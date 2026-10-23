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
import { randomUUID, createHash } from 'node:crypto';
import { writeFileSync, rmSync } from 'node:fs';
import { tools as reelTools, motionClip, render as renderReel } from './reel.mjs';

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
    tiktok: { name: 'TikTok', auto: true, tag: 'tt', max: 1500, link: false, style: 'TikTok photo post caption: a short hook line, 2-3 short lines on what the product does and the price, "link in bio" (never a URL), then 4-6 hashtags. Upbeat and casual' },
    fbgroups: { name: 'Facebook groups', auto: false, tag: 'fbg', max: 900, style: 'Post for an Israeli AliExpress deals group on Facebook, written as a member sharing a find: personal and down to earth, 3-5 short lines, the price, one line that the price may change on AliExpress, a short question that invites comments, a line saying it is an affiliate link, no hashtags' },
    whatsapp: { name: 'WhatsApp', auto: false, tag: 'wa', max: 600, style: 'WhatsApp group message: like a friend sharing a find, 3-4 short lines, a couple of emoji, no hashtags' },
    linkedin: { name: 'LinkedIn', auto: false, tag: 'li', max: 1100, style: 'LinkedIn post: practical angle (work from home, productivity, a smart buy), 3-5 lines, 2-3 hashtags, no silly tone' },
    reddit: { name: 'Reddit', auto: false, tag: 'rd', max: 1100, style: 'Reddit post: honest and low-key, no hype and no emoji; a title on the first line, then 2-3 plain sentences, and say openly that the link is an affiliate link' },
};
const TAGS = new Set(Object.values(CHANNELS).map(c => c.tag));

// Telegram invite links, one per place people join from. Partners are added in the admin.
const INVITE_SOURCES = { site: 'Website', fbgroups: 'Facebook groups', whatsapp: 'WhatsApp' };
export const PUBLIC_CHANNEL = 'https://t.me/alidealer';

const DEFAULTS = {
    paused: false,
    autopilot: false,
    perDay: 3,
    slots: ['09:00', '13:00', '19:00'],
    publishLang: 'he',              // he | en | both — language posted to the automatic channels
    channels: Object.keys(CHANNELS), // channels the copywriter writes for
    guides: true,
    telegramChat: '', facebookPageId: '', instagramId: '', threadsUserId: '', pinterestBoard: '',
    tiktokUser: '', tiktokPrivacy: 'PUBLIC_TO_EVERYONE', tiktokComments: true,
    influencer: true, influencerName: 'Noa', influencerNameHe: 'נועה', // AI influencer: one deal a day with her photo
    reels: true, // ...and that post goes out as a short video (reel) where the channel takes one
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
        invites: {}, joins: {}, leaves: {}, members: {}, tgOffset: 0,
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
        tiktok: !!(env('TIKTOK_CLIENT_KEY') && st.tiktokUser),
    };
}

