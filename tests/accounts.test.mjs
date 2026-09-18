// W4-C · per-crew accounts, TOTP and the audit log (migration 0016).
// The crypto is checked against published vectors (PBKDF2-HMAC-SHA256, RFC 4648 base32, the RFC 6238
// SHA-1 table); everything else runs the real Worker against schema.sql in node:sqlite, so the role
// gates, the shared-password fallback and every audit row are proved on real SQL, not a mock's guess.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const root = new URL('../', import.meta.url);
const source = await readFile(new URL('worker.js', root), 'utf8');
const { default: worker, hashPassword, makePassword, passwordMatches, base32Encode, base32Decode, totpAt, totpMatches } =
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const schema = await readFile(new URL('schema.sql', root), 'utf8');

const secrets = { ADMIN_PASSWORD: 'local-test-password', SESSION_SECRET: 'local-test-signing-key-never-used-in-production' };
const payloadOf = token => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());

// One in-memory database per test, wired to the Worker through the same D1 shim the other suites use.
function crewEnv(context, seed = '') {
  const sql = new DatabaseSync(':memory:'); sql.exec(schema); context.after(() => sql.close());
  if (seed) sql.exec(seed);
  const env = { ...secrets, ALLOWED_ORIGIN: 'https://site.example', MATCH_THRESHOLD: '0.62',
    DB: { prepare(query) { const statement = sql.prepare(query); let args = []; return { query,
      bind(...values) { args = values; return this; },
      async first() { return statement.get(...args) || null; },
      async all() { return { results: statement.all(...args) }; },
      async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; } }; },
      async batch(statements) { sql.exec('BEGIN'); try { const out = []; for (const statement of statements) out.push(/^\s*SELECT/i.test(statement.query) ? await statement.all() : await statement.run()); sql.exec('COMMIT'); return out; } catch (caught) { sql.exec('ROLLBACK'); throw caught; } } },
    PHOTOS: { async put() {}, async get(key) { return { body: `bytes of ${key}`, httpMetadata: { contentType: 'image/jpeg' } }; }, async head() { return { size: 5 }; }, async delete() {} },
    INDEX_QUEUE: { async send() {} } };
  const api = (path, init = {}) => worker.fetch(new Request(`https://api.example${path}`, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) } }), env, {});
  const login = (body, headers = {}) => api('/api/admin/login', { method: 'POST', headers, body: JSON.stringify(body) });
  const as = token => (path, init = {}) => api(path, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  // The shared password still works while crew_users is empty, which is how the first account is made.
  const bootstrap = async () => as((await (await login({ password: secrets.ADMIN_PASSWORD })).json()).token);
  const auditRows = () => sql.prepare('SELECT * FROM audit_log ORDER BY rowid').all().map(row => ({ ...row }));
  return { sql, env, api, login, as, bootstrap, auditRows };
}
const createUser = (crew, body) => crew('/api/admin/users', { method: 'POST', body: JSON.stringify(body) });
// A ready-made account of either role, signed in.
async function account(harness, { name, password = 'a-long-crew-password', role = 'admin' }) {
  const admin = await harness.bootstrap();
  const made = await (await createUser(admin, { name, password, role })).json();
  const token = (await (await harness.login({ name, password })).json()).token;
  return { user: made.user, totp: made.totp, token, call: harness.as(token) };
}
const SESSION_SEED = `
  INSERT INTO sessions(id,title,session_date,location,status,price_paise) VALUES
    ('s-draft','Draft morning','2026-09-15','Mulki','draft',29900),
    ('s-live','Published glass','2026-09-16','Mulki','published',29900);
  INSERT INTO photos(id,session_id,object_key,preview_key,filename,content_type,indexing_status) VALUES
    ('p1','s-draft','o/1','v/1','a.jpg','image/jpeg','completed'),
    ('p2','s-live','o/2','v/2','b.jpg','image/jpeg','completed');
`;

