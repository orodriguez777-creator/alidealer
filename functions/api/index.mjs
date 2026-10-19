/**
 * Affiliate catalog API
 *
 * Public:  list, GET ?go=<productId> (count the click, redirect to the product page),
 *          GET ?share=[he/]<productId> (link-preview page for one deal),
 *          GET ?tg=<source> (redirect to that source's Telegram invite link)
 * Admin:   login, detect, save, delete, stats, post, suggestions, suggest-*  (require ADMIN_PASSWORD-derived token)
 * Hourly schedule: the AI marketing agency (agency.mjs); at 04 UTC also the
 *          AliExpress deal suggestions (see "deal suggestions")
 *
 * Products are stored as one JSON document in the project bucket
 * (data/products.json) — a single admin writes, everyone reads.
 *
 * Environment variables:
 * - ADMIN_PASSWORD  (secret, set via functions/api/.env)
 * - ALIEXPRESS_APP_KEY, ALIEXPRESS_APP_SECRET  (secret, affiliate API)
 * - STORAGE_BUCKET, OPENKBS_API_KEY (injected)
 */
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { initAgency, agencyAction, agencyHourly, approvedGuides, recordVisit, inviteLink } from './agency.mjs';

const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-central-1' });
const DATA_KEY = 'data/products.json';
const CLICKS_KEY = 'data/clicks.json';
const CLICK_EVENTS = 'clicks/events/';
const SITE_URL = 'https://alidealer.com';
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const AI_MODEL = 'gemini-3.1-flash-lite-preview';
const TRANSLATE_MODEL = 'gemini-3-flash-preview';

export const CATEGORIES = [
    'Electronics', 'Phone Accessories', 'Computers & Office', 'Home & Kitchen',
    'Tools & Home Improvement', 'Lighting', 'Women\'s Fashion', 'Men\'s Fashion',
    'Shoes', 'Bags & Luggage', 'Jewelry & Watches', 'Beauty & Health',
    'Sports & Outdoors', 'Toys & Hobbies', 'Baby & Kids', 'Pet Supplies',
    'Automotive', 'Garden', 'Other',
];

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, statusCode = 200) {
    return { statusCode, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(data) };
}

// ---------- auth ----------

function sign(payload) {
    return createHmac('sha256', 'catalog-admin:' + process.env.ADMIN_PASSWORD).update(payload).digest('hex');
}

function issueToken() {
    const exp = String(Date.now() + TOKEN_TTL_MS);
    return `${exp}.${sign(exp)}`;
}

function isAdmin(event) {
    if (!process.env.ADMIN_PASSWORD) return false;
    const auth = event.headers?.authorization || event.headers?.Authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    const [exp, sig] = token.split('.');
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    const expected = Buffer.from(sign(exp));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
}

function passwordMatches(input) {
    const a = Buffer.from(sign(String(input || '')));
    const b = Buffer.from(sign(process.env.ADMIN_PASSWORD));
    return timingSafeEqual(a, b);
}

// ---------- storage ----------

async function loadProducts() {
    try {
        const res = await s3.send(new GetObjectCommand({ Bucket: process.env.STORAGE_BUCKET, Key: DATA_KEY }));
        return JSON.parse(await res.Body.transformToString());
    } catch (e) {
        if (e.name === 'NoSuchKey') return [];
        throw e;
    }
}

async function saveProducts(products) {
    await s3.send(new PutObjectCommand({
        Bucket: process.env.STORAGE_BUCKET,
        Key: DATA_KEY,
        Body: JSON.stringify(products),
        ContentType: 'application/json',
    }));
}

// ---------- detection ----------

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';
// AliExpress serves server-rendered Open Graph tags to link-preview crawlers
const PREVIEW_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

