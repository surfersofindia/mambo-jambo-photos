# Operations runbook — Surfers of India photos

Everything an on-call crew member needs when something breaks or something ships: the deploy order,
every secret and where it lives, rollbacks, the crew-lockout reset, backups and the restore drill,
and what to do when an alert arrives. Written 2026-09-17 (W4-D). Commands assume the repo root
`/Users/…/mambo jambo photos website` and `npx wrangler` (version pinned in `package.json`).

**Nothing in this repo has been deployed yet.** Waves 1–4 of the audit programme are uncommitted in
the working tree (see `docs/audit/STATUS.md`); the first deploy is the full list in §1.

---

## 1. Deploys

Deploy **in this order**. Each step is safe on its own and the Worker degrades gracefully before the
migrations land, but the order matters: the Worker caches which columns exist per isolate, so a
Worker deployed before its migrations keeps behaving as if they were missing until its isolates
recycle (minutes to hours).

1. **Face service (Hugging Face Space).** Push `face-api/` (`main.py`, `test_auth.py`). The
   `Dockerfile` and `requirements.txt` are unchanged, so the pip layer stays cached and the rebuild
   is short. Wait for **RUNNING**, then
   `curl -s https://ankitkotian-mambo-jambo-face-api.hf.space/health` →
   `{"status":"ok","model_loaded":true,"key_required":false,"inference_workers":2}`.
   Read the `Face model ready: load Xs, warm-up Ys` line in the Space logs and record it in §8.
2. **D1 migrations, one file at a time, oldest first.** Only the ones not yet applied:
   ```sh
   npx wrangler d1 execute mambo-jambo-photos --remote --file=migrations/0010_rate_limits.sql
   npx wrangler d1 execute mambo-jambo-photos --remote --file=migrations/0011_admin_sessions.sql
   npx wrangler d1 execute mambo-jambo-photos --remote --file=migrations/0012_photo_dimensions.sql
   npx wrangler d1 execute mambo-jambo-photos --remote --file=migrations/0013_events.sql
   npx wrangler d1 execute mambo-jambo-photos --remote --file=migrations/0014_session_conditions.sql
   npx wrangler d1 execute mambo-jambo-photos --remote --file=migrations/0015_support.sql
   npx wrangler d1 execute mambo-jambo-photos --remote --file=migrations/0016_crew_accounts.sql
   ```
   Apply every migration file present in `migrations/`, in numeric order — wave 4 added 0016 (per-crew
   accounts, TOTP, audit log) and may add later numbers; check `ls migrations/` rather than this list.
   A transient auth error is safe to retry — every file is idempotent (`IF NOT EXISTS` / guarded
   `ALTER`). **Take a backup first** (§4) if the database already holds real sessions.
3. **Worker.** `npm run deploy:api` (`wrangler deploy`). This also registers the `*/10 * * * *` cron
   trigger and the queue consumer's `max_concurrency: 3`. Then:
   `curl -s https://<worker>/api/health | jq` → all six `migrations` flags `true`, `checks.db` and
   `checks.r2` `ok`. Within ten minutes the Worker logs (`npx wrangler tail`) show one
   `scheduled health check {...}` line per tick with `queue` and `alert` fields (§7).
   Every crew member signs in again once after this deploy (tokens now name an `admin_sessions` row).
4. **Public site — Hostinger (primary).** `npm run build`, then upload the **contents of `dist/`**,
   including the hidden `.htaccess` and `dist/assets/fonts/`, and clear the Hostinger cache. Never
   upload the source tree: `dist/` is what carries the fingerprinted filenames the HTML references.
   Spot-check: `curl -sI https://photos.surfersofindia.com/assets/fonts/fraunces-500.woff2` →
   `content-type: font/woff2`, `cache-control: public, max-age=31536000, immutable`.
5. **Public site — Vercel (mirror).** `npx vercel deploy --prod --yes` (the build targets `dist/`).
6. **Cashfree dashboard** (production *and* sandbox): webhook URL `<worker>/api/payment/webhook`,
   API version `2023-08-01` or later, subscribed to `PAYMENT_SUCCESS_WEBHOOK` **and**
   `REFUND_STATUS_WEBHOOK`; production domain whitelisting.
7. **Smoke test** on a phone and a laptop: open a session → selfie → results → checkout (sandbox
   card/UPI) → download an original; then a crew sign-in, a small upload, a publish.

Deploy the API and the front end **together** whenever the API contract changed.

