/**
 * Mambo Jambo — Admin JS
 * Self-contained script for /admin.html only.
 * Bugs fixed:
 *  1. Sign-out: topbar "Sign out" was styled hidden by CSS class but
 *     the class toggle was correct — real issue was the button sitting
 *     OUTSIDE #adminApp so showApp() needed to show it independently. ✓
 *  2. Delete: CORS missing DELETE method (fixed in worker.js already). ✓
 *  3. Progress bar: called hideProgress() immediately after setting success
 *     status AND then again after 2s timeout — now only hides after 2s. ✓
 *  4. loadDashboard() called from showApp() even when dashboard tab is not
 *     active — wastes network requests on login. Now only loads on tab switch. ✓
 *  5. deleteSession: called via inline onclick string which breaks if
 *     session IDs have special chars. Switched to event delegation. ✓
 *  6. sign-out didn't clear dashInterval so auto-refresh kept running. ✓
 *  7. Login button text lost its <span>→</span> when re-enabled after error. ✓
 */

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
  const resp = await fetch(apiUrl(path), { ...options, headers });
  const body = await resp.json().catch(() => ({}));
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
  if (!dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);
  // Don't auto-load dashboard — only load when tab is clicked
}

function showLogin() {
  // Stop any running auto-refresh
  if (dashInterval) { clearInterval(dashInterval); dashInterval = null; }
  adminApp.classList.add('hidden');
  loginScreen.classList.remove('hidden');
  signOutBtn.classList.add('hidden');
  // Reset tabs back to Upload so next login starts fresh
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  document.querySelector('.tab-btn[data-tab="upload"]').classList.add('active');
  document.getElementById('tab-upload').classList.add('active');
}

if (isAuthenticated()) {
  showApp();
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
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
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

if (closeGalleryModal) {
  closeGalleryModal.addEventListener('click', () => photoGalleryModal.classList.add('hidden'));
}
if (closeEditModal) {
  closeEditModal.addEventListener('click', () => editSessionModal.classList.add('hidden'));
}
[photoGalleryModal, editSessionModal].forEach((modal) => {
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });
  }
});

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
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', .82));
}

// ── Upload: file selection & drag/drop ────────────────────────────────────────

let adminFiles = [];
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
  adminFiles = [...files].filter((f) => f.type.startsWith('image/'));
  if (adminFiles.length) {
    setStatus(`${adminFiles.length} photo${adminFiles.length === 1 ? '' : 's'} selected. Click "Publish photo pack" to upload.`);
    window.setTimeout(() => document.getElementById('publishBtn').scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
  } else {
    setStatus('No valid images selected. Choose JPG or PNG files.', true);
  }
}

photoInput.addEventListener('click', (e) => { e.target.value = null; });
photoInput.addEventListener('change', (e) => selectFiles(e.target.files));
['dragenter', 'dragover'].forEach((t) => dropZone.addEventListener(t, (e) => { e.preventDefault(); dropZone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((t) => dropZone.addEventListener(t, (e) => { e.preventDefault(); dropZone.classList.remove('dragging'); }));
dropZone.addEventListener('drop', (e) => selectFiles(e.dataTransfer.files));

// ── Upload: publish ───────────────────────────────────────────────────────────

document.getElementById('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!adminFiles.length) return setStatus('Choose at least one photo before publishing.', true);

  const publishBtn = document.getElementById('publishBtn');
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

      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) {
          fileProgress[index] = ev.loaded;
          const uploaded = fileProgress.reduce((a, b) => a + b, 0);
          const elapsed = (performance.now() - startTime) / 1000;
          const speed = (uploaded / 1024) / Math.max(elapsed, 0.1);
          const remaining = (totalBytes - uploaded) / 1024;
          const eta = speed > 0 ? `ETA: ${Math.ceil(remaining / speed)}s` : '';
          const pct = Math.round((uploaded / totalBytes) * 100);
          setProgress(pct, speed, eta);
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          fileProgress[index] = file.size;
          resolve(JSON.parse(xhr.responseText));
        } else {
          reject(new Error(`Upload failed: ${file.name}`));
        }
      };
      xhr.onerror = () => reject(new Error(`Network error: ${file.name}`));
      xhr.send(form);
    });

    setStatus(`Uploading ${adminFiles.length} photo${adminFiles.length === 1 ? '' : 's'}…`);
    setProgress(0, 0, 'calculating...');

    // Up to 10 concurrent uploads
    const queue = adminFiles.map((file, index) => ({ file, index }));
    let active = 0;
    await new Promise((resolve, reject) => {
      let failed = false;
      const next = () => {
        if (failed) return;
        if (queue.length === 0 && active === 0) return resolve();
        while (active < 10 && queue.length > 0) {
          const { file, index } = queue.shift();
          active++;
          watermarkedPreview(file)
            .then((preview) => uploadOne(file, preview, index))
            .then(() => { active--; next(); })
            .catch((err) => { if (!failed) { failed = true; reject(err); } });
        }
      };
      next();
    });

    const photoCount = adminFiles.length;
    const estMins = Math.max(1, Math.ceil((photoCount * 10) / 60));

    // Mark session published
    await apiRequest(`/api/admin/sessions/${sessionId}/publish`, { method: 'POST' });
    adminFiles = [];
    photoInput.value = '';
    if (typeof renderFileList === 'function') renderFileList();
    setProgress(100, 0, '');
    setStatus(`✓ Published! Your session is now live. Background face indexing will take ~${estMins} min${estMins > 1 ? 's' : ''} to complete.`);
    
    publishBtn.innerHTML = 'Published! ✓';
    publishBtn.classList.add('published-state');

    setTimeout(() => hideProgress(), 1800);
    setTimeout(() => {
      publishBtn.disabled = false;
      publishBtn.classList.remove('published-state');
      publishBtn.innerHTML = 'Publish photo pack <span>→</span>';
    }, 4000);
  } catch (err) {
    setStatus(err.message || 'Upload failed. Your draft session is still private.', true);
    hideProgress();
    publishBtn.disabled = false;
    publishBtn.classList.remove('published-state');
  }
});

