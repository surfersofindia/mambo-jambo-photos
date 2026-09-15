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
test('reindex queues immediately, deduplicates clicks, and commits detected faces', async context => {
  const { sql, messages, enqueue, consume } = await setup(context);
  let requests = 0; context.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json([{ embedding: [1, 0], confidence: .99 }]); });
  const response = await enqueue(); assert.equal(response.status, 202); assert.deepEqual(await response.json(), { queued: 1, alreadyQueued: 0, failed: 0 });
  assert.equal(requests, 0); assert.equal(messages.length, 1);
  assert.deepEqual(await (await enqueue()).json(), { queued: 0, alreadyQueued: 1, failed: 0 });
  assert.deepEqual(await consume(), { ack: true, retry: false });
  assert.equal(sql.prepare('SELECT indexing_status FROM photos').get().indexing_status, 'completed');
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM faces').get().n, 1);
  await consume(); assert.equal(requests, 1);
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
  context.mock.method(globalThis, 'fetch', async () => Response.json([])); await enqueue(); await consume();
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
