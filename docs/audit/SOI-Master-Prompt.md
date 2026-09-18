# Surfers of India photos — the 10/10 program, run with multiple agents

Companion file: `docs/audit/SOI-Fix-Prompt.md` holds the full detail of every task numbered **F1–F31** below. Agents read their F-tasks there; this file is the plan, the ownership map and the rules.

## 0. You are the lead

- You orchestrate; agents do the work. For each workstream spawn one agent (Agent tool, background), and give it verbatim: section 1, section 2, its own workstream block, and section 8. Never give an agent a file it does not own.
- Waves run in order. Inside a wave every agent runs in parallel. Wave N+1 starts only after every wave-N agent has handed off, you have integrated their work, and the full check passes: `npm run check && npm test && npm run build && npx wrangler deploy --dry-run`.
- Before wave 1 run `git status`. If there are uncommitted changes, ask the user whether to snapshot-commit them ("Snapshot before the 10/10 program"), because the live site is deployed from this tree and HEAD can lag behind it. If they say yes, you may give each agent its own worktree (`git worktree add ../soi-<id> -b <id>`) and merge branches yourself. If they say no, every agent works in this directory under strict file ownership and leaves its changes uncommitted, listed in its handoff.
- Every agent runs its own dev server on its own port: `PORT=4180 npm run dev` for the first agent, 4181 for the next, and so on. The dev server proxies `/api` to the production Worker, so treat the API as production.
- Agents never deploy. You deploy at the end of a wave only when the user says so, in this order: face service (Hugging Face Space) → D1 migrations one file at a time (`npx wrangler d1 execute mambo-jambo-photos --remote --file=migrations/00NN_*.sql`, retry a transient auth error once) → Worker (`npm run deploy:api`) → Hostinger (per-file TUS upload of changed files, then clear cache) → Vercel (`npm run build && npx vercel deploy --prod --yes`). Secrets go through `npx wrangler secret put NAME` and the Space settings, which the user runs or approves.
- After each wave write `docs/audit/STATUS.md`: tasks done, tests added, screenshots and traces, what needs a deploy or a dashboard action, what was cut and why, and an honest re-score of the four areas in section 2.

## 1. Working rules (paste into every agent)

- Repo: `/Users/ankithkotian/Documents/mambo jambo photos website`. Static public site (`index.html`, `app.js`, `effects.js`, `nav.js`, `soi-fx.js`, `site.css`, `premium.css`, `soi-brand.css`, `soi-tokens.css`), crew studio (`admin.html`, `admin.js`, `admin-theme.css`), Cloudflare Worker (`worker.js`, D1 + R2 + Queue, `wrangler.jsonc`, `migrations/`, `schema.sql`), face service (`face-api/main.py`, a Hugging Face Space), tests (`node --test tests/*.test.mjs`; the Worker is imported from source and given mock `env` objects), build (`scripts/build.mjs` copies `scripts/site-files.mjs` into `dist/`).
- Edit only the files you own. If you need a change elsewhere, write the exact request in your handoff file; do not touch the file.
- Never `git stash`, `checkout`, `reset` or commit other people's changes. Other sessions edit this directory concurrently: `git diff` your owned files before editing and never revert a change you did not make.
- After every task run `npm run check` and `npm test`; Worker owners also run `npx wrangler deploy --dry-run`. Add a test for every behaviour you change.
- For anything visual, start your dev server on your assigned port and screenshot at 1024 px and 375×812 before and after. Do not trust CSS reading alone: `soi-tokens.css` loads first and owns tokens, then `site.css`, `premium.css`, `soi-brand.css` (public) or `admin-theme.css` (admin), so a later rule of equal specificity wins. Verify with computed styles.
- The dev server proxies `/api` to the production Worker. Reads are fine. For anything that writes (uploads, deletes, reviews) create a draft session named `zz-test-<your id>` and delete it when you finish. Never touch existing sessions, paid searches or the login endpoint from this machine (five failed logins lock the crew out for 15 minutes; use unit tests for auth).
- Privacy rules that must survive every change: selfies are never persisted; session covers are crew-chosen only, never automatic; the 30-day gallery token flow and the ZIP download stay intact.
- Any task that touches Cashfree code (checkout, verify, webhook, refunds, settlements) follows the Cashfree rules in `CLAUDE.md` and the skills under `.claude/skills/`.
- Migration numbers are pre-assigned in this plan so agents never collide; mirror every migration into `schema.sql`.
- Finish with the handoff file in section 8. Do not deploy.

