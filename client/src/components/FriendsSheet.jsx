import { haversineMeters, bearingDeg, formatDistance, cardinal } from '../lib/geo';

const LEVEL_LABELS = {
  off: 'Off',
  this_event_only: 'This event only',
  always: 'Always',
};

// One flat panel for the whole friend layer: incoming/outgoing requests,
// every friend with their sharing level right on the row (req: not buried in
// nested menus), and adding anyone currently in the group.
export default function FriendsSheet({
  user, peers, myPos, friendState, friendActions, onClose, onLocate,
}) {
  const { friends, sent, received } = friendState;
  const friendIds = new Set(friends.map((f) => f.id));
  const pendingIds = new Set([
    ...sent.map((r) => r.toGuestId),
    ...received.map((r) => r.fromGuestId),
  ]);
  const addable = peers.filter((p) => !friendIds.has(p.id) && !pendingIds.has(p.id));
  const peerById = new Map(peers.map((p) => [p.id, p]));

  const distanceLine = (guestId) => {
    const p = peerById.get(guestId);
    if (!p || p.lat == null || !myPos) return null;
    return `${formatDistance(haversineMeters(myPos, p))} · ${cardinal(bearingDeg(myPos, p))}`;
  };

  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div className="sheet friends-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="friends-header">
          <h3>Friends</h3>
          <button className="friends-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {received.length > 0 && (
          <section>
            <h4>Requests for you</h4>
            {received.map((r) => (
              <div key={r.id} className="friend-row">
                <span className="friend-name">{r.fromName}</span>
                <span className="friend-row-actions">
                  <button className="mini-btn accept" onClick={() => friendActions.respond(r.id, true)}>
                    Accept
                  </button>
                  <button className="mini-btn" onClick={() => friendActions.respond(r.id, false)}>
                    Decline
                  </button>
                </span>
              </div>
            ))}
          </section>
        )}

        {sent.length > 0 && (
          <section>
            <h4>Sent</h4>
            {sent.map((r) => (
              <div key={r.id} className="friend-row">
                <span className="friend-name">{r.toName}</span>
                <span className="friend-pending">pending…</span>
              </div>
            ))}
          </section>
        )}

        <section>
          <h4>My friends</h4>
          {friends.length === 0 && (
            <p className="friends-empty">No friends yet — add someone from your group below.</p>
          )}
          {friends.map((f) => (
            <div key={f.id} className="friend-row">
              <span className="friend-name">
                ⭐ {f.name}
                <small>
                  {f.visibleToMe
                    ? (distanceLine(f.id) ?? 'sharing with you')
                    : 'not sharing with you'}
                </small>
              </span>
              <span className="friend-row-actions">
                {f.visibleToMe && peerById.get(f.id)?.lat != null && (
                  <button
                    className="mini-btn"
                    title="Point me there"
                    onClick={() => { onLocate(f.id); onClose(); }}
                  >
                    📷
                  </button>
                )}
                <select
                  className="level-select"
                  value={f.myLevel}
                  onChange={(e) => friendActions.setLevel(f.id, e.target.value)}
                  aria-label={`Sharing level for ${f.name}`}
                >
                  {Object.entries(LEVEL_LABELS).map(([v, label]) => (
                    <option key={v} value={v}>{label}</option>
                  ))}
                </select>
              </span>
            </div>
          ))}
          {friends.length > 0 && (
            <p className="friends-hint">
              The dropdown is what <strong>{user.name}</strong> shares with them — they control what you see.
            </p>
          )}
        </section>

        <section>
          <h4>In your group now</h4>
          {addable.length === 0 && (
            <p className="friends-empty">Everyone here is already a friend or pending.</p>
          )}
          {addable.map((p) => (
            <div key={p.id} className="friend-row">
              <span className="friend-name">{p.name}</span>
              <button className="mini-btn add" onClick={() => friendActions.request(p.id)}>
                + Add friend
              </button>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
