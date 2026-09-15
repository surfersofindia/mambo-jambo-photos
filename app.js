'use strict';
const $ = (selector) => document.querySelector(selector);
const apiBase = (window.MJ_CONFIG?.apiUrl || '').replace(/\/$/, '');
let sessions = [], selectedFile = null, previewUrl = null, photos = [], favourites = new Set(), favouritesOnly = false, photoIndex = 0, searchController = null;
const status = (message = '', error = false) => { $('#finderStatus').textContent = message; $('#finderStatus').classList.toggle('error', error); };
async function requestApi(path, options = {}) {
  if (!apiBase) throw new Error('Photo search is not available yet. Please check back soon.');
  const response = await fetch(`${apiBase}${path}`, { ...options, signal: options.signal || AbortSignal.timeout(20000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'We couldn’t complete that request. Please try again.');
  return data;
}
function dateLabel(value) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
function stage(name) {
  for (const value of ['session', 'selfie', 'matching']) $(`#${value}Stage`).hidden = value !== name;
  $('#step1').classList.toggle('active', name === 'session');
  $('#step2').classList.toggle('active', name === 'selfie');
  $('#step3').classList.toggle('active', name === 'matching');
  status();
}
function chooseSession(id) {
  if (searchController) searchController.abort();
  $('#sessionSelect').value = id;
  $('#main').hidden = false; $('#results').hidden = true;
  stage('selfie'); $('#finder').scrollIntoView(); $('#changeSession').focus({ preventScroll: true });
}
async function loadSessions() {
  $('#retrySessions').hidden = true; $('#sessionSelect').disabled = true; $('#nextStep').disabled = true;
  status('Loading available sessions…');
  try {
    const data = await requestApi('/api/sessions');
    if (!Array.isArray(data.sessions)) throw new Error('Sessions could not be loaded. Please try again.');
    sessions = data.sessions;
    $('#sessionSelect').replaceChildren(new Option(sessions.length ? 'Choose your surf session' : 'No sessions published yet', ''));
    for (const session of sessions) $('#sessionSelect').add(new Option(`${dateLabel(session.session_date)} · ${session.title} · ${session.location}`, session.id));
    $('#sessionSelect').disabled = !sessions.length;
    $('#sessionCards').replaceChildren();
    if (!sessions.length) { $('#sessionCards').textContent = 'The next batch of memories is on its way. Check back after your session.'; status('Your crew hasn’t published any sessions yet. Check back soon.'); return; }
    for (const session of sessions.slice(0, 3)) {
      const button = document.createElement('button'); button.className = 'session-card'; button.type = 'button';
      const img = document.createElement('img'); img.src = 'assets/mambo-jambo-surf-session.jpg'; img.alt = 'Mambo Jambo surf school — illustrative session photo'; img.loading = 'lazy';
      const date = document.createElement('small'); date.textContent = dateLabel(session.session_date).toUpperCase();
      const title = document.createElement('h3'); title.textContent = `${session.title} ↗`;
      const location = document.createElement('p'); location.textContent = `${session.location} · Find your photos`;
      button.append(img, date, title, location); button.addEventListener('click', () => chooseSession(session.id)); $('#sessionCards').append(button);
    }
    status();
  } catch (error) {
    $('#sessionSelect').replaceChildren(new Option('Sessions currently unavailable', '')); $('#retrySessions').hidden = false;
    status(error.name === 'TimeoutError' ? 'Loading took too long. Please try again.' : error.message, true);
    $('#sessionCards').textContent = 'We couldn’t load the sessions. Use “Try loading sessions again” above to retry.';
  }
}
$('#retrySessions').addEventListener('click', loadSessions);
$('#sessionSelect').addEventListener('change', () => { $('#nextStep').disabled = !$('#sessionSelect').value; });
$('#nextStep').addEventListener('click', () => chooseSession($('#sessionSelect').value));
$('#changeSession').addEventListener('click', () => { stage('session'); $('#sessionSelect').focus(); });
function updateSubmit() { $('#findMatches').disabled = !selectedFile || !$('#privacyConsent').checked; }
$('#privacyConsent').addEventListener('change', updateSubmit);
$('#selfieInput').addEventListener('change', async (event) => {
  selectedFile = null; updateSubmit(); status();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null; $('#selfiePreview').hidden = true; $('#selfiePreview').removeAttribute('src'); $('#uploadPrompt').hidden = false;
  const file = event.target.files[0]; if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024 || !file.size) { status('Choose a JPG, PNG or WebP image smaller than 10 MB.', true); event.target.value = ''; return; }
  const url = URL.createObjectURL(file); previewUrl = url;
  try {
    const image = new Image(); image.src = url; await image.decode();
    if (previewUrl !== url) return;
    selectedFile = file; $('#selfiePreview').src = url; $('#selfiePreview').hidden = false; $('#uploadPrompt').hidden = true; updateSubmit();
  } catch { if (previewUrl === url) { URL.revokeObjectURL(url); previewUrl = null; status('That image couldn’t be opened. Please choose another photo.', true); } }
});
$('#cancelSearch').addEventListener('click', () => { searchController?.abort(); });
$('#searchForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (searchController || !selectedFile || !$('#privacyConsent').checked || !$('#sessionSelect').value) return;
  stage('matching'); status('Matching your selfie…');
  const controller = new AbortController(); searchController = controller;
  let timedOut = false; const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 90000);
  const form = new FormData(); form.append('sessionId', $('#sessionSelect').value); form.append('file', selectedFile); form.append('consent', 'true');
  try {
    const match = await requestApi('/api/match', { method: 'POST', body: form, signal: controller.signal });
    if (controller.signal.aborted) return;
    if (!Array.isArray(match.previews) || !match.session) throw new Error('The search response was incomplete. Please try again.');
    photos = match.previews.map(photo => {
      const url = new URL(photo.url, apiBase);
      if (url.origin !== new URL(apiBase).origin || !url.pathname.startsWith('/api/media/')) throw new Error('An invalid photo link was returned. Please try again.');
      return { ...photo, url: url.href };
    });
    favourites.clear(); favouritesOnly = false; $('#favouritesFilter').setAttribute('aria-pressed', 'false');
    $('#resultsMeta').textContent = `${dateLabel(match.session.date)} · ${match.session.location} · ${match.session.title}`;
    $('#resultsTitle').textContent = photos.length ? `${photos.length} moments. All yours.` : 'No matches this time.';
    $('#resultsCopy').textContent = photos.length ? 'A little salt, a little sunshine, and you. Tap a photo for a closer look.' : 'Try a brighter selfie without sunglasses, or check that you chose the right session.';
    $('#indexingBanner').textContent = match.indexingNote || ''; $('#indexingBanner').hidden = !match.indexingNote;
    renderGallery(); $('#main').hidden = true; $('#results').hidden = false; stage('selfie'); window.scrollTo(0, 0); $('#resultsTitle').focus();
  } catch (error) { stage('selfie'); status(error.name === 'AbortError' ? (timedOut ? 'The search took too long. Please try again.' : 'Search cancelled. You can try again when you’re ready.') : error.message, error.name !== 'AbortError' || timedOut); }
  finally { clearTimeout(timeout); searchController = null; }
});
function renderGallery() {
  $('#gallery').replaceChildren(); $('#favouriteCount').textContent = favourites.size;
  $('#galleryEmpty').hidden = !favouritesOnly || favourites.size > 0;
  photos.forEach((photo, index) => {
    if (favouritesOnly && !favourites.has(index)) return;
    const figure = document.createElement('figure');
    const open = document.createElement('button'); open.className = 'photo-open'; open.setAttribute('aria-label', `Enlarge photo ${index + 1}`);
    const img = document.createElement('img'); img.src = photo.url; img.alt = `Surf session preview ${index + 1}`; img.loading = 'lazy';
    img.addEventListener('error', () => { img.alt = 'Preview unavailable. Run a new search to refresh expired links.'; });
    open.append(img); open.addEventListener('click', () => openPhoto(index));
    const favourite = document.createElement('button'); favourite.className = 'favourite'; favourite.textContent = favourites.has(index) ? '♥' : '♡'; favourite.setAttribute('aria-label', `Favourite photo ${index + 1}`); favourite.setAttribute('aria-pressed', String(favourites.has(index))); favourite.dataset.index = index;
    favourite.addEventListener('click', () => { favourites.has(index) ? favourites.delete(index) : favourites.add(index); renderGallery(); ($('#gallery').querySelector(`[data-index="${index}"]`) || $('#favouritesFilter')).focus(); });
    const caption = document.createElement('figcaption'); caption.textContent = `MOMENT ${String(index + 1).padStart(2, '0')} · PREVIEW`;
    figure.append(open, favourite, caption); $('#gallery').append(figure);
  });
}
$('#favouritesFilter').addEventListener('click', () => { favouritesOnly = !favouritesOnly; $('#favouritesFilter').setAttribute('aria-pressed', String(favouritesOnly)); renderGallery(); });
function openPhoto(index) { photoIndex = (index + photos.length) % photos.length; $('#lightboxImage').src = photos[photoIndex].url; $('#lightboxCount').textContent = `${photoIndex + 1} of ${photos.length}`; if (!$('#lightbox').open) $('#lightbox').showModal(); }
$('#closeLightbox').addEventListener('click', () => $('#lightbox').close());
$('#previousPhoto').addEventListener('click', () => openPhoto(photoIndex - 1)); $('#nextPhoto').addEventListener('click', () => openPhoto(photoIndex + 1));
$('#lightbox').addEventListener('keydown', event => { if (event.key === 'ArrowLeft') { event.preventDefault(); openPhoto(photoIndex - 1); } if (event.key === 'ArrowRight') { event.preventDefault(); openPhoto(photoIndex + 1); } });
function returnToSearch() { $('#results').hidden = true; $('#main').hidden = false; $('#finder').scrollIntoView(); $('#changeSession').focus({ preventScroll: true }); }
$('#backHome').addEventListener('click', returnToSearch);
document.querySelectorAll('a[href^="#"]').forEach(link => link.addEventListener('click', () => { searchController?.abort(); $('#main').hidden = false; $('#results').hidden = true; }));
window.addEventListener('pagehide', event => { if (!event.persisted && previewUrl) URL.revokeObjectURL(previewUrl); searchController?.abort(); });
loadSessions();