## 2. Definition of done (the 10/10 targets)

- **UI:** WCAG AA contrast everywhere, no informational text under 11 px, real linocut art in `soi-stamps.svg`, crew-chosen photographic covers on session cards, uncropped tiles from stored dimensions, one spacing scale and radius pair, screenshot tests at 375/768/1024/1440 that pass.
- **UX:** every state ends in a next action; zero-match offers the colour search and a notify-me; guests can hide wrong matches; WhatsApp share and post-payment delivery; checkout shows count, per-photo price and what you get; VoiceOver and NVDA pass with zero axe violations; the funnel is instrumented with targets of at least 60% of searches returning a photo and at least 25% of result views unlocking.
- **Performance:** Lighthouse CI budgets enforced (LCP under 1.8 s on throttled mid-range Android, INP under 200 ms, CLS 0, JS under 40 KB compressed, above-the-fold images under 120 KB); no frame over 32 ms during a 30-photo upload; previews edge-cached; the face service warm with p95 match under 6 s; indexing throughput at least three photos in parallel; direct-to-R2 uploads.
- **Admin utility:** bulk photo actions, money and support tabs, resumable uploads, conditions metadata, per-crew accounts with TOTP and an audit log, queue observability with alerts, tested backups, and a Playwright end-to-end suite covering upload → publish → match (mocked face service) → sandbox checkout → download.
- **Matching:** precision measured on one consented session with crew labels, target 90% precision at the shipped threshold, documented.

## 3. File ownership map

| Wave | Workstream | Owns |
|---|---|---|
| 1 | W1-A Backend security | `worker.js`, `migrations/0010_rate_limits.sql`, `migrations/0011_admin_sessions.sql`, `schema.sql`, `tests/worker.test.mjs`, `tests/indexing.test.mjs` |
| 1 | W1-B Face service | `face-api/main.py`, `face-api/requirements.txt`, `face-api/Dockerfile` |
| 1 | W1-C Crew studio | `admin.html`, `admin.js`, `admin-theme.css`, `preview-worker.js` (new), `scripts/site-files.mjs` (add the worker file only), `tests/review-images.test.mjs` |
| 1 | W1-D Public site | `index.html`, `app.js`, `effects.js`, `nav.js`, `soi-fx.js`, `site.css`, `premium.css`, `soi-brand.css`, `soi-tokens.css`, `tests/site.test.mjs` |
| 1 | W1-E Build and perf tooling | `scripts/build.mjs`, `scripts/images.mjs` (new), `package.json`, `package-lock.json`, `.htaccess`, `vercel.json`, `lighthouserc.json` (new), `assets/brand-surf-wide-768.webp` and `-1280.webp` (new) |
| 2 | W2-A Fonts and CSP | `index.html`, `admin.html`, `soi-tokens.css`, `assets/fonts/` (new), `.htaccess`, `vercel.json` |
| 2 | W2-B End-to-end and visual tests | `tests/e2e/**` (new), `playwright.config.mjs` (new), `package.json`, `.github/workflows/ci.yml` (new, only if a GitHub remote exists; otherwise a `npm run verify` script) |
| 2 | W2-C Backend product foundations | `worker.js`, `migrations/0012_photo_dimensions.sql`, `migrations/0013_events.sql`, `schema.sql`, `tests/worker.test.mjs` |
| 2 | W2-D Admin details | `admin.js`, `admin.html`, `admin-theme.css` |
| 3 | W3-A Public product | `index.html`, `app.js`, `site.css`, `soi-tokens.css`, `soi-stamps.svg` |
| 3 | W3-B Backend product | `worker.js`, `wrangler.jsonc`, `migrations/0014_session_conditions.sql`, `migrations/0015_support.sql`, `schema.sql`, `tests/worker.test.mjs` |
| 3 | W3-C Admin product | `admin.js`, `admin.html`, `admin-theme.css` |
| 3 | W3-D Matching accuracy | `face-api/**`, `scripts/accuracy.mjs` (new), `docs/accuracy.md` (new) |
| 4 | W4-A Uploads and previews | `worker.js` (upload routes only), `admin.js`, `admin.html`, `preview-worker.js`, `tests/worker.test.mjs` |
| 4 | W4-B PWA and service worker | `sw.js` (new), `manifest.webmanifest` (new), `index.html`, `admin.html`, `scripts/build.mjs`, `scripts/site-files.mjs` |
| 4 | W4-C Accounts, TOTP, audit log | `worker.js` (auth routes only), `migrations/0016_crew_accounts.sql`, `schema.sql`, `admin.js` (login section only), `admin.html` (login section only), `tests/worker.test.mjs` |
| 4 | W4-D Ops | `.github/workflows/backup.yml` (new), `scripts/backup.mjs` (new), `docs/runbook.md` (new), `wrangler.jsonc` (cron triggers only) |
| all | Lead | `README.md`, `docs/audit/STATUS.md`, merges, deploys |

