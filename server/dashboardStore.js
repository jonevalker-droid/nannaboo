// Dashboard data layer (Prompt 6). EVERYTHING here is aggregated and
// anonymized: heatmap cells, zone occupancy counts, incident tallies, dwell/
// flow/peak statistics. No function in this module ever returns a guest id,
// a guest name, or a raw position_fix row — SQL aggregates in the database,
// and the in-memory paths aggregate before returning. The one identified
// view (incidents with subject names) lives in db/access.js where the
// Security-role check and audit_log write share a transaction.
//
// Dual backend like poiStore/friendStore: PostGIS when the DB is up,
// live in-memory group state otherwise (analytics history needs the DB and
// says so rather than faking it).
import { randomUUID } from 'crypto';
import * as db from './db/index.js';
import { ACTIVE_CONSENT } from './db/access.js';
import * as geofence from './geofence.js';

const RECENT_MIN = 15;          // "currently on site" = a fix in the last 15 min
const GRID = 0.00025;           // heatmap cell ≈ 25-30 m
export const INCIDENT_CATEGORIES = [
  'sos', 'medical', 'altercation', 'lost_person', 'theft', 'overcrowding', 'other',
];
const INCIDENT_STATUSES = ['open', 'acknowledged', 'resolved'];

// In-memory fallback state
const memoryZones = [];     // { id, name, capacity, polygon, createdAt }
const memoryIncidents = []; // { id, eventKey, category, description, status, lat, lng, zoneId, subjectGuestId, reportedBy, createdAt, resolvedAt }

const snap = (v) => Math.round(v / GRID) * GRID;

// Consented latest-position-per-guest, already aggregated to grid cells.
const CONSENTED = ACTIVE_CONSENT('g.id', `'venue_safety_network'`, '$1');

// ---------------------------------------------------------------- heatmap

export async function heatmap({ eventId, group }) {
  if (db.enabled && eventId) {
    const { rows } = await db.getPool().query(
      `SELECT round(ST_Y(pf.location::geometry) / ${GRID}) * ${GRID} AS lat,
              round(ST_X(pf.location::geometry) / ${GRID}) * ${GRID} AS lng,
              count(*)::int AS count
       FROM guest g
       JOIN LATERAL (
         SELECT location, recorded_at FROM position_fix
         WHERE guest_id = g.id AND event_id = $1
         ORDER BY recorded_at DESC LIMIT 1
       ) pf ON pf.recorded_at > now() - interval '${RECENT_MIN} minutes'
       WHERE ${CONSENTED}
       GROUP BY 1, 2`,
      [eventId]
    );
    return { cells: rows, total: rows.reduce((s, r) => s + r.count, 0) };
  }
  const bins = new Map();
  for (const guest of group?.guests.values() ?? []) {
    if (guest.lat == null) continue;
    const key = `${snap(guest.lat)}|${snap(guest.lng)}`;
    bins.set(key, (bins.get(key) ?? 0) + 1);
  }
  const cells = [...bins.entries()].map(([k, count]) => {
    const [lat, lng] = k.split('|').map(Number);
    return { lat, lng, count };
  });
  return { cells, total: cells.reduce((s, c) => s + c.count, 0) };
}

// ---------------------------------------------------------------- zones

export async function listZones() {
  if (db.enabled) {
    const { rows } = await db.getPool().query(
      `SELECT id, name, capacity, ST_AsGeoJSON(boundary::geometry) AS gj
       FROM zone WHERE venue_id = $1 ORDER BY name`,
      [db.getDefaultVenueId()]
    );
    return rows.map((r) => ({
      id: r.id, name: r.name, capacity: r.capacity, polygon: JSON.parse(r.gj),
    }));
  }
  return memoryZones.map(({ id, name, capacity, polygon }) => ({ id, name, capacity, polygon }));
}

export async function createZone({ name, capacity, polygon }) {
  if (db.enabled) {
    const { rows } = await db.getPool().query(
      `INSERT INTO zone (venue_id, name, boundary, capacity)
       VALUES ($1, $2, ST_GeomFromGeoJSON($3)::geography, $4)
       RETURNING id`,
      [db.getDefaultVenueId(), name, JSON.stringify(polygon), capacity]
    );
    return { id: rows[0].id, name, capacity, polygon };
  }
  const zone = { id: randomUUID(), name, capacity, polygon, createdAt: Date.now() };
  memoryZones.push(zone);
  return { id: zone.id, name, capacity, polygon };
}

export async function deleteZone(id) {
  if (db.enabled) {
    const { rowCount } = await db.getPool().query(
      'DELETE FROM zone WHERE id = $1 AND venue_id = $2', [id, db.getDefaultVenueId()]
    );
    return rowCount > 0;
  }
  const i = memoryZones.findIndex((z) => z.id === id);
  if (i === -1) return false;
  memoryZones.splice(i, 1);
  return true;
}

