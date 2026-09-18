import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../admin.js', import.meta.url), 'utf8');
const loaderSource = source.slice(source.indexOf('function createReviewImageLoader()'), source.indexOf('async function drawCroppedFaceCanvas('));
function setup() {
  const requests = [];
  class Image { set src(url) { requests.push({ url, image: this }); } }
  const load = vm.runInNewContext(`${loaderSource}\ncreateReviewImageLoader()`, { Image, URL, window: { location: { origin: 'https://photos.test' } }, apiUrl: path => `https://photos.test${path}` });
  const canvas = (id, url) => ({ dataset: { photoId: id, imgUrl: url } });
  return { requests, load, canvas };
}
test('repeated faces share one download and decoded original even with different signed URLs', async () => {
  const { requests, load, canvas } = setup();
  const first = load(canvas('photo', '/original?token=one'));
  const second = load(canvas('photo', '/original?token=two'));
  assert.equal(requests.length, 1);
  assert.equal(first, second);
  requests[0].image.onload();
  assert.equal(await first, await second);
  assert.equal(await load(canvas('photo', '/original?token=three')), requests[0].image);
  assert.equal(requests.length, 1);
});
test('failed image downloads can retry with a renewed link', async () => {
  const { requests, load, canvas } = setup();
  const first = load(canvas('photo', '/expired'));
  requests[0].image.onerror();
  await assert.rejects(first, /Could not load/);
  const retry = load(canvas('photo', '/renewed'));
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, 'https://photos.test/renewed');
  requests[1].image.onload();
  await retry;
});
test('offscreen pairs wait and intersecting pairs load only once', () => {
  let callback;
  const watched = new Set();
  const loaded = [];
  class IntersectionObserver {
    constructor(fn) { callback = fn; }
    observe(card) { watched.add(card); }
    unobserve(card) { watched.delete(card); }
  }
  const observerSource = source.slice(source.indexOf('let reviewObserver;'), source.indexOf('async function loadVerifyQueue()'));
  const observe = vm.runInNewContext(`${observerSource}\nobserveReviewImages`, {
    window: { IntersectionObserver }, IntersectionObserver,
    createReviewImageLoader: () => () => {},
    drawCroppedFaceCanvas: canvas => loaded.push(canvas),
  });
  const faces = [{}, {}];
  const card = { querySelectorAll: () => faces };
  observe({ querySelectorAll: () => [card] });
  assert.equal(loaded.length, 0);
  callback([{ target: card, isIntersecting: false }]);
  assert.equal(loaded.length, 0);
  callback([{ target: card, isIntersecting: true }]);
  assert.deepEqual(loaded, faces);
  assert.equal(watched.size, 0);
});
test('signed review photos use the same-origin proxy without changing their token', async () => {
  const { requests, load, canvas } = setup();
  const pending = load(canvas('photo', 'https://mambo-jambo-photo-api.surfersofindia.workers.dev/api/media/photo?variant=original&token=signed'));
  assert.equal(requests[0].url, 'https://photos.test/api/media/photo?variant=original&token=signed');
  requests[0].image.onload();
  await pending;
});

// ── Crew studio upload helpers (W1-C): pure helpers sliced out of admin.js, plus the preview worker ──
const helpersSource = source.slice(source.indexOf('// ── Pure helpers'), source.indexOf('// ── DOM references'));
const helpers = vm.runInNewContext(`${helpersSource}\n({ formatProgress, findDuplicateSession, shortDate, menuPlacement })`, {});

test('progress copy reads "n of N photos · x of y MB" with a human speed and ETA, and a calmer live sentence', () => {
  const view = helpers.formatProgress({ percent: 41.6, speed: 1536, etaSeconds: 42.2, done: 12, total: 30, sentBytes: 41 * 1048576, totalBytes: 96.5 * 1048576 });
  assert.equal(view.count, '12 of 30 photos · 41.0 of 96.5 MB');
  assert.equal(view.rate, '1.5 MB/s');
  assert.equal(view.eta, 'ETA: 43s');
  assert.equal(view.percent, 42);
  assert.equal(view.live, '12 of 30 photos · 41.0 of 96.5 MB, 43 seconds left');
  const slow = helpers.formatProgress({ speed: 220, etaSeconds: 400, done: 1, total: 1, sentBytes: 0, totalBytes: 250 * 1048576 });
  assert.equal(slow.count, '1 of 1 photo · 0 of 250 MB');
  assert.equal(slow.rate, '220 KB/s');
  assert.equal(slow.eta, 'ETA: 7 min');
  assert.match(slow.live, /about 7 minutes left$/);
  const start = helpers.formatProgress({ percent: 0, total: 3, totalBytes: 3 * 1048576 });
  assert.deepEqual([start.rate, start.eta, start.percent], ['', '', 0]);
  assert.equal(helpers.formatProgress({ percent: 140 }).percent, 100);
  assert.equal(helpers.formatProgress().count, '');
});

