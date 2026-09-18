# W3-A · Public product — handoff (wave 3, port 4180)

## Summary

Every item in the W3-A block is built and exercised against a **mocked** Worker (the W3-B contract shapes) in Playwright at 375×812 and 1024×768; nothing was deployed, committed or written to production, and the only real Worker call from this machine was the read-only `GET /api/sessions` through the dev proxy.

- **Uncropped tiles.** Each print's button box carries `aspect-ratio: W / H` inline from `photo.width/height` (migration 0012); a photo without stored size keeps the CSS 4:3 box and is cover-cropped as before. The grid stays `auto-fill` with `align-items:start`, so the sheet is ragged like a contact sheet and no tile stretches. Layout-shift observer through results load, a hide and the colour search: **0 / 0 / 0** at both widths (`shots/W3-A/metrics-after.json → cls`).
- **"Not me, hide"** on every preview tile (never on paid originals): the figure is removed in place (no grid re-render, no image reload), the remaining tiles are renumbered by text only, hearts follow their photo, focus moves to the next print, the live eyebrow reads "… · 8 waves, 1 hidden", the id is kept per search in `sessionStorage` (`mjHidden:<searchId>`) and applied to every later server list, and `POST /api/searches/:id/hide { token, photoId }` is fired-and-forgotten (404 = route not deployed, ignored). Hiding the last wave lands on the zero-match state.
- **Zero-match second chance.** A `radiogroup` of twelve named hue radios on a ring, a Vivid / Muted / Any tone group and "Find by colour" → `POST /api/searches/:id/colour { token, hue, tone }`; success swaps the previews in place under the title "N waves, maybe you." with the copy "Matched by board colour · previews only" and the eyebrow "… · N waves by colour"; empty keeps the picker with a hint; 404 says it is not available yet; 429 disables the ring for `retry-after` with a countdown. Beside it, "Tell me when the crew re-indexes" → `POST /api/searches/:id/notify { token, phone }` with the checkout number rules; "We'll WhatsApp you once." on success, a friendly line on 404.
- **WhatsApp share** on the results header and in the lightbox: `navigator.share({ title, text, url })` when available, else a `wa.me/?text=` tab; the text is the session title + the public site URL only (the e2e asserts no `token`, `api/media` or search id ever appears). After payment, "Send my gallery link to WhatsApp" shares `<site>/?gallery=<searchId>.<galleryToken>` (the 30-day token from `mjGallery`, never the 45-minute search token) with the bearer-link hint under it; opening that link on a fresh device reopens the originals through the resume path and only stores the record once `/access` accepts the token (a bad link never overwrites a saved gallery).
- **Checkout trust block** above the phone field: "9 photos · ₹700" (heading contract from wave 1 kept), "₹78 each", three ✓ lines (Full-resolution originals, no watermark · Download all as one ZIP · 30-day link to come back) and UPI / Cards / Netbanking with inline SVG glyphs.
- **"Today's session lands by 4:30 pm"** in the sessions section from `GET /api/sessions` `nextDropAt` (local time; "Next session lands by 7:00 am tomorrow" across midnight; the element stays hidden when there is nothing within 24 h). Session `conditions` render as slate chips under the results title.
- **429 on `/api/match`** (W1-A's carried request): the search button stays disabled for exactly `retry-after` with a ticking "Try again in 6:58"; the ticking figure is `aria-hidden` and a visually-hidden "7 minutes" is what the live region speaks, once.
- **Accessibility.** `#resultsMeta` is the one live region (`aria-live="polite" aria-atomic="true"`), written once per change. New controls carry names (`Not me, hide wave 3`, `Share this session on WhatsApp`, hue radios `Red … Pink`, `Board colour` radiogroup, `Tone` group, `Notify me`). Axe: zero violations on every public screen × 4 viewports (`npm run e2e`), plus the colour-results and paid-gallery states in the new spec. Accessibility-tree dumps of the new screens are in `shots/W3-A/aria-{375,1024}.txt`.
- **Carried from wave 2, both closed.** (a) Lighthouse CLS 0.0007 on `h1.soi-title > span`: the cause is that Plus Jakarta Sans capitals run ~95 % of Arial's while the 400–500 fallback was tuned on lowercase (104 %), and "OF INDIA" runs the other way (101 % — F, I, N, D, A are narrow in Arial Bold) against the 800 fallback tuned on "SURFERS" (95 %); the centred lines therefore stepped 3.6–5.8 px sideways at the swap. Two more fallback faces (`Fallback Caps`, `Fallback Title`) and `--sans-caps` fix it: font-swap CLS **0.00072 → 0 at 412×823, 0.00096 → 0 at 375, 0.00049 → 0.00006 at 1024** (the residue is the decorative, aria-hidden, animated ticker). **`npm run lighthouse` now passes every assertion: CLS 0 / 0 / 0, LCP 1788 / 1744 / 1762 ms (median 1762 ≤ 1800), TBT 0, script 30.2 KB, a11y 1.0.** (b) Axe "needs review" over the hero: real pixels sampled behind every hero text node with all hero text hidden, at 375, 1024 and 1440 — three pairs failed (tagline 4.34:1 at 1024, bottom strip 3.96–4.14:1 at 1024/1440, scroll arrow 3.2–3.6:1 everywhere); now coral-ink / umber / dusk, worst pairs 4.95 / 7.94 / 8.03:1.
- **JS budget:** `app.js` 16,933 → 22,870 B gzip (+5.9 KB for all of the above); the built `index.html` carries **28.1 KB** of compressed JS (budget 40 KB).
- `soi-stamps.svg`: the kit was not supplied; a note at the top of the file says what to replace and that no wiring changes are needed.

Collisions with the concurrent session: none. The camera block in `app.js` is byte-identical to my start snapshot (`diff` in the scratchpad); my edits were small targeted hunks around it. `tests/e2e/` was hit by other agents' parallel Playwright runs (shared `test-results/` and the 4195 server) — I ran with `--output` in my scratchpad and re-ran when the server was killed under me; the numbers below are from clean runs.

## Files changed

- `index.html` — `#nextDrop` line in the sessions section; results header: `aria-live`/`aria-atomic` on `#resultsMeta`, `#resultsConditions`, `.results-actions` wrapping the keepers filter and `#shareResults`; `#galleryShare` (button + hint) above `#downloadAll`; `#secondChance` (colour ring `#hueRing` with 12 radios + `#hueName`, `#toneToggle`, `#colourSubmit`, `#colourStatus`; `#notifyForm` with `#notifyPhone`, `#notifySubmit`, `#notifyStatus`) after `#noMatches`; `#sharePhoto` in the lightbox controls; checkout trust block (`#checkoutPerPhoto`, `.checkout-trust`, `.pay-methods` with three inline SVGs) replacing the old sentence.
- `app.js` — `requestApi` keeps `status` and `retryAfter` on the error; `retryAfterSeconds`, `retryCopy`, `mmss`, `retryLock`; `nextDropCopy`/`renderNextDrop`; `resultsMetaText`/`setResultsCount`, `conditionChips`/`renderConditions`; hidden list (`hiddenKey`, `loadHidden`, `saveHidden`, `withoutHidden`); `showZeroMatch`, the colour and notify handlers; `tileAspect`, `indexOfPhoto`, `relabelTiles`, `hidePhoto`, `renderGallery` (inline aspect, hide button, live indices, `data-photo-id`); `perPhotoCopy`; share (`siteUrl`, `shareText`, `whatsappUrl`, `share`, `galleryLink`, `resumeGalleryFromLink`); `openGallery` (the resume handler, shared with the link); `setResultsTitle(count, tail)`; 429 branch in the search handler; `withoutHidden` applied in `applyUnlockedPhotos`, the colour result and the match result; `loadSessions().finally(resumeGalleryFromLink)`.
- `site.css` — `.visually-hidden`; `.next-drop`; `.results-actions`, `.share-button`, `.conditions .chip` (slate-ink); tile box (`.photo-open{aspect-ratio:4/3}`, image `height:100%`, `.gallery{align-items:start}`, broken tile keeps its ratio); `.hide-photo` (44 px row); `.gallery-share`; `.second-chance`, `.chance-card`, `.hue-ring`/`.hue-swatch`/`.hue-name`, `.tone-toggle`, `.notify-form`; `.lightbox-share`; checkout trust styles; phone tweaks; hero contrast overrides (`.hero .soi-tagline`, `.hero .hero-bottom`, `.hero .hero-bottom a`); `--sans-caps` on `.hero-hand`, `.hero-bottom`, `.ticker-group`; `.soi-title span` fallback face; `.countdown`/`#checkoutPerPhoto` added to the tabular-nums list.
- `soi-tokens.css` — `@font-face` `'Plus Jakarta Sans Fallback Caps'` (400–500 at 95 %, 600–800 at 95.3 %) and `'Plus Jakarta Sans Fallback Title'` (800 at 101 %) with the derived ascent/descent overrides; `--sans-caps`; `--soi-coral-ink:#8F4D5B`.
- `soi-stamps.svg` — header comment only (kit not supplied; how to swap the symbols in).
- `tests/e2e/helpers/mock-api.mjs` (additive) — real asset dimensions in `PHOTO_SIZES` (one `null` pair), `conditions` on the first public session, `state.nextDropAt`, `state.guest` modes and the `/hide`, `/colour`, `/notify` routes, `matchMode: '429'`.
- `tests/e2e/guest-product.spec.mjs` (new, 16 tests × mobile-375 + desktop-1024), `tests/guest-product.test.mjs` (new, 12 tests; `tests/` is not in my ownership so nothing in `site.test.mjs` was touched).
- `tests/e2e/__screenshots__/screenshots.spec.mjs/{results,checkout}-{mobile-375,tablet-768,desktop-1024,wide-1440}-darwin.png` — re-baselined (tiles and the dialog changed); `hero`, `finder` and `lightbox` were left as they were (their diffs stayed under the 0.5 % tolerance, so `--update-snapshots` did not rewrite them).
- `docs/audit/handoff/W3-A.md` (this file), `docs/audit/handoff/shots/W3-A/`.

Not touched: `effects.js`, `nav.js`, `soi-fx.js`, `premium.css`, `soi-brand.css`, `worker.js`, `admin*`, `README.md`, `package.json`, `playwright.config.mjs`, `tests/site.test.mjs`, `tests/e2e/public.spec.mjs`, `axe.spec.mjs`, `screenshots.spec.mjs`.

## Tasks done (by id)

Wave-3 W3-A block (the master prompt numbers these by name, not F-id):

| Item | Where | Proof |
|---|---|---|
| Uncropped tiles from `width/height`, contact sheet, zero layout shift | `renderGallery` + `tileAspect`; `.photo-open` box | e2e "uncropped tiles…" (inline ratio = stored, rendered = natural ±0.02, unknown = 4:3, non-input CLS entries `[]`); audit `metrics-after.json → tiles, cls.resultsLoad = 0` |
| "Not me, hide" on every result tile, removes in place, sessionStorage, 404 ignored | `hidePhoto`, `relabelTiles` | e2e ""Not me" hides" ×3; audit `hide` (9 → 8, meta "8 waves, 1 hidden", focus "Open wave 2", stored `["p2"]`, POST body) |
| Zero-match colour picker (`/colour`, 12 hues + tone, 429 honoured, header copy) | `#secondChance`, colour handler | e2e "zero match: second chance" ×3 (success, empty/404, 429 lock + countdown + release); audit `colour`, `cls.colour = 0` |
| "Tell me when the crew re-indexes" phone field (`/notify`) | `#notifyForm` | e2e "notify me…" (validation, success copy, 404 copy) |
| WhatsApp share on lightbox and results header (Web Share, `wa.me` fallback) | `share()`, `#shareResults`, `#sharePhoto` | e2e "share" ×2 (payload = title + site URL, no token/media; `wa.me` with `_blank`,`noopener`) |
| "Send my gallery link to WhatsApp" after payment, 30-day token, hint | `galleryLink`, `#galleryShare`, `resumeGalleryFromLink` | e2e "after payment…" (link carries `e2e-gallery-token`, not the search token; the link reopens the gallery cold; axe clean) and "gallery link" (bad token never overwrites the saved record) |
| Checkout trust block (count, per-photo price, three lines, method icons) | `#checkoutDialog` | e2e "checkout trust block…"; unit `perPhotoCopy`; screenshots `checkout-*-after.png` |
| "Today's session lands by …" from `nextDropAt` | `nextDropCopy`, `#nextDrop` | e2e "landing…" (today / tomorrow / past / >24 h / null); unit `nextDropCopy`; `landing-sessions-*-after.png` |
| Conditions chips on the results header | `renderConditions` | e2e colour test asserts the five chips; `results-*-after.png` |
| `soi-stamps.svg` traced originals | — | kit not supplied → note in the file (unit test checks it) |
| VoiceOver/NVDA pass, `aria-live` on the count, zero axe violations | `#resultsMeta`, names/roles | e2e "names and roles…", `aria-*.txt` dumps, `npm run e2e` axe 0 violations; a real VoiceOver/NVDA run is **not possible headlessly** (see Cut) |
| Honour `retry-after` on 429 (W1-A carried) | `retryLock` | e2e "search quota…" (disabled for 7:00, ticks, survives a stage change, releases; aria-hidden figure) |
| Lighthouse CLS 0.0007 (lead carried) | caps/title fallback faces | `font-swap-{before,after}.txt`; `lighthouse-summary.json` (last three runs CLS 0) |
| Axe "needs review" over the hero (W2-B carried) | `hero-contrast-{before,after}.txt` | every hero node ≥ 4.5:1 (or ≥ 3:1 where large) against the darkest sampled pixel at 375/1024/1440 |

### Hero contrast, real pixels behind each node (worst pair, text hidden while sampling)

| Node | 375 before → after | 1024 before → after | 1440 before → after |
|---|---|---|---|
| `.soi-tagline` (20–28 px / 500; needs 4.5 below 24 px) | 4.90 → 5.59 | **4.34** → 4.95 | 4.18 (large, ok) → 4.76 |
| `.hero-bottom span` "PHOTOS · FILMS…" (11 px) | 5.35 → 10.74 | **4.14** → 8.31 | **3.96** → 7.94 |
| `.hero-bottom a` "↓" (20 px) | **3.60** → 9.05 | **3.22** → 8.09 | **3.20** → 8.03 |
| `.hero-hand`, `.soi-title`, `.soi-title span`, `.intro`, `.hero-note`, "TAKE THE OCEAN HOME." | all ≥ 4.77 before and after (unchanged colours) | | |

Axe still lists ~26 hero/footer nodes as "needs review" at every width: it cannot read through the photo, the scrim gradient or the fixed `body::before` grain layer. Those pairs are now verified by sampling (hero) or are CSS-solid (footer links 10:1, eyebrow 4.9:1, from W1-D's table). The count is unchanged by design — the check is the pixel audit, not axe's guess.

### Font-swap layout shift (fonts delayed 1.5 s, `font-swap.mjs`)

| Viewport | Before | After | What moved before |
|---|---|---|---|
| 412×823 @1.75 (the Lighthouse device) | 0.00072 | **0** | `h1.soi-title > span` 176.4 → 188 px wide (x −5.8 px), `p.hero-hand` +7.1 px (x −3.6 px) |
| 375×812 | 0.00096 | **0** | the same two, plus the bottom strip wrapping 3 → 2 lines |
| 1024×768 | 0.00049 | 0.00006 | the same two, plus the ticker (`aria-hidden`, animated when motion runs; left alone) |

## Tests added (names)

`tests/e2e/guest-product.spec.mjs` (mobile-375 + desktop-1024, 32 runs, all passing):
1. uncropped tiles › each print keeps its stored ratio, an unknown size keeps 4:3, and the sheet loads with zero layout shift
2. "Not me" hides › the tile goes in place, the rest renumber, focus moves to the next print, the live count says so, and the hide is stored and posted
3. "Not me" hides › a missing /hide route (404) hides locally and says nothing; the unlocked gallery offers no hide
4. "Not me" hides › hiding the last wave lands on the zero-match state with its second chance
5. zero match: second chance › the colour ring is a radiogroup of twelve named swatches; a colour search swaps in the colour-ranked previews under the colour header (+ axe)
6. zero match: second chance › no boards of that colour keeps the picker with a hint; 404 says the search is not available yet
7. zero match: second chance › a 429 locks the ring for retry-after with a countdown, then frees it
8. zero match: second chance › notify me: the checkout number rules, the success line, and a friendly 404
9. share › results header and lightbox share the session title and the site URL through Web Share — never a preview link or the token
10. share › without Web Share a wa.me tab opens with the same text
11. share › after payment the WhatsApp button sends the 30-day gallery link with its bearer-link hint, and the link reopens the gallery (+ axe)
12. gallery link › a link with a bad token says so and never overwrites the gallery already saved on this device
13. checkout trust block › count, per-photo price, the three lines and the three ways to pay sit above the phone field
14. landing › "lands by" shows only for a future drop within 24 h, in local time
15. search quota › a 429 keeps the search button off for retry-after with a ticking countdown that screen readers hear once
16. names and roles › the results screen reads right: live eyebrow, named hide buttons, share, conditions; the zero-match ring and tone toggle are labelled

`tests/guest-product.test.mjs` (12, all passing): `nextDropCopy…`, `retryAfterSeconds and retryCopy…`, `resultsMetaText and conditionChips…`, `tileAspect and the tile box…`, `"Not me"…`, `zero-match second chance…`, `share…`, `checkout trust block…`, `"lands by"…`, `font swap: caps-tuned fallback faces…`, `hero contrast over the photo…`, `soi-stamps.svg: still placeholder geometry…`.

## How to verify (commands and my port)

```sh
cd "/Users/ankithkotian/Documents/mambo jambo photos website"
npm run check && npm test                       # 169/169 at hand-off (12 in tests/guest-product.test.mjs)
node --test tests/guest-product.test.mjs        # 12/12
npm run e2e                                      # 219 passed, 3 skipped at hand-off (full suite, all four agents' specs)
npx playwright test tests/e2e/guest-product.spec.mjs tests/e2e/public.spec.mjs --reporter=list   # 62 passed
# if another agent's e2e run kills the shared 4195 server mid-run (tests die at ~250 ms), start one that nobody kills and re-run:
PORT=4195 npm run dev &
npm run build                                    # 49 files; index.html: 5 scripts, 28.1 KB gzip
CHROME_PATH="$HOME/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" npm run lighthouse   # all assertions pass; CLS 0
PORT=4180 npm run dev                            # then, from the shared shots tool dir:
SHOTS=/private/tmp/claude-501/-Users-ankithkotian-Documents-mambo-jambo-photos-website/7bb4db07-8310-4483-95f0-d75808750f63/scratchpad/shots
(cd $SHOTS && node "$PWD/docs/audit/handoff/shots/W3-A/audit.mjs" --tag after --port 4180)        # every screen at 1024/375 + metrics JSON (mocked API)
(cd $SHOTS && node "$PWD/docs/audit/handoff/shots/W3-A/hero-contrast.mjs" 4180)                    # pixels behind each hero node at 1024/375/1440
(cd $SHOTS && node "$PWD/docs/audit/handoff/shots/W3-A/font-swap.mjs" 4180 1500)                   # layout-shift entries at the swap, fonts delayed 1.5 s
(cd $SHOTS && node "$PWD/docs/audit/handoff/shots/W3-A/measure-widths.mjs" 4180)                   # web-font vs Arial widths behind the size-adjust values
```

The audit scripts import the shared Playwright from the scratchpad, so they run on this machine only; `audit.mjs` writes its metrics JSON into the scratchpad (copies are in the shots folder).

## Screenshots and traces (paths)

`docs/audit/handoff/shots/W3-A/<name>-<1024|375>-<before|after>.png`: `landing` (hero), `landing-sessions` (the "lands by" line, after only), `results` (mixed-ratio tiles, chips, share), `results-sheet` (scrolled to the tiles: ragged contact sheet with the "Not me" captions), `results-hidden` (after a hide), `lightbox` (share button), `checkout` (trust block), `paid` (WhatsApp gallery button + hint), `zero-match`, `zero-match-full` (full page: starfish + colour ring + notify), `zero-match-notified`, `colour-results`, `rate-limited` (429 countdown). The before set has no `hidden`/`colour`/`notified`/`sessions` variants (those states did not exist). Metrics: `metrics-before.json`, `metrics-after.json` (tiles, a11y, hide, colour, notify, 429, CLS entries per step), `hero-contrast-{before,after}.txt`, `font-swap-{before,after}.txt`, `lighthouse-summary.json` (every run today, the last three are this tree), `lighthouse-run1-loaded-machine.txt` / `lighthouse-run2.txt`, `aria-{375,1024}.txt` (accessibility-tree dumps), and the four scripts. No Chrome performance traces were recorded (nothing in this block needed one). Scratch copies, Lighthouse HTML reports and the Playwright artifacts: `/private/tmp/claude-501/…/scratchpad/W3-A/`.

## Deploy or dashboard actions needed

None from this workstream beyond the usual site deploy from `dist/` (index.html, app.js, site.css, soi-tokens.css, soi-stamps.svg are all fingerprinted/rewritten by the build). Everything degrades without the new Worker routes: `/hide` 404 → local hide; `/colour` and `/notify` 404 → the friendly copy; no `nextDropAt`/`conditions` → no line, no chips. The gallery link (`?gallery=…`) relies only on the existing `GET /api/searches/:id/access` with a gallery token, which is already deployed.

## Requests to other owners (file, exact change, why)

1. **W3-B (`worker.js`)** — the contract as built against: `POST /api/searches/:id/hide { token, photoId }` → `{ ok, remaining }`; `POST /api/searches/:id/colour { token, hue 0–359, tone 'vivid'|'muted'|'any' }` → the `/api/match` shape + `mode:'colour'` (the page also accepts a fresh `token` if one is returned, and keeps the old one otherwise); `POST /api/searches/:id/notify { token, phone }` → `{ ok }`; `GET /api/sessions` `nextDropAt` (ISO or null) and per-session `conditions { breakName, swellFt, wind, tide, photographer } | null`. On 429 the page reads `retry-after` in seconds (an HTTP date also works). Server-side hides should also drop the photo from `/previews`, `/access`, the ZIP and the checkout count — the page already filters them client-side, so a mismatch would only show in the price/count on a different device.
2. **README (lead)** — add: (a) under Guest flow step 4: "A **Not me** on a preview hides it (kept per search in `sessionStorage`, `POST /api/searches/:id/hide`); a zero-match search offers a board-colour search (`/colour`) and a notify-me number (`/notify`); the results header and lightbox share the session via Web Share or `wa.me`"; (b) after payment: "**Send my gallery link to WhatsApp** shares `/?gallery=<searchId>.<galleryToken>` — a bearer link for the 30-day gallery; opening it stores the record on that device once `/access` accepts it"; (c) landing: "`nextDropAt` from `/api/sessions` renders 'Today's session lands by …' when within 24 h"; (d) the Checks section: `tests/guest-product.test.mjs` and `tests/e2e/guest-product.spec.mjs` exist.
3. **`soi-brand.css` (lead) — optional, cosmetic:** the three hero overrides live in `site.css` (`.hero .soi-tagline{color:var(--soi-coral-ink)}`, `.hero .hero-bottom{color:var(--soi-umber)}`, `.hero .hero-bottom a{color:var(--soi-dusk)}`) because `soi-brand.css` is not in my list. If you prefer the brand file to own them, move the values into `.soi-tagline`, `.hero-bottom` and `.hero-bottom a` there and delete the three lines from `site.css` (the unit test `hero contrast over the photo…` checks the `site.css` lines — update it with the move). Also optional: `--sans-caps` on `.eyebrow`, `.brand small`, `.session-card small` would make those swaps pixel-still too (they are left-aligned single lines, so they never register as CLS; not done to keep the diff small).
4. **W3-C (`admin.js` / `admin-theme.css`)** — `--soi-coral-ink:#8F4D5B` now exists in `soi-tokens.css` (same value as the local one in `admin-theme.css`); the local definition can go.
5. **Lead (`tests/e2e/screenshots.spec.mjs` / `playwright.config.mjs`)** — informational: four agents running `npm run e2e` at once share `test-results/` and the 4195 `webServer`; a run whose server is killed by another run's teardown fails every test at ~250 ms. A `--output` per agent and a long-lived server on 4195 avoided it for me; a `PORT` env override in the config would make this routine.

## Cut or blocked (with reason)

- **VoiceOver / NVDA:** not run — no screen reader can be driven headlessly from this session. What was verified instead: the Chromium accessibility tree (`aria-*.txt`, `getByRole` assertions in the e2e), one live region updated once per change, aria-hidden countdown figures, focus management after a hide, and axe at zero violations on every public state. A human pass on a phone with VoiceOver and on Windows with NVDA is still owed before calling the a11y item done.
- **`soi-stamps.svg`:** the linocut kit was not supplied; placeholder geometry stays, with the note in the file.
- **Ticker residue at the swap (0.00006 at 1024):** `aria-hidden`, decorative, animated by transform when motion runs (so not tracked), and below the fold on the Lighthouse device; the 95.3 % caps face made it 5 px wider in the fallback rather than 3.5 px narrower (the ✳ spans and word spacing do not follow the caps ratio). Left alone.
- **Colour results title copy deviates:** "N waves, maybe you." instead of the standard "All you." — a board-colour match is not a face match and the title should not claim it is; the header line asked for ("Matched by board colour · previews only") is the `#resultsCopy` under it.
- **The checkout heading keeps wave 1's exact text** ("9 photos · ₹700") with "₹78 each" as a sibling line rather than inside the heading: `tests/site.test.mjs` (not mine) asserts the `checkoutHeading` contract by source string.
- **Not verified against the real Worker:** every new endpoint, `nextDropAt`/`conditions`, real `retry-after` values, hide propagation to `/access` and the ZIP, and the WhatsApp/Web Share sheets on real phones (Web Share and `window.open` are stubbed in the e2e; the `wa.me` URL and the share payload are asserted, the apps are not). The `?gallery=` link was verified against the mocked `/access` only.
- **Lighthouse LCP:** the first run of this tree on a machine at load 13 (three other agents' Playwright runs) read 1791 / 2265 / 1887 ms and failed the 1800 ms median; the re-run at load 4 read 1788 / 1744 / 1762 and passed. LCP was 1725–1730 on wave 2's tree under the same gate, so the +30–60 ms is the extra 6 KB of JS; still inside the budget, but the margin is ~40 ms.
- **Cashfree:** the checkout dialog change is markup and copy only (trust block above the phone field); no SDK, API, verify, webhook or refund code was touched, so the CLAUDE.md Cashfree flow (App-ID ask, telemetry, progress feedback) was not run.
