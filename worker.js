/**
 * Mambo Jambo photo API — Cloudflare Worker + D1 + R2.
 *
 * Secrets set with `wrangler secret put`:
 *   ADMIN_PASSWORD, SESSION_SECRET, CASHFREE_APP_ID, CASHFREE_SECRET_KEY, FACE_API_KEY (optional)
 * (Cashfree signs webhooks with the same CASHFREE_SECRET_KEY, not a separate secret. FACE_API_KEY is
 *  forwarded to the face service as `x-face-key`; leave it unset until the Space enforces it.)
 * Vars: CASHFREE_ENV ('sandbox' or 'production', defaults to 'sandbox'), LEGACY_SHARED_LOGIN
 * ('true' keeps the shared ADMIN_PASSWORD working after crew accounts exist — migration 0016)
 * Cron (wrangler.jsonc triggers.crons): `scheduled` runs the deep health check every 10 minutes so
 * the face service stays warm, checks the indexing queue for a stall and alerts the crew once per
 * incident; the result goes to the Worker logs. Optional alert settings (all absent = log only):
 * ALERT_WEBHOOK_URL and RESEND_API_KEY as secrets, ALERT_EMAIL_TO / ALERT_EMAIL_FROM /
 * ALERT_WEBHOOK_FORMAT / QUEUE_STALL_MINUTES as vars — docs/runbook.md sections 2 and 7.
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

// ── Image header parsing (migration 0012) ────────────────────────────────────
// Pixel size from the first bytes of a JPEG, PNG or WebP — header only, never the pixel data, so a
// streamed original is inspected without buffering it. JPEG walks the marker chain to the first SOF
// segment and honours an EXIF orientation of 5–8 (the camera stored the frame transposed, so what a
// browser shows has width and height swapped); PNG reads IHDR; WebP reads a VP8 (lossy), VP8L
// (lossless) or VP8X (extended) chunk. Anything else, or a header cut short, gives null.
const HEADER_BYTES = 64 * 1024;
const JPEG_SOF = new Set([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF]);
function imageDimensions(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  const size = (width, height) => width > 0 && height > 0 ? { width, height } : null;
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
    let offset = 2, transposed = false;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xFF) return null;
      const marker = bytes[offset + 1];
      if (marker === 0xFF) { offset += 1; continue; }                                                  // fill byte before a marker
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { offset += 2; continue; } // standalone markers
      if (marker === 0xD9 || marker === 0xDA) return null;                                             // end of image / scan data: no SOF
      const length = view.getUint16(offset + 2);
      if (length < 2) return null;
      if (JPEG_SOF.has(marker)) {
        if (offset + 9 > bytes.length) return null;
        const height = view.getUint16(offset + 5), width = view.getUint16(offset + 7);
        return transposed ? size(height, width) : size(width, height);
      }
      if (marker === 0xE1 && offset + 10 <= bytes.length && ascii(offset + 4, 6) === 'Exif\0\0') transposed = exifTransposed(bytes, view, offset + 10, Math.min(bytes.length, offset + 2 + length));
      offset += 2 + length;
    }
    return null;
  }
  if (bytes[0] === 0x89 && ascii(1, 3) === 'PNG') {
    return bytes.length >= 24 && ascii(12, 4) === 'IHDR' ? size(view.getUint32(16), view.getUint32(20)) : null;
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8 ' && bytes.length >= 30) return bytes[23] === 0x9D && bytes[24] === 0x01 && bytes[25] === 0x2A ? size(view.getUint16(26, true) & 0x3FFF, view.getUint16(28, true) & 0x3FFF) : null;
    if (chunk === 'VP8L' && bytes.length >= 25) { if (bytes[20] !== 0x2F) return null; const bits = view.getUint32(21, true); return size((bits & 0x3FFF) + 1, ((bits >>> 14) & 0x3FFF) + 1); }
    if (chunk === 'VP8X' && bytes.length >= 30) return size(1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)));
  }
  return null;
}
// True when the EXIF orientation tag (0x0112, in IFD0 of the TIFF block that starts at `start`) is
// 5–8: those orientations rotate by 90° or 270°, so the displayed width is the stored height.
function exifTransposed(bytes, view, start, end) {
  if (start + 8 > end) return false;
  const little = bytes[start] === 0x49 && bytes[start + 1] === 0x49;
  if (!little && !(bytes[start] === 0x4D && bytes[start + 1] === 0x4D)) return false;
  if (view.getUint16(start + 2, little) !== 0x2A) return false;
  const ifd = start + view.getUint32(start + 4, little);
  if (ifd + 2 > end) return false;
  const entries = view.getUint16(ifd, little);
  for (let i = 0; i < entries; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return false;
    if (view.getUint16(entry, little) === 0x0112) { const orientation = view.getUint16(entry + 8, little); return orientation >= 5 && orientation <= 8; }
  }
  return false;
}
// The crew studio sends its preview's pixel size (aspect-exact) with each upload. It is only a
// fallback for originals whose header cannot be read, never trusted over parsed bytes.
function dimensionHint(width, height) {
  const w = Number(width), h = Number(height);
  return Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= 65535 && h <= 65535 ? { width: w, height: h } : null;
}
const concatBytes = parts => { const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let at = 0; for (const part of parts) { out.set(part, at); at += part.length; } return out; };

// ── Preview formats ──────────────────────────────────────────────────────────
// Previews and grid thumbs are JPEG or WebP: the crew studio encodes WebP wherever the browser can
// (Chrome, Firefox, Safari 16+) and JPEG elsewhere. The format is always sniffed from the bytes —
// never taken from a header the client set — and decides the stored key's extension and content-type.
const PREVIEW_FORMATS = { jpeg: { type: 'image/jpeg', ext: 'jpg' }, webp: { type: 'image/webp', ext: 'webp' } };
function previewFormat(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 2) return null;
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return PREVIEW_FORMATS.jpeg;   // SOI marker
  if (bytes.length < 12) return null;                                        // a RIFF/WEBP signature needs twelve
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return PREVIEW_FORMATS.webp;
  return null;
}
// The same sniff for a Blob/File (the legacy multipart upload) or a byte array.
async function previewFormatOf(preview) {
  if (preview instanceof Uint8Array) return previewFormat(preview);
  if (preview && typeof preview.slice === 'function' && typeof preview.arrayBuffer === 'function') return previewFormat(new Uint8Array(await preview.slice(0, 12).arrayBuffer()));
  return null;
}
// One of the two formats a crew-sent preview or thumb may claim to be (the legacy multipart upload
// checks the declared type before reading any bytes, and keeps it when the bytes say nothing — that
// path is the pre-streaming client and its Blob type is all there is to go on).
const PREVIEW_TYPES = Object.values(PREVIEW_FORMATS).map(format => format.type);
const formatForType = type => Object.values(PREVIEW_FORMATS).find(format => format.type === type) || null;

// Streaming upload body layout: [uint32 preview length LE][preview JPEG/WebP bytes][original bytes].
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
  if (!previewFormat(preview)) throw new RequestError('The upload preview is invalid.', 400);
  const leftover = buf.slice(4 + previewLen);
  // R2.put only accepts a stream of known length, so pump the original (already-read leftover
  // plus the rest of the request) through the readable half of a FixedLengthStream.
  const originalLength = Number(request.headers.get('content-length')) - 4 - previewLen;
  if (!Number.isFinite(originalLength) || originalLength < 0) throw new RequestError('The upload is incomplete.', 400);
  const passthrough = new FixedLengthStream(originalLength);
  // The first HEADER_BYTES of the original are copied aside as they stream past (a tee, not a buffer:
  // the body itself is never held) so its pixel size can be read once R2 has consumed the stream.
  // R2 needs the FixedLengthStream's own readable, so the copy rides in this pump rather than in a
  // second TransformStream, which would lose the known length.
  const head = []; let headSize = 0; let settleHeader;
  const header = new Promise(resolve => { settleHeader = resolve; });
  const keep = chunk => {
    if (headSize >= HEADER_BYTES) return;
    const part = chunk.slice(0, HEADER_BYTES - headSize); head.push(part); headSize += part.length;
    if (headSize >= HEADER_BYTES) settleHeader(concatBytes(head));
  };
  (async () => {
    const writer = passthrough.writable.getWriter();
    try {
      if (leftover.length) { keep(leftover); await writer.write(leftover); }
      while (true) { const r = await reader.read(); if (r.done) break; keep(r.value); await writer.write(r.value); }
      await writer.close();
    } catch (streamError) { await writer.abort(streamError).catch(() => {}); }
    finally { settleHeader(concatBytes(head)); }
  })();
  return { preview, original: passthrough.readable, header };
}

// Shared finalize step for the legacy multipart upload, the streaming upload and the direct-to-R2
// `complete` call: resolve the filename against duplicates, store the objects, insert the row,
// clean up a replaced photo, and enqueue indexing. `original` may be a File or a ReadableStream —
// or already in the bucket (`stored: { photoId, key }`, put there by the browser through a presigned
// URL), in which case nothing is written for it and a `skip` removes it again. `header` resolves to
// its first bytes (parsed for the pixel size once the original is stored) and `hint` is the crew
// studio's ?width=&height=, used only when that parse fails. `thumb` (bytes, optional) is the grid
// thumbnail riding along with a direct upload; it lands in the same INSERT when migration 0008 exists.
async function storeSessionPhoto(env, request, sessionId, { filename, contentType, original = null, preview, onDuplicate, header = null, hint = null, stored = null, thumb = null, previewType = null }) {
  const format = await previewFormatOf(preview) || formatForType(previewType);
  if (!format) throw new RequestError('The upload preview is invalid.', 400);
  const thumbFormat = thumb?.length ? previewFormat(thumb) : null;
  if (thumb?.length && !thumbFormat) throw new RequestError('The thumbnail must be a JPEG or WebP.', 400);
  let name = safeFilename(filename); let duplicates = [];
  const hasThumb = await hasColumn(env, 'photos', 'thumb_key');
  if (onDuplicate) {
    duplicates = (await env.DB.prepare(`SELECT id, object_key, preview_key${hasThumb ? ', thumb_key' : ''} FROM photos WHERE session_id = ? AND filename = ? COLLATE NOCASE`).bind(sessionId, name).all()).results;
    if (duplicates.length && onDuplicate === 'skip') {
      if (stored) await env.PHOTOS.delete(stored.key).catch(() => {});   // the browser already put the original there; nothing keeps it
      return response({ skipped: true, filename: name }, request, env);
    }
    if (duplicates.length && onDuplicate === 'rename') {
      const taken = new Set((await env.DB.prepare('SELECT filename FROM photos WHERE session_id = ?').bind(sessionId).all()).results.map(row => row.filename.toLowerCase()));
      name = uniqueFilename(name, taken);
    }
  }
  const photoId = stored?.photoId || id(); const objectKey = stored?.key || `sessions/${sessionId}/original/${photoId}-${name}`; const previewKey = `sessions/${sessionId}/preview/${photoId}.${format.ext}`;
  // Store the streamed original first (unless the browser already did), then the buffered preview and thumb.
  if (!stored) await env.PHOTOS.put(objectKey, original, { httpMetadata: { contentType } });
  await env.PHOTOS.put(previewKey, preview, { httpMetadata: { contentType: format.type } });
  const thumbKey = thumbFormat && hasThumb ? `sessions/${sessionId}/thumb/${photoId}.${thumbFormat.ext}` : null;
  if (thumbKey) await env.PHOTOS.put(thumbKey, thumb, { httpMetadata: { contentType: thumbFormat.type } });
  // Pixel size (migration 0012): parsed bytes win; the hint only fills in when the header is unreadable.
  let dims = null;
  try { dims = header ? imageDimensions(new Uint8Array(await header)) : null; } catch { dims = null; }
  dims = dims || hint;
  const withDims = Boolean(dims) && await hasColumn(env, 'photos', 'width');
  await env.DB.prepare(`INSERT INTO photos (id, session_id, object_key, preview_key, filename, content_type, indexing_status${withDims ? ', width, height' : ''}${thumbKey ? ', thumb_key' : ''}) VALUES (?, ?, ?, ?, ?, ?, 'pending'${withDims ? ', ?, ?' : ''}${thumbKey ? ', ?' : ''})`)
    .bind(photoId, sessionId, objectKey, previewKey, name, contentType, ...(withDims ? [dims.width, dims.height] : []), ...(thumbKey ? [thumbKey] : [])).run();
  if (duplicates.length && onDuplicate === 'replace') {
    // Remove the old rows before their files so a failed delete never leaves a photo pointing at missing media.
    await env.DB.batch(duplicates.flatMap(photo => [env.DB.prepare('DELETE FROM faces WHERE photo_id = ?').bind(photo.id), env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(photo.id)]));
    await Promise.all(duplicates.flatMap(photo => [photo.object_key, photo.preview_key, photo.thumb_key].filter(Boolean).map(key => env.PHOTOS.delete(key))));
  }
  const processing = await enqueuePhotos([{ id: photoId }], env);
  return response({ photoId, filename: name, status: processing.failed ? 'failed' : 'pending', duplicate: duplicates.length ? (onDuplicate === 'replace' ? 'replaced' : 'renamed') : null, replaced: onDuplicate === 'replace' ? duplicates.length : 0, thumb: Boolean(thumbKey) }, request, env, 201);
}

// ── Direct-to-R2 uploads: AWS Signature V4 query-string presigning ───────────
// The browser PUTs each original straight into the bucket through R2's S3-compatible endpoint
// (`https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com/<bucket>/<key>`), so a 20 MB photo never
// passes through this Worker; only the small preview and thumb come here afterwards (`complete`).
// Secrets (`wrangler secret put`): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY — an R2 API
// token with object read/write on the photos bucket. Var R2_BUCKET overrides the bucket name (it
// defaults to the binding's bucket in wrangler.jsonc). While any of the three is unset, `presign`
// answers 503 { fallback: 'stream' } and the studio keeps using the streaming route above.
// Signing is plain WebCrypto with no dependency: canonical request → string to sign → HMAC chain,
// exactly as AWS documents it (tests/uploads.test.mjs checks the published example vector).
const PRESIGN_SECONDS = 15 * 60, DIRECT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024, R2_DEFAULT_BUCKET = 'mambo-jambo-photos';
const sigv4Encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const sigHex = bytes => Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join('');   // ArrayBuffer-friendly; the crew-account helpers below have their own byte-array hex()
const sha256Hex = async value => sigHex(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value));
async function hmacBytes(key, value) {
  const cryptoKey = await crypto.subtle.importKey('raw', typeof key === 'string' ? encoder.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(value));
}
// `url` is the full object URL; `headers` are the request headers the client will send verbatim
// (host is always signed; content-type pins the object's type). `now` is injectable for the test vector.
async function presignS3Url({ method = 'PUT', url, accessKeyId, secretAccessKey, region = 'auto', service = 's3', expires = PRESIGN_SECONDS, headers = {}, now = new Date() }) {
  const target = new URL(url);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const shortDate = amzDate.slice(0, 8);
  const scope = `${shortDate}/${region}/${service}/aws4_request`;
  const signedHeaders = Object.fromEntries(Object.entries({ host: target.host, ...headers }).map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/\s+/g, ' ')]));
  const headerNames = Object.keys(signedHeaders).sort();
  const query = new URLSearchParams(target.search);
  query.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  query.set('X-Amz-Credential', `${accessKeyId}/${scope}`);
  query.set('X-Amz-Date', amzDate);
  query.set('X-Amz-Expires', String(expires));
  query.set('X-Amz-SignedHeaders', headerNames.join(';'));
  const canonicalQuery = [...query.entries()].map(([name, value]) => [sigv4Encode(name), sigv4Encode(value)]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1).map(pair => pair.join('=')).join('&');
  const canonicalPath = target.pathname.split('/').map(segment => sigv4Encode(decodeURIComponent(segment))).join('/') || '/';
  const canonicalRequest = [method, canonicalPath, canonicalQuery, ...headerNames.map(name => `${name}:${signedHeaders[name]}`), '', headerNames.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  let key = await hmacBytes(`AWS4${secretAccessKey}`, shortDate);
  for (const part of [region, service, 'aws4_request']) key = await hmacBytes(key, part);
  const signature = sigHex(await hmacBytes(key, stringToSign));
  return `${target.origin}${target.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
const directUploadsConfigured = env => Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
const r2ObjectUrl = (env, key) => `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET || R2_DEFAULT_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;
// The `complete` body: [uint32 preview length LE][preview bytes][thumb bytes, possibly none] — the
// streaming frame with the thumbnail where the original would be, fully buffered (it is small).
async function readFramedSmall(request, maxBytes) {
  const bytes = new Uint8Array(await (await boundedBody(request, maxBytes)).arrayBuffer());
  if (bytes.length < 4) throw new RequestError('The upload is incomplete.', 400);
  const previewLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getUint32(0, true);
  if (!previewLen || 4 + previewLen > bytes.length) throw new RequestError('The upload preview is invalid.', 400);
  return { preview: bytes.slice(4, 4 + previewLen), thumb: bytes.slice(4 + previewLen) };
}
export { presignS3Url, previewFormat };
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
// ── Session conditions (migration 0014) ──────────────────────────────────────
// Crew-entered surf conditions and the time the next batch of photos is expected. Every field is
// optional; null or '' clears one. Wind and tide are free text (≤ 30) but the known words are stored
// lower-case so the site can show them as stamps.
const CONDITION_COLUMNS = { breakName: 'break_name', swellFt: 'swell_ft', wind: 'wind', tide: 'tide', photographer: 'photographer', nextDropAt: 'next_drop_at' };
const WIND_KINDS = ['offshore', 'onshore', 'cross', 'glassy', 'light', 'strong'], TIDE_KINDS = ['low', 'mid', 'high', 'rising', 'dropping'];
function validateConditions(data) {
  const out = {};
  const text = (field, max, label, kinds = []) => {
    const value = data[field];
    if (value === undefined) return;
    if (value === null || value === '') { out[field] = null; return; }
    if (typeof value !== 'string' || value.trim().length > max) throw new RequestError(`${label} must be ${max} characters or fewer.`);
    const trimmed = value.trim(); out[field] = kinds.includes(trimmed.toLowerCase()) ? trimmed.toLowerCase() : trimmed || null;
  };
  text('breakName', 60, 'The break name'); text('wind', 30, 'Wind', WIND_KINDS); text('tide', 30, 'Tide', TIDE_KINDS); text('photographer', 60, 'The photographer');
  if (data.swellFt !== undefined) {
    if (data.swellFt === null || data.swellFt === '') out.swellFt = null;
    else { const feet = Number(data.swellFt); if (!Number.isFinite(feet) || feet < 0 || feet > 30) throw new RequestError('Swell must be between 0 and 30 ft.'); out.swellFt = Math.round(feet * 10) / 10; }
  }
  if (data.nextDropAt !== undefined) {
    if (data.nextDropAt === null || data.nextDropAt === '') out.nextDropAt = null;
    else {
      const at = typeof data.nextDropAt === 'string' ? Date.parse(data.nextDropAt) : NaN;
      if (!Number.isFinite(at)) throw new RequestError('Enter a valid next-drop time.');
      if (at <= Date.now()) throw new RequestError('The next-drop time must be in the future.');
      out.nextDropAt = new Date(at).toISOString();
    }
  }
  return out;
}
// What the API returns: `conditions` is null when every field is empty; `nextDropAt` only while it is
// still ahead (a drop that already happened is not a promise the site should repeat).
function conditionsOf(row) {
  const swell = row?.swell_ft === null || row?.swell_ft === undefined || row.swell_ft === '' ? null : Number(row.swell_ft);
  const conditions = { breakName: row?.break_name || null, swellFt: Number.isFinite(swell) ? swell : null, wind: row?.wind || null, tide: row?.tide || null, photographer: row?.photographer || null };
  return Object.values(conditions).some(value => value !== null) ? conditions : null;
}
function nextDropOf(row) { const at = Date.parse(row?.next_drop_at); return Number.isFinite(at) && at > Date.now() ? new Date(at).toISOString() : null; }
const conditionsRow = fields => Object.fromEntries(Object.entries(CONDITION_COLUMNS).map(([field, column]) => [column, fields[field] ?? null]));
// Splits a joined row into the API's session object plus its conditions (the raw columns never leak).
function withConditions({ break_name, swell_ft, wind, tide, photographer, next_drop_at, ...rest }) {
  return { ...rest, conditions: conditionsOf({ break_name, swell_ft, wind, tide, photographer }), nextDropAt: nextDropOf({ next_drop_at }) };
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
const ADMIN_TOKEN_HOURS = 8, ADMIN_SEEN_INTERVAL_MS = 5 * 60_000;
// Signature and expiry first (no I/O, so junk tokens never reach D1), then one lookup of the token's
// admin_sessions row (migration 0011): a missing, revoked or expired row is refused. last_seen_at is
// touched at most every five minutes. If the table is missing (unmigrated database) the signed token
// is accepted with a warning so a Worker deploy that precedes the migration never locks the crew out;
// any other D1 failure refuses the token (a revoked one must never slip through on an outage).
// The answer is the crew identity the routes gate on: { sid, uid, role, name } — `uid`/`name` are
// null for the shared password, and the stored row's role wins over the token's, so a demotion
// takes effect on the next request rather than at the next sign-in. SELECT * on purpose: naming
// user_id/role would throw "no such column" on a pre-0016 database and refuse every token.
async function requireAdmin(request, env) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const payload = await verify(token, env);
  if (!CREW_ROLES.includes(payload?.role) || typeof payload.sid !== 'string' || !payload.sid) return null;
  const identity = (row) => ({ ...payload, uid: row?.user_id ?? payload.uid ?? null, role: row?.role || payload.role, name: payload.name || null });
  if (!env.DB) return identity(null);
  let row;
  try { row = await env.DB.prepare('SELECT * FROM admin_sessions WHERE id = ?').bind(payload.sid).first(); }
  catch (caught) {
    if (!isMissingTable(caught)) { console.error('admin_sessions lookup failed — refusing the crew token:', caught?.message ?? String(caught)); return null; }
    console.warn('admin_sessions unavailable (is migration 0011 applied?) — accepting the signed token:', caught?.message ?? String(caught)); return identity(null);
  }
  if (!row || row.revoked_at || !(Date.parse(row.expires_at) > Date.now())) return null;
  if (!(Date.now() - (Date.parse(row.last_seen_at) || 0) < ADMIN_SEEN_INTERVAL_MS)) {
    try { await env.DB.prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?').bind(new Date().toISOString(), payload.sid).run(); } catch { /* best effort */ }
  }
  return identity(row);
}
// The search token proves the guest owns a search: in the query or Authorization header for the
// GET routes (previews, access, download), as a body field for the POST ones (colour, hide, notify).
async function searchPayload(token, env, searchId) {
  const payload = await verify(token, env);
  return payload?.scope === 'search' && payload.searchId === searchId ? payload : null;
}
async function requireSearch(request, env, searchId) {
  const token = new URL(request.url).searchParams.get('token') || request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  return searchPayload(token, env, searchId);
}
// The public site for links handed to guests (checkout return, gallery links): the caller's origin
// when it is an allowed one (the site and the studio share a host), else the first configured origin.
function siteOrigin(request, env, url) {
  const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean);
  const origin = request.headers.get('Origin');
  return origin && allowed.includes(origin) ? origin : (allowed[0] || url.origin);
}
function safeFilename(filename) {
  return (filename || 'photo.jpg').replace(/[^a-zA-Z0-9._-]/g, '-').slice(-120);
}
const DUPLICATE_MODES = ['replace', 'skip', 'rename'];
const BULK_ACTIONS = ['delete', 'reindex', 'move', 'cover'], BULK_LIMIT = 200;
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
const MEDIA_CACHE_SECONDS = 3600;   // cap for preview/thumb caching; the effective value is min(this, seconds until the token expires)
// `claims` distinguish what a token is for: `{ scope: 'cover' }` for a landing-page cover (renders, never
// downloads, counts nothing), `{ searchId }` for the originals of a paid search (the only tokens whose
// ?download=1 is a funnel `download`). Crew review images and lookup thumbs carry neither.
async function mediaToken(photoId, variant, env, minutes = MEDIA_TOKEN_MINUTES[variant] || 20, claims = {}) {
  return sign({ scope: 'media', photoId, variant, ...claims, exp: Date.now() + minutes * 60_000 }, env);
}
async function mediaLink(base, photoId, variant, env, extra = '', claims = {}) {
  return `${base}/api/media/${photoId}?variant=${variant}&token=${encodeURIComponent(await mediaToken(photoId, variant, env, undefined, claims))}${extra}`;
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
// `photos.width`/`height` arrived in migration 0012 and are detected the same way.
async function dimensionColumns(env, prefix = '') { return (await hasColumn(env, 'photos', 'width')) ? `, ${prefix}width, ${prefix}height` : ''; }
// `sessions.break_name` … `next_drop_at` arrived in migration 0014; selected only once they exist.
async function conditionColumns(env, prefix = '') { return (await hasColumn(env, 'sessions', 'break_name')) ? Object.values(CONDITION_COLUMNS).map(column => `, ${prefix}${column}`).join('') : ''; }
// The photos a search shows: its face matches plus whatever the colour search added (migration
// 0015), de-duplicated. A photo the guest hid has already left both lists.
function parseIds(json) { try { const ids = JSON.parse(json || '[]'); return Array.isArray(ids) ? ids.filter(value => typeof value === 'string') : []; } catch { return []; } }
function searchPhotoIds(search) { return [...new Set([...parseIds(search.matched_photo_ids_json), ...parseIds(search.colour_photo_ids_json)])]; }
// Integers on every photo object the API returns; both null until the photo was uploaded with 0012 applied.
function dimensions(photo) {
  const width = Number(photo?.width), height = Number(photo?.height);
  return Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0 ? { width, height } : { width: null, height: null };
}
// Grid tiles use the small thumbnail when one exists and fall back to the 1400px preview otherwise.
async function previewLinks(base, photo, env) {
  const url = await mediaLink(base, photo.id, 'preview', env);
  return { url, thumbUrl: photo.thumb_key ? await mediaLink(base, photo.id, 'thumb', env) : url, ...dimensions(photo) };
}
async function previewPayload(search, request, env) {
  const photoIds = searchPhotoIds(search);
  if (!photoIds.length) return [];
  const rows = await env.DB.prepare(`SELECT id${await thumbColumn(env)}${await dimensionColumns(env)} FROM photos WHERE session_id = ? AND id IN (${photoIds.map(() => '?').join(',')})`)
    .bind(search.session_id, ...photoIds).all();
  const base = new URL(request.url).origin;
  return Promise.all(rows.results.map(async photo => ({ photoId: photo.id, ...(await previewLinks(base, photo, env)) })));
}
async function accessPayload(search, request, env) {
  const photoIds = searchPhotoIds(search);
  if (!photoIds.length) return [];
  const rows = await env.DB.prepare(`SELECT id${await thumbColumn(env)}${await dimensionColumns(env)} FROM photos WHERE session_id = ? AND id IN (${photoIds.map(() => '?').join(',')})`)
    .bind(search.session_id, ...photoIds).all();
  const base = new URL(request.url).origin;
  return Promise.all(rows.results.map(async photo => {
    const url = await mediaLink(base, photo.id, 'original', env, '', { searchId: search.id });   // a paid search's original: its download counts
    return { photoId: photo.id, url, downloadUrl: `${url}&download=1`, thumbUrl: photo.thumb_key ? await mediaLink(base, photo.id, 'thumb', env) : url, ...dimensions(photo) };
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
// ── Per-client quotas ─────────────────────────────────────────────────────────
// Cloudflare sets cf-connecting-ip on every request; the first x-forwarded-for hop only matters
// behind a local proxy. 'unknown' shares one bucket rather than escaping the cap.
function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
}
// What a quota is keyed on. IPv4 stays whole; IPv6 is cut to its /64 (a phone on mobile data owns a
// whole /64 and rotates through it, so keying on the full address would let one guest walk past the
// cap); an IPv4-mapped address (::ffff:a.b.c.d) is its IPv4; anything unparseable shares 'unknown'.
// Only quotas use this — login_attempts and admin_sessions.ip keep the exact address.
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
function quotaKeyFor(ip) {
  if (typeof ip !== 'string') return 'unknown';
  const address = ip.trim().replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (IPV4.test(address)) return address;
  const mapped = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return IPV4.test(mapped[1]) ? mapped[1] : 'unknown';
  if (!address.includes(':') || !/^[0-9a-f:]+$/.test(address)) return 'unknown';
  const halves = address.split('::');
  if (halves.length > 2) return 'unknown';
  const head = halves[0] ? halves[0].split(':') : [], tail = halves[1] ? halves[1].split(':') : [];
  if ([...head, ...tail].some(part => !/^[0-9a-f]{1,4}$/.test(part))) return 'unknown';
  const given = head.length + tail.length;
  if (halves.length === 2 ? given > 7 : given !== 8) return 'unknown';          // '::' stands for at least one zero group
  const hextets = halves.length === 2 ? [...head, ...Array(8 - given).fill('0'), ...tail] : head;
  return `${hextets.slice(0, 4).map(part => part.padStart(4, '0')).join(':')}::/64`;
}
// Fixed-window counter in D1 (migration 0010). One upsert both counts the request and reads the window
// back, so two concurrent requests can never both slip under the cap, and a refused request still
// counts (retrying while blocked never buys quota). Fails open with a warning only when the table is
// missing, so a Worker deploy that races the migration never blocks guests; any other D1 failure
// refuses (`unavailable: true`, retry in 30 s) rather than lifting the cap. Reusable for any keyed quota.
const LIMITER_RETRY_SECONDS = 30;
async function limiter(env, key, max, windowSeconds) {
  try {
    const row = await env.DB.prepare(`INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN strftime('%s', 'now') - strftime('%s', window_start) >= ? THEN 1 ELSE count + 1 END,
        window_start = CASE WHEN strftime('%s', 'now') - strftime('%s', window_start) >= ? THEN CURRENT_TIMESTAMP ELSE window_start END
      RETURNING count, strftime('%s', 'now') - strftime('%s', window_start) AS elapsed`).bind(key, windowSeconds, windowSeconds).first();
    if (!row) throw new Error('the quota upsert returned no row');
    const count = Number(row.count) || 0;
    return { allowed: count <= max, count, retryAfter: Math.max(1, windowSeconds - (Number(row.elapsed) || 0)) };
  } catch (caught) {
    if (!isMissingTable(caught)) {
      console.error('rate limiter failed — refusing the request for now:', caught?.message ?? String(caught));
      return { allowed: false, count: 0, retryAfter: LIMITER_RETRY_SECONDS, unavailable: true };
    }
    console.warn('rate limiter unavailable (is migration 0010 applied?) — allowing the request:', caught?.message ?? String(caught));
    return { allowed: true, count: 0, retryAfter: 0 };
  }
}
// A quota that could not be checked (D1 error, not a missing table): 503 with a short retry-after, in
// the shape the guest page already understands, rather than a 429 blaming the guest.
function quotaUnavailable(request, env) {
  return json({ error: 'Searching is briefly unavailable. Please try again in a moment.' }, 503, { ...cors(request, env), 'retry-after': String(LIMITER_RETRY_SECONDS) });
}
// Finished windows are swept opportunistically, once per limited request path; the longest window is
// a day, and the text comparison keeps the window_start index usable.
function sweepRateLimits(env, ctx) {
  try {
    const done = env.DB.prepare("DELETE FROM rate_limits WHERE window_start < datetime('now', '-1 day')").run().catch(() => {});
    ctx?.waitUntil?.(done);
  } catch { /* unmigrated — nothing to sweep */ }
}
const MATCH_LIMITS = [{ label: '10m', max: 8, seconds: 600 }, { label: '1d', max: 30, seconds: 86400 }];   // shortest window first: charging stops at the first refusal
// Guest copy for a 429: minutes while the short window blocks, hours once the daily cap does.
function retryCopy(seconds) {
  if (seconds >= 5400) return `${Math.ceil(seconds / 3600)} hours`;
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
// ── Colour search (the second chance after a zero match) ─────────────────────
// photo_appearances holds the face service's clothing histogram: OpenCV calcHist over HSV with 30
// hue bins (OpenCV hue 0–180, so 12° of standard hue each) × 32 saturation bins, row-major
// (hue × 32 + sat), min-max normalised. A photo's score for a chosen hue is the share of its
// clothing mass sitting in that hue — the exact bin, ±1 bin at half weight, ±2 at a sixth, wrapping
// around the wheel — with the tone choosing which saturation bins count: vivid wants saturated
// kit, muted wants pastels, any takes everything except the near-grey bins whose hue is noise.
const HUE_BINS = 30, SAT_BINS = 32, HUE_KERNEL = [1, 0.5, 0.15];
const COLOUR_TONES = {
  vivid: sat => sat >= 16 ? 1 : sat >= 8 ? 0.4 : 0,
  muted: sat => sat < 3 ? 0 : sat <= 15 ? 1 : sat <= 23 ? 0.4 : 0,
  any: sat => sat < 3 ? 0 : 1,
};
const COLOUR_LIMIT = 40, COLOUR_FLOOR = 0.05, COLOUR_LIMITS = { max: 8, seconds: 600 };
function colourScore(histogram, hue, tone) {
  if (!Array.isArray(histogram) || histogram.length !== HUE_BINS * SAT_BINS) return null;
  const centre = Math.floor((((hue % 360) + 360) % 360) / (360 / HUE_BINS)); const satWeight = COLOUR_TONES[tone] || COLOUR_TONES.any;
  let mass = 0, hit = 0;
  for (let h = 0; h < HUE_BINS; h += 1) {
    const away = Math.abs(h - centre); const hueWeight = HUE_KERNEL[Math.min(away, HUE_BINS - away)] || 0;
    for (let s = 0; s < SAT_BINS; s += 1) {
      const value = Number(histogram[h * SAT_BINS + s]) || 0;
      if (value <= 0) continue;
      mass += value;
      if (hueWeight) hit += hueWeight * satWeight(s) * value;
    }
  }
  return mass > 0 ? hit / mass : null;
}
// Photos the guest hid on a search (migration 0015): empty when the table is missing.
async function hiddenPhotoIds(env, searchId) {
  try { return new Set((await env.DB.prepare('SELECT photo_id FROM match_hides WHERE search_id = ?').bind(searchId).all()).results.map(row => row.photo_id)); }
  catch { return new Set(); }
}
const isMissingTable = caught => /no such table/i.test(caught?.message ?? '');
// ── Guest funnel events (migration 0013) ─────────────────────────────────────
// One row per step, ids and a timestamp only — never the selfie, a phone number or an IP. Recording
// is best effort: a missing table (or any D1 error) logs a warning and the request carries on.
async function recordEvents(env, events) {
  try {
    const statements = events.map(({ kind, sessionId = null, searchId = null }) => env.DB.prepare('INSERT INTO events (id, kind, session_id, search_id) VALUES (?, ?, ?, ?)').bind(id(), kind, sessionId, searchId));
    if (statements.length === 1) await statements[0].run(); else if (statements.length) await env.DB.batch(statements);
  } catch (caught) { console.warn('events unavailable (is migration 0013 applied?) — funnel event not recorded:', caught?.message ?? String(caught)); }
}
// GET /api/admin/stats: the funnel per session. Every session appears (zeros included) so the studio
// can merge by sessionId; `unlocks` counts `paid` events (one per payment, whichever of verify or
// webhook transitioned it); `rupees` sums payments Cashfree confirmed (`verified` by the guest's
// verify call or `captured` by the webhook — the same money either way). Without the events table
// the answer is empty with `unmigrated: true`, never an error.
const FUNNEL_COUNTS = { searches: 'search', matches: 'match', zeroMatches: 'zero_match', checkouts: 'checkout', unlocks: 'paid', downloads: 'download' };
async function funnelStats(env) {
  const zeros = () => ({ searches: 0, matches: 0, zeroMatches: 0, zeroMatchRate: 0, checkouts: 0, unlocks: 0, downloads: 0, rupees: 0, grants: 0 });
  const rate = (zero, searches) => searches ? zero / searches : 0;
  const rupees = paise => Math.round(Number(paise) || 0) / 100;
  const counts = Object.entries(FUNNEL_COUNTS).map(([name, kind]) => `SUM(CASE WHEN e.kind = '${kind}' THEN 1 ELSE 0 END) AS ${name}`).join(', ');
  let rows, money;
  try {
    [rows, money] = await env.DB.batch([
      env.DB.prepare(`SELECT s.id, s.title, ${counts} FROM sessions s LEFT JOIN events e ON e.session_id = s.id GROUP BY s.id ORDER BY s.created_at DESC`),
      env.DB.prepare("SELECT sr.session_id, SUM(p.amount_paise) AS paise FROM payments p JOIN searches sr ON sr.id = p.search_id WHERE p.status IN ('verified', 'captured') GROUP BY sr.session_id"),
    ]);
  } catch (caught) {
    if (!/no such table/i.test(caught?.message ?? '')) throw caught;
    console.warn('events unavailable (is migration 0013 applied?) — stats are empty:', caught?.message ?? String(caught));
    return { sessions: [], totals: zeros(), unmigrated: true };
  }
  const paise = new Map((money.results || []).map(row => [row.session_id, Number(row.paise) || 0]));
  // Free unlocks (migration 0015) are neither unlocks nor rupees: counted apart, zero until the table exists.
  let grants = new Map();
  try { grants = new Map((await env.DB.prepare('SELECT sr.session_id, COUNT(*) AS n FROM grants g JOIN searches sr ON sr.id = g.search_id GROUP BY sr.session_id').all()).results.map(row => [row.session_id, Number(row.n) || 0])); }
  catch (caught) { if (!isMissingTable(caught)) throw caught; }
  const sessions = (rows.results || []).map(row => {
    const count = name => Number(row[name]) || 0;
    return { sessionId: row.id, title: row.title, searches: count('searches'), matches: count('matches'), zeroMatches: count('zeroMatches'), zeroMatchRate: rate(count('zeroMatches'), count('searches')), checkouts: count('checkouts'), unlocks: count('unlocks'), downloads: count('downloads'), rupees: rupees(paise.get(row.id)), grants: grants.get(row.id) || 0 };
  });
  const totals = zeros(); let totalPaise = 0;
  for (const stat of sessions) { for (const name of [...Object.keys(FUNNEL_COUNTS), 'grants']) totals[name] += stat[name]; totalPaise += paise.get(stat.sessionId) || 0; }
  totals.zeroMatchRate = rate(totals.zeroMatches, totals.searches); totals.rupees = rupees(totalPaise);
  return { sessions, totals };
}
// ── Review undo (F30) ─────────────────────────────────────────────────────────
// A confirm/reject can be taken back for ten minutes: the pair or link returns to `pending` and the
// match_feedback row that decision inserted is removed. Rows tagged with subject_id (migration 0013)
// are found exactly; older rows fall back to the newest one with the same source, score and label
// from the last ten minutes (the same decision's values), so nothing else is ever unlearned.
const UNDO_WINDOW_MS = 10 * 60_000;
const FEEDBACK_SCORE_COLUMN = { face_pair: 'face_similarity', burst_link: 'burst_score', appearance_link: 'appearance_similarity' };
async function removeFeedback(env, { subjectId, source, score, label }) {
  const tagged = await hasColumn(env, 'match_feedback', 'subject_id');
  if (tagged) {
    const removed = await env.DB.prepare('DELETE FROM match_feedback WHERE subject_id = ?').bind(subjectId).run();
    if (removed.meta?.changes) return;
  }
  await env.DB.prepare(`DELETE FROM match_feedback WHERE id = (SELECT id FROM match_feedback WHERE source = ? AND ${FEEDBACK_SCORE_COLUMN[source]} = ? AND label = ?${tagged ? ' AND subject_id IS NULL' : ''} AND created_at >= datetime('now', '-10 minutes') ORDER BY created_at DESC LIMIT 1)`)
    .bind(source, score, label).run();
}
// A crew decision's feedback insert, tagged with the pair or link it came from once 0013 is applied.
async function recordFeedback(env, { source, score, label, subjectId }) {
  const tagged = await hasColumn(env, 'match_feedback', 'subject_id');
  await env.DB.prepare(`INSERT INTO match_feedback (id, source, ${FEEDBACK_SCORE_COLUMN[source]}, label${tagged ? ', subject_id' : ''}) VALUES (?, ?, ?, ?${tagged ? ', ?' : ''})`)
    .bind(id(), source, score, label, ...(tagged ? [subjectId] : [])).run();
}
// A shared crew password with unlimited attempts is brute-forceable; count failures per IP in D1
// (migration 0008). If that table is missing the check is skipped rather than locking the crew out.
const LOGIN_WINDOW_MINUTES = 15, LOGIN_MAX_FAILURES = 5;
// Keyed on the source IP *and*, once crew accounts exist (migration 0016), on the account name, so
// a guess spread over many addresses still stops after five tries at one account. login_attempts.ip
// is only a key column, so the name bucket rides in it as `name:<lowercased>` — no migration needed.
async function loginThrottle(request, env, name = '') {
  const keys = [clientIp(request), ...(name ? [`name:${name.toLowerCase().slice(0, 60)}`] : [])];
  const count = async (key) => {
    try {
      const row = await env.DB.prepare('SELECT count, window_start FROM login_attempts WHERE ip = ?').bind(key).first();
      if (!row) return 0;
      const started = Date.parse(`${row.window_start}Z`) || Date.parse(row.window_start) || 0;
      if (Date.now() - started > LOGIN_WINDOW_MINUTES * 60_000) return 0;
      return Number(row.count) || 0;
    } catch { return 0; }
  };
  const counts = await Promise.all(keys.map(count));
  return {
    blocked: Math.max(...counts) >= LOGIN_MAX_FAILURES,
    async failed() {
      for (const key of keys) {
        try {
          await env.DB.prepare(`INSERT INTO login_attempts (ip, count, window_start) VALUES (?, 1, CURRENT_TIMESTAMP)
            ON CONFLICT(ip) DO UPDATE SET count = CASE WHEN (julianday(CURRENT_TIMESTAMP) - julianday(window_start)) * 1440 > ? THEN 1 ELSE count + 1 END,
              window_start = CASE WHEN (julianday(CURRENT_TIMESTAMP) - julianday(window_start)) * 1440 > ? THEN CURRENT_TIMESTAMP ELSE window_start END`)
            .bind(key, LOGIN_WINDOW_MINUTES, LOGIN_WINDOW_MINUTES).run();
        } catch { /* Table not migrated yet — login still works, just without throttling. */ }
      }
    },
    async succeeded() { for (const key of keys) { try { await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(key).run(); } catch { /* optional */ } } },
  };
}
// ── Crew accounts, TOTP and the audit log (migration 0016) ───────────────────
// One row per crew member in `crew_users`: a PBKDF2-SHA256 password (WebCrypto, 210 000 rounds —
// 50–200 ms per derivation in a local workerd on this Mac, inside the Paid plan's CPU budget), an optional RFC 6238
// TOTP secret, and a role. `photographer` may run the whole photo workflow; only `admin` touches
// money (refunds, free unlocks) or deletes a published session. Nothing here can lock the crew out:
// while the tables are missing, while no enabled account exists, or while LEGACY_SHARED_LOGIN is
// 'true', the shared ADMIN_PASSWORD still signs in as an admin (audited as 'crew (shared)').
const PBKDF2_ITERATIONS = 210_000, CREW_ROLES = ['photographer', 'admin'], SHARED_ACTOR = 'crew (shared)';
const CREW_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .'\-]{1,39}$/u, MIN_PASSWORD = 10, MAX_PASSWORD = 200;
const hex = (bytes) => Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('');
const randomHex = (length) => hex(crypto.getRandomValues(new Uint8Array(length)));
async function hashPassword(password, salt, iterations = PBKDF2_ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(String(salt)), iterations, hash: 'SHA-256' }, key, 256)));
}
async function makePassword(password) {
  const salt = randomHex(16);
  return { hash: await hashPassword(password, salt), salt, iterations: PBKDF2_ITERATIONS };
}
// Constant-time compare of the derived keys (same() refuses different lengths, which a stored hash
// from another iteration count would never be — the row carries the count it was made with).
async function passwordMatches(password, row) {
  if (typeof password !== 'string' || !password || !row?.password_hash || !row?.password_salt) return false;
  return same(await hashPassword(password, row.password_salt, Number(row.iterations) || PBKDF2_ITERATIONS), row.password_hash);
}
// A wrong name must cost about as much as a wrong password, or the timing names the crew. The salt is a
// constant on purpose: the derived bits are thrown away, and workerd refuses to start a module that draws
// random values at global scope ("Disallowed operation called within global scope").
const DECOY_SALT = 'decoy-salt-for-timing-only';
const burnPasswordTime = (password) => hashPassword(typeof password === 'string' ? password : '', DECOY_SALT).catch(() => {});
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(secret) {
  const clean = String(secret || '').toUpperCase().replace(/[\s=]/g, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  const bytes = []; let bits = 0, value = 0;
  for (const character of clean) { value = (value << 5) | BASE32.indexOf(character); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return new Uint8Array(bytes);
}
// RFC 6238: HMAC-SHA1 over the 30-second counter, dynamically truncated to six digits. `at` is a
// millisecond timestamp; ±1 step is accepted at sign-in so a slow phone clock still works.
const TOTP_STEP_SECONDS = 30, TOTP_DIGITS = 6, TOTP_DRIFT_STEPS = 1;
async function hotp(keyBytes, counter, digits = TOTP_DIGITS) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, BigInt(counter));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = mac[mac.length - 1] & 0x0f;
  const truncated = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(truncated % 10 ** digits).padStart(digits, '0');
}
async function totpAt(secret, at = Date.now(), digits = TOTP_DIGITS) {
  const keyBytes = base32Decode(secret);
  return keyBytes?.length ? hotp(keyBytes, Math.floor(at / 1000 / TOTP_STEP_SECONDS), digits) : null;
}
async function totpMatches(secret, code, at = Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return false;
  const keyBytes = base32Decode(secret);
  if (!keyBytes?.length) return false;
  const step = Math.floor(at / 1000 / TOTP_STEP_SECONDS);
  for (let drift = -TOTP_DRIFT_STEPS; drift <= TOTP_DRIFT_STEPS; drift += 1) {
    if (same(await hotp(keyBytes, step + drift), code.trim())) return true;
  }
  return false;
}
const totpUri = (name, secret) => `otpauth://totp/SOI%20Crew:${encodeURIComponent(name)}?secret=${secret}&issuer=SOI%20Crew&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
// crew_users lookups. A missing table (pre-0016 database) answers `null` / "no accounts" rather
// than throwing, so every caller degrades into the shared-password world.
async function crewUserByName(env, name) {
  if (!env.DB || !name) return null;
  try { return await env.DB.prepare('SELECT * FROM crew_users WHERE name = ?').bind(name).first(); }
  catch (caught) { if (!isMissingTable(caught)) console.error('crew_users lookup failed:', caught?.message ?? String(caught)); return null; }
}
async function crewAccountsExist(env) {
  if (!env.DB) return false;
  try { return Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM crew_users WHERE disabled_at IS NULL').first())?.n) > 0; }
  catch (caught) { if (!isMissingTable(caught)) console.error('crew_users count failed:', caught?.message ?? String(caught)); return false; }
}
// The shared crew password keeps working until every crew member has an account — explicitly with
// LEGACY_SHARED_LOGIN=true, otherwise automatically while crew_users is empty or unmigrated. Any D1
// failure counts as "no accounts": an outage must not lock the crew out of their own studio.
async function sharedLoginAvailable(env) {
  return env.LEGACY_SHARED_LOGIN === 'true' || !(await crewAccountsExist(env));
}
const safeJson = (value) => { try { return value ? JSON.parse(value) : null; } catch { return null; } };
const crewUserView = (row) => ({ id: row.id, name: row.name, role: row.role, totpEnabled: Boolean(row.totp_enabled), createdAt: row.created_at, lastLoginAt: row.last_login_at || null, disabledAt: row.disabled_at || null });
// Who did what, to which record, from where (migration 0016). Best effort in every sense: a missing
// table, a D1 error or a malformed detail can never fail the action being recorded.
async function audit(env, request, actor, action, targetType = null, targetId = null, detail = null) {
  // Before migration 0016 there is nowhere to write: skip in silence (one cached PRAGMA per isolate)
  // rather than warn on every crew action of an otherwise perfectly working deploy.
  if (!env?.DB || !await hasColumn(env, 'audit_log', 'action')) return;
  try {
    let json = null;
    try { json = detail ? JSON.stringify(detail).slice(0, 2000) : null; } catch { json = null; }
    // created_at is written here, not left to CURRENT_TIMESTAMP: SQLite's is second-resolution, and
    // the /api/admin/audit cursor pages on this value, so two entries in one second must still sort.
    await env.DB.prepare('INSERT INTO audit_log (id, actor_user_id, actor_name, action, target_type, target_id, detail_json, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id(), actor?.uid || null, String(actor?.name || SHARED_ACTOR).slice(0, 80), action, targetType, targetId, json, clientIp(request), new Date().toISOString()).run();
  } catch (caught) { console.error('audit log write failed:', action, caught?.message ?? String(caught)); }
}
// Money and destroying published work are admin-only; a photographer gets a 403 that says who can.
function adminOnly(admin, request, env, what) {
  return admin?.role === 'admin' ? null : error(`Only a crew admin can ${what}. Ask an admin to do it for you.`, request, env, 403);
}
const CREW_MIGRATION_ERROR = 'Crew accounts need database migration 0016.';
// One signed-in crew session: the admin_sessions row (migration 0011) plus, once migration 0016 is
// applied, which account and role it belongs to. The insert stays best effort — an unmigrated
// database still gets a working (if unrevocable) token, exactly as it did before accounts existed.
async function startCrewSession(env, request, { uid = null, role = 'admin' } = {}) {
  const sid = id(); const exp = Date.now() + ADMIN_TOKEN_HOURS * 60 * 60_000;
  if (env.DB) {
    const named = await hasColumn(env, 'admin_sessions', 'user_id');
    try {
      await env.DB.prepare(`INSERT INTO admin_sessions (id, expires_at, ip, user_agent${named ? ', user_id, role' : ''}) VALUES (?, ?, ?, ?${named ? ', ?, ?' : ''})`)
        .bind(sid, new Date(exp).toISOString(), clientIp(request), (request.headers.get('user-agent') || '').slice(0, 200), ...(named ? [uid, role] : [])).run();
    } catch (caught) { console.warn('admin_sessions unavailable (is migration 0011 applied?) — this token cannot be revoked server-side:', caught?.message ?? String(caught)); }
  }
  return { sid, exp };
}
// Sign-out and account changes both need every live token of one account gone.
async function revokeSessionsOf(env, userId) {
  try { await env.DB.prepare('UPDATE admin_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(new Date().toISOString(), userId).run(); }
  catch (caught) { console.warn('could not revoke the crew sessions of', userId, caught?.message ?? String(caught)); }
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
// Cashfree signs `${x-webhook-timestamp}${rawBody}`; the timestamp arrives as epoch seconds or
// milliseconds depending on the webhook version. Anything non-numeric, or further than
// WEBHOOK_TOLERANCE_MS from the Worker's clock in either direction, is refused so a captured
// delivery cannot be replayed later.
const WEBHOOK_TOLERANCE_MS = 5 * 60_000, WEBHOOK_MAX_BYTES = 64 * 1024;
function webhookTimestampFresh(value, now = Date.now()) {
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) return false;
  const number = Number(value);
  const ms = number < 1e11 ? number * 1000 : number; // epoch seconds stay below 1e11 until the year 5138
  return Math.abs(now - ms) <= WEBHOOK_TOLERANCE_MS;
}
async function cashfreeOrderStatus(orderId, env) {
  const result = await fetch(`${cashfreeBase(env)}/orders/${encodeURIComponent(orderId)}`, { headers: cashfreeHeaders(env) });
  if (!result.ok) return null;
  return result.json();
}
// ── Cashfree refunds and settlements (crew money tools) ──────────────────────
// Create Refund (POST /pg/orders/{order_id}/refunds): refund_id is our own idempotent id (Cashfree
// returns the existing refund for a repeated id, never a second one), the amount is rupees, and the
// speed stays STANDARD (INSTANT carries a fee and falls back silently on many instruments). A network
// failure answers ok:false rather than throwing; the REFUND_STATUS_WEBHOOK corrects the ledger if
// Cashfree had in fact accepted it. Control flow keys off HTTP status and refund_status enums only.
const REFUND_STATUSES = new Set(['PENDING', 'SUCCESS', 'CANCELLED', 'ONHOLD', 'FAILED']);
async function cashfreeRefund(orderId, { refundId, amountPaise, note }, env) {
  try {
    const result = await fetch(`${cashfreeBase(env)}/orders/${encodeURIComponent(orderId)}/refunds`, {
      method: 'POST', headers: cashfreeHeaders(env),
      body: JSON.stringify({ refund_id: refundId, refund_amount: Number((amountPaise / 100).toFixed(2)), refund_note: note, refund_speed: 'STANDARD' }),
    });
    let body = null; try { body = await result.json(); } catch { body = null; }
    return { ok: result.ok, status: result.status, body };
  } catch (caught) { return { ok: false, status: 0, body: null, error: caught?.message ?? String(caught) }; }
}
const refundView = row => ({ id: row.id, paymentId: row.payment_id, cashfreeRefundId: row.cashfree_refund_id ?? null, amountPaise: Number(row.amount_paise) || 0, status: row.status, reason: row.reason ?? null, createdAt: row.created_at, updatedAt: row.updated_at });
// Cashfree's list endpoints take a { pagination, filters } body and page with a cursor (settlements
// skill: "List all settlements" is a POST). Follows the cursor a bounded number of pages and accepts
// either a bare array or { data, cursor } so a shape change never crashes the report.
const CASHFREE_PAGES = 10;
async function cashfreePages(path, filters, limit, env) {
  const rows = []; let cursor = null;
  for (let page = 0; page < CASHFREE_PAGES; page += 1) {
    const result = await fetch(`${cashfreeBase(env)}${path}`, { method: 'POST', headers: cashfreeHeaders(env), body: JSON.stringify({ pagination: { limit, cursor }, filters }) });
    if (!result.ok) throw new RequestError('Cashfree could not list settlements right now. Try again shortly.', 502);
    const body = await result.json();
    rows.push(...(Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []));
    cursor = Array.isArray(body) ? null : body?.cursor || null;
    if (!cursor) break;
  }
  return rows;
}
// GET /api/admin/settlements: the settlements Cashfree paid out in an IST date range, mapped to the
// studio's shape, plus which of our confirmed payments from that range no PAYMENT recon event names
// yet (the recon window runs a week past `to`, since T+1/T+2 settlements land after the payment day).
const SETTLE_RECON_GRACE_DAYS = 7;
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const shiftDate = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const toPaise = rupees => Number.isFinite(Number(rupees)) ? Math.round(Number(rupees) * 100) : null;
async function settlementsReport(env, from, to) {
  const window = (start, end) => ({ start_date: `${start}T00:00:00+05:30`, end_date: `${end}T23:59:59+05:30` });
  const settlements = (await cashfreePages('/settlements', window(from, to), 100, env)).map(s => ({
    id: s?.cf_settlement_id != null ? String(s.cf_settlement_id) : null, utr: s?.utr || null,
    amountPaise: toPaise(s?.amount_settled), grossPaise: toPaise(s?.amount), settledAt: s?.settlement_time || s?.settled_on || null,
    from: s?.payment_from || s?.payment_time || null, to: s?.payment_till || s?.settlement_time || null, status: s?.status || null, type: s?.type || s?.settlement_type || null,
  }));
  let reconUnavailable = false; const settledOrders = new Set();
  try {
    for (const row of await cashfreePages('/settlement/recon', window(from, shiftDate(to, SETTLE_RECON_GRACE_DAYS)), 1000, env)) {
      const orderId = row?.order_details?.order_id;
      if (orderId && (row?.event_details?.event_type ?? 'PAYMENT') === 'PAYMENT') settledOrders.add(String(orderId));
    }
  } catch (caught) { reconUnavailable = true; console.warn('settlement recon unavailable:', caught?.message ?? String(caught)); }
  // paid_at is UTC (D1's CURRENT_TIMESTAMP); the range is IST days, hence the 330-minute shift.
  const paid = (await env.DB.prepare("SELECT id, cashfree_order_id FROM payments WHERE status IN ('verified', 'captured') AND paid_at >= datetime(?, '-330 minutes') AND paid_at < datetime(?, '+1 day', '-330 minutes') ORDER BY paid_at").bind(`${from} 00:00:00`, `${to} 00:00:00`).all()).results;
  return { from, to, settlements, unreconciled: reconUnavailable ? [] : paid.filter(payment => !settledOrders.has(payment.cashfree_order_id)).map(payment => payment.id), reconUnavailable };
}

// Shared secret with the face service: sent as x-face-key whenever FACE_API_KEY is set. Unset means no
// header at all, so the current (open) Space keeps working while the secret is rolled out.
const faceHeaders = env => env.FACE_API_KEY ? { 'x-face-key': env.FACE_API_KEY } : {};
async function extractFaces(file, env) {
  if (!env.FACE_API_URL) throw new RequestError('Face matching is temporarily unavailable.', 503);
  const form = new FormData(); form.append('file', file, 'image.jpg');
  let result;
  try { result = await fetch(env.FACE_API_URL, { method: 'POST', body: form, headers: faceHeaders(env), signal: AbortSignal.timeout(75000) }); }
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
async function enqueuePhotos(photos, env, { force = false } = {}) {
  if (!env.INDEX_QUEUE) throw new RequestError('Photo processing is not configured. Please contact the crew.', 503);
  let queued = 0, alreadyQueued = 0, failed = 0;
  for (const photo of photos) {
    const jobId = id();
    // `force` overrides a job that's still queued/processing — a stale consumer will notice its job_id
    // no longer matches the row and ack without writing, so the new job always wins the re-run.
    const claim = await env.DB.prepare(`INSERT INTO indexing_jobs (photo_id, job_id, status) VALUES (?, ?, 'queued')
      ON CONFLICT(photo_id) DO UPDATE SET job_id = excluded.job_id, status = 'queued', attempts = 0, error = NULL, updated_at = CURRENT_TIMESTAMP
      ${force ? '' : "WHERE indexing_jobs.status NOT IN ('queued', 'processing')"}`).bind(photo.id, jobId).run();
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
  // Burst pairs (same subject, seconds apart) are trusted without a human look — they still pass
  // the face-mismatch and gap checks above, they just skip the review queue. Appearance ("same
  // kit") links are a weaker signal and still land 'pending' for crew confirmation.
  const statements = candidates.slice(0, 20).map(pair => env.DB.prepare(`INSERT OR IGNORE INTO photo_links
    (id, session_id, photo1_id, photo2_id, link_type, score, status) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id(), pair.sessionId, pair.first, pair.second, pair.linkType, pair.score, pair.linkType === 'burst' ? 'confirmed' : 'pending'));
  if (!statements.length) return 0;
  const linkResults = await env.DB.batch(statements);
  return linkResults.reduce((sum, result) => sum + Number(result.meta?.changes || 0), 0);
}

