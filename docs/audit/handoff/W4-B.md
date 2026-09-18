# W4-B · PWA and service worker — handoff (wave 4, resumed run)

Agent W4-B, wave 4, second launch. Dev port **4181** (source tree); the `dist/` checks use a scratch static server
on 4187 (or an ephemeral port inside the test) that sends the real production headers and the report-only CSP;
the Lighthouse A/B used 4186. Nothing was deployed, committed or written to production; the only network calls
were read-only `GET /api/sessions` through the dev proxy (the landing page loading in Chromium), plus local mocks
for everything the verification drove.

## Summary

**Inherited (first wave-4 run, cut off when the process exited):** everything the workstream asks for was already
in the tree and is kept as it was — `sw.js`, `manifest.webmanifest`, `pwa.js`, the three icon PNGs, the two
`index.html`/`admin.html` hunks, the `scripts/build.mjs` precache injection, `scripts/site-files.mjs`,
`tests/pwa.test.mjs` (4 tests), the screenshots and the harnesses under `docs/audit/handoff/shots/W4-B/`, and
the previous handoff (its design notes are folded into this one below, unchanged where still true).

**This run re-verified every claim and closed the gaps it found:**

- `npm run check` ok · `npm test` **232/232** (5 in `tests/pwa.test.mjs`) · `npm run build` ok
  (55 files, 14 fingerprinted, "sw.js precaches 25 shell files (271.8 KB raw)", "every local reference verified").
- **Chromium against `dist/` (`verify.mjs`, 13/13):** registers and precaches 25 shell entries under
  `soi-shell-f4fc800b`; every script and stylesheet on a reload has `workerStart > 0`; an offline reload renders the
  landing shell with the web font and the banner and hits the server zero times; the paid gallery's thumbs are kept
  under `/__soi-media/<searchId>/<photoId>/<variant>` and a **re-minted** link is served offline; `/api/sessions`,
  an original and a `?download=1` link all fail offline (never cached); the studio opens offline after one visit;
  Chromium parses the manifest with `errors: []` and four icons; no CSP report or page error; a gallery saved on the
  installing visit is cached; 220 posted photos → 151 entries (150 + the manifest).
- **Chromium against the dev server on 4181 (`dev-verify.mjs`, 6/6):** worker at scope `http://127.0.0.1:4181/`,
  **0 entries** in every cache (the dev server sends `no-store`, so `npm run dev` and the e2e suite are unaffected),
  the banner shows fixed at 13 px in the token colours on the `offline` event and hides on `online`, a background
  sync dispatched over CDP reaches the page as `soi-resume-uploads`, no page errors. `sync-auto.mjs`: no
  `soi-uploads` database → no sync tag; database present → `["soi-upload-manifest"]`.
- **Gap closed — the browser behaviour is now a test, not only a harness.** `tests/pwa.test.mjs` gained a fifth
  test that builds the tree into a temp directory (one build shared with the build test), serves `dist/` with the
  production cache headers and a mock `/api`, and drives headless Chromium through: precache named by the injected
  build id with no studio/face-api entry; a reload fully served by the worker; an offline reload that renders and
  never touches the server; the gallery rule end to end (token-free keys, the stored manifest, re-minted links → 200
  offline, while an unclaimed photo, an original, a download, `/api/sessions`, `/api/admin/sessions`, `/api/health`
  and `/admin/queue` all stay on the network). It runs in ~4 s, skips (never fails) when Chromium cannot start, and
  `SOI_SKIP_BROWSER=1` skips it on purpose. CI installs Chromium before `npm test`, so it runs there.
  Along the way one harness mistake was found and avoided: Playwright's `page.waitForFunction` does **not** await an
  async predicate (the pending promise is truthy), so the test polls from Node.
- **Gap closed — the two contracts with other owners are guarded:** test 3 now fails if `#uploadForm` leaves
  `admin.html` or `admin.js` renames its `soi-uploads` database (both are what `pwa.js` keys on).
