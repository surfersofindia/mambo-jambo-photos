/**
 * Mambo Jambo photo API — Cloudflare Worker + D1 + R2.
 *
 * Secrets set with `wrangler secret put`:
 *   ADMIN_PASSWORD, SESSION_SECRET, CASHFREE_APP_ID, CASHFREE_SECRET_KEY
 * (Cashfree signs webhooks with the same CASHFREE_SECRET_KEY, not a separate secret.)
 * Vars: CASHFREE_ENV ('sandbox' or 'production', defaults to 'sandbox')
 */

const encoder = new TextEncoder();
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra },
});
const id = () => crypto.randomUUID();
const dateAfterMinutes = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const base64url = (value) => btoa(typeof value === 'string' ? value : JSON.stringify(value))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const fromBase64url = (value) => atob(value.replace(/-/g, '+').replace(/_/g, '/'));

function cors(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean);
  return {
    ...(origin && allowed.includes(origin) ? { 'access-control-allow-origin': origin } : {}),
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}
class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
async function boundedBody(request, maxBytes) {
  if (Number(request.headers.get('content-length')) > maxBytes) throw new RequestError('The upload is too large.', 413);
  if (!request.body) throw new RequestError('A request body is required.');
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new RequestError('The upload is too large.', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new Blob(chunks, { type: request.headers.get('content-type') || '' });
}
async function readForm(request, maxBytes) {
  const body = await boundedBody(request, maxBytes);
  // Blob.type lowercases MIME parameters; multipart boundaries are case-sensitive.
  try { return await new Response(body, { headers: { 'content-type': request.headers.get('content-type') || '' } }).formData(); }
  catch { throw new RequestError('Choose a valid image upload.'); }
}

// Streaming upload body layout: [uint32 preview length LE][preview JPEG bytes][original bytes].
// The small preview is buffered; the large original is piped straight to R2 so a
// batch of big photos never stacks up in the isolate's memory (which dropped connections).
async function readFramedUpload(request, maxPreview) {
  if (!request.body) throw new RequestError('A request body is required.');
  const reader = request.body.getReader();
  let buf = new Uint8Array(0); let ended = false;
  const pull = async () => {
    const r = await reader.read();
    if (r.done) { ended = true; return; }
    const merged = new Uint8Array(buf.length + r.value.length); merged.set(buf); merged.set(r.value, buf.length); buf = merged;
  };
  while (buf.length < 4 && !ended) await pull();
  if (buf.length < 4) throw new RequestError('The upload is incomplete.', 400);
  const previewLen = new DataView(buf.buffer, buf.byteOffset, buf.length).getUint32(0, true);
  if (!previewLen || previewLen > maxPreview) { await reader.cancel(); throw new RequestError('The upload preview is invalid.', 400); }
  while (buf.length < 4 + previewLen && !ended) await pull();
  if (buf.length < 4 + previewLen) throw new RequestError('The upload is incomplete.', 400);
  const preview = buf.slice(4, 4 + previewLen);
  if (preview[0] !== 0xFF || preview[1] !== 0xD8) throw new RequestError('The upload preview is invalid.', 400);
  const leftover = buf.slice(4 + previewLen);
  // R2.put only accepts a stream of known length, so pump the original (already-read leftover
  // plus the rest of the request) through the readable half of a FixedLengthStream.
  const originalLength = Number(request.headers.get('content-length')) - 4 - previewLen;
  if (!Number.isFinite(originalLength) || originalLength < 0) throw new RequestError('The upload is incomplete.', 400);
  const passthrough = new FixedLengthStream(originalLength);
  (async () => {
    const writer = passthrough.writable.getWriter();
    try {
      if (leftover.length) await writer.write(leftover);
      while (true) { const r = await reader.read(); if (r.done) break; await writer.write(r.value); }
      await writer.close();
    } catch (streamError) { await writer.abort(streamError).catch(() => {}); }
  })();
  return { preview, original: passthrough.readable };
}

// Shared finalize step for both the legacy multipart upload and the streaming upload:
// resolve the filename against duplicates, store both objects, insert the row, clean up
// a replaced photo, and enqueue indexing. `original` may be a File or a ReadableStream.
async function storeSessionPhoto(env, request, sessionId, { filename, contentType, original, preview, onDuplicate }) {
  let name = safeFilename(filename); let duplicates = [];
  if (onDuplicate) {
    duplicates = (await env.DB.prepare('SELECT id, object_key, preview_key FROM photos WHERE session_id = ? AND filename = ? COLLATE NOCASE').bind(sessionId, name).all()).results;
    if (duplicates.length && onDuplicate === 'skip') return response({ skipped: true, filename: name }, request, env);
    if (duplicates.length && onDuplicate === 'rename') {
      const taken = new Set((await env.DB.prepare('SELECT filename FROM photos WHERE session_id = ?').bind(sessionId).all()).results.map(row => row.filename.toLowerCase()));
      name = uniqueFilename(name, taken);
    }
  }
  const photoId = id(); const objectKey = `sessions/${sessionId}/original/${photoId}-${name}`; const previewKey = `sessions/${sessionId}/preview/${photoId}.jpg`;
  // Store the streamed original first, then the buffered preview.
  await env.PHOTOS.put(objectKey, original, { httpMetadata: { contentType } });
  await env.PHOTOS.put(previewKey, preview, { httpMetadata: { contentType: 'image/jpeg' } });
  await env.DB.prepare("INSERT INTO photos (id, session_id, object_key, preview_key, filename, content_type, indexing_status) VALUES (?, ?, ?, ?, ?, ?, 'pending')").bind(photoId, sessionId, objectKey, previewKey, name, contentType).run();
  if (duplicates.length && onDuplicate === 'replace') {
    // Remove the old rows before their files so a failed delete never leaves a photo pointing at missing media.
    await env.DB.batch(duplicates.flatMap(photo => [env.DB.prepare('DELETE FROM faces WHERE photo_id = ?').bind(photo.id), env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(photo.id)]));
    await Promise.all(duplicates.flatMap(photo => [env.PHOTOS.delete(photo.object_key), env.PHOTOS.delete(photo.preview_key)]));
  }
  const processing = await enqueuePhotos([{ id: photoId }], env);
  return response({ photoId, filename: name, status: processing.failed ? 'failed' : 'pending', duplicate: duplicates.length ? (onDuplicate === 'replace' ? 'replaced' : 'renamed') : null, replaced: onDuplicate === 'replace' ? duplicates.length : 0 }, request, env, 201);
}
async function readJson(request) {
  const body = await boundedBody(request, 16384);
  try {
    const data = JSON.parse(await body.text());
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new RequestError('Send a valid JSON object.'); }
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T12:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validateSession(data, partial = false) {
  for (const field of ['title', 'location']) {
    if ((!partial || data[field] !== undefined) && (typeof data[field] !== 'string' || !data[field].trim() || data[field].trim().length > 80)) throw new RequestError('Session name and location must contain 1–80 characters.');
  }
  if ((!partial || data.date !== undefined) && !validDate(data.date)) throw new RequestError('Choose a valid session date.');
  if ((!partial || data.pricePaise !== undefined) && (!Number.isSafeInteger(Number(data.pricePaise)) || Number(data.pricePaise) < 100)) throw new RequestError('Enter a valid future photo-pack price.');
  if (data.status !== undefined && !['draft', 'published', 'archived'].includes(data.status)) throw new RequestError('Choose a valid session status.');
}
function response(data, request, env, status = 200) {
  return json(data, status, cors(request, env));
}
function error(message, request, env, status = 400) {
  return response({ error: message }, request, env, status);
}
async function hmac(value, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hmacBase64(value, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b || a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
async function sign(payload, env) {
  const encoded = base64url(payload);
  return `${encoded}.${await hmac(encoded, env.SESSION_SECRET)}`;
}
async function verify(token, env) {
  if (!token || !env.SESSION_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  if (!encoded || !same(await hmac(encoded, env.SESSION_SECRET), signature)) return null;
  try {
    const payload = JSON.parse(fromBase64url(encoded));
    return payload.exp && payload.exp > Date.now() ? payload : null;
  } catch { return null; }
}
async function requireAdmin(request, env) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const payload = await verify(token, env);
  return payload?.role === 'admin' ? payload : null;
}
async function requireSearch(request, env, searchId) {
  const token = new URL(request.url).searchParams.get('token') || request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const payload = await verify(token, env);
  return payload?.scope === 'search' && payload.searchId === searchId ? payload : null;
}
function safeFilename(filename) {
  return (filename || 'photo.jpg').replace(/[^a-zA-Z0-9._-]/g, '-').slice(-120);
}
const DUPLICATE_MODES = ['replace', 'skip', 'rename'];
// Append -2, -3, … before the extension until the name is unused in the session.
function uniqueFilename(filename, taken) {
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename; const ext = dot > 0 ? filename.slice(dot) : '';
  for (let n = 2; ; n += 1) { const candidate = `${base}-${n}${ext}`; if (!taken.has(candidate.toLowerCase())) return candidate; }
}
function similarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return -1;
  let dot = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return dot / (Math.sqrt(aa) * Math.sqrt(bb));
}
// Cosine similarity over normalized clothing-color histograms — same shape as similarity() above,
// separate name because the vectors come from a different signal (appearance, not a face embedding).
const histogramSimilarity = similarity;
const MEDIA_TOKEN_MINUTES = { preview: 45, thumb: 45, original: 30 };
async function mediaToken(photoId, variant, env, minutes = MEDIA_TOKEN_MINUTES[variant] || 20) {
  return sign({ scope: 'media', photoId, variant, exp: Date.now() + minutes * 60_000 }, env);
}
async function mediaLink(base, photoId, variant, env, extra = '') {
  return `${base}/api/media/${photoId}?variant=${variant}&token=${encodeURIComponent(await mediaToken(photoId, variant, env))}${extra}`;
}
// `photos.thumb_key` arrived in migration 0008. Detect it once per isolate so every read keeps
// working (without thumbnails) on a database that has not been migrated yet.
const columnCache = new WeakMap(); // per D1 binding, so a fresh binding (or test double) re-checks
async function hasColumn(env, table, column) {
  if (!env.DB || typeof env.DB !== 'object') return false;
  if (!columnCache.has(env.DB)) columnCache.set(env.DB, new Map());
  const cache = columnCache.get(env.DB); const key = `${table}.${column}`;
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      try { const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all(); return (info.results || []).some(row => row.name === column); }
      catch { return false; }
    })());
  }
  return cache.get(key);
}
async function thumbColumn(env) { return (await hasColumn(env, 'photos', 'thumb_key')) ? ', thumb_key' : ''; }
// Grid tiles use the small thumbnail when one exists and fall back to the 1400px preview otherwise.
async function previewLinks(base, photo, env) {
  const url = await mediaLink(base, photo.id, 'preview', env);
  return { url, thumbUrl: photo.thumb_key ? await mediaLink(base, photo.id, 'thumb', env) : url };
}
async function previewPayload(search, request, env) {
  const photoIds = JSON.parse(search.matched_photo_ids_json);
  if (!photoIds.length) return [];
  const rows = await env.DB.prepare(`SELECT id${await thumbColumn(env)} FROM photos WHERE session_id = ? AND id IN (${photoIds.map(() => '?').join(',')})`)
    .bind(search.session_id, ...photoIds).all();
  const base = new URL(request.url).origin;
  return Promise.all(rows.results.map(async photo => ({ photoId: photo.id, ...(await previewLinks(base, photo, env)) })));
}
async function accessPayload(search, request, env) {
  const photoIds = JSON.parse(search.matched_photo_ids_json);
  if (!photoIds.length) return [];
  const rows = await env.DB.prepare(`SELECT id${await thumbColumn(env)} FROM photos WHERE session_id = ? AND id IN (${photoIds.map(() => '?').join(',')})`)
    .bind(search.session_id, ...photoIds).all();
  const base = new URL(request.url).origin;
  return Promise.all(rows.results.map(async photo => {
    const url = await mediaLink(base, photo.id, 'original', env);
    return { photoId: photo.id, url, downloadUrl: `${url}&download=1`, thumbUrl: photo.thumb_key ? await mediaLink(base, photo.id, 'thumb', env) : url };
  }));
}
// ── Download all: a stored (uncompressed) ZIP streamed straight out of R2 ──────
// JPEGs don't compress, so STORE keeps the Worker's cost to one CRC pass per byte and
// lets the archive stream without ever buffering a photo. Data descriptors (flag bit 3)
// put each entry's CRC/size after its bytes, so nothing is read twice. No ZIP64: a
// pack is refused above 4 GiB, which is far beyond any session pack.
const CRC_TABLE = Int32Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(crc, bytes) { crc = ~crc; for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8); return ~crc; }
const le16 = value => [value & 255, (value >>> 8) & 255];
const le32 = value => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
function dosDateTime(date = new Date()) {
  return { time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1), date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate() };
}
const ZIP_FLAGS = 0x0808; // bit 3: data descriptor follows the data · bit 11: UTF-8 names
function zipLocalHeader(name, stamp) { return Uint8Array.from([...le32(0x04034B50), ...le16(20), ...le16(ZIP_FLAGS), ...le16(0), ...le16(stamp.time), ...le16(stamp.date), ...le32(0), ...le32(0), ...le32(0), ...le16(name.length), ...le16(0), ...name]); }
function zipDescriptor(crc, size) { return Uint8Array.from([...le32(0x08074B50), ...le32(crc), ...le32(size), ...le32(size)]); }
function zipCentralEntry(entry, stamp) { return Uint8Array.from([...le32(0x02014B50), ...le16(20), ...le16(20), ...le16(ZIP_FLAGS), ...le16(0), ...le16(stamp.time), ...le16(stamp.date), ...le32(entry.crc), ...le32(entry.size), ...le32(entry.size), ...le16(entry.name.length), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(entry.offset), ...entry.name]); }
function zipEnd(count, cdSize, cdOffset) { return Uint8Array.from([...le32(0x06054B50), ...le16(0), ...le16(0), ...le16(count), ...le16(count), ...le32(cdSize), ...le32(cdOffset), ...le16(0)]); }
// Exact archive length when every object size is known up front, so the browser can show progress.
function zipLength(files) { return files.reduce((sum, file) => sum + 30 + file.name.length + file.size + 16 + 46 + file.name.length, 0) + 22; }
function zipStream(files, env, onError) {
  const { readable, writable } = new TransformStream();
  const stamp = dosDateTime();
  const pump = (async () => {
    const writer = writable.getWriter();
    try {
      let offset = 0; const entries = [];
      for (const file of files) {
        const object = await env.PHOTOS.get(file.key);
        if (!object) throw new Error(`Missing object ${file.key}`);
        const header = zipLocalHeader(file.name, stamp); await writer.write(header);
        const start = offset; offset += header.length;
        let crc = 0, size = 0;
        const body = object.body instanceof ReadableStream ? object.body : new Response(object.body).body;
        const reader = body.getReader();
        for (;;) { const { value, done } = await reader.read(); if (done) break; crc = crc32(crc, value); size += value.length; await writer.write(value); }
        const descriptor = zipDescriptor(crc >>> 0, size); await writer.write(descriptor); offset += size + descriptor.length;
        entries.push({ name: file.name, crc: crc >>> 0, size, offset: start });
      }
      const cdOffset = offset; let cdSize = 0;
      for (const entry of entries) { const record = zipCentralEntry(entry, stamp); cdSize += record.length; await writer.write(record); }
      await writer.write(zipEnd(entries.length, cdSize, cdOffset));
      await writer.close();
    } catch (err) { onError?.(err); await writer.abort(err).catch(() => {}); }
  })();
  return { readable, pump };
}
async function sessionSummary(env, sessionId) {
  const session = await env.DB.prepare('SELECT title, session_date AS date, location FROM sessions WHERE id = ?').bind(sessionId).first();
  return session ? { title: session.title, date: session.date, location: session.location } : null;
}
// A shared crew password with unlimited attempts is brute-forceable; count failures per IP in D1
// (migration 0008). If that table is missing the check is skipped rather than locking the crew out.
const LOGIN_WINDOW_MINUTES = 15, LOGIN_MAX_FAILURES = 5;
async function loginThrottle(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const check = async () => {
    try {
      const row = await env.DB.prepare('SELECT count, window_start FROM login_attempts WHERE ip = ?').bind(ip).first();
      if (!row) return 0;
      const started = Date.parse(`${row.window_start}Z`) || Date.parse(row.window_start) || 0;
      if (Date.now() - started > LOGIN_WINDOW_MINUTES * 60_000) return 0;
      return Number(row.count) || 0;
    } catch { return 0; }
  };
  return {
    blocked: (await check()) >= LOGIN_MAX_FAILURES,
    async failed() {
      try {
        await env.DB.prepare(`INSERT INTO login_attempts (ip, count, window_start) VALUES (?, 1, CURRENT_TIMESTAMP)
          ON CONFLICT(ip) DO UPDATE SET count = CASE WHEN (julianday(CURRENT_TIMESTAMP) - julianday(window_start)) * 1440 > ? THEN 1 ELSE count + 1 END,
            window_start = CASE WHEN (julianday(CURRENT_TIMESTAMP) - julianday(window_start)) * 1440 > ? THEN CURRENT_TIMESTAMP ELSE window_start END`)
          .bind(ip, LOGIN_WINDOW_MINUTES, LOGIN_WINDOW_MINUTES).run();
      } catch { /* Table not migrated yet — login still works, just without throttling. */ }
    },
    async succeeded() { try { await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run(); } catch { /* optional */ } },
  };
}
function cashfreeBase(env) {
  return env.CASHFREE_ENV === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
}
function cashfreeHeaders(env) {
  return { 'x-client-id': env.CASHFREE_APP_ID, 'x-client-secret': env.CASHFREE_SECRET_KEY, 'x-api-version': '2025-01-01', 'content-type': 'application/json' };
}
async function cashfreeOrder(search, paymentId, customer, siteOrigin, workerOrigin, env) {
  const result = await fetch(`${cashfreeBase(env)}/orders`, {
    method: 'POST',
    headers: cashfreeHeaders(env),
    body: JSON.stringify({
      order_id: `mj-${paymentId}`,
      order_amount: Number((search.price_paise / 100).toFixed(2)),
      order_currency: search.currency,
      customer_details: { customer_id: `guest-${search.id}`, customer_phone: customer.phone, ...(customer.email ? { customer_email: customer.email } : {}) },
      order_meta: { return_url: `${siteOrigin}/`, notify_url: `${workerOrigin}/api/payment/webhook` },
    }),
  });
  if (!result.ok) throw new Error('Cashfree could not create an order. Check your live/test keys.');
  return result.json();
}
async function cashfreeOrderStatus(orderId, env) {
  const result = await fetch(`${cashfreeBase(env)}/orders/${encodeURIComponent(orderId)}`, { headers: cashfreeHeaders(env) });
  if (!result.ok) return null;
  return result.json();
}

