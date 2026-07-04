-- 008: consent & onboarding (Prompt 7) — data retention + medical profile.

-- Raw location logs are purged after a per-venue window (hours). 48h default;
-- configurable via PUT /api/venue/retention — never hardcoded in app logic.
ALTER TABLE venue
  ADD COLUMN position_retention_hours integer NOT NULL DEFAULT 48;

-- Aggregated, anonymized analytics survive the raw purge: the purge job
-- rolls an event's aggregates up here BEFORE deleting its expired
-- position_fix rows. Nothing in this table identifies a guest.
CREATE TABLE analytics_rollup (
  event_id        uuid PRIMARY KEY REFERENCES event(id) ON DELETE CASCADE,
  dwell           jsonb NOT NULL,
  entries_by_hour jsonb NOT NULL,
  exits_by_hour   jsonb NOT NULL,
  peak_windows    jsonb NOT NULL,
  rolled_at       timestamptz NOT NULL DEFAULT now()
);

-- Persistent medical profile (distinct from the ephemeral SOS-time note,
-- which lives in incident_log.description). AES-256-GCM ciphertext — the
-- plaintext never touches the database. Writing it REQUIRES an active
-- identified_security_roster grant (enforced in consentStore.setMedicalInfo);
-- reading it happens only through the audited identified paths in access.js.
ALTER TABLE guest
  ADD COLUMN medical_info_enc text;

-- Its own consent scope, granted/revoked alongside the profile text.
-- (PG12+ allows ADD VALUE inside a transaction as long as the new value
-- isn't used in the same transaction — it isn't.)
ALTER TYPE consent_scope ADD VALUE IF NOT EXISTS 'medical_info';
