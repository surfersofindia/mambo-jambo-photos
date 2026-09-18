// W4-C · per-crew accounts, TOTP and the audit log in the studio, against the mocked API (no crew
// credentials exist on this machine and the login endpoint is never touched for real): signing in
// with a name and a 6-digit code, the Crew pane appearing only for an admin, creating an account and
// switching its authenticator on, disabling one, and the audit list. Plus an axe pass on the pane.
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './helpers/fixtures.mjs';
import { ADMIN_PASSWORD, ADMIN_TOKEN } from './helpers/mock-api.mjs';
import { openAdminLogin, openStudio } from './helpers/flows.mjs';

const expectClean = async page => {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations.flatMap(v => v.nodes.map(n => `${v.id} (${v.impact}) ${n.target.join(' ')}`))).toEqual([]);
};
const ADMIN_ME = { user: { id: 'crew-1', name: 'Ankith', role: 'admin', totpEnabled: true, createdAt: '2026-09-01T06:00:00.000Z', lastLoginAt: '2026-09-17T05:00:00.000Z', disabledAt: null }, role: 'admin', canManageUsers: true, sharedLogin: false, accounts: true };
const CREW = () => ([
  { id: 'crew-1', name: 'Ankith', role: 'admin', totpEnabled: true, createdAt: '2026-09-01T06:00:00.000Z', lastLoginAt: '2026-09-17T05:00:00.000Z', disabledAt: null },
  { id: 'crew-2', name: 'Sam', role: 'photographer', totpEnabled: false, createdAt: '2026-09-10T06:00:00.000Z', lastLoginAt: null, disabledAt: null },
]);
const AUDIT = [
  { id: 'a1', actorUserId: 'crew-1', actor: 'Ankith', action: 'payment.refund', targetType: 'payment', targetId: 'mj-pay-1', detail: { amountPaise: 29900 }, ip: '203.0.113.5', createdAt: '2026-09-17T06:30:00.000Z' },
  { id: 'a2', actorUserId: null, actor: 'Sam (unverified)', action: 'login.failure', targetType: null, targetId: null, detail: { reason: 'password' }, ip: '203.0.113.9', createdAt: '2026-09-17T06:20:00.000Z' },
  { id: 'a3', actorUserId: 'crew-2', actor: 'Sam', action: 'session.unpublish', targetType: 'session', targetId: 'ses-mulki-0917', detail: { was: 'published', now: 'draft' }, ip: '203.0.113.9', createdAt: '2026-09-17T06:10:00.000Z' },
];

test.describe('signing in with an account', () => {
  test('the code field appears only when the Worker asks for it, and the name is remembered next time', async ({ page, api, pageErrors }) => {
    api.state.needsTotp = true; api.state.me = ADMIN_ME;
    await openAdminLogin(page);
    await expect(page.locator('#adminName')).toBeFocused();
    await expect(page.locator('#loginCodeField')).toBeHidden();

    await page.locator('#adminName').fill('Ankith');
    await page.locator('#adminPassword').fill(ADMIN_PASSWORD);
    await page.locator('#loginForm button[type=submit]').click();
    await expect(page.locator('#loginError')).toHaveText('Enter the 6-digit code from your authenticator app.');
    await expect(page.locator('#loginCodeField')).toBeVisible();
    await expect(page.locator('#adminCode')).toBeFocused();
    await expect(page.locator('#adminPassword')).toHaveValue(ADMIN_PASSWORD, 'the password typed once is kept');
    await expectClean(page);

    await page.locator('#adminCode').fill('000000');
    await page.locator('#loginForm button[type=submit]').click();
    await expect(page.locator('#loginError')).toHaveText('That code did not match. Try the next one.');

    await page.locator('#adminCode').fill(api.state.totpCode);
    await page.locator('#loginForm button[type=submit]').click();
    await expect(page.locator('#adminApp')).toBeVisible();
    const sent = api.calls.filter(call => call.path === '/api/admin/login');
    expect(sent.map(call => [call.body.name, call.body.password, call.body.code])).toEqual([['Ankith', '***', null], ['Ankith', '***', '000000'], ['Ankith', '***', '123456']]);

    // Signed out and back: the name is remembered, so the cursor starts on the password.
    await page.locator('#signOutBtn').click();
    await expect(page.locator('#loginScreen')).toBeVisible();
    await expect(page.locator('#adminName')).toHaveValue('Ankith');
    await expect(page.locator('#adminPassword')).toBeFocused();
    await expect(page.locator('#loginCodeField')).toBeHidden();
    expect(pageErrors).toEqual([]);
  });

  test('the shared password still signs in with no name at all, and hides the Crew button', async ({ page, api }) => {
    await openAdminLogin(page);
    await page.locator('#adminPassword').fill(ADMIN_PASSWORD);
    await page.locator('#loginForm button[type=submit]').click();
    await expect(page.locator('#adminApp')).toBeVisible();
    expect(api.calls.find(call => call.path === '/api/admin/login').body.name).toBeNull();
    await expect(page.locator('#crewBtn')).toBeHidden();   // this mock is a Worker without the crew routes
  });
});

