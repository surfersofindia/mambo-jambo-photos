'use strict';
const $ = (selector) => document.querySelector(selector);
const apiBase = (window.MJ_CONFIG?.apiUrl || '').replace(/\/$/, '');
let selectedSessionId = '';
let sessions = [], selectedFile = null, previewUrl = null, photos = [], favourites = new Set(), favouritesOnly = false, photoIndex = 0, searchController = null;
let currentSearch = null, unlocked = false, paying = false, refreshTimer = null, lastRefresh = 0;
// Wave 3: photos the guest hid ("Not me") by photoId, per search; the results eyebrow's base text (date · beach · session) that the live
// count is appended to; a 429's retry-after deadline for the search button; whether the current list came from the colour search.
let hiddenIds = new Set(), resultsBase = '', retryUntil = 0, retryTimer = 0, colourMode = false;
const GALLERY_KEY = 'mjGallery', SESSION_COUNT_KEY = 'mjSessionCount';
// How many skeleton rows stand in for the session list: the last real count (this tab), else one. Four rows already
// overflow the list's 340px max-height, so anything above that is clipped to the same height anyway.
function skeletonRows(cached) { const n = Math.floor(Number(cached)); return n > 0 ? Math.min(n, 4) : 1; }
(() => {
  let cached = null; try { cached = sessionStorage.getItem(SESSION_COUNT_KEY); } catch { /* Storage is optional. */ }
  const first = $('#sessionChoices').querySelector('.session-skeleton');
  for (let i = skeletonRows(cached); i > 1 && first; i--) first.after(first.cloneNode());
  if (Number(cached) > 4) $('#sessionFilterWrap').hidden = false;   // renderSessionChoices() shows the filter above four sessions; reserve its space too
})();
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
  if (!response.ok) { const error = new Error(data.error || 'That didn’t work. Try again?'); error.status = response.status; error.retryAfter = retryAfterSeconds(response.headers.get('retry-after')); throw error; }
  return data;
}
// `retry-after` as seconds: the Worker sends a number; an HTTP date is accepted too; a 429 without a readable value is treated as a minute.
function retryAfterSeconds(header) {
  if (header == null || header === '') return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds));
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.round((at - Date.now()) / 1000)) : 60;
}
const mmss = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
// "7 minutes" / "45 seconds": the spoken half of a countdown, said once.
function retryCopy(seconds) { if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`; const minutes = Math.ceil(seconds / 60); return `${minutes} minute${minutes === 1 ? '' : 's'}`; }
// A 429 lock (F1's carried request): `setLocked(true)` disables the control until the Worker's retry-after has passed, and `line` shows
// "Try again in 6:58" ticking every second. The sentence and a visually-hidden "7 minutes" are what a screen reader gets from the live
// region, once; the ticking figure is aria-hidden so nothing is announced every second. If another message replaces the line meanwhile
// (a bad file, a stage change), the countdown only comes back once the line is empty again — it never talks over an error.
function retryLock(seconds, line, setLocked, lead = 'You’ve searched a lot in a short while.') {
  clearTimeout(retryTimer);
  const until = Date.now() + Math.max(1, seconds) * 1000;
  setLocked(until);
  const tick = () => {
    const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    if (!left) { setLocked(0); if (!line.textContent.trim() || line.querySelector('.countdown')) line.textContent = 'You can search again now.'; return; }
    let figure = line.querySelector('.countdown');
    if (!figure && !line.textContent.trim()) {
      const said = document.createElement('span'); said.className = 'visually-hidden'; said.textContent = retryCopy(left);
      figure = document.createElement('span'); figure.className = 'countdown'; figure.setAttribute('aria-hidden', 'true');
      line.classList.remove('error'); line.replaceChildren(document.createTextNode(`${lead} Try again in `), said, figure, document.createTextNode('.'));
    }
    if (figure) figure.textContent = mmss(left);
    retryTimer = setTimeout(tick, 1000);
  };
  tick();
}
function dateLabel(value) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
// "Today's session lands by 4:30 pm" from GET /api/sessions' nextDropAt (W3-B): only when the drop is still ahead and within 24 h,
// otherwise null and the line stays out of the page. Local time; "tomorrow" when the calendar day differs.
function nextDropCopy(iso, now = Date.now()) {
  const at = Date.parse(iso || '');
  if (!Number.isFinite(at) || at <= now || at - now > 24 * 60 * 60 * 1000) return null;
  const date = new Date(at), today = new Date(now);
  const time = date.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }).replace(/\s?([ap])m$/i, ' $1m').toLowerCase();
  return date.toDateString() === today.toDateString() ? `Today’s session lands by ${time}` : `Next session lands by ${time} tomorrow`;
}
function renderNextDrop(iso) {
  const line = $('#nextDrop'); if (!line) return;
  const copy = nextDropCopy(iso);
  line.textContent = copy || ''; line.hidden = !copy;
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
// The jump to the top is instant on purpose: html{scroll-behavior:smooth} would leave the finder's scroll offset in
// place for the first frame after the swap, and the footer would flash through the viewport as a layout shift.
// Safari before 15.4 rejects `behavior: 'instant'` with a TypeError; there the smooth scroll is switched off on the
// root for the one plain call, so the swap is still a jump and never a thrown error mid-render.
function jumpToTop() {
  try { window.scrollTo({ top: 0, behavior: 'instant' }); }
  catch { const root = document.documentElement, was = root.style.scrollBehavior; root.style.scrollBehavior = 'auto'; window.scrollTo(0, 0); root.style.scrollBehavior = was; }
}
function showResults() {
  $('#main').hidden = true; $('#results').hidden = false;
  if (history.state?.view !== 'results') history.pushState({ view: 'results' }, '', location.pathname + location.search);
  jumpToTop(); $('#resultsTitle').focus(); syncActionBar();
}
function showSearch({ scroll = true } = {}) {
  $('#results').hidden = true; $('#main').hidden = false;
  if (history.state?.view === 'results') history.replaceState({ view: 'search' }, '', location.pathname + location.search);
  if (scroll) { $('#finder').scrollIntoView(); $('#changeSession').focus({ preventScroll: true }); }
  syncActionBar();
}
window.addEventListener('popstate', event => {
  if ($('#lightbox').open) $('#lightbox').close();
  if (event.state?.view === 'results' && photos.length) { $('#main').hidden = true; $('#results').hidden = false; jumpToTop(); }
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
    renderNextDrop(data.nextDropAt);
    selectedSessionId = '';
    try { sessionStorage.setItem(SESSION_COUNT_KEY, String(sessions.length)); } catch { /* Storage is optional. */ }
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
  if (!sessions.length) return;   // the field can be on screen (reserved from the cached count) before the list has loaded
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
function updateSubmit() { $('#findMatches').disabled = !selectedFile || !$('#privacyConsent').checked || Date.now() < retryUntil; }
$('#privacyConsent').addEventListener('change', updateSubmit);
$('#takeSelfie').addEventListener('click', () => openCameraDialog());
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
// Why a selfie can't be used, or '' when it can. Shared by the file input and the drop zone so both refuse the same files.
function selfieProblem(file) {
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024 || !file.size) return 'JPG, PNG or WebP under 10 MB.';
  return '';
}
async function acceptSelfie(file) {
  selectedFile = null; updateSubmit(); status();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null; $('#selfiePreview').hidden = true; $('#selfiePreview').removeAttribute('src'); $('#uploadPrompt').hidden = false;
  if (!file) return;
  const problem = selfieProblem(file);
  if (problem) { status(problem, true); $('#selfieInput').value = ''; return; }
  const url = URL.createObjectURL(file); previewUrl = url;
  try {
    const image = new Image(); image.src = url; await image.decode();
    if (previewUrl !== url) return;
    selectedFile = await downscaleSelfie(file, image);
    if (previewUrl !== url) return;
    $('#selfiePreview').src = url; $('#selfiePreview').hidden = false; $('#uploadPrompt').hidden = true; updateSubmit(); window.SOI?.haptic?.([20]);
  } catch { if (previewUrl === url) { URL.revokeObjectURL(url); previewUrl = null; status('Couldn’t open that one. Try another.', true); } }
}
$('#selfieInput').addEventListener('change', event => acceptSelfie(event.target.files[0]));
// Desktop drag-and-drop onto the zone. The drop is handled here (not by the file input's native drop) so the zone's
// drag state, the validation and the preview all go through the one path above; the input's files are mirrored when the
// browser allows it, so the form state matches. Keyboard and touch paths are untouched.
(() => {
  const zone = document.querySelector('.upload-zone'); if (!zone) return;
  for (const type of ['dragenter', 'dragover']) zone.addEventListener(type, event => { event.preventDefault(); zone.classList.add('is-dragover'); });
  zone.addEventListener('dragleave', event => { if (!zone.contains(event.relatedTarget)) zone.classList.remove('is-dragover'); });
  zone.addEventListener('drop', event => {
    event.preventDefault(); zone.classList.remove('is-dragover');
    const files = event.dataTransfer?.files; if (!files?.length) return;
    try { $('#selfieInput').files = files; } catch { /* Some browsers refuse; the drop still works from `file`. */ }
    acceptSelfie(files[0]);
  });
})();

// ── Guided selfie capture: in-page camera with a live face-alignment guide ────
// The old behaviour opened the OS camera app via <input capture="user"> — fine, but a full native
// hand-off with no framing help. This runs the camera in-page instead: a face-detection model
// (face-api.js's tiny_face_detector, vendored under assets/ — ~155 KB gzip, so it's only ever
// fetched when this dialog opens, never on page load) tracks the face live and auto-fires the
// capture once it settles inside the guide oval, matching what the guide showed the guest.
// Every failure mode below (no camera API, permission denied, model fails to load) falls back to
// something that still works rather than trapping the guest: first the same native capture= input
// this replaced, and "Upload a photo instead" is always one tap away regardless.
const CAMERA_GUIDE = { cx: .5, cy: .44, rx: .30, ry: .36 }; // relative to the frame; mirrors the <ellipse> in index.html
const CAMERA_ALIGN_HOLD_MS = 700; // how long the face must sit still inside the guide before auto-capture fires
let cameraStream = null, cameraDetectTimer = null, cameraAlignedSince = 0, cameraCaptured = false, faceApiReady = null;

function loadFaceApi() {
  if (window.faceapi) return Promise.resolve();
  if (!faceApiReady) {
    faceApiReady = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'assets/face-api.js'; script.async = true;
      script.onload = () => window.faceapi ? resolve() : reject(new Error('face-api failed to load'));
      script.onerror = () => { faceApiReady = null; script.remove(); reject(new Error('face-api failed to load')); };
      document.head.append(script);
    }).then(() => window.faceapi.nets.tinyFaceDetector.loadFromUri('assets/face-models'));
  }
  return faceApiReady;
}

function stopCamera() {
  clearInterval(cameraDetectTimer); cameraDetectTimer = null;
  cameraStream?.getTracks().forEach(track => track.stop()); cameraStream = null;
  $('#cameraVideo').srcObject = null;
  delete $('#cameraFrame').dataset.aligned;
}
function closeCameraDialog() { stopCamera(); if ($('#cameraDialog').open) $('#cameraDialog').close(); }

// The video plays at its own native aspect ratio inside a differently-shaped box via
// object-fit:cover, which crops one axis — map a detected face box (in native video pixels) into
// the same 0–1 space the guide oval is defined in, undoing that crop. The X axis is also mirrored
// (the preview is CSS-flipped for a natural "looking in a mirror" feel; detection runs on the
// unflipped source frame) so "move left" in the guide matches what the guest actually sees.
function videoBoxToGuideSpace(box, video, frame) {
  const vW = video.videoWidth, vH = video.videoHeight, dW = frame.clientWidth, dH = frame.clientHeight;
  if (!vW || !vH || !dW || !dH) return null;
  let scale, offsetX = 0, offsetY = 0;
  if (vW / vH > dW / dH) { scale = dH / vH; offsetX = vW / 2 - dW / (2 * scale); }
  else { scale = dW / vW; offsetY = vH / 2 - dH / (2 * scale); }
  const visibleW = dW / scale, visibleH = dH / scale;
  return {
    centerX: 1 - (box.x + box.width / 2 - offsetX) / visibleW,
    centerY: (box.y + box.height / 2 - offsetY) / visibleH,
    height: box.height / visibleH,
  };
}

async function runCameraDetectLoop() {
  if (cameraCaptured) return;
  const video = $('#cameraVideo'), frame = $('#cameraFrame'), statusEl = $('#cameraStatus');
  let face; try { face = await window.faceapi.detectSingleFace(video, new window.faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: .5 })); } catch { return; }
  if (cameraCaptured) return;
  if (!face) { delete frame.dataset.aligned; cameraAlignedSince = 0; statusEl.textContent = 'Center your face in the oval'; return; }
  const rect = videoBoxToGuideSpace(face.box, video, frame);
  if (!rect) return;
  const centered = Math.abs(rect.centerX - CAMERA_GUIDE.cx) < .14 && Math.abs(rect.centerY - CAMERA_GUIDE.cy) < .16;
  const sizeRatio = rect.height / (CAMERA_GUIDE.ry * 2);
  const aligned = centered && sizeRatio > .65 && sizeRatio < 1.35;
  frame.dataset.aligned = String(aligned);
  if (!centered) statusEl.textContent = 'Center your face in the oval';
  else if (sizeRatio <= .65) statusEl.textContent = 'Move a little closer';
  else if (sizeRatio >= 1.35) statusEl.textContent = 'Move back a little';
  else statusEl.textContent = 'Hold still…';
  if (!aligned) { cameraAlignedSince = 0; return; }
  if (!cameraAlignedSince) cameraAlignedSince = performance.now();
  else if (performance.now() - cameraAlignedSince >= CAMERA_ALIGN_HOLD_MS) captureSelfieFromCamera();
}

function captureSelfieFromCamera() {
  if (cameraCaptured) return;
  cameraCaptured = true;
  const video = $('#cameraVideo'), canvas = $('#cameraCanvas');
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  canvas.toBlob(blob => {
    closeCameraDialog();
    if (!blob) { status('Could not capture that. Try again?', true); return; }
    window.SOI?.haptic?.([20]);
    // Hand the captured frame to #selfieInput itself (a DataTransfer is the only way to set
    // .files programmatically) and fire the same 'change' it emits for a manual pick, rather than
    // calling into whatever validates/previews a selfie directly — that logic isn't this feature's
    // concern, and this way a capture behaves exactly like a pick no matter how that logic evolves.
    const input = $('#selfieInput'), transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'selfie.jpg', { type: 'image/jpeg' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, 'image/jpeg', .9);
}

// The pre-existing fallback: hand off to the OS camera app via the file input. The `capture`
// attribute is removed again straight after so a later "Choose a selfie" tap keeps opening the
// photo library instead of jumping back into the camera.
function openNativeCameraFallback() {
  const input = $('#selfieInput'); input.setAttribute('capture', 'user'); input.click();
  setTimeout(() => input.removeAttribute('capture'), 1000);
}

async function openCameraDialog() {
  if ($('#cameraDialog').open) return;   // a fast double-tap must not call showModal() twice
  if (!navigator.mediaDevices?.getUserMedia) { openNativeCameraFallback(); return; }
  cameraCaptured = false; cameraAlignedSince = 0;
  $('#cameraStatus').textContent = 'Starting camera…';
  $('#cameraDialog').showModal();
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 960 } }, audio: false });
  } catch {
    $('#cameraDialog').close();
    openNativeCameraFallback();
    return;
  }
  const video = $('#cameraVideo'); video.srcObject = cameraStream; await video.play().catch(() => {});
  if (!cameraStream) return; // dialog was closed while the stream was starting
  $('#cameraStatus').textContent = 'Loading face guide…';
  try {
    await loadFaceApi();
    if (!cameraStream) return; // dialog was closed while the model was loading
    $('#cameraStatus').textContent = 'Center your face in the oval';
    cameraDetectTimer = setInterval(runCameraDetectLoop, 250);
  } catch {
    // No live guidance, but the camera itself still works — Capture stays manual.
    $('#cameraStatus').textContent = 'Line up your face and tap Capture.';
  }
}

$('#cameraCapture').addEventListener('click', () => captureSelfieFromCamera());
$('#closeCameraDialog').addEventListener('click', () => closeCameraDialog());
$('#cameraUploadInstead').addEventListener('click', () => { closeCameraDialog(); $('#selfieInput').click(); });
$('#cameraDialog').addEventListener('cancel', () => stopCamera());   // Esc key
$('#cameraDialog').addEventListener('close', () => stopCamera());
// "12 waves. All you." — the count is its own element so the hand-drawn underline has something to sit under. Built
// from nodes, never markup; the underline is drawn a frame later so the results view is on screen when it measures.
function setResultsTitle(count, tail = colourMode ? ', maybe you.' : '. All you.') {   // colour matches are a board, not a face — say so
  const number = document.createElement('b'); number.className = 'soi-underline'; number.textContent = String(count);
  $('#resultsTitle').replaceChildren(number, document.createTextNode(` wave${count === 1 ? '' : 's'}${tail}`));
  requestAnimationFrame(() => window.SOI?.underline?.(number));
}
// The eyebrow over the title is the one live region for the count (aria-live=polite, atomic): "17 Sept 2026 · Mulki Beach · Dawn patrol ·
// 9 waves", then "… · 8 waves, 1 hidden" after a hide. Written once per change, never per tile, so a screen reader hears one sentence.
function resultsMetaText(base, count, hidden = 0, byColour = false) {
  const waves = `${count} wave${count === 1 ? '' : 's'}${byColour ? ' by colour' : ''}`;
  return `${base ? `${base} · ` : ''}${waves}${hidden ? `, ${hidden} hidden` : ''}`;
}
function setResultsCount() { $('#resultsMeta').textContent = resultsMetaText(resultsBase, photos.length, hiddenIds.size, colourMode); }
// Session conditions (W3-B's /api/sessions `conditions`) as stamp chips under the title; nothing rendered when the crew left them empty.
function conditionChips(conditions) {
  if (!conditions || typeof conditions !== 'object') return [];
  const swell = Number(conditions.swellFt);
  return [conditions.breakName, Number.isFinite(swell) && swell > 0 ? `${swell} ft` : '', conditions.wind, conditions.tide, conditions.photographer ? `📷 ${conditions.photographer}` : '']
    .map(value => String(value || '').trim()).filter(Boolean);
}
function renderConditions(conditions) {
  const box = $('#resultsConditions'); if (!box) return;
  const chips = conditionChips(conditions);
  box.replaceChildren(...chips.map(text => { const chip = document.createElement('span'); chip.className = 'chip chip--slate'; chip.textContent = text; return chip; }));
  box.hidden = !chips.length;
}
// "Not me" hides are remembered per search in sessionStorage, so a refresh (or the UPI round trip) does not resurrect a hidden wave before the
// Worker has confirmed it — and keeps it hidden even where the /hide route is not deployed yet.
const hiddenKey = () => currentSearch?.searchId ? `mjHidden:${currentSearch.searchId}` : null;
function loadHidden() { hiddenIds = new Set(); const key = hiddenKey(); if (!key) return; try { JSON.parse(sessionStorage.getItem(key) || '[]').forEach(id => { if (typeof id === 'string' && id) hiddenIds.add(id); }); } catch { /* ignore */ } }
function saveHidden() { const key = hiddenKey(); if (!key) return; try { sessionStorage.setItem(key, JSON.stringify([...hiddenIds])); } catch { /* Storage is optional. */ } }
const withoutHidden = list => list.filter(photo => !hiddenIds.has(photo.photoId));
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
    favourites.clear(); favouritesOnly = false; colourMode = false; $('#favouritesFilter').setAttribute('aria-pressed', 'false');
    unlocked = false;
    currentSearch = (match.searchId && match.token) ? { searchId: match.searchId, token: match.token, pricePaise: match.pricePaise, currency: match.currency } : null;
    loadHidden(); photos = withoutHidden(match.previews.map(normalisePhoto));
    restoreFavourites();
    resultsBase = `${dateLabel(match.session.date)} · ${match.session.location} · ${match.session.title}`; setResultsCount();
    renderConditions(sessions.find(item => item.id === selectedSessionId)?.conditions);
    if (photos.length) setResultsTitle(photos.length); else $('#resultsTitle').textContent = 'No waves with your face in them.';
    $('#resultsCopy').textContent = photos.length ? 'Tap one to get closer.' : '';
    showZeroMatch(!photos.length);   // the starfish state carries the copy and the way back, plus the colour search and notify-me
    $('#indexingBanner').textContent = match.indexingNote || ''; $('#indexingBanner').hidden = !match.indexingNote;
    updateCheckoutPanel();
    renderGallery(); stage('selfie'); showResults(); scheduleLinkRefresh();
    if (photos.length) window.SOI?.splash?.({ at: $('#resultsTitle'), symbol: 'stamp-hibiscus', count: 6 });
  } catch (error) {
    stage('selfie');
    // Over the guest quota: the Worker says how long (retry-after); keep the button off for exactly that long and count it down.
    if (error.status === 429) { retryLock(error.retryAfter || 60, $('#finderStatus'), until => { retryUntil = until; updateSubmit(); }); return; }
    status(error.name === 'AbortError' ? (timedOut ? 'That took too long. Go again?' : 'Stopped. Whenever you’re ready.') : error.message, error.name !== 'AbortError' || timedOut);
  }
  finally { clearTimeout(timeout); searchController = null; $('#matchingStage').style.removeProperty('--stage-h'); }
});
// Zero match: the starfish state plus the second chance (a colour search and a notify-me), both only while there is a live search to
// run them against. The colour picker is reset each time so an old choice never fires against a new search.
function showZeroMatch(on) {
  $('#noMatches').hidden = !on;
  // Nothing to keep or share yet, and the conditions chips wait too: with these out of the header while the state is empty, a later colour
  // result only *adds* elements under the title instead of moving them, so the swap registers no layout shift.
  const actions = document.querySelector('.results-actions'); if (actions) actions.hidden = on;
  if (on) $('#resultsConditions').hidden = true;
  const chance = $('#secondChance'); if (!chance) return;
  chance.hidden = !on || !currentSearch?.searchId;
  if (!on) return;
  document.querySelectorAll('#hueRing input').forEach(input => { input.checked = false; input.disabled = false; });
  const vivid = $('#toneToggle')?.querySelector('input[value=vivid]'); if (vivid) vivid.checked = true;
  $('#hueName').textContent = 'Pick a colour'; $('#colourSubmit').disabled = true; colourStatusMsg(); notifyStatusMsg(); $('#notifyPhone').value = '';
}
function colourStatusMsg(message = '', error = false) { const line = $('#colourStatus'); if (!line) return; line.textContent = message; line.classList.toggle('error', error); }
function notifyStatusMsg(message = '', error = false) { const line = $('#notifyStatus'); if (!line) return; line.textContent = message; line.classList.toggle('error', error); }
const chosenHue = () => { const input = $('#hueRing')?.querySelector('input:checked'); return input ? { hue: Number(input.value), name: input.nextElementSibling?.textContent || '' } : null; };
$('#hueRing')?.addEventListener('change', () => { const chosen = chosenHue(); $('#hueName').textContent = chosen ? chosen.name : 'Pick a colour'; $('#colourSubmit').disabled = !chosen; colourStatusMsg(); });
// POST /api/searches/:id/colour { token, hue, tone } → the /api/match shape with mode:'colour' (W3-B). Success swaps the results in place:
// same search, same token, previews ranked by board colour. 429 locks the picker for retry-after. 404 (route not deployed) says so.
$('#colourSubmit')?.addEventListener('click', async () => {
  const chosen = chosenHue(); if (!chosen || !currentSearch?.searchId) return;
  const tone = $('#toneToggle')?.querySelector('input:checked')?.value || 'any';
  const button = $('#colourSubmit'); button.disabled = true; button.classList.add('is-busy'); colourStatusMsg(`Looking for ${chosen.name.toLowerCase()} boards…`);
  try {
    const result = await requestApi(`/api/searches/${encodeURIComponent(currentSearch.searchId)}/colour`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: currentSearch.token, hue: chosen.hue, tone }) });
    if (!Array.isArray(result.previews)) throw new Error('Something came back broken. Go again?');
    if (result.token) currentSearch.token = result.token;
    const found = withoutHidden(result.previews.map(normalisePhoto));
    if (!found.length) { colourStatusMsg(`No ${chosen.name.toLowerCase()} boards in this session. Try another colour.`); return; }
    photos = found; colourMode = true; favourites.clear(); favouritesOnly = false; $('#favouritesFilter').setAttribute('aria-pressed', 'false');
    if (result.session) resultsBase = `${dateLabel(result.session.date)} · ${result.session.location} · ${result.session.title}`;
    setResultsCount(); setResultsTitle(photos.length); $('#resultsCopy').textContent = 'Matched by board colour · previews only';
    showZeroMatch(false); renderConditions(sessions.find(item => item.id === selectedSessionId)?.conditions); updateCheckoutPanel(); renderGallery(); scheduleLinkRefresh();
    jumpToTop(); $('#resultsTitle').focus();
  } catch (error) {
    if (error.status === 429) { colourStatusMsg(); retryLock(error.retryAfter || 60, $('#colourStatus'), until => { document.querySelectorAll('#hueRing input').forEach(input => { input.disabled = until > 0; }); button.disabled = until > 0; }, 'That’s a lot of searches.'); return; }
    colourStatusMsg(error.status === 404 ? 'Colour search isn’t available yet — try another selfie above.' : error.message, true);
  } finally { button.classList.remove('is-busy'); if (!document.querySelector('#hueRing input:disabled')) button.disabled = !chosenHue(); }   // a 429 lock (inputs disabled) keeps the button off until retryLock lifts it
});
// POST /api/searches/:id/notify { token, phone } → { ok:true } (W3-B). Same number rules as checkout. 404 → a friendly "not yet".
$('#notifyForm')?.addEventListener('submit', async event => {
  event.preventDefault();
  const phone = $('#notifyPhone').value.trim(), button = $('#notifySubmit');
  if (!/^[6-9]\d{9}$/.test(phone)) { notifyStatusMsg('Needs a 10-digit mobile number.', true); return; }
  if (!currentSearch?.searchId) { notifyStatusMsg('Run a search first.', true); return; }
  button.disabled = true; button.classList.add('is-busy'); notifyStatusMsg('Saving…');
  try {
    await requestApi(`/api/searches/${encodeURIComponent(currentSearch.searchId)}/notify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: currentSearch.token, phone }) });
    notifyStatusMsg('We’ll WhatsApp you once.'); window.SOI?.haptic?.([20]);
  } catch (error) { notifyStatusMsg(error.status === 404 ? 'Not available yet — email namaste@surfersofindia.com and we’ll tell you.' : error.message, error.status !== 404); }
  finally { button.disabled = false; button.classList.remove('is-busy'); }
});
function formatRupees(paise, currency) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR', maximumFractionDigits: 0 }).format((paise || 0) / 100);
}
// "12 photos · ₹700": what the pack is and what it costs, in the checkout dialog's heading.
function checkoutHeading(count, amount) { return `${count} photo${count === 1 ? '' : 's'} · ${amount}`; }
function checkoutStatusMsg(message = '', error = false) { $('#checkoutStatus').textContent = message; $('#checkoutStatus').classList.toggle('error', error); }
// The ZIP of every original. The token is whichever the API handed back last — the search token right after payment,
// the long-lived gallery token once refreshLinks() has swapped it in — so the link is rebuilt every time the panel updates.
const downloadAllUrl = () => currentSearch?.searchId && currentSearch.token ? `${apiBase}/api/searches/${encodeURIComponent(currentSearch.searchId)}/download?token=${encodeURIComponent(currentSearch.token)}` : null;
function updateCheckoutPanel() {
  const canUnlock = photos.length > 0 && Number(currentSearch?.pricePaise) > 0;
  $('#unlockButton').hidden = !canUnlock || unlocked;
  $('#checkoutNotice').hidden = unlocked || !photos.length;   // nothing to unlock on the zero-match state
  $('#unlockedNotice').hidden = !unlocked;
  const zip = unlocked && photos.length ? downloadAllUrl() : null, all = $('#downloadAll');
  if (all) { all.hidden = !zip; all.href = zip || '#'; }
  // The count lives in the title; only the text node in front of the #unlockPrice span is (re)written.
  const label = 'Unlock all photos · ', first = $('#unlockButton').firstChild;
  if (first?.nodeType === Node.TEXT_NODE) first.data = label; else $('#unlockButton').prepend(label);
  if (currentSearch?.pricePaise) {
    const amount = formatRupees(currentSearch.pricePaise, currentSearch.currency);
    $('#unlockPrice').textContent = amount; $('#payAmount').textContent = amount;
    $('#checkoutTitle').textContent = checkoutHeading(photos.length, amount);
    const each = $('#checkoutPerPhoto'); if (each) { each.textContent = perPhotoCopy(photos.length, currentSearch.pricePaise, currentSearch.currency); each.hidden = !each.textContent; }
  }
  // The WhatsApp button for the 30-day link only once the long-lived gallery token is saved on this device (refreshLinks → saveGallery).
  const share = $('#galleryShare'); if (share) share.hidden = !(unlocked && photos.length && galleryLink());
  syncActionBar();
}
// "₹58 each" under the checkout heading — the pack price spread over the photos in it; '' when there is nothing to divide.
function perPhotoCopy(count, paise, currency) {
  if (!(count > 0) || !(paise > 0)) return '';
  return `${formatRupees(Math.round(paise / count), currency)} each`;
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
  const valid = withoutHidden(unlockedPhotos.filter(photo => photo?.photoId && photo?.url).map(normalisePhoto));
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
  updateCheckoutPanel();   // the gallery-share button appears once the long-lived token has been saved
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
// Open a paid gallery from its record — the one saved on this device (the resume notice) or one carried by a ?gallery= link (W3-A).
// refreshLinks() saves the record only once /access has answered, so a bad link never overwrites a good saved gallery; an expired
// saved record is dropped, an expired link leaves whatever was saved alone.
async function openGallery(saved, button) {
  if (button) { button.classList.add('is-busy'); button.disabled = true; }
  try {
    currentSearch = { searchId: saved.searchId, token: saved.token }; unlocked = true; photos = []; favourites.clear(); loadHidden(); colourMode = false;
    const ok = await refreshLinks();
    if (!ok || !photos.length) throw new Error('Couldn’t open your photos.');
    const session = saved.session || loadSavedGallery()?.session || {};
    resultsBase = session.title ? `${dateLabel(session.date)} · ${session.location} · ${session.title}` : 'Your photos'; setResultsCount(); renderConditions(null);
    setResultsTitle(photos.length); $('#resultsCopy').textContent = 'The originals, still here. Tap one, then Download.';
    $('#indexingBanner').hidden = true; showZeroMatch(false); restoreFavourites(); updateCheckoutPanel(); renderGallery(); showResults(); showResumeNotice();
  } catch (error) {
    const kept = loadSavedGallery();
    if (/expired/i.test(error.message) && kept?.searchId === saved.searchId && kept?.token === saved.token) { try { localStorage.removeItem(GALLERY_KEY); } catch { /* ignore */ } $('#resumeNotice').hidden = true; }
    status(`${error.message} Paid and locked out? Email namaste@surfersofindia.com with your number.`, true);
    if (!button) $('#finder').scrollIntoView();   // a link opened cold: bring the message into view
  } finally { if (button) { button.classList.remove('is-busy'); button.disabled = false; } }
}
$('#resumeGallery').addEventListener('click', () => { const saved = loadSavedGallery(); if (saved) openGallery(saved, $('#resumeGallery')); });
async function confirmPayment(orderId) {
  const result = await requestApi('/api/payment/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ searchId: currentSearch.searchId, token: currentSearch.token, orderId }) });
  if (!Array.isArray(result.photos)) throw new Error('Paid, but the photos didn’t load. Email the crew with your payment details.');
  window.SOI?.haptic?.([30, 40, 30]);
  applyUnlockedPhotos(result.photos, { celebrate: true });
  try { sessionStorage.removeItem('mjCheckout'); localStorage.removeItem('mjCheckout'); } catch { /* ignore */ }
  // Swap the 45-minute search token for the long-lived gallery token and remember it on this device.
  lastRefresh = 0; refreshLinks().catch(() => { saveGallery(null); updateCheckoutPanel(); });
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
// A tile's box ratio from the stored dimensions (migration 0012): "1600 / 1067", or '' for a pre-0012 photo, which keeps the CSS 4:3 box.
function tileAspect(photo) {
  const width = Number(photo?.width), height = Number(photo?.height);
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 ? `${width} / ${height}` : '';
}
// The tile's index is looked up when it is used, not captured at render time: a "Not me" hide splices `photos` without re-rendering
// the grid, so a captured index would point at the wrong wave afterwards.
const indexOfPhoto = photo => photos.findIndex(item => item.photoId === photo.photoId);
// Wave numbers, hearts and open/download labels of the remaining tiles after a hide — text only, no image is touched.
function relabelTiles() {
  for (const figure of $('#gallery').querySelectorAll('figure')) {
    const index = photos.findIndex(item => item.photoId === figure.dataset.photoId); if (index < 0) continue;
    const n = index + 1, open = figure.querySelector('.photo-open'), img = open?.querySelector('img'), heart = figure.querySelector('.favourite'), label = figure.querySelector('figcaption span'), download = figure.querySelector('figcaption a'), hide = figure.querySelector('.hide-photo');
    if (open && !figure.classList.contains('is-broken')) open.setAttribute('aria-label', `Open wave ${n}`);
    if (img) img.alt = unlocked ? `Wave ${n}` : `Wave ${n} preview`;
    if (heart) { heart.setAttribute('aria-label', `Keep wave ${n}`); heart.textContent = favourites.has(index) ? '♥' : '♡'; heart.setAttribute('aria-pressed', String(favourites.has(index))); }
    if (label) label.textContent = `WAVE ${String(n).padStart(2, '0')} · ${unlocked ? 'ORIGINAL' : 'PREVIEW'}`;
    if (download) download.setAttribute('aria-label', `Download wave ${n}`);
    if (hide) hide.setAttribute('aria-label', `Not me, hide wave ${n}`);
  }
}
// "Not me": drop the tile in place (no grid re-render), renumber what is left, move focus to the next print, update the live count,
// remember the id in sessionStorage, then tell the Worker (POST /api/searches/:id/hide). A 404 — route not deployed — is ignored: the
// hide already happened here. When the last wave goes, the zero-match state takes over with its second chance.
function hidePhoto(photo, figure) {
  const index = indexOfPhoto(photo); if (index < 0) return;
  const next = figure.nextElementSibling?.querySelector('.photo-open') || figure.previousElementSibling?.querySelector('.photo-open');
  hiddenIds.add(photo.photoId); saveHidden();
  photos.splice(index, 1);
  favourites = new Set([...favourites].filter(i => i !== index).map(i => (i > index ? i - 1 : i))); saveFavourites();
  if (photoIndex > index) photoIndex--;
  figure.remove(); relabelTiles(); window.SOI?.haptic?.([15]);
  $('#favouriteCount').textContent = favourites.size; $('#galleryEmpty').hidden = !favouritesOnly || favourites.size > 0;
  setResultsCount();
  if (photos.length) { setResultsTitle(photos.length); (next || $('#resultsTitle')).focus(); }
  else { $('#resultsTitle').textContent = 'No waves left.'; $('#resultsCopy').textContent = ''; showZeroMatch(true); $('#resultsTitle').focus(); }
  updateCheckoutPanel();
  if (currentSearch?.searchId && currentSearch.token) requestApi(`/api/searches/${encodeURIComponent(currentSearch.searchId)}/hide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: currentSearch.token, photoId: photo.photoId }) }).catch(() => {});
}
function renderGallery() {
  $('#gallery').replaceChildren(); $('#favouriteCount').textContent = favourites.size;
  $('#galleryEmpty').hidden = !favouritesOnly || favourites.size > 0;
  photos.forEach((photo, index) => {
    if (favouritesOnly && !favourites.has(index)) return;
    const figure = document.createElement('figure'); figure.className = 'is-loading'; figure.dataset.photoId = photo.photoId;
    const open = document.createElement('button'); open.className = 'photo-open'; open.type = 'button'; open.setAttribute('aria-label', `Open wave ${index + 1}`);
    // The box knows its shape before the image arrives, so an uncropped print never moves the sheet when it loads.
    const aspect = tileAspect(photo); if (aspect) open.style.aspectRatio = aspect;
    const img = document.createElement('img'); img.src = photo.thumbUrl || photo.url; img.alt = unlocked ? `Wave ${index + 1}` : `Wave ${index + 1} preview`; img.loading = 'lazy'; img.decoding = 'async';
    const settle = () => { figure.classList.remove('is-loading', 'is-broken'); open.setAttribute('aria-label', `Open wave ${indexOfPhoto(photo) + 1}`); };
    if (img.complete && img.naturalWidth) settle(); else img.addEventListener('load', settle);
    // An expired link asks for fresh ones (a successful refresh re-renders the grid). Otherwise mark the tile so the
    // CSS shows a retry stamp instead of painting the alt text, and let a tap on it retry the same src.
    const broken = () => { figure.classList.add('is-broken'); open.setAttribute('aria-label', `Photo ${indexOfPhoto(photo) + 1} didn’t load — tap to retry`); };
    img.addEventListener('error', () => { figure.classList.remove('is-loading'); refreshLinks().then(ok => { if (!ok) broken(); }).catch(broken); });
    open.append(img); open.addEventListener('click', () => { if (!figure.classList.contains('is-broken')) return openPhoto(indexOfPhoto(photo)); figure.classList.remove('is-broken'); figure.classList.add('is-loading'); img.src = photo.thumbUrl || photo.url; });
    const favourite = document.createElement('button'); favourite.className = 'favourite'; favourite.textContent = favourites.has(index) ? '♥' : '♡'; favourite.setAttribute('aria-label', `Keep wave ${index + 1}`); favourite.setAttribute('aria-pressed', String(favourites.has(index))); favourite.dataset.index = index;
    favourite.addEventListener('click', () => toggleFavourite(indexOfPhoto(photo), favourite, figure));
    const caption = document.createElement('figcaption'); const label = document.createElement('span'); label.textContent = `WAVE ${String(index + 1).padStart(2, '0')} · ${unlocked ? 'ORIGINAL' : 'PREVIEW'}`; caption.append(label);
    if (unlocked && photo.downloadUrl) { const download = document.createElement('a'); download.href = photo.downloadUrl; download.textContent = 'Download'; download.setAttribute('aria-label', `Download wave ${index + 1}`); caption.append(download); }
    // Previews only: once the pack is paid for these are the guest's originals and there is nothing to disown.
    else if (!unlocked && photo.photoId) { const hide = document.createElement('button'); hide.type = 'button'; hide.className = 'hide-photo'; hide.textContent = 'Not me'; hide.setAttribute('aria-label', `Not me, hide wave ${index + 1}`); hide.addEventListener('click', () => hidePhoto(photo, figure)); caption.append(hide); }
    figure.append(open, favourite, caption); $('#gallery').append(figure);
  });
  syncActionBar();
}
$('#favouritesFilter').addEventListener('click', () => { favouritesOnly = !favouritesOnly; $('#favouritesFilter').setAttribute('aria-pressed', String(favouritesOnly)); renderGallery(); });
$('#showAllWaves').addEventListener('click', () => { if (favouritesOnly) $('#favouritesFilter').click(); });
$('#tryAgain').addEventListener('click', () => { showSearch(); $('#selfieInput').focus({ preventScroll: true }); });
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
// A horizontal drag moves to the neighbour when it is long (over 40px) or quick: a flick of 20px+ at 0.5px/ms or faster,
// measured over the whole drag, so a short fast swipe on a phone still turns the page.
function swipeAdvances(dx, ms) { const d = Math.abs(dx); return d > 40 || (d >= 20 && ms > 0 && d / ms >= 0.5); }
// Touch: a horizontal drag of 40px+ (or a fast flick, see swipeAdvances) moves to the neighbour. A double-tap (two clean taps within 300 ms and 24 px) zooms
// 2.2× around the tap point and another double-tap zooms back out — a single tap does nothing. While zoomed a drag pans
// (clamped to the frame) and a two-finger pinch scales 1–4×. The transform is inline (origin = centre), so the CSS only
// needs the .is-zoomed / .is-sliding hooks; .is-sliding also switches the transform transition off so panning and pinching
// track the finger instead of easing after it. Only the zoom step itself carries an inline 320 ms spring, iOS-style.
(() => {
  const stage = $('#lightboxStage'), image = $('#lightboxImage'), pointers = new Map();
  let startX = 0, startY = 0, startT = 0, dragging = false, moved = false, panX = 0, panY = 0, scale = 1, pinchStart = 1, pinchScale = 1;
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
    dragging = true; moved = false; startX = event.clientX - panX; startY = event.clientY - panY; startT = event.timeStamp;
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
    // The browser took the pointer away (a scroll or a system gesture won it). Chromium reports clientX 0 on that
    // event, which would read as a full-width flick to the left: put the slide back and stay on this photo.
    if (event.type === 'pointercancel') { lastTap = null; if (scale <= 1) image.style.transform = ''; return; }
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
    if (swipeAdvances(dx, event.timeStamp - startT)) openPhoto(photoIndex + (dx < 0 ? 1 : -1));
  };
  stage.addEventListener('pointerup', finish); stage.addEventListener('pointercancel', finish);
  // Desktop: a native double-click does the same. A fast mouse pair is usually caught by the pointer events first (and
  // some Android browsers fire dblclick for a touch pair too), so a toggle that just happened is not repeated.
  stage.addEventListener('dblclick', event => { event.preventDefault(); if (performance.now() - lastZoomAt > 400) toggleZoom(event.clientX, event.clientY); });
})();
// ── Share (WhatsApp) ──────────────────────────────────────────────────────
// Web Share where the browser has it (phones, and desktop Chrome/Safari open the OS sheet), else a wa.me link in a new tab. The text is
// only ever the session title and the public site URL — never a signed preview link, never the search token — except the one
// post-payment button that deliberately sends the guest's own 30-day gallery link (a bearer link, and the hint under it says so).
const siteUrl = () => `${location.origin}${location.pathname}`;
function shareText({ title, url } = {}) {
  const session = (title || resultsBase.split(' · ').pop() || '').trim();
  return `${session ? `${session} — ` : ''}Surfers of India shot the session. Find your waves: ${url || siteUrl()}`;
}
const whatsappUrl = text => `https://wa.me/?text=${encodeURIComponent(text)}`;
async function share(text, url) {
  const payload = { title: 'Surfers of India', text, url };
  if (typeof navigator.share === 'function' && (!navigator.canShare || navigator.canShare(payload))) {
    try { await navigator.share(payload); return 'shared'; } catch (error) { if (error?.name === 'AbortError') return 'cancelled'; }
  }
  window.open(whatsappUrl(`${text}`), '_blank', 'noopener');
  return 'whatsapp';
}
// The 30-day link: this page with ?gallery=<searchId>.<galleryToken>, rebuilt from what saveGallery() kept, so it always carries the
// long-lived token rather than the 45-minute search one. Opening it on another device stores the same record and reopens the gallery.
function galleryLink() {
  const saved = loadSavedGallery();
  return saved && currentSearch?.searchId === saved.searchId ? `${siteUrl()}?gallery=${encodeURIComponent(saved.searchId)}.${encodeURIComponent(saved.token)}` : null;
}
$('#shareResults')?.addEventListener('click', () => { window.SOI?.haptic?.([10]); share(shareText(), siteUrl()); });
$('#sharePhoto')?.addEventListener('click', () => { window.SOI?.haptic?.([10]); share(shareText(), siteUrl()); });
$('#shareGallery')?.addEventListener('click', () => {
  const link = galleryLink(); if (!link) return;
  window.SOI?.haptic?.([10]);
  share(`My Surfers of India photos (the link opens them for 30 days): ${link}`, link);
});
// The 30-day link's query in either spelling: ?gallery=<searchId>.<token> (the page's own share link, and what the Worker
// mints now) or ?gallery=<searchId>&token=<token> (links the Worker sent out before the dotted form). Null when malformed.
function galleryLinkParams(search) {
  const params = new URLSearchParams(search); const raw = params.get('gallery'); if (!raw) return null;
  const separate = params.get('token'); const dot = raw.indexOf('.');
  const searchId = separate ? raw : dot > 0 ? raw.slice(0, dot) : '', token = separate || (dot > 0 ? raw.slice(dot + 1) : '');
  return searchId && token ? { searchId, token } : null;
}
// A gallery link opened on this device: the query is dropped from the URL at once and the originals are opened through the
// same path as the resume notice; the record is saved for 30 days only if the Worker accepts the token.
function resumeGalleryFromLink() {
  if (!new URLSearchParams(location.search).has('gallery')) return false;
  const link = galleryLinkParams(location.search);
  history.replaceState(null, '', location.pathname + location.hash);
  if (!link) return false;
  openGallery({ ...link, session: null }, null);
  return true;
}
function returnToSearch() { showSearch(); }
$('#backHome').addEventListener('click', returnToSearch);
// In-page links leave the results view and cancel a running search — except links inside the search form (the consent
// label's privacy link, which should simply scroll to its target) and inside the results view (the Download-all link
// starts out as href="#" and must not send a paid guest back to the finder).
function leavesResults(link) { return !link.closest('#searchForm,#results'); }
document.querySelectorAll('a[href^="#"]').forEach(link => { if (!leavesResults(link)) return; link.addEventListener('click', () => { searchController?.abort(); showSearch({ scroll: false }); }); });
window.addEventListener('pagehide', event => { if (!event.persisted && previewUrl) URL.revokeObjectURL(previewUrl); searchController?.abort(); });
// Cashfree appends ?order_id= to the return URL after a redirect-style payment (UPI apps, netbanking).
async function resumeCheckoutFromRedirect() {
  const orderId = new URLSearchParams(location.search).get('order_id');
  if (!orderId) return;
  history.replaceState(null, '', location.pathname + location.hash);
  let stored = null;
  try { stored = JSON.parse(sessionStorage.getItem('mjCheckout') || localStorage.getItem('mjCheckout') || 'null'); } catch { stored = null; }
  const lost = !stored?.searchId || !stored?.token || (stored.orderId && stored.orderId !== orderId);
  resultsBase = ''; $('#resultsMeta').textContent = ''; $('#resultsCopy').textContent = ''; renderConditions(null);
  $('#resultsTitle').textContent = lost ? 'Payment received.' : 'Confirming…';
  $('#indexingBanner').hidden = true; showZeroMatch(false); $('#unlockButton').hidden = true; $('#checkoutNotice').hidden = true;
  showResults();
  if (lost) {
    // The browser that finished the payment isn't the one that ran the search (common when a UPI
    // app returns to a new tab). Say so instead of silently showing the landing page.
    $('#resultsCopy').textContent = `Order ${orderId} is paid, but this browser doesn’t know your search. Go back to the tab you searched in, or email namaste@surfersofindia.com with your number and order ${orderId}.`;
    return;
  }
  try {
    currentSearch = { searchId: stored.searchId, token: stored.token };
    photos = []; loadHidden(); colourMode = false;
    await confirmPayment(orderId);
    restoreFavourites(); renderGallery(); setResultsCount();   // hearts picked before the UPI app took over
    $('#resultsTitle').textContent = 'Paid.'; $('#resultsCopy').textContent = 'These are the originals — tap one, then Download.';
  } catch (error) { $('#resultsTitle').textContent = 'Paid, but…'; $('#resultsCopy').textContent = `${error.message} Order ${orderId}. Still stuck? Email namaste@surfersofindia.com with your number.`; }
}
resumeCheckoutFromRedirect();
showResumeNotice();
loadSessions().finally(resumeGalleryFromLink);   // after the session list: loadSessions() owns the status line until then
