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
  if (resp.status === 401) { clearToken(); showLogin(); throw new Error('Your crew session expired. Please sign in again.'); }
  if (!resp.ok) throw new Error(body.error || 'Something went wrong.');
  return body;
}

// ── DOM references ────────────────────────────────────────────────────────────

const loginScreen = document.getElementById('loginScreen');
const adminApp    = document.getElementById('adminApp');
const signOutBtn  = document.getElementById('signOutBtn');

// ── Routing: show login or app ────────────────────────────────────────────────

function showApp() {
  loginScreen.classList.add('hidden');
  adminApp.classList.remove('hidden');
  signOutBtn.classList.remove('hidden');   // show sign-out in topbar
  // Set today's date as default
  const dateInput = document.getElementById('adminDate');
  if (!dateInput.value) { const now = new Date(); dateInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; }
  // Don't auto-load dashboard — only load when tab is clicked
}

function showLogin() {
  // Stop any running auto-refresh
  if (dashInterval) { clearInterval(dashInterval); dashInterval = null; }
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
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    const result = await fetch(apiUrl('/api/admin/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: passwordEl.value }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await result.json().catch(() => ({}));
    if (!result.ok) throw new Error(body.error || (result.status === 401 ? 'Incorrect password.' : 'The photo service is unavailable. Please try again.'));
    if (typeof body.token !== 'string' || !body.token) throw new Error('Sign-in could not be completed. Please refresh and try again.');
    setToken(body.token);
    passwordEl.value = '';
    showApp();
  } catch (err) {
    errorEl.textContent = err.name === 'TimeoutError' ? 'Sign-in took too long. Please try again.' : err instanceof TypeError ? 'Cannot reach the photo service. Check your connection and try again.' : err.message;
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Enter studio <span>→</span>';
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

function openModal(modal) { modal.querySelector('.modal-notice')?.remove(); modal.classList.remove('hidden'); if (!modal.open) modal.showModal(); }
[photoGalleryModal, editSessionModal, uploadMoreModal].forEach(modal => {
  modal.addEventListener('close', () => modal.classList.add('hidden'));
  modal.addEventListener('click', event => { if (event.target === modal && !uploadBusy) modal.close(); });
  // Escape must not abandon an upload that is still sending files.
  modal.addEventListener('cancel', event => { if (uploadBusy) event.preventDefault(); });
});
closeGalleryModal.addEventListener('click', () => photoGalleryModal.close());
closeEditModal.addEventListener('click', () => editSessionModal.close());
closeMoreModal.addEventListener('click', () => { if (!uploadBusy) uploadMoreModal.close(); });
document.querySelector('.tabs').addEventListener('keydown', event => {
  const buttons = [...document.querySelectorAll('.tab-btn')]; const index = buttons.indexOf(document.activeElement);
  if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next].focus(); buttons[next].click();
});
function notifyCrew(message) {
  if (!loginScreen.classList.contains('hidden')) { document.getElementById('loginError').textContent = message; return; }
  const modal = document.querySelector('dialog[open]');
  let notice = document.getElementById('adminNotice');
  if (modal) {
    notice = modal.querySelector('.modal-notice');
    if (!notice) { notice = document.createElement('p'); notice.className = 'admin-notice modal-notice'; notice.setAttribute('role', 'status'); modal.querySelector('.modal-body').prepend(notice); }
  }
  notice.textContent = message; notice.hidden = false;
}

// ── Upload: preview generation ────────────────────────────────────────────────

function imageFromFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image.')); };
    img.src = url;
  });
}

async function watermarkedPreview(file) {
  const img = await imageFromFile(file);
  const max = 1400;
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(-Math.PI / 7);
  ctx.globalAlpha = .68;
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${Math.max(20, Math.round(canvas.width / 18))}px Work Sans, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('SURFERS OF INDIA  •  PREVIEW', 0, 0);
  ctx.restore();
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not prepare this photo for upload.')), 'image/jpeg', .82));
}

// ── Upload: file selection & drag/drop ────────────────────────────────────────

let adminFiles = [];
let uploadBusy = false;
const dropZone = document.getElementById('adminDropZone');
const photoInput = document.getElementById('adminPhotoInput');

function setStatus(text, isError = false) {
  const el = document.getElementById('uploadStatus');
  el.textContent = text;
  el.className = 'upload-status visible' + (isError ? ' error' : '');
}

function clearStatus() {
  const el = document.getElementById('uploadStatus');
  el.textContent = '';
  el.className = 'upload-status';
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

const UNSUPPORTED_FILES = 'Choose only JPG, PNG or WebP photos up to 25 MB each. Remove unsupported files and select again.';
function isSupportedPhoto(file) { return ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) && file.size > 0 && file.size <= 25 * 1024 * 1024; }

