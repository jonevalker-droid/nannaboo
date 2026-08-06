// Bearing/distance math for POIs and the AR view.
// (Server keeps its own copy in server/poiStore.js.)

const toRad = (d) => (d * Math.PI) / 180;

export function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Initial bearing from `from` to `to`, degrees clockwise from north (0-360). */
export function bearingDeg(from, to) {
  const y = Math.sin(toRad(to.lng - from.lng)) * Math.cos(toRad(to.lat));
  const x = Math.cos(toRad(from.lat)) * Math.sin(toRad(to.lat)) -
    Math.sin(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.cos(toRad(to.lng - from.lng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** US-friendly: feet up close, miles past a quarter mile. */
export function formatDistance(meters) {
  const feet = meters * 3.28084;
  if (feet < 1320) return `${Math.round(feet)} ft`;
  return `${(meters / 1609.34).toFixed(1)} mi`;
}

/** A position older than this reads as "last seen X min ago", not live. */
export const STALE_MS = 2 * 60_000;

/** Whole minutes since `ts`, floored at 1 — for "last seen X min ago". */
export function minutesAgo(ts, now = Date.now()) {
  return Math.max(1, Math.round((now - ts) / 60000));
}

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function cardinal(bearing) {
  return POINTS[Math.round(((bearing % 360) + 360) % 360 / 45) % 8];
}
