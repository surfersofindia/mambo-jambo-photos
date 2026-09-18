// Shared test fixtures: every test gets the API mock installed on its context before the first navigation and
// fails afterwards if any /api request slipped past the mocks. Import `test`/`expect` from here, never from
// @playwright/test directly, so the guard can't be forgotten.
import { test as base, expect } from '@playwright/test';
import { installApiMock } from './mock-api.mjs';

export const test = base.extend({
  api: [async ({ context, baseURL }, use) => {
    const api = await installApiMock(context, { origin: new URL(baseURL).origin });
    await use(api);
    expect(api.escaped, 'every /api request must be mocked — these reached the dev-server proxy').toEqual([]);
  }, { auto: true }],
  // Page errors are collected per test; a flow test asserts the list is empty at the end.
  pageErrors: [async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(String(error?.message || error)));
    await use(errors);
  }, { auto: true }],
});

export { expect };
