// Surfers of India crew studio.
const apiBase = (window.MJ_CONFIG?.apiUrl || '').replace(/\/$/, '');
const isLive = Boolean(apiBase);
const apiUrl = (path) => path.startsWith('http') ? path : `${apiBase}${path}`;

// ── Auth helpers ──────────────────────────────────────────────────────────────

function getToken() { return sessionStorage.getItem('mj-admin-token') || ''; }
function setToken(t) { sessionStorage.setItem('mj-admin-token', t); }
function clearToken() { sessionStorage.removeItem('mj-admin-token'); }
function isAuthenticated() { return Boolean(getToken()); }

async function apiRequest(path, options = {}) {
  if (!isLive) throw new Error('API not configured. Add the Worker URL to config.js.');
  const headers = {
    ...(typeof options.body === 'string' ? { 'content-type': 'application/json' } : {}),
    authorization: `Bearer ${getToken()}`,
    ...(options.headers || {}),
  };
  const resp = await fetch(apiUrl(path), { ...options, headers, signal: options.signal || AbortSignal.timeout(90000) });
  const body = await resp.json().catch(() => ({}));
  if (resp.status === 401) { clearToken(); showLogin(); throw new Error('Signed out — sign in again.'); }
  if (!resp.ok) throw new Error(body.error || "That didn't work. Try again?");
  return body;
}

// ── DOM references ────────────────────────────────────────────────────────────

const loginScreen = document.getElementById('loginScreen');
const adminApp    = document.getElementById('adminApp');
const signOutBtn  = document.getElementById('signOutBtn');

// ── Toasts ────────────────────────────────────────────────────────────────────

// Action results used to land in #adminNotice above the tabs — off-screen whenever the crew is
// scrolled into a long session list. A fixed stack is always in view. Open dialogs paint in the
// top layer, above any fixed element, so the stack moves into whichever dialog is open.
const toastRoot = Object.assign(document.createElement('div'), { className: 'soi-toasts' });
toastRoot.setAttribute('aria-live', 'polite');
document.body.append(toastRoot);
const TOAST_ICON = { info: 'stamp-wave', success: 'stamp-sunburst', error: 'stamp-coral' };
function toast(message, kind = 'info', { timeout = kind === 'error' ? 9000 : 5000, action } = {}) {
  const el = document.createElement('div'); el.className = 'soi-toast'; el.dataset.kind = kind;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = `<svg aria-hidden="true"><use href="soi-stamps.svg#${TOAST_ICON[kind] || TOAST_ICON.info}"/></svg><div></div><button type="button" aria-label="Dismiss">×</button>`;
  const body = el.children[1]; body.textContent = message;
  if (action) {
    const run = document.createElement('button'); run.type = 'button'; run.textContent = action.label;
    run.style.cssText = 'min-width:0;min-height:0;margin:4px 0 0;padding:10px 0;font:inherit;text-decoration:underline;opacity:1';
    run.addEventListener('click', () => { el.remove(); action.run(); });
    body.append(document.createElement('br'), run);
  }
  el.lastElementChild.addEventListener('click', () => el.remove());
  const host = [...document.querySelectorAll('dialog[open]')].pop() || document.body;
  if (toastRoot.parentNode !== host) host.append(toastRoot);
  toastRoot.append(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}
// `kind` is explicit ('info' | 'success' | 'error'): errors are announced assertively and shown
// longer, successes get the sunburst stamp. Nothing is inferred from the wording. The login screen
// has no toasts — its inline error slot takes the message instead.
function notifyCrew(message, kind = 'info') {
  if (!loginScreen.classList.contains('hidden')) { document.getElementById('loginError').textContent = message; return; }
  toast(String(message ?? ''), kind);
}

// ── Routing: show login or app ────────────────────────────────────────────────

function showApp() {
  loginScreen.classList.add('hidden');
  adminApp.classList.remove('hidden');
  signOutBtn.classList.remove('hidden');   // show sign-out in topbar
  armIdle(); startHealth();
  // Set today's date as default
  const dateInput = document.getElementById('adminDate');
  if (!dateInput.value) { const now = new Date(); dateInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; }
  // Don't auto-load dashboard — only load when tab is clicked
}

function showLogin() {
  // Stop any running auto-refresh, the idle clock and the health poll
  if (dashInterval) { clearInterval(dashInterval); dashInterval = null; }
  disarmIdle(); stopHealth({ hide: true });
  adminApp.classList.add('hidden');
  loginScreen.classList.remove('hidden');
  signOutBtn.classList.add('hidden');
  document.querySelectorAll('dialog[open]').forEach(modal => modal.close());
  // Reset tabs back to Upload so next login starts fresh
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  document.querySelector('.tab-btn[data-tab="upload"]').classList.add('active');
  document.getElementById('tab-upload').classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(button => { button.setAttribute('aria-selected', String(button.dataset.tab === 'upload')); button.tabIndex = button.dataset.tab === 'upload' ? 0 : -1; });
}



// ── Sign out ──────────────────────────────────────────────────────────────────

signOutBtn.addEventListener('click', () => {
  clearToken();
  showLogin();
});

// ── Login form ────────────────────────────────────────────────────────────────

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('loginError');
  const passwordEl = document.getElementById('adminPassword');
  const btn = e.currentTarget.querySelector('button[type="submit"]');
  errorEl.textContent = '';
  btn.disabled = true; btn.classList.add('is-busy');
  btn.innerHTML = 'Signing in… <span></span>';

  try {
    const result = await fetch(apiUrl('/api/admin/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: passwordEl.value }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await result.json().catch(() => ({}));
    if (!result.ok) throw new Error(body.error || (result.status === 401 ? 'Wrong password.' : result.status === 429 ? 'Too many tries. Wait 15 minutes.' : 'Photo service is down. Try again?'));
    if (typeof body.token !== 'string' || !body.token) throw new Error("Sign-in didn't complete. Refresh and try again.");
    setToken(body.token);
    passwordEl.value = '';
    showApp();
  } catch (err) {
    errorEl.textContent = err.name === 'TimeoutError' ? 'Sign-in timed out. Try again?' : err instanceof TypeError ? "Can't reach the photo service. Check your connection." : err.message;
  } finally {
    btn.disabled = false; btn.classList.remove('is-busy');
    btn.innerHTML = "Let's go";
  }
});

document.getElementById('togglePassword').addEventListener('click', event => {
  const input = document.getElementById('adminPassword');
  const visible = input.type === 'password';
  input.type = visible ? 'text' : 'password';
  event.currentTarget.textContent = visible ? 'Hide' : 'Show';
  event.currentTarget.setAttribute('aria-pressed', String(visible));
});

// ── Tabs ──────────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (dashInterval) { clearInterval(dashInterval); dashInterval = null; }
    document.querySelectorAll('.tab-btn').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); b.tabIndex = -1; });
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active'); btn.setAttribute('aria-selected', 'true'); btn.tabIndex = 0;
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'dashboard') loadDashboard();
    if (btn.dataset.tab === 'verify') { loadVerifyQueue(); loadLinkQueue(); }
  });
});

// ── Modals ────────────────────────────────────────────────────────────────────

const photoGalleryModal = document.getElementById('photoGalleryModal');
const closeGalleryModal = document.getElementById('closeGalleryModal');
const editSessionModal  = document.getElementById('editSessionModal');
const closeEditModal    = document.getElementById('closeEditModal');
const uploadMoreModal   = document.getElementById('uploadMoreModal');
const closeMoreModal    = document.getElementById('closeMoreModal');
const confirmDialog     = document.getElementById('confirmDialog');

function openModal(modal) { modal.classList.remove('hidden'); if (!modal.open) modal.showModal(); }
// The edit form remembers what it opened with so an accidental backdrop click / Escape can't
// silently discard typed changes.
let editSnapshot = '';
const editFormState = () => ['editTitle', 'editDate', 'editLocation', 'editPrice', 'editStatus'].map(id => document.getElementById(id).value).join('\u0000');
const editIsDirty = () => editSessionModal.open && editFormState() !== editSnapshot;
async function closeEditSafely() {
  if (editIsDirty() && !await confirmAction({ title: 'Discard changes?', copy: 'You have unsaved edits to this session.', confirmLabel: 'Discard' })) return false;
  editSessionModal.close(); return true;
}
[photoGalleryModal, editSessionModal, uploadMoreModal, confirmDialog].forEach(modal => {
  modal.addEventListener('close', () => { modal.classList.add('hidden'); if (toastRoot.parentNode === modal) document.body.append(toastRoot); });
  modal.addEventListener('click', event => {
    if (event.target !== modal || (uploadBusy && modal !== confirmDialog)) return;
    if (modal === editSessionModal) { closeEditSafely(); return; }
    modal.close();
  });
  // Escape must not abandon an upload that is still sending files, or drop unsaved edits. The
  // confirm dialog is exempt so "Stop uploading?" can itself be backed out of.
  modal.addEventListener('cancel', event => { if (uploadBusy && modal !== confirmDialog) event.preventDefault(); if (modal === editSessionModal && editIsDirty()) { event.preventDefault(); closeEditSafely(); } });
});
closeGalleryModal.addEventListener('click', () => photoGalleryModal.close());
closeEditModal.addEventListener('click', () => closeEditSafely());
// Promise-based confirm dialog: `typed` asks the crew to type a phrase before a destructive action.
let confirmResolve = null;
function confirmAction({ title, copy, confirmLabel = 'Delete', typed = '' }) {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmCopy').textContent = copy;
  const wrap = document.getElementById('confirmTypedWrap'), input = document.getElementById('confirmTypedInput'), ok = document.getElementById('confirmOkBtn');
  wrap.hidden = !typed; input.value = ''; ok.textContent = confirmLabel; ok.disabled = Boolean(typed);
  document.getElementById('confirmTypedLabel').textContent = typed ? `Type “${typed}” to confirm` : '';
  input.oninput = () => { ok.disabled = input.value.trim() !== typed; };
  confirmResolve?.(false);
  // Enter on a stray keypress must not fire the destructive action: focus Cancel (or the typed field).
  return new Promise(resolve => { confirmResolve = resolve; openModal(confirmDialog); (typed ? input : document.getElementById('confirmCancelBtn')).focus(); });
}
document.getElementById('confirmForm').addEventListener('submit', event => { event.preventDefault(); const resolve = confirmResolve; confirmResolve = null; confirmDialog.close(); resolve?.(true); });
document.getElementById('confirmCancelBtn').addEventListener('click', () => confirmDialog.close());
document.getElementById('closeConfirmDialog').addEventListener('click', () => confirmDialog.close());
confirmDialog.addEventListener('close', () => { const resolve = confirmResolve; confirmResolve = null; resolve?.(false); });
// While a batch is sending, × and Cancel offer to stop it (Escape stays blocked); otherwise they close.
async function stopOrCloseMore() {
  if (!uploadBusy) return uploadMoreModal.close();
  if (await confirmAction({ title: 'Stop uploading?', copy: STOP_UPLOAD_COPY, confirmLabel: 'Stop' })) cancelUpload();
}
closeMoreModal.addEventListener('click', () => stopOrCloseMore());
document.querySelector('.tabs').addEventListener('keydown', event => {
  const buttons = [...document.querySelectorAll('.tab-btn')]; const index = buttons.indexOf(document.activeElement);
  if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next].focus(); buttons[next].click();
});
// ── Upload: preview generation ────────────────────────────────────────────────

