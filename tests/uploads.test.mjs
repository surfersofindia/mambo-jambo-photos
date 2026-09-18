// W4-A · direct-to-R2 uploads, WebP previews and the regenerate routes, against the Worker's own code
// with mock `env` objects (D1 and R2 doubles). Nothing here touches the network or the deployed Worker:
// `presignS3Url` is checked against AWS's own published example, and every route is driven through
// `worker.fetch`. The sibling upload tests in tests/worker.test.mjs (streaming/multipart) stay there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
const { default: worker, presignS3Url, previewFormat } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

// FixedLengthStream is a Workers runtime global (the streaming upload path pumps through it); Node gets a pass-through.
globalThis.FixedLengthStream ??= class { constructor() { const stream = new TransformStream(); this.writable = stream.writable; this.readable = stream.readable; } };
const request = (path, options) => new Request(`https://example.com${path}`, options);
const secrets = { ADMIN_PASSWORD: 'local-test-password', SESSION_SECRET: 'local-test-signing-key-never-used-in-production' };
const R2_SECRETS = { R2_ACCOUNT_ID: 'acct123', R2_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE', R2_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
async function login() {
  const result = await worker.fetch(request('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: secrets.ADMIN_PASSWORD }) }), secrets, {});
  assert.equal(result.status, 200);
  return (await result.json()).token;
}
// Tokens issued above have no admin_sessions row (that env has no DB), so every env below answers the
// per-request session lookup (migration 0011) with a live row.
const liveSession = () => ({ revoked_at: null, expires_at: '2999-01-01T00:00:00.000Z', last_seen_at: new Date().toISOString() });
function adminAware(db) {
  return { ...db, prepare(sql) {
    if (sql.includes('admin_sessions')) return { bind() { return this; }, async first() { return liveSession(); }, async run() { return { meta: { changes: 1 } }; } };
    return db.prepare(sql);
  } };
}

// Byte fixtures: the smallest headers that identify a format and carry a pixel size.
const JPEG = extra => Uint8Array.from([0xFF, 0xD8, ...extra]);
const le32 = value => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
const be16 = value => [(value >> 8) & 255, value & 255];
const WEBP = (payload = [0x2F, ...le32((600 - 1) | ((400 - 1) << 14)), 0]) => Uint8Array.from([0x52, 0x49, 0x46, 0x46, ...le32(payload.length + 12), 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4C, ...le32(payload.length), ...payload]);
const segment = (marker, payload) => [0xFF, marker, ...be16(payload.length + 2), ...payload];
const sof = (width, height) => segment(0xC0, [8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
const bigJpeg = (width = 6000, height = 4000) => JPEG(sof(width, height));
// The `complete` body: [uint32 preview length LE][preview][thumb].
function framedSmall(preview, thumb = new Uint8Array(0)) {
  const length = new Uint8Array(4); new DataView(length.buffer).setUint32(0, preview.length, true);
  return new Blob([length, preview, thumb]);
}

/**
 * A D1 + R2 double for the upload routes. `objects` is the bucket (key → { body, contentType });
 * `rows` collects every INSERT/UPDATE the routes run, `queued` the indexing jobs.
 * `photoColumns` decides which migrations this database pretends to have.
 */
function uploadEnv({ status = 'draft', session = { id: 'session-1' }, existing = [], photos = {}, photoColumns = ['id', 'width', 'height', 'thumb_key'], objects = new Map(), direct = true } = {}) {
  const inserts = []; const updates = []; const queued = []; const deletes = []; const puts = []; const heads = []; const ranges = [];
  const statement = sql => ({ values: [], sql, bind(...values) { this.values = values; return this; },
    async first() {
      if (sql.includes('FROM sessions WHERE id')) return session ? { ...session, status } : null;
      if (sql.includes('FROM photos WHERE id')) return photos[this.values[0]] || null;
      throw new Error(`Unexpected query: ${sql}`);
    },
    async all() {
      if (sql.startsWith('PRAGMA table_info(photos)')) return { results: photoColumns.map(name => ({ name })) };
      if (sql.startsWith('PRAGMA')) return { results: [{ name: 'id' }] };
      if (sql.includes('COLLATE NOCASE')) return { results: existing.filter(photo => photo.filename.toLowerCase() === String(this.values[1]).toLowerCase()) };
      if (sql.includes('SELECT filename FROM photos')) return { results: existing.map(photo => ({ filename: photo.filename })) };
      throw new Error(`Unexpected query: ${sql}`);
    },
    async run() {
      if (sql.includes('INSERT INTO photos')) inserts.push({ sql, values: this.values });
      else if (sql.includes('UPDATE photos') || sql.includes('INSERT INTO indexing_jobs')) updates.push({ sql, values: this.values });
      return { meta: { changes: 1 } };
    },
  });
  const env = { ...secrets, ...(direct ? R2_SECRETS : {}),
    INDEX_QUEUE: { async send(message) { queued.push(message); } },
    DB: adminAware({ prepare: statement, async batch(statements) { statements.forEach(item => updates.push({ sql: item.sql, values: item.values })); return []; } }),
    PHOTOS: {
      async put(key, value, options) {
        puts.push(key);
        const body = value instanceof ReadableStream ? new Uint8Array(await new Response(value).arrayBuffer()) : value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : value;
        objects.set(key, { body, contentType: options?.httpMetadata?.contentType });
      },
      async head(key) { heads.push(key); const object = objects.get(key); return object ? { key, size: object.body.length ?? object.body.size ?? 0, httpMetadata: { contentType: object.contentType } } : null; },
      async get(key, options) {
        const object = objects.get(key); if (!object) return null;
        if (options?.range) ranges.push({ key, ...options.range });
        const bytes = options?.range ? object.body.slice(options.range.offset, options.range.offset + options.range.length) : object.body;
        return { async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }, async text() { return new TextDecoder().decode(bytes); } };
      },
      async delete(key) { deletes.push(key); objects.delete(key); },
    } };
  return { env, objects, inserts, updates, queued, deletes, puts, heads, ranges };
}
const post = (token, path, body, headers = {}) => request(path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, ...headers }, body });
const presign = (token, body, sessionId = 'session-1') => post(token, `/api/admin/sessions/${sessionId}/uploads/presign`, JSON.stringify(body), { 'content-type': 'application/json' });
const complete = (token, query, body) => post(token, `/api/admin/sessions/session-1/uploads/complete?${new URLSearchParams(query)}`, body, { 'content-type': 'application/octet-stream', 'content-length': String(body.size) });

// ── SigV4 ────────────────────────────────────────────────────────────────────

test('the presigner reproduces AWS\'s published query-string example byte for byte, and sorts/encodes the canonical query itself', async () => {
  // AWS "Signature Calculation: Transfer Payload in a Single Chunk / query parameters" example:
  // GET examplebucket/test.txt, us-east-1, 24-hour expiry, host the only signed header, UNSIGNED-PAYLOAD.
  const url = await presignS3Url({
    method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1', service: 's3', expires: 86400, now: new Date('2013-05-24T00:00:00Z'),
  });
  const signed = new URL(url);
  assert.equal(signed.searchParams.get('X-Amz-Signature'), 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  assert.equal(signed.searchParams.get('X-Amz-Credential'), 'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request');
  assert.equal(signed.searchParams.get('X-Amz-Date'), '20130524T000000Z');
  assert.equal(signed.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.equal(signed.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  // The query is sorted by name and the credential's slashes are percent-encoded (AWS's canonical form).
  assert.match(url, /\?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=/);
  // A second header (content-type) joins the signature and the SignedHeaders list, and R2's own region/service
  // produce a different signature for the same object — so the region is really part of the key derivation.
  const withType = await presignS3Url({ url: 'https://examplebucket.s3.amazonaws.com/test.txt', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', expires: 86400, headers: { 'content-type': 'image/jpeg' }, now: new Date('2013-05-24T00:00:00Z') });
  assert.equal(new URL(withType).searchParams.get('X-Amz-SignedHeaders'), 'content-type;host');
  assert.notEqual(new URL(withType).searchParams.get('X-Amz-Signature'), new URL(url).searchParams.get('X-Amz-Signature'));
  const autoRegion = await presignS3Url({ url: 'https://examplebucket.s3.amazonaws.com/test.txt', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', expires: 86400, now: new Date('2013-05-24T00:00:00Z') });
  assert.notEqual(new URL(autoRegion).searchParams.get('X-Amz-Signature'), new URL(url).searchParams.get('X-Amz-Signature'));
  // A key with spaces and a plus is encoded in the path the same way on both sides of the signature.
  const spaced = await presignS3Url({ url: 'https://acct.r2.cloudflarestorage.com/bucket/sessions/s1/original/p1-IMG%200412%2B2.jpg', accessKeyId: 'k', secretAccessKey: 's', now: new Date('2026-09-17T00:00:00Z') });
  assert.ok(spaced.includes('/sessions/s1/original/p1-IMG%200412%2B2.jpg'), 'the path keeps its encoding');
});

// ── presign ──────────────────────────────────────────────────────────────────

test('presign reserves the key storeSessionPhoto would have used and signs a 15-minute PUT for it', async () => {
  const token = await login();
  const { env, puts, inserts } = uploadEnv();
  const result = await worker.fetch(presign(token, { filename: 'IMG 0412.jpg', contentType: 'image/jpeg', size: 4 * 1024 * 1024 }), env, {});
  assert.equal(result.status, 201);
  const body = await result.json();
  assert.equal(body.method, 'PUT');
  assert.equal(body.key, `sessions/session-1/original/${body.photoId}-IMG-0412.jpg`, 'the crew filename is sanitised exactly as the streaming path does');
  assert.deepEqual(body.headers, { 'content-type': 'image/jpeg' });
  const url = new URL(body.uploadUrl);
  assert.equal(url.host, 'acct123.r2.cloudflarestorage.com');
  assert.equal(url.pathname, `/mambo-jambo-photos/sessions/session-1/original/${body.photoId}-IMG-0412.jpg`);
  assert.equal(url.searchParams.get('X-Amz-Expires'), '900');
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'content-type;host');
  assert.match(url.searchParams.get('X-Amz-Credential'), /^AKIAIOSFODNN7EXAMPLE\/\d{8}\/auto\/s3\/aws4_request$/);
  assert.ok(Date.parse(body.expiresAt) - Date.now() > 14 * 60_000);
  assert.equal(puts.length, 0, 'nothing is written until complete');
  assert.equal(inserts.length, 0);
  // R2_BUCKET overrides the bucket name for an account whose bucket is called something else.
  const renamed = uploadEnv(); renamed.env.R2_BUCKET = 'other-bucket';
  const second = await (await worker.fetch(presign(token, { filename: 'a.jpg', contentType: 'image/jpeg', size: 10 }), renamed.env, {})).json();
  assert.match(new URL(second.uploadUrl).pathname, /^\/other-bucket\/sessions\//);
});

test('presign refuses what the streaming upload refuses, and answers 503 { fallback: "stream" } until the R2 secrets exist', async () => {
  const token = await login();
  const { env } = uploadEnv();
  const cases = [
    [{ filename: 'a.txt', contentType: 'text/plain', size: 10 }, 400],
    [{ filename: 'a.heic', contentType: 'image/heic', size: 10 }, 400],
    [{ filename: 'a.jpg', contentType: 'image/jpeg', size: 26 * 1024 * 1024 }, 413],
    [{ filename: 'a.jpg', contentType: 'image/jpeg', size: 0 }, 400],
    [{ filename: 'a.jpg', contentType: 'image/jpeg', size: '4000' }, 400],
  ];
  for (const [body, status] of cases) assert.equal((await worker.fetch(presign(token, body), env, {})).status, status, JSON.stringify(body));
  const missing = await worker.fetch(presign(token, { filename: 'a.jpg', contentType: 'image/jpeg', size: 10 }, 'session-missing'), uploadEnv({ session: null }).env, {});
  assert.equal(missing.status, 404);
  const archived = await worker.fetch(presign(token, { filename: 'a.jpg', contentType: 'image/jpeg', size: 10 }), uploadEnv({ status: 'archived' }).env, {});
  assert.equal(archived.status, 409);
  assert.equal((await worker.fetch(presign('not-a-token', { filename: 'a.jpg', contentType: 'image/jpeg', size: 10 }), env, {})).status, 401);
  // No secrets: the studio is told to fall back to the streaming route instead of failing the batch.
  const { env: plain } = uploadEnv({ direct: false });
  const fallback = await worker.fetch(presign(token, { filename: 'a.jpg', contentType: 'image/jpeg', size: 10 }), plain, {});
  assert.equal(fallback.status, 503);
  assert.equal((await fallback.json()).fallback, 'stream');
  for (const secret of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
    const partial = uploadEnv().env; delete partial[secret];
    assert.equal((await worker.fetch(presign(token, { filename: 'a.jpg', contentType: 'image/jpeg', size: 10 }), partial, {})).status, 503, `${secret} alone missing`);
  }
});

// ── complete ─────────────────────────────────────────────────────────────────

test('complete registers the photo the browser PUT to R2: the object stays, the preview and thumb land, the size comes from a range read', async () => {
  const token = await login();
  const photoId = 'photo-direct-1'; const key = `sessions/session-1/original/${photoId}-DSC01237.JPG`;
  const original = new Uint8Array(200 * 1024); original.set(bigJpeg(6000, 4000));
  const objects = new Map([[key, { body: original, contentType: 'image/jpeg' }]]);
  const { env, inserts, queued, puts, heads, ranges, deletes } = uploadEnv({ objects });
  const result = await worker.fetch(complete(token, { photoId, key, filename: 'DSC01237.JPG', contentType: 'image/jpeg' }, framedSmall(WEBP(), WEBP())), env, {});
  assert.equal(result.status, 201);
  const body = await result.json();
  assert.equal(body.photoId, photoId, 'the reserved id is kept, so a retry cannot store the same object twice');
  assert.equal(body.filename, 'DSC01237.JPG'); assert.equal(body.thumb, true); assert.equal(body.status, 'pending');
  assert.deepEqual(heads, [key], 'the object is confirmed before anything is written');
  assert.deepEqual(ranges, [{ key, offset: 0, length: 64 * 1024 }], 'only the header is read back');
  assert.deepEqual(puts, [`sessions/session-1/preview/${photoId}.webp`, `sessions/session-1/thumb/${photoId}.webp`], 'the original is not re-uploaded');
  assert.equal(objects.get(`sessions/session-1/preview/${photoId}.webp`).contentType, 'image/webp');
  assert.equal(deletes.length, 0);
  assert.equal(inserts.length, 1);
  const [insert] = inserts;
  assert.deepEqual(insert.values.slice(0, 6), [photoId, 'session-1', key, `sessions/session-1/preview/${photoId}.webp`, 'DSC01237.JPG', 'image/jpeg']);
  assert.deepEqual(insert.values.slice(6), [6000, 4000, `sessions/session-1/thumb/${photoId}.webp`], 'the pixel size is parsed from the stored original, and the thumb key rides in the same INSERT');
  assert.deepEqual(queued, [{ photoId, jobId: queued[0]?.jobId }]);
  assert.ok(queued[0].jobId);
});

test('complete: a missing object answers 404 { missing: true } so the studio re-sends that one file the streaming way', async () => {
  const token = await login();
  const photoId = 'photo-gone'; const key = `sessions/session-1/original/${photoId}-IMG_0500.jpg`;
  const { env, inserts, puts } = uploadEnv();
  const result = await worker.fetch(complete(token, { photoId, key, filename: 'IMG_0500.jpg', contentType: 'image/jpeg' }, framedSmall(JPEG([1, 2, 3]))), env, {});
  assert.equal(result.status, 404);
  assert.equal((await result.json()).missing, true);
  assert.equal(inserts.length, 0); assert.equal(puts.length, 0);
});

test('complete only accepts a key presign minted for this session and photo, and refuses an object that is not a photo under 25 MB', async () => {
  const token = await login();
  const photoId = 'photo-x';
  const legit = `sessions/session-1/original/${photoId}-a.jpg`;
  const objects = new Map([
    [legit, { body: bigJpeg(), contentType: 'image/jpeg' }],
    ['sessions/session-2/original/photo-x-a.jpg', { body: bigJpeg(), contentType: 'image/jpeg' }],
    ['ops/alert-state.json', { body: JPEG([1]), contentType: 'application/json' }],
  ]);
  const { env, inserts, heads } = uploadEnv({ objects });
  const bad = [
    { photoId, key: 'sessions/session-2/original/photo-x-a.jpg' },            // another session's prefix
    { photoId, key: 'ops/alert-state.json' },                                 // an object outside the uploads area
    { photoId, key: `sessions/session-1/original/other-${photoId}-a.jpg` },   // a different photo id
    { photoId, key: `sessions/session-1/original/${photoId}-../../ops/x.json` },
    { photoId, key: `sessions/session-1/preview/${photoId}-a.jpg` },
    { photoId: 'photo/../x', key: `sessions/session-1/original/photo/../x-a.jpg` },
  ];
  for (const query of bad) {
    const result = await worker.fetch(complete(token, { ...query, filename: 'a.jpg', contentType: 'image/jpeg' }, framedSmall(JPEG([1]))), env, {});
    assert.equal(result.status, 400, JSON.stringify(query));
  }
  assert.deepEqual(heads, [], 'a bad key never reaches the bucket');
  assert.equal(inserts.length, 0);
  // Right key, but what landed is not a photo (or is too big): the object is dropped, nothing is registered.
  const huge = new Uint8Array(0); Object.defineProperty(huge, 'length', { value: 26 * 1024 * 1024 });
  for (const [object, status] of [[{ body: bigJpeg(), contentType: 'text/html' }, 400], [{ body: huge, contentType: 'image/jpeg' }, 413]]) {
    const map = new Map([[legit, object]]);
    const run = uploadEnv({ objects: map });
    const result = await worker.fetch(complete(token, { photoId, key: legit, filename: 'a.jpg', contentType: 'image/jpeg' }, framedSmall(JPEG([1]))), run.env, {});
    assert.equal(result.status, status);
    assert.deepEqual(run.deletes, [legit], 'the rejected object does not linger in the bucket');
    assert.equal(run.inserts.length, 0);
  }
  // And the metadata itself is validated like every other upload.
  const typed = await worker.fetch(complete(token, { photoId, key: legit, filename: 'a.jpg', contentType: 'application/pdf' }, framedSmall(JPEG([1]))), env, {});
  assert.equal(typed.status, 400);
  const mode = await worker.fetch(complete(token, { photoId, key: legit, filename: 'a.jpg', contentType: 'image/jpeg', onDuplicate: 'overwrite' }, framedSmall(JPEG([1]))), env, {});
  assert.equal(mode.status, 400);
  const junkPreview = await worker.fetch(complete(token, { photoId, key: legit, filename: 'a.jpg', contentType: 'image/jpeg' }, framedSmall(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))), env, {});
  assert.equal(junkPreview.status, 400);
  assert.equal((await worker.fetch(complete('not-a-token', { photoId, key: legit, filename: 'a.jpg', contentType: 'image/jpeg' }, framedSmall(JPEG([1]))), env, {})).status, 401);
});

test('complete honours the duplicate modes: a skipped retry takes its own object back out of the bucket', async () => {
  const token = await login();
  const photoId = 'photo-dup'; const key = `sessions/session-1/original/${photoId}-IMG_0412.jpg`;
  const existing = [{ id: 'photo-old', filename: 'IMG_0412.jpg', object_key: 'original/old', preview_key: 'preview/old', thumb_key: 'thumb/old' }];
  const skipRun = uploadEnv({ existing, objects: new Map([[key, { body: bigJpeg(), contentType: 'image/jpeg' }]]) });
  const skipped = await worker.fetch(complete(token, { photoId, key, filename: 'IMG_0412.jpg', contentType: 'image/jpeg', onDuplicate: 'skip' }, framedSmall(JPEG([1]))), skipRun.env, {});
  assert.equal(skipped.status, 200);
  assert.deepEqual(await skipped.json(), { skipped: true, filename: 'IMG_0412.jpg' });
  assert.equal(skipRun.inserts.length, 0);
  assert.deepEqual(skipRun.deletes, [key], 'the orphan the browser PUT is cleaned up');
  assert.equal(skipRun.objects.has(key), false);
  // replace: the new row keeps the direct object, and the old photo's three files go.
  const replaceRun = uploadEnv({ existing, objects: new Map([[key, { body: bigJpeg(), contentType: 'image/jpeg' }]]) });
  const replaced = await worker.fetch(complete(token, { photoId, key, filename: 'IMG_0412.jpg', contentType: 'image/jpeg', onDuplicate: 'replace' }, framedSmall(JPEG([1]))), replaceRun.env, {});
  assert.equal(replaced.status, 201);
  assert.equal((await replaced.json()).duplicate, 'replaced');
  assert.deepEqual(replaceRun.deletes.sort(), ['original/old', 'preview/old', 'thumb/old']);
  assert.equal(replaceRun.inserts[0].values[2], key);
  // rename: the numbered copy is stored under the reserved key (the key names the photo id, not the filename).
  const renameRun = uploadEnv({ existing, objects: new Map([[key, { body: bigJpeg(), contentType: 'image/jpeg' }]]) });
  const renamed = await worker.fetch(complete(token, { photoId, key, filename: 'IMG_0412.jpg', contentType: 'image/jpeg', onDuplicate: 'rename' }, framedSmall(JPEG([1]))), renameRun.env, {});
  assert.equal((await renamed.json()).filename, 'IMG_0412-2.jpg');
  assert.equal(renameRun.inserts[0].values[4], 'IMG_0412-2.jpg');
});

test('complete falls back to the studio hint and to a plain INSERT on a database without 0008/0012', async () => {
  const token = await login();
  const photoId = 'photo-heic'; const key = `sessions/session-1/original/${photoId}-IMG_0001.jpg`;
  // An original whose header says nothing (an ISOBMFF box, as a HEIC converted by some phones does).
  const opaque = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0, 0, 0, 0]);
  const hinted = uploadEnv({ objects: new Map([[key, { body: opaque, contentType: 'image/jpeg' }]]) });
  await worker.fetch(complete(token, { photoId, key, filename: 'IMG_0001.jpg', contentType: 'image/jpeg', width: '480', height: '600' }, framedSmall(JPEG([1]))), hinted.env, {});
  assert.deepEqual(hinted.inserts[0].values.slice(6, 8), [480, 600], 'the studio hint fills in when the header cannot be read');
  // Pre-0008/0012 database: no width/height, no thumb_key — the thumb is simply not stored.
  const old = uploadEnv({ photoColumns: ['id'], objects: new Map([[key, { body: bigJpeg(), contentType: 'image/jpeg' }]]) });
  const result = await worker.fetch(complete(token, { photoId, key, filename: 'IMG_0001.jpg', contentType: 'image/jpeg' }, framedSmall(JPEG([1]), WEBP())), old.env, {});
  assert.equal(result.status, 201);
  assert.equal((await result.json()).thumb, false);
  assert.equal(old.inserts[0].values.length, 6);
  assert.match(old.inserts[0].sql, /INSERT INTO photos \(id, session_id, object_key, preview_key, filename, content_type, indexing_status\)/);
  assert.deepEqual(old.puts, [`sessions/session-1/preview/${photoId}.jpg`]);
});

// ── WebP previews and thumbs ─────────────────────────────────────────────────

test('previews and thumbs may be WebP or JPEG: the format is sniffed from the bytes, never taken from the client', async () => {
  assert.deepEqual(previewFormat(JPEG([1, 2, 3])), { type: 'image/jpeg', ext: 'jpg' });
  assert.deepEqual(previewFormat(WEBP()), { type: 'image/webp', ext: 'webp' });
  for (const bytes of [null, 'FFD8', Uint8Array.from([0xFF]), Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13]), Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20])]) {
    assert.equal(previewFormat(bytes), null, String(bytes));
  }
  // Streaming upload with a WebP preview: stored under .webp with the right content-type.
  const token = await login();
  const { env, objects, inserts } = uploadEnv();
  const preview = WEBP(); const length = new Uint8Array(4); new DataView(length.buffer).setUint32(0, preview.length, true);
  const body = new Blob([length, preview, bigJpeg(4000, 3000)]);
  const stream = request('/api/admin/sessions/session-1/photos?type=image%2Fjpeg&filename=IMG_0600.jpg', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'content-length': String(body.size) }, body });
  const result = await worker.fetch(stream, env, {});
  assert.equal(result.status, 201);
  const previewKey = inserts[0].values[3];
  assert.match(previewKey, /\.webp$/);
  assert.equal(objects.get(previewKey).contentType, 'image/webp');
  // A preview that is neither is still refused before the original is touched.
  const junk = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13]);
  const junkLength = new Uint8Array(4); new DataView(junkLength.buffer).setUint32(0, junk.length, true);
  const junkBody = new Blob([junkLength, junk, bigJpeg()]);
  const refused = await worker.fetch(request('/api/admin/sessions/session-1/photos?type=image%2Fjpeg&filename=IMG_0601.jpg', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'content-length': String(junkBody.size) }, body: junkBody }), uploadEnv().env, {});
  assert.equal(refused.status, 400);
});

