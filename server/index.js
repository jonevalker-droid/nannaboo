import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from './db/index.js';
import * as friendStore from './friendStore.js';
import * as consentStore from './consentStore.js';
import * as dashboardStore from './dashboardStore.js';
import * as geofence from './geofence.js';
import poisRouter from './routes/pois.js';
import venueRouter from './routes/venue.js';
import createSecurityRouter from './routes/security.js';
import createDashboardRouter from './routes/dashboard.js';
import createConsoleRouter from './routes/console.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// API routes must come before the static catchall
app.use(express.json());
app.use('/api/pois', poisRouter);
app.use('/api/venue', venueRouter);
app.use('/api/security', createSecurityRouter({
  getLiveGroup: (code) => groups.get(code),
}));
app.use('/api/dashboard', createDashboardRouter({
  getLiveGroup: (code) => groups.get(code),
}));
app.use('/api/console', createConsoleRouter({
  getLiveGroup: (code) => groups.get(code),
}));

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

// "Someone's looking for you" dings (friend-to-friend, user-initiated only).
// A ding to a friend who isn't connected right now waits here and is
// delivered on their next join — one pending entry per sender, latest wins.
const pendingDings = new Map(); // toGuestId -> Map(fromGuestId -> { fromName, at })
const lastDing = new Map();     // `${from}|${to}` -> ms of last ding sent
const DING_COOLDOWN_MS = 30_000;

// Stale-location support ("last seen"): a guest whose socket dies (dead
// zone, backgrounded browser) stays on the map as a disconnected entry with
// their last position instead of silently vanishing, then is pruned.
const GHOST_TTL_MS = 30 * 60_000;

// Profile photos are relayed in-memory only — captured and stored on the
// guest's device, shown live to their group, never written to the DB.
const PHOTO_DATA_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const PHOTO_MAX_CHARS = 120_000; // ~90KB decoded; a 200×200 JPEG is ~15KB

// Per-viewer friend visibility, mirrored from friendStore whenever a
// friendState is computed (join + every friend op), so groupState broadcasts
// can apply friend rules synchronously: viewerId -> Map(friendId -> visibleToMe)
const friendVisCache = new Map();

const VISIBILITY_MODES = ['public', 'friends_only', 'off'];

// Event identity for friend-link scoping: the DB event uuid when persistence
// is up, else the group code (in-memory mode only compares these for equality).
async function resolveEventKey(groupCode) {
  if (db.enabled) {
    const eventId = await db.ensureEventForGroup(groupCode);
    if (eventId) {
      // The id can roll over when the event's visibility window lapses —
      // keep the group's cached copy current for position/pin writes.
      const g = groups.get(groupCode);
      if (g) g.eventId = eventId;
      return eventId;
    }
  }
  return `code:${groupCode}`;
}

// friendState is per-viewer (who my friends are, who can see me is theirs to
// know) — always sent to one guest, never broadcast with group state.
async function sendFriendState(targetGuestId) {
  const sess = sessions.get(targetGuestId);
  if (!sess || sess.ws.readyState !== 1) return;
  try {
    // Always re-resolve (cached with the window expiry): a this_event_only
    // link must stop resolving as visible once the event window lapses.
    const eventKey = await resolveEventKey(sess.groupCode);
    const state = await friendStore.getFriendState(targetGuestId, eventKey);
    friendVisCache.set(
      targetGuestId,
      new Map(state.friends.map((f) => [
        f.id,
        // theirOff = the friend EXPLICITLY blocked this viewer, which is the
        // only friend-link state allowed to override a public guest down.
        { visibleToMe: f.visibleToMe, theirOff: f.theirLevel === 'off' },
      ]))
    );
    // Strip theirLevel from the wire: clients only ever learn the boolean.
    sess.ws.send(JSON.stringify({
      type: 'friendState',
      ...state,
      friends: state.friends.map(({ theirLevel: _t, ...f }) => f),
    }));
  } catch (err) {
    console.error('[friends] friendState failed:', err.message);
  }
}

async function handleFriendOp(msg, guestId, groupCode) {
  const group = groups.get(groupCode);
  if (!group) return;
  const eventKey = await resolveEventKey(groupCode);
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
  // Friendship/level changes alter who may see whom on the map right now
  // (friends_only guests appear to new friends; a level set to 'off'
  // overrides a public guest down) — re-send the filtered group state.
  // Photos follow listing (a newly-visible friends_only guest's photo too).
  broadcastGroup(group);
  broadcastPhotos(group);
}

