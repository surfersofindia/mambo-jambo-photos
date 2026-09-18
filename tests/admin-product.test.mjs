// W3-C · crew studio product features: bulk photo actions, cover-picker publish, session conditions with EXIF
// pre-fill, indexing observability, review confidence meter, Money and Support tabs. admin.js is a classic script
// with top-level DOM access, so its pure helpers are sliced out by banner and run in a vm context; the DOM-bound
// blocks (bulk, cover step) run against a tiny fake document. Nothing here touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deepEqual as looseEqual } from 'node:assert';   // values built inside a vm context have another realm's Object prototype
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const source = await readFile(new URL('admin.js', root), 'utf8');
const html = await readFile(new URL('admin.html', root), 'utf8');
const css = await readFile(new URL('admin-theme.css', root), 'utf8');
const tokens = await readFile(new URL('soi-tokens.css', root), 'utf8');
const slice = (from, to) => { const start = source.indexOf(from), end = source.indexOf(to, start); assert.ok(start >= 0 && end > start, `admin.js no longer has the block ${from} … ${to}`); return source.slice(start, end); };
const helpersSource = slice('// ── Pure helpers', '// ── DOM references');
const helpers = vm.runInNewContext(`${helpersSource}\n({ formatEta, formatIndexingLine, confidenceBand, conditionsPayload, datetimeLocalToIso, isoToDatetimeLocal, formatConditionsLine, readExif, exifSuggestion, formatRupees, detectSupportQuery, defaultSettlementRange, chunkIds, summariseBulk })`, {});

// ── EXIF bytes built by hand: SOI, APP1 "Exif\0\0", TIFF header, IFD0 (Model, ExifIFD pointer), Exif IFD (DateTimeOriginal) ──
function exifJpeg({ model = 'Canon EOS R6', dateTimeOriginal = '2026:09:17 06:41:12', littleEndian = false, dateInIfd0 = false, noApp1 = false } = {}) {
  if (noApp1) return Buffer.from([0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x04, 0x00, 0x00, 0xFF, 0xD9]);
  const u16 = (b, o, v) => littleEndian ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o);
  const u32 = (b, o, v) => littleEndian ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o);
  const modelBuf = Buffer.from(`${model}\0`, 'latin1'), dtoBuf = Buffer.from(`${dateTimeOriginal}\0`, 'latin1');
  const ifd0Count = dateInIfd0 ? 2 : 2, exifCount = 1;
  const ifd0Offset = 8, exifOffset = ifd0Offset + 2 + ifd0Count * 12 + 4, blobStart = exifOffset + 2 + exifCount * 12 + 4;
  const entry = (tag, type, count, valueOrOffset) => { const e = Buffer.alloc(12); u16(e, 0, tag); u16(e, 2, type); u32(e, 4, count); u32(e, 8, valueOrOffset); return e; };
  const modelAt = blobStart, dtoAt = blobStart + modelBuf.length;
  const ifd0 = Buffer.concat([Buffer.alloc(2), entry(0x0110, 2, modelBuf.length, modelAt), dateInIfd0 ? entry(0x9003, 2, dtoBuf.length, dtoAt) : entry(0x8769, 4, 1, exifOffset), Buffer.alloc(4)]); u16(ifd0, 0, ifd0Count);
  const exifIfd = Buffer.concat([Buffer.alloc(2), entry(0x9003, 2, dtoBuf.length, dtoAt), Buffer.alloc(4)]); u16(exifIfd, 0, exifCount);
  const header = Buffer.alloc(8); header.write(littleEndian ? 'II' : 'MM', 0, 'latin1'); u16(header, 2, 42); u32(header, 4, ifd0Offset);
  const tiff = Buffer.concat([header, ifd0, exifIfd, modelBuf, dtoBuf]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const seg = Buffer.alloc(4); seg[0] = 0xFF; seg[1] = 0xE1; seg.writeUInt16BE(payload.length + 2, 2);
  // A JFIF APP0 before the APP1 and a DQT after, like a real camera file.
  const app0 = Buffer.from([0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), app0, seg, payload, Buffer.from([0xFF, 0xDB, 0x00, 0x04, 0x00, 0x00, 0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9])]);
}

test('readExif walks APP1/TIFF for Model and DateTimeOriginal in both byte orders and shrugs at anything else', () => {
  looseEqual(helpers.readExif(exifJpeg()), { dateTimeOriginal: '2026:09:17 06:41:12', model: 'Canon EOS R6' });
  looseEqual(helpers.readExif(exifJpeg({ littleEndian: true, model: 'iPhone 15 Pro', dateTimeOriginal: '2026:09:17 07:22:41' })), { dateTimeOriginal: '2026:09:17 07:22:41', model: 'iPhone 15 Pro' });
  looseEqual(helpers.readExif(exifJpeg({ dateInIfd0: true })), { dateTimeOriginal: '2026:09:17 06:41:12', model: 'Canon EOS R6' }, 'a DateTimeOriginal sitting in IFD0 is still found');
  looseEqual(helpers.readExif(exifJpeg({ noApp1: true })), { dateTimeOriginal: null, model: null }, 'no APP1: nothing');
  looseEqual(helpers.readExif(Buffer.from('RIFF....WEBPVP8 ', 'latin1')), { dateTimeOriginal: null, model: null }, 'not a JPEG');
  looseEqual(helpers.readExif(exifJpeg().subarray(0, 40)), { dateTimeOriginal: null, model: null }, 'truncated mid-TIFF never throws');
  looseEqual(helpers.readExif(exifJpeg({ dateTimeOriginal: '    :  :     :  :  ' })), { dateTimeOriginal: null, model: 'Canon EOS R6' }, 'a blank camera date is dropped');
  looseEqual(helpers.readExif(new Uint8Array(0)), { dateTimeOriginal: null, model: null });
});

