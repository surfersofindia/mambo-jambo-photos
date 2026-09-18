// W4-B — PWA and service worker.
// Tests 1–4 guard the parts that can silently rot in the tree: the manifest and its icons, the caching
// rules in sw.js (above all "no /api caching except the watermarked media rule"), the registration
// wiring in both pages, and the precache list the build injects. Test 5 then drives the *built* worker
// in headless Chromium (Playwright is a devDependency and CI installs the browser before `npm test`):
// precache at install, an offline reload of the landing page, and the gallery rule end to end. It
// skips — never fails — where Chromium cannot start, and SOI_SKIP_BROWSER=1 skips it on purpose.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { root, siteFiles } from '../scripts/site-files.mjs';

const run = promisify(execFile);
const read = file => readFile(new URL(file, root), 'utf8');
const bytes = file => readFile(new URL(file, root));

// One throwaway production build of the tree, shared by the build test and the browser test, so a
// parallel `npm run build` in this checkout is never disturbed and the build runs once, not twice.
let building;
const tempBuild = () => (building ??= (async () => {
  const temp = await mkdtemp(join(tmpdir(), 'soi-pwa-build-'));
  const repo = fileURLToPath(root);
  for (const file of [...await siteFiles(), 'scripts/build.mjs', 'scripts/site-files.mjs']) await cp(join(repo, file), join(temp, file), { recursive: true }).catch(() => {});
  await run(process.execPath, ['scripts/build.mjs'], { cwd: temp });
  return { temp, dist: join(temp, 'dist') };
})());
after(async () => { const built = await building?.catch(() => null); if (built) await rm(built.temp, { recursive: true, force: true }); });

// Serves a dist/ the way the hosts do — hashed assets immutable, everything else `no-cache,
// must-revalidate` — with a tiny /api mock: media answers a cacheable 1×1 PNG, anything else JSON with
// `no-store`. Hits are counted per path so a test can prove the network was never touched offline.
async function serveDist(dist) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const hits = new Map();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    hits.set(url.pathname, (hits.get(url.pathname) || 0) + 1);
    if (url.pathname.startsWith('/api/media/')) { response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=600', 'access-control-allow-origin': '*' }); response.end(pixel); return; }
    if (url.pathname.startsWith('/api/')) { response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end('{"sessions":[],"nextDropAt":null,"ok":true}'); return; }
    const file = join(dist, url.pathname === '/' ? 'index.html' : url.pathname === '/admin' ? 'admin.html' : url.pathname.slice(1));
    if (!file.startsWith(dist) || !existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': /\.[0-9a-f]{8}\.(?:js|css)$/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache, must-revalidate' });
    response.end(await readFile(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, hits, base: `http://127.0.0.1:${server.address().port}` };
}

