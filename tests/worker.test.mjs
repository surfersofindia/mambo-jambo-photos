import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
const source = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
const { default: worker, imageDimensions, quotaKeyFor } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const request = (path, options) => new Request(`https://example.com${path}`, options);
const jsonRequest = (path, body, options = {}) => request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...options });
test('payment endpoints reject malformed requests without touching payment providers', async () => {
  for (const path of ['/api/checkout', '/api/payment/verify', '/api/payment/webhook']) {
    const response = await worker.fetch(jsonRequest(path, {}), {}, {});
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});
test('CORS allows authenticated session edits', async () => {
  const response = await worker.fetch(request('/api/admin/sessions/test', { method: 'OPTIONS', headers: { Origin: 'https://site.example' } }), { ALLOWED_ORIGIN: 'https://site.example' }, {});
  assert.match(response.headers.get('access-control-allow-methods'), /PUT/);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://site.example');
});
function selfieForm(consent = false, type = 'image/jpeg') {
  const form = new FormData(); form.append('sessionId', 'session-1'); form.append('file', new Blob(['image'], { type }), 'selfie.jpg');
  if (consent) form.append('consent', 'true'); return form;
}
test('selfie matching requires explicit consent before database or inference access', async () => {
  const response = await worker.fetch(request('/api/match', { method: 'POST', body: selfieForm() }), {}, {});
  assert.equal(response.status, 400); assert.match((await response.json()).error, /consent/);
});
test('selfie matching rejects unsupported files with a client error, not "too large"', async () => {
  const response = await worker.fetch(request('/api/match', { method: 'POST', body: selfieForm(true, 'text/html') }), {}, {});
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /JPG, PNG or WebP/);
});
test('unpublished sessions do not invoke face processing', async () => {
  const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } };
  const response = await worker.fetch(request('/api/match', { method: 'POST', body: selfieForm(true) }), env, {});
  assert.equal(response.status, 404);
});
test('oversized requests are rejected before parsing', async () => {
  const response = await worker.fetch(request('/api/match', { method: 'POST', headers: { 'content-length': String(12 * 1024 * 1024) } }), {}, {});
  assert.equal(response.status, 413);
});