---

## 2. Secrets and variables — where each one lives

Never commit any of these. `wrangler secret put <NAME>` prompts for the value and stores it on the
Worker; variables in `wrangler.jsonc` `vars` are public configuration, not secrets.

### Cloudflare Worker (`npx wrangler secret put …`)
| Name | Required | What it does |
|---|---|---|
| `ADMIN_PASSWORD` | yes | the crew sign-in password |
| `SESSION_SECRET` | yes | signs crew tokens and every signed media URL. Rotating it signs everyone out and invalidates outstanding preview/gallery links |
| `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY` | yes | Cashfree PG; the secret key also verifies webhook signatures (there is no separate webhook secret) |
| `FACE_API_KEY` | recommended | sent to the face service as `x-face-key`. Set it on the Worker **before** setting it on the Space |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | for direct-to-R2 uploads (W4-A) | S3 credentials the Worker uses to presign upload URLs; Cloudflare dashboard → R2 → Manage API tokens → Object Read & Write, **this bucket only**. Without all three of these and `R2_ACCOUNT_ID` the studio falls back to the streaming upload path |
| `R2_ACCOUNT_ID`, `R2_BUCKET` | with the two above | account id for the S3 endpoint; `R2_BUCKET` defaults to `mambo-jambo-photos`. Not secret, but they live beside the keys |
| `ALERT_WEBHOOK_URL` | optional | where cron alerts are POSTed (Slack / Google Chat / Discord / any relay). Treated as a secret: the URL *is* the credential |
| `RESEND_API_KEY` | optional | email alerts through Resend |

### Cloudflare Worker variables (`wrangler.jsonc` → `vars`, or the dashboard)
`ALLOWED_ORIGIN`, `FACE_API_URL`, `MATCH_THRESHOLD` (0.62), `CASHFREE_ENV` (`sandbox` |
`production`), `BURST_GAP_SECONDS` (2), `APPEARANCE_THRESHOLD` (0.85), and the optional ops knobs:

| Name | Default | What it does |
|---|---|---|
| `QUEUE_STALL_MINUTES` | 15 | how long the indexing queue may show no progress before the cron calls it a stall |
| `ALERT_WEBHOOK_FORMAT` | `text` | `text` → `{"text":…}` (Slack, Google Chat, Mattermost, Rocket.Chat); `discord` → `{"content":…}`; `json` → the full structured payload for a custom relay |
| `ALERT_EMAIL_TO` | — | comma-separated recipients for Resend alerts |
| `ALERT_EMAIL_FROM` | Resend's shared `onboarding@resend.dev` | a verified-domain sender; the shared one only delivers to the Resend account owner |

### Hugging Face Space → Settings → Variables and secrets
`FACE_API_KEY` (secret, same value as the Worker's — **set it last**, the container restarts and
pays a cold start), `FACE_MAX_INFERENCE` (variable, default 2 — leave it at 2 on the 2 vCPU
cpu-basic hardware; it caps concurrent inferences, and onnxruntime already uses every core).

### GitHub repository secrets (Settings → Secrets and variables → Actions)
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for the nightly backup Action (§4). The token
needs exactly two permissions on this account: **D1 → Read** (`wrangler d1 export`) and
**Workers R2 Storage → Edit** (`wrangler r2 object put`). Nothing else — no Workers Scripts edit, no
Zone permissions. Create it under My Profile → API Tokens → Create Custom Token, scoped to the one
account.

### Not stored anywhere on a developer machine
There is no crew password on the build Mac and there must not be: five failed sign-ins lock the crew
out for 15 minutes (§6).

---

## 3. Rollbacks