Two agents in the same wave never share a file. Where a wave-4 line says "only", the lead assigns those agents disjoint regions of the file and runs them one after the other if a conflict appears.

## 4. Wave 1 — the fix batch (five agents in parallel)

**W1-A Backend security.** Tasks F1 (rate limit `POST /api/match`, migration 0010), F3 (revocable admin tokens, migration 0011, `POST /api/admin/logout`), F4 (webhook timestamp window, Cashfree rules apply), and the Worker half of F2 (`x-face-key` header in `extractFaces()`, read from `env.FACE_API_KEY`). Also rewrite the `/api/sessions` cover lookup as a single join instead of one query per session. Add tests for each.

**W1-B Face service.** The Space half of F2 (`x-face-key` check, enforced only when `FACE_API_KEY` is set, `/health` stays open). Confirm `/extract` accepts a `HEAD` or `GET` warm ping cheaply, and document in the handoff the exact rollout: push Space code, set the Worker secret, deploy the Worker, then set the Space secret. Note the current cold-start time from a fresh container in the handoff.

**W1-C Crew studio.** Tasks F5 (previews to 600 px, thumbs 320 px), F6–F13 (upload smoothness, including `preview-worker.js`), F27–F29 (autofocus, menu flip, duplicate-session warning), the admin lines of F14 (warning status, chip colours) and F17 (label sizes). Record a DevTools performance trace of a 30-photo upload into `zz-test-w1c` before and after, and put the longest frame of each in the handoff.

**W1-D Public site.** Tasks F14 (public lines), F15, F16, F17 (`.brand small`), F18, F22–F26. Add `<link rel="preconnect" href="https://mambo-jambo-photo-api.surfersofindia.workers.dev">` to `index.html`. Add `text-wrap:balance` on `h1,h2`, `text-wrap:pretty` on paragraphs, and `font-variant-numeric:tabular-nums` on prices and counts. Add the hero `srcset` and preload markup from F20 using the filenames `assets/brand-surf-wide-768.webp` and `assets/brand-surf-wide-1280.webp`; W1-E produces those files, and the lead verifies both exist before merging.

**W1-E Build and perf tooling.** Task F21 implemented entirely inside `scripts/build.mjs`: hash JS and CSS into `dist/` and rewrite references in the copied HTML, so source files stay unhashed; write the matching `immutable` cache rules into `.htaccess` and `vercel.json` while keeping HTML on `no-cache`; document in the handoff that Hostinger must now be deployed from `dist/`. Create `scripts/images.mjs` (using `sharp` as a devDependency) that exports the two hero variants from `assets/brand-surf-wide.webp`, and run it. Add `@lhci/cli` with `lighthouserc.json` carrying the budgets from section 2, runnable as `npm run lighthouse` against a dev server on port 4190.

