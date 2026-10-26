/**
 * Deal bot for other people's Telegram groups and channels. A group admin adds it,
 * and it posts one deal a day there: the newest deal the agency already posted to our
 * own channel, in the group's language, at the hour the admin picked (default 12:00).
 *
 * Opt-in only: if someone who isn't an admin adds it, it says so and leaves. Admins
 * change it with /time, /lang and /stop; a group that removes it is never posted to again.
 *
 * It is its own bot (GROUP_BOT_TOKEN in functions/api/.env), so the channel bot's hourly
 * polling is untouched. Telegram sends its updates to the webhook POST ?gb=hook.
 * State: data/groupbot.json.
 */
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { postedDeals, tagVisits } from './agency.mjs';

const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-central-1' });
const KEY = 'data/groupbot.json';
const TZ = 'Asia/Jerusalem';
const DEFAULT_HOUR = 12;
const REPEAT_DAYS = 30;
const TAG = 'grp'; // visits from these posts are counted under this tag
const ADMIN = ['creator', 'administrator'];

let ctx;
export function initGroupBot(c) { ctx = c; }

const token = () => process.env.GROUP_BOT_TOKEN || '';
const hookSecret = () => createHash('sha256').update(`groupbot:${token()}`).digest('hex').slice(0, 40);
const tokenId = () => createHash('sha256').update(token()).digest('hex').slice(0, 12);

// ---------- storage ----------

async function load() {
    let doc = {};
    try {
        const res = await s3.send(new GetObjectCommand({ Bucket: process.env.STORAGE_BUCKET, Key: KEY }));
        doc = JSON.parse(await res.Body.transformToString());
    } catch (e) { if (e.name !== 'NoSuchKey') throw e; }
    return { bot: null, groups: {}, ...doc };
}

// webhook calls and the hourly run can overlap, so changes go to a fresh copy
async function change(fn) {
    const doc = await load();
    const out = await fn(doc);
    await s3.send(new PutObjectCommand({ Bucket: process.env.STORAGE_BUCKET, Key: KEY, Body: JSON.stringify(doc), ContentType: 'application/json' }));
    return out === undefined ? doc : out;
}

const ilParts = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
}).formatToParts(ms).map(p => [p.type, p.value]));
const ilDay = (ms) => { const p = ilParts(ms); return `${p.year}-${p.month}-${p.day}`; };
const hh = (h) => `${String(h).padStart(2, '0')}:00`;

// ---------- Telegram ----------

async function tg(method, params) {
    const r = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(20000),
    }).then(res => res.json());
    if (!r.ok) {
        const e = new Error(r.description || `${method} failed`);
        e.code = r.error_code;
        e.migrate = r.parameters?.migrate_to_chat_id;
        throw e;
    }
    return r.result;
}

// the bot can't post there any more (removed, banned, no rights, chat deleted)
const gone = (e) => e.code === 403 || /chat not found|not enough rights|have no rights|CHAT_WRITE_FORBIDDEN|need administrator rights/i.test(e.message);

