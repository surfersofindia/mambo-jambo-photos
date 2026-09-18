# W4-D · Ops — handoff (wave 4)

## Summary

Every item of the W4-D block is done: a nightly D1 backup to R2 (script + GitHub Action + the exact
retention rule to apply), a restore drill that was actually run and recorded, a Worker cron that
detects an indexing-queue stall and alerts the crew once per incident through a webhook and/or
Resend, and `docs/runbook.md` covering deploys, secrets, rollbacks, the crew lockout reset, the face
service, backups, restore and alerts.

`scripts/backup.mjs` runs `wrangler d1 export`, refuses an empty dump or one with no `CREATE TABLE`,
gzips it streamed (level 9, sha256 printed), uploads `backups/d1/daily/<YYYY-MM-DD>.sql.gz` and, on
the 1st, `backups/d1/monthly/<YYYY-MM>.sql.gz` under a second prefix — because an R2 lifecycle rule
can express "expire after 30 days" but not "keep the 1st of the month". `.github/workflows/backup.yml`
runs it at 19:40 UTC (01:10 IST) with `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, fails with an
actionable message when a secret is missing, is guarded against forks, and writes a run summary.
`scripts/restore-drill.mjs` loads a dump into a **fresh local** database (never remote) and runs three
sanity queries.

**The drill found a real defect in the restore path and it is fixed.** `wrangler d1 export` interleaves
DDL and data per table and `sessions.cover_photo_id REFERENCES photos(id)`, so feeding the dump back
verbatim dies on the first `INSERT INTO "sessions"` with `no such table: main.photos` (the dump's own
leading `PRAGMA defer_foreign_keys=TRUE` is not honoured statement-by-statement by
`d1 execute --file`). The drill now splits the dump — every `CREATE` first, then every `INSERT` — and
the runbook says a real restore needs the same split. Before this, the backups were readable but
*unrestorable by the documented command*.

The cron (the same `*/10 * * * *` W3-B added — no second trigger) now also runs one SQL statement
against `indexing_jobs`: photos still `queued`/`processing` while nothing has moved for
`QUEUE_STALL_MINUTES` (15) is a stall. Alerting is once per incident, state in
`r2://mambo-jambo-photos/ops/alert-state.json` (no migration — the binding already exists and the
Worker only ever signs keys under `sessions/`). A stall alerts on first sight; a failed health probe
needs two consecutive ticks so one slow `HEAD` from a waking Space never pages anyone; a new problem
during an open incident joins it silently; the first clean tick sends one "recovered" note. Sinks are
`ALERT_WEBHOOK_URL` (Slack/Google Chat/Mattermost `{text}`, Discord `{content}`, or the full
structured payload) and Resend (`RESEND_API_KEY` + `ALERT_EMAIL_TO`); with neither set the tick logs
what it would have sent and stores nothing, so the first tick after the secrets land still alerts on
an incident that is already under way. Nothing in the tick can fail it — every step degrades to a log
line, and the log is one JSON line per tick with `queue` and `alert` fields.

**Nothing was deployed and nothing production was written.** The backup and drill were proven end to
end against a **local** miniflare D1 + R2 seeded from `schema.sql` plus a fixture session set,
including reading the uploaded object back and matching its sha256.

## Files changed

- `worker.js` — **my region only** (`scheduled()` and its new helpers, plus five lines in the file
  header listing the alert settings). New block `── Ops cron: queue-stall detection and crew alerts ──`
  before the named exports: `stallMinutes`, `queueStall`, `alertConditions`, `alertSinks`,
  `readAlertState`, `writeAlertState`, `deliverAlert`, `alertMessage`, `opsAlerts`. `scheduled()` now
  awaits `opsAlerts(env, health)` (caught — an ops failure never fails the tick) and logs `queue` and
  `alert` in the existing line. W3-B's health check and quota sweep are untouched.
- `wrangler.jsonc` — **cron region only**: the comment above `triggers` now also mentions the stall
  check and names the alert settings. The cron expression, queue block, bindings and vars are
  unchanged (one cadence serves both jobs, as the brief asked).
