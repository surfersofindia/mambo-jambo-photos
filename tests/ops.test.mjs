// W4-D ops: the Worker cron's stall detection and once-per-incident alerts, the nightly D1 backup
// script and the restore drill. Everything runs against mocks — no D1, R2, wrangler, webhook or
// Resend call leaves this process (the scripts are exercised through an injected command runner).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
const source = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const { backupKeys, parseBackupArgs, runBackup } = await import('../scripts/backup.mjs');
const { runRestoreDrill, parseDrillArgs, splitDump, SANITY_QUERIES } = await import('../scripts/restore-drill.mjs');

const TABLES = ['admin_sessions', 'rate_limits', 'events', 'match_hides', 'notify_requests', 'refunds', 'grants'];
// A cron-tick environment: DB answers the health probe, the migration PRAGMAs, the stall query
// (`jobs`) and the quota sweep; PHOTOS holds the alert state (`state`, null = nothing stored) and
// records every put; `fetch` answers the face HEAD ping, the webhook and Resend per `answers`.
function tickEnv({ jobs = { pending: 0, recent: 1, last_progress: '2026-09-17 03:00:00' }, state = null, stallQueryFails = false, r2Fails = false, faceDown = false, answers = {}, vars = {} } = {}) {
  const calls = { stallBinds: [], puts: [], gets: 0, posts: [], runs: [] };
  const env = {
    ALLOWED_ORIGIN: 'https://site.example', FACE_API_URL: 'https://face.example/extract', ...vars,
    DB: { prepare(sql) {
      return { bind(...values) { if (sql.includes('indexing_jobs')) calls.stallBinds.push(values); return this; },
        async first() { if (sql.includes('indexing_jobs')) { if (stallQueryFails) throw new Error('no such table: indexing_jobs'); return jobs; } return { 1: 1 }; },
        async all() {
          if (sql.startsWith('PRAGMA')) return { results: [{ name: 'id' }, { name: 'width' }, { name: 'break_name' }, { name: 'colour_photo_ids_json' }] };
          return { results: TABLES.map(name => ({ name })) };
        }, async run() { calls.runs.push(sql); return {}; } };
    } },
    PHOTOS: { async head() { if (r2Fails) throw new Error('bucket unreachable'); return null; },
      async get(key) { calls.gets += 1; assert.equal(key, 'ops/alert-state.json'); if (r2Fails) throw new Error('bucket unreachable'); return state ? { async text() { return JSON.stringify(state); } } : null; },
      async put(key, body, options) { if (r2Fails) throw new Error('bucket unreachable'); calls.puts.push({ key, body: JSON.parse(body), options }); } },
  };
  const fetchMock = async (url, options = {}) => {
    if (options.method === 'HEAD') { if (faceDown) throw new Error('timeout'); return new Response(null, { status: 200 }); }
    calls.posts.push({ url, headers: Object.fromEntries(new Headers(options.headers || {})), body: JSON.parse(options.body) });
    const answer = answers[url] ?? (() => new Response('ok', { status: 200 }));
    return answer();
  };
  return { env, calls, fetchMock };
}
const STALLED = { pending: 12, recent: 0, last_progress: '2026-09-17 02:40:00' };
async function tick(context, { env, fetchMock }) {
  context.mock.method(globalThis, 'fetch', fetchMock);
  const log = context.mock.method(console, 'log', () => {}); const warn = context.mock.method(console, 'warn', () => {}); const error = context.mock.method(console, 'error', () => {});
  await worker.scheduled({ cron: '*/10 * * * *', scheduledTime: Date.now() }, env, { waitUntil() {} });
  assert.equal(log.mock.callCount(), 1, 'one log line per tick');
  const line = JSON.parse(log.mock.calls[0].arguments[1]);
  context.mock.restoreAll();
  return { line, warnings: warn.mock.calls.map(call => call.arguments.join(' ')), errors: error.mock.calls.map(call => call.arguments.join(' ')) };
}

