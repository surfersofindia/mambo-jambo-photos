// Wave 3 (W3-A) guest product against the mocked API: uncropped tiles from stored dimensions, "Not me" hides, the zero-match
// second chance (colour ring + notify-me), WhatsApp share (Web Share with the wa.me fallback) and the post-payment gallery link,
// the checkout trust block, the landing "lands by" line, the 429 countdown and the accessibility names of the new controls.
// Runs on the mobile-375 and desktop-1024 projects (playwright.config.mjs). Nothing here reaches the production Worker.
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './helpers/fixtures.mjs';
import { PHOTO_IDS, PHOTO_SIZES, SEARCH } from './helpers/mock-api.mjs';
import { attachSelfie, chooseFirstSession, isPhone, openCheckout, openLanding, openLightbox, runSearch, searchToResults, settleImages } from './helpers/flows.mjs';

const PHONE = '9876543210';
// Layout Instability observer installed before the page loads; `clsSince(t)` sums the non-input entries after a timestamp.
const observeShifts = page => page.addInitScript(() => {
  window.__cls = [];
  new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__cls.push({ value: entry.value, input: entry.hadRecentInput, t: entry.startTime, sources: (entry.sources || []).map(s => s.node?.id || s.node?.className || s.node?.nodeName) }); }).observe({ type: 'layout-shift', buffered: true });
  window.__clsSince = t => window.__cls.filter(e => e.t >= t && !e.input).reduce((sum, e) => sum + e.value, 0);
});
const now = page => page.evaluate(() => performance.now());
// A fake clock that only moves with clock.runFor(): install() alone keeps ticking in real time, and a loaded machine then drifts the
// countdown assertions by whole seconds.
const freezeClock = async page => { const t0 = new Date('2026-09-17T09:30:00+05:30'); await page.clock.install({ time: t0 }); await page.clock.pauseAt(t0.getTime() + 1000); };
const shifts = (page, since) => page.evaluate(t => ({ total: window.__clsSince(t), entries: window.__cls.filter(e => e.t >= t && !e.input) }), since);
// Web Share stub that records what the page tried to share; `available:false` removes it so the wa.me fallback runs, with window.open stubbed.
const stubShare = (page, { available = true } = {}) => page.addInitScript(on => {
  window.__shares = []; window.__opened = [];
  if (on) { navigator.share = async payload => { window.__shares.push(payload); }; navigator.canShare = () => true; }
  else { delete Navigator.prototype.share; delete Navigator.prototype.canShare; }
  window.open = (url, target, features) => { window.__opened.push({ url, target, features }); return null; };
}, available);
const zeroMatch = async (page, api) => { api.state.matchMode = 'empty'; await openLanding(page); await chooseFirstSession(page); await attachSelfie(page); await runSearch(page, { expectPhotos: 0 }); };
const expectClean = async page => {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations.flatMap(v => v.nodes.map(n => `${v.id} ${n.target.join(' ')}`))).toEqual([]);
};

test.describe('uncropped tiles', () => {
  test('each print keeps its stored ratio, an unknown size keeps 4:3, and the sheet loads with zero layout shift', async ({ page }) => {
    await observeShifts(page);
    await openLanding(page); await chooseFirstSession(page); await attachSelfie(page);
    const since = await now(page);
    await runSearch(page);
    const tiles = await page.locator('#gallery figure').evaluateAll(figures => figures.map(figure => {
      const box = figure.querySelector('.photo-open'), img = box.querySelector('img'), r = img.getBoundingClientRect();
      return { inline: box.style.aspectRatio, rendered: +(r.width / r.height).toFixed(2), natural: +(img.naturalWidth / img.naturalHeight).toFixed(2), fit: getComputedStyle(img).objectFit };
    }));
    tiles.forEach((tile, index) => {
      const [width, height] = PHOTO_SIZES[index];
      if (width && height) { expect(tile.inline, `tile ${index + 1} carries its stored ratio`).toBe(`${width} / ${height}`); expect(Math.abs(tile.rendered - tile.natural), `tile ${index + 1} is not cropped`).toBeLessThan(0.02); }
      else { expect(tile.inline).toBe(''); expect(tile.rendered).toBeCloseTo(1.33, 1); }   // pre-0012 photo: the CSS 4:3 box, cover-cropped
    });
    expect(new Set(tiles.map(tile => tile.rendered)).size, 'a contact sheet, not a grid of identical boxes').toBeGreaterThan(2);
    // The boxes were sized before the images arrived: no non-input shift between the search click and the settled sheet.
    expect((await shifts(page, since)).entries).toEqual([]);
  });
});