// Persist the guest/event, and after a server restart reload the group's pins
// from the DB (merged behind any pins added since, capped at 3 like addPin).
async function persistJoin(group, groupCode, guestId, name, visibility) {
  db.upsertGuest(guestId, name, visibility);
  const eventId = await db.ensureEventForGroup(groupCode);
  if (!eventId) return;
  group.eventId = eventId;
  db.grantJoinConsents(guestId, eventId);
  if (group.hydrated) return;
  group.hydrated = true;
  const stored = await db.loadPins(eventId);
  const have = new Set(group.pins.map(p => p.id));
  const restored = stored.filter(p => !have.has(p.id)).map(p => ({ ...p, groupCode }));
  if (restored.length) {
    group.pins = [...restored, ...group.pins].slice(-3);
    broadcastGroup(group);
  }
}

// May VIEWER see GUEST's position right now? (Both are live group members.)
// - visibility 'off' hides in every guest layer.
// - Positions only show while inside the venue geofence (no fence = inside).
// - public ("Everyone") means everyone at the event. A friend link may only
//   override that DOWN via an EXPLICIT per-friend 'off' — a this_event_only
//   link scoped to some earlier event must NOT hide a public guest from
//   their friend while strangers still see them (4e field regression: both
//   devices public + mutual friends, no markers either way).
// - friends_only: the friend link fully decides (visibleToMe), including
//   its event scoping — that's what this_event_only means on that tier.
function canSeePosition(viewerId, g) {
  if (g.lat == null) return false;
  if (g.visibility === 'off') return false;
  if (!geofence.contains(g.lat, g.lng)) return false;
  const link = friendVisCache.get(viewerId)?.get(g.id);
  if (g.visibility === 'public') return link?.theirOff !== true;
  return link?.visibleToMe === true;
}

// groupState is per-viewer since visibility tiers (4b): each recipient gets
// only the positions they may see. 'off' guests are omitted entirely, and so
// are friends_only guests for anyone who isn't an accepted friend — not even
// their name is discoverable by strangers. Accepted friends keep them listed
// (the friend link + geofence still decide whether the position shows).
// Friendship therefore forms by the friends_only guest reaching out first.
// The viewer's own entry carries visibility + inside for the privacy UI.
// May VIEWER even see GUEST listed (name in roster / photo / friend rows)?
// 'off' guests are omitted entirely, and so are friends_only guests for
// anyone who isn't an accepted friend — not even their name is discoverable.
function listedFor(viewer, g) {
  if (g.id === viewer.id) return true;
  if (g.visibility === 'off') return false;
  if (g.visibility === 'friends_only'
      && !friendVisCache.get(viewer.id)?.has(g.id)) return false;
  return true;
}

function guestsFor(viewer, group) {
  const out = [];
  for (const g of group.guests.values()) {
    // Photos ride a separate photoState message (join/photo-change only) —
    // never the per-position groupState broadcasts, which must stay small.
    const { ws: _ws, photo: _p, disconnectedAt: _dc, ...pub } = g;
    if (g.id === viewer.id) {
      out.push(pub);
      continue;
    }
    if (!listedFor(viewer, g)) continue;
    // rosterConsent is between the guest and security — never shown to peers.
    if (canSeePosition(viewer.id, g)) {
      const { visibility: _v, inside: _i, rosterConsent: _rc, ...visible } = pub;
      out.push(visible);
    } else {
      const {
        lat: _lat, lng: _lng, accuracy: _a, heading: _h,
        visibility: _v, inside: _i, rosterConsent: _rc, ...hidden
      } = pub;
      out.push({ ...hidden, lat: null, lng: null, accuracy: null, heading: null });
    }
  }
  return out;
}

// Per-viewer photo map, gated by exactly the listing rule above: a photo is
// never exposed to anyone who couldn't already see that guest's name.
function photosFor(viewer, group) {
  const photos = {};
  for (const g of group.guests.values()) {
    if (g.id !== viewer.id && g.photo && listedFor(viewer, g)) {
      photos[g.id] = g.photo;
    }
  }
  return photos;
}

function broadcastPhotos(group) {
  for (const viewer of group.guests.values()) {
    if (viewer.ws.readyState !== 1) continue;
    viewer.ws.send(JSON.stringify({
      type: 'photoState',
      photos: photosFor(viewer, group),
    }));
  }
}

