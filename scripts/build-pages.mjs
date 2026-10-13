// Builds the pages Google indexes: one page per deal and per category, in English
// and Hebrew, plus sitemap.xml and robots.txt. Reads the live catalog from the API.
//
//   node scripts/build-pages.mjs && openkbs site deploy
//
// Deals added in admin get their pages on the next run.
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'site');
const ORIGIN = 'https://alidealer.com';
const API = 'https://ghzfcfbdwidurfqkjaateras4m0hnndz.lambda-url.eu-central-1.on.aws/';
const ASSET_V = 18;

// same names the storefront shows in Hebrew mode (site/store.js)
const CATEGORY_HE = {
    'Electronics': 'אלקטרוניקה', 'Phone Accessories': 'אביזרים לטלפון',
    'Computers & Office': 'מחשבים ומשרד', 'Home & Kitchen': 'בית ומטבח',
    'Tools & Home Improvement': 'כלי עבודה ושיפוצים', 'Lighting': 'תאורה',
    'Women\'s Fashion': 'אופנת נשים', 'Men\'s Fashion': 'אופנת גברים', 'Shoes': 'נעליים',
    'Bags & Luggage': 'תיקים ומזוודות', 'Jewelry & Watches': 'תכשיטים ושעונים',
    'Beauty & Health': 'יופי ובריאות', 'Sports & Outdoors': 'ספורט ופעילות בחוץ',
    'Toys & Hobbies': 'צעצועים ותחביבים', 'Baby & Kids': 'תינוקות וילדים',
    'Pet Supplies': 'מוצרים לחיות מחמד', 'Automotive': 'רכב', 'Garden': 'גינה', 'Other': 'אחר',
};

const T = {
    en: {
        home: 'Home', slogan: 'Only the best deals', switchTo: 'עברית', switchLang: 'he',
        seeOn: 'See on AliExpress', categories: 'Browse by category', allDeals: 'All deals',
        priceNote: 'Price as listed on AliExpress when we picked it. It can change, so check the final price there.',
        more: (c) => `More ${c} deals`,
        dealTitle: (p, price) => `${p}${price ? ` — ${price}` : ''} | www.Alidealer.com`,
        dealDesc: (p, price, c) => `${p}${price ? ` for ${price}` : ''} on AliExpress, hand-picked by www.Alidealer.com. See more ${c} deals.`,
        catH1: (c) => `${c} deals from AliExpress`,
        catTitle: (c) => `${c} deals from AliExpress | www.Alidealer.com`,
        catDesc: (n, c) => `${n} hand-picked ${c} finds from AliExpress, checked and sorted by www.Alidealer.com.`,
        disclosure: 'Affiliate disclosure: links on this site are AliExpress affiliate links. If you buy through them we may earn a small commission, at no extra cost to you.',
    },
    he: {
        home: 'דף הבית', slogan: 'רק הדילים הכי טובים', switchTo: 'English', switchLang: 'en',
        seeOn: 'לצפייה ב-AliExpress', categories: 'קטגוריות', allDeals: 'כל הדילים',
        priceNote: 'המחיר כפי שהופיע ב-AliExpress כשבחרנו את המוצר. הוא עשוי להשתנות, לכן כדאי לבדוק את המחיר הסופי שם.',
        more: (c) => `עוד דילים: ${c}`,
        dealTitle: (p, price) => `${p}${price ? ` — ${price}` : ''} | www.Alidealer.com`,
        dealDesc: (p, price, c) => `${p}${price ? ` ב-${price}` : ''} ב-AliExpress, נבחר בקפידה ב-www.Alidealer.com. עוד דילים של ${c}.`,
        catH1: (c) => `דילים של ${c} מ-AliExpress`,
        catTitle: (c) => `דילים של ${c} מ-AliExpress | www.Alidealer.com`,
        catDesc: (n, c) => `${n} מוצרי ${c} נבחרים מ-AliExpress, שנבדקו ומוינו בשבילכם ב-www.Alidealer.com.`,
        disclosure: 'גילוי נאות: הקישורים באתר הם קישורי שותפים של AliExpress. אם תקנו דרכם ייתכן שנקבל עמלה קטנה, ללא כל עלות נוספת עבורכם.',
    },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = (s) => String(s).toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function dealSlug(p) {
    let base = slugify(p.title);
    if (base.length > 60) base = base.slice(0, 60).replace(/-[^-]*$/, '');
    return `${base || 'deal'}-${p.id.slice(0, 6)}`;
}

// "$35.84", "18.85 $", "46.81" → 35.84 (USD); shekel prices keep their currency
function parsePrice(raw) {
    const m = String(raw || '').match(/\d+(?:[.,]\d{1,2})?/);
    if (!m) return null;
    const amount = m[0].replace(',', '.');
    const currency = /₪|ILS|NIS/i.test(raw) ? 'ILS' : 'USD';
    return { amount, currency, label: currency === 'ILS' ? `₪${amount}` : `$${amount}` };
}

const prefix = (lang) => lang === 'he' ? '/he' : '';
const dealPath = (p, lang) => `${prefix(lang)}/deal/${dealSlug(p)}`;
const catPath = (c, lang) => `${prefix(lang)}/category/${slugify(c)}`;
const catName = (c, lang) => (lang === 'he' && CATEGORY_HE[c]) || c;
const titleOf = (p, lang) => (lang === 'he' && p.titleHe) || p.title;
const homePath = (lang) => lang === 'he' ? '/?lang=he' : '/';

function layout({ lang, title, description, path, altPath, image, jsonLd, body, cats }) {
    const t = T[lang];
    const he = lang === 'he';
    const enPath = he ? altPath : path;
    const hePath = he ? path : altPath;
    return `<!DOCTYPE html>
<html lang="${lang}" dir="${he ? 'rtl' : 'ltr'}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}">
    <link rel="canonical" href="${ORIGIN}${path}">
    <link rel="alternate" hreflang="en" href="${ORIGIN}${enPath}">
    <link rel="alternate" hreflang="he" href="${ORIGIN}${hePath}">
    <link rel="alternate" hreflang="x-default" href="${ORIGIN}${enPath}">
    <meta name="theme-color" content="#f56c1c">
    <link rel="icon" href="/favicon.ico" sizes="any">
    <link rel="icon" href="/favicon.png" type="image/png">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    <link rel="manifest" href="/manifest.json">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="www.Alidealer.com">
    <meta property="og:locale" content="${he ? 'he_IL' : 'en_US'}">
    <meta property="og:title" content="${esc(title)}">
    <meta property="og:description" content="${esc(description)}">
    <meta property="og:image" content="${esc(image || `${ORIGIN}/og.jpg`)}">
    <meta property="og:url" content="${ORIGIN}${path}">
    <meta name="twitter:card" content="summary_large_image">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Josefin+Sans:wght@400;600;700&family=Instrument+Sans:wght@400;600&family=Rubik:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/styles.css?v=${ASSET_V}">
    ${jsonLd.map(j => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, '\\u003c')}</script>`).join('\n    ')}