test.describe('crew accounts', () => {
  test.beforeEach(async ({ api }) => { api.state.me = ADMIN_ME; api.state.crew = CREW(); api.state.audit = AUDIT; });

  test('an admin sees the crew, adds someone, switches their authenticator on and disables an account', async ({ page, api, pageErrors }) => {
    await openStudio(page);
    await expect(page.locator('#crewBtn')).toBeVisible();
    await page.locator('#crewBtn').click();
    await expect(page.locator('#crewScreen')).toBeVisible();
    await expect(page.locator('#adminApp')).toBeHidden();
    await expect(page.locator('#crewList .d-card')).toHaveCount(2);
    await expect(page.locator('#crewList .d-card').first()).toContainText('Ankith');
    await expect(page.locator('#crewList .d-card').first()).toContainText('Authenticator on');
    await expect(page.locator('#crewList .d-card').nth(1)).toContainText('No authenticator yet');
    await expectClean(page);

    // Add an account: the authenticator key is shown once, with the otpauth link beside it.
    await page.locator('#crewNewName').fill('Riya');
    await page.locator('#crewNewPassword').fill('a-long-crew-password');
    await page.locator('#crewNewRole').selectOption('photographer');
    await page.locator('#crewCreateForm button[type=submit]').click();
    await expect(page.locator('#crewProvision')).toBeVisible();
    await expect(page.locator('#crewProvisionName')).toHaveText('Riya’s');
    await expect(page.locator('#crewProvisionSecret')).toHaveText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
    await expect(page.locator('#crewProvisionLink')).toHaveAttribute('href', /^otpauth:\/\/totp\/SOI%20Crew:Riya\?secret=/);
    await expect(page.locator('#crewList .d-card')).toHaveCount(3);
    const created = api.calls.find(call => call.path === '/api/admin/users' && call.method === 'POST');
    expect([created.body.name, created.body.role, created.body.password]).toEqual(['Riya', 'photographer', '***']);
    await expectClean(page);

    // Their first code turns TOTP on.
    await page.locator('#crewVerifyCode').fill('999999');
    await page.locator('#crewVerifyForm button[type=submit]').click();
    await expect(page.locator('#crewVerifyError')).toHaveText('That code did not match. Try the next one.');
    await page.locator('#crewVerifyCode').fill(api.state.totpCode);
    await page.locator('#crewVerifyForm button[type=submit]').click();
    await expect(page.locator('#crewProvision')).toBeHidden();
    await expect(page.locator('#crewList [data-user-id="crew-3"]')).toContainText('Authenticator on');

    // Disabling asks first, then that card says so and its actions go. (The mock keeps its own order;
    // the Worker sorts disabled accounts last, so the card is found by its account id, not its place.)
    const sam = page.locator('#crewList [data-user-id="crew-2"]');
    page.once('dialog', dialog => dialog.accept());
    await sam.locator('button[data-crew-action="disable"]').click();
    await expect(sam).toContainText('Disabled');
    await expect(sam.locator('button[data-crew-action]')).toHaveCount(0);
    expect(api.calls.some(call => call.path === '/api/admin/users/crew-2/disable')).toBe(true);

    // Back to the studio, and the button says which pane is open.
    await page.locator('#crewBackBtn').click();
    await expect(page.locator('#adminApp')).toBeVisible();
    await expect(page.locator('#crewBtn')).toHaveAttribute('aria-expanded', 'false');
    expect(pageErrors).toEqual([]);
  });

  test('the audit list reads as sentences, newest first', async ({ page }) => {
    await openStudio(page);
    await page.locator('#crewBtn').click();
    await expect(page.locator('#auditList .d-card')).toHaveCount(3);
    await expect(page.locator('#auditList .d-card').first()).toContainText('Ankith refunded a payment');
    await expect(page.locator('#auditList .d-card').first()).toContainText('payment mj-pay-1');
    await expect(page.locator('#auditList .d-card').nth(1)).toContainText('Sam (unverified) failed to sign in');
    await expect(page.locator('#auditList .d-card').nth(2)).toContainText('Sam took a session off the site');   // PUT status: 'draft' (the card's Restore/Unpublish path)
    await expect(page.locator('#auditList .d-card').nth(2)).toContainText('was: published · now: draft');
    await expect(page.locator('#auditMoreBtn')).toBeHidden();   // the mock hands back no cursor
  });

  test('a photographer never sees the Crew button, and an older Worker hides it too', async ({ page, api }) => {
    api.state.me = { user: { id: 'crew-2', name: 'Sam', role: 'photographer', totpEnabled: false }, role: 'photographer', canManageUsers: false, sharedLogin: false, accounts: true };
    await openStudio(page);
    await expect(page.locator('#tab-upload')).toBeVisible();
    await expect(page.locator('#crewBtn')).toBeHidden();

    api.state.me = null;   // a Worker deployed before migration 0016's routes
    await page.evaluate(() => { try { sessionStorage.removeItem('mj-admin-who'); } catch { /* ignore */ } });
    await page.reload();
    await expect(page.locator('#adminApp')).toBeVisible();
    await expect(page.locator('#crewBtn')).toBeHidden();
    expect(await page.evaluate(() => sessionStorage.getItem('mj-admin-token'))).toBe(ADMIN_TOKEN);
  });
});
