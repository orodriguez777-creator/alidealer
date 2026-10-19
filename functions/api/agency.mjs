/**
 * AI marketing agency: a small team of agents that promotes the shop's deals.
 *
 *   Strategist  picks the day's deals (click stats, variety, nothing repeated within 14 days)
 *   Copywriter  writes each deal's post for every channel, in Hebrew and English
 *   Editor      checks the posts (no invented claims, platform limits) and fixes them
 *   Publisher   posts approved drafts at their time slot to the connected channels
 *   SEO writer  drafts a weekly buying guide (made into pages by scripts/build-pages.mjs)
 *   Analyst     weekly report: visits per channel, top deals, advice for the strategist
 *
 * Runs from the api function's hourly schedule. Drafts wait for the owner's approval
 * in admin unless Autopilot is on. State: one JSON document, data/agency.json.
 *
 * Channel secrets (functions/api/.env): TELEGRAM_BOT_TOKEN, META_PAGE_TOKEN,
 * THREADS_TOKEN, PINTEREST_TOKEN. Channel ids (chat, page, board) live in settings.
 */
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';

const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-central-1' });
const AGENCY_KEY = 'data/agency.json';
const VISIT_EVENTS = 'clicks/visits/';
const TZ = 'Asia/Jerusalem';
const GRAPH = 'https://graph.facebook.com/v23.0';
const REPEAT_DAYS = 14;

// filled in by index.mjs (shared helpers live there)
let ctx;
export const initAgency = (helpers) => { ctx = helpers; };

// link: false → the platform doesn't make links in the text clickable
export const CHANNELS = {
    telegram: { name: 'Telegram', auto: true, tag: 'tg', max: 900, style: 'Telegram channel post: a punchy hook line, then 2-4 short lines, a few fitting emoji, up to 3 hashtags at the end' },
    facebook: { name: 'Facebook Page', auto: true, tag: 'fb', max: 1200, style: 'Facebook Page post: friendly and conversational, 3-5 short lines, end with a short question that invites comments, up to 3 hashtags' },
    instagram: { name: 'Instagram', auto: true, tag: 'ig', max: 1900, link: false, style: 'Instagram caption: strong first line, 3-5 short lines with emoji, then a line saying the link is in the bio (alidealer.com), then 8-12 relevant hashtags on the last line' },
    threads: { name: 'Threads', auto: true, tag: 'th', max: 400, style: 'Threads post: casual and a bit witty, 1-3 short lines, at most 1 hashtag' },
    pinterest: { name: 'Pinterest', auto: true, tag: 'pin', max: 450, link: false, style: 'Pinterest pin description: helpful and keyword-rich, 2-3 sentences on what it is and who it is for, no hashtags, no emoji' },
    x: { name: 'X (Twitter)', auto: false, tag: 'x', max: 230, style: 'X post: one or two punchy lines, at most 2 hashtags, under 230 characters' },
    tiktok: { name: 'TikTok', auto: false, tag: 'tt', max: 1200, link: false, style: 'TikTok: first a caption line, then a 3-shot idea for a 10-second clip (hook, the product in use, the price and "link in bio"), each shot on its own line starting with 🎬, then 4-6 hashtags' },
    fbgroups: { name: 'Facebook groups', auto: false, tag: 'fbg', max: 900, style: 'Post for an Israeli AliExpress deals group on Facebook, written as a member sharing a find: personal and down to earth, 3-5 short lines, the price, one line that the price may change on AliExpress, a short question that invites comments, a line saying it is an affiliate link, no hashtags' },
    whatsapp: { name: 'WhatsApp', auto: false, tag: 'wa', max: 600, style: 'WhatsApp group message: like a friend sharing a find, 3-4 short lines, a couple of emoji, no hashtags' },
    linkedin: { name: 'LinkedIn', auto: false, tag: 'li', max: 1100, style: 'LinkedIn post: practical angle (work from home, productivity, a smart buy), 3-5 lines, 2-3 hashtags, no silly tone' },
    reddit: { name: 'Reddit', auto: false, tag: 'rd', max: 1100, style: 'Reddit post: honest and low-key, no hype and no emoji; a title on the first line, then 2-3 plain sentences, and say openly that the link is an affiliate link' },
};
const TAGS = new Set(Object.values(CHANNELS).map(c => c.tag));

const DEFAULTS = {
    paused: false,
    autopilot: false,
    perDay: 3,
    slots: ['09:00', '13:00', '19:00'],
    publishLang: 'he',              // he | en | both — language posted to the automatic channels
    channels: Object.keys(CHANNELS), // channels the copywriter writes for
    guides: true,
    telegramChat: '', facebookPageId: '', instagramId: '', threadsUserId: '', pinterestBoard: '',
};

// ---------- storage ----------

async function getJson(Key, fallback) {
    try {
        const res = await s3.send(new GetObjectCommand({ Bucket: process.env.STORAGE_BUCKET, Key }));
        return JSON.parse(await res.Body.transformToString());
    } catch (e) {
        if (e.name === 'NoSuchKey') return fallback;
        throw e;
    }
}

