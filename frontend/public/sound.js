// Synthesised sound effects, so there are no audio files to load.

let ctx = null;

// iOS mutes Web Audio with the ring/silent switch unless the page says it plays media.
if (navigator.audioSession) navigator.audioSession.type = 'playback';

// Browsers only allow audio after a user gesture, so call this from a tap handler. iOS also
// suspends the context again when the camera starts or the page is hidden, so every tap retries.
export function unlock() {
  ctx ??= new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state !== 'running') ctx.resume();
}

function tone({ type = 'square', from, to = from, duration, volume = 0.2, delay = 0 }) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(to, t + duration);
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + duration);
}

export const shoot = () => tone({ from: 1400, to: 180, duration: 0.15, volume: 0.12 });

export function hitConfirmed(headshot) {
  tone({ type: 'sine', from: 1500, duration: 0.06 });
  if (headshot) tone({ type: 'sine', from: 2200, duration: 0.08, delay: 0.07 });
}

export const hurt = () => tone({ type: 'sawtooth', from: 320, to: 60, duration: 0.35, volume: 0.25 });

export function win() {
  [523, 659, 784, 1047].forEach((f, i) => tone({ type: 'triangle', from: f, duration: 0.18, delay: i * 0.12 }));
}

export function lose() {
  [392, 330, 262].forEach((f, i) => tone({ type: 'triangle', from: f, duration: 0.25, delay: i * 0.18 }));
}

export function countdownBeep(final) {
  tone({ type: 'sine', from: final ? 1320 : 660, duration: final ? 0.3 : 0.12 });
}