test('a stalled indexing queue alerts the crew once through the webhook, keeps the incident in ops/alert-state.json and closes it with a recovered note', async context => {
  const hook = 'https://hooks.example/T000/B000';
  // Tick 1: 12 photos waiting, nothing moved for 15 minutes → one alert, incident opened.
  let run = tickEnv({ jobs: STALLED, vars: { ALERT_WEBHOOK_URL: hook } });
  let { line } = await tick(context, run);
  assert.deepEqual(line.queue, { pending: 12, stalled: true, lastProgress: '2026-09-17 02:40:00' });
  assert.equal(line.alert, 'sent'); assert.equal(line.ok, true, 'the health probe itself is fine');
  assert.deepEqual(run.calls.stallBinds, [['-15 minutes']], 'the default window is 15 minutes');
  assert.equal(run.calls.posts.length, 1);
  assert.equal(run.calls.posts[0].url, hook);
  assert.deepEqual(Object.keys(run.calls.posts[0].body), ['text'], 'Slack/Google Chat shape by default');
  assert.match(run.calls.posts[0].body.text, /ALERT/); assert.match(run.calls.posts[0].body.text, /12 photos waiting and no job has moved for 15\+ minutes/); assert.match(run.calls.posts[0].body.text, /runbook/);
  assert.equal(run.calls.puts.length, 1);
  const saved = run.calls.puts[0];
  assert.equal(saved.key, 'ops/alert-state.json'); assert.equal(saved.options.httpMetadata.contentType, 'application/json');
  assert.deepEqual(saved.body.open.keys, ['queue:stall']); assert.ok(saved.body.open.alertedAt); assert.deepEqual(Object.keys(saved.body.seen), ['queue:stall']);
  assert.doesNotMatch(JSON.stringify(saved.body), /hooks\.example/, 'the state never stores the sink');
  // Tick 2: still stalled → nothing sent, state unchanged.
  run = tickEnv({ jobs: STALLED, state: saved.body, vars: { ALERT_WEBHOOK_URL: hook } });
  ({ line } = await tick(context, run));
  assert.equal(line.alert, 'open'); assert.equal(run.calls.posts.length, 0); assert.equal(run.calls.puts.length, 0);
  // Tick 3: a job moved → recovered note, incident cleared.
  run = tickEnv({ jobs: { pending: 3, recent: 2, last_progress: '2026-09-17 03:20:00' }, state: saved.body, vars: { ALERT_WEBHOOK_URL: hook } });
  ({ line } = await tick(context, run));
  assert.equal(line.alert, 'recovered'); assert.equal(run.calls.posts.length, 1); assert.match(run.calls.posts[0].body.text, /RECOVERED/); assert.match(run.calls.posts[0].body.text, /queue:stall/);
  assert.equal(run.calls.puts[0].body.open, null); assert.deepEqual(run.calls.puts[0].body.seen, {});
  // Tick 4: clean and closed → no traffic at all.
  run = tickEnv({ state: run.calls.puts[0].body, vars: { ALERT_WEBHOOK_URL: hook } });
  ({ line } = await tick(context, run));
  assert.equal(line.alert, 'none'); assert.deepEqual(line.queue, { pending: 0, stalled: false, lastProgress: '2026-09-17 03:00:00' }); assert.equal(run.calls.posts.length, 0); assert.equal(run.calls.puts.length, 0);
});