test('the thumb route takes a WebP too and retires a thumbnail stored under the other extension', async () => {
  const token = await login();
  const photos = { 'photo-1': { id: 'photo-1', session_id: 'session-1', thumb_key: 'sessions/session-1/thumb/photo-1.jpg' } };
  const { env, objects, updates, deletes } = uploadEnv({ photos, objects: new Map([['sessions/session-1/thumb/photo-1.jpg', { body: JPEG([1]), contentType: 'image/jpeg' }]]) });
  const result = await worker.fetch(post(token, '/api/admin/photos/photo-1/thumb', WEBP(), { 'content-type': 'image/webp' }), env, {});
  assert.equal(result.status, 201);
  assert.equal(objects.get('sessions/session-1/thumb/photo-1.webp').contentType, 'image/webp');
  assert.ok(updates.some(update => update.sql.includes('UPDATE photos SET thumb_key') && update.values[0] === 'sessions/session-1/thumb/photo-1.webp'));
  assert.deepEqual(deletes, ['sessions/session-1/thumb/photo-1.jpg'], 'the old JPEG thumb goes with it');
  // Junk is still refused, and the message names both formats.
  const junk = await worker.fetch(post(token, '/api/admin/photos/photo-1/thumb', Uint8Array.from([1, 2, 3]), { 'content-type': 'image/webp' }), uploadEnv({ photos }).env, {});
  assert.equal(junk.status, 400);
  assert.match((await junk.json()).error, /JPEG or WebP/);
  const unmigrated = await worker.fetch(post(token, '/api/admin/photos/photo-1/thumb', WEBP(), { 'content-type': 'image/webp' }), uploadEnv({ photos, photoColumns: ['id'] }).env, {});
  assert.equal(unmigrated.status, 503);
});

