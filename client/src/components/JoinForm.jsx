import { useState } from 'react';

export const VISIBILITY_OPTIONS = [
  { value: 'public', icon: '🌐', label: 'Everyone', hint: 'Anyone at this event can see you on the map' },
  { value: 'friends_only', icon: '⭐', label: 'Friends', hint: 'Only friends you’ve accepted can see you' },
  { value: 'off', icon: '🙈', label: 'Hidden', hint: 'Nobody can see you on the map' },
];

export default function JoinForm({ onJoin }) {
  const [name, setName] = useState(localStorage.getItem('nb_name') || '');
  const [groupCode, setGroupCode] = useState(localStorage.getItem('nb_group') || '');
  const [visibility, setVisibility] = useState(
    VISIBILITY_OPTIONS.some((o) => o.value === localStorage.getItem('nb_visibility'))
      ? localStorage.getItem('nb_visibility')
      : 'public'
  );
  const [error, setError] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    const n = name.trim();
    const g = groupCode.trim().toUpperCase();
    if (!n) { setError('Enter your name'); return; }
    if (!g) { setError('Enter a group code'); return; }
    localStorage.setItem('nb_name', n);
    localStorage.setItem('nb_group', g);
    localStorage.setItem('nb_visibility', visibility);
    onJoin(n, g, visibility);
  };

  return (
    <div className="join-screen">
      <div className="join-card">
        <div className="join-logo">N</div>
        <h1>NannaBoo</h1>
        <p className="join-subtitle">Find your people at the lake</p>
        <form onSubmit={handleSubmit}>
          <label>
            Your name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Grandma Pat"
              autoComplete="given-name"
              autoCapitalize="words"
            />
          </label>
          <label>
            Group code
            <input
              type="text"
              value={groupCode}
              onChange={(e) => setGroupCode(e.target.value.toUpperCase())}
              placeholder="e.g. SMITH2026"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <fieldset className="visibility-fieldset">
            <legend>Who can see you on the map?</legend>
            <div className="visibility-options" role="radiogroup" aria-label="Visibility">
              {VISIBILITY_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={visibility === o.value}
                  className={`visibility-pill ${visibility === o.value ? 'active' : ''}`}
                  onClick={() => setVisibility(o.value)}
                >
                  {o.icon} {o.label}
                </button>
              ))}
            </div>
            <p className="visibility-hint">
              {VISIBILITY_OPTIONS.find((o) => o.value === visibility).hint}. You
              can change this anytime.
            </p>
          </fieldset>
          {error && <p className="error">{error}</p>}
          <button type="submit">Find my group →</button>
        </form>
        <p className="join-hint">Everyone in your family uses the same group code.</p>
      </div>
    </div>
  );
}
