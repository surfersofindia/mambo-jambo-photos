# W2-D · Admin details — handoff

Agent W2-D, wave 2 (resumed run). Dev port 4183. Everything crew-side was exercised against a **mocked API** (Playwright `page.route('**/api/**')`, unmatched paths answered 404 so nothing can reach the production Worker). No production write, no `POST /api/admin/login`, no `zz-test-*` session. "Verified" below always names the command, test or screenshot; otherwise it says "not verified".

## Summary

- **Inherited (predecessor, first wave-2 launch — kept and finished, not restarted):** in `admin.js` the pure helpers `formatMoneyStrip`, `mergeSessionStats` and `reviewShortcut` (Y/N/S/Z), the money strip (`fetchSessionStats` runs in parallel with `/api/admin/dashboard`; `paintMoneyStrips` fills `<p class="d-card-money">` on each card once the stats land, guarded by a render counter so a stale answer never paints over a newer list), `revokeToken()` (fire-and-forget `POST /api/admin/logout` with `keepalive`) wired into the **Sign out** click and the **idle sign-out**, `apiRequest` now attaching `status` to thrown errors, the whole undo block (`rememberReview` / `forgetReview` / `restoreReviewCard` / `undoLastReview`), `showLogin()` forgetting the undo memory, and `Z` in the review keydown handler. In `admin.html` (body) the `#undoReviewBtn` toolbar button and the `<kbd>Z</kbd> undo` hint. In `admin-theme.css` the `.d-card-money` strip (tabular figures, muted state), `#undoReviewBtn kbd`, and the local `--soi-coral-ink:#8F4D5B` for the draft chip (5.14:1). Plus the four `-before` screenshots and the mock harness `run-shots.mjs` in the scratchpad.
- **Git note:** the concurrent non-program session committed the whole working tree as `5335e0f` at 17:31 (which swept up the predecessor's hunks) and then ran `git reset HEAD~1`, so `git diff HEAD` on my files now shows W1-C's, the predecessor's and that session's hunks together (its review-queue session dividers and burst auto-approve copy live in the same regions). I touched none of theirs. **My own edits this run** are three hunks in `admin.js` (below) and the appended tests.
- **Finished this run:** (1) the undo memory now lapses on its own after the Worker's 10-minute window (`UNDO_WINDOW_MS`; a newer decision restarts the clock), so the toolbar button is disabled when there is truly nothing to undo instead of earning a 409; (2) a successful undo and a 409/404 now go through `forgetReview()` so the expiry timer is cleared with the memory (found by the new unit test); (3) five unit tests covering the money strip, the review keys, the undo flow (success, reload race, 409/404, dropped connection, expiry) and the logout call; (4) the `-after` screenshots at 1024 and 375 for the sessions tab (strip with 12 searches / 3 unlocks / ₹2,100 next to a "No searches yet" card, and the hidden state on a 404), the review toolbar with Undo (disabled, then armed after a Same), the "Undone." toast and the 409 toast; (5) browser probes proving the stats call never delays the cards and that both sign-out paths call logout before dropping the token, with a 404 staying silent.
- Contract with W2-C followed exactly: `GET /api/admin/stats` merged by `sessionId`, hidden on failure / `unmigrated`, "No searches yet" muted at zero searches; `POST /api/admin/undo-review { kind: 'pair' | 'link', id }`, 409/404 → server message toasted and the memory cleared. **Not verified against the real Worker** (the routes do not exist on the deployed Worker yet; W2-C builds them in parallel).

## Files changed

- `admin.js` — this run: `UNDO_WINDOW_MS` + `undoExpiry` timer in `rememberReview` / `forgetReview` (the "Review: undo" block), and `forgetReview()` instead of `lastReview = null` on the success and 409/404 paths of `undoLastReview`. Inherited from the predecessor (kept): helpers block additions, `apiRequest` error `status`, `revokeToken` + sign-out/idle wiring, `fetchSessionStats` / `paintMoneyStrips` / `dashboardRender`, the `.d-card-money` line in the card template, `rememberReview(...)` calls in both confirm handlers, the Z branch of the keydown handler, `forgetReview()` in `showLogin()`, and the undo block itself.
- `admin.html` — **body only**, no edits this run; the predecessor added `#undoReviewBtn` in the Review toolbar (after Refresh, before Retrain scoring) and the `<kbd>Z</kbd> undo` hint. `<head>` untouched (W2-A's).
- `admin-theme.css` — no edits this run; inherited `.d-card-money{…}` rules, `#undoReviewBtn kbd`, `--soi-coral-ink` and `.d-card-status.draft{color:var(--soi-coral-ink)}`.
- `tests/review-images.test.mjs` — five tests appended under a `W2-D` banner (nothing above it changed). This file is where W1-C put the admin unit tests; I did not create a new test file.
- `docs/audit/handoff/W2-D.md` (this file) and `docs/audit/handoff/shots/W2-D/*.png`.

Nothing else was edited. No `package.json`, no `worker.js`, no `soi-tokens.css`, no `dist/`.

## Tasks done (by id)

- **F30 (client half)** — `Z` and the 44 px **Undo** toolbar button call `POST /api/admin/undo-review { kind, id }` for the last confirmed/rejected face pair or kit link, put the card back at the top of its queue with its buttons re-enabled and focus on it, fix the To review / Same / Different counters, and toast "Undone.". 409/404 toast the server's line and clear the memory; a dropped connection keeps it for another Z; `Z` is ignored while typing, in a dialog, on other tabs or with a modifier; the memory lapses after 10 minutes and on sign-out. Deviation from the reconstructed spec: the body is `{ kind, id }` per the wave-2 contract, not `{ faceId }`.
- **Money strip** — `GET /api/admin/stats` fetched once per dashboard load (in parallel with `/api/admin/dashboard`, also on each 8-second silent poll while indexing), merged by `sessionId`, rendered as "12 searches · 3 unlocks · ₹2,100" (`en-IN` grouping, `lining-nums tabular-nums`, the fuller breakdown in the strip's `title`), "No searches yet" muted at zero searches, hidden entirely on 404 / any failure / `unmigrated`. Never blocks the cards (measured below).
- **Carried request from W1-A** — `POST /api/admin/logout` (bearer token, `keepalive: true`, fire-and-forget) on the Sign out click and the idle sign-out, before `clearToken()` / `showLogin()`; a 404 from the not-yet-deployed Worker is silent.
- **Contrast token note** — `--soi-slate-ink` / `--soi-ochre-ink` / `--soi-coral-ink` stay defined locally in `admin-theme.css`; `soi-tokens.css` still has no `-ink` tokens and `--soi-coral-deep` is still `#9A5563` there, so I did not switch the draft chip to `var(--soi-coral-deep, …)` — the local `--soi-coral-ink:#8F4D5B` gives 5.14:1 today regardless of W2-A's timing.

## Tests added (names)

All in `tests/review-images.test.mjs` (W2-D section at the end):

1. `the money strip reads "12 searches · 3 unlocks · ₹2,100" with Indian grouping, mutes to "No searches yet", and hides when the stats are untrustworthy` — `formatMoneyStrip` (plurals, lakh grouping, junk input, missing row), `mergeSessionStats` (404 body / `unmigrated` / junk → `null`; empty list trusted), and `paintMoneyStrips` against fake cards (fills, mutes, hides).
2. `review keys: Y / N / S / Z map to their actions only on the Review tab, with no dialog, no modifier and nobody typing` — `reviewShortcut` plus a source check that the keydown handler gates Z on the toolbar button being enabled and treats INPUT/TEXTAREA/SELECT/contentEditable as typing.
3. `Z / Undo puts the last Same or Different back at the top of its queue, focused and reviewable, fixes the counters and toasts "Undone."` — the undo block run in a `vm` context against a two-queue fake DOM: request body, re-insertion at the top, buttons re-enabled, focus, counters, one-undo-per-decision, the link queue replacing its "Batch done" message, and the last-card-of-a-batch race (a reload in flight is awaited and its copy of the card wins, counters untouched).
4. `undo forgets the decision on a 409 or 404 (toasting the server line), keeps it on a dropped connection, and lets it lapse after ten minutes` — this one caught the stale expiry timer on the success/409 paths.
5. `signing out — by the button or the idle clock — revokes the crew token on the Worker before dropping it, and a missing route stays silent` — `revokeToken` with a fake `fetch` (URL, method, bearer header, `keepalive`; rejection swallowed; no token → no call; `isLive` false → no call) plus source checks that both sign-out paths run `revokeToken(); clearToken(); showLogin();` and that `showLogin` forgets the undo memory.

Final run: `npm run check` clean; `npm test` → `tests 106, pass 106, fail 0` at 17:39 (was 101 at relaunch). A re-run at 17:46 showed **3 failures in `tests/worker.test.mjs`** (webhook 500, `migrations` now reporting `events`/`photoDimensions`) — `worker.js` had been modified at 17:45:37 by W2-C's concurrent edit and its test file not yet updated; `node --test tests/review-images.test.mjs tests/site.test.mjs tests/indexing.test.mjs` stays 49/49. Not caused by, and not fixable from, this workstream. W2-C updated its test file at 17:47 and the **final run at 17:48:40 is green: `npm run check` ok, `npm test` → `tests 108, pass 108, fail 0`** (the two extra tests are W2-C's).

## How to verify (commands and my port)

```sh
cd "/Users/ankithkotian/Documents/mambo jambo photos website"
npm run check && npm test
node --test tests/review-images.test.mjs          # the 16 admin tests alone (11 W1-C + 5 W2-D)
PORT=4183 npm run dev                              # (a server from the first launch, PID 52913, was still up and was reused; I did not restart or kill it)
```

Browser flows, all mocked (`S=/private/tmp/claude-501/-Users-ankithkotian-Documents-mambo-jambo-photos-website/7bb4db07-8310-4483-95f0-d75808750f63/scratchpad/W2-D`, session-specific scratchpad; needs the shared Playwright in `../shots/`):

```sh
node $S/run-shots.mjs --port 4183 --mode sessions --width 1024 --height 768 --tag after [--stats ok|404|unmigrated|slow] [--scroll .d-card]
node $S/run-shots.mjs --port 4183 --mode review|armed|undo|undo-409 --width 375 --height 812 --tag after [--scrollTop 1]
node $S/probe-nonblocking.mjs     # stats answer 1.5 s late: cards at ~170 ms, strip fills at ~1.6 s
node $S/probe-signout.mjs         # Sign out click, idle sign-out (page.clock 30 min), and a 404 from /api/admin/logout
```

Each run prints a JSON probe (strip text/hidden/title/computed `font-variant-numeric`, Undo button `disabled`/size, toast text/kind/role, card order, `activeElement`, counters, every intercepted API call, page errors). Never point these at production — every `/api/**` request is intercepted and unmatched ones get a 404.

### Measured (mock runs)

- Sessions tab, stats `ok`: `sess-morning` → "12 searches · 3 unlocks · ₹2,100", title "9 matched · 3 no match (25%) · 4 checkouts · 5 downloads", `font-variant-numeric: lining-nums tabular-nums`, 12 px, #2B2018 on #F2ECDB (13.46:1); `sess-dawn` → "No searches yet", `.is-muted`, #5C4F43 on #F2ECDB (6.70:1). Draft chip #8F4D5B on #F5E6E8 (5.14:1). API calls: `GET /api/admin/stats` and `GET /api/admin/dashboard` issued together. Same at 375×812. No page errors.
- Stats `404` → both strips `hidden: true` (only console line is the browser's own 404 notice); `unmigrated` → both hidden, no errors; `slow` (1.5 s) → cards visible **167 ms** after the tab click with the strip still hidden, strip filled at **1 595 ms** — the dashboard never waited.
- Review tab: Undo button 88×**44** px, `disabled` with nothing to undo; after **Same** on `pair-1`: enabled, To review 2→1, Same 14→15, first card `pair-2`. After **Z**: `POST /api/admin/undo-review {"kind":"pair","id":"pair-1"}`, card order `[pair-1, pair-2]`, `document.activeElement` = `verify-card-pair-1`, `.is-active` on it, all its buttons enabled, counters back to 2 / 14, toast "Undone." (`data-kind=success`, `role=status`), Undo disabled again. Same at 375×812.
- 409 mode: toast "Too late to undo — that decision is older than 10 minutes." (`role=alert`), nothing re-inserted (queue stays `[pair-2]`, counters 1 / 15), Undo disabled.
- Sign out: `POST /api/admin/logout auth=Bearer mock-token-abc` is the only call after the click, token gone, login screen shown, no toast, no page error; with the route answering 404: identical, silent. Idle: after 30 fake minutes (`page.clock.runFor`) the same POST fires, then the login screen shows "Signed out — you'd gone quiet for 30 min.".

## Screenshots and traces (paths)

`docs/audit/handoff/shots/W2-D/` (1024×768 and 375×812; `-before` = first-launch baseline, `-after` = this branch):

- `sessions-{1024,375}-before.png`, `sessions-{1024,375}-after.png` — Sessions tab, top of page (identical framing to the baseline; the strip is below the fold at 375)
- `sessions-strip-{1024,375}-after.png` — scrolled to the cards: "12 searches · 3 unlocks · ₹2,100" and the muted "No searches yet"
- `sessions-nostats-1024-after.png` — same cards with `/api/admin/stats` answering 404: strips hidden, nothing else moves
- `review-{1024,375}-before.png`, `review-{1024,375}-after.png` — Review tab with the toolbar; Undo disabled (nothing to undo)
- `undo-armed-{1024,375}-after.png` — after a Same: Undo enabled, counters 1 / 15
- `undo-toast-{1024,375}-after.png` — after Z: card back at the top, counters 2 / 14, "Undone." toast, Undo disabled
- `undo-409-{1024,375}-after.png` — the Worker refusing: error toast with the server's line

Probe JSON for every screenshot is in `$S/out/*.json`; no traces (no performance work in this stream).

## Deploy or dashboard actions needed

- None of mine. The client degrades on the current production Worker: `GET /api/admin/stats` 404 → strips hidden; `POST /api/admin/logout` 404 → silent; `POST /api/admin/undo-review` 404 → "Not found"-style toast from the server body and the memory clears. Deploy `admin.js`/`admin.html`/`admin-theme.css` together with W2-C's Worker for the strip and undo to become live; deploying the studio first is harmless.
- `preview-worker.js` note from W1-C still applies (ship it with `admin.js`).

## Requests to other owners (file, exact change, why)

1. **W2-C · `worker.js`** — none required; two notes. (a) The studio re-fetches `/api/admin/stats` on every 8-second silent dashboard poll while a session is indexing (once per load, as the contract says) — if the stats query is heavy, consider a short `cache-control: private, max-age=30` or a cheap path when nothing changed. (b) On 409/404 the client toasts `body.error` verbatim; keep those messages crew-readable ("Too late to undo — that decision is older than 10 minutes." reads well).
2. **W2-A · `soi-tokens.css`** — unchanged request from W1-C: add `--soi-slate-ink:#43617A`, `--soi-ochre-ink:#7A5F30` (and optionally `--soi-coral-ink:#8F4D5B`) next to the `-deep` tokens. `admin-theme.css` line 17 keeps its local copies until then; delete that line once the tokens exist. I did not repoint the draft chip at `--soi-coral-deep` because that token is `#9A5563` today and is used by public headings/chips.
3. **W2-B · `tests/e2e/`** — `$S/run-shots.mjs` (mocks + probes for sessions / review / armed / undo / undo-409) and `$S/probe-signout.mjs` (`page.clock` idle sign-out) can be lifted into `@playwright/test` specs; the mock bodies there match the W2-C contract shapes.
4. **Lead · `README.md`** — one line under "Crew flow": the Review tab's `Z` / Undo puts the last Same / Different back within 10 minutes (`POST /api/admin/undo-review`), and session cards show searches · unlocks · rupees from `GET /api/admin/stats` once that route is deployed.

## Cut or blocked (with reason)

- **Not verified against the real Worker:** `/api/admin/stats`, `/api/admin/undo-review` and `/api/admin/logout` do not exist on the deployed Worker (W2-C builds the first two in parallel; W1-A's logout is not deployed). Everything above is mock-verified against the contract shapes in my brief; the response of the real endpoints (field names, 409 wording, `unmigrated`) should be checked once after W2-C lands: `node $S/run-shots.mjs` only needs the mock bodies updated if the shapes drift.
- **Not verified:** the undo of a *link* card in the browser (the mock link queue's single card is a burst link and the concurrent session now auto-approves bursts; the unit test covers the link path against the fake DOM, and the code path is shared). Idle sign-out was verified with Playwright's fake clock, not a real 30-minute wait. Safari/Firefox not available here.
- Nothing cut. Deviation from the reconstructed F30 text: request body `{ kind, id }` (wave-2 contract) rather than `{ faceId }`; the toast reads "Undone." with a full stop, matching the studio's other toasts.
