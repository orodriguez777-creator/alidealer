// Shared settings for the storefront and admin pages
window.SITE = {
    name: 'www.Alidealer.com',
    url: 'https://alidealer.com',
    tagline: 'Hand-picked AliExpress deals, checked and sorted so you don\'t have to dig.',
    api: 'https://ghzfcfbdwidurfqkjaateras4m0hnndz.lambda-url.eu-central-1.on.aws/',
};

window.api = async function api(action, data = {}, token) {
    const res = await fetch(window.SITE.api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ action, ...data }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { status: res.status });
    return body;
};

// Brand wordmark: "www." and the TLD set small around the name, like a web address
window.brandHtml = (name) => {
    const m = String(name).match(/^(www\.)?(.+?)(\.[a-z]{2,})?$/i);
    return `${m[1] ? `<small>${esc(m[1])}</small>` : ''}${esc(m[2])}${m[3] ? `<small>${esc(m[3])}</small>` : ''}`;
};

window.esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Lucide icon paths
window.ICONS = {
    arrow: '<path d="M7 17 17 7"/><path d="M7 7h10v10"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    sparkles: '<path d="M9.94 14.06 2 22"/><path d="m14 2 1.5 4.5L20 8l-4.5 1.5L14 14l-1.5-4.5L8 8l4.5-1.5Z"/>',
    loader: '<path d="M21 12a9 9 0 1 1-6.22-8.56"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98"/><path d="m15.41 6.51-6.82 3.98"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    send: '<path d="M14.54 21.69a.5.5 0 0 0 .94-.03l6.5-19a.5.5 0 0 0-.64-.63l-19 6.5a.5.5 0 0 0-.02.93l7.93 3.18a2 2 0 0 1 1.11 1.11z"/><path d="m21.85 2.15-10.94 10.94"/>',
    facebook: '<path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>',
    megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
};
// Link that shows the deal's own photo, name and price when posted on WhatsApp, Facebook, Telegram
window.shareLink = (id, lang) => `${window.SITE.url}/d/${lang === 'he' ? 'he/' : ''}${id}`;

window.icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24">${window.ICONS[name]}</svg>`;
