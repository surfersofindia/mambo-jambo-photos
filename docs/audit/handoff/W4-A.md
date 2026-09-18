# W4-A · Uploads and previews — handoff

Agent W4-A, wave 4 (second launch — the first run was cut off and its scratchpad wiped; the repo kept the work). Dev port **4180** (source tree, `PORT=4180 npm run dev`), e2e server 4195. Everything crew-side was exercised against the **mocked API** (`tests/e2e/helpers/mock-api.mjs`, which also mocks the R2 bucket) or the Worker's own code with mock `env` objects — no production write, no `POST /api/admin/login`, no `zz-test-*` session, nothing deployed, no secret set, no git commit/stash/checkout/reset. "Verified" names the test, command, transcript or screenshot; where a claim rests on reasoning it says so.

## Summary

**Inherited from the first wave-4 run (all present, all re-verified this session):**

- **Direct-to-R2 uploads** (`worker.js`, upload-routes region): `presignS3Url()` — AWS Signature V4 query-string presigning in plain WebCrypto, no dependency, checked byte-for-byte against AWS's published example vector (`tests/uploads.test.mjs` test 1). `POST /api/admin/sessions/:id/uploads/presign { filename, contentType, size }` → `201 { uploadUrl, method:'PUT', key, photoId, expiresAt, headers }` with a 15-minute expiry, the key under exactly the `sessions/<id>/original/<photoId>-<safeFilename>` naming `storeSessionPhoto()` uses, `content-type` + `host` signed; validation mirrors the streaming route (JPG/PNG/WebP only, ≤ 25 MB, 404 unknown session, 409 archived, 401). **Without `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` it answers `503 { fallback: 'stream' }`** and nothing else changes. `POST …/uploads/complete?photoId=&key=&filename=&contentType=&onDuplicate=&width=&height=` with body `[uint32 preview length][preview][thumb]`: the key must be one presign would have minted for this session + photo id (anything else is 400 before the bucket is touched), the object is `head()`ed (missing → `404 { missing: true }`, so the studio re-sends that one file the streaming way; not a photo / over 25 MB → the object is deleted, 400/413), its first 64 KB are range-read for the pixel size (migration 0012; the studio's `?width=&height=` is the fallback), then the same registration as every other upload runs — duplicate modes included; a `skip` deletes the orphan the browser PUT. The thumb rides in the same call, so a direct upload makes no separate thumb POST. Degrades on a pre-0008/0012 database (no thumb, plain INSERT).
- **WebP previews**: `PREVIEW_FORMATS` / `previewFormat()` sniff JPEG vs WebP from the bytes (never from a client header) and decide the stored key extension and content-type on the streaming route, `complete`, the thumb route (which retires a thumb stored under the other extension) and the new preview route. The studio (`admin.js` `toWebp()`, `preview-worker.js` `encodeWebp()`) encodes WebP only when the produced blob's own type is `image/webp` — Safari 15 answers a PNG — and JPEG otherwise; never a UA string.
- **Studio client** (`admin.js`, batch sender): `UPLOAD_DIRECT = true`; one presign probe per batch (`directProbe`) — twelve streams start together and a Worker without the route is asked once, 503/404 turn the whole batch to the streaming path; per-file XHR `PUT` to the bucket with exactly the headers the Worker signed and never the crew token, the same 30 s stall watchdog / 90 s response deadline, progress into the per-photo ring and MB counter; a bucket refusal (5xx, network error, CORS failure) is a `direct` error that sends only that file through the Worker, so mixed batches work; a lost `complete` reply is retried as a fresh presign + PUT + `onDuplicate=skip` (FIX-C's rule), the Worker answers `skipped` and drops the second object; re-auth pause/resume and Stop cover both routes. HEIC keeps the streaming path (the Worker never accepts it presigned).
- **Resumable batches**: IndexedDB `soi-uploads` / store `batches` keyed by `sessionId` — `{ sessionId, sessionTitle, createdAt, files: [{ name, size, lastModified, done, photoId }] }`, nothing else (no photo, no type, no token); written when a batch starts, ticked off per file with writes debounced to one per 1.5 s, dropped when every file is done, forgotten after 7 days. On sign-in (`showApp()` → `offerResume()`) the newest manifest with files still to send opens `#resumePanel`: *"Resume publishing?" — "“Morning glass” — 143 of 312 photos uploaded. Pick the same photos again and the rest go into that session; nothing is published until you say so."* **Pick the same photos** uses `showOpenFilePicker({ id: 'soi-session-photos', multiple: true })` where it exists (Chrome reopens the folder used last time) and the plain file input elsewhere (Safari, Firefox, phones); files are matched by name + size + lastModified, the ones already sent are left out, strays are counted in a toast, the wrong folder is refused with the count still to send, and the rest go into the existing **Add photos** flow for that session (which re-checks names against the session, so a photo that landed without being ticked off is caught again). **Discard** drops the manifest and never touches uploaded photos. Publishing stays manual.
- **Regenerate previews** (session card → More): confirm dialog ("Originals are never touched…"), then every original is fetched once through its signed crew link (`variant=original`), re-rendered by the same preview pipeline (600 / 320 px, WebP where the browser encodes it), `PUT /api/admin/photos/:id/preview?width=&height=` (new route: replaces the object, deletes the old key when the extension changed, fills `width/height` only where they are still empty) and `POST …/thumb`. Two at a time, a progress line with **Stop**, expired links renewed once from the photo list, a summary toast ("3 previews rebuilt." / "2 previews rebuilt, stopped with 1 to go."), refused while an upload is running. No original is ever uploaded again.
- Tests: 15 in `tests/uploads.test.mjs`, 8 e2e in `tests/e2e/uploads.spec.mjs`, the R2/presign/complete/preview mocks in `mock-api.mjs`.

**Added this session:**

1. **W4-B's background-sync hook** (their request #3, `admin.js`): `needsUploadSync(failures, unsent, online)` — true when a batch left photos behind *and* the device is offline or a stream died with "Network dropped."; a deliberate Stop while online or a Worker refusal is not a reason. `uploadPhotoBatch()` calls `window.SOIPWA?.requestUploadSync?.()` once at the end when it is true (feature-detected: no service worker or no Background Sync → the call answers `false` and the retry buttons stay in charge). `addEventListener('soi-resume-uploads', …)` — the event `pwa.js` re-dispatches when the worker's `sync` fires — re-opens the resume offer from the manifest, never over a running batch (`uploadBusy`) or a signed-out screen.
2. **The offer can't hide under a reload** (`admin.js` `showResumeOffer()`): a reload puts the page back where it was scrolled (often the bottom of a long queue), and the panel sits above the form. It now scrolls itself into view with `block: 'nearest'` (an already-visible panel is left alone) and a `scroll-margin-top` measured from the sticky topbar, and does it again after `load` because Chromium restores the old position as late as that — found while photographing it: at 375 px the restoration landed *after* the first scroll and pushed the panel 248 px above the viewport (`shots/W4-A/shots.log` history in the scratchpad; the final run shows the panel at y = 105 / 93 px at 1024 / 375).
3. **E2E assertion tightened**: the regenerate spec now proves each original was fetched exactly once through its crew link and never as a download (`state.media`, additive in `mock-api.mjs`); the placeholder `≥ 0` check is gone.
4. **Measured WebP vs JPEG** on the two real photos in `assets/` through the studio's own pipeline (`shots/W4-A/webp-vs-jpeg.txt`):

| Photo | Original | Preview (600 px) WebP | JPEG | Thumb (320 px) WebP | JPEG |
|---|---|---|---|---|---|
| `mambo-jambo-surf-session.jpg` (2400×1350) | 299 916 B | **20 702 B** | 28 365 B (WebP 27 % smaller) | **8 810 B** | 11 299 B (22 % smaller) |
| `mambo-jambo-surf-session-portrait.jpg` (900×1125) | 115 187 B | **30 672 B** | 40 443 B (24 % smaller) | **12 310 B** | 15 733 B (22 % smaller) |

The worker path and the main-thread path produce identical WebP sizes (same pipeline), and the JPEG column is the exact fallback a browser without WebP encoding gets.

5. Screenshots, the measurement script, the screenshot scripts and their transcript under `docs/audit/handoff/shots/W4-A/`.

Concurrent-session collisions: **none.** `git diff HEAD` of `admin.js`, `admin.html`, `worker.js` and a copy of `mock-api.mjs` / `uploads.test.mjs` were snapshotted at start (`scratchpad/W4-A/start-*`) and diffed before every editing round. Hunks that appeared meanwhile: W4-C's `AUDIT_WORDS` / `AUDIT_DETAIL_WORDS` in `admin.js` and their `DECOY_SALT` / audit-on-status-change hunks in `worker.js` — both outside my regions, both kept. `worker.js` and `admin.html` were not edited by me this session (the predecessor's routes and markup were complete).

