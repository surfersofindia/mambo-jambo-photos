/* ============================================================================
   ADMIN (admin.html / admin.js) — patches
   Each block names what it replaces. Apply in order.
   ========================================================================== */

/* ── FIX A1 · notifyCrew() writes to a notice the crew can't see (admin.js:179)
   #adminNotice sits above the tabs; every action result ("✓ Cover updated",
   "Delete failed…") lands off-screen when the crew is scrolled into a long
   session list. Replace with a toast stack (styles in soi-tokens.css). */
const toastRoot = Object.assign(document.createElement('div'), { className: 'soi-toasts' });
toastRoot.setAttribute('aria-live', 'polite'); document.body.append(toastRoot);
const TOAST_ICON = { info: 'stamp-wave', success: 'stamp-sunburst', error: 'stamp-coral' };
function toast(message, kind = 'info', { timeout = kind === 'error' ? 9000 : 5000, action } = {}) {
  const el = document.createElement('div'); el.className = 'soi-toast'; el.dataset.kind = kind; el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = `<svg aria-hidden="true"><use href="soi-stamps.svg#${TOAST_ICON[kind] || TOAST_ICON.info}"/></svg><div></div><button type="button" aria-label="Dismiss">×</button>`;
  el.children[1].textContent = message;
  if (action) { const b = document.createElement('button'); b.type = 'button'; b.textContent = action.label; b.style.cssText = 'text-decoration:underline;opacity:1;min-width:0;margin:6px 0 0'; b.onclick = () => { action.run(); el.remove(); }; el.children[1].append(document.createElement('br'), b); }
  el.querySelector('[aria-label=Dismiss]').onclick = () => el.remove();
  toastRoot.append(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}
function notifyCrew(message) {                       // keep the old signature; route by content
  if (!loginScreen.classList.contains('hidden')) { document.getElementById('loginError').textContent = message; return; }
  toast(message.replace(/^✓\s*/, ''), /^✓/.test(message) ? 'success' : /fail|could not|expired|error|wrong|unable/i.test(message) ? 'error' : 'info');
}

/* ── FIX A2 · Fixed 120 s upload timeout kills every file on slow uplinks (admin.js:378,416)
   12 parallel XHRs share the uplink. On a 2 Mbps hotspot each 8 MB file gets
   ~170 kbps → ~6 min → xhr.timeout fires at 120 s → retries → all fail.
   Use a STALL timeout (no progress for 30 s) and adapt concurrency to measured speed. */
const UPLOAD_STALL_MS = 30000;
let uploadConcurrency = 4;                             // start modest; ramp on fast links
function tuneConcurrency(kbps) { uploadConcurrency = kbps > 4000 ? 12 : kbps > 1500 ? 8 : kbps > 500 ? 4 : 2; }
// inside uploadOne(): replace `xhr.timeout = 120000; xhr.ontimeout = …` with
//   let stall = setTimeout(() => xhr.abort(), UPLOAD_STALL_MS);
//   const kick = () => { clearTimeout(stall); stall = setTimeout(() => { xhr.abort(); }, UPLOAD_STALL_MS); };
//   xhr.upload.onprogress = (ev) => { kick(); if (!ev.lengthComputable) return; fileProgress[index] = …; report(); };
//   xhr.onabort = () => { clearTimeout(stall); cancelled ? reject(new Error('Upload cancelled.')) : failRetryable('Upload stalled — no data for 30 s.'); };
//   xhr.onloadend = () => clearTimeout(stall);
// inside report(): after computing `speed`, call tuneConcurrency(speed) and let the
// worker loop read `uploadConcurrency` each iteration instead of the fixed workerCount:
//   while (queue.length) { if (activeWorkers > uploadConcurrency) { await sleep(500); continue; } … }

/* ── FIX A3 · No way to cancel a running batch (admin.js:491-556) ───────────
   Once "Publish" starts, the only exit is closing the tab (which beforeunload blocks). */
let cancelled = false; const liveRequests = new Set();
// in uploadOne(): liveRequests.add(xhr); xhr.onloadend = () => liveRequests.delete(xhr);
// in the worker loop: `if (cancelled) break;` before `queue.shift()`.
function cancelUpload() { cancelled = true; liveRequests.forEach(x => x.abort()); }
// HTML (inside #progressWrap): <button type="button" class="btn-sm" id="cancelUploadBtn">Cancel upload</button>
document.getElementById('cancelUploadBtn')?.addEventListener('click', async () => {
  if (!uploadBusy) return;
  if (!await confirmAction({ title: 'Stop uploading?', copy: 'Photos already uploaded stay in the draft session. You can add the rest later with "Upload more".', confirmLabel: 'Stop upload' })) return;
  cancelUpload();
});
// The submit handler's `finally` should reset `cancelled = false` and, when cancelled,
// skip the /publish call so the session stays a private draft.

/* ── FIX A4 · iPhone/Mac HEIC exports are rejected (admin.js:279, admin.html:874) ─
   Crew shooting on phones get "Choose only JPG, PNG or WebP". Accept HEIC/HEIF and
   transcode in-browser via createImageBitmap (Safari) or heic2any fallback. */
function isSupportedPhoto(file) {
  const heic = /\.hei[cf]$/i.test(file.name) || /image\/hei[cf]/.test(file.type);
  return (['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || heic) && file.size > 0 && file.size <= 25 * 1024 * 1024;
}
// HTML: accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
// in imageFromFile(): try `createImageBitmap(file)` first (decodes HEIC on Safari/macOS);
// if it throws and the file is HEIC, load https://cdn.jsdelivr.net/npm/heic2any once and convert to JPEG.

/* ── FIX A5 · Selected-but-not-uploaded files vanish silently (admin.js:359) ──
   beforeunload only guards while uploadBusy. A crew member who selected 300
   photos, then taps "Back to site" or pulls-to-refresh, loses the selection. */
window.addEventListener('beforeunload', event => {
  if (uploadBusy || adminFiles.length || (moreUpload?.items?.length && uploadMoreModal.open)) { event.preventDefault(); event.returnValue = ''; }
});
document.querySelector('.back-link').addEventListener('click', event => {
  if (adminFiles.length && !confirm(`${adminFiles.length} selected photos haven't been published. Leave anyway?`)) event.preventDefault();
});

/* ── FIX A6 · Destructive confirm focuses the destructive button (admin.js:165)
   Enter on a stray keypress = "Delete session". Focus Cancel unless typing is required. */
//   return new Promise(resolve => { confirmResolve = resolve; openModal(confirmDialog);
//     (typed ? input : document.getElementById('confirmCancelBtn')).focus(); });

/* ── FIX A7 · Y / N / S shortcuts have no visible target (admin.js:1140) ────
   Highlight the card the keys will act on. */
function markActiveReviewCard() {
  const cards = [...document.querySelectorAll('#verifyGrid .verify-card, #linkGrid .verify-card')];
  const active = cards.find(c => { const b = c.getBoundingClientRect(); return b.bottom > 80 && b.top < innerHeight; });
  cards.forEach(c => c.classList.toggle('is-active', c === active));
}
addEventListener('scroll', () => requestAnimationFrame(markActiveReviewCard), { passive: true });
document.addEventListener('mj:queue-rendered', markActiveReviewCard);   // dispatch this at the end of loadVerifyQueue()/loadLinkQueue()

/* ── FIX A8 · Watermark: replace tiled text with the brand stamp (admin.js:205-231)
   Keeps the un-croppable diagonal text at low alpha but adds the linocut wave
   crest as a corner stamp, so previews look branded instead of "sample". */
const stampImage = new Image(); stampImage.src = 'assets/stamp-wave-linen.png';   // 512px PNG export of #stamp-wave in linen (#F2ECDB)
async function watermarkedPreview(file) {
  const img = await imageFromFile(file);
  const max = 1400, scale = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas'); canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  // 1) low-alpha diagonal text lattice — the anti-crop layer
  ctx.save(); ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate(-Math.PI / 7);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const size = Math.max(16, Math.round(canvas.width / 30)); ctx.font = `700 ${size}px "Plus Jakarta Sans", Arial, sans-serif`;
  const stepY = size * 5, stepX = size * 14, reach = Math.hypot(canvas.width, canvas.height);
  for (let y = -reach, row = 0; y <= reach; y += stepY, row++) for (let x = -reach + (row % 2 ? stepX / 2 : 0); x <= reach; x += stepX) {
    ctx.globalAlpha = .16; ctx.fillStyle = '#2B2018'; ctx.fillText('SURFERS OF INDIA · PREVIEW', x + 1, y + 1);
    ctx.globalAlpha = .28; ctx.fillStyle = '#F2ECDB'; ctx.fillText('SURFERS OF INDIA · PREVIEW', x, y);
  }
  ctx.restore();
  // 2) corner stamp — the brand mark guests will recognise on Instagram
  if (stampImage.complete && stampImage.naturalWidth) {
    const s = Math.round(canvas.width * .11), pad = Math.round(s * .35);
    ctx.save(); ctx.globalAlpha = .82; ctx.shadowColor = 'rgba(43,32,24,.45)'; ctx.shadowBlur = s * .15;
    ctx.drawImage(stampImage, canvas.width - s - pad, canvas.height - s - pad, s, s); ctx.restore();
  }
  const preview = await toJpeg(canvas, .82);
  const thumbScale = Math.min(1, 480 / Math.max(canvas.width, canvas.height));
  const small = document.createElement('canvas'); small.width = Math.max(1, Math.round(canvas.width * thumbScale)); small.height = Math.max(1, Math.round(canvas.height * thumbScale));
  small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
  return Object.assign(preview, { thumb: await toJpeg(small, .78) });
}

/* ── FIX A9 · 12 simultaneous full-size canvas decodes on a phone (admin.js:478)
   Each 24 MP JPEG decodes to ~96 MB RGBA; 12 at once ≈ 1.1 GB → Safari kills the tab.
   Gate preview generation separately from the network. */
const decodeGate = (() => { let active = 0; const q = []; const MAX = 2;
  return async fn => { if (active >= MAX) await new Promise(r => q.push(r)); active++;
    try { return await fn(); } finally { active--; q.shift()?.(); } }; })();
//   const preview = await decodeGate(() => watermarkedPreview(item.file));
// And in imageFromFile(), prefer createImageBitmap(file, { resizeWidth: 1400, resizeQuality: 'high' })
// so the browser downsamples during decode instead of allocating the full frame.

/* ── FIX A10 · Session token lives in sessionStorage with no idle timeout (admin.js:8-11)
   Client-side: drop the token after 30 min idle and warn 2 min before. Server-side
   (Worker): issue a short JWT (30 min) + rotating refresh cookie (HttpOnly; SameSite=None
   because the Worker is cross-origin), so a leaked token dies quickly. */
const IDLE_MS = 30 * 60 * 1000; let idleTimer, warnTimer;
function touchSession() {
  clearTimeout(idleTimer); clearTimeout(warnTimer);
  if (!isAuthenticated()) return;
  warnTimer = setTimeout(() => toast('You will be signed out in 2 minutes. Move the mouse or tap to stay in.', 'info', { timeout: 110000 }), IDLE_MS - 120000);
  idleTimer = setTimeout(() => { if (uploadBusy) return touchSession(); clearToken(); showLogin(); notifyCrew('Signed out after 30 minutes of inactivity.'); }, IDLE_MS);
}
['pointerdown', 'keydown', 'scroll'].forEach(t => addEventListener(t, touchSession, { passive: true }));
touchSession();

/* ── FIX A11 · Rejected-file warning styled as an error even when the batch is fine (admin.js:289)
   "4 photos selected. 1 file was left out…" renders red; the crew reads it as a failure. */
//   setStatus(`${kept} ${rejected.length} file(s) left out…`, /* isError */ false) and add a
//   `data-kind="warning"` attribute so it takes --warning-bg instead of --error-bg.

/* ── FIX A12 · Ship one theme, not two (admin.html:12-802 + admin-theme.css) ──
   The inline <style> is a 27 KB dark theme that admin-theme.css then overrides
   rule-by-rule. Delete the inline block, fold the surviving structural rules into
   admin-theme.css, then load soi-tokens.css. Saves ~20 KB and every "!important". */