async function extractFaces(file, env) {
  if (!env.FACE_API_URL) throw new RequestError('Face matching is temporarily unavailable.', 503);
  const form = new FormData(); form.append('file', file, 'image.jpg');
  let result;
  try { result = await fetch(env.FACE_API_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(75000) }); }
  catch { throw new RequestError('The face service took too long to respond. Please try again shortly.', 503); }
  if (!result.ok) throw new RequestError('The face service is temporarily unavailable. Please try again shortly.', 503);
  let body;
  try { body = await result.json(); } catch { throw new RequestError('The face service returned an unreadable result.', 503); }
  const faces = body?.faces;
  if (!Array.isArray(faces) || faces.some(face => !Array.isArray(face?.embedding) || !face.embedding.length || !face.embedding.every(Number.isFinite) || !face.embedding.some(value => value !== 0))) throw new RequestError('The face service returned an invalid result.', 503);
  const capturedAt = typeof body.captured_at === 'string' && Number.isFinite(Date.parse(body.captured_at)) ? body.captured_at : null;
  const rawAppearance = body.appearance;
  const appearance = rawAppearance && Array.isArray(rawAppearance.histogram) && rawAppearance.histogram.length && rawAppearance.histogram.every(Number.isFinite)
    ? { bboxNorm: Array.isArray(rawAppearance.bbox_norm) ? rawAppearance.bbox_norm : null, histogram: rawAppearance.histogram }
    : null;
  return { faces, capturedAt, appearance };
}
async function enqueuePhotos(photos, env) {
  if (!env.INDEX_QUEUE) throw new RequestError('Photo processing is not configured. Please contact the crew.', 503);
  let queued = 0, alreadyQueued = 0, failed = 0;
  for (const photo of photos) {
    const jobId = id();
    const claim = await env.DB.prepare(`INSERT INTO indexing_jobs (photo_id, job_id, status) VALUES (?, ?, 'queued')
      ON CONFLICT(photo_id) DO UPDATE SET job_id = excluded.job_id, status = 'queued', attempts = 0, error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE indexing_jobs.status NOT IN ('queued', 'processing')`).bind(photo.id, jobId).run();
    if (!claim.meta?.changes) { alreadyQueued++; continue; }
    try {
      await env.DB.prepare("UPDATE photos SET indexing_status = 'pending' WHERE id = ?").bind(photo.id).run();
      await env.INDEX_QUEUE.send({ photoId: photo.id, jobId });
      queued++;
    } catch {
      await env.DB.batch([
        env.DB.prepare("UPDATE photos SET indexing_status = 'failed' WHERE id = ?").bind(photo.id),
        env.DB.prepare("UPDATE indexing_jobs SET status = 'failed', error = 'Could not queue photo. Retry processing.', updated_at = CURRENT_TIMESTAMP WHERE photo_id = ? AND job_id = ?").bind(photo.id, jobId)
      ]);
      failed++;
    }
  }
  return { queued, alreadyQueued, failed };
}
async function consumePhoto(message, env) {
  const { photoId, jobId } = message.body || {};
  if (!photoId || !jobId) { message.ack(); return; }
  const job = await env.DB.prepare('SELECT p.object_key, j.job_id, j.status FROM photos p JOIN indexing_jobs j ON j.photo_id = p.id WHERE p.id = ?').bind(photoId).first();
  if (!job || job.job_id !== jobId || ['completed', 'failed'].includes(job.status)) { message.ack(); return; }
  try {
    await env.DB.prepare("UPDATE indexing_jobs SET status = 'processing', attempts = ?, updated_at = CURRENT_TIMESTAMP WHERE photo_id = ? AND job_id = ?").bind(message.attempts, photoId, jobId).run();
    const object = await env.PHOTOS.get(job.object_key);
    if (!object) throw new RequestError('Original photo is missing. Upload it again.', 404);
    const { faces, capturedAt, appearance } = await extractFaces(await object.blob(), env);
    const statements = [
      env.DB.prepare('DELETE FROM face_verifications WHERE face1_id IN (SELECT id FROM faces WHERE photo_id = ?) OR face2_id IN (SELECT id FROM faces WHERE photo_id = ?)').bind(photoId, photoId),
      env.DB.prepare('DELETE FROM faces WHERE photo_id = ?').bind(photoId),
      ...faces.map(face => env.DB.prepare('INSERT INTO faces (id, photo_id, embedding_json, bbox_json, confidence) VALUES (?, ?, ?, ?, ?)').bind(id(), photoId, JSON.stringify(face.embedding), face.bbox_norm ? JSON.stringify(face.bbox_norm) : null, Number(face.confidence) || null)),
      env.DB.prepare('DELETE FROM photo_appearances WHERE photo_id = ?').bind(photoId),
      ...(appearance ? [env.DB.prepare('INSERT INTO photo_appearances (photo_id, bbox_json, histogram_json) VALUES (?, ?, ?)').bind(photoId, appearance.bboxNorm ? JSON.stringify(appearance.bboxNorm) : null, JSON.stringify(appearance.histogram))] : []),
      env.DB.prepare("UPDATE photos SET indexing_status = 'completed', captured_at = ? WHERE id = ?").bind(capturedAt, photoId),
      env.DB.prepare("UPDATE indexing_jobs SET status = 'completed', error = NULL, updated_at = CURRENT_TIMESTAMP WHERE photo_id = ? AND job_id = ?").bind(photoId, jobId)
    ];
    await env.DB.batch(statements);
    message.ack();
  } catch (error) {
    const retry = message.attempts < 4 && error.status !== 404;
    await env.DB.batch([
      env.DB.prepare('UPDATE indexing_jobs SET status = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE photo_id = ? AND job_id = ?').bind(retry ? 'queued' : 'failed', error instanceof RequestError ? error.message : 'Processing failed. Retry this photo.', photoId, jobId),
      env.DB.prepare('UPDATE photos SET indexing_status = ? WHERE id = ?').bind(retry ? 'pending' : 'failed', photoId)
    ]);
    if (retry) message.retry({ delaySeconds: 60 }); else message.ack();
  }
}

