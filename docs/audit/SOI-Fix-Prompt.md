# SOI photos — fix tasks F1–F31 (reconstructed)

> **Provenance.** The master prompt (`docs/audit/SOI-Master-Prompt.md`) references this file, but it was missing from the tree on 2026-09-17. The lead reconstructed every task from (a) the master prompt's own inline descriptions, (b) `docs/audit/SOI-Audit-Report.md` and `docs/audit/patches-reference/`, and (c) what already shipped in the working tree (most of the audit's top 10 did). If the original file turns up, it wins; anything here that contradicts it should be re-done to the original spec.
>
> Every task says **who owns it** (workstream in the master prompt) and **how to verify**. Numbers, sizes and copy are targets; owners may adjust with a reason in their handoff.

## Backend (Worker)

### F1 · Rate-limit `POST /api/match` — W1-A
Today a client can call `/api/match` without limit, and every call invokes the face service (slow and costly) and inserts a `searches` row. Add a per-client limiter backed by D1:
- Migration `migrations/0010_rate_limits.sql`: `rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, window_start TEXT NOT NULL)` plus an index on `window_start` for cleanup. Mirror in `schema.sql`.
- Key by client IP (`cf-connecting-ip`, fall back to `x-forwarded-for` first hop, then `'unknown'`). Windows: **8 searches per 10 minutes** and **30 per 24 hours** per IP (two keys: `match:10m:<ip>`, `match:1d:<ip>`). Count only after input validation passes (a malformed request must not consume quota), and count *before* calling the face service so a slow provider cannot be used to amplify load.
- Over limit → `429` with `retry-after` seconds and guest copy: "You've searched a lot in a short while. Try again in N minutes." Keep the existing selfie-not-persisted behaviour.
- Reuse the same pattern (a small `limiter(env, key, max, windowSeconds)` helper) so W3-B can protect the colour search later. Expire old rows opportunistically (delete rows whose window ended, at most once per request path, wrapped in try/catch — the limiter must fail open with a `console.warn` if the table is missing, so an unmigrated database does not block searches).
- Tests: under limit passes; the 9th call in a window is 429 with `retry-after`; an invalid request does not consume quota; a missing table fails open.

### F2 · Shared secret between the Worker and the face service — W1-A (Worker half) + W1-B (Space half)
The Hugging Face Space is publicly callable. Add `FACE_API_KEY`:
- **Worker (W1-A):** `extractFaces()` sends `x-face-key: env.FACE_API_KEY` when the secret is set (no header when unset, so the current deployment keeps working during rollout). Any deep health ping that reaches `/extract` sends it too. Test: the header is present when the secret is set and absent when it is not.
- **Space (W1-B):** in `face-api/main.py`, when the `FACE_API_KEY` environment variable is set, `POST /extract` returns `401 {"error":"unauthorised"}` unless `x-face-key` matches (constant-time compare). `/health` and `/` stay open. When the variable is unset, behaviour is unchanged. Also make sure a cheap warm ping exists: `GET /extract` or `HEAD /extract` returns 200 without loading an image (document which). Record the cold-start time from a fresh container in the handoff, and the exact rollout order (push Space code → `wrangler secret put FACE_API_KEY` → deploy Worker → set the Space secret in Space settings).

### F3 · Revocable admin tokens — W1-A
Admin tokens are HMAC-signed with an expiry but cannot be revoked server-side. Add server-side sessions:
- Migration `migrations/0011_admin_sessions.sql`: `admin_sessions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TEXT NOT NULL, revoked_at TEXT, last_seen_at TEXT, ip TEXT, user_agent TEXT)`. Mirror in `schema.sql`.
- Login inserts a row and embeds its `id` in the signed token payload. `requireAdmin()` still verifies the signature first (cheap, no DB), then does **one** query on `admin_sessions` and rejects when the row is missing, revoked or expired; update `last_seen_at` at most once per 5 minutes (not on every request).
- `POST /api/admin/logout` (authenticated) sets `revoked_at` and returns `{ ok: true }`. Keep the token lifetime as it is today.
- If the table does not exist (unmigrated database) log a warning and accept signature-valid tokens, so a deploy without the migration does not lock the crew out; the health endpoint should surface `adminSessions: 'unmigrated'`.
- Tests: logout revokes (the same token then 401s); expired session 401s; tampered token 401s before any DB access; missing table falls back to signature-only.