test('duplicate-session check matches date + break case-insensitively, trimmed, and ignores archived sessions', () => {
  const sessions = [
    { id: 'a', date: '2026-09-17', location: 'Mulki Beach', status: 'published' },
    { id: 'b', date: '2026-09-17', location: 'Sasihithlu', status: 'draft' },
    { id: 'c', date: '2026-09-10', location: 'Mulki Beach', status: 'archived' },
  ];
  assert.equal(helpers.findDuplicateSession(sessions, { date: '2026-09-17', location: '  mulki   BEACH ' })?.id, 'a');
  assert.equal(helpers.findDuplicateSession(sessions, { date: '2026-09-17', location: 'Kodi Bengre' }), null);
  assert.equal(helpers.findDuplicateSession(sessions, { date: '2026-09-10', location: 'Mulki Beach' }), null, 'archived sessions are not twins');
  assert.equal(helpers.findDuplicateSession(sessions, { date: '', location: 'Mulki Beach' }), null);
  assert.equal(helpers.findDuplicateSession(undefined, { date: '2026-09-17', location: 'Mulki Beach' }), null);
  assert.equal(helpers.shortDate('2026-09-17'), '17 Sept');
  assert.equal(helpers.shortDate('not-a-date'), 'not-a-date');
});

test('the card menu flips up only when it would run off the bottom and there is room above, and right-aligns at the right edge', () => {
  const viewport = { width: 375, height: 812 };
  const anchor = { top: 700, bottom: 744, left: 250, right: 320, height: 44, width: 70 };
  const below = { top: 750, bottom: 900, left: 250, right: 450, height: 150, width: 200 };
  assert.deepEqual({ ...helpers.menuPlacement({ menu: below, anchor, viewport }) }, { up: true, left: true });
  assert.deepEqual({ ...helpers.menuPlacement({ menu: { ...below, right: 360 }, anchor: { ...anchor, top: 100 }, viewport: { width: 375, height: 2000 } }) }, { up: false, left: false });
  assert.deepEqual({ ...helpers.menuPlacement({ menu: below, anchor: { ...anchor, top: 120 }, viewport }) }, { up: false, left: true }, 'no room above: stays down (the page can scroll)');
});

test('progress DOM writes coalesce into one animation frame with the last write per key winning', () => {
  const frames = [];
  const writeSource = source.slice(source.indexOf('const frameWrites = new Map();'), source.indexOf('// The visible progress line updates once per frame'));
  const { queueWrite, frameWrites } = vm.runInNewContext(`${writeSource}\n({ queueWrite, frameWrites })`, { requestAnimationFrame: fn => frames.push(fn) && frames.length });
  const calls = [];
  queueWrite('progress', () => calls.push('progress-1'));
  queueWrite('row-a', () => calls.push('row-a-1'));
  queueWrite('progress', () => calls.push('progress-2'));
  assert.equal(frames.length, 1, 'one frame requested for many writes');
  frameWrites.delete('row-a');   // what setRowState does when a row changes state
  frames[0]();
  assert.deepEqual(calls, ['progress-2']);
  queueWrite('progress', () => calls.push('progress-3'));
  assert.equal(frames.length, 2, 'a new frame after the flush');
});

test('the preview pool runs two workers, lets queue thumbnails jump the line, and marks itself broken when a worker fails', async () => {
  const instances = [];
  class Worker { constructor(url) { this.url = url; this.sent = []; instances.push(this); } postMessage(message) { this.sent.push(message); } terminate() { this.terminated = true; } }
  const poolSource = source.slice(source.indexOf('function createPreviewPool('), source.indexOf('const previewPool = createPreviewPool(2);'));
  const pool = vm.runInNewContext(`${poolSource}\ncreatePreviewPool(2)`, { Worker, OffscreenCanvas: class {}, createImageBitmap() {} });
  assert.equal(pool.available, true);
  const jobs = [pool.run({ kind: 'preview', file: 'a' }), pool.run({ kind: 'preview', file: 'b' }), pool.run({ kind: 'preview', file: 'c' })];
  const thumb = pool.run({ kind: 'thumb', file: 't', size: 96 }, { priority: true });
  assert.equal(instances.length, 2, 'never more than two workers');
  assert.deepEqual(instances.map(worker => worker.url), ['preview-worker.js', 'preview-worker.js']);
  assert.deepEqual(instances.map(worker => worker.sent[0].file), ['a', 'b'], 'two decodes in flight');
  instances[0].onmessage({ data: { id: instances[0].sent[0].id, preview: 'A', thumb: 'a-thumb', width: 600, height: 400 } });
  assert.deepEqual(await jobs[0], { id: instances[0].sent[0].id, preview: 'A', thumb: 'a-thumb', width: 600, height: 400 });
  assert.equal(instances[0].sent[1].kind, 'thumb', 'the queue thumbnail went before the third preview');
  instances[0].onmessage({ data: { id: instances[0].sent[1].id, thumb: 'T' } });
  assert.equal((await thumb).thumb, 'T');
  assert.equal(instances[0].sent[2].file, 'c');
  instances[1].onmessage({ data: { id: instances[1].sent[0].id, error: 'decode' } });
  await assert.rejects(jobs[1], error => error.worker === true && error.message === 'decode');
  instances[0].onerror({ preventDefault() {} });
  await assert.rejects(jobs[2], error => error.worker === true);
  assert.equal(pool.available, false, 'a crashed worker sends every later file to the main-thread path');
  assert.equal(instances[0].terminated, true);
  await assert.rejects(pool.run({ kind: 'preview', file: 'd' }), error => error.worker === true);
});