- **Headless sync verification.** Background Sync is disabled in Playwright's headless *shell*, but the `chromium`
  channel (new headless mode) exposes it, so `dev-verify.mjs` and `sync-auto.mjs` no longer need a headed window;
  the copies under `shots/W4-B/` are updated.
- **Lighthouse re-run** (the previous run had reasoned, not measured): see "Lighthouse" below.
- Screenshots refreshed on the current tree (the studio's login card gained W4-C's crew-name field since the first
  run): `landing-*-after`, `offline-landing-*`, `offline-banner-*`, `admin-375-after`, `offline-admin-375-after`,
  `offline-banner-admin-375-after`. Measured on both pages: banner top = header bottom (87 px landing at 1024,
  69 px studio at 375), fixed, 13 px, 375 px wide at 375 (no horizontal overflow).

### What the feature is (unchanged design, from the first run)

- **`sw.js` (never fingerprinted).** Precaches the guest app shell at install in a production build, runtime-caches
  in dev. Fingerprinted assets **cache-first** (immutable), unhashed assets and site images
  **stale-while-revalidate**, HTML **network-first with a cache fallback**. `/api/**` is **never** cached except
  `GET /api/media/:id?variant=preview|thumb` of the paid gallery this device holds a 30-day token for; originals,
  `?download=1`, crew media and every `/api/admin/*` route stay on the network. Everything under `/admin` is
  bypassed except the studio shell itself (`/admin`, `/admin.html`), which is network-first like any page so the
  crew's sign-in screen opens offline after one visit. The worker honours `Cache-Control: no-store`. The gallery
  cache is keyed by search + photo + variant (tokens are re-minted every ~27 min, ids are not), bounded to 150
  photos, and evicted when the saved search id changes or the page says the gallery is gone. Opaque (`no-cors`)
  responses are never stored; the worker warms the gallery with a real CORS fetch of the links the page hands it.
- **`manifest.webmanifest`** with the brand tokens (`theme_color #F2ECDB`, `background_color #FCFAF6`),
  `start_url "/"`, standalone, the SVG logo plus 192/512 PNGs and a 512 maskable PNG.
- **Offline banner** (`<div id="offlineBanner" hidden role="status">`) on both pages, `position: fixed` just under
  the sticky header (CLS 0, never covers the brand or the menu button), 13 px, linen/umber with a terracotta rule.
- **`pwa.js`** (`defer` on both pages): registration after `load`, the banner, the paid-gallery bridge
  (a `MutationObserver` on `#gallery`, gated on a saved `mjGallery` record and a visible `#unlockedNotice`), the
  `soi-resume-uploads` re-dispatch, and `window.SOIPWA = { ready, requestUploadSync(), cacheGallery(), clearGallery() }`.
