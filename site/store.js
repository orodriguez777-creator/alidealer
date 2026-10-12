(() => {
    const $ = (id) => document.getElementById(id);
    const state = { products: [], category: 'All', q: '' };

    // ---------- language: English / Hebrew ----------

    const STRINGS = {
        en: {
            pageTitle: 'www.Alidealer.com — Only the best AliExpress deals',
            slogan: 'Only the best deals',
            findsListed: 'finds listed',
            tagline: SITE.tagline,
            updated: (d) => `Latest find added ${d}`,
            categories: 'Categories',
            search: 'Search finds',
            surprise: 'Surprise me',
            disclosure: 'Affiliate disclosure: links on this site are AliExpress affiliate links. If you buy through them we may earn a small commission, at no extra cost to you.',
            close: 'Close',
            randomFind: 'Random find',
            shuffling: 'Shuffling…',
            yourFind: 'Your random find',
            randomFrom: (c) => `Random from ${c}`,
            spinAgain: 'Spin again',
            seeOn: 'See on AliExpress',
            noMatch: ['Nothing matches', 'Try another search or category.'],
            noItems: ['First finds coming soon', 'Check back shortly.'],
            loadFailed: ['Couldn\'t load finds', 'Please refresh in a moment.'],
            switchTo: 'עברית',
        },
        he: {
            pageTitle: 'www.Alidealer.com — רק הדילים הכי טובים מ-AliExpress',
            slogan: 'רק הדילים הכי טובים',
            findsListed: 'מוצרים באתר',
            tagline: 'דילים נבחרים מ-AliExpress, שנבדקו ומוינו בשבילכם כדי שלא תצטרכו לחפש.',
            updated: (d) => `המוצר האחרון נוסף ב-${d}`,
            categories: 'קטגוריות',
            search: 'חיפוש מוצרים',
            surprise: 'הפתיעו אותי',
            disclosure: 'גילוי נאות: הקישורים באתר הם קישורי שותפים של AliExpress. אם תקנו דרכם ייתכן שנקבל עמלה קטנה, ללא כל עלות נוספת עבורכם.',
            close: 'סגירה',
            randomFind: 'מוצר אקראי',
            shuffling: 'מערבבים…',
            yourFind: 'המוצר האקראי שלכם',
            randomFrom: (c) => `בחירה אקראית: ${c}`,
            spinAgain: 'סובבו שוב',
            seeOn: 'לצפייה ב-AliExpress',
            noMatch: ['לא נמצאו מוצרים', 'נסו חיפוש או קטגוריה אחרים.'],
            noItems: ['המוצרים הראשונים יגיעו בקרוב', 'בדקו שוב בקרוב.'],
            loadFailed: ['לא הצלחנו לטעון את המוצרים', 'נסו לרענן את הדף בעוד רגע.'],
            switchTo: 'English',
        },
    };
    const CATEGORY_HE = {
        'All': 'הכל', 'Electronics': 'אלקטרוניקה', 'Phone Accessories': 'אביזרים לטלפון',
        'Computers & Office': 'מחשבים ומשרד', 'Home & Kitchen': 'בית ומטבח',
        'Tools & Home Improvement': 'כלי עבודה ושיפוצים', 'Lighting': 'תאורה',
        'Women\'s Fashion': 'אופנת נשים', 'Men\'s Fashion': 'אופנת גברים', 'Shoes': 'נעליים',
        'Bags & Luggage': 'תיקים ומזוודות', 'Jewelry & Watches': 'תכשיטים ושעונים',
        'Beauty & Health': 'יופי ובריאות', 'Sports & Outdoors': 'ספורט ופעילות בחוץ',
        'Toys & Hobbies': 'צעצועים ותחביבים', 'Baby & Kids': 'תינוקות וילדים',
        'Pet Supplies': 'מוצרים לחיות מחמד', 'Automotive': 'רכב', 'Garden': 'גינה', 'Other': 'אחר',
    };

    let lang = localStorage.getItem('lang') || (/^(he|iw)\b/i.test(navigator.language) ? 'he' : 'en');
    const t = (key) => STRINGS[lang][key];
    const catName = (c) => (lang === 'he' && CATEGORY_HE[c]) || c;
    // via our API, which opens the product page itself rather than the short
    // affiliate link (the AliExpress phone app opens short links on its home screen)
    const goUrl = (p) => `/api?go=${encodeURIComponent(p.id)}`;
    const titleOf = (p) => (lang === 'he' && p.titleHe) || p.title;

    function applyLang() {
        const he = lang === 'he';
        document.documentElement.lang = lang;
        document.documentElement.dir = he ? 'rtl' : 'ltr';
        document.title = t('pageTitle');
        document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
        document.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
        $('tagline').textContent = t('tagline');
        $('lang-label').textContent = t('switchTo');
        $('lang').lang = he ? 'en' : 'he';
        renderUpdated();
    }

    function renderUpdated() {
        const latest = state.products[0];
        if (!latest) return;
        const d = new Date(latest.createdAt).toLocaleDateString(lang === 'he' ? 'he-IL' : 'en-US', { day: 'numeric', month: 'long' });
        $('updated').textContent = t('updated')(d);
    }

    $('lang').addEventListener('click', () => {
        lang = lang === 'he' ? 'en' : 'he';
        localStorage.setItem('lang', lang);
        applyLang();
        renderChips();
        renderGrid();
        if (lastPick && !spinning) { showInLucky(lastPick); $('lucky-label').textContent = pickLabel(); }
    });

    $('brand').innerHTML = brandHtml(SITE.name);
    $('copy').textContent = `© ${new Date().getFullYear()} ${SITE.name}`;

    function renderChips() {
        const counts = {};
        state.products.forEach(p => { counts[p.category] = (counts[p.category] || 0) + 1; });
        const cats = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
        $('chips').innerHTML = ['All', ...cats].map(c => `
            <button class="chip" aria-pressed="${c === state.category}" data-cat="${esc(c)}">
                ${esc(catName(c))}<sup>${c === 'All' ? state.products.length : counts[c]}</sup>
            </button>`).join('');
    }

    function renderGrid() {
        const q = state.q.toLowerCase();
        const items = state.products.filter(p =>
            (state.category === 'All' || p.category === state.category) &&
            (!q || [p.title, p.titleHe, p.category, CATEGORY_HE[p.category]].some(s => s && s.toLowerCase().includes(q))));

        if (!items.length) {
            const [h, sub] = t(state.products.length ? 'noMatch' : 'noItems');
            $('grid').innerHTML = `<div class="empty"><h2>${h}</h2><p>${sub}</p></div>`;
            return;
        }

        $('grid').innerHTML = items.map((p, i) => `
            <a class="card" href="${goUrl(p)}" target="_blank" rel="sponsored nofollow noopener" style="animation-delay:${Math.min(i, 16) * 45}ms">
                <div class="card-img">
                    ${p.image
                        ? `<img src="${esc(p.image)}" alt="${esc(titleOf(p))}" loading="lazy" referrerpolicy="no-referrer">`
                        : `<div class="noimg">${icon('image')}</div>`}
                    <span class="card-num">${String(i + 1).padStart(2, '0')}</span>
                </div>
                <div class="card-cat">${esc(catName(p.category))}</div>
                <h3 class="card-title">${esc(titleOf(p))}</h3>
                <div class="card-foot">
                    <span class="price">${esc(p.price)}</span>
                    <span class="go">${t('seeOn')} ${icon('arrow')}</span>
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
        $('lucky-cat').textContent = catName(p.category);
        $('lucky-title').textContent = titleOf(p);
        $('lucky-price').textContent = p.price || '';
    }

    function pool() {
        const inCategory = state.products.filter(p => state.category === 'All' || p.category === state.category);
        return inCategory.length ? inCategory : state.products;
    }

    function pickLabel() {
        return state.category === 'All' ? t('yourFind') : t('randomFrom')(catName(state.category));
    }

    async function spin() {
        const items = pool();
        if (!items.length || spinning) return;
        spinning = true;
        lucky.classList.add('spinning');
        $('lucky-label').textContent = t('shuffling');
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
        $('lucky-go').href = goUrl(pick);
        $('lucky-label').textContent = pickLabel();
        lucky.classList.remove('spinning');
        $('lucky-again').disabled = false;
        spinning = false;
    }

    $('surprise').addEventListener('click', () => { lucky.showModal(); spin(); });
    $('lucky-again').addEventListener('click', spin);
    $('lucky-close').addEventListener('click', () => lucky.close());
    lucky.addEventListener('click', (e) => { if (e.target === lucky) lucky.close(); });

    applyLang();

    api('list').then(({ products }) => {
        state.products = products;
        $('count').textContent = products.length;
        renderUpdated();
        renderChips();
        renderGrid();
        $('surprise').disabled = !products.length;
    }).catch(() => {
        const [h, sub] = t('loadFailed');
        $('grid').innerHTML = `<div class="empty"><h2>${h}</h2><p>${sub}</p></div>`;
    });
})();
