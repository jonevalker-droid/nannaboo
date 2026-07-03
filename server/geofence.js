// Venue geofence (Prompt 4b). Holds the venue boundary polygon in memory —
// hydrated from venue.boundary at boot in DB mode, settable via
// /api/venue/boundary either way — and answers point-in-polygon per position
// update. Deliberately simple: one polygon, outer ring only (holes ignored),
// standard ray casting. NO boundary configured means everyone counts as
// inside, so a fresh deploy behaves exactly like pre-geofence NannaBoo until
// an admin draws the fence.

let boundary = null; // GeoJSON Polygon ({ type:'Polygon', coordinates:[[[lng,lat],...]] }) or null

export function getBoundary() {
  return boundary;
}

/** Validates + stores a GeoJSON Polygon (or null to clear). Returns false if invalid. */
export function setBoundary(polygon) {
  if (polygon === null) {
    boundary = null;
    return true;
  }
  if (!isValidPolygon(polygon)) return false;
  boundary = polygon;
  return true;
}

export function isValidPolygon(p) {
  if (p?.type !== 'Polygon' || !Array.isArray(p.coordinates) || !p.coordinates.length) return false;
  const ring = p.coordinates[0];
  if (!Array.isArray(ring) || ring.length < 4) return false;
  return ring.every((pt) =>
    Array.isArray(pt) && pt.length >= 2 &&
    typeof pt[0] === 'number' && typeof pt[1] === 'number' &&
    Math.abs(pt[0]) <= 180 && Math.abs(pt[1]) <= 90);
}

/**
 * Is a guest position inside the venue fence? true when no fence is set.
 * Ray casting on the outer ring; fine at venue scale (no antimeridian venues).
 */
export function contains(lat, lng) {
  if (!boundary) return true;
  return polygonContains(boundary, lat, lng);
}

/** Same ray cast against an arbitrary GeoJSON Polygon (zones use this). */
export function polygonContains(polygon, lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  const ring = polygon.coordinates[0];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat &&
        lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Convenience for live tests and quick setup: an N-gon approximating a circle
 * around a center, so one request can fence "the venue plus the parking lot".
 */
export function circlePolygon(lat, lng, radiusM, points = 24) {
  const latR = radiusM / 111_320; // meters per degree latitude
  const lngR = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  const ring = [];
  for (let i = 0; i < points; i++) {
    const a = (2 * Math.PI * i) / points;
    ring.push([lng + lngR * Math.cos(a), lat + latR * Math.sin(a)]);
  }
  ring.push([...ring[0]]); // close the ring
  return { type: 'Polygon', coordinates: [ring] };
}
