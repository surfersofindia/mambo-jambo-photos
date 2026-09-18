// Page-driving steps shared by the flow, screenshot and axe specs. Each step ends on a checked state so a
// later spec can chain them without re-asserting the basics.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { ADMIN_PASSWORD, ADMIN_TOKEN, PHOTO_IDS, asset } from './mock-api.mjs';

const ASSETS = new URL('../../../assets/', import.meta.url);
// fileURLToPath, not .pathname: the repo path has spaces and a URL pathname keeps them percent-encoded.
export const SELFIE = { name: 'selfie.jpg', mimeType: 'image/jpeg', path: fileURLToPath(new URL('mambo-jambo-surf-session-portrait.jpg', ASSETS)) };
export const FIXED_TIME = '2026-09-17T04:00:00.000Z';   // 09:30 IST; the crew studio defaults the session date to "today"

// Crew upload picks: two real photos under new names plus a text file the studio must reject.
export async function crewPicks() {
  const [jpeg, webp] = await Promise.all([asset('mambo-jambo-surf-session.jpg'), asset('backpackers-05.webp')]);
  return {
    jpeg: { name: 'SOI_0412.jpg', mimeType: 'image/jpeg', buffer: jpeg },
    webp: { name: 'SOI_0413.webp', mimeType: 'image/webp', buffer: webp },
    text: { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a photo') },
  };
}

export const fontsReady = page => page.evaluate(() => document.fonts?.ready).catch(() => {});
// Every image under `selector` is loaded *and decoded*: a loaded `decoding="async"` image can still paint blank
// for a frame or two, and a screenshot taken in that window shows the tile's box instead of the photo.
export async function settleImages(page, selector) {
  await page.waitForFunction(sel => [...document.querySelectorAll(sel)].every(img => img.complete && img.naturalWidth > 0), selector, { timeout: 15_000 });
  await page.evaluate(sel => Promise.all([...document.querySelectorAll(sel)].map(img => img.decode().catch(() => {}))), selector);
}
export const scrollTop = page => page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
export const isPhone = page => page.viewportSize().width < 651;   // site.css switches to the sticky action bar at ≤650px

// ── public site ──────────────────────────────────────────────────────────────
export async function openLanding(page) {
  await page.goto('/');
  await page.waitForFunction(() => document.getElementById('sessionChoices')?.getAttribute('aria-busy') === 'false');
  await expect(page.locator('label.session-choice')).toHaveCount(3);
  await fontsReady(page);
  await settleImages(page, '.hero-photo img');
}
export async function chooseFirstSession(page) {
  await page.locator('input[name="surfSession"]').first().check();
  await expect(page.locator('#nextStep')).toBeEnabled();
  await page.locator('#nextStep').click();
  await expect(page.locator('#selfieStage')).toBeVisible();
}
export async function attachSelfie(page) {
  await page.setInputFiles('#selfieInput', SELFIE.path);
  await expect(page.locator('#selfiePreview')).toBeVisible();
  await page.locator('#privacyConsent').check();
  await expect(page.locator('#findMatches')).toBeEnabled();
}
export async function runSearch(page, { expectPhotos = PHOTO_IDS.length } = {}) {
  await page.locator('#findMatches').click();
  await expect(page.locator('#results')).toBeVisible({ timeout: 20_000 });
  if (expectPhotos) {
    await expect(page.locator('#gallery figure')).toHaveCount(expectPhotos);
    await settleImages(page, '#gallery img');
    await expect(page.locator('#gallery figure.is-loading'), 'every tile has left its loading state').toHaveCount(0);
  }
  await scrollTop(page);
}
export async function searchToResults(page) {
  await openLanding(page); await chooseFirstSession(page); await attachSelfie(page); await runSearch(page);
}
export async function openLightbox(page, index = 0) {
  await page.locator('#gallery .photo-open').nth(index).click();
  await expect(page.locator('#lightbox')).toHaveAttribute('open', '');
  await page.waitForFunction(() => { const image = document.getElementById('lightboxImage'); return image && image.complete && image.naturalWidth > 0; });
}
export async function openCheckout(page) {
  await page.locator(isPhone(page) ? '#unlockButtonBar' : '#unlockButton').click();
  await expect(page.locator('#checkoutDialog')).toHaveAttribute('open', '');
  await expect(page.locator('#checkoutPhone')).toBeVisible();
}

// ── crew studio ──────────────────────────────────────────────────────────────
export async function openAdminLogin(page) {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto('/admin.html');
  await expect(page.locator('#loginScreen')).toBeVisible();
  await expect(page.locator('#adminPassword')).toBeVisible();
  await fontsReady(page);
}
export async function signIn(page, password = ADMIN_PASSWORD) {
  await page.locator('#adminPassword').fill(password);
  await page.locator('#loginForm button[type=submit]').click();
  await expect(page.locator('#adminApp')).toBeVisible();
  await expect(page.locator('#tab-upload')).toBeVisible();
}
// Straight into the studio with a stored token (what a returning crew member sees), no login round trip.
export async function openStudio(page) {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.addInitScript(token => { try { sessionStorage.setItem('mj-admin-token', token); } catch { /* storage blocked */ } }, ADMIN_TOKEN);
  await page.goto('/admin.html');
  await expect(page.locator('#adminApp')).toBeVisible();
  await expect(page.locator('#apiHealth')).toBeVisible();
  await fontsReady(page);
}
export async function queueFiles(page, files) {
  await page.setInputFiles('#adminPhotoInput', files);
  await expect(page.locator('#fileQueue')).toBeVisible();
  // selectFiles() smooth-scrolls Publish into view 100 ms after a pick; let that start and finish before a caller
  // repositions the page, or a screenshot catches the sticky topbar mid-scroll.
  await page.waitForTimeout(150);
  await page.waitForFunction(() => new Promise(resolve => { const y = window.scrollY; setTimeout(() => resolve(window.scrollY === y), 120); }));
}
export async function openSessionsTab(page, count) {
  await page.locator('#nav-dashboard').click();
  await expect(page.locator('#tab-dashboard')).toBeVisible();
  await expect(page.locator('#dashboardGrid .d-card')).toHaveCount(count);
}
export async function cardMenuItem(page, sessionId, selector) {
  const card = page.locator(`.d-card[data-session-id="${sessionId}"]`);
  await card.locator('.card-more summary').click();
  await expect(card.locator('.card-more')).toHaveAttribute('open', '');
  return card.locator(selector);
}

export { readFile };