const TEXT = {
    he: {
        welcome: (h) => `שלום! 👋 אני הבוט של Alidealer.\nכל יום ב-${hh(h)} אשלח לכאן דיל אחד נבחר מ-AliExpress, לא יותר.\n\nלמנהלים:\n/time 18 – שינוי שעת הפרסום\n/lang en – English\n/stop – הסרת הבוט\n\nהנה הדיל של היום 👇`,
        settings: (g) => `הבוט של Alidealer שולח לכאן דיל אחד ביום ב-${hh(g.hour)}, בעברית.\n\nלמנהלים:\n/time 18 – שינוי שעת הפרסום (0-23, שעון ישראל)\n/lang en – English\n/stop – הסרת הבוט`,
        time: (h) => `✅ מעכשיו הדיל היומי יגיע ב-${hh(h)}.`,
        badTime: 'כתבו שעה בין 0 ל-23, למשל: /time 18',
        lang: '✅ מעכשיו הדילים יגיעו בעברית.',
        stop: 'הבוט הוסר. תודה! 🙏 אפשר להוסיף אותו שוב בכל זמן.',
        notAdmin: 'רק מנהלי הקבוצה יכולים להוסיף את הבוט של Alidealer. ביי! 👋',
        adminOnly: 'רק מנהלי הקבוצה יכולים לשנות את הבוט.',
        button: '🛒 לצפייה בדיל',
        foot: 'הדיל היומי מ-alidealer.com · קישור שותפים',
        private: (u) => `שלום! 👋 אני שולח דיל אחד ביום מ-AliExpress לקבוצות ולערוצים בטלגרם.\n\nמנהלים קבוצה או ערוץ? הוסיפו אותי בכפתור למטה. אפשר לבחור שעה ושפה, ולהסיר אותי בכל רגע עם /stop.\n\nהדילים נבחרים על ידי alidealer.com. הקישורים הם קישורי שותפים.`,
        addGroup: '➕ הוספה לקבוצה', addChannel: '➕ הוספה לערוץ',
    },
    en: {
        welcome: (h) => `Hi! 👋 I'm the Alidealer bot.\nEvery day at ${hh(h)} (Israel time) I'll post one hand-picked AliExpress deal here, no more.\n\nFor admins:\n/time 18 – change the posting hour\n/lang he – עברית\n/stop – remove the bot\n\nHere's today's deal 👇`,
        settings: (g) => `The Alidealer bot posts one deal a day here at ${hh(g.hour)} (Israel time), in English.\n\nFor admins:\n/time 18 – change the posting hour (0-23)\n/lang he – עברית\n/stop – remove the bot`,
        time: (h) => `✅ The daily deal now comes at ${hh(h)} (Israel time).`,
        badTime: 'Send an hour from 0 to 23, for example: /time 18',
        lang: '✅ Deals will now come in English.',
        stop: 'The bot is removed. Thanks! 🙏 You can add it again any time.',
        notAdmin: 'Only a group admin can add the Alidealer bot. Bye! 👋',
        adminOnly: 'Only the group admins can change the bot.',
        button: '🛒 See the deal',
        foot: 'Daily deal from alidealer.com · affiliate link',
        private: () => `Hi! 👋 I post one AliExpress deal a day to Telegram groups and channels.\n\nRun a group or a channel? Add me with the button below. You can pick the hour and language, and remove me any time with /stop.\n\nDeals are picked by alidealer.com. Links are affiliate links.`,
        addGroup: '➕ Add to a group', addChannel: '➕ Add to a channel',
    },
};
const langOf = (user) => /^(en)/.test(user?.language_code || '') && !/^(he|iw)/.test(user?.language_code || '') ? 'en' : 'he';

// ---------- setup ----------

// Webhook, command menu and profile text; redone whenever the token changes
async function ensureSetup() {
    if (!token()) return null;
    const doc = await load();
    if (doc.bot?.tokenId === tokenId() && doc.bot.hook) return doc.bot;
    const me = await tg('getMe', {});
    await tg('setWebhook', { url: `${ctx.selfUrl}?gb=hook`, secret_token: hookSecret(), allowed_updates: ['message', 'channel_post', 'my_chat_member'] });
    const cmds = (l) => l === 'he'
        ? [{ command: 'time', description: 'שעת הדיל היומי, למשל /time 18' }, { command: 'lang', description: 'שפה: /lang he או /lang en' }, { command: 'stop', description: 'הסרת הבוט' }, { command: 'help', description: 'הגדרות ועזרה' }]
        : [{ command: 'time', description: 'Daily deal hour, e.g. /time 18' }, { command: 'lang', description: 'Language: /lang he or /lang en' }, { command: 'stop', description: 'Remove the bot' }, { command: 'help', description: 'Settings and help' }];
    await tg('setMyCommands', { commands: cmds('en'), scope: { type: 'all_chat_administrators' } });
    await tg('setMyCommands', { commands: cmds('he'), scope: { type: 'all_chat_administrators' }, language_code: 'he' });
    await tg('setMyShortDescription', { short_description: 'One hand-picked AliExpress deal a day for your Telegram group or channel. By alidealer.com' }).catch(() => {});
    await tg('setMyShortDescription', { short_description: 'דיל נבחר אחד ביום מ-AliExpress לקבוצה או לערוץ שלכם בטלגרם. מבית alidealer.com', language_code: 'he' }).catch(() => {});
    await tg('setMyDescription', { description: TEXT.en.private() }).catch(() => {});
    await tg('setMyDescription', { description: TEXT.he.private(), language_code: 'he' }).catch(() => {});
    const bot = { id: me.id, username: me.username, name: me.first_name, tokenId: tokenId(), hook: true };
    await change(d => { d.bot = bot; });
    return bot;
}