async function loadAgency() {
    const doc = await getJson(AGENCY_KEY, {});
    return {
        drafts: [], guides: [], reports: [], visits: {}, lastDaily: null, lastWeekly: null, log: [],
        ...doc,
        settings: { ...DEFAULTS, ...doc.settings },
    };
}

// Background work is slow (AI calls), so changes are applied to a fresh copy of the
// document at the end, never to one read minutes ago.
async function mutate(fn) {
    const doc = await loadAgency();
    const out = await fn(doc);
    await s3.send(new PutObjectCommand({ Bucket: process.env.STORAGE_BUCKET, Key: AGENCY_KEY, Body: JSON.stringify(doc), ContentType: 'application/json' }));
    return out === undefined ? doc : out;
}

function logLine(doc, text) {
    doc.log = [{ at: new Date().toISOString(), text }, ...doc.log].slice(0, 40);
}

// ---------- Israel time ----------

const ilParts = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
}).formatToParts(ms).map(p => [p.type, p.value]));
const ilDate = (ms) => { const p = ilParts(ms); return `${p.year}-${p.month}-${p.day}`; };

// Israel wall-clock time on a date → timestamp
function ilTime(date, hhmm) {
    const guess = Date.parse(`${date}T${hhmm}:00Z`);
    const p = ilParts(guess);
    return guess - (Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) - guess);
}

// The next free publishing slots, starting now
function nextSlots(doc, n) {
    const taken = new Set(doc.drafts.filter(d => d.status !== 'skipped').map(d => d.slot));
    const slots = [...doc.settings.slots].sort();
    const out = [];
    for (let day = 0; out.length < n && day < 14; day++) {
        const date = ilDate(Date.now() + day * 86400000);
        for (const s of slots) {
            const at = new Date(ilTime(date, s)).toISOString();
            if (Date.parse(at) > Date.now() + 10 * 60000 && !taken.has(at)) out.push(at);
            if (out.length === n) break;
        }
    }
    return out;
}

// ---------- visits per channel (the ?s= tag on share links) ----------

const BOT_UA = /bot|crawl|spider|preview|facebookexternalhit|whatsapp|telegram|slack|discord|curl|wget|python|headless|pinterest|twitter|linkedin/i;

export async function recordVisit(tag, ua) {
    if (!TAGS.has(tag) || BOT_UA.test(ua || '')) return;
    try {
        await s3.send(new PutObjectCommand({ Bucket: process.env.STORAGE_BUCKET, Key: `${VISIT_EVENTS}${tag}/${Date.now()}-${randomUUID().slice(0, 8)}`, Body: '' }));
    } catch (e) { console.error('[visit]', e.message); }
}

async function foldVisits() {
    const Bucket = process.env.STORAGE_BUCKET;
    const add = {};
    const keys = [];
    let token;
    do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: VISIT_EVENTS, ContinuationToken: token }));
        for (const { Key } of page.Contents || []) {
            const [tag, stamp] = Key.slice(VISIT_EVENTS.length).split('/');
            const day = new Date(Number(stamp.split('-')[0])).toISOString().slice(0, 10);
            (add[tag] ||= {})[day] = (add[tag][day] || 0) + 1;
            keys.push(Key);
        }
        token = page.NextContinuationToken;
    } while (token);
    if (!keys.length) return;
    await mutate(doc => {
        const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
        for (const [tag, days] of Object.entries(add)) {
            const v = doc.visits[tag] ||= {};
            for (const [d, n] of Object.entries(days)) v[d] = (v[d] || 0) + n;
        }
        for (const v of Object.values(doc.visits)) for (const d of Object.keys(v)) if (d < cutoff) delete v[d];
    });
    for (let i = 0; i < keys.length; i += 1000) {
        await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys.slice(i, i + 1000).map(Key => ({ Key })), Quiet: true } }));
    }
}

function visitTotals(doc, days) {
    const from = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
    const out = {};
    for (const [key, ch] of Object.entries(CHANNELS)) {
        out[key] = Object.entries(doc.visits[ch.tag] || {}).reduce((n, [d, v]) => n + (d >= from ? v : 0), 0);
    }
    return out;
}

// ---------- the agents ----------

const FACT_RULES = `- Use only the facts given. Never invent ratings, reviews, stock levels, shipping times, discounts, "limited time" or "lowest price ever".
- If a price is given, you may mention it, but say it is the price when we picked it (it can change on AliExpress). If no price is given, do not mention one.
- Never claim that we bought, tried or used the product; we found and picked it.
- Do not include any links or URLs; the link is added after your text. A plain sentence saying the link is an affiliate link is fine (Reddit needs it) and must be kept.
- Hebrew must be natural, everyday Israeli Hebrew (not a translation); English casual and friendly.`;

const linkFor = (id, lang, channel) => `${ctx.shareUrl(id, lang)}?s=${CHANNELS[channel].tag}`;

