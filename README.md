# Mambo Jambo Photo Finder

Surf-session discovery, consent-based selfie matching, watermarked previews, temporary favourites, crew photo management, and Cashfree-powered checkout for original-photo downloads.

## Stack

- Static HTML, CSS and JavaScript on Vercel. `npm run build` copies only public website assets into `dist/`; source, database files and local credentials are excluded.
- Cloudflare Worker for authenticated admin operations, matching, and signed media access.
- Private R2 storage for originals and watermarked previews; D1 for metadata and face embeddings.
- Python FastAPI / InsightFace service for face extraction.

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

Set `apiUrl` in `config.js` to `http://127.0.0.1:8787` for this setup. Supply `ADMIN_PASSWORD`, `SESSION_SECRET`, `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY` and `CASHFREE_WEBHOOK_SECRET` in an uncommitted `.dev.vars` file. Set `FACE_API_URL` to your face service's `/extract` endpoint. Do not use production passwords for local development. Cashfree webhooks cannot reach localhost, so test the full paid flow against a deployed Worker (`CASHFREE_ENV=sandbox`) or a tunnel.

Initialize a fresh local database:

```sh
npx wrangler d1 execute mambo-jambo-photos --local --file=schema.sql
```

There are no fabricated session or match results. Empty sessions and API failures are displayed explicitly.

## Guest flow

1. Choose a published session.
2. Select a valid JPG, PNG or WebP selfie up to 10 MB and consent to server processing.
3. Search; cancel or retry if needed.
4. Browse temporary watermarked previews, enlarge photos, and filter favourites. Favourites are held only in page memory and reset on a new search or reload.

The selfie is sent to the Worker and forwarded to the face service. The provided code does not persist guest selfies or their embeddings. D1 does store a search record with matched photo IDs; signed access expires, but records are not automatically deleted. Hosting-provider logging and retention must be reviewed separately. Session photos and indexed face embeddings remain stored until removed by the crew.

## Crew flow

Open `/admin.html` (or `/admin` on Vercel), sign in, create a session, upload images, and publish. The crew can manage sessions, inspect photos, reindex and review borderline face pairs, and set the photo-pack price guests pay to unlock originals. **Upload more** on a session card adds photos to a draft or published session; files whose names already exist in that session are listed first, and the crew chooses whether to replace the existing photos, upload only the new files, or keep both as numbered copies (`IMG_0412-2.jpg`). Reviewing face pairs records a crew decision; those decisions are not currently applied to guest match scoring.

## Database compatibility

`schema.sql` now includes `faces.bbox_json` and `face_verifications`, both used by existing admin indexing and verification features. For an existing database, inspect `PRAGMA table_info(faces)` before upgrading. If `bbox_json` is absent, add it once:

```sql
ALTER TABLE faces ADD COLUMN bbox_json TEXT;
```

Then apply `schema.sql` to create any missing tables/indexes. `CREATE TABLE IF NOT EXISTS` does not add columns to an existing table. Back up remote data and inspect the existing schema before migration; no remote migration has been performed by this rebuild.

## Checks

```sh
npm run check
npm run build
npm test
npx wrangler deploy --dry-run
```

Tests cover matching with a mocked face service, deduplicated signed previews, original-photo isolation, authentication, session validation, streaming upload limits, CORS, Cashfree checkout/verification/webhook handling (mocked), and public build asset completeness. Browser and real-service end-to-end testing are still required before launch.

## Deployment

1. Verify D1 schema compatibility and private R2 storage. Apply `migrations/0002_cashfree_payments.sql` if upgrading an existing database.
2. Configure Worker secrets `ADMIN_PASSWORD`, `SESSION_SECRET`, `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`, `CASHFREE_WEBHOOK_SECRET`, and variables `ALLOWED_ORIGIN`, `FACE_API_URL`, `MATCH_THRESHOLD`, `CASHFREE_ENV` (`sandbox` or `production`).
3. In the Cashfree dashboard, point the webhook URL at `<worker-url>/api/payment/webhook` and copy its signing secret into `CASHFREE_WEBHOOK_SECRET`.
4. Deploy the Worker with `npm run deploy:api`.
5. Set the public `config.js` API URL, then deploy to Vercel, which runs the build and serves `dist/`. Deploy API and frontend together because matching now requires the consent field.
6. Test upload → indexing → publication → consent → matching → previews → checkout → payment verification → unlocked originals on desktop and mobile, using consented test photos and Cashfree sandbox test cards/UPI.

## Outstanding launch validation

- Visual and keyboard QA in real browsers, including mobile Safari.
- Real matching accuracy and threshold validation on consented session photos.
- Infrastructure rate limits for public matching and admin login; authentication/private access for the face service.
- Provider retention review, a working data-request contact, and a defined data cleanup schedule.
- Backups, service monitoring, inference capacity and dependency/security review.

Production website: https://photos.surfersofindia.com (also mirrored at https://mambo-jambo-photos.vercel.app).

## Durable photo indexing

Photo uploads and re-index requests send one job per photo to the `mambo-jambo-face-indexing` Cloudflare Queue. The consumer processes one at a time, retries service failures up to three times, and records final errors. Repeated re-index clicks do not duplicate active jobs. No-face scans are marked completed with zero faces; this is distinct from failed inference.

For an existing installation, apply `migrations/0001_indexing_jobs.sql` before deploying this version of the Worker. Create the queue once with `npx wrangler queues create mambo-jambo-face-indexing`; the bindings are in `wrangler.jsonc`. New installations use the complete `schema.sql`.