// ── Regenerate previews ──────────────────────────────────────────────────────

test('PUT /api/admin/photos/:id/preview replaces the watermarked preview, removes the old object and fills a missing pixel size', async () => {
  const token = await login();
  const photos = { 'photo-1': { id: 'photo-1', session_id: 'session-1', preview_key: 'sessions/session-1/preview/photo-1.jpg', width: null, height: null } };
  const put = (id, body, query = '') => request(`/api/admin/photos/${id}/preview${query}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body });
  const { env, objects, updates, deletes } = uploadEnv({ photos, objects: new Map([['sessions/session-1/preview/photo-1.jpg', { body: JPEG([1]), contentType: 'image/jpeg' }]]) });
  const result = await worker.fetch(put('photo-1', WEBP(), '?width=600&height=400'), env, {});
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.deepEqual(body, { photoId: 'photo-1', preview: true, key: 'sessions/session-1/preview/photo-1.webp', width: 600, height: 400 });
  assert.equal(objects.get('sessions/session-1/preview/photo-1.webp').contentType, 'image/webp');
  assert.deepEqual(deletes, ['sessions/session-1/preview/photo-1.jpg']);
  const [update] = updates.filter(entry => entry.sql.includes('UPDATE photos SET preview_key'));
  assert.deepEqual(update.values, ['sessions/session-1/preview/photo-1.webp', 600, 400, 'photo-1']);
  // A photo that already has its size keeps it (the regenerated preview is smaller than the original).
  const sized = { 'photo-2': { id: 'photo-2', session_id: 'session-1', preview_key: 'sessions/session-1/preview/photo-2.jpg', width: 6000, height: 4000 } };
  const kept = uploadEnv({ photos: sized });
  const second = await worker.fetch(put('photo-2', JPEG([1, 2, 3]), '?width=600&height=400'), kept.env, {});
  assert.equal(second.status, 200);
  assert.equal((await second.json()).width, undefined);
  assert.deepEqual(kept.updates.filter(entry => entry.sql.includes('preview_key'))[0].values, ['sessions/session-1/preview/photo-2.jpg', 'photo-2']);
  assert.deepEqual(kept.deletes, [], 'the same key was overwritten, so nothing is deleted');
  // Refusals: unknown photo, junk bytes, no sign-in.
  assert.equal((await worker.fetch(put('photo-missing', WEBP()), uploadEnv().env, {})).status, 404);
  const junk = await worker.fetch(put('photo-1', Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), ''), uploadEnv({ photos }).env, {});
  assert.equal(junk.status, 400);
  assert.match((await junk.json()).error, /JPEG or WebP/);
  const anonymous = await worker.fetch(request('/api/admin/photos/photo-1/preview', { method: 'PUT', body: WEBP() }), uploadEnv({ photos }).env, {});
  assert.equal(anonymous.status, 401);
});

// ── The studio side (admin.js / preview-worker.js), checked as source ────────

test('the studio prefers WebP only when the browser really encodes it, and falls back per batch when presign is unavailable', async () => {
  const admin = await readFile(new URL('../admin.js', import.meta.url), 'utf8');
  const previewWorker = await readFile(new URL('../preview-worker.js', import.meta.url), 'utf8');
  // Feature detection is by the *output* type, never by a UA string: Safari < 16 answers a PNG to
  // toBlob('image/webp'), so the type of the produced blob is what decides.
  assert.match(admin, /blob\.type === 'image\/webp'/);
  assert.match(previewWorker, /blob\.type === 'image\/webp'/);
  assert.doesNotMatch(admin, /navigator\.userAgent/);
  // One presign probe per batch; a 503 (or any refusal) turns the whole batch back to the streaming path.
  assert.match(admin, /fallback === 'stream'/);
  assert.match(admin, /uploads\/presign/);
  assert.match(admin, /uploads\/complete/);
  // The R2 PUT carries the exact headers the Worker signed and nothing else (a stray header breaks the signature).
  assert.match(admin, /Object\.entries\(plan\.headers \|\| \{\}\)\.forEach\(\(\[name, value\]\) => xhr\.setRequestHeader\(name, value\)\);/);
  assert.doesNotMatch(admin.slice(admin.indexOf('const uploadDirect ='), admin.indexOf('const uploadOne =')), /authorization/i, 'the crew token never goes to the bucket');
});

// ── Resumable batches: the IndexedDB manifest and the resume offer ───────────

// The manifest block and the resume block are run in a sandbox with a tiny in-memory IndexedDB and a
// fake document, so the real behaviour (not just the source text) is checked without a browser.
function fakeIndexedDb() {
  const stores = new Map();
  const request = value => { const req = { result: value, onsuccess: null, onerror: null, onupgradeneeded: null }; queueMicrotask(() => req.onsuccess?.()); return req; };
  const db = {
    objectStoreNames: { contains: name => stores.has(name) },
    createObjectStore(name, { keyPath }) { stores.set(name, { keyPath, rows: new Map() }); return stores.get(name); },
    transaction(name) {
      const store = stores.get(name); const tx = { oncomplete: null, onerror: null, onabort: null };
      queueMicrotask(() => tx.oncomplete?.());
      return { ...tx, get oncomplete() { return tx.oncomplete; }, set oncomplete(fn) { tx.oncomplete = fn; }, set onerror(fn) { tx.onerror = fn; }, set onabort(fn) { tx.onabort = fn; },
        objectStore: () => ({
          put: row => { store.rows.set(row[store.keyPath], structuredClone(row)); return request(undefined); },
          delete: key => { store.rows.delete(key); return request(undefined); },
          getAll: () => request([...store.rows.values()]),
        }) };
    },
    close() {},
  };
  return { stores, indexedDB: { open() { const req = { result: db, onsuccess: null, onerror: null, onupgradeneeded: null }; queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.(); }); return req; } } };
}
async function manifestSandbox() {
  const vm = await import('node:vm');
  const admin = await readFile(new URL('../admin.js', import.meta.url), 'utf8');
  const block = admin.slice(admin.indexOf('const UPLOAD_DB ='), admin.indexOf('// ── Upload: shared batch sender'));
  const { stores, indexedDB } = fakeIndexedDb();
  const api = vm.runInNewContext(`${block}\n({ saveManifest, dropManifest, allManifests, newManifest, manifestRecorder, fileKey, needsUploadSync, UPLOAD_MANIFEST_MAX_AGE_MS })`, { indexedDB, Promise, Date, Math, Array, Object, JSON, setTimeout, clearTimeout, structuredClone });
  return { ...api, stores };
}

test('an interrupted batch leaves a manifest of what still has to go — names, sizes and timestamps only', async () => {
  const { newManifest, manifestRecorder, allManifests, fileKey, stores } = await manifestSandbox();
  const items = [1, 2, 3].map(n => ({ file: { name: `SOI_040${n}.jpg`, size: 2_400_000 + n, lastModified: 1_700_000_000_000 + n, type: 'image/jpeg' } }));
  const manifest = newManifest('session-1', 'Morning glass', items);
  assert.deepEqual(JSON.parse(JSON.stringify(manifest.files[0])), { name: 'SOI_0401.jpg', size: 2_400_001, lastModified: 1_700_000_000_001, done: false, photoId: null });   // the sandbox realm has its own Object prototype
  assert.equal(JSON.stringify(manifest).includes('image/jpeg'), false, 'no photo, no type, no token — just enough to match a re-pick');
  const recorder = manifestRecorder(manifest);
  await new Promise(resolve => setTimeout(resolve, 5));
  const stored = await allManifests();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].sessionTitle, 'Morning glass');
  recorder.done(0, 'photo-1'); recorder.done(1, 'photo-2');
  await recorder.finish();
  const half = (await allManifests())[0];
  assert.deepEqual(half.files.map(file => file.done), [true, true, false], 'two ticked off, one still to send');
  assert.equal(half.files[0].photoId, 'photo-1');
  recorder.done(2, 'photo-3');
  await recorder.finish();
  assert.deepEqual(await allManifests(), [], 'nothing left to resume: the manifest is dropped');
  // Every store access is guarded: a browser that refuses IndexedDB (private mode) is simply silent.
  const vm = await import('node:vm');
  const admin = await readFile(new URL('../admin.js', import.meta.url), 'utf8');
  const block = admin.slice(admin.indexOf('const UPLOAD_DB ='), admin.indexOf('// ── Upload: shared batch sender'));
  const blocked = vm.runInNewContext(`${block}\n({ allManifests, saveManifest, manifestRecorder, newManifest })`, { indexedDB: { open() { const req = { onsuccess: null, onerror: null }; queueMicrotask(() => req.onerror?.()); return req; } }, Promise, Date, Math, Array, Object, JSON, setTimeout, clearTimeout });
  assert.equal(await blocked.allManifests(), null);
  const quiet = blocked.manifestRecorder(blocked.newManifest('s', 't', items));
  quiet.done(0, 'p'); await quiet.finish();   // must not throw
  assert.equal(fileKey({ name: 'a.jpg', size: 10, lastModified: 5 }), fileKey({ name: 'a.jpg', size: 10, lastModified: 5 }));
  assert.notEqual(fileKey({ name: 'a.jpg', size: 10, lastModified: 5 }), fileKey({ name: 'a.jpg', size: 11, lastModified: 5 }));
  assert.equal(stores.size, 1);
});

test('a batch that lost the link asks the service worker for a background sync; a Stop or a refusal does not', async () => {
  const { needsUploadSync } = await manifestSandbox();
  const dropped = { message: 'SOI_0402.jpg: Network dropped.' }, refused = { message: 'SOI_0403.jpg: Photos must be under 25 MB.' }, stalled = { message: 'SOI_0404.jpg: Stalled — nothing sent for 30 s.' };
  assert.equal(needsUploadSync([], [], true), false, 'everything landed');
  assert.equal(needsUploadSync([], [], false), false, 'everything landed before the link went');
  assert.equal(needsUploadSync([dropped], [], true), true, 'a stream died on the network: the connection is flaky even if the browser still says online');
  assert.equal(needsUploadSync([refused], [], true), false, 'the Worker said no — a sync would change nothing');
  assert.equal(needsUploadSync([stalled], [], true), false, 'a stall is the Worker or a slow uplink, not a lost link');
  assert.equal(needsUploadSync([], [{ file: {} }], true), false, 'a deliberate Stop while online: the crew has the retry button');
  assert.equal(needsUploadSync([], [{ file: {} }], false), true, 'stopped because the device went offline');
  assert.equal(needsUploadSync([refused], [], false), true, 'offline now: whatever the reason, the link is gone');
  // The batch sender calls it once at the end with the real online state, feature-detecting W4-B's API;
  // nothing else in the studio registers the sync tag (pwa.js does its own on the `offline` event).
  const admin = await readFile(new URL('../admin.js', import.meta.url), 'utf8');
  const sender = admin.slice(admin.indexOf('async function uploadPhotoBatch('), admin.indexOf('// ── Upload: publish'));
  assert.match(sender, /if \(needsUploadSync\(failures, unsent, navigator\.onLine\)\) window\.SOIPWA\?\.requestUploadSync\?\.\(\);/);
  assert.equal(admin.split('requestUploadSync').length - 1, 1);
});

test('the resume offer names the session, sends only the files that never landed, and Discard forgets it', async () => {
  const vm = await import('node:vm');
  const admin = await readFile(new URL('../admin.js', import.meta.url), 'utf8');
  const block = admin.slice(admin.indexOf('const UPLOAD_DB ='), admin.indexOf('// ── Upload: shared batch sender')) +
    admin.slice(admin.indexOf('const resumePanel = document.getElementById'), admin.indexOf('// ── Regenerate previews'));
  const { indexedDB } = fakeIndexedDb();
  const listeners = new Map(); const elements = new Map(); const dropped = []; const toasts = []; const statuses = []; const handed = [];
  const scrolls = [];
  const element = id => { if (!elements.has(id)) elements.set(id, { id, hidden: true, textContent: '', style: {}, click: () => listeners.get(`${id}:click`)?.(), addEventListener: (type, fn) => listeners.set(`${id}:${type}`, fn), scrollIntoView: options => scrolls.push({ id, ...options }) }); return elements.get(id); };
  const sandbox = { indexedDB, Promise, Date, Math, Array, Object, JSON, Map, Set, setTimeout, clearTimeout, structuredClone,
    document: { getElementById: element, querySelector: selector => (selector === '.topbar' ? { offsetHeight: 88 } : null) },
    window: {},   // no File System Access API: the file input is used
    addEventListener: (type, fn) => listeners.set(`window:${type}`, fn),   // W4-B's `soi-resume-uploads` lands here
    isAuthenticated: () => true, uploadBusy: false,
    setStatus: (text, isError) => statuses.push({ text, isError }),
    openUploadMoreWith: (session, files) => handed.push({ session, files }),
    toast: (text, kind) => toasts.push({ text, kind }),
  };
  const api = vm.runInNewContext(`${block}\n({ offerResume, resumeWith, saveManifest, allManifests, newManifest, hideResumeOffer })`, sandbox);
  const file = (name, size, lastModified) => ({ name, size, lastModified });
  const manifest = { sessionId: 'session-7', sessionTitle: 'Morning glass', createdAt: Date.now(), files: [
    { name: 'a.jpg', size: 100, lastModified: 1, done: true, photoId: 'p-a' },
    { name: 'b.jpg', size: 200, lastModified: 2, done: false, photoId: null },
    { name: 'c.jpg', size: 300, lastModified: 3, done: false, photoId: null },
  ] };
  const finished = { sessionId: 'session-8', sessionTitle: 'Old one', createdAt: Date.now() - 1000, files: [{ name: 'x.jpg', size: 1, lastModified: 1, done: true, photoId: 'p' }] };
  const ancient = { sessionId: 'session-9', sessionTitle: 'Last week', createdAt: Date.now() - 8 * 24 * 3600 * 1000, files: [{ name: 'y.jpg', size: 1, lastModified: 1, done: false, photoId: null }] };
  await api.saveManifest(manifest); await api.saveManifest(finished); await api.saveManifest(ancient);
  await api.offerResume();
  assert.equal(element('resumePanel').hidden, false);
  assert.match(element('resumeCopy').textContent, /“Morning glass” — 1 of 3 photos uploaded/);
  assert.ok(element('resumeCopy').textContent.includes('nothing is published until you say so'), 'publishing stays manual');
  // A reload restores the old scroll position (often the bottom of a long queue): the offer scrolls itself into
  // view, clear of the sticky topbar, and `nearest` leaves it alone when it is already on screen.
  assert.deepEqual(scrolls, [{ id: 'resumePanel', block: 'nearest' }]);
  assert.equal(element('resumePanel').style.scrollMarginTop, '104px');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual((await api.allManifests()).map(item => item.sessionId).sort(), ['session-7', 'session-8'], 'a week-old manifest is forgotten, a finished one is never offered');
  // A re-pick of the whole folder: the photo that already landed is left out, a stray is reported.
  api.resumeWith([file('a.jpg', 100, 1), file('b.jpg', 200, 2), file('c.jpg', 300, 3), file('holiday.jpg', 40, 9)]);
  assert.equal(handed.length, 1);
  assert.deepEqual({ ...handed[0].session }, { id: 'session-7', title: 'Morning glass' });
  assert.deepEqual([...handed[0].files].map(item => item.name), ['b.jpg', 'c.jpg']);
  assert.match(toasts.at(-1).text, /2 photos from another batch left out|1 photo from another batch left out/);
  assert.equal(element('resumePanel').hidden, true, 'the offer closes once the files are handed over');
  // The wrong folder: nothing is sent and the panel stays up.
  await api.offerResume();
  api.resumeWith([file('zzz.jpg', 1, 1)]);
  assert.equal(handed.length, 1);
  assert.match(statuses.at(-1).text, /None of those are from that batch\. Pick the same folder — 2 photos still to send\./);
  assert.equal(statuses.at(-1).isError, true);
  // Discard drops the manifest and never touches the photos already uploaded.
  listeners.get('resumeDiscardBtn:click')();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual((await api.allManifests()).map(item => item.sessionId), ['session-8']);
  assert.match(toasts.at(-1).text, /The photos already uploaded are still in that session/);
  // The service worker's background sync (W4-B) reopens the offer from the manifest — for a batch
  // left behind offline — but never over a batch that is running, and never without a manifest.
  const wake = listeners.get('window:soi-resume-uploads');
  assert.equal(typeof wake, 'function', 'the studio listens for soi-resume-uploads');
  wake(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(element('resumePanel').hidden, true, 'nothing left to resume (session-8 is finished): the offer stays closed');
  await api.saveManifest({ sessionId: 'session-10', sessionTitle: 'Dusk', createdAt: Date.now(), files: [{ name: 'd.jpg', size: 4, lastModified: 4, done: false, photoId: null }] });
  sandbox.uploadBusy = true; wake(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(element('resumePanel').hidden, true, 'a batch is running: it would offer to resume itself');
  sandbox.uploadBusy = false; wake(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(element('resumePanel').hidden, false);
  assert.match(element('resumeCopy').textContent, /“Dusk” — 0 of 1 photos uploaded/);
});

// ── Regenerate previews ──────────────────────────────────────────────────────

test('"Regenerate previews" rebuilds every preview from the original in the browser, never re-uploading one, and can be stopped', async () => {
  const vm = await import('node:vm');
  const admin = await readFile(new URL('../admin.js', import.meta.url), 'utf8');
  const block = admin.slice(admin.indexOf('const REGEN_WORKERS'), admin.indexOf('// ── Dashboard ─'));
  const calls = []; const notices = []; const statuses = []; const elements = new Map(); const listeners = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, { id, hidden: true, disabled: false, textContent: '', addEventListener: (type, fn) => listeners.set(`${id}:${type}`, fn) }); return elements.get(id); };
  const photos = [1, 2, 3].map(n => ({ id: `photo-${n}`, filename: `SOI_040${n}.jpg`, originalUrl: `https://worker.test/api/media/photo-${n}?variant=original&token=t${n}` }));
  let expire = 0;
  let renderMs = 0;   // how long one re-render takes, so the Stop test can click mid-run
  const sandbox = { Promise, Date, Math, Array, Object, JSON, Map, Number, Boolean, String, setTimeout, clearTimeout, AbortSignal: { timeout: () => null },
    document: { getElementById: element },
    File: class { constructor(parts, name, options) { this.parts = parts; this.name = name; this.type = options?.type; } },
    Blob: class { constructor(parts) { this.parts = parts; } },
    uploadBusy: false,
    confirmAction: async options => { calls.push({ confirm: options.title, copy: options.copy }); return true; },
    notifyCrew: (message, kind) => notices.push({ message, kind }),
    setStatus: text => statuses.push(text),
    apiRequest: async (path, options) => {
      calls.push({ path, method: options?.method || 'GET', type: options?.headers?.['content-type'] });
      if (path.endsWith('/photos')) return { photos };
      return { photoId: 'x', preview: true };
    },
    fetch: async url => {
      calls.push({ fetched: String(url) });
      if (expire-- > 0) return { ok: false, status: 401 };
      return { ok: true, status: 200, async blob() { return { type: 'image/jpeg', size: 4_000_000 }; } };
    },
    watermarkedPreview: async () => { if (renderMs) await new Promise(resolve => setTimeout(resolve, renderMs)); return Object.assign({ type: 'image/webp', size: 28_000 }, { width: 600, height: 400, thumb: { type: 'image/webp', size: 11_000 } }); },
    uploadThumb: async (photoId, thumb) => calls.push({ thumb: photoId, type: thumb.type }),
  };
  const api = vm.runInNewContext(`${block}\n({ regeneratePreviews })`, sandbox);
  await api.regeneratePreviews('session-1', 'Dawn patrol');
  assert.match(calls[0].copy, /Originals are never touched/);
  const previewPuts = calls.filter(call => call.method === 'PUT');
  assert.equal(previewPuts.length, 3);
  assert.deepEqual(previewPuts.map(call => call.path), photos.map(photo => `/api/admin/photos/${photo.id}/preview?width=600&height=400`));
  assert.ok(previewPuts.every(call => call.type === 'image/webp'), 'the preview is sent as what it actually is');
  assert.equal(calls.filter(call => call.thumb).length, 3);
  assert.equal(calls.filter(call => call.fetched).length, 3, 'each original is fetched once — and only through its signed crew link');
  assert.ok(calls.every(call => !call.path || !call.path.includes('/photos?') || call.method === 'GET'), 'no original is ever uploaded again');
  assert.match(notices.at(-1).message, /^3 previews rebuilt\.$/);
  assert.equal(notices.at(-1).kind, 'success');
  assert.equal(element('regenPanel').hidden, true, 'the progress line goes when the run ends');
  // A link that expired mid-run is renewed once from the photo list, then the photo is retried.
  calls.length = 0; notices.length = 0; expire = 1;
  await api.regeneratePreviews('session-1', 'Dawn patrol');
  assert.equal(calls.filter(call => call.path?.endsWith('/photos')).length, 2, 'the list is fetched again to renew the links');
  assert.match(notices.at(-1).message, /^3 previews rebuilt\.$/);
  // Stop: the run ends after the photos already in flight and says how many were left.
  calls.length = 0; notices.length = 0; expire = 0; renderMs = 30;
  const running = api.regeneratePreviews('session-1', 'Dawn patrol');
  await new Promise(resolve => setTimeout(resolve, 10));   // two photos are in flight (REGEN_WORKERS), the third has not started
  listeners.get('regenStopBtn:click')();
  await running;
  assert.match(notices.at(-1).message, /2 previews rebuilt, stopped with 1 to go\./);
  assert.equal(element('regenStopBtn').disabled, true);
  renderMs = 0;
  // A batch in progress owns the uplink: the action says so instead of competing with it.
  sandbox.uploadBusy = true; notices.length = 0;
  await api.regeneratePreviews('session-1', 'Dawn patrol');
  assert.match(notices.at(-1).message, /Let the current upload finish first/);
});