// Groups photos shot within `gapSeconds` of each other (burst-mode continuous shooting is very
// likely the same subject). photos must be pre-sorted ascending by capturedAt; null/unparsable
// timestamps are skipped rather than breaking up the surrounding sequence. Single-photo groups
// (no actual burst) are dropped.
function burstGroups(photos, gapSeconds = 2) {
  const groups = [];
  let current = null;
  for (const { id: photoId, capturedAt } of photos) {
    const t = Date.parse(capturedAt);
    if (!Number.isFinite(t)) continue;
    if (current && (t - current.lastTime) / 1000 <= gapSeconds) { current.ids.push(photoId); current.lastTime = t; }
    else { current = { ids: [photoId], lastTime: t }; groups.push(current); }
  }
  return groups.filter(group => group.ids.length > 1);
}
function faceBounds(raw) {
  let box; try { box = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  return Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) && box[0] >= 0 && box[1] >= 0 && box[2] > 0 && box[3] > 0 && box[0] + box[3] <= 100.1 && box[1] + box[2] <= 100.1 ? box : null;
}
async function generateBorderlineMatches(env, targetSessionId = null) {
  let query = `SELECT f.id as face_id, f.photo_id, f.embedding_json, f.bbox_json, p.session_id
    FROM faces f JOIN photos p ON p.id = f.photo_id
    WHERE p.indexing_status = 'completed' AND f.bbox_json IS NOT NULL`;
  if (targetSessionId) query += ' AND p.session_id = ?';
  const statement = env.DB.prepare(query);
  const faces = (await (targetSessionId ? statement.bind(targetSessionId) : statement).all()).results
    .filter(face => faceBounds(face.bbox_json)).map(face => { try { return { ...face, embedding: JSON.parse(face.embedding_json) }; } catch { return null; } }).filter(Boolean);
  const seen = await env.DB.prepare('SELECT face1_id, face2_id FROM face_verifications').all();
  const pairKey = (a, b) => [a, b].sort().join(':');
  const existing = new Set(seen.results.map(pair => pairKey(pair.face1_id, pair.face2_id)));
  const threshold = Number(env.MATCH_THRESHOLD || .62);
  const candidates = [];
  for (let i = 0; i < faces.length; i++) for (let j = i + 1; j < faces.length; j++) {
    const a = faces[i], b = faces[j];
    if (a.photo_id === b.photo_id || a.session_id !== b.session_id || existing.has(pairKey(a.face_id, b.face_id))) continue;
    const score = similarity(a.embedding, b.embedding);
    if (!Number.isFinite(score) || Math.abs(score - threshold) > .06) continue;
    const [first, second] = [a.face_id, b.face_id].sort();
    candidates.push({ first, second, sessionId: a.session_id, score });
  }
  candidates.sort((a, b) => Math.abs(a.score - threshold) - Math.abs(b.score - threshold));
  const statements = candidates.slice(0, 20).map(pair => env.DB.prepare(`INSERT OR IGNORE INTO face_verifications
    (id, session_id, face1_id, face2_id, similarity, status) VALUES (?, ?, ?, ?, ?, 'pending')`).bind(id(), pair.sessionId, pair.first, pair.second, pair.score));
  if (!statements.length) return 0;
  const results = await env.DB.batch(statements);
  return results.reduce((sum, result) => sum + Number(result.meta?.changes || 0), 0);
}

