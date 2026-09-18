# W2-A · Fonts and CSP — handoff (wave 2, resumed run, port 4180)

## Summary

F19 is done: the site no longer loads anything from Google Fonts. Two families ship from `assets/fonts/` (five woff2 files, **63,664 B** on the landing page against **234,174 B in 8 requests** from `fonts.googleapis.com`/`fonts.gstatic.com` before; 38,908 B on every other page against 97,242 B), every page has `font-src 'self'` in both CSP files, and the web-font swap no longer moves a line: the non-input CLS measured in the browser is **0.0000 on all six pages at 375 and 1024** (was 0.0022–0.0187), and the Lighthouse CI gate's CLS assertion passes for the first time (0.0000 on three runs; 0.003–0.004 before). Rendering is unchanged: every computed font family / weight / style / size on the probed elements is identical before and after (`metrics-before.json` vs `metrics-after.json`), and the before/after screenshots differ only at the anti-aliasing level (0.2–2.6 % of pixels).

Two deliberate deviations from the brief, both measured:

- **Plus Jakarta Sans ships as one variable file (wght 400..800), not three statics.** Google only serves the variable font for multi-weight requests; for single-weight requests it instances statics, and my predecessor had already fetched them: 400 = 11,868 B, 600 = 12,168 B, 700 = 12,280 B, **36,316 B together**. Google's latin variable file is 27,272 B (wght 200..800); trimmed to 400..800 with fontTools (`varLib.instancer`) it is **20,644 B**. The brief allows the variable file when it is smaller than the sum of the statics, and it also means the weights 500 and 800 the stylesheets use (hero title, brand, step numbers, `.pricing-amount span`, tagline) keep rendering from real outlines — **no weight remap was needed** and none was done; a test now guards that every weight in the five stylesheets stays inside 400..800 and that Fraunces is only ever asked at 500.
- **index.html preloads one face (Plus Jakarta Sans), not two.** Fraunces first appears at `#finder h2`, below the fold at both 375 and 1024, and preloading it too would put another 18 KB (≈ 90 ms of slow-4G bandwidth — estimated, not measured) ahead of the first paint for nothing visible. `admin.html` and the four text pages open on a Fraunces heading, so they preload both faces.

Fraunces is a **static opsz-36 instance** (upright 18,264 B, italic 22,860 B). Google's plain static is instanced at opsz 9 (a text cut, visibly wider and lower-contrast than what the page rendered with the variable font at opsz = font-size), and the variable file with the opsz axis costs 34,760 + 42,116 B. The display headings run 18–52 px, so 36 sits in the middle; the before/after crops of "Your best wave is *in here.*" and "From ₹700" are indistinguishable. **₹ (U+20B9) sits outside Google's latin block**: with latin-only files it would fall back to Georgia/Arial in "From ₹700" and "Pay ₹700", so each family gets a one-glyph rupee file (960 B and 936 B) declared with `unicode-range:U+20B9` — the old embed pulled a 21 KB + 17 KB latin-ext file for that one glyph. Plus Jakarta Sans's italic (the hero tagline, `.soi-tagline`) is dropped per the brief; the browser's synthesized oblique is a near-perfect stand-in because the family's real italic is an oblique design (see `index-hero-1024-*.png`).

The fallback faces (`'Plus Jakarta Sans Fallback'` = Arial/Helvetica, `'Fraunces Fallback'` = Georgia) carry `size-adjust`, `ascent-override`, `descent-override` and `line-gap-override`, tuned against the rendered landing page with the fonts blocked rather than from table averages: with the web fonts blocked the document height and every measured block's y/height are identical to the web-font layout at both widths (`fallback-out-final.txt`), versus 16–30 px of drift with raw system fonts. The only residue is a few px of width on centered hero lines (hero title box +0.6 px).

