// Game sounds, made with Web Audio so there are no files to load: a wooden
// knock for moves, a heavier one for captures, a bright pair for check.

let ctx = null;
let enabled = true;

export function setSoundEnabled(on) {
  enabled = on;
}

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

// Browsers only allow sound after the first tap or key press.
["pointerdown", "keydown"].forEach((type) => window.addEventListener(type, () => audio(), { once: true, passive: true }));

// A short filtered noise burst: the "knock" of a piece on the board.
function knock(a, { at = 0, freq = 1800, q = 1.2, gain = 0.5, length = 0.07 } = {}) {
  const t = a.currentTime + at;
  const buffer = a.createBuffer(1, Math.ceil(a.sampleRate * length), a.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 4);
  const src = a.createBufferSource();
  src.buffer = buffer;
  const filter = a.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = freq;
  filter.Q.value = q;
  const g = a.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + length);
  src.connect(filter).connect(g).connect(a.destination);
  src.start(t);
}

function tone(a, { at = 0, freq = 880, length = 0.18, gain = 0.12, type = "sine" } = {}) {
  const t = a.currentTime + at;
  const osc = a.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + length);
  osc.connect(g).connect(a.destination);
  osc.start(t);
  osc.stop(t + length + 0.02);
}

const SOUNDS = {
  move: (a) => knock(a, { freq: 1500, gain: 0.55 }),
  capture: (a) => {
    knock(a, { freq: 900, gain: 0.7, length: 0.09 });
    knock(a, { at: 0.035, freq: 2200, gain: 0.25, length: 0.05 });
  },
  castle: (a) => {
    knock(a, { freq: 1500, gain: 0.5 });
    knock(a, { at: 0.11, freq: 1300, gain: 0.5 });
  },
  check: (a) => {
    knock(a, { freq: 1500, gain: 0.5 });
    tone(a, { at: 0.02, freq: 988, length: 0.14, gain: 0.08, type: "triangle" });
    tone(a, { at: 0.1, freq: 1319, length: 0.2, gain: 0.08, type: "triangle" });
  },
  premove: (a) => knock(a, { freq: 2600, gain: 0.25, length: 0.04 }),
  illegal: (a) => tone(a, { freq: 180, length: 0.15, gain: 0.08, type: "square" }),
  start: (a) => {
    tone(a, { freq: 523, length: 0.25, gain: 0.09 });
    tone(a, { at: 0.12, freq: 784, length: 0.35, gain: 0.09 });
  },
  end: (a) => {
    tone(a, { freq: 784, length: 0.3, gain: 0.09 });
    tone(a, { at: 0.14, freq: 659, length: 0.3, gain: 0.09 });
    tone(a, { at: 0.28, freq: 523, length: 0.5, gain: 0.09 });
  },
  lowtime: (a) => {
    tone(a, { freq: 1760, length: 0.08, gain: 0.07, type: "square" });
    tone(a, { at: 0.16, freq: 1760, length: 0.08, gain: 0.07, type: "square" });
  },
  notify: (a) => {
    tone(a, { freq: 1047, length: 0.16, gain: 0.07 });
    tone(a, { at: 0.09, freq: 1568, length: 0.22, gain: 0.07 });
  },
};

export function play(name) {
  if (!enabled) return;
  const a = audio();
  if (!a || a.state !== "running") return;
  try {
    SOUNDS[name]?.(a);
  } catch {
    /* sound is never essential */
  }
}

// The right sound for a chess.js move.
export function soundForMove(move, inCheck) {
  if (inCheck) return "check";
  if (move.flags.includes("k") || move.flags.includes("q")) return "castle";
  if (move.captured) return "capture";
  return "move";
}