// Strategist: which deals to promote next
async function strategist(doc, products, clicks, n) {
    const since = Date.now() - REPEAT_DAYS * 86400000;
    const recent = new Set(doc.drafts.filter(d => d.status !== 'skipped' && Date.parse(d.createdAt) > since).map(d => d.productId));
    const promoted = {};
    doc.drafts.filter(d => d.status === 'posted').forEach(d => { promoted[d.productId] = (promoted[d.productId] || 0) + 1; });
    const pool = products.filter(p => p.image && !recent.has(p.id)).slice(0, 80).map(p => ({
        id: p.id, title: p.title, category: p.category, price: p.price || '',
        clicks: clicks[p.id]?.total || 0, clicksWeek: clicks[p.id]?.week || 0,
        daysListed: Math.round((Date.now() - Date.parse(p.createdAt)) / 86400000),
        timesPromoted: promoted[p.id] || 0,
    }));
    if (!pool.length) return { theme: '', picks: [] };
    const advice = doc.reports[0]?.advice || '';
    let out = {};
    try {
        out = await ctx.gemini(ctx.model, `You are the strategist of a small marketing team promoting www.Alidealer.com, a site of hand-picked AliExpress deals for shoppers in Israel and abroad.
Today is ${ilDate(Date.now())} (Israel). Pick the ${n} best deals to post on social media today.

Think about: what people need this season and this week (holidays, weather, back to school, etc.), deals that already get clicks, new deals that deserve a first push, variety (different categories, different price points), and nothing that was promoted many times already.
${advice ? `Advice from last week's analytics report: ${advice}\n` : ''}
Candidate deals (JSON):
${JSON.stringify(pool)}

Return JSON {"theme": "one short line: the idea behind today's picks", "picks": [{"id": "...", "angle": "one sentence: the angle the copywriter should use for this deal"}]} with exactly ${n} picks, ids copied exactly from the candidates.`,
        { generationConfig: { maxOutputTokens: 2000, responseMimeType: 'application/json', temperature: 0.8 } }, 40000);
    } catch (e) { console.error('[strategist]', e.message); }
    const byId = new Map(pool.map(p => [p.id, p]));
    const picks = (Array.isArray(out.picks) ? out.picks : []).filter(p => byId.has(p.id));
    const unique = [...new Map(picks.map(p => [p.id, p])).values()].slice(0, n);
    // fallback (or top-up): most-clicked first, then newest, one per category
    if (unique.length < n) {
        const cats = new Set(unique.map(p => byId.get(p.id).category));
        const ranked = [...pool].sort((a, b) => (b.clicksWeek * 3 + b.clicks) - (a.clicksWeek * 3 + a.clicks) || a.daysListed - b.daysListed);
        for (const p of ranked) {
            if (unique.length >= n) break;
            if (unique.some(u => u.id === p.id) || (cats.has(p.category) && ranked.length > n * 2)) continue;
            unique.push({ id: p.id, angle: '' });
            cats.add(p.category);
        }
    }
    return { theme: String(out.theme || '').slice(0, 200), picks: unique };
}

// Copywriter: one post per channel and language
async function copywriter(p, angle, theme, channels) {
    const specs = channels.map(c => `- "${c}": ${CHANNELS[c].style}. Max ${CHANNELS[c].max} characters.`).join('\n');
    const out = await ctx.gemini(ctx.writeModel, `You are the copywriter of www.Alidealer.com, a site of hand-picked AliExpress deals. Write social media posts for this deal.

Product (English name): ${p.title}
Product (Hebrew name): ${p.titleHe || p.title}
Category: ${p.category}
${p.price ? `Price when we picked it: ${p.price}` : 'Price: not given'}
${angle ? `Angle to use: ${angle}` : ''}${theme ? `\nToday's theme: ${theme}` : ''}

Channels and their style:
${specs}

Rules:
${FACT_RULES}
- Each channel must read differently; don't paste the same text everywhere.

Return JSON {"he": {${channels.map(c => `"${c}": "..."`).join(', ')}}, "en": {same keys}} using \\n for line breaks.`,
    { generationConfig: { maxOutputTokens: 16000, responseMimeType: 'application/json', temperature: 1, thinkingConfig: { thinkingLevel: 'low' } } }, 90000);
    return out;
}

// Editor: checks the copywriter's work against the facts and the platform limits
async function editor(p, posts, channels) {
    try {
        const out = await ctx.gemini(ctx.writeModel, `You are the editor of a small marketing team. Check these social posts for an AliExpress deal and fix any that break the rules. Keep posts that are fine exactly as they are.

Facts (the only facts allowed): ${JSON.stringify({ name: p.title, nameHe: p.titleHe, category: p.category, price: p.price || null })}
Limits (characters): ${JSON.stringify(Object.fromEntries(channels.map(c => [c, CHANNELS[c].max])))}

Rules:
${FACT_RULES}
- Fix spelling, awkward Hebrew, and anything over its limit.

Posts:
${JSON.stringify(posts)}

Return JSON {"he": {...}, "en": {...}, "notes": "one short line on what you changed, or empty"} with the same keys.`,
        { generationConfig: { maxOutputTokens: 16000, responseMimeType: 'application/json', temperature: 0.3, thinkingConfig: { thinkingLevel: 'low' } } }, 90000);
        const ok = ['he', 'en'].every(l => channels.every(c => typeof out[l]?.[c] === 'string' && out[l][c].trim()));
        return ok ? out : { ...posts, notes: '' };
    } catch (e) {
        console.error('[editor]', e.message);
        return { ...posts, notes: '' };
    }
}

function clip(text, max) {
    text = String(text || '').trim();
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
    return (at > max * 0.6 ? cut.slice(0, at + 1) : cut.replace(/\s+\S*$/, '…')).trim();
}

async function makeDraft(p, pick, theme, channels, slot) {
    let raw = await copywriter(p, pick.angle, theme, channels).catch(e => { console.error('[copywriter]', e.message); return {}; });
    if (!raw.he && !raw.en) raw = await copywriter(p, pick.angle, theme, channels); // one retry
    const edited = await editor(p, raw, channels);
    const posts = {};
    for (const c of channels) {
        posts[c] = {};
        for (const l of ['he', 'en']) {
            const text = clip(edited[l]?.[c] || raw[l]?.[c], CHANNELS[c].max);
            if (text) posts[c][l] = text;
        }
        if (!Object.keys(posts[c]).length) delete posts[c];
    }
    if (!Object.keys(posts).length) throw new Error('the copywriter came back empty');
    return {
        id: randomUUID(), productId: p.id, title: p.title, titleHe: p.titleHe || '', image: p.image, price: p.price || '', category: p.category,
        angle: pick.angle || '', theme, notes: String(edited.notes || '').slice(0, 300),
        slot, status: 'waiting', posts, results: {}, createdAt: new Date().toISOString(),
    };
}

// Strategist → copywriter → editor for the next free slots
async function runDaily(n) {
    const [doc, products, clicks] = await Promise.all([loadAgency(), ctx.loadProducts(), ctx.foldClicks().catch(() => ({}))]);
    const count = Math.max(1, Math.min(10, n || doc.settings.perDay));
    const { theme, picks } = await strategist(doc, products, clicks, count);
    const slots = nextSlots(doc, picks.length);
    const channels = doc.settings.channels.filter(c => CHANNELS[c]);
    const byId = new Map(products.map(p => [p.id, p]));
    const made = await Promise.allSettled(picks.map((pick, i) => makeDraft(byId.get(pick.id), pick, theme, channels, slots[i])));
    const drafts = made.filter(r => r.status === 'fulfilled').map(r => r.value);
    const errors = made.filter(r => r.status === 'rejected').map(r => r.reason?.message);
    return mutate(fresh => {
        fresh.drafts = [...drafts, ...fresh.drafts].slice(0, 300);
        if (drafts.length || !errors.length) fresh.lastDaily = ilDate(Date.now()); // all failed → retry next hour
        logLine(fresh, `${drafts.length} new draft${drafts.length === 1 ? '' : 's'}${theme ? ` · theme: ${theme}` : ''}${errors.length ? ` · ${errors.length} failed: ${errors[0]}` : ''}`);
        return { drafts, errors, theme };
    });
}

// SEO writer: a buying guide built only from deals on the site
async function runGuide() {
    const [doc, products] = await Promise.all([loadAgency(), ctx.loadProducts()]);
    const used = doc.guides.filter(g => g.status !== 'skipped').map(g => g.title);
    const out = await ctx.gemini(ctx.writeModel, `You are the SEO writer of www.Alidealer.com, a site of hand-picked AliExpress deals (English and Hebrew).
Write one buying-guide article that people actually search for on Google, using ONLY deals from the list below (5 to 8 of them that fit one topic: a category, a budget like "under $10", a season, a room, a gift idea…).
${used.length ? `Earlier guides (pick a different topic): ${JSON.stringify(used.slice(0, 20))}\n` : ''}
Rules:
${FACT_RULES}
- Search-friendly title (max 65 chars) and meta description (max 155 chars) in both languages.
- "why": 2-3 helpful sentences per deal: what it is, who it suits, what to check before buying.

Deals (JSON):
${JSON.stringify(products.slice(0, 150).map(p => ({ id: p.id, title: p.title, titleHe: p.titleHe, category: p.category, price: p.price })))}

Return JSON {"slug": "english-url-slug", "title": "...", "titleHe": "...", "description": "...", "descriptionHe": "...", "intro": "2-3 sentences", "introHe": "...", "items": [{"id": "...", "why": "...", "whyHe": "..."}], "outro": "1-2 sentences", "outroHe": "..."}`,
    { generationConfig: { maxOutputTokens: 10000, responseMimeType: 'application/json', temperature: 0.9 } }, 90000);
    const ids = new Set(products.map(p => p.id));
    const items = (Array.isArray(out.items) ? out.items : []).filter(i => ids.has(i.id) && i.why);
    if (!out.title || items.length < 3) throw new Error('the SEO writer came back incomplete');
    const slug = String(out.slug || out.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
    const guide = {
        id: randomUUID(), status: 'waiting', createdAt: new Date().toISOString(),
        slug, title: String(out.title).slice(0, 90), titleHe: String(out.titleHe || '').slice(0, 90),
        description: String(out.description || '').slice(0, 170), descriptionHe: String(out.descriptionHe || '').slice(0, 170),
        intro: String(out.intro || ''), introHe: String(out.introHe || ''), outro: String(out.outro || ''), outroHe: String(out.outroHe || ''),
        items: items.map(i => ({ id: i.id, why: String(i.why), whyHe: String(i.whyHe || '') })),
    };
    return mutate(fresh => {
        if (fresh.guides.some(g => g.slug === guide.slug)) guide.slug += '-' + guide.id.slice(0, 4);
        fresh.guides = [guide, ...fresh.guides].slice(0, 100);
        logLine(fresh, `SEO writer drafted a guide: ${guide.title}`);
        return guide;
    });
}

// Analyst: the week in numbers, plus one piece of advice for the strategist
async function runReport() {
    await foldVisits();
    const [doc, products, clicks] = await Promise.all([loadAgency(), ctx.loadProducts(), ctx.foldClicks().catch(() => ({}))]);
    const weekAgo = Date.now() - 7 * 86400000;
    const posted = doc.drafts.filter(d => d.status === 'posted' && Date.parse(d.slot) > weekAgo);
    const postsPerChannel = {};
    posted.forEach(d => Object.entries(d.results || {}).forEach(([c, r]) => { if (r.ok) postsPerChannel[c] = (postsPerChannel[c] || 0) + 1; }));
    const visits = visitTotals(doc, 7);
    const byId = new Map(products.map(p => [p.id, p]));
    const topDeals = Object.entries(clicks).filter(([id]) => byId.has(id)).sort((a, b) => b[1].week - a[1].week).slice(0, 5)
        .map(([id, c]) => ({ title: byId.get(id).title, category: byId.get(id).category, clicksWeek: c.week }));
    const promotedClicks = posted.map(d => ({ title: d.title, clicksWeek: clicks[d.productId]?.week || 0 }));
    const numbers = { postsPerChannel, visitsPerChannel: visits, topDeals, promotedDeals: promotedClicks, totalClicksWeek: Object.values(clicks).reduce((n, c) => n + c.week, 0) };
    let out = {};
    try {
        out = await ctx.gemini(ctx.writeModel, `You are the analyst of a small marketing team promoting www.Alidealer.com (AliExpress deals). Here are last week's numbers:
${JSON.stringify(numbers)}
"visitsPerChannel" counts people who opened a shared deal link from that channel; clicks are clicks through to AliExpress.

Return JSON {"summary": "3-5 plain sentences for the shop owner: what worked, what didn't", "advice": "one or two sentences of concrete advice for next week's deal picks and channels"}. Be honest when numbers are too small to conclude anything.`,
        { generationConfig: { maxOutputTokens: 1500, responseMimeType: 'application/json', temperature: 0.4 } }, 40000);
    } catch (e) { console.error('[analyst]', e.message); }
    const report = { at: new Date().toISOString(), numbers, summary: String(out.summary || ''), advice: String(out.advice || '') };
    return mutate(fresh => {
        fresh.reports = [report, ...fresh.reports].slice(0, 12);
        logLine(fresh, 'Analyst wrote the weekly report');
        return report;
    });
}

// ---------- publishing ----------

async function callJson(url, init) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error || data.ok === false) {
        const msg = data.error?.message || data.description || data.message || (typeof data.error === 'string' ? data.error : '') || `HTTP ${res.status}`;
        throw new Error(msg);
    }
    return data;
}
const form = (params) => ({ method: 'POST', body: new URLSearchParams(params) });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// AliExpress sometimes serves photos as .webp/.avif; Instagram and Threads need the jpg
const plainImage = (url) => String(url || '').replace(/_\.(webp|avif)$/i, '').replace(/\.jpg_\d+x\d+[^/]*$/i, '.jpg');

const env = (k) => process.env[k] || '';

// what each automatic channel needs before it can post
function connection(st) {
    return {
        telegram: !!(env('TELEGRAM_BOT_TOKEN') && st.telegramChat),
        facebook: !!(env('META_PAGE_TOKEN') && st.facebookPageId),
        instagram: !!(env('META_PAGE_TOKEN') && st.instagramId),
        threads: !!(env('THREADS_TOKEN') && st.threadsUserId),
        pinterest: !!(env('PINTEREST_TOKEN') && st.pinterestBoard),
    };
}

// Fill in the account ids the tokens can tell us, so the user only has to save the tokens.
// A Page token's /me is the Page itself; the Page knows its linked Instagram account.
async function autoIds(st) {
    const found = {};
    const meta = env('META_PAGE_TOKEN');
    if (meta) {
        if (!/^\d+$/.test(st.facebookPageId || '')) {
            const page = await callJson(`${GRAPH}/me?fields=id&access_token=${meta}`).catch(() => ({}));
            if (page.id) found.facebookPageId = page.id;
        }
        const pageId = found.facebookPageId || st.facebookPageId;
        if (!st.instagramId && /^\d+$/.test(pageId || '')) {
            const r = await callJson(`${GRAPH}/${pageId}?fields=instagram_business_account&access_token=${meta}`).catch(() => ({}));
            if (r.instagram_business_account?.id) found.instagramId = r.instagram_business_account.id;
        }
    }
    if (env('THREADS_TOKEN') && !st.threadsUserId) {
        const r = await callJson(`https://graph.threads.net/v1.0/me?fields=id&access_token=${env('THREADS_TOKEN')}`).catch(() => ({}));
        if (r.id) found.threadsUserId = r.id;
    }
    if (!Object.keys(found).length) return st;
    await mutate(doc => { Object.assign(doc.settings, found); });
    return { ...st, ...found };
}

const PUBLISH = {
    async telegram(st, d, text, link) {
        const api = `https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}`;
        const caption = `${text}\n\n👉 ${link}`;
        let r;
        try {
            r = await callJson(`${api}/sendPhoto`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: st.telegramChat, photo: d.image, caption }) });
        } catch (e) {
            if (!/photo|image|file|wrong type/i.test(e.message)) throw e;
            r = await callJson(`${api}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: st.telegramChat, text: caption }) });
        }
        const user = r.result?.chat?.username;
        return { id: String(r.result?.message_id || ''), url: user ? `https://t.me/${user}/${r.result.message_id}` : '' };
    },
    async facebook(st, d, text, link) {
        const r = await callJson(`${GRAPH}/${st.facebookPageId}/photos`, form({ url: d.image, message: `${text}\n\n👉 ${link}`, access_token: env('META_PAGE_TOKEN') }));
        return { id: r.post_id || r.id, url: `https://www.facebook.com/${r.post_id || r.id}` };
    },
    async instagram(st, d, text) {
        const token = env('META_PAGE_TOKEN');
        const box = await callJson(`${GRAPH}/${st.instagramId}/media`, form({ image_url: plainImage(d.image), caption: text, access_token: token }));
        let r;
        for (let i = 0; ; i++) { // the photo is fetched in the background; publishing too early fails
            try { r = await callJson(`${GRAPH}/${st.instagramId}/media_publish`, form({ creation_id: box.id, access_token: token })); break; }
            catch (e) { if (i >= 4) throw e; await sleep(4000); }
        }
        const info = await callJson(`${GRAPH}/${r.id}?fields=permalink&access_token=${token}`).catch(() => ({}));
        return { id: r.id, url: info.permalink || '' };
    },
    async threads(st, d, text, link) {
        const token = env('THREADS_TOKEN');
        const base = `https://graph.threads.net/v1.0/${st.threadsUserId}`;
        const box = await callJson(`${base}/threads`, form({ media_type: 'IMAGE', image_url: plainImage(d.image), text: `${text}\n\n${link}`, access_token: token }));
        let r;
        for (let i = 0; ; i++) {
            await sleep(i ? 6000 : 3000);
            try { r = await callJson(`${base}/threads_publish`, form({ creation_id: box.id, access_token: token })); break; }
            catch (e) { if (i >= 4) throw e; }
        }
        const info = await callJson(`https://graph.threads.net/v1.0/${r.id}?fields=permalink&access_token=${token}`).catch(() => ({}));
        return { id: r.id, url: info.permalink || '' };
    },
    async pinterest(st, d, text, link, lang) {
        const r = await callJson('https://api.pinterest.com/v5/pins', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env('PINTEREST_TOKEN')}` },
            body: JSON.stringify({
                board_id: st.pinterestBoard, link,
                title: ((lang === 'he' && d.titleHe) || d.title).slice(0, 100),
                description: text.slice(0, 500), alt_text: d.title.slice(0, 500),
                media_source: { source_type: 'image_url', url: plainImage(d.image) },
            }),
        });
        return { id: r.id, url: `https://www.pinterest.com/pin/${r.id}/` };
    },
};