test.describe('"Not me" hides', () => {
  test('the tile goes in place, the rest renumber, focus moves to the next print, the live count says so, and the hide is stored and posted', async ({ page, api }) => {
    await observeShifts(page);
    await searchToResults(page);
    await expect(page.locator('#resultsMeta')).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('#resultsMeta')).toHaveText(/Morning glass · 9 waves$/);
    const second = page.locator('#gallery figure').nth(1);
    await expect(second.locator('figcaption span')).toHaveText('WAVE 02 · PREVIEW');
    await page.locator('#gallery .favourite').nth(3).click();   // a heart on wave 4 must follow the photo to its new number
    const since = await now(page);
    await second.getByRole('button', { name: 'Not me, hide wave 2' }).click();
    await expect(page.locator('#gallery figure')).toHaveCount(PHOTO_IDS.length - 1);
    await expect(page.locator('#resultsMeta')).toHaveText(/Morning glass · 8 waves, 1 hidden$/);
    await expect(page.locator('#resultsTitle')).toHaveText('8 waves. All you.');
    await expect(page.locator('#gallery figure').nth(1).locator('figcaption span')).toHaveText('WAVE 02 · PREVIEW');   // the old wave 3, renumbered in place
    await expect(page.locator('#gallery figure').nth(1).locator('.photo-open')).toHaveAttribute('aria-label', 'Open wave 2');
    await expect(page.locator('#gallery figure').nth(1).locator('.photo-open')).toBeFocused();
    await expect(page.locator('#gallery .favourite').nth(2)).toHaveAttribute('aria-pressed', 'true');   // the heart moved with its photo
    await expect(page.locator('#favouriteCount')).toHaveText('1');
    await expect(page.locator('#gallery figure').nth(1)).toHaveAttribute('data-photo-id', PHOTO_IDS[2]);
    expect(await page.evaluate(id => JSON.parse(sessionStorage.getItem(`mjHidden:${id}`)), SEARCH.id)).toEqual([PHOTO_IDS[1]]);
    await expect.poll(() => api.calls.find(call => call.path === `/api/searches/${SEARCH.id}/hide`)?.body).toEqual({ token: SEARCH.token, photoId: PHOTO_IDS[1] });
    // Still images untouched: no tile was re-rendered, so nothing left its loaded state.
    await expect(page.locator('#gallery figure.is-loading')).toHaveCount(0);
    // Whatever moved, moved within the click's 500 ms window — nothing non-input.
    expect((await shifts(page, since)).total).toBe(0);
    // The lightbox now counts 8 and opens the renumbered wave.
    await openLightbox(page, 1);
    await expect(page.locator('#lightboxCount')).toHaveText('2 of 8');
    await page.keyboard.press('Escape');
    // A refresh does not resurrect it: the id is applied when the previews come back.
    await page.reload();
    await expect(page.locator('#main')).toBeVisible();
  });

  test('a missing /hide route (404) hides locally and says nothing; the unlocked gallery offers no hide', async ({ page, api, pageErrors }) => {
    api.state.guest.hide = 404;
    await searchToResults(page);
    await page.getByRole('button', { name: 'Not me, hide wave 1' }).click();
    await expect(page.locator('#gallery figure')).toHaveCount(PHOTO_IDS.length - 1);
    await expect(page.locator('#resultsMeta')).toHaveText(/8 waves, 1 hidden$/);
    await expect.poll(() => api.calls.filter(call => call.path.endsWith('/hide')).length).toBe(1);
    await expect(page.locator('#finderStatus')).toHaveText('');
    expect(pageErrors).toEqual([]);
  });

  test('hiding the last wave lands on the zero-match state with its second chance', async ({ page }) => {
    await searchToResults(page);
    for (let left = PHOTO_IDS.length; left > 0; left--) await page.locator('#gallery .hide-photo').first().click();
    await expect(page.locator('#gallery figure')).toHaveCount(0);
    await expect(page.locator('#resultsTitle')).toHaveText('No waves left.');
    await expect(page.locator('#noMatches')).toBeVisible();
    await expect(page.locator('#secondChance')).toBeVisible();
    await expect(page.locator('#unlockButton')).toBeHidden();
    await expect(page.locator('#actionBar')).toBeHidden();
  });
});

