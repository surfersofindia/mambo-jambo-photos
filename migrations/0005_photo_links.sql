-- Photo-level fallback match candidates (burst-timing, later also appearance) for photos where
-- direct face matching isn't confident enough — reviewed by the crew before guests ever see them.
CREATE TABLE IF NOT EXISTS photo_links (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  photo1_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  photo2_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL CHECK (link_type IN ('burst', 'appearance')),
  score REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(photo1_id, photo2_id, link_type)
);
CREATE INDEX IF NOT EXISTS photo_links_by_status ON photo_links(status);
CREATE INDEX IF NOT EXISTS photo_links_by_photo1 ON photo_links(photo1_id);
CREATE INDEX IF NOT EXISTS photo_links_by_photo2 ON photo_links(photo2_id);
