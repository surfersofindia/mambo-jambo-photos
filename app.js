'use strict';
const $ = (selector) => document.querySelector(selector);
const apiBase = (window.MJ_CONFIG?.apiUrl || '').replace(/\/$/, '');
let selectedSessionId = '';
let sessions = [], selectedFile = null, previewUrl = null, photos = [], favourites = new Set(), favouritesOnly = false, photoIndex = 0, searchController = null;
let currentSearch = null, unlocked = false, paying = false;
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
  $('#privacyConsent').disabled = name !== 'selfie';
  for (const value of ['session', 'selfie', 'matching']) $(`#${value}Stage`).hidden = value !== name;
  $('#step1').classList.toggle('active', name === 'session');
  $('#step2').classList.toggle('active', name === 'selfie');
  $('#step3').classList.toggle('active', name === 'matching');
  status();
  document.dispatchEvent(new CustomEvent('mj:stage', { detail: name }));
}
function chooseSession(id) {
  if (searchController) searchController.abort();
  const session = sessions.find(item => item.id === id);
  if (!session) return;
  selectSession(id);
  $('#main').hidden = false; $('#results').hidden = true;
  stage('selfie'); $('#finder').scrollIntoView(); $('#changeSession').focus({ preventScroll: true });
}
function selectSession(id) {
  const session = sessions.find(item => item.id === id);
  if (!session) return;
  selectedSessionId = id;
  document.querySelectorAll('input[name="surfSession"]').forEach(input => { input.checked = input.value === id; });
  $('#nextStep').disabled = false;
  $('#nextStep').replaceChildren(document.createTextNode('Continue with this session '));
  const arrow = document.createElement('span'); arrow.textContent = '→'; $('#nextStep').append(arrow);
  $('#selectedSessionSummary').textContent = `${session.title} · ${dateLabel(session.session_date)} · ${session.location}`;
}
function renderSessionChoices() {
  const list = $('#sessionChoices'); list.replaceChildren();
  sessions.forEach((session, index) => {
    const label = document.createElement('label'); label.className = 'session-choice';
    label.dataset.search = `${session.title} ${session.location} ${session.session_date} ${dateLabel(session.session_date)}`.toLowerCase();
    const input = document.createElement('input'); input.type = 'radio'; input.name = 'surfSession'; input.value = session.id; input.checked = session.id === selectedSessionId;
    input.addEventListener('change', () => selectSession(session.id));
    const date = new Date(`${session.session_date}T12:00:00`);
    const badge = document.createElement('span'); badge.className = 'session-date'; badge.setAttribute('aria-hidden', 'true');
    const month = document.createElement('small'); month.textContent = Number.isNaN(date.getTime()) ? 'SURF' : date.toLocaleDateString('en-IN', { month: 'short' });
    const day = document.createElement('strong'); day.textContent = Number.isNaN(date.getTime()) ? '〰' : String(date.getDate()).padStart(2, '0'); badge.append(month, day);
    const copy = document.createElement('span'); copy.className = 'session-choice-copy';
    const title = document.createElement('strong'); title.textContent = session.title;
    const detail = document.createElement('span'); detail.textContent = `${dateLabel(session.session_date)} · ${session.location}`;
    copy.append(title, detail);
    if (index === 0) { const recent = document.createElement('small'); recent.className = 'session-recent'; recent.textContent = 'Latest session'; copy.append(recent); }
    const check = document.createElement('span'); check.className = 'session-check'; check.setAttribute('aria-hidden', 'true'); check.textContent = '✓';
    label.append(input, badge, copy, check); list.append(label);
  });
  $('#sessionFilterWrap').hidden = sessions.length <= 4;
  $('#sessionFilter').value = ''; $('#sessionNoResults').hidden = true;
}
async function loadSessions() {
  $('#retrySessions').hidden = true; $('#sessionPicker').disabled = true; $('#nextStep').disabled = true; $('#sessionChoices').setAttribute('aria-busy', 'true');
  status('Loading available sessions…');
  try {
    const data = await requestApi('/api/sessions');
    if (!Array.isArray(data.sessions)) throw new Error('Sessions could not be loaded. Please try again.');
    sessions = data.sessions;
    selectedSessionId = '';
    renderSessionChoices();
    $('#sessionPicker').disabled = !sessions.length;
    $('#sessionCards').replaceChildren();
    if (!sessions.length) { $('#sessionChoices').textContent = 'Your next surf session will appear here once the crew publishes it.'; $('#sessionCards').textContent = 'The next batch of memories is on its way. Check back after your session.'; status('Your crew hasn’t published any sessions yet. Check back soon.'); return; }
    for (const session of sessions.slice(0, 3)) {
      const button = document.createElement('button'); button.className = 'session-card'; button.type = 'button';
      const img = document.createElement('img'); img.src = 'assets/soi-waves.svg'; img.alt = 'Surfers of India — illustrated waves'; img.loading = 'lazy';
      const date = document.createElement('small'); date.textContent = dateLabel(session.session_date).toUpperCase();
      const title = document.createElement('h3'); title.textContent = `${session.title} ↗`;
      const location = document.createElement('p'); location.textContent = `${session.location} · Find your photos`;
      button.append(img, date, title, location); button.addEventListener('click', () => chooseSession(session.id)); $('#sessionCards').append(button);
    }
    document.dispatchEvent(new Event('mj:sessions'));
    status();
  } catch (error) {
    $('#sessionChoices').textContent = 'We couldn’t load your sessions.'; $('#retrySessions').hidden = false;
    status(error.name === 'TimeoutError' ? 'Loading took too long. Please try again.' : error.message, true);
    $('#sessionCards').textContent = 'We couldn’t load the sessions. Use “Try loading sessions again” above to retry.';
  } finally { $('#sessionChoices').setAttribute('aria-busy', 'false'); }
}
$('#retrySessions').addEventListener('click', loadSessions);
$('#sessionFilter').addEventListener('input', event => {
  const query = event.target.value.trim().toLowerCase();
  let visible = 0;
  document.querySelectorAll('.session-choice').forEach(choice => { choice.hidden = !choice.dataset.search.includes(query); if (!choice.hidden) visible++; });
  $('#sessionNoResults').hidden = visible !== 0;
});
$('#nextStep').addEventListener('click', () => chooseSession(selectedSessionId));
$('#changeSession').addEventListener('click', () => { stage('session'); $('#sessionFilter').value = ''; $('#sessionFilter').dispatchEvent(new Event('input'));
  const input = $('#sessionChoices').querySelector('input:checked') || $('#sessionChoices').querySelector('input');
  input?.focus(); });
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
  if (!$('#sessionStage').hidden) { if (selectedSessionId) chooseSession(selectedSessionId); return; }
  if (searchController || !selectedFile || !$('#privacyConsent').checked || !selectedSessionId) return;
  stage('matching'); status('Matching your selfie…');
  const controller = new AbortController(); searchController = controller;
  let timedOut = false; const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 90000);
  const form = new FormData(); form.append('sessionId', selectedSessionId); form.append('file', selectedFile); form.append('consent', 'true');
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
    unlocked = false;
    currentSearch = (match.searchId && match.token) ? { searchId: match.searchId, token: match.token, pricePaise: match.pricePaise, currency: match.currency } : null;
    $('#resultsMeta').textContent = `${dateLabel(match.session.date)} · ${match.session.location} · ${match.session.title}`;
    $('#resultsTitle').textContent = photos.length ? `${photos.length} moments. All yours.` : 'No matches this time.';
    $('#resultsCopy').textContent = photos.length ? 'A little salt, a little sunshine, and you. Tap a photo for a closer look.' : 'Try a brighter selfie without sunglasses, or check that you chose the right session.';
    $('#indexingBanner').textContent = match.indexingNote || ''; $('#indexingBanner').hidden = !match.indexingNote;
    updateCheckoutPanel();
    renderGallery(); $('#main').hidden = true; $('#results').hidden = false; stage('selfie'); window.scrollTo(0, 0); $('#resultsTitle').focus();
  } catch (error) { stage('selfie'); status(error.name === 'AbortError' ? (timedOut ? 'The search took too long. Please try again.' : 'Search cancelled. You can try again when you’re ready.') : error.message, error.name !== 'AbortError' || timedOut); }
  finally { clearTimeout(timeout); searchController = null; }
});
function formatRupees(paise, currency) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR', maximumFractionDigits: 0 }).format((paise || 0) / 100);
}
function checkoutStatusMsg(message = '', error = false) { $('#checkoutStatus').textContent = message; $('#checkoutStatus').classList.toggle('error', error); }
function updateCheckoutPanel() {
  const canUnlock = photos.length > 0 && Number(currentSearch?.pricePaise) > 0;
  $('#unlockButton').hidden = !canUnlock || unlocked;
  $('#checkoutNotice').hidden = unlocked;
  $('#unlockedNotice').hidden = !unlocked;
  if (currentSearch?.pricePaise) {
    const amount = formatRupees(currentSearch.pricePaise, currentSearch.currency);
    $('#unlockPrice').textContent = amount; $('#payAmount').textContent = amount;
  }
}
function applyUnlockedPhotos(unlockedPhotos) {
  const valid = unlockedPhotos.filter(photo => photo?.photoId && photo?.url);
  if (photos.length) {
    const byId = new Map(valid.map(photo => [photo.photoId, photo.url]));
    photos = photos.map(photo => ({ ...photo, url: byId.get(photo.photoId) || photo.url }));
  } else {
    photos = valid.map(photo => ({ photoId: photo.photoId, url: photo.url }));
  }
  unlocked = true;
  updateCheckoutPanel(); renderGallery();
}
async function confirmPayment(orderId) {
  const result = await requestApi('/api/payment/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ searchId: currentSearch.searchId, token: currentSearch.token, orderId }) });
  if (!Array.isArray(result.photos)) throw new Error('Payment confirmed, but photos could not be loaded. Contact the crew with your payment details.');
  applyUnlockedPhotos(result.photos);
  sessionStorage.removeItem('mjCheckout');
}
$('#unlockButton').addEventListener('click', () => { checkoutStatusMsg(); $('#checkoutDialog').showModal(); });
$('#cancelCheckout').addEventListener('click', () => $('#checkoutDialog').close());
$('#checkoutForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (paying || !currentSearch) return;
  const phone = $('#checkoutPhone').value.trim();
  const email = $('#checkoutEmail').value.trim();
  if (!/^[6-9]\d{9}$/.test(phone)) { checkoutStatusMsg('Enter a valid 10-digit mobile number.', true); return; }
  paying = true; $('#payButton').disabled = true; checkoutStatusMsg('Creating your payment…');
  try {
    const order = await requestApi('/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ searchId: currentSearch.searchId, token: currentSearch.token, phone, email: email || undefined }) });
    if (!order.paymentSessionId || !window.Cashfree) throw new Error('Payment could not start. Please refresh and try again.');
    sessionStorage.setItem('mjCheckout', JSON.stringify({ searchId: currentSearch.searchId, token: currentSearch.token }));
    const cashfree = window.Cashfree({ mode: order.mode === 'production' ? 'production' : 'sandbox' });
    const result = await cashfree.checkout({ paymentSessionId: order.paymentSessionId, redirectTarget: '_modal' });
    if (result?.error) { checkoutStatusMsg('Payment was not completed. You can try again.', true); return; }
    checkoutStatusMsg('Confirming your payment…');
    await confirmPayment(order.orderId);
    $('#checkoutDialog').close();
  } catch (error) { checkoutStatusMsg(error.message, true); }
  finally { paying = false; $('#payButton').disabled = false; }
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
    const caption = document.createElement('figcaption'); caption.textContent = `MOMENT ${String(index + 1).padStart(2, '0')} · ${unlocked ? 'ORIGINAL' : 'PREVIEW'}`;
    figure.append(open, favourite, caption); $('#gallery').append(figure);
  });
}
$('#favouritesFilter').addEventListener('click', () => { favouritesOnly = !favouritesOnly; $('#favouritesFilter').setAttribute('aria-pressed', String(favouritesOnly)); renderGallery(); });
function openPhoto(index) { photoIndex = (index + photos.length) % photos.length; $('#lightboxImage').src = photos[photoIndex].url; $('#lightboxCount').textContent = `${photoIndex + 1} of ${photos.length}`; if (!$('#lightbox').open) $('#lightbox').showModal(); document.dispatchEvent(new Event('mj:photo')); }
$('#closeLightbox').addEventListener('click', () => $('#lightbox').close());
$('#previousPhoto').addEventListener('click', () => openPhoto(photoIndex - 1)); $('#nextPhoto').addEventListener('click', () => openPhoto(photoIndex + 1));
$('#lightbox').addEventListener('keydown', event => { if (event.key === 'ArrowLeft') { event.preventDefault(); openPhoto(photoIndex - 1); } if (event.key === 'ArrowRight') { event.preventDefault(); openPhoto(photoIndex + 1); } });
function returnToSearch() { $('#results').hidden = true; $('#main').hidden = false; $('#finder').scrollIntoView(); $('#changeSession').focus({ preventScroll: true }); }
$('#backHome').addEventListener('click', returnToSearch);
document.querySelectorAll('a[href^="#"]').forEach(link => link.addEventListener('click', () => { searchController?.abort(); $('#main').hidden = false; $('#results').hidden = true; }));
window.addEventListener('pagehide', event => { if (!event.persisted && previewUrl) URL.revokeObjectURL(previewUrl); searchController?.abort(); });
async function resumeCheckoutFromRedirect() {
  const orderId = new URLSearchParams(location.search).get('cfOrder');
  if (!orderId) return;
  history.replaceState(null, '', location.pathname + location.hash);
  const stored = sessionStorage.getItem('mjCheckout');
  if (!stored) return;
  try {
    const { searchId, token } = JSON.parse(stored);
    if (!searchId || !token) return;
    currentSearch = { searchId, token };
    photos = [];
    $('#resultsMeta').textContent = ''; $('#resultsTitle').textContent = 'Confirming your payment…'; $('#resultsCopy').textContent = '';
    $('#main').hidden = true; $('#results').hidden = false; window.scrollTo(0, 0);
    await confirmPayment(orderId);
    $('#resultsTitle').textContent = 'Payment received.'; $('#resultsCopy').textContent = 'These are your original, watermark-free photos.';
  } catch (error) { $('#resultsCopy').textContent = error.message; }
}
resumeCheckoutFromRedirect();
loadSessions();