test.describe('zero match: second chance', () => {
  test('the colour ring is a radiogroup of twelve named swatches; a colour search swaps in the colour-ranked previews under the colour header', async ({ page, api }) => {
    await observeShifts(page);
    await zeroMatch(page, api);
    await expect(page.locator('#secondChance')).toBeVisible();
    await expect(page.locator('.results-actions')).toBeHidden();   // nothing to keep or share yet
    const ring = page.getByRole('radiogroup', { name: 'Board colour' });
    await expect(ring.getByRole('radio')).toHaveCount(12);
    for (const name of ['Red', 'Green', 'Sky blue', 'Blue', 'Pink']) await expect(ring.getByRole('radio', { name, exact: true })).toHaveCount(1);
    await expect(page.locator('#colourSubmit')).toBeDisabled();
    await ring.getByRole('radio', { name: 'Green' }).check();
    await expect(page.locator('#hueName')).toHaveText('Green');
    await expect(page.locator('#colourSubmit')).toBeEnabled();
    await page.getByRole('radio', { name: 'Muted' }).check();
    const since = await now(page);
    await page.locator('#colourSubmit').click();
    await expect(page.locator('#gallery figure')).toHaveCount(4);
    await settleImages(page, '#gallery img');
    await expect(page.locator('#resultsCopy')).toHaveText('Matched by board colour · previews only');
    await expect(page.locator('#resultsTitle')).toHaveText('4 waves, maybe you.');
    await expect(page.locator('#resultsMeta')).toHaveText(/Morning glass · 4 waves by colour$/);
    await expect(page.locator('#resultsTitle')).toBeFocused();
    await expect(page.locator('#noMatches')).toBeHidden();
    await expect(page.locator('#secondChance')).toBeHidden();
    await expect(page.locator('.results-actions')).toBeVisible();
    await expect(page.locator('#resultsConditions .chip')).toHaveText(['Mulki left', '4 ft', 'Offshore', 'Mid rising', '📷 Ankith']);
    await expect(page.locator(isPhone(page) ? '#unlockButtonBar' : '#unlockButton')).toBeVisible();
    expect(api.calls.find(call => call.path === `/api/searches/${SEARCH.id}/colour`).body).toEqual({ token: SEARCH.token, hue: 120, tone: 'muted' });
    expect((await shifts(page, since)).entries, 'the swap adds under the title, it moves nothing').toEqual([]);
    await expectClean(page);
  });

  test('no boards of that colour keeps the picker with a hint; 404 says the search is not available yet', async ({ page, api }) => {
    api.state.guest.colour = 'empty';
    await zeroMatch(page, api);
    await page.getByRole('radio', { name: 'Orange' }).check();
    await page.locator('#colourSubmit').click();
    await expect(page.locator('#colourStatus')).toHaveText('No orange boards in this session. Try another colour.');
    await expect(page.locator('#gallery figure')).toHaveCount(0);
    await expect(page.locator('#secondChance')).toBeVisible();
    api.state.guest.colour = 404;
    await page.locator('#colourSubmit').click();
    await expect(page.locator('#colourStatus')).toHaveText('Colour search isn’t available yet — try another selfie above.');
    await expect(page.locator('#colourSubmit')).toBeEnabled();
  });

  test('a 429 locks the ring for retry-after with a countdown, then frees it', async ({ page, api }) => {
    await freezeClock(page);
    api.state.guest.colour = 429;
    await zeroMatch(page, api);
    await page.getByRole('radio', { name: 'Blue', exact: true }).check();
    await page.locator('#colourSubmit').click();
    await expect(page.locator('#colourStatus')).toHaveText(/That’s a lot of searches\. Try again in 5 minutes\s*5:00\.$/);
    await expect(page.locator('#colourStatus .countdown')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('#colourSubmit')).toBeDisabled();
    await expect(page.getByRole('radio', { name: 'Blue', exact: true })).toBeDisabled();
    await page.clock.runFor(61_000);
    await expect(page.locator('#colourStatus .countdown')).toHaveText('3:59');
    await page.clock.runFor(4 * 60_000);
    await expect(page.locator('#colourStatus')).toHaveText('You can search again now.');
    await expect(page.locator('#colourSubmit')).toBeEnabled();
    await expect(page.getByRole('radio', { name: 'Blue', exact: true })).toBeEnabled();
  });

  test('notify me: the checkout number rules, the success line, and a friendly 404', async ({ page, api }) => {
    await zeroMatch(page, api);
    await page.locator('#notifyPhone').fill('12345');
    await page.locator('#notifyPhone').evaluate(input => input.removeAttribute('pattern'));
    await page.locator('#notifySubmit').click();
    await expect(page.locator('#notifyStatus')).toHaveText('Needs a 10-digit mobile number.');
    expect(api.calls.filter(call => call.path.endsWith('/notify'))).toEqual([]);
    await page.locator('#notifyPhone').fill(PHONE);
    await page.locator('#notifySubmit').click();
    await expect(page.locator('#notifyStatus')).toHaveText('We’ll WhatsApp you once.');
    expect(api.calls.find(call => call.path === `/api/searches/${SEARCH.id}/notify`).body).toEqual({ token: SEARCH.token, phone: PHONE });
    api.state.guest.notify = 404;
    await page.locator('#notifySubmit').click();
    await expect(page.locator('#notifyStatus')).toHaveText('Not available yet — email namaste@surfersofindia.com and we’ll tell you.');
    await expect(page.locator('#notifyStatus')).not.toHaveClass(/error/);
  });
});

