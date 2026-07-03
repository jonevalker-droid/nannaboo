// Venue geofence API (Prompt 4b). Reads are public (clients may render the
// fence); writes follow the same ADMIN_KEY guard as POI writes. The boundary
// gates guest-to-guest visibility: guests only appear on other guests' maps
// while inside it (see canSeePosition in server/index.js).
import { Router } from 'express';
import * as geofence from '../geofence.js';
import * as db from '../db/index.js';

const router = Router();

let warnedOpenAdmin = false;
function requireAdmin(req, res, next) {
  const key = process.env.ADMIN_KEY;
  if (!key) {
    if (!warnedOpenAdmin) {
      console.warn('[venue] ADMIN_KEY not set — boundary write routes are unprotected (prototype mode)');
      warnedOpenAdmin = true;
    }
    return next();
  }
  if (req.get('x-admin-key') === key || req.query.key === key) return next();
  res.status(401).json({ error: 'admin key required' });
}

router.get('/boundary', (_req, res) => {
  res.json({ boundary: geofence.getBoundary() });
});

// PUT /api/venue/boundary
// Body: { "polygon": <GeoJSON Polygon> }  — explicit fence
//   or: { "lat": .., "lng": .., "radiusM": .. } — circle helper for live tests
router.put('/boundary', requireAdmin, (req, res) => {
  const body = req.body ?? {};
  let polygon = body.polygon ?? null;
  if (!polygon && [body.lat, body.lng, body.radiusM].every((v) => Number.isFinite(v))) {
    if (body.radiusM <= 0 || body.radiusM > 100_000) {
      return res.status(400).json({ error: 'radiusM must be between 1 and 100000' });
    }
    polygon = geofence.circlePolygon(body.lat, body.lng, body.radiusM);
  }
  if (!polygon || !geofence.setBoundary(polygon)) {
    return res.status(400).json({
      error: 'body must be { polygon: GeoJSON Polygon } or { lat, lng, radiusM }',
    });
  }
  db.saveVenueBoundary(polygon); // fire-and-forget, no-op without DB
  res.json({ boundary: geofence.getBoundary() });
});

router.delete('/boundary', requireAdmin, (_req, res) => {
  geofence.setBoundary(null);
  db.saveVenueBoundary(null);
  res.status(204).end();
});

export default router;