- **Background sync for the crew's upload manifest.** The studio registers `soi-upload-manifest` when it goes
  offline and an IndexedDB database `soi-uploads` exists (probed with `indexedDB.databases()`, never opened, so
  admin.js's own upgrade still runs). The worker's `sync` handler posts every open studio tab `soi-resume-uploads`;
  a service worker holds no `File` objects, so waking the page is all it can do. **admin.js does not listen for the
  event yet** — see requests.
- **`scripts/build.mjs`** keeps `sw.js` unhashed, injects the shell list and an 8-hex build id into the copy in
  `dist/`, verifies every precached path and manifest icon exists, and reports the precache weight against a 400 KB
  budget (25 files, 271.8 KB raw).

Deliberate deviations (unchanged): `admin.html` gets the worker and the banner but **no manifest link** (the
installable app is the guest site; installing from `/admin` would open `/`); the precache is the **guest shell
only** (no `admin.js`, no face-api bundle, no images); icons were rendered with the repo's `sharp` in a scratch
script (`shots/W4-B/icons.mjs`), not a new project script.

### Lighthouse

`npm run lighthouse` (Chrome = Playwright's Chromium 1243 via `CHROME_PATH`; the dev server on 4190; three runs,
median): **LCP 1815 ms (budget 1800), FCP 1761, TBT 0, CLS 0.0000, script transfer 34,421 B (budget 40,960),
image 29 KB** — every budget passes except LCP by **15 ms**, all three runs within 1783–1817 ms, LCP element =
the hero image. The machine was running four agents' suites at the time (load average 77–80 on a Mac), so a single
run cannot attribute 15 ms; an interleaved A/B on temp copies of the tree (no `pwa.js` tag / the current `defer`
tag / `defer fetchpriority="low"`, two rounds of two runs each, same port, same load) was run to settle it:

| variant | round 1 (load ≈ 80) | round 2 (load ≈ 10) |
|---|---|---|
| control — no `pwa.js` tag (script 30,583 B) | LCP 1815 · 1750 | LCP **1754 · 1755** |
| current — `<script src="pwa.js" defer>` (34,421 B) | LCP 2778 · 3284 (FCP 2230 · 2700 — a load spike across the whole page) | LCP **1728 · 1724** |
| `defer fetchpriority="low"` (34,421 B) | LCP 1997 · 1759 | LCP **1755 · 1753** |

On the quiet round every variant passes and the current tag is no slower than having no `pwa.js` at all
(differences of ±30 ms are the run-to-run noise; FCP moves with LCP in every case). **Verdict: the 15 ms miss was
machine load, not the worker or `pwa.js`; the tag stays as it is** (no evidence that `fetchpriority="low"` buys
anything). TBT 0, CLS 0.0000 and the 40 KB script budget hold in all 15 runs; `pwa.js` adds 3.8 KB of gzip
transfer (30.6 → 34.4 KB). A final gate run on the quiet machine is recorded under "How to verify".
Raw numbers: `…/scratchpad/W4-B/lh/summary.txt` and the `*-round*.log` files beside it.

## Files changed

New this workstream (all mine): `sw.js`, `pwa.js`, `manifest.webmanifest`, `assets/soi-icon-192.png`,
`assets/soi-icon-512.png`, `assets/soi-icon-maskable-512.png`, `tests/pwa.test.mjs`, this handoff and
`docs/audit/handoff/shots/W4-B/`.

Edited (only my regions):

- `index.html` — three hunks: `pwa.js` on the deferred script line; `<link rel="manifest">`, `apple-touch-icon`
  and the three web-app meta tags; the `#offlineBanner` div as the first element in `<body>`.
- `admin.html` — two hunks: the `#offlineBanner` div after `<body>`; `<script src="pwa.js" defer>` after `admin.js`.
  W4-A's upload/resume markup and W4-C's login markup untouched (re-read before every edit; no edit was needed
  this run).
- `scripts/site-files.mjs` — `pwa.js`, `sw.js`, `manifest.webmanifest` in the deployed list.
- `scripts/build.mjs` — `STABLE`, `shellFiles()`, the precache injection, the precache/icon verification, the
  report line.

This run's edits: `tests/pwa.test.mjs` (shared temp build, `serveDist()`, the browser test, the two contract
guards), `docs/audit/handoff/shots/W4-B/{dev-verify,sync-auto}.mjs` (headless `chromium` channel), the refreshed
PNGs, this file. Not touched: `app.js`, `admin.js`, `worker.js`, any CSS, `.htaccess`, `vercel.json`,
`scripts/dev.mjs`, `package.json`, `README.md`, `tests/site.test.mjs` (green), the e2e specs, `dist/` is a build
artefact (rebuilt from the current tree).

## Tasks done (by id)

**W4-B — PWA and service worker** (no F-numbers in the fix prompt):