test('CORS does not reflect an unapproved origin', async () => {
  const result = await worker.fetch(request('/api/sessions', { method: 'OPTIONS', headers: { Origin: 'https://unapproved.example' } }), { ALLOWED_ORIGIN: 'https://site.example' }, {});
  assert.equal(result.headers.get('access-control-allow-origin'), null);
});
test('malformed JSON produces a useful client error', async () => {
  const result = await worker.fetch(request('/api/admin/login', { method: 'POST', body: '{' }), {}, {});
  assert.equal(result.status, 400);
});
test('non-string passwords cannot crash login', async () => {
  const result = await worker.fetch(request('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: { length: 6 } }) }), { ADMIN_PASSWORD: 'secret' }, {});
  assert.equal(result.status, 401);
});
test('streaming uploads cannot bypass the size limit by omitting content-length', async () => {
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(12 * 1024 * 1024)); controller.close(); } });
  const result = await worker.fetch(request('/api/match', { method: 'POST', body: stream, duplex: 'half' }), {}, {});
  assert.equal(result.status, 413);
});
const secrets = { ADMIN_PASSWORD: 'local-test-password', SESSION_SECRET: 'local-test-signing-key-never-used-in-production' };
async function login() {
  const result = await worker.fetch(request('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: secrets.ADMIN_PASSWORD }) }), secrets, {});
  assert.equal(result.status, 200); return (await result.json()).token;
}
// Tokens from login() have no admin_sessions row (that env has no DB). This wrapper answers the
// per-request session lookup (migration 0011) with a live row so route mocks stay focused on the route.
const liveSession = () => ({ revoked_at: null, expires_at: '2999-01-01T00:00:00.000Z', last_seen_at: new Date().toISOString() });
function adminAware(db) {
  return { ...db, prepare(sql) {
    if (sql.includes('admin_sessions')) return { bind() { return this; }, async first() { return liveSession(); }, async run() { return { meta: { changes: 1 } }; } };
    return db.prepare(sql);
  } };
}
// Signs a payload exactly as the Worker does, for tokens the login route would never issue.
const signed = (payload, secret = secrets.SESSION_SECRET) => { const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url'); return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('hex')}`; };
test('admin session creation rejects impossible dates and invalid values before DB access', async () => {
  const token = await login();
  for (const fields of [{ date: '2026-02-30' }, { title: '   ' }, { location: 42 }, { pricePaise: -1 }]) {
    const result = await worker.fetch(request('/api/admin/sessions', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ title: 'Morning', location: 'Mulki', date: '2026-09-15', pricePaise: 29900, ...fields }) }), secrets, {});
    assert.equal(result.status, 400);
  }
});
test('admin edits reject unknown statuses and missing sessions', async () => {
  const token = await login();
  const send = body => request('/api/admin/sessions/missing', { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  assert.equal((await worker.fetch(send({ status: 'anything' }), secrets, {})).status, 400);
  const env = { ...secrets, DB: adminAware({ prepare: () => ({ bind: () => ({ first: async () => null }) }) }) };
  assert.equal((await worker.fetch(send({ title: 'Morning' }), env, {})).status, 404);
});
// ── Revocable crew tokens (migration 0011) ───────────────────────────────────
test('tampered or legacy admin tokens are refused before any database access', async () => {
  const token = await login();
  const touched = [];
  const env = { ...secrets, DB: { prepare(sql) { touched.push(sql); throw new Error('the database must not be consulted'); } } };
  // A signature-valid token without a session id, as the Worker issued before migration 0011.
  const legacy = signed({ role: 'admin', exp: Date.now() + 60_000 });
  for (const invalid of [`${token}.extra`, `${token.slice(0, -1)}x`, legacy, signed({ role: 'guest', sid: 'x', exp: Date.now() + 60_000 })]) {
    const result = await worker.fetch(request('/api/admin/dashboard', { headers: { Authorization: `Bearer ${invalid}` } }), env, {});
    assert.equal(result.status, 401);
  }
  assert.deepEqual(touched, []);
});
// A D1 double for admin_sessions: rows live in a Map so revocation and expiry are observable.
function adminSessionsEnv({ table = true } = {}) {
  const rows = new Map(); const writes = [];
  const env = { ...secrets, DB: { prepare(sql) { return { values: [], bind(...values) { this.values = values; return this; },
    async first() {
      if (sql.includes('FROM login_attempts')) return null;
      if (!table) throw new Error('no such table: admin_sessions');
      if (sql.includes('FROM admin_sessions')) return rows.get(this.values[0]) || null;
      throw new Error(`Unexpected query: ${sql}`);
    },
    async all() { if (sql.includes('FROM sessions s')) return { results: [] }; throw new Error(`Unexpected query: ${sql}`); },
    async run() {
      if (sql.includes('login_attempts')) return {};
      if (!table) throw new Error('no such table: admin_sessions');
      writes.push(sql);
      if (sql.includes('INSERT INTO admin_sessions')) rows.set(this.values[0], { expires_at: this.values[1], ip: this.values[2], user_agent: this.values[3], revoked_at: null, last_seen_at: null });
      if (sql.includes('SET revoked_at')) { const row = rows.get(this.values[1]); if (row) row.revoked_at = this.values[0]; }
      if (sql.includes('SET last_seen_at')) { const row = rows.get(this.values[1]); if (row) row.last_seen_at = this.values[0]; }
      return { meta: { changes: 1 } };
    },
  }; } } };
  const signIn = (headers = {}) => worker.fetch(request('/api/admin/login', { method: 'POST', headers, body: JSON.stringify({ password: secrets.ADMIN_PASSWORD }) }), env, {});
  const dashboard = token => worker.fetch(request('/api/admin/dashboard', { headers: { Authorization: `Bearer ${token}` } }), env, {});
  const logout = token => worker.fetch(request('/api/admin/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }), env, {});
  return { env, rows, writes, signIn, dashboard, logout };
}
test('sign-out revokes the crew token server-side, and an expired session row refuses a still-signed token', async () => {
  const { rows, writes, signIn, dashboard, logout } = adminSessionsEnv();
  const token = (await (await signIn({ 'cf-connecting-ip': '203.0.113.4', 'user-agent': 'CrewPhone/1.0' })).json()).token;
  assert.equal(rows.size, 1);
  const [row] = rows.values();
  assert.equal(row.ip, '203.0.113.4'); assert.equal(row.user_agent, 'CrewPhone/1.0');
  assert.ok(Date.parse(row.expires_at) - Date.now() > 7.9 * 3600_000, 'token lifetime stays at eight hours');
  assert.equal((await dashboard(token)).status, 200);
  assert.equal((await dashboard(token)).status, 200);
  assert.equal(writes.filter(sql => sql.includes('SET last_seen_at')).length, 1, 'last_seen_at is touched once, not per request');
  const signedOut = await logout(token);
  assert.equal(signedOut.status, 200); assert.deepEqual(await signedOut.json(), { ok: true });
  assert.ok(row.revoked_at);
  assert.equal((await dashboard(token)).status, 401);
  assert.equal((await logout(token)).status, 401);
  const fresh = (await (await signIn()).json()).token;
  assert.equal((await dashboard(fresh)).status, 200);
  for (const candidate of rows.values()) if (!candidate.revoked_at) candidate.expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal((await dashboard(fresh)).status, 401);
});
test('without the admin_sessions table the crew can still sign in, work and sign out, with a warning in the logs', async context => {
  const warn = context.mock.method(console, 'warn', () => {});
  const { signIn, dashboard, logout } = adminSessionsEnv({ table: false });
  const token = (await (await signIn()).json()).token;
  assert.ok(token);
  assert.equal((await dashboard(token)).status, 200);
  assert.equal((await logout(token)).status, 200);
  assert.ok(warn.mock.callCount() >= 3);
  assert.ok(warn.mock.calls.every(call => String(call.arguments[0]).includes('migration 0011')));
  // Signature checks still apply in fallback mode.
  assert.equal((await dashboard(`${token.slice(0, -1)}x`)).status, 401);
});
test('a D1 failure that is not a missing table refuses a signed crew token instead of accepting it', async context => {
  const warn = context.mock.method(console, 'warn', () => {}); const logged = context.mock.method(console, 'error', () => {});
  const { env, signIn, dashboard } = adminSessionsEnv();
  const token = (await (await signIn()).json()).token;
  assert.equal((await dashboard(token)).status, 200);
  // The session lookup starts failing for any other reason (an outage, a locked database): fail closed.
  const { prepare } = env.DB;
  env.DB.prepare = sql => { if (sql.includes('FROM admin_sessions')) return { bind() { return this; }, async first() { throw new Error('D1_ERROR: database is locked'); } }; return prepare(sql); };
  assert.equal((await dashboard(token)).status, 401);
  assert.equal(warn.mock.callCount(), 0, 'not the unmigrated warning');
  assert.ok(logged.mock.calls.some(call => String(call.arguments[0]).includes('refusing the crew token')));
  env.DB.prepare = prepare;
  assert.equal((await dashboard(token)).status, 200, 'the same token works again once the database answers');
});
// `events` collects funnel rows (migration 0013) as [id, kind, session_id, search_id]; `dimensions`
// pretends photos.width/height exist (migration 0012) and answers the per-match detail lookup.
function matchingEnv({ rateLimits = 'ok', quota = new Map(), events: eventsTable = 'ok', dimensions = false } = {}) {
  const searches = []; const mediaReads = []; const events = [];
  const env = { ...secrets, FACE_API_URL: 'https://face.example/extract', MATCH_THRESHOLD: '0.62',
    DB: { prepare(sql) { return { values: [], bind(...values) { this.values = values; return this; },
      async first() {
        if (sql.includes("FROM sessions WHERE id")) return { id: 'session-1', title: 'Morning surf', session_date: '2026-09-15', location: 'Mulki', price_paise: 29900, currency: 'INR' };
        if (sql.includes('COUNT(*) as total')) return { total: 3, completed: 3, pending: 0 };
        if (sql.includes('object_key, preview_key')) return { object_key: 'original/private.jpg', preview_key: 'preview/watermark.jpg', content_type: 'image/jpeg' };
        // The quota upsert (migration 0010): count within a window that never rolls over during a test.
        if (sql.includes('INSERT INTO rate_limits')) {
          if (rateLimits === 'missing') throw new Error('no such table: rate_limits');
          if (rateLimits === 'broken') throw new Error('D1_ERROR: internal error');
          const count = (quota.get(this.values[0]) || 0) + 1; quota.set(this.values[0], count);
          return { count, elapsed: 0 };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      async all() {
        if (sql.startsWith('PRAGMA')) return { results: dimensions ? [{ name: 'id' }, { name: 'width' }, { name: 'height' }] : [{ name: 'id' }] };
        if (sql.includes('SELECT id, width, height FROM photos')) return { results: [{ id: 'photo-1', width: 4000, height: 6000 }] };
        return { results: [{ photo_id: 'photo-1', embedding_json: '[1,0]' }, { photo_id: 'photo-1', embedding_json: '[0.9,0.1]' }, { photo_id: 'photo-2', embedding_json: '[0,1]' }] };
      },
      async run() {
        if (sql.includes('DELETE FROM rate_limits')) return {};
        if (sql.includes('INSERT INTO events')) { if (eventsTable === 'missing') throw new Error('no such table: events'); events.push(this.values); return {}; }
        assert.match(sql, /INSERT INTO searches/); searches.push(this.values); return {};
      },
    }; }, async batch(statements) { return Promise.all(statements.map(statement => statement.run())); } },
    PHOTOS: { async get(key) { mediaReads.push(key); return { body: 'watermarked image bytes', httpMetadata: { contentType: 'image/jpeg' } }; } }
  };
  return { env, searches, mediaReads, quota, events };
}
test('matching returns deduplicated signed previews, persists IDs only, and protects originals', async context => {
  const { env, searches, mediaReads } = matchingEnv();
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, env.FACE_API_URL); assert.equal(options.body.get('file').name, 'image.jpg');
    return Response.json({ faces: [{ embedding: [1, 0] }] });
  });
  const result = await worker.fetch(request('/api/match', { method: 'POST', body: selfieForm(true) }), env, {});
  assert.equal(result.status, 200);
  const match = await result.json();
  assert.equal(match.count, 1); assert.equal(match.previews[0].photoId, 'photo-1');
  assert.equal(searches.length, 1); assert.equal(searches[0][2], '["photo-1"]');
  assert.equal(searches[0].some(value => String(value).includes('embedding')), false);
  const preview = await worker.fetch(new Request(match.previews[0].url), env, {});
  assert.equal(preview.status, 200); assert.equal(await preview.text(), 'watermarked image bytes');
  assert.deepEqual(mediaReads, ['preview/watermark.jpg']);
  const originalUrl = new URL(match.previews[0].url); originalUrl.searchParams.set('variant', 'original');
  assert.equal((await worker.fetch(new Request(originalUrl), env, {})).status, 401);
  assert.equal(mediaReads.length, 1);
});
test('multiple faces produce a retryable error without creating a search', async context => {
  const { env, searches } = matchingEnv();
  context.mock.method(globalThis, 'fetch', async () => Response.json({ faces: [{ embedding: [1, 0] }, { embedding: [0, 1] }] }));
  const result = await worker.fetch(request('/api/match', { method: 'POST', body: selfieForm(true) }), env, {});
  assert.equal(result.status, 400); assert.match((await result.json()).error, /only one/); assert.equal(searches.length, 0);
});
test('malformed face-service data produces service-unavailable, without storing a search', async context => {
  const { env, searches } = matchingEnv();
  context.mock.method(globalThis, 'fetch', async () => Response.json({ unexpected: true }));
  const result = await worker.fetch(request('/api/match', { method: 'POST', body: selfieForm(true) }), env, {});
  assert.equal(result.status, 503); assert.equal(searches.length, 0);
});
// ── Per-IP search quota (migration 0010) ─────────────────────────────────────
test('guest searches are capped per IP: the ninth in ten minutes is refused with retry-after, other IPs are not', async context => {
  const { env, searches, quota } = matchingEnv();
  const face = context.mock.method(globalThis, 'fetch', async () => Response.json({ faces: [{ embedding: [1, 0] }] }));
  const search = ip => worker.fetch(request('/api/match', { method: 'POST', headers: { 'cf-connecting-ip': ip }, body: selfieForm(true) }), env, {});
  for (let i = 0; i < 8; i += 1) assert.equal((await search('203.0.113.7')).status, 200);
  const blocked = await search('203.0.113.7');
  assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('retry-after'), '600');
  assert.equal(blocked.headers.get('cache-control'), 'no-store');
  assert.match((await blocked.json()).error, /You've searched a lot in a short while\. Try again in 10 minutes\./);
  // The refused search neither reached the face service nor created a search record, and only the
  // window that refused it counted it: the daily cap is not charged while the short one blocks.
  assert.equal(face.mock.callCount(), 8); assert.equal(searches.length, 8);
  assert.equal(quota.get('match:10m:203.0.113.7'), 9); assert.equal(quota.get('match:1d:203.0.113.7'), 8);
  for (let i = 0; i < 5; i += 1) assert.equal((await search('203.0.113.7')).status, 429);
  assert.equal(quota.get('match:1d:203.0.113.7'), 8, 'retrying against a ten-minute 429 never burns the daily cap');
  assert.equal((await search('203.0.113.8')).status, 200);
});
// ── Quota keys: IPv6 by /64, IPv4 whole ──────────────────────────────────────
test('the search quota keys an IPv6 guest on their /64 and an IPv4 guest on the whole address, and unparseable addresses share one bucket', async context => {
  const { env, quota } = matchingEnv();
  context.mock.method(globalThis, 'fetch', async () => Response.json({ faces: [{ embedding: [1, 0] }] }));
  const search = ip => worker.fetch(request('/api/match', { method: 'POST', headers: { 'cf-connecting-ip': ip }, body: selfieForm(true) }), env, {});
  // A phone rotating through its /64: eight searches from one address, the ninth from a sibling address is the ninth in the bucket.
  for (let i = 0; i < 8; i += 1) assert.equal((await search(`2001:db8:85a3:8d3:1319:8a2e:370:${(7000 + i).toString(16)}`)).status, 200);
  assert.equal((await search('2001:DB8:85A3:8D3::1')).status, 429, 'same /64, different address and casing: same counter');
  assert.equal(quota.get('match:10m:2001:0db8:85a3:08d3::/64'), 9);
  assert.equal((await search('2001:db8:85a3:8d4::1')).status, 200, 'the neighbouring /64 is another guest');
  assert.equal(quota.get('match:10m:2001:0db8:85a3:08d4::/64'), 1);
  assert.equal((await search('203.0.113.7')).status, 200); assert.equal(quota.get('match:10m:203.0.113.7'), 1, 'IPv4 is keyed whole');
  assert.equal((await search('::ffff:203.0.113.7')).status, 200); assert.equal(quota.get('match:10m:203.0.113.7'), 2, 'an IPv4-mapped address is its IPv4');
  for (const junk of ['not-an-ip', '1:2:3:4:5:6:7:8:9', '2001::db8::1', '12345::1', '', '999.1.1.1']) await search(junk);
  assert.equal(quota.get('match:10m:unknown'), 6, 'malformed addresses fall back to the shared unknown bucket');
  assert.equal([...quota.keys()].filter(key => key.startsWith('match:10m:')).length, 4, 'two /64s, one IPv4 and the unknown bucket: no other keys were created');
  // The pure helper, for the edge cases a request cannot easily carry.
  assert.equal(quotaKeyFor('::1'), '0000:0000:0000:0000::/64'); assert.equal(quotaKeyFor('fe80::1%eth0'), 'fe80:0000:0000:0000::/64'); assert.equal(quotaKeyFor('[2001:db8::1]'), '2001:0db8:0000:0000::/64');
  assert.equal(quotaKeyFor('1:2:3:4:5:6:7:8'), '0001:0002:0003:0004::/64'); assert.equal(quotaKeyFor('1:2:3:4:5:6:7'), 'unknown'); assert.equal(quotaKeyFor(null), 'unknown'); assert.equal(quotaKeyFor('unknown'), 'unknown');
});
// ── Quota checks that fail for a reason other than a missing table refuse, not lift, the cap ────
test('a rate_limits failure that is not a missing table refuses the search with a 503 and a short retry-after, and never reaches the face service', async context => {
  const error = context.mock.method(console, 'error', () => {});
  const { env, searches } = matchingEnv({ rateLimits: 'broken' });
  const face = context.mock.method(globalThis, 'fetch', async () => Response.json({ faces: [{ embedding: [1, 0] }] }));
  const result = await worker.fetch(request('/api/match', { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.5' }, body: selfieForm(true) }), env, {});
  assert.equal(result.status, 503); assert.equal(result.headers.get('retry-after'), '30'); assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.match((await result.json()).error, /briefly unavailable/);
  assert.equal(face.mock.callCount(), 0); assert.equal(searches.length, 0);
  assert.ok(error.mock.calls.some(call => String(call.arguments[0]).includes('rate limiter failed')));
});
test('the daily cap blocks even when the ten-minute window is free, keys on the first x-forwarded-for hop, and speaks in hours', async context => {
  const quota = new Map([['match:1d:203.0.113.9', 30]]);
  const { env } = matchingEnv({ quota });
  const face = context.mock.method(globalThis, 'fetch', async () => Response.json({ faces: [{ embedding: [1, 0] }] }));
  const blocked = await worker.fetch(request('/api/match', { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, body: selfieForm(true) }), env, {});
  assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('retry-after'), '86400');
  assert.match((await blocked.json()).error, /Try again in 24 hours\./);
  assert.equal(face.mock.callCount(), 0);
});
test('a malformed search never consumes quota, and a missing rate_limits table fails open with a warning', async context => {
  const { env, quota } = matchingEnv();
  const face = context.mock.method(globalThis, 'fetch', async () => Response.json({ faces: [{ embedding: [1, 0] }] }));
  const attempt = body => worker.fetch(request('/api/match', { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.5' }, body }), env, {});
  assert.equal((await attempt(selfieForm(false))).status, 400);
  assert.equal((await attempt(selfieForm(true, 'text/html'))).status, 400);
  assert.equal(quota.size, 0); assert.equal(face.mock.callCount(), 0);
  const warn = context.mock.method(console, 'warn', () => {});
  const unmigrated = matchingEnv({ rateLimits: 'missing' });
  const result = await worker.fetch(request('/api/match', { method: 'POST', body: selfieForm(true) }), unmigrated.env, {});
  assert.equal(result.status, 200); assert.equal(unmigrated.searches.length, 1);
  assert.ok(warn.mock.calls.some(call => String(call.arguments[0]).includes('migration 0010')));
});
// ── Shared secret with the face service ──────────────────────────────────────
test('the face service receives x-face-key only when FACE_API_KEY is set, on matching and on the deep health ping', async context => {
  const seen = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => { seen.push(new Headers(options.headers || {}).get('x-face-key')); return Response.json({ faces: [{ embedding: [1, 0] }] }); });
  const open = matchingEnv();
  assert.equal((await worker.fetch(request('/api/match', { method: 'POST', body: selfieForm(true) }), open.env, {})).status, 200);
  const keyed = matchingEnv(); keyed.env.FACE_API_KEY = 'shared-secret';
  assert.equal((await worker.fetch(request('/api/match', { method: 'POST', body: selfieForm(true) }), keyed.env, {})).status, 200);
  assert.deepEqual(seen, [null, 'shared-secret']);
  seen.length = 0;
  await worker.fetch(request('/api/health?deep=1'), healthEnv().env, {});
  await worker.fetch(request('/api/health?deep=1'), healthEnv({ FACE_API_KEY: 'shared-secret' }).env, {});
  assert.deepEqual(seen, [null, 'shared-secret']);
});
test('browser-style mixed-case multipart boundaries preserve selfie fields', async () => {
  const boundary = '----WebKitFormBoundaryAaBbCc123';
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="sessionId"\r\n\r\nsession-1\r\n--${boundary}\r\nContent-Disposition: form-data; name="consent"\r\n\r\ntrue\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="selfie.jpg"\r\nContent-Type: image/jpeg\r\n\r\nimage bytes\r\n--${boundary}--\r\n`;
  let sessionLookup = false;
  const env = { DB: { prepare() { return { bind(id) { assert.equal(id, 'session-1'); return this; }, async first() { sessionLookup = true; return null; } }; } } };
  const result = await worker.fetch(request('/api/match', { method: 'POST', body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }), env, {});
  assert.equal(sessionLookup, true); assert.equal(result.status, 404);
});
async function getMatch(context) {
  const { env } = matchingEnv();
  context.mock.method(globalThis, 'fetch', async () => Response.json({ faces: [{ embedding: [1, 0] }] }));
  const result = await worker.fetch(request('/api/match', { method: 'POST', body: selfieForm(true) }), env, {});
  return result.json();
}
test('checkout rejects an invalid phone number before touching the database or Cashfree', async context => {
  const match = await getMatch(context);
  const env = { ...secrets, DB: { prepare: () => { throw new Error('DB should not be queried'); } } };
  const result = await worker.fetch(jsonRequest('/api/checkout', { searchId: match.searchId, token: match.token, phone: '12345' }), env, {});
  assert.equal(result.status, 400); assert.match((await result.json()).error, /mobile/);
});
function checkoutDb(match, extra = {}) {
  return { prepare(sql) { return { values: [], bind(...values) { this.values = values; return this; },
    async first() {
      if (sql.includes('FROM searches WHERE id')) return { id: match.searchId, session_id: 'session-1', price_paise: 29900, currency: 'INR', status: 'preview' };
      if (extra.first) return extra.first(sql);
      throw new Error(`Unexpected query: ${sql}`);
    },
    async run() { if (extra.run) extra.run(sql, this.values); return { meta: { changes: 1 } }; },
  }; }, async batch(statements) { return Promise.all(statements.map(statement => statement.run())); } };
}
test('checkout requires Cashfree credentials before creating an order', async context => {
  const match = await getMatch(context);
  const env = { ...secrets, DB: checkoutDb(match) };
  const result = await worker.fetch(jsonRequest('/api/checkout', { searchId: match.searchId, token: match.token, phone: '9876543210' }), env, {});
  assert.equal(result.status, 503);
});
test('checkout creates a Cashfree order in rupees, records the payment and a checkout event', async context => {
  const match = await getMatch(context);
  const inserts = []; const events = [];
  const env = { ...secrets, CASHFREE_APP_ID: 'test-app', CASHFREE_SECRET_KEY: 'test-secret', ALLOWED_ORIGIN: 'https://site.example',
    DB: checkoutDb(match, { run: (sql, values) => { if (sql.includes('INSERT INTO events')) { events.push(values); return; } assert.match(sql, /INSERT INTO payments/); inserts.push(values); } }) };
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(String(url), /\/pg\/orders$/);
    const body = JSON.parse(options.body);
    assert.equal(body.order_amount, 299);
    assert.equal(body.order_currency, 'INR');
    assert.equal(body.customer_details.customer_phone, '9876543210');
    return Response.json({ order_id: 'mj-test-order', payment_session_id: 'session_abc123' });
  });
  const result = await worker.fetch(jsonRequest('/api/checkout', { searchId: match.searchId, token: match.token, phone: '9876543210' }), env, {});
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.orderId, 'mj-test-order'); assert.equal(body.paymentSessionId, 'session_abc123'); assert.equal(body.mode, 'sandbox');
  assert.equal(inserts.length, 1); assert.equal(inserts[0][2], 'mj-test-order');
  assert.deepEqual(events.map(row => row.slice(1)), [['checkout', 'session-1', match.searchId]]);
  assert.equal(JSON.stringify(events).includes('9876543210'), false, 'the phone number never reaches the events table');
});
test('payment verification confirms order status with Cashfree before unlocking', async context => {
  const match = await getMatch(context);
  const env = {
    ...secrets, CASHFREE_APP_ID: 'test-app', CASHFREE_SECRET_KEY: 'test-secret',
    DB: { prepare(sql) {
      return {
        bind() { return this; },
        async first() {
          if (sql.includes('FROM payments WHERE cashfree_order_id')) return { id: 'payment-1', status: 'created' };
          throw new Error(`Unexpected query: ${sql}`);
        },
      };
    } },
  };
  context.mock.method(globalThis, 'fetch', async () => Response.json({ order_status: 'ACTIVE' }));
  const result = await worker.fetch(jsonRequest('/api/payment/verify', { searchId: match.searchId, token: match.token, orderId: 'mj-test-order' }), env, {});
  assert.equal(result.status, 402);
});
test('webhook rejects an invalid signature without touching the database', async () => {
  const env = { CASHFREE_SECRET_KEY: 'test-secret', DB: { prepare: () => { throw new Error('DB should not be queried'); } } };
  const result = await worker.fetch(request('/api/payment/webhook', { method: 'POST', headers: { 'x-webhook-signature': 'bad', 'x-webhook-timestamp': '123' }, body: '{}' }), env, {});
  assert.equal(result.status, 401);
});
// ── Cashfree webhook: signature, freshness window, payment_status ────────────
// One payment row whose status follows the Worker's guarded UPDATEs, so "captured once" is observable;
// `events` collects funnel rows as [id, kind, session_id, search_id].
function webhookEnv({ status = 'created' } = {}) {
  const updates = []; const events = []; const payment = { status, cashfree_payment_id: null, search_id: 'search-1', session_id: 'session-1' };
  const env = { CASHFREE_SECRET_KEY: 'test-secret', DB: { prepare(sql) { return { bind(...values) { this.values = values; return this; },
    async run() {
      updates.push(sql);
      if (sql.includes('INSERT INTO events')) { events.push(this.values); return {}; }
      if (sql.includes("status = 'captured'")) {
        const eligible = sql.includes("NOT IN ('verified', 'captured')") ? !['verified', 'captured'].includes(payment.status) : sql.includes("status = 'verified'") ? payment.status === 'verified' : true;
        if (!eligible) return { meta: { changes: 0 } };
        payment.status = 'captured'; payment.cashfree_payment_id = this.values[0] ?? payment.cashfree_payment_id; return { meta: { changes: 1 } };
      }
      return { meta: { changes: 1 } };
    },
    async first() { if (sql.includes('FROM payments p JOIN searches sr')) return { search_id: payment.search_id, session_id: payment.session_id }; throw new Error(`Unexpected query: ${sql}`); },
  }; }, async batch(statements) { const results = []; for (const statement of statements) results.push(await statement.run()); return results; } } };
  return { env, updates, events, payment };
}
const successEvent = (payment = {}) => JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: 'mj-test-order' }, payment: { cf_payment_id: 555, ...payment } } });
// Signs `${timestamp}${rawBody}` with the merchant secret, exactly as Cashfree does.
const deliver = (env, payload, timestamp, secret = 'test-secret') => worker.fetch(request('/api/payment/webhook', { method: 'POST', headers: { 'x-webhook-signature': createHmac('sha256', secret).update(`${timestamp}${payload}`).digest('base64'), 'x-webhook-timestamp': timestamp }, body: payload }), env, {});
test('a validly signed, fresh webhook marks the payment captured and the search paid, whether the timestamp is epoch seconds or milliseconds', async () => {
  for (const timestamp of [String(Date.now()), String(Math.floor(Date.now() / 1000)), String(Date.now() - 4 * 60_000)]) {
    const { env, updates, payment } = webhookEnv();
    const result = await deliver(env, successEvent({ payment_status: 'SUCCESS' }), timestamp);
    assert.equal(result.status, 200, timestamp); assert.equal((await result.json()).received, true);
    assert.equal(updates.some(sql => sql.includes('UPDATE payments')), true);
    assert.equal(payment.status, 'captured'); assert.equal(payment.cashfree_payment_id, '555');
    assert.equal(updates.some(sql => sql.includes("UPDATE searches SET status = 'paid'") && sql.includes("status != 'paid'")), true, 'idempotent: an already-paid search is left alone');
  }
});
// ── Funnel events (migration 0013): `paid` exactly once per payment ──────────
test('the webhook records one paid event on the capture transition — never on a replay, nor after verify already unlocked', async () => {
  const fresh = webhookEnv();
  await deliver(fresh.env, successEvent({ payment_status: 'SUCCESS' }), String(Date.now()));
  assert.deepEqual(fresh.events.map(row => row.slice(1)), [['paid', 'session-1', 'search-1']]);
  await deliver(fresh.env, successEvent({ payment_status: 'SUCCESS' }), String(Date.now()));   // Cashfree retries the same delivery
  assert.equal(fresh.events.length, 1, 'a replayed delivery counts no second unlock');
  assert.equal(fresh.payment.status, 'captured');
  // The guest's verify call got there first: the row is upgraded to captured, the id is stored, no event.
  const verified = webhookEnv({ status: 'verified' });
  await deliver(verified.env, successEvent({ payment_status: 'SUCCESS' }), String(Date.now()));
  assert.deepEqual(verified.events, []); assert.equal(verified.payment.status, 'captured'); assert.equal(verified.payment.cashfree_payment_id, '555');
});
// A payments row whose status the verify route's guarded UPDATE flips, mirroring D1's `changes`.
function verifyEnv(match, { status = 'created' } = {}) {
  const events = []; const payment = { id: 'payment-1', status }; const batches = [];
  const env = { ...secrets, CASHFREE_APP_ID: 'test-app', CASHFREE_SECRET_KEY: 'test-secret',
    DB: { prepare(sql) { return { values: [], bind(...values) { this.values = values; return this; },
      async first() {
        if (sql.includes('FROM payments WHERE cashfree_order_id')) return { ...payment };
        if (sql.includes('FROM searches WHERE id')) return { id: match.searchId, session_id: 'session-1', matched_photo_ids_json: '[]', status: 'paid' };
        throw new Error(`Unexpected query: ${sql}`);
      },
      async run() {
        if (sql.includes('INSERT INTO events')) { events.push(this.values); return {}; }
        if (sql.includes("SET status = 'verified'")) { assert.match(sql, /status NOT IN \('verified', 'captured'\)/); if (['verified', 'captured'].includes(payment.status)) return { meta: { changes: 0 } }; payment.status = 'verified'; return { meta: { changes: 1 } }; }
        return { meta: { changes: 1 } };
      },
    }; }, async batch(statements) { batches.push(statements.length); const results = []; for (const statement of statements) results.push(await statement.run()); return results; } } };
  return { env, events, payment, batches };
}
test('verify records one paid event when it is the call that confirms the payment, and none when the webhook already did', async context => {
  const match = await getMatch(context);
  context.mock.method(globalThis, 'fetch', async () => Response.json({ order_status: 'PAID' }));
  const verify = env => worker.fetch(jsonRequest('/api/payment/verify', { searchId: match.searchId, token: match.token, orderId: 'mj-test-order' }), env, {});
  const first = verifyEnv(match);
  assert.equal((await verify(first.env)).status, 200);
  assert.equal(first.payment.status, 'verified'); assert.deepEqual(first.events.map(row => row.slice(1)), [['paid', 'session-1', match.searchId]]);
  assert.equal((await verify(first.env)).status, 200, 'a second verify still unlocks');
  assert.equal(first.events.length, 1); assert.equal(first.batches.length, 1, 'an already-verified payment is not re-written');
  const captured = verifyEnv(match, { status: 'captured' });
  assert.equal((await verify(captured.env)).status, 200); assert.deepEqual(captured.events, []); assert.deepEqual(captured.batches, []);
});
test('a replayed webhook — valid signature but a stale, future or non-numeric timestamp — is refused before any database access', async () => {
  const sixMinutes = 6 * 60;
  for (const timestamp of [String(Date.now() - sixMinutes * 1000), String(Math.floor(Date.now() / 1000) + sixMinutes), '2026-09-17T10:00:00Z', '12abc', '']) {
    const { env, updates } = webhookEnv();
    const result = await deliver(env, successEvent({ payment_status: 'SUCCESS' }), timestamp);
    assert.equal(result.status, 401, `timestamp ${JSON.stringify(timestamp)}`); assert.deepEqual(updates, []);
  }
  // A fresh timestamp with the wrong secret is still a signature failure.
  const { env, updates } = webhookEnv();
  assert.equal((await deliver(env, successEvent(), String(Date.now()), 'other-secret')).status, 401); assert.deepEqual(updates, []);
});
test('a PAYMENT_SUCCESS_WEBHOOK still carrying a PENDING payment is acknowledged but unlocks nothing', async () => {
  const { env, updates } = webhookEnv();
  const result = await deliver(env, successEvent({ payment_status: 'PENDING' }), String(Date.now()));
  assert.equal(result.status, 200); assert.equal((await result.json()).received, true); assert.deepEqual(updates, []);
  const failed = await deliver(env, JSON.stringify({ type: 'PAYMENT_FAILED_WEBHOOK', data: { order: { order_id: 'mj-test-order' }, payment: { payment_status: 'FAILED' } } }), String(Date.now()));
  assert.equal(failed.status, 200); assert.deepEqual(updates, []);
});
// ── Webhook body bound: cheap checks before the body is read, 64 KB cap before the HMAC ─────
test('the webhook refuses missing headers and stale timestamps before reading the body, caps the body at 64 KB before signing it, and still accepts a large valid delivery', async context => {
  const hmac = context.mock.method(crypto.subtle, 'sign');
  const huge = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', pad: 'x'.repeat(70 * 1024) });
  const post = (body, headers) => worker.fetch(request('/api/payment/webhook', { method: 'POST', headers, body, duplex: 'half' }), webhookEnv().env, {});
  // Headers missing, or a stale timestamp: 401 without the body being read or HMACed, whatever its size.
  assert.equal((await post(huge, { 'x-webhook-timestamp': String(Date.now()) })).status, 401);
  assert.equal((await post(huge, { 'x-webhook-signature': 'sig' })).status, 401);
  const stale = await post(huge, { 'x-webhook-signature': 'sig', 'x-webhook-timestamp': String(Date.now() - 6 * 60_000) });
  assert.equal(stale.status, 401); assert.match((await stale.json()).error, /outside the accepted window/);
  assert.equal(hmac.mock.callCount(), 0, 'nothing was signed');
  // Fresh headers on an oversized body: 413 from the bounded read, still before any HMAC — with or without content-length.
  const oversized = await deliver(webhookEnv().env, huge, String(Date.now()));
  assert.equal(oversized.status, 413); assert.equal(hmac.mock.callCount(), 0);
  const streamed = await post(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(huge)); controller.close(); } }), { 'x-webhook-signature': 'sig', 'x-webhook-timestamp': String(Date.now()) });
  assert.equal(streamed.status, 413); assert.equal(hmac.mock.callCount(), 0);
  // A wrong signature on a fresh, small body is signed once and refused; a valid delivery just under the cap is processed as before.
  assert.equal((await post('{}', { 'x-webhook-signature': 'sig', 'x-webhook-timestamp': String(Date.now()) })).status, 401);
  assert.equal(hmac.mock.callCount(), 1);
  const large = webhookEnv();
  const result = await deliver(large.env, JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', pad: 'x'.repeat(60 * 1024), data: { order: { order_id: 'mj-test-order' }, payment: { cf_payment_id: 555, payment_status: 'SUCCESS' } } }), String(Date.now()));
  assert.equal(result.status, 200); assert.equal(large.payment.status, 'captured');
});
// ── Upload more: duplicate handling ──────────────────────────────────────────
function photoUpload(token, sessionId, name, onDuplicate) {
  const form = new FormData();
  form.append('file', new Blob(['original'], { type: 'image/jpeg' }), name);
  form.append('preview', new Blob(['preview'], { type: 'image/jpeg' }), 'preview.jpg');
  if (onDuplicate) form.append('onDuplicate', onDuplicate);
  return request(`/api/admin/sessions/${sessionId}/photos`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
}
// Simulates a session that already holds IMG_0412.jpg (and, optionally, its -2 copy).
// `dimensions` pretends migration 0012 is applied (photos.width/height exist); `insertSql` keeps each INSERT's text.
function uploadEnv({ status = 'published', existing = [{ id: 'photo-old', filename: 'IMG_0412.jpg', object_key: 'original/old', preview_key: 'preview/old' }], dimensions = false } = {}) {
  const puts = []; const deletes = []; const inserts = []; const deletedRows = []; const queued = []; const insertSql = [];
  const statement = sql => ({ values: [], bind(...values) { this.values = values; return this; },
    async first() {
      if (sql.includes('FROM sessions WHERE id')) return { id: 'session-1', status };
      throw new Error(`Unexpected query: ${sql}`);
    },
    async all() {
      if (sql.startsWith('PRAGMA')) return { results: dimensions ? [{ name: 'id' }, { name: 'width' }, { name: 'height' }] : [{ name: 'id' }] };
      if (sql.includes('COLLATE NOCASE')) return { results: existing.filter(photo => photo.filename.toLowerCase() === String(this.values[1]).toLowerCase()) };
      if (sql.includes('SELECT filename FROM photos')) return { results: existing.map(photo => ({ filename: photo.filename })) };
      throw new Error(`Unexpected query: ${sql}`);
    },
    async run() {
      if (sql.includes('INSERT INTO photos')) { inserts.push(this.values); insertSql.push(sql); }
      if (sql.includes('DELETE FROM')) deletedRows.push(sql);
      return { meta: { changes: 1 } };
    },
    sql,
  });
  const env = { ...secrets, INDEX_QUEUE: { async send(message) { queued.push(message); } },
    DB: adminAware({ prepare: statement, async batch(statements) { statements.forEach(item => deletedRows.push(item.sql)); return []; } }),
    // Like R2, put() drains a streamed value (the upload pump only finishes once its reader does).
    PHOTOS: { async put(key, value) { puts.push(key); if (value instanceof ReadableStream) await new Response(value).arrayBuffer(); }, async delete(key) { deletes.push(key); } } };
  return { env, puts, deletes, inserts, deletedRows, queued, insertSql };
}
test('photos can be added to a published session but not an archived one', async () => {
  const token = await login();
  const open = uploadEnv({ status: 'published', existing: [] });
  const added = await worker.fetch(photoUpload(token, 'session-1', 'IMG_0500.jpg'), open.env, {});
  assert.equal(added.status, 201); assert.equal(open.inserts.length, 1); assert.equal(open.queued.length, 1);
  const archived = uploadEnv({ status: 'archived' });
  const refused = await worker.fetch(photoUpload(token, 'session-1', 'IMG_0500.jpg'), archived.env, {});
  assert.equal(refused.status, 409); assert.equal(archived.puts.length, 0);
});
test('uploads reject unknown duplicate modes before storing anything', async () => {
  const token = await login();
  const { env, puts } = uploadEnv();
  const result = await worker.fetch(photoUpload(token, 'session-1', 'IMG_0412.jpg', 'overwrite'), env, {});
  assert.equal(result.status, 400); assert.equal(puts.length, 0);
});
test('skip mode leaves the existing photo untouched and stores nothing', async () => {
  const token = await login();
  const { env, puts, inserts, queued } = uploadEnv();
  const result = await worker.fetch(photoUpload(token, 'session-1', 'img_0412.JPG', 'skip'), env, {});
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { skipped: true, filename: 'img_0412.JPG' });
  assert.equal(puts.length, 0); assert.equal(inserts.length, 0); assert.equal(queued.length, 0);
});
test('rename mode stores a numbered copy that avoids every name already in the session', async () => {
  const token = await login();
  const { env, inserts } = uploadEnv({ existing: [
    { id: 'photo-old', filename: 'IMG_0412.jpg', object_key: 'original/old', preview_key: 'preview/old' },
    { id: 'photo-copy', filename: 'img_0412-2.jpg', object_key: 'original/copy', preview_key: 'preview/copy' },
  ] });
  const result = await worker.fetch(photoUpload(token, 'session-1', 'IMG_0412.jpg', 'rename'), env, {});
  assert.equal(result.status, 201);
  const body = await result.json();
  assert.equal(body.filename, 'IMG_0412-3.jpg'); assert.equal(body.duplicate, 'renamed');
  assert.equal(inserts[0][4], 'IMG_0412-3.jpg');
});
test('replace mode stores the new photo, then removes the old rows and files', async () => {
  const token = await login();
  const { env, puts, deletes, inserts, deletedRows } = uploadEnv();
  const result = await worker.fetch(photoUpload(token, 'session-1', 'IMG_0412.jpg', 'replace'), env, {});
  assert.equal(result.status, 201);
  const body = await result.json();
  assert.equal(body.duplicate, 'replaced'); assert.equal(body.replaced, 1); assert.equal(body.filename, 'IMG_0412.jpg');
  assert.equal(inserts.length, 1); assert.equal(puts.length, 2);
  assert.deepEqual(deletes.sort(), ['original/old', 'preview/old']);
  assert.equal(deletedRows.some(sql => sql.includes('DELETE FROM faces')), true);
  assert.equal(deletedRows.some(sql => sql.includes('DELETE FROM photos')), true);
});
test('uploads without a duplicate mode keep the previous behaviour', async () => {
  const token = await login();
  const { env, inserts, deletes } = uploadEnv();
  const result = await worker.fetch(photoUpload(token, 'session-1', 'IMG_0412.jpg'), env, {});
  assert.equal(result.status, 201); assert.equal((await result.json()).duplicate, null);
  assert.equal(inserts.length, 1); assert.equal(deletes.length, 0);
});
// ── Streaming upload (framed body: [uint32 preview length LE][preview][original]) ──
// FixedLengthStream is a Workers runtime global; shim it for Node as a pass-through.
globalThis.FixedLengthStream ??= class { constructor() { const s = new TransformStream(); this.writable = s.writable; this.readable = s.readable; } };
function framedBody(preview, original) {
  const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, preview.length, true);
  return new Blob([len, preview, original]);
}
const JPEG = extra => new Uint8Array([0xFF, 0xD8, ...extra]); // valid JPEG SOI prefix
test('streaming upload pipes the original to R2 and stores the buffered preview', async () => {
  const token = await login();
  const { env, puts, inserts, queued } = uploadEnv({ status: 'published', existing: [] });
  const stored = {};
  env.PHOTOS.put = async (key, value) => { puts.push(key); stored[key] = value instanceof ReadableStream ? new Uint8Array(await new Response(value).arrayBuffer()) : value; };
  const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const streamBody = framedBody(JPEG([9, 9, 9]), original);
  const req = request('/api/admin/sessions/session-1/photos?type=image%2Fjpeg&filename=DSC01237.JPG', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'content-length': String(streamBody.size) }, body: streamBody,
  });
  const result = await worker.fetch(req, env, {});
  assert.equal(result.status, 201);
  const body = await result.json();
  assert.equal(body.filename, 'DSC01237.JPG'); assert.equal(body.duplicate, null);
  assert.equal(inserts.length, 1); assert.equal(queued.length, 1); assert.equal(puts.length, 2);
  const originalKey = puts.find(k => k.includes('/original/'));
  assert.deepEqual([...stored[originalKey]], [1, 2, 3, 4, 5, 6, 7, 8]); // original streamed through intact
  const previewKey = puts.find(k => k.includes('/preview/'));
  assert.deepEqual([...stored[previewKey]], [0xFF, 0xD8, 9, 9, 9]); // preview buffered intact
});
test('streaming upload honours the skip duplicate mode without storing anything', async () => {
  const token = await login();
  const { env, puts, inserts } = uploadEnv(); // existing IMG_0412.jpg
  const skipBody = framedBody(JPEG([1]), new Uint8Array([1, 2, 3]));
  const req = request('/api/admin/sessions/session-1/photos?type=image%2Fjpeg&filename=IMG_0412.jpg&onDuplicate=skip', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'content-length': String(skipBody.size) }, body: skipBody,
  });
  const result = await worker.fetch(req, env, {});
  assert.equal(result.status, 200); assert.equal((await result.json()).skipped, true);
  assert.equal(puts.length, 0); assert.equal(inserts.length, 0);
});
test('streaming upload rejects a preview that is not a JPEG', async () => {
  const token = await login();
  const { env } = uploadEnv({ existing: [] });
  const badBody = framedBody(new Uint8Array([0x00, 0x01, 0x02]), new Uint8Array([9]));
  const req = request('/api/admin/sessions/session-1/photos?type=image%2Fjpeg&filename=x.jpg', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'content-length': String(badBody.size) }, body: badBody,
  });
  assert.equal((await worker.fetch(req, env, {})).status, 400);
});

// ── Signed-link refresh, downloads, thumbnails, throttling ───────────────────
// A tiny D1 double: `rows` answers queries by substring; `runs` records writes.
function galleryEnv({ paid = true, thumbColumn = false, dimensions = false } = {}) {
  const runs = []; const reads = [];
  const sized = photo => dimensions ? { ...photo, width: photo.id === 'photo-1' ? 6000 : null, height: photo.id === 'photo-1' ? 4000 : null } : photo;
  const search = { id: 'search-1', session_id: 'session-1', matched_photo_ids_json: '["photo-1","photo-2"]', status: paid ? 'paid' : 'preview', expires_at: '2999-01-01 00:00:00' };
  const statement = sql => ({ values: [], bind(...values) { this.values = values; return this; },
    async first() {
      if (sql.includes('FROM searches WHERE id')) return sql.includes("AND status = 'paid'") && !paid ? null : search; // /access needs paid; /previews accepts a live preview
      if (sql.includes('FROM sessions WHERE id')) return { title: 'Morning surf', date: '2026-09-15', location: 'Mulki' };
      if (sql.includes('object_key, preview_key')) return { session_id: 'session-1', object_key: 'original/1.jpg', preview_key: 'preview/1.jpg', content_type: 'image/jpeg', filename: 'IMG 0412.jpg', thumb_key: thumbColumn ? 'thumb/1.jpg' : undefined };
      if (sql.includes('SELECT id, session_id, thumb_key FROM photos')) return { id: 'photo-1', session_id: 'session-1', thumb_key: null };
      throw new Error(`Unexpected query: ${sql}`);
    },
    async all() {
      if (sql.startsWith('PRAGMA')) return { results: [{ name: 'id' }, ...(thumbColumn ? [{ name: 'thumb_key' }] : []), ...(dimensions ? [{ name: 'width' }, { name: 'height' }] : [])] };
      if (sql.includes('FROM photos WHERE session_id')) return { results: [sized({ id: 'photo-1', thumb_key: thumbColumn ? 'thumb/1.jpg' : undefined }), sized({ id: 'photo-2', thumb_key: null })] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    async run() { runs.push({ sql, values: this.values }); return { meta: { changes: 1 } }; },
  });
  const env = { ...secrets, DB: adminAware({ prepare: statement }), PHOTOS: { async get(key) { reads.push(key); return { body: `bytes of ${key}`, httpMetadata: { contentType: 'image/jpeg' } }; }, async put(key) { runs.push({ put: key }); } } };
  return { env, runs, reads };
}
test('a paid search can refresh its original links and receives a 30-day gallery token', async context => {
  const match = await getMatch(context);
  const { env, reads } = galleryEnv({ paid: true });
  const result = await worker.fetch(request(`/api/searches/${match.searchId}/access?token=${encodeURIComponent(match.token)}`), env, {});
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.photos.length, 2); assert.equal(body.session.title, 'Morning surf');
  assert.ok(body.galleryToken && body.galleryToken !== match.token);
  // The gallery token authorises the same search, and ?download=1 turns an original into an attachment.
  const again = await worker.fetch(request(`/api/searches/${match.searchId}/access?token=${encodeURIComponent(body.galleryToken)}`), env, {});
  assert.equal(again.status, 200);
  const download = await worker.fetch(new Request(body.photos[0].downloadUrl), env, {});
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-disposition'), 'attachment; filename="IMG-0412.jpg"');
  assert.deepEqual(reads, ['original/1.jpg']);
  const inline = await worker.fetch(new Request(body.photos[0].url), env, {});
  assert.equal(inline.headers.get('content-disposition'), null);
});
test('preview links can be refreshed while the search is valid, but originals stay locked', async context => {
  const match = await getMatch(context);
  const { env } = galleryEnv({ paid: false });
  const previews = await worker.fetch(request(`/api/searches/${match.searchId}/previews?token=${encodeURIComponent(match.token)}`), env, {});
  assert.equal(previews.status, 200);
  const body = await previews.json();
  assert.equal(body.photos.length, 2); assert.match(body.photos[0].url, /variant=preview/); assert.equal(body.photos[0].thumbUrl, body.photos[0].url);
  assert.equal((await worker.fetch(request(`/api/searches/${match.searchId}/access?token=${encodeURIComponent(match.token)}`), env, {})).status, 402);
  assert.equal((await worker.fetch(request(`/api/searches/${match.searchId}/previews?token=nope`), env, {})).status, 401);
});
test('thumbnails are served when the column exists and the upload route refuses an unmigrated database', async context => {
  const match = await getMatch(context);
  const token = await login();
  const withThumbs = galleryEnv({ paid: false, thumbColumn: true });
  const previews = await (await worker.fetch(request(`/api/searches/${match.searchId}/previews?token=${encodeURIComponent(match.token)}`), withThumbs.env, {})).json();
  assert.match(previews.photos[0].thumbUrl, /variant=thumb/); assert.match(previews.photos[1].thumbUrl, /variant=preview/);
  const thumb = await worker.fetch(new Request(previews.photos[0].thumbUrl), withThumbs.env, {});
  assert.equal(thumb.status, 200); assert.deepEqual(withThumbs.reads, ['thumb/1.jpg']);
  const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]);
  const stored = await worker.fetch(request('/api/admin/photos/photo-1/thumb', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'image/jpeg' }, body: jpeg }), withThumbs.env, {});
  assert.equal(stored.status, 201);
  assert.ok(withThumbs.runs.some(entry => entry.put === 'sessions/session-1/thumb/photo-1.jpg'));
  assert.ok(withThumbs.runs.some(entry => entry.sql?.includes('UPDATE photos SET thumb_key')));
  const notJpeg = await worker.fetch(request('/api/admin/photos/photo-1/thumb', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'image/jpeg' }, body: new Uint8Array([1, 2, 3]) }), withThumbs.env, {});
  assert.equal(notJpeg.status, 400);
  const withoutThumbs = galleryEnv({ paid: false, thumbColumn: false });
  const refused = await worker.fetch(request('/api/admin/photos/photo-1/thumb', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'image/jpeg' }, body: jpeg }), withoutThumbs.env, {});
  assert.equal(refused.status, 503); assert.equal(withoutThumbs.runs.length, 0);
});
test('re-index can be limited to failed photos', async () => {
  const token = await login();
  const seen = [];
  const env = { ...secrets, INDEX_QUEUE: { async send() {} }, DB: adminAware({ prepare(sql) { seen.push(sql); return { bind() { return this; }, async first() { return { id: 'session-1' }; }, async all() { return { results: [] }; }, async run() { return { meta: { changes: 1 } }; } }; } }) };
  const only = await worker.fetch(request('/api/admin/sessions/session-1/reindex?onlyFailed=1', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }), env, {});
  assert.equal(only.status, 202);
  assert.ok(seen.some(sql => sql.includes("indexing_status = 'failed'")));
  seen.length = 0;
  await worker.fetch(request('/api/admin/sessions/session-1/reindex', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }), env, {});
  assert.equal(seen.some(sql => sql.includes("indexing_status = 'failed'")), false);
});
test('crew sign-in is throttled per IP after repeated failures, and a success clears the counter', async context => {
  context.mock.method(console, 'warn', () => {}); // the no-table env below also lacks admin_sessions
  const table = new Map(); const writes = [];
  const env = { ...secrets, DB: { prepare(sql) { return { values: [], bind(...values) { this.values = values; return this; },
    async first() { if (sql.includes('FROM login_attempts')) { const row = table.get(this.values[0]); return row ? { count: row, window_start: new Date().toISOString().replace('T', ' ').slice(0, 19) } : null; } throw new Error(`Unexpected query: ${sql}`); },
    async run() { writes.push(sql); if (sql.includes('INSERT INTO login_attempts')) table.set(this.values[0], (table.get(this.values[0]) || 0) + 1); if (sql.includes('DELETE FROM login_attempts')) table.delete(this.values[0]); return {}; },
  }; } } };
  const attempt = password => worker.fetch(request('/api/admin/login', { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.9' }, body: JSON.stringify({ password }) }), env, {});
  for (let i = 0; i < 5; i += 1) assert.equal((await attempt('wrong')).status, 401);
  const blocked = await attempt(secrets.ADMIN_PASSWORD);
  assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('retry-after'), '900');
  table.clear();
  const ok = await attempt(secrets.ADMIN_PASSWORD);
  assert.equal(ok.status, 200); assert.ok(writes.some(sql => sql.includes('DELETE FROM login_attempts')));
  // A database without the table never locks the crew out.
  const noTable = { ...secrets, DB: { prepare() { return { bind() { return this; }, async first() { throw new Error('no such table: login_attempts'); }, async run() { throw new Error('no such table'); } }; } } };
  assert.equal((await worker.fetch(request('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: secrets.ADMIN_PASSWORD }) }), noTable, {})).status, 200);
});
test('landing-page covers are only ever the photo the crew explicitly chose, fetched with the list in a single join', async () => {
  const token = await login();
  const runs = []; const statements = [];
  const env = (hasCover, coverId) => ({ ...secrets, DB: adminAware({ prepare(sql) { statements.push(sql); return { values: [], bind(...values) { this.values = values; return this; },
    async all() {
      if (sql.startsWith('PRAGMA table_info(sessions)')) return { results: hasCover ? [{ name: 'id' }, { name: 'cover_photo_id' }] : [{ name: 'id' }] };
      if (sql.includes('FROM sessions s')) {
        assert.equal(sql.includes('LEFT JOIN photos p ON p.id = s.cover_photo_id AND p.session_id = s.id'), hasCover, 'the join only exists once migration 0009 is applied');
        const session = { title: 'Morning', session_date: '2026-09-15', location: 'Mulki', price_paise: 70000, currency: 'INR' };
        return { results: [{ id: 'session-1', ...session, cover_id: hasCover ? coverId : null }, { id: 'session-2', ...session, cover_id: null }, { id: 'session-3', ...session, cover_id: null }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async first() {
      if (sql.includes('FROM sessions WHERE id')) return { id: 'session-1' };
      if (sql.includes('FROM photos WHERE id = ? AND session_id')) return this.values[0] === 'photo-1' ? { id: 'photo-1' } : null;
      throw new Error(`Unexpected query: ${sql}`);
    },
    async run() { runs.push({ sql, values: this.values }); return { meta: { changes: 1 } }; },
  }; } }) });
  const list = async candidate => { statements.length = 0; return (await (await worker.fetch(request('/api/sessions'), candidate, {})).json()).sessions; };
  const queries = () => statements.filter(sql => !sql.startsWith('PRAGMA')).length;
  // No chosen cover (or no column yet) → no coverUrl, even though the session has photos.
  for (const candidate of [env(false, null), env(true, null)]) {
    const sessions = await list(candidate);
    assert.equal(sessions.length, 3); assert.ok(sessions.every(session => session.coverUrl === null)); assert.equal(queries(), 1);
  }
  const chosen = await list(env(true, 'photo-1'));
  // The cover is the clean, watermark-free original — not the watermarked preview/thumb guests get elsewhere.
  assert.match(chosen[0].coverUrl, /\/api\/media\/photo-1\?variant=original/); assert.equal(chosen[1].coverUrl, null);
  assert.equal(queries(), 1, 'three sessions, one statement: covers come from the join, not a lookup per session');
  assert.deepEqual(Object.keys(chosen[0]).sort(), ['conditions', 'coverUrl', 'currency', 'id', 'location', 'nextDropAt', 'price_paise', 'session_date', 'title'], 'the existing keys are untouched; conditions and nextDropAt are the wave-3 additions');
  assert.equal(chosen[0].conditions, null); assert.equal(chosen[0].nextDropAt, null);
  const put = (body, candidate) => worker.fetch(request('/api/admin/sessions/session-1', { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }), candidate, {});
  assert.equal((await put({ coverPhotoId: 'photo-1' }, env(false))).status, 503);
  assert.equal((await put({ coverPhotoId: 'photo-from-another-session' }, env(true))).status, 404);
  assert.equal((await put({ coverPhotoId: 'photo-1' }, env(true))).status, 200);
  assert.ok(runs.some(entry => entry.sql.includes('UPDATE sessions SET cover_photo_id') && entry.values[0] === 'photo-1'));
  assert.equal((await put({ coverPhotoId: null }, env(true))).status, 200);
});
const SUPPORT_TABLES = ['match_hides', 'notify_requests', 'refunds', 'grants'];
function healthEnv(overrides = {}, { tables = ['admin_sessions', 'rate_limits', 'events', ...SUPPORT_TABLES], photoColumns = ['id', 'width', 'height'], sessionColumns = ['id', 'break_name'], searchColumns = ['id', 'colour_photo_ids_json'] } = {}) {
  const calls = { sql: [], heads: [] };
  const env = { ALLOWED_ORIGIN: 'https://site.example', FACE_API_URL: 'https://face.example/extract',
    DB: { prepare(sql) { calls.sql.push(sql); return { async first() { return { 1: 1 }; }, async all() {
      if (sql.startsWith('PRAGMA table_info(photos)')) return { results: photoColumns.map(name => ({ name })) };
      if (sql.startsWith('PRAGMA table_info(sessions)')) return { results: sessionColumns.map(name => ({ name })) };
      if (sql.startsWith('PRAGMA table_info(searches)')) return { results: searchColumns.map(name => ({ name })) };
      assert.match(sql, /FROM sqlite_master/); return { results: tables.map(name => ({ name })) };
    } }; } },
    PHOTOS: { async head(key) { calls.heads.push(key); return null; } },
    ...overrides };
  return { env, calls };
}
test('health check is public, uncached, reports which migrations exist and only probes the face service on demand', async context => {
  const { env, calls } = healthEnv();
  const fetchMock = context.mock.method(globalThis, 'fetch', async () => { throw new Error('the face service must not be contacted without ?deep=1'); });
  const result = await worker.fetch(request('/api/health', { headers: { Origin: 'https://site.example' } }), env, {});
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('access-control-allow-origin'), 'https://site.example');
  const body = await result.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.checks, { db: 'ok', r2: 'ok', face: 'skipped' });
  assert.deepEqual(body.migrations, { adminSessions: true, rateLimits: true, photoDimensions: true, events: true, sessionConditions: true, support: true, crewAccounts: false });
  assert.equal(new Date(body.time).toISOString(), body.time);
  assert.deepEqual(calls.sql.sort(), ['PRAGMA table_info(photos)', 'PRAGMA table_info(searches)', 'PRAGMA table_info(sessions)', 'SELECT 1', "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('admin_sessions', 'rate_limits', 'events', 'match_hides', 'notify_requests', 'refunds', 'grants', 'crew_users', 'audit_log')"]); assert.deepEqual(calls.heads, ['__health-probe']);
  assert.equal(fetchMock.mock.callCount(), 0);
  // A half-migrated database is still healthy, and says which table is missing.
  const partial = await (await worker.fetch(request('/api/health'), healthEnv({}, { tables: ['rate_limits', 'match_hides', 'refunds'], photoColumns: ['id', 'thumb_key'], sessionColumns: ['id'], searchColumns: ['id'] }).env, {})).json();
  assert.equal(partial.ok, true); assert.deepEqual(partial.migrations, { adminSessions: false, rateLimits: true, photoDimensions: false, events: false, sessionConditions: false, support: false, crewAccounts: false }, 'support is only true once every 0015 table and the searches column exist');
});
test('health check reports a database failure without masking storage or leaking the error', async () => {
  const { env } = healthEnv({ DB: { prepare() { throw new Error('D1_ERROR: internal detail that must stay private'); } } });
  const result = await worker.fetch(request('/api/health'), env, {});
  assert.equal(result.status, 503);
  const body = await result.json();
  assert.equal(body.ok, false);
  assert.deepEqual(body.checks, { db: 'error', r2: 'ok', face: 'skipped' });
  assert.deepEqual(body.migrations, { adminSessions: false, rateLimits: false, photoDimensions: false, events: false, sessionConditions: false, support: false, crewAccounts: false });
  assert.equal(JSON.stringify(body).includes('D1_ERROR'), false);
  // A missing binding is reported as a failed check, never as a crashed request.
  const unbound = await worker.fetch(request('/api/health'), { PHOTOS: env.PHOTOS }, {});
  assert.equal(unbound.status, 503); assert.deepEqual((await unbound.json()).checks, { db: 'error', r2: 'ok', face: 'skipped' });
});
test('deep health check treats any face-service HTTP reply as reachable and a network failure as an error', async context => {
  const { env } = healthEnv();
  const fetchMock = context.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, env.FACE_API_URL); assert.equal(options.method, 'HEAD'); assert.ok(options.signal instanceof AbortSignal);
    return new Response(null, { status: 405 });
  });
  const reachable = await worker.fetch(request('/api/health?deep=1'), env, {});
  assert.equal(reachable.status, 200);
  assert.deepEqual((await reachable.json()).checks, { db: 'ok', r2: 'ok', face: 'ok' });
  assert.equal(fetchMock.mock.callCount(), 1);
  fetchMock.mock.mockImplementation(async () => { throw new TypeError('fetch failed'); });
  const unreachable = await worker.fetch(request('/api/health?deep=1'), env, {});
  assert.equal(unreachable.status, 503);
  assert.deepEqual((await unreachable.json()).checks, { db: 'ok', r2: 'ok', face: 'error' });
});

// ── Download all: one streamed ZIP of a paid search's originals ───────────────
function zipEnv({ paid = true, withHead = true, bodies = 'stream', filenames = ['IMG 0412.jpg', 'IMG 0413.jpg'] } = {}) {
  const reads = []; const heads = []; const events = [];
  const objects = { 'original/1.jpg': 'bytes of the first original', 'original/2.jpg': 'bytes of the second original, a bit longer' };
  const statement = sql => ({ values: [], bind(...values) { this.values = values; return this; },
    async first() {
      if (sql.includes('FROM searches WHERE id')) return paid ? { id: 'search-1', session_id: 'session-1', matched_photo_ids_json: '["photo-1","photo-2"]', status: 'paid', expires_at: '2999-01-01 00:00:00' } : null;
      if (sql.includes('FROM sessions WHERE id')) return { title: 'Morning surf', date: '2026-09-15', location: 'Mulki Beach' };
      throw new Error(`Unexpected query: ${sql}`);
    },
    async all() {
      if (sql.includes('object_key, filename FROM photos')) return { results: [{ id: 'photo-1', object_key: 'original/1.jpg', filename: filenames[0] }, { id: 'photo-2', object_key: 'original/2.jpg', filename: filenames[1] }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    async run() { assert.match(sql, /INSERT INTO events/); events.push(this.values); return {}; },
  });
  const PHOTOS = {
    async get(key) { reads.push(key); const text = objects[key]; return text === undefined ? null : { body: bodies === 'stream' ? new Response(text).body : text, httpMetadata: { contentType: 'image/jpeg' } }; },
  };
  if (withHead) PHOTOS.head = async key => { heads.push(key); return { size: new TextEncoder().encode(objects[key]).length }; };
  return { env: { ...secrets, DB: { prepare: statement }, PHOTOS }, reads, heads, objects, events };
}
function parseZip(buffer) {
  assert.equal(buffer.readUInt32LE(0), 0x04034B50, 'local header signature');
  assert.equal(buffer.readUInt32LE(buffer.length - 22), 0x06054B50, 'end-of-central-directory signature');
  const count = buffer.readUInt16LE(buffer.length - 12); let offset = buffer.readUInt32LE(buffer.length - 6); const entries = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014B50, 'central directory signature');
    const nameLength = buffer.readUInt16LE(offset + 28); const local = buffer.readUInt32LE(offset + 42);
    entries.push({ name: buffer.toString('utf8', offset + 46, offset + 46 + nameLength), crc: buffer.readUInt32LE(offset + 16), size: buffer.readUInt32LE(offset + 24), data: buffer.subarray(local + 30 + nameLength, local + 30 + nameLength + buffer.readUInt32LE(offset + 24)) });
    offset += 46 + nameLength;
  }
  return entries;
}
test('a paid search downloads every original as one streamed ZIP with an exact length', async context => {
  const { crc32 } = await import('node:zlib');
  const match = await getMatch(context);
  const { env, reads, heads, objects, events } = zipEnv();
  const result = await worker.fetch(request(`/api/searches/${match.searchId}/download?token=${encodeURIComponent(match.token)}`), env, {});
  assert.equal(result.status, 200);
  assert.deepEqual(events.map(row => row.slice(1)), [['download', 'session-1', match.searchId]], 'one download event per ZIP');
  assert.equal(result.headers.get('content-type'), 'application/zip');
  assert.equal(result.headers.get('content-disposition'), 'attachment; filename="surfers-of-india-2026-09-15-mulki-beach.zip"');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const buffer = Buffer.from(await result.arrayBuffer());
  assert.equal(Number(result.headers.get('content-length')), buffer.length);
  assert.deepEqual(heads, ['original/1.jpg', 'original/2.jpg']); assert.deepEqual(reads, ['original/1.jpg', 'original/2.jpg']);
  const entries = parseZip(buffer);
  assert.deepEqual(entries.map(entry => entry.name), ['IMG-0412.jpg', 'IMG-0413.jpg']);
  for (const [entry, key] of [[entries[0], 'original/1.jpg'], [entries[1], 'original/2.jpg']]) {
    assert.equal(entry.data.toString('utf8'), objects[key]); assert.equal(entry.size, entry.data.length); assert.equal(entry.crc, crc32(objects[key]));
  }
});
test('the ZIP still streams when object sizes are unknown and de-duplicates repeated filenames', async context => {
  const match = await getMatch(context);
  const { env } = zipEnv({ withHead: false, bodies: 'text', filenames: ['IMG 0412.jpg', 'IMG 0412.jpg'] });
  const result = await worker.fetch(request(`/api/searches/${match.searchId}/download?token=${encodeURIComponent(match.token)}`), env, {});
  assert.equal(result.status, 200); assert.equal(result.headers.get('content-length'), null);
  const entries = parseZip(Buffer.from(await result.arrayBuffer()));
  assert.deepEqual(entries.map(entry => entry.name), ['IMG-0412.jpg', 'IMG-0412-2.jpg']);
});
test('the ZIP is refused for unpaid searches and bad tokens', async context => {
  const match = await getMatch(context);
  assert.equal((await worker.fetch(request(`/api/searches/${match.searchId}/download?token=${encodeURIComponent(match.token)}`), zipEnv({ paid: false }).env, {})).status, 402);
  assert.equal((await worker.fetch(request(`/api/searches/${match.searchId}/download?token=nope`), zipEnv().env, {})).status, 401);
});

// ── Photo dimensions (migration 0012): header-only parsing ───────────────────
// Byte fixtures, not files: the smallest JPEG / PNG / WebP headers that carry a size.
const be16 = value => [(value >> 8) & 255, value & 255];
const be32 = value => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const jpegSegment = (marker, payload) => [0xFF, marker, ...be16(payload.length + 2), ...payload];
const jpegSof = (marker, width, height) => jpegSegment(marker, [8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
const APP0 = jpegSegment(0xE0, [0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
// An EXIF APP1 segment holding one IFD0 entry: the orientation tag, in the given byte order.
function exifSegment(orientation, little = true) {
  const u16 = value => little ? [value & 255, value >> 8] : be16(value);
  const u32 = value => little ? [value & 255, (value >> 8) & 255, (value >> 16) & 255, value >>> 24] : be32(value);
  const tiff = [...(little ? [0x49, 0x49] : [0x4D, 0x4D]), ...u16(0x2A), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)];
  return jpegSegment(0xE1, [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]);
}
const jpeg = (...segments) => Uint8Array.from([0xFF, 0xD8, ...segments.flat()]);
const png = (width, height) => Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(width), ...be32(height), 8, 2, 0, 0, 0, 0, 0, 0, 0]);
const riff = (chunk, payload) => Uint8Array.from([0x52, 0x49, 0x46, 0x46, ...le32(payload.length + 12), 0x57, 0x45, 0x42, 0x50, ...chunk.split('').map(c => c.charCodeAt(0)), ...le32(payload.length), ...payload]);
const le32 = value => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
const webpLossy = (width, height) => riff('VP8 ', [0x10, 0x02, 0x00, 0x9D, 0x01, 0x2A, width & 255, width >> 8, height & 255, height >> 8, 0, 0]);
const webpLossless = (width, height) => riff('VP8L', [0x2F, ...le32((width - 1) | ((height - 1) << 14)), 0]);
const webpExtended = (width, height) => riff('VP8X', [0x10, 0, 0, 0, ...le32(width - 1).slice(0, 3), ...le32(height - 1).slice(0, 3)]);
test('image headers give the pixel size for baseline and progressive JPEG (EXIF orientation 5–8 swaps it), PNG and the three WebP layouts', () => {
  assert.deepEqual(imageDimensions(jpeg(APP0, jpegSof(0xC0, 6000, 4000))), { width: 6000, height: 4000 });
  assert.deepEqual(imageDimensions(jpeg(APP0, jpegSof(0xC2, 6000, 4000))), { width: 6000, height: 4000 }, 'progressive SOF2');
  assert.deepEqual(imageDimensions(jpeg(APP0, exifSegment(1), jpegSof(0xC0, 6000, 4000))), { width: 6000, height: 4000 }, 'orientation 1 is upright');
  for (const orientation of [5, 6, 7, 8]) assert.deepEqual(imageDimensions(jpeg(exifSegment(orientation), jpegSof(0xC0, 6000, 4000))), { width: 4000, height: 6000 }, `orientation ${orientation} is a portrait shot stored sideways`);
  assert.deepEqual(imageDimensions(jpeg(exifSegment(6, false), APP0, jpegSof(0xC1, 6000, 4000))), { width: 4000, height: 6000 }, 'big-endian TIFF, SOF after other segments');
  assert.deepEqual(imageDimensions(jpeg([0xFF, 0xFF], APP0, [0xFF, 0xD0], jpegSof(0xC0, 320, 240))), { width: 320, height: 240 }, 'fill bytes and standalone markers are stepped over');
  assert.deepEqual(imageDimensions(png(1920, 1080)), { width: 1920, height: 1080 });
  assert.deepEqual(imageDimensions(webpLossy(1600, 900)), { width: 1600, height: 900 });
  assert.deepEqual(imageDimensions(webpLossless(1600, 900)), { width: 1600, height: 900 });
  assert.deepEqual(imageDimensions(webpExtended(4032, 3024)), { width: 4032, height: 3024 });
  // Only the header is read: a 64 KB slice of a JPEG whose SOF sits inside it parses without the rest.
  const big = new Uint8Array(70 * 1024); big.set(jpeg(APP0, jpegSof(0xC0, 6000, 4000)));
  assert.deepEqual(imageDimensions(big.subarray(0, 64 * 1024)), { width: 6000, height: 4000 });
});
test('unreadable or truncated headers give null rather than a guess', () => {
  const cases = {
    'not an image': Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]),
    'too short': Uint8Array.from([0xFF, 0xD8, 0xFF]),
    'JPEG cut before its SOF': jpeg(APP0).subarray(0, 12),
    'JPEG whose scan starts before any SOF': jpeg(APP0, jpegSegment(0xDA, [1, 2, 3]), jpegSof(0xC0, 6000, 4000)),
    'JPEG with a zero width': jpeg(APP0, jpegSof(0xC0, 0, 4000)),
    'JPEG with a broken marker chain': Uint8Array.from([0xFF, 0xD8, 0x00, 0xE0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    'PNG without IHDR first': Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...be32(4), 0x67, 0x41, 0x4D, 0x41, 0, 0, 0, 0, 0, 0, 0, 0]),
    'WebP with an unknown first chunk': riff('ALPH', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    'lossy WebP without its start code': riff('VP8 ', [0x10, 0x02, 0x00, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0]),
    'HEIC (ftyp box)': Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0, 0, 0, 0]),
    'not bytes at all': 'FFD8',
  };
  for (const [name, bytes] of Object.entries(cases)) assert.equal(imageDimensions(bytes), null, name);
});
// The streamed original is longer than the 64 KB header tee, so the copy-aside must not disturb the bytes R2 stores.
function streamedUpload(token, original, query = '') {
  const body = framedBody(JPEG([9, 9, 9]), original);
  return request(`/api/admin/sessions/session-1/photos?type=image%2Fjpeg&filename=DSC01237.JPG${query}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'content-length': String(body.size) }, body });
}
test('a streamed upload stores the size parsed from the original header, never the studio hint, and leaves the bytes intact', async () => {
  const token = await login();
  const { env, puts, inserts, insertSql } = uploadEnv({ existing: [], dimensions: true });
  const stored = {};
  env.PHOTOS.put = async (key, value) => { puts.push(key); stored[key] = value instanceof ReadableStream ? new Uint8Array(await new Response(value).arrayBuffer()) : value; };
  const original = new Uint8Array(70 * 1024); original.set(jpeg(APP0, exifSegment(6), jpegSof(0xC0, 6000, 4000))); original.fill(7, 1024); original[original.length - 1] = 42;
  // A portrait (EXIF 6) original; the hint says the preview is 600×450 (landscape) and must lose.
  const result = await worker.fetch(streamedUpload(token, original, '&width=600&height=450'), env, {});
  assert.equal(result.status, 201);
  assert.equal(inserts.length, 1); assert.match(insertSql[0], /width, height\) VALUES/);
  assert.deepEqual(inserts[0].slice(-2), [4000, 6000]);
  const originalKey = puts.find(key => key.includes('/original/'));
  assert.equal(stored[originalKey].length, original.length); assert.equal(stored[originalKey][original.length - 1], 42); assert.deepEqual(stored[originalKey].subarray(0, 40), original.subarray(0, 40));
});
test('the studio hint fills in only when the header cannot be read, and a bad hint is ignored', async () => {
  const token = await login();
  const opaque = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 1, 2, 3, 4, 5, 6, 7, 8]);   // a HEIC-like original the parser refuses
  const hinted = uploadEnv({ existing: [], dimensions: true });
  assert.equal((await worker.fetch(streamedUpload(token, opaque, '&width=600&height=450'), hinted.env, {})).status, 201);
  assert.match(hinted.insertSql[0], /width, height\) VALUES/); assert.deepEqual(hinted.inserts[0].slice(-2), [600, 450]);
  for (const query of ['', '&width=600', '&width=0&height=450', '&width=abc&height=450', '&width=1.5&height=450', '&width=70000&height=1']) {
    const unhinted = uploadEnv({ existing: [], dimensions: true });
    assert.equal((await worker.fetch(streamedUpload(token, opaque, query), unhinted.env, {})).status, 201);
    assert.doesNotMatch(unhinted.insertSql[0], /width/, `query ${JSON.stringify(query)} stores nothing`);
    assert.equal(unhinted.inserts[0].length, 6);
  }
});
test('uploads before migration 0012 insert without the size columns, and the multipart path parses the File slice', async () => {
  const token = await login();
  const unmigrated = uploadEnv({ existing: [], dimensions: false });
  assert.equal((await worker.fetch(streamedUpload(token, jpeg(APP0, jpegSof(0xC0, 6000, 4000)), '&width=600&height=400'), unmigrated.env, {})).status, 201);
  assert.doesNotMatch(unmigrated.insertSql[0], /width/); assert.equal(unmigrated.inserts[0].length, 6);
  const multipart = uploadEnv({ existing: [], dimensions: true });
  const form = new FormData();
  form.append('file', new Blob([png(1920, 1080)], { type: 'image/png' }), 'frame.png');
  form.append('preview', new Blob(['preview'], { type: 'image/jpeg' }), 'preview.jpg');
  const result = await worker.fetch(request('/api/admin/sessions/session-1/photos', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }), multipart.env, {});
  assert.equal(result.status, 201); assert.deepEqual(multipart.inserts[0].slice(-2), [1920, 1080]);
});
test('every photo object the API returns carries width and height — integers once known, null before migration 0012', async context => {
  // Guest: /api/match previews, then the preview and access refreshes.
  const sized = matchingEnv({ dimensions: true });
  context.mock.method(globalThis, 'fetch', async () => Response.json({ faces: [{ embedding: [1, 0] }] }));
  const match = await (await worker.fetch(request('/api/match', { method: 'POST', body: selfieForm(true) }), sized.env, {})).json();
  assert.equal(match.previews[0].width, 4000); assert.equal(match.previews[0].height, 6000);
  const unsized = await (await worker.fetch(request('/api/match', { method: 'POST', body: selfieForm(true) }), matchingEnv().env, {})).json();
  assert.equal(unsized.previews[0].width, null); assert.equal(unsized.previews[0].height, null);
  const gallery = galleryEnv({ paid: true, dimensions: true });
  const previews = await (await worker.fetch(request(`/api/searches/${match.searchId}/previews?token=${encodeURIComponent(match.token)}`), gallery.env, {})).json();
  assert.deepEqual(previews.photos.map(photo => [photo.width, photo.height]), [[6000, 4000], [null, null]], 'a photo uploaded before 0012 stays null even when the columns exist');
  const access = await (await worker.fetch(request(`/api/searches/${match.searchId}/access?token=${encodeURIComponent(match.token)}`), gallery.env, {})).json();
  assert.deepEqual(access.photos.map(photo => [photo.width, photo.height]), [[6000, 4000], [null, null]]);
  const legacy = await (await worker.fetch(request(`/api/searches/${match.searchId}/previews?token=${encodeURIComponent(match.token)}`), galleryEnv({ paid: true }).env, {})).json();
  assert.deepEqual(legacy.photos.map(photo => [photo.width, photo.height]), [[null, null], [null, null]]);
  // Crew: the session photo grid.
  const token = await login();
  const adminEnv = dimensions => ({ ...secrets, DB: adminAware({ prepare(sql) { return { bind() { return this; },
    async first() { if (sql.includes('SELECT cover_photo_id')) return { cover_photo_id: null }; throw new Error(`Unexpected query: ${sql}`); },
    async all() {
      if (sql.startsWith('PRAGMA')) return { results: dimensions ? [{ name: 'id' }, { name: 'cover_photo_id' }, { name: 'width' }] : [{ name: 'id' }] };
      assert.equal(sql.includes('p.width, p.height'), dimensions, 'the columns are only selected once they exist');
      return { results: [{ id: 'photo-1', filename: 'a.jpg', indexing_status: 'completed', face_count: 1, ...(dimensions ? { width: 6000, height: 4000 } : {}) }, { id: 'photo-2', filename: 'b.jpg', indexing_status: 'completed', face_count: 0, ...(dimensions ? { width: null, height: null } : {}) }] };
    } }; } }) });
  const grid = await (await worker.fetch(request('/api/admin/sessions/session-1/photos', { headers: { Authorization: `Bearer ${token}` } }), adminEnv(true), {})).json();
  assert.deepEqual(grid.photos.map(photo => [photo.width, photo.height]), [[6000, 4000], [null, null]]);
  const oldGrid = await (await worker.fetch(request('/api/admin/sessions/session-1/photos', { headers: { Authorization: `Bearer ${token}` } }), adminEnv(false), {})).json();
  assert.deepEqual(oldGrid.photos.map(photo => [photo.width, photo.height]), [[null, null], [null, null]]);
});

