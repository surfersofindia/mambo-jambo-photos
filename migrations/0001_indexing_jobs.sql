CREATE TABLE IF NOT EXISTS indexing_jobs (
  photo_id TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','processing','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS indexing_jobs_status ON indexing_jobs(status);