// Fill in the account ids the tokens can tell us, so the user only has to save the tokens.
// A Page token's /me is the Page itself; the Page knows its linked Instagram account.
async function autoIds(st) {
    const found = {};
    const meta = env('META_PAGE_TOKEN');
    if (meta) {
        // a replaced token may belong to another Page, so its ids are looked up again
        const tokenId = createHash('sha256').update(meta).digest('hex').slice(0, 12);
        const fresh = st.metaTokenId !== tokenId;
        if (fresh || !/^\d+$/.test(st.facebookPageId || '')) {
            // only a Page has a category; a personal (user) token's /me is the person
            const page = await callJson(`${GRAPH}/me?fields=id,category&access_token=${meta}`).catch(() => ({}));
            if (page.id && page.category) Object.assign(found, { facebookPageId: page.id, metaTokenId: tokenId, ...(fresh && { instagramId: '' }) });
        }
        const pageId = found.facebookPageId || st.facebookPageId;
        if (!(found.instagramId ?? st.instagramId) && /^\d+$/.test(pageId || '')) {
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

// ---------- TikTok (Content Posting API, photo posts) ----------
// The owner connects the account once in admin (Login Kit). The login lasts a day and
// is renewed with the refresh token, which lasts a year. Tokens live in their own file,
// never in the view sent to the browser.

const TT = 'https://open.tiktokapis.com/v2';
const TT_AUTH_KEY = 'data/tiktok-auth.json';
export const TT_REDIRECT = 'https://alidealer.com/admin';
// photos must come from a URL prefix verified in the TikTok developer portal
const TT_MEDIA = 'media/tiktok/';
const TT_MEDIA_URL = 'https://alidealer.com/media/tiktok/';

async function ttCall(path, { token, body, formBody } = {}) {
    const res = await fetch(`${TT}${path}`, {
        method: 'POST',
        headers: formBody ? { 'Content-Type': 'application/x-www-form-urlencoded' } : { 'Content-Type': 'application/json; charset=UTF-8', Authorization: `Bearer ${token}` },
        body: formBody ? new URLSearchParams(formBody) : JSON.stringify(body || {}),
        signal: AbortSignal.timeout(30000),
    });
    const data = await res.json().catch(() => ({}));
    // the token endpoint answers with error/error_description, the others with error.code
    const code = typeof data.error === 'string' ? data.error : data.error?.code;
    if (!res.ok || (code && code !== 'ok')) {
        throw Object.assign(new Error(data.error_description || data.error?.message || code || `HTTP ${res.status}`), { code });
    }
    return data;
}

const ttSave = (auth) => s3.send(new PutObjectCommand({ Bucket: process.env.STORAGE_BUCKET, Key: TT_AUTH_KEY, Body: JSON.stringify(auth), ContentType: 'application/json' }));

function ttStore(t) {
    return {
        access_token: t.access_token, refresh_token: t.refresh_token, open_id: t.open_id,
        expires_at: Date.now() + (t.expires_in || 86400) * 1000,
        refresh_expires_at: Date.now() + (t.refresh_expires_in || 31536000) * 1000,
    };
}

async function ttToken() {
    const auth = await getJson(TT_AUTH_KEY, null);
    if (!auth?.refresh_token) throw new Error('TikTok is not connected. Press "Connect TikTok" in the Agency tab.');
    if (auth.expires_at > Date.now() + 10 * 60000) return auth.access_token;
    if (auth.refresh_expires_at < Date.now()) throw new Error('The TikTok login expired. Press "Connect TikTok" again.');
    const t = await ttCall('/oauth/token/', { formBody: { client_key: env('TIKTOK_CLIENT_KEY'), client_secret: env('TIKTOK_CLIENT_SECRET'), grant_type: 'refresh_token', refresh_token: auth.refresh_token } });
    await ttSave(ttStore(t));
    return t.access_token;
}

// up to 4 product photos, copied to our verified media path as jpg
async function ttPhotos(d) {
    const p = (await ctx.loadProducts()).find(x => x.id === d.productId);
    const extra = p?.itemId ? await ctx.productImages(p.itemId).catch(() => []) : [];
    const urls = [...new Set([d.image, ...extra].filter(Boolean).map(plainImage))].slice(0, 4);
    const out = [];
    for (const [i, u] of urls.entries()) {
        try {
            const res = await fetch(u, { signal: AbortSignal.timeout(20000) });
            const type = res.headers.get('content-type') || '';
            if (!res.ok || !/jpe?g|webp/.test(type)) continue;
            const ext = type.includes('webp') ? 'webp' : 'jpg';
            const name = `${d.id}-${i}.${ext}`;
            await s3.send(new PutObjectCommand({ Bucket: process.env.STORAGE_BUCKET, Key: TT_MEDIA + name, Body: Buffer.from(await res.arrayBuffer()), ContentType: type }));
            out.push(TT_MEDIA_URL + name);
        } catch (e) { console.error('[tiktok photo]', e.message); }
    }
    if (!out.length) throw new Error('No product photo could be prepared for TikTok');
    return out;
}

// ---------- AI influencer ----------
// Once a day one deal is posted with a photo of the influencer (an AI character) holding it,
// with posts in her voice. Her look comes from one reference portrait in storage.

const INF_PORTRAIT = 'data/influencer/portrait.jpg';
const INF_MEDIA = 'media/influencer/';
const INF_MEDIA_URL = 'https://alidealer.com/media/influencer/';
const INF_CHANNELS = ['telegram', 'facebook', 'instagram', 'threads', 'tiktok', 'pinterest'];
const infDisclosure = (st) => ({
    he: `🤖 ${st.influencerNameHe} היא דמות AI של Alidealer`,
    en: `🤖 ${st.influencerName} is Alidealer's AI character`,
});

async function s3Bytes(Key) {
    const r = await s3.send(new GetObjectCommand({ Bucket: process.env.STORAGE_BUCKET, Key }));
    return Buffer.from(await r.Body.transformToByteArray());
}

// TikTok takes only jpg/webp photos
async function toJpeg(buf, mime) {
    if (/jpe?g/.test(mime)) return buf;
    const [{ PNG }, jpeg] = await Promise.all([import('pngjs'), import('jpeg-js')]);
    const png = PNG.sync.read(buf);
    return jpeg.default.encode({ data: png.data, width: png.width, height: png.height }, 88).data;
}

async function infImage(scene, productPhoto, productMime) {
    const portrait = await s3Bytes(INF_PORTRAIT);
    const prompt = `Same young woman as the FIRST reference photo: exactly the same face, wavy dark-brown shoulder-length hair, same age and look. Her clothes may change to suit the scene.
She poses naturally with the product from the SECOND reference photo, showing it to the camera (holding it, or standing next to it if it is large). The product must look exactly like in the second photo: same shape, colours and details.
Scene: ${scene}
Photorealistic lifestyle photo, like a real Instagram influencer's post shot on a good phone: natural light, real skin, friendly smile, vertical 4:5 frame, the product clearly visible.
No text, no captions, no logos, no brand names, no watermarks.`;
    const res = await fetch('https://proxy.openkbs.com/v1/google/models/gemini-3-pro-image:generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENKBS_API_KEY}` },
        body: JSON.stringify({
            contents: [{ role: 'user', parts: [
                { text: prompt },
                { inlineData: { mimeType: 'image/jpeg', data: portrait.toString('base64') } },
                { inlineData: { mimeType: productMime, data: productPhoto.toString('base64') } },
            ] }],
            generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '4:5' } },
        }),
        signal: AbortSignal.timeout(150000),
    });
    const data = await res.json().catch(() => ({}));
    const img = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData;
    if (!img) throw new Error(`no image came back (${res.status} ${JSON.stringify(data.error || data.candidates?.[0]?.finishReason || data.promptFeedback || '').slice(0, 200)})`);
    return toJpeg(Buffer.from(img.data, 'base64'), img.mimeType || '');
}

