import { useEffect, useRef, useState } from 'react';
import { haversineMeters, bearingDeg, formatDistance, cardinal } from '../lib/geo';

// Lightweight AR: rear camera feed + an arrow rotated to (bearing to target −
// device compass heading). No computer vision — just GPS bearing math and the
// orientation sensor. Degrades to a compass card if camera or sensors are
// unavailable (both require HTTPS, which Render provides).
export default function ARView({ target, myPos, onClose }) {
  const videoRef = useRef(null);
  const [camError, setCamError] = useState(false);
  const [heading, setHeading] = useState(null);
  const [needsMotionPerm, setNeedsMotionPerm] = useState(false);

  // Rear camera
  useEffect(() => {
    let stream;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then((s) => {
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
      })
      .catch(() => setCamError(true));
    if (!navigator.mediaDevices) setCamError(true);
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);

  // Compass heading. iOS exposes webkitCompassHeading (already degrees
  // clockwise from north) and requires a permission grant; Android exposes
  // absolute alpha (counterclockwise), heard best on deviceorientationabsolute.
  useEffect(() => {
    const onOrientation = (e) => {
      let h = null;
      if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
      else if (e.alpha != null && (e.absolute || e.type === 'deviceorientationabsolute')) {
        h = (360 - e.alpha) % 360;
      }
      if (h != null) setHeading(h);
    };

    const eventName = 'ondeviceorientationabsolute' in window
      ? 'deviceorientationabsolute' : 'deviceorientation';

    const start = () => window.addEventListener(eventName, onOrientation, true);

    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      // iOS 13+: must be granted via user gesture; opening AR was a tap, but
      // if the promise rejects we show an explicit enable button.
      DeviceOrientationEvent.requestPermission()
        .then((res) => (res === 'granted' ? start() : setNeedsMotionPerm(true)))
        .catch(() => setNeedsMotionPerm(true));
    } else {
      start();
    }
    return () => window.removeEventListener(eventName, onOrientation, true);
  }, []);

  const enableCompass = () => {
    DeviceOrientationEvent.requestPermission()
      .then((res) => {
        if (res === 'granted') {
          setNeedsMotionPerm(false);
          window.addEventListener('deviceorientation', (e) => {
            if (typeof e.webkitCompassHeading === 'number') setHeading(e.webkitCompassHeading);
          }, true);
        }
      })
      .catch(() => {});
  };

  const dist = myPos ? haversineMeters(myPos, target) : null;
  const bearing = myPos ? bearingDeg(myPos, target) : null;
  const relative = bearing != null && heading != null
    ? (bearing - heading + 360) % 360
    : null;
  const onTarget = relative != null && (relative < 20 || relative > 340);

  return (
    <div className="ar-screen">
      {!camError && (
        <video ref={videoRef} className="ar-video" autoPlay playsInline muted />
      )}

      <div className="ar-top">
        <div className="ar-target">
          <strong>{target.name}</strong>
          <span>
            {dist != null ? formatDistance(dist) : 'waiting for GPS…'}
            {bearing != null && ` · ${cardinal(bearing)}`}
          </span>
        </div>
        <button className="ar-close" onClick={onClose} aria-label="Close AR view">✕</button>
      </div>

      <div className="ar-center">
        {relative != null ? (
          <>
            <div
              className={`ar-arrow ${onTarget ? 'on-target' : ''}`}
              style={{ transform: `rotate(${relative}deg)` }}
            >
              <svg viewBox="0 0 100 100" width="110" height="110">
                <path
                  d="M50 6 L78 62 L50 48 L22 62 Z"
                  fill="currentColor"
                  stroke="rgba(0,0,0,.35)"
                  strokeWidth="3"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <p className="ar-hint">
              {onTarget ? 'Straight ahead!' : 'Turn until the arrow points up'}
            </p>
          </>
        ) : (
          <div className="ar-fallback">
            {needsMotionPerm ? (
              <button className="ar-enable" onClick={enableCompass}>
                Enable compass
              </button>
            ) : bearing != null ? (
              <p>Compass unavailable — head <strong>{cardinal(bearing)}</strong></p>
            ) : (
              <p>Waiting for GPS fix…</p>
            )}
          </div>
        )}
      </div>

      {camError && <div className="ar-nocam">Camera unavailable — compass mode</div>}
    </div>
  );
}
