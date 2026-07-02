-- 005: friend requests (mutual-accept handshake in front of friend_link).
-- Accepting creates TWO friend_link rows — one per direction — because each
-- guest controls their own sharing_level toward the other independently.

CREATE TYPE friend_request_status AS ENUM ('pending', 'accepted', 'declined');

CREATE TABLE friend_request (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_guest_id uuid NOT NULL REFERENCES guest(id) ON DELETE CASCADE,
  to_guest_id   uuid NOT NULL REFERENCES guest(id) ON DELETE CASCADE,
  event_id      uuid REFERENCES event(id) ON DELETE SET NULL,
  status        friend_request_status NOT NULL DEFAULT 'pending',
  created_at    timestamptz NOT NULL DEFAULT now(),
  responded_at  timestamptz,
  CHECK (from_guest_id <> to_guest_id)
);
-- One live request per direction; a declined pair can be re-requested later.
CREATE UNIQUE INDEX friend_request_pending_uq
  ON friend_request (from_guest_id, to_guest_id) WHERE status = 'pending';
CREATE INDEX friend_request_inbox_ix
  ON friend_request (to_guest_id) WHERE status = 'pending';

-- The friend-finder keeps exactly one link per (sharer, viewer) pair; the
-- link's event_id records where the friendship formed and scopes
-- this_event_only visibility. (Table is empty pre-launch, so this tightening
-- of the per-event uniqueness is safe.)
CREATE UNIQUE INDEX friend_link_pair_uq
  ON friend_link (guest_id, friend_guest_id);