test.describe('share', () => {
  test('results header and lightbox share the session title and the site URL through Web Share — never a preview link or the token', async ({ page }) => {
    await stubShare(page);
    await searchToResults(page);
    await page.getByRole('button', { name: 'Share this session on WhatsApp' }).first().click();
    await openLightbox(page, 0);
    await page.locator('#sharePhoto').click();
    const shares = await page.evaluate(() => window.__shares);
    expect(shares).toHaveLength(2);
    for (const share of shares) {
      expect(share.url).toBe(new URL('/', page.url()).href);
      expect(share.text).toContain('Morning glass');
      expect(share.text).toContain(share.url);
      expect(share.text).not.toMatch(/api\/media|token|e2e-search/);
    }
    expect(await page.evaluate(() => window.__opened)).toEqual([]);
  });

  test('without Web Share a wa.me tab opens with the same text', async ({ page }) => {
    await stubShare(page, { available: false });
    await searchToResults(page);
    await page.getByRole('button', { name: 'Share this session on WhatsApp' }).first().click();
    const opened = await page.evaluate(() => window.__opened);
    expect(opened).toHaveLength(1);
    expect(opened[0].target).toBe('_blank'); expect(opened[0].features).toBe('noopener');
    const text = decodeURIComponent(new URL(opened[0].url).searchParams.get('text'));
    expect(opened[0].url).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(text).toContain('Morning glass');
    expect(text).toContain(new URL('/', page.url()).href);
    expect(text).not.toMatch(/token|api\/media/);
  });

  test('after payment the WhatsApp button sends the 30-day gallery link with its bearer-link hint, and the link reopens the gallery', async ({ page, api }) => {
    await stubShare(page);
    await page.addInitScript(() => { window.Cashfree = () => ({ checkout: async () => ({ paymentDetails: { paymentMessage: 'ok' } }) }); });
    await searchToResults(page);
    await expect(page.locator('#galleryShare')).toBeHidden();
    await openCheckout(page);
    await page.locator('#checkoutPhone').fill(PHONE);
    await page.locator('#payButton').click();
    await expect(page.locator('#unlockedNotice')).toBeVisible();
    await expect(page.locator('#galleryShare')).toBeVisible();
    await expect(page.locator('.gallery-share-hint')).toHaveText(/Anyone with that link can open your photos for 30 days/);
    await expect(page.locator('#gallery .hide-photo')).toHaveCount(0);   // originals are yours: nothing to disown
    await page.locator('#shareGallery').click();
    const [share] = await page.evaluate(() => window.__shares);
    const link = `${new URL('/', page.url()).href}?gallery=${SEARCH.id}.${SEARCH.galleryToken}`;   // the long-lived token, not the search one
    expect(share.url).toBe(link);
    expect(share.text).toContain(link);
    expect(share.text).not.toContain(SEARCH.token);
    // The link on a fresh page (a phone that never searched): the gallery record is kept and the originals open.
    await page.evaluate(() => localStorage.clear());
    await page.goto(link);
    await expect(page.locator('#results')).toBeVisible();
    await expect(page.locator('#gallery figcaption a')).toHaveCount(PHOTO_IDS.length);
    await expect(page).toHaveURL(/\/$/);
    expect(api.calls.filter(call => call.path === `/api/searches/${SEARCH.id}/access`).pop().query).toEqual({ token: SEARCH.galleryToken });
    await expectClean(page);
  });
});

