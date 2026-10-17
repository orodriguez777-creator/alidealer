// After a deal click (the product opens in a new tab), invite the visitor to the Telegram channel.
// Shown at most once every 3 days, and never again after they press Join.
(() => {
    const CHANNEL = 'https://t.me/alidealer';
    const KEY = 'tgInvite';
    const STRINGS = {
        en: { title: 'Want deals like this every day?', text: 'Join our Telegram channel and get the best AliExpress finds on your phone. It’s free.', join: 'Join on Telegram', close: 'Close' },
        he: { title: 'רוצים דילים כאלה כל יום?', text: 'הצטרפו לערוץ הטלגרם שלנו וקבלו את המציאות הכי טובות מ-AliExpress ישר לטלפון. בחינם.', join: 'הצטרפו בטלגרם', close: 'סגירה' },
    };
    const ICON = '<svg class="icon" viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>';

    const due = () => {
        const v = localStorage.getItem(KEY);
        return v !== 'joined' && !(Date.now() - Number(v || 0) < 3 * 86400000);
    };

    function show() {
        if (!due() || document.querySelector('.tg-invite')) return;
        localStorage.setItem(KEY, String(Date.now()));
        const s = STRINGS[document.documentElement.lang === 'he' ? 'he' : 'en'];
        const box = document.createElement('aside');
        box.className = 'tg-invite';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-label', s.title);
        box.innerHTML = `<button class="tg-invite-x" type="button" aria-label="${s.close}">&times;</button>
            <span class="tg-logo">${ICON}</span>
            <div><strong>${s.title}</strong><p>${s.text}</p>
            <a class="btn tg-btn" href="${CHANNEL}" target="_blank" rel="noopener">${ICON}${s.join}</a></div>`;
        const close = () => { box.classList.remove('in'); setTimeout(() => box.remove(), 250); };
        box.querySelector('.tg-invite-x').addEventListener('click', close);
        box.querySelector('.tg-btn').addEventListener('click', () => { localStorage.setItem(KEY, 'joined'); close(); });
        document.body.append(box);
        requestAnimationFrame(() => box.classList.add('in'));
    }

    document.addEventListener('click', (e) => {
        const a = e.target.closest('a[href*="/api?go="]');
        if (!a || e.target.closest('button')) return;
        setTimeout(show, 800);
    }, true);
    // a Join click anywhere on the page counts too
    document.addEventListener('click', (e) => {
        if (e.target.closest(`a[href^="${CHANNEL}"]`)) localStorage.setItem(KEY, 'joined');
    });
})();
