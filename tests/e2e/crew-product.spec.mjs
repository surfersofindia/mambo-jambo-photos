// W3-C · crew studio product features against the mocked API (no crew credentials exist here; nothing reaches the
// production Worker): bulk select in the photo grid (new Worker and the per-photo fallback), the cover-picker step
// before publish, session conditions with EXIF pre-fill, indexing observability on the cards, the review meter with
// whole-frame canvases, and the Money and Support tabs (resend, free unlock, refund, settlements). Every new screen
// also gets an axe pass (WCAG 2.0 A + AA, zero violations). Runs on mobile-375 and desktop-1024.
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './helpers/fixtures.mjs';
import { asset, reviewLink, reviewPair } from './helpers/mock-api.mjs';
import { cardMenuItem, crewPicks, openSessionsTab, openStudio, settleImages } from './helpers/flows.mjs';

const expectClean = async page => {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations.flatMap(v => v.nodes.map(n => `${v.id} (${v.impact}) ${n.target.join(' ')}`))).toEqual([]);
};
// The same APP1/EXIF builder the unit test uses: a real JPEG with Model in IFD0 and DateTimeOriginal in the Exif IFD.
function withExif(jpeg, { model = 'Canon EOS R6', dateTimeOriginal = '2026:09:17 06:41:12', littleEndian = false } = {}) {
  const u16 = (b, o, v) => littleEndian ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o);
  const u32 = (b, o, v) => littleEndian ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o);
  const modelBuf = Buffer.from(`${model}\0`, 'latin1'), dtoBuf = Buffer.from(`${dateTimeOriginal}\0`, 'latin1');
  const ifd0Offset = 8, exifOffset = ifd0Offset + 2 + 2 * 12 + 4, blobStart = exifOffset + 2 + 1 * 12 + 4;
  const entry = (tag, type, count, value) => { const e = Buffer.alloc(12); u16(e, 0, tag); u16(e, 2, type); u32(e, 4, count); u32(e, 8, value); return e; };
  const ifd0 = Buffer.concat([Buffer.alloc(2), entry(0x0110, 2, modelBuf.length, blobStart), entry(0x8769, 4, 1, exifOffset), Buffer.alloc(4)]); u16(ifd0, 0, 2);
  const exifIfd = Buffer.concat([Buffer.alloc(2), entry(0x9003, 2, dtoBuf.length, blobStart + modelBuf.length), Buffer.alloc(4)]); u16(exifIfd, 0, 1);
  const header = Buffer.alloc(8); header.write(littleEndian ? 'II' : 'MM', 0, 'latin1'); u16(header, 2, 42); u32(header, 4, ifd0Offset);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), header, ifd0, exifIfd, modelBuf, dtoBuf]);
  const seg = Buffer.alloc(4); seg[0] = 0xFF; seg[1] = 0xE1; seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), seg, payload, jpeg.subarray(2)]);
}
async function exifPicks() {
  const jpeg = await asset('mambo-jambo-surf-session.jpg');
  return [['SOI_0410.jpg', '2026:09:17 06:41:12', false], ['SOI_0411.jpg', '2026:09:17 07:22:41', true], ['SOI_0412.jpg', '2026:09:17 08:05:19', false]].map(([name, dateTimeOriginal, littleEndian]) => ({ name, mimeType: 'image/jpeg', buffer: withExif(jpeg, { dateTimeOriginal, littleEndian }) }));
}
async function openGallery(page, sessionId = 'e2e-sess-2', count = 3) {
  await openStudio(page);
  await openSessionsTab(page, 2);
  await page.locator(`.d-card[data-session-id="${sessionId}"] .view-photos-btn`).click();
  await expect(page.locator('#photoGalleryModal')).toHaveAttribute('open', '');
  await expect(page.locator('#galleryGrid .photo-card')).toHaveCount(count);
  await settleImages(page, '#galleryGrid img');
}
const selected = page => page.locator('#galleryGrid .photo-card.is-selected').evaluateAll(cards => cards.map(card => card.dataset.photoId));

