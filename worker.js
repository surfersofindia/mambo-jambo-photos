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
async function mediaToken(photoId, variant, env) {
  return sign({ scope: 'media', photoId, variant, exp: Date.now() + 20 * 60_000 }, env);
}
async function accessPayload(search, request, env) {
  const photoIds = JSON.parse(search.matched_photo_ids_json);
  const rows = await env.DB.prepare(`SELECT id FROM photos WHERE session_id = ? AND id IN (${photoIds.map(() => '?').join(',')})`)
    .bind(search.session_id, ...photoIds).all();
  const base = new URL(request.url).origin;
  return Promise.all(rows.results.map(async ({ id: photoId }) => ({
    photoId,
    url: `${base}/api/media/${photoId}?variant=original&token=${encodeURIComponent(await mediaToken(photoId, 'original', env))}`,
  })));
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

      if (request.method === 'POST' && url.pathname === '/api/admin/login') {
        const { password } = await readJson(request);
        if (!env.ADMIN_PASSWORD || !same(password, env.ADMIN_PASSWORD)) return error('Incorrect password.', request, env, 401);
        const token = await sign({ role: 'admin', exp: Date.now() + 8 * 60 * 60_000 }, env);
        return response({ token }, request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/sessions') {
        const sessions = await env.DB.prepare("SELECT id, title, session_date, location, price_paise, currency FROM sessions WHERE status = 'published' ORDER BY session_date DESC LIMIT 30").all();
        return response({ sessions: sessions.results }, request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/match') {
        if (Number(request.headers.get('content-length')) > 11 * 1024 * 1024) return error('Selfie uploads must be smaller than 10 MB.', request, env, 413);
        const form = await readForm(request, 11 * 1024 * 1024);
        const sessionId = form.get('sessionId');
        const file = form.get('file');
        if (typeof sessionId !== 'string' || !sessionId || !(file instanceof File)) return error('A valid selfie image and session are required.', request, env);
        if (form.get('consent') !== 'true') return error('Your consent is required for face matching.', request, env);
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || !file.size || file.size > 10 * 1024 * 1024) return error('Choose a JPG, PNG or WebP selfie smaller than 10 MB.', request, env, 413);
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
        const previews = await Promise.all(matches.map(async ([photoId, score]) => ({
          photoId, score: Math.round(score * 100),
          url: `${base}/api/media/${photoId}?variant=preview&token=${encodeURIComponent(await mediaToken(photoId, 'preview', env))}`,
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
        const photo = await env.DB.prepare('SELECT object_key, preview_key, content_type FROM photos WHERE id = ?').bind(photoId).first();
        if (!photo) return error('Photo not found.', request, env, 404);
        const object = await env.PHOTOS.get(variant === 'original' ? photo.object_key : photo.preview_key);
        if (!object) return error('Photo unavailable.', request, env, 404);
        return new Response(object.body, { headers: { ...cors(request, env), 'content-type': object.httpMetadata?.contentType || photo.content_type, 'cache-control': 'private, max-age=600' } });
      }

      if (request.method === 'GET' && url.pathname.match(/^\/api\/searches\/([\w-]+)\/access$/)) {
        const searchId = url.pathname.split('/')[3];
        if (!await requireSearch(request, env, searchId)) return error('This gallery link has expired.', request, env, 401);
        const search = await env.DB.prepare("SELECT * FROM searches WHERE id = ? AND status = 'paid'").bind(searchId).first();
        if (!search) return error('Payment has not been confirmed.', request, env, 402);
        return response({ unlocked: true, photos: await accessPayload(search, request, env) }, request, env);
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
        const photos = await env.DB.prepare('SELECT object_key, preview_key FROM photos WHERE session_id = ?').bind(sessionId).all();

        // Delete all photo files from R2
        if (photos.results.length > 0) {
          const keysToDelete = photos.results.flatMap(p => [p.object_key, p.preview_key]);
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
        const photos = await env.DB.prepare(`
          SELECT p.id, p.filename, p.indexing_status, p.created_at, j.error as indexing_error, COUNT(f.id) as face_count
          FROM photos p
          LEFT JOIN faces f ON f.photo_id = p.id
          LEFT JOIN indexing_jobs j ON j.photo_id = p.id
          WHERE p.session_id = ?
          GROUP BY p.id
          ORDER BY p.created_at DESC
        `).bind(sessionId).all();

        const results = await Promise.all(photos.results.map(async (photo) => ({
          ...photo,
          previewUrl: `${base}/api/media/${photo.id}?variant=preview&token=${encodeURIComponent(await mediaToken(photo.id, 'preview', env))}`,
          originalUrl: `${base}/api/media/${photo.id}?variant=original&token=${encodeURIComponent(await mediaToken(photo.id, 'original', env))}`,
        })));

        return response({ photos: results }, request, env);
      }

      // DELETE /api/admin/photos/:id - Delete a single photo
      const deletePhoto = url.pathname.match(/^\/api\/admin\/photos\/([\w-]+)$/);
      if (request.method === 'DELETE' && deletePhoto) {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const photoId = deletePhoto[1];
        const photo = await env.DB.prepare('SELECT object_key, preview_key FROM photos WHERE id = ?').bind(photoId).first();
        if (!photo) return error('Photo not found.', request, env, 404);

        await Promise.all([
          env.PHOTOS.delete(photo.object_key),
          env.PHOTOS.delete(photo.preview_key),
        ]);

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
        const photos = await env.DB.prepare("SELECT id, object_key FROM photos WHERE session_id = ?").bind(sessionId).all();
        const session = await env.DB.prepare('SELECT id FROM sessions WHERE id = ?').bind(sessionId).first();
        if (!session) return error('Session not found.', request, env, 404);
        return response(await enqueuePhotos(photos.results, env), request, env, 202);
      }

      // PUT /api/admin/sessions/:id - Update session details or status
      const updateSession = url.pathname.match(/^\/api\/admin\/sessions\/([\w-]+)$/);
      if (request.method === 'PUT' && updateSession) {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const sessionId = updateSession[1];
        const { title, date, location, pricePaise, status } = await readJson(request);
        validateSession({ title, date, location, pricePaise, status }, true);
        const existing = await env.DB.prepare('SELECT id FROM sessions WHERE id = ?').bind(sessionId).first();
        if (!existing) return error('Session not found.', request, env, 404);
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
