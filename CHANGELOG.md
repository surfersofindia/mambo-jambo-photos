# Changelog

All notable changes to this project are documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [1.0.0] - 2026-09-18

The "10/10 program": a four-wave audit and rebuild covering security, product depth, performance/PWA,
crew accounts and ops tooling. Full per-workstream detail lives in `docs/audit/STATUS.md`.

### Security
- Per-IP quota on selfie search (`POST /api/match`, 8/10 min, 30/day, `retry-after`) and on colour search.
- `x-face-key` shared secret between the Worker and the face service — needs `FACE_API_KEY` set on
  the Worker **and** the Hugging Face Space (Worker first).
- Revocable crew sign-in tokens and `POST /api/admin/logout` — needs migration `0011_admin_sessions`.
- Per-crew accounts with TOTP (RFC 6238), PBKDF2-SHA256 210k-round passwords, and per-IP/per-account
  sign-in throttling, replacing the single shared studio password — needs migration
  `0016_crew_accounts`; the shared `ADMIN_PASSWORD` keeps working during the transition via the
  `LEGACY_SHARED_LOGIN` variable.
- Cashfree webhook: 5-minute signed-timestamp window and a `payment_status` gate before unlocking.
- Self-hosted fonts and `font-src 'self'` in both report-only CSPs; Google Fonts removed from every page.

### Public site
- Uncropped contact-sheet tiles sized from the stored photo dimensions, zero layout shift — needs
  migration `0012_photo_dimensions`.
- "Not me, hide" on any matched tile, with an in-place, screen-reader-announced removal.
- Zero-match second chance: a 12-hue colour search ring and a "notify me" phone number.
- WhatsApp share on results and post-payment (a 30-day gallery link, never a bare token).
- Checkout trust block (photo count, per-photo price, payment methods) above the phone field.
- Session conditions (surf/weather notes) and a "today's session lands by …" countdown — needs
  migration `0014_session_conditions`.
- Drag-and-drop selfie, flick-to-turn lightbox, 48px touch targets, AA contrast throughout.
- Installable PWA: manifest, offline landing page and offline access to an already-unlocked gallery
  via a service worker, resumable uploads woken by Background Sync.

### Crew studio
- Bulk photo actions (delete, re-index, move, set cover) with per-photo fallback on an older Worker.
- Cover picker required before publish (or an explicit "publish without a cover").
- Session conditions editor with an EXIF pre-fill helper.
- **Money** tab: per-session funnel and Cashfree settlement reconciliation.
- **Support** tab: guest lookup by phone/order/search, resend a link, free unlock, refunds — needs
  migration `0015_support`.
- Review queue: a meter, full uncropped frames beside crops, and `Z`/Undo within a 10-minute window.
- Direct-to-R2 presigned uploads with resumable batches and one-click "regenerate previews" — needs
  the `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` secrets (falls back to streaming
  uploads without them) and R2 bucket CORS for `PUT` from both site origins.
- **Crew** pane: add/disable crew accounts, TOTP enrolment, audit log viewer.

### Performance & PWA
- Lighthouse (local, applied throttling): LCP 2.8s → ~1.7s, CLS 0, TBT 0, script 34KB gzip.
- Previews and thumbnails edge-cached; a `*/10 * * * *` cron keeps the face service warm.
- Fingerprinted, `immutable`-cached build output (`npm run build` → `dist/`); every deploy now also
  writes `dist/version.json` (`version`, short commit, `builtAt`) so a live host can be checked against
  the release tag it shipped.
- Direct-to-R2 uploads take large batches off the Worker's own bandwidth.

### Backend & data
- Migrations `0010_rate_limits` through `0016_crew_accounts`, applied one file at a time, oldest first
  (see `docs/runbook.md` §1).
- `events` table backs `GET /api/admin/stats` (per-session searches, unlocks, revenue).
- Settlement reconciliation against Cashfree's `POST /pg/settlements`.
- Refunds through Cashfree's Create Refund API, tracked via `REFUND_STATUS_WEBHOOK`.

### Accounts & audit
- `crew_users` (name, password hash, TOTP secret, role) and `admin_sessions.user_id`/`role`.
- `audit_log` records every delete, publish, free unlock, refund, login attempt, TOTP change and
  account change, without ever recording a password.
- Roles `photographer` / `admin`, with 403s on refund, grant, deleting a published session, and
  account management for non-admins.

### Operations
- `scripts/backup.mjs`: nightly D1 export → gzip → R2, with a monthly copy — needs the GitHub
  repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and an R2 lifecycle rule
  expiring backups after 30 days.
- `scripts/restore-drill.mjs`: reloads a backup into a fresh local database and sanity-checks it.
- Indexing-queue stall detection and alert delivery (Slack/Chat/Discord/Resend) — needs
  `ALERT_WEBHOOK_URL` and/or `RESEND_API_KEY` (optional; logs only until one is set).
- `docs/runbook.md`: the deploy order, every secret and where it lives, rollbacks, the crew-lockout
  reset, backups/restore, and alerts.

### Testing
- 232 unit tests (`node --test`), 269 Playwright e2e tests across four viewports (375/768/1024/1440),
  zero axe accessibility violations, and a Lighthouse CI budget gate.
- `.github/workflows/ci.yml` runs `npm run verify` on every push.

### Known gaps
- Live-host LCP (2.2–3.0s measured on the mirror and primary host) is above the 1.8s target the local
  gate meets — the local number doesn't include real CDN/Worker round trips.
- The landing-page cover is served as the unwatermarked original on a 6-hour public token; a
  dedicated EXIF-free cover derivative is recommended if the original should not be public.
- Matching precision/recall is unmeasured — no consented session has been nominated for
  `docs/accuracy.md`'s procedure yet; `MATCH_THRESHOLD` stays at its default, 0.62.
- `soi-stamps.svg` uses placeholder geometry; the intended linocut art was never supplied.
- Accessibility was verified with axe and the Chromium accessibility tree, not a real screen reader
  (VoiceOver/NVDA).
- Cashfree go-live items remain open regardless of this release: the payment webhook does not
  re-fetch `GET /orders/{id}` before fulfilment, there is no idempotency-key store and no webhook IP
  allow-list, and the sandbox→production key swap has not been exercised.

## [0.9.0] - 2026-09-17

Pre-program baseline. Cashfree payments and the rebrand to Surfers of India; a crew studio with
reliable batched uploads, live per-photo progress, retry and resume across network handovers, and
review queues sorted by session; fallback face matching (burst + appearance) with EXIF-orientation
handling; and a concurrently-developed guided-selfie camera with client-side face detection and
burst-link auto-confirmation.
