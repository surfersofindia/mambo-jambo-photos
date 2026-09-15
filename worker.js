/**
 * Mambo Jambo photo API — Cloudflare Worker + D1 + R2.
 *
 * Secrets set with `wrangler secret put`:
 *   ADMIN_PASSWORD, SESSION_SECRET, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET,
 *   RAZORPAY_WEBHOOK_SECRET
 */

const encoder = new TextEncoder();
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
});
const id = () => crypto.randomUUID();
const dateAfterMinutes = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const base64url = (value) => btoa(typeof value === 'string' ? value : JSON.stringify(value))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const fromBase64url = (value) => atob(value.replace(/-/g, '+').replace(/_/g, '/'));

function cors(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = env.ALLOWED_ORIGIN || origin || '*';
  return {
    'access-control-allow-origin': allowed === '*' ? '*' : (origin === allowed ? allowed : allowed),
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
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
function same(a, b) {
  if (!a || !b || a.length !== b.length) return false;
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
  const [encoded, signature] = token.split('.');
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
function similarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return -1;
  let dot = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return dot / (Math.sqrt(aa) * Math.sqrt(bb));
}
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
async function razorpayOrder(search, env) {
  const credentials = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  const result = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { authorization: `Basic ${credentials}`, 'content-type': 'application/json' },
    body: JSON.stringify({ amount: search.price_paise, currency: search.currency, receipt: `mj_${search.id.slice(0, 28)}`, notes: { search_id: search.id } }),
  });
  if (!result.ok) throw new Error('Razorpay could not create an order. Check your live/test keys.');
  return result.json();
}

