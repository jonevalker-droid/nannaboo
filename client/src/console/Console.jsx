// Security console (Prompt 6) — Security-role staff only, and the server
// enforces that on every request; this UI is presentation, not the control.
// High-liability rules surfaced in the UX so staff can't stumble:
//  - The roster and any guest identity load ONLY after picking a reason
//    code; every such view writes an audit row server-side.
//  - The inbox is identity-free until a deliberate per-incident "identify".
//  - Bulk export = reason code + typed confirmation, exchanged server-side
//    for a single-use token.
//  - The session countdown mirrors access_expires_at; expiry (or any 401)
//    signs the console out.
import { useCallback, useEffect, useRef, useState } from 'react';
import '../dashboard/dashboard.css';
import './console.css';

const REASONS = [
  'sos_response', 'medical', 'lost_person', 'wellness_check',
  'incident_investigation', 'dispatch', 'shift_handover', 'other',
];
const CATEGORIES = ['sos', 'medical', 'altercation', 'lost_person', 'theft', 'overcrowding', 'other'];

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#c0392b'];
const colorFor = (id) => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
};

const fmtPos = (r) => (r?.lat != null ? `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}` : 'no fix');
const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString() : '—');

function useStaff() {
  const [staff, setStaff] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('nb_console_staff')) ?? null; } catch { return null; }
  });
  const save = (s) => {
    if (s) sessionStorage.setItem('nb_console_staff', JSON.stringify(s));
    else sessionStorage.removeItem('nb_console_staff');
    setStaff(s);
  };
  return [staff, save];
}

function ReasonSelect({ value, onChange, label }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label ?? 'Reason code'}>
      <option value="">reason code…</option>
      {REASONS.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
    </select>
  );
}

export default function Console() {
  const [staff, setStaff] = useStaff();
  const [code, setCode] = useState(localStorage.getItem('nb_console_code') ?? '');
  const signOut = useCallback(() => setStaff(null), [setStaff]);

  const api = useCallback(async (path, opts = {}) => {
    const res = await fetch(`/api${path}`, {
      ...opts,
      headers: {
        'content-type': 'application/json',
        'x-staff-session': staff?.id ?? '',
        ...(opts.headers ?? {}),
      },
    });
    if (res.status === 401) { signOut(); throw new Error('session expired — signed out'); }
    const body = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(body?.error ?? `HTTP ${res.status}`), { status: res.status });
    return body;
  }, [staff, signOut]);

  if (!staff) return <Login onSignIn={setStaff} />;
  if (!code) return <PickEvent onPick={(c) => { localStorage.setItem('nb_console_code', c); setCode(c); }} />;
  return <Shell staff={staff} code={code} api={api} signOut={signOut} />;
}

function Login({ onSignIn }) {
  const [adminKey, setAdminKey] = useState('');
  const [name, setName] = useState('');
  const [hours, setHours] = useState('8');
  const [sessionId, setSessionId] = useState('');
  const [error, setError] = useState('');

  const bootstrap = async () => {
    try {
      const res = await fetch(`/api/security/session?key=${encodeURIComponent(adminKey)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name || 'Security', role: 'security', hours: Number(hours) || 8 }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? 'could not create session');
      onSignIn({
        id: body.session.id, name: name || 'Security',
        expiresAt: body.session.access_expires_at ?? null,
      });
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="dash-login console-theme">
      <div className="dash-login-card">
        <h1>🛡 NannaBoo Security</h1>
        <p className="dash-muted">
          Identified guest data. Every lookup is audited with your session id,
          the guest, a timestamp, and your reason code.
        </p>
        <h3>Start a shift session</h3>
        <input placeholder="Admin key" type="password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} />
        <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
        <label className="console-hours">
          Shift length (hours — access auto-expires)
          <input type="number" min="0.1" max="24" step="0.5" value={hours}
            onChange={(e) => setHours(e.target.value)} />
        </label>
        <button className="dash-primary" onClick={bootstrap}>Start shift →</button>
        <h3>Or paste an existing session id</h3>
        <input placeholder="staff session id" value={sessionId} onChange={(e) => setSessionId(e.target.value)} />
        <button disabled={!sessionId.trim()}
          onClick={() => onSignIn({ id: sessionId.trim(), name: 'Security', expiresAt: null })}>
          Sign in
        </button>
        {error && <p className="dash-error">{error}</p>}
      </div>
    </div>
  );
}

function PickEvent({ onPick }) {
  const [v, setV] = useState('');
  return (
    <div className="dash-login console-theme">
      <div className="dash-login-card">
        <h1>🛡 NannaBoo Security</h1>
        <p className="dash-muted">Which event (group code)?</p>
        <input placeholder="e.g. ZIMM2026" value={v} onChange={(e) => setV(e.target.value.toUpperCase())} />
        <button className="dash-primary" disabled={!v.trim()} onClick={() => onPick(v.trim())}>Open console →</button>
      </div>
    </div>
  );
}

function Countdown({ expiresAt, onExpire }) {
  const [left, setLeft] = useState('');
  useEffect(() => {
    if (!expiresAt) return;
    const t = setInterval(() => {
      const ms = new Date(expiresAt) - Date.now();
      if (ms <= 0) { clearInterval(t); onExpire(); return; }
      const m = Math.floor(ms / 60000);
      setLeft(m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${Math.floor((ms % 60000) / 1000)}s`);
    }, 1000);
    return () => clearInterval(t);
  }, [expiresAt, onExpire]);
  if (!expiresAt) return null;
  return <span className="dash-chip console-countdown" title="Session auto-expires at shift end">⏳ {left}</span>;
}