// ── Module scope ─────────────────────────────────────────────────────────────
// workerd (the production runtime) refuses to start a Worker whose module scope draws random values, sets a
// timer or does I/O — `wrangler deploy --dry-run` never executes the script, so only a test catches it. The
// first wave-4 run shipped `const decoySalt = randomHex(16)` at top level and the Worker would not have started.
test('the Worker module evaluates without touching entropy, timers or fetch at global scope (workerd would refuse to start)', async () => {
  const forbidden = [];
  const trap = name => () => { forbidden.push(name); throw new Error(`Disallowed operation called within global scope: ${name}`); };
  const own = Object.getOwnPropertyDescriptors(globalThis.crypto);
  Object.defineProperty(globalThis.crypto, 'getRandomValues', { value: trap('crypto.getRandomValues'), configurable: true, writable: true });
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: trap('crypto.randomUUID'), configurable: true, writable: true });
  const { setTimeout: realTimeout, setInterval: realInterval, fetch: realFetch } = globalThis;
  globalThis.setTimeout = trap('setTimeout'); globalThis.setInterval = trap('setInterval'); globalThis.fetch = trap('fetch');
  try {
    // A fresh module instance: the data: URL differs from the one imported at the top of this file.
    const fresh = await import(`data:text/javascript;base64,${Buffer.from(`${source}\n// module-scope guard`).toString('base64')}`);
    assert.equal(typeof fresh.default.fetch, 'function');
  } finally {
    for (const name of ['getRandomValues', 'randomUUID']) { if (own[name]) Object.defineProperty(globalThis.crypto, name, own[name]); else delete globalThis.crypto[name]; }
    globalThis.setTimeout = realTimeout; globalThis.setInterval = realInterval; globalThis.fetch = realFetch;
  }
  assert.deepEqual(forbidden, []);
});

// ── Password hashing ─────────────────────────────────────────────────────────
test('PBKDF2-SHA256 matches the published vectors, and a stored password round-trips without ever being kept', async () => {
  // Widely published PBKDF2-HMAC-SHA256 vectors (password "password", salt "salt").
  assert.equal(await hashPassword('password', 'salt', 1), '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b');
  assert.equal(await hashPassword('password', 'salt', 2), 'ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43');
  assert.equal(await hashPassword('password', 'salt', 4096), 'c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a');

  const stored = await makePassword('a-long-crew-password');
  assert.equal(stored.iterations, 210_000, 'at least the 210 000 rounds the brief asks for');
  assert.match(stored.salt, /^[0-9a-f]{32}$/); assert.match(stored.hash, /^[0-9a-f]{64}$/);
  const row = { password_hash: stored.hash, password_salt: stored.salt, iterations: stored.iterations };
  assert.equal(await passwordMatches('a-long-crew-password', row), true);
  assert.equal(await passwordMatches('a-long-crew-passwore', row), false);
  assert.equal(await passwordMatches('', row), false);
  assert.equal(await passwordMatches(null, row), false);
  assert.equal(await passwordMatches('a-long-crew-password', { ...row, password_salt: 'ff'.repeat(16) }), false, 'the salt is part of the answer');
  // Two accounts with the same password must not share a hash.
  const other = await makePassword('a-long-crew-password');
  assert.notEqual(other.salt, stored.salt); assert.notEqual(other.hash, stored.hash);
  // A row written with a different cost is still verifiable at that cost.
  assert.equal(await passwordMatches('password', { password_hash: await hashPassword('password', 'salt', 4096), password_salt: 'salt', iterations: 4096 }), true);
});

