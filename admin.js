// Surfers of India crew studio.
const apiBase = (window.MJ_CONFIG?.apiUrl || '').replace(/\/$/, '');
const isLive = Boolean(apiBase);
const apiUrl = (path) => path.startsWith('http') ? path : `${apiBase}${path}`;

// ── Auth helpers ──────────────────────────────────────────────────────────────

function getToken() { return sessionStorage.getItem('mj-admin-token') || ''; }
function setToken(t) { sessionStorage.setItem('mj-admin-token', t); }
function clearToken() { sessionStorage.removeItem('mj-admin-token'); }
function isAuthenticated() { return Boolean(getToken()); }

async function apiRequest(path, options = {}) {
  if (!isLive) throw new Error('API not configured. Add the Worker URL to config.js.');
  const token = getToken();   // remembered on a 401 so a reply to a stale request is told from a fresh expiry (withReauth)
  const headers = {
    ...(typeof options.body === 'string' ? { 'content-type': 'application/json' } : {}),
    authorization: `Bearer ${token}`,
    ...(options.headers || {}),
  };
  const resp = await fetch(apiUrl(path), { ...options, headers, signal: options.signal || AbortSignal.timeout(90000) });
  const body = await resp.json().catch(() => ({}));
  if (resp.status === 401) {
    // Mid-batch (or when the caller says so) an expired token pauses for an inline sign-in instead
    // of dropping the crew on the login screen with a draft half-made — see withReauth().
    if (options.keepSession || uploadBusy) throw Object.assign(new Error('Signed out — sign in again.'), { unauthorized: true, token });
    clearToken(); showLogin(); throw new Error('Signed out — sign in again.');
  }
  if (!resp.ok) throw Object.assign(new Error(body.error || "That didn't work. Try again?"), { status: resp.status, body });   // callers that care (undo, the cover step) read the status / body
  return body;
}

// ── Pure helpers (unit-tested in tests/review-images.test.mjs; keep them free of DOM access) ──

// Progress copy: "n of N photos · x of y MB", a speed and an ETA for the visible line, plus the
// sentence the aria-live twin announces at most every 2 s.
function formatProgress({ percent = 0, speed = 0, etaSeconds = null, done = 0, total = 0, sentBytes = 0, totalBytes = 0 } = {}) {
  const mb = bytes => (bytes / 1048576).toFixed(totalBytes >= 100 * 1048576 ? 0 : 1);
  const count = total ? `${done} of ${total} photo${total === 1 ? '' : 's'} · ${mb(sentBytes)} of ${mb(totalBytes)} MB` : '';
  const rate = speed >= 1000 ? `${(speed / 1024).toFixed(1)} MB/s` : speed > 0 ? `${Math.round(speed)} KB/s` : '';
  const seconds = etaSeconds === null || !Number.isFinite(etaSeconds) ? null : Math.max(1, Math.ceil(etaSeconds));
  const eta = seconds === null ? '' : seconds < 90 ? `ETA: ${seconds}s` : `ETA: ${Math.ceil(seconds / 60)} min`;
  const live = count ? `${count}${seconds === null ? '' : seconds < 90 ? `, ${seconds} seconds left` : `, about ${Math.ceil(seconds / 60)} minutes left`}` : '';
  return { percent: Math.min(100, Math.max(0, Math.round(percent))), count, rate, eta, live };
}
// Same date + break (case-insensitive, trimmed, single-spaced) as an existing, non-archived session.
function findDuplicateSession(sessions, { date, location }) {
  const norm = value => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!norm(date) || !norm(location)) return null;
  return (sessions || []).find(session => session.status !== 'archived' && norm(session.date) === norm(date) && norm(session.location) === norm(location)) || null;
}
// "17 Sept" for the duplicate-session prompt; the raw value if it isn't a date.
function shortDate(value) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? String(value || '') : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
// Where a card's "More" menu should open so it stays on screen: up when it would run off the bottom
// and there is room above the button; right-aligned to the button when it would run off the right.
// `menu` is the menu's rect as opened downwards/right, `anchor` the summary button's.
function menuPlacement({ menu, anchor, viewport, gap = 6, margin = 8 }) {
  const up = menu.bottom > viewport.height - margin && anchor.top - gap - menu.height >= margin;
  const left = menu.right > viewport.width - margin;
  return { up, left };
}
// Money strip for a session card, from one /api/admin/stats row: "12 searches · 3 unlocks · ₹2,100"
// (Indian digit grouping), or a muted "No searches yet" when nobody has searched it. `detail` is the
// fuller breakdown shown as the strip's title. A missing row counts as zero searches.
function formatMoneyStrip(row) {
  const n = key => Math.max(0, Math.round(Number(row?.[key]) || 0));
  const count = (value, word, plural = `${word}s`) => `${value.toLocaleString('en-IN')} ${value === 1 ? word : plural}`;
  const searches = n('searches');
  if (!searches) return { text: 'No searches yet', detail: 'Nobody has searched this session yet.', muted: true };
  const zero = n('zeroMatches');
  const detail = `${n('matches').toLocaleString('en-IN')} matched · ${zero.toLocaleString('en-IN')} no match (${Math.round(zero / searches * 100)}%) · ${count(n('checkouts'), 'checkout')} · ${count(n('downloads'), 'download')}`;
  return { text: `${count(searches, 'search', 'searches')} · ${count(n('unlocks'), 'unlock')} · ₹${n('rupees').toLocaleString('en-IN')}`, detail, muted: false };
}
// The /api/admin/stats body keyed by session id — or null when there is nothing trustworthy to show:
// no body (404 from a Worker without the route yet), a database that isn't migrated (`unmigrated`),
// or no sessions array. Null keeps every strip hidden rather than claiming zero.
function mergeSessionStats(body) {
  if (!body || typeof body !== 'object' || body.unmigrated || !Array.isArray(body.sessions)) return null;
  return new Map(body.sessions.filter(row => row && typeof row.sessionId === 'string').map(row => [row.sessionId, row]));
}
// What a keypress means on the Review tab — Y same, N different, S skip, Z undo — or null when it
// isn't ours: another tab, a dialog up, a modifier held, or the crew typing in a field.
const REVIEW_KEYS = { y: 'confirm', n: 'reject', s: 'skip', z: 'undo' };
function reviewShortcut(event, { tabActive = true, dialogOpen = false, typing = false } = {}) {
  if (!tabActive || dialogOpen || typing || event.metaKey || event.ctrlKey || event.altKey) return null;
  return REVIEW_KEYS[String(event.key || '').toLowerCase()] || null;
}
// ── W3-C helpers: indexing line, conditions, EXIF, money, support ──
// "42 queued · 3 running · ETA 6 min" plus grouped failures ("3 × Face service timed out") from the dashboard's
// `indexing` object (W3-B contract). Null when the object is absent (older Worker) so the badge alone shows.
function formatEta(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return '';
  const s = Math.max(0, Math.round(Number(seconds)));
  return s < 60 ? `ETA ${Math.max(5, Math.ceil(s / 5) * 5)} s` : s < 3600 ? `ETA ${Math.ceil(s / 60)} min` : `ETA ${Math.round(s / 360) / 10} h`;
}
function formatIndexingLine(indexing) {
  if (!indexing || typeof indexing !== 'object') return null;
  const n = key => Math.max(0, Math.round(Number(indexing[key]) || 0));
  const parts = [];
  if (n('queued')) parts.push(`${n('queued').toLocaleString('en-IN')} queued`);
  if (n('processing')) parts.push(`${n('processing')} running`);
  if ((n('queued') || n('processing')) && formatEta(indexing.etaSeconds)) parts.push(formatEta(indexing.etaSeconds));
  if (parts.length && n('failed')) parts.push(`${n('failed')} failed`);   // finished sessions say nothing here — the badge and the failure chips already do
  const failures = (Array.isArray(indexing.failures) ? indexing.failures : []).filter(item => item && item.reason).map(item => ({ reason: String(item.reason), count: Math.max(1, Math.round(Number(item.count) || 1)) })).sort((a, b) => b.count - a.count);
  return { line: parts.join(' · '), failures };
}
// Review confidence bands for the meter: under 50 reads "probably different", 75+ "probably the same".
function confidenceBand(pct) { const value = Number(pct) || 0; return value < 50 ? 'low' : value < 75 ? 'mid' : 'high'; }
// Session conditions (W3-B contract): trimmed strings, swell to one decimal within 0–30, next drop as ISO or null.
// Empty fields become null so an edit can clear them; the payload only ever carries these six keys.
const WIND_OPTIONS = ['offshore', 'onshore', 'cross', 'glassy', 'light', 'strong'];
const TIDE_OPTIONS = ['low', 'mid', 'high', 'rising', 'dropping'];
function conditionsPayload({ breakName = '', swellFt = '', wind = '', tide = '', photographer = '', nextDropAt = '' } = {}) {
  const text = (value, max) => { const trimmed = String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max); return trimmed || null; };
  const swell = String(swellFt ?? '').trim() === '' ? null : Math.round(Math.min(30, Math.max(0, Number(swellFt) || 0)) * 10) / 10;
  return { breakName: text(breakName, 60), swellFt: swell, wind: text(wind, 30)?.toLowerCase() ?? null, tide: text(tide, 30)?.toLowerCase() ?? null, photographer: text(photographer, 60), nextDropAt: datetimeLocalToIso(nextDropAt) };
}
// <input type="datetime-local"> ↔ ISO. The local value has no zone; it is the crew's wall clock, so Date() is right.
function datetimeLocalToIso(value) {
  if (!value) return null;
  const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function isoToDatetimeLocal(iso) {
  if (!iso) return '';
  const date = new Date(iso); if (Number.isNaN(date.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
// One line for the session card: "Mulki river mouth · 3.5 ft · offshore · rising · Ankith · next drop Fri 18 Sept, 07:00"
function formatConditionsLine(conditions, nextDropAt, now = Date.now()) {
  const c = conditions && typeof conditions === 'object' ? conditions : {};
  const parts = [];
  if (c.breakName) parts.push(String(c.breakName));
  if (c.swellFt !== null && c.swellFt !== undefined && c.swellFt !== '') parts.push(`${Number(c.swellFt)} ft`);
  if (c.wind) parts.push(String(c.wind));
  if (c.tide) parts.push(`${c.tide} tide`);
  if (c.photographer) parts.push(`by ${c.photographer}`);
  const drop = nextDropAt ? new Date(nextDropAt) : null;
  if (drop && !Number.isNaN(drop.getTime())) parts.push(`${drop.getTime() < now ? 'dropped' : 'next drop'} ${drop.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}, ${drop.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}`);
  return parts.join(' · ');
}
// EXIF, without a dependency: walk JPEG markers to APP1 "Exif\0\0", then the TIFF header (II/MM), IFD0 for Model
// (0x0110) and the Exif sub-IFD pointer (0x8769), then DateTimeOriginal (0x9003). Only the first ~256 KB of a
// file is read by the caller. Anything odd returns nulls — a pre-fill is a suggestion, never an error.
function readExif(buffer) {
  const out = { dateTimeOriginal: null, model: null };
  try {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 12 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return out;
    let offset = 2;
    while (offset + 4 <= bytes.length && bytes[offset] === 0xFF) {
      const marker = bytes[offset + 1]; const length = view.getUint16(offset + 2);
      if (marker === 0xDA || marker === 0xD9) break;                                   // image data: no more headers
      if (marker === 0xE1 && bytes[offset + 4] === 0x45 && bytes[offset + 5] === 0x78 && bytes[offset + 6] === 0x69 && bytes[offset + 7] === 0x66) {
        const tiff = offset + 10; const end = Math.min(bytes.length, offset + 2 + length);
        const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
        if (!little && !(bytes[tiff] === 0x4D && bytes[tiff + 1] === 0x4D)) return out;
        const u16 = at => view.getUint16(at, little), u32 = at => view.getUint32(at, little);
        const ascii = (at, count) => { let s = ''; for (let i = 0; i < count && at + i < end; i++) { const c = bytes[at + i]; if (!c) break; s += String.fromCharCode(c); } return s.trim(); };
        const readIfd = (at, wanted) => {
          const found = {}; if (at + 2 > end) return found;
          const count = u16(at);
          for (let i = 0; i < count; i++) {
            const entry = at + 2 + i * 12; if (entry + 12 > end) break;
            const tag = u16(entry), type = u16(entry + 2), n = u32(entry + 4);
            if (!(tag in wanted)) continue;
            if (type === 2) { const where = n <= 4 ? entry + 8 : tiff + u32(entry + 8); found[wanted[tag]] = ascii(where, n); }
            else if (type === 4 || type === 3) found[wanted[tag]] = type === 4 ? u32(entry + 8) : u16(entry + 8);
          }
          return found;
        };
        const ifd0 = readIfd(tiff + u32(tiff + 4), { 0x0110: 'model', 0x8769: 'exifIfd', 0x9003: 'dateTimeOriginal' });
        if (ifd0.model) out.model = ifd0.model;
        if (ifd0.dateTimeOriginal) out.dateTimeOriginal = ifd0.dateTimeOriginal;
        if (ifd0.exifIfd) { const exif = readIfd(tiff + ifd0.exifIfd, { 0x9003: 'dateTimeOriginal' }); if (exif.dateTimeOriginal) out.dateTimeOriginal = exif.dateTimeOriginal; }
        break;
      }
      offset += 2 + length;
    }
  } catch { /* a suggestion, never an error */ }
  if (out.dateTimeOriginal && !/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(out.dateTimeOriginal)) out.dateTimeOriginal = null;
  return out;
}
// From the EXIF of the sampled files: the session date, the shooting window and the camera — or null when nothing.
function exifSuggestion(entries) {
  const stamps = (entries || []).map(item => item?.dateTimeOriginal).filter(Boolean).map(stamp => ({ date: stamp.slice(0, 10).replace(/:/g, '-'), time: stamp.slice(11, 16) })).sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  const models = (entries || []).map(item => item?.model).filter(Boolean);
  const model = models.length ? [...models.reduce((map, name) => map.set(name, (map.get(name) || 0) + 1), new Map()).entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
  if (!stamps.length && !model) return null;
  const first = stamps[0], last = stamps[stamps.length - 1];
  const window = !first ? '' : first.date === last.date ? (first.time === last.time ? `at ${first.time}` : `${first.time}–${last.time}`) : `${first.time} (${shortDate(first.date)}) – ${last.time} (${shortDate(last.date)})`;
  const hint = [first ? `Shot ${window} on ${shortDate(first.date)}` : '', model ? (first ? `with a ${model}` : `Shot with a ${model}`) : ''].filter(Boolean).join(' ') + '.';
  return { date: first?.date || null, from: first?.time || null, to: last?.time || null, model, hint };
}
// Money: paise → "₹2,100" (Indian grouping); support: what the crew typed → phone / Cashfree order id / search id.
function formatRupees(paise) { return `₹${Math.round((Number(paise) || 0) / 100).toLocaleString('en-IN')}`; }
function detectSupportQuery(text) {
  const value = String(text ?? '').trim();
  if (!value) return { kind: null, value: '' };
  const digits = value.replace(/[\s()+-]/g, '');
  if (/^(?:91)?[6-9]\d{9}$/.test(digits)) return { kind: 'phone', value: digits.slice(-10) };
  if (/^(mj-|order_)/i.test(value)) return { kind: 'order', value };
  return { kind: 'search', value };
}
// Settlements default to the last 30 days, as YYYY-MM-DD in the crew's local zone.
function defaultSettlementRange(now = new Date()) {
  const day = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const to = new Date(now); const from = new Date(now); from.setDate(from.getDate() - 30);
  return { from: day(from), to: day(to) };
}
// Bulk actions go out in chunks the Worker accepts (200 ids per call); failures from every chunk are merged.
const BULK_CHUNK = 200;
function chunkIds(ids, size = BULK_CHUNK) { const out = []; for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size)); return out; }
function summariseBulk(action, { affected = 0, failed = [] } = {}) {
  const verb = { delete: 'deleted', reindex: 'queued again', move: 'moved', cover: 'set as cover' }[action] || action;
  const done = `${affected} photo${affected === 1 ? '' : 's'} ${verb}`;
  return failed.length ? `${done}; ${failed.length} failed — ${String(failed[0].error || failed[0].reason || 'try again').replace(/\.$/, '')}.` : `${done}.`;
}
// Which duplicate mode an upload attempt sends. The crew's explicit choice (replace / rename / skip
// from the Add-photos dialog) always stands; otherwise an item that has already been attempted —
// an automatic retry after "Network dropped." / "Timed out.", or a "Retry failed" / "Send remaining"
// tap — goes out as 'skip', because the earlier attempt may have stored the photo although its 201
// never arrived, and the Worker would keep a second copy. Such an item's name is unique in the
// session (the dialog flags every name already there), so 'skip' can only ever match its own earlier
// copy — which is why a `skipped` answer to a retried attempt means "done", not "skipped".
function uploadAttemptMode(item, retrying) { return item.onDuplicate || (retrying ? 'skip' : undefined); }
function settleUploadResult(retrying, result) { return retrying && result?.skipped ? { ...result, skipped: false, landed: 'earlier' } : result; }
// Pixel size from the first bytes of a JPEG (the first SOF marker; an EXIF orientation of 5–8 swaps
// the axes so the answer matches what createImageBitmap produces), PNG (IHDR) or WebP (VP8 / VP8L /
// VP8X) — the same walk the Worker does for migration 0012, header only, never the pixel data.
// Null for anything else (HEIC) or a header cut short.
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
// The width createImageBitmap should downsample to *during* decode (so a 24 MP frame is never
// allocated): from the parsed size when the header could be read, and then never wider than the
// image itself — a 500 × 500 PNG that happens to weigh 700 KB used to come back upscaled to 600.
// When the size is unknown (HEIC, or a header cut short) the old rule of thumb stands: a file over
// 512 KB is a big frame. `null` means decode at natural size. Mirrors fitWithin()'s width.
function decodeWidth(dims, size, max) {
  if (dims) return Math.max(dims.width, dims.height) > max ? Math.max(1, Math.round(dims.width * max / Math.max(dims.width, dims.height))) : null;
  return size > 512 * 1024 ? max : null;
}

// ── DOM references ────────────────────────────────────────────────────────────

const loginScreen = document.getElementById('loginScreen');
const adminApp    = document.getElementById('adminApp');
const signOutBtn  = document.getElementById('signOutBtn');
const crewScreen  = document.getElementById('crewScreen');   // W4-C: the crew-accounts pane
const crewBtn     = document.getElementById('crewBtn');

// ── Toasts ────────────────────────────────────────────────────────────────────

// Action results used to land in #adminNotice above the tabs — off-screen whenever the crew is
// scrolled into a long session list. A fixed stack is always in view. Open dialogs paint in the
// top layer, above any fixed element, so the stack moves into whichever dialog is open.
const toastRoot = Object.assign(document.createElement('div'), { className: 'soi-toasts' });
toastRoot.setAttribute('aria-live', 'polite');
document.body.append(toastRoot);
const TOAST_ICON = { info: 'stamp-wave', success: 'stamp-sunburst', error: 'stamp-coral' };
function toast(message, kind = 'info', { action, timeout = action ? 10000 : kind === 'error' ? 9000 : 5000 } = {}) {   // one with an action stays long enough to Tab to
  const el = document.createElement('div'); el.className = 'soi-toast'; el.dataset.kind = kind;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = `<svg aria-hidden="true"><use href="soi-stamps.svg#${TOAST_ICON[kind] || TOAST_ICON.info}"/></svg><div></div><button type="button" aria-label="Dismiss">×</button>`;
  const body = el.children[1]; body.textContent = message;
  if (action) {
    const run = document.createElement('button'); run.type = 'button'; run.textContent = action.label;
    run.style.cssText = 'min-width:0;min-height:0;margin:4px 0 0;padding:10px 0;font:inherit;text-decoration:underline;opacity:1';
    run.addEventListener('click', () => { el.remove(); action.run(); });
    body.append(document.createElement('br'), run);
  }
  el.lastElementChild.addEventListener('click', () => el.remove());
  const host = [...document.querySelectorAll('dialog[open]')].pop() || document.body;
  if (toastRoot.parentNode !== host) host.append(toastRoot);
  toastRoot.append(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}
// `kind` is explicit ('info' | 'success' | 'error'): errors are announced assertively and shown
// longer, successes get the sunburst stamp. Nothing is inferred from the wording. The login screen
// has no toasts — its inline error slot takes the message instead.
function notifyCrew(message, kind = 'info') {
  if (!loginScreen.classList.contains('hidden')) { document.getElementById('loginError').textContent = message; return; }
  toast(String(message ?? ''), kind);
}

// ── Routing: show login or app ────────────────────────────────────────────────

function showApp() {
  loginScreen.classList.add('hidden');
  crewScreen.classList.add('hidden');
  adminApp.classList.remove('hidden');
  signOutBtn.classList.remove('hidden');   // show sign-out in topbar
  refreshCrewIdentity();                   // W4-C: shows the topbar's Crew button for an admin account
  armIdle(); startHealth();
  focusUploadTitle();
  // Set today's date as default
  const dateInput = document.getElementById('adminDate');
  if (!dateInput.value) { const now = new Date(); dateInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; }
  offerResume();   // an interrupted batch from an earlier visit (W4-A); silent when there is none
  // Don't auto-load dashboard — only load when tab is clicked
}

function showLogin() {
  // Stop any running auto-refresh, the idle clock and the health poll
  if (dashInterval) { clearInterval(dashInterval); dashInterval = null; }
  disarmIdle(); stopHealth({ hide: true });
  adminApp.classList.add('hidden');
  crewScreen.classList.add('hidden');
  loginScreen.classList.remove('hidden');
  signOutBtn.classList.add('hidden');
  crewBtn.classList.add('hidden');
  document.querySelectorAll('dialog[open]').forEach(modal => modal.close());
  // Reset tabs back to Upload so next login starts fresh
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  document.querySelector('.tab-btn[data-tab="upload"]').classList.add('active');
  document.getElementById('tab-upload').classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(button => { button.setAttribute('aria-selected', String(button.dataset.tab === 'upload')); button.tabIndex = button.dataset.tab === 'upload' ? 0 : -1; });
  document.getElementById('reauthPanel').hidden = true;
  forgetReview();                                   // the undo window belongs to the sign-in that made the decision
  focusLogin();
}
// W4-C: the name is remembered between sign-ins, so a returning crew member lands on the password;
// a first visit (and the shared-password era, where the name stays empty) starts at the name field.
function focusLogin() {
  const nameEl = document.getElementById('adminName');
  if (!nameEl.value) nameEl.value = rememberedName();
  (nameEl.value ? document.getElementById('adminPassword') : nameEl).focus();
}
// Keyboard users land in the title field when the Upload tab opens (after sign-in too); on touch
// screens that would pop the keyboard over the form, so there the tab just opens.
function focusUploadTitle() { if (!window.matchMedia('(pointer:coarse)').matches) document.getElementById('adminTitle').focus({ preventScroll: true }); }



// ── Sign out ──────────────────────────────────────────────────────────────────

// Crew tokens are revocable server-side (migration 0011): tell the Worker before dropping the token
// locally, fire-and-forget — `keepalive` lets the request finish even if the page unloads, and a 404
// from a Worker deployed without the route yet is silent. Nothing waits on it.
function revokeToken() {
  const token = getToken();
  if (!token || !isLive) return;
  try { fetch(apiUrl('/api/admin/logout'), { method: 'POST', headers: { authorization: `Bearer ${token}` }, keepalive: true }).catch(() => {}); }
  catch { /* optional */ }
}
signOutBtn.addEventListener('click', () => {
  revokeToken();
  clearToken();
  showLogin();
});

// ── Login form ────────────────────────────────────────────────────────────────

// W4-C: sign-in is { name?, password, code? }. An empty name is the shared crew password, which the
// Worker accepts only until everyone has an account; `needsTotp` in the answer reveals the code
// field and keeps whatever was typed, so the crew member only adds the six digits.
const NAME_KEY = 'mj-admin-name';
const rememberedName = () => { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } };
const rememberName = (name) => { try { if (name) localStorage.setItem(NAME_KEY, name); else localStorage.removeItem(NAME_KEY); } catch { /* private mode */ } };
// What the Worker last said about this sign-in (role, whether they may manage accounts). Kept in
// sessionStorage beside the token so a reload does not have to ask again before painting the topbar.
const WHO_KEY = 'mj-admin-who';
const whoAmI = () => { try { return JSON.parse(sessionStorage.getItem(WHO_KEY) || 'null'); } catch { return null; } };
const setWhoAmI = (who) => { try { if (who) sessionStorage.setItem(WHO_KEY, JSON.stringify(who)); else sessionStorage.removeItem(WHO_KEY); } catch { /* private mode */ } };
class TotpNeeded extends Error {}

// One sign-in call for the login screen and the mid-batch "sign in again" panel.
async function loginWithPassword(password, { name = rememberedName(), code = '' } = {}) {
  const payload = { password, ...(name ? { name } : {}), ...(code ? { code } : {}) };
  const result = await fetch(apiUrl('/api/admin/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
  const body = await result.json().catch(() => ({}));
  if (!result.ok) {
    const message = body.error || (result.status === 401 ? 'Wrong password.' : result.status === 429 ? 'Too many tries. Wait 15 minutes.' : 'Photo service is down. Try again?');
    throw body.needsTotp ? new TotpNeeded(message) : new Error(message);
  }
  if (typeof body.token !== 'string' || !body.token) throw new Error("Sign-in didn't complete. Refresh and try again.");
  setToken(body.token);
  rememberName(body.user?.name || '');
  setWhoAmI({ name: body.user?.name || null, role: body.role || body.user?.role || 'admin', canManageUsers: Boolean(body.canManageUsers), sharedLogin: Boolean(body.sharedLogin) });
}
const loginErrorMessage = err => err.name === 'TimeoutError' ? 'Sign-in timed out. Try again?' : err instanceof TypeError ? "Can't reach the photo service. Check your connection." : err.message;

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('loginError');
  const nameEl = document.getElementById('adminName');
  const passwordEl = document.getElementById('adminPassword');
  const codeField = document.getElementById('loginCodeField');
  const codeEl = document.getElementById('adminCode');
  const btn = e.currentTarget.querySelector('button[type="submit"]');
  errorEl.textContent = '';
  btn.disabled = true; btn.classList.add('is-busy');
  btn.innerHTML = 'Signing in… <span></span>';

  try {
    await loginWithPassword(passwordEl.value, { name: nameEl.value.trim(), code: codeEl.value.trim() });
    passwordEl.value = ''; codeEl.value = ''; codeField.hidden = true;
    showApp();
  } catch (err) {
    errorEl.textContent = loginErrorMessage(err);
    // The account has an authenticator: show the field (keeping the password) and put the cursor in it.
    if (err instanceof TotpNeeded) { codeField.hidden = false; codeEl.value = ''; codeEl.focus(); }
  } finally {
    btn.disabled = false; btn.classList.remove('is-busy');
    btn.innerHTML = "Let's go";
  }
});

document.getElementById('togglePassword').addEventListener('click', event => {
  const input = document.getElementById('adminPassword');
  const visible = input.type === 'password';
  input.type = visible ? 'text' : 'password';
  event.currentTarget.textContent = visible ? 'Hide' : 'Show';
  event.currentTarget.setAttribute('aria-pressed', String(visible));
});

// ── Crew accounts, TOTP and the audit log (W4-C) ──────────────────────────────

// The topbar's "Crew" button appears only for an admin account — or for the shared password while it
// still works, which is how the first account gets made. GET /api/admin/me answers that; an older
// Worker 404s it, and then the button simply stays hidden and nothing else changes.
async function refreshCrewIdentity() {
  const known = whoAmI();
  if (known) crewBtn.classList.toggle('hidden', !known.canManageUsers);
  if (!isLive) return;
  try {
    const me = await apiRequest('/api/admin/me', { keepSession: true });
    setWhoAmI({ name: me.user?.name || null, role: me.role, canManageUsers: Boolean(me.canManageUsers), sharedLogin: Boolean(me.sharedLogin) });
    if (me.user?.name) rememberName(me.user.name);
    crewBtn.classList.toggle('hidden', !me.canManageUsers);
  } catch { crewBtn.classList.toggle('hidden', !known?.canManageUsers); }   // 404 on an older Worker, or a paused batch
}

const crewNotice = (message, kind = 'info') => {
  const el = document.getElementById('crewNotice');
  el.textContent = message || ''; el.hidden = !message;
  el.classList.toggle('error', kind === 'error');
};
function showCrewScreen() {
  adminApp.classList.add('hidden');
  crewScreen.classList.remove('hidden');
  crewBtn.setAttribute('aria-expanded', 'true');
  document.getElementById('crewBackBtn').focus();
  loadCrewUsers(); loadAudit({ reset: true });
}
function hideCrewScreen() {
  crewScreen.classList.add('hidden');
  adminApp.classList.remove('hidden');
  crewBtn.setAttribute('aria-expanded', 'false');
  crewBtn.focus();
}
crewBtn.addEventListener('click', () => (crewScreen.classList.contains('hidden') ? showCrewScreen() : hideCrewScreen()));
document.getElementById('crewBackBtn').addEventListener('click', hideCrewScreen);

const crewRoleLabel = role => (role === 'admin' ? 'Admin' : 'Photographer');
const whenText = (iso) => { const at = Date.parse(iso); return Number.isFinite(at) ? new Date(at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; };
// One card per account: role, whether the authenticator is on, last sign-in, and the two admin actions.
function renderCrewUsers(users, sharedLogin) {
  const list = document.getElementById('crewList');
  if (!users.length) { list.innerHTML = '<p class="section-sub">No accounts yet — the shared crew password is still what everyone uses.</p>'; return; }
  list.innerHTML = users.map(user => `
    <div class="d-card" data-user-id="${escHtml(user.id)}" style="margin-bottom:12px">
      <div class="d-card-head">
        <div>
          <span class="d-card-title">${escHtml(user.name)}</span>
          <span class="chip">${escHtml(crewRoleLabel(user.role))}</span>
          <span class="chip ${user.totpEnabled ? 'chip--slate' : 'chip--terracotta'}">${user.totpEnabled ? 'Authenticator on' : 'No authenticator yet'}</span>
          ${user.disabledAt ? '<span class="chip chip--coral">Disabled</span>' : ''}
        </div>
        <div>
          ${user.disabledAt ? '' : `<button class="btn-sm" type="button" data-crew-action="reset">Reset password</button>
          <button class="btn-sm" type="button" data-crew-action="disable">Disable</button>`}
        </div>
      </div>
      <p class="section-sub" style="margin:0">Last signed in ${user.lastLoginAt ? escHtml(whenText(user.lastLoginAt)) : 'never'}${user.disabledAt ? ` · disabled ${escHtml(whenText(user.disabledAt))}` : ''}</p>
    </div>`).join('');
  if (sharedLogin) crewNotice('The shared crew password still works. It stops the moment every crew member has an account here (or when LEGACY_SHARED_LOGIN is turned off).');
}
async function loadCrewUsers() {
  const list = document.getElementById('crewList');
  list.innerHTML = '<p class="section-sub">Loading the crew…</p>';
  try {
    const { users, sharedLogin } = await apiRequest('/api/admin/users');
    renderCrewUsers(users, sharedLogin);
  } catch (error) {
    list.innerHTML = '';
    crewNotice(error.status === 404 ? 'That needs the new Worker deploy.' : error.message, 'error');
  }
}

// Reset / disable, straight from a card. Both revoke that account's live sessions server-side.
document.getElementById('crewList').addEventListener('click', async event => {
  const button = event.target.closest('button[data-crew-action]');
  if (!button) return;
  const card = button.closest('[data-user-id]'); const userId = card.dataset.userId; const name = card.querySelector('.d-card-title').textContent;
  const action = button.dataset.crewAction;
  if (action === 'reset') {
    const replacement = window.prompt(`New password for ${name} (at least 10 characters). They will be signed out everywhere.`);
    if (!replacement) return;
    button.disabled = true;
    try { await apiRequest(`/api/admin/users/${userId}/reset-password`, { method: 'POST', body: JSON.stringify({ password: replacement }) }); toast(`${name} has a new password — tell them in person, not in writing.`, 'success'); }
    catch (error) { crewNotice(error.message, 'error'); }
    finally { button.disabled = false; }
    return;
  }
  if (!window.confirm(`Disable ${name}? They are signed out everywhere and cannot sign in again. The audit log keeps what they did.`)) return;
  button.disabled = true;
  try { await apiRequest(`/api/admin/users/${userId}/disable`, { method: 'POST' }); toast(`${name} can no longer sign in.`, 'success'); await loadCrewUsers(); }
  catch (error) { crewNotice(error.message, 'error'); button.disabled = false; }
});

// Creating an account shows its authenticator key once. No QR encoder ships with the studio: the key
// is shown in full with a copy button, and the otpauth:// link opens the app directly on a phone.
let provisioned = null;
document.getElementById('crewCreateForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget; const errorEl = document.getElementById('crewCreateError');
  const button = form.querySelector('button[type=submit]');
  const name = document.getElementById('crewNewName').value.trim();
  const password = document.getElementById('crewNewPassword').value;
  const role = document.getElementById('crewNewRole').value;
  errorEl.textContent = ''; button.disabled = true;
  try {
    const { user, totp } = await apiRequest('/api/admin/users', { method: 'POST', body: JSON.stringify({ name, password, role }) });
    provisioned = { user, totp };
    document.getElementById('crewNewName').value = ''; document.getElementById('crewNewPassword').value = '';
    document.getElementById('crewProvisionName').textContent = `${user.name}’s`;
    document.getElementById('crewProvisionSecret').textContent = (totp.secret.match(/.{1,4}/g) || []).join(' ');
    document.getElementById('crewProvisionLink').href = totp.uri;
    document.getElementById('crewVerifyError').textContent = ''; document.getElementById('crewVerifyCode').value = '';
    document.getElementById('crewProvision').hidden = false;
    document.getElementById('crewProvision').scrollIntoView({ block: 'nearest' });
    document.getElementById('crewVerifyCode').focus();
    await loadCrewUsers();
  } catch (error) { errorEl.textContent = error.status === 404 ? 'That needs the new Worker deploy.' : error.message; }
  finally { button.disabled = false; }
});
document.getElementById('crewCopySecret').addEventListener('click', async event => {
  if (!provisioned) return;
  try { await navigator.clipboard.writeText(provisioned.totp.secret); event.currentTarget.textContent = 'Copied'; setTimeout(() => { event.currentTarget.textContent = 'Copy the key'; }, 2000); }
  catch { crewNotice('Copying is blocked in this browser — read the key out instead.', 'error'); }
});
document.getElementById('crewProvisionDone').addEventListener('click', () => { document.getElementById('crewProvision').hidden = true; provisioned = null; });
document.getElementById('crewVerifyForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!provisioned) return;
  const errorEl = document.getElementById('crewVerifyError'); const button = event.currentTarget.querySelector('button[type=submit]');
  errorEl.textContent = ''; button.disabled = true;
  try {
    await apiRequest(`/api/admin/users/${provisioned.user.id}/totp/verify`, { method: 'POST', body: JSON.stringify({ code: document.getElementById('crewVerifyCode').value.trim() }) });
    toast(`${provisioned.user.name} now needs their 6-digit code to sign in.`, 'success');
    document.getElementById('crewProvision').hidden = true; provisioned = null;
    await loadCrewUsers();
  } catch (error) { errorEl.textContent = error.message; }
  finally { button.disabled = false; }
});

// The audit log, newest first, paged by the cursor the Worker hands back.
let auditCursor = null;
const AUDIT_WORDS = { 'login.success': 'signed in', 'login.failure': 'failed to sign in', 'session.delete': 'deleted a session', 'session.publish': 'published a session', 'session.unpublish': 'took a session off the site', 'session.archive': 'archived a session', 'photo.delete': 'deleted a photo', 'photo.bulk-delete': 'deleted photos', 'photo.bulk-move': 'moved photos', 'search.grant': 'unlocked a gallery for free', 'payment.refund': 'refunded a payment', 'user.create': 'created an account', 'user.disable': 'disabled an account', 'user.reset-password': 'reset a password', 'user.totp.enable': 'switched on an authenticator' };
// Money reads as money and the rest as "key: value"; unknown keys still show rather than disappear.
const AUDIT_DETAIL_WORDS = { amountPaise: 'amount', photos: 'photos', reason: 'reason', role: 'role', name: 'name', status: 'status', to: 'moved to', failed: 'failed', cover: 'cover', title: 'session', totp: 'authenticator', shared: 'shared password', refundId: 'refund', was: 'was', now: 'now' };
const auditDetail = detail => Object.entries(detail)
  .filter(([, value]) => value !== null && value !== undefined && value !== false)
  .map(([key, value]) => `${AUDIT_DETAIL_WORDS[key] || key}: ${key === 'amountPaise' ? formatRupees(value) : value}`)
  .join(' · ');
const auditLine = entry => `
  <div class="d-card" style="margin-bottom:8px;padding:14px 18px">
    <p style="margin:0;font-size:13px"><strong>${escHtml(entry.actor)}</strong> ${escHtml(AUDIT_WORDS[entry.action] || entry.action)}${entry.targetId ? ` <span class="chip">${escHtml(entry.targetType || 'record')} ${escHtml(entry.targetId)}</span>` : ''}</p>
    <p class="section-sub" style="margin:4px 0 0">${escHtml(whenText(entry.createdAt))}${entry.ip ? ` · ${escHtml(entry.ip)}` : ''}${entry.detail ? ` · ${escHtml(auditDetail(entry.detail))}` : ''}</p>
  </div>`;
async function loadAudit({ reset = false } = {}) {
  const list = document.getElementById('auditList'); const more = document.getElementById('auditMoreBtn');
  if (reset) { auditCursor = null; list.innerHTML = '<p class="section-sub">Loading…</p>'; }
  try {
    const { entries, nextBefore } = await apiRequest(`/api/admin/audit?limit=25${auditCursor ? `&before=${encodeURIComponent(auditCursor)}` : ''}`);
    const html = entries.map(auditLine).join('');
    if (reset) list.innerHTML = entries.length ? html : '<p class="section-sub">Nothing recorded yet.</p>';
    else list.insertAdjacentHTML('beforeend', html);
    auditCursor = nextBefore;
    more.hidden = !nextBefore;
  } catch (error) {
    if (reset) list.innerHTML = '';
    crewNotice(error.status === 404 ? 'That needs the new Worker deploy.' : error.message, 'error');
    more.hidden = true;
  }
}
document.getElementById('auditMoreBtn').addEventListener('click', () => loadAudit());

// ── Tabs ──────────────────────────────────────────────────────────────────────

// `focusPanel` is off for arrow-key navigation, where focus must stay in the tablist.
function activateTab(btn, { focusPanel = true } = {}) {
  if (dashInterval) { clearInterval(dashInterval); dashInterval = null; }
  document.querySelectorAll('.tab-btn').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); b.tabIndex = -1; });
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  btn.classList.add('active'); btn.setAttribute('aria-selected', 'true'); btn.tabIndex = 0;
  document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  if (btn.dataset.tab === 'dashboard') loadDashboard();
  if (btn.dataset.tab === 'verify') { loadVerifyQueue(); loadLinkQueue(); }
  if (btn.dataset.tab === 'money') loadMoneyTab();
  if (btn.dataset.tab === 'support' && focusPanel && !window.matchMedia('(pointer:coarse)').matches) document.getElementById('supportQuery').focus({ preventScroll: true });
  if (btn.dataset.tab === 'upload' && focusPanel) focusUploadTitle();
}
document.querySelectorAll('.tab-btn').forEach((btn) => btn.addEventListener('click', () => activateTab(btn)));