**Lighthouse (the enforced gate, `npm run lighthouse`, Lantern simulation):** CLS 0.003–0.004 → **0.0000** (passes), FCP 1692–1775 → **1507–1514 ms**, total transfer 316 KB → **149 KB**, font requests 8 → 5, render-blocking third-party CSS gone; **LCP 1692–1775 → 1979–2036 ms, which fails the 1,800 ms assertion**. That LCP number is an artifact of Lantern's model, not of the change: Lantern shares HTTP/1.1 bandwidth evenly between every same-origin request in flight, so the 63 KB of fonts (before, the Google fonts sat behind a third-party connection chain and never overlapped the hero image in the simulation) now "slow" the 29 KB hero image; it reads the same with the preload, with `fetchpriority="low"`, and with no preload at all. Under **applied** throttling (real Chrome scheduling, slow 4G + 4× CPU, interleaved runs over a local HTTP/2 server, medians of 5) the page is equal or better: before FCP 1032 / LCP 1096 / CLS 0.0034 with the web fonts arriving at 2430 ms; after FCP 1232 / LCP 1232 / CLS 0 with the fonts in place at first paint (no FOUT at all); after-without-preload FCP 1056 / LCP 1084 / CLS ≤ 0.001 with a ~560 ms shift-free FOUT. So the preload buys "no font flash" for ~150 ms of first paint on slow 4G; I kept it because it is what the brief asks, it is what makes the CLS gate read 0.0000, and the lead can drop it by deleting one tag (numbers for both in this file). See "Requests to other owners" for the `lighthouserc.json` suggestion.

Inherited: nothing in the repo (Google Fonts links were in every page, no `assets/fonts/`); my predecessor's scratch downloads (`scratchpad/W2-A/dl/`, the static instances) were reused for the size comparison. A separate session was editing `worker.js`/`tests/worker.test.mjs` during this run; `npm test` hung on that file for ~6 minutes at one point and passes (129/129) at hand-off. Nothing was deployed, committed or written to production; the only Worker calls were read-only `GET /api/sessions` through the dev proxy.

## Files changed