// HEIC/HEIF is the iPhone default; its MIME type is often blank, so check the extension too.
const isHeic = file => /image\/hei[cf]/.test(file.type) || /\.hei[cf]$/i.test(file.name);
const imageElementFromFile = file => new Promise((resolve, reject) => {
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't read this file.")); };
  img.src = url;
});
// createImageBitmap first: it decodes HEIC on Safari/macOS and downsamples *during* decode, so a
// 24 MP frame is never allocated (small files skip the resize so they are never upscaled). <img>
// is the fallback for browsers/formats it can't take; a HEIC that fails both fails only that file.
async function imageFromFile(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, file.size > 512 * 1024 ? { resizeWidth: PREVIEW_MAX, resizeQuality: 'high' } : {}); }
    catch { /* fall through to the <img> path */ }
  }
  try { return await imageElementFromFile(file); }
  catch { throw new Error(isHeic(file) ? "This browser can't read HEIC — use Safari or export JPEGs." : "Couldn't read this file."); }
}

const toJpeg = (canvas, quality) => new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Couldn't build the preview.")), 'image/jpeg', quality));
// The wave-crest stamp (soi-stamps.svg #stamp-wave, viewBox 0 0 100 100) as Path2D — no raster asset.
const STAMP_PATHS = typeof Path2D === 'function' ? [
  'M8 78c10-3 18-2 28-8 8-5 13-13 12-24-1-9-8-17-18-18 12-4 26 1 31 13 4 10 1 22-6 30 9-2 16-8 20-16 5-11 2-24-6-32 14 4 24 17 22 33-2 17-16 29-33 30 6 0 12-1 18-3-9 6-21 8-32 6-12-2-24-3-36-1z',
  'M6 86h60c2 0 2 3 0 3H6c-2 0-2-3 0-3zm10 6h34c2 0 2 3 0 3H16c-2 0-2-3 0-3z',
].map(d => new Path2D(d)) : [];
// Guests see this preview until they pay, so it is deliberately useless anywhere else: 300 px on
// the long edge, blurred, then a dense low-alpha diagonal text lattice drawn sharp on top so it can't
// be cropped away, plus the brand stamp in the corner so shares look branded rather than "sample".
// A surfer can still tell it's them; nobody can print it. A 200 px thumbnail (drawn from the
// finished canvas) rides along so grids don't load the 300 px file.
const PREVIEW_MAX = 300;
const PREVIEW_BLUR_PX = 2.2;
async function watermarkedPreview(file) {
  const img = await imageFromFile(file);          // ImageBitmap or HTMLImageElement — both expose width/height
  const scale = Math.min(1, PREVIEW_MAX / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d');
  // 1) blur, before the watermark. Canvas filters where supported (Chrome/Firefox/Safari 18+); the
  // image bleeds past the edges so the filter's transparent falloff lands off-canvas instead of
  // becoming a dark JPEG border. Elsewhere a cheap box blur: draw at 1/3 size and scale back up.
  if ('filter' in ctx) {
    const bleed = Math.ceil(PREVIEW_BLUR_PX * 3);
    ctx.filter = `blur(${PREVIEW_BLUR_PX}px)`;
    ctx.drawImage(img, -bleed, -bleed, canvas.width + bleed * 2, canvas.height + bleed * 2);
    ctx.filter = 'none';
  } else {
    const scratch = document.createElement('canvas');
    scratch.width = Math.max(1, Math.round(canvas.width / 3)); scratch.height = Math.max(1, Math.round(canvas.height / 3));
    scratch.getContext('2d').drawImage(img, 0, 0, scratch.width, scratch.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(scratch, 0, 0, canvas.width, canvas.height);
  }
  img.close?.();                                  // release the decoded bitmap right away
  // 2) anti-crop lattice, sharp on top of the blur
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(-Math.PI / 7);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const size = Math.max(16, Math.round(canvas.width / 22));
  ctx.font = `700 ${size}px "Plus Jakarta Sans", Arial, sans-serif`;
  const stepY = size * 3.4, stepX = size * 10, reach = Math.hypot(canvas.width, canvas.height);
  let row = 0;
  for (let y = -reach; y <= reach; y += stepY, row += 1) {
    for (let x = -reach + (row % 2 ? stepX / 2 : 0); x <= reach; x += stepX) {
      ctx.globalAlpha = .22; ctx.fillStyle = '#2B2018'; ctx.fillText('SURFERS OF INDIA · PREVIEW', x + 1, y + 1);
      ctx.globalAlpha = .42; ctx.fillStyle = '#F2ECDB'; ctx.fillText('SURFERS OF INDIA · PREVIEW', x, y);
    }
  }
  ctx.restore();
  // 3) corner stamp: 11% of the width, padded by 35% of itself, bottom-right
  if (STAMP_PATHS.length) {
    const s = Math.round(canvas.width * .11), pad = Math.round(s * .35);
    ctx.save();
    ctx.translate(canvas.width - s - pad, canvas.height - s - pad); ctx.scale(s / 100, s / 100);
    ctx.globalAlpha = .82; ctx.fillStyle = '#F2ECDB'; ctx.shadowColor = 'rgba(43,32,24,.45)'; ctx.shadowBlur = s * .15;
    STAMP_PATHS.forEach(path => ctx.fill(path));
    ctx.restore();
  }
  const preview = await toJpeg(canvas, .7);
  const thumbScale = Math.min(1, 200 / Math.max(canvas.width, canvas.height));
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.round(canvas.width * thumbScale)); small.height = Math.max(1, Math.round(canvas.height * thumbScale));
  small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
  const thumb = await toJpeg(small, .72);
  return Object.assign(preview, { thumb });
}
// Thumbnails ride along after the main upload. An older Worker (404) or an unmigrated database
// (503) just means tiles keep using the preview — never fail the photo for it.
async function uploadThumb(photoId, thumb) {
  if (!photoId || !thumb) return;
  try { await fetch(apiUrl(`/api/admin/photos/${photoId}/thumb`), { method: 'POST', headers: { authorization: `Bearer ${getToken()}`, 'content-type': 'image/jpeg' }, body: thumb, signal: AbortSignal.timeout(30000) }); }
  catch { /* optional */ }
}

// ── Upload: file selection & drag/drop ────────────────────────────────────────

let adminFiles = [];
let uploadBusy = false;
const dropZone = document.getElementById('adminDropZone');
const photoInput = document.getElementById('adminPhotoInput');

// `kind` ('warning') colours a heads-up that isn't a failure — "1 file left out" must not read as red.
function setStatus(text, isError = false, kind = '') {
  const el = document.getElementById('uploadStatus');
  el.textContent = text;
  el.className = 'upload-status visible' + (isError ? ' error' : '');
  if (kind) el.dataset.kind = kind; else delete el.dataset.kind;
}

function clearStatus() {
  const el = document.getElementById('uploadStatus');
  el.textContent = '';
  el.className = 'upload-status';
  delete el.dataset.kind;
}

function setProgress(percent, speed, eta) {
  const wrap = document.getElementById('progressWrap');
  wrap.classList.remove('hidden');
  document.getElementById('progressFill').style.width = `${Math.min(100, percent)}%`;
  document.getElementById('progressSpeed').textContent = speed ? `${Math.round(speed)} KB/s` : '';
  document.getElementById('progressEta').textContent = eta || '';
}

function hideProgress() {
  const wrap = document.getElementById('progressWrap');
  wrap.classList.add('hidden');
  document.getElementById('progressFill').style.width = '0%';
}

const UNSUPPORTED_FILES = 'JPG, PNG, WebP or HEIC up to 25 MB each.';
function isSupportedPhoto(file) { return (['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || isHeic(file)) && file.size > 0 && file.size <= 25 * 1024 * 1024; }

function selectFiles(files) {
  if (uploadBusy) return;
  const selected = [...files];
  adminFiles = selected.filter(isSupportedPhoto);
  const rejected = selected.filter(file => !isSupportedPhoto(file));
  renderFileList();
  if (!adminFiles.length) { setStatus(rejected.length ? UNSUPPORTED_FILES : 'No photos in that pick. JPG, PNG, WebP or HEIC.', true); return; }
  if (rejected.length) setStatus(`${adminFiles.length} ready. ${rejected.length} left out (JPG, PNG, WebP or HEIC up to 25 MB): ${rejected.slice(0, 3).map(file => file.name).join(', ')}${rejected.length > 3 ? '…' : ''}.`, false, 'warning');
  else setStatus(`${plural(adminFiles.length, 'photo')} ready. Hit Publish.`);
  window.setTimeout(() => document.getElementById('publishBtn').scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
}

// ── Upload: live per-photo rows ───────────────────────────────────────────────

// Object URLs are created lazily per File and revoked when the list that showed them goes away.
const thumbnailUrls = new Map();
function thumbnailFor(file) {
  if (!thumbnailUrls.has(file)) thumbnailUrls.set(file, URL.createObjectURL(file));
  return thumbnailUrls.get(file);
}
function releaseThumbnails(files) {
  for (const file of files) { const url = thumbnailUrls.get(file); if (url) { URL.revokeObjectURL(url); thumbnailUrls.delete(file); } }
}
const ROW_LABELS = { waiting: 'Waiting', uploading: 'Sending…', done: 'Sent', failed: 'Failed', skipped: 'Skipped' };
// One list row: thumbnail with a status overlay, filename + size, optional tag and trailing control.
function photoRow(file, { tag = '', control } = {}) {
  const row = document.createElement('li'); row.className = 'photo-row'; row.dataset.state = 'waiting';
  const thumb = document.createElement('div'); thumb.className = 'photo-row-thumb';
  const image = document.createElement('img'); image.src = thumbnailFor(file); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
  const status = document.createElement('i'); status.className = 'photo-row-status'; status.setAttribute('role', 'img'); status.setAttribute('aria-label', ROW_LABELS.waiting);
  thumb.append(image, status);
  const name = document.createElement('span'); name.className = 'photo-row-name'; name.textContent = file.name;
  const size = document.createElement('small'); size.textContent = `${(file.size / 1048576).toFixed(1)} MB`; name.append(size);
  const badge = document.createElement('em'); badge.className = 'photo-row-tag'; badge.textContent = tag; badge.title = tag;
  row.append(thumb, name, badge);
  if (control) row.append(control);
  return row;
}
function setRowState(row, state, { tag, kind, title } = {}) {
  if (!row) return;
  row.dataset.state = state;
  const status = row.querySelector('.photo-row-status');
  status.setAttribute('aria-label', title || ROW_LABELS[state] || state); status.title = title || '';
  if (tag !== undefined) { const badge = row.querySelector('.photo-row-tag'); badge.textContent = tag; badge.title = tag; if (kind) badge.dataset.kind = kind; else delete badge.dataset.kind; }
  if (state === 'uploading') row.scrollIntoView({ block: 'nearest' });
}
// Translate one upload result into a row state so both flows show identical ticks.
function markRowFromResult(row, state, detail) {
  if (state === 'failed') return setRowState(row, 'failed', { tag: 'Failed', kind: 'error', title: detail?.message });
  if (state === 'waiting') return setRowState(row, 'waiting', { tag: detail?.cancelled ? 'Not sent' : '' });
  if (state !== 'done') return setRowState(row, state, { tag: '' });
  if (detail?.skipped) return setRowState(row, 'skipped', { tag: 'Already here' });
  if (detail?.duplicate === 'renamed') return setRowState(row, 'done', { tag: `Saved as ${detail.filename}`, kind: 'ok' });
  if (detail?.duplicate === 'replaced') return setRowState(row, 'done', { tag: 'Replaced', kind: 'ok' });
  setRowState(row, 'done', { tag: '' });
}

let queueFiles = []; // Files whose thumbnails the Upload tab list currently shows.
function renderFileList() {
  document.getElementById('publishBtn').disabled = uploadBusy || !adminFiles.length;
  const container = document.getElementById('fileQueue'); container.replaceChildren(); container.hidden = !adminFiles.length;
  delete container.dataset.uploading; delete container.dataset.finished;
  releaseThumbnails(queueFiles.filter(file => !adminFiles.includes(file)));
  queueFiles = [...adminFiles];
  if (!adminFiles.length) return;
  const header = document.createElement('div'); header.className = 'file-queue-head';
  const summary = document.createElement('strong'); summary.textContent = `${adminFiles.length} photos · ${(adminFiles.reduce((sum, file) => sum + file.size, 0) / 1048576).toFixed(1)} MB`;
  const clear = document.createElement('button'); clear.type = 'button'; clear.textContent = 'Clear'; clear.disabled = uploadBusy;
  clear.addEventListener('click', () => { adminFiles = []; photoInput.value = ''; renderFileList(); clearStatus(); });
  header.append(summary, clear); const list = document.createElement('ul'); list.className = 'photo-list';
  adminFiles.forEach((file, index) => {
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove'; remove.disabled = uploadBusy; remove.setAttribute('aria-label', `Remove ${file.name}`);
    remove.addEventListener('click', () => { adminFiles.splice(index, 1); renderFileList(); });
    list.append(photoRow(file, { control: remove }));
  });
  container.append(header, list);
}
document.getElementById('choosePhotos').addEventListener('click', () => photoInput.click());
// A selection that hasn't been published is work too: 300 picked photos vanish on a pull-to-refresh
// or "Back to site". `leaving` lets a confirmed back-link click through without a second prompt.
let leaving = false;
const hasPendingWork = () => uploadBusy || adminFiles.length > 0 || Boolean(uploadMoreModal.open && moreUpload?.items?.length);
window.addEventListener('beforeunload', event => { if (leaving || !hasPendingWork()) return; event.preventDefault(); event.returnValue = ''; });
document.querySelector('.back-link')?.addEventListener('click', async event => {
  if (!adminFiles.length || uploadBusy) return;   // mid-upload the native beforeunload prompt already guards the tab
  event.preventDefault();
  const href = event.currentTarget.href, count = adminFiles.length;
  if (!await confirmAction({ title: 'Leave the studio?', copy: `${plural(count, 'photo')} not published yet — leaving drops ${count === 1 ? 'it' : 'them'}.`, confirmLabel: 'Leave' })) return;
  leaving = true; window.location.assign(href);
});

photoInput.addEventListener('click', (e) => { e.target.value = null; });
photoInput.addEventListener('change', (e) => selectFiles(e.target.files));
['dragenter', 'dragover'].forEach((t) => dropZone.addEventListener(t, (e) => { e.preventDefault(); dropZone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((t) => dropZone.addEventListener(t, (e) => { e.preventDefault(); dropZone.classList.remove('dragging'); }));
dropZone.addEventListener('drop', (e) => selectFiles(e.dataTransfer.files));

// ── Upload: shared batch sender ───────────────────────────────────────────────

// Keep concurrent uploads under a memory budget: the Worker buffers each original fully,
// so several large files at once can exceed its limit and drop connections.
const UPLOAD_MAX_WORKERS = 3;
const UPLOAD_BYTE_BUDGET = 20 * 1024 * 1024; // ~20 MB of originals in flight at once (buffering server)
const UPLOAD_MAX_ATTEMPTS = 3;
// When the Worker streams uploads straight to storage it no longer holds whole files in
// memory, so many can run at once. Turn this on ONLY once that Worker path is deployed —
// against an old (buffering) Worker the streaming request format fails.
const UPLOAD_STREAMING = true;
const UPLOAD_STREAM_WORKERS = 12;
// A wall-clock timeout kills every file on a slow uplink (12 streams on a 2 Mbps hotspot ≈ 6 min a
// file). Abort only when no bytes have moved for UPLOAD_STALL_MS; once the body is fully sent, give
// the Worker UPLOAD_RESPONSE_MS to answer.
const UPLOAD_STALL_MS = 30000;
const UPLOAD_RESPONSE_MS = 90000;
// The streams share one uplink: start modest and let the measured KB/s decide how many run at once.
let uploadConcurrency = 4;
function tuneConcurrency(kbps) { uploadConcurrency = kbps > 4000 ? 12 : kbps > 1500 ? 8 : kbps > 500 ? 4 : 2; }
// Cancel: abort every in-flight request; workers stop taking new items and the batch resolves.
let cancelled = false;
const liveRequests = new Set();
function cancelUpload() { if (!uploadBusy) return; cancelled = true; liveRequests.forEach(xhr => xhr.abort()); }
const cancelledError = () => Object.assign(new Error('Stopped.'), { cancelled: true });
const STOP_UPLOAD_COPY = "What's sent stays in the draft. Add the rest later.";
// Preview decode gate: a 24 MP frame is ~96 MB RGBA, so 12 parallel uploads must not decode 12 at
// once. Two at a time, independent of the network pool; a finishing decode hands its slot straight on.
const decodeGate = (() => {
  let active = 0; const waiting = []; const MAX = 2;
  return async fn => {
    if (active >= MAX) await new Promise(resolve => waiting.push(resolve)); else active += 1;
    try { return await fn(); }
    finally { const next = waiting.shift(); if (next) next(); else active -= 1; }
  };
})();

// Send originals plus watermarked previews and report combined progress.
// Each item is { file, onDuplicate? }. onItem(index, state, detail) fires as each photo starts and finishes.
// Resolves with per-file results and failures, plus `stopped` and the `unsent` items after a cancel.
async function uploadPhotoBatch(sessionId, items, onProgress, onItem = () => {}) {
  const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0);
  const startTime = performance.now();
  const fileProgress = new Array(items.length).fill(0);
  let active = 0; const slotWaiters = [];
  const wakeSlots = () => slotWaiters.splice(0).forEach(resolve => resolve());
  const report = () => {
    const uploaded = fileProgress.reduce((a, b) => a + b, 0);
    const elapsed = (performance.now() - startTime) / 1000;
    const speed = (uploaded / 1024) / Math.max(elapsed, 0.1);
    const remaining = Math.max(0, totalBytes - uploaded) / 1024;
    // The first seconds are ramp-up noise; after that the link speed sets the pool size.
    if (elapsed >= 3 && uploaded > 0) { const before = uploadConcurrency; tuneConcurrency(speed); if (uploadConcurrency > before) wakeSlots(); }
    onProgress(Math.round((uploaded / totalBytes) * 100), speed, speed > 0 ? `ETA: ${Math.ceil(remaining / speed)}s` : '');
  };

  const uploadOne = (item, preview, index) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let body;
    if (UPLOAD_STREAMING) {
      // Body: [uint32 preview length LE][preview][original]; metadata rides in the query string.
      const header = new Uint8Array(4); new DataView(header.buffer).setUint32(0, preview.size, true);
      body = new Blob([header, preview, item.file]);
      const params = new URLSearchParams({ type: item.file.type, filename: item.file.name });
      if (item.onDuplicate) params.set('onDuplicate', item.onDuplicate);
      xhr.open('POST', apiUrl(`/api/admin/sessions/${sessionId}/photos?${params}`));
      xhr.setRequestHeader('authorization', `Bearer ${getToken()}`);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
    } else {
      const form = new FormData();
      form.append('file', item.file);
      form.append('preview', preview, `${item.file.name.replace(/\.[^.]+$/, '')}-preview.jpg`);
      if (item.onDuplicate) form.append('onDuplicate', item.onDuplicate);
      body = form;
      xhr.open('POST', apiUrl(`/api/admin/sessions/${sessionId}/photos`));
      xhr.setRequestHeader('authorization', `Bearer ${getToken()}`);
    }
    const failRetryable = (message) => reject(Object.assign(new Error(message), { retryable: true }));
    let stall = null, stallReason = 'Stalled — nothing sent for 30 s.';
    const watch = (ms) => { clearTimeout(stall); stall = setTimeout(() => xhr.abort(), ms); };
    xhr.onabort = () => cancelled ? reject(cancelledError()) : failRetryable(stallReason);
    xhr.upload.onprogress = (ev) => {
      watch(UPLOAD_STALL_MS);                     // bytes moved: push the stall deadline out
      if (!ev.lengthComputable) return;
      fileProgress[index] = Math.min(item.file.size, item.file.size * ev.loaded / ev.total);
      report();
    };
    xhr.upload.onload = () => { stallReason = 'Timed out.'; watch(UPLOAD_RESPONSE_MS); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        fileProgress[index] = item.file.size; report();
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error('Bad reply from the photo service.')); }
      } else {
        let detail = `HTTP ${xhr.status}`;
        try { detail = JSON.parse(xhr.responseText).error || detail; } catch { /* Non-JSON gateway response. */ }
        // 5xx and gateway responses are usually transient (the Worker was overloaded); 4xx are not.
        reject(Object.assign(new Error(detail), { retryable: xhr.status >= 500 }));
      }
    };
    xhr.onerror = () => failRetryable('Network dropped.');
    xhr.onloadend = () => { clearTimeout(stall); liveRequests.delete(xhr); };
    liveRequests.add(xhr); watch(UPLOAD_STALL_MS);
    xhr.send(body);
  });

  // Retry transient failures (network drop / stall / overloaded Worker) a couple of times.
  const uploadWithRetry = async (item, index, preview) => {
    for (let attempt = 1; ; attempt += 1) {
      if (cancelled) throw cancelledError();
      try { return await uploadOne(item, preview, index); }
      catch (error) {
        if (!error.retryable || attempt >= UPLOAD_MAX_ATTEMPTS) throw error;
        await new Promise(resolve => setTimeout(resolve, 700 * attempt));
      }
    }
  };

  // A buffering Worker holds each original in memory, so cap the bytes in flight (not just the
  // request count) to stay under its limit; a file larger than the budget uploads alone. A
  // streaming Worker doesn't buffer, so we lift the byte cap and just run many at once.
  const byteBudget = UPLOAD_STREAMING ? Infinity : UPLOAD_BYTE_BUDGET;
  const workerCount = UPLOAD_STREAMING ? UPLOAD_STREAM_WORKERS : UPLOAD_MAX_WORKERS;
  let inFlightBytes = 0; const waiters = [];
  const acquire = (bytes) => (inFlightBytes === 0 || inFlightBytes + bytes <= byteBudget)
    ? (inFlightBytes += bytes, Promise.resolve())
    : new Promise(resolve => waiters.push({ bytes, resolve }));
  const release = (bytes) => {
    inFlightBytes -= bytes;
    for (let i = 0; i < waiters.length; ) {
      if (inFlightBytes === 0 || inFlightBytes + waiters[i].bytes <= byteBudget) { inFlightBytes += waiters[i].bytes; waiters.splice(i, 1)[0].resolve(); }
      else i += 1;
    }
  };

  onProgress(0, 0, 'starting…');
  const queue = items.map((item, index) => ({ item, index }));
  const results = []; const failures = [];
  // Spawn the full pool; a worker only takes an item while the live limit allows, so a downgrade to
  // 2 streams bites mid-batch and an upgrade to 12 wakes the idle ones. Cancel drains the pool.
  const limit = () => UPLOAD_STREAMING ? uploadConcurrency : workerCount;
  await Promise.all(Array.from({ length: Math.min(workerCount, queue.length) }, async () => {
    while (queue.length && !cancelled) {
      if (active >= limit()) { await new Promise(resolve => slotWaiters.push(resolve)); continue; }
      active += 1;
      const { item, index } = queue.shift();
      await acquire(item.file.size);
      onItem(index, 'uploading');
      try {
        if (cancelled) throw cancelledError();
        const preview = await decodeGate(() => watermarkedPreview(item.file));
        if (cancelled) throw cancelledError();
        const result = await uploadWithRetry(item, index, preview); results.push(result); onItem(index, 'done', result);
        if (result?.photoId && !result.skipped) await uploadThumb(result.photoId, preview.thumb);
      }
      catch (error) { failures.push({ item, message: `${item.file.name}: ${error.message}` }); onItem(index, error.cancelled ? 'waiting' : 'failed', error); }
      finally { release(item.file.size); active -= 1; wakeSlots(); }
    }
  }));
  return { results, failures, stopped: cancelled, unsent: queue.map(entry => entry.item) };
}

// ── Upload: publish ───────────────────────────────────────────────────────────

document.getElementById('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (uploadBusy) return;
  if (!adminFiles.length) return setStatus('Drop at least one photo first.', true);

  const publishBtn = document.getElementById('publishBtn');
  const queueEl = document.getElementById('fileQueue');
  const rows = [...queueEl.querySelectorAll('.photo-row')];
  uploadBusy = true;
  // Everything in the form locks except the cancel button inside the progress card.
  document.querySelectorAll('#uploadForm input, #uploadForm button:not(#cancelUploadBtn)').forEach(control => { control.disabled = true; });
  signOutBtn.disabled = true;
  queueEl.dataset.uploading = 'true';
  publishBtn.disabled = true;
  publishBtn.innerHTML = 'Publishing… <span></span>'; publishBtn.classList.add('is-busy');
  hideProgress();
  // Leave the ticked list on screen; "Clear list" or a new selection resets it.
  const leaveTickedList = (done, label) => {
    adminFiles = [];
    photoInput.value = '';
    queueEl.dataset.finished = 'true';
    queueEl.querySelector('.file-queue-head strong').textContent = `${done} of ${rows.length} photo${rows.length === 1 ? '' : 's'} ${label}`;
    queueEl.querySelector('.file-queue-head button').textContent = 'Clear';
    setProgress(100, 0, '');
  };

  try {
    const title = document.getElementById('adminTitle').value.trim();
    const date = document.getElementById('adminDate').value;
    const location = document.getElementById('adminLocation').value.trim();
    const pricePaise = Math.round(Number(document.getElementById('adminPrice').value) * 100);

    // Pre-flight with the cheapest authenticated GET: an expired token is caught here, not after a
    // draft exists and 300 uploads have started failing one by one.
    await apiRequest('/api/admin/dashboard');
    const create = await apiRequest('/api/admin/sessions', {
      method: 'POST',
      body: JSON.stringify({ title, date, location, pricePaise }),
    });

    const sessionId = create.session.id;
    setStatus(`Uploading ${adminFiles.length} photo${adminFiles.length === 1 ? '' : 's'}…`);
    const { results, failures, stopped } = await uploadPhotoBatch(sessionId, adminFiles.map(file => ({ file })), setProgress, (index, state, detail) => markRowFromResult(rows[index], state, detail));
    if (stopped) {
      // The draft stays private: what landed can be published from Sessions, the rest added via "Upload more".
      leaveTickedList(results.length, 'in the draft');
      setStatus(`Stopped. ${results.length} of ${rows.length} are in the draft — publish or add the rest from Sessions.`, false, 'warning');
      hideProgress();
      return;
    }
    if (!results.length) throw new Error(`All ${failures.length} failed. The draft is still private — check Sessions. ${failures[0].message}`);

    // Publish whatever uploaded successfully; failed files (if any) can be added afterwards via "Upload more".
    await apiRequest(`/api/admin/sessions/${sessionId}/publish`, { method: 'POST' });
    leaveTickedList(results.length, 'published');
    window.SOI?.haptic?.([15]);
    if (failures.length) {
      setStatus(`Live with ${results.length} of ${results.length + failures.length}. ${failures.length} failed — Sessions → Add photos to retry. ${failures[0].message}`, true);
    } else {
      setStatus('Live. Faces are indexing — watch it in Sessions.');
      window.SOI?.splash?.({ at: publishBtn, symbol: 'stamp-sunburst', count: 12 });
    }
    flagFinishedInTitle('Live · Crew Studio');

    hideProgress();
  } catch (err) {
    setStatus(err.message || 'Upload failed. The draft is still private.', true);
    if (!isAuthenticated()) notifyCrew(err.message, 'error');   // kicked to the login screen: say why there too
    hideProgress();
  } finally {
    cancelled = false;
    uploadBusy = false;
    document.querySelectorAll('#uploadForm input, #uploadForm button').forEach(control => { control.disabled = false; });
    signOutBtn.disabled = false;
    publishBtn.innerHTML = 'Publish'; publishBtn.classList.remove('is-busy');
    publishBtn.disabled = !adminFiles.length;
    delete queueEl.dataset.uploading;
    queueEl.querySelectorAll('button').forEach(control => { control.disabled = false; });
  }
});

// ── Upload: cancel ────────────────────────────────────────────────────────────

document.getElementById('cancelUploadBtn')?.addEventListener('click', async event => {
  event.preventDefault();                          // never let it submit the form it sits in
  if (!uploadBusy) return;
  if (!await confirmAction({ title: 'Stop uploading?', copy: STOP_UPLOAD_COPY, confirmLabel: 'Stop' })) return;
  cancelUpload();
});

// ── Dashboard ─────────────────────────────────────────────────────────────────

let dashInterval = null;

const sessionDateLabel = value => { const date = new Date(`${value}T12:00:00`); return Number.isNaN(date.getTime()) ? (value || '—') : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); };
async function loadDashboard(silent = false) {
  const grid = document.getElementById('dashboardGrid');
  if (!isAuthenticated()) return;
  // A background poll that re-renders while the crew is hovering or tabbing through a card steals
  // their focus/hover mid-click; wait for the next tick instead.
  if (silent && (grid.matches(':hover, :focus-within') || document.querySelector('dialog[open]'))) return;
  if (!silent) grid.innerHTML = '<p class="loading-msg">Loading sessions…</p>';
  try {
    const requestToken = getToken();
    const { sessions } = await apiRequest('/api/admin/dashboard');
    if (!isAuthenticated() || getToken() !== requestToken) return;
    if (!sessions.length) {
      grid.innerHTML = '<p class="empty-msg">No sessions yet. Upload one.</p>';
      updateMetrics([]);
      if (dashInterval) { clearInterval(dashInterval); dashInterval = null; }
      return;
    }

    updateMetrics(sessions);

    let hasPending = false;
    const openMenu = grid.querySelector('.card-more[open]')?.closest('.d-card')?.dataset.sessionId;   // survive a silent re-render
    grid.innerHTML = sessions.map((s) => {
      const total = Number(s.total_photos || 0);
      const indexed = Number(s.indexed_photos || 0);
      const pending = Number(s.pending_photos || 0);
      const failed = Number(s.failed_photos || 0);
      const pct = total > 0 ? Math.round((indexed / total) * 100) : 0;
      const isDone = total > 0 && indexed === total;

      if (pending > 0) hasPending = true;

      let badgeHtml = '';
      if (total === 0) {
        badgeHtml = `<span class="indexing-badge empty">Empty</span>`;
      } else if (isDone) {
        badgeHtml = `<span class="indexing-badge done">Indexed</span>`;
      } else if (pending > 0) {
        badgeHtml = `<span class="indexing-badge processing"><span class="pulse-dot"></span> Indexing · ${pct}%</span>`;
      } else if (failed > 0) {
        badgeHtml = `<span class="indexing-badge warning">${failed} failed</span>`;
      } else {
        badgeHtml = `<span class="indexing-badge processing">${pct}% indexed</span>`;
      }

      const priceRs = Math.round((s.price_paise ?? 70000) / 100);

      return `
        <div class="d-card" data-session-id="${escHtml(s.id)}">
          <div class="d-card-head">
            <span class="d-card-title">${escHtml(s.title)}</span>
            <div style="display:flex;gap:8px;align-items:center;">
              ${badgeHtml}
              <span class="d-card-status ${escHtml(s.status)}">${escHtml(s.status)}</span>
            </div>
          </div>
          <div class="d-card-stats">
            <div><span>Date</span><strong style="font-size:13px;font-weight:500">${escHtml(sessionDateLabel(s.date))}</strong></div>
            <div><span>Break</span><strong style="font-size:13px;font-weight:500">${escHtml(s.location || '—')}</strong></div>
            <div><span>Indexed</span><strong>${pct}% (${indexed} / ${total})</strong></div>
            <div><span>Failed</span><strong>${failed}</strong></div>
            <div class="spacer"></div>
          </div>
          ${total > 0 ? `
            <div class="card-progress-track">
              <div class="card-progress-fill" style="width: ${pct}%;"></div>
            </div>
          ` : ''}
          <div class="action-group">
            ${s.status === 'draft' ? `<button class="btn-sm btn-publish publish-session-btn" data-session-id="${escHtml(s.id)}" data-session-title="${escHtml(s.title)}" ${total ? '' : 'disabled title="Add photos first."'}>Publish</button>` : ''}
            <button class="btn-sm btn-primary-sm view-photos-btn" data-session-id="${escHtml(s.id)}" data-session-title="${escHtml(s.title)}">Photos (${total})</button>
            <button class="btn-sm upload-more-btn" data-session-id="${escHtml(s.id)}" data-session-title="${escHtml(s.title)}" ${s.status === 'archived' ? 'disabled title="Archived — restore it first."' : ''}>Add photos</button>
            <details class="card-more">
              <summary class="btn-sm">More</summary>
              <div class="card-more-menu">
                <button class="btn-sm edit-session-btn" data-session-id="${escHtml(s.id)}" data-title="${escHtml(s.title)}" data-date="${escHtml(s.date || '')}" data-location="${escHtml(s.location || '')}" data-price="${priceRs}" data-status="${escHtml(s.status)}">Edit</button>
                ${failed > 0 && pending === 0 ? `<button class="btn-sm btn-retry retry-failed-btn" data-session-id="${escHtml(s.id)}">Retry ${failed} failed</button>` : ''}
                <button class="btn-sm reindex-btn" data-session-id="${escHtml(s.id)}">Force reindex</button>
                ${s.status === 'archived' ? `<button class="btn-sm restore-session-btn" data-session-id="${escHtml(s.id)}">Restore</button>` : ''}
                <button class="delete-btn" data-session-id="${escHtml(s.id)}">Delete</button>
              </div>
            </details>
          </div>
        </div>
      `;
    }).join('');
    if (openMenu) { const menu = grid.querySelector(`.d-card[data-session-id="${CSS.escape(openMenu)}"] .card-more`); if (menu) menu.open = true; }

    if (hasPending && !dashInterval && document.getElementById('tab-dashboard').classList.contains('active')) {
      dashInterval = setInterval(() => { if (!document.hidden) loadDashboard(true); }, 8000);
    } else if (!hasPending && dashInterval) {
      clearInterval(dashInterval); dashInterval = null;
    }
  } catch (err) {
    if (!silent) grid.innerHTML = `<p class="loading-msg error-msg">${escHtml(err.message)}</p>`;
  }
}