// ── Crew support tools (migration 0015) ──────────────────────────────────────
// A fresh 30-day gallery link for a paid search: the same token /access mints, as a URL the guest
// page can open: `?gallery=<searchId>.<token>`, the same dotted form the guest page itself builds for
// its share link (app.js resumeGalleryFromLink splits on the first dot; search ids are UUIDs, so the
// token's own dot is never the first). The expiry is kept on the search for support.
const GALLERY_DAYS = 30;
async function galleryLink(env, searchId, request, url) {
  const exp = Date.now() + GALLERY_DAYS * 24 * 60 * 60_000; const expiresAt = new Date(exp).toISOString();
  const token = await sign({ scope: 'search', searchId, exp }, env);
  await rememberGalleryExpiry(env, searchId, expiresAt);
  return { link: `${siteOrigin(request, env, url)}/?gallery=${encodeURIComponent(searchId)}.${encodeURIComponent(token)}`, expiresAt };
}
async function rememberGalleryExpiry(env, searchId, expiresAt) {
  if (!await hasColumn(env, 'searches', 'gallery_link_expires_at')) return;
  try { await env.DB.prepare('UPDATE searches SET gallery_link_expires_at = ? WHERE id = ?').bind(expiresAt, searchId).run(); } catch { /* best effort */ }
}
// Queue observability per session for the dashboard: indexing_jobs counted by status, failures
// grouped by reason, and an ETA = remaining jobs × the median gap between that session's last 20
// completions (a job row only carries its last change time, so throughput stands in for duration).
// Best effort: a failure leaves zeros with etaSeconds null rather than breaking the dashboard.
const ETA_SAMPLE = 20;
const emptyIndexing = () => ({ queued: 0, processing: 0, done: 0, failed: 0, etaSeconds: null, failures: [] });
async function indexingSummary(env, sessionIds) {
  const summary = new Map(sessionIds.map(sessionId => [sessionId, emptyIndexing()]));
  if (!sessionIds.length) return summary;
  try {
    const marks = ids => ids.map(() => '?').join(',');
    const counts = await env.DB.prepare(`SELECT p.session_id, j.status, j.error, COUNT(*) AS n FROM indexing_jobs j JOIN photos p ON p.id = j.photo_id WHERE p.session_id IN (${marks(sessionIds)}) GROUP BY p.session_id, j.status, j.error`).bind(...sessionIds).all();
    for (const row of counts.results || []) {
      const entry = summary.get(row.session_id); const n = Number(row.n) || 0;
      if (!entry) continue;
      if (row.status === 'queued') entry.queued += n;
      else if (row.status === 'processing') entry.processing += n;
      else if (row.status === 'completed') entry.done += n;
      else if (row.status === 'failed') { entry.failed += n; const reason = row.error || 'Processing failed.'; const known = entry.failures.find(item => item.reason === reason); if (known) known.count += n; else entry.failures.push({ reason, count: n }); }
    }
    const active = sessionIds.filter(sessionId => summary.get(sessionId).queued + summary.get(sessionId).processing > 0);
    if (active.length) {
      const stamps = await env.DB.prepare(`SELECT session_id, updated_at FROM (SELECT p.session_id, j.updated_at, ROW_NUMBER() OVER (PARTITION BY p.session_id ORDER BY j.updated_at DESC) AS rn FROM indexing_jobs j JOIN photos p ON p.id = j.photo_id WHERE j.status = 'completed' AND p.session_id IN (${marks(active)})) WHERE rn <= ${ETA_SAMPLE}`).bind(...active).all();
      const times = new Map();
      for (const row of stamps.results || []) { const at = Date.parse(`${row.updated_at}Z`) || Date.parse(row.updated_at); if (Number.isFinite(at)) { if (!times.has(row.session_id)) times.set(row.session_id, []); times.get(row.session_id).push(at); } }
      for (const sessionId of active) {
        const sorted = (times.get(sessionId) || []).sort((a, b) => a - b);
        if (sorted.length < 2) continue;
        const gaps = sorted.slice(1).map((at, index) => (at - sorted[index]) / 1000).sort((a, b) => a - b);
        const median = Math.max(1, gaps[Math.floor(gaps.length / 2)]);   // second resolution: never a zero-second ETA
        const entry = summary.get(sessionId); entry.etaSeconds = Math.round((entry.queued + entry.processing) * median);
      }
    }
    for (const entry of summary.values()) entry.failures.sort((a, b) => b.count - a.count);
  } catch (caught) { console.warn('indexing summary unavailable:', caught?.message ?? String(caught)); }
  return summary;
}
// GET /api/admin/lookup: a guest's searches by phone (checkout or notify-me), by Cashfree order id or
// by search id — what they matched, hid, found by colour, paid, were granted, and asked to be told
// about. Phones come back masked (98xxxxxx21); never a selfie or an embedding. Free unlocks appear
// among `payments` as status 'granted' rows so the studio can show one timeline.
const LOOKUP_LIMIT = 50, LOOKUP_TOKEN_MINUTES = 15;
const maskPhone = phone => typeof phone === 'string' && phone.length >= 4 ? `${phone.slice(0, 2)}${'x'.repeat(phone.length - 4)}${phone.slice(-2)}` : null;
async function supportLookup(env, { phone, order, search }, base) {
  let unmigrated = false;
  const optional = async (sql, values) => { try { return (await env.DB.prepare(sql).bind(...values).all()).results; } catch (caught) { if (!isMissingTable(caught)) throw caught; unmigrated = true; return []; } };
  const marks = ids => ids.map(() => '?').join(',');
  let searchIds = [];
  if (search) searchIds = [search];
  else if (order) searchIds = (await env.DB.prepare('SELECT search_id FROM payments WHERE cashfree_order_id = ?').bind(order).all()).results.map(row => row.search_id);
  else {
    if (await hasColumn(env, 'payments', 'customer_phone')) searchIds.push(...(await env.DB.prepare('SELECT search_id FROM payments WHERE customer_phone = ?').bind(phone).all()).results.map(row => row.search_id));
    searchIds.push(...(await optional('SELECT search_id FROM notify_requests WHERE phone = ?', [phone])).map(row => row.search_id));
  }
  searchIds = [...new Set(searchIds)].slice(0, LOOKUP_LIMIT);
  if (!searchIds.length) return { searches: [], payments: [], notify: [], ...(unmigrated ? { unmigrated: true } : {}) };
  const searches = (await env.DB.prepare(`SELECT sr.*, s.title AS session_title FROM searches sr JOIN sessions s ON s.id = sr.session_id WHERE sr.id IN (${marks(searchIds)}) ORDER BY sr.created_at DESC`).bind(...searchIds).all()).results;
  const payments = (await env.DB.prepare(`SELECT * FROM payments WHERE search_id IN (${marks(searchIds)}) ORDER BY created_at DESC`).bind(...searchIds).all()).results;
  const hides = await optional(`SELECT search_id, photo_id FROM match_hides WHERE search_id IN (${marks(searchIds)}) ORDER BY created_at`, searchIds);
  const notify = await optional(`SELECT search_id, created_at, notified_at FROM notify_requests WHERE search_id IN (${marks(searchIds)})`, searchIds);
  const grants = await optional(`SELECT * FROM grants WHERE search_id IN (${marks(searchIds)}) ORDER BY created_at DESC`, searchIds);
  const refunds = payments.length ? await optional(`SELECT * FROM refunds WHERE payment_id IN (${marks(payments.map(payment => payment.id))}) ORDER BY created_at DESC`, payments.map(payment => payment.id)) : [];
  // What the guest saw: signed thumbs (or previews) for every id, short-lived since they are for a crew screen.
  const hiddenBySearch = new Map(); for (const row of hides) { if (!hiddenBySearch.has(row.search_id)) hiddenBySearch.set(row.search_id, []); hiddenBySearch.get(row.search_id).push(row.photo_id); }
  const lists = searches.map(row => ({ id: row.id, matched: parseIds(row.matched_photo_ids_json), colour: parseIds(row.colour_photo_ids_json), hidden: hiddenBySearch.get(row.id) || [] }));
  const photoIds = [...new Set(lists.flatMap(list => [...list.matched, ...list.colour, ...list.hidden]))];
  const photos = new Map(photoIds.length ? (await env.DB.prepare(`SELECT id${await thumbColumn(env)} FROM photos WHERE id IN (${marks(photoIds)})`).bind(...photoIds).all()).results.map(row => [row.id, row]) : []);
  const thumb = async photoId => { const photo = photos.get(photoId); if (!photo) return { photoId, thumbUrl: null }; const variant = photo.thumb_key ? 'thumb' : 'preview'; return { photoId, thumbUrl: `${base}/api/media/${photoId}?variant=${variant}&token=${encodeURIComponent(await mediaToken(photoId, variant, env, LOOKUP_TOKEN_MINUTES))}` }; };
  const searchViews = await Promise.all(searches.map(async (row, index) => {
    const list = lists[index];
    const photos = { matched: await Promise.all(list.matched.map(thumb)), colour: await Promise.all(list.colour.map(thumb)), hidden: await Promise.all(list.hidden.map(thumb)) };
    // `saw` is the same set as one flat strip for the studio: matched, then colour picks, then what the
    // guest hid (flagged), each photo once; `photos` keeps the per-list shape for anything that wants it.
    const saw = []; const seen = new Set();
    for (const [kind, items] of Object.entries(photos)) for (const item of items) { if (seen.has(item.photoId)) continue; seen.add(item.photoId); saw.push({ ...item, hidden: kind === 'hidden' }); }
    return {
      id: row.id, sessionId: row.session_id, sessionTitle: row.session_title, createdAt: row.created_at, status: row.status,
      matchedCount: list.matched.length, hiddenCount: list.hidden.length, colourCount: list.colour.length,
      paidAt: row.paid_at ?? null, expiresAt: row.expires_at, galleryLinkExpiresAt: row.gallery_link_expires_at ?? null,
      photos, saw,
    };
  }));
  const paymentViews = payments.map(row => {
    const own = refunds.filter(refund => refund.payment_id === row.id);
    return {
      id: row.id, searchId: row.search_id, orderId: row.cashfree_order_id, cfPaymentId: row.cashfree_payment_id ?? null, amountPaise: Number(row.amount_paise) || 0, status: row.status,
      createdAt: row.created_at, paidAt: row.paid_at ?? null, phone: maskPhone(row.customer_phone),
      refundedPaise: own.filter(refund => !['CANCELLED', 'FAILED'].includes(refund.status)).reduce((sum, refund) => sum + (Number(refund.amount_paise) || 0), 0),
      refundStatus: own[0]?.status ?? null, refunds: own.map(refundView),
    };
  });
  const grantViews = grants.map(row => ({ id: row.id, searchId: row.search_id, orderId: null, cfPaymentId: null, amountPaise: 0, status: 'granted', createdAt: row.created_at, paidAt: row.created_at, phone: null, refundedPaise: 0, refundStatus: null, refunds: [], reason: row.reason ?? null }));
  return { searches: searchViews, payments: [...paymentViews, ...grantViews], notify: notify.map(row => ({ searchId: row.search_id, createdAt: row.created_at, notifiedAt: row.notified_at ?? null })), ...(unmigrated ? { unmigrated: true } : {}) };
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
  const [db, r2, face, migrations] = await Promise.all([
    probe('db', async () => { if (!env.DB) throw new Error('DB binding missing'); await env.DB.prepare('SELECT 1').first(); }),
    // A missing object is a healthy answer from R2; only a thrown error means the bucket is unreachable.
    probe('r2', async () => { if (!env.PHOTOS) throw new Error('PHOTOS binding missing'); await env.PHOTOS.head('__health-probe'); }),
    // The face service is only pinged on demand (?deep=1) so a routine poll never waits on a cold
    // Hugging Face Space. Any HTTP reply — even 405 for HEAD — proves it is reachable.
    deep ? probe('face', async () => { if (!env.FACE_API_URL) throw new Error('FACE_API_URL missing'); await fetch(env.FACE_API_URL, { method: 'HEAD', headers: faceHeaders(env), signal: AbortSignal.timeout(HEALTH_FACE_TIMEOUT_MS) }); }) : 'skipped',
    migrationStatus(env),
  ]);
  const checks = { db, r2, face };
  // Unmigrated tables degrade features (no quota, signature-only crew tokens) but never fail the probe.
  return { ok: Object.values(checks).every(status => status !== 'error'), checks, migrations };
}
// Which of the runtime-detected tables exist, so a migration deploy can be confirmed from the health
// pill. Table names only — nothing about their contents leaves the Worker.
async function migrationStatus(env) {
  const missing = { adminSessions: false, rateLimits: false, photoDimensions: false, events: false, sessionConditions: false, support: false, crewAccounts: false };
  if (!env.DB) return missing;
  try {
    // Fresh reads on purpose (not the per-isolate hasColumn cache), so the pill reflects a migration the moment it lands.
    const [tables, photoColumns, sessionColumns, searchColumns] = await Promise.all([
      env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('admin_sessions', 'rate_limits', 'events', 'match_hides', 'notify_requests', 'refunds', 'grants', 'crew_users', 'audit_log')").all(),
      env.DB.prepare('PRAGMA table_info(photos)').all(),
      env.DB.prepare('PRAGMA table_info(sessions)').all(),
      env.DB.prepare('PRAGMA table_info(searches)').all(),
    ]);
    const names = new Set((tables.results || []).map(row => row.name));
    const has = (columns, name) => (columns.results || []).some(row => row.name === name);
    return {
      adminSessions: names.has('admin_sessions'), rateLimits: names.has('rate_limits'), photoDimensions: has(photoColumns, 'width'), events: names.has('events'),
      sessionConditions: has(sessionColumns, 'break_name'),
      support: ['match_hides', 'notify_requests', 'refunds', 'grants'].every(name => names.has(name)) && has(searchColumns, 'colour_photo_ids_json'),
      crewAccounts: names.has('crew_users') && names.has('audit_log'),   // migration 0016 (W4-C)
    };
  } catch { return missing; }
}

