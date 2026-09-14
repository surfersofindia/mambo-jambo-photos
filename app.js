const $ = (selector) => document.querySelector(selector);
const apiBase = (window.MJ_CONFIG?.apiUrl || '').replace(/\/$/, '');
const isLive = Boolean(apiBase);
const money = (paise, currency = 'INR') => new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(paise / 100);
const apiUrl = (path) => path.startsWith('http') ? path : `${apiBase}${path}`;

document.documentElement.classList.add('js');
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const scrollProgress = $('.scroll-progress i');
const hero = $('.hero');
const heroCopy = $('.hero-copy');
const heroImage = $('.hero-image');
let scrollTicking = false;
function updateScrollMotion() {
  const y = window.scrollY;
  const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  scrollProgress.style.setProperty('--progress', `${(y / maxScroll) * 100}%`);
  if (!prefersReducedMotion.matches) {
    const heroDistance = Math.min(y, 720);
    hero.style.setProperty('--hero-opacity', `${Math.max(.1, 1 - heroDistance / 900)}`);
    heroCopy.style.setProperty('--scroll-offset', `${heroDistance * -.12}px`);
    heroImage.style.setProperty('--image-scroll', `${heroDistance * .07}px`);
  }
  scrollTicking = false;
}
window.addEventListener('scroll', () => { if (!scrollTicking) { scrollTicking = true; requestAnimationFrame(updateScrollMotion); } }, { passive: true });
window.addEventListener('resize', updateScrollMotion);
updateScrollMotion();

document.querySelectorAll('[data-enter]').forEach((el, index) => el.style.setProperty('--enter-order', index));
requestAnimationFrame(() => document.querySelectorAll('[data-enter]').forEach((el) => el.classList.add('is-visible')));
const revealObserver = new IntersectionObserver((entries) => entries.forEach((entry) => {
  if (entry.isIntersecting) { entry.target.classList.add('is-visible'); revealObserver.unobserve(entry.target); }
}), { threshold: 0.16 });
document.querySelectorAll('[data-reveal]').forEach((el) => revealObserver.observe(el));

document.querySelectorAll('.ripple').forEach((button) => button.addEventListener('click', (event) => {
  const ring = document.createElement('i');
  ring.className = 'ripple-ring';
  const box = button.getBoundingClientRect();
  ring.style.left = `${event.clientX - box.left}px`; ring.style.top = `${event.clientY - box.top}px`;
  button.append(ring); ring.addEventListener('animationend', () => ring.remove());
}));
document.querySelectorAll('[data-tilt]').forEach((card) => {
  card.addEventListener('pointermove', (event) => {
    if (prefersReducedMotion.matches) return;
    const box = card.getBoundingClientRect();
    card.style.setProperty('--ry', `${((event.clientX - box.left) / box.width - .5) * 5}deg`);
    card.style.setProperty('--rx', `${((event.clientY - box.top) / box.height - .5) * -5}deg`);
  });
  card.addEventListener('pointerleave', () => { card.style.setProperty('--rx', '0deg'); card.style.setProperty('--ry', '0deg'); });
});

