-- 0011: revocable crew sessions. Every admin token now carries the id of a row here and
-- POST /api/admin/logout sets revoked_at, so a leaked or finished token stops working server-side.
-- Apply once to an existing database, on its own, before deploying the Worker that uses it:
--   npx wrangler d1 execute mambo-jambo-photos --remote --file=migrations/0011_admin_sessions.sql
-- While the table is missing the Worker accepts signature-valid tokens (with a console.warn) so the
-- crew is never locked out. Tokens issued before the migration have no row here and are refused once
-- it is applied — the crew simply signs in again.
CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT,
  ip TEXT,
  user_agent TEXT
);