// ── Funnel events (migration 0013): search / match / zero_match / download ──
test('a search records search + match (or zero_match), with ids only — never the selfie, an IP or a phone', async context => {
  const found = matchingEnv();
  context.mock.method(globalThis, 'fetch', async () => Response.json({ faces: [{ embedding: [1, 0] }] }));
  const search = env => worker.fetch(request('/api/match', { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.44' }, body: selfieForm(true) }), env, {});
  const hit = await (await search(found.env)).json();
  assert.deepEqual(found.events.map(row => row.slice(1)), [['search', 'session-1', hit.searchId], ['match', 'session-1', hit.searchId]]);
  const missed = matchingEnv(); missed.env.MATCH_THRESHOLD = '1.5';   // nothing clears an impossible threshold
  const miss = await (await search(missed.env)).json();
  assert.equal(miss.count, 0);
  assert.deepEqual(missed.events.map(row => row.slice(1)), [['search', 'session-1', miss.searchId], ['zero_match', 'session-1', miss.searchId]]);
  const uuid = /^[0-9a-f-]{36}$/;
  for (const row of [...found.events, ...missed.events]) {
    assert.equal(row.length, 4); assert.match(row[0], uuid); assert.match(row[3], uuid);
    assert.equal(JSON.stringify(row).includes('203.0.113'), false); assert.equal(JSON.stringify(row).includes('image'), false);
  }
});
test('a missing events table only logs a warning: the search, the checkout and the download still succeed', async context => {
  const warn = context.mock.method(console, 'warn', () => {});
  const { env, searches } = matchingEnv({ events: 'missing' });
  context.mock.method(globalThis, 'fetch', async () => Response.json({ faces: [{ embedding: [1, 0] }] }));
  const result = await worker.fetch(request('/api/match', { method: 'POST', body: selfieForm(true) }), env, {});
  assert.equal(result.status, 200); assert.equal(searches.length, 1);
  assert.ok(warn.mock.calls.some(call => String(call.arguments[0]).includes('migration 0013')));
});
test('an original served with ?download=1 records a download event; an inline view or a preview does not', async context => {
  const match = await getMatch(context);
  const { env, runs } = galleryEnv({ paid: true });
  const body = await (await worker.fetch(request(`/api/searches/${match.searchId}/access?token=${encodeURIComponent(match.token)}`), env, {})).json();
  const downloads = () => runs.filter(entry => entry.sql?.includes('INSERT INTO events')).map(entry => entry.values.slice(1));
  assert.equal((await worker.fetch(new Request(body.photos[0].url), env, {})).status, 200);
  assert.deepEqual(downloads(), [], 'viewing the original inline is not a download');
  assert.equal((await worker.fetch(new Request(body.photos[0].downloadUrl), env, {})).status, 200);
  assert.deepEqual(downloads(), [['download', 'session-1', 'search-1']], 'the paid search\'s token names the search the download belongs to');
  assert.equal((await worker.fetch(new Request(body.photos[0].thumbUrl), env, {})).status, 200);
  assert.equal(downloads().length, 1);
});
// The landing-page cover is a public six-hour link to an original: it may render, never save as a file, never count.
test('a cover token renders the chosen original but refuses ?download=1 with 403 and records no event; a paid search\'s token downloads with an event; a crew original saves without one', async context => {
  const runs = []; const reads = [];
  const env = { ...secrets, DB: { prepare(sql) { return { values: [], bind(...values) { this.values = values; return this; },
    async all() {
      if (sql.startsWith('PRAGMA table_info(sessions)')) return { results: [{ name: 'id' }, { name: 'cover_photo_id' }] };
      if (sql.startsWith('PRAGMA')) return { results: [{ name: 'id' }] };
      if (sql.includes('FROM sessions s')) return { results: [{ id: 'session-1', title: 'Morning', session_date: '2026-09-15', location: 'Mulki', price_paise: 70000, currency: 'INR', cover_id: 'photo-1' }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    async first() {
      if (sql.includes('object_key, preview_key')) return { session_id: 'session-1', object_key: 'original/1.jpg', preview_key: 'preview/1.jpg', content_type: 'image/jpeg', filename: 'IMG 0412.jpg' };
      throw new Error(`Unexpected query: ${sql}`);
    },
    async run() { runs.push({ sql, values: this.values }); return { meta: { changes: 1 } }; },
  }; } }, PHOTOS: { async get(key) { reads.push(key); return { body: `bytes of ${key}`, httpMetadata: { contentType: 'image/jpeg' } }; } } };
  const events = () => runs.filter(entry => entry.sql.includes('INSERT INTO events')).map(entry => entry.values.slice(1));
  const [session] = (await (await worker.fetch(request('/api/sessions'), env, {})).json()).sessions;
  const cover = new URL(session.coverUrl);
  assert.equal(JSON.parse(Buffer.from(cover.searchParams.get('token').split('.')[0], 'base64url')).scope, 'cover', 'the cover token says what it is for');
  // Rendering the cover works exactly as before: the clean original, inline, privately cached.
  const shown = await worker.fetch(new Request(cover), env, {});
  assert.equal(shown.status, 200); assert.equal(await shown.text(), 'bytes of original/1.jpg'); assert.equal(shown.headers.get('content-disposition'), null); assert.equal(shown.headers.get('cache-control'), 'private, max-age=600');
  // …but ?download=1 on it is refused before storage is touched, and no funnel event is written.
  cover.searchParams.set('download', '1');
  const refused = await worker.fetch(new Request(cover), env, {});
  assert.equal(refused.status, 403); assert.match((await refused.json()).error, /cannot be downloaded/);
  assert.deepEqual(reads, ['original/1.jpg']); assert.deepEqual(events(), []);
  // A cover token cannot be re-pointed at another variant or photo either.
  const other = new URL(session.coverUrl); other.searchParams.set('variant', 'preview');
  assert.equal((await worker.fetch(new Request(other), env, {})).status, 401);
  // The token minted for a paid search (it names the search) saves the file and counts one download for that search.
  const paid = `${cover.origin}/api/media/photo-1?variant=original&download=1&token=${encodeURIComponent(signed({ scope: 'media', photoId: 'photo-1', variant: 'original', searchId: 'search-9', exp: Date.now() + 60_000 }))}`;
  const saved = await worker.fetch(new Request(paid), env, {});
  assert.equal(saved.status, 200); assert.equal(saved.headers.get('content-disposition'), 'attachment; filename="IMG-0412.jpg"');
  assert.deepEqual(events(), [['download', 'session-1', 'search-9']]);
  // A plain original token (crew review image) saves the file but is nobody's funnel step.
  const crew = `${cover.origin}/api/media/photo-1?variant=original&download=1&token=${encodeURIComponent(signed({ scope: 'media', photoId: 'photo-1', variant: 'original', exp: Date.now() + 60_000 }))}`;
  const review = await worker.fetch(new Request(crew), env, {});
  assert.equal(review.status, 200); assert.equal(review.headers.get('content-disposition'), 'attachment; filename="IMG-0412.jpg"');
  assert.equal(events().length, 1);
});

// ── GET /api/admin/stats ──────────────────────────────────────────────────────
// D1 double for the two aggregate statements: `rows` is the per-session event count query's answer
// (SUM over a LEFT JOIN yields NULL for a session with no events), `money` the captured-paise query's.
function statsEnv({ rows, money = [], grants = [], failure = null, grantsTable = true } = {}) {
  const statements = [];
  const env = { ...secrets, DB: adminAware({ prepare(sql) { statements.push(sql); return { bind() { return this; }, async all() {
      if (sql.includes('FROM grants g')) { if (!grantsTable) throw new Error('no such table: grants'); return { results: grants }; }
      throw new Error(`Unexpected query: ${sql}`);
    } }; },
    async batch(prepared) {
      if (failure) throw failure;
      assert.equal(prepared.length, 2);
      assert.match(statements.at(-2), /FROM sessions s LEFT JOIN events e ON e\.session_id = s\.id GROUP BY s\.id/);
      assert.match(statements.at(-1), /WHERE p\.status IN \('verified', 'captured'\)/);
      return [{ results: rows }, { results: money }];
    } }) };
  return { env, statements };
}
test('admin stats aggregate the funnel per session — zeros for quiet sessions, rupees from confirmed payments only — and total it', async () => {
  const token = await login();
  const stats = env => worker.fetch(request('/api/admin/stats', { headers: { Authorization: `Bearer ${token}` } }), env, {});
  const { env } = statsEnv({
    rows: [
      { id: 'session-1', title: 'Morning', searches: 4, matches: 3, zeroMatches: 1, checkouts: 2, unlocks: 2, downloads: 3 },
      { id: 'session-2', title: 'Evening', searches: null, matches: null, zeroMatches: null, checkouts: null, unlocks: null, downloads: null },
    ],
    money: [{ session_id: 'session-1', paise: 59850 }],
    grants: [{ session_id: 'session-2', n: 1 }],   // a free unlock: counted apart, never an unlock or rupees
  });
  const result = await stats(env);
  assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
  const body = await result.json();
  assert.deepEqual(body, {
    sessions: [
      { sessionId: 'session-1', title: 'Morning', searches: 4, matches: 3, zeroMatches: 1, zeroMatchRate: 0.25, checkouts: 2, unlocks: 2, downloads: 3, rupees: 598.5, grants: 0 },
      { sessionId: 'session-2', title: 'Evening', searches: 0, matches: 0, zeroMatches: 0, zeroMatchRate: 0, checkouts: 0, unlocks: 0, downloads: 0, rupees: 0, grants: 1 },
    ],
    totals: { searches: 4, matches: 3, zeroMatches: 1, zeroMatchRate: 0.25, checkouts: 2, unlocks: 2, downloads: 3, rupees: 598.5, grants: 1 },
  });
  // Before migration 0015 the grants table is missing: the funnel still answers, with grants at zero.
  const early = await (await stats(statsEnv({ rows: [{ id: 'session-1', title: 'Morning', searches: 1, matches: 1, zeroMatches: 0, checkouts: 0, unlocks: 0, downloads: 0 }], grantsTable: false }).env)).json();
  assert.equal(early.sessions[0].grants, 0); assert.equal(early.totals.grants, 0); assert.equal(early.unmigrated, undefined);
  assert.equal((await worker.fetch(request('/api/admin/stats'), env, {})).status, 401);
});
test('admin stats answer 200 with unmigrated: true while the events table is missing, and 500 for any other database failure', async () => {
  const token = await login();
  const stats = env => worker.fetch(request('/api/admin/stats', { headers: { Authorization: `Bearer ${token}` } }), env, {});
  const warned = []; const originalWarn = console.warn; console.warn = (...args) => warned.push(args.join(' '));
  try {
    const missing = await stats(statsEnv({ failure: new Error('D1_ERROR: no such table: events: SQLITE_ERROR') }).env);
    assert.equal(missing.status, 200);
    assert.deepEqual(await missing.json(), { sessions: [], totals: { searches: 0, matches: 0, zeroMatches: 0, zeroMatchRate: 0, checkouts: 0, unlocks: 0, downloads: 0, rupees: 0, grants: 0 }, unmigrated: true });
    assert.ok(warned.some(line => line.includes('migration 0013')));
  } finally { console.warn = originalWarn; }
  const originalError = console.error; console.error = () => {};
  try { assert.equal((await stats(statsEnv({ failure: new Error('D1_ERROR: storage caused object reset') }).env)).status, 500); }
  finally { console.error = originalError; }
});

// ── POST /api/admin/undo-review (F30) ────────────────────────────────────────
// Pairs, links and feedback rows live in Maps; the UPDATE/DELETE statements mutate them the way D1 would.
const recent = () => new Date(Date.now() - 60_000).toISOString().replace('T', ' ').slice(0, 19);   // one minute ago, as D1's CURRENT_TIMESTAMP writes it
function reviewEnv({ subjectColumn = true, pairs = [], links = [], feedback = [] } = {}) {
  const pairRows = new Map(pairs.map(row => [row.id, { ...row }])); const linkRows = new Map(links.map(row => [row.id, { ...row }]));
  const feedbackRows = feedback.map(row => ({ ...row })); const writes = [];
  const env = { ...secrets, DB: adminAware({ prepare(sql) { return { values: [], bind(...values) { this.values = values; return this; },
    async all() { if (sql.startsWith('PRAGMA table_info(match_feedback)')) return { results: subjectColumn ? [{ name: 'id' }, { name: 'subject_id' }] : [{ name: 'id' }] }; throw new Error(`Unexpected query: ${sql}`); },
    async first() {
      const [subjectId] = this.values;
      if (sql.includes('FROM face_verifications WHERE id')) { const row = pairRows.get(subjectId); return row ? (sql.includes('AS source') ? { status: row.status, updated_at: row.updated_at, score: row.similarity, source: 'face_pair' } : { similarity: row.similarity }) : null; }
      if (sql.includes('FROM photo_links WHERE id')) { const row = linkRows.get(subjectId); return row ? (sql.includes('AS source') ? { status: row.status, updated_at: row.updated_at, score: row.score, source: row.link_type === 'appearance' ? 'appearance_link' : 'burst_link' } : { link_type: row.link_type, score: row.score }) : null; }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async run() {
      const text = sql.trim();   // the confirm routes' statements start on a new line
      writes.push({ sql: text, values: this.values });
      const table = text.includes('face_verifications') ? pairRows : text.includes('photo_links') ? linkRows : null;
      if (text.startsWith('UPDATE') && text.includes("SET status = 'pending'")) { const row = table.get(this.values[0]); if (!row || row.status !== this.values[1]) return { meta: { changes: 0 } }; row.status = 'pending'; row.updated_at = recent(); return { meta: { changes: 1 } }; }
      if (text.startsWith('UPDATE') && text.includes("WHERE id = ? AND status = 'pending'")) { const row = table.get(this.values[1]); if (!row || row.status !== 'pending') return { meta: { changes: 0 } }; row.status = this.values[0]; row.updated_at = recent(); return { meta: { changes: 1 } }; }
      if (text.startsWith('INSERT INTO match_feedback')) { const [id, source, score, label, subjectId] = this.values; feedbackRows.push({ id, source, score, label, subject_id: text.includes('subject_id') ? subjectId : null, created_at: recent() }); return { meta: { changes: 1 } }; }
      if (text.startsWith('DELETE FROM match_feedback WHERE subject_id = ?')) { const before = feedbackRows.length; for (let i = feedbackRows.length - 1; i >= 0; i -= 1) if (feedbackRows[i].subject_id === this.values[0]) feedbackRows.splice(i, 1); return { meta: { changes: before - feedbackRows.length } }; }
      if (text.startsWith('DELETE FROM match_feedback WHERE id = (SELECT')) {
        const [source, score, label] = this.values;
        const candidates = feedbackRows.filter(row => row.source === source && row.score === score && row.label === label && (!text.includes('subject_id IS NULL') || row.subject_id === null));
        const newest = candidates.at(-1); if (!newest) return { meta: { changes: 0 } };
        feedbackRows.splice(feedbackRows.indexOf(newest), 1); return { meta: { changes: 1 } };
      }
      throw new Error(`Unexpected write: ${text}`);
    },
  }; } }) };
  return { env, pairRows, linkRows, feedbackRows, writes };
}
const undo = (token, env, body) => worker.fetch(request('/api/admin/undo-review', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }), env, {});
test('a crew decision tags its feedback row with the pair or link id, and Z within ten minutes puts the pair back and removes exactly that row', async () => {
  const token = await login();
  const { env, pairRows, feedbackRows } = reviewEnv({ pairs: [{ id: 'pair-1', status: 'pending', similarity: 0.61, updated_at: recent() }], feedback: [{ id: 'older', source: 'face_pair', score: 0.61, label: 1, subject_id: null, created_at: '2026-09-01 10:00:00' }] });
  const decided = await worker.fetch(request('/api/admin/confirm-match', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ pairId: 'pair-1', confirmed: true }) }), env, {});
  assert.equal(decided.status, 200); assert.equal(pairRows.get('pair-1').status, 'confirmed');
  assert.equal(feedbackRows.length, 2); assert.equal(feedbackRows[1].subject_id, 'pair-1'); assert.equal(feedbackRows[1].label, 1);
  const undone = await undo(token, env, { kind: 'pair', id: 'pair-1' });
  assert.equal(undone.status, 200); assert.deepEqual(await undone.json(), { success: true, kind: 'pair', id: 'pair-1', status: 'pending' });
  assert.equal(pairRows.get('pair-1').status, 'pending');
  assert.deepEqual(feedbackRows.map(row => row.id), ['older'], 'only the row that decision inserted is gone');
  // Back in the queue, it can be decided again — and undone again.
  assert.equal((await worker.fetch(request('/api/admin/confirm-match', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ pairId: 'pair-1', confirmed: false }) }), env, {})).status, 200);
  assert.equal(feedbackRows.at(-1).label, 0);
  assert.equal((await undo(token, env, { kind: 'pair', id: 'pair-1' })).status, 200); assert.equal(feedbackRows.length, 1);
});
test('undo covers appearance links, refuses stale or already-pending decisions with 409 and unknown ids with 404', async () => {
  const token = await login();
  const { env, linkRows, feedbackRows } = reviewEnv({ links: [
    { id: 'link-1', status: 'pending', link_type: 'appearance', score: 0.9, updated_at: recent() },
    { id: 'link-old', status: 'rejected', link_type: 'appearance', score: 0.88, updated_at: '2026-09-17 06:00:00' },
    { id: 'link-idle', status: 'pending', link_type: 'appearance', score: 0.87, updated_at: recent() },
  ] });
  assert.equal((await worker.fetch(request('/api/admin/confirm-link', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ linkId: 'link-1', confirmed: false }) }), env, {})).status, 200);
  assert.deepEqual(feedbackRows.map(row => [row.source, row.score, row.label, row.subject_id]), [['appearance_link', 0.9, 0, 'link-1']]);
  const undone = await undo(token, env, { kind: 'link', id: 'link-1' });
  assert.equal(undone.status, 200); assert.deepEqual(await undone.json(), { success: true, kind: 'link', id: 'link-1', status: 'pending' });
  assert.equal(linkRows.get('link-1').status, 'pending'); assert.deepEqual(feedbackRows, []);
  const stale = await undo(token, env, { kind: 'link', id: 'link-old' });
  assert.equal(stale.status, 409); assert.equal((await stale.json()).error, 'Too late to undo — the queue moved on.'); assert.equal(linkRows.get('link-old').status, 'rejected');
  assert.equal((await undo(token, env, { kind: 'link', id: 'link-idle' })).status, 409, 'nothing to undo on a pending row');
  assert.equal((await undo(token, env, { kind: 'pair', id: 'link-1' })).status, 404, 'a link id is not a pair id');
  assert.equal((await undo(token, env, { kind: 'link', id: 'nope' })).status, 404);
  for (const body of [{}, { kind: 'photo', id: 'link-1' }, { kind: 'link' }, { kind: 'link', id: 7 }]) assert.equal((await undo(token, env, body)).status, 400);
  assert.equal((await worker.fetch(request('/api/admin/undo-review', { method: 'POST', body: JSON.stringify({ kind: 'link', id: 'link-1' }) }), env, {})).status, 401);
});
test('decisions recorded before migration 0013 are undone by the newest matching feedback row from the last ten minutes', async () => {
  const token = await login();
  const { env, pairRows, feedbackRows, writes } = reviewEnv({ subjectColumn: false,
    pairs: [{ id: 'pair-2', status: 'rejected', similarity: 0.6, updated_at: recent() }],
    feedback: [
      { id: 'other-score', source: 'face_pair', score: 0.59, label: 0, subject_id: null, created_at: recent() },
      { id: 'earlier', source: 'face_pair', score: 0.6, label: 0, subject_id: null, created_at: recent() },
      { id: 'newest', source: 'face_pair', score: 0.6, label: 0, subject_id: null, created_at: recent() },
    ] });
  assert.equal((await undo(token, env, { kind: 'pair', id: 'pair-2' })).status, 200);
  assert.equal(pairRows.get('pair-2').status, 'pending');
  assert.deepEqual(feedbackRows.map(row => row.id), ['other-score', 'earlier']);
  const fallback = writes.find(entry => entry.sql.startsWith('DELETE FROM match_feedback WHERE id = (SELECT'));
  assert.match(fallback.sql, /source = \? AND face_similarity = \? AND label = \?/); assert.match(fallback.sql, /datetime\('now', '-10 minutes'\)/); assert.doesNotMatch(fallback.sql, /subject_id/);
  assert.deepEqual(fallback.values, ['face_pair', 0.6, 0]);
  assert.equal(writes.some(entry => entry.sql.startsWith('DELETE FROM match_feedback WHERE subject_id')), false, 'no subject_id lookup before the column exists');
  // With the column present, an untagged row (decided before the migration) still falls back — restricted to untagged rows.
  const mixed = reviewEnv({ links: [{ id: 'link-9', status: 'confirmed', link_type: 'burst', score: 0.75, updated_at: recent() }],
    feedback: [{ id: 'tagged-elsewhere', source: 'burst_link', score: 0.75, label: 1, subject_id: 'link-8', created_at: recent() }, { id: 'untagged', source: 'burst_link', score: 0.75, label: 1, subject_id: null, created_at: recent() }] });
  assert.equal((await undo(token, mixed.env, { kind: 'link', id: 'link-9' })).status, 200);
  assert.deepEqual(mixed.feedbackRows.map(row => row.id), ['tagged-elsewhere']);
  assert.match(mixed.writes.find(entry => entry.sql.startsWith('DELETE FROM match_feedback WHERE id = (SELECT')).sql, /burst_score = \? AND label = \? AND subject_id IS NULL/);
});

