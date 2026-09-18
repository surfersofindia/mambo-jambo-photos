// W3-A (wave 3): pure helpers lifted out of app.js by name, plus the markup and stylesheet invariants behind the uncropped tiles,
// the "Not me" hides, the zero-match second chance, WhatsApp share, the checkout trust block, the "lands by" line, the 429
// countdown and the font-swap fixes. The browser behaviour is covered by tests/e2e/guest-product.spec.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { root } from '../scripts/site-files.mjs';

const read = file => readFile(new URL(file, root), 'utf8');
function lift(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found in app.js`);
  let depth = 0, i = source.indexOf('{', start);
  for (; i < source.length; i++) { if (source[i] === '{') depth++; else if (source[i] === '}' && --depth === 0) break; }
  return new Function('formatRupees', `return ${source.slice(start, i + 1)}`)((paise, currency) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR', maximumFractionDigits: 0 }).format((paise || 0) / 100));
}
const hexToRgb = hex => { const h = hex.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
const contrast = (fg, bg) => {
  const lin = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
  const L = ([r, g, b]) => .2126 * lin(r) + .7152 * lin(g) + .0722 * lin(b);
  const [hi, lo] = [L(hexToRgb(fg)), L(hexToRgb(bg))].sort((a, b) => b - a);
  return (hi + .05) / (lo + .05);
};

test('nextDropCopy: only a future drop within 24 h, in local time, "today" or "tomorrow"', async () => {
  const nextDropCopy = lift(await read('app.js'), 'nextDropCopy');
  const now = Date.parse('2026-09-17T09:30:00+05:30');
  const tz = process.env.TZ; process.env.TZ = 'Asia/Kolkata';
  try {
    assert.equal(nextDropCopy('2026-09-17T16:30:00+05:30', now), 'Today’s session lands by 4:30 pm');
    assert.equal(nextDropCopy('2026-09-18T07:00:00+05:30', now), 'Next session lands by 7:00 am tomorrow');
    assert.equal(nextDropCopy('2026-09-17T08:00:00+05:30', now), null, 'already past');
    assert.equal(nextDropCopy('2026-09-18T09:30:00.001+05:30', now), null, 'over 24 h away');
    assert.equal(nextDropCopy('2026-09-18T09:29:00+05:30', now), 'Next session lands by 9:29 am tomorrow');
    for (const bad of [null, undefined, '', 'garbage', 42]) assert.equal(nextDropCopy(bad, now), null);
  } finally { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; }
});

test('retryAfterSeconds and retryCopy: seconds, HTTP dates, garbage, and the spoken sentence', async () => {
  const app = await read('app.js');
  const retryAfterSeconds = lift(app, 'retryAfterSeconds'), retryCopy = lift(app, 'retryCopy');
  assert.equal(retryAfterSeconds('420'), 420);
  assert.equal(retryAfterSeconds(' 7 '), 7);
  assert.equal(retryAfterSeconds('-3'), 0);
  assert.equal(retryAfterSeconds(null), 0);
  assert.equal(retryAfterSeconds(''), 0);
  const inTwoMinutes = new Date(Date.now() + 120_000).toUTCString();
  assert.ok(Math.abs(retryAfterSeconds(inTwoMinutes) - 120) <= 1, 'an HTTP date becomes seconds from now');
  assert.equal(retryAfterSeconds('soon'), 60, 'unreadable → a minute');
  assert.equal(retryCopy(45), '45 seconds'); assert.equal(retryCopy(1), '1 second');
  assert.equal(retryCopy(60), '1 minute'); assert.equal(retryCopy(61), '2 minutes'); assert.equal(retryCopy(420), '7 minutes');
  assert.ok(app.includes("if (error.status === 429) { retryLock(error.retryAfter || 60, $('#finderStatus')"), 'a 429 from /api/match starts the lock');
  assert.ok(/function updateSubmit\(\) \{[^}]*Date\.now\(\) < retryUntil/.test(app), 'the search button honours the lock');
  assert.ok(/error\.retryAfter = retryAfterSeconds\(response\.headers\.get\('retry-after'\)\)/.test(app), 'requestApi keeps retry-after on the error');
  assert.ok(/figure\.setAttribute\('aria-hidden', 'true'\)/.test(app) && app.includes("said.className = 'visually-hidden'"), 'the ticking figure is aria-hidden, the sentence is spoken once');
});

test('resultsMetaText and conditionChips: one live sentence per change, chips only for what the crew filled in', async () => {
  const app = await read('app.js');
  const resultsMetaText = lift(app, 'resultsMetaText'), conditionChips = lift(app, 'conditionChips');
  assert.equal(resultsMetaText('17 Sept 2026 · Mulki Beach · Dawn patrol', 9), '17 Sept 2026 · Mulki Beach · Dawn patrol · 9 waves');
  assert.equal(resultsMetaText('base', 8, 1), 'base · 8 waves, 1 hidden');
  assert.equal(resultsMetaText('base', 1, 0), 'base · 1 wave');
  assert.equal(resultsMetaText('base', 4, 0, true), 'base · 4 waves by colour');
  assert.equal(resultsMetaText('', 0, 2), '0 waves, 2 hidden');
  assert.deepEqual(conditionChips({ breakName: 'Mulki left', swellFt: 4, wind: 'Offshore', tide: 'Mid rising', photographer: 'Ankith' }), ['Mulki left', '4 ft', 'Offshore', 'Mid rising', '📷 Ankith']);
  assert.deepEqual(conditionChips({ breakName: ' ', swellFt: 0, wind: null, tide: 'Low', photographer: '' }), ['Low']);
  assert.deepEqual(conditionChips(null), []); assert.deepEqual(conditionChips('x'), []);
  const html = await read('index.html');
  assert.ok(html.includes('<p class="eyebrow" id="resultsMeta" aria-live="polite" aria-atomic="true">'), 'the eyebrow is the one live region');
  assert.equal(/id="resultsTitle"[^>]*aria-live/.test(html), false, 'the title is not a second live region');
  assert.ok(html.includes('<div class="conditions" id="resultsConditions" hidden></div>'));
});

test('tileAspect and the tile box: the ratio comes from stored dimensions, unknown sizes keep the 4:3 box, the grid never stretches', async () => {
  const app = await read('app.js'), css = await read('site.css');
  const tileAspect = lift(app, 'tileAspect');
  assert.equal(tileAspect({ width: 1600, height: 1067 }), '1600 / 1067');
  assert.equal(tileAspect({ width: 900, height: 1201 }), '900 / 1201');
  assert.equal(tileAspect({ width: '900', height: '675' }), '900 / 675', 'numeric strings are fine');
  for (const bad of [{ width: null, height: null }, { width: 0, height: 100 }, { width: 100 }, { width: 1.5, height: 2 }, { width: 'x', height: 675 }, null, undefined]) assert.equal(tileAspect(bad), '', JSON.stringify(bad));
  assert.ok(app.includes("const aspect = tileAspect(photo); if (aspect) open.style.aspectRatio = aspect;"), 'the button box carries the ratio inline');
  assert.ok(/\.photo-open\{[^}]*aspect-ratio:4\/3/.test(css), 'the box defaults to 4:3');
  assert.ok(/\.photo-open img\{[^}]*height:100%/.test(css) && /\.photo-open img\{[^}]*object-fit:cover/.test(css), 'the image fills its box');
  assert.ok(/\.gallery\{[^}]*align-items:start/.test(css), 'ragged rows, no stretched tiles');
  assert.equal(/figure\.is-broken \.photo-open\{[^}]*aspect-ratio/.test(css), false, 'a broken tile keeps its own ratio');
});

test('"Not me": every preview tile gets a named hide button, hides are remembered per search and posted, 404 is ignored', async () => {
  const app = await read('app.js');
  assert.ok(app.includes("hide.setAttribute('aria-label', `Not me, hide wave ${index + 1}`)"));
  assert.ok(app.includes("else if (!unlocked && photo.photoId) {"), 'previews only — never on paid originals');
  assert.ok(app.includes("`mjHidden:${currentSearch.searchId}`"), 'sessionStorage per search');
  assert.ok(/hiddenIds\.add\(photo\.photoId\); saveHidden\(\);\n\s*photos\.splice\(index, 1\);/.test(app), 'removed from the list in place');
  assert.ok(app.includes("figure.remove(); relabelTiles();"), 'no grid re-render');
  assert.ok(/\/hide`, \{ method: 'POST'[^\n]*\.catch\(\(\) => \{\}\);/.test(app), 'the Worker call never surfaces an error (404 = route not deployed)');
  assert.ok(app.includes("(next || $('#resultsTitle')).focus();"), 'focus moves to the next print');
  for (const site of ["photos = withoutHidden(match.previews.map(normalisePhoto));", "const valid = withoutHidden(unlockedPhotos.filter", "const found = withoutHidden(result.previews.map(normalisePhoto));"]) assert.ok(app.includes(site), `hidden ids applied: ${site.slice(0, 40)}`);
});