### F4 · Cashfree webhook timestamp window — W1-A (Cashfree rules from `CLAUDE.md` apply; read `.claude/skills/pg/webhooks/SKILL.md`)
`/api/payment/webhook` verifies the HMAC but accepts any `x-webhook-timestamp`, so a captured payload can be replayed forever. Reject webhooks whose timestamp is more than **5 minutes** from the Worker's clock (accept both epoch-seconds and epoch-milliseconds forms; treat non-numeric as invalid). Keep the signature check first and constant-time. Keep processing idempotent (the existing `status != 'paid'` guard). Tests: a valid signature with a stale timestamp is rejected with 401; a fresh one still marks the payment captured. Then run the validation checklist in `.claude/skills/validation-and-testing/SKILL.md` for the webhook part and list unmet items in the handoff.

### F4b · `/api/sessions` cover lookup as one join — W1-A
The handler runs one `photos` query per session. Replace with a single `LEFT JOIN photos ON photos.id = sessions.cover_photo_id AND photos.session_id = sessions.id`, keep the `hasColumn` guards for unmigrated databases, keep the response shape (`coverUrl`, signed thumb-or-preview token). Test with a mock DB that counts prepared statements.

## Face service

See F2. Also confirm the Space handles at least three concurrent `/extract` calls (needed before W3-B raises queue `max_concurrency`); note the result in the handoff.

## Crew studio (admin)

### F5 · Preview and thumbnail sizes — W1-C
A parallel session cut the client-side watermarked preview to 300 px long edge and thumbs to 200 px, which upscales 2.5× on phones. Set `PREVIEW_MAX = 600` (long edge) and thumbs to **320 px**, JPEG quality tuned so a preview stays under ~90 KB and a thumb under ~25 KB. Keep the watermark lattice and stamp legible at the new size; keep the blur pass. The Worker accepts previews up to 5 MB so nothing server-side changes. Verify by uploading three photos into `zz-test-w1c` and reading the stored sizes from the admin photo grid / network panel; put before/after sizes in the handoff.

### F6 · `preview-worker.js` — W1-C
Move preview + thumb generation off the main thread: a Web Worker (`preview-worker.js`, new, add to `scripts/site-files.mjs` and restart your dev server so it is served) that receives a `File`, uses `createImageBitmap(file, { resizeWidth })` + `OffscreenCanvas` to blur, watermark and encode (`convertToBlob`), and posts back `{ preview: Blob, thumb: Blob, width, height }`. Keep the existing main-thread path as the fallback when `OffscreenCanvas`/`createImageBitmap` are unavailable (older Safari). The decode gate (max 2 in flight) becomes a pool of two workers. HEIC: if the worker cannot decode it, fall back to the main-thread path for that file only.

### F7 · Frame budget during a batch — W1-C
Target: no frame over 32 ms during a 30-photo upload. Coalesce DOM writes (row status, progress bar, speed/ETA) into one `requestAnimationFrame` write per frame; never read layout inside a loop that also writes; put `content-visibility:auto; contain-intrinsic-size: 0 64px` on queue rows; revoke object URLs as soon as a row's thumbnail is painted. Record a Chrome performance trace of a 30-photo upload into `zz-test-w1c` before and after (the shared tool in the scratchpad can record traces) and report the longest frame of each in the handoff.

### F8 · Queue thumbnails — W1-C
Queue rows currently create an `<img>` with a full-size object URL per selected file, so 300 selected files trigger 300 full decodes. Generate small (≈96 px) thumbs lazily with an `IntersectionObserver` from the same worker (or `createImageBitmap` with `resizeWidth`), and release them when rows leave the viewport or are removed.

### F9 · Keep the pipeline busy — W1-C
Preview generation should run ahead of the uploads (bounded prefetch of 2–3 previews) so the upload workers never wait for a decode and decodes never wait for the network. Measure a 30-photo batch wall-clock before and after on the same connection and report it.

### F10 · Token expiry mid-batch — W1-C
If the crew token expires mid-batch, every remaining file 401s and the batch is lost. Before starting a batch, ping a cheap authenticated endpoint (`GET /api/admin/dashboard` is acceptable) and, on 401, show the login inline and resume. Mid-batch, a 401 pauses the queue (does not fail the files), shows an inline "Sign in again to continue" panel, and resumes the remaining files after a successful login. The draft session and already-uploaded files are kept.