- `scripts/backup.mjs` — new. Nightly D1 export → gzip → R2, `--dry-run`, `--local --config` for
  offline proof, `--keep`, `--skip-upload`, `--bucket`/`--prefix`/`--date`/`--out-dir`. Exports
  `backupKeys`, `parseBackupArgs`, `runBackup`, `wranglerRunner`, `DEFAULTS`.
- `scripts/restore-drill.mjs` — new. Dump (`.sql` or `.sql.gz`) → fresh local D1 → three sanity
  queries → report; exits non-zero when the restored copy has no sessions. Exports `splitDump`,
  `runRestoreDrill`, `parseDrillArgs`, `SANITY_QUERIES`.
- `.github/workflows/backup.yml` — new. Nightly + manual (`workflow_dispatch` with a dry-run input),
  `concurrency: d1-backup`, `permissions: contents: read`, repository guard, credential check, run
  summary.
- `docs/runbook.md` — new. §1 deploys, §2 secrets and variables (Worker / Space / GitHub), §3
  rollbacks, §4 backups + the lifecycle command, §5 restore (drill and real), §6 the crew lockout
  reset, §7 alerts and stall triage, §8 face service rollout/rotation/cold start (W1-B's carried
  request), §9 recorded drills, §10 related documents.
- `tests/ops.test.mjs` — new, 11 tests (mine alone; I did not touch `tests/worker.test.mjs`,
  `tests/uploads.test.mjs` or `tests/accounts.test.mjs`).
- `docs/audit/handoff/W4-D.md` (this file), `docs/audit/handoff/shots/W4-D/restore-drill-local.txt`.

## Tasks done (by id)

The W4-D block has no F-numbers in `SOI-Fix-Prompt.md`; by the block's own clauses:

- **Nightly D1 export to R2 through a GitHub Action** — `scripts/backup.mjs` + `.github/workflows/backup.yml`.
  Also usable as a documented local cron (`node scripts/backup.mjs`, runbook §4).
- **R2 lifecycle rules** — exact `wrangler r2 bucket lifecycle add … --expire-days 30` command and the
  dashboard equivalent in runbook §4, plus the monthly-copy workaround for the rule R2 cannot express.
  **Not applied** (writes to production R2; deploy action below).
- **One recorded restore drill** — run today against a local database and recorded in runbook §9 with
  the transcript path. It **passed** (`sessions {n:3, published:2}`, `photos {n:3, indexed:2}`,
  `latest payment {pay-1, verified, 29900}`) after the schema-first fix; the first attempt failed and
  that failure is what produced the fix.
- **Worker cron: health + queue stall (no progress for 15 minutes) + alert the crew** — done, one
  alert per incident, generic webhook and Resend, graceful when unconfigured.
- **Email through a provider the user chooses** — the user has not chosen, so both paths exist and
  neither is required: Resend is implemented (one env var + recipients), any other provider is one
  webhook URL away. Documented in runbook §2 and §7; the decision is listed under "Cut or blocked".
- **`docs/runbook.md` covering deploys, secrets, rollbacks, the lockout reset and the restore drill** —
  done, plus the alert runbook, the face-service rollout/rotation (W1-B → W4-D, carried since wave 1)
  and the `docs/accuracy.md` link.

Deviations from the lead notes, each deliberate:
1. **`ops/alert-state.json` is stored in the existing photo bucket**, as the note suggested, not a new
   table — no migration is mine. The isolate also keeps a copy so a bucket outage cannot repeat the
   alert every ten minutes (a cron tick landing in a *fresh* isolate during an R2 outage can repeat it
   once; noted in the code).
2. **A health failure needs two consecutive ticks; a stall alerts immediately.** The note said "once
   per incident" without saying when an incident starts; a single slow `HEAD` from a waking Space is
   not worth a page, whereas a stall is already 15 minutes old when it is first seen.
3. **`scripts/restore-drill.mjs` was built** (the note marked it optional) because the drill is the
   only thing that proves a backup, and it is what found the restore defect.
4. **The monthly copy is written by the script**, not by a lifecycle rule — R2 lifecycle cannot keep
   the 1st of a month.
5. **Backups share the photo bucket** (`backups/` prefix) with the dedicated-bucket alternative and
   its exact trigger documented, rather than creating a bucket I cannot create from here.

