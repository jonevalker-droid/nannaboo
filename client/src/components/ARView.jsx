import { useEffect, useRef, useState } from 'react';
import { haversineMeters, bearingDeg, formatDistance, cardinal } from '../lib/geo';

// Lightweight AR: rear camera feed + arrows rotated to (bearing to target −
// device compass heading). No computer vision — just GPS bearing math and the
// orientation sensor. Degrades to a compass card if camera or sensors are
// unavailable (both require HTTPS, which Render provides).
//
// Two modes:
//   single (default) — the original one-big-arrow view for a POI or one friend
//   multi            — several live targets at once (all friends / entry exits):
//                      each gets its own small arrow + label, placed across the
//                      screen by relative bearing, stacked when bearings crowd
//
// `auto` marks the one-time entry flash: tap anywhere skips, and the iOS
// motion-permission request is NOT attempted (it needs a user gesture, which
// an automatic open doesn't have) — the cardinal-direction fallback shows
// instead.

// Map a signed relative bearing (deg, 0 = straight ahead) to a horizontal
// screen position. ±60° spans the visible band; anything wider clamps to an
// edge so targets behind you still show which way to turn.
function relToX(rel) {
  return Math.max(6, Math.min(94, 50 + (rel / 60) * 45));
}

// Vendor footprint tiers: a SCREEN-SPACE prominence rank only — bigger arrow,
// badge, and first claim on the top stack row. Deliberately not presented as
// spatial height/depth: this AR is compass bearing + GPS distance, so there
// is no real 3D placement to promote a vendor within. Targets without a tier
// (friends, exits, every safety POI — the data layer guarantees those can
// never carry one) all render at the same full standard prominence.
const TIER_RANK = { premium: 2, featured: 1, standard: 0 };
const TIER_META = {
  featured: { arrow: 66, badge: '★ Featured' },
  premium:  { arrow: 80, badge: '◆ Premium' },
};

// Assign stack rows so labels at similar bearings don't overlap: sorted by x,
// any marker within 18% of the previous one joins its cluster and drops a row
// below. Within a cluster, higher footprint tiers claim the upper rows
// (their stacking priority); equal tiers stack nearest-first.
function placeMarkers(markers) {
  const sorted = [...markers].sort((a, b) => a.x - b.x);
  const clusters = [];
  let prevX = -100;
  for (const m of sorted) {
    if (m.x - prevX < 18 && clusters.length) clusters[clusters.length - 1].push(m);
    else clusters.push([m]);
    prevX = m.x;
  }
  return clusters.flatMap((cluster) =>
    [...cluster]
      .sort((a, b) =>
        (TIER_RANK[b.tier] ?? 0) - (TIER_RANK[a.tier] ?? 0) || a.dist - b.dist)
      .map((m, row) => ({ ...m, row }))
  );
}

