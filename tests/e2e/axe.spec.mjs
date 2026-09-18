// axe-core on every screen, WCAG 2.0 A + AA rules only (best-practice off), zero violations allowed. A screen that
// fails today keeps its strict assertion but is wrapped in test.fixme() so `npm run verify` stays green while the
// gap is visible; the violation ids and nodes are listed in docs/audit/handoff/W2-B.md as requests to the owners
// of index.html / admin.html / app.js / admin.js. Runs on all four projects (375, 768, 1024, 1440).
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './helpers/fixtures.mjs';
import { attachSelfie, chooseFirstSession, crewPicks, openAdminLogin, openCheckout, openLanding, openLightbox, openSessionsTab, openStudio, queueFiles, runSearch, searchToResults, settleImages } from './helpers/flows.mjs';

// One line per violation node so a failure reads like a checklist: "color-contrast (serious) footer > p: …".
async function violations(page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  // "incomplete" is what axe could not decide (mostly colour-contrast over photos and gradients) — never a failure,
  // but it is kept on the report as an annotation so a reviewer can see what needs a human eye.
  const incomplete = results.incomplete.map(rule => `${rule.id}×${rule.nodes.length}`).join(', ');
  test.info().annotations.push({ type: 'axe', description: `${results.passes.length} rules passed, ${results.violations.length} violated, needs review: ${incomplete || 'none'}` });
  expect(results.passes.length, 'axe ran at least a dozen rules on this screen').toBeGreaterThan(12);
  return results.violations.flatMap(violation => violation.nodes.map(node => `${violation.id} (${violation.impact}) ${node.target.join(' ')} — ${node.failureSummary.split('\n').slice(1).join(' | ')}`));
}
const expectClean = async page => expect(await violations(page)).toEqual([]);

test.describe('axe: public site', () => {
  test('hero (landing, sessions loaded)', async ({ page }) => {
    await openLanding(page);
    await expectClean(page);
  });
  test('finder (selfie stage, preview attached)', async ({ page }) => {
    await openLanding(page); await chooseFirstSession(page); await attachSelfie(page);
    await expectClean(page);
  });
  test('results', async ({ page }) => {
    await searchToResults(page);
    await expectClean(page);
  });
  test('zero match', async ({ page, api }) => {
    api.state.matchMode = 'empty';
    await openLanding(page); await chooseFirstSession(page); await attachSelfie(page); await runSearch(page, { expectPhotos: 0 });
    await expectClean(page);
  });
  test('lightbox', async ({ page }) => {
    await searchToResults(page); await openLightbox(page, 0);
    await expectClean(page);
  });
  test('checkout dialog', async ({ page }) => {
    await searchToResults(page); await openCheckout(page);
    await expectClean(page);
  });
  test('navigation menu open (phone)', async ({ page }) => {
    test.skip(page.viewportSize().width > 650, 'the toggle only exists on phones');
    await openLanding(page);
    await page.locator('#navToggle').click();
    await expect(page.locator('#primaryNav')).toBeVisible();
    await expectClean(page);
  });
});

test.describe('axe: crew studio', () => {
  test('admin login', async ({ page }) => {
    await openAdminLogin(page);
    await expectClean(page);
  });
  test('upload (queue with two photos)', async ({ page }) => {
    await openStudio(page);
    const picks = await crewPicks();
    await queueFiles(page, [picks.jpeg, picks.webp, picks.text]);
    await settleImages(page, '#fileQueue img');
    await expectClean(page);
  });
  test('sessions', async ({ page }) => {
    await openStudio(page); await openSessionsTab(page, 2);
    await expect(page.locator('.d-card-money').first()).toBeVisible();
    await expectClean(page);
  });
  test('review tab (empty queues)', async ({ page }) => {
    await openStudio(page);
    await page.locator('#nav-verify').click();
    await expect(page.locator('#tab-verify')).toBeVisible();
    await expectClean(page);
  });
});