async function requestApi(path, options = {}, admin = false) {
  if (!isLive) throw new Error('The live API is not configured yet. Add the deployed Worker URL to config.js.');
  const headers = { ...(typeof options.body === 'string' ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) };
  if (admin) headers.authorization = `Bearer ${sessionStorage.getItem('mj-admin-token') || ''}`;
  const response = await fetch(apiUrl(path), { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Something went wrong. Please try again.');
  return body;
}


function imageFromFile(file) {
  return new Promise((resolve, reject) => {
    const image = new Image(); const url = URL.createObjectURL(file);
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This image could not be read. Try a JPG or PNG.')); };
    image.src = url;
  });
}

async function watermarkedPreview(file) {
  const image = await imageFromFile(file); const max = 1400;
  const scale = Math.min(1, max / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas'); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
  const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, canvas.width, canvas.height);
  context.save(); context.translate(canvas.width / 2, canvas.height / 2); context.rotate(-Math.PI / 7);
  context.globalAlpha = .68; context.fillStyle = '#ffffff'; context.font = `700 ${Math.max(20, Math.round(canvas.width / 18))}px Work Sans, sans-serif`;
  context.textAlign = 'center'; context.fillText('MAMBO JAMBO  •  PREVIEW', 0, 0); context.restore();
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', .82));
}

const uploadStage = $('#uploadStage');
const sessionStage = $('#sessionStage');
const matchingStage = $('#matchingStage');
const sessionOptions = $('#sessionOptions');
const galleryImages = ['assets/backpackers-01.webp', 'assets/backpackers-04.webp', 'assets/backpackers-05.webp', 'assets/backpackers-06.webp', 'assets/backpackers-07.webp', 'assets/backpackers-10.webp', 'assets/backpackers-12.webp', 'assets/mambo-jambo-surf-session.jpg'];
let selfieEmbedding = null;
let selectedSession = null;
let activeSearch = null;
let unlockedPhotos = [];

$('#startFinding').addEventListener('click', () => $('#finder').scrollIntoView({ behavior: 'smooth' }));
const privacyConsent = $('#privacyConsent');
const uploadLabel = $('#uploadLabel');
const selfieInput = $('#selfieInput');
privacyConsent.addEventListener('change', () => {
  const allowed = privacyConsent.checked;
  selfieInput.disabled = !allowed;
  uploadLabel.classList.toggle('disabled', !allowed);
});
function setUploadMessage(message) { uploadStage.querySelector('p').textContent = message; }
function demoSessionOptions() {
  sessionOptions.innerHTML = '<button class="session selected" data-session-id="demo"><span>Today</span><small>Choose this session</small></button><button class="session" data-session-id="demo"><span>Yesterday</span><small>Sample matching flow</small></button><button class="session" data-session-id="demo"><span>Older session</span><small>Available when live</small></button>';
  selectedSession = { id: 'demo', title: 'Morning glass', date: 'Sunday, 14 Sept', location: 'Mulki' };
}
async function loadSessions() {
  if (!isLive) return demoSessionOptions();
  const { sessions } = await requestApi('/api/sessions');
  if (!sessions.length) throw new Error('No photo sessions have been published yet.');
  selectedSession = sessions[0];
  sessionOptions.innerHTML = sessions.slice(0, 3).map((session, index) => `<button class="session ${index === 0 ? 'selected' : ''}" data-session-id="${session.id}"><span>${session.title}</span><small>${session.session_date} · ${session.location}</small></button>`).join('');
}
selfieInput.addEventListener('change', async (event) => {
  const file = event.target.files[0]; if (!file) return;
  $('#selfiePreview').src = URL.createObjectURL(file);
  try {
    if (isLive) {
      setUploadMessage('Ready to find matches...');
      await loadSessions();
    } else demoSessionOptions();
    uploadStage.classList.add('hidden'); sessionStage.classList.remove('hidden');
  } catch (caught) { setUploadMessage(caught.message || 'Could not process that selfie. Please try another image.'); }
});
sessionOptions.addEventListener('click', (event) => {
  const button = event.target.closest('.session'); if (!button) return;
  document.querySelectorAll('.session').forEach((item) => item.classList.remove('selected')); button.classList.add('selected');
  if (isLive) selectedSession = { id: button.dataset.sessionId };
});
$('#findMatches').addEventListener('click', async () => {
  sessionStage.classList.add('hidden'); matchingStage.classList.remove('hidden');
  try {
    if (!isLive) { window.setTimeout(() => showResults(), 1800); return; }
    
    const file = selfieInput.files[0];
    const form = new FormData();
    form.append('sessionId', selectedSession.id);
    form.append('file', file);
    
    const match = await requestApi('/api/match', { method: 'POST', body: form });
    showResults(match);
  } catch (caught) { matchingStage.classList.add('hidden'); sessionStage.classList.remove('hidden'); alert(caught.message || 'Could not find your photos. Please try again.'); }
});

function showResults(match) {
  $('#results').classList.remove('hidden'); matchingStage.classList.add('hidden');
  const unlockButton = $('#unlockPhotos'); const downloadButton = $('#downloadAll');
  if (match) {
    activeSearch = match; unlockedPhotos = [];
    $('#resultsMeta').textContent = `${match.session.date} · ${match.session.location}`.toUpperCase();
    $('#resultsTitle').innerHTML = match.count ? `We found <em>${match.count}</em> shots<br />with your name on ’em.` : 'No exact matches<br />just <em>yet.</em>';
    $('#resultsCopy').textContent = match.count ? `Here are your watermarked previews. Unlock the full set for ${money(match.pricePaise, match.currency)}.` : 'Try a clearer selfie, or ask our crew to take another look.';
    unlockButton.textContent = `Unlock full set · ${money(match.pricePaise, match.currency)}`; unlockButton.classList.toggle('hidden', !match.count); downloadButton.classList.add('hidden');
    $('#gallery').innerHTML = match.previews.map((photo, index) => `<figure class="preview" style="animation-delay:${.18 + index * .065}s"><img src="${apiUrl(photo.url)}" alt="Your watermarked surf-session preview"><div class="payment-lock">MATCH ${photo.score}% · UNLOCK TO DOWNLOAD</div></figure>`).join('');
  } else {
    $('#resultsMeta').textContent = 'SUNDAY, 14 SEPT · MULKI';
    $('#resultsTitle').innerHTML = 'We found <em>18</em> shots<br />with your name on ’em.';
    $('#resultsCopy').textContent = 'This demo has no payment account attached yet. The live version shows watermarked previews until payment succeeds.';
    unlockButton.classList.add('hidden'); downloadButton.classList.remove('hidden');
    $('#gallery').innerHTML = galleryImages.map((src, index) => `<figure style="animation-delay:${.18 + index * .065}s"><img src="${src}" alt="Your Mambo Jambo session photo ${index + 1}"><button title="Save favourite">♡</button></figure>`).join('');
  }
  window.scrollTo(0, 0);
}
$('#backHome').addEventListener('click', () => $('#results').classList.add('hidden'));
$('#gallery').addEventListener('click', (event) => { if (event.target.tagName === 'BUTTON') { const saved = event.target.textContent === '♡'; event.target.textContent = saved ? '♥' : '♡'; event.target.classList.toggle('saved', saved); } });

function loadRazorpay() { return window.Razorpay ? Promise.resolve(window.Razorpay) : loadScript('https://checkout.razorpay.com/v1/checkout.js').then(() => window.Razorpay); }
async function unlockPaidGallery(payload) {
  unlockedPhotos = payload.photos;
  $('#gallery').innerHTML = payload.photos.map((photo, index) => `<figure class="unlocked" style="animation-delay:${.12 + index * .055}s"><img src="${apiUrl(photo.url)}" alt="Your full-resolution surf-session photo"><div class="photo-actions"><a class="dl-btn" href="${apiUrl(photo.url)}" download title="Download this photo">↓</a><button title="Save favourite">♡</button></div></figure>`).join('');
  $('#resultsCopy').textContent = 'Payment confirmed — your full-resolution photos are ready to download.';
  $('#unlockPhotos').classList.add('hidden'); $('#downloadAll').classList.remove('hidden');
}
$('#unlockPhotos').addEventListener('click', async () => {
  try {
    const button = $('#unlockPhotos'); button.disabled = true; button.textContent = 'Opening secure checkout…';
    const checkout = await requestApi('/api/checkout', { method: 'POST', body: JSON.stringify({ searchId: activeSearch.searchId, token: activeSearch.token }) });
    const Razorpay = await loadRazorpay();
    const razorpay = new Razorpay({
      key: checkout.keyId, amount: checkout.amount, currency: checkout.currency, name: checkout.name, description: 'Full-resolution surf photos', order_id: checkout.orderId, theme: { color: '#3070a0' },
      handler: async (payment) => {
        try { await unlockPaidGallery(await requestApi('/api/payment/verify', { method: 'POST', body: JSON.stringify({ searchId: activeSearch.searchId, token: activeSearch.token, ...payment }) })); }
        catch (caught) { alert(caught.message || 'We could not confirm this payment yet. Please contact the surf school with your payment ID.'); }
      },
      modal: { ondismiss: () => { button.disabled = false; button.textContent = `Unlock full set · ${money(activeSearch.pricePaise, activeSearch.currency)}`; } },
    });
    razorpay.open();
  } catch (caught) {
    $('#unlockPhotos').disabled = false; $('#unlockPhotos').textContent = activeSearch ? `Unlock full set · ${money(activeSearch.pricePaise, activeSearch.currency)}` : 'Unlock full set';
    alert(caught.message || 'Checkout could not open. Please try again.');
  }
});
$('#downloadAll').addEventListener('click', () => { if (!unlockedPhotos.length) return alert('Downloads are available after payment.'); unlockedPhotos.forEach((photo) => window.open(apiUrl(photo.url), '_blank', 'noopener')); });

function admin(open) { $('#adminPanel').classList.toggle('hidden', !open); $('#overlay').classList.toggle('hidden', !open); }
function updateAdminState() { const authenticated = Boolean(sessionStorage.getItem('mj-admin-token')); $('#adminLoginForm').classList.toggle('hidden', authenticated); $('#adminWorkspace').classList.toggle('hidden', !authenticated); }
$('#openAdmin').addEventListener('click', () => { admin(true); updateAdminState(); });
$('#closeAdmin').addEventListener('click', () => admin(false)); $('#overlay').addEventListener('click', () => admin(false));
$('#adminLoginForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const message = $('#adminLoginMessage');
  try { const result = await requestApi('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('#adminPassword').value }) }); sessionStorage.setItem('mj-admin-token', result.token); $('#adminPassword').value = ''; updateAdminState(); }
  catch (caught) { message.textContent = caught.message || 'Could not sign in.'; }
});

let adminFiles = [];
function setUploadStatus(text, isError = false) { const status = $('#adminUploadStatus'); status.textContent = text; status.classList.remove('hidden'); status.classList.toggle('error', isError); }
function updateProgress(percent, speed, eta) { const c = $('#adminUploadProgress'); c.classList.add('visible'); c.style.setProperty('--progress', `${percent}%`); $('#adminSpeed').textContent = speed ? `${speed} KB/s` : ''; $('#adminEta').textContent = eta ? `ETA: ${eta}` : ''; }
function hideProgress() { $('#adminUploadProgress').classList.remove('visible'); }
function selectAdminFiles(files) { 
  adminFiles = [...files].filter((file) => file.type.startsWith('image/')); 
  setUploadStatus(adminFiles.length ? `${adminFiles.length} photo${adminFiles.length === 1 ? '' : 's'} selected. Scroll down and click "Publish photo pack" to begin uploading.` : 'Choose JPG or PNG photos to continue.', !adminFiles.length); 
  if (adminFiles.length > 0) {
    window.setTimeout(() => $('#publishSession').scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
  }
}
$('#adminPhotoInput').addEventListener('click', (event) => { event.target.value = null; });
$('#adminPhotoInput').addEventListener('change', (event) => selectAdminFiles(event.target.files));
const dropZone = $('#adminDropZone');
['dragenter', 'dragover'].forEach((type) => dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((type) => dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.remove('dragging'); }));
dropZone.addEventListener('drop', (event) => selectAdminFiles(event.dataTransfer.files));
$('#adminWorkspace').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!adminFiles.length) return setUploadStatus('Choose at least one JPG or PNG photo before publishing.', true);    const create = await requestApi('/api/admin/sessions', { method: 'POST', body: JSON.stringify({ title: $('#adminTitle').value, date: $('#adminDate').value, location: $('#adminLocation').value, pricePaise: Math.round(Number($('#adminPrice').value) * 100) }) }, true);
    
    const totalBytes = adminFiles.reduce((acc, file) => acc + file.size, 0);
    const startTime = performance.now();
    let fileProgress = new Array(adminFiles.length).fill(0);
    
    const uploadPhotoWithProgress = (file, preview, sessionId, index) => {
      return new Promise((resolve, reject) => {
        const form = new FormData();
        form.append('file', file);
        form.append('preview', preview, `${file.name.replace(/\\.[^.]+$/, '')}-preview.jpg`);
        
        const xhr = new XMLHttpRequest();
        xhr.open('POST', apiUrl(`/api/admin/sessions/${sessionId}/photos`));
        xhr.setRequestHeader('authorization', `Bearer ${sessionStorage.getItem('mj-admin-token') || ''}`);
        
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            fileProgress[index] = e.loaded;
            const currentTotalUploaded = fileProgress.reduce((a, b) => a + b, 0);
            const elapsed = (performance.now() - startTime) / 1000;
            const avgSpeed = (currentTotalUploaded / 1024) / Math.max(elapsed, 0.1);
            const remainingBytes = totalBytes - currentTotalUploaded;
            const remainingSeconds = avgSpeed > 0 ? (remainingBytes / 1024) / avgSpeed : 0;
            const etaText = remainingSeconds > 0 ? `${Math.ceil(remainingSeconds)}s` : 'almost done...';
            const percent = Math.round((currentTotalUploaded / totalBytes) * 100);
            updateProgress(percent, Math.round(avgSpeed), etaText);
          }
        };
        
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            fileProgress[index] = file.size;
            resolve(JSON.parse(xhr.responseText));
          } else {
            reject(new Error(`Upload failed for ${file.name}`));
          }
        };
        xhr.onerror = () => reject(new Error(`Network error during upload of ${file.name}`));
        xhr.send(form);
      });
    };

    setUploadStatus(`Uploading ${adminFiles.length} photos...`);
    updateProgress(0, 0, 'calculating...');
    
    let queue = adminFiles.map((file, index) => ({ file, index }));
    let active = 0;
    
    await new Promise((resolve, reject) => {
      let isRejected = false;
      const next = async () => {
        if (isRejected) return;
        if (queue.length === 0 && active === 0) return resolve();
        while (active < 4 && queue.length > 0) {
          const { file, index } = queue.shift();
          active++;
          watermarkedPreview(file).then(preview => {
            return uploadPhotoWithProgress(file, preview, create.session.id, index);
          }).then(() => {
            active--;
            next();
          }).catch(err => {
            if (!isRejected) { isRejected = true; reject(err); }
          });
        }
      };
      next();
    });

    await requestApi(`/api/admin/sessions/${create.session.id}/publish`, { method: 'POST' }, true);
    adminFiles = []; $('#adminPhotoInput').value = ''; setUploadStatus('Published! Your new photo pack is live and ready for guests.'); await loadSessions();
    window.setTimeout(() => hideProgress(), 2000);
  } catch (caught) { hideProgress(); setUploadStatus(caught.message || 'The upload did not complete. Your draft session is still private.', true); }
});