test('zero-match second chance: twelve named hue radios in a radiogroup, a tone group, the notify form with the checkout number rules', async () => {
  const html = await read('index.html'), app = await read('app.js');
  const ring = html.match(/<fieldset class="hue-ring" id="hueRing" role="radiogroup">([\s\S]*?)<\/fieldset>/)[1];
  const swatches = [...ring.matchAll(/<label class="hue-swatch" style="--i:(\d+);--hue:(\d+)"><input type="radio" name="hue" value="(\d+)"><span>([^<]+)<\/span><\/label>/g)];
  assert.equal(swatches.length, 12);
  swatches.forEach((m, i) => { assert.equal(Number(m[1]), i); assert.equal(Number(m[2]), i * 30); assert.equal(m[3], m[2]); assert.ok(m[4].length > 2); });
  assert.equal(new Set(swatches.map(m => m[4])).size, 12, 'every swatch has its own name');
  assert.ok(ring.includes('<legend>Board colour</legend>'));
  const tones = [...html.matchAll(/<input type="radio" name="tone" value="(\w+)"( checked)?>/g)].map(m => [m[1], Boolean(m[2])]);
  assert.deepEqual(tones, [['vivid', true], ['muted', false], ['any', false]]);
  assert.ok(html.includes('<input id="notifyPhone" type="tel" inputmode="numeric" pattern="[6-9][0-9]{9}" maxlength="10" required'), 'same number rules as checkout');
  assert.ok(app.includes("body: JSON.stringify({ token: currentSearch.token, hue: chosen.hue, tone })"), 'colour body {token, hue, tone}');
  assert.ok(app.includes("body: JSON.stringify({ token: currentSearch.token, phone })"), 'notify body {token, phone}');
  assert.ok(app.includes("notifyStatusMsg('We’ll WhatsApp you once.')"));
  assert.ok(app.includes("$('#resultsCopy').textContent = 'Matched by board colour · previews only'"));
  assert.ok(app.includes("if (!Array.isArray(result.previews))"), 'the colour reply is the /api/match shape');
});

