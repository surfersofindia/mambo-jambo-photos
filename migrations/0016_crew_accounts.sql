-- 0016: per-crew accounts with TOTP, and an audit log.
-- Apply once: npx wrangler d1 execute mambo-jambo-photos --remote --file=migrations/0016_crew_accounts.sql
-- Deploy the Worker after it (admin_sessions.user_id/role presence is cached per isolate).
-- Nothing here locks anyone out: while this migration is missing, or while crew_users holds no
-- enabled account, or while the Worker var LEGACY_SHARED_LOGIN is 'true', the shared ADMIN_PASSWORD
-- keeps signing the crew in as an admin (audited as 'crew (shared)'). Once every crew member has an
-- account, unset LEGACY_SHARED_LOGIN (or leave it unset) and the shared password stops working.

-- One row per crew member. Passwords are PBKDF2-SHA256 (WebCrypto, `iterations` rounds, 16-byte
-- salt, both hex); `totp_secret` is the base32 RFC 6238 secret, only enforced once `totp_enabled`
-- is 1 (the member confirms a code from their authenticator first). `disabled_at` keeps the row for
-- the audit log while refusing sign-in and revoking every session.
CREATE TABLE IF NOT EXISTS crew_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('photographer', 'admin')),
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TEXT,
  disabled_at TEXT
);

-- Who did what, to which record, from where. Written by the Worker's audit() helper for sign-ins
-- (failures record the attempted name truncated, never the password), deletes, refunds, grants,
-- publishes, TOTP enablement and account changes. Never fails the action it describes.
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail_json TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS audit_log_by_time ON audit_log(created_at);

-- Which account (and role) a crew session belongs to; NULL for the shared password.
ALTER TABLE admin_sessions ADD COLUMN user_id TEXT;
ALTER TABLE admin_sessions ADD COLUMN role TEXT;
