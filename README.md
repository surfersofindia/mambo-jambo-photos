# Mambo Jambo Photo Finder

Surf-session discovery, consent-based selfie matching, watermarked previews, temporary favourites, crew photo management, and Cashfree-powered checkout for original-photo downloads.

## Stack

- Static HTML, CSS and JavaScript on Vercel. `npm run build` copies only public website assets into `dist/`; source, database files and local credentials are excluded.
- Cloudflare Worker for authenticated admin operations, matching, and signed media access.
- Private R2 storage for originals and watermarked previews; D1 for metadata and face embeddings.
- Python FastAPI / InsightFace service for face extraction.
- Brand layer: `soi-tokens.css` (design tokens plus the shared toast, chip, empty-state, loader and action-bar components, loaded first on both the public and admin pages) and `soi-stamps.svg` (the linocut stamp sprite it references). Headings use the Fraunces display font from Google Fonts; UI text stays on Plus Jakarta Sans.

## Local development

Use Node 22 or newer. Python is needed only when running the face service.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:4173. `config.js` currently points at the deployed API. Its CORS configuration only permits the production site, so use a local Worker for the complete local flow:

```sh
npx wrangler dev --var ALLOWED_ORIGIN:http://127.0.0.1:4173
```

Set `apiUrl` in `config.js` to `http://127.0.0.1:8787` for this setup. Supply `ADMIN_PASSWORD`, `SESSION_SECRET`, `CASHFREE_APP_ID` and `CASHFREE_SECRET_KEY` in an uncommitted `.dev.vars` file. Set `FACE_API_URL` to your face service's `/extract` endpoint. Do not use production passwords for local development. Cashfree webhooks cannot reach localhost, so test the full paid flow against a deployed Worker (`CASHFREE_ENV=sandbox`) or a tunnel.

Initialize a fresh local database:

```sh
npx wrangler d1 execute mambo-jambo-photos --local --file=schema.sql
```

There are no fabricated session or match results. Empty sessions and API failures are displayed explicitly.

## Guest flow

1. Choose a published session.
2. Select a valid JPG, PNG or WebP selfie up to 10 MB and consent to server processing.
3. Search; cancel or retry if needed.
4. Browse temporary watermarked previews, enlarge photos (swipe / arrow keys / tap to zoom), and filter favourites. Favourites are held only in page memory and reset on a new search or reload. Signed preview links are refreshed automatically while the search is valid; after payment the browser keeps a 30-day gallery token in `localStorage` (`mjGallery`) so a guest can reopen their originals, and each original has a **Download** link (`?download=1` serves it as an attachment).

The selfie is sent to the Worker and forwarded to the face service. The provided code does not persist guest selfies or their embeddings. D1 does store a search record with matched photo IDs; signed access expires, but records are not automatically deleted. Hosting-provider logging and retention must be reviewed separately. Session photos and indexed face embeddings remain stored until removed by the crew.

A guest's results are not only direct face matches: if a matched photo has a crew-**confirmed** burst or appearance link (see Crew flow below) to another photo with no usable face of its own, that linked photo is included too, at a slightly discounted score. Pending and rejected links are never surfaced to guests.

## Crew flow

Open `/admin.html` (or `/admin` on Vercel), sign in (five failed attempts from one IP lock sign-in for 15 minutes once migration 0008 is applied), create a session, upload images, and publish. Uploads accept JPG, PNG, WebP and iPhone HEIC/HEIF files; HEIC is decoded in the browser before upload, which Safari and macOS do natively, while other browsers report a per-file error for that photo and continue with the rest. Uploads use the streaming Worker path (`UPLOAD_STREAMING` in `admin.js`) and send a 480px watermarked thumbnail per photo after the original (`POST /api/admin/photos/:id/thumb`); thumbnails are optional and only exist for photos uploaded after 0008. The crew can manage sessions, inspect photos, reindex and review borderline face pairs, and set the photo-pack price guests pay to unlock originals. **Upload more** on a session card adds photos to a draft or published session; files whose names already exist in that session are listed first, and the crew chooses whether to replace the existing photos, upload only the new files, or keep both as numbered copies (`IMG_0412-2.jpg`). Reviewing face pairs records a crew decision; those decisions are not currently applied to guest match scoring.

The **Review matches** tab also surfaces two kinds of fallback links for photos with no usable face (the surfer facing away, for example): burst-sequence links to a photo shot within a couple of seconds of one that does have a face (`BURST_GAP_SECONDS`, default 2s), and clothing-appearance links to a photo with a detected face whose clothing color histogram closely matches (`APPEARANCE_THRESHOLD`, default 0.85 — see "Body/clothing appearance matching" below for how that signal is produced). "Scan Burst & Appearance Links" proposes candidates for the crew to confirm or reject. Unlike face-pair reviews, **confirming a link here does reach guests** — see "Guest flow" above and `/api/match` in `worker.js`.

