import { useEffect, useState } from 'react';
import { haversineMeters, bearingDeg, formatDistance, cardinal } from '../lib/geo';
import { VISIBILITY_OPTIONS } from './JoinForm';

// Privacy & Safety settings (Prompt 7): the same choices made at onboarding,
// reviewable/changeable anytime — visibility, security identity sharing,
// the persistent medical profile, per-friend sharing levels, plus the
// data-retention notice with the venue's REAL configured purge window.
function MedicalSection({ rosterConsent, medicalResult, onSaveMedical }) {
  const [text, setText] = useState(() => localStorage.getItem('nb_medical_profile') ?? '');
  const [dirty, setDirty] = useState(false);
  return (
    <div className="medical-section">
      <h4>⚕ Medical info (optional)</h4>
      {rosterConsent ? (
        <>
          <textarea
            rows={2}
            maxLength={500}
            value={text}
            placeholder="e.g. Type 1 diabetic, penicillin allergy"
            onChange={(e) => { setText(e.target.value); setDirty(true); }}
          />
          <div className="medical-actions">
            <button
              className="mini-btn"
              disabled={!dirty}
              onClick={() => { onSaveMedical(text.trim()); setDirty(false); }}
            >
              Save
            </button>
            {medicalResult && !dirty && (
              <small className={medicalResult.saved ? 'medical-ok' : 'medical-err'}>
                {medicalResult.saved ? '✓ saved (encrypted)' : medicalResult.error}
              </small>
            )}
          </div>
          <p className="friends-hint">
            Stored encrypted; shown only to security responding to you,
            alongside your name.
          </p>
        </>
      ) : (
        <p className="friends-hint">
          Medical info needs identity sharing with security turned on (above)
          — otherwise responders can't connect it to you.
        </p>
      )}
    </div>
  );
}

function RetentionNotice() {
  const [hours, setHours] = useState(null);
  useEffect(() => {
    fetch('/api/venue/retention')
      .then((r) => r.json())
      .then((d) => setHours(d.hours))
      .catch(() => {});
  }, []);
  return (
    <section>
      <h4>🗑 Your data</h4>
      <p className="friends-hint">
        Raw location history is deleted after{' '}
        <strong>{hours ?? '…'} hours</strong>. Venue safety staff always see
        an anonymous dot for everyone on site (part of entry — never your
        name unless you opted in above). Only anonymous totals are kept
        longer, and every identified security view is logged and auditable.
      </p>
    </section>
  );
}

const LEVEL_LABELS = {
  off: 'Off',
  this_event_only: 'This event only',
  always: 'Always',
};

// ─── Social connect: UI STUBS ONLY ─────────────────────────────────────────
// These buttons are demo/investor polish — they perform NO OAuth and make NO
// API calls to the platforms. Real integration requires a registered
// developer app + review from each platform (weeks-to-months timelines), so
// tapping one shows a brief fake "connecting" state and then "Coming soon".
const SOCIAL_PLATFORMS = [
  {
    id: 'facebook', name: 'Facebook', bg: '#1877F2', fg: '#fff',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path fill="currentColor" d="M13.5 21v-7h2.4l.4-3h-2.8V9.1c0-.9.3-1.5 1.6-1.5h1.3V4.9c-.3 0-1.1-.1-2-.1-2 0-3.4 1.2-3.4 3.5V11H8.6v3H11v7h2.5z" />
      </svg>
    ),
  },
  {
    id: 'instagram', name: 'Instagram', fg: '#fff',
    bg: 'linear-gradient(45deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888)',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="17.2" cy="6.8" r="1.3" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: 'tiktok', name: 'TikTok', bg: '#010101', fg: '#fff',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path fill="currentColor" d="M16.6 3c.3 2 1.6 3.4 3.9 3.6v3c-1.5 0-2.8-.4-3.9-1.2v5.9c0 3.6-2.5 5.7-5.5 5.7-2.9 0-5.1-2-5.1-4.9 0-2.8 2.2-4.9 5.2-4.9.3 0 .7 0 1 .1v3.1c-.3-.1-.7-.2-1-.2-1.4 0-2.4.9-2.4 2 0 1.2 1 2 2.3 2 1.5 0 2.6-1 2.6-2.9V3h2.9z" />
      </svg>
    ),
  },
  {
    id: 'snapchat', name: 'Snapchat', bg: '#FFFC00', fg: '#000',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path fill="currentColor" d="M12 3c3 0 5 2.2 5 5.2 0 .8 0 1.6-.1 2.3.5.3 1.1-.2 1.6 0 .4.2.5.7.1 1-.5.5-1.6.8-1.8 1.5-.1.5 1.2 2.2 3.2 2.8.4.1.4.6.1.8-.7.5-2 .6-2.3.9-.2.3-.1.8-.6.9-.6.2-1.4-.2-2.3 0-.9.2-1.6 1.6-2.9 1.6s-2-1.4-2.9-1.6c-.9-.2-1.7.2-2.3 0-.5-.1-.4-.6-.6-.9-.3-.3-1.6-.4-2.3-.9-.3-.2-.3-.7.1-.8 2-.6 3.3-2.3 3.2-2.8-.2-.7-1.3-1-1.8-1.5-.4-.3-.3-.8.1-1 .5-.2 1.1.3 1.6 0-.1-.7-.1-1.5-.1-2.3C7 5.2 9 3 12 3z" />
      </svg>
    ),
  },
];