function updateMetrics(sessions) {
  const total = field => sessions.reduce((sum, session) => sum + Number(session[field] || 0), 0);
  document.getElementById('statIndexed').textContent = total('indexed_photos').toLocaleString('en-IN');
  document.getElementById('statFailed').textContent = total('failed_photos').toLocaleString('en-IN');
  document.getElementById('statPhotos').textContent = total('total_photos').toLocaleString('en-IN');
  document.getElementById('statSessions').textContent = sessions.filter(session => session.status === 'published').length;
}

// ── View Session Photos Modal ────────────────────────────────────────────────

async function viewSessionPhotos(sessionId, sessionTitle) {
  const modal = document.getElementById('photoGalleryModal');
  const titleEl = document.getElementById('galleryModalTitle');
  const grid = document.getElementById('galleryGrid');
  
  titleEl.textContent = sessionTitle;
  grid.innerHTML = '<p class="loading-msg">Loading…</p>';
  openModal(modal);

  try {
    const { photos, coverPhotoId } = await apiRequest(`/api/admin/sessions/${sessionId}/photos`);
    grid.dataset.sessionId = sessionId;
    if (!photos.length) {
      grid.innerHTML = '<p class="empty-msg">Nothing here yet.</p>';
      return;
    }
    grid.innerHTML = `<p class="cover-hint">Pick a cover for the site — a lineup or wave shot, nothing with a recognisable face. Until then it shows the wave illustration.</p>` + photos.map((p) => `
      <div class="photo-card${p.id === coverPhotoId ? ' is-cover' : ''}" id="photo-card-${escHtml(p.id)}" data-status="${escHtml(p.indexing_status)}">
        <img src="${escHtml(p.thumbUrl || p.previewUrl)}" alt="${escHtml(p.filename)}" loading="lazy" decoding="async" />
        <button class="photo-cover-btn" data-photo-id="${escHtml(p.id)}" aria-pressed="${p.id === coverPhotoId}">${p.id === coverPhotoId ? '★ Cover' : 'Set as cover'}</button>
        <span class="photo-badge">${p.indexing_status === 'completed' ? `${p.face_count} face${Number(p.face_count) === 1 ? '' : 's'}` : escHtml(p.indexing_status)}</span>
        <p class="photo-processing-note">${p.indexing_error ? escHtml(p.indexing_error) : p.indexing_status === 'completed' && !Number(p.face_count) ? 'No clear face.' : p.indexing_status === 'pending' ? 'Indexing — refresh to check.' : ''}</p>
        <button class="photo-delete-btn" data-photo-id="${escHtml(p.id)}" aria-label="Delete ${escHtml(p.filename)}">Delete</button>
      </div>
    `).join('');
  } catch (err) {
    grid.innerHTML = `<p class="loading-msg error-msg">${escHtml(err.message)}</p>`;
  }
}

