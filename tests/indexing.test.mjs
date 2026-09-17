import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
async function setup(context) {
  const sql = new DatabaseSync(':memory:'); sql.exec(schema); context.after(() => sql.close());
  sql.exec("INSERT INTO sessions(id,title,session_date,location) VALUES('session','Surf','2026-09-15','Mulki'); INSERT INTO photos(id,session_id,object_key,preview_key,filename,content_type) VALUES('photo','session','original','preview','image.jpg','image/jpeg');");
  const messages = [];
  const env = { ADMIN_PASSWORD: 'test-password', SESSION_SECRET: 'test-signing-key', FACE_API_URL: 'https://face.test/extract',
    DB: { prepare(query) { const statement = sql.prepare(query); let args = []; return {
      bind(...values) { args = values; return this; }, async first() { return statement.get(...args) || null; }, async all() { return { results: statement.all(...args) }; }, async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; }
    }; }, async batch(statements) { sql.exec('BEGIN'); try { const result = []; for (const statement of statements) result.push(await statement.run()); sql.exec('COMMIT'); return result; } catch (error) { sql.exec('ROLLBACK'); throw error; } } },
    PHOTOS: { async get() { return { blob: async () => new Blob(['test image'], { type: 'image/jpeg' }) }; } }, INDEX_QUEUE: { async send(body) { messages.push(body); } }
  };
  const login = await worker.fetch(new Request('https://api.test/api/admin/login', { method: 'POST', body: JSON.stringify({ password: env.ADMIN_PASSWORD }) }), env, {});
  const token = (await login.json()).token;
  const enqueue = () => worker.fetch(new Request('https://api.test/api/admin/sessions/session/reindex', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }), env, {});
  const consume = async (body = messages[0], attempts = 1) => { const result = { ack: false, retry: false }; await worker.queue({ messages: [{ body, attempts, ack() { result.ack = true; }, retry() { result.retry = true; } }] }, env); return result; };
  return { sql, env, messages, enqueue, consume, token };
}
test('reindex queues immediately, force-reindex overrides an in-flight click, and commits detected faces', async context => {
  const { sql, messages, enqueue, consume } = await setup(context);
  let requests = 0; context.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json({ faces: [{ embedding: [1, 0], confidence: .99 }], captured_at: '2026-09-15T08:30:00' }); });
  const response = await enqueue(); assert.equal(response.status, 202); assert.deepEqual(await response.json(), { queued: 1, alreadyQueued: 0, failed: 0 });
  assert.equal(requests, 0); assert.equal(messages.length, 1);
  // A second click before the first job is even consumed force-overrides it: a fresh job replaces
  // the queued one instead of deduping, so the crew can always override a stuck run.
  assert.deepEqual(await (await enqueue()).json(), { queued: 1, alreadyQueued: 0, failed: 0 });
  assert.equal(messages.length, 2);
  // The superseded first message's job_id no longer matches the row, so its stale consumer just acks.
  assert.deepEqual(await consume(messages[0]), { ack: true, retry: false });
  assert.equal(requests, 0);
  // The second (current) job still processes and commits normally.
  assert.deepEqual(await consume(messages[1]), { ack: true, retry: false });
  assert.equal(sql.prepare('SELECT indexing_status FROM photos').get().indexing_status, 'completed');
  assert.equal(sql.prepare('SELECT captured_at FROM photos').get().captured_at, '2026-09-15T08:30:00');
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM faces').get().n, 1);
  assert.equal(requests, 1);
});
test('face service failure retries and reports terminal failure without deleting old faces', async context => {
  const { sql, enqueue, consume } = await setup(context);
  sql.exec("INSERT INTO faces(id,photo_id,embedding_json) VALUES('old-face','photo','[1,0]')");
  context.mock.method(globalThis, 'fetch', async () => new Response('Unavailable', { status: 503 }));
  await enqueue(); assert.deepEqual(await consume(), { ack: false, retry: true });
  assert.equal(sql.prepare('SELECT indexing_status FROM photos').get().indexing_status, 'pending');
  assert.deepEqual(await consume(undefined, 4), { ack: true, retry: false });
  assert.equal(sql.prepare('SELECT indexing_status FROM photos').get().indexing_status, 'failed');
  assert.match(sql.prepare('SELECT error FROM indexing_jobs').get().error, /temporarily unavailable/);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM faces').get().n, 1);
});
test('no detected faces is a completed scan, not a service failure', async context => {
  const { sql, enqueue, consume } = await setup(context);
  context.mock.method(globalThis, 'fetch', async () => Response.json({ faces: [], captured_at: null })); await enqueue(); await consume();
  assert.equal(sql.prepare('SELECT indexing_status FROM photos').get().indexing_status, 'completed');
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM faces').get().n, 0);
});
test('queue send failure is visible and can be retried', async context => {
  const { env, sql, enqueue } = await setup(context); env.INDEX_QUEUE.send = async () => { throw new Error('offline'); };
  assert.equal((await (await enqueue()).json()).failed, 1);
  assert.equal(sql.prepare('SELECT status FROM indexing_jobs').get().status, 'failed');
  env.INDEX_QUEUE.send = async () => {};
  assert.equal((await (await enqueue()).json()).queued, 1);
});
test('deleted photos and superseded queue messages are safely ignored', async context => {
  const { sql, enqueue, consume } = await setup(context); await enqueue();
  assert.deepEqual(await consume({ photoId: 'photo', jobId: 'old-generation' }), { ack: true, retry: false });
  sql.exec("DELETE FROM photos WHERE id='photo'");
  assert.deepEqual(await consume(), { ack: true, retry: false });
});

