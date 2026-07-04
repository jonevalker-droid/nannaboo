import { useState, useEffect, useRef, useCallback } from 'react';
import JoinForm from './components/JoinForm';
import NearestExits from './components/NearestExits';
import MapView from './components/MapView';
import './App.css';

function getOrCreateGuestId() {
  let id = localStorage.getItem('nb_guest_id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('nb_guest_id', id);
  }
  return id;
}

const WS_URL =
  `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;

// Geolocation debug trail: every attempt, outcome, and error code is logged
// so a field failure can be diagnosed from a remote devtools session.
const geoLog = (...args) => console.log('[geo]', ...args);
const GEO_ERR = { 1: 'PERMISSION_DENIED', 2: 'POSITION_UNAVAILABLE', 3: 'TIMEOUT' };

export default function App() {
  const [phase, setPhase] = useState('join');
  const [user, setUser] = useState(null);
  const [peers, setPeers] = useState([]);
  const [pins, setPins] = useState([]);
  const [friendState, setFriendState] = useState({ friends: [], sent: [], received: [] });
  const [wsStatus, setWsStatus] = useState('disconnected');
  const [visibility, setVisibility] = useState('public');
  const [insideVenue, setInsideVenue] = useState(null); // null until server has a fix + fence
  const [rosterConsent, setRosterConsentState] = useState(
    () => localStorage.getItem('nb_roster_consent') === '1'
  );
  const [sosState, setSosState] = useState('idle'); // idle | sending | acked
  const [myPos, setMyPos] = useState(null);
  const [geoStatus, setGeoStatus] = useState('locating'); // locating | ok | denied | unavailable
  const [geoDetail, setGeoDetail] = useState(null); // last error message, shown in the banner

  const wsRef = useRef(null);
  const userRef = useRef(null);
  const reconnectRef = useRef(null);
  const geoWatchRef = useRef(null);
  const geoRetryRef = useRef(null);
  const geoStatusRef = useRef('locating'); // mirror for non-render callbacks

  const connect = useCallback((userData) => {
    clearTimeout(reconnectRef.current);
    if (wsRef.current) wsRef.current.close();

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus('connected');
      ws.send(JSON.stringify({
        type: 'join',
        guestId: userData.id,
        name: userData.name,
        groupCode: userData.groupCode,
        visibility: userData.visibility,
      }));
      // Roster consent is re-asserted on every (re)connect so the server's
      // record survives restarts in memory mode too.
      if (localStorage.getItem('nb_roster_consent') === '1') {
        ws.send(JSON.stringify({ type: 'setRosterConsent', grant: true }));
      }
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'groupState') {
        setPeers(msg.guests.filter((g) => g.id !== userData.id));
        setPins(msg.pins);
        // Own entry carries the geofence verdict for MY position.
        const me = msg.guests.find((g) => g.id === userData.id);
        setInsideVenue(me?.inside ?? null);
      }
      if (msg.type === 'friendState') {
        setFriendState({ friends: msg.friends, sent: msg.sent, received: msg.received });
      }
      if (msg.type === 'sosAck') setSosState('acked');
    };

    ws.onclose = () => {
      setWsStatus('reconnecting');
      reconnectRef.current = setTimeout(() => {
        if (userRef.current) connect(userRef.current);
      }, 3000);
    };

    ws.onerror = () => ws.close();
  }, []);

  const sendPosition = useCallback((lat, lng, accuracy, heading) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !userRef.current) return;
    ws.send(JSON.stringify({
      type: 'position',
      guestId: userRef.current.id,
      lat, lng, accuracy, heading,
    }));
  }, []);

  const setGeo = useCallback((status, detail = null) => {
    geoStatusRef.current = status;
    setGeoStatus(status);
    setGeoDetail(detail);
  }, []);

  const applyFix = useCallback(({ coords }) => {
    const { latitude: lat, longitude: lng, accuracy, heading } = coords;
    geoLog(`fix ok lat=${lat.toFixed(5)} lng=${lng.toFixed(5)} ±${Math.round(accuracy)}m`);
    setGeo('ok');
    setMyPos({ lat, lng, accuracy });
    sendPosition(lat, lng, accuracy, heading);
  }, [sendPosition, setGeo]);

  // Log the Permissions API snapshot for diagnosis ONLY. Mobile Safari can
  // report stale/cached state after the user changes settings, so nothing is
  // ever gated on it — the outcome of a real watchPosition/getCurrentPosition
  // attempt is the only source of truth for the banner.
  const logPermissionSnapshot = useCallback((label) => {
    try {
      navigator.permissions?.query({ name: 'geolocation' })
        .then((st) => geoLog(`${label}: permissions.query reports '${st.state}' (informational only)`))
        .catch(() => {});
    } catch { /* Permissions API unavailable */ }
  }, []);

  // Live GPS watch for the whole session, started at join so the permission
  // prompt and first fix happen while the exits screen is up. Nothing is ever
  // sent until a real fix arrives — there is no placeholder position, and a
  // failed watch is restarted rather than silently abandoned (some mobile
  // browsers wedge a watch after a timeout error).
  const startGeoWatch = useCallback((trigger = 'join') => {
    if (!('geolocation' in navigator)) {
      geoLog('navigator.geolocation missing — cannot locate this device');
      setGeo('unavailable');
      return;
    }
    clearTimeout(geoRetryRef.current);
    if (geoWatchRef.current != null) {
      navigator.geolocation.clearWatch(geoWatchRef.current);
    }
    if (geoStatusRef.current !== 'ok') setGeo('locating');
    geoLog(`starting watchPosition (${trigger})`);
    logPermissionSnapshot(`watch/${trigger}`);
    geoWatchRef.current = navigator.geolocation.watchPosition(
      applyFix,
      (err) => {
        geoLog(`watch error code=${err.code} ${GEO_ERR[err.code] ?? '?'}: ${err.message}`);
        if (err.code === 1) {
          // PERMISSION_DENIED: nothing recovers without user action; the
          // banner's "try again" runs retryGeo, and a permissions-change
          // event (where supported) nudges it automatically.
          setGeo('denied', err.message);
          return;
        }
        // TIMEOUT / POSITION_UNAVAILABLE: keep the last fix if we had one,
        // tear the watch down and start fresh.
        if (geoStatusRef.current !== 'ok') setGeo('locating');
        geoRetryRef.current = setTimeout(() => startGeoWatch('error-restart'), 3000);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
  }, [applyFix, logPermissionSnapshot, setGeo]);

  // Recovery path: "try again" must genuinely re-attempt geolocation, not
  // reset a UI flag. After an earlier denial, mobile Safari can leave a
  // restarted watchPosition wedged (or instantly re-fail it from cache), so
  // the retry probes with a fresh one-shot getCurrentPosition — its real
  // outcome decides the banner — and on success hands off to a clean watch.
  const retryGeo = useCallback((trigger) => {
    const why = typeof trigger === 'string' ? trigger : 'retry-button';
    if (!('geolocation' in navigator)) return;
    geoLog(`retry (${why}) — probing with one-shot getCurrentPosition`);
    logPermissionSnapshot(`retry/${why}`);
    if (geoStatusRef.current !== 'ok') setGeo('locating');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        geoLog(`retry (${why}) probe succeeded — restarting live watch`);
        applyFix(pos);
        startGeoWatch(`${why}-recovered`);
      },
      (err) => {
        geoLog(`retry (${why}) probe error code=${err.code} ${GEO_ERR[err.code] ?? '?'}: ${err.message}`);
        if (err.code === 1) {
          setGeo('denied', err.message);
          return;
        }
        // Transient failure while permission itself is fine: let the normal
        // watch restart/backoff loop take it from here.
        startGeoWatch(`${why}-fallback`);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
  }, [applyFix, startGeoWatch, logPermissionSnapshot, setGeo]);

  // Where the browser fires permission-change events, use a flip to
  // 'granted' as a nudge to re-attempt for users who fix their settings but
  // never tap the button. Trigger only — the attempt's outcome, not the
  // reported state, decides what the banner shows.
  useEffect(() => {
    let st = null;
    let cancelled = false;
    try {
      navigator.permissions?.query({ name: 'geolocation' }).then((status) => {
        if (cancelled) return;
        st = status;
        st.onchange = () => {
          geoLog(`permissions.query state changed to '${st.state}'`);
          if (st.state === 'granted' && geoStatusRef.current === 'denied') {
            retryGeo('permission-change');
          }
        };
      }).catch(() => {});
    } catch { /* no Permissions API — the banner button covers recovery */ }
    return () => {
      cancelled = true;
      if (st) st.onchange = null;
    };
  }, [retryGeo]);

  const handleJoin = useCallback((name, groupCode, chosenVisibility) => {
    const userData = {
      id: getOrCreateGuestId(),
      name,
      groupCode: groupCode.toUpperCase().trim(),
      visibility: chosenVisibility,
    };
    userRef.current = userData;
    setUser(userData);
    setVisibility(chosenVisibility);
    // Exit-first safety screen comes before the friend map; the WebSocket
    // and GPS watch start underneath it so the map is live — and our position
    // already broadcasting — the moment they continue.
    setPhase('exits');
    connect(userData);
    startGeoWatch();
  }, [connect, startGeoWatch]);

  const handleExitsSeen = useCallback(() => setPhase('map'), []);

  const addPin = useCallback((label, lat, lng) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !userRef.current) return;
    ws.send(JSON.stringify({
      type: 'addPin',
      guestId: userRef.current.id,
      groupCode: userRef.current.groupCode,
      label, lat, lng,
    }));
  }, []);

  const removePin = useCallback((pinId) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'removePin', pinId }));
  }, []);

  const sendFriendMsg = useCallback((payload) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }, []);

  const friendActions = {
    request: (toGuestId) => sendFriendMsg({ type: 'friendRequest', toGuestId }),
    respond: (requestId, accept) => sendFriendMsg({ type: 'friendRespond', requestId, accept }),
    setLevel: (friendGuestId, level) => sendFriendMsg({ type: 'friendLevel', friendGuestId, level }),
  };

  // Identified-security-roster opt-in: the only scope that shows this
  // guest's name to staff. Explicit toggle, persisted, re-sent on connect.
  const changeRosterConsent = useCallback((grant) => {
    setRosterConsentState(grant);
    localStorage.setItem('nb_roster_consent', grant ? '1' : '0');
    sendFriendMsg({ type: 'setRosterConsent', grant });
  }, [sendFriendMsg]);

  // Guest SOS: alerts event security with position + whatever note (e.g.
  // medical info) the guest chooses to include.
  const sendSos = useCallback((note) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setSosState('sending');
    ws.send(JSON.stringify({
      type: 'sos',
      guestId: userRef.current?.id,
      lat: myPos?.lat, lng: myPos?.lng,
      note: note || null,
    }));
  }, [myPos]);

  // Guest-level visibility tier, editable anytime (server enforces it; the
  // localStorage copy + userRef keep it across reloads and WS reconnects).
  const changeVisibility = useCallback((mode) => {
    setVisibility(mode);
    localStorage.setItem('nb_visibility', mode);
    if (userRef.current) userRef.current = { ...userRef.current, visibility: mode };
    sendFriendMsg({ type: 'setVisibility', visibility: mode });
  }, [sendFriendMsg]);

  useEffect(() => {
    return () => {
      clearTimeout(reconnectRef.current);
      clearTimeout(geoRetryRef.current);
      if (geoWatchRef.current != null) {
        navigator.geolocation.clearWatch(geoWatchRef.current);
      }
      wsRef.current?.close();
    };
  }, []);

  if (phase === 'join') {
    return <JoinForm onJoin={handleJoin} />;
  }

  if (phase === 'exits') {
    return <NearestExits onContinue={handleExitsSeen} />;
  }

  return (
    <MapView
      user={user}
      peers={peers}
      pins={pins}
      friendState={friendState}
      friendActions={friendActions}
      wsStatus={wsStatus}
      myPos={myPos}
      geoStatus={geoStatus}
      geoDetail={geoDetail}
      onGeoRetry={retryGeo}
      visibility={visibility}
      onChangeVisibility={changeVisibility}
      insideVenue={insideVenue}
      rosterConsent={rosterConsent}
      onChangeRosterConsent={changeRosterConsent}
      sosState={sosState}
      onSendSos={sendSos}
      onResetSos={() => setSosState('idle')}
      onAddPin={addPin}
      onRemovePin={removePin}
    />
  );
}
