// Security console API (Prompt 6) — the highest-liability surface.
// Everything here requires an ACTIVE Security-role staff session (expiry is
// enforced at the data layer on every request, so a session dies mid-shift
// the moment access_expires_at passes). Rules:
//  - Identified reads (roster, guest detail, incident identify) demand a
//    reason code and write audit_log rows inside the same transaction
//    (db/access.js). Memory mode mirrors the contract and logs to console.
//  - The inbox is identity-free (has_subject flag); identity is a separate,
//    deliberate, audited call per incident.
//  - Bulk roster export needs TWO steps server-side: an intent (with reason)
//    that mints a short-lived single-use token, then the export itself.
//    There is no single request that returns the whole identified roster
//    as a file.
import { Router } from 'express';
import { randomUUID } from 'crypto';
import * as db from '../db/index.js';
import * as access from '../db/access.js';
import * as store from '../dashboardStore.js';
import * as consentStore from '../consentStore.js';
import { requireStaff } from '../staffAuth.js';
import { haversineMeters } from '../geo.js';

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Live staff positions for dispatch (console heartbeats). Ephemeral by
// design — staff locations are shift data, not history; nothing persists.
const staffPositions = new Map(); // staffSessionId -> { lat, lng, at, name }
const STAFF_FRESH_MS = 5 * 60 * 1000;

// Single-use bulk-export intents: token -> { staffId, code, reasonCode, expiresAt }
const exportIntents = new Map();
const EXPORT_INTENT_MS = 2 * 60 * 1000;

const auditLog = (msg) => console.log(`[audit] ${msg}`); // memory-mode trail

// Accuracy -> confidence, same formula the DB write path uses.
const confidenceFor = (acc) => (typeof acc === 'number'
  ? Math.max(0.1, Math.min(1, 1 - (acc - 5) / 95 * 0.9)) : 0.5);