### F11 · Finished while away — W1-C
When a batch finishes or fails while the tab is hidden, prefix `document.title` with "✓ Published · " or "⚠ Upload stopped · " and restore it on `visibilitychange`/focus. Fire a `Notification` only if permission is already granted — never prompt for it.

### F12 · Retry failed inline — W1-C
The Upload tab's end-of-batch summary lists failures but the only "Retry failed" lives in the Upload-more modal. Add an inline "Retry failed (n)" button in the Upload tab summary that re-queues only the failed files against the same draft.

### F13 · Progress copy — W1-C
Progress shows % / KB/s / ETA. Add "n of N photos · x of y MB", keep per-row ticks, and make the progress line an `aria-live="polite"` region updated at most every 2 seconds so screen readers are not flooded.

### F14 · Warning status and chip contrast — W1-C (admin lines) + W1-D (public lines)
- **Admin (W1-C):** the "n files left out" status uses the `warning` kind — make sure it is visually distinct from the error style (ochre rule, not coral) and passes WCAG AA (4.5:1) for its text. Audit every status chip / badge (`.indexing-badge`, `.studio-badge`, `.photo-badge`, session status pills, `.review-score`) with computed colours and fix any pair under 4.5:1 (small text) or 3:1 (≥ 18.66 px bold / 24 px).
- **Public (W1-D):** the how-it-works copy measures 3.6:1 on its dark panel — raise to ≥ 4.5:1. Check `.eyebrow` (slate-deep on linen), `.lightbox-hint` (`#F2ECDB80` on the lightbox backdrop), `.hero-note`, `.ticker`, figcaptions and the checkout dialog help text. Report each pair's before/after ratio.

### F15 · Results padding under the sticky bar — W1-D
`soi-tokens.css` sets `.results{padding-bottom:96px}` for the mobile action bar, but the later `site.css` `.section` rule (equal specificity, loaded after) wins, so the last caption sits under the 73 px bar. Fix with a rule that wins by cascade order or specificity and add `env(safe-area-inset-bottom)`; verify with computed style at 375×812 with results visible.

### F16 · Crew login link — W1-D
The public footer links "Crew login ↗" to `admin.html` (which is `noindex`). Remove it from the public footer; keep a plain link on `about.html` (owned by nobody this wave — request via handoff if you cannot edit it, otherwise leave it) so the crew can still find the studio.

### F17 · No informational text under 11 px — W1-C (admin) + W1-D (public)
- **Admin:** `.back-link,.sign-out-btn` 9 px, `.photo-badge` 10 px, `.review-score` 10 px, `.review-zoom label` 10 px (mobile), `.photo-row` 11 px is fine, tab labels 10 px on mobile → all to ≥ 11 px (13 px for tab labels), keeping the layout at 375 px intact.
- **Public:** `.brand small` is 9 px (7 px at ≤ 650 px), `.session-date small` 9 px, `.session-card small` 10 px, `.eyebrow` 10 px, `.session-picker legend` 10 px, `.motion-toggle span` 9 px (icon glyph — may stay if `aria-hidden`). Raise informational text to ≥ 11 px; purely decorative text may instead be hidden at narrow widths. Screenshot header and session cards at 375 before/after.

### F18 · Zero layout shift in the finder — W1-D
Two CLS sources: (a) the session-list skeleton always renders two 92 px rows although there is usually one session — render the skeleton row count from a `sessionStorage` cache of the last real count (default 1); (b) the selfie stage (~520 px) swaps to the matching stage (~380 px) on every search — set `#matchingStage{min-height:var(--stage-h)}` from the selfie stage's measured height before swapping. Verify with a Layout Instability observer (`PerformanceObserver` `layout-shift`) that CLS is 0 through select → selfie → matching at 375 and 1024.

### F19 · Fonts — W2-A (wave 2)
Cut to Plus Jakarta Sans 400/600/700 and Fraunces 500 + italic, self-host under `assets/fonts/` with `font-display:swap`, preload the two above-the-fold faces, `font-src 'self'` in both CSP files, remap `font-weight:500/800` to the nearest kept weight.

