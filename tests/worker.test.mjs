import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const request = (path, options) => new Request(`https://example.com${path}`, options);
test('all payment endpoints are on hold without touching payment providers', async () => {
  for (const path of ['/api/checkout', '/api/payment/verify', '/api/payment/webhook']) {
    const response = await worker.fetch(request(path, { method: 'POST' }), {}, {});
    assert.equal(response.status, 503); assert.match((await response.json()).error, /on hold/);
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
test('selfie matching rejects unsupported files', async () => {
  const response = await worker.fetch(request('/api/match', { method: 'POST', body: selfieForm(true, 'text/html') }), {}, {});
  assert.equal(response.status, 413);
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
    return Response.json([{ embedding: [1, 0] }]);
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
  context.mock.method(globalThis, 'fetch', async () => Response.json([{ embedding: [1, 0] }, { embedding: [0, 1] }]));
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