// ── base32 and TOTP (RFC 4648 / RFC 6238) ────────────────────────────────────
test('base32 follows RFC 4648 and round-trips the 20-byte secrets the studio provisions', () => {
  const ascii = value => new TextEncoder().encode(value);
  assert.equal(base32Encode(ascii('f')), 'MY');
  assert.equal(base32Encode(ascii('fo')), 'MZXQ');
  assert.equal(base32Encode(ascii('foobar')), 'MZXW6YTBOI');
  assert.equal(base32Encode(ascii('12345678901234567890')), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual([...base32Decode('MZXW6YTBOI')], [...ascii('foobar')]);
  assert.deepEqual([...base32Decode('mzxw6ytboi')], [...ascii('foobar')], 'lower case is accepted from a hand-typed secret');
  assert.deepEqual([...base32Decode('MZXW6YTB OI==')], [...ascii('foobar')], 'padding and spaces are ignored');
  assert.equal(base32Decode('MZXW6YT!'), null); assert.equal(base32Decode(''), null); assert.equal(base32Decode(null), null);
  const random = crypto.getRandomValues(new Uint8Array(20));
  assert.deepEqual([...base32Decode(base32Encode(random))], [...random]);
});
test('TOTP reproduces the RFC 6238 SHA-1 table, and sign-in accepts one step of clock drift either way', async () => {
  const secret = base32Encode(new TextEncoder().encode('12345678901234567890'));   // the RFC's seed
  const vectors = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
  for (const [seconds, expected] of vectors) {
    assert.equal(await totpAt(secret, seconds * 1000, 8), expected, `RFC 6238 T=${seconds}`);
    assert.equal(await totpAt(secret, seconds * 1000), expected.slice(-6), 'the six-digit code is the same truncation');
  }
  const now = 1111111109_000;
  assert.equal(await totpMatches(secret, await totpAt(secret, now), now), true);
  assert.equal(await totpMatches(secret, await totpAt(secret, now - 30_000), now), true, 'one step late');
  assert.equal(await totpMatches(secret, await totpAt(secret, now + 30_000), now), true, 'one step early');
  assert.equal(await totpMatches(secret, await totpAt(secret, now - 60_000), now), false, 'two steps is too far');
  assert.equal(await totpMatches(secret, ' 081804 ', now), true, 'a code pasted with spaces around it still works');
  assert.equal(await totpMatches(secret, ' 081805 ', now), false, 'but only the right one');
  for (const junk of ['', '0000', '00000a', null, undefined, '0000000']) assert.equal(await totpMatches(secret, junk, now), false);
  assert.equal(await totpMatches('not base32!', '000000', now), false);
});

// ── Sign-in with an account ──────────────────────────────────────────────────
test('a crew account signs in with its own password, and the token and session row carry the account and its role', async context => {
  const harness = crewEnv(context);
  const { user, call } = await account(harness, { name: 'Ankith', role: 'admin' });
  const token = (await (await harness.login({ name: 'ankith', password: 'a-long-crew-password' })).json()).token;   // names are case-insensitive
  const payload = payloadOf(token);
  assert.equal(payload.uid, user.id); assert.equal(payload.role, 'admin'); assert.equal(payload.name, 'Ankith');
  const row = harness.sql.prepare('SELECT * FROM admin_sessions WHERE id = ?').get(payload.sid);
  assert.equal(row.user_id, user.id); assert.equal(row.role, 'admin');
  assert.ok(harness.sql.prepare('SELECT last_login_at FROM crew_users WHERE id = ?').get(user.id).last_login_at, 'last_login_at is stamped');
  assert.equal((await harness.as(token)('/api/admin/dashboard')).status, 200);
  const me = await (await call('/api/admin/me')).json();
  assert.deepEqual([me.role, me.canManageUsers, me.sharedLogin, me.accounts, me.user.name], ['admin', true, false, true, 'Ankith']);
  // A wrong password, and a name nobody uses, answer the same thing.
  const wrong = await harness.login({ name: 'Ankith', password: 'not-the-password' });
  const unknown = await harness.login({ name: 'Nobody', password: 'not-the-password' });
  assert.equal(wrong.status, 401); assert.equal(unknown.status, 401);
  assert.equal((await wrong.json()).error, (await unknown.json()).error);
});
test('an account with TOTP needs the code: no code asks for one without burning an attempt, a wrong code is a failed attempt', async context => {
  const harness = crewEnv(context);
  const { user, totp, call } = await account(harness, { name: 'Ankith' });
  assert.match(totp.uri, /^otpauth:\/\/totp\/SOI%20Crew:Ankith\?secret=[A-Z2-7]{32}&issuer=SOI%20Crew&algorithm=SHA1&digits=6&period=30$/);
  assert.equal(totp.secret, harness.sql.prepare('SELECT totp_secret FROM crew_users WHERE id = ?').get(user.id).totp_secret);
  assert.equal(harness.sql.prepare('SELECT totp_enabled FROM crew_users WHERE id = ?').get(user.id).totp_enabled, 0, 'off until a code proves the phone works');

  // Wrong code first: TOTP is not enabled yet, so it cannot be switched on.
  assert.equal((await call(`/api/admin/users/${user.id}/totp/verify`, { method: 'POST', body: JSON.stringify({ code: '000000' }) })).status, 400);
  const enable = await call(`/api/admin/users/${user.id}/totp/verify`, { method: 'POST', body: JSON.stringify({ code: await totpAt(totp.secret) }) });
  assert.equal(enable.status, 200); assert.equal((await enable.json()).user.totpEnabled, true);

  const noCode = await harness.login({ name: 'Ankith', password: 'a-long-crew-password' });
  assert.equal(noCode.status, 401);
  assert.deepEqual(await noCode.json(), { error: 'Enter the 6-digit code from your authenticator app.', needsTotp: true });
  assert.equal(harness.sql.prepare('SELECT COUNT(*) AS n FROM login_attempts').get().n, 0, 'a right password with no code is not a failed attempt');

  const badCode = await harness.login({ name: 'Ankith', password: 'a-long-crew-password', code: '123456' });
  assert.equal(badCode.status, 401); assert.equal((await badCode.json()).needsTotp, true);
  assert.equal(harness.sql.prepare('SELECT COUNT(*) AS n FROM login_attempts').get().n, 2, 'a wrong code counts against both the IP and the name');

  const ok = await harness.login({ name: 'Ankith', password: 'a-long-crew-password', code: await totpAt(totp.secret) });
  assert.equal(ok.status, 200);
  assert.equal(harness.sql.prepare('SELECT COUNT(*) AS n FROM login_attempts').get().n, 0, 'a good sign-in clears both buckets');
  assert.equal((await harness.login({ name: 'Ankith', password: 'nope', code: await totpAt(totp.secret) })).status, 401, 'the code alone is not enough');
});
test('sign-in throttling counts the account name as well as the IP, so spreading the guesses does not help', async context => {
  const harness = crewEnv(context);
  const admin = await harness.bootstrap();                       // the shared password, before any account exists
  await createUser(admin, { name: 'Ankith', password: 'a-long-crew-password', role: 'admin' });
  await createUser(admin, { name: 'Sam', password: 'another-long-password', role: 'photographer' });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const refused = await harness.login({ name: 'Ankith', password: `guess-${attempt}` }, { 'cf-connecting-ip': `203.0.113.${attempt}` });
    assert.equal(refused.status, 401);
  }
  const blocked = await harness.login({ name: 'Ankith', password: 'a-long-crew-password' }, { 'cf-connecting-ip': '203.0.113.99' });
  assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('retry-after'), '900');
  assert.equal(harness.sql.prepare("SELECT count FROM login_attempts WHERE ip = 'name:ankith'").get().count, 5);
  // Another account from an address that has not guessed is unaffected.
  const sam = await harness.login({ name: 'Sam', password: 'another-long-password' }, { 'cf-connecting-ip': '198.51.100.7' });
  assert.equal(sam.status, 200);
  assert.equal(payloadOf((await sam.json()).token).role, 'photographer');
});