// Posts in her voice for the automatic channels, plus a scene for the photo
async function infWriter(st, d, channels) {
    const specs = channels.map(c => `- "${c}": ${CHANNELS[c].style}. Max ${CHANNELS[c].max - 80} characters.`).join('\n');
    return ctx.gemini(ctx.writeModel, `You write social posts for ${st.influencerName} (Hebrew: ${st.influencerNameHe}), the AI influencer of www.Alidealer.com, a site of hand-picked AliExpress deals. She is a warm, upbeat Israeli woman in her mid-20s who loves smart finds. Posts are in her first-person voice, sharing a deal she picked for her followers.

Product (English name): ${d.title}
Product (Hebrew name): ${d.titleHe || d.title}
Category: ${d.category}
${d.price ? `Price when we picked it: ${d.price}` : 'Price: not given'}
${d.angle ? `Angle: ${d.angle}` : ''}

Channels and their style:
${specs}

Rules:
${FACT_RULES.replace('we bought, tried or used the product; we found and picked it', `${st.influencerName} bought, tried, owns or used the product; she found and picked it`)}
- Hebrew: she is a woman, so first-person verbs and adjectives are feminine (מצאתי, בחרתי, אני ממליצה). English: first person.
- Each channel must read differently.

Also write "scene": one English sentence describing a fitting, everyday setting for a photo of her with this product (place, light, season-appropriate), with no text or brands in it.

Return JSON {"scene": "...", "he": {${channels.map(c => `"${c}": "..."`).join(', ')}}, "en": {same keys}} using \\n for line breaks.`,
    { generationConfig: { maxOutputTokens: 16000, responseMimeType: 'application/json', temperature: 1, thinkingConfig: { thinkingLevel: 'low' } } }, 90000);
}

// Turns one draft into an influencer post: her photo becomes the post photo, posts in her voice
async function makeInfluencer(id) {
    const doc = await loadAgency();
    const st = doc.settings;
    const d = doc.drafts.find(x => x.id === id);
    if (!d?.productId) throw new Error('Only deal posts can get an influencer photo');
    if (d.status === 'posted' || d.status === 'publishing') throw new Error('This post is out already');
    const productUrl = plainImage(d.productImage || d.image);
    const pr = await fetch(productUrl, { signal: AbortSignal.timeout(20000) });
    if (!pr.ok) throw new Error(`the product photo didn't load (${pr.status})`);
    const productMime = (pr.headers.get('content-type') || 'image/jpeg').split(';')[0];
    const productPhoto = Buffer.from(await pr.arrayBuffer());

    const channels = INF_CHANNELS.filter(c => d.posts[c]);
    const out = await infWriter(st, d, channels).catch(e => { console.error('[influencer writer]', e.message); return {}; });
    const jpg = await infImage(String(out.scene || `a cozy, sunny Israeli apartment`).slice(0, 300), productPhoto, productMime);
    const name = `${d.id}-${Date.now().toString(36)}.jpg`;
    await s3.send(new PutObjectCommand({ Bucket: process.env.STORAGE_BUCKET, Key: INF_MEDIA + name, Body: jpg, ContentType: 'image/jpeg' }));

    const tag = infDisclosure(st);
    return mutate(fresh => {
        const x = fresh.drafts.find(y => y.id === id);
        if (!x || x.status === 'posted' || x.status === 'publishing') return null;
        x.productImage ||= x.image;
        x.image = INF_MEDIA_URL + name;
        x.influencer = { name: st.influencerName, at: new Date().toISOString() };
        if (st.reels) x.reel = { status: 'pending' }; // a new photo means a new reel
        else delete x.reel;
        for (const c of channels) for (const l of ['he', 'en']) {
            const text = out[l]?.[c] && clip(out[l][c], CHANNELS[c].max - tag[l].length - 2);
            if (text && x.posts[c]?.[l] !== undefined) x.posts[c][l] = `${text}\n\n${tag[l]}`;
        }
        logLine(fresh, `${st.influencerName} photo made for "${x.title}"`);
        return x;
    });
}

// Daily: the first deal post still ahead today (at least 40 min away) gets the influencer
async function influencerDaily() {
    const doc = await loadAgency();
    const today = ilDate(Date.now());
    if (!doc.settings.influencer || doc.lastInfluencer === today) return '';
    const d = doc.drafts
        .filter(x => x.productId && !x.influencer && ['waiting', 'approved'].includes(x.status) && ilDate(Date.parse(x.slot)) === today && Date.parse(x.slot) > Date.now() + 40 * 60000)
        .sort((a, b) => Date.parse(a.slot) - Date.parse(b.slot))[0];
    if (!d) return '';
    await mutate(f => { f.lastInfluencer = today; }); // one try a day, so a failing model never burns credits every hour
    await makeInfluencer(d.id); // its reel is started by the hourly run right after this
    return d.title;
}

// ---------- Noa reels ----------
// The influencer post also goes out as a 7.5-second vertical video on the channels that take
// one: her photo brought to life by a free image-to-video AI, with the product name, price,
// the site and music on it (see reel.mjs). Making it takes 2-4 minutes, so it runs in its own
// call of this function, started right after the photo. If the video can't be made or posted,
// the photo post goes out as before.

const REEL_CHANNELS = ['telegram', 'facebook', 'instagram', 'threads', 'tiktok'];
// TikTok only pulls media from its verified path, so every channel uses the copy there
const reelName = (id, lang) => `reel-${id}-${lang}.mp4`;
const REEL_TEXT = {
    en: (st) => ({ tagline: 'New deals every day', disclosure: `${st.influencerName} is an AI character` }),
    he: (st) => ({ tagline: 'דילים חדשים כל יום', disclosure: `${st.influencerNameHe} היא דמות AI` }),
};
const REEL_STYLE = 'Photorealistic live-action social media footage, natural realistic human motion, the same woman, consistent face, the product keeps its exact shape and size. Steady camera with a slight push in. No text.';

