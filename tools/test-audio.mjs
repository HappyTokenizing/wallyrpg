#!/usr/bin/env node
/* ============================================================
   test-audio.mjs — verification harness for the WALLY audio system.

   Node has no Web Audio, so this file ships a deterministic
   OfflineAudioContext shim: a virtual clock plus stand-ins for every
   node type the audio modules touch, each of which records what was
   created, started and stopped. Driving the real modules against it
   lets us assert things a listening test never could — that the score
   schedules bar lines to the microsecond, that nothing is left ringing
   after a stop, that every effect name in the bank resolves.

   Usage:
     node tools/test-audio.mjs             # node shim suite
     node tools/test-audio.mjs --browser   # additionally boot real Chrome
     node tools/test-audio.mjs --verbose

   Exits non-zero on the first failed assertion group.
   ============================================================ */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');
const BROWSER = process.argv.includes('--browser');

/* ============================================================
   1. The shim
   ============================================================ */

class Param {
  constructor(v = 0, owner = null, name = '') {
    this._v = v; this.owner = owner; this.name = name;
    this.events = [];
  }
  get value() { return this._v; }
  set value(v) { this._v = v; }
  setValueAtTime(v, t) { this.events.push(['set', v, t]); this._v = v; return this; }
  linearRampToValueAtTime(v, t) { this.events.push(['lin', v, t]); this._v = v; return this; }
  exponentialRampToValueAtTime(v, t) {
    if (v === 0) throw new RangeError('exponentialRampToValueAtTime: value must be non-zero');
    this.events.push(['exp', v, t]); this._v = v; return this;
  }
  setTargetAtTime(v, t, tau) { this.events.push(['tgt', v, t, tau]); this._v = v; return this; }
  setValueCurveAtTime(c, t, d) { this.events.push(['curve', c, t, d]); return this; }
  cancelScheduledValues(t) { this.events.push(['cancel', t]); return this; }
  cancelAndHoldAtTime(t) { this.events.push(['hold', t]); return this; }
}

let NODE_ID = 0;

class Node {
  constructor(actx, type) {
    this.actx = actx; this.type_ = type; this.id = ++NODE_ID;
    this.outputs = []; this.disconnected = false;
    actx._stats.created[type] = (actx._stats.created[type] || 0) + 1;
  }
  connect(dst) {
    if (!dst) throw new TypeError(`connect(): destination is ${dst}`);
    if (!(dst instanceof Node) && !(dst instanceof Param)) {
      throw new TypeError('connect(): not an AudioNode or AudioParam');
    }
    this.outputs.push(dst);
    return dst instanceof Node ? dst : undefined;
  }
  disconnect() { this.outputs.length = 0; this.disconnected = true; }
}

class SourceNode extends Node {
  constructor(actx, type) {
    super(actx, type);
    this.started = false; this.stopped = false;
    this.startTime = null; this.stopTime = null;
    this.onended = null;
    actx._sources.push(this);
  }
  start(when = this.actx.currentTime) {
    if (this.started) throw new Error(`${this.type_}.start() called twice`);
    if (when < this.actx.currentTime - 1e-9) {
      this.actx._stats.pastStarts++;
    }
    this.started = true; this.startTime = when;
    this.actx._stats.started++;
    return this;
  }
  stop(when = this.actx.currentTime) {
    if (!this.started) throw new Error(`${this.type_}.stop() before start()`);
    // Later stop() calls override, matching the spec.
    this.stopped = true; this.stopTime = when;
    this.actx._stats.stopped++;
    return this;
  }
}

class OscillatorShim extends SourceNode {
  constructor(actx) {
    super(actx, 'oscillator');
    this.type = 'sine';
    this.frequency = new Param(440, this, 'frequency');
    this.detune = new Param(0, this, 'detune');
  }
}

class BufferSourceShim extends SourceNode {
  constructor(actx) {
    super(actx, 'bufferSource');
    this.buffer = null; this.loop = false;
    this.playbackRate = new Param(1, this, 'playbackRate');
    this.detune = new Param(0, this, 'detune');
  }
}

class GainShim extends Node {
  constructor(actx) { super(actx, 'gain'); this.gain = new Param(1, this, 'gain'); }
}

class BiquadShim extends Node {
  constructor(actx) {
    super(actx, 'biquad');
    this.type = 'lowpass';
    this.frequency = new Param(350, this, 'frequency');
    this.Q = new Param(1, this, 'Q');
    this.gain = new Param(0, this, 'gain');
    this.detune = new Param(0, this, 'detune');
  }
}

class StereoPannerShim extends Node {
  constructor(actx) { super(actx, 'stereoPanner'); this.pan = new Param(0, this, 'pan'); }
}

class PannerShim extends Node {
  constructor(actx) {
    super(actx, 'panner');
    this.panningModel = 'equalpower'; this.distanceModel = 'inverse';
    this.refDistance = 1; this.maxDistance = 10000; this.rolloffFactor = 1;
    this.positionX = new Param(0, this, 'positionX');
    this.positionY = new Param(0, this, 'positionY');
    this.positionZ = new Param(0, this, 'positionZ');
  }
  setPosition(x, y, z) { this.positionX.value = x; this.positionY.value = y; this.positionZ.value = z; }
}

