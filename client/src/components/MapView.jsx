import { useEffect, useRef, useState, useCallback } from 'react';
import {
  MapContainer, TileLayer, Marker, Popup, Circle,
  useMap, useMapEvents,
} from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import ARView from './ARView';
import FriendsSheet from './FriendsSheet';
import { haversineMeters, bearingDeg, formatDistance, cardinal } from '../lib/geo';

export const CATEGORY_META = {
  exit:             { emoji: '🚪', label: 'Exits',     color: '#d32f2f' },
  restroom:         { emoji: '🚻', label: 'Restrooms', color: '#7b1fa2' },
  medic:            { emoji: '⛑️', label: 'Medic',     color: '#c62828' },
  food:             { emoji: '🍔', label: 'Food',      color: '#ef6c00' },
  drink:            { emoji: '🥤', label: 'Drinks',    color: '#0288d1' },
  smoking:          { emoji: '🚬', label: 'Smoking',   color: '#616161' },
  atm:              { emoji: '💵', label: 'ATM',       color: '#2e7d32' },
  lost_and_found:   { emoji: '🧸', label: 'Lost & Found', color: '#6d4c41' },
  info:             { emoji: 'ℹ️', label: 'Info',      color: '#1565c0' },
  charging:         { emoji: '🔌', label: 'Charging',  color: '#455a64' },
  merch:            { emoji: '🛍️', label: 'Merch',     color: '#ad1457' },
  coat_check:       { emoji: '🧥', label: 'Coat Check', color: '#5d4037' },
  accessible_route: { emoji: '♿', label: 'Accessible', color: '#00695c' },
  parking:          { emoji: '🅿️', label: 'Parking',   color: '#283593' },
  rideshare:        { emoji: '🚗', label: 'Rideshare', color: '#4527a0' },
  water:            { emoji: '💧', label: 'Water',     color: '#0097a7' },
  quiet_room:       { emoji: '🤫', label: 'Quiet Room', color: '#37474f' },
  other:            { emoji: '📌', label: 'Other',     color: '#546e7a' },
};

function poiIcon(category) {
  const meta = CATEGORY_META[category] ?? CATEGORY_META.other;
  return L.divIcon({
    className: '',
    html: `<div style="
      width:34px;height:34px;background:white;
      border:3px solid ${meta.color};border-radius:50%;
      display:flex;align-items:center;justify-content:center;
      font-size:17px;box-shadow:0 2px 8px rgba(0,0,0,.35);
      user-select:none;
    ">${meta.emoji}</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -20],
  });
}

const COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
  '#9b59b6', '#1abc9c', '#e67e22', '#c0392b',
];

function colorFor(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

function avatarIcon(color, initial, isMe = false, isFriend = false) {
  const sz = isMe ? 46 : 38;
  const border = isMe ? '3px solid white' : '2px solid white';
  const badge = isFriend
    ? `<div style="
        position:absolute;bottom:-3px;right:-3px;
        width:16px;height:16px;background:white;border-radius:50%;
        display:flex;align-items:center;justify-content:center;
        font-size:10px;box-shadow:0 1px 4px rgba(0,0,0,.4);
      ">⭐</div>`
    : '';
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:${sz}px;height:${sz}px;">
      <div style="
      width:${sz}px;height:${sz}px;background:${color};
      border:${border};border-radius:50%;
      display:flex;align-items:center;justify-content:center;
      color:white;font-weight:800;font-size:${isMe ? 18 : 15}px;
      font-family:-apple-system,sans-serif;
      box-shadow:0 2px 10px rgba(0,0,0,.45);
      user-select:none;
    ">${initial.toUpperCase()}</div>${badge}</div>`,
    iconSize: [sz, sz],
    iconAnchor: [sz / 2, sz / 2],
    popupAnchor: [0, -(sz / 2 + 4)],
  });
}

