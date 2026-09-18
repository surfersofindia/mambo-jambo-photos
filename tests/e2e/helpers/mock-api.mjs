// Route mocks for every /api/** request the site and the crew studio make. Shapes mirror worker.js today
// (GET /api/sessions, POST /api/match, /api/media/:id, /api/searches/:id/*, /api/checkout, /api/payment/verify,
// /api/health, /api/admin/*). The dev server proxies /api to the production Worker, so nothing here may fall
// through: an unknown path is answered 404 *and* recorded in `api.escaped`, which the fixture asserts is empty.
import { readFile } from 'node:fs/promises';

const ASSETS = new URL('../../../assets/', import.meta.url);

export const ADMIN_TOKEN = 'e2e-admin-token';
export const ADMIN_PASSWORD = 'crew-e2e';
export const SEARCH = { id: 'e2e-search-1', token: 'e2e-search-token', galleryToken: 'e2e-gallery-token' };
export const ORDER = { id: 'order_e2e_1', paymentSessionId: 'session_e2e_1' };

// Public sessions exactly as GET /api/sessions returns them (coverUrl is null until the crew picks a cover).
export const PUBLIC_SESSIONS = [
  { id: 'e2e-sess-1', title: 'Morning glass', session_date: '2026-09-14', location: 'Mulki Beach', price_paise: 70000, currency: 'INR', coverUrl: null, conditions: { breakName: 'Mulki left', swellFt: 4, wind: 'Offshore', tide: 'Mid rising', photographer: 'Ankith' } },
  { id: 'e2e-sess-2', title: 'Sunset session', session_date: '2026-09-12', location: 'Sasihithlu', price_paise: 70000, currency: 'INR', coverUrl: null },
  { id: 'e2e-sess-3', title: 'Dawn patrol', session_date: '2026-09-07', location: 'Kodi Bengre', price_paise: 70000, currency: 'INR', coverUrl: null },
];
// Crew dashboard rows as GET /api/admin/dashboard returns them.
// `indexing` (queue depth / ETA / grouped failures) and `conditions` + `nextDropAt` (migration 0014) are the W3-B
// contract fields the studio renders on each card; an older Worker simply omits them (see state.oldWorker).
export const dashboardSessions = () => [
  { id: 'e2e-sess-1', title: 'Morning glass', date: '2026-09-14', location: 'Mulki Beach', status: 'published', price_paise: 70000, total_photos: 128, indexed_photos: 128, pending_photos: 0, failed_photos: 0, downloads: 6, indexing: { queued: 0, processing: 0, done: 128, failed: 0, etaSeconds: null, failures: [] }, conditions: { breakName: 'River mouth', swellFt: 3.5, wind: 'offshore', tide: 'rising', photographer: 'Ankith' }, nextDropAt: '2026-09-18T01:30:00.000Z' },
  { id: 'e2e-sess-2', title: 'Sunset session', date: '2026-09-12', location: 'Sasihithlu', status: 'draft', price_paise: 70000, total_photos: 42, indexed_photos: 39, pending_photos: 0, failed_photos: 3, downloads: 0, indexing: { queued: 0, processing: 0, done: 39, failed: 3, etaSeconds: null, failures: [{ reason: 'Face service timed out', count: 2 }, { reason: 'Image could not be decoded', count: 1 }] }, conditions: null, nextDropAt: null },
];
// Per-session funnel rows as GET /api/admin/stats returns them (W2-C contract; the W2-D money strip merges by
// sessionId). One session with traffic, one nobody has searched yet — the strip reads "No searches yet" for it.
export const statsRow = (sessionId, title, searches = 0, matches = 0, checkouts = 0, unlocks = 0, downloads = 0, rupees = 0, grants = 0) =>
  ({ sessionId, title, searches, matches, zeroMatches: searches - matches, zeroMatchRate: searches ? (searches - matches) / searches : 0, checkouts, unlocks, downloads, rupees, grants });
