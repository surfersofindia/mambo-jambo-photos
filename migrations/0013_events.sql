-- 0013: guest funnel events and the review-undo bookkeeping column.
-- Apply once: npx wrangler d1 execute mambo-jambo-photos --remote --file=migrations/0013_events.sql
-- The Worker records events with a try/catch (a missing table only logs a warning) and
-- GET /api/admin/stats answers { sessions: [], totals: {…zeros}, unmigrated: true } until this lands.

-- One row per funnel step, written server-side by the existing handlers: `search` when a search
-- row is created, then `match` (≥ 1 photo) or `zero_match` (0 photos); `checkout` on
-- POST /api/checkout; `paid` exactly once per payment when it becomes captured (verify or webhook,
-- whichever transitions the payment row first); `download` per original served with ?download=1
-- and once per ZIP. Never a selfie, phone number or IP address — ids and a timestamp only.
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('search', 'match', 'zero_match', 'checkout', 'paid', 'download')),
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  search_id TEXT REFERENCES searches(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS events_by_session_kind ON events(session_id, kind);

-- Belongs with the undo feature (POST /api/admin/undo-review): the face_verifications or
-- photo_links id whose crew decision inserted this feedback row, so an undo can remove exactly
-- that row. Rows written before this column existed stay NULL; the Worker then falls back to the
-- newest row with the same source, score and label from the last ten minutes.
ALTER TABLE match_feedback ADD COLUMN subject_id TEXT;