// ── Modals ────────────────────────────────────────────────────────────────────

const photoGalleryModal = document.getElementById('photoGalleryModal');
const closeGalleryModal = document.getElementById('closeGalleryModal');
const editSessionModal  = document.getElementById('editSessionModal');
const closeEditModal    = document.getElementById('closeEditModal');
const uploadMoreModal   = document.getElementById('uploadMoreModal');
const closeMoreModal    = document.getElementById('closeMoreModal');
const confirmDialog     = document.getElementById('confirmDialog');

function openModal(modal) { modal.classList.remove('hidden'); if (!modal.open) modal.showModal(); }
// The edit form remembers what it opened with so an accidental backdrop click / Escape can't
// silently discard typed changes.
let editSnapshot = '';
const EDIT_CONDITION_IDS = { breakName: 'editBreakName', swellFt: 'editSwell', wind: 'editWind', tide: 'editTide', photographer: 'editPhotographer', nextDropAt: 'editNextDrop' };
const editFormState = () => ['editTitle', 'editDate', 'editLocation', 'editPrice', 'editStatus', ...Object.values(EDIT_CONDITION_IDS)].map(id => document.getElementById(id).value).join('\u0000');
const editIsDirty = () => editSessionModal.open && editFormState() !== editSnapshot;
async function closeEditSafely() {
  if (editIsDirty() && !await confirmAction({ title: 'Discard changes?', copy: 'You have unsaved edits to this session.', confirmLabel: 'Discard' })) return false;
  editSessionModal.close(); return true;
}
[photoGalleryModal, editSessionModal, uploadMoreModal, confirmDialog].forEach(modal => {
  modal.addEventListener('close', () => { modal.classList.add('hidden'); if (toastRoot.parentNode === modal) document.body.append(toastRoot); });
  modal.addEventListener('click', event => {
    if (event.target !== modal || (uploadBusy && modal !== confirmDialog)) return;
    if (modal === editSessionModal) { closeEditSafely(); return; }
    modal.close();
  });
  // Escape must not abandon an upload that is still sending files, or drop unsaved edits. The
  // confirm dialog is exempt so "Stop uploading?" can itself be backed out of.
  modal.addEventListener('cancel', event => { if (uploadBusy && modal !== confirmDialog) event.preventDefault(); if (modal === editSessionModal && editIsDirty()) { event.preventDefault(); closeEditSafely(); } });
});
closeGalleryModal.addEventListener('click', () => photoGalleryModal.close());
closeEditModal.addEventListener('click', () => closeEditSafely());
// Promise-based confirm dialog: `typed` asks the crew to type a phrase before a destructive action;
// `danger: false` keeps a non-destructive confirm off the red button; `alt` adds a third choice that
// resolves with 'alt' (the duplicate-session prompt's "Upload more to that session").
let confirmResolve = null;
// `choice` ({ label, options: [{ value, label }] }) adds a pick list (bulk "Move to…") and `reason` ({ label,
// required }) a free-text field (free unlock, refund); with either, a confirm resolves { choice, reason } instead of true.
function confirmAction({ title, copy, confirmLabel = 'Delete', typed = '', danger = true, alt = '', choice = null, reason = null }) {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmCopy').textContent = copy;
  const wrap = document.getElementById('confirmTypedWrap'), input = document.getElementById('confirmTypedInput'), ok = document.getElementById('confirmOkBtn');
  wrap.hidden = !typed; input.value = ''; ok.textContent = confirmLabel;
  ok.className = danger ? 'delete-btn confirm-danger' : 'btn-sm btn-primary-sm';
  const altBtn = document.getElementById('confirmAltBtn'); altBtn.hidden = !alt; altBtn.textContent = alt;
  document.getElementById('confirmTypedLabel').textContent = typed ? `Type “${typed}” to confirm` : '';
  const choiceWrap = document.getElementById('confirmChoiceWrap'), select = document.getElementById('confirmChoice');
  choiceWrap.hidden = !choice; select.replaceChildren();
  if (choice) { document.getElementById('confirmChoiceLabel').textContent = choice.label || 'Choose'; (choice.options || []).forEach(option => select.append(Object.assign(document.createElement('option'), { value: option.value, textContent: option.label }))); }
  const reasonWrap = document.getElementById('confirmReasonWrap'), reasonInput = document.getElementById('confirmReason');
  reasonWrap.hidden = !reason; reasonInput.value = '';
  if (reason) { document.getElementById('confirmReasonLabel').textContent = reason.label || 'Reason'; reasonInput.placeholder = reason.placeholder || ''; }
  const settle = () => { ok.disabled = (typed && input.value.trim() !== typed) || (reason?.required && !reasonInput.value.trim()) || (choice && !select.value); };
  settle();
  input.oninput = settle; reasonInput.oninput = settle; select.onchange = settle;
  confirmResolve?.(false);
  // Enter on a stray keypress must not fire the destructive action: focus Cancel (or the typed field).
  const first = typed ? input : reason ? reasonInput : choice ? select : document.getElementById('confirmCancelBtn');
  return new Promise(resolve => { confirmResolve = resolve; openModal(confirmDialog); first.focus(); });
}
document.getElementById('confirmForm').addEventListener('submit', event => {
  event.preventDefault();
  if (document.getElementById('confirmOkBtn').disabled) return;   // Enter in the reason field before it is filled
  const resolve = confirmResolve; confirmResolve = null;
  const detailed = !document.getElementById('confirmChoiceWrap').hidden || !document.getElementById('confirmReasonWrap').hidden;
  const result = detailed ? { choice: document.getElementById('confirmChoice').value, reason: document.getElementById('confirmReason').value.trim() } : true;
  confirmDialog.close(); resolve?.(result);
});
document.getElementById('confirmAltBtn').addEventListener('click', () => { const resolve = confirmResolve; confirmResolve = null; confirmDialog.close(); resolve?.('alt'); });
document.getElementById('confirmCancelBtn').addEventListener('click', () => confirmDialog.close());
document.getElementById('closeConfirmDialog').addEventListener('click', () => confirmDialog.close());
confirmDialog.addEventListener('close', () => { const resolve = confirmResolve; confirmResolve = null; resolve?.(false); });
// While a batch is sending, × and Cancel offer to stop it (Escape stays blocked); otherwise they close.
async function stopOrCloseMore() {
  if (!uploadBusy) return uploadMoreModal.close();
  if (await confirmAction({ title: 'Stop uploading?', copy: STOP_UPLOAD_COPY, confirmLabel: 'Stop' })) cancelUpload();
}
closeMoreModal.addEventListener('click', () => stopOrCloseMore());
document.querySelector('.tabs').addEventListener('keydown', event => {
  const buttons = [...document.querySelectorAll('.tab-btn')]; const index = buttons.indexOf(document.activeElement);
  if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next].focus(); activateTab(buttons[next], { focusPanel: false });
});
// ── Upload: preview generation ────────────────────────────────────────────────

// HEIC/HEIF is the iPhone default; its MIME type is often blank, so check the extension too.
const isHeic = file => /image\/hei[cf]/.test(file.type) || /\.hei[cf]$/i.test(file.name);
const imageElementFromFile = file => new Promise((resolve, reject) => {
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't read this file.")); };
  img.src = url;
});
// createImageBitmap first: it decodes HEIC on Safari/macOS and downsamples *during* decode, so a
// 24 MP frame is never allocated (`resizeWidth` comes from decodeWidth(): the header's own size,
// so nothing is ever upscaled; null decodes at natural size). <img> is the fallback for
// browsers/formats it can't take; a HEIC that fails both fails only that file.
async function imageFromFile(file, resizeWidth = null) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, resizeWidth ? { resizeWidth, resizeQuality: 'high' } : {}); }
    catch { /* fall through to the <img> path */ }
  }
  try { return await imageElementFromFile(file); }
  catch { throw new Error(isHeic(file) ? "This browser can't read HEIC — use Safari or export JPEGs." : "Couldn't read this file."); }
}

