// Shared staff-session auth (Prompt 6 dashboard). One place validates a
// staff session for Express routes, in both backends:
//  - DB mode: the staff_session row (revocation + expiry enforced in SQL)
//  - in-memory mode: sessions minted by POST /api/security/session
// Routers gate ROLE here; anything identified goes further through
// db/access.js, which re-checks the role inside the same transaction that
// writes the audit_log row — so a UI (or curl) without the Security role is
// structurally unable to reach identified data, not just un-linked to it.
import { randomUUID } from 'crypto';
import * as db from './db/index.js';

export const STAFF_ROLES = ['security', 'admin', 'promoter'];

const memorySessions = new Map(); // id -> { role, name, expiresAt }

export function createMemorySession(name, role, hours) {
  const id = randomUUID();
  memorySessions.set(id, { role, name, expiresAt: Date.now() + hours * 3_600_000 });
  return { id, role };
}

/** Resolve an active staff session -> { id, role, displayName } or null. */
export async function getStaffSession(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  if (db.enabled) {
    if (!db.isUuid(sessionId)) return null;
    const { rows } = await db.getPool().query(
      `SELECT id, role, display_name
       FROM staff_session
       WHERE id = $1 AND revoked_at IS NULL AND access_expires_at > now()`,
      [sessionId]
    );
    return rows.length
      ? { id: rows[0].id, role: rows[0].role, displayName: rows[0].display_name }
      : null;
  }
  const s = memorySessions.get(sessionId);
  return s && s.expiresAt > Date.now()
    ? { id: sessionId, role: s.role, displayName: s.name }
    : null;
}

/** Express middleware: require an active staff session (optionally role-limited). */
export function requireStaff(roles = null) {
  return async (req, res, next) => {
    try {
      const sessionId = req.get('x-staff-session') || req.query.session;
      const staff = await getStaffSession(sessionId);
      if (!staff) return res.status(401).json({ error: 'active staff session required' });
      if (roles && !roles.includes(staff.role)) {
        return res.status(403).json({ error: `role '${staff.role}' not permitted here` });
      }
      req.staff = staff;
      next();
    } catch (err) {
      next(err);
    }
  };
}
