# W4-C · Accounts, TOTP, audit log — handoff

## Summary

Per-crew accounts with TOTP and an audit log, on migration **0016**. Sign-in is `POST /api/admin/login { name?, password, code? }`: a named account is checked with PBKDF2-SHA256 (WebCrypto, 210 000 rounds, 16-byte salt, constant-time compare, a decoy hash on unknown names so timing does not reveal the crew list), then — once the member has switched it on — an RFC 6238 code (SHA-1, 30 s, 6 digits, ±1 step, base32 secret). Throttling counts the source IP **and** the account name. Roles are `photographer` and `admin`: a photographer runs the whole photo workflow; refunds, free unlocks, deleting a **published** session and managing accounts answer `403 Only a crew admin can …`. The token carries `{ role, sid, uid, name, exp }`, `admin_sessions` gains `user_id`/`role`, and `requireAdmin` answers `{ sid, uid, role, name }` with the stored row's role winning over the token's (a demotion lands on the next request). The shared `ADMIN_PASSWORD` keeps working — as `admin`, audited as `crew (shared)` — while `crew_users` is missing or holds no enabled account, or while `LEGACY_SHARED_LOGIN === 'true'`; nobody is locked out by the deploy, and the shared password is the bootstrap door for the first account. `audit(env, request, actor, action, targetType, targetId, detail)` never throws and is called from session delete, photo delete, bulk delete/move, publish (both routes), unpublish/archive (`PUT … { status }`), grant, refund, login success/failure (attempted name truncated to 24 chars, never a password), TOTP enable, account create/disable/reset. Admin-only management: `GET/POST /api/admin/users`, `POST /api/admin/users/:id/totp/verify|disable|reset-password`, `GET /api/admin/audit?limit=&before=`; `GET /api/admin/me` tells the studio who is signed in. The studio has Name + Password + a 6-digit field that appears only on `needsTotp` (also on the mid-batch sign-in-again panel), remembers the name, and a **Crew** pane (accounts list, add with the one-time secret shown as text + copy + `otpauth://` link, first-code verification, disable, reset password, and the audit list with "load older").