document.getElementById('galleryGrid').addEventListener('click', async (e) => {
  // Choose (or clear) the public cover photo for this session.
  const coverBtn = e.target.closest('.photo-cover-btn');
  if (coverBtn) {
    const grid = document.getElementById('galleryGrid'); const sessionId = grid.dataset.sessionId;
    const clearing = coverBtn.getAttribute('aria-pressed') === 'true';
    grid.querySelectorAll('.photo-cover-btn').forEach(control => { control.disabled = true; });
    try {
      await apiRequest(`/api/admin/sessions/${sessionId}`, { method: 'PUT', body: JSON.stringify({ coverPhotoId: clearing ? null : coverBtn.dataset.photoId }) });
      grid.querySelectorAll('.photo-card').forEach(card => { const isCover = !clearing && card.id === `photo-card-${coverBtn.dataset.photoId}`; card.classList.toggle('is-cover', isCover); const control = card.querySelector('.photo-cover-btn'); control.setAttribute('aria-pressed', String(isCover)); control.textContent = isCover ? '★ Cover' : 'Set as cover'; });
      if (clearing) notifyCrew('Cover removed.');
      else { notifyCrew('Cover set — on the site in a few minutes.', 'success'); window.SOI?.splash?.({ at: coverBtn, symbol: 'stamp-coconut', count: 5 }); }
    } catch (err) { notifyCrew(err.message, 'error'); }
    finally { grid.querySelectorAll('.photo-cover-btn').forEach(control => { control.disabled = false; }); }
    return;
  }
  const btn = e.target.closest('.photo-delete-btn');
  if (!btn) return;
  const photoId = btn.dataset.photoId;
  if (!await confirmAction({ title: 'Delete this photo?', copy: 'Gone for good — including for anyone who paid for it.', confirmLabel: 'Delete' })) return;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    await apiRequest(`/api/admin/photos/${photoId}`, { method: 'DELETE' });
    const card = document.getElementById(`photo-card-${photoId}`);
    if (card) card.remove();
    loadDashboard(true);
  } catch (err) {
    notifyCrew(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Delete';
  }
});