</head>
<body>
    <header class="hero hero-small">
        <div class="wrap hero-inner">
            <a class="logo" href="${homePath(lang)}" aria-label="www.Alidealer.com">
                <img class="logo-cart" src="/cart.png" alt="" width="209" height="160">
                <span class="logo-text">
                    <span class="brand" dir="ltr"><small>www.</small>Alidealer<small>.com</small></span>
                    <span class="slogan">${t.slogan}</span>
                </span>
            </a>
            <div class="masthead-meta">
                <a class="lang" href="${he ? enPath : hePath}" hreflang="${t.switchLang}" lang="${t.switchLang}">
                    <svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
                    ${t.switchTo}
                </a>
            </div>
        </div>
    </header>

    <div class="wrap">
${body}
        <nav class="cat-nav" aria-label="${t.categories}">
            <h2>${t.categories}</h2>
            <ul>
                <li><a href="${homePath(lang)}">${t.allDeals}</a></li>
${cats.map(c => `                <li><a href="${catPath(c, lang)}">${esc(catName(c, lang))}</a></li>`).join('\n')}
            </ul>
        </nav>

        <footer>
            <span>${t.disclosure}</span>
            <span>© ${new Date().getFullYear()} www.Alidealer.com</span>
        </footer>
    </div>
</body>
</html>
`;
}

function crumbs(lang, items) {
    return `        <nav class="crumbs" aria-label="Breadcrumb">
            ${items.map(([label, href]) => href ? `<a href="${href}">${esc(label)}</a>` : `<span aria-current="page">${esc(label)}</span>`).join('<span class="sep">/</span>')}
        </nav>`;
}

function breadcrumbLd(items) {
    return {
        '@context': 'https://schema.org', '@type': 'BreadcrumbList',
        itemListElement: items.map(([name, href], i) => ({ '@type': 'ListItem', position: i + 1, name, ...(href && { item: ORIGIN + href }) })),
    };
}

function cardsHtml(items, lang) {
    return items.map((p, i) => {
        const price = parsePrice(p.price);
        return `
            <a class="card" href="${dealPath(p, lang)}" style="animation-delay:${Math.min(i, 16) * 45}ms">
                <div class="card-img">
                    ${p.image ? `<img src="${esc(p.image)}" alt="${esc(titleOf(p, lang))}" loading="lazy" referrerpolicy="no-referrer" width="400" height="400">` : ''}
                </div>
                <div class="card-cat">${esc(catName(p.category, lang))}</div>
                <h3 class="card-title">${esc(titleOf(p, lang))}</h3>
                <div class="card-foot"><span class="price">${esc(price?.label || p.price || '')}</span></div>
            </a>`;
    }).join('');
}

function dealPage(p, lang, products, cats) {
    const t = T[lang];
    const name = titleOf(p, lang);
    const cat = catName(p.category, lang);
    const price = parsePrice(p.price);
    const path = dealPath(p, lang);
    const trail = [[t.home, homePath(lang)], [cat, catPath(p.category, lang)], [name]];
    const related = products.filter(x => x.category === p.category && x.id !== p.id).slice(0, 8);

    const productLd = {
        '@context': 'https://schema.org', '@type': 'Product',
        name, category: cat, url: ORIGIN + path,
        ...(p.image && { image: [p.image] }),
        ...(price && { offers: { '@type': 'Offer', price: price.amount, priceCurrency: price.currency, url: ORIGIN + path } }),
    };

    const body = `${crumbs(lang, trail)}
        <article class="deal">
            <div class="deal-img">
                ${p.image ? `<img src="${esc(p.image)}" alt="${esc(name)}" referrerpolicy="no-referrer" width="600" height="600">` : ''}
            </div>
            <div class="deal-info">
                <a class="card-cat" href="${catPath(p.category, lang)}">${esc(cat)}</a>
                <h1>${esc(name)}</h1>
                ${price ? `<div class="price deal-price">${esc(price.label)}</div>` : ''}
                <a class="btn accent deal-go" href="/api?go=${encodeURIComponent(p.id)}" target="_blank" rel="sponsored nofollow noopener">${t.seeOn}
                    <svg class="icon" viewBox="0 0 24 24"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg></a>
                <p class="deal-note">${t.priceNote}</p>
            </div>
        </article>
