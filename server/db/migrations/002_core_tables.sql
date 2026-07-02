-- 002: core tables
-- Phase 1 uses one venue and one event per group code, but every row is
-- venue/event-scoped so Phase 2 (security roster + incidents) and Phase 3
-- (multi-venue) are additive, not a rewrite.

CREATE TABLE venue (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  timezone    text NOT NULL DEFAULT 'UTC',
  center      geography(Point, 4326),
  boundary    geography(Polygon, 4326),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE event (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id    uuid NOT NULL REFERENCES venue(id),
  name        text NOT NULL,
  group_code  text,               -- Phase 1 join code; NULL for ticketed events later
  starts_at   timestamptz,
  ends_at     timestamptz,        -- NULL = active
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- Join flow only carries a code (no venue), so codes must be unique among active events.
CREATE UNIQUE INDEX event_active_group_code_uq
  ON event ((upper(group_code))) WHERE group_code IS NOT NULL AND ends_at IS NULL;
CREATE INDEX event_venue_ix ON event (venue_id);

CREATE TABLE zone (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id    uuid NOT NULL REFERENCES venue(id) ON DELETE CASCADE,
  name        text NOT NULL,
  boundary    geography(Polygon, 4326) NOT NULL,
  capacity    integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX zone_boundary_gix ON zone USING GIST (boundary);

CREATE TABLE poi (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id    uuid NOT NULL REFERENCES venue(id) ON DELETE CASCADE,
  zone_id     uuid REFERENCES zone(id) ON DELETE SET NULL,
  category    poi_category NOT NULL,
  name        text NOT NULL,
  location    geography(Point, 4326) NOT NULL,
  live_status text,               -- e.g. 'long line', 'closed until 6pm'
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX poi_location_gix ON poi USING GIST (location);
CREATE INDEX poi_venue_category_ix ON poi (venue_id, category);

CREATE TABLE guest (
  id            uuid PRIMARY KEY,  -- client-generated (localStorage nb_guest_id), validated server-side
  display_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consent_grant (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id    uuid NOT NULL REFERENCES guest(id) ON DELETE CASCADE,
  event_id    uuid REFERENCES event(id) ON DELETE CASCADE,  -- NULL = not event-scoped
  scope       consent_scope NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  revoked_at  timestamptz,
  CHECK (expires_at IS NULL OR expires_at > granted_at)
);
CREATE INDEX consent_grant_active_ix
  ON consent_grant (guest_id, scope) WHERE revoked_at IS NULL;

CREATE TABLE friend_link (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id        uuid NOT NULL REFERENCES guest(id) ON DELETE CASCADE,  -- the sharer
  friend_guest_id uuid NOT NULL REFERENCES guest(id) ON DELETE CASCADE,  -- who may see them
  event_id        uuid REFERENCES event(id) ON DELETE CASCADE,
  sharing_level   sharing_level NOT NULL DEFAULT 'off',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (guest_id <> friend_guest_id),
  CHECK (sharing_level <> 'this_event_only' OR event_id IS NOT NULL),
  UNIQUE NULLS NOT DISTINCT (guest_id, friend_guest_id, event_id)
);
CREATE INDEX friend_link_viewer_ix ON friend_link (friend_guest_id);

CREATE TABLE position_fix (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guest_id    uuid NOT NULL REFERENCES guest(id) ON DELETE CASCADE,
  event_id    uuid REFERENCES event(id) ON DELETE CASCADE,
  location    geography(Point, 4326) NOT NULL,
  accuracy_m  real,
  heading     real,
  source      position_source NOT NULL,
  confidence  real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX position_fix_guest_time_ix ON position_fix (guest_id, recorded_at DESC);
CREATE INDEX position_fix_event_time_ix ON position_fix (event_id, recorded_at DESC);
CREATE INDEX position_fix_location_gix ON position_fix USING GIST (location);

CREATE TABLE staff_session (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id          uuid NOT NULL REFERENCES venue(id),
  event_id          uuid REFERENCES event(id),
  display_name      text NOT NULL,
  role              staff_role NOT NULL,
  token_hash        text,           -- never store the raw credential
  access_expires_at timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz
);
CREATE INDEX staff_session_active_ix
  ON staff_session (venue_id, role) WHERE revoked_at IS NULL;

CREATE TABLE incident_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id         uuid NOT NULL REFERENCES venue(id),
  event_id         uuid REFERENCES event(id),
  zone_id          uuid REFERENCES zone(id) ON DELETE SET NULL,
  reported_by      uuid REFERENCES staff_session(id),
  subject_guest_id uuid REFERENCES guest(id),
  category         text NOT NULL,
  description      text,
  location         geography(Point, 4326),
  status           incident_status NOT NULL DEFAULT 'open',
  created_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz
);
CREATE INDEX incident_log_event_ix ON incident_log (event_id, status);

-- Written by the access-control helper on every identified-guest lookup.
CREATE TABLE audit_log (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor                  text NOT NULL,  -- staff_session id, guest id, or 'system'
  actor_staff_session_id uuid REFERENCES staff_session(id),
  target_guest_id        uuid REFERENCES guest(id),
  action                 text NOT NULL,
  detail                 jsonb,
  at                     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_target_ix ON audit_log (target_guest_id, at DESC);
CREATE INDEX audit_log_actor_ix ON audit_log (actor, at DESC);

-- App table for the existing shared-pins feature (guest-created, max 3 per
-- group enforced in the app layer). Distinct from poi, which is venue infrastructure.
CREATE TABLE pin (
  id         uuid PRIMARY KEY,
  event_id   uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  label      text NOT NULL,
  location   geography(Point, 4326) NOT NULL,
  created_by uuid REFERENCES guest(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pin_event_ix ON pin (event_id);