// Post one draft to every connected channel it hasn't reached yet
async function publishDraft(id) {
    // claim it first, so the hourly run and a click in admin never post it twice
    const d = await mutate(doc => {
        const x = doc.drafts.find(y => y.id === id);
        if (!x || x.status === 'publishing' && Date.parse(x.claimedAt) > Date.now() - 10 * 60000) return null;
        x.status = 'publishing';
        x.claimedAt = new Date().toISOString();
        return { ...x, settings: doc.settings };
    });
    if (!d) return null;
    const st = await autoIds(d.settings);
    const conn = connection(st);
    const langs = st.publishLang === 'both' ? ['he', 'en'] : [st.publishLang];
    const results = { ...d.results };
    for (const c of Object.keys(PUBLISH)) {
        if (!conn[c] || !d.posts[c] || !st.channels.includes(c)) continue;
        for (const l of langs) {
            const key = langs.length > 1 ? `${c}-${l}` : c;
            if (results[key]?.ok || !d.posts[c][l]) continue;
            try {
                // guide posts carry their own page links instead of a deal
                const r = await PUBLISH[c](st, d, d.posts[c][l], d.links?.[l] || linkFor(d.productId, l, c), l);
                results[key] = { ok: true, ...r, at: new Date().toISOString() };
            } catch (e) {
                console.error(`[publish ${key}]`, e.message);
                results[key] = { ok: false, error: e.message.slice(0, 300), at: new Date().toISOString() };
            }
        }
    }
    return mutate(doc => {
        const x = doc.drafts.find(y => y.id === id);
        if (!x) return null;
        x.results = results;
        x.status = 'posted';
        x.postedAt = new Date().toISOString();
        delete x.claimedAt;
        const failed = Object.entries(results).filter(([, r]) => !r.ok).map(([k]) => k);
        const ok = Object.values(results).filter(r => r.ok).length;
        logLine(doc, `Published "${x.title}": ${ok} channel${ok === 1 ? '' : 's'}${failed.length ? `, failed: ${failed.join(', ')}` : ''}`);
        return x;
    });
}

