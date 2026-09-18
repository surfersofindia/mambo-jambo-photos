// The crew studio against the mocked API (no crew credentials exist on the machines that run this, and the real
// login endpoint locks the crew out after five misses): login → upload queue with three files, one rejected →
// publish → sessions tab → edit modal dirty guard → typed delete confirm → upload-more duplicate choice, plus the
// duplicate-session guard, the mid-batch re-auth pause and sign-out. Runs on mobile-375 and desktop-1024.
import sharp from 'sharp';
import { test, expect } from './helpers/fixtures.mjs';
import { ADMIN_PASSWORD, ADMIN_TOKEN } from './helpers/mock-api.mjs';
import { cardMenuItem, crewPicks, openAdminLogin, openSessionsTab, openStudio, queueFiles, settleImages, signIn } from './helpers/flows.mjs';

const LEFT_OUT = '2 ready. 1 left out (JPG, PNG, WebP or HEIC up to 25 MB): notes.txt.';
// The studio encodes previews and thumbs as WebP wherever canvas.toBlob really produces one; these
// tests run on Chromium, which does (a browser that does not gets JPEG — see tests/uploads.test.mjs).
const CHROMIUM_PREVIEW = 'webp';
// Session conditions (W3-C / migration 0014) are always sent, null when the crew left them empty.
const NO_CONDITIONS = { breakName: null, swellFt: null, wind: null, tide: null, photographer: null, nextDropAt: null };

async function fillSessionForm(page, { title = 'Evening glass', date = '2026-09-17', location = 'Kodi Bengre', price = '700' } = {}) {
  await page.locator('#adminTitle').fill(title);
  await page.locator('#adminDate').fill(date);
  await page.locator('#adminLocation').fill(location);
  await page.locator('#adminPrice').fill(price);
}
const rowStates = page => page.locator('#fileQueue li.photo-row').evaluateAll(rows => rows.map(row => row.dataset.state));

test.describe('sign in', () => {
  test('a wrong password shows the inline error; the right one opens the studio and starts the health pill', async ({ page, api, pageErrors }) => {
    await openAdminLogin(page);
    await expect(page.locator('#adminName')).toBeFocused();   // W4-C: the name comes first; it is remembered after the first sign-in
    await page.locator('#adminPassword').fill('nope');
    await page.locator('#loginForm button[type=submit]').click();
    await expect(page.locator('#loginError')).toHaveText('Incorrect password.');
    await expect(page.locator('#loginScreen')).toBeVisible();
    await signIn(page);
    await expect(page.locator('#loginScreen')).toBeHidden();
    await expect(page.locator('#signOutBtn')).toBeVisible();
    await expect(page.locator('#apiHealth')).toBeVisible();
    await expect(page.locator('#apiHealth')).toHaveAttribute('data-state', 'ok');
    await expect(page.locator('#adminDate')).toHaveValue('2026-09-17');   // "today" under the fixed clock (IST)
    expect(await page.evaluate(() => sessionStorage.getItem('mj-admin-token'))).toBe(ADMIN_TOKEN);
    const logins = api.calls.filter(call => call.path === '/api/admin/login');
    expect(logins).toHaveLength(2);
    expect(logins.every(call => call.body.password === '***')).toBe(true);   // the mock never records the real value
    expect(api.calls.some(call => call.path === '/api/health')).toBe(true);
    expect(pageErrors).toEqual([]);
  });

  test('Sign out revokes the token server-side and returns to the login screen', async ({ page, api }) => {
    await openStudio(page);
    await page.locator('#signOutBtn').click();
    await expect(page.locator('#loginScreen')).toBeVisible();
    await expect(page.locator('#adminApp')).toBeHidden();
    await expect.poll(() => api.calls.some(call => call.path === '/api/admin/logout' && !call.unauthorised)).toBe(true);
    expect(await page.evaluate(() => sessionStorage.getItem('mj-admin-token'))).toBeNull();
  });

  test('a stale token is refused by the first authenticated call and the crew lands on the login screen', async ({ page, api }) => {
    api.state.token = 'rotated-elsewhere';
    await page.addInitScript(token => sessionStorage.setItem('mj-admin-token', token), ADMIN_TOKEN);
    await page.goto('/admin.html');
    await expect(page.locator('#adminApp')).toBeVisible();
    await page.locator('#nav-dashboard').click();
    await expect(page.locator('#loginScreen')).toBeVisible();
    expect(api.calls.find(call => call.path === '/api/admin/dashboard').unauthorised).toBe(true);
  });
});