## Database compatibility

`schema.sql` now includes `faces.bbox_json`, `face_verifications`, and `photos.captured_at`, used by existing admin indexing, verification, and burst-grouping features. For an existing database, inspect `PRAGMA table_info(faces)` and `PRAGMA table_info(photos)` before upgrading. If `bbox_json` or `captured_at` are absent, add them once:

```sql
ALTER TABLE faces ADD COLUMN bbox_json TEXT;
ALTER TABLE photos ADD COLUMN captured_at TEXT;
```

Then apply `schema.sql` to create any missing tables/indexes. `CREATE TABLE IF NOT EXISTS` does not add columns to an existing table. Back up remote data and inspect the existing schema before migration; no remote migration has been performed by this rebuild.

`photos.captured_at` is populated from EXIF by the face service and only backfills when a photo is (re)indexed — apply `migrations/0004_capture_metadata.sql` then re-index existing sessions (`/api/admin/reindex` or per-session reindex) to populate it for already-uploaded photos. Photos with stripped or missing EXIF (screenshots, some compression tools) simply keep `captured_at = NULL`.

## Checks

```sh
npm run check
npm run build
npm test
npx wrangler deploy --dry-run
```

Tests cover matching with a mocked face service, deduplicated signed previews, original-photo isolation, authentication, session validation, streaming upload limits, CORS, the public health endpoint, Cashfree checkout/verification/webhook handling (mocked), public build asset completeness, burst-sequence grouping, burst/appearance fallback-link generation and review, the confirm/reject feedback log and weight-retraining logistic regression, and confirmed links extending a guest's matched photos. Browser and real-service end-to-end testing (including the actual HOG detector and EXIF parsing against real camera JPEGs, not just mocked face-service responses) are still required before launch.

## Deployment

1. Verify D1 schema compatibility and private R2 storage. Apply `migrations/0002_cashfree_payments.sql`, `migrations/0004_capture_metadata.sql`, `migrations/0005_photo_links.sql`, `migrations/0006_photo_appearances.sql`, `migrations/0007_match_learning.sql`, and `migrations/0008_thumbnails_and_login_throttle.sql` if upgrading an existing database. The Worker detects `photos.thumb_key` and `login_attempts` at runtime, so it can be deployed before 0008 is applied — grid tiles fall back to the 1400px preview and sign-in throttling is skipped until then.
2. Configure Worker secrets `ADMIN_PASSWORD`, `SESSION_SECRET`, `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`, and variables `ALLOWED_ORIGIN`, `FACE_API_URL`, `MATCH_THRESHOLD`, `CASHFREE_ENV` (`sandbox` or `production`). `BURST_GAP_SECONDS` (default 2) and `APPEARANCE_THRESHOLD` (default 0.85) are optional and only affect fallback-link candidate generation.
3. In the Cashfree dashboard, point the webhook URL at `<worker-url>/api/payment/webhook` (version `2023-08-01` or later). Cashfree signs webhooks with the same `CASHFREE_SECRET_KEY` used for API calls — there is no separate webhook secret to configure.
4. Deploy the Worker with `npm run deploy:api`.
5. Set the public `config.js` API URL, then deploy to Vercel, which runs the build and serves `dist/`. Deploy API and frontend together because matching now requires the consent field.
6. Test upload → indexing → publication → consent → matching → previews → checkout → payment verification → unlocked originals on desktop and mobile, using consented test photos and Cashfree sandbox test cards/UPI.

### Health check

`GET /api/health` on the Worker is public and uncached (`cache-control: no-store`). It returns `{ ok, checks: { db, r2, face }, time }` with HTTP 200 when every check is `ok` and 503 otherwise: `db` runs `SELECT 1` on D1, `r2` performs a `head()` on the photo bucket (a missing object is fine; only an R2 error fails), and `face` is `skipped` unless `?deep=1` is passed, in which case the face service must answer a `HEAD` request within 3 s — any HTTP status counts, including 405, since the point is reachability, not inference. Checks run independently, so one failure never hides another, and the response never carries error text or configuration values. The admin studio's topbar health pill polls this endpoint and shows API, R2 and face-service status; an uptime monitor can watch the same URL.

### Download all

`GET /api/searches/:id/download?token=<search or gallery token>` streams every original of a **paid** search as one ZIP (`surfers-of-india-<date>-<break>.zip`). Entries are stored, not deflated — JPEGs don't shrink and it keeps the Worker to a single CRC pass per byte — and the archive streams straight out of R2 with data descriptors, so nothing is buffered. When R2 reports object sizes the response carries an exact `Content-Length` (browser progress bars work) and packs above 4 GiB are refused with 413 (no ZIP64). The guest page shows **Download all** once a gallery is unlocked; unpaid searches get 402, bad tokens 401.

