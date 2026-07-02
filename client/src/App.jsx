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
  const [wsStatus, setWsStatus] = useState('disconnected');

  const wsRef = useRef(null);
  const userRef = useRef(null);
  const reconnectRef = useRef(null);

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
    };

    ws.onclose = () => {
      setWsStatus('reconnecting');
      reconnectRef.current = setTimeout(() => {
        if (userRef.current) connect(userRef.current);
      }, 3000);
    };

    ws.onerror = () => ws.close();
  }, []);

  const handleJoin = useCallback((name, groupCode) => {
    const userData = {
      id: getOrCreateGuestId(),
      name,
      groupCode: groupCode.toUpperCase().trim(),
    };
    userRef.current = userData;
    setUser(userData);
    // Exit-first safety screen comes before the friend map; the WebSocket
    // connects underneath it so the map is live the moment they continue.
    setPhase('exits');
    connect(userData);
  }, [connect]);

  const handleExitsSeen = useCallback(() => setPhase('map'), []);

  const sendPosition = useCallback((lat, lng, accuracy, heading) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !userRef.current) return;
    ws.send(JSON.stringify({
      type: 'position',
      guestId: userRef.current.id,
      lat, lng, accuracy, heading,
    }));
  }, []);

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

  useEffect(() => {
    return () => {
      clearTimeout(reconnectRef.current);
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
      wsStatus={wsStatus}
      onPositionUpdate={sendPosition}
      onAddPin={addPin}
      onRemovePin={removePin}
    />
  );
}
