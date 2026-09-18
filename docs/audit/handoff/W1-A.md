# W1-A · Backend security — handoff

## Summary

Wave-1 backend security for the Worker: a D1-backed per-IP quota on `POST /api/match` (F1), the `x-face-key` shared secret towards the face service (F2, Worker half), revocable crew tokens with `POST /api/admin/logout` (F3), a 5-minute freshness window plus a `payment_status` gate on the Cashfree webhook (F4), and the `/api/sessions` cover lookup rewritten as a single `LEFT JOIN` (F4b). Two new migrations (`0010_rate_limits.sql`, `0011_admin_sessions.sql`) are mirrored in `schema.sql`; `GET /api/health` now reports `migrations: { adminSessions, rateLimits }` so the lead can confirm the remote migration deploy. Every new query degrades gracefully on an unmigrated database (limiter fails open with a `console.warn`; admin tokens fall back to signature-only with a `console.warn`), so the Worker can be deployed before or after the migrations without blocking guests or locking the crew out. Nothing was deployed; no production write, login or payment endpoint was called from this machine. Verified by `npm run check`, `npm test` (81/81, 10 new tests, no stray warnings) and `npx wrangler deploy --dry-run` (result recorded below).

## Files changed

- `worker.js` — all hunks are mine (`git diff worker.js` before and after: no foreign hunks)
- `schema.sql` — appended `rate_limits` (+ index) and `admin_sessions` blocks
- `migrations/0010_rate_limits.sql` — new
- `migrations/0011_admin_sessions.sql` — new
- `tests/worker.test.mjs` — new tests + mock updates (details below)
- `tests/indexing.test.mjs` — two new real-SQLite tests
- `docs/audit/handoff/W1-A.md` — this file

## Tasks done (by id)

- **F1 · Rate-limit `POST /api/match`.** `clientIp()` (`cf-connecting-ip` → first `x-forwarded-for` hop → `'unknown'`), a reusable `limiter(env, key, max, windowSeconds)` (one atomic upsert with `RETURNING`, so concurrent requests cannot both slip under the cap; a refused request still counts), keys `match:10m:<ip>` (8 / 10 min) and `match:1d:<ip>` (30 / 24 h). Counting happens after every input check *and* after the session/indexing-status checks (so a guest polling a "still processing" session does not burn quota — a deliberate deviation from "after input validation", noted here), and before `extractFaces()`. Over limit → `429`, `retry-after` seconds, copy `You've searched a lot in a short while. Try again in N minutes.` (switches to `N hours` when the daily cap is what blocks — small copy deviation from the spec, since "Try again in 1380 minutes" reads badly). `sweepRateLimits()` deletes rows with `window_start < datetime('now','-1 day')` once per match request via `ctx.waitUntil` when available; the text comparison keeps the `window_start` index usable. Missing table → `console.warn('rate limiter unavailable (is migration 0010 applied?) …')` and the request proceeds. `loginThrottle()` now uses the same `clientIp()` helper (gains the `x-forwarded-for` fallback; otherwise unchanged).
- **F2 · Worker half.** `faceHeaders(env)` adds `x-face-key: env.FACE_API_KEY` only when the secret is set; used by `extractFaces()` (matching and the queue consumer) and by the `?deep=1` health `HEAD` ping. No header when unset, so the current open Space keeps working during rollout. Header comment in `worker.js` lists `FACE_API_KEY` as an optional secret.
- **F3 · Revocable admin tokens.** Login inserts an `admin_sessions` row (`id`, `expires_at` ISO, `ip`, `user_agent` ≤ 200 chars) and embeds `sid` in the signed payload; lifetime stays 8 h (`ADMIN_TOKEN_HOURS`). `requireAdmin()` verifies the signature and `exp` first (no I/O), refuses tokens without `sid` (i.e. tokens issued by the previous Worker — the crew signs in again once), then does one `SELECT` on `admin_sessions`: missing, revoked or expired row → 401; `last_seen_at` is written at most once per 5 min (`ADMIN_SEEN_INTERVAL_MS`). `POST /api/admin/logout` (authenticated) sets `revoked_at` and returns `{ ok: true }`. If the table is missing, login still issues a token, `requireAdmin` accepts the signed token and logout returns `{ ok: true }`, each with a `console.warn` naming migration 0011. Health reports `migrations.adminSessions`.
- **F4 · Cashfree webhook timestamp window.** `webhookTimestampFresh()` accepts epoch seconds or milliseconds (`< 1e11` → seconds), rejects non-numeric, and refuses anything more than 5 minutes from the Worker clock in either direction. Order is unchanged: secret/headers present → HMAC over `timestamp + rawBody` compared with the constant-time `same()` → *then* the freshness check → parse. Also per `.claude/skills/pg/webhooks/SKILL.md` §Step 4 the handler now branches on `data.payment.payment_status`: a `PAYMENT_SUCCESS_WEBHOOK` carrying `PENDING` is acknowledged (200) but unlocks nothing; absent `payment_status` is treated as `SUCCESS` for older payload versions. The existing idempotency guard (`status != 'paid'`) is kept and asserted.
- **F4b · `/api/sessions` single join.** `SELECT s.… , p.id AS cover_id, p.thumb_key AS cover_thumb FROM sessions s LEFT JOIN photos p ON p.id = s.cover_photo_id AND p.session_id = s.id WHERE s.status = 'published' …`; `hasColumn` guards keep the join out before 0009 and `thumb_key` out before 0008. Response shape unchanged (`coverUrl` with a 6-hour thumb-or-preview token; internal `cover_id`/`cover_thumb` never leave the Worker).
- **Health.** `GET /api/health` → `{ ok, checks, migrations: { adminSessions: bool, rateLimits: bool }, time }` (one `sqlite_master` query; a DB failure reports both `false`; `ok` is unaffected by migration state).

