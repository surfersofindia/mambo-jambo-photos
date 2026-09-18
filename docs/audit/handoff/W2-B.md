# W2-B · End-to-end and visual tests — handoff (wave 2, resumed run; dev port 4181, Playwright webServer 4195)

## Summary

The Playwright suite exists and is green: **131 passed, 3 skipped** (`npm run e2e`, Chromium only, four viewport projects), made of the mocked public flow (sessions → selfie → results → lightbox → checkout → paid → `?order_id=` return, zero match, 30-day resume, Back button), the mocked crew flow (login → three-file queue with the text file left out → publish with the streaming framed body → sessions tab with the W2-D money strip → edit-modal dirty guard → typed delete confirm → upload-more duplicate choice, plus the F29 duplicate-session guard, the F10 mid-batch re-auth pause and sign-out), 32 screenshot baselines (8 screens × 375/768/1024/1440) and an axe pass (`wcag2a` + `wcag2aa`, `best-practice` off) on eleven screens with **zero violations today — no `test.fixme` was needed**. `npm run e2e` and `npm run verify` are wired, and `.github/workflows/ci.yml` runs `npm run verify` on push/PR (the remote is GitHub).

Inherited from the first wave-2 run and kept: `playwright.config.mjs`, `tests/e2e/helpers/{fixtures,flows,mock-api}.mjs` and the two devDependencies (already installed; Chromium 1243 was cached). Fixed in the inherited files: a selfie path built from `URL.pathname` (percent-encoded spaces in the repo path → ENOENT), raw control bytes in the ZIP stub that made `grep` treat `mock-api.mjs` as binary, and the `/api/admin/stats` route (W2-C/W2-D contract) plus `width`/`height` on every photo object, which the mock did not have. No spec files, scripts or CI existed.

Every `/api/**` request is intercepted at the context level; an un-mocked one is answered 404, recorded, and fails the test in fixture teardown — proven by a test. `sdk.cashfree.com` is blocked; the paid path uses a `window.Cashfree` stub, so the suite never reaches the production Worker, D1, R2, Cashfree or the face service, and never calls `POST /api/admin/login` for real.

The one thing that cost time: a **screenshot flake at 768×1024** where one results tile (always the second tile of the second row, `e2e-photo-05`) was photographed as an empty box while the DOM said loaded, decoded, opacity 1 and a canvas draw of the same `<img>` returned real pixels. Bisected to Chromium's checker-imaging (a tile committed without its image and filled in on a later frame that, under a four-worker load, does not arrive before the capture); `--disable-checker-imaging` in `launchOptions` took it from 3–6 failures in 24 runs to **0 in 144** (three 48-run loops) and 128/128 for the whole screenshot spec repeated four times. The captures use `page.screenshot()` + `toMatchSnapshot()` rather than `toHaveScreenshot()` (same files, same tolerance, same `--update-snapshots`); the reason is in the spec header.

**`npm run verify` passed at hand-off** (exit 0: `check` → `test` 129/129 → `build` 49 files, 13 fingerprinted → `CI=1 npx wrangler deploy --dry-run` → `e2e` 131 passed, 3 skipped). One earlier attempt stopped at `npm test` on W2-A's new `tests/fonts.test.mjs` while `index.html`'s `<head>` was being rewritten by another session (the preload count went 0 → 1 → 2 across my runs); it settled before my final run.

## Files changed

New (all mine):
- `tests/e2e/public.spec.mjs` — guest flow, redirect return, 30-day gallery, mock guard (15 tests × 2 projects).
- `tests/e2e/crew.spec.mjs` — sign-in, upload, sessions tab (14 tests × 2 projects).
- `tests/e2e/screenshots.spec.mjs` — 8 screens × 4 projects, with a failure-time `images.json` diagnostic.
- `tests/e2e/axe.spec.mjs` — 11 screens × 4 projects (44, 3 skipped: the phone-only menu test on non-phone projects).
- `tests/e2e/helpers/screenshot.css` — capture-only stylesheet (`.photo-row{content-visibility:visible}` so a full-page capture of the upload queue has a stable height).
- `tests/e2e/__screenshots__/screenshots.spec.mjs/*-darwin.png` — 32 baselines, 14 MB (the results/lightbox/hero PNGs are photo-heavy).
- `.github/workflows/ci.yml` — Node 22, `npm ci`, `npx playwright install --with-deps chromium`, `npm run verify`, report/failure artifacts, and a one-off Linux baseline hand-back (see "How to verify").
- `docs/audit/handoff/W2-B.md` (this file), `docs/audit/handoff/shots/W2-B/README.md` + 16 PNGs (the 375/1024 pairs).

