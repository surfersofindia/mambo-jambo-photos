// W4-A · direct-to-R2 uploads, the resume prompt and "Regenerate previews" in a real browser, against
// the mocked API and a mocked R2 bucket (tests/e2e/helpers/mock-api.mjs). Nothing leaves the machine:
// every /api call and every r2.cloudflarestorage.com PUT is intercepted, and the fixture fails the test
// if one escapes. The streaming route keeps its own coverage in crew.spec.mjs (presign answers 503 by
// default there, exactly as an undeployed Worker does).
import { fileURLToPath } from 'node:url';
import { test, expect } from './helpers/fixtures.mjs';
import { crewPicks, openSessionsTab, openStudio, queueFiles, settleImages } from './helpers/flows.mjs';

// Two real photos straight off disk. A resume matches a re-picked file by name + size + last-modified,
// and only a real file has a last-modified that survives being picked twice (a buffer gets "now"), so
// the resume tests pick these paths rather than the in-memory fixtures the upload tests use.
const ASSETS = new URL('../../assets/', import.meta.url);
const onDisk = name => fileURLToPath(new URL(name, ASSETS));
const DISK_PICKS = [onDisk('mambo-jambo-surf-session.jpg'), onDisk('backpackers-05.webp')];
const DISK_NAMES = ['mambo-jambo-surf-session.jpg', 'backpackers-05.webp'];

const fillSessionForm = async (page, { title = 'Evening glass', date = '2026-09-17', location = 'Kodi Bengre', price = '700' } = {}) => {
  await page.locator('#adminTitle').fill(title);
  await page.locator('#adminDate').fill(date);
  await page.locator('#adminLocation').fill(location);
  await page.locator('#adminPrice').fill(price);
};
const rowStates = page => page.locator('#fileQueue li.photo-row').evaluateAll(rows => rows.map(row => row.dataset.state));
const publishTwo = async (page) => {
  const picks = await crewPicks();
  await queueFiles(page, [picks.jpeg, picks.webp]);
  await settleImages(page, '#fileQueue img');
  await fillSessionForm(page);
  await page.locator('#publishBtn').click();
};