// ---------- the daily deal ----------

// The newest deal from our own channel this group hasn't had in 30 days; else any deal from the shop
async function pickDeal(g, deals, products) {
    const since = Date.now() - REPEAT_DAYS * 86400000;
    const had = new Set((g.sent || []).filter(s => Date.parse(s.at) > since).map(s => s.productId));
    const d = deals.find(x => !had.has(x.productId) && x.posts.telegram[g.lang]);
    if (d) return { productId: d.productId, image: d.image, text: d.posts.telegram[g.lang] };
    const list = (await products()).filter(p => p.price && p.image && !had.has(p.id));
    const p = list[Math.floor(Math.random() * list.length)];
    if (!p) return null;
    const title = g.lang === 'he' ? p.titleHe || p.title : p.title;
    return { productId: p.id, image: p.image, text: g.lang === 'he' ? `🔥 ${title}\n💰 ${p.price}` : `🔥 ${title}\n💰 Only ${p.price}` };
}

async function sendDeal(chatId, g, deal) {
    const t = TEXT[g.lang];
    const caption = `${deal.text.slice(0, 900)}\n\n${t.foot}`;
    const reply_markup = { inline_keyboard: [[{ text: t.button, url: `${ctx.shareUrl(deal.productId, g.lang)}?s=${TAG}` }]] };
    try {
        await tg('sendPhoto', { chat_id: chatId, photo: deal.image, caption, reply_markup });
    } catch (e) {
        if (!/photo|image|file|wrong type/i.test(e.message)) throw e;
        await tg('sendMessage', { chat_id: chatId, text: caption, reply_markup });
    }
}

let productCache;
const productsOnce = () => (productCache ||= ctx.loadProducts());

// Called every hour: each active group whose hour has come gets today's deal
export async function groupDaily(deadline) {
    if (!token()) return 'not set up';
    await ensureSetup();
    productCache = null;
    const today = ilDay(Date.now());
    const hour = +ilParts(Date.now()).hour;
    const doc = await load();
    const due = Object.entries(doc.groups).filter(([, g]) => g.active && g.lastDay !== today && hour >= g.hour);
    if (!due.length) return 'sent 0';
    const deals = await postedDeals(3);
    const done = {};
    for (const [id, g] of due) {
        if (Date.now() > deadline) break;
        const deal = await pickDeal(g, deals, productsOnce);
        if (!deal) break;
        try {
            await sendDeal(id, g, deal);
            const members = await tg('getChatMemberCount', { chat_id: id }).catch(() => null);
            done[id] = { sent: deal.productId, members };
        } catch (e) {
            console.error('[groupbot send]', id, e.code, e.message);
            if (e.migrate) done[id] = { migrate: String(e.migrate) };
            else if (gone(e)) done[id] = { gone: e.message.slice(0, 160) };
            else if (e.code === 429) break; // too fast: the rest go next hour
        }
        await new Promise(r => setTimeout(r, 100));
    }
    let sent = 0;
    await change(d => {
        for (const [id, r] of Object.entries(done)) {
            const g = d.groups[id];
            if (!g) continue;
            if (r.migrate) { d.groups[r.migrate] = g; delete d.groups[id]; continue; }
            if (r.gone) { Object.assign(g, { active: false, removedAt: new Date().toISOString(), reason: r.gone }); continue; }
            g.lastDay = today;
            g.count = (g.count || 0) + 1;
            g.sent = [{ productId: r.sent, at: new Date().toISOString() }, ...(g.sent || [])].slice(0, 40);
            if (r.members !== null) g.members = r.members;
            sent++;
        }
    });
    return `sent ${sent}`;
}

