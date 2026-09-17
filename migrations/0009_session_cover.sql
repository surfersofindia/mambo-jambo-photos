-- 0009: crew-chosen cover photo per session (shown on the public landing page).
-- Apply once: npx wrangler d1 execute mambo-jambo-photos --remote --file=migrations/0009_session_cover.sql
-- The Worker detects the column at runtime; without it, session cards show the brand illustration.
ALTER TABLE sessions ADD COLUMN cover_photo_id TEXT REFERENCES photos(id) ON DELETE SET NULL;