test.describe('photo grid: bulk select', () => {
  test('checkboxes, Select all / Clear, the action bar with a count, uncropped tiles from stored dimensions', async ({ page, api }) => {
    await openGallery(page);
    await expect(page.locator('#gallerySummary')).toHaveText('3 photos');
    await expect(page.locator('#bulkBar')).toBeHidden();
    // Tiles keep the stored aspect ratio; the one without dimensions falls back to 4:3.
    const aspects = await page.locator('#galleryGrid .photo-card img').evaluateAll(imgs => imgs.map(img => getComputedStyle(img).aspectRatio.replace(/\s/g, '')));
    expect(aspects).toEqual(['4/3', '1600/1067', '1600/1067']);
    const boxes = page.locator('#galleryGrid .photo-select input');
    await expect(boxes).toHaveCount(3);
    for (const box of await page.locator('#galleryGrid .photo-select').all()) { const size = await box.boundingBox(); expect(size.width).toBeGreaterThanOrEqual(44); expect(size.height).toBeGreaterThanOrEqual(44); }
    await boxes.nth(0).check();
    await boxes.nth(2).check();
    await expect(page.locator('#bulkBar')).toBeVisible();
    await expect(page.locator('#bulkCount')).toHaveText('2 selected');
    await expect(page.locator('#gallerySummary')).toHaveText('2 of 3 selected');
    expect(await selected(page)).toEqual(['e2e-old-3', 'e2e-old-5']);
    await expect(page.locator('#galleryGrid .photo-delete-btn:visible')).toHaveCount(0);   // the bar owns Delete while a selection exists
    await page.locator('#selectAllPhotos').click();
    await expect(page.locator('#bulkCount')).toHaveText('3 selected');
    await expect(page.locator('#selectAllPhotos')).toBeHidden();
    await page.locator('#clearPhotoSelection').click();
    await expect(page.locator('#bulkBar')).toBeHidden();
    expect(await selected(page)).toEqual([]);
    for (const button of await page.locator('#bulkBar button').all()) expect((await button.boundingBox())?.height ?? 44).toBeGreaterThanOrEqual(44);
    expect(api.calls.filter(call => call.path === '/api/admin/photos/bulk')).toEqual([]);
  });

  test('Re-index confirms and posts one bulk call; Delete needs DELETE typed and removes the tiles; the dashboard count follows', async ({ page, api }) => {
    await openGallery(page);
    const boxes = page.locator('#galleryGrid .photo-select input');
    await boxes.nth(0).check(); await boxes.nth(1).check();
    await page.locator('#bulkBar [data-bulk="reindex"]').click();
    await expect(page.locator('#confirmDialog')).toHaveAttribute('open', '');
    await expect(page.locator('#confirmTitle')).toHaveText('Re-index 2 photos?');
    await page.locator('#confirmOkBtn').click();
    await expect(page.locator('.soi-toast[data-kind="success"]')).toContainText('2 photos queued again.');
    expect(api.calls.filter(call => call.path === '/api/admin/photos/bulk').map(call => call.body)).toEqual([{ action: 'reindex', photoIds: ['e2e-old-3', 'e2e-old-4'] }]);
    await expect(page.locator('#galleryGrid .photo-card').nth(0).locator('.photo-badge')).toHaveText('pending');
    await expect(page.locator('#bulkBar')).toBeHidden();   // done: the selection clears
    // Delete: typed confirm, then the tiles go and the card's photo count drops.
    await boxes.nth(0).check(); await boxes.nth(2).check();
    await page.locator('#bulkBar [data-bulk="delete"]').click();
    await expect(page.locator('#confirmTitle')).toHaveText('Delete 2 photos?');
    await expect(page.locator('#confirmTypedLabel')).toHaveText('Type “DELETE” to confirm');
    await expect(page.locator('#confirmOkBtn')).toBeDisabled();
    await page.locator('#confirmTypedInput').fill('delete');
    await expect(page.locator('#confirmOkBtn')).toBeDisabled();
    await page.locator('#confirmTypedInput').fill('DELETE');
    await page.locator('#confirmOkBtn').click();
    await expect(page.locator('#galleryGrid .photo-card')).toHaveCount(1);
    await expect(page.locator('.soi-toast[data-kind="success"]').last()).toContainText('2 photos deleted.');
    expect(api.state.photos['e2e-sess-2'].map(photo => photo.id)).toEqual(['e2e-old-4']);
    expect(api.calls.filter(call => call.method === 'DELETE')).toEqual([]);   // the bulk route did it, not the per-photo one
    await page.locator('#closeGalleryModal').click();
    await expect(page.locator('.d-card[data-session-id="e2e-sess-2"] .view-photos-btn')).toHaveText('Photos (40)');
  });

  test('Move to… offers the other sessions and posts targetSessionId; Set cover with one photo uses the existing PUT', async ({ page, api }) => {
    await openGallery(page);
    const boxes = page.locator('#galleryGrid .photo-select input');
    await boxes.nth(1).check();
    await page.locator('#bulkBar [data-bulk="cover"]').click();
    await expect(page.locator('.soi-toast[data-kind="success"]')).toContainText('1 photo set as cover.');
    await expect(page.locator('#galleryGrid .photo-card').nth(1)).toHaveClass(/is-cover/);
    expect(api.calls.filter(call => call.path === '/api/admin/photos/bulk').map(call => call.body)).toEqual([{ action: 'cover', photoIds: ['e2e-old-4'] }]);
    await boxes.nth(1).check(); await boxes.nth(2).check();
    await page.locator('#bulkBar [data-bulk="move"]').click();
    await expect(page.locator('#confirmDialog')).toHaveAttribute('open', '');
    await expect(page.locator('#confirmChoiceWrap')).toBeVisible();
    await expect(page.locator('#confirmChoice option')).toHaveCount(1);
    await expect(page.locator('#confirmChoice option')).toContainText('Morning glass');
    await page.locator('#confirmOkBtn').click();
    await expect(page.locator('#galleryGrid .photo-card')).toHaveCount(1);
    await expect(page.locator('.soi-toast[data-kind="success"]').last()).toContainText('2 photos moved. Now in “Morning glass”.');
    expect(api.calls.filter(call => call.path === '/api/admin/photos/bulk').at(-1).body).toEqual({ action: 'move', photoIds: ['e2e-old-4', 'e2e-old-5'], targetSessionId: 'e2e-sess-1' });
    expect(api.state.photos['e2e-sess-1'].map(photo => photo.id)).toEqual(['e2e-old-1', 'e2e-old-2', 'e2e-old-4', 'e2e-old-5']);
  });

  test('on a Worker without the bulk route: delete loops the per-photo route, a failure stays selected, and Move says it needs the new Worker', async ({ page, api }) => {
    api.state.bulkRoute = false;
    await openGallery(page);
    const boxes = page.locator('#galleryGrid .photo-select input');
    await boxes.nth(0).check(); await boxes.nth(1).check();
    await page.locator('#bulkBar [data-bulk="move"]').click();
    await page.locator('#confirmOkBtn').click();
    await expect(page.locator('.soi-toast[data-kind="error"]')).toContainText('Moving photos needs the new Worker deploy');
    await expect(page.locator('#galleryGrid .photo-card')).toHaveCount(3);
    await page.locator('#bulkBar [data-bulk="delete"]').click();
    await page.locator('#confirmTypedInput').fill('DELETE');
    await page.locator('#confirmOkBtn').click();
    await expect(page.locator('#galleryGrid .photo-card')).toHaveCount(1);
    expect(api.calls.filter(call => call.method === 'DELETE').map(call => call.path)).toEqual(['/api/admin/photos/e2e-old-3', '/api/admin/photos/e2e-old-4']);
    expect(api.calls.filter(call => call.path === '/api/admin/photos/bulk')).toHaveLength(1);   // probed once, then remembered
  });
});