**Inherited from the first wave-4 run** (the scratchpad was wiped, the repo was intact): everything above except the unpublish/archive audit, plus 15 tests, the e2e spec and mocks, and 14 screenshots. This run verified all of it (commands below) and fixed two things. **(1) A deploy blocker:** the inherited `const decoySalt = randomHex(16)` drew random bytes at module scope, which workerd — the production runtime — refuses (`Disallowed operation called within global scope`; reproduced with `wrangler dev --local`: the Worker did not start). `wrangler deploy --dry-run` never executes the script, so it had passed. The salt is now the constant `DECOY_SALT` (the derived bits are discarded; only the time matters), and a new test imports the module with entropy, timers and `fetch` trapped at global scope — it fails on the old line (checked) and passes now; the local workerd starts and answers `/api/health` 200. **(2)** A status change through `PUT /api/admin/sessions/:id` (the card's Restore path and any future Unpublish) recorded nothing; it now audits `session.unpublish` / `session.archive` / `session.publish` with `{ was, now }`, with a unit test and an e2e assertion. Every screenshot was re-taken from the final code, and the PBKDF2 cost was measured in that local workerd (the inherited "~21 ms" comment was wrong and is corrected).

Nothing was deployed; no production write, login or payment endpoint was called; no `zz-test-*` session exists. `npm run check` ok · `npm test` **232/232** (17 in `tests/accounts.test.mjs`) · `npm run e2e` **269 passed** (2.3 min, exit 0) · `CI=1 npx wrangler deploy --dry-run` ok (184.28 KiB / 43.95 KiB gzip) · `CI=1 npx wrangler dev --local` starts and answers `GET /api/health` 200 (it did not start before this run's fix).

## Files changed

- `worker.js` — my region only: `sign/verify/requireAdmin`, `loginThrottle` (name key), the crew-accounts/TOTP/audit block (`hashPassword`…`revokeSessionsOf`, `adminOnly`, `startCrewSession`), `/api/admin/login|logout|me`, the `/api/admin/users*` and `/api/admin/audit` routes, one-line `audit(…)` calls in session delete, photo delete, bulk, publish, grant, refund, and — this run — the `PUT /api/admin/sessions/:id` handler (captures `admin`, selects `status`, one audit line on a status change) and the decoy salt (`DECOY_SALT` constant instead of a module-scope `randomHex(16)`; comment corrected). `git diff HEAD -- worker.js` also carries W4-A's and W4-D's regions and the concurrent session's hunks; none touched.
- `migrations/0016_crew_accounts.sql` — new (`crew_users`, `audit_log` + index, `admin_sessions.user_id/role`).
- `schema.sql` — mirrors 0016 (`admin_sessions` columns, both tables, the index).
- `admin.html` — topbar `#crewBtn`, the login card (`#adminName`, `#loginCodeField`), `#reauthCodeField` on the sign-in-again panel, the `#crewScreen` pane.
- `admin.js` — sign-out (`revokeToken`), `focusLogin`/`rememberedName`, `loginWithPassword` + `TotpNeeded`, the re-auth panel's code field, the whole "Crew accounts, TOTP and the audit log" section; this run added `session.unpublish`/`session.archive` wording and the `was`/`now` detail words.
- `tests/accounts.test.mjs` — 16 tests (one added this run).
- `tests/e2e/crew-accounts.spec.mjs` — 5 tests (this run: an unpublish entry in the audit mock and two assertions); `tests/e2e/helpers/mock-api.mjs` — the crew routes (`me`, `users`, `totp/verify|disable|reset-password`, `audit`, `needsTotp` on login), all `null`/off by default so every other spec and baseline is untouched; `tests/e2e/crew.spec.mjs` line 28 (the name field is focused first).
- `docs/audit/handoff/shots/W4-C/*.png` — 14 screenshots, re-taken this run.
- `docs/audit/handoff/W4-C.md` — this file.

## Tasks done (by id)

- **C1 · Migration 0016 + schema mirror.** `crew_users` (id, name `COLLATE NOCASE UNIQUE`, PBKDF2 hash/salt/iterations, role CHECK, totp_secret, totp_enabled, created/last_login/disabled), `audit_log` (actor id + name, action, target type/id, detail JSON, ip, created_at) + `audit_log_by_time`, `admin_sessions.user_id/role`. Idempotent `CREATE … IF NOT EXISTS`; the two `ALTER`s are the only non-idempotent lines (apply once).
- **C2 · Login.** Name optional; PBKDF2 210k; decoy hash on unknown names; a right password with no code answers `401 { needsTotp: true }` **without** counting as a failed attempt; a wrong code counts; disabled accounts answer the generic "Incorrect name or password."; `last_login_at` updated; throttle keys `<ip>` and `name:<lowercased>` in the existing `login_attempts` table (no migration).
- **C3 · Roles and gates.** `adminOnly()` at refund, grant, delete-of-a-published-session, and the whole users/audit block. `requireAdmin` refuses tokens without a known role or `sid`; on a pre-0016 database it still answers (`SELECT *`, so no "no such column").
- **C4 · Shared-login flag.** `sharedLoginAvailable()` = `LEGACY_SHARED_LOGIN === 'true' || no enabled account`; any D1 failure counts as "no accounts" (an outage never locks the crew out). Once accounts exist a nameless attempt is refused with "Sign in with your crew name and password." (reason `no-name` in the log).
- **C5 · Management routes.** Create (name 2–40 chars, password 10–200, role; 409 on a taken name; one-time `{ secret, uri }`), list (disabled last), TOTP verify (enables only after a matching code), disable (keeps the row, revokes every session, refuses the last enabled admin with 409), reset password (revokes every session), audit page (limit 1–100, `before` cursor on ISO `created_at` written by the Worker at ms resolution so two entries in one second still page).
- **C6 · Audit helper and calls.** Best-effort insert; skipped silently before 0016 (one cached PRAGMA); malformed detail → `null`; detail capped at 2 000 chars; actor name capped at 80. Calls listed in the summary; this run added the `PUT` status change (`session.unpublish` / `session.archive` / `session.publish`, detail `{ was, now }`, only when the status actually changes — a rename records nothing).
- **C7 · Client sign-in.** `autocomplete` username / current-password / one-time-code; the code field is revealed by `needsTotp` keeping the typed password; the name is remembered in `localStorage` (`mj-admin-name`) so a returning member lands on the password; who-am-I cached in `sessionStorage` (`mj-admin-who`) and refreshed from `GET /api/admin/me` (a 404 from an older Worker just hides the Crew button); the mid-batch re-auth panel gets the same code field.
- **C8 · Crew pane.** Not a `<dialog>` (the studio's dialog count stays four): a third `.admin-body` pane. Cards with role/authenticator chips and last sign-in; Reset password (`window.prompt`) and Disable (`window.confirm`); Add someone → provisioning panel with the secret in 4-char groups, **Copy the key**, **Open in an authenticator app** (`otpauth://`), first-code verification, **Later**; audit list as sentences (`AUDIT_WORDS`) with money formatted as rupees and a **Load older entries** cursor button; the shared-password notice while it still works.
- **C12 · workerd start-up fix (this run).** Module scope must not draw entropy, set timers or do I/O; the inherited decoy salt did. Constant salt + a guard test that traps `crypto.getRandomValues`, `crypto.randomUUID`, `setTimeout`, `setInterval` and `fetch` while importing a fresh instance of `worker.js`. Verified by the test (fails on the old line, passes now) and by `wrangler dev --local` starting.
- **C9 · Unit tests** — see below. **C10 · e2e** — `crew-accounts.spec.mjs` against the mock (no crew credentials on this machine). **C11 · Screenshots** — 1024 and 375, listed below.

## Tests added (names)

`tests/accounts.test.mjs` (17; the first is a module-scope guard, the rest run real SQL through `schema.sql` in `node:sqlite`, the same D1 shim the other suites use):
0. **(this run)** the Worker module evaluates without touching entropy, timers or fetch at global scope (workerd would refuse to start)
1. PBKDF2-SHA256 matches the published vectors, and a stored password round-trips without ever being kept
2. base32 follows RFC 4648 and round-trips the 20-byte secrets the studio provisions
3. TOTP reproduces the RFC 6238 SHA-1 table, and sign-in accepts one step of clock drift either way
4. a crew account signs in with its own password, and the token and session row carry the account and its role (`admin_sessions.user_id` asserted)
5. an account with TOTP needs the code: no code asks for one without burning an attempt, a wrong code is a failed attempt
6. sign-in throttling counts the account name as well as the IP, so spreading the guesses does not help
7. the shared crew password works while no account exists, stops once one does, and comes back with LEGACY_SHARED_LOGIN
8. on a database without migration 0016 the shared password still signs in and the account routes say which migration is missing
9. a crew session survives an unmigrated admin_sessions table but a role the token does not carry is refused
10. a photographer runs the photo workflow but cannot refund, unlock for free, delete a published session or manage accounts
11. the role on the session row wins over the role in the token, so a demotion takes effect on the next request
12. accounts are created with a one-time provisioning secret, listed, disabled with their sessions, and reset
13. every delete, publish, free unlock and refund is recorded with who did it, and a failed sign-in never records a password
14. **(this run)** taking a session off the site or archiving it through PUT is audited as a status change; a rename or an unchanged status is not
15. a password typed into the name box is truncated in the log, and the audit route pages newest first for admins only
16. the audit helper never breaks the action it records

`tests/e2e/crew-accounts.spec.mjs` (5, mobile-375 + desktop-1024): the code field appears only when the Worker asks and the name is remembered; the shared password signs in with no name and hides the Crew button; an admin sees the crew, adds someone, switches their authenticator on and disables an account (axe clean at each step); the audit list reads as sentences newest first (**this run:** the unpublish sentence and `was: published · now: draft`); a photographer never sees the Crew button and an older Worker hides it too.

## How to verify (commands and my port)

```sh
npm run check && npm test                       # 232/232; node --test tests/accounts.test.mjs for the 17 alone
npx playwright test tests/e2e/crew-accounts.spec.mjs tests/e2e/crew.spec.mjs   # 54 passed (27 × two viewports)
npm run e2e                                     # full suite, port 4195 — 269 passed (2.3 min)
CI=1 npx wrangler deploy --dry-run              # 184.28 KiB / 43.95 KiB gzip
CI=1 npx wrangler dev --local --port 8797       # local bindings only; the Worker must start and GET /api/health must answer 200 (kill it after)
PORT=4183 npm run dev                           # W4-C dev server; then the screenshot script below
node /private/tmp/claude-501/-Users-ankithkotian-Documents-mambo-jambo-photos-website/7bb4db07-8310-4483-95f0-d75808750f63/scratchpad/W4-C/shots.mjs
```

The screenshot script (scratchpad, not in the repo) drives the studio with `tests/e2e/helpers/mock-api.mjs` installed on the browser context, so every `/api` call is answered by the mock and it asserts nothing escaped to the proxy. PBKDF2 cost, measured this run in a **local** workerd (`CI=1 npx wrangler dev --local --port 8797`, no remote binding touched): a sign-in with an unknown name (runs the decoy hash) vs. a nameless one (no hash) — 64–223 ms vs 18–41 ms wall time over four samples each, i.e. roughly **50–180 ms for the 210 000-round derivation** on this Mac's workerd. Inside the Paid plan's CPU budget, but three to nine times the "~21 ms" the inherited comment claimed (now corrected in `worker.js`); budget ~100–200 ms per sign-in. In Node the same derivation takes 60–140 ms.

## Screenshots and traces (paths)

`docs/audit/handoff/shots/W4-C/` — all re-taken this run from the final code, 1024×768 and 375×812, no page errors, nothing escaped the mock:
- `login-before-{1024,375}.png` — Name + Password filled, no code field.
- `login-code-{1024,375}.png` — after the Worker's `needsTotp`: the 6-digit field revealed, the password kept, the inline message.
- `topbar-crew-{1024,375}.png` — the studio topbar with the health pill, **Crew** and **Sign out**.
- `crew-accounts-{1024,375}.png` — the Crew pane: four accounts (admin, two photographers, one disabled), chips, actions.
- `crew-provision-{1024,375}.png` — the one-time provisioning panel: secret in 4-char groups, Copy, `otpauth://` link, first-code form.
- `audit-log-{1024,375}.png` — six audit sentences incl. a refund (₹299), an unpublish (`was: published · now: draft`), a grant, a failed sign-in and an account creation.
- `crew-full-{1024,375}.png` — the whole pane, full page.
Playwright traces: none retained (no failures); `test-results/` is empty after a green run.

## Deploy or dashboard actions needed

1. **Apply migration 0016 before deploying the Worker:** `npx wrangler d1 execute mambo-jambo-photos --remote --file=migrations/0016_crew_accounts.sql` (once; the two `ALTER TABLE admin_sessions` lines are not idempotent). Order matters because the Worker caches column presence per isolate: deployed first it still works (shared login, `user_id` left NULL, audit skipped) until isolates recycle.
2. **Deploy the Worker** (`npm run deploy:api`) and the studio (`admin.html`/`admin.js` in the next Hostinger/Vercel build). Existing crew tokens keep working for their remaining lifetime (they carry `role: 'admin'` and a `sid`); no forced re-login. Old studio + new Worker and new studio + old Worker both keep the shared-password sign-in working.
3. **Bootstrap the first admin:** sign in with the shared password → **Crew** → Add someone with role *admin* → scan/type the key into an authenticator → enter the first code (**Turn the code on**). Then the other members. The moment one enabled account exists the shared password stops (test 7) — create the admin account first, verify its code, and only then tell the crew the shared password is gone.
4. **Optional Worker var `LEGACY_SHARED_LOGIN = "true"`** (`wrangler.jsonc` `vars` or the dashboard) if the crew wants the shared password to keep working alongside accounts during the transition; remove it when everyone is on an account. Not set today; nothing else needs a secret.
5. **Plan check:** 210 000 PBKDF2 iterations (~50–180 ms measured locally) need the Workers Paid plan's CPU allowance (the account already is on it — Queues require it). Cloudflare limits PBKDF2 iterations on the Free plan; if the Worker were ever moved there, lower `PBKDF2_ITERATIONS` (stored per row, so old hashes keep verifying).
6. After the deploy, `GET /api/admin/me` from a signed-in studio should answer `{ accounts: true }` once the first account exists, and the Crew pane's audit list should show the bootstrap `login.success` by `crew (shared)`.

## Requests to other owners (file, exact change, why)

- **Lead / health owner · `worker.js` `migrationStatus()` (~line 1416):** add `'crew_users', 'audit_log'` to the `sqlite_master … name IN (…)` list, `crewAccounts: false` to `missing`, and `crewAccounts: names.has('crew_users') && names.has('audit_log')` to the returned object. Why: `GET /api/health` / the topbar pill is how the lead confirms a migration landed (W1-A's pattern for 0010/0011); 0016 is invisible there today. Not edited — outside my region.
- **Lead · `README.md`:** Crew flow: sign-in is name + password (+ 6-digit code once the member's authenticator is on); the throttle is "five failed attempts per IP **or per account name**"; roles and what a photographer cannot do; the **Crew** pane; the audit log. Deployment list: `migrations/0016_crew_accounts.sql`, the optional `LEGACY_SHARED_LOGIN` var, the bootstrap order in step 3 above. Health JSON: `migrations.crewAccounts` once the request above lands. I did not edit README.md.
- **W4-D · `docs/runbook.md`:** a "crew member leaves / phone lost" entry: Disable the account (sessions revoked), or Reset password; a lost authenticator = disable and re-create (the secret is never shown twice). Optional.

## Cut or blocked (with reason)

- **No client-side QR code.** The brief allowed "QR rendered client-side without a dependency, or the URI/secret as text with copy"; the pane shows the secret in 4-char groups with Copy and an `otpauth://` link (which opens the authenticator directly when the pane is opened on the phone). A dependency-free QR encoder is ~150 lines with no decoder in the repo to test it against; not worth the risk this wave.
- **Not verified against the real Worker or D1** (no crew credentials on this machine; no production writes allowed): the migration on remote D1, real Cashfree refunds under the new 403 gate, and real-token behaviour after deploy. Everything is proven on `schema.sql` in `node:sqlite` through the same D1 shim the other suites use, and on the mocked API in Playwright.
- **PBKDF2 cost at the edge** is inferred from the local `wrangler dev` measurement above (50–180 ms), not measured on Cloudflare; the inherited "~21 ms" claim could not have been measured in workerd, since the Worker did not start there before this run's fix. If sign-in ever feels slow at the edge, `PBKDF2_ITERATIONS` can drop to 100 000 without touching stored rows (each row carries its own count).
- Nothing else cut. Every item of the workstream block and the lead notes is implemented and tested.