test('share: Web Share first, wa.me second, the text carries the session and the public site URL, the gallery link uses the saved 30-day token', async () => {
  const app = await read('app.js'), html = await read('index.html');
  assert.ok(app.includes("if (typeof navigator.share === 'function' && (!navigator.canShare || navigator.canShare(payload)))"));
  assert.ok(app.includes("window.open(whatsappUrl(`${text}`), '_blank', 'noopener');"));
  assert.ok(app.includes("const whatsappUrl = text => `https://wa.me/?text=${encodeURIComponent(text)}`;"));
  assert.ok(app.includes("const siteUrl = () => `${location.origin}${location.pathname}`;"), 'never the query (order_id, gallery token) in a share');
  assert.ok(app.includes("share(shareText(), siteUrl())"), 'header and lightbox share the site URL');
  assert.ok(app.includes("return saved && currentSearch?.searchId === saved.searchId ? `${siteUrl()}?gallery=${encodeURIComponent(saved.searchId)}.${encodeURIComponent(saved.token)}` : null;"), 'the gallery link is rebuilt from the saved record');
  assert.ok(html.includes('id="shareResults"') && html.includes('id="sharePhoto"') && html.includes('id="shareGallery"'));
  assert.ok(/<p class="gallery-share-hint">Anyone with that link can open your photos for 30 days/.test(html), 'the bearer-link hint sits under the button');
  assert.ok(app.includes("loadSessions().finally(resumeGalleryFromLink);"), 'a ?gallery= link is honoured on load, after the session list so it owns the status line');
});

