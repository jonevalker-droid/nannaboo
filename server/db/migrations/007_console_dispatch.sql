-- 007: security console (Prompt 6) — incident dispatch assignment.
-- Nearest-available-staff dispatch pins one staff session to an incident.
ALTER TABLE incident_log
  ADD COLUMN assigned_staff_id uuid REFERENCES staff_session(id),
  ADD COLUMN assigned_at timestamptz;

CREATE INDEX incident_log_assigned_ix
  ON incident_log (assigned_staff_id) WHERE assigned_staff_id IS NOT NULL;
