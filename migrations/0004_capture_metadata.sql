-- Photo capture timestamp (from EXIF, extracted by the face service) powers burst-sequence
-- grouping. NULL for photos indexed before this migration, or with stripped/missing EXIF, until
-- the session is re-indexed.
ALTER TABLE photos ADD COLUMN captured_at TEXT;
CREATE INDEX IF NOT EXISTS photos_by_session_captured_at ON photos(session_id, captured_at);