test('checkout trust block: per-photo price, the three lines and inline payment glyphs above the phone field', async () => {
  const app = await read('app.js'), html = await read('index.html');
  const perPhotoCopy = lift(app, 'perPhotoCopy');
  assert.equal(perPhotoCopy(12, 70000, 'INR'), '₹58 each');
  assert.equal(perPhotoCopy(9, 70000, 'INR'), '₹78 each');
  assert.equal(perPhotoCopy(1, 5000, 'INR'), '₹50 each');
  assert.equal(perPhotoCopy(0, 70000, 'INR'), ''); assert.equal(perPhotoCopy(3, 0, 'INR'), '');
  const dialog = html.match(/<dialog id="checkoutDialog"[\s\S]*?<\/dialog>/)[0];
  const order = ['id="checkoutTitle"', 'id="checkoutPerPhoto"', 'class="checkout-trust"', 'class="pay-methods"', 'for="checkoutPhone"'].map(mark => dialog.indexOf(mark));
  assert.ok(order.every(i => i > -1) && order.every((i, n) => n === 0 || i > order[n - 1]), `trust block sits above the phone field (${order})`);
  assert.deepEqual([...dialog.matchAll(/<li>([^<]+)<\/li>/g)].map(m => m[1]), ['Full-resolution originals, no watermark', 'Download all as one ZIP', '30-day link to come back']);
  assert.equal((dialog.match(/<svg viewBox="0 0 20 20" aria-hidden="true">/g) || []).length, 3, 'three inline glyphs, no external images');
  assert.equal(/<img/.test(dialog), false);
  assert.ok(app.includes("$('#checkoutTitle').textContent = checkoutHeading(photos.length, amount)"), 'the heading contract from wave 1 stands');
});

test('"lands by": rendered from nextDropAt, hidden otherwise, with no empty box in the page', async () => {
  const app = await read('app.js'), html = await read('index.html'), css = await read('site.css');
  assert.ok(html.includes('<p class="next-drop" id="nextDrop" hidden></p>'));
  assert.ok(app.includes("renderNextDrop(data.nextDropAt);"));
  assert.ok(app.includes("line.textContent = copy || ''; line.hidden = !copy;"), 'omitted entirely when there is nothing to say');
  assert.ok(/\.next-drop\{[^}]*font-size:13px/.test(css));
});