export const sessionStats = () => ({
  sessions: [statsRow('e2e-sess-1', 'Morning glass', 12, 9, 4, 3, 6, 2100), statsRow('e2e-sess-2', 'Sunset session')],
  totals: statsRow(undefined, undefined, 12, 9, 4, 3, 6, 2100),
});
// Photos already stored in the mocked sessions (the Add-photos duplicate check compares filenames).
export const sessionPhotos = () => ({
  'e2e-sess-1': [{ id: 'e2e-old-1', filename: 'SOI_0412.jpg', width: 1600, height: 1067 }, { id: 'e2e-old-2', filename: 'SOI_0399.jpg', width: 1067, height: 1600 }],
  'e2e-sess-2': [{ id: 'e2e-old-3', filename: 'SOI_0500.jpg' }, { id: 'e2e-old-4', filename: 'SOI_0501.jpg', width: 1600, height: 1067 }, { id: 'e2e-old-5', filename: 'SOI_0502.jpg', width: 1600, height: 1067 }],
});
// Support lookup (GET /api/admin/lookup) and settlements (GET /api/admin/settlements) as the W3-B contract shapes them;
// phones come back masked. state.lookup / state.settlements = null answer 404 (an older Worker).
export const supportLookup = origin => ({
  phone: '98xxxxxx21',
  searches: [{ id: 'e2e-search-1', sessionId: 'e2e-sess-1', sessionTitle: 'Morning glass', createdAt: '2026-09-17T02:10:00.000Z', status: 'paid', matchedCount: 9, hiddenCount: 1, colourCount: 0, paidAt: '2026-09-17T02:14:00.000Z', expiresAt: '2026-09-17T03:10:00.000Z', galleryLinkExpiresAt: '2026-10-17T02:14:00.000Z', photos: PHOTO_IDS.slice(0, 6).map((photoId, index) => ({ photoId, thumbUrl: mediaLink(origin, photoId, 'thumb'), hidden: index === 2 })) }],
  payments: [{ id: 'e2e-pay-1', searchId: 'e2e-search-1', orderId: 'mj-e2e-pay-1', cfPaymentId: '5114910812', amountPaise: 70000, status: 'captured', createdAt: '2026-09-17T02:12:00.000Z', paidAt: '2026-09-17T02:14:00.000Z', refundedPaise: 0, refundStatus: null }],
  notify: [{ searchId: 'e2e-search-1', createdAt: '2026-09-17T02:11:00.000Z', notifiedAt: null }],
});
export const settlementsBody = () => ({
  settlements: [{ id: 'stl-1', utr: 'AXISCN0123456789', amountPaise: 136500, settledAt: '2026-09-15T04:30:00.000Z', from: '2026-09-13', to: '2026-09-14', status: 'settled' }, { id: 'stl-2', utr: 'AXISCN0123457001', amountPaise: 68250, settledAt: '2026-09-17T04:30:00.000Z', from: '2026-09-15', to: '2026-09-16', status: 'settled' }],
  unreconciled: ['e2e-pay-1'],
});
// Review queues (empty by default; W3-C's specs set state.verifyQueue / state.linkQueue to render cards).
export const reviewPair = (id, similarityPct) => ({ id, sessionTitle: 'Morning glass', similarityPct, photo1: { id: `${id}-a`, filename: 'SOI_0412.jpg', url: '/assets/brand-surf-portrait.webp', bboxNorm: [12, 28, 44, 36] }, photo2: { id: `${id}-b`, filename: 'SOI_0418.jpg', url: '/assets/mambo-jambo-surf-session-portrait.jpg', bboxNorm: [10, 30, 40, 34] } });
export const reviewLink = (id, scorePct, linkType = 'appearance') => ({ id, linkType, scorePct, sessionTitle: 'Morning glass', photo1: { id: `${id}-a`, filename: 'SOI_0500.jpg', url: '/assets/brand-surf-wide.webp' }, photo2: { id: `${id}-b`, filename: 'SOI_0501.jpg', url: '/assets/mambo-jambo-surf-session.jpg' } });
// Preview photos served from the repo's own assets through /api/media/<id> (app.js only accepts that path).
export const PHOTO_FILES = ['backpackers-01.webp', 'backpackers-04.webp', 'backpackers-05.webp', 'backpackers-06.webp', 'backpackers-07.webp', 'backpackers-10.webp', 'backpackers-12.webp', 'mambo-jambo-surf-session.jpg', 'mambo-jambo-surf-session-portrait.jpg'];
export const PHOTO_IDS = PHOTO_FILES.map((_, index) => `e2e-photo-${String(index + 1).padStart(2, '0')}`);

const assetCache = new Map();
export async function asset(name) {
  if (!assetCache.has(name)) assetCache.set(name, readFile(new URL(name, ASSETS)));
  return assetCache.get(name);
}
const contentType = name => name.endsWith('.webp') ? 'image/webp' : name.endsWith('.png') ? 'image/png' : 'image/jpeg';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS' };
const json = (route, body, status = 200) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });

const mediaLink = (origin, id, variant) => `${origin}/api/media/${id}?variant=${variant}&token=e2e-media-${variant}`;
// Pixel size of each preview photo (W2-C adds `width`/`height` to every photo object; null when unknown). The real dimensions of the
// assets above (portrait 3:4, landscape 4:3, 16:9, 4:5) so W3-A's uncropped tiles show a genuine contact sheet; the seventh is a
// pre-0012 photo with no stored size and keeps the 4:3 box.
export const PHOTO_SIZES = [[900, 1201], [900, 1201], [900, 675], [900, 675], [900, 677], [900, 1201], [null, null], [2400, 1350], [900, 1125]];
const dims = index => ({ width: PHOTO_SIZES[index]?.[0] ?? null, height: PHOTO_SIZES[index]?.[1] ?? null });
export const previewList = origin => PHOTO_IDS.map((photoId, index) => ({ photoId, score: 96 - index * 3, url: mediaLink(origin, photoId, 'preview'), thumbUrl: mediaLink(origin, photoId, 'thumb'), ...dims(index) }));
export const accessList = origin => PHOTO_IDS.map((photoId, index) => { const url = mediaLink(origin, photoId, 'original'); return { photoId, url, downloadUrl: `${url}&download=1`, thumbUrl: mediaLink(origin, photoId, 'thumb'), ...dims(index) }; });
const summary = session => ({ title: session.title, date: session.session_date, location: session.location });