test('a failed deep health probe alerts only when it is seen on two consecutive ticks, and a new problem joins an open incident without a second alert', async context => {
  const vars = { ALERT_WEBHOOK_URL: 'https://hooks.example/x' };
  let run = tickEnv({ faceDown: true, vars });
  let { line } = await tick(context, run);
  assert.equal(line.ok, false); assert.equal(line.checks.face, 'error'); assert.equal(line.alert, 'pending'); assert.deepEqual(line.queue, { pending: 0, stalled: false, lastProgress: '2026-09-17 03:00:00' });
  assert.equal(run.calls.posts.length, 0, 'one slow HEAD never pages anyone');
  assert.equal(run.calls.puts.length, 1); const firstSeen = run.calls.puts[0].body; assert.ok(firstSeen.seen['health:face']); assert.equal(firstSeen.open, null);
  run = tickEnv({ faceDown: true, state: firstSeen, vars });
  ({ line } = await tick(context, run));
  assert.equal(line.alert, 'sent'); assert.equal(run.calls.posts.length, 1); assert.match(run.calls.posts[0].body.text, /face service: no answer to the deep probe within 3 s/);
  const open = run.calls.puts[0].body; assert.deepEqual(open.open.keys, ['health:face']); assert.equal(open.seen['health:face'], firstSeen.seen['health:face'], 'first sighting is kept');
  // The queue stalls while the face incident is open: it joins the incident, nothing else is sent.
  run = tickEnv({ faceDown: true, jobs: STALLED, state: open, vars });
  ({ line } = await tick(context, run));
  assert.equal(line.alert, 'open'); assert.equal(run.calls.posts.length, 0);
  assert.deepEqual(run.calls.puts[0].body.open.keys, ['health:face', 'queue:stall']);
  // Face back but the queue still stalled: the incident stays open, still no repeat.
  run = tickEnv({ jobs: STALLED, state: run.calls.puts[0].body, vars });
  ({ line } = await tick(context, run));
  assert.equal(line.alert, 'open'); assert.equal(run.calls.posts.length, 0); assert.deepEqual(Object.keys(run.calls.puts[0].body.seen), ['queue:stall']);
  // Everything clean: one recovery note naming both.
  run = tickEnv({ state: run.calls.puts[0].body, vars });
  ({ line } = await tick(context, run));
  assert.equal(line.alert, 'recovered'); assert.match(run.calls.posts[0].body.text, /health:face, queue:stall/);
});

test('without a configured sink the tick logs the alert it would have sent, stores no state and still reports the queue', async context => {
  const run = tickEnv({ jobs: STALLED });
  const { line, warnings } = await tick(context, run);
  assert.equal(line.alert, 'unconfigured'); assert.equal(line.queue.stalled, true);
  assert.equal(run.calls.posts.length, 0); assert.equal(run.calls.puts.length, 0);
  assert.ok(warnings.some(text => text.includes('ALERT_WEBHOOK_URL') && text.includes('RESEND_API_KEY') && text.includes('12 photos waiting')), warnings.join('\n'));
  // A Resend key without recipients is not a sink either.
  const half = tickEnv({ jobs: STALLED, vars: { RESEND_API_KEY: 're_test', ALERT_EMAIL_TO: ' , ' } });
  assert.equal((await tick(context, half)).line.alert, 'unconfigured'); assert.equal(half.calls.posts.length, 0);
});

test('email goes through Resend to every configured address, Discord and JSON webhook shapes are honoured, and an alert nobody accepted is retried on the next tick', async context => {
  const hook = 'https://discord.example/api/webhooks/1/abc';
  let run = tickEnv({ jobs: STALLED, vars: { ALERT_WEBHOOK_URL: hook, ALERT_WEBHOOK_FORMAT: 'discord', RESEND_API_KEY: 're_test_key', ALERT_EMAIL_TO: 'crew@example.com, ankith@example.com', ALERT_EMAIL_FROM: 'Alerts <alerts@photos.example>' } });
  let { line } = await tick(context, run);
  assert.equal(line.alert, 'sent'); assert.equal(run.calls.posts.length, 2);
  const [discord, email] = run.calls.posts;
  assert.equal(discord.url, hook); assert.deepEqual(Object.keys(discord.body), ['content']);
  assert.equal(email.url, 'https://api.resend.com/emails'); assert.equal(email.headers.authorization, 'Bearer re_test_key');
  assert.deepEqual(email.body.to, ['crew@example.com', 'ankith@example.com']); assert.equal(email.body.from, 'Alerts <alerts@photos.example>');
  assert.match(email.body.subject, /^\[Surfers of India photos\] ALERT: queue:stall$/); assert.match(email.body.text, /12 photos waiting/);
  assert.doesNotMatch(JSON.stringify(run.calls.posts.map(post => post.body)), /re_test_key/, 'the key travels only in the Authorization header');
  // Structured payload for a custom relay.
  run = tickEnv({ jobs: STALLED, vars: { ALERT_WEBHOOK_URL: hook, ALERT_WEBHOOK_FORMAT: 'json' } });
  await tick(context, run);
  assert.equal(run.calls.posts[0].body.site, 'Surfers of India photos'); assert.equal(run.calls.posts[0].body.status, 'alert'); assert.deepEqual(run.calls.posts[0].body.conditions, ['queue:stall']); assert.ok(run.calls.posts[0].body.time);
  // Webhook 500 and Resend network failure: nothing delivered → incident not opened, so the next tick sends again.
  run = tickEnv({ jobs: STALLED, vars: { ALERT_WEBHOOK_URL: hook, RESEND_API_KEY: 're_test_key', ALERT_EMAIL_TO: 'crew@example.com' }, answers: { [hook]: () => new Response('nope', { status: 500 }), 'https://api.resend.com/emails': () => { throw new Error('socket hang up'); } } });
  const failed = await tick(context, run);
  assert.equal(failed.line.alert, 'unsent'); assert.equal(failed.errors.filter(text => text.includes('alert delivery failed')).length, 2);
  assert.equal(run.calls.puts[0].body.open, null, 'the incident stays unopened');
  run = tickEnv({ jobs: STALLED, state: run.calls.puts[0].body, vars: { ALERT_WEBHOOK_URL: hook } });
  assert.equal((await tick(context, run)).line.alert, 'sent'); assert.equal(run.calls.posts.length, 1);
  // One sink accepting is enough.
  run = tickEnv({ jobs: STALLED, vars: { ALERT_WEBHOOK_URL: hook, RESEND_API_KEY: 're_test_key', ALERT_EMAIL_TO: 'crew@example.com' }, answers: { [hook]: () => new Response('nope', { status: 500 }) } });
  assert.equal((await tick(context, run)).line.alert, 'sent'); assert.deepEqual(run.calls.puts[0].body.open.keys, ['queue:stall']);
});