Inherited and edited:
- `playwright.config.mjs` — `launchOptions.args: ['--disable-checker-imaging']`; `expect.toMatchSnapshot` tolerance (0.005 / 0.2); `ignoreSnapshots` when no baselines exist for the running platform (with a one-line warning) so a fresh Linux runner drives every screen without failing on "snapshot missing".
- `tests/e2e/helpers/mock-api.mjs` — `GET /api/admin/stats` (`state.stats`, contract shape; `null` → 404), `POST /api/admin/undo-review` (409), `width`/`height` on preview/access/admin photo rows, the multipart selfie recorded by its part header (Chromium does not hand Playwright the file bytes), ZIP stub bytes as escapes.
- `tests/e2e/helpers/flows.mjs` — `fileURLToPath` for the selfie; `settleImages` also awaits `img.decode()`; `runSearch` waits for `figure.is-loading` to clear; `queueFiles` waits out the form's 100 ms smooth scroll to Publish.
- `package.json` — scripts `e2e` and `verify` (the devDependencies were already there from the first run).
- `package-lock.json` — unchanged by me (it already carried `@playwright/test` 1.63.0 and `@axe-core/playwright` 4.13.0).

Not touched: everything else. `git diff` on `app.js`, `admin.js`, `admin.html`, `index.html`, `worker.js`, `site.css`, `soi-tokens.css` contains nothing of mine.

## Tasks done (by id)

