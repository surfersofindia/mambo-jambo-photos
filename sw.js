// Service worker for the Surfers of India photo finder (W4-B).
//
// Scope is the whole site, but the rules are deliberately narrow:
//   * app shell (HTML, CSS, JS, fonts, stamps) — precached at install in a production build,
//     runtime-cached in dev (the source tree has no hashed names to precache);
//   * fingerprinted assets (app.3f2a1b7c.js) are immutable, so they are served cache-first;
//   * unhashed assets (the source tree, fonts, svg) are stale-while-revalidate;
//   * HTML is network-first with a cache fallback, so a deploy is picked up on the next load
//     (the hosts already send `no-cache, must-revalidate` for HTML) and an offline revisit still renders;
//   * /api/** is NEVER cached — with exactly one exception: watermarked previews and thumbs
//     (`GET /api/media/:id?variant=preview|thumb`) of the paid gallery this device has a saved
//     token for, so a guest who comes back on a plane or in the water still sees their photos.
//     Originals (`variant=original`, `?download=1`), crew media and every /api/admin route stay
//     on the network, always.
//   * everything under /admin is bypassed except the studio shell itself (/admin, /admin.html).
//
// This file is never fingerprinted — a service worker needs a stable URL — so the build injects the
// precache manifest into the copied copy instead (see scripts/build.mjs). The source below works
// unchanged in `npm run dev` with an empty list: runtime caching only.
'use strict';

// scripts/build.mjs replaces this whole line with the dist/ shell list and the build id.
self.__PRECACHE__ = { build: 'dev', files: [] };

const BUILD = self.__PRECACHE__.build || 'dev';
const PRECACHE_FILES = Array.isArray(self.__PRECACHE__.files) ? self.__PRECACHE__.files : [];
const SHELL_CACHE = `soi-shell-${BUILD}`;          // shell + runtime assets; dropped when the build id changes
const GALLERY_CACHE = 'soi-gallery-v1';            // the guest's paid previews; survives deploys, evicted per search
const GALLERY_LIMIT = 150;                         // photos, not bytes: a session pack is a few dozen thumbs
const GALLERY_MANIFEST = '/__soi-gallery';         // internal cache key holding { searchId, photoIds }
const HASHED = /\.[0-9a-f]{8}\.(?:m?js|css)$/;     // written by the fingerprinting build: immutable
const SHELL_ASSET = /\.(?:m?js|css|woff2|svg|webp|png|jpe?g|ico)$/;   // what is worth keeping for an offline revisit
// Site images (the hero variants, the logos) are cached only once a visit has actually downloaded them —
// they are never precached, so a first visit pays nothing for them. Session photos are not site images:
// they come from /api/media and are handled by the gallery rules above.
const UPLOAD_SYNC_TAG = 'soi-upload-manifest';

// ── install / activate ──────────────────────────────────────────────────────────────────────────
// A failed precache must not wedge the worker (one 404 would reject addAll and leave the site
// uncontrolled), so files are added one at a time and a miss is simply skipped.
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    if (PRECACHE_FILES.length) {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(PRECACHE_FILES.map(file => cache.add(new Request(file, { cache: 'reload' })).catch(() => {})));
    }
    await self.skipWaiting();
  })());
});

// Old builds' shells go; the gallery cache is the guest's own data and is only ever evicted by the page.
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('soi-shell-') && name !== SHELL_CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────
const isSameOrigin = url => url.origin === self.location.origin;
// The studio shell is cacheable; anything else under /admin (a future /admin/... route) is not.
const isAdminShell = path => path === '/admin' || path === '/admin.html';
const isAdminPath = path => path === '/admin' || path.startsWith('/admin.') || path.startsWith('/admin/');
const isHtmlPath = path => path === '/' || path.endsWith('.html') || isAdminShell(path);

// `Cache-Control: no-store` means exactly that, and the dev server sends it for every file it serves
// (W1-E, so Lighthouse measures a cold load). Honouring it keeps `npm run dev` and the Playwright suite
// working exactly as they did before this worker existed — an edit is never served from a stale cache —
// while both hosts' production headers (`immutable` for hashed assets, `no-cache, must-revalidate` for
// HTML: store, but revalidate) are stored as usual.
const storable = response => Boolean(response?.ok) && !/\bno-store\b/i.test(response.headers.get('cache-control') || '');

