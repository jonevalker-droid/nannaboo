-- 012: reunion retention — keep raw position history for the full 72h
-- Valker weekend (was 48h). Still runtime-configurable via
-- PUT /api/venue/retention; this only moves venues still on the old default,
-- so a manually tuned value is left alone.
UPDATE venue SET position_retention_hours = 72 WHERE position_retention_hours = 48;
ALTER TABLE venue ALTER COLUMN position_retention_hours SET DEFAULT 72;