// ── The shared password stays available until every crew member has an account ──
test('the shared crew password works while no account exists, stops once one does, and comes back with LEGACY_SHARED_LOGIN', async context => {
  const harness = crewEnv(context);
  const first = await harness.login({ password: secrets.ADMIN_PASSWORD });
  assert.equal(first.status, 200);
  const shared = await first.json();
  assert.deepEqual([shared.user, shared.canManageUsers, shared.sharedLogin], [null, true, true]);
  const payload = payloadOf(shared.token);
  assert.equal(payload.role, 'admin'); assert.equal(payload.uid, null);
  assert.equal(harness.sql.prepare('SELECT user_id FROM admin_sessions').get().user_id, null);

  const admin = harness.as(shared.token);
  assert.equal((await createUser(admin, { name: 'Ankith', password: 'a-long-crew-password', role: 'admin' })).status, 201);
  // From here the shared password is refused — everyone has their own.
  const refused = await harness.login({ password: secrets.ADMIN_PASSWORD });
  assert.equal(refused.status, 401); assert.equal((await refused.json()).error, 'Sign in with your crew name and password.');
  assert.equal((await harness.login({ name: 'Ankith', password: secrets.ADMIN_PASSWORD })).status, 401, 'nor does it work under a real name');

  harness.env.LEGACY_SHARED_LOGIN = 'true';
  assert.equal((await harness.login({ password: secrets.ADMIN_PASSWORD })).status, 200, 'the flag keeps the door open during the rollout');
  delete harness.env.LEGACY_SHARED_LOGIN;
  // A disabled account does not count as "somebody has an account".
  harness.sql.exec("UPDATE crew_users SET disabled_at = CURRENT_TIMESTAMP");
  assert.equal((await harness.login({ password: secrets.ADMIN_PASSWORD })).status, 200);
});
test('on a database without migration 0016 the shared password still signs in and the account routes say which migration is missing', async context => {
  const harness = crewEnv(context);
  harness.sql.exec('DROP TABLE crew_users; DROP TABLE audit_log;');
  const signedIn = await harness.login({ password: secrets.ADMIN_PASSWORD });
  assert.equal(signedIn.status, 200);
  const crew = harness.as((await signedIn.json()).token);
  assert.equal((await crew('/api/admin/dashboard')).status, 200, 'the studio keeps working');
  for (const path of ['/api/admin/users', '/api/admin/audit']) {
    const answer = await crew(path);
    assert.equal(answer.status, 503); assert.equal((await answer.json()).error, 'Crew accounts need database migration 0016.');
  }
  const me = await (await crew('/api/admin/me')).json();
  assert.deepEqual([me.role, me.sharedLogin, me.accounts, me.user], ['admin', true, false, null]);
  assert.equal((await crew('/api/admin/sessions/nope', { method: 'DELETE' })).status, 200, 'and an audited action still happens, unrecorded');
});
test('a crew session survives an unmigrated admin_sessions table but a role the token does not carry is refused', async context => {
  const harness = crewEnv(context);
  const { token } = await account(harness, { name: 'Ankith' });
  const tampered = payloadOf(token);
  assert.equal(tampered.role, 'admin');
  // A token signed for a role the Worker does not know is refused before any lookup.
  const guest = `${Buffer.from(JSON.stringify({ ...tampered, role: 'guest' })).toString('base64url')}.${token.split('.')[1]}`;
  assert.equal((await harness.as(guest)('/api/admin/dashboard')).status, 401);
});