## 5. Wave 2 — fonts, tests, foundations (four agents in parallel)

**W2-A Fonts and CSP.** Task F19: cut to Plus Jakarta Sans 400, 600, 700 and Fraunces 500 plus italic; self-host under `assets/fonts/` with `font-display:swap`; preload the two above-the-fold faces; `font-src 'self'` in both CSP files; remap every `font-weight:500` and `800` in the stylesheets to the nearest kept weight and screenshot every page to confirm nothing regressed.

**W2-B End-to-end and visual tests.** Install `@playwright/test`. Write `tests/e2e/`: the public flow with the API mocked through route interception (sessions → selfie → results → lightbox → checkout dialog, plus the redirect return with `?order_id=`), the crew flow with the API mocked (login → upload queue with three files, one rejected → sessions tab → edit modal dirty guard → delete typed-confirm → upload-more duplicate choice), screenshot tests at 375/768/1024/1440 for hero, finder, results, lightbox, admin login, upload and sessions, and an axe check on every screen with zero violations allowed. Add `npm run e2e` and `npm run verify` (check + test + build + dry-run + e2e). Wire CI only if `git remote -v` shows GitHub.

**W2-C Backend product foundations.** Migration 0012: `photos.width` and `photos.height`, filled at upload from the streamed original's JPEG/PNG/WebP header (parse only the header bytes) and returned in preview, access and admin payloads. Migration 0013: `events (id, kind, session_id, search_id, created_at)` with kinds `search`, `match`, `zero_match`, `checkout`, `paid`, `download`; record them server-side in the existing handlers; add `GET /api/admin/stats` returning per-session searches, matches, zero-match rate, unlocks and rupees. Task F30's `POST /api/admin/undo-review`. Tests for all three.

**W2-D Admin details.** Task F30 client side (`Z` undo against the new endpoint), and a first "Money" strip on each session card using `/api/admin/stats` (searches, unlocks, rupees). Screenshot both.

## 6. Wave 3 — product depth (four agents in parallel)

**W3-A Public product.** Uncropped tiles: use `photo.width`/`height` for each tile's `aspect-ratio` in a contact-sheet layout with zero layout shift. Zero-match second chance: a colour picker that calls `POST /api/searches/:id/colour` and a "tell me when the crew re-indexes" phone field. A "Not me, hide" control on every result tile that calls `POST /api/searches/:id/hide` and removes the tile. WhatsApp share on the lightbox and results header (Web Share with a `wa.me` fallback) and a "Send my gallery link to WhatsApp" button after payment using the 30-day token. Checkout trust block: count, per-photo price, three "what you get" lines, payment method icons. A "Today's session lands by …" line on the landing page read from `GET /api/sessions` (`nextDropAt`). Replace the placeholder geometry in `soi-stamps.svg` with traced originals if the user supplies the kit; otherwise leave a note. Full VoiceOver and NVDA pass with `aria-live` on the results count and zero axe violations.

**W3-B Backend product.** `POST /api/searches/:id/colour` ranking the session's `photo_appearances` histograms against a chosen hue with the same signed-preview response shape as `/api/match`. `POST /api/searches/:id/hide` that removes a photo from the search's matched list and logs `match_feedback`. Publish requires a chosen cover or an explicit `noCover:true`. Migration 0014: session conditions (`break_name`, `swell_ft`, `wind`, `tide`, `photographer`, `next_drop_at`), validated and returned publicly. Migration 0015: support tooling tables as needed for `GET /api/admin/lookup?phone=|order=` (searches, payments, what the guest saw), `POST /api/admin/searches/:id/resend` (returns a fresh 30-day link), `POST /api/admin/searches/:id/grant` (free unlock), `POST /api/admin/payments/:id/refund` (Cashfree refunds API, follow `CLAUDE.md` and `.claude/skills/pg/refunds/SKILL.md`), and `GET /api/admin/settlements` (see `.claude/skills/settlements-and-reconciliation/SKILL.md`). Edge caching: `cache-control: public, max-age=3600` on `preview` and `thumb` media variants only. A `scheduled` handler in `wrangler.jsonc` (`triggers.crons` every 10 minutes) that pings `/api/health?deep=1` to keep the face service warm. Raise queue consumer `max_concurrency` to 3 only after W1-B has confirmed the Space handles parallel requests.