## Tests added (names)

`tests/ops.test.mjs` — 11 tests, all passing:
- `a stalled indexing queue alerts the crew once through the webhook, keeps the incident in ops/alert-state.json and closes it with a recovered note` (four ticks: sent → open → recovered → none; asserts the 15-minute bind, the Slack-shaped body, the stored state and that the sink URL never enters the state)
- `a failed deep health probe alerts only when it is seen on two consecutive ticks, and a new problem joins an open incident without a second alert`
- `without a configured sink the tick logs the alert it would have sent, stores no state and still reports the queue` (a Resend key with no recipients is not a sink)
- `email goes through Resend to every configured address, Discord and JSON webhook shapes are honoured, and an alert nobody accepted is retried on the next tick` (asserts the Resend URL, `Authorization` header, `to`/`from`/`subject`, that the key never reaches a body, a 500 + a thrown fetch → `unsent` with the incident unopened, and that one accepting sink is enough)
- `the stall window is configurable, an empty queue or an unmigrated table never alerts, and a bucket outage falls back to the isolate copy so nothing repeats every ten minutes`
- `wrangler.jsonc keeps the ten-minute cron the stall check rides on, and the alert settings are documented as optional vars and secrets` (also asserts the runbook names every setting, the GitHub secrets, the lifecycle rule, `login_attempts` and `wrangler rollback`)
- `backup keys: one daily object per date and a monthly copy on the 1st, under the bucket prefix the lifecycle rule expires` (+ argument parsing and its errors)
- `the backup exports the remote database, gzips the dump, uploads the daily (and monthly) object and removes the local files` (asserts the exact wrangler argument vectors)
- `the backup proves itself against a local database (--local --config), keeps the files with --keep, and a failed export never uploads` (gzip round-trip, empty dump refused, dry run calls nothing)
- `a dump is loaded schema-first: wrangler d1 export interleaves the tables, and sessions.cover_photo_id references photos, so the rows cannot go in as they come` (`splitDump`, including a semicolon and an escaped quote inside a string literal)
- `the restore drill loads a dump into a fresh local database, runs the three sanity queries and reports them` (schema file then data file, `--local --persist-to` only, gzip inflated first, an empty restore reported as FAILED)

## How to verify (commands and your port)

No UI in this workstream, so no dev server and no screenshots (port 4184 was assigned and not needed).

```sh
npm run check && node --test tests/ops.test.mjs      # 11/11 (mine)
npm test                                             # 228/228 at my hand-off
CI=1 npx wrangler deploy --dry-run                   # exit 0, 183.98 KiB / 43.86 KiB gzip
node scripts/backup.mjs --dry-run                    # prints the plan, calls nothing
npm run e2e                                          # see the note below — not green, and not mine
```
**`npm run e2e` at my hand-off: 145 passed, 98 failed, 3 skipped (5.1 min).** None of the failures
touch anything I changed — the e2e suite loads the static site and mocks `/api`; it never imports
`worker.js`, and my workstream adds no client code, no markup and no request. The failures split
into: **61** "every `/api` request must be mocked" (the crew specs now reach W4-A's
`/api/admin/uploads/*` and W4-C's account routes, which `tests/e2e/helpers/mock-api.mjs` does not
stub yet), **~30** visibility/text assertions on the studio's new markup, **4** screenshot-baseline
mismatches, and **8** `ENOENT …/test-results/.playwright-artifacts-*` from concurrent runs sharing
`test-results/`. All of it is wave-4 front-end work still in flight in the same tree.
To repeat the recorded drill offline (no production access, ~30 s):
```sh
S=/tmp/w4d && mkdir -p $S/cf && cat > $S/cf/wrangler.jsonc <<'JSON'
{ "name": "drill", "compatibility_date": "2026-09-14",
  "d1_databases": [{ "binding": "DB", "database_name": "mambo-jambo-photos", "database_id": "8dde58b7-fcb4-4420-9249-96c057011fe1" }],
  "r2_buckets": [{ "binding": "PHOTOS", "bucket_name": "mambo-jambo-photos" }] }
JSON
npx wrangler d1 execute mambo-jambo-photos --local --config $S/cf/wrangler.jsonc --file=schema.sql -y
node scripts/backup.mjs --local --config $S/cf/wrangler.jsonc --out-dir $S/out --keep
npx wrangler r2 object get mambo-jambo-photos/backups/d1/daily/$(date -u +%F).sql.gz \
  --local --config $S/cf/wrangler.jsonc --file $S/out/roundtrip.sql.gz
node scripts/restore-drill.mjs --dump $S/out/roundtrip.sql.gz --persist-to $S/drill
```
(with an empty schema the drill correctly reports FAILED — seed a few rows, as the recorded run did,
to see it pass).