## Tests added (names)

`tests/worker.test.mjs`
- `tampered or legacy admin tokens are refused before any database access`
- `sign-out revokes the crew token server-side, and an expired session row refuses a still-signed token`
- `without the admin_sessions table the crew can still sign in, work and sign out, with a warning in the logs`
- `guest searches are capped per IP: the ninth in ten minutes is refused with retry-after, other IPs are not`
- `the daily cap blocks even when the ten-minute window is free, keys on the first x-forwarded-for hop, and speaks in hours`
- `a malformed search never consumes quota, and a missing rate_limits table fails open with a warning`
- `the face service receives x-face-key only when FACE_API_KEY is set, on matching and on the deep health ping`
- `a validly signed, fresh webhook marks the payment captured and the search paid, whether the timestamp is epoch seconds or milliseconds` (replaces the old "validly signed webhook" test)
- `a replayed webhook — valid signature but a stale, future or non-numeric timestamp — is refused before any database access`
- `a PAYMENT_SUCCESS_WEBHOOK still carrying a PENDING payment is acknowledged but unlocks nothing`
- rewritten: `landing-page covers are only ever the photo the crew explicitly chose, fetched with the list in a single join` (counts prepared statements: 3 sessions → 1 non-PRAGMA statement; asserts the join/`thumb_key` appear only with their migrations; asserts the response keys)
- extended: `health check is public, uncached, reports which migrations exist and only probes the face service on demand` (+ half-migrated case), and the DB-failure health test asserts `migrations: { false, false }`
- helpers: `adminAware(db)` answers the per-request `admin_sessions` lookup for existing route mocks; `signed()` mints tokens the login route never issues; `webhookEnv()/deliver()`; `matchingEnv({ rateLimits, quota })`

`tests/indexing.test.mjs` (real `node:sqlite` against `schema.sql`)
- `the search quota upsert counts within a window, resets once the window has passed, and sweeps stale rows` — proves the `strftime` window arithmetic, the reset, the daily key continuing to count, the sweep and that refused searches create no `searches` row
- `crew sign-in records an admin_sessions row, requests touch last_seen_at, and sign-out revokes it`

## How to verify (commands and your port)

