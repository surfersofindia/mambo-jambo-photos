-- 0008: small watermarked thumbnails for grid tiles, and per-IP crew login throttling.
-- Apply once to an existing database:
--   npx wrangler d1 execute mambo-jambo-photos --remote --file=migrations/0008_thumbnails_and_login_throttle.sql
-- The Worker detects photos.thumb_key at runtime, so deploying it before this migration is safe
-- (tiles simply keep using the 1400px preview until thumbnails exist).
ALTER TABLE photos ADD COLUMN thumb_key TEXT;
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
