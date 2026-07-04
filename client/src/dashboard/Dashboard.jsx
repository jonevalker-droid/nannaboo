// Staff ops dashboard (Prompt 6): live crowd density, zone capacity alerts,
// POI management, incident summary, post-event analytics export.
//
// Privacy model: every panel here renders AGGREGATED, anonymized data — the
// API it talks to (/api/dashboard, dashboardStore.js) never returns guest ids
// or raw position fixes. The one identified view (incident subjects) is
// rendered only for Security-role sessions, and the server enforces that
// independently (role re-check + audit_log write inside db/access.js), so
// hiding it here is cosmetic, not the control.
//
// Viz follows the dataviz reference palette (pre-validated): sequential blue
// ramp for density, reserved status colors with icon+label for capacity
// state, single-hue bars with direct value labels for counts.
import { useCallback, useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, CircleMarker, Polygon, Tooltip, useMapEvents } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import './dashboard.css';

// Sequential ramp steps (reference palette, light surface), near-zero -> max.
const RAMP = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
const rampFor = (count, max) => RAMP[Math.min(RAMP.length - 1, Math.floor((count / Math.max(max, 1)) * (RAMP.length - 1)))];

// Reserved status palette — icon + label always accompany the color.
const ZONE_STATUS = {
  ok:   { color: '#0ca30c', icon: '●', label: 'OK' },
  near: { color: '#fab219', icon: '◐', label: 'Near capacity' },
  over: { color: '#d03b3b', icon: '⛔', label: 'Over capacity' },
};

const BAR_HUE = '#2a78d6'; // single-series bars: categorical slot 1

function useStaff() {
  const [staff, setStaff] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('nb_staff')) ?? null; } catch { return null; }
  });
  const save = (s) => {
    if (s) sessionStorage.setItem('nb_staff', JSON.stringify(s));
    else sessionStorage.removeItem('nb_staff');
    setStaff(s);
  };
  return [staff, save];
}

async function api(staff, path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      'x-staff-session': staff?.id ?? '',
      ...(opts.headers ?? {}),
    },
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(body?.error ?? `HTTP ${res.status}`), { status: res.status });
  return body;
}

// ---------------------------------------------------------------- login