// ── Edit Session Details ─────────────────────────────────────────────────────

document.getElementById('editSessionForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const sessionId = document.getElementById('editSessionId').value;
  const title = document.getElementById('editTitle').value;
  const date = document.getElementById('editDate').value;
  const location = document.getElementById('editLocation').value;
  const pricePaise = Math.round(Number(document.getElementById('editPrice').value) * 100);
  const status = document.getElementById('editStatus').value;

  const saveButton = e.currentTarget.querySelector('button[type=submit]');
  if (saveButton.disabled) return;
  saveButton.disabled = true; saveButton.textContent = 'Saving…';
  try {
    await apiRequest(`/api/admin/sessions/${sessionId}`, {
      method: 'PUT',
      body: JSON.stringify({ title, date, location, pricePaise, status }),
    });
    editSessionModal.close();
    loadDashboard();
  } catch (err) {
    notifyCrew(err.message, 'error');
  } finally { saveButton.disabled = false; saveButton.textContent = 'Save'; }
});

// ── Session Card Action Event Delegation ──────────────────────────────────────

document.getElementById('dashboardGrid').addEventListener('click', async (e) => {
  // View Photos
  const viewBtn = e.target.closest('.view-photos-btn');
  if (viewBtn) {
    return viewSessionPhotos(viewBtn.dataset.sessionId, viewBtn.dataset.sessionTitle);
  }

  // Upload more photos into this session
  const moreBtn = e.target.closest('.upload-more-btn');
  if (moreBtn) {
    if (uploadBusy) return notifyCrew('Let this upload finish first.');
    moreUpload = { sessionId: moreBtn.dataset.sessionId, title: moreBtn.dataset.sessionTitle, items: [], duplicates: [], failedItems: [] };
    morePhotoInput.click();
    return;
  }

  // Edit Session
  const editBtn = e.target.closest('.edit-session-btn');
  if (editBtn) {
    document.getElementById('editSessionId').value = editBtn.dataset.sessionId;
    document.getElementById('editTitle').value = editBtn.dataset.title;
    document.getElementById('editDate').value = editBtn.dataset.date;
    document.getElementById('editLocation').value = editBtn.dataset.location;
    document.getElementById('editPrice').value = editBtn.dataset.price;
    document.getElementById('editStatus').value = editBtn.dataset.status;
    editSnapshot = editFormState();
    openModal(editSessionModal);
    return;
  }

  // Publish a draft straight from its card (the same endpoint the upload flow uses).
  const publishBtn = e.target.closest('.publish-session-btn');
  if (publishBtn) {
    publishBtn.disabled = true; publishBtn.textContent = 'Publishing…';
    try { await apiRequest(`/api/admin/sessions/${publishBtn.dataset.sessionId}/publish`, { method: 'POST' }); window.SOI?.haptic?.([15]); notifyCrew(`“${publishBtn.dataset.sessionTitle}” is live.`, 'success'); loadDashboard(); }
    catch (err) { notifyCrew(err.message, 'error'); publishBtn.disabled = false; publishBtn.textContent = 'Publish'; }
    return;
  }

  const restoreBtn = e.target.closest('.restore-session-btn');
  if (restoreBtn) {
    restoreBtn.disabled = true; restoreBtn.textContent = 'Restoring…';
    try { await apiRequest(`/api/admin/sessions/${restoreBtn.dataset.sessionId}`, { method: 'PUT', body: JSON.stringify({ status: 'draft' }) }); loadDashboard(); }
    catch (err) { notifyCrew(err.message, 'error'); restoreBtn.disabled = false; restoreBtn.textContent = 'Restore'; }
    return;
  }

  // Re-queue only the photos whose indexing failed.
  const retryBtn = e.target.closest('.retry-failed-btn');
  if (retryBtn) {
    retryBtn.disabled = true; retryBtn.textContent = 'Queuing…';
    try {
      const res = await apiRequest(`/api/admin/sessions/${retryBtn.dataset.sessionId}/reindex?onlyFailed=1`, { method: 'POST' });
      notifyCrew(`${res.queued || 0} queued again.${res.failed ? ` ${res.failed} couldn't queue.` : ''}`, res.queued ? 'success' : 'info');
      loadDashboard();
    } catch (err) { notifyCrew(err.message, 'error'); retryBtn.disabled = false; retryBtn.textContent = 'Retry failed'; }
    return;
  }

  // Force Reindex Session — reprocesses every photo in the session, even ones already indexed.
  const reindexBtn = e.target.closest('.reindex-btn');
  if (reindexBtn) {
    if (!await confirmAction({ title: 'Force reindex this session?', copy: 'Reprocesses every photo — including ones already indexed or still mid-run — and replaces their face and appearance data. Takes a while for big sessions.', confirmLabel: 'Force reindex' })) return;
    reindexBtn.disabled = true;
    reindexBtn.textContent = 'Queuing…';
    try {
      const res = await apiRequest(`/api/admin/sessions/${reindexBtn.dataset.sessionId}/reindex`, { method: 'POST' });
      notifyCrew(`${res.queued || 0} queued, ${res.alreadyQueued || 0} already running.${res.failed ? ` ${res.failed} couldn't queue — retry after.` : ''} You can leave, it keeps going.`, res.queued ? 'success' : 'info');
      loadDashboard();
    } catch (err) {
      notifyCrew(err.message, 'error');
    } finally {
      reindexBtn.disabled = false;
      reindexBtn.textContent = 'Force reindex';
    }
    return;
  }

  // Delete Session
  const deleteBtn = e.target.closest('.delete-btn');
  if (deleteBtn) {
    const id = deleteBtn.dataset.sessionId;
    const card = deleteBtn.closest('.d-card'); const title = card?.querySelector('.d-card-title')?.textContent?.trim() || '';
    const photoCount = card?.querySelector('.view-photos-btn')?.textContent.match(/\((\d+)\)/)?.[1] || '0';
    if (!await confirmAction({ title: `Delete “${title}”?`, copy: `All ${plural(Number(photoCount), 'photo')} go${photoCount === '1' ? 'es' : ''} — including originals people paid for. No undo.`, confirmLabel: 'Delete', typed: title })) return;
    deleteBtn.disabled = true;
    deleteBtn.textContent = 'Deleting…';
    try {
      await apiRequest(`/api/admin/sessions/${id}`, { method: 'DELETE' });
      loadDashboard();
    } catch (err) {
      notifyCrew(err.message, 'error');
      deleteBtn.disabled = false;
      deleteBtn.textContent = 'Delete';
    }
    return;
  }
});

document.getElementById('refreshBtn').addEventListener('click', () => loadDashboard());

// ── Upload more photos into an existing session ───────────────────────────────

const morePhotoInput = document.getElementById('morePhotoInput');
const moreConfirmBtn = document.getElementById('moreConfirmBtn');
const moreCancelBtn  = document.getElementById('moreCancelBtn');
const moreRetryBtn   = document.getElementById('moreRetryBtn');
let moreUpload = null; // { sessionId, title, items: [{ file, name, duplicate }], duplicates, failedItems }

// Mirror the Worker's safeFilename so the duplicate check compares stored names.
function storedFilename(name) { return (name || 'photo.jpg').replace(/[^a-zA-Z0-9._-]/g, '-').slice(-120); }
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function setMoreStatus(text, isError = false, kind = '') {
  const el = document.getElementById('moreStatus');
  el.textContent = text; el.className = 'upload-status' + (text ? ' visible' : '') + (isError ? ' error' : '');
  if (kind) el.dataset.kind = kind; else delete el.dataset.kind;
}
function setMoreProgress(percent, speed, eta) {
  document.getElementById('moreProgressWrap').classList.remove('hidden');
  document.getElementById('moreProgressFill').style.width = `${Math.min(100, percent)}%`;
  document.getElementById('moreProgressSpeed').textContent = speed ? `${Math.round(speed)} KB/s` : '';
  document.getElementById('moreProgressEta').textContent = eta || '';
}
let moreFiles = []; // Files whose thumbnails the dialog list currently shows.
uploadMoreModal.addEventListener('close', () => { releaseThumbnails(moreFiles); moreFiles = []; });
function resetMoreModal() {
  document.getElementById('moreSummary').textContent = 'Checking…';
  document.getElementById('morePhotos').hidden = true;
  document.getElementById('morePhotoList').replaceChildren();
  releaseThumbnails(moreFiles); moreFiles = [];
  document.getElementById('moreChoice').hidden = true;
  document.querySelector('input[name=duplicateMode][value=skip]').checked = true;
  document.getElementById('moreProgressWrap').classList.add('hidden');
  document.getElementById('moreProgressFill').style.width = '0%';
  setMoreStatus('');
  moreConfirmBtn.disabled = true; moreConfirmBtn.innerHTML = 'Upload'; moreConfirmBtn.classList.remove('is-busy');
  moreCancelBtn.textContent = 'Cancel';
  moreRetryBtn.hidden = true;
  if (moreUpload) moreUpload.failedItems = [];
}

morePhotoInput.addEventListener('click', (e) => { e.target.value = null; });
morePhotoInput.addEventListener('change', (e) => prepareUploadMore(e.target.files));
moreCancelBtn.addEventListener('click', () => stopOrCloseMore());

async function prepareUploadMore(fileList) {
  const files = [...fileList];
  if (!moreUpload || uploadBusy || !files.length) return;
  if (!files.every(isSupportedPhoto)) return toast(UNSUPPORTED_FILES, 'error');
  resetMoreModal();
  document.getElementById('moreModalTitle').textContent = `Add photos — ${moreUpload.title}`;
  openModal(uploadMoreModal);
  try {
    const { photos } = await apiRequest(`/api/admin/sessions/${moreUpload.sessionId}/photos`);
    if (!uploadMoreModal.open) return;
    const existing = new Set(photos.map(photo => photo.filename.toLowerCase()));
    // The same name picked twice from different folders is sent once.
    const seen = new Set(); const items = []; let repeated = 0;
    for (const file of files) {
      const name = storedFilename(file.name); const key = name.toLowerCase();
      if (seen.has(key)) { repeated += 1; continue; }
      seen.add(key); items.push({ file, name, duplicate: existing.has(key) });
    }
    moreUpload.items = items; moreUpload.duplicates = items.filter(item => item.duplicate);
    renderUploadMore(repeated);
  } catch (err) {
    document.getElementById('moreSummary').textContent = "Couldn't check what's already here.";
    setMoreStatus(err.message, true);
  }
}

function renderUploadMore(repeated) {
  const { items, duplicates } = moreUpload;
  const fresh = items.length - duplicates.length;
  const summary = document.getElementById('moreSummary'); summary.replaceChildren();
  const count = document.createElement('strong'); count.textContent = plural(items.length, 'photo');
  summary.append(count, '. ');
  if (duplicates.length) summary.append(`${duplicates.length} already here, ${fresh} new.`);
  else summary.append('All new.');
  if (repeated) summary.append(` ${plural(repeated, 'duplicate')} in your pick dropped.`);

  // Every selected photo gets a row up front; the rows then show live upload progress.
  document.getElementById('morePhotosTitle').textContent = duplicates.length ? `Photos · ${duplicates.length} already here` : 'Photos';
  const list = document.getElementById('morePhotoList'); list.replaceChildren();
  items.forEach(item => { item.row = photoRow(item.file, { tag: item.duplicate ? 'Already here' : '' }); list.append(item.row); });
  moreFiles = items.map(item => item.file);
  document.getElementById('morePhotos').hidden = false;
  document.getElementById('moreChoice').hidden = !duplicates.length;
  moreConfirmBtn.disabled = false;
  updateMoreConfirmLabel();
}

function plannedUploads() {
  if (!moreUpload) return [];
  const mode = moreUpload.duplicates.length ? document.querySelector('input[name=duplicateMode]:checked')?.value : '';
  const items = mode === 'skip' ? moreUpload.items.filter(item => !item.duplicate) : moreUpload.items;
  return items.map(item => ({ file: item.file, onDuplicate: mode || undefined, row: item.row }));
}
function updateMoreConfirmLabel() {
  const count = plannedUploads().length;
  moreConfirmBtn.innerHTML = count ? `Upload ${count}` : 'Nothing to upload';
  moreConfirmBtn.disabled = !count;
  // Preview the choice: duplicates dim when they are about to be left out.
  const skipping = document.querySelector('input[name=duplicateMode]:checked')?.value === 'skip';
  moreUpload?.duplicates.forEach(item => setRowState(item.row, skipping ? 'skipped' : 'waiting'));
}
document.getElementById('moreChoice').addEventListener('change', updateMoreConfirmLabel);

async function runMoreUpload(items, { skippedByChoice = 0, isRetry = false } = {}) {
  // Everything locks except × and Cancel, which become "Stop upload" while the batch is sending.
  const controls = [...uploadMoreModal.querySelectorAll('input, button')].filter(control => control !== moreCancelBtn && control !== closeMoreModal);
  uploadBusy = true; controls.forEach(control => { control.disabled = true; }); signOutBtn.disabled = true;
  moreConfirmBtn.innerHTML = 'Uploading… <span></span>'; moreConfirmBtn.classList.add('is-busy');
  moreCancelBtn.textContent = 'Stop';
  if (isRetry) moreRetryBtn.textContent = 'Retrying…';
  setMoreStatus(`${isRetry ? 'Retrying' : 'Uploading'} ${plural(items.length, 'photo')}…`);
  let stopped = false;
  try {
    const batch = await uploadPhotoBatch(moreUpload.sessionId, items, setMoreProgress, (index, state, detail) => markRowFromResult(items[index].row, state, detail));
    const { results, failures, unsent } = batch; stopped = batch.stopped;
    const uploaded = results.filter(result => !result.skipped);
    const replaced = uploaded.reduce((sum, result) => sum + (result.replaced || 0), 0);
    const renamed = uploaded.filter(result => result.duplicate === 'renamed');
    const skipped = results.filter(result => result.skipped).length + skippedByChoice;
    const parts = [`${uploaded.length} sent${uploaded.length ? ', indexing' : ''}.`];
    if (replaced) parts.push(`${replaced} replaced.`);
    if (renamed.length) parts.push(`${renamed.length === 1 ? '1 copy' : `${renamed.length} copies`} saved as ${renamed.slice(0, 3).map(result => result.filename).join(', ')}${renamed.length > 3 ? '…' : ''}.`);
    if (skipped) parts.push(`${skipped} skipped.`);
    if (stopped) parts.push(`Stopped — ${failures.length + unsent.length} not sent.`);
    else if (failures.length) parts.push(`${failures.length} failed — ${failures[0].message}`);
    setMoreStatus(parts.join(' '), Boolean(failures.length) && !stopped, stopped ? 'warning' : '');
    if (!stopped && !failures.length) window.SOI?.splash?.({ at: moreConfirmBtn, symbol: 'stamp-sunburst', count: 8 });
    // Aborted and never-started items both go on the retry list so one tap sends the rest.
    moreUpload.failedItems = [...failures.map(failure => failure.item), ...unsent];
    if (!moreUpload.failedItems.length) document.getElementById('moreProgressWrap').classList.add('hidden');
    moreUpload.items = []; moreUpload.duplicates = [];
    if (!stopped) flagFinishedInTitle('Sent · Crew Studio');
    loadDashboard(true);
  } catch (err) {
    setMoreStatus(err.message || 'Upload failed.', true);
  } finally {
    cancelled = false;
    uploadBusy = false; signOutBtn.disabled = false;
    controls.forEach(control => { control.disabled = false; });
    moreConfirmBtn.disabled = true; moreConfirmBtn.innerHTML = 'Upload'; moreConfirmBtn.classList.remove('is-busy');
    moreCancelBtn.textContent = 'Done';
    document.getElementById('moreChoice').hidden = true;
    if (moreUpload.failedItems.length) {
      moreRetryBtn.hidden = false; moreRetryBtn.disabled = false;
      moreRetryBtn.textContent = stopped ? `Send ${moreUpload.failedItems.length} remaining` : `Retry ${moreUpload.failedItems.length}`;
    } else {
      moreRetryBtn.hidden = true;
    }
  }
}

moreConfirmBtn.addEventListener('click', () => {
  const items = plannedUploads();
  if (!items.length || uploadBusy) return;
  runMoreUpload(items, { skippedByChoice: moreUpload.items.length - items.length });
});

moreRetryBtn.addEventListener('click', () => {
  const items = moreUpload?.failedItems || [];
  if (!items.length || uploadBusy) return;
  runMoreUpload(items, { isRetry: true });
});

// ── Crew Match Verification Queue ─────────────────────────────────────────────

const faceImages = new WeakMap();
function renderFace(canvas, zoom = 1) {
  const image = faceImages.get(canvas); if (!image) return;
  const [top, left, width, height] = JSON.parse(canvas.dataset.bboxNorm);
  const fullWidth = width / 100 * image.naturalWidth, fullHeight = height / 100 * image.naturalHeight;
  const cropWidth = fullWidth / zoom, cropHeight = fullHeight / zoom;
  const x = left / 100 * image.naturalWidth + (fullWidth - cropWidth) / 2;
  const y = top / 100 * image.naturalHeight + (fullHeight - cropHeight) / 2;
  const context = canvas.getContext('2d');
  const scale = Math.min(canvas.width / cropWidth, canvas.height / cropHeight);
  context.fillStyle = '#e7e2d6'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, x, y, cropWidth, cropHeight, (canvas.width - cropWidth * scale) / 2, (canvas.height - cropHeight * scale) / 2, cropWidth * scale, cropHeight * scale);
}
// Share downloads and decoded originals across pairs within this queue.
function createReviewImageLoader() {
  const images = new Map();
  return canvas => {
    const key = canvas.dataset.photoId || canvas.dataset.imgUrl;
    if (!images.has(key)) {
      const pending = new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.decoding = 'async';
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Could not load photo.'));
        const mediaUrl = new URL(canvas.dataset.imgUrl, window.location.origin);
        image.src = mediaUrl.origin === 'https://mambo-jambo-photo-api.surfersofindia.workers.dev' ? apiUrl(mediaUrl.pathname + mediaUrl.search) : mediaUrl.href;
      });
      images.set(key, pending);
      pending.catch(() => images.delete(key));
    }
    return images.get(key);
  };
}
async function drawCroppedFaceCanvas(canvas, loadImage) {
  const card = canvas.closest('.verify-card');
  const frame = canvas.closest('.review-image-frame');
  frame.dataset.state = 'loading';
  frame.setAttribute('aria-busy', 'true');
  try {
    const image = await loadImage(canvas);
    if (!canvas.isConnected) return;
    faceImages.set(canvas, image); renderFace(canvas); canvas.dataset.ready = 'true';
    frame.dataset.state = 'ready';
    if ([...card.querySelectorAll('canvas')].every(item => item.dataset.ready === 'true')) {
      card.querySelector('.review-load-status').textContent = 'Your call.';
      card.querySelectorAll('[data-action="confirm"],[data-action="reject"],input[type=range]').forEach(control => { control.disabled = false; });
    }
  } catch {
    if (!canvas.isConnected) return;
    frame.dataset.state = 'error';
    frame.querySelector('.review-image-label').textContent = "Didn't load";
    card.querySelector('.review-load-status').textContent = "A face didn't load — refresh the queue.";
  } finally {
    frame.setAttribute('aria-busy', 'false');
  }
}
let reviewObserver;
let reviewQueueVersion = 0;
function observeReviewImages(grid) {
  const loadImage = createReviewImageLoader();
  const loadCard = card => card.querySelectorAll('canvas').forEach(canvas => drawCroppedFaceCanvas(canvas, loadImage));
  if (!('IntersectionObserver' in window)) {
    grid.querySelectorAll('.verify-card').forEach(loadCard);
    return;
  }
  reviewObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      reviewObserver.unobserve(entry.target);
      loadCard(entry.target);
    }
  }, { rootMargin: '300px 0px' });
  grid.querySelectorAll('.verify-card').forEach(card => reviewObserver.observe(card));
}
async function loadVerifyQueue() {
  const grid = document.getElementById('verifyGrid');
  const version = ++reviewQueueVersion;
  reviewObserver?.disconnect();
  grid.innerHTML = '<p class="loading-msg review-queue-loading" role="status"><span class="review-spinner" aria-hidden="true"></span>Looking for borderline pairs…</p>';
  try {
    const { queue, stats } = await apiRequest('/api/admin/verify-queue');
    if (version !== reviewQueueVersion) return;
    document.getElementById('verifyPending').textContent = stats.pending || 0;
    const unavailable = document.getElementById('reviewUnavailable');
    unavailable.hidden = !stats.unavailable;
    unavailable.textContent = `${plural(stats.unavailable, 'pair')} hidden — faces still indexing or crops missing. Re-index, wait, scan again.`;
    document.getElementById('verifyConfirmed').textContent = stats.confirmed || 0;
    document.getElementById('verifyRejected').textContent = stats.rejected || 0;
    if (!queue?.length) { grid.innerHTML = '<p class="empty-msg">Nothing borderline right now. Scan again once indexing finishes.</p>'; return; }
    grid.innerHTML = queue.map(item => `
      <article class="verify-card" id="verify-card-${escHtml(item.id)}">
        <div class="review-heading"><div><span class="eyebrow">A SECOND PAIR OF EYES</span><h3>Same surfer?</h3><p>${escHtml(item.sessionTitle)}</p></div><span class="review-score">${item.similarityPct}%<small>borderline</small></span></div>
        <div class="verify-faces">${[item.photo1, item.photo2].map((photo, index) => `
          <figure class="review-face"><figcaption>FACE ${index === 0 ? 'A' : 'B'}</figcaption><div class="review-image-frame" data-state="waiting" aria-busy="true"><div class="review-image-loader" aria-hidden="true"><span class="review-spinner"></span><span class="review-image-label">Loading…</span></div><canvas class="face-crop-canvas" data-photo-id="${escHtml(photo.id)}" data-img-url="${escHtml(photo.url)}" data-bbox-norm="${escHtml(JSON.stringify(photo.bboxNorm))}" width="640" height="640" role="img" aria-label="Face ${index === 0 ? 'A' : 'B'} crop"></canvas></div><p title="${escHtml(photo.filename)}">${escHtml(photo.filename)}</p></figure>`).join('')}</div>
        <div class="review-zoom"><label>Zoom <input type="range" min="1" max="2.5" step=".1" value="1" disabled><output>1×</output></label><button type="button" data-action="reset-zoom">Reset</button></div>
        <p class="review-load-status" role="status">Loading faces…</p>
        <div class="verify-actions"><button class="confirm-btn" data-pair-id="${escHtml(item.id)}" data-action="confirm" disabled>Same</button><button class="reject-btn" data-pair-id="${escHtml(item.id)}" data-action="reject" disabled>Different</button><button class="review-skip" data-pair-id="${escHtml(item.id)}" data-action="skip">Skip</button></div>
      </article>`).join('');
    observeReviewImages(grid);
    document.dispatchEvent(new CustomEvent('mj:queue-rendered'));
  } catch (error) { if (version === reviewQueueVersion) grid.innerHTML = `<p class="loading-msg error-msg">${escHtml(error.message)}</p>`; }
}
const reviewGrid = document.getElementById('verifyGrid');
reviewGrid.addEventListener('input', event => {
  if (!event.target.matches('input[type=range]')) return;
  const card = event.target.closest('.verify-card'), zoom = Number(event.target.value);
  card.querySelector('output').textContent = `${zoom.toFixed(1)}×`;
  card.querySelectorAll('canvas').forEach(canvas => renderFace(canvas, zoom));
});
reviewGrid.addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]'); if (!button) return;
  const card = button.closest('.verify-card');
  if (button.dataset.action === 'reset-zoom') { const slider = card.querySelector('input'); slider.value = '1'; slider.dispatchEvent(new Event('input', { bubbles: true })); return; }
  window.SOI?.haptic?.([12]);
  if (button.dataset.action === 'skip') {
    card.remove(); if (!reviewGrid.querySelector('.verify-card')) reviewGrid.innerHTML = '<p class="empty-msg">Batch done. Refresh to see skipped ones.</p>';
    markActiveReviewCard();
    return;
  }
  card.querySelectorAll('button').forEach(control => { control.disabled = true; });
  const confirmed = button.dataset.action === 'confirm';
  try {
    await apiRequest('/api/admin/confirm-match', { method: 'POST', body: JSON.stringify({ pairId: button.dataset.pairId, confirmed }) });
    card.remove(); markActiveReviewCard();
    const pending = document.getElementById('verifyPending'); pending.textContent = Math.max(0, Number(pending.textContent) - 1);
    const count = document.getElementById(confirmed ? 'verifyConfirmed' : 'verifyRejected'); count.textContent = Number(count.textContent) + 1;
    if (!reviewGrid.querySelector('.verify-card')) await loadVerifyQueue();
  } catch (error) { card.querySelector('.review-load-status').textContent = error.message; card.querySelectorAll('button').forEach(control => { control.disabled = false; }); }
});