test.describe('cover-picker step before publish', () => {
  test('the new Worker answers 409 needsCover: pick a tile → PUT cover → publish; the card goes live', async ({ page, api }) => {
    api.state.needsCover = true;
    await openStudio(page);
    await openSessionsTab(page, 2);
    await page.locator('.d-card[data-session-id="e2e-sess-2"] .publish-session-btn').click();
    await expect(page.locator('#photoGalleryModal')).toHaveAttribute('open', '');
    await expect(page.locator('#photoGalleryModal')).toHaveAttribute('data-mode', 'cover');
    await expect(page.locator('#galleryModalTitle')).toHaveText('Pick a cover — Sunset session');
    await expect(page.locator('#coverPickerBar')).toBeVisible();
    await expect(page.locator('#bulkBar')).toBeHidden();
    await expect(page.locator('#publishWithCoverBtn')).toBeDisabled();
    await expect(page.locator('#galleryGrid .photo-pick')).toHaveCount(3);
    await page.locator('#galleryGrid .photo-pick').nth(1).click();
    await expect(page.locator('#galleryGrid .photo-card').nth(1)).toHaveClass(/is-cover/);
    await expect(page.locator('#publishWithCoverBtn')).toBeEnabled();
    await page.locator('#publishWithCoverBtn').click();
    await expect(page.locator('#photoGalleryModal')).not.toHaveAttribute('open', '');
    await expect(page.locator('.soi-toast[data-kind="success"]')).toContainText('“Sunset session” is live.');
    await expect(page.locator('.d-card[data-session-id="e2e-sess-2"] .d-card-status')).toHaveText('published');
    const publishes = api.calls.filter(call => call.path === '/api/admin/sessions/e2e-sess-2/publish');
    expect(publishes.map(call => call.body)).toEqual([null, null]);
    expect(api.calls.find(call => call.method === 'PUT' && call.path === '/api/admin/sessions/e2e-sess-2').body).toEqual({ coverPhotoId: 'e2e-old-4' });
    expect(api.state.covers['e2e-sess-2']).toBe('e2e-old-4');
  });

  test('"Publish without a cover" sends noCover:true; closing the picker keeps the draft; an older Worker never shows it', async ({ page, api }) => {
    api.state.needsCover = true;
    await openStudio(page);
    await openSessionsTab(page, 2);
    await page.locator('.d-card[data-session-id="e2e-sess-2"] .publish-session-btn').click();
    await expect(page.locator('#photoGalleryModal')).toHaveAttribute('data-mode', 'cover');
    await page.locator('#closeGalleryModal').click();
    await expect(page.locator('#photoGalleryModal')).not.toHaveAttribute('open', '');
    await expect(page.locator('.d-card[data-session-id="e2e-sess-2"] .publish-session-btn')).toBeEnabled();
    await expect(page.locator('.d-card[data-session-id="e2e-sess-2"] .d-card-status')).toHaveText('draft');
    await page.locator('.d-card[data-session-id="e2e-sess-2"] .publish-session-btn').click();
    await page.locator('#publishNoCoverBtn').click();
    await expect(page.locator('.d-card[data-session-id="e2e-sess-2"] .d-card-status')).toHaveText('published');
    expect(api.calls.filter(call => call.path === '/api/admin/sessions/e2e-sess-2/publish').map(call => call.body)).toEqual([null, null, { noCover: true }]);
    expect(api.calls.filter(call => call.method === 'PUT')).toEqual([]);
  });

  test('the upload flow: a 409 after the photos land opens the picker over the draft; publishing with a cover finishes the batch', async ({ page, api }) => {
    api.state.needsCover = true;
    await openStudio(page);
    const picks = await crewPicks();
    await page.setInputFiles('#adminPhotoInput', [picks.jpeg]);
    await expect(page.locator('#fileQueue')).toBeVisible();
    await page.locator('#adminTitle').fill('Evening glass'); await page.locator('#adminDate').fill('2026-09-17'); await page.locator('#adminLocation').fill('Kodi Bengre');
    await page.locator('#publishBtn').click();
    await expect(page.locator('#photoGalleryModal')).toHaveAttribute('data-mode', 'cover', { timeout: 30_000 });
    await expect(page.locator('#galleryGrid .photo-pick')).toHaveCount(1);
    await page.locator('#galleryGrid .photo-pick').first().click();
    await page.locator('#publishWithCoverBtn').click();
    await expect(page.locator('#uploadStatus')).toHaveText('Live. Faces are indexing — watch it in Sessions.', { timeout: 30_000 });
    expect(api.state.dashboard[0]).toMatchObject({ title: 'Evening glass', status: 'published' });
    expect(api.state.covers[api.state.dashboard[0].id]).toBe('e2e-up-1');
  });
});

