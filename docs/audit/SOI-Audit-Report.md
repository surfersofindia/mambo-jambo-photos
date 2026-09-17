# Surfers of India · Photos — Functional Audit, Rebrand System & Roadmap

**Scope:** `photos.surfersofindia.com` (public) and `/admin.html` (crew studio)
**Method:** Read every line of the deployed code (`index.html`, `site.css`, `premium.css`, `soi-brand.css`, `app.js`, `effects.js`, `nav.js`, `admin.html`, `admin-theme.css`, `admin.js`, `config.js`), probed the Worker API, and drove both pages in a real browser at 1024 px and 375×812 px — including the selfie → match → results → lightbox flow (with a synthetic image), the admin upload queue, edit modal and unsaved-change guard.
**Not tested:** anything behind crew login that requires the real API (dashboard data, deletes, verification queue). Those findings are from code reading and are marked *(code)*.
**Deliverable files:** `patches/soi-tokens.css`, `patches/soi-stamps.svg`, `patches/app.fixes.js`, `patches/admin.fixes.js`.

---

## 0 · Executive summary

### What the product actually is
The brief describes a search/filter photo gallery. The live product is narrower and smarter: **a selfie‑driven face‑match store.** Guest picks a session → uploads a selfie → sees watermarked matches → pays ₹700 via Cashfree → downloads originals. There is no date/spot filter grid, no EXIF panel, no share button, and no masonry — those are roadmap items, not bugs. The audit below tests what exists and specifies what's missing.

### State of the codebase
Better than most indie photo platforms. Vanilla JS, no framework, `<dialog>` for modals, `history.pushState` for the results view, signed-URL refresh, retry-with-backoff uploads, typed-confirm deletes, dirty-form guards, keyboard review shortcuts, reduced-motion respected. The bones are good. The problems are (a) **two disconnected visual identities**, (b) a handful of **real mobile/upload bugs**, and (c) **zero brand illustration** anywhere.

### The single biggest design finding
The admin already runs on the linocut palette (`--cream:#f2ecdb --sand:#e7dcc2 --coral:#b5502f --ink:#2b2018`) and the public page even ships `<meta name="theme-color" content="#F2ECDB">` — but the public site itself renders in a **clinical blue/white** (`#f5f8fb`, `#264a6b`). Guests see a navy SaaS; the crew sees a warm studio. The rebrand is mostly *finishing a migration that was already started.*

### Top 10 findings (severity-ordered)

| # | Where | Finding | Severity |
|---|---|---|---|
| 1 | Admin upload | **12 parallel uploads + fixed 120 s XHR timeout** → on any uplink under ~3 Mbps every file times out, retries, fails. A 300-photo session cannot be published from a beach hotspot. | 🔴 Blocker |
| 2 | Admin upload | 12 concurrent full-frame canvas decodes of 24 MP JPEGs (~1 GB RGBA) → Safari/Chrome mobile kills the tab mid-batch. | 🔴 Blocker |
| 3 | Admin | `notifyCrew()` writes to a notice **above the tabs**; every action result is off-screen once you scroll. Crew never sees "Cover updated / Delete failed". | 🟠 High |
| 4 | Public results | Tapping ♥ **re-renders all tiles** (`renderGallery()` on every toggle) — shimmer flashes, scroll jumps, 40 images re-requested. | 🟠 High |
| 5 | Public mobile | "Unlock all photos ₹700" is a small inline button that scrolls away; no sticky CTA on the one screen that makes money. | 🟠 High |
| 6 | Public lightbox | Tap-to-zoom works, but **zoomed image cannot be panned** (`pointermove` bails when `.is-zoomed`). No pinch. | 🟠 High |
| 7 | Admin | HEIC (iPhone default, Mac Photos export) is rejected outright. | 🟠 High |
| 8 | Both | Inputs under 16 px (`#sessionFilter` 13 px, admin fields 14 px) → iOS auto-zooms on focus. | 🟡 Med |
| 9 | Both | Sub-44 px targets: consent checkbox 17 px, admin Remove 55×26, Clear 90×26, Sign out 84×34, `.text-button`s ~30 px tall. | 🟡 Med |
| 10 | Admin | `admin.html` ships a 27 KB **dark theme inline** that `admin-theme.css` then overrides rule-by-rule with `!important`. Two themes, one page. | 🟡 Med (tech debt) |

---

## 1 · Design tokens & CSS implementation

### 1.1 Extracted palette (contrast-verified)

Sampled from the linocut kit and checked against WCAG AA. Raw Slate and raw Ochre are **decorative only** — they fail as text.