// Y / N / S act on the first reviewable card in view (face pairs first, then burst/appearance links).
// The same rule marks that card `.is-active`, so the crew can see what the keys will hit.
const activeReviewCard = () => [...document.querySelectorAll('#verifyGrid .verify-card, #linkGrid .verify-card')].find(item => { const box = item.getBoundingClientRect(); return box.bottom > 80 && box.top < window.innerHeight; });
function markActiveReviewCard() {
  const active = activeReviewCard();
  document.querySelectorAll('.verify-card.is-active').forEach(card => { if (card !== active) card.classList.remove('is-active'); });
  active?.classList.add('is-active');
}
let reviewMarkFrame = 0;
window.addEventListener('scroll', () => { if (!reviewMarkFrame) reviewMarkFrame = requestAnimationFrame(() => { reviewMarkFrame = 0; markActiveReviewCard(); }); }, { passive: true });
document.addEventListener('mj:queue-rendered', markActiveReviewCard);
document.addEventListener('keydown', event => {
  if (!document.getElementById('tab-verify').classList.contains('active') || document.querySelector('dialog[open]')) return;
  if (event.metaKey || event.ctrlKey || event.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
  const action = { y: 'confirm', n: 'reject', s: 'skip' }[event.key.toLowerCase()]; if (!action) return;
  const card = activeReviewCard();
  const button = card?.querySelector(`button[data-action="${action}"]`);
  if (!button || button.disabled) return;
  event.preventDefault(); button.click();
});

const rescanVerifyBtn = document.getElementById('rescanVerifyBtn');
if (rescanVerifyBtn) {
  rescanVerifyBtn.addEventListener('click', async () => {
    rescanVerifyBtn.disabled = true;
    rescanVerifyBtn.textContent = 'Scanning…';
    try {
      const res = await apiRequest('/api/admin/verify-queue/scan', { method: 'POST' });
      notifyCrew(`Scan done — ${plural(res.generated || 0, 'borderline pair')}.`, 'success');
      loadVerifyQueue();
    } catch (err) {
      notifyCrew(err.message, 'error');
    } finally {
      rescanVerifyBtn.disabled = false;
      rescanVerifyBtn.textContent = 'Find borderline pairs';
    }
  });
}

const refreshVerifyBtn = document.getElementById('refreshVerifyBtn');
if (refreshVerifyBtn) {
  refreshVerifyBtn.addEventListener('click', () => loadVerifyQueue());
}

// ── Burst & Appearance Fallback Link Review ────────────────────────────────────
// Unlike face pairs above, one or both sides here may have no detected face at all, so there is
// no bbox to crop to — cards compare whole photos. Plain lazy-loaded <img> is enough; there is no
// canvas cropping/zoom to justify the decoded-image cache the face-pair review uses.

const LINK_TYPE_LABEL = { burst: ['BURST', 'seconds apart'], appearance: ['SAME KIT', 'matching colours'] };
let linkQueueVersion = 0;
async function loadLinkQueue() {
  const grid = document.getElementById('linkGrid');
  if (!grid) return;
  const version = ++linkQueueVersion;
  grid.innerHTML = '<p class="loading-msg review-queue-loading" role="status"><span class="review-spinner" aria-hidden="true"></span>Looking for links…</p>';
  try {
    const { queue, stats, trainedOn } = await apiRequest('/api/admin/link-queue');
    if (version !== linkQueueVersion) return;
    document.getElementById('linkPending').textContent = stats.pending || 0;
    document.getElementById('linkConfirmed').textContent = stats.confirmed || 0;
    document.getElementById('linkRejected').textContent = stats.rejected || 0;
    showRetrainStatus(trainedOn);
    if (!queue?.length) { grid.innerHTML = '<p class="empty-msg">No links yet. Needs capture times — re-index, then scan.</p>'; return; }
    grid.innerHTML = queue.map(item => {
      const [eyebrow, note] = LINK_TYPE_LABEL[item.linkType] || LINK_TYPE_LABEL.burst;
      return `
      <article class="verify-card" id="link-card-${escHtml(item.id)}">
        <div class="review-heading"><div><span class="eyebrow">${eyebrow}</span><h3>Same surfer?</h3><p>${escHtml(item.sessionTitle)}</p></div><span class="review-score">${item.scorePct}%<small>${note}</small></span></div>
        <div class="verify-faces">${[item.photo1, item.photo2].map((photo, index) => `
          <figure class="review-face"><figcaption>PHOTO ${index === 0 ? 'A' : 'B'}</figcaption><img class="link-photo-img" loading="lazy" src="${escHtml(photo.url)}" alt="Photo ${index === 0 ? 'A' : 'B'}"><p title="${escHtml(photo.filename)}">${escHtml(photo.filename)}</p></figure>`).join('')}</div>
        <div class="verify-actions"><button class="confirm-btn" data-link-id="${escHtml(item.id)}" data-action="confirm">Same</button><button class="reject-btn" data-link-id="${escHtml(item.id)}" data-action="reject">Different</button><button class="review-skip" data-link-id="${escHtml(item.id)}" data-action="skip">Skip</button></div>
      </article>`;
    }).join('');
    grid.querySelectorAll('.link-photo-img').forEach(img => {
      img.addEventListener('error', () => img.closest('.review-face').classList.add('link-photo-error'), { once: true });
    });
    document.dispatchEvent(new CustomEvent('mj:queue-rendered'));
  } catch (error) { if (version === linkQueueVersion) grid.innerHTML = `<p class="loading-msg error-msg">${escHtml(error.message)}</p>`; }
}
const linkGrid = document.getElementById('linkGrid');
if (linkGrid) {
  linkGrid.addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]'); if (!button) return;
    const card = button.closest('.verify-card');
    window.SOI?.haptic?.([12]);
    if (button.dataset.action === 'skip') {
      card.remove(); if (!linkGrid.querySelector('.verify-card')) linkGrid.innerHTML = '<p class="empty-msg">Batch done. Refresh to see skipped ones.</p>';
      markActiveReviewCard();
      return;
    }
    card.querySelectorAll('button').forEach(control => { control.disabled = true; });
    const confirmed = button.dataset.action === 'confirm';
    try {
      await apiRequest('/api/admin/confirm-link', { method: 'POST', body: JSON.stringify({ linkId: button.dataset.linkId, confirmed }) });
      card.remove(); markActiveReviewCard();
      const pending = document.getElementById('linkPending'); pending.textContent = Math.max(0, Number(pending.textContent) - 1);
      const count = document.getElementById(confirmed ? 'linkConfirmed' : 'linkRejected'); count.textContent = Number(count.textContent) + 1;
      if (!linkGrid.querySelector('.verify-card')) await loadLinkQueue();
    } catch (error) { notifyCrew(error.message, 'error'); card.querySelectorAll('button').forEach(control => { control.disabled = false; }); }
  });
}