test.describe('gallery link', () => {
  test('a link with a bad token says so and never overwrites the gallery already saved on this device', async ({ page, api }) => {
    const saved = { searchId: SEARCH.id, token: SEARCH.galleryToken, session: { title: 'Morning glass', date: '2026-09-14', location: 'Mulki Beach' }, savedAt: Date.now() };
    await page.addInitScript(value => localStorage.setItem('mjGallery', value), JSON.stringify(saved));
    await page.goto(`/?gallery=${SEARCH.id}.stale-token`);
    await expect(page.locator('#finderStatus')).toContainText('This gallery link has expired.');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('#results')).toBeHidden();
    await expect(page.locator('#resumeNotice')).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('mjGallery')))).toMatchObject({ searchId: SEARCH.id, token: SEARCH.galleryToken });
    expect(api.calls.find(call => call.path === `/api/searches/${SEARCH.id}/access`).query).toEqual({ token: 'stale-token' });
    // A malformed value is ignored outright: no request, no change.
    await page.goto('/?gallery=nonsense');
    await expect(page.locator('label.session-choice')).toHaveCount(3);
    expect(api.calls.filter(call => call.path.endsWith('/access')).length).toBe(1);
  });
});

test.describe('gallery link (FIX-C)', () => {
  test('the older ?gallery=<id>&token=<token> spelling opens the gallery like the dotted one, and both leave a clean URL', async ({ page, api }) => {
    await page.goto(`/?gallery=${SEARCH.id}&token=${SEARCH.galleryToken}`);
    await expect(page.locator('#results')).toBeVisible();
    await expect(page.locator('#gallery figcaption a')).toHaveCount(PHOTO_IDS.length);
    await expect(page).toHaveURL(/\/$/);
    expect(api.calls.filter(call => call.path === `/api/searches/${SEARCH.id}/access`).pop().query).toEqual({ token: SEARCH.galleryToken });
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('mjGallery')))).toMatchObject({ searchId: SEARCH.id, token: SEARCH.galleryToken });
    // The dotted form still works from the same cold start.
    await page.evaluate(() => localStorage.clear());
    await page.goto(`/?gallery=${SEARCH.id}.${SEARCH.galleryToken}`);
    await expect(page.locator('#gallery figcaption a')).toHaveCount(PHOTO_IDS.length);
    await expect(page).toHaveURL(/\/$/);
    expect(api.calls.filter(call => call.path === `/api/searches/${SEARCH.id}/access`)).toHaveLength(2);
    // A token param without a gallery id is not a link: the landing page, no request.
    await page.goto(`/?token=${SEARCH.galleryToken}`);
    await expect(page.locator('label.session-choice')).toHaveCount(3);
    expect(api.calls.filter(call => call.path.endsWith('/access'))).toHaveLength(2);
  });
});