function findItemId(text) {
    const decoded = decodeURIComponent(decodeURIComponent(text));
    const m = decoded.match(/\/item\/(?:[^/?#]*\/)?(\d{10,20})\.html/) || decoded.match(/productIds?=(\d{10,20})/);
    return m ? m[1] : null;
}

// Follow affiliate redirects (s.click.aliexpress.com, a.aliexpress.com, ...) by hand
// so we can spot the product id in any hop, including JS/meta-refresh pages.
async function resolveItemId(url) {
    let current = url;
    for (let hop = 0; hop < 10; hop++) {
        const id = findItemId(current);
        if (id) return id;
        const res = await fetch(current, { redirect: 'manual', headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(8000) });
        const location = res.headers.get('location');
        if (location) { current = new URL(location, current).toString(); continue; }
        const body = await res.text();
        return findItemId(body);
    }
    return null;
}

// ---------- outbound product links ----------

// Short affiliate links (s.click.aliexpress.com/e/…) are claimed by the AliExpress
// phone app, which often can't resolve them and opens its home screen. So the
// storefront links here instead: we follow the short link ourselves (AliExpress
// records the affiliate click) and send the visitor straight to the product page,
// which carries AliExpress's affiliate tracking parameters.
async function productPageUrl(link, ua) {
    let current = link;
    for (let hop = 0; hop < 6; hop++) {
        const url = new URL(current);
        if (/\/item\/\d+\.html$/.test(url.pathname) && /(^|\.)aliexpress\./.test(url.hostname)) {
            url.hostname = 'www.aliexpress.com';
            return url.toString();
        }
        const res = await fetch(current, { redirect: 'manual', headers: { 'User-Agent': ua || BROWSER_UA }, signal: AbortSignal.timeout(4000) });
        const location = res.headers.get('location');
        if (!location) return null;
        current = new URL(location, current).toString();
    }
    return null;
}

async function handleGo(id, ua) {
    const product = (await loadProducts()).find(p => p.id === id);
    let target = product?.url || 'https://alidealer.com/';
    if (product) {
        const counted = recordClick(product.id, ua);
        try { target = await productPageUrl(product.url, ua) || product.url; }
        catch (e) { console.error('[go]', e.message); }
        await counted;
    }
    return { statusCode: 302, headers: { Location: target, 'Cache-Control': 'no-store' }, body: '' };
}

// ---------- click counting ----------

// Each click is its own tiny object, so simultaneous clicks never overwrite each
// other. The admin's stats call folds them into data/clicks.json and removes them.
const BOT_UA = /bot|crawl|spider|preview|facebookexternalhit|whatsapp|telegram|slack|discord|curl|wget|python|headless/i;

async function recordClick(id, ua) {
    if (BOT_UA.test(ua || '')) return;
    try {
        await s3.send(new PutObjectCommand({
            Bucket: process.env.STORAGE_BUCKET,
            Key: `${CLICK_EVENTS}${id}/${Date.now()}-${randomUUID().slice(0, 8)}`,
            Body: '',
        }));
    } catch (e) { console.error('[click]', e.message); }
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

async function loadClicks() {
    try {
        const res = await s3.send(new GetObjectCommand({ Bucket: process.env.STORAGE_BUCKET, Key: CLICKS_KEY }));
        return JSON.parse(await res.Body.transformToString());
    } catch (e) {
        if (e.name === 'NoSuchKey') return {};
        throw e;
    }
}

// Folds new click events into data/clicks.json → { id: { total, week } }
async function foldClicks() {
    const Bucket = process.env.STORAGE_BUCKET;
    const clicks = await loadClicks();
    const keys = [];
    let token;
    do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: CLICK_EVENTS, ContinuationToken: token }));
        for (const { Key } of page.Contents || []) {
            const [id, stamp] = Key.slice(CLICK_EVENTS.length).split('/');
            const day = dayOf(Number(stamp.split('-')[0]));
            const c = clicks[id] ||= { total: 0, days: {} };
            c.total++;
            c.days[day] = (c.days[day] || 0) + 1;
            keys.push(Key);
        }
        token = page.NextContinuationToken;
    } while (token);

    // per-day counts only matter for "this week"; keep a month of them
    const cutoff = dayOf(Date.now() - 30 * 86400000);
    for (const c of Object.values(clicks)) {
        for (const d of Object.keys(c.days)) if (d < cutoff) delete c.days[d];
    }
    if (keys.length) {
        await s3.send(new PutObjectCommand({ Bucket, Key: CLICKS_KEY, Body: JSON.stringify(clicks), ContentType: 'application/json' }));
        for (let i = 0; i < keys.length; i += 1000) {
            await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys.slice(i, i + 1000).map(Key => ({ Key })), Quiet: true } }));
        }
    }

    const weekStart = dayOf(Date.now() - 6 * 86400000);
    const out = {};
    for (const [id, c] of Object.entries(clicks)) {
        out[id] = { total: c.total, week: Object.entries(c.days).reduce((n, [d, v]) => n + (d >= weekStart ? v : 0), 0) };
    }
    return out;
}

// ---------- sharing ----------

