// Progressive-web-app glue for both pages (W4-B): service-worker registration, the offline banner,
// and the bridge that tells the worker which paid-gallery previews may be kept for an offline revisit.
// Loaded `defer` by index.html and admin.html. Everything here is optional: on a browser without
// service workers (or with storage blocked) the banner still works and nothing else happens.
'use strict';
(() => {
  const SW_URL = 'sw.js';
  const GALLERY_KEY = 'mjGallery';          // app.js writes the 30-day gallery record here after /access
  const UPLOAD_SYNC_TAG = 'soi-upload-manifest';
  const banner = document.getElementById('offlineBanner');

  // ── offline banner ────────────────────────────────────────────────────────────────────────────
  // Fixed, so showing it never moves the page (the program's CLS budget is zero). Styles live here
  // rather than in site.css/admin-theme.css so one file carries the whole feature; tokens come from
  // soi-tokens.css, with literal fallbacks in case this ever runs before the stylesheet.
  if (banner) {
    const style = document.createElement('style');
    style.textContent = '#offlineBanner{position:fixed;top:var(--soi-offline-top,0px);left:0;right:0;z-index:45;margin:0;padding:10px 16px;'
      + 'background:var(--soi-linen,#F2ECDB);color:var(--soi-umber,#2B2018);border-bottom:2px solid var(--soi-terracotta,#A8482C);'
      + 'font:500 13px/1.4 var(--sans,system-ui,sans-serif);text-align:center;box-shadow:0 2px 10px #2b201820}'
      + '#offlineBanner[hidden]{display:none}';
    document.head.append(style);
    // It sits just under the sticky header (both pages have one) so it never covers the brand or the
    // menu button, and it is fixed, so showing it moves nothing else on the page.
    const place = () => { const header = document.querySelector('.header, .topbar'); banner.style.setProperty('--soi-offline-top', `${Math.round(header?.getBoundingClientRect().height || 0)}px`); };
    const sync = () => { const offline = navigator.onLine === false; if (offline) place(); banner.hidden = !offline; };
    addEventListener('online', sync); addEventListener('offline', sync);
    addEventListener('resize', () => { if (!banner.hidden) place(); });
    // The 'offline'/'online' events are unreliable across a backgrounded tab: a brief Wi-Fi/cellular
    // handover can fire 'offline' while the tab is hidden and never fire 'online' back once the
    // connection returns, leaving the banner stuck shown on a device that is actually online. Re-check
    // navigator.onLine directly whenever the tab regains focus rather than trusting only the events.
    addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
    addEventListener('pageshow', sync);
    sync();
  }

  // ── service worker ────────────────────────────────────────────────────────────────────────────
  const supported = 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');
  let registration = null;
  const ready = supported
    // Registering after `load` keeps the install-time precache out of the way of the first render.
    ? new Promise(resolve => { if (document.readyState === 'complete') resolve(); else addEventListener('load', resolve, { once: true }); })
      .then(() => navigator.serviceWorker.register(SW_URL))
      .then(reg => { registration = reg; return reg; })
      .catch(() => null)
    : Promise.resolve(null);

  // The worker cannot finish an interrupted upload itself (it has no File handles), so a background
  // sync only wakes the studio tab; admin.js listens for this event and resumes the batch it has.
  if (supported) navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type === 'soi-resume-uploads') dispatchEvent(new CustomEvent('soi-resume-uploads'));
  });

  // `controller` is null on the visit that installs the worker, and a guest may pay on exactly that
  // visit, so the active worker is addressed directly when it is not controlling this page yet: it
  // answers messages either way and fetches the previews itself.
  const post = message => ready
    .then(reg => navigator.serviceWorker?.controller || reg?.active || navigator.serviceWorker.ready.then(active => active.active))
    .then(worker => { if (worker) worker.postMessage(message); return Boolean(worker); })
    .catch(() => false);

  // ── paid-gallery previews ─────────────────────────────────────────────────────────────────────
  // Only the previews and thumbs of the search this device holds a 30-day gallery token for are
  // allowed into the cache — never an original, never an unpaid search, never a crew image.
  const savedGallery = () => { try { return JSON.parse(localStorage.getItem(GALLERY_KEY) || 'null'); } catch { return null; } };
  const cacheable = src => { try { const url = new URL(src, location.href); return /^\/api\/media\/[\w-]+$/.test(url.pathname) && ['preview', 'thumb'].includes(url.searchParams.get('variant')) && url.searchParams.get('download') !== '1'; } catch { return false; } };

  function syncGallery() {
    const gallery = document.getElementById('gallery');
    const unlockedNotice = document.getElementById('unlockedNotice');
    const saved = savedGallery();
    // No saved token, or these results are not that paid gallery: leave the cache alone.
    if (!gallery || !saved?.searchId || !saved?.token || unlockedNotice?.hidden !== false) return;
    // The worker is given the live signed links as well as the ids: by the time this runs the browser
    // has already fetched each tile, so the worker warms its cache itself instead of waiting for a
    // request that will not come again this visit. It keys the entries by id, which outlives the token.
    const photos = [...gallery.querySelectorAll('figure[data-photo-id]')].map(figure => {
      const img = figure.querySelector('img');
      const src = img && (img.currentSrc || img.src);
      return src && cacheable(src) ? { photoId: figure.dataset.photoId, url: new URL(src, location.href).href } : null;
    }).filter(Boolean);
    if (photos.length) post({ type: 'soi-gallery', searchId: saved.searchId, photos });
  }

  // app.js re-renders #gallery wholesale (favourites filter, link refresh, a hidden photo), so the
  // list is re-read whenever the grid changes rather than hooked into any of its functions.
  const gallery = document.getElementById('gallery');
  if (gallery && supported) {
    let pending = 0;
    const schedule = () => { clearTimeout(pending); pending = setTimeout(syncGallery, 400); };
    new MutationObserver(schedule).observe(gallery, { childList: true });
    ready.then(() => { if (registration) schedule(); });
    // A gallery record that expires or is cleared (app.js drops it on an expired link) takes its cache with it.
    addEventListener('pageshow', () => { if (!savedGallery()) post({ type: 'soi-gallery-clear' }); });
  }

  // ── the crew's interrupted upload batch ───────────────────────────────────────────────────────
  // admin.js (W4-A) keeps a manifest of the batch in the IndexedDB database `soi-uploads`. When the
  // studio goes offline with such a manifest on the device, a background-sync tag is registered so the
  // browser wakes the tab as soon as the connection is back — the worker itself cannot resume an
  // upload (it holds no File objects), it only sends the page a "resume" message.
  // The database is only ever *probed*, never opened: `indexedDB.open` on a missing name would create
  // an empty database at version 1 and admin.js's own upgrade would then never run.
  async function uploadManifestExists() {
    try { return typeof indexedDB?.databases === 'function' && (await indexedDB.databases()).some(db => db.name === 'soi-uploads'); }
    catch { return false; }
  }
  if (supported && document.getElementById('uploadForm')) {
    addEventListener('offline', async () => { if (await uploadManifestExists()) window.SOIPWA.requestUploadSync(); });
  }

  // ── small public API ──────────────────────────────────────────────────────────────────────────
  // requestUploadSync(): admin.js (W4-A) calls this when a batch stalls offline; the browser fires the
  // worker's `sync` event once connectivity is back and the worker asks the page to resume. Returns
  // false where Background Sync is unavailable (Safari, Firefox) — the caller keeps its own retry.
  window.SOIPWA = {
    ready,
    async requestUploadSync() {
      try {
        const reg = await ready;
        if (!reg?.sync) return false;
        await reg.sync.register(UPLOAD_SYNC_TAG);
        return true;
      } catch { return false; }
    },
    // cacheGallery(searchId, [{ photoId, url }]): app.js can call this straight after /access instead of
    // waiting for the grid observer; the worker keeps only preview/thumb links of that search.
    cacheGallery: (searchId, photos) => post({ type: 'soi-gallery', searchId, photos }),
    clearGallery: () => post({ type: 'soi-gallery-clear' }),
  };
})();
