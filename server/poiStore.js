// POI store with two backends: PostGIS when the DB is up, otherwise an
// in-memory Map (same graceful-degradation contract as the rest of the app —
// local dev and a DB outage still get working POI features, just not durable).
import { randomUUID } from 'crypto';
import * as db from './db/index.js';

export const CATEGORIES = [
  'restroom', 'exit', 'medic', 'food', 'drink', 'smoking', 'atm',
  'lost_and_found', 'info', 'charging', 'merch', 'coat_check',
  'accessible_route', 'parking', 'rideshare', 'water', 'quiet_room', 'other',
];

const memory = new Map(); // id -> poi, used only when db is disabled

// ---- geo math (duplicated client-side in client/src/lib/geo.js) ----

const toRad = (d) => (d * Math.PI) / 180;

export function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function bearingDeg(from, to) {
  const y = Math.sin(toRad(to.lng - from.lng)) * Math.cos(toRad(to.lat));
  const x = Math.cos(toRad(from.lat)) * Math.sin(toRad(to.lat)) -
    Math.sin(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.cos(toRad(to.lng - from.lng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// ---- helpers ----

function decorate(pois, lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return pois;
  const me = { lat, lng };
  return pois
    .map((p) => ({
      ...p,
      distanceM: Math.round(haversineMeters(me, p)),
      bearingDeg: Math.round(bearingDeg(me, p)),
    }))
    .sort((a, b) => a.distanceM - b.distanceM);
}

const rowToPoi = (r) => ({
  id: r.id,
  category: r.category,
  name: r.name,
  lat: r.lat,
  lng: r.lng,
  floorLevel: r.floor_level,
  liveStatus: r.live_status,
});

// ---- CRUD ----

export async function listPois({ category, lat, lng, limit } = {}) {
  let pois;
  if (db.enabled) {
    const params = [db.getDefaultVenueId()];
    let where = 'venue_id = $1';
    if (category) {
      params.push(category);
      where += ` AND category = $${params.length}`;
    }
    const { rows } = await db.getPool().query(
      `SELECT id, category, name,
              ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng,
              floor_level, live_status
       FROM poi WHERE ${where}`,
      params
    );
    pois = rows.map(rowToPoi);
  } else {
    pois = [...memory.values()].filter((p) => !category || p.category === category);
  }
  pois = decorate(pois, lat, lng);
  return limit ? pois.slice(0, limit) : pois;
}

export async function createPoi({ category, name, lat, lng, floorLevel, liveStatus }) {
  const id = randomUUID();
  if (db.enabled) {
    await db.getPool().query(
      `INSERT INTO poi (id, venue_id, category, name, location, floor_level, live_status)
       VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, $7, $8)`,
      [id, db.getDefaultVenueId(), category, name, lng, lat, floorLevel ?? null, liveStatus ?? null]
    );
  } else {
    memory.set(id, { id, category, name, lat, lng, floorLevel: floorLevel ?? null, liveStatus: liveStatus ?? null });
  }
  return { id, category, name, lat, lng, floorLevel: floorLevel ?? null, liveStatus: liveStatus ?? null };
}

export async function updatePoi(id, patch) {
  if (db.enabled) {
    const sets = [];
    const params = [id];
    const add = (sql, val) => { params.push(val); sets.push(`${sql} = $${params.length}`); };
    if (patch.category !== undefined) add('category', patch.category);
    if (patch.name !== undefined) add('name', patch.name);
    if (patch.floorLevel !== undefined) add('floor_level', patch.floorLevel);
    if (patch.liveStatus !== undefined) add('live_status', patch.liveStatus);
    if (patch.lat !== undefined && patch.lng !== undefined) {
      params.push(patch.lng, patch.lat);
      sets.push(`location = ST_SetSRID(ST_MakePoint($${params.length - 1}, $${params.length}), 4326)::geography`);
    }
    if (!sets.length) return null;
    sets.push('updated_at = now()');
    const { rows } = await db.getPool().query(
      `UPDATE poi SET ${sets.join(', ')} WHERE id = $1
       RETURNING id, category, name,
                 ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng,
                 floor_level, live_status`,
      params
    );
    return rows.length ? rowToPoi(rows[0]) : null;
  }
  const existing = memory.get(id);
  if (!existing) return null;
  const updated = { ...existing };
  for (const k of ['category', 'name', 'lat', 'lng', 'floorLevel', 'liveStatus']) {
    if (patch[k] !== undefined) updated[k] = patch[k];
  }
  memory.set(id, updated);
  return updated;
}

export async function deletePoi(id) {
  if (db.enabled) {
    const { rowCount } = await db.getPool().query('DELETE FROM poi WHERE id = $1', [id]);
    return rowCount > 0;
  }
  return memory.delete(id);
}

// ---- demo seed ----
// Same sample set as migration 004, positioned around any point — lets the
// venue be "moved" to wherever you're standing for a live phone test.
// REPLACES all existing POIs for the venue.

const DEMO_SET = [
  { category: 'exit',     name: 'North Exit — Main Gate',   east: 0,    north: 133 },
  { category: 'exit',     name: 'South Exit — Boat Ramp',   east: -40,  north: -133 },
  { category: 'exit',     name: 'East Exit — Service Road', east: 143,  north: 11 },
  { category: 'restroom', name: 'Restrooms — Main Lodge',   east: -79,  north: 44, floorLevel: '1' },
  { category: 'medic',    name: 'First Aid Tent',           east: 64,   north: -44 },
  { category: 'food',     name: 'Grill Shack',              east: 40,   north: 78 },
];

export async function seedDemo({ lat, lng }) {
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos(toRad(lat));
  if (db.enabled) {
    await db.getPool().query('DELETE FROM poi WHERE venue_id = $1', [db.getDefaultVenueId()]);
  } else {
    memory.clear();
  }
  const created = [];
  for (const d of DEMO_SET) {
    created.push(await createPoi({
      category: d.category,
      name: d.name,
      lat: lat + d.north / mPerDegLat,
      lng: lng + d.east / mPerDegLng,
      floorLevel: d.floorLevel,
    }));
  }
  return created;
}
