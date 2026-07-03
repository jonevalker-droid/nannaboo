-- 006: guest-level visibility tier (Prompt 4b).
-- Separate from the per-friend friend_link.sharing_level, which can still
-- override DOWN toward a specific friend whatever the general mode is:
--   public       -> marker visible to any guest at the same event
--   friends_only -> marker visible only to accepted friends
--   off          -> never shown to other guests, in any layer
-- Default 'public' preserves the shipped behavior (everyone in the group
-- sees everyone) for guests who never touch the picker.
CREATE TYPE visibility_mode AS ENUM ('public', 'friends_only', 'off');

ALTER TABLE guest
  ADD COLUMN visibility_mode visibility_mode NOT NULL DEFAULT 'public';
