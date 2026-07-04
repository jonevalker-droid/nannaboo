// Shared access-control helper. ALL reads of guest identity or position data
// for staff/friend features MUST go through this module — consent_grant scopes
// are enforced here in SQL, not in the UI. Every identified-guest lookup
// writes an audit_log row in the same transaction as the read.
//
// Phase 1's live family map doesn't call these paths yet (its visibility rule
// — everyone in your group code sees you — is backed by the implicit
// friend_sharing grant written on join). Phase 2 dashboards must build on
// these functions rather than querying position_fix/guest directly.
import { getPool, isUuid } from './index.js';
import { decryptMedical } from '../consentStore.js';

// Decrypt guest.medical_info_enc onto a row as medical_info (or null).
// Only ever called on rows that already passed an audited identified path.
const withMedical = (row) => {
  if (!row) return row;
  const { medical_info_enc, ...rest } = row;
  return { ...rest, medical_info: decryptMedical(medical_info_enc) };
};

export class AccessDeniedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AccessDeniedError';
  }
}

// Every identified read carries one of these in its audit row (Prompt 6).
// A missing/unknown code is an AccessDeniedError — the reason is part of the
// authorization, not decoration.
export const REASON_CODES = [
  'sos_response', 'medical', 'lost_person', 'wellness_check',
  'incident_investigation', 'dispatch', 'shift_handover', 'other',
];

export function requireReason(reasonCode) {
  if (!REASON_CODES.includes(reasonCode)) {
    throw new AccessDeniedError(
      `a reason code is required: ${REASON_CODES.join(', ')}`
    );
  }
  return reasonCode;
}

// SQL fragment: guest $N has an active grant for scope $M covering event $E.
// A grant with event_id NULL covers all events. Exported so aggregated
// dashboard queries (dashboardStore.js) apply the same consent filter.
export const ACTIVE_CONSENT = (guestCol, scopeParam, eventParam) => `
  EXISTS (
    SELECT 1 FROM consent_grant cg
    WHERE cg.guest_id = ${guestCol}
      AND cg.scope = ${scopeParam}
      AND (cg.event_id IS NULL OR cg.event_id = ${eventParam})
      AND cg.revoked_at IS NULL
      AND (cg.expires_at IS NULL OR cg.expires_at > now())
  )`;

async function requireStaffSession(client, staffSessionId, roles) {
  if (!isUuid(staffSessionId)) throw new AccessDeniedError('invalid staff session');
  const { rows } = await client.query(
    `SELECT id, venue_id, event_id, display_name, role
     FROM staff_session
     WHERE id = $1 AND revoked_at IS NULL AND access_expires_at > now()`,
    [staffSessionId]
  );
  if (!rows.length) throw new AccessDeniedError('staff session expired or revoked');
  if (roles && !roles.includes(rows[0].role)) {
    throw new AccessDeniedError(`role '${rows[0].role}' not permitted`);
  }
  return rows[0];
}