function Shell({ staff, code, api, signOut }) {
  const [tab, setTab] = useState('inbox');
  const myPosRef = useRef(null);

  // Staff position heartbeat — powers nearest-staff dispatch.
  useEffect(() => {
    if (!('geolocation' in navigator)) return;
    let last = 0;
    const id = navigator.geolocation.watchPosition(
      ({ coords }) => {
        myPosRef.current = { lat: coords.latitude, lng: coords.longitude };
        if (Date.now() - last < 10000) return;
        last = Date.now();
        api('/console/staff-position', {
          method: 'POST',
          body: JSON.stringify(myPosRef.current),
        }).catch(() => {});
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [api]);

  return (
    <div className="dash-root console-theme">
      <nav className="dash-nav">
        <strong>🛡 Security console</strong>
        <span className="dash-chip">{code}</span>
        <span className="dash-chip role">security</span>
        <Countdown expiresAt={staff.expiresAt} onExpire={signOut} />
        <div className="dash-nav-tabs">
          {[['inbox', 'SOS / Inbox'], ['roster', 'Roster'], ['log', 'Log incident']].map(([k, label]) => (
            <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>
        <button className="dash-link-btn" onClick={signOut}>end session</button>
      </nav>
      <main className="dash-main">
        {tab === 'inbox' && <Inbox api={api} code={code} staff={staff} />}
        {tab === 'roster' && <Roster api={api} code={code} />}
        {tab === 'log' && <LogIncident api={api} code={code} myPosRef={myPosRef} />}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------- inbox

function Inbox({ api, code, staff }) {
  const [incidents, setIncidents] = useState([]);
  const [err, setErr] = useState('');
  const [identify, setIdentify] = useState({}); // incidentId -> {reason} | {subject} | {error}
  const [dispatchFor, setDispatchFor] = useState(null); // {incident, staff:[]}

  const refresh = useCallback(() =>
    api(`/console/inbox?code=${code}`)
      .then((d) => { setIncidents(d.incidents); setErr(''); })
      .catch((e) => setErr(e.message)), [api, code]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const doIdentify = async (inc) => {
    const reason = identify[inc.id]?.reason;
    if (!reason) return;
    try {
      const d = await api(`/console/incidents/${inc.id}/subject?code=${code}&reason=${reason}`);
      setIdentify((s) => ({ ...s, [inc.id]: { subject: d.subject } }));
    } catch (e) {
      setIdentify((s) => ({ ...s, [inc.id]: { error: e.message } }));
    }
  };

  const openDispatch = async (inc) => {
    try { setDispatchFor(await api(`/console/dispatch/${inc.id}?code=${code}`)); }
    catch (e) { setErr(e.message); }
  };

  const assign = async (staffSessionId) => {
    await api('/console/dispatch', {
      method: 'POST',
      body: JSON.stringify({ incidentId: dispatchFor.incident.id, staffSessionId }),
    }).catch((e) => setErr(e.message));
    setDispatchFor(null);
    refresh();
  };

  const advance = (inc) => {
    const next = inc.status === 'open' ? 'acknowledged' : 'resolved';
    api(`/dashboard/incidents/${inc.id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) })
      .then(refresh).catch((e) => setErr(e.message));
  };

  return (
    <section className="dash-panel console-wide">
      <header>
        <h2>SOS & incident inbox</h2>
        <span className="dash-muted">guest-triggered alerts first · identity only via audited identify</span>
      </header>
      {err && <p className="dash-error">{err}</p>}
      {incidents.length === 0 && <p className="dash-muted">Nothing yet. Quiet shift.</p>}
      {incidents.map((inc) => {
        const idn = identify[inc.id] ?? {};
        return (
          <div key={inc.id} className={`console-incident ${inc.category === 'sos' && inc.status !== 'resolved' ? 'is-sos' : ''}`}>
            <div className="console-incident-head">
              <strong>{inc.category === 'sos' ? '🆘 SOS' : inc.category.replace(/_/g, ' ')}</strong>
              <span className={`dash-chip status-${inc.status}`}>{inc.status}</span>
              <span className="dash-muted">{fmtTime(inc.created_at)}</span>
              <span className="dash-muted">📍 {fmtPos(inc)}</span>
              {inc.assigned_staff_id && <span className="dash-chip">assigned</span>}
            </div>
            {inc.description && (
              <p className="console-incident-note">
                {/* SOS-time note ≠ persistent medical profile: this is what
                    the guest typed when pressing 🆘 (or a staff report). */}
                {inc.category === 'sos'
                  ? <><strong>SOS note:</strong> {inc.description.replace(/^Guest SOS( — )?/, '') || '(none)'}</>
                  : inc.description}
              </p>
            )}
            <div className="console-incident-actions">
              {inc.status !== 'resolved' && (
                <>
                  <button className="dash-link-btn" onClick={() => advance(inc)}>
                    {inc.status === 'open' ? 'acknowledge' : 'resolve'}
                  </button>
                  <button className="dash-link-btn" onClick={() => openDispatch(inc)}>dispatch…</button>
                </>
              )}
              {inc.has_subject && !idn.subject && (
                <span className="console-identify">
                  <ReasonSelect value={idn.reason ?? ''} label={`Reason for identifying incident ${inc.id}`}
                    onChange={(r) => setIdentify((s) => ({ ...s, [inc.id]: { reason: r } }))} />
                  <button className="dash-link-btn" disabled={!idn.reason} onClick={() => doIdentify(inc)}>
                    identify subject (audited)
                  </button>
                </span>
              )}
              {idn.subject && (
                <span className="console-subject">
                  👤 <strong>{idn.subject.subject_name ?? 'unknown'}</strong>
                  {' · '}{fmtPos(idn.subject)}
                  {idn.subject.confidence != null && ` · conf ${Math.round(idn.subject.confidence * 100)}%`}
                  {idn.subject.medical_info && (
                    <span className="console-medical">⚕ Profile: {idn.subject.medical_info}</span>
                  )}
                  <em className="dash-muted"> (view audited)</em>
                </span>
              )}
              {idn.error && <span className="dash-error">{idn.error}</span>}
            </div>
          </div>
        );
      })}

      {dispatchFor && (
        <div className="console-modal-overlay" onClick={() => setDispatchFor(null)}>
          <div className="console-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Dispatch to {dispatchFor.incident.category === 'sos' ? '🆘 SOS' : dispatchFor.incident.category}</h3>
            {dispatchFor.staff.length === 0 && (
              <p className="dash-muted">
                No staff positions in the last 5 minutes. Consoles report
                location automatically while open — including yours.
              </p>
            )}
            {dispatchFor.staff.map((s) => (
              <div key={s.staffSessionId} className="dash-feed-row">
                <strong>{s.name}{s.isYou ? ' (you)' : ''}</strong>
                <span>{s.distanceM != null ? `${s.distanceM} m away` : 'distance unknown'}</span>
                <button className="dash-link-btn" onClick={() => assign(s.staffSessionId)}>assign</button>
              </div>
            ))}
            <div className="sheet-buttons">
              <button onClick={() => setDispatchFor(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- roster

function Roster({ api, code }) {
  const [reason, setReason] = useState('');
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [exp, setExp] = useState(null); // {reason, confirm} export modal state

  const load = () =>
    api(`/console/roster?code=${code}&reason=${reason}`)
      .then((d) => { setRows(d.roster); setErr(''); })
      .catch((e) => setErr(e.message));

  const runExport = async () => {
    try {
      const intent = await api('/console/export/intent', {
        method: 'POST', body: JSON.stringify({ code, reason: exp.reason }),
      });
      const res = await fetch(`/api/console/export?code=${code}&token=${intent.token}`, {
        headers: { 'x-staff-session': JSON.parse(sessionStorage.getItem('nb_console_staff')).id },
      });
      if (!res.ok) throw new Error((await res.json())?.error ?? 'export failed');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `roster-${code}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      setExp(null);
    } catch (e) { setErr(e.message); setExp(null); }
  };

  const visible = (rows ?? []).filter((r) =>
    r.display_name?.toLowerCase().includes(q.toLowerCase()));

  return (
    <section className="dash-panel console-wide">
      <header>
        <h2>Identified roster</h2>
        <span className="dash-muted">guests who granted identified_security_roster · every view audited</span>
      </header>
      {err && <p className="dash-error">{err}</p>}

      {!rows && (
        <div className="dash-form-row">
          <ReasonSelect value={reason} onChange={setReason} />
          <button className="dash-primary" disabled={!reason} onClick={load}>
            Load roster (writes audit rows)
          </button>
        </div>
      )}

      {rows && (
        <>
          <div className="dash-form-row">
            <input placeholder="Search name…" value={q} onChange={(e) => setQ(e.target.value)} />
            <button onClick={load}>Refresh</button>
            <button className="dash-primary" onClick={() => setExp({ reason: '', confirm: '' })}>
              Export…
            </button>
          </div>
          {rows.length === 0 && (
            <p className="dash-muted">Nobody has opted into the identified roster for this event.</p>
          )}
          <table className="dash-table">
            <thead><tr><th /><th>Name</th><th>Medical (profile)</th><th>Last known position</th><th>Confidence</th><th>Seen</th></tr></thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id}>
                  <td>
                    {/* No guest photos exist in the system — colored-initial
                        avatar, same identity mark the guest map uses. */}
                    <span className="console-avatar" style={{ background: colorFor(r.id) }}>
                      {(r.display_name ?? '?')[0].toUpperCase()}
                    </span>
                  </td>
                  <td>{r.display_name}</td>
                  <td className="console-medical-cell">
                    {r.medical_info ? <>⚕ {r.medical_info}</> : '—'}
                  </td>
                  <td>{fmtPos(r)}</td>
                  <td>
                    {r.confidence != null ? (
                      <span className="console-conf">
                        <span className="dash-meter"><i style={{ width: `${r.confidence * 100}%`, background: '#2a78d6' }} /></span>
                        {Math.round(r.confidence * 100)}%
                      </span>
                    ) : '—'}
                  </td>
                  <td>{fmtTime(r.recorded_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {exp && (
        <div className="console-modal-overlay" onClick={() => setExp(null)}>
          <div className="console-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Bulk roster export</h3>
            <p className="dash-muted">
              Exports every identified guest as CSV. Requires a reason code and
              a typed confirmation; the export itself is audited.
            </p>
            <ReasonSelect value={exp.reason} onChange={(r) => setExp({ ...exp, reason: r })} />
            <input
              placeholder='Type EXPORT to confirm'
              value={exp.confirm}
              onChange={(e) => setExp({ ...exp, confirm: e.target.value })}
            />
            <div className="sheet-buttons">
              <button onClick={() => setExp(null)}>Cancel</button>
              <button className="dash-primary"
                disabled={!exp.reason || exp.confirm !== 'EXPORT'}
                onClick={runExport}>
                Export roster
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- log form

function LogIncident({ api, code, myPosRef }) {
  const [form, setForm] = useState({ category: 'other', description: '' });
  const [msg, setMsg] = useState('');

  const submit = () =>
    api('/dashboard/incidents', {
      method: 'POST',
      body: JSON.stringify({
        code, ...form,
        lat: myPosRef.current?.lat, lng: myPosRef.current?.lng,
      }),
    }).then(() => { setMsg('Logged.'); setForm({ ...form, description: '' }); })
      .catch((e) => setMsg(e.message));

  return (
    <section className="dash-panel console-wide">
      <header><h2>Log an incident</h2></header>
      <div className="dash-form-row">
        <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
          {CATEGORIES.filter((c) => c !== 'sos').map((c) =>
            <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
        </select>
      </div>
      <textarea
        className="console-log-desc"
        rows={4}
        placeholder="What happened? (location defaults to your current position)"
        value={form.description}
        onChange={(e) => setForm({ ...form, description: e.target.value })}
      />
      <div className="dash-form-row">
        <button className="dash-primary" onClick={submit}>Log incident</button>
        {msg && <span className="dash-muted">{msg}</span>}
      </div>
    </section>
  );
}