Workstream block items (no F-number; the master prompt's W2-B block):
- **Install `@playwright/test`** — present (1.63.0) with `@axe-core/playwright` 4.13.0; Chromium 1243 from `~/Library/Caches/ms-playwright` matches, no download needed here.
- **Public flow with the API mocked** — done: sessions → selfie (a `.txt` is refused with the drop-zone copy; consent gates the submit) → results (nine tiles, title "9 waves. All you.", meta line, unlock button with ₹700) → lightbox (buttons, arrow keys, wrap-around, pointer-aware hint, Escape) → checkout dialog ("9 photos · ₹700", "Pay ₹700", eyebrow, native `pattern` gate and the JS gate behind it, Cancel) → the SDK-blocked failure path → the paid path through a `window.Cashfree` stub (verify → originals with Download links → `#downloadAll`/`#downloadAllBar` → lightbox "Original" → `mjGallery` saved with the gallery token, `mjCheckout` cleared) → cancelled-in-modal path → zero match (`#noMatches`, nothing for sale, action bar hidden, "Try another selfie" lands on the selfie stage with the session kept) → Back/Forward.
- **`?order_id=` return** — three cases: the searching tab (verify runs, "Paid.", nine Download links, URL cleaned, gallery token saved), a different browser (no stored search → "Payment received." naming the order and the contact address, no verify call), a failed verification ("Paid, but…" with the order number).
- **Crew flow with the API mocked** — done: wrong password → inline error; right password → studio, health pill `ok`, token in `sessionStorage`, password never recorded by the mock; upload queue with three files (two rows, "2 ready. 1 left out (…): notes.txt." as a `warning`, not an error) → Publish → pre-flight dashboard call before `POST /api/admin/sessions` → two framed uploads (`[uint32][JPEG preview][original]`, `application/octet-stream`, preview ≤ 600 px on the long edge, `width`/`height` params, JPEG thumbs) → publish → "Live. Faces are indexing — watch it in Sessions."; sessions tab (cards, badges, totals, money strip "12 searches · 3 unlocks · ₹2,100" and muted "No searches yet"; strip hidden on 404 and on `unmigrated`); edit modal dirty guard (Escape/× on a dirty form → "Discard changes?"; Cancel keeps the edit; Discard closes; Save sends the PUT and re-renders the card); delete typed-confirm (label, disabled until the exact trimmed title, Enter on a partial name does nothing, Cancel keeps both cards, delete removes one and focus moves to the next card); upload-more duplicate choice (Skip/Replace/Keep both change the button count and the row preview; `onDuplicate` on the wire; "1 copy saved as SOI_0412-2.jpg", "1 skipped.", "1 replaced."); F29 duplicate-session guard offering "Upload more to that session"; F10 re-auth pause mid-batch (wrong then right password, batch carries on with the fresh token); Sign out → `POST /api/admin/logout`; a stale token → login screen.
- **Screenshot tests at 375/768/1024/1440** — hero, finder, results, lightbox, admin login, upload, sessions, plus checkout: 32 baselines, stable across 144 targeted and 128 full repeats.
- **axe on every screen, zero violations** — 11 screens (hero, finder, results, zero match, lightbox, checkout, phone menu open, admin login, upload queue, sessions, review tab) × 4 projects: **0 violations** with `wcag2a`/`wcag2aa`. Each test asserts axe ran > 12 rules and annotates the report with the counts (25 passed / 24 `color-contrast` "needs review" nodes on the landing page — text over photos and gradients that axe cannot compute; W1-D measured those by pixel sampling). With every rule on, the admin login only trips `best-practice` landmarks (`landmark-one-main`, `region`), which the brief keeps off.
- **`npm run e2e` / `npm run verify`** — added.
- **CI** — `.github/workflows/ci.yml` (remote: `github.com/surfersofindia/mambo-jambo-photos`).

## Tests added (names)

`tests/e2e/public.spec.mjs` (mobile-375, desktop-1024):
1. guest flow › sessions → selfie → results: three sessions, consent gate, nine previews
2. guest flow › favourites: hearts, the count, the filter and its empty state
3. guest flow › lightbox: opens on a tile, steps with buttons and arrow keys, closes with Escape
4. guest flow › checkout dialog: count and price in the heading, phone validation, cancel
5. guest flow › checkout without the payment SDK: the order is created, the failure is shown and the dialog stays open
6. guest flow › paid in the modal: verify unlocks the originals, download links and the 30-day gallery token
7. guest flow › cancelled in the modal: the dialog reopens with a retry message and nothing is unlocked
8. guest flow › zero match: the starfish state ends in "Try another selfie" and nothing is offered for sale
9. guest flow › the browser Back button returns from the results to the finder
10. redirect return (?order_id=) › the tab that searched: verify runs, the originals render as "Paid." and the URL is cleaned
11. redirect return (?order_id=) › a different browser: no stored search, so the page says who to contact and never calls verify
12. redirect return (?order_id=) › a failed verification keeps the order number on screen
13. 30-day gallery › the resume notice reopens a paid gallery from localStorage
14. 30-day gallery › an expired gallery token clears the notice and says so
15. mock guard › an un-mocked /api request is refused with 404 and recorded — it never reaches the dev-server proxy

`tests/e2e/crew.spec.mjs` (mobile-375, desktop-1024):
1. sign in › a wrong password shows the inline error; the right one opens the studio and starts the health pill
2. sign in › Sign out revokes the token server-side and returns to the login screen
3. sign in › a stale token is refused by the first authenticated call and the crew lands on the login screen
4. upload › a pick of three files queues two photos, leaves the text file out and publishes a new session
5. upload › a pick with nothing usable keeps Publish disabled
6. upload › same date and break as an existing session: the guard offers "Upload more to that session"
7. upload › an expired token mid-batch pauses for a sign-in and the batch carries on
8. sessions tab › cards, badges, totals and the money strip from /api/admin/stats
9. sessions tab › the money strip stays hidden when the stats route is missing or unmigrated
10. sessions tab › edit modal: Escape and × on a dirty form ask before discarding; Save sends the change
11. sessions tab › delete asks for the session name typed exactly, then removes the card and moves focus on
12. sessions tab › upload more: files already in the session are flagged and the duplicate choice changes what is sent
13. sessions tab › upload more with "Skip" sends only the new file; "Replace" reports the replacement
14. sessions tab › Add photos refuses a pick with an unsupported file before opening the dialog

`tests/e2e/screenshots.spec.mjs` (all four projects): public site › hero · finder (selfie stage) · results · lightbox · checkout dialog; crew studio › admin login · upload (queue with two photos, one left out) · sessions.

`tests/e2e/axe.spec.mjs` (all four projects): axe: public site › hero (landing, sessions loaded) · finder (selfie stage, preview attached) · results · zero match · lightbox · checkout dialog · navigation menu open (phone); axe: crew studio › admin login · upload (queue with two photos) · sessions · review tab (empty queues).

Fixture-level (every test): the `api` fixture asserts `api.escaped` is empty at teardown; the `pageErrors` fixture collects `pageerror` events (asserted empty in the main flows).

## How to verify (commands and my port)

```sh
cd "/Users/ankithkotian/Documents/mambo jambo photos website"
npm run check && npm test                 # 129 unit tests, 129 pass at hand-off
npm run e2e                               # starts PORT=4195 npm run dev itself (reuses one if running); 131 passed, 3 skipped, ~55 s
npm run e2e -- --project=desktop-1024     # one viewport; mobile-375 | tablet-768 | desktop-1024 | wide-1440
npm run e2e -- tests/e2e/axe.spec.mjs     # one spec
npm run e2e -- --update-snapshots         # re-baseline after an intended visual change (W2-A's fonts, W2-D's strip…)
npm run e2e -- --repeat-each 4 tests/e2e/screenshots.spec.mjs   # the stability loop I used (128/128)
npm run verify                            # check → test → build → CI=1 wrangler dry-run → e2e; exit 0 at hand-off (~2 min)
npx playwright show-report                # after a CI-style run (reporter html is on when CI=1)
```

Tail of the last full `npm run e2e` (2026-09-17, after re-baselining against the tree with W2-A's fonts in place):

```
  3 skipped
  131 passed (54.2s)
```

Tail of `npm run verify` at hand-off (exit 0; the "health check failed: face fetch failed" line is a Worker unit test's expected console output):

```
ℹ tests 129
ℹ pass 129
ℹ fail 0
Production website built in dist/ (public assets only): 49 files, 13 fingerprinted, every local reference verified.
--dry-run: exiting now.
  3 skipped
  131 passed (52.9s)
```

Baselines are `darwin` only. On another platform the config prints `[e2e] no screenshot baselines for <platform>; visual comparisons are skipped this run` and runs everything else; generate that platform's set with `npm run e2e -- --update-snapshots` and commit it. CI does this for Linux on its first run and uploads the set as the `linux-screenshot-baselines` artifact (commit it to switch the comparison on in CI).

## Screenshots and traces (paths)

- Baselines: `tests/e2e/__screenshots__/screenshots.spec.mjs/<screen>-<project>-darwin.png` (32 files, 14 MB total).
- Handoff copies (375 and 1024): `docs/audit/handoff/shots/W2-B/<screen>-{375,1024}.png` + `README.md` (16 PNGs, 5.5 MB). No "before" set exists: this workstream changed nothing visual; these are the first baselines.
- Flake investigation (scratchpad, this session): `scratchpad/W2-B/r768-repro*.log` (the 20/24/48-run loops: repro3 = visibility toggle, repro7 = scroll nudge 10/48, repro8 = quiet gap 5/48, repro9–11 = `--disable-checker-imaging` 48/48 ×3), `shots-stability*.log`, `axe-run1.log`, `e2e-final.log`, `verify1.log`, the tile crops `t5-actual.png` / `t5-expected.png`, and the unzipped trace of one failing run in `trace-results768/`. Playwright traces are `retain-on-failure` into `test-results/` (deleted at hand-off; re-created by any failing run).

## Deploy or dashboard actions needed

None for production. Repository-side, when the wave is committed:
1. Commit `tests/e2e/__screenshots__/` with the code (14 MB of PNGs; if that is too heavy, drop the `tablet-768`/`wide-1440` baselines — the spec still runs there — or keep only 375/1024).
2. After the first CI run on GitHub, download the `linux-screenshot-baselines` artifact and commit its `*-linux.png` files so CI compares screenshots too.
3. CI needs no secrets: `wrangler deploy --dry-run` bundles without an API token here; **not verified on a GitHub runner** (nothing was pushed).

## Requests to other owners (file, exact change, why)

- **`.gitignore` (lead):** add `test-results/` and `playwright-report/`. Why: Playwright writes traces, diffs and the HTML report there on every failing or CI-style run; both are untracked today and would be committed by accident.
- **`README.md` (lead), "Checks":** add `npm run e2e` (Playwright, Chromium, fully mocked `/api`, never touches production; `-- --update-snapshots` re-baselines after an intended visual change; baselines are per platform under `tests/e2e/__screenshots__/`) and `npm run verify` (check + test + build + wrangler dry-run + e2e; what CI runs). Why: the scripts exist and CI depends on them.
- **`index.html` `<head>` (W2-A), observation only:** during my run the page's font preloads went 2 → 0 → 1 → 2 as two sessions edited the head (W2-A's `tests/fonts.test.mjs` failed in between). It was consistent again at hand-off (`npm run verify` green), but whoever rewrites `index.html` whole should know W2-A's preload pair lives there. The baselines were taken with the self-hosted fonts in place; if the fonts change again, `npm run e2e -- --update-snapshots`.
- **`admin.html` `<body>` (W2-D), optional, best-practice only:** wrap the login card and the studio in a `<main>` landmark (axe `landmark-one-main`, `region` × 6 — `best-practice` tags, off in the gate, so nothing fails). Why: the only axe findings on the admin pages with every rule enabled.
- **`index.html` (lead / W3-A), informational:** axe marks 24 `color-contrast` nodes on the landing page and 3 on the admin login as "needs review" (text over the hero photo/gradient and the scrim). Not violations; W1-D's pixel-sampled ratios cover the hero note (9.7–15:1). No change requested.
- **`app.js` (not mine), informational:** the gallery tile blank was a Chromium compositor artefact, not an app bug — the DOM state was always right. Nothing to change.

## Cut or blocked (with reason)

- **Linux baselines:** not generated (no Docker on this machine; Chromium rasterises text differently on Linux, so the darwin set cannot be reused). The config skips comparisons where a platform has no set; CI hands a Linux set back as an artifact on its first run.
- **CI itself:** written and YAML-validated locally; **not run** (nothing pushed this wave). `npm ci` on a fresh runner may print npm's allow-scripts notice (W1-E); `npx playwright install --with-deps chromium` needs apt access, which `ubuntu-latest` has.
- **Verified against the mock, not the real Worker:** every crew behaviour (login, uploads, publish, stats, edit, delete, upload-more, re-auth, logout), the paid checkout (SDK stub), verify, access/previews refresh, the ZIP link and the redirect return. Only the shapes were taken from `worker.js` and the W2-C/W2-D contracts. Nothing was called on production; `GET /api/sessions` was not read either — the suite mocks it too.
- **Cashfree:** the checkout tests exercise `app.js`'s existing `/api/checkout` → `cashfree.checkout()` → `/api/payment/verify` sequence against a stub; no Cashfree code, config or webhook was touched, so the CLAUDE.md Cashfree flow (App-ID ask, telemetry, progress feedback) was not run. The real Drop-in, sandbox cards/UPI and the webhook remain unverified from here (STATUS.md "go-live status" still applies).
- **HEIC in the crew queue, Safari/Firefox, real devices, throttled Android:** not covered (Chromium only, by design of the brief).
- **The `mock guard` test clears `api.escaped` after proving the recording**, because the same fixture would otherwise fail the test at teardown; the teardown assertion itself is exercised by every other test staying at zero escapes. A deliberate negative test of the teardown (`test.fail()`) was not added.
- **Baseline weight:** 14 MB of PNGs for 32 screens. Masking the photo tiles would shrink them and remove the one thing that ever flaked, but would also stop catching tile-aspect regressions (W2-C's dimensions land in these tiles in wave 3). Left as full captures; the lead can decide.