const rescanLinkBtn = document.getElementById('rescanLinkBtn');
if (rescanLinkBtn) {
  rescanLinkBtn.addEventListener('click', async () => {
    rescanLinkBtn.disabled = true;
    rescanLinkBtn.textContent = 'Scanning…';
    try {
      const res = await apiRequest('/api/admin/link-queue/scan', { method: 'POST' });
      notifyCrew(`Scan done — ${plural(res.generated || 0, 'link')}.`, 'success');
      loadLinkQueue();
    } catch (err) {
      notifyCrew(err.message, 'error');
    } finally {
      rescanLinkBtn.disabled = false;
      rescanLinkBtn.textContent = 'Find links';
    }
  });
}

const refreshLinkBtn = document.getElementById('refreshLinkBtn');
if (refreshLinkBtn) {
  refreshLinkBtn.addEventListener('click', () => loadLinkQueue());
}

function showRetrainStatus(trainedOn) {
  const el = document.getElementById('retrainStatus');
  if (!el) return;
  el.hidden = !trainedOn;
  el.textContent = trainedOn ? `Scoring trained on ${plural(trainedOn, 'review')}` : '';
}
const retrainBtn = document.getElementById('retrainBtn');
if (retrainBtn) {
  retrainBtn.addEventListener('click', async () => {
    retrainBtn.disabled = true;
    retrainBtn.textContent = 'Retraining…';
    try {
      const res = await apiRequest('/api/admin/retrain', { method: 'POST' });
      if (res.trained) { notifyCrew(`Retrained on ${plural(res.reviewCount, 'review')}.`, 'success'); showRetrainStatus(res.reviewCount); }
      else if (res.reviewCount < 20) notifyCrew(`Only ${res.reviewCount} reviewed so far — needs 20. Keep going.`);
      else notifyCrew(`${res.reviewCount} reviewed, but all one answer — needs some of each.`);   // the Worker won't fit on confirms-only or rejects-only
    } catch (err) {
      notifyCrew(err.message, 'error');
    } finally {
      retrainBtn.disabled = false;
      retrainBtn.textContent = 'Retrain scoring';
    }
  });
}

