// Mambo Jambo crew studio.
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
    if (!result.ok) throw new Error(body.error || 'Incorrect password.');
    setToken(body.token);
    passwordEl.value = '';
    showApp();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Enter studio <span>→</span>';
  }
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
    if (btn.dataset.tab === 'verify') loadVerifyQueue();
  });
});

// ── Modals ────────────────────────────────────────────────────────────────────

const photoGalleryModal = document.getElementById('photoGalleryModal');
const closeGalleryModal = document.getElementById('closeGalleryModal');
const editSessionModal  = document.getElementById('editSessionModal');
const closeEditModal    = document.getElementById('closeEditModal');

function openModal(modal) { modal.querySelector('.modal-notice')?.remove(); modal.classList.remove('hidden'); if (!modal.open) modal.showModal(); }
[photoGalleryModal, editSessionModal].forEach(modal => {
  modal.addEventListener('close', () => modal.classList.add('hidden'));
  modal.addEventListener('click', event => { if (event.target === modal) modal.close(); });
});
closeGalleryModal.addEventListener('click', () => photoGalleryModal.close());
closeEditModal.addEventListener('click', () => editSessionModal.close());
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
  ctx.fillText('MAMBO JAMBO  •  PREVIEW', 0, 0);
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

function selectFiles(files) {
  if (uploadBusy) return;
  const selected = [...files];
  adminFiles = selected.filter(f => ['image/jpeg', 'image/png', 'image/webp'].includes(f.type) && f.size > 0 && f.size <= 25 * 1024 * 1024);
  if (adminFiles.length !== selected.length) {
    adminFiles = []; renderFileList();
    setStatus('Choose only JPG, PNG or WebP photos up to 25 MB each. Remove unsupported files and select again.', true);
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

function renderFileList() {
  const container = document.getElementById('fileQueue'); container.replaceChildren(); container.hidden = !adminFiles.length;
  if (!adminFiles.length) return;
  const header = document.createElement('div'); header.className = 'file-queue-head';
  const summary = document.createElement('strong'); summary.textContent = `${adminFiles.length} photos · ${(adminFiles.reduce((sum, file) => sum + file.size, 0) / 1048576).toFixed(1)} MB`;
  const clear = document.createElement('button'); clear.type = 'button'; clear.textContent = 'Clear selection'; clear.disabled = uploadBusy;
  clear.addEventListener('click', () => { adminFiles = []; photoInput.value = ''; renderFileList(); clearStatus(); });
  header.append(summary, clear); const list = document.createElement('ul');
  adminFiles.forEach((file, index) => {
    const row = document.createElement('li'); const name = document.createElement('span'); name.textContent = file.name;
    const size = document.createElement('small'); size.textContent = `${(file.size / 1048576).toFixed(1)} MB`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove'; remove.disabled = uploadBusy; remove.setAttribute('aria-label', `Remove ${file.name}`);
    remove.addEventListener('click', () => { adminFiles.splice(index, 1); renderFileList(); }); row.append(name, size, remove); list.append(row);
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

// ── Upload: publish ───────────────────────────────────────────────────────────

document.getElementById('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (uploadBusy) return;
  if (!adminFiles.length) return setStatus('Choose at least one photo before publishing.', true);

  const publishBtn = document.getElementById('publishBtn');
  uploadBusy = true;
  document.querySelectorAll('#uploadForm input, #uploadForm button').forEach(control => { control.disabled = true; });
  signOutBtn.disabled = true;
  renderFileList();
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
    const totalBytes = adminFiles.reduce((acc, f) => acc + f.size, 0);
    const startTime = performance.now();
    let fileProgress = new Array(adminFiles.length).fill(0);

    const uploadOne = (file, preview, index) => new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('file', file);
      form.append('preview', preview, `${file.name.replace(/\.[^.]+$/, '')}-preview.jpg`);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', apiUrl(`/api/admin/sessions/${sessionId}/photos`));
      xhr.setRequestHeader('authorization', `Bearer ${getToken()}`);
      xhr.timeout = 120000;
      xhr.ontimeout = () => reject(new Error(`Upload timed out: ${file.name}. Please try again.`));
      xhr.onabort = () => reject(new Error(`Upload cancelled: ${file.name}`));

      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) {
          fileProgress[index] = Math.min(file.size, file.size * ev.loaded / ev.total);
          const uploaded = fileProgress.reduce((a, b) => a + b, 0);
          const elapsed = (performance.now() - startTime) / 1000;
          const speed = (uploaded / 1024) / Math.max(elapsed, 0.1);
          const remaining = Math.max(0, totalBytes - uploaded) / 1024;
          const eta = speed > 0 ? `ETA: ${Math.ceil(remaining / speed)}s` : '';
          const pct = Math.round((uploaded / totalBytes) * 100);
          setProgress(pct, speed, eta);
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          fileProgress[index] = file.size;
          try { resolve(JSON.parse(xhr.responseText)); }
          catch { reject(new Error(`Invalid upload response: ${file.name}`)); }
        } else {
          let detail = `HTTP ${xhr.status}`;
          try { detail = JSON.parse(xhr.responseText).error || detail; } catch { /* Non-JSON gateway response. */ }
          reject(new Error(`${file.name}: ${detail}`));
        }
      };
      xhr.onerror = () => reject(new Error(`Network error: ${file.name}`));
      xhr.send(form);
    });

    setStatus(`Uploading ${adminFiles.length} photo${adminFiles.length === 1 ? '' : 's'}…`);
    setProgress(0, 0, 'calculating...');

    // Wait for every in-flight upload before reporting failure. Limit memory use.
    const queue = adminFiles.map((file, index) => ({ file, index }));
    const failures = [];
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) {
        const { file, index } = queue.shift();
        try { await uploadOne(file, await watermarkedPreview(file), index); }
        catch (error) { failures.push(`${file.name}: ${error.message}`); }
      }
    }));
    if (failures.length) throw new Error(`${failures.length} upload(s) failed. The draft is still private; open Sessions to review uploaded photos. ${failures[0]}`);

    // Mark session published
    await apiRequest(`/api/admin/sessions/${sessionId}/publish`, { method: 'POST' });
    adminFiles = [];
    photoInput.value = '';
    if (typeof renderFileList === 'function') renderFileList();
    setProgress(100, 0, '');
    setStatus('Published! Your session is live. Open Sessions to follow photo processing.');
    
    hideProgress();
  } catch (err) {
    setStatus(err.message || 'Upload failed. Your draft session is still private.', true);
    hideProgress();
  } finally {
    uploadBusy = false;
    document.querySelectorAll('#uploadForm input, #uploadForm button').forEach(control => { control.disabled = false; });
    signOutBtn.disabled = false;
    publishBtn.innerHTML = 'Publish photo pack <span>→</span>';
    renderFileList();
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

      const priceRs = Math.round((s.price_paise || 29900) / 100);

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

// ── Crew Match Verification Queue ─────────────────────────────────────────────

function drawCroppedFaceCanvas(canvasEl) {
  const url = canvasEl.dataset.imgUrl;
  let bboxNorm = null;
  try {
    bboxNorm = JSON.parse(canvasEl.dataset.bboxNorm || 'null');
  } catch (e) {}

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const ctx = canvasEl.getContext('2d');
    const cw = canvasEl.width = 170;
    const ch = canvasEl.height = 170;

    let sx, sy, sw, sh;

    if (bboxNorm && Array.isArray(bboxNorm) && bboxNorm.length === 4) {
      const [topPct, leftPct, widthPct, heightPct] = bboxNorm;
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;

      const fx = (leftPct / 100) * nw;
      const fy = (topPct / 100) * nh;
      const fw = (widthPct / 100) * nw;
      const fh = (heightPct / 100) * nh;

      const pad = Math.max(fw, fh) * 0.3;
      const side = Math.max(fw, fh) + (pad * 2);
      const cx = fx + (fw / 2);
      const cy = fy + (fh / 2);

      sx = Math.max(0, cx - (side / 2));
      sy = Math.max(0, cy - (side / 2));
      sw = Math.min(nw - sx, side);
      sh = Math.min(nh - sy, side);
    } else {
      const side = Math.min(img.naturalWidth, img.naturalHeight) * 0.38;
      sx = (img.naturalWidth - side) / 2;
      sy = img.naturalHeight * 0.12;
      sw = side;
      sh = side;
    }

    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);
  };
  img.src = url;
}