function Login({ onSignIn }) {
  const [sessionId, setSessionId] = useState('');
  const [adminKey, setAdminKey] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('admin');
  const [error, setError] = useState('');

  const paste = async () => {
    try {
      // Any authenticated aggregate endpoint doubles as a session probe.
      const res = await fetch('/api/dashboard/zones?code=PROBE', {
        headers: { 'x-staff-session': sessionId.trim() },
      });
      if (res.status === 401) throw new Error('session not recognized or expired');
      onSignIn({ id: sessionId.trim(), role: 'unknown', name: 'Staff' });
    } catch (e) { setError(e.message); }
  };

  const bootstrap = async () => {
    try {
      const res = await fetch(`/api/security/session?key=${encodeURIComponent(adminKey)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name || 'Dashboard user', role }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? 'could not create session');
      onSignIn({ id: body.session.id, role: body.session.role, name: name || 'Dashboard user' });
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="dash-login">
      <div className="dash-login-card">
        <h1>NannaBoo Ops</h1>
        <p className="dash-muted">Staff dashboard — aggregated, anonymized views.</p>

        <h3>Create a session</h3>
        <input placeholder="Admin key" type="password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} />
        <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
          <option value="admin">Admin</option>
          <option value="promoter">Promoter</option>
          <option value="security">Security</option>
        </select>
        <button className="dash-primary" onClick={bootstrap}>Create session →</button>

        <h3>Or paste an existing session id</h3>
        <input placeholder="staff session id" value={sessionId} onChange={(e) => setSessionId(e.target.value)} />
        <button onClick={paste} disabled={!sessionId.trim()}>Sign in</button>

        {error && <p className="dash-error">{error}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- heatmap

function MapCenterTracker({ onCenter }) {
  const map = useMapEvents({ moveend: () => onCenter(map.getCenter()) });
  // Seed with the initial center too — zone/POI creation must work before
  // the operator ever pans the map.
  useEffect(() => { onCenter(map.getCenter()); }, [map, onCenter]);
  return null;
}

function HeatmapPanel({ staff, code, onCenter }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    const tick = () =>
      api(staff, `/dashboard/heatmap?code=${code}`)
        .then((d) => { if (live) { setData(d); setErr(''); } })
        .catch((e) => live && setErr(e.message));
    tick();
    const t = setInterval(tick, 5000);
    return () => { live = false; clearInterval(t); };
  }, [staff, code]);

  const cells = data?.cells ?? [];
  const max = Math.max(...cells.map((c) => c.count), 1);
  const first = cells[0];
  const boundaryLL = data?.boundary?.coordinates?.[0]?.map(([lng, lat]) => [lat, lng]);

  return (
    <section className="dash-panel dash-map-panel">
      <header>
        <h2>Live crowd density</h2>
        <span className="dash-muted">
          {data ? `${data.total} on site · ${cells.length} cells · ~25 m grid` : 'loading…'}
        </span>
      </header>
      {err && <p className="dash-error">{err}</p>}
      <MapContainer
        center={first ? [first.lat, first.lng] : [33.6595, -117.9988]}
        zoom={16}
        className="dash-map"
      >
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://osm.org/copyright">OSM</a>' />
        <MapCenterTracker onCenter={onCenter} />
        {boundaryLL && (
          <Polygon positions={boundaryLL}
            pathOptions={{ color: '#52514e', weight: 1.5, dashArray: '6 4', fill: false }} />
        )}
        {cells.map((c) => (
          <CircleMarker
            key={`${c.lat}|${c.lng}`}
            center={[c.lat, c.lng]}
            radius={10 + 14 * (c.count / max)}
            pathOptions={{
              color: '#fcfcfb', weight: 2,
              fillColor: rampFor(c.count, max), fillOpacity: 0.75,
            }}
          >
            <Tooltip>{c.count} {c.count === 1 ? 'guest' : 'guests'} in this cell</Tooltip>
          </CircleMarker>
        ))}
      </MapContainer>
      <div className="dash-ramp-legend" aria-hidden="true">
        <span className="dash-muted">fewer</span>
        {RAMP.map((h) => <i key={h} style={{ background: h }} />)}
        <span className="dash-muted">more</span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- zones

function ZonesPanel({ staff, code, mapCenter }) {
  const [zones, setZones] = useState([]);
  const [form, setForm] = useState({ name: '', capacity: 25, radiusM: 60 });
  const [err, setErr] = useState('');
  const canEdit = ['admin', 'promoter', 'unknown'].includes(staff.role);

  const refresh = useCallback(() =>
    api(staff, `/dashboard/zones?code=${code}`)
      .then((d) => { setZones(d.zones); setErr(''); })
      .catch((e) => setErr(e.message)), [staff, code]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const create = async () => {
    if (!mapCenter) { setErr('move the density map to the zone center first'); return; }
    try {
      await api(staff, '/dashboard/zones', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name, capacity: Number(form.capacity),
          lat: mapCenter.lat, lng: mapCenter.lng, radiusM: Number(form.radiusM),
        }),
      });
      setForm({ ...form, name: '' });
      refresh();
    } catch (e) { setErr(e.message); }
  };

  return (
    <section className="dash-panel">
      <header><h2>Zone capacity</h2></header>
      {err && <p className="dash-error">{err}</p>}
      {zones.length === 0 && <p className="dash-muted">No zones yet — create one below (center = density-map center).</p>}
      {zones.map((z) => {
        const st = ZONE_STATUS[z.alert] ?? ZONE_STATUS.ok;
        const pct = z.capacity ? Math.min(1, z.occupancy / z.capacity) : 0;
        return (
          <div key={z.id} className="dash-zone-row">
            <div className="dash-zone-head">
              <strong>{z.name}</strong>
              <span className="dash-status" style={{ color: st.color }}>
                {st.icon} {st.label}
              </span>
            </div>
            <div className="dash-meter" role="img"
              aria-label={`${z.occupancy} of ${z.capacity ?? '∞'} in ${z.name}`}>
              <i style={{ width: `${pct * 100}%`, background: BAR_HUE }} />
            </div>
            <div className="dash-zone-foot">
              <span>{z.occupancy}{z.capacity ? ` / ${z.capacity}` : ''}</span>
              {canEdit && (
                <button className="dash-link-btn" onClick={() =>
                  api(staff, `/dashboard/zones/${z.id}`, { method: 'DELETE' }).then(refresh).catch((e) => setErr(e.message))
                }>remove</button>
              )}
            </div>
          </div>
        );
      })}
      {canEdit && (
        <div className="dash-form-row">
          <input placeholder="Zone name" value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input type="number" title="Capacity" value={form.capacity}
            onChange={(e) => setForm({ ...form, capacity: e.target.value })} />
          <input type="number" title="Radius (m)" value={form.radiusM}
            onChange={(e) => setForm({ ...form, radiusM: e.target.value })} />
          <button className="dash-primary" onClick={create} disabled={!form.name.trim()}>Add zone</button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- POIs

const FOOTPRINT_TIERS = ['standard', 'featured', 'premium'];

function PoiPanel({ staff, mapCenter }) {
  const [pois, setPois] = useState([]);
  const [form, setForm] = useState({ category: 'exit', name: '', footprintTier: 'standard' });
  const [err, setErr] = useState('');

  const refresh = useCallback(() =>
    fetch('/api/pois').then((r) => r.json()).then((d) => setPois(d.pois ?? [])), []);
  useEffect(() => { refresh(); }, [refresh]);

  const write = (path, opts) =>
    api(staff, path, opts).then(refresh).catch((e) => setErr(e.message));

  const categories = ['exit', 'restroom', 'medic', 'food', 'drink', 'water', 'info',
    'charging', 'atm', 'lost_and_found', 'parking', 'rideshare', 'quiet_room',
    'vendor', 'other'];

  const create = () => {
    // footprintTier goes up only for vendors — the API rejects it anywhere
    // else (safety categories are structurally untierable at the data layer).
    const body = { category: form.category, name: form.name, lat: mapCenter.lat, lng: mapCenter.lng };
    if (form.category === 'vendor') body.footprintTier = form.footprintTier;
    write('/pois', { method: 'POST', body: JSON.stringify(body) })
      .then(() => setForm({ ...form, name: '' }));
  };

  return (
    <section className="dash-panel">
      <header>
        <h2>POI management</h2>
        <span className="dash-muted">vendor footprint = AR prominence (screen styling, not spatial)</span>
      </header>
      {err && <p className="dash-error">{err}</p>}
      <div className="dash-form-row">
        <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
          {categories.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
        </select>
        {form.category === 'vendor' && (
          <select value={form.footprintTier} aria-label="Footprint tier"
            onChange={(e) => setForm({ ...form, footprintTier: e.target.value })}>
            {FOOTPRINT_TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        <input placeholder={form.category === 'vendor' ? 'Vendor name' : 'POI name'} value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <button className="dash-primary" disabled={!form.name.trim() || !mapCenter}
          title={mapCenter ? 'places at density-map center' : 'move the density map first'}
          onClick={create}>
          Add at map center
        </button>
      </div>
      <table className="dash-table">
        <thead><tr><th>POI</th><th>Category</th><th>Footprint</th><th>Live status</th><th /></tr></thead>
        <tbody>
          {pois.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.category.replace(/_/g, ' ')}</td>
              <td>
                {p.category === 'vendor' ? (
                  <select value={p.footprintTier ?? 'standard'} aria-label={`Footprint tier for ${p.name}`}
                    onChange={(e) =>
                      write(`/pois/${p.id}`, {
                        method: 'PUT',
                        body: JSON.stringify({ footprintTier: e.target.value }),
                      })}>
                    {FOOTPRINT_TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                ) : (
                  <span className="dash-muted" title="Only vendors carry a footprint tier — safety POIs always render at full standard prominence">—</span>
                )}
              </td>
              <td>
                <input className="dash-inline-input" defaultValue={p.liveStatus ?? ''}
                  placeholder="e.g. long line"
                  onBlur={(e) => {
                    const v = e.target.value.trim() || null;
                    if (v !== (p.liveStatus ?? null)) {
                      write(`/pois/${p.id}`, { method: 'PUT', body: JSON.stringify({ liveStatus: v }) });
                    }
                  }} />
              </td>
              <td>
                <button className="dash-link-btn"
                  onClick={() => write(`/pois/${p.id}`, { method: 'DELETE' })}>remove</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ---------------------------------------------------------------- incidents

function IncidentsPanel({ staff, code, mapCenter }) {
  const [summary, setSummary] = useState(null);
  const [identified, setIdentified] = useState(null); // null | {incidents,...} | {denied}
  const [form, setForm] = useState({ category: 'medical', description: '' });
  const [err, setErr] = useState('');

  const refresh = useCallback(() =>
    api(staff, `/dashboard/incidents?code=${code}`)
      .then((d) => { setSummary(d); setErr(''); })
      .catch((e) => setErr(e.message)), [staff, code]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [refresh]);

  const report = () =>
    api(staff, '/dashboard/incidents', {
      method: 'POST',
      body: JSON.stringify({
        code, ...form,
        lat: mapCenter?.lat, lng: mapCenter?.lng,
      }),
    }).then(() => { setForm({ ...form, description: '' }); refresh(); })
      .catch((e) => setErr(e.message));

  const advance = (i) => {
    const next = i.status === 'open' ? 'acknowledged' : 'resolved';
    api(staff, `/dashboard/incidents/${i.id}`, {
      method: 'PATCH', body: JSON.stringify({ status: next }),
    }).then(refresh).catch((e) => setErr(e.message));
  };

  const [reason, setReason] = useState('incident_investigation');
  const loadIdentified = () =>
    api(staff, `/dashboard/incidents/identified?code=${code}&reason=${reason}`)
      .then(setIdentified)
      .catch((e) => setIdentified({ denied: true, message: e.message, status: e.status }));

  const maxCat = Math.max(...(summary?.byCategory ?? []).map((c) => c.count), 1);

  return (
    <section className="dash-panel">
      <header>
        <h2>Incidents</h2>
        <span className="dash-muted">counts & types — no guest identity</span>
      </header>
      {err && <p className="dash-error">{err}</p>}

      <div className="dash-chips">
        {(summary?.byStatus ?? []).map((s) => (
          <span key={s.status} className={`dash-chip status-${s.status}`}>
            {s.status === 'open' ? '🔴' : s.status === 'acknowledged' ? '🟡' : '🟢'} {s.status}: {s.count}
          </span>
        ))}
      </div>

      {(summary?.byCategory ?? []).map((c) => (
        <div key={c.category} className="dash-bar-row">
          <span className="dash-bar-label">{c.category.replace(/_/g, ' ')}</span>
          <div className="dash-bar-track">
            <i style={{ width: `${(c.count / maxCat) * 100}%`, background: BAR_HUE }} />
          </div>
          <span className="dash-bar-value">{c.count}</span>
        </div>
      ))}

      <h3>Recent</h3>
      {(summary?.recent ?? []).length === 0 && <p className="dash-muted">No incidents reported.</p>}
      {(summary?.recent ?? []).map((i) => (
        <div key={i.id} className="dash-feed-row">
          <span>{new Date(i.created_at).toLocaleTimeString()}</span>
          <strong>{i.category.replace(/_/g, ' ')}</strong>
          <span className={`dash-chip status-${i.status}`}>{i.status}</span>
          {i.status !== 'resolved' && (
            <button className="dash-link-btn" onClick={() => advance(i)}>
              {i.status === 'open' ? 'acknowledge' : 'resolve'}
            </button>
          )}
        </div>
      ))}

      <div className="dash-form-row">
        <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
          {(summary?.categories ?? ['medical', 'other']).map((c) =>
            <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
        </select>
        <input placeholder="Description (optional)" value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <button className="dash-primary" onClick={report}>Report incident</button>
      </div>

      <h3>Identified view <span className="dash-muted">(Security role — every access is audited with a reason code)</span></h3>
      {!identified && (
        <div className="dash-form-row">
          <select value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason code">
            {['incident_investigation', 'sos_response', 'medical', 'lost_person',
              'wellness_check', 'dispatch', 'shift_handover', 'other'].map((r) =>
              <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
          </select>
          <button onClick={loadIdentified}>Load identified incidents</button>
        </div>
      )}
      {identified?.denied && (
        <p className="dash-error">
          {identified.status === 403
            ? 'Denied by the data layer: this account does not hold the Security role.'
            : identified.message}
        </p>
      )}
      {identified?.incidents && (
        <table className="dash-table">
          <thead><tr><th>Time</th><th>Category</th><th>Subject</th><th>Status</th></tr></thead>
          <tbody>
            {identified.incidents.map((i) => (
              <tr key={i.id}>
                <td>{new Date(i.created_at).toLocaleTimeString()}</td>
                <td>{i.category.replace(/_/g, ' ')}</td>
                <td>{i.subject_name ?? '—'}</td>
                <td>{i.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- analytics

function AnalyticsPanel({ staff, code }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  const refresh = useCallback(() =>
    api(staff, `/dashboard/analytics?code=${code}`)
      .then((d) => { setData(d); setErr(''); })
      .catch((e) => setErr(e.message)), [staff, code]);
  useEffect(() => { refresh(); }, [refresh]);

  const exportCsv = async () => {
    const res = await fetch(`/api/dashboard/analytics?code=${code}&format=csv`, {
      headers: { 'x-staff-session': staff.id },
    });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `nannaboo-analytics-${code}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const HourBars = ({ title, rows }) => {
    const max = Math.max(...rows.map((r) => r.count), 1);
    return (
      <div className="dash-hours">
        <h3>{title}</h3>
        {rows.length === 0 && <p className="dash-muted">no data yet</p>}
        {rows.map((r) => (
          <div key={r.hour} className="dash-bar-row">
            <span className="dash-bar-label">{r.hour.slice(11)}</span>
            <div className="dash-bar-track">
              <i style={{ width: `${(r.count / max) * 100}%`, background: BAR_HUE }} />
            </div>
            <span className="dash-bar-value">{r.count}</span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <section className="dash-panel">
      <header>
        <h2>Analytics</h2>
        <button className="dash-primary" onClick={exportCsv}>Export CSV</button>
      </header>
      {err && <p className="dash-error">{err}</p>}
      {data?.memoryMode && <p className="dash-muted">⚠ {data.note}</p>}
      <div className="dash-tiles">
        <div className="dash-tile"><em>{data?.dwell?.guests ?? '—'}</em><span>guests tracked</span></div>
        <div className="dash-tile"><em>{data?.dwell?.avg_dwell_min ?? '—'}<small> min</small></em><span>avg dwell</span></div>
        <div className="dash-tile"><em>{data?.dwell?.median_dwell_min ?? '—'}<small> min</small></em><span>median dwell</span></div>
        <div className="dash-tile"><em>{data?.dwell?.max_dwell_min ?? '—'}<small> min</small></em><span>longest dwell</span></div>
      </div>
      <div className="dash-hours-grid">
        <HourBars title="Entries by hour" rows={data?.entriesByHour ?? []} />
        <HourBars title="Exits by hour" rows={data?.exitsByHour ?? []} />
      </div>
      <h3>Peak windows</h3>
      {(data?.peakWindows ?? []).map((p) => (
        <div key={p.window} className="dash-feed-row">
          <span>{p.window}</span><strong>{p.guests} guests</strong>
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------- shell

export default function Dashboard() {
  const [staff, setStaff] = useStaff();
  const [code, setCode] = useState(localStorage.getItem('nb_dash_code') ?? '');
  const [codeInput, setCodeInput] = useState(code);
  const [tab, setTab] = useState('live');
  const mapCenterRef = useRef(null);
  const [mapCenter, setMapCenter] = useState(null);
  const onCenter = useCallback((c) => { mapCenterRef.current = c; setMapCenter(c); }, []);

  if (!staff) return <Login onSignIn={setStaff} />;

  if (!code) {
    return (
      <div className="dash-login">
        <div className="dash-login-card">
          <h1>NannaBoo Ops</h1>
          <p className="dash-muted">Which event (group code) do you want to monitor?</p>
          <input placeholder="e.g. ZIMM2026" value={codeInput}
            onChange={(e) => setCodeInput(e.target.value.toUpperCase())} />
          <button className="dash-primary" disabled={!codeInput.trim()}
            onClick={() => { localStorage.setItem('nb_dash_code', codeInput.trim()); setCode(codeInput.trim()); }}>
            Monitor →
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="dash-root">
      <nav className="dash-nav">
        <strong>NannaBoo Ops</strong>
        <span className="dash-chip">{code}</span>
        <span className="dash-chip role">{staff.role}</span>
        <div className="dash-nav-tabs">
          {[['live', 'Live'], ['pois', 'POIs'], ['incidents', 'Incidents'], ['analytics', 'Analytics']].map(([k, label]) => (
            <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>
        <button className="dash-link-btn" onClick={() => { setStaff(null); }}>sign out</button>
      </nav>
      <main className="dash-main">
        {tab === 'live' && (
          <>
            <HeatmapPanel staff={staff} code={code} onCenter={onCenter} />
            <ZonesPanel staff={staff} code={code} mapCenter={mapCenter} />
          </>
        )}
        {tab === 'pois' && (
          <>
            <HeatmapPanel staff={staff} code={code} onCenter={onCenter} />
            <PoiPanel staff={staff} mapCenter={mapCenter} />
          </>
        )}
        {tab === 'incidents' && <IncidentsPanel staff={staff} code={code} mapCenter={mapCenter} />}
        {tab === 'analytics' && <AnalyticsPanel staff={staff} code={code} />}
      </main>
    </div>
  );
}
