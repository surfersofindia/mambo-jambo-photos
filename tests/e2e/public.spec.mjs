// The guest flow end to end against the mocked API: sessions → selfie → results → lightbox → checkout dialog,
// the paid path through a stubbed Cashfree SDK, the redirect return with ?order_id=, the zero-match state, the
// 30-day resume notice and the guard that fails any test letting a request through to the real Worker.
// Runs on the mobile-375 and desktop-1024 projects (playwright.config.mjs).
import { test, expect } from './helpers/fixtures.mjs';
import { ORDER, PHOTO_IDS, SEARCH } from './helpers/mock-api.mjs';
import { attachSelfie, chooseFirstSession, isPhone, openCheckout, openLanding, openLightbox, runSearch, searchToResults, settleImages } from './helpers/flows.mjs';

const PHONE = '9876543210';

// window.Cashfree as app.js uses it: loadCashfreeSdk() short-circuits when the global exists, so the blocked
// sdk.cashfree.com script is never needed. checkout() resolves like a completed in-modal attempt (paymentDetails),
// which makes app.js call POST /api/payment/verify — the same path a real card/UPI payment takes.
const stubCashfree = (page, outcome = 'paid') => page.addInitScript(mode => {
  window.__cashfreeCalls = [];
  window.Cashfree = options => ({ checkout: async args => { window.__cashfreeCalls.push({ options, args }); return mode === 'paid' ? { paymentDetails: { paymentMessage: 'ok' } } : { error: { message: 'cancelled' } }; } });
}, outcome);

