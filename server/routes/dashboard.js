// Ops dashboard API (Prompt 6). Every endpoint requires an active staff
// session; every response except /incidents/identified is aggregated and
// anonymized (see dashboardStore.js — no guest ids, no raw position_fix
// rows). The identified incident view requires the SECURITY role: enforced
// again inside db/access.js in the same transaction that writes the
// audit_log rows, so a non-Security account is rejected at the data layer
// even if it crafts the request by hand.
import { Router } from 'express';
import * as db from '../db/index.js';
import * as access from '../db/access.js';
import * as store from '../dashboardStore.js';
import * as geofence from '../geofence.js';
import { requireStaff } from '../staffAuth.js';

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
};

export default function createDashboardRouter({ getLiveGroup }) {
  const router = Router();

  // Everything below needs a staff session (any role unless noted).
  router.use(requireStaff());

  async function eventCtx(req, res) {
    const code = String(req.query.code ?? req.body?.code ?? '').toUpperCase().trim();
    if (!code) {
      res.status(400).json({ error: 'code (group code) required' });
      return null;
    }
    return {
      code,
      eventId: db.enabled ? await db.ensureEventForGroup(code) : null,
      eventKey: `code:${code}`,
      group: getLiveGroup(code),
    };
  }

  // ---- live crowd density (aggregated cells) ----
  router.get('/heatmap', wrap(async (req, res) => {
    const ctx = await eventCtx(req, res);
    if (!ctx) return;
    const data = await store.heatmap(ctx);
    res.json({ ...data, gridDeg: 0.00025, boundary: geofence.getBoundary(), generatedAt: new Date().toISOString() });
  }));

  // ---- zones + capacity alerts ----
  router.get('/zones', wrap(async (req, res) => {
    const ctx = await eventCtx(req, res);
    if (!ctx) return;
    res.json({ zones: await store.zoneStatus(ctx) });
  }));

  router.post('/zones', requireStaff(['admin', 'promoter']), wrap(async (req, res) => {
    const { name, capacity, lat, lng, radiusM, polygon } = req.body ?? {};
    const zoneName = String(name ?? '').trim().slice(0, 60);
    const cap = Number.isFinite(capacity) ? Math.max(1, Math.floor(capacity)) : null;
    let poly = polygon ?? null;
    if (!poly && [lat, lng, radiusM].every(Number.isFinite)) {
      poly = geofence.circlePolygon(lat, lng, radiusM);
    }
    if (!zoneName || !poly || !geofence.isValidPolygon(poly)) {
      return res.status(400).json({ error: 'name plus polygon or lat/lng/radiusM required' });
    }
    res.status(201).json({ zone: await store.createZone({ name: zoneName, capacity: cap, polygon: poly }) });
  }));

  router.delete('/zones/:id', requireStaff(['admin', 'promoter']), wrap(async (req, res) => {
    const gone = await store.deleteZone(req.params.id);
    if (!gone) return res.status(404).json({ error: 'zone not found' });
    res.status(204).end();
  }));

  // ---- incidents: identity-free summary + reporting ----
  router.get('/incidents', wrap(async (req, res) => {
    const ctx = await eventCtx(req, res);
    if (!ctx) return;
    res.json({
      ...await store.incidentSummary(ctx),
      categories: store.INCIDENT_CATEGORIES,
    });
  }));

  router.post('/incidents', wrap(async (req, res) => {
    const ctx = await eventCtx(req, res);
    if (!ctx) return;
    const { category, description, lat, lng, zoneId, subjectGuestId } = req.body ?? {};
    const created = await store.createIncident({
      ...ctx,
      category,
      description: description ? String(description).slice(0, 500) : null,
      lat: num(lat), lng: num(lng),
      zoneId: typeof zoneId === 'string' ? zoneId : null,
      subjectGuestId: typeof subjectGuestId === 'string' ? subjectGuestId : null,
      reportedBy: req.staff.id,
    });
    if (!created) {
      return res.status(400).json({ error: `category must be one of: ${store.INCIDENT_CATEGORIES.join(', ')}` });
    }
    res.status(201).json({ incident: created });
  }));

  router.patch('/incidents/:id', wrap(async (req, res) => {
    const ok = await store.setIncidentStatus(req.params.id, req.body?.status);
    if (!ok) return res.status(400).json({ error: 'unknown incident or bad status' });
    res.json({ ok: true });
  }));

  // ---- identified incidents: SECURITY ONLY, audited ----
  router.get('/incidents/identified', requireStaff(['security']), wrap(async (req, res) => {
    const ctx = await eventCtx(req, res);
    if (!ctx) return;
    if (db.enabled) {
      // Role re-checked + audit_log written inside this call's transaction.
      const incidents = await access.listIdentifiedIncidents({
        staffSessionId: req.staff.id, eventId: ctx.eventId,
      });
      return res.json({ incidents, audited: true });
    }
    console.log(`[audit] identified incident view by staff ${req.staff.id} (memory mode)`);
    res.json({
      incidents: store.memoryIdentifiedIncidents(ctx),
      audited: false, memoryMode: true,
    });
  }));

  // ---- post-event analytics + CSV export ----
  router.get('/analytics', wrap(async (req, res) => {
    const ctx = await eventCtx(req, res);
    if (!ctx) return;
    const data = await store.analytics(ctx);
    if (req.query.format === 'csv') {
      res.set('Content-Type', 'text/csv');
      res.set('Content-Disposition', `attachment; filename="nannaboo-analytics-${ctx.code}.csv"`);
      return res.send(store.analyticsCsv(data));
    }
    res.json(data);
  }));

  router.use((err, _req, res, _next) => {
    if (err instanceof access.AccessDeniedError) {
      return res.status(403).json({ error: err.message });
    }
    console.error('[dashboard]', err);
    res.status(500).json({ error: 'internal error' });
  });

  return router;
}
