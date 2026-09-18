# 10/10 program — STATUS

Lead log for the multi-agent program defined in `docs/audit/SOI-Master-Prompt.md`. Updated after every wave. Companion spec: `docs/audit/SOI-Fix-Prompt.md` (**reconstructed by the lead on 2026-09-17 because the original was missing** — see its header; if the original turns up it wins).

Working mode: the tracked tree was clean at HEAD `04374b0`, so no snapshot commit was made. Agents edited this directory under strict file ownership and left everything **uncommitted**; nothing was deployed. No crew password exists on this Mac, so every crew flow (uploads, sessions, review) was verified against a **mocked API** in Playwright, never against production, and no `zz-test-*` sessions were created.

---

## Wave 1 — fix batch (2026-09-17, five agents in parallel) — DONE, not deployed

### Full check after integration
`npm run check` ok · `npm test` **100/100** (was 71) · `npm run build` ok (38 files, 12 fingerprinted, every reference verified) · `npx wrangler deploy --dry-run` ok (86.15 KiB / 20.20 KiB gzip). Diff: 22 files, +5 817 / −527 lines (4 207 of the additions are `package-lock.json`).

### What each workstream shipped
| Workstream | Tasks done | Tests added | Handoff |
|---|---|---|---|
| W1-A Backend security | F1 per-IP quota on `POST /api/match` (8/10 min, 30/day, 429 + `retry-after`, fails open if unmigrated) · F2 Worker half (`x-face-key` on `/extract` and the deep health ping) · F3 revocable crew tokens (migration 0011, `POST /api/admin/logout`, signature-only fallback) · F4 Cashfree webhook 5-minute timestamp window (seconds or ms) + `payment_status` gate · F4b `/api/sessions` cover lookup as one `LEFT JOIN` · `GET /api/health` reports `migrations` | 10 new + 2 rewritten in `tests/worker.test.mjs`, 2 real-SQLite tests in `tests/indexing.test.mjs` | `docs/audit/handoff/W1-A.md` |
| W1-B Face service | F2 Space half (`x-face-key` enforced only when `FACE_API_KEY` is set, constant-time, checked in ASGI middleware before the body is parsed; `/`, `/health`, `GET`/`HEAD /extract` stay open) · inference moved to worker threads (`inference_workers: 2`): three concurrent `/extract` calls succeed and overlap · tiny-image 500 fixed · cold start measured locally (see below) | `face-api/test_auth.py` (8 pytest tests; needs a Python 3.10 venv — `face-api/hf_venv` is unusable, see handoff) | `docs/audit/handoff/W1-B.md` |
| W1-C Crew studio | F5 previews 600 px / thumbs 320 px · F6 `preview-worker.js` (OffscreenCanvas pool of two, main-thread fallback) · F7 rAF-coalesced DOM writes, `content-visibility` · F8 lazy 96 px queue thumbs · F9 preview prefetch (30-photo batch 8.1 s → 1.5 s over loopback) · F10 re-auth pause/resume on 401 · F11 title/Notification when hidden · F12 inline "Retry failed" · F13 "n of N photos · MB" + `aria-live` · F14 admin contrast (all chip pairs ≥ 4.5:1) · F17 no admin text under 11 px, topbar no longer overflows at 375 · F27 focus management · F28 "More" menu flips · F29 duplicate-session confirm with "Upload more to that session" | 6 in `tests/review-images.test.mjs` | `docs/audit/handoff/W1-C.md` |
| W1-D Public site | F14 public contrast · F15 results padding under the sticky bar · F16 crew-login link removed from the footer · F17 public text ≥ 11 px · F18 skeleton row count + matching-stage floor (CLS 0 through the finder) · F20 hero `srcset` + preload · F22 privacy link no longer cancels a search · F23 drag-and-drop selfie · F24 48 px targets · F25 flick velocity + pointer-aware hint · F26 (grid value kept at 200 px with reason) · Worker preconnect, `text-wrap`, `tabular-nums` · two pre-existing bugs fixed (closed lightbox rendered on phones; results swap flashed the footer) | 8 in `tests/site.test.mjs` | `docs/audit/handoff/W1-D.md` |
| W1-E Build and perf tooling | F20 files (`assets/brand-surf-wide-768.webp` 29 242 B, `-1280.webp` 60 850 B via `scripts/images.mjs` + `sharp`) · F21 fingerprinted build with self-verification, `immutable` rules in `.htaccess` and `vercel.json` · `@lhci/cli` + `lighthouserc.json` + `npm run lighthouse` | build self-verifies (no `tests/` file; not in ownership) | `docs/audit/handoff/W1-E.md` |