async function withTransaction(fn) {
  const pool = getPool();
  if (!pool) throw new AccessDeniedError('database unavailable');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Security/admin looks up ONE identified guest: name + latest position.
 * Requires the guest's active identified_security_roster consent.
 * Audited (action: identified_guest_lookup) in the same transaction.
 */
export async function lookupIdentifiedGuest({ staffSessionId, guestId, eventId, reasonCode }) {
  return withTransaction(async (client) => {
    // Identified data is Security-role ONLY (Prompt 6): admins/promoters get
    // operational visibility from aggregated views, never guest identity.
    requireReason(reasonCode);
    const staff = await requireStaffSession(client, staffSessionId, ['security']);
    const { rows } = await client.query(
      `SELECT g.id, g.display_name, g.last_seen_at, g.medical_info_enc,
              ST_Y(pf.location::geometry) AS lat, ST_X(pf.location::geometry) AS lng,
              pf.accuracy_m, pf.confidence, pf.recorded_at
       FROM guest g
       LEFT JOIN LATERAL (
         SELECT * FROM position_fix
         WHERE guest_id = g.id AND ($2::uuid IS NULL OR event_id = $2)
         ORDER BY recorded_at DESC LIMIT 1
       ) pf ON true
       WHERE g.id = $1
         AND ${ACTIVE_CONSENT('g.id', `'identified_security_roster'`, '$2::uuid')}`,
      [guestId, eventId ?? null]
    );
    if (!rows.length) {
      throw new AccessDeniedError('guest not found or has not consented to the security roster');
    }
    await client.query(
      `INSERT INTO audit_log (actor, actor_staff_session_id, target_guest_id, action, detail)
       VALUES ($1, $1, $2, 'identified_guest_lookup', $3)`,
      [staff.id, guestId,
       JSON.stringify({ eventId: eventId ?? null, role: staff.role, reasonCode })]
    );
    return withMedical(rows[0]);
  });
}

/**
 * Security/admin lists the identified roster for an event: every guest with
 * active identified_security_roster consent, with latest position.
 * One audit row per returned guest.
 */
export async function listIdentifiedRoster({ staffSessionId, eventId, reasonCode, bulkExport = false }) {
  return withTransaction(async (client) => {
    requireReason(reasonCode);
    const staff = await requireStaffSession(client, staffSessionId, ['security']);
    const { rows } = await client.query(
      `SELECT g.id, g.display_name, g.medical_info_enc,
              ST_Y(pf.location::geometry) AS lat, ST_X(pf.location::geometry) AS lng,
              pf.confidence, pf.recorded_at
       FROM guest g
       LEFT JOIN LATERAL (
         SELECT * FROM position_fix
         WHERE guest_id = g.id AND event_id = $1
         ORDER BY recorded_at DESC LIMIT 1
       ) pf ON true
       WHERE ${ACTIVE_CONSENT('g.id', `'identified_security_roster'`, '$1')}`,
      [eventId]
    );
    for (const row of rows) {
      await client.query(
        `INSERT INTO audit_log (actor, actor_staff_session_id, target_guest_id, action, detail)
         VALUES ($1, $1, $2, 'identified_guest_lookup', $3)`,
        [staff.id, row.id, JSON.stringify({
          eventId, via: bulkExport ? 'roster_bulk_export' : 'roster_list',
          role: staff.role, reasonCode,
        })]
      );
    }
    const out = rows.map(withMedical);
    if (bulkExport) {
      await client.query(
        `INSERT INTO audit_log (actor, actor_staff_session_id, action, detail)
         VALUES ($1, $1, 'roster_bulk_export', $2)`,
        [staff.id, JSON.stringify({ eventId, count: rows.length, role: staff.role, reasonCode })]
      );
    }
    return out;
  });
}

/**
 * Staff safety view: ANONYMOUS positions of guests with venue_safety_network
 * consent. No guest ids or names leave this function. Audited once as an
 * aggregate action (no target_guest_id — nobody was identified).
 */
export async function listSafetyNetworkPositions({ staffSessionId, eventId }) {
  return withTransaction(async (client) => {
    const staff = await requireStaffSession(client, staffSessionId, ['security', 'admin', 'promoter']);
    const { rows } = await client.query(
      `SELECT ST_Y(pf.location::geometry) AS lat, ST_X(pf.location::geometry) AS lng,
              pf.confidence, pf.recorded_at
       FROM guest g
       JOIN LATERAL (
         SELECT * FROM position_fix
         WHERE guest_id = g.id AND event_id = $1
         ORDER BY recorded_at DESC LIMIT 1
       ) pf ON true
       WHERE ${ACTIVE_CONSENT('g.id', `'venue_safety_network'`, '$1')}`,
      [eventId]
    );
    await client.query(
      `INSERT INTO audit_log (actor, actor_staff_session_id, action, detail)
       VALUES ($1, $1, 'safety_network_snapshot', $2)`,
      [staff.id, JSON.stringify({ eventId, count: rows.length, role: staff.role })]
    );
    return rows;
  });
}

/**
 * Guest-to-guest: positions the viewer may see via friend links.
 * Requires BOTH an active friend_sharing consent grant from the sharer AND a
 * friend_link at 'always' (any event) or 'this_event_only' (matching event).
 */
export async function listFriendPositions({ viewerGuestId, eventId }) {
  if (!isUuid(viewerGuestId)) throw new AccessDeniedError('invalid guest id');
  const pool = getPool();
  if (!pool) throw new AccessDeniedError('database unavailable');
  const { rows } = await pool.query(
    `SELECT g.id, g.display_name,
            ST_Y(pf.location::geometry) AS lat, ST_X(pf.location::geometry) AS lng,
            pf.confidence, pf.recorded_at
     FROM friend_link fl
     JOIN guest g ON g.id = fl.guest_id
     LEFT JOIN LATERAL (
       SELECT * FROM position_fix
       WHERE guest_id = g.id AND ($2::uuid IS NULL OR event_id = $2)
       ORDER BY recorded_at DESC LIMIT 1
     ) pf ON true
     WHERE fl.friend_guest_id = $1
       AND (fl.sharing_level = 'always'
            OR (fl.sharing_level = 'this_event_only' AND fl.event_id = $2))
       AND ${ACTIVE_CONSENT('g.id', `'friend_sharing'`, '$2::uuid')}`,
    [viewerGuestId, eventId ?? null]
  );
  return rows;
}

/**
 * Security-only incident view WITH subject identity. The role check runs in
 * the same transaction as the read and the per-subject audit rows — an
 * account without the Security role cannot reach this data through any code
 * path (the aggregated incident summary in dashboardStore never selects
 * subject_guest_id). Subject names are operational data recorded by staff, so
 * they are shown to Security without a roster consent — but every view of
 * them is audited.
 */
export async function listIdentifiedIncidents({ staffSessionId, eventId, reasonCode }) {
  return withTransaction(async (client) => {
    requireReason(reasonCode);
    const staff = await requireStaffSession(client, staffSessionId, ['security']);
    const { rows } = await client.query(
      `SELECT i.id, i.category, i.description, i.status,
              i.created_at, i.resolved_at,
              ST_Y(i.location::geometry) AS lat, ST_X(i.location::geometry) AS lng,
              i.subject_guest_id, g.display_name AS subject_name
       FROM incident_log i
       LEFT JOIN guest g ON g.id = i.subject_guest_id
       WHERE i.event_id = $1
       ORDER BY i.created_at DESC
       LIMIT 100`,
      [eventId]
    );
    for (const row of rows) {
      if (!row.subject_guest_id) continue;
      await client.query(
        `INSERT INTO audit_log (actor, actor_staff_session_id, target_guest_id, action, detail)
         VALUES ($1, $1, $2, 'identified_guest_lookup', $3)`,
        [staff.id, row.subject_guest_id,
         JSON.stringify({ eventId, via: 'incident_identified_view', incidentId: row.id, role: staff.role, reasonCode })]
      );
    }
    return rows;
  });
}

/**
 * Identify ONE incident's subject (console "identify" action) — narrower
 * than listIdentifiedIncidents so responding to a single SOS doesn't expose
 * every subject in the log. Security role + reason code + one audit row.
 * An SOS sender is identified regardless of roster consent: pressing SOS is
 * the request for help; the audit row records that justification.
 */
export async function identifyIncidentSubject({ staffSessionId, incidentId, eventId, reasonCode }) {
  return withTransaction(async (client) => {
    requireReason(reasonCode);
    const staff = await requireStaffSession(client, staffSessionId, ['security']);
    const { rows } = await client.query(
      `SELECT i.id AS incident_id, i.category, i.subject_guest_id,
              g.display_name AS subject_name, g.last_seen_at, g.medical_info_enc,
              ST_Y(pf.location::geometry) AS lat, ST_X(pf.location::geometry) AS lng,
              pf.confidence, pf.recorded_at
       FROM incident_log i
       JOIN guest g ON g.id = i.subject_guest_id
       LEFT JOIN LATERAL (
         SELECT * FROM position_fix
         WHERE guest_id = i.subject_guest_id AND ($2::uuid IS NULL OR event_id = $2)
         ORDER BY recorded_at DESC LIMIT 1
       ) pf ON true
       WHERE i.id = $1 AND ($2::uuid IS NULL OR i.event_id = $2)`,
      [incidentId, eventId ?? null]
    );
    if (!rows.length) throw new AccessDeniedError('incident not found or has no subject');
    await client.query(
      `INSERT INTO audit_log (actor, actor_staff_session_id, target_guest_id, action, detail)
       VALUES ($1, $1, $2, 'identified_guest_lookup', $3)`,
      [staff.id, rows[0].subject_guest_id,
       JSON.stringify({ eventId: eventId ?? null, via: 'incident_identify', incidentId, role: staff.role, reasonCode })]
    );
    // medical_info here is the PERSISTENT profile — the console labels it
    // distinctly from the SOS-time note (incident description).
    return withMedical(rows[0]);
  });
}

/** Revoke a consent scope — takes effect on the next query, no cache to bust. */
export async function revokeConsent({ guestId, scope, eventId }) {
  if (!isUuid(guestId)) throw new AccessDeniedError('invalid guest id');
  const pool = getPool();
  if (!pool) throw new AccessDeniedError('database unavailable');
  await pool.query(
    `UPDATE consent_grant SET revoked_at = now()
     WHERE guest_id = $1 AND scope = $2
       AND ($3::uuid IS NULL OR event_id = $3)
       AND revoked_at IS NULL`,
    [guestId, scope, eventId ?? null]
  );
}