// Small hand-rolled logistic regression (gradient descent) — there is no ML library available in a
// Cloudflare Worker, and with 3 features and at most a few hundred labeled reviews, this trains in
// well under a millisecond. A null feature value on a row contributes 0 to that row's gradient, so
// signal types that never co-occur on one review (a face-pair review never carries a burst_score,
// for instance) naturally end up with independently-learned weights from one combined fit.
function fitLogisticRegression(rows, features, { epochs = 500, lr = 0.1 } = {}) {
  const weights = new Array(features.length).fill(0); let bias = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array(features.length).fill(0); let gradB = 0;
    for (const row of rows) {
      const z = bias + features.reduce((sum, f, i) => sum + weights[i] * (row[f] ?? 0), 0);
      const err = 1 / (1 + Math.exp(-z)) - row.label;
      features.forEach((f, i) => { gradW[i] += err * (row[f] ?? 0); });
      gradB += err;
    }
    features.forEach((f, i) => { weights[i] -= lr * gradW[i] / rows.length; });
    bias -= lr * gradB / rows.length;
  }
  return { weights, bias };
}
const sigmoid = z => 1 / (1 + Math.exp(-z));
// Below this many labeled reviews, a fit is too easily degenerate (e.g. a handful of confirms with
// no rejects) to trust over the untrained defaults, so scoring keeps using fixed thresholds instead.
const MIN_FEEDBACK_FOR_TRAINING = 20;
async function retrainMatchWeights(env) {
  const rows = (await env.DB.prepare('SELECT face_similarity, burst_score, appearance_similarity, label FROM match_feedback').all()).results;
  const positives = rows.filter(row => row.label === 1).length;
  if (rows.length < MIN_FEEDBACK_FOR_TRAINING || positives === 0 || positives === rows.length) {
    return { trained: false, reviewCount: rows.length };
  }
  const features = ['face_similarity', 'burst_score', 'appearance_similarity'];
  const { weights, bias } = fitLogisticRegression(rows, features);
  await env.DB.prepare(`UPDATE match_weights
    SET face_weight = ?, burst_weight = ?, appearance_weight = ?, bias = ?, trained_on = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1`).bind(weights[0], weights[1], weights[2], bias, rows.length).run();
  return { trained: true, reviewCount: rows.length };
}