test.describe('direct-to-R2 uploads', () => {
  test('originals go straight to the bucket and only the preview and thumb reach the Worker', async ({ page, api, pageErrors }) => {
    api.state.direct = true;
    await openStudio(page);
    await publishTwo(page);
    await expect(page.locator('#uploadStatus')).toHaveText('Live. Faces are indexing — watch it in Sessions.', { timeout: 30_000 });
    expect(await rowStates(page)).toEqual(['done', 'done']);

    // One presign per photo, one PUT to the bucket, one complete — and no streaming upload at all.
    const presigns = api.calls.filter(call => call.path.endsWith('/uploads/presign'));
    expect(presigns).toHaveLength(2);
    expect(presigns.map(call => call.body.contentType).sort()).toEqual(['image/jpeg', 'image/webp']);
    expect(presigns.every(call => call.body.size > 10_000)).toBe(true);
    expect(api.state.r2.puts).toHaveLength(2);
    for (const put of api.state.r2.puts) {
      expect(put.method).toBe('PUT');
      expect(put.key).toMatch(/^sessions\/e2e-new-3\/original\/e2e-direct-\d+-SOI_04\d\d\.(jpg|webp)$/);
      expect(put.authorization, 'the crew token never goes to the bucket').toBeNull();
      expect(put.signed).toBeTruthy();
      expect(['image/jpeg', 'image/webp']).toContain(put.contentType);
      expect(put.bytes).toBeGreaterThan(10_000);   // the whole original, not the preview
    }
    const completed = api.state.uploads;
    expect(completed.every(upload => upload.direct)).toBe(true);
    expect(completed.map(upload => upload.filename).sort()).toEqual(['SOI_0412.jpg', 'SOI_0413.webp']);
    for (const upload of completed) {
      expect(upload.previewFormat).toBe('webp');            // Chromium encodes WebP; a browser that cannot gets JPEG
      expect(upload.previewLength).toBeGreaterThan(2_000);
      expect(upload.thumbLength).toBeGreaterThan(1_000);    // the grid thumb rides along, so there is no second POST
      expect(Math.max(Number(upload.width), Number(upload.height))).toBeLessThanOrEqual(600);
      expect(upload.onDuplicate).toBeNull();
      expect(api.state.r2.objects.has(upload.key)).toBe(true);
    }
    expect(api.state.thumbs, 'the thumb came with `complete`').toHaveLength(0);
    expect(api.calls.some(call => call.path.endsWith('/photos') && call.method === 'POST')).toBe(false);
    expect(api.state.photos['e2e-new-3'].map(photo => photo.filename).sort()).toEqual(['SOI_0412.jpg', 'SOI_0413.webp']);
    expect(pageErrors).toEqual([]);
  });

  test('a bucket that refuses one file sends that one through the Worker instead, and the batch still publishes', async ({ page, api }) => {
    api.state.direct = true;
    api.state.r2.fail = 'SOI_0413.webp';   // one 500 from the bucket, once
    await openStudio(page);
    await publishTwo(page);
    await expect(page.locator('#uploadStatus')).toHaveText('Live. Faces are indexing — watch it in Sessions.', { timeout: 30_000 });
    expect(await rowStates(page)).toEqual(['done', 'done']);
    const byRoute = Object.fromEntries(api.state.uploads.map(upload => [upload.filename, upload.route]));
    expect(byRoute).toEqual({ 'SOI_0412.jpg': 'complete', 'SOI_0413.webp': 'stream' });
    expect(api.state.photos['e2e-new-3'].map(photo => photo.filename).sort()).toEqual(['SOI_0412.jpg', 'SOI_0413.webp']);
    expect(api.state.thumbs.map(thumb => thumb.format)).toEqual(['webp']);   // only the streamed one needs its own thumb POST
  });

  test('a Worker without the R2 secrets answers 503 once and the whole batch streams, exactly as today', async ({ page, api }) => {
    await openStudio(page);   // state.direct is false by default: presign → 503 { fallback: 'stream' }
    await publishTwo(page);
    await expect(page.locator('#uploadStatus')).toHaveText('Live. Faces are indexing — watch it in Sessions.', { timeout: 30_000 });
    expect(api.calls.filter(call => call.path.endsWith('/uploads/presign'))).toHaveLength(1);   // asked once for the batch, never again
    expect(api.state.uploads.every(upload => upload.route === 'stream')).toBe(true);
    expect(api.state.r2.puts).toHaveLength(0);
  });

  test('a retried direct upload is idempotent: a lost reply stores the photo once and its orphan object is dropped', async ({ page, api }) => {
    api.state.direct = true;
    api.state.dropCompletes = ['SOI_0413.webp'];   // registered by the Worker; the studio never hears the 201
    await openStudio(page);
    await publishTwo(page);
    await expect(page.locator('#uploadStatus')).toHaveText('Live. Faces are indexing — watch it in Sessions.', { timeout: 30_000 });
    expect(await rowStates(page)).toEqual(['done', 'done']);
    // The second attempt presigns a fresh key, PUTs again and completes with onDuplicate=skip: the
    // Worker answers `skipped`, the studio counts the photo as sent, and the orphan object is removed.
    const webpCompletes = api.state.uploads.filter(upload => upload.filename === 'SOI_0413.webp');
    expect(webpCompletes).toHaveLength(2);
    expect(webpCompletes.map(upload => upload.onDuplicate)).toEqual([null, 'skip']);
    expect(webpCompletes[0].key).not.toBe(webpCompletes[1].key);
    expect(api.state.photos['e2e-new-3'].filter(photo => photo.filename === 'SOI_0413.webp')).toHaveLength(1);
    expect(api.state.r2.puts).toHaveLength(3);                                   // three PUTs…
    expect(api.state.r2.objects.size, 'the orphan original is gone again').toBe(2);   // …two objects kept
    expect(api.state.r2.objects.has(webpCompletes[1].key)).toBe(false);
  });
});

