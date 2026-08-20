/* ============================================================
   reverb.js — procedurally generated convolution reverb.

   No impulse-response files exist and none may be downloaded, so we
   synthesise them: a decorrelated stereo noise bed shaped by an
   exponential decay envelope, darkened progressively over its own tail
   by a one-pole lowpass (air absorption), preceded by a handful of
   discrete early-reflection taps that give the space a *size*.

   Four spaces are required by the brief — outdoor, room, hall, cave —
   plus two the city needs: `market` (a wide, busy, bright square) and
   `plate` (a short bright sheen used on stings only).

   Everything here is seeded, so the IRs are byte-identical between
   builds and screenshots/recordings stay comparable.

   Public:
     SPACES                     the preset table
     generateImpulse(actx, o)   -> AudioBuffer
     createReverb(actx, dest)   -> { input, setSpace, update, dispose }
   ============================================================ */

/* Local seeded RNG. contracts.js exports one, but it imports THREE and
   this file must stay importable from a bare node test harness. */
function rng32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Early reflection patterns: [timeSeconds, gain] pairs, scaled by the
   preset's `size`. Sparse and irregular — regular taps ring like a comb
   filter and instantly sound like a cheap plug-in. */
const EARLY = [
  [0.0113, 0.82], [0.0197, -0.61], [0.0291, 0.54], [0.0403, -0.44],
  [0.0562, 0.38], [0.0731, -0.29], [0.0977, 0.23], [0.1291, -0.17],
];

export const SPACES = {
  /* Open island air: almost no tail, just a wide bright bloom and a
     couple of slap-backs off the cliffs. */
  outdoor: {
    seconds: 1.25, decay: 3.4, preDelay: 0.014, damping: 6200,
    size: 1.6, early: 0.30, width: 1.0, wet: 0.20, seed: 0x0111,
  },
  /* Small plaster interior. Tight, warm, a bit boxy on purpose. */
  room: {
    seconds: 0.78, decay: 6.0, preDelay: 0.005, damping: 3400,
    size: 0.34, early: 0.46, width: 0.62, wet: 0.26, seed: 0x0222,
  },
  /* Stone hall — the exchange, the treasury, the stadium concourse. */
  hall: {
    seconds: 2.9, decay: 2.3, preDelay: 0.026, damping: 4300,
    size: 1.0, early: 0.34, width: 0.86, wet: 0.30, seed: 0x0333,
  },
  /* The mine. Long, dark, slightly metallic, obviously underground. */
  cave: {
    seconds: 4.6, decay: 1.45, preDelay: 0.048, damping: 1500,
    size: 1.9, early: 0.40, width: 0.94, wet: 0.38, seed: 0x0444,
  },
  /* Market square: hard walls on three sides, sky on the fourth. */
  market: {
    seconds: 1.6, decay: 3.0, preDelay: 0.018, damping: 5200,
    size: 1.15, early: 0.42, width: 1.0, wet: 0.24, seed: 0x0555,
  },
  /* Short bright sheen for stings and the title card. */
  plate: {
    seconds: 1.9, decay: 3.8, preDelay: 0.002, damping: 7800,
    size: 0.16, early: 0.10, width: 1.0, wet: 0.34, seed: 0x0666,
  },
};

/* One-pole lowpass coefficient for a cutoff in Hz. */
function poleFor(hz, sampleRate) {
  const x = Math.exp(-2 * Math.PI * Math.max(20, hz) / sampleRate);
  return x;
}

/**
 * Synthesize a stereo impulse response.
 *
 * The tail is noise * exp(-decay * t) — the textbook shape — but the two
 * channels use independent noise streams (decorrelation is what makes a
 * convolution reverb sound wide rather than merely loud) and the lowpass
 * cutoff slides down across the tail so late energy is darker than early
 * energy, which is how real rooms behave.
 */