```sh
cd "/Users/ankithkotian/Documents/mambo jambo photos website"
npm run check && npm test          # 81 tests, 0 failures, no console.warn lines in the output
npx wrangler deploy --dry-run      # bundles worker.js without deploying (result below)
node --test tests/worker.test.mjs tests/indexing.test.mjs   # just this workstream's suites
```
Migration files applied on top of the pre-change `schema.sql` in an in-memory SQLite (script run during this task): `before: []` → `after: ['admin_sessions','rate_limits']`, index `rate_limits_by_window` present, re-applying both migrations and then the full `schema.sql` is a no-op.

Dry-run result (run 2026-09-17 with `CI=1 WRANGLER_SEND_METRICS=false npx wrangler deploy --dry-run`, wrangler 4.131.2): exit 0, `Total Upload: 86.15 KiB / gzip: 20.20 KiB`, bindings DB / PHOTOS / INDEX_QUEUE and the six vars resolved, `--dry-run: exiting now.` Note: without `CI=1` the first attempt hung past 180 s on this machine (wrangler waiting on something interactive); the flag makes it non-interactive.

No dev server / port was needed: this workstream has no UI. Read-only production check (allowed): `GET https://mambo-jambo-photo-api.surfersofindia.workers.dev/api/health` → `200 {"ok":true,"checks":{"db":"ok","r2":"ok","face":"skipped"}}` — the pre-deploy shape, i.e. no `migrations` key yet. After the Worker deploy it should read `"migrations":{"adminSessions":true,"rateLimits":true}` once both migrations are applied.

## Screenshots and traces (paths)

None — no visual change in this workstream (`docs/audit/handoff/shots/W1-A/` intentionally not created).

## Deploy or dashboard actions needed

Order matters; each step is safe on its own because the Worker degrades gracefully.
1. `npx wrangler d1 execute mambo-jambo-photos --remote --file=migrations/0010_rate_limits.sql`
2. `npx wrangler d1 execute mambo-jambo-photos --remote --file=migrations/0011_admin_sessions.sql` (one file at a time, as the lead asked)
3. Deploy the Worker (`npm run deploy:api`). Then `curl …/api/health` and confirm `migrations: { adminSessions: true, rateLimits: true }`. If the Worker is deployed *before* the migrations, guests keep searching without a cap and the crew keeps working on signature-only tokens; Worker logs will show the two `console.warn` lines until the migrations land.
4. After step 3 every crew member must sign in again once (old tokens carry no `sid`). If the Worker was deployed before 0011, tokens issued in that gap have a `sid` but no row and are refused as soon as 0011 lands — again just a re-login.
5. F2 rollout, in this order: W1-B pushes the Space code → `npx wrangler secret put FACE_API_KEY` → deploy the Worker → set the same value in the Space's settings (the Worker sends the header as soon as the secret exists; the Space only enforces once its own variable is set).
6. Optional: watch the Cashfree dashboard webhook log for a day after deploy. Retried deliveries (2 / 10 / 30 min) are expected to carry a fresh `x-webhook-timestamp` per attempt; if a retry ever shows a 401 with `Webhook timestamp is outside the accepted window`, the guest's `/api/payment/verify` path (GET order → PAID) still unlocks the gallery, but tell W1-A/lead so the window can be revisited.
7. README/health-docs are the lead's: README "Health check" section should mention the `migrations` field and the deployment list should add 0010/0011 and the `FACE_API_KEY` secret (I did not edit README.md).

## Cashfree validation checklist — webhook part (from `.claude/skills/validation-and-testing/SKILL.md`)

