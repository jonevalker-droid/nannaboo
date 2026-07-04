// identified_security_roster consent (Prompt 6). This is the ONLY guest
// scope that exposes identity to staff, so it is an explicit opt-in from the
// guest app (never implied by joining, unlike friend_sharing and
// venue_safety_network). Dual backend: consent_grant rows in DB mode, a
// per-event set in memory mode. Reads for staff go through db/access.js —
// this module only records the guest's choice.
import * as db from './db/index.js';

const memoryGrants = new Set(); // `${guestId}|${eventKey}`

const key = (guestId, eventKey) => `${guestId}|${eventKey}`;

export async function setRosterConsent(guestId, eventId, eventKey, grant) {
  if (db.enabled && eventId) {
    if (grant) {
      await db.grantConsent(guestId, eventId, 'identified_security_roster');
    } else {
      await db.getPool().query(
        `UPDATE consent_grant SET revoked_at = now()
         WHERE guest_id = $1 AND scope = 'identified_security_roster'
           AND (event_id IS NULL OR event_id = $2) AND revoked_at IS NULL`,
        [guestId, eventId]
      );
    }
    return;
  }
  if (grant) memoryGrants.add(key(guestId, eventKey));
  else memoryGrants.delete(key(guestId, eventKey));
}

/** Memory-mode check (DB mode enforces consent in access.js SQL instead). */
export function hasRosterConsent(guestId, eventKey) {
  return memoryGrants.has(key(guestId, eventKey));
}