test('browser-style uploads save both images and queue exactly one photo', async context => {
  const { env, sql, messages, token } = await setup(context);
  const stored = [];
  env.PHOTOS.put = async (key, body) => { assert.ok(body instanceof Blob); stored.push({ key, size: body.size }); };
  const boundary = '----WebKitFormBoundaryCaseSensitive';
  const part = (name, filename) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\nimage bytes\r\n`;
  const body = part('file', 'GPAH1009.JPG') + part('preview', 'preview.jpg') + `--${boundary}--\r\n`;
  const response = await worker.fetch(new Request('https://api.test/api/admin/sessions/session/photos', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, body }), env, {});
  assert.equal(response.status, 201); assert.equal(stored.length, 2); assert.equal(messages.length, 1);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM photos').get().n, 2);
});
test('review finds fresh uncertain pairs, returns precise crops, and records one decision', async context => {
  const { env, sql, token } = await setup(context);
  sql.exec("UPDATE photos SET indexing_status='completed'; INSERT INTO faces(id,photo_id,embedding_json,bbox_json) VALUES('anchor','photo','[1,0]','[10,10,20,30]');");
  for (let i = 0; i < 7; i++) {
    sql.prepare("INSERT INTO photos(id,session_id,object_key,preview_key,filename,content_type,indexing_status) VALUES(?,'session',?,?,?,'image/jpeg','completed')").run(`p${i}`, `o${i}`, `v${i}`, `shot${i}.jpg`);
    sql.prepare('INSERT INTO faces(id,photo_id,embedding_json,bbox_json) VALUES(?,?,?,?)').run(`f${i}`, `p${i}`, JSON.stringify([.62, Math.sqrt(1 - .62 ** 2)]), '[15,15,18,24]');
  }
  // Existing pairs can be stored in either order; they must not reappear.
  sql.exec("INSERT INTO face_verifications(id,session_id,face1_id,face2_id,similarity,status) VALUES('reviewed','session','f0','anchor',.62,'confirmed')");
  const send = (path, body) => worker.fetch(new Request(`https://api.test${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, {});
  const response = await send('/api/admin/verify-queue'); assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.queue.length, 6);
  assert.ok(data.queue.every(pair => pair.photo1.bboxNorm && pair.photo2.bboxNorm));
  assert.ok(data.queue.every(pair => new URL(pair.photo1.url).searchParams.get('variant') === 'original'));
  const pairId = data.queue[0].id;
  assert.equal((await send('/api/admin/confirm-match', { pairId, confirmed: 'false' })).status, 400);
  assert.equal((await send('/api/admin/confirm-match', { pairId, confirmed: false })).status, 200);
  assert.equal(sql.prepare('SELECT status FROM face_verifications WHERE id=?').get(pairId).status, 'rejected');
  assert.equal((await send('/api/admin/confirm-match', { pairId, confirmed: true })).status, 409);
  assert.equal((await (await send('/api/admin/verify-queue/scan', {})).json()).generated, 0);
});
test('confirming or rejecting a face pair, burst link, or appearance link logs feedback with the right source and feature', async context => {
  const { env, sql, token } = await setup(context);
  sql.exec(`
    UPDATE photos SET indexing_status='completed' WHERE id='photo';
    INSERT INTO photos(id,session_id,object_key,preview_key,filename,content_type,indexing_status) VALUES('other','session','o2','v2','other.jpg','image/jpeg','completed');
    INSERT INTO faces(id,photo_id,embedding_json) VALUES('f1','photo','[1,0]'),('f2','other','[0.62,0.7846]');
    INSERT INTO face_verifications(id,session_id,face1_id,face2_id,similarity,status) VALUES('pair1','session','f1','f2',.7,'pending');
    INSERT INTO photo_links(id,session_id,photo1_id,photo2_id,link_type,score,status) VALUES
      ('burst1','session','photo','other','burst',.8,'pending'),
      ('appear1','session','photo','other','appearance',.9,'pending');
  `);
  const send = (path, body) => worker.fetch(new Request(`https://api.test${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, {});
  await send('/api/admin/confirm-match', { pairId: 'pair1', confirmed: true });
  await send('/api/admin/confirm-link', { linkId: 'burst1', confirmed: false });
  await send('/api/admin/confirm-link', { linkId: 'appear1', confirmed: true });

  const rows = sql.prepare('SELECT source, face_similarity, burst_score, appearance_similarity, label FROM match_feedback ORDER BY source').all().map(row => ({ ...row }));
  assert.deepEqual(rows, [
    { source: 'appearance_link', face_similarity: null, burst_score: null, appearance_similarity: .9, label: 1 },
    { source: 'burst_link', face_similarity: null, burst_score: .8, appearance_similarity: null, label: 0 },
    { source: 'face_pair', face_similarity: .7, burst_score: null, appearance_similarity: null, label: 1 },
  ]);
});
test('retraining requires enough labeled reviews of both classes, and fits weights that favor the confirmed direction once available', async context => {
  const { env, sql, token } = await setup(context);
  const send = (path, body) => worker.fetch(new Request(`https://api.test${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, {});

  // Below MIN_FEEDBACK_FOR_TRAINING (20): retraining is a no-op, defaults stay in place.
  for (let i = 0; i < 5; i++) sql.prepare("INSERT INTO match_feedback(id,source,burst_score,label) VALUES(?,'burst_link',.9,1)").run(`few-${i}`);
  let result = await (await send('/api/admin/retrain', {})).json();
  assert.deepEqual(result, { trained: false, reviewCount: 5 });
  assert.equal(sql.prepare('SELECT trained_on FROM match_weights WHERE id=1').get().trained_on, 0);

  // Clearly separable synthetic data: high burst_score confirmed, low burst_score rejected.
  for (let i = 0; i < 12; i++) sql.prepare("INSERT INTO match_feedback(id,source,burst_score,label) VALUES(?,'burst_link',.9,1)").run(`hi-${i}`);
  for (let i = 0; i < 12; i++) sql.prepare("INSERT INTO match_feedback(id,source,burst_score,label) VALUES(?,'burst_link',.1,0)").run(`lo-${i}`);
  result = await (await send('/api/admin/retrain', {})).json();
  assert.equal(result.trained, true);
  assert.equal(result.reviewCount, 29);
  const weights = sql.prepare('SELECT burst_weight, trained_on FROM match_weights WHERE id=1').get();
  assert.equal(weights.trained_on, 29);
  assert.ok(weights.burst_weight > 0, 'higher burst_score should learn a positive weight toward "confirmed"');

  const queueData = await (await send('/api/admin/link-queue')).json();
  assert.equal(queueData.trainedOn, 29);
});
test('pending pairs without face coordinates do not inflate the ready count or block new pairs', async context => {
  const { env, sql, token } = await setup(context);
  sql.exec("UPDATE photos SET indexing_status='completed'; INSERT INTO photos(id,session_id,object_key,preview_key,filename,content_type,indexing_status) VALUES('other','session','o2','v2','other.jpg','image/jpeg','completed'); INSERT INTO faces(id,photo_id,embedding_json,bbox_json) VALUES('a','photo','[1,0]',NULL),('b','other','[0.62,0.7846]',NULL),('c','photo','[1,0]','[10,10,20,20]'),('d','other','[0.62,0.7846]','[20,20,20,20]'); INSERT INTO face_verifications(id,session_id,face1_id,face2_id,similarity,status) VALUES('hidden','session','a','b',.62,'pending');");
  const response = await worker.fetch(new Request('https://api.test/api/admin/verify-queue', { headers: { Authorization: `Bearer ${token}` } }), env, {});
  assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.stats.unavailable, 1); assert.equal(body.stats.pending, 1); assert.equal(body.queue.length, 1);
});

test('a crew-confirmed link surfaces its linked photo to a matching guest, but pending and rejected links never do', async context => {
  const { env, sql } = await setup(context);
  sql.exec(`
    UPDATE sessions SET status='published';
    UPDATE photos SET indexing_status='completed' WHERE id='photo';
    INSERT INTO photos(id,session_id,object_key,preview_key,filename,content_type,indexing_status) VALUES
      ('linked','session','oL','vL','linked.jpg','image/jpeg','completed'),
      ('pendingLinked','session','oP','vP','pendingLinked.jpg','image/jpeg','completed'),
      ('rejectedLinked','session','oR','vR','rejectedLinked.jpg','image/jpeg','completed');
    INSERT INTO faces(id,photo_id,embedding_json) VALUES('anchorFace','photo','[1,0]');
    INSERT INTO photo_links(id,session_id,photo1_id,photo2_id,link_type,score,status) VALUES
      ('confirmedLink','session','photo','linked','burst',.8,'confirmed'),
      ('pendingLink','session','photo','pendingLinked','burst',.8,'pending'),
      ('rejectedLink','session','photo','rejectedLinked','burst',.8,'rejected');
  `);
  context.mock.method(globalThis, 'fetch', async () => Response.json({ faces: [{ embedding: [1, 0] }] }));
  const form = new FormData();
  form.append('sessionId', 'session'); form.append('consent', 'true');
  form.append('file', new Blob(['selfie'], { type: 'image/jpeg' }), 'selfie.jpg');
  const response = await worker.fetch(new Request('https://api.test/api/match', { method: 'POST', body: form }), env, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.previews.map(p => p.photoId).sort(), ['linked', 'photo']);
  const search = sql.prepare('SELECT matched_photo_ids_json FROM searches').get();
  assert.deepEqual(JSON.parse(search.matched_photo_ids_json).sort(), ['linked', 'photo']);
});

test('indexing stores a clothing appearance descriptor when the face service returns one', async context => {
  const { sql, enqueue, consume } = await setup(context);
  context.mock.method(globalThis, 'fetch', async () => Response.json({ faces: [], captured_at: null, appearance: { bbox_norm: [10, 10, 50, 80], histogram: [1, 0, 0] } }));
  await enqueue(); await consume();
  const row = sql.prepare('SELECT bbox_json, histogram_json FROM photo_appearances WHERE photo_id=?').get('photo');
  assert.deepEqual(JSON.parse(row.bbox_json), [10, 10, 50, 80]);
  assert.deepEqual(JSON.parse(row.histogram_json), [1, 0, 0]);
});
test('re-indexing without a detectable person removes the stale appearance descriptor', async context => {
  const { sql, enqueue, consume } = await setup(context);
  sql.exec("INSERT INTO photo_appearances(photo_id,histogram_json) VALUES('photo','[1,0,0]')");
  context.mock.method(globalThis, 'fetch', async () => Response.json({ faces: [], captured_at: null }));
  await enqueue(); await consume();
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM photo_appearances').get().n, 0);
});
test('appearance links surface a faceless photo whose clothing matches a photo with a detected face, gated by APPEARANCE_THRESHOLD', async context => {
  const { env, sql, token } = await setup(context);
  sql.exec(`
    UPDATE photos SET indexing_status='completed' WHERE id='photo';
    INSERT INTO photos(id,session_id,object_key,preview_key,filename,content_type,indexing_status) VALUES
      ('faceless','session','oF','vF','faceless.jpg','image/jpeg','completed'),
      ('dissimilar','session','oD','vD','dissimilar.jpg','image/jpeg','completed');
    INSERT INTO faces(id,photo_id,embedding_json) VALUES ('faceOnPhoto','photo','[1,0]');
    INSERT INTO photo_appearances(photo_id,histogram_json) VALUES
      ('photo','[1,0,0]'),
      ('faceless','[0.99,0.01,0]'),
      ('dissimilar','[0,1,0]');
  `);
  // faceless's clothing histogram is nearly identical to photo's (which has a detected face);
  // dissimilar's is orthogonal, so it must stay below APPEARANCE_THRESHOLD (default 0.85).
  const send = (path, body) => worker.fetch(new Request(`https://api.test${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, {});
  assert.equal((await (await send('/api/admin/link-queue/scan', {})).json()).generated, 1);
  const data = await (await send('/api/admin/link-queue')).json();
  assert.equal(data.queue.length, 1);
  assert.equal(data.queue[0].linkType, 'appearance');
  assert.deepEqual([data.queue[0].photo1.id, data.queue[0].photo2.id].sort(), ['faceless', 'photo']);
});
test('burst links auto-confirm on generation, skip pairs direct matching already covers, and never enter the review queue', async context => {
  const { env, sql, token } = await setup(context);
  sql.exec(`
    UPDATE photos SET indexing_status='completed' WHERE id='photo';
    INSERT INTO photos(id,session_id,object_key,preview_key,filename,content_type,indexing_status,captured_at) VALUES
      ('burstA','session','oA','vA','burstA.jpg','image/jpeg','completed','2026-09-15T08:30:00.000Z'),
      ('burstB','session','oB','vB','burstB.jpg','image/jpeg','completed','2026-09-15T08:30:01.000Z'),
      ('coveredC','session','oC','vC','coveredC.jpg','image/jpeg','completed','2026-09-15T08:31:00.000Z'),
      ('coveredD','session','oD','vD','coveredD.jpg','image/jpeg','completed','2026-09-15T08:31:01.000Z'),
      ('lonelyE','session','oE','vE','lonelyE.jpg','image/jpeg','completed','2026-09-15T08:40:00.000Z'),
      ('lonelyF','session','oF','vF','lonelyF.jpg','image/jpeg','completed','2026-09-15T08:45:00.000Z');
    INSERT INTO faces(id,photo_id,embedding_json) VALUES
      ('faceA','burstA','[1,0]'),
      ('faceC','coveredC','[1,0]'),
      ('faceD','coveredD','[1,0]');
  `);
  // burstB has no detected face at all; coveredC/D have identical embeddings (already a confident
  // direct match); lonelyE/F sit far apart in time from anything, so neither is a burst at all.
  const send = (path, body) => worker.fetch(new Request(`https://api.test${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, {});
  assert.equal((await (await send('/api/admin/link-queue/scan', {})).json()).generated, 1);

  // Burst links skip crew review entirely — the row lands 'confirmed' as soon as it's generated.
  const row = sql.prepare("SELECT id, status, photo1_id, photo2_id FROM photo_links WHERE link_type='burst'").get();
  assert.equal(row.status, 'confirmed');
  assert.deepEqual([row.photo1_id, row.photo2_id].sort(), ['burstA', 'burstB']);

  const response = await send('/api/admin/link-queue'); assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.queue.length, 0);
  assert.equal(data.stats.pending, 0);
  assert.equal(data.stats.confirmed, 1);

  // Already confirmed automatically, so confirm-link can no longer act on it — but it still
  // validates the request shape before touching the row.
  assert.equal((await send('/api/admin/confirm-link', { linkId: row.id, confirmed: 'false' })).status, 400);
  assert.equal((await send('/api/admin/confirm-link', { linkId: row.id, confirmed: true })).status, 409);
  assert.equal((await (await send('/api/admin/link-queue/scan', {})).json()).generated, 0);
});
test('a burst link left over as pending from before auto-confirm sweeps to confirmed on queue fetch', async context => {
  const { env, sql, token } = await setup(context);
  sql.exec(`
    INSERT INTO photos(id,session_id,object_key,preview_key,filename,content_type,indexing_status) VALUES
      ('legacyA','session','oA','vA','legacyA.jpg','image/jpeg','completed'),
      ('legacyB','session','oB','vB','legacyB.jpg','image/jpeg','completed');
    INSERT INTO photo_links(id,session_id,photo1_id,photo2_id,link_type,score,status) VALUES
      ('legacy-link','session','legacyA','legacyB','burst',0.9,'pending');
  `);
  const send = path => worker.fetch(new Request(`https://api.test${path}`, { headers: { Authorization: `Bearer ${token}` } }), env, {});
  const data = await (await send('/api/admin/link-queue')).json();
  assert.equal(data.queue.length, 0);
  assert.equal(sql.prepare("SELECT status FROM photo_links WHERE id='legacy-link'").get().status, 'confirmed');
});

// ── Quotas and revocable crew tokens against a real SQLite schema (migrations 0010 / 0011) ──
// The Worker suite mocks the D1 rows; these prove the SQL itself: the upsert's window arithmetic,
// the sweep's text comparison and the admin_sessions round trip.
test('the search quota upsert counts within a window, resets once the window has passed, and sweeps stale rows', async context => {
  const { env, sql } = await setup(context);
  sql.exec("UPDATE sessions SET status='published'; UPDATE photos SET indexing_status='completed'; INSERT INTO faces(id,photo_id,embedding_json) VALUES('f','photo','[1,0]')");
  context.mock.method(globalThis, 'fetch', async () => Response.json({ faces: [{ embedding: [1, 0] }] }));
  const search = () => {
    const form = new FormData(); form.append('sessionId', 'session'); form.append('consent', 'true'); form.append('file', new Blob(['selfie'], { type: 'image/jpeg' }), 'selfie.jpg');
    return worker.fetch(new Request('https://api.test/api/match', { method: 'POST', headers: { 'cf-connecting-ip': '198.51.100.1' }, body: form }), env, {});
  };
  for (let i = 0; i < 8; i++) assert.equal((await search()).status, 200);
  const blocked = await search(); assert.equal(blocked.status, 429);
  const retry = Number(blocked.headers.get('retry-after')); assert.ok(retry > 0 && retry <= 600, `retry-after ${retry}`);
  assert.deepEqual(sql.prepare('SELECT key, count FROM rate_limits ORDER BY key').all().map(row => ({ ...row })), [{ key: 'match:10m:198.51.100.1', count: 9 }, { key: 'match:1d:198.51.100.1', count: 9 }]);
  // Age the ten-minute window past its end: the next search opens a fresh window and is allowed,
  // while the untouched daily window keeps counting.
  sql.exec("UPDATE rate_limits SET window_start = datetime('now', '-11 minutes') WHERE key LIKE 'match:10m:%'");
  assert.equal((await search()).status, 200);
  assert.equal(sql.prepare("SELECT count FROM rate_limits WHERE key = 'match:10m:198.51.100.1'").get().count, 1);
  assert.equal(sql.prepare("SELECT count FROM rate_limits WHERE key = 'match:1d:198.51.100.1'").get().count, 10);
  // Rows older than the longest window are swept by the next search.
  sql.exec("INSERT INTO rate_limits(key,count,window_start) VALUES('match:10m:stale', 3, datetime('now', '-2 days'))");
  assert.equal((await search()).status, 200);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key = 'match:10m:stale'").get().n, 0);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM searches').get().n, 10, 'refused searches never create a search record');
});
test('crew sign-in records an admin_sessions row, requests touch last_seen_at, and sign-out revokes it', async context => {
  const { env, sql, token } = await setup(context);
  const row = sql.prepare('SELECT * FROM admin_sessions').get();
  assert.ok(row?.expires_at && !row.revoked_at && !row.last_seen_at);
  const dashboard = () => worker.fetch(new Request('https://api.test/api/admin/dashboard', { headers: { Authorization: `Bearer ${token}` } }), env, {});
  assert.equal((await dashboard()).status, 200);
  assert.ok(sql.prepare('SELECT last_seen_at FROM admin_sessions').get().last_seen_at);
  const logout = await worker.fetch(new Request('https://api.test/api/admin/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }), env, {});
  assert.equal(logout.status, 200); assert.deepEqual(await logout.json(), { ok: true });
  assert.ok(sql.prepare('SELECT revoked_at FROM admin_sessions').get().revoked_at);
  assert.equal((await dashboard()).status, 401);
});
