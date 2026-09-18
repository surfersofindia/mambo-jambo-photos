-- 0010: per-client request quotas (POST /api/match today; the colour search can reuse it later).
-- Apply once to an existing database, on its own, before deploying the Worker that uses it:
--   npx wrangler d1 execute mambo-jambo-photos --remote --file=migrations/0010_rate_limits.sql
-- The Worker's limiter fails open (with a console.warn) while this table is missing, so a deploy
-- that races the migration never blocks guest searches. One row per key, e.g. match:10m:<ip>.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_by_window ON rate_limits(window_start);
