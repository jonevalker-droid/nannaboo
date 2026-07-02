-- 003: Phase 1 seed — the single venue all group-code events attach to.
-- Update name/timezone/center via SQL when the real venue details are known.

INSERT INTO venue (name, slug, timezone)
VALUES ('Lake Resort', 'lake-resort', 'UTC')
ON CONFLICT (slug) DO NOTHING;