// ── Ops cron: queue-stall detection and crew alerts (the `scheduled` handler's helpers) ─────────
// Every cron tick (wrangler.jsonc `*/10 * * * *`) the deep health probe above runs and the indexing
// queue is checked for a stall: photos still `queued`/`processing` while no indexing_jobs row has
// moved for QUEUE_STALL_MINUTES (default 15) — a sleeping Space, a dead consumer and a poisoned
// batch all look like this. Alerts go out once per incident: the tick that confirms a problem opens
// it, nothing repeats while it lasts, and the first clean tick closes it with a "recovered" note.
// A stall is alerted the first time it is seen (it is already 15 minutes old by definition); a
// failed health probe needs two consecutive ticks, so one slow HEAD from the Space never pages
// anyone. Sinks: a generic JSON webhook (ALERT_WEBHOOK_URL — Slack, Google Chat, Mattermost and
// Rocket.Chat incoming webhooks take `{ text }`; ALERT_WEBHOOK_FORMAT=discord sends `{ content }`,
// =json the full structured payload for a custom relay) and/or email through Resend
// (RESEND_API_KEY + ALERT_EMAIL_TO, optional ALERT_EMAIL_FROM). Incident state lives in the photo
// bucket under ops/alert-state.json — no migration, the binding already exists, and photo keys all
// start with sessions/ — with a copy in the isolate so a bucket outage does not repeat the alert
// every ten minutes (a cron tick landing in a *fresh* isolate during an R2 outage can repeat it
// once: the copy is per isolate, and R2 being down is itself one of the alertable conditions).
// With no sink configured the tick logs what it would have sent and stores nothing, so the
// first tick after the secrets land alerts on an incident that is already under way. Nothing here
// can fail the tick: every step degrades to a log line.
const QUEUE_STALL_MINUTES = 15, ALERT_STATE_KEY = 'ops/alert-state.json', ALERT_TIMEOUT_MS = 5000, ALERT_SITE = 'Surfers of India photos';
const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
const HEALTH_CONDITION_TEXT = { db: 'D1 database: SELECT 1 failed', r2: 'R2 photo bucket: head() failed', face: `face service: no answer to the deep probe within ${HEALTH_FACE_TIMEOUT_MS / 1000} s` };
let alertStateCache = null;   // last state this isolate saw or wrote; read only when the bucket cannot answer
function stallMinutes(env) { const value = Number(env.QUEUE_STALL_MINUTES); return Number.isFinite(value) && value > 0 ? value : QUEUE_STALL_MINUTES; }
// One query: how many photos are still waiting, and whether any job row moved inside the window.
// indexing_jobs.updated_at is written with CURRENT_TIMESTAMP everywhere, so the text comparison
// against datetime('now', …) is exact. Unmigrated or unreadable → null (unknown), never an alert on
// its own — the db probe reports a broken database.
async function queueStall(env, minutes) {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM indexing_jobs WHERE status IN ('queued', 'processing')) AS pending,
      (SELECT COUNT(*) FROM indexing_jobs WHERE updated_at >= datetime('now', ?)) AS recent,
      (SELECT MAX(updated_at) FROM indexing_jobs) AS last_progress`).bind(`-${minutes} minutes`).first();
    const pending = Number(row?.pending ?? 0), recent = Number(row?.recent ?? 0);
    return { pending, stalled: pending > 0 && recent === 0, lastProgress: row?.last_progress ?? null };
  } catch (caught) { console.warn('queue stall check unavailable:', caught?.message ?? String(caught)); return null; }
}
function alertConditions(health, stall, minutes) {
  const conditions = Object.entries(health.checks).filter(([, status]) => status === 'error').map(([name]) => ({ key: `health:${name}`, text: HEALTH_CONDITION_TEXT[name] ?? `${name}: failed` }));
  if (stall?.stalled) conditions.push({ key: 'queue:stall', text: `indexing queue: ${stall.pending} photo${stall.pending === 1 ? '' : 's'} waiting and no job has moved for ${minutes}+ minutes (last progress ${stall.lastProgress ? `${stall.lastProgress} UTC` : 'unknown'})` });
  return conditions;
}
function alertSinks(env) {
  const sinks = [];
  if (env.ALERT_WEBHOOK_URL) sinks.push('webhook');
  if (env.RESEND_API_KEY && (env.ALERT_EMAIL_TO || '').split(',').some(value => value.trim())) sinks.push('email');
  return sinks;
}
async function readAlertState(env) {
  const empty = { open: null, seen: {} };
  try {
    const object = await env.PHOTOS?.get?.(ALERT_STATE_KEY);
    // A successful read is authoritative and refreshes the isolate's copy (including "nothing
    // stored yet"), so the fallback below can never resurrect an incident the bucket has closed.
    const state = object ? JSON.parse(await object.text()) : null;
    alertStateCache = { open: state?.open ?? null, seen: state?.seen && typeof state.seen === 'object' ? state.seen : {} };
    return alertStateCache;
  } catch (caught) { console.warn('alert state unreadable, using this isolate\'s copy:', caught?.message ?? String(caught)); return alertStateCache ?? empty; }
}
async function writeAlertState(env, state) {
  alertStateCache = state;
  try { await env.PHOTOS.put(ALERT_STATE_KEY, JSON.stringify(state), { httpMetadata: { contentType: 'application/json' } }); }
  catch (caught) { console.warn('alert state not saved (kept in this isolate only):', caught?.message ?? String(caught)); }
}
// Both sinks are tried; the alert counts as delivered when at least one accepted it, and an
// undelivered alert leaves the incident unopened so the next tick tries again. Bodies carry the
// condition list and the next step, never secrets, tokens, guest data or the Worker's configuration.
async function deliverAlert(env, message) {
  const attempts = [];
  if (env.ALERT_WEBHOOK_URL) {
    const format = String(env.ALERT_WEBHOOK_FORMAT || 'text').toLowerCase();
    const body = format === 'discord' ? { content: message.text } : format === 'json' ? { site: ALERT_SITE, ...message } : { text: message.text };
    attempts.push(['webhook', fetch(env.ALERT_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ALERT_TIMEOUT_MS) })]);
  }
  const to = (env.ALERT_EMAIL_TO || '').split(',').map(value => value.trim()).filter(Boolean);
  if (env.RESEND_API_KEY && to.length) {
    // Resend's shared onboarding sender only reaches the account owner's own address; a verified domain (ALERT_EMAIL_FROM) reaches the whole crew.
    const from = env.ALERT_EMAIL_FROM || `${ALERT_SITE} <onboarding@resend.dev>`;
    attempts.push(['email', fetch(RESEND_EMAILS_URL, { method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ from, to, subject: message.subject, text: message.text }), signal: AbortSignal.timeout(ALERT_TIMEOUT_MS) })]);
  }
  const results = await Promise.allSettled(attempts.map(([, pending]) => pending));
  let delivered = 0;
  results.forEach((result, index) => {
    if (result.status === 'fulfilled' && result.value.ok) { delivered += 1; return; }
    console.error('alert delivery failed:', attempts[index][0], result.status === 'fulfilled' ? `HTTP ${result.value.status}` : (result.reason?.message ?? String(result.reason)));
  });
  return delivered > 0;
}
function alertMessage(status, conditions, state, now) {
  const list = conditions.map(condition => `• ${condition.text}`).join('\n');
  if (status === 'alert') return { status, subject: `[${ALERT_SITE}] ALERT: ${conditions.map(condition => condition.key).join(', ')}`, text: `${ALERT_SITE} — ALERT at ${now}\n${list}\nNext: docs/runbook.md → "Alerts" (re-queue stalled photos from the studio's Re-index, retry failed ones; check GET /api/health?deep=1 on the Worker).`, conditions: conditions.map(condition => condition.key), time: now };
  const since = state.open?.since ?? 'unknown';
  return { status, subject: `[${ALERT_SITE}] RECOVERED: ${(state.open?.keys ?? []).join(', ')}`, text: `${ALERT_SITE} — RECOVERED at ${now}\nEvery check is clean again; the incident opened at ${since} (${(state.open?.keys ?? []).join(', ')}) is closed.`, conditions: state.open?.keys ?? [], time: now };
}
// Returns what the tick's log line reports: the queue numbers and what happened with alerting
// (`none` clean, `pending` a first sighting waiting for confirmation, `open` an incident already
// alerted, `sent`/`recovered` a delivery, `unsent` every sink refused, `unconfigured` no sink).
async function opsAlerts(env, health) {
  const minutes = stallMinutes(env);
  const stall = await queueStall(env, minutes);
  const queue = stall ? { pending: stall.pending, stalled: stall.stalled, lastProgress: stall.lastProgress } : null;
  const conditions = alertConditions(health, stall, minutes);
  const now = new Date().toISOString();
  const state = await readAlertState(env);
  const confirmed = conditions.filter(condition => condition.key === 'queue:stall' || state.seen[condition.key]);
  const message = !state.open && confirmed.length ? alertMessage('alert', confirmed, state, now) : state.open && !conditions.length ? alertMessage('recovered', [], state, now) : null;
  if (!alertSinks(env).length) {
    if (message) console.warn('scheduled alert not sent: set ALERT_WEBHOOK_URL and/or RESEND_API_KEY + ALERT_EMAIL_TO', JSON.stringify(message));
    return { queue, alert: 'unconfigured', conditions: conditions.map(condition => condition.key) };
  }
  const seen = Object.fromEntries(conditions.map(condition => [condition.key, state.seen[condition.key] ?? now]));
  const next = { open: state.open, seen };
  let alert = state.open ? 'open' : conditions.length ? 'pending' : 'none';
  if (message) {
    const delivered = await deliverAlert(env, message);
    if (delivered) { next.open = message.status === 'alert' ? { keys: message.conditions, since: now, alertedAt: now } : null; alert = message.status === 'alert' ? 'sent' : 'recovered'; }
    else alert = 'unsent';
  } else if (state.open && confirmed.length) {
    // A new problem during an open incident joins it (no second alert; the recovery note lists all of them).
    const keys = [...new Set([...(state.open.keys ?? []), ...confirmed.map(condition => condition.key)])];
    if (keys.length !== (state.open.keys ?? []).length) next.open = { ...state.open, keys };
  }
  if (JSON.stringify(next) !== JSON.stringify(state)) await writeAlertState(env, next);
  return { queue, alert, conditions: conditions.map(condition => condition.key) };
}

