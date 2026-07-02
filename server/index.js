import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from './db/index.js';
import poisRouter from './routes/pois.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// API routes must come before the static catchall
app.use(express.json());
app.use('/api/pois', poisRouter);

// Serve React build in production
const distPath = path.join(__dirname, '../client/dist');
app.use(express.static(distPath));
app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));

// In-memory state — still authoritative for the live map. The db module
// write-through persists behind it and is a no-op without DATABASE_URL.
// GuestState: { ws, id, name, groupCode, lat, lng, accuracy, heading, lastSeen }
// Pin:        { id, label, lat, lng, groupCode, createdBy, createdAt }
const groups = new Map();

function getOrCreateGroup(code) {
  if (!groups.has(code)) {
    groups.set(code, { guests: new Map(), pins: [], eventId: null, hydrated: false });
  }
  return groups.get(code);
}

// Persist the guest/event, and after a server restart reload the group's pins
// from the DB (merged behind any pins added since, capped at 3 like addPin).
async function persistJoin(group, groupCode, guestId, name) {
  db.upsertGuest(guestId, name);
  const eventId = await db.ensureEventForGroup(groupCode);
  if (!eventId) return;
  group.eventId = eventId;
  db.grantFriendSharing(guestId, eventId);
  if (group.hydrated) return;
  group.hydrated = true;
  const stored = await db.loadPins(eventId);
  const have = new Set(group.pins.map(p => p.id));
  const restored = stored.filter(p => !have.has(p.id)).map(p => ({ ...p, groupCode }));
  if (restored.length) {
    group.pins = [...restored, ...group.pins].slice(-3);
    broadcast(group, groupStatePayload(group));
  }
}

function groupStatePayload(group) {
  return {
    type: 'groupState',
    guests: [...group.guests.values()].map(({ ws: _ws, ...g }) => g),
    pins: group.pins,
  };
}

function broadcast(group, payload) {
  const msg = JSON.stringify(payload);
  for (const g of group.guests.values()) {
    if (g.ws.readyState === 1) g.ws.send(msg);
  }
}

wss.on('connection', (ws) => {
  let guestId = null;
  let groupCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      // Client ids come from crypto.randomUUID() in localStorage; anything
      // else gets a fresh one (also keeps guest.id a valid uuid in the DB).
      guestId = db.isUuid(msg.guestId) ? msg.guestId : randomUUID();
      groupCode = String(msg.groupCode || '').toUpperCase().trim();
      const name = String(msg.name || 'Unknown').trim().slice(0, 40);
      if (!groupCode) return;

      const group = getOrCreateGroup(groupCode);
      const existing = group.guests.get(guestId);
      if (existing && existing.ws !== ws) existing.ws.terminate();

      group.guests.set(guestId, {
        ws, id: guestId, name, groupCode,
        lat: null, lng: null, accuracy: null, heading: null,
        lastSeen: Date.now(),
      });

      broadcast(group, groupStatePayload(group));
      persistJoin(group, groupCode, guestId, name)
        .catch(err => console.error('[db] persistJoin failed:', err.message));
      return;
    }

    if (!guestId || !groupCode) return;
    const group = groups.get(groupCode);
    if (!group) return;

    if (msg.type === 'position') {
      const guest = group.guests.get(guestId);
      if (!guest) return;
      guest.lat = msg.lat;
      guest.lng = msg.lng;
      guest.accuracy = msg.accuracy;
      guest.heading = msg.heading ?? null;
      guest.lastSeen = Date.now();
      broadcast(group, groupStatePayload(group));
      db.recordPositionFix(guestId, group.eventId, msg);
    }

    if (msg.type === 'addPin') {
      if (group.pins.length >= 3) {
        const dropped = group.pins.shift(); // drop oldest
        db.deletePin(dropped.id);
      }
      const pin = {
        id: randomUUID(),
        label: String(msg.label || 'Pin').trim().slice(0, 30),
        lat: msg.lat,
        lng: msg.lng,
        groupCode,
        createdBy: guestId,
        createdAt: Date.now(),
      };
      group.pins.push(pin);
      broadcast(group, groupStatePayload(group));
      db.savePin(group.eventId, pin);
    }

    if (msg.type === 'removePin') {
      group.pins = group.pins.filter(p => p.id !== msg.pinId);
      broadcast(group, groupStatePayload(group));
      db.deletePin(msg.pinId);
    }
  });

  ws.on('close', () => {
    if (!guestId || !groupCode) return;
    const group = groups.get(groupCode);
    if (!group) return;
    group.guests.delete(guestId);
    broadcast(group, groupStatePayload(group));
  });

  ws.on('error', () => ws.terminate());
});

// Prune guests gone >5 min
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [code, group] of groups) {
    for (const [id, guest] of group.guests) {
      if (guest.lastSeen < cutoff) {
        guest.ws.terminate();
        group.guests.delete(id);
      }
    }
    if (group.guests.size === 0 && group.pins.length === 0) groups.delete(code);
  }
}, 60_000);

// Listen first so the live map is up even if the DB is slow or down;
// db.init() runs migrations and enables write-through when it succeeds.
server.listen(PORT, () => console.log(`NannaBoo running on :${PORT}`));
db.init();
