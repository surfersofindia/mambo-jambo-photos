-- 0015: guest second-chance and crew support tooling.
-- Apply once: npx wrangler d1 execute mambo-jambo-photos --remote --file=migrations/0015_support.sql
-- The Worker checks for these at runtime: before this lands the colour search still answers (its list
-- is not persisted), hide/notify/refund/grant answer 503 naming this migration, and lookup/stats
-- degrade to zero counts. GET /api/health reports `migrations.support` once everything below exists.

-- The guest's "Not me, hide" on a result tile: the photo id leaves the search's matched/colour
-- lists and is remembered here so a later colour search never brings it back. `similarity` is the
-- score the guest saw (0–1) when the client sends it, else NULL. match_feedback is not used: its
-- `source` CHECK has no guest-hide kind and rebuilding that table is out of scope.
CREATE TABLE IF NOT EXISTS match_hides (
  id TEXT PRIMARY KEY,
  search_id TEXT NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  photo_id TEXT NOT NULL,
  similarity REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS match_hides_by_search ON match_hides(search_id);

-- "Tell me when the crew re-indexes": one row per search (the phone is replaced on a repeat), the
-- only place a guest phone number is stored on purpose; support responses mask it.
CREATE TABLE IF NOT EXISTS notify_requests (
  id TEXT PRIMARY KEY,
  search_id TEXT NOT NULL UNIQUE REFERENCES searches(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notified_at TEXT
);

-- Cashfree refunds issued from the studio (POST /api/admin/payments/:id/refund). `id` is the
-- refund_id sent to Cashfree (idempotent per order); `status` follows Cashfree's refund_status
-- (PENDING → SUCCESS | CANCELLED | ONHOLD | FAILED) via the REFUND_STATUS_WEBHOOK.
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  cashfree_refund_id TEXT,
  amount_paise INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS refunds_by_payment ON refunds(payment_id);

-- Free unlocks (POST /api/admin/searches/:id/grant). payments.status has a CHECK without a
-- 'granted' value, so a grant is its own row: no payments row, no `paid` event, no rupees —
-- GET /api/admin/stats counts them separately as `grants`.
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  search_id TEXT NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The colour search's ranked photo ids (POST /api/searches/:id/colour), kept beside the face
-- matches so /previews, /access and the ZIP include what the guest actually saw and paid for.
ALTER TABLE searches ADD COLUMN colour_photo_ids_json TEXT;
-- When the most recent 30-day gallery link (from /access, a resend or a grant) expires, for support.
ALTER TABLE searches ADD COLUMN gallery_link_expires_at TEXT;
-- The mobile number the guest typed at checkout (it already goes to Cashfree as customer_phone),
-- so support can find a guest's searches by phone. Masked in every response.
ALTER TABLE payments ADD COLUMN customer_phone TEXT;