| Item | Result |
|---|---|
| `sw.js` caching the app shell and fingerprinted assets | Done; verified by test 5 and `verify.mjs` 1/1b/2/3/3b. |
| …plus paid-gallery previews for offline revisits | Done; token-free keys, 150-photo bound, evicted per search; verified by test 5 and `verify.mjs` 4/5/10/11. |
| `manifest.webmanifest` | Done; test 1 + `verify.mjs` 8 (Chromium: `errors: []`, 4 icons). |
| An offline banner | Done on both pages; `dev-verify.mjs` 3/4 + screenshots. |
| Registration in both pages | Done; test 3 + `dev-verify.mjs` 1. |
| Background sync for the admin upload manifest | Done on the worker/pwa.js side; `dev-verify.mjs` 5 + `sync-auto.mjs`. admin.js's listener is W4-A's (request 3). |
| Build injects the precache manifest; `sw.js` stays unhashed | Done; test 4 + `npm run build` self-verification. |
| Never cache `/api/*` except the media rule; bypass `/admin` | Done; test 2 (source rules) + test 5 (behaviour, incl. `/api/admin/*` and `/admin/queue`). |
| CSP: no violation | `verify.mjs` 9 with the real report-only policy from `.htaccess` on every response. |
| Lead's resume checklist (re-verify, fill gaps, screenshots, handoff) | Done — this file. |

## Tests added (names)

`tests/pwa.test.mjs` — 5 tests, all passing (`npm test` 232/232 at hand-off):

1. `W4-B: the manifest parses, is listed for deployment and every icon it names ships`
2. `W4-B: sw.js never caches /api except watermarked gallery media, and never the studio`
3. `W4-B: both pages register the worker and carry the offline banner; only the guest page is installable`
   (now also guards `#uploadForm` in admin.html and `UPLOAD_DB = 'soi-uploads'` in admin.js)
4. `W4-B: the build keeps sw.js unhashed and injects a precache list of files that exist`
5. **new** `W4-B: in Chromium the built worker precaches the shell, renders the landing page offline and keeps only the paid gallery`

## How to verify (commands and my port)

```sh
cd "/Users/ankithkotian/Documents/mambo jambo photos website"
npm run check && npm test                 # 232/232 (5 in tests/pwa.test.mjs; test 5 drives headless Chromium, ~4 s)
node --test tests/pwa.test.mjs            # 5/5
SOI_SKIP_BROWSER=1 node --test tests/pwa.test.mjs   # 4 pass + 1 skipped, for a machine without Chromium
npm run build                             # … "sw.js precaches 25 shell files (271.8 KB raw)" … "every local reference verified"
PORT=4181 npm run dev                     # my port

H=docs/audit/handoff/shots/W4-B
node "$H/verify.mjs" 4187                 # 13 checks against dist/ (real headers + report-only CSP + mock /api)
node "$H/dev-verify.mjs" 4181             # 6 checks against the dev server, incl. a CDP-dispatched background sync
node "$H/sync-auto.mjs"                   # the studio registers the sync tag only when a soi-uploads database exists
CHROME_PATH="$HOME/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" npm run lighthouse
```

All three harnesses are headless now (`verify.mjs` always was; the other two use the `chromium` channel).

**`npm run e2e` at hand-off: 265 passed, 3 skipped, 4 failed in 7.6 min** — all four failures are the same
`browserContext.close: ENOENT …/test-results/.playwright-artifacts-N/traces/…trace` (another agent's suite cleared
`test-results/` underneath the run; two concurrent Playwright runs in one checkout collide on that directory —
the predecessor hit exactly this). **Re-run in isolation, all four pass** (`public.spec.mjs:20`, `:56`,
`guest-product.spec.mjs:360`, `:386`, mobile-375: 4/4 in 5 s). Effectively **269/269 with 3 skipped**; the
screenshot baselines all pass with the worker registered. A clean full-suite run with the tree quiescent is still
the integrator's to take. Log: `…/scratchpad/W4-B/e2e.log`.

**`npm run lighthouse` at hand-off (quiet machine, load ≈ 9): gate passes, exit 0** — LCP 1761 / 1749 / 1757 ms
(median 1757, budget 1800), FCP ≈ 1700, TBT 0–2 ms, CLS 0.0000, script 34,421 B (budget 40,960), image 30,540 B
(budget 122,880), accessibility 1.0. Log: `…/scratchpad/W4-B/lighthouse-final.log`; reports in `.lighthouseci/`.