// a short on-screen product name per language, and how she moves in the clip
async function reelWriter(d) {
    return ctx.gemini(ctx.writeModel, `A 5-second vertical video is made from a photo of a young woman showing this product to the camera.
Product (English): ${d.title}
Product (Hebrew): ${d.titleHe || d.title}

Return JSON {"motion": "...", "en": "...", "he": "..."}:
- motion: one English sentence describing simple, natural movement for her in those 5 seconds, using the product as it is in the photo (e.g. she smiles, brings it a little closer to the camera, turns it to show it, nods). No new objects, nobody else, she never covers her face.
- en: the product's name for an on-screen caption, 2-4 words, no brand codes or model numbers.
- he: the same in natural Hebrew, 2-4 words.`,
    { generationConfig: { maxOutputTokens: 2000, responseMimeType: 'application/json', temperature: 0.7, thinkingConfig: { thinkingLevel: 'low' } } }, 40000);
}

async function makeReel(id) {
    const d = await mutate(doc => {
        const x = doc.drafts.find(y => y.id === id);
        if (!x?.reel || x.status === 'publishing') return null;
        const r = x.reel;
        if (r.status === 'making' && Date.parse(r.at) > Date.now() - 8 * 60000) return null; // another call is on it
        if (!['pending', 'making'].includes(r.status)) return null;
        if ((r.tries || 0) >= 2) { x.reel = { ...r, status: 'failed' }; return null; }
        x.reel = { ...r, status: 'making', at: new Date().toISOString(), tries: (r.tries || 0) + 1 };
        return { ...x, settings: doc.settings };
    });
    if (!d) return null;
    const st = d.settings;
    const langs = st.publishLang === 'both' ? ['he', 'en'] : [st.publishLang];
    try {
        const photoKey = d.image.startsWith(INF_MEDIA_URL) ? INF_MEDIA + d.image.slice(INF_MEDIA_URL.length) : null;
        if (!photoKey) throw new Error('the post has no influencer photo');
        const [ff, photo, words] = await Promise.all([reelTools(), s3Bytes(photoKey),
            reelWriter(d).catch(e => { console.error('[reel writer]', e.message); return {}; })]);
        const dir = process.env.REEL_DIR || '/tmp/reel';
        const photoFile = `${dir}/${id}.jpg`;
        writeFileSync(photoFile, photo);
        let clipFile = null, note = '';
        try {
            const motion = String(words.motion || 'She smiles warmly at the camera and brings the product a little closer to show it, then gives a small friendly nod.').slice(0, 400);
            writeFileSync(`${dir}/${id}-clip.mp4`, await motionClip(photo, `${motion} ${REEL_STYLE}`));
            clipFile = `${dir}/${id}-clip.mp4`;
        } catch (e) {
            // the free video AI is busy, out of quota or gone: the photo moves instead
            note = `no AI motion today (${String(e?.message || e).slice(0, 120)})`;
            console.error('[reel motion]', note);
        }
        const out = {};
        for (const l of langs) {
            const name = clip(String(words[l] || (l === 'he' && d.titleHe) || d.title), 34);
            const mp4 = await renderReel(ff, { clip: clipFile, photo: photoFile, out: `${dir}/${reelName(id, l)}`,
                text: { name, price: d.price || '', ...REEL_TEXT[l](st) } });
            await s3.send(new PutObjectCommand({ Bucket: process.env.STORAGE_BUCKET, Key: TT_MEDIA + reelName(id, l), Body: mp4, ContentType: 'video/mp4', CacheControl: 'public, max-age=86400' }));
            out[l] = `${TT_MEDIA_URL}${reelName(id, l)}?v=${Date.now().toString(36)}`;
        }
        return mutate(doc => {
            const x = doc.drafts.find(y => y.id === id);
            if (!x) return null;
            x.reel = { status: 'ready', motion: !!clipFile, ...out, at: new Date().toISOString(), ...(note && { note }) };
            logLine(doc, `${st.influencerName} reel made for "${x.title}"${clipFile ? '' : ' (photo only, the video AI was not available)'}`);
            return x;
        });
    } catch (e) {
        console.error('[reel]', e);
        await mutate(doc => {
            const x = doc.drafts.find(y => y.id === id);
            if (!x?.reel) return;
            x.reel = { ...x.reel, status: x.reel.tries >= 2 ? 'failed' : 'pending', error: String(e.message).slice(0, 200) };
            logLine(doc, `${st.influencerName} reel failed for "${x.title}": ${String(e.message).slice(0, 150)}`);
        });
        throw e;
    } finally {
        for (const f of [`${id}.jpg`, `${id}-clip.mp4`, ...langs.flatMap(l => [reelName(id, l), `${reelName(id, l)}.ass`])]) rmSync(`${process.env.REEL_DIR || '/tmp/reel'}/${f}`, { force: true });
    }
}

// reels still to make, nearest post first (a waiting reel holds its post back up to an hour)
const reelDue = (doc) => doc.drafts
    .filter(x => ['pending', 'making'].includes(x.reel?.status) && ['waiting', 'approved'].includes(x.status) && Date.parse(x.slot) > Date.now() - 60 * 60000)
    .sort((a, b) => Date.parse(a.slot) - Date.parse(b.slot));

const TT_PRIVACY = { PUBLIC_TO_EVERYONE: 'everyone', MUTUAL_FOLLOW_FRIENDS: 'friends', FOLLOWER_OF_CREATOR: 'followers', SELF_ONLY: 'only you' };

async function ttCreator(token) {
    return (await ttCall('/post/publish/creator_info/query/', { token })).data;
}