// A cacheable gallery photo: the public media route, a watermarked variant, never a download.
// The Worker is a different origin on Hostinger (config.js) and the same one behind the Vercel /api
// proxy and the dev server, so the origin is not part of the test — the path shape is.
function mediaRequest(url) {
  const match = url.pathname.match(/^\/api\/media\/([\w-]+)$/);
  if (!match) return null;
  const variant = url.searchParams.get('variant');
  if (variant !== 'preview' && variant !== 'thumb') return null;
  if (url.searchParams.get('download') === '1') return null;
  return { photoId: match[1], variant };
}

// Signed media links are re-minted every time the page refreshes them, so the token cannot be part of
// the cache key or an offline revisit would miss every photo. Key by search + photo + variant instead.
const galleryKey = (searchId, photoId, variant) => `${self.location.origin}/__soi-media/${encodeURIComponent(searchId)}/${photoId}/${variant}`;

// Kept in memory as well as in the cache, so the common case — a guest with no saved gallery loading a
// page full of previews — costs one cache read per worker lifetime instead of one per photo. The worker
// can be stopped at any moment, which simply makes the next read fall back to the stored copy.
let manifestMemo;   // undefined = not read yet, null = no gallery on this device
async function galleryManifest() {
  if (manifestMemo !== undefined) return manifestMemo;
  const cache = await caches.open(GALLERY_CACHE);
  const stored = await cache.match(GALLERY_MANIFEST);
  manifestMemo = stored ? await stored.json().catch(() => null) : null;
  return manifestMemo;
}

async function putManifest(manifest) {
  const cache = await caches.open(GALLERY_CACHE);
  await cache.put(GALLERY_MANIFEST, new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } }));
  manifestMemo = manifest;
}

async function clearGallery() {
  manifestMemo = null;
  await caches.delete(GALLERY_CACHE);
}

// The page owns the list: a new search id (or a cleared gallery) drops everything cached for the old one.
// `photos` is [{ photoId, variant, url }] — the signed links the page is showing right now. The ids are
// what the fetch handler matches on later (tokens are re-minted, ids are not); the urls are only used to
// warm the cache immediately, because by the time the page can tell us about a tile the browser has
// already fetched its image and will not ask again this visit.
async function rememberGallery(searchId, photos) {
  if (!searchId || !Array.isArray(photos)) return;
  const valid = photos.map(photo => {
    if (!photo || typeof photo.url !== 'string') return null;
    let url; try { url = new URL(photo.url, self.location.origin); } catch { return null; }
    const media = mediaRequest(url);
    return media && media.photoId === photo.photoId ? { ...media, url: url.href } : null;
  }).filter(Boolean).slice(0, GALLERY_LIMIT);
  if (!valid.length) return;
  const current = await galleryManifest();
  if (current && current.searchId !== searchId) await clearGallery();
  const known = current && current.searchId === searchId ? current.photoIds : [];
  const photoIds = [...new Set([...known, ...valid.map(photo => photo.photoId)])].slice(0, GALLERY_LIMIT);
  await putManifest({ searchId, photoIds, savedAt: Date.now() });
  await warmGallery(searchId, valid);
}

// Fetch what is not cached yet. The links are public-cacheable for the life of the token, so this
// normally comes straight out of the browser's own HTTP cache rather than off the network again.
// A cross-origin miss (the Worker is a different origin on Hostinger) is simply skipped: an <img>
// request is `no-cors`, and caching the opaque response it produces would cost megabytes of padded
// quota per photo, so only a real CORS/same-origin response is ever stored.
async function warmGallery(searchId, photos) {
  const cache = await caches.open(GALLERY_CACHE);
  for (const photo of photos) {
    const key = galleryKey(searchId, photo.photoId, photo.variant);
    if (await cache.match(key)) continue;
    try {
      const response = await fetch(photo.url, { mode: 'cors', credentials: 'omit' });
      if (storable(response)) await cache.put(key, response);
    } catch { /* offline, or an origin the Worker does not CORS for: nothing to keep */ }
  }
  await trimGallery();
}