## Screenshots and traces (paths)

`docs/audit/handoff/shots/W4-B/` (dev server = source tree on 4181; dist = `dist/` on 4187):

- `landing-1024-before.png`, `landing-375-before.png`, `admin-375-before.png` — before the wave.
- `landing-online-1024-after.png`, `landing-online-375-after.png` — after, online, dev server (first run).
- `landing-1024-after.png`, `landing-375-after.png` — after, online, served from `dist/` (refreshed this run).
- `offline-banner-1024-after.png`, `offline-banner-375-after.png`, `offline-banner-admin-375-after.png` — the
  banner under the header on the `offline` event (refreshed this run).
- `offline-landing-1024-after.png`, `offline-landing-375-after.png` — a reload with the network off against
  `dist/`: the whole landing shell renders from the cache (refreshed this run).
- `offline-admin-375-after.png` — the studio's sign-in screen offline after one online visit (refreshed).
- `admin-375-after.png` — the studio online at 375 on the current tree (refreshed).
- `verify.mjs`, `dev-verify.mjs`, `sync-auto.mjs`, `icons.mjs` — the harnesses and the icon generator.

Scratch transcripts (session scratchpad, `…/scratchpad/W4-B/`): `verify-rerun.txt`, `dev-verify-rerun.txt`,
`sync-auto-rerun.txt`, `lighthouse.log`, `lh/summary.txt` (the A/B), `debug-reminted.mjs` (the waitForFunction
finding), `sync-probe.mjs` (headless Background Sync probe). Lighthouse reports: `.lighthouseci/` (gitignored).

## Deploy or dashboard actions needed

1. **Deploy from `dist/` as usual.** The build writes `dist/sw.js` (with the injected precache list) and
   `dist/manifest.webmanifest`; both must ship, and `sw.js` **must be served from the web root** (a worker's scope
   is its own directory).
2. **`sw.js` must never be cached long.** `.htaccess` already sends `no-cache, must-revalidate` for `\.(html|js|css)$`,
   which covers it and can never match the hashed-asset rule. Vercel serves unlisted static files with
   `max-age=0, must-revalidate` by default; request 2 below makes it explicit.
3. **After the first deploy**, on the live site: `curl -sI https://photos.surfersofindia.com/sw.js` →
   `cache-control: no-cache, must-revalidate`; `curl -sI https://photos.surfersofindia.com/manifest.webmanifest` →
   a `content-type` of `application/manifest+json` (if it is `application/octet-stream`, see request 2); open the
   site, DevTools → Application → Service Workers (activated, `soi-shell-<id>` present) and Manifest (installable,
   four icons); load once, network off, reload — the landing page must still render.
4. **Watch the report-only CSP console once on the live hosts** (nothing logged here with the identical policy).
5. No Worker, D1, secret, R2 or Space action; no migration.
6. **Rollback** is one deploy: remove `sw.js` from the upload and the old worker keeps serving its cache until it is
   replaced; a clean kill switch is a `sw.js` that calls `self.registration.unregister()`.

## Requests to other owners (file, exact change, why)

1. **`scripts/dev.mjs` (lead)** — add `'.webmanifest': 'application/manifest+json'` to the `types` map. Why: the
   dev server serves the manifest as `application/octet-stream` today (re-checked with curl this run); Chromium
   parses it anyway, so this is correctness, not a fix. **Still open.**
2. **`vercel.json` (lead / W1-E)** — add a headers entry
   `{ "source": "/sw.js", "headers": [{ "key": "Cache-Control", "value": "no-cache, must-revalidate" }] }`. Why: the
   service worker must be revalidated on every check and the file is explicitly listed for HTML only today.
   `.htaccess` already covers `sw.js`; if Hostinger's server does not know the `.webmanifest` extension, add
   `AddType application/manifest+json .webmanifest` inside a `<IfModule mod_mime.c>` block. **Still open.**