// Meta processes an uploaded video before it can be published
async function videoReady(url, field) {
    for (let i = 0; i < 18; i++) {
        await sleep(5000);
        const r = await callJson(url).catch(() => ({}));
        if (r[field] === 'FINISHED') return;
        if (['ERROR', 'EXPIRED'].includes(r[field])) throw new Error(`the video was rejected (${r.error_message || r.status || r[field]})`);
    }
    throw new Error('the video was still processing after 90 seconds');
}

// `video` is the reel's url when the post has one; each channel falls back to the photo
const PUBLISH = {
    async telegram(st, d, text, link, lang, video) {
        const api = `https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}`;
        const caption = `${text}\n\n👉 ${link}`;
        let r;
        if (video) {
            r = await callJson(`${api}/sendVideo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: st.telegramChat, video, caption, supports_streaming: true, width: 720, height: 1280 }) });
            const user = r.result?.chat?.username;
            return { id: String(r.result?.message_id || ''), url: user ? `https://t.me/${user}/${r.result.message_id}` : '', video: true };
        }
        try {
            r = await callJson(`${api}/sendPhoto`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: st.telegramChat, photo: d.image, caption }) });
        } catch (e) {
            if (!/photo|image|file|wrong type/i.test(e.message)) throw e;
            r = await callJson(`${api}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: st.telegramChat, text: caption }) });
        }
        const user = r.result?.chat?.username;
        return { id: String(r.result?.message_id || ''), url: user ? `https://t.me/${user}/${r.result.message_id}` : '' };
    },
    async facebook(st, d, text, link, lang, video) {
        if (video) {
            const v = await callJson(`${GRAPH}/${st.facebookPageId}/videos`, form({ file_url: video, description: `${text}\n\n👉 ${link}`, access_token: env('META_PAGE_TOKEN') }));
            return { id: v.id, url: `https://www.facebook.com/${st.facebookPageId}/videos/${v.id}`, video: true };
        }
        const r = await callJson(`${GRAPH}/${st.facebookPageId}/photos`, form({ url: d.image, message: `${text}\n\n👉 ${link}`, access_token: env('META_PAGE_TOKEN') }));
        return { id: r.post_id || r.id, url: `https://www.facebook.com/${r.post_id || r.id}` };
    },
    async instagram(st, d, text, link, lang, video) {
        const token = env('META_PAGE_TOKEN');
        const box = await callJson(`${GRAPH}/${st.instagramId}/media`, form(video
            ? { media_type: 'REELS', video_url: video, caption: text, share_to_feed: 'true', access_token: token }
            : { image_url: plainImage(d.image), caption: text, access_token: token }));
        if (video) await videoReady(`${GRAPH}/${box.id}?fields=status_code,status&access_token=${token}`, 'status_code');
        let r;
        for (let i = 0; ; i++) { // the photo is fetched in the background; publishing too early fails
            try { r = await callJson(`${GRAPH}/${st.instagramId}/media_publish`, form({ creation_id: box.id, access_token: token })); break; }
            catch (e) { if (i >= 4) throw e; await sleep(4000); }
        }
        const info = await callJson(`${GRAPH}/${r.id}?fields=permalink&access_token=${token}`).catch(() => ({}));
        return { id: r.id, url: info.permalink || '', ...(video && { video: true }) };
    },
    async threads(st, d, text, link, lang, video) {
        const token = env('THREADS_TOKEN');
        const base = `https://graph.threads.net/v1.0/${st.threadsUserId}`;
        const box = await callJson(`${base}/threads`, form(video
            ? { media_type: 'VIDEO', video_url: video, text: `${text}\n\n${link}`, access_token: token }
            : { media_type: 'IMAGE', image_url: plainImage(d.image), text: `${text}\n\n${link}`, access_token: token }));
        if (video) await videoReady(`https://graph.threads.net/v1.0/${box.id}?fields=status,error_message&access_token=${token}`, 'status');
        let r;
        for (let i = 0; ; i++) {
            await sleep(i ? 6000 : 3000);
            try { r = await callJson(`${base}/threads_publish`, form({ creation_id: box.id, access_token: token })); break; }
            catch (e) { if (i >= 4) throw e; }
        }
        const info = await callJson(`https://graph.threads.net/v1.0/${r.id}?fields=permalink&access_token=${token}`).catch(() => ({}));
        return { id: r.id, url: info.permalink || '', ...(video && { video: true }) };
    },
    async tiktok(st, d, text, link, lang, video) {
        const token = await ttToken();
        const creator = await ttCreator(token);
        const photos = video ? null : await ttPhotos(d);
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const post = (privacy) => video ? ttCall('/post/publish/video/init/', {
            token,
            body: {
                post_info: {
                    title: text.slice(0, 2200), // a video's title is its whole caption
                    privacy_level: privacy,
                    disable_comment: !st.tiktokComments,
                    video_cover_timestamp_ms: 2500,
                    brand_content_toggle: false, brand_organic_toggle: true,
                },
                source_info: { source: 'PULL_FROM_URL', video_url: video },
            },
        }) : ttCall('/post/publish/content/init/', {
            token,
            body: {
                media_type: 'PHOTO', post_mode: 'DIRECT_POST',
                post_info: {
                    title: (lines[0] || d.title).slice(0, 90),
                    description: text.slice(0, 4000),
                    privacy_level: privacy,
                    disable_comment: !st.tiktokComments,
                    auto_add_music: true,
                    brand_content_toggle: false, brand_organic_toggle: true, // our own affiliate deals
                },
                source_info: { source: 'PULL_FROM_URL', photo_images: photos, photo_cover_index: 0 },
            },
        });
        const want = creator.privacy_level_options?.includes(st.tiktokPrivacy) ? st.tiktokPrivacy : 'SELF_ONLY';
        let r, privacy = want;
        try { r = await post(want); }
        catch (e) {
            // until TikTok approves (audits) the app, posts can only be private
            if (!/unaudited/i.test(e.code || e.message) || want === 'SELF_ONLY') throw e;
            privacy = 'SELF_ONLY';
            r = await post(privacy);
        }
        return { id: r.data.publish_id, url: creator.creator_username ? `https://www.tiktok.com/@${creator.creator_username}` : '', ...(privacy === 'SELF_ONLY' && { note: 'private (only you can see it)' }), ...(video && { video: true }) };
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
    const jobs = [];
    for (const c of Object.keys(PUBLISH)) {
        if (!conn[c] || !d.posts[c] || !st.channels.includes(c)) continue;
        // TikTok gets one slideshow per deal (two near-identical ones look like spam), and guides have no product photos
        if (c === 'tiktok' && !d.productId) continue;
        for (const l of (c === 'tiktok' && langs.length > 1 ? ['he'] : langs)) {
            const key = langs.length > 1 ? `${c}-${l}` : c;
            // a post made under the other language setting counts too, so changing it never reposts
            if (results[key]?.ok || results[c]?.ok || results[`${c}-${l}`]?.ok || !d.posts[c][l]) continue;
            const video = d.reel?.status === 'ready' && REEL_CHANNELS.includes(c) ? d.reel[l] || '' : '';
            // channels post side by side: a video can take a minute to be processed
            jobs.push((async () => {
                // guide posts carry their own page links instead of a deal
                const post = (v) => PUBLISH[c](st, d, d.posts[c][l], d.links?.[l] || linkFor(d.productId, l, c), l, v);
                try {
                    let r;
                    try { r = await post(video); }
                    catch (e) {
                        if (!video) throw e;
                        console.error(`[publish ${key} video]`, e.message);
                        r = { ...await post(''), note: `photo, the video failed: ${e.message.slice(0, 150)}` };
                    }
                    results[key] = { ok: true, ...r, at: new Date().toISOString() };
                } catch (e) {
                    console.error(`[publish ${key}]`, e.code, e.message);
                    results[key] = { ok: false, error: `${e.code && !e.message.includes(e.code) ? `${e.code}: ` : ''}${e.message}`.slice(0, 300), at: new Date().toISOString() };
                }
            })());
        }
    }
    await Promise.all(jobs);
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
        && (d.status === 'approved' || (d.status === 'waiting' && doc.settings.autopilot && !d.hold)) // hold = only after the owner's OK
        && !reelDue(doc).includes(d)); // its reel is still being made
    let n = 0;
    for (const d of due) {
        if (Date.now() > deadline - (d.reel?.status === 'ready' ? 60000 : 0)) break; // videos take longer to post
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

// ---------- Telegram followers ----------

const tgApi = () => `https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}`;
const tgReady = (st) => !!(env('TELEGRAM_BOT_TOKEN') && st.telegramChat);
const sourceSlug = (name) => String(name).toLowerCase().replace(/[^a-z0-9א-ת]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'partner';

// Telegram's own link name is how a join is matched back to its source
async function createInvite(st, key, name) {
    const r = await callJson(`${tgApi()}/createChatInviteLink`, form({ chat_id: st.telegramChat, name: `src:${key}`.slice(0, 32) }));
    return { name, link: r.result.invite_link, createdAt: new Date().toISOString() };
}

async function ensureInvites() {
    const doc = await loadAgency();
    if (!tgReady(doc.settings)) return 0;
    const made = {};
    for (const [key, name] of Object.entries(INVITE_SOURCES)) {
        if (!doc.invites[key]) made[key] = await createInvite(doc.settings, key, name);
    }
    if (Object.keys(made).length) await mutate(d => { for (const [k, v] of Object.entries(made)) d.invites[k] ??= v; });
    return Object.keys(made).length;
}

// Who joined or left since the last check. Telegram keeps these updates for 24 hours,
// so the hourly run never misses any. Joins without one of our links count as "direct".
async function pollJoins() {
    const doc = await loadAgency();
    if (!tgReady(doc.settings)) return 0;
    const chat = (await callJson(`${tgApi()}/getChat?chat_id=${encodeURIComponent(doc.settings.telegramChat)}`)).result;
    const res = await callJson(`${tgApi()}/getUpdates?offset=${(doc.tgOffset || 0) + 1}&timeout=0&allowed_updates=${encodeURIComponent('["chat_member"]')}`);
    const today = ilDate(Date.now());
    const count = await callJson(`${tgApi()}/getChatMemberCount?chat_id=${chat.id}`).then(r => r.result).catch(() => null);
    const IN = ['member', 'administrator', 'creator', 'restricted'];
    let n = 0;
    await mutate(d => {
        for (const u of res.result) {
            if (u.update_id <= (d.tgOffset || 0)) continue; // counted by a run that overlapped this one
            d.tgOffset = u.update_id;
            const m = u.chat_member;
            if (!m || m.chat.id !== chat.id || m.new_chat_member.user.is_bot) continue;
            const was = IN.includes(m.old_chat_member.status), is = IN.includes(m.new_chat_member.status);
            const day = ilDate(m.date * 1000);
            if (!was && is) {
                const name = m.invite_link?.name || '';
                const key = name.startsWith('src:') && d.invites[name.slice(4)] ? name.slice(4)
                    : Object.keys(d.invites).find(k => d.invites[k].link === m.invite_link?.invite_link) || 'direct';
                d.joins[key] ??= {};
                d.joins[key][day] = (d.joins[key][day] || 0) + 1;
                n++;
            } else if (was && !is) {
                d.leaves[day] = (d.leaves[day] || 0) + 1;
            }
        }
        if (count !== null) d.members[today] = count;
        // keep about a year of daily numbers
        const cut = ilDate(Date.now() - 400 * 86400000);
        for (const days of [d.leaves, d.members, ...Object.values(d.joins)]) for (const k of Object.keys(days)) if (k < cut) delete days[k];
    });
    return n;
}

const sumDays = (days = {}, n) => {
    const cut = n ? ilDate(Date.now() - (n - 1) * 86400000) : '';
    return Object.entries(days).reduce((s, [k, v]) => s + (k >= cut ? v : 0), 0);
};

function followersView(doc) {
    const keys = [...Object.keys(doc.invites), 'direct'];
    const latest = Object.keys(doc.members).sort().pop();
    return {
        members: latest ? doc.members[latest] : null,
        since: Object.values(doc.invites).map(i => i.createdAt).sort()[0] || null,
        sources: keys.map(k => ({
            key: k,
            name: k === 'direct' ? 'Other (the public @ link, search, forwards)' : doc.invites[k].name,
            link: k === 'direct' ? PUBLIC_CHANNEL : doc.invites[k].link,
            partner: !!doc.invites[k]?.partner, revoked: !!doc.invites[k]?.revoked,
            week: sumDays(doc.joins[k], 7), month: sumDays(doc.joins[k], 30), total: sumDays(doc.joins[k]),
        })),
        leaves: { week: sumDays(doc.leaves, 7), month: sumDays(doc.leaves, 30) },
    };
}

// The site's Join buttons go through /api?tg=site, so the link can be swapped without a rebuild
export async function inviteLink(key) {
    try { return (await loadAgency()).invites[key]?.link || PUBLIC_CHANNEL; }
    catch { return PUBLIC_CHANNEL; }
}

// Called every hour by the api function's schedule
export async function agencyHourly(deadline) {
    const doc = await loadAgency();
    const done = [];
    try { await ensureInvites(); done.push(`joins ${await pollJoins()}`); } catch (e) { console.error('[agency followers]', e.message); }
    if (doc.settings.paused) return [...done, 'paused'];
    // a newly saved token may still need its Page / Instagram / Threads ids
    await autoIds(doc.settings).catch(e => console.error('[agency ids]', e.message));
    const now = ilParts(Date.now());
    try { done.push(`published ${await publishDue(deadline - 90000)}`); } catch (e) { console.error('[agency publish]', e); }
    // the day's drafts are written early in the morning, Israel time
    if (+now.hour >= 6 && doc.lastDaily !== ilDate(Date.now()) && Date.now() < deadline - 120000) {
        try { const r = await runDaily(); done.push(`drafted ${r.drafts.length}`); } catch (e) { console.error('[agency daily]', e); }
    }
    if (doc.settings.influencer && Date.now() < deadline - 170000) {
        try { const t = await influencerDaily(); if (t) done.push(`influencer: ${t}`); }
        catch (e) { console.error('[agency influencer]', e); await mutate(d => logLine(d, `${d.settings.influencerName} photo failed: ${e.message.slice(0, 150)}`)).catch(() => {}); }
    }
    // a reel that is queued or whose maker stopped half way gets another go
    const reel = reelDue(await loadAgency()).find(x => x.reel.status === 'pending' || Date.parse(x.reel.at) < Date.now() - 8 * 60000);
    if (reel) { await ctx.selfCall({ action: 'agency-reel', id: reel.id }); done.push(`reel started: ${reel.title}`); }
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
    let tgError = '';
    await ensureInvites().then(pollJoins).catch(e => { tgError = e.message; console.error('[followers]', e.message); });
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
        secrets: { telegram: !!env('TELEGRAM_BOT_TOKEN'), meta: !!env('META_PAGE_TOKEN'), threads: !!env('THREADS_TOKEN'), pinterest: !!env('PINTEREST_TOKEN'), tiktok: !!(env('TIKTOK_CLIENT_KEY') && env('TIKTOK_CLIENT_SECRET')) },
        channels: Object.fromEntries(Object.entries(CHANNELS).map(([k, c]) => [k, { name: c.name, auto: c.auto, tag: c.tag, max: c.max, link: c.link !== false }])),
        lastDaily: doc.lastDaily,
        followers: { ...followersView(doc), error: tgError },
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
        metaTokenId: cur.metaTokenId,
        tiktokUser: cur.tiktokUser, // set by connecting the account
        tiktokPrivacy: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'].includes(s.tiktokPrivacy) ? s.tiktokPrivacy : cur.tiktokPrivacy,
        tiktokComments: s.tiktokComments === undefined ? cur.tiktokComments : !!s.tiktokComments,
        influencer: s.influencer === undefined ? cur.influencer : !!s.influencer,
        influencerName: String(s.influencerName ?? '').trim().slice(0, 30) || cur.influencerName,
        influencerNameHe: String(s.influencerNameHe ?? '').trim().slice(0, 30) || cur.influencerNameHe,
        reels: s.reels === undefined ? cur.reels : !!s.reels,
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
            if (me.can_invite_users === false) throw new Error(`@${bot.username} can post to "${chat.title}", but can't make invite links. Turn on "Invite users via link" (Add subscribers) for it.`);
            return `Connected: @${bot.username} can post to "${chat.title || chat.username}"`;
        }
        case 'facebook': {
            if (!meta) throw new Error('The Facebook Page token is not saved yet');
            const me = await callJson(`${GRAPH}/me?fields=id,name,category&access_token=${meta}`).catch(e => {
                if (/category/.test(e.message)) throw new Error('This is a personal (user) token, not a Page token. In the Graph API Explorer run me/accounts and save the access_token next to your Page.');
                throw e;
            });
            if (me.id !== st.facebookPageId) throw new Error(`The token belongs to the Page "${me.name}", but it hasn't been set up yet. Open the Agency tab again and test once more.`);
            return `Connected to the Page "${me.name}"`;
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
        case 'tiktok': {
            const c = await ttCreator(await ttToken());
            return `Connected to @${c.creator_username} (${c.creator_nickname}). It can post as: ${c.privacy_level_options.map(o => TT_PRIVACY[o] || o).join(', ')}. Until TikTok approves your app, posts are private.`;
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
        case 'agency-influencer': {
            // the influencer photo + her posts for one draft, on demand
            const d = await makeInfluencer(body.id);
            if (!d) return json({ error: 'This post went out while the photo was being made' }, 409);
            if (d.reel) await ctx.selfCall({ action: 'agency-reel', id: d.id });
            return json({ draft: d });
        }
        case 'agency-reel': {
            // makes one reel; started by the function itself (see ctx.selfCall), so it gets its own 5 minutes.
            // redo: make it again from scratch (an influencer post only)
            if (body.redo) await mutate(doc => { const x = doc.drafts.find(y => y.id === body.id); if (x?.influencer) x.reel = { status: 'pending' }; });
            const d = await makeReel(body.id);
            return json({ draft: d });
        }
        case 'agency-test':
            return json({ message: await testChannel(body.channel) });
        case 'agency-tiktok-start': {
            // the TikTok login page; it comes back to /admin with ?code=&state=
            if (!env('TIKTOK_CLIENT_KEY') || !env('TIKTOK_CLIENT_SECRET')) return json({ error: 'Save the TikTok client key and secret first' }, 400);
            const state = randomUUID();
            await mutate(d => { d.tiktokState = { value: state, at: Date.now() }; });
            const q = new URLSearchParams({ client_key: env('TIKTOK_CLIENT_KEY'), scope: 'user.info.basic,video.publish', response_type: 'code', redirect_uri: TT_REDIRECT, state });
            return json({ url: `https://www.tiktok.com/v2/auth/authorize/?${q}` });
        }
        case 'agency-tiktok-finish': {
            const doc = await loadAgency();
            if (!doc.tiktokState || doc.tiktokState.value !== body.state || doc.tiktokState.at < Date.now() - 30 * 60000) return json({ error: 'This TikTok login is out of date. Press "Connect TikTok" again.' }, 400);
            const t = await ttCall('/oauth/token/', { formBody: { client_key: env('TIKTOK_CLIENT_KEY'), client_secret: env('TIKTOK_CLIENT_SECRET'), code: String(body.code || ''), grant_type: 'authorization_code', redirect_uri: TT_REDIRECT } });
            if (!String(t.scope || '').includes('video.publish')) return json({ error: 'TikTok didn\'t give permission to post. Connect again and allow posting.' }, 400);
            await ttSave(ttStore(t));
            const c = await ttCreator(t.access_token).catch(() => ({}));
            const name = c.creator_username ? `@${c.creator_username}` : 'your TikTok account';
            await mutate(d => { d.settings.tiktokUser = name; delete d.tiktokState; logLine(d, `TikTok connected: ${name}`); });
            return json(await view());
        }
        case 'agency-tiktok-disconnect': {
            const auth = await getJson(TT_AUTH_KEY, null);
            if (auth?.access_token) await ttCall('/oauth/revoke/', { formBody: { client_key: env('TIKTOK_CLIENT_KEY'), client_secret: env('TIKTOK_CLIENT_SECRET'), token: auth.access_token } }).catch(e => console.error('[tiktok revoke]', e.message));
            await ttSave({});
            await mutate(d => { d.settings.tiktokUser = ''; logLine(d, 'TikTok disconnected'); });
            return json(await view());
        }
        case 'agency-invite-add': {
            // a separate link for a partner channel that gives us a shoutout
            const name = String(body.name || '').trim().slice(0, 60);
            if (!name) return json({ error: 'Write the partner\'s name' }, 400);
            const st = (await loadAgency()).settings;
            if (!tgReady(st)) return json({ error: 'Connect Telegram first' }, 400);
            const base = `p-${sourceSlug(name)}`;
            const cur = (await loadAgency()).invites;
            let key = base;
            for (let i = 2; cur[key]; i++) key = `${base}-${i}`;
            const inv = { ...(await createInvite(st, key, name)), partner: true };
            await mutate(d => { d.invites[key] = inv; logLine(d, `New Telegram link for ${name}`); });
            return json(await view());
        }
        case 'agency-invite-remove': {
            // only partner links can be switched off; their joins stay in the totals
            const doc = await loadAgency();
            const inv = doc.invites[body.key];
            if (!inv?.partner) return json({ error: 'This link can\'t be removed' }, 400);
            await callJson(`${tgApi()}/revokeChatInviteLink`, form({ chat_id: doc.settings.telegramChat, invite_link: inv.link })).catch(e => console.error('[revoke]', e.message));
            await mutate(d => { if (d.invites[body.key]) d.invites[body.key].revoked = new Date().toISOString(); });
            return json(await view());
        }
    }
    return null;
}

// Approved guides, for scripts/build-pages.mjs
export async function approvedGuides() {
    return (await loadAgency()).guides.filter(g => g.status === 'approved');
}
