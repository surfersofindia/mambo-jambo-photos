'use strict';
const $ = (selector) => document.querySelector(selector);
const apiBase = (window.MJ_CONFIG?.apiUrl || '').replace(/\/$/, '');
let selectedSessionId = '';
let sessions = [], selectedFile = null, previewUrl = null, photos = [], favourites = new Set(), favouritesOnly = false, photoIndex = 0, searchController = null;
let currentSearch = null, unlocked = false, paying = false, refreshTimer = null, lastRefresh = 0;
const GALLERY_KEY = 'mjGallery';
// Every photo link must point at this API's /api/media/ path — anything else is dropped.
function mediaUrl(value) {
  if (!value) return null;
  const url = new URL(value, apiBase);
  if (url.origin !== new URL(apiBase).origin || !url.pathname.startsWith('/api/media/')) throw new Error('Bad photo link. Try again?');
  return url.href;
}
function normalisePhoto(photo) {
  const url = mediaUrl(photo.url);
  return { ...photo, url, thumbUrl: photo.thumbUrl ? mediaUrl(photo.thumbUrl) : url, downloadUrl: photo.downloadUrl ? mediaUrl(photo.downloadUrl) : null };
}
const status = (message = '', error = false) => { $('#finderStatus').textContent = message; $('#finderStatus').classList.toggle('error', error); };
async function requestApi(path, options = {}) {
  if (!apiBase) throw new Error('Photo search is down right now. Back soon.');
  const response = await fetch(`${apiBase}${path}`, { ...options, signal: options.signal || AbortSignal.timeout(20000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'That didn’t work. Try again?');
  return data;
}
function dateLabel(value) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
function stage(name) {
  $('#privacyConsent').disabled = name !== 'selfie';
  for (const value of ['session', 'selfie', 'matching']) $(`#${value}Stage`).hidden = value !== name;
  [['#step1', 'session'], ['#step2', 'selfie'], ['#step3', 'matching']].forEach(([selector, value]) => {
    $(selector).classList.toggle('active', name === value);
    if (name === value) $(selector).setAttribute('aria-current', 'step'); else $(selector).removeAttribute('aria-current');
  });
  // Step 01 doubles as a "change session" shortcut, but only once the selfie stage is showing.
  if (name === 'selfie') $('#step1').tabIndex = 0; else $('#step1').removeAttribute('tabindex');
  $('#step1').style.cursor = name === 'selfie' ? 'pointer' : '';
  status();
  document.dispatchEvent(new CustomEvent('mj:stage', { detail: name }));
}
// The results view is a separate "page": push a history entry so the browser Back button returns
// to the finder instead of leaving the site, and popstate restores whichever view the entry names.
function showResults() {
  $('#main').hidden = true; $('#results').hidden = false;
  if (history.state?.view !== 'results') history.pushState({ view: 'results' }, '', location.pathname + location.search);
  window.scrollTo(0, 0); $('#resultsTitle').focus(); syncActionBar();
}
function showSearch({ scroll = true } = {}) {
  $('#results').hidden = true; $('#main').hidden = false;
  if (history.state?.view === 'results') history.replaceState({ view: 'search' }, '', location.pathname + location.search);
  if (scroll) { $('#finder').scrollIntoView(); $('#changeSession').focus({ preventScroll: true }); }
  syncActionBar();
}
window.addEventListener('popstate', event => {
  if ($('#lightbox').open) $('#lightbox').close();
  if (event.state?.view === 'results' && photos.length) { $('#main').hidden = true; $('#results').hidden = false; window.scrollTo(0, 0); }
  else { $('#results').hidden = true; $('#main').hidden = false; }
  syncActionBar();
});
function chooseSession(id) {
  if (searchController) searchController.abort();
  const session = sessions.find(item => item.id === id);
  if (!session) return;
  selectSession(id);
  showSearch({ scroll: false });
  stage('selfie'); $('#finder').scrollIntoView(); $('#changeSession').focus({ preventScroll: true });
}
function selectSession(id) {
  const session = sessions.find(item => item.id === id);
  if (!session) return;
  selectedSessionId = id;
  document.querySelectorAll('input[name="surfSession"]').forEach(input => { input.checked = input.value === id; });
  $('#nextStep').disabled = false;
  $('#nextStep').replaceChildren(document.createTextNode('That’s the one '));
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
    if (index === 0) { const recent = document.createElement('small'); recent.className = 'session-recent'; recent.textContent = 'Latest'; copy.append(recent); }
    const check = document.createElement('span'); check.className = 'session-check'; check.setAttribute('aria-hidden', 'true'); check.textContent = '✓';
    label.append(input, badge, copy, check); list.append(label);
  });
  $('#sessionFilterWrap').hidden = sessions.length <= 4;
  $('#sessionFilter').value = ''; $('#sessionNoResults').hidden = true;
}
async function loadSessions() {
  $('#retrySessions').hidden = true; $('#sessionPicker').disabled = true; $('#nextStep').disabled = true; $('#sessionChoices').setAttribute('aria-busy', 'true');
  status('Loading sessions…');
  try {
    const data = await requestApi('/api/sessions');
    if (!Array.isArray(data.sessions)) throw new Error('Sessions came back broken. Try again?');
    sessions = data.sessions;
    selectedSessionId = '';
    renderSessionChoices();
    $('#sessionPicker').disabled = !sessions.length;
    $('#sessionCards').replaceChildren();
    if (!sessions.length) { $('#sessionChoices').textContent = 'Nothing published yet.'; $('#sessionCards').textContent = 'Next session drops after the next swell.'; status('Nothing published yet. Check back after your surf.'); return; }
    for (const session of sessions.slice(0, 3)) {
      const button = document.createElement('button'); button.className = 'session-card'; button.type = 'button';
      const img = document.createElement('img'); img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.width = 640; img.height = 220;
      let cover = null; try { cover = session.coverUrl ? mediaUrl(session.coverUrl) : null; } catch { cover = null; }
      img.src = cover || 'assets/soi-waves.svg';
      img.addEventListener('error', () => { img.src = 'assets/soi-waves.svg'; }, { once: true });
      const date = document.createElement('small'); date.textContent = dateLabel(session.session_date).toUpperCase();
      const title = document.createElement('h3'); title.textContent = session.title;
      const location = document.createElement('p'); location.textContent = session.location;
      button.append(img, date, title, location); button.addEventListener('click', () => chooseSession(session.id)); $('#sessionCards').append(button);
    }
    document.dispatchEvent(new Event('mj:sessions'));
    status();
  } catch (error) {
    $('#sessionChoices').textContent = 'Sessions didn’t load.'; $('#retrySessions').hidden = false;
    status(error.name === 'TimeoutError' ? 'Took too long. Try again?' : error.message, true);
    $('#sessionCards').textContent = 'Sessions didn’t load — hit Try again above.';
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
const step1Back = () => { if (!$('#selfieStage').hidden) $('#changeSession').click(); };
$('#step1').addEventListener('click', step1Back);
$('#step1').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); step1Back(); } });
function updateSubmit() { $('#findMatches').disabled = !selectedFile || !$('#privacyConsent').checked; }
$('#privacyConsent').addEventListener('change', updateSubmit);
// On phones, offer the camera directly; the attribute is removed again so "Choose a selfie" keeps
// opening the photo library.
$('#takeSelfie').addEventListener('click', () => { const input = $('#selfieInput'); input.setAttribute('capture', 'user'); input.click(); setTimeout(() => input.removeAttribute('capture'), 1000); });
// Phone selfies are often 4–10 MB; the matcher only needs ~1500 px, so shrink before uploading.
// Falls back to the original file if the canvas step fails (e.g. a decoder quirk).
async function downscaleSelfie(file, image) {
  const MAX = 1600, longest = Math.max(image.naturalWidth, image.naturalHeight);
  if (!longest || (longest <= MAX && file.size <= 1.5 * 1024 * 1024)) return file;
  try {
    const scale = Math.min(1, MAX / longest);
    const canvas = document.createElement('canvas'); canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .88));
    if (!blob || !blob.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch { return file; }
}
$('#selfieInput').addEventListener('change', async (event) => {
  selectedFile = null; updateSubmit(); status();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null; $('#selfiePreview').hidden = true; $('#selfiePreview').removeAttribute('src'); $('#uploadPrompt').hidden = false;
  const file = event.target.files[0]; if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024 || !file.size) { status('JPG, PNG or WebP under 10 MB.', true); event.target.value = ''; return; }
  const url = URL.createObjectURL(file); previewUrl = url;
  try {
    const image = new Image(); image.src = url; await image.decode();
    if (previewUrl !== url) return;
    selectedFile = await downscaleSelfie(file, image);
    if (previewUrl !== url) return;
    $('#selfiePreview').src = url; $('#selfiePreview').hidden = false; $('#uploadPrompt').hidden = true; updateSubmit(); window.SOI?.haptic?.([20]);
  } catch { if (previewUrl === url) { URL.revokeObjectURL(url); previewUrl = null; status('Couldn’t open that one. Try another.', true); } }
});
// "12 waves. All you." — the count is its own element so the hand-drawn underline has something to sit under. Built
// from nodes, never markup; the underline is drawn a frame later so the results view is on screen when it measures.
function setResultsTitle(count) {
  const number = document.createElement('b'); number.className = 'soi-underline'; number.textContent = String(count);
  $('#resultsTitle').replaceChildren(number, document.createTextNode(` wave${count === 1 ? '' : 's'}. All you.`));
  requestAnimationFrame(() => window.SOI?.underline?.(number));
}
$('#cancelSearch').addEventListener('click', () => { searchController?.abort(); });
$('#searchForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!$('#sessionStage').hidden) { if (selectedSessionId) chooseSession(selectedSessionId); return; }
  if (searchController || !selectedFile || !$('#privacyConsent').checked || !selectedSessionId) return;
  // Keep the card the same height while matching so the stage swap doesn't shift the page.
  $('#matchingStage').style.setProperty('--stage-h', `${$('#selfieStage').offsetHeight}px`);
  stage('matching'); status('Scanning…');
  const controller = new AbortController(); searchController = controller;
  let timedOut = false; const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 90000);
  const form = new FormData(); form.append('sessionId', selectedSessionId); form.append('file', selectedFile); form.append('consent', 'true');
  try {
    const match = await requestApi('/api/match', { method: 'POST', body: form, signal: controller.signal });
    if (controller.signal.aborted) return;
    if (!Array.isArray(match.previews) || !match.session) throw new Error('Something came back broken. Go again?');
    photos = match.previews.map(normalisePhoto);
    favourites.clear(); favouritesOnly = false; $('#favouritesFilter').setAttribute('aria-pressed', 'false');
    unlocked = false;
    currentSearch = (match.searchId && match.token) ? { searchId: match.searchId, token: match.token, pricePaise: match.pricePaise, currency: match.currency } : null;
    restoreFavourites();
    $('#resultsMeta').textContent = `${dateLabel(match.session.date)} · ${match.session.location} · ${match.session.title}`;
    if (photos.length) setResultsTitle(photos.length); else $('#resultsTitle').textContent = 'No waves with your face in them.';
    $('#resultsCopy').textContent = photos.length ? 'Tap one to get closer.' : 'Brighter selfie, no sunnies — or check the session.';
    $('#indexingBanner').textContent = match.indexingNote || ''; $('#indexingBanner').hidden = !match.indexingNote;
    updateCheckoutPanel();
    renderGallery(); stage('selfie'); showResults(); scheduleLinkRefresh();
    if (photos.length) window.SOI?.splash?.({ at: $('#resultsTitle'), symbol: 'stamp-hibiscus', count: 6 });
  } catch (error) { stage('selfie'); status(error.name === 'AbortError' ? (timedOut ? 'That took too long. Go again?' : 'Stopped. Whenever you’re ready.') : error.message, error.name !== 'AbortError' || timedOut); }
  finally { clearTimeout(timeout); searchController = null; $('#matchingStage').style.removeProperty('--stage-h'); }
});
function formatRupees(paise, currency) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR', maximumFractionDigits: 0 }).format((paise || 0) / 100);
}
function checkoutStatusMsg(message = '', error = false) { $('#checkoutStatus').textContent = message; $('#checkoutStatus').classList.toggle('error', error); }
// The ZIP of every original. The token is whichever the API handed back last — the search token right after payment,
// the long-lived gallery token once refreshLinks() has swapped it in — so the link is rebuilt every time the panel updates.
const downloadAllUrl = () => currentSearch?.searchId && currentSearch.token ? `${apiBase}/api/searches/${encodeURIComponent(currentSearch.searchId)}/download?token=${encodeURIComponent(currentSearch.token)}` : null;
function updateCheckoutPanel() {
  const canUnlock = photos.length > 0 && Number(currentSearch?.pricePaise) > 0;
  $('#unlockButton').hidden = !canUnlock || unlocked;
  $('#checkoutNotice').hidden = unlocked;
  $('#unlockedNotice').hidden = !unlocked;
  const zip = unlocked && photos.length ? downloadAllUrl() : null, all = $('#downloadAll');
  if (all) { all.hidden = !zip; all.href = zip || '#'; }
  // The count lives in the title; only the text node in front of the #unlockPrice span is (re)written.
  const label = 'Unlock all photos · ', first = $('#unlockButton').firstChild;
  if (first?.nodeType === Node.TEXT_NODE) first.data = label; else $('#unlockButton').prepend(label);
  if (currentSearch?.pricePaise) {
    const amount = formatRupees(currentSearch.pricePaise, currentSearch.currency);
    $('#unlockPrice').textContent = amount; $('#payAmount').textContent = amount;
  }
  syncActionBar();
}
// Where the unlock button sits before it disappears — the sticky bar's copy on phones, the in-page one elsewhere. A
// redirect return has neither on screen yet, so the burst lands on the title instead.
function unlockAnchor() {
  for (const button of [$('#unlockButton'), $('#unlockButtonBar')]) { const box = button?.getBoundingClientRect(); if (box?.width && box?.height) return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; }
  return $('#resultsTitle');
}
// `celebrate` is set only straight after a payment — never for the 30-day resume or a link refresh.
function applyUnlockedPhotos(unlockedPhotos, { celebrate = false } = {}) {
  const at = celebrate ? unlockAnchor() : null;
  const valid = unlockedPhotos.filter(photo => photo?.photoId && photo?.url).map(normalisePhoto);
  if (photos.length) {
    const byId = new Map(valid.map(photo => [photo.photoId, photo]));
    photos = photos.map(photo => { const fresh = byId.get(photo.photoId); return fresh ? { ...photo, url: fresh.url, thumbUrl: fresh.thumbUrl || fresh.url, downloadUrl: fresh.downloadUrl } : photo; });
  } else {
    photos = valid;
  }
  unlocked = true;
  updateCheckoutPanel(); renderGallery(); scheduleLinkRefresh();
  // Next frame, so the burst paints after the checkout dialog (top layer) has closed.
  if (at) requestAnimationFrame(() => window.SOI?.splash?.({ at, symbol: 'stamp-sunburst', count: 12 }));
}
// Signed photo links expire (previews with the search, originals sooner). Instead of telling a
// guest to "search again", ask the API for fresh links — for a paid gallery this is what keeps
// the photos reachable, and it also hands back a long-lived token we keep for 30 days.
async function refreshLinks() {
  if (!currentSearch?.searchId || !currentSearch.token || Date.now() - lastRefresh < 15000) return false;
  lastRefresh = Date.now();
  const path = unlocked ? 'access' : 'previews';
  const result = await requestApi(`/api/searches/${encodeURIComponent(currentSearch.searchId)}/${path}?token=${encodeURIComponent(currentSearch.token)}`);
  if (!Array.isArray(result.photos)) return false;
  if (unlocked) { if (result.galleryToken) currentSearch.token = result.galleryToken; applyUnlockedPhotos(result.photos); saveGallery(result.session); }
  else { const byId = new Map(result.photos.map(photo => [photo.photoId, normalisePhoto(photo)])); photos = photos.map(photo => byId.get(photo.photoId) || photo); renderGallery(); scheduleLinkRefresh(); }
  return true;
}
function scheduleLinkRefresh() {
  clearTimeout(refreshTimer);
  if (!currentSearch?.searchId) return;
  // Originals are signed for 30 minutes, previews for the life of the search (45); refresh a little early.
  refreshTimer = setTimeout(() => { refreshLinks().catch(() => {}); }, (unlocked ? 27 : 40) * 60 * 1000);
}
function saveGallery(session) {
  if (!unlocked || !currentSearch?.searchId || !currentSearch.token) return;
  try { localStorage.setItem(GALLERY_KEY, JSON.stringify({ searchId: currentSearch.searchId, token: currentSearch.token, session: session || null, savedAt: Date.now() })); } catch { /* Storage is optional. */ }
}
function loadSavedGallery() {
  try { const saved = JSON.parse(localStorage.getItem(GALLERY_KEY) || 'null'); return saved?.searchId && saved?.token && Date.now() - (saved.savedAt || 0) < 30 * 24 * 60 * 60 * 1000 ? saved : null; }
  catch { return null; }
}
function showResumeNotice() {
  const saved = loadSavedGallery();
  $('#resumeNotice').hidden = !saved;
  if (!saved) return;
  const where = saved.session ? ` from ${saved.session.title} · ${dateLabel(saved.session.date)}` : '';
  $('#resumeCopy').textContent = `Welcome back. Your photos${where} are still here.`;
}
$('#resumeGallery').addEventListener('click', async () => {
  const saved = loadSavedGallery(); if (!saved) return;
  const button = $('#resumeGallery'); button.classList.add('is-busy'); button.disabled = true;
  try {
    currentSearch = { searchId: saved.searchId, token: saved.token }; unlocked = true; photos = []; favourites.clear();
    const ok = await refreshLinks();
    if (!ok || !photos.length) throw new Error('Couldn’t open your photos.');
    const session = saved.session || {};
    $('#resultsMeta').textContent = session.title ? `${dateLabel(session.date)} · ${session.location} · ${session.title}` : 'Your photos';
    setResultsTitle(photos.length); $('#resultsCopy').textContent = 'The originals, still here. Tap one, then Download.';
    $('#indexingBanner').hidden = true; restoreFavourites(); updateCheckoutPanel(); renderGallery(); showResults();
  } catch (error) {
    if (/expired/i.test(error.message)) { try { localStorage.removeItem(GALLERY_KEY); } catch { /* ignore */ } $('#resumeNotice').hidden = true; }
    status(`${error.message} Paid and locked out? Email namaste@surfersofindia.com with your number.`, true);
  } finally { button.classList.remove('is-busy'); button.disabled = false; }
});
async function confirmPayment(orderId) {
  const result = await requestApi('/api/payment/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ searchId: currentSearch.searchId, token: currentSearch.token, orderId }) });
  if (!Array.isArray(result.photos)) throw new Error('Paid, but the photos didn’t load. Email the crew with your payment details.');
  window.SOI?.haptic?.([30, 40, 30]);
  applyUnlockedPhotos(result.photos, { celebrate: true });
  try { sessionStorage.removeItem('mjCheckout'); localStorage.removeItem('mjCheckout'); } catch { /* ignore */ }
  // Swap the 45-minute search token for the long-lived gallery token and remember it on this device.
  lastRefresh = 0; refreshLinks().catch(() => saveGallery(null));
}
// The Cashfree v3 SDK (~67 KB) is only needed by the few guests who pay, so it is fetched when the
// checkout dialog opens rather than on every landing. Loaded once; the promise is cached.
let cashfreeSdk = null;
function loadCashfreeSdk() {
  if (window.Cashfree) return Promise.resolve();
  if (!cashfreeSdk) {
    cashfreeSdk = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://sdk.cashfree.com/js/v3/cashfree.js'; script.async = true;
      script.onload = () => window.Cashfree ? resolve() : reject(new Error('Payment didn’t start. Refresh and try again.'));
      script.onerror = () => { cashfreeSdk = null; script.remove(); reject(new Error('Couldn’t reach the payment service. Check your connection.')); };
      document.head.append(script);
    });
  }
  return cashfreeSdk;
}
const cashfreeInstances = {};
function getCashfree(mode) {
  const key = mode === 'production' ? 'production' : 'sandbox';
  if (!cashfreeInstances[key]) cashfreeInstances[key] = window.Cashfree({ mode: key });
  return cashfreeInstances[key];
}
$('#unlockButton').addEventListener('click', () => { checkoutStatusMsg(); loadCashfreeSdk().catch(() => {}); $('#checkoutDialog').showModal(); });
$('#cancelCheckout').addEventListener('click', () => $('#checkoutDialog').close());
$('#checkoutForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (paying || !currentSearch) return;
  const phone = $('#checkoutPhone').value.trim();
  const email = $('#checkoutEmail').value.trim();
  if (!/^[6-9]\d{9}$/.test(phone)) { checkoutStatusMsg('Needs a 10-digit mobile number.', true); return; }
  paying = true; $('#payButton').disabled = true; $('#payButton').classList.add('is-busy'); $('#cancelCheckout').disabled = true; checkoutStatusMsg('Setting up payment…');
  try {
    const [order] = await Promise.all([
      requestApi('/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ searchId: currentSearch.searchId, token: currentSearch.token, phone, email: email || undefined }) }),
      loadCashfreeSdk(),
    ]);
    if (!order.paymentSessionId || !window.Cashfree) throw new Error('Payment didn’t start. Refresh and try again.');
    // Kept in both stores: sessionStorage survives the in-tab redirect, localStorage survives a UPI
    // app handing the return URL to a new tab or the system browser.
    const pending = JSON.stringify({ searchId: currentSearch.searchId, token: currentSearch.token, orderId: order.orderId, at: Date.now() });
    try { sessionStorage.setItem('mjCheckout', pending); localStorage.setItem('mjCheckout', pending); } catch { /* Storage is optional. */ }
    const cashfree = getCashfree(order.mode);
    // Our own <dialog> renders in the browser's top layer, which always paints above Cashfree's
    // _modal overlay regardless of z-index — close it first or the Drop-in UI is stuck underneath.
    $('#checkoutDialog').close();
    const result = await cashfree.checkout({ paymentSessionId: order.paymentSessionId, redirectTarget: '_modal' });
    // Three terminal states: error (failed/cancelled), redirect (navigating away — return_url picks it up), paymentDetails (attempt made, must verify).
    if (result?.error) { $('#checkoutDialog').showModal(); checkoutStatusMsg('Payment didn’t go through. Try again?', true); return; }
    if (result?.redirect) return;
    $('#checkoutDialog').showModal(); checkoutStatusMsg('Confirming…');
    await confirmPayment(order.orderId);
    $('#checkoutDialog').close();
  } catch (error) { if (!$('#checkoutDialog').open) $('#checkoutDialog').showModal(); checkoutStatusMsg(error.message, true); }
  finally { paying = false; $('#payButton').disabled = false; $('#payButton').classList.remove('is-busy'); $('#cancelCheckout').disabled = false; }
});
// Favourites are kept in sessionStorage per search so a refresh (or a UPI redirect) doesn't lose the picks.
const favouritesKey = () => currentSearch?.searchId ? `mjFav:${currentSearch.searchId}` : null;
function saveFavourites() { const key = favouritesKey(); if (!key) return; try { sessionStorage.setItem(key, JSON.stringify([...favourites])); } catch { /* Storage is optional. */ } }
function restoreFavourites() {
  favourites.clear(); const key = favouritesKey(); if (!key) return;
  try { JSON.parse(sessionStorage.getItem(key) || '[]').forEach(index => { if (Number.isInteger(index) && index >= 0 && index < photos.length) favourites.add(index); }); } catch { /* ignore */ }
}
// Toggle one tile in place: rebuilding the grid on every tap re-shimmers every thumbnail and can jump the scroll on iOS.
function toggleFavourite(index, button, figure) {
  const on = !favourites.has(index);
  on ? favourites.add(index) : favourites.delete(index);
  button.textContent = on ? '♥' : '♡'; button.setAttribute('aria-pressed', String(on)); window.SOI?.haptic?.([15]);
  $('#favouriteCount').textContent = favourites.size;
  // Only the "favourites only" view needs a structural change, and only for this tile.
  if (favouritesOnly && !on) { figure.remove(); $('#galleryEmpty').hidden = favourites.size > 0; $('#favouritesFilter').focus(); }
  saveFavourites(); syncActionBar();
}
function renderGallery() {
  $('#gallery').replaceChildren(); $('#favouriteCount').textContent = favourites.size;
  $('#galleryEmpty').hidden = !favouritesOnly || favourites.size > 0;
  photos.forEach((photo, index) => {
    if (favouritesOnly && !favourites.has(index)) return;
    const figure = document.createElement('figure'); figure.className = 'is-loading';
    const open = document.createElement('button'); open.className = 'photo-open'; open.type = 'button'; open.setAttribute('aria-label', `Open wave ${index + 1}`);
    const img = document.createElement('img'); img.src = photo.thumbUrl || photo.url; img.alt = unlocked ? `Wave ${index + 1}` : `Wave ${index + 1} preview`; img.loading = 'lazy'; img.decoding = 'async';
    const settle = () => { figure.classList.remove('is-loading', 'is-broken'); open.setAttribute('aria-label', `Open wave ${index + 1}`); };
    if (img.complete && img.naturalWidth) settle(); else img.addEventListener('load', settle);
    // An expired link asks for fresh ones (a successful refresh re-renders the grid). Otherwise mark the tile so the
    // CSS shows a retry stamp instead of painting the alt text, and let a tap on it retry the same src.
    const broken = () => { figure.classList.add('is-broken'); open.setAttribute('aria-label', `Photo ${index + 1} didn’t load — tap to retry`); };
    img.addEventListener('error', () => { figure.classList.remove('is-loading'); refreshLinks().then(ok => { if (!ok) broken(); }).catch(broken); });
    open.append(img); open.addEventListener('click', () => { if (!figure.classList.contains('is-broken')) return openPhoto(index); figure.classList.remove('is-broken'); figure.classList.add('is-loading'); img.src = photo.thumbUrl || photo.url; });
    const favourite = document.createElement('button'); favourite.className = 'favourite'; favourite.textContent = favourites.has(index) ? '♥' : '♡'; favourite.setAttribute('aria-label', `Keep wave ${index + 1}`); favourite.setAttribute('aria-pressed', String(favourites.has(index))); favourite.dataset.index = index;
    favourite.addEventListener('click', () => toggleFavourite(index, favourite, figure));
    const caption = document.createElement('figcaption'); const label = document.createElement('span'); label.textContent = `WAVE ${String(index + 1).padStart(2, '0')} · ${unlocked ? 'ORIGINAL' : 'PREVIEW'}`; caption.append(label);
    if (unlocked && photo.downloadUrl) { const download = document.createElement('a'); download.href = photo.downloadUrl; download.textContent = 'Download'; download.setAttribute('aria-label', `Download wave ${index + 1}`); caption.append(download); }
    figure.append(open, favourite, caption); $('#gallery').append(figure);
  });
  syncActionBar();
}
$('#favouritesFilter').addEventListener('click', () => { favouritesOnly = !favouritesOnly; $('#favouritesFilter').setAttribute('aria-pressed', String(favouritesOnly)); renderGallery(); });
// The phone-only sticky bar (#actionBar) lives outside #results, so it is hidden by hand whenever the results view is,
// or when there is nothing to do (no photos). Its controls proxy the originals, and it shows exactly one primary action:
// unlock while the gallery is locked, the ZIP once it is paid for. The markup is optional.
function syncActionBar() {
  const bar = $('#actionBar'), price = $('#unlockPriceBar'), count = $('#favouriteCountBar'), filter = $('#favouritesFilterBar');
  if (!bar) return;
  const canUnlock = !$('#unlockButton').hidden, canZip = !!$('#downloadAll') && !$('#downloadAll').hidden;
  bar.hidden = $('#results').hidden || !(canUnlock || canZip);
  if (price) price.textContent = $('#unlockPrice').textContent;
  const barButton = $('#unlockButtonBar'), zipButton = $('#downloadAllBar'), label = $('#unlockButton').firstChild;
  if (barButton) { barButton.hidden = !canUnlock; if (label?.nodeType === 3) barButton.firstChild.textContent = label.textContent; }
  if (zipButton) zipButton.hidden = canUnlock || !canZip;
  if (count) count.textContent = favourites.size;
  filter?.setAttribute('aria-pressed', String(favouritesOnly));
}
$('#unlockButtonBar')?.addEventListener('click', () => $('#unlockButton').click());
$('#favouritesFilterBar')?.addEventListener('click', () => $('#favouritesFilter').click());
// The ZIP arrives as an attachment, so the page stays put and the download itself can't be observed: a tick, then 6 s of busy.
function downloadAllBusy(button) { window.SOI?.haptic?.([15]); button.classList.add('is-busy'); setTimeout(() => button.classList.remove('is-busy'), 6000); }
$('#downloadAll')?.addEventListener('click', event => { if (!downloadAllUrl()) { event.preventDefault(); return; } downloadAllBusy(event.currentTarget); });
$('#downloadAllBar')?.addEventListener('click', event => { const url = downloadAllUrl(); if (!url) return; downloadAllBusy(event.currentTarget); location.assign(url); });
const preloaded = new Set();
function preloadPhoto(index) {
  if (!photos.length) return;
  const url = photos[(index + photos.length) % photos.length]?.url;
  if (!url || preloaded.has(url)) return;
  preloaded.add(url); const img = new Image(); img.decoding = 'async'; img.src = url;
}
function openPhoto(index) {
  if (!photos.length) return;
  const next = (index + photos.length) % photos.length;
  // A fresh open or a move to a neighbour gets a tick; re-opening the same photo after a link refresh doesn't.
  if (!$('#lightbox').open || next !== photoIndex) window.SOI?.haptic?.([10]);
  photoIndex = next;
  const photo = photos[photoIndex];
  $('#lightboxStage').classList.remove('is-zoomed');
  $('#lightboxImage').src = photo.url; $('#lightboxImage').alt = unlocked ? `Wave ${photoIndex + 1} of ${photos.length}` : `Wave ${photoIndex + 1} of ${photos.length}, preview`;
  $('#lightboxCount').textContent = `${photoIndex + 1} of ${photos.length}`;
  $('#lightboxCaption').textContent = unlocked ? 'Original' : 'Preview';
  $('#downloadPhoto').hidden = !(unlocked && photo.downloadUrl); if (photo.downloadUrl) $('#downloadPhoto').href = photo.downloadUrl;
  if (!$('#lightbox').open) $('#lightbox').showModal();
  preloadPhoto(photoIndex + 1); preloadPhoto(photoIndex - 1);
  document.dispatchEvent(new Event('mj:photo'));
}
$('#closeLightbox').addEventListener('click', () => $('#lightbox').close());
$('#previousPhoto').addEventListener('click', () => openPhoto(photoIndex - 1)); $('#nextPhoto').addEventListener('click', () => openPhoto(photoIndex + 1));
$('#lightbox').addEventListener('keydown', event => { if (event.key === 'ArrowLeft') { event.preventDefault(); openPhoto(photoIndex - 1); } if (event.key === 'ArrowRight') { event.preventDefault(); openPhoto(photoIndex + 1); } if (event.key === 'Escape') { event.preventDefault(); $('#lightbox').close(); } });
$('#lightboxImage').addEventListener('error', () => { refreshLinks().then(ok => { if (ok) openPhoto(photoIndex); }).catch(() => {}); });
// Touch: a horizontal drag of 40px+ moves to the neighbour. A double-tap (two clean taps within 300 ms and 24 px) zooms
// 2.2× around the tap point and another double-tap zooms back out — a single tap does nothing. While zoomed a drag pans
// (clamped to the frame) and a two-finger pinch scales 1–4×. The transform is inline (origin = centre), so the CSS only
// needs the .is-zoomed / .is-sliding hooks; .is-sliding also switches the transform transition off so panning and pinching
// track the finger instead of easing after it. Only the zoom step itself carries an inline 320 ms spring, iOS-style.
(() => {
  const stage = $('#lightboxStage'), image = $('#lightboxImage'), pointers = new Map();
  let startX = 0, startY = 0, dragging = false, moved = false, panX = 0, panY = 0, scale = 1, pinchStart = 1, pinchScale = 1;
  let lastTap = null, lastZoomAt = 0, zoomTimer = 0;
  image.style.transformOrigin = '50% 50%';
  const apply = () => {
    // Never pan further than the zoomed image's edge meeting the frame's edge — anything beyond is blank space.
    const maxX = (scale - 1) * image.offsetWidth / 2, maxY = (scale - 1) * image.offsetHeight / 2;
    panX = Math.max(-maxX, Math.min(maxX, panX)); panY = Math.max(-maxY, Math.min(maxY, panY));
    image.style.transform = scale > 1 ? `translate(${panX}px,${panY}px) scale(${scale})` : '';
    stage.classList.toggle('is-zoomed', scale > 1);
    stage.style.touchAction = scale > 1 ? 'none' : ''; // the stylesheet's pan-y would hand a vertical pan to the browser
  };
  // The inline transition exists for the zoom step only; a pan, a pinch or the next photo must not inherit it.
  const settleZoom = () => { clearTimeout(zoomTimer); if (image.style.transition) image.style.transition = ''; };
  const reset = () => { settleZoom(); lastTap = null; scale = 1; panX = panY = 0; apply(); };
  const toggleZoom = (x, y) => {
    lastZoomAt = performance.now(); clearTimeout(zoomTimer);
    image.style.transition = 'transform 320ms var(--ease-spring)';
    if (scale > 1) { scale = 1; panX = panY = 0; }
    else {
      // Zoom around the tapped point: shift the centre-origin scale so that point stays under the finger.
      const box = image.getBoundingClientRect(); scale = 2.2;
      panX = (box.width / 2 - (x - box.left)) * (scale - 1); panY = (box.height / 2 - (y - box.top)) * (scale - 1);
    }
    apply(); zoomTimer = setTimeout(settleZoom, 400); // fallback for a transition that never ends (reduced motion)
  };
  image.addEventListener('transitionend', event => { if (event.propertyName === 'transform') settleZoom(); });
  const distance = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1; };
  document.addEventListener('mj:photo', reset);
  stage.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointers.set(event.pointerId, event); stage.setPointerCapture(event.pointerId);
    if (pointers.size > 2) return; // a third finger neither pans nor pinches
    if (pointers.size === 2) { pinchStart = distance(); pinchScale = scale; dragging = false; lastTap = null; return; }
    dragging = true; moved = false; startX = event.clientX - panX; startY = event.clientY - panY;
  });
  stage.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId)) return; pointers.set(event.pointerId, event);
    if (pointers.size === 2) { settleZoom(); stage.classList.add('is-sliding'); scale = Math.min(4, Math.max(1, pinchScale * distance() / pinchStart)); apply(); return; }
    if (!dragging) return;
    const dx = event.clientX - startX, dy = event.clientY - startY;
    if (scale > 1) { moved = true; settleZoom(); stage.classList.add('is-sliding'); panX = dx; panY = dy; apply(); return; }
    if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) { moved = true; settleZoom(); stage.classList.add('is-sliding'); image.style.transform = `translateX(${dx}px)`; }
  });
  const finish = event => {
    pointers.delete(event.pointerId);
    // Lifting one finger after a pinch continues as a pan with the other; never count it as a tap.
    if (pointers.size === 1) { const [rest] = pointers.values(); dragging = true; moved = true; startX = rest.clientX - panX; startY = rest.clientY - panY; return; }
    if (pointers.size) return;
    stage.classList.remove('is-sliding');
    if (!dragging) return; dragging = false;
    if (!moved) {
      // A clean tap only counts in pairs: the second within 300 ms and 24 px of the first toggles the zoom.
      if (event.type !== 'pointerup') return;
      const tap = { t: event.timeStamp, x: event.clientX, y: event.clientY };
      const pair = lastTap && tap.t - lastTap.t < 300 && Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < 24;
      lastTap = pair ? null : tap;
      if (pair) toggleZoom(tap.x, tap.y);
      return;
    }
    lastTap = null;
    if (scale > 1) return;
    const dx = event.clientX - startX; image.style.transform = '';
    if (Math.abs(dx) > 40) openPhoto(photoIndex + (dx < 0 ? 1 : -1));
  };
  stage.addEventListener('pointerup', finish); stage.addEventListener('pointercancel', finish);
  // Desktop: a native double-click does the same. A fast mouse pair is usually caught by the pointer events first (and
  // some Android browsers fire dblclick for a touch pair too), so a toggle that just happened is not repeated.
  stage.addEventListener('dblclick', event => { event.preventDefault(); if (performance.now() - lastZoomAt > 400) toggleZoom(event.clientX, event.clientY); });
})();
function returnToSearch() { showSearch(); }
$('#backHome').addEventListener('click', returnToSearch);
// In-page links leave the results view and cancel a running search — except links inside the search form (the
// consent label's privacy link), which should simply scroll to their target.
document.querySelectorAll('a[href^="#"]').forEach(link => { if (link.closest('#searchForm')) return; link.addEventListener('click', () => { searchController?.abort(); showSearch({ scroll: false }); }); });
window.addEventListener('pagehide', event => { if (!event.persisted && previewUrl) URL.revokeObjectURL(previewUrl); searchController?.abort(); });
// Cashfree appends ?order_id= to the return URL after a redirect-style payment (UPI apps, netbanking).
async function resumeCheckoutFromRedirect() {
  const orderId = new URLSearchParams(location.search).get('order_id');
  if (!orderId) return;
  history.replaceState(null, '', location.pathname + location.hash);
  let stored = null;
  try { stored = JSON.parse(sessionStorage.getItem('mjCheckout') || localStorage.getItem('mjCheckout') || 'null'); } catch { stored = null; }
  const lost = !stored?.searchId || !stored?.token || (stored.orderId && stored.orderId !== orderId);
  $('#resultsMeta').textContent = ''; $('#resultsCopy').textContent = '';
  $('#resultsTitle').textContent = lost ? 'Payment received.' : 'Confirming…';
  $('#indexingBanner').hidden = true; $('#unlockButton').hidden = true; $('#checkoutNotice').hidden = true;
  showResults();
  if (lost) {
    // The browser that finished the payment isn't the one that ran the search (common when a UPI
    // app returns to a new tab). Say so instead of silently showing the landing page.
    $('#resultsCopy').textContent = `Order ${orderId} is paid, but this browser doesn’t know your search. Go back to the tab you searched in, or email namaste@surfersofindia.com with your number and order ${orderId}.`;
    return;
  }
  try {
    currentSearch = { searchId: stored.searchId, token: stored.token };
    photos = [];
    await confirmPayment(orderId);
    restoreFavourites(); renderGallery();   // hearts picked before the UPI app took over
    $('#resultsTitle').textContent = 'Paid.'; $('#resultsCopy').textContent = 'These are the originals — tap one, then Download.';
  } catch (error) { $('#resultsTitle').textContent = 'Paid, but…'; $('#resultsCopy').textContent = `${error.message} Order ${orderId}. Still stuck? Email namaste@surfersofindia.com with your number.`; }
}
resumeCheckoutFromRedirect();
showResumeNotice();
loadSessions();