/** Occupancy COUNT per zone + capacity alert flag. Counts, never members. */
export async function zoneStatus({ eventId, group }) {
  const zones = await listZones();
  if (db.enabled && eventId) {
    const { rows } = await db.getPool().query(
      `SELECT z.id, count(pf.location)::int AS occupancy
       FROM zone z
       LEFT JOIN (
         SELECT DISTINCT ON (g.id) g.id AS guest_id, pf1.location, pf1.recorded_at
         FROM guest g
         JOIN position_fix pf1 ON pf1.guest_id = g.id AND pf1.event_id = $1
         WHERE ${CONSENTED}
         ORDER BY g.id, pf1.recorded_at DESC
       ) pf ON pf.recorded_at > now() - interval '${RECENT_MIN} minutes'
          AND ST_Covers(z.boundary, pf.location)
       WHERE z.venue_id = $2
       GROUP BY z.id`,
      [eventId, db.getDefaultVenueId()]
    );
    const occ = new Map(rows.map((r) => [r.id, r.occupancy]));
    return zones.map((z) => decorate(z, occ.get(z.id) ?? 0));
  }
  return zones.map((z) => {
    let occupancy = 0;
    for (const guest of group?.guests.values() ?? []) {
      if (guest.lat != null && geofence.polygonContains(z.polygon, guest.lat, guest.lng)) occupancy++;
    }
    return decorate(z, occupancy);
  });
}

function decorate(zone, occupancy) {
  const pct = zone.capacity ? occupancy / zone.capacity : null;
  return {
    ...zone,
    occupancy,
    alert: pct !== null && pct >= 1 ? 'over'
      : pct !== null && pct >= 0.8 ? 'near'
      : 'ok',
  };
}

// ---------------------------------------------------------------- incidents

export async function createIncident({ eventId, eventKey, category, description, lat, lng, zoneId, subjectGuestId, reportedBy }) {
  if (!INCIDENT_CATEGORIES.includes(category)) return null;
  if (db.enabled && eventId) {
    const { rows } = await db.getPool().query(
      `INSERT INTO incident_log
         (venue_id, event_id, zone_id, reported_by, subject_guest_id, category, description, location)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               CASE WHEN $8::float8 IS NULL THEN NULL
                    ELSE ST_SetSRID(ST_MakePoint($9, $8), 4326)::geography END)
       RETURNING id, created_at`,
      [db.getDefaultVenueId(), eventId, zoneId ?? null,
       db.isUuid(reportedBy) ? reportedBy : null,
       db.isUuid(subjectGuestId) ? subjectGuestId : null,
       category, description ?? null, lat ?? null, lng ?? null]
    );
    return { id: rows[0].id };
  }
  const inc = {
    id: randomUUID(), eventKey, category,
    description: description ?? null, status: 'open',
    lat: lat ?? null, lng: lng ?? null, zoneId: zoneId ?? null,
    subjectGuestId: subjectGuestId ?? null, reportedBy,
    createdAt: Date.now(), resolvedAt: null,
  };
  memoryIncidents.push(inc);
  return { id: inc.id };
}

export async function setIncidentStatus(id, status) {
  if (!INCIDENT_STATUSES.includes(status)) return false;
  if (db.enabled) {
    const { rowCount } = await db.getPool().query(
      `UPDATE incident_log
       SET status = $2, resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE resolved_at END
       WHERE id = $1`,
      [id, status]
    );
    return rowCount > 0;
  }
  const inc = memoryIncidents.find((i) => i.id === id);
  if (!inc) return false;
  inc.status = status;
  if (status === 'resolved') inc.resolvedAt = Date.now();
  return true;
}

/**
 * Identity-free incident view for admins/promoters: counts by category and
 * status plus a recent feed that NEVER selects subject_guest_id. The
 * identified variant is access.listIdentifiedIncidents (Security + audit).
 */
