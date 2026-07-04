// identified_security_roster consent (Prompt 6). This is the ONLY guest
// scope that exposes identity to staff, so it is an explicit opt-in from the
// guest app (never implied by joining, unlike friend_sharing and
// venue_safety_network). Dual backend: consent_grant rows in DB mode, a
// per-event set in memory mode. Reads for staff go through db/access.js —
// this module only records the guest's choice.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import * as db from './db/index.js';

const memoryGrants = new Set();  // `${guestId}|${eventKey}`
const memoryMedical = new Map(); // guestId -> plaintext (RAM only — memory mode has no "at rest")

const key = (guestId, eventKey) => `${guestId}|${eventKey}`;

// ---- medical profile encryption (at rest, AES-256-GCM) ----
// Key derives from MEDICAL_INFO_KEY (preferred) or ADMIN_KEY. The dev
// fallback exists only so local no-env runs work; Render sets ADMIN_KEY.
const MEDICAL_KEY = createHash('sha256')
  .update(process.env.MEDICAL_INFO_KEY || process.env.ADMIN_KEY || 'nannaboo-dev-only')
  .digest();
if (!process.env.MEDICAL_INFO_KEY && !process.env.ADMIN_KEY) {
  console.warn('[medical] no MEDICAL_INFO_KEY/ADMIN_KEY set — using dev-only encryption key');
}

export function encryptMedical(text) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', MEDICAL_KEY, iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decryptMedical(b64) {
  if (!b64) return null;
  try {
    const raw = Buffer.from(b64, 'base64');
    const d = createDecipheriv('aes-256-gcm', MEDICAL_KEY, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null; // wrong key (rotated env) — unreadable, never throws into a request
  }
}

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

async function dbHasRosterConsent(guestId, eventId) {
  const { rows } = await db.getPool().query(
    `SELECT 1 FROM consent_grant
     WHERE guest_id = $1 AND scope = 'identified_security_roster'
       AND (event_id IS NULL OR event_id = $2)
       AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
     LIMIT 1`,
    [guestId, eventId]
  );
  return rows.length > 0;
}

/**
 * Persistent medical profile (Prompt 7) — distinct from the SOS-time note.
 * DATA-LAYER RULE, not just UI: writing medical info requires an ACTIVE
 * identified_security_roster grant — medical info security can't attach to
 * a person is useless, so the dependency is enforced here regardless of
 * what any client sends. null text clears the profile (always allowed).
 * Returns { ok, error? }.
 */
export async function setMedicalInfo(guestId, eventId, eventKey, text) {
  const clearing = text == null || text.trim() === '';
  if (db.enabled && eventId) {
    if (!clearing && !(await dbHasRosterConsent(guestId, eventId))) {
      return { ok: false, error: 'identity sharing with security must be on first' };
    }
    await db.getPool().query(
      'UPDATE guest SET medical_info_enc = $2 WHERE id = $1',
      [guestId, clearing ? null : encryptMedical(text.trim().slice(0, 500))]
    );
    if (clearing) {
      await db.getPool().query(
        `UPDATE consent_grant SET revoked_at = now()
         WHERE guest_id = $1 AND scope = 'medical_info' AND revoked_at IS NULL`,
        [guestId]
      );
    } else {
      await db.grantConsent(guestId, eventId, 'medical_info');
    }
    return { ok: true };
  }
  if (!clearing && !hasRosterConsent(guestId, eventKey)) {
    return { ok: false, error: 'identity sharing with security must be on first' };
  }
  if (clearing) memoryMedical.delete(guestId);
  else memoryMedical.set(guestId, text.trim().slice(0, 500));
  return { ok: true };
}

/** Memory-mode read (DB mode decrypts inside access.js identified paths). */
export function getMedicalInfo(guestId) {
  return memoryMedical.get(guestId) ?? null;
}
