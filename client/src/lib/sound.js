// Audible "ding" chime. iOS Safari has no navigator.vibrate and no
// page-context notifications, so for a foregrounded iPhone this chime IS the
// attention signal. WebAudio must be unlocked by a user gesture — primeAudio
// is hooked to the first tap anywhere in the app.
let ctx = null;

export function primeAudio() {
  if (ctx) return;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  } catch { /* no WebAudio — banner only */ }
}

export function playDing() {
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const t = ctx.currentTime;
  // two quick rising notes — friendly, not alarming
  for (const [freq, start] of [[880, 0], [1174.7, 0.15]]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t + start);
    gain.gain.exponentialRampToValueAtTime(0.25, t + start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + start + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t + start);
    osc.stop(t + start + 0.55);
  }
}