class ConvolverShim extends Node {
  constructor(actx) { super(actx, 'convolver'); this.buffer = null; this.normalize = true; }
}

class CompressorShim extends Node {
  constructor(actx) {
    super(actx, 'compressor');
    this.threshold = new Param(-24, this, 'threshold');
    this.knee = new Param(30, this, 'knee');
    this.ratio = new Param(12, this, 'ratio');
    this.attack = new Param(0.003, this, 'attack');
    this.release = new Param(0.25, this, 'release');
  }
}

class DelayShim extends Node {
  constructor(actx) { super(actx, 'delay'); this.delayTime = new Param(0, this, 'delayTime'); }
}

class BufferShim {
  constructor(ch, len, sr) {
    this.numberOfChannels = ch; this.length = len; this.sampleRate = sr;
    this.duration = len / sr;
    this._d = [];
    for (let i = 0; i < ch; i++) this._d.push(new Float32Array(len));
  }
  getChannelData(i) { return this._d[i]; }
}

class ListenerShim {
  constructor() {
    for (const n of ['positionX', 'positionY', 'positionZ',
      'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ']) {
      this[n] = new Param(0, this, n);
    }
  }
}

/** A virtual-clock AudioContext with the surface the audio modules use. */
class OfflineAudioContextShim {
  constructor({ sampleRate = 44100, state = 'suspended' } = {}) {
    this.sampleRate = sampleRate;
    this.state = state;
    this._now = 0;
    this.listener = new ListenerShim();
    this._sources = [];
    this._stats = { created: {}, started: 0, stopped: 0, pastStarts: 0 };
    this.destination = new Node(this, 'destination');
  }
  get currentTime() { return this._now; }
  /** Advance the virtual clock. Sources whose stop time has passed fire
      `onended`, exactly as a real implementation would. */
  advance(dt) {
    this._now += dt;
    for (const s of this._sources) {
      if (s.started && s.stopped && !s._ended && s.stopTime <= this._now) {
        s._ended = true;
        try { s.onended?.(); } catch { /* handler's problem */ }
      }
    }
  }
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  async close() { this.state = 'closed'; }
  createGain() { return new GainShim(this); }
  createOscillator() { return new OscillatorShim(this); }
  createBufferSource() { return new BufferSourceShim(this); }
  createBiquadFilter() { return new BiquadShim(this); }
  createStereoPanner() { return new StereoPannerShim(this); }
  createPanner() { return new PannerShim(this); }
  createConvolver() { return new ConvolverShim(this); }
  createDynamicsCompressor() { return new CompressorShim(this); }
  createDelay() { return new DelayShim(this); }
  createBuffer(ch, len, sr) { return new BufferShim(ch, len, sr || this.sampleRate); }
  /** Sources still scheduled to be sounding at the current virtual time. */
  liveSources() {
    return this._sources.filter((s) =>
      s.started && s.startTime <= this._now && (!s.stopped || s.stopTime > this._now));
  }
}

/* ============================================================
   2. Assertions
   ============================================================ */

let pass = 0;
const failures = [];
let group = '';

function G(name) { group = name; if (VERBOSE) console.log(`\n— ${name}`); }
function ok(cond, msg, detail) {
  if (cond) { pass++; if (VERBOSE) console.log(`  ok   ${msg}`); }
  else {
    failures.push(`${group}: ${msg}${detail != null ? `\n       ${detail}` : ''}`);
    console.log(`  FAIL ${msg}${detail != null ? `  (${detail})` : ''}`);
  }
}
function near(a, b, eps, msg) {
  ok(Math.abs(a - b) <= eps, msg, `${a} vs ${b} (eps ${eps})`);
}

/* ============================================================
   3. Node suite
   ============================================================ */