// Named exports solely for direct unit testing of pure logic (burst grouping, image header parsing,
// the match ranking's cosine similarity that scripts/accuracy.mjs replicates, the quota key, and the
// crew-account crypto checked against the RFC vectors); the runtime only uses the default export.
export { burstGroups, imageDimensions, similarity, quotaKeyFor, hashPassword, makePassword, passwordMatches, base32Encode, base32Decode, totpAt, totpMatches };

export default {
  async queue(batch, env) { for (const message of batch.messages) await consumePhoto(message, env); },
  // Cron trigger (every 10 minutes): the deep health check's HEAD ping keeps the Hugging Face Space
  // from going to sleep, the indexing queue is checked for a stall and the crew is alerted once per
  // incident (see the ops helpers above); one JSON line per tick lands in the Worker logs for an
  // uptime view. The probes run in parallel and the face probe times out at 3 s, alert deliveries at
  // 5 s. Finished quota windows are swept on the same tick so the rate_limits table never grows
  // between guest searches.
  async scheduled(event, env, ctx) {
    const health = await healthCheck(env, true);
    const ops = await opsAlerts(env, health).catch(caught => { console.error('ops alert check failed:', caught?.message ?? String(caught)); return null; });
    console.log('scheduled health check', JSON.stringify({ cron: event?.cron ?? null, ok: health.ok, checks: health.checks, migrations: health.migrations, queue: ops?.queue ?? null, alert: ops?.alert ?? 'error', time: new Date().toISOString() }));
    if (env.DB) sweepRateLimits(env, ctx);
  },
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') return new Response(null, { headers: cors(request, env) });
      if (!url.pathname.startsWith('/api/')) return error('Not found', request, env, 404);

      if (request.method === 'GET' && url.pathname === '/api/health') {
        const health = await healthCheck(env, url.searchParams.get('deep') === '1');
        return response({ ...health, time: new Date().toISOString() }, request, env, health.ok ? 200 : 503);
      }

      // POST /api/admin/login { name?, password, code? } — a crew account (migration 0016) when a
      // name is given and matches one, otherwise the shared password while that is still allowed.
      // Both answer { token, … }; the token carries the account id and role for every later request.
      if (request.method === 'POST' && url.pathname === '/api/admin/login') {
        const { name, password, code } = await readJson(request);
        const crewName = typeof name === 'string' ? name.trim().slice(0, 40) : '';
        const throttle = env.DB ? await loginThrottle(request, env, crewName) : null;
        if (throttle?.blocked) return json({ error: `Too many sign-in attempts. Try again in ${LOGIN_WINDOW_MINUTES} minutes.` }, 429, { ...cors(request, env), 'retry-after': String(LOGIN_WINDOW_MINUTES * 60) });
        const refuse = async (message, reason, extra = {}) => {
          await throttle?.failed();
          // The name is stored as typed but truncated, so a password mistyped into the name box cannot land in the log.
          await audit(env, request, { uid: null, name: crewName ? `${crewName.slice(0, 24)} (unverified)` : SHARED_ACTOR }, 'login.failure', null, null, { reason });
          return json({ error: message, ...extra }, 401, cors(request, env));
        };
        const account = crewName ? await crewUserByName(env, crewName) : null;
        if (crewName && !account) await burnPasswordTime(password);          // an unknown name must not answer faster than a wrong password
        if (account?.disabled_at) return refuse('Incorrect name or password.', 'disabled');
        if (account) {
          if (!await passwordMatches(password, account)) return refuse('Incorrect name or password.', 'password');
          if (account.totp_enabled) {
            // A right password with no code is not a failed attempt — the crew member simply has one more field to fill.
            if (code === undefined || code === null || code === '') return json({ error: 'Enter the 6-digit code from your authenticator app.', needsTotp: true }, 401, cors(request, env));
            if (!await totpMatches(account.totp_secret, String(code))) return refuse('That code did not match. Try the next one.', 'totp', { needsTotp: true });
          }
          await throttle?.succeeded();
          const { sid, exp } = await startCrewSession(env, request, { uid: account.id, role: account.role });
          try { await env.DB.prepare('UPDATE crew_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').bind(account.id).run(); } catch { /* best effort */ }
          const actor = { uid: account.id, name: account.name, role: account.role };
          await audit(env, request, actor, 'login.success', 'user', account.id, { role: account.role, totp: Boolean(account.totp_enabled) });
          return response({ token: await sign({ role: account.role, sid, uid: account.id, name: account.name, exp }, env), user: crewUserView(account), canManageUsers: account.role === 'admin', sharedLogin: false }, request, env);
        }
        // Shared password: only while no enabled account exists, or while LEGACY_SHARED_LOGIN says so.
        const shared = await sharedLoginAvailable(env);
        if (!shared) return refuse(crewName ? 'Incorrect name or password.' : 'Sign in with your crew name and password.', crewName ? 'unknown-name' : 'no-name');
        if (!env.ADMIN_PASSWORD || !same(password, env.ADMIN_PASSWORD)) return refuse('Incorrect password.', 'password');
        await throttle?.succeeded();
        const { sid, exp } = await startCrewSession(env, request, { uid: null, role: 'admin' });
        await audit(env, request, { uid: null, name: SHARED_ACTOR }, 'login.success', null, null, { shared: true });
        return response({ token: await sign({ role: 'admin', sid, uid: null, exp }, env), user: null, canManageUsers: true, sharedLogin: true }, request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/admin/logout') {
        const admin = await requireAdmin(request, env);
        if (!admin) return error('Sign in required.', request, env, 401);
        try { await env.DB.prepare('UPDATE admin_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(new Date().toISOString(), admin.sid).run(); }
        catch (caught) { console.warn('admin_sessions unavailable (is migration 0011 applied?) — sign-out could not revoke the token server-side:', caught?.message ?? String(caught)); }
        return response({ ok: true }, request, env);
      }

      // GET /api/admin/me — who the studio is signed in as, so it can show the right controls. It
      // never 503s: on a pre-0016 database it simply answers the shared-login shape.
      if (request.method === 'GET' && url.pathname === '/api/admin/me') {
        const admin = await requireAdmin(request, env);
        if (!admin) return error('Sign in required.', request, env, 401);
        const account = admin.uid && env.DB ? await env.DB.prepare('SELECT * FROM crew_users WHERE id = ?').bind(admin.uid).first().catch(() => null) : null;
        return response({ user: account ? crewUserView(account) : null, role: admin.role, canManageUsers: admin.role === 'admin', sharedLogin: !admin.uid, accounts: await crewAccountsExist(env) }, request, env);
      }

      // ── Crew accounts (migration 0016) ────────────────────────────────────
      // Admin-only, with one bootstrap door: while the shared password still works it signs in as an
      // admin, so the first account can be created before anyone has one.
      const crewUsers = url.pathname === '/api/admin/users';
      const crewUser = url.pathname.match(/^\/api\/admin\/users\/([\w-]+)(?:\/(totp\/verify|disable|reset-password))?$/);
      if (crewUsers || crewUser || url.pathname === '/api/admin/audit') {
        const admin = await requireAdmin(request, env);
        if (!admin) return error('Sign in required.', request, env, 401);
        const denied = adminOnly(admin, request, env, 'manage crew accounts');
        if (denied) return denied;
        if (!await hasColumn(env, 'crew_users', 'name')) return error(CREW_MIGRATION_ERROR, request, env, 503);

        if (request.method === 'GET' && crewUsers) {
          const rows = await env.DB.prepare('SELECT * FROM crew_users ORDER BY disabled_at IS NOT NULL, name COLLATE NOCASE').all();
          return response({ users: rows.results.map(crewUserView), sharedLogin: await sharedLoginAvailable(env) }, request, env);
        }

        // POST /api/admin/users { name, password, role } → the account plus a one-time TOTP secret and
        // provisioning URI. The secret is shown exactly once; the member confirms a code to switch it on.
        if (request.method === 'POST' && crewUsers) {
          const { name: newName, password: newPassword, role } = await readJson(request);
          const clean = typeof newName === 'string' ? newName.trim() : '';
          if (!CREW_NAME_RE.test(clean)) return error('Names are 2–40 letters, numbers, spaces, dots, apostrophes or hyphens.', request, env);
          if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD || newPassword.length > MAX_PASSWORD) return error(`Give them a password of at least ${MIN_PASSWORD} characters.`, request, env);
          if (!CREW_ROLES.includes(role)) return error('Choose the photographer or admin role.', request, env);
          if (await crewUserByName(env, clean)) return error('Someone already uses that name.', request, env, 409);
          const secret = base32Encode(crypto.getRandomValues(new Uint8Array(20)));
          const stored = await makePassword(newPassword);
          const userId = id();
          try {
            await env.DB.prepare('INSERT INTO crew_users (id, name, password_hash, password_salt, iterations, role, totp_secret) VALUES (?, ?, ?, ?, ?, ?, ?)')
              .bind(userId, clean, stored.hash, stored.salt, stored.iterations, role, secret).run();
          } catch (caught) { if (/UNIQUE/i.test(caught?.message ?? '')) return error('Someone already uses that name.', request, env, 409); throw caught; }
          await audit(env, request, admin, 'user.create', 'user', userId, { name: clean, role });
          const created = await env.DB.prepare('SELECT * FROM crew_users WHERE id = ?').bind(userId).first();
          return response({ user: crewUserView(created), totp: { secret, uri: totpUri(clean, secret) } }, request, env, 201);
        }

        const targetId = crewUser?.[1]; const action = crewUser?.[2];
        const target = targetId ? await env.DB.prepare('SELECT * FROM crew_users WHERE id = ?').bind(targetId).first() : null;
        if (targetId && !target) return error('That crew account no longer exists.', request, env, 404);

        // POST /api/admin/users/:id/totp/verify { code } — the member (or an admin helping them set
        // the phone up) proves the authenticator works, and only then does TOTP become required.
        if (request.method === 'POST' && action === 'totp/verify') {
          const { code } = await readJson(request);
          if (!target.totp_secret) return error('That account has no authenticator secret. Reset it first.', request, env, 409);
          if (!await totpMatches(target.totp_secret, String(code ?? ''))) return error('That code did not match. Try the next one.', request, env);
          await env.DB.prepare('UPDATE crew_users SET totp_enabled = 1 WHERE id = ?').bind(target.id).run();
          await audit(env, request, admin, 'user.totp.enable', 'user', target.id, { name: target.name });
          return response({ ok: true, user: crewUserView({ ...target, totp_enabled: 1 }) }, request, env);
        }

        // POST /api/admin/users/:id/disable — keeps the row (the audit log points at it) and takes
        // every live session with it. The last enabled admin cannot be disabled: that is the lockout.
        if (request.method === 'POST' && action === 'disable') {
          if (target.disabled_at) return response({ ok: true, user: crewUserView(target) }, request, env);
          const admins = Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM crew_users WHERE role = 'admin' AND disabled_at IS NULL").first())?.n) || 0;
          if (target.role === 'admin' && admins <= 1) return error('This is the last crew admin. Make someone else an admin first.', request, env, 409);
          await env.DB.prepare('UPDATE crew_users SET disabled_at = CURRENT_TIMESTAMP WHERE id = ?').bind(target.id).run();
          await revokeSessionsOf(env, target.id);
          await audit(env, request, admin, 'user.disable', 'user', target.id, { name: target.name });
          const after = await env.DB.prepare('SELECT * FROM crew_users WHERE id = ?').bind(target.id).first();
          return response({ ok: true, user: crewUserView(after) }, request, env);
        }

        // POST /api/admin/users/:id/reset-password { password } — new password, every session gone.
        if (request.method === 'POST' && action === 'reset-password') {
          const { password: replacement } = await readJson(request);
          if (typeof replacement !== 'string' || replacement.length < MIN_PASSWORD || replacement.length > MAX_PASSWORD) return error(`Give them a password of at least ${MIN_PASSWORD} characters.`, request, env);
          const stored = await makePassword(replacement);
          await env.DB.prepare('UPDATE crew_users SET password_hash = ?, password_salt = ?, iterations = ? WHERE id = ?').bind(stored.hash, stored.salt, stored.iterations, target.id).run();
          await revokeSessionsOf(env, target.id);
          await audit(env, request, admin, 'user.reset-password', 'user', target.id, { name: target.name });
          return response({ ok: true }, request, env);
        }

        // GET /api/admin/audit?limit=&before= — newest first, paged by created_at.
        if (request.method === 'GET' && url.pathname === '/api/admin/audit') {
          const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100);
          const before = url.searchParams.get('before');
          const rows = await (before
            ? env.DB.prepare('SELECT * FROM audit_log WHERE created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?').bind(before, limit)
            : env.DB.prepare('SELECT * FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ?').bind(limit)).all();
          const entries = rows.results.map(row => ({ id: row.id, actorUserId: row.actor_user_id || null, actor: row.actor_name, action: row.action, targetType: row.target_type || null, targetId: row.target_id || null, detail: safeJson(row.detail_json), ip: row.ip || null, createdAt: row.created_at }));
          return response({ entries, nextBefore: entries.length === limit ? entries[entries.length - 1].createdAt : null }, request, env);
        }
        return error('Not found', request, env, 404);
      }

      if (request.method === 'GET' && url.pathname === '/api/sessions') {
        // Session photos are only ever shown to the guest who matched them — the landing-page card
        // uses a cover the crew explicitly chose (migration 0009), otherwise the brand illustration.
        // One statement for the list and its covers: the join's session_id clause is what guarantees a
        // cover can only ever be one of that session's own photos, whatever cover_photo_id holds.
        // The cover is served at full, watermark-free resolution — the crew is guided to pick a shot
        // with no recognisable face, so there's nothing to protect and it should look clean on the site.
        const hasCover = await hasColumn(env, 'sessions', 'cover_photo_id');
        const coverColumns = hasCover ? ', p.id AS cover_id' : ', NULL AS cover_id';
        const coverJoin = hasCover ? ' LEFT JOIN photos p ON p.id = s.cover_photo_id AND p.session_id = s.id' : '';
        // Conditions and the next drop (migration 0014) ride on the same statement; null until the crew fills them in.
        const sessions = await env.DB.prepare(`SELECT s.id, s.title, s.session_date, s.location, s.price_paise, s.currency${coverColumns}${await conditionColumns(env, 's.')} FROM sessions s${coverJoin} WHERE s.status = 'published' ORDER BY s.session_date DESC LIMIT 30`).all();
        const results = await Promise.all(sessions.results.map(async ({ cover_id: coverId, ...row }) => {
          let coverUrl = null;
          if (coverId) {
            try { coverUrl = `${url.origin}/api/media/${coverId}?variant=original&token=${encodeURIComponent(await mediaToken(coverId, 'original', env, 6 * 60, { scope: 'cover' }))}`; } catch { coverUrl = null; }
          }
          const { conditions, nextDropAt, ...session } = withConditions(row);
          return { ...session, coverUrl, conditions, nextDropAt };
        }));
        // The earliest drop still ahead across published sessions, for the landing page's "lands by" line.
        const nextDropAt = results.map(session => session.nextDropAt).filter(Boolean).sort()[0] || null;
        return response({ sessions: results, nextDropAt }, request, env);
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

        // Quotas are charged only once the request has validated (a malformed request never burns quota)
        // and before the face service is called, so a slow provider cannot be used to amplify load.
        // Windows are charged shortest first and the first refusal stops the charging, so a guest
        // retrying against a ten-minute 429 does not burn the daily cap while blocked.
        const ip = quotaKeyFor(clientIp(request));
        for (const { label, max, seconds } of MATCH_LIMITS) {
          const quota = await limiter(env, `match:${label}:${ip}`, max, seconds);
          if (quota.unavailable) return quotaUnavailable(request, env);
          if (!quota.allowed) return json({ error: `You've searched a lot in a short while. Try again in ${retryCopy(quota.retryAfter)}.` }, 429, { ...cors(request, env), 'retry-after': String(quota.retryAfter) });
        }
        sweepRateLimits(env, ctx);

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

        // Confirmed burst/appearance links extend a direct match to its linked photo even when
        // that photo has no usable face of its own — burst links confirm automatically (same
        // subject, seconds apart); appearance ("same kit") links need a crew call first. Either
        // way, pending/rejected links never reach a guest. The linked photo's own score never
        // gates inclusion here since the pairing is already confirmed ground truth.
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
        // Funnel: every search, then whether it found anything. Best effort, never blocks the answer.
        await recordEvents(env, [{ kind: 'search', sessionId, searchId }, { kind: photoIds.length ? 'match' : 'zero_match', sessionId, searchId }]);
        const base = url.origin;
        let details = new Map();   // thumb_key (0008) and width/height (0012) per matched photo, when the columns exist
        const [hasThumb, hasDims] = await Promise.all([hasColumn(env, 'photos', 'thumb_key'), hasColumn(env, 'photos', 'width')]);
        if (photoIds.length && (hasThumb || hasDims)) {
          try { const rows = await env.DB.prepare(`SELECT id${hasThumb ? ', thumb_key' : ''}${hasDims ? ', width, height' : ''} FROM photos WHERE id IN (${photoIds.map(() => '?').join(',')})`).bind(...photoIds).all(); details = new Map(rows.results.map(row => [row.id, row])); }
          catch { details = new Map(); }
        }
        const previews = await Promise.all(matches.map(async ([photoId, score]) => ({
          photoId, score: Math.round(score * 100),
          ...(await previewLinks(base, { id: photoId, ...(details.get(photoId) || {}) }, env)),
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
        const paymentId = id();
        const order = await cashfreeOrder(search, paymentId, { phone, email }, siteOrigin(request, env, url), url.origin, env);
        // The phone (already on the Cashfree order) is kept once migration 0015 adds the column, so support can find the guest.
        const withPhone = await hasColumn(env, 'payments', 'customer_phone');
        await env.DB.prepare(`INSERT INTO payments (id, search_id, cashfree_order_id, amount_paise, currency${withPhone ? ', customer_phone' : ''}) VALUES (?, ?, ?, ?, ?${withPhone ? ', ?' : ''})`)
          .bind(paymentId, searchId, order.order_id, search.price_paise, search.currency, ...(withPhone ? [phone] : [])).run();
        await recordEvents(env, [{ kind: 'checkout', sessionId: search.session_id, searchId }]);
        return response({ orderId: order.order_id, paymentSessionId: order.payment_session_id, mode: env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox', amount: search.price_paise / 100, currency: search.currency }, request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/payment/verify') {
        const { searchId, token, orderId } = await readJson(request);
        const payload = await verify(token, env);
        if (payload?.scope !== 'search' || payload.searchId !== searchId) return error('This gallery link has expired.', request, env, 401);
        const payment = await env.DB.prepare('SELECT * FROM payments WHERE cashfree_order_id = ? AND search_id = ?').bind(orderId, searchId).first();
        if (!payment) return error('Payment verification failed.', request, env, 402);
        let unlockedNow = false;
        if (!['verified', 'captured'].includes(payment.status)) {
          if (!env.CASHFREE_APP_ID || !env.CASHFREE_SECRET_KEY) return error('Payments are not configured yet.', request, env, 503);
          const orderStatus = await cashfreeOrderStatus(orderId, env);
          if (orderStatus?.order_status !== 'PAID') return error('Payment has not been confirmed yet.', request, env, 402);
          // The status guard makes the row's transition the single source of the `paid` event: if the
          // webhook captured it between our read and this write, it recorded the unlock, not us.
          const [marked] = await env.DB.batch([
            env.DB.prepare("UPDATE payments SET status = 'verified', paid_at = CURRENT_TIMESTAMP WHERE id = ? AND status NOT IN ('verified', 'captured')").bind(payment.id),
            env.DB.prepare("UPDATE searches SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ?").bind(searchId),
          ]);
          unlockedNow = Boolean(marked?.meta?.changes);
        }
        const search = await env.DB.prepare('SELECT * FROM searches WHERE id = ?').bind(searchId).first();
        if (unlockedNow) await recordEvents(env, [{ kind: 'paid', sessionId: search?.session_id ?? null, searchId }]);
        return response({ unlocked: true, photos: await accessPayload(search, request, env) }, request, env);
      }

      const media = url.pathname.match(/^\/api\/media\/([\w-]+)$/);
      if (request.method === 'GET' && media) {
        const photoId = media[1]; const variant = url.searchParams.get('variant'); const token = url.searchParams.get('token');
        const payload = await verify(token, env);
        if (!(payload?.scope === 'media' || payload?.scope === 'cover') || payload.photoId !== photoId || payload.variant !== variant) return error('This photo link has expired.', request, env, 401);
        // A landing-page cover token renders the photo and nothing else: it is public for six hours, so it
        // must never hand out the original as a file (403 before any storage read) nor count as a download.
        const download = url.searchParams.get('download') === '1';
        if (download && payload.scope === 'cover') return error('Covers cannot be downloaded.', request, env, 403);
        // Watermarked previews and thumbs are public-cacheable (browser and edge) for up to an hour, but
        // never past the signed token's own expiry (≤ 45 min), so an expired link cannot be served from
        // any cache; the token is in the URL, which is the cache key. Originals stay private.
        const cacheable = variant === 'preview' || variant === 'thumb';
        const maxAge = cacheable ? Math.max(0, Math.min(MEDIA_CACHE_SECONDS, Math.floor((Number(payload.exp) - Date.now()) / 1000))) : 0;
        const edge = cacheable && maxAge > 0 ? globalThis.caches?.default : null;
        if (edge) { const hit = await edge.match(request).catch(() => null); if (hit) return hit; }
        const photo = await env.DB.prepare(`SELECT session_id, object_key, preview_key, content_type, filename${await thumbColumn(env)} FROM photos WHERE id = ?`).bind(photoId).first();
        if (!photo) return error('Photo not found.', request, env, 404);
        const key = variant === 'original' ? photo.object_key : (variant === 'thumb' && photo.thumb_key) ? photo.thumb_key : photo.preview_key;
        const object = await env.PHOTOS.get(key);
        if (!object) return error('Photo unavailable.', request, env, 404);
        const headers = { ...cors(request, env), 'content-type': object.httpMetadata?.contentType || photo.content_type, 'cache-control': cacheable ? `public, max-age=${maxAge}` : 'private, max-age=600' };
        // ?download=1 makes the browser save the original under its session filename instead of opening it.
        // Only a token minted for a paid search (it carries the searchId) counts as a funnel download:
        // crew review images and other original links save the file without touching the funnel.
        if (variant === 'original' && download) {
          headers['content-disposition'] = `attachment; filename="${safeFilename(photo.filename)}"`;
          if (typeof payload.searchId === 'string' && payload.searchId) await recordEvents(env, [{ kind: 'download', sessionId: photo.session_id ?? null, searchId: payload.searchId }]);
        }
        const served = new Response(object.body, { headers });
        if (edge) ctx?.waitUntil?.(edge.put(request, served.clone()).catch(() => {}));
        return served;
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
        const galleryExp = Date.now() + GALLERY_DAYS * 24 * 60 * 60_000;
        const galleryToken = await sign({ scope: 'search', searchId, exp: galleryExp }, env);
        await rememberGalleryExpiry(env, searchId, new Date(galleryExp).toISOString());
        return response({ unlocked: true, photos: await accessPayload(search, request, env), galleryToken, session: await sessionSummary(env, search.session_id) }, request, env);
      }

      // GET /api/searches/:id/download — every original of a paid search as one ZIP, streamed.
      if (request.method === 'GET' && url.pathname.match(/^\/api\/searches\/([\w-]+)\/download$/)) {
        const searchId = url.pathname.split('/')[3];
        if (!await requireSearch(request, env, searchId)) return error('This gallery link has expired.', request, env, 401);
        const search = await env.DB.prepare("SELECT * FROM searches WHERE id = ? AND status = 'paid'").bind(searchId).first();
        if (!search) return error('Payment has not been confirmed.', request, env, 402);
        const photoIds = searchPhotoIds(search);
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
        await recordEvents(env, [{ kind: 'download', sessionId: search.session_id, searchId }]);   // once per ZIP
        return new Response(readable, { headers: { ...cors(request, env), 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${archiveName}"`, 'cache-control': 'no-store', ...(sized ? { 'content-length': String(zipLength(files)) } : {}) } });
      }

      // POST /api/searches/:id/colour { token, hue, tone } — the second chance after a zero match: rank
      // the session's clothing histograms against a chosen hue. Same shape as /api/match plus
      // mode: 'colour'; quota-limited like a search. The ranked ids are kept on the search (migration
      // 0015) so previews, access and the ZIP include what the guest saw and pays for. No funnel event:
      // the events CHECK has no colour kind and rebuilding that table is out of scope.
      const colourSearch = url.pathname.match(/^\/api\/searches\/([\w-]+)\/colour$/);
      if (request.method === 'POST' && colourSearch) {
        const searchId = colourSearch[1];
        const { token, hue, tone = 'any' } = await readJson(request);
        if (!await searchPayload(token, env, searchId)) return error('This gallery link has expired.', request, env, 401);
        const hueNumber = Number(hue);
        if (typeof hue === 'boolean' || hue === null || hue === '' || !Number.isFinite(hueNumber) || hueNumber < 0 || hueNumber > 359) return error('Pick a colour on the wheel (a hue from 0 to 359).', request, env);
        if (!Object.hasOwn(COLOUR_TONES, tone)) return error('Choose a vivid, muted or any tone.', request, env);
        const search = await env.DB.prepare("SELECT * FROM searches WHERE id = ? AND status = 'preview' AND expires_at > CURRENT_TIMESTAMP").bind(searchId).first();
        if (!search) return error('This gallery link has expired.', request, env, 410);
        const quota = await limiter(env, `colour:10m:${quotaKeyFor(clientIp(request))}`, COLOUR_LIMITS.max, COLOUR_LIMITS.seconds);
        if (quota.unavailable) return quotaUnavailable(request, env);
        if (!quota.allowed) return json({ error: `You've searched a lot in a short while. Try again in ${retryCopy(quota.retryAfter)}.` }, 429, { ...cors(request, env), 'retry-after': String(quota.retryAfter) });
        sweepRateLimits(env, ctx);
        const session = await env.DB.prepare('SELECT title, session_date, location FROM sessions WHERE id = ?').bind(search.session_id).first();
        const [hidden, pending] = await Promise.all([hiddenPhotoIds(env, searchId), env.DB.prepare("SELECT SUM(CASE WHEN indexing_status = 'pending' THEN 1 ELSE 0 END) AS pending FROM photos WHERE session_id = ?").bind(search.session_id).first()]);
        const rows = await env.DB.prepare(`SELECT p.id, pa.histogram_json${(await thumbColumn(env)).replace(', thumb_key', ', p.thumb_key')}${await dimensionColumns(env, 'p.')} FROM photo_appearances pa JOIN photos p ON p.id = pa.photo_id WHERE p.session_id = ? AND p.indexing_status = 'completed'`).bind(search.session_id).all();
        const ranked = [];
        for (const row of rows.results) {
          if (hidden.has(row.id)) continue;
          let histogram; try { histogram = JSON.parse(row.histogram_json); } catch { continue; }
          const score = colourScore(histogram, hueNumber, tone);
          if (score !== null && score >= COLOUR_FLOOR) ranked.push([row, score]);
        }
        const top = ranked.sort((a, b) => b[1] - a[1]).slice(0, COLOUR_LIMIT);
        if (await hasColumn(env, 'searches', 'colour_photo_ids_json')) await env.DB.prepare('UPDATE searches SET colour_photo_ids_json = ? WHERE id = ?').bind(JSON.stringify(top.map(([row]) => row.id)), searchId).run();
        else console.warn('searches.colour_photo_ids_json missing (is migration 0015 applied?) — colour results are shown but not kept on the search');
        const base = url.origin;
        const previews = await Promise.all(top.map(async ([row, score]) => ({ photoId: row.id, score: Math.round(score * 100), ...(await previewLinks(base, row, env)) })));
        const pendingPhotos = Number(pending?.pending || 0);
        return response({ searchId, token, previews, count: previews.length, pricePaise: search.price_paise, currency: search.currency, indexingNote: pendingPhotos > 0 ? `${pendingPhotos} photos are still processing. Search again later to include them.` : null, session: session ? { title: session.title, date: session.session_date, location: session.location } : null, mode: 'colour', hue: hueNumber, tone }, request, env);
      }

      // POST /api/searches/:id/hide { token, photoId, score? } — "Not me": the photo leaves the search's
      // matched and colour lists (so the pack the guest pays for excludes it) and match_hides remembers
      // it so a later colour search never brings it back. `score` is the percentage the guest saw.
      const hidePhoto = url.pathname.match(/^\/api\/searches\/([\w-]+)\/hide$/);
      if (request.method === 'POST' && hidePhoto) {
        const searchId = hidePhoto[1];
        const { token, photoId, score } = await readJson(request);
        if (!await searchPayload(token, env, searchId)) return error('This gallery link has expired.', request, env, 401);
        if (typeof photoId !== 'string' || !photoId) return error('Choose a photo to hide.', request, env);
        const search = await env.DB.prepare("SELECT * FROM searches WHERE id = ? AND status = 'preview' AND expires_at > CURRENT_TIMESTAMP").bind(searchId).first();
        if (!search) return error('This gallery link has expired.', request, env, 410);
        const matched = parseIds(search.matched_photo_ids_json), colour = parseIds(search.colour_photo_ids_json);
        if (!matched.includes(photoId) && !colour.includes(photoId)) return error('That photo is not in this search.', request, env, 404);
        const hasColour = await hasColumn(env, 'searches', 'colour_photo_ids_json');
        await env.DB.prepare(`UPDATE searches SET matched_photo_ids_json = ?${hasColour ? ', colour_photo_ids_json = ?' : ''} WHERE id = ?`)
          .bind(JSON.stringify(matched.filter(item => item !== photoId)), ...(hasColour ? [JSON.stringify(colour.filter(item => item !== photoId))] : []), searchId).run();
        const percent = Number(score);
        const similarity = score === undefined || score === null || score === '' || !Number.isFinite(percent) ? null : Math.min(1, Math.max(0, percent > 1 ? percent / 100 : percent));
        try { await env.DB.prepare('INSERT INTO match_hides (id, search_id, photo_id, similarity) VALUES (?, ?, ?, ?)').bind(id(), searchId, photoId, similarity).run(); }
        catch (caught) { if (!isMissingTable(caught)) throw caught; console.warn('match_hides unavailable (is migration 0015 applied?) — the photo left the search but the hide is not remembered:', caught?.message ?? String(caught)); }
        const remaining = new Set([...matched, ...colour]); remaining.delete(photoId);
        return response({ ok: true, remaining: remaining.size }, request, env);
      }

      // POST /api/searches/:id/notify { token, phone } — "tell me when the crew re-indexes", one row per
      // search (a repeat replaces the phone). Validated like the checkout phone.
      const notifyMe = url.pathname.match(/^\/api\/searches\/([\w-]+)\/notify$/);
      if (request.method === 'POST' && notifyMe) {
        const searchId = notifyMe[1];
        const { token, phone } = await readJson(request);
        if (!await searchPayload(token, env, searchId)) return error('This gallery link has expired.', request, env, 401);
        if (typeof phone !== 'string' || !/^[6-9]\d{9}$/.test(phone)) return error('Enter a valid 10-digit mobile number.', request, env);
        const search = await env.DB.prepare('SELECT id, session_id FROM searches WHERE id = ?').bind(searchId).first();
        if (!search) return error('This gallery link has expired.', request, env, 410);
        try { await env.DB.prepare('INSERT INTO notify_requests (id, search_id, session_id, phone) VALUES (?, ?, ?, ?) ON CONFLICT(search_id) DO UPDATE SET phone = excluded.phone, created_at = CURRENT_TIMESTAMP, notified_at = NULL').bind(id(), searchId, search.session_id, phone).run(); }
        catch (caught) { if (!isMissingTable(caught)) throw caught; return error('Notifications are not available yet.', request, env, 503); }
        return response({ ok: true }, request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/admin/sessions') {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const { title, date, location, pricePaise, ...rest } = await readJson(request);
        validateSession({ title, date, location, pricePaise });
        const conditions = validateConditions(rest);
        const fields = Object.keys(conditions).filter(field => conditions[field] !== null);   // empty fields need no column
        if (fields.length && !await hasColumn(env, 'sessions', 'break_name')) return error('Session conditions need database migration 0014.', request, env, 503);
        const session = { id: id(), title: title.trim(), date, location: location.trim(), price: Number(pricePaise) };
        await env.DB.prepare(`INSERT INTO sessions (id, title, session_date, location, price_paise${fields.map(field => `, ${CONDITION_COLUMNS[field]}`).join('')}) VALUES (?, ?, ?, ?, ?${fields.map(() => ', ?').join('')})`)
          .bind(session.id, session.title, session.date, session.location, session.price, ...fields.map(field => conditions[field])).run();
        const { conditions: saved, nextDropAt } = withConditions(conditionsRow(conditions));
        return response({ session: { ...session, conditions: saved, nextDropAt } }, request, env, 201);
      }

      const dashboard = url.pathname.match(/^\/api\/admin\/dashboard$/);
      if (request.method === 'GET' && dashboard) {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const query = `
          SELECT
            s.id, s.title, s.session_date as date, s.location, s.status, s.price_paise${await conditionColumns(env, 's.')},
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
        // Conditions (0014) come off the row; the indexing block (queue depth, ETA, grouped failures) is one extra aggregate.
        const indexing = await indexingSummary(env, sessions.results.map(row => row.id));
        return response({ sessions: sessions.results.map(row => ({ ...withConditions(row), indexing: indexing.get(row.id) || emptyIndexing() })) }, request, env);
      }

      // GET /api/admin/stats — the guest funnel per session (migration 0013); see funnelStats().
      if (request.method === 'GET' && url.pathname === '/api/admin/stats') {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        return response(await funnelStats(env), request, env);
      }

      const deleteSession = url.pathname.match(/^\/api\/admin\/sessions\/([\w-]+)$/);
      if (request.method === 'DELETE' && deleteSession) {
        const admin = await requireAdmin(request, env);
        if (!admin) return error('Sign in required.', request, env, 401);
        const sessionId = deleteSession[1];
        // A published session is live work with paid galleries hanging off it: admins only (W4-C).
        const doomed = await env.DB.prepare('SELECT title, status FROM sessions WHERE id = ?').bind(sessionId).first();
        if (doomed?.status === 'published') { const denied = adminOnly(admin, request, env, 'delete a published session'); if (denied) return denied; }

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

        await audit(env, request, admin, 'session.delete', 'session', sessionId, { title: doomed?.title ?? null, status: doomed?.status ?? null, photos: photos.results.length });
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
          SELECT p.id, p.filename, p.indexing_status, p.created_at, j.error as indexing_error, COUNT(f.id) as face_count${(await thumbColumn(env)).replace(', thumb_key', ', p.thumb_key')}${await dimensionColumns(env, 'p.')}
          FROM photos p
          LEFT JOIN faces f ON f.photo_id = p.id
          LEFT JOIN indexing_jobs j ON j.photo_id = p.id
          WHERE p.session_id = ?
          GROUP BY p.id
          ORDER BY p.created_at DESC
        `).bind(sessionId).all();

        const results = await Promise.all(photos.results.map(async (photo) => ({
          ...photo,
          ...dimensions(photo),
          previewUrl: await mediaLink(base, photo.id, 'preview', env),
          thumbUrl: photo.thumb_key ? await mediaLink(base, photo.id, 'thumb', env) : null,
          originalUrl: await mediaLink(base, photo.id, 'original', env),
        })));

        return response({ photos: results, coverPhotoId }, request, env);
      }

      // DELETE /api/admin/photos/:id - Delete a single photo
      const deletePhoto = url.pathname.match(/^\/api\/admin\/photos\/([\w-]+)$/);
      if (request.method === 'DELETE' && deletePhoto) {
        const admin = await requireAdmin(request, env);
        if (!admin) return error('Sign in required.', request, env, 401);
        const photoId = deletePhoto[1];
        const photo = await env.DB.prepare(`SELECT object_key, preview_key${await thumbColumn(env)} FROM photos WHERE id = ?`).bind(photoId).first();
        if (!photo) return error('Photo not found.', request, env, 404);

        await Promise.all([photo.object_key, photo.preview_key, photo.thumb_key].filter(Boolean).map(key => env.PHOTOS.delete(key)));

        await env.DB.batch([
          env.DB.prepare('DELETE FROM faces WHERE photo_id = ?').bind(photoId),
          env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(photoId),
        ]);

        await audit(env, request, admin, 'photo.delete', 'photo', photoId, null);
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
        return response(await enqueuePhotos(photos.results, env, { force: !onlyFailed }), request, env, 202);
      }

      // PUT /api/admin/sessions/:id - Update session details or status
      const updateSession = url.pathname.match(/^\/api\/admin\/sessions\/([\w-]+)$/);
      if (request.method === 'PUT' && updateSession) {
        const admin = await requireAdmin(request, env);
        if (!admin) return error('Sign in required.', request, env, 401);
        const sessionId = updateSession[1];
        const { title, date, location, pricePaise, status, coverPhotoId, ...rest } = await readJson(request);
        validateSession({ title, date, location, pricePaise, status }, true);
        const conditions = validateConditions(rest);
        const existing = await env.DB.prepare('SELECT id, status FROM sessions WHERE id = ?').bind(sessionId).first();
        if (!existing) return error('Session not found.', request, env, 404);
        const conditionFields = Object.keys(conditions);
        if (conditionFields.length) {
          // null clears a field, so this is a plain SET of exactly the fields sent (COALESCE below would keep old values).
          if (await hasColumn(env, 'sessions', 'break_name')) await env.DB.prepare(`UPDATE sessions SET ${conditionFields.map(field => `${CONDITION_COLUMNS[field]} = ?`).join(', ')} WHERE id = ?`).bind(...conditionFields.map(field => conditions[field]), sessionId).run();
          else if (conditionFields.some(field => conditions[field] !== null)) return error('Session conditions need database migration 0014.', request, env, 503);
        }
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
        // Only a status change is audited (W4-C): 'published' here is the same act as POST …/publish, 'draft' takes live work off the site.
        if (status && status !== existing.status) await audit(env, request, admin, status === 'published' ? 'session.publish' : status === 'archived' ? 'session.archive' : 'session.unpublish', 'session', sessionId, { was: existing.status, now: status });

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
          ORDER BY s.title ASC, fv.similarity DESC
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
        if (pair) await recordFeedback(env, { source: 'face_pair', score: pair.similarity, label: confirmed ? 1 : 0, subjectId: pairId });

        return response({ success: true, status: newStatus }, request, env);
      }

      // POST /api/admin/undo-review { kind: 'pair' | 'link', id } — take back the last Same / Different
      // within ten minutes (F30): the row returns to pending and its feedback row is removed.
      if (request.method === 'POST' && url.pathname === '/api/admin/undo-review') {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const { kind, id: subjectId } = await readJson(request);
        if (!['pair', 'link'].includes(kind) || typeof subjectId !== 'string' || !subjectId) return error('Choose a pair or link decision to undo.', request, env);
        const table = kind === 'pair' ? 'face_verifications' : 'photo_links';
        const row = await env.DB.prepare(kind === 'pair'
          ? "SELECT status, updated_at, similarity AS score, 'face_pair' AS source FROM face_verifications WHERE id = ?"
          : "SELECT status, updated_at, score, CASE link_type WHEN 'appearance' THEN 'appearance_link' ELSE 'burst_link' END AS source FROM photo_links WHERE id = ?").bind(subjectId).first();
        if (!row) return error('That decision is no longer in the queue.', request, env, 404);
        const decidedAt = Date.parse(`${row.updated_at}Z`) || Date.parse(row.updated_at) || 0;   // D1's CURRENT_TIMESTAMP is UTC without a zone
        if (row.status === 'pending' || Date.now() - decidedAt > UNDO_WINDOW_MS) return error('Too late to undo — the queue moved on.', request, env, 409);
        const reverted = await env.DB.prepare(`UPDATE ${table} SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?`).bind(subjectId, row.status).run();
        if (!reverted.meta?.changes) return error('Too late to undo — the queue moved on.', request, env, 409);
        await removeFeedback(env, { subjectId, source: row.source, score: row.score, label: row.status === 'confirmed' ? 1 : 0 });
        return response({ success: true, kind, id: subjectId, status: 'pending' }, request, env);
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

        // Burst links (same subject, shot seconds apart) auto-confirm at generation time now — this
        // sweeps any left over from before that change, or from a deploy race, so they never sit in
        // the queue waiting on a human. Appearance ("same kit") links still need a crew call.
        await env.DB.prepare(`UPDATE photo_links SET status = 'confirmed', updated_at = CURRENT_TIMESTAMP WHERE link_type = 'burst' AND status = 'pending'`).run();

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
          ORDER BY s.title ASC, pl.score DESC
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
        if (link) await recordFeedback(env, { source: link.link_type === 'appearance' ? 'appearance_link' : 'burst_link', score: link.score, label: confirmed ? 1 : 0, subjectId: linkId });

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
        const hint = dimensionHint(url.searchParams.get('width'), url.searchParams.get('height'));   // preview size from the studio: fallback only
        if (uploadType.includes('multipart/form-data')) {
          // Legacy buffered upload — kept so a client that has not switched to streaming still works.
          const form = await readForm(request, 32 * 1024 * 1024); const file = form.get('file'); const preview = form.get('preview');
          if (!(file instanceof File) || !(preview instanceof File) || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || !PREVIEW_TYPES.includes(preview.type) || !file.size || file.size > 25 * 1024 * 1024 || !preview.size || preview.size > 5 * 1024 * 1024) return error('An image and its preview are required.', request, env);
          const onDuplicate = form.get('onDuplicate');
          if (onDuplicate !== null && !DUPLICATE_MODES.includes(onDuplicate)) return error('Choose replace, skip or rename for duplicate photos.', request, env);
          return await storeSessionPhoto(env, request, sessionId, { filename: file.name, contentType: file.type, original: file, preview, previewType: preview.type, onDuplicate, header: file.slice(0, HEADER_BYTES).arrayBuffer(), hint });
        }
        // Streaming upload — metadata in the query string, body is [len][preview][original].
        const type = url.searchParams.get('type'); const onDuplicate = url.searchParams.get('onDuplicate');
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) return error('An image and its preview are required.', request, env);
        if (onDuplicate !== null && !DUPLICATE_MODES.includes(onDuplicate)) return error('Choose replace, skip or rename for duplicate photos.', request, env);
        const { preview, original, header } = await readFramedUpload(request, 5 * 1024 * 1024);
        return await storeSessionPhoto(env, request, sessionId, { filename: url.searchParams.get('filename') || 'photo.jpg', contentType: type, original, preview, onDuplicate, header, hint });
      }

      // ── Direct-to-R2 uploads ──
      // POST /api/admin/sessions/:id/uploads/presign { filename, contentType, size } → a 15-minute
      // presigned PUT for the original under the same key storeSessionPhoto would have used, plus the
      // photoId reserved for it. 503 { fallback: 'stream' } until the R2 secrets exist (the studio
      // then keeps streaming through the route above). Nothing is written yet: a presign that is never
      // completed costs one orphan object at most.
      const presignRoute = url.pathname.match(/^\/api\/admin\/sessions\/([\w-]+)\/uploads\/presign$/);
      if (request.method === 'POST' && presignRoute) {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        if (!directUploadsConfigured(env)) return response({ error: 'Direct uploads are not configured on this Worker.', fallback: 'stream' }, request, env, 503);
        if (!env.INDEX_QUEUE) return error('Photo processing is not configured.', request, env, 503);
        const { filename, contentType, size } = await readJson(request);
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) return error('Choose a JPG, PNG or WebP photo.', request, env);
        if (!Number.isInteger(size) || size <= 0 || size > DIRECT_UPLOAD_MAX_BYTES) return error('Photos must be under 25 MB.', request, env, Number.isInteger(size) && size > DIRECT_UPLOAD_MAX_BYTES ? 413 : 400);
        const sessionId = presignRoute[1]; const session = await env.DB.prepare('SELECT id, status FROM sessions WHERE id = ?').bind(sessionId).first();
        if (!session) return error('Session not found. Create a session before uploading.', request, env, 404);
        if (session.status === 'archived') return error('Restore this archived session before uploading more photos.', request, env, 409);
        const photoId = id(); const key = `sessions/${sessionId}/original/${photoId}-${safeFilename(filename)}`;
        const uploadUrl = await presignS3Url({ method: 'PUT', url: r2ObjectUrl(env, key), accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, expires: PRESIGN_SECONDS, headers: { 'content-type': contentType } });
        return response({ uploadUrl, method: 'PUT', key, photoId, expiresAt: new Date(Date.now() + PRESIGN_SECONDS * 1000).toISOString(), headers: { 'content-type': contentType } }, request, env, 201);
      }
      // POST /api/admin/sessions/:id/uploads/complete?photoId=&key=&filename=&contentType=&onDuplicate=&width=&height=
      // with the body [uint32 preview length LE][preview][thumb] — registers a photo the browser PUT to
      // R2 itself. The object is head()ed first (404 { missing: true } sends the studio back to the
      // streaming route for that file), its first 64 KB are read for the pixel size, then the same
      // registration as every other upload runs (duplicate modes included; a `skip` deletes the object).
      const completeRoute = url.pathname.match(/^\/api\/admin\/sessions\/([\w-]+)\/uploads\/complete$/);
      if (request.method === 'POST' && completeRoute) {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        if (!env.INDEX_QUEUE) return error('Photo processing is not configured.', request, env, 503);
        const sessionId = completeRoute[1]; const photoId = url.searchParams.get('photoId') || ''; const key = url.searchParams.get('key') || '';
        const type = url.searchParams.get('contentType'); const onDuplicate = url.searchParams.get('onDuplicate');
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) return error('An image and its preview are required.', request, env);
        if (onDuplicate !== null && !DUPLICATE_MODES.includes(onDuplicate)) return error('Choose replace, skip or rename for duplicate photos.', request, env);
        // The key must be one presign() would have minted for this session and photo id — never an arbitrary object.
        const keyPrefix = `sessions/${sessionId}/original/${photoId}-`;
        if (!/^[\w-]+$/.test(photoId) || !key.startsWith(keyPrefix) || !/^[a-zA-Z0-9._-]{1,120}$/.test(key.slice(keyPrefix.length))) return error('That upload key is not valid.', request, env);
        const session = await env.DB.prepare('SELECT id, status FROM sessions WHERE id = ?').bind(sessionId).first();
        if (!session) return error('Session not found. Create a session before uploading.', request, env, 404);
        if (session.status === 'archived') return error('Restore this archived session before uploading more photos.', request, env, 409);
        const head = await env.PHOTOS.head(key);
        if (!head) return response({ error: 'The photo never reached storage — it will be sent again.', missing: true }, request, env, 404);
        if (!head.size || head.size > DIRECT_UPLOAD_MAX_BYTES || (head.httpMetadata?.contentType && !['image/jpeg', 'image/png', 'image/webp'].includes(head.httpMetadata.contentType))) {
          await env.PHOTOS.delete(key).catch(() => {});
          return error('That upload is not a photo under 25 MB.', request, env, head.size > DIRECT_UPLOAD_MAX_BYTES ? 413 : 400);
        }
        const { preview, thumb } = await readFramedSmall(request, 6 * 1024 * 1024);
        const hint = dimensionHint(url.searchParams.get('width'), url.searchParams.get('height'));
        // A range read of the object's first bytes for the pixel size — the same parse the streaming path tees.
        const header = (async () => { const part = await env.PHOTOS.get(key, { range: { offset: 0, length: HEADER_BYTES } }); return part ? new Uint8Array(await part.arrayBuffer()) : new Uint8Array(0); })().catch(() => new Uint8Array(0));
        return await storeSessionPhoto(env, request, sessionId, { filename: url.searchParams.get('filename') || key.slice(key.lastIndexOf('-') + 1), contentType: type, preview, thumb, onDuplicate, header, hint, stored: { photoId, key } });
      }

      // POST /api/admin/photos/:id/thumb — a small watermarked JPEG or WebP for grid tiles, sent by the
      // crew studio after the main upload (and by "Regenerate previews"). Optional: everything renders
      // from the preview without it. The key's extension follows the sniffed format; a thumb stored
      // under another extension earlier is removed once the row points at the new one.
      const thumbUpload = url.pathname.match(/^\/api\/admin\/photos\/([\w-]+)\/thumb$/);
      if (request.method === 'POST' && thumbUpload) {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        if (!await hasColumn(env, 'photos', 'thumb_key')) return error('Thumbnails need database migration 0008.', request, env, 503);
        const photo = await env.DB.prepare('SELECT id, session_id, thumb_key FROM photos WHERE id = ?').bind(thumbUpload[1]).first();
        if (!photo) return error('Photo not found.', request, env, 404);
        const body = await boundedBody(request, 1024 * 1024);
        const format = body.size ? await previewFormatOf(body) : null;
        if (!format) return error('The thumbnail must be a JPEG or WebP.', request, env, 400);
        const thumbKey = `sessions/${photo.session_id}/thumb/${photo.id}.${format.ext}`;
        await env.PHOTOS.put(thumbKey, body, { httpMetadata: { contentType: format.type } });
        await env.DB.prepare('UPDATE photos SET thumb_key = ? WHERE id = ?').bind(thumbKey, photo.id).run();
        if (photo.thumb_key && photo.thumb_key !== thumbKey) await env.PHOTOS.delete(photo.thumb_key).catch(() => {});
        return response({ photoId: photo.id, thumb: true }, request, env, 201);
      }
      // PUT /api/admin/photos/:id/preview?width=&height= — replace the watermarked preview ("Regenerate
      // previews": the studio re-renders 600 px WebP/JPEG previews from the originals of sessions
      // uploaded before F5 and sends them here; the thumb follows through the route above). The pixel
      // size, if sent, fills in only where migration 0012's columns are still empty (pre-0012 photos).
      // Edge caches keep an old preview for at most an hour (MEDIA_CACHE_SECONDS); the token in the URL
      // rotates before that anyway.
      const previewUpdate = url.pathname.match(/^\/api\/admin\/photos\/([\w-]+)\/preview$/);
      if (request.method === 'PUT' && previewUpdate) {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const hasDims = await hasColumn(env, 'photos', 'width');
        const photo = await env.DB.prepare(`SELECT id, session_id, preview_key${hasDims ? ', width, height' : ''} FROM photos WHERE id = ?`).bind(previewUpdate[1]).first();
        if (!photo) return error('Photo not found.', request, env, 404);
        const body = await boundedBody(request, 5 * 1024 * 1024);
        const format = body.size ? await previewFormatOf(body) : null;
        if (!format) return error('The preview must be a JPEG or WebP.', request, env, 400);
        const previewKey = `sessions/${photo.session_id}/preview/${photo.id}.${format.ext}`;
        await env.PHOTOS.put(previewKey, body, { httpMetadata: { contentType: format.type } });
        const hint = hasDims && !(photo.width > 0 && photo.height > 0) ? dimensionHint(url.searchParams.get('width'), url.searchParams.get('height')) : null;
        await env.DB.prepare(`UPDATE photos SET preview_key = ?${hint ? ', width = ?, height = ?' : ''} WHERE id = ?`).bind(previewKey, ...(hint ? [hint.width, hint.height] : []), photo.id).run();
        if (photo.preview_key && photo.preview_key !== previewKey) await env.PHOTOS.delete(photo.preview_key).catch(() => {});
        return response({ photoId: photo.id, preview: true, key: previewKey, ...(hint ? { width: hint.width, height: hint.height } : {}) }, request, env);
      }

      const publish = url.pathname.match(/^\/api\/admin\/sessions\/([\w-]+)\/publish$/);
      if (request.method === 'POST' && publish) {
        const admin = await requireAdmin(request, env);
        if (!admin) return error('Sign in required.', request, env, 401);
        // Body is optional ({ noCover: true } publishes without a cover); a session card's Publish sends none.
        const body = request.body && request.headers.get('content-length') !== '0' ? await readJson(request) : {};
        const hasCover = await hasColumn(env, 'sessions', 'cover_photo_id');
        const session = await env.DB.prepare(`SELECT id${hasCover ? ', cover_photo_id' : ''} FROM sessions WHERE id = ?`).bind(publish[1]).first();
        if (!session) return error('Session not found.', request, env, 404);
        const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM photos WHERE session_id = ?').bind(publish[1]).first();
        if (!count?.count) return error('Upload at least one photo before publishing.', request, env);
        // Covers are crew-chosen, never automatic: publishing without one has to be said out loud.
        if (hasCover && !session.cover_photo_id && body.noCover !== true) return response({ error: 'Pick a cover photo or publish without one.', needsCover: true }, request, env, 409);
        await env.DB.prepare("UPDATE sessions SET status = 'published', published_at = CURRENT_TIMESTAMP WHERE id = ?").bind(publish[1]).run();
        await audit(env, request, admin, 'session.publish', 'session', publish[1], { photos: Number(count.count) || 0, cover: hasCover ? session.cover_photo_id || null : null });
        return response({ published: true }, request, env);
      }

      // POST /api/admin/photos/bulk { action, photoIds, targetSessionId? } — delete / reindex / move /
      // cover for up to 200 photos in one call. Unknown ids land in `failed` and never abort the rest.
      if (request.method === 'POST' && url.pathname === '/api/admin/photos/bulk') {
        const admin = await requireAdmin(request, env);
        if (!admin) return error('Sign in required.', request, env, 401);
        const { action, photoIds, targetSessionId } = await readJson(request);
        if (!BULK_ACTIONS.includes(action)) return error('Choose delete, reindex, move or cover.', request, env);
        if (!Array.isArray(photoIds) || !photoIds.length || photoIds.length > BULK_LIMIT || !photoIds.every(value => typeof value === 'string' && value)) return error(`Select between 1 and ${BULK_LIMIT} photos.`, request, env);
        const ids = [...new Set(photoIds)]; const marks = list => list.map(() => '?').join(',');
        const rows = (await env.DB.prepare(`SELECT id, session_id, object_key, preview_key${await thumbColumn(env)} FROM photos WHERE id IN (${marks(ids)})`).bind(...ids).all()).results;
        const found = new Map(rows.map(row => [row.id, row]));
        const failed = ids.filter(photoId => !found.has(photoId)).map(photoId => ({ photoId, error: 'Photo not found.' }));
        let affected = 0;
        if (action === 'cover') {
          // The first id becomes the cover of its own session; the rest of the selection is ignored.
          if (!await hasColumn(env, 'sessions', 'cover_photo_id')) return error('Session covers need database migration 0009.', request, env, 503);
          const photo = found.get(ids[0]);
          if (!photo) return error('Photo not found.', request, env, 404);
          await env.DB.prepare('UPDATE sessions SET cover_photo_id = ? WHERE id = ?').bind(photo.id, photo.session_id).run();
          return response({ ok: true, affected: 1, failed: [] }, request, env);
        }
        if (action === 'delete') {
          for (const photo of rows) {
            try {
              await Promise.all([photo.object_key, photo.preview_key, photo.thumb_key].filter(Boolean).map(key => env.PHOTOS.delete(key)));
              await env.DB.batch([env.DB.prepare('DELETE FROM faces WHERE photo_id = ?').bind(photo.id), env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(photo.id)]);
              affected += 1;
            } catch (caught) { console.error('bulk delete failed', photo.id, caught?.message ?? String(caught)); failed.push({ photoId: photo.id, error: 'Could not delete this photo.' }); }
          }
        } else if (action === 'reindex') {
          for (const photo of rows) {
            const result = await enqueuePhotos([photo], env, { force: true });
            if (result.failed) failed.push({ photoId: photo.id, error: 'Could not queue photo. Retry processing.' }); else affected += 1;
          }
        } else if (action === 'move') {
          if (typeof targetSessionId !== 'string' || !targetSessionId) return error('Choose a session to move the photos to.', request, env);
          const target = await env.DB.prepare('SELECT id, status FROM sessions WHERE id = ?').bind(targetSessionId).first();
          if (!target) return error('That session does not exist.', request, env, 404);
          if (target.status === 'archived') return error('Restore that archived session before moving photos into it.', request, env, 409);
          const moving = rows.filter(row => row.session_id !== targetSessionId).map(row => row.id);
          if (moving.length) {
            // Faces stay with their photo (keyed by photo id). A link or a face pair only makes sense
            // inside one session: pairs that move together follow the photos, pairs split by the move go.
            // R2 keys keep the old session id in their path, which is fine — they are opaque.
            const statements = [
              env.DB.prepare(`UPDATE photos SET session_id = ? WHERE id IN (${marks(moving)})`).bind(targetSessionId, ...moving),
              env.DB.prepare(`UPDATE photo_links SET session_id = ? WHERE photo1_id IN (${marks(moving)}) AND photo2_id IN (${marks(moving)})`).bind(targetSessionId, ...moving, ...moving),
              env.DB.prepare(`DELETE FROM photo_links WHERE (photo1_id IN (${marks(moving)})) != (photo2_id IN (${marks(moving)}))`).bind(...moving, ...moving),
              env.DB.prepare(`UPDATE face_verifications SET session_id = ? WHERE face1_id IN (SELECT id FROM faces WHERE photo_id IN (${marks(moving)})) AND face2_id IN (SELECT id FROM faces WHERE photo_id IN (${marks(moving)}))`).bind(targetSessionId, ...moving, ...moving),
              env.DB.prepare(`DELETE FROM face_verifications WHERE (face1_id IN (SELECT id FROM faces WHERE photo_id IN (${marks(moving)}))) != (face2_id IN (SELECT id FROM faces WHERE photo_id IN (${marks(moving)})))`).bind(...moving, ...moving),
            ];
            if (await hasColumn(env, 'sessions', 'cover_photo_id')) statements.push(env.DB.prepare(`UPDATE sessions SET cover_photo_id = NULL WHERE cover_photo_id IN (${marks(moving)})`).bind(...moving));
            await env.DB.batch(statements);
            affected = moving.length;
          }
        }
        // Bulk deletes and moves are the two that destroy or relocate work; re-index and cover are not audited.
        if (action === 'delete' || action === 'move') await audit(env, request, admin, `photo.bulk-${action}`, 'photo', ids[0], { photos: affected, ...(action === 'move' ? { to: targetSessionId } : {}), failed: failed.length });
        return response({ ok: true, affected, failed }, request, env);
      }

      // GET /api/admin/lookup?phone=|order=|search= — support: a guest's searches, payments and notify-me
      // requests, with what they saw (see supportLookup). Exactly one key; phones are masked in the answer.
      if (request.method === 'GET' && url.pathname === '/api/admin/lookup') {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const keys = { phone: url.searchParams.get('phone'), order: url.searchParams.get('order'), search: url.searchParams.get('search') };
        const given = Object.values(keys).filter(value => value !== null && value.trim() !== '');
        if (given.length !== 1) return error('Look up by one of phone, order or search.', request, env);
        if (keys.phone !== null && !/^[6-9]\d{9}$/.test(keys.phone.trim())) return error('Enter a valid 10-digit mobile number.', request, env);
        return response(await supportLookup(env, { phone: keys.phone?.trim() || null, order: keys.order?.trim() || null, search: keys.search?.trim() || null }, url.origin), request, env);
      }

      // POST /api/admin/searches/:id/resend — a fresh 30-day gallery link for a paid search.
      const resend = url.pathname.match(/^\/api\/admin\/searches\/([\w-]+)\/resend$/);
      if (request.method === 'POST' && resend) {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const search = await env.DB.prepare('SELECT id, status FROM searches WHERE id = ?').bind(resend[1]).first();
        if (!search) return error('Search not found.', request, env, 404);
        if (search.status !== 'paid') return error('This search has not been paid for. Use a free unlock instead.', request, env, 402);
        return response(await galleryLink(env, search.id, request, url), request, env);
      }

      // POST /api/admin/searches/:id/grant { reason } — a free unlock: the search becomes paid with a
      // grants row instead of a payment (no rupees, no `paid` event; stats count it as a grant).
      const grantUnlock = url.pathname.match(/^\/api\/admin\/searches\/([\w-]+)\/grant$/);
      if (request.method === 'POST' && grantUnlock) {
        const admin = await requireAdmin(request, env);
        if (!admin) return error('Sign in required.', request, env, 401);
        const deniedGrant = adminOnly(admin, request, env, 'give a free unlock');   // money decision (W4-C)
        if (deniedGrant) return deniedGrant;
        const { reason } = await readJson(request);
        if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 200) return error('Give a reason for the free unlock (up to 200 characters).', request, env);
        const search = await env.DB.prepare('SELECT id, status FROM searches WHERE id = ?').bind(grantUnlock[1]).first();
        if (!search) return error('Search not found.', request, env, 404);
        if (search.status === 'paid') return error('This search is already unlocked.', request, env, 409);
        try {
          await env.DB.batch([
            env.DB.prepare('INSERT INTO grants (id, search_id, reason) VALUES (?, ?, ?)').bind(id(), search.id, reason.trim()),
            env.DB.prepare("UPDATE searches SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ?").bind(search.id),
          ]);
        } catch (caught) { if (!isMissingTable(caught)) throw caught; return error('Free unlocks need database migration 0015.', request, env, 503); }
        await audit(env, request, admin, 'search.grant', 'search', search.id, { reason: reason.trim() });
        return response({ ok: true, ...(await galleryLink(env, search.id, request, url)) }, request, env);
      }

      // POST /api/admin/payments/:id/refund { amountPaise?, reason } — Cashfree Create Refund for a
      // confirmed payment, full by default, capped server-side at what is left to refund. The refunds
      // row is written PENDING before the call and updated from the answer; REFUND_STATUS_WEBHOOK keeps
      // it current afterwards. 503 without credentials or before migration 0015.
      const refundPayment = url.pathname.match(/^\/api\/admin\/payments\/([\w-]+)\/refund$/);
      if (request.method === 'POST' && refundPayment) {
        const admin = await requireAdmin(request, env);
        if (!admin) return error('Sign in required.', request, env, 401);
        const deniedRefund = adminOnly(admin, request, env, 'issue a refund');   // money decision (W4-C)
        if (deniedRefund) return deniedRefund;
        const { amountPaise, reason } = await readJson(request);
        if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 200) return error('Give a reason for the refund (up to 200 characters).', request, env);
        if (!env.CASHFREE_APP_ID || !env.CASHFREE_SECRET_KEY) return error('Payments are not configured yet.', request, env, 503);
        const payment = await env.DB.prepare('SELECT * FROM payments WHERE id = ?').bind(refundPayment[1]).first();
        if (!payment) return error('Payment not found.', request, env, 404);
        if (!['verified', 'captured'].includes(payment.status)) return error('Only a confirmed payment can be refunded.', request, env, 409);
        let refunded = 0;
        try { refunded = Number((await env.DB.prepare("SELECT COALESCE(SUM(amount_paise), 0) AS paise FROM refunds WHERE payment_id = ? AND status NOT IN ('CANCELLED', 'FAILED')").bind(payment.id).first())?.paise) || 0; }
        catch (caught) { if (!isMissingTable(caught)) throw caught; return error('Refunds need database migration 0015.', request, env, 503); }
        const remaining = (Number(payment.amount_paise) || 0) - refunded;
        if (remaining <= 0) return error('This payment has already been refunded in full.', request, env);
        const amount = amountPaise === undefined || amountPaise === null ? remaining : Number(amountPaise);
        if (!Number.isSafeInteger(amount) || amount <= 0) return error('Enter a refund amount in paise.', request, env);
        if (amount > remaining) return error(`Only ₹${(remaining / 100).toFixed(2)} of this payment is left to refund.`, request, env);
        const refundId = `rf-${id()}`;
        await env.DB.prepare("INSERT INTO refunds (id, payment_id, amount_paise, status, reason) VALUES (?, ?, ?, 'PENDING', ?)").bind(refundId, payment.id, amount, reason.trim()).run();
        const result = await cashfreeRefund(payment.cashfree_order_id, { refundId, amountPaise: amount, note: reason.trim() }, env);
        if (!result.ok) {
          await env.DB.prepare("UPDATE refunds SET status = 'FAILED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(refundId).run();
          console.error('cashfree refund refused', refundId, result.status, result.body?.code ?? result.error ?? null);
          return error('Cashfree did not accept the refund. Check the payment in the Cashfree dashboard.', request, env, 502);
        }
        const status = REFUND_STATUSES.has(result.body?.refund_status) ? result.body.refund_status : 'PENDING';
        await env.DB.prepare('UPDATE refunds SET cashfree_refund_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(result.body?.cf_refund_id != null ? String(result.body.cf_refund_id) : null, status, refundId).run();
        const row = await env.DB.prepare('SELECT * FROM refunds WHERE id = ?').bind(refundId).first();
        await audit(env, request, admin, 'payment.refund', 'payment', payment.id, { refundId, amountPaise: amount, status, reason: reason.trim() });
        return response({ ok: true, refund: refundView(row) }, request, env);
      }

      // GET /api/admin/settlements?from=&to= — Cashfree settlements for an IST date range (default the
      // last 30 days) and our confirmed payments from that range that no settlement names yet.
      if (request.method === 'GET' && url.pathname === '/api/admin/settlements') {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        if (!env.CASHFREE_APP_ID || !env.CASHFREE_SECRET_KEY) return error('Payments are not configured yet.', request, env, 503);
        const to = url.searchParams.get('to') || istToday();
        const from = url.searchParams.get('from') || (validDate(to) ? shiftDate(to, -30) : '');
        if (!validDate(from) || !validDate(to) || from > to) return error('Choose a valid date range (YYYY-MM-DD, from before to).', request, env);
        return response(await settlementsReport(env, from, to), request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/payment/webhook') {
        // Cheap checks before the body is read or HMACed: the secret and both headers must exist and the
        // timestamp must sit inside the window (a replayed delivery carries a valid signature over a
        // stale timestamp, so the window is what stops it). Then a bounded read — Cashfree payloads are
        // a few KB, 413 above WEBHOOK_MAX_BYTES — and the constant-time signature compare over the raw body.
        const signature = request.headers.get('x-webhook-signature');
        const timestamp = request.headers.get('x-webhook-timestamp');
        if (!env.CASHFREE_SECRET_KEY || !timestamp || !signature) return error('Invalid webhook signature.', request, env, 401);
        if (!webhookTimestampFresh(timestamp)) return error('Webhook timestamp is outside the accepted window.', request, env, 401);
        const raw = await (await boundedBody(request, WEBHOOK_MAX_BYTES)).text();
        if (!same(await hmacBase64(`${timestamp}${raw}`, env.CASHFREE_SECRET_KEY), signature)) return error('Invalid webhook signature.', request, env, 401);
        const event = JSON.parse(raw);
        // Route on the event type, then on payment_status: a PAYMENT_SUCCESS_WEBHOOK can still carry
        // PENDING (late authorisation) and must not unlock the gallery before the final delivery.
        const paymentStatus = event.data?.payment?.payment_status;
        if (event.type === 'PAYMENT_SUCCESS_WEBHOOK' && (paymentStatus === undefined || paymentStatus === 'SUCCESS')) {
          const orderId = event.data?.order?.order_id;
          const cfPaymentId = event.data?.payment?.cf_payment_id;
          if (orderId) {
            const cfId = cfPaymentId ? String(cfPaymentId) : null;
            // Two guarded writes so the row's own transition decides the `paid` event: the first captures a
            // payment nobody has confirmed yet (that is the unlock); the second only upgrades one the guest's
            // verify call already confirmed, keeping its paid_at and adding no second event.
            const [captured] = await env.DB.batch([
              env.DB.prepare("UPDATE payments SET cashfree_payment_id = COALESCE(?, cashfree_payment_id), status = 'captured', paid_at = CURRENT_TIMESTAMP WHERE cashfree_order_id = ? AND status NOT IN ('verified', 'captured')").bind(cfId, orderId),
              env.DB.prepare("UPDATE payments SET cashfree_payment_id = COALESCE(?, cashfree_payment_id), status = 'captured' WHERE cashfree_order_id = ? AND status = 'verified'").bind(cfId, orderId),
            ]);
            const payment = await env.DB.prepare('SELECT p.search_id, sr.session_id FROM payments p JOIN searches sr ON sr.id = p.search_id WHERE p.cashfree_order_id = ?').bind(orderId).first();
            if (payment) await env.DB.prepare("UPDATE searches SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'paid'").bind(payment.search_id).run();
            if (payment && captured?.meta?.changes) await recordEvents(env, [{ kind: 'paid', sessionId: payment.session_id ?? null, searchId: payment.search_id }]);
          }
        }
        // REFUND_STATUS_WEBHOOK (refunds skill §3): the refund object arrives with flat fields and numeric
        // ids. The row is found by our refund_id; a refund the studio never issued (Cashfree dashboard, or
        // an insert lost to a crash) is added so the ledger stays complete. Re-deliveries set the same
        // status again, which is harmless. Nothing here can fail the 200.
        if (event.type === 'REFUND_STATUS_WEBHOOK') {
          const refund = event.data?.refund;
          const status = REFUND_STATUSES.has(refund?.refund_status) ? refund.refund_status : null;
          if (status && typeof refund.refund_id === 'string' && refund.refund_id) {
            const cfRefundId = refund.cf_refund_id != null ? String(refund.cf_refund_id) : null;
            try {
              const updated = await env.DB.prepare('UPDATE refunds SET status = ?, cashfree_refund_id = COALESCE(?, cashfree_refund_id), updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(status, cfRefundId, refund.refund_id).run();
              if (!updated.meta?.changes && refund.order_id) {
                const payment = await env.DB.prepare('SELECT id FROM payments WHERE cashfree_order_id = ?').bind(String(refund.order_id)).first();
                const paise = Math.round(Number(refund.refund_amount) * 100);
                if (payment && Number.isSafeInteger(paise) && paise > 0) await env.DB.prepare('INSERT OR IGNORE INTO refunds (id, payment_id, cashfree_refund_id, amount_paise, status, reason) VALUES (?, ?, ?, ?, ?, ?)').bind(refund.refund_id, payment.id, cfRefundId, paise, status, 'Recorded from the Cashfree refund webhook').run();
              }
            } catch (caught) { console.warn('refunds unavailable (is migration 0015 applied?) — refund status not recorded:', caught?.message ?? String(caught)); }
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