const toBlobOfType = (canvas, type, quality) => new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Couldn't build the preview.")), type, quality));
const toJpeg = (canvas, quality) => toBlobOfType(canvas, 'image/jpeg', quality);
// WebP where the browser really encodes it (Chrome, Firefox, Safari 16+), JPEG otherwise: Safari 15
// and older hand back a PNG when asked for WebP, so the produced blob's own type decides — never a UA
// string. Probed once per page on the first preview, and mirrored in preview-worker.js.
let webpOk = null;
async function toWebp(canvas, quality) {
  if (webpOk === false) return null;
  const blob = await toBlobOfType(canvas, 'image/webp', quality).catch(() => null);
  webpOk = Boolean(blob) && blob.type === 'image/webp';
  return webpOk ? blob : null;
}
// The wave-crest stamp (soi-stamps.svg #stamp-wave, viewBox 0 0 100 100) as Path2D — no raster asset.
const STAMP_PATHS = typeof Path2D === 'function' ? [
  'M8 78c10-3 18-2 28-8 8-5 13-13 12-24-1-9-8-17-18-18 12-4 26 1 31 13 4 10 1 22-6 30 9-2 16-8 20-16 5-11 2-24-6-32 14 4 24 17 22 33-2 17-16 29-33 30 6 0 12-1 18-3-9 6-21 8-32 6-12-2-24-3-36-1z',
  'M6 86h60c2 0 2 3 0 3H6c-2 0-2-3 0-3zm10 6h34c2 0 2 3 0 3H16c-2 0-2-3 0-3z',
].map(d => new Path2D(d)) : [];
// Guests see this preview until they pay, so it is deliberately useless anywhere else: 600 px on
// the long edge, blurred, then a dense low-alpha diagonal text lattice drawn sharp on top so it can't
// be cropped away, plus the brand stamp in the corner so shares look branded rather than "sample".
// A surfer can still tell it's them; nobody can print it. A 320 px thumbnail (drawn from the
// finished canvas) rides along so grids don't load the 600 px file.
// The fast path is preview-worker.js (same steps on an OffscreenCanvas, off the main thread); this
// copy is the fallback for browsers without Workers/OffscreenCanvas and for files the worker can't
// decode (HEIC outside Safari). KEEP THE CONSTANTS AND DRAWING STEPS IN BOTH FILES IDENTICAL —
// tests/review-images.test.mjs checks the constants and stamp paths match.
const PREVIEW_MAX = 600;
const PREVIEW_BLUR_PX = 2.2;
const PREVIEW_QUALITY = 0.72;
const THUMB_MAX = 320;
const THUMB_QUALITY = 0.74;
const QUEUE_THUMB_PX = 96;        // upload-list thumbnails: never uploaded, just what the crew sees in the queue
const fitWithin = (width, height, max) => {
  const scale = Math.min(1, max / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
};
// 1) blur, before the watermark. Canvas filters where supported (Chrome/Firefox/Safari 18+); the
// image bleeds past the edges so the filter's transparent falloff lands off-canvas instead of
// becoming a dark JPEG border. Elsewhere a cheap box blur: draw at 1/3 size and scale back up.
function paintBlurred(ctx, img, width, height) {
  if ('filter' in ctx) {
    const bleed = Math.ceil(PREVIEW_BLUR_PX * 3);
    ctx.filter = `blur(${PREVIEW_BLUR_PX}px)`;
    ctx.drawImage(img, -bleed, -bleed, width + bleed * 2, height + bleed * 2);
    ctx.filter = 'none';
  } else {
    const scratch = document.createElement('canvas');
    scratch.width = Math.max(1, Math.round(width / 3)); scratch.height = Math.max(1, Math.round(height / 3));
    scratch.getContext('2d').drawImage(img, 0, 0, scratch.width, scratch.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(scratch, 0, 0, width, height);
  }
}
// 2) anti-crop lattice, sharp on top of the blur; 3) corner stamp: 11% of the width, padded by
// 35% of itself, bottom-right.
function paintWatermark(ctx, width, height) {
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate(-Math.PI / 7);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const size = Math.max(16, Math.round(width / 22));
  ctx.font = `700 ${size}px "Plus Jakarta Sans", Arial, sans-serif`;
  const stepY = size * 3.4, stepX = size * 10, reach = Math.hypot(width, height);
  let row = 0;
  for (let y = -reach; y <= reach; y += stepY, row += 1) {
    for (let x = -reach + (row % 2 ? stepX / 2 : 0); x <= reach; x += stepX) {
      ctx.globalAlpha = .22; ctx.fillStyle = '#2B2018'; ctx.fillText('SURFERS OF INDIA · PREVIEW', x + 1, y + 1);
      ctx.globalAlpha = .42; ctx.fillStyle = '#F2ECDB'; ctx.fillText('SURFERS OF INDIA · PREVIEW', x, y);
    }
  }
  ctx.restore();
  if (!STAMP_PATHS.length) return;
  const s = Math.round(width * .11), pad = Math.round(s * .35);
  ctx.save();
  ctx.translate(width - s - pad, height - s - pad); ctx.scale(s / 100, s / 100);
  ctx.globalAlpha = .82; ctx.fillStyle = '#F2ECDB'; ctx.shadowColor = 'rgba(43,32,24,.45)'; ctx.shadowBlur = s * .15;
  STAMP_PATHS.forEach(path => ctx.fill(path));
  ctx.restore();
}
async function watermarkedPreviewOnMainThread(file, resizeWidth = null) {
  const img = await imageFromFile(file, resizeWidth);   // ImageBitmap or HTMLImageElement — both expose width/height
  const [width, height] = fitWithin(img.width, img.height, PREVIEW_MAX);
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  paintBlurred(ctx, img, width, height);
  img.close?.();                                  // release the decoded bitmap right away
  paintWatermark(ctx, width, height);
  const preview = await toWebp(canvas, PREVIEW_QUALITY) || await toJpeg(canvas, PREVIEW_QUALITY);
  const [thumbWidth, thumbHeight] = fitWithin(width, height, THUMB_MAX);
  const small = document.createElement('canvas'); small.width = thumbWidth; small.height = thumbHeight;
  const smallCtx = small.getContext('2d'); smallCtx.imageSmoothingQuality = 'high';
  smallCtx.drawImage(canvas, 0, 0, thumbWidth, thumbHeight);
  const thumb = await toWebp(small, THUMB_QUALITY) || await toJpeg(small, THUMB_QUALITY);
  return Object.assign(preview, { thumb, width, height });
}

// ── Upload: preview worker pool ───────────────────────────────────────────────

// Two workers (a 24 MP decode is ~96 MB RGBA, so never more than two at once) share one FIFO of
// jobs; queue thumbnails jump the line because they're tiny and the crew is looking at them. A
// worker that fails to load (a deploy without the file) or crashes marks the pool broken and every
// later job goes to the main-thread path. Jobs the worker rejects carry `worker: true` so callers
// can tell "this worker couldn't take it" from a real error.
function createPreviewPool(size) {
  const supported = typeof Worker === 'function' && typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function';
  const workers = []; const pending = []; let seq = 0, broken = false;
  const workerError = message => Object.assign(new Error(message), { worker: true });
  const fail = (job, message) => job?.reject(workerError(message));
  function spawn() {
    const worker = new Worker('preview-worker.js');
    worker.job = null;
    worker.onmessage = ({ data }) => {
      const job = worker.job; if (!job || data?.id !== job.id) return;
      worker.job = null;
      if (data.error) fail(job, data.error); else job.resolve(data);
      pump();
    };
    worker.onerror = event => {
      event.preventDefault?.();
      broken = true; worker.terminate(); workers.splice(workers.indexOf(worker), 1);
      fail(worker.job, 'Preview worker failed.'); worker.job = null;
      pending.splice(0).forEach(job => fail(job, 'Preview worker failed.'));
    };
    workers.push(worker);
    return worker;
  }
  function pump() {
    while (pending.length && !broken) {
      const worker = workers.find(item => !item.job) || (workers.length < size ? spawn() : null);
      if (!worker) return;
      const job = pending.shift(); worker.job = job;
      worker.postMessage({ id: job.id, kind: job.kind, file: job.file, size: job.size, resizeWidth: job.resizeWidth });
    }
  }
  return {
    get available() { return supported && !broken; },
    run(message, { priority = false } = {}) {
      if (!this.available) return Promise.reject(workerError('No preview worker.'));
      return new Promise((resolve, reject) => {
        const job = { id: ++seq, ...message, resolve, reject };
        if (priority) pending.unshift(job); else pending.push(job);
        pump();
      });
    },
  };
}
const previewPool = createPreviewPool(2);
// Decode gate for the main-thread fallback: a 24 MP frame is ~96 MB RGBA, so 12 parallel uploads
// must not decode 12 at once. Two at a time, independent of the network pool; a finishing decode
// hands its slot straight on.
const decodeGate = (() => {
  let active = 0; const waiting = []; const MAX = 2;
  return async fn => {
    if (active >= MAX) await new Promise(resolve => waiting.push(resolve)); else active += 1;
    try { return await fn(); }
    finally { const next = waiting.shift(); if (next) next(); else active -= 1; }
  };
})();
// The file's pixel size from its header, read once per File (the queue thumbnail and the preview both
// ask) — it decides how wide to decode (decodeWidth) on either path, so a small image is never upscaled.
const fileDims = new WeakMap();   // File → Promise<{ width, height } | null>
function headerDimensions(file) {
  if (!fileDims.has(file)) fileDims.set(file, file.slice(0, HEADER_BYTES).arrayBuffer().then(buffer => imageDimensions(new Uint8Array(buffer))).catch(() => null));
  return fileDims.get(file);
}
const decodeWidthFor = async (file, max) => decodeWidth(await headerDimensions(file), file.size, max);
// The worker first; if it can't take the file (HEIC outside Safari, or no worker at all) the same
// routine runs here, gated, and produces the real error message for that file only.
async function watermarkedPreview(file) {
  const resizeWidth = await decodeWidthFor(file, PREVIEW_MAX);
  if (previewPool.available) {
    try { const { preview, thumb, width, height } = await previewPool.run({ kind: 'preview', file, resizeWidth }); return Object.assign(preview, { thumb, width, height }); }
    catch (error) { if (!error.worker) throw error; }
  }
  return decodeGate(() => watermarkedPreviewOnMainThread(file, resizeWidth));
}
// Thumbnails ride along after the main upload. An older Worker (404) or an unmigrated database
// (503) just means tiles keep using the preview — never fail the photo for it.
async function uploadThumb(photoId, thumb) {
  if (!photoId || !thumb) return;
  try { await fetch(apiUrl(`/api/admin/photos/${photoId}/thumb`), { method: 'POST', headers: { authorization: `Bearer ${getToken()}`, 'content-type': thumb.type || 'image/jpeg' }, body: thumb, signal: AbortSignal.timeout(30000) }); }
  catch { /* optional */ }
}

// ── Upload: file selection & drag/drop ────────────────────────────────────────

let adminFiles = [];
let uploadBusy = false;
const dropZone = document.getElementById('adminDropZone');
const photoInput = document.getElementById('adminPhotoInput');
const retryUploadBtn = document.getElementById('retryUploadBtn');
// What's left to retry after a batch leaves some photos unsent: { sessionId, items, rows, publish }
// (`rows` are the same <li> elements from the original pick, kept in sync by index; `publish` means
// the draft was never published, so a clean retry publishes it).
let lastUpload = null;
function clearLastUpload() { lastUpload = null; retryUploadBtn.hidden = true; }
function offerRetry(upload, label) { lastUpload = upload; retryUploadBtn.hidden = false; retryUploadBtn.disabled = false; retryUploadBtn.textContent = label; }

// `kind` ('warning') colours a heads-up that isn't a failure — "1 file left out" must not read as red.
function setStatus(text, isError = false, kind = '') {
  const el = document.getElementById('uploadStatus');
  el.textContent = text;
  el.className = 'upload-status visible' + (isError ? ' error' : '');
  if (kind) el.dataset.kind = kind; else delete el.dataset.kind;
}

function clearStatus() {
  const el = document.getElementById('uploadStatus');
  el.textContent = '';
  el.className = 'upload-status';
  delete el.dataset.kind;
}

// One DOM write per frame: progress events arrive from up to 12 streams many times a second, so
// every live readout (ring, bytes, bar, speed, ETA, count) is keyed and flushed together in one
// requestAnimationFrame — the last write for a key wins and nothing reads layout in between.
const frameWrites = new Map(); let frameHandle = 0;
function queueWrite(key, write) {
  frameWrites.set(key, write);
  if (!frameHandle) frameHandle = requestAnimationFrame(() => { frameHandle = 0; const writes = [...frameWrites.values()]; frameWrites.clear(); writes.forEach(fn => fn()); });
}
// The visible progress line updates once per frame; the aria-live twin (#progressLive) repeats it
// at most every 2 s so screen readers hear "12 of 30 photos" without being flooded.
const liveAnnouncedAt = new WeakMap();
function announceProgress(el, text) {
  if (!el || !text) return;
  const now = performance.now(), last = liveAnnouncedAt.get(el);
  if (last !== undefined && now - last < 2000) return;   // the first one always goes out
  liveAnnouncedAt.set(el, now); el.textContent = text;
}
function paintProgress(ids, stats) {
  const view = formatProgress(stats);
  queueWrite(ids.wrap, () => {
    document.getElementById(ids.wrap).classList.remove('hidden');
    document.getElementById(ids.fill).style.width = `${view.percent}%`;
    document.getElementById(ids.count).textContent = view.count;
    document.getElementById(ids.speed).textContent = view.rate;
    document.getElementById(ids.eta).textContent = view.eta;
  });
  announceProgress(document.getElementById(ids.live), view.live);
}
const PROGRESS_IDS = { wrap: 'progressWrap', fill: 'progressFill', count: 'progressCount', speed: 'progressSpeed', eta: 'progressEta', live: 'progressLive' };
function setProgress(stats) { paintProgress(PROGRESS_IDS, stats); }
function hideProgress() {
  frameWrites.delete(PROGRESS_IDS.wrap);          // a queued frame must not un-hide it again
  const wrap = document.getElementById('progressWrap');
  wrap.classList.add('hidden');
  document.getElementById('progressFill').style.width = '0%';
  document.getElementById('progressLive').textContent = '';
}

const UNSUPPORTED_FILES = 'JPG, PNG, WebP or HEIC up to 25 MB each.';
function isSupportedPhoto(file) { return (['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || isHeic(file)) && file.size > 0 && file.size <= 25 * 1024 * 1024; }

function selectFiles(files) {
  if (uploadBusy) return;
  clearLastUpload();
  const selected = [...files];
  adminFiles = selected.filter(isSupportedPhoto);
  const rejected = selected.filter(file => !isSupportedPhoto(file));
  renderFileList();
  if (!adminFiles.length) { setStatus(rejected.length ? UNSUPPORTED_FILES : 'No photos in that pick. JPG, PNG, WebP or HEIC.', true); return; }
  if (rejected.length) setStatus(`${adminFiles.length} ready. ${rejected.length} left out (JPG, PNG, WebP or HEIC up to 25 MB): ${rejected.slice(0, 3).map(file => file.name).join(', ')}${rejected.length > 3 ? '…' : ''}.`, false, 'warning');
  else setStatus(`${plural(adminFiles.length, 'photo')} ready. Hit Publish.`);
  suggestFromExif(adminFiles);
  window.setTimeout(() => document.getElementById('publishBtn').scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
}

// ── Upload: conditions pre-filled from EXIF ───────────────────────────────────

// A pick's JPEGs (up to EXIF_SAMPLE of them, spread across the pick; the first 256 KB of each) are read for
// DateTimeOriginal and Model. The suggestion opens the Conditions panel with "Shot 06:41–08:05 on 17 Sept with a
// Canon EOS R6.", sets the date unless the crew typed one, and puts the camera in the photographer placeholder.
// Nothing the crew typed is ever overwritten; a later pick supersedes an earlier read still in flight.
const ADMIN_CONDITION_IDS = { breakName: 'adminBreakName', swellFt: 'adminSwell', wind: 'adminWind', tide: 'adminTide', photographer: 'adminPhotographer', nextDropAt: 'adminNextDrop' };
const EXIF_SAMPLE = 12, EXIF_HEAD_BYTES = 256 * 1024;
let exifRun = 0;
const isJpeg = file => file.type === 'image/jpeg' || /\.jpe?g$/i.test(file.name);
async function exifOf(file) { try { return readExif(await file.slice(0, EXIF_HEAD_BYTES).arrayBuffer()); } catch { return { dateTimeOriginal: null, model: null }; } }
function sampleFiles(files, count) { if (files.length <= count) return files; const step = (files.length - 1) / (count - 1); return Array.from({ length: count }, (_, i) => files[Math.round(i * step)]); }
document.getElementById('adminDate').addEventListener('input', event => { event.currentTarget.dataset.typed = '1'; });
async function suggestFromExif(files) {
  const run = ++exifRun;
  const hint = document.getElementById('exifHint');
  const jpegs = (files || []).filter(isJpeg);
  const suggestion = jpegs.length ? exifSuggestion(await Promise.all(sampleFiles(jpegs, EXIF_SAMPLE).map(exifOf))) : null;
  if (run !== exifRun) return;
  hint.hidden = !suggestion; hint.textContent = suggestion?.hint || '';
  if (!suggestion) return;
  document.getElementById('adminConditions').open = true;
  const dateInput = document.getElementById('adminDate');
  if (suggestion.date && !dateInput.dataset.typed) dateInput.value = suggestion.date;   // today's default isn't "typed"
  if (suggestion.model) document.getElementById('adminPhotographer').placeholder = `Who shot it · ${suggestion.model}`;
}
// The six condition fields of either form as the contract payload (null for anything empty).
function readConditions(ids) { return conditionsPayload(Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, document.getElementById(id).value]))); }
function fillConditions(ids, conditions, nextDropAt) {
  const c = conditions || {};
  for (const [key, id] of Object.entries(ids)) {
    const el = document.getElementById(id);
    el.value = key === 'nextDropAt' ? isoToDatetimeLocal(nextDropAt ?? c.nextDropAt) : c[key] === null || c[key] === undefined ? '' : String(c[key]);
  }
}

// ── Upload: live per-photo rows ───────────────────────────────────────────────

// Queue thumbnails: ~96 px JPEGs made by the preview worker (or createImageBitmap here), handed
// over as ~3 KB data: URLs, cached per File and only requested for rows the crew can see — 300
// picked files no longer mean 300 full decodes. (Not blobs: URL.createObjectURL is a synchronous
// browser-process round trip that measured ~20 ms per thumbnail mid-batch.) A row leaving the
// list's viewport drops its <img> src so the decoded pixels go too; the string stays cached, so
// scrolling back is instant. With neither worker nor createImageBitmap (old Safari) the row falls
// back to an object URL of the file itself, as before.
const queueThumbs = new WeakMap();   // File → Promise<string | null>
async function queueThumbOnMainThread(file, resizeWidth = null) {
  if (typeof createImageBitmap !== 'function') return null;
  const img = await createImageBitmap(file, resizeWidth ? { resizeWidth, resizeQuality: 'high' } : {});
  const [width, height] = fitWithin(img.width, img.height, QUEUE_THUMB_PX);
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(img, 0, 0, width, height); img.close();
  return canvas.toDataURL('image/jpeg', .7);
}
function queueThumbFor(file) {
  if (!queueThumbs.has(file)) {
    const width = decodeWidthFor(file, QUEUE_THUMB_PX);
    const viaWorker = previewPool.available ? width.then(resizeWidth => previewPool.run({ kind: 'thumb', file, size: QUEUE_THUMB_PX, resizeWidth }, { priority: true })).then(result => result.thumb) : Promise.reject(Object.assign(new Error(), { worker: true }));
    queueThumbs.set(file, viaWorker.catch(() => decodeGate(async () => queueThumbOnMainThread(file, await width))).catch(() => null));
  }
  return queueThumbs.get(file);
}
const queueRowFiles = new WeakMap();   // <li> → File
function showQueueThumb(row) {
  const image = row.querySelector('img'); const file = queueRowFiles.get(row);
  if (!image || !file || image.dataset.thumb) return;
  image.dataset.thumb = 'pending';
  queueThumbFor(file).then(thumb => {
    if (!row.isConnected || image.dataset.thumb !== 'pending') return;
    if (thumb) image.src = thumb;
    else { const url = URL.createObjectURL(file); image.onload = image.onerror = () => URL.revokeObjectURL(url); image.src = url; }   // the object URL dies as soon as the pixels are painted
    image.dataset.thumb = 'shown';
  });
}
function releaseQueueThumb(row) {
  const image = row.querySelector('img');
  if (image?.dataset.thumb === 'shown') { image.removeAttribute('src'); delete image.dataset.thumb; }
}
function watchQueueThumbs(list) {
  const rows = list.querySelectorAll('.photo-row');
  if (!('IntersectionObserver' in window)) { rows.forEach(showQueueThumb); return null; }
  const observer = new IntersectionObserver(entries => { for (const entry of entries) (entry.isIntersecting ? showQueueThumb : releaseQueueThumb)(entry.target); }, { root: list, rootMargin: '160px 0px' });
  rows.forEach(row => observer.observe(row));
  return observer;
}
const ROW_LABELS = { waiting: 'Waiting', uploading: 'Sending…', done: 'Sent', failed: 'Failed', skipped: 'Skipped' };
// Matches the SVG ring's r=15 in photoRow() below — the circle's stroke-dashoffset walks from this
// (empty) down to 0 (full) as bytes go out, then resets so the next file starts from empty again.
const RING_CIRCUMFERENCE = 2 * Math.PI * 15;
// One list row: thumbnail with a status overlay, filename + size, optional tag and trailing control.
function photoRow(file, { tag = '', control } = {}) {
  const row = document.createElement('li'); row.className = 'photo-row'; row.dataset.state = 'waiting';
  const thumb = document.createElement('div'); thumb.className = 'photo-row-thumb';
  const image = document.createElement('img'); image.alt = ''; image.decoding = 'async';   // src arrives from showQueueThumb once the row is in view
  const status = document.createElement('i'); status.className = 'photo-row-status'; status.setAttribute('role', 'img'); status.setAttribute('aria-label', ROW_LABELS.waiting);
  // Upload progress ring: plain track + a fill circle whose stroke-dashoffset tracks bytes sent.
  // Drawn after `status` so it sits on top of the dark scrim, visible only while uploading; the
  // same centered spot then shows the done/failed/skipped glyph, never a relocated corner badge.
  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ring.setAttribute('class', 'photo-row-ring'); ring.setAttribute('viewBox', '0 0 36 36'); ring.setAttribute('aria-hidden', 'true');
  ring.innerHTML = '<circle class="ring-track" cx="18" cy="18" r="15"/><circle class="ring-fill" cx="18" cy="18" r="15"/>';
  thumb.append(image, status, ring);
  const name = document.createElement('span'); name.className = 'photo-row-name'; name.textContent = file.name;
  const size = document.createElement('small'); size.dataset.total = file.size; size.textContent = `${(file.size / 1048576).toFixed(1)} MB`; name.append(size);
  const badge = document.createElement('em'); badge.className = 'photo-row-tag'; badge.textContent = tag; badge.title = tag;
  row.append(thumb, name, badge);
  if (control) row.append(control);
  queueRowFiles.set(row, file);
  return row;
}
function setRowState(row, state, { tag, kind, title } = {}) {
  if (!row) return;
  frameWrites.delete(row);                        // a stale byte readout must not land after the state change
  row.dataset.state = state;
  const status = row.querySelector('.photo-row-status');
  status.setAttribute('aria-label', title || ROW_LABELS[state] || state); status.title = title || '';
  if (tag !== undefined) { const badge = row.querySelector('.photo-row-tag'); badge.textContent = tag; badge.title = tag; if (kind) badge.dataset.kind = kind; else delete badge.dataset.kind; }
  // Every state change is a fresh start for the ring/byte readout — setRowProgress fills them
  // back in while that particular attempt is actually sending.
  const ring = row.querySelector('.ring-fill'); if (ring) ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
  const size = row.querySelector('.photo-row-name small'); if (size) size.textContent = `${(Number(size.dataset.total) / 1048576).toFixed(1)} MB`;
  // Twelve streams can start in the same tick; one scroll per frame, to the latest, is enough.
  if (state === 'uploading') queueWrite('scroll-row', () => row.scrollIntoView({ block: 'nearest' }));
}
// Live bytes-sent readout for one row: fills the ring and swaps the size label to "x.x / y.y MB".
function setRowProgress(row, loaded, total) {
  if (!row || !total) return;
  queueWrite(row, () => {
    const ring = row.querySelector('.ring-fill');
    if (ring) ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - Math.min(1, loaded / total)));
    const size = row.querySelector('.photo-row-name small');
    if (size) size.textContent = `${(loaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`;
  });
}
// Translate one upload result into a row state so both flows show identical ticks.
function markRowFromResult(row, state, detail) {
  if (state === 'progress') return setRowProgress(row, detail.loaded, detail.total);
  if (state === 'failed') return setRowState(row, 'failed', { tag: 'Failed', kind: 'error', title: detail?.message });
  if (state === 'waiting') return setRowState(row, 'waiting', { tag: detail?.cancelled ? 'Not sent' : '' });
  if (state !== 'done') return setRowState(row, state, { tag: '' });
  if (detail?.skipped) return setRowState(row, 'skipped', { tag: 'Already here' });
  if (detail?.duplicate === 'renamed') return setRowState(row, 'done', { tag: `Saved as ${detail.filename}`, kind: 'ok' });
  if (detail?.duplicate === 'replaced') return setRowState(row, 'done', { tag: 'Replaced', kind: 'ok' });
  setRowState(row, 'done', { tag: '' });
}

let queueObserver = null;   // IntersectionObserver feeding thumbnails to the Upload tab list.
function renderFileList() {
  document.getElementById('publishBtn').disabled = uploadBusy || !adminFiles.length;
  const container = document.getElementById('fileQueue'); container.replaceChildren(); container.hidden = !adminFiles.length;
  delete container.dataset.uploading; delete container.dataset.finished;
  queueObserver?.disconnect(); queueObserver = null;
  if (!adminFiles.length) return;
  const header = document.createElement('div'); header.className = 'file-queue-head';
  const summary = document.createElement('strong'); summary.textContent = `${adminFiles.length} photos · ${(adminFiles.reduce((sum, file) => sum + file.size, 0) / 1048576).toFixed(1)} MB`;
  const clear = document.createElement('button'); clear.type = 'button'; clear.textContent = 'Clear'; clear.disabled = uploadBusy;
  clear.addEventListener('click', () => { adminFiles = []; photoInput.value = ''; renderFileList(); clearStatus(); clearLastUpload(); });
  header.append(summary, clear); const list = document.createElement('ul'); list.className = 'photo-list';
  adminFiles.forEach((file, index) => {
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove'; remove.disabled = uploadBusy; remove.setAttribute('aria-label', `Remove ${file.name}`);
    remove.addEventListener('click', () => { adminFiles.splice(index, 1); renderFileList(); });
    list.append(photoRow(file, { control: remove }));
  });
  container.append(header, list);
  queueObserver = watchQueueThumbs(list);
}
document.getElementById('choosePhotos').addEventListener('click', () => photoInput.click());
// A selection that hasn't been published is work too: 300 picked photos vanish on a pull-to-refresh
// or "Back to site". `leaving` lets a confirmed back-link click through without a second prompt.
let leaving = false;
const hasPendingWork = () => uploadBusy || adminFiles.length > 0 || Boolean(uploadMoreModal.open && moreUpload?.items?.length);
window.addEventListener('beforeunload', event => { if (leaving || !hasPendingWork()) return; event.preventDefault(); event.returnValue = ''; });
document.querySelector('.back-link')?.addEventListener('click', async event => {
  if (!adminFiles.length || uploadBusy) return;   // mid-upload the native beforeunload prompt already guards the tab
  event.preventDefault();
  const href = event.currentTarget.href, count = adminFiles.length;
  if (!await confirmAction({ title: 'Leave the studio?', copy: `${plural(count, 'photo')} not published yet — leaving drops ${count === 1 ? 'it' : 'them'}.`, confirmLabel: 'Leave' })) return;
  leaving = true; window.location.assign(href);
});

photoInput.addEventListener('click', (e) => { e.target.value = null; });
photoInput.addEventListener('change', (e) => selectFiles(e.target.files));
['dragenter', 'dragover'].forEach((t) => dropZone.addEventListener(t, (e) => { e.preventDefault(); dropZone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((t) => dropZone.addEventListener(t, (e) => { e.preventDefault(); dropZone.classList.remove('dragging'); }));
dropZone.addEventListener('drop', (e) => selectFiles(e.dataTransfer.files));

// ── Upload: sign in again mid-batch ───────────────────────────────────────────

// An expired token used to 401 every remaining file and lose the batch. Now the first 401 pauses
// every stream (the ones already in flight retry afterwards), shows #reauthPanel inline — inside
// the Add-photos dialog when that flow is running — and the batch carries on once the crew signs
// in again. The draft and everything already sent stay put; Stop while paused cancels as usual.
const reauthPanel = document.getElementById('reauthPanel');
let reauthPending = null;   // { promise, resolve, reject } while the batch waits for a fresh sign-in
const batchStatus = (text, isError, kind) => (uploadMoreModal.open ? setMoreStatus : setStatus)(text, isError, kind);
// A 401 to a request that went out with a token the crew has since replaced (twelve streams were in
// flight when the first one paused the batch; the rest answer after the sign-in) is not a new expiry:
// the caller simply retries with the fresh token instead of raising the panel again.
function tokenRenewedSince(error) { return typeof error.token === 'string' && error.token !== getToken(); }
function requireReauth() {
  if (reauthPending) return reauthPending.promise;
  const pending = {};
  pending.promise = new Promise((resolve, reject) => { pending.resolve = resolve; pending.reject = reject; });
  reauthPending = pending;
  const host = uploadMoreModal.open ? uploadMoreModal.querySelector('.modal-body') : document.getElementById('tab-upload');
  if (reauthPanel.parentNode !== host) host.append(reauthPanel);
  document.getElementById('reauthError').textContent = ''; document.getElementById('reauthPassword').value = '';
  document.getElementById('reauthCode').value = ''; document.getElementById('reauthCodeField').hidden = true;   // W4-C: asked for only if the Worker asks
  reauthPanel.hidden = false;
  batchStatus('Paused — your sign-in expired. Sign in again below and it carries on; nothing is lost.', false, 'warning');
  reauthPanel.scrollIntoView({ block: 'nearest' });
  document.getElementById('reauthPassword').focus();
  // The crew may have wandered to another tab while the batch ran: the panel is on the Upload tab, so say so.
  if (host.id === 'tab-upload' && !host.classList.contains('active')) toast('Paused — sign in again on the Upload tab', 'info', { action: { label: 'Open the Upload tab', run: () => { activateTab(document.querySelector('.tab-btn[data-tab="upload"]'), { focusPanel: false }); document.getElementById('reauthPassword').focus(); } } });
  return pending.promise;
}
function settleReauth(error) {
  const pending = reauthPending; reauthPending = null;
  reauthPanel.hidden = true;
  if (!pending) return;
  if (error) pending.reject(error); else pending.resolve();
}
// Cancel gives the batch up instead of signing in — the same stop as the progress card's Stop button,
// which is out of reach while the paused call is the pre-flight or the create (the card only shows
// once photos move). The form unlocks through the batch's own finally; what was sent stays put.
const reauthCancelled = () => Object.assign(new Error('Stopped — you are signed out. Sign in again when you are ready; nothing already sent is lost.'), { cancelled: true });
document.getElementById('reauthCancelBtn').addEventListener('click', () => { if (uploadBusy) cancelUpload(reauthCancelled()); else settleReauth(reauthCancelled()); });
reauthPanel.addEventListener('submit', async event => {
  event.preventDefault();
  const button = reauthPanel.querySelector('button[type=submit]'); const errorEl = document.getElementById('reauthError');
  button.disabled = true; errorEl.textContent = '';
  const codeField = document.getElementById('reauthCodeField'); const codeEl = document.getElementById('reauthCode');
  try {
    // W4-C: the name comes from the remembered sign-in; the code field appears only if the Worker asks.
    await loginWithPassword(document.getElementById('reauthPassword').value, { code: codeEl.value.trim() });
    codeEl.value = ''; codeField.hidden = true;
    batchStatus('Signed in — carrying on.');
    settleReauth();
  } catch (err) {
    errorEl.textContent = loginErrorMessage(err);
    if (err instanceof TotpNeeded) { codeField.hidden = false; codeEl.value = ''; codeEl.focus(); }
  }
  finally { button.disabled = false; }
});
// Wrap the one-off calls around a batch (pre-flight, create, publish) so an expired token pauses
// for a sign-in instead of throwing the crew to the login screen with a draft half-made.
async function withReauth(fn) {
  for (;;) {
    try { return await fn(); }
    catch (error) { if (!error.unauthorized) throw error; if (!tokenRenewedSince(error)) await requireReauth(); }
  }
}

// ── Upload: resumable batches (a manifest in IndexedDB) ──────────────────────

// A 300-photo batch survives a reload, a crashed tab or a phone that ran out of battery: while a
// batch runs, a manifest of the session and its files is kept in IndexedDB and each file is ticked
// off as it lands. On the next visit the studio offers "Resume publishing …?" and the crew re-picks
// the same photos (File System Access where it exists, the file input otherwise); files already
// ticked off are left out, the rest go into the Add-photos flow for that session. Publishing stays
// manual — a resumed batch never publishes anything by itself.
// Only names, sizes and timestamps are stored: never a photo, never a token. Everything here is
// wrapped: private mode, a blocked or full store and an old browser simply mean no resume offer.
const UPLOAD_DB = 'soi-uploads', UPLOAD_STORE = 'batches', UPLOAD_MANIFEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const fileKey = file => `${file.name}\u0000${file.size}\u0000${file.lastModified || 0}`;
function openUploadDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no IndexedDB'));
    const request = indexedDB.open(UPLOAD_DB, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(UPLOAD_STORE)) request.result.createObjectStore(UPLOAD_STORE, { keyPath: 'sessionId' }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB unavailable'));
    request.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}
async function withManifests(mode, run) {
  let db = null;
  try {
    db = await openUploadDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(UPLOAD_STORE, mode);
      const result = run(tx.objectStore(UPLOAD_STORE));
      tx.oncomplete = () => resolve(result?.result !== undefined ? result.result : result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('IndexedDB write failed'));
    });
  } catch { return null; }
  finally { db?.close(); }
}
const saveManifest = manifest => withManifests('readwrite', store => store.put(manifest));
const dropManifest = sessionId => withManifests('readwrite', store => store.delete(sessionId));
const allManifests = () => withManifests('readonly', store => store.getAll());
// The manifest for one batch; `items` are the files it was asked to send, in order.
function newManifest(sessionId, title, items) {
  return { sessionId, sessionTitle: title || '', createdAt: Date.now(), files: items.map(item => ({ name: item.file.name, size: item.file.size, lastModified: item.file.lastModified || 0, done: false, photoId: null })) };
}
// Writes are debounced to one per 1.5 s: a 300-file batch must not put the whole manifest per photo.
function manifestRecorder(manifest) {
  if (!manifest) return { done: () => {}, finish: async () => {} };
  let pending = null, dirty = false;
  const flush = () => { dirty = false; pending = null; saveManifest(manifest); };
  saveManifest(manifest);
  return {
    done(index, photoId) {
      const file = manifest.files[index]; if (!file || file.done) return;
      file.done = true; file.photoId = photoId || null; dirty = true;
      if (!pending) pending = setTimeout(flush, 1500);
    },
    // Everything sent (or the crew gave up on a batch with nothing left): the manifest goes.
    async finish() {
      clearTimeout(pending); pending = null;
      if (manifest.files.every(file => file.done)) return dropManifest(manifest.sessionId);
      if (dirty) await saveManifest(manifest);
    },
  };
}
// A batch that left photos behind because the link went (the device is offline, or a stream died
// with "Network dropped.") asks W4-B's service worker for a background sync: once the connection is
// back the worker wakes this tab with `soi-resume-uploads` — even one left in the background — and
// the resume offer above reopens. A deliberate Stop, or a refusal from the Worker, is not a reason.
const needsUploadSync = (failures, unsent, online) => (failures.length > 0 || unsent.length > 0) && (online === false || failures.some(failure => /Network dropped/.test(failure.message)));

// ── Upload: shared batch sender ───────────────────────────────────────────────

// Keep concurrent uploads under a memory budget: the Worker buffers each original fully,
// so several large files at once can exceed its limit and drop connections.
const UPLOAD_MAX_WORKERS = 3;
const UPLOAD_BYTE_BUDGET = 20 * 1024 * 1024; // ~20 MB of originals in flight at once (buffering server)
// A phone switching Wi-Fi/cellular mid-upload kills every in-flight socket at once — that's a
// network drop, not a dead link, and it can take several seconds for the OS to reconnect. Retry
// generously enough to ride that out instead of failing the whole batch over one handover.
const UPLOAD_MAX_ATTEMPTS = 6;
const UPLOAD_RETRY_BACKOFF_MS = attempt => Math.min(1500 * attempt, 6000);
// When the Worker streams uploads straight to storage it no longer holds whole files in
// memory, so many can run at once. Turn this on ONLY once that Worker path is deployed —
// against an old (buffering) Worker the streaming request format fails.
const UPLOAD_STREAMING = true;
const UPLOAD_STREAM_WORKERS = 12;
// Direct-to-R2 (W4-A): ask the Worker to sign a PUT so originals go straight to the bucket. Safe to
// leave on against any Worker — one that cannot sign answers 503 { fallback: 'stream' } and the whole
// batch uses the streaming route instead.
const UPLOAD_DIRECT = true;
// A wall-clock timeout kills every file on a slow uplink (12 streams on a 2 Mbps hotspot ≈ 6 min a
// file). Abort only when no bytes have moved for UPLOAD_STALL_MS; once the body is fully sent, give
// the Worker UPLOAD_RESPONSE_MS to answer.
const UPLOAD_STALL_MS = 30000;
const UPLOAD_RESPONSE_MS = 90000;
// Previews run ahead of the network: this many beyond the items already taken by an upload stream
// are decoding or ready, so a stream never waits for a decode and the decoders never idle waiting
// for a slot. (The worker pool still caps actual decodes at two.)
const PREVIEW_PREFETCH = 3;
// The streams share one uplink: start modest and let the measured KB/s decide how many run at once.
let uploadConcurrency = 4;
function tuneConcurrency(kbps) { uploadConcurrency = kbps > 4000 ? 12 : kbps > 1500 ? 8 : kbps > 500 ? 4 : 2; }
// Cancel: abort every in-flight request; workers stop taking new items and the batch resolves.
let cancelled = false;
const liveRequests = new Set();
function cancelUpload(reason = cancelledError()) { if (!uploadBusy) return; cancelled = true; liveRequests.forEach(xhr => xhr.abort()); settleReauth(reason); }
const cancelledError = () => Object.assign(new Error('Stopped.'), { cancelled: true });
const STOP_UPLOAD_COPY = "What's sent stays in the draft. Add the rest later.";

// Send originals plus watermarked previews and report combined progress.
// Each item is { file, onDuplicate? }. onProgress(stats) fires as bytes move (see formatProgress);
// onItem(index, state, detail) fires as each photo starts and finishes. `title` names the session in
// the IndexedDB manifest that lets an interrupted batch be resumed after a reload.
// Resolves with per-file results and failures, plus `stopped` and the `unsent` items after a cancel.
async function uploadPhotoBatch(sessionId, items, onProgress, onItem = () => {}, { title = '' } = {}) {
  const manifest = manifestRecorder(newManifest(sessionId, title, items));
  const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0);
  const startTime = performance.now();
  const fileProgress = new Array(items.length).fill(0);
  let active = 0; const slotWaiters = [];
  const wakeSlots = () => slotWaiters.splice(0).forEach(resolve => resolve());
  const results = []; const failures = [];
  const report = () => {
    const uploaded = fileProgress.reduce((a, b) => a + b, 0);
    const elapsed = (performance.now() - startTime) / 1000;
    const speed = (uploaded / 1024) / Math.max(elapsed, 0.1);
    const remaining = Math.max(0, totalBytes - uploaded) / 1024;
    // The first seconds are ramp-up noise; after that the link speed sets the pool size.
    if (elapsed >= 3 && uploaded > 0) { const before = uploadConcurrency; tuneConcurrency(speed); if (uploadConcurrency > before) wakeSlots(); }
    onProgress({ percent: totalBytes ? (uploaded / totalBytes) * 100 : 0, speed, etaSeconds: speed > 0 ? remaining / speed : null, done: results.length, total: items.length, sentBytes: uploaded, totalBytes });
  };

  // ── Direct to R2 (W4-A) ──
  // The Worker signs a 15-minute PUT and the browser sends the original straight to the bucket, so a
  // 20 MB photo never passes through the Worker; only the small preview and thumb are posted to it
  // afterwards (`complete`). One presign decides for the whole batch whether the route exists (a
  // Worker without the R2 secrets answers 503 { fallback: 'stream' }); after that a file whose PUT
  // the bucket refuses falls back to the streaming route on its own, so a batch can mix the two.
  // Every attempt after the first re-presigns (a fresh key) and carries onDuplicate=skip, so a lost
  // reply cannot store the same photo twice — a skip answered to `complete` deletes the new object.
  let directUploads = null;   // null = not asked yet, true = signing, false = stream everything
  let directProbe = null;     // the batch's first presign: the other streams wait for its verdict before asking
  const directFailure = (message) => Object.assign(new Error(message), { direct: true });
  const directPlanFor = async (item) => {
    if (!UPLOAD_DIRECT || directUploads === false || cancelled) return null;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(item.file.type)) return null;   // HEIC and friends keep the streaming path they have today
    // Twelve streams start together, so the first presign answers for all of them: a Worker that
    // cannot sign is asked once, not twelve times. Every file still gets its own key afterwards.
    if (directProbe) { await directProbe.catch(() => {}); if (directUploads === false || cancelled) return null; }
    try {
      const attempt = apiRequest(`/api/admin/sessions/${sessionId}/uploads/presign`, { method: 'POST', body: JSON.stringify({ filename: item.file.name, contentType: item.file.type, size: item.file.size }), keepSession: true });
      if (!directProbe) directProbe = attempt;
      const plan = await attempt;
      directUploads = true;
      return plan?.uploadUrl ? plan : null;
    } catch (error) {
      if (error.unauthorized) throw error;                                                   // the pool pauses for a sign-in and tries again
      if (error.body?.fallback === 'stream' || error.status === 404) { directUploads = false; return null; }   // this Worker has no direct uploads (yet)
      if (error.status >= 400 && error.status < 500) throw error;                             // a real refusal (too big, wrong type, archived session)
      return null;                                                                            // a hiccup: send this one the streaming way
    }
  };
  // PUT the original to the bucket, then register it. The bucket sees exactly the headers the Worker
  // signed and never the crew token; a refusal there is a `direct` error, which streams the file instead.
  const uploadDirect = (item, preview, index, onDuplicate, plan) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(plan.method || 'PUT', plan.uploadUrl);
    Object.entries(plan.headers || {}).forEach(([name, value]) => xhr.setRequestHeader(name, value));
    let stall = null;
    const watch = (ms) => { clearTimeout(stall); stall = setTimeout(() => xhr.abort(), ms); };
    xhr.onabort = () => cancelled ? reject(cancelledError()) : reject(directFailure('Stalled — nothing sent for 30 s.'));
    xhr.upload.onprogress = (ev) => {
      watch(UPLOAD_STALL_MS);
      if (!ev.lengthComputable) return;
      const loaded = Math.min(item.file.size, item.file.size * ev.loaded / ev.total);
      fileProgress[index] = loaded;
      onItem(index, 'progress', { loaded, total: item.file.size });
      report();
    };
    xhr.upload.onload = () => watch(UPLOAD_RESPONSE_MS);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(directFailure(`Storage answered HTTP ${xhr.status}.`));
    xhr.onerror = () => reject(directFailure('Network dropped.'));
    xhr.onloadend = () => { clearTimeout(stall); liveRequests.delete(xhr); };
    liveRequests.add(xhr); watch(UPLOAD_STALL_MS);
    xhr.send(item.file);
  }).then(async () => {
    if (cancelled) throw cancelledError();
    fileProgress[index] = item.file.size; report();
    const params = new URLSearchParams({ photoId: plan.photoId, key: plan.key, filename: item.file.name, contentType: item.file.type });
    if (onDuplicate) params.set('onDuplicate', onDuplicate);
    if (preview.width && preview.height) { params.set('width', preview.width); params.set('height', preview.height); }   // preview pixel size: the aspect ratio for uncropped tiles
    // Body: [uint32 preview length LE][preview][thumb] — the streaming frame with the grid thumbnail
    // where the original would be, so one call registers both and no separate thumb POST is needed.
    const header = new Uint8Array(4); new DataView(header.buffer).setUint32(0, preview.size, true);
    const body = new Blob([header, preview, preview.thumb || new Blob([])]);
    try {
      return await apiRequest(`/api/admin/sessions/${sessionId}/uploads/complete?${params}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body, keepSession: true });
    } catch (error) {
      if (error.body?.missing) throw directFailure('The photo never reached storage.');   // it goes through the Worker instead
      if (error.unauthorized || (error.status >= 400 && error.status < 500)) throw error;   // a real refusal, or a pause for a sign-in
      throw Object.assign(error, { retryable: true });   // a dropped or overloaded reply: the whole photo goes again, as a duplicate 'skip'
    }
  });

  // Direct first where the Worker offers it, the streaming route otherwise — decided per file, and a
  // bucket that refuses one file only sends that file the old way.
  const uploadOne = (item, preview, index, onDuplicate) => directPlanFor(item)
    .then(plan => plan ? uploadDirect(item, preview, index, onDuplicate, plan) : uploadStreaming(item, preview, index, onDuplicate))
    .catch(error => { if (!error.direct) throw error; fileProgress[index] = 0; return uploadStreaming(item, preview, index, onDuplicate); });
  const uploadStreaming = (item, preview, index, onDuplicate) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const token = getToken();   // a 401 carries it: a stream sent before the crew signed in again is retried with the fresh token, not re-prompted
    let body;
    if (UPLOAD_STREAMING) {
      // Body: [uint32 preview length LE][preview][original]; metadata rides in the query string.
      const header = new Uint8Array(4); new DataView(header.buffer).setUint32(0, preview.size, true);
      body = new Blob([header, preview, item.file]);
      const params = new URLSearchParams({ type: item.file.type, filename: item.file.name });
      if (onDuplicate) params.set('onDuplicate', onDuplicate);
      if (preview.width && preview.height) { params.set('width', preview.width); params.set('height', preview.height); }   // preview pixel size: the aspect ratio for uncropped tiles
      xhr.open('POST', apiUrl(`/api/admin/sessions/${sessionId}/photos?${params}`));
      xhr.setRequestHeader('authorization', `Bearer ${token}`);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
    } else {
      const form = new FormData();
      form.append('file', item.file);
      form.append('preview', preview, `${item.file.name.replace(/\.[^.]+$/, '')}-preview.jpg`);
      if (onDuplicate) form.append('onDuplicate', onDuplicate);
      body = form;
      xhr.open('POST', apiUrl(`/api/admin/sessions/${sessionId}/photos`));
      xhr.setRequestHeader('authorization', `Bearer ${token}`);
    }
    const failRetryable = (message) => reject(Object.assign(new Error(message), { retryable: true }));
    let stall = null, stallReason = 'Stalled — nothing sent for 30 s.';
    const watch = (ms) => { clearTimeout(stall); stall = setTimeout(() => xhr.abort(), ms); };
    xhr.onabort = () => cancelled ? reject(cancelledError()) : failRetryable(stallReason);
    xhr.upload.onprogress = (ev) => {
      watch(UPLOAD_STALL_MS);                     // bytes moved: push the stall deadline out
      if (!ev.lengthComputable) return;
      // ev.total includes the tiny preview + header riding alongside the original; scaling against
      // the file's own size keeps this row's "x.x / y.y MB" matching the size already shown for it.
      const loaded = Math.min(item.file.size, item.file.size * ev.loaded / ev.total);
      fileProgress[index] = loaded;
      onItem(index, 'progress', { loaded, total: item.file.size });
      report();
    };
    xhr.upload.onload = () => { stallReason = 'Timed out.'; watch(UPLOAD_RESPONSE_MS); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        fileProgress[index] = item.file.size; report();
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error('Bad reply from the photo service.')); }
      } else if (xhr.status === 401) {
        reject(Object.assign(new Error('Signed out.'), { unauthorized: true, token }));   // uploadWithRetry pauses for a sign-in; not a failure
      } else {
        let detail = `HTTP ${xhr.status}`;
        try { detail = JSON.parse(xhr.responseText).error || detail; } catch { /* Non-JSON gateway response. */ }
        // 5xx and gateway responses are usually transient (the Worker was overloaded); 4xx are not.
        reject(Object.assign(new Error(detail), { retryable: xhr.status >= 500 }));
      }
    };
    xhr.onerror = () => failRetryable('Network dropped.');
    xhr.onloadend = () => { clearTimeout(stall); liveRequests.delete(xhr); };
    liveRequests.add(xhr); watch(UPLOAD_STALL_MS);
    xhr.send(body);
  });

  // Retry transient failures (network drop / stall / overloaded Worker) a couple of times. An
  // expired token is not an attempt: the whole pool waits for the crew to sign in again. Every
  // attempt after the first — in this batch or a later "Retry failed" — goes out as a duplicate
  // 'skip' (see uploadAttemptMode): the earlier attempt may have stored the photo although its
  // reply was lost, and sent plainly again the Worker would keep it twice.
  const uploadWithRetry = async (item, index, preview) => {
    for (let attempt = 1; ; attempt += 1) {
      if (reauthPending) await reauthPending.promise;
      if (cancelled) throw cancelledError();
      const retrying = Boolean(item.attempted); item.attempted = true;
      try { return settleUploadResult(retrying, await uploadOne(item, preview, index, uploadAttemptMode(item, retrying))); }
      catch (error) {
        if (error.unauthorized) { attempt -= 1; if (!tokenRenewedSince(error)) await requireReauth(); continue; }
        if (!error.retryable || attempt >= UPLOAD_MAX_ATTEMPTS) throw error;
        await new Promise(resolve => setTimeout(resolve, UPLOAD_RETRY_BACKOFF_MS(attempt)));
      }
    }
  };

  // A buffering Worker holds each original in memory, so cap the bytes in flight (not just the
  // request count) to stay under its limit; a file larger than the budget uploads alone. A
  // streaming Worker doesn't buffer, so we lift the byte cap and just run many at once.
  const byteBudget = UPLOAD_STREAMING ? Infinity : UPLOAD_BYTE_BUDGET;
  const workerCount = UPLOAD_STREAMING ? UPLOAD_STREAM_WORKERS : UPLOAD_MAX_WORKERS;
  let inFlightBytes = 0; const waiters = [];
  const acquire = (bytes) => (inFlightBytes === 0 || inFlightBytes + bytes <= byteBudget)
    ? (inFlightBytes += bytes, Promise.resolve())
    : new Promise(resolve => waiters.push({ bytes, resolve }));
  const release = (bytes) => {
    inFlightBytes -= bytes;
    for (let i = 0; i < waiters.length; ) {
      if (inFlightBytes === 0 || inFlightBytes + waiters[i].bytes <= byteBudget) { inFlightBytes += waiters[i].bytes; waiters.splice(i, 1)[0].resolve(); }
      else i += 1;
    }
  };

  onProgress({ percent: 0, speed: 0, etaSeconds: null, done: 0, total: items.length, sentBytes: 0, totalBytes });
  const queue = items.map((item, index) => ({ item, index }));
  let nextUpload = 0, nextPrepare = 0;
  const previews = new Map();   // index → Promise<preview>, filled ahead of the streams in order
  const prepare = () => {
    while (nextPrepare < queue.length && !cancelled && nextPrepare < nextUpload + PREVIEW_PREFETCH) {
      const { item, index } = queue[nextPrepare++];
      const pending = watermarkedPreview(item.file); pending.catch(() => {});   // the stream that takes it reports the error
      previews.set(index, pending);
    }
  };
  prepare();
  // Spawn the full pool; a worker only takes an item while the live limit allows, so a downgrade to
  // 2 streams bites mid-batch and an upgrade to 12 wakes the idle ones. Cancel drains the pool.
  const limit = () => UPLOAD_STREAMING ? uploadConcurrency : workerCount;
  await Promise.all(Array.from({ length: Math.min(workerCount, queue.length) }, async () => {
    while (nextUpload < queue.length && !cancelled) {
      if (active >= limit()) { await new Promise(resolve => slotWaiters.push(resolve)); continue; }
      active += 1;
      const { item, index } = queue[nextUpload++]; prepare();
      await acquire(item.file.size);
      onItem(index, 'uploading');
      try {
        if (cancelled) throw cancelledError();
        const pending = previews.get(index); previews.delete(index);
        const preview = await pending;
        if (cancelled) throw cancelledError();
        const result = await uploadWithRetry(item, index, preview); results.push(result); onItem(index, 'done', result);
        manifest.done(index, result?.photoId);   // ticked off in the resume manifest as soon as the Worker has it
        if (result?.photoId && !result.skipped && !result.thumb) await uploadThumb(result.photoId, preview.thumb);   // a direct upload already sent it with `complete`
      }
      catch (error) { failures.push({ item, message: `${item.file.name}: ${error.message}` }); onItem(index, error.cancelled ? 'waiting' : 'failed', error); }
      finally { release(item.file.size); active -= 1; wakeSlots(); }
    }
  }));
  const unsent = queue.slice(nextUpload).map(entry => entry.item);
  await manifest.finish();   // nothing left to resume → the manifest goes; otherwise it waits for the next visit
  // Feature-detected: no service worker or no Background Sync (Safari, Firefox) → the call answers false and the retry buttons stay in charge.
  if (needsUploadSync(failures, unsent, navigator.onLine)) window.SOIPWA?.requestUploadSync?.();
  return { results, failures, stopped: cancelled, unsent };
}

// ── Upload: publish ───────────────────────────────────────────────────────────

// Everything in the form locks except the cancel button inside the progress card.
function lockUploadForm() {
  uploadBusy = true;
  document.querySelectorAll('#uploadForm input, #uploadForm button:not(#cancelUploadBtn)').forEach(control => { control.disabled = true; });
  signOutBtn.disabled = true;
}
function unlockUploadForm() {
  cancelled = false; uploadBusy = false;
  document.querySelectorAll('#uploadForm input, #uploadForm button').forEach(control => { control.disabled = false; });
  signOutBtn.disabled = false;
  document.getElementById('publishBtn').disabled = !adminFiles.length;
}
// "Add photos" on a card, or "Upload more to that session" from the duplicate check with the
// files already picked.
function openUploadMoreWith(session, files) {
  moreUpload = { sessionId: session.id, title: session.title, items: [], duplicates: [], failedItems: [] };
  if (files?.length) prepareUploadMore(files); else morePhotoInput.click();
}

document.getElementById('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (uploadBusy) return;
  if (!adminFiles.length) return setStatus('Drop at least one photo first.', true);

  const publishBtn = document.getElementById('publishBtn');
  const queueEl = document.getElementById('fileQueue');
  const rows = [...queueEl.querySelectorAll('.photo-row')];
  const files = adminFiles;
  lockUploadForm();
  queueEl.dataset.uploading = 'true';
  publishBtn.innerHTML = 'Publishing… <span></span>'; publishBtn.classList.add('is-busy');
  hideProgress();
  // Leave the ticked list on screen; "Clear list" or a new selection resets it.
  const leaveTickedList = (done, label) => {
    adminFiles = [];
    photoInput.value = '';
    queueEl.dataset.finished = 'true';
    queueEl.querySelector('.file-queue-head strong').textContent = `${done} of ${rows.length} photo${rows.length === 1 ? '' : 's'} ${label}`;
    queueEl.querySelector('.file-queue-head button').textContent = 'Clear';
  };
  const rowsFor = list => list.map(item => rows[files.indexOf(item.file)]);
  let addTo = null;   // set when the crew picks "Upload more to that session" on the duplicate check

  try {
    const title = document.getElementById('adminTitle').value.trim();
    const date = document.getElementById('adminDate').value;
    const location = document.getElementById('adminLocation').value.trim();
    const pricePaise = Math.round(Number(document.getElementById('adminPrice').value) * 100);

    // Pre-flight with the cheapest authenticated GET: an expired token is caught here (sign in
    // inline, then carry on), not after a draft exists and 300 uploads have started failing one by
    // one. The same call brings the session list for the duplicate check.
    const { sessions } = await withReauth(() => apiRequest('/api/admin/dashboard', { keepSession: true }));
    const twin = findDuplicateSession(sessions, { date, location });
    if (twin) {
      const choice = await confirmAction({ title: 'Already got one.', copy: `A session at ${twin.location} on ${shortDate(date)} already exists — create another?`, confirmLabel: 'Create another', danger: false, alt: 'Upload more to that session' });
      if (choice === 'alt') { addTo = twin; return; }
      if (!choice) return;
    }
    const create = await withReauth(() => apiRequest('/api/admin/sessions', { method: 'POST', body: JSON.stringify({ title, date, location, pricePaise, ...readConditions(ADMIN_CONDITION_IDS) }), keepSession: true }));   // an older Worker ignores the condition keys

    const sessionId = create.session.id;
    const items = files.map(file => ({ file }));
    setStatus(`Uploading ${plural(items.length, 'photo')}…`);
    const { results, failures, stopped, unsent } = await uploadPhotoBatch(sessionId, items, setProgress, (index, state, detail) => markRowFromResult(rows[index], state, detail), { title });
    if (stopped) {
      // The draft stays private: what landed can be published from Sessions, the rest sent from here.
      const remaining = [...failures.map(f => f.item), ...unsent];
      leaveTickedList(results.length, 'in the draft');
      offerRetry({ sessionId, items: remaining, rows: rowsFor(remaining), publish: true }, `Send ${remaining.length} remaining`);
      setStatus(`Stopped. ${results.length} of ${rows.length} are in the draft — send the rest below, or publish it from Sessions.`, false, 'warning');
      flagFinishedInTitle('⚠ Upload stopped', `${results.length} of ${rows.length} sent — the draft is private.`);
      return;
    }
    if (!results.length) {
      const remaining = failures.map(f => f.item);
      leaveTickedList(0, 'in the draft');
      offerRetry({ sessionId, items: remaining, rows: rowsFor(remaining), publish: true }, `Retry failed (${remaining.length})`);
      setStatus(`All ${failures.length} failed — the draft is still private. Retry below. ${failures[0].message}`, true);
      flagFinishedInTitle('⚠ Upload stopped', failures[0].message);
      return;
    }

    // Publish whatever uploaded successfully; failed files (if any) can be retried straight into it. The new
    // Worker asks for a cover first (409) — the picker opens over these photos; backing out keeps the draft.
    if (!await publishSession(sessionId, title, { keepSession: true })) {
      leaveTickedList(results.length, 'in the draft');
      const remaining = failures.map(f => f.item);
      if (remaining.length) offerRetry({ sessionId, items: remaining, rows: rowsFor(remaining), publish: true }, `Retry failed (${remaining.length})`);
      setStatus(`Draft saved with ${plural(results.length, 'photo')} — it stays private until you pick a cover and publish from Sessions.`, false, 'warning');
      flagFinishedInTitle('⚠ Upload stopped', 'Draft saved — pick a cover to publish.');
      return;
    }
    leaveTickedList(results.length, 'published');
    window.SOI?.haptic?.([15]);
    if (failures.length) {
      const remaining = failures.map(f => f.item);
      offerRetry({ sessionId, items: remaining, rows: rowsFor(remaining) }, `Retry failed (${remaining.length})`);
      setStatus(`Live with ${results.length} of ${results.length + failures.length}. ${failures.length} failed — retry below. ${failures[0].message}`, true);
    } else {
      clearLastUpload();
      setStatus('Live. Faces are indexing — watch it in Sessions.');
      window.SOI?.splash?.({ at: publishBtn, symbol: 'stamp-sunburst', count: 12 });
    }
    flagFinishedInTitle('✓ Published', failures.length ? `${results.length} live, ${failures.length} failed — retry from the studio.` : `${plural(results.length, 'photo')} live. Faces are indexing.`);
  } catch (err) {
    setStatus(err.message || 'Upload failed. The draft is still private.', true);
    if (!isAuthenticated()) notifyCrew(err.message, 'error');   // kicked to the login screen: say why there too
    flagFinishedInTitle('⚠ Upload stopped', err.message);
  } finally {
    hideProgress();
    unlockUploadForm();
    publishBtn.innerHTML = 'Publish'; publishBtn.classList.remove('is-busy');
    delete queueEl.dataset.uploading;
    queueEl.querySelectorAll('button').forEach(control => { control.disabled = false; });
    // "Upload more to that session": the picked files move to that flow; the form keeps its values.
    if (addTo) { adminFiles = []; photoInput.value = ''; renderFileList(); clearStatus(); openUploadMoreWith(addTo, files); }
  }
});

// One tap resends exactly the photos that didn't make it — into the published session, or into the
// draft, which then publishes once everything is in.
retryUploadBtn.addEventListener('click', async () => {
  if (!lastUpload || uploadBusy) return;
  const { sessionId, items, rows, publish } = lastUpload;
  const queueEl = document.getElementById('fileQueue');
  lockUploadForm();
  retryUploadBtn.textContent = 'Retrying…';
  rows.forEach(row => setRowState(row, 'waiting', { tag: '' }));
  hideProgress();
  setStatus(items.length ? `Retrying ${plural(items.length, 'photo')}…` : 'Publishing…');
  try {
    const { results, failures, unsent, stopped } = await uploadPhotoBatch(sessionId, items, setProgress, (index, state, detail) => markRowFromResult(rows[index], state, detail), { title: document.getElementById('adminTitle').value.trim() });
    const remaining = [...failures.map(f => f.item), ...unsent];
    if (remaining.length) {
      offerRetry({ sessionId, items: remaining, rows: remaining.map(item => rows[items.indexOf(item)]), publish }, stopped ? `Send ${remaining.length} remaining` : `Retry failed (${remaining.length})`);
      setStatus(stopped ? `Stopped. ${results.length} sent, ${remaining.length} left — retry below.` : `${results.length} sent. ${remaining.length} still failing — ${failures[0]?.message || ''}`, !stopped, stopped ? 'warning' : '');
      flagFinishedInTitle('⚠ Upload stopped', `${remaining.length} still to send.`);
    } else {
      if (publish) {
        if (!await publishSession(sessionId, document.getElementById('adminTitle').value.trim(), { keepSession: true })) {
          offerRetry({ sessionId, items: [], rows: [], publish: true }, 'Publish draft');   // everything is in; only the cover step is left
          setStatus('All sent. The draft stays private until you pick a cover — Publish draft, or do it from Sessions.', false, 'warning');
          return;
        }
        const head = queueEl.querySelector('.file-queue-head strong');
        if (head) { const total = queueEl.querySelectorAll('.photo-row').length; head.textContent = `${queueEl.querySelectorAll('.photo-row[data-state="done"]').length} of ${total} photo${total === 1 ? '' : 's'} published`; }
      }
      clearLastUpload();
      setStatus(publish ? 'Live. Faces are indexing — watch it in Sessions.' : 'All caught up — faces are indexing.');
      window.SOI?.splash?.({ at: retryUploadBtn, symbol: 'stamp-sunburst', count: 6 });
      flagFinishedInTitle('✓ Published', `${plural(results.length, 'photo')} sent. Faces are indexing.`);
    }
    loadDashboard(true);
  } catch (err) {
    setStatus(err.message || 'Retry failed.', true);
    flagFinishedInTitle('⚠ Upload stopped', err.message);
  } finally {
    hideProgress();
    unlockUploadForm();
  }
});

// ── Upload: cancel ────────────────────────────────────────────────────────────

document.getElementById('cancelUploadBtn')?.addEventListener('click', async event => {
  event.preventDefault();                          // never let it submit the form it sits in
  if (!uploadBusy) return;
  if (!await confirmAction({ title: 'Stop uploading?', copy: STOP_UPLOAD_COPY, confirmLabel: 'Stop' })) return;
  cancelUpload();
});

// ── Upload: resume an interrupted batch ───────────────────────────────────────

// On sign-in, the newest manifest with photos still to send offers "Resume publishing Morning glass
// — 143 of 312 uploaded?". "Pick the same photos" re-opens the folder (the browser never keeps the
// files themselves): with the File System Access API the picker reopens where it was last time,
// otherwise it is the normal file input. Files are matched by name + size + last-modified, the ones
// already sent are dropped, and the rest go into the Add-photos flow for that session — which checks
// what is already there, so a photo that landed without being ticked off is caught a second time.
const resumePanel = document.getElementById('resumePanel');
const resumeFileInput = document.getElementById('resumeFileInput');
let resumeManifest = null;
function showResumeOffer(manifest) {
  resumeManifest = manifest;
  const done = manifest.files.filter(file => file.done).length;
  document.getElementById('resumeCopy').textContent = `${manifest.sessionTitle ? `“${manifest.sessionTitle}” — ` : ''}${done} of ${manifest.files.length} photos uploaded. Pick the same photos again and the rest go into that session; nothing is published until you say so.`;
  resumePanel.hidden = false;
  // A reload puts the page back where it was scrolled — often the bottom of a long queue — so the
  // offer, which sits above the form, would open out of sight. `nearest` leaves an already-visible
  // panel alone; the margin keeps the sticky topbar from covering the heading. Chromium restores
  // that old position as late as the `load` event, which can land after this ran, so it runs again then.
  const bringIntoView = () => {
    try {
      resumePanel.style.scrollMarginTop = `${(document.querySelector('.topbar')?.offsetHeight || 0) + 16}px`;
      resumePanel.scrollIntoView?.({ block: 'nearest' });
    } catch { /* an old engine without the options form */ }
  };
  bringIntoView();
  if (document.readyState !== 'complete') addEventListener('load', () => setTimeout(bringIntoView, 0), { once: true });
}
function hideResumeOffer() { resumePanel.hidden = true; resumeManifest = null; }
async function offerResume() {
  const manifests = await allManifests();
  if (!Array.isArray(manifests) || !manifests.length) return;
  const stale = manifests.filter(manifest => Date.now() - (manifest.createdAt || 0) > UPLOAD_MANIFEST_MAX_AGE_MS);
  stale.forEach(manifest => dropManifest(manifest.sessionId));   // a week old: the session has moved on
  const pending = manifests
    .filter(manifest => !stale.includes(manifest) && Array.isArray(manifest.files) && manifest.files.some(file => !file.done))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (pending.length) showResumeOffer(pending[0]);
}
// The picker: showOpenFilePicker keeps its own place between visits through `id`, so the crew lands
// back in the same folder. Anything else (Safari, Firefox, phones) falls back to the file input.
async function pickResumeFiles() {
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const handles = await window.showOpenFilePicker({ id: 'soi-session-photos', multiple: true, types: [{ description: 'Photos', accept: { 'image/*': ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'] } }] });
      return Promise.all(handles.map(handle => handle.getFile()));
    } catch (error) { if (error?.name === 'AbortError') return []; }   // cancelled the dialog: nothing to do
  }
  resumeFileInput.click();
  return null;   // the change handler carries on from here
}
function resumeWith(files) {
  if (!resumeManifest || !files?.length) return;
  const wanted = new Map(resumeManifest.files.filter(file => !file.done).map(file => [fileKey(file), file]));   // a manifest entry carries the same three fields a File does
  const matched = [...files].filter(file => wanted.has(fileKey(file)));
  const strays = files.length - matched.length;
  if (!matched.length) {
    setStatus(`None of those are from that batch. Pick the same folder — ${wanted.size} photo${wanted.size === 1 ? '' : 's'} still to send.`, true);
    return;
  }
  const session = { id: resumeManifest.sessionId, title: resumeManifest.sessionTitle };
  hideResumeOffer();
  openUploadMoreWith(session, matched);
  if (strays) toast(`${strays} photo${strays === 1 ? '' : 's'} from another batch left out.`, 'info');
}
document.getElementById('resumePickBtn')?.addEventListener('click', async () => {
  const files = await pickResumeFiles();
  if (files?.length) resumeWith(files);
});
resumeFileInput?.addEventListener('click', event => { event.target.value = null; });
resumeFileInput?.addEventListener('change', event => resumeWith([...event.target.files]));
document.getElementById('resumeDiscardBtn')?.addEventListener('click', async () => {
  const sessionId = resumeManifest?.sessionId;
  hideResumeOffer();
  if (sessionId) await dropManifest(sessionId);
  toast('Forgotten. The photos already uploaded are still in that session.', 'info');
});
// W4-B's service worker: a batch left behind offline registered a background sync (see
// needsUploadSync); when the connection is back the worker posts every studio tab this event through
// pwa.js. The worker holds no files, so all it can do is wake the page — the offer above reopens
// from the manifest, never over a batch that is running or a signed-out screen.
addEventListener('soi-resume-uploads', () => { if (isAuthenticated() && !uploadBusy && resumePanel.hidden) offerResume(); });

// ── Regenerate previews (sessions uploaded before the 600 px pipeline) ───────

// Sessions uploaded before F5 carry 300 px previews and 200 px thumbs (and JPEG ones at that). This
// re-renders them with today's pipeline — 600/320 px, WebP where the browser encodes it — entirely in
// the browser: each original is fetched through the crew's own signed link, blurred and watermarked by
// the same preview worker the upload uses, and sent back as a preview (PUT) and a thumb (POST).
// **Originals are never re-uploaded**, nothing is deleted, and stopping half-way simply leaves the
// rest on their old previews. Two at a time, so a session of 300 doesn't saturate the uplink.
const REGEN_WORKERS = 2;
let regenRun = null;   // { cancelled } while a run is going
const regenStopBtn = document.getElementById('regenStopBtn');
regenStopBtn?.addEventListener('click', () => { if (regenRun) { regenRun.cancelled = true; regenStopBtn.disabled = true; } });
function setRegenStatus(text) {
  const panel = document.getElementById('regenPanel');
  panel.hidden = !text;
  document.getElementById('regenStatus').textContent = text;   // Stop is armed when a run starts, never re-armed by a progress line
}
// One photo: fetch the original through its signed crew link, re-render, send both images back.
async function regenerateOne(photo) {
  const response = await fetch(photo.originalUrl, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw Object.assign(new Error(response.status === 401 || response.status === 403 ? 'link expired' : `HTTP ${response.status}`), { expired: response.status === 401 || response.status === 403 });
  const blob = await response.blob();
  const file = new File([blob], photo.filename || 'photo.jpg', { type: blob.type || 'image/jpeg' });
  const preview = await watermarkedPreview(file);
  const params = preview.width && preview.height ? `?width=${preview.width}&height=${preview.height}` : '';   // fills in a pre-0012 photo's pixel size
  await apiRequest(`/api/admin/photos/${photo.id}/preview${params}`, { method: 'PUT', headers: { 'content-type': preview.type || 'image/jpeg' }, body: preview, keepSession: true });
  if (preview.thumb) await uploadThumb(photo.id, preview.thumb);   // optional: a thumb route that 404s leaves tiles on the new preview
}
async function regeneratePreviews(sessionId, title) {
  if (uploadBusy || regenRun) return notifyCrew('Let the current upload finish first.');
  if (!await confirmAction({
    title: `Rebuild previews for “${title}”?`,
    copy: 'Every original is downloaded once and its blurred preview and grid thumbnail are made again with the current pipeline (600 px, WebP where your browser can). Originals are never touched. On a phone this is a lot of data — stay on this page while it runs.',
    confirmLabel: 'Rebuild previews', danger: false,
  })) return;
  regenRun = { cancelled: false };
  regenStopBtn.disabled = false;
  let photos = [];
  try { photos = (await apiRequest(`/api/admin/sessions/${sessionId}/photos`)).photos || []; }
  catch (error) { regenRun = null; setRegenStatus(''); return notifyCrew(error.message, 'error'); }
  if (!photos.length) { regenRun = null; setRegenStatus(''); return notifyCrew('That session has no photos yet.'); }
  let done = 0, failed = 0, next = 0; let firstError = '';
  const links = new Map(photos.map(photo => [photo.id, photo]));
  const say = () => setRegenStatus(`Rebuilding previews for “${title}” — ${done + failed} of ${photos.length}${failed ? ` · ${failed} failed` : ''}`);
  say();
  await Promise.all(Array.from({ length: Math.min(REGEN_WORKERS, photos.length) }, async () => {
    while (next < photos.length && !regenRun.cancelled) {
      const photo = photos[next++];
      try { await regenerateOne(links.get(photo.id) || photo); done += 1; }
      catch (error) {
        // A link older than its 30-minute token: fetch the list again once and retry this photo.
        if (error.expired) {
          try {
            const fresh = (await apiRequest(`/api/admin/sessions/${sessionId}/photos`)).photos || [];
            fresh.forEach(item => links.set(item.id, item));
            await regenerateOne(links.get(photo.id) || photo); done += 1;
            say(); continue;
          } catch (retryError) { failed += 1; firstError = firstError || `${photo.filename}: ${retryError.message}`; }
        } else { failed += 1; firstError = firstError || `${photo.filename}: ${error.message}`; }
      }
      say();
    }
  }));
  const stopped = regenRun.cancelled;
  regenRun = null;
  setRegenStatus('');
  const summary = `${done} preview${done === 1 ? '' : 's'} rebuilt${stopped ? `, stopped with ${photos.length - done - failed} to go` : ''}${failed ? `. ${failed} failed — ${firstError}` : '.'}`;
  notifyCrew(summary, failed ? 'error' : 'success');
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

let dashInterval = null;

// Money strip on each card: GET /api/admin/stats runs alongside the dashboard call and never delays
// it — the cards render as soon as the sessions arrive and the strips fill in when the stats do. A
// 404 (a Worker deployed without the route yet), an unmigrated database or any other failure just
// leaves every strip hidden; a session nobody has searched reads "No searches yet".
async function fetchSessionStats() {
  try { return mergeSessionStats(await apiRequest('/api/admin/stats')); }
  catch { return null; }
}
function paintMoneyStrips(grid, stats) {
  grid.querySelectorAll('.d-card').forEach(card => {
    const strip = card.querySelector('.d-card-money'); if (!strip) return;
    const view = stats ? formatMoneyStrip(stats.get(card.dataset.sessionId)) : null;
    if (!view) { strip.hidden = true; return; }
    strip.textContent = view.text; strip.title = view.detail; strip.classList.toggle('is-muted', view.muted); strip.hidden = false;
  });
}
let dashboardRender = 0;   // stats from an older load must not paint over a newer render
let dashboardSessions = new Map();   // id → session object from the last dashboard load

const sessionDateLabel = value => { const date = new Date(`${value}T12:00:00`); return Number.isNaN(date.getTime()) ? (value || '—') : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); };
// The 8-second silent poll only stands down while a card's "More" menu is open, a dialog is up or a button in the
// grid is being pressed — states a re-render would visibly break. It used to wait for :hover / :focus-within to
// clear as well, and never ran again after a delete (F27 focuses the next card), a closed dialog (focus returns to
// a card button) or a tap on a phone (where :hover sticks): focus is carried across the render instead, below.
function dashboardPollBlocked(grid) {
  return Boolean(grid.querySelector('.card-more[open]') || document.querySelector('dialog[open]') || grid.matches(':active'));
}
// What the crew had focused inside the grid — the card's session id plus the control's own class (or its tag for
// the "More" summary) — so the same control is focused after the cards are rebuilt; when that control is gone (a
// Publish button after publishing, say) the card itself takes the focus rather than <body>.
function rememberGridFocus(grid) {
  const active = document.activeElement;
  if (!active || active === grid || !grid.contains(active)) return null;
  const card = active.closest('.d-card'); if (!card) return null;
  const control = active === card ? '' : [...active.classList].find(name => name.endsWith('-btn')) || active.tagName.toLowerCase();
  return { sessionId: card.dataset.sessionId, control };
}
function restoreGridFocus(grid, memo) {
  if (!memo) return;
  const card = grid.querySelector(`.d-card[data-session-id="${CSS.escape(memo.sessionId)}"]`); if (!card) return;
  const target = (memo.control && card.querySelector(memo.control.includes('-') ? `.${memo.control}` : memo.control)) || card;
  target.focus({ preventScroll: true });
}
async function loadDashboard(silent = false) {
  const grid = document.getElementById('dashboardGrid');
  if (!isAuthenticated()) return;
  if (silent && dashboardPollBlocked(grid)) return;   // wait for the next tick instead
  const focusMemo = rememberGridFocus(grid);
  if (!silent) grid.innerHTML = '<p class="loading-msg">Loading sessions…</p>';
  try {
    const requestToken = getToken();
    const statsPending = fetchSessionStats();                    // in parallel; awaited only after the cards are on screen
    const { sessions } = await apiRequest('/api/admin/dashboard');
    if (!isAuthenticated() || getToken() !== requestToken) return;
    const render = ++dashboardRender;
    if (!sessions.length) {
      grid.innerHTML = '<p class="empty-msg">No sessions yet. Upload one.</p>';
      updateMetrics([]);
      if (dashInterval) { clearInterval(dashInterval); dashInterval = null; }
      return;
    }

    updateMetrics(sessions);
    dashboardSessions = new Map(sessions.map(session => [session.id, session]));   // the edit modal and bulk "Move to…" read from here

    let hasPending = false;
    const openMenu = grid.querySelector('.card-more[open]')?.closest('.d-card')?.dataset.sessionId;   // survive a silent re-render
    grid.innerHTML = sessions.map((s) => {
      const total = Number(s.total_photos || 0);
      const indexed = Number(s.indexed_photos || 0);
      const pending = Number(s.pending_photos || 0);
      const failed = Number(s.failed_photos || 0);
      const pct = total > 0 ? Math.round((indexed / total) * 100) : 0;
      const isDone = total > 0 && indexed === total;

      if (pending > 0) hasPending = true;

      let badgeHtml = '';
      if (total === 0) {
        badgeHtml = `<span class="indexing-badge empty">Empty</span>`;
      } else if (isDone) {
        badgeHtml = `<span class="indexing-badge done">Indexed</span>`;
      } else if (pending > 0) {
        badgeHtml = `<span class="indexing-badge processing"><span class="pulse-dot"></span> Indexing · ${pct}%</span>`;
      } else if (failed > 0) {
        badgeHtml = `<span class="indexing-badge warning">${failed} failed</span>`;
      } else {
        badgeHtml = `<span class="indexing-badge processing">${pct}% indexed</span>`;
      }

      const priceRs = Math.round((s.price_paise ?? 70000) / 100);
      // Queue depth, ETA and grouped failure reasons (new Worker); conditions line (migration 0014). Both optional.
      const indexingView = formatIndexingLine(s.indexing);
      const indexingHtml = indexingView ? `${indexingView.line ? `<p class="d-card-indexing">${escHtml(indexingView.line)}</p>` : ''}${indexingView.failures.length ? `<ul class="d-card-failures" aria-label="Why photos failed">${indexingView.failures.map(item => `<li><b>${item.count} ×</b> ${escHtml(item.reason)}</li>`).join('')}</ul>` : ''}` : '';
      const conditionsLine = formatConditionsLine(s.conditions, s.nextDropAt);
      const conditionsHtml = conditionsLine ? `<p class="d-card-conditions"><b>Conditions</b> · ${escHtml(conditionsLine)}</p>` : '';

      return `
        <div class="d-card" data-session-id="${escHtml(s.id)}" tabindex="-1">
          <div class="d-card-head">
            <span class="d-card-title">${escHtml(s.title)}</span>
            <div style="display:flex;gap:8px;align-items:center;">
              ${badgeHtml}
              <span class="d-card-status ${escHtml(s.status)}">${escHtml(s.status)}</span>
            </div>
          </div>
          <div class="d-card-stats">
            <div><span>Date</span><strong style="font-size:13px;font-weight:500">${escHtml(sessionDateLabel(s.date))}</strong></div>
            <div><span>Break</span><strong style="font-size:13px;font-weight:500">${escHtml(s.location || '—')}</strong></div>
            <div><span>Indexed</span><strong>${pct}% (${indexed} / ${total})</strong></div>
            <div><span>Failed</span><strong>${failed}</strong></div>
            <div class="spacer"></div>
          </div>
          ${total > 0 ? `
            <div class="card-progress-track">
              <div class="card-progress-fill" style="width: ${pct}%;"></div>
            </div>
          ` : ''}
          ${indexingHtml}${conditionsHtml}
          <p class="d-card-money" hidden></p>
          <div class="action-group">
            ${s.status === 'draft' ? `<button class="btn-sm btn-publish publish-session-btn" data-session-id="${escHtml(s.id)}" data-session-title="${escHtml(s.title)}" ${total ? '' : 'disabled title="Add photos first."'}>Publish</button>` : ''}
            <button class="btn-sm btn-primary-sm view-photos-btn" data-session-id="${escHtml(s.id)}" data-session-title="${escHtml(s.title)}">Photos (${total})</button>
            <button class="btn-sm upload-more-btn" data-session-id="${escHtml(s.id)}" data-session-title="${escHtml(s.title)}" ${s.status === 'archived' ? 'disabled title="Archived — restore it first."' : ''}>Add photos</button>
            <details class="card-more">
              <summary class="btn-sm">More</summary>
              <div class="card-more-menu">
                <button class="btn-sm edit-session-btn" data-session-id="${escHtml(s.id)}" data-title="${escHtml(s.title)}" data-date="${escHtml(s.date || '')}" data-location="${escHtml(s.location || '')}" data-price="${priceRs}" data-status="${escHtml(s.status)}">Edit</button>
                ${failed > 0 && pending === 0 ? `<button class="btn-sm btn-retry retry-failed-btn" data-session-id="${escHtml(s.id)}">Retry ${failed} failed</button>` : ''}
                <button class="btn-sm reindex-btn" data-session-id="${escHtml(s.id)}">Force reindex</button>
                ${total > 0 ? `<button class="btn-sm regen-previews-btn" data-session-id="${escHtml(s.id)}" data-session-title="${escHtml(s.title)}">Regenerate previews</button>` : ''}
                ${s.status === 'archived' ? `<button class="btn-sm restore-session-btn" data-session-id="${escHtml(s.id)}">Restore</button>` : ''}
                <button class="delete-btn" data-session-id="${escHtml(s.id)}">Delete</button>
              </div>
            </details>
          </div>
        </div>
      `;
    }).join('');
    if (openMenu) { const menu = grid.querySelector(`.d-card[data-session-id="${CSS.escape(openMenu)}"] .card-more`); if (menu) menu.open = true; }
    restoreGridFocus(grid, focusMemo);
    statsPending.then(stats => { if (render === dashboardRender) paintMoneyStrips(grid, stats); });

    if (hasPending && !dashInterval && document.getElementById('tab-dashboard').classList.contains('active')) {
      dashInterval = setInterval(() => { if (!document.hidden) loadDashboard(true); }, 8000);
    } else if (!hasPending && dashInterval) {
      clearInterval(dashInterval); dashInterval = null;
    }
  } catch (err) {
    if (!silent) grid.innerHTML = `<p class="loading-msg error-msg">${escHtml(err.message)}</p>`;
  }
}

function updateMetrics(sessions) {
  const total = field => sessions.reduce((sum, session) => sum + Number(session[field] || 0), 0);
  document.getElementById('statIndexed').textContent = total('indexed_photos').toLocaleString('en-IN');
  document.getElementById('statFailed').textContent = total('failed_photos').toLocaleString('en-IN');
  document.getElementById('statPhotos').textContent = total('total_photos').toLocaleString('en-IN');
  document.getElementById('statSessions').textContent = sessions.filter(session => session.status === 'published').length;
}

// ── View Session Photos Modal ────────────────────────────────────────────────

// `mode: 'cover'` is the cover-picker step before publish (pickCover below): same grid, tiles become one big
// choice and the footer offers "Publish without a cover". Tiles keep their stored aspect ratio (migration 0012;
// 4:3 when unknown) and carry a 44 px select checkbox for the bulk actions.
async function viewSessionPhotos(sessionId, sessionTitle, { mode = '' } = {}) {
  const modal = document.getElementById('photoGalleryModal');
  const titleEl = document.getElementById('galleryModalTitle');
  const grid = document.getElementById('galleryGrid');

  modal.dataset.mode = mode;
  titleEl.textContent = mode === 'cover' ? `Pick a cover — ${sessionTitle}` : sessionTitle;
  grid.innerHTML = '<p class="loading-msg">Loading…</p>';
  clearPhotoSelection();
  document.getElementById('galleryTools').hidden = true;
  document.getElementById('coverPickerBar').hidden = mode !== 'cover';
  document.getElementById('publishWithCoverBtn').disabled = true;
  openModal(modal);

  try {
    const { photos, coverPhotoId } = await apiRequest(`/api/admin/sessions/${sessionId}/photos`);
    if (!modal.open) return;
    grid.dataset.sessionId = sessionId; grid.dataset.sessionTitle = sessionTitle;
    if (!photos.length) {
      grid.innerHTML = '<p class="empty-msg">Nothing here yet.</p>';
      return;
    }
    const aspect = p => (Number(p.width) > 0 && Number(p.height) > 0) ? `${Math.round(Number(p.width))}/${Math.round(Number(p.height))}` : '';
    grid.innerHTML = (mode === 'cover' ? '' : `<p class="cover-hint">Pick a cover for the site — a lineup or wave shot, nothing with a recognisable face. Until then it shows the wave illustration.</p>`) + photos.map((p) => `
      <div class="photo-card${p.id === coverPhotoId ? ' is-cover' : ''}" id="photo-card-${escHtml(p.id)}" data-photo-id="${escHtml(p.id)}" data-status="${escHtml(p.indexing_status)}">
        <img src="${escHtml(p.thumbUrl || p.previewUrl)}" alt="${escHtml(p.filename)}" loading="lazy" decoding="async"${aspect(p) ? ` style="--tile-aspect:${aspect(p)}"` : ''} />
        ${mode === 'cover' ? `<button class="photo-pick" type="button" data-photo-id="${escHtml(p.id)}" aria-pressed="${p.id === coverPhotoId}">Use ${escHtml(p.filename)} as the cover</button>` : `<label class="photo-select"><input type="checkbox" data-photo-id="${escHtml(p.id)}" aria-label="Select ${escHtml(p.filename)}" /></label>`}
        <button class="photo-cover-btn" data-photo-id="${escHtml(p.id)}" aria-pressed="${p.id === coverPhotoId}">${p.id === coverPhotoId ? '★ Cover' : 'Set as cover'}</button>
        <span class="photo-badge">${p.indexing_status === 'completed' ? `${p.face_count} face${Number(p.face_count) === 1 ? '' : 's'}` : escHtml(p.indexing_status)}</span>
        <p class="photo-processing-note">${p.indexing_error ? escHtml(p.indexing_error) : p.indexing_status === 'completed' && !Number(p.face_count) ? 'No clear face.' : p.indexing_status === 'pending' ? 'Indexing — refresh to check.' : ''}</p>
        <button class="photo-delete-btn" data-photo-id="${escHtml(p.id)}" aria-label="Delete ${escHtml(p.filename)}">Delete</button>
      </div>
    `).join('');
    if (mode === 'cover') { coverPick = coverPhotoId || null; document.getElementById('publishWithCoverBtn').disabled = !coverPick; }
    else { document.getElementById('galleryTools').hidden = false; syncPhotoSelection(); }
  } catch (err) {
    grid.innerHTML = `<p class="loading-msg error-msg">${escHtml(err.message)}</p>`;
  }
}

document.getElementById('galleryGrid').addEventListener('click', async (e) => {
  // Cover-picker mode: a tile is the choice; nothing is saved until "Use this cover and publish".
  const pick = e.target.closest('.photo-pick');
  if (pick) {
    coverPick = pick.dataset.photoId;
    document.querySelectorAll('#galleryGrid .photo-card').forEach(card => { const chosen = card.dataset.photoId === coverPick; card.classList.toggle('is-cover', chosen); card.querySelector('.photo-pick')?.setAttribute('aria-pressed', String(chosen)); });
    document.getElementById('publishWithCoverBtn').disabled = false;
    return;
  }
  // Choose (or clear) the public cover photo for this session.
  const coverBtn = e.target.closest('.photo-cover-btn');
  if (coverBtn) {
    const grid = document.getElementById('galleryGrid'); const sessionId = grid.dataset.sessionId;
    const clearing = coverBtn.getAttribute('aria-pressed') === 'true';
    grid.querySelectorAll('.photo-cover-btn').forEach(control => { control.disabled = true; });
    try {
      await apiRequest(`/api/admin/sessions/${sessionId}`, { method: 'PUT', body: JSON.stringify({ coverPhotoId: clearing ? null : coverBtn.dataset.photoId }) });
      grid.querySelectorAll('.photo-card').forEach(card => { const isCover = !clearing && card.id === `photo-card-${coverBtn.dataset.photoId}`; card.classList.toggle('is-cover', isCover); const control = card.querySelector('.photo-cover-btn'); control.setAttribute('aria-pressed', String(isCover)); control.textContent = isCover ? '★ Cover' : 'Set as cover'; });
      if (clearing) notifyCrew('Cover removed.');
      else { notifyCrew('Cover set — on the site in a few minutes.', 'success'); window.SOI?.splash?.({ at: coverBtn, symbol: 'stamp-coconut', count: 5 }); }
    } catch (err) { notifyCrew(err.message, 'error'); }
    finally { grid.querySelectorAll('.photo-cover-btn').forEach(control => { control.disabled = false; }); }
    return;
  }
  const btn = e.target.closest('.photo-delete-btn');
  if (!btn) return;
  const photoId = btn.dataset.photoId;
  if (!await confirmAction({ title: 'Delete this photo?', copy: 'Gone for good — including for anyone who paid for it.', confirmLabel: 'Delete' })) return;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    await apiRequest(`/api/admin/photos/${photoId}`, { method: 'DELETE' });
    const card = document.getElementById(`photo-card-${photoId}`);
    if (card) card.remove();
    adjustCardPhotoCount(document.getElementById('galleryGrid').dataset.sessionId, -1); galleryDirty = true;
  } catch (err) {
    notifyCrew(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Delete';
  }
});

// ── Photo grid: bulk select ───────────────────────────────────────────────────

// A checkbox per tile, Select all / Clear, and an action bar below the grid with the count. Actions go to
// POST /api/admin/photos/bulk (W3-B contract, 200 ids per call). On a Worker without that route (404): delete
// loops the per-photo route, re-index falls back to the per-session route (the whole session — said so in the
// toast), a single cover uses the existing PUT, and move / multi-cover say they need the new Worker.
const galleryGrid = document.getElementById('galleryGrid');
const bulkBar = document.getElementById('bulkBar');
let photoSelection = new Set();
let bulkBusy = false, bulkRouteMissing = false, galleryDirty = false;   // remembered per page load so the fallback doesn't re-probe every click
function clearPhotoSelection() { photoSelection = new Set(); syncPhotoSelection(); }
function syncPhotoSelection() {
  const cards = [...galleryGrid.querySelectorAll('.photo-card')];
  cards.forEach(card => { const box = card.querySelector('.photo-select input'); const selected = photoSelection.has(card.dataset.photoId); if (box) box.checked = selected; card.classList.toggle('is-selected', selected); });
  galleryGrid.classList.toggle('has-selection', photoSelection.size > 0);
  const count = photoSelection.size, total = cards.length;
  document.getElementById('gallerySummary').textContent = count ? `${count} of ${total} selected` : total ? plural(total, 'photo') : '';
  document.getElementById('selectAllPhotos').hidden = !total || count === total;
  document.getElementById('clearPhotoSelection').hidden = !count;
  bulkBar.hidden = !count || document.getElementById('photoGalleryModal').dataset.mode === 'cover';
  document.getElementById('bulkCount').textContent = count ? `${count} selected` : '';
  bulkBar.querySelectorAll('button').forEach(button => { button.disabled = bulkBusy; });
  if (!count) setBulkProgress('');
}
function setBulkProgress(text, kind = '') { const el = document.getElementById('bulkProgress'); el.textContent = text; el.hidden = !text; if (kind) el.dataset.kind = kind; else delete el.dataset.kind; }
galleryGrid.addEventListener('change', event => {
  const box = event.target.closest('.photo-select input'); if (!box) return;
  if (box.checked) photoSelection.add(box.dataset.photoId); else photoSelection.delete(box.dataset.photoId);
  syncPhotoSelection();
});
document.getElementById('selectAllPhotos').addEventListener('click', () => { photoSelection = new Set([...galleryGrid.querySelectorAll('.photo-card')].map(card => card.dataset.photoId)); syncPhotoSelection(); });
document.getElementById('clearPhotoSelection').addEventListener('click', () => clearPhotoSelection());

// One bulk call, chunked; a 404 marks the route missing and lets the caller fall back.
async function bulkRequest(action, photoIds, extra = {}) {
  const totals = { affected: 0, failed: [] };
  for (const chunk of chunkIds(photoIds)) {
    const result = await apiRequest('/api/admin/photos/bulk', { method: 'POST', body: JSON.stringify({ action, photoIds: chunk, ...extra }) });
    totals.affected += Number(result.affected) || 0; totals.failed.push(...(Array.isArray(result.failed) ? result.failed : []));
    setBulkProgress(`${totals.affected + totals.failed.length} of ${photoIds.length}…`);
  }
  return totals;
}
const isMissingRoute = error => error?.status === 404 && !/photo|session/i.test(error?.message || '');   // "Photo not found" is a real 404, a bare route 404 is not
async function runBulkAction(action, ids, { targetSessionId, targetTitle } = {}) {
  const sessionId = galleryGrid.dataset.sessionId;
  let outcome;
  if (!bulkRouteMissing) {
    try { outcome = await bulkRequest(action, ids, targetSessionId ? { targetSessionId } : {}); }
    catch (error) { if (!isMissingRoute(error)) throw error; bulkRouteMissing = true; }
  }
  if (!outcome) {   // older Worker
    if (action === 'delete') {
      outcome = { affected: 0, failed: [] };
      for (const [index, photoId] of ids.entries()) {
        try { await apiRequest(`/api/admin/photos/${photoId}`, { method: 'DELETE' }); outcome.affected += 1; }
        catch (error) { outcome.failed.push({ photoId, error: error.message }); }
        setBulkProgress(`${index + 1} of ${ids.length}…`);
      }
    } else if (action === 'reindex') {
      const res = await apiRequest(`/api/admin/sessions/${sessionId}/reindex`, { method: 'POST' });
      outcome = { affected: Number(res.queued) || 0, failed: [], note: 'This Worker can only re-index a whole session, so every photo in it was queued.' };
    } else if (action === 'cover' && ids.length === 1) {
      await apiRequest(`/api/admin/sessions/${sessionId}`, { method: 'PUT', body: JSON.stringify({ coverPhotoId: ids[0] }) });
      outcome = { affected: 1, failed: [] };
    } else {
      throw Object.assign(new Error(`${action === 'move' ? 'Moving photos' : 'Picking a cover from several'} needs the new Worker deploy — this one can't do it yet.`), { status: 404 });
    }
  }
  // Reflect the result in the grid: deleted and moved photos leave, the cover badge moves, re-index marks pending.
  const failedIds = new Set(outcome.failed.map(item => item.photoId));
  const done = ids.filter(id => !failedIds.has(id));
  if (action === 'delete' || action === 'move') done.forEach(id => galleryGrid.querySelector(`.photo-card[data-photo-id="${CSS.escape(id)}"]`)?.remove());
  if (action === 'cover') galleryGrid.querySelectorAll('.photo-card').forEach(card => { const isCover = card.dataset.photoId === ids[0]; card.classList.toggle('is-cover', isCover); const control = card.querySelector('.photo-cover-btn'); if (control) { control.setAttribute('aria-pressed', String(isCover)); control.textContent = isCover ? '★ Cover' : 'Set as cover'; } });
  if (action === 'reindex') done.forEach(id => { const card = galleryGrid.querySelector(`.photo-card[data-photo-id="${CSS.escape(id)}"]`); if (card) { card.dataset.status = 'pending'; card.querySelector('.photo-badge').textContent = 'pending'; card.querySelector('.photo-processing-note').textContent = 'Indexing — refresh to check.'; } });
  photoSelection = new Set(failedIds);   // what failed stays selected so one more tap retries exactly those
  const summary = summariseBulk(action, outcome) + (outcome.note ? ` ${outcome.note}` : '') + (action === 'move' && outcome.affected ? ` Now in “${targetTitle}”.` : '');
  notifyCrew(summary, outcome.failed.length ? 'error' : 'success');
  setBulkProgress(outcome.failed.length ? `${outcome.failed.length} failed and still selected: ${outcome.failed.slice(0, 3).map(item => `${item.photoId} — ${item.error || item.reason || 'unknown'}`).join('; ')}${outcome.failed.length > 3 ? '…' : ''}` : '', outcome.failed.length ? 'error' : '');
  if (!galleryGrid.querySelector('.photo-card')) galleryGrid.innerHTML = '<p class="empty-msg">Nothing here now.</p>';
  if (action === 'delete' || action === 'move') { adjustCardPhotoCount(sessionId, -done.length); if (action === 'move') adjustCardPhotoCount(targetSessionId, done.length); }
  galleryDirty = true;   // a silent dashboard refresh is skipped while a dialog is open, so the cards catch up when this one closes
}
// "Photos (n)" on a session card, nudged by a delta right away — a full refresh waits until the dialog closes
// (loadDashboard's silent guard stands down for open dialogs; galleryDirty triggers it on close).
function adjustCardPhotoCount(sessionId, delta) {
  const button = document.querySelector(`.d-card[data-session-id="${CSS.escape(sessionId || '')}"] .view-photos-btn`); if (!button) return;
  const count = Math.max(0, Number(button.textContent.match(/\((\d+)\)/)?.[1] || 0) + delta);
  button.textContent = `Photos (${count})`;
  const row = dashboardSessions.get(sessionId); if (row) row.total_photos = count;
}
bulkBar.addEventListener('click', async event => {
  const button = event.target.closest('button[data-bulk]'); if (!button || bulkBusy) return;
  const action = button.dataset.bulk; const ids = [...photoSelection]; if (!ids.length) return;
  const sessionId = galleryGrid.dataset.sessionId;
  const count = plural(ids.length, 'photo');
  let extra = {};
  if (action === 'delete') { if (!await confirmAction({ title: `Delete ${count}?`, copy: 'Gone for good — including for anyone who paid for them. No undo.', confirmLabel: 'Delete', typed: 'DELETE' })) return; }
  if (action === 'reindex') { if (!await confirmAction({ title: `Re-index ${count}?`, copy: 'Their faces and appearance data are replaced. Photos already indexed are done again.', confirmLabel: 'Re-index', danger: false })) return; }
  if (action === 'cover' && ids.length > 1) { if (!await confirmAction({ title: 'One cover only', copy: `${count} are selected — the first one becomes the cover.`, confirmLabel: 'Use the first', danger: false })) return; }
  if (action === 'move') {
    const options = [...dashboardSessions.values()].filter(session => session.id !== sessionId && session.status !== 'archived').map(session => ({ value: session.id, label: `${session.title} · ${sessionDateLabel(session.date)} · ${session.location || '—'}` }));
    if (!options.length) return notifyCrew('No other session to move them to — create one first.');
    const choice = await confirmAction({ title: `Move ${count}`, copy: 'They leave this session with their faces and links; guests who already paid keep their downloads.', confirmLabel: 'Move', danger: false, choice: { label: 'To session', options } });
    if (!choice) return;
    extra = { targetSessionId: choice.choice, targetTitle: options.find(option => option.value === choice.choice)?.label.split(' · ')[0] || '' };
  }
  bulkBusy = true; syncPhotoSelection(); setBulkProgress(`Working on ${count}…`);
  try { await runBulkAction(action, ids, extra); }
  catch (error) { notifyCrew(error.message, 'error'); setBulkProgress(error.message, 'error'); }
  finally { bulkBusy = false; syncPhotoSelection(); }
});

// ── Cover-picker step before publish ──────────────────────────────────────────

// The new Worker answers publish with 409 { needsCover: true } until the session has a cover or the crew says
// { noCover: true }. pickCover() opens the gallery in cover mode and resolves with a photo id, 'none', or null
// when the dialog is closed without choosing (the draft stays private). An older Worker never 409s.
let coverPick = null, coverPickResolve = null;
function pickCover(sessionId, title) {
  viewSessionPhotos(sessionId, title, { mode: 'cover' });
  return new Promise(resolve => { coverPickResolve = resolve; });
}
function settleCoverPick(value) { const resolve = coverPickResolve; coverPickResolve = null; if (resolve) { photoGalleryModal.close(); resolve(value); } }
document.getElementById('publishNoCoverBtn').addEventListener('click', () => settleCoverPick('none'));
document.getElementById('publishWithCoverBtn').addEventListener('click', () => { if (coverPick) settleCoverPick(coverPick); });
photoGalleryModal.addEventListener('close', () => { delete photoGalleryModal.dataset.mode; document.getElementById('coverPickerBar').hidden = true; clearPhotoSelection(); if (galleryDirty) { galleryDirty = false; loadDashboard(true); } const resolve = coverPickResolve; coverPickResolve = null; resolve?.(null); });
async function publishSession(sessionId, title, { keepSession = false } = {}) {
  const publish = body => withReauth(() => apiRequest(`/api/admin/sessions/${sessionId}/publish`, { method: 'POST', body: body ? JSON.stringify(body) : undefined, keepSession }));
  try { await publish(); return true; }
  catch (error) {
    if (error.status !== 409 || !error.body?.needsCover) throw error;
    const choice = await pickCover(sessionId, title);
    if (!choice) return false;
    if (choice !== 'none') await withReauth(() => apiRequest(`/api/admin/sessions/${sessionId}`, { method: 'PUT', body: JSON.stringify({ coverPhotoId: choice }), keepSession }));
    await publish(choice === 'none' ? { noCover: true } : undefined);
    return true;
  }
}

// ── Edit Session Details ─────────────────────────────────────────────────────

document.getElementById('editSessionForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const sessionId = document.getElementById('editSessionId').value;
  const title = document.getElementById('editTitle').value;
  const date = document.getElementById('editDate').value;
  const location = document.getElementById('editLocation').value;
  const pricePaise = Math.round(Number(document.getElementById('editPrice').value) * 100);
  const status = document.getElementById('editStatus').value;

  const saveButton = e.currentTarget.querySelector('button[type=submit]');
  if (saveButton.disabled) return;
  saveButton.disabled = true; saveButton.textContent = 'Saving…';
  try {
    await apiRequest(`/api/admin/sessions/${sessionId}`, {
      method: 'PUT',
      body: JSON.stringify({ title, date, location, pricePaise, status, ...readConditions(EDIT_CONDITION_IDS) }),   // nulls clear a condition; an older Worker ignores them
    });
    editSessionModal.close();
    loadDashboard();
  } catch (err) {
    notifyCrew(err.message, 'error');
  } finally { saveButton.disabled = false; saveButton.textContent = 'Save'; }
});

