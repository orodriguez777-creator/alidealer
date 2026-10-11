/**
 * Affiliate catalog API
 *
 * Public:  list
 * Admin:   login, detect, save, delete  (require ADMIN_PASSWORD-derived token)
 *
 * Products are stored as one JSON document in the project bucket
 * (data/products.json) — a single admin writes, everyone reads.
 *
 * Environment variables:
 * - ADMIN_PASSWORD  (secret, set via functions/api/.env)
 * - STORAGE_BUCKET, OPENKBS_API_KEY (injected)
 */
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-central-1' });
const DATA_KEY = 'data/products.json';
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const AI_MODEL = 'gemini-3.1-flash-lite-preview';

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

function metaContent(html, prop) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i');
    const m = html.match(re);
    return m ? decodeEntities(m[1]).trim() : '';
}

function decodeEntities(s) {
    return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

const cleanTitle = (t) => String(t || '').replace(/\s*-\s*AliExpress.*$/i, '').trim();
const isProductImage = (u) => /^https:\/\/[a-z0-9.-]*(alicdn\.com|aliexpress-media\.com)\//i.test(u || '');

// Fast path: AliExpress serves Open Graph tags to link-preview crawlers,
// but often answers cloud IPs with a bot check instead.
async function fetchOpenGraph(itemId) {
    try {
        const res = await fetch(`https://www.aliexpress.com/item/${itemId}.html`, {
            headers: { 'User-Agent': PREVIEW_UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'aep_usuc_f=site=glo&c_tp=USD&region=US&b_locale=en_US' },
            signal: AbortSignal.timeout(6000),
        });
        const html = await res.text();
        return { rawTitle: cleanTitle(metaContent(html, 'og:title')), image: metaContent(html, 'og:image') };
    } catch (e) {
        console.error('[og]', e.message);
        return { rawTitle: '', image: '' };
    }
}

// Preferred: official AliExpress Affiliate API (needs app key + secret from portals.aliexpress.com)
async function fetchViaAffiliateApi(itemId) {
    const key = process.env.ALIEXPRESS_APP_KEY;
    const secret = process.env.ALIEXPRESS_APP_SECRET;
    if (!key || !secret) return null;
    try {
        const params = {
            app_key: key,
            method: 'aliexpress.affiliate.productdetail.get',
            sign_method: 'sha256',
            timestamp: String(Date.now()),
            product_ids: itemId,
            target_currency: 'USD',
            target_language: 'EN',
        };
        const base = Object.keys(params).sort().map(k => k + params[k]).join('');
        params.sign = createHmac('sha256', secret).update(base).digest('hex').toUpperCase();
        const res = await fetch('https://api-sg.aliexpress.com/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
            body: new URLSearchParams(params),
            signal: AbortSignal.timeout(8000),
        });
        const data = await res.json();
        const p = data.aliexpress_affiliate_productdetail_get_response?.resp_result?.result?.products?.product?.[0];
        if (!p) { console.error('[affiliate-api]', JSON.stringify(data).slice(0, 300)); return null; }
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

async function firstWorkingImage(candidates) {
    for (const url of candidates) {
        if (!isProductImage(url)) continue;
        try {
            const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
            if (res.ok && (res.headers.get('content-type') || '').startsWith('image/')) return url;
        } catch { /* try next */ }
    }
    return '';
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
    return m ? JSON.parse(m[0]) : {};
}

const OUTPUT_RULES = `- "title": a clean, readable product name (max 70 chars, no keyword stuffing, Title Case)
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

// The bot check on cloud IPs is intermittent, so keep retrying the direct read
// while the reader service works in parallel. (AI "URL reading" was tried and
// dropped: it returns confident titles of unrelated products.)
async function readPage(itemId, deadline) {
    let done = false;
    const reader = fetchViaReader(itemId).then(r => { if (r.rawTitle) done = true; return r; });
    let og = { rawTitle: '', image: '' };
    while (!done && Date.now() < deadline) {
        og = await fetchOpenGraph(itemId);
        if (og.rawTitle) break;
        await new Promise(r => setTimeout(r, 1500));
    }
    if (og.rawTitle && og.image) return og;
    const r = await reader;
    return { rawTitle: og.rawTitle || r.rawTitle, image: await firstWorkingImage([og.image, r.image]) };
}

async function handleDetect({ url }) {
    if (!/^https?:\/\/([a-z0-9-]+\.)*aliexpress\.(com|us|ru)\b/i.test(url || '')) {
        return json({ error: 'Please paste an AliExpress link (aliexpress.com, s.click.aliexpress.com, …)' }, 400);
    }
    const itemId = await resolveItemId(url);
    if (!itemId) return json({ error: 'Could not find the product behind this link. Fill in the details manually.' }, 422);

    let page = await fetchViaAffiliateApi(itemId);
    if (!page?.rawTitle) page = await readPage(itemId, Date.now() + 30000);
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
        Object.assign(product, fields, { updatedAt: new Date().toISOString() });
    } else {
        product = { id: randomUUID(), ...fields, createdAt: new Date().toISOString() };
        products.unshift(product);
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

export const handler = async (event) => {
    if (event.requestContext?.http?.method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

    try {
        const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body;
        const body = JSON.parse(raw || '{}');

        switch (body.action) {
            case 'list':
                return json({ products: await loadProducts(), categories: CATEGORIES });

            case 'login':
                if (!process.env.ADMIN_PASSWORD) return json({ error: 'Admin password is not configured yet' }, 503);
                if (!passwordMatches(body.password)) {
                    await new Promise(r => setTimeout(r, 1000)); // slow down guessing
                    return json({ error: 'Wrong password' }, 401);
                }
                return json({ token: issueToken() });
        }

        if (!isAdmin(event)) return json({ error: 'Unauthorized' }, 401);

        switch (body.action) {
            case 'check':  return json({ ok: true, categories: CATEGORIES });
            case 'detect': return await handleDetect(body);
            case 'classify': return await handleClassify(body);
            case 'save':   return await handleSave(body);
            case 'delete': return await handleDelete(body);
            default:       return json({ error: 'Unknown action' }, 400);
        }
    } catch (error) {
        console.error(error);
        return json({ error: error.message }, 500);
    }
};