// ── Dashboard ─────────────────────────────────────────────────────────────────

let dashInterval = null;

async function loadDashboard(silent = false) {
  const grid = document.getElementById('dashboardGrid');
  if (!silent) grid.innerHTML = '<p class="loading-msg">Loading sessions...</p>';
  try {
    const { sessions } = await apiRequest('/api/admin/dashboard');
    if (!sessions.length) {
      grid.innerHTML = '<p class="empty-msg">No sessions yet. Go to the Upload tab to create one.</p>';
      updateMetrics([]);
      if (dashInterval) { clearInterval(dashInterval); dashInterval = null; }
      return;
    }

    updateMetrics(sessions);

    let hasPending = false;
    grid.innerHTML = sessions.map((s) => {
      const isDone = s.total_photos > 0 && s.indexed_photos === s.total_photos;
      if (!isDone && s.status !== 'draft') hasPending = true;
      const indexedStr = isDone ? '✓ Done' : `${s.indexed_photos || 0} / ${s.total_photos || '?'}`;
      const priceRs = Math.round((s.price_paise || 29900) / 100);

      return `
        <div class="d-card">
          <div class="d-card-head">
            <span class="d-card-title">${escHtml(s.title)}</span>
            <span class="d-card-status ${s.status}">${s.status}</span>
          </div>
          <div class="d-card-stats">
            <div><span>Date</span><strong style="font-size:13px;font-weight:500">${escHtml(s.date || '—')}</strong></div>
            <div><span>Photos</span><strong>${indexedStr}</strong></div>
            <div><span>Downloads</span><strong>${s.downloads}</strong></div>
            <div class="spacer"></div>
          </div>
          <div class="action-group">
            <button class="btn-sm btn-primary-sm view-photos-btn" data-session-id="${escHtml(s.id)}" data-session-title="${escHtml(s.title)}">📷 View Photos (${s.total_photos || 0})</button>
            <button class="btn-sm edit-session-btn" data-session-id="${escHtml(s.id)}" data-title="${escHtml(s.title)}" data-date="${escHtml(s.date || '')}" data-location="${escHtml(s.location || '')}" data-price="${priceRs}" data-status="${s.status}">✏️ Edit</button>
            <button class="btn-sm reindex-btn" data-session-id="${escHtml(s.id)}">🔄 Re-index</button>
            <button class="delete-btn" data-session-id="${escHtml(s.id)}">Delete</button>
          </div>
        </div>
      `;
    }).join('');

    if (hasPending && !dashInterval) {
      dashInterval = setInterval(() => loadDashboard(true), 5000);
    } else if (!hasPending && dashInterval) {
      clearInterval(dashInterval); dashInterval = null;
    }
  } catch (err) {
    if (!silent) grid.innerHTML = `<p class="loading-msg error-msg">${escHtml(err.message)}</p>`;
  }
}

function updateMetrics(sessions) {
  let totalDownloads = 0;
  let totalPhotos = 0;
  let totalRevenuePaise = 0;
  let activeSessions = 0;

  sessions.forEach((s) => {
    totalDownloads += Number(s.downloads || 0);
    totalPhotos += Number(s.total_photos || 0);
    if (s.status === 'published') activeSessions++;
    totalRevenuePaise += (Number(s.downloads || 0) * Number(s.price_paise || 29900));
  });

  const revRs = Math.round(totalRevenuePaise / 100);
  document.getElementById('statRevenue').textContent = `₹${revRs.toLocaleString('en-IN')}`;
  document.getElementById('statDownloads').textContent = totalDownloads;
  document.getElementById('statPhotos').textContent = totalPhotos;
  document.getElementById('statSessions').textContent = activeSessions;
}