test.describe('upload', () => {
  test('a pick of three files queues two photos, leaves the text file out and publishes a new session', async ({ page, api, pageErrors }) => {
    await openStudio(page);
    const picks = await crewPicks();
    await queueFiles(page, [picks.jpeg, picks.webp, picks.text]);
    await expect(page.locator('#fileQueue li.photo-row')).toHaveCount(2);
    await expect(page.locator('#fileQueue .photo-row-name').nth(0)).toContainText('SOI_0412.jpg');
    await expect(page.locator('#fileQueue .photo-row-name').nth(1)).toContainText('SOI_0413.webp');
    await expect(page.locator('#uploadStatus')).toHaveText(LEFT_OUT);
    await expect(page.locator('#uploadStatus')).toHaveAttribute('data-kind', 'warning');   // a heads-up, not an error
    await expect(page.locator('#uploadStatus')).not.toHaveClass(/error/);
    await expect(page.locator('#publishBtn')).toBeEnabled();
    await settleImages(page, '#fileQueue img');   // queue thumbnails come from the preview worker

    await fillSessionForm(page);
    await page.locator('#publishBtn').click();
    await expect(page.locator('#uploadStatus')).toHaveText('Live. Faces are indexing — watch it in Sessions.', { timeout: 30_000 });
    expect(await rowStates(page)).toEqual(['done', 'done']);
    await expect(page.locator('#fileQueue .file-queue-head strong')).toHaveText('2 of 2 photos published');
    await expect(page.locator('#publishBtn')).toHaveText('Publish');

    const paths = api.calls.map(call => `${call.method} ${call.path}`);
    expect(paths.indexOf('GET /api/admin/dashboard')).toBeLessThan(paths.indexOf('POST /api/admin/sessions'));   // pre-flight first
    const created = api.calls.find(call => call.path === '/api/admin/sessions');
    expect(created.body).toEqual({ title: 'Evening glass', date: '2026-09-17', location: 'Kodi Bengre', pricePaise: 70000, ...NO_CONDITIONS });   // W3-C: the six condition keys ride along, null when untouched
    expect(paths.filter(item => item === 'POST /api/admin/sessions/e2e-new-3/photos')).toHaveLength(2);
    expect(paths.at(-1)).toBe('POST /api/admin/sessions/e2e-new-3/publish');
    // Every upload is the streaming frame admin.js sends: [uint32 preview length][JPEG preview][original].
    expect(api.state.uploads.map(upload => upload.filename).sort()).toEqual(['SOI_0412.jpg', 'SOI_0413.webp']);
    for (const upload of api.state.uploads) {
      expect(upload.error).toBeUndefined();
      expect(upload.contentType).toBe('application/octet-stream');
      expect(upload.previewFormat).toBe(CHROMIUM_PREVIEW);   // W4-A: WebP where the browser encodes it (Chromium does), JPEG otherwise
      expect(upload.previewLength).toBeGreaterThan(5_000);
      expect(upload.previewLength).toBeLessThan(150_000);
      expect(upload.originalLength).toBeGreaterThan(10_000);
      expect(Number(upload.width)).toBeGreaterThan(0); expect(Number(upload.height)).toBeGreaterThan(0);
      expect(Math.max(Number(upload.width), Number(upload.height))).toBeLessThanOrEqual(600);   // preview long edge
      expect(upload.onDuplicate).toBeNull();
    }
    expect(api.state.uploads.map(upload => upload.type).sort()).toEqual(['image/jpeg', 'image/webp']);
    expect(api.state.thumbs).toHaveLength(2);
    expect(api.state.thumbs.every(thumb => thumb.format === CHROMIUM_PREVIEW && thumb.bytes > 1_000)).toBe(true);
    expect(api.state.dashboard[0]).toMatchObject({ id: 'e2e-new-3', title: 'Evening glass', status: 'published', total_photos: 2 });
    expect(pageErrors).toEqual([]);
  });

  test('a lost reply is retried as a duplicate "skip", so the photo is stored once and still counts as sent', async ({ page, api }) => {
    // FIX-C: the Worker stored the photo but the 201 never reached the browser (Wi-Fi handover). The automatic retry used
    // to resend plainly and the session kept two copies; now every attempt after the first says onDuplicate=skip and a
    // "skipped" answer to it is read as "landed earlier".
    await openStudio(page);
    const picks = await crewPicks();
    await queueFiles(page, [picks.jpeg, picks.webp]);
    await fillSessionForm(page);
    api.state.dropUploads = ['SOI_0413.webp'];
    await page.locator('#publishBtn').click();
    await expect(page.locator('#uploadStatus')).toHaveText('Live. Faces are indexing — watch it in Sessions.', { timeout: 30_000 });
    expect(await rowStates(page)).toEqual(['done', 'done']);
    await expect(page.locator('#fileQueue .file-queue-head strong')).toHaveText('2 of 2 photos published');
    await expect(page.locator('#fileQueue li.photo-row').nth(1).locator('.photo-row-tag')).not.toContainText('Already here');
    const webp = api.state.uploads.filter(upload => upload.filename === 'SOI_0413.webp');
    expect(webp.map(upload => upload.onDuplicate)).toEqual([null, 'skip']);   // plain first, skip on the retry
    expect(api.state.uploads.filter(upload => upload.filename === 'SOI_0412.jpg').map(upload => upload.onDuplicate)).toEqual([null]);
    expect(api.state.photos['e2e-new-3'].map(photo => photo.filename).sort()).toEqual(['SOI_0412.jpg', 'SOI_0413.webp']);   // once each
    expect(api.state.dashboard[0]).toMatchObject({ id: 'e2e-new-3', status: 'published', total_photos: 2 });
  });

  test('"Retry failed" resends as a duplicate "skip" too, and the draft publishes once everything is in', async ({ page, api }) => {
    await openStudio(page);
    const picks = await crewPicks();
    await queueFiles(page, [picks.jpeg, picks.webp]);
    await fillSessionForm(page);
    api.state.refuseUploads = ['SOI_0413.webp'];   // a 400 is not retried automatically: the crew gets the Retry button
    await page.locator('#publishBtn').click();
    await expect(page.locator('#uploadStatus')).toContainText('Live with 1 of 2. 1 failed — retry below.', { timeout: 30_000 });
    await expect(page.locator('#retryUploadBtn')).toHaveText('Retry failed (1)');
    expect(await rowStates(page)).toEqual(['done', 'failed']);
    await page.locator('#retryUploadBtn').click();
    await expect(page.locator('#uploadStatus')).toHaveText('All caught up — faces are indexing.', { timeout: 30_000 });
    expect(await rowStates(page)).toEqual(['done', 'done']);
    const webp = api.state.uploads.filter(upload => upload.filename === 'SOI_0413.webp');
    expect(webp.map(upload => upload.onDuplicate)).toEqual([null, 'skip']);
    expect(api.state.photos['e2e-new-3'].map(photo => photo.filename).sort()).toEqual(['SOI_0412.jpg', 'SOI_0413.webp']);
  });

  test('a heavy but small photo (500 px, 700 KB of noise PNG) is previewed at its own size, never upscaled to 600', async ({ page, api }) => {
    // FIX-C: the decode width used to be picked by file size (over 512 KB → resize to 600), so this file came back 600 × 600.
    const raw = Buffer.alloc(500 * 500 * 3); for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 2654435761 >>> 13) & 255;   // incompressible
    const buffer = await sharp(raw, { raw: { width: 500, height: 500, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    expect(buffer.length).toBeGreaterThan(512 * 1024);
    await openStudio(page);
    await queueFiles(page, [{ name: 'SOI_noise.png', mimeType: 'image/png', buffer }]);
    await expect(page.locator('#fileQueue li.photo-row')).toHaveCount(1);
    await settleImages(page, '#fileQueue img');
    const thumb = await page.locator('#fileQueue img').evaluate(img => ({ w: img.naturalWidth, h: img.naturalHeight }));
    expect(Math.max(thumb.w, thumb.h)).toBeLessThanOrEqual(96);   // the queue thumbnail is still the small decode
    await fillSessionForm(page);
    await page.locator('#publishBtn').click();
    await expect(page.locator('#uploadStatus')).toHaveText('Live. Faces are indexing — watch it in Sessions.', { timeout: 30_000 });
    const [upload] = api.state.uploads;
    expect([upload.width, upload.height]).toEqual(['500', '500']);   // the preview's pixel size rides along; it was 600 × 600 before
    expect(upload.previewFormat).toBe(CHROMIUM_PREVIEW);   // W4-A: WebP where the browser encodes it (Chromium does), JPEG otherwise
  });

  test('a pick with nothing usable keeps Publish disabled', async ({ page }) => {
    await openStudio(page);
    const picks = await crewPicks();
    await page.setInputFiles('#adminPhotoInput', [picks.text]);
    await expect(page.locator('#uploadStatus')).toHaveText('JPG, PNG, WebP or HEIC up to 25 MB each.');
    await expect(page.locator('#uploadStatus')).toHaveClass(/error/);
    await expect(page.locator('#fileQueue')).toBeHidden();
    await expect(page.locator('#publishBtn')).toBeDisabled();
  });

  test('same date and break as an existing session: the guard offers "Upload more to that session"', async ({ page, api }) => {
    await openStudio(page);
    const picks = await crewPicks();
    await queueFiles(page, [picks.jpeg, picks.webp]);
    await fillSessionForm(page, { title: 'Morning glass again', date: '2026-09-14', location: '  mulki beach ' });   // case and spacing must not matter
    await page.locator('#publishBtn').click();
    await expect(page.locator('#confirmDialog')).toHaveAttribute('open', '');
    await expect(page.locator('#confirmTitle')).toHaveText('Already got one.');
    await expect(page.locator('#confirmCopy')).toHaveText('A session at Mulki Beach on 14 Sept already exists — create another?');
    await expect(page.locator('#confirmOkBtn')).toHaveText('Create another');
    await expect(page.locator('#confirmAltBtn')).toHaveText('Upload more to that session');
    await page.locator('#confirmAltBtn').click();
    // The picked files move straight into the Add-photos flow for the existing session.
    await expect(page.locator('#uploadMoreModal')).toHaveAttribute('open', '');
    await expect(page.locator('#moreModalTitle')).toHaveText('Add photos — Morning glass');
    await expect(page.locator('#moreSummary')).toHaveText('2 photos. 1 already here, 1 new.');
    await expect(page.locator('#fileQueue')).toBeHidden();
    expect(api.calls.find(call => call.path === '/api/admin/sessions')).toBeUndefined();
  });

  test('an expired token mid-batch pauses for a sign-in and the batch carries on', async ({ page, api }) => {
    await openStudio(page);
    const picks = await crewPicks();
    await queueFiles(page, [picks.jpeg]);
    await fillSessionForm(page);
    api.state.token = 'fresh-token';   // the stored token is stale from here on; the next sign-in hands out this one
    await page.locator('#publishBtn').click();
    await expect(page.locator('#reauthPanel')).toBeVisible();
    await expect(page.locator('#uploadStatus')).toHaveText('Paused — your sign-in expired. Sign in again below and it carries on; nothing is lost.');
    await expect(page.locator('#uploadStatus')).toHaveAttribute('data-kind', 'warning');
    await expect(page.locator('#reauthPassword')).toBeFocused();
    await page.locator('#reauthPassword').fill('wrong');
    await page.locator('#reauthPanel button[type=submit]').click();
    await expect(page.locator('#reauthError')).toHaveText('Incorrect password.');
    await page.locator('#reauthPassword').fill(ADMIN_PASSWORD);
    await page.locator('#reauthPanel button[type=submit]').click();
    await expect(page.locator('#reauthPanel')).toBeHidden();
    await expect(page.locator('#uploadStatus')).toHaveText('Live. Faces are indexing — watch it in Sessions.', { timeout: 30_000 });
    expect(await page.evaluate(() => sessionStorage.getItem('mj-admin-token'))).toBe('fresh-token');
    expect(api.calls.filter(call => call.unauthorised).map(call => call.path)).toEqual(['/api/admin/dashboard']);
    expect(api.state.uploads).toHaveLength(1);
    expect(api.state.dashboard[0].status).toBe('published');
  });
  test('Cancel on the sign-in-again panel gives the batch up and unlocks the form (the pre-flight has no Stop button)', async ({ page, api }) => {
    // FIX-C: a 401 on the pre-flight / create call used to lock the whole form behind the panel with nothing but the password field.
    await openStudio(page);
    const picks = await crewPicks();
    await queueFiles(page, [picks.jpeg]);
    await fillSessionForm(page);
    api.state.token = 'fresh-token';
    await page.locator('#publishBtn').click();
    await expect(page.locator('#reauthPanel')).toBeVisible();
    await expect(page.locator('#adminTitle')).toBeDisabled();
    await expect(page.locator('#reauthCancelBtn')).toBeEnabled();
    await page.locator('#reauthCancelBtn').click();
    await expect(page.locator('#reauthPanel')).toBeHidden();
    await expect(page.locator('#uploadStatus')).toContainText('Stopped — you are signed out.');
    await expect(page.locator('#adminTitle')).toBeEnabled();
    await expect(page.locator('#publishBtn')).toBeEnabled();
    await expect(page.locator('#publishBtn')).toHaveText('Publish');
    expect(api.calls.filter(call => call.path === '/api/admin/sessions' && call.method === 'POST')).toEqual([]);   // nothing was created
    expect(await rowStates(page)).toEqual(['waiting']);
    // Mid-batch the same button stops the streams like Stop does: the sent photos stay, the rest can be sent later.
    api.state.token = ADMIN_TOKEN;
    await page.evaluate(() => sessionStorage.setItem('mj-admin-token', 'e2e-admin-token'));
    api.state.expireAfterCreate = 'fresh-token';
    await page.locator('#publishBtn').click();
    await expect(page.locator('#reauthPanel')).toBeVisible();
    await page.locator('#reauthCancelBtn').click();
    await expect(page.locator('#reauthPanel')).toBeHidden();
    await expect(page.locator('#uploadStatus')).toContainText('Stopped. 0 of 1 are in the draft');
    await expect(page.locator('#retryUploadBtn')).toHaveText('Send 1 remaining');
    await expect(page.locator('#retryUploadBtn')).toBeEnabled();
    await expect(page.locator('#adminTitle')).toBeEnabled();   // the form is unlocked; Publish stays off because the list is now the finished one
    expect(api.state.dashboard[0]).toMatchObject({ id: 'e2e-new-3', status: 'draft', total_photos: 0 });
  });

  test('a 401 to a stream sent before the crew signed in again is retried with the fresh token, not prompted for twice', async ({ page, api }) => {
    // FIX-C: with twelve streams in flight the first 401 pauses the batch; the others answer later with the same stale-token
    // 401 — after the sign-in, that used to raise the panel a second time.
    await openStudio(page);
    const picks = await crewPicks();
    await queueFiles(page, [picks.jpeg, picks.webp]);
    await fillSessionForm(page);
    api.state.expireAfterCreate = 'fresh-token';
    api.state.lateUnauthorised = { filename: 'SOI_0413.webp', ms: 2500 };   // this stream's 401 lands well after the sign-in below
    await page.locator('#publishBtn').click();
    await expect(page.locator('#reauthPanel')).toBeVisible();
    await page.locator('#reauthPassword').fill(ADMIN_PASSWORD);
    await page.locator('#reauthPanel button[type=submit]').click();
    await expect(page.locator('#reauthPanel')).toBeHidden();
    await expect(page.locator('#uploadStatus')).toHaveText('Live. Faces are indexing — watch it in Sessions.', { timeout: 30_000 });
    await expect(page.locator('#reauthPanel')).toBeHidden();
    expect(api.calls.filter(call => call.path === '/api/admin/login')).toHaveLength(1);   // one re-sign-in, no second (openStudio stores the token without a login call)
    expect(api.calls.filter(call => call.unauthorised).map(call => call.query.filename ?? call.body?.filename).sort()).toEqual(['SOI_0412.jpg', 'SOI_0413.webp']);   // W4-A: the stale 401 now lands on the presign probe, which is retried with the fresh token the same way
    expect(api.state.uploads.filter(upload => upload.filename === 'SOI_0413.webp')).toMatchObject([{ onDuplicate: 'skip' }]);   // the fresh-token resend (a second attempt, so a duplicate 'skip' — see the lost-reply test)
    expect(api.state.photos['e2e-new-3'].map(photo => photo.filename).sort()).toEqual(['SOI_0412.jpg', 'SOI_0413.webp']);
    expect(await rowStates(page)).toEqual(['done', 'done']);
  });

  test('a sign-in expiry while the crew is on another tab is announced with a way back to the panel', async ({ page, api }) => {
    await openStudio(page);
    const picks = await crewPicks();
    await queueFiles(page, [picks.jpeg]);
    await fillSessionForm(page);
    api.state.expireAfterCreate = 'fresh-token';
    await page.locator('#publishBtn').click();
    await page.locator('#nav-verify').click();   // wander off while the batch runs
    await expect(page.locator('#tab-verify')).toHaveClass(/active/);
    const notice = page.locator('.soi-toast', { hasText: 'Paused — sign in again on the Upload tab' });
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: 'Open the Upload tab' }).click();
    await expect(page.locator('#tab-upload')).toHaveClass(/active/);
    await expect(page.locator('#reauthPassword')).toBeFocused();
    await page.locator('#reauthPassword').fill(ADMIN_PASSWORD);
    await page.locator('#reauthPanel button[type=submit]').click();
    await expect(page.locator('#uploadStatus')).toHaveText('Live. Faces are indexing — watch it in Sessions.', { timeout: 30_000 });
  });
});