// Chromium has the File System Access API, whose native picker no browser automation can answer, so
// the fallback tests below take it away first — exactly what Safari, Firefox and every phone look like.
const withoutFilePicker = page => page.addInitScript(() => { try { delete window.showOpenFilePicker; } catch { /* non-configurable */ } });

test.describe('resumable batches', () => {
  test('an interrupted batch is offered again after a reload and only the missing photos are sent', async ({ page, api }) => {
    await withoutFilePicker(page);
    await openStudio(page);
    await queueFiles(page, DISK_PICKS);
    await settleImages(page, '#fileQueue img');
    await fillSessionForm(page);
    api.state.refuseUploads = new Array(6).fill(DISK_NAMES[1]);   // this one never lands
    await page.locator('#publishBtn').click();
    await expect(page.locator('#retryUploadBtn')).toBeVisible({ timeout: 30_000 });
    expect(await rowStates(page)).toEqual(['done', 'failed']);

    // Reload: the manifest in IndexedDB offers the batch again, naming the session and the count.
    await page.reload();
    await expect(page.locator('#resumePanel')).toBeVisible();
    await expect(page.locator('#resumeCopy')).toHaveText(/“Evening glass” — 1 of 2 photos uploaded/);
    await expect(page.locator('#resumeCopy')).toContainText('nothing is published until you say so');

    // Re-picking the whole folder sends only the photo that never landed. This browser has no File
    // System Access API (Safari, Firefox, phones), so the plain file input is used.
    api.state.refuseUploads = [];
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#resumePickBtn').click()]);
    await chooser.setFiles(DISK_PICKS);
    await expect(page.locator('#uploadMoreModal')).toBeVisible();
    await expect(page.locator('#moreModalTitle')).toHaveText('Add photos — Evening glass');
    await expect(page.locator('#morePhotoList li.photo-row')).toHaveCount(1);
    await expect(page.locator('#morePhotoList .photo-row-name')).toContainText(DISK_NAMES[1]);
    await page.locator('#moreConfirmBtn').click();
    await expect(page.locator('#moreStatus')).toContainText('1 sent', { timeout: 30_000 });
    expect(api.state.photos['e2e-new-3'].map(photo => photo.filename).sort()).toEqual([...DISK_NAMES].sort());
    // Publishing stays manual: the session created by the interrupted batch was never published by the resume.
    expect(api.calls.filter(call => call.path.endsWith('/publish'))).toHaveLength(1);   // the one the original batch tried
    // Everything is in, so the offer does not come back.
    await page.reload();
    await expect(page.locator('#resumePanel')).toBeHidden();
  });

  test('Discard forgets the batch, and a finished batch is never offered', async ({ page, api }) => {
    await withoutFilePicker(page);
    await openStudio(page);
    const picks = await crewPicks();
    await queueFiles(page, [picks.jpeg, picks.webp]);
    await settleImages(page, '#fileQueue img');
    await fillSessionForm(page);
    await page.locator('#publishBtn').click();
    await expect(page.locator('#uploadStatus')).toHaveText('Live. Faces are indexing — watch it in Sessions.', { timeout: 30_000 });
    await page.reload();
    await expect(page.locator('#resumePanel'), 'a batch that finished leaves nothing to resume').toBeHidden();

    // A batch that stopped half-way, then discarded.
    api.state.refuseUploads = new Array(6).fill('SOI_0413.webp');
    await queueFiles(page, [picks.jpeg, picks.webp]);   // buffers are fine here: this batch is discarded, never re-picked
    await settleImages(page, '#fileQueue img');
    await fillSessionForm(page, { title: 'Second try', location: 'Sasihithlu' });
    await page.locator('#publishBtn').click();
    await expect(page.locator('#retryUploadBtn')).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await expect(page.locator('#resumePanel')).toBeVisible();
    await page.locator('#resumeDiscardBtn').click();
    await expect(page.locator('#resumePanel')).toBeHidden();
    await expect(page.locator('.soi-toast')).toContainText('The photos already uploaded are still in that session');
    await page.reload();
    await expect(page.locator('#resumePanel')).toBeHidden();
  });

  test('where the File System Access API exists, the picker is used instead of the file input', async ({ page, api }) => {
    // A stub stands in for the native picker (Playwright cannot answer the real one): it hands back
    // handles for the same two photos, fetched from the site's own assets, and records the `id` the
    // studio passes — that is what makes Chrome reopen the folder the crew used last time.
    await page.addInitScript(names => {
      window.__pickerCalls = [];
      window.showOpenFilePicker = async options => {
        window.__pickerCalls.push(options);
        const take = async name => { const blob = await (await fetch(`/assets/${name}`)).blob(); return { getFile: async () => new File([blob], name, { type: blob.type, lastModified: window.__pickedAt?.[name] ?? 0 }) }; };
        return Promise.all(names.map(take));
      };
    }, DISK_NAMES);
    await openStudio(page);
    await queueFiles(page, DISK_PICKS);
    await settleImages(page, '#fileQueue img');
    await fillSessionForm(page);
    // The picker stub has to hand back files that look like the ones on disk, so it reuses their
    // last-modified stamps — which is exactly what a real re-pick of the same folder does.
    const stamps = await page.locator('#adminPhotoInput').evaluate(input => Object.fromEntries([...input.files].map(file => [file.name, file.lastModified])));
    api.state.refuseUploads = new Array(6).fill(DISK_NAMES[1]);
    await page.locator('#publishBtn').click();
    await expect(page.locator('#retryUploadBtn')).toBeVisible({ timeout: 30_000 });
    api.state.refuseUploads = [];
    await page.addInitScript(stamped => { window.__pickedAt = stamped; }, stamps);
    await page.reload();
    await expect(page.locator('#resumePanel')).toBeVisible();
    await page.locator('#resumePickBtn').click();
    await expect(page.locator('#uploadMoreModal')).toBeVisible();
    await expect(page.locator('#morePhotoList li.photo-row')).toHaveCount(1);
    await expect(page.locator('#morePhotoList .photo-row-name')).toContainText(DISK_NAMES[1]);
    expect(await page.evaluate(() => window.__pickerCalls)).toMatchObject([{ id: 'soi-session-photos', multiple: true }]);
  });
});

