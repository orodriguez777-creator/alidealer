(() => {
    const $ = (id) => document.getElementById(id);
    const state = { products: [], category: 'All', q: '' };

    $('brand').innerHTML = brandHtml(SITE.name);
    $('tagline').textContent = SITE.tagline;
    $('copy').textContent = `© ${new Date().getFullYear()} ${SITE.name}`;

    function renderChips() {
        const counts = {};
        state.products.forEach(p => { counts[p.category] = (counts[p.category] || 0) + 1; });
        const cats = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
        $('chips').innerHTML = ['All', ...cats].map(c => `
            <button class="chip" aria-pressed="${c === state.category}" data-cat="${esc(c)}">
                ${esc(c)}<sup>${c === 'All' ? state.products.length : counts[c]}</sup>
            </button>`).join('');
    }

    function renderGrid() {
        const q = state.q.toLowerCase();
        const items = state.products.filter(p =>
            (state.category === 'All' || p.category === state.category) &&
            (!q || p.title.toLowerCase().includes(q) || p.category.toLowerCase().includes(q)));

        if (!items.length) {
            $('grid').innerHTML = state.products.length
                ? `<div class="empty"><h2>Nothing matches</h2><p>Try another search or category.</p></div>`
                : `<div class="empty"><h2>First finds coming soon</h2><p>Check back shortly.</p></div>`;
            return;
        }

        $('grid').innerHTML = items.map((p, i) => `
            <a class="card" href="${esc(p.url)}" target="_blank" rel="sponsored nofollow noopener" style="animation-delay:${Math.min(i, 16) * 45}ms">
                <div class="card-img">
                    ${p.image
                        ? `<img src="${esc(p.image)}" alt="${esc(p.title)}" loading="lazy" referrerpolicy="no-referrer">`
                        : `<div class="noimg">${icon('image')}</div>`}
                    <span class="card-num">${String(i + 1).padStart(2, '0')}</span>
                </div>
                <div class="card-cat">${esc(p.category)}</div>
                <h3 class="card-title">${esc(p.title)}</h3>
                <div class="card-foot">
                    <span class="price">${esc(p.price)}</span>
                    <span class="go">See on AliExpress ${icon('arrow')}</span>
                </div>
            </a>`).join('');
    }

    $('chips').addEventListener('click', (e) => {
        const btn = e.target.closest('.chip');
        if (!btn) return;
        state.category = btn.dataset.cat;
        renderChips();
        renderGrid();
    });
    $('q').addEventListener('input', (e) => { state.q = e.target.value.trim(); renderGrid(); });

    // ---------- Surprise me: shuffle through finds, land on a random one ----------

    const lucky = $('lucky');
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let lastPick = null;
    let spinning = false;

    function showInLucky(p) {
        $('lucky-img').innerHTML = p.image
            ? `<img src="${esc(p.image)}" alt="" referrerpolicy="no-referrer">`
            : `<div class="noimg">${icon('image')}</div>`;
        $('lucky-cat').textContent = p.category;
        $('lucky-title').textContent = p.title;
        $('lucky-price').textContent = p.price || '';
    }

    function pool() {
        const inCategory = state.products.filter(p => state.category === 'All' || p.category === state.category);
        return inCategory.length ? inCategory : state.products;
    }

    async function spin() {
        const items = pool();
        if (!items.length || spinning) return;
        spinning = true;
        lucky.classList.add('spinning');
        $('lucky-label').textContent = 'Shuffling…';
        $('lucky-again').disabled = true;
        $('lucky-go').removeAttribute('href');

        const choices = items.length > 1 ? items.filter(p => p !== lastPick) : items;
        const pick = choices[Math.floor(Math.random() * choices.length)];

        // slot-machine roll: quick flicks that slow down before the pick
        const steps = reduceMotion || items.length < 2 ? 0 : 14;
        for (let i = 0; i < steps; i++) {
            showInLucky(items[Math.floor(Math.random() * items.length)]);
            await new Promise(r => setTimeout(r, 50 + i * i * 1.6));
        }

        showInLucky(pick);
        lastPick = pick;
        $('lucky-go').href = pick.url;
        $('lucky-label').textContent = state.category === 'All' ? 'Your random find' : `Random from ${state.category}`;
        lucky.classList.remove('spinning');
        $('lucky-again').disabled = false;
        spinning = false;
    }

    $('surprise').addEventListener('click', () => { lucky.showModal(); spin(); });
    $('lucky-again').addEventListener('click', spin);
    $('lucky-close').addEventListener('click', () => lucky.close());
    lucky.addEventListener('click', (e) => { if (e.target === lucky) lucky.close(); });

    api('list').then(({ products }) => {
        state.products = products;
        $('count').textContent = products.length;
        if (products[0]) {
            const d = new Date(products[0].createdAt);
            $('updated').textContent = `Latest find added ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}`;
        }
        renderChips();
        renderGrid();
        $('surprise').disabled = !products.length;
    }).catch(() => {
        $('grid').innerHTML = `<div class="empty"><h2>Couldn't load finds</h2><p>Please refresh in a moment.</p></div>`;
    });
})();