test('preview-worker.js parses and shares the preview constants and stamp paths with the admin fallback', async () => {
  const workerSource = await readFile(new URL('../preview-worker.js', import.meta.url), 'utf8');
  assert.doesNotThrow(() => new vm.Script(workerSource, { filename: 'preview-worker.js' }));
  const constants = text => Object.fromEntries([...text.matchAll(/^const (PREVIEW_MAX|PREVIEW_BLUR_PX|PREVIEW_QUALITY|THUMB_MAX|THUMB_QUALITY) = ([\d.]+);/gm)].map(match => [match[1], Number(match[2])]));
  const fromWorker = constants(workerSource), fromAdmin = constants(source);
  assert.deepEqual(Object.keys(fromWorker).sort(), ['PREVIEW_BLUR_PX', 'PREVIEW_MAX', 'PREVIEW_QUALITY', 'THUMB_MAX', 'THUMB_QUALITY']);
  assert.deepEqual(fromAdmin, fromWorker);
  assert.equal(fromWorker.PREVIEW_MAX, 600);
  assert.equal(fromWorker.THUMB_MAX, 320);
  const paths = text => [...text.matchAll(/'(M[\d.\s\-a-zA-Z]+z)'/g)].map(match => match[1]);
  assert.equal(paths(workerSource).length, 2);
  assert.deepEqual(paths(source), paths(workerSource));
  const lattice = text => text.match(/const stepY = .*?;/)[0];
  assert.equal(lattice(source), lattice(workerSource));
  assert.ok(workerSource.includes("self.onmessage") && workerSource.includes("convertToBlob({ type: 'image/jpeg', quality: PREVIEW_QUALITY })"));
  assert.ok(source.includes("new Worker('preview-worker.js')"), 'admin.js loads the worker by its relative same-origin path');
});

test('the aria-live progress line repeats at most once every two seconds per region', () => {
  let now = 0;
  const liveSource = source.slice(source.indexOf('const liveAnnouncedAt = new WeakMap();'), source.indexOf('function paintProgress('));
  const announce = vm.runInNewContext(`${liveSource}\nannounceProgress`, { performance: { now: () => now }, WeakMap });
  const region = { textContent: '' }, other = { textContent: '' };
  announce(region, '1 of 30 photos'); assert.equal(region.textContent, '1 of 30 photos');
  now = 1500; announce(region, '4 of 30 photos'); assert.equal(region.textContent, '1 of 30 photos', 'too soon: dropped, not queued');
  announce(other, 'dialog 1 of 6'); assert.equal(other.textContent, 'dialog 1 of 6', 'each region keeps its own clock');
  now = 2100; announce(region, '9 of 30 photos'); assert.equal(region.textContent, '9 of 30 photos');
  announce(region, ''); assert.equal(region.textContent, '9 of 30 photos', 'empty text never clears an announcement');
});

// ── Crew studio admin details (W2-D): money strip, review shortcuts, undo and sign-out revocation ──
const adminHelpers = vm.runInNewContext(`${helpersSource}\n({ formatMoneyStrip, mergeSessionStats, reviewShortcut })`, {});

test('the money strip reads "12 searches · 3 unlocks · ₹2,100" with Indian grouping, mutes to "No searches yet", and hides when the stats are untrustworthy', () => {
  const busy = adminHelpers.formatMoneyStrip({ sessionId: 'a', searches: 12, matches: 9, zeroMatches: 3, zeroMatchRate: 0.25, checkouts: 4, unlocks: 3, downloads: 5, rupees: 2100 });
  assert.equal(busy.text, '12 searches · 3 unlocks · ₹2,100');
  assert.equal(busy.detail, '9 matched · 3 no match (25%) · 4 checkouts · 5 downloads');
  assert.equal(busy.muted, false);
  assert.equal(adminHelpers.formatMoneyStrip({ searches: 1, unlocks: 1, rupees: 125000 }).text, '1 search · 1 unlock · ₹1,25,000', 'singulars and lakh grouping');
  assert.equal(adminHelpers.formatMoneyStrip({ searches: '7', unlocks: null, rupees: 'nope' }).text, '7 searches · 0 unlocks · ₹0', 'strings and junk never throw');
  const quiet = adminHelpers.formatMoneyStrip({ sessionId: 'b', searches: 0, unlocks: 0, rupees: 0 });
  assert.deepEqual([quiet.text, quiet.muted], ['No searches yet', true]);
  assert.equal(adminHelpers.formatMoneyStrip(undefined).text, 'No searches yet', 'a session missing from the stats counts as unsearched');
  // Merging: only a real sessions array is trusted; 404 bodies, `unmigrated` and junk keep every strip hidden.
  const merged = adminHelpers.mergeSessionStats({ sessions: [{ sessionId: 'a', searches: 12 }, { sessionId: 'b', searches: 0 }, { nope: true }, null], totals: {} });
  assert.deepEqual([...merged.keys()], ['a', 'b']);
  assert.equal(merged.get('a').searches, 12);
  for (const body of [null, undefined, {}, { error: 'Not found' }, { sessions: [], totals: {}, unmigrated: true }, { sessions: 'no' }, 'text']) assert.equal(adminHelpers.mergeSessionStats(body), null, `hidden for ${JSON.stringify(body)}`);
  assert.equal(adminHelpers.mergeSessionStats({ sessions: [] }).size, 0, 'an empty list is trusted (every card reads "No searches yet")');
  // Painting: the strip is filled per card from the map, or hidden when the map is null.
  const paintSource = source.slice(source.indexOf('function paintMoneyStrips('), source.indexOf('let dashboardRender'));
  const paint = vm.runInNewContext(`${helpersSource}\n${paintSource}\npaintMoneyStrips`, {});
  const strip = () => ({ hidden: true, textContent: '', title: '', classes: new Set(), classList: { toggle(name, on) { on ? this.owner.classes.add(name) : this.owner.classes.delete(name); } } });
  const card = (id, s) => { s.classList.owner = s; return { dataset: { sessionId: id }, querySelector: sel => sel === '.d-card-money' ? s : null }; };
  const a = strip(), b = strip(), c = strip();
  const grid = { querySelectorAll: () => [card('a', a), card('b', b), card('c', c)] };
  paint(grid, merged);
  assert.deepEqual([a.hidden, a.textContent, a.title, [...a.classes]], [false, '12 searches · 0 unlocks · ₹0', '0 matched · 0 no match (0%) · 0 checkouts · 0 downloads', []]);
  assert.deepEqual([b.hidden, b.textContent, [...b.classes]], [false, 'No searches yet', ['is-muted']]);
  assert.deepEqual([c.hidden, c.textContent], [false, 'No searches yet'], 'a card the stats never mention is an unsearched one');
  paint(grid, null);
  assert.deepEqual([a.hidden, b.hidden, c.hidden], [true, true, true], 'a 404 / unmigrated answer hides every strip');
});