| Token | Hex | Role | Contrast |
|---|---|---|---|
| `--soi-terracotta` | `#A8482C` | Primary: CTAs, active states, focus ring, badges, eyebrow | 4.9:1 on linen · white on it 5.8:1 ✅ |
| `--soi-terracotta-deep` | `#8A3A22` | Hover / pressed / danger | white on it 7.8:1 ✅ |
| `--soi-terracotta-tint` | `#F4E4DC` | Selected rows, soft fills | — |
| `--soi-slate` | `#7B9BB4` | Secondary (decorative): board silhouette, tag fills | white on it **2.9:1 ❌** — never text |
| `--soi-slate-deep` | `#4E6F88` | Secondary buttons (solid), metadata text | 4.5:1 on linen · white on it 5.3:1 ✅ |
| `--soi-slate-tint` | `#E3ECF2` | Filter chips, active toggles | — |
| `--soi-ochre` | `#B9975B` | Hairline borders, dividers, hover fills, stamp fill | 2.3:1 — decorative only |
| `--soi-ochre-deep` | `#8C6E3A` | Ochre as bold/large text | 4.0:1 (large text only) |
| `--soi-sand` | `#E7DCC2` | Card outlines, tag backgrounds, ticker | — |
| `--soi-linen` | `#F2ECDB` | **Body background** (replaces `#f5f8fb` and `#fff`) | — |
| `--soi-surface` | `#FBF8F0` | Cards, inputs, dialogs (one step lighter than canvas) | — |
| `--soi-umber` | `#2B2018` | Headings, body copy, dark footer/how-it-works | 13.5:1 on linen ✅ |
| `--soi-umber-soft` | `#5C4F43` | Muted copy | 6.7:1 ✅ |
| `--soi-coral` | `#B66B78` | Favourite ♥ only | decorative |

**Implementation strategy:** `patches/soi-tokens.css` re-maps the *existing* variable names (`--ocean`, `--bg`, `--marker`, `--coral`…) onto the new tokens, so 90 % of both stylesheets recolour with **one added `<link>`** and zero selector edits. Load it last in `<head>` on both pages.

### 1.2 Typography

| Role | Face | Spec |
|---|---|---|
| Display (h1/h2, section titles, metric values) | **Fraunces** (Google, variable) — a soft, slightly hand-cut serif that echoes the linocut lettering without being a novelty font | 500 weight, `letter-spacing:-.01em`, opsz auto |
| UI / body | Plus Jakarta Sans (keep) | 400/500/600, 15 px body, 1.65 line-height |
| Eyebrows / admin labels | Plus Jakarta Sans | 11 px, 600, tracking +1.5 px, **sentence case, not caps** on badges |

Add to both `<head>`s:
```html
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;1,9..144,500&display=swap" rel="stylesheet">
```
Self-host both families later (`font-display:swap` is already set; hosting removes the third-party round trip on LCP).

### 1.3 Shape, depth, motion

```css
--radius-card:16px;  --radius-btn:12px;  --radius-chip:999px;  --radius-input:10px;
--shadow-card:0 1px 2px rgba(43,32,24,.05),0 14px 34px -22px rgba(43,32,24,.25);
--shadow-card-hover:0 2px 4px rgba(43,32,24,.06),0 24px 48px -24px rgba(43,32,24,.32);
--shadow-float:0 18px 48px -16px rgba(43,32,24,.45);      /* toasts, bottom bar */
--ease-out:cubic-bezier(.22,1,.36,1);  --ease-spring:cubic-bezier(.34,1.4,.64,1);
--duration-fast:140ms; --duration-base:240ms; --duration-slow:420ms;
```
Shadows are tinted **umber, not black** — grey shadows on linen look dirty.

**Micro-interaction states (all in `soi-tokens.css`):**

| State | Primary button | Card | Chip | Photo tile |
|---|---|---|---|---|
| Rest | terracotta, umber-tinted shadow | surface, sand border | sand fill, ochre hairline | sand placeholder |
| Hover | terracotta-deep, `translateY(-1px)`, wider shadow | ochre border, hover shadow | sand-deep | `scale(1.03)` on image only |
| Active/press | `scale(.985)`, shadow off | — | — | `scale(.99)` |
| Focus-visible | 2 px terracotta ring, 3 px offset | ring on the card | ring | ring on the tile button |
| Disabled | sand-deep fill, umber-soft text (no opacity — reads as "unavailable" not "broken") | — | — | — |
| Selected/pressed | — | terracotta-tint fill + 1 px terracotta ring | slate-deep fill, white text | ♥ = coral |
| Busy | trailing glyph becomes an animated **fin** | — | — | shimmer |

### 1.4 Custom components