**W3-C Admin product.** Bulk select in the photo grid (select all, delete, re-index, set cover, move to session). A Money tab (per-session funnel from `/api/admin/stats`, settlements, refund button with confirm). A Support tab (lookup by phone or order id, resend link, free unlock, "what the guest saw"). Session conditions fields on create and edit, pre-filled from the first photo's EXIF time range and camera model when available. A cover-picker step before publish. Indexing observability on each card (queue depth, ETA, grouped failure reasons). Review queue: undo, a confidence bar, full-photo thumbnails beside the crops.

**W3-D Matching accuracy.** Build `scripts/accuracy.mjs` that takes one consented session, crew labels (a CSV of photo id and surfer id), and the stored embeddings, and reports precision and recall at thresholds 0.55 to 0.70. Run it on the session the user nominates, recommend a `MATCH_THRESHOLD`, and write `docs/accuracy.md`. Measure real HOG person-detector recall on that session for the appearance signal and report it.

## 7. Wave 4 — platform (four agents in parallel)

**W4-A Uploads and previews.** Direct-to-R2 uploads: the Worker signs a presigned PUT (S3-compatible R2 API, credentials as Worker secrets) and the browser uploads the original straight to R2, then calls the Worker to register the photo and send the preview; keep the streaming path as the fallback. Resumable batches: a manifest in IndexedDB (`sessionId`, filenames, done list) with a "Resume publishing?" prompt after reload. WebP previews where `canvas.toBlob('image/webp')` is supported, JPEG otherwise. A crew-driven "Regenerate previews" action for sessions uploaded before F5.

**W4-B PWA and service worker.** `sw.js` caching the app shell and fingerprinted assets, plus paid-gallery previews for offline revisits; `manifest.webmanifest`; an offline banner; registration in both pages. Background sync for the admin upload manifest.

**W4-C Accounts, TOTP, audit log.** Migration 0016: `crew_users` (name, password hash with PBKDF2 via WebCrypto, role, TOTP secret), `audit_log` (who, what, target, when). Login by name and password plus a TOTP code (RFC 6238 in the Worker), roles `photographer` and `admin`, and audit entries for every delete, refund, grant and publish. Keep the shared-password login working behind a flag until every crew member has an account.

**W4-D Ops.** Nightly D1 export (`wrangler d1 export`) to R2 through a GitHub Action or a documented local cron, R2 lifecycle rules, and one recorded restore drill. A Worker cron that checks health and queue stall (no job progress for 15 minutes) and alerts the crew (email through a provider the user chooses). `docs/runbook.md` covering deploys, secrets, rollbacks, the lockout reset, and the restore drill.

## 8. Handoff file (every agent, at the end)

Write `docs/audit/handoff/<workstream>.md` with these headings: Summary; Files changed; Tasks done (by id); Tests added (names); How to verify (commands and your port); Screenshots and traces (paths); Deploy or dashboard actions needed; Requests to other owners (file, exact change, why); Cut or blocked (with reason). Keep it factual; if something is not verified, say so.

## 9. Lead integration checklist after each wave

1. Merge or review in this order: backend → face service → crew studio → public site → tooling → tests.
2. Run `npm run verify` (or the four commands until W2-B lands), then the e2e suite once it exists.
3. Confirm both hero variants exist, every migration is mirrored in `schema.sql`, and no two handoffs request conflicting changes to the same file.
4. Re-take the eight canonical screenshots at 1024 and 375×812 and compare with the previous wave.
5. Update `README.md` from the handoffs and write `docs/audit/STATUS.md` with the honest re-score.
6. Ask the user for a deploy go/no-go, listing secrets and dashboard actions they must do themselves.
