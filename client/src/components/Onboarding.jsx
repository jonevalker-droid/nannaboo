// First-time onboarding (Prompt 7): every consent choice in ONE guided,
// check-in-style sequence, plain language, one decision per screen.
//
// HARD INVARIANT (do not regress): the app stays fully functional — live
// map, POIs, exits, AR wayfinding, anonymized venue_safety_network presence
// — no matter what the guest declines here. Only TWO features are consent-
// gated: identity sharing with security (identified_security_roster [+ the
// medical profile that depends on it]) and friend sharing levels. Basic
// safety and wayfinding are never behind consent. venue_safety_network
// (anonymous dot for safety ops) is a disclosed condition of entry, not a
// choice — it's explained in the data step below.
//
// The location step shows WHY before the OS prompt ever fires: the real
// geolocation request starts only on that step's Continue tap (field
// testing showed people reflexively deny cold prompts).
import { useEffect, useState } from 'react';
import { VISIBILITY_OPTIONS } from './JoinForm';

export default function Onboarding({
  geoStatus, onRequestLocation,
  visibility, onChangeVisibility,
  rosterConsent, onChangeRosterConsent,
  medicalResult, onSaveMedical,
  onComplete,
}) {
  const [step, setStep] = useState(0);
  const [medical, setMedical] = useState(
    () => localStorage.getItem('nb_medical_profile') ?? ''
  );
  const [retentionHours, setRetentionHours] = useState(null);

  useEffect(() => {
    fetch('/api/venue/retention')
      .then((r) => r.json())
      .then((d) => setRetentionHours(d.hours))
      .catch(() => setRetentionHours(null));
  }, []);

  const next = () => setStep((s) => s + 1);
  const TOTAL = 6;

  const saveMedicalAndNext = () => {
    const text = medical.trim();
    localStorage.setItem('nb_medical_profile', text);
    if (text && rosterConsent) onSaveMedical(text);
    next();
  };

  return (
    <div className="join-screen onboarding">
      <div className="join-card">
        <div className="onboarding-progress" aria-hidden="true">
          {Array.from({ length: TOTAL }, (_, i) => (
            <i key={i} className={i <= step ? 'done' : ''} />
          ))}
        </div>

        {step === 0 && (
          <section className="onboarding-step">
            <div className="join-logo">N</div>
            <h2>Welcome to NannaBoo</h2>
            <p>One map for your whole crew — find your people, the exits, and help fast.</p>
            <p className="onboarding-hint">A few quick choices about what you share. You can change any of them later.</p>
            <button className="onboarding-primary" onClick={next}>Get started →</button>
          </section>
        )}

        {step === 1 && (
          <section className="onboarding-step">
            <h2>📍 Your location</h2>
            <p>
              We'll ask to use your location so your friends and event staff
              can find you if needed. Your phone will show the permission
              prompt after you tap Continue.
            </p>
            {geoStatus === 'ok' && <p className="onboarding-ok">✓ Location is on</p>}
            {geoStatus === 'denied' && (
              <p className="onboarding-warn">
                Location was blocked — you can still use the map and exits, and
                turn location on later from your browser settings.
              </p>
            )}
            {geoStatus !== 'ok' && geoStatus !== 'denied' && (
              <button
                className="onboarding-primary"
                onClick={onRequestLocation /* fires the REAL OS prompt now */}
              >
                Continue — ask for my location
              </button>
            )}
            <button
              className={geoStatus === 'ok' || geoStatus === 'denied' ? 'onboarding-primary' : 'onboarding-skip'}
              onClick={next}
            >
              {geoStatus === 'ok' || geoStatus === 'denied' ? 'Next →' : 'Skip for now'}
            </button>
          </section>
        )}

        {step === 2 && (
          <section className="onboarding-step">
            <h2>👀 Who can see you?</h2>
            <div className="visibility-options" role="radiogroup" aria-label="Visibility">
              {VISIBILITY_OPTIONS.map((o) => (
                <button key={o.value} type="button" role="radio"
                  aria-checked={visibility === o.value}
                  className={`visibility-pill ${visibility === o.value ? 'active' : ''}`}
                  onClick={() => onChangeVisibility(o.value)}>
                  {o.icon} {o.label}
                </button>
              ))}
            </div>
            <p className="onboarding-hint">
              {VISIBILITY_OPTIONS.find((o) => o.value === visibility)?.hint}.
            </p>
            <button className="onboarding-primary" onClick={next}>Next →</button>
          </section>
        )}

        {step === 3 && (
          <section className="onboarding-step">
            <h2>🛡 Event security</h2>
            <p>
              If you opt in, security can see your <strong>name</strong> — not
              just an anonymous dot — if they ever need to find you (like if
              you press 🆘 or someone reports you missing).
            </p>
            <label className="roster-consent-row onboarding-toggle">
              <input type="checkbox" checked={rosterConsent}
                onChange={(e) => onChangeRosterConsent(e.target.checked)} />
              <span><strong>Share my identity with event security</strong>
                <small>Off by default. Your choice, changeable anytime.</small></span>
            </label>
            <button className="onboarding-primary" onClick={next}>Next →</button>
          </section>
        )}

        {step === 4 && (
          <section className="onboarding-step">
            <h2>⚕ Medical info <span className="onboarding-optional">(optional)</span></h2>
            {rosterConsent ? (
              <>
                <p>
                  Anything medics should know if they respond to you — e.g.
                  “Type 1 diabetic”, “penicillin allergy”. Stored encrypted,
                  shown only to security responding to you.
                </p>
                <textarea rows={3} maxLength={500} value={medical}
                  placeholder="e.g. Type 1 diabetic"
                  onChange={(e) => setMedical(e.target.value)} />
                {medicalResult?.error && <p className="onboarding-warn">{medicalResult.error}</p>}
                <button className="onboarding-primary" onClick={saveMedicalAndNext}>
                  {medical.trim() ? 'Save & continue →' : 'Skip →'}
                </button>
              </>
            ) : (
              <>
                {/* UI gate mirrors the data-layer rule: medical info requires
                    identity sharing — info security can't attach to anyone
                    helps nobody. */}
                <p className="onboarding-hint">
                  Medical info is only useful if security can also see who you
                  are. Turn on identity sharing (previous step) to add it —
                  or skip; you can do both later in Privacy &amp; Safety.
                </p>
                <button className="onboarding-primary" onClick={next}>Skip →</button>
              </>
            )}
          </section>
        )}

        {step === 5 && (
          <section className="onboarding-step">
            <h2>🗑 Your data</h2>
            <ul className="onboarding-data-list">
              <li>
                While you're here, venue safety staff can see an{' '}
                <strong>anonymous dot</strong> for everyone on site — no name,
                no profile. That's part of coming in, and it's never more than
                a dot unless you opted in above.
              </li>
              <li>
                Raw location history is <strong>deleted after{' '}
                {retentionHours ?? '…'} hours</strong>. Only anonymous
                totals (like crowd counts) are kept longer — nothing that
                identifies you.
              </li>
              <li>Every time security views your identity, it's logged and auditable.</li>
            </ul>
            <button className="onboarding-primary" onClick={onComplete}>
              Got it — show me the exits →
            </button>
          </section>
        )}
      </div>
    </div>
  );
}