// ── View Session Photos Modal ────────────────────────────────────────────────

async function viewSessionPhotos(sessionId, sessionTitle) {
  const modal = document.getElementById('photoGalleryModal');
  const titleEl = document.getElementById('galleryModalTitle');
  const grid = document.getElementById('galleryGrid');
  
  titleEl.textContent = `Photos — ${sessionTitle}`;
  grid.innerHTML = '<p class="loading-msg">Loading session photos...</p>';
  modal.classList.remove('hidden');

  try {
    const { photos } = await apiRequest(`/api/admin/sessions/${sessionId}/photos`);
    if (!photos.length) {
      grid.innerHTML = '<p class="empty-msg">No photos uploaded to this session yet.</p>';
      return;
    }
    grid.innerHTML = photos.map((p) => `
      <div class="photo-card" id="photo-card-${p.id}">
        <img src="${p.previewUrl}" alt="${escHtml(p.filename)}" loading="lazy" />
        <span class="photo-badge">${p.face_count} face${p.face_count === 1 ? '' : 's'}</span>
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
    alert(err.message);
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

  try {
    await apiRequest(`/api/admin/sessions/${sessionId}`, {
      method: 'PUT',
      body: JSON.stringify({ title, date, location, pricePaise, status }),
    });
    document.getElementById('editSessionModal').classList.add('hidden');
    loadDashboard();
  } catch (err) {
    alert(err.message);
  }
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
    document.getElementById('editSessionModal').classList.remove('hidden');
    return;
  }

  // Reindex Session
  const reindexBtn = e.target.closest('.reindex-btn');
  if (reindexBtn) {
    reindexBtn.disabled = true;
    reindexBtn.textContent = 'Indexing...';
    try {
      const res = await apiRequest(`/api/admin/sessions/${reindexBtn.dataset.sessionId}/reindex`, { method: 'POST' });
      alert(`Queued ${res.queued || 0} photos for background face scanning!`);
      loadDashboard();
    } catch (err) {
      alert(err.message);
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
      alert(err.message);
      deleteBtn.disabled = false;
      deleteBtn.textContent = 'Delete';
    }
    return;
  }
});

document.getElementById('refreshBtn').addEventListener('click', () => loadDashboard());

// ── Crew Match Verification Queue ─────────────────────────────────────────────

async function loadVerifyQueue() {
  const grid = document.getElementById('verifyGrid');
  grid.innerHTML = '<p class="loading-msg">Loading match verification queue...</p>';
  try {
    const { queue } = await apiRequest('/api/admin/verify-queue');
    if (!queue || !queue.length) {
      grid.innerHTML = '<p class="empty-msg">All face matches verified! Crew match queue is clean. 🤙</p>';
      return;
    }
    grid.innerHTML = queue.map((item) => `
      <div class="verify-card" id="verify-card-${item.id}">
        <div style="font:11px var(--mono);color:var(--muted);text-align:center;">Session: ${escHtml(item.sessionTitle)}</div>
        <div class="verify-faces">
          <div class="verify-face-wrapper" title="Hover to view full photo">
            <img src="${item.photo1Url}" class="verify-face-img" alt="Face 1" />
            <span class="verify-zoom-tip">🔍 Face Crop</span>
          </div>
          <span class="verify-vs">VS</span>
          <div class="verify-face-wrapper" title="Hover to view full photo">
            <img src="${item.photo2Url}" class="verify-face-img" alt="Face 2" />
            <span class="verify-zoom-tip">🔍 Face Crop</span>
          </div>
        </div>
        <div class="verify-actions">
          <button class="confirm-btn" data-pair-id="${item.id}" data-action="confirm">✓ Confirm Match</button>
          <button class="reject-btn" data-pair-id="${item.id}" data-action="reject">✗ Not Same Person</button>
        </div>
      </div>
    `).join('');
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
      // Smooth fade out & slide up animation before removal
      card.style.transition = 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)';
      card.style.opacity = '0';
      card.style.transform = 'translateY(-12px) scale(0.95)';

      setTimeout(() => {
        card.remove();
        const remaining = document.querySelectorAll('.verify-card');
        if (!remaining.length) {
          document.getElementById('verifyGrid').innerHTML = '<p class="empty-msg">All face matches verified! Crew match queue is clean. 🤙</p>';
        }
      }, 350);
    }
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
    btn.textContent = confirmed ? '✓ Confirm Match' : '✗ Not Same Person';
  }
});

const refreshVerifyBtn = document.getElementById('refreshVerifyBtn');
if (refreshVerifyBtn) {
  refreshVerifyBtn.addEventListener('click', () => loadVerifyQueue());
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