function broadcastGroup(group) {
  for (const viewer of group.guests.values()) {
    if (viewer.ws.readyState !== 1) continue;
    viewer.ws.send(JSON.stringify({
      type: 'groupState',
      guests: guestsFor(viewer, group),
      pins: group.pins,
    }));
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
      const visibility = VISIBILITY_MODES.includes(msg.visibility) ? msg.visibility : 'public';
      if (!groupCode) return;

      const group = getOrCreateGroup(groupCode);
      const existing = group.guests.get(guestId);
      if (existing && existing.ws !== ws) existing.ws.terminate();

      // Preserve joinedAt across reconnects — it feeds live dwell analytics.
      // Position, lastSeen and photo also survive a reconnect: a flaky-signal
      // guest reads as "last seen X min ago" instead of dropping off the map.
      group.guests.set(guestId, {
        ws, id: guestId, name, groupCode, visibility,
        lat: existing?.lat ?? null, lng: existing?.lng ?? null,
        accuracy: existing?.accuracy ?? null, heading: existing?.heading ?? null,
        inside: existing?.inside ?? null, // unknown until the first position fix
        photo: existing?.photo ?? null,
        connected: true,
        disconnectedAt: null,
        joinedAt: existing?.joinedAt ?? Date.now(),
        lastSeen: existing?.lastSeen ?? Date.now(),
      });

      sessions.set(guestId, { ws, groupCode });
      friendStore.rememberName(guestId, name);

      broadcastGroup(group);
      persistJoin(group, groupCode, guestId, name, visibility)
        .catch(err => console.error('[db] persistJoin failed:', err.message));
      // Un-ACKed dings land (again) now — that's the "open the app" moment
      // the copy asks for. Entries clear only on the client's dingAck, so a
      // delivery lost to a suspended tab is retried on every (re)join.
      const queued = pendingDings.get(guestId);
      if (queued) {
        for (const [fromId, d] of queued) {
          ws.send(JSON.stringify({
            type: 'ding', fromGuestId: fromId, fromName: d.fromName, at: d.at,
          }));
        }
      }
      // Once the friend cache is warm, re-send group state so friends_only
      // friends' positions appear immediately, not on the next position tick.
      // Photos go after the cache too — photosFor gates on it.
      sendFriendState(guestId).then(() => {
        const g = groups.get(groupCode);
        if (g?.guests.has(guestId)) {
          broadcastGroup(g);
          broadcastPhotos(g);
        }
      });
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
      // Geofence check per update: leaving the fence hides the guest from
      // other guests automatically; coming back shows them again.
      guest.inside = typeof msg.lat === 'number' && typeof msg.lng === 'number'
        ? geofence.contains(msg.lat, msg.lng)
        : null;
      guest.lastSeen = Date.now();
      broadcastGroup(group);
      db.recordPositionFix(guestId, group.eventId, msg);
    }

    if (msg.type === 'setVisibility') {
      const guest = group.guests.get(guestId);
      if (!guest || !VISIBILITY_MODES.includes(msg.visibility)) return;
      guest.visibility = msg.visibility;
      db.setGuestVisibility(guestId, msg.visibility);
      broadcastGroup(group);
      broadcastPhotos(group); // photo exposure follows listing
    }

    // Profile photo (same-initial icon fix). In-memory relay only: the image
    // lives on the guest's device; the server never persists it.
    if (msg.type === 'setPhoto') {
      const guest = group.guests.get(guestId);
      if (!guest) return;
      const photo = msg.photo ?? null;
      if (photo !== null
          && !(typeof photo === 'string'
               && photo.length <= PHOTO_MAX_CHARS
               && PHOTO_DATA_RE.test(photo))) return;
      guest.photo = photo;
      broadcastPhotos(group);
    }

    // "Someone's looking for you" ding: user-initiated, accepted friends
    // only (the sender's warmed visibility cache mirrors friendships), and
    // rate-limited per pair so it can't be spammed.
    if (msg.type === 'ding') {
      const guest = group.guests.get(guestId);
      if (!guest || typeof msg.toGuestId !== 'string' || msg.toGuestId === guestId) return;
      if (!friendVisCache.get(guestId)?.has(msg.toGuestId)) return;
      const key = `${guestId}|${msg.toGuestId}`;
      const nowMs = Date.now();
      if (nowMs - (lastDing.get(key) ?? 0) < DING_COOLDOWN_MS) return;
      lastDing.set(key, nowMs);
      // Store-and-forward, not fire-and-forget: iOS suspends a backgrounded
      // tab WITHOUT closing its socket, so a "live" send can land in a
      // zombie socket and vanish. Every ding stays queued until the
      // recipient's app ACKs it; join/reconnect re-flushes the queue.
      if (!pendingDings.has(msg.toGuestId)) pendingDings.set(msg.toGuestId, new Map());
      pendingDings.get(msg.toGuestId).set(guestId, { fromName: guest.name, at: nowMs });
      const target = sessions.get(msg.toGuestId);
      if (target?.ws.readyState === 1) {
        target.ws.send(JSON.stringify({
          type: 'ding', fromGuestId: guestId, fromName: guest.name, at: nowMs,
        }));
      }
      if (guest.ws.readyState === 1) {
        guest.ws.send(JSON.stringify({ type: 'dingSent', toGuestId: msg.toGuestId, at: nowMs }));
      }
    }

    // Recipient's app confirmed a ding reached a *running* page — only now
    // does it leave the queue.
    if (msg.type === 'dingAck') {
      const q = pendingDings.get(guestId);
      if (q && typeof msg.fromGuestId === 'string') {
        q.delete(msg.fromGuestId);
        if (q.size === 0) pendingDings.delete(guestId);
      }
    }

    // Explicit opt-in/out of the identified security roster (Prompt 6) —
    // the ONLY scope that shows a guest's identity to staff. Never implied.
    if (msg.type === 'setRosterConsent') {
      const guest = group.guests.get(guestId);
      if (!guest) return;
      const grant = !!msg.grant;
      guest.rosterConsent = grant;
      (async () => {
        const eventId = group.eventId
          ?? (db.enabled ? await db.ensureEventForGroup(groupCode) : null);
        await consentStore.setRosterConsent(guestId, eventId, `code:${groupCode}`, grant);
      })().catch(err => console.error('[consent] setRosterConsent failed:', err.message));
      if (guest.ws.readyState === 1) {
        guest.ws.send(JSON.stringify({ type: 'rosterConsent', granted: grant }));
      }
    }

    // Persistent medical profile (Prompt 7). The roster-consent dependency
    // is enforced inside consentStore.setMedicalInfo (data layer), so a
    // hand-crafted message without identity sharing is rejected there.
    if (msg.type === 'setMedicalInfo') {
      const guest = group.guests.get(guestId);
      if (!guest) return;
      const text = typeof msg.text === 'string' ? msg.text : null;
      (async () => {
        const eventId = group.eventId
          ?? (db.enabled ? await db.ensureEventForGroup(groupCode) : null);
        const result = await consentStore.setMedicalInfo(guestId, eventId, `code:${groupCode}`, text);
        if (guest.ws.readyState === 1) {
          guest.ws.send(JSON.stringify({ type: 'medicalInfo', saved: result.ok, error: result.error ?? null }));
        }
      })().catch(err => console.error('[medical] set failed:', err.message));
    }

    // Guest-triggered SOS: lands in the security console inbox as the
    // highest-priority incident. The note is whatever the guest chose to
    // send (e.g. medical info) — consented by the act of sending it.
    if (msg.type === 'sos') {
      const guest = group.guests.get(guestId);
      if (!guest) return;
      const lat = typeof msg.lat === 'number' ? msg.lat : guest.lat;
      const lng = typeof msg.lng === 'number' ? msg.lng : guest.lng;
      const note = msg.note ? String(msg.note).trim().slice(0, 300) : null;
      (async () => {
        const eventId = group.eventId
          ?? (db.enabled ? await db.ensureEventForGroup(groupCode) : null);
        await dashboardStore.createIncident({
          eventId, eventKey: `code:${groupCode}`,
          category: 'sos',
          description: note ? `Guest SOS — ${note}` : 'Guest SOS',
          lat: lat ?? null, lng: lng ?? null,
          zoneId: null, subjectGuestId: guestId, reportedBy: null,
        });
      })().catch(err => console.error('[sos] create failed:', err.message));
      if (guest.ws.readyState === 1) {
        guest.ws.send(JSON.stringify({ type: 'sosAck', at: Date.now() }));
      }
    }

    if (msg.type === 'addPin') {
      // Idempotent by pin id (client-generated uuid): a double-fired drop
      // handler (Enter + tap, iOS ghost click) can't create twin pins with
      // twin overlapping labels.
      const pinId = db.isUuid(msg.pinId) ? msg.pinId : randomUUID();
      if (group.pins.some(p => p.id === pinId)) return;
      if (group.pins.length >= 3) {
        const dropped = group.pins.shift(); // drop oldest
        db.deletePin(dropped.id);
      }
      const pin = {
        id: pinId,
        label: String(msg.label || 'Pin').trim().slice(0, 30),
        lat: msg.lat,
        lng: msg.lng,
        groupCode,
        createdBy: guestId,
        createdAt: Date.now(),
      };
      group.pins.push(pin);
      broadcastGroup(group);
      db.savePin(group.eventId, pin);
    }

    if (msg.type === 'removePin') {
      group.pins = group.pins.filter(p => p.id !== msg.pinId);
      broadcastGroup(group);
      db.deletePin(msg.pinId);
    }

    if (msg.type === 'friendRequest' || msg.type === 'friendRespond' || msg.type === 'friendLevel') {
      handleFriendOp(msg, guestId, groupCode)
        .catch(err => console.error('[friends] op failed:', err.message));
    }
  });

  ws.on('close', () => {
    if (!guestId || !groupCode) return;
    if (sessions.get(guestId)?.ws === ws) {
      sessions.delete(guestId);
      friendVisCache.delete(guestId);
    }
    const group = groups.get(groupCode);
    if (!group) return;
    // A reconnect may already have replaced this entry with a live socket
    // (join terminates the stale one, and its close event lands here after
    // the new entry is in place) — leave the fresh entry alone.
    const guest = group.guests.get(guestId);
    if (guest?.ws !== ws) return;
    // Don't delete: keep the entry as a disconnected "last seen" marker so a
    // dead-zone dropout reads as stale, not as the guest vanishing. The
    // sweep below prunes it after GHOST_TTL_MS (or a rejoin revives it).
    guest.connected = false;
    guest.disconnectedAt = Date.now();
    broadcastGroup(group);
  });

  ws.on('error', () => ws.terminate());
});

