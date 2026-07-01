import { useEffect, useRef, useState, useCallback } from 'react';
import {
  MapContainer, TileLayer, Marker, Popup, Circle,
  useMap, useMapEvents,
} from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
  '#9b59b6', '#1abc9c', '#e67e22', '#c0392b',
];

function colorFor(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

function avatarIcon(color, initial, isMe = false) {
  const sz = isMe ? 46 : 38;
  const border = isMe ? '3px solid white' : '2px solid white';
  return L.divIcon({
    className: '',
    html: `<div style="
      width:${sz}px;height:${sz}px;background:${color};
      border:${border};border-radius:50%;
      display:flex;align-items:center;justify-content:center;
      color:white;font-weight:800;font-size:${isMe ? 18 : 15}px;
      font-family:-apple-system,sans-serif;
      box-shadow:0 2px 10px rgba(0,0,0,.45);
      user-select:none;
    ">${initial.toUpperCase()}</div>`,
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

function FlyToFirst({ position }) {
  const map = useMap();
  const done = useRef(false);
  useEffect(() => {
    if (position && !done.current) {
      map.flyTo([position.lat, position.lng], 16, { duration: 1.5 });
      done.current = true;
    }
  }, [position, map]);
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
  user, peers, pins, wsStatus,
  onPositionUpdate, onAddPin, onRemovePin,
}) {
  const [myPos, setMyPos] = useState(null);
  const [placing, setPlacing] = useState(false);
  const [pinLabel, setPinLabel] = useState('');
  const [pendingLL, setPendingLL] = useState(null);
  const watchId = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    watchId.current = navigator.geolocation.watchPosition(
      ({ coords }) => {
        const { latitude: lat, longitude: lng, accuracy, heading } = coords;
        setMyPos({ lat, lng, accuracy });
        onPositionUpdate(lat, lng, accuracy, heading);
      },
      (err) => console.warn('geo:', err),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
    return () => navigator.geolocation.clearWatch(watchId.current);
  }, [onPositionUpdate]);

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

  const fallbackCenter = [44.5, -88.0];

  return (
    <div className="map-screen">
      <div className="status-bar">
        <span className="group-label">{user.groupCode}</span>
        <span className={`ws-dot ws-${wsStatus}`} title={wsStatus} />
        <span className="peer-count">
          {peers.length + 1} {peers.length + 1 === 1 ? 'person' : 'people'}
        </span>
      </div>

      <MapContainer
        center={myPos ? [myPos.lat, myPos.lng] : fallbackCenter}
        zoom={15}
        style={{ flex: 1 }}
        zoomControl
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://osm.org/copyright">OpenStreetMap</a>'
          maxZoom={19}
        />

        <FlyToFirst position={myPos} />
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

        {peers.filter((p) => p.lat != null).map((peer) => (
          <Marker
            key={peer.id}
            position={[peer.lat, peer.lng]}
            icon={avatarIcon(colorFor(peer.id), peer.name[0])}
          >
            <Popup><strong>{peer.name}</strong></Popup>
          </Marker>
        ))}

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
