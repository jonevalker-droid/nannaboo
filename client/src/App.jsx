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

export default function App() {
  const [phase, setPhase] = useState('join');
  const [user, setUser] = useState(null);
  const [peers, setPeers] = useState([]);
  const [pins, setPins] = useState([]);
  const [friendState, setFriendState] = useState({ friends: [], sent: [], received: [] });
  const [wsStatus, setWsStatus] = useState('disconnected');
  const [myPos, setMyPos] = useState(null);
  const [geoStatus, setGeoStatus] = useState('locating'); // locating | ok | denied | unavailable

  const wsRef = useRef(null);
  const userRef = useRef(null);
  const reconnectRef = useRef(null);
  const geoWatchRef = useRef(null);
  const geoRetryRef = useRef(null);

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
      }));
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'groupState') {
        setPeers(msg.guests.filter((g) => g.id !== userData.id));
        setPins(msg.pins);
      }
      if (msg.type === 'friendState') {
        setFriendState({ friends: msg.friends, sent: msg.sent, received: msg.received });
      }
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

  // Live GPS watch for the whole session, started at join so the permission
  // prompt and first fix happen while the exits screen is up. Nothing is ever
  // sent until a real fix arrives — there is no placeholder position, and a
  // failed watch is restarted rather than silently abandoned (some mobile
  // browsers wedge a watch after a timeout error).
  const startGeoWatch = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setGeoStatus('unavailable');
      return;
    }
    clearTimeout(geoRetryRef.current);
    if (geoWatchRef.current != null) {
      navigator.geolocation.clearWatch(geoWatchRef.current);
    }
    setGeoStatus((s) => (s === 'ok' ? s : 'locating'));
    geoWatchRef.current = navigator.geolocation.watchPosition(
      ({ coords }) => {
        const { latitude: lat, longitude: lng, accuracy, heading } = coords;
        setGeoStatus('ok');
        setMyPos({ lat, lng, accuracy });
        sendPosition(lat, lng, accuracy, heading);
      },
      (err) => {
        console.warn('geo:', err.code, err.message);
        if (err.code === 1) {
          // PERMISSION_DENIED: retrying is pointless until the user acts;
          // the map shows a banner with a retry button wired to this fn.
          setGeoStatus('denied');
          return;
        }
        // TIMEOUT / POSITION_UNAVAILABLE: keep the last fix if we had one,
        // tear the watch down and start fresh.
        setGeoStatus((s) => (s === 'ok' ? s : 'locating'));
        geoRetryRef.current = setTimeout(startGeoWatch, 3000);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
  }, [sendPosition]);

  const handleJoin = useCallback((name, groupCode) => {
    const userData = {
      id: getOrCreateGuestId(),
      name,
      groupCode: groupCode.toUpperCase().trim(),
    };
    userRef.current = userData;
    setUser(userData);
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
      onGeoRetry={startGeoWatch}
      onAddPin={addPin}
      onRemovePin={removePin}
    />
  );
}
