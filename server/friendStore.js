// Friend layer: mutual-accept requests + per-direction sharing levels.
// Same dual-backend contract as poiStore: PostGIS/Postgres when the DB is up
// (friendships survive restarts and 'always' spans sessions), in-memory Maps
// otherwise. This is guest-to-guest opt-in sharing only — completely separate
// from the staff venue_safety_network / identified_security_roster scopes.
//
// Semantics:
// - A pair are "friends" when links exist in BOTH directions.
// - Each link's sharing_level is set by its sharer (guest_id) and controls
//   whether friend_guest_id sees them in the FRIENDS layer:
//     off             -> hidden (base everyone-in-group layer is unaffected)
//     this_event_only -> visible only within the event stored on the link
//                        (where the friendship formed) — the default
//     always          -> visible in any shared event, across sessions
// - eventKey is the event uuid in DB mode, or 'code:<GROUP>' in memory mode.
import { randomUUID } from 'crypto';
import * as db from './db/index.js';

export const LEVELS = ['off', 'this_event_only', 'always'];

// In-memory fallback state
const names = new Map();    // guestId -> display name (both modes, name fallback)
const requests = new Map(); // id -> { id, from, to, eventKey, status }
const links = new Map();    // `${sharer}|${viewer}` -> { level, eventKey }

const pairKey = (sharer, viewer) => `${sharer}|${viewer}`;

export function rememberName(guestId, name) {
  names.set(guestId, name);
}

const nameOf = (id, dbNames) => dbNames?.get(id) ?? names.get(id) ?? 'Unknown';

function visible(theirLevel, theirEventKey, currentEventKey) {
  if (theirLevel === 'always') return true;
  if (theirLevel === 'this_event_only') {
    return theirEventKey != null && theirEventKey === currentEventKey;
  }
  return false;
}

// ---- state for one guest ----

export async function getFriendState(guestId, eventKey) {
  if (db.enabled) {
    const pool = db.getPool();
    const [friends, reqs] = await Promise.all([
      pool.query(
        `SELECT my.friend_guest_id AS id, g.display_name AS name,
                my.sharing_level AS my_level,
                their.sharing_level AS their_level,
                their.event_id AS their_event_id
         FROM friend_link my
         JOIN friend_link their
           ON their.guest_id = my.friend_guest_id
          AND their.friend_guest_id = my.guest_id
         JOIN guest g ON g.id = my.friend_guest_id
         WHERE my.guest_id = $1
         ORDER BY g.display_name`,
        [guestId]
      ),
      pool.query(
        `SELECT r.id, r.from_guest_id, r.to_guest_id,
                gf.display_name AS from_name, gt.display_name AS to_name
         FROM friend_request r
         JOIN guest gf ON gf.id = r.from_guest_id
         JOIN guest gt ON gt.id = r.to_guest_id
         WHERE r.status = 'pending' AND (r.from_guest_id = $1 OR r.to_guest_id = $1)
         ORDER BY r.created_at`,
        [guestId]
      ),
    ]);
    return {
      friends: friends.rows.map((r) => ({
        id: r.id,
        name: r.name,
        myLevel: r.my_level,
        visibleToMe: visible(r.their_level, r.their_event_id, eventKey),
      })),
      sent: reqs.rows.filter((r) => r.from_guest_id === guestId)
        .map((r) => ({ id: r.id, toGuestId: r.to_guest_id, toName: r.to_name })),
      received: reqs.rows.filter((r) => r.to_guest_id === guestId)
        .map((r) => ({ id: r.id, fromGuestId: r.from_guest_id, fromName: r.from_name })),
    };
  }

  const friends = [];
  for (const [key, mine] of links) {
    const [sharer, viewer] = key.split('|');
    if (sharer !== guestId) continue;
    const theirs = links.get(pairKey(viewer, guestId));
    if (!theirs) continue;
    friends.push({
      id: viewer,
      name: nameOf(viewer),
      myLevel: mine.level,
      visibleToMe: visible(theirs.level, theirs.eventKey, eventKey),
    });
  }
  const pending = [...requests.values()].filter((r) => r.status === 'pending');
  return {
    friends: friends.sort((a, b) => a.name.localeCompare(b.name)),
    sent: pending.filter((r) => r.from === guestId)
      .map((r) => ({ id: r.id, toGuestId: r.to, toName: nameOf(r.to) })),
    received: pending.filter((r) => r.to === guestId)
      .map((r) => ({ id: r.id, fromGuestId: r.from, fromName: nameOf(r.from) })),
  };
}

// ---- operations ----

