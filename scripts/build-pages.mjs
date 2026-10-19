// Builds the pages Google indexes: one page per deal and per category, in English
// and Hebrew, the buying guides approved in admin (AI agency), plus sitemap.xml and
// robots.txt. Reads the live catalog from the API.
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
const ASSET_V = 24;
const CONTACT = 'orodriguez777@gmail.com';
const POLICY_DATE = { en: 'October 13, 2026', he: '13 באוקטובר 2026' };

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
        tgJoin: 'Join on Telegram', tgBandTitle: 'New deals every day on Telegram', tgBandText: 'Join our channel and get the best AliExpress finds straight to your phone. It’s free.',
        home: 'Home', slogan: 'Only the best deals', switchTo: 'עברית', switchLang: 'he',
        seeOn: 'See on AliExpress', categories: 'Browse by category', allDeals: 'All deals',
        priceNote: 'Price as listed on the AliExpress affiliate portal when we picked it. The price on the AliExpress site can differ and may even be cheaper, so check the final price there.',
        more: (c) => `More ${c} deals`,
        dealTitle: (p, price) => `${p}${price ? ` — ${price}` : ''} | www.Alidealer.com`,
        dealDesc: (p, price, c) => `${p}${price ? ` for ${price}` : ''} on AliExpress, hand-picked by www.Alidealer.com. See more ${c} deals.`,
        catH1: (c) => `${c} deals from AliExpress`,
        catTitle: (c) => `${c} deals from AliExpress | www.Alidealer.com`,
        catDesc: (n, c) => `${n} hand-picked ${c} finds from AliExpress, checked and sorted by www.Alidealer.com.`,
        disclosure: 'Affiliate disclosure: links on this site are AliExpress affiliate links. If you buy through them we may earn a small commission, at no extra cost to you.',
        privacy: 'Privacy policy',
        guide: 'Buying guide', guides: 'Buying guides', readMore: 'Details',
        priceDisclaimer: 'Price note: our prices come from the AliExpress affiliate portal and can differ from the AliExpress site, where the price may even be cheaper. We list only top-selling AliExpress products.',
    },
    he: {
        tgJoin: 'הצטרפו בטלגרם', tgBandTitle: 'דילים חדשים כל יום בטלגרם', tgBandText: 'הצטרפו לערוץ שלנו וקבלו את המציאות הכי טובות מ-AliExpress ישר לטלפון. בחינם.',
        home: 'דף הבית', slogan: 'רק הדילים הכי טובים', switchTo: 'English', switchLang: 'en',
        seeOn: 'לצפייה ב-AliExpress', categories: 'קטגוריות', allDeals: 'כל הדילים',
        priceNote: 'המחיר כפי שהופיע בפורטל השותפים של AliExpress כשבחרנו את המוצר. המחיר באתר AliExpress עצמו עשוי להיות שונה ואפילו זול יותר, לכן כדאי לבדוק את המחיר הסופי שם.',
        more: (c) => `עוד דילים: ${c}`,
        dealTitle: (p, price) => `${p}${price ? ` — ${price}` : ''} | www.Alidealer.com`,
        dealDesc: (p, price, c) => `${p}${price ? ` ב-${price}` : ''} ב-AliExpress, נבחר בקפידה ב-www.Alidealer.com. עוד דילים של ${c}.`,
        catH1: (c) => `דילים של ${c} מ-AliExpress`,
        catTitle: (c) => `דילים של ${c} מ-AliExpress | www.Alidealer.com`,
        catDesc: (n, c) => `${n} מוצרי ${c} נבחרים מ-AliExpress, שנבדקו ומוינו בשבילכם ב-www.Alidealer.com.`,
        disclosure: 'גילוי נאות: הקישורים באתר הם קישורי שותפים של AliExpress. אם תקנו דרכם ייתכן שנקבל עמלה קטנה, ללא כל עלות נוספת עבורכם.',
        privacy: 'מדיניות פרטיות',
        guide: 'מדריך קנייה', guides: 'מדריכי קנייה', readMore: 'לפרטים',
        priceDisclaimer: 'הערה לגבי מחירים: המחירים באתר לקוחים מפורטל השותפים של AliExpress ועשויים להיות שונים מהמחירים באתר AliExpress עצמו, שם המחיר עשוי להיות אפילו זול יותר. אנחנו מציגים רק את המוצרים הנמכרים ביותר ב-AliExpress.',
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
                <a class="lang tg-join" href="/api?tg=site" target="_blank" rel="noopener"><svg class="icon" viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>${t.tgJoin}</a>
                <a class="lang" href="${he ? enPath : hePath}" hreflang="${t.switchLang}" lang="${t.switchLang}">
                    <svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
                    ${t.switchTo}
                </a>
            </div>
        </div>
    </header>

    <div class="wrap">
${body}
${GUIDES.length ? `        <nav class="cat-nav guide-nav" aria-label="${t.guides}">
            <h2>${t.guides}</h2>
            <ul>
${GUIDES.map(g => `                <li><a href="${guidePath(g, lang)}">${esc((he && g.titleHe) || g.title)}</a></li>`).join('\n')}
            </ul>
        </nav>
` : ''}        <nav class="cat-nav" aria-label="${t.categories}">
            <h2>${t.categories}</h2>
            <ul>
                <li><a href="${homePath(lang)}">${t.allDeals}</a></li>
${cats.map(c => `                <li><a href="${catPath(c, lang)}">${esc(catName(c, lang))}</a></li>`).join('\n')}
            </ul>
        </nav>

        <section class="tg-band">
            <span class="tg-logo"><svg class="icon" viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg></span>
            <div><strong>${t.tgBandTitle}</strong><span>${t.tgBandText}</span></div>
            <a class="btn tg-btn" href="/api?tg=site" target="_blank" rel="noopener"><svg class="icon" viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>${t.tgJoin}</a>
        </section>

        <footer>
            <div class="foot-notes">
                <p>${t.disclosure}</p>
                <p>${t.priceDisclaimer}</p>
            </div>
            <span>© ${new Date().getFullYear()} www.Alidealer.com · <a href="${prefix(lang)}/privacy">${t.privacy}</a></span>
        </footer>
    </div>
    <script src="/join.js?v=2" defer></script>
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

// A buying guide written by the agency's SEO writer and approved in admin
const guidePath = (g, lang) => `${prefix(lang)}/guides/${g.slug}`;
let GUIDES = [];

function guidePage(g, lang, byId, cats) {
    const t = T[lang];
    const he = lang === 'he';
    const pick = (en, hebrew) => (he && hebrew) || en;
    const title = pick(g.title, g.titleHe);
    const path = guidePath(g, lang);
    const items = g.items.filter(i => byId.has(i.id)).map(i => ({ ...i, p: byId.get(i.id) }));
    const trail = [[t.home, homePath(lang)], [t.guide], [title]];
    const body = `${crumbs(lang, trail)}
        <article class="legal guide">
            <h1>${esc(title)}</h1>
            <p>${esc(pick(g.intro, g.introHe))}</p>
${items.map(({ p, why, whyHe }, n) => {
        const price = parsePrice(p.price);
        return `            <section class="guide-item">
                <a class="guide-img" href="${dealPath(p, lang)}">${p.image ? `<img src="${esc(p.image)}" alt="${esc(titleOf(p, lang))}" loading="lazy" referrerpolicy="no-referrer" width="300" height="300">` : ''}</a>
                <div>
                    <h2>${n + 1}. <a href="${dealPath(p, lang)}">${esc(titleOf(p, lang))}</a></h2>
                    <p>${esc(pick(why, whyHe))}</p>
                    <p class="guide-foot">${price ? `<span class="price">${esc(price.label)}</span>` : ''}
                        <a class="btn accent small" href="/api?go=${encodeURIComponent(p.id)}" target="_blank" rel="sponsored nofollow noopener">${t.seeOn}</a>
                        <a href="${dealPath(p, lang)}">${t.readMore}</a></p>
                </div>
            </section>`;
    }).join('\n')}
            <p>${esc(pick(g.outro, g.outroHe))}</p>
            <p class="deal-note">${t.priceNote}</p>
        </article>`;
    return layout({
        lang, path, altPath: guidePath(g, he ? 'en' : 'he'), image: items.find(i => i.p.image)?.p.image, cats,
        title: `${title} | www.Alidealer.com`,
        description: pick(g.description, g.descriptionHe),
        jsonLd: [breadcrumbLd(trail), {
            '@context': 'https://schema.org', '@type': 'Article', headline: title, inLanguage: lang,
            datePublished: g.createdAt, url: ORIGIN + path, publisher: { '@type': 'Organization', name: 'www.Alidealer.com' },
        }, {
            '@context': 'https://schema.org', '@type': 'ItemList',
            itemListElement: items.map((i, n) => ({ '@type': 'ListItem', position: n + 1, url: ORIGIN + dealPath(i.p, lang) })),
        }],
        body,
    });
}

// Privacy policy (also the policy URL for the Google Play listing). Keep it in
// step with what the site and the app actually do.
const mail = `<a href="mailto:${CONTACT}">${CONTACT}</a>`;
const POLICY = {
    en: {
        title: 'Privacy policy',
        effective: 'Effective ',
        intro: `This policy explains what information www.Alidealer.com (the website at alidealer.com and the www.Alidealer.com Android app, together "the service") collects, how it is used, and the choices you have. In short: we do not ask who you are, we do not use advertising or analytics trackers, and we do not sell or share personal information.`,
        sections: [
            ['Who we are', `www.Alidealer.com is a deals site run by an individual. It lists hand-picked products from AliExpress and links to them. For any privacy question, contact ${mail}.`],
            ['Information we collect', `<ul>
                <li><strong>No account, no sign-up.</strong> You can use the whole service without giving us your name, email, phone number or any other personal details.</li>
                <li><strong>Deal clicks.</strong> When you tap "See on AliExpress", we count that the deal was clicked and when. We do not record your IP address, device, location or any identifier with that count, so it cannot be linked to you. Clicks from search engine robots are not counted. Click counts are used only to see which deals are popular.</li>
                <li><strong>Technical logs.</strong> The service is hosted on Amazon Web Services (AWS) in the European Union. Like any web server, AWS may briefly keep standard technical logs (such as IP address, browser type and the page requested) to deliver pages and protect against abuse. We do not use these logs to identify or profile visitors.</li>
            </ul>`],
            ['Information stored on your device', `<ul>
                <li><strong>Language choice.</strong> If you switch between English and Hebrew, that choice is saved in your browser's local storage so the site remembers it. It never leaves your device.</li>
                <li><strong>Offline files.</strong> The app and the installed website keep a copy of the site's own pages and images on your device so they open faster and show a page when you are offline.</li>
                <li><strong>No cookies from us.</strong> The service itself does not set cookies and does not use advertising or analytics tools.</li>
            </ul>`],
            ['Third-party services', `<p>Some content is loaded from other companies, which receive your IP address and browser details when your device fetches it:</p>
            <ul>
                <li><strong>Google Fonts</strong> (fonts.googleapis.com) for the text fonts. See the <a href="https://policies.google.com/privacy" rel="noopener" target="_blank">Google privacy policy</a>.</li>
                <li><strong>AliExpress</strong> image servers for product photos.</li>
            </ul>
            <p>When you share a deal using the WhatsApp, Telegram or Facebook buttons, or your phone's share menu, the chosen service opens and its own privacy policy applies.</p>`],
            ['Affiliate links and AliExpress', `<p>Links to products are AliExpress affiliate links. When you follow one, you leave our service and go to AliExpress, which may set its own cookies to record that you came from us, so that we may earn a small commission if you buy. This costs you nothing extra. We do not receive your name, address, payment details or order contents from AliExpress; we only see commission totals. Your use of AliExpress is covered by the <a href="https://www.aliexpress.com/p/privacy-policy/index.html" rel="noopener" target="_blank">AliExpress privacy policy</a>.</p>`],
            ['How we use and share information', `We use the limited information above only to run the service, keep it secure and see which deals are popular. We do not sell, rent or trade personal information, and we do not share it with anyone except the hosting and service providers named above, or where the law requires it.`],
            ['Data retention', `Daily click counts are kept for 30 days, plus an overall count per deal. Neither contains any personal information. Your language choice and offline files stay on your device until you clear the site's data or uninstall the app.`],
            ['Security', `All traffic to and from the service is encrypted with HTTPS. Because we collect almost no personal information, there is very little that could be exposed.`],
            ['Children', `The service is not directed at children under 13, and we do not knowingly collect personal information from children.`],
            ['Your rights', `Depending on where you live (for example under the Israeli Privacy Protection Law or the EU GDPR), you may have the right to ask what information we hold about you, to correct it or to delete it. Since we do not keep personal information linked to you, there is usually nothing to return or delete, but you are welcome to write to ${mail} and we will reply within 30 days.`],
            ['Changes to this policy', `If this policy changes, the new version will be posted on this page with a new effective date.`],
            ['Contact', `Questions about this policy or your privacy: ${mail}.`],
        ],
    },
    he: {
        title: 'מדיניות פרטיות',
        effective: 'בתוקף מ-',
        intro: `מדיניות זו מסבירה איזה מידע אוסף www.Alidealer.com (האתר בכתובת alidealer.com ואפליקציית www.Alidealer.com לאנדרואיד, ביחד "השירות"), איך משתמשים בו ומה האפשרויות שלכם. בקצרה: אנחנו לא שואלים מי אתם, לא משתמשים בכלי מעקב של פרסום או סטטיסטיקה, ולא מוכרים או משתפים מידע אישי.`,
        sections: [
            ['מי אנחנו', `www.Alidealer.com הוא אתר דילים שמופעל על ידי אדם פרטי. האתר מציג מוצרים נבחרים מ-AliExpress ומקשר אליהם. לכל שאלה בנושא פרטיות אפשר לפנות אל ${mail}.`],
            ['איזה מידע אנחנו אוספים', `<ul>
                <li><strong>בלי חשבון ובלי הרשמה.</strong> אפשר להשתמש בכל השירות בלי למסור לנו שם, אימייל, מספר טלפון או כל פרט אישי אחר.</li>
                <li><strong>לחיצות על דילים.</strong> כשלוחצים על "לצפייה ב-AliExpress", אנחנו סופרים שהדיל נלחץ ומתי. אנחנו לא שומרים עם הספירה כתובת IP, סוג מכשיר, מיקום או כל מזהה אחר, כך שאי אפשר לקשר אותה אליכם. לחיצות של רובוטים של מנועי חיפוש לא נספרות. הספירה משמשת רק כדי לדעת אילו דילים פופולריים.</li>
                <li><strong>יומני שרת טכניים.</strong> השירות מאוחסן ב-Amazon Web Services (AWS) באיחוד האירופי. כמו בכל שרת אינטרנט, AWS עשויה לשמור לזמן קצר יומנים טכניים רגילים (כמו כתובת IP, סוג הדפדפן והדף שנטען) כדי להציג את הדפים ולהגן מפני שימוש לרעה. אנחנו לא משתמשים ביומנים האלה כדי לזהות גולשים או לבנות עליהם פרופיל.</li>
            </ul>`],
            ['מידע שנשמר במכשיר שלכם', `<ul>
                <li><strong>בחירת שפה.</strong> אם עברתם בין עברית לאנגלית, הבחירה נשמרת באחסון המקומי של הדפדפן כדי שהאתר יזכור אותה. היא לא יוצאת מהמכשיר שלכם.</li>
                <li><strong>קבצים לשימוש בלי אינטרנט.</strong> האפליקציה והאתר המותקן שומרים במכשיר עותק של הדפים והתמונות של האתר עצמו, כדי שייפתחו מהר יותר ויציגו דף גם כשאין חיבור.</li>
                <li><strong>אין עוגיות (Cookies) שלנו.</strong> השירות עצמו לא שומר עוגיות ולא משתמש בכלי פרסום או סטטיסטיקה.</li>
            </ul>`],
            ['שירותים של צד שלישי', `<p>חלק מהתוכן נטען מחברות אחרות, שמקבלות את כתובת ה-IP ופרטי הדפדפן שלכם כשהמכשיר טוען אותו:</p>
            <ul>
                <li><strong>Google Fonts</strong> (fonts.googleapis.com) עבור הגופנים. ראו את <a href="https://policies.google.com/privacy?hl=iw" rel="noopener" target="_blank">מדיניות הפרטיות של Google</a>.</li>
                <li>שרתי התמונות של <strong>AliExpress</strong> עבור תמונות המוצרים.</li>
            </ul>
            <p>כשמשתפים דיל דרך הכפתורים של WhatsApp, טלגרם או פייסבוק, או דרך תפריט השיתוף של הטלפון, נפתח השירות שבחרתם וחלה עליו מדיניות הפרטיות שלו.</p>`],
            ['קישורי שותפים ו-AliExpress', `<p>הקישורים למוצרים הם קישורי שותפים של AliExpress. כשנכנסים לקישור, יוצאים מהשירות שלנו ועוברים ל-AliExpress, שעשויה לשמור עוגיות משלה כדי לרשום שהגעתם דרכנו, וכך נוכל לקבל עמלה קטנה אם תקנו. זה לא עולה לכם שום דבר נוסף. אנחנו לא מקבלים מ-AliExpress את השם, הכתובת, פרטי התשלום או תוכן ההזמנה שלכם, אלא רק את סכומי העמלות. השימוש ב-AliExpress כפוף ל<a href="https://www.aliexpress.com/p/privacy-policy/index.html" rel="noopener" target="_blank">מדיניות הפרטיות של AliExpress</a>.</p>`],
            ['איך אנחנו משתמשים במידע ועם מי משתפים אותו', `אנחנו משתמשים במידע המצומצם שתואר למעלה רק כדי להפעיל את השירות, לשמור על אבטחתו ולדעת אילו דילים פופולריים. אנחנו לא מוכרים, משכירים או סוחרים במידע אישי, ולא משתפים אותו עם אף אחד מלבד ספקי האחסון והשירותים שצוינו למעלה, או כשהחוק מחייב זאת.`],
            ['כמה זמן נשמר המידע', `ספירות הלחיצות היומיות נשמרות 30 יום, לצד ספירה כוללת לכל דיל. אף אחת מהן לא כוללת מידע אישי. בחירת השפה והקבצים לשימוש בלי אינטרנט נשארים במכשיר שלכם עד שתמחקו את נתוני האתר או תסירו את האפליקציה.`],
            ['אבטחת מידע', `כל התעבורה אל השירות וממנו מוצפנת ב-HTTPS. מכיוון שאנחנו כמעט לא אוספים מידע אישי, אין כמעט מה שעלול להיחשף.`],
            ['ילדים', `השירות לא מיועד לילדים מתחת לגיל 13, ואנחנו לא אוספים ביודעין מידע אישי מילדים.`],
            ['הזכויות שלכם', `בהתאם למקום מגוריכם (למשל לפי חוק הגנת הפרטיות בישראל או תקנות ה-GDPR באיחוד האירופי), ייתכן שיש לכם זכות לבקש לעיין במידע שנשמר עליכם, לתקן אותו או למחוק אותו. מכיוון שאנחנו לא שומרים מידע אישי שמקושר אליכם, בדרך כלל אין מה להחזיר או למחוק, אבל תמיד אפשר לכתוב אל ${mail} ונחזור אליכם תוך 30 יום.`],
            ['שינויים במדיניות', `אם המדיניות תשתנה, הגרסה החדשה תפורסם בדף הזה עם תאריך תחילה חדש.`],
            ['יצירת קשר', `שאלות על המדיניות או על הפרטיות שלכם: ${mail}.`],
        ],
    },
};

function privacyPage(lang, cats) {
    const t = T[lang];
    const pol = POLICY[lang];
    const path = `${prefix(lang)}/privacy`;
    const trail = [[t.home, homePath(lang)], [pol.title]];
    const wrapP = (html) => html.trimStart().startsWith('<') ? html : `<p>${html}</p>`;
    const body = `${crumbs(lang, trail)}
        <article class="legal">
            <h1>${pol.title}</h1>
            <p class="effective">${pol.effective}${POLICY_DATE[lang]}</p>
            <p>${pol.intro}</p>
${pol.sections.map(([h, html]) => `            <h2>${h}</h2>\n            ${wrapP(html)}`).join('\n')}
        </article>`;
    return layout({
        lang, path, altPath: `${prefix(lang === 'he' ? 'en' : 'he')}/privacy`, cats,
        title: `${pol.title} | www.Alidealer.com`,
        description: pol.intro.split('. ')[0] + '.',
        jsonLd: [breadcrumbLd(trail)],
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

// guides the owner approved in admin (a failed fetch just means no guides this run);
// fetched first so every page can link to them
const guides = await fetch(API, { method: 'POST', body: JSON.stringify({ action: 'agency-guides' }) })
    .then(r => r.json()).then(d => d.guides || []).catch(() => []);
GUIDES = guides;

// start clean so pages of deleted deals don't linger locally
for (const dir of ['deal', 'category', 'guides', 'he']) await rm(join(SITE_DIR, dir), { recursive: true, force: true });

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

const byId = new Map(products.map(p => [p.id, p]));
for (const g of guides) {
    for (const lang of ['en', 'he']) {
        await write(`${guidePath(g, lang).slice(1)}.html`, guidePage(g, lang, byId, cats));
        urls.push({ loc: guidePath(g, lang), en: guidePath(g, 'en'), he: guidePath(g, 'he'), lastmod: g.createdAt });
    }
}

for (const lang of ['en', 'he']) {
    await write(`${prefix(lang).slice(1)}${lang === 'he' ? '/' : ''}privacy.html`, privacyPage(lang, cats));
    urls.push({ loc: `${prefix(lang)}/privacy`, en: '/privacy', he: '/he/privacy', lastmod: '2026-10-13' });
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
Disallow: /api?tg=

Sitemap: ${ORIGIN}/sitemap.xml
`);

// crawlable category links on the home page (the chips there are built by script)
const indexFile = join(SITE_DIR, 'index.html');
const index = await readFile(indexFile, 'utf8');
const links = cats.map(c => `<a href="${catPath(c, 'en')}" data-cat="${esc(c)}">${esc(c)}</a>`).join('\n                ');
await writeFile(indexFile, index.replace(/(<!-- category-links -->)[\s\S]*?(<!-- \/category-links -->)/,
    `$1\n                ${links}\n                $2`)
    .replace(/(<!-- guide-links -->)[\s\S]*?(<!-- \/guide-links -->)/, `$1\n${guides.map(g =>
        `                <a href="${guidePath(g, 'en')}" data-en="${esc(g.title)}" data-he="${esc(g.titleHe || g.title)}">${esc(g.title)}</a>`).join('\n')}\n                $2`)
    .replace(/<nav class="cat-nav guide-nav"( hidden)?/, `<nav class="cat-nav guide-nav"${guides.length ? '' : ' hidden'}`));

console.log(`${products.length} deals, ${cats.length} categories, ${guides.length} guides → ${urls.length} URLs in sitemap.xml`);