function selectFiles(files) {
  if (uploadBusy) return;
  const selected = [...files];
  adminFiles = selected.filter(isSupportedPhoto);
  if (adminFiles.length !== selected.length) {
    adminFiles = []; renderFileList();
    setStatus(UNSUPPORTED_FILES, true);
    return;
  }
  renderFileList();
  if (adminFiles.length) {
    setStatus(`${adminFiles.length} photo${adminFiles.length === 1 ? '' : 's'} selected. Click "Publish photo pack" to upload.`);
    window.setTimeout(() => document.getElementById('publishBtn').scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
  } else {
    setStatus('No valid images selected. Choose JPG, PNG or WebP files.', true);
  }
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
const ROW_LABELS = { waiting: 'Waiting to upload', uploading: 'Uploading…', done: 'Uploaded', failed: 'Upload failed', skipped: 'Skipped' };
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
  if (state !== 'done') return setRowState(row, state, { tag: '' });
  if (detail?.skipped) return setRowState(row, 'skipped', { tag: 'Already in session' });
  if (detail?.duplicate === 'renamed') return setRowState(row, 'done', { tag: `Saved as ${detail.filename}`, kind: 'ok' });
  if (detail?.duplicate === 'replaced') return setRowState(row, 'done', { tag: 'Replaced existing', kind: 'ok' });
  setRowState(row, 'done', { tag: '' });
}

let queueFiles = []; // Files whose thumbnails the Upload tab list currently shows.
function renderFileList() {
  const container = document.getElementById('fileQueue'); container.replaceChildren(); container.hidden = !adminFiles.length;
  delete container.dataset.uploading; delete container.dataset.finished;
  releaseThumbnails(queueFiles.filter(file => !adminFiles.includes(file)));
  queueFiles = [...adminFiles];
  if (!adminFiles.length) return;
  const header = document.createElement('div'); header.className = 'file-queue-head';
  const summary = document.createElement('strong'); summary.textContent = `${adminFiles.length} photos · ${(adminFiles.reduce((sum, file) => sum + file.size, 0) / 1048576).toFixed(1)} MB`;
  const clear = document.createElement('button'); clear.type = 'button'; clear.textContent = 'Clear selection'; clear.disabled = uploadBusy;
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
window.addEventListener('beforeunload', event => { if (uploadBusy) { event.preventDefault(); event.returnValue = ''; } });

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
const UPLOAD_STREAMING = false;
const UPLOAD_STREAM_WORKERS = 12;

// Send originals plus watermarked previews and report combined progress.
// Each item is { file, onDuplicate? }. onItem(index, state, detail) fires as each photo starts and finishes.
// Resolves with per-file results and failures.
async function uploadPhotoBatch(sessionId, items, onProgress, onItem = () => {}) {
  const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0);
  const startTime = performance.now();
  const fileProgress = new Array(items.length).fill(0);
  const report = () => {
    const uploaded = fileProgress.reduce((a, b) => a + b, 0);
    const elapsed = (performance.now() - startTime) / 1000;
    const speed = (uploaded / 1024) / Math.max(elapsed, 0.1);
    const remaining = Math.max(0, totalBytes - uploaded) / 1024;
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
    xhr.timeout = 120000;
    const failRetryable = (message) => reject(Object.assign(new Error(message), { retryable: true }));
    xhr.ontimeout = () => failRetryable('Upload timed out.');
    xhr.onabort = () => reject(new Error('Upload cancelled.'));
    xhr.upload.onprogress = (ev) => {
      if (!ev.lengthComputable) return;
      fileProgress[index] = Math.min(item.file.size, item.file.size * ev.loaded / ev.total);
      report();
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        fileProgress[index] = item.file.size; report();
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error('Invalid upload response.')); }
      } else {
        let detail = `HTTP ${xhr.status}`;
        try { detail = JSON.parse(xhr.responseText).error || detail; } catch { /* Non-JSON gateway response. */ }
        // 5xx and gateway responses are usually transient (the Worker was overloaded); 4xx are not.
        reject(Object.assign(new Error(detail), { retryable: xhr.status >= 500 }));
      }
    };
    xhr.onerror = () => failRetryable('Network error.');
    xhr.send(body);
  });

  // Retry transient failures (network drop / timeout / overloaded Worker) a couple of times.
  const uploadWithRetry = async (item, index) => {
    for (let attempt = 1; ; attempt += 1) {
      try { return await uploadOne(item, await watermarkedPreview(item.file), index); }
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

  onProgress(0, 0, 'calculating...');
  const queue = items.map((item, index) => ({ item, index }));
  const results = []; const failures = [];
  await Promise.all(Array.from({ length: Math.min(workerCount, queue.length) }, async () => {
    while (queue.length) {
      const { item, index } = queue.shift();
      await acquire(item.file.size);
      onItem(index, 'uploading');
      try { const result = await uploadWithRetry(item, index); results.push(result); onItem(index, 'done', result); }
      catch (error) { failures.push({ item, message: `${item.file.name}: ${error.message}` }); onItem(index, 'failed', error); }
      finally { release(item.file.size); }
    }
  }));
  return { results, failures };
}

// ── Upload: publish ───────────────────────────────────────────────────────────

document.getElementById('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (uploadBusy) return;
  if (!adminFiles.length) return setStatus('Choose at least one photo before publishing.', true);

  const publishBtn = document.getElementById('publishBtn');
  const queueEl = document.getElementById('fileQueue');
  const rows = [...queueEl.querySelectorAll('.photo-row')];
  uploadBusy = true;
  document.querySelectorAll('#uploadForm input, #uploadForm button').forEach(control => { control.disabled = true; });
  signOutBtn.disabled = true;
  queueEl.dataset.uploading = 'true';
  publishBtn.disabled = true;
  publishBtn.innerHTML = 'Publishing…';
  hideProgress();

  try {
    const title = document.getElementById('adminTitle').value.trim();
    const date = document.getElementById('adminDate').value;
    const location = document.getElementById('adminLocation').value.trim();
    const pricePaise = Math.round(Number(document.getElementById('adminPrice').value) * 100);

    const create = await apiRequest('/api/admin/sessions', {
      method: 'POST',
      body: JSON.stringify({ title, date, location, pricePaise }),
    });

    const sessionId = create.session.id;
    setStatus(`Uploading ${adminFiles.length} photo${adminFiles.length === 1 ? '' : 's'}…`);
    const { results, failures } = await uploadPhotoBatch(sessionId, adminFiles.map(file => ({ file })), setProgress, (index, state, detail) => markRowFromResult(rows[index], state, detail));
    if (!results.length) throw new Error(`All ${failures.length} upload(s) failed. The draft is still private; open Sessions to review or delete it. ${failures[0].message}`);

    // Publish whatever uploaded successfully; failed files (if any) can be added afterwards via "Upload more".
    await apiRequest(`/api/admin/sessions/${sessionId}/publish`, { method: 'POST' });
    // Leave the ticked list on screen; "Clear list" or a new selection resets it.
    adminFiles = [];
    photoInput.value = '';
    queueEl.dataset.finished = 'true';
    queueEl.querySelector('.file-queue-head strong').textContent = `${results.length} of ${rows.length} photo${rows.length === 1 ? '' : 's'} published`;
    queueEl.querySelector('.file-queue-head button').textContent = 'Clear list';
    setProgress(100, 0, '');
    if (failures.length) {
      setStatus(`Published! ${results.length} of ${results.length + failures.length} photos are live. ${failures.length} upload(s) failed — open Sessions → "Upload more" on this session to retry. ${failures[0].message}`, true);
    } else {
      setStatus('Published! Your session is live. Open Sessions to follow photo processing.');
    }

    hideProgress();
  } catch (err) {
    setStatus(err.message || 'Upload failed. Your draft session is still private.', true);
    hideProgress();
  } finally {
    uploadBusy = false;
    document.querySelectorAll('#uploadForm input, #uploadForm button').forEach(control => { control.disabled = false; });
    signOutBtn.disabled = false;
    publishBtn.innerHTML = 'Publish photo pack <span>→</span>';
    delete queueEl.dataset.uploading;
    queueEl.querySelectorAll('button').forEach(control => { control.disabled = false; });
  }
});