test('W4-B: the manifest parses, is listed for deployment and every icon it names ships', async () => {
  const files = new Set(await siteFiles());
  assert.ok(files.has('manifest.webmanifest'), 'manifest.webmanifest must be in siteFiles()');
  const manifest = JSON.parse(await read('manifest.webmanifest'));
  assert.equal(manifest.short_name, 'SOI Photos');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.match(manifest.theme_color, /^#[0-9A-F]{6}$/i);
  assert.match(manifest.background_color, /^#[0-9A-F]{6}$/i);
  // The colours are the brand tokens, not invented ones.
  const tokens = await read('soi-tokens.css');
  assert.ok(tokens.includes(manifest.theme_color), `theme_color ${manifest.theme_color} is not a token in soi-tokens.css`);
  assert.ok(tokens.includes(manifest.background_color), `background_color ${manifest.background_color} is not a token in soi-tokens.css`);
  assert.equal(manifest.theme_color, (await read('index.html')).match(/<meta name="theme-color" content="([^"]+)"/)[1], 'the manifest and the page must agree on theme-color');

  const purposes = new Set();
  for (const icon of manifest.icons) {
    assert.ok(files.has(icon.src), `manifest icon ${icon.src} is not in siteFiles()`);
    const data = await bytes(icon.src);
    assert.ok(data.length > 0, `${icon.src} is empty`);
    if (icon.type === 'image/png') {
      assert.equal(data.subarray(1, 4).toString('latin1'), 'PNG', `${icon.src} is not a PNG`);
      // IHDR: width and height are big-endian uint32 at bytes 16 and 20; they must match the declared size.
      assert.equal(`${data.readUInt32BE(16)}x${data.readUInt32BE(20)}`, icon.sizes, `${icon.src} is not ${icon.sizes}`);
    }
    for (const purpose of (icon.purpose || 'any').split(/\s+/)) purposes.add(purpose);
  }
  assert.ok(purposes.has('any') && purposes.has('maskable'), 'the icon set needs an "any" and a "maskable" entry');
  for (const size of ['192x192', '512x512']) assert.ok(manifest.icons.some(icon => icon.sizes === size && icon.type === 'image/png'), `a ${size} PNG icon is required for installability`);
});

test('W4-B: sw.js never caches /api except watermarked gallery media, and never the studio', async () => {
  const sw = await read('sw.js');
  // The one media rule: public media route, preview/thumb only, never a download.
  assert.match(sw, /\/\^\\\/api\\\/media\\\/\(\[\\w-\]\+\)\$\//, 'the media matcher must be anchored on /api/media/:id');
  assert.match(sw, /variant !== 'preview' && variant !== 'thumb'/, 'only preview and thumb variants may be cached');
  assert.match(sw, /download'\) === '1'\) return null/, 'a ?download=1 link must never be cached');
  // Everything else under /api falls through to the network, and the fall-through must come after the
  // media branch (otherwise nothing would ever be cached) but before any caching strategy is chosen.
  const mediaBranch = sw.indexOf('const media = mediaRequest(url);');
  const apiBypass = sw.indexOf("if (url.pathname.startsWith('/api/')) return;");
  const firstStrategy = Math.min(...['event.respondWith(networkFirst', 'event.respondWith(cacheFirst', 'event.respondWith(staleWhileRevalidate'].map(marker => sw.indexOf(marker)).filter(index => index > 0));
  assert.ok(mediaBranch > 0 && apiBypass > mediaBranch && apiBypass < firstStrategy, 'the /api/ bypass must sit between the media rule and the caching strategies');
  // Crew routes: only the studio shell may be cached.
  assert.match(sw, /isAdminPath\(url\.pathname\) && !isAdminShell\(url\.pathname\)\) return;/);
  // Only GET is ever considered (an upload or a payment must never be replayed from a cache).
  assert.match(sw, /request\.method !== 'GET'\) return;/);
  // The gallery cache is bounded and evicted with the search.
  assert.match(sw, /GALLERY_LIMIT = (\d+)/);
  assert.ok(Number(sw.match(/GALLERY_LIMIT = (\d+)/)[1]) <= 200);
  assert.match(sw, /caches\.delete\(GALLERY_CACHE\)/);
  // `no-store` is honoured, so `npm run dev` (which sends it for every file) and the Playwright suite
  // behave exactly as they did before the worker existed — an edit is never served from a stale cache.
  assert.match(sw, /const storable = response => Boolean\(response\?\.ok\) && !\/\\bno-store\\b\/i\.test/);
  for (const strategy of ['galleryFirst', 'cacheFirst', 'staleWhileRevalidate', 'networkFirst', 'warmGallery']) {
    const body = sw.slice(sw.indexOf(`function ${strategy}(`));
    const end = body.indexOf('\n}\n');
    assert.ok(/storable\(response\)/.test(body.slice(0, end)), `${strategy} must gate its cache.put on storable()`);
    assert.ok(!/response\?\.ok\) (?:await )?cache\.put/.test(body.slice(0, end)), `${strategy} must not store a response on .ok alone`);
  }
  // The dev copy precaches nothing; the build injects the list (see the build test below).
  assert.match(sw, /^self\.__PRECACHE__ = \{ build: 'dev', files: \[\] \};$/m);
  assert.match(sw, /event\.tag !== UPLOAD_SYNC_TAG\) return;/, 'the background-sync handler must be tag-scoped');
});