test('font swap: caps-tuned fallback faces exist, the hero lines use them, and the second title line has its own face', async () => {
  const tokens = await read('soi-tokens.css'), css = await read('site.css');
  const caps = [...tokens.matchAll(/@font-face\{font-family:'Plus Jakarta Sans Fallback Caps';font-weight:(\d+ \d+);[^}]*size-adjust:([\d.]+)%;ascent-override:([\d.]+)%;descent-override:([\d.]+)%;line-gap-override:0%\}/g)];
  assert.equal(caps.length, 2);
  for (const [, weights, size, ascent, descent] of caps) {
    // overrides = web font ascent/descent (1038/222 per 1000) ÷ size-adjust, within rounding
    assert.ok(Math.abs(ascent - 103.8 / (size / 100)) < .2 && Math.abs(descent - 22.2 / (size / 100)) < .2, `${weights}: ascent ${ascent} / descent ${descent} at ${size}%`);
    assert.ok(size >= 94 && size <= 96, 'caps run ~95 % of Arial');
  }
  const title = tokens.match(/@font-face\{font-family:'Plus Jakarta Sans Fallback Title';font-weight:800;[^}]*size-adjust:([\d.]+)%;/);
  assert.ok(title && Math.abs(title[1] - 101) < .5, 'OF INDIA runs the other way: 101 %');
  assert.ok(tokens.includes("--sans-caps:'Plus Jakarta Sans','Plus Jakarta Sans Fallback Caps',Arial,sans-serif;"));
  for (const rule of ['.hero-hand{font-family:var(--sans-caps)', '.ticker-group{flex-shrink:0;display:flex;align-items:center;font-family:var(--sans-caps)', "font-family:var(--sans-caps);font-size:11px;letter-spacing:1px}", ".soi-title span{font-family:'Plus Jakarta Sans','Plus Jakarta Sans Fallback Title',Arial,sans-serif}"]) assert.ok(css.includes(rule), rule);
});

test('hero contrast over the photo: the three overrides clear 4.5:1 against the darkest sampled backdrop pixel', async () => {
  const tokens = await read('soi-tokens.css'), css = await read('site.css');
  const token = name => tokens.match(new RegExp(`--soi-${name}:(#[0-9A-Fa-f]{6})`))[1];
  assert.ok(css.includes('.hero .soi-tagline{color:var(--soi-coral-ink)}'));
  assert.ok(css.includes('.hero .hero-bottom{color:var(--soi-umber)}') && css.includes('.hero .hero-bottom a{color:var(--soi-dusk)}'));
  // Darkest backdrop pixels sampled behind each node at 1024/1440 (docs/audit/handoff/W3-A.md): luminance .786 under the tagline,
  // .478 under the bottom strip, .582 under the arrow — as greys, for the same ratio arithmetic.
  const grey = L => { const c = Math.round(255 * (L <= .0031308 ? L * 12.92 : 1.055 * L ** (1 / 2.4) - .055)); return `#${c.toString(16).padStart(2, '0').repeat(3)}`; };
  assert.ok(contrast(token('coral-ink'), grey(.786)) >= 4.5, `tagline ${contrast(token('coral-ink'), grey(.786)).toFixed(2)}`);
  assert.ok(contrast(token('umber'), grey(.478)) >= 4.5);
  assert.ok(contrast(token('dusk'), grey(.582)) >= 4.5);
  assert.ok(contrast(token('slate-deep'), grey(.582)) < 4.5, 'the arrow needed the change');
  assert.ok(contrast(token('slate-ink'), token('slate-tint')) >= 4.5, 'conditions chips print in slate-ink');
  assert.ok(css.includes('.conditions .chip{text-transform:none;color:var(--soi-slate-ink)}'));
});

test('soi-stamps.svg: still placeholder geometry, with the note for the kit at the top', async () => {
  const sprite = await read('soi-stamps.svg');
  assert.ok(sprite.includes('PLACEHOLDER GEOMETRY'));
  assert.ok(/W3-A.*kit/i.test(sprite.slice(0, 2000)), 'the wave-3 note is in the header comment');
});

// ── FIX-C (review-fix pass) ────────────────────────────────────────────────────

