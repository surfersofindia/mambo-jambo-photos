import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { root, siteFiles } from '../scripts/site-files.mjs';
test('deployment includes only public assets, with all local page references present', async () => {
  const files = new Set(await siteFiles());
  for (const privateFile of ['.env.local', '.dev.vars', 'worker.js', 'schema.sql', 'package.json', 'README.md', 'face-api/main.py']) assert.equal(files.has(privateFile), false);
  for (const page of ['index.html', 'admin.html']) {
    const html = await readFile(new URL(page, root), 'utf8');
    for (const [, path] of html.matchAll(/(?:src|href)="([^"#][^"]*)"/g)) {
      if (/^(https?:|data:|mailto:|tel:)/.test(path)) continue;
      assert.equal(files.has(path === '/' ? 'index.html' : path.split('#')[0].replace(/^\//, '')), true, `${page} references missing asset ${path}`);
    }
  }
});
test('guest script selectors resolve to unique elements', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  const script = await readFile(new URL('app.js', root), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const [, id] of script.matchAll(/\$\('#([\w-]+)'\)/g)) assert.ok(ids.includes(id), `Missing #${id}`);
});

test('crew controls and accessible tab panels have valid targets', async () => {
  const html = await readFile(new URL('admin.html', root), 'utf8');
  const script = await readFile(new URL('admin.js', root), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const [, id] of script.matchAll(/getElementById\('([\w-]+)'\)/g)) assert.ok(ids.includes(id), `Missing crew control #${id}`);
  for (const [, id] of html.matchAll(/aria-(?:controls|labelledby)="([^"]+)"/g)) assert.ok(ids.includes(id));
  assert.equal((html.match(/<dialog\b/g) || []).length, 4);
  assert.equal((html.match(/<\/dialog>/g) || []).length, 4);
});

// ---- W1-D: public-site behaviours (F14–F18, F20 markup, F22–F26) -----------------------------------------------------
// app.js is a classic script with top-level DOM access, so its pure helpers are lifted out of the source by name and
// evaluated on their own. A helper that stops being a plain `function name(…) {…}` declaration fails these tests loudly.
const readSite = async (file) => readFile(new URL(file, root), 'utf8');
function liftFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found in app.js`);
  let depth = 0, i = source.indexOf('{', start);
  for (; i < source.length; i++) { if (source[i] === '{') depth++; else if (source[i] === '}' && --depth === 0) break; }
  return new Function(`return ${source.slice(start, i + 1)}`)();
}
const hexToRgb = (hex) => { const h = hex.replace('#', ''); const p = [0, 2, 4, 6].filter(i => i < h.length).map(i => parseInt(h.slice(i, i + 2), 16)); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] / 255 }; };
function contrast(fgHex, bgHex) {
  const fg = hexToRgb(fgHex), bg = hexToRgb(bgHex);
  const c = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
  const lin = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
  const L = x => .2126 * lin(x.r) + .7152 * lin(x.g) + .0722 * lin(x.b);
  const [hi, lo] = [L(c), L(bg)].sort((a, b) => b - a);
  return (hi + .05) / (lo + .05);
}

test('F14: how-it-works copy, its headings and the lightbox hint pass 4.5:1 on their dark panels', async () => {
  const css = await readSite('site.css'), tokens = await readSite('soi-tokens.css');
  const token = name => tokens.match(new RegExp(`--soi-${name}:(#[0-9A-Fa-f]{6})`))[1];
  const howCopy = css.match(/\.how \.section-title>p,\.how-grid p\{color:(#[0-9A-Fa-f]{6,8})/)[1];
  const howH3 = css.match(/\.how-grid h3\{font-size:21px;color:(#[0-9A-Fa-f]{6,8})/)[1];
  const hint = css.match(/\.lightbox-hint\{[^}]*color:(#[0-9A-Fa-f]{6,8})!important/)[1];
  assert.ok(contrast(howCopy, token('slate-deep')) >= 4.5, `how copy ${howCopy} on slate-deep is ${contrast(howCopy, token('slate-deep')).toFixed(2)}`);
  assert.ok(contrast(howH3, token('slate-deep')) >= 4.6, `how h3 ${howH3} on slate-deep is ${contrast(howH3, token('slate-deep')).toFixed(2)}`);
  assert.ok(contrast(hint, token('dusk')) >= 4.5, `lightbox hint ${hint} on dusk is ${contrast(hint, token('dusk')).toFixed(2)}`);
});

test('F17: no font size under 11px anywhere in the public stylesheets', async () => {
  for (const file of ['site.css', 'soi-tokens.css', 'soi-brand.css', 'premium.css']) {
    const css = await readSite(file);
    const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g), ...css.matchAll(/\bfont:\s*(?:[a-z0-9-]+\s+)*?(\d+(?:\.\d+)?)px/g)].map(m => Number(m[1]));
    assert.ok(sizes.length > 0 || file === 'premium.css', `${file} has font sizes to check`);
    for (const size of sizes) assert.ok(size >= 11, `${file} sets a ${size}px font size`);
  }
});

test('F16: the public footer has no crew link; the about page keeps one', async () => {
  const html = await readSite('index.html');
  assert.equal(/<footer>[\s\S]*href="admin\.html"[\s\S]*<\/footer>/.test(html), false, 'index.html footer still links admin.html');
  assert.ok(/href="admin\.html"/.test(await readSite('about.html')), 'about.html should keep the crew link');
});

test('F15: results clear the phone action bar by specificity and the closed lightbox stays out of the page', async () => {
  const css = await readSite('site.css');
  assert.ok(css.includes('.results.section{padding-bottom:calc(96px + env(safe-area-inset-bottom,0px))}'));
  assert.ok(css.includes('#lightbox[open]{display:flex}'));
  assert.equal(/#lightbox\{[^}]*display:flex/.test(css), false, 'a bare #lightbox{display:flex} would render the closed dialog in flow');
  assert.ok(css.includes('.results{min-height:100vh}'), 'results keep the footer below the fold at the view swap');
});

test('F18: skeleton rows follow the cached session count, the status line and matching stage keep their boxes', async () => {
  const skeletonRows = liftFunction(await readSite('app.js'), 'skeletonRows');
  assert.deepEqual([null, undefined, '', '0', 'x', '-2', '1', '2', 2.7, '3', '4', '9'].map(skeletonRows), [1, 1, 1, 1, 1, 1, 1, 2, 2, 3, 4, 4]);
  const html = await readSite('index.html'), css = await readSite('site.css');
  assert.equal((html.match(/class="skeleton session-skeleton"/g) || []).length, 1, 'markup carries the one-session default');
  assert.ok(css.includes('#finderStatus:empty{display:block}') && css.includes('#finderStatus{min-height:21px'));
  assert.ok(/#matchingStage\{[^}]*min-height:var\(--stage-h/.test(css));
  assert.ok(/\.session-loading\{position:absolute/.test(css), 'the loading line overlays the rows instead of adding height');
});

test('F20 markup: hero image has three candidates, the preload mirrors them and the Worker is preconnected', async () => {
  const html = await readSite('index.html');
  const srcset = 'assets/brand-surf-wide-768.webp 768w, assets/brand-surf-wide-1280.webp 1280w, assets/brand-surf-wide.webp 1920w';
  assert.ok(html.includes(`<img src="assets/brand-surf-wide.webp" srcset="${srcset}" sizes="100vw"`));
  assert.ok(html.includes(`<link rel="preload" as="image" href="assets/brand-surf-wide.webp" imagesrcset="${srcset}" imagesizes="100vw"`));
  assert.ok(html.includes('<link rel="preconnect" href="https://mambo-jambo-photo-api.surfersofindia.workers.dev">'));
  assert.ok(html.indexOf('rel="preload" as="image"') < html.indexOf('rel="stylesheet" href="soi-tokens.css"'), 'preload is declared before the stylesheets');
});

test('typography: balanced headings, orphan-free paragraphs, tabular figures on prices and counts', async () => {
  const css = await readSite('site.css');
  assert.ok(css.includes('h1,h2{text-wrap:balance}') && css.includes('p{text-wrap:pretty}'));
  const tabular = css.match(/^([^{\n]+)\{font-variant-numeric:tabular-nums\}/m)[1];
  for (const sel of ['.pricing-amount', '#unlockPrice', '#unlockPriceBar', '#payAmount', '#favouriteCount', '#favouriteCountBar', '#lightboxCount', '#checkoutTitle']) assert.ok(tabular.split(',').includes(sel), `${sel} is tabular`);
});

test('F22: only in-page links outside the form and the results view leave the results / cancel a search', async () => {
  const leavesResults = liftFunction(await readSite('app.js'), 'leavesResults');
  let seen = '';
  assert.equal(leavesResults({ closest: selector => { seen = selector; return null; } }), true);
  assert.ok(seen.includes('#searchForm') && seen.includes('#results'), `handler excludes both containers (got ${seen})`);
  assert.equal(leavesResults({ closest: () => ({}) }), false);
});

test('F23: the drop zone shares the file input validation and shows a drag state', async () => {
  const app = await readSite('app.js'), css = await readSite('site.css');
  const selfieProblem = liftFunction(app, 'selfieProblem');
  assert.equal(selfieProblem({ type: 'image/jpeg', size: 1024 }), '');
  assert.equal(selfieProblem({ type: 'image/webp', size: 10 * 1024 * 1024 }), '');
  assert.equal(selfieProblem({ type: 'image/heic', size: 1024 }), 'JPG, PNG or WebP under 10 MB.');
  assert.equal(selfieProblem({ type: 'image/png', size: 10 * 1024 * 1024 + 1 }), 'JPG, PNG or WebP under 10 MB.');
  assert.equal(selfieProblem({ type: 'image/png', size: 0 }), 'JPG, PNG or WebP under 10 MB.');
  assert.equal(selfieProblem(null), 'JPG, PNG or WebP under 10 MB.');
  assert.ok(/zone\.addEventListener\('drop',[\s\S]*?acceptSelfie\(files\[0\]\)/.test(app), 'drop goes through acceptSelfie');
  assert.ok(/for \(const type of \['dragenter', 'dragover'\]\)/.test(app) && app.includes("zone.addEventListener('dragleave'"));
  assert.ok(app.includes("addEventListener('change', event => acceptSelfie(event.target.files[0]))"), 'the input uses the same path');
  assert.ok(css.includes('.upload-zone.is-dragover'));
});

test('F24: step 01, the brand link and unlocked figcaption links get 44px rows', async () => {
  const css = await readSite('site.css');
  assert.ok(/\.steps li\{[^}]*min-height:44px/.test(css));
  assert.ok(/\.brand\{[^}]*min-height:44px/.test(css));
  assert.ok(css.includes('.gallery figcaption:has(a){min-height:44px') && /\.gallery figcaption a\{[^}]*min-height:44px/.test(css));
});

test('F25: a short fast flick turns the lightbox page, a slow short drag does not; the hint follows the pointer type', async () => {
  const swipeAdvances = liftFunction(await readSite('app.js'), 'swipeAdvances');
  assert.equal(swipeAdvances(-30, 40), true, '30px in 40ms is a flick');
  assert.equal(swipeAdvances(20, 40), true, '20px in 40ms just qualifies');
  assert.equal(swipeAdvances(-30, 200), false, '30px in 200ms is a slow drag');
  assert.equal(swipeAdvances(-15, 10), false, 'under 20px never advances');
  assert.equal(swipeAdvances(45, 3000), true, 'over 40px advances at any speed');
  assert.equal(swipeAdvances(30, 0), false, 'a zero-length drag time is not a flick');
  const html = await readSite('index.html'), css = await readSite('site.css');
  assert.ok(/<span class="hint-touch">Swipe for more · double-tap to zoom<\/span>/.test(html));
  assert.ok(/<span class="hint-pointer">← → keys · double-click to zoom<\/span>/.test(html));
  assert.ok(css.includes('@media(pointer:fine){.hint-touch{display:none}.hint-pointer{display:inline}}'));
});

test('F26: the gallery auto-fills (never fixed columns) and keeps the tile box, empty states use real stamps and end in an action, checkout names count and price', async () => {
  const css = await readSite('site.css'), html = await readSite('index.html'), sprite = await readSite('soi-stamps.svg'), app = await readSite('app.js');
  assert.ok(/\.gallery\{display:grid;grid-template-columns:repeat\(auto-fill,minmax\(200px,1fr\)\)/.test(css), 'wide screens auto-fill ~216px prints');
  assert.equal(/\.gallery\{[^}]*repeat\(3,1fr\)/.test(css), false, 'no fixed three-column gallery');
  assert.ok(/\.photo-open img\{[^}]*aspect-ratio:4\/3/.test(css));
  const ids = new Set([...sprite.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  for (const [block, stamp] of [['galleryEmpty', 'stamp-shell'], ['noMatches', 'stamp-starfish']]) {
    const markup = html.match(new RegExp(`<div class="soi-empty" id="${block}"[^>]*>([\\s\\S]*?)</div>`))[1];
    assert.ok(markup.includes(`href="soi-stamps.svg#${stamp}"`) && ids.has(stamp), `${block} uses ${stamp} and the sprite has it`);
    assert.ok(/<button/.test(markup), `${block} ends in a next action`);
  }
  const checkoutHeading = liftFunction(app, 'checkoutHeading');
  assert.equal(checkoutHeading(12, '₹700'), '12 photos · ₹700');
  assert.equal(checkoutHeading(1, '₹50'), '1 photo · ₹50');
  assert.ok(html.includes('<h3 id="checkoutTitle">') && app.includes("$('#checkoutTitle').textContent = checkoutHeading(photos.length, amount)"));
});
