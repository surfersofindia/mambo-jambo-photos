-- Logs every crew confirm/reject decision (face pairs and burst/appearance links) with its
-- feature value, so match_weights can be periodically refit from accumulated review outcomes.
-- A row only ever has one of the three feature columns set — the signal types never co-occur on
-- a single review — so one combined logistic regression naturally learns independent weights
-- per signal without needing separate models.
CREATE TABLE IF NOT EXISTS match_feedback (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('face_pair', 'burst_link', 'appearance_link')),
  face_similarity REAL,
  burst_score REAL,
  appearance_similarity REAL,
  label INTEGER NOT NULL CHECK (label IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Singleton row of fitted scoring weights. Defaults mean "act exactly as before" until there is
-- enough review data to retrain (see MIN_FEEDBACK_FOR_TRAINING in worker.js).
CREATE TABLE IF NOT EXISTS match_weights (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  face_weight REAL NOT NULL DEFAULT 1,
  burst_weight REAL NOT NULL DEFAULT 0,
  appearance_weight REAL NOT NULL DEFAULT 0,
  bias REAL NOT NULL DEFAULT 0,
  trained_on INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO match_weights (id) VALUES (1);