// Keep the cache bounded: Cache Storage keeps insertion order, so the oldest entries go first.
async function trimGallery() {
  const cache = await caches.open(GALLERY_CACHE);
  const keys = (await cache.keys()).filter(request => !request.url.endsWith(GALLERY_MANIFEST));
  for (const request of keys.slice(0, Math.max(0, keys.length - GALLERY_LIMIT))) await cache.delete(request);
}

// Cache-first: a watermarked preview of a given photo never changes, and the point is the offline revisit.
// Only a readable response is kept (see warmGallery on why an opaque one is not), and a photo the page
// never claimed as part of its paid gallery is passed straight through, uncached.
async function galleryFirst(request, media) {
  const manifest = await galleryManifest();
  if (!manifest?.searchId || !manifest.photoIds?.includes(media.photoId)) return fetch(request);
  const key = galleryKey(manifest.searchId, media.photoId, media.variant);
  const cache = await caches.open(GALLERY_CACHE);
  const hit = await cache.match(key);
  if (hit) return hit;
  const response = await fetch(request);
  if (storable(response)) {
    await cache.put(key, response.clone());
    await trimGallery();
  }
  return response;
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (storable(response)) await cache.put(request, response.clone());
  return response;
}

// Serve what we have, refresh in the background. A failed refresh is normal (offline) and never surfaces.
async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request);
  const network = fetch(request).then(response => { if (storable(response)) cache.put(request, response.clone()).catch(() => {}); return response; }).catch(() => null);
  if (hit) return hit;
  const response = await network;
  if (response) return response;
  throw new Error('offline');
}

// HTML must never go stale behind a deploy, so the network wins whenever it answers.
async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (storable(response)) cache.put(request, response.clone()).catch(() => {});
    return response;
  } catch (error) {
    const hit = await cache.match(request) || await cache.match(new URL(request.url).pathname) || (request.mode === 'navigate' ? await cache.match('/index.html') || await cache.match('/') : null);
    if (hit) return hit;
    throw error;
  }
}

// ── fetch ───────────────────────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;                                  // uploads, matches, payments: untouched
  let url;
  try { url = new URL(request.url); } catch { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  const media = mediaRequest(url);
  if (media) {
    // Once the worker knows this device has no saved gallery it stops taking part in photo loading
    // altogether: a guest browsing previews gets exactly the requests they would get with no worker.
    if (manifestMemo === null) return;
    event.respondWith(galleryFirst(request, media));
    return;
  }
  if (url.pathname.startsWith('/api/')) return;                          // every other API call: network, no cache
  if (!isSameOrigin(url)) return;                                        // the Cashfree SDK and any other third party
  if (isAdminPath(url.pathname) && !isAdminShell(url.pathname)) return;  // crew routes other than the studio shell

  if (request.mode === 'navigate' || isHtmlPath(url.pathname)) { event.respondWith(networkFirst(request)); return; }
  if (HASHED.test(url.pathname)) { event.respondWith(cacheFirst(request)); return; }
  if (SHELL_ASSET.test(url.pathname) || url.pathname === '/manifest.webmanifest') { event.respondWith(staleWhileRevalidate(request)); return; }
  // session covers and anything else: straight to the network.
});

// ── messages from the page (pwa.js) ─────────────────────────────────────────────────────────────
self.addEventListener('message', event => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'soi-gallery') event.waitUntil(rememberGallery(data.searchId, data.photos));
  else if (data.type === 'soi-gallery-clear') event.waitUntil(clearGallery());
});

// ── background sync: the crew's interrupted upload batch ────────────────────────────────────────
// Honest limitation: a service worker cannot finish an upload on its own. The crew's `File` objects
// live in the page (IndexedDB keeps the manifest — names, sizes, what is done — not the bytes; the
// File handles a page holds are not transferable to a worker that starts fresh). So the sync handler
// does the one useful thing it can: when the device is back online it wakes every open studio tab and
// asks it to resume, and if none is open the tag simply fires again on the next visit.
self.addEventListener('sync', event => {
  if (event.tag !== UPLOAD_SYNC_TAG) return;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) client.postMessage({ type: 'soi-resume-uploads' });
  })());
});