test('review keys: Y / N / S / Z map to their actions only on the Review tab, with no dialog, no modifier and nobody typing', () => {
  const key = (k, extra = {}) => ({ key: k, ...extra });
  assert.deepEqual(['y', 'N', 's', 'Z', 'x', ''].map(k => adminHelpers.reviewShortcut(key(k))), ['confirm', 'reject', 'skip', 'undo', null, null]);
  assert.equal(adminHelpers.reviewShortcut(key('z'), { tabActive: false }), null, 'other tabs ignore the keys');
  assert.equal(adminHelpers.reviewShortcut(key('z'), { dialogOpen: true }), null, 'a dialog owns the keyboard');
  assert.equal(adminHelpers.reviewShortcut(key('z'), { typing: true }), null, 'typing "z" in a field is not an undo');
  for (const modifier of ['metaKey', 'ctrlKey', 'altKey']) assert.equal(adminHelpers.reviewShortcut(key('z', { [modifier]: true })), null, `${modifier} shortcuts belong to the browser`);
  assert.equal(adminHelpers.reviewShortcut({}), null);
  // The key handler only lets Z through when the toolbar button is enabled, so the two paths can never disagree.
  const handler = source.slice(source.indexOf("document.addEventListener('keydown', event => {\n  const focused"), source.indexOf('const rescanVerifyBtn'));
  assert.match(handler, /action === 'undo'[\s\S]*!undoReviewBtn\.disabled[\s\S]*undoLastReview\(\)/);
  assert.match(handler, /typing: \/\^\(INPUT\|TEXTAREA\|SELECT\)\$\/\.test\(focused\?\.tagName\) \|\| Boolean\(focused\?\.isContentEditable\)/);
});

// The undo block sliced out of admin.js against a tiny fake DOM: two queues, their counters, the toolbar button and fake timers.
function undoHarness({ api } = {}) {
  const undoSource = source.slice(source.indexOf('// ── Review: undo the last decision (F30)'), source.indexOf('// ── Session hygiene'));
  const calls = [], toasts = [], timers = [], reloads = [];
  let focused = null;
  const grid = () => {
    const g = { children: [], loading: false };
    g.querySelector = sel => sel === '.review-queue-loading' ? (g.loading ? {} : null) : sel.startsWith('#') ? g.children.find(child => child.id === sel.slice(1)) || null : null;
    g.querySelectorAll = sel => sel === ':scope > p' ? g.children.filter(child => child.tag === 'P') : [];
    g.prepend = el => { g.children = [el, ...g.children.filter(child => child !== el)]; };
    return g;
  };
  const reviewGrid = grid(), linkGrid = grid();
  const card = id => { const buttons = [{ disabled: true }, { disabled: true }]; return { id, tag: 'ARTICLE', buttons, tabIndex: 0, querySelectorAll: sel => sel === 'button' ? buttons : [], focus() { focused = this; }, scrollIntoView() {} }; };
  const message = g => { const p = { tag: 'P', remove() { g.children = g.children.filter(child => child !== p); } }; return p; };
  const counter = start => ({ value: String(start), get textContent() { return this.value; }, set textContent(v) { this.value = String(v); } });   // the DOM stringifies
  const ids = { undoReviewBtn: { disabled: true, addEventListener() {} }, verifyPending: counter(1), verifyConfirmed: counter(15), verifyRejected: counter(6), linkPending: counter(0), linkConfirmed: counter(4), linkRejected: counter(1) };
  const context = {
    document: { getElementById: id => ids[id] }, reviewGrid, linkGrid, CSS: { escape: s => s }, window: {},
    apiRequest: async (path, options) => { calls.push({ path, ...options }); return api(path, options); },
    notifyCrew: (text, kind) => toasts.push([text, kind]), markActiveReviewCard: () => {},
    loadVerifyQueue: async () => { reloads.push('pair'); reviewGrid.loading = false; }, loadLinkQueue: async () => { reloads.push('link'); linkGrid.loading = false; },
    setTimeout: (fn, ms) => timers.push({ fn, ms, cleared: false }), clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cleared = true; }, Date,
  };
  const undo = vm.runInNewContext(`${undoSource}\n({ rememberReview, forgetReview, undoLastReview, get lastReview() { return lastReview; }, UNDO_WINDOW_MS })`, context);
  return { undo, calls, toasts, timers, reloads, reviewGrid, linkGrid, card, message, ids, button: ids.undoReviewBtn, focused: () => focused };
}

