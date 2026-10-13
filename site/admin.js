(() => {
    const $ = (id) => document.getElementById(id);
    const TOKEN_KEY = 'haul_admin_token';
    let token = localStorage.getItem(TOKEN_KEY);
    let products = [];
    let clicks = {};

    document.title = `Admin — ${SITE.name}`;
    $('brand').innerHTML = brandHtml(SITE.name);

    function show(section) {
        $('login').classList.toggle('hidden', section !== 'login');
        $('app').classList.toggle('hidden', section !== 'app');
        $('actions').classList.toggle('hidden', section !== 'app');
    }

    function note(el, text, kind = 'err') {
        el.className = `note ${kind}`;
        el.textContent = text;
        el.classList.toggle('hidden', !text);
    }

    function busy(btn, on, label) {
        btn.disabled = on;
        if (on) { btn.dataset.label = btn.innerHTML; btn.innerHTML = `${icon('loader', 'spin')} ${label}`; }
        else if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
    }

    async function call(action, data) {
        try {
            return await api(action, data, token);
        } catch (e) {
            if (e.status === 401) signOut();
            throw e;
        }
    }

    function signOut() {
        token = null;
        localStorage.removeItem(TOKEN_KEY);
        show('login');
    }

    // ---------- login ----------

    $('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        busy($('login-btn'), true, 'Signing in');
        try {
            ({ token } = await api('login', { password: $('password').value }));
            localStorage.setItem(TOKEN_KEY, token);
            $('password').value = '';
            note($('login-msg'), '');
            start();
        } catch (err) {
            note($('login-msg'), err.message);
        } finally {
            busy($('login-btn'), false);
        }
    });
    $('logout').addEventListener('click', signOut);

    // ---------- form ----------

    function setPreview(url) {
        $('preview').innerHTML = url
            ? `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer">`
            : icon('image');
    }

    function resetForm() {
        $('form').reset();
        $('id').value = '';
        $('itemId').value = '';
        $('raw').classList.add('hidden');
        $('save').textContent = 'Save find';
        setPreview('');
    }

    async function detect() {
        const url = $('url').value.trim();
        if (!url) return;
        note($('msg'), '');
        busy($('detect'), true, 'Reading');
        try {
            const d = await call('detect', { url });
            $('itemId').value = d.itemId || '';
            if (d.title) $('title').value = d.title;
            if (d.category) $('category').value = d.category;
            if (d.image) { $('image').value = d.image; setPreview(d.image); }
            if (d.price && !$('price').value) $('price').value = d.price;
            if (d.rawTitle && d.rawTitle !== d.title) {
                $('raw').textContent = `Original listing: ${d.rawTitle}`;
                $('raw').classList.remove('hidden');
            }
            if (d.warning) note($('msg'), d.warning, 'warn');
            else $('title').focus();
        } catch (err) {
            note($('msg'), err.message);
        } finally {
            busy($('detect'), false);
        }
    }

    $('detect').addEventListener('click', detect);

    $('classify').addEventListener('click', async () => {
        const raw = $('title').value.trim();
        if (!raw) return $('title').focus();
        busy($('classify'), true, 'Thinking');
        try {
            const d = await call('classify', { title: raw });
            $('title').value = d.title;
            $('category').value = d.category;
            if (d.title !== raw) {
                $('raw').textContent = `Original listing: ${raw}`;
                $('raw').classList.remove('hidden');
            }
            note($('msg'), '');
        } catch (err) {
            note($('msg'), err.message);
        } finally {
            busy($('classify'), false);
        }
    });
    // Detect as soon as a link is pasted
    $('url').addEventListener('paste', () => setTimeout(() => { if (!$('id').value) detect(); }, 0));
    $('image').addEventListener('change', () => setPreview($('image').value.trim()));
    $('reset').addEventListener('click', () => { resetForm(); note($('msg'), ''); });

    $('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        busy($('save'), true, 'Saving');
        try {
            const editing = !!$('id').value;
            await call('save', {
                id: $('id').value || undefined,
                url: $('url').value.trim(),
                title: $('title').value.trim(),
                category: $('category').value.trim(),
                price: $('price').value.trim(),
                image: $('image').value.trim(),
                itemId: $('itemId').value || undefined,
            });
            busy($('save'), false);
            resetForm();
            note($('msg'), editing ? 'Find updated.' : 'Find added — it is live on the site now.', 'ok');
            await loadList();
            $('url').focus();
        } catch (err) {
            note($('msg'), err.message);
        } finally {
            busy($('save'), false);
        }
    });

    // ---------- list ----------

    const clicksOf = (p) => clicks[p.id] || { total: 0, week: 0 };

    function renderList() {
        $('total').textContent = `(${products.length})`;
        const sum = Object.values(clicks).reduce((a, c) => ({ total: a.total + c.total, week: a.week + c.week }), { total: 0, week: 0 });
        $('clicks-sum').textContent = `${sum.total} clicks to AliExpress in total · ${sum.week} in the last 7 days`;
        const sort = $('sort').value;
        const sorted = sort === 'new' ? products : [...products].sort((a, b) => clicksOf(b)[sort === 'week' ? 'week' : 'total'] - clicksOf(a)[sort === 'week' ? 'week' : 'total']);
        $('list').innerHTML = products.length ? sorted.map(p => `
            <li data-id="${esc(p.id)}">
                ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<div class="ph"></div>'}
                <div>
                    <div class="t">${esc(p.title)}</div>
                    <div class="c">${esc(p.category)}${p.price ? ` · ${esc(p.price)}` : ''}</div>
                    <div class="clicks"><b>${clicksOf(p).total}</b> clicks · ${clicksOf(p).week} this week</div>
                </div>
                <div class="actions">
                    <button class="btn ghost small" data-act="post" title="Create post">${icon('megaphone')}</button>
                    <a class="btn ghost small" href="${esc(p.url)}" target="_blank" rel="noopener" title="Open link">${icon('external')}</a>
                    <button class="btn ghost small" data-act="edit" title="Edit">${icon('pencil')}</button>
                    <button class="btn ghost small" data-act="delete" title="Delete">${icon('trash')}</button>
                </div>
            </li>`).join('') : '<li style="display:block;color:var(--ink-soft)">No finds yet. Paste your first link.</li>';
    }

    $('list').addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const p = products.find(x => x.id === btn.closest('li').dataset.id);
        if (btn.dataset.act === 'post') {
            openPost(p);
        } else if (btn.dataset.act === 'edit') {
            $('id').value = p.id;
            $('itemId').value = p.itemId || '';
            $('url').value = p.url;
            $('title').value = p.title;
            $('category').value = p.category;
            $('price').value = p.price || '';
            $('image').value = p.image || '';
            setPreview(p.image);
            $('raw').classList.add('hidden');
            $('save').textContent = 'Update find';
            note($('msg'), '');
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } else if (confirm(`Delete "${p.title}"?`)) {
            btn.disabled = true;
            try {
                await call('delete', { id: p.id });
                await loadList();
            } catch (err) {
                note($('msg'), err.message);
            }
        }
    });

    async function loadList() {
        const [list, stats] = await Promise.all([api('list'), call('stats').catch(() => null)]);
        products = list.products;
        if (stats) clicks = stats.clicks;
        renderList();
    }
    $('sort').addEventListener('change', renderList);

    // ---------- create post ----------

    const postbox = $('postbox');
    let posting = null;
    let postLang = 'he';
    const POST_UI = {
        he: { copy: 'העתקה', copied: 'הועתק!', again: 'כתבו מחדש', wa: 'וואטסאפ', tg: 'טלגרם', writing: 'כותבים…' },
        en: { copy: 'Copy', copied: 'Copied!', again: 'Rewrite', wa: 'WhatsApp', tg: 'Telegram', writing: 'Writing…' },
    };

    function setPostLabels() {
        const ui = POST_UI[postLang];
        $('post-copy').innerHTML = `${icon('copy')} ${ui.copy}`;
        $('post-wa').innerHTML = `${icon('chat')} ${ui.wa}`;
        $('post-again').innerHTML = `${icon('sparkles')} ${ui.again}`;
        $('post-tg').innerHTML = `${icon('send')} ${ui.tg}`;
        postbox.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === postLang)));
        $('post-text').dir = postLang === 'he' ? 'rtl' : 'ltr';
    }

    function syncPostLinks() {
        const text = $('post-text').value;
        $('post-wa').href = `https://wa.me/?text=${encodeURIComponent(text)}`;
        $('post-tg').href = `https://t.me/share/url?url=${encodeURIComponent(shareLink(posting.id, postLang))}&text=${encodeURIComponent(text.replace(/\n*👉\s*\S+\s*$/, ''))}`;
    }

    async function writePost() {
        const ui = POST_UI[postLang];
        note($('post-msg'), '');
        $('post-text').value = ui.writing;
        $('post-text').disabled = true;
        busy($('post-again'), true, ui.writing);
        try {
            const { post } = await call('post', { id: posting.id, lang: postLang });
            $('post-text').value = post;
        } catch (err) {
            $('post-text').value = '';
            note($('post-msg'), err.message);
        } finally {
            $('post-text').disabled = false;
            busy($('post-again'), false);
            setPostLabels();
            syncPostLinks();
        }
    }

    function openPost(p) {
        posting = p;
        $('post-img').innerHTML = p.image ? `<img src="${esc(p.image)}" alt="" referrerpolicy="no-referrer">` : '';
        $('post-name').textContent = p.title;
        setPostLabels();
        postbox.showModal();
        writePost();
    }

    postbox.querySelector('.seg').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-lang]');
        if (!b || b.dataset.lang === postLang) return;
        postLang = b.dataset.lang;
        setPostLabels();
        writePost();
    });
    $('post-again').addEventListener('click', writePost);
    $('post-text').addEventListener('input', syncPostLinks);
    $('post-copy').addEventListener('click', async () => {
        await navigator.clipboard.writeText($('post-text').value);
        $('post-copy').innerHTML = `${icon('copy')} ${POST_UI[postLang].copied}`;
        setTimeout(setPostLabels, 1600);
    });
    $('post-close').addEventListener('click', () => postbox.close());
    postbox.addEventListener('click', (e) => { if (e.target === postbox) postbox.close(); });

    async function start() {
        show('app');
        setPreview('');
        try {
            const { categories } = await call('check');
            $('cats').innerHTML = categories.map(c => `<option value="${esc(c)}">`).join('');
            await loadList();
        } catch { /* 401 already handled */ }
    }

    token ? start() : show('login');
})();