const shareUrl = (id, lang) => `${SITE_URL}/d/${lang === 'he' ? 'he/' : ''}${id}`;
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// What WhatsApp, Facebook and Telegram read when a deal link is posted: the deal's
// own photo, name and price. People who open it land on the storefront with the deal shown.
// Links posted by the agency carry ?s=<channel> (it arrives inside the share value,
// "he/<id>?s=tg"), so visits can be counted per channel.
async function handleShare(param, query, ua) {
    const [path, qs = ''] = param.split('?');
    param = path;
    const tag = new URLSearchParams(qs).get('s') || query?.s;
    if (tag) await recordVisit(String(tag), ua);
    const [lang, id] = param.startsWith('he/') ? ['he', param.slice(3)] : ['en', param];
    const p = (await loadProducts()).find(x => x.id === id);
    const he = lang === 'he';
    const title = p ? ((he && p.titleHe) || p.title) : 'www.Alidealer.com';
    const desc = p
        ? [p.price, he ? 'נבחר בקפידה ב-www.Alidealer.com' : 'Hand-picked on www.Alidealer.com'].filter(Boolean).join(' · ')
        : (he ? 'רק הדילים הכי טובים מ-AliExpress' : 'Only the best AliExpress deals');
    const image = p?.image || `${SITE_URL}/og.jpg`;
    const target = p ? `${SITE_URL}/?deal=${encodeURIComponent(p.id)}${he ? '&lang=he' : ''}` : SITE_URL + '/';
    const html = `<!DOCTYPE html>
<html lang="${lang}" dir="${he ? 'rtl' : 'ltr'}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)} — www.Alidealer.com</title>
<meta name="description" content="${escHtml(desc)}">
<meta name="robots" content="noindex">
<meta property="og:type" content="product">
<meta property="og:site_name" content="www.Alidealer.com">
<meta property="og:title" content="${escHtml(title)}">
<meta property="og:description" content="${escHtml(desc)}">
<meta property="og:image" content="${escHtml(image)}">
<meta property="og:url" content="${escHtml(p ? shareUrl(p.id, lang) : SITE_URL)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="${escHtml(target)}">
<meta http-equiv="refresh" content="0;url=${escHtml(target)}">
</head>
<body><a href="${escHtml(target)}">${escHtml(title)}</a><script>location.replace(${JSON.stringify(target)})</script></body>
</html>`;
    return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': tag ? 'no-store' : 'public, max-age=300' }, body: html };
}

// Ready-to-paste social post for one deal
async function handlePost({ id, lang }) {
    const p = (await loadProducts()).find(x => x.id === id);
    if (!p) return json({ error: 'Product not found' }, 404);
    const he = lang === 'he';
    const link = shareUrl(p.id, he ? 'he' : 'en');
    const out = await gemini(TRANSLATE_MODEL, `Write a short social media post (for WhatsApp groups, Facebook and Telegram) promoting this AliExpress deal from the shop www.Alidealer.com.
Product: ${(he && p.titleHe) || p.title}
Category: ${p.category}
${p.price ? `Price: ${p.price}` : 'Price: not given, do not invent one'}

Rules:
- Language: ${he ? 'natural, everyday Israeli Hebrew' : 'casual, friendly English'}
- 3 to 5 short lines: a catchy hook, why it is useful, ${p.price ? 'the price, ' : ''}a call to action
- A few fitting emoji are welcome; no more than 2 hashtags
- Do not make claims you cannot know (ratings, stock, shipping time, discounts)
- Do not include any link; it is added after your text
Return JSON {"post": "..."} using \n for line breaks.`, { generationConfig: { maxOutputTokens: 1000, responseMimeType: 'application/json', temperature: 1 } }, 30000);
    const text = String(out.post || '').trim();
    if (!text) return json({ error: 'The writer came back empty, please try again' }, 502);
    return json({ post: `${text}\n\n👉 ${link}`, link });
}

function metaContent(html, prop) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i');
    const m = html.match(re);
    return m ? decodeEntities(m[1]).trim() : '';
}

function decodeEntities(s) {
    return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

const cleanTitle = (t) => String(t || '').replace(/\s*(-|на)\s*AliExpress.*$/i, '').trim();
const isProductImage = (u) => /^https:\/\/[a-z0-9.-]*(alicdn\.com|aliexpress-media\.com)\//i.test(u || '');

// AliExpress serves Open Graph tags to link-preview crawlers, but answers cloud
// IPs with a bot check on and off. The global site blocks almost every time;
// aliexpress.ru usually serves the real page (Russian title, photo) in ~2s.
async function fetchOpenGraph(itemId, host = 'www.aliexpress.com') {
    try {
        const res = await fetch(`https://${host}/item/${itemId}.html`, {
            headers: {
                'User-Agent': PREVIEW_UA,
                'Accept-Language': 'en-US,en;q=0.9',
                // the global-site cookie makes aliexpress.ru redirect into the bot check
                ...(host === 'www.aliexpress.com' && { Cookie: 'aep_usuc_f=site=glo&c_tp=USD&region=US&b_locale=en_US' }),
            },
            signal: AbortSignal.timeout(6000),
        });
        const html = await res.text();
        return { rawTitle: cleanTitle(metaContent(html, 'og:title')), image: metaContent(html, 'og:image') };
    } catch (e) {
        console.error(`[og ${host}]`, e.message);
        return { rawTitle: '', image: '' };
    }
}

// ---------- AliExpress affiliate API (app key + secret from portals.aliexpress.com) ----------

// The API allows about one call per second, so calls from this container are spaced out
let nextAliCall = 0;
async function aliCall(method, extra) {
    const key = process.env.ALIEXPRESS_APP_KEY;
    const secret = process.env.ALIEXPRESS_APP_SECRET;
    if (!key || !secret) throw new Error('AliExpress API keys are not configured');
    let data;
    for (let attempt = 0; attempt < 4; attempt++) {
        const wait = nextAliCall - Date.now() + (attempt ? Math.random() * 600 : 0);
        nextAliCall = Math.max(Date.now(), nextAliCall) + 1100;
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        const params = { app_key: key, method, sign_method: 'sha256', timestamp: String(Date.now()), ...extra };
        const base = Object.keys(params).sort().map(k => k + params[k]).join('');
        params.sign = createHmac('sha256', secret).update(base).digest('hex').toUpperCase();
        const res = await fetch('https://api-sg.aliexpress.com/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
            body: new URLSearchParams(params),
            signal: AbortSignal.timeout(8000),
        });
        data = await res.json();
        if (data.error_response?.code !== 'ApiCallLimit') break;
    }
    if (data.error_response) throw new Error(`AliExpress: ${data.error_response.msg || data.error_response.code}`);
    return data[`${method.replace(/\./g, '_')}_response`]?.resp_result;
}