export default function createConsoleRouter({ getLiveGroup }) {
  const router = Router();
  router.use(requireStaff(['security']));

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

  function memoryRoster(ctx) {
    const rows = [];
    for (const g of ctx.group?.guests.values() ?? []) {
      if (!consentStore.hasRosterConsent(g.id, ctx.eventKey)) continue;
      rows.push({
        id: g.id, display_name: g.name,
        lat: g.lat, lng: g.lng,
        confidence: g.lat != null ? confidenceFor(g.accuracy) : null,
        recorded_at: new Date(g.lastSeen).toISOString(),
        medical_info: consentStore.getMedicalInfo(g.id), // persistent profile
      });
    }
    return rows;
  }

  // ---- identified roster (audited, reason-coded) ----
  router.get('/roster', wrap(async (req, res) => {
    const ctx = await eventCtx(req, res);
    if (!ctx) return;
    const reasonCode = access.requireReason(String(req.query.reason ?? ''));
    if (db.enabled) {
      const roster = await access.listIdentifiedRoster({
        staffSessionId: req.staff.id, eventId: ctx.eventId, reasonCode,
      });
      return res.json({ roster, audited: true, reasonCode });
    }
    const roster = memoryRoster(ctx);
    for (const r of roster) {
      auditLog(`roster_list guest=${r.id} by=${req.staff.id} reason=${reasonCode}`);
    }
    res.json({ roster, audited: false, memoryMode: true, reasonCode });
  }));

  // ---- single guest detail (audited, reason-coded) ----
  router.get('/guest/:guestId', wrap(async (req, res) => {
    const ctx = await eventCtx(req, res);
    if (!ctx) return;
    const reasonCode = access.requireReason(String(req.query.reason ?? ''));
    if (db.enabled) {
      const guest = await access.lookupIdentifiedGuest({
        staffSessionId: req.staff.id, guestId: req.params.guestId,
        eventId: ctx.eventId, reasonCode,
      });
      return res.json({ guest, audited: true });
    }
    const guest = memoryRoster(ctx).find((r) => r.id === req.params.guestId);
    if (!guest) return res.status(404).json({ error: 'guest not found or has not consented' });
    auditLog(`guest_detail guest=${guest.id} by=${req.staff.id} reason=${reasonCode}`);
    res.json({ guest, audited: false, memoryMode: true });
  }));

  // ---- SOS/incident inbox (identity-free rows) ----
  router.get('/inbox', wrap(async (req, res) => {
    const ctx = await eventCtx(req, res);
    if (!ctx) return;
    res.json({
      incidents: await store.consoleInbox(ctx),
      categories: store.INCIDENT_CATEGORIES,
      reasonCodes: access.REASON_CODES,
    });
  }));

  // ---- identify ONE incident's subject (audited, reason-coded) ----
  router.get('/incidents/:id/subject', wrap(async (req, res) => {
    const ctx = await eventCtx(req, res);
    if (!ctx) return;
    const reasonCode = access.requireReason(String(req.query.reason ?? ''));
    if (db.enabled) {
      const subject = await access.identifyIncidentSubject({
        staffSessionId: req.staff.id, incidentId: req.params.id,
        eventId: ctx.eventId, reasonCode,
      });
      return res.json({ subject, audited: true });
    }
    const subjectId = store.memoryIncidentSubject(req.params.id, ctx.eventKey);
    if (!subjectId) return res.status(404).json({ error: 'incident not found or has no subject' });
    const g = ctx.group?.guests.get(subjectId);
    auditLog(`incident_identify incident=${req.params.id} guest=${subjectId} by=${req.staff.id} reason=${reasonCode}`);
    res.json({
      subject: {
        incident_id: req.params.id, subject_guest_id: subjectId,
        subject_name: g?.name ?? null, lat: g?.lat ?? null, lng: g?.lng ?? null,
        confidence: g?.lat != null ? confidenceFor(g.accuracy) : null,
        medical_info: consentStore.getMedicalInfo(subjectId), // profile ≠ SOS note
      },
      audited: false, memoryMode: true,
    });
  }));

  // ---- staff position heartbeat + dispatch ----
  router.post('/staff-position', (req, res) => {
    const { lat, lng } = req.body ?? {};
    if (![lat, lng].every(Number.isFinite)) return res.status(400).json({ error: 'lat/lng required' });
    staffPositions.set(req.staff.id, {
      lat, lng, at: Date.now(), name: req.staff.displayName,
    });
    res.json({ ok: true });
  });

  router.get('/dispatch/:incidentId', wrap(async (req, res) => {
    const ctx = await eventCtx(req, res);
    if (!ctx) return;
    const incident = await store.getIncident(req.params.incidentId, ctx);
    if (!incident) return res.status(404).json({ error: 'incident not found' });
    const now = Date.now();
    const staff = [...staffPositions.entries()]
      .filter(([, p]) => now - p.at < STAFF_FRESH_MS)
      .map(([id, p]) => ({
        staffSessionId: id,
        name: p.name,
        distanceM: incident.lat != null
          ? Math.round(haversineMeters({ lat: incident.lat, lng: incident.lng }, p))
          : null,
        isYou: id === req.staff.id,
      }))
      .sort((a, b) => (a.distanceM ?? 1e12) - (b.distanceM ?? 1e12));
    res.json({ incident, staff });
  }));

  router.post('/dispatch', wrap(async (req, res) => {
    const { incidentId, staffSessionId } = req.body ?? {};
    if (!incidentId || !staffSessionId) {
      return res.status(400).json({ error: 'incidentId and staffSessionId required' });
    }
    const ok = await store.assignIncident(incidentId, staffSessionId);
    if (!ok) return res.status(404).json({ error: 'incident not found' });
    res.json({ ok: true });
  }));

  // ---- bulk export: intent (reason + confirmation) then single-use token ----
  router.post('/export/intent', wrap(async (req, res) => {
    const ctx = await eventCtx(req, res);
    if (!ctx) return;
    const reasonCode = access.requireReason(String(req.body?.reason ?? ''));
    const token = randomUUID();
    exportIntents.set(token, {
      staffId: req.staff.id, code: ctx.code, reasonCode,
      expiresAt: Date.now() + EXPORT_INTENT_MS,
    });
    res.status(201).json({ token, expiresInS: EXPORT_INTENT_MS / 1000, reasonCode });
  }));

  router.get('/export', wrap(async (req, res) => {
    const ctx = await eventCtx(req, res);
    if (!ctx) return;
    const intent = exportIntents.get(String(req.query.token ?? ''));
    exportIntents.delete(String(req.query.token ?? '')); // single-use, even on failure
    if (!intent || intent.staffId !== req.staff.id || intent.code !== ctx.code
        || intent.expiresAt < Date.now()) {
      return res.status(403).json({
        error: 'bulk export requires a fresh export intent (confirmation + reason code)',
      });
    }
    let roster;
    if (db.enabled) {
      roster = await access.listIdentifiedRoster({
        staffSessionId: req.staff.id, eventId: ctx.eventId,
        reasonCode: intent.reasonCode, bulkExport: true,
      });
    } else {
      roster = memoryRoster(ctx);
      auditLog(`roster_bulk_export count=${roster.length} by=${req.staff.id} reason=${intent.reasonCode}`);
    }
    const lines = [['guest_id', 'name', 'lat', 'lng', 'confidence', 'recorded_at']];
    for (const r of roster) {
      lines.push([r.id, r.display_name, r.lat ?? '', r.lng ?? '', r.confidence ?? '', r.recorded_at ?? '']);
    }
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="roster-${ctx.code}.csv"`);
    res.send(lines.map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'));
  }));

  router.use((err, _req, res, _next) => {
    if (err instanceof access.AccessDeniedError) {
      return res.status(403).json({ error: err.message });
    }
    console.error('[console]', err);
    res.status(500).json({ error: 'internal error' });
  });

  return router;
}