async function areFriends(a, b) {
  if (db.enabled) {
    const { rows } = await db.getPool().query(
      `SELECT count(*) AS n FROM friend_link
       WHERE (guest_id = $1 AND friend_guest_id = $2)
          OR (guest_id = $2 AND friend_guest_id = $1)`,
      [a, b]
    );
    return Number(rows[0].n) === 2;
  }
  return links.has(pairKey(a, b)) && links.has(pairKey(b, a));
}

async function createMutualLinks(a, b, eventKey) {
  // New friendships default to the least-persistent visible level.
  if (db.enabled) {
    await db.getPool().query(
      `INSERT INTO friend_link (guest_id, friend_guest_id, event_id, sharing_level)
       VALUES ($1, $2, $3, 'this_event_only'), ($2, $1, $3, 'this_event_only')
       ON CONFLICT (guest_id, friend_guest_id) DO NOTHING`,
      [a, b, eventKey]
    );
  } else {
    if (!links.has(pairKey(a, b))) links.set(pairKey(a, b), { level: 'this_event_only', eventKey });
    if (!links.has(pairKey(b, a))) links.set(pairKey(b, a), { level: 'this_event_only', eventKey });
  }
}

/** Returns 'requested' | 'auto_accepted' | 'already_friends'. */
export async function sendRequest(fromId, toId, eventKey) {
  if (await areFriends(fromId, toId)) return 'already_friends';

  // If they already asked us, requesting back == accepting (mutual intent).
  if (db.enabled) {
    const pool = db.getPool();
    const { rows } = await pool.query(
      `UPDATE friend_request SET status = 'accepted', responded_at = now()
       WHERE from_guest_id = $2 AND to_guest_id = $1 AND status = 'pending'
       RETURNING id`,
      [fromId, toId]
    );
    if (rows.length) {
      await createMutualLinks(fromId, toId, eventKey);
      return 'auto_accepted';
    }
    await pool.query(
      `INSERT INTO friend_request (from_guest_id, to_guest_id, event_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (from_guest_id, to_guest_id) WHERE status = 'pending' DO NOTHING`,
      [fromId, toId, eventKey]
    );
    return 'requested';
  }

  const reverse = [...requests.values()]
    .find((r) => r.from === toId && r.to === fromId && r.status === 'pending');
  if (reverse) {
    reverse.status = 'accepted';
    await createMutualLinks(fromId, toId, eventKey);
    return 'auto_accepted';
  }
  const dup = [...requests.values()]
    .find((r) => r.from === fromId && r.to === toId && r.status === 'pending');
  if (!dup) {
    const id = randomUUID();
    requests.set(id, { id, from: fromId, to: toId, eventKey, status: 'pending' });
  }
  return 'requested';
}

/** Only the recipient may respond. Returns the other guest's id, or null. */
export async function respondRequest(requestId, guestId, accept, eventKey) {
  if (db.enabled) {
    const { rows } = await db.getPool().query(
      `UPDATE friend_request
       SET status = $3, responded_at = now()
       WHERE id = $1 AND to_guest_id = $2 AND status = 'pending'
       RETURNING from_guest_id, event_id`,
      [requestId, guestId, accept ? 'accepted' : 'declined']
    );
    if (!rows.length) return null;
    if (accept) {
      await createMutualLinks(guestId, rows[0].from_guest_id, rows[0].event_id ?? eventKey);
    }
    return rows[0].from_guest_id;
  }

  const req = requests.get(requestId);
  if (!req || req.to !== guestId || req.status !== 'pending') return null;
  req.status = accept ? 'accepted' : 'declined';
  if (accept) await createMutualLinks(guestId, req.from, req.eventKey ?? eventKey);
  return req.from;
}

/** Set MY sharing level toward a friend. Returns false if not friends. */
export async function setLevel(guestId, friendId, level, eventKey) {
  if (!LEVELS.includes(level)) return false;
  if (db.enabled) {
    // this_event_only needs a non-null event on the link (schema CHECK);
    // re-point it at the current event when upgrading back from off/always.
    const { rowCount } = await db.getPool().query(
      `UPDATE friend_link
       SET sharing_level = $3::sharing_level,
           event_id = CASE WHEN $3::text = 'this_event_only'
                           THEN COALESCE($4::uuid, event_id) ELSE event_id END,
           updated_at = now()
       WHERE guest_id = $1 AND friend_guest_id = $2
         AND ($3::text <> 'this_event_only' OR COALESCE($4::uuid, event_id) IS NOT NULL)`,
      [guestId, friendId, level, eventKey]
    );
    return rowCount > 0;
  }
  const link = links.get(pairKey(guestId, friendId));
  if (!link) return false;
  link.level = level;
  if (level === 'this_event_only' && eventKey) link.eventKey = eventKey;
  return true;
}