test('the stall window is configurable, an empty queue or an unmigrated table never alerts, and a bucket outage falls back to the isolate copy so nothing repeats every ten minutes', async context => {
  const vars = { ALERT_WEBHOOK_URL: 'https://hooks.example/x', QUEUE_STALL_MINUTES: '30' };
  let run = tickEnv({ jobs: { pending: 0, recent: 0, last_progress: '2026-09-16 10:00:00' }, vars });
  let { line } = await tick(context, run);
  assert.deepEqual(run.calls.stallBinds, [['-30 minutes']]); assert.equal(line.alert, 'none'); assert.equal(line.queue.stalled, false, 'nothing waiting = nothing stalled');
  run = tickEnv({ jobs: { pending: 5, recent: 1, last_progress: '2026-09-17 03:00:00' }, vars });
  assert.equal((await tick(context, run)).line.alert, 'none', 'progress inside the window');
  run = tickEnv({ stallQueryFails: true, vars });
  const unmigrated = await tick(context, run);
  assert.equal(unmigrated.line.queue, null); assert.equal(unmigrated.line.alert, 'none'); assert.ok(unmigrated.warnings.some(text => text.includes('queue stall check unavailable')));
  // R2 down: the r2 probe fails (tick 1 pending, tick 2 alert) and the state cannot be stored, yet tick 3 does not alert again.
  const down = { r2Fails: true, vars: { ALERT_WEBHOOK_URL: 'https://hooks.example/x' } };
  run = tickEnv(down); assert.equal((await tick(context, run)).line.alert, 'pending');
  run = tickEnv(down); ({ line } = await tick(context, run)); assert.equal(line.alert, 'sent'); assert.equal(run.calls.posts.length, 1); assert.match(run.calls.posts[0].body.text, /R2 photo bucket/);
  run = tickEnv(down); ({ line } = await tick(context, run)); assert.equal(line.alert, 'open'); assert.equal(run.calls.posts.length, 0);
  // Bucket back, state object absent (the puts never landed): the bucket's answer wins and the recovery note goes out from a fresh start — no alert storm, no stale incident.
  run = tickEnv({ vars: { ALERT_WEBHOOK_URL: 'https://hooks.example/x' } }); ({ line } = await tick(context, run)); assert.equal(line.alert, 'none'); assert.equal(run.calls.posts.length, 0);
});

