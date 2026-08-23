/* ============================================================
   music.js — the adaptive score.

   The original game had eight scales, one oscillator playing a six-note
   loop, and a pad. This is a different animal:

     * six simultaneous LAYERS (bass, pad, arp, lead, perc, air) whose
       gains are a function of game context, not a track selector. Moving
       from `explore` to `market` does not switch songs — it fades the
       flute out, the marimba and shaker up, and re-harmonises.
     * a real harmonic model: seventh, ninth and thirteenth voicings on a
       per-zone progression, with voice-leading between chords so the
       inner parts move by a semitone or two instead of jumping.
     * a melody that is *composed*: 4-bar phrases built from a motif that
       is transposed, inverted and rested, so it develops rather than
       loops. Strong beats snap to chord tones; whole bars are silence.
     * instruments synthesised properly — additive harp and glass, FM
       marimba, detuned-ensemble strings, breath-noise flute, filtered
       saw horn — each with its own ADSR, detune and stereo placement.
     * a musical transition system: a context change is *queued* and
       committed on the next bar line, then cross-faded. Nothing ever
       cuts mid-note.

   Public:
     SCORES                                  the per-context score table
     createMusic({ actx, dest, reverb, rng }) -> engine
   ============================================================ */

/* ---------- theory ---------- */