test('exifSuggestion turns the sampled stamps into the session date, a shooting window and the most-used camera', () => {
  const entries = [{ dateTimeOriginal: '2026:09:17 07:22:41', model: 'Canon EOS R6' }, { dateTimeOriginal: '2026:09:17 06:41:12', model: 'Canon EOS R6' }, { dateTimeOriginal: '2026:09:17 08:05:19', model: 'iPhone 15 Pro' }, { dateTimeOriginal: null, model: null }];
  const view = helpers.exifSuggestion(entries);
  assert.deepEqual([view.date, view.from, view.to, view.model], ['2026-09-17', '06:41', '08:05', 'Canon EOS R6']);
  assert.equal(view.hint, 'Shot 06:41–08:05 on 17 Sept with a Canon EOS R6.');
  assert.equal(helpers.exifSuggestion([{ dateTimeOriginal: '2026:09:17 06:41:12', model: null }]).hint, 'Shot at 06:41 on 17 Sept.');
  assert.equal(helpers.exifSuggestion([{ dateTimeOriginal: null, model: 'Sony A7 IV' }]).hint, 'Shot with a Sony A7 IV.');
  assert.match(helpers.exifSuggestion([{ dateTimeOriginal: '2026:09:16 23:50:00' }, { dateTimeOriginal: '2026:09:17 00:20:00' }]).hint, /23:50 \(16 Sept\) – 00:20 \(17 Sept\)/, 'a session across midnight names both days');
  assert.equal(helpers.exifSuggestion([{ dateTimeOriginal: null, model: null }]), null);
  assert.equal(helpers.exifSuggestion([]), null);
});

