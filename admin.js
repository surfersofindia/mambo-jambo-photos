/**
 * Mambo Jambo — Admin JS
 * Self-contained script for /admin.html only.
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
  signOutBtn.classList.remove('hidden');
  loadDashboard();
  // Set today's date as default
  const dateInput = document.getElementById('adminDate');
  if (!dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);
}

function showLogin() {
  adminApp.classList.add('hidden');
  loginScreen.classList.remove('hidden');
  signOutBtn.classList.add('hidden');
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
  });
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

function setProgress(percent, speed, eta) {
  const wrap = document.getElementById('progressWrap');
  wrap.classList.remove('hidden');
  document.getElementById('progressFill').style.width = `${percent}%`;
  document.getElementById('progressSpeed').textContent = speed ? `${Math.round(speed)} KB/s` : '';
  document.getElementById('progressEta').textContent = eta || '';
}

function hideProgress() {
  document.getElementById('progressWrap').classList.add('hidden');
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
  publishBtn.textContent = 'Uploading…';

  try {
    const title = document.getElementById('adminTitle').value;
    const date = document.getElementById('adminDate').value;
    const location = document.getElementById('adminLocation').value;
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

    setStatus(`Uploading ${adminFiles.length} photos…`);
    setProgress(0, 0, 'calculating...');

    // 10 concurrent uploads
    const queue = adminFiles.map((file, index) => ({ file, index }));
    let active = 0;
    await new Promise((resolve, reject) => {
      let failed = false;
      const next = async () => {
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

    await apiRequest(`/api/admin/sessions/${sessionId}/publish`, { method: 'POST' });
    adminFiles = [];
    photoInput.value = '';
    setStatus('Published! Your new photo pack is live and ready for guests. 🎉');
    hideProgress();
    setTimeout(() => hideProgress(), 2000);
  } catch (err) {
    setStatus(err.message || 'Upload failed. Your draft session is still private.', true);
    hideProgress();
  } finally {
    publishBtn.disabled = false;
    publishBtn.innerHTML = 'Publish photo pack <span>→</span>';
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
      clearInterval(dashInterval); dashInterval = null;
      return;
    }
    let hasPending = false;
    grid.innerHTML = sessions.map((s) => {
      const isDone = s.total_photos > 0 && s.indexed_photos === s.total_photos;
      if (!isDone && s.status !== 'draft') hasPending = true;
      const indexedStr = isDone ? '✓ Done' : `${s.indexed_photos || 0} / ${s.total_photos}`;
      return `
        <div class="d-card">
          <div class="d-card-head">
            <span class="d-card-title">${s.title}</span>
            <span class="d-card-status ${s.status}">${s.status}</span>
          </div>
          <div class="d-card-stats">
            <div><span>Date</span><strong style="font-size:13px; font-weight:500">${s.date || '—'}</strong></div>
            <div><span>Indexed</span><strong>${indexedStr}</strong></div>
            <div><span>Downloads</span><strong>${s.downloads}</strong></div>
            <div class="spacer"></div>
            <button class="delete-btn" data-id="${s.id}" onclick="deleteSession('${s.id}')">Delete</button>
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
    if (!silent) grid.innerHTML = `<p class="loading-msg error-msg">${err.message}</p>`;
  }
}

document.getElementById('refreshBtn').addEventListener('click', loadDashboard);

async function deleteSession(id) {
  if (!confirm('Delete this session and permanently wipe ALL its photos from storage? This cannot be undone.')) return;
  const btn = document.querySelector(`button[data-id="${id}"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
  try {
    await apiRequest(`/api/admin/sessions/${id}`, { method: 'DELETE' });
    loadDashboard();
  } catch (err) {
    alert(err.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
  }
}