// ── Dashboard ─────────────────────────────────────────────────────────────────

let dashInterval = null;

async function loadDashboard(silent = false) {
  const grid = document.getElementById('dashboardGrid');
  if (!isAuthenticated()) return;
  if (!silent) grid.innerHTML = '<p class="loading-msg">Loading sessions...</p>';
  try {
    const requestToken = getToken();
    const { sessions } = await apiRequest('/api/admin/dashboard');
    if (!isAuthenticated() || getToken() !== requestToken) return;
    if (!sessions.length) {
      grid.innerHTML = '<p class="empty-msg">No sessions yet. Go to the Upload tab to create one.</p>';
      updateMetrics([]);
      if (dashInterval) { clearInterval(dashInterval); dashInterval = null; }
      return;
    }

    updateMetrics(sessions);

    let hasPending = false;
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
        badgeHtml = `<span class="indexing-badge empty">No Photos Uploaded</span>`;
      } else if (isDone) {
        badgeHtml = `<span class="indexing-badge done">✓ Indexing Complete</span>`;
      } else if (pending > 0) {
        badgeHtml = `<span class="indexing-badge processing"><span class="pulse-dot"></span> Indexing (${pct}%)</span>`;
      } else if (failed > 0) {
        badgeHtml = `<span class="indexing-badge warning">⚠️ ${failed} Failed</span>`;
      } else {
        badgeHtml = `<span class="indexing-badge processing">${pct}% Indexed</span>`;
      }

      const priceRs = Math.round((s.price_paise ?? 70000) / 100);

      return `
        <div class="d-card">
          <div class="d-card-head">
            <span class="d-card-title">${escHtml(s.title)}</span>
            <div style="display:flex;gap:8px;align-items:center;">
              ${badgeHtml}
              <span class="d-card-status ${s.status}">${s.status}</span>
            </div>
          </div>
          <div class="d-card-stats">
            <div><span>Date</span><strong style="font-size:13px;font-weight:500">${escHtml(s.date || '—')}</strong></div>
            <div><span>Location</span><strong style="font-size:13px;font-weight:500">${escHtml(s.location || '—')}</strong></div>
            <div><span>Indexing Progress</span><strong>${pct}% (${indexed} / ${total})</strong></div>
            <div><span>Need attention</span><strong>${failed}</strong></div>
            <div class="spacer"></div>
          </div>
          ${total > 0 ? `
            <div class="card-progress-track">
              <div class="card-progress-fill" style="width: ${pct}%;"></div>
            </div>
          ` : ''}
          <div class="action-group">
            <button class="btn-sm btn-primary-sm view-photos-btn" data-session-id="${escHtml(s.id)}" data-session-title="${escHtml(s.title)}">📷 View Photos (${total})</button>
            <button class="btn-sm upload-more-btn" data-session-id="${escHtml(s.id)}" data-session-title="${escHtml(s.title)}" ${s.status === 'archived' ? 'disabled title="Restore this archived session before uploading more photos."' : ''}>⬆ Upload more</button>
            <button class="btn-sm edit-session-btn" data-session-id="${escHtml(s.id)}" data-title="${escHtml(s.title)}" data-date="${escHtml(s.date || '')}" data-location="${escHtml(s.location || '')}" data-price="${priceRs}" data-status="${s.status}">✏️ Edit</button>
            <button class="btn-sm reindex-btn" data-session-id="${escHtml(s.id)}" ${pending > 0 ? 'disabled' : ''}>${pending > 0 ? 'Processing…' : '↻ Re-index'}</button>
            <button class="delete-btn" data-session-id="${escHtml(s.id)}">Delete</button>
          </div>
        </div>
      `;
    }).join('');

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
  
  titleEl.textContent = `Photos — ${sessionTitle}`;
  grid.innerHTML = '<p class="loading-msg">Loading session photos...</p>';
  openModal(modal);

  try {
    const { photos } = await apiRequest(`/api/admin/sessions/${sessionId}/photos`);
    if (!photos.length) {
      grid.innerHTML = '<p class="empty-msg">No photos uploaded to this session yet.</p>';
      return;
    }
    grid.innerHTML = photos.map((p) => `
      <div class="photo-card" id="photo-card-${p.id}">
        <img src="${p.previewUrl}" alt="${escHtml(p.filename)}" loading="lazy" />
        <span class="photo-badge">${p.indexing_status === 'completed' ? `${p.face_count} face${Number(p.face_count) === 1 ? '' : 's'} detected` : escHtml(p.indexing_status)}</span>
        <p class="photo-processing-note">${p.indexing_error ? escHtml(p.indexing_error) : p.indexing_status === 'completed' && !Number(p.face_count) ? 'No clear faces detected in this photo.' : p.indexing_status === 'pending' ? 'Queued or processing. Refresh to check progress.' : ''}</p>
        <button class="photo-delete-btn" data-photo-id="${p.id}">Delete</button>
      </div>
    `).join('');
  } catch (err) {
    grid.innerHTML = `<p class="loading-msg error-msg">${escHtml(err.message)}</p>`;
  }
}