async function publishDue(deadline) {
    const doc = await loadAgency();
    if (doc.settings.paused) return 0;
    const due = doc.drafts.filter(d => Date.parse(d.slot) <= Date.now()
        && (d.status === 'approved' || (d.status === 'waiting' && doc.settings.autopilot && !d.hold))); // hold = only after the owner's OK
    let n = 0;
    for (const d of due) {
        if (Date.now() > deadline) break;
        if (await publishDraft(d.id)) n++;
    }
    return n;
}

// ---------- schedule ----------

const isoWeek = (ms) => {
    const d = new Date(ms);
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const start = Date.UTC(d.getUTCFullYear(), 0, 1);
    return `${d.getUTCFullYear()}-W${String(Math.ceil(((d - start) / 86400000 + 1) / 7)).padStart(2, '0')}`;
};

// Called every hour by the api function's schedule
export async function agencyHourly(deadline) {
    const doc = await loadAgency();
    const done = [];
    if (doc.settings.paused) return ['paused'];
    const now = ilParts(Date.now());
    try { done.push(`published ${await publishDue(deadline - 90000)}`); } catch (e) { console.error('[agency publish]', e); }
    // the day's drafts are written early in the morning, Israel time
    if (+now.hour >= 6 && doc.lastDaily !== ilDate(Date.now()) && Date.now() < deadline - 120000) {
        try { const r = await runDaily(); done.push(`drafted ${r.drafts.length}`); } catch (e) { console.error('[agency daily]', e); }
    }
    // Mondays: the analyst's report and the SEO writer's guide
    if (now.weekday === 'Mon' && +now.hour >= 7 && doc.lastWeekly !== isoWeek(Date.now())) {
        await mutate(d => { d.lastWeekly = isoWeek(Date.now()); });
        if (Date.now() < deadline - 60000) try { await runReport(); done.push('report'); } catch (e) { console.error('[agency report]', e); }
        if (doc.settings.guides && Date.now() < deadline - 100000) try { await runGuide(); done.push('guide'); } catch (e) { console.error('[agency guide]', e); }
    }
    return done;
}