test('Z / Undo puts the last Same or Different back at the top of its queue, focused and reviewable, fixes the counters and toasts "Undone."', async () => {
  const h = undoHarness({ api: async (path, { body }) => ({ success: true, ...JSON.parse(body), status: 'pending' }) });
  assert.equal(h.button.disabled, true, 'nothing to undo yet');
  const first = h.card('verify-card-pair-1'), second = h.card('verify-card-pair-2');
  h.reviewGrid.children = [second];
  h.undo.rememberReview({ kind: 'pair', id: 'pair-1', card: first, confirmed: true });
  assert.equal(h.button.disabled, false);
  assert.deepEqual([h.timers.length, h.timers[0].ms], [1, 10 * 60 * 1000], 'the memory expires with the Worker window');
  await h.undo.undoLastReview();
  assert.deepEqual(h.calls, [{ path: '/api/admin/undo-review', method: 'POST', body: '{"kind":"pair","id":"pair-1"}' }]);
  assert.deepEqual(h.reviewGrid.children.map(c => c.id), ['verify-card-pair-1', 'verify-card-pair-2'], 'back at the top of the face-pair queue');
  assert.ok(first.buttons.every(b => !b.disabled), 'Same / Different / Skip work again');
  assert.equal(h.focused(), first);
  assert.deepEqual([h.ids.verifyPending.textContent, h.ids.verifyConfirmed.textContent], ['2', '14']);
  assert.deepEqual(h.toasts, [['Undone.', 'success']]);
  assert.deepEqual([h.button.disabled, h.undo.lastReview, h.timers[0].cleared], [true, null, true], 'one undo per decision');
  // A rejected kit link goes back to the link queue, replacing the "Batch done" message, and fixes the link counters.
  const link = h.card('link-card-link-9');
  h.linkGrid.children = [h.message(h.linkGrid)];
  h.undo.rememberReview({ kind: 'link', id: 'link-9', card: link, confirmed: false });
  await h.undo.undoLastReview();
  assert.deepEqual(h.linkGrid.children, [link]);
  assert.deepEqual([h.ids.linkPending.textContent, h.ids.linkRejected.textContent, h.ids.verifyPending.textContent], ['1', '0', '2']);
  assert.equal(h.calls.at(-1).body, '{"kind":"link","id":"link-9"}');
  // Undoing the last card of a batch: the confirm already asked for a reload, so a fresh one is awaited and its copy of the pair wins.
  const stale = h.card('verify-card-pair-7'), fresh = h.card('verify-card-pair-7');
  h.reviewGrid.children = []; h.reviewGrid.loading = true;
  h.undo.rememberReview({ kind: 'pair', id: 'pair-7', card: stale, confirmed: true });
  const pending = h.undo.undoLastReview();
  h.reviewGrid.children = [h.card('verify-card-pair-8'), fresh];   // what the reload paints
  await pending;
  assert.deepEqual(h.reloads, ['pair']);
  assert.equal(h.reviewGrid.children[0], fresh, "the reload's card is moved to the top; the stale one is dropped");
  assert.deepEqual([h.ids.verifyPending.textContent, h.ids.verifyConfirmed.textContent], ['2', '14'], 'a reload already carries the server counts');
  assert.equal(h.focused(), fresh);
});

test('undo forgets the decision on a 409 or 404 (toasting the server line), keeps it on a dropped connection, and lets it lapse after ten minutes', async () => {
  let answer;
  const h = undoHarness({ api: async () => { throw answer; } });
  const card = h.card('verify-card-pair-1');
  answer = Object.assign(new Error('Too late to undo — that decision is older than 10 minutes.'), { status: 409 });
  h.undo.rememberReview({ kind: 'pair', id: 'pair-1', card, confirmed: true });
  await h.undo.undoLastReview();
  assert.deepEqual(h.toasts, [['Too late to undo — that decision is older than 10 minutes.', 'error']]);
  assert.deepEqual([h.undo.lastReview, h.button.disabled, h.reviewGrid.children.length, h.ids.verifyPending.textContent], [null, true, 0, '1'], 'the server has the last word: nothing re-inserted, nothing counted');
  answer = Object.assign(new Error('No such review.'), { status: 404 });
  h.undo.rememberReview({ kind: 'link', id: 'gone', card: h.card('link-card-gone'), confirmed: false });
  await h.undo.undoLastReview();
  assert.deepEqual([h.toasts.at(-1), h.undo.lastReview, h.button.disabled], [['No such review.', 'error'], null, true]);
  answer = new TypeError('Failed to fetch');
  h.undo.rememberReview({ kind: 'pair', id: 'pair-2', card: h.card('verify-card-pair-2'), confirmed: true });
  await h.undo.undoLastReview();
  assert.deepEqual([h.toasts.at(-1)[1], h.undo.lastReview?.id, h.button.disabled], ['error', 'pair-2', false], 'a dropped connection keeps the memory for another Z');
  assert.equal(h.calls.length, 3);
  await h.undo.undoLastReview();
  assert.equal(h.calls.length, 4, 'and Z retries');
  // Ten minutes on, the button goes quiet on its own; a newer decision restarts the clock.
  const expiry = h.timers.filter(t => !t.cleared);
  assert.equal(expiry.length, 1);
  h.undo.rememberReview({ kind: 'pair', id: 'pair-3', card: h.card('verify-card-pair-3'), confirmed: false });
  assert.equal(expiry[0].cleared, true, 'the older clock is stopped');
  h.timers.at(-1).fn();
  assert.deepEqual([h.undo.lastReview, h.button.disabled], [null, true]);
  await h.undo.undoLastReview();
  assert.equal(h.calls.length, 4, 'nothing to undo: no request');
});