// A multipart body is binary (the selfie), so only the text field we need is picked out of it.
function multipartField(buffer, name) {
  const text = buffer ? buffer.toString('latin1') : '';
  return text.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`))?.[1] ?? null;
}

// The format of a preview or thumb the studio sends, from its first bytes — JPEG or WebP (W4-A), like
// the Worker's own sniff. Anything else is not an image the Worker would take.
export function imageFormat(bytes) {
  if (!bytes || bytes.length < 2) return null;
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}
// Parse the streaming upload body admin.js sends: [uint32 LE preview length][preview JPEG/WebP][original bytes].
export function parseFramedUpload(buffer) {
  if (!buffer || buffer.length < 4) return { error: 'The upload is incomplete.' };
  const previewLength = buffer.readUInt32LE(0);
  if (!previewLength || 4 + previewLength > buffer.length) return { error: 'The upload preview is invalid.' };
  const previewFormat = imageFormat(buffer.subarray(4, 4 + previewLength));
  if (!previewFormat) return { error: 'The upload preview is invalid.' };
  return { previewLength, originalLength: buffer.length - 4 - previewLength, previewFormat, previewIsJpeg: previewFormat === 'jpeg' };
}

/**
 * Install the mock on a BrowserContext. Returns the handle the tests read and tweak:
 *   state.matchMode  'photos' | 'empty' | '429' — what POST /api/match answers with ('429' → retry-after 420 s)
 *   state.nextDropAt ISO string or null — the top-level nextDropAt on GET /api/sessions (W3-B contract; landing "lands by" line)
 *   state.guest      per-route mode for the wave-3 guest endpoints: { hide: 'ok'|404, colour: 'ok'|'empty'|404|429, notify: 'ok'|404 }
 *   state.dashboard  the crew session list (mutable; deletes/creates/edits are applied to it)
 *   state.photos     stored photos per session id (mutable)
 *   state.stats      the GET /api/admin/stats body (set to { sessions: [], totals: {}, unmigrated: true } or null → 404 to test the strip hiding)
 *   state.uploads    every upload the studio sent — streaming ({ sessionId, filename, type, width, height, onDuplicate, previewLength, originalLength })
 *                    and direct-to-R2 ({ direct: true, key, photoId, … }); `route` says which one it was
 *   state.direct     W4-A: false (default) → POST …/uploads/presign answers 503 { fallback: 'stream' }, so every existing spec keeps
 *                    using the streaming route; true → presigned PUTs are minted and the mocked bucket below stores them
 *   state.r2         the mocked bucket: { objects: Map<key, bytes>, puts: [], fail: null } — `fail` is a filename whose PUT is
 *                    answered 500 once (the studio then streams that one file), 'all' refuses every PUT
 *   state.dropUploads filenames whose next upload is stored and then answered with a dropped connection (a lost 201 — FIX-C)
 *   state.dropCompletes the same for a direct upload's `complete` call (W4-A): the photo is registered, the reply never arrives
 *   state.media      every GET /api/media/:id served, as { id, variant, download } (W4-A: "Regenerate previews" must fetch each
 *                    original exactly once through its crew link); these are not added to api.calls, so call counts elsewhere hold
 *   state.refuseUploads filenames whose next upload is refused with a 400 and not stored (drives the "Retry failed" button — FIX-C)
 *   state.lateUnauthorised { filename, ms } — that upload's 401 (stale token) is held back for `ms`, so it lands after a re-sign-in (FIX-C)
 *   state.expireAfterCreate a token string: the crew's token expires (the mock switches to this one) the moment a session is created (FIX-C)
 *   api.calls        [{ method, path, query, body }] in order; api.escaped — un-mocked requests (must stay empty)
 */
export async function installApiMock(context, { origin, state: overrides = {} } = {}) {
  const state = { matchMode: 'photos', nextDropAt: null, guest: { hide: 'ok', colour: 'ok', notify: 'ok' }, password: ADMIN_PASSWORD, token: ADMIN_TOKEN, dashboard: dashboardSessions(), photos: sessionPhotos(),   // W3-C additions: covers (session id → photo id), needsCover (new Worker's 409 until a cover or noCover:true),
  // bulkRoute (false → 404, the studio falls back), lookup / settlements bodies (null → 404), verifyQueue / linkQueue,
  // oldWorker (strips indexing/conditions from the dashboard rows), refunds / grants / resends recorded as they happen.
me: null, crew: null, crewSharedLogin: false, audit: null, totpCode: '123456', needsTotp: false,   // W4-C: null = a Worker without the crew-account routes
stats: sessionStats(), uploads: [], dropUploads: [], dropCompletes: [], refuseUploads: [], lateUnauthorised: null, expireAfterCreate: null, thumbs: [], nextPhoto: 1, direct: false, r2: { objects: new Map(), puts: [], fail: null }, previews: [], media: [], covers: {}, needsCover: false, bulkRoute: true, lookup: supportLookup(origin || 'http://127.0.0.1'), settlements: settlementsBody(), verifyQueue: [], linkQueue: [], oldWorker: false, refunds: [], grants: [], resends: [], ...overrides };
  const api = { state, calls: [], escaped: [] };
  const record = (request, url, extra = {}) => { const call = { method: request.method(), path: url.pathname, query: Object.fromEntries(url.searchParams), ...extra }; api.calls.push(call); return call; };
  const jsonBody = request => { try { return JSON.parse(request.postData() || 'null'); } catch { return null; } };
  const authorised = request => (request.headers().authorization || '') === `Bearer ${state.token}`;
  const photoRow = (base, sessionId, photo) => ({ id: photo.id, filename: photo.filename, indexing_status: photo.indexing_status || 'completed', created_at: '2026-09-14T06:00:00.000Z', indexing_error: photo.indexing_error || null, face_count: 1, thumb_key: null, previewUrl: mediaLink(base, photo.id, 'preview'), thumbUrl: null, originalUrl: mediaLink(base, photo.id, 'original'), width: photo.width ?? null, height: photo.height ?? null });

  // The Cashfree SDK never loads in tests: app.js turns the failed <script> into a visible error, and the SDK
  // stub in public.spec.mjs covers the paid path. Fonts (Google or self-hosted) are left alone.
  await context.route('https://sdk.cashfree.com/**', route => route.abort('blockedbyclient'));

  // The mocked R2 bucket (W4-A direct uploads). The presigned URL below points here, so an original
  // PUT straight from the browser never leaves the test — and `state.r2.fail` makes the bucket refuse
  // one file (or all of them) to exercise the per-file fallback to the streaming route.
  await context.route('https://*.r2.cloudflarestorage.com/**', route => {
    const request = route.request(); const url = new URL(request.url());
    const key = url.pathname.split('/').slice(2).map(decodeURIComponent).join('/');
    const body = request.postDataBuffer();
    const put = { key, method: request.method(), bytes: body ? body.length : 0, contentType: request.headers()['content-type'] || '', authorization: request.headers().authorization || null, signed: url.searchParams.get('X-Amz-Signature') };
    state.r2.puts.push(put);
    if (state.r2.fail === 'all' || (state.r2.fail && key.endsWith(state.r2.fail))) { if (state.r2.fail !== 'all') state.r2.fail = null; return route.fulfill({ status: 500, headers: cors, body: '<Error>InternalError</Error>' }); }
    state.r2.objects.set(key, put);
    return route.fulfill({ status: 200, headers: { ...cors, etag: '"e2e"' }, body: '' });
  });

  await context.route('**/api/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname; const method = request.method();
    const base = origin || url.origin;
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });

    // ── public ────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/health') { record(request, url); return json(route, { ok: true, checks: { db: 'ok', r2: 'ok', face: 'skipped' }, migrations: { adminSessions: true, rateLimits: true }, time: '2026-09-17T04:00:00.000Z' }); }
    if (method === 'GET' && path === '/api/sessions') { record(request, url); return json(route, { sessions: PUBLIC_SESSIONS, nextDropAt: state.nextDropAt }); }
    const media = path.match(/^\/api\/media\/([\w-]+)$/);
    if (method === 'GET' && media) {
      state.media.push({ id: media[1], variant: url.searchParams.get('variant'), download: url.searchParams.get('download') === '1' });
      const index = PHOTO_IDS.indexOf(media[1]);
      const file = index >= 0 ? PHOTO_FILES[index] : 'mambo-jambo-surf-session.jpg';   // crew photo tiles reuse one asset
      const headers = { ...cors, 'content-type': contentType(file), 'cache-control': 'private, max-age=600' };
      if (url.searchParams.get('download') === '1') headers['content-disposition'] = `attachment; filename="${file}"`;
      return route.fulfill({ status: 200, headers, body: await asset(file) });
    }
    if (method === 'POST' && path === '/api/match') {
      const buffer = request.postDataBuffer();
      const sessionId = multipartField(buffer, 'sessionId'); const consent = multipartField(buffer, 'consent');
      // Chromium hands Playwright the multipart text parts but not the file bytes, so the selfie is checked by its part header.
      const file = (buffer ? buffer.toString('latin1') : '').match(/name="file"; filename="([^"]*)"\r\nContent-Type: ([\w/+-]+)/i);
      record(request, url, { body: { sessionId, consent, file: file ? { name: file[1], type: file[2] } : null, multipart: /^multipart\/form-data; boundary=/.test(request.headers()['content-type'] || '') } });
      if (consent !== 'true') return json(route, { error: 'Your consent is required for face matching.' }, 400);
      const session = PUBLIC_SESSIONS.find(item => item.id === sessionId);
      if (!session) return json(route, { error: 'That session is unavailable.' }, 404);
      await new Promise(resolve => setTimeout(resolve, 250));   // a search is never instant; the matching stage must render
      if (state.matchMode === '429') return route.fulfill({ status: 429, headers: { ...cors, 'content-type': 'application/json', 'retry-after': '420' }, body: JSON.stringify({ error: 'You’ve searched a lot in a short while. Try again in 7 minutes.' }) });
      const previews = state.matchMode === 'empty' ? [] : previewList(base);
      return json(route, { searchId: SEARCH.id, token: SEARCH.token, previews, count: previews.length, pricePaise: session.price_paise, currency: session.currency, indexingNote: null, session: summary(session) });
    }
    const searches = path.match(/^\/api\/searches\/([\w-]+)\/(previews|access|download)$/);
    if (method === 'GET' && searches) {
      record(request, url);
      if (searches[1] !== SEARCH.id || ![SEARCH.token, SEARCH.galleryToken].includes(url.searchParams.get('token'))) return json(route, { error: 'This gallery link has expired.' }, 401);
      if (searches[2] === 'previews') return json(route, { photos: previewList(base), session: summary(PUBLIC_SESSIONS[0]) });
      if (searches[2] === 'access') return json(route, { unlocked: true, photos: accessList(base), galleryToken: SEARCH.galleryToken, session: summary(PUBLIC_SESSIONS[0]) });
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="surfers-of-india-2026-09-14-mulki-beach.zip"', 'cache-control': 'no-store' }, body: Buffer.from('PK\x05\x06' + '\x00'.repeat(18), 'latin1') });
    }
    // ── wave-3 guest endpoints (W3-B contract; the guest page must also cope with 404 while they are not deployed) ──
    const guest = path.match(/^\/api\/searches\/([\w-]+)\/(hide|colour|notify)$/);
    if (method === 'POST' && guest) {
      const body = jsonBody(request); record(request, url, { body });
      const mode = state.guest[guest[2]];
      if (mode === 404) return json(route, { error: 'Not found.' }, 404);
      if (guest[1] !== SEARCH.id || body?.token !== SEARCH.token) return json(route, { error: 'This gallery link has expired.' }, 401);
      if (guest[2] === 'hide') return json(route, { ok: true, remaining: PHOTO_IDS.length - 1 });
      if (guest[2] === 'notify') return typeof body.phone === 'string' && /^[6-9]\d{9}$/.test(body.phone) ? json(route, { ok: true }) : json(route, { error: 'Enter a valid 10-digit mobile number.' }, 400);
      if (mode === 429) return route.fulfill({ status: 429, headers: { ...cors, 'content-type': 'application/json', 'retry-after': '300' }, body: JSON.stringify({ error: 'Too many colour searches. Try again in 5 minutes.' }) });
      if (!Number.isInteger(body.hue) || body.hue < 0 || body.hue > 359 || !['vivid', 'muted', 'any'].includes(body.tone)) return json(route, { error: 'Pick a colour.' }, 400);
      const session = PUBLIC_SESSIONS[0]; const previews = mode === 'empty' ? [] : previewList(base).slice(2, 6);   // colour-ranked: a different, shorter list
      await new Promise(resolve => setTimeout(resolve, 250));
      return json(route, { searchId: SEARCH.id, token: SEARCH.token, previews, count: previews.length, pricePaise: session.price_paise, currency: session.currency, indexingNote: null, session: summary(session), mode: 'colour' });
    }
    if (method === 'POST' && path === '/api/checkout') {
      const body = jsonBody(request); record(request, url, { body });
      if (body?.searchId !== SEARCH.id || body?.token !== SEARCH.token) return json(route, { error: 'This gallery link has expired.' }, 401);
      if (typeof body.phone !== 'string' || !/^[6-9]\d{9}$/.test(body.phone)) return json(route, { error: 'Enter a valid 10-digit mobile number.' }, 400);
      return json(route, { orderId: ORDER.id, paymentSessionId: ORDER.paymentSessionId, mode: 'sandbox', amount: 700, currency: 'INR' });
    }
    if (method === 'POST' && path === '/api/payment/verify') {
      const body = jsonBody(request); record(request, url, { body });
      if (body?.searchId !== SEARCH.id || body?.token !== SEARCH.token) return json(route, { error: 'This gallery link has expired.' }, 401);
      if (body.orderId !== ORDER.id) return json(route, { error: 'Payment verification failed.' }, 402);
      return json(route, { unlocked: true, photos: accessList(base) });
    }

    // ── crew ──────────────────────────────────────────────────────────────
    if (method === 'POST' && path === '/api/admin/login') {
      const body = jsonBody(request); record(request, url, { body: { name: body?.name ?? null, password: body?.password ? '***' : null, code: body?.code ?? null } });
      if (body?.password !== state.password) return json(route, { error: 'Incorrect password.' }, 401);
      // W4-C: with state.needsTotp the mock behaves like an account whose authenticator is on.
      if (state.needsTotp && !body?.code) return json(route, { error: 'Enter the 6-digit code from your authenticator app.', needsTotp: true }, 401);
      if (state.needsTotp && body.code !== state.totpCode) return json(route, { error: 'That code did not match. Try the next one.', needsTotp: true }, 401);
      return json(route, { token: state.token, ...(state.me ? { user: state.me.user, canManageUsers: state.me.canManageUsers, sharedLogin: state.me.sharedLogin, role: state.me.role } : {}) });
    }
    if (path.startsWith('/api/admin/')) {
      if (!authorised(request)) {
        // The filename is in the query for a streaming upload and in the JSON body for a presign (W4-A),
        // so both are recorded and `lateUnauthorised` can hold either one back past a re-sign-in.
        const body = method === 'POST' ? jsonBody(request) : null;
        record(request, url, { unauthorised: true, body });
        const filename = url.searchParams.get('filename') || body?.filename || null;
        if (state.lateUnauthorised && method === 'POST' && (path.endsWith('/photos') || path.endsWith('/uploads/presign')) && filename === state.lateUnauthorised.filename) { const { ms } = state.lateUnauthorised; state.lateUnauthorised = null; await new Promise(resolve => setTimeout(resolve, ms)); }
        return json(route, { error: 'Sign in required.' }, 401);
      }
      if (method === 'POST' && path === '/api/admin/logout') { record(request, url); return json(route, { ok: true }); }
      if (method === 'GET' && path === '/api/admin/dashboard') { record(request, url); return json(route, { sessions: state.oldWorker ? state.dashboard.map(({ indexing, conditions, nextDropAt, ...row }) => row) : state.dashboard }); }
      // ── W3-B / W3-C contract routes ──
      let hit;
      // ── W4-C crew accounts, TOTP and the audit log (migration 0016) ──
      // Every one of these is null by default, i.e. a Worker without the routes: the studio hides its
      // Crew button and nothing else changes, so the other specs and their baselines are untouched.
      if (method === 'GET' && path === '/api/admin/me') { record(request, url); return state.me ? json(route, state.me) : json(route, { error: 'Not found' }, 404); }
      if (method === 'GET' && path === '/api/admin/users') { record(request, url); return state.crew ? json(route, { users: state.crew, sharedLogin: Boolean(state.crewSharedLogin) }) : json(route, { error: 'Not found' }, 404); }
      if (method === 'POST' && path === '/api/admin/users') {
        const body = jsonBody(request); record(request, url, { body: { ...body, password: body?.password ? '***' : null } });
        if (!state.crew) return json(route, { error: 'Not found' }, 404);
        if (state.crew.some(user => user.name.toLowerCase() === String(body?.name || '').toLowerCase())) return json(route, { error: 'Someone already uses that name.' }, 409);
        const user = { id: `crew-${state.crew.length + 1}`, name: body.name, role: body.role, totpEnabled: false, createdAt: '2026-09-17T06:00:00.000Z', lastLoginAt: null, disabledAt: null };
        state.crew.push(user);
        return json(route, { user, totp: { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', uri: `otpauth://totp/SOI%20Crew:${encodeURIComponent(user.name)}?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=SOI%20Crew&algorithm=SHA1&digits=6&period=30` } }, 201);
      }
      if ((hit = path.match(/^\/api\/admin\/users\/([\w-]+)\/(totp\/verify|disable|reset-password)$/)) && method === 'POST') {
        const body = jsonBody(request); record(request, url, { body: hit[2] === 'reset-password' ? { password: '***' } : body });
        const user = (state.crew || []).find(row => row.id === hit[1]);
        if (!user) return json(route, { error: 'That crew account no longer exists.' }, 404);
        if (hit[2] === 'totp/verify') { if (body?.code !== state.totpCode) return json(route, { error: 'That code did not match. Try the next one.' }, 400); user.totpEnabled = true; }
        if (hit[2] === 'disable') user.disabledAt = '2026-09-17T07:00:00.000Z';
        return json(route, { ok: true, user });
      }
      if (method === 'GET' && path === '/api/admin/audit') { record(request, url); return state.audit ? json(route, { entries: state.audit, nextBefore: null }) : json(route, { error: 'Not found' }, 404); }
      if (method === 'GET' && path === '/api/admin/lookup') { record(request, url); return state.lookup ? json(route, state.lookup) : json(route, { error: 'Not found' }, 404); }
      if (method === 'GET' && path === '/api/admin/settlements') { record(request, url); return state.settlements ? json(route, state.settlements) : json(route, { error: 'Not found' }, 404); }
      if ((hit = path.match(/^\/api\/admin\/searches\/([\w-]+)\/(resend|grant)$/)) && method === 'POST') {
        const body = jsonBody(request); record(request, url, { body });
        if (!state.lookup) return json(route, { error: 'Not found' }, 404);
        if (hit[2] === 'grant' && !body?.reason) return json(route, { error: 'A reason is required.' }, 400);
        const link = `https://photos.surfersofindia.com/?search=${hit[1]}&gallery=e2e-${hit[2]}-token`;
        (hit[2] === 'grant' ? state.grants : state.resends).push({ searchId: hit[1], reason: body?.reason });
        return json(route, { ok: true, link, expiresAt: '2026-10-17T04:00:00.000Z' });
      }
      if ((hit = path.match(/^\/api\/admin\/payments\/([\w-]+)\/refund$/)) && method === 'POST') {
        const body = jsonBody(request); record(request, url, { body });
        if (!state.lookup) return json(route, { error: 'Not found' }, 404);
        if (!body?.reason) return json(route, { error: 'A reason is required.' }, 400);
        state.refunds.push({ paymentId: hit[1], ...body });
        return json(route, { ok: true, refund: { id: `rf-${state.refunds.length}`, paymentId: hit[1], amountPaise: body.amountPaise || 70000, status: 'PENDING' } });
      }
      if (method === 'POST' && path === '/api/admin/photos/bulk') {
        const body = jsonBody(request); record(request, url, { body });
        if (!state.bulkRoute) return json(route, { error: 'Not found' }, 404);
        const ids = Array.isArray(body?.photoIds) ? body.photoIds : [];
        if (!ids.length || ids.length > 200 || !['delete', 'reindex', 'move', 'cover'].includes(body?.action)) return json(route, { error: 'Choose an action and up to 200 photos.' }, 400);
        const failed = []; let affected = 0;
        for (const id of ids) {
          const sessionId = Object.keys(state.photos).find(key => state.photos[key].some(photo => photo.id === id));
          if (!sessionId) { failed.push({ photoId: id, error: 'Photo not found.' }); continue; }
          const photo = state.photos[sessionId].find(item => item.id === id);
          if (body.action === 'delete') { state.photos[sessionId] = state.photos[sessionId].filter(item => item !== photo); const row = state.dashboard.find(session => session.id === sessionId); if (row) row.total_photos -= 1; }
          if (body.action === 'move') { if (!state.photos[body.targetSessionId]) { failed.push({ photoId: id, error: 'Target session not found.' }); continue; } state.photos[sessionId] = state.photos[sessionId].filter(item => item !== photo); state.photos[body.targetSessionId].push(photo); }
          if (body.action === 'reindex') photo.indexing_status = 'pending';
          if (body.action === 'cover' && id === ids[0]) state.covers[sessionId] = id;
          affected += 1;
        }
        return json(route, { ok: true, affected, failed });
      }
      if (method === 'GET' && path === '/api/admin/stats') { record(request, url); return state.stats ? json(route, state.stats) : json(route, { error: 'Not found.' }, 404); }
      if (method === 'POST' && path === '/api/admin/undo-review') { const body = jsonBody(request); record(request, url, { body }); return json(route, { error: 'Too late to undo — the queue moved on.' }, 409); }
      if (method === 'POST' && path === '/api/admin/sessions') {
        const body = jsonBody(request); record(request, url, { body });
        const id = `e2e-new-${state.dashboard.length + 1}`;
        state.dashboard.unshift({ id, title: body.title, date: body.date, location: body.location, status: 'draft', price_paise: body.pricePaise, total_photos: 0, indexed_photos: 0, pending_photos: 0, failed_photos: 0, downloads: 0, conditions: 'breakName' in body ? { breakName: body.breakName, swellFt: body.swellFt, wind: body.wind, tide: body.tide, photographer: body.photographer } : null, nextDropAt: body.nextDropAt ?? null });
        state.photos[id] = [];
        if (state.expireAfterCreate) { state.token = state.expireAfterCreate; state.expireAfterCreate = null; }   // every upload of this batch now carries a stale token
        return json(route, { session: { id, title: body.title, date: body.date, location: body.location, price: body.pricePaise } }, 201);
      }
      let match;
      // W4-A direct-to-R2: presign (503 { fallback: 'stream' } unless state.direct) and complete.
      if ((match = path.match(/^\/api\/admin\/sessions\/([\w-]+)\/uploads\/presign$/)) && method === 'POST') {
        const body = jsonBody(request); record(request, url, { body });
        if (!state.direct) return json(route, { error: 'Direct uploads are not configured on this Worker.', fallback: 'stream' }, 503);
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(body?.contentType)) return json(route, { error: 'Choose a JPG, PNG or WebP photo.' }, 400);
        const photoId = `e2e-direct-${state.nextPhoto++}`;
        const key = `sessions/${match[1]}/original/${photoId}-${String(body.filename || 'photo.jpg').replace(/[^a-zA-Z0-9._-]/g, '-')}`;
        return json(route, { uploadUrl: `https://acct.r2.cloudflarestorage.com/mambo-jambo-photos/${key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=e2e`, method: 'PUT', key, photoId, expiresAt: '2026-09-17T04:15:00.000Z', headers: { 'content-type': body.contentType } }, 201);
      }
      if ((match = path.match(/^\/api\/admin\/sessions\/([\w-]+)\/uploads\/complete$/)) && method === 'POST') {
        const sessionId = match[1]; const framed = parseFramedUpload(request.postDataBuffer());
        const key = url.searchParams.get('key') || ''; const photoId = url.searchParams.get('photoId') || '';
        const upload = { direct: true, route: 'complete', sessionId, key, photoId, filename: url.searchParams.get('filename'), type: url.searchParams.get('contentType'), width: url.searchParams.get('width'), height: url.searchParams.get('height'), onDuplicate: url.searchParams.get('onDuplicate'), ...framed, thumbLength: request.postDataBuffer() ? request.postDataBuffer().length - 4 - (framed.previewLength || 0) : 0 };
        state.uploads.push(upload); record(request, url, { body: upload });
        if (framed.error) return json(route, { error: framed.error }, 400);
        if (!state.r2.objects.has(key)) return json(route, { error: 'The photo never reached storage — it will be sent again.', missing: true }, 404);
        const stored = state.photos[sessionId] || (state.photos[sessionId] = []);
        const existing = stored.filter(photo => photo.filename.toLowerCase() === (upload.filename || '').toLowerCase());
        let name = upload.filename, duplicate = null, replaced = 0;
        if (existing.length && upload.onDuplicate === 'skip') { state.r2.objects.delete(key); return json(route, { skipped: true, filename: name }); }
        if (existing.length && upload.onDuplicate === 'rename') { duplicate = 'renamed'; name = name.replace(/(\.[^.]*)?$/, `-${existing.length + 1}$1`); }
        if (existing.length && upload.onDuplicate === 'replace') { duplicate = 'replaced'; replaced = existing.length; state.photos[sessionId] = stored.filter(photo => !existing.includes(photo)); }
        state.photos[sessionId].push({ id: photoId, filename: name });
        const row = state.dashboard.find(session => session.id === sessionId); if (row) { row.total_photos += 1; row.pending_photos += 1; }
        // A lost reply: the photo is registered (above) but the studio never hears so — once per listed filename.
        const dropAt = state.dropCompletes.indexOf(upload.filename);
        if (dropAt >= 0) { state.dropCompletes.splice(dropAt, 1); return route.abort('connectionreset'); }
        return json(route, { photoId, filename: name, status: 'pending', duplicate, replaced, thumb: upload.thumbLength > 0 }, 201);
      }
      // W4-A "Regenerate previews": the studio PUTs a freshly rendered preview for a photo.
      if ((match = path.match(/^\/api\/admin\/photos\/([\w-]+)\/preview$/)) && method === 'PUT') {
        const body = request.postDataBuffer(); const format = imageFormat(body);
        state.previews.push({ photoId: match[1], bytes: body ? body.length : 0, format, width: url.searchParams.get('width'), height: url.searchParams.get('height') });
        record(request, url, { body: { bytes: body ? body.length : 0, format } });
        if (!format) return json(route, { error: 'The preview must be a JPEG or WebP.' }, 400);
        return json(route, { photoId: match[1], preview: true, key: `sessions/e2e/preview/${match[1]}.${format === 'webp' ? 'webp' : 'jpg'}` });
      }
      if ((match = path.match(/^\/api\/admin\/sessions\/([\w-]+)\/photos$/)) && method === 'POST') {
        const sessionId = match[1]; const framed = parseFramedUpload(request.postDataBuffer());
        const upload = { route: 'stream', sessionId, filename: url.searchParams.get('filename'), type: url.searchParams.get('type'), width: url.searchParams.get('width'), height: url.searchParams.get('height'), onDuplicate: url.searchParams.get('onDuplicate'), contentType: request.headers()['content-type'] || '', ...framed };
        state.uploads.push(upload); record(request, url, { body: upload });
        if (framed.error) return json(route, { error: framed.error }, 400);
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(upload.type)) return json(route, { error: 'An image and its preview are required.' }, 400);
        const refuseAt = state.refuseUploads.indexOf(upload.filename);
        if (refuseAt >= 0) { state.refuseUploads.splice(refuseAt, 1); return json(route, { error: 'The photo service hiccuped.' }, 400); }
        const stored = state.photos[sessionId] || (state.photos[sessionId] = []);
        const existing = stored.filter(photo => photo.filename.toLowerCase() === (upload.filename || '').toLowerCase());
        let name = upload.filename, duplicate = null, replaced = 0;
        if (existing.length && upload.onDuplicate === 'skip') return json(route, { skipped: true, filename: name });
        if (existing.length && upload.onDuplicate === 'rename') { duplicate = 'renamed'; name = name.replace(/(\.[^.]*)?$/, `-${existing.length + 1}$1`); }
        if (existing.length && upload.onDuplicate === 'replace') { duplicate = 'replaced'; replaced = existing.length; state.photos[sessionId] = stored.filter(photo => !existing.includes(photo)); }
        const photoId = `e2e-up-${state.nextPhoto++}`;
        state.photos[sessionId].push({ id: photoId, filename: name });
        const row = state.dashboard.find(session => session.id === sessionId); if (row) { row.total_photos += 1; row.pending_photos += 1; }
        await new Promise(resolve => setTimeout(resolve, 120));
        // A lost reply: the photo is stored (above) but the crew's browser never hears so — once per listed filename.
        const dropAt = state.dropUploads.indexOf(upload.filename);
        if (dropAt >= 0) { state.dropUploads.splice(dropAt, 1); return route.abort('connectionreset'); }
        return json(route, { photoId, filename: name, status: 'pending', duplicate, replaced }, 201);
      }
      if ((match = path.match(/^\/api\/admin\/photos\/([\w-]+)\/thumb$/)) && method === 'POST') {
        const body = request.postDataBuffer(); const format = imageFormat(body); const isJpeg = format === 'jpeg';
        state.thumbs.push({ photoId: match[1], bytes: body ? body.length : 0, isJpeg, format }); record(request, url, { body: { bytes: body ? body.length : 0, format } });
        if (!format) return json(route, { error: 'The thumbnail must be a JPEG or WebP.' }, 400);
        return json(route, { photoId: match[1], thumb: true }, 201);
      }
      if ((match = path.match(/^\/api\/admin\/sessions\/([\w-]+)\/publish$/)) && method === 'POST') {
        const body = jsonBody(request); record(request, url, { body });
        const row = state.dashboard.find(session => session.id === match[1]);
        if (!row) return json(route, { error: 'Session not found.' }, 404);
        if (!(state.photos[match[1]] || []).length) return json(route, { error: 'Upload at least one photo before publishing.' }, 400);
        if (state.needsCover && !state.covers[match[1]] && body?.noCover !== true) return json(route, { error: 'Pick a cover photo or publish without one.', needsCover: true }, 409);   // the new Worker's cover step
        row.status = 'published';
        return json(route, { published: true });
      }
      if ((match = path.match(/^\/api\/admin\/sessions\/([\w-]+)\/photos$/)) && method === 'GET') {
        record(request, url);
        return json(route, { photos: (state.photos[match[1]] || []).map(photo => photoRow(base, match[1], photo)), coverPhotoId: state.covers[match[1]] || null });
      }
      if ((match = path.match(/^\/api\/admin\/sessions\/([\w-]+)\/reindex$/)) && method === 'POST') { record(request, url); return json(route, { queued: 0, alreadyQueued: 0, failed: 0 }, 202); }
      if ((match = path.match(/^\/api\/admin\/sessions\/([\w-]+)$/)) && method === 'DELETE') {
        record(request, url);
        const index = state.dashboard.findIndex(session => session.id === match[1]);
        if (index < 0) return json(route, { error: 'Session not found.' }, 404);
        state.dashboard.splice(index, 1); delete state.photos[match[1]];
        return json(route, { success: true });
      }
      if ((match = path.match(/^\/api\/admin\/sessions\/([\w-]+)$/)) && method === 'PUT') {
        const body = jsonBody(request); record(request, url, { body });
        const row = state.dashboard.find(session => session.id === match[1]);
        if (!row) return json(route, { error: 'Session not found.' }, 404);
        if (body.title) row.title = body.title.trim(); if (body.date) row.date = body.date; if (body.location) row.location = body.location.trim();
        if (body.pricePaise) row.price_paise = Number(body.pricePaise); if (body.status) row.status = body.status;
        if (body.coverPhotoId !== undefined) { if (body.coverPhotoId) state.covers[match[1]] = body.coverPhotoId; else delete state.covers[match[1]]; }
        if ('breakName' in body) { row.conditions = { breakName: body.breakName, swellFt: body.swellFt, wind: body.wind, tide: body.tide, photographer: body.photographer }; row.nextDropAt = body.nextDropAt ?? null; }   // migration 0014
        return json(route, { updated: true });
      }
      if ((match = path.match(/^\/api\/admin\/photos\/([\w-]+)$/)) && method === 'DELETE') { record(request, url); return json(route, { success: true }); }
      if (method === 'GET' && path === '/api/admin/verify-queue') { record(request, url); return json(route, { queue: state.verifyQueue, stats: { pending: state.verifyQueue.length, confirmed: 14, rejected: 6, unavailable: 0 } }); }
      if (method === 'GET' && path === '/api/admin/link-queue') { record(request, url); return json(route, { queue: state.linkQueue, stats: { pending: state.linkQueue.length, confirmed: 3, rejected: 1 }, trainedOn: 0 }); }
      if ((method === 'POST' && path === '/api/admin/confirm-match') || (method === 'POST' && path === '/api/admin/confirm-link')) { const body = jsonBody(request); record(request, url, { body }); return json(route, { success: true }); }
    }

    // Anything else would have gone to the dev server's proxy and on to production. Refuse it and fail the test.
    api.escaped.push(`${method} ${path}${url.search}`);
    return json(route, { error: `e2e: no mock for ${method} ${path}` }, 404);
  });
  return api;
}