// ---------- admin actions ----------

async function view() {
    await foldVisits().catch(e => console.error('[visits]', e.message));
    const doc = await loadAgency();
    doc.settings = await autoIds(doc.settings);
    const since = Date.now() - 30 * 86400000;
    return {
        settings: doc.settings,
        drafts: doc.drafts.filter(d => d.status !== 'skipped' && (Date.parse(d.slot || d.createdAt) > since || d.status === 'waiting' || d.status === 'approved')).slice(0, 80),
        guides: doc.guides.filter(g => g.status !== 'skipped').slice(0, 30),
        reports: doc.reports.slice(0, 4),
        log: doc.log.slice(0, 15),
        visits: { week: visitTotals(doc, 7), month: visitTotals(doc, 30) },
        connected: connection(doc.settings),
        secrets: { telegram: !!env('TELEGRAM_BOT_TOKEN'), meta: !!env('META_PAGE_TOKEN'), threads: !!env('THREADS_TOKEN'), pinterest: !!env('PINTEREST_TOKEN') },
        channels: Object.fromEntries(Object.entries(CHANNELS).map(([k, c]) => [k, { name: c.name, auto: c.auto, tag: c.tag, max: c.max, link: c.link !== false }])),
        lastDaily: doc.lastDaily,
    };
}