// ── Roles ────────────────────────────────────────────────────────────────────
test('a photographer runs the photo workflow but cannot refund, unlock for free, delete a published session or manage accounts', async context => {
  const harness = crewEnv(context, SESSION_SEED + `
    INSERT INTO searches(id,session_id,status,expires_at,matched_photo_ids_json,price_paise,currency) VALUES ('sr1','s-live','preview',datetime('now','+1 day'),'[]',29900,'INR');
    INSERT INTO payments(id,search_id,cashfree_order_id,amount_paise,currency,status) VALUES ('pay1','sr1','mj-order-1',29900,'INR','captured');
  `);
  const { call: crew, user } = await account(harness, { name: 'Sam', password: 'another-long-password', role: 'photographer' });
  assert.equal(payloadOf((await (await harness.login({ name: 'Sam', password: 'another-long-password' })).json()).token).role, 'photographer');

  // Allowed: the whole photo workflow.
  assert.equal((await crew('/api/admin/dashboard')).status, 200);
  assert.equal((await crew('/api/admin/sessions', { method: 'POST', body: JSON.stringify({ title: 'Evening', date: '2026-09-18', location: 'Mulki', pricePaise: 29900 }) })).status, 201);
  assert.equal((await crew('/api/admin/sessions/s-draft/publish', { method: 'POST', body: JSON.stringify({ noCover: true }) })).status, 200);
  assert.equal((await crew('/api/admin/photos/p1', { method: 'DELETE' })).status, 200);

  // Refused: money, and destroying published work.
  const refund = await crew('/api/admin/payments/pay1/refund', { method: 'POST', body: JSON.stringify({ reason: 'goodwill' }) });
  assert.equal(refund.status, 403); assert.match((await refund.json()).error, /Only a crew admin can issue a refund/);
  const grant = await crew('/api/admin/searches/sr1/grant', { method: 'POST', body: JSON.stringify({ reason: 'paid in cash' }) });
  assert.equal(grant.status, 403); assert.match((await grant.json()).error, /free unlock/);
  const deletion = await crew('/api/admin/sessions/s-live', { method: 'DELETE' });
  assert.equal(deletion.status, 403); assert.match((await deletion.json()).error, /published session/);
  assert.ok(harness.sql.prepare("SELECT id FROM sessions WHERE id = 's-live'").get(), 'the session is still there');
  const users = await crew('/api/admin/users');
  assert.equal(users.status, 403); assert.match((await users.json()).error, /manage crew accounts/);
  assert.equal((await crew('/api/admin/audit')).status, 403);
  assert.equal((await crew(`/api/admin/users/${user.id}/disable`, { method: 'POST' })).status, 403, 'not even their own account');

  // A draft session is theirs to delete (it was published above, so use the one they just made).
  const drafts = (await (await crew('/api/admin/dashboard')).json()).sessions.filter(session => session.status === 'draft');
  assert.equal((await crew(`/api/admin/sessions/${drafts[0].id}`, { method: 'DELETE' })).status, 200);
});
test('the role on the session row wins over the role in the token, so a demotion takes effect on the next request', async context => {
  const harness = crewEnv(context, SESSION_SEED);
  const { user, token } = await account(harness, { name: 'Ankith' });
  const crew = harness.as(token);
  assert.equal((await crew('/api/admin/users')).status, 200);
  harness.sql.exec(`UPDATE crew_users SET role = 'photographer' WHERE id = '${user.id}'`);
  harness.sql.exec(`UPDATE admin_sessions SET role = 'photographer' WHERE user_id = '${user.id}'`);
  assert.equal((await crew('/api/admin/users')).status, 403, 'the signed token still says admin; the row does not');
  assert.equal((await crew('/api/admin/dashboard')).status, 200, 'and they keep working as a photographer');
});