// Candidate photo-level fallback links for photos a direct face match can't confidently cover:
// adjacent frames in a burst sequence whose faces (if any) don't already clear MATCH_THRESHOLD,
// plus faceless photos whose clothing appearance closely matches a photo that has a detected face.
const APPEARANCE_POOL_CAP = 150; // bounds worst-case pairwise histogram comparisons per session
async function generateFallbackLinks(env, targetSessionId = null) {
  const seen = await env.DB.prepare('SELECT photo1_id, photo2_id, link_type FROM photo_links').all();
  const linkKey = (a, b, type) => [a, b].sort().join(':') + ':' + type;
  const existing = new Set(seen.results.map(row => linkKey(row.photo1_id, row.photo2_id, row.link_type)));
  const candidates = [];

  const weights = await env.DB.prepare('SELECT burst_weight, appearance_weight, bias, trained_on FROM match_weights WHERE id = 1').first();
  const trained = Boolean(weights) && weights.trained_on >= MIN_FEEDBACK_FOR_TRAINING;

  // -- Burst-sequence candidates --
  let burstQuery = `SELECT p.id as photo_id, p.session_id, p.captured_at, f.embedding_json
    FROM photos p LEFT JOIN faces f ON f.photo_id = p.id
    WHERE p.indexing_status = 'completed' AND p.captured_at IS NOT NULL`;
  if (targetSessionId) burstQuery += ' AND p.session_id = ?';
  const burstStatement = env.DB.prepare(burstQuery);
  const burstRows = (await (targetSessionId ? burstStatement.bind(targetSessionId) : burstStatement).all()).results;

  const bySession = new Map();
  for (const row of burstRows) {
    if (!bySession.has(row.session_id)) bySession.set(row.session_id, new Map());
    const photos = bySession.get(row.session_id);
    if (!photos.has(row.photo_id)) photos.set(row.photo_id, { id: row.photo_id, capturedAt: row.captured_at, embeddings: [] });
    if (row.embedding_json) { try { photos.get(row.photo_id).embeddings.push(JSON.parse(row.embedding_json)); } catch { /* skip malformed */ } }
  }

  const threshold = Number(env.MATCH_THRESHOLD || .62);
  const gapSeconds = Number(env.BURST_GAP_SECONDS) || 2;
  for (const [sessionId, photoMap] of bySession) {
    const ordered = [...photoMap.values()].sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
    for (const group of burstGroups(ordered, gapSeconds)) {
      for (let i = 0; i < group.ids.length - 1; i++) {
        const a = photoMap.get(group.ids[i]); const b = photoMap.get(group.ids[i + 1]);
        const key = linkKey(a.id, b.id, 'burst');
        if (existing.has(key)) continue;
        let maxFaceSim = -1;
        for (const ea of a.embeddings) for (const eb of b.embeddings) maxFaceSim = Math.max(maxFaceSim, similarity(ea, eb));
        if (maxFaceSim >= threshold) continue; // direct face matching already covers this pair
        const gap = Math.abs(Date.parse(b.capturedAt) - Date.parse(a.capturedAt)) / 1000;
        const burstScore = Math.max(0, 1 - gap / gapSeconds);
        const confidence = trained ? sigmoid(weights.bias + weights.burst_weight * burstScore) : burstScore;
        if (trained && confidence < 0.5) continue;
        const [first, second] = [a.id, b.id].sort();
        candidates.push({ first, second, sessionId, linkType: 'burst', score: confidence });
      }
    }
  }

  // -- Appearance candidates: faceless photos vs. photos with a detected face, same session --
  let appearanceQuery = `SELECT p.id as photo_id, p.session_id, pa.histogram_json,
      EXISTS(SELECT 1 FROM faces f WHERE f.photo_id = p.id) as has_face
    FROM photos p JOIN photo_appearances pa ON pa.photo_id = p.id
    WHERE p.indexing_status = 'completed'`;
  if (targetSessionId) appearanceQuery += ' AND p.session_id = ?';
  const appearanceStatement = env.DB.prepare(appearanceQuery);
  const appearanceRows = (await (targetSessionId ? appearanceStatement.bind(targetSessionId) : appearanceStatement).all()).results;

  const appearanceBySession = new Map();
  for (const row of appearanceRows) {
    if (!appearanceBySession.has(row.session_id)) appearanceBySession.set(row.session_id, { faceless: [], withFace: [] });
    let histogram; try { histogram = JSON.parse(row.histogram_json); } catch { continue; }
    const pool = appearanceBySession.get(row.session_id);
    (row.has_face ? pool.withFace : pool.faceless).push({ id: row.photo_id, histogram });
  }
  const appearanceThreshold = Number(env.APPEARANCE_THRESHOLD || .85);
  for (const [sessionId, { faceless, withFace }] of appearanceBySession) {
    for (const a of faceless.slice(0, APPEARANCE_POOL_CAP)) {
      for (const b of withFace.slice(0, APPEARANCE_POOL_CAP)) {
        const key = linkKey(a.id, b.id, 'appearance');
        if (existing.has(key)) continue;
        const rawScore = histogramSimilarity(a.histogram, b.histogram);
        if (!Number.isFinite(rawScore)) continue;
        const confidence = trained ? sigmoid(weights.bias + weights.appearance_weight * rawScore) : rawScore;
        if (trained ? confidence < 0.5 : rawScore < appearanceThreshold) continue;
        const [first, second] = [a.id, b.id].sort();
        candidates.push({ first, second, sessionId, linkType: 'appearance', score: confidence });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const statements = candidates.slice(0, 20).map(pair => env.DB.prepare(`INSERT OR IGNORE INTO photo_links
    (id, session_id, photo1_id, photo2_id, link_type, score, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`).bind(id(), pair.sessionId, pair.first, pair.second, pair.linkType, pair.score));
  if (!statements.length) return 0;
  const linkResults = await env.DB.batch(statements);
  return linkResults.reduce((sum, result) => sum + Number(result.meta?.changes || 0), 0);
}

// GET /api/health — public, unauthenticated probe for the admin studio's topbar health pill and any
// uptime monitor. Each check is isolated so one failure never masks another, and only
// 'ok' / 'error' / 'skipped' ever leaves the Worker: no error text, no binding or env details.
const HEALTH_FACE_TIMEOUT_MS = 3000;
async function healthCheck(env, deep) {
  const probe = async (name, run) => {
    try { await run(); return 'ok'; }
    // Log one line per failed check for Worker logs; stack traces stay out (and nothing reaches the client).
    catch (caught) { console.error('health check failed:', name, caught?.message ?? String(caught)); return 'error'; }
  };
  const [db, r2, face] = await Promise.all([
    probe('db', async () => { if (!env.DB) throw new Error('DB binding missing'); await env.DB.prepare('SELECT 1').first(); }),
    // A missing object is a healthy answer from R2; only a thrown error means the bucket is unreachable.
    probe('r2', async () => { if (!env.PHOTOS) throw new Error('PHOTOS binding missing'); await env.PHOTOS.head('__health-probe'); }),
    // The face service is only pinged on demand (?deep=1) so a routine poll never waits on a cold
    // Hugging Face Space. Any HTTP reply — even 405 for HEAD — proves it is reachable.
    deep ? probe('face', async () => { if (!env.FACE_API_URL) throw new Error('FACE_API_URL missing'); await fetch(env.FACE_API_URL, { method: 'HEAD', signal: AbortSignal.timeout(HEALTH_FACE_TIMEOUT_MS) }); }) : 'skipped',
  ]);
  const checks = { db, r2, face };
  return { ok: Object.values(checks).every(status => status !== 'error'), checks };
}

// Named export solely for direct unit testing of the pure grouping logic; the Cloudflare Workers
// runtime only uses the default export below.
export { burstGroups };

export default {
  async queue(batch, env) { for (const message of batch.messages) await consumePhoto(message, env); },
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') return new Response(null, { headers: cors(request, env) });
      if (!url.pathname.startsWith('/api/')) return error('Not found', request, env, 404);

      if (request.method === 'GET' && url.pathname === '/api/health') {
        const health = await healthCheck(env, url.searchParams.get('deep') === '1');
        return response({ ...health, time: new Date().toISOString() }, request, env, health.ok ? 200 : 503);
      }

      if (request.method === 'POST' && url.pathname === '/api/admin/login') {
        const { password } = await readJson(request);
        const throttle = env.DB ? await loginThrottle(request, env) : null;
        if (throttle?.blocked) return json({ error: `Too many sign-in attempts. Try again in ${LOGIN_WINDOW_MINUTES} minutes.` }, 429, { ...cors(request, env), 'retry-after': String(LOGIN_WINDOW_MINUTES * 60) });
        if (!env.ADMIN_PASSWORD || !same(password, env.ADMIN_PASSWORD)) { await throttle?.failed(); return error('Incorrect password.', request, env, 401); }
        await throttle?.succeeded();
        const token = await sign({ role: 'admin', exp: Date.now() + 8 * 60 * 60_000 }, env);
        return response({ token }, request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/sessions') {
        // Session photos are only ever shown to the guest who matched them — the landing-page card
        // uses a cover the crew explicitly chose (migration 0009), otherwise the brand illustration.
        const hasCover = await hasColumn(env, 'sessions', 'cover_photo_id');
        const sessions = await env.DB.prepare(`SELECT id, title, session_date, location, price_paise, currency${hasCover ? ', cover_photo_id' : ''} FROM sessions WHERE status = 'published' ORDER BY session_date DESC LIMIT 30`).all();
        const thumbs = await thumbColumn(env);
        const results = await Promise.all(sessions.results.map(async ({ cover_photo_id: coverId, ...session }) => {
          let coverUrl = null;
          try {
            const cover = coverId ? await env.DB.prepare(`SELECT id${thumbs} FROM photos WHERE id = ? AND session_id = ?`).bind(coverId, session.id).first() : null;
            if (cover) coverUrl = `${url.origin}/api/media/${cover.id}?variant=${cover.thumb_key ? 'thumb' : 'preview'}&token=${encodeURIComponent(await mediaToken(cover.id, cover.thumb_key ? 'thumb' : 'preview', env, 6 * 60))}`;
          } catch { coverUrl = null; }
          return { ...session, coverUrl };
        }));
        return response({ sessions: results }, request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/match') {
        if (Number(request.headers.get('content-length')) > 11 * 1024 * 1024) return error('Selfie uploads must be smaller than 10 MB.', request, env, 413);
        const form = await readForm(request, 11 * 1024 * 1024);
        const sessionId = form.get('sessionId');
        const file = form.get('file');
        if (typeof sessionId !== 'string' || !sessionId || !(file instanceof File)) return error('A valid selfie image and session are required.', request, env);
        if (form.get('consent') !== 'true') return error('Your consent is required for face matching.', request, env);
        if (!file.size || file.size > 10 * 1024 * 1024) return error('Choose a JPG, PNG or WebP selfie smaller than 10 MB.', request, env, 413);
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return error('Choose a JPG, PNG or WebP selfie smaller than 10 MB.', request, env, 400);
        const session = await env.DB.prepare("SELECT * FROM sessions WHERE id = ? AND status = 'published'").bind(sessionId).first();
        if (!session) return error('That session is unavailable.', request, env, 404);
        const statusCheck = await env.DB.prepare(`
          SELECT
            COUNT(*) as total,
            SUM(CASE WHEN indexing_status = 'pending' THEN 1 ELSE 0 END) as pending,
            SUM(CASE WHEN indexing_status = 'completed' THEN 1 ELSE 0 END) as completed
          FROM photos WHERE session_id = ?
        `).bind(sessionId).first();

        const totalPhotos = Number(statusCheck?.total || 0);
        const pendingPhotos = Number(statusCheck?.pending || 0);
        const completedPhotos = Number(statusCheck?.completed || 0);

        if (totalPhotos === 0) {
          return error('No photos have been uploaded to this session yet.', request, env, 404);
        }

        if (completedPhotos === 0 && pendingPhotos === 0) return error('This session’s photos could not be processed yet. Please ask the crew to retry indexing.', request, env, 422);
        if (completedPhotos === 0 && pendingPhotos > 0) return error('This session is still processing. Please check back shortly.', request, env, 422);

        const { faces: faceResults } = await extractFaces(file, env);
        if (faceResults.length !== 1) return error(faceResults.length ? 'Please use a selfie with only one clearly visible face.' : 'We could not find a clear face. Try a brighter, straight-on selfie.', request, env);

        const embedding = faceResults[0]?.embedding;
        if (!Array.isArray(embedding) || !embedding.length || !embedding.every(Number.isFinite)) return error('Face matching is temporarily unavailable.', request, env, 503);

        const faces = await env.DB.prepare('SELECT f.photo_id, f.embedding_json FROM faces f JOIN photos p ON p.id = f.photo_id WHERE p.session_id = ? AND p.indexing_status = \'completed\'').bind(sessionId).all();
        const scores = new Map();
        for (const face of faces.results) {
          let stored; try { stored = JSON.parse(face.embedding_json); } catch { continue; }
          const score = similarity(embedding, stored);
          if (!Number.isFinite(score)) continue;
          scores.set(face.photo_id, Math.max(scores.get(face.photo_id) || -1, score));
        }
        const threshold = Number(env.MATCH_THRESHOLD || 0.62);
        let matches = [...scores.entries()].filter(([, score]) => score >= threshold).sort((a, b) => b[1] - a[1]).slice(0, 80);

        // Crew-confirmed burst/appearance links extend a direct match to its linked photo even
        // when that photo has no usable face of its own — but only once a human has confirmed the
        // pairing (pending/rejected links never reach a guest). The linked photo's own score never
        // gates inclusion here since the pairing is already human-verified ground truth.
        const matchedIds = new Set(matches.map(([photoId]) => photoId));
        if (matchedIds.size) {
          const idList = [...matchedIds];
          const linkRows = await env.DB.prepare(`SELECT photo1_id, photo2_id FROM photo_links
            WHERE status = 'confirmed' AND session_id = ?
              AND (photo1_id IN (${idList.map(() => '?').join(',')}) OR photo2_id IN (${idList.map(() => '?').join(',')}))`)
            .bind(sessionId, ...idList, ...idList).all();
          const CONFIRMED_LINK_SCORE_DISCOUNT = 0.9;
          const extensions = [];
          for (const { photo1_id, photo2_id } of linkRows.results) {
            for (const [anchor, other] of [[photo1_id, photo2_id], [photo2_id, photo1_id]]) {
              if (!matchedIds.has(anchor) || matchedIds.has(other)) continue;
              matchedIds.add(other);
              extensions.push([other, (scores.get(anchor) ?? threshold) * CONFIRMED_LINK_SCORE_DISCOUNT]);
            }
          }
          if (extensions.length) matches = [...matches, ...extensions].sort((a, b) => b[1] - a[1]).slice(0, 80);
        }

        const photoIds = matches.map(([photoId]) => photoId);
        const searchId = id();
        await env.DB.prepare('INSERT INTO searches (id, session_id, matched_photo_ids_json, price_paise, currency, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(searchId, sessionId, JSON.stringify(photoIds), session.price_paise, session.currency, dateAfterMinutes(45)).run();
        const base = url.origin;
        let thumbKeys = new Map();
        if (photoIds.length && await hasColumn(env, 'photos', 'thumb_key')) {
          try { const rows = await env.DB.prepare(`SELECT id, thumb_key FROM photos WHERE id IN (${photoIds.map(() => '?').join(',')})`).bind(...photoIds).all(); thumbKeys = new Map(rows.results.map(row => [row.id, row.thumb_key])); }
          catch { thumbKeys = new Map(); }
        }
        const previews = await Promise.all(matches.map(async ([photoId, score]) => ({
          photoId, score: Math.round(score * 100),
          ...(await previewLinks(base, { id: photoId, thumb_key: thumbKeys.get(photoId) }, env)),
        })));
        const token = await sign({ scope: 'search', searchId, exp: Date.now() + 45 * 60_000 }, env);

        let indexingNote = null;
        if (pendingPhotos > 0) {
          indexingNote = `${pendingPhotos} photos are still processing. Search again later to include them.`;
        }

        return response({ searchId, token, previews, count: previews.length, pricePaise: session.price_paise, currency: session.currency, indexingNote, session: { title: session.title, date: session.session_date, location: session.location } }, request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/checkout') {
        const { searchId, token, phone, email } = await readJson(request);
        const payload = await verify(token, env);
        if (payload?.scope !== 'search' || payload.searchId !== searchId) return error('This gallery link has expired.', request, env, 401);
        if (typeof phone !== 'string' || !/^[6-9]\d{9}$/.test(phone)) return error('Enter a valid 10-digit mobile number.', request, env);
        if (email !== undefined && email !== '' && (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return error('Enter a valid email address.', request, env);
        const search = await env.DB.prepare("SELECT * FROM searches WHERE id = ? AND status = 'preview' AND expires_at > CURRENT_TIMESTAMP").bind(searchId).first();
        if (!search) return error('This gallery link has expired.', request, env, 410);
        if (!env.CASHFREE_APP_ID || !env.CASHFREE_SECRET_KEY) return error('Payments are not configured yet.', request, env, 503);
        const allowedOrigins = (env.ALLOWED_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean);
        const requestOrigin = request.headers.get('Origin');
        const siteOrigin = (requestOrigin && allowedOrigins.includes(requestOrigin)) ? requestOrigin : (allowedOrigins[0] || url.origin);
        const paymentId = id();
        const order = await cashfreeOrder(search, paymentId, { phone, email }, siteOrigin, url.origin, env);
        await env.DB.prepare('INSERT INTO payments (id, search_id, cashfree_order_id, amount_paise, currency) VALUES (?, ?, ?, ?, ?)')
          .bind(paymentId, searchId, order.order_id, search.price_paise, search.currency).run();
        return response({ orderId: order.order_id, paymentSessionId: order.payment_session_id, mode: env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox', amount: search.price_paise / 100, currency: search.currency }, request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/payment/verify') {
        const { searchId, token, orderId } = await readJson(request);
        const payload = await verify(token, env);
        if (payload?.scope !== 'search' || payload.searchId !== searchId) return error('This gallery link has expired.', request, env, 401);
        const payment = await env.DB.prepare('SELECT * FROM payments WHERE cashfree_order_id = ? AND search_id = ?').bind(orderId, searchId).first();
        if (!payment) return error('Payment verification failed.', request, env, 402);
        if (!['verified', 'captured'].includes(payment.status)) {
          if (!env.CASHFREE_APP_ID || !env.CASHFREE_SECRET_KEY) return error('Payments are not configured yet.', request, env, 503);
          const orderStatus = await cashfreeOrderStatus(orderId, env);
          if (orderStatus?.order_status !== 'PAID') return error('Payment has not been confirmed yet.', request, env, 402);
          await env.DB.batch([
            env.DB.prepare("UPDATE payments SET status = 'verified', paid_at = CURRENT_TIMESTAMP WHERE id = ?").bind(payment.id),
            env.DB.prepare("UPDATE searches SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ?").bind(searchId),
          ]);
        }
        const search = await env.DB.prepare('SELECT * FROM searches WHERE id = ?').bind(searchId).first();
        return response({ unlocked: true, photos: await accessPayload(search, request, env) }, request, env);
      }

      const media = url.pathname.match(/^\/api\/media\/([\w-]+)$/);
      if (request.method === 'GET' && media) {
        const photoId = media[1]; const variant = url.searchParams.get('variant'); const token = url.searchParams.get('token');
        const payload = await verify(token, env);
        if (payload?.scope !== 'media' || payload.photoId !== photoId || payload.variant !== variant) return error('This photo link has expired.', request, env, 401);
        const photo = await env.DB.prepare(`SELECT object_key, preview_key, content_type, filename${await thumbColumn(env)} FROM photos WHERE id = ?`).bind(photoId).first();
        if (!photo) return error('Photo not found.', request, env, 404);
        const key = variant === 'original' ? photo.object_key : (variant === 'thumb' && photo.thumb_key) ? photo.thumb_key : photo.preview_key;
        const object = await env.PHOTOS.get(key);
        if (!object) return error('Photo unavailable.', request, env, 404);
        const headers = { ...cors(request, env), 'content-type': object.httpMetadata?.contentType || photo.content_type, 'cache-control': 'private, max-age=600' };
        // ?download=1 makes the browser save the original under its session filename instead of opening it.
        if (variant === 'original' && url.searchParams.get('download') === '1') headers['content-disposition'] = `attachment; filename="${safeFilename(photo.filename)}"`;
        return new Response(object.body, { headers });
      }

      // Fresh preview links for a still-valid search (the signed URLs expire; the search may not have yet).
      if (request.method === 'GET' && url.pathname.match(/^\/api\/searches\/([\w-]+)\/previews$/)) {
        const searchId = url.pathname.split('/')[3];
        if (!await requireSearch(request, env, searchId)) return error('This gallery link has expired.', request, env, 401);
        const search = await env.DB.prepare("SELECT * FROM searches WHERE id = ? AND (status = 'paid' OR expires_at > CURRENT_TIMESTAMP)").bind(searchId).first();
        if (!search) return error('This gallery link has expired.', request, env, 410);
        return response({ photos: await previewPayload(search, request, env), session: await sessionSummary(env, search.session_id) }, request, env);
      }

      if (request.method === 'GET' && url.pathname.match(/^\/api\/searches\/([\w-]+)\/access$/)) {
        const searchId = url.pathname.split('/')[3];
        if (!await requireSearch(request, env, searchId)) return error('This gallery link has expired.', request, env, 401);
        const search = await env.DB.prepare("SELECT * FROM searches WHERE id = ? AND status = 'paid'").bind(searchId).first();
        if (!search) return error('Payment has not been confirmed.', request, env, 402);
        // A paid gallery gets a 30-day token so the guest can come back for their originals.
        const galleryToken = await sign({ scope: 'search', searchId, exp: Date.now() + 30 * 24 * 60 * 60_000 }, env);
        return response({ unlocked: true, photos: await accessPayload(search, request, env), galleryToken, session: await sessionSummary(env, search.session_id) }, request, env);
      }

      // GET /api/searches/:id/download — every original of a paid search as one ZIP, streamed.
      if (request.method === 'GET' && url.pathname.match(/^\/api\/searches\/([\w-]+)\/download$/)) {
        const searchId = url.pathname.split('/')[3];
        if (!await requireSearch(request, env, searchId)) return error('This gallery link has expired.', request, env, 401);
        const search = await env.DB.prepare("SELECT * FROM searches WHERE id = ? AND status = 'paid'").bind(searchId).first();
        if (!search) return error('Payment has not been confirmed.', request, env, 402);
        const photoIds = JSON.parse(search.matched_photo_ids_json);
        if (!photoIds.length) return error('There are no photos in this pack.', request, env, 404);
        const rows = await env.DB.prepare(`SELECT id, object_key, filename FROM photos WHERE session_id = ? AND id IN (${photoIds.map(() => '?').join(',')}) ORDER BY filename`).bind(search.session_id, ...photoIds).all();
        if (!rows.results.length) return error('There are no photos in this pack.', request, env, 404);
        // Session filenames can repeat once "keep both" copies exist; suffix so the archive never overwrites itself.
        const seen = new Map(); const encoder = new TextEncoder();
        const files = rows.results.map(row => {
          const base = safeFilename(row.filename); const count = (seen.get(base) || 0) + 1; seen.set(base, count);
          const name = count === 1 ? base : base.replace(/(\.[^.]*)?$/, `-${count}$1`);
          return { key: row.object_key, name: encoder.encode(name) };
        });
        // Sizes are optional (older R2 mocks/objects may not answer head); when known, refuse ZIP64 territory and send an exact length.
        const heads = await Promise.all(files.map(file => env.PHOTOS.head?.(file.key).catch(() => null) ?? null));
        const sized = heads.every(head => Number.isFinite(head?.size));
        if (sized) { heads.forEach((head, index) => { files[index].size = head.size; }); if (zipLength(files) >= 2 ** 32) return error('This pack is too large for one download. Use the per-photo Download links.', request, env, 413); }
        const session = await sessionSummary(env, search.session_id);
        const archiveName = `surfers-of-india-${session?.date || 'session'}-${(session?.location || 'photos').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.zip`;
        const { readable, pump } = zipStream(files, env, err => console.error('zip stream failed', searchId, err?.message));
        ctx?.waitUntil?.(pump);
        return new Response(readable, { headers: { ...cors(request, env), 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${archiveName}"`, 'cache-control': 'no-store', ...(sized ? { 'content-length': String(zipLength(files)) } : {}) } });
      }

      if (request.method === 'POST' && url.pathname === '/api/admin/sessions') {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const { title, date, location, pricePaise } = await readJson(request);
        validateSession({ title, date, location, pricePaise });
        const session = { id: id(), title: title.trim(), date, location: location.trim(), price: Number(pricePaise) };
        await env.DB.prepare('INSERT INTO sessions (id, title, session_date, location, price_paise) VALUES (?, ?, ?, ?, ?)').bind(session.id, session.title, session.date, session.location, session.price).run();
        return response({ session }, request, env, 201);
      }

      const dashboard = url.pathname.match(/^\/api\/admin\/dashboard$/);
      if (request.method === 'GET' && dashboard) {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const query = `
          SELECT
            s.id, s.title, s.session_date as date, s.location, s.status, s.price_paise,
            COUNT(DISTINCT p.id) as total_photos,
            SUM(CASE WHEN p.indexing_status = 'completed' THEN 1 ELSE 0 END) as indexed_photos,
            SUM(CASE WHEN p.indexing_status = 'pending' THEN 1 ELSE 0 END) as pending_photos,
            SUM(CASE WHEN p.indexing_status = 'failed' THEN 1 ELSE 0 END) as failed_photos,
            (SELECT COUNT(*) FROM searches sr WHERE sr.session_id = s.id AND sr.status = 'paid') as downloads
          FROM sessions s
          LEFT JOIN photos p ON p.session_id = s.id
          GROUP BY s.id
          ORDER BY s.created_at DESC
          LIMIT 50
        `;
        const sessions = await env.DB.prepare(query).all();
        return response({ sessions: sessions.results }, request, env);
      }

      const deleteSession = url.pathname.match(/^\/api\/admin\/sessions\/([\w-]+)$/);
      if (request.method === 'DELETE' && deleteSession) {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const sessionId = deleteSession[1];

        // Fetch all photos for this session
        const photos = await env.DB.prepare(`SELECT object_key, preview_key${await thumbColumn(env)} FROM photos WHERE session_id = ?`).bind(sessionId).all();

        // Delete all photo files from R2
        if (photos.results.length > 0) {
          const keysToDelete = photos.results.flatMap(p => [p.object_key, p.preview_key, p.thumb_key].filter(Boolean));
          const chunks = [];
          for (let i = 0; i < keysToDelete.length; i += 500) {
            chunks.push(env.PHOTOS.delete(keysToDelete.slice(i, i + 500)));
          }
          await Promise.all(chunks);
        }

        // Delete all DB records in correct dependency order to prevent foreign key errors
        await env.DB.batch([
          env.DB.prepare('DELETE FROM payments WHERE search_id IN (SELECT id FROM searches WHERE session_id = ?)').bind(sessionId),
          env.DB.prepare('DELETE FROM searches WHERE session_id = ?').bind(sessionId),
          env.DB.prepare('DELETE FROM faces WHERE photo_id IN (SELECT id FROM photos WHERE session_id = ?)').bind(sessionId),
          env.DB.prepare('DELETE FROM photos WHERE session_id = ?').bind(sessionId),
          env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId),
        ]);

        return response({ success: true }, request, env);
      }

      // GET /api/admin/sessions/:id/photos - List photos in a session for admin grid
      const sessionPhotos = url.pathname.match(/^\/api\/admin\/sessions\/([\w-]+)\/photos$/);
      if (request.method === 'GET' && sessionPhotos) {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const sessionId = sessionPhotos[1];
        const base = url.origin;
        let coverPhotoId = null;
        if (await hasColumn(env, 'sessions', 'cover_photo_id')) { try { coverPhotoId = (await env.DB.prepare('SELECT cover_photo_id FROM sessions WHERE id = ?').bind(sessionId).first())?.cover_photo_id || null; } catch { coverPhotoId = null; } }
        const photos = await env.DB.prepare(`
          SELECT p.id, p.filename, p.indexing_status, p.created_at, j.error as indexing_error, COUNT(f.id) as face_count${(await thumbColumn(env)).replace(', thumb_key', ', p.thumb_key')}
          FROM photos p
          LEFT JOIN faces f ON f.photo_id = p.id
          LEFT JOIN indexing_jobs j ON j.photo_id = p.id
          WHERE p.session_id = ?
          GROUP BY p.id
          ORDER BY p.created_at DESC
        `).bind(sessionId).all();

        const results = await Promise.all(photos.results.map(async (photo) => ({
          ...photo,
          previewUrl: await mediaLink(base, photo.id, 'preview', env),
          thumbUrl: photo.thumb_key ? await mediaLink(base, photo.id, 'thumb', env) : null,
          originalUrl: await mediaLink(base, photo.id, 'original', env),
        })));

        return response({ photos: results, coverPhotoId }, request, env);
      }

      // DELETE /api/admin/photos/:id - Delete a single photo
      const deletePhoto = url.pathname.match(/^\/api\/admin\/photos\/([\w-]+)$/);
      if (request.method === 'DELETE' && deletePhoto) {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const photoId = deletePhoto[1];
        const photo = await env.DB.prepare(`SELECT object_key, preview_key${await thumbColumn(env)} FROM photos WHERE id = ?`).bind(photoId).first();
        if (!photo) return error('Photo not found.', request, env, 404);

        await Promise.all([photo.object_key, photo.preview_key, photo.thumb_key].filter(Boolean).map(key => env.PHOTOS.delete(key)));

        await env.DB.batch([
          env.DB.prepare('DELETE FROM faces WHERE photo_id = ?').bind(photoId),
          env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(photoId),
        ]);

        return response({ success: true }, request, env);
      }

      // POST /api/admin/sessions/:id/reindex - Reindex photos for a specific session
      const reindexSession = url.pathname.match(/^\/api\/admin\/sessions\/([\w-]+)\/reindex$/);
      if (request.method === 'POST' && reindexSession) {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const sessionId = reindexSession[1];
        const onlyFailed = url.searchParams.get('onlyFailed') === '1';
        const photos = await env.DB.prepare(`SELECT id, object_key FROM photos WHERE session_id = ?${onlyFailed ? " AND indexing_status = 'failed'" : ''}`).bind(sessionId).all();
        const session = await env.DB.prepare('SELECT id FROM sessions WHERE id = ?').bind(sessionId).first();
        if (!session) return error('Session not found.', request, env, 404);
        return response(await enqueuePhotos(photos.results, env), request, env, 202);
      }

      // PUT /api/admin/sessions/:id - Update session details or status
      const updateSession = url.pathname.match(/^\/api\/admin\/sessions\/([\w-]+)$/);
      if (request.method === 'PUT' && updateSession) {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const sessionId = updateSession[1];
        const { title, date, location, pricePaise, status, coverPhotoId } = await readJson(request);
        validateSession({ title, date, location, pricePaise, status }, true);
        const existing = await env.DB.prepare('SELECT id FROM sessions WHERE id = ?').bind(sessionId).first();
        if (!existing) return error('Session not found.', request, env, 404);
        if (coverPhotoId !== undefined) {
          if (!await hasColumn(env, 'sessions', 'cover_photo_id')) return error('Session covers need database migration 0009.', request, env, 503);
          if (coverPhotoId !== null && (typeof coverPhotoId !== 'string' || !coverPhotoId)) return error('Choose a valid cover photo.', request, env);
          if (coverPhotoId) {
            const owned = await env.DB.prepare('SELECT id FROM photos WHERE id = ? AND session_id = ?').bind(coverPhotoId, sessionId).first();
            if (!owned) return error('That photo is not part of this session.', request, env, 404);
          }
          await env.DB.prepare('UPDATE sessions SET cover_photo_id = ? WHERE id = ?').bind(coverPhotoId, sessionId).run();
        }
        if (status === 'published') {
          const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM photos WHERE session_id = ?').bind(sessionId).first();
          if (!count?.count) return error('Upload at least one photo before publishing.', request, env);
        }

        await env.DB.prepare(`
          UPDATE sessions
          SET title = COALESCE(?, title),
              session_date = COALESCE(?, session_date),
              location = COALESCE(?, location),
              price_paise = COALESCE(?, price_paise),
              status = COALESCE(?, status)
          WHERE id = ?
        `).bind(title?.trim() || null, date || null, location?.trim() || null, pricePaise ? Number(pricePaise) : null, status || null, sessionId).run();

        return response({ updated: true }, request, env);
      }

      // POST /api/admin/verify-queue/scan - Generate candidate borderline matches
      if (request.method === 'POST' && url.pathname === '/api/admin/verify-queue/scan') {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const count = await generateBorderlineMatches(env);
        return response({ generated: count }, request, env);
      }

      // GET /api/admin/verify-queue - Fetch face pairs needing confirmation
      if (request.method === 'GET' && url.pathname === '/api/admin/verify-queue') {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const base = url.origin;

        const query = `
          SELECT
            fv.id, fv.similarity, fv.status, s.title as session_title,
            p1.id as photo1_id, p1.filename as photo1_filename,
            p2.id as photo2_id, p2.filename as photo2_filename,
            f1.id as face1_id, f1.bbox_json as face1_bbox,
            f2.id as face2_id, f2.bbox_json as face2_bbox
          FROM face_verifications fv
          JOIN sessions s ON s.id = fv.session_id
          JOIN faces f1 ON f1.id = fv.face1_id
          JOIN photos p1 ON p1.id = f1.photo_id
          JOIN faces f2 ON f2.id = fv.face2_id
          JOIN photos p2 ON p2.id = f2.photo_id
          WHERE fv.status = 'pending' AND f1.bbox_json IS NOT NULL AND f2.bbox_json IS NOT NULL
            AND p1.indexing_status = 'completed' AND p2.indexing_status = 'completed'
          ORDER BY fv.similarity DESC
        `;
        let res = await env.DB.prepare(query).all();
        let reviewable = res.results.filter(item => faceBounds(item.face1_bbox) && faceBounds(item.face2_bbox));
        if (!reviewable.length) {
          await generateBorderlineMatches(env);
          res = await env.DB.prepare(query).all();
          reviewable = res.results.filter(item => faceBounds(item.face1_bbox) && faceBounds(item.face2_bbox));
        }

        const queue = await Promise.all(reviewable.slice(0, 20).map(async (item) => ({
          id: item.id,
          sessionTitle: item.session_title,
          similarityPct: Math.round(item.similarity * 100),
          photo1: {
            id: item.photo1_id,
            filename: item.photo1_filename,
            url: `${base}/api/media/${item.photo1_id}?variant=original&token=${encodeURIComponent(await mediaToken(item.photo1_id, 'original', env))}`,
            bboxNorm: item.face1_bbox ? JSON.parse(item.face1_bbox) : null,
          },
          photo2: {
            id: item.photo2_id,
            filename: item.photo2_filename,
            url: `${base}/api/media/${item.photo2_id}?variant=original&token=${encodeURIComponent(await mediaToken(item.photo2_id, 'original', env))}`,
            bboxNorm: item.face2_bbox ? JSON.parse(item.face2_bbox) : null,
          },
        })));

        const stats = await env.DB.prepare(`
          SELECT
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
            SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmed,
            SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected
          FROM face_verifications
        `).first();

        return response({ queue, stats: { pending: reviewable.length, unavailable: Math.max(0, Number(stats?.pending || 0) - reviewable.length), confirmed: stats?.confirmed || 0, rejected: stats?.rejected || 0 } }, request, env);
      }

      // POST /api/admin/confirm-match - Confirm or reject borderline face match
      if (request.method === 'POST' && url.pathname === '/api/admin/confirm-match') {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const { pairId, confirmed } = await readJson(request);
        if (typeof pairId !== 'string' || typeof confirmed !== 'boolean') return error('Choose same person or different people for a valid pair.', request, env);
        const newStatus = confirmed ? 'confirmed' : 'rejected';

        const decision = await env.DB.prepare(`
          UPDATE face_verifications
          SET status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'pending'
        `).bind(newStatus, pairId).run();
        if (!decision.meta?.changes) return error('This pair was already reviewed or is no longer available. Refresh the queue.', request, env, 409);

        const pair = await env.DB.prepare('SELECT similarity FROM face_verifications WHERE id = ?').bind(pairId).first();
        if (pair) await env.DB.prepare('INSERT INTO match_feedback (id, source, face_similarity, label) VALUES (?, ?, ?, ?)').bind(id(), 'face_pair', pair.similarity, confirmed ? 1 : 0).run();

        return response({ success: true, status: newStatus }, request, env);
      }

      // POST /api/admin/link-queue/scan - Generate candidate burst/appearance fallback links
      if (request.method === 'POST' && url.pathname === '/api/admin/link-queue/scan') {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const count = await generateFallbackLinks(env);
        return response({ generated: count }, request, env);
      }

      // GET /api/admin/link-queue - Fetch photo-level fallback links needing confirmation
      if (request.method === 'GET' && url.pathname === '/api/admin/link-queue') {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const base = url.origin;

        const query = `
          SELECT
            pl.id, pl.link_type, pl.score, s.title as session_title,
            p1.id as photo1_id, p1.filename as photo1_filename,
            p2.id as photo2_id, p2.filename as photo2_filename
          FROM photo_links pl
          JOIN sessions s ON s.id = pl.session_id
          JOIN photos p1 ON p1.id = pl.photo1_id
          JOIN photos p2 ON p2.id = pl.photo2_id
          WHERE pl.status = 'pending' AND p1.indexing_status = 'completed' AND p2.indexing_status = 'completed'
          ORDER BY pl.score DESC
        `;
        let res = await env.DB.prepare(query).all();
        let reviewable = res.results;
        if (!reviewable.length) {
          await generateFallbackLinks(env);
          res = await env.DB.prepare(query).all();
          reviewable = res.results;
        }

        const queue = await Promise.all(reviewable.slice(0, 20).map(async (item) => ({
          id: item.id,
          linkType: item.link_type,
          scorePct: Math.round(item.score * 100),
          sessionTitle: item.session_title,
          photo1: {
            id: item.photo1_id,
            filename: item.photo1_filename,
            url: `${base}/api/media/${item.photo1_id}?variant=original&token=${encodeURIComponent(await mediaToken(item.photo1_id, 'original', env))}`,
          },
          photo2: {
            id: item.photo2_id,
            filename: item.photo2_filename,
            url: `${base}/api/media/${item.photo2_id}?variant=original&token=${encodeURIComponent(await mediaToken(item.photo2_id, 'original', env))}`,
          },
        })));

        const stats = await env.DB.prepare(`
          SELECT
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
            SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmed,
            SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected
          FROM photo_links
        `).first();
        const weights = await env.DB.prepare('SELECT trained_on FROM match_weights WHERE id = 1').first();

        return response({ queue, stats: { pending: reviewable.length, confirmed: stats?.confirmed || 0, rejected: stats?.rejected || 0 }, trainedOn: weights?.trained_on || 0 }, request, env);
      }

      // POST /api/admin/confirm-link - Confirm or reject a fallback photo link
      if (request.method === 'POST' && url.pathname === '/api/admin/confirm-link') {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const { linkId, confirmed } = await readJson(request);
        if (typeof linkId !== 'string' || typeof confirmed !== 'boolean') return error('Choose same person or different people for a valid link.', request, env);
        const newStatus = confirmed ? 'confirmed' : 'rejected';

        const decision = await env.DB.prepare(`
          UPDATE photo_links
          SET status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'pending'
        `).bind(newStatus, linkId).run();
        if (!decision.meta?.changes) return error('This link was already reviewed or is no longer available. Refresh the queue.', request, env, 409);

        const link = await env.DB.prepare('SELECT link_type, score FROM photo_links WHERE id = ?').bind(linkId).first();
        if (link) {
          const label = confirmed ? 1 : 0;
          if (link.link_type === 'appearance') await env.DB.prepare('INSERT INTO match_feedback (id, source, appearance_similarity, label) VALUES (?, ?, ?, ?)').bind(id(), 'appearance_link', link.score, label).run();
          else await env.DB.prepare('INSERT INTO match_feedback (id, source, burst_score, label) VALUES (?, ?, ?, ?)').bind(id(), 'burst_link', link.score, label).run();
        }

        return response({ success: true, status: newStatus }, request, env);
      }

      // POST /api/admin/retrain - Refit match-scoring weights from accumulated crew review decisions
      if (request.method === 'POST' && url.pathname === '/api/admin/retrain') {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const result = await retrainMatchWeights(env);
        return response(result, request, env);
      }

      const reindex = url.pathname.match(/^\/api\/admin\/reindex$/);
      if (request.method === 'POST' && reindex) {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const unindexed = await env.DB.prepare("SELECT id, object_key FROM photos WHERE indexing_status != 'completed'").all();
        return response(await enqueuePhotos(unindexed.results, env), request, env, 202);
      }

      const upload = url.pathname.match(/^\/api\/admin\/sessions\/([\w-]+)\/photos$/);
      if (request.method === 'POST' && upload) {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        if (!env.INDEX_QUEUE) return error('Photo processing is not configured.', request, env, 503);
        const sessionId = upload[1]; const session = await env.DB.prepare('SELECT id, status FROM sessions WHERE id = ?').bind(sessionId).first();
        if (!session) return error('Session not found. Create a session before uploading.', request, env, 404);
        if (session.status === 'archived') return error('Restore this archived session before uploading more photos.', request, env, 409);
        if (Number(request.headers.get('content-length')) > 32 * 1024 * 1024) return error('The upload is too large.', request, env, 413);
        const uploadType = request.headers.get('content-type') || '';
        if (uploadType.includes('multipart/form-data')) {
          // Legacy buffered upload — kept so a client that has not switched to streaming still works.
          const form = await readForm(request, 32 * 1024 * 1024); const file = form.get('file'); const preview = form.get('preview');
          if (!(file instanceof File) || !(preview instanceof File) || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || preview.type !== 'image/jpeg' || !file.size || file.size > 25 * 1024 * 1024 || !preview.size || preview.size > 5 * 1024 * 1024) return error('An image and its preview are required.', request, env);
          const onDuplicate = form.get('onDuplicate');
          if (onDuplicate !== null && !DUPLICATE_MODES.includes(onDuplicate)) return error('Choose replace, skip or rename for duplicate photos.', request, env);
          return storeSessionPhoto(env, request, sessionId, { filename: file.name, contentType: file.type, original: file, preview, onDuplicate });
        }
        // Streaming upload — metadata in the query string, body is [len][preview][original].
        const type = url.searchParams.get('type'); const onDuplicate = url.searchParams.get('onDuplicate');
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) return error('An image and its preview are required.', request, env);
        if (onDuplicate !== null && !DUPLICATE_MODES.includes(onDuplicate)) return error('Choose replace, skip or rename for duplicate photos.', request, env);
        const { preview, original } = await readFramedUpload(request, 5 * 1024 * 1024);
        return storeSessionPhoto(env, request, sessionId, { filename: url.searchParams.get('filename') || 'photo.jpg', contentType: type, original, preview, onDuplicate });
      }

      // POST /api/admin/photos/:id/thumb — a small watermarked JPEG for grid tiles, sent by the crew
      // studio after the main upload. Optional: everything renders from the preview without it.
      const thumbUpload = url.pathname.match(/^\/api\/admin\/photos\/([\w-]+)\/thumb$/);
      if (request.method === 'POST' && thumbUpload) {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        if (!await hasColumn(env, 'photos', 'thumb_key')) return error('Thumbnails need database migration 0008.', request, env, 503);
        const photo = await env.DB.prepare('SELECT id, session_id, thumb_key FROM photos WHERE id = ?').bind(thumbUpload[1]).first();
        if (!photo) return error('Photo not found.', request, env, 404);
        const body = await boundedBody(request, 1024 * 1024);
        const head = new Uint8Array(await body.slice(0, 2).arrayBuffer());
        if (!body.size || head[0] !== 0xFF || head[1] !== 0xD8) return error('The thumbnail must be a JPEG.', request, env, 400);
        const thumbKey = `sessions/${photo.session_id}/thumb/${photo.id}.jpg`;
        await env.PHOTOS.put(thumbKey, body, { httpMetadata: { contentType: 'image/jpeg' } });
        await env.DB.prepare('UPDATE photos SET thumb_key = ? WHERE id = ?').bind(thumbKey, photo.id).run();
        return response({ photoId: photo.id, thumb: true }, request, env, 201);
      }

      const publish = url.pathname.match(/^\/api\/admin\/sessions\/([\w-]+)\/publish$/);
      if (request.method === 'POST' && publish) {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM photos WHERE session_id = ?').bind(publish[1]).first();
        if (!count?.count) return error('Upload at least one photo before publishing.', request, env);
        await env.DB.prepare("UPDATE sessions SET status = 'published', published_at = CURRENT_TIMESTAMP WHERE id = ?").bind(publish[1]).run();
        return response({ published: true }, request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/payment/webhook') {
        const raw = await request.text();
        const signature = request.headers.get('x-webhook-signature');
        const timestamp = request.headers.get('x-webhook-timestamp');
        if (!env.CASHFREE_SECRET_KEY || !timestamp || !signature || !same(await hmacBase64(`${timestamp}${raw}`, env.CASHFREE_SECRET_KEY), signature)) return error('Invalid webhook signature.', request, env, 401);
        const event = JSON.parse(raw);
        if (event.type === 'PAYMENT_SUCCESS_WEBHOOK') {
          const orderId = event.data?.order?.order_id;
          const cfPaymentId = event.data?.payment?.cf_payment_id;
          if (orderId) {
            await env.DB.prepare("UPDATE payments SET cashfree_payment_id = COALESCE(?, cashfree_payment_id), status = 'captured', paid_at = CURRENT_TIMESTAMP WHERE cashfree_order_id = ?").bind(cfPaymentId ? String(cfPaymentId) : null, orderId).run();
            const payment = await env.DB.prepare('SELECT search_id FROM payments WHERE cashfree_order_id = ?').bind(orderId).first();
            if (payment) await env.DB.prepare("UPDATE searches SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'paid'").bind(payment.search_id).run();
          }
        }
        return response({ received: true }, request, env);
      }

      return error('Not found', request, env, 404);
    } catch (caught) {
      if (caught instanceof RequestError) return error(caught.message, request, env, caught.status);
      console.error(caught);
      return error('We couldn’t complete that request. Please try again shortly.', request, env, 500);
    }
  },
};