async function loadVerifyQueue() {
  const grid = document.getElementById('verifyGrid');
  grid.innerHTML = '<p class="loading-msg">Loading match verification queue...</p>';
  try {
    const { queue, stats } = await apiRequest('/api/admin/verify-queue');

    if (stats) {
      const pendingEl = document.getElementById('verifyPending');
      const confirmedEl = document.getElementById('verifyConfirmed');
      const rejectedEl = document.getElementById('verifyRejected');
      if (pendingEl) pendingEl.textContent = stats.pending || 0;
      if (confirmedEl) confirmedEl.textContent = stats.confirmed || 0;
      if (rejectedEl) rejectedEl.textContent = stats.rejected || 0;
    }

    if (!queue || !queue.length) {
      grid.innerHTML = '<p class="empty-msg">All borderline face matches verified! Crew match queue is clean. 🤙</p>';
      return;
    }

    grid.innerHTML = queue.map((item) => {
      const bbox1Str = item.photo1.bboxNorm ? JSON.stringify(item.photo1.bboxNorm) : '';
      const bbox2Str = item.photo2.bboxNorm ? JSON.stringify(item.photo2.bboxNorm) : '';

      return `
        <div class="verify-card" id="verify-card-${item.id}">
          <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);padding-bottom:10px;">
            <div style="font:11px var(--mono);color:var(--text);font-weight:600;">Session: ${escHtml(item.sessionTitle)}</div>
            <span style="font:10px var(--mono);font-weight:700;padding:3px 9px;border-radius:20px;background:rgba(248,232,56,0.15);color:var(--marker);border:1px solid rgba(248,232,56,0.3);">Similarity: ${item.similarityPct}%</span>
          </div>
          <div class="verify-faces" style="margin-top:12px;">
            <div style="display:flex;flex-direction:column;align-items:center;gap:6px;">
              <div class="verify-face-wrapper" style="width:170px;height:170px;border-radius:12px;overflow:hidden;border:2px solid rgba(248,232,56,0.35);background:#000;position:relative;">
                <canvas class="face-crop-canvas" data-img-url="${item.photo1.url}" data-bbox-norm='${escHtml(bbox1Str)}' width="170" height="170" style="width:100%;height:100%;display:block;"></canvas>
                <span class="verify-zoom-tip">🔍 Isolated Face</span>
              </div>
              <a href="${item.photo1.url}" target="_blank" style="font:10px var(--mono);color:var(--muted);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:underline;">${escHtml(item.photo1.filename)}</a>
            </div>
            <span class="verify-vs">VS</span>
            <div style="display:flex;flex-direction:column;align-items:center;gap:6px;">
              <div class="verify-face-wrapper" style="width:170px;height:170px;border-radius:12px;overflow:hidden;border:2px solid rgba(248,232,56,0.35);background:#000;position:relative;">
                <canvas class="face-crop-canvas" data-img-url="${item.photo2.url}" data-bbox-norm='${escHtml(bbox2Str)}' width="170" height="170" style="width:100%;height:100%;display:block;"></canvas>
                <span class="verify-zoom-tip">🔍 Isolated Face</span>
              </div>
              <a href="${item.photo2.url}" target="_blank" style="font:10px var(--mono);color:var(--muted);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:underline;">${escHtml(item.photo2.filename)}</a>
            </div>
          </div>
          <div class="verify-actions" style="margin-top:14px;">
            <button class="confirm-btn" data-pair-id="${item.id}" data-action="confirm">✓ Confirm Same Surfer</button>
            <button class="reject-btn" data-pair-id="${item.id}" data-action="reject">✗ Different Surfer</button>
          </div>
        </div>
      `;
    }).join('');

    // Draw isolated face crops on canvases
    document.querySelectorAll('.face-crop-canvas').forEach((canvas) => {
      drawCroppedFaceCanvas(canvas);
    });
  } catch (err) {
    grid.innerHTML = `<p class="loading-msg error-msg">${escHtml(err.message)}</p>`;
  }
}