function pinIcon(label) {
  return L.divIcon({
    html: `<div style="
      position:relative;display:inline-block;
      background:white;border:2px solid #333;border-radius:8px;
      padding:4px 8px;font-size:12px;font-weight:700;
      font-family:-apple-system,sans-serif;white-space:nowrap;
      box-shadow:0 2px 8px rgba(0,0,0,.3);
    ">📍 ${label}<div style="
      position:absolute;bottom:-9px;left:50%;transform:translateX(-50%);
      width:0;height:0;
      border-left:7px solid transparent;border-right:7px solid transparent;
      border-top:9px solid #333;
    "></div></div>`,
    className: '',
    iconAnchor: [0, 36],
    popupAnchor: [0, -38],
  });
}

// Flies to my first real GPS fix; until one arrives, flies once to the best
// group context (a peer's position or a shared pin) so the viewer is never
// staring at an arbitrary hardcoded place.
function AutoCenter({ myPos, context }) {
  const map = useMap();
  const flownToGps = useRef(false);
  const flownToContext = useRef(false);
  useEffect(() => {
    if (myPos && !flownToGps.current) {
      flownToGps.current = true;
      map.flyTo([myPos.lat, myPos.lng], 16, { duration: 1.5 });
    } else if (!myPos && context && !flownToContext.current) {
      flownToContext.current = true;
      map.flyTo([context.lat, context.lng], 15, { duration: 1.5 });
    }
  }, [myPos, context, map]);
  return null;
}

