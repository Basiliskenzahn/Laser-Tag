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

// A burst of white noise through a band-pass filter, for percussive sounds.
function noise({ freq, q = 1, duration, volume = 0.2, delay = 0 }) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = q;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
  src.connect(filter).connect(gain).connect(ctx.destination);
  src.start(t);
}

export const shoot = () => tone({ from: 1400, to: 180, duration: 0.15, volume: 0.12 });

// A thwack: a sharp noise smack over a low thump that drops in pitch.
export function hitConfirmed(headshot) {
  noise({ freq: 1800, q: 0.8, duration: 0.05, volume: 0.5 });
  tone({ type: 'sine', from: 220, to: 55, duration: 0.12, volume: 0.45 });
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

// One short tick per results line, timed to match the lines appearing.
export function statTicks(count, start, step) {
  for (let i = 0; i < count; i++) tone({ type: 'sine', from: 900 + i * 60, duration: 0.04, volume: 0.08, delay: start + i * step });
}