test.describe('sessions tab', () => {
  test('cards, badges, totals and the money strip from /api/admin/stats', async ({ page, api }) => {
    await openStudio(page);
    await openSessionsTab(page, 2);
    const first = page.locator('.d-card[data-session-id="e2e-sess-1"]'), second = page.locator('.d-card[data-session-id="e2e-sess-2"]');
    await expect(first.locator('.d-card-title')).toHaveText('Morning glass');
    await expect(first.locator('.d-card-status')).toHaveText('published');
    await expect(first.locator('.indexing-badge')).toHaveText('Indexed');
    await expect(second.locator('.d-card-status')).toHaveText('draft');
    await expect(second.locator('.indexing-badge')).toHaveText('3 failed');
    await expect(second.locator('.publish-session-btn')).toBeVisible();
    await expect(page.locator('#statSessions')).toHaveText('1');
    await expect(page.locator('#statPhotos')).toHaveText('170');
    await expect(page.locator('#statFailed')).toHaveText('3');
    await expect(first.locator('.d-card-money')).toHaveText('12 searches · 3 unlocks · ₹2,100');
    await expect(first.locator('.d-card-money')).not.toHaveClass(/is-muted/);
    await expect(second.locator('.d-card-money')).toHaveText('No searches yet');
    await expect(second.locator('.d-card-money')).toHaveClass(/is-muted/);
    expect(api.calls.filter(call => call.path === '/api/admin/stats')).toHaveLength(1);
  });

  test('the money strip stays hidden when the stats route is missing or unmigrated', async ({ page, api }) => {
    api.state.stats = null;   // 404: a Worker deployed without the route
    await openStudio(page);
    await openSessionsTab(page, 2);
    await expect(page.locator('.d-card[data-session-id="e2e-sess-1"]')).toBeVisible();
    await expect(page.locator('.d-card-money:visible')).toHaveCount(0);
    api.state.stats = { sessions: [], totals: {}, unmigrated: true };
    await page.locator('#refreshBtn').click();
    await expect(page.locator('.d-card[data-session-id="e2e-sess-1"] .d-card-title')).toHaveText('Morning glass');
    await expect(page.locator('.d-card-money:visible')).toHaveCount(0);
  });

  test('edit modal: Escape and × on a dirty form ask before discarding; Save sends the change', async ({ page, api }) => {
    await openStudio(page);
    await openSessionsTab(page, 2);
    await (await cardMenuItem(page, 'e2e-sess-1', '.edit-session-btn')).click();
    await expect(page.locator('#editSessionModal')).toHaveAttribute('open', '');
    await expect(page.locator('#editTitle')).toHaveValue('Morning glass');
    await expect(page.locator('#editTitle')).toBeFocused();
    await expect(page.locator('#editPrice')).toHaveValue('700');
    // Untouched: Escape just closes.
    await page.keyboard.press('Escape');
    await expect(page.locator('#editSessionModal')).not.toHaveAttribute('open', '');
    await (await cardMenuItem(page, 'e2e-sess-1', '.edit-session-btn')).click();
    await page.locator('#editTitle').fill('Morning glass · reshoot');
    await page.keyboard.press('Escape');
    await expect(page.locator('#confirmDialog')).toHaveAttribute('open', '');
    await expect(page.locator('#confirmTitle')).toHaveText('Discard changes?');
    await expect(page.locator('#confirmOkBtn')).toHaveText('Discard');
    await page.locator('#confirmCancelBtn').click();
    await expect(page.locator('#confirmDialog')).not.toHaveAttribute('open', '');
    await expect(page.locator('#editSessionModal')).toHaveAttribute('open', '');
    await expect(page.locator('#editTitle')).toHaveValue('Morning glass · reshoot');   // nothing lost
    await page.locator('#closeEditModal').click();
    await expect(page.locator('#confirmDialog')).toHaveAttribute('open', '');
    await page.locator('#confirmOkBtn').click();
    await expect(page.locator('#editSessionModal')).not.toHaveAttribute('open', '');
    expect(api.calls.filter(call => call.method === 'PUT')).toEqual([]);
    // Saving goes through PUT and re-renders the card.
    await (await cardMenuItem(page, 'e2e-sess-1', '.edit-session-btn')).click();
    await expect(page.locator('#editTitle')).toHaveValue('Morning glass');
    await page.locator('#editTitle').fill('Morning glass · reshoot');
    await page.locator('#editPrice').fill('900');
    await page.locator('#editSessionForm button[type=submit]').click();
    await expect(page.locator('#editSessionModal')).not.toHaveAttribute('open', '');
    await expect(page.locator('.d-card[data-session-id="e2e-sess-1"] .d-card-title')).toHaveText('Morning glass · reshoot');
    const put = api.calls.find(call => call.method === 'PUT');
    expect(put.path).toBe('/api/admin/sessions/e2e-sess-1');
    expect(put.body).toEqual({ title: 'Morning glass · reshoot', date: '2026-09-14', location: 'Mulki Beach', pricePaise: 90000, status: 'published', breakName: 'River mouth', swellFt: 3.5, wind: 'offshore', tide: 'rising', photographer: 'Ankith', nextDropAt: '2026-09-18T01:30:00.000Z' });   // the modal pre-fills the session's conditions and sends them back unchanged
  });

  test('delete asks for the session name typed exactly, then removes the card and moves focus on', async ({ page, api }) => {
    await openStudio(page);
    await openSessionsTab(page, 2);
    await (await cardMenuItem(page, 'e2e-sess-1', '.delete-btn')).click();
    await expect(page.locator('#confirmDialog')).toHaveAttribute('open', '');
    await expect(page.locator('#confirmTitle')).toHaveText('Delete “Morning glass”?');
    await expect(page.locator('#confirmCopy')).toHaveText('All 128 photos go — including originals people paid for. No undo.');
    await expect(page.locator('#confirmTypedLabel')).toHaveText('Type “Morning glass” to confirm');
    await expect(page.locator('#confirmTypedInput')).toBeFocused();
    await expect(page.locator('#confirmOkBtn')).toBeDisabled();
    await page.locator('#confirmTypedInput').fill('Morning');
    await expect(page.locator('#confirmOkBtn')).toBeDisabled();
    await page.locator('#confirmTypedInput').press('Enter');   // Enter on a stray keypress must not delete
    await expect(page.locator('#confirmDialog')).toHaveAttribute('open', '');
    expect(api.calls.filter(call => call.method === 'DELETE')).toEqual([]);
    await page.locator('#confirmTypedInput').fill('Morning glass');
    await expect(page.locator('#confirmOkBtn')).toBeEnabled();
    // Cancel keeps everything; a second pass with the exact name deletes.
    await page.locator('#confirmCancelBtn').click();
    await expect(page.locator('#confirmDialog')).not.toHaveAttribute('open', '');
    await expect(page.locator('#dashboardGrid .d-card')).toHaveCount(2);
    await (await cardMenuItem(page, 'e2e-sess-1', '.delete-btn')).click();
    await page.locator('#confirmTypedInput').fill(' Morning glass ');   // trimmed
    await page.locator('#confirmOkBtn').click();
    await expect(page.locator('#dashboardGrid .d-card')).toHaveCount(1);
    await expect(page.locator('#dashboardGrid .d-card').first()).toHaveAttribute('data-session-id', 'e2e-sess-2');
    await expect(page.locator('.d-card[data-session-id="e2e-sess-2"]')).toBeFocused();
    expect(api.calls.filter(call => call.method === 'DELETE').map(call => call.path)).toEqual(['/api/admin/sessions/e2e-sess-1']);
    await expect(page.locator('#statSessions')).toHaveText('0');
  });

  test('the silent refresh keeps running with a card focused — and keeps that focus — but waits while a More menu is open', async ({ page, api }) => {
    // FIX-C: the poll used to stand down while the grid was :hover / :focus-within, so after a delete (focus lands on the
    // next card) or a dialog (focus returns to a card button) the 8-second refresh never ran again while photos indexed.
    await openStudio(page);
    await openSessionsTab(page, 2);
    const dashboardCalls = () => api.calls.filter(call => call.path === '/api/admin/dashboard').length;
    const loads = dashboardCalls();
    api.state.dashboard[0].pending_photos = 5; api.state.dashboard[0].indexed_photos = 123;   // the next load sees indexing under way
    await page.locator('.d-card[data-session-id="e2e-sess-2"] .view-photos-btn').focus();
    await expect(page.locator('.d-card[data-session-id="e2e-sess-2"] .view-photos-btn')).toBeFocused();
    await page.evaluate(() => loadDashboard(true));                       // what the interval calls
    await expect.poll(dashboardCalls).toBe(loads + 1);                    // it ran, focus notwithstanding
    await expect(page.locator('.d-card[data-session-id="e2e-sess-1"] .indexing-badge')).toContainText('Indexing');   // and rendered the change
    await expect(page.locator('.d-card[data-session-id="e2e-sess-2"] .view-photos-btn')).toBeFocused();              // on the rebuilt card
    // The card itself focused (where a delete leaves the crew): same again.
    await page.locator('.d-card[data-session-id="e2e-sess-2"]').focus();
    await page.evaluate(() => loadDashboard(true));
    await expect.poll(dashboardCalls).toBe(loads + 2);
    await expect(page.locator('.d-card[data-session-id="e2e-sess-2"]')).toBeFocused();
    // A control that vanished with the change hands focus to its card instead of <body>.
    await page.locator('.d-card[data-session-id="e2e-sess-2"] .publish-session-btn').focus();
    api.state.dashboard[1].status = 'published';
    await page.evaluate(() => loadDashboard(true));
    await expect.poll(dashboardCalls).toBe(loads + 3);
    await expect(page.locator('.d-card[data-session-id="e2e-sess-2"] .publish-session-btn')).toHaveCount(0);
    await expect(page.locator('.d-card[data-session-id="e2e-sess-2"]')).toBeFocused();
    // An open More menu still blocks the silent refresh (a re-render would close it under the pointer).
    await page.locator('.d-card[data-session-id="e2e-sess-2"] .card-more summary').click();
    await expect(page.locator('.d-card[data-session-id="e2e-sess-2"] .card-more')).toHaveAttribute('open', '');
    await page.evaluate(() => loadDashboard(true));
    await page.waitForTimeout(300);
    expect(dashboardCalls()).toBe(loads + 3);
    await page.keyboard.press('Escape');
    await expect(page.locator('.d-card[data-session-id="e2e-sess-2"] .card-more')).not.toHaveAttribute('open', '');
    // The real interval: with photos indexing, the next tick arrives on its own while the card keeps the focus.
    await page.locator('.d-card[data-session-id="e2e-sess-2"]').focus();
    await expect.poll(dashboardCalls, { timeout: 15_000 }).toBeGreaterThan(loads + 3);
    await expect(page.locator('.d-card[data-session-id="e2e-sess-2"]')).toBeFocused();
  });

  test('upload more: files already in the session are flagged and the duplicate choice changes what is sent', async ({ page, api }) => {
    await openStudio(page);
    await openSessionsTab(page, 2);
    const picks = await crewPicks();
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.d-card[data-session-id="e2e-sess-1"] .upload-more-btn').click();
    await (await chooser).setFiles([picks.jpeg, picks.webp]);
    await expect(page.locator('#uploadMoreModal')).toHaveAttribute('open', '');
    await expect(page.locator('#moreModalTitle')).toHaveText('Add photos — Morning glass');
    await expect(page.locator('#moreSummary')).toHaveText('2 photos. 1 already here, 1 new.');
    await expect(page.locator('#morePhotosTitle')).toHaveText('Photos · 1 already here');
    const rows = page.locator('#morePhotoList li.photo-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator('.photo-row-tag')).toHaveText('Already here');
    await expect(rows.nth(1).locator('.photo-row-tag')).toHaveText('');
    await expect(page.locator('#moreChoice')).toBeVisible();
    await expect(page.locator('input[name=duplicateMode][value=skip]')).toBeChecked();
    await expect(page.locator('#moreConfirmBtn')).toHaveText('Upload 1');
    expect(await rows.nth(0).getAttribute('data-state')).toBe('skipped');   // the choice is previewed on the row
    await page.locator('input[name=duplicateMode][value=replace]').check();
    await expect(page.locator('#moreConfirmBtn')).toHaveText('Upload 2');
    expect(await rows.nth(0).getAttribute('data-state')).toBe('waiting');
    await page.locator('input[name=duplicateMode][value=rename]').check();
    await expect(page.locator('#moreConfirmBtn')).toHaveText('Upload 2');
    await page.locator('#moreConfirmBtn').click();
    await expect(page.locator('#moreStatus')).toHaveText('2 sent, indexing. 1 copy saved as SOI_0412-2.jpg.', { timeout: 30_000 });
    await expect(page.locator('#moreCancelBtn')).toHaveText('Done');
    await expect(rows.nth(0).locator('.photo-row-tag')).toHaveText('Saved as SOI_0412-2.jpg');
    expect(api.state.uploads.map(upload => [upload.filename, upload.onDuplicate]).sort()).toEqual([['SOI_0412.jpg', 'rename'], ['SOI_0413.webp', 'rename']]);   // streams run in parallel
    expect(api.state.photos['e2e-sess-1'].map(photo => photo.filename).sort()).toEqual(['SOI_0399.jpg', 'SOI_0412-2.jpg', 'SOI_0412.jpg', 'SOI_0413.webp']);
    await page.locator('#moreCancelBtn').click();
    await expect(page.locator('#uploadMoreModal')).not.toHaveAttribute('open', '');
  });

  test('upload more with "Skip" sends only the new file; "Replace" reports the replacement', async ({ page, api }) => {
    await openStudio(page);
    await openSessionsTab(page, 2);
    const picks = await crewPicks();
    let chooser = page.waitForEvent('filechooser');
    await page.locator('.d-card[data-session-id="e2e-sess-1"] .upload-more-btn').click();
    await (await chooser).setFiles([picks.jpeg, picks.webp]);
    await expect(page.locator('#moreConfirmBtn')).toHaveText('Upload 1');
    await page.locator('#moreConfirmBtn').click();
    await expect(page.locator('#moreStatus')).toHaveText('1 sent, indexing. 1 skipped.', { timeout: 30_000 });
    expect(api.state.uploads.map(upload => [upload.filename, upload.onDuplicate])).toEqual([['SOI_0413.webp', 'skip']]);
    await page.locator('#moreCancelBtn').click();

    chooser = page.waitForEvent('filechooser');
    await page.locator('.d-card[data-session-id="e2e-sess-1"] .upload-more-btn').click();
    await (await chooser).setFiles([picks.jpeg]);
    await expect(page.locator('#moreSummary')).toHaveText('1 photo. 1 already here, 0 new.');
    await expect(page.locator('#moreConfirmBtn')).toHaveText('Nothing to upload');
    await expect(page.locator('#moreConfirmBtn')).toBeDisabled();
    await page.locator('input[name=duplicateMode][value=replace]').check();
    await page.locator('#moreConfirmBtn').click();
    await expect(page.locator('#moreStatus')).toHaveText('1 sent, indexing. 1 replaced.', { timeout: 30_000 });
    expect(api.state.uploads.at(-1)).toMatchObject({ filename: 'SOI_0412.jpg', onDuplicate: 'replace' });
    expect(api.state.photos['e2e-sess-1'].filter(photo => photo.filename === 'SOI_0412.jpg')).toHaveLength(1);
  });

  test('a second sign-in-again inside the Add-photos dialog is still usable (the dialog lock skips the panel)', async ({ page, api }) => {
    // FIX-C: the panel stays inside the dialog after the first pause, and the next batch's lock used to disable its field and button.
    await openStudio(page);
    await openSessionsTab(page, 2);
    const picks = await crewPicks();
    const addPhotos = async file => { const chooser = page.waitForEvent('filechooser'); await page.locator('.d-card[data-session-id="e2e-sess-2"] .upload-more-btn').click(); await (await chooser).setFiles([file]); await expect(page.locator('#moreConfirmBtn')).toHaveText('Upload 1'); };
    const signInAgain = async () => { await expect(page.locator('#uploadMoreModal #reauthPanel')).toBeVisible(); await expect(page.locator('#reauthPassword')).toBeEnabled(); await expect(page.locator('#reauthPanel button[type=submit]')).toBeEnabled(); await page.locator('#reauthPassword').fill(ADMIN_PASSWORD); await page.locator('#reauthPanel button[type=submit]').click(); };
    await addPhotos(picks.jpeg);
    api.state.token = 'fresh-1';
    await page.locator('#moreConfirmBtn').click();
    await signInAgain();
    await expect(page.locator('#moreStatus')).toHaveText('1 sent, indexing.', { timeout: 30_000 });
    await page.locator('#moreCancelBtn').click();   // "Done"
    await addPhotos(picks.webp);
    api.state.token = 'fresh-2';
    await page.locator('#moreConfirmBtn').click();
    await signInAgain();
    await expect(page.locator('#moreStatus')).toHaveText('1 sent, indexing.', { timeout: 30_000 });
    expect(await page.evaluate(() => sessionStorage.getItem('mj-admin-token'))).toBe('fresh-2');
    expect(api.state.photos['e2e-sess-2'].map(photo => photo.filename)).toEqual(expect.arrayContaining(['SOI_0412.jpg', 'SOI_0413.webp']));
  });

  test('Add photos refuses a pick with an unsupported file before opening the dialog', async ({ page }) => {
    await openStudio(page);
    await openSessionsTab(page, 2);
    const picks = await crewPicks();
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.d-card[data-session-id="e2e-sess-1"] .upload-more-btn').click();
    await (await chooser).setFiles([picks.jpeg, picks.text]);
    await expect(page.locator('.soi-toast[data-kind="error"]')).toContainText('JPG, PNG, WebP or HEIC up to 25 MB each.');
    await expect(page.locator('#uploadMoreModal')).not.toHaveAttribute('open', '');
  });
});