const SCALES = {
  major:      [0, 2, 4, 5, 7, 9, 11],
  lydian:     [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  dorian:     [0, 2, 3, 5, 7, 9, 10],
  aeolian:    [0, 2, 3, 5, 7, 8, 10],
};

/* Chord shapes as semitones above the chord root. Nothing here is a bare
   triad — the whole point is the colour of the 7th and 9th. */
export const CHORDS = {
  maj7:  [0, 4, 7, 11],
  maj9:  [0, 4, 7, 11, 14],
  maj13: [0, 4, 7, 11, 14, 21],
  six9:  [0, 4, 7, 9, 14],
  add9:  [0, 4, 7, 14],
  min7:  [0, 3, 7, 10],
  min9:  [0, 3, 7, 10, 14],
  min11: [0, 3, 7, 10, 17],
  dom7:  [0, 4, 7, 10],
  dom9:  [0, 4, 7, 10, 14],
  dom13: [0, 4, 7, 10, 14, 21],
  sus9:  [0, 5, 7, 10, 14],
  m7b5:  [0, 3, 6, 10],
  minmaj:[0, 3, 7, 11],
};

const A4 = 69;
export const mtof = (m) => 440 * Math.pow(2, (m - A4) / 12);

/** Scale degree -> semitones, wrapping octaves for degrees outside 0..6. */
function degToSemi(scale, deg) {
  const n = scale.length;
  const oct = Math.floor(deg / n);
  const i = ((deg % n) + n) % n;
  return oct * 12 + scale[i];
}

/**
 * Voice-lead a chord. Given the previous voicing and the new chord's
 * pitch classes, place each new tone at the octave nearest the voice it
 * replaces, inside a register window. This is the difference between a
 * progression that flows and one that lurches.
 */
function voiceLead(prev, rootMidi, shape, lo, hi) {
  const pcs = shape.map((s) => (rootMidi + s) % 12);
  const out = [];
  const used = new Set();
  const centre = (lo + hi) / 2;
  for (let i = 0; i < pcs.length; i++) {
    const target = prev && prev[i] != null ? prev[i] : centre + (i - pcs.length / 2) * 3;
    let best = -1, bestD = 1e9;
    for (let m = lo; m <= hi; m++) {
      if (m % 12 !== pcs[i]) continue;
      if (used.has(m)) continue;
      const d = Math.abs(m - target);
      if (d < bestD) { bestD = d; best = m; }
    }
    if (best < 0) best = rootMidi + shape[i];
    used.add(best);
    out.push(best);
  }
  return out.sort((a, b) => a - b);
}

/* Rhythm cells, in beats. The scheduler picks one per melodic bar. A cell
   never fills the bar completely — the tail is breath. */
const CELLS_4 = [
  [1, 1, 2], [2, 1, 1], [0.5, 0.5, 1, 1], [1.5, 0.5, 2], [3, 1],
  [1, 0.5, 0.5, 1], [2, 2], [0.5, 0.5, 0.5, 0.5, 2], [4],
];
const CELLS_6 = [
  [1, 1, 1], [1.5, 1.5], [1, 0.5, 0.5, 1], [2, 1], [3], [0.5, 0.5, 1, 1],
];

/* Phrase shapes: which bars of a 4-bar phrase the lead plays in.
   Silence is a compositional device, not an oversight. */
const PHRASES = [
  [1, 1, 1, 0],   // call, breathe
  [1, 1, 0, 1],   // answer
  [1, 0, 1, 1],
  [1, 1, 1, 1],   // full — used sparingly
  [0, 1, 1, 0],   // late entry
  [1, 0, 0, 1],   // very sparse
];

/* ---------- the score table ---------- */
/* Every context is a complete piece: key, mode, tempo, meter, a chord
   progression, the six layer gains, and instrument assignments. */

export const SCORES = {
  silence: {
    bpm: 90, meter: 4, key: 55, scale: 'major', space: 'outdoor',
    prog: [[0, 'maj9', 4]],
    layers: { bass: 0, pad: 0, arp: 0, lead: 0, perc: 0, air: 0 },
    inst: { bass: 'contrabass', pad: 'strings', arp: 'harp', lead: 'flute' },
    lead: { lo: 72, hi: 88, density: 0 }, arp: { rate: 0.5, mode: 'roll' }, perc: 'none',
  },

  /* The title card. Wide, slow, ceremonial: horn over strings and harp. */
  title: {
    bpm: 66, meter: 4, key: 50, scale: 'major', space: 'hall',
    prog: [[0, 'maj9', 2], [4, 'sus9', 2], [5, 'min9', 2], [3, 'maj13', 2]],
    layers: { bass: 0.85, pad: 1.0, arp: 0.7, lead: 0.9, perc: 0.14, air: 0.6 },
    inst: { bass: 'contrabass', pad: 'strings', arp: 'harp', lead: 'horn' },
    lead: { lo: 62, hi: 79, density: 0.55, legato: 1.5 },
    arp: { rate: 0.5, mode: 'roll' }, perc: 'ceremony',
  },

  /* The overworld. This is the piece the player hears most, so it is the
     one with the most air in it: a lydian brightness, a harp that never
     stops, a flute that says something then stops talking. */
  explore: {
    bpm: 104, meter: 4, key: 55, scale: 'lydian', space: 'outdoor',
    prog: [[0, 'maj9', 2], [5, 'min9', 2], [3, 'maj7', 2], [4, 'sus9', 1], [4, 'dom9', 1]],
    layers: { bass: 0.8, pad: 0.55, arp: 0.85, lead: 0.7, perc: 0.3, air: 0.18 },
    inst: { bass: 'contrabass', pad: 'strings', arp: 'harp', lead: 'flute' },
    lead: { lo: 72, hi: 89, density: 0.62 },
    arp: { rate: 0.5, mode: 'roll' }, perc: 'light',
  },

  /* Streets and squares between shops — warmer, closer, marimba-led. */
  town: {
    bpm: 98, meter: 4, key: 57, scale: 'major', space: 'outdoor',
    prog: [[0, 'six9', 2], [3, 'maj9', 2], [1, 'min9', 2], [4, 'dom9', 2]],
    layers: { bass: 0.85, pad: 0.45, arp: 0.9, lead: 0.6, perc: 0.42, air: 0.1 },
    inst: { bass: 'pizz', pad: 'strings', arp: 'marimba', lead: 'flute' },
    lead: { lo: 72, hi: 88, density: 0.55 },
    arp: { rate: 0.5, mode: 'walk' }, perc: 'light',
  },

  /* Market square. Busy, mixolydian, hand percussion, horn punctuation. */
  market: {
    bpm: 126, meter: 4, key: 60, scale: 'mixolydian', space: 'market',
    prog: [[0, 'dom9', 2], [6, 'maj9', 1], [3, 'maj9', 1], [0, 'dom13', 2], [4, 'sus9', 2]],
    layers: { bass: 0.9, pad: 0.3, arp: 0.95, lead: 0.55, perc: 0.75, air: 0.06 },
    inst: { bass: 'pizz', pad: 'strings', arp: 'marimba', lead: 'horn' },
    lead: { lo: 67, hi: 84, density: 0.45, legato: 0.7 },
    arp: { rate: 0.25, mode: 'walk' }, perc: 'busy',
  },

  /* Indoors: shopfronts, offices, the library. Small and quiet. */
  interior: {
    bpm: 76, meter: 4, key: 53, scale: 'major', space: 'room',
    prog: [[0, 'maj9', 2], [5, 'min7', 2], [1, 'min9', 2], [4, 'sus9', 2]],
    layers: { bass: 0.5, pad: 0.6, arp: 0.62, lead: 0.34, perc: 0, air: 0.22 },
    inst: { bass: 'contrabass', pad: 'strings', arp: 'harp', lead: 'flute' },
    lead: { lo: 72, hi: 86, density: 0.34 },
    arp: { rate: 1, mode: 'roll' }, perc: 'none',
  },

  /* Night. Aeolian ninths, choir air, a harp that barely moves. */
  night: {
    bpm: 62, meter: 4, key: 52, scale: 'aeolian', space: 'outdoor',
    prog: [[0, 'min9', 4], [5, 'maj9', 2], [2, 'maj7', 2], [4, 'min7', 4]],
    layers: { bass: 0.62, pad: 0.72, arp: 0.5, lead: 0.3, perc: 0.06, air: 0.75 },
    inst: { bass: 'contrabass', pad: 'strings', arp: 'glass', lead: 'flute' },
    lead: { lo: 74, hi: 90, density: 0.26, legato: 1.4 },
    arp: { rate: 1, mode: 'roll' }, perc: 'none',
  },

  /* Danger. Ostinato bass, drums, no tune — the melody withholding
     itself is what makes it read as tense. */
  tense: {
    bpm: 134, meter: 4, key: 50, scale: 'aeolian', space: 'outdoor',
    prog: [[0, 'min7', 2], [5, 'maj7', 1], [6, 'maj7', 1], [0, 'min7', 2], [4, 'm7b5', 2]],
    layers: { bass: 1.0, pad: 0.5, arp: 0.55, lead: 0.28, perc: 0.85, air: 0.14 },
    inst: { bass: 'contrabass', pad: 'strings', arp: 'marimba', lead: 'horn' },
    lead: { lo: 60, hi: 74, density: 0.3, legato: 0.6 },
    arp: { rate: 0.25, mode: 'ostinato' }, perc: 'drive',
  },

  /* Travel by sea. 6/8, rolling, horn on top — the Wind Waker sail. */
  sail: {
    bpm: 168, meter: 6, key: 55, scale: 'major', space: 'outdoor',
    prog: [[0, 'add9', 6], [4, 'dom9', 6], [5, 'min9', 6], [3, 'maj9', 6]],
    layers: { bass: 0.9, pad: 0.6, arp: 0.75, lead: 0.85, perc: 0.4, air: 0.3 },
    inst: { bass: 'contrabass', pad: 'strings', arp: 'harp', lead: 'horn' },
    lead: { lo: 64, hi: 81, density: 0.7, legato: 1.2 },
    arp: { rate: 1, mode: 'roll' }, perc: 'roll',
  },

  /* Cutscenes. Very slow, strings and horn only, huge reverb. */
  cinematic: {
    bpm: 54, meter: 4, key: 51, scale: 'major', space: 'hall',
    prog: [[0, 'maj9', 4], [3, 'maj13', 4], [5, 'min11', 4], [4, 'sus9', 4]],
    layers: { bass: 0.7, pad: 1.0, arp: 0.35, lead: 0.7, perc: 0, air: 0.85 },
    inst: { bass: 'contrabass', pad: 'strings', arp: 'harp', lead: 'horn' },
    lead: { lo: 60, hi: 78, density: 0.42, legato: 2.0 },
    arp: { rate: 1, mode: 'roll' }, perc: 'none',
  },

  /* Green Edge — pastoral mixolydian, marimba and flute. */
  farm: {
    bpm: 92, meter: 4, key: 58, scale: 'mixolydian', space: 'outdoor',
    prog: [[0, 'add9', 2], [6, 'maj9', 2], [3, 'maj9', 2], [0, 'six9', 2]],
    layers: { bass: 0.78, pad: 0.4, arp: 0.8, lead: 0.72, perc: 0.28, air: 0.14 },
    inst: { bass: 'pizz', pad: 'strings', arp: 'marimba', lead: 'flute' },
    lead: { lo: 70, hi: 87, density: 0.6 },
    arp: { rate: 0.5, mode: 'walk' }, perc: 'light',
  },

  /* Iron Hills mine — dark dorian, glass bells, cave reverb. */
  mine: {
    bpm: 70, meter: 4, key: 48, scale: 'dorian', space: 'cave',
    prog: [[0, 'min9', 4], [3, 'min7', 2], [5, 'maj7', 2], [0, 'minmaj', 4]],
    layers: { bass: 0.85, pad: 0.6, arp: 0.55, lead: 0.24, perc: 0.16, air: 0.5 },
    inst: { bass: 'contrabass', pad: 'strings', arp: 'glass', lead: 'flute' },
    lead: { lo: 72, hi: 88, density: 0.24, legato: 1.6 },
    arp: { rate: 1, mode: 'roll' }, perc: 'none',
  },

  /* Golden Heights — lush, expensive, maj13s and a glass ceiling. */
  heights: {
    bpm: 84, meter: 4, key: 56, scale: 'major', space: 'hall',
    prog: [[0, 'maj13', 2], [2, 'min7', 2], [5, 'min9', 2], [3, 'maj9', 1], [4, 'dom13', 1]],
    layers: { bass: 0.72, pad: 0.85, arp: 0.8, lead: 0.6, perc: 0.12, air: 0.55 },
    inst: { bass: 'contrabass', pad: 'strings', arp: 'glass', lead: 'flute' },
    lead: { lo: 72, hi: 90, density: 0.5, legato: 1.3 },
    arp: { rate: 0.5, mode: 'roll' }, perc: 'ceremony',
  },
};

export const CONTEXT_NAMES = Object.keys(SCORES);

const LAYER_NAMES = ['bass', 'pad', 'arp', 'lead', 'perc', 'air'];

/* Per-layer stereo placement and reverb send. Spreading the layers is
   most of what makes a synthesised ensemble sound like an ensemble. */
const LAYER_PLACE = {
  bass: { pan: 0.00, spread: 0.06, send: 0.22 },
  pad:  { pan: -0.10, spread: 0.55, send: 0.55 },
  arp:  { pan: 0.22, spread: 0.34, send: 0.40 },
  lead: { pan: -0.06, spread: 0.10, send: 0.34 },
  perc: { pan: 0.14, spread: 0.40, send: 0.24 },
  air:  { pan: 0.00, spread: 0.70, send: 0.72 },
};

/* ---------- engine ---------- */

/* --- the look-ahead, and why it is not a constant -------------------

   A look-ahead scheduler is only safe while it is called back more often
   than its own horizon. Neither of the two clocks that drive this one
   guarantees that:

     · requestAnimationFrame stops entirely in a hidden tab;
     · setTimeout/setInterval is clamped to 1 s in a hidden tab, and
       Chrome drops a page that has made no sound for 30 s to ONE TICK
       PER MINUTE ("intensive throttling").

   With a fixed 0.28 s horizon that is fatal, and self-reinforcing: the
   tab goes to the background, the scheduler starves, the score goes
   quiet, being quiet makes the page eligible for the harsher throttle,
   and now it is a minute between ticks and the music is properly dead
   until the player comes back and rAF starts again. THAT IS THE
   "my music cut out, stayed off, and came back later" report.

   So the horizon is measured, not assumed: tick() watches how far apart
   its own calls actually land and schedules far enough ahead to cover
   the gap it is really being given, up to MAX_LOOKAHEAD. audio.js also
   raises the floor the moment the document is hidden, so the very first
   throttled tick is already covered rather than the second. Staying
   audible is what keeps us out of intensive throttling in the first
   place. */
const LOOKAHEAD = 0.28;       // seconds of score scheduled beyond `now`
const MAX_LOOKAHEAD = 3.0;    // ceiling: any more and a context change drags
const MIN_STEP = 0.02;

export function createMusic({ actx, dest, reverb = null, rng = null, seed = 0x7a11 } = {}) {
  /* The world RNG is deterministic and shared; fall back to Math.random
     only if the caller has none. Never assume it was passed. */
  const R = typeof rng === 'function' ? rng : Math.random;

  /* --- graph --- */
  const out = actx.createGain();
  out.gain.value = 1;

  /* The "gentle lowpass that opens on louder passages": one shared tone
     filter after all layers, whose cutoff tracks the summed layer energy.
     Quiet contexts sit dark and distant; the market opens right up. */
  const tone = actx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 2600;
  tone.Q.value = 0.4;

  /* A very light shelf keeps synthesised strings from sounding brittle. */
  const warmth = actx.createBiquadFilter();
  warmth.type = 'highshelf';
  warmth.frequency.value = 4200;
  warmth.gain.value = -3.5;

  tone.connect(warmth); warmth.connect(out); out.connect(dest);

  const layers = {};
  for (const name of LAYER_NAMES) {
    const g = actx.createGain();
    g.gain.value = 0;
    g.connect(tone);
    const send = actx.createGain();
    send.gain.value = LAYER_PLACE[name].send;
    if (reverb) { g.connect(send); send.connect(reverb.input ?? reverb); }
    layers[name] = { gain: g, send, target: 0 };
  }

  /* --- voice bookkeeping ---
     Every voice registers its scheduled stop time. `voices` counts only
     the ones that are still supposed to be sounding, so the test harness
     can prove there are no runaway oscillators without depending on
     `onended` timing. */
  const live = [];
  function track(node, stopTime) {
    live.push({ node, stopTime });
    if (node && 'onended' in node) {
      node.onended = () => { try { node.disconnect(); } catch { /* already gone */ } };
    }
  }
  /* Drop the entries whose voices have already finished.

     THIS USED TO HAPPEN ONLY INSIDE voiceCount(), which nothing but the
     test harness ever calls — so in a real session `live` grew by one
     object per note, forever, each holding a reference to an AudioNode
     that had long since stopped. An hour of play is tens of thousands of
     retained nodes and a steadily growing heap behind the audio thread.
     reap() is now called from tick(), so the list stays the size of what
     is genuinely sounding. */
  function reap() {
    const cut = actx.currentTime - 0.5;
    let w = 0;
    for (let i = 0; i < live.length; i++) {
      if (live[i].stopTime > cut) live[w++] = live[i];
    }
    live.length = w;
  }
  function voiceCount() {
    reap();
    const t = actx.currentTime;
    let n = 0;
    for (const v of live) if (v.stopTime > t) n++;
    return n;
  }

  const noise = makeNoise(actx);

  /* --- instruments ---------------------------------------------------
     Each returns nothing; it builds a short-lived voice graph, schedules
     it and registers it for counting. `bus` is the layer gain node. */

  function panFor(layer, jitter) {
    const p = LAYER_PLACE[layer] || LAYER_PLACE.lead;
    const v = p.pan + (jitter * 2 - 1) * p.spread;
    if (!actx.createStereoPanner) return null;
    const n = actx.createStereoPanner();
    n.pan.value = Math.max(-1, Math.min(1, v));
    return n;
  }

  /* ADSR into a gain node, returns the node. Exponential release, linear
     attack — the combination that reads as "acoustic". */
  function env(when, a, d, s, r, peak, dur) {
    const g = actx.createGain();
    const t0 = when;
    const eps = 0.0001;
    g.gain.setValueAtTime(eps, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + a);
    g.gain.exponentialRampToValueAtTime(Math.max(eps, peak * s), t0 + a + d);
    const rel = t0 + Math.max(a + d, dur);
    g.gain.setValueAtTime(Math.max(eps, peak * s), rel);
    g.gain.exponentialRampToValueAtTime(eps, rel + r);
    return { node: g, end: rel + r };
  }

  function connectOut(chain, layer, jitter) {
    const p = panFor(layer, jitter);
    if (p) { chain.connect(p); p.connect(layers[layer].gain); }
    else chain.connect(layers[layer].gain);
  }

  /* Additive harp: a struck string is a small number of partials with
     slightly stretched tuning and decays that shorten with frequency. */
  function harp(when, midi, dur, gain, layer, jit) {
    const f = mtof(midi);
    const e = env(when, 0.004, dur * 0.9, 0.02, 0.28, gain, dur);
    connectOut(e.node, layer, jit);
    const partials = [1, 2.001, 3.004, 4.01, 5.02, 6.04];
    const amps = [1, 0.42, 0.22, 0.13, 0.07, 0.04];
    const np = detail < 0.6 ? 3 : partials.length;
    for (let i = 0; i < np; i++) {
      if (f * partials[i] > 14000) break;
      const o = actx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * partials[i];
      o.detune.value = (i === 0 ? 0 : (i % 2 ? 3 : -3));
      const pg = actx.createGain();
      // Higher partials die first — this is the whole character of a harp.
      const pd = dur * Math.pow(0.62, i);
      pg.gain.setValueAtTime(amps[i], when);
      pg.gain.exponentialRampToValueAtTime(0.0001, when + Math.max(0.05, pd));
      o.connect(pg); pg.connect(e.node);
      o.start(when); o.stop(e.end);
      if (i === 0) track(o, e.end);
    }
    // Pluck transient.
    plink(when, f * 3.2, 0.012, gain * 0.5, e.node);
  }

  /* FM marimba: 4:1 carrier/modulator with a fast modulator decay, plus a
     wooden mallet click. */
  function marimba(when, midi, dur, gain, layer, jit) {
    const f = mtof(midi);
    const d = Math.min(dur, 0.9);
    const e = env(when, 0.003, d * 0.85, 0.01, 0.14, gain, d);
    connectOut(e.node, layer, jit);
    const car = actx.createOscillator();
    car.type = 'sine'; car.frequency.value = f;
    const mod = actx.createOscillator();
    mod.type = 'sine'; mod.frequency.value = f * 4;
    const mg = actx.createGain();
    mg.gain.setValueAtTime(f * 3.4, when);
    mg.gain.exponentialRampToValueAtTime(f * 0.02, when + 0.09);
    mod.connect(mg); mg.connect(car.frequency);
    // A quiet 4th-partial ring is what says "bar" rather than "sine".
    const ring = actx.createOscillator();
    ring.type = 'sine'; ring.frequency.value = f * 3.98;
    const rg = actx.createGain();
    rg.gain.setValueAtTime(0.16, when);
    rg.gain.exponentialRampToValueAtTime(0.0001, when + 0.16);
    ring.connect(rg); rg.connect(e.node);
    car.connect(e.node);
    car.start(when); mod.start(when); ring.start(when);
    car.stop(e.end); mod.stop(e.end); ring.stop(e.end);
    track(car, e.end);
    plink(when, 2400, 0.008, gain * 0.35, e.node);
  }

  /* Additive glass / celesta: inharmonic partials, long shimmer. */
  function glass(when, midi, dur, gain, layer, jit) {
    const f = mtof(midi);
    const e = env(when, 0.006, dur, 0.05, 0.9, gain * 0.8, dur);
    connectOut(e.node, layer, jit);
    const partials = [1, 2.76, 5.4, 8.93];
    const amps = [1, 0.34, 0.16, 0.08];
    for (let i = 0; i < partials.length; i++) {
      if (f * partials[i] > 15000) break;
      const o = actx.createOscillator();
      o.type = 'sine'; o.frequency.value = f * partials[i];
      const pg = actx.createGain();
      pg.gain.setValueAtTime(amps[i], when);
      pg.gain.exponentialRampToValueAtTime(0.0001, when + dur * Math.pow(0.7, i));
      o.connect(pg); pg.connect(e.node);
      o.start(when); o.stop(e.end);
      if (i === 0) track(o, e.end);
    }
  }

  /* Ensemble strings: three saws a few cents apart through a lowpass that
     opens with the envelope, plus a slow vibrato. Slow attack. */
  function strings(when, midi, dur, gain, layer, jit) {
    const f = mtof(midi);
    const a = Math.min(0.5, dur * 0.35);
    const e = env(when, a, dur * 0.3, 0.72, Math.max(0.5, dur * 0.5), gain, dur);
    const lp = actx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(f * 2.2, when);
    lp.frequency.linearRampToValueAtTime(f * 5.5, when + a * 1.5);
    lp.frequency.linearRampToValueAtTime(f * 2.6, e.end);
    lp.Q.value = 0.7;
    lp.connect(e.node);
    connectOut(e.node, layer, jit);

    const vib = actx.createOscillator();
    vib.type = 'sine'; vib.frequency.value = 4.6 + R() * 0.9;
    const vg = actx.createGain();
    vg.gain.setValueAtTime(0, when);
    vg.gain.linearRampToValueAtTime(4.5, when + a + 0.25);
    vib.connect(vg);
    vib.start(when); vib.stop(e.end);

    // A three-voice ensemble a few cents apart; the low tier drops to one.
    const cents = detail < 0.6 ? [0] : [-7, 0, 8];
    for (let i = 0; i < cents.length; i++) {
      const o = actx.createOscillator();
      o.type = cents[i] === 0 ? 'sawtooth' : 'triangle';
      o.frequency.value = f;
      o.detune.value = cents[i];
      vg.connect(o.detune);
      const og = actx.createGain();
      og.gain.value = cents[i] === 0 ? 0.5 : 0.32;
      o.connect(og); og.connect(lp);
      o.start(when); o.stop(e.end);
      if (i === 0) track(o, e.end);
    }
  }

  /* Flute: near-sine with a touch of 2nd/3rd, plus band-passed breath
     noise on the attack. The noise is what makes it a flute. */
  function flute(when, midi, dur, gain, layer, jit) {
    const f = mtof(midi);
    const a = Math.min(0.09, dur * 0.3);
    const e = env(when, a, dur * 0.25, 0.78, 0.22, gain, dur);
    connectOut(e.node, layer, jit);

    const vib = actx.createOscillator();
    vib.type = 'sine'; vib.frequency.value = 5.1;
    const vg = actx.createGain();
    vg.gain.setValueAtTime(0, when);
    vg.gain.linearRampToValueAtTime(7, when + Math.min(0.6, dur));
    vib.connect(vg); vib.start(when); vib.stop(e.end);

    const amps = [1, 0.16, 0.06];
    for (let i = 0; i < 3; i++) {
      const o = actx.createOscillator();
      o.type = 'sine'; o.frequency.value = f * (i + 1);
      vg.connect(o.detune);
      const og = actx.createGain(); og.gain.value = amps[i];
      o.connect(og); og.connect(e.node);
      o.start(when); o.stop(e.end);
      if (i === 0) track(o, e.end);
    }
    const br = noise.source(when, 0.13);
    const bf = actx.createBiquadFilter();
    bf.type = 'bandpass'; bf.frequency.value = f * 2.6; bf.Q.value = 1.6;
    const bg = actx.createGain();
    bg.gain.setValueAtTime(0.0001, when);
    bg.gain.linearRampToValueAtTime(gain * 0.22, when + 0.02);
    bg.gain.exponentialRampToValueAtTime(0.0001, when + 0.13);
    br.connect(bf); bf.connect(bg); bg.connect(e.node);
    br.stop(when + 0.14);
  }

  /* Horn: filtered sawtooth with a slow brassy filter sweep and a soft
     attack. Two voices a hair apart so it sits wide. */
  function horn(when, midi, dur, gain, layer, jit) {
    const f = mtof(midi);
    const a = Math.min(0.13, dur * 0.35);
    const e = env(when, a, dur * 0.3, 0.7, 0.3, gain * 0.9, dur);
    const lp = actx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(f * 1.4, when);
    lp.frequency.linearRampToValueAtTime(f * 6, when + a * 1.6);
    lp.frequency.exponentialRampToValueAtTime(Math.max(200, f * 2), e.end);
    lp.Q.value = 3.2;
    lp.connect(e.node);
    connectOut(e.node, layer, jit);
    for (let i = 0; i < 2; i++) {
      const o = actx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f;
      o.detune.value = i ? 6 : -6;
      const og = actx.createGain(); og.gain.value = 0.34;
      o.connect(og); og.connect(lp);
      o.start(when); o.stop(e.end);
      if (i === 0) track(o, e.end);
    }
  }

  /* Bowed contrabass: sine fundamental + a filtered saw an octave up. */
  function contrabass(when, midi, dur, gain, layer, jit) {
    const f = mtof(midi);
    const e = env(when, 0.05, dur * 0.4, 0.65, 0.35, gain, dur);
    connectOut(e.node, layer, jit);
    const o = actx.createOscillator();
    o.type = 'sine'; o.frequency.value = f;
    const og = actx.createGain(); og.gain.value = 0.8;
    o.connect(og); og.connect(e.node);
    const o2 = actx.createOscillator();
    o2.type = 'triangle'; o2.frequency.value = f * 2; o2.detune.value = 5;
    const lp = actx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = Math.max(160, f * 5); lp.Q.value = 0.6;
    const o2g = actx.createGain(); o2g.gain.value = 0.18;
    o2.connect(lp); lp.connect(o2g); o2g.connect(e.node);
    o.start(when); o2.start(when); o.stop(e.end); o2.stop(e.end);
    track(o, e.end);
  }

  /* Pizzicato bass: same body, plucked envelope, no sustain. */
  function pizz(when, midi, dur, gain, layer, jit) {
    const f = mtof(midi);
    const d = Math.min(dur, 0.42);
    const e = env(when, 0.004, d, 0.01, 0.12, gain * 1.15, d);
    connectOut(e.node, layer, jit);
    const o = actx.createOscillator();
    o.type = 'triangle'; o.frequency.setValueAtTime(f * 1.02, when);
    o.frequency.exponentialRampToValueAtTime(f, when + 0.03);
    o.connect(e.node);
    o.start(when); o.stop(e.end);
    track(o, e.end);
    plink(when, f * 5, 0.01, gain * 0.4, e.node);
  }

  /* Wordless choir for the `air` layer: two filtered saws through fixed
     formants. Extremely slow attack; it should arrive without being
     noticed. */
  function choir(when, midi, dur, gain, layer, jit) {
    const f = mtof(midi);
    const a = Math.min(1.6, dur * 0.45);
    const e = env(when, a, dur * 0.2, 0.85, Math.max(0.9, dur * 0.5), gain, dur);
    connectOut(e.node, layer, jit);
    const mix = actx.createGain(); mix.gain.value = 0.4;
    // "aah" formants
    for (const [hz, q, g] of [[730, 7, 1], [1090, 9, 0.5], [2440, 11, 0.22]]) {
      const bp = actx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = hz; bp.Q.value = q;
      const bg = actx.createGain(); bg.gain.value = g;
      mix.connect(bp); bp.connect(bg); bg.connect(e.node);
    }
    const vib = actx.createOscillator();
    vib.type = 'sine'; vib.frequency.value = 4.2;
    const vg = actx.createGain(); vg.gain.value = 6;
    vib.connect(vg); vib.start(when); vib.stop(e.end);
    for (let i = 0; i < 2; i++) {
      const o = actx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f;
      o.detune.value = i ? 11 : -11;
      vg.connect(o.detune);
      o.connect(mix);
      o.start(when); o.stop(e.end);
      if (i === 0) track(o, e.end);
    }
  }

  /* --- percussion --- */

  function drum(when, freq, dur, gain, jit) {
    const e = env(when, 0.002, dur, 0.01, 0.06, gain, dur);
    connectOut(e.node, 'perc', jit);
    const o = actx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq * 2.2, when);
    o.frequency.exponentialRampToValueAtTime(freq, when + 0.05);
    o.connect(e.node);
    o.start(when); o.stop(e.end);
    track(o, e.end);
    // Skin slap.
    const n = noise.source(when, 0.06);
    const bp = actx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.8;
    const ng = actx.createGain();
    ng.gain.setValueAtTime(gain * 0.35, when);
    ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    n.connect(bp); bp.connect(ng); ng.connect(e.node);
    n.stop(when + 0.07);
  }

  function shaker(when, gain, jit) {
    const e = env(when, 0.002, 0.03, 0.01, 0.02, gain, 0.03);
    connectOut(e.node, 'perc', jit);
    const n = noise.source(when, 0.09);
    const hp = actx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 5200; hp.Q.value = 0.7;
    n.connect(hp); hp.connect(e.node);
    n.stop(when + 0.09);
    track(n, when + 0.09);
  }

  function triangleHit(when, gain, jit) {
    const e = env(when, 0.002, 1.4, 0.02, 0.6, gain, 1.4);
    connectOut(e.node, 'perc', jit);
    for (const [r, a] of [[1, 1], [2.53, 0.6], [4.11, 0.35], [6.7, 0.2]]) {
      const o = actx.createOscillator();
      o.type = 'sine'; o.frequency.value = 2100 * r;
      const g = actx.createGain(); g.gain.value = a * 0.25;
      o.connect(g); g.connect(e.node);
      o.start(when); o.stop(e.end);
      if (r === 1) track(o, e.end);
    }
  }

  function plink(when, hz, dur, gain, destNode) {
    const n = noise.source(when, dur + 0.02);
    const bp = actx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = hz; bp.Q.value = 1.2;
    const g = actx.createGain();
    g.gain.setValueAtTime(gain, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    n.connect(bp); bp.connect(g); g.connect(destNode);
    n.stop(when + dur + 0.02);
  }

  const INSTRUMENTS = { harp, marimba, glass, strings, flute, horn, contrabass, pizz, choir };

  /* --- transport & composition state --- */

  let score = SCORES.silence;
  let scoreName = 'silence';
  let pending = null;             // { name, fade } queued for the next bar
  let bpm = score.bpm;
  let bpmTarget = score.bpm;
  let meter = score.meter;

  let bar = 0, beat = 0;
  let nextTime = 0;
  let running = false;
  /* True once the transport has actually put a bar on the wire. Until
     then a context change may snap the tempo instead of gliding to it —
     there is nothing to glide away from, and the opening cinematic is
     cut against exact 54 bpm bar lines from bar 0. */
  let scheduled = false;
  /* 0..1 — how many voices we may spend. Driven from ctx.quality so the
     low tier gets the same *piece*, thinner, rather than a different one. */
  let detail = 1;

  /* --- scheduler health, all in context-clock seconds ---
     Everything the watchdog in audio.js needs to tell "playing" from
     "believes it is playing". `nextTime` doubles as the answer to "how
     far is the score written on the wire": once currentTime passes it,
     the room has gone quiet. */
  let horizonFloor = 0;     // raised by setHorizon() while the tab is hidden
  let horizon = LOOKAHEAD;  // what the last tick actually used
  let tickGap = 0;          // measured seconds between tick() calls
  let lastTick = -1;
  let reanchors = 0;        // times we gave up catching up and re-clocked
  let tickErrors = 0;       // bars that failed to schedule, ever
  /* ...AND HOW MANY IN A ROW, which is the number that means "the room
     is silent right now". Zeroed the moment a bar actually lands. The
     watchdog in audio.js reads it every frame: a bar that throws every
     time produces NO growth in silentFor (the loop still advances the
     clock, it just writes nothing to it) so this counter is the only
     evidence that exists. */
  let barFails = 0;
  let recoveries = 0;       // full transport resets (recover(), below)
  let barLogs = 0, lastBarLog = 0;
  let lastError = null;
  /* Test hook, driven by WALLY.debug.audioBreakTick(). See injectFault(). */
  let faultBars = 0, faultWhere = 'bar';
  let crossfadeUntil = 0;   // a commit is gliding the layers; heal() waits
  let silentUntil = 0;      // stop()'s fade owns the bus until this time

  let progIdx = 0, progBarsLeft = 0;
  let voicing = null;
  let chordRoot = 55;
  let chordPcs = [];

  let mrng = mulberry(seed);
  let motif = [];
  let phraseIdx = 0;
  let leadDeg = 4;
  let barNotes = [];              // melody scheduled for the current bar
  let noteEvents = [];            // rolling log, for the test harness

  function mulberry(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function newMotif() {
    const pool = [-2, -1, -1, 0, 1, 1, 2, 2, 3, -3, 4];
    const n = 3 + Math.floor(mrng() * 4);
    motif = [];
    for (let i = 0; i < n; i++) motif.push(pool[Math.floor(mrng() * pool.length)]);
    // Guarantee the motif moves somewhere rather than wobbling in place.
    if (motif.reduce((a, b) => a + b, 0) === 0) motif[0] += 2;
  }
  newMotif();

  function scaleArr() { return SCALES[score.scale] || SCALES.major; }

  function advanceChord() {
    if (progBarsLeft > 0) return;
    const step = score.prog[progIdx % score.prog.length];
    progIdx++;
    const [deg, quality, bars] = step;
    const sc = scaleArr();
    chordRoot = score.key + degToSemi(sc, deg);
    const shape = CHORDS[quality] || CHORDS.maj7;
    voicing = voiceLead(voicing, chordRoot, shape, 54, 84);
    chordPcs = shape.map((s) => (chordRoot + s) % 12);
    progBarsLeft = bars;
  }

  function nearestChordTone(midi) {
    let best = midi, bestD = 1e9;
    for (let m = midi - 6; m <= midi + 6; m++) {
      if (!chordPcs.includes(((m % 12) + 12) % 12)) continue;
      const d = Math.abs(m - midi);
      if (d < bestD) { bestD = d; best = m; }
    }
    return best;
  }

  /* Compose one bar of melody. Returns [{offsetBeats, dur, midi}]. */
  function composeBar(barInPhrase) {
    const L = score.lead;
    if (!L || L.density <= 0) return [];
    const shape = PHRASES[phraseIdx % PHRASES.length];
    if (!shape[barInPhrase]) return [];
    if (mrng() > L.density) return [];

    const cells = meter === 6 ? CELLS_6 : CELLS_4;
    const cell = cells[Math.floor(mrng() * cells.length)];
    const sc = scaleArr();
    const notes = [];
    let t = 0;
    // Phrase-level development: transpose or invert the motif per phrase.
    const inv = (phraseIdx % 4 === 3) ? -1 : 1;
    const shift = (phraseIdx % 8 >= 4) ? 2 : 0;

    for (let i = 0; i < cell.length && t < meter; i++) {
      const d = cell[i];
      const strong = (t === 0) || (meter === 4 && t === 2) || (meter === 6 && t === 3);
      leadDeg += motif[(bar * 3 + i) % motif.length] * inv;
      let midi = score.key + 12 + degToSemi(sc, leadDeg + shift);
      // Fold back into the instrument's register instead of clamping flat.
      while (midi > L.hi) { midi -= 12; leadDeg -= 7; }
      while (midi < L.lo) { midi += 12; leadDeg += 7; }
      if (strong) midi = nearestChordTone(midi);
      // Drop the odd note — a melody with holes breathes.
      if (!strong && mrng() < 0.16) { t += d; continue; }
      notes.push({ at: t, dur: d * (L.legato ?? 1), midi });
      t += d;
    }
    return notes;
  }

  /* --- per-beat scheduling --- */

  function beatDur() { return 60 / bpm; }

  function scheduleBar(when) {
    /* Fault injection. A real browser throws exactly here — every Web
       Audio param setter rejects a non-finite value with a TypeError —
       so this is the honest shape of the failure, not a stand-in. */
    if (faultBars > 0 && faultWhere === 'bar') {
      faultBars--;
      throw new TypeError('injected: the provided float value is non-finite');
    }
    scheduled = true;
    advanceChord();
    progBarsLeft--;
    const bd = beatDur();
    const barLen = bd * meter;
    const barInPhrase = bar % 4;
    if (barInPhrase === 0 && bar > 0) {
      phraseIdx++;
      if (phraseIdx % 8 === 0) newMotif();
    }

    /* Bass — root, with a fifth or octave answer on the back half. */
    if (score.layers.bass > 0 && voicing) {
      const inst = INSTRUMENTS[score.inst.bass] || contrabass;
      let bmidi = chordRoot;
      while (bmidi > 47) bmidi -= 12;
      while (bmidi < 31) bmidi += 12;
      inst(when, bmidi, barLen * 0.92, 0.30, 'bass', mrng());
      logNote('bass', when, bmidi);
      if (meter === 4) {
        inst(when + bd * 2.5, bmidi + 7, bd * 1.2, 0.16, 'bass', mrng());
        logNote('bass', when + bd * 2.5, bmidi + 7);
      } else {
        inst(when + bd * 3, bmidi + 12, bd * 2.4, 0.14, 'bass', mrng());
        logNote('bass', when + bd * 3, bmidi + 12);
      }
    }

    /* Pad — the chord, held, entries staggered so it swells. */
    if (score.layers.pad > 0 && voicing) {
      const inst = INSTRUMENTS[score.inst.pad] || strings;
      // On thin detail keep the root, the colour tone and the top — the
      // notes that carry the harmony — and drop the inner doublings.
      const v = detail < 0.6 && voicing.length > 3
        ? [voicing[0], voicing[Math.floor(voicing.length / 2)], voicing[voicing.length - 1]]
        : voicing;
      for (let i = 0; i < v.length; i++) {
        const stagger = i * 0.028;
        inst(when + stagger, v[i], barLen * 1.04, 0.085, 'pad', i / v.length);
      }
      logNote('pad', when, v[0]);
    }

    /* Air — choir doubling the top two voices an octave up, very quiet. */
    if (score.layers.air > 0 && voicing && detail >= 0.6) {
      const top = voicing.slice(-2);
      for (let i = 0; i < top.length; i++) {
        choir(when + i * 0.05, top[i] + 12, barLen * 1.1, 0.05, 'air', i * 0.7);
      }
    }

    /* Arp — the constant motion. Three flavours: a rolled arpeggio, a
       walking figure that also touches passing scale tones, and a driving
       ostinato for `tense`. */
    if (score.layers.arp > 0 && voicing) {
      const inst = INSTRUMENTS[score.inst.arp] || harp;
      const rate = score.arp.rate;             // in beats
      const steps = Math.round(meter / rate);
      const v = voicing;
      for (let s = 0; s < steps; s++) {
        const t = when + s * rate * bd;
        let midi;
        if (score.arp.mode === 'ostinato') {
          midi = v[[0, 1, 0, 2][s % 4] % v.length];
          if (s % 8 >= 4) midi += 12;
        } else if (score.arp.mode === 'walk') {
          const idx = s % (v.length * 2 - 2);
          midi = v[idx < v.length ? idx : v.length * 2 - 2 - idx];
          if (s % 4 === 3) midi += 12;
        } else {
          const up = s % (v.length + 2);
          midi = up < v.length ? v[up] : v[v.length - 1] + 12 * (up - v.length + 1);
        }
        // A gentle accent pattern; flat velocity is the tell of a machine.
        const acc = (s % 4 === 0) ? 1 : (s % 2 === 0 ? 0.78 : 0.6);
        if (mrng() < 0.06) continue;   // occasional dropped note
        inst(t, midi, rate * bd * 1.6, 0.09 * acc, 'arp', mrng());
        if (s === 0) logNote('arp', t, midi);
      }
    }

    /* Lead — the composed phrase. */
    if (score.layers.lead > 0) {
      barNotes = composeBar(barInPhrase);
      const inst = INSTRUMENTS[score.inst.lead] || flute;
      for (const n of barNotes) {
        inst(when + n.at * bd, n.midi, n.dur * bd, 0.115, 'lead', 0.5);
        logNote('lead', when + n.at * bd, n.midi);
      }
    }

    /* Percussion. */
    const pat = score.perc;
    if (score.layers.perc > 0 && pat !== 'none') {
      if (pat === 'light') {
        drum(when, 92, 0.4, 0.16, 0.4);
        shaker(when + bd * 1.5, 0.05, 0.7);
        shaker(when + bd * 3.5, 0.04, 0.3);
        if (bar % 4 === 3) drum(when + bd * 3, 120, 0.3, 0.1, 0.6);
      } else if (pat === 'busy') {
        for (let b = 0; b < meter; b++) {
          drum(when + b * bd, b % 2 ? 130 : 86, 0.3, b % 2 ? 0.08 : 0.17, 0.35);
          shaker(when + (b + 0.5) * bd, 0.055, 0.75);
        }
        if (bar % 2 === 1) shaker(when + (meter - 0.25) * bd, 0.05, 0.2);
      } else if (pat === 'drive') {
        for (let b = 0; b < meter; b++) drum(when + b * bd, b === 0 ? 62 : 88, 0.26, b === 0 ? 0.24 : 0.12, 0.5);
        for (let s = 0; s < meter * 2; s++) shaker(when + s * bd * 0.5, 0.05, (s % 3) / 3);
      } else if (pat === 'roll') {
        for (let b = 0; b < meter; b++) {
          if (b % 3 === 0) drum(when + b * bd, 78, 0.34, 0.15, 0.45);
          else shaker(when + b * bd, 0.04, b / meter);
        }
      } else if (pat === 'ceremony') {
        if (bar % 4 === 0) { triangleHit(when, 0.10, 0.5); drum(when, 58, 0.7, 0.14, 0.5); }
        if (bar % 8 === 4) triangleHit(when + bd * 2, 0.06, 0.6);
      }
    }

    /* Open the tone filter with the music's own density. */
    const energy =
      score.layers.arp * 0.3 + score.layers.perc * 0.3 +
      score.layers.lead * 0.25 + score.layers.pad * 0.15;
    const cutoff = 1500 + energy * 5200;
    tone.frequency.cancelScheduledValues(when);
    tone.frequency.setValueAtTime(tone.frequency.value, when);
    tone.frequency.linearRampToValueAtTime(cutoff, when + barLen * 0.8);
  }

  function logNote(layer, time, midi) {
    noteEvents.push({ layer, time, midi, bar });
    if (noteEvents.length > 400) noteEvents.splice(0, noteEvents.length - 400);
  }

  /* Commit a queued context change. Called only on a bar line. */
  function commitPending() {
    if (!pending) return;
    const next = SCORES[pending.name];
    if (!next) { pending = null; return; }
    const fade = pending.fade;
    const t = actx.currentTime;

    scoreName = pending.name;
    score = next;
    meter = next.meter;
    bpmTarget = next.bpm;
    // Nothing to glide from if the transport has not started, or has
    // started but not yet scheduled its first bar.
    if (!running || !scheduled) bpm = bpmTarget;
    // Re-key: reset the progression but keep the voicing as the seed for
    // voice-leading, so the first chord of the new zone reaches for the
    // nearest notes to where we already were.
    progIdx = 0; progBarsLeft = 0;
    mrng = mulberry(seed ^ hashName(pending.name));
    newMotif();
    phraseIdx = 0;
    leadDeg = 4;

    for (const name of LAYER_NAMES) {
      const target = next.layers[name] ?? 0;
      const g = layers[name].gain;
      layers[name].target = target;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(target, t + fade);
    }
    if (reverb && next.space) reverb.setSpace(next.space, Math.max(0.8, fade));
    // heal() must not fight a cross-fade that is legitimately at zero.
    crossfadeUntil = t + fade + 0.2;
    pending = null;
  }

  function hashName(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  /* The scheduler. Called from the frame loop (and from a timer, so the
     score survives a browser throttling requestAnimationFrame).

     Three things here exist purely so that a stall becomes a short gap
     instead of permanent silence — see the LOOKAHEAD note at the top:
       1  the horizon tracks how often we are really being called;
       2  a transport that has fallen behind RE-ANCHORS onto the clock
          rather than scheduling a catch-up burst of the bars it missed
          (which is a machine-gun of sixty bars at once) or bailing;
       3  a throw inside the loop is contained. It used to take the whole
          loop with it, and a scheduler that has stopped is silence for
          the rest of the session.
     Returns the number of bars it put on the wire. */
  function tick() {
    if (!running) return 0;
    if (faultBars > 0 && faultWhere === 'tick') {
      faultBars--;
      throw new TypeError('injected: tick failed');
    }
    const now = actx.currentTime;

    /* A NON-FINITE CLOCK IS A PERMANENT, SILENT DEATH, so it is checked
       rather than assumed. Every comparison below against a NaN nextTime
       is false: the re-anchor branches do not fire, the while loop never
       runs, nothing is ever scheduled again — and `silentFor` would be
       currentTime - NaN, i.e. NaN, so the watchdog in audio.js cannot
       see it either, because `NaN > SILENT_LIMIT` is also false. One bad
       tempo anywhere upstream would wedge the score for the session with
       every flag still reading "playing". Three comparisons is a cheap
       price for closing that off. */
    if (!Number.isFinite(nextTime) || !Number.isFinite(bpm) || bpm <= 0
      || !Number.isFinite(meter) || meter < 1) {
      console.error(`[music] the transport clock went non-finite `
        + `(nextTime=${nextTime}, bpm=${bpm}, meter=${meter}) — resetting it.`);
      recover();
      return 0;
    }

    /* How far apart our ticks are actually arriving. Rises instantly (we
       must cover the worst gap we have just seen) and decays slowly. */
    if (lastTick >= 0) {
      const gap = now - lastTick;
      if (gap > 0) tickGap = gap > tickGap ? gap : tickGap * 0.9 + gap * 0.1;
    }
    lastTick = now;
    horizon = Math.min(MAX_LOOKAHEAD,
      Math.max(LOOKAHEAD, horizonFloor, tickGap * 2.5 + 0.25));

    if (nextTime < now - 0.12) {
      /* Genuinely behind — a suspended context, a stalled tab, a long GC.
         Start a clean bar from here; the bars we missed are gone and
         playing them late is worse than not playing them. */
      nextTime = now + MIN_STEP;
      beat = 0; bar++;
      reanchors++;
    } else if (nextTime < now) {
      nextTime = now + MIN_STEP;
    }

    let bars = 0, guard = 0;
    while (nextTime < now + horizon && guard++ < 512) {
      if (beat === 0) {
        try {
          // Bar line: this is the only place a context change may land.
          if (pending) commitPending();
          // Ease the tempo rather than jumping it.
          bpm += (bpmTarget - bpm) * 0.34;
          if (Math.abs(bpm - bpmTarget) < 0.4) bpm = bpmTarget;
          scheduleBar(nextTime);
          bars++;
          barFails = 0;              // a bar landed: we are audible again
        } catch (e) {
          tickErrors++;
          barFails++;
          lastError = String(e?.message || e);
          /* LOUD, BOUNDED, COUNTED — and at error level.

             This used to be three console.warns and then nothing at all,
             ever. MEASURED against this module: a bar that throws every
             time produces exactly 3 warning lines in TWO MINUTES of
             play, `silentFor` stays 0.000 the whole way (the loop still
             advances the clock, it just writes nothing to it), `running`
             stays true, and the game plays on in silence with a green
             console. That is the reported dropout, precisely. warn was
             also the wrong level: tools/shot.mjs only greps for errors,
             so no screenshot tool in tools/ would ever have failed on
             it. audio.js now reads barFails and escalates. */
          const t = Date.now();
          if (barLogs < 3 || t - lastBarLog > 10000) {
            barLogs++; lastBarLog = t;
            console.error(`[music] bar ${bar} failed to schedule `
              + `(${barFails} in a row, ${tickErrors} total) — the room is going quiet:`, e);
          }
        }
      }
      nextTime += beatDur();
      beat++;
      if (beat >= meter) { beat = 0; bar++; }
    }
    reap();
    return bars;
  }

  /* Put the transport back on the clock without trying to replay the
     past. The watchdog in audio.js calls this when the score believes it
     is playing but the wire has been empty long enough to hear. */
  function reanchor() {
    if (!running) return 0;
    resetClock();
    return tick();
  }

  function resetClock() {
    const now = actx.currentTime;
    nextTime = (Number.isFinite(now) ? now : 0) + MIN_STEP;
    beat = 0; bar++;
    lastTick = -1; tickGap = 0;
    horizon = Math.max(LOOKAHEAD, horizonFloor);
    reanchors++;
  }

  /* THE HEAVIER HAMMER, for when the score is failing every bar rather
     than merely running late. reanchor() only moves the clock; when
     scheduleBar() itself is throwing, the cause is upstream of the clock
     — a tempo, a meter, a voicing, a half-committed context change — so
     everything that could be carrying a bad value is thrown away and
     rebuilt from the score data. Deliberately cause-agnostic: the same
     argument as the watchdog's last branch in audio.js. It does NOT call
     tick() (the non-finite guard above calls this, and re-entering tick
     from inside tick is a recursion waiting for a bad day) — the next
     tick, milliseconds away, does the scheduling. */
  function recover() {
    pending = null;
    const s = SCORES[scoreName] || SCORES.explore;
    score = s;
    bpm = Number.isFinite(s.bpm) && s.bpm > 0 ? s.bpm : 80;
    bpmTarget = bpm;
    meter = Number.isFinite(s.meter) && s.meter >= 1 ? s.meter : 4;
    progIdx = 0; progBarsLeft = 0;
    voicing = null; chordPcs = []; barNotes = [];
    mrng = mulberry(seed ^ hashName(scoreName || 'explore'));
    newMotif(); phraseIdx = 0; leadDeg = 4;
    silentUntil = 0; crossfadeUntil = 0;
    scheduled = false;
    /* barFails is deliberately NOT cleared here. It means "consecutive
       bars that failed to reach the wire", and a reset does not make a
       bar land — only scheduleBar() succeeding does. Clearing it here
       would hide the symptom from the watchdog the moment the watchdog
       reacted to it, which is the same trick that lost this failure in
       the first place. */
    resetClock();
    recoveries++;
    return true;
  }

  /* The other way this goes silent: the score plays perfectly into a bus
     somebody left at zero. A cross-fade interrupted by a suspend, a
     stop() whose restore never ran, a sting that ended in the wrong
     place. Cheap to check, so check it every watchdog pass — but never
     during a fade that is legitimately in progress. */
  function heal() {
    if (!running) return false;
    const t = actx.currentTime;
    if (t < silentUntil || t < crossfadeUntil) return false;
    let fixed = null;

    if (out.gain.value < 0.02) {
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(out.gain.value, t);
      out.gain.linearRampToValueAtTime(1, t + 0.25);
      fixed = 'bus';
    }

    let want = 0, have = 0;
    for (const n of LAYER_NAMES) {
      want += layers[n].target;
      have += layers[n].gain.gain.value;
    }
    if (want > 0.05 && have < want * 0.02) {
      for (const n of LAYER_NAMES) {
        const g = layers[n].gain;
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(layers[n].target, t + 0.6);
      }
      fixed = fixed ? 'bus+layers' : 'layers';
    }
    if (fixed) console.warn(`[music] muted ${fixed} while playing — restored`);
    return !!fixed;
  }

  /* --- stings ---
     Short cinematic gestures that sit above the score and are not part of
     the transport. They use the same instruments so they belong. */
  const STINGS = {
    title:    { midis: [50, 57, 62, 66, 69, 74], inst: 'horn', step: 0.16, dur: 2.4, gain: 0.24, roll: 'harp' },
    discover: { midis: [67, 71, 74, 79], inst: 'glass', step: 0.11, dur: 1.6, gain: 0.20 },
    quest:    { midis: [62, 66, 69, 74], inst: 'harp', step: 0.09, dur: 1.4, gain: 0.20 },
    victory:  { midis: [60, 64, 67, 72, 76, 79], inst: 'horn', step: 0.10, dur: 1.5, gain: 0.22 },
    fail:     { midis: [58, 55, 51, 46], inst: 'horn', step: 0.15, dur: 1.2, gain: 0.20 },
    money:    { midis: [72, 76, 79, 84], inst: 'glass', step: 0.07, dur: 1.1, gain: 0.18 },
    dawn:     { midis: [60, 64, 71, 76], inst: 'glass', step: 0.22, dur: 2.6, gain: 0.14 },
    dusk:     { midis: [57, 60, 64, 67], inst: 'glass', step: 0.26, dur: 3.0, gain: 0.13 },
  };

  function sting(name = 'title') {
    const s = STINGS[name] || STINGS.discover;
    const t0 = actx.currentTime + 0.04;
    const inst = INSTRUMENTS[s.inst] || horn;
    for (let i = 0; i < s.midis.length; i++) {
      inst(t0 + i * s.step, s.midis[i], s.dur - i * s.step * 0.4, s.gain, 'lead', i / s.midis.length);
      logNote('sting', t0 + i * s.step, s.midis[i]);
    }
    if (s.roll) {
      const r = INSTRUMENTS[s.roll];
      for (let i = 0; i < 8; i++) r(t0 + i * 0.05, s.midis[0] + 12 + i * 2, 1.4, 0.07, 'arp', i / 8);
    }
    // Make sure the sting is audible even from a silent context.
    const lg = layers.lead.gain;
    if (lg.gain.value < 0.5) {
      const t = actx.currentTime;
      lg.gain.cancelScheduledValues(t);
      lg.gain.setValueAtTime(lg.gain.value, t);
      lg.gain.linearRampToValueAtTime(0.85, t + 0.15);
      lg.gain.setValueAtTime(0.85, t + s.dur);
      lg.gain.linearRampToValueAtTime(layers.lead.target, t + s.dur + 1.2);
    }
    return engine;
  }

  /* --- public engine --- */
  const engine = {
    out,
    get context() { return scoreName; },
    get pending() { return pending?.name ?? null; },
    get bar() { return bar; },
    get beat() { return beat; },
    get bpm() { return bpm; },
    get running() { return running; },
    get voices() { return voiceCount(); },
    get notes() { return noteEvents; },
    get chord() { return voicing ? voicing.slice() : []; },
    contexts: CONTEXT_NAMES,

    start(at = actx.currentTime + 0.06) {
      if (running) return engine;
      running = true;
      scheduled = false;
      nextTime = at;
      bar = 0; beat = 0;
      bpm = bpmTarget;
      lastTick = -1; tickGap = 0;
      /* A restart after stop() has to take the bus back: stop() ramped it
         down, and a transport playing into a muted bus is still silence. */
      const t = actx.currentTime;
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(out.gain.value, t);
      out.gain.linearRampToValueAtTime(1, t + 0.12);
      silentUntil = 0;
      crossfadeUntil = 0;
      return engine;
    },

    /** Queue a context. It lands on the next bar line and cross-fades. */
    setContext(name, { fade = 2.4, immediate = false } = {}) {
      if (!SCORES[name]) return engine;
      if (name === scoreName && !pending) return engine;
      pending = { name, fade: Math.max(0.05, fade) };
      // Before the transport runs there is no bar line to wait for, so an
      // early context change simply becomes the starting score.
      if (immediate || !running || bar === 0) commitPending();
      return engine;
    },

    /** How long until the queued change lands (seconds). */
    timeToBar() {
      const remaining = (meter - beat) % meter || meter;
      return Math.max(0, nextTime - actx.currentTime) + (remaining - 1) * beatDur();
    },

    tick,
    update() { tick(); },
    reanchor,
    recover,
    heal,

    /* --- scheduler health, for the watchdog and for audiotest.mjs ---
       `silentFor` is the one that matters: seconds of context clock that
       have passed the far edge of what the scheduler has actually
       written. Zero while the score is playing, and growing means the
       room is quiet no matter what `running` says. */
    get silentFor() {
      if (!running) return 0;
      /* A wedged clock IS silence, and it must not read as health.
         Returning NaN here (which currentTime - NaN does) made every
         comparison in the watchdog false, so the one number that exists
         to say "the room is quiet" reported the quietest possible room
         as fine. Infinity is the truth and it compares correctly. */
      if (!Number.isFinite(nextTime)) return Infinity;
      return Math.max(0, actx.currentTime - nextTime);
    },
    get scheduledThrough() { return nextTime; },
    get horizon() { return horizon; },
    get tickGap() { return tickGap; },
    get reanchors() { return reanchors; },
    /** How many voice records are still held. Watch this over a long
        session: it must track what is sounding, not what has ever sounded. */
    get tracked() { return live.length; },
    get errors() { return tickErrors; },
    /** Bars that have failed IN A ROW. Non-zero means the room is silent
        right now, whatever `running` and `silentFor` say — this is the
        only symptom a throwing scheduleBar() produces. audio.js watches
        it every frame. */
    get barFails() { return barFails; },
    get recoveries() { return recoveries; },
    get lastError() { return lastError; },

    /** Raise the floor under the look-ahead (audio.js does this while the
        document is hidden, where our clocks are clamped to 1 s). 0 or
        less restores the measured behaviour. */
    setHorizon(sec) {
      horizonFloor = Math.max(0, Math.min(MAX_LOOKAHEAD, +sec || 0));
      return engine;
    },

    /** TEST HOOK. Leave the transport believing it is playing while the
        wire runs dry — exactly the state a throttled-away tab returns in.
        The watchdog must notice and re-anchor. */
    stall(seconds = 3) {
      if (!running) return null;
      nextTime = actx.currentTime - Math.max(0, seconds);
      lastTick = -1;
      return { silentFor: engine.silentFor, bar };
    },

    /** TEST HOOK. Make the next `n` bars (or ticks, with where='tick')
        throw. A real browser throws in exactly this place — every Web
        Audio param setter rejects a non-finite value with a TypeError —
        so this reproduces the failure rather than standing in for it.
        tools/audiotest.mjs PASS F uses it to prove the module reports
        and recovers instead of going quiet. `true` means forever. */
    injectFault(n = 8, where = 'bar') {
      faultBars = n === true ? Infinity : Math.max(0, Number(n) || 0);
      faultWhere = where === 'tick' ? 'tick' : 'bar';
      return { bars: faultBars, where: faultWhere };
    },
    clearFault() { faultBars = 0; barFails = 0; barLogs = 0; return engine; },

    /** 0..1 voice budget. `low` quality gets a thinner arrangement of the
        same piece, never a different one. */
    setDetail(v) { detail = Math.max(0, Math.min(1, v)); return engine; },
    get detail() { return detail; },

    /** Stop scheduling. Sounding voices are allowed to finish (fade), so
        this never produces a click; `hard` cuts the bus instead. */
    stop({ fade = 1.5, hard = false } = {}) {
      running = false;
      scheduled = false;
      const t = actx.currentTime;
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(out.gain.value, t);
      out.gain.linearRampToValueAtTime(0.0001, t + (hard ? 0.02 : fade));
      out.gain.setValueAtTime(1, t + (hard ? 0.03 : fade) + 0.01);
      silentUntil = t + (hard ? 0.03 : fade) + 0.1;
      for (const n of LAYER_NAMES) {
        const g = layers[n].gain;
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0, t + (hard ? 0.02 : fade));
      }
      scoreName = 'silence'; score = SCORES.silence; pending = null;
      return engine;
    },

    sting,
    stings: Object.keys(STINGS),

    /** Debug/telemetry: which layers are currently sounding and how loud. */
    layerGains() {
      const o = {};
      for (const n of LAYER_NAMES) o[n] = +layers[n].gain.gain.value.toFixed(3);
      return o;
    },

    dispose() {
      running = false;
      try {
        for (const n of LAYER_NAMES) { layers[n].gain.disconnect(); layers[n].send.disconnect(); }
        tone.disconnect(); warmth.disconnect(); out.disconnect();
      } catch { /* graph already torn down */ }
      live.length = 0;
      noteEvents.length = 0;
    },
  };

  return engine;
}

/* Shared noise buffer factory — one 2-second buffer, reused by every
   breath, mallet click and shaker in the score. */
function makeNoise(actx) {
  let buf = null;
  return {
    get buffer() {
      if (!buf) {
        const len = Math.floor((actx.sampleRate || 44100) * 2);
        buf = actx.createBuffer(1, len, actx.sampleRate || 44100);
        const d = buf.getChannelData(0);
        let a = 0x1234abcd;
        for (let i = 0; i < len; i++) {
          a |= 0; a = (a + 0x6d2b79f5) | 0;
          let t = Math.imul(a ^ (a >>> 15), 1 | a);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          d[i] = ((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1) * 0.7;
        }
      }
      return buf;
    },
    source(when, dur) {
      const s = actx.createBufferSource();
      s.buffer = this.buffer;
      // Random offset so repeated hits are not identical.
      const off = (when * 7.13) % 1.6;
      s.start(when, off, Math.max(0.02, dur + 0.05));
      return s;
    },
  };
}
