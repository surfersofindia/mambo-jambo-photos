-- 0014: surf conditions and the next drop time on a session, entered by the crew and shown to guests.
-- Apply once: npx wrangler d1 execute mambo-jambo-photos --remote --file=migrations/0014_session_conditions.sql
-- The Worker detects break_name at runtime (hasColumn): before this lands, conditions fields are
-- refused with 503 on the crew routes and GET /api/sessions answers conditions: null, nextDropAt: null.
ALTER TABLE sessions ADD COLUMN break_name TEXT;      -- ≤ 60 chars
ALTER TABLE sessions ADD COLUMN swell_ft REAL;        -- 0–30, one decimal
ALTER TABLE sessions ADD COLUMN wind TEXT;            -- offshore | onshore | cross | glassy | light | strong, or free text ≤ 30
ALTER TABLE sessions ADD COLUMN tide TEXT;            -- low | mid | high | rising | dropping, or free text ≤ 30
ALTER TABLE sessions ADD COLUMN photographer TEXT;    -- ≤ 60 chars
ALTER TABLE sessions ADD COLUMN next_drop_at TEXT;    -- ISO 8601, when the next batch of photos is expected to land