document.getElementById('verifyGrid').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-pair-id]');
  if (!btn) return;
  const pairId = btn.dataset.pairId;
  const confirmed = btn.dataset.action === 'confirm';
  const card = document.getElementById(`verify-card-${pairId}`);

  btn.disabled = true;
  btn.textContent = confirmed ? 'Confirming...' : 'Rejecting...';

  try {
    await apiRequest('/api/admin/confirm-match', {
      method: 'POST',
      body: JSON.stringify({ pairId, confirmed }),
    });

    if (card) {
      card.style.transition = 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)';
      card.style.opacity = '0';
      card.style.transform = 'translateY(-12px) scale(0.95)';

      setTimeout(() => {
        card.remove();
        const remaining = document.querySelectorAll('.verify-card');
        if (!remaining.length) {
          document.getElementById('verifyGrid').innerHTML = '<p class="empty-msg">All borderline face matches verified! Crew match queue is clean. 🤙</p>';
        }
      }, 350);
    }

    // Update pending counter
    const pendingEl = document.getElementById('verifyPending');
    if (pendingEl) {
      const current = Math.max(0, Number(pendingEl.textContent || 0) - 1);
      pendingEl.textContent = current;
    }
    if (confirmed) {
      const confirmedEl = document.getElementById('verifyConfirmed');
      if (confirmedEl) confirmedEl.textContent = Number(confirmedEl.textContent || 0) + 1;
    } else {
      const rejectedEl = document.getElementById('verifyRejected');
      if (rejectedEl) rejectedEl.textContent = Number(rejectedEl.textContent || 0) + 1;
    }
  } catch (err) {
    notifyCrew(err.message);
    btn.disabled = false;
    btn.textContent = confirmed ? '✓ Confirm Same Surfer' : '✗ Different Surfer';
  }
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


if (isAuthenticated()) showApp();