test('signing out — by the button or the idle clock — revokes the crew token on the Worker before dropping it, and a missing route stays silent', async () => {
  const revokeSource = source.slice(source.indexOf('function revokeToken()'), source.indexOf("signOutBtn.addEventListener('click'"));
  const fetches = [];
  let token = 'tok-123', reject = false;
  const revoke = vm.runInNewContext(`${revokeSource}\nrevokeToken`, { getToken: () => token, isLive: true, apiUrl: path => `https://api.test${path}`, fetch: (...args) => { fetches.push(args); return reject ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve({ status: 404 }); } });
  revoke();
  assert.deepEqual(JSON.parse(JSON.stringify(fetches)), [['https://api.test/api/admin/logout', { method: 'POST', headers: { authorization: 'Bearer tok-123' }, keepalive: true }]]);   // built inside the vm realm
  reject = true; revoke(); await new Promise(resolve => setImmediate(resolve));   // the rejection is swallowed, never unhandled
  token = ''; revoke();
  assert.equal(fetches.length, 2, 'no token, no call');
  assert.equal(vm.runInNewContext(`${revokeSource}\nrevokeToken`, { getToken: () => 'tok', isLive: false, apiUrl: p => p, fetch: () => { throw new Error('must not be called'); } })(), undefined, 'no Worker configured: nothing to revoke');
  const ordered = source.match(/revokeToken\(\);\s*clearToken\(\);\s*showLogin\(\);/g) || [];
  assert.equal(ordered.length, 2, 'Sign out and the idle sign-out both revoke first, then clear the token locally');
  assert.match(source.slice(source.indexOf('function showLogin()'), source.indexOf('function focusUploadTitle')), /forgetReview\(\)/, 'a new sign-in never inherits an old undo');
});

// ── FIX-C (review-fix pass) ────────────────────────────────────────────────────

test('an upload attempt after the first goes out as a duplicate "skip" unless the crew chose a mode, and a skip answered to it counts as sent', () => {
  const { uploadAttemptMode, settleUploadResult } = vm.runInNewContext(`${helpersSource}\n({ uploadAttemptMode, settleUploadResult })`, {});
  assert.equal(uploadAttemptMode({ file: {} }, false), undefined, 'first attempt of a fresh file: no mode');
  assert.equal(uploadAttemptMode({ file: {} }, true), 'skip', 'second attempt (lost reply) or a Retry-failed item: skip');
  for (const chosen of ['replace', 'rename', 'skip']) { assert.equal(uploadAttemptMode({ onDuplicate: chosen }, false), chosen); assert.equal(uploadAttemptMode({ onDuplicate: chosen }, true), chosen, `the crew's ${chosen} stands on a retry`); }
  const stored = { photoId: 'p1', filename: 'a.jpg', status: 'pending', duplicate: null, replaced: 0 };
  assert.equal(settleUploadResult(false, stored), stored);
  assert.equal(settleUploadResult(true, stored), stored);
  const plain = value => JSON.parse(JSON.stringify(value));   // the vm realm's objects have another Object prototype
  assert.deepEqual(plain(settleUploadResult(false, { skipped: true, filename: 'a.jpg' })), { skipped: true, filename: 'a.jpg' }, 'a first-attempt skip is the crew’s choice');
  assert.deepEqual(plain(settleUploadResult(true, { skipped: true, filename: 'a.jpg' })), { skipped: false, filename: 'a.jpg', landed: 'earlier' }, 'a retried attempt’s skip means the earlier one landed');
  assert.equal(settleUploadResult(true, undefined), undefined);
  // and the batch sender wires them per attempt: the flag is set before the request so a Stop mid-flight (abort) also counts as attempted.
  const retry = source.slice(source.indexOf('const uploadWithRetry = async (item, index, preview) => {'), source.indexOf('// A buffering Worker holds each original in memory'));
  assert.match(retry, /const retrying = Boolean\(item\.attempted\); item\.attempted = true;/);
  assert.match(retry, /settleUploadResult\(retrying, await uploadOne\(item, preview, index, uploadAttemptMode\(item, retrying\)\)\)/);
  const one = source.slice(source.indexOf('const uploadOne = (item, preview, index, onDuplicate) =>'), source.indexOf('const failRetryable = (message) =>'));
  assert.match(one, /if \(onDuplicate\) params\.set\('onDuplicate', onDuplicate\);/, 'the streaming shape carries the attempt’s mode');
  assert.match(one, /if \(onDuplicate\) form\.append\('onDuplicate', onDuplicate\);/, 'so does the multipart shape');
  assert.doesNotMatch(one, /item\.onDuplicate/, 'never the item’s own field directly');
});