// ---------- updates from Telegram ----------

async function isAdmin(chatId, m) {
    // an anonymous admin, or a post by the channel itself
    if (m.sender_chat?.id === chatId || !m.from) return true;
    const r = await tg('getChatMember', { chat_id: chatId, user_id: m.from.id }).catch(() => null);
    return ADMIN.includes(r?.status);
}

const say = (chatId, text, extra = {}) => tg('sendMessage', { chat_id: chatId, text, ...extra }).catch(e => console.error('[groupbot say]', e.message));

async function onAdded(u) {
    const chat = u.chat;
    if (chat.type === 'private') return;
    const lang = langOf(u.from);
    if (!ADMIN.includes((await tg('getChatMember', { chat_id: chat.id, user_id: u.from.id }).catch(() => null))?.status)) {
        if (chat.type !== 'channel') await say(chat.id, TEXT[lang].notAdmin);
        await tg('leaveChat', { chat_id: chat.id }).catch(() => {});
        console.log('[groupbot] left: added by a non-admin', chat.id, chat.title);
        return;
    }
    const id = String(chat.id);
    const g = await change(d => {
        const old = d.groups[id] || {};
        d.groups[id] = {
            hour: DEFAULT_HOUR, lang, sent: [], count: 0, ...old,
            title: chat.title || '', type: chat.type, username: chat.username || '',
            active: true, addedAt: new Date().toISOString(), addedBy: u.from.username || u.from.first_name || '', removedAt: null, reason: null,
        };
        return d.groups[id];
    });
    await say(id, TEXT[g.lang].welcome(g.hour));
    // the first deal right away, so the admin sees what the group will get
    try {
        const deal = await pickDeal(g, await postedDeals(3), productsOnce);
        if (!deal) return;
        await sendDeal(id, g, deal);
        const members = await tg('getChatMemberCount', { chat_id: id }).catch(() => null);
        await change(d => {
            const x = d.groups[id];
            if (!x) return;
            x.lastDay = ilDay(Date.now());
            x.count = (x.count || 0) + 1;
            x.sent = [{ productId: deal.productId, at: new Date().toISOString() }, ...(x.sent || [])].slice(0, 40);
            if (members !== null) x.members = members;
        });
    } catch (e) { console.error('[groupbot first deal]', id, e.message); }
}

async function onRemoved(chat, reason) {
    await change(d => {
        const g = d.groups[String(chat.id)];
        if (g) Object.assign(g, { active: false, removedAt: new Date().toISOString(), reason });
    });
}

async function onCommand(m, bot) {
    const match = /^\/([a-z_]+)(?:@(\w+))?\s*(.*)$/is.exec(m.text || '');
    if (!match || (match[2] && match[2].toLowerCase() !== bot.username.toLowerCase())) return;
    const [, cmd, , arg] = match;
    const chat = m.chat;
    if (chat.type === 'private') {
        const t = TEXT[langOf(m.from)];
        await say(chat.id, t.private(), { reply_markup: { inline_keyboard: [
            [{ text: t.addGroup, url: `https://t.me/${bot.username}?startgroup=deals` }],
            [{ text: t.addChannel, url: `https://t.me/${bot.username}?startchannel=deals&admin=post_messages` }],
        ] } });
        return;
    }
    const id = String(chat.id);
    const g = (await load()).groups[id];
    if (!g?.active || !['time', 'lang', 'stop', 'help', 'start', 'settings'].includes(cmd.toLowerCase())) return;
    if (!await isAdmin(chat.id, m)) { await say(id, TEXT[g.lang].adminOnly); return; }
    // in a channel the command would stay on everyone's screen
    if (chat.type === 'channel') tg('deleteMessage', { chat_id: id, message_id: m.message_id }).catch(() => {});
    switch (cmd.toLowerCase()) {
        case 'time': {
            const h = Number(arg.trim().split(':')[0]);
            if (!/^\d{1,2}(:00)?$/.test(arg.trim()) || h > 23) { await say(id, TEXT[g.lang].badTime); return; }
            // a later hour today still gets today's deal; an earlier one starts tomorrow
            await change(d => { d.groups[id].hour = h; });
            await say(id, TEXT[g.lang].time(h));
            return;
        }
        case 'lang': {
            const lang = /^(he|iw|עברית|heb)/i.test(arg.trim()) ? 'he' : /^(en|english|eng)/i.test(arg.trim()) ? 'en' : g.lang === 'he' ? 'en' : 'he';
            await change(d => { d.groups[id].lang = lang; });
            await say(id, TEXT[lang].lang);
            return;
        }
        case 'stop':
            await say(id, TEXT[g.lang].stop);
            await onRemoved(chat, 'stopped with /stop');
            await tg('leaveChat', { chat_id: id }).catch(() => {});
            return;
        default:
            await say(id, TEXT[g.lang].settings(g));
    }
}