test('gallery link: both ?gallery=<id>.<token> and ?gallery=<id>&token=<token> open the gallery; junk opens nothing', async () => {
  const app = await read('app.js');
  const galleryLinkParams = lift(app, 'galleryLinkParams');
  assert.deepEqual(galleryLinkParams('?gallery=sr1.tok-30d'), { searchId: 'sr1', token: 'tok-30d' }, 'the dotted form (the page’s own share link)');
  assert.deepEqual(galleryLinkParams('?gallery=sr1&token=tok-30d'), { searchId: 'sr1', token: 'tok-30d' }, 'the separate-token form (older Worker links)');
  assert.deepEqual(galleryLinkParams('?utm=x&gallery=sr1&token=tok-30d&order_id=y'), { searchId: 'sr1', token: 'tok-30d' }, 'other params ride along');
  assert.deepEqual(galleryLinkParams('?gallery=sr1.a.b'), { searchId: 'sr1', token: 'a.b' }, 'the token keeps any later dots');
  assert.deepEqual(galleryLinkParams('?gallery=sr%2E1&token=t'), { searchId: 'sr.1', token: 't' }, 'an explicit token wins over a dot in the id');
  for (const bad of ['', '?', '?token=only', '?gallery=', '?gallery=nonsense', '?gallery=.tok', '?gallery=sr1.', '?gallery=sr1&token=']) assert.equal(galleryLinkParams(bad), null, JSON.stringify(bad));
  // resumeGalleryFromLink drops the query first (both spellings) and only then decides whether anything opens.
  const resume = app.slice(app.indexOf('function resumeGalleryFromLink()'), app.indexOf('function returnToSearch()'));
  assert.match(resume, /if \(!new URLSearchParams\(location\.search\)\.has\('gallery'\)\) return false;/);
  assert.match(resume, /const link = galleryLinkParams\(location\.search\);\s+history\.replaceState\(null, '', location\.pathname \+ location\.hash\);\s+if \(!link\) return false;/);
  assert.match(resume, /openGallery\(\{ \.\.\.link, session: null \}, null\);/);
});

test('lightbox: a cancelled pointer puts the slide back and never turns the page; the results jump-to-top survives old Safari', async () => {
  const app = await read('app.js');
  const finish = app.slice(app.indexOf('const finish = event => {'), app.indexOf("stage.addEventListener('pointerup', finish);"));
  // pointercancel bails out before the flick maths (Chromium reports clientX 0 there → dx = −startX → "next photo").
  const cancelAt = finish.indexOf("if (event.type === 'pointercancel')"), flickAt = finish.indexOf('swipeAdvances(dx');
  assert.ok(cancelAt > 0 && cancelAt < flickAt, 'the cancel branch comes before the swipe decision');
  assert.match(finish, /if \(event\.type === 'pointercancel'\) \{ lastTap = null; if \(scale <= 1\) image\.style\.transform = ''; return; \}/);
  assert.ok(finish.indexOf('dragging = false;') < cancelAt, 'the drag state is closed first');
  // Every instant jump goes through jumpToTop(), whose fallback switches the root's smooth scroll off around a plain call.
  assert.equal((app.match(/scrollTo\(\{ top: 0, behavior: 'instant' \}\)/g) || []).length, 1, 'only the helper spells the instant scroll');
  assert.equal((app.match(/jumpToTop\(\)/g) || []).length, 4, 'showResults, popstate and the colour search call it (+ the definition)');
  const helper = app.slice(app.indexOf('function jumpToTop()'), app.indexOf('function showResults()'));
  assert.match(helper, /try \{ window\.scrollTo\(\{ top: 0, behavior: 'instant' \}\); \}/);
  assert.match(helper, /catch \{ const root = document\.documentElement, was = root\.style\.scrollBehavior; root\.style\.scrollBehavior = 'auto'; window\.scrollTo\(0, 0\); root\.style\.scrollBehavior = was; \}/);
  // Run it against a window that throws on the options form (Safari < 15.4): the plain call happens with smooth scrolling off.
  const calls = []; const root = { style: { scrollBehavior: '' } };
  const jumpToTop = new Function('window', 'document', `${helper}; return jumpToTop;`)({ scrollTo: (...args) => { if (typeof args[0] === 'object') throw new TypeError('bad behavior'); calls.push({ args, behavior: root.style.scrollBehavior }); } }, { documentElement: root });
  jumpToTop();
  assert.deepEqual(calls, [{ args: [0, 0], behavior: 'auto' }]);
  assert.equal(root.style.scrollBehavior, '', 'restored afterwards');
});