## Screenshots and traces (paths)

- `docs/audit/handoff/shots/W4-D/restore-drill-local.txt` — the recorded backup + restore drill:
  seed, export (21 tables, 12 insert statements, 11 332 B → 2 319 B gzip), upload, the object read
  back with a matching sha256 (`d56f3e3f…2fac9`), the drill's three sanity answers, PASSED, and the
  defect it found.
- Scratchpad (not in the repo)
  `/private/tmp/claude-501/-Users-ankithkotian-Documents-mambo-jambo-photos-website/7bb4db07-8310-4483-95f0-d75808750f63/scratchpad/W4-D/`:
  `baseline-tests.txt` (183/183 at the start of my run), `full-tests-1..3.txt`, `dryrun.txt`,
  `e2e.txt`, `seed-rows.sql`, `local-cf/` (scratch wrangler config + its local D1/R2 state),
  `out/` (the dump, the gzip, the round-tripped object), `probe/` (a patched copy of `worker.js`
  used to run my tests during the ten minutes another agent's in-flight edit made the module
  unloadable — see "Cut or blocked").

## Deploy or dashboard actions needed

Nothing here is deployed. In addition to waves 1–3's list:

1. **GitHub → Settings → Secrets and variables → Actions**: add `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`. The token is a **Custom Token** scoped to this account with exactly two
   permissions: **D1 → Read** and **Workers R2 Storage → Edit**. Nothing else. Until both exist the
   nightly run fails fast with that sentence in the log.
2. **First backup:** Actions → *Nightly D1 backup* → Run workflow (tick the dry run once to see the
   plan, then run it for real). Confirm the object:
   `npx wrangler r2 object get mambo-jambo-photos/backups/d1/daily/<date>.sql.gz --file /tmp/x.sql.gz`.
3. **R2 retention (once):**
   `npx wrangler r2 bucket lifecycle add mambo-jambo-photos expire-daily-d1-backups backups/d1/daily/ --expire-days 30`
   then `npx wrangler r2 bucket lifecycle list mambo-jambo-photos`. (Dashboard equivalent in runbook
   §4.) Do it **after** the first successful backup, so the prefix exists.
4. **First real restore drill:** the day after step 2, run the drill on that object and paste the
   output into runbook §9. Then quarterly.
5. **Alerting — the user's choice, one of:**
   - a webhook: `npx wrangler secret put ALERT_WEBHOOK_URL` (Slack/Google Chat/Mattermost incoming
     webhook work as-is; for Discord also set the var `ALERT_WEBHOOK_FORMAT=discord`), or
   - email: create a Resend account and API key, `npx wrangler secret put RESEND_API_KEY`, and set
     the var `ALERT_EMAIL_TO=<comma-separated>`. Verify a sending domain and set `ALERT_EMAIL_FROM`,
     otherwise Resend's shared sender only delivers to the account owner's own address.
   Both may be set. Until one is, the cron logs alerts instead of sending them — no error, no noise.
6. **Optional:** `QUEUE_STALL_MINUTES` var if 15 minutes proves too twitchy (a 300-photo session
   with a cold Space can idle for a few minutes; 15 was chosen because the queue consumer retries
   three times within that window).
7. Nothing about the backup Action touches the Worker, D1 or R2 outside `backups/`, and the cron
   change ships with the normal Worker deploy (no separate step).

## Requests to other owners (file, exact change, why)