3. **`admin.js` (W4-A)** — two lines to hook the resumable batch into the worker (**still not wired**: `grep` finds
   no `soi-resume-uploads` or `SOIPWA` in admin.js):
   - when a batch stalls because the device went offline: `window.SOIPWA?.requestUploadSync();` (resolves `false`
     on Safari/Firefox, where your own retry stays in charge);
   - `addEventListener('soi-resume-uploads', () => { /* re-open the soi-uploads manifest and offer Resume */ });`
     — the worker fires this when the connection is back, even if the tab was left in the background. `pwa.js`
     already registers the tag by itself when the studio goes offline and a `soi-uploads` database exists, so the
     listener alone is enough. Why: the worker cannot hold `File` objects; only the page can finish the batch.
4. **`app.js` (W3-A / the public-site owner)** — optional, two lines that make the offline gallery exact instead of
   DOM-derived: after `/access` answers, `window.SOIPWA?.cacheGallery(currentSearch.searchId, photos.map(p => ({ photoId: p.photoId, url: p.thumbUrl || p.url })));`
   and where an expired gallery record is dropped, `window.SOIPWA?.clearGallery();`. Why: `pwa.js` reads the
   rendered grid today, which works (tests 5 and `verify.mjs` 4/5/10 exercise exactly that path) but is inferred.
   **Still open.**
5. **`README.md` (lead)** — a paragraph under "Stack" or "Deployment": "The site is a PWA: `manifest.webmanifest`
   makes it installable and `sw.js` (registered by `pwa.js` on both pages) precaches the guest app shell, serves
   fingerprinted assets cache-first and HTML network-first, and keeps the watermarked previews of a paid gallery
   for offline revisits. It never caches `/api` otherwise, never caches originals, and honours `no-store`, so
   `npm run dev` is unaffected. `npm run build` injects the precache list into `dist/sw.js`; deploy it from the web
   root. `tests/pwa.test.mjs` drives the built worker in headless Chromium; `SOI_SKIP_BROWSER=1` skips that test."
   **Still open.**
6. **`lighthouserc.json` (lead / W1-E)** — no change requested. The gate's LCP budget is met by this tree on a
   quiet machine (A/B above); when four agents run suites at once the median lands 0–30 ms either side of 1800 ms,
   which is a property of the host, not the page. If the lead wants the gate immune to that, the lever is
   `numberOfRuns: 5` (median of five), not a looser budget.

## Cut or blocked (with reason)

- **Not verified on real hosts or real devices:** Hostinger/Vercel header behaviour for `sw.js` and
  `.webmanifest`, an actual install prompt on Android/iOS, Safari and Firefox (neither supports Background Sync —
  `requestUploadSync()` returns `false` there by design; Safari evicts service-worker caches after 7 days of no
  use), and the cross-origin (Hostinger) media path, where caching depends on the Worker's `ALLOWED_ORIGIN` CORS
  header. Everything above was measured in Chromium on this Mac against local mocks.
- **No real paid gallery was cached:** the gallery path ran with the real `pwa.js` on the real `index.html`, with the
  paid state injected into the DOM exactly as `renderGallery()` writes it and a mock `/api/media`. No payment, no
  crew login, no production write.
- **The resume contract is one-sided until W4-A wires it** (request 3): the tag registration, the sync handler and
  the page event are verified; nothing in admin.js reacts to the event yet, so an interrupted batch is still
  resumed only through admin.js's own on-load resume panel.
- **`dist/` was rebuilt** by `npm run build` and by the tests' temp builds (the latter never touch the repo's `dist/`).
- **Observation, not mine to fix:** at a 375 px emulated viewport, going offline in Chromium expands the landing
  page's layout viewport to ~720 px because the `.ticker-track` marquee is 1 453 px wide; it happens with the banner
  removed and no `offline` event, so it is not caused by this change (`overflow: clip` on `.ticker` in `site.css`
  would make it impossible).
- **Cashfree:** untouched. The worker never caches `/api/payment/*` or the SDK, so the CLAUDE.md Cashfree flow does
  not apply.