test.describe('guest flow', () => {
  test('sessions → selfie → results: three sessions, consent gate, nine previews', async ({ page, api, pageErrors }) => {
    await openLanding(page);
    await expect(page.locator('#nextStep')).toBeDisabled();
    const choices = page.locator('label.session-choice');
    await expect(choices.nth(0)).toContainText('Morning glass');
    await expect(choices.nth(0).locator('.session-recent')).toHaveText('Latest');
    await expect(page.locator('#sessionCards .session-card')).toHaveCount(3);
    await chooseFirstSession(page);
    await expect(page.locator('#selectedSessionSummary')).toContainText('Morning glass');
    await expect(page.locator('#selectedSessionSummary')).toContainText('Mulki Beach');
    await expect(page.locator('#step2')).toHaveAttribute('aria-current', 'step');

    // A text file is refused with the same copy the drop zone uses; the submit stays locked until consent.
    await page.setInputFiles('#selfieInput', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a selfie') });
    await expect(page.locator('#finderStatus')).toHaveText('JPG, PNG or WebP under 10 MB.');
    await expect(page.locator('#findMatches')).toBeDisabled();
    await attachSelfie(page);
    await expect(page.locator('#finderStatus')).toHaveText('');

    await runSearch(page);
    await expect(page.locator('#resultsTitle')).toHaveText('9 waves. All you.');
    await expect(page.locator('#resultsMeta')).toHaveText(/14 Sept? 2026 · Mulki Beach · Morning glass/);
    await expect(page.locator('#gallery figure').first().locator('figcaption')).toContainText('WAVE 01 · PREVIEW');
    await expect(page.locator('#gallery figure.is-broken')).toHaveCount(0);
    await expect(page.locator('#step2')).toHaveAttribute('aria-current', 'step');   // the finder is parked on the selfie stage for a re-run
    const unlock = page.locator(isPhone(page) ? '#unlockButtonBar' : '#unlockButton');
    await expect(unlock).toBeVisible();
    await expect(unlock).toContainText('Unlock all photos · ₹700');
    await expect(page.locator('#noMatches')).toBeHidden();

    const match = api.calls.find(call => call.path === '/api/match');
    expect(match.body).toEqual({ sessionId: 'e2e-sess-1', consent: 'true', multipart: true, file: { name: 'mambo-jambo-surf-session-portrait.jpg', type: 'image/jpeg' } });   // small enough to go up untouched
    expect(api.calls.filter(call => call.path.startsWith('/api/media/')).length).toBe(0);   // media is served, not recorded
    expect(pageErrors).toEqual([]);
  });

  test('favourites: hearts, the count, the filter and its empty state', async ({ page }) => {
    await searchToResults(page);
    const hearts = page.locator('#gallery .favourite');
    await hearts.nth(1).click();
    await hearts.nth(3).click();
    await expect(hearts.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#favouriteCount')).toHaveText('2');
    const filter = page.locator(isPhone(page) ? '#favouritesFilterBar' : '#favouritesFilter');
    await filter.click();
    await expect(page.locator('#gallery figure')).toHaveCount(2);
    await expect(page.locator('#gallery figure').first().locator('figcaption')).toContainText('WAVE 02');
    // Un-keeping the last two leaves the shell stamp state with a way back to every wave.
    await page.locator('#gallery .favourite').first().click();
    await page.locator('#gallery .favourite').first().click();
    await expect(page.locator('#galleryEmpty')).toBeVisible();
    await expect(page.locator('#galleryEmpty')).toContainText('No keepers yet.');
    await page.locator('#showAllWaves').click();
    await expect(page.locator('#gallery figure')).toHaveCount(PHOTO_IDS.length);
    await expect(page.locator('#favouriteCount')).toHaveText('0');
  });

  test('lightbox: opens on a tile, steps with buttons and arrow keys, closes with Escape', async ({ page }) => {
    await searchToResults(page);
    await openLightbox(page, 0);
    await expect(page.locator('#lightboxCount')).toHaveText('1 of 9');
    await expect(page.locator('#lightboxCaption')).toHaveText('Preview');
    await expect(page.locator('#downloadPhoto')).toBeHidden();
    await expect(page.locator('#lightboxImage')).toHaveAttribute('alt', 'Wave 1 of 9, preview');
    await page.locator('#nextPhoto').click();
    await expect(page.locator('#lightboxCount')).toHaveText('2 of 9');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#lightboxCount')).toHaveText('3 of 9');
    await page.locator('#previousPhoto').click();
    await expect(page.locator('#lightboxCount')).toHaveText('2 of 9');
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#lightboxCount')).toHaveText('9 of 9');   // wraps around
    // The hint follows the pointer type: touch copy on the phone project, keys on desktop.
    const hint = page.locator(isPhone(page) ? '.hint-touch' : '.hint-pointer');
    await expect(hint).toBeVisible();
    await expect(page.locator(isPhone(page) ? '.hint-pointer' : '.hint-touch')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator('#lightbox')).not.toHaveAttribute('open', '');
    await page.locator('#closeLightbox').isHidden();
  });

  test('checkout dialog: count and price in the heading, phone validation, cancel', async ({ page, api }) => {
    await searchToResults(page);
    await openCheckout(page);
    await expect(page.locator('#checkoutTitle')).toHaveText('9 photos · ₹700');
    await expect(page.locator('#payButton')).toHaveText(/Pay\s*₹700/);
    await expect(page.locator('#checkoutDialog .eyebrow')).toHaveText('ALMOST YOURS');
    // The field's pattern ([6-9][0-9]{9}) stops the submit natively; the JS check behind it is the belt to that brace.
    await page.locator('#checkoutPhone').fill('12345');
    await page.locator('#payButton').click();
    expect(await page.locator('#checkoutPhone').evaluate(input => input.validity.patternMismatch)).toBe(true);
    await expect(page.locator('#checkoutDialog')).toHaveAttribute('open', '');
    expect(api.calls.filter(call => call.path === '/api/checkout')).toEqual([]);
    await page.locator('#checkoutPhone').evaluate(input => { input.removeAttribute('pattern'); });
    await page.locator('#payButton').click();
    await expect(page.locator('#checkoutStatus')).toHaveText('Needs a 10-digit mobile number.');
    expect(api.calls.filter(call => call.path === '/api/checkout')).toEqual([]);
    await page.locator('#cancelCheckout').click();
    await expect(page.locator('#checkoutDialog')).not.toHaveAttribute('open', '');
    await expect(page.locator('#results')).toBeVisible();
  });

  test('checkout without the payment SDK: the order is created, the failure is shown and the dialog stays open', async ({ page, api }) => {
    await searchToResults(page);
    await openCheckout(page);
    await page.locator('#checkoutPhone').fill(PHONE);
    await page.locator('#payButton').click();
    await expect(page.locator('#checkoutStatus')).toHaveText('Couldn’t reach the payment service. Check your connection.');
    await expect(page.locator('#checkoutDialog')).toHaveAttribute('open', '');
    await expect(page.locator('#payButton')).toBeEnabled();
    const order = api.calls.find(call => call.path === '/api/checkout');
    expect(order.body).toEqual({ searchId: SEARCH.id, token: SEARCH.token, phone: PHONE });
    expect(api.calls.find(call => call.path === '/api/payment/verify')).toBeUndefined();
  });

  test('paid in the modal: verify unlocks the originals, download links and the 30-day gallery token', async ({ page, api, pageErrors }) => {
    await stubCashfree(page, 'paid');
    await searchToResults(page);
    await openCheckout(page);
    await page.locator('#checkoutPhone').fill(PHONE);
    await page.locator('#checkoutEmail').fill('surfer@example.com');
    await page.locator('#payButton').click();
    await expect(page.locator('#checkoutDialog')).not.toHaveAttribute('open', '');
    await expect(page.locator('#unlockedNotice')).toBeVisible();
    await expect(page.locator('#unlockButton')).toBeHidden();
    await expect(page.locator('#gallery figcaption a')).toHaveCount(PHOTO_IDS.length);
    await expect(page.locator('#gallery figure').first().locator('figcaption')).toContainText('WAVE 01 · ORIGINAL');
    await expect(page.locator('#gallery figcaption a').first()).toHaveAttribute('href', /\/api\/media\/e2e-photo-01\?variant=original&token=e2e-media-original&download=1$/);
    await settleImages(page, '#gallery img');
    const zip = page.locator(isPhone(page) ? '#downloadAllBar' : '#downloadAll');
    await expect(zip).toBeVisible();
    if (!isPhone(page)) await expect(zip).toHaveAttribute('href', /\/api\/searches\/e2e-search-1\/download\?token=e2e-gallery-token$/);
    // The lightbox now offers the original for download.
    await openLightbox(page, 0);
    await expect(page.locator('#lightboxCaption')).toHaveText('Original');
    await expect(page.locator('#downloadPhoto')).toBeVisible();
    await page.keyboard.press('Escape');

    const sdk = await page.evaluate(() => window.__cashfreeCalls);
    expect(sdk).toEqual([{ options: { mode: 'sandbox' }, args: { paymentSessionId: ORDER.paymentSessionId, redirectTarget: '_modal' } }]);
    expect(api.calls.find(call => call.path === '/api/checkout').body).toEqual({ searchId: SEARCH.id, token: SEARCH.token, phone: PHONE, email: 'surfer@example.com' });
    expect(api.calls.find(call => call.path === '/api/payment/verify').body).toEqual({ searchId: SEARCH.id, token: SEARCH.token, orderId: ORDER.id });
    expect(api.calls.find(call => call.path === '/api/searches/e2e-search-1/access').query).toEqual({ token: SEARCH.token });
    const stored = await page.evaluate(() => ({ gallery: JSON.parse(localStorage.getItem('mjGallery')), checkout: sessionStorage.getItem('mjCheckout') || localStorage.getItem('mjCheckout') }));
    expect(stored.gallery).toMatchObject({ searchId: SEARCH.id, token: SEARCH.galleryToken, session: { title: 'Morning glass' } });
    expect(stored.checkout).toBeNull();
    expect(pageErrors).toEqual([]);
  });

  test('cancelled in the modal: the dialog reopens with a retry message and nothing is unlocked', async ({ page, api }) => {
    await stubCashfree(page, 'cancelled');
    await searchToResults(page);
    await openCheckout(page);
    await page.locator('#checkoutPhone').fill(PHONE);
    await page.locator('#payButton').click();
    await expect(page.locator('#checkoutStatus')).toHaveText('Payment didn’t go through. Try again?');
    await expect(page.locator('#checkoutDialog')).toHaveAttribute('open', '');
    await expect(page.locator('#unlockedNotice')).toBeHidden();
    expect(api.calls.find(call => call.path === '/api/payment/verify')).toBeUndefined();
  });

  test('zero match: the starfish state ends in "Try another selfie" and nothing is offered for sale', async ({ page, api }) => {
    api.state.matchMode = 'empty';
    await openLanding(page); await chooseFirstSession(page); await attachSelfie(page);
    await runSearch(page, { expectPhotos: 0 });
    await expect(page.locator('#resultsTitle')).toHaveText('No waves with your face in them.');
    await expect(page.locator('#noMatches')).toBeVisible();
    await expect(page.locator('#noMatches')).toContainText('Nothing matched this time.');
    await expect(page.locator('#gallery figure')).toHaveCount(0);
    await expect(page.locator('#unlockButton')).toBeHidden();
    await expect(page.locator('#checkoutNotice')).toBeHidden();
    await expect(page.locator('#actionBar')).toBeHidden();
    await page.locator('#tryAgain').click();
    await expect(page.locator('#main')).toBeVisible();
    await expect(page.locator('#results')).toBeHidden();
    await expect(page.locator('#selfieStage')).toBeVisible();   // the selfie stage, with the session still chosen
    await expect(page.locator('#selectedSessionSummary')).toContainText('Morning glass');
  });

  test('the browser Back button returns from the results to the finder', async ({ page }) => {
    await searchToResults(page);
    await page.goBack();
    await expect(page.locator('#main')).toBeVisible();
    await expect(page.locator('#results')).toBeHidden();
    await expect(page.locator('#actionBar')).toBeHidden();
    await page.goForward();
    await expect(page.locator('#results')).toBeVisible();
    await expect(page.locator('#gallery figure')).toHaveCount(PHOTO_IDS.length);
  });
});

test.describe('redirect return (?order_id=)', () => {
  const pending = { searchId: SEARCH.id, token: SEARCH.token, orderId: ORDER.id, at: 1_789_000_000_000 };

  test('the tab that searched: verify runs, the originals render as "Paid." and the URL is cleaned', async ({ page, api, pageErrors }) => {
    await page.addInitScript(value => sessionStorage.setItem('mjCheckout', value), JSON.stringify(pending));
    await page.goto(`/?order_id=${ORDER.id}`);
    await expect(page.locator('#results')).toBeVisible();
    await expect(page.locator('#resultsTitle')).toHaveText('Paid.');
    await expect(page.locator('#resultsCopy')).toHaveText('These are the originals — tap one, then Download.');
    await expect(page.locator('#gallery figure')).toHaveCount(PHOTO_IDS.length);
    await expect(page.locator('#gallery figcaption a')).toHaveCount(PHOTO_IDS.length);
    await expect(page.locator('#unlockedNotice')).toBeVisible();
    await expect(page.locator(isPhone(page) ? '#downloadAllBar' : '#downloadAll')).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await settleImages(page, '#gallery img');
    const verify = api.calls.find(call => call.path === '/api/payment/verify');
    expect(verify.body).toEqual({ searchId: SEARCH.id, token: SEARCH.token, orderId: ORDER.id });
    expect(api.calls.findIndex(call => call.path === '/api/match')).toBe(-1);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('mjGallery') || 'null'))).toMatchObject({ searchId: SEARCH.id, token: SEARCH.galleryToken });
    expect(await page.evaluate(() => sessionStorage.getItem('mjCheckout'))).toBeNull();
    expect(pageErrors).toEqual([]);
  });

  test('a different browser: no stored search, so the page says who to contact and never calls verify', async ({ page, api }) => {
    await page.goto(`/?order_id=${ORDER.id}`);
    await expect(page.locator('#results')).toBeVisible();
    await expect(page.locator('#resultsTitle')).toHaveText('Payment received.');
    await expect(page.locator('#resultsCopy')).toContainText(`Order ${ORDER.id} is paid, but this browser doesn’t know your search.`);
    await expect(page.locator('#resultsCopy')).toContainText('namaste@surfersofindia.com');
    await expect(page.locator('#gallery figure')).toHaveCount(0);
    await expect(page.locator('#unlockButton')).toBeHidden();
    expect(api.calls.find(call => call.path === '/api/payment/verify')).toBeUndefined();
  });

  test('a failed verification keeps the order number on screen', async ({ page, api }) => {
    await page.addInitScript(value => sessionStorage.setItem('mjCheckout', value), JSON.stringify({ ...pending, orderId: 'order_other' }));
    await page.goto('/?order_id=order_other');
    await expect(page.locator('#resultsTitle')).toHaveText('Paid, but…');
    await expect(page.locator('#resultsCopy')).toContainText('Payment verification failed. Order order_other.');
    expect(api.calls.find(call => call.path === '/api/payment/verify').body.orderId).toBe('order_other');
  });
});