function TapListener({ active, onTap }) {
  useMapEvents({
    click(e) {
      if (active) onTap(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

export default function MapView({
  user, peers, pins, friendState, friendActions, wsStatus,
  myPos, geoStatus, geoDetail, onGeoRetry,
  visibility, onChangeVisibility, insideVenue,
  rosterConsent, onChangeRosterConsent,
  sosState, onSendSos, onResetSos,
  onAddPin, onRemovePin,
}) {
  const [placing, setPlacing] = useState(false);
  const [sosOpen, setSosOpen] = useState(false);
  const [sosNote, setSosNote] = useState(
    () => localStorage.getItem('nb_medical_note') ?? ''
  );
  const [pinLabel, setPinLabel] = useState('');
  const [pendingLL, setPendingLL] = useState(null);
  const [pois, setPois] = useState([]);
  const [poiFilter, setPoiFilter] = useState('all');
  const [arTarget, setArTarget] = useState(null);
  const [showFriends, setShowFriends] = useState(false);

  const friendById = new Map(friendState.friends.map((f) => [f.id, f]));
  const sentToIds = new Set(friendState.sent.map((r) => r.toGuestId));
  const receivedFrom = new Map(friendState.received.map((r) => [r.fromGuestId, r]));

  // Friend AR targets track the live peer position instead of a snapshot.
  const resolveArTarget = () => {
    if (!arTarget) return null;
    if (!arTarget.peerId) return arTarget;
    const p = peers.find((pp) => pp.id === arTarget.peerId);
    return p && p.lat != null ? { ...arTarget, lat: p.lat, lng: p.lng } : null;
  };
  const liveArTarget = resolveArTarget();

  const locateFriend = (peerId) => {
    const p = peers.find((pp) => pp.id === peerId);
    if (p) setArTarget({ peerId, name: p.name });
  };
  const inputRef = useRef(null);

  useEffect(() => {
    fetch('/api/pois')
      .then((r) => r.json())
      .then((d) => setPois(d.pois ?? []))
      .catch((err) => console.warn('pois:', err));
  }, []);

  const visiblePois = poiFilter === 'all'
    ? pois
    : poiFilter === 'friends' ? []
    : pois.filter((p) => p.category === poiFilter);

  // Friends filter narrows the PEER layer to friends. The server already
  // decides whose position I may see (per-viewer groupState) — so membership
  // is the only client-side criterion; gating on visibleToMe here would hide
  // a public friend whose this_event_only link is scoped to an older event.
  const visiblePeers = poiFilter === 'friends'
    ? peers.filter((p) => friendById.has(p.id))
    : peers;

  const poiCategories = [...new Set(pois.map((p) => p.category))]
    .sort((a, b) => (a === 'exit' ? -1 : b === 'exit' ? 1 : a.localeCompare(b)));

  const nearestExit = () => {
    const exits = pois.filter((p) => p.category === 'exit');
    if (!exits.length || !myPos) return null;
    return exits.reduce((best, p) =>
      haversineMeters(myPos, p) < haversineMeters(myPos, best) ? p : best);
  };

  const handleTap = useCallback((lat, lng) => {
    setPendingLL({ lat, lng });
    setPlacing(false);
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  const confirmPin = () => {
    onAddPin(pinLabel.trim() || 'Pin', pendingLL.lat, pendingLL.lng);
    setPendingLL(null);
    setPinLabel('');
  };

  const cancelPin = () => {
    setPendingLL(null);
    setPinLabel('');
    setPlacing(false);
  };

  // Initial center is only ever a real coordinate: my GPS, a groupmate's
  // position, or a shared pin. With none of those yet, start on a world view
  // (unmistakably "no location") — never a hardcoded placeholder that looks
  // like someone's actual position.
  const peerWithPos = peers.find((p) => p.lat != null);
  const contextCenter = myPos ?? peerWithPos ?? pins[0] ?? null;

  return (
    <div className="map-screen">
      <div className="status-bar">
        <span className="group-label">{user.groupCode}</span>
        <button
          className="exit-ar-btn"
          title="Point me to the nearest exit"
          onClick={() => {
            const exit = nearestExit();
            if (exit) setArTarget(exit);
            else alert(myPos ? 'No exits mapped yet' : 'Waiting for GPS fix…');
          }}
        >
          🚪 Exit
        </button>
        <button
          className="sos-btn"
          title="Alert event security"
          onClick={() => { onResetSos(); setSosOpen(true); }}
        >
          🆘
        </button>
        <button
          className="friends-btn"
          title="Friends"
          onClick={() => setShowFriends(true)}
        >
          👥
          {friendState.received.length > 0 && (
            <span className="friends-badge">{friendState.received.length}</span>
          )}
        </button>
        <span className={`ws-dot ws-${wsStatus}`} title={wsStatus} />
        <span className="peer-count">
          {peers.length + 1} {peers.length + 1 === 1 ? 'person' : 'people'}
        </span>
      </div>

      {(pois.length > 0 || friendState.friends.length > 0) && (
        <div className="poi-filter-bar">
          <button
            className={`poi-chip ${poiFilter === 'all' ? 'active' : ''}`}
            onClick={() => setPoiFilter('all')}
          >
            All
          </button>
          <button
            className={`poi-chip ${poiFilter === 'friends' ? 'active' : ''}`}
            style={poiFilter === 'friends' ? { background: '#f9a825', borderColor: '#f9a825' } : {}}
            onClick={() => setPoiFilter(poiFilter === 'friends' ? 'all' : 'friends')}
          >
            ⭐ Friends
          </button>
          {poiCategories.map((cat) => {
            const meta = CATEGORY_META[cat] ?? CATEGORY_META.other;
            return (
              <button
                key={cat}
                className={`poi-chip ${poiFilter === cat ? 'active' : ''}`}
                style={poiFilter === cat ? { background: meta.color, borderColor: meta.color } : {}}
                onClick={() => setPoiFilter(poiFilter === cat ? 'all' : cat)}
              >
                {meta.emoji} {meta.label}
              </button>
            );
          })}
        </div>
      )}

      {geoStatus !== 'ok' && (
        <div className={`geo-banner geo-${geoStatus}`}>
          {geoStatus === 'locating' && <span>📡 Finding your GPS position…</span>}
          {geoStatus === 'denied' && (
            <span>
              ⚠️ Location is blocked — allow it for this site in your browser
              settings, then{' '}
              <button className="geo-retry-btn" onClick={onGeoRetry}>
                try again
              </button>
              <span className="geo-detail">
                iPhone: also check Settings → Privacy &amp; Security → Location
                Services → Safari Websites → “While Using the App”.
                {geoDetail ? ` (${geoDetail})` : ''}
              </span>
            </span>
          )}
          {geoStatus === 'unavailable' && (
            <span>⚠️ This device can't share its location</span>
          )}
        </div>
      )}

      {/* Own privacy state: the server decides what others see; these banners
          just tell the guest why they may currently be invisible. */}
      {visibility === 'off' && (
        <div className="fence-banner">
          🙈 You're hidden from other guests — change it in the 👥 panel
        </div>
      )}
      {visibility !== 'off' && insideVenue === false && (
        <div className="fence-banner">
          🚧 You're outside the venue — other guests can't see you until you're back inside
        </div>
      )}

      <MapContainer
        center={contextCenter ? [contextCenter.lat, contextCenter.lng] : [20, 0]}
        zoom={contextCenter ? 15 : 2}
        style={{ flex: 1 }}
        zoomControl
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://osm.org/copyright">OpenStreetMap</a>'
          maxZoom={19}
        />

        <AutoCenter myPos={myPos} context={peerWithPos ?? pins[0] ?? null} />
        <TapListener active={placing} onTap={handleTap} />

        {myPos && (
          <>
            <Marker
              position={[myPos.lat, myPos.lng]}
              icon={avatarIcon('#007AFF', user.name[0], true)}
              zIndexOffset={1000}
            >
              <Popup>
                <strong>You</strong> — {user.name}
              </Popup>
            </Marker>
            {myPos.accuracy > 0 && (
              <Circle
                center={[myPos.lat, myPos.lng]}
                radius={myPos.accuracy}
                pathOptions={{
                  color: '#007AFF', fillColor: '#007AFF',
                  fillOpacity: 0.08, weight: 1,
                }}
              />
            )}
          </>
        )}

        {visiblePeers.filter((p) => p.lat != null).map((peer) => {
          const friend = friendById.get(peer.id);
          const request = receivedFrom.get(peer.id);
          return (
            <Marker
              key={peer.id}
              position={[peer.lat, peer.lng]}
              icon={avatarIcon(colorFor(peer.id), peer.name[0], false, !!friend)}
            >
              <Popup>
                <strong>{friend ? '⭐ ' : ''}{peer.name}</strong>
                {myPos && (
                  <>
                    <br />
                    <span className="poi-popup-meta">
                      {formatDistance(haversineMeters(myPos, peer))} · {cardinal(bearingDeg(myPos, peer))}
                    </span>
                  </>
                )}
                <br />
                {friend && friend.visibleToMe && (
                  <button className="poi-ar-btn" onClick={() => locateFriend(peer.id)}>
                    📷 Point me there
                  </button>
                )}
                {!friend && request && (
                  <button
                    className="poi-ar-btn"
                    onClick={() => friendActions.respond(request.id, true)}
                  >
                    ✓ Accept friend request
                  </button>
                )}
                {!friend && !request && (
                  sentToIds.has(peer.id)
                    ? <em className="poi-popup-meta">Friend request sent</em>
                    : <button className="poi-ar-btn" onClick={() => friendActions.request(peer.id)}>
                        ➕ Add friend
                      </button>
                )}
              </Popup>
            </Marker>
          );
        })}

        {visiblePois.map((poi) => {
          const meta = CATEGORY_META[poi.category] ?? CATEGORY_META.other;
          return (
            <Marker
              key={poi.id}
              position={[poi.lat, poi.lng]}
              icon={poiIcon(poi.category)}
            >
              <Popup>
                <strong>{meta.emoji} {poi.name}</strong>
                <br />
                <span className="poi-popup-meta">
                  {meta.label}
                  {poi.floorLevel && ` · Floor ${poi.floorLevel}`}
                  {myPos && ` · ${formatDistance(haversineMeters(myPos, poi))}`}
                </span>
                {poi.liveStatus && (
                  <>
                    <br />
                    <em className="poi-popup-status">{poi.liveStatus}</em>
                  </>
                )}
                <br />
                <button
                  className="poi-ar-btn"
                  onClick={() => setArTarget(poi)}
                >
                  📷 Point me there
                </button>
              </Popup>
            </Marker>
          );
        })}

        {pins.map((pin) => (
          <Marker
            key={pin.id}
            position={[pin.lat, pin.lng]}
            icon={pinIcon(pin.label)}
          >
            <Popup>
              <strong>{pin.label}</strong>
              <br />
              <button
                className="popup-remove-btn"
                onClick={() => onRemovePin(pin.id)}
              >
                Remove
              </button>
            </Popup>
          </Marker>
        ))}
      </MapContainer>

      {/* Floating "Drop Pin" button */}
      {!placing && !pendingLL && (
        <button className="fab" onClick={() => setPlacing(true)} title="Drop a shared pin">
          📍 Pin
        </button>
      )}

      {/* Tap-to-place banner */}
      {placing && !pendingLL && (
        <div className="placing-banner">
          Tap the map to place a pin
          <button onClick={() => setPlacing(false)}>Cancel</button>
        </div>
      )}

      {/* Friends panel */}
      {showFriends && (
        <FriendsSheet
          user={user}
          peers={peers}
          myPos={myPos}
          friendState={friendState}
          friendActions={friendActions}
          visibility={visibility}
          onChangeVisibility={onChangeVisibility}
          rosterConsent={rosterConsent}
          onChangeRosterConsent={onChangeRosterConsent}
          onClose={() => setShowFriends(false)}
          onLocate={locateFriend}
        />
      )}

      {/* AR camera view (POIs use a fixed target; friends track live) */}
      {liveArTarget && (
        <ARView
          target={liveArTarget}
          myPos={myPos}
          onClose={() => setArTarget(null)}
        />
      )}

      {/* SOS confirm sheet */}
      {sosOpen && (
        <div className="sheet-overlay" onClick={() => setSosOpen(false)}>
          <div className="sheet sos-sheet" onClick={(e) => e.stopPropagation()}>
            {sosState !== 'acked' ? (
              <>
                <h3>🆘 Alert event security?</h3>
                <p className="sos-explain">
                  Security gets your live location right away. Anything you add
                  below (allergies, medication, what's happening) goes with it.
                </p>
                <textarea
                  value={sosNote}
                  onChange={(e) => setSosNote(e.target.value)}
                  placeholder="Optional — medical info or what's wrong"
                  maxLength={300}
                  rows={3}
                />
                <div className="sheet-buttons">
                  <button onClick={() => setSosOpen(false)}>Cancel</button>
                  <button
                    className="sos-send"
                    disabled={sosState === 'sending'}
                    onClick={() => {
                      localStorage.setItem('nb_medical_note', sosNote);
                      onSendSos(sosNote.trim());
                    }}
                  >
                    {sosState === 'sending' ? 'Sending…' : 'Send SOS'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3>✅ Security has been alerted</h3>
                <p className="sos-explain">
                  Your location {sosNote.trim() ? 'and your note ' : ''}went to
                  the security team. Stay where you are if you safely can.
                </p>
                <div className="sheet-buttons">
                  <button className="primary" onClick={() => setSosOpen(false)}>
                    OK
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Label prompt sheet */}
      {pendingLL && (
        <div className="sheet-overlay" onClick={cancelPin}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>Name this pin</h3>
            <input
              ref={inputRef}
              type="text"
              value={pinLabel}
              onChange={(e) => setPinLabel(e.target.value)}
              placeholder="e.g. Main Lodge"
              maxLength={30}
              onKeyDown={(e) => e.key === 'Enter' && confirmPin()}
            />
            <div className="sheet-buttons">
              <button onClick={cancelPin}>Cancel</button>
              <button className="primary" onClick={confirmPin}>Place Pin</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