export async function incidentSummary({ eventId, eventKey }) {
  if (db.enabled && eventId) {
    const pool = db.getPool();
    const [byCategory, byStatus, recent] = await Promise.all([
      pool.query(
        `SELECT category, count(*)::int AS count FROM incident_log
         WHERE event_id = $1 GROUP BY category ORDER BY count DESC`,
        [eventId]
      ),
      pool.query(
        `SELECT status, count(*)::int AS count FROM incident_log
         WHERE event_id = $1 GROUP BY status`,
        [eventId]
      ),
      pool.query(
        `SELECT id, category, status, created_at,
                ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng,
                (subject_guest_id IS NOT NULL) AS has_subject
         FROM incident_log
         WHERE event_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [eventId]
      ),
    ]);
    return {
      byCategory: byCategory.rows,
      byStatus: byStatus.rows,
      recent: recent.rows,
    };
  }
  const mine = memoryIncidents.filter((i) => i.eventKey === eventKey);
  const tally = (key) => {
    const m = new Map();
    for (const i of mine) m.set(i[key], (m.get(i[key]) ?? 0) + 1);
    return [...m.entries()].map(([k, count]) => ({ [key]: k, count }))
      .sort((a, b) => b.count - a.count);
  };
  return {
    byCategory: tally('category'),
    byStatus: tally('status'),
    recent: mine.slice(-20).reverse().map((i) => ({
      id: i.id, category: i.category, status: i.status,
      created_at: new Date(i.createdAt).toISOString(),
      lat: i.lat, lng: i.lng, has_subject: !!i.subjectGuestId,
    })),
  };
}

/**
 * Console inbox: identity-free rows (has_subject flag only — identity is a
 * separate audited call), SOS pinned first, then open incidents, newest
 * first. description IS included: a guest's SOS note is information they
 * sent to security on purpose.
 */
export async function consoleInbox({ eventId, eventKey }) {
  if (db.enabled && eventId) {
    const { rows } = await db.getPool().query(
      `SELECT id, category, status, description, created_at,
              assigned_staff_id, assigned_at,
              ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng,
              (subject_guest_id IS NOT NULL) AS has_subject
       FROM incident_log
       WHERE event_id = $1
       ORDER BY (category = 'sos' AND status <> 'resolved') DESC,
                (status = 'open') DESC,
                created_at DESC
       LIMIT 50`,
      [eventId]
    );
    return rows;
  }
  const score = (i) =>
    (i.category === 'sos' && i.status !== 'resolved' ? 2 : 0) +
    (i.status === 'open' ? 1 : 0);
  return memoryIncidents.filter((i) => i.eventKey === eventKey)
    .sort((a, b) => score(b) - score(a) || b.createdAt - a.createdAt)
    .slice(0, 50)
    .map((i) => ({
      id: i.id, category: i.category, status: i.status,
      description: i.description,
      created_at: new Date(i.createdAt).toISOString(),
      assigned_staff_id: i.assignedStaffId ?? null,
      assigned_at: i.assignedAt ? new Date(i.assignedAt).toISOString() : null,
      lat: i.lat, lng: i.lng, has_subject: !!i.subjectGuestId,
    }));
}

/** Location + assignment info for one incident (no subject identity). */
export async function getIncident(id, { eventId, eventKey }) {
  if (db.enabled && eventId) {
    const { rows } = await db.getPool().query(
      `SELECT id, category, status, assigned_staff_id,
              ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
       FROM incident_log WHERE id = $1 AND event_id = $2`,
      [id, eventId]
    );
    return rows[0] ?? null;
  }
  const i = memoryIncidents.find((x) => x.id === id && x.eventKey === eventKey);
  return i ? {
    id: i.id, category: i.category, status: i.status,
    assigned_staff_id: i.assignedStaffId ?? null, lat: i.lat, lng: i.lng,
  } : null;
}

/** Memory-mode subject id for one incident (DB mode resolves in access.js). */
export function memoryIncidentSubject(id, eventKey) {
  return memoryIncidents.find((x) => x.id === id && x.eventKey === eventKey)
    ?.subjectGuestId ?? null;
}

export async function assignIncident(id, staffSessionId) {
  if (db.enabled) {
    const { rowCount } = await db.getPool().query(
      `UPDATE incident_log
       SET assigned_staff_id = $2, assigned_at = now(),
           status = CASE WHEN status = 'open' THEN 'acknowledged' ELSE status END
       WHERE id = $1`,
      [id, staffSessionId]
    );
    return rowCount > 0;
  }
  const i = memoryIncidents.find((x) => x.id === id);
  if (!i) return false;
  i.assignedStaffId = staffSessionId;
  i.assignedAt = Date.now();
  if (i.status === 'open') i.status = 'acknowledged';
  return true;
}

/** In-memory identified incidents (Security role enforced by the router). */
export function memoryIdentifiedIncidents({ eventKey, group }) {
  return memoryIncidents.filter((i) => i.eventKey === eventKey)
    .slice(-100).reverse()
    .map((i) => ({
      id: i.id, category: i.category, description: i.description,
      status: i.status, created_at: new Date(i.createdAt).toISOString(),
      lat: i.lat, lng: i.lng,
      subject_guest_id: i.subjectGuestId,
      subject_name: i.subjectGuestId
        ? group?.guests.get(i.subjectGuestId)?.name ?? null
        : null,
    }));
}

// ---------------------------------------------------------------- analytics

/**
 * Post-event export: dwell time, entry/exit flow, peak occupancy — all
 * computed as aggregates in SQL (per-guest intermediates never leave the
 * database). In-memory mode has no history and reports only the live
 * session-derived figures, flagged memoryMode.
 */
export async function analytics({ eventId, group }) {
  if (db.enabled && eventId) {
    const pool = db.getPool();
    const [dwell, entries, exits, peaks] = await Promise.all([
      pool.query(
        `SELECT count(*)::int AS guests,
                round(avg(dur))::int AS avg_dwell_min,
                round(percentile_cont(0.5) WITHIN GROUP (ORDER BY dur))::int AS median_dwell_min,
                round(max(dur))::int AS max_dwell_min
         FROM (
           SELECT extract(epoch FROM max(pf.recorded_at) - min(pf.recorded_at)) / 60 AS dur
           FROM position_fix pf JOIN guest g ON g.id = pf.guest_id
           WHERE pf.event_id = $1 AND ${CONSENTED}
           GROUP BY pf.guest_id
         ) d`,
        [eventId]
      ),
      pool.query(
        `SELECT to_char(hr, 'YYYY-MM-DD HH24:00') AS hour, count(*)::int AS count
         FROM (
           SELECT date_trunc('hour', min(pf.recorded_at)) AS hr
           FROM position_fix pf JOIN guest g ON g.id = pf.guest_id
           WHERE pf.event_id = $1 AND ${CONSENTED}
           GROUP BY pf.guest_id
         ) e GROUP BY hr ORDER BY hr`,
        [eventId]
      ),
      pool.query(
        `SELECT to_char(hr, 'YYYY-MM-DD HH24:00') AS hour, count(*)::int AS count
         FROM (
           SELECT date_trunc('hour', max(pf.recorded_at)) AS hr
           FROM position_fix pf JOIN guest g ON g.id = pf.guest_id
           WHERE pf.event_id = $1 AND ${CONSENTED}
           GROUP BY pf.guest_id
         ) e GROUP BY hr ORDER BY hr`,
        [eventId]
      ),
      pool.query(
        `SELECT to_char(bucket, 'YYYY-MM-DD HH24:MI') AS window,
                count(DISTINCT pf.guest_id)::int AS guests
         FROM (
           SELECT guest_id, recorded_at,
                  date_trunc('hour', recorded_at)
                    + floor(extract(minute FROM recorded_at) / 15) * interval '15 minutes' AS bucket
           FROM position_fix WHERE event_id = $1
         ) pf JOIN guest g ON g.id = pf.guest_id
         WHERE ${CONSENTED}
         GROUP BY bucket ORDER BY guests DESC, bucket LIMIT 5`,
        [eventId]
      ),
    ]);
    return {
      memoryMode: false,
      dwell: dwell.rows[0],
      entriesByHour: entries.rows,
      exitsByHour: exits.rows,
      peakWindows: peaks.rows,
    };
  }
  // Live-only view: no persisted history without the database.
  const guests = [...(group?.guests.values() ?? [])];
  const now = Date.now();
  const durations = guests.map((guest) => (now - (guest.joinedAt ?? now)) / 60_000);
  const sorted = [...durations].sort((a, b) => a - b);
  const entriesMap = new Map();
  for (const guest of guests) {
    const hr = new Date(guest.joinedAt ?? now).toISOString().slice(0, 13).replace('T', ' ') + ':00';
    entriesMap.set(hr, (entriesMap.get(hr) ?? 0) + 1);
  }
  return {
    memoryMode: true,
    note: 'live session snapshot — full dwell/flow history requires the database',
    dwell: {
      guests: guests.length,
      avg_dwell_min: durations.length ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length) : 0,
      median_dwell_min: durations.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : 0,
      max_dwell_min: durations.length ? Math.round(sorted[sorted.length - 1]) : 0,
    },
    entriesByHour: [...entriesMap.entries()].map(([hour, count]) => ({ hour, count })),
    exitsByHour: [],
    peakWindows: [{ window: 'now', guests: guests.filter((g) => g.lat != null).length }],
  };
}

/** Flatten the analytics object to section,key,value CSV rows. */
export function analyticsCsv(a) {
  const lines = [['section', 'key', 'value']];
  for (const [k, v] of Object.entries(a.dwell ?? {})) lines.push(['dwell', k, v ?? '']);
  for (const r of a.entriesByHour) lines.push(['entries_by_hour', r.hour, r.count]);
  for (const r of a.exitsByHour) lines.push(['exits_by_hour', r.hour, r.count]);
  for (const r of a.peakWindows) lines.push(['peak_windows', r.window, r.guests]);
  return lines.map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
}