async function onUpdate(u) {
    const bot = await ensureSetup();
    if (u.my_chat_member) {
        const c = u.my_chat_member;
        const IN = ['member', 'administrator', 'restricted'];
        const was = IN.includes(c.old_chat_member.status), is = IN.includes(c.new_chat_member.status);
        if (!was && is) await onAdded(c);
        else if (was && !is) await onRemoved(c.chat, c.new_chat_member.status === 'kicked' ? 'removed by the group' : 'left the group');
        return;
    }
    const m = u.message || u.channel_post;
    if (!m) return;
    // a group that became a supergroup gets a new id
    if (m.migrate_to_chat_id) {
        await change(d => { const g = d.groups[String(m.chat.id)]; if (g) { d.groups[String(m.migrate_to_chat_id)] = g; delete d.groups[String(m.chat.id)]; } });
        return;
    }
    if (m.text?.startsWith('/')) await onCommand(m, bot);
}

export async function groupHook(event) {
    if (!token() || event.headers?.['x-telegram-bot-api-secret-token'] !== hookSecret()) return { statusCode: 401, body: '' };
    try {
        const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body;
        await onUpdate(JSON.parse(raw || '{}'));
    } catch (e) { console.error('[groupbot update]', e); }
    // always OK, or Telegram keeps resending the same update
    return { statusCode: 200, body: 'ok' };
}

// ---------- admin ----------

async function view() {
    if (!token()) return { configured: false };
    let error = '';
    const bot = await ensureSetup().catch(e => { error = e.message; return null; });
    const doc = await load();
    const groups = Object.entries(doc.groups).map(([id, g]) => ({
        id, title: g.title, type: g.type, username: g.username, lang: g.lang, hour: g.hour, active: g.active,
        members: g.members ?? null, count: g.count || 0, addedAt: g.addedAt, removedAt: g.removedAt, reason: g.reason,
    })).sort((a, b) => b.active - a.active || (b.members || 0) - (a.members || 0));
    return {
        configured: true, error,
        bot: bot && { username: bot.username, link: `https://t.me/${bot.username}`, addLink: `https://t.me/${bot.username}?startgroup=deals` },
        groups,
        reach: groups.filter(g => g.active).reduce((n, g) => n + (g.members || 0), 0),
        visits: { week: await tagVisits(TAG, 7), month: await tagVisits(TAG, 30) },
    };
}

export async function groupAction(body) {
    if (body.action === 'groupbot') return view();
    if (body.action === 'groupbot-remove') {
        const id = String(body.id || '');
        const g = (await load()).groups[id];
        if (!g) throw new Error('That group is not in the list');
        if (g.active) {
            await tg('leaveChat', { chat_id: id }).catch(e => console.error('[groupbot leave]', e.message));
            await onRemoved({ id }, 'removed by you in admin');
        }
        return view();
    }
    throw new Error('Unknown action');
}