// ── Session Card Action Event Delegation ──────────────────────────────────────

document.getElementById('dashboardGrid').addEventListener('click', async (e) => {
  const menuItem = e.target.closest('.card-more-menu button'); if (menuItem) menuItem.closest('.card-more').open = false;   // the action speaks for itself
  // View Photos
  const viewBtn = e.target.closest('.view-photos-btn');
  if (viewBtn) {
    return viewSessionPhotos(viewBtn.dataset.sessionId, viewBtn.dataset.sessionTitle);
  }

  // Upload more photos into this session
  const moreBtn = e.target.closest('.upload-more-btn');
  if (moreBtn) {
    if (uploadBusy) return notifyCrew('Let this upload finish first.');
    openUploadMoreWith({ id: moreBtn.dataset.sessionId, title: moreBtn.dataset.sessionTitle });
    return;
  }

  // Edit Session
  const editBtn = e.target.closest('.edit-session-btn');
  if (editBtn) {
    document.getElementById('editSessionId').value = editBtn.dataset.sessionId;
    document.getElementById('editTitle').value = editBtn.dataset.title;
    document.getElementById('editDate').value = editBtn.dataset.date;
    document.getElementById('editLocation').value = editBtn.dataset.location;
    document.getElementById('editPrice').value = editBtn.dataset.price;
    document.getElementById('editStatus').value = editBtn.dataset.status;
    const session = dashboardSessions.get(editBtn.dataset.sessionId);
    fillConditions(EDIT_CONDITION_IDS, session?.conditions, session?.nextDropAt);   // empty on an older Worker
    editSnapshot = editFormState();
    openModal(editSessionModal);
    document.getElementById('editTitle').focus();   // showModal() would land on the × button
    return;
  }

  // Publish a draft straight from its card (the same endpoint the upload flow uses).
  const publishBtn = e.target.closest('.publish-session-btn');
  if (publishBtn) {
    publishBtn.disabled = true; publishBtn.textContent = 'Publishing…';
    try {
      if (await publishSession(publishBtn.dataset.sessionId, publishBtn.dataset.sessionTitle)) { window.SOI?.haptic?.([15]); notifyCrew(`“${publishBtn.dataset.sessionTitle}” is live.`, 'success'); loadDashboard(); }
      else { publishBtn.disabled = false; publishBtn.textContent = 'Publish'; }   // backed out of the cover step: still a draft
    }
    catch (err) { notifyCrew(err.message, 'error'); publishBtn.disabled = false; publishBtn.textContent = 'Publish'; }
    return;
  }

  const restoreBtn = e.target.closest('.restore-session-btn');
  if (restoreBtn) {
    restoreBtn.disabled = true; restoreBtn.textContent = 'Restoring…';
    try { await apiRequest(`/api/admin/sessions/${restoreBtn.dataset.sessionId}`, { method: 'PUT', body: JSON.stringify({ status: 'draft' }) }); loadDashboard(); }
    catch (err) { notifyCrew(err.message, 'error'); restoreBtn.disabled = false; restoreBtn.textContent = 'Restore'; }
    return;
  }

  // Re-queue only the photos whose indexing failed.
  const retryBtn = e.target.closest('.retry-failed-btn');
  if (retryBtn) {
    retryBtn.disabled = true; retryBtn.textContent = 'Queuing…';
    try {
      const res = await apiRequest(`/api/admin/sessions/${retryBtn.dataset.sessionId}/reindex?onlyFailed=1`, { method: 'POST' });
      notifyCrew(`${res.queued || 0} queued again.${res.failed ? ` ${res.failed} couldn't queue.` : ''}`, res.queued ? 'success' : 'info');
      loadDashboard();
    } catch (err) { notifyCrew(err.message, 'error'); retryBtn.disabled = false; retryBtn.textContent = 'Retry failed'; }
    return;
  }

  // Force Reindex Session — reprocesses every photo in the session, even ones already indexed.
  const reindexBtn = e.target.closest('.reindex-btn');
  if (reindexBtn) {
    if (!await confirmAction({ title: 'Force reindex this session?', copy: 'Reprocesses every photo — including ones already indexed or still mid-run — and replaces their face and appearance data. Takes a while for big sessions.', confirmLabel: 'Force reindex' })) return;
    reindexBtn.disabled = true;
    reindexBtn.textContent = 'Queuing…';
    try {
      const res = await apiRequest(`/api/admin/sessions/${reindexBtn.dataset.sessionId}/reindex`, { method: 'POST' });
      notifyCrew(`${res.queued || 0} queued, ${res.alreadyQueued || 0} already running.${res.failed ? ` ${res.failed} couldn't queue — retry after.` : ''} You can leave, it keeps going.`, res.queued ? 'success' : 'info');
      loadDashboard();
    } catch (err) {
      notifyCrew(err.message, 'error');
    } finally {
      reindexBtn.disabled = false;
      reindexBtn.textContent = 'Force reindex';
    }
    return;
  }

  // Rebuild every preview and thumb in this session with today's pipeline (W4-A).
  const regenBtn = e.target.closest('.regen-previews-btn');
  if (regenBtn) {
    regeneratePreviews(regenBtn.dataset.sessionId, regenBtn.dataset.sessionTitle);
    return;
  }

  // Delete Session
  const deleteBtn = e.target.closest('.delete-btn');
  if (deleteBtn) {
    const id = deleteBtn.dataset.sessionId;
    const card = deleteBtn.closest('.d-card'); const title = card?.querySelector('.d-card-title')?.textContent?.trim() || '';
    const photoCount = card?.querySelector('.view-photos-btn')?.textContent.match(/\((\d+)\)/)?.[1] || '0';
    if (!await confirmAction({ title: `Delete “${title}”?`, copy: `All ${plural(Number(photoCount), 'photo')} go${photoCount === '1' ? 'es' : ''} — including originals people paid for. No undo.`, confirmLabel: 'Delete', typed: title })) return;
    deleteBtn.disabled = true;
    deleteBtn.textContent = 'Deleting…';
    const nextCard = card?.nextElementSibling?.dataset.sessionId || card?.previousElementSibling?.dataset.sessionId || '';
    try {
      await apiRequest(`/api/admin/sessions/${id}`, { method: 'DELETE' });
      await loadDashboard();
      // Focus was on a button inside the card that just vanished: move it to the next card, else the tab.
      (document.querySelector(`.d-card[data-session-id="${CSS.escape(nextCard)}"]`) || document.getElementById('nav-dashboard')).focus();
    } catch (err) {
      notifyCrew(err.message, 'error');
      deleteBtn.disabled = false;
      deleteBtn.textContent = 'Delete';
    }
    return;
  }
});

document.getElementById('refreshBtn').addEventListener('click', () => loadDashboard());

// ── Session card "More" menu ──────────────────────────────────────────────────

// <details> opens downwards and to the right, which runs off the bottom of the viewport on the last
// card and off the right edge on phones. On open, measure once and flip with .is-up / .is-left
// (admin-theme.css); one menu open at a time; outside click and Escape close it.
const dashboardGrid = document.getElementById('dashboardGrid');
function placeCardMenu(details) {
  const menu = details.querySelector('.card-more-menu'), summary = details.querySelector('summary');
  if (!menu || !summary) return;
  details.classList.remove('is-up', 'is-left');
  const { up, left } = menuPlacement({ menu: menu.getBoundingClientRect(), anchor: summary.getBoundingClientRect(), viewport: { width: window.innerWidth, height: window.innerHeight } });
  details.classList.toggle('is-up', up); details.classList.toggle('is-left', left);
}
function closeCardMenus(except = null) { dashboardGrid.querySelectorAll('.card-more[open]').forEach(menu => { if (menu !== except) menu.open = false; }); }
dashboardGrid.addEventListener('toggle', event => {   // toggle doesn't bubble: listen in the capture phase
  const details = event.target; if (!details.matches?.('.card-more')) return;
  if (details.open) { closeCardMenus(details); placeCardMenu(details); }
  else details.classList.remove('is-up', 'is-left');
}, true);
document.addEventListener('pointerdown', event => { if (!event.target.closest('.card-more')) closeCardMenus(); });
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const open = dashboardGrid.querySelector('.card-more[open]'); if (!open) return;
  open.open = false; open.querySelector('summary').focus();
});

