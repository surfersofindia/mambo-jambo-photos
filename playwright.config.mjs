// Playwright end-to-end suite (tests/e2e). Chromium only, one deterministic viewport per project.
// The dev server it starts proxies /api to the production Worker, so every /api request is answered by the
// route mocks in tests/e2e/helpers/mock-api.mjs and an un-mocked one fails the test (see fixtures.mjs).
// Re-baseline the screenshots with:  npm run e2e -- --update-snapshots
import { existsSync, readdirSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const PORT = 4195;
const SCREENS_ONLY = /(screenshots|axe)\.spec\.mjs$/;   // the tablet/wide projects only need the visual + axe passes

// Baselines are per platform (Chromium rasterises text differently on macOS and Linux). On a machine without a set for
// its own platform — a fresh CI runner, say — the screenshot tests still drive every screen but skip the comparison
// (ignoreSnapshots) instead of failing on "snapshot missing"; generate the set once with `npm run e2e -- --update-snapshots`
// on that platform and commit it, and the comparison switches on by itself.
const SNAPSHOT_DIR = new URL('./tests/e2e/__screenshots__/screenshots.spec.mjs/', import.meta.url);
const hasBaselines = existsSync(SNAPSHOT_DIR) && readdirSync(SNAPSHOT_DIR).some(name => name.endsWith(`-${process.platform}.png`));
// The skip must stand down when the run is meant to *create* the baselines: Playwright's matchers return a pass on
// ignoreSnapshots before they look at the update mode, so `--update-snapshots` on a platform without a set would write
// nothing (the CI bootstrap step relied on exactly that). The flag is read here in the runner process and handed to the
// workers — which re-import this file without the CLI arguments — through E2E_UPDATE_SNAPSHOTS; a CI step may set it too.
const updatingSnapshots = updateSnapshotsRequested(process.argv) || process.env.E2E_UPDATE_SNAPSHOTS === '1';
if (updatingSnapshots) process.env.E2E_UPDATE_SNAPSHOTS = '1';
const ignoreSnapshots = !hasBaselines && !updatingSnapshots;
if (ignoreSnapshots && !process.env.TEST_WORKER_INDEX) console.warn(`[e2e] no screenshot baselines for ${process.platform}; visual comparisons are skipped this run. Create them with: npm run e2e -- --update-snapshots`);
// `-u`, `--update-snapshots`, `--update-snapshots=<mode>` or `--update-snapshots <mode>` (any mode but `none`).
export function updateSnapshotsRequested(argv) {
  return argv.some((arg, index) => {
    const mode = arg === '-u' || arg === '--update-snapshots' ? (/^(all|changed|missing|none)$/.test(argv[index + 1] || '') ? argv[index + 1] : 'changed') : arg.startsWith('--update-snapshots=') ? arg.slice('--update-snapshots='.length) : null;
    return mode !== null && mode !== 'none';
  });
}

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.mjs$/,
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  ignoreSnapshots,
  // Baselines: tests/e2e/__screenshots__/<spec file>/<name>-<project>-<platform>.png (platform matters: Chromium
  // rasterises text differently on macOS and Linux, so each OS keeps its own set).
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}-{projectName}-{platform}{ext}',
  expect: {
    timeout: 10_000,
    // screenshots.spec.mjs captures with page.screenshot() and compares with toMatchSnapshot() (see the note there);
    // the toHaveScreenshot entry keeps the same tolerance for anyone using the matcher directly.
    toMatchSnapshot: { maxDiffPixelRatio: 0.005, threshold: 0.2 },
    toHaveScreenshot: { maxDiffPixelRatio: 0.005, threshold: 0.2, animations: 'disabled', caret: 'hide', scale: 'css' },
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: 'chromium',
    // Checker-imaging lets Chromium commit a frame with a large image left out of its raster tile and fill it in on a
    // later frame; under a four-worker load that later frame sometimes never comes before the capture, and a results
    // tile is photographed as an empty box (DOM loaded, decoded, opacity 1). Off, every tile is rastered with its image.
    launchOptions: { args: ['--disable-checker-imaging'] },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    colorScheme: 'light',
    // prefers-reduced-motion switches off the scroll-reveal pre-hide, the ticker, the stamp bursts and every
    // transition (site.css / premium.css / admin-theme.css honour it), which is what makes the screenshots stable.
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'mobile-375', use: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } },
    { name: 'tablet-768', use: { viewport: { width: 768, height: 1024 } }, testMatch: SCREENS_ONLY },
    { name: 'desktop-1024', use: { viewport: { width: 1024, height: 768 } } },
    { name: 'wide-1440', use: { viewport: { width: 1440, height: 900 } }, testMatch: SCREENS_ONLY },
  ],
  webServer: {
    command: `PORT=${PORT} npm run dev`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
