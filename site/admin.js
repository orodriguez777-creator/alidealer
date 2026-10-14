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
        // the "Clear" button's id="reset" shadows form.reset, so call the real one
        HTMLFormElement.prototype.reset.call($('form'));
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

    // ---------- several links at once ----------

    const ALI_LINK = /^https?:\/\/([a-z0-9-]+\.)*aliexpress\.(com|us|ru)\b/i;
    let bulkItems = [];
    let bulkRunning = false;

    function setMode(mode) {
        $('mode').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
        $('form').classList.toggle('hidden', mode !== 'one');
        $('bulk').classList.toggle('hidden', mode !== 'bulk');
        $('suggest').classList.toggle('hidden', mode !== 'suggest');
        $('agency').classList.toggle('hidden', mode !== 'agency');
        // the agency needs the room: the finds list steps aside
        document.querySelector('.admin-layout').classList.toggle('wide', mode === 'agency');
        $('list-panel').classList.toggle('hidden', mode === 'agency');
        note($('msg'), '');
    }
    $('mode').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-mode]');
        if (b && !bulkRunning) setMode(b.dataset.mode);
    });

    // A price typed on the same line as a link wins over the detected one: the
    // affiliate portal shows promo prices the API doesn't report.
    const NUM = '(\\d{1,5}(?:[.,]\\d{1,2})?)';
    const PRICE_RES = [
        [new RegExp(`(?:US\\s?\\$|\\$|USD)\\s?${NUM}|${NUM}\\s?(?:\\$|USD)`, 'i'), '$'],
        [new RegExp(`(?:₪|ILS|NIS)\\s?${NUM}|${NUM}\\s?(?:₪|ILS|NIS|ש"ח|שח)`, 'i'), '₪'],
    ];
    function linePrice(rest) {
        for (const [re, sym] of PRICE_RES) {
            const m = rest.match(re);
            if (m) return sym + (m[1] || m[2]).replace(',', '.');
        }
        const bare = rest.match(new RegExp(`^${NUM}$`)); // just a number next to the link
        return bare ? '$' + bare[1].replace(',', '.') : '';
    }

    // Pull every AliExpress link out of whatever was pasted (one per line, or mixed with text)
    function bulkLinks() {
        const seen = new Map();
        for (const line of $('bulk-urls').value.split('\n')) {
            const urls = (line.match(/https?:\/\/[^\s<>"']+/g) || []).map(u => u.replace(/[),.;!?]+$/, '')).filter(u => ALI_LINK.test(u));
            const price = urls.length === 1 ? linePrice(line.replace(/https?:\/\/[^\s<>"']+/g, ' ').trim()) : '';
            urls.forEach(url => { if (!seen.has(url) || (price && !seen.get(url))) seen.set(url, price); });
        }
        return [...seen].map(([url, price]) => ({ url, price }));
    }

    function bulkCount() {
        const links = bulkLinks();
        const n = links.length;
        const priced = links.filter(l => l.price).length;
        $('bulk-count').textContent = n
            ? `${n} link${n === 1 ? '' : 's'} found${priced ? `, ${priced === n ? 'all' : priced} with your price` : ''}`
            : 'Paste links copied from AliExpress, a chat or a spreadsheet.';
        $('bulk-add').disabled = !n || bulkRunning;
        $('bulk-add').textContent = n > 1 ? `Add all ${n}` : 'Add';
    }
    $('bulk-urls').addEventListener('input', bulkCount);

    const BULK_ICON = { wait: icon('clock'), busy: icon('loader', 'spin'), ok: icon('check'), dup: icon('check'), fail: icon('alert') };

    function renderBulk() {
        $('bulk-list').innerHTML = bulkItems.map((it, i) => `
            <li class="${it.state === 'busy' ? 'wait' : it.state}">
                <span class="bulk-state">${BULK_ICON[it.state]}</span>
                <div>
                    <div class="t">${esc(it.title || it.url)}</div>
                    <div class="c">${esc(it.status)}</div>
                </div>
                ${it.state === 'fail' && !bulkRunning ? `<button class="btn ghost small" type="button" data-fix="${i}">Fill in by hand</button>` : ''}
            </li>`).join('');
    }

    function bulkSet(it, state, status, title) {
        Object.assign(it, { state, status }, title ? { title } : {});
        renderBulk();
    }

    // Saves go one at a time: each save rewrites the whole product list
    let saveQueue = Promise.resolve();
    const queueSave = (fn) => (saveQueue = saveQueue.then(fn, fn));

    async function bulkOne(it, known) {
        if (known.urls.has(it.url)) return bulkSet(it, 'dup', 'Already on the site, skipped');
        bulkSet(it, 'busy', 'Reading the product…');
        let d;
        try {
            d = await call('detect', { url: it.url });
        } catch (err) {
            return bulkSet(it, 'fail', err.message);
        }
        it.detected = d;
        if (d.itemId && known.items.has(d.itemId)) return bulkSet(it, 'dup', 'Already on the site, skipped', d.title);
        if (d.itemId) known.items.add(d.itemId);
        if (!d.title) return bulkSet(it, 'fail', 'AliExpress didn\'t show the title right now. Fill it in by hand or try again later.');
        bulkSet(it, 'busy', 'Saving…', d.title);
        const price = it.price || d.price || '';
        await queueSave(async () => {
            try {
                await call('save', { url: it.url, title: d.title, category: d.category, price, image: d.image, itemId: d.itemId });
                known.urls.add(it.url);
                bulkSet(it, 'ok', `Added to ${d.category}${price ? ` · ${price}` : ''}${it.price ? ' (your price)' : price ? ' (AliExpress price, check it)' : ''}`);
            } catch (err) {
                bulkSet(it, 'fail', err.message);
            }
        });
    }

    $('bulk').addEventListener('submit', async (e) => {
        e.preventDefault();
        const links = bulkLinks();
        if (!links.length || bulkRunning) return;
        bulkRunning = true;
        $('bulk-urls').disabled = true;
        busy($('bulk-add'), true, 'Adding');
        note($('msg'), '');
        bulkItems = links.map(({ url, price }) => ({ url, price, state: 'wait', status: 'Waiting…' }));
        renderBulk();

        const known = { urls: new Set(products.map(p => p.url)), items: new Set(products.map(p => p.itemId).filter(Boolean)) };
        const queue = [...bulkItems];
        // two at a time: AliExpress allows about one product lookup per second
        await Promise.all(Array.from({ length: Math.min(2, queue.length) }, async () => {
            while (queue.length) await bulkOne(queue.shift(), known);
        }));
        await saveQueue;

        bulkRunning = false;
        busy($('bulk-add'), false);
        $('bulk-urls').disabled = false;
        const failed = bulkItems.filter(it => it.state === 'fail');
        const added = bulkItems.filter(it => it.state === 'ok').length;
        const dups = bulkItems.filter(it => it.state === 'dup').length;
        // leave only the links that still need attention, so "Add" retries just those
        $('bulk-urls').value = failed.map(it => it.price ? `${it.url} ${it.price}` : it.url).join('\n');
        bulkCount();
        renderBulk();
        note($('msg'), [
            added && `${added} find${added === 1 ? '' : 's'} added, live on the site now.`,
            dups && `${dups} already listed.`,
            failed.length && `${failed.length} need${failed.length === 1 ? 's' : ''} attention: press Add to try again, or fill ${failed.length === 1 ? 'it' : 'them'} in by hand.`,
        ].filter(Boolean).join(' '), failed.length ? 'warn' : 'ok');
        if (added) await loadList().catch(() => {});
    });

    $('bulk-list').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-fix]');
        if (!b) return;
        const it = bulkItems[b.dataset.fix];
        const d = it.detected || {};
        setMode('one');
        resetForm();
        $('url').value = it.url;
        $('itemId').value = d.itemId || '';
        if (d.image) { $('image').value = d.image; setPreview(d.image); }
        if (it.price || d.price) $('price').value = it.price || d.price;
        note($('msg'), 'Type or paste the product title, then press Auto-categorize and Save.', 'warn');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        $('title').focus();
    });

    // ---------- suggestions (found on AliExpress every morning) ----------

    let sg = { items: [], settings: {}, categories: [] };
    const SG_NUMS = ['minOrders', 'minRating', 'minDiscount', 'maxPrice', 'perCategory'];

    function sgStatus() {
        const n = sg.items.length;
        $('sg-badge').textContent = n || '';
        const run = sg.lastRun;
        const when = run ? new Date(run.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
        $('sg-status').textContent = [
            n ? `${n} suggestion${n === 1 ? '' : 's'} waiting` : 'No suggestions waiting',
            run && `last search ${when}, ${run.found} new`,
        ].filter(Boolean).join(' · ');
        if (run?.errors?.length) note($('msg'), `Last search had problems: ${run.errors.join('; ')}`, 'warn');
    }

    function renderSuggest() {
        sgStatus();
        $('sg-foot').classList.toggle('hidden', !sg.items.length);
        $('sg-list').innerHTML = sg.items.length ? sg.items.map(it => `
            <li data-item="${esc(it.itemId)}">
                <a href="https://www.aliexpress.com/item/${esc(it.itemId)}.html" target="_blank" rel="noopener" title="View on AliExpress"><img src="${esc(it.image)}" alt="" loading="lazy" referrerpolicy="no-referrer"></a>
                <div class="sg-fields">
                    <input class="input" data-f="title" value="${esc(it.title)}" maxlength="160" title="${esc(it.rawTitle)}">
                    <div class="sg-row">
                        <input class="input" data-f="category" list="cats" value="${esc(it.category)}" maxlength="60">
                        <input class="input" data-f="price" value="${esc(it.price)}" maxlength="30" title="Price">
                    </div>
                    <div class="sg-meta">${[
                        it.was && `<s>${esc(it.was)}</s> −${esc(it.discount)}`,
                        `${Number(it.orders).toLocaleString('en-US')} sold`,
                        it.rating && `${esc(it.rating)} positive`,
                        it.commission && `${esc(it.commission)} commission`,
                        `<a href="https://www.aliexpress.com/item/${esc(it.itemId)}.html" target="_blank" rel="noopener">View on AliExpress</a>`,
                    ].filter(Boolean).join(' · ')}</div>
                    <div class="sg-err hidden"></div>
                    <div class="sg-act">
                        <button class="btn ghost small" type="button" data-sg="skip">Skip</button>
                        <button class="btn small" type="button" data-sg="add">${icon('check')} Add</button>
                    </div>
                </div>
            </li>`).join('') : `<li style="display:block;color:var(--ink-soft)">Nothing waiting. New suggestions arrive every morning, or press "Find new now".</li>`;
    }

    function renderSgForm() {
        const st = sg.settings;
        $('sg-cats').innerHTML = sg.categories.map(c => `<label><input type="checkbox" value="${esc(c)}" ${st.categories.includes(c) ? 'checked' : ''}> ${esc(c)}</label>`).join('');
        SG_NUMS.forEach(k => { $(`sg-${k}`).value = st[k] ?? ''; });
    }

    function sgLoaded(d, form = true) {
        sg = d;
        renderSuggest();
        if (form) renderSgForm();
    }

    async function loadSuggest() {
        try { sgLoaded(await call('suggestions')); }
        catch (err) { $('sg-status').textContent = `Suggestions couldn't load: ${err.message}`; }
    }

    $('sg-refresh').addEventListener('click', async () => {
        busy($('sg-refresh'), true, 'Searching');
        note($('msg'), '');
        const before = sg.items.length;
        try {
            sgLoaded(await call('suggest-refresh'), false);
            const n = sg.items.length - before;
            if (!sg.lastRun?.errors?.length) note($('msg'), n > 0 ? `${n} new suggestion${n === 1 ? '' : 's'} found.` : 'Nothing new right now that matches your filters.', n > 0 ? 'ok' : 'warn');
        } catch (err) {
            note($('msg'), err.message);
        } finally {
            busy($('sg-refresh'), false);
        }
    });

    $('sg-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        busy($('sg-save'), true, 'Saving');
        try {
            const settings = { categories: [...$('sg-cats').querySelectorAll('input:checked')].map(i => i.value) };
            SG_NUMS.forEach(k => { settings[k] = $(`sg-${k}`).value; });
            sgLoaded(await call('suggest-settings', { settings }));
            $('sg-filters').open = false;
            note($('msg'), 'Filters saved. They apply from the next search.', 'ok');
        } catch (err) {
            note($('msg'), err.message);
        } finally {
            busy($('sg-save'), false);
        }
    });

    $('sg-list').addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-sg]');
        if (!btn) return;
        const li = btn.closest('li');
        const itemId = li.dataset.item;
        const val = (f) => li.querySelector(`[data-f="${f}"]`).value.trim();
        const err = li.querySelector('.sg-err');
        li.querySelectorAll('button').forEach(b => { b.disabled = true; });
        try {
            if (btn.dataset.sg === 'add') {
                busy(btn, true, 'Adding');
                await queueSave(() => call('suggest-add', { itemId, title: val('title'), category: val('category'), price: val('price') }));
                note($('msg'), `Added "${val('title')}", live on the site now.`, 'ok');
                loadList().catch(() => {});
            } else {
                await call('suggest-skip', { itemIds: [itemId] });
            }
            sg.items = sg.items.filter(i => i.itemId !== itemId);
            li.remove();
            sgStatus();
            if (!sg.items.length) renderSuggest();
        } catch (ex) {
            busy(btn, false);
            li.querySelectorAll('button').forEach(b => { b.disabled = false; });
            err.textContent = ex.message;
            err.classList.remove('hidden');
            if (ex.status === 409 || ex.status === 404) loadSuggest();
        }
    });

    $('sg-skip-all').addEventListener('click', async () => {
        if (!confirm(`Skip all ${sg.items.length} suggestions? They won't be suggested again.`)) return;
        busy($('sg-skip-all'), true, 'Skipping');
        try { sgLoaded(await call('suggest-skip', { itemIds: sg.items.map(i => i.itemId) }), false); }
        catch (err) { note($('msg'), err.message); }
        finally { busy($('sg-skip-all'), false); }
    });

    // ---------- AI agency (agency.mjs on the server) ----------

    let ag = null;
    const agTab = {}; // draft id → { ch, lang } being viewed
    const AG_IDS = ['telegramChat', 'facebookPageId', 'instagramId', 'threadsUserId', 'pinterestBoard'];
    const AG_HELP = {
        telegram: 'Needs a bot token and the channel name. The bot must be an admin of the channel.',
        facebook: 'Needs a Page token from a Meta app and the Page id.',
        instagram: 'Business account linked to the Facebook Page; uses the same token.',
        threads: 'Needs a Threads token from the same Meta app.',
        pinterest: 'Needs a Pinterest API token and a board id.',
    };
    const agWhen = (iso) => iso ? new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    const agLink = (d, ch, lang) => `${shareLink(d.productId, lang)}?s=${ag.channels[ch].tag}`;

    // the text exactly as it should be pasted on the platform
    function agFull(d, ch, lang) {
        const text = d.posts[ch]?.[lang] || '';
        return ag.channels[ch].link ? `${text}\n\n👉 ${agLink(d, ch, lang)}` : text;
    }

    function agShareUrl(d, ch, lang) {
        const text = d.posts[ch]?.[lang] || '';
        const link = agLink(d, ch, lang);
        const e = encodeURIComponent;
        return {
            x: `https://twitter.com/intent/tweet?text=${e(`${text}\n${link}`)}`,
            whatsapp: `https://wa.me/?text=${e(`${text}\n\n👉 ${link}`)}`,
            telegram: `https://t.me/share/url?url=${e(link)}&text=${e(text)}`,
            facebook: `https://www.facebook.com/sharer/sharer.php?u=${e(link)}`,
            threads: `https://www.threads.net/intent/post?text=${e(`${text}\n\n${link}`)}`,
            linkedin: `https://www.linkedin.com/feed/?shareActive=true&text=${e(`${text}\n\n${link}`)}`,
            reddit: `https://www.reddit.com/submit?url=${e(link)}&title=${e(text.split('\n')[0].slice(0, 280))}`,
            pinterest: `https://www.pinterest.com/pin/create/button/?url=${e(link)}&media=${e(d.image)}&description=${e(text)}`,
        }[ch];
    }

    function agStatusLine(d) {
        const auto = Object.keys(d.posts).some(c => ag.channels[c].auto && ag.connected[c]);
        if (d.status === 'waiting') return `${icon('clock')} Waiting for your OK · ${ag.settings.autopilot ? 'Autopilot posts it' : 'slot'} ${agWhen(d.slot)}`;
        if (d.status === 'approved') return auto ? `${icon('check')} Approved · posts ${agWhen(d.slot)}` : `${icon('check')} Approved · no automatic channel connected yet, use Copy / Share`;
        if (d.status === 'publishing') return `${icon('loader', 'spin')} Publishing…`;
        const res = Object.entries(d.results || {});
        if (!res.length) return `${icon('check')} Done · nothing posted automatically (no channel connected)`;
        return res.map(([k, r]) => r.ok
            ? `${icon('check')} ${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(k)}</a>` : esc(k)}${r.manual ? ' (by hand)' : ''}`
            : `<span class="ag-bad" title="${esc(r.error)}">${icon('alert')} ${esc(k)}: ${esc(r.error)}</span>`).join(' · ');
    }

    function agDraftHtml(d) {
        const chans = Object.keys(d.posts);
        const t = agTab[d.id] ||= { ch: chans[0], lang: 'he' };
        if (!d.posts[t.ch]) t.ch = chans[0];
        const ch = ag.channels[t.ch];
        const text = d.posts[t.ch]?.[t.lang] || '';
        const share = agShareUrl(d, t.ch, t.lang);
        const open = d.status === 'waiting' || d.status === 'approved';
        const anyAuto = Object.values(ag.connected).some(Boolean);
        return `
            <li data-draft="${esc(d.id)}" class="ag-${esc(d.status)}">
                <div class="ag-top">
                    <img src="${esc(d.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">
                    <div>
                        <div class="t">${esc(d.title)}</div>
                        <div class="c">${esc(d.category)}${d.price ? ` · ${esc(d.price)}` : ''}</div>
                        ${d.angle ? `<div class="ag-angle">Angle: ${esc(d.angle)}</div>` : ''}
                        ${d.notes ? `<div class="ag-angle">Editor: ${esc(d.notes)}</div>` : ''}
                        <div class="ag-state">${agStatusLine(d)}</div>
                    </div>
                </div>
                <div class="ag-tabs">${chans.map(c => `<button type="button" data-ch="${c}" aria-pressed="${c === t.ch}" class="${ag.channels[c].auto ? 'auto' : ''}${d.results?.[c]?.ok ? ' done' : ''}">${esc(ag.channels[c].name)}</button>`).join('')}</div>
                <div class="ag-editor">
                    <div class="seg ag-lang">
                        <button type="button" data-lang="he" aria-pressed="${t.lang === 'he'}" lang="he">עברית</button>
                        <button type="button" data-lang="en" aria-pressed="${t.lang === 'en'}">English</button>
                    </div>
                    <span class="ag-count">${text.length}/${ch.max}${ch.auto ? (ag.connected[t.ch] ? ' · posts automatically' : ' · automatic once connected') : ' · post it yourself'}${ch.link ? '' : ' · links don\'t work here, "link in bio"'}</span>
                    <textarea class="input" rows="7" dir="${t.lang === 'he' ? 'rtl' : 'ltr'}" ${d.status === 'posted' ? 'readonly' : ''}>${esc(text)}</textarea>
                    ${ch.link ? `<div class="ag-link">+ ${esc(agLink(d, t.ch, t.lang))}</div>` : ''}
                </div>
                <div class="sg-err hidden"></div>
                <div class="ag-act">
                    <button class="btn ghost small" type="button" data-ag="copy">${icon('copy')} Copy</button>
                    ${share ? `<a class="btn ghost small" href="${esc(share)}" target="_blank" rel="noopener" data-ag="share">${icon('share')} Share</a>` : ''}
                    ${!ch.auto || !ag.connected[t.ch] ? `<button class="btn ghost small" type="button" data-ag="manual" ${d.results?.[t.ch]?.ok ? 'disabled' : ''}>${d.results?.[t.ch]?.ok ? 'Marked posted' : 'Mark as posted'}</button>` : ''}
                    <span class="ag-sp"></span>
                    ${open ? `<button class="btn ghost small hidden" type="button" data-ag="save">Save edits</button>
                    <button class="btn ghost small" type="button" data-ag="skip">Skip</button>
                    ${anyAuto ? `<button class="btn ghost small" type="button" data-ag="now">Post now</button>` : ''}
                    ${d.status === 'waiting' ? `<button class="btn small" type="button" data-ag="approve">${icon('check')} Approve</button>` : `<button class="btn ghost small" type="button" data-ag="unapprove">Undo approve</button>`}` : ''}
                </div>
            </li>`;
    }

    function renderAgency() {
        const st = ag.settings;
        const waiting = ag.drafts.filter(d => d.status === 'waiting').length;
        $('ag-badge').textContent = waiting || '';
        const conn = Object.entries(ag.connected).filter(([, v]) => v).map(([k]) => ag.channels[k].name);
        $('ag-status').textContent = [
            st.paused ? 'Paused' : st.autopilot ? 'Autopilot on' : `${waiting} post${waiting === 1 ? '' : 's'} waiting for your OK`,
            conn.length ? `posting to ${conn.join(', ')}` : 'no channel connected yet',
        ].join(' · ');

        // drafts: open ones first (by slot), then the history
        const open = ag.drafts.filter(d => d.status === 'waiting' || d.status === 'approved' || d.status === 'publishing').sort((a, b) => a.slot.localeCompare(b.slot));
        const done = ag.drafts.filter(d => !open.includes(d));
        $('ag-list').innerHTML = open.length || done.length
            ? open.map(agDraftHtml).join('') + (done.length ? `<li class="ag-sep">Posted earlier</li>` + done.map(agDraftHtml).join('') : '')
            : `<li class="ag-empty">No posts yet. New ones are written every morning, or press "Write new posts now".</li>`;

        $('ag-chans').innerHTML = Object.entries(ag.channels).map(([k, c]) => `
            <li>
                <b>${esc(c.name)}</b>
                <span>${c.auto
                    ? (ag.connected[k] ? `<span class="ag-ok">${icon('check')} Connected</span>` : `<span class="ag-off">Not connected</span> · ${AG_HELP[k]}`)
                    : 'Ready-to-post text with Copy / Share (this platform has no free posting API)'}</span>
                ${c.auto && ag.connected[k] ? `<button class="btn ghost small" type="button" data-test="${k}">Test</button>` : '<span></span>'}
            </li>`).join('');

        $('ag-guides').innerHTML = ag.guides.length ? ag.guides.map(g => `
            <li data-guide="${esc(g.id)}">
                <div class="t">${esc(g.title)}</div>
                <div class="t" dir="rtl" lang="he">${esc(g.titleHe)}</div>
                <div class="ag-angle">${esc(g.description)} · ${g.items.length} deals · /guides/${esc(g.slug)}</div>
                <details><summary>Read it</summary><p>${esc(g.intro)}</p><ol>${g.items.map(i => `<li>${esc(i.why)}</li>`).join('')}</ol><p>${esc(g.outro)}</p></details>
                <div class="ag-act"><span class="ag-sp">${g.status === 'approved' ? `${icon('check')} Approved` : 'Waiting for your OK'}</span>
                    ${g.status === 'approved' ? `<button class="btn ghost small" type="button" data-g="waiting">Undo</button>` : `<button class="btn ghost small" type="button" data-g="skipped">Skip</button><button class="btn small" type="button" data-g="approved">${icon('check')} Approve</button>`}
                </div>
            </li>`).join('') : '<li class="ag-empty">The first guide is written on Monday morning.</li>';

        const r = ag.reports[0];
        const visits = Object.entries(ag.visits.week).filter(([, n]) => n);
        $('ag-report').innerHTML = `
            <p class="bulk-hint">People who opened a deal from each platform: ${visits.length ? visits.map(([k, n]) => `<b>${esc(ag.channels[k].name)}</b> ${n}`).join(' · ') : 'none yet'} (last 7 days).</p>
            ${r ? `<div class="ag-report"><div class="ag-angle">Analyst, ${agWhen(r.at)}</div><p>${esc(r.summary)}</p>${r.advice ? `<p><b>Next week:</b> ${esc(r.advice)}</p>` : ''}</div>` : '<p class="bulk-hint">The analyst writes a report every Monday.</p>'}`;

        $('ag-log').innerHTML = ag.log.map(l => `<li><span>${agWhen(l.at)}</span> ${esc(l.text)}</li>`).join('') || '<li>Nothing yet.</li>';
    }

    function renderAgForm() {
        const st = ag.settings;
        $('ag-perDay').value = st.perDay;
        $('ag-slots').value = st.slots.join(', ');
        $('ag-publishLang').value = st.publishLang;
        ['autopilot', 'guides', 'paused'].forEach(k => { $(`ag-${k}`).checked = !!st[k]; });
        AG_IDS.forEach(k => { $(`ag-${k}`).value = st[k] || ''; });
        $('ag-chan-boxes').innerHTML = Object.entries(ag.channels).map(([k, c]) => `<label><input type="checkbox" value="${k}" ${st.channels.includes(k) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('');
    }

    function agLoaded(d, form = true) {
        ag = d;
        renderAgency();
        if (form) renderAgForm();
    }

    async function loadAgency() {
        try { agLoaded(await call('agency')); }
        catch (err) { $('ag-status').textContent = `The agency couldn't load: ${err.message}`; }
    }

    $('ag-run').addEventListener('click', async () => {
        busy($('ag-run'), true, 'The team is writing (about a minute)');
        note($('msg'), '');
        try {
            const r = await call('agency-run-now');
            agLoaded(r, false);
            note($('msg'), r.made ? `${r.made} new post${r.made === 1 ? '' : 's'} written. Read them below and approve the ones you like.` : `Nothing new was written${r.errors?.length ? `: ${r.errors[0]}` : '. Every deal was promoted in the last 14 days.'}`, r.made ? 'ok' : 'warn');
        } catch (err) { note($('msg'), err.message); }
        finally { busy($('ag-run'), false); }
    });

    $('ag-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        busy($('ag-save'), true, 'Saving');
        try {
            const settings = {
                perDay: $('ag-perDay').value,
                slots: $('ag-slots').value.split(/[,\s]+/).filter(Boolean).map(s => s.padStart(5, '0')),
                publishLang: $('ag-publishLang').value,
                channels: [...$('ag-chan-boxes').querySelectorAll('input:checked')].map(i => i.value),
            };
            ['autopilot', 'guides', 'paused'].forEach(k => { settings[k] = $(`ag-${k}`).checked; });
            AG_IDS.forEach(k => { settings[k] = $(`ag-${k}`).value.trim(); });
            agLoaded(await call('agency-settings', { settings }));
            $('ag-settings').open = false;
            note($('msg'), 'Settings saved.', 'ok');
        } catch (err) { note($('msg'), err.message); }
        finally { busy($('ag-save'), false); }
    });

    $('ag-chans').addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-test]');
        if (!btn) return;
        busy(btn, true, 'Checking');
        try { note($('msg'), (await call('agency-test', { channel: btn.dataset.test })).message, 'ok'); }
        catch (err) { note($('msg'), `${ag.channels[btn.dataset.test].name}: ${err.message}`); }
        finally { busy(btn, false); }
    });

    const agDraftOf = (li) => ag.drafts.find(d => d.id === li.dataset.draft);
    const agRerender = (li) => { li.outerHTML = agDraftHtml(agDraftOf(li)); };

    $('ag-list').addEventListener('input', (e) => {
        if (e.target.tagName !== 'TEXTAREA') return;
        const li = e.target.closest('li');
        const d = agDraftOf(li);
        const t = agTab[d.id];
        d.posts[t.ch][t.lang] = e.target.value;
        (d.dirty ||= {})[t.ch] = true;
        li.querySelector('.ag-count').textContent = li.querySelector('.ag-count').textContent.replace(/^\d+/, e.target.value.length);
        li.querySelector('[data-ag="save"]')?.classList.remove('hidden');
    });

    $('ag-list').addEventListener('click', async (e) => {
        const li = e.target.closest('li[data-draft]');
        if (!li) return;
        const d = agDraftOf(li);
        const t = agTab[d.id];
        const tab = e.target.closest('button[data-ch]');
        const lang = e.target.closest('button[data-lang]');
        if (tab || lang) {
            if (tab) t.ch = tab.dataset.ch;
            if (lang) t.lang = lang.dataset.lang;
            return agRerender(li);
        }
        const btn = e.target.closest('[data-ag]');
        if (!btn) return;
        const act = btn.dataset.ag;
        if (act === 'share') return;
        if (act === 'copy') {
            await navigator.clipboard.writeText(agFull(d, t.ch, t.lang));
            btn.innerHTML = `${icon('check')} Copied`;
            setTimeout(() => { btn.innerHTML = `${icon('copy')} Copy`; }, 1500);
            return;
        }
        const err = li.querySelector('.sg-err');
        li.querySelectorAll('.ag-act button').forEach(b => { b.disabled = true; });
        try {
            const edits = d.dirty ? Object.fromEntries(Object.keys(d.dirty).map(c => [c, d.posts[c]])) : undefined;
            if (act === 'now') {
                if (!confirm('Post this deal to the connected channels now?')) throw Object.assign(new Error(''), { quiet: true });
                busy(btn, true, 'Posting');
                if (edits) await call('agency-draft', { id: d.id, posts: edits });
                const r = await call('agency-publish-now', { id: d.id });
                agLoaded(r.view, false);
                return;
            }
            const body = { id: d.id, posts: edits };
            if (act === 'approve') body.status = 'approved';
            if (act === 'unapprove') body.status = 'waiting';
            if (act === 'skip') body.status = 'skipped';
            if (act === 'manual') body.manual = t.ch;
            busy(btn, true, act === 'save' ? 'Saving' : '…');
            const { draft } = await call('agency-draft', body);
            if (draft.status === 'skipped') ag.drafts = ag.drafts.filter(x => x.id !== d.id);
            else Object.assign(d, draft, { dirty: undefined });
            renderAgency();
        } catch (ex) {
            if (!ex.quiet) { err.textContent = ex.message; err.classList.remove('hidden'); }
            li.querySelectorAll('.ag-act button').forEach(b => { b.disabled = false; });
            busy(btn, false);
            if (ex.status === 404 || ex.status === 409) loadAgency();
        }
    });

    $('ag-guides').addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-g]');
        if (!btn) return;
        busy(btn, true, '…');
        try {
            await call('agency-guide', { id: btn.closest('li').dataset.guide, status: btn.dataset.g });
            await loadAgency();
            if (btn.dataset.g === 'approved') note($('msg'), 'Guide approved. It goes on the site with the next page rebuild.', 'ok');
        } catch (err) { note($('msg'), err.message); busy(btn, false); }
    });

    for (const [id, action, label] of [['ag-guide-now', 'agency-guide-now', 'Writing (up to a minute)'], ['ag-report-now', 'agency-report-now', 'Counting']]) {
        $(id).addEventListener('click', async () => {
            busy($(id), true, label);
            try { agLoaded(await call(action), false); }
            catch (err) { note($('msg'), err.message); }
            finally { busy($(id), false); }
        });
    }

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
        const [list, stats] = await Promise.all([api('list'), call('stats').catch((e) => { note($('msg'), `Click counts couldn't load: ${e.message}`); return null; })]);
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
            await Promise.all([loadList(), loadSuggest(), loadAgency()]);
        } catch { /* 401 already handled */ }
    }

    token ? start() : show('login');
})();
