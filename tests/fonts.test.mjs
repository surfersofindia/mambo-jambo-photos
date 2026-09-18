import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { root, siteFiles } from '../scripts/site-files.mjs';

// ---- W2-A (F19): self-hosted fonts, preloads, CSP font-src ------------------------------------------------------------
// Static invariants only (no browser): the pages must never reach Google Fonts again, the @font-face block must point at files
// that ship, each page preloads exactly its above-the-fold faces, the fallback faces keep their metric overrides,
// and every weight the stylesheets ask for is inside what the shipped files can render — the variable Plus Jakarta Sans covers
// 400..800, Fraunces is a single 500 cut (upright + italic), so a stray `font-weight:300` or a Fraunces 600 would fall back silently.
const read = (file) => readFile(new URL(file, root), 'utf8');
const pages = ['index.html', 'admin.html', 'about.html', 'contact.html', 'terms.html', 'refund-policy.html'];
const stylesheets = ['soi-tokens.css', 'site.css', 'premium.css', 'soi-brand.css', 'admin-theme.css'];
const FONT_BUDGET = 70 * 1024; // all five woff2 files together; the Google embed was 234 KB on the landing page

test('F19: no page loads anything from Google Fonts', async () => {
  for (const page of pages) {
    const html = await read(page);
    assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/, `${page} still references Google Fonts`);
  }
});

test('F19: every page preloads exactly its above-the-fold faces', async () => {
  // index: the hero is Plus Jakarta Sans only (Fraunces first appears at #finder, below the fold at 375 and 1024; preloading it
  // there would put another 18 KB (about 90 ms of slow-4G bandwidth) ahead of the first paint for nothing visible). Every other page
  // opens on a Fraunces heading, so both go.
  const expected = { 'index.html': ['assets/fonts/plus-jakarta-sans-400-800.woff2'] };
  for (const page of pages) {
    const html = await read(page);
    const preloads = [...html.matchAll(/<link rel="preload" as="font"([^>]*)>/g)].map(m => m[1]);
    const hrefs = preloads.map(attrs => attrs.match(/href="([^"]+)"/)[1]).sort();
    assert.deepEqual(hrefs, expected[page] || ['assets/fonts/fraunces-500.woff2', 'assets/fonts/plus-jakarta-sans-400-800.woff2'], `${page} preloads ${hrefs.join(', ')}`);
    for (const attrs of preloads) {
      assert.match(attrs, /type="font\/woff2"/, `${page}: font preload without type`);
      assert.match(attrs, /\bcrossorigin\b/, `${page}: font preload without crossorigin (the browser would fetch it twice)`);
    }
    // Preloads must precede the stylesheet that declares the faces, otherwise they add nothing to the critical path.
    assert.ok(html.indexOf('rel="preload" as="font"') < html.indexOf('soi-tokens.css'), `${page}: font preloads come after soi-tokens.css`);
  }
});

