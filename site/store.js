(() => {
    const $ = (id) => document.getElementById(id);
    const state = { products: [], category: 'All', q: '' };

    // Accent the last word, or the last CamelCase part of a one-word name (AliDealer → Ali·Dealer)
    const m = SITE.name.match(/^(.*\s)(\S+)$/) || SITE.name.match(/^(.*[a-z])([A-Z]\w*)$/);
    $('brand').innerHTML = m ? `${esc(m[1])}<em>${esc(m[2])}</em>` : esc(SITE.name);
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

    api('list').then(({ products }) => {
        state.products = products;
        $('count').textContent = products.length;
        if (products[0]) {
            const d = new Date(products[0].createdAt);
            $('updated').textContent = `Latest find added ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}`;
        }
        renderChips();
        renderGrid();
    }).catch(() => {
        $('grid').innerHTML = `<div class="empty"><h2>Couldn't load finds</h2><p>Please refresh in a moment.</p></div>`;
    });
})();