test('wrangler.jsonc keeps the ten-minute cron the stall check rides on, and the alert settings are documented as optional vars and secrets', async () => {
  const config = JSON.parse((await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8')).replace(/^\s*\/\/.*$/gm, ''));
  assert.deepEqual(config.triggers, { crons: ['*/10 * * * *'] });
  for (const name of ['ALERT_WEBHOOK_URL', 'RESEND_API_KEY', 'ALERT_EMAIL_TO']) assert.equal(name in config.vars, false, `${name} is set with wrangler secret put or in the dashboard, never committed`);
  const runbook = await readFile(new URL('../docs/runbook.md', import.meta.url), 'utf8');
  for (const name of ['ALERT_WEBHOOK_URL', 'ALERT_WEBHOOK_FORMAT', 'RESEND_API_KEY', 'ALERT_EMAIL_TO', 'ALERT_EMAIL_FROM', 'QUEUE_STALL_MINUTES', 'ops/alert-state.json', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'lifecycle', 'restore-drill', 'login_attempts', 'wrangler rollback']) assert.ok(runbook.includes(name), `runbook covers ${name}`);
});

// ── scripts/backup.mjs ─────────────────────────────────────────────────────────────────────────
function fakeWrangler(calls, { exportBody = 'PRAGMA defer_foreign_keys=TRUE;\nCREATE TABLE sessions (id TEXT PRIMARY KEY);\nINSERT INTO sessions VALUES(\'s1\');\n', fail = null } = {}) {
  return async (args) => {
    calls.push(args);
    const command = args.slice(0, 2).join(' ');
    if (fail === command) throw new Error(`${command} failed`);
    if (command === 'd1 export') { await writeFile(args[args.indexOf('--output') + 1], exportBody); return { stdout: 'Done!' }; }
    if (command === 'r2 object') return { stdout: 'Upload complete.' };
    if (command === 'd1 execute') return { stdout: '[]' };
    throw new Error(`unexpected wrangler call: ${args.join(' ')}`);
  };
}
test('backup keys: one daily object per date and a monthly copy on the 1st, under the bucket prefix the lifecycle rule expires', () => {
  assert.deepEqual(backupKeys(new Date('2026-09-17T21:30:00Z'), 'backups/d1'), { daily: 'backups/d1/daily/2026-09-17.sql.gz', monthly: null, date: '2026-09-17' });
  assert.deepEqual(backupKeys(new Date('2026-10-01T03:00:00+05:30'), 'backups/d1'), { daily: 'backups/d1/daily/2026-09-30.sql.gz', monthly: null, date: '2026-09-30' }, 'dates are UTC, like the Action\'s clock');
  assert.deepEqual(backupKeys(new Date('2026-10-01T00:10:00Z'), 'backups/d1/'), { daily: 'backups/d1/daily/2026-10-01.sql.gz', monthly: 'backups/d1/monthly/2026-10.sql.gz', date: '2026-10-01' });
  assert.deepEqual(parseBackupArgs(['--local', '--config', 'x/wrangler.jsonc', '--date', '2026-10-01', '--out-dir', 'out', '--keep']), { local: true, config: 'x/wrangler.jsonc', date: '2026-10-01', outDir: 'out', keep: true, database: 'mambo-jambo-photos', bucket: 'mambo-jambo-photos', prefix: 'backups/d1', dryRun: false, skipUpload: false });
  assert.throws(() => parseBackupArgs(['--date', 'yesterday']), /--date/);
  assert.throws(() => parseBackupArgs(['--bogus']), /unknown option/i);
});
test('the backup exports the remote database, gzips the dump, uploads the daily (and monthly) object and removes the local files', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'soi-backup-'));
  const calls = []; const logs = [];
  const report = await runBackup({ date: '2026-10-01', outDir }, { wrangler: fakeWrangler(calls), log: line => logs.push(line) });
  assert.deepEqual(calls[0], ['d1', 'export', 'mambo-jambo-photos', '--remote', '--output', join(outDir, '2026-10-01.sql')]);
  assert.deepEqual(calls[1], ['r2', 'object', 'put', 'mambo-jambo-photos/backups/d1/daily/2026-10-01.sql.gz', '--file', join(outDir, '2026-10-01.sql.gz'), '--content-type', 'application/gzip', '--remote']);
  assert.deepEqual(calls[2], ['r2', 'object', 'put', 'mambo-jambo-photos/backups/d1/monthly/2026-10.sql.gz', '--file', join(outDir, '2026-10-01.sql.gz'), '--content-type', 'application/gzip', '--remote']);
  assert.equal(calls.length, 3);
  assert.equal(report.uploaded.length, 2); assert.ok(report.bytes.sql > 0); assert.ok(report.bytes.gz > 0); assert.equal(report.sha256.length, 64); assert.equal(report.tables, 1); assert.equal(report.rows, 1);
  assert.deepEqual(await readdir(outDir), [], 'temporary files are removed');
  assert.ok(logs.some(line => line.includes('backups/d1/daily/2026-10-01.sql.gz')));
  await rm(outDir, { recursive: true, force: true });
});
test('the backup proves itself against a local database (--local --config), keeps the files with --keep, and a failed export never uploads', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'soi-backup-'));
  const calls = [];
  const report = await runBackup({ date: '2026-09-17', outDir, local: true, config: '/tmp/cf/wrangler.jsonc', keep: true }, { wrangler: fakeWrangler(calls), log() {} });
  assert.deepEqual(calls[0], ['d1', 'export', 'mambo-jambo-photos', '--local', '--output', join(outDir, '2026-09-17.sql'), '--config', '/tmp/cf/wrangler.jsonc']);
  assert.deepEqual(calls[1], ['r2', 'object', 'put', 'mambo-jambo-photos/backups/d1/daily/2026-09-17.sql.gz', '--file', join(outDir, '2026-09-17.sql.gz'), '--content-type', 'application/gzip', '--local', '--config', '/tmp/cf/wrangler.jsonc']);
  assert.deepEqual((await readdir(outDir)).sort(), ['2026-09-17.sql', '2026-09-17.sql.gz']);
  assert.equal(gunzipSync(await readFile(join(outDir, '2026-09-17.sql.gz'))).toString(), await readFile(join(outDir, '2026-09-17.sql'), 'utf8'), 'the gzip round-trips');
  assert.equal(report.uploaded[0], 'backups/d1/daily/2026-09-17.sql.gz');
  const failing = []; await rm(outDir, { recursive: true, force: true });
  await assert.rejects(runBackup({ date: '2026-09-17', outDir: await mkdtemp(join(tmpdir(), 'soi-backup-')) }, { wrangler: fakeWrangler(failing, { fail: 'd1 export' }), log() {} }), /d1 export failed/);
  assert.equal(failing.length, 1, 'no upload after a failed export');
  const empty = []; await assert.rejects(runBackup({ date: '2026-09-17', outDir: await mkdtemp(join(tmpdir(), 'soi-backup-')) }, { wrangler: fakeWrangler(empty, { exportBody: '' }), log() {} }), /empty/);
  assert.equal(empty.length, 1, 'an empty dump is refused before upload');
  const dry = []; const plan = await runBackup({ date: '2026-09-17', dryRun: true }, { wrangler: fakeWrangler(dry), log() {} });
  assert.equal(dry.length, 0); assert.deepEqual(plan.uploaded, []); assert.equal(plan.keys.daily, 'backups/d1/daily/2026-09-17.sql.gz');
});