test('F19: every @font-face src ships, is a woff2, uses swap, and the set stays under budget', async () => {
  const css = await read('soi-tokens.css');
  const files = new Set(await siteFiles());
  const faces = [...css.matchAll(/@font-face\{([^}]*)\}/g)].map(m => m[1]);
  const web = faces.filter(f => /url\(/.test(f)), local = faces.filter(f => /local\(/.test(f));
  assert.ok(web.length >= 5 && local.length >= 4, `expected web + fallback faces, got ${web.length} + ${local.length}`);
  let bytes = 0;
  const seen = new Set();
  for (const face of web) {
    const url = face.match(/url\(([^)]+)\)/)[1].replace(/['"]/g, '');
    assert.ok(files.has(url), `${url} is not in the site file list`);
    assert.match(face, /font-display:swap/, `${url}: no font-display:swap`);
    assert.match(face, /format\('woff2'\)/, `${url}: format hint missing`);
    assert.match(face, /unicode-range:/, `${url}: no unicode-range`);
    const buf = await readFile(new URL(url, root));
    assert.equal(buf.subarray(0, 4).toString('latin1'), 'wOF2', `${url} is not a woff2 file`);
    if (!seen.has(url)) { seen.add(url); bytes += buf.length; }
  }
  assert.ok(bytes <= FONT_BUDGET, `fonts weigh ${bytes} B, budget ${FONT_BUDGET}`);
  // The rupee sign sits outside Google's latin block; both families must carry it or ₹700 falls back to the system font.
  for (const family of ['Plus Jakarta Sans', 'Fraunces']) {
    assert.ok(web.some(f => f.includes(`font-family:'${family}'`) && /unicode-range:U\+20B9/i.test(f)), `${family}: no U+20B9 face`);
  }
  // Licences ship next to the files.
  for (const licence of ['assets/fonts/LICENSE-plus-jakarta-sans.txt', 'assets/fonts/LICENSE-fraunces.txt']) {
    assert.ok(files.has(licence), `${licence} missing from the site file list`);
    assert.match(await read(licence), /SIL OPEN FONT LICENSE Version 1\.1/);
  }
});

test('F19: the fallback faces carry metric overrides and sit right behind the web font in every stack', async () => {
  const css = await read('soi-tokens.css');
  const fallbacks = [...css.matchAll(/@font-face\{([^}]*local\([^}]*)\}/g)].map(m => m[1]);
  for (const face of fallbacks) {
    for (const d of ['size-adjust', 'ascent-override', 'descent-override', 'line-gap-override']) assert.match(face, new RegExp(`${d}:\\d`), `fallback face lacks ${d}: ${face.slice(0, 60)}`);
  }
  const weights = fallbacks.filter(f => f.includes("'Plus Jakarta Sans Fallback'")).map(f => f.match(/font-weight:([^;]+)/)[1]);
  assert.deepEqual(weights, ['400 500', '600 700', '800'], 'sans fallback weight ranges must tile 400..800 without overlap');
  assert.match(css, /--sans:'Plus Jakarta Sans','Plus Jakarta Sans Fallback',/);
  assert.match(css, /--display:'Fraunces','Fraunces Fallback',/);
  assert.match(css, /--mono:'Plus Jakarta Sans','Plus Jakarta Sans Fallback',/);
});

test('F19: every weight the stylesheets use is inside the shipped faces (sans 400..800, Fraunces 500 only)', async () => {
  const tokens = await read('soi-tokens.css');
  const sans = tokens.match(/font-family:'Plus Jakarta Sans';font-style:normal;font-weight:(\d+) (\d+)/);
  const [lo, hi] = [Number(sans[1]), Number(sans[2])];
  for (const file of stylesheets) {
    const css = (await read(file)).replace(/@font-face\{[^}]*\}/g, '');
    for (const [, w] of css.matchAll(/font-weight:\s*(\d{3})/g)) assert.ok(Number(w) >= lo && Number(w) <= hi, `${file}: font-weight:${w} outside ${lo}..${hi}`);
    for (const [, w] of css.matchAll(/\bfont:\s*(?:italic\s+)?(\d{3})\s/g)) assert.ok(Number(w) >= lo && Number(w) <= hi, `${file}: font:${w} outside ${lo}..${hi}`);
    // Display-face shorthands must ask for 500: the only Fraunces cut on disk.
    for (const [decl, w] of css.matchAll(/\bfont:\s*(?:italic\s+)?(\d{3})[^;}]*var\(--display\)/g)) assert.equal(w, '500', `${file}: Fraunces asked at ${w}: ${decl}`);
  }
  assert.match(tokens, /h1,h2\{font-family:var\(--display\);font-weight:500/);
});

test('F19: both CSP files restrict fonts to the site itself and drop the Google hosts', async () => {
  const htaccess = await read('.htaccess');
  const vercel = JSON.parse(await read('vercel.json'));
  const apache = htaccess.match(/Content-Security-Policy-Report-Only "([^"]+)"/)[1];
  const mirror = vercel.headers.find(h => h.source === '/(.*)').headers.find(h => h.key === 'Content-Security-Policy-Report-Only').value;
  assert.equal(apache, mirror, 'the two hosts must send the same policy');
  assert.match(apache, /(^|; )font-src 'self'(;|$)/);
  assert.doesNotMatch(apache, /googleapis|gstatic/);
  assert.match(apache, /style-src 'self' 'unsafe-inline'(;|$)/);
  // Fonts are not fingerprinted, so both hosts cache them by name for a year (a new cut ships under a new name).
  assert.match(htaccess, /<FilesMatch "\\\.woff2\$">\s*Header set Cache-Control "public, max-age=31536000, immutable"/);
  const fontRule = vercel.headers.find(h => h.source === '/assets/fonts/(.*)\\.woff2');
  assert.equal(fontRule?.headers[0].value, 'public, max-age=31536000, immutable');
});

test('W1-C tokens: slate-ink and ochre-ink exist and clear 4.5:1 on their chip backgrounds', async () => {
  const css = await read('soi-tokens.css');
  const token = name => css.match(new RegExp(`--soi-${name}:(#[0-9A-Fa-f]{6})`))?.[1];
  const lin = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
  const L = hex => { const h = hex.slice(1); return .2126 * lin(parseInt(h.slice(0, 2), 16)) + .7152 * lin(parseInt(h.slice(2, 4), 16)) + .0722 * lin(parseInt(h.slice(4, 6), 16)); };
  const contrast = (a, b) => { const [hi, lo] = [L(a), L(b)].sort((x, y) => y - x); return (hi + .05) / (lo + .05); };
  assert.equal(token('slate-ink'), '#43617A');
  assert.equal(token('ochre-ink'), '#7A5F30');
  assert.ok(contrast(token('slate-ink'), token('slate-tint')) >= 4.5);
  assert.ok(contrast(token('ochre-ink'), token('linen')) >= 4.5);
  await stat(new URL('assets/fonts/SOURCES.txt', root)); // provenance ships with the files
});