// prices differ per country; the owner shops from Israel and sees Israel prices in USD
const ALI_MARKET = { target_currency: 'USD', target_language: 'EN', country: 'IL' };

// Preferred source for detect
async function fetchViaAffiliateApi(itemId) {
    try {
        const r = await aliCall('aliexpress.affiliate.productdetail.get', { product_ids: itemId, ...ALI_MARKET });
        const p = r?.result?.products?.product?.[0];
        if (!p) { console.error('[affiliate-api]', JSON.stringify(r).slice(0, 300)); return null; }
        const amount = p.target_sale_price || p.sale_price;
        return {
            rawTitle: cleanTitle(p.product_title),
            image: p.product_main_image_url || '',
            price: amount ? `$${amount}` : '',
            hint: [p.first_level_category_name, p.second_level_category_name].filter(Boolean).join(' > '),
        };
    } catch (e) {
        console.error('[affiliate-api]', e.message);
        return null;
    }
}

// Last resort: public reader service
async function fetchViaReader(itemId) {
    try {
        const res = await fetch(`https://r.jina.ai/https://www.aliexpress.com/item/${itemId}.html`, {
            headers: { Accept: 'application/json', 'X-With-Images-Summary': 'true' },
            signal: AbortSignal.timeout(25000),
        });
        const data = (await res.json()).data || {};
        const rawTitle = /maintaining|captcha|404|^aliexpress/i.test(data.title || '') ? '' : cleanTitle(data.title);
        // Product photos are jpg/webp under /kf/; pngs there are site logos and badges
        const image = Object.values(data.images || {}).find(u => isProductImage(u) && /\/kf\/.+\.(jpe?g|webp)/i.test(u)) || '';
        return { rawTitle, image };
    } catch (e) {
        console.error('[reader]', e.message);
        return { rawTitle: '', image: '' };
    }
}

async function gemini(model, prompt, extra = {}, timeoutMs = 15000) {
    const res = await fetch(`https://proxy.openkbs.com/v1/google/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENKBS_API_KEY}` },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], ...extra }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) console.error('[gemini]', model, res.status, JSON.stringify(data.error || { finish: data.candidates?.[0]?.finishReason, feedback: data.promptFeedback, usage: data.usageMetadata }).slice(0, 400));
    return m ? JSON.parse(m[0]) : {};
}

const OUTPUT_RULES = `- "title": a clean, readable product name in English, translated if the listing is in another language (max 70 chars, no keyword stuffing, Title Case)
- "category": exactly one of: ${CATEGORIES.join(' | ')}`;

function normalize(out, fallbackTitle) {
    return {
        title: String(out.title || fallbackTitle || '').slice(0, 120),
        category: CATEGORIES.includes(out.category) ? out.category : 'Other',
    };
}

async function classify(rawTitle, hint = '') {
    const out = await gemini(AI_MODEL, `You organise an AliExpress product catalog.
Product listing title: "${rawTitle}"${hint ? `\nAliExpress category: ${hint}` : ''}

Return JSON with:
${OUTPUT_RULES}`, { generationConfig: { maxOutputTokens: 300, responseMimeType: 'application/json' } });
    return normalize(out, rawTitle);
}

// Ask every source at once and take the first that returns a title. The global
// site's bot check is intermittent, so keep retrying it until something wins.
// (AI "URL reading" was tried and dropped: it returns confident titles of
// unrelated products.)
async function readPage(itemId, deadline) {
    let done = false;
    const retryGlobal = async () => {
        while (!done && Date.now() < deadline) {
            const og = await fetchOpenGraph(itemId);
            if (og.rawTitle) return og;
            await new Promise(r => setTimeout(r, 1000));
        }
        return { rawTitle: '', image: '' };
    };
    const sources = [retryGlobal(), fetchOpenGraph(itemId, 'aliexpress.ru'), fetchViaReader(itemId)];
    const titled = sources.map(p => p.then(r => r.rawTitle ? r : Promise.reject(r)));
    const timeout = new Promise((_, reject) => setTimeout(reject, Math.max(0, deadline - Date.now())));
    try {
        const page = await Promise.race([Promise.any(titled), timeout]);
        done = true;
        return { rawTitle: page.rawTitle, image: isProductImage(page.image) ? page.image : '' };
    } catch {
        done = true;
        return { rawTitle: '', image: '' };
    }
}

