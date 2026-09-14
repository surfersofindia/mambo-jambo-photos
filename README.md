# Mambo Jambo Photo Finder

This is a pay-to-unlock surf-photo delivery app. It uses one low-cost Cloudflare stack:

- **Cloudflare Pages** — public website
- **Cloudflare Worker** — private API, access checks and Razorpay verification
- **Cloudflare R2** — original photos and watermarked previews
- **Cloudflare D1** — session, photo, embedding, search and payment records
- **Browser-side Human.js** — face embedding detection; guest selfie image stays in their browser
- **Razorpay** — UPI/card checkout, with server-side order and signature verification

## What is stored where

| Data | Location | Who can access it |
| --- | --- | --- |
| Original session photos | Private R2 objects | Buyers receive a short-lived signed URL after payment |
| Watermarked previews | Private R2 objects | A matching guest receives a short-lived preview URL |
| Photo metadata, prices, orders | D1 database | Worker only |
| Face embeddings from session photos | D1 database | Worker only |
| Guest selfie image | Browser memory only | Never uploaded by this app |
| Guest face embedding | Sent once to `/api/match`, not stored | Worker uses it to score that search |

## Local setup

1. Install the Worker tooling:

   ```sh
   npm install
   ```

2. Log into Cloudflare and create the two data stores:

   ```sh
   npx wrangler login
   npx wrangler d1 create mambo-jambo-photos
   npx wrangler r2 bucket create mambo-jambo-photos
   ```

3. Copy the returned D1 `database_id` into [`wrangler.jsonc`](./wrangler.jsonc). Apply the schema:

   ```sh
   npm run db:apply
   ```

4. Add secrets. Use a long unique random string for `SESSION_SECRET`.

   ```sh
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put RAZORPAY_KEY_ID
   npx wrangler secret put RAZORPAY_KEY_SECRET
   npx wrangler secret put RAZORPAY_WEBHOOK_SECRET
   ```

5. For local testing, start the Worker and set `apiUrl` in [`config.js`](./config.js) to `http://127.0.0.1:8787`:

   ```sh
   npm run dev:api
   ```

   Serve this folder through any static web server on port `4173` and leave `ALLOWED_ORIGIN` in `wrangler.jsonc` as shown.

## Deploy

1. Deploy the API:

   ```sh
   npm run deploy:api
   ```

2. Set `apiUrl` in [`config.js`](./config.js) to the Worker URL printed by Cloudflare. Update `ALLOWED_ORIGIN` in `wrangler.jsonc` to your final Pages domain and deploy the Worker again.

3. In Cloudflare Pages, create a project from this repository and use the repository root as the build output directory (there is no build command). Deploy it.

4. In the Razorpay dashboard, use the deployed API endpoint as your webhook URL:

   ```text
   https://YOUR-WORKER.workers.dev/api/payment/webhook
   ```

   Subscribe to `payment.captured` and `order.paid`, then use the same webhook secret in `RAZORPAY_WEBHOOK_SECRET`.

5. Start with Razorpay **Test Mode** keys, run a real test order, and only then replace them with Live Mode keys after Razorpay KYC is approved.

## Admin flow

1. Open **Admin** and enter the password stored in `ADMIN_PASSWORD`.
2. Name the session, set its date/location and set the price in rupees.
3. Select the day’s JPG/PNG photos.
4. The browser generates face embeddings and a watermarked preview for every image, then uploads both.
5. Press **Publish photo pack**. Only then is the session visible to guests.

## Guest flow

1. A guest uploads a single clear selfie.
2. The browser produces a face embedding locally; the raw selfie never leaves the device.
3. The Worker scores it against that session’s indexed faces and returns only watermarked previews.
4. Razorpay checkout creates an order server-side.
5. The Worker verifies the returned payment signature before issuing 20-minute original-photo URLs.

## Cost starting point

Cloudflare’s free tier is suitable for a small launch: R2 includes 10 GB-month storage, 1 million writes, 10 million reads and no egress fees; D1 includes 5 GB storage plus 5 million reads/day and 100,000 writes/day. Razorpay has no setup or annual fee; its published standard rate is 2% plus GST per successful transaction, so it is not free but has no fixed monthly gateway cost. Verify current pricing before launching.

## Important launch checklist

- Add a clear consent checkbox before the guest selects their selfie.
- Publish a privacy notice explaining the short-lived face-matching request.
- Tune `MATCH_THRESHOLD` on real Mulki session photos before a public launch. Start at `0.62`; do a manual review of results and adjust conservatively.
- Do not put any Razorpay secret or the admin password in `config.js` or frontend files.
- Keep R2 buckets private. The Worker is intentionally the only route to media.
- Use production monitoring and a paid backup plan once this is a revenue-critical product.