test.describe('30-day gallery', () => {
  test('the resume notice reopens a paid gallery from localStorage', async ({ page, api }) => {
    await page.addInitScript(value => localStorage.setItem('mjGallery', value), JSON.stringify({ searchId: SEARCH.id, token: SEARCH.galleryToken, session: { title: 'Morning glass', date: '2026-09-14', location: 'Mulki Beach' }, savedAt: Date.now() }));
    await openLanding(page);
    await expect(page.locator('#resumeNotice')).toBeVisible();
    await expect(page.locator('#resumeCopy')).toHaveText(/Welcome back\. Your photos from Morning glass · 14 Sept? 2026 are still here\./);
    await page.locator('#resumeGallery').click();
    await expect(page.locator('#results')).toBeVisible();
    await expect(page.locator('#resultsTitle')).toHaveText('9 waves. All you.');
    await expect(page.locator('#gallery figcaption a')).toHaveCount(PHOTO_IDS.length);
    expect(api.calls.find(call => call.path === '/api/searches/e2e-search-1/access').query).toEqual({ token: SEARCH.galleryToken });
  });

  test('an expired gallery token clears the notice and says so', async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('mjGallery', value), JSON.stringify({ searchId: SEARCH.id, token: 'stale-token', session: null, savedAt: Date.now() }));
    await openLanding(page);
    await page.locator('#resumeGallery').click();
    await expect(page.locator('#finderStatus')).toContainText('This gallery link has expired.');
    await expect(page.locator('#resumeNotice')).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('mjGallery'))).toBeNull();
  });
});

test.describe('mock guard', () => {
  test('an un-mocked /api request is refused with 404 and recorded — it never reaches the dev-server proxy', async ({ page, api }) => {
    await page.goto('/');
    const status = await page.evaluate(() => fetch('/api/does-not-exist?x=1').then(response => response.status));
    expect(status).toBe(404);
    expect(api.escaped).toEqual(['GET /api/does-not-exist?x=1']);
    api.escaped.length = 0;   // the fixture asserts the list is empty at teardown; this test proved the recording, so clear it
  });
});