test.describe('session conditions and EXIF pre-fill', () => {
  test('picking JPEGs suggests the date, the shooting window and the camera without overwriting typed values; the create body carries the conditions', async ({ page, api }) => {
    await openStudio(page);
    await expect(page.locator('#adminConditions')).not.toHaveAttribute('open', '');
    await page.setInputFiles('#adminPhotoInput', await exifPicks());
    await expect(page.locator('#exifHint')).toHaveText('Shot 06:41–08:05 on 17 Sept with a Canon EOS R6.');
    await expect(page.locator('#adminConditions')).toHaveAttribute('open', '');
    await expect(page.locator('#adminDate')).toHaveValue('2026-09-17');
    await expect(page.locator('#adminPhotographer')).toHaveAttribute('placeholder', 'Who shot it · Canon EOS R6');
    await expect(page.locator('#adminPhotographer')).toHaveValue('');   // a placeholder, never a value
    // The crew's own date wins over a later pick.
    await page.locator('#adminDate').fill('2026-09-16');
    await page.setInputFiles('#adminPhotoInput', (await exifPicks()).slice(0, 1));
    await expect(page.locator('#exifHint')).toHaveText('Shot at 06:41 on 17 Sept with a Canon EOS R6.');
    await expect(page.locator('#adminDate')).toHaveValue('2026-09-16');
    await page.locator('#adminTitle').fill('Dawn glass'); await page.locator('#adminLocation').fill('Kodi Bengre');
    await page.locator('#adminBreakName').fill(' River mouth '); await page.locator('#adminSwell').fill('3.5'); await page.locator('#adminWind').fill('Offshore'); await page.locator('#adminTide').fill('rising'); await page.locator('#adminPhotographer').fill('Ankith'); await page.locator('#adminNextDrop').fill('2026-09-18T07:00');
    await page.locator('#publishBtn').click();
    await expect(page.locator('#uploadStatus')).toHaveText('Live. Faces are indexing — watch it in Sessions.', { timeout: 30_000 });
    const created = api.calls.find(call => call.path === '/api/admin/sessions' && call.method === 'POST');
    expect(created.body).toMatchObject({ title: 'Dawn glass', date: '2026-09-16', breakName: 'River mouth', swellFt: 3.5, wind: 'offshore', tide: 'rising', photographer: 'Ankith' });
    expect(new Date(created.body.nextDropAt).getTime()).toBe(await page.evaluate(() => new Date('2026-09-18T07:00').getTime()));
  });

  test('cards show the conditions and indexing lines from the dashboard; the edit modal pre-fills them and PUTs the change; an older Worker shows neither', async ({ page, api }) => {
    await openStudio(page);
    await openSessionsTab(page, 2);
    const first = page.locator('.d-card[data-session-id="e2e-sess-1"]'), second = page.locator('.d-card[data-session-id="e2e-sess-2"]');
    await expect(first.locator('.d-card-conditions')).toContainText('River mouth · 3.5 ft · offshore · rising tide · by Ankith · next drop');
    await expect(first.locator('.d-card-indexing')).toHaveCount(0);   // done: the badge says it
    await expect(second.locator('.d-card-indexing')).toHaveCount(0);   // nothing queued: the chips below carry the failures
    await expect(second.locator('.d-card-failures li')).toHaveText(['2 × Face service timed out', '1 × Image could not be decoded']);
    await expect(second.locator('.d-card-conditions')).toHaveCount(0);
    await (await cardMenuItem(page, 'e2e-sess-1', '.edit-session-btn')).click();
    await expect(page.locator('#editBreakName')).toHaveValue('River mouth');
    await expect(page.locator('#editSwell')).toHaveValue('3.5');
    await expect(page.locator('#editWind')).toHaveValue('offshore');
    await expect(page.locator('#editNextDrop')).toHaveValue(await page.evaluate(() => { const d = new Date('2026-09-18T01:30:00.000Z'); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }));
    await page.locator('#editTide').fill('dropping');
    await page.keyboard.press('Escape');
    await expect(page.locator('#confirmTitle')).toHaveText('Discard changes?');   // conditions count as edits
    await page.locator('#confirmCancelBtn').click();
    await page.locator('#editSessionForm button[type=submit]').click();
    await expect(page.locator('#editSessionModal')).not.toHaveAttribute('open', '');
    const put = api.calls.find(call => call.method === 'PUT');
    expect(put.body).toMatchObject({ breakName: 'River mouth', swellFt: 3.5, wind: 'offshore', tide: 'dropping', photographer: 'Ankith', nextDropAt: '2026-09-18T01:30:00.000Z' });
    await expect(first.locator('.d-card-conditions')).toContainText('dropping tide');
    api.state.oldWorker = true;
    await page.locator('#refreshBtn').click();
    await expect(first.locator('.d-card-title')).toHaveText('Morning glass');
    await expect(page.locator('.d-card-conditions')).toHaveCount(0);
    await expect(page.locator('.d-card-indexing')).toHaveCount(0);
    await expect(second.locator('.indexing-badge')).toHaveText('3 failed');
  });
});