// Prune dead sockets via ping/pong instead of message activity: a connected
// guest with no GPS fix sends no position messages, and must NOT be pruned
// for being quiet. A socket that misses a whole ping round is dead; terminate
// it and let the close handler remove the guest and broadcast.
setInterval(() => {
  const now = Date.now();
  for (const [code, group] of groups) {
    let pruned = false;
    for (const guest of group.guests.values()) {
      // Disconnected "last seen" entries aren't pinged — just aged out.
      if (guest.connected === false) {
        if (now - (guest.disconnectedAt ?? 0) > GHOST_TTL_MS) {
          group.guests.delete(guest.id);
          pruned = true;
        }
        continue;
      }
      if (guest.ws.isAlive === false) {
        guest.ws.terminate();
        continue;
      }
      guest.ws.isAlive = false;
      guest.ws.ping();
    }
    if (pruned) broadcastGroup(group);
    if (group.guests.size === 0 && group.pins.length === 0) groups.delete(code);
  }
  // Un-ACKed dings for guests who never come back expire after a day.
  for (const [toId, q] of pendingDings) {
    for (const [fromId, d] of q) {
      if (now - d.at > 24 * 3600_000) q.delete(fromId);
    }
    if (q.size === 0) pendingDings.delete(toId);
  }
}, 60_000);

// Listen first so the live map is up even if the DB is slow or down;
// db.init() runs migrations and enables write-through when it succeeds.
// The venue geofence hydrates from the DB once it's up (in-memory mode keeps
// whatever was last PUT to /api/venue/boundary this process).
server.listen(PORT, () => console.log(`NannaBoo running on :${PORT}`));
db.init().then(async () => {
  const boundary = await db.loadVenueBoundary();
  if (boundary && geofence.setBoundary(boundary)) {
    console.log('[venue] geofence boundary loaded from DB');
  }
  // Retention purge (Prompt 7): hourly, and once shortly after boot. Rolls
  // up aggregated analytics per event before deleting raw position rows.
  const purge = () => db.purgeExpiredPositions(dashboardStore.rollupEvent)
    .catch(err => console.error('[retention] purge failed:', err.message));
  setTimeout(purge, 60_000);
  setInterval(purge, 60 * 60_000);
});
