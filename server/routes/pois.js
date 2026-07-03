// POI API. Reads are public (guests browse POIs); writes accept either the
// ADMIN_KEY or an active admin/promoter staff session (the dashboard's POI
// management panel signs requests with its session, not the raw key).
import { Router } from 'express';
import * as poiStore from '../poiStore.js';
import { getStaffSession } from '../staffAuth.js';

const router = Router();

let warnedOpenAdmin = false;
async function requireAdmin(req, res, next) {
  const key = process.env.ADMIN_KEY;
  if (!key) {
    if (!warnedOpenAdmin) {
      console.warn('[pois] ADMIN_KEY not set — POI write routes are unprotected (prototype mode)');
      warnedOpenAdmin = true;
    }
    return next();
  }
  if (req.get('x-admin-key') === key || req.query.key === key) return next();
  const staff = await getStaffSession(req.get('x-staff-session') || req.query.session);
  if (staff && ['admin', 'promoter'].includes(staff.role)) return next();
  res.status(401).json({ error: 'admin key or admin/promoter staff session required' });
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
};

// Express 4 doesn't route async rejections to error middleware.
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function validatePoiFields(body, { partial = false } = {}) {
  const out = {};
  const errors = [];
  const has = (k) => body[k] !== undefined;

  if (has('category') || !partial) {
    if (!poiStore.CATEGORIES.includes(body.category)) {
      errors.push(`category must be one of: ${poiStore.CATEGORIES.join(', ')}`);
    } else out.category = body.category;
  }
  if (has('name') || !partial) {
    const name = String(body.name ?? '').trim().slice(0, 60);
    if (!name) errors.push('name is required');
    else out.name = name;
  }
  if (has('lat') || has('lng') || !partial) {
    const lat = num(body.lat);
    const lng = num(body.lng);
    if (lat === undefined || lng === undefined || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      errors.push('lat/lng must be valid coordinates');
    } else { out.lat = lat; out.lng = lng; }
  }
  if (has('floorLevel')) out.floorLevel = body.floorLevel === null ? null : String(body.floorLevel).slice(0, 20);
  if (has('liveStatus')) out.liveStatus = body.liveStatus === null ? null : String(body.liveStatus).slice(0, 120);
  return { out, errors };
}

// GET /api/pois?category=exit&lat=..&lng=..&limit=3
// With lat/lng, results include distanceM + bearingDeg and sort nearest-first.
router.get('/', wrap(async (req, res) => {
  const { category } = req.query;
  if (category && !poiStore.CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'unknown category' });
  }
  const pois = await poiStore.listPois({
    category,
    lat: num(req.query.lat),
    lng: num(req.query.lng),
    limit: num(req.query.limit),
  });
  res.json({ pois });
}));

router.post('/', requireAdmin, wrap(async (req, res) => {
  const { out, errors } = validatePoiFields(req.body ?? {});
  if (errors.length) return res.status(400).json({ errors });
  res.status(201).json({ poi: await poiStore.createPoi(out) });
}));

router.put('/:id', requireAdmin, wrap(async (req, res) => {
  const { out, errors } = validatePoiFields(req.body ?? {}, { partial: true });
  if (errors.length) return res.status(400).json({ errors });
  const poi = await poiStore.updatePoi(req.params.id, out);
  if (!poi) return res.status(404).json({ error: 'poi not found' });
  res.json({ poi });
}));

router.delete('/:id', requireAdmin, wrap(async (req, res) => {
  const gone = await poiStore.deletePoi(req.params.id);
  if (!gone) return res.status(404).json({ error: 'poi not found' });
  res.status(204).end();
}));

// Re-center the demo POI set around any point (REPLACES the venue's POIs).
// GET is supported so it can be triggered from a phone browser:
//   /api/pois/seed-demo?lat=44.5&lng=-88.0[&key=ADMIN_KEY]
async function seedDemo(req, res) {
  const lat = num(req.query.lat ?? req.body?.lat);
  const lng = num(req.query.lng ?? req.body?.lng);
  if (lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'lat and lng are required' });
  }
  const pois = await poiStore.seedDemo({ lat, lng });
  res.json({ seeded: pois.length, pois });
}
router.post('/seed-demo', requireAdmin, wrap(seedDemo));
router.get('/seed-demo', requireAdmin, wrap(seedDemo));

// Surface unexpected errors as JSON instead of the HTML default.
router.use((err, _req, res, _next) => {
  console.error('[pois]', err);
  res.status(500).json({ error: 'internal error' });
});

export default router;