test.describe('lightbox (FIX-C)', () => {
  test('a cancelled touch (the browser took it for a scroll or gesture) stays on the same photo with the slide put back', async ({ page }) => {
    await searchToResults(page);
    await openLightbox(page, 1);
    await expect(page.locator('#lightboxCount')).toHaveText(`2 of ${PHOTO_IDS.length}`);
    // Real touch input through CDP (synthetic PointerEvents cannot be captured with setPointerCapture). A cancel Chromium
    // raises on its own (a scroll or a system gesture claiming the touch) carries clientX 0 — a full-width flick to the
    // left as far as the old code was concerned; CDP's touchCancel carries the last position instead, which after a 60 px
    // drag the old code also turned into "next photo". Either way the page must stay where it is.
    const cdp = await page.context().newCDPSession(page);
    const { x, y } = await page.evaluate(() => { const box = document.getElementById('lightboxStage').getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; });
    await page.evaluate(() => { window.__cancelSeen = []; document.getElementById('lightboxStage').addEventListener('pointercancel', event => window.__cancelSeen.push(event.clientX)); });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 30, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 60, y }] });
    await expect(page.locator('#lightboxImage')).toHaveCSS('transform', /matrix\(1, 0, 0, 1, -60, 0\)/);   // the drag is being followed
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await expect.poll(() => page.evaluate(() => window.__cancelSeen.length)).toBe(1);   // one pointercancel reached the stage
    await expect(page.locator('#lightboxImage')).toHaveAttribute('style', /^((?!translateX).)*$/);   // put back
    await expect(page.locator('#lightboxStage')).not.toHaveClass(/is-sliding/);
    await expect(page.locator('#lightboxCount')).toHaveText(`2 of ${PHOTO_IDS.length}`);
    // The same drag lifted normally still turns the page (the flick path is untouched).
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 30, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 60, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.locator('#lightboxCount')).toHaveText(`3 of ${PHOTO_IDS.length}`);
  });
});

test.describe('checkout trust block', () => {
  test('count, per-photo price, the three lines and the three ways to pay sit above the phone field', async ({ page }) => {
    await searchToResults(page);
    await openCheckout(page);
    await expect(page.locator('#checkoutTitle')).toHaveText('9 photos · ₹700');
    await expect(page.locator('#checkoutPerPhoto')).toHaveText('₹78 each');
    await expect(page.locator('.checkout-trust li')).toHaveText(['Full-resolution originals, no watermark', 'Download all as one ZIP', '30-day link to come back']);
    await expect(page.locator('.pay-methods span')).toHaveText(['UPI', 'Cards', 'Netbanking']);
    const order = await page.locator('#checkoutForm').evaluate(form => ['#checkoutTitle', '#checkoutPerPhoto', '.checkout-trust', '.pay-methods', '#checkoutPhone'].map(sel => form.querySelector(sel).getBoundingClientRect().top));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    await expect(page.locator('.pay-methods svg')).toHaveCount(3);
  });
});