// ── Upload more photos into an existing session ───────────────────────────────

const morePhotoInput = document.getElementById('morePhotoInput');
const moreConfirmBtn = document.getElementById('moreConfirmBtn');
const moreCancelBtn  = document.getElementById('moreCancelBtn');
const moreRetryBtn   = document.getElementById('moreRetryBtn');
let moreUpload = null; // { sessionId, title, items: [{ file, name, duplicate }], duplicates, failedItems }

// Mirror the Worker's safeFilename so the duplicate check compares stored names.
function storedFilename(name) { return (name || 'photo.jpg').replace(/[^a-zA-Z0-9._-]/g, '-').slice(-120); }
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function setMoreStatus(text, isError = false, kind = '') {
  const el = document.getElementById('moreStatus');
  el.textContent = text; el.className = 'upload-status' + (text ? ' visible' : '') + (isError ? ' error' : '');
  if (kind) el.dataset.kind = kind; else delete el.dataset.kind;
}
const MORE_PROGRESS_IDS = { wrap: 'moreProgressWrap', fill: 'moreProgressFill', count: 'moreProgressCount', speed: 'moreProgressSpeed', eta: 'moreProgressEta', live: 'moreProgressLive' };
function setMoreProgress(stats) { paintProgress(MORE_PROGRESS_IDS, stats); }
function hideMoreProgress() {
  frameWrites.delete(MORE_PROGRESS_IDS.wrap);
  document.getElementById('moreProgressWrap').classList.add('hidden');
  document.getElementById('moreProgressFill').style.width = '0%';
  document.getElementById('moreProgressLive').textContent = '';
}
let moreQueueObserver = null; // IntersectionObserver feeding thumbnails to the dialog's list.
uploadMoreModal.addEventListener('close', () => { moreQueueObserver?.disconnect(); moreQueueObserver = null; });
function resetMoreModal() {
  document.getElementById('moreSummary').textContent = 'Checking…';
  document.getElementById('morePhotos').hidden = true;
  document.getElementById('morePhotoList').replaceChildren();
  moreQueueObserver?.disconnect(); moreQueueObserver = null;
  document.getElementById('moreChoice').hidden = true;
  document.querySelector('input[name=duplicateMode][value=skip]').checked = true;
  hideMoreProgress();
  setMoreStatus('');
  moreConfirmBtn.disabled = true; moreConfirmBtn.innerHTML = 'Upload'; moreConfirmBtn.classList.remove('is-busy');
  moreCancelBtn.textContent = 'Cancel';
  moreRetryBtn.hidden = true;
  if (moreUpload) moreUpload.failedItems = [];
}