// ── Wave 3 · real-SQLite harness for the second-chance and support routes ────
// The doubles above answer by SQL substring; the routes below lean on real SQL (list unions,
// ON CONFLICT upserts, window functions, cascades), so they run against schema.sql in node:sqlite
// with a D1 shim whose batch() answers SELECTs with rows, as D1 does.
import { DatabaseSync } from 'node:sqlite';
const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
function sqliteEnv(context, seed = '') {
  const sql = new DatabaseSync(':memory:'); sql.exec(schema); context.after(() => sql.close());
  if (seed) sql.exec(seed);
  const deleted = []; const queued = [];
  const env = { ...secrets, FACE_API_URL: 'https://face.example/extract', MATCH_THRESHOLD: '0.62', ALLOWED_ORIGIN: 'https://site.example',
    DB: { prepare(query) { const statement = sql.prepare(query); let args = []; return { query,
      bind(...values) { args = values; return this; }, async first() { return statement.get(...args) || null; }, async all() { return { results: statement.all(...args) }; }, async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; } }; },
      async batch(statements) { sql.exec('BEGIN'); try { const result = []; for (const statement of statements) result.push(/^\s*SELECT/i.test(statement.query) ? await statement.all() : await statement.run()); sql.exec('COMMIT'); return result; } catch (caught) { sql.exec('ROLLBACK'); throw caught; } } },
    PHOTOS: { async put() {}, async get(key) { return { body: `bytes of ${key}`, httpMetadata: { contentType: 'image/jpeg' } }; }, async head() { return { size: 5 }; }, async delete(key) { deleted.push(...(Array.isArray(key) ? key : [key])); } },
    INDEX_QUEUE: { async send(message) { queued.push(message); } } };
  const api = (path, init) => worker.fetch(new Request(`https://api.example${path}`, init), env, {});
  const post = (path, body, headers = {}) => api(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const crew = async () => {
    const token = (await (await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: secrets.ADMIN_PASSWORD }) })).json()).token;
    return (path, init = {}) => api(path, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) } });
  };
  const searchToken = searchId => signed({ scope: 'search', searchId, exp: Date.now() + 45 * 60_000 });
  return { sql, env, api, post, crew, searchToken, deleted, queued };
}
// A clothing histogram as the face service stores it: 30 hue bins (12° each) × 32 saturation bins,
// row-major, with all of its mass in one cell (or a few).
function histogram(...cells) { const bins = new Array(30 * 32).fill(0); for (const [hue, sat, weight = 1] of cells) bins[Math.floor(hue / 12) * 32 + sat] = weight; return JSON.stringify(bins); }
const SESSION_SEED = `
  INSERT INTO sessions(id,title,session_date,location,status,price_paise) VALUES ('s1','Morning glass','2026-09-15','Mulki','published',29900), ('s2','Quiet','2026-09-16','Mulki','published',29900);
  INSERT INTO photos(id,session_id,object_key,preview_key,thumb_key,filename,content_type,indexing_status,width,height) VALUES
    ('p-red','s1','o/red','v/red','t/red','red.jpg','image/jpeg','completed',6000,4000),
    ('p-blue','s1','o/blue','v/blue',NULL,'blue.jpg','image/jpeg','completed',4000,6000),
    ('p-pastel','s1','o/pastel','v/pastel',NULL,'pastel.jpg','image/jpeg','completed',NULL,NULL),
    ('p-grey','s1','o/grey','v/grey',NULL,'grey.jpg','image/jpeg','completed',NULL,NULL),
    ('p-pending','s1','o/pending','v/pending',NULL,'pending.jpg','image/jpeg','pending',NULL,NULL),
    ('p-other','s2','o/other','v/other',NULL,'other.jpg','image/jpeg','completed',NULL,NULL);
  INSERT INTO photo_appearances(photo_id,histogram_json) VALUES
    ('p-red', '${histogram([0, 28])}'), ('p-blue', '${histogram([240, 28, 1], [12, 28, 0.2])}'), ('p-pastel', '${histogram([240, 6])}'), ('p-grey', '${histogram([240, 0])}'),
    ('p-pending', '${histogram([240, 28])}'), ('p-other', '${histogram([240, 28])}');
  INSERT INTO searches(id,session_id,matched_photo_ids_json,price_paise,currency,expires_at) VALUES ('sr1','s1','["p-red"]',29900,'INR','2999-01-01 00:00:00');
`;
const previewIds = body => body.previews.map(preview => preview.photoId);
test('the colour search ranks a session\'s clothing histograms by hue and tone, keeps its list on the search so previews include it, and is quota-limited like a search', async context => {
  const { sql, api, post, searchToken } = sqliteEnv(context, SESSION_SEED);
  const token = searchToken('sr1');
  const colour = (hue, tone, extra = {}) => post('/api/searches/sr1/colour', { token, hue, tone }, extra);
  const vivid = await colour(240, 'vivid');
  assert.equal(vivid.status, 200);
  const body = await vivid.json();
  assert.deepEqual(previewIds(body), ['p-blue'], 'vivid blue: the pastel and the grey do not count, the pending photo and the other session are never candidates');
  assert.deepEqual(Object.keys(body).sort(), ['count', 'currency', 'hue', 'indexingNote', 'mode', 'previews', 'pricePaise', 'searchId', 'session', 'token', 'tone'], 'the /api/match shape plus mode, hue and tone');
  assert.equal(body.mode, 'colour'); assert.equal(body.count, 1); assert.equal(body.pricePaise, 29900); assert.equal(body.session.title, 'Morning glass'); assert.equal(body.token, token);
  assert.match(body.indexingNote, /^1 photos are still processing/);
  assert.ok(body.previews[0].score >= 70 && body.previews[0].score <= 100, `score ${body.previews[0].score}`);
  assert.match(body.previews[0].url, /variant=preview/); assert.equal(body.previews[0].width, 4000); assert.equal(body.previews[0].height, 6000);
  assert.equal(sql.prepare('SELECT colour_photo_ids_json FROM searches WHERE id = ?').get('sr1').colour_photo_ids_json, '["p-blue"]');
  // The union reaches the preview refresh: the face match first, then the colour result, once each.
  const refreshed = await (await api(`/api/searches/sr1/previews?token=${encodeURIComponent(token)}`)).json();
  assert.deepEqual(refreshed.photos.map(photo => photo.photoId).sort(), ['p-blue', 'p-red']);
  assert.deepEqual(previewIds(await (await colour(240, 'muted')).json()), ['p-pastel'], 'muted blue is the pastel');
  assert.deepEqual(previewIds(await (await colour(240, 'any')).json()), ['p-pastel', 'p-blue'], 'any tone: the purest blue first (p-blue carries a fifth of red, the pastel is all blue)');
  assert.deepEqual(previewIds(await (await colour(355, 'vivid')).json()), ['p-red'], 'the wheel wraps: 355° is next to red at 0°');
  assert.deepEqual(previewIds(await (await colour(120, 'any')).json()), [], 'nothing green in this session: an honest empty list');
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0, 'no funnel event: the events CHECK has no colour kind');
  // Validation and the token.
  for (const [hue, tone] of [[360, 'any'], [-1, 'any'], ['blue', 'any'], [null, 'any'], [240, 'loud']]) assert.equal((await colour(hue, tone)).status, 400, `${hue} ${tone}`);
  assert.equal((await post('/api/searches/sr1/colour', { token: searchToken('other'), hue: 1, tone: 'any' })).status, 401);
  sql.exec("UPDATE searches SET expires_at = '2000-01-01 00:00:00' WHERE id = 'sr1'");
  assert.equal((await colour(240, 'any')).status, 410, 'an expired search cannot be searched again');
  sql.exec("UPDATE searches SET expires_at = '2999-01-01 00:00:00' WHERE id = 'sr1'");
  // Quota: colour:10m:<ip>, 8 per ten minutes, refused with retry-after and the search copy.
  sql.exec("INSERT INTO rate_limits(key, count, window_start) VALUES ('colour:10m:203.0.113.9', 8, CURRENT_TIMESTAMP)");
  const blocked = await colour(240, 'any', { 'cf-connecting-ip': '203.0.113.9' });
  assert.equal(blocked.status, 429); assert.ok(Number(blocked.headers.get('retry-after')) > 0); assert.match((await blocked.json()).error, /searched a lot/);
  assert.equal(sql.prepare("SELECT count FROM rate_limits WHERE key = 'colour:10m:203.0.113.9'").get().count, 9, 'a refused call still counts');
  assert.equal((await colour(240, 'any', { 'cf-connecting-ip': '203.0.113.10' })).status, 200, 'another IP is not affected');
});
test('hiding a photo removes it from the matched and colour lists, keeps it out of later colour searches and the paid pack, and answers 404 for a photo outside the search', async context => {
  const { sql, api, post, searchToken } = sqliteEnv(context, SESSION_SEED);
  const token = searchToken('sr1');
  assert.equal((await post('/api/searches/sr1/colour', { token, hue: 240, tone: 'any' })).status, 200);   // p-blue, p-pastel
  const hidden = await post('/api/searches/sr1/hide', { token, photoId: 'p-blue', score: 83 });
  assert.equal(hidden.status, 200); assert.deepEqual(await hidden.json(), { ok: true, remaining: 2 });
  assert.deepEqual({ ...sql.prepare('SELECT matched_photo_ids_json AS m, colour_photo_ids_json AS c FROM searches WHERE id = ?').get('sr1') }, { m: '["p-red"]', c: '["p-pastel"]' });
  assert.deepEqual(sql.prepare('SELECT photo_id, similarity FROM match_hides').all().map(row => ({ ...row })), [{ photo_id: 'p-blue', similarity: 0.83 }]);
  const again = await (await post('/api/searches/sr1/colour', { token, hue: 240, tone: 'any' })).json();
  assert.deepEqual(previewIds(again), ['p-pastel'], 'a hidden photo never comes back from a colour search');
  const face = await post('/api/searches/sr1/hide', { token, photoId: 'p-red' });
  assert.deepEqual(await face.json(), { ok: true, remaining: 1 }, 'a face match can be hidden too');
  assert.equal((await post('/api/searches/sr1/hide', { token, photoId: 'p-grey' })).status, 404, 'not in this search');
  assert.equal((await post('/api/searches/sr1/hide', { token, photoId: 'p-blue' })).status, 404, 'already gone');
  assert.equal((await post('/api/searches/sr1/hide', { token })).status, 400);
  assert.equal((await post('/api/searches/sr1/hide', { token: 'nope', photoId: 'p-pastel' })).status, 401);
  // What is left is what the guest sees and pays for: previews, then the paid pack and its ZIP.
  assert.deepEqual((await (await api(`/api/searches/sr1/previews?token=${encodeURIComponent(token)}`)).json()).photos.map(photo => photo.photoId), ['p-pastel']);
  sql.exec("UPDATE searches SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = 'sr1'");
  const access = await (await api(`/api/searches/sr1/access?token=${encodeURIComponent(token)}`)).json();
  assert.deepEqual(access.photos.map(photo => photo.photoId), ['p-pastel']);
  assert.ok(sql.prepare('SELECT gallery_link_expires_at FROM searches WHERE id = ?').get('sr1').gallery_link_expires_at, '/access records when the 30-day link expires');
  const zip = await api(`/api/searches/sr1/download?token=${encodeURIComponent(token)}`);
  assert.equal(zip.status, 200); assert.deepEqual(parseZip(Buffer.from(await zip.arrayBuffer())).map(entry => entry.name), ['pastel.jpg']);
  assert.equal((await post('/api/searches/sr1/hide', { token, photoId: 'p-pastel' })).status, 410, 'a paid search is no longer edited');
});
test('notify-me keeps one phone per search, validated like checkout, and replaces it on a repeat', async context => {
  const { sql, post, searchToken } = sqliteEnv(context, SESSION_SEED);
  const token = searchToken('sr1');
  const ask = phone => post('/api/searches/sr1/notify', { token, phone });
  assert.equal((await ask('12345')).status, 400); assert.equal((await ask(9876543210)).status, 400);
  assert.equal((await post('/api/searches/sr1/notify', { token: searchToken('sr2'), phone: '9876543210' })).status, 401);
  const first = await ask('9876543210'); assert.equal(first.status, 200); assert.deepEqual(await first.json(), { ok: true });
  assert.equal((await ask('9123456789')).status, 200);
  assert.deepEqual(sql.prepare('SELECT search_id, session_id, phone, notified_at FROM notify_requests').all().map(row => ({ ...row })), [{ search_id: 'sr1', session_id: 's1', phone: '9123456789', notified_at: null }], 'one row per search, the newest phone');
  sql.exec('DROP TABLE notify_requests');
  assert.equal((await ask('9876543210')).status, 503, 'before migration 0015 the route says so instead of failing');
});
// ── Wave 3 · session conditions (migration 0014) ─────────────────────────────
test('session conditions are validated on create and edit, returned to the crew and to guests, and the landing page learns the earliest future drop', async context => {
  const { sql, api, crew } = sqliteEnv(context);
  const admin = await crew();
  const create = body => admin('/api/admin/sessions', { method: 'POST', body: JSON.stringify({ title: 'Morning', location: 'Mulki', date: '2026-09-15', pricePaise: 29900, ...body }) });
  const soon = new Date(Date.now() + 3 * 3600_000).toISOString(), later = new Date(Date.now() + 26 * 3600_000).toISOString();
  for (const bad of [{ swellFt: 31 }, { swellFt: -1 }, { swellFt: 'big' }, { breakName: 'x'.repeat(61) }, { wind: 'x'.repeat(31) }, { tide: 'x'.repeat(31) }, { photographer: 'x'.repeat(61) }, { nextDropAt: 'tomorrow' }, { nextDropAt: '2020-01-01T00:00:00Z' }, { nextDropAt: 7 }]) {
    const refused = await create(bad); assert.equal(refused.status, 400, JSON.stringify(bad)); assert.ok((await refused.json()).error);
  }
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'nothing was inserted');
  const created = await create({ breakName: ' Mulki left ', swellFt: 3.26, wind: 'OFFSHORE', tide: 'Rising', photographer: 'Ankith', nextDropAt: later });
  assert.equal(created.status, 201);
  const { session } = await created.json();
  assert.deepEqual(session.conditions, { breakName: 'Mulki left', swellFt: 3.3, wind: 'offshore', tide: 'rising', photographer: 'Ankith' }); assert.equal(session.nextDropAt, later);
  const plain = await (await create({ title: 'Quiet', date: '2026-09-16', breakName: '', swellFt: null })).json();
  assert.equal(plain.session.conditions, null); assert.equal(plain.session.nextDropAt, null);
  // Edit: null clears, unknown fields are ignored, a past drop is refused, other fields keep their values.
  assert.equal((await admin(`/api/admin/sessions/${session.id}`, { method: 'PUT', body: JSON.stringify({ tide: null, wind: 'a bit cross', nextDropAt: soon, shaka: true }) })).status, 200);
  assert.equal((await admin(`/api/admin/sessions/${session.id}`, { method: 'PUT', body: JSON.stringify({ nextDropAt: '2020-01-01T00:00:00Z' }) })).status, 400);
  assert.deepEqual({ ...sql.prepare('SELECT break_name, swell_ft, wind, tide, photographer, next_drop_at FROM sessions WHERE id = ?').get(session.id) }, { break_name: 'Mulki left', swell_ft: 3.3, wind: 'a bit cross', tide: null, photographer: 'Ankith', next_drop_at: soon });
  const dashboard = await (await admin('/api/admin/dashboard')).json();
  const card = dashboard.sessions.find(item => item.id === session.id);
  assert.deepEqual(card.conditions, { breakName: 'Mulki left', swellFt: 3.3, wind: 'a bit cross', tide: null, photographer: 'Ankith' }); assert.equal(card.nextDropAt, soon);
  assert.deepEqual(card.indexing, { queued: 0, processing: 0, done: 0, failed: 0, etaSeconds: null, failures: [] });
  assert.equal('break_name' in card, false, 'raw columns never leak');
  assert.equal(dashboard.sessions.find(item => item.id === plain.session.id).conditions, null);
  // Guests: published sessions carry conditions; the top-level nextDropAt is the earliest one still ahead.
  sql.exec(`UPDATE sessions SET status = 'published'; UPDATE sessions SET next_drop_at = '${later}' WHERE id = '${plain.session.id}'`);
  const listed = await (await api('/api/sessions')).json();
  assert.equal(listed.nextDropAt, soon);
  assert.deepEqual(listed.sessions.map(item => [item.id, item.conditions?.breakName ?? null, item.nextDropAt]).sort(), [[plain.session.id, null, later], [session.id, 'Mulki left', soon]].sort());
  sql.exec("UPDATE sessions SET next_drop_at = '2020-01-01T00:00:00.000Z'");
  const stale = await (await api('/api/sessions')).json();
  assert.equal(stale.nextDropAt, null); assert.ok(stale.sessions.every(item => item.nextDropAt === null), 'a drop that already happened is not repeated');
  // Before migration 0014 the columns are missing: empty fields pass, real values are refused with 503.
  const early = sqliteEnv(context); early.sql.exec('ALTER TABLE sessions DROP COLUMN break_name');
  const earlyAdmin = await early.crew();
  assert.equal((await earlyAdmin('/api/admin/sessions', { method: 'POST', body: JSON.stringify({ title: 'Morning', location: 'Mulki', date: '2026-09-15', pricePaise: 29900, breakName: '' }) })).status, 201);
  assert.equal((await earlyAdmin('/api/admin/sessions', { method: 'POST', body: JSON.stringify({ title: 'Morning', location: 'Mulki', date: '2026-09-15', pricePaise: 29900, breakName: 'Mulki' }) })).status, 503);
  assert.equal((await (await early.api('/api/sessions')).json()).nextDropAt, null);
});
test('publishing needs a chosen cover or an explicit noCover: true', async context => {
  const { sql, crew } = sqliteEnv(context, "INSERT INTO sessions(id,title,session_date,location) VALUES ('draft','Draft','2026-09-15','Mulki'), ('empty','Empty','2026-09-15','Mulki'); INSERT INTO photos(id,session_id,object_key,preview_key,filename,content_type) VALUES ('p1','draft','o1','v1','a.jpg','image/jpeg');");
  const admin = await crew();
  const publish = (sessionId, body) => admin(`/api/admin/sessions/${sessionId}/publish`, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) });
  const needs = await publish('draft');
  assert.equal(needs.status, 409); assert.deepEqual(await needs.json(), { error: 'Pick a cover photo or publish without one.', needsCover: true });
  assert.equal(sql.prepare("SELECT status FROM sessions WHERE id = 'draft'").get().status, 'draft');
  assert.equal((await publish('draft', { noCover: 'yes' })).status, 409, 'only a boolean true counts');
  assert.equal((await publish('draft', { noCover: true })).status, 200);
  assert.equal(sql.prepare("SELECT status FROM sessions WHERE id = 'draft'").get().status, 'published');
  sql.exec("UPDATE sessions SET status = 'draft', cover_photo_id = 'p1' WHERE id = 'draft'");
  assert.equal((await publish('draft')).status, 200, 'a chosen cover needs no body at all');
  assert.equal((await publish('empty', { noCover: true })).status, 400, 'still needs a photo');
  assert.equal((await publish('missing', { noCover: true })).status, 404);
  assert.equal((await admin('/api/admin/sessions/draft/publish', { method: 'POST', body: '{' })).status, 400, 'a malformed body is not silently ignored');
});
// ── Wave 3 · crew bulk actions and queue observability ───────────────────────
const BULK_SEED = `
  INSERT INTO sessions(id,title,session_date,location,cover_photo_id) VALUES ('a','A','2026-09-15','Mulki',NULL), ('b','B','2026-09-16','Mulki',NULL), ('z','Z','2026-09-16','Mulki',NULL);
  UPDATE sessions SET status = 'archived' WHERE id = 'z';
  INSERT INTO photos(id,session_id,object_key,preview_key,thumb_key,filename,content_type,indexing_status) VALUES
    ('p1','a','o1','v1','t1','1.jpg','image/jpeg','completed'), ('p2','a','o2','v2',NULL,'2.jpg','image/jpeg','completed'), ('p3','a','o3','v3',NULL,'3.jpg','image/jpeg','completed'), ('p4','b','o4','v4',NULL,'4.jpg','image/jpeg','failed');
  UPDATE sessions SET cover_photo_id = 'p1' WHERE id = 'a';
  INSERT INTO faces(id,photo_id,embedding_json) VALUES ('f1','p1','[1,0]'), ('f2','p2','[1,0]'), ('f3','p3','[0,1]');
  INSERT INTO face_verifications(id,session_id,face1_id,face2_id,similarity) VALUES ('pair12','a','f1','f2',0.6), ('pair23','a','f2','f3',0.6);
  INSERT INTO photo_links(id,session_id,photo1_id,photo2_id,link_type,score) VALUES ('link12','a','p1','p2','burst',0.9), ('link23','a','p2','p3','appearance',0.9);
`;
test('bulk photo actions move a selection with the links and pairs that travel whole, set a cover, re-index, and delete — unknown ids fail without stopping the rest', async context => {
  const { sql, crew, deleted, queued } = sqliteEnv(context, BULK_SEED);
  const admin = await crew();
  const bulk = body => admin('/api/admin/photos/bulk', { method: 'POST', body: JSON.stringify(body) });
  for (const bad of [{}, { action: 'archive', photoIds: ['p1'] }, { action: 'delete', photoIds: [] }, { action: 'delete', photoIds: 'p1' }, { action: 'delete', photoIds: [7] }, { action: 'delete', photoIds: Array.from({ length: 201 }, (_, i) => `p${i}`) }, { action: 'move', photoIds: ['p1'] }]) assert.equal((await bulk(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await bulk({ action: 'move', photoIds: ['p1'], targetSessionId: 'nope' })).status, 404);
  assert.equal((await bulk({ action: 'move', photoIds: ['p1'], targetSessionId: 'z' })).status, 409, 'not into an archived session');
  // Move p1 and p2 to b: the pair/link between them follows, the ones shared with p3 (staying) are dropped, a's cover is cleared.
  const moved = await bulk({ action: 'move', photoIds: ['p1', 'p2', 'ghost'], targetSessionId: 'b' });
  assert.equal(moved.status, 200); assert.deepEqual(await moved.json(), { ok: true, affected: 2, failed: [{ photoId: 'ghost', error: 'Photo not found.' }] });
  assert.deepEqual(sql.prepare('SELECT id, session_id FROM photos ORDER BY id').all().map(row => [row.id, row.session_id]), [['p1', 'b'], ['p2', 'b'], ['p3', 'a'], ['p4', 'b']]);
  assert.deepEqual(sql.prepare('SELECT id, session_id FROM photo_links ORDER BY id').all().map(row => [row.id, row.session_id]), [['link12', 'b']]);
  assert.deepEqual(sql.prepare('SELECT id, session_id FROM face_verifications ORDER BY id').all().map(row => [row.id, row.session_id]), [['pair12', 'b']]);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM faces').get().n, 3, 'faces stay attached to their photos');
  assert.equal(sql.prepare("SELECT cover_photo_id FROM sessions WHERE id = 'a'").get().cover_photo_id, null);
  assert.deepEqual(await (await bulk({ action: 'move', photoIds: ['p1'], targetSessionId: 'b' })).json(), { ok: true, affected: 0, failed: [] }, 'already there');
  // Cover: the first id becomes the cover of its own session.
  assert.deepEqual(await (await bulk({ action: 'cover', photoIds: ['p3', 'p1'] })).json(), { ok: true, affected: 1, failed: [] });
  assert.equal(sql.prepare("SELECT cover_photo_id FROM sessions WHERE id = 'a'").get().cover_photo_id, 'p3');
  assert.equal((await bulk({ action: 'cover', photoIds: ['ghost'] })).status, 404);
  // Re-index forces a fresh job for each photo, even a failed one.
  const reindexed = await (await bulk({ action: 'reindex', photoIds: ['p3', 'p4', 'ghost'] })).json();
  assert.deepEqual(reindexed, { ok: true, affected: 2, failed: [{ photoId: 'ghost', error: 'Photo not found.' }] });
  assert.equal(queued.length, 2); assert.deepEqual(sql.prepare("SELECT status FROM indexing_jobs WHERE photo_id IN ('p3', 'p4')").all().map(row => row.status), ['queued', 'queued']);
  // Delete removes files (original, preview, thumb when present) and rows; the session's cover empties itself.
  const removed = await (await bulk({ action: 'delete', photoIds: ['p3', 'p1', 'ghost'] })).json();
  assert.deepEqual(removed, { ok: true, affected: 2, failed: [{ photoId: 'ghost', error: 'Photo not found.' }] });
  assert.deepEqual(deleted.sort(), ['o1', 'o3', 't1', 'v1', 'v3']);
  assert.deepEqual(sql.prepare('SELECT id FROM photos ORDER BY id').all().map(row => row.id), ['p2', 'p4']);
  assert.equal(sql.prepare("SELECT cover_photo_id FROM sessions WHERE id = 'a'").get().cover_photo_id, null);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM faces').get().n, 1);
  assert.equal((await worker.fetch(request('/api/admin/photos/bulk', { method: 'POST', body: JSON.stringify({ action: 'delete', photoIds: ['p2'] }) }), sqliteEnv(context).env, {})).status, 401);
});
test('the dashboard indexing block counts jobs by status, groups failures by reason and estimates an ETA from the session\'s completion throughput', async context => {
  const stamp = secondsAgo => `datetime('now', '-${secondsAgo} seconds')`;
  const { crew } = sqliteEnv(context, `
    INSERT INTO sessions(id,title,session_date,location) VALUES ('busy','Busy','2026-09-15','Mulki'), ('idle','Idle','2026-09-15','Mulki');
    INSERT INTO photos(id,session_id,object_key,preview_key,filename,content_type,indexing_status) VALUES
      ('c1','busy','o1','v1','1.jpg','image/jpeg','completed'), ('c2','busy','o2','v2','2.jpg','image/jpeg','completed'), ('c3','busy','o3','v3','3.jpg','image/jpeg','completed'), ('c4','busy','o4','v4','4.jpg','image/jpeg','completed'),
      ('q1','busy','o5','v5','5.jpg','image/jpeg','pending'), ('q2','busy','o6','v6','6.jpg','image/jpeg','pending'), ('r1','busy','o7','v7','7.jpg','image/jpeg','pending'),
      ('x1','busy','o8','v8','8.jpg','image/jpeg','failed'), ('x2','busy','o9','v9','9.jpg','image/jpeg','failed'), ('x3','busy','o10','v10','10.jpg','image/jpeg','failed'),
      ('i1','idle','o11','v11','11.jpg','image/jpeg','completed');
    INSERT INTO indexing_jobs(photo_id,job_id,status,error,updated_at) VALUES
      ('c1','j','completed',NULL,${stamp(300)}), ('c2','j','completed',NULL,${stamp(240)}), ('c3','j','completed',NULL,${stamp(200)}), ('c4','j','completed',NULL,${stamp(100)}),
      ('q1','j','queued',NULL,${stamp(10)}), ('q2','j','queued',NULL,${stamp(10)}), ('r1','j','processing',NULL,${stamp(5)}),
      ('x1','j','failed','Original photo is missing. Upload it again.',${stamp(50)}), ('x2','j','failed','Original photo is missing. Upload it again.',${stamp(50)}), ('x3','j','failed','Processing failed. Retry this photo.',${stamp(50)}),
      ('i1','j','completed',NULL,${stamp(1000)});
  `);
  const admin = await crew();
  const { sessions } = await (await admin('/api/admin/dashboard')).json();
  const busy = sessions.find(item => item.id === 'busy').indexing, idle = sessions.find(item => item.id === 'idle').indexing;
  // Completion gaps 60, 40, 100 s → median 60 s; 3 jobs remain → 180 s.
  assert.deepEqual(busy, { queued: 2, processing: 1, done: 4, failed: 3, etaSeconds: 180, failures: [{ reason: 'Original photo is missing. Upload it again.', count: 2 }, { reason: 'Processing failed. Retry this photo.', count: 1 }] });
  assert.deepEqual(idle, { queued: 0, processing: 0, done: 1, failed: 0, etaSeconds: null, failures: [] });
});
// ── Wave 3 · support: lookup, resend, grant ──────────────────────────────────
const SUPPORT_SEED = SESSION_SEED + `
  INSERT INTO searches(id,session_id,matched_photo_ids_json,colour_photo_ids_json,price_paise,currency,status,expires_at,paid_at) VALUES ('sr2','s1','["p-red","p-blue"]','["p-pastel"]',29900,'INR','paid','2026-09-15 10:45:00','2026-09-15 10:20:00');
  INSERT INTO match_hides(id,search_id,photo_id,similarity) VALUES ('h1','sr2','p-grey',0.4);
  INSERT INTO payments(id,search_id,cashfree_order_id,cashfree_payment_id,amount_paise,currency,status,paid_at,customer_phone) VALUES ('pay2','sr2','mj-pay2','555',29900,'INR','captured','2026-09-15 10:20:00','9876543210');
  INSERT INTO refunds(id,payment_id,cashfree_refund_id,amount_paise,status,reason) VALUES ('rf-a','pay2','1',10000,'SUCCESS','wrong surfer'), ('rf-b','pay2',NULL,5000,'FAILED','bank bounced');
  INSERT INTO notify_requests(id,search_id,session_id,phone) VALUES ('n1','sr1','s1','9876543210');
`;
test('support lookup finds a guest by phone, order or search id and answers with masked phones, counts, what they saw, payments with refunds and free unlocks', async context => {
  const { sql, crew } = sqliteEnv(context, SUPPORT_SEED);
  const admin = await crew();
  const lookup = query => admin(`/api/admin/lookup?${query}`);
  for (const bad of ['', 'phone=123', 'phone=9876543210&order=mj-pay2', 'nope=1']) assert.equal((await lookup(bad)).status, 400, bad);
  const byPhone = await lookup('phone=9876543210');
  assert.equal(byPhone.status, 200);
  const body = await byPhone.json();
  assert.deepEqual(body.searches.map(item => item.id).sort(), ['sr1', 'sr2'], 'the checkout phone finds the paid search, notify-me finds the other');
  const paid = body.searches.find(item => item.id === 'sr2');
  assert.deepEqual({ ...paid, photos: undefined, saw: undefined }, { id: 'sr2', sessionId: 's1', sessionTitle: 'Morning glass', createdAt: paid.createdAt, status: 'paid', matchedCount: 2, hiddenCount: 1, colourCount: 1, paidAt: '2026-09-15 10:20:00', expiresAt: '2026-09-15 10:45:00', galleryLinkExpiresAt: null, photos: undefined, saw: undefined });
  assert.deepEqual(Object.fromEntries(Object.entries(paid.photos).map(([kind, list]) => [kind, list.map(photo => photo.photoId)])), { matched: ['p-red', 'p-blue'], colour: ['p-pastel'], hidden: ['p-grey'] });
  assert.match(paid.photos.matched[0].thumbUrl, /\/api\/media\/p-red\?variant=thumb&token=/); assert.match(paid.photos.matched[1].thumbUrl, /variant=preview/, 'no thumb stored: the preview stands in');
  // `saw` is the flat strip the studio renders: matched, colour, then hidden (flagged), each `{ photoId, thumbUrl, hidden }`.
  assert.deepEqual(paid.saw.map(({ photoId, hidden, ...rest }) => [photoId, hidden, Object.keys(rest)]), [['p-red', false, ['thumbUrl']], ['p-blue', false, ['thumbUrl']], ['p-pastel', false, ['thumbUrl']], ['p-grey', true, ['thumbUrl']]]);
  assert.equal(paid.saw[0].thumbUrl, paid.photos.matched[0].thumbUrl); assert.match(paid.saw[3].thumbUrl, /\/api\/media\/p-grey\?variant=/, 'a hidden photo still has its thumb for the crew');
  const unpaid = body.searches.find(item => item.id === 'sr1');
  assert.deepEqual(unpaid.saw.map(item => [item.photoId, item.hidden]), [['p-red', false]], 'the unpaid search saw its one match, nothing hidden');
  assert.deepEqual(body.payments.map(({ createdAt, ...payment }) => ({ ...payment, refunds: payment.refunds.map(refund => refund.id) })), [{ id: 'pay2', searchId: 'sr2', orderId: 'mj-pay2', cfPaymentId: '555', amountPaise: 29900, status: 'captured', paidAt: '2026-09-15 10:20:00', phone: '98xxxxxx10', refundedPaise: 10000, refundStatus: 'SUCCESS', refunds: ['rf-a', 'rf-b'] }]);
  assert.deepEqual(body.notify.map(item => [item.searchId, item.notifiedAt]), [['sr1', null]]);
  assert.equal(JSON.stringify(body).includes('9876543210'), false, 'the phone is masked everywhere');
  assert.equal(JSON.stringify(body).includes('embedding'), false);
  assert.deepEqual((await (await lookup('order=mj-pay2')).json()).searches.map(item => item.id), ['sr2']);
  assert.deepEqual((await (await lookup('search=sr1')).json()).searches.map(item => item.id), ['sr1']);
  assert.deepEqual(await (await lookup('phone=9000000000')).json(), { searches: [], payments: [], notify: [] });
  assert.equal((await worker.fetch(request('/api/admin/lookup?phone=9876543210'), sqliteEnv(context).env, {})).status, 401);
  // Before migration 0015 the lookup still answers from what exists, flagged unmigrated.
  for (const table of ['match_hides', 'notify_requests', 'refunds', 'grants']) sql.exec(`DROP TABLE ${table}`);
  const early = await (await lookup('order=mj-pay2')).json();
  assert.equal(early.unmigrated, true); assert.equal(early.searches[0].hiddenCount, 0); assert.equal(early.payments[0].refundedPaise, 0); assert.deepEqual(early.notify, []);
});
test('resend mints a fresh 30-day link for a paid search only; a free unlock marks an unpaid search paid with a grants row and no rupees, then resend works too', async context => {
  const { sql, crew, api } = sqliteEnv(context, SUPPORT_SEED);
  const admin = await crew();
  const unpaid = await admin('/api/admin/searches/sr1/resend', { method: 'POST' });
  assert.equal(unpaid.status, 402); assert.equal((await admin('/api/admin/searches/nope/resend', { method: 'POST' })).status, 404);
  const resent = await admin('/api/admin/searches/sr2/resend', { method: 'POST', headers: { Origin: 'https://site.example' } });
  assert.equal(resent.status, 200);
  const { link, expiresAt } = await resent.json();
  assert.ok(Date.parse(expiresAt) - Date.now() > 29.9 * 86400_000);
  const opened = new URL(link);
  // The link is `?gallery=<searchId>.<token>` — parsed here exactly as app.js resumeGalleryFromLink() does (split on the first dot).
  const galleryParam = raw => { const dot = raw.indexOf('.'); return { searchId: raw.slice(0, dot), token: raw.slice(dot + 1) }; };
  const { searchId: linkedSearch, token: linkedToken } = galleryParam(opened.searchParams.get('gallery'));
  assert.equal(opened.origin, 'https://site.example'); assert.equal(linkedSearch, 'sr2'); assert.equal(opened.searchParams.has('token'), false, 'no separate token parameter');
  assert.match(linkedToken, /^[\w-]+\.[0-9a-f]{64}$/, 'the signed token, dot and all, follows the search id');
  assert.equal(sql.prepare("SELECT gallery_link_expires_at FROM searches WHERE id = 'sr2'").get().gallery_link_expires_at, expiresAt);
  // The token in the link opens the originals exactly like the guest's own gallery token.
  const access = await api(`/api/searches/sr2/access?token=${encodeURIComponent(linkedToken)}`);
  assert.equal(access.status, 200); assert.equal((await access.json()).photos.length, 3);
  // Grant: reason required; the search becomes paid without a payment, and stats count it as a grant, not an unlock.
  assert.equal((await admin('/api/admin/searches/sr1/grant', { method: 'POST', body: JSON.stringify({}) })).status, 400);
  assert.equal((await admin('/api/admin/searches/sr2/grant', { method: 'POST', body: JSON.stringify({ reason: 'x' }) })).status, 409, 'already unlocked');
  const granted = await admin('/api/admin/searches/sr1/grant', { method: 'POST', body: JSON.stringify({ reason: 'Paid in cash at the beach' }) });
  assert.equal(granted.status, 200);
  const grant = await granted.json();
  assert.equal(grant.ok, true); assert.match(grant.link, /\/\?gallery=sr1\.[\w-]+\.[0-9a-f]{64}$/); assert.ok(grant.expiresAt);
  assert.deepEqual({ ...sql.prepare("SELECT status, paid_at IS NOT NULL AS paid FROM searches WHERE id = 'sr1'").get() }, { status: 'paid', paid: 1 });
  assert.deepEqual(sql.prepare('SELECT search_id, reason FROM grants').all().map(row => ({ ...row })), [{ search_id: 'sr1', reason: 'Paid in cash at the beach' }]);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM payments WHERE search_id = 'sr1'").get().n, 0); assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'paid'").get().n, 0);
  const stats = await (await admin('/api/admin/stats')).json();
  assert.deepEqual(stats.sessions.map(item => [item.sessionId, item.unlocks, item.rupees, item.grants]).sort(), [['s1', 0, 299, 1], ['s2', 0, 0, 0]]);
  assert.equal(stats.totals.grants, 1);
  assert.equal((await admin('/api/admin/searches/sr1/resend', { method: 'POST' })).status, 200, 'a granted search can be re-sent');
  const seen = await (await admin('/api/admin/lookup?search=sr1')).json();
  assert.deepEqual(seen.payments.map(payment => [payment.status, payment.amountPaise, payment.reason]), [['granted', 0, 'Paid in cash at the beach']]);
  assert.equal((await api(`/api/searches/sr1/access?token=${encodeURIComponent(galleryParam(new URL(grant.link).searchParams.get('gallery')).token)}`)).status, 200);
  sql.exec('DROP TABLE grants');
  assert.equal((await admin('/api/admin/searches/sr2/grant', { method: 'POST', body: JSON.stringify({ reason: 'x' }) })).status, 409);
  sql.exec("UPDATE searches SET status = 'preview' WHERE id = 'sr2'");
  assert.equal((await admin('/api/admin/searches/sr2/grant', { method: 'POST', body: JSON.stringify({ reason: 'x' }) })).status, 503, 'before migration 0015');
  assert.equal(sql.prepare("SELECT status FROM searches WHERE id = 'sr2'").get().status, 'preview', 'the batch rolled back');
});
test('deleting a session takes its hides, notify-me requests, grants and refunds with it through the existing route', async context => {
  const { sql, crew } = sqliteEnv(context, SUPPORT_SEED + "INSERT INTO grants(id,search_id,reason) VALUES ('g1','sr1','vip');");
  const admin = await crew();
  assert.deepEqual(['match_hides', 'notify_requests', 'grants', 'refunds', 'payments', 'searches'].map(table => sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n), [1, 1, 1, 2, 1, 2]);
  assert.equal((await admin('/api/admin/sessions/s1', { method: 'DELETE' })).status, 200);
  assert.deepEqual(['match_hides', 'notify_requests', 'grants', 'refunds', 'payments', 'searches', 'photos'].map(table => sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n), [0, 0, 0, 0, 0, 0, 1], 'only the other session\'s photo remains');
});
// ── Wave 3 · Cashfree refunds and settlements (mocked Cashfree, real SQLite ledger) ──
const cashfreeCreds = { CASHFREE_APP_ID: 'test-app', CASHFREE_SECRET_KEY: 'test-secret' };
test('a refund goes to Cashfree Create Refund with our idempotent id and a rupee amount, is capped at what is left, and its ledger row follows the answer and the REFUND_STATUS_WEBHOOK', async context => {
  const { sql, crew, env, api } = sqliteEnv(context, SUPPORT_SEED);
  Object.assign(env, cashfreeCreds);
  sql.exec('DELETE FROM refunds');
  const admin = await crew();
  const refund = (paymentId, body) => admin(`/api/admin/payments/${paymentId}/refund`, { method: 'POST', body: JSON.stringify(body) });
  const calls = [];
  const cashfree = context.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
    return Response.json({ cf_refund_id: '11325632', cf_payment_id: '555', refund_id: calls.at(-1).body.refund_id, order_id: 'mj-pay2', refund_amount: calls.at(-1).body.refund_amount, refund_status: 'PENDING', refund_speed: { requested: 'STANDARD', accepted: 'STANDARD' } });
  });
  assert.equal((await refund('pay2', { amountPaise: 100 })).status, 400, 'a reason is required');
  assert.equal((await refund('nope', { reason: 'x' })).status, 404);
  assert.equal(cashfree.mock.callCount(), 0);
  const partial = await refund('pay2', { amountPaise: 10000, reason: 'Wrong surfer in two photos' });
  assert.equal(partial.status, 200);
  const { ok, refund: row } = await partial.json();
  assert.equal(ok, true); assert.match(row.id, /^rf-[0-9a-f-]{36}$/); assert.equal(row.paymentId, 'pay2'); assert.equal(row.cashfreeRefundId, '11325632'); assert.equal(row.amountPaise, 10000); assert.equal(row.status, 'PENDING'); assert.equal(row.reason, 'Wrong surfer in two photos');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://sandbox.cashfree.com/pg/orders/mj-pay2/refunds');
  assert.equal(calls[0].headers['x-api-version'], '2025-01-01'); assert.equal(calls[0].headers['x-client-id'], 'test-app'); assert.equal(calls[0].headers['x-client-secret'], 'test-secret');
  assert.deepEqual(calls[0].body, { refund_id: row.id, refund_amount: 100, refund_note: 'Wrong surfer in two photos', refund_speed: 'STANDARD' });
  // The cap: 199.00 is left; asking for more is refused before Cashfree is called; the default is the remainder.
  const tooMuch = await refund('pay2', { amountPaise: 20000, reason: 'x' });
  assert.equal(tooMuch.status, 400); assert.match((await tooMuch.json()).error, /₹199\.00/); assert.equal(calls.length, 1);
  for (const amount of [0, -5, 1.5, 'all']) assert.equal((await refund('pay2', { amountPaise: amount, reason: 'x' })).status, 400, String(amount));
  const rest = await (await refund('pay2', { reason: 'Refund the rest' })).json();
  assert.equal(rest.refund.amountPaise, 19900); assert.equal(calls[1].body.refund_amount, 199);
  const full = await refund('pay2', { reason: 'again' });
  assert.equal(full.status, 400); assert.match((await full.json()).error, /already been refunded in full/);
  // Cashfree refusing → 502 and the row is FAILED (it no longer counts against the cap); a network failure is the same.
  sql.exec("DELETE FROM refunds WHERE amount_paise = 19900");
  cashfree.mock.mockImplementation(async () => Response.json({ code: 'refund_amount_invalid', type: 'invalid_request_error' }, { status: 400 }));
  const refused = await refund('pay2', { amountPaise: 500, reason: 'x' });
  assert.equal(refused.status, 502); assert.deepEqual(sql.prepare('SELECT status FROM refunds ORDER BY created_at, rowid').all().map(item => item.status), ['PENDING', 'FAILED']);
  cashfree.mock.mockImplementation(async () => { throw new TypeError('fetch failed'); });
  assert.equal((await refund('pay2', { amountPaise: 500, reason: 'x' })).status, 502);
  // The webhook: our row follows refund_status by refund_id (numeric ids arrive as numbers), replays are harmless,
  // and a refund made in the Cashfree dashboard is added to the ledger by order id.
  const hook = payload => { const ts = String(Date.now()); return api('/api/payment/webhook', { method: 'POST', headers: { 'x-webhook-signature': createHmac('sha256', 'test-secret').update(`${ts}${payload}`).digest('base64'), 'x-webhook-timestamp': ts }, body: payload }); };
  const refundEvent = (refundId, status, extra = {}) => JSON.stringify({ type: 'REFUND_STATUS_WEBHOOK', event_time: new Date().toISOString(), data: { refund: { cf_refund_id: 11325632, cf_payment_id: 555, refund_id: refundId, order_id: 'mj-pay2', refund_amount: 100, refund_currency: 'INR', refund_status: status, refund_arn: '205907014017', requested_speed: 'STANDARD', processed_speed: 'STANDARD', ...extra } } });
  assert.equal((await hook(refundEvent(row.id, 'SUCCESS'))).status, 200);
  assert.equal(sql.prepare('SELECT status FROM refunds WHERE id = ?').get(row.id).status, 'SUCCESS');
  assert.equal((await hook(refundEvent(row.id, 'SUCCESS'))).status, 200); assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM refunds').get().n, 3, 'a replay adds nothing');
  assert.equal((await hook(refundEvent(row.id, 'MAYBE'))).status, 200); assert.equal(sql.prepare('SELECT status FROM refunds WHERE id = ?').get(row.id).status, 'SUCCESS', 'an unknown status is ignored');
  assert.equal((await hook(refundEvent('dash_1', 'SUCCESS', { refund_amount: 50 }))).status, 200);
  assert.deepEqual({ ...sql.prepare("SELECT payment_id, amount_paise, status, cashfree_refund_id FROM refunds WHERE id = 'dash_1'").get() }, { payment_id: 'pay2', amount_paise: 5000, status: 'SUCCESS', cashfree_refund_id: '11325632' });
  assert.equal((await hook(refundEvent('dash_2', 'SUCCESS', { order_id: 'mj-unknown' }))).status, 200); assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM refunds WHERE id = 'dash_2'").get().n, 0, 'an order we never created is not a payment of ours');
  // Guards: unconfirmed payment, missing credentials, missing migration, sign-in.
  sql.exec("INSERT INTO payments(id,search_id,cashfree_order_id,amount_paise,currency,status) VALUES ('created','sr1','mj-created',100,'INR','created')");
  assert.equal((await refund('created', { reason: 'x' })).status, 409);
  assert.equal((await worker.fetch(request('/api/admin/payments/pay2/refund', { method: 'POST', body: JSON.stringify({ reason: 'x' }) }), env, {})).status, 401);
  delete env.CASHFREE_SECRET_KEY;
  assert.equal((await refund('pay2', { reason: 'x' })).status, 503);
  Object.assign(env, cashfreeCreds); sql.exec('DROP TABLE refunds');
  assert.equal((await refund('pay2', { reason: 'x' })).status, 503);
});
test('settlements come from Cashfree\'s POST /pg/settlements and settlement recon for an IST date range, mapped to the studio shape with the confirmed payments no settlement names yet', async context => {
  const { sql, crew, env } = sqliteEnv(context, SUPPORT_SEED);
  Object.assign(env, cashfreeCreds);
  sql.exec("INSERT INTO payments(id,search_id,cashfree_order_id,amount_paise,currency,status,paid_at) VALUES ('pay-late','sr1','mj-late',29900,'INR','verified','2026-09-16 09:00:00'), ('pay-out','sr1','mj-out',29900,'INR','captured','2026-08-01 09:00:00'), ('pay-open','sr1','mj-open',29900,'INR','created','2026-09-15 12:00:00')");
  const admin = await crew();
  const calls = [];
  const cashfree = context.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url: String(url), method: options.method, headers: options.headers, body });
    if (String(url).endsWith('/pg/settlements')) {
      return body.pagination.cursor === null
        ? Response.json({ cursor: 'page-2', data: [{ cf_settlement_id: 12345, entity: 'settlement', amount: 299, amount_settled: 292.96, status: 'SUCCESS', utr: 'AXIS1234567890', type: 'STANDARD', payment_from: '2026-09-15T00:00:00+05:30', payment_till: '2026-09-15T23:59:59+05:30', settlement_time: '2026-09-16T11:00:00+05:30' }] })
        : Response.json({ cursor: null, data: [{ cf_settlement_id: 12346, amount: 100, amount_settled: 98, status: 'INITIATED', utr: null, settlement_type: 'INSTANT', payment_time: '2026-09-16T09:00:00+05:30' }] });
    }
    return Response.json({ cursor: null, data: [{ event_details: { event_type: 'PAYMENT', sale_type: 'CREDIT' }, order_details: { order_id: 'mj-pay2' }, settlement_details: { cf_settlement_id: 12345 } }, { event_details: { event_type: 'REFUND', sale_type: 'DEBIT' }, order_details: { order_id: 'mj-late' } }] });
  });
  for (const bad of ['from=2026-09-40', 'from=2026-09-16&to=2026-09-15', 'to=yesterday']) assert.equal((await admin(`/api/admin/settlements?${bad}`)).status, 400, bad);
  assert.equal(cashfree.mock.callCount(), 0);
  const result = await admin('/api/admin/settlements?from=2026-09-15&to=2026-09-16');
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.deepEqual(body, {
    from: '2026-09-15', to: '2026-09-16',
    settlements: [
      { id: '12345', utr: 'AXIS1234567890', amountPaise: 29296, grossPaise: 29900, settledAt: '2026-09-16T11:00:00+05:30', from: '2026-09-15T00:00:00+05:30', to: '2026-09-15T23:59:59+05:30', status: 'SUCCESS', type: 'STANDARD' },
      { id: '12346', utr: null, amountPaise: 9800, grossPaise: 10000, settledAt: null, from: '2026-09-16T09:00:00+05:30', to: null, status: 'INITIATED', type: 'INSTANT' },
    ],
    unreconciled: ['pay-late'],   // confirmed in range, no PAYMENT recon event yet; pay2 is settled, pay-out is outside the range, pay-open was never paid
    reconUnavailable: false,
  });
  assert.deepEqual(calls.map(call => [call.method, call.url.replace('https://sandbox.cashfree.com', ''), call.body.pagination, call.body.filters]), [
    ['POST', '/pg/settlements', { limit: 100, cursor: null }, { start_date: '2026-09-15T00:00:00+05:30', end_date: '2026-09-16T23:59:59+05:30' }],
    ['POST', '/pg/settlements', { limit: 100, cursor: 'page-2' }, { start_date: '2026-09-15T00:00:00+05:30', end_date: '2026-09-16T23:59:59+05:30' }],
    ['POST', '/pg/settlement/recon', { limit: 1000, cursor: null }, { start_date: '2026-09-15T00:00:00+05:30', end_date: '2026-09-23T23:59:59+05:30' }],
  ], 'a POST body with pagination + filters, the cursor followed, the recon window a week past `to`');
  assert.ok(calls.every(call => call.headers['x-api-version'] === '2025-01-01'));
  // Defaults: the last 30 IST days. Recon failing degrades to an empty unreconciled list, flagged.
  calls.length = 0;
  cashfree.mock.mockImplementation(async url => String(url).endsWith('/pg/settlements') ? Response.json([]) : new Response('nope', { status: 403 }));
  const fallback = await (await admin('/api/admin/settlements')).json();
  assert.equal(Date.parse(`${fallback.to}T00:00:00Z`) - Date.parse(`${fallback.from}T00:00:00Z`), 30 * 86400_000);
  assert.deepEqual(fallback.settlements, []); assert.deepEqual(fallback.unreconciled, []); assert.equal(fallback.reconUnavailable, true);
  cashfree.mock.mockImplementation(async () => new Response('down', { status: 503 }));
  assert.equal((await admin('/api/admin/settlements')).status, 502);
  delete env.CASHFREE_APP_ID;
  assert.equal((await admin('/api/admin/settlements')).status, 503);
});
test('checkout keeps the guest\'s phone on the payment once migration 0015 exists, and never before', async context => {
  const token = signed({ scope: 'search', searchId: 'sr1', exp: Date.now() + 45 * 60_000 });
  context.mock.method(globalThis, 'fetch', async () => Response.json({ order_id: 'mj-new', payment_session_id: 'ps' }));
  const checkout = harness => harness.post('/api/checkout', { searchId: 'sr1', token, phone: '9876543210' });
  assert.equal((await checkout(sqliteEnv(context, SESSION_SEED))).status, 503, 'no Cashfree credentials: nothing is stored');
  const migrated = sqliteEnv(context, SESSION_SEED); Object.assign(migrated.env, cashfreeCreds);
  assert.equal((await checkout(migrated)).status, 200);
  assert.equal(migrated.sql.prepare('SELECT customer_phone FROM payments').get().customer_phone, '9876543210');
  const early = sqliteEnv(context, SESSION_SEED); Object.assign(early.env, cashfreeCreds); early.sql.exec('ALTER TABLE payments DROP COLUMN customer_phone');
  assert.equal((await checkout(early)).status, 200, 'before the column exists the payment is still recorded');
  assert.equal(early.sql.prepare('SELECT COUNT(*) AS n FROM payments').get().n, 1);
});
// ── Wave 3 · edge caching of previews, and the warm-ping cron ────────────────
test('previews and thumbs are public-cacheable for at most an hour and never past their own token; originals stay private', async context => {
  const match = await getMatch(context);
  const { env } = galleryEnv({ paid: true, thumbColumn: true });
  const body = await (await worker.fetch(request(`/api/searches/${match.searchId}/access?token=${encodeURIComponent(match.token)}`), env, {})).json();
  const fresh = await worker.fetch(new Request(body.photos[0].thumbUrl), env, {});
  assert.equal(fresh.status, 200);
  const maxAge = Number(fresh.headers.get('cache-control').match(/^public, max-age=(\d+)$/)[1]);
  assert.ok(maxAge > 2600 && maxAge <= 2700, `a 45-minute token caps the cache at its own life (${maxAge} s)`);
  const original = await worker.fetch(new Request(body.photos[0].url), env, {});
  assert.equal(original.headers.get('cache-control'), 'private, max-age=600');
  const download = await worker.fetch(new Request(body.photos[0].downloadUrl), env, {});
  assert.equal(download.headers.get('cache-control'), 'private, max-age=600');
  // A token minted with a long life is still capped at an hour; one about to expire caps the cache with it.
  const media = (exp, variant = 'preview') => new Request(`https://example.com/api/media/photo-1?variant=${variant}&token=${encodeURIComponent(signed({ scope: 'media', photoId: 'photo-1', variant, exp }))}`);
  assert.equal((await worker.fetch(media(Date.now() + 86400_000), env, {})).headers.get('cache-control'), 'public, max-age=3600');
  const short = Number((await worker.fetch(media(Date.now() + 30_000), env, {})).headers.get('cache-control').match(/max-age=(\d+)/)[1]);
  assert.ok(short > 0 && short <= 30, `${short} s`);
  assert.equal((await worker.fetch(media(Date.now() - 1000), env, {})).status, 401, 'an expired token is refused, never served');
});
test('the scheduled handler runs the deep health check, logs its result and sweeps finished quota windows, and wrangler.jsonc wires the cron and three-way queue concurrency', async context => {
  const { env, calls } = healthEnv();
  const runs = [];
  env.DB = { prepare(sql) { calls.sql.push(sql); return { async first() { return { 1: 1 }; }, async all() {
    if (sql.startsWith('PRAGMA')) return { results: [{ name: 'id' }, { name: 'width' }, { name: 'break_name' }, { name: 'colour_photo_ids_json' }] };
    return { results: [...SUPPORT_TABLES, 'admin_sessions', 'rate_limits', 'events'].map(name => ({ name })) };
  }, async run() { runs.push(sql); return {}; } }; } };
  const pings = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => { pings.push([url, options.method, new Headers(options.headers || {}).get('x-face-key')]); return new Response(null, { status: 405 }); });
  const logs = context.mock.method(console, 'log', () => {});
  const waited = []; const ctx = { waitUntil(promise) { waited.push(promise); } };
  const started = Date.now();
  await worker.scheduled({ cron: '*/10 * * * *', scheduledTime: started }, { ...env, FACE_API_KEY: 'shared-secret' }, ctx);
  assert.ok(Date.now() - started < 3000);
  assert.deepEqual(pings, [['https://face.example/extract', 'HEAD', 'shared-secret']], 'one warm ping, with the shared secret');
  assert.equal(logs.mock.callCount(), 1);
  const logged = JSON.parse(logs.mock.calls[0].arguments[1]);
  assert.equal(logs.mock.calls[0].arguments[0], 'scheduled health check');
  assert.equal(logged.cron, '*/10 * * * *'); assert.equal(logged.ok, true); assert.deepEqual(logged.checks, { db: 'ok', r2: 'ok', face: 'ok' }); assert.equal(logged.migrations.support, true);
  assert.ok(runs.some(sql => sql.includes('DELETE FROM rate_limits')), 'finished quota windows are swept'); assert.equal(waited.length, 1);
  const config = JSON.parse((await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8')).replace(/^\s*\/\/.*$/gm, ''));
  assert.deepEqual(config.triggers, { crons: ['*/10 * * * *'] });
  assert.equal(config.queues.consumers[0].max_concurrency, 3);
});