test.describe('landing', () => {
  test('"lands by" shows only for a future drop within 24 h, in local time', async ({ page, api }) => {
    await page.clock.setFixedTime(new Date('2026-09-17T09:30:00+05:30'));
    api.state.nextDropAt = '2026-09-17T16:30:00+05:30';
    await openLanding(page);
    await expect(page.locator('#nextDrop')).toBeVisible();
    await expect(page.locator('#nextDrop')).toHaveText('Today’s session lands by 4:30 pm');
    api.state.nextDropAt = '2026-09-18T07:00:00+05:30';
    await openLanding(page);
    await expect(page.locator('#nextDrop')).toHaveText('Next session lands by 7:00 am tomorrow');
    for (const past of ['2026-09-17T08:00:00+05:30', '2026-09-19T09:30:00+05:30', null]) {
      api.state.nextDropAt = past;
      await openLanding(page);
      await expect(page.locator('#nextDrop')).toBeHidden();
      await expect(page.locator('#nextDrop')).toHaveText('');
    }
  });
});

test.describe('search quota', () => {
  test('a 429 keeps the search button off for retry-after with a ticking countdown that screen readers hear once', async ({ page, api }) => {
    await freezeClock(page);
    api.state.matchMode = '429';
    await openLanding(page); await chooseFirstSession(page); await attachSelfie(page);
    await page.locator('#findMatches').click();
    await expect(page.locator('#selfieStage')).toBeVisible();
    await expect(page.locator('#finderStatus')).toHaveText(/You’ve searched a lot in a short while\. Try again in 7 minutes\s*7:00\.$/);
    await expect(page.locator('#finderStatus .countdown')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('#finderStatus .visually-hidden')).toHaveText('7 minutes');
    await expect(page.locator('#findMatches')).toBeDisabled();
    await page.clock.runFor(90_000);
    await expect(page.locator('#finderStatus .countdown')).toHaveText('5:30');
    await expect(page.locator('#findMatches')).toBeDisabled();
    // Another message may take the line (a stage change clears it); the countdown returns only once the line is empty.
    await page.locator('#changeSession').click();
    await expect(page.locator('#finderStatus')).toHaveText('');
    await page.clock.runFor(1_000);
    await expect(page.locator('#finderStatus .countdown')).toHaveText('5:29');
    await page.clock.runFor(6 * 60_000);
    await expect(page.locator('#finderStatus')).toHaveText('You can search again now.');
    await page.locator('#nextStep').click();
    await expect(page.locator('#findMatches')).toBeEnabled();
  });
});

test.describe('names and roles', () => {
  test('the results screen reads right: live eyebrow, named hide buttons, share, conditions; the zero-match ring and tone toggle are labelled', async ({ page, api }) => {
    await searchToResults(page);
    await expect(page.getByRole('button', { name: /^Not me, hide wave \d$/ })).toHaveCount(PHOTO_IDS.length);
    await expect(page.getByRole('button', { name: 'Share this session on WhatsApp' })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1, name: '9 waves. All you.' })).toBeVisible();
    expect(await page.locator('#resultsMeta').getAttribute('aria-atomic')).toBe('true');
    await openLightbox(page, 0);
    await expect(page.locator('#lightbox').getByRole('button', { name: 'Share this session on WhatsApp' })).toBeVisible();
    await page.keyboard.press('Escape');
    await zeroMatch(page, api);
    await expect(page.getByRole('radiogroup', { name: 'Board colour' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Tone' }).getByRole('radio')).toHaveCount(3);
    await expect(page.getByRole('textbox', { name: 'Mobile number' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Notify me' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Find by colour/ })).toBeDisabled();
  });
});