**Wave loader** (replaces the near-invisible grey "tide" blobs on the matching stage):
```html
<svg class="soi-loader" viewBox="0 0 112 64" aria-hidden="true">
  <path class="crest" d="M6 44c14-20 28-20 42-2 6-8 14-14 24-16-10 8-16 18-18 30 18-4 34-2 52 6"/>
  <path class="fin" d="M56 54c0-10-4-18-10-24 8 2 14 10 16 20-2 1-4 3-6 4z"/>
</svg>
```
The crest draws itself in (`stroke-dashoffset`) while a terracotta fin slides across it. Respects `prefers-reduced-motion`.

**Empty state:**
```html
<div class="soi-empty">
  <svg><use href="soi-stamps.svg#stamp-starfish"/></svg>
  <strong>No photos in this session yet.</strong>
  <p>The crew is still uploading. Check back after your surf.</p>
</div>
```

**Toast** — see `admin.fixes.js` FIX A1. Umber card, linen text, terracotta/sunburst/coral left rule by kind, stamp icon.

**Stamp badge / chip:**
```html
<span class="chip chip--stamp chip--slate"><svg><use href="soi-stamps.svg#stamp-board"/></svg>Mulki Beach</span>
```

### 1.5 Illustration placement rules

Principle: **stamps live on chrome, never on photographs.** The photos are the product; the illustrations are the packaging.

| Motif | Where it goes | How | Where it must NOT go |
|---|---|---|---|
| **Wave crest** | Hero (large, ochre, 8 % opacity, bottom-right, behind copy) · loader · footer wave (replace the current clip-path zigzag) · **corner watermark stamp** on paid previews (11 % of width, 82 % alpha, linen on shadow) · toast "info" icon | Inline `<use>`; CSS mask for the footer | Over gallery thumbnails |
| **Single fin** | Busy-button spinner · active step marker in the finder (01/02/03) · admin "uploading" row status | CSS `clip-path` fin in `.is-busy span` | — |
| **Longboard** | Session chip icon (beach / break) · admin session card status column · "your board" tag (roadmap) | 16 px chip icon, slate | As a large decorative — it reads as a surf-shop logo |
| **Starfish** | Broken-image tile fallback · "No photos found" · "No matches this time" | `.soi-empty`, `figure.is-broken::before` mask | — |
| **Seashell** | "No favourites yet" empty state | `.soi-empty` | — |
| **Coral** | Matching stage secondary art · admin "processing / indexing" badge icon · error toast icon | 16–88 px, ochre | — |
| **Split coconut** | Pricing card corner stamp · "Unlocked / payment received" notice · refund page | 64 px, terracotta, top-right of card, 20 % overlap outside the card edge | — |
| **Hibiscus block** | The one place for a **solid** stamp: the admin login hero corner, the results-page "Your moments." heading ornament, 404 page | 72 px terracotta block, rotate −6° | Anywhere near photos |
| **Sunburst block** | Success toast icon · "Published" session badge · payment-confirmed hero | 20 px in badges, 72 px in confirmations | — |
| **Wave pattern (tile)** | Admin drop-zone background (ochre, 28 % alpha), nothing else | `background:url(soi-stamps.svg#pattern-wave)` | Page backgrounds — it will fight the photos |

