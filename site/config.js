// Shared settings for the storefront and admin pages
window.SITE = {
    name: 'The Haul',
    tagline: 'Hand-picked AliExpress finds, checked and sorted so you don\'t have to dig.',
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
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
};
window.icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24">${window.ICONS[name]}</svg>`;
