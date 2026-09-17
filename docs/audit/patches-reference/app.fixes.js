/* ============================================================================
   PUBLIC GALLERY — app.js / effects.js patches
   Each block names the function/lines it replaces in the live app.js.
   Apply in order; they are independent of each other.
   ========================================================================== */

/* ── FIX 1 · Favourite toggle re-renders the whole grid (app.js:354) ───────
   Symptom: tapping ♥ on tile 12 of 40 destroys and rebuilds all 40 <figure>s,
   every thumbnail flashes its shimmer again, scroll position can jump on iOS.
   Replace the favourite click handler with an in-place toggle. */
function toggleFavourite(index, button, figure) {
  const on = !favourites.has(index);
  on ? favourites.add(index) : favourites.delete(index);
  button.textContent = on ? '♥' : '♡';
  button.setAttribute('aria-pressed', String(on));
  $('#favouriteCount').textContent = favourites.size;
  // Only the "favourites only" view needs a structural change, and only for THIS tile.
  if (favouritesOnly && !on) { figure.remove(); $('#galleryEmpty').hidden = favourites.size > 0; }
  // Persist so a refresh (or a UPI redirect) doesn't lose the picks.
  try { sessionStorage.setItem(`mjFav:${currentSearch?.searchId}`, JSON.stringify([...favourites])); } catch {}
}
// in renderGallery(): replace the favourite.addEventListener('click', …) line with
//   favourite.addEventListener('click', () => toggleFavourite(index, favourite, figure));
// and after `favourites.clear()` on a new search (app.js:172) restore:
//   try { JSON.parse(sessionStorage.getItem(`mjFav:${match.searchId}`) || '[]').forEach(i => favourites.add(i)); } catch {}

/* ── FIX 2 · Broken thumbnail shows raw alt text (app.js:348-351) ──────────
   Symptom: expired signed URL → browser paints the alt string across the tile.
   Mark the figure and let CSS (figure.is-broken, soi-tokens.css) show a starfish stamp. */
img.addEventListener('error', () => {
  settle();
  refreshLinks().then(ok => { if (!ok) figure.classList.add('is-broken'); })
                .catch(() => figure.classList.add('is-broken'));
  figure.querySelector('.photo-open').setAttribute('aria-label', `Photo ${index + 1} could not load — tap to retry`);
}, { once: true });
// and in the open click handler, if the figure is broken, retry instead of opening:
//   open.addEventListener('click', () => figure.classList.contains('is-broken')
//     ? (figure.classList.remove('is-broken'), img.src = photo.thumbUrl || photo.url)
//     : openPhoto(index));

/* ── FIX 3 · Zoomed lightbox image cannot be panned (app.js:391) ───────────
   Symptom: tap zooms to 2.2× around the tap point, but pointermove returns early
   while zoomed, so the guest can't see the rest of the frame. Add pan + pinch. */
(() => {
  const stage = $('#lightboxStage'), image = $('#lightboxImage');
  let startX = 0, startY = 0, dragging = false, moved = false;
  let panX = 0, panY = 0, scale = 1, pinchStart = 0, pinchScale = 1;
  const pointers = new Map();
  const apply = () => { image.style.transform = scale > 1 ? `translate(${panX}px,${panY}px) scale(${scale})` : ''; stage.classList.toggle('is-zoomed', scale > 1); };
  const reset = () => { scale = 1; panX = panY = 0; apply(); };
  document.addEventListener('mj:photo', reset);
  stage.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.set(e.pointerId, e); stage.setPointerCapture(e.pointerId);
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinchStart = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); pinchScale = scale; return; }
    dragging = true; moved = false; startX = e.clientX - panX; startY = e.clientY - panY;
  });
  stage.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return; pointers.set(e.pointerId, e);
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; scale = Math.min(4, Math.max(1, pinchScale * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinchStart)); apply(); return; }
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (scale > 1) { moved = true; panX = dx; panY = dy; apply(); return; }            // pan when zoomed
    if (Math.abs(e.clientX - startX) > 8) { moved = true; stage.classList.add('is-sliding'); image.style.transform = `translateX(${e.clientX - startX}px)`; }
  });
  const finish = e => {
    pointers.delete(e.pointerId);
    if (pointers.size) return;
    if (!dragging) return; dragging = false;
    if (scale > 1) { if (!moved && e.type === 'pointerup') reset(); return; }           // tap while zoomed → zoom out
    const dx = e.clientX - startX; stage.classList.remove('is-sliding'); image.style.transform = '';
    if (moved && Math.abs(dx) > 40) { openPhoto(photoIndex + (dx < 0 ? 1 : -1)); return; }
    if (!moved && e.type === 'pointerup') {                                                // tap → zoom to point
      const box = image.getBoundingClientRect(); scale = 2.2;
      panX = (box.width / 2 - (e.clientX - box.left)) * (scale - 1); panY = (box.height / 2 - (e.clientY - box.top)) * (scale - 1); apply();
    }
  };
  stage.addEventListener('pointerup', finish); stage.addEventListener('pointercancel', finish);
  // Belt-and-braces Escape (native <dialog> cancel is enough on real devices, but be explicit).
  $('#lightbox').addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); $('#lightbox').close(); } });
})();
// CSS to pair with it (replace .lightbox-stage.is-zoomed img rule): 
//   .lightbox-stage img{transition:transform var(--duration-slow) var(--ease-spring)}
//   .lightbox-stage.is-zoomed img{cursor:grab} .lightbox-stage.is-sliding img,.lightbox-stage.is-zoomed.is-sliding img{transition:none}