test.describe('regenerate previews', () => {
  test('the More menu rebuilds every preview and thumb from the originals, without re-uploading one', async ({ page, api, pageErrors }) => {
    await openStudio(page);
    await openSessionsTab(page, 2);
    const card = page.locator('.d-card[data-session-id="e2e-sess-1"]');
    await card.locator('.card-more summary').click();
    await card.locator('.regen-previews-btn').click();
    await expect(page.locator('#confirmDialog')).toBeVisible();
    await expect(page.locator('#confirmCopy')).toContainText('Originals are never touched');
    await page.locator('#confirmOkBtn').click();
    await expect(page.locator('.soi-toast')).toContainText('2 previews rebuilt', { timeout: 60_000 });
    // Two photos in that session: each original fetched once, each preview PUT, each thumb POSTed.
    expect(api.state.previews.map(preview => preview.photoId).sort()).toEqual(['e2e-old-1', 'e2e-old-2']);
    for (const preview of api.state.previews) {
      expect(preview.format).toBe('webp');
      expect(preview.bytes).toBeGreaterThan(2_000);
      expect(Math.max(Number(preview.width), Number(preview.height))).toBeLessThanOrEqual(600);
    }
    expect(api.state.thumbs.map(thumb => thumb.photoId).sort()).toEqual(['e2e-old-1', 'e2e-old-2']);
    expect(api.state.uploads, 'no original is ever uploaded again').toHaveLength(0);
    expect(api.state.r2.puts).toHaveLength(0);
    // Each original was fetched exactly once, through its signed crew link (variant=original), never as a download.
    const originals = api.state.media.filter(hit => hit.variant === 'original');
    expect(originals.map(hit => hit.id).sort()).toEqual(['e2e-old-1', 'e2e-old-2']);
    expect(originals.every(hit => !hit.download)).toBe(true);
    await expect(page.locator('#regenPanel')).toBeHidden();
    expect(pageErrors).toEqual([]);
  });
});