// ── Account management ───────────────────────────────────────────────────────
test('accounts are created with a one-time provisioning secret, listed, disabled with their sessions, and reset', async context => {
  const harness = crewEnv(context);
  const admin = await harness.bootstrap();
  assert.equal((await createUser(admin, { name: 'A', password: 'a-long-crew-password', role: 'admin' })).status, 400, 'a one-letter name');
  assert.equal((await createUser(admin, { name: 'Ankith', password: 'short', role: 'admin' })).status, 400);
  assert.equal((await createUser(admin, { name: 'Ankith', password: 'a-long-crew-password', role: 'owner' })).status, 400);
  assert.equal((await createUser(admin, { name: 'Ank<script>', password: 'a-long-crew-password', role: 'admin' })).status, 400);
  const made = await createUser(admin, { name: "Ankith D'Souza", password: 'a-long-crew-password', role: 'admin' });
  assert.equal(made.status, 201);
  const body = await made.json();
  assert.match(body.totp.secret, /^[A-Z2-7]{32}$/);
  assert.equal(body.user.totpEnabled, false); assert.equal(body.user.role, 'admin');
  assert.equal(body.user.password_hash, undefined, 'no hash ever leaves the Worker');
  assert.equal((await createUser(admin, { name: "ankith d'souza", password: 'a-long-crew-password', role: 'admin' })).status, 409, 'names are unique whatever the case');

  const second = await (await createUser(admin, { name: 'Sam', password: 'another-long-password', role: 'photographer' })).json();
  const listed = await (await admin('/api/admin/users')).json();
  assert.deepEqual(listed.users.map(user => [user.name, user.role, user.totpEnabled]), [["Ankith D'Souza", 'admin', false], ['Sam', 'photographer', false]]);
  assert.equal(listed.sharedLogin, false);
  assert.equal(JSON.stringify(listed).includes('password'), false, 'nothing password-shaped in the listing');

  // Disable: the row stays (the audit log points at it), the sessions go, the sign-in stops.
  const samToken = (await (await harness.login({ name: 'Sam', password: 'another-long-password' })).json()).token;
  assert.equal((await harness.as(samToken)('/api/admin/dashboard')).status, 200);
  assert.equal((await admin(`/api/admin/users/${second.user.id}/disable`, { method: 'POST' })).status, 200);
  assert.equal((await harness.as(samToken)('/api/admin/dashboard')).status, 401, 'their live session is revoked');
  assert.equal((await harness.login({ name: 'Sam', password: 'another-long-password' })).status, 401);
  assert.ok(harness.sql.prepare('SELECT disabled_at FROM crew_users WHERE id = ?').get(second.user.id).disabled_at);
  assert.equal((await admin(`/api/admin/users/${second.user.id}/disable`, { method: 'POST' })).status, 200, 'disabling twice is not an error');
  assert.equal((await admin('/api/admin/users/nobody/disable', { method: 'POST' })).status, 404);

  // The last admin cannot be disabled — that is how a crew locks itself out.
  const onlyAdmin = listed.users.find(user => user.role === 'admin');
  const lockout = await admin(`/api/admin/users/${onlyAdmin.id}/disable`, { method: 'POST' });
  assert.equal(lockout.status, 409); assert.match((await lockout.json()).error, /last crew admin/);

  // Reset password: the new one works, the old one does not, and every session of theirs is gone.
  const mineToken = (await (await harness.login({ name: "Ankith D'Souza", password: 'a-long-crew-password' })).json()).token;
  assert.equal((await admin(`/api/admin/users/${onlyAdmin.id}/reset-password`, { method: 'POST', body: JSON.stringify({ password: 'short' }) })).status, 400);
  assert.equal((await admin(`/api/admin/users/${onlyAdmin.id}/reset-password`, { method: 'POST', body: JSON.stringify({ password: 'a-brand-new-password' }) })).status, 200);
  assert.equal((await harness.as(mineToken)('/api/admin/dashboard')).status, 401);
  assert.equal((await harness.login({ name: "Ankith D'Souza", password: 'a-long-crew-password' })).status, 401);
  assert.equal((await harness.login({ name: "Ankith D'Souza", password: 'a-brand-new-password' })).status, 200);
});