/* ── FIX 4 · Unlock CTA scrolls away on phones ─────────────────────────────
   Add once to index.html just before </footer> (outside #results so it isn't
   hidden with it) and mirror the two controls. soi-tokens.css shows it ≤650px. */
// <div class="soi-actionbar" id="actionBar" hidden>
//   <button class="filter-button" id="favouritesFilterBar" aria-pressed="false">♡ <span id="favouriteCountBar">0</span></button>
//   <button class="button" id="unlockButtonBar" type="button">Unlock all photos <span id="unlockPriceBar"></span></button>
// </div>
function syncActionBar() {
  const bar = $('#actionBar'); if (!bar) return;
  bar.hidden = $('#results').hidden || $('#unlockButton').hidden;      // unlocked or no photos → no bar
  $('#unlockPriceBar').textContent = $('#unlockPrice').textContent;
  $('#favouriteCountBar').textContent = favourites.size;
  $('#favouritesFilterBar').setAttribute('aria-pressed', String(favouritesOnly));
}
$('#unlockButtonBar')?.addEventListener('click', () => $('#unlockButton').click());
$('#favouritesFilterBar')?.addEventListener('click', () => $('#favouritesFilter').click());
// call syncActionBar() at the end of updateCheckoutPanel(), renderGallery(), showResults() and showSearch().

/* ── FIX 5 · Loader is nearly invisible (index.html matchingStage) ─────────
   Replace <div class="loader" aria-hidden="true">…</div> with the wave/fin SVG. */
// <svg class="soi-loader" viewBox="0 0 112 64" aria-hidden="true">
//   <path class="crest" d="M6 44c14-20 28-20 42-2 6-8 14-14 24-16-10 8-16 18-18 30 18-4 34-2 52 6"/>
//   <path class="fin" d="M56 54c0-10-4-18-10-24 8 2 14 10 16 20-2 1-4 3-6 4z"/>
// </svg>

/* ── FIX 6 · Section "flash of empty content" (effects.js:43-58) ───────────
   Symptom: sections are visible, then jump to opacity 0 when the observer fires,
   then fade in — a visible blink on scroll. Pre-hide only when motion is enabled. */
// effects.js, inside applyPreference() after the classList toggles:
//   document.documentElement.classList.toggle('soi-reveal', enabled());
// effects.js, replace `animate(entry.target, rise, { duration: 850 })` with:
//   entry.target.classList.add('is-revealed'); animate(entry.target, rise, { duration: 850, fill: 'backwards' });
// site.css: 
//   html.soi-reveal :is(.section-copy,.finder-card,.section-title,.how-grid article,.session-card,.privacy>div):not(.is-revealed){opacity:0}

/* ── FIX 7 · iOS zoom on the session search box (site.css:153) ─────────────
   `#sessionFilter{font:13px …}` → any focused input under 16px zooms the page.
   soi-tokens.css already forces 16px on all inputs; keep the visual size with
   `font-size:16px;transform-origin:left;` and reduce padding instead. */

/* ── FIX 8 · Step indicator is not navigable ───────────────────────────────
   Make completed steps clickable (01 ← from selfie stage). */
$('#step1').addEventListener('click', () => { if (!$('#selfieStage').hidden) $('#changeSession').click(); });
$('#step1').style.cursor = 'pointer';