// ── scripts/restore-drill.mjs ──────────────────────────────────────────────────────────────────
test('a dump is loaded schema-first: wrangler d1 export interleaves the tables, and sessions.cover_photo_id references photos, so the rows cannot go in as they come', () => {
  // Exactly the shape `wrangler d1 export` produces (verified against a real local export).
  const dump = ['PRAGMA defer_foreign_keys=TRUE;',
    'CREATE TABLE sessions (', '  id TEXT PRIMARY KEY,', '  cover_photo_id TEXT REFERENCES photos(id) ON DELETE SET NULL', ');',
    'INSERT INTO "sessions" ("id","cover_photo_id") VALUES(\'sess-1\',NULL);',
    'CREATE TABLE photos (', '  id TEXT PRIMARY KEY', ');',
    'INSERT INTO "photos" ("id") VALUES(\'ph-1\');',
    "INSERT INTO \"photos\" (\"id\") VALUES('a;b''c');",   // a semicolon and an escaped quote inside a literal
    'CREATE INDEX photos_by_session ON photos(id);', ''].join('\n');
  const { schema, data } = splitDump(dump);
  assert.equal(schema.length, 4, schema.join(' | '));
  assert.equal(schema[0], 'PRAGMA defer_foreign_keys=TRUE;');
  assert.ok(schema[1].startsWith('CREATE TABLE sessions') && schema[1].endsWith(');'), 'a multi-line CREATE stays one statement');
  assert.equal(schema[3], 'CREATE INDEX photos_by_session ON photos(id);');
  assert.equal(data.length, 3); assert.ok(data.every(statement => statement.startsWith('INSERT INTO')));
  assert.equal(data[2], "INSERT INTO \"photos\" (\"id\") VALUES('a;b''c');", 'a semicolon inside a string literal does not split a statement');
});
test('the restore drill loads a dump into a fresh local database, runs the three sanity queries and reports them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soi-drill-'));
  const dump = join(dir, 'dump.sql'); await writeFile(dump, 'CREATE TABLE sessions (id TEXT);\nINSERT INTO sessions VALUES(\'s1\');\n');
  const calls = []; const answers = [[{ n: 3, published: 2 }], [{ n: 40, indexed: 38 }], [{ id: 'p1', status: 'verified', amount_paise: 29900, paid_at: '2026-09-16 10:00:00' }]];
  const wrangler = async (args) => { calls.push(args); if (args[1] === 'execute' && args.includes('--command')) return { stdout: JSON.stringify([{ results: answers.shift(), success: true }]) }; return { stdout: '[]' }; };
  const report = await runRestoreDrill({ dump, persistTo: join(dir, 'state') }, { wrangler, log() {} });
  assert.deepEqual(calls[0].slice(0, 6), ['d1', 'execute', 'mambo-jambo-photos', '--local', '--persist-to', join(dir, 'state')]);
  assert.ok(calls[0].includes('--file') && calls[0].includes('-y'));
  assert.match(calls[0][calls[0].indexOf('--file') + 1], /-schema\.sql$/); assert.match(calls[1][calls[1].indexOf('--file') + 1], /-data\.sql$/);
  assert.equal(calls.length, 2 + SANITY_QUERIES.length); assert.equal(SANITY_QUERIES.length, 3);
  assert.deepEqual(report.checks.map(check => check.name), ['sessions', 'photos', 'latest payment']);
  assert.deepEqual(report.checks[0].rows, [{ n: 3, published: 2 }]); assert.equal(report.checks[2].rows[0].id, 'p1');
  assert.equal(report.ok, true); assert.equal(report.dump, dump); assert.ok(report.sha256); assert.equal(report.bytes, (await readFile(dump)).length);
  // A gzipped dump is inflated first; the files handed to wrangler are plain .sql. With no rows in
  // it there is nothing to load after the schema, so only one --file call is made.
  const { gzipSync } = await import('node:zlib'); const gz = join(dir, 'dump.sql.gz'); await writeFile(gz, gzipSync('CREATE TABLE sessions (id TEXT);\n'));
  const gzCalls = []; const loadedFiles = [];
  const gzReport = await runRestoreDrill({ dump: gz, persistTo: join(dir, 'state2') }, { wrangler: async (args) => {
    gzCalls.push(args);
    // Read it while the drill's work directory still exists (it is removed at the end of the run).
    if (args.includes('--file')) loadedFiles.push([args[args.indexOf('--file') + 1], await readFile(args[args.indexOf('--file') + 1], 'utf8')]);
    return { stdout: JSON.stringify([{ results: [], success: true }]) };
  }, log() {} });
  assert.equal(loadedFiles.length, 1); const [loaded, contents] = loadedFiles[0];
  assert.ok(loaded.endsWith('.sql') && !loaded.endsWith('.gz'), loaded); assert.equal(contents, 'CREATE TABLE sessions (id TEXT);\n');
  assert.equal(gzReport.ok, false, 'no session rows = the drill did not prove anything');
  assert.deepEqual(parseDrillArgs(['--dump', 'x.sql.gz', '--persist-to', 'y']), { dump: 'x.sql.gz', persistTo: 'y', database: 'mambo-jambo-photos', keep: false, json: false });
  assert.throws(() => parseDrillArgs([]), /--dump/);
  await rm(dir, { recursive: true, force: true });
});
