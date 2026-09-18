// FIX-C: the suite's own configuration, checked from inside a worker. playwright.config.mjs skips the screenshot
// comparison on a platform without baselines, but must NOT skip a run that is writing them — Playwright's matchers
// return a pass on ignoreSnapshots before they read the update mode, so the CI bootstrap step used to write nothing.
// The config decides in the runner process and hands the decision to the workers through E2E_UPDATE_SNAPSHOTS; this
// spec asserts that hand-over from the worker's side on every run (plain, `--update-snapshots`, or with the env var).
import { existsSync, readdirSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { updateSnapshotsRequested } from '../../playwright.config.mjs';

const SNAPSHOT_DIR = new URL('./__screenshots__/screenshots.spec.mjs/', import.meta.url);

test.describe('e2e config', () => {
  test('a run that writes baselines is never a run that ignores snapshots', () => {
    const { updateSnapshots } = test.info().config;
    const updating = updateSnapshots !== 'none' && updateSnapshots !== 'missing';   // 'missing' is Playwright's default: not a request to write
    const hasBaselines = existsSync(SNAPSHOT_DIR) && readdirSync(SNAPSHOT_DIR).some(name => name.endsWith(`-${process.platform}.png`));
    // Baselines present → comparisons are on regardless. Baselines absent → they are on exactly when the run is updating.
    if (updating) expect(process.env.E2E_UPDATE_SNAPSHOTS, 'the runner did not hand --update-snapshots to this worker').toBe('1');
    if (!hasBaselines && !updating) expect(process.env.E2E_UPDATE_SNAPSHOTS).not.toBe('1');
  });

  test('the CLI forms Playwright accepts for updating are all recognised, and "none" is not', () => {
    expect(updateSnapshotsRequested(['-u'])).toBe(true);
    expect(updateSnapshotsRequested(['--update-snapshots'])).toBe(true);
    expect(updateSnapshotsRequested(['--update-snapshots=all'])).toBe(true);
    expect(updateSnapshotsRequested(['--update-snapshots', 'changed', '-g', 'hero'])).toBe(true);
    expect(updateSnapshotsRequested(['--update-snapshots=none'])).toBe(false);
    expect(updateSnapshotsRequested(['--project=mobile-375'])).toBe(false);
  });
});