async function handleDetect({ url }) {
    if (!/^https?:\/\/([a-z0-9-]+\.)*aliexpress\.(com|us|ru)\b/i.test(url || '')) {
        return json({ error: 'Please paste an AliExpress link (aliexpress.com, s.click.aliexpress.com, …)' }, 400);
    }
    const itemId = await resolveItemId(url);
    if (!itemId) return json({ error: 'Could not find the product behind this link. Fill in the details manually.' }, 422);

    let page = await fetchViaAffiliateApi(itemId);
    if (!page?.rawTitle) page = await readPage(itemId, Date.now() + 8000);
    if (!page.rawTitle) {
        return json({ itemId, image: page.image, title: '', category: '', warning: 'AliExpress didn\'t let us read this page right now. Paste the product title below and press Auto-categorize, or try Detect again.' });
    }

    let detected = { title: page.rawTitle, category: 'Other' };
    try { detected = await classify(page.rawTitle, page.hint); } catch (e) { console.error('[classify]', e.message); }
    return json({ itemId, image: page.image, price: page.price || '', rawTitle: page.rawTitle, ...detected });
}

async function handleClassify({ title }) {
    if (!String(title || '').trim()) return json({ error: 'Enter a title first' }, 400);
    return json(await classify(String(title).slice(0, 300)));
}

// ---------- Hebrew titles (for the storefront's Hebrew mode) ----------

async function translateTitles(titles) {
    const out = await gemini(TRANSLATE_MODEL, `Translate these online-store product names into natural, concise Hebrew, the way an Israeli shop would list them.
Keep brand names, model numbers and units (e.g. Baseus, MC2, 100W, USB-C) in Latin characters.
Return JSON {"he": [...]} with exactly ${titles.length} strings, in the same order.

${JSON.stringify(titles)}`, { generationConfig: { maxOutputTokens: 8000, responseMimeType: 'application/json' } }, 30000);
    if (!Array.isArray(out.he) || out.he.length !== titles.length) throw new Error('translation came back incomplete');
    return out.he.map(t => String(t || '').trim().slice(0, 160));
}

// Products added before Hebrew existed get translated once, on the next list.
// After a failure, wait before trying again so visitors aren't held up.
let translateRetryAt = 0;
async function fillHebrewTitles(products) {
    const missing = products.filter(p => !p.titleHe);
    if (!missing.length || Date.now() < translateRetryAt) return;
    try {
        const he = await translateTitles(missing.map(p => p.title));
        const byId = new Map(missing.map((p, i) => [p.id, { title: p.title, he: he[i] }]));
        missing.forEach((p, i) => { p.titleHe = he[i]; });
        // re-read before writing so an admin save made meanwhile isn't lost
        const fresh = await loadProducts();
        fresh.forEach(p => { const t = byId.get(p.id); if (t && !p.titleHe && p.title === t.title) p.titleHe = t.he; });
        await saveProducts(fresh);
    } catch (e) {
        console.error('[translate]', e.message);
        translateRetryAt = Date.now() + 10 * 60 * 1000;
    }
}

// ---------- CRUD ----------