export function generateImpulse(actx, opts = {}) {
  const p = { ...SPACES.room, ...opts };
  const sr = actx.sampleRate || 44100;
  const len = Math.max(64, Math.floor(p.seconds * sr));
  const pre = Math.floor(p.preDelay * sr);
  const buf = actx.createBuffer(2, len + pre, sr);

  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const rnd = rng32((p.seed | 0) + ch * 7919 + 1);
    // Channel-specific damping so the stereo image is not a mirror.
    const hiCut = p.damping * (ch === 0 ? 1.0 : 0.93);
    const loCut = Math.max(240, p.damping * 0.10);
    let z = 0;

    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const u = i / len;
      // Exponential decay, with a short fade-out at the very end so the
      // buffer never terminates on a discontinuity (that clicks).
      let env = Math.exp(-p.decay * t);
      if (u > 0.86) env *= (1 - u) / 0.14;
      // Diffusion build-up: real tails swell for a few ms before decaying.
      const build = Math.min(1, t / 0.012);

      const n = rnd() * 2 - 1;
      // Progressive air absorption: cutoff glides hiCut -> loCut.
      const a = poleFor(hiCut + (loCut - hiCut) * u, sr);
      z = n * (1 - a) + z * a;

      d[i + pre] += z * env * build;
    }

    // Early reflections. Alternating polarity, channel-offset in time so
    // the space has a left/right geometry rather than a phantom centre.
    const skew = ch === 0 ? 1.0 : 1.13;
    for (let k = 0; k < EARLY.length; k++) {
      const [et, eg] = EARLY[k];
      const idx = pre + Math.floor(et * p.size * skew * sr);
      if (idx >= 0 && idx < d.length - 3) {
        const g = eg * p.early * Math.exp(-p.decay * et * p.size * 0.5);
        // 3-sample smear so the tap is a little slap, not a tick.
        d[idx] += g;
        d[idx + 1] += g * 0.5;
        d[idx + 2] += g * 0.2;
      }
    }

    // Stereo width: collapse toward mono by blending in channel 0.
    if (ch === 1 && p.width < 1) {
      const l = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = d[i] * p.width + l[i] * (1 - p.width);
    }
  }

  // Normalise to a predictable peak so switching spaces never jumps level.
  let peak = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  }
  if (peak > 0) {
    const k = 0.5 / peak;
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) d[i] *= k;
    }
  }
  return buf;
}

/**
 * A send-style reverb unit. Feed it with `unit.input`; it mixes its own
 * wet signal to `destination`. Spaces cross-fade over `fade` seconds via
 * two convolvers, so a room change never cuts a tail dead.
 */
export function createReverb(actx, destination, opts = {}) {
  const cache = new Map();
  const input = actx.createGain();
  input.gain.value = 1;

  // Pre-send tone shaping: roll off mud and fizz before the convolution,
  // which is both cheaper and cleaner than EQ-ing the wet return.
  const hp = actx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 220; hp.Q.value = 0.5;
  const lp = actx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 7200; lp.Q.value = 0.4;
  input.connect(hp); hp.connect(lp);

  const wet = actx.createGain();
  wet.gain.value = opts.wet ?? 0.24;
  wet.connect(destination);

  function makeSlot() {
    const conv = actx.createConvolver();
    conv.normalize = false;
    const g = actx.createGain();
    g.gain.value = 0;
    lp.connect(conv); conv.connect(g); g.connect(wet);
    return { conv, g };
  }
  const slots = [makeSlot(), makeSlot()];
  let active = 0;
  let current = null;

  function bufferFor(name) {
    if (!cache.has(name)) {
      const preset = SPACES[name] || SPACES.room;
      cache.set(name, generateImpulse(actx, preset));
    }
    return cache.get(name);
  }

  const unit = {
    input,
    get space() { return current; },
    /** Pre-build IRs so the first switch does not stall the audio thread. */
    warm(names = ['outdoor', 'room']) {
      for (const n of names) { try { bufferFor(n); } catch { /* offline ctx quirks */ } }
      return unit;
    },
    setSpace(name, fade = 1.2) {
      if (name === current) return unit;
      const preset = SPACES[name] || SPACES.outdoor;
      const next = (active + 1) % 2;
      let buf;
      try { buf = bufferFor(name); } catch { return unit; }
      slots[next].conv.buffer = buf;
      const t = actx.currentTime;
      slots[active].g.gain.cancelScheduledValues(t);
      slots[next].g.gain.cancelScheduledValues(t);
      slots[active].g.gain.setValueAtTime(slots[active].g.gain.value, t);
      slots[next].g.gain.setValueAtTime(slots[next].g.gain.value, t);
      slots[active].g.gain.linearRampToValueAtTime(0, t + fade);
      slots[next].g.gain.linearRampToValueAtTime(1, t + fade);
      wet.gain.cancelScheduledValues(t);
      wet.gain.setValueAtTime(wet.gain.value, t);
      wet.gain.linearRampToValueAtTime(preset.wet, t + fade);
      active = next;
      current = name;
      return unit;
    },
    setWet(v, fade = 0.4) {
      const t = actx.currentTime;
      wet.gain.cancelScheduledValues(t);
      wet.gain.setValueAtTime(wet.gain.value, t);
      wet.gain.linearRampToValueAtTime(Math.max(0, v), t + fade);
      return unit;
    },
    dispose() {
      try { input.disconnect(); hp.disconnect(); lp.disconnect(); wet.disconnect(); } catch {}
      for (const s of slots) { try { s.conv.disconnect(); s.g.disconnect(); } catch {} }
      cache.clear();
    },
  };

  return unit;
}
