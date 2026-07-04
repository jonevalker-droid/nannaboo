-- 009: 'vendor' POI category (commercial vendors — food trucks, merch booths).
-- Enum value only: migration 010's CHECK constraint compares against this
-- value, and PG refuses to use a new enum value inside the transaction that
-- added it — the runner gives each file its own transaction, so split them.

ALTER TYPE poi_category ADD VALUE IF NOT EXISTS 'vendor';