const toggleAdminView = $('#toggleAdminView');
const adminDashboard = $('#adminDashboard');
const dashboardList = $('#dashboardList');

toggleAdminView.addEventListener('click', () => {
  const isDashboard = adminWorkspace.classList.contains('hidden');
  if (isDashboard) {
    adminDashboard.classList.add('hidden');
    adminWorkspace.classList.remove('hidden');
    $('#toggleAdminView').classList.remove('hidden');
    toggleAdminView.textContent = 'View Dashboard';
    if (dashboardInterval) { clearInterval(dashboardInterval); dashboardInterval = null; }
  } else {
    adminWorkspace.classList.add('hidden');
    adminDashboard.classList.remove('hidden');
    toggleAdminView.textContent = 'New Session';
    loadDashboard();
  }
});

$('#refreshDashboard').addEventListener('click', loadDashboard);

let dashboardInterval = null;
async function loadDashboard(silent = false) {
  if (!silent) dashboardList.innerHTML = 'Loading...';
  try {
    const { sessions } = await requestApi('/api/admin/dashboard', {}, true);
    if (!sessions.length) {
      dashboardList.innerHTML = '<p>No sessions found.</p>';
      if (dashboardInterval) { clearInterval(dashboardInterval); dashboardInterval = null; }
      return;
    }
    let hasPending = false;
    dashboardList.innerHTML = sessions.map((s) => {
      const isDone = s.indexed_photos === s.total_photos && s.total_photos > 0;
      if (!isDone && s.status !== 'draft') hasPending = true;
      const indexedStr = isDone ? 'Done' : `${s.indexed_photos || 0} / ${s.total_photos}`;
      return `
        <div class="dashboard-card">
          <div class="dashboard-card-head">
            <span class="dashboard-card-title">${s.title}</span>
            <span class="dashboard-card-status ${s.status}">${s.status}</span>
          </div>
          <div class="dashboard-card-stats">
            <div><span>Indexed</span><strong>${indexedStr}</strong></div>
            <div><span>Downloads</span><strong>${s.downloads}</strong></div>
          </div>
        </div>
      `;
    }).join('');
    
    if (hasPending && !dashboardInterval) {
      dashboardInterval = setInterval(() => loadDashboard(true), 4000);
    } else if (!hasPending && dashboardInterval) {
      clearInterval(dashboardInterval);
      dashboardInterval = null;
    }
  } catch (err) {
    if (!silent) dashboardList.innerHTML = `<p style="color:var(--coral)">${err.message}</p>`;
  }
}