**Watermark policy:** keep the low-alpha diagonal text lattice (it's what stops cropping) but drop its alpha to .16/.28 and add the wave-crest corner stamp. Previews then look *branded* rather than *sampled* — guests share them to Instagram, which is free marketing (see `admin.fixes.js` FIX A8).

`patches/soi-stamps.svg` contains placeholder geometry for every motif with stable ids; replace each `<symbol>` body with the traced originals from the kit (Illustrator Image Trace → "Black and White Logo" → export 0 0 100 100 paths).

---

## 2 · Interactive QA matrix

Legend: ✅ verified in browser · 🧪 verified by code reading · ❌ confirmed bug · ⚠️ risk / missing state

### 2.1 Public — landing & finder

| Element | Expected behaviour | Edge case / bug risk | Recommended fix |
|---|---|---|---|
| Sticky header + hamburger (≤650 px) | Opens nav, closes on link/Escape/outside click, resets at ≥651 px | ✅ Works. Toggle target is 46×40 (`nav.js`, `.nav-toggle`) | Pad to 48×48 |
| Reading-progress bar | 2 px `--sky` bar tracks scroll | ✅ Works; becomes slate-deep with tokens | — |
| Scroll-reveal sections (`effects.js:55`) | Sections fade up on first intersection | ❌ **Flash:** section is visible → snaps to opacity 0 → fades in. Caught it on screenshot as a fully empty "How it works" block | `app.fixes.js` FIX 6 — pre-hide with a class only when motion is enabled, `fill:'backwards'` |
| Session list skeleton | Two 92 px skeleton rows keep the card height | ⚠️ Real list is 1 row (currently 1 session) → 90 px shift after load | Render the skeleton row count from `sessionStorage` cache of the last session count |
| Session radio cards | Click selects, ✓ appears, "Continue" enables | ✅ Works. Label is the hit-target (good). | — |
| Session search (`#sessionFilter`) | Shown when >4 sessions; filters by title/beach/date | 🧪 Fine. **13 px font → iOS zoom on focus** | 16 px (tokens file forces it) |
| Step indicator 01/02/03 | Shows progress | ⚠️ Not clickable; only "← Change session" text link (30 px tall) goes back | FIX 8: make completed steps clickable; `.text-button` gets `min-height:44px` |
| "Continue with this session" | → selfie stage, scrolls finder into view, focuses "Change session" | ✅ Works. Stage swap animates 400 ms | — |
| Selfie upload zone | Accepts JPG/PNG/WebP ≤10 MB, previews, downsamples to 1600 px | ✅ Preview shown, `findMatches` stays disabled until consent ✅ | Add drag-and-drop on desktop (`drop` listener missing on `.upload-zone`) |
| "📷 Take a selfie now" | Sets `capture=user`, opens camera, removes attr after 1 s | 🧪 Only shown on `pointer:coarse` (correct) | — |
| Consent checkbox | Required, enabled only in selfie stage | ✅ Works. **17×17 px** box; label text is the real target | 22 px box + 44 px row (tokens file) |
| "Find my photos" submit | Disabled until file + consent; matching stage with loader; 90 s timeout; cancel | ✅ Works end-to-end (synthetic image → "We could not find a clear face"). | Loader nearly invisible → wave loader (FIX 5) |
| Matching-stage layout | Card should keep height | ⚠️ Selfie stage ~520 px → matching ~380 px → **CLS on every search** | `#matchingStage{min-height:var(--stage-h)}` set from the selfie stage height before swapping |
| Cancel search | Aborts fetch, returns to selfie stage with message | 🧪 Works via `AbortController` | — |
| Double-submit | Second submit ignored while `searchController` set | 🧪 Guarded | — |
| Hash nav links while searching | Any `#` link aborts the search and shows the finder | 🧪 Works — but also fires for `#privacy` inside the consent label, **cancelling a running search when a guest reads the privacy link** | Exclude links inside `#searchForm` from that handler |
| Resume notice (30-day gallery) | Shows if `mjGallery` in localStorage is <30 d old | 🧪 Works; button gets `is-busy` | — |

### 2.2 Public — results, lightbox, checkout

| Element | Expected behaviour | Edge case / bug risk | Recommended fix |
|---|---|---|---|
| Results view + Back button | `pushState` so browser Back returns to finder | ✅ Works | — |
| Gallery grid | 3-col desktop / 2-col mobile, 4:3 tiles, shimmer until decoded | ✅ Works; no CLS on image load | Consider `grid-template-columns:repeat(auto-fill,minmax(180px,1fr))` — 3 fixed columns look sparse ≥1280 px |
| Thumbnail error | Refresh signed links, else message | ❌ **Alt text paints across the tile** ("This photo link has expired…") | FIX 2 — `figure.is-broken` + starfish stamp + tap-to-retry |
| ♥ Favourite | Toggle, count updates, focus retained | ❌ **`renderGallery()` rebuilds all tiles** on every tap; favourites are lost on refresh/redirect | FIX 1 — in-place toggle + `sessionStorage` persistence |
| Favourite button size | ≥44 px | ⚠️ 44 px desktop, **40 px mobile** (`site.css:291`) | 48/44 (tokens file) |
| "Favourites" filter | Shows only ♥ tiles; empty message | ✅ Works | Empty state → seashell stamp |
| "Unlock all photos ₹700" | Opens checkout dialog | ✅ Works. ❌ **Not sticky; scrolls away on mobile** | FIX 4 — fixed bottom action bar (unlock + ♥ filter), safe-area padded |
| Lightbox open/close | `showModal`, spring-in via `@starting-style`, focus on × | ✅ Opens, focus on close, count "1 of 7" ✅. Escape: could not verify with synthetic keys — native `<dialog>` should close; FIX 3 adds an explicit handler | — |
| ← → keys / buttons | Wrap around | ✅ Works (1 → 3 of 7 on two presses) | — |
| Swipe | 40 px horizontal drag → neighbour | 🧪 Works; live `translateX` follows finger | Add velocity: a fast 20 px flick should also advance |
| Tap-to-zoom | 2.2× around tap point | ❌ **Cannot pan while zoomed**; no pinch | FIX 3 — pan + pinch + tap-out |
| Lightbox on phones | Full-bleed, controls in safe area | ✅ Prev/Next 167×44, × 44×44 | Raise controls to 48 px; hint text mentions "← →" keys on a phone — make it pointer-aware |
| Image transition between photos | 420 ms fade/scale | ✅ | Preloads neighbours ✅ |
| Download (unlocked) | Per-photo `<a download>` in caption + lightbox | 🧪 Works | No "Download all (ZIP)" — see roadmap |
| Share | — | ⚠️ **No share button at all** | Roadmap: Web Share API on the lightbox (share the watermarked preview + deep link) |
| Metadata/EXIF | — | ⚠️ None. Only "MOMENT 01 · PREVIEW" | Roadmap: time-of-day + session conditions chip under each tile |
| Checkout dialog | Phone `[6-9]\d{9}` validated twice, email optional, Cashfree SDK lazy-loaded, dialog closed before Drop-in (top-layer conflict handled) | 🧪 Excellent. `paying` flag blocks double-pay ✅ | Show the amount **and** photo count in the dialog title ("12 photos · ₹700") |
| UPI redirect return | `?order_id=` → verify → unlocked gallery; "lost search" case explained | 🧪 Handled, including new-tab return | — |
| Signed-URL refresh | 27/40 min timers; refresh on image error, throttled 15 s | 🧪 Sound | — |
| Motion toggle (footer) | Pause/resume, persisted | 🧪 Works; hidden when OS reduced-motion | — |

### 2.3 Admin — login, tabs, upload

| Element | Expected behaviour | Edge case / bug risk | Recommended fix |
|---|---|---|---|
| Login form | POST password → token in `sessionStorage`; 401/429/timeout messages | ✅ UI verified (not submitted — a wrong-password test risks the 15-min lockout for the crew) | Add "Forgot password → WhatsApp the other crew member" copy; see §4 for token hardening |
| Show/Hide password | Toggles type, `aria-pressed` | ✅ 59×36 target | 44 px |
| Hidden username `crew` | Lets password managers save the login | ✅ Good practice | — |
| Tabs | Click + ←/→/Home/End roving tabindex, `aria-selected` | ✅ Solid | Tab font 10 px on mobile → 13 px |
| Session fields | Required, defaults (today, "Morning surf", "Mulki Beach", ₹700) | ⚠️ **14 px inputs → iOS zoom.** Defaults invite publishing the wrong name | 16 px; make title default empty with the placeholder, keep beach + price |
| Drop zone | Drag/drop + Choose; filters unsupported; status | ✅ 4 JPG + 1 CR3 → "4 selected, 1 left out" ✅ but ❌ **styled red as an error** | FIX A11 — warning style |
| HEIC / RAW | — | ❌ **HEIC rejected** (iPhone default). RAW rejected (fine — say so up front) | FIX A4 — accept HEIC, transcode client-side |
| File queue rows | Thumb, name, size, Remove; scrolls to Publish | ✅ Works. **Remove 55×26, Clear 90×26** | 44 px (tokens) |
| Selected but unpublished files | Should survive accidental navigation | ❌ `beforeunload` only fires while uploading; "← Back to site" silently drops 300 selected photos | FIX A5 |
| Publish batch | Create draft → upload (12 streams) → publish → summary | 🧪 ❌ **Fixed 120 s per-file timeout**; ❌ **12 concurrent canvas decodes**; ❌ **no cancel** | FIX A2, A9, A3 |
| Progress bar | %, KB/s, ETA | 🧪 Works | Add "n of N photos" and per-row ticks are already there ✅ |
| Partial failure | Publishes what succeeded, says which failed | 🧪 Good | Offer "Retry failed" inline (exists only in Upload-more) |
| Token expiry mid-batch | Should refresh or pause | 🧪 ⚠️ XHR gets 401 → non-retryable → every remaining file fails, then `/publish` 401 kicks to login | Refresh token before a batch; treat 401 as "pause + re-auth + resume" |

### 2.4 Admin — sessions, modals, review *(code)*

| Element | Expected behaviour | Edge case / bug risk | Recommended fix |
|---|---|---|---|
| Dashboard poll | Every 8 s while indexing, paused when hovering/focused/dialog open/hidden tab | 🧪 Thoughtful | — |
| Metric cards | Totals | 🧪 "Active Sessions" counts `published` only — label it "Published" | — |
| Session card actions (7 buttons) | Publish / Restore / View / Upload more / Edit / Retry / Re-index / Delete | ⚠️ 7 pills in a wrap row; hierarchy flat; **10 px text** | Primary (View, Upload more) as buttons; the rest under a "⋯ More" menu |
| Publish/Restore/Re-index | Disable → request → reload | 🧪 Results go to `notifyCrew` → **off-screen notice** | FIX A1 toasts |
| Delete session | Typed-name confirm | 🧪 ✅ Excellent — but confirm dialog **focuses the destructive button** | FIX A6 |
| View photos modal | Grid, cover picker, per-photo delete, indexing notes | 🧪 Works. No multi-select | Roadmap: batch select/delete/re-index |
| Photo delete | Confirm → DELETE → card removed | 🧪 Works; button hidden until hover on pointer devices (touch keeps it) ✅ | — |
| Edit modal | Snapshot → dirty check on backdrop/Escape/× | ✅ Verified: "Discard changes?" appears | — |
| Upload more | Duplicate detection (replace/skip/rename), retry failed, Escape blocked while busy | 🧪 Very good | Same timeout/decode fixes apply |
| Review queue (faces) | Lazy canvas crops, zoom slider, Y/N/S | 🧪 Good; ⚠️ **no visible indication of which card Y/N/S targets** | FIX A7 |
| Rescan / Retrain | Disabled while running | 🧪 ✅ | Show last-run time |
| API / CDN status | — | ⚠️ **None** | Roadmap: health pill in topbar |
| Race: rapid tab switching while queues load | `reviewQueueVersion`/`linkQueueVersion` guards | 🧪 ✅ Handled | — |
| Race: dashboard reload after sign-out | `requestToken !== getToken()` guard | 🧪 ✅ Handled | — |

### 2.5 Performance & headers

| Check | Result |
|---|---|
| Brotli on HTML/CSS/JS | ✅ (`app.js` 32 KB → 9 KB) |
| `Cache-Control` on JS/CSS | ⚠️ `no-cache, must-revalidate` — every visit revalidates 7 files. Fingerprint filenames (`app.3f2a.js`) and set `max-age=31536000, immutable`; keep HTML `no-cache` |
| Hero image | 155 KB WebP, `fetchpriority=high` ✅ — add `<link rel=preload as=image>` + a 640 px `srcset` for phones |
| Fonts | Google Fonts CSS blocks first paint; self-host |
| CSP | Only `upgrade-insecure-requests`. With Cashfree lazy-loaded you can ship `script-src 'self' https://sdk.cashfree.com; frame-src https://*.cashfree.com; img-src 'self' blob: data: https://mambo-jambo-photo-api.surfersofindia.workers.dev; connect-src 'self' https://mambo-jambo-photo-api.surfersofindia.workers.dev https://*.cashfree.com` |
| `x-frame-options: DENY`, HSTS, `nosniff`, `referrer-policy: no-referrer` | ✅ |
| Admin `noindex` | ✅ — but the public footer links "Crew login ↗" to `admin.html`; move it to the About page or drop it |
| Dead CSS | 27 KB inline dark theme in `admin.html` overridden by `admin-theme.css` (FIX A12) |

---

## 3 · Admin dashboard breakdown (`admin.html`)

The crew's job on a session day: **shoot → dump 200–600 files from a card → name the session → publish → watch indexing → (occasionally) review borderline faces.** Everything below is ranked by how much time it saves on that loop.

### 3.1 Upload workflow (the daily path)

1. **Make uploads survive Indian mobile networks** *(FIX A2)*. Replace the wall-clock timeout with a **30 s stall timeout** (abort only if no bytes moved) and let concurrency adapt to measured throughput (2 → 12 workers). Expected result: a 4 GB session on a 5 Mbps hotspot publishes in ~2 h unattended instead of failing at file #13.
2. **Add "Cancel upload"** *(A3)* inside the progress card. Cancel keeps the draft and what already landed.
3. **Bound preview generation** *(A9)*: max 2 decodes in flight, and decode with `createImageBitmap(file,{resizeWidth:1400})` so the browser never allocates the 24 MP frame. This is what keeps the tab alive on an iPad.
4. **Accept HEIC** *(A4)*; state RAW policy in the drop-zone copy ("Export JPGs from Lightroom first — RAW isn't accepted").
5. **Resumable batches** *(roadmap, needs Worker work)*: persist `{sessionId, filenames, done[]}` in IndexedDB; on reload, "Resume publishing *Morning glass* — 143 of 312 uploaded?" Re-selecting the folder re-hydrates `File` objects (the File System Access API on desktop Chrome can even skip the re-pick).
6. **Session metadata at upload time** *(roadmap)*: break, tide, swell chips (see §5) so the crew tags once, not per photo.
7. **Duplicate-session guard**: creating "Morning surf · Mulki · today" twice is one mis-click away (defaults). Warn if a session with the same date + location exists.

### 3.2 Feedback & alerts

- **Toasts, not a top-of-page notice** *(A1)*. Kinds: info (wave), success (sunburst), error (coral). Errors persist 9 s and carry an action ("Retry").
- **Upload finished while in another tab** → `document.title = '✓ Published · Crew Studio'` + a `Notification` if permitted. The crew walks away from a 40-minute batch; tell them when it's done.
- **Warning vs error styling** *(A11)*: "1 file left out" is a warning.

### 3.3 Session management

- **Action hierarchy** on each card: `View photos` (primary), `Upload more` (secondary), everything else in a `⋯` menu. Seven equal pills is a scan-and-guess UI.
- **Status as a toggle**: Draft ⇄ Published with a switch on the card (with confirm when unpublishing a session that has buyers), instead of a select buried in Edit.
- **Batch actions in the photo grid**: checkbox multi-select → Delete / Re-index / Set cover. Currently 1 photo = 1 confirm dialog.
- **Buyer visibility** *(roadmap)*: "3 unlocks · ₹2,100" per session card. The Worker already knows this from Cashfree verifies.

### 3.4 Authentication & session retention

| Issue | Current | Recommendation |
|---|---|---|
| Single shared "crew" password | One secret for everyone; no audit trail | Per-crew accounts (name + password), or magic link to the two crew emails |
| Token in `sessionStorage`, no client expiry | Survives as long as the tab does; XSS-readable | *(A10)* 30-min idle sign-out with a 2-min warning (paused during uploads) — **and** on the Worker: short JWT + HttpOnly refresh cookie |
| Rate limiting | 429 after N attempts (15 min) ✅ | Show remaining attempts before lockout |
| 2FA | None | TOTP is 40 lines on a Worker; do it for the account that can delete paid originals |
| Session-expiry mid-upload | Everything fails | Refresh before batch; pause-and-re-auth on 401 |

### 3.5 Verification queue

- Highlight the **active card** for Y/N/S *(A7)*.
- Add **"Undo last decision"** (Z) — confirms are one keypress and currently irreversible from the UI.
- Show similarity as a **bar**, not just "71 %" — reviewers calibrate faster.

### 3.6 Monitoring

Topbar health pill polling `GET /api/health` every 60 s: `API ● R2 ● Face service ●` (green/amber/red), with "last indexed 2 min ago". If the Worker lacks the endpoint, it's a 10-line addition that pings D1/R2/the face provider.

---

## 4 · Actionable code fixes (deploy-ready)

Full, commented snippets are in the patch files; the essentials:

### 4.1 Rebrand in one line per page
```html
<!-- index.html & admin.html, last stylesheet in <head> -->
<link rel="stylesheet" href="soi-tokens.css">
```
`soi-tokens.css` remaps `--ocean/--bg/--marker/--coral/--sand…` onto the linocut palette, restyles buttons/chips/cards/inputs/dialogs, adds the toast, empty-state, wave-loader, sticky action bar, and forces 16 px inputs + 44 px targets. Then swap `assets/soi-waves.svg` (session-card fallback) for `soi-stamps.svg#stamp-wave` in ochre, and **recolour `assets/soi-logo.svg`** — it is hard-coded ocean blue and is the one element the token remap cannot reach (verified by injecting the stylesheet into the live page: everything else recoloured; the logo stayed blue). Export an umber-on-linen and a linen-on-umber variant (header vs footer).

**Live proof:** injecting `soi-tokens.css` into the production page recoloured the hero, header, finder card, selected session, CTAs and footer correctly with no layout regressions at 1024 px.

### 4.2 Public — `app.fixes.js`
| Fix | Replaces | Result |
|---|---|---|
| 1 | `app.js:354` favourite handler | In-place ♥ toggle, persisted per search |
| 2 | `app.js:348-351` image error | Starfish fallback tile, tap to retry |
| 3 | `app.js:383-408` pointer block | Pan + pinch when zoomed, tap-out, explicit Escape |
| 4 | new HTML + `syncActionBar()` | Sticky Unlock/♥ bar on phones |
| 5 | `#matchingStage .loader` | Wave/fin loader |
| 6 | `effects.js:43-58` | No reveal flash |
| 7 | `site.css:153` | No iOS zoom |
| 8 | new | Clickable step 01 |

### 4.3 Admin — `admin.fixes.js`
| Fix | Replaces | Result |
|---|---|---|
| A1 | `notifyCrew()` | Toast stack |
| A2 | `xhr.timeout`, `UPLOAD_STREAM_WORKERS` | Stall-based timeout, adaptive concurrency |
| A3 | new | Cancel upload |
| A4 | `isSupportedPhoto`, `accept=` | HEIC |
| A5 | `beforeunload` | Guards unpublished selections |
| A6 | `confirmAction` focus | Cancel focused by default |
| A7 | new | Active review card outline |
| A8 | `watermarkedPreview` | Brand stamp watermark |
| A9 | preview generation | Decode gate (max 2) + downsample-on-decode |
| A10 | new | Idle sign-out |
| A11 | `selectFiles` status | Warning styling |
| A12 | `admin.html:12-802` | Delete inline dark theme |

### 4.4 Small HTML edits
```html
<!-- index.html: matching stage -->
<svg class="soi-loader" viewBox="0 0 112 64" aria-hidden="true">…</svg>

<!-- index.html: before </footer> -->
<div class="soi-actionbar" id="actionBar" hidden>…</div>

<!-- index.html: galleryEmpty → -->
<div class="soi-empty" id="galleryEmpty" hidden><svg><use href="soi-stamps.svg#stamp-shell"/></svg><strong>No favourites yet.</strong><p>Tap the heart on a photo to keep it here.</p></div>

<!-- admin.html: drop zone input -->
<input id="adminPhotoInput" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" multiple hidden>

<!-- admin.html: progress card -->
<button type="button" class="btn-sm" id="cancelUploadBtn">Cancel upload</button>

<!-- admin.html: remove --> <span class="studio-badge">…</span>
```

### 4.5 Server / hosting
- Fingerprint static assets; `Cache-Control: public, max-age=31536000, immutable`.
- CSP as in §2.5.
- Worker: `/api/health`; JWT + HttpOnly refresh; per-crew accounts; per-session unlock counts.

---

## 5 · Feature expansion roadmap (Indian surf photographers & athletes)

Ordered by revenue impact ÷ effort. "Worker" = needs backend work.

### Now (2–3 weeks) — closes the money loop
1. **WhatsApp share & delivery.** On the results page and lightbox: `navigator.share({title, text, url})` with a fallback `https://wa.me/?text=` deep link. After payment, offer **"Send download link to WhatsApp"** — the Worker already has the phone number from checkout; a 30-day gallery link via WhatsApp Business API (Interakt/Gupshup) is the most-opened receipt in India. *(Worker)*
2. **Download all (ZIP).** One tap after unlock; stream a ZIP from R2 in the Worker. Guests on phones will not tap "Download" 23 times. *(Worker)*
3. **Session condition chips** at upload: break name (Mulki, Sasihithlu, Kodi Bengre, Kovalam, Varkala, Mahabalipuram…), swell (ft), wind, tide, board type. Rendered as stamp chips on session cards, results header and each photo's caption. Free SEO for "Mulki surf photos 15 Sept". Chips use the longboard/wave stamps.
4. **Proofing modes** for the crew: per-session toggle **Watermarked previews / Clean low-res proofs / Originals** — for sponsored athletes and school partners who get photos free. One-click "Send clean proofs to +91…" generates a no-pay gallery token. *(Worker: token with `unlocked:true, price:0`)*

### Next (1–2 months) — better matching, less review
5. **Board-colour & wetsuit search.** The link-queue already computes "appearance" similarity; expose it to guests as a second search input: "Didn't match? Pick your board colour / rashie colour" → colour-histogram filter over the session. Cheap, no new ML. The longboard stamp becomes the picker icon.
6. **Surfer profiles (opt-in).** "Remember my face for next time" → stores an embedding keyed to phone number; returning surfers skip the selfie. Also enables **"Notify me when the crew publishes a session I'm in"** (WhatsApp). *(Worker + consent copy)*
7. **Athlete portfolios.** Athlete shares a public page `photos.surfersofindia.com/@name` with their unlocked shots (they own them); SOI gets attribution + a "Book the crew" link.
8. **Multi-surfer group unlock.** Surf-school batches: instructor pays once for N surfers; each student self-serves with a selfie against the same order. *(Worker: order → many tokens)*

### Later (quarter) — platform
9. **Photographer-side capture app**: phone-based tethered upload (Sony/Canon Wi-Fi → phone → Worker) with resumable chunking, so sessions publish *from the beach* within the hour — the moment guests are most likely to buy.
10. **Pricing tiers**: single photo ₹149 / session pack ₹700 / season pass. Requires per-photo unlock tokens.
11. **Prints & merch**: linocut-framed prints via a POD partner; the hibiscus/sunburst stamps become the product line, not just UI.
12. **Analytics**: unlock rate per session, time-to-first-search after publish, top breaks — a small D1 dashboard tab in the studio.

---

## Appendix A · What was verified live

- Landing at 1024 px and 375 px; hamburger open/close; reveal animation timing.
- Session select → Continue → selfie stage → synthetic-image submit → matching stage → API error surfaced correctly.
- Results view with 7 injected photos: grid, ♥ button geometry, unlock button geometry, lightbox open/keys/count, mobile control sizes, broken-tile rendering.
- Admin login screen geometry; forced `showApp()` (UI only, no API): upload tab, file queue with a rejected `.CR3`, edit modal, dirty-close confirm, mobile layout and target sizes.
- Worker: `/api/sessions` (200, CORS scoped to the site origin ✅), `/api/admin/dashboard` unauthenticated (401 ✅).

## Appendix B · Files read
`index.html` (12.7 KB) · `site.css` (24.9 KB) · `premium.css` · `soi-brand.css` · `app.js` (32.7 KB) · `effects.js` · `nav.js` · `config.js` · `admin.html` (44.7 KB) · `admin-theme.css` (15.2 KB) · `admin.js` (76.4 KB, 1,283 lines)