function SocialConnect() {
  // per-platform stub state: idle -> connecting (fake) -> soon
  const [states, setStates] = useState({});
  const tap = (id) => {
    if (states[id] === 'connecting') return;
    setStates((s) => ({ ...s, [id]: 'connecting' }));
    setTimeout(() => setStates((s) => ({ ...s, [id]: 'soon' })), 900);
  };
  return (
    <section>
      <h4>Find friends from your socials</h4>
      <div className="social-grid">
        {SOCIAL_PLATFORMS.map((p) => (
          <button
            key={p.id}
            className="social-btn"
            style={{ background: p.bg, color: p.fg }}
            onClick={() => tap(p.id)}
            disabled={states[p.id] === 'connecting'}
          >
            {p.icon}
            <span>
              {states[p.id] === 'connecting' ? 'Connecting…'
                : states[p.id] === 'soon' ? 'Coming soon ✨'
                : `Connect ${p.name}`}
            </span>
          </button>
        ))}
      </div>
      <p className="friends-hint">
        Import friend lists from your accounts — launching in a future update.
      </p>
    </section>
  );
}

// One flat panel for the whole friend layer: incoming/outgoing requests,
// every friend with their sharing level right on the row (req: not buried in
// nested menus), and adding anyone currently in the group.
export default function FriendsSheet({
  user, peers, myPos, friendState, friendActions,
  visibility, onChangeVisibility,
  rosterConsent, onChangeRosterConsent,
  medicalResult, onSaveMedical,
  onClose, onLocate,
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
          <h3>Friends &amp; Privacy</h3>
          <button className="friends-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <section>
          <h4>Who can see you</h4>
          <div className="visibility-options" role="radiogroup" aria-label="My visibility">
            {VISIBILITY_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={visibility === o.value}
                className={`visibility-pill ${visibility === o.value ? 'active' : ''}`}
                onClick={() => onChangeVisibility(o.value)}
              >
                {o.icon} {o.label}
              </button>
            ))}
          </div>
          <p className="friends-hint">
            {VISIBILITY_OPTIONS.find((o) => o.value === visibility)?.hint}. Your
            per-friend sharing levels below still apply on top.
          </p>
          <label className="roster-consent-row">
            <input
              type="checkbox"
              checked={rosterConsent}
              onChange={(e) => onChangeRosterConsent(e.target.checked)}
            />
            <span>
              <strong>Share my identity with event security</strong>
              <small>
                Security staff can see your name with your location when
                responding — e.g. if you press 🆘 or someone reports you
                missing. Off by default; your choice, changeable anytime.
              </small>
            </span>
          </label>
          <MedicalSection
            rosterConsent={rosterConsent}
            medicalResult={medicalResult}
            onSaveMedical={onSaveMedical}
          />
        </section>

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

        <SocialConnect />

        <RetentionNotice />
      </div>
    </div>
  );
}