// ── Session hygiene: idle sign-out, API health pill, tab title ────────────────

// The token lives in sessionStorage with no expiry of its own: drop it after 30 min without input,
// with a 2-minute warning. Never mid-upload — re-arm instead, so a long batch can't sign itself out.
const IDLE_MS = 30 * 60 * 1000, IDLE_WARN_MS = 2 * 60 * 1000;
let idleTimer = null, idleWarnTimer = null, idleWarning = null, idleTouchedAt = 0;
function armIdle() {
  disarmIdle();
  if (!isAuthenticated()) return;
  idleWarnTimer = setTimeout(() => { if (!uploadBusy) idleWarning = toast('Signing you out in 2 min — tap anything to stay.', 'info', { timeout: IDLE_WARN_MS }); }, IDLE_MS - IDLE_WARN_MS);
  idleTimer = setTimeout(() => {
    if (uploadBusy) return armIdle();
    clearToken(); showLogin(); notifyCrew("Signed out — you'd gone quiet for 30 min.");
  }, IDLE_MS);
}
function disarmIdle() { clearTimeout(idleTimer); clearTimeout(idleWarnTimer); idleTimer = idleWarnTimer = null; idleWarning?.remove(); idleWarning = null; }
function touchIdle() {
  if (!idleTimer) return;                                                       // not armed (login screen)
  const now = Date.now(); if (now - idleTouchedAt < 1000) return; idleTouchedAt = now;   // scroll fires constantly
  armIdle();
}
['pointerdown', 'keydown', 'scroll'].forEach(type => document.addEventListener(type, touchIdle, { passive: true, capture: true }));

// Topbar health pill: GET /api/health (public, no auth) every 60 s while signed in and the tab is
// visible. One dot per check; the pill's data-state is the worst of them. Must never throw.
const HEALTH_MS = 60000;
const HEALTH_CHECKS = [['api', 'API'], ['db', 'DB'], ['r2', 'R2'], ['face', 'Face']];
let healthTimer = null;
const HEALTH_DOT = { ok: 'var(--success)', skipped: 'var(--soi-umber-soft)', error: 'var(--soi-terracotta)' };
function renderHealth(el, state, checks) {
  const dot = key => ['ok', 'error', 'skipped'].includes(checks[key]) ? checks[key] : 'error';
  el.classList.add('health-pill'); el.dataset.state = state;
  el.innerHTML = HEALTH_CHECKS.map(([key, label]) => `<span class="health-check" data-state="${dot(key)}"><i aria-hidden="true" style="color:${HEALTH_DOT[dot(key)]}">●</i> ${label}</span>`).join(' · ');
  el.title = HEALTH_CHECKS.map(([key, label]) => `${label}: ${dot(key)}`).join(' · ');
  el.setAttribute('aria-label', `Service health ${state}: ${el.title}`);
  el.hidden = false; el.classList.remove('hidden');
}
async function pollHealth() {
  try {
    const el = document.getElementById('apiHealth');
    if (!el || !isAuthenticated() || document.hidden) return;
    let state = 'down', checks = {};
    try {
      const resp = await fetch(apiUrl('/api/health'), { signal: AbortSignal.timeout(5000) });
      if (resp.status === 404) { el.hidden = true; return; }              // Worker without the route yet
      const body = await resp.json().catch(() => ({}));
      checks = { api: 'ok', ...(body.checks || {}) };
      state = resp.ok && body.ok === true ? 'ok' : 'degraded';
    } catch { checks = {}; }
    renderHealth(el, state, checks);
  } catch { /* the pill must never break the studio */ }
}
function startHealth() {
  clearInterval(healthTimer); healthTimer = null;
  if (!isLive || !isAuthenticated() || document.hidden) return;
  pollHealth(); healthTimer = setInterval(pollHealth, HEALTH_MS);
}
function stopHealth({ hide = false } = {}) {
  clearInterval(healthTimer); healthTimer = null;
  const el = document.getElementById('apiHealth');
  if (hide && el) { el.hidden = true; el.classList.add('hidden'); }
}

// A batch that finishes while the crew is in another tab flags the title until they come back.
const baseTitle = document.title;
function flagFinishedInTitle(label) { if (document.hidden) document.title = label; }
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopHealth(); return; }
  document.title = baseTitle;
  startHealth();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


if (isAuthenticated()) showApp();