morePhotoInput.addEventListener('click', (e) => { e.target.value = null; });
morePhotoInput.addEventListener('change', (e) => prepareUploadMore(e.target.files));
moreCancelBtn.addEventListener('click', () => stopOrCloseMore());

async function prepareUploadMore(fileList) {
  const files = [...fileList];
  if (!moreUpload || uploadBusy || !files.length) return;
  if (!files.every(isSupportedPhoto)) return toast(UNSUPPORTED_FILES, 'error');
  resetMoreModal();
  document.getElementById('moreModalTitle').textContent = `Add photos — ${moreUpload.title}`;
  openModal(uploadMoreModal);
  try {
    const { photos } = await apiRequest(`/api/admin/sessions/${moreUpload.sessionId}/photos`);
    if (!uploadMoreModal.open) return;
    const existing = new Set(photos.map(photo => photo.filename.toLowerCase()));
    // The same name picked twice from different folders is sent once.
    const seen = new Set(); const items = []; let repeated = 0;
    for (const file of files) {
      const name = storedFilename(file.name); const key = name.toLowerCase();
      if (seen.has(key)) { repeated += 1; continue; }
      seen.add(key); items.push({ file, name, duplicate: existing.has(key) });
    }
    moreUpload.items = items; moreUpload.duplicates = items.filter(item => item.duplicate);
    renderUploadMore(repeated);
  } catch (err) {
    document.getElementById('moreSummary').textContent = "Couldn't check what's already here.";
    setMoreStatus(err.message, true);
  }
}