test('the create and edit forms send the six condition keys — trimmed, bounded, nulls for empties — and the edit dirty guard covers them', () => {
  const full = helpers.conditionsPayload({ breakName: '  Mulki   river mouth ', swellFt: '3.55', wind: ' Offshore ', tide: 'RISING', photographer: 'Ankith', nextDropAt: '2026-09-18T07:00' });
  looseEqual({ ...full, nextDropAt: full.nextDropAt.slice(0, 4) }, { breakName: 'Mulki river mouth', swellFt: 3.6, wind: 'offshore', tide: 'rising', photographer: 'Ankith', nextDropAt: '2026' });
  assert.equal(new Date(full.nextDropAt).getTime(), new Date('2026-09-18T07:00').getTime(), 'the local wall-clock time becomes ISO');
  looseEqual(helpers.conditionsPayload({}), { breakName: null, swellFt: null, wind: null, tide: null, photographer: null, nextDropAt: null });
  looseEqual(helpers.conditionsPayload({ swellFt: '45', wind: 'x'.repeat(50), breakName: 'y'.repeat(80), nextDropAt: 'garbage' }), { breakName: 'y'.repeat(60), swellFt: 30, wind: 'x'.repeat(30), tide: null, photographer: null, nextDropAt: null }, 'clamped to the Worker ranges');
  assert.equal(helpers.conditionsPayload({ swellFt: '0' }).swellFt, 0, 'zero is a value, not empty');
  assert.equal(helpers.isoToDatetimeLocal(helpers.datetimeLocalToIso('2026-09-18T07:00')), '2026-09-18T07:00', 'round-trips for the edit modal');
  assert.equal(helpers.isoToDatetimeLocal(null), '');
  // The source sends them from both forms and the edit modal's dirty check watches every condition field.
  assert.match(source, /\/api\/admin\/sessions', \{ method: 'POST', body: JSON\.stringify\(\{ title, date, location, pricePaise, \.\.\.readConditions\(ADMIN_CONDITION_IDS\) \}\)/);
  assert.match(source, /body: JSON\.stringify\(\{ title, date, location, pricePaise, status, \.\.\.readConditions\(EDIT_CONDITION_IDS\) \}\)/);
  assert.match(source, /const editFormState = \(\) => \['editTitle', 'editDate', 'editLocation', 'editPrice', 'editStatus', \.\.\.Object\.values\(EDIT_CONDITION_IDS\)\]/);
  for (const id of ['adminBreakName', 'adminSwell', 'adminWind', 'adminTide', 'adminPhotographer', 'adminNextDrop', 'editBreakName', 'editSwell', 'editWind', 'editTide', 'editPhotographer', 'editNextDrop', 'exifHint', 'adminConditions']) assert.ok(html.includes(`id="${id}"`), `admin.html has #${id}`);
  // The EXIF pre-fill never overwrites a typed date, and only reads a bounded head of a bounded sample.
  assert.match(source, /if \(suggestion\.date && !dateInput\.dataset\.typed\) dateInput\.value = suggestion\.date/);
  assert.match(source, /const EXIF_SAMPLE = 12, EXIF_HEAD_BYTES = 256 \* 1024/);
  assert.match(source, /file\.slice\(0, EXIF_HEAD_BYTES\)\.arrayBuffer\(\)/);
});

test('the card conditions line and the indexing line read like a person wrote them', () => {
  assert.equal(helpers.formatConditionsLine({ breakName: 'Mulki river mouth', swellFt: 3.5, wind: 'offshore', tide: 'rising', photographer: 'Ankith' }, '2026-09-18T01:30:00.000Z', new Date('2026-09-17T04:00:00Z').getTime()), `Mulki river mouth · 3.5 ft · offshore · rising tide · by Ankith · next drop ${new Date('2026-09-18T01:30:00.000Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}, ${new Date('2026-09-18T01:30:00.000Z').toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}`);
  assert.equal(helpers.formatConditionsLine(null, null), '');
  assert.match(helpers.formatConditionsLine({}, '2026-09-10T01:30:00.000Z', new Date('2026-09-17T04:00:00Z').getTime()), /^dropped /, 'a past drop reads as dropped');
  assert.equal(helpers.formatConditionsLine({ swellFt: 0 }, null), '0 ft');
  const view = helpers.formatIndexingLine({ queued: 42, processing: 3, done: 83, failed: 5, etaSeconds: 372, failures: [{ reason: 'Image could not be decoded', count: 2 }, { reason: 'Face service timed out', count: 3 }, { reason: '', count: 9 }, null] });
  assert.equal(view.line, '42 queued · 3 running · ETA 7 min · 5 failed');
  looseEqual(view.failures, [{ reason: 'Face service timed out', count: 3 }, { reason: 'Image could not be decoded', count: 2 }], 'grouped, biggest first, blanks dropped');
  looseEqual(helpers.formatIndexingLine({ queued: 0, processing: 0, done: 12, failed: 0, etaSeconds: null, failures: [] }), { line: '', failures: [] }, 'a finished session says nothing — the badge already does');
  assert.equal(helpers.formatIndexingLine({ queued: 1, etaSeconds: 3 }).line, '1 queued · ETA 5 s');
  assert.equal(helpers.formatIndexingLine({ queued: 400, etaSeconds: 7300 }).line, '400 queued · ETA 2 h');
  assert.equal(helpers.formatIndexingLine({ queued: 2, etaSeconds: null }).line, '2 queued', 'unknown ETA is left out');
  assert.equal(helpers.formatIndexingLine({ queued: 0, failed: 3, failures: [{ reason: 'x', count: 3 }] }).line, '', 'nothing running: the failure chips speak, not the line');
  assert.equal(helpers.formatIndexingLine(undefined), null, 'an older Worker: keep the badge alone');
  assert.equal(helpers.formatEta('nope'), '');
});

test('review confidence: bands under 50 / 50–74 / 75+, a role="meter" with the number in its name, and the whole frame beside each crop', () => {
  assert.deepEqual([0, 49, 50, 74, 75, 100, 'x'].map(helpers.confidenceBand), ['low', 'low', 'mid', 'mid', 'high', 'high', 'low']);
  const meterSource = slice('function confidenceMeter(', 'function renderFullFrame(');
  const meter = vm.runInNewContext(`${helpersSource}\n${meterSource}\nfunction escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}\nconfidenceMeter`, {});
  const out = meter(61, 'borderline', 'Face similarity');
  assert.match(out, /role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="61" aria-label="Face similarity 61%" data-band="mid"/);
  assert.match(out, /<i style="width:61%"><\/i>/);
  assert.match(meter(140, 'x', 'y'), /aria-valuenow="100"/);
  assert.match(meter('junk', 'x', 'y'), /aria-valuenow="0"/);
  // Both queues render the meter; each face figure carries a whole-frame canvas drawn from the same decoded image
  // with the face outlined, and the crop canvases alone gate the Same / Different buttons.
  assert.match(source, /confidenceMeter\(item\.similarityPct, 'borderline', 'Face similarity'\)/);
  assert.match(source, /confidenceMeter\(item\.scorePct, note, item\.linkType === 'burst' \? 'Timing closeness' : 'Kit similarity'\)/);
  assert.match(source, /<canvas class="face-full-canvas"/);
  assert.match(source, /if \(full\) try \{ renderFullFrame\(full, image, JSON\.parse\(canvas\.dataset\.bboxNorm\)\); \}/);
  assert.match(source, /card\.querySelectorAll\('\.face-crop-canvas'\)\]\.every\(item => item\.dataset\.ready === 'true'\)/);
  // renderFullFrame keeps the photo's aspect and strokes the box.
  const renderSource = slice('function renderFullFrame(', 'async function drawCroppedFaceCanvas(');
  const calls = [];
  const context = { canvas: { getContext: () => ({ drawImage: (...a) => calls.push(['draw', ...a.slice(1)]), strokeRect: (...a) => calls.push(['box', ...a.map(Math.round)]), set lineWidth(v) { calls.push(['lw', v]); }, set strokeStyle(v) { calls.push(['stroke', v]); } }) } };
  vm.runInNewContext(`${renderSource}\nrenderFullFrame(canvas, { naturalWidth: 4000, naturalHeight: 3000 }, [10, 20, 30, 40])`, context);
  assert.deepEqual([context.canvas.width, context.canvas.height], [480, 360]);
  assert.deepEqual(calls.find(c => c[0] === 'box'), ['box', 96, 36, 144, 144], 'left/top/width/height from the normalised bbox');
});

