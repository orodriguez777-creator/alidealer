// Posts one deal per run. The day's 3 deals come from a date-seeded shuffle of the
// whole catalog, so no history is needed and nothing repeats within a day.
const API = 'https://ghzfcfbdwidurfqkjaateras4m0hnndz.lambda-url.eu-central-1.on.aws/';
const ORIGIN = 'https://alidealer.com';
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const LANG = process.env.POST_LANG || 'he';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
if (!TOKEN || !CHAT) throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');

const he = LANG === 'he';
const hour = new Date().getUTCHours();
const slot = process.env.SLOT !== undefined && process.env.SLOT !== ''
    ? Number(process.env.SLOT) % 3
    : hour < 10 ? 0 : hour < 14 ? 1 : 2;

// seeded shuffle: same day -> same order, new day -> new order
function rng(seed) {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    return () => {
        h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
        return ((h ^= h >>> 16) >>> 0) / 4294967296;
    };
}
const today = new Date().toISOString().slice(0, 10);
const plainImage = (u) => String(u || '').replace(/_\.(webp|avif)$/i, '').replace(/\.jpg_\d+x\d+[^/]*$/i, '.jpg');
const priceOf = (raw) => {
    const m = String(raw || '').match(/\d+(?:[.,]\d{1,2})?/);
    if (!m) return '';
    const n = m[0].replace(',', '.');
    return /₪|ILS|NIS/i.test(raw) ? `₪${n}` : `$${n}`;
};

const res = await fetch(API, { method: 'POST', body: JSON.stringify({ action: 'list' }) });
const { products } = await res.json();
const pool = (products || []).filter(p => p.image);
if (!pool.length) throw new Error('No products came back from the API');

const rand = rng(today);
const order = [...pool];
for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
const p = order[slot % order.length];

const title = (he && p.titleHe) || p.title;
const price = priceOf(p.price);
const link = `${ORIGIN}/d/${he ? 'he/' : ''}${p.id}?s=tg`;

const T = {
    he: {
        hooks: ['מצאתי לכם משהו שימושי 👇', 'הדיל של הרגע 🔥', 'שווה להציץ ב-👇', 'עוד מציאה נבחרת ✨', 'בחרתי עבורכם 🛍️'],
        price: (x) => `💰 ${x} (המחיר כפי שהיה כשבחרנו, עשוי להשתנות ב-AliExpress)`,
        cta: '👉 לצפייה ב-AliExpress:',
        ai: '🤖 נועה היא דמות AI של Alidealer · קישור שותפים',
    },
    en: {
        hooks: ['Found something useful 👇', 'Deal of the moment 🔥', 'Worth a look 👇', 'Another hand-picked find ✨', 'Picked for you 🛍️'],
        price: (x) => `💰 ${x} (price when we picked it, may change on AliExpress)`,
        cta: '👉 See it on AliExpress:',
        ai: '🤖 Noa is Alidealer’s AI character · affiliate link',
    },
}[he ? 'he' : 'en'];

// optional: one fresh line from Gemini (free key); any failure falls back to templates
async function freshLine() {
    if (!GEMINI_KEY) return '';
    try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
            body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text:
`You are Noa, a warm upbeat Israeli woman in her mid-20s presenting a deal. Write ONE short sentence (max 120 characters) in ${he ? 'natural everyday Hebrew, feminine first person' : 'casual English'} about this product: "${title}". Use only what the name says. No price, no links, no claims of owning or using it, no hashtags.` }] }],
                generationConfig: { maxOutputTokens: 120, temperature: 1 } }),
            signal: AbortSignal.timeout(20000),
        });
        const d = await r.json();
        return String(d.candidates?.[0]?.content?.parts?.map(x => x.text || '').join('') || '').trim().split('\n')[0].slice(0, 160);
    } catch (e) { console.error('[gemini]', e.message); return ''; }
}

const hook = T.hooks[Math.floor(rand() * T.hooks.length)];
const extra = await freshLine();
const caption = [`${hook}`, `🔥 ${title}`, extra, price && T.price(price), `${T.cta} ${link}`, T.ai].filter(Boolean).join('\n\n').slice(0, 1000);

const tg = async (method, body) => {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) throw new Error(`${method}: ${d.description || r.status}`);
};
try { await tg('sendPhoto', { chat_id: CHAT, photo: plainImage(p.image), caption }); }
catch (e) {
    if (!/photo|image|file|wrong type/i.test(e.message)) throw e;
    await tg('sendMessage', { chat_id: CHAT, text: caption });
}
console.log(`Slot ${slot}: posted "${title}"`);