test('sign in again: a stale 401 retries with the fresh token, Cancel stops the batch and unlocks the form, the dialog lock skips the panel', async () => {
  const html = await readFile(new URL('../admin.html', import.meta.url), 'utf8');
  // The panel has a Cancel button beside the submit, inside the form so it moves with it.
  const panel = html.slice(html.indexOf('id="reauthPanel"'), html.indexOf('</form>', html.indexOf('id="reauthPanel"')));
  assert.match(panel, /<button class="publish-btn" type="submit">Sign in and continue<\/button>/);
  assert.match(panel, /<button class="more-cancel" type="button" id="reauthCancelBtn">Cancel<\/button>/);
  // tokenRenewedSince: only a 401 that names a token other than the current one is "stale".
  const token = { value: 'old' };
  const renewed = vm.runInNewContext(`${source.slice(source.indexOf('function tokenRenewedSince('), source.indexOf('function requireReauth()'))}\ntokenRenewedSince`, { getToken: () => token.value });
  assert.equal(renewed({ unauthorized: true, token: 'old' }), false, 'same token: a real expiry');
  assert.equal(renewed({ unauthorized: true }), false, 'no token recorded: treat as a real expiry');
  token.value = 'fresh';
  assert.equal(renewed({ unauthorized: true, token: 'old' }), true, 'the crew signed in again meanwhile');
  assert.equal(renewed({ unauthorized: true, token: 'fresh' }), false, 'the fresh token was refused too');
  // Every 401 path records the token the request went out with, and both retry loops consult it before raising the panel.
  assert.match(source, /const token = getToken\(\);\s+\/\/ remembered on a 401/);
  assert.match(source, /throw Object\.assign\(new Error\('Signed out — sign in again\.'\), \{ unauthorized: true, token \}\);/);
  assert.match(source, /reject\(Object\.assign\(new Error\('Signed out\.'\), \{ unauthorized: true, token \}\)\);/);
  assert.match(source, /catch \(error\) \{ if \(!error\.unauthorized\) throw error; if \(!tokenRenewedSince\(error\)\) await requireReauth\(\); \}/, 'withReauth');
  assert.match(source, /if \(error\.unauthorized\) \{ attempt -= 1; if \(!tokenRenewedSince\(error\)\) await requireReauth\(\); continue; \}/, 'uploadWithRetry');
  const one = source.slice(source.indexOf('const uploadOne = ('), source.indexOf('const failRetryable = (message) =>'));
  assert.equal((one.match(/xhr\.setRequestHeader\('authorization', `Bearer \$\{token\}`\);/g) || []).length, 2, 'both request shapes send the remembered token');
  assert.doesNotMatch(one, /Bearer \$\{getToken\(\)\}/);
  // Cancel: the Stop path (abort the streams, reject the pause) while a batch runs, a plain rejection otherwise; the message says what to do.
  const reauthBlock = source.slice(source.indexOf('const reauthCancelled = '), source.indexOf('// Wrap the one-off calls around a batch'));
  assert.match(reauthBlock, /cancelled: true/);
  assert.match(reauthBlock, /Sign in again when you are ready; nothing already sent is lost\./);
  assert.match(reauthBlock, /getElementById\('reauthCancelBtn'\)\.addEventListener\('click', \(\) => \{ if \(uploadBusy\) cancelUpload\(reauthCancelled\(\)\); else settleReauth\(reauthCancelled\(\)\); \}\);/);
  assert.match(source, /function cancelUpload\(reason = cancelledError\(\)\) \{ if \(!uploadBusy\) return; cancelled = true; liveRequests\.forEach\(xhr => xhr\.abort\(\)\); settleReauth\(reason\); \}/);
  // Off the Upload tab, the pause is announced with a way back to the panel.
  const require = source.slice(source.indexOf('function requireReauth()'), source.indexOf('function settleReauth('));
  assert.match(require, /if \(host\.id === 'tab-upload' && !host\.classList\.contains\('active'\)\) toast\('Paused — sign in again on the Upload tab', 'info', \{ action: \{ label: 'Open the Upload tab'/);
  // The Add-photos dialog lock never touches the panel's own field and buttons (it may still sit in the dialog from an earlier pause).
  assert.match(source, /const controls = \[\.\.\.uploadMoreModal\.querySelectorAll\('input, button'\)\]\.filter\(control => control !== moreCancelBtn && control !== closeMoreModal && !reauthPanel\.contains\(control\)\);/);
});

test('decode width comes from the image header, never wider than the image: a heavy 500 px PNG is no longer upscaled; unknown sizes keep the file-size rule', async () => {
  const { imageDimensions, decodeWidth } = vm.runInNewContext(`${helpersSource}\n({ imageDimensions, decodeWidth })`, { Uint8Array, DataView, Set, String, Math });
  // Byte fixtures (the same shapes tests/worker.test.mjs uses for migration 0012): the smallest headers that carry a size.
  const be16 = value => [(value >> 8) & 255, value & 255];
  const be32 = value => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
  const le32 = value => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
  const segment = (marker, payload) => [0xFF, marker, ...be16(payload.length + 2), ...payload];
  const sof = (marker, width, height) => segment(marker, [8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const APP0 = segment(0xE0, [0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const exif = (orientation, little = true) => { const u16 = v => little ? [v & 255, v >> 8] : be16(v); const u32 = v => little ? le32(v) : be32(v); return segment(0xE1, [0x45, 0x78, 0x69, 0x66, 0, 0, ...(little ? [0x49, 0x49] : [0x4D, 0x4D]), ...u16(0x2A), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)]); };
  const jpeg = (...segments) => Uint8Array.from([0xFF, 0xD8, ...segments.flat()]);
  const png = (width, height) => Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(width), ...be32(height), 8, 2, 0, 0, 0, 0, 0, 0, 0]);
  const riff = (chunk, payload) => Uint8Array.from([0x52, 0x49, 0x46, 0x46, ...le32(payload.length + 12), 0x57, 0x45, 0x42, 0x50, ...chunk.split('').map(c => c.charCodeAt(0)), ...le32(payload.length), ...payload]);
  const plain = value => value && JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(imageDimensions(jpeg(APP0, sof(0xC0, 6000, 4000)))), { width: 6000, height: 4000 });
  assert.deepEqual(plain(imageDimensions(jpeg(APP0, sof(0xC2, 6000, 4000)))), { width: 6000, height: 4000 }, 'progressive');
  assert.deepEqual(plain(imageDimensions(jpeg(exif(6), sof(0xC0, 4032, 3024)))), { width: 3024, height: 4032 }, 'a phone portrait stored sideways reads as createImageBitmap shows it');
  assert.deepEqual(plain(imageDimensions(jpeg(exif(1, false), APP0, sof(0xC1, 4032, 3024)))), { width: 4032, height: 3024 }, 'upright, big-endian TIFF');
  assert.deepEqual(plain(imageDimensions(png(500, 500))), { width: 500, height: 500 });
  assert.deepEqual(plain(imageDimensions(riff('VP8 ', [0x10, 0x02, 0x00, 0x9D, 0x01, 0x2A, 900 & 255, 900 >> 8, 675 & 255, 675 >> 8, 0, 0]))), { width: 900, height: 675 });
  assert.deepEqual(plain(imageDimensions(riff('VP8L', [0x2F, ...le32((1600 - 1) | ((900 - 1) << 14)), 0]))), { width: 1600, height: 900 });
  assert.deepEqual(plain(imageDimensions(riff('VP8X', [0x10, 0, 0, 0, ...le32(4032 - 1).slice(0, 3), ...le32(3024 - 1).slice(0, 3)]))), { width: 4032, height: 3024 });
  for (const [name, bytes] of Object.entries({ heic: Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0, 0, 0, 0]), 'cut before SOF': jpeg(APP0).subarray(0, 12), 'scan first': jpeg(APP0, segment(0xDA, [1, 2, 3]), sof(0xC0, 6000, 4000)), junk: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]), 'not bytes': 'FFD8' })) assert.equal(imageDimensions(bytes), null, name);
  // decodeWidth: the reviewer's case — 500 × 500 but 700 KB — decodes at natural size instead of 600; big frames still downsample
  // during decode (to the fitted width, so a portrait is not decoded to 600 wide and shrunk again); unknown sizes keep the old rule.
  const KB = 1024;
  assert.equal(decodeWidth({ width: 500, height: 500 }, 700 * KB, 600), null, 'never upscaled');
  assert.equal(decodeWidth({ width: 600, height: 400 }, 900 * KB, 600), null, 'exactly the target: nothing to do');
  assert.equal(decodeWidth({ width: 6000, height: 4000 }, 8 * 1024 * KB, 600), 600);
  assert.equal(decodeWidth({ width: 3024, height: 4032 }, 3 * 1024 * KB, 600), 450, 'portrait: the fitted width');
  assert.equal(decodeWidth({ width: 4000, height: 3000 }, 3 * 1024 * KB, 96), 96, 'queue thumbnails');
  assert.equal(decodeWidth({ width: 80, height: 80 }, 2 * KB, 96), null);
  assert.equal(decodeWidth({ width: 6000, height: 4000 }, 200 * KB, 600), 600, 'a small file with a big frame still downsamples (size says nothing)');
  assert.equal(decodeWidth(null, 700 * KB, 600), 600, 'unknown (HEIC): over 512 KB is treated as a big frame, as before');
  assert.equal(decodeWidth(null, 300 * KB, 600), null);
  // Both decode paths take the width from decodeWidth and only resize when one is given; the old size rule lives nowhere else.
  const workerSource = await readFile(new URL('../preview-worker.js', import.meta.url), 'utf8');
  assert.match(workerSource, /const decode = \(file, resizeWidth\) => createImageBitmap\(file, resizeWidth \? \{ resizeWidth, resizeQuality: 'high' \} : \{\}\);/);
  assert.match(workerSource, /const \{ id, kind, file, size, resizeWidth \} = data \|\| \{\};/);
  assert.match(workerSource, /renderQueueThumb\(file, size \|\| 96, resizeWidth\) : await renderPreview\(file, resizeWidth\)/);
  assert.doesNotMatch(workerSource, /file\.size > 512/);
  assert.equal((source.match(/file\.size > 512 \* 1024/g) || []).length, 0, 'admin.js decides in decodeWidth only');
  assert.match(source, /createImageBitmap\(file, resizeWidth \? \{ resizeWidth, resizeQuality: 'high' \} : \{\}\)/);
  assert.match(source, /worker\.postMessage\(\{ id: job\.id, kind: job\.kind, file: job\.file, size: job\.size, resizeWidth: job\.resizeWidth \}\);/);
  assert.match(source, /const resizeWidth = await decodeWidthFor\(file, PREVIEW_MAX\);/);
  assert.match(source, /const width = decodeWidthFor\(file, QUEUE_THUMB_PX\);/);
  assert.match(source, /file\.slice\(0, HEADER_BYTES\)\.arrayBuffer\(\)/, 'only the header is read');
  // The pool hands the width to the worker with the job.
  const sent = [];
  class Worker { postMessage(message) { sent.push(message); } terminate() {} }
  const pool = vm.runInNewContext(`${source.slice(source.indexOf('function createPreviewPool('), source.indexOf('const previewPool = createPreviewPool(2);'))}\ncreatePreviewPool(1)`, { Worker, OffscreenCanvas: class {}, createImageBitmap() {} });
  pool.run({ kind: 'preview', file: 'f', resizeWidth: 450 });
  assert.equal(sent.length, 1); assert.equal(sent[0].resizeWidth, 450); assert.equal(sent[0].kind, 'preview');
});
