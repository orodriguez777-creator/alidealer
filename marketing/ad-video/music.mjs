// Original royalty-free music bed for the 20.8 s ad: 120 BPM, C–G–Am–F.
// Calm intro (scene 1), beat drops at 4.0 s when she finds Alidealer, whooshes on cuts.
import { writeFileSync } from 'node:fs';
const SR = 44100, DUR = 20.8, N = Math.ceil(SR * DUR);
const L = new Float32Array(N), R = new Float32Array(N);
const BEAT = 0.5, DROP = 4.0, CUTS = [4.0, 7.0, 12.0, 15.3];
const hz = m => 440 * 2 ** ((m - 69) / 12);
let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

function add(t0, buf, gain = 1, pan = 0) {
  const s0 = Math.round(t0 * SR), gl = gain * Math.cos((pan + 1) * Math.PI / 4), gr = gain * Math.sin((pan + 1) * Math.PI / 4);
  for (let i = 0; i < buf.length && s0 + i < N; i++) if (s0 + i >= 0) { L[s0 + i] += buf[i] * gl; R[s0 + i] += buf[i] * gr; }
}
function tone(f, dur, { a = 0.005, d = 0.3, harm = [1, 0.4, 0.15], sus = 0 } = {}) {
  const n = Math.round(dur * SR), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR, env = Math.min(1, t / a) * (sus + (1 - sus) * Math.exp(-t / d)) * Math.min(1, (dur - t) / 0.05);
    let v = 0; harm.forEach((h, k) => v += h * Math.sin(2 * Math.PI * f * (k + 1) * t));
    b[i] = v * env;
  }
  return b;
}
function noise(dur, decay, hp = 0.9) {
  const n = Math.round(dur * SR), b = new Float32Array(n); let prev = 0, y = 0;
  for (let i = 0; i < n; i++) { const x = rnd(); y = hp * (y + x - prev); prev = x; b[i] = y * Math.exp(-(i / SR) / decay); }
  return b;
}
function kick() {
  const n = Math.round(0.35 * SR), b = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / SR; ph += 2 * Math.PI * (50 + 90 * Math.exp(-t / 0.04)) / SR; b[i] = Math.sin(ph) * Math.exp(-t / 0.12); }
  return b;
}
function whoosh(len = 0.6) {
  const n = Math.round(len * SR), b = new Float32Array(n); let y = 0;
  for (let i = 0; i < n; i++) { const p = i / n, c = 0.02 + 0.25 * Math.sin(Math.PI * p); y += c * (rnd() - y); b[i] = y * Math.sin(Math.PI * p) ** 2; }
  return b;
}

const CHORDS = [[48, 60, 64, 67], [43, 59, 62, 67], [45, 60, 64, 69], [41, 60, 65, 69]]; // C G Am F (bass + triad)
const MELODY = [76, 74, 72, 74, 76, 79, 76, 74, 72, 69, 72, 74, 72, null, 67, 72]; // eighth notes over 2 bars

for (let bar = 0; bar * 2 < DUR; bar++) {
  const t = bar * 2, [bass, ...tri] = CHORDS[bar % 4], full = t >= DROP, end = t >= 18;
  // soft pad on every bar
  tri.forEach((m, k) => add(t, tone(hz(m), 2.05, { a: 0.25, d: 1.5, sus: 0.5, harm: [1, 0.2] }), full ? 0.045 : 0.09, [-0.5, 0, 0.5][k]));
  for (let e = 0; e < 8; e++) {
    const te = t + e * BEAT / 2; if (te >= DUR - 0.6) break;
    if (full) {
      if (e % 2 === 0) add(te, kick(), e % 4 === 0 ? 0.55 : 0.4);
      if (e === 2 || e === 6) add(te, noise(0.25, 0.07, 0.6), 0.22, 0.1);           // snare/clap
      add(te, tone(hz(bass - 12), 0.24, { d: 0.12, harm: [1, 0.5, 0.2] }), 0.32);  // bass
      if (e % 2 === 1) tri.forEach((m, k) => add(te, tone(hz(m + 12), 0.2, { d: 0.08, harm: [1, 0.3] }), 0.05, [-0.4, 0, 0.4][k])); // stabs
      if (bar >= 4 && !end) { const m = MELODY[(bar % 2) * 8 + e]; if (m) add(te, tone(hz(m), 0.4, { d: 0.18, harm: [1, 0.25, 0.1] }), 0.07, 0.25); }
    }
    add(te, noise(0.06, 0.015), full ? 0.07 : 0.035, e % 2 ? 0.4 : -0.4);           // hats
  }
}
// riser into the drop, whooshes on scene cuts, final chord
add(DROP - 1.5, (() => { const n = 1.5 * SR, b = new Float32Array(n); let y = 0; for (let i = 0; i < n; i++) { const p = i / n; y += (0.01 + 0.3 * p) * (rnd() - y); b[i] = y * p * p; } return b; })(), 0.5);
CUTS.forEach(c => add(c - 0.3, whoosh(), 0.35));
[48, 60, 64, 67, 72].forEach(m => add(18.8, tone(hz(m), 2, { d: 0.9, harm: [1, 0.3, 0.1] }), 0.09));

// master: fade in/out, soft clip, normalise to -1 dBFS
let peak = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR, g = Math.min(1, t / 0.3) * Math.min(1, (DUR - t) / 0.8);
  L[i] = Math.tanh(L[i] * 1.3 * g); R[i] = Math.tanh(R[i] * 1.3 * g); peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const k = 0.89 / peak, out = Buffer.alloc(44 + N * 4);
out.write('RIFF', 0); out.writeUInt32LE(36 + N * 4, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16);
out.writeUInt16LE(1, 20); out.writeUInt16LE(2, 22); out.writeUInt32LE(SR, 24); out.writeUInt32LE(SR * 4, 28);
out.writeUInt16LE(4, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) { out.writeInt16LE(Math.round(L[i] * k * 32767), 44 + i * 4); out.writeInt16LE(Math.round(R[i] * k * 32767), 46 + i * 4); }
writeFileSync('/tmp/vid/music.wav', out);
console.log('music.wav', DUR + 's');