### Content Security Policy

Both hosts send the policy as `Content-Security-Policy-Report-Only` (`.htaccess` for Hostinger, `vercel.json` for the Vercel mirror), so browsers log violations to the console without blocking anything. Before enforcing it, complete one full sandbox payment (checkout → pay → return → download an original) with the browser console open and confirm no CSP reports appear; then rename the header to `Content-Security-Policy` in both files and redeploy. The policy allows scripts only from the site itself and `sdk.cashfree.com`, connections to the Worker and Cashfree, Cashfree frames, Google Fonts, and `blob:`/`data:` images for in-browser thumbnailing and HEIC decoding — any new script host or CDN must be added to the policy first.

## Outstanding launch validation

- Visual and keyboard QA in real browsers, including mobile Safari.
- Real matching accuracy and threshold validation on consented session photos.
- Real-world accuracy of the HOG person detector and burst/appearance fallback links against actual session photos — since confirming a link now reaches guest results (see "Guest flow"), a crew mis-confirmation shows a guest someone else's photo, not just a false entry in an internal review queue.
- Infrastructure rate limits for public matching and admin login; authentication/private access for the face service.
- Provider retention review, a working data-request contact, and a defined data cleanup schedule.
- Backups, service monitoring, inference capacity and dependency/security review.

Production website: https://photos.surfersofindia.com (also mirrored at https://mambo-jambo-photos.vercel.app).

## Body/clothing appearance matching

For every indexed photo, the face service also runs OpenCV's built-in HOG person detector (`face-api/main.py`) — no extra model download or dependency beyond `opencv-python-headless`, already required for face detection — and, if a person is found, computes a normalized HSV color histogram of their lower ~65% (clothing, not head/hair) as a coarse "same outfit" descriptor. This runs for every photo regardless of whether a face was also detected, since a surfer keeps the same wetsuit/boardshorts for a whole session. Stored in `photo_appearances` (one row per photo, replaced on re-index).

This is a deliberately lightweight choice over a YOLO/torch-based person detector: HOG ships inside the dependency the face service already has, so this added zero new packages and no extra cold-start cost on the Hugging Face Spaces container it runs on. It is also weaker than YOLO on crouched, mid-air, or heavily cropped action shots — if real-world recall proves too low, swap `detect_person_bbox()` in `face-api/main.py` for an ONNX-based detector; `clothing_histogram()` and the worker-side matching in `generateFallbackLinks()` don't care which detector produced the box. Only the single largest (dominant) detected person per photo is used — photos with multiple surfers close together in frame will have lower appearance-match recall for anyone but the largest subject in shot; this is a known v1 limitation, not a bug.

## Learning from crew reviews

Every confirm/reject decision on a face pair or a burst/appearance link is logged to `match_feedback` with the feature value that produced the candidate (face similarity, burst timing closeness, or appearance similarity). "🧠 Retrain from Reviews" in the Review matches tab (`POST /api/admin/retrain`) refits a small logistic regression — hand-rolled in `worker.js` (`fitLogisticRegression`), since there's no ML library available inside a Cloudflare Worker — over all accumulated feedback, and stores the fitted weights in the `match_weights` singleton row. This is genuinely "the more the crew reviews, the more accurate it gets," but concretely: it recalibrates how confidently `generateFallbackLinks()` scores and gates future burst/appearance candidates (`sigmoid(bias + weight · signal) ≥ 0.5`) from crew-labeled examples — it does **not** retrain or fine-tune the InsightFace face-recognition network itself, which is out of scope for this stack. Retraining is a no-op (`trained: false`) below `MIN_FEEDBACK_FOR_TRAINING` (20) labeled reviews, or until both confirmed and rejected examples exist — until then, scoring keeps using the original fixed thresholds (`APPEARANCE_THRESHOLD` etc.) so behavior never regresses for lack of data. Retraining is a deliberate crew action (a button), not automatic on every decision, so a review click never risks the extra latency of a fit.

## Durable photo indexing

Photo uploads and re-index requests send one job per photo to the `mambo-jambo-face-indexing` Cloudflare Queue. The consumer processes one at a time, retries service failures up to three times, and records final errors. Repeated re-index clicks do not duplicate active jobs. No-face scans are marked completed with zero faces; this is distinct from failed inference.

For an existing installation, apply `migrations/0001_indexing_jobs.sql` before deploying this version of the Worker. Create the queue once with `npx wrangler queues create mambo-jambo-face-indexing`; the bindings are in `wrangler.jsonc`. New installations use the complete `schema.sql`.