function cleanSettings(cur, s = {}) {
    const slot = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
    const id = (v, d) => v === undefined ? d : String(v).trim().slice(0, 120);
    return {
        paused: s.paused === undefined ? cur.paused : !!s.paused,
        autopilot: s.autopilot === undefined ? cur.autopilot : !!s.autopilot,
        perDay: Number.isFinite(+s.perDay) && s.perDay !== '' && s.perDay !== undefined ? Math.min(10, Math.max(1, Math.round(+s.perDay))) : cur.perDay,
        slots: Array.isArray(s.slots) ? [...new Set(s.slots.filter(slot))].sort().slice(0, 10) : cur.slots,
        publishLang: ['he', 'en', 'both'].includes(s.publishLang) ? s.publishLang : cur.publishLang,
        channels: Array.isArray(s.channels) ? s.channels.filter(c => CHANNELS[c]) : cur.channels,
        guides: s.guides === undefined ? cur.guides : !!s.guides,
        telegramChat: id(s.telegramChat, cur.telegramChat),
        facebookPageId: id(s.facebookPageId, cur.facebookPageId),
        instagramId: id(s.instagramId, cur.instagramId),
        threadsUserId: id(s.threadsUserId, cur.threadsUserId),
        pinterestBoard: id(s.pinterestBoard, cur.pinterestBoard),
    };
}