function ArrowSvg({ size = 110 }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size}>
      <path
        d="M50 6 L78 62 L50 48 L22 62 Z"
        fill="currentColor"
        stroke="rgba(0,0,0,.35)"
        strokeWidth="3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function ARView({
  target, myPos, onClose,
  mode = 'single',
  targets = [],
  modeLabel = null,        // header pill naming the multi mode ("👥 All friends")
  emptyLabel = 'Nobody here is sharing a live position right now', // multi mode, zero live targets
  auto = false,            // entry flash: tap-anywhere skip, no motion-perm prompt
  autoSecondsLeft = null,  // countdown shown in the skip hint
  onToggleAllFriends = null, // single-friend view → switch to all-friends mode
}) {
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
      // iOS 13+: must be granted via user gesture. Opening AR manually was a
      // tap; the automatic entry flash was not, so don't even ask there —
      // rejecting would surface an enable button nobody can meaningfully use
      // in a 4-second window. Cardinal-direction fallback covers it.
      if (auto) return () => window.removeEventListener(eventName, onOrientation, true);
      DeviceOrientationEvent.requestPermission()
        .then((res) => (res === 'granted' ? start() : setNeedsMotionPerm(true)))
        .catch(() => setNeedsMotionPerm(true));
    } else {
      start();
    }
    return () => window.removeEventListener(eventName, onOrientation, true);
  }, [auto]);

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

  // ── Multi-target geometry (recomputed every render: positions are live) ──
  const liveTargets = mode === 'multi'
    ? targets.filter((t) => t.lat != null && t.lng != null)
    : [];
  const multiMarkers = mode === 'multi' && myPos
    ? liveTargets.map((t) => {
        const bearing = bearingDeg(myPos, t);
        const dist = haversineMeters(myPos, t);
        let rel = null;
        if (heading != null) {
          rel = (bearing - heading + 360) % 360;
          if (rel > 180) rel -= 360;
        }
        return {
          id: t.id ?? t.name, name: t.name, bearing, dist, rel,
          x: rel != null ? relToX(rel) : null,
          emoji: t.emoji ?? null,
          // Prominence tier passes through ONLY for vendors — the server
          // never emits footprintTier on any other category.
          tier: t.category === 'vendor' ? t.footprintTier ?? null : null,
        };
      })
    : [];
  const placed = heading != null ? placeMarkers(multiMarkers) : [];

  // ── Single-target math (unchanged from the original view) ──
  const dist = target && myPos ? haversineMeters(myPos, target) : null;
  const bearing = target && myPos ? bearingDeg(myPos, target) : null;
  const relative = bearing != null && heading != null
    ? (bearing - heading + 360) % 360
    : null;
  const onTarget = relative != null && (relative < 20 || relative > 340);

  return (
    <div
      className={`ar-screen ${mode === 'multi' ? 'ar-multi' : ''}`}
      onClick={auto ? onClose : undefined}
    >
      {!camError && (
        <video ref={videoRef} className="ar-video" autoPlay playsInline muted />
      )}

      <div className="ar-top">
        <div className="ar-target">
          {mode === 'multi' ? (
            <>
              <span className="ar-mode-pill">{modeLabel ?? '👥 All friends'}</span>
              <span>
                {!myPos ? 'waiting for GPS…'
                  : liveTargets.length === 0 ? 'no targets right now'
                  : `${liveTargets.length} ${liveTargets.length === 1 ? 'target' : 'targets'} · live`}
              </span>
            </>
          ) : (
            <>
              <strong>{target.name}</strong>
              <span>
                {dist != null ? formatDistance(dist) : 'waiting for GPS…'}
                {bearing != null && ` · ${cardinal(bearing)}`}
              </span>
            </>
          )}
        </div>
        <button className="ar-close" onClick={onClose} aria-label="Close AR view">✕</button>
      </div>

      {mode === 'multi' ? (
        <>
          {heading != null && myPos != null ? (
            placed.map((m) => {
              const tierMeta = TIER_META[m.tier];
              return (
                <div
                  key={m.id}
                  className={`ar-marker ${m.tier ? `ar-tier-${m.tier}` : ''}`}
                  style={{
                    left: `${m.x}%`,
                    top: `calc(26% + ${m.row * 96}px)`,
                    zIndex: 1 + (TIER_RANK[m.tier] ?? 0),
                  }}
                >
                  <div
                    className={`ar-arrow ar-marker-arrow ${Math.abs(m.rel) < 20 ? 'on-target' : ''}`}
                    style={{ transform: `rotate(${m.rel}deg)` }}
                  >
                    <ArrowSvg size={tierMeta?.arrow ?? 54} />
                  </div>
                  <div className="ar-marker-label">
                    {tierMeta && <em className="ar-tier-badge">{tierMeta.badge}</em>}
                    <strong>{m.emoji ? `${m.emoji} ` : ''}{m.name}</strong>
                    <span>{formatDistance(m.dist)}</span>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="ar-center">
              <div className="ar-fallback ar-multi-fallback">
                {needsMotionPerm && !auto && (
                  <button className="ar-enable" onClick={enableCompass}>
                    Enable compass
                  </button>
                )}
                {!myPos ? (
                  <p>Waiting for GPS fix…</p>
                ) : liveTargets.length === 0 ? (
                  <p>{emptyLabel}</p>
                ) : (
                  <ul className="ar-multi-list">
                    {[...multiMarkers]
                      .sort((a, b) =>
                        (TIER_RANK[b.tier] ?? 0) - (TIER_RANK[a.tier] ?? 0) || a.dist - b.dist)
                      .map((m) => (
                        <li key={m.id} className={m.tier ? `ar-tier-${m.tier}` : ''}>
                          {TIER_META[m.tier] && (
                            <em className="ar-tier-badge">{TIER_META[m.tier].badge}</em>
                          )}
                          <strong>{m.emoji ? `${m.emoji} ` : ''}{m.name}</strong>
                          {' '}— {formatDistance(m.dist)} · head <strong>{cardinal(m.bearing)}</strong>
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            </div>
          )}
          {heading != null && myPos != null && liveTargets.length === 0 && (
            <div className="ar-center">
              <div className="ar-fallback">
                <p>{emptyLabel}</p>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="ar-center">
          {relative != null ? (
            <>
              <div
                className={`ar-arrow ${onTarget ? 'on-target' : ''}`}
                style={{ transform: `rotate(${relative}deg)` }}
              >
                <ArrowSvg />
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
      )}

      {onToggleAllFriends && mode === 'single' && (
        <button
          className="ar-toggle-all"
          onClick={(e) => { e.stopPropagation(); onToggleAllFriends(); }}
        >
          👥 Show all friends
        </button>
      )}

      {auto && (
        <div className="ar-skip">
          Tap anywhere to skip{autoSecondsLeft != null ? ` · continuing in ${autoSecondsLeft}s` : ''}
        </div>
      )}

      {camError && <div className="ar-nocam">Camera unavailable — compass mode</div>}
    </div>
  );
}