function renderUploadMore(repeated) {
  const { items, duplicates } = moreUpload;
  const fresh = items.length - duplicates.length;
  const summary = document.getElementById('moreSummary'); summary.replaceChildren();
  const count = document.createElement('strong'); count.textContent = plural(items.length, 'photo');
  summary.append(count, '. ');
  if (duplicates.length) summary.append(`${duplicates.length} already here, ${fresh} new.`);
  else summary.append('All new.');
  if (repeated) summary.append(` ${plural(repeated, 'duplicate')} in your pick dropped.`);

  // Every selected photo gets a row up front; the rows then show live upload progress.
  document.getElementById('morePhotosTitle').textContent = duplicates.length ? `Photos · ${duplicates.length} already here` : 'Photos';
  const list = document.getElementById('morePhotoList'); list.replaceChildren();
  items.forEach(item => { item.row = photoRow(item.file, { tag: item.duplicate ? 'Already here' : '' }); list.append(item.row); });
  moreQueueObserver?.disconnect(); moreQueueObserver = watchQueueThumbs(list);
  document.getElementById('morePhotos').hidden = false;
  document.getElementById('moreChoice').hidden = !duplicates.length;
  moreConfirmBtn.disabled = false;
  updateMoreConfirmLabel();
}

function plannedUploads() {
  if (!moreUpload) return [];
  const mode = moreUpload.duplicates.length ? document.querySelector('input[name=duplicateMode]:checked')?.value : '';
  const items = mode === 'skip' ? moreUpload.items.filter(item => !item.duplicate) : moreUpload.items;
  return items.map(item => ({ file: item.file, onDuplicate: mode || undefined, row: item.row }));
}
function updateMoreConfirmLabel() {
  const count = plannedUploads().length;
  moreConfirmBtn.innerHTML = count ? `Upload ${count}` : 'Nothing to upload';
  moreConfirmBtn.disabled = !count;
  // Preview the choice: duplicates dim when they are about to be left out.
  const skipping = document.querySelector('input[name=duplicateMode]:checked')?.value === 'skip';
  moreUpload?.duplicates.forEach(item => setRowState(item.row, skipping ? 'skipped' : 'waiting'));
}
document.getElementById('moreChoice').addEventListener('change', updateMoreConfirmLabel);

async function runMoreUpload(items, { skippedByChoice = 0, isRetry = false } = {}) {
  // Everything locks except × and Cancel, which become "Stop upload" while the batch is sending.
  const controls = [...uploadMoreModal.querySelectorAll('input, button')].filter(control => control !== moreCancelBtn && control !== closeMoreModal && !reauthPanel.contains(control));   // the sign-in-again panel (left here by an earlier pause) must stay usable
  uploadBusy = true; controls.forEach(control => { control.disabled = true; }); signOutBtn.disabled = true;
  moreConfirmBtn.innerHTML = 'Uploading… <span></span>'; moreConfirmBtn.classList.add('is-busy');
  moreCancelBtn.textContent = 'Stop';
  if (isRetry) moreRetryBtn.textContent = 'Retrying…';
  setMoreStatus(`${isRetry ? 'Retrying' : 'Uploading'} ${plural(items.length, 'photo')}…`);
  let stopped = false;
  try {
    const batch = await uploadPhotoBatch(moreUpload.sessionId, items, setMoreProgress, (index, state, detail) => markRowFromResult(items[index].row, state, detail), { title: moreUpload.title });
    const { results, failures, unsent } = batch; stopped = batch.stopped;
    const uploaded = results.filter(result => !result.skipped);
    const replaced = uploaded.reduce((sum, result) => sum + (result.replaced || 0), 0);
    const renamed = uploaded.filter(result => result.duplicate === 'renamed');
    const skipped = results.filter(result => result.skipped).length + skippedByChoice;
    const parts = [`${uploaded.length} sent${uploaded.length ? ', indexing' : ''}.`];
    if (replaced) parts.push(`${replaced} replaced.`);
    if (renamed.length) parts.push(`${renamed.length === 1 ? '1 copy' : `${renamed.length} copies`} saved as ${renamed.slice(0, 3).map(result => result.filename).join(', ')}${renamed.length > 3 ? '…' : ''}.`);
    if (skipped) parts.push(`${skipped} skipped.`);
    if (stopped) parts.push(`Stopped — ${failures.length + unsent.length} not sent.`);
    else if (failures.length) parts.push(`${failures.length} failed — ${failures[0].message}`);
    setMoreStatus(parts.join(' '), Boolean(failures.length) && !stopped, stopped ? 'warning' : '');
    if (!stopped && !failures.length) window.SOI?.splash?.({ at: moreConfirmBtn, symbol: 'stamp-sunburst', count: 8 });
    // Aborted and never-started items both go on the retry list so one tap sends the rest.
    moreUpload.failedItems = [...failures.map(failure => failure.item), ...unsent];
    if (!moreUpload.failedItems.length) hideMoreProgress();
    moreUpload.items = []; moreUpload.duplicates = [];
    if (stopped || failures.length) flagFinishedInTitle('⚠ Upload stopped', `${uploaded.length} sent, ${failures.length + unsent.length} not.`);
    else flagFinishedInTitle('✓ Added', `${plural(uploaded.length, 'photo')} added to ${moreUpload.title}.`);
    loadDashboard(true);
  } catch (err) {
    setMoreStatus(err.message || 'Upload failed.', true);
    flagFinishedInTitle('⚠ Upload stopped', err.message);
  } finally {
    cancelled = false;
    uploadBusy = false; signOutBtn.disabled = false;
    controls.forEach(control => { control.disabled = false; });
    moreConfirmBtn.disabled = true; moreConfirmBtn.innerHTML = 'Upload'; moreConfirmBtn.classList.remove('is-busy');
    moreCancelBtn.textContent = 'Done';
    document.getElementById('moreChoice').hidden = true;
    if (moreUpload.failedItems.length) {
      moreRetryBtn.hidden = false; moreRetryBtn.disabled = false;
      moreRetryBtn.textContent = stopped ? `Send ${moreUpload.failedItems.length} remaining` : `Retry ${moreUpload.failedItems.length}`;
    } else {
      moreRetryBtn.hidden = true;
    }
  }
}

moreConfirmBtn.addEventListener('click', () => {
  const items = plannedUploads();
  if (!items.length || uploadBusy) return;
  runMoreUpload(items, { skippedByChoice: moreUpload.items.length - items.length });
});

moreRetryBtn.addEventListener('click', () => {
  const items = moreUpload?.failedItems || [];
  if (!items.length || uploadBusy) return;
  runMoreUpload(items, { isRetry: true });
});

// ── Crew Match Verification Queue ─────────────────────────────────────────────

const faceImages = new WeakMap();
function renderFace(canvas, zoom = 1) {
  const image = faceImages.get(canvas); if (!image) return;
  const [top, left, width, height] = JSON.parse(canvas.dataset.bboxNorm);
  const fullWidth = width / 100 * image.naturalWidth, fullHeight = height / 100 * image.naturalHeight;
  const cropWidth = fullWidth / zoom, cropHeight = fullHeight / zoom;
  const x = left / 100 * image.naturalWidth + (fullWidth - cropWidth) / 2;
  const y = top / 100 * image.naturalHeight + (fullHeight - cropHeight) / 2;
  const context = canvas.getContext('2d');
  const scale = Math.min(canvas.width / cropWidth, canvas.height / cropHeight);
  context.fillStyle = '#e7e2d6'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, x, y, cropWidth, cropHeight, (canvas.width - cropWidth * scale) / 2, (canvas.height - cropHeight * scale) / 2, cropWidth * scale, cropHeight * scale);
}
// Share downloads and decoded originals across pairs within this queue.
function createReviewImageLoader() {
  const images = new Map();
  return canvas => {
    const key = canvas.dataset.photoId || canvas.dataset.imgUrl;
    if (!images.has(key)) {
      const pending = new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.decoding = 'async';
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Could not load photo.'));
        const mediaUrl = new URL(canvas.dataset.imgUrl, window.location.origin);
        image.src = mediaUrl.origin === 'https://mambo-jambo-photo-api.surfersofindia.workers.dev' ? apiUrl(mediaUrl.pathname + mediaUrl.search) : mediaUrl.href;
      });
      images.set(key, pending);
      pending.catch(() => images.delete(key));
    }
    return images.get(key);
  };
}
// Confidence for a review card: the percentage, a one-word note and a bar coloured by band (role="meter" so a
// screen reader gets "Face similarity 61%"). Text carries the number; the bar is the at-a-glance read.
function confidenceMeter(pct, note, label) {
  const value = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  return `<span class="review-score"><span class="review-score-value">${value}%</span><small>${escHtml(note)}</small><span class="review-meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}" aria-label="${escHtml(label)} ${value}%" data-band="${confidenceBand(value)}"><i style="width:${value}%"></i></span></span>`;
}
// The whole frame beside the crop, at the photo's own aspect ratio, with the face box outlined — the same decoded
// original the crop came from, so it costs no extra request.
function renderFullFrame(canvas, image, bboxNorm) {
  const [top, left, width, height] = bboxNorm || [0, 0, 0, 0];
  const scale = Math.min(1, 480 / image.naturalWidth, 480 / image.naturalHeight);
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  if (width && height) {
    context.lineWidth = Math.max(2, Math.round(canvas.width / 160)); context.strokeStyle = '#A8482C';
    context.strokeRect(left / 100 * canvas.width, top / 100 * canvas.height, width / 100 * canvas.width, height / 100 * canvas.height);
  }
}
async function drawCroppedFaceCanvas(canvas, loadImage) {
  const card = canvas.closest('.verify-card');
  const frame = canvas.closest('.review-image-frame');
  frame.dataset.state = 'loading';
  frame.setAttribute('aria-busy', 'true');
  try {
    const image = await loadImage(canvas);
    if (!canvas.isConnected) return;
    faceImages.set(canvas, image); renderFace(canvas); canvas.dataset.ready = 'true';
    const full = canvas.closest('.review-face')?.querySelector('.face-full-canvas');
    if (full) try { renderFullFrame(full, image, JSON.parse(canvas.dataset.bboxNorm)); } catch { /* the crop is what matters */ }
    frame.dataset.state = 'ready';
    if ([...card.querySelectorAll('.face-crop-canvas')].every(item => item.dataset.ready === 'true')) {   // the whole-frame canvases ride along and never gate the buttons
      card.querySelector('.review-load-status').textContent = 'Your call.';
      card.querySelectorAll('[data-action="confirm"],[data-action="reject"],input[type=range]').forEach(control => { control.disabled = false; });
    }
  } catch {
    if (!canvas.isConnected) return;
    frame.dataset.state = 'error';
    frame.querySelector('.review-image-label').textContent = "Didn't load";
    card.querySelector('.review-load-status').textContent = "A face didn't load — refresh the queue.";
  } finally {
    frame.setAttribute('aria-busy', 'false');
  }
}
let reviewObserver;
let reviewQueueVersion = 0;
function observeReviewImages(grid) {
  const loadImage = createReviewImageLoader();
  const loadCard = card => card.querySelectorAll('.face-crop-canvas').forEach(canvas => drawCroppedFaceCanvas(canvas, loadImage));
  if (!('IntersectionObserver' in window)) {
    grid.querySelectorAll('.verify-card').forEach(loadCard);
    return;
  }
  reviewObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      reviewObserver.unobserve(entry.target);
      loadCard(entry.target);
    }
  }, { rootMargin: '300px 0px' });
  grid.querySelectorAll('.verify-card').forEach(card => reviewObserver.observe(card));
}
async function loadVerifyQueue() {
  const grid = document.getElementById('verifyGrid');
  const version = ++reviewQueueVersion;
  reviewObserver?.disconnect();
  grid.innerHTML = '<p class="loading-msg review-queue-loading" role="status"><span class="review-spinner" aria-hidden="true"></span>Looking for borderline pairs…</p>';
  try {
    const { queue, stats } = await apiRequest('/api/admin/verify-queue');
    if (version !== reviewQueueVersion) return;
    document.getElementById('verifyPending').textContent = stats.pending || 0;
    const unavailable = document.getElementById('reviewUnavailable');
    unavailable.hidden = !stats.unavailable;
    unavailable.textContent = `${plural(stats.unavailable, 'pair')} hidden — faces still indexing or crops missing. Re-index, wait, scan again.`;
    document.getElementById('verifyConfirmed').textContent = stats.confirmed || 0;
    document.getElementById('verifyRejected').textContent = stats.rejected || 0;
    if (!queue?.length) { grid.innerHTML = '<p class="empty-msg">Nothing borderline right now. Scan again once indexing finishes.</p>'; return; }
    let lastSession = null;
    grid.innerHTML = queue.map(item => {
      const divider = item.sessionTitle !== lastSession ? `<div class="review-session-divider">${escHtml(item.sessionTitle)}</div>` : '';
      lastSession = item.sessionTitle;
      return `${divider}
      <article class="verify-card" id="verify-card-${escHtml(item.id)}">
        <div class="review-heading"><div><span class="eyebrow">A SECOND PAIR OF EYES</span><h3>Same surfer?</h3><p>${escHtml(item.sessionTitle)}</p></div>${confidenceMeter(item.similarityPct, 'borderline', 'Face similarity')}</div>
        <div class="verify-faces">${[item.photo1, item.photo2].map((photo, index) => `
          <figure class="review-face"><figcaption>FACE ${index === 0 ? 'A' : 'B'}</figcaption><div class="review-image-frame" data-state="waiting" aria-busy="true"><div class="review-image-loader" aria-hidden="true"><span class="review-spinner"></span><span class="review-image-label">Loading…</span></div><canvas class="face-crop-canvas" data-photo-id="${escHtml(photo.id)}" data-img-url="${escHtml(photo.url)}" data-bbox-norm="${escHtml(JSON.stringify(photo.bboxNorm))}" width="640" height="640" role="img" aria-label="Face ${index === 0 ? 'A' : 'B'} crop"></canvas></div><div class="review-full"><p class="review-full-label">WHOLE FRAME</p><canvas class="face-full-canvas" width="480" height="320" role="img" aria-label="Photo ${index === 0 ? 'A' : 'B'} with the face outlined"></canvas></div><p title="${escHtml(photo.filename)}">${escHtml(photo.filename)}</p></figure>`).join('')}</div>
        <div class="review-zoom"><label>Zoom <input type="range" min="1" max="2.5" step=".1" value="1" disabled><output>1×</output></label><button type="button" data-action="reset-zoom">Reset</button></div>
        <p class="review-load-status" role="status">Loading faces…</p>
        <div class="verify-actions"><button class="confirm-btn" data-pair-id="${escHtml(item.id)}" data-action="confirm" disabled>Same</button><button class="reject-btn" data-pair-id="${escHtml(item.id)}" data-action="reject" disabled>Different</button><button class="review-skip" data-pair-id="${escHtml(item.id)}" data-action="skip">Skip</button></div>
      </article>`;
    }).join('');
    observeReviewImages(grid);
    document.dispatchEvent(new CustomEvent('mj:queue-rendered'));
  } catch (error) { if (version === reviewQueueVersion) grid.innerHTML = `<p class="loading-msg error-msg">${escHtml(error.message)}</p>`; }
}
const reviewGrid = document.getElementById('verifyGrid');
reviewGrid.addEventListener('input', event => {
  if (!event.target.matches('input[type=range]')) return;
  const card = event.target.closest('.verify-card'), zoom = Number(event.target.value);
  card.querySelector('output').textContent = `${zoom.toFixed(1)}×`;
  card.querySelectorAll('.face-crop-canvas').forEach(canvas => renderFace(canvas, zoom));
});
reviewGrid.addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]'); if (!button) return;
  const card = button.closest('.verify-card');
  if (button.dataset.action === 'reset-zoom') { const slider = card.querySelector('input'); slider.value = '1'; slider.dispatchEvent(new Event('input', { bubbles: true })); return; }
  window.SOI?.haptic?.([12]);
  if (button.dataset.action === 'skip') {
    card.remove(); if (!reviewGrid.querySelector('.verify-card')) reviewGrid.innerHTML = '<p class="empty-msg">Batch done. Refresh to see skipped ones.</p>';
    markActiveReviewCard();
    return;
  }
  card.querySelectorAll('button').forEach(control => { control.disabled = true; });
  const confirmed = button.dataset.action === 'confirm';
  try {
    await apiRequest('/api/admin/confirm-match', { method: 'POST', body: JSON.stringify({ pairId: button.dataset.pairId, confirmed }) });
    rememberReview({ kind: 'pair', id: button.dataset.pairId, card, confirmed });
    card.remove(); markActiveReviewCard();
    const pending = document.getElementById('verifyPending'); pending.textContent = Math.max(0, Number(pending.textContent) - 1);
    const count = document.getElementById(confirmed ? 'verifyConfirmed' : 'verifyRejected'); count.textContent = Number(count.textContent) + 1;
    if (!reviewGrid.querySelector('.verify-card')) await loadVerifyQueue();
  } catch (error) { card.querySelector('.review-load-status').textContent = error.message; card.querySelectorAll('button').forEach(control => { control.disabled = false; }); }
});

// Y / N / S act on the first reviewable card in view (face pairs first, then burst/appearance links);
// Z undoes the last decision (see "Review: undo" below). The same rule marks that card `.is-active`,
// so the crew can see what the keys will hit.
const activeReviewCard = () => [...document.querySelectorAll('#verifyGrid .verify-card, #linkGrid .verify-card')].find(item => { const box = item.getBoundingClientRect(); return box.bottom > 80 && box.top < window.innerHeight; });
function markActiveReviewCard() {
  const active = activeReviewCard();
  document.querySelectorAll('.verify-card.is-active').forEach(card => { if (card !== active) card.classList.remove('is-active'); });
  active?.classList.add('is-active');
}
let reviewMarkFrame = 0;
window.addEventListener('scroll', () => { if (!reviewMarkFrame) reviewMarkFrame = requestAnimationFrame(() => { reviewMarkFrame = 0; markActiveReviewCard(); }); }, { passive: true });
document.addEventListener('mj:queue-rendered', markActiveReviewCard);
document.addEventListener('keydown', event => {
  const focused = document.activeElement;
  const action = reviewShortcut(event, { tabActive: document.getElementById('tab-verify').classList.contains('active'), dialogOpen: Boolean(document.querySelector('dialog[open]')), typing: /^(INPUT|TEXTAREA|SELECT)$/.test(focused?.tagName) || Boolean(focused?.isContentEditable) });
  if (!action) return;
  if (action === 'undo') { if (!undoReviewBtn.disabled) { event.preventDefault(); undoLastReview(); } return; }
  const card = activeReviewCard();
  const button = card?.querySelector(`button[data-action="${action}"]`);
  if (!button || button.disabled) return;
  event.preventDefault(); button.click();
});

const rescanVerifyBtn = document.getElementById('rescanVerifyBtn');
if (rescanVerifyBtn) {
  rescanVerifyBtn.addEventListener('click', async () => {
    rescanVerifyBtn.disabled = true;
    rescanVerifyBtn.textContent = 'Scanning…';
    try {
      const res = await apiRequest('/api/admin/verify-queue/scan', { method: 'POST' });
      notifyCrew(`Scan done — ${plural(res.generated || 0, 'borderline pair')}.`, 'success');
      loadVerifyQueue();
    } catch (err) {
      notifyCrew(err.message, 'error');
    } finally {
      rescanVerifyBtn.disabled = false;
      rescanVerifyBtn.textContent = 'Find borderline pairs';
    }
  });
}

const refreshVerifyBtn = document.getElementById('refreshVerifyBtn');
if (refreshVerifyBtn) {
  refreshVerifyBtn.addEventListener('click', () => loadVerifyQueue());
}

// ── Burst & Appearance Fallback Link Review ────────────────────────────────────
// Unlike face pairs above, one or both sides here may have no detected face at all, so there is
// no bbox to crop to — cards compare whole photos. Plain lazy-loaded <img> is enough; there is no
// canvas cropping/zoom to justify the decoded-image cache the face-pair review uses.

const LINK_TYPE_LABEL = { burst: ['BURST', 'seconds apart'], appearance: ['SAME KIT', 'matching colours'] };
let linkQueueVersion = 0;
async function loadLinkQueue() {
  const grid = document.getElementById('linkGrid');
  if (!grid) return;
  const version = ++linkQueueVersion;
  grid.innerHTML = '<p class="loading-msg review-queue-loading" role="status"><span class="review-spinner" aria-hidden="true"></span>Looking for links…</p>';
  try {
    const { queue, stats, trainedOn } = await apiRequest('/api/admin/link-queue');
    if (version !== linkQueueVersion) return;
    document.getElementById('linkPending').textContent = stats.pending || 0;
    document.getElementById('linkConfirmed').textContent = stats.confirmed || 0;
    document.getElementById('linkRejected').textContent = stats.rejected || 0;
    showRetrainStatus(trainedOn);
    if (!queue?.length) { grid.innerHTML = '<p class="empty-msg">No links yet. Needs capture times — re-index, then scan.</p>'; return; }
    let lastSession = null;
    grid.innerHTML = queue.map(item => {
      const [eyebrow, note] = LINK_TYPE_LABEL[item.linkType] || LINK_TYPE_LABEL.burst;
      const divider = item.sessionTitle !== lastSession ? `<div class="review-session-divider">${escHtml(item.sessionTitle)}</div>` : '';
      lastSession = item.sessionTitle;
      return `${divider}
      <article class="verify-card" id="link-card-${escHtml(item.id)}">
        <div class="review-heading"><div><span class="eyebrow">${eyebrow}</span><h3>Same surfer?</h3><p>${escHtml(item.sessionTitle)}</p></div>${confidenceMeter(item.scorePct, note, item.linkType === 'burst' ? 'Timing closeness' : 'Kit similarity')}</div>
        <div class="verify-faces">${[item.photo1, item.photo2].map((photo, index) => `
          <figure class="review-face"><figcaption>PHOTO ${index === 0 ? 'A' : 'B'}</figcaption><img class="link-photo-img" loading="lazy" src="${escHtml(photo.url)}" alt="Photo ${index === 0 ? 'A' : 'B'}"><p title="${escHtml(photo.filename)}">${escHtml(photo.filename)}</p></figure>`).join('')}</div>
        <div class="verify-actions"><button class="confirm-btn" data-link-id="${escHtml(item.id)}" data-action="confirm">Same</button><button class="reject-btn" data-link-id="${escHtml(item.id)}" data-action="reject">Different</button><button class="review-skip" data-link-id="${escHtml(item.id)}" data-action="skip">Skip</button></div>
      </article>`;
    }).join('');
    grid.querySelectorAll('.link-photo-img').forEach(img => {
      img.addEventListener('error', () => img.closest('.review-face').classList.add('link-photo-error'), { once: true });
    });
    document.dispatchEvent(new CustomEvent('mj:queue-rendered'));
  } catch (error) { if (version === linkQueueVersion) grid.innerHTML = `<p class="loading-msg error-msg">${escHtml(error.message)}</p>`; }
}
const linkGrid = document.getElementById('linkGrid');
if (linkGrid) {
  linkGrid.addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]'); if (!button) return;
    const card = button.closest('.verify-card');
    window.SOI?.haptic?.([12]);
    if (button.dataset.action === 'skip') {
      card.remove(); if (!linkGrid.querySelector('.verify-card')) linkGrid.innerHTML = '<p class="empty-msg">Batch done. Refresh to see skipped ones.</p>';
      markActiveReviewCard();
      return;
    }
    card.querySelectorAll('button').forEach(control => { control.disabled = true; });
    const confirmed = button.dataset.action === 'confirm';
    try {
      await apiRequest('/api/admin/confirm-link', { method: 'POST', body: JSON.stringify({ linkId: button.dataset.linkId, confirmed }) });
      rememberReview({ kind: 'link', id: button.dataset.linkId, card, confirmed });
      card.remove(); markActiveReviewCard();
      const pending = document.getElementById('linkPending'); pending.textContent = Math.max(0, Number(pending.textContent) - 1);
      const count = document.getElementById(confirmed ? 'linkConfirmed' : 'linkRejected'); count.textContent = Number(count.textContent) + 1;
      if (!linkGrid.querySelector('.verify-card')) await loadLinkQueue();
    } catch (error) { notifyCrew(error.message, 'error'); card.querySelectorAll('button').forEach(control => { control.disabled = false; }); }
  });
}

const rescanLinkBtn = document.getElementById('rescanLinkBtn');
if (rescanLinkBtn) {
  rescanLinkBtn.addEventListener('click', async () => {
    rescanLinkBtn.disabled = true;
    rescanLinkBtn.textContent = 'Scanning…';
    try {
      const res = await apiRequest('/api/admin/link-queue/scan', { method: 'POST' });
      notifyCrew(`Scan done — ${plural(res.generated || 0, 'link')}.`, 'success');
      loadLinkQueue();
    } catch (err) {
      notifyCrew(err.message, 'error');
    } finally {
      rescanLinkBtn.disabled = false;
      rescanLinkBtn.textContent = 'Find links';
    }
  });
}

const refreshLinkBtn = document.getElementById('refreshLinkBtn');
if (refreshLinkBtn) {
  refreshLinkBtn.addEventListener('click', () => loadLinkQueue());
}