// Checks a channel's connection without posting anything
async function testChannel(channel) {
    const st = await autoIds((await loadAgency()).settings);
    const meta = env('META_PAGE_TOKEN');
    switch (channel) {
        case 'telegram': {
            if (!env('TELEGRAM_BOT_TOKEN')) throw new Error('The bot token is not saved yet');
            const api = `https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}`;
            const bot = (await callJson(`${api}/getMe`)).result;
            if (!st.telegramChat) return `The bot @${bot.username} works. Now put your channel (like @yourchannel) in Settings and save.`;
            const chat = (await callJson(`${api}/getChat?chat_id=${encodeURIComponent(st.telegramChat)}`).catch(() => {
                throw new Error(`The bot @${bot.username} can't see ${st.telegramChat}. Check the name, and add the bot to the channel as an administrator.`);
            })).result;
            const me = (await callJson(`${api}/getChatMember?chat_id=${encodeURIComponent(st.telegramChat)}&user_id=${bot.id}`)).result;
            if (me.status !== 'administrator' && me.status !== 'creator') throw new Error(`@${bot.username} is in "${chat.title}" but isn't an administrator. Make it an admin with "Post messages".`);
            if (chat.type === 'channel' && me.can_post_messages === false) throw new Error(`@${bot.username} is an admin of "${chat.title}" but can't post. Turn on "Post messages" for it.`);
            return `Connected: @${bot.username} can post to "${chat.title || chat.username}"`;
        }
        case 'facebook': {
            if (!meta) throw new Error('The Facebook Page token is not saved yet');
            const r = await callJson(`${GRAPH}/${st.facebookPageId}?fields=name&access_token=${meta}`);
            return `Connected to the Page "${r.name}"`;
        }
        case 'instagram': {
            if (!meta) throw new Error('The Facebook Page token is not saved yet (Instagram posts through it)');
            if (!st.instagramId) throw new Error('No Instagram account is linked to your Facebook Page. Link it in the Page settings (Linked accounts → Instagram), make sure it is a Professional account, then test again.');
            const r = await callJson(`${GRAPH}/${st.instagramId}?fields=username&access_token=${meta}`);
            return `Connected to @${r.username}`;
        }
        case 'threads': {
            if (!env('THREADS_TOKEN')) throw new Error('The Threads token is not saved yet');
            const r = await callJson(`https://graph.threads.net/v1.0/${st.threadsUserId}?fields=username&access_token=${env('THREADS_TOKEN')}`);
            return `Connected to @${r.username}`;
        }
        case 'pinterest': {
            const r = await callJson(`https://api.pinterest.com/v5/boards/${st.pinterestBoard}`, { headers: { Authorization: `Bearer ${env('PINTEREST_TOKEN')}` } });
            return `Connected to the board "${r.name}"`;
        }
    }
    throw new Error('This channel has no automatic posting');
}

export async function agencyAction(body) {
    const { json } = ctx;
    switch (body.action) {
        case 'agency': return json(await view());
        case 'agency-settings':
            await mutate(doc => { doc.settings = cleanSettings(doc.settings, body.settings); });
            return json(await view());
        case 'agency-run-now': {
            const r = await runDaily(body.count);
            return json({ ...(await view()), made: r.drafts.length, errors: r.errors });
        }
        case 'agency-guide-now':
            await runGuide();
            return json(await view());
        case 'agency-report-now':
            await runReport();
            return json(await view());
        case 'agency-draft': {
            // save edits, approve, skip or reschedule one draft
            const out = await mutate(doc => {
                const d = doc.drafts.find(x => x.id === body.id);
                if (!d) return null;
                if (body.posts && typeof body.posts === 'object') {
                    for (const [c, langs] of Object.entries(body.posts)) {
                        if (!d.posts[c]) continue;
                        for (const l of ['he', 'en']) if (typeof langs?.[l] === 'string') d.posts[c][l] = langs[l].slice(0, 3000);
                    }
                }
                if (body.slot && Number.isFinite(Date.parse(body.slot))) d.slot = new Date(body.slot).toISOString();
                if (['waiting', 'approved', 'skipped'].includes(body.status) && d.status !== 'posted' && d.status !== 'publishing') d.status = body.status;
                if (body.manual && CHANNELS[body.manual]) d.results[body.manual] = { ok: true, manual: true, at: new Date().toISOString() };
                return d;
            });
            if (!out) return json({ error: 'This draft is no longer there' }, 404);
            return json({ draft: out });
        }
        case 'agency-publish-now': {
            const d = await publishDraft(body.id);
            if (!d) return json({ error: 'This draft is being published already, or is gone' }, 409);
            return json({ draft: d, view: await view() });
        }
        case 'agency-guide': {
            const g = await mutate(doc => {
                const x = doc.guides.find(y => y.id === body.id);
                if (!x) return null;
                if (['waiting', 'approved', 'skipped'].includes(body.status)) x.status = body.status;
                for (const f of ['title', 'titleHe', 'description', 'descriptionHe', 'intro', 'introHe', 'outro', 'outroHe']) {
                    if (typeof body[f] === 'string') x[f] = body[f].slice(0, 2000);
                }
                return x;
            });
            if (!g) return json({ error: 'This guide is no longer there' }, 404);
            return json({ guide: g });
        }
        case 'agency-test':
            return json({ message: await testChannel(body.channel) });
    }
    return null;
}

// Approved guides, for scripts/build-pages.mjs
export async function approvedGuides() {
    return (await loadAgency()).guides.filter(g => g.status === 'approved');
}
