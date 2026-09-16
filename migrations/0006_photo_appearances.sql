-- Per-photo clothing/body appearance descriptor (HSV color histogram of the dominant detected
-- person), used as a fallback matching signal when a photo has no usable face. One row per photo;
-- re-indexing replaces it.
CREATE TABLE IF NOT EXISTS photo_appearances (
  photo_id TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  bbox_json TEXT,
  histogram_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