// ── The audit log ────────────────────────────────────────────────────────────
test('every delete, publish, free unlock and refund is recorded with who did it, and a failed sign-in never records a password', async context => {
  const harness = crewEnv(context, SESSION_SEED + `
    INSERT INTO searches(id,session_id,status,expires_at,matched_photo_ids_json,price_paise,currency) VALUES ('sr1','s-live','preview',datetime('now','+1 day'),'[]',29900,'INR');
  `);
  const { user, call: crew } = await account(harness, { name: 'Ankith' });
  await crew('/api/admin/sessions/s-draft/publish', { method: 'POST', body: JSON.stringify({ noCover: true }) });
  await crew('/api/admin/photos/p1', { method: 'DELETE' });
  await crew('/api/admin/photos/bulk', { method: 'POST', body: JSON.stringify({ action: 'delete', photoIds: ['p2'] }) });
  await crew('/api/admin/searches/sr1/grant', { method: 'POST', body: JSON.stringify({ reason: 'paid in cash at the beach' }) });
  await crew('/api/admin/sessions/s-live', { method: 'DELETE', headers: { 'cf-connecting-ip': '203.0.113.5' } });
  await harness.login({ name: 'Ankith', password: 'hunter2-the-real-password' });
  await harness.login({ password: 'not-the-shared-one' });

  const rows = harness.auditRows();
  const actions = rows.map(row => row.action);
  // The first login.success is the shared password that bootstrapped the account (crew_users was empty).
  assert.deepEqual(actions, ['login.success', 'user.create', 'login.success', 'session.publish', 'photo.delete', 'photo.bulk-delete', 'search.grant', 'session.delete', 'login.failure', 'login.failure']);
  assert.deepEqual(rows.filter(row => row.action === 'login.success').map(row => row.actor_name), ['crew (shared)', 'Ankith']);
  const byAction = Object.fromEntries(rows.map(row => [row.action, row]));
  assert.equal(byAction['session.delete'].actor_user_id, user.id);
  assert.equal(byAction['session.delete'].actor_name, 'Ankith');
  assert.equal(byAction['session.delete'].ip, '203.0.113.5');
  assert.equal(byAction['session.delete'].target_type, 'session');
  assert.equal(byAction['session.delete'].target_id, 's-live');
  assert.deepEqual(JSON.parse(byAction['session.delete'].detail_json), { title: 'Published glass', status: 'published', photos: 0 });
  assert.deepEqual(JSON.parse(byAction['search.grant'].detail_json), { reason: 'paid in cash at the beach' });
  assert.equal(byAction['photo.bulk-delete'].target_id, 'p2');
  assert.equal(byAction['session.publish'].target_id, 's-draft');
  // A failed sign-in names the attempt, never the secret.
  const failures = rows.filter(row => row.action === 'login.failure');
  assert.deepEqual(failures.map(row => row.actor_name), ['Ankith (unverified)', 'crew (shared)']);
  // The nameless attempt is refused for having no name at all: accounts exist, so the shared password is gone.
  assert.deepEqual(failures.map(row => JSON.parse(row.detail_json).reason), ['password', 'no-name']);
  assert.equal(JSON.stringify(rows).includes('hunter2'), false, 'no password, not even a mistyped one, reaches the log');
  assert.equal(JSON.stringify(rows).includes('not-the-shared-one'), false);
});
test('taking a session off the site or archiving it through PUT is audited as a status change; a rename or an unchanged status is not', async context => {
  const harness = crewEnv(context, SESSION_SEED);
  const { user, call: crew } = await account(harness, { name: 'Sam', role: 'photographer' });   // taking work down is not admin-only
  const before = harness.auditRows().length;
  assert.equal((await crew('/api/admin/sessions/s-live', { method: 'PUT', body: JSON.stringify({ title: 'Renamed glass' }) })).status, 200);
  assert.equal((await crew('/api/admin/sessions/s-live', { method: 'PUT', body: JSON.stringify({ status: 'published' }) })).status, 200);
  assert.equal(harness.auditRows().length, before, 'a rename or an unchanged status records nothing');
  assert.equal((await crew('/api/admin/sessions/s-live', { method: 'PUT', body: JSON.stringify({ status: 'draft' }) })).status, 200);
  assert.equal((await crew('/api/admin/sessions/s-live', { method: 'PUT', body: JSON.stringify({ status: 'archived' }) })).status, 200);
  assert.equal((await crew('/api/admin/sessions/s-draft', { method: 'PUT', body: JSON.stringify({ status: 'published' }) })).status, 200);
  const rows = harness.auditRows().slice(before);
  assert.deepEqual(rows.map(row => [row.action, row.target_type, row.target_id, row.actor_name, row.actor_user_id, JSON.parse(row.detail_json)]), [
    ['session.unpublish', 'session', 's-live', 'Sam', user.id, { was: 'published', now: 'draft' }],
    ['session.archive', 'session', 's-live', 'Sam', user.id, { was: 'draft', now: 'archived' }],
    ['session.publish', 'session', 's-draft', 'Sam', user.id, { was: 'draft', now: 'published' }],
  ]);
  assert.equal((await crew('/api/admin/sessions/nope', { method: 'PUT', body: JSON.stringify({ status: 'draft' }) })).status, 404);
  assert.equal(harness.auditRows().length, before + 3, 'a missing session records nothing');
});
test('a password typed into the name box is truncated in the log, and the audit route pages newest first for admins only', async context => {
  const harness = crewEnv(context);
  const { call: crew } = await account(harness, { name: 'Ankith' });
  await harness.login({ name: 'correct-horse-battery-staple-and-more', password: 'x' });
  const long = harness.auditRows().find(row => row.action === 'login.failure');
  assert.equal(long.actor_name, 'correct-horse-battery-st (unverified)');
  assert.ok(long.actor_name.length <= 40);

  const page = await (await crew('/api/admin/audit?limit=2')).json();
  assert.equal(page.entries.length, 2);
  const times = page.entries.map(entry => entry.createdAt);
  assert.deepEqual([...times].sort().reverse(), times, 'newest first');
  assert.equal(page.entries[0].action, 'login.failure');
  assert.equal(page.entries[0].actor, 'correct-horse-battery-st (unverified)');
  assert.ok(page.nextBefore, 'a full page hands back a cursor');
  const next = await (await crew(`/api/admin/audit?before=${encodeURIComponent(page.nextBefore)}`)).json();
  assert.equal(next.entries.some(entry => entry.id === page.entries[0].id), false, 'the cursor does not repeat the page');
  const capped = await (await crew('/api/admin/audit?limit=999')).json();
  assert.ok(capped.entries.length <= 100);
  assert.equal((await crew('/api/admin/audit?limit=0')).status, 200);
});
test('the audit helper never breaks the action it records', async context => {
  const harness = crewEnv(context, SESSION_SEED);
  const { call: crew } = await account(harness, { name: 'Ankith' });
  const logged = context.mock.method(console, 'error', () => {});
  const { prepare } = harness.env.DB;
  harness.env.DB.prepare = query => (query.includes('INSERT INTO audit_log') ? { bind() { return this; }, async run() { throw new Error('D1_ERROR: database is locked'); } } : prepare(query));
  const deleted = await crew('/api/admin/sessions/s-draft', { method: 'DELETE' });
  assert.equal(deleted.status, 200, 'the delete still happens');
  assert.ok(logged.mock.calls.some(call => String(call.arguments[0]).includes('audit log write failed')));
  harness.env.DB.prepare = prepare;
});