test('support lookups detect a phone (with +91 / spaces), a Cashfree order id or a search id; money formats paise and the default range', () => {
  looseEqual(helpers.detectSupportQuery(' +91 98765 43221 '), { kind: 'phone', value: '9876543221' });
  looseEqual(helpers.detectSupportQuery('9876543221'), { kind: 'phone', value: '9876543221' });
  looseEqual(helpers.detectSupportQuery('mj-8f2a1b'), { kind: 'order', value: 'mj-8f2a1b' });
  looseEqual(helpers.detectSupportQuery('order_9f31ab'), { kind: 'order', value: 'order_9f31ab' });
  looseEqual(helpers.detectSupportQuery('srch-8f2a'), { kind: 'search', value: 'srch-8f2a' });
  looseEqual(helpers.detectSupportQuery('1234567890'), { kind: 'search', value: '1234567890' }, 'not an Indian mobile: treated as an id');
  looseEqual(helpers.detectSupportQuery('   '), { kind: null, value: '' });
  assert.equal(helpers.formatRupees(70000), '₹700');
  assert.equal(helpers.formatRupees(12500000), '₹1,25,000');
  assert.equal(helpers.formatRupees('junk'), '₹0');
  looseEqual(helpers.defaultSettlementRange(new Date(2026, 8, 17, 9, 30)), { from: '2026-08-18', to: '2026-09-17' });
  looseEqual(helpers.chunkIds(Array.from({ length: 450 }, (_, i) => i)).map(c => c.length), [200, 200, 50]);
  assert.equal(helpers.summariseBulk('delete', { affected: 3, failed: [] }), '3 photos deleted.');
  assert.equal(helpers.summariseBulk('move', { affected: 1, failed: [{ photoId: 'p2', error: 'Photo not found.' }] }), '1 photo moved; 1 failed — Photo not found.');
  // Refund confirm: typed REFUND + a required reason; free unlock needs a reason too; resend copies the link.
  assert.match(source, /Type REFUND\.`, confirmLabel: 'Refund', typed: 'REFUND', reason: \{ label: 'Reason', required: true/);
  assert.match(source, /confirmLabel: 'Unlock', danger: false, reason: \{ label: 'Reason', required: true/);
  assert.match(source, /apiRequest\(`\/api\/admin\/payments\/\$\{el\.dataset\.paymentId\}\/refund`, \{ method: 'POST', body: JSON\.stringify\(\{ amountPaise, reason: answer\.reason \}\) \}\)/);
  assert.match(source, /apiRequest\(`\/api\/admin\/searches\/\$\{el\.dataset\.searchId\}\/resend`, \{ method: 'POST' \}\)/);
  assert.match(source, /apiRequest\(`\/api\/admin\/searches\/\$\{el\.dataset\.searchId\}\/grant`, \{ method: 'POST', body: JSON\.stringify\(\{ reason: answer\.reason \}\) \}\)/);
  assert.match(source, /apiRequest\(`\/api\/admin\/lookup\?\$\{new URLSearchParams\(\{ \[kind\]: value \}\)\}`\)/);
  assert.match(source, /apiRequest\(`\/api\/admin\/settlements\?\$\{new URLSearchParams\(\{ from, to \}\)\}`\)/);
});

// A tiny fake document for the DOM-bound blocks: every element has a dataset, classList, hidden flag and no-op listeners.
function fakeElement(extra = {}) {
  const el = { hidden: false, disabled: false, textContent: '', innerHTML: '', dataset: {}, classes: new Set(), listeners: {}, children: [] };
  el.classList = { toggle: (name, on) => { (on === undefined ? !el.classes.has(name) : on) ? el.classes.add(name) : el.classes.delete(name); }, add: n => el.classes.add(n), remove: n => el.classes.delete(n), contains: n => el.classes.has(n) };
  el.addEventListener = (type, fn) => { (el.listeners[type] ||= []).push(fn); };
  el.querySelector = () => null; el.querySelectorAll = () => [];
  el.remove = () => { el.removed = true; }; el.setAttribute = (k, v) => { el.attrs = { ...(el.attrs || {}), [k]: v }; };
  return Object.assign(el, extra);
}
function bulkHarness({ api }) {
  const bulkSource = slice('// ── Photo grid: bulk select', '// ── Cover-picker step before publish');
  const calls = [], toasts = [];
  const photoCards = new Map();
  const grid = fakeElement({ dataset: { sessionId: 'sess-1' } });
  grid.querySelectorAll = sel => sel === '.photo-card' ? [...photoCards.values()] : [];
  grid.querySelector = sel => { const m = sel.match(/^\.photo-card\[data-photo-id="(.+)"\]$/); return m ? photoCards.get(m[1]) || null : null; };
  const ids = { galleryGrid: grid, bulkBar: fakeElement(), gallerySummary: fakeElement(), selectAllPhotos: fakeElement(), clearPhotoSelection: fakeElement(), bulkCount: fakeElement(), bulkProgress: fakeElement(), photoGalleryModal: fakeElement() };
  const context = {
    document: { getElementById: id => ids[id] || fakeElement(), querySelector: () => null },
    apiRequest: async (path, options) => { calls.push({ path, method: options?.method || 'GET', body: options?.body ? JSON.parse(options.body) : null }); return api(path, options); },
    notifyCrew: (text, kind) => toasts.push([text, kind]), loadDashboard: () => {}, CSS: { escape: s => s }, plural: (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`,
    chunkIds: helpers.chunkIds, summariseBulk: helpers.summariseBulk, confirmAction: async () => true, dashboardSessions: new Map(), sessionDateLabel: v => v,
  };
  const bulk = vm.runInNewContext(`${bulkSource}\n({ runBulkAction, get bulkRouteMissing() { return bulkRouteMissing; }, get photoSelection() { return photoSelection; } })`, context);
  const addCard = id => { const card = fakeElement({ dataset: { photoId: id } }); const badge = fakeElement(), note = fakeElement(), cover = fakeElement(); card.querySelector = sel => sel === '.photo-badge' ? badge : sel === '.photo-processing-note' ? note : sel === '.photo-cover-btn' ? cover : null; photoCards.set(id, card); return card; };
  return { bulk, calls, toasts, addCard, photoCards, progress: ids.bulkProgress };
}

test('bulk actions go to POST /api/admin/photos/bulk in chunks of 200; failures stay selected for one more tap', async () => {
  const { bulk, calls, toasts, addCard, photoCards } = bulkHarness({ api: async (path, options) => { const body = JSON.parse(options.body); const flaky = body.action === 'delete' && body.photoIds.includes('p-3'); return { ok: true, affected: body.photoIds.length - (flaky ? 1 : 0), failed: flaky ? [{ photoId: 'p-3', error: 'Photo not found.' }] : [] }; } });
  const ids = Array.from({ length: 250 }, (_, i) => `p-${i}`); ids.forEach(addCard);
  await bulk.runBulkAction('delete', ids);
  assert.deepEqual(calls.map(call => [call.path, call.body.action, call.body.photoIds.length]), [['/api/admin/photos/bulk', 'delete', 200], ['/api/admin/photos/bulk', 'delete', 50]]);
  assert.equal([...photoCards.values()].filter(card => card.removed).length, 249, 'every deleted tile leaves the grid');
  assert.equal(photoCards.get('p-3').removed, undefined, 'the failed one stays');
  assert.deepEqual([...bulk.photoSelection], ['p-3']);
  assert.deepEqual(toasts.at(-1), ['249 photos deleted; 1 failed — Photo not found.', 'error']);
  assert.equal(bulk.bulkRouteMissing, false);
  // move carries the target session and removes the moved tiles.
  calls.length = 0;
  await bulk.runBulkAction('move', ['p-3'], { targetSessionId: 'sess-2', targetTitle: 'Dawn patrol' });
  looseEqual(calls[0].body, { action: 'move', photoIds: ['p-3'], targetSessionId: 'sess-2' });
  assert.equal(photoCards.get('p-3').removed, true);
  assert.match(toasts.at(-1)[0], /Now in “Dawn patrol”/);
});

test('on a Worker without the bulk route, delete loops the per-photo route, re-index falls back to the session route, and move says it needs the new Worker', async () => {
  const seen = [];
  const { bulk, calls, toasts, addCard } = bulkHarness({ api: async (path, options) => {
    if (path === '/api/admin/photos/bulk') throw Object.assign(new Error('Not found'), { status: 404, body: { error: 'Not found' } });
    if (options?.method === 'DELETE') { seen.push(path); if (path.endsWith('/p-2')) throw Object.assign(new Error('Photo not found.'), { status: 404 }); return { success: true }; }
    if (path.endsWith('/reindex')) return { queued: 12, alreadyQueued: 0, failed: 0 };
    if (options?.method === 'PUT') return { updated: true };
    throw new Error(`unexpected ${path}`);
  } });
  ['p-1', 'p-2', 'p-3'].forEach(addCard);
  await bulk.runBulkAction('delete', ['p-1', 'p-2', 'p-3']);
  assert.equal(bulk.bulkRouteMissing, true, 'remembered: the next action skips the probe');
  assert.deepEqual(seen, ['/api/admin/photos/p-1', '/api/admin/photos/p-2', '/api/admin/photos/p-3']);
  assert.deepEqual(toasts.at(-1), ['2 photos deleted; 1 failed — Photo not found.', 'error']);
  assert.deepEqual([...bulk.photoSelection], ['p-2'], 'a real "Photo not found" is a failure, not a missing route');
  calls.length = 0;
  await bulk.runBulkAction('reindex', ['p-3']);
  assert.deepEqual(calls.map(call => call.path), ['/api/admin/sessions/sess-1/reindex'], 'no second probe of /bulk');
  assert.match(toasts.at(-1)[0], /12 photos queued again\. This Worker can only re-index a whole session/);
  calls.length = 0;
  await bulk.runBulkAction('cover', ['p-3']);
  assert.deepEqual(calls.map(call => [call.path, call.method, call.body]), [['/api/admin/sessions/sess-1', 'PUT', { coverPhotoId: 'p-3' }]], 'one cover uses the existing route');
  await assert.rejects(() => bulk.runBulkAction('move', ['p-3'], { targetSessionId: 'sess-2' }), /Moving photos needs the new Worker deploy/);
  await assert.rejects(() => bulk.runBulkAction('cover', ['p-1', 'p-3']), /needs the new Worker deploy/);
});

function coverHarness({ api, pick }) {
  const coverSource = slice('// ── Cover-picker step before publish', '// ── Edit Session Details');
  const calls = [], opened = [];
  const buttons = { publishNoCoverBtn: fakeElement(), publishWithCoverBtn: fakeElement(), coverPickerBar: fakeElement() };
  const modal = fakeElement({ open: true }); modal.close = () => { modal.open = false; modal.listeners.close?.forEach(fn => fn()); };
  const context = {
    document: { getElementById: id => buttons[id] || fakeElement() }, photoGalleryModal: modal, clearPhotoSelection: () => {}, galleryDirty: false, loadDashboard: () => {},
    viewSessionPhotos: (id, title, options) => { opened.push({ id, title, ...options }); setTimeout(() => pick(buttons, modal), 0); },
    withReauth: fn => fn(), apiRequest: async (path, options) => { calls.push({ path, method: options?.method || 'GET', body: options?.body ? JSON.parse(options.body) : undefined }); return api(path, options); },
    setTimeout,
  };
  const cover = vm.runInNewContext(`${coverSource}\n({ publishSession, set coverPick(v) { coverPick = v; } })`, context);
  return { cover, calls, opened, buttons, modal };
}
const needsCover = () => Object.assign(new Error('Pick a cover photo or publish without one.'), { status: 409, body: { error: 'Pick a cover photo or publish without one.', needsCover: true } });

test('publish: an older Worker publishes straight away; the new one answers 409 needsCover and the picker sets the cover then publishes', async () => {
  const plain = coverHarness({ api: async () => ({ published: true }), pick: () => {} });
  assert.equal(await plain.cover.publishSession('sess-1', 'Morning glass', { keepSession: true }), true);
  assert.deepEqual(plain.calls, [{ path: '/api/admin/sessions/sess-1/publish', method: 'POST', body: undefined }]);
  assert.deepEqual(plain.opened, [], 'no picker without a 409');
  let publishes = 0;
  const picked = coverHarness({ api: async (path, options) => { if (path.endsWith('/publish')) { publishes += 1; if (publishes === 1) throw needsCover(); return { published: true }; } return { updated: true }; }, pick: (buttons) => { picked.cover.coverPick = 'photo-7'; buttons.publishWithCoverBtn.listeners.click[0](); } });
  assert.equal(await picked.cover.publishSession('sess-1', 'Morning glass'), true);
  assert.deepEqual(picked.opened, [{ id: 'sess-1', title: 'Morning glass', mode: 'cover' }]);
  assert.deepEqual(picked.calls.map(call => [call.path, call.body]), [['/api/admin/sessions/sess-1/publish', undefined], ['/api/admin/sessions/sess-1', { coverPhotoId: 'photo-7' }], ['/api/admin/sessions/sess-1/publish', undefined]]);
  assert.equal(picked.modal.open, false, 'the picker closes itself');
});

test('publish: "Publish without a cover" sends noCover:true; closing the picker keeps the draft; other errors still throw', async () => {
  let publishes = 0;
  const none = coverHarness({ api: async path => { if (path.endsWith('/publish')) { publishes += 1; if (publishes === 1) throw needsCover(); return { published: true }; } throw new Error('unexpected'); }, pick: buttons => buttons.publishNoCoverBtn.listeners.click[0]() });
  assert.equal(await none.cover.publishSession('sess-1', 'Morning glass'), true);
  assert.deepEqual(none.calls.map(call => call.body), [undefined, { noCover: true }]);
  const closed = coverHarness({ api: async () => { throw needsCover(); }, pick: (buttons, modal) => modal.close() });
  assert.equal(await closed.cover.publishSession('sess-1', 'Morning glass'), false, 'backing out: still a draft');
  assert.equal(closed.calls.length, 1, 'nothing else was sent');
  const broken = coverHarness({ api: async () => { throw Object.assign(new Error('Upload at least one photo before publishing.'), { status: 400 }); }, pick: () => {} });
  await assert.rejects(() => broken.cover.publishSession('sess-1', 'x'), /Upload at least one photo/);
  // Every publish path in the studio goes through publishSession, and the 409 body is what triggers the picker.
  assert.equal((source.match(/\/publish`, \{ method: 'POST'/g) || []).length, 1, 'only publishSession posts to /publish');
  assert.match(source, /if \(error\.status !== 409 \|\| !error\.body\?\.needsCover\) throw error;/);
  assert.match(source, /if \(!await publishSession\(sessionId, title, \{ keepSession: true \}\)\)/, 'the upload flow');
  assert.match(source, /if \(await publishSession\(publishBtn\.dataset\.sessionId, publishBtn\.dataset\.sessionTitle\)\)/, 'the card button');
});

test('the studio markup: five tabs with panels, one <main> around both panes, the ink tokens come from soi-tokens.css, no admin text under 11px', () => {
  const tabs = [...html.matchAll(/<button class="tab-btn[^"]*" id="nav-(\w+)" role="tab" aria-controls="tab-(\w+)"/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(tabs, [['upload', 'upload'], ['dashboard', 'dashboard'], ['verify', 'verify'], ['money', 'money'], ['support', 'support']]);
  for (const [, panel] of tabs) assert.ok(html.includes(`id="tab-${panel}" role="tabpanel" aria-labelledby="nav-${panel}"`), `panel ${panel}`);
  assert.equal((html.match(/<main\b/g) || []).length, 1);
  assert.ok(/<main class="admin-main">[\s\S]*id="loginScreen"[\s\S]*id="adminApp"[\s\S]*<\/main>/.test(html), 'login card and studio inside the landmark');
  assert.ok(html.indexOf('</main>') < html.indexOf('id="photoGalleryModal"'), 'dialogs stay outside main');
  assert.match(source, /if \(btn\.dataset\.tab === 'money'\) loadMoneyTab\(\);/);
  assert.doesNotMatch(css, /--soi-slate-ink:|--soi-ochre-ink:/, 'the local duplicates are gone (W2-A carried request)');
  assert.match(tokens, /--soi-slate-ink:#43617A/); assert.match(tokens, /--soi-ochre-ink:#7A5F30/);
  assert.doesNotMatch(css, /font(?:-size)?:\s*(?:\d{3}\s)?(?:[4-9]|10)(?:\.\d+)?px/, 'no text size under 11px');
  // Every getElementById the new code uses exists once in the page, and the dialog count is still four.
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const [, id] of source.matchAll(/getElementById\('([\w-]+)'\)/g)) assert.ok(ids.includes(id), `#${id}`);
  assert.equal((html.match(/<dialog\b/g) || []).length, 4, 'the cover picker reuses the gallery dialog and Move/Reason reuse the confirm dialog');
  // 44px targets on the new controls.
  assert.match(css, /\.photo-select\{[^}]*width:44px;height:44px/);
  assert.match(css, /\.unreconciled button\{[^}]*min-height:44px/);
  assert.match(css, /\.support-form button\{[^}]*min-height:48px/);
});

test('contrast: every new text pair in the studio is at least 4.5:1 on its background, meter fills at least 3:1 on the track', () => {
  const token = name => tokens.match(new RegExp(`--soi-${name}:(#[0-9A-Fa-f]{6})`))?.[1] || tokens.match(new RegExp(`--${name}:(#[0-9A-Fa-f]{6})`))?.[1];
  const hexToRgb = hex => { const h = hex.replace('#', ''); return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }; };
  const contrast = (fg, bg) => { const lin = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; const L = c => { const x = hexToRgb(c); return .2126 * lin(x.r) + .7152 * lin(x.g) + .0722 * lin(x.b); }; const [hi, lo] = [L(fg), L(bg)].sort((a, b) => b - a); return (hi + .05) / (lo + .05); };
  const text = { 'failure chip': ['terracotta-deep', 'terracotta-tint'], 'exif hint': ['umber', 'slate-tint'], 'table caption': ['ochre-ink', 'surface'], 'unreconciled': ['ochre-ink', 'warning-bg'], 'support detected': ['slate-ink', 'canvas'], 'table head': ['umber-soft', 'linen'], 'slate chip': ['slate-ink', 'slate-tint'], 'session divider': ['ochre-ink', 'canvas'], 'indexing line': ['umber-soft', 'surface'], 'support code': ['terracotta-deep', 'surface'], 'draft chip': ['#8F4D5B', 'coral-tint'] };
  for (const [name, [fg, bg]] of Object.entries(text)) { const ratio = contrast(fg.startsWith('#') ? fg : token(fg), token(bg)); assert.ok(ratio >= 4.5, `${name}: ${ratio.toFixed(2)}`); }
  for (const fill of ['ochre-deep', 'terracotta', 'success']) assert.ok(contrast(token(fill), token('sand')) >= 3, `meter ${fill} on sand`);
  // and the stylesheet really uses those inks where it matters
  assert.match(css, /\.d-card-failures li\{[^}]*color:var\(--soi-terracotta-deep\)/);
  assert.match(css, /\.review-session-divider\{[^}]*color:var\(--soi-ochre-ink\)/);
  assert.match(css, /\.indexing-badge\.processing,\.d-card-status\.published,\.chip--slate\{color:var\(--soi-slate-ink\)\}/);
  assert.match(css, /\.review-meter\[data-band="low"\] i\{background:var\(--soi-terracotta\)\}/);
  assert.match(css, /\.review-meter\[data-band="high"\] i\{background:var\(--success\)\}/);
});

// ── FIX-C (review-fix pass) ────────────────────────────────────────────────────

test('e2e config: --update-snapshots (or E2E_UPDATE_SNAPSHOTS=1) turns the no-baselines skip off, so a fresh platform can write its set', async () => {
  const configSource = await readFile(new URL('playwright.config.mjs', root), 'utf8');
  const { updateSnapshotsRequested } = await import(new URL('playwright.config.mjs', root));
  for (const argv of [['-u'], ['--update-snapshots'], ['--update-snapshots=all'], ['--update-snapshots', 'missing'], ['test', '-g', 'x', '--update-snapshots', '--project=mobile-375']]) assert.equal(updateSnapshotsRequested(argv), true, argv.join(' '));
  for (const argv of [[], ['--update-snapshots=none'], ['--update-snapshots', 'none'], ['--project=mobile-375'], ['--ui']]) assert.equal(updateSnapshotsRequested(argv), false, argv.join(' ') || '(no flags)');
  // The skip is the computed constant (not the bare `!hasBaselines` that ignored the update mode), and the runner hands the
  // decision to the workers through the env — they re-import this file without the CLI arguments.
  assert.match(configSource, /const ignoreSnapshots = !hasBaselines && !updatingSnapshots;/);
  assert.match(configSource, /^\s*ignoreSnapshots,$/m);
  assert.doesNotMatch(configSource, /ignoreSnapshots: !hasBaselines/);
  assert.match(configSource, /if \(updatingSnapshots\) process\.env\.E2E_UPDATE_SNAPSHOTS = '1';/);
  assert.match(configSource, /process\.env\.E2E_UPDATE_SNAPSHOTS === '1'/);
});

test('the silent dashboard poll stands down only for an open card menu, a dialog or a pressed button, and focus survives the re-render', () => {
  const pollSource = slice('function dashboardPollBlocked(', 'async function loadDashboard(');
  // A grid of cards: each card knows its session id, its controls and whether it "is" the focused element.
  const makeCard = (sessionId, controls) => {
    const card = { dataset: { sessionId }, focused: 0, classList: [], tagName: 'DIV', closest: sel => sel === '.d-card' ? card : null, focus(options) { card.focused += 1; card.focusOptions = options; } };
    card.controls = controls.map(([tag, classes]) => ({ tagName: tag, classList: classes, focused: 0, closest: sel => sel === '.d-card' ? card : null, focus(options) { this.focused += 1; this.focusOptions = options; } }));
    card.querySelector = sel => sel.startsWith('.') ? card.controls.find(control => control.classList.includes(sel.slice(1))) || null : card.controls.find(control => control.tagName.toLowerCase() === sel) || null;
    return card;
  };
  const makeGrid = (cards, { menuOpen = false, active = false } = {}) => ({
    cards, matches: sel => sel === ':active' ? active : false, contains: node => cards.some(card => card === node || card.controls.includes(node)),
    querySelector: sel => sel === '.card-more[open]' ? (menuOpen ? {} : null) : (cards.find(card => sel === `.d-card[data-session-id="${card.dataset.sessionId}"]`) || null),
  });
  const document = { activeElement: null, dialogOpen: false, querySelector: sel => sel === 'dialog[open]' ? (document.dialogOpen ? {} : null) : null };
  const api = vm.runInNewContext(`${pollSource}\n({ dashboardPollBlocked, rememberGridFocus, restoreGridFocus })`, { document, CSS: { escape: s => s } });
  const CONTROLS = [['BUTTON', ['btn-sm', 'btn-primary-sm', 'view-photos-btn']], ['BUTTON', ['btn-sm', 'btn-publish', 'publish-session-btn']], ['SUMMARY', ['btn-sm']], ['BUTTON', ['delete-btn']]];
  const before = [makeCard('s1', CONTROLS), makeCard('s2', CONTROLS)];

  // The guard: hover and focus inside the grid no longer block (they used to starve the poll for good after a delete or on touch).
  assert.equal(api.dashboardPollBlocked(makeGrid(before)), false);
  document.activeElement = before[0].controls[0]; assert.equal(api.dashboardPollBlocked(makeGrid(before)), false, 'a focused card button does not block');
  assert.equal(api.dashboardPollBlocked(makeGrid(before, { menuOpen: true })), true, 'an open More menu blocks');
  assert.equal(api.dashboardPollBlocked(makeGrid(before, { active: true })), true, 'a button being pressed blocks');
  document.dialogOpen = true; assert.equal(api.dashboardPollBlocked(makeGrid(before)), true, 'an open dialog blocks'); document.dialogOpen = false;

  // Focus memo: the card's id plus the control's own class (tag for the More summary; '' for the card itself); nothing outside the grid.
  document.activeElement = before[1].controls[0];
  looseEqual(api.rememberGridFocus(makeGrid(before)), { sessionId: 's2', control: 'view-photos-btn' });
  document.activeElement = before[0].controls[2];
  looseEqual(api.rememberGridFocus(makeGrid(before)), { sessionId: 's1', control: 'summary' });
  document.activeElement = before[0];
  looseEqual(api.rememberGridFocus(makeGrid(before)), { sessionId: 's1', control: '' });
  document.activeElement = { tagName: 'BUTTON', classList: ['tab-btn'], closest: () => null };
  assert.equal(api.rememberGridFocus(makeGrid(before)), null, 'focus outside the grid');
  document.activeElement = null;
  assert.equal(api.rememberGridFocus(makeGrid(before)), null);

  // After the re-render (new nodes): the same control on the same card is focused without scrolling; a control that vanished
  // (Publish after publishing) hands focus to its card; a card that vanished (deleted) leaves focus alone.
  const after = [makeCard('s1', CONTROLS.slice(0, 1).concat(CONTROLS.slice(2))), makeCard('s2', CONTROLS)];
  api.restoreGridFocus(makeGrid(after), { sessionId: 's2', control: 'view-photos-btn' });
  assert.equal(after[1].controls[0].focused, 1); looseEqual(after[1].controls[0].focusOptions, { preventScroll: true });
  api.restoreGridFocus(makeGrid(after), { sessionId: 's1', control: 'summary' });
  assert.equal(after[0].controls[1].focused, 1, 'the More summary is found by tag');
  api.restoreGridFocus(makeGrid(after), { sessionId: 's1', control: 'publish-session-btn' });
  assert.equal(after[0].focused, 1, 'a vanished control focuses the card');
  api.restoreGridFocus(makeGrid(after), { sessionId: 's1', control: '' });
  assert.equal(after[0].focused, 2);
  api.restoreGridFocus(makeGrid(after), { sessionId: 'gone', control: 'delete-btn' });
  api.restoreGridFocus(makeGrid(after), null);
  assert.equal(after.reduce((sum, card) => sum + card.focused + card.controls.reduce((s, c) => s + c.focused, 0), 0), 4, 'nothing else was focused');

  // loadDashboard wires them in that order: guard → memo → render → restore; the old :hover/:focus-within guard is gone.
  const load = slice('async function loadDashboard(', 'function updateMetrics(');
  assert.doesNotMatch(load, /:hover, :focus-within/);
  assert.match(load, /if \(silent && dashboardPollBlocked\(grid\)\) return;/);
  assert.ok(load.indexOf('const focusMemo = rememberGridFocus(grid);') < load.indexOf("grid.innerHTML = '<p class=\"loading-msg\">Loading sessions…</p>'"), 'the memo is taken before the grid is cleared');
  assert.ok(load.indexOf('grid.innerHTML = sessions.map(') < load.indexOf('restoreGridFocus(grid, focusMemo);'), 'and restored after the cards are rebuilt');
});
