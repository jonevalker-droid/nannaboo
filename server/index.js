import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from './db/index.js';
import * as friendStore from './friendStore.js';
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

// Live connections by guest id (friend updates target individuals, not groups)
const sessions = new Map(); // guestId -> { ws, groupCode }

// Event identity for friend-link scoping: the DB event uuid when persistence
// is up, else the group code (in-memory mode only compares these for equality).
async function resolveEventKey(groupCode) {
  if (db.enabled) {
    const eventId = await db.ensureEventForGroup(groupCode);
    if (eventId) return eventId;
  }
  return `code:${groupCode}`;
}

// friendState is per-viewer (who my friends are, who can see me is theirs to
// know) — always sent to one guest, never broadcast with group state.
async function sendFriendState(targetGuestId) {
  const sess = sessions.get(targetGuestId);
  if (!sess || sess.ws.readyState !== 1) return;
  try {
    const eventKey = groups.get(sess.groupCode)?.eventId
      ?? await resolveEventKey(sess.groupCode);
    const state = await friendStore.getFriendState(targetGuestId, eventKey);
    sess.ws.send(JSON.stringify({ type: 'friendState', ...state }));
  } catch (err) {
    console.error('[friends] friendState failed:', err.message);
  }
}

async function handleFriendOp(msg, guestId, groupCode) {
  const group = groups.get(groupCode);
  if (!group) return;
  const eventKey = group.eventId ?? await resolveEventKey(groupCode);
  let other = null;

  if (msg.type === 'friendRequest') {
    // Requests are only to guests currently present in the same group.
    if (typeof msg.toGuestId !== 'string' || msg.toGuestId === guestId) return;
    if (!group.guests.has(msg.toGuestId)) return;
    await friendStore.sendRequest(guestId, msg.toGuestId, eventKey);
    other = msg.toGuestId;
  }

  if (msg.type === 'friendRespond') {
    other = await friendStore.respondRequest(msg.requestId, guestId, !!msg.accept, eventKey);
  }

  if (msg.type === 'friendLevel') {
    const ok = await friendStore.setLevel(guestId, msg.friendGuestId, msg.level, eventKey);
    if (ok) other = msg.friendGuestId;
  }

  await sendFriendState(guestId);
  if (other) await sendFriendState(other); // their view changed too
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

  // Protocol-level liveness: browsers answer pings automatically even when
  // the page sends no app messages (e.g. a guest still waiting on a GPS fix).
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

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

      sessions.set(guestId, { ws, groupCode });
      friendStore.rememberName(guestId, name);

      broadcast(group, groupStatePayload(group));
      persistJoin(group, groupCode, guestId, name)
        .catch(err => console.error('[db] persistJoin failed:', err.message));
      sendFriendState(guestId);
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

    if (msg.type === 'friendRequest' || msg.type === 'friendRespond' || msg.type === 'friendLevel') {
      handleFriendOp(msg, guestId, groupCode)
        .catch(err => console.error('[friends] op failed:', err.message));
    }
  });

  ws.on('close', () => {
    if (!guestId || !groupCode) return;
    if (sessions.get(guestId)?.ws === ws) sessions.delete(guestId);
    const group = groups.get(groupCode);
    if (!group) return;
    // A reconnect may already have replaced this entry with a live socket
    // (join terminates the stale one, and its close event lands here after
    // the new entry is in place). Deleting by id alone would ghost the guest:
    // still connected, but positions dropped and invisible to the group.
    if (group.guests.get(guestId)?.ws !== ws) return;
    group.guests.delete(guestId);
    broadcast(group, groupStatePayload(group));
  });

  ws.on('error', () => ws.terminate());
});

// Prune dead sockets via ping/pong instead of message activity: a connected
// guest with no GPS fix sends no position messages, and must NOT be pruned
// for being quiet. A socket that misses a whole ping round is dead; terminate
// it and let the close handler remove the guest and broadcast.
setInterval(() => {
  for (const [code, group] of groups) {
    for (const guest of group.guests.values()) {
      if (guest.ws.isAlive === false) {
        guest.ws.terminate();
        continue;
      }
      guest.ws.isAlive = false;
      guest.ws.ping();
    }
    if (group.guests.size === 0 && group.pins.length === 0) groups.delete(code);
  }
}, 60_000);

// Listen first so the live map is up even if the DB is slow or down;
// db.init() runs migrations and enables write-through when it succeeds.
server.listen(PORT, () => console.log(`NannaBoo running on :${PORT}`));
db.init();