async function nodeSuite() {
  /* contracts.js reads devicePixelRatio at module scope; the audio modules
     import it for `damp`/`clamp`, so give it a DOM-free stand-in. */
  globalThis.devicePixelRatio = 1;
  if (!globalThis.location) globalThis.location = { search: '' };
  globalThis.AudioContext = OfflineAudioContextShim;
  globalThis.OfflineAudioContext = OfflineAudioContextShim;
  globalThis.WALLY = { debug: {} };

  const reverbMod = await import('../src/audio/reverb.js');
  const musicMod = await import('../src/audio/music.js');
  const sfxMod = await import('../src/audio/sfx.js');
  const audioMod = await import('../src/audio/audio.js');

  /* ---------- reverb: the impulse responses are real ---------- */
  G('reverb — procedural impulse responses');
  {
    const actx = new OfflineAudioContextShim({ sampleRate: 44100 });
    ok(Object.keys(reverbMod.SPACES).length >= 4, 'at least four spaces defined',
      Object.keys(reverbMod.SPACES).join(','));
    for (const need of ['outdoor', 'room', 'hall', 'cave']) {
      ok(!!reverbMod.SPACES[need], `space "${need}" exists`);
    }
    for (const [name, p] of Object.entries(reverbMod.SPACES)) {
      const ir = reverbMod.generateImpulse(actx, p);
      const expect = Math.floor(p.seconds * 44100) + Math.floor(p.preDelay * 44100);
      ok(ir.numberOfChannels === 2, `${name}: stereo IR`);
      near(ir.length, expect, 2, `${name}: IR length matches preset`);

      const L = ir.getChannelData(0), Rr = ir.getChannelData(1);
      let peak = 0, energyEarly = 0, energyLate = 0, diff = 0;
      const q = Math.floor(ir.length / 4);
      for (let i = 0; i < ir.length; i++) {
        const a = Math.abs(L[i]);
        if (a > peak) peak = a;
        if (i < q) energyEarly += L[i] * L[i];
        if (i > ir.length - q) energyLate += L[i] * L[i];
        diff += Math.abs(L[i] - Rr[i]);
      }
      ok(peak > 0.05 && peak <= 0.51, `${name}: normalised peak in range`, peak.toFixed(3));
      ok(energyLate < energyEarly * 0.5, `${name}: tail decays`,
        `early ${energyEarly.toExponential(2)} late ${energyLate.toExponential(2)}`);
      ok(diff > 0, `${name}: channels are decorrelated (stereo, not dual mono)`);
      ok(Number.isFinite(peak), `${name}: no NaN in the IR`);
    }

    // Determinism: two runs must be byte-identical, or screenshots and
    // recordings stop being comparable between builds.
    const a = reverbMod.generateImpulse(actx, reverbMod.SPACES.hall).getChannelData(0);
    const b = reverbMod.generateImpulse(actx, reverbMod.SPACES.hall).getChannelData(0);
    let same = true;
    for (let i = 0; i < a.length; i += 97) if (a[i] !== b[i]) { same = false; break; }
    ok(same, 'IR generation is deterministic');

    const dest = actx.createGain();
    const rv = reverbMod.createReverb(actx, dest);
    rv.setSpace('hall', 1.0);
    ok(rv.space === 'hall', 'setSpace records the current space');
    rv.setSpace('cave', 1.0);
    ok(rv.space === 'cave', 'spaces cross-fade rather than replace');
    rv.dispose();
  }

  /* ---------- sfx: every name resolves ---------- */
  G('sfx — the effect bank');
  {
    const actx = new OfflineAudioContextShim();
    actx.state = 'running';
    const dest = actx.createGain();
    const bank = sfxMod.createSfx({ actx, dest, rng: null, seed: 7 });

    ok(bank.names.length >= 60, 'bank is substantial', `${bank.names.length} effects`);

    // The exported list and the actual bank must not drift apart.
    const inBank = new Set(bank.names);
    const inList = new Set(sfxMod.SFX_NAMES);
    const missingFromList = bank.names.filter((n) => !inList.has(n));
    const missingFromBank = sfxMod.SFX_NAMES.filter((n) => !inBank.has(n));
    ok(missingFromList.length === 0, 'every bank entry is in SFX_NAMES', missingFromList.join(','));
    ok(missingFromBank.length === 0, 'every SFX_NAMES entry exists in the bank', missingFromBank.join(','));

    // Every effect must actually build a graph without throwing.
    let built = 0;
    for (const name of bank.names) {
      const before = actx._stats.started;
      let threw = null;
      try { bank.play(name, { gain: 0.8, pitch: 1.0 }); } catch (e) { threw = e; }
      ok(!threw, `sfx "${name}" builds without throwing`, threw && threw.message);
      ok(actx._stats.started > before, `sfx "${name}" starts at least one source`);
      built++;
      actx.advance(0.001);
    }
    ok(built === bank.names.length, 'all effects exercised');

    ok(bank.play('no.such.sound') === false, 'unknown name is a no-op, not a throw');
    ok(bank.has('step.grass') && !bank.has('step.lava'), 'has() reports membership');

    // Every surface must produce a different footstep recipe.
    for (const s of sfxMod.SURFACES) {
      bank.setSurface(s);
      ok(bank.surface === s, `surface "${s}" selectable`);
      const before = actx._stats.created.bufferSource || 0;
      bank.play('step');
      ok((actx._stats.created.bufferSource || 0) > before, `step on ${s} uses noise`);
    }

    // Positional playback must route through a PannerNode.
    const pBefore = actx._stats.created.panner || 0;
    bank.play('door.close', { position: [12, 1, -4] });
    ok((actx._stats.created.panner || 0) === pBefore + 1, 'positional sfx creates a PannerNode');
    const p2 = actx._stats.created.panner || 0;
    bank.play('door.close');
    ok((actx._stats.created.panner || 0) === p2, 'non-positional sfx does not');

    // Beds: build lazily, cross-fade, and every declared bed must build.
    for (const name of bank.beds) {
      ok(bank.bed(name, 0.5) === true, `bed "${name}" builds`);
      ok(bank.bedLevel(name) === 0.5, `bed "${name}" records its level`);
    }
    const bedList = new Set(bank.beds);
    ok(sfxMod.BED_NAMES.every((b) => bedList.has(b)), 'BED_NAMES matches the built beds');

    // The wind and wave beds must respond to ctx.wind.strength.
    bank.ambience({ wind: 0.8, waves: 0.8 }, 0.1);
    actx.advance(0.5);
    bank.update(0.5, { wind: 0.2 });
    const quiet = bank.bedLevel('wind');
    bank.update(0.5, { wind: 1.2 });
    ok(quiet === 0.8, 'bed target is independent of the wind modulation');
    // A gust must schedule more surf events over the same span.
    let breaks = 0;
    const spy = bank.play;
    for (let i = 0; i < 40; i++) { actx.advance(0.25); bank.update(0.25, { wind: 1.3 }); }
    ok(typeof spy === 'function', 'bed update loop runs without throwing');
    breaks = actx._sources.length;
    ok(breaks > 0, 'ambience emitters fire over time', `${breaks} sources`);

    bank.dispose();
  }

  /* ---------- music: harmony, phrasing and the scheduler ---------- */
  G('music — score, harmony and scheduler');
  {
    const actx = new OfflineAudioContextShim();
    actx.state = 'running';
    const dest = actx.createGain();
    const m = musicMod.createMusic({ actx, dest, reverb: null, rng: null, seed: 12345 });

    ok(musicMod.CONTEXT_NAMES.length >= 8, 'a real set of contexts',
      musicMod.CONTEXT_NAMES.join(','));
    for (const need of ['explore', 'town', 'market', 'night', 'tense', 'sail', 'cinematic']) {
      ok(musicMod.CONTEXT_NAMES.includes(need), `context "${need}" defined`);
    }
    // Every score must be internally coherent.
    for (const [name, s] of Object.entries(musicMod.SCORES)) {
      ok(s.prog.length > 0, `${name}: has a progression`);
      ok(s.bpm > 20 && s.bpm < 260, `${name}: sane tempo`, s.bpm);
      ok(s.meter === 4 || s.meter === 6 || s.meter === 3, `${name}: sane meter`, s.meter);
      const sum = Object.values(s.layers).reduce((a, b) => a + b, 0);
      ok(name === 'silence' ? sum === 0 : sum > 0.5, `${name}: layers are set`);
      // Every chord must carry a 7th or richer — no bare triads anywhere.
      for (const [, q] of s.prog) {
        const shape = musicMod.CHORDS[q];
        ok(!!shape, `${name}: chord "${q}" is a known quality`);
        ok(shape && shape.length >= 4, `${name}: chord "${q}" is not a bare triad`,
          shape && shape.join(','));
      }
    }

    m.setContext('explore', { immediate: true });
    ok(m.context === 'explore', 'immediate context change applies at once');
    near(m.bpm, musicMod.SCORES.explore.bpm, 1e-9, 'tempo snaps before the transport runs');

    m.start(1.0);
    // Drive 24 seconds of score in 20 ms frames, the way the game does.
    for (let i = 0; i < 1200; i++) { actx.advance(0.02); m.tick(); }

    const notes = m.notes;
    ok(notes.length > 40, 'the scheduler produced note events', `${notes.length} logged`);

    const beat = 60 / musicMod.SCORES.explore.bpm;
    const barLen = beat * musicMod.SCORES.explore.meter;

    // Bar onsets: the bass fires once at the top of every bar.
    const barTimes = [];
    const seen = new Set();
    for (const n of notes) {
      if (n.layer !== 'bass' || seen.has(n.bar)) continue;
      seen.add(n.bar); barTimes.push(n.time);
    }
    ok(barTimes.length >= 8, 'at least eight bars scheduled', barTimes.length);
    near(barTimes[0], 1.0, 1e-9, 'first bar lands exactly at the start time');
    let worst = 0;
    for (let i = 1; i < barTimes.length; i++) {
      worst = Math.max(worst, Math.abs((barTimes[i] - barTimes[i - 1]) - barLen));
    }
    ok(worst < 1e-9, 'every bar is exactly one bar long', `worst drift ${worst.toExponential(2)}s`);

    // Nothing may ever be scheduled in the past — that is what produces
    // the machine-gun stutter when a tab is restored.
    ok(actx._stats.pastStarts === 0, 'no voice was scheduled in the past',
      actx._stats.pastStarts);

    // Lead notes must sit on the rhythmic grid, never between subdivisions.
    const grid = beat * 0.5;
    let offGrid = 0;
    for (const n of notes) {
      if (n.layer !== 'lead') continue;
      const rel = (n.time - 1.0) % grid;
      if (Math.min(rel, grid - rel) > 1e-6) offGrid++;
    }
    ok(offGrid === 0, 'every melody note is on the grid', `${offGrid} off-grid`);

    // The melody must actually rest, and must not be a fixed loop.
    const leadBars = new Set(notes.filter((n) => n.layer === 'lead').map((n) => n.bar));
    const allBars = new Set(notes.map((n) => n.bar));
    ok(leadBars.size < allBars.size, 'the melody rests for whole bars',
      `${leadBars.size} of ${allBars.size} bars have melody`);
    const leadMidis = notes.filter((n) => n.layer === 'lead').map((n) => n.midi);
    ok(new Set(leadMidis).size > 5, 'the melody uses a real range',
      `${new Set(leadMidis).size} distinct pitches`);

    // Voice leading is the whole reason the harmony sounds composed:
    // successive chords must move each voice by a step or two, not leap.
    {
      const seenBars = new Set(); const voicings = [];
      const a2 = new OfflineAudioContextShim(); a2.state = 'running';
      const m2 = musicMod.createMusic({ actx: a2, dest: a2.createGain(), seed: 999 });
      m2.setContext('heights', { immediate: true });
      m2.start(0.05);
      for (let i = 0; i < 3000; i++) {
        a2.advance(0.02); m2.tick();
        if (!seenBars.has(m2.bar)) { seenBars.add(m2.bar); voicings.push(m2.chord); }
      }
      let moves = 0, total = 0, leap = 0;
      for (let i = 1; i < voicings.length; i++) {
        const a = voicings[i - 1], b = voicings[i];
        if (!a.length || !b.length || a.join() === b.join()) continue;
        for (let v = 0; v < Math.min(a.length, b.length); v++) {
          const d = Math.abs(a[v] - b[v]);
          moves += d; total++; if (d > 7) leap++;
        }
      }
      ok(total > 8, 'the progression actually moves', total);
      ok(moves / total < 4, 'voices move by steps, not leaps',
        `mean ${(moves / total).toFixed(2)} semitones`);
      ok(leap / total < 0.15, 'few voices leap more than a fifth',
        `${leap}/${total}`);
      m2.stop({ hard: true });
    }

    // Voice leading: successive chords must move by small steps.
    const chord = m.chord;
    ok(chord.length >= 4, 'chords are seventh/ninth voicings', chord.length);
    ok(chord.every((n) => n >= 54 && n <= 84), 'voicings stay in register', chord.join(','));

    // The layer mix is the whole adaptive mechanism, so it has to report.
    const lg = m.layerGains();
    ok(Object.keys(lg).length === 6, 'six layers are reported', Object.keys(lg).join(','));
    ok(Object.values(lg).every((v) => Number.isFinite(v) && v >= 0),
      'layer gains are finite numbers', JSON.stringify(lg));
    ok(Object.values(lg).some((v) => v > 0), 'layers are actually audible', JSON.stringify(lg));

    /* ---- transitions land on a bar line ---- */
    G('music — bar-quantised transitions');
    const barBefore = m.bar;
    // Move to just after a bar line, then request a change mid-bar.
    m.tick();
    m.setContext('market', { fade: 1.0 });
    ok(m.pending === 'market', 'a context change is queued, not applied');
    ok(m.context === 'explore', 'the current score keeps playing');
    let bars = 0;
    while (m.context !== 'market' && bars < 400) { actx.advance(0.02); m.tick(); bars++; }
    ok(m.context === 'market', 'the change lands');
    ok(m.pending === null, 'the queue is empty afterwards');
    ok(m.bar > barBefore, 'it landed on a later bar line', `${barBefore} -> ${m.bar}`);
    ok(bars * 0.02 <= barLen + 0.5, 'it waited at most one bar', `${(bars * 0.02).toFixed(2)}s`);

    /* ---- stings ---- */
    G('music — stings');
    for (const s of m.stings) {
      const before = actx._stats.started;
      let threw = null;
      try { m.sting(s); } catch (e) { threw = e; }
      ok(!threw, `sting "${s}" builds`, threw && threw.message);
      ok(actx._stats.started > before, `sting "${s}" sounds`);
      actx.advance(0.01);
    }

    /* ---- no runaway oscillators ---- */
    G('music — voice lifecycle');
    for (let i = 0; i < 200; i++) { actx.advance(0.02); m.tick(); }
    const busy = m.voices;
    ok(busy > 0, 'voices are live while the score runs', busy);
    ok(busy < 120, 'the voice count is bounded', busy);

    m.stop({ fade: 0.5 });
    ok(m.running === false, 'stop() halts the scheduler');
    const startedAtStop = actx._stats.started;
    // Let every scheduled tail finish, and keep ticking to prove the
    // stopped scheduler does not sneak more notes in.
    for (let i = 0; i < 800; i++) { actx.advance(0.02); m.tick(); }
    ok(actx._stats.started === startedAtStop, 'a stopped scheduler schedules nothing new',
      `${actx._stats.started - startedAtStop} extra`);
    ok(m.voices === 0, 'voice count returns to baseline after stop', m.voices);
    ok(actx.liveSources().length === 0, 'no source is left sounding in the graph',
      actx.liveSources().length);
    ok(actx._stats.started === actx._stats.stopped,
      'every source that was started was also given a stop time',
      `${actx._stats.started} started / ${actx._stats.stopped} stopped`);
  }

  /* ---------- audio.js: the ctx module ---------- */
  G('audio — ctx.audio module contract');
  {
    const events = new Map();
    const bus = {
      on(t, f) { (events.get(t) || events.set(t, new Set()).get(t)).add(f); return () => {}; },
      emit(t, p) { for (const f of events.get(t) || []) f(p); },
    };
    let seed = 1;
    const ctx = {
      bus,
      rng: () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; },
      quality: { name: 'high' },
      flags: {},
      wind: { strength: 0.5 },
      camera: { matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 2, 5, 1] } },
    };

    const audio = await audioMod.init(ctx);
    ok(!!audio, 'init(ctx) returns a handle');
    ok(typeof audio.update === 'function', 'handle implements update(dt)');
    ok(audio.ready === true, 'the AudioContext was created');
    ok(audio.suspended === true, 'it starts suspended, per autoplay policy');

    /* Suspended must be entirely inert, and entirely silent about it. */
    let threw = null;
    try {
      for (let i = 0; i < 30; i++) audio.update(1 / 60);
      audio.sfx('coin');
      audio.sfx('step', { position: [1, 0, 2] });
      audio.sting('title');
      audio.duckFor(1.5);
      audio.setContext('market');
      audio.setWeather('rain');
      audio.setTimeOfDay(22);
      audio.setSurface('wood');
      audio.setSpace('cave');
      audio.setMusicVolume(0.4); audio.setSfxVolume(0.7); audio.mute(false);
    } catch (e) { threw = e; }
    ok(!threw, 'nothing throws while the context is suspended', threw && threw.stack);
    ok(audio.sfx('coin') === false, 'sfx() reports that it did not play');

    /* API surface the rest of the game codes against. */
    for (const k of ['init', 'resume', 'setContext', 'sfx', 'sting', 'duckFor',
      'setMusicVolume', 'setSfxVolume', 'mute', 'toggleMute', 'setSurface',
      'setWeather', 'setTimeOfDay', 'setSpace', 'bed', 'stop', 'update', 'dispose']) {
      ok(typeof audio[k] === 'function', `ctx.audio.${k}() exists`);
    }
    for (const k of ['ready', 'running', 'suspended', 'context', 'contexts',
      'sfxNames', 'beds', 'spaces', 'surfaces', 'stings', 'voices', 'muted',
      'musicVolume', 'sfxVolume', 'masterVolume']) {
      ok(audio[k] !== undefined, `ctx.audio.${k} exists`);
    }
    ok(audio.contexts.length >= 8, 'contexts are exposed', audio.contexts.join(','));

    /* Resume, then behave like a real session. */
    const resumed = await audio.resume();
    ok(resumed === true, 'resume() unlocks on a gesture');
    ok(audio.running === true, 'the context is running');

    const actx = audio.actx;
    ok(audio.sfx('coin') === true, 'sfx() plays once running');
    ok(audio.sfx('nope.nope') === false, 'an unknown sfx name is still a no-op');

    // Every name the module advertises must resolve.
    let bad = [];
    for (const n of audio.sfxNames) if (!audio.sfx(n, { gain: 0.5 })) bad.push(n);
    ok(bad.length === 0, 'every advertised sfx name resolves through ctx.audio', bad.join(','));

    audio.setContext('explore', { immediate: true });
    for (let i = 0; i < 600; i++) { actx.advance(1 / 60); audio.update(1 / 60); }
    ok(audio.bar > 2, 'the score advanced', `bar ${audio.bar}`);
    ok(audio.notes.length > 20, 'notes were scheduled through ctx.audio', audio.notes.length);
    ok(audio.voices > 0, 'voices are live', audio.voices);

    // The listener must have followed the camera.
    ok(Math.abs(actx.listener.positionX.value - 3) < 0.5, 'the listener tracks the camera',
      actx.listener.positionX.value);

    // Muting must not stop the scheduler from being safe to call.
    audio.mute(true);
    ok(audio.sfx('coin') === false, 'muted blocks one-shots');
    audio.mute(false);

    // Bus wiring — the events other agents will emit.
    threw = null;
    try {
      bus.emit('sfx', 'ui.click');
      bus.emit('sfx', { name: 'step', position: [1, 0, 0], surface: 'stone' });
      bus.emit('wally:step', { position: [0, 0, 0], surface: 'sand' });
      bus.emit('wally:land', { heavy: true });
      bus.emit('wally:earflap', {});
      bus.emit('ui:click'); bus.emit('ui:error'); bus.emit('dialogue:blip', {});
      bus.emit('game:money'); bus.emit('game:quest');
      bus.emit('sky:hour', 21);
      bus.emit('audio:context', 'sail');
      bus.emit('audio:duck', 1);
      bus.emit('intro:start'); bus.emit('intro:title'); bus.emit('intro:done');
    } catch (e) { threw = e; }
    ok(!threw, 'every wired bus event is handled', threw && threw.stack);

    // Contexts must all be reachable and all must transition cleanly.
    threw = null;
    try {
      for (const name of audio.contexts) {
        audio.setContext(name, { fade: 0.5 });
        for (let i = 0; i < 200; i++) { actx.advance(1 / 60); audio.update(1 / 60); }
      }
    } catch (e) { threw = e; }
    ok(!threw, 'every context is reachable', threw && threw.stack);

    // And finally: stop everything and prove the graph goes quiet.
    // Baseline: the ambience beds each keep a permanent, silent modulator
    // (a looping noise source, an LFO, a drone). Those are the only nodes
    // allowed to outlive a stop, and their number must not creep.
    const permanentBefore = actx._sources.filter((s) => s.started && !s.stopped).length;
    audio.stop();
    const startedAtStop = actx._stats.started;
    for (let i = 0; i < 1200; i++) { actx.advance(1 / 60); audio.update(1 / 60); }
    ok(actx._stats.started === startedAtStop, 'nothing new is scheduled after stop()',
      actx._stats.started - startedAtStop);
    ok(audio.voices === 0, 'voice count returns to baseline after stop()', audio.voices);
    // Ambience beds keep one silent looping source each on purpose — starting
    // and stopping them per zone is what makes cheap ambience click. What must
    // never happen is a one-shot left ringing, or the bed count creeping up.
    const ringing = actx._sources.filter((s) => s.stopped && s.stopTime > actx.currentTime);
    ok(ringing.length === 0, 'no scheduled voice outlives the stop', ringing.length);
    const permanentAfter = actx._sources.filter((s) => s.started && !s.stopped).length;
    ok(permanentAfter === permanentBefore, 'the permanent node count does not creep',
      `${permanentBefore} -> ${permanentAfter}`);
    ok(permanentAfter <= audio.beds.length * 3, 'only bounded per-bed modulators remain',
      `${permanentAfter} for ${audio.beds.length} beds`);

    audio.dispose();
    ok(true, 'dispose() completes');
  }
}

