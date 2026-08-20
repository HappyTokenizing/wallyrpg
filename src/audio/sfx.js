/* ============================================================
   sfx.js — the effect bank.

   Every sound here is synthesised on the spot from oscillators, noise
   bursts and filters. Nothing is sampled, nothing is loaded.

   Two kinds of thing live in this file:

     ONE-SHOTS   `play(name, { position, pitch, gain, delay, pan })`
                 Positional when given a world position — the voice is
                 routed through a PannerNode so a door slamming behind
                 Wally is behind him.

     BEDS        continuous ambience — wind, waves, rain, market chatter,
                 room tone, night. Each has a target level; `bed(name, v)`
                 cross-fades to it. The wind and wave beds additionally
                 read `ctx.wind.strength` every frame, so when the world
                 gusts, the soundtrack gusts with it.

   Public:
     SFX_NAMES, SURFACES, BED_NAMES
     createSfx({ actx, dest, reverb, rng }) -> bank
   ============================================================ */

export const SURFACES = ['grass', 'sand', 'wood', 'stone', 'water', 'dirt'];

/* ---------- helpers shared by every effect ---------- */

function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSfx({ actx, dest, reverb = null, rng = Math.random, seed = 0x5f11 } = {}) {
  const srng = mulberry(seed);
  const R = () => (rng ? rng() : srng());

  /* --- buses --- */
  const out = actx.createGain();
  out.gain.value = 1;
  out.connect(dest);

  const send = actx.createGain();       // one-shot reverb send
  send.gain.value = 0.16;
  if (reverb) send.connect(reverb.input ?? reverb);

  const ambOut = actx.createGain();     // beds sit on their own trim
  ambOut.gain.value = 1;
  ambOut.connect(dest);
  const ambSend = actx.createGain();
  ambSend.gain.value = 0.10;
  if (reverb) ambSend.connect(reverb.input ?? reverb);
  ambOut.connect(ambSend);

  /* --- voice bookkeeping (see music.js — same contract) --- */
  const live = [];
  function track(node, stopTime) {
    live.push({ node, stopTime });
    if (node && 'onended' in node) {
      node.onended = () => { try { node.disconnect(); } catch { /* gone */ } };
    }
  }
  function voiceCount() {
    const t = actx.currentTime;
    for (let i = live.length - 1; i >= 0; i--) if (live[i].stopTime <= t - 0.5) live.splice(i, 1);
    let n = 0;
    for (const v of live) if (v.stopTime > t) n++;
    return n;
  }

  /* --- noise --- */
  let noiseBuf = null;
  function noiseBuffer() {
    if (noiseBuf) return noiseBuf;
    const sr = actx.sampleRate || 44100;
    const len = Math.floor(sr * 2.5);
    noiseBuf = actx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = noiseBuf.getChannelData(c);
      const r = mulberry(0xa11ce + c * 977);
      // Slight pinking: a one-pole average tames the harsh top of white
      // noise, which is what makes synthesised wind sound like wind.
      let z = 0;
      for (let i = 0; i < len; i++) {
        const w = r() * 2 - 1;
        z = w * 0.32 + z * 0.68;
        d[i] = w * 0.55 + z * 0.9;
      }
    }
    return noiseBuf;
  }
  function noiseSource(when, dur, loop = false) {
    const s = actx.createBufferSource();
    s.buffer = noiseBuffer();
    s.loop = loop;
    if (loop) s.start(when);
    else s.start(when, (when * 3.77) % 2.0, Math.max(0.02, dur + 0.05));
    return s;
  }

  function filt(type, hz, q) {
    const f = actx.createBiquadFilter();
    f.type = type; f.frequency.value = hz; if (q != null) f.Q.value = q;
    return f;
  }

  /* A percussive gain envelope: instant attack, exponential fall. */
  function hit(when, dur, peak, dst, attack = 0.002) {
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + Math.max(attack + 0.01, dur));
    g.connect(dst);
    return g;
  }

  /* Noise burst through a filter — the backbone of footsteps, splashes,
     wind, cloth, wood and stone. */
  function burst(when, dur, peak, dst, { type = 'bandpass', hz = 1000, q = 1, sweep = null } = {}) {
    const n = noiseSource(when, dur);
    const f = filt(type, hz, q);
    if (sweep != null) {
      f.frequency.setValueAtTime(hz, when);
      f.frequency.exponentialRampToValueAtTime(Math.max(40, sweep), when + dur);
    }
    const g = hit(when, dur, peak, dst);
    n.connect(f); f.connect(g);
    n.stop(when + dur + 0.06);
    track(n, when + dur + 0.06);
    return g;
  }

  /* A single pitched voice with optional glide. */
  function tone(when, dur, peak, dst, {
    type = 'sine', hz = 440, to = null, curve = 'exp', detune = 0, attack = 0.004,
  } = {}) {
    const o = actx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(hz, when);
    o.detune.value = detune;
    if (to != null) {
      if (curve === 'lin') o.frequency.linearRampToValueAtTime(to, when + dur);
      else o.frequency.exponentialRampToValueAtTime(Math.max(1, to), when + dur);
    }
    const g = hit(when, dur, peak, dst, attack);
    o.connect(g);
    o.start(when); o.stop(when + dur + 0.06);
    track(o, when + dur + 0.06);
    return g;
  }

  /* An inharmonic struck-metal voice: bells, chimes, triangles. */
  function metal(when, dur, peak, dst, hz, partials = [1, 2.76, 5.4, 8.93]) {
    const g = hit(when, dur, peak, dst, 0.002);
    for (let i = 0; i < partials.length; i++) {
      const o = actx.createOscillator();
      o.type = 'sine'; o.frequency.value = hz * partials[i];
      const pg = actx.createGain();
      pg.gain.setValueAtTime(1 / (1 + i * 1.6), when);
      pg.gain.exponentialRampToValueAtTime(0.0001, when + dur * Math.pow(0.72, i));
      o.connect(pg); pg.connect(g);
      o.start(when); o.stop(when + dur + 0.06);
      if (i === 0) track(o, when + dur + 0.06);
    }
    return g;
  }

  /* ---------- footsteps ----------
     Each surface is a different *recipe*, not a different pitch. That is
     the whole point: grass is a soft broadband rustle, stone is a sharp
     click over a short body, wood is a resonant low knock, sand is dry
     and dull, water is a splash plus droplets. */
  const STEP = {
    grass(t, o, dst) {
      burst(t, 0.075 * o.len, 0.30 * o.g, dst, { type: 'bandpass', hz: 1900 * o.p, q: 0.7, sweep: 900 * o.p });
      burst(t + 0.004, 0.05, 0.12 * o.g, dst, { type: 'highpass', hz: 4200 * o.p, q: 0.6 });
      tone(t, 0.05, 0.05 * o.g, dst, { type: 'sine', hz: 120 * o.p, to: 70 * o.p });
    },
    dirt(t, o, dst) {
      burst(t, 0.07 * o.len, 0.28 * o.g, dst, { type: 'lowpass', hz: 1300 * o.p, q: 0.8 });
      tone(t, 0.06, 0.09 * o.g, dst, { type: 'sine', hz: 105 * o.p, to: 58 * o.p });
    },
    sand(t, o, dst) {
      burst(t, 0.11 * o.len, 0.26 * o.g, dst, { type: 'bandpass', hz: 2600 * o.p, q: 0.5, sweep: 1200 * o.p });
      burst(t + 0.02, 0.09, 0.14 * o.g, dst, { type: 'lowpass', hz: 900 * o.p, q: 0.6 });
    },
    wood(t, o, dst) {
      // Resonant plank: a short knock plus two lightly detuned body modes.
      burst(t, 0.035, 0.24 * o.g, dst, { type: 'bandpass', hz: 2400 * o.p, q: 1.4 });
      tone(t, 0.10, 0.16 * o.g, dst, { type: 'triangle', hz: 168 * o.p, to: 132 * o.p });
      tone(t + 0.003, 0.07, 0.07 * o.g, dst, { type: 'sine', hz: 430 * o.p, to: 380 * o.p });
    },
    stone(t, o, dst) {
      burst(t, 0.03, 0.30 * o.g, dst, { type: 'highpass', hz: 3400 * o.p, q: 0.7 });
      burst(t, 0.055, 0.18 * o.g, dst, { type: 'bandpass', hz: 1100 * o.p, q: 1.8 });
      tone(t, 0.045, 0.08 * o.g, dst, { type: 'sine', hz: 190 * o.p, to: 140 * o.p });
    },
    water(t, o, dst) {
      burst(t, 0.16 * o.len, 0.30 * o.g, dst, { type: 'bandpass', hz: 900 * o.p, q: 0.55, sweep: 2600 * o.p });
      tone(t, 0.09, 0.10 * o.g, dst, { type: 'sine', hz: 260 * o.p, to: 620 * o.p });
      // Droplets falling back.
      for (let i = 0; i < 3; i++) {
        const d = t + 0.06 + R() * 0.16;
        tone(d, 0.05, 0.045 * o.g, dst, { type: 'sine', hz: (900 + R() * 1400) * o.p, to: (1800 + R() * 1600) * o.p });
      }
    },
  };

  /* ---------- the bank ---------- */
  /* Each entry: (t, o, dst) where `o` is { g gain, p pitch, len, v variation }
     and `dst` is the already-panned destination gain. */
  const BANK = {
    /* --- locomotion --- */
    'step':        (t, o, d) => (STEP[o.surface] || STEP.grass)(t, o, d),
    'step.grass':  (t, o, d) => STEP.grass(t, o, d),
    'step.dirt':   (t, o, d) => STEP.dirt(t, o, d),
    'step.sand':   (t, o, d) => STEP.sand(t, o, d),
    'step.wood':   (t, o, d) => STEP.wood(t, o, d),
    'step.stone':  (t, o, d) => STEP.stone(t, o, d),
    'step.water':  (t, o, d) => STEP.water(t, o, d),

    'jump': (t, o, d) => {
      tone(t, 0.16, 0.16 * o.g, d, { type: 'triangle', hz: 200 * o.p, to: 470 * o.p });
      burst(t, 0.09, 0.10 * o.g, d, { type: 'highpass', hz: 2600, q: 0.6 });
    },
    'land': (t, o, d) => {
      tone(t, 0.13, 0.24 * o.g, d, { type: 'sine', hz: 150 * o.p, to: 62 * o.p });
      (STEP[o.surface] || STEP.grass)(t, { ...o, g: o.g * 0.8 }, d);
    },
    'land.heavy': (t, o, d) => {
      tone(t, 0.26, 0.34 * o.g, d, { type: 'sine', hz: 130 * o.p, to: 44 * o.p });
      burst(t, 0.18, 0.24 * o.g, d, { type: 'lowpass', hz: 620, q: 0.9, sweep: 180 });
      burst(t + 0.01, 0.07, 0.12 * o.g, d, { type: 'highpass', hz: 3000, q: 0.6 });
    },
    'slide': (t, o, d) => burst(t, 0.42 * o.len, 0.16 * o.g, d, { type: 'bandpass', hz: 2200 * o.p, q: 0.8, sweep: 700 }),
    'bump':  (t, o, d) => { tone(t, 0.09, 0.18 * o.g, d, { type: 'sine', hz: 170 * o.p, to: 90 * o.p }); burst(t, 0.05, 0.10 * o.g, d, { type: 'lowpass', hz: 1400 }); },
    'whoosh': (t, o, d) => burst(t, 0.34 * o.len, 0.20 * o.g, d, { type: 'bandpass', hz: 380 * o.p, q: 0.9, sweep: 2400 * o.p }),
    'swim':  (t, o, d) => { burst(t, 0.30, 0.16 * o.g, d, { type: 'lowpass', hz: 1100 * o.p, q: 0.7, sweep: 400 }); STEP.water(t + 0.05, { ...o, g: o.g * 0.5 }, d); },
    'splash': (t, o, d) => {
      burst(t, 0.34 * o.len, 0.34 * o.g, d, { type: 'bandpass', hz: 700 * o.p, q: 0.5, sweep: 3400 * o.p });
      tone(t, 0.14, 0.14 * o.g, d, { type: 'sine', hz: 200 * o.p, to: 760 * o.p });
      for (let i = 0; i < 6; i++) {
        tone(t + 0.08 + R() * 0.3, 0.06, 0.05 * o.g, d, { type: 'sine', hz: (800 + R() * 1600) * o.p, to: (2000 + R() * 2000) * o.p });
      }
    },
    'splash.small': (t, o, d) => { burst(t, 0.14, 0.20 * o.g, d, { type: 'bandpass', hz: 1200 * o.p, q: 0.6, sweep: 3000 }); tone(t, 0.07, 0.07 * o.g, d, { type: 'sine', hz: 420 * o.p, to: 1100 * o.p }); },
    'ripple': (t, o, d) => tone(t, 0.5, 0.06 * o.g, d, { type: 'sine', hz: 620 * o.p, to: 240 * o.p, attack: 0.02 }),

    /* --- Wally himself --- */
    /* Ear flap: a big soft membrane. Low-passed cloth swoosh with a
       little body thump when it slaps his cheek. */
    'ear.flap': (t, o, d) => {
      burst(t, 0.17 * o.len, 0.16 * o.g, d, { type: 'lowpass', hz: 1500 * o.p, q: 0.8, sweep: 380 * o.p });
      tone(t + 0.06, 0.08, 0.05 * o.g, d, { type: 'sine', hz: 145 * o.p, to: 92 * o.p });
    },
    'ear.flap.soft': (t, o, d) => burst(t, 0.22, 0.08 * o.g, d, { type: 'lowpass', hz: 900 * o.p, q: 0.7, sweep: 260 }),
    /* The trunk. Two detuned saws through a moving formant, so it is a
       genuine little elephant call and not a car horn. */
    'trunk': (t, o, d) => {
      const g = hit(t, 0.62, 0.20 * o.g, d, 0.05);
      const bp = filt('bandpass', 620 * o.p, 4);
      bp.frequency.setValueAtTime(480 * o.p, t);
      bp.frequency.linearRampToValueAtTime(1250 * o.p, t + 0.18);
      bp.frequency.linearRampToValueAtTime(700 * o.p, t + 0.6);
      bp.connect(g);
      for (let i = 0; i < 2; i++) {
        const osc = actx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(196 * o.p, t);
        osc.frequency.linearRampToValueAtTime(268 * o.p, t + 0.14);
        osc.frequency.linearRampToValueAtTime(212 * o.p, t + 0.58);
        osc.detune.value = i ? 9 : -9;
        const og = actx.createGain(); og.gain.value = 0.4;
        osc.connect(og); og.connect(bp);
        osc.start(t); osc.stop(t + 0.7);
        if (i === 0) track(osc, t + 0.7);
      }
      burst(t, 0.5, 0.05 * o.g, d, { type: 'bandpass', hz: 900, q: 1.1 });
    },
    'sniff': (t, o, d) => burst(t, 0.24, 0.12 * o.g, d, { type: 'bandpass', hz: 700 * o.p, q: 1.3, sweep: 2200 }),

    /* --- economy --- */
    'coin':  (t, o, d) => { metal(t, 0.45, 0.16 * o.g, d, 2100 * o.p, [1, 2.41, 3.9]); metal(t + 0.03, 0.30, 0.10 * o.g, d, 3150 * o.p, [1, 2.6]); },
    'coins': (t, o, d) => { for (let i = 0; i < 6; i++) metal(t + i * 0.045 + R() * 0.02, 0.35, 0.10 * o.g, d, (1800 + R() * 1500) * o.p, [1, 2.4, 4.1]); },
    'cash':  (t, o, d) => { for (let i = 0; i < 5; i++) burst(t + i * 0.055, 0.07, 0.10 * o.g, d, { type: 'bandpass', hz: 3200 + R() * 1800, q: 0.8, sweep: 1400 }); },
    'token': (t, o, d) => { const seq = [523, 659, 784, 1047, 1319]; seq.forEach((f, i) => metal(t + i * 0.06, 0.7 - i * 0.06, 0.13 * o.g, d, f * o.p, [1, 2.76, 5.4])); },
    'buy':   (t, o, d) => { tone(t, 0.10, 0.16 * o.g, d, { type: 'triangle', hz: 520 * o.p, to: 700 * o.p }); metal(t + 0.06, 0.4, 0.09 * o.g, d, 1400 * o.p); },
    'sell':  (t, o, d) => { tone(t, 0.11, 0.16 * o.g, d, { type: 'triangle', hz: 700 * o.p, to: 440 * o.p }); metal(t + 0.06, 0.4, 0.09 * o.g, d, 1050 * o.p); },
    'ledger': (t, o, d) => { burst(t, 0.09, 0.14 * o.g, d, { type: 'bandpass', hz: 2600, q: 0.7, sweep: 900 }); burst(t + 0.1, 0.07, 0.09 * o.g, d, { type: 'bandpass', hz: 2000, q: 0.7 }); },

    /* --- doors, chests, props --- */
    'door.open':  (t, o, d) => { tone(t, 0.42, 0.12 * o.g, d, { type: 'sawtooth', hz: 88 * o.p, to: 138 * o.p, attack: 0.03 }); burst(t, 0.4, 0.07 * o.g, d, { type: 'bandpass', hz: 520, q: 2.4, sweep: 1100 }); },
    'door.close': (t, o, d) => { tone(t, 0.20, 0.24 * o.g, d, { type: 'sine', hz: 150 * o.p, to: 58 * o.p }); burst(t, 0.09, 0.16 * o.g, d, { type: 'lowpass', hz: 900, q: 1.1 }); metal(t + 0.02, 0.16, 0.05 * o.g, d, 1900 * o.p, [1, 2.2]); },
    'door.wood':  (t, o, d) => { tone(t, 0.16, 0.20 * o.g, d, { type: 'triangle', hz: 175 * o.p, to: 110 * o.p }); burst(t, 0.06, 0.12 * o.g, d, { type: 'bandpass', hz: 2100, q: 1.2 }); },
    'gate.iron':  (t, o, d) => { metal(t, 1.4, 0.14 * o.g, d, 320 * o.p, [1, 1.87, 3.11, 4.9]); burst(t, 0.5, 0.08 * o.g, d, { type: 'bandpass', hz: 1500, q: 3, sweep: 700 }); },
    'chest.open': (t, o, d) => { burst(t, 0.12, 0.14 * o.g, d, { type: 'bandpass', hz: 1800, q: 1.4, sweep: 700 }); metal(t + 0.08, 0.9, 0.11 * o.g, d, 880 * o.p, [1, 2.4, 4.2]); tone(t + 0.1, 0.3, 0.09 * o.g, d, { type: 'triangle', hz: 200 * o.p, to: 330 * o.p }); },
    'latch':      (t, o, d) => { burst(t, 0.04, 0.16 * o.g, d, { type: 'highpass', hz: 3000, q: 0.8 }); metal(t, 0.18, 0.08 * o.g, d, 2600 * o.p, [1, 2.1]); },
    'crate':      (t, o, d) => { tone(t, 0.14, 0.20 * o.g, d, { type: 'triangle', hz: 130 * o.p, to: 78 * o.p }); burst(t, 0.09, 0.14 * o.g, d, { type: 'bandpass', hz: 1500, q: 1.1, sweep: 600 }); },
    'rope':       (t, o, d) => burst(t, 0.3 * o.len, 0.11 * o.g, d, { type: 'bandpass', hz: 1600 * o.p, q: 2.2, sweep: 800 }),
    'sail.flap':  (t, o, d) => { for (let i = 0; i < 3; i++) burst(t + i * 0.11 + R() * 0.04, 0.14, 0.15 * o.g, d, { type: 'lowpass', hz: 1400 * o.p, q: 0.7, sweep: 400 }); },
    'boat.creak': (t, o, d) => { const g = hit(t, 0.9, 0.10 * o.g, d, 0.12); const bp = filt('bandpass', 420 * o.p, 9); bp.connect(g); const osc = actx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.setValueAtTime(58 * o.p, t); osc.frequency.linearRampToValueAtTime(74 * o.p, t + 0.5); osc.frequency.linearRampToValueAtTime(61 * o.p, t + 0.9); osc.connect(bp); osc.start(t); osc.stop(t + 0.95); track(osc, t + 0.95); },
    'anchor':     (t, o, d) => { metal(t, 1.8, 0.16 * o.g, d, 190 * o.p, [1, 1.72, 2.94, 4.6]); burst(t, 0.3, 0.10 * o.g, d, { type: 'lowpass', hz: 500, sweep: 150 }); },
    'cart':       (t, o, d) => { for (let i = 0; i < 8; i++) burst(t + i * 0.09, 0.07, 0.07 * o.g, d, { type: 'bandpass', hz: 900 + R() * 700, q: 1.6 }); },

    /* --- bells, clocks, signals --- */
    'bell.small': (t, o, d) => metal(t, 1.5, 0.14 * o.g, d, 1480 * o.p),
    'bell.big':   (t, o, d) => { metal(t, 4.5, 0.20 * o.g, d, 262 * o.p, [1, 2.0, 2.98, 4.15, 5.43]); tone(t, 0.4, 0.06 * o.g, d, { type: 'sine', hz: 131 * o.p, to: 128 * o.p, attack: 0.01 }); },
    'chime':      (t, o, d) => { [1319, 1568, 2093].forEach((f, i) => metal(t + i * 0.08, 1.6 - i * 0.2, 0.10 * o.g, d, f * o.p)); },
    'clock.chime': (t, o, d) => { [0, 1, 2, 3].forEach(i => metal(t + i * 0.55, 3.2, 0.13 * o.g, d, [523, 392, 440, 330][i] * o.p, [1, 2.01, 3.02, 4.3])); },
    'train.horn': (t, o, d) => { [110, 138.6, 165].forEach(f => tone(t, 1.5, 0.09 * o.g, d, { type: 'sawtooth', hz: f * o.p, to: f * o.p * 0.97, attack: 0.14 })); },
    'whistle':    (t, o, d) => { tone(t, 0.5, 0.10 * o.g, d, { type: 'sine', hz: 1900 * o.p, to: 2350 * o.p, attack: 0.03 }); burst(t, 0.5, 0.05 * o.g, d, { type: 'bandpass', hz: 2100, q: 8 }); },

    /* --- nature --- */
    /* A gull is two rising cries with a rasp on the front. */
    'gull': (t, o, d) => {
      for (let i = 0; i < 2; i++) {
        const s = t + i * 0.24;
        const f = (1250 + R() * 340) * o.p;
        tone(s, 0.20, 0.11 * o.g, d, { type: 'sawtooth', hz: f * 0.72, to: f, attack: 0.02 });
        burst(s, 0.10, 0.05 * o.g, d, { type: 'bandpass', hz: f * 1.6, q: 4 });
      }
    },
    'bird': (t, o, d) => { const n = 2 + Math.floor(R() * 3); for (let i = 0; i < n; i++) { const f = (2600 + R() * 1500) * o.p; tone(t + i * 0.09, 0.06, 0.07 * o.g, d, { type: 'sine', hz: f, to: f * (0.7 + R() * 0.9) }); } },
    'crow':  (t, o, d) => { for (let i = 0; i < 3; i++) burst(t + i * 0.17, 0.13, 0.10 * o.g, d, { type: 'bandpass', hz: (700 + R() * 200) * o.p, q: 5, sweep: 420 }); },
    'cricket': (t, o, d) => { for (let i = 0; i < 5; i++) burst(t + i * 0.035, 0.018, 0.055 * o.g, d, { type: 'bandpass', hz: 4600 * o.p, q: 22 }); },
    'frog':  (t, o, d) => { for (let i = 0; i < 3; i++) tone(t + i * 0.12, 0.09, 0.09 * o.g, d, { type: 'sawtooth', hz: 210 * o.p, to: 160 * o.p }); },
    'wave':  (t, o, d) => { burst(t, 1.5 * o.len, 0.16 * o.g, d, { type: 'lowpass', hz: 480, q: 0.5, sweep: 2200 }); burst(t + 0.5, 1.4, 0.12 * o.g, d, { type: 'highpass', hz: 1400, q: 0.4 }); },
    'thunder': (t, o, d) => { burst(t, 2.6, 0.30 * o.g, d, { type: 'lowpass', hz: 260, q: 0.6, sweep: 60 }); burst(t + 0.1, 1.8, 0.12 * o.g, d, { type: 'bandpass', hz: 700, q: 0.5, sweep: 180 }); },
    'rain.drop': (t, o, d) => tone(t, 0.05, 0.05 * o.g, d, { type: 'sine', hz: (1400 + R() * 2200) * o.p, to: (2600 + R() * 2600) * o.p }),
    'leaf':  (t, o, d) => burst(t, 0.2, 0.07 * o.g, d, { type: 'highpass', hz: 3600 * o.p, q: 0.6 }),
    'gust':  (t, o, d) => burst(t, 1.9 * o.len, 0.13 * o.g, d, { type: 'bandpass', hz: 500 * o.p, q: 1.4, sweep: 1500 }),

    /* --- UI --- */
    'ui.click':  (t, o, d) => { tone(t, 0.03, 0.14 * o.g, d, { type: 'sine', hz: 1200 * o.p, to: 900 * o.p }); burst(t, 0.02, 0.06 * o.g, d, { type: 'highpass', hz: 5000 }); },
    'ui.select': (t, o, d) => { tone(t, 0.07, 0.13 * o.g, d, { type: 'triangle', hz: 880 * o.p }); tone(t + 0.05, 0.10, 0.10 * o.g, d, { type: 'triangle', hz: 1320 * o.p }); },
    'ui.back':   (t, o, d) => { tone(t, 0.07, 0.12 * o.g, d, { type: 'triangle', hz: 700 * o.p }); tone(t + 0.05, 0.10, 0.09 * o.g, d, { type: 'triangle', hz: 466 * o.p }); },
    'ui.open':   (t, o, d) => { tone(t, 0.16, 0.11 * o.g, d, { type: 'sine', hz: 420 * o.p, to: 900 * o.p }); burst(t, 0.12, 0.06 * o.g, d, { type: 'bandpass', hz: 2200, q: 0.8, sweep: 4200 }); },
    'ui.close':  (t, o, d) => { tone(t, 0.14, 0.11 * o.g, d, { type: 'sine', hz: 900 * o.p, to: 380 * o.p }); burst(t, 0.10, 0.05 * o.g, d, { type: 'bandpass', hz: 3600, q: 0.8, sweep: 1400 }); },
    'ui.tab':    (t, o, d) => tone(t, 0.05, 0.10 * o.g, d, { type: 'sine', hz: 1000 * o.p, to: 1250 * o.p }),
    'ui.error':  (t, o, d) => { tone(t, 0.16, 0.14 * o.g, d, { type: 'sawtooth', hz: 240 * o.p, to: 150 * o.p }); tone(t + 0.02, 0.14, 0.07 * o.g, d, { type: 'square', hz: 180 * o.p, to: 120 * o.p }); },
    'ui.toast':  (t, o, d) => { metal(t, 0.6, 0.09 * o.g, d, 1760 * o.p); metal(t + 0.07, 0.5, 0.06 * o.g, d, 2640 * o.p); },
    'ui.type':   (t, o, d) => burst(t, 0.018, 0.07 * o.g, d, { type: 'bandpass', hz: 2800 * o.p, q: 1.6 }),

    /* --- dialogue --- */
    'talk.blip': (t, o, d) => tone(t, 0.055, 0.07 * o.g, d, { type: 'triangle', hz: 620 * o.p, to: 700 * o.p }),
    'talk.low':  (t, o, d) => tone(t, 0.07, 0.07 * o.g, d, { type: 'triangle', hz: 330 * o.p, to: 300 * o.p }),
    'talk.high': (t, o, d) => tone(t, 0.05, 0.06 * o.g, d, { type: 'triangle', hz: 980 * o.p, to: 1100 * o.p }),
    'talk.end':  (t, o, d) => { tone(t, 0.08, 0.08 * o.g, d, { type: 'triangle', hz: 700 * o.p }); tone(t + 0.06, 0.12, 0.06 * o.g, d, { type: 'triangle', hz: 950 * o.p }); },

    /* --- rewards & states --- */
    'levelup':  (t, o, d) => { [392, 523, 659, 784, 1047].forEach((f, i) => metal(t + i * 0.085, 1.2, 0.12 * o.g, d, f * o.p, [1, 2.76, 5.4])); },
    'quest.start': (t, o, d) => { [523, 698, 880].forEach((f, i) => metal(t + i * 0.1, 1.1, 0.11 * o.g, d, f * o.p)); },
    'quest.done':  (t, o, d) => { [659, 880, 1047, 1319].forEach((f, i) => metal(t + i * 0.09, 1.5, 0.12 * o.g, d, f * o.p)); },
    'unlock':   (t, o, d) => { burst(t, 0.06, 0.12 * o.g, d, { type: 'bandpass', hz: 2400, q: 2, sweep: 900 }); [784, 1047].forEach((f, i) => metal(t + 0.08 + i * 0.09, 1.2, 0.11 * o.g, d, f * o.p)); },
    'discover': (t, o, d) => { [880, 1175, 1568].forEach((f, i) => metal(t + i * 0.11, 1.8, 0.11 * o.g, d, f * o.p, [1, 2.76, 5.4, 8.9])); },
    'fanfare':  (t, o, d) => { [523, 659, 784, 1047].forEach((f, i) => tone(t + i * 0.11, 0.5, 0.11 * o.g, d, { type: 'sawtooth', hz: f * o.p, attack: 0.02 })); },
    'heart':    (t, o, d) => { tone(t, 0.12, 0.10 * o.g, d, { type: 'sine', hz: 660 * o.p, to: 880 * o.p }); tone(t + 0.1, 0.22, 0.08 * o.g, d, { type: 'sine', hz: 990 * o.p }); },
    'fail':     (t, o, d) => { [440, 349, 262].forEach((f, i) => tone(t + i * 0.13, 0.34, 0.11 * o.g, d, { type: 'sawtooth', hz: f * o.p, attack: 0.02 })); },
    'sparkle':  (t, o, d) => { for (let i = 0; i < 7; i++) metal(t + i * 0.04 + R() * 0.03, 0.5, 0.05 * o.g, d, (1600 + R() * 2600) * o.p, [1, 2.76]); },
    'magic':    (t, o, d) => { burst(t, 0.7, 0.10 * o.g, d, { type: 'bandpass', hz: 700, q: 3, sweep: 5200 }); for (let i = 0; i < 5; i++) metal(t + i * 0.07, 0.9, 0.06 * o.g, d, (1046 * Math.pow(2, i / 5)) * o.p, [1, 2.76, 5.4]); },
    'pop':      (t, o, d) => { tone(t, 0.05, 0.14 * o.g, d, { type: 'sine', hz: 380 * o.p, to: 1500 * o.p }); burst(t, 0.03, 0.06 * o.g, d, { type: 'highpass', hz: 3000 }); },
    'hit':      (t, o, d) => { tone(t, 0.08, 0.20 * o.g, d, { type: 'square', hz: 340 * o.p, to: 520 * o.p }); burst(t, 0.06, 0.14 * o.g, d, { type: 'bandpass', hz: 1600, q: 0.8, sweep: 500 }); },
    'break':    (t, o, d) => { burst(t, 0.28, 0.22 * o.g, d, { type: 'bandpass', hz: 2200, q: 0.5, sweep: 600 }); for (let i = 0; i < 5; i++) burst(t + R() * 0.2, 0.06, 0.09 * o.g, d, { type: 'bandpass', hz: 1200 + R() * 2600, q: 2 }); },
    'camera':   (t, o, d) => { burst(t, 0.03, 0.16 * o.g, d, { type: 'bandpass', hz: 2400, q: 1.2 }); burst(t + 0.06, 0.04, 0.12 * o.g, d, { type: 'bandpass', hz: 1600, q: 1.2 }); },

    /* --- market colour --- */
    /* A hawker's shout: formant-filtered noise + a pitched vowel, short,
       and deliberately unintelligible. Fired sparsely over the chatter
       bed so the square feels populated rather than looped. */
    'market.hawk': (t, o, d) => {
      const base = (150 + R() * 130) * o.p;
      const g = hit(t, 0.42, 0.10 * o.g, d, 0.04);
      const forms = R() < 0.5 ? [[730, 1090, 2440]] : [[570, 840, 2410]];
      for (const hz of forms[0]) {
        const bp = filt('bandpass', hz, 8);
        bp.connect(g);
        const osc = actx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(base, t);
        osc.frequency.linearRampToValueAtTime(base * (1.1 + R() * 0.3), t + 0.18);
        osc.frequency.linearRampToValueAtTime(base * 0.9, t + 0.4);
        const og = actx.createGain(); og.gain.value = 0.3;
        osc.connect(og); og.connect(bp);
        osc.start(t); osc.stop(t + 0.45);
        if (hz === forms[0][0]) track(osc, t + 0.45);
      }
    },
    'market.laugh': (t, o, d) => { for (let i = 0; i < 4; i++) tone(t + i * 0.11, 0.09, 0.07 * o.g, d, { type: 'sawtooth', hz: (300 - i * 22) * o.p, to: (250 - i * 20) * o.p }); },
    'crowd.murmur': (t, o, d) => burst(t, 1.2, 0.07 * o.g, d, { type: 'bandpass', hz: 620, q: 1.1, sweep: 900 }),
  };

  const NAMES = Object.keys(BANK);

  /* ---------- routing ---------- */
  const usePanner = typeof actx.createPanner === 'function';
  function route(o) {
    // Positional voices go through a PannerNode; everything else through
    // a cheap stereo pan. Both land on the same one-shot bus.
    const g = actx.createGain();
    g.gain.value = 1;
    if (o.position && usePanner) {
      const p = actx.createPanner();
      p.panningModel = o.hrtf ? 'HRTF' : 'equalpower';
      p.distanceModel = 'inverse';
      p.refDistance = o.refDistance ?? 4;
      p.maxDistance = o.maxDistance ?? 140;
      p.rolloffFactor = o.rolloff ?? 1.15;
      const [x, y, z] = o.position;
      if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; }
      else p.setPosition(x, y, z);
      g.connect(p); p.connect(out); p.connect(send);
    } else if (actx.createStereoPanner) {
      const sp = actx.createStereoPanner();
      sp.pan.value = Math.max(-1, Math.min(1, o.pan ?? 0));
      g.connect(sp); sp.connect(out); sp.connect(send);
    } else {
      g.connect(out); g.connect(send);
    }
    return g;
  }

  function vec3(p) {
    if (!p) return null;
    if (Array.isArray(p)) return [p[0] || 0, p[1] || 0, p[2] || 0];
    if (typeof p === 'object') return [p.x || 0, p.y || 0, p.z || 0];
    return null;
  }

  let surface = 'grass';

  /**
   * Fire a one-shot. Unknown names are a no-op that returns false, so a
   * typo in another subsystem can never take the game down.
   */
  function play(name, opts = {}) {
    const fn = BANK[name];
    if (!fn) return false;
    const t = actx.currentTime + (opts.delay || 0) + 0.005;
    const o = {
      g: opts.gain ?? 1,
      // A little natural pitch scatter so repeated footsteps never twin.
      p: (opts.pitch ?? 1) * (1 + (R() - 0.5) * (opts.vary ?? 0.06)),
      len: opts.length ?? 1,
      pan: opts.pan ?? 0,
      surface: opts.surface || surface,
      position: vec3(opts.position),
      hrtf: opts.hrtf ?? false,
      refDistance: opts.refDistance, maxDistance: opts.maxDistance, rolloff: opts.rolloff,
    };
    const d = route(o);
    fn(t, o, d);
    return true;
  }

  /* ---------- ambience beds ---------- */
  /* A bed is built once, on first request, and then lives for the session
     with its level cross-faded. Starting and stopping buffer sources on
     every zone change is what makes cheap ambience click. */

  const beds = {};

  /* Two gains per bed, deliberately: `gain` is the *level* the context
     asked for and is only ever cross-faded, while `mod` is the per-frame
     modulation the wind field drives. Sharing one AudioParam between a
     scheduled ramp and a continuous setTargetAtTime is a fight neither
     side wins — the level jumps whenever a zone change overlaps a gust. */
  function bedGain(name, initial = 0) {
    const g = actx.createGain();
    g.gain.value = initial;
    const mod = actx.createGain();
    mod.gain.value = 1;
    g.connect(mod); mod.connect(ambOut);
    beds[name] = { gain: g, mod, level: initial, target: initial, nodes: [] };
    return beds[name];
  }

  function loopNoise(b, chain) {
    const s = noiseSource(actx.currentTime + 0.02, 0, true);
    s.connect(chain);
    b.nodes.push(s);
    return s;
  }

  const BED_BUILD = {
    /* Wind: a broad low rush whose cutoff and level follow the global wind
       field, plus a resonant whistle that only appears in gusts. */
    wind(b) {
      const lp = filt('lowpass', 420, 0.7);
      const hp = filt('highpass', 90, 0.5);
      const g = actx.createGain(); g.gain.value = 0.55;
      hp.connect(lp); lp.connect(g); g.connect(b.gain);
      loopNoise(b, hp);

      const wq = filt('bandpass', 900, 6);
      const wg = actx.createGain(); wg.gain.value = 0;
      hp.connect(wq); wq.connect(wg); wg.connect(b.gain);
      b.ctrl = { lp, whistle: wg, wq };
    },
    /* Surf: a slow band of low noise plus scheduled breakers. */
    waves(b) {
      const lp = filt('lowpass', 700, 0.6);
      const g = actx.createGain(); g.gain.value = 0.5;
      lp.connect(g); g.connect(b.gain);
      loopNoise(b, lp);
      // Two out-of-phase LFOs give a swell that never obviously repeats.
      const lfoSum = actx.createGain(); lfoSum.gain.value = 1;
      for (const [hz, amt] of [[0.077, 0.30], [0.113, 0.18]]) {
        const l = actx.createOscillator();
        l.type = 'sine'; l.frequency.value = hz;
        const la = actx.createGain(); la.gain.value = amt;
        l.connect(la); la.connect(g.gain);
        l.start(); b.nodes.push(l);
      }
      b.ctrl = { lp, body: g, breakTimer: 2 };
    },
    rain(b) {
      const bp = filt('bandpass', 1500, 0.5);
      const hp = filt('highpass', 3800, 0.6);
      const g1 = actx.createGain(); g1.gain.value = 0.42;
      const g2 = actx.createGain(); g2.gain.value = 0.20;
      bp.connect(g1); g1.connect(b.gain);
      hp.connect(g2); g2.connect(b.gain);
      const src = loopNoise(b, bp);
      src.connect(hp);
      b.ctrl = { bp, dropTimer: 0.4 };
    },
    /* Market chatter: babble is band-passed noise with a wandering centre
       frequency; the individual shouts are fired by update(). */
    market(b) {
      const bp = filt('bandpass', 520, 1.4);
      const lp = filt('lowpass', 2600, 0.6);
      const g = actx.createGain(); g.gain.value = 0.34;
      bp.connect(lp); lp.connect(g); g.connect(b.gain);
      loopNoise(b, bp);
      const l = actx.createOscillator();
      l.type = 'sine'; l.frequency.value = 0.23;
      const la = actx.createGain(); la.gain.value = 180;
      l.connect(la); la.connect(bp.frequency);
      l.start(); b.nodes.push(l);
      b.ctrl = { bp, hawkTimer: 1.5 };
    },
    crowd(b) {
      const bp = filt('bandpass', 400, 1.0);
      const g = actx.createGain(); g.gain.value = 0.30;
      bp.connect(g); g.connect(b.gain);
      loopNoise(b, bp);
      b.ctrl = {};
    },
    /* Night: a low bed plus a cricket field built from update(). */
    night(b) {
      const lp = filt('lowpass', 320, 0.6);
      const g = actx.createGain(); g.gain.value = 0.30;
      lp.connect(g); g.connect(b.gain);
      loopNoise(b, lp);
      b.ctrl = { chirpTimer: 0.5 };
    },
    /* Room tone: almost nothing, which is exactly the point — the ear
       notices the absence of it more than the presence. */
    room(b) {
      const lp = filt('lowpass', 240, 0.5);
      const g = actx.createGain(); g.gain.value = 0.12;
      lp.connect(g); g.connect(b.gain);
      loopNoise(b, lp);
      const hum = actx.createOscillator();
      hum.type = 'sine'; hum.frequency.value = 50;
      const hg = actx.createGain(); hg.gain.value = 0.012;
      hum.connect(hg); hg.connect(b.gain);
      hum.start(); b.nodes.push(hum);
      b.ctrl = {};
    },
    /* Sparse birdsong for green zones — emitters only, no bed noise. */
    forest(b) {
      const lp = filt('lowpass', 900, 0.6);
      const g = actx.createGain(); g.gain.value = 0.16;
      lp.connect(g); g.connect(b.gain);
      loopNoise(b, lp);
      b.ctrl = { birdTimer: 1.2 };
    },
    /* Gulls over the water. Emitter-only. */
    gulls(b) { b.ctrl = { gullTimer: 2.5 }; },
    /* Deep drone for the mine. */
    cave(b) {
      const lp = filt('lowpass', 160, 0.7);
      const g = actx.createGain(); g.gain.value = 0.28;
      lp.connect(g); g.connect(b.gain);
      loopNoise(b, lp);
      const d = actx.createOscillator();
      d.type = 'sine'; d.frequency.value = 41;
      const dg = actx.createGain(); dg.gain.value = 0.05;
      d.connect(dg); dg.connect(b.gain);
      d.start(); b.nodes.push(d);
      b.ctrl = { dripTimer: 3 };
    },
  };

  const BEDS = Object.keys(BED_BUILD);

  function ensureBed(name) {
    if (beds[name]) return beds[name];
    if (!BED_BUILD[name]) return null;
    const b = bedGain(name, 0);
    try { BED_BUILD[name](b); } catch { /* offline contexts lack some nodes */ }
    return b;
  }

  /** Cross-fade a bed to `level` (0..1). Building is lazy. */
  function bed(name, level, fade = 2.0) {
    const b = ensureBed(name);
    if (!b) return false;
    b.target = Math.max(0, level);
    const t = actx.currentTime;
    b.gain.gain.cancelScheduledValues(t);
    b.gain.gain.setValueAtTime(b.gain.gain.value, t);
    b.gain.gain.linearRampToValueAtTime(b.target, t + Math.max(0.02, fade));
    b.level = b.target;
    return true;
  }

  /** Set the whole ambience mix at once; anything omitted fades out. */
  function ambience(mix, fade = 2.5) {
    for (const n of BEDS) bed(n, mix[n] ?? 0, fade);
  }

  /* ---------- per-frame ---------- */
  let windStrength = 0.4;
  let listenerPos = [0, 0, 0];

  function update(dt, env = {}) {
    if (env.wind != null) windStrength = env.wind;
    if (env.listener) listenerPos = env.listener;

    /* Wind bed follows the global field: louder, brighter and whistlier
       in a gust. This is the audio half of ART_DIRECTION §2.3. */
    const wb = beds.wind;
    if (wb && wb.ctrl && wb.target > 0) {
      const w = Math.max(0, Math.min(1.4, windStrength));
      const t = actx.currentTime;
      const cut = 260 + w * 900;
      wb.ctrl.lp.frequency.setTargetAtTime(cut, t, 0.35);
      wb.ctrl.whistle.gain.setTargetAtTime(Math.max(0, (w - 0.45)) * 0.42, t, 0.5);
      wb.ctrl.wq.frequency.setTargetAtTime(700 + w * 900, t, 0.6);
      wb.mod.gain.setTargetAtTime(0.45 + w * 0.75, t, 0.6);
    }

    /* Surf rate and brightness ride the wind too. */
    const wv = beds.waves;
    if (wv && wv.ctrl && wv.target > 0) {
      const w = Math.max(0, Math.min(1.4, windStrength));
      wv.ctrl.lp.frequency.setTargetAtTime(480 + w * 900, actx.currentTime, 0.6);
      wv.ctrl.breakTimer -= dt * (0.6 + w);
      if (wv.ctrl.breakTimer <= 0) {
        wv.ctrl.breakTimer = 2.6 + R() * 5.5;
        play('wave', { gain: (0.5 + w * 0.7) * wv.target, pan: R() * 1.6 - 0.8, length: 0.8 + R() * 0.8 });
      }
    }

    const rn = beds.rain;
    if (rn && rn.ctrl && rn.target > 0) {
      rn.ctrl.dropTimer -= dt;
      if (rn.ctrl.dropTimer <= 0) {
        rn.ctrl.dropTimer = 0.10 + R() * 0.24;
        play('rain.drop', { gain: 0.5 * rn.target, pan: R() * 1.8 - 0.9 });
      }
    }

    const mk = beds.market;
    if (mk && mk.ctrl && mk.target > 0) {
      mk.ctrl.hawkTimer -= dt;
      if (mk.ctrl.hawkTimer <= 0) {
        mk.ctrl.hawkTimer = 1.6 + R() * 4.2;
        play(R() < 0.22 ? 'market.laugh' : 'market.hawk', {
          gain: (0.5 + R() * 0.5) * mk.target, pan: R() * 1.7 - 0.85, pitch: 0.85 + R() * 0.4,
        });
      }
    }

    const nt = beds.night;
    if (nt && nt.ctrl && nt.target > 0) {
      nt.ctrl.chirpTimer -= dt;
      if (nt.ctrl.chirpTimer <= 0) {
        nt.ctrl.chirpTimer = 0.35 + R() * 1.1;
        play('cricket', { gain: (0.35 + R() * 0.5) * nt.target, pan: R() * 1.9 - 0.95, pitch: 0.9 + R() * 0.25 });
      }
    }

    const gl = beds.gulls;
    if (gl && gl.ctrl && gl.target > 0) {
      gl.ctrl.gullTimer -= dt;
      if (gl.ctrl.gullTimer <= 0) {
        gl.ctrl.gullTimer = 4 + R() * 11;
        play('gull', { gain: (0.5 + R() * 0.5) * gl.target, pan: R() * 1.8 - 0.9, pitch: 0.85 + R() * 0.4 });
      }
    }

    const fo = beds.forest;
    if (fo && fo.ctrl && fo.target > 0) {
      fo.ctrl.birdTimer -= dt;
      if (fo.ctrl.birdTimer <= 0) {
        fo.ctrl.birdTimer = 1.4 + R() * 5;
        play('bird', { gain: (0.4 + R() * 0.5) * fo.target, pan: R() * 1.8 - 0.9, pitch: 0.85 + R() * 0.4 });
      }
    }

    const cv = beds.cave;
    if (cv && cv.ctrl && cv.target > 0) {
      cv.ctrl.dripTimer -= dt;
      if (cv.ctrl.dripTimer <= 0) {
        cv.ctrl.dripTimer = 2.2 + R() * 7;
        play('splash.small', { gain: 0.35 * cv.target, pan: R() * 1.6 - 0.8, pitch: 1.4 + R() * 0.7 });
      }
    }
  }

  /* ---------- public ---------- */
  const bank = {
    out, ambOut,
    names: NAMES,
    beds: BEDS,
    surfaces: SURFACES,
    get voices() { return voiceCount(); },
    get surface() { return surface; },
    has(name) { return !!BANK[name]; },
    setSurface(s) { if (SURFACES.includes(s)) surface = s; return bank; },
    setSendLevel(v) { send.gain.value = Math.max(0, v); return bank; },
    play,
    bed,
    ambience,
    bedLevel(name) { return beds[name]?.target ?? 0; },
    update,
    /** Silence every bed. One-shots are left to ring out naturally. */
    stopBeds(fade = 0.6) { for (const n of Object.keys(beds)) bed(n, 0, fade); },
    dispose() {
      for (const n of Object.keys(beds)) {
        for (const node of beds[n].nodes) { try { node.stop(); } catch {} try { node.disconnect(); } catch {} }
        try { beds[n].gain.disconnect(); beds[n].mod.disconnect(); } catch {}
        delete beds[n];
      }
      try { out.disconnect(); send.disconnect(); ambOut.disconnect(); ambSend.disconnect(); } catch {}
      live.length = 0;
    },
  };

  return bank;
}