## Files changed

- `admin.js` — my regions only: `needsUploadSync` (end of the manifest block), the `unsent` variable and the `requestUploadSync` call at the end of `uploadPhotoBatch()`, `showResumeOffer()`'s `bringIntoView` (scroll margin + `load` retry), the `soi-resume-uploads` listener after the Discard handler. Predecessor's regions (batch sender's direct path, manifest, resume, regenerate) verified and untouched.
- `tests/uploads.test.mjs` — one new test; the manifest sandbox exports `needsUploadSync`; the resume sandbox gained `addEventListener`, `isAuthenticated`, `uploadBusy`, `document.querySelector`, element `style`/`scrollIntoView`, and the resume test asserts the wake-up event and the scroll behaviour. **16 tests.**
- `tests/e2e/helpers/mock-api.mjs` — additive: `state.media` (every `GET /api/media/:id` served, `{ id, variant, download }`, not added to `api.calls`), documented in the header comment. W4-C's crew-account hunks untouched.
- `tests/e2e/uploads.spec.mjs` — the regenerate test's originals assertion.
- `docs/audit/handoff/W4-A.md` (this file), `docs/audit/handoff/shots/W4-A/` (new).

Not touched: `worker.js`, `admin.html`, `preview-worker.js` (inherited state verified), `pwa.js`/`sw.js` (W4-B), any CSS, `README.md`, `STATUS.md`, `tests/worker.test.mjs`, `tests/e2e/crew.spec.mjs`, `flows.mjs`, `fixtures.mjs`, `tests/e2e/__screenshots__/`.

## Tasks done (by id)

W4-A has no F-numbers in the fix prompt; against the workstream block:

| Item | Status |
|---|---|
| Presigned PUT in the Worker (SigV4, WebCrypto, no dependency), secrets `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`, `503 { fallback:'stream' }` without them | Done (inherited, verified: unit tests 1–3, e2e "503 once and the whole batch streams") |
| `presign` → `{ uploadUrl, key, photoId, expiresAt, headers }` with type/size validation and `storeSessionPhoto` naming | Done (unit test 2) |
| `complete` → `head()`, 64 KB range parse for dimensions, same registration; `404 { missing }` | Done (unit tests 4–8) |
| Client: presign decision once per batch, per-file PUT with the same watchdog/retry, then `complete`; progress/ETA, re-auth, cancel, `onDuplicate:'skip'` on retries, the progress ring; mixed batches | Done (e2e "originals go straight to the bucket", "a bucket that refuses one file", "a retried direct upload is idempotent"; unit test 12 for the studio source) |
| Resumable batches: IndexedDB manifest, "Resume publishing?" with the count, "Pick the same folder" (name+size+lastModified, skip done) and "Discard"; File System Access with `id`, file input otherwise | Done (unit tests 13 and 15; e2e "interrupted batch is offered again", "Discard forgets", "File System Access API… picker is used"). Deviation: `showOpenFilePicker({ id, multiple })`, not `showDirectoryPicker` — a directory picker would also hand over every non-photo in the folder and asks for a broader permission; the `id` gives the same "reopens where you were" behaviour. |
| `soi-resume-uploads` listener and `requestUploadSync()` (W4-B's hook) | **Done this session** (unit test 14 "a batch that lost the link…", the wake-up assertions in test 15) |
| WebP previews with feature detection; Worker accepts `image/webp` previews/thumbs end to end (content-type + key extension) | Done (unit tests 9–10; e2e asserts `previewFormat === 'webp'` on every direct and streamed upload in Chromium); size difference reported above |
| "Regenerate previews" on the More menu: crew media token, client-side re-render, `PUT …/preview` (new) + thumb, progress + cancel + summary toast, never re-uploads originals | Done (unit tests 11, 16; e2e "the More menu rebuilds every preview…", now asserting one `variant=original` fetch per photo) |
| Tests: SigV4 vector, presign validation, complete 404, fallback 503, WebP acceptance, regenerate route; e2e crew upload spec still passing with presign 503 by default, plus a mocked-R2 spec | Done (`crew.spec.mjs` unchanged and green in the full run; `uploads.spec.mjs` 8 × 2 projects) |
| Screenshots 1024/375: resume prompt, direct-upload progress, regenerate progress | **Done this session** |

## Tests added (names)

Unit (`node --test tests/uploads.test.mjs`, **16 / 16**; full suite **232 / 232**):

Inherited (15): `the presigner reproduces AWS's published query-string example byte for byte…` · `presign reserves the key storeSessionPhoto would have used and signs a 15-minute PUT for it` · `presign refuses what the streaming upload refuses, and answers 503 { fallback: "stream" } until the R2 secrets exist` · `complete registers the photo the browser PUT to R2…` · `complete: a missing object answers 404 { missing: true }…` · `complete only accepts a key presign minted for this session and photo…` · `complete honours the duplicate modes: a skipped retry takes its own object back out of the bucket` · `complete falls back to the studio hint and to a plain INSERT on a database without 0008/0012` · `previews and thumbs may be WebP or JPEG: the format is sniffed from the bytes…` · `the thumb route takes a WebP too and retires a thumbnail stored under the other extension` · `PUT /api/admin/photos/:id/preview replaces the watermarked preview…` · `the studio prefers WebP only when the browser really encodes it, and falls back per batch when presign is unavailable` · `an interrupted batch leaves a manifest of what still has to go…` · `the resume offer names the session, sends only the files that never landed, and Discard forgets it` (extended this session: the `soi-resume-uploads` wake-up, `uploadBusy` guard, scroll-into-view + `scrollMarginTop`) · `"Regenerate previews" rebuilds every preview from the original in the browser…`

New this session (1): `a batch that lost the link asks the service worker for a background sync; a Stop or a refusal does not`.

E2E (`tests/e2e/uploads.spec.mjs`, inherited, 8 tests × mobile-375 + desktop-1024 = 16 runs): direct-to-R2 uploads › `originals go straight to the bucket and only the preview and thumb reach the Worker` · `a bucket that refuses one file sends that one through the Worker instead, and the batch still publishes` · `a Worker without the R2 secrets answers 503 once and the whole batch streams, exactly as today` · `a retried direct upload is idempotent: a lost reply stores the photo once and its orphan object is dropped`; resumable batches › `an interrupted batch is offered again after a reload and only the missing photos are sent` · `Discard forgets the batch, and a finished batch is never offered` · `where the File System Access API exists, the picker is used instead of the file input`; regenerate previews › `the More menu rebuilds every preview and thumb from the originals, without re-uploading one` (assertion tightened this session).

## How to verify (commands and my port)

```sh
cd "/Users/ankithkotian/Documents/mambo jambo photos website"
npm run check && npm test                          # 232 / 232 at hand-off
node --test tests/uploads.test.mjs                 # 16 / 16
npx playwright test tests/e2e/uploads.spec.mjs --reporter=list   # 16 passed (~17 s; needs nothing running — it starts 4195)
npm run e2e                                        # see the line below
CI=1 npx wrangler deploy --dry-run                 # Total Upload: 184.28 KiB / gzip: 43.95 KiB
npm run build                                      # 55 files, 14 fingerprinted; dist/admin.<hash>.js references preview-worker.<hash>.js
PORT=4180 npm run dev                              # my port (a server I started is still up; PID via lsof -nP -iTCP:4180)
S=docs/audit/handoff/shots/W4-A
node $S/measure-webp.mjs                           # the WebP/JPEG table (needs the 4180 server; read-only, uploads nothing)
node $S/shots.mjs                                  # the six screenshots (needs 4180; every /api and bucket call is mocked, prints "escaped: []")
```

Full `npm run e2e` before the last two `admin.js` edits (the `soi-resume-uploads` listener and `needsUploadSync` were already in): **269 passed, 3 skipped** (2.8 min; the 3 skips are the phone-only axe check on the 768/1024/1440 projects, as in every wave). Final full run after every edit: **269 passed, 3 skipped (2.8 min)** (`scratchpad/W4-A/e2e-final2.log`). One run in between (`e2e-final.log`) reported 17 failed / 252 passed, every one of the 17 a `net::ERR_CONNECTION_REFUSED` on `127.0.0.1:4195` in `page.goto` — the shared e2e web server (`reuseExistingServer: true`) was torn down under it by another agent's concurrent run, the collision W4-B's handoff describes; no test failed on an assertion. Re-run alone once 4195 was free: clean.

## Screenshots and traces (paths)

`docs/audit/handoff/shots/W4-A/` (mocked API + mocked bucket on my 4180 server, Chromium, `reducedMotion`, 1024×768 and 375×812):

- `direct-upload-progress-{1024,375}.png` — two photos going straight to the bucket over a 48 KB/s uplink (CDP throttling against a loopback stand-in for the S3 endpoint, `bucket.mjs`, because a Playwright route holds a request before a byte moves and the browser then reports no upload progress): both rows "uploading" with their rings, "0 of 2 photos · 0.1 of 0.3 MB · 64 KB/s · ETA: 4s", the bar at 28 %. The transcript (`shots.log`) shows the two presigns, the two PUTs received by the bucket (299 916 B JPEG, 53 340 B WebP) and 2 `complete` calls / 0 streams.
- `resume-prompt-{1024,375}.png` — after a reload with one of two photos never landed: the panel, its copy ("“Morning glass” — 1 of 2 photos uploaded…"), **Pick the same photos** / **Discard**, fully below the sticky topbar (bounding box y = 105 / 93 px — the transcript prints "resume panel in view after the reload: true" for both).
- `regenerate-confirm-{1024,375}.png` — the confirm dialog ("Originals are never touched…").
- `regenerate-progress-{1024,375}.png` — "Rebuilding previews for “Morning glass” — 0 of 2" with **Stop**, the preview PUT held back 5 s; the transcript shows the summary toast "2 previews rebuilt.", 2 preview PUTs, and 0 originals re-uploaded.
- `webp-vs-jpeg.txt` + `measure-webp.mjs` — the size table and the script that produced it.
- `shots.mjs`, `bucket.mjs`, `shots.log` — the screenshot driver, the loopback bucket and the final transcript (`escaped: [] | page errors: []`).

No "before" screenshots: none of the three states existed before wave 4. No performance traces (no perf work in this block; the direct path removes the Worker from the original's byte path by construction, which was not measured against a real bucket from here).

## Deploy or dashboard actions needed

Nothing is deployed. In order:

1. **Worker secrets** (user runs or approves; each prompts for the value): an R2 API token with **Object Read & Write** on the `mambo-jambo-photos` bucket from Cloudflare dashboard → R2 → *Manage R2 API Tokens*, then
   ```sh
   npx wrangler secret put R2_ACCOUNT_ID        # the Cloudflare account id (the host is https://<id>.r2.cloudflarestorage.com)
   npx wrangler secret put R2_ACCESS_KEY_ID
   npx wrangler secret put R2_SECRET_ACCESS_KEY
   ```
   Optional var `R2_BUCKET` in `wrangler.jsonc` only if the bucket is not called `mambo-jambo-photos` (the binding's `bucket_name`). Until all three exist the Worker answers `503 { fallback: 'stream' }` and the studio streams exactly as today — verified by unit test 3 and the e2e "503 once" case, so the Worker can be deployed before the secrets.
2. **R2 bucket CORS** (dashboard → R2 → `mambo-jambo-photos` → Settings → CORS policy), exactly:
   ```json
   [
     {
       "AllowedOrigins": ["https://photos.surfersofindia.com", "https://mambo-jambo-photos.vercel.app"],
       "AllowedMethods": ["PUT"],
       "AllowedHeaders": ["content-type"],
       "ExposeHeaders": ["etag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
   `content-type` is signed into every presigned URL, so the preflight must allow it. Without this policy the browser's preflight fails, every file's PUT reports "Network dropped." and the studio streams that file through the Worker instead — the batch still publishes, just slower and with one failed PUT per photo (that fallback is the e2e "bucket that refuses one file" case).
3. **CSP** — see request 1 below; today's policy is report-only, so the PUT works but logs a violation until `connect-src` names the R2 host. Do not enforce the CSP before that line is in.
4. **Deploy order**: Worker (`npm run deploy:api`) then the studio from `dist/`. Both directions degrade: an old studio never calls presign; a new studio on an old Worker gets 404 and streams the batch (`directUploads = false`).
5. **After the first real batch** with the secrets in: R2 → bucket → objects should show `sessions/<id>/original/<photoId>-<name>` written by the browser and `preview/<photoId>.webp` + `thumb/<photoId>.webp` written by the Worker; `GET /api/admin/sessions/:id/photos` should carry `width/height` for those photos (the range-read parse) and, on Chrome, `thumbUrl`s ending in `.webp`. If a PUT is refused with a signature error, the first things to compare are the account id in `R2_ACCOUNT_ID` and that the token is scoped to this bucket — the signer itself is proven against AWS's vector and R2 documents SigV4 with region `auto`.
6. **"Regenerate previews"** is for sessions uploaded before F5 (300 px JPEG previews): run it once per old session from a desktop on a good connection (every original is downloaded once; a 300-photo session is ~1.5 GB of transfer). Guests' edge-cached previews rotate within an hour (`MEDIA_CACHE_SECONDS`).

## Requests to other owners (file, exact change, why)

1. **Lead · `.htaccess` and `vercel.json`** — in both `Content-Security-Policy-Report-Only` headers, append to `connect-src`: ` https://*.r2.cloudflarestorage.com` (or the exact `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` once the id is known). Why: the studio's presigned `PUT` goes from the browser to that host; the policy is report-only today so it only logs, but the README's plan is to enforce it, and enforced it would block every direct PUT (the studio would silently fall back to streaming). Verified the current value: `connect-src 'self' https://mambo-jambo-photo-api.surfersofindia.workers.dev https://sdk.cashfree.com https://api.cashfree.com https://sandbox.cashfree.com`.
2. **Lead · `README.md`** — under *Crew flow*, after the streaming-upload sentence: "With the R2 secrets in place (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, plus the bucket CORS policy in the W4-A handoff), originals go **straight to R2** through a 15-minute presigned PUT (`POST /api/admin/sessions/:id/uploads/presign`, then `…/uploads/complete` with the preview and thumb); without them the Worker answers `503 { fallback: 'stream' }` and the streaming route is used. Previews and thumbs are WebP where the browser encodes it (Chrome, Firefox, Safari 16+) and JPEG elsewhere — the Worker sniffs the format from the bytes. A batch interrupted by a reload or a dead battery is offered again on the next sign-in (*Resume publishing?*, from an IndexedDB manifest of names/sizes/timestamps only — re-pick the same photos and only the missing ones are sent; nothing is published automatically). **Regenerate previews** on a session card's More menu rebuilds every preview and thumb in the browser from the originals (`PUT /api/admin/photos/:id/preview`) without re-uploading them." Under *Deployment* step 2, add the three secrets as optional with the same one-line explanation. Under *Checks*, nothing new.
3. **W4-B · `pwa.js`** — informational, no change: your request #3 is done (`addEventListener('soi-resume-uploads', …)` reopens the offer; `requestUploadSync()` is called once at the end of a batch that lost the link). Note that `pwa.js` registers the tag itself on `offline` when a `soi-uploads` database exists, so on a mid-batch drop the tag is registered twice (idempotent).
4. **Lead · `docs/audit/STATUS.md`** — the build's "admin.html: 4 scripts, 71.3 KB gzip — WARNING: over the 40.0 KB compressed JS budget" is pre-existing (W3-C's note: `admin.js` is not under the public budget); nothing in this block moves it materially (my additions are ~0.4 KB gzip).
5. **Nobody in particular** — I started a standing dev server on **4180** (my port) and left it up; stop by PID (`lsof -nP -iTCP:4180`). Playwright's own 4195 server was started and stopped by each `npm run e2e`. No `pkill`; the lead's 4189 server was not touched.

## Cut or blocked (with reason)

- **Nothing cut.** Every item of the block is in place with tests, screenshots and this handoff.
- **Not verified against the real R2 / Worker / D1** (no crew credentials on this Mac; no secrets): that R2 accepts the presigned PUT (the signer reproduces AWS's example and uses R2's documented `auto` region/`s3` service and the `<account>.r2.cloudflarestorage.com/<bucket>/<key>` path form), the real `head()`/range-read semantics, real CORS, the studio's end-to-end round trip with 600/320 px WebP files against the deployed Worker. Everything above is the Worker's own code under mock `env` objects and the studio in Chromium against the mocked API and a mocked bucket.
- **Background Sync**: exercised in unit tests (the pure `needsUploadSync`, the wake-up event in the resume sandbox, the call site by source). Headless Chromium disables Background Sync (W4-B's finding), so the worker → `pwa.js` → studio path was not run in a browser by me; W4-B verified their half headed.
- **Chromium only.** WebP feature detection by output type is the mechanism for Safari < 16 and was exercised by forcing the JPEG branch (`webpOk = false`) in Chromium, not in a real Safari; the File System Access fallback is exercised by deleting `showOpenFilePicker` (what Safari/Firefox/phones look like), the picker path with a stub (no automation can answer the native dialog). HEIC (no decoder in Chromium) keeps the streaming route by design and was not exercised.
- **`showDirectoryPicker` not used** — reason in *Tasks done*.
- **Cashfree**: nothing in this block touches checkout, verify, webhook, refund or settlement code, so the CLAUDE.md Cashfree flow (App-ID ask, telemetry, progress feedback) was not run.