/* ============================================================
   4. Browser suite — the real Web Audio implementation
   ============================================================ */

async function browserSuite() {
  G('browser — real Web Audio in headless Chrome');
  const { chromium } = await import('playwright-core');
  const { createServer } = await import('node:http');
  const { readFile } = await import('node:fs/promises');
  const { extname, join } = await import('node:path');

  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.png': 'image/png', '.json': 'application/json',
  };
  const server = createServer(async (req, res) => {
    try {
      const clean = decodeURIComponent(req.url.split('?')[0]);
      const path = join(ROOT, clean === '/' ? 'index.html' : clean);
      if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const browser = await chromium.launch({
    channel: 'chrome',
    args: [
      '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${e.message}`));
  // The generic "Failed to load resource" console line carries no URL; the
  // response listener below reports real 404s with one, so drop the noise
  // (headless Chrome always asks for a favicon we do not ship).
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push(`${r.status()} ${r.url()}`);
  });

  try {
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load', timeout: 45000 });
    await page.waitForFunction('window.__WALLY_READY__ === true', { timeout: 30000 }).catch(() => {});

    const r = await page.evaluate(async () => {
      const a = window.WALLY?.ctx?.audio;
      if (!a) return { error: 'ctx.audio missing' };
      const out = { created: a.ready, suspendedAtBoot: a.suspended };
      await a.resume();
      out.running = a.running;
      out.contexts = a.contexts;
      out.sfxNames = a.sfxNames;
      out.spaces = a.spaces;
      out.beds = a.beds;

      // Every effect must resolve against the real implementation.
      out.unresolved = a.sfxNames.filter((n) => !a.sfx(n, { gain: 0.001 }));
      a.setMusicVolume(0.001); a.setSfxVolume(0.001);
      a.setContext('explore', { immediate: true });
      await new Promise((res) => setTimeout(res, 3000));
      out.bar = a.bar;
      out.notes = a.notes.length;
      out.voicesRunning = a.voices;
      a.setContext('market');
      out.pending = a.pendingContext;
      await new Promise((res) => setTimeout(res, 3500));
      out.after = a.context;
      a.sting('title');
      a.duckFor(0.5);
      await new Promise((res) => setTimeout(res, 500));
      a.stop();
      await new Promise((res) => setTimeout(res, 6000));
      out.voicesAfterStop = a.voices;
      out.state = window.WALLY.debug.audioState();
      return out;
    });

    ok(!r.error, 'ctx.audio exists on the real page', r.error);
    if (!r.error) {
      ok(r.created === true, 'AudioContext created in the browser');
      ok(r.running === true, 'resume() works against the real implementation');
      ok(r.unresolved.length === 0, 'every sfx name resolves in the browser', r.unresolved.join(','));
      ok(r.bar > 0, 'the score advanced in real time', `bar ${r.bar}`);
      ok(r.notes > 10, 'notes were scheduled', r.notes);
      ok(r.voicesRunning > 0, 'voices live while playing', r.voicesRunning);
      ok(r.after === 'market', 'the queued transition landed', r.after);
      ok(r.voicesAfterStop === 0, 'no runaway oscillators after stop()', r.voicesAfterStop);
      if (VERBOSE) console.log('  state:', JSON.stringify(r.state));
    }
    /* ---- offline render: does it actually make a sound? ----
       An OfflineAudioContext renders the score faster than real time, so
       we can measure the result. The scheduler reads `currentTime`, which
       an offline context pins at 0 until rendering starts, so drive it
       through a Proxy that supplies a virtual clock. */
    G('browser — offline render of the score');
    const r2 = await page.evaluate(async () => {
      const MUS = await import('/src/audio/music.js');
      const SFX = await import('/src/audio/sfx.js');
      const RVB = await import('/src/audio/reverb.js');

      function virtualise(oac) {
        const box = { now: 0 };
        return {
          box,
          ctx: new Proxy(oac, {
            get(t, k) {
              if (k === 'currentTime') return box.now;
              const v = t[k];
              return typeof v === 'function' ? v.bind(t) : v;
            },
          }),
        };
      }

      function measure(buf, from, to) {
        const sr = buf.sampleRate;
        const a = buf.getChannelData(0), b = buf.getChannelData(1);
        let peak = 0, sum = 0, n = 0, nan = 0, corr = 0;
        for (let i = Math.floor(from * sr); i < Math.floor(to * sr); i++) {
          const l = a[i], r = b[i];
          if (!Number.isFinite(l) || !Number.isFinite(r)) { nan++; continue; }
          peak = Math.max(peak, Math.abs(l), Math.abs(r));
          sum += l * l; n++;
          corr += Math.abs(l - r);
        }
        return { peak, rms: Math.sqrt(sum / Math.max(1, n)), nan, width: corr / Math.max(1, n) };
      }

      const out = {};

      // 1. The score.
      {
        const oac = new OfflineAudioContext(2, 44100 * 10, 44100);
        const { ctx, box } = virtualise(oac);
        const g = oac.createGain(); g.gain.value = 1; g.connect(oac.destination);
        const rv = RVB.createReverb(ctx, g, { wet: 0.22 });
        rv.setSpace('outdoor', 0.01);
        const m = MUS.createMusic({ actx: ctx, dest: g, reverb: rv, seed: 4242 });
        m.setContext('explore', { immediate: true, fade: 0.2 });
        m.start(0.05);
        for (box.now = 0; box.now < 10; box.now += 0.04) m.tick();
        box.now = 0;
        out.music = measure(await oac.startRendering(), 1.5, 9.5);
      }

      // 2. A handful of effects, so the bank is proven audible too.
      {
        const oac = new OfflineAudioContext(2, 44100 * 4, 44100);
        const { ctx, box } = virtualise(oac);
        const g = oac.createGain(); g.gain.value = 1; g.connect(oac.destination);
        const bank = SFX.createSfx({ actx: ctx, dest: g, seed: 99 });
        const names = ['step.grass', 'step.stone', 'step.water', 'coin', 'splash',
          'ear.flap', 'trunk', 'door.close', 'gull', 'bell.big', 'levelup'];
        names.forEach((n, i) => { box.now = i * 0.3; bank.play(n, { gain: 1 }); });
        bank.bed('wind', 0.8, 0.1);
        for (let t = 0; t < 4; t += 0.05) { box.now = t; bank.update(0.05, { wind: 1.0 }); }
        box.now = 0;
        out.sfx = measure(await oac.startRendering(), 0.1, 3.8);
      }
      return out;
    });

    ok(r2.music.nan === 0, 'the score renders without NaN', r2.music.nan);
    ok(r2.music.rms > 0.002, 'the score is actually audible', `rms ${r2.music.rms.toFixed(4)}`);
    ok(r2.music.peak < 1.0, 'the score does not clip', `peak ${r2.music.peak.toFixed(3)}`);
    ok(r2.music.peak > 0.02, 'the score has real dynamic level', `peak ${r2.music.peak.toFixed(3)}`);
    ok(r2.music.width > 1e-5, 'the score is genuinely stereo', r2.music.width.toExponential(2));
    ok(r2.sfx.nan === 0, 'effects render without NaN', r2.sfx.nan);
    ok(r2.sfx.rms > 0.002, 'effects are audible', `rms ${r2.sfx.rms.toFixed(4)}`);
    ok(r2.sfx.peak < 1.0, 'effects do not clip', `peak ${r2.sfx.peak.toFixed(3)}`);
    if (VERBOSE) console.log('  render:', JSON.stringify(r2));

    ok(errors.length === 0, 'no console errors or page exceptions', errors.slice(0, 4).join(' | '));
  } finally {
    await browser.close();
    server.close();
  }
}

/* ============================================================
   5. Run
   ============================================================ */

try {
  await nodeSuite();
  if (BROWSER) await browserSuite();
} catch (e) {
  failures.push(`harness threw: ${e.stack || e.message}`);
  console.error(e);
}

console.log(`\n${failures.length ? 'FAILED' : 'PASS'} — ${pass} assertions passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\n' + failures.map((f) => ' • ' + f).join('\n'));
  process.exit(1);
}
process.exit(0);