/* The canonical name list, exported for tooling and for the audio
   module's own self-test. Kept in sync with BANK by test-audio.mjs. */
export const SFX_NAMES = [
  'step', 'step.grass', 'step.dirt', 'step.sand', 'step.wood', 'step.stone', 'step.water',
  'jump', 'land', 'land.heavy', 'slide', 'bump', 'whoosh', 'swim', 'splash', 'splash.small', 'ripple',
  'ear.flap', 'ear.flap.soft', 'trunk', 'sniff',
  'coin', 'coins', 'cash', 'token', 'buy', 'sell', 'ledger',
  'door.open', 'door.close', 'door.wood', 'gate.iron', 'chest.open', 'latch', 'crate',
  'rope', 'sail.flap', 'boat.creak', 'anchor', 'cart',
  'bell.small', 'bell.big', 'chime', 'clock.chime', 'train.horn', 'whistle',
  'gull', 'bird', 'crow', 'cricket', 'frog', 'wave', 'thunder', 'rain.drop', 'leaf', 'gust',
  'ui.click', 'ui.select', 'ui.back', 'ui.open', 'ui.close', 'ui.tab', 'ui.error', 'ui.toast', 'ui.type',
  'talk.blip', 'talk.low', 'talk.high', 'talk.end',
  'levelup', 'quest.start', 'quest.done', 'unlock', 'discover', 'fanfare', 'heart', 'fail',
  'sparkle', 'magic', 'pop', 'hit', 'break', 'camera',
  'market.hawk', 'market.laugh', 'crowd.murmur',
];

export const BED_NAMES = [
  'wind', 'waves', 'rain', 'market', 'crowd', 'night', 'room', 'forest', 'gulls', 'cave',
];