### F20 · Hero image responsive + preload — W1-D (markup) + W1-E (files)
W1-E exports `assets/brand-surf-wide-768.webp` and `assets/brand-surf-wide-1280.webp` from `assets/brand-surf-wide.webp` (quality ~78, keep aspect). W1-D adds `srcset="assets/brand-surf-wide-768.webp 768w, assets/brand-surf-wide-1280.webp 1280w, assets/brand-surf-wide.webp 1920w" sizes="100vw"` on the hero `<img>` and a `<link rel="preload" as="image" imagesrcset="…" imagesizes="100vw">` in `<head>`. Above-the-fold image bytes at 375 px must be under 120 KB.

### F21 · Fingerprinted build — W1-E
`scripts/build.mjs` hashes JS and CSS into `dist/` (`app.3f2a1b.js`) and rewrites references in the copied HTML (including `<link rel=preload>` and `<script>`), so source files stay unhashed for the dev server. `.htaccess` and `vercel.json` get `Cache-Control: public, max-age=31536000, immutable` for hashed assets while HTML stays `no-cache, must-revalidate`. Document that Hostinger must now be deployed from `dist/`. `npm run build` output must pass `tests/site.test.mjs` logic (every referenced asset exists in `dist/`).

## Public site (continued)

### F22 · Privacy link cancels a running search — W1-D
Any `#` link click aborts a search and shows the finder; the `#privacy` link inside the consent label triggers this while a guest reads the privacy copy. Exclude links inside `#searchForm` (and `#results`) from that handler; the privacy link should scroll to the section without touching the search.

### F23 · Drag-and-drop selfie — W1-D
`.upload-zone` has no `dragover`/`drop` listeners. Add them (desktop), with the `is-dragover` state, reusing the same validation as the file input. Keyboard and touch paths unchanged.

### F24 · Hit targets — W1-D
`.nav-toggle` to 48×48, lightbox close/prev/next to 48 px, favourite button ≥ 44 px at 375 px, every `.text-button` `min-height:44px`. Verify with `getBoundingClientRect()` at 375×812 and list the sizes in the handoff.

### F25 · Lightbox swipe velocity and pointer-aware hint — W1-D
A fast flick (≥ 0.5 px/ms over ≥ 20 px) should advance to the neighbour even when the drag is under 40 px. The hint text mentions "← →" keys on phones: show "Swipe for more · tap to zoom" on coarse pointers and the key hint on fine pointers.

### F26 · Gallery grid density and empty states — W1-D
At ≥ 1280 px use `grid-template-columns:repeat(auto-fill,minmax(220px,1fr))` (three fixed columns look sparse) without introducing layout shift on image load (tiles keep their `aspect-ratio`). The "No favourites yet" empty state uses the seashell stamp and the zero-match state the starfish stamp (verify both exist and render). The checkout dialog heading shows the count and price ("12 photos · ₹700"); W3-A expands this into the full trust block later.

## Crew studio (continued)

### F27 · Focus management — W1-C
Login: focus the password field on load. Create session: focus the title field when the Upload tab opens. Edit modal: focus the first field. Toasts with an action: the action button is reachable with Tab and the toast is `role=status`. After deleting a session, focus moves to the next card (or the tab) rather than being lost.

### F28 · "More" menu flips — W1-C
The `<details class="card-more">` menu opens downwards and is clipped at the bottom of the viewport / right edge on phones. On open, measure and add `.is-up` / `.is-left` so it stays on screen; close on outside click and Escape; only one open at a time.

### F29 · Duplicate-session warning — W1-C
Before creating a session, compare the loaded sessions list for the same date + location (case-insensitive, trimmed). If one exists, show a confirm: "A session at Mulki Beach on 17 Sept already exists — create another?" with a second action "Upload more to that session" that opens the existing Upload-more flow. Test with a unit test on the pure comparison helper if the file structure allows it; otherwise verify against `zz-test-w1c`.

### F30 · Undo the last review decision (Z) — W2-C (endpoint) + W2-D (client)
`POST /api/admin/undo-review { faceId }` reverts the last confirm/reject on that face (restores the previous `match_feedback`/link state) within 10 minutes of the decision; the review queue's `Z` key calls it and re-inserts the card at the top. The client shows "Undone" as a toast.

### F31 · Reserved — not scheduled
Kept for the original spec's F31 (unknown). Nothing in waves 1–4 depends on it. If the original file turns up, schedule it in the wave that owns its files.
