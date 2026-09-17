import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
const source = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
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
  const env = { ...secrets, DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } };
  assert.equal((await worker.fetch(send({ title: 'Morning' }), env, {})).status, 404);
});
test('modified admin tokens cannot authenticate', async () => {
  const token = await login();
  for (const invalid of [`${token}.extra`, `${token.slice(0, -1)}x`]) {
    const result = await worker.fetch(request('/api/admin/dashboard', { headers: { Authorization: `Bearer ${invalid}` } }), secrets, {});
    assert.equal(result.status, 401);
  }
});
function matchingEnv() {
  const searches = []; const mediaReads = [];
  const env = { ...secrets, FACE_API_URL: 'https://face.example/extract', MATCH_THRESHOLD: '0.62',
    DB: { prepare(sql) { return { values: [], bind(...values) { this.values = values; return this; },
      async first() {
        if (sql.includes("FROM sessions WHERE id")) return { id: 'session-1', title: 'Morning surf', session_date: '2026-09-15', location: 'Mulki', price_paise: 29900, currency: 'INR' };
        if (sql.includes('COUNT(*) as total')) return { total: 3, completed: 3, pending: 0 };
        if (sql.includes('object_key, preview_key')) return { object_key: 'original/private.jpg', preview_key: 'preview/watermark.jpg', content_type: 'image/jpeg' };
        throw new Error(`Unexpected query: ${sql}`);
      },
      async all() { return { results: [{ photo_id: 'photo-1', embedding_json: '[1,0]' }, { photo_id: 'photo-1', embedding_json: '[0.9,0.1]' }, { photo_id: 'photo-2', embedding_json: '[0,1]' }] }; },
      async run() { assert.match(sql, /INSERT INTO searches/); searches.push(this.values); return {}; }
    }; } },
    PHOTOS: { async get(key) { mediaReads.push(key); return { body: 'watermarked image bytes', httpMetadata: { contentType: 'image/jpeg' } }; } }
  };
  return { env, searches, mediaReads };
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
  }; } };
}
test('checkout requires Cashfree credentials before creating an order', async context => {
  const match = await getMatch(context);
  const env = { ...secrets, DB: checkoutDb(match) };
  const result = await worker.fetch(jsonRequest('/api/checkout', { searchId: match.searchId, token: match.token, phone: '9876543210' }), env, {});
  assert.equal(result.status, 503);
});
test('checkout creates a Cashfree order in rupees and records the payment', async context => {
  const match = await getMatch(context);
  const inserts = [];
  const env = { ...secrets, CASHFREE_APP_ID: 'test-app', CASHFREE_SECRET_KEY: 'test-secret', ALLOWED_ORIGIN: 'https://site.example',
    DB: checkoutDb(match, { run: (sql, values) => { assert.match(sql, /INSERT INTO payments/); inserts.push(values); } }) };
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
test('a validly signed webhook marks the payment captured and the search paid', async () => {
  const secret = 'test-secret';
  const timestamp = String(Date.now());
  const payload = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: 'mj-test-order' }, payment: { cf_payment_id: 555 } } });
  const signature = createHmac('sha256', secret).update(`${timestamp}${payload}`).digest('base64');
  const updates = [];
  const env = { CASHFREE_SECRET_KEY: secret, DB: { prepare(sql) { return { bind(...values) { this.values = values; return this; },
    async run() { updates.push(sql); return {}; },
    async first() { if (sql.includes('SELECT search_id FROM payments')) return { search_id: 'search-1' }; throw new Error(`Unexpected query: ${sql}`); },
  }; } } };
  const result = await worker.fetch(request('/api/payment/webhook', { method: 'POST', headers: { 'x-webhook-signature': signature, 'x-webhook-timestamp': timestamp }, body: payload }), env, {});
  assert.equal(result.status, 200); assert.equal((await result.json()).received, true);
  assert.equal(updates.some(sql => sql.includes('UPDATE payments')), true);
  assert.equal(updates.some(sql => sql.includes("UPDATE searches SET status = 'paid'")), true);
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
function uploadEnv({ status = 'published', existing = [{ id: 'photo-old', filename: 'IMG_0412.jpg', object_key: 'original/old', preview_key: 'preview/old' }] } = {}) {
  const puts = []; const deletes = []; const inserts = []; const deletedRows = []; const queued = [];
  const statement = sql => ({ values: [], bind(...values) { this.values = values; return this; },
    async first() {
      if (sql.includes('FROM sessions WHERE id')) return { id: 'session-1', status };
      throw new Error(`Unexpected query: ${sql}`);
    },
    async all() {
      if (sql.includes('COLLATE NOCASE')) return { results: existing.filter(photo => photo.filename.toLowerCase() === String(this.values[1]).toLowerCase()) };
      if (sql.includes('SELECT filename FROM photos')) return { results: existing.map(photo => ({ filename: photo.filename })) };
      throw new Error(`Unexpected query: ${sql}`);
    },
    async run() {
      if (sql.includes('INSERT INTO photos')) inserts.push(this.values);
      if (sql.includes('DELETE FROM')) deletedRows.push(sql);
      return { meta: { changes: 1 } };
    },
    sql,
  });
  const env = { ...secrets, INDEX_QUEUE: { async send(message) { queued.push(message); } },
    DB: { prepare: statement, async batch(statements) { statements.forEach(item => deletedRows.push(item.sql)); return []; } },
    PHOTOS: { async put(key) { puts.push(key); }, async delete(key) { deletes.push(key); } } };
  return { env, puts, deletes, inserts, deletedRows, queued };
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
function galleryEnv({ paid = true, thumbColumn = false } = {}) {
  const runs = []; const reads = [];
  const search = { id: 'search-1', session_id: 'session-1', matched_photo_ids_json: '["photo-1","photo-2"]', status: paid ? 'paid' : 'preview', expires_at: '2999-01-01 00:00:00' };
  const statement = sql => ({ values: [], bind(...values) { this.values = values; return this; },
    async first() {
      if (sql.includes('FROM searches WHERE id')) return sql.includes("AND status = 'paid'") && !paid ? null : search; // /access needs paid; /previews accepts a live preview
      if (sql.includes('FROM sessions WHERE id')) return { title: 'Morning surf', date: '2026-09-15', location: 'Mulki' };
      if (sql.includes('object_key, preview_key')) return { object_key: 'original/1.jpg', preview_key: 'preview/1.jpg', content_type: 'image/jpeg', filename: 'IMG 0412.jpg', thumb_key: thumbColumn ? 'thumb/1.jpg' : undefined };
      if (sql.includes('SELECT id, session_id, thumb_key FROM photos')) return { id: 'photo-1', session_id: 'session-1', thumb_key: null };
      throw new Error(`Unexpected query: ${sql}`);
    },
    async all() {
      if (sql.startsWith('PRAGMA')) return { results: thumbColumn ? [{ name: 'id' }, { name: 'thumb_key' }] : [{ name: 'id' }] };
      if (sql.includes('FROM photos WHERE session_id')) return { results: [{ id: 'photo-1', thumb_key: thumbColumn ? 'thumb/1.jpg' : undefined }, { id: 'photo-2', thumb_key: null }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    async run() { runs.push({ sql, values: this.values }); return { meta: { changes: 1 } }; },
  });
  const env = { ...secrets, DB: { prepare: statement }, PHOTOS: { async get(key) { reads.push(key); return { body: `bytes of ${key}`, httpMetadata: { contentType: 'image/jpeg' } }; }, async put(key) { runs.push({ put: key }); } } };
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
  const env = { ...secrets, INDEX_QUEUE: { async send() {} }, DB: { prepare(sql) { seen.push(sql); return { bind() { return this; }, async first() { return { id: 'session-1' }; }, async all() { return { results: [] }; }, async run() { return { meta: { changes: 1 } }; } }; } } };
  const only = await worker.fetch(request('/api/admin/sessions/session-1/reindex?onlyFailed=1', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }), env, {});
  assert.equal(only.status, 202);
  assert.ok(seen.some(sql => sql.includes("indexing_status = 'failed'")));
  seen.length = 0;
  await worker.fetch(request('/api/admin/sessions/session-1/reindex', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }), env, {});
  assert.equal(seen.some(sql => sql.includes("indexing_status = 'failed'")), false);
});
test('crew sign-in is throttled per IP after repeated failures, and a success clears the counter', async () => {
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
test('landing-page covers are only ever the photo the crew explicitly chose', async () => {
  const token = await login();
  const runs = [];
  const env = (hasColumn, coverId) => ({ ...secrets, DB: { prepare(sql) { return { values: [], bind(...values) { this.values = values; return this; },
    async all() {
      if (sql.startsWith('PRAGMA')) return { results: hasColumn ? [{ name: 'id' }, { name: 'cover_photo_id' }] : [{ name: 'id' }] };
      if (sql.includes('FROM sessions WHERE status')) { assert.equal(sql.includes('cover_photo_id'), hasColumn); return { results: [{ id: 'session-1', title: 'Morning', session_date: '2026-09-15', location: 'Mulki', price_paise: 70000, currency: 'INR', ...(hasColumn ? { cover_photo_id: coverId } : {}) }] }; }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async first() {
      if (sql.includes('FROM sessions WHERE id')) return { id: 'session-1' };
      if (sql.includes('FROM photos WHERE id = ? AND session_id')) return this.values[0] === 'photo-1' ? { id: 'photo-1' } : null;
      throw new Error(`Unexpected query: ${sql}`);
    },
    async run() { runs.push({ sql, values: this.values }); return { meta: { changes: 1 } }; },
  }; } } });
  // No chosen cover (or no column yet) → no coverUrl, even though the session has photos.
  for (const candidate of [env(false, null), env(true, null)]) {
    const listed = await (await worker.fetch(request('/api/sessions'), candidate, {})).json();
    assert.equal(listed.sessions[0].coverUrl, null);
  }
  const chosen = await (await worker.fetch(request('/api/sessions'), env(true, 'photo-1'), {})).json();
  assert.match(chosen.sessions[0].coverUrl, /\/api\/media\/photo-1\?variant=preview/);
  const put = (body, candidate) => worker.fetch(request('/api/admin/sessions/session-1', { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }), candidate, {});
  assert.equal((await put({ coverPhotoId: 'photo-1' }, env(false))).status, 503);
  assert.equal((await put({ coverPhotoId: 'photo-from-another-session' }, env(true))).status, 404);
  assert.equal((await put({ coverPhotoId: 'photo-1' }, env(true))).status, 200);
  assert.ok(runs.some(entry => entry.sql.includes('UPDATE sessions SET cover_photo_id') && entry.values[0] === 'photo-1'));
  assert.equal((await put({ coverPhotoId: null }, env(true))).status, 200);
});
function healthEnv(overrides = {}) {
  const calls = { sql: [], heads: [] };
  const env = { ALLOWED_ORIGIN: 'https://site.example', FACE_API_URL: 'https://face.example/extract',
    DB: { prepare(sql) { calls.sql.push(sql); return { async first() { return { 1: 1 }; } }; } },
    PHOTOS: { async head(key) { calls.heads.push(key); return null; } },
    ...overrides };
  return { env, calls };
}
test('health check is public, uncached and only probes the face service on demand', async context => {
  const { env, calls } = healthEnv();
  const fetchMock = context.mock.method(globalThis, 'fetch', async () => { throw new Error('the face service must not be contacted without ?deep=1'); });
  const result = await worker.fetch(request('/api/health', { headers: { Origin: 'https://site.example' } }), env, {});
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('access-control-allow-origin'), 'https://site.example');
  const body = await result.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.checks, { db: 'ok', r2: 'ok', face: 'skipped' });
  assert.equal(new Date(body.time).toISOString(), body.time);
  assert.deepEqual(calls.sql, ['SELECT 1']); assert.deepEqual(calls.heads, ['__health-probe']);
  assert.equal(fetchMock.mock.callCount(), 0);
});
test('health check reports a database failure without masking storage or leaking the error', async () => {
  const { env } = healthEnv({ DB: { prepare() { throw new Error('D1_ERROR: internal detail that must stay private'); } } });
  const result = await worker.fetch(request('/api/health'), env, {});
  assert.equal(result.status, 503);
  const body = await result.json();
  assert.equal(body.ok, false);
  assert.deepEqual(body.checks, { db: 'error', r2: 'ok', face: 'skipped' });
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
  const reads = []; const heads = [];
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
  });
  const PHOTOS = {
    async get(key) { reads.push(key); const text = objects[key]; return text === undefined ? null : { body: bodies === 'stream' ? new Response(text).body : text, httpMetadata: { contentType: 'image/jpeg' } }; },
  };
  if (withHead) PHOTOS.head = async key => { heads.push(key); return { size: new TextEncoder().encode(objects[key]).length }; };
  return { env: { ...secrets, DB: { prepare: statement }, PHOTOS }, reads, heads, objects };
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
  const { env, reads, heads, objects } = zipEnv();
  const result = await worker.fetch(request(`/api/searches/${match.searchId}/download?token=${encodeURIComponent(match.token)}`), env, {});
  assert.equal(result.status, 200);
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