async function processFaces(env, photoId, objectKey) {
  try {
    const object = await env.PHOTOS.get(objectKey);
    if (!object) return;
    const formData = new FormData();
    formData.append('file', await object.blob(), 'image.jpg');
    
    const apiUrl = env.FACE_API_URL || 'http://localhost:8080/extract';
    const req = await fetch(apiUrl, { method: 'POST', body: formData });
    
    if (!req.ok) throw new Error(`Face API error: ${req.status}`);
    const faces = await req.json();
    
    const statements = [env.DB.prepare("UPDATE photos SET indexing_status = 'completed' WHERE id = ?").bind(photoId)];
    faces.forEach((face) => statements.push(env.DB.prepare('INSERT INTO faces (id, photo_id, embedding_json, confidence) VALUES (?, ?, ?, ?)').bind(id(), photoId, JSON.stringify(face.embedding), Number(face.confidence) || null)));
    await env.DB.batch(statements);
  } catch (err) {
    console.error('Background face extraction failed:', err);
    await env.DB.prepare("UPDATE photos SET indexing_status = 'failed' WHERE id = ?").bind(photoId).run();
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') return new Response(null, { headers: cors(request, env) });
      if (!url.pathname.startsWith('/api/')) return error('Not found', request, env, 404);

      if (request.method === 'POST' && url.pathname === '/api/admin/login') {
        const { password } = await request.json();
        if (!env.ADMIN_PASSWORD || !same(password, env.ADMIN_PASSWORD)) return error('Incorrect password.', request, env, 401);
        const token = await sign({ role: 'admin', exp: Date.now() + 8 * 60 * 60_000 }, env);
        return response({ token }, request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/sessions') {
        const sessions = await env.DB.prepare("SELECT id, title, session_date, location, price_paise, currency FROM sessions WHERE status = 'published' ORDER BY session_date DESC LIMIT 30").all();
        return response({ sessions: sessions.results }, request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/match') {
        const form = await request.formData(); 
        const sessionId = form.get('sessionId');
        const file = form.get('file');
        if (!sessionId || !(file instanceof File)) return error('A valid selfie image and session are required.', request, env);
        
        const apiUrl = env.FACE_API_URL || 'http://localhost:8080/extract';
        const apiForm = new FormData(); apiForm.append('file', file, 'selfie.jpg');
        const req = await fetch(apiUrl, { method: 'POST', body: apiForm });
        if (!req.ok) return error('Failed to detect face in selfie.', request, env, 500);
        const faceResults = await req.json();
        if (faceResults.length !== 1) return error(faceResults.length ? 'Please use a selfie with only one clearly visible face.' : 'We could not find a clear face. Try a brighter, straight-on selfie.', request, env);
        
        const embedding = faceResults[0].embedding;
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

        if (completedPhotos === 0 && pendingPhotos > 0) {
          const estMins = Math.max(2, Math.ceil((pendingPhotos * 10) / 60));
          return error(`🌊 Hang tight, legend! Our surf crew is currently doing housekeeping & sorting through the waves for this session. Please check back in ~${estMins} mins! 🤙`, request, env, 422);
        }

        const faces = await env.DB.prepare('SELECT f.photo_id, f.embedding_json FROM faces f JOIN photos p ON p.id = f.photo_id WHERE p.session_id = ?').bind(sessionId).all();
        const scores = new Map();
        for (const face of faces.results) {
          const score = similarity(embedding, JSON.parse(face.embedding_json));
          scores.set(face.photo_id, Math.max(scores.get(face.photo_id) || -1, score));
        }
        const threshold = Number(env.MATCH_THRESHOLD || 0.62);
        const matches = [...scores.entries()].filter(([, score]) => score >= threshold).sort((a, b) => b[1] - a[1]).slice(0, 80);
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
          const estMins = Math.max(2, Math.ceil((pendingPhotos * 10) / 60));
          indexingNote = `🌊 Our surf crew is still doing housekeeping on ${pendingPhotos} remaining photo(s). Try checking back in ~${estMins} mins if you don't see all your shots yet! 🤙`;
        }
        
        return response({ searchId, token, previews, count: previews.length, pricePaise: session.price_paise, currency: session.currency, indexingNote, session: { title: session.title, date: session.session_date, location: session.location } }, request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/checkout') {
        const { searchId, token } = await request.json();
        const payload = await verify(token, env);
        if (payload?.scope !== 'search' || payload.searchId !== searchId) return error('This gallery link has expired.', request, env, 401);
        const search = await env.DB.prepare("SELECT * FROM searches WHERE id = ? AND status = 'preview' AND expires_at > CURRENT_TIMESTAMP").bind(searchId).first();
        if (!search) return error('This gallery link has expired.', request, env, 410);
        if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) return error('Payments are not configured yet.', request, env, 503);
        const order = await razorpayOrder(search, env);
        await env.DB.prepare('INSERT INTO payments (id, search_id, razorpay_order_id, amount_paise, currency) VALUES (?, ?, ?, ?, ?)')
          .bind(id(), searchId, order.id, search.price_paise, search.currency).run();
        return response({ orderId: order.id, keyId: env.RAZORPAY_KEY_ID, amount: order.amount, currency: order.currency, name: 'Mambo Jambo Surf School', description: `${search.title || 'Surf'} photo pack` }, request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/payment/verify') {
        const { searchId, token, razorpay_payment_id: paymentId, razorpay_order_id: orderId, razorpay_signature: signature } = await request.json();
        const payload = await verify(token, env);
        if (payload?.scope !== 'search' || payload.searchId !== searchId) return error('This gallery link has expired.', request, env, 401);
        const payment = await env.DB.prepare('SELECT * FROM payments WHERE razorpay_order_id = ? AND search_id = ?').bind(orderId, searchId).first();
        if (!payment || !same(await hmac(`${payment.razorpay_order_id}|${paymentId}`, env.RAZORPAY_KEY_SECRET), signature)) return error('Payment verification failed.', request, env, 402);
        await env.DB.batch([
          env.DB.prepare("UPDATE payments SET razorpay_payment_id = ?, status = 'verified', paid_at = CURRENT_TIMESTAMP WHERE id = ?").bind(paymentId, payment.id),
          env.DB.prepare("UPDATE searches SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ?").bind(searchId),
        ]);
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
        const { title, date, location, pricePaise } = await request.json();
        if (!title || !date || !location || !Number.isInteger(Number(pricePaise)) || Number(pricePaise) < 100) return error('Enter a title, date, location, and price.', request, env);
        const session = { id: id(), title: title.slice(0, 80), date, location: location.slice(0, 80), price: Number(pricePaise) };
        await env.DB.prepare('INSERT INTO sessions (id, title, session_date, location, price_paise) VALUES (?, ?, ?, ?, ?)').bind(session.id, session.title, session.date, session.location, session.price).run();
        return response({ session }, request, env, 201);
      }

      const dashboard = url.pathname.match(/^\/api\/admin\/dashboard$/);
      if (request.method === 'GET' && dashboard) {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const query = `
          SELECT 
            s.id, s.title, s.session_date as date, s.location, s.status,
            COUNT(DISTINCT p.id) as total_photos,
            SUM(CASE WHEN p.indexing_status = 'completed' THEN 1 ELSE 0 END) as indexed_photos,
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
          // R2 delete can take an array of keys (up to 1000 at a time, but this handles most cases)
          const chunks = [];
          for (let i = 0; i < keysToDelete.length; i += 500) {
            chunks.push(env.PHOTOS.delete(keysToDelete.slice(i, i + 500)));
          }
          await Promise.all(chunks);
        }
        
        // Delete session from DB (cascades to photos and faces due to ON DELETE CASCADE)
        await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
        return response({ success: true }, request, env);
      }

      const reindex = url.pathname.match(/^\/api\/admin\/reindex$/);
      if (request.method === 'POST' && reindex) {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const unindexed = await env.DB.prepare("SELECT id, object_key FROM photos WHERE indexing_status != 'completed'").all();
        const results = [];
        for (const p of unindexed.results) {
          await processFaces(env, p.id, p.object_key);
          results.push(p.id);
        }
        return response({ reindexed: results.length, ids: results }, request, env);
      }

      const upload = url.pathname.match(/^\/api\/admin\/sessions\/([\w-]+)\/photos$/);
      if (request.method === 'POST' && upload) {
        if (!await requireAdmin(request, env)) return error('Sign in required.', request, env, 401);
        const sessionId = upload[1]; const session = await env.DB.prepare("SELECT id FROM sessions WHERE id = ? AND status = 'draft'").bind(sessionId).first();
        if (!session) return error('Create a draft session before uploading.', request, env, 404);
        const form = await request.formData(); const file = form.get('file'); const preview = form.get('preview');
        if (!(file instanceof File) || !(preview instanceof File) || !file.type.startsWith('image/')) return error('An image and its preview are required.', request, env);
        const photoId = id(); const filename = safeFilename(file.name); const objectKey = `sessions/${sessionId}/original/${photoId}-${filename}`; const previewKey = `sessions/${sessionId}/preview/${photoId}.jpg`;
        await Promise.all([
          env.PHOTOS.put(objectKey, file.stream(), { httpMetadata: { contentType: file.type } }),
          env.PHOTOS.put(previewKey, preview.stream(), { httpMetadata: { contentType: 'image/jpeg' } }),
        ]);
        await env.DB.prepare("INSERT INTO photos (id, session_id, object_key, preview_key, filename, content_type, indexing_status) VALUES (?, ?, ?, ?, ?, ?, 'pending')").bind(photoId, sessionId, objectKey, previewKey, filename, file.type).run();
        
        ctx.waitUntil(processFaces(env, photoId, objectKey));
        
        return response({ photoId, status: 'pending' }, request, env, 201);
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
        const raw = await request.text(); const signature = request.headers.get('x-razorpay-signature');
        if (!env.RAZORPAY_WEBHOOK_SECRET || !same(await hmac(raw, env.RAZORPAY_WEBHOOK_SECRET), signature)) return error('Invalid webhook signature.', request, env, 401);
        const event = JSON.parse(raw);
        if (['payment.captured', 'order.paid'].includes(event.event)) {
          const entity = event.payload?.payment?.entity || event.payload?.order?.entity;
          const orderId = entity?.order_id || entity?.id;
          if (orderId) await env.DB.prepare("UPDATE payments SET status = 'captured', paid_at = CURRENT_TIMESTAMP WHERE razorpay_order_id = ?").bind(orderId).run();
        }
        return response({ received: true }, request, env);
      }

      return error('Not found', request, env, 404);
    } catch (caught) {
      console.error(caught);
      return error(caught instanceof Error ? caught.message : 'Unexpected server error.', request, env, 500);
    }
  },
};