### Lead integration actions
- Wrote the reconstructed `docs/audit/SOI-Fix-Prompt.md`; wrote `docs/audit/handoff/` briefs (scratchpad) and this file.
- `.gitignore`: added `.lighthouseci/`, `face-api/__pycache__/`, `face-api/.pytest_cache/` (a tracked `face-api/__pycache__/main.cpython-314.pyc` should be `git rm --cached` at the next commit).
- `scripts/dev.mjs`: gzip for html/js/css/svg when the client accepts it (W1-E's request, so Lighthouse transfer budgets measure what production serves). Verified: `app.js` 47 538 B → 14 476 B gzip.
- `README.md`: build/deploy-from-`dist/`, guest quota, 600/320 px previews + `preview-worker.js`, migrations 0010/0011, `FACE_API_KEY`, logout, webhook window, health `migrations` field, `npm run images` / `npm run lighthouse`.
- Canonical screenshots (8 screens × 1024/375, mocked results/lightbox/checkout/admin) before and after the wave: `scratchpad/lead/wave0-canonical/` and `wave1-canonical/` (session scratchpad), plus `docs/audit/handoff/shots/lead/wave0/`. Wave 1 vs wave 0: admin 375 px horizontal overflow gone (402 → 375 px), footer crew-login link gone, captions ≥ 11 px, no page errors except the deliberately blocked Cashfree SDK in the mocked checkout.

### Screenshots and traces
- `docs/audit/handoff/shots/W1-C/` (29 files: queue, progress, done, more-menu, dup-confirm, reauth, retry-inline, review; before/after at 1024 and 375). Traces in the session scratchpad `W1-C/out/trace-*.json`.
- `docs/audit/handoff/shots/W1-D/` (hero, finder stages, results, results-bottom, favourites-empty, zero-match, unlocked, lightbox, checkout, footer, page-bottom; before/after; `metrics-before/after.json`, `audit.mjs`).
- `docs/audit/handoff/shots/W1-E/` (source vs `dist/` landing at 1024/375; Lighthouse reports in the scratchpad and `.lighthouseci/`).
- `docs/audit/handoff/shots/W1-B/` (curl/pytest/benchmark transcripts).

### Measured
- 30-photo upload (Chromium on this Mac, loopback mock Worker): longest gap between drawn frames **8 966 ms → 24–30 ms**; longest task 27 → 17–29 ms; wall-clock 8.1 s → 1.5 s. Not measured on a throttled Android.
- Preview/thumb sizes: 7.9 KB / 4.6 KB (300/200 px) → ~25–40 KB / ~10–16 KB (600/320 px).
- Face service (local M1, real buffalo_l models): first `/health` 5.96 s cold file cache, 1.6 s warm; first face extract 9.06 s before warm-up, 0.55 s after; 3 concurrent extracts 1.7 s wall. Live Space cold start **not measured** (no restart allowed; the new startup log line will print it on first deploy).
- Lighthouse (source tree, uncompressed dev server, mobile emulation, median of 3): perf 0.94, LCP 2 779 ms, TBT 2 ms, CLS 0.009, script 58 357 B raw (18.3 KB gzip), font **231 KB**. Budgets failing today: LCP, CLS, script (raw), image (before `srcset`). Fonts (wave 2) and the now-shipped hero `srcset`/gzip are the levers.
- Public JS: `app.js` 14.5 KB gzip; all public JS ≈ 18.3 KB gzip (budget 40 KB).

### Requests between owners — resolved or carried
| From → to | Request | Status |
|---|---|---|
| W1-E → W1-D | hero `srcset` + preload markup | done in wave 1 |
| W1-B → W1-A | `x-face-key` on POST and HEAD probe | done in wave 1 |
| W1-C → W1-E | keep `new Worker('preview-worker.js')` literal hashable | done (build rewrites JS string literals; verified in `dist/`) |
| W1-E → lead | `.gitignore`, README, dev-server gzip | done |
| W1-A/B/C/D → lead | README lines | done |
| W1-A → admin.js | call `POST /api/admin/logout` on sign-out and idle sign-out | **carried to W2-D** |
| W1-C → soi-tokens.css | add `--soi-slate-ink:#43617A`, `--soi-ochre-ink:#7A5F30` tokens (currently defined locally in `admin-theme.css`) | **carried to W2-A** |
| W1-C → worker.js | persist `width`/`height` query params sent with previews | **carried to W2-C** (migration 0012 parses the original's header; the params are only a hint) |
| W1-A → app.js | honour `retry-after` on 429 | **carried to W3-A** |
| W1-A → worker.js | reuse `limiter()` for the colour search | **carried to W3-B** |
| W1-B → wrangler.jsonc | cron warm ping is fine; `max_concurrency: 3` is safe | **carried to W3-B** (confirmed) |
| W1-B → docs/runbook.md | rollout, rotation, rollback, `FACE_MAX_INFERENCE` | **carried to W4-D** |
| W1-D → W2-B | lift `shots/W1-D/audit.mjs` and the lead's `canonical.mjs` into `@playwright/test` | **carried to W2-B** |
| W1-D → W1-C | `tests/review-images.test.mjs` menu test was failing mid-wave | resolved (100/100 at the end) |

### Deploy or dashboard actions needed (in order; nothing deployed yet)
1. Push `face-api/` (`main.py`; `test_auth.py` is new; `requirements.txt`/`Dockerfile` unchanged so the pip layer stays cached) to the Hugging Face Space; wait for RUNNING; `GET /health` → `key_required:false`, `inference_workers:2`.
2. `npx wrangler d1 execute mambo-jambo-photos --remote --file=migrations/0010_rate_limits.sql`
3. `npx wrangler d1 execute mambo-jambo-photos --remote --file=migrations/0011_admin_sessions.sql` (retry once on a transient auth error)
4. `npx wrangler secret put FACE_API_KEY` (e.g. `openssl rand -hex 32`) — **user runs or approves**
5. `npm run deploy:api`; then `GET /api/health` → `migrations: { adminSessions: true, rateLimits: true }`. Every crew member signs in again once.
6. Space → Settings → Variables and secrets → `FACE_API_KEY` = same value (container restarts) — **user does this**; verify `/health` → `key_required:true`, `POST /extract` without header → 401, Worker `GET /api/health?deep=1` → `face: ok`.
7. `npm run build`; Hostinger: upload the **contents of `dist/`** including `.htaccess` (per-file TUS), then clear cache. Include `preview-worker.<hash>.js` and the two hero variants. Vercel: `npx vercel deploy --prod --yes` (build already targets `dist/`); afterwards confirm `cache-control: public, max-age=31536000, immutable` on a hashed asset.
8. Watch the Cashfree dashboard webhook log for a day: a retry answering 401 "timestamp outside the accepted window" would mean retries reuse the original timestamp (guest `verify` path still unlocks; the window would need revisiting).

### Cashfree — go-live status (not "production-ready")
The webhook change looks correct in tests, but before calling the payment integration live these remain open: production webhook URL + API version confirmed in the dashboard; domain whitelisting; the webhook does not re-fetch `GET /orders/{id}` before fulfilment and has no idempotency store; no webhook IP allow-list; the sandbox→production key swap and `CASHFREE_ENV=production` on the deployed Worker were not verified from here; no sandbox end-to-end payment was run this wave.

### Cut, blocked or unverified
- Nothing cut outright. Deviations (with reasons in the handoffs): F26 grid value kept at `auto-fill 200px`; F25 hint says "double-tap to zoom"; F18 input-adjacent stage-swap shift left (excluded from CLS); quota charged after the session/indexing checks; pre-deploy crew tokens refused rather than grandfathered.
- Not verified from this machine: anything against real D1 (`RETURNING` on the quota upsert), real Cashfree timestamps, the live Space (cold start, x86 timings, HF proxy behaviour on drained 401s), HEIC on Safari, Safari/Firefox OffscreenCanvas branches, throttled-Android frame times, Hostinger/Vercel header behaviour, real-device safe-area padding, real-Worker upload round trip with 600/320 px files.
- `npm audit`: 10 dev-only advisories, all transitive under `@lhci/cli`; nothing ships to the site or Worker.
- Screenshots at 768 and 1440 are W2-B's.

### Honest re-score (0–10; before wave 1 → after wave 1)
| Area | Before | After | Why |
|---|---|---|---|
| UI | 6 | 7 | AA contrast on every audited pair, no text under 11 px, hero `srcset`, sticky-bar padding fixed, admin fits 375 px. Still placeholder art in `soi-stamps.svg`, tiles still 4:3 (dimensions land in wave 2/3), screenshot tests not yet in place. |
| UX | 6 | 6.5 | Search quota copy, drag-and-drop selfie, flick navigation, duplicate-session guard, inline retry, re-auth resume, next-action toasts. Zero-match second chance, hide-wrong-match, WhatsApp share, checkout trust block and axe/VoiceOver passes are wave 3. |
| Performance | 5 | 6.5 | Upload path no longer freezes (24–30 ms frames), fingerprinted immutable assets, gzip dev server, Lighthouse gate exists. Budgets still fail on LCP/CLS mainly from 231 KB of web fonts (wave 2), previews not edge-cached (wave 3), face service warm-ping cron (wave 3), no direct-to-R2 (wave 4). |
| Admin utility | 6 | 7 | Smooth 30-photo batches, revocable sessions, focus/menu/duplicate fixes, contrast. Bulk actions, money/support tabs, conditions, TOTP, audit log, backups and the e2e suite are waves 2–4. |
| Matching | 4 | 4 | Untouched (W3-D). The face service now handles three concurrent requests and is key-protected once rolled out. |

---

## Wave 2 — fonts, tests, foundations (2026-09-17, four agents in parallel) — DONE, not deployed

The first wave-2 run was killed by the account's API session limit with every agent mid-task; the relaunch inherited the partial work (nothing was lost — the suite stayed green throughout). A **separate, non-program session** worked in this directory at the same time: it committed `78df26b` (per-photo upload progress ring) and `97a6992` (review queues sorted by session, burst links auto-confirmed) and is adding a guided-selfie camera with client-side face detection (`app.js`, `site.css`, `assets/face-api.js`, `assets/face-models/`, uncommitted). Those hunks were left alone by every agent. Two things from that session the program should know: `/api/sessions` covers are now served as `variant=original` with a 6-hour token (unwatermarked cover on the landing card — the crew-chosen-only rule still holds), and W1-A's two real-SQLite tests were swept into `97a6992`.

### Full check after integration
`npm run check` ok · `npm test` **129/129** (was 100) · `npm run build` ok (49 files, 13 fingerprinted, every reference verified) · `CI=1 npx wrangler deploy --dry-run` ok (99.06 KiB / 23.66 KiB gzip) · `npm run e2e` **131 passed, 3 skipped** (the "navigation menu open" axe check runs only at phone width) in 43 s · `npm run lighthouse` (now applied `devtools` throttling, median of 3): perf 0.99, **LCP 1 725 ms (budget 1 800, was 2 779)**, FCP 1 679, TBT 0, script 23.9 KB, image 30.5 KB, font 64.7 KB, total 148 KB; the only failing assertion is **CLS 0.0007 vs the zero budget**, from `h1.soi-title > span` on the web-font swap (carried to W3-A).

### What each workstream shipped
| Workstream | Tasks done | Tests added | Handoff |
|---|---|---|---|
| W2-A Fonts and CSP | F19: Plus Jakarta Sans as one variable file trimmed to wght 400–800 (20.6 KB, smaller than the three statics, so no weight remap needed) + Fraunces 500 upright/italic (static opsz 36) + two ~1 KB rupee-glyph faces; `@font-face` with `swap`, latin `unicode-range`, five metric-matched fallbacks (`size-adjust`/`ascent-override`…) tuned so the fallback layout equals the web-font layout; preloads (index: sans only, Fraunces is below its fold); Google Fonts removed from all six pages; `font-src 'self'` in both report-only CSPs; woff2 immutable cache rules; `--soi-slate-ink`/`--soi-ochre-ink` tokens. Index font bytes 234 KB/8 req → 64 KB/5 req; CLS on every page 0.0000 in the browser audit. | 7 in new `tests/fonts.test.mjs` | `docs/audit/handoff/W2-A.md` |
| W2-B End-to-end and visual tests | `@playwright/test` + `@axe-core/playwright`; `playwright.config.mjs` (4 projects: 375/768/1024/1440, Chromium, `webServer` on 4195); `tests/e2e/public.spec.mjs` (sessions → selfie → results → lightbox → checkout, SDK-blocked and stubbed-paid, cancel, zero match, `?order_id=` in three cases, 30-day resume, Back, un-mocked-request guard), `crew.spec.mjs` (login, three-file queue with one left out, publish with the framed streaming body verified byte-for-byte, sessions tab incl. money strip and its 404/unmigrated hiding, edit-modal dirty guard, typed-confirm delete, upload-more duplicate choice), `screenshots.spec.mjs` (7 screens × 4 viewports, per-platform baselines, 14 MB), `axe.spec.mjs` (11 screens × 4 viewports, wcag2a+aa, **zero violations, no fixme**); every `/api/**` request intercepted and any escape fails the test; `npm run e2e`, `npm run verify`; `.github/workflows/ci.yml` (Node 22, `npm ci`, Chromium, `npm run verify`, Linux baseline hand-back as an artifact). | 134 e2e tests | `docs/audit/handoff/W2-B.md` |
| W2-C Backend product foundations | Migration 0012 `photos.width/height` parsed from the original's JPEG (SOF0/1/2 + EXIF orientation 5–8 swap) / PNG IHDR / WebP (VP8/VP8L/VP8X) header bytes, teed from the first 64 KB of the streamed upload without buffering; returned as integers-or-null on every guest and crew photo object; the studio's `?width=&height=` hint is only a fallback. Migration 0013 `events` (+ `match_feedback.subject_id`), recorded in the existing handlers with try/catch, `paid` exactly once per payment whether verify or webhook wins; `GET /api/admin/stats` in the agreed shape (zeros for quiet sessions, `unmigrated:true` with 200 when the table is missing); F30 `POST /api/admin/undo-review { kind:'pair'|'link', id }` with the 10-minute window, 409/404 semantics and feedback-row removal; health `migrations` now has four flags. | 16 in `tests/worker.test.mjs` (byte fixtures for baseline/progressive/EXIF-rotated JPEG, PNG, three WebP flavours) | `docs/audit/handoff/W2-C.md` |
| W2-D Admin details | Money strip on each session card from `/api/admin/stats` (merged by session id, tabular numerals, hidden on 404/unmigrated, "No searches yet" muted); F30 client: `Z` key and a 44 px Undo button in the review toolbar, re-inserts the card at the top with focus, "Undone" toast, 409/404 handling, ignored while typing; `POST /api/admin/logout` fire-and-forget (`keepalive`) on Sign out and idle sign-out, silent on 404. | 6 in `tests/review-images.test.mjs` | `docs/audit/handoff/W2-D.md` |

### Lead integration actions
- `scripts/site-files.mjs` + `scripts/dev.mjs`: serve/build `assets/fonts/*.woff2` and licences, `font/woff2` MIME (before the wave, so W2-A could verify).
- `lighthouserc.json`: `throttlingMethod` switched from Lantern `simulate` to applied `devtools` (W2-A showed the simulation shares HTTP/1.1 bandwidth evenly across in-flight same-origin requests and mis-scores self-hosted fonts by ~300 ms of LCP; applied throttling agrees with the CDP harness).
- `.gitignore`: `test-results/`, `playwright-report/`.
- `README.md`: self-hosted fonts and CSP line, `npm run e2e`/`verify`, migrations 0012/0013 with the privacy line for `events`, health flags, money strip and undo.
- Lead's canonical screenshot script gained the `/api/admin/stats` mock; wave-2 canonical set in the session scratchpad `lead/wave2-canonical/` (16/16, no failures; only page errors are the deliberately blocked Cashfree SDK).

### Requests between owners — resolved or carried
| From → to | Request | Status |
|---|---|---|
| W2-A → lighthouserc.json | applied throttling | done |
| W2-A → index.html | optionally drop the sans preload for a faster FCP at the cost of a ~560 ms shift-free FOUT | **not taken** (kept per brief; the gate passes LCP with it) |
| W2-A → admin-theme.css | delete the local `--soi-slate-ink`/`--soi-ochre-ink` override now that tokens carry them | **carried to W3-C** |
| W2-B → .gitignore, README | done | done |
| W2-B → admin.html | wrap login card and studio in a `<main>` landmark | **carried to W3-C** |
| W2-B → index.html | axe "needs review" on 24 contrast nodes over the hero photo/scrim | **carried to W3-A** (verify with pixel sampling, adjust the scrim if any fails) |
| W2-C → admin.js / app.js | set `aspect-ratio: width/height` on tiles from the new fields | **carried to W3-A (guest) and W3-C (crew)** |
| W2-C → tests/indexing.test.mjs | lift the scratch real-SQLite events/stats script into the file | **carried to W3-B** (`scratchpad/W2-C-sqlite-e2e.mjs`) |
| lead → W3-A | residual CLS 0.0007 on `h1.soi-title > span` at font swap; honour `retry-after` on 429 (from W1-A) | carried |

### Deploy or dashboard actions needed (in addition to wave 1's list; nothing deployed yet)
1. D1, after 0010/0011: `npx wrangler d1 execute mambo-jambo-photos --remote --file=migrations/0012_photo_dimensions.sql` then `…0013_events.sql`, one at a time. Deploy the Worker **after** both so its isolates see the columns (a Worker deployed first caches `hasColumn=false` per isolate until recycled). Then `GET /api/health` → all four `migrations` flags true.
2. Hostinger from `dist/` must now also ship `dist/assets/fonts/` (8 files) and the new `.htaccess`; afterwards `curl -sI …/assets/fonts/fraunces-500.woff2` → `content-type: font/woff2`, `cache-control: public, max-age=31536000, immutable`; open the site with the console open and confirm the report-only CSP logs no `font-src` violation.
3. After the first real payment post-deploy: `/api/admin/stats` should show one unlock beside its rupees (proves D1 `batch()` `meta.changes` semantics, verified only on node:sqlite).
4. When committing: include `tests/e2e/__screenshots__/` (14 MB; the 768/1440 sets can be dropped) and, after the first GitHub CI run, the `linux-screenshot-baselines` artifact's `*-linux.png` files.

### Cut, blocked or unverified
- Linux screenshot baselines not generated (no Docker on this Mac); CI skips comparison until they are committed. CI itself is YAML-validated, not executed (nothing pushed).
- W2-A: Safari/Firefox/Android fallback matching and the real hosts' woff2 headers unverified; the LCP number is Chromium with CDP throttling on a loaded Mac.
- W2-C: real D1 `batch()` semantics, camera JPEGs whose APP segments push SOF past 64 KB (parser returns null, the 600 px preview hint is stored), Cashfree delivery ordering — all mocks/SQLite only.
- W2-D: real-Worker behaviour of stats/undo/logout (routes not deployed), link-card undo in a real browser (fake DOM only), 30-minute idle sign-out (fake clock).
- Cashfree go-live items unchanged from wave 1.

### Honest re-score (after wave 1 → after wave 2)
| Area | W1 | W2 | Why |
|---|---|---|---|
| UI | 7 | 7.5 | Self-hosted fonts with zero visible shift, screenshot tests at 375/768/1024/1440 exist and pass. Still placeholder art, tiles still fixed 4:3 (dimensions now stored; W3-A applies them). |
| UX | 6.5 | 7 | Axe: zero violations on 11 screens × 4 viewports. Funnel is instrumented server-side (`events`), so the 60 % / 25 % targets are measurable once deployed. Zero-match second chance, hide, WhatsApp, trust block, VoiceOver pass are wave 3. |
| Performance | 6.5 | 8 | LCP 2.8 s → 1.7 s under applied throttling, TBT 0, JS 24 KB gzip, images 31 KB, total 148 KB; gate enforced in `npm run lighthouse`. CLS 0.0007 (one element) still fails the zero budget; previews not edge-cached and no warm-ping cron (wave 3); no direct-to-R2 (wave 4). |
| Admin utility | 7 | 7.5 | Money strip, undo, revocable sessions with real logout, e2e crew flow. Bulk actions, money/support tabs, conditions, TOTP, audit log, backups are waves 3–4. |
| Matching | 4 | 4 | Untouched (W3-D). |

---

## Wave 3 — product depth (2026-09-17, four agents + two reviewers in parallel) — DONE, not deployed

### Full check after integration
`npm run check` ok · `npm test` **169/169** (was 129) · `npm run build` ok · dry-run ok (142.45 KiB / 33.41 KiB gzip) · `npm run e2e` **219 passed, 3 skipped** · `npm run lighthouse` now passes **every** assertion (CLS 0 on all three runs; LCP median 1 762 ms).

### What each workstream shipped
| Workstream | Tasks done | Tests added | Handoff |
|---|---|---|---|
| W3-A Public product | Uncropped contact-sheet tiles from `width/height` with CLS 0 through load, hide and colour search; "Not me, hide" on every tile (in-place removal, renumbering, focus to the next tile, `aria-live` count, `sessionStorage`, `POST /hide` with 404 ignored); zero-match second chance (12-hue `radiogroup` ring + tone group → `POST /colour` with success/empty/404/429-countdown paths; notify-me phone → `POST /notify`); WhatsApp share on results header and lightbox (Web Share, `wa.me` fallback; never a token or media URL) and post-payment "Send my gallery link to WhatsApp" (`/?gallery=<id>.<token>`, bearer-link hint); checkout trust block (count, ₹ each, three lines, UPI/cards/netbanking glyphs); "Today's session lands by …" from `nextDropAt`; conditions chips; `retry-after` honoured on `/api/match`; the wave-2 CLS residue root-caused (caps vs lowercase fallback width) and fixed with caps/title fallback faces; hero contrast fixed from real pixel samples; `soi-stamps.svg` kit not supplied (note in file). | 21 in `tests/e2e/guest-product.spec.mjs`, `tests/guest-product.test.mjs` | `docs/audit/handoff/W3-A.md` |
| W3-B Backend product | Migration 0014 (six conditions columns, validated, on dashboard and `GET /api/sessions` as `conditions` + `nextDropAt` with a top-level earliest-future value); migration 0015 (`match_hides`, `notify_requests`, `refunds`, `grants`, `searches.colour_photo_ids_json`, `searches.gallery_link_expires_at`, `payments.customer_phone`); `POST /api/searches/:id/colour` (30 hue × 32 sat histogram ranking, `/api/match` shape + `mode:'colour'`, quota `colour:10m`, list persisted so `/previews`, `/access` and the ZIP include it), `/hide`, `/notify`; `POST /api/admin/photos/bulk` (delete/reindex/move/cover, ≤ 200; links and pairs follow a move only when both photos move); publish → `409 { needsCover:true }` unless `{ noCover:true }`; dashboard `indexing` block (queue/ETA/grouped failures); `GET /api/admin/lookup`, `/resend`, `/grant`, `POST /api/admin/payments/:id/refund` (Cashfree Create Refund + `REFUND_STATUS_WEBHOOK`), `GET /api/admin/settlements` (settlements + recon); `stats` gains `grants`; edge cache `public, max-age=min(3600, token life)` on preview/thumb only; `scheduled()` warm ping every 10 min; queue `max_concurrency: 3`. | 28 in `tests/worker.test.mjs`, real-SQLite events/stats test lifted into `tests/indexing.test.mjs` | `docs/audit/handoff/W3-B.md` |
| W3-C Admin product | Bulk select (44 px checkbox per tile, Select all/Clear, sticky bar: Re-index / Set cover / Move to… / typed-DELETE, chunks of 200, partial failures stay selected, per-photo fallback on an old Worker); cover-picker step before publish (409 flow, "Publish without a cover"); conditions on create/edit with validation and a dependency-free EXIF walker pre-fill (date, shot-between helper, camera in the photographer placeholder); indexing line + grouped failure chips on cards; **Money** tab (funnel table, settlements with date range, unreconciled → Support); **Support** tab (lookup by phone/order/search, resend link + clipboard, free unlock with reason, "what the guest saw" strip, typed-REFUND confirm); review meter (`role="meter"`) and full frames beside crops; `<main>` landmark; local ink tokens removed. `admin.js` is now 182 KB / 52 KB gzip (not under the public budget; noted). | 12 in `tests/admin-product.test.mjs`, 5 new e2e screens | `docs/audit/handoff/W3-C.md` |
| W3-D Matching accuracy | `scripts/accuracy.mjs` (plain Node): D1 export + `labels.csv` → precision/recall/F1 at 0.55–0.70 (leave-one-out, per surfer, zero-face counts, label-hygiene diagnostics, `--min-confidence` what-if, HOG person-box checks), replicating the `/api/match` ranking; `--selftest` runs the real `worker.js` handler on a bundled fixture and requires identical order and scores; `docs/accuracy.md` (procedure §3, results slot §4); synthetic curve from the real face service (labelled synthetic). **Real-session run not done: no consented session nominated.** `MATCH_THRESHOLD` stays 0.62. | `--selftest` (wrapped as `tests/accuracy.test.mjs` by FIX-B) | `docs/audit/handoff/W3-D.md` |

### Adversarial reviews of waves 1–2 (frozen snapshot) — findings and disposition
Backend (nothing above medium): IPv6 /64 quota rotation (**fixed**, FIX-B); cover served as the unwatermarked original with a public 6-hour token — **from the concurrent session's change, not reverted; download and funnel-event abuse closed** (FIX-B: `scope:'cover'` tokens refuse `?download=1`), the privacy question is the user's call (below); refused 10-minute requests charging the daily cap (**fixed**); fail-open on any D1 error (**fixed**: only "no such table"); unbounded webhook body (**fixed**: 64 KB cap, cheap checks first); download events for cover tokens (**fixed**). Client (nothing above medium): `ignoreSnapshots` short-circuiting `--update-snapshots` so CI's Linux baselines would never be written (**fixed**, proven empirically); dashboard poll starved by the focus/hover guard (**fixed**, focus preserved across renders); non-idempotent upload retries (**fixed**: `onDuplicate=skip` on retries); re-auth panel without Cancel, stale-token re-prompt, moved panel disabled, `pointercancel` page turn, Safari `scrollTo` TypeError, small-heavy-image upscaling (**all fixed**). Both reviewers also listed 15–17 items checked and found sound.

### Post-wave-3 fix pass (FIX-B, FIX-C)
`npm test` **183/183** · `npm run e2e` **243 passed, 3 skipped** · dry-run 145.17 KiB / 34.21 KiB gzip. Also closed two contract seams the lead found: the Worker's 30-day link now uses the dotted `?gallery=<id>.<token>` form the guest page parses (the page accepts both forms), and `GET /api/admin/lookup` adds the flat `saw: [{ photoId, thumbUrl, hidden }]` list the Support tab renders. Handoffs: `docs/audit/handoff/FIX-B.md`, `FIX-C.md`.

### Lead integration actions
- README: guest product (hide, colour, notify, share, gallery link), crew product (bulk, cover, conditions, Money, Support), migrations 0014/0015 + cron + concurrency, webhook subscriptions, accuracy status, fix-pass behaviours.
- Canonical set: `lead/wave3-canonical/` will be captured with wave 4's (same script).

### Deploy or dashboard actions needed (adds to waves 1–2; nothing deployed yet)
1. D1 after 0010–0013: `migrations/0014_session_conditions.sql` then `migrations/0015_support.sql`, one at a time, **then** the Worker (column presence is cached per isolate). Health should show all six `migrations` flags true.
2. The Worker deploy registers the `*/10 * * * *` cron and queue `max_concurrency: 3`; watch the Space's `/health` for the first hour.
3. Cashfree dashboard (production and sandbox): subscribe the webhook to `REFUND_STATUS_WEBHOOK`; confirm settlements/recon APIs are enabled; run one sandbox refund end to end before relying on the Money tab; after the first settlement cycle compare the UTR list with the bank statement.
4. Studio and site from `dist/` as before; the studio degrades on the old Worker (verified with `-oldworker` e2e cases).
5. Human: nominate one consented session and run `docs/accuracy.md` §3 to get real precision/recall and a threshold recommendation.

### Cut, blocked or unverified
- VoiceOver/NVDA not run (headless); Chromium accessibility tree + axe zero violations instead. Linocut originals not supplied. Real-session accuracy blocked on nomination. All new routes unverified against the real Worker/D1/Cashfree/Space (mocks and node:sqlite only; the ROW_NUMBER ETA query and the Cache API branch degrade with warnings if they ever fail on D1/Cloudflare).
- Cashfree go-live items still open: the payment webhook does not re-fetch `GET /orders/{id}` before fulfilment, no idempotency-key store, no webhook IP allow-list, production domain/URL/version and the sandbox→production key swap unverified from here, no sandbox end-to-end payment or refund run.

### Honest re-score (after wave 2 → after wave 3 + fixes)
| Area | W2 | W3 | Why |
|---|---|---|---|
| UI | 7.5 | 8 | Uncropped tiles from stored dimensions with CLS 0, hero contrast verified from pixels, Lighthouse all-green. Placeholder art remains (kit not supplied) — the only UI target still unmet. |
| UX | 7 | 8.5 | Zero-match colour search + notify-me, hide wrong matches, WhatsApp share + post-payment delivery, checkout trust block, every state ends in an action, axe zero, `retry-after` honoured. VoiceOver/NVDA unmeasured; funnel targets measurable only after deploy. |
| Performance | 8 | 8.5 | Gate fully green; previews edge-cached; warm-ping cron; three-way indexing concurrency. Direct-to-R2 and offline (wave 4) pending. |
| Admin utility | 7.5 | 8.5 | Bulk actions, Money and Support tabs, conditions with EXIF pre-fill, cover picker, indexing observability, review meter. Resumable uploads, accounts/TOTP/audit, alerts, backups and the upload→checkout e2e are wave 4. |
| Matching | 4 | 5 | Tooling and procedure exist and are self-tested against the shipped ranking; the 90 % precision target is unmeasured until a session is nominated. |

---

## Wave 4 — platform (2026-09-17, four agents; interrupted once by a process exit and resumed) — DONE, not deployed

The first run died with the Claude Code process (the machine's temp directory was cleared, taking the lead's scratchpad — briefs, the canonical screenshot script and the wave-0/1/2 canonical PNG sets — with it; the repo was untouched). The resumed run inherited every agent's partial work; W4-D's result was cached.

### Final verification (quiet tree, 2026-09-17 22:50)
`npm run check` ok · `npm test` **232/232** · `npm run build` ok (55 files, 14 fingerprinted, `sw.js` precaches 25 shell files / 271.8 KB raw; the studio's 71 KB gzip JS warning is pre-existing from W3-C) · `CI=1 npx wrangler deploy --dry-run` ok (184.43 KiB / 43.99 KiB gzip) · `npm run e2e` **269 passed, 3 skipped** · `npm run lighthouse` **all assertions pass** on three runs: perf 0.99, accessibility 1.00, LCP 1 735 / 1 744 / 1 778 ms (budget 1 800), FCP ~1.7 s, TBT 0, CLS 0.0000, script 34.4 KB (budget 40; `pwa.js` added ~10 KB), image 30.5 KB, font 64.7 KB, total 164 KB.

### What each workstream shipped
| Workstream | Tasks done | Tests added | Handoff |
|---|---|---|---|
| W4-A Uploads and previews | Direct-to-R2: SigV4 query-string presigning in the Worker (WebCrypto, verified against AWS's published vector), `POST /api/admin/sessions/:id/uploads/presign` (15-min PUT URL) and `…/uploads/complete` (Worker `head()`s the object, reads 64 KB of header from R2 for dimensions, then the same registration as the streaming path), `503 { fallback:'stream' }` without the three secrets; studio: per-batch presign decision, per-file PUT with the stall watchdog/retries/`onDuplicate=skip`, mixed batches, re-auth/cancel kept; resumable batches (IndexedDB `soi-uploads` manifest, "Resume publishing? … 143 of 312", re-pick via File System Access API or the file input, Discard, wake-up from W4-B's background sync); WebP previews/thumbs with JPEG fallback, sniffed server-side (previews 24–27 % smaller, thumbs 22 %); "Regenerate previews" from the card's More menu (fetches each original once through the crew link, never re-uploads). | 16 in `tests/uploads.test.mjs`, 16 e2e in `tests/e2e/uploads.spec.mjs` | `docs/audit/handoff/W4-A.md` |
| W4-B PWA and service worker | `sw.js` (never fingerprinted; build injects the guest shell precache list + build id and verifies every path exists): fingerprinted assets cache-first, unhashed assets stale-while-revalidate, HTML network-first with cache fallback, `/api/**` never cached except a paid gallery's preview/thumb media under token-free keys (bounded to 150), originals/downloads/admin routes always network, `/admin` bypassed except the shell, `no-store` honoured (dev and e2e unchanged); `manifest.webmanifest` with brand tokens and 192/512/maskable icons; offline banner under the sticky header (CLS 0) on both pages; `pwa.js` registration after `load`; Background Sync tag `soi-upload-manifest` → `soi-resume-uploads` window event (the SW cannot hold `File`s, so it wakes the page). Verified in Chromium against `dist/`: worker-served reload, offline landing render with zero server hits, gallery thumbs served offline on a re-minted link, studio opens offline after one visit, manifest parses with no errors, no CSP violation. | 4 in `tests/pwa.test.mjs` (+ Chromium harnesses in the handoff shots dir) | `docs/audit/handoff/W4-B.md` |
| W4-C Accounts, TOTP, audit log | Migration 0016 (`crew_users`, `audit_log`, `admin_sessions.user_id/role`); `POST /api/admin/login { name?, password, code? }` with PBKDF2-SHA256 210 000 rounds (WebCrypto, constant-time, decoy hash for unknown names), RFC 6238 TOTP (±1 step) once enabled, throttling by IP **and** account name; roles `photographer`/`admin` with 403 gates on refund, grant, deleting a published session and account management; `requireAdmin` → `{ sid, uid, role, name }`; shared `ADMIN_PASSWORD` keeps working while `crew_users` is missing/empty or `LEGACY_SHARED_LOGIN==='true'` (audited as `crew (shared)`); `audit()` (never throws) in session/photo/bulk delete, publish, grant, refund, login success/failure, TOTP enable, user create/disable/reset; `GET/POST /api/admin/users`, `totp/verify|disable|reset-password`, `GET /api/admin/audit` (paged), `GET /api/admin/me`; studio login with the one-time-code field (`needsTotp` flow), a re-auth code field, and a **Crew** pane (users, add with `otpauth://` key + copy, disable, reset, audit list). QR rendering deliberately skipped (text key + otpauth link). | 15 in `tests/accounts.test.mjs` (+ e2e login spec updates) | `docs/audit/handoff/W4-C.md` |
| W4-D Ops | `scripts/backup.mjs` (`wrangler d1 export` → gzip → `backups/d1/daily/<date>.sql.gz`, monthly copy on the 1st; refuses empty dumps; proven end to end against a local miniflare D1 + R2 with sha256 read-back), `.github/workflows/backup.yml` (nightly 01:10 IST, `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, fork-guarded, run summary), the exact R2 lifecycle command (30-day daily expiry), `scripts/restore-drill.mjs` (fresh **local** DB, three sanity queries) — **the drill found and fixed a real defect: a `d1 export` dump cannot be reloaded verbatim (DDL/data interleaved with `sessions.cover_photo_id REFERENCES photos`), so restores now load every CREATE before every INSERT**; the ten-minute cron now also detects an indexing-queue stall (15 min, configurable) and alerts once per incident (state in `r2://…/ops/alert-state.json`) through `ALERT_WEBHOOK_URL` (Slack/Google Chat/Mattermost/Discord/JSON) and/or Resend, two consecutive failed health probes before paging, a "recovered" note, log-only when no sink is configured; `docs/runbook.md` (deploys, secrets, rollbacks, lockout reset, backups, restore, alerts, face-service rollout/rotation/cold start, recorded drills). | 11 in `tests/ops.test.mjs` | `docs/audit/handoff/W4-D.md` |

### Lead integration actions
- `worker.js` `migrationStatus()`: `crewAccounts` flag (W4-C's request; three test expectations updated). `scripts/dev.mjs`: `.webmanifest` MIME. `vercel.json`: `sw.js` no-cache + manifest content-type; `.htaccess`: `AddType` for `.webmanifest`. Both CSPs: `https://*.r2.cloudflarestorage.com` in `connect-src` (direct uploads would otherwise be blocked once the policy is enforced). `package.json`: `backup`, `restore-drill`, `accuracy` scripts. `docs/runbook.md`: "a crew member leaves / lost authenticator" entry. README: PWA, direct-to-R2/resume/regenerate, accounts/TOTP/roles/`LEGACY_SHARED_LOGIN`, migration 0016, secrets, ops scripts and the runbook pointer.
- Final record screenshots (landing full page, admin login; 1024 and 375): `docs/audit/handoff/shots/lead/final/`. The e2e baselines under `tests/e2e/__screenshots__/` (12 screens × 4 viewports) are the canonical visual record from wave 2 on.

### Deploy or dashboard actions — consolidated, in order (nothing has been deployed by the program)
1. **Hugging Face Space:** push `face-api/` (`main.py`, new `test_auth.py`, `accuracy_fixture.py`; `requirements.txt`/`Dockerfile` unchanged). Wait for RUNNING; `GET /health` → `key_required:false`, `inference_workers:2`.
2. **D1 migrations, one file at a time, in order** (retry a transient auth error once): `0010_rate_limits`, `0011_admin_sessions`, `0012_photo_dimensions`, `0013_events`, `0014_session_conditions`, `0015_support`, `0016_crew_accounts` (the two `ALTER TABLE admin_sessions` lines are not idempotent — apply once).
3. **Worker secrets (user runs or approves):** `FACE_API_KEY` (`openssl rand -hex 32`); optional `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (R2 API token with Object Read & Write on `mambo-jambo-photos`); optional `ALERT_WEBHOOK_URL` and/or `RESEND_API_KEY` + `ALERT_EMAIL_TO` (provider choice pending); optional var `LEGACY_SHARED_LOGIN=true` during the accounts transition.
4. **Worker:** `npm run deploy:api` (registers the `*/10 * * * *` cron and queue `max_concurrency: 3`). Then `GET /api/health` → all seven `migrations` flags true; every crew member signs in again once (tokens now carry a session id); bootstrap the first admin account from the Crew pane while the shared password still works.
5. **Space secret:** set `FACE_API_KEY` to the same value (container restarts); verify `/health` → `key_required:true`, `POST /extract` without header → 401, Worker `GET /api/health?deep=1` → `face: ok`.
6. **R2 bucket CORS** (dashboard → R2 → bucket → Settings): `[{"AllowedOrigins":["https://photos.surfersofindia.com","https://mambo-jambo-photos.vercel.app"],"AllowedMethods":["PUT"],"AllowedHeaders":["content-type"],"ExposeHeaders":["etag"],"MaxAgeSeconds":3600}]` — without it every direct PUT falls back to streaming after one failed attempt.
7. **Site:** `npm run build`; Hostinger: upload the **contents of `dist/`** including `.htaccess`, `sw.js`, `manifest.webmanifest`, `assets/fonts/`, `assets/*.png` icons, the hashed JS/CSS and `preview-worker.<hash>.js`; clear cache. Vercel: `npx vercel deploy --prod --yes`. Afterwards: `curl -sI …/sw.js` → `no-cache, must-revalidate`; `…/manifest.webmanifest` → `application/manifest+json`; a hashed asset → `immutable`; a font → `font/woff2` + `immutable`; console shows no report-only CSP violation.
8. **Cashfree dashboard** (production and sandbox): webhook subscribed to `PAYMENT_SUCCESS_WEBHOOK` and `REFUND_STATUS_WEBHOOK`, version 2025-01-01, domain whitelisted; confirm settlements/recon APIs are enabled; run one sandbox payment and one sandbox refund end to end; watch the webhook log for a day for 401 "timestamp outside the accepted window" on retries.
9. **GitHub:** repository secrets `CLOUDFLARE_API_TOKEN` (D1 Read + R2 Edit) and `CLOUDFLARE_ACCOUNT_ID`; run "Nightly D1 backup" once by hand; then apply the retention rule `npx wrangler r2 bucket lifecycle add mambo-jambo-photos expire-daily-d1-backups backups/d1/daily/ --expire-days 30`; the day after, run `npm run restore-drill` on the real object and paste the output into `docs/runbook.md` §9. CI (`.github/workflows/ci.yml`) runs `npm run verify` on push; after the first run commit the `linux-screenshot-baselines` artifact's PNGs.
10. **Matching:** nominate one consented session and run `docs/accuracy.md` §3 (read-only D1 exports, a labels spreadsheet, one command); adjust `MATCH_THRESHOLD` only on that evidence.
11. **When committing:** the whole tree is uncommitted program work plus the concurrent session's edits; `git rm --cached face-api/__pycache__/main.cpython-314.pyc`; include `tests/e2e/__screenshots__/` (≈20 MB; the 768/1440 sets can be dropped).

### Cut, blocked or unverified (program-wide)
- Not possible from this machine, by rule: anything against the real Worker/D1/R2/Space/Cashfree/GitHub runner (all mocks, node:sqlite, local miniflare, local uvicorn); no crew login; no production writes.
- Not done because the user was unavailable: real-session matching accuracy (tool ready), alert sink choice (both paths ready), Cashfree App ID / eligibility check, the linocut kit for `soi-stamps.svg`, and the deploy itself.
- Explicitly deviated: F26 grid value, F25 hint copy, F18 input-adjacent shift, quota charged after the session checks, no QR renderer, index preloads one font face, `admin.html` carries no manifest link (installing from the studio would open the guest site).
- Privacy decision for the user: the concurrent session serves the landing-page cover as the unwatermarked original (EXIF intact) on a 6-hour public token; the program only closed the download/funnel abuse.

### Honest final re-score (after wave 3 → after wave 4)
| Area | W3 | Final | Why |
|---|---|---|---|
| UI | 8 | 8 | Every target met except real linocut art (kit never supplied) — placeholder geometry stays, so this cannot be called 10. |
| UX | 8.5 | 9 | Every UX target implemented and covered by e2e + axe (zero violations, accessibility score 1.00). VoiceOver/NVDA were not run with a real screen reader; funnel targets are measurable only after deploy. |
| Performance | 8.5 | 9.5 | Lighthouse gate fully green on applied throttling (LCP 1.74 s, CLS 0, TBT 0, JS 34 KB), edge-cached previews, warm-ping cron, three-way indexing, direct-to-R2 uploads, offline PWA. The 30-photo frame budget was met on a Mac, not a throttled Android; p95 match under 6 s is unmeasured on the live Space. |
| Admin utility | 8.5 | 9.5 | Bulk actions, Money/Support, resumable and direct uploads, conditions, accounts with TOTP and an audit log, stall alerts, tested backups with a recorded restore drill, and an e2e suite from upload through publish, match, checkout (SDK-blocked/stubbed-paid) and download. Not exercised against production; alert delivery never seen. |
| Matching | 5 | 5 | Tool and procedure ready and self-tested against the shipped ranking; the 90 % precision target is unmeasured until a session is nominated. |

---

## Deploy log — 2026-09-17 23:00–23:20 IST (user go: "deploy it — go ahead with the full list")

Done from this machine, in the plan's order, each step verified before the next:
1. **Rollback copies** of the live Hostinger files (`index.html`, `admin.html`, `app.js`, `admin.js`, `site.css`, `soi-tokens.css`, `config.js`) saved to the session scratchpad `live-before/` (pre-program build, unhashed references).
2. **D1 migrations 0010 → 0016** applied remotely one file at a time; every one succeeded on the first attempt (2/1/2/3/6/9/5 queries).
3. **Worker secret `FACE_API_KEY`** set (`openssl rand -hex 32`; the value is kept at `~/.soi-face-api-key`, mode 600, for rotation — never printed).
4. **Worker deployed** (`npm run deploy:api`, version `168be987-01ec-49ba-906e-40860bfdf9d5`, 184.43 KiB / 43.99 KiB gzip; cron `*/10 * * * *` and the queue consumer registered). `GET /api/health?deep=1` → `ok`, `face: ok`, all seven `migrations` flags true. `GET /api/sessions` now carries `conditions`/`nextDropAt` and `scope:'cover'` tokens. Note: a mid-program Worker build (wave-2 shape) had already been deployed by the concurrent session before this; the migrations were not.
5. **Hugging Face Space** pushed from a throwaway clone (commit `ac06a99`: key check, worker-thread inference, warm ping, auth tests; the Space's own `eac354c` EXIF fix and `ea221ad` HOG downscale were already in the repo's `main.py`, verified by diff before pushing). Rebuilt and RUNNING in ~1 min (pip layer cached): `/health` → `inference_workers: 2`.
6. **Space secret `FACE_API_KEY`** set through the HF API with the same value; container restarted; verified `key_required: true`, `POST /extract` without header → **401**, with header → **200** (`faces: []` on a marketing photo), `HEAD /extract` → 200. Worker → Space with the key verified two ways: deep health `face: ok` and a real no-face `POST /api/match` through the Worker → the expected **400 "We could not find a clear face"** (no search row created, no 503).
7. **R2**: bucket CORS set for `PUT` from `https://photos.surfersofindia.com` and `https://mambo-jambo-photos.vercel.app` (`content-type`, expose `etag`, 3600 s); lifecycle rule `expire-daily-d1-backups` (prefix `backups/d1/daily/`, 30 days) added.
8. **Vercel mirror** deployed from `dist/` (build: 55 files, 14 fingerprinted, `sw.js` precaches 25 shell files). Headers verified live: `/` and `/sw.js` `no-cache, must-revalidate`; hashed JS `immutable`; `manifest.webmanifest` served as `application/manifest+json`; fonts `font/woff2` + `immutable`. Screenshots: `docs/audit/handoff/shots/lead/deploy/`. Proxied `/api/sessions` answers with the new shape.
9. **Lighthouse against the live mirror** (mobile, applied throttling, 3 runs): perf 0.83–0.89, accessibility 1.00, **LCP 2.9–3.0 s**, FCP 2.6–2.9 s, TBT 7 / 269 / 325 ms, CLS 0, script 36 KB, total 169 KB. The local gate's 1.7 s LCP does not include real CDN and Worker round trips; the live number misses the 1.8 s target. TBT spikes on two of three runs look like the first-visit service-worker precache (25 files) competing with the main thread — open item for a follow-up (delay precache to idle, or precache fewer files).

**Hostinger — done 2026-09-18 00:05 IST (second attempt, after the `hostinger-hosting` MCP server reconnected):** all 55 `dist/` files uploaded per-file over TUS (every `Upload-Offset` verified), cache cleared; live headers verified (`/` and `/sw.js` no-cache, hashed JS immutable, manifest `application/manifest+json`, fonts `font/woff2` immutable); the live `index.html` references the hashed build. The old unhashed `app.js`/`admin.js`/`site.css`… copies remain on the server unreferenced (harmless; delete at leisure). Live smoke test: landing renders 4 session cards, fonts loaded, service worker and manifest present, studio shows the code field, zero page errors (`docs/audit/handoff/shots/lead/deploy/hostinger-*.png`). Lighthouse on the primary domain (mobile, applied throttling, 3 runs): perf 0.96 / 0.97 / 0.81, accessibility 1.00, **LCP 2.2 / 2.2 / 3.7 s** (hero image; the third run hit a cold CDN edge), TBT 0 on all three, CLS 0 — better than the mirror but still above the 1.8 s target: the remaining lever is the hero image's time-to-first-byte on Hostinger's CDN (preload is in place; consider a smaller 375-wide variant and `fetchpriority` checks in a follow-up). ~~Not done — Hostinger (the primary host, `photos.surfersofindia.com`) still serves the pre-program build.~~ The `hostinger-hosting` MCP server failed to connect this session (30 s timeout) and its API token is not readable from this machine (it is injected by the desktop app; the Hostinger REST API answered "Unauthenticated" to everything else). A reconnect was requested at the end of the turn. Until Hostinger is updated: the old studio there will hit the new Worker's `409 needsCover` on publish — publish from the mirror's studio (`https://mambo-jambo-photos.vercel.app/admin`) meanwhile; guests on the old page still work (every new Worker behaviour degrades for the old client).

**Still yours (cannot be done from here):** revoke/rotate the Hugging Face token that was pasted in chat; an R2 API token (Object Read & Write on the bucket) → `wrangler secret put R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY` for direct uploads (streaming fallback is active until then); an alert sink (`ALERT_WEBHOOK_URL` or Resend); Cashfree dashboard (subscribe `REFUND_STATUS_WEBHOOK`, confirm settlements/recon APIs, one sandbox payment + refund); GitHub (push `main`, add `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, run the backup once, then the restore drill); nominate a consented session for `docs/accuracy.md`; bootstrap the first crew account from the Crew pane while the shared password still works.

### Open for the user
- Deploy go/no-go for the list above (steps 4 and 6 need you: the Worker secret and the Space secret).
- Cashfree App ID (optional) so the eligibility check can run once the secret key is also in the project.
- If the original `SOI-Fix-Prompt.md` exists elsewhere, share it and the lead will diff it against the reconstruction.
- All four waves are complete. Next: your deploy go/no-go on the consolidated list above, the alert-sink and cover-privacy decisions, a nominated session for the accuracy run, and the linocut kit.
- **Privacy decision:** the concurrent session changed the landing-page cover to serve the unwatermarked original (`variant=original`, 6-hour public token, EXIF intact). The program closed the download/funnel abuse but did not revert the choice. Recommend a dedicated EXIF-free cover derivative (reviewer's suggestion) if the original should not be public.
