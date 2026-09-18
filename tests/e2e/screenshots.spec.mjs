// Visual baselines for the seven canonical screens (hero, finder, results, lightbox, admin login, upload, sessions)
// plus the checkout dialog, on all four projects: 375×812 (touch), 768×1024, 1024×768 and 1440×900. Baselines live
// in tests/e2e/__screenshots__/screenshots.spec.mjs/<screen>-<project>-<platform>.png. They are rendered with
// prefers-reduced-motion, a fixed clock and a fully mocked API, so the only legitimate reason for a diff is a
// change to the markup, the styles or the fonts — re-baseline with:  npm run e2e -- --update-snapshots
import { readFile, writeFile } from 'node:fs/promises';
import { test, expect } from './helpers/fixtures.mjs';
import { reviewPair } from './helpers/mock-api.mjs';
import { attachSelfie, chooseFirstSession, crewPicks, fontsReady, openAdminLogin, openCheckout, openLanding, openLightbox, openSessionsTab, openStudio, queueFiles, scrollTop, searchToResults, settleImages } from './helpers/flows.mjs';

// Fonts and lazy images are awaited by the flow steps; this adds the last frame of settling before the capture
// (dialog top-layer paint, the health pill, a last layout pass) without ever depending on animation timing.
const settle = async page => {
  await fontsReady(page);
  // Photos are decoding="async": make sure every loaded image is actually decoded before the frame is captured.
  await page.evaluate(() => Promise.all([...document.images].map(img => { img.decoding = 'sync'; return img.complete ? img.decode().catch(() => {}) : null; })));
  // A smooth scroll may still be running (the upload form scrolls Publish into view after a pick): wait for scrollY to hold still.
  await page.waitForFunction(() => new Promise(resolve => { const y = window.scrollY; requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.scrollY === y))); }));
};
const STYLE = readFile(new URL('./helpers/screenshot.css', import.meta.url), 'utf8');
// page.screenshot() + toMatchSnapshot() rather than toHaveScreenshot(): the matcher forces two fresh animation frames
// before every capture and re-captures until two agree, which (before --disable-checker-imaging in the config) made
// the results grid's missing-tile raster 3–6× more frequent than a plain capture. Baseline files, tolerances and
// --update-snapshots behave exactly the same; only the capture path differs.
const shoot = async (page, name, options = {}) => {
  await settle(page);
  const image = await page.screenshot({ fullPage: false, animations: 'disabled', caret: 'hide', scale: 'css', style: await STYLE, ...options });
  expect(image).toMatchSnapshot(`${name}.png`);
};

// When a capture fails, the state of every image on the page rides along with the diff so a blank tile can be told
// apart from a missing one (loaded? decoded? which src? what opacity?).
test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  const images = await page.evaluate(() => Promise.all([...document.images].map(async img => {
    const cs = getComputedStyle(img); const box = img.getBoundingClientRect();
    let decode = 'ok', canvas = null;
    try { await img.decode(); } catch (error) { decode = String(error); }
    try { const c = document.createElement('canvas'); c.width = 8; c.height = 8; const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, 8, 8); canvas = [...ctx.getImageData(0, 0, 8, 8).data.slice(0, 12)]; } catch (error) { canvas = String(error); }
    return { src: img.currentSrc.replace(/^.*\//, ''), complete: img.complete, naturalWidth: img.naturalWidth, loading: img.loading, decoding: img.decoding, opacity: cs.opacity, visibility: cs.visibility, display: cs.display, box: [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)], figureClass: img.closest('figure')?.className || null, decode, canvas };
  }))).catch(error => ({ error: String(error) }));
  const file = info.outputPath('images.json');
  await writeFile(file, JSON.stringify(images, null, 2));
  await info.attach('images.json', { path: file, contentType: 'application/json' });
});

test.describe('public site', () => {
  test('hero', async ({ page }) => {
    await openLanding(page);
    await scrollTop(page);
    await shoot(page, 'hero');
  });

  test('finder (selfie stage)', async ({ page }) => {
    await openLanding(page); await chooseFirstSession(page); await attachSelfie(page);
    // The finder card just under the sticky header, the same framing on every viewport.
    await page.evaluate(() => {
      const card = document.querySelector('.finder-card') || document.getElementById('finder');
      const header = document.querySelector('.header');
      window.scrollTo({ top: Math.max(0, card.getBoundingClientRect().top + window.scrollY - ((header?.getBoundingClientRect().height || 0) + 12)), behavior: 'instant' });
    });
    await shoot(page, 'finder');
  });

  test('results', async ({ page }) => {
    await searchToResults(page);
    await shoot(page, 'results');
  });

  test('lightbox', async ({ page }) => {
    await searchToResults(page); await openLightbox(page, 0);
    await shoot(page, 'lightbox');
  });

  test('checkout dialog', async ({ page }) => {
    await searchToResults(page); await openCheckout(page);
    await shoot(page, 'checkout');
  });
});

