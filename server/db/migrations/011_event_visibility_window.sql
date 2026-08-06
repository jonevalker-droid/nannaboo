-- 011: per-event visibility window (Valker Family Reunion setup).
-- this_event_only friend links stay live for as long as the event row stays
-- active. Events now close automatically once their window lapses (the next
-- join opens a fresh one, which is what "resets" friend visibility): default
-- 24h, VALK2026 gets 72h — seeded lazily by EVENT_PRESETS in db/index.js.
ALTER TABLE event
  ADD COLUMN IF NOT EXISTS visibility_window_hours integer NOT NULL DEFAULT 24;