test.describe('review queue', () => {
  test('a confidence meter per card coloured by band, and the whole frame with the face outlined beside each crop', async ({ page, api }) => {
    api.state.verifyQueue = [reviewPair('pair-1', 61), reviewPair('pair-2', 84)];
    api.state.linkQueue = [reviewLink('link-1', 42)];
    await openStudio(page);
    await page.locator('#nav-verify').click();
    await expect(page.locator('#verifyGrid .verify-card')).toHaveCount(2);
    await expect(page.locator('#verifyGrid .confirm-btn').first()).toBeEnabled({ timeout: 20_000 });
    const meters = page.locator('#verifyGrid [role="meter"]');
    await expect(meters).toHaveCount(2);
    await expect(meters.nth(0)).toHaveAttribute('aria-valuenow', '61');
    await expect(meters.nth(0)).toHaveAttribute('aria-label', 'Face similarity 61%');
    await expect(meters.nth(0)).toHaveAttribute('data-band', 'mid');
    await expect(meters.nth(1)).toHaveAttribute('data-band', 'high');
    await expect(page.locator('#linkGrid [role="meter"]')).toHaveAttribute('data-band', 'low');
    expect(await meters.nth(0).locator('i').evaluate(el => el.style.width)).toBe('61%');
    const fills = await page.locator('[role="meter"] i').evaluateAll(els => els.map(el => getComputedStyle(el).backgroundColor));
    expect(new Set(fills).size).toBe(3);   // three bands, three colours
    // Every crop has a whole-frame canvas next to it, at the photo's own aspect, with pixels drawn.
    const frames = page.locator('#verifyGrid .verify-card').first().locator('.face-full-canvas');
    await expect(frames).toHaveCount(2);
    const drawn = await frames.evaluateAll(canvases => canvases.map(canvas => { const ctx = canvas.getContext('2d'); const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data; let filled = 0; for (let i = 3; i < data.length; i += 4) if (data[i]) filled += 1; return { w: canvas.width, h: canvas.height, filled: filled / (canvas.width * canvas.height) }; }));
    for (const frame of drawn) { expect(frame.w).toBeLessThanOrEqual(480); expect(frame.h).toBeLessThanOrEqual(480); expect(frame.w !== frame.h).toBe(true); expect(frame.filled).toBeGreaterThan(0.95); }
    await expectClean(page);
  });
});