test.describe('crew studio', () => {
  test('admin login', async ({ page }) => {
    await openAdminLogin(page);
    await shoot(page, 'admin-login');
  });

  test('upload (queue with two photos, one left out)', async ({ page }) => {
    await openStudio(page);
    const picks = await crewPicks();
    await queueFiles(page, [picks.jpeg, picks.webp, picks.text]);
    await settleImages(page, '#fileQueue img');
    await expect(page.locator('#uploadStatus')).toContainText('1 left out');
    await scrollTop(page);
    await shoot(page, 'admin-upload', { fullPage: true });
  });

  test('sessions', async ({ page }) => {
    await openStudio(page); await openSessionsTab(page, 2);
    await expect(page.locator('.d-card[data-session-id="e2e-sess-1"] .d-card-money')).toHaveText('12 searches · 3 unlocks · ₹2,100');
    await scrollTop(page);
    await shoot(page, 'admin-sessions', { fullPage: true });
  });
});

// W3-C screens: the photo grid with a bulk selection, the cover-picker step, a review card with the confidence meter
// and whole-frame canvases, and the Money and Support tabs. Same mocks, same four viewports.
test.describe('crew studio (W3-C)', () => {
  test('photo grid with a bulk selection', async ({ page }) => {
    await openStudio(page); await openSessionsTab(page, 2);
    await page.locator('.d-card[data-session-id="e2e-sess-2"] .view-photos-btn').click();
    await expect(page.locator('#galleryGrid .photo-card')).toHaveCount(3);
    await settleImages(page, '#galleryGrid img');
    await page.locator('#galleryGrid .photo-select input').nth(0).check();
    await page.locator('#galleryGrid .photo-select input').nth(2).check();
    await expect(page.locator('#bulkCount')).toHaveText('2 selected');
    await shoot(page, 'admin-gallery-bulk');
  });

  test('cover picker before publish', async ({ page, api }) => {
    api.state.needsCover = true;
    await openStudio(page); await openSessionsTab(page, 2);
    await page.locator('.d-card[data-session-id="e2e-sess-2"] .publish-session-btn').click();
    await expect(page.locator('#photoGalleryModal')).toHaveAttribute('data-mode', 'cover');
    await expect(page.locator('#galleryGrid .photo-pick')).toHaveCount(3);
    await settleImages(page, '#galleryGrid img');
    await page.locator('#galleryGrid .photo-pick').nth(1).click();
    await expect(page.locator('#publishWithCoverBtn')).toBeEnabled();
    await shoot(page, 'admin-cover-picker');
  });

  test('review card with the meter and whole frames', async ({ page, api }) => {
    api.state.verifyQueue = [reviewPair('pair-1', 61)];
    await openStudio(page);
    await page.locator('#nav-verify').click();
    await expect(page.locator('#verifyGrid .confirm-btn').first()).toBeEnabled({ timeout: 20_000 });
    await page.evaluate(() => document.querySelector('#verifyGrid .verify-card').scrollIntoView({ block: 'start', behavior: 'instant' }));
    await shoot(page, 'admin-review-card');
  });

  test('money tab', async ({ page }) => {
    await openStudio(page);
    await page.locator('#nav-money').click();
    await expect(page.locator('#moneyFunnel tbody tr')).toHaveCount(2);
    await expect(page.locator('#settlementsList tbody tr')).toHaveCount(3);
    await scrollTop(page);
    await shoot(page, 'admin-money', { fullPage: true });
  });

  test('support tab with a lookup', async ({ page }) => {
    await openStudio(page);
    await page.locator('#nav-support').click();
    await page.locator('#supportQuery').fill('9876543221');
    await page.locator('#supportForm button[type=submit]').click();
    await expect(page.locator('.support-card')).toHaveCount(3);
    await settleImages(page, '.guest-saw img');
    await scrollTop(page);
    await shoot(page, 'admin-support', { fullPage: true });
  });
});