test('W4-B: both pages register the worker and carry the offline banner; only the guest page is installable', async () => {
  const files = new Set(await siteFiles());
  for (const file of ['sw.js', 'pwa.js']) assert.ok(files.has(file), `${file} must be in siteFiles()`);
  for (const page of ['index.html', 'admin.html']) {
    const html = await read(page);
    assert.match(html, /<script src="pwa\.js" defer><\/script>/, `${page} must load pwa.js with defer`);
    assert.match(html, /<div id="offlineBanner" hidden role="status">[^<]+<\/div>/, `${page} must carry the offline banner`);
    assert.equal((html.match(/id="offlineBanner"/g) || []).length, 1);
  }
  const index = await read('index.html');
  assert.match(index, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(index, /<link rel="apple-touch-icon" href="assets\/soi-icon-192\.png">/);
  // The studio is noindex and its start_url would be wrong: it gets the worker, not the install prompt.
  assert.ok(!/rel="manifest"/.test(await read('admin.html')), 'admin.html must not link the manifest');
  // pwa.js registers the worker by its plain, stable name — the build must be able to leave that literal alone.
  const pwa = await read('pwa.js');
  assert.match(pwa, /const SW_URL = 'sw\.js';/);
  assert.match(pwa, /navigator\.serviceWorker\.register\(SW_URL\)/);
  assert.match(pwa, /addEventListener\('offline', sync\)/);
  // Only watermarked variants of the saved paid gallery are ever offered to the worker.
  assert.match(pwa, /\['preview', 'thumb'\]\.includes\(url\.searchParams\.get\('variant'\)\)/);
  assert.match(pwa, /localStorage\.getItem\(GALLERY_KEY\)/);
  // The upload manifest belongs to admin.js (W4-A): pwa.js may only ask whether the database exists.
  // `indexedDB.open('soi-uploads')` here would create an empty v1 database and admin.js's own upgrade
  // would then never run, so the probe uses indexedDB.databases() and nothing else.
  assert.match(pwa, /indexedDB\?\.databases === 'function'/);
  assert.ok(!/indexedDB\.open\(/.test(pwa), 'pwa.js must never open the soi-uploads database');
  assert.match(pwa, /reg\.sync\.register\(UPLOAD_SYNC_TAG\)/);
  // The studio-only branch (register the sync tag when the crew goes offline) keys on the upload form,
  // and the database name it probes is the one admin.js (W4-A) writes — both are contracts with files
  // this workstream does not own, so a rename there must fail here, not silently disable the feature.
  assert.match(await read('admin.html'), /id="uploadForm"/, 'pwa.js keys its studio-only branch on #uploadForm');
  assert.match(await read('admin.js'), /UPLOAD_DB = 'soi-uploads'/, "admin.js's manifest database must still be named soi-uploads");
  assert.match(pwa, /db\.name === 'soi-uploads'/);
});

test('W4-B: the build keeps sw.js unhashed and injects a precache list of files that exist', async () => {
  const { dist } = await tempBuild();
  const sw = await readFile(join(dist, 'sw.js'), 'utf8');
  const injected = JSON.parse(sw.match(/^self\.__PRECACHE__ = (.*);$/m)[1]);
  assert.match(injected.build, /^[0-9a-f]{8}$/, 'the injected build id must be an 8-hex hash');
  assert.ok(injected.files.length >= 10, 'the precache list looks empty');
  for (const file of injected.files) {
    assert.ok(file.startsWith('/'), `${file} must be a root-absolute path`);
    await readFile(join(dist, file.slice(1)));   // throws if the build precaches something it did not write
    assert.ok(!/\.(png|jpe?g|webp|ico)$/i.test(file), `${file} is an image and must not be precached`);
  }
  assert.ok(injected.files.includes('/index.html'), 'the landing page must be precached');
  assert.ok(injected.files.some(file => /^\/app\.[0-9a-f]{8}\.js$/.test(file)), 'the precache list must name the fingerprinted app.js');
  assert.ok(!injected.files.includes('/admin.html'), 'the studio is runtime-cached, never precached onto a guest device');
  assert.ok(!injected.files.some(file => file.includes('face-api')), 'the lazy face-api bundle must stay out of the shell');
  // The worker itself keeps its plain name (a hashed service worker would never update in place),
  // and the registration inside the hashed pwa.js still points at it.
  await readFile(join(dist, 'sw.js'));
  const pwaName = (await readFile(join(dist, 'index.html'), 'utf8')).match(/src="(pwa\.[0-9a-f]{8}\.js)"/)[1];
  assert.match(await readFile(join(dist, pwaName), 'utf8'), /const SW_URL = 'sw\.js';/);
});

test('W4-B: in Chromium the built worker precaches the shell, renders the landing page offline and keeps only the paid gallery', { timeout: 90_000 }, async t => {
  if (process.env.SOI_SKIP_BROWSER) return t.skip('SOI_SKIP_BROWSER is set');
  let chromium;
  try { ({ chromium } = await import('@playwright/test')); } catch { return t.skip('@playwright/test is not installed'); }
  let browser;
  try { browser = await chromium.launch(); } catch (error) { return t.skip(`Chromium could not start: ${error.message.split('\n')[0]}`); }
  t.after(() => browser.close());
  const { dist } = await tempBuild();
  const { server, hits, base } = await serveDist(dist);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const buildId = JSON.parse((await readFile(join(dist, 'sw.js'), 'utf8')).match(/^self\.__PRECACHE__ = (.*);$/m)[1]).build;

  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  // 1 — registration and the install-time precache, named by the build id the build injected.
  await page.goto(`${base}/`, { waitUntil: 'load' });
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  const shell = await page.evaluate(async () => {
    const name = (await caches.keys()).find(key => key.startsWith('soi-shell-'));
    return { name, keys: name ? (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname) : [] };
  });
  assert.equal(shell.name, `soi-shell-${buildId}`, 'the shell cache is named by the injected build id');
  assert.ok(shell.keys.includes('/index.html') && shell.keys.length >= 10, `precache holds ${shell.keys.length} entries`);
  assert.ok(!shell.keys.some(path => /admin|face-api/.test(path)), 'the studio and the face-api bundle never land on a guest device');

  // 2 — a reload is answered by the worker for every script and stylesheet.
  await page.reload({ waitUntil: 'load' });
  const served = await page.evaluate(() => performance.getEntriesByType('resource').filter(entry => /\.(?:js|css)$/.test(entry.name)).map(entry => [new URL(entry.name).pathname, entry.workerStart > 0]));
  assert.ok(served.length >= 5 && served.every(([, fromWorker]) => fromWorker), `served by the worker: ${JSON.stringify(served)}`);

  // 3 — offline: the landing shell still renders, the banner shows, and nothing reaches the server.
  const before = new Map(hits);
  await context.setOffline(true);
  await page.reload({ waitUntil: 'load' }).catch(() => {});
  const offline = await page.evaluate(() => ({ title: document.querySelector('h1')?.textContent || '', banner: document.getElementById('offlineBanner')?.hidden === false, position: getComputedStyle(document.getElementById('offlineBanner')).position }));
  assert.match(offline.title, /SURFERS/, 'the landing page renders from the cache');
  assert.ok(offline.banner && offline.position === 'fixed', `the offline banner is shown and fixed: ${JSON.stringify(offline)}`);
  assert.deepEqual([...hits].filter(([path, count]) => count !== (before.get(path) || 0)), [], 'no request reached the server while offline');

  // 4 — the paid gallery: a saved 30-day token plus the unlocked grid, shaped as app.js renders it,
  // makes the worker keep those previews (keyed by photo id, so a re-minted token is a hit) and nothing else.
  await context.setOffline(false);
  const photoIds = ['pwa-photo-1', 'pwa-photo-2', 'pwa-photo-3'];
  await page.evaluate(ids => {
    localStorage.setItem('mjGallery', JSON.stringify({ searchId: 'pwa-search', token: 'gallery-token', savedAt: Date.now() }));
    document.getElementById('unlockedNotice').hidden = false;
    document.getElementById('gallery').replaceChildren(...ids.map(id => { const figure = document.createElement('figure'); figure.dataset.photoId = id; const img = document.createElement('img'); img.src = `/api/media/${id}?variant=thumb&token=first-${id}`; figure.append(img); return figure; }));
  }, photoIds);
  // pwa.js debounces the grid observer by 400 ms and the worker then warms one photo at a time, so poll
  // from here (page.waitForFunction would not await an async predicate — the pending promise is truthy).
  const galleryCache = () => page.evaluate(async () => {
    const cache = await caches.open('soi-gallery-v1');
    const keys = (await cache.keys()).map(request => new URL(request.url).pathname);
    return { keys: keys.filter(path => path.startsWith('/__soi-media/')), manifest: await (await cache.match('/__soi-gallery'))?.json() };
  });
  let gallery = await galleryCache();
  for (const deadline = Date.now() + 15_000; gallery.keys.length < photoIds.length && Date.now() < deadline;) { await new Promise(resolve => setTimeout(resolve, 100)); gallery = await galleryCache(); }
  assert.deepEqual(gallery.keys.sort(), photoIds.map(id => `/__soi-media/pwa-search/${id}/thumb`), 'the three thumbs of the paid gallery are cached under token-free keys');
  assert.deepEqual({ searchId: gallery.manifest?.searchId, photoIds: gallery.manifest?.photoIds }, { searchId: 'pwa-search', photoIds }, 'the worker remembers which search and photos it may keep');

  await context.setOffline(true);
  const probes = await page.evaluate(async ids => {
    const probe = async path => { try { const response = await fetch(path); return `${response.status}:${(await response.blob()).size}`; } catch { return 'network-error'; } };
    return {
      reminted: await Promise.all(ids.map(id => probe(`/api/media/${id}?variant=thumb&token=re-minted-${Date.now()}`))),
      unclaimed: await probe('/api/media/someone-elses-photo?variant=thumb&token=x'),
      original: await probe(`/api/media/${ids[0]}?variant=original&token=x`),
      download: await probe(`/api/media/${ids[0]}?variant=thumb&token=x&download=1`),
      sessions: await probe('/api/sessions'),
      admin: await probe('/api/admin/sessions'),
      health: await probe('/api/health'),
      adminRoute: await probe('/admin/queue'),   // anything under /admin but the studio shell is bypassed
    };
  }, photoIds);
  assert.ok(probes.reminted.every(result => /^200:\d+$/.test(result)), `re-minted preview links are served from the cache offline: ${probes.reminted}`);
  for (const [name, result] of Object.entries(probes)) if (name !== 'reminted') assert.equal(result, 'network-error', `${name} must never be cached`);
  assert.deepEqual(pageErrors, []);
});