| What | How | Notes |
|---|---|---|
| **Worker** | `npx wrangler rollback` (or `npx wrangler rollback <version-id> -m "reason"`; list with `npx wrangler deployments list`) | Instant. Code only — it does **not** undo a D1 migration or change secrets. A Worker rolled back behind its migrations is fine (extra columns are ignored); a Worker rolled *forward* of them is not (§1 order) |
| **D1 migration** | there is no "down" migration: restore from the nightly backup (§5) or drop the added object by hand | Every migration so far is additive (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN`), so a rolled-back Worker simply stops using it. Only restore if a migration corrupted data |
| **Hostinger** | re-upload the previous `dist/` (keep the last two builds as `dist-YYYY-MM-DD.zip` before each deploy) and clear the cache | The HTML is `no-cache, must-revalidate`, so a re-upload is visible immediately; hashed assets are immutable, so old ones can stay |
| **Vercel** | Deployments → the previous production deployment → Promote to Production | Mirror only; Hostinger is the primary host |
| **Face service** | Space → Settings → Factory rebuild is a last resort; normally revert the commit and push. To disable key enforcement, **delete the Space's `FACE_API_KEY` secret** (container restarts, the Worker's extra header is harmless) | Every restart pays a cold start (§8) |
| **Alerts** | remove `ALERT_WEBHOOK_URL` / `RESEND_API_KEY` (`npx wrangler secret delete …`) | The cron then logs what it would have sent and changes nothing else |

---

## 4. Backups

**What is backed up:** the D1 database (sessions, photos metadata, faces and their embeddings,
searches, payments, refunds, grants, events). **What is not:** the R2 objects (originals, previews,
thumbs). R2 is the source of truth for pixels; a D1 restore without R2 is a working catalogue whose
images are still in the bucket. Photos are only ever deleted by a deliberate crew action.

### Nightly, automatic
`.github/workflows/backup.yml` runs `node scripts/backup.mjs` at **19:40 UTC (01:10 IST)** on a
GitHub-hosted runner, and can be started by hand from Actions → *Nightly D1 backup* → Run workflow
(with an optional dry run). It needs the two repository secrets in §2. It writes:

```
r2://mambo-jambo-photos/backups/d1/daily/<YYYY-MM-DD>.sql.gz     expires after 30 days (lifecycle)
r2://mambo-jambo-photos/backups/d1/monthly/<YYYY-MM>.sql.gz      written on the 1st, never expired
```

The script exports with `wrangler d1 export --remote`, refuses an empty dump or one without a single
`CREATE TABLE`, gzips it (level 9, streamed — a large dump never sits in memory), prints the table /
row-statement counts and the gzip's **sha256**, uploads, then deletes the local files. Run it by
hand the same way: `node scripts/backup.mjs` (add `--dry-run` to see the plan, `--keep` to keep the
`.sql`/`.sql.gz`).

Backups share the photo bucket because the Worker already binds it and R2 does not bill per prefix;
nothing under `backups/` is reachable through the Worker, which only signs keys under `sessions/`.
**If the crew ever needs an API token that may read photos but not backups, move them to a dedicated
`mambo-jambo-backups` bucket** — `node scripts/backup.mjs --bucket mambo-jambo-backups` and the same
lifecycle rule are all that changes.

### Retention — the R2 lifecycle rule (run once)
```sh
npx wrangler r2 bucket lifecycle add mambo-jambo-photos expire-daily-d1-backups backups/d1/daily/ \
  --expire-days 30
npx wrangler r2 bucket lifecycle list mambo-jambo-photos       # confirm
```
Dashboard equivalent: R2 → `mambo-jambo-photos` → Settings → Object lifecycle rules → Add rule,
prefix `backups/d1/daily/`, "Delete objects 30 days after creation". A lifecycle rule cannot express
"keep the 1st of each month", which is why the script writes the monthly copy under a second prefix
the rule does not match. Prune `backups/d1/monthly/` by hand once a year.

**Status: not yet applied — no backup has ever run against production** (nothing is deployed and
this machine must not write to production R2). Apply the rule right after the first Action run, and
check the first object exists:
`npx wrangler r2 object get mambo-jambo-photos/backups/d1/daily/<date>.sql.gz --file /tmp/check.sql.gz`.

---

## 5. Restore

### The drill (do this quarterly; it touches nothing remote)
```sh
# 1. fetch a backup
npx wrangler r2 object get mambo-jambo-photos/backups/d1/daily/2026-10-01.sql.gz \
  --file /tmp/2026-10-01.sql.gz
# 2. load it into a throwaway local database and run the sanity queries
node scripts/restore-drill.mjs --dump /tmp/2026-10-01.sql.gz --persist-to /tmp/drill
```
The drill loads the dump with `wrangler d1 execute --local --persist-to <dir>` (never remote) and
reports three things: sessions (total and published), photos (total and how many have an indexed
face), and the latest payment. It exits non-zero if the restored copy has no sessions. Paste the
output into §9 with the date.

> **Load the schema before the rows.** `wrangler d1 export` writes each table's `CREATE` followed by
> its rows, and `sessions.cover_photo_id REFERENCES photos(id)`. Feeding the dump to
> `wrangler d1 execute --file` verbatim therefore fails on the very first `INSERT INTO "sessions"`
> with `no such table: main.photos` — the dump's leading `PRAGMA defer_foreign_keys=TRUE` is not
> honoured statement-by-statement by that command. The drill script splits the dump (every `CREATE`
> first, then every `INSERT`; `splitDump()` in `scripts/restore-drill.mjs`). **A real restore needs
> the same split** — do it with the drill script's own two files, or by hand:
> ```sh
> grep -v '^INSERT INTO' dump.sql > schema-only.sql && grep '^INSERT INTO' dump.sql > data-only.sql
> ```
> (that `grep` pair is only safe when no value contains a newline; the script's splitter is the
> reliable one). Found by the 2026-09-17 drill — §9.

### A real restore (deliberate, rare, destructive)
1. **Stop writes:** the crew stops uploading; consider `npx wrangler rollback` to an older Worker or
   temporarily unsetting `ADMIN_PASSWORD` so no one signs in.
2. Take a fresh export of the damaged database first — `node scripts/backup.mjs --keep` — so the
   restore itself can be undone.
3. Run the drill (above) on the chosen dump; do not restore a dump you have not just verified.
4. D1 has no "replace database" command. Either
   **(a)** create a new database (`npx wrangler d1 create mambo-jambo-photos-restored`), load the
   dump into it **schema first, then data** (see the box above:
   `npx wrangler d1 execute mambo-jambo-photos-restored --remote --file <schema>.sql` then
   `--file <data>.sql`), point `wrangler.jsonc`'s `database_id` at it and redeploy — the safest
   path, the old database stays untouched — or
   **(b)** apply the dump into the existing database after dropping the affected tables. The dump's
   `CREATE TABLE` statements fail on tables that already exist, so only (a) is a clean full restore.
5. Verify `GET /api/health` (six migration flags), open the studio, check one session's photos and
   the Money tab, then let the crew back in.
6. R2 is untouched by any of this. If pixels were also lost, they cannot be recovered from D1 —
   `photos.object_key` tells you exactly which objects are missing.

---

## 6. The crew lockout reset

Five failed sign-ins from one IP lock sign-in for **15 minutes** (migration 0008,
`login_attempts`). To clear it immediately:

```sh
npx wrangler d1 execute mambo-jambo-photos --remote \
  --command "DELETE FROM login_attempts"                       # everyone
npx wrangler d1 execute mambo-jambo-photos --remote \
  --command "DELETE FROM login_attempts WHERE ip = '203.0.113.7'"   # one address
```
`GET /api/health` is unaffected by a lockout, so use it to confirm the Worker itself is fine. Waiting
15 minutes works too — the window is per IP and resets on a success.

Related crew-token operations:
- **Revoke one signed-in session:** Sign out in the studio calls `POST /api/admin/logout`, which
  revokes the token server-side (`admin_sessions`).
- **Revoke every token at once:**
  `npx wrangler d1 execute mambo-jambo-photos --remote --command "UPDATE admin_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE revoked_at IS NULL"`,
  or rotate `SESSION_SECRET` (which also invalidates outstanding signed media and gallery links).
- **Change the password:** `npx wrangler secret put ADMIN_PASSWORD`; existing tokens keep working
  until they expire or are revoked, so revoke them too if the old password leaked.
- **Per-crew accounts (migration 0016).** Once `crew_users` holds an enabled account, sign-in is
  per person with TOTP. Nothing about that changes the lockout reset above — it is still
  `login_attempts`. Escape hatches, in order of preference: set the Worker var
  `LEGACY_SHARED_LOGIN=true` to let the shared `ADMIN_PASSWORD` sign in as an admin again (audited
  as `crew (shared)`), or re-enable / reset one account by hand
  (`UPDATE crew_users SET disabled_at = NULL WHERE name = '…'`). Check the exact column names
  against `migrations/0016_crew_accounts.sql` before typing an `UPDATE`, and see
  `docs/audit/handoff/W4-C.md` for the account-management routes.

---

### A crew member leaves, or loses their phone

- **Leaves:** Crew pane → **Disable** the account (`POST /api/admin/users/:id/disable`). Every session of that account is revoked at once; the row stays for the audit log. Do not delete rows from `crew_users` by hand — `audit_log.actor_user_id` points at them.
- **Lost or reset authenticator:** the TOTP secret is never shown twice. Disable the account and create a new one for the same person (`POST /api/admin/users`), then walk them through **Turn the code on** with the fresh key. A password-only reset (`POST /api/admin/users/:id/reset-password`) does not clear the code requirement.
- **Only one admin and they are the one locked out:** set the Worker var `LEGACY_SHARED_LOGIN` to `true` (dashboard or `wrangler.jsonc` → `vars`, then deploy), sign in with the shared `ADMIN_PASSWORD` (audited as `crew (shared)`), fix the accounts, then unset the flag.

## 7. Alerts

The Worker's cron (`*/10 * * * *`, `scheduled` in `worker.js`) does four things every ten minutes:
the deep health check (D1, R2 and a `HEAD` on the face service, which doubles as the warm ping that
keeps the Space awake), a queue-stall check, alerting, and a sweep of finished quota windows. It logs
exactly one line per tick:

```
scheduled health check {"cron":"*/10 * * * *","ok":true,"checks":{"db":"ok","r2":"ok","face":"ok"},
  "migrations":{…},"queue":{"pending":0,"stalled":false,"lastProgress":"2026-09-17 03:00:00"},
  "alert":"none","time":"…"}
```
Watch it with `npx wrangler tail --format pretty`, or in the dashboard → Workers → Logs.

`alert` values: `none` (clean) · `pending` (a health check failed once; a second consecutive failure
alerts) · `sent` · `open` (incident already alerted, nothing repeated) · `recovered` · `unsent`
(every sink refused — the next tick tries again) · `unconfigured` (no sink set; the alert text is in
a `console.warn` instead).

**One alert per incident.** State lives in the photo bucket at `ops/alert-state.json` (no migration;
the Worker never serves anything outside `sessions/`). A stall alerts on first sight — it is already
15 minutes old by definition. A failed health probe needs two consecutive ticks, so one slow `HEAD`
from a waking Space never pages anyone. A new problem during an open incident joins it silently; the
recovery note lists everything that was wrong.

### Wiring a sink
```sh
npx wrangler secret put ALERT_WEBHOOK_URL       # Slack/Google Chat/Mattermost incoming webhook
# Discord: also set ALERT_WEBHOOK_FORMAT=discord in wrangler.jsonc vars (or the dashboard)
npx wrangler secret put RESEND_API_KEY          # optional email path
# and ALERT_EMAIL_TO=crew@…,ankith@… (+ ALERT_EMAIL_FROM once a domain is verified in Resend)
```
Both sinks are tried; one acceptance is enough. To test a sink without waiting for a real incident,
point `ALERT_WEBHOOK_URL` at a request-bin URL and drive the cron locally:
```sh
npx wrangler dev --test-scheduled            # then, in another shell:
curl "http://localhost:8787/__scheduled?cron=*/10+*+*+*+*"
```
with a `queued` row in the local `indexing_jobs` whose `updated_at` is older than the window (a
`QUEUE_STALL_MINUTES=1` var and a one-minute wait is the easiest way). **Not yet done: no sink is
configured and no alert has ever been delivered** — the user has not chosen a provider. The whole
path (both sinks, both shapes, delivery failure, once-per-incident, recovery) is covered by
`tests/ops.test.mjs`.

### What a stall alert means and what to do
> `indexing queue: 12 photos waiting and no job has moved for 15+ minutes`

Photos are sitting in `indexing_jobs` as `queued`/`processing` and nothing has completed or failed in
the window. In order of likelihood:
1. **The face service is asleep or down.** Check the same log line's `checks.face`, then
   `curl -s https://ankitkotian-mambo-jambo-face-api.hf.space/health`. A cold Space takes tens of
   seconds (§8); if it is stopped, restart it from the Space page. The queue drains itself once the
   service answers — the consumer retries up to three times per photo.
2. **Photos failed permanently.** Open the studio → the session card shows queue depth, ETA and the
   grouped failure reasons. Select the failed photos → **Re-index** (bulk), or use the session's
   re-index; per-photo the API is `POST /api/admin/sessions/:id/reindex` (whole session) and the
   studio's "Retry failed" for the rest.
3. **The queue consumer is not running.** `npx wrangler deployments list` (was something deployed
   just before?), and Cloudflare dashboard → Queues → `mambo-jambo-face-indexing` for backlog and
   error rates. `npx wrangler rollback` if a bad deploy broke the consumer.
4. **D1 is refusing writes.** `checks.db` would be `error` too; then it is a Cloudflare incident —
   watch status.cloudflarestatus.com and wait.

A health alert (`D1 database`, `R2 photo bucket`, `face service`) is the same triage: hit
`GET /api/health?deep=1` yourself, check the Cloudflare and Hugging Face status pages, and only then
suspect our code. Guests see a friendly 503 while D1 is down; nothing is lost.

---

## 8. Face service — rollout, rotation, cold start

**Rollout order for `FACE_API_KEY`** (never the other way round, or every index and match 401s):
1. `npx wrangler secret put FACE_API_KEY` (value from `openssl rand -hex 32`).
2. `npm run deploy:api` — the Worker now sends `x-face-key` on every `/extract` and on the deep
   health ping. The Space ignores it until step 3.
3. Space → Settings → Variables and secrets → add **secret** `FACE_API_KEY`, same value. The
   container restarts. Verify: `/health` → `"key_required":true`; `POST /extract` without the header
   → `401 {"error":"unauthorised"}`; with it → 200; Worker `GET /api/health?deep=1` → `face: ok`;
   then one small crew re-index.

**Rotation** is the same three steps with a new value, Worker first. **Disabling** the check: delete
the Space secret (the Worker's header is then ignored).

`FACE_MAX_INFERENCE` (Space variable, default 2) caps concurrent inferences. Leave it at 2 on
cpu-basic: onnxruntime already uses both vCPUs for one inference, so a higher cap adds latency
without throughput. The Worker's queue consumer runs three photos in parallel; the third simply
waits inside the Space.

**Cold start.** A fresh container downloads the 275 MB `buffalo_l` pack, builds five ONNX sessions
and warms them before uvicorn answers. Measured locally on an M1: 5.96 s cold file cache, 1.6 s
warm; estimated 25–45 s on the Space's 2 vCPU, plus Hugging Face's own scheduling. The Space sleeps
after 48 h idle; the ten-minute cron ping prevents that.

> **Record the real number here after the first deploy** (from the Space log line
> `Face model ready: load Xs, warm-up Ys`): _not yet measured — nothing deployed._

---

## 9. Recorded drills and checks

| Date | What | Result |
|---|---|---|
| 2026-09-17 | **Backup + restore drill, local end to end** — a scratch local D1 seeded from `schema.sql` plus a fixture set (3 sessions / 2 published, 3 photos, 2 faces, 1 paid search, 1 verified payment, 1 queued job); `node scripts/backup.mjs --local --config …` exported it (21 tables, 12 insert statements, 11 332 B → 2 319 B gzip), uploaded `backups/d1/daily/2026-09-17.sql.gz` to the local R2; the object was fetched back and its **sha256 matched the one the script printed** (`d56f3e3f…2fac9`); `node scripts/restore-drill.mjs --dump …` reloaded it into a fresh local database (37 schema + 12 insert statements) and answered `sessions {n:3, published:2}`, `photos {n:3, indexed:2}`, `latest payment {pay-1, verified, 29900, 2026-09-15 08:01:12}` → **PASSED**. Transcript: `docs/audit/handoff/shots/W4-D/restore-drill-local.txt`. | proven offline; never run against production |
| 2026-09-17 | **What the drill found** — a dump loaded verbatim fails with `no such table: main.photos` (see the box in §5). The scripts now load schema before data; the same applies to a real restore. | fixed in `scripts/restore-drill.mjs` |
| — | **Backup against production** | **never run** — nothing is deployed and this machine must not write to production R2. First real run: the GitHub Action, after the secrets in §2 exist |
| — | **Restore drill on a real backup** | **never run** — see above. Do it the day after the first Action run, and quarterly after that |
| — | **Alert delivery** | **never run** — no provider chosen yet (§7) |

---

## 11. Deploy prompt (paste into Claude Code / VS Code to ship the working tree)

Copy everything between the lines into a Claude Code session opened in this repo. It follows section 1's order and stops at anything it cannot verify.

---
Deploy the current working tree of this repo (`/Users/ankithkotian/Documents/mambo jambo photos website`) to production, in this exact order, verifying each step before the next. Never `git stash`, `checkout` or `reset`; other sessions edit this directory. Do not commit unless I say so.

1. Preflight: `npm run verify` must pass (check, unit tests, build, `CI=1 npx wrangler deploy --dry-run`, e2e). Save the live `index.html`, `admin.html` and `.htaccess` from https://photos.surfersofindia.com to a scratch folder as a rollback copy.
2. Face service: if `face-api/main.py`, `requirements.txt` or `Dockerfile` differ from the Hugging Face Space `ankitkotian/mambo-jambo-face-api`, ask me for a write token, clone the Space into a scratch folder (never into this repo), copy the changed files, commit, push, delete the clone, then poll `https://ankitkotian-mambo-jambo-face-api.hf.space/health` until it is RUNNING and `POST /extract` with `x-face-key` answers 200.
3. D1: apply any migration in `migrations/` newer than what `GET https://mambo-jambo-photo-api.surfersofindia.workers.dev/api/health` reports, one file at a time with `CI=1 npx wrangler d1 execute mambo-jambo-photos --remote --yes --file=migrations/<file>.sql`; retry once on a transient "Authentication error [code: 10000]".
4. Worker: `npm run deploy:api`; then `GET /api/health?deep=1` must show `ok: true`, `face: ok` and every `migrations` flag true. Any new secret goes through `npx wrangler secret put NAME` (ask me for values).
5. Site: `npm run build`; upload the contents of `dist/` (including the hidden `.htaccess`, `sw.js`, `manifest.webmanifest`, `assets/fonts/`, `assets/*.png` and the hashed JS/CSS) to Hostinger `photos.surfersofindia.com` (account `u602956317`) with `hosting_generateUploadURLV1` and a per-file TUS `curl` (POST create + PATCH bytes, `?override=true`, verify the returned `Upload-Offset` equals the file size); then `hosting_clearWebsiteCacheV1`. Then `npx vercel deploy --prod --yes` for the mirror.
6. Verify both hosts: `/` → `no-cache, must-revalidate`; a hashed `app.<hash>.js` → `public, max-age=31536000, immutable`; `/sw.js` → no-cache; `/manifest.webmanifest` → `application/manifest+json`; a font → `font/woff2`; the live `index.html` references the hashed files; screenshot the landing page and the studio login at 375×812 and 1024×768 with zero page errors; run Lighthouse (mobile, `throttlingMethod: devtools`, 3 runs) against https://photos.surfersofindia.com/ and report LCP, CLS, TBT.
7. Append a dated deploy log to `docs/audit/STATUS.md` (what shipped, versions, verification results, anything skipped and why) and tell me what still needs a dashboard action from me (Cashfree webhook subscriptions, R2 API token, alert sink, GitHub secrets).
---

## 12. Release prompt (paste into Claude Code / VS Code — everything goes through git as versions)

---
You are the release manager for this repo (`/Users/ankithkotian/Documents/mambo jambo photos website`). From now on every change reaches production only as a tagged git release with release notes. Follow this exactly; ask me before anything destructive; never `git stash`, `checkout --`, `reset --hard` or rewrite published history; never commit secrets, `.env*`, `.dev.vars`, `dist/`, `node_modules/`, `.lighthouseci/`, `test-results/` or `docs/audit/handoff/shots/`.

### Part A — one-time bootstrap (skip if `git tag -l 'v*'` already lists versions)
1. Read `docs/audit/STATUS.md` (waves 1–4 and the deploy log) and `git log --oneline -15`. The tree that is live on all hosts today is the uncommitted working tree; GitHub `main` is at the last pushed commit.
2. Housekeeping first, as its own commit "chore: repo hygiene before v1.0.0": `git rm --cached face-api/__pycache__/main.cpython-314.pyc`; add `docs/audit/handoff/shots/` to `.gitignore` (the 93 MB of audit PNGs stay local; the Playwright baselines under `tests/e2e/__screenshots__/` ARE committed because the screenshot tests need them); add `"version": "1.0.0"` to `package.json`; make `scripts/build.mjs` write `dist/version.json` = `{ "version": <package.json version>, "commit": <git short sha>, "builtAt": <ISO time> }` and add `version.json` to the deploy allowlist in `scripts/site-files.mjs` only if that list is what the build copies from (read both files first); `npm run verify` must stay green.
3. Tag the pre-program state for history: `git tag -a v0.9.0 <sha of the last commit before the program, currently 97a6992> -m "Pre-program baseline (Sept 17 2026)"`.
4. Create `CHANGELOG.md` in Keep-a-Changelog format with these sections, written from STATUS.md, each bullet naming the user-visible change and the migration/secret it needs: `## [1.0.0] - 2026-09-18` with subsections **Security** (wave 1), **Public site** (waves 1, 3), **Crew studio** (waves 1, 3, 4), **Performance & PWA** (waves 1, 2, 4), **Backend & data** (migrations 0010–0016, events, stats, conditions, support, refunds, settlements), **Accounts & audit** (wave 4), **Operations** (backups, restore drill, alerts, runbook), **Testing** (unit, e2e, axe, Lighthouse gate, CI), and **Known gaps** (from STATUS "Cut, blocked or unverified" and the deploy log: LCP above 1.8 s on the live hosts, cover served as original, accuracy unmeasured, linocut art placeholder). Then `## [0.9.0] - 2026-09-17` summarising the pre-program state in three lines.
5. Commit the whole remaining tree as ONE release commit: `feat: v1.0.0 — the 10/10 program (security, fonts, e2e, product depth, PWA, crew accounts, ops)`, body listing the wave headings and noting that the concurrent session's guided-selfie camera and burst auto-confirm are included. End the message with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
6. `git tag -a v1.0.0 -m "v1.0.0 — deployed 2026-09-18 (see CHANGELOG.md)"`, then `git push origin main --tags`. If `gh` is installed and authenticated, `gh release create v1.0.0 --title "v1.0.0" --notes-file <the 1.0.0 section of CHANGELOG.md>`; otherwise tell me to create the GitHub Release from the tag. Report the CI run URL and whether `npm run verify` passed on the Linux runner (first run; the screenshot comparison auto-skips until Linux baselines are committed — download the `linux-screenshot-baselines` artifact and commit those PNGs as `chore(e2e): add Linux screenshot baselines`).

### Part B — every change from now on
1. **Branch per change**: `git switch -c <type>/<short-name>` from an up-to-date `main` (`feat/`, `fix/`, `perf/`, `chore/`, `docs/`). Other Claude sessions may be editing this directory at the same time: before committing, `git add -p` or add only the files you changed, and never include hunks you did not write — leave them in the tree and say so.
2. **Conventional commits**, one logical change per commit, imperative subject under 72 characters, body explaining why, tests included in the same commit (`npm run check && npm test`, plus `npm run e2e` when the UI or API contract changed). Never commit with failing tests.
3. **Changelog with the change**: add the bullet under `## [Unreleased]` in `CHANGELOG.md` in the same commit, in the section it belongs to; name any new migration, secret, env var or dashboard action.
4. **Merge**: fast-forward or squash onto `main` (`git switch main && git merge --ff-only <branch>` or a PR via `gh pr create` if I ask for review), delete the branch, push `main`. CI must be green on `main` before a release.
5. **Release** (only when I say "release" or "deploy"): bump `package.json` with `npm version <patch|minor|major> --no-git-tag-version` (patch = fixes only, minor = new features, major = breaking API/schema change for guests or crew), move `[Unreleased]` to `## [x.y.z] - <today>`, commit `chore(release): vX.Y.Z`, tag `vX.Y.Z` annotated with the changelog section, `git push origin main --tags`, and create the GitHub Release with the same notes.
6. **Deploy only from a tag**: refuse to deploy unless `git status --porcelain` is empty and `git describe --exact-match --tags HEAD` prints a version. Then follow `docs/runbook.md` §1 (Space → migrations one by one → Worker → Hostinger from `dist/` → Vercel), verify `https://photos.surfersofindia.com/version.json` and the mirror show the released version and commit, and append to `docs/audit/STATUS.md` a deploy-log entry that names the tag. If a rollback is needed, deploy the previous tag the same way (`git switch --detach vX.Y.Z-1`, build, deploy) and record it.
7. **Hotfix**: branch from the deployed tag (`git switch -c fix/<name> vX.Y.Z`), fix, test, merge to `main`, release a patch version; never patch production files by hand.
8. Every reply about a release ends with: the version, the tag's commit, what changed (from the changelog), what was deployed where, and what still needs a dashboard action from me.
---

## 10. Related documents

- `docs/audit/STATUS.md` — what each audit wave shipped, and the full deploy checklist per wave.
- `docs/accuracy.md` — the matching precision/recall procedure (`node scripts/accuracy.mjs`); run it
  on one consented session before changing `MATCH_THRESHOLD` (still 0.62).
- `README.md` — architecture, the guest and crew flows, migrations, health endpoint, CSP.
- `docs/audit/handoff/` — per-workstream handoffs, including the deploy and dashboard actions each
  one needs.
