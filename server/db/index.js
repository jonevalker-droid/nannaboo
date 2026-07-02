// Persistence layer. The live WebSocket path stays in-memory and authoritative
// for the reunion test; everything here is write-through and fire-and-forget.
// Without DATABASE_URL (or if init fails) every function is a no-op and the
// app behaves exactly as before.
import pg from 'pg';
import { runMigrations } from './migrate.js';

const DATABASE_URL = process.env.DATABASE_URL;
const DEFAULT_VENUE_SLUG = process.env.DEFAULT_VENUE_SLUG || 'lake-resort';
const POSITION_WRITE_INTERVAL_MS = 10_000; // cap position_fix inserts per guest

let pool = null;
let defaultVenueId = null;
const eventIdByCode = new Map();     // upper(groupCode) -> event uuid
const lastPositionWrite = new Map(); // guestId -> ms timestamp

export let enabled = false;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);

function logError(op, err) {
  console.error(`[db] ${op} failed: ${err.message}`);
}

export async function init() {
  if (!DATABASE_URL) {
    console.log('[db] DATABASE_URL not set — running in-memory only');
    return;
  }
  try {
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
      max: 5,
      connectionTimeoutMillis: 10_000,
    });
    await runMigrations(pool);
    const { rows } = await pool.query(
      'SELECT id FROM venue WHERE slug = $1', [DEFAULT_VENUE_SLUG]
    );
    if (!rows.length) throw new Error(`default venue '${DEFAULT_VENUE_SLUG}' not found`);
    defaultVenueId = rows[0].id;
    enabled = true;
    console.log('[db] connected, migrations applied');
  } catch (err) {
    logError('init', err);
    console.error('[db] continuing without persistence');
    pool = null;
    enabled = false;
  }
}

export function getPool() {
  return pool;
}

export function getDefaultVenueId() {
  return defaultVenueId;
}

// One active event per group code, created lazily on first join.
export async function ensureEventForGroup(groupCode) {
  if (!enabled) return null;
  const code = groupCode.toUpperCase();
  if (eventIdByCode.has(code)) return eventIdByCode.get(code);
  try {
    let { rows } = await pool.query(
      'SELECT id FROM event WHERE upper(group_code) = $1 AND ends_at IS NULL', [code]
    );
    if (!rows.length) {
      ({ rows } = await pool.query(
        `INSERT INTO event (venue_id, name, group_code, starts_at)
         VALUES ($1, $2, $2, now())
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [defaultVenueId, code]
      ));
      if (!rows.length) { // lost a concurrent insert race — re-read
        ({ rows } = await pool.query(
          'SELECT id FROM event WHERE upper(group_code) = $1 AND ends_at IS NULL', [code]
        ));
      }
    }
    if (rows.length) eventIdByCode.set(code, rows[0].id);
    return rows[0]?.id ?? null;
  } catch (err) {
    logError('ensureEventForGroup', err);
    return null;
  }
}

export async function upsertGuest(guestId, name) {
  if (!enabled || !isUuid(guestId)) return;
  try {
    await pool.query(
      `INSERT INTO guest (id, display_name)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE
         SET display_name = EXCLUDED.display_name, last_seen_at = now()`,
      [guestId, name]
    );
  } catch (err) {
    logError('upsertGuest', err);
  }
}

// Joining a group and broadcasting your position to it is the product's
// consent action in Phase 1, so record it as a friend_sharing grant — this
// keeps Phase 1 data valid under the Phase 2+ access-control rules.
export async function grantFriendSharing(guestId, eventId) {
  if (!enabled || !isUuid(guestId) || !eventId) return;
  try {
    await pool.query(
      `INSERT INTO consent_grant (guest_id, event_id, scope)
       SELECT $1, $2, 'friend_sharing'
       WHERE NOT EXISTS (
         SELECT 1 FROM consent_grant
         WHERE guest_id = $1 AND event_id = $2 AND scope = 'friend_sharing'
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())
       )`,
      [guestId, eventId]
    );
  } catch (err) {
    logError('grantFriendSharing', err);
  }
}

export async function recordPositionFix(guestId, eventId, { lat, lng, accuracy, heading }) {
  if (!enabled || !isUuid(guestId) || !eventId) return;
  if (typeof lat !== 'number' || typeof lng !== 'number') return;
  const now = Date.now();
  if (now - (lastPositionWrite.get(guestId) ?? 0) < POSITION_WRITE_INTERVAL_MS) return;
  lastPositionWrite.set(guestId, now);
  // Browser geolocation is a fused provider (GPS/wifi/cell/sensors); imu_fused
  // is the nearest position_source value. Confidence is derived from reported
  // accuracy: 1.0 at <=5m falling linearly to 0.1 at >=100m.
  const acc = typeof accuracy === 'number' ? accuracy : null;
  const confidence = acc === null ? 0.5
    : Math.max(0.1, Math.min(1, 1 - (acc - 5) / (100 - 5) * 0.9));
  try {
    await pool.query(
      `INSERT INTO position_fix (guest_id, event_id, location, accuracy_m, heading, source, confidence)
       VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6, 'imu_fused', $7)`,
      [guestId, eventId, lng, lat, acc, typeof heading === 'number' ? heading : null, confidence]
    );
    pool.query('UPDATE guest SET last_seen_at = now() WHERE id = $1', [guestId])
      .catch(err => logError('touch guest', err));
  } catch (err) {
    logError('recordPositionFix', err);
  }
}

export async function savePin(eventId, pin) {
  if (!enabled || !eventId) return;
  try {
    await pool.query(
      `INSERT INTO pin (id, event_id, label, location, created_by)
       VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6)
       ON CONFLICT (id) DO NOTHING`,
      [pin.id, eventId, pin.label, pin.lng, pin.lat, isUuid(pin.createdBy) ? pin.createdBy : null]
    );
  } catch (err) {
    logError('savePin', err);
  }
}

export async function deletePin(pinId) {
  if (!enabled || !isUuid(pinId)) return;
  try {
    await pool.query('DELETE FROM pin WHERE id = $1', [pinId]);
  } catch (err) {
    logError('deletePin', err);
  }
}

// Rehydrate a group's pins after a server restart, in the exact in-memory shape.
export async function loadPins(eventId) {
  if (!enabled || !eventId) return [];
  try {
    const { rows } = await pool.query(
      `SELECT id, label,
              ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng,
              created_by, created_at
       FROM pin WHERE event_id = $1
       ORDER BY created_at ASC`,
      [eventId]
    );
    return rows.map(r => ({
      id: r.id,
      label: r.label,
      lat: r.lat,
      lng: r.lng,
      createdBy: r.created_by,
      createdAt: new Date(r.created_at).getTime(),
    }));
  } catch (err) {
    logError('loadPins', err);
    return [];
  }
}
