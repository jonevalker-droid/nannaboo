// Security/admin data-layer foundation (Prompt 4b — the full console is
// Prompt 6). Proves the two distinct query paths at the API level:
//   GET /positions -> ANONYMIZED dots: position only, no id/name/photo, for
//                     every guest with venue_safety_network consent (granted
//                     implicitly at join). Guest visibility_mode does NOT
//                     apply to this layer — it governs guest-to-guest only.
//   GET /roster    -> IDENTIFIED list: only guests who additionally granted
//                     identified_security_roster (nobody does yet — the
//                     grant UI ships with the Prompt 6 console), audited per
//                     row by access.js.
// DB mode goes through server/db/access.js exclusively (consent enforced in
// SQL, identified reads audited). In-memory mode mirrors the same contract
// from live state: joining == venue_safety_network consent, and the
// identified roster is empty because that scope can't be granted yet.
import { Router } from 'express';
import * as db from '../db/index.js';
import * as access from '../db/access.js';
import * as geofence from '../geofence.js';
import * as staffAuth from '../staffAuth.js';

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

let warnedOpenAdmin = false;
function requireAdmin(req, res, next) {
  const key = process.env.ADMIN_KEY;
  if (!key) {
    if (!warnedOpenAdmin) {
      console.warn('[security] ADMIN_KEY not set — security routes are unprotected (prototype mode)');
      warnedOpenAdmin = true;
    }
    return next();
  }
  if (req.get('x-admin-key') === key || req.query.key === key) return next();
  res.status(401).json({ error: 'admin key required' });
}

export default function createSecurityRouter({ getLiveGroup }) {
  const router = Router();

  // Bootstrap a staff session (stand-in for real staff auth; the dashboard
  // signs in with the returned id).
  router.post('/session', requireAdmin, wrap(async (req, res) => {
    const role = staffAuth.STAFF_ROLES.includes(req.body?.role)
      ? req.body.role : 'security';
    const name = String(req.body?.name ?? 'Field test').slice(0, 60);
    const hours = Math.min(24, Math.max(1, Number(req.body?.hours) || 8));
    if (db.enabled) {
      const { rows } = await db.getPool().query(
        `INSERT INTO staff_session (venue_id, display_name, role, access_expires_at)
         VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval)
         RETURNING id, role, access_expires_at`,
        [db.getDefaultVenueId(), name, role, hours]
      );
      return res.status(201).json({ session: rows[0] });
    }
    res.status(201).json({ session: staffAuth.createMemorySession(name, role, hours), memoryMode: true });
  }));

  const memorySession = (id) => staffAuth.getStaffSession(id); // async, memory-backed here

  // ANONYMIZED path: position-only dots, on site (inside the fence).
  router.get('/positions', wrap(async (req, res) => {
    const code = String(req.query.code ?? '').toUpperCase().trim();
    const sessionId = String(req.query.session ?? '');
    if (!code) return res.status(400).json({ error: 'code (group code) required' });
    if (db.enabled) {
      const eventId = await db.ensureEventForGroup(code);
      const positions = await access.listSafetyNetworkPositions({
        staffSessionId: sessionId, eventId,
      });
      return res.json({ positions, path: 'anonymized' });
    }
    if (!(await memorySession(sessionId))) return res.status(403).json({ error: 'invalid staff session' });
    const group = getLiveGroup(code);
    const positions = [];
    for (const g of group?.guests.values() ?? []) {
      if (g.lat == null || !geofence.contains(g.lat, g.lng)) continue;
      // Position only — id and name intentionally never leave this endpoint.
      positions.push({ lat: g.lat, lng: g.lng, recordedAt: g.lastSeen });
    }
    res.json({ positions, path: 'anonymized' });
  }));

  // IDENTIFIED path: requires the guest's identified_security_roster consent.
  router.get('/roster', wrap(async (req, res) => {
    const code = String(req.query.code ?? '').toUpperCase().trim();
    const sessionId = String(req.query.session ?? '');
    if (!code) return res.status(400).json({ error: 'code (group code) required' });
    if (db.enabled) {
      const eventId = await db.ensureEventForGroup(code);
      const roster = await access.listIdentifiedRoster({
        staffSessionId: sessionId, eventId,
      });
      return res.json({ roster, path: 'identified' });
    }
    const sess = await memorySession(sessionId);
    if (!sess) return res.status(403).json({ error: 'invalid staff session' });
    // Identified data is Security-role only, even when the list is empty.
    if (sess.role !== 'security') {
      return res.status(403).json({ error: `role '${sess.role}' not permitted` });
    }
    // No in-memory guest has (or can yet grant) identified_security_roster.
    res.json({ roster: [], path: 'identified' });
  }));

  router.use((err, _req, res, _next) => {
    if (err instanceof access.AccessDeniedError) {
      return res.status(403).json({ error: err.message });
    }
    console.error('[security]', err);
    res.status(500).json({ error: 'internal error' });
  });

  return router;
}