async function handleSave(body) {
    const url = String(body.url || '').trim();
    const title = String(body.title || '').trim();
    if (!/^https?:\/\//.test(url) || !title) return json({ error: 'Link and title are required' }, 400);

    const products = await loadProducts();
    const fields = {
        url,
        title: title.slice(0, 160),
        category: String(body.category || 'Other').trim().slice(0, 60) || 'Other',
        image: /^https:\/\//.test(body.image || '') ? body.image : '',
        price: String(body.price || '').trim().slice(0, 30),
        itemId: body.itemId ? String(body.itemId) : null,
    };
    let product;
    if (body.id) {
        product = products.find(p => p.id === body.id);
        if (!product) return json({ error: 'Product not found' }, 404);
        if (product.title === fields.title && product.titleHe) fields.titleHe = product.titleHe;
        Object.assign(product, fields, { updatedAt: new Date().toISOString() });
    } else {
        product = { id: randomUUID(), ...fields, createdAt: new Date().toISOString() };
        products.unshift(product);
    }
    if (!fields.titleHe) {
        try { [product.titleHe] = await translateTitles([fields.title]); }
        catch (e) { console.error('[translate]', e.message); delete product.titleHe; }
    }
    await saveProducts(products);
    return json({ product });
}

async function handleDelete({ id }) {
    const products = await loadProducts();
    const next = products.filter(p => p.id !== id);
    await saveProducts(next);
    return json({ deleted: products.length - next.length });
}

// ---------- deal suggestions ----------
// Once a day (and on "Find new now") AliExpress is searched per category for
// best-selling, well-rated, discounted products. They wait in the admin until
// the owner adds or skips each one, unless "add automatically" is on: then the
// best few each day (most sold and most positive reviews) go on the site by themselves.

const SUGGEST_KEY = 'data/suggestions.json';
const SUGGEST_MAX_AGE_MS = 14 * 86400000;

// our category → AliExpress category ids (aliexpress.affiliate.category.get)
const ALI_CATEGORIES = {
    'Electronics': { ids: '44' },
    'Phone Accessories': { ids: '509,202192403' },
    'Computers & Office': { ids: '7' },
    'Home & Kitchen': { ids: '200000920,1541,200033149,3710,100000041' },
    'Tools & Home Improvement': { ids: '1420,13' },
    'Lighting': { ids: '39' },
    'Women\'s Fashion': { ids: '200000345' },
    'Men\'s Fashion': { ids: '200000343' },
    'Shoes': { ids: '322' },
    'Bags & Luggage': { ids: '1524' },
    'Jewelry & Watches': { ids: '36,1511' },
    'Beauty & Health': { ids: '66' },
    'Sports & Outdoors': { ids: '18' },
    'Toys & Hobbies': { ids: '26' },
    'Baby & Kids': { ids: '1501' },
    'Pet Supplies': { ids: '100006664' },
    'Automotive': { ids: '34' },
    'Garden': { ids: '125' },
};

const SUGGEST_DEFAULTS = { categories: [], minOrders: 300, minRating: 95, minDiscount: 30, maxPrice: 50, perCategory: 3, autoAdd: false, autoPerDay: 5 };

async function loadSuggestions() {
    try {
        const res = await s3.send(new GetObjectCommand({ Bucket: process.env.STORAGE_BUCKET, Key: SUGGEST_KEY }));
        return JSON.parse(await res.Body.transformToString());
    } catch (e) {
        if (e.name !== 'NoSuchKey') throw e;
        // start with the categories the shop already has
        const products = await loadProducts();
        const categories = Object.keys(ALI_CATEGORIES).filter(c => products.some(p => p.category === c));
        return { items: [], skipped: [], settings: { ...SUGGEST_DEFAULTS, categories }, lastRun: null };
    }
}

async function saveSuggestions(doc) {
    await s3.send(new PutObjectCommand({ Bucket: process.env.STORAGE_BUCKET, Key: SUGGEST_KEY, Body: JSON.stringify(doc), ContentType: 'application/json' }));
}

const pct = (s) => parseFloat(String(s || '').replace('%', '')) || 0;

async function cleanTitles(raw) {
    const out = await gemini(AI_MODEL, `Rewrite these AliExpress listing titles as clean, readable product names in English, the way a curated shop would list them.
Max 70 characters each, no keyword stuffing, Title Case, keep brand names and key specs.
Return JSON {"titles": [...]} with exactly ${raw.length} strings, in the same order.

${JSON.stringify(raw)}`, { generationConfig: { maxOutputTokens: 4000, responseMimeType: 'application/json' } }, 30000);
    if (!Array.isArray(out.titles) || out.titles.length !== raw.length) throw new Error('title cleanup came back incomplete');
    return out.titles.map((t, i) => String(t || '').trim().slice(0, 120) || raw[i]);
}

async function refreshSuggestions(deadline) {
    const [doc, products] = await Promise.all([loadSuggestions(), loadProducts()]);
    const st = doc.settings;
    const known = new Set([...products.map(p => p.itemId), ...doc.items.map(i => i.itemId), ...doc.skipped].filter(Boolean).map(String));
    const found = [];
    const errors = [];

    for (const category of st.categories.filter(c => ALI_CATEGORIES[c])) {
        if (Date.now() > deadline) { errors.push('ran out of time, some categories were not searched'); break; }
        const { ids } = ALI_CATEGORIES[category];
        try {
            const r = await aliCall('aliexpress.affiliate.product.query', {
                ...ALI_MARKET, category_ids: ids,
                sort: 'LAST_VOLUME_DESC', page_size: '50',
                // a different page each day so the same best-sellers don't come back
                page_no: String(1 + Math.floor(Math.random() * 3)),
            });
            const picks = (r?.result?.products?.product || []).filter(p => {
                const id = String(p.product_id);
                const price = parseFloat(p.target_sale_price);
                return !known.has(id) && p.product_main_image_url && price > 0
                    && (!st.maxPrice || price <= st.maxPrice)
                    && (p.lastest_volume || 0) >= st.minOrders
                    && pct(p.evaluate_rate) >= st.minRating
                    && pct(p.discount) >= st.minDiscount;
            }).slice(0, st.perCategory);
            for (const p of picks) {
                known.add(String(p.product_id));
                found.push({
                    itemId: String(p.product_id), category,
                    rawTitle: cleanTitle(p.product_title), title: cleanTitle(p.product_title),
                    image: p.product_main_image_url,
                    price: `$${p.target_sale_price}`,
                    was: p.target_original_price && p.target_original_price !== p.target_sale_price ? `$${p.target_original_price}` : '',
                    discount: p.discount || '', orders: p.lastest_volume || 0, rating: p.evaluate_rate || '',
                    commission: p.commission_rate || '',
                    foundAt: new Date().toISOString(),
                });
            }
        } catch (e) {
            console.error('[suggest]', category, e.message);
            errors.push(`${category}: ${e.message}`);
        }
    }

    if (found.length) {
        try {
            const titles = await cleanTitles(found.map(f => f.rawTitle));
            found.forEach((f, i) => { f.title = titles[i]; });
        } catch (e) { console.error('[suggest-titles]', e.message); }
    }

    // re-read before writing so an add/skip made meanwhile isn't lost
    const fresh = await loadSuggestions();
    const cutoff = Date.now() - SUGGEST_MAX_AGE_MS;
    const have = new Set(fresh.items.map(i => i.itemId));
    fresh.items = [...found.filter(f => !have.has(f.itemId)), ...fresh.items.filter(i => Date.parse(i.foundAt) > cutoff)].slice(0, 300);
    fresh.lastRun = { at: new Date().toISOString(), found: found.length, errors: errors.slice(0, 5) };
    await saveSuggestions(fresh);
    return fresh;
}

const suggestView = (doc) => ({ items: doc.items, settings: { ...SUGGEST_DEFAULTS, ...doc.settings }, lastRun: doc.lastRun, lastAuto: doc.lastAuto, categories: Object.keys(ALI_CATEGORIES) });

async function handleSuggestSettings({ settings = {} }) {
    const doc = await loadSuggestions();
    const num = (v, min, max, d) => Number.isFinite(+v) && v !== '' && v !== null ? Math.min(max, Math.max(min, +v)) : d;
    doc.settings = {
        categories: (Array.isArray(settings.categories) ? settings.categories : []).filter(c => ALI_CATEGORIES[c]),
        minOrders: num(settings.minOrders, 0, 1e6, SUGGEST_DEFAULTS.minOrders),
        minRating: num(settings.minRating, 0, 100, SUGGEST_DEFAULTS.minRating),
        minDiscount: num(settings.minDiscount, 0, 99, SUGGEST_DEFAULTS.minDiscount),
        maxPrice: num(settings.maxPrice, 0, 1e5, 0),
        perCategory: num(settings.perCategory, 1, 20, SUGGEST_DEFAULTS.perCategory),
        autoAdd: !!settings.autoAdd,
        autoPerDay: num(settings.autoPerDay, 1, 30, SUGGEST_DEFAULTS.autoPerDay),
    };
    await saveSuggestions(doc);
    return json(suggestView(doc));
}

async function dropSuggestions(itemIds, skip) {
    const ids = new Set(itemIds.map(String));
    const doc = await loadSuggestions();
    doc.items = doc.items.filter(i => !ids.has(i.itemId));
    if (skip) doc.skipped = [...ids, ...doc.skipped.filter(id => !ids.has(id))].slice(0, 5000);
    await saveSuggestions(doc);
    return doc;
}

// Positive reviews matter most, sales next: 98% from 2,000 buyers beats 96% from 20,000.
// log10 keeps a huge seller from winning on volume alone.
const dealScore = (i) => (pct(i.rating) / 100) ** 4 * Math.log10((i.orders || 0) + 10);

// The day's best suggestions go on the site by themselves, at most one per category per
// round so a single category doesn't take over the shop.
async function autoAddSuggestions(deadline) {
    const doc = await loadSuggestions();
    const st = { ...SUGGEST_DEFAULTS, ...doc.settings };
    const today = new Date().toISOString().slice(0, 10);
    if (!st.autoAdd || doc.lastAutoAdd === today) return null;
    doc.lastAutoAdd = today;
    await saveSuggestions(doc);
    // only recent finds, so the price shown is still close to AliExpress's
    const recent = doc.items.filter(i => Date.parse(i.foundAt) > Date.now() - 3 * 86400000);
    const ranked = recent.sort((a, b) => dealScore(b) - dealScore(a));
    const picks = [];
    while (picks.length < st.autoPerDay && ranked.length) {
        const used = new Set();
        for (const it of [...ranked]) {
            if (picks.length >= st.autoPerDay) break;
            if (used.has(it.category)) continue;
            used.add(it.category);
            picks.push(it);
            ranked.splice(ranked.indexOf(it), 1);
        }
    }
    const added = [], failed = [];
    for (const it of picks) {
        if (Date.now() > deadline) break;
        const r = await handleSuggestAdd({ itemId: it.itemId }).catch(e => ({ statusCode: 500, body: JSON.stringify({ error: e.message }) }));
        if (r.statusCode === 200) added.push(it.title);
        else failed.push(`${it.title}: ${JSON.parse(r.body || '{}').error}`);
    }
    const fresh = await loadSuggestions();
    fresh.lastAuto = { at: new Date().toISOString(), added, failed: failed.slice(0, 5) };
    await saveSuggestions(fresh);
    return fresh.lastAuto;
}

async function handleSuggestAdd(body) {
    const itemId = String(body.itemId || '');
    const doc = await loadSuggestions();
    const item = doc.items.find(i => i.itemId === itemId);
    if (!item) return json({ error: 'This suggestion is no longer in the list' }, 404);
    if ((await loadProducts()).some(p => String(p.itemId) === itemId)) {
        await dropSuggestions([itemId], true);
        return json({ error: 'Already on the site' }, 409);
    }
    // a short affiliate link, the same kind the portal makes
    const r = await aliCall('aliexpress.affiliate.link.generate', {
        promotion_link_type: '0', tracking_id: 'default',
        source_values: `https://www.aliexpress.com/item/${itemId}.html`,
    });
    const url = r?.result?.promotion_links?.promotion_link?.[0]?.promotion_link;
    if (!url) return json({ error: 'AliExpress didn\'t create the affiliate link. Try again in a moment.' }, 502);
    const saved = await handleSave({
        url, itemId, image: item.image,
        title: body.title || item.title,
        category: body.category || item.category,
        price: body.price ?? item.price,
    });
    if (saved.statusCode === 200) await dropSuggestions([itemId], true);
    return saved;
}

initAgency({ gemini, loadProducts, foldClicks, shareUrl, json, model: AI_MODEL, writeModel: TRANSLATE_MODEL });

export const handler = async (event) => {
    if (event.source === 'schedule') {
        const deadline = Date.now() + 280000;
        if (new Date().getUTCHours() === 4) {
            try {
                const doc = await refreshSuggestions(Date.now() + 100000);
                console.log('[suggest] daily run', JSON.stringify(doc.lastRun));
            } catch (e) { console.error('[suggest]', e); }
        }
        // after the morning search (and on the first run once it is switched on)
        if (new Date().getUTCHours() >= 4) {
            try {
                const r = await autoAddSuggestions(Date.now() + 90000);
                if (r) console.log('[suggest] auto-added', JSON.stringify(r));
            } catch (e) { console.error('[suggest auto]', e); }
        }
        console.log('[agency] hourly run', JSON.stringify(await agencyHourly(deadline)));
        return { ok: true };
    }

    if (event.requestContext?.http?.method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

    try {
        const go = event.queryStringParameters?.go;
        if (go) return await handleGo(go, event.headers?.['user-agent']);
        const tg = event.queryStringParameters?.tg;
        if (tg) return { statusCode: 302, headers: { Location: await inviteLink(tg), 'Cache-Control': 'no-store' }, body: '' };
        const share = event.queryStringParameters?.share;
        if (share) return await handleShare(share, event.queryStringParameters, event.headers?.['user-agent']);

        const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body;
        const body = JSON.parse(raw || '{}');

        switch (body.action) {
            case 'list': {
                const products = await loadProducts();
                await fillHebrewTitles(products);
                return json({ products, categories: CATEGORIES });
            }

            case 'login':
                if (!process.env.ADMIN_PASSWORD) return json({ error: 'Admin password is not configured yet' }, 503);
                if (!passwordMatches(body.password)) {
                    await new Promise(r => setTimeout(r, 1000)); // slow down guessing
                    return json({ error: 'Wrong password' }, 401);
                }
                return json({ token: issueToken() });

            case 'agency-guides':
                return json({ guides: await approvedGuides() });
        }

        if (!isAdmin(event)) return json({ error: 'Unauthorized' }, 401);

        switch (body.action) {
            case 'check':  return json({ ok: true, categories: CATEGORIES });
            case 'detect': return await handleDetect(body);
            case 'classify': return await handleClassify(body);
            case 'save':   return await handleSave(body);
            case 'delete': return await handleDelete(body);
            case 'stats':  return json({ clicks: await foldClicks() });
            case 'post':   return await handlePost(body);
            case 'suggestions': return json(suggestView(await loadSuggestions()));
            case 'suggest-refresh': return json(suggestView(await refreshSuggestions(Date.now() + 35000)));
            case 'suggest-settings': return await handleSuggestSettings(body);
            case 'suggest-add': return await handleSuggestAdd(body);
            case 'suggest-skip': return json(suggestView(await dropSuggestions(Array.isArray(body.itemIds) ? body.itemIds : [], true)));
            default:
                if (String(body.action).startsWith('agency')) {
                    const res = await agencyAction(body);
                    if (res) return res;
                }
                return json({ error: 'Unknown action' }, 400);
        }
    } catch (error) {
        console.error(error);
        return json({ error: error.message }, 500);
    }
};