- **Lead · `README.md`** — add to "Checks"/"Deployment": `docs/runbook.md` is the operations runbook
  (deploys, secrets, rollbacks, lockout reset, backups, restore, alerts); nightly D1 backups run from
  `.github/workflows/backup.yml` into `r2://mambo-jambo-photos/backups/d1/` with a 30-day lifecycle on
  the daily prefix; `node scripts/backup.mjs` and `node scripts/restore-drill.mjs` exist; the
  `*/10 * * * *` cron now also detects an indexing stall and alerts once per incident through
  `ALERT_WEBHOOK_URL` and/or Resend (`RESEND_API_KEY` + `ALERT_EMAIL_TO`), and logs instead when
  neither is set. One sentence for the health paragraph: the cron's log line carries `queue` and
  `alert` fields.
- **Lead / W1-E · `package.json`** (not mine, and only W1-E may touch it) — optional convenience
  scripts: `"backup": "node scripts/backup.mjs"` and `"restore-drill": "node scripts/restore-drill.mjs"`.
  The Action calls `node scripts/backup.mjs` directly, so nothing depends on this.
- **W4-A · `worker.js`** (informational, no change requested) — direct-to-R2 uploads write objects the
  nightly D1 backup does not cover; R2 objects are deliberately out of scope for the backup (runbook
  §4 says so). If a bucket-to-bucket photo copy is ever wanted, it belongs in a separate Action.
- **W4-C · `worker.js`** (informational) — `audit_log` rows are inside the D1 backup, so the audit
  trail is covered by the nightly dump; no separate export needed. If the audit log ever needs a
  longer retention than D1 itself, say so and it can be teed into R2 by the same script.
- **Whoever owns `.gitignore` (lead)** — no change needed: `scripts/backup.mjs` defaults its working
  directory to the OS temp dir, so a hand-run leaves nothing in the working tree.

## Cut or blocked (with reason)

- **No backup has ever run against production, and no lifecycle rule is applied.** Both write to
  production R2, which this wave forbids from this machine. Everything was proven against a local
  miniflare D1 + R2 with the same database and bucket names, including the sha256 round trip. What is
  therefore **unverified**: the real `wrangler d1 export --remote` against a live D1 (size, duration,
  whether a token with only D1-Read can export), `r2 object put --remote` with the Action's token, and
  the lifecycle rule's actual behaviour after 30 days.
- **The GitHub Action has never run.** It is YAML-validated (`js-yaml` parse, shell steps parsed with
  `bash -n`) and its script is tested, but nothing has been pushed, so the runner's `npm ci` +
  `npx --no-install wrangler` path and the expression in the dry-run argument are unproven in CI.
- **No alert has ever been delivered.** No provider is chosen and no secret exists; the code path is
  covered by mocks in `tests/ops.test.mjs` only. The real Resend response shape, a real Slack/Discord
  webhook's acceptance, and R2 read/write of `ops/alert-state.json` from the Workers runtime are
  unverified.
- **The stall query is unverified against real D1** (node mocks only): it is one `SELECT` with three
  scalar sub-selects over `indexing_jobs` and a `datetime('now', '-15 minutes')` comparison against
  `updated_at`, which every writer sets with `CURRENT_TIMESTAMP`. If it ever failed, `queueStall`
  warns and returns `null` and the tick continues.
- **Email provider choice** is the user's: implemented for Resend (the cheapest zero-infrastructure
  option with a free tier) *and* for any webhook relay, so no choice is blocking.
- **Another agent's in-flight edit crossed mine once.** For about ten minutes `worker.js` had two
  `const hex` declarations (W4-A's presign helper at ~line 263 and W4-C's crew-accounts helper at
  ~802), so the module would not load and every Worker test failed. I did not touch either hunk — I
  ran my tests against a patched copy in the scratchpad until the owner fixed it, and the repo file
  loads again. Final state of my run: `npm run check` exit 0, **`npm test` 228/228**,
  `node --test tests/ops.test.mjs` 11/11, `CI=1 npx wrangler deploy --dry-run` exit 0 (183.98 KiB /
  43.86 KiB gzip). `npm run e2e` is **not** green (see "How to verify") for reasons outside this
  workstream.
- **Not done, on purpose:** no second cron cadence (the brief preferred one), no migration, no new
  runtime dependency, no change to the health check or the quota sweep, no R2 object backup, and no
  restore into any remote database.