${related.length ? `
        <section class="related">
            <h2>${esc(t.more(cat))}</h2>
            <div class="grid">${cardsHtml(related, lang)}
            </div>
        </section>` : ''}`;

    return layout({
        lang, path, altPath: dealPath(p, lang === 'he' ? 'en' : 'he'), image: p.image, cats,
        title: t.dealTitle(name, price?.label),
        description: t.dealDesc(name, price?.label, cat),
        jsonLd: [productLd, breadcrumbLd(trail)],
        body,
    });
}

function categoryPage(c, lang, items, cats) {
    const t = T[lang];
    const cat = catName(c, lang);
    const path = catPath(c, lang);
    const trail = [[t.home, homePath(lang)], [cat]];
    const body = `${crumbs(lang, trail)}
        <section class="cat-head">
            <h1>${esc(t.catH1(cat))}</h1>
            <p>${esc(t.catDesc(items.length, cat))}</p>
        </section>
        <div class="grid">${cardsHtml(items, lang)}
        </div>`;
    return layout({
        lang, path, altPath: catPath(c, lang === 'he' ? 'en' : 'he'), image: items.find(p => p.image)?.image, cats,
        title: t.catTitle(cat),
        description: t.catDesc(items.length, cat),
        jsonLd: [breadcrumbLd(trail), {
            '@context': 'https://schema.org', '@type': 'ItemList',
            itemListElement: items.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: ORIGIN + dealPath(p, lang) })),
        }],
        body,
    });
}

async function write(rel, content) {
    const file = join(SITE_DIR, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
}

const res = await fetch(API, { method: 'POST', body: JSON.stringify({ action: 'list' }) });
const { products } = await res.json();
if (!Array.isArray(products) || !products.length) throw new Error('No products came back from the API');

const counts = {};
products.forEach(p => { counts[p.category] = (counts[p.category] || 0) + 1; });
const cats = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);

// start clean so pages of deleted deals don't linger locally
for (const dir of ['deal', 'category', 'he']) await rm(join(SITE_DIR, dir), { recursive: true, force: true });

const urls = [{ loc: '/', alt: null, lastmod: products[0].createdAt }];
for (const lang of ['en', 'he']) {
    for (const p of products) {
        await write(`${dealPath(p, lang).slice(1)}.html`, dealPage(p, lang, products, cats));
        urls.push({ loc: dealPath(p, lang), en: dealPath(p, 'en'), he: dealPath(p, 'he'), lastmod: p.updatedAt || p.createdAt });
    }
    for (const c of cats) {
        const items = products.filter(p => p.category === c);
        await write(`${catPath(c, lang).slice(1)}.html`, categoryPage(c, lang, items, cats));
        urls.push({ loc: catPath(c, lang), en: catPath(c, 'en'), he: catPath(c, 'he'), lastmod: items.map(p => p.updatedAt || p.createdAt).sort().pop() });
    }
}

await write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.map(u => `  <url>
    <loc>${ORIGIN}${esc(u.loc)}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod.slice(0, 10)}</lastmod>` : ''}${u.en ? `
    <xhtml:link rel="alternate" hreflang="en" href="${ORIGIN}${u.en}"/>
    <xhtml:link rel="alternate" hreflang="he" href="${ORIGIN}${u.he}"/>` : ''}
  </url>`).join('\n')}
</urlset>
`);

await write('robots.txt', `User-agent: *
Disallow: /admin
Disallow: /api?go=

Sitemap: ${ORIGIN}/sitemap.xml
`);

// crawlable category links on the home page (the chips there are built by script)
const indexFile = join(SITE_DIR, 'index.html');
const index = await readFile(indexFile, 'utf8');
const links = cats.map(c => `<a href="${catPath(c, 'en')}" data-cat="${esc(c)}">${esc(c)}</a>`).join('\n                ');
await writeFile(indexFile, index.replace(/(<!-- category-links -->)[\s\S]*?(<!-- \/category-links -->)/,
    `$1\n                ${links}\n                $2`));

console.log(`${products.length} deals, ${cats.length} categories → ${urls.length} URLs in sitemap.xml`);