- `assets/fonts/` (new): `plus-jakarta-sans-400-800.woff2` (20,644 B), `plus-jakarta-sans-400-800-rupee.woff2` (960 B), `fraunces-500.woff2` (18,264 B), `fraunces-500-italic.woff2` (22,860 B), `fraunces-500-rupee.woff2` (936 B), `LICENSE-plus-jakarta-sans.txt`, `LICENSE-fraunces.txt` (both SIL OFL 1.1 from the upstream repos), `SOURCES.txt` (provenance and rebuild commands). All are served by the dev server, copied by the build and listed by `siteFiles()` (the lead's wave-2 extension).
- `soi-tokens.css`: `@font-face` block at the top (five web faces with `font-display:swap`, Google's latin `unicode-range`, the two `U+20B9` faces; five metric-matched fallback faces); `--sans`/`--display`/`--mono` stacks now name the fallback face right behind the web font; stale Google Fonts comment replaced; tokens `--soi-slate-ink:#43617A` and `--soi-ochre-ink:#7A5F30` added beside the `-deep` tokens (W1-C's request). +1.5 KB gzip (6.3 → 7.8 KB).
- `index.html` (`<head>`): Google preconnects and both stylesheet links removed; one `<link rel="preload" as="font" type="font/woff2" crossorigin>` for Plus Jakarta Sans after the hero image preload, before the stylesheets. W1-D's hero `srcset`/preload/preconnect hunks untouched.
- `admin.html` (`<head>` only, lines 9–12): Google preconnects and stylesheet links replaced by two font preloads (Fraunces 500, Plus Jakarta Sans). No CSP `<meta>` existed. W2-D's body edits untouched.
- `about.html`, `contact.html`, `terms.html`, `refund-policy.html`: line 8 only (the Google links → the two preloads).
- `.htaccess`: `style-src` and `font-src` in the report-only CSP (`font-src 'self'`, Google hosts gone); a `<FilesMatch "\.woff2$">` block with `Cache-Control: public, max-age=31536000, immutable` after W1-E's hashed-asset block.
- `vercel.json`: the same CSP change (the two policies are byte-identical again, tested) and a `/assets/fonts/(.*)\.woff2` immutable header entry.
- `tests/fonts.test.mjs` (new, 7 tests) — `tests/` is not in my ownership list, so I added a new file rather than editing `tests/site.test.mjs`; `npm test` picks it up through the glob.
- `docs/audit/handoff/W2-A.md` (this file) and `docs/audit/handoff/shots/W2-A/`.

Not touched: `site.css`, `premium.css`, `soi-brand.css`, `admin-theme.css`, `app.js`, `admin.js`, `worker.js`, `scripts/*`, `package.json`, `lighthouserc.json`, `README.md`.

## Tasks done (by id)

### F19 · fonts (all sub-items)

| Item | Result |
|---|---|
| Cut the faces | Plus Jakarta Sans 400..800 variable (see Summary for why not three statics; sizes: statics 36,316 B vs variable 27,272 B untrimmed / 20,644 B trimmed) · Fraunces 500 upright + italic, static opsz 36 · two rupee glyph files. Files dropped versus the old embed: PJS 500 italic (13,064 B), PJS latin-ext (21,688 B), Fraunces 600 (never used), Fraunces latin-ext ×2 (59,574 + ~40 KB), the opsz axis. |
| Self-host, `font-display:swap`, `unicode-range` | `soi-tokens.css` lines 22–29; served from the same origin on both hosts (relative `url(assets/fonts/…)` from the root stylesheet, so `/admin` on Vercel resolves too). Build verified: `dist/soi-tokens.aaf97f35.css` references all five files, "every local reference verified". |
| `size-adjust`/`ascent-override` fallbacks | Tuned in Chromium against the rendered page with fonts blocked (sweeps in `tune-out.txt`, `tune2-out.txt`): PJS 400–500 → Arial at 104 %, 600–700 → Arial Bold at 98 %, 800 → Arial Bold at 95 %, Fraunces → Georgia at 104 %, italic → Georgia Italic at 97 %; overrides = web-font ascent/descent ÷ size-adjust. Result in `fallback-out-final.txt`: fallback document height 4047 / 5233 px = web-font height at 1024 / 375; every probed block's y and height Δ = 0.0; hero title box Δw +0.6 px. Raw Arial/Georgia: 4031 / 5203 px, footer y −16 / −30 px. |
| Preload the above-the-fold faces | index: PJS (one file covers hero h1 800, tagline, intro, nav). admin + the four text pages: Fraunces 500 + PJS. Preloads sit before the first stylesheet; `crossorigin` set so the preload and the CSS fetch share one request (verified: exactly one request per file in the log). |
| `font-src 'self'` in both CSP files | Done, still `Content-Security-Policy-Report-Only`; `https://fonts.googleapis.com` dropped from `style-src`, `connect-src` never listed Google. The two policies are identical strings (test). |
| Remap `font-weight:500`/`800` | Not needed: the variable file renders them natively. Verified by computed style + `document.fonts` face lookup for 26 probes on index and 14 on admin (`metrics-after.json → computed/rendered`): identical to before, every probe served by a loaded face of the right weight. The only synthesized style is the tagline's italic (by design). |
| Screenshot every page | `docs/audit/handoff/shots/W2-A/<page>-<label>-<width>-<before|after>.png`: index hero/finder/pricing/footer, admin login, about, contact, terms, refund-policy at 1024 and 375×812 (18 files each side). Pixel diff (threshold 40/765 per channel): 0.18–2.63 %, all anti-aliasing / grain; side-by-side crops of the hero, the pricing card and the finder heading were inspected by eye. |
| No request to Google | Playwright response log in `metrics-after.json`: 0 responses from `fonts.googleapis.com` / `fonts.gstatic.com` on all 12 page×width loads; Lighthouse network log: font hosts = `127.0.0.1` only. |
| Font bytes | index 234,174 B (8 req) → 63,664 B (5 req); other pages 97,242 B (4 req) → 38,908 B (2 req). Lighthouse resource summary: font 231,296 → 64,710 B; page total 316,054 → 148,921 B. |
| Lighthouse LCP / CLS | Same-day baseline (gzip dev server + W1-D's `srcset`, i.e. the tree I started from) vs after, `npm run lighthouse` median of 3: LCP 1704 → 2032 ms (fails the gate — see Summary and Requests), CLS 0.0030 → **0.0000** (now passes), FCP 1704 → 1507 ms, TBT 2 → 32 ms, perf 99 → 99. W1-E's wave-1 baseline (uncompressed server, no srcset) was LCP 2779 / CLS 0.009. Applied-throttling numbers are in `throttled-h2b-out.txt` (H2) and `throttled2-out.txt` (H1). |

### W1-C's tokens
`--soi-slate-ink:#43617A` (5.43:1 on slate-tint) and `--soi-ochre-ink:#7A5F30` (5.07:1 on linen) added. `--soi-coral-deep` already exists as `#9A5563`, so per the lead's "if it does not exist" it was left alone (W1-C's optional `#8F4D5B` not applied — the lead can flip it; `admin-theme.css` defines its own `--soi-coral-ink:#8F4D5B` locally). The shared `.chip--slate,…{color:var(--soi-slate-deep)}` rule was **not** changed, as instructed; W1-C's local override in `admin-theme.css` still covers admin.

## Tests added (names, `tests/fonts.test.mjs`, 7/7 passing; suite 129/129)

1. `F19: no page loads anything from Google Fonts`
2. `F19: every page preloads exactly its above-the-fold faces` (index: PJS; others: Fraunces + PJS; `type`, `crossorigin`, preload before `soi-tokens.css`)
3. `F19: every @font-face src ships, is a woff2, uses swap, and the set stays under budget` (files in `siteFiles()`, `wOF2` magic, `unicode-range`, a `U+20B9` face per family, ≤ 70 KB total, OFL licences present)
4. `F19: the fallback faces carry metric overrides and sit right behind the web font in every stack` (sans fallback weights tile `400 500` / `600 700` / `800`)
5. `F19: every weight the stylesheets use is inside the shipped faces (sans 400..800, Fraunces 500 only)`
6. `F19: both CSP files restrict fonts to the site itself and drop the Google hosts` (policies identical, `font-src 'self'`, woff2 cache rules in both)
7. `W1-C tokens: slate-ink and ochre-ink exist and clear 4.5:1 on their chip backgrounds`

## How to verify (commands and my port)

```sh
cd "/Users/ankithkotian/Documents/mambo jambo photos website"
npm run check && npm test                 # 129/129 at hand-off (7 in tests/fonts.test.mjs)
node --test tests/fonts.test.mjs          # 7/7
npm run build                             # 49 files, 13 fingerprinted, "every local reference verified"; dist/assets/fonts/ has the 8 files
PORT=4180 npm run dev                     # then:
curl -sI http://127.0.0.1:4180/assets/fonts/fraunces-500.woff2 | head -3        # 200, font/woff2, 18264
SHOTS=/private/tmp/claude-501/-Users-ankithkotian-Documents-mambo-jambo-photos-website/7bb4db07-8310-4483-95f0-d75808750f63/scratchpad/shots
# screenshots + font request log + computed styles + CLS for all six pages at 1024 and 375 (writes metrics-<tag>.json):
(cd $SHOTS && node "/Users/ankithkotian/Documents/mambo jambo photos website/docs/audit/handoff/shots/W2-A/audit.mjs" --tag after --port 4180)
# fallback layout vs web-font layout (fonts blocked in the browser):
(cd $SHOTS && node "/Users/ankithkotian/Documents/mambo jambo photos website/docs/audit/handoff/shots/W2-A/fallback.mjs" 4180)
# the gate (starts its own server on 4190; LCP assertion fails at ~2.0 s simulated, CLS passes at 0):
CHROME_PATH="$HOME/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" npm run lighthouse
# applied-throttling comparison over HTTP/2 (needs the before-tree and variant copies in the session scratchpad; scripts kept in shots/W2-A/ for reference)
```

The font files can be rebuilt from the commands in `assets/fonts/SOURCES.txt` (Google Fonts CSS fetched with a Chrome UA; the PJS trim needs fontTools + brotli in a scratch venv — no project dependency was added).

## Screenshots and traces (paths)

- `docs/audit/handoff/shots/W2-A/`: 36 PNGs (`index-{hero,finder,pricing,footer}`, `admin-login`, `about-top`, `contact-top`, `terms-top`, `refund-top` × 1024/375 × before/after); `metrics-before.json` / `metrics-after.json` (per page×width: font responses with bytes, `document.fonts` faces, computed font per probe, the loaded face that served it, layout-shift entries with sources, console errors, screenshot paths); `fallback-out-final.txt`, `tune-out.txt`, `tune2-out.txt` (size-adjust sweeps); `throttled2-out.txt` (H1: before / preload / no-preload), `throttled-h2b-out.txt` (H2: before / preload / preload-low / no-preload); `lighthouse/before-median.{html,json}`, `lighthouse/after-median.{html,json}`; the scripts `audit.mjs`, `fallback.mjs`, `tune2.mjs`, `throttled-h2b.mjs`, `h2serve.mjs`.
- Session scratchpad `/private/tmp/claude-501/…/scratchpad/W2-A/`: all Lighthouse runs (`lh-before`, `lh-after`, `lh-v1` low-priority preload, `lh-v2` PJS-only preload, `lh-v3` no preload, `lh-final`, `lh-before-dt` / `lh-after-dt` devtools throttling), the `before-tree` / `nopreload-tree` / `preloadlow-tree` copies, downloaded font candidates (`dl/`), the fontTools venv, `fontinfo.py` (axes, glyph coverage, metrics of every candidate).

## Deploy or dashboard actions needed

- Deploy the site from `dist/` as usual (W1-E's rule); the eight files in `dist/assets/fonts/` must ship with the HTML/CSS, otherwise every page falls back to Arial/Georgia (no breakage, just the fallback faces). `.htaccess` goes with them (woff2 cache rule).
- After the Hostinger upload: `curl -sI https://photos.surfersofindia.com/assets/fonts/fraunces-500.woff2` → `content-type: font/woff2`, `cache-control: public, max-age=31536000, immutable`; Vercel: same on `https://mambo-jambo-photos.vercel.app/assets/fonts/fraunces-500.woff2`. Open the site with the console on: the report-only CSP should log no `font-src` violation (there is no third-party font left to violate it).
- No Worker, D1, secret or Space action.

## Requests to other owners (file, exact change, why)

1. **`lighthouserc.json` (W1-E / lead):** consider `"throttlingMethod": "devtools"` in `ci.collect.settings`, or re-baseline the LCP assertion after the H2 deploy. Why: Lantern's simulation splits HTTP/1.1 bandwidth evenly across every same-origin request in flight, so self-hosted fonts read as +250–330 ms LCP (1704 → 1979–2036 ms) whether they are preloaded, low-priority or not preloaded at all, while applied throttling (Lighthouse `devtools`, and my CDP harness over both H1 and a local H2 server) shows LCP equal or better than before (H2 medians: 1096 → 1232 ms with the preload, 1084 ms without; FCP 1032 → 1232 / 1056 ms; CLS 0.0034 → 0). Until then the gate exits 1 on LCP for this page; the CLS assertion now passes.
2. **`index.html` (lead's call, my file):** if the 150 ms of slow-4G first paint matters more than a font flash, delete the single `<link rel="preload" as="font" … plus-jakarta-sans-400-800.woff2 …>` tag: no-preload measured FCP 1056 / LCP 1084 / CLS ≤ 0.001 (H2, slow 4G) with the fonts arriving ~560 ms after first paint into a metric-matched fallback. Update `tests/fonts.test.mjs` test 2's `expected['index.html']` to `[]` with it.
3. **`README.md` (lead):** "Headings use the Fraunces display font from Google Fonts; UI text stays on Plus Jakarta Sans." → "Both fonts are self-hosted from `assets/fonts/` (Plus Jakarta Sans variable 400–800, Fraunces 500 static + italic, OFL; provenance in `assets/fonts/SOURCES.txt`); `soi-tokens.css` carries the `@font-face` rules and metric-matched fallbacks." Also in "Content Security Policy": "… Cashfree frames, Google Fonts, and `blob:`/`data:` images" → drop "Google Fonts" (fonts are `'self'`). Why: F19 removed the Google dependency.
4. **`soi-brand.css` (lead) — optional:** `.soi-tagline{font:italic 500 …var(--sans)…}` now renders a synthesized oblique (the PJS italic file was cut). It is visually equivalent (see the hero crops) — no change needed. If a true italic is ever wanted, the cheapest is `font-family:var(--display)` (Fraunces 500 italic is shipped) rather than adding a 12 KB PJS italic file.
5. **`admin-theme.css` (W2-D):** once W1-C's local `:root{--soi-slate-ink…;--soi-ochre-ink…}` override is deleted, the tokens now come from `soi-tokens.css` with the same values; `--soi-coral-ink:#8F4D5B` stays local (not added to the tokens, see above). Why: W1-C asked for the tokens to move up; they have.
6. **`scripts/dev.mjs` (lead) — informational only:** nothing needed; `font/woff2` and `.txt` types already existed.

## Cut or blocked (with reason)

- **Lighthouse LCP assertion fails (2032 ms median simulated, budget 1800):** not fixable from my files without hurting real users — removing the preload does not change Lantern's number and adds a font flash; only the hero image, the JS, or the simulator settings move it. Documented above with applied-throttling evidence; request 1.
- **Preload set deviates on index (one face):** reasoned and measured (Summary); the four text pages and admin preload both.
- **Weight remap not performed:** by design (variable file). If a future change ships statics instead, `tests/fonts.test.mjs` test 5 will point at every rule to remap.
- **`--soi-coral-deep` unchanged** (`#9A5563` exists; W1-C's `#8F4D5B` was optional and outside the lead's "if it does not exist").
- **Hero-title fallback residue:** "SURFERS" and "OF INDIA" have different width ratios in Arial Bold (+4.6 % / −2.1 % at equal size-adjust); the 95 % rule makes the box match (Δ +0.6 px) while the second line's glyphs sit ~5 px narrower, centered — under the 3 px-per-side shift threshold in practice; a real swap on a very slow link could still log ≤ 0.001 CLS on `h1.soi-title`.
- **Not verified:** Safari and Firefox (`size-adjust`/`local('Arial Bold')` matching, synthesized oblique look, HEIC-irrelevant); Android (no Arial/Georgia → the plain `sans-serif`/`serif` fallback without overrides during the swap window); Hostinger/LiteSpeed and Vercel header behaviour for `.woff2` (rules mirror W1-E's tested hashed-asset rules; not exercised on the hosts); real-device throttled numbers (the harness runs Chromium on this Mac with CDP throttling while three other agents load the CPU — medians of interleaved runs, not lab conditions); the swap on a real slow network (only emulated).
- **Cashfree:** no checkout, verify, webhook or refund code was touched — the CSP edit only removed the two Google hosts; the Cashfree entries are byte-identical. The CLAUDE.md Cashfree flow was therefore not run.
- **`npm test` during the run:** `tests/worker.test.mjs` hung for >6 minutes while the other session was mid-edit on `worker.js`; not mine, resolved by hand-off (129/129).
