# Mambo Jambo Photo Finder

Surf-session discovery, consent-based selfie matching, watermarked previews, temporary favourites, and crew photo management. Payments and original-photo downloads are on hold. The Worker rejects checkout, payment verification, and webhook requests with HTTP 503; the guest site contains no checkout integration.

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

Set `apiUrl` in `config.js` to `http://127.0.0.1:8787` for this setup. Supply `ADMIN_PASSWORD` and `SESSION_SECRET` in an uncommitted `.dev.vars` file. Set `FACE_API_URL` to your face service's `/extract` endpoint. Do not use production passwords for local development.

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

Open `/admin.html` (or `/admin` on Vercel), sign in, create a session, upload images, and publish. The crew can manage sessions, inspect photos, reindex and review borderline face pairs. Prices are retained as future configuration only. Reviewing face pairs records a crew decision; those decisions are not currently applied to guest match scoring.

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

Tests cover matching with a mocked face service, deduplicated signed previews, original-photo isolation, authentication, session validation, streaming upload limits, CORS, the payment hold, and public build asset completeness. Browser and real-service end-to-end testing are still required before launch.

## Deployment

1. Verify D1 schema compatibility and private R2 storage.
2. Configure Worker secrets `ADMIN_PASSWORD` and `SESSION_SECRET`, and variables `ALLOWED_ORIGIN`, `FACE_API_URL`, `MATCH_THRESHOLD`.
3. Deploy the Worker with `npm run deploy:api`.
4. Set the public `config.js` API URL, then deploy to Vercel, which runs the build and serves `dist/`. Deploy API and frontend together because matching now requires the consent field.
5. Test upload → indexing → publication → consent → matching → previews on desktop and mobile, using consented test photos.

## Outstanding launch validation

- Visual and keyboard QA in real browsers, including mobile Safari.
- Real matching accuracy and threshold validation on consented session photos.
- Infrastructure rate limits for public matching and admin login; authentication/private access for the face service.
- Provider retention review, a working data-request contact, and a defined data cleanup schedule.
- Backups, service monitoring, inference capacity and dependency/security review.

Production website: https://mambo-jambo-photos.vercel.app. Payment enablement is a separate future task.
