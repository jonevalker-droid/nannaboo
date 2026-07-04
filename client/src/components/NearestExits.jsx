import { useEffect, useRef, useState } from 'react';
import { formatDistance, cardinal } from '../lib/geo';

const COUNTDOWN_S = 10;

// Exit-first entry: the first thing a guest sees after joining is where the
// nearest exits are. Deliberately brief — auto-continues, and NEVER blocks
// entry: any failure (no exits, API down, no GPS) falls through to the map.
export default function NearestExits({ onContinue }) {
  const [exits, setExits] = useState(null); // null = loading
  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_S);
  const doneRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const load = (loc) => {
      if (doneRef.current) return;
      doneRef.current = true;
      const q = loc ? `&lat=${loc.lat}&lng=${loc.lng}` : '';
      fetch(`/api/pois?category=exit&limit=3${q}`)
        .then((r) => r.json())
        .then((d) => { if (!cancelled) setExits(d.pois ?? []); })
        .catch(() => { if (!cancelled) setExits([]); });
    };

    // Quick location fix improves the list (distance + sort) but must not
    // gate it: a permission prompt left unanswered would hang forever, so a
    // hard 5s timer proceeds without location.
    const fallback = setTimeout(() => load(null), 5000);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => { clearTimeout(fallback); load({ lat: coords.latitude, lng: coords.longitude }); },
      () => { clearTimeout(fallback); load(null); },
      { enableHighAccuracy: true, timeout: 4000, maximumAge: 60000 }
    );

    return () => { cancelled = true; clearTimeout(fallback); };
  }, []);

  // Start the countdown once exits render; skip the screen if there are none.
  // onContinue receives the fetched exits so the app can flash them in AR.
  useEffect(() => {
    if (exits === null) return;
    if (exits.length === 0) { onContinue([]); return; }
    const t = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) { clearInterval(t); onContinue(exits); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [exits, onContinue]);

  if (exits === null) {
    return (
      <div className="exits-screen">
        <div className="exits-loading">Finding your nearest exits…</div>
      </div>
    );
  }
  if (exits.length === 0) return null; // onContinue already fired

  return (
    <div className="exits-screen">
      <div className="exits-header">
        <span className="exits-icon">🚪</span>
        <h1>Know your exits</h1>
        <p>Before anything else — here's your fastest way out.</p>
      </div>

      <ul className="exits-list">
        {exits.map((exit) => (
          <li key={exit.id} className="exit-item">
            <div className="exit-arrow">
              {exit.bearingDeg != null
                ? <span style={{ transform: `rotate(${exit.bearingDeg}deg)` }}>↑</span>
                : <span>🚪</span>}
            </div>
            <div className="exit-info">
              <strong>{exit.name}</strong>
              {exit.distanceM != null && (
                <span>
                  {formatDistance(exit.distanceM)} · head {cardinal(exit.bearingDeg)}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>

      <button className="exits-continue" onClick={() => onContinue(exits)}>
        Got it — find my people →
      </button>
      <p className="exits-countdown">Continuing in {secondsLeft}s</p>
    </div>
  );
}