document.getElementById('galleryGrid').addEventListener('click', async (e) => {
  const btn = e.target.closest('.photo-delete-btn');
  if (!btn) return;
  const photoId = btn.dataset.photoId;
  if (!confirm('Delete this photo permanently?')) return;
  btn.disabled = true;
  btn.textContent = '...';
  try {
    await apiRequest(`/api/admin/photos/${photoId}`, { method: 'DELETE' });
    const card = document.getElementById(`photo-card-${photoId}`);
    if (card) card.remove();
    loadDashboard(true);
  } catch (err) {
    notifyCrew(err.message);
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
    notifyCrew(err.message);
  } finally { saveButton.disabled = false; saveButton.textContent = 'Save changes'; }
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
    if (uploadBusy) return notifyCrew('Wait for the current upload to finish before adding more photos.');
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
    openModal(editSessionModal);
    return;
  }

  // Reindex Session
  const reindexBtn = e.target.closest('.reindex-btn');
  if (reindexBtn) {
    reindexBtn.disabled = true;
    reindexBtn.textContent = 'Adding to queue…';
    try {
      const res = await apiRequest(`/api/admin/sessions/${reindexBtn.dataset.sessionId}/reindex`, { method: 'POST' });
      notifyCrew(`${res.queued || 0} photos queued. ${res.alreadyQueued || 0} already processing.${res.failed ? ` ${res.failed} could not be queued; retry those after processing finishes.` : ''} You can leave this page; processing continues in the background.`);
      loadDashboard();
    } catch (err) {
      notifyCrew(err.message);
    } finally {
      reindexBtn.disabled = false;
      reindexBtn.textContent = '🔄 Re-index';
    }
    return;
  }

  // Delete Session
  const deleteBtn = e.target.closest('.delete-btn');
  if (deleteBtn) {
    const id = deleteBtn.dataset.sessionId;
    if (!confirm('Delete this session and permanently remove ALL its photos from storage? This cannot be undone.')) return;
    deleteBtn.disabled = true;
    deleteBtn.textContent = 'Deleting…';
    try {
      await apiRequest(`/api/admin/sessions/${id}`, { method: 'DELETE' });
      loadDashboard();
    } catch (err) {
      notifyCrew(err.message);
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

function setMoreStatus(text, isError = false) {
  const el = document.getElementById('moreStatus');
  el.textContent = text; el.className = 'upload-status' + (text ? ' visible' : '') + (isError ? ' error' : '');
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
  document.getElementById('moreSummary').textContent = 'Checking your selection…';
  document.getElementById('morePhotos').hidden = true;
  document.getElementById('morePhotoList').replaceChildren();
  releaseThumbnails(moreFiles); moreFiles = [];
  document.getElementById('moreChoice').hidden = true;
  document.querySelector('input[name=duplicateMode][value=skip]').checked = true;
  document.getElementById('moreProgressWrap').classList.add('hidden');
  document.getElementById('moreProgressFill').style.width = '0%';
  setMoreStatus('');
  moreConfirmBtn.disabled = true; moreConfirmBtn.innerHTML = 'Upload photos <span>→</span>';
  moreCancelBtn.textContent = 'Cancel';
  moreRetryBtn.hidden = true;
  if (moreUpload) moreUpload.failedItems = [];
}

morePhotoInput.addEventListener('click', (e) => { e.target.value = null; });
morePhotoInput.addEventListener('change', (e) => prepareUploadMore(e.target.files));
moreCancelBtn.addEventListener('click', () => { if (!uploadBusy) uploadMoreModal.close(); });

async function prepareUploadMore(fileList) {
  const files = [...fileList];
  if (!moreUpload || uploadBusy || !files.length) return;
  if (!files.every(isSupportedPhoto)) return notifyCrew(UNSUPPORTED_FILES);
  resetMoreModal();
  document.getElementById('moreModalTitle').textContent = `Upload more — ${moreUpload.title}`;
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
    document.getElementById('moreSummary').textContent = 'The existing photos could not be checked.';
    setMoreStatus(err.message, true);
  }
}

function renderUploadMore(repeated) {
  const { items, duplicates } = moreUpload;
  const fresh = items.length - duplicates.length;
  const summary = document.getElementById('moreSummary'); summary.replaceChildren();
  const count = document.createElement('strong'); count.textContent = plural(items.length, 'photo');
  summary.append(count, ' selected. ');
  if (duplicates.length) summary.append(`${plural(duplicates.length, 'photo')} already exist${duplicates.length === 1 ? 's' : ''} in this session; ${fresh} ${fresh === 1 ? 'is' : 'are'} new.`);
  else summary.append('None of them are in this session yet.');
  if (repeated) summary.append(` ${plural(repeated, 'repeated file')} in your selection ${repeated === 1 ? 'was' : 'were'} dropped.`);

  // Every selected photo gets a row up front; the rows then show live upload progress.
  document.getElementById('morePhotosTitle').textContent = duplicates.length ? `Selected photos · ${duplicates.length} already in this session` : 'Selected photos';
  const list = document.getElementById('morePhotoList'); list.replaceChildren();
  items.forEach(item => { item.row = photoRow(item.file, { tag: item.duplicate ? 'Already in session' : '' }); list.append(item.row); });
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
  moreConfirmBtn.innerHTML = count ? `Upload ${plural(count, 'photo')} <span>→</span>` : 'Nothing to upload';
  moreConfirmBtn.disabled = !count;
  // Preview the choice: duplicates dim when they are about to be left out.
  const skipping = document.querySelector('input[name=duplicateMode]:checked')?.value === 'skip';
  moreUpload?.duplicates.forEach(item => setRowState(item.row, skipping ? 'skipped' : 'waiting'));
}
document.getElementById('moreChoice').addEventListener('change', updateMoreConfirmLabel);

async function runMoreUpload(items, { skippedByChoice = 0, isRetry = false } = {}) {
  const controls = uploadMoreModal.querySelectorAll('input, button');
  uploadBusy = true; controls.forEach(control => { control.disabled = true; }); signOutBtn.disabled = true;
  moreConfirmBtn.innerHTML = 'Uploading…';
  if (isRetry) moreRetryBtn.textContent = 'Retrying…';
  setMoreStatus(`${isRetry ? 'Retrying' : 'Uploading'} ${plural(items.length, 'photo')}…`);
  try {
    const { results, failures } = await uploadPhotoBatch(moreUpload.sessionId, items, setMoreProgress, (index, state, detail) => markRowFromResult(items[index].row, state, detail));
    const uploaded = results.filter(result => !result.skipped);
    const replaced = uploaded.reduce((sum, result) => sum + (result.replaced || 0), 0);
    const renamed = uploaded.filter(result => result.duplicate === 'renamed');
    const skipped = results.filter(result => result.skipped).length + skippedByChoice;
    const parts = [`${plural(uploaded.length, 'photo')} uploaded and queued for face indexing.`];
    if (replaced) parts.push(`${plural(replaced, 'existing photo')} replaced.`);
    if (renamed.length) parts.push(`${renamed.length === 1 ? '1 copy' : `${renamed.length} copies`} saved as ${renamed.slice(0, 3).map(result => result.filename).join(', ')}${renamed.length > 3 ? '…' : ''}.`);
    if (skipped) parts.push(`${plural(skipped, 'duplicate')} skipped.`);
    if (failures.length) parts.push(`${plural(failures.length, 'upload')} failed — ${failures[0].message}`);
    setMoreStatus(parts.join(' '), Boolean(failures.length));
    moreUpload.failedItems = failures.map(failure => failure.item);
    if (!failures.length) document.getElementById('moreProgressWrap').classList.add('hidden');
    moreUpload.items = []; moreUpload.duplicates = [];
    loadDashboard(true);
  } catch (err) {
    setMoreStatus(err.message || 'Upload failed.', true);
  } finally {
    uploadBusy = false; signOutBtn.disabled = false;
    controls.forEach(control => { control.disabled = false; });
    moreConfirmBtn.disabled = true; moreConfirmBtn.innerHTML = 'Upload photos <span>→</span>';
    moreCancelBtn.textContent = 'Done';
    document.getElementById('moreChoice').hidden = true;
    if (moreUpload.failedItems.length) {
      moreRetryBtn.hidden = false; moreRetryBtn.disabled = false;
      moreRetryBtn.textContent = `Retry ${plural(moreUpload.failedItems.length, 'failed upload')}`;
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
      card.querySelector('.review-load-status').textContent = 'Compare the faces, then choose below.';
      card.querySelectorAll('[data-action="confirm"],[data-action="reject"],input[type=range]').forEach(control => { control.disabled = false; });
    }
  } catch {
    if (!canvas.isConnected) return;
    frame.dataset.state = 'error';
    frame.querySelector('.review-image-label').textContent = 'Photo could not load';
    card.querySelector('.review-load-status').textContent = 'A face could not load. Refresh the queue to try again.';
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
  grid.innerHTML = '<p class="loading-msg review-queue-loading" role="status"><span class="review-spinner" aria-hidden="true"></span>Looking for uncertain face pairs…</p>';
  try {
    const { queue, stats } = await apiRequest('/api/admin/verify-queue');
    if (version !== reviewQueueVersion) return;
    document.getElementById('verifyPending').textContent = stats.pending || 0;
    const unavailable = document.getElementById('reviewUnavailable');
    unavailable.hidden = !stats.unavailable;
    unavailable.textContent = `${stats.unavailable} saved pair(s) cannot be shown yet because face crops are missing or their photos are still processing. Re-index the affected sessions, wait for processing to finish, then scan again.`;
    document.getElementById('verifyConfirmed').textContent = stats.confirmed || 0;
    document.getElementById('verifyRejected').textContent = stats.rejected || 0;
    if (!queue?.length) { grid.innerHTML = '<p class="empty-msg">No uncertain face pairs available. Once photos finish processing, scan again to find pairs for review.</p>'; return; }
    grid.innerHTML = queue.map(item => `
      <article class="verify-card" id="verify-card-${escHtml(item.id)}">
        <div class="review-heading"><div><span class="eyebrow">A SECOND PAIR OF EYES</span><h3>Same person, different moment?</h3><p>${escHtml(item.sessionTitle)}</p></div><span class="review-score">Similarity ${item.similarityPct}%<small>Near the matching cutoff</small></span></div>
        <div class="verify-faces">${[item.photo1, item.photo2].map((photo, index) => `
          <figure class="review-face"><figcaption>FACE ${index === 0 ? 'A' : 'B'}</figcaption><div class="review-image-frame" data-state="waiting" aria-busy="true"><div class="review-image-loader" aria-hidden="true"><span class="review-spinner"></span><span class="review-image-label">Loading face…</span></div><canvas class="face-crop-canvas" data-photo-id="${escHtml(photo.id)}" data-img-url="${escHtml(photo.url)}" data-bbox-norm="${escHtml(JSON.stringify(photo.bboxNorm))}" width="640" height="640" role="img" aria-label="Cropped face ${index === 0 ? 'A' : 'B'} for comparison"></canvas></div><p title="${escHtml(photo.filename)}">${escHtml(photo.filename)}</p></figure>`).join('')}</div>
        <div class="review-zoom"><label>Zoom both faces <input type="range" min="1" max="2.5" step=".1" value="1" disabled><output>1×</output></label><button type="button" data-action="reset-zoom">Reset</button></div>
        <p class="review-load-status" role="status">Loading isolated face crops…</p>
        <div class="verify-actions"><button class="confirm-btn" data-pair-id="${escHtml(item.id)}" data-action="confirm" disabled>✓ Same person</button><button class="reject-btn" data-pair-id="${escHtml(item.id)}" data-action="reject" disabled>✕ Different people</button><button class="review-skip" data-pair-id="${escHtml(item.id)}" data-action="skip">Not sure · skip</button></div>
      </article>`).join('');
    observeReviewImages(grid);
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
  if (button.dataset.action === 'skip') {
    card.remove(); if (!reviewGrid.querySelector('.verify-card')) reviewGrid.innerHTML = '<p class="empty-msg">No more pairs in this batch. Refresh to return to skipped pairs.</p>';
    return;
  }
  card.querySelectorAll('button').forEach(control => { control.disabled = true; });
  const confirmed = button.dataset.action === 'confirm';
  try {
    await apiRequest('/api/admin/confirm-match', { method: 'POST', body: JSON.stringify({ pairId: button.dataset.pairId, confirmed }) });
    card.remove();
    const pending = document.getElementById('verifyPending'); pending.textContent = Math.max(0, Number(pending.textContent) - 1);
    const count = document.getElementById(confirmed ? 'verifyConfirmed' : 'verifyRejected'); count.textContent = Number(count.textContent) + 1;
    if (!reviewGrid.querySelector('.verify-card')) await loadVerifyQueue();
  } catch (error) { card.querySelector('.review-load-status').textContent = error.message; card.querySelectorAll('button').forEach(control => { control.disabled = false; }); }
});

const rescanVerifyBtn = document.getElementById('rescanVerifyBtn');
if (rescanVerifyBtn) {
  rescanVerifyBtn.addEventListener('click', async () => {
    rescanVerifyBtn.disabled = true;
    rescanVerifyBtn.textContent = 'Scanning...';
    try {
      const res = await apiRequest('/api/admin/verify-queue/scan', { method: 'POST' });
      notifyCrew(`✓ Borderline scan complete! Found ${res.generated || 0} candidate pair(s) for verification.`);
      loadVerifyQueue();
    } catch (err) {
      notifyCrew(err.message);
    } finally {
      rescanVerifyBtn.disabled = false;
      rescanVerifyBtn.textContent = '🔍 Rescan Borderline Matches';
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

const LINK_TYPE_LABEL = { burst: ['BURST SEQUENCE', 'Shot moments apart'], appearance: ['SIMILAR OUTFIT', 'Matching clothing colors'] };
let linkQueueVersion = 0;
async function loadLinkQueue() {
  const grid = document.getElementById('linkGrid');
  if (!grid) return;
  const version = ++linkQueueVersion;
  grid.innerHTML = '<p class="loading-msg review-queue-loading" role="status"><span class="review-spinner" aria-hidden="true"></span>Looking for burst and appearance links…</p>';
  try {
    const { queue, stats, trainedOn } = await apiRequest('/api/admin/link-queue');
    if (version !== linkQueueVersion) return;
    document.getElementById('linkPending').textContent = stats.pending || 0;
    document.getElementById('linkConfirmed').textContent = stats.confirmed || 0;
    document.getElementById('linkRejected').textContent = stats.rejected || 0;
    showRetrainStatus(trainedOn);
    if (!queue?.length) { grid.innerHTML = '<p class="empty-msg">No burst or appearance links available. Photos need capture timestamps — re-index a session, then scan again.</p>'; return; }
    grid.innerHTML = queue.map(item => {
      const [eyebrow, note] = LINK_TYPE_LABEL[item.linkType] || LINK_TYPE_LABEL.burst;
      return `
      <article class="verify-card" id="link-card-${escHtml(item.id)}">
        <div class="review-heading"><div><span class="eyebrow">${eyebrow}</span><h3>Same person, different shot?</h3><p>${escHtml(item.sessionTitle)}</p></div><span class="review-score">${item.scorePct}% confidence<small>${note}</small></span></div>
        <div class="verify-faces">${[item.photo1, item.photo2].map((photo, index) => `
          <figure class="review-face"><figcaption>PHOTO ${index === 0 ? 'A' : 'B'}</figcaption><img class="link-photo-img" loading="lazy" src="${escHtml(photo.url)}" alt="Photo ${index === 0 ? 'A' : 'B'} for comparison"><p title="${escHtml(photo.filename)}">${escHtml(photo.filename)}</p></figure>`).join('')}</div>
        <div class="verify-actions"><button class="confirm-btn" data-link-id="${escHtml(item.id)}" data-action="confirm">✓ Same person</button><button class="reject-btn" data-link-id="${escHtml(item.id)}" data-action="reject">✕ Different people</button><button class="review-skip" data-link-id="${escHtml(item.id)}" data-action="skip">Not sure · skip</button></div>
      </article>`;
    }).join('');
    grid.querySelectorAll('.link-photo-img').forEach(img => {
      img.addEventListener('error', () => img.closest('.review-face').classList.add('link-photo-error'), { once: true });
    });
  } catch (error) { if (version === linkQueueVersion) grid.innerHTML = `<p class="loading-msg error-msg">${escHtml(error.message)}</p>`; }
}
const linkGrid = document.getElementById('linkGrid');
if (linkGrid) {
  linkGrid.addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]'); if (!button) return;
    const card = button.closest('.verify-card');
    if (button.dataset.action === 'skip') {
      card.remove(); if (!linkGrid.querySelector('.verify-card')) linkGrid.innerHTML = '<p class="empty-msg">No more links in this batch. Refresh to return to skipped links.</p>';
      return;
    }
    card.querySelectorAll('button').forEach(control => { control.disabled = true; });
    const confirmed = button.dataset.action === 'confirm';
    try {
      await apiRequest('/api/admin/confirm-link', { method: 'POST', body: JSON.stringify({ linkId: button.dataset.linkId, confirmed }) });
      card.remove();
      const pending = document.getElementById('linkPending'); pending.textContent = Math.max(0, Number(pending.textContent) - 1);
      const count = document.getElementById(confirmed ? 'linkConfirmed' : 'linkRejected'); count.textContent = Number(count.textContent) + 1;
      if (!linkGrid.querySelector('.verify-card')) await loadLinkQueue();
    } catch (error) { notifyCrew(error.message); card.querySelectorAll('button').forEach(control => { control.disabled = false; }); }
  });
}

const rescanLinkBtn = document.getElementById('rescanLinkBtn');
if (rescanLinkBtn) {
  rescanLinkBtn.addEventListener('click', async () => {
    rescanLinkBtn.disabled = true;
    rescanLinkBtn.textContent = 'Scanning...';
    try {
      const res = await apiRequest('/api/admin/link-queue/scan', { method: 'POST' });
      notifyCrew(`✓ Scan complete! Found ${res.generated || 0} candidate link(s) for verification.`);
      loadLinkQueue();
    } catch (err) {
      notifyCrew(err.message);
    } finally {
      rescanLinkBtn.disabled = false;
      rescanLinkBtn.textContent = '🔍 Scan Burst & Appearance Links';
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
  el.textContent = trainedOn ? `Fallback-match scoring trained on ${trainedOn} review${trainedOn === 1 ? '' : 's'}` : '';
}
const retrainBtn = document.getElementById('retrainBtn');
if (retrainBtn) {
  retrainBtn.addEventListener('click', async () => {
    retrainBtn.disabled = true;
    retrainBtn.textContent = 'Retraining...';
    try {
      const res = await apiRequest('/api/admin/retrain', { method: 'POST' });
      if (res.trained) { notifyCrew(`✓ Fallback-match scoring retrained on ${res.reviewCount} reviews.`); showRetrainStatus(res.reviewCount); }
      else notifyCrew(`Not enough reviewed pairs yet (${res.reviewCount} so far) — keep reviewing the queues above, then retrain again.`);
    } catch (err) {
      notifyCrew(err.message);
    } finally {
      retrainBtn.disabled = false;
      retrainBtn.textContent = '🧠 Retrain from Reviews';
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


if (isAuthenticated()) showApp();