test('the five tabs keep the roving-tabindex keyboard model: arrows move and activate, Home / End jump, the panels follow', async ({ page }) => {
  await openStudio(page);
  await page.locator('#nav-verify').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#nav-money')).toBeFocused();
  await expect(page.locator('#tab-money')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#nav-support')).toBeFocused();
  await expect(page.locator('#tab-support')).toBeVisible();
  await expect(page.locator('#nav-support')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');   // wraps
  await expect(page.locator('#nav-upload')).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.locator('#nav-support')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.locator('#nav-upload')).toBeFocused();
  expect(await page.locator('.tab-btn').evaluateAll(tabs => tabs.map(tab => tab.tabIndex))).toEqual([0, -1, -1, -1, -1]);
  expect(await page.evaluate(() => document.querySelectorAll('main').length)).toBe(1);
});

test.describe('Money tab', () => {
  test('per-session funnel with rates and totals, settlements for the last 30 days, and the unreconciled list hands off to Support', async ({ page, api }) => {
    await openStudio(page);
    await page.locator('#nav-money').click();
    await expect(page.locator('#tab-money')).toBeVisible();
    await expect(page.locator('#moneySearches')).toHaveText('12');
    await expect(page.locator('#moneyMatchRate')).toHaveText('75% found a photo · target 60%');
    await expect(page.locator('#moneyUnlocks')).toHaveText('3');
    await expect(page.locator('#moneyUnlockRate')).toHaveText('33% of result views · target 25%');
    await expect(page.locator('#moneyRupees')).toHaveText('₹2,100');
    const rows = page.locator('#moneyFunnel tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator('td').nth(0)).toHaveText('Morning glass');
    await expect(rows.nth(0).locator('td').nth(1)).toHaveText('12');
    await expect(rows.nth(0).locator('td').nth(2)).toContainText('9');
    await expect(rows.nth(0).locator('td').nth(2).locator('.rate')).toHaveText('75%');
    await expect(rows.nth(0).locator('td').nth(7)).toHaveText('₹2,100');
    await expect(rows.nth(1)).toHaveClass(/is-muted/);
    await expect(page.locator('#settleFrom')).toHaveValue('2026-08-18');   // the fixed clock: 17 Sept IST
    await expect(page.locator('#settleTo')).toHaveValue('2026-09-17');
    await expect(page.locator('#settlementsList tbody tr')).toHaveCount(3);
    await expect(page.locator('#settlementsList tbody tr').nth(0).locator('td').nth(1)).toHaveText('AXISCN0123456789');
    await expect(page.locator('#settlementsList tbody tr.total td').last()).toHaveText('₹2,048');
    await expect(page.locator('#unreconciledList')).toContainText('1 captured payment not in any settlement yet');
    expect(api.calls.find(call => call.path === '/api/admin/settlements').query).toEqual({ from: '2026-08-18', to: '2026-09-17' });
    await page.locator('#settleFrom').fill('2026-09-01');
    await page.locator('#settleRangeForm button[type=submit]').click();
    await expect.poll(() => api.calls.filter(call => call.path === '/api/admin/settlements').at(-1).query).toEqual({ from: '2026-09-01', to: '2026-09-17' });
    await expectClean(page);
    await page.locator('#unreconciledList button').first().click();
    await expect(page.locator('#tab-support')).toBeVisible();
    await expect(page.locator('#supportQuery')).toHaveValue('mj-e2e-pay-1');
    await expect(page.locator('.support-card[data-kind="payment"]')).toBeVisible();
    expect(api.calls.find(call => call.path === '/api/admin/lookup').query).toEqual({ order: 'mj-e2e-pay-1' });
  });

  test('without the new routes the funnel and settlements each show one plain notice', async ({ page, api }) => {
    api.state.stats = null; api.state.settlements = null;
    await openStudio(page);
    await page.locator('#nav-money').click();
    await expect(page.locator('#moneyNotice')).toHaveText('The funnel needs the new Worker deploy (GET /api/admin/stats).');
    await expect(page.locator('#settlementsNotice')).toHaveText('Settlements need the new Worker deploy (GET /api/admin/settlements).');
    await expect(page.locator('#moneyFunnelWrap')).toBeHidden();
    await expect(page.locator('#settlementsWrap')).toBeHidden();
    await expect(page.locator('#moneySearches')).toHaveText('0');
  });
});

test.describe('Support tab', () => {
  test('a phone lookup returns the search, the payment and notify cards with the masked phone and the "what the guest saw" strip', async ({ page, api }) => {
    await openStudio(page);
    await page.locator('#nav-support').click();
    await expect(page.locator('#tab-support')).toBeVisible();
    await page.locator('#supportQuery').fill('+91 98765 43221');
    await expect(page.locator('#supportDetected')).toHaveText('Looking up a phone');
    await page.locator('#supportForm button[type=submit]').click();
    await expect(page.locator('.support-card')).toHaveCount(3);
    expect(api.calls.find(call => call.path === '/api/admin/lookup').query).toEqual({ phone: '9876543221' });
    const search = page.locator('.support-card[data-kind="search"]');
    await expect(search.locator('h3')).toContainText('Search e2e-search-1');
    await expect(search.locator('h3 .chip')).toHaveText('Paid');
    await expect(search).toContainText('98xxxxxx21');
    await expect(search.locator('.guest-saw p')).toHaveText('What the guest saw · 6');
    await expect(search.locator('.guest-saw li')).toHaveCount(6);
    await expect(search.locator('.guest-saw li.is-hidden')).toHaveCount(1);
    await settleImages(page, '.guest-saw img');
    await expect(page.locator('.support-card[data-kind="payment"] h3')).toContainText('Payment ₹700');
    await expect(page.locator('.support-card[data-kind="payment"] [data-support="refund"]')).toHaveText('Refund ₹700');
    await expect(page.locator('.support-card[data-kind="notify"]')).toContainText('not told yet');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);   // the strip scrolls inside its card
    await expectClean(page);
  });

  test('Resend link mints a fresh 30-day link and shows it; Free unlock needs a reason; Refund needs REFUND typed and a reason', async ({ page, api, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    await openStudio(page);
    await page.locator('#nav-support').click();
    await page.locator('#supportQuery').fill('e2e-search-1');
    await expect(page.locator('#supportDetected')).toHaveText('Looking up a search id');
    await page.locator('#supportForm button[type=submit]').click();
    await page.locator('.support-card[data-kind="search"] [data-support="resend"]').click();
    await expect(page.locator('.support-card[data-kind="search"] .support-link')).toContainText('https://photos.surfersofindia.com/?search=e2e-search-1&gallery=e2e-resend-token');
    await expect(page.locator('.support-card[data-kind="search"] .support-link small')).toContainText('Valid until 17 Oct 2026');
    await expect(page.locator('.soi-toast[data-kind="success"]')).toContainText(/Link copied|Link ready below/);
    expect(api.state.resends).toEqual([{ searchId: 'e2e-search-1', reason: undefined }]);
    // Refund: the typed word alone is not enough, the reason must be there too.
    await page.locator('.support-card[data-kind="payment"] [data-support="refund"]').click();
    await expect(page.locator('#confirmTitle')).toHaveText('Refund ₹700?');
    await expect(page.locator('#confirmCopy')).toContainText('Refund ₹700 to the guest?');
    await expect(page.locator('#confirmTypedInput')).toBeFocused();
    await page.locator('#confirmTypedInput').fill('REFUND');
    await expect(page.locator('#confirmOkBtn')).toBeDisabled();
    await page.locator('#confirmReason').fill('Wrong person matched');
    await expect(page.locator('#confirmOkBtn')).toBeEnabled();
    await page.locator('#confirmOkBtn').click();
    await expect(page.locator('.soi-toast[data-kind="success"]').last()).toContainText('Refund of ₹700 requested — Cashfree confirms it by webhook.');
    await expect(page.locator('.support-card[data-kind="payment"] h3')).toContainText('Refund pending');
    await expect(page.locator('.support-card[data-kind="payment"] [data-support="refund"]')).toHaveCount(0);
    expect(api.state.refunds).toEqual([{ paymentId: 'e2e-pay-1', amountPaise: 70000, reason: 'Wrong person matched' }]);
    // Free unlock on an unpaid search.
    api.state.lookup.searches[0].status = 'pending'; api.state.lookup.searches[0].paidAt = null;
    await page.locator('#supportForm button[type=submit]').click();
    await expect(page.locator('.support-card[data-kind="search"] h3 .chip')).toHaveText('Not paid');
    await page.locator('.support-card[data-kind="search"] [data-support="grant"]').click();
    await expect(page.locator('#confirmTitle')).toHaveText('Unlock for free?');
    await expect(page.locator('#confirmOkBtn')).toBeDisabled();
    await page.locator('#confirmReason').fill('Paid twice');
    await page.locator('#confirmOkBtn').click();
    await expect(page.locator('.support-card[data-kind="search"] .support-link')).toContainText('gallery=e2e-grant-token');
    await expect(page.locator('.support-card[data-kind="search"] h3 .chip')).toHaveText('Free unlock');
    expect(api.state.grants).toEqual([{ searchId: 'e2e-search-1', reason: 'Paid twice' }]);
  });

  test('nothing found and a Worker without the lookup route both end in a sentence, not a spinner', async ({ page, api }) => {
    api.state.lookup = { searches: [], payments: [], notify: [] };
    await openStudio(page);
    await page.locator('#nav-support').click();
    await page.locator('#supportQuery').fill('9876543221');
    await page.locator('#supportForm button[type=submit]').click();
    await expect(page.locator('.support-empty')).toContainText('Nothing for the phone ending 3221.');
    api.state.lookup = null;
    await page.locator('#supportForm button[type=submit]').click();
    await expect(page.locator('#supportNotice')).toHaveText('Support lookup needs the new Worker deploy (GET /api/admin/lookup).');
    await expect(page.locator('.support-card')).toHaveCount(0);
  });
});

test.describe('axe: new crew screens', () => {
  test('photo grid with a selection, and the cover picker', async ({ page, api }) => {
    await openGallery(page);
    await page.locator('#galleryGrid .photo-select input').nth(0).check();
    await expect(page.locator('#bulkBar')).toBeVisible();
    await expectClean(page);
    await page.locator('#closeGalleryModal').click();
    api.state.needsCover = true;
    await page.locator('.d-card[data-session-id="e2e-sess-2"] .publish-session-btn').click();
    await expect(page.locator('#photoGalleryModal')).toHaveAttribute('data-mode', 'cover');
    await settleImages(page, '#galleryGrid img');
    await expectClean(page);
  });
  test('upload form with the conditions open, and the edit modal', async ({ page }) => {
    await openStudio(page);
    await page.setInputFiles('#adminPhotoInput', await exifPicks());
    await expect(page.locator('#adminConditions')).toHaveAttribute('open', '');
    await settleImages(page, '#fileQueue img');
    await expectClean(page);
    await openSessionsTab(page, 2);
    await (await cardMenuItem(page, 'e2e-sess-1', '.edit-session-btn')).click();
    await expect(page.locator('#editSessionModal')).toHaveAttribute('open', '');
    await expectClean(page);
  });
});