The webhook change looks correct, but these items remain before go-live:
- Met: signature verified server-side over the raw body with `x-webhook-signature` + `x-webhook-timestamp` (constant-time compare); now also a 5-minute freshness window; env vars only (`CASHFREE_APP_ID`/`CASHFREE_SECRET_KEY`), `x-api-version: 2025-01-01` on every call; control flow branches on `type` / `payment_status` enums, not message text; `return_url` is the real site origin; duplicate deliveries do not double-fulfil (`status != 'paid'` guard, idempotent `payments` update).
- **Unmet — webhook does not re-fetch the order.** The skill's process (REFERENCE §2 step 6) says to `GET /orders/{order_id}` from the backend before fulfilling on a webhook; today the webhook marks `captured`/`paid` from the signed payload alone. The guest-facing `/api/payment/verify` path *does* re-fetch. Suggested follow-up (wave 2, Worker owner): call `cashfreeOrderStatus()` inside the webhook and only mark paid when `order_status === 'PAID'`, keeping the 200 fast (Cashfree's test expects a reply within ~50 ms, so do it in `ctx.waitUntil`).
- **Unmet — `x-idempotency-key` not stored.** Dedup relies on the state guard; no processed-key store. Low risk given the guard, but listed per the checklist.
- **Unmet / not verifiable here — Cashfree webhook IPs are not allow-listed** on the Worker (no firewall). Could be enforced via `cf-connecting-ip` against the four production IPs; deliberately not added because the IP list changes and a wrong list silently blocks payments.
- **Not verifiable from this machine:** production domain whitelisting in the Cashfree dashboard; that the production dashboard's webhook URL points at `<worker>/api/payment/webhook` with version `2025-01-01`; the sandbox → production swap of keys and `CASHFREE_ENV`.
- Frontend items (SDK initialised once, 3-state `cashfree.checkout` handling, dead-code cleanup) are outside this workstream (`app.js`, W1-D/W3-A).

## Requests to other owners (file, exact change, why)

- **W1-C · `admin.js`** — in the sign-out handler (line ~101: `signOutBtn.addEventListener('click', () => { clearToken(); showLogin(); })`) and the idle sign-out (line ~1547), send `fetch(apiUrl + '/api/admin/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, keepalive: true })` (fire-and-forget, ignore the result) *before* `clearToken()`. Why: the token is now revocable server-side; without the call a copied token keeps working until it expires. Also: after the Worker deploy every existing token is refused with 401 once — the existing `if (resp.status === 401) { clearToken(); showLogin(); … }` in `api()` already handles that, no change needed.
- **W1-D · `app.js`** — optional. `requestApi()` already surfaces the 429 body as the error text (`throw new Error(data.error …)`), so guests see "You've searched a lot in a short while. Try again in N minutes." with no change. If W1-D wants a distinct state, read `response.headers.get('retry-after')` (seconds) and disable the search button for that long.
- **W1-B · `face-api/main.py`** — no code request; just the rollout order in "Deploy actions" step 5. The Worker sends `x-face-key` on `POST /extract` and on the `HEAD` warm ping; the Space's `GET/HEAD /extract` warm ping should stay open or accept the same header.
- **W3-B (later) · `worker.js`** — the colour search can reuse `limiter(env, 'colour:10m:' + clientIp(request), max, seconds)`; the sweep already covers any key.
- **Lead · `README.md`** — document `migrations` in the health JSON, migrations 0010/0011 in the deployment list, the optional `FACE_API_KEY` secret, and `POST /api/admin/logout`.

## Cut or blocked (with reason)

- Nothing cut. Deviations from the reconstructed spec, each deliberate and noted above: (1) quota is charged after the session/indexing-status checks rather than immediately after input validation, so polling a still-processing session is free; (2) 429 copy says "N hours" when the daily cap blocks; (3) tokens without `sid` (pre-deploy tokens) are refused rather than accepted for their remaining lifetime, so the only non-revocable class of token disappears at deploy time (cost: one re-login).
- Not verified against real D1 (only against `node:sqlite` and mocks): that D1's `.first()` returns the `RETURNING` row of the upsert. If it ever returned `null`, `limiter()` logs `the quota upsert returned no row` and fails open — check Worker logs once after deploy by making one search.
- Not verified: Cashfree's actual `x-webhook-timestamp` unit in production deliveries (both units are accepted, so either works) and whether retries carry a fresh timestamp (see deploy action 6).
- No end-to-end run against the real Worker or Space (no crew credentials on this machine; no writes allowed this wave).