function showRetrainStatus(trainedOn) {
  const el = document.getElementById('retrainStatus');
  if (!el) return;
  el.hidden = !trainedOn;
  el.textContent = trainedOn ? `Scoring trained on ${plural(trainedOn, 'review')}` : '';
}
const retrainBtn = document.getElementById('retrainBtn');
if (retrainBtn) {
  retrainBtn.addEventListener('click', async () => {
    retrainBtn.disabled = true;
    retrainBtn.textContent = 'Retraining…';
    try {
      const res = await apiRequest('/api/admin/retrain', { method: 'POST' });
      if (res.trained) { notifyCrew(`Retrained on ${plural(res.reviewCount, 'review')}.`, 'success'); showRetrainStatus(res.reviewCount); }
      else if (res.reviewCount < 20) notifyCrew(`Only ${res.reviewCount} reviewed so far — needs 20. Keep going.`);
      else notifyCrew(`${res.reviewCount} reviewed, but all one answer — needs some of each.`);   // the Worker won't fit on confirms-only or rejects-only
    } catch (err) {
      notifyCrew(err.message, 'error');
    } finally {
      retrainBtn.disabled = false;
      retrainBtn.textContent = 'Retrain scoring';
    }
  });
}

// ── Review: undo the last decision (F30) ──────────────────────────────────────

// The last Same / Different is kept with its card so Z (or the Undo button in the toolbar) can put
// it straight back: POST /api/admin/undo-review { kind, id } flips the pair or link to pending again
// inside the Worker's 10-minute window. A 409 (older than that, or already pending) or a 404 means
// there is nothing left to undo, so the memory clears; a dropped connection keeps it for another Z.
const undoReviewBtn = document.getElementById('undoReviewBtn');
const UNDO_WINDOW_MS = 10 * 60 * 1000;   // the Worker's window; once it lapses the button goes quiet instead of earning a 409
let lastReview = null;   // { kind: 'pair' | 'link', id, at, card, confirmed }
let undoBusy = false, undoExpiry = null;
function syncUndoButton() { undoReviewBtn.disabled = !lastReview || undoBusy; }
function rememberReview(entry) { lastReview = { ...entry, at: Date.now() }; clearTimeout(undoExpiry); undoExpiry = setTimeout(forgetReview, UNDO_WINDOW_MS); syncUndoButton(); }
function forgetReview() { lastReview = null; clearTimeout(undoExpiry); undoExpiry = null; syncUndoButton(); }
// Back at the top of its queue, reviewable again, focused. If a reload of that queue is in flight
// (confirming the last card triggers one), it was requested before the undo and would wipe the card
// when it lands — so wait for a fresh reload instead and move the pair it brings back to the top.
async function restoreReviewCard({ kind, id, card, confirmed }) {
  const isPair = kind === 'pair';
  const grid = isPair ? reviewGrid : linkGrid;
  const reloaded = Boolean(grid.querySelector('.review-queue-loading'));
  if (reloaded) await (isPair ? loadVerifyQueue() : loadLinkQueue());
  let restored = grid.querySelector(`#${isPair ? 'verify' : 'link'}-card-${CSS.escape(id)}`);
  if (!restored) {
    grid.querySelectorAll(':scope > p').forEach(message => message.remove());   // "Batch done" / "Nothing borderline"
    card.querySelectorAll('button').forEach(control => { control.disabled = false; });
    restored = card;
  }
  grid.prepend(restored);
  if (!reloaded) {   // a fresh reload already carries the server's counts
    const pending = document.getElementById(isPair ? 'verifyPending' : 'linkPending'); pending.textContent = Number(pending.textContent) + 1;
    const count = document.getElementById(isPair ? (confirmed ? 'verifyConfirmed' : 'verifyRejected') : (confirmed ? 'linkConfirmed' : 'linkRejected')); count.textContent = Math.max(0, Number(count.textContent) - 1);
  }
  restored.tabIndex = -1; restored.focus({ preventScroll: true }); restored.scrollIntoView({ block: 'nearest' });
  markActiveReviewCard();
}
async function undoLastReview() {
  const entry = lastReview;
  if (!entry || undoBusy) return;
  undoBusy = true; syncUndoButton();
  try {
    await apiRequest('/api/admin/undo-review', { method: 'POST', body: JSON.stringify({ kind: entry.kind, id: entry.id }) });
    if (lastReview === entry) forgetReview();   // a decision made meanwhile is the new last one
    await restoreReviewCard(entry);
    window.SOI?.haptic?.([12]);
    notifyCrew('Undone.', 'success');
  } catch (error) {
    if ((error.status === 409 || error.status === 404) && lastReview === entry) forgetReview();   // the server has the last word
    notifyCrew(error.message, 'error');
  } finally { undoBusy = false; syncUndoButton(); }
}
undoReviewBtn.addEventListener('click', () => undoLastReview());

// ── Session hygiene: idle sign-out, API health pill, tab title ────────────────

// The token lives in sessionStorage with no expiry of its own: drop it after 30 min without input,
// with a 2-minute warning. Never mid-upload — re-arm instead, so a long batch can't sign itself out.
const IDLE_MS = 30 * 60 * 1000, IDLE_WARN_MS = 2 * 60 * 1000;
let idleTimer = null, idleWarnTimer = null, idleWarning = null, idleTouchedAt = 0;
function armIdle() {
  disarmIdle();
  if (!isAuthenticated()) return;
  idleWarnTimer = setTimeout(() => { if (!uploadBusy) idleWarning = toast('Signing you out in 2 min — tap anything to stay.', 'info', { timeout: IDLE_WARN_MS }); }, IDLE_MS - IDLE_WARN_MS);
  idleTimer = setTimeout(() => {
    if (uploadBusy) return armIdle();
    revokeToken(); clearToken(); showLogin(); notifyCrew("Signed out — you'd gone quiet for 30 min.");
  }, IDLE_MS);
}
function disarmIdle() { clearTimeout(idleTimer); clearTimeout(idleWarnTimer); idleTimer = idleWarnTimer = null; idleWarning?.remove(); idleWarning = null; }
function touchIdle() {
  if (!idleTimer) return;                                                       // not armed (login screen)
  const now = Date.now(); if (now - idleTouchedAt < 1000) return; idleTouchedAt = now;   // scroll fires constantly
  armIdle();
}
['pointerdown', 'keydown', 'scroll'].forEach(type => document.addEventListener(type, touchIdle, { passive: true, capture: true }));

// Topbar health pill: GET /api/health (public, no auth) every 60 s while signed in and the tab is
// visible. One dot per check; the pill's data-state is the worst of them. Must never throw.
const HEALTH_MS = 60000;
const HEALTH_CHECKS = [['api', 'API'], ['db', 'DB'], ['r2', 'R2'], ['face', 'Face']];
let healthTimer = null;
const HEALTH_DOT = { ok: 'var(--success)', skipped: 'var(--soi-umber-soft)', error: 'var(--soi-terracotta)' };
function renderHealth(el, state, checks) {
  const dot = key => ['ok', 'error', 'skipped'].includes(checks[key]) ? checks[key] : 'error';
  el.classList.add('health-pill'); el.dataset.state = state;
  el.innerHTML = HEALTH_CHECKS.map(([key, label]) => `<span class="health-check" data-state="${dot(key)}"><i aria-hidden="true" style="color:${HEALTH_DOT[dot(key)]}">●</i> <b class="health-label">${label}</b></span>`).join(' · ');   // labels hide on narrow phones (admin-theme.css); the title/aria-label keep them
  el.title = HEALTH_CHECKS.map(([key, label]) => `${label}: ${dot(key)}`).join(' · ');
  el.setAttribute('aria-label', `Service health ${state}: ${el.title}`);
  el.hidden = false; el.classList.remove('hidden');
}
async function pollHealth() {
  try {
    const el = document.getElementById('apiHealth');
    if (!el || !isAuthenticated() || document.hidden) return;
    let state = 'down', checks = {};
    try {
      const resp = await fetch(apiUrl('/api/health'), { signal: AbortSignal.timeout(5000) });
      if (resp.status === 404) { el.hidden = true; return; }              // Worker without the route yet
      const body = await resp.json().catch(() => ({}));
      checks = { api: 'ok', ...(body.checks || {}) };
      state = resp.ok && body.ok === true ? 'ok' : 'degraded';
    } catch { checks = {}; }
    renderHealth(el, state, checks);
  } catch { /* the pill must never break the studio */ }
}
function startHealth() {
  clearInterval(healthTimer); healthTimer = null;
  if (!isLive || !isAuthenticated() || document.hidden) return;
  pollHealth(); healthTimer = setInterval(pollHealth, HEALTH_MS);
}
function stopHealth({ hide = false } = {}) {
  clearInterval(healthTimer); healthTimer = null;
  const el = document.getElementById('apiHealth');
  if (hide && el) { el.hidden = true; el.classList.add('hidden'); }
}

// A batch that finishes or stops while the crew is in another tab prefixes the title ("✓ Published ·",
// "⚠ Upload stopped ·") until they come back, and posts a system notification only if they already
// allowed them — it never asks.
const baseTitle = document.title;
function flagFinishedInTitle(prefix, body = '') {
  if (!document.hidden) return;
  document.title = `${prefix} · ${baseTitle}`;
  if (typeof Notification === 'function' && Notification.permission === 'granted') {
    try { new Notification(`${prefix} — Surfers of India`, { body, tag: 'soi-crew-upload' }); } catch { /* optional */ }
  }
}
const restoreTitle = () => { if (!document.hidden) document.title = baseTitle; };
window.addEventListener('focus', restoreTitle);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopHealth(); return; }
  restoreTitle();
  startHealth();
});

// ── Money tab: funnel, settlements, unreconciled ─────────────────────────────

// Per-session funnel from GET /api/admin/stats (searches → matched → checkouts → unlocks, plus grants and rupees)
// and Cashfree settlements from GET /api/admin/settlements?from=&to= (W3-B). Each block hides itself with a
// one-line notice when its route is missing (older Worker) or the Worker has no Cashfree credentials (503).
const dateLabel = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value || '—') : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); };
const dateTimeLabel = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value || '—') : `${date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}, ${date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}`; };
const pct = (part, whole) => whole ? `${Math.round(part / whole * 100)}%` : '—';
let moneyRun = 0;
function loadMoneyTab() { loadFunnel(); if (!document.getElementById('settleFrom').value) { const range = defaultSettlementRange(); document.getElementById('settleFrom').value = range.from; document.getElementById('settleTo').value = range.to; } loadSettlements(); }
async function loadFunnel() {
  const run = ++moneyRun;
  const notice = document.getElementById('moneyNotice'), wrap = document.getElementById('moneyFunnelWrap'), body = document.querySelector('#moneyFunnel tbody');
  notice.hidden = true; wrap.hidden = true;
  let stats = null, message = '';
  try { const raw = await apiRequest('/api/admin/stats'); stats = mergeSessionStats(raw); if (!stats) message = raw?.unmigrated ? 'The funnel needs database migration 0013 on the Worker.' : 'No funnel data yet.'; if (stats) stats.totals = raw.totals; }
  catch (error) { message = error.status === 404 ? 'The funnel needs the new Worker deploy (GET /api/admin/stats).' : error.message; }
  if (run !== moneyRun) return;
  const rows = stats ? [...stats.values()].sort((a, b) => (Number(b.searches) || 0) - (Number(a.searches) || 0)) : [];
  const n = (row, key) => Math.max(0, Math.round(Number(row?.[key]) || 0));
  const totals = rows.reduce((sum, row) => { for (const key of ['searches', 'matches', 'zeroMatches', 'checkouts', 'unlocks', 'grants', 'rupees']) sum[key] += n(row, key); return sum; }, { searches: 0, matches: 0, zeroMatches: 0, checkouts: 0, unlocks: 0, grants: 0, rupees: 0 });
  document.getElementById('moneySearches').textContent = totals.searches.toLocaleString('en-IN');
  document.getElementById('moneyMatchRate').textContent = totals.searches ? `${pct(totals.matches, totals.searches)} found a photo · target 60%` : '';
  document.getElementById('moneyUnlocks').textContent = totals.unlocks.toLocaleString('en-IN');
  document.getElementById('moneyUnlockRate').textContent = totals.matches ? `${pct(totals.unlocks, totals.matches)} of result views · target 25%` : '';
  document.getElementById('moneyRupees').textContent = formatRupees(totals.rupees * 100);
  document.getElementById('moneyGrants').textContent = totals.grants ? `${plural(totals.grants, 'free unlock')} not counted` : '';
  if (!stats) { notice.textContent = message; notice.hidden = false; return; }
  if (!rows.length) { notice.textContent = 'No sessions yet.'; notice.hidden = false; return; }
  body.innerHTML = rows.map(row => `<tr${n(row, 'searches') ? '' : ' class="is-muted"'}><td>${escHtml(row.title || dashboardSessions.get(row.sessionId)?.title || row.sessionId)}</td><td class="num">${n(row, 'searches').toLocaleString('en-IN')}</td><td class="num">${n(row, 'matches').toLocaleString('en-IN')}<span class="rate">${pct(n(row, 'matches'), n(row, 'searches'))}</span></td><td class="num">${n(row, 'zeroMatches').toLocaleString('en-IN')}<span class="rate">${pct(n(row, 'zeroMatches'), n(row, 'searches'))}</span></td><td class="num">${n(row, 'checkouts').toLocaleString('en-IN')}</td><td class="num">${n(row, 'unlocks').toLocaleString('en-IN')}<span class="rate">${pct(n(row, 'unlocks'), n(row, 'matches'))}</span></td><td class="num">${n(row, 'grants').toLocaleString('en-IN')}</td><td class="num">${formatRupees(n(row, 'rupees') * 100)}</td></tr>`).join('');
  wrap.hidden = false;
}
let settlementsRun = 0;
async function loadSettlements() {
  const run = ++settlementsRun;
  const notice = document.getElementById('settlementsNotice'), wrap = document.getElementById('settlementsWrap'), list = document.getElementById('unreconciledList');
  const from = document.getElementById('settleFrom').value, to = document.getElementById('settleTo').value;
  notice.hidden = true; wrap.hidden = true; list.hidden = true;
  let data = null, message = '';
  try { data = await apiRequest(`/api/admin/settlements?${new URLSearchParams({ from, to })}`); }
  catch (error) { message = error.status === 404 ? 'Settlements need the new Worker deploy (GET /api/admin/settlements).' : error.status === 503 ? `Cashfree isn't configured on the Worker yet — ${error.message}` : error.message; }
  if (run !== settlementsRun) return;
  if (!data) { notice.textContent = message; notice.hidden = false; return; }
  const rows = Array.isArray(data.settlements) ? data.settlements : [];
  if (!rows.length) { notice.textContent = `No settlements between ${dateLabel(from)} and ${dateLabel(to)}.`; notice.hidden = false; }
  else {
    document.querySelector('#settlementsList tbody').innerHTML = rows.map(row => `<tr><td>${escHtml(dateLabel(row.settledAt))}</td><td>${escHtml(row.utr || '—')}</td><td>${escHtml(row.from ? `${dateLabel(row.from)} – ${dateLabel(row.to)}` : '—')}</td><td>${escHtml(row.status || '—')}</td><td class="num">${formatRupees(row.amountPaise)}</td></tr>`).join('') + `<tr class="total"><td colspan="4">Total</td><td class="num">${formatRupees(rows.reduce((sum, row) => sum + (Number(row.amountPaise) || 0), 0))}</td></tr>`;
    wrap.hidden = false;
  }
  const unreconciled = Array.isArray(data.unreconciled) ? data.unreconciled : [];
  if (unreconciled.length) {
    list.replaceChildren();
    const intro = document.createElement('strong'); intro.textContent = `${plural(unreconciled.length, 'captured payment')} not in any settlement yet`; list.append(intro, ' — usually the next payout cycle; look one up if it is older than a week.');
    const ul = document.createElement('ul');
    unreconciled.forEach(id => { const li = document.createElement('li'); const button = document.createElement('button'); button.type = 'button'; const orderId = String(id).startsWith('mj-') ? String(id) : `mj-${id}`; button.textContent = orderId; button.title = 'Look this payment up in Support'; button.addEventListener('click', () => { document.getElementById('supportQuery').value = orderId; activateTab(document.getElementById('nav-support'), { focusPanel: false }); document.getElementById('supportForm').requestSubmit(); }); li.append(button); ul.append(li); });
    list.append(ul); list.hidden = false;
  }
}
document.getElementById('refreshMoneyBtn').addEventListener('click', () => loadMoneyTab());
document.getElementById('settleRangeForm').addEventListener('submit', event => { event.preventDefault(); loadSettlements(); });

// ── Support tab: lookup, resend, free unlock, refund ─────────────────────────

// One box: a phone, a Cashfree order id (mj-… / order_…) or a search id, detected as the crew types. Results come
// from GET /api/admin/lookup (W3-B) as cards — searches with the "what the guest saw" strip, payments with Refund.
// Every action hides itself with a plain notice when its route 404s (older Worker). Phones arrive masked.
const supportResults = document.getElementById('supportResults');
const SUPPORT_KIND_LABEL = { phone: 'Looking up a phone', order: 'Looking up a Cashfree order', search: 'Looking up a search id' };
document.getElementById('supportQuery').addEventListener('input', event => { const { kind } = detectSupportQuery(event.currentTarget.value); document.getElementById('supportDetected').textContent = kind ? SUPPORT_KIND_LABEL[kind] : ''; });
let supportRun = 0;
async function runSupportLookup(query) {
  const run = ++supportRun;
  const notice = document.getElementById('supportNotice');
  const { kind, value } = detectSupportQuery(query);
  if (!kind) return;
  notice.hidden = true; supportResults.innerHTML = '<p class="loading-msg">Looking…</p>';
  try {
    const body = await apiRequest(`/api/admin/lookup?${new URLSearchParams({ [kind]: value })}`);
    if (run !== supportRun) return;
    renderSupport(body, { kind, value });
  } catch (error) {
    if (run !== supportRun) return;
    supportResults.replaceChildren();
    notice.textContent = error.status === 404 ? 'Support lookup needs the new Worker deploy (GET /api/admin/lookup).' : error.message; notice.hidden = false;
  }
}
document.getElementById('supportForm').addEventListener('submit', event => { event.preventDefault(); runSupportLookup(document.getElementById('supportQuery').value); });
const SEARCH_STATUS = { paid: ['Paid', 'chip--slate'], granted: ['Free unlock', 'chip--slate'], expired: ['Expired', ''], pending: ['Not paid', 'chip--terracotta'] };
function renderSupport(body, { kind, value }) {
  const searches = Array.isArray(body?.searches) ? body.searches : [], payments = Array.isArray(body?.payments) ? body.payments : [], notify = Array.isArray(body?.notify) ? body.notify : [];
  supportResults.replaceChildren();
  if (!searches.length && !payments.length && !notify.length) { supportResults.innerHTML = `<p class="support-empty">Nothing for ${escHtml(kind === 'phone' ? `the phone ending ${value.slice(-4)}` : value)}. Guests only appear here once they reach checkout — a search alone leaves no phone.</p>`; return; }
  const phone = body.phone || searches.find(item => item.phone)?.phone || payments.find(item => item.phone)?.phone || '';
  const card = (kindName, headHtml) => { const el = document.createElement('article'); el.className = 'support-card'; el.dataset.kind = kindName; el.innerHTML = `<h3>${headHtml}</h3>`; supportResults.append(el); return el; };
  const facts = pairs => `<div class="support-facts">${pairs.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `<div><span>${escHtml(k)}</span><strong>${escHtml(String(v))}</strong></div>`).join('')}</div>`;
  for (const search of searches) {
    const [statusLabel, chip] = SEARCH_STATUS[search.status] || [search.status || '—', ''];
    const paid = search.status === 'paid' || search.status === 'granted' || Boolean(search.paidAt);
    const el = card('search', `Search <code>${escHtml(search.id)}</code> <span class="chip ${chip}">${escHtml(statusLabel)}</span>`);
    el.dataset.searchId = search.id;
    el.insertAdjacentHTML('beforeend', facts([['Session', search.sessionTitle || search.sessionId], ['Searched', search.createdAt ? dateTimeLabel(search.createdAt) : ''], ['Phone', phone], ['Matched', search.matchedCount ?? ''], ['Hidden by guest', search.hiddenCount || ''], ['Colour picks', search.colourCount || ''], ['Paid', search.paidAt ? dateTimeLabel(search.paidAt) : ''], ['Gallery link until', search.galleryLinkExpiresAt ? dateLabel(search.galleryLinkExpiresAt) : ''], ['Search valid until', !paid && search.expiresAt ? dateTimeLabel(search.expiresAt) : '']]));
    const saw = Array.isArray(search.photos) ? search.photos : Array.isArray(search.saw) ? search.saw : [];
    if (saw.length) el.insertAdjacentHTML('beforeend', `<div class="guest-saw"><p id="saw-${escHtml(search.id)}">What the guest saw · ${saw.length}</p><div class="guest-saw-scroll" tabindex="0" role="region" aria-labelledby="saw-${escHtml(search.id)}"><ul>${saw.map(item => `<li${item.hidden ? ' class="is-hidden"' : ''}><img src="${escHtml(item.thumbUrl || item.url || '')}" alt="${escHtml(item.hidden ? 'Hidden by the guest' : 'Matched photo')}" loading="lazy" decoding="async" /></li>`).join('')}</ul></div></div>`);
    el.insertAdjacentHTML('beforeend', `<div class="support-actions">${paid ? `<button class="btn-sm btn-primary-sm" type="button" data-support="resend">Resend link</button>` : `<button class="btn-sm btn-primary-sm" type="button" data-support="grant">Free unlock</button>`}</div>`);
  }
  for (const payment of payments) {
    const refundable = payment.status === 'captured' && !['PENDING', 'SUCCESS'].includes(String(payment.refundStatus || '').toUpperCase()) && (Number(payment.amountPaise) || 0) > (Number(payment.refundedPaise) || 0);
    const el = card('payment', `Payment ${formatRupees(payment.amountPaise)} <span class="chip ${payment.status === 'captured' ? 'chip--slate' : 'chip--terracotta'}">${escHtml(payment.status || '—')}</span>${payment.refundStatus ? ` <span class="chip">Refund ${escHtml(String(payment.refundStatus).toLowerCase())}</span>` : ''}`);
    el.dataset.paymentId = payment.id;
    el.insertAdjacentHTML('beforeend', facts([['Order', payment.orderId], ['Cashfree payment', payment.cfPaymentId], ['Search', payment.searchId], ['Phone', phone], ['Created', payment.createdAt ? dateTimeLabel(payment.createdAt) : ''], ['Paid', payment.paidAt ? dateTimeLabel(payment.paidAt) : ''], ['Refunded', payment.refundedPaise ? formatRupees(payment.refundedPaise) : '']]));
    if (refundable) el.insertAdjacentHTML('beforeend', `<div class="support-actions"><button class="delete-btn" type="button" data-support="refund" data-amount="${(Number(payment.amountPaise) || 0) - (Number(payment.refundedPaise) || 0)}">Refund ${formatRupees((Number(payment.amountPaise) || 0) - (Number(payment.refundedPaise) || 0))}</button></div>`);
  }
  if (notify.length) {
    const el = card('notify', 'Notify-me requests');
    el.insertAdjacentHTML('beforeend', `<ul class="support-notify">${notify.map(item => `<li>Search <code>${escHtml(item.searchId)}</code> · asked ${escHtml(item.createdAt ? dateTimeLabel(item.createdAt) : '—')} · ${item.notifiedAt ? `told ${escHtml(dateTimeLabel(item.notifiedAt))}` : 'not told yet'}</li>`).join('')}</ul>`);
  }
}
function showSupportLink(el, link, expiresAt, note) {
  el.querySelector('.support-link')?.remove();
  const box = document.createElement('p'); box.className = 'support-link'; box.textContent = link;
  const small = document.createElement('small'); small.textContent = `${note} Valid until ${dateLabel(expiresAt)}. Send it to the guest on WhatsApp.`; box.append(small);
  el.append(box);
}
async function copyText(text) { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } }
supportResults.addEventListener('click', async event => {
  const button = event.target.closest('button[data-support]'); if (!button || button.disabled) return;
  const el = button.closest('.support-card'); const action = button.dataset.support;
  const busy = (on, label) => { button.disabled = on; if (label) button.textContent = label; };
  try {
    if (action === 'resend') {
      busy(true, 'Minting…');
      const { link, expiresAt } = await apiRequest(`/api/admin/searches/${el.dataset.searchId}/resend`, { method: 'POST' });
      showSupportLink(el, link, expiresAt, 'Fresh 30-day link.');
      notifyCrew(await copyText(link) ? 'Link copied — paste it to the guest.' : 'Link ready below — copy it to the guest.', 'success');
      busy(false, 'Resend link');
    } else if (action === 'grant') {
      const answer = await confirmAction({ title: 'Unlock for free?', copy: 'The guest gets a 30-day gallery link without paying. Say why, for the books.', confirmLabel: 'Unlock', danger: false, reason: { label: 'Reason', required: true, placeholder: 'e.g. paid twice, photographer’s friend' } });
      if (!answer) return;
      busy(true, 'Unlocking…');
      const { link, expiresAt } = await apiRequest(`/api/admin/searches/${el.dataset.searchId}/grant`, { method: 'POST', body: JSON.stringify({ reason: answer.reason }) });
      showSupportLink(el, link, expiresAt, 'Free unlock.');
      el.querySelector('h3 .chip').textContent = 'Free unlock';
      notifyCrew(await copyText(link) ? 'Unlocked — link copied.' : 'Unlocked — link below.', 'success');
      button.remove();
    } else if (action === 'refund') {
      const amountPaise = Number(button.dataset.amount) || 0;
      const answer = await confirmAction({ title: `Refund ${formatRupees(amountPaise)}?`, copy: `Refund ${formatRupees(amountPaise)} to the guest? Cashfree returns it to the card or UPI they paid with in 5–7 working days. Type REFUND.`, confirmLabel: 'Refund', typed: 'REFUND', reason: { label: 'Reason', required: true, placeholder: 'e.g. wrong person matched' } });
      if (!answer) return;
      busy(true, 'Refunding…');
      const { refund } = await apiRequest(`/api/admin/payments/${el.dataset.paymentId}/refund`, { method: 'POST', body: JSON.stringify({ amountPaise, reason: answer.reason }) });
      notifyCrew(`Refund of ${formatRupees(refund?.amountPaise ?? amountPaise)} requested — Cashfree confirms it by webhook.`, 'success');
      el.querySelector('h3').insertAdjacentHTML('beforeend', ` <span class="chip">Refund ${escHtml(String(refund?.status || 'pending').toLowerCase())}</span>`);
      button.remove();
    }
  } catch (error) {
    notifyCrew(error.status === 404 ? 'That needs the new Worker deploy.' : error.message, 'error');
    busy(false, action === 'resend' ? 'Resend link' : action === 'grant' ? 'Free unlock' : button.textContent.replace('Refunding…', 'Refund'));
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


if (isAuthenticated()) showApp(); else focusLogin();
