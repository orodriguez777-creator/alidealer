# AI marketing agency for alidealer.com

## Context
The user wants "an agency of AI agents to advertise my site", posting on all platforms. Approval mode wasn't chosen → default: **agents draft, the user approves in admin, approved posts publish automatically** (one "Autopilot" switch makes it fully automatic later).
The site already has the raw material: catalog (`data/products.json`, newest first, `title`/`titleHe`/`image`/`price`/`category`), share links with OG previews (`shareUrl()` → `/d/[he/]<id>`), a post writer (`handlePost`, functions/api/index.mjs:267), the `gemini()` JSON helper (:393), click stats (`handleStats` :188), a daily scheduled job (:724), and an admin Suggestions tab whose UI pattern we copy (site/admin.js:318-446).

## Platform reality (what can post automatically)
| Channel | How | Needs from the user |
|---|---|---|
| Telegram channel | Bot API `sendPhoto` — **automatic** | Bot token from @BotFather (secret box), bot added as channel admin |
| Facebook Page | Graph API `/{page}/photos` — **automatic** | Meta developer app + long-lived Page token (I guide step by step) |
| Instagram (Business, linked to the Page) | Graph API media → media_publish — **automatic**; links not clickable → "link in bio" | Same Meta token |
| Threads | Threads API — **automatic** | Threads token from the same Meta app |
| Pinterest | API v5 `/pins` — **automatic after Pinterest approves API access** (days) | Pinterest token + board |
| X, TikTok, WhatsApp, LinkedIn, Reddit | **Ready-to-post drafts** with Copy / Share buttons (X API posting is paid; TikTok's API needs an app audit; WhatsApp channels have no API). TikTok/Reels drafts reuse the /ads videos | Nothing |
| Google (SEO articles) | Weekly guide articles, EN+HE, published as static pages | Nothing |

## The agents (one scheduled pipeline, Gemini via the OpenKBS proxy — a few cents of credits/day)
1. **Strategist** – daily 05:00 UTC: picks N deals (default 3) from catalog + click stats, avoids repeats within 14 days, mixes categories, notes a daily theme.
2. **Copywriter** – per deal: text for each enabled channel × language (EN, HE), respecting each platform's style/length, hashtags, share link with a channel tag (`/d/<id>?s=tg`).
3. **Editor** – checks every draft: no invented claims, the existing price disclaimer ("price may differ on AliExpress"), affiliate disclosure, length limits; rewrites or drops failures.
4. **Publisher** – hourly: posts approved drafts whose time slot has passed (default slots 09:00 / 13:00 / 19:00 Israel time); records post IDs/errors.
5. **SEO writer** – weekly: one guide draft ("Best kitchen gadgets under $10"), EN+HE, built only from catalog deals.
6. **Analyst** – weekly: clicks per channel/deal (via the `?s=` tag), shown in admin and fed back to the Strategist.

## Implementation
- **functions/api/lib.mjs (new)**: move shared helpers out of index.mjs (`s3`, a `getJson/putJson` pair, `gemini`, `json`, `loadProducts`, `shareUrl`) so both modules use them.
- **functions/api/agency.mjs (new)**: state doc `data/agency.json` `{settings, drafts[], posted[], guides[], reports[], lastRun}`; agent prompts; `runDaily`, `runHourly`, `runWeekly`; channel publishers (telegram/facebook/instagram/threads/pinterest), each skipped if its secret is missing. Re-read the doc before writing (pattern from `refreshSuggestions`).
- **functions/api/index.mjs**: schedule becomes hourly; handler runs suggestions only at 04 UTC, agency every hour. New admin actions: `agency`, `agency-settings`, `agency-draft-save|approve|skip`, `agency-run-now`, `agency-publish-now`, `agency-test-channel`. Public `agency-guides` (approved guides, for the page build). Share links accept `?s=` → stored in click events for attribution.
- **openkbs.json**: api schedule `cron(5 * * * ? *)`, timeout 120 → 300.
- **site/admin.html / admin.js / styles.css**: new "Agency" tab (badge = drafts waiting): drafts grouped by deal with per-channel/language editable text, image, Approve / Skip / Copy / Share; channel connection status + test buttons; settings (posts/day, slots, languages, channels, Autopilot, Pause); weekly report.
- **scripts/build-pages.mjs**: fetch `agency-guides`, render `/guides/<slug>` + `/he/guides/<slug>` with existing `layout()`/`cardsHtml()`, add to sitemap. Guides go live when the site is rebuilt (ask me "publish the guides", or the user can set a weekly `/routine`).
- Secrets only via the studio secret box into `functions/api/.env` (TELEGRAM_BOT_TOKEN, META_PAGE_TOKEN, THREADS_TOKEN, PINTEREST_TOKEN).

## Rollout
1. Core agents + Agency tab + Telegram + manual-channel drafts → deploy, generate first batch.
2. Facebook + Instagram + Threads once the user creates the Meta app (guided).
3. Pinterest after approval. 4. SEO guides + build. 5. Analyst/attribution report.

## Verification
- `agency-run-now` from admin → drafts appear in EN/HE for every channel; spot-check Editor output.
- `agency-test-channel` per connected channel → a real test post (user confirms on Telegram/Facebook/Instagram).
- Approve a draft with a past slot → `agency-publish-now` → posted, ID recorded; then confirm the hourly schedule publishes on its own (`openkbs fn logs api`).
- Click a `?s=tg` share link → event counted under Telegram in the report.
- Build pages → `/guides/...` live, in sitemap.xml (curl with --resolve).
