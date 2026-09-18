-- 0012: pixel dimensions of every uploaded original, so guest tiles and the crew grid can reserve
-- the photo's real aspect ratio instead of cropping to 4:3. The Worker fills them at upload time
-- from the original's JPEG / PNG / WebP header (the first 64 KB of the streamed body; EXIF
-- orientation 5–8 swaps them) and falls back to the crew studio's ?width=&height= hint only when
-- the header cannot be parsed. Photos uploaded before this migration keep NULL, which the API
-- returns as `width: null, height: null`.
-- Apply once: npx wrangler d1 execute mambo-jambo-photos --remote --file=migrations/0012_photo_dimensions.sql
-- The Worker detects the columns at runtime (hasColumn), so it can be deployed before or after this.
ALTER TABLE photos ADD COLUMN width INTEGER;
ALTER TABLE photos ADD COLUMN height INTEGER;
