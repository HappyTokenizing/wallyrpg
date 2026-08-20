/* ============================================================
   audio.js — ctx.audio. Web Audio only, fully procedural, no files.

   This module owns the AudioContext, the master bus, the shared reverb,
   and the mapping from *game context* to *sound*. The two heavy lifters
   live next door: music.js (the adaptive score) and sfx.js (the effect
   bank and the ambience beds).

   Autoplay policy is respected properly:
     - the AudioContext is created lazily, and creating it never throws
       into the boot sequence;
     - if it starts `suspended` (the normal case), nothing schedules and
       nothing errors — the score is simply not running;
     - the first real user gesture resumes it and starts the score at the
       context the game has already asked for.
   Boot is never blocked, and a missing or blocked Web Audio implementation
   degrades to a complete no-op API rather than a crash.

   Graph:

     music ──► musicGain ─┐
     sfx   ──► sfxGain  ──┼─► duck ─► master ─► limiter ─► destination
     beds  ──► sfxGain  ──┘      ▲
     (sends) ────────► reverb ───┘

   Public API (ctx.audio):
     init()                       create the context (idempotent)
     resume()                     resume after a gesture; returns a promise
     ready / running / suspended  state flags
     setContext(name, opts)       queue a musical context; lands on a bar
     context / pendingContext     current + queued context names
     contexts                     the list of context names
     sfx(name, { position, pitch, gain, delay, pan, surface })
     sfxNames / hasSfx(name)      the effect bank
     setSurface(name)             which footstep recipe `sfx('step')` uses
     sting(name)                  cinematic gesture over the score
     duckFor(seconds, amount)     duck music+ambience for dialogue
     musicVolume / sfxVolume / masterVolume   get + set (0..1, persisted)
     mute(on) / toggleMute() / muted
     setWeather(name)             'clear' | 'rain' | 'storm'
     setTimeOfDay(hour)           auto day/night context in auto mode
     setSpace(name)               force a reverb preset
     stop() / stopMusic()
     voices                       live voice count (for the test harness)
   ============================================================ */

import { clamp, damp } from '../core/contracts.js';
import { createReverb, SPACES } from './reverb.js';
import { createMusic, SCORES, CONTEXT_NAMES } from './music.js';
import { createSfx, SURFACES } from './sfx.js';

const STORE_KEY = 'wally.audio.v1';

/* Which ambience beds each musical context wants, and how loud. A context
   change therefore reshapes the *whole* soundscape — score, ambience and
   room acoustic together — rather than swapping a track. */
const AMBIENCE = {
  silence:   {},
  title:     { wind: 0.28, waves: 0.34, gulls: 0.55 },
  explore:   { wind: 0.50, waves: 0.34, gulls: 0.45, forest: 0.28 },
  town:      { wind: 0.30, crowd: 0.34, forest: 0.14 },
  market:    { market: 0.80, crowd: 0.26, wind: 0.16 },
  interior:  { room: 0.70 },
  night:     { wind: 0.34, waves: 0.28, night: 0.70 },
  tense:     { wind: 0.58, waves: 0.20 },
  sail:      { wind: 0.85, waves: 0.85, gulls: 0.40 },
  cinematic: { wind: 0.30, waves: 0.26, gulls: 0.20 },
  farm:      { wind: 0.46, forest: 0.55 },
  mine:      { cave: 0.80 },
  heights:   { wind: 0.55, gulls: 0.24 },
};

/* Rain and storm layer on top of whatever the context asked for. */
const WEATHER = {
  clear: { rain: 0 },
  rain:  { rain: 0.55 },
  storm: { rain: 0.90, wind: 0.90 },
};

/* A no-op stand-in used when Web Audio is unavailable or blocked. Every
   method exists and returns something sane, so no caller ever has to
   check whether audio is present. */
function nullAudio(reason) {
  const api = {
    unavailable: reason,
    ready: false, running: false, suspended: true, muted: true,
    context: 'silence', pendingContext: null,
    contexts: CONTEXT_NAMES, sfxNames: [], beds: [], surfaces: SURFACES,
    spaces: Object.keys(SPACES), stings: [], notes: [],
    voices: 0, bar: 0, bpm: 0,
    musicVolume: 0, sfxVolume: 0, masterVolume: 0,
    init: () => api, resume: () => Promise.resolve(false),
    setContext: () => api, timeToTransition: () => 0,
    sfx: () => false, hasSfx: () => false, setSurface: () => api,
    sting: () => api, duckFor: () => api,
    setMusicVolume: () => api, setSfxVolume: () => api, setMasterVolume: () => api,
    mute: () => api, toggleMute: () => api,
    setWeather: () => api, setTimeOfDay: () => api, setAutoNight: () => api,
    setSpace: () => api, bed: () => false, bedLevel: () => 0,
    stop: () => api, stopMusic: () => api,
    update() {}, dispose() {},
  };
  return api;
}

export async function init(ctx) {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return nullAudio('no AudioContext in this browser');

  /* ---------- persisted settings ---------- */
  let vol = { music: 0.55, sfx: 0.8, master: 0.9, muted: false };
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY);
    if (raw) vol = { ...vol, ...JSON.parse(raw) };
  } catch { /* private mode, or no storage — defaults are fine */ }
  const persist = () => {
    try { globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(vol)); } catch {}
  };

  /* ---------- lazy graph ---------- */
  let actx = null, master = null, limiter = null, duck = null;
  let musicGain = null, sfxGain = null, reverb = null;
  let music = null, sfx = null;
  let built = false;
  let failed = null;

  /* Wanted state, applied the moment the graph exists. Everything the game
     asks for before the first gesture is remembered, not dropped. */
  let wantContext = 'silence';
  let wantWeather = 'clear';
  let autoNight = true;
  let hour = 10;
  let forcedSpace = null;

  const detailFor = (q) => (q === 'low' || q === 'med' ? 0.45 : 1);

  function build() {
    if (built || failed) return built;
    try {
      actx = new AC({ latencyHint: 'interactive' });
    } catch (e) {
      failed = e;
      console.warn('[audio] AudioContext unavailable:', e?.message || e);
      return false;
    }

    master = actx.createGain();
    master.gain.value = vol.muted ? 0 : vol.master;

    /* A gentle limiter, not a pumping compressor: the score plus a busy
       market can stack a lot of voices and we must never clip. */
    limiter = actx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 8;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.22;

    duck = actx.createGain();
    duck.gain.value = 1;

    duck.connect(master); master.connect(limiter); limiter.connect(actx.destination);

    musicGain = actx.createGain(); musicGain.gain.value = vol.music;
    sfxGain = actx.createGain();   sfxGain.gain.value = vol.sfx;
    musicGain.connect(duck); sfxGain.connect(duck);

    reverb = createReverb(actx, duck, { wet: 0.22 });
    reverb.warm(['outdoor', 'room']);
    reverb.setSpace('outdoor', 0.01);

    music = createMusic({ actx, dest: musicGain, reverb, rng: ctx?.rng, seed: 0x7a11ee });
    music.setDetail(detailFor(ctx?.quality?.name));

    sfx = createSfx({ actx, dest: sfxGain, reverb, rng: ctx?.rng, seed: 0x5f11ee });

    built = true;

    // Apply everything the game asked for while we were still asleep.
    applyContext(wantContext, { immediate: true, fade: 0.4 });
    return true;
  }

  /* ---------- context application ---------- */
  function applyContext(name, { fade = 2.4, immediate = false } = {}) {
    if (!SCORES[name]) name = 'explore';
    wantContext = name;
    if (!built) return;

    music.setContext(name, { fade, immediate });

    const mix = { ...(AMBIENCE[name] || {}) };
    const w = WEATHER[wantWeather] || WEATHER.clear;
    for (const k in w) mix[k] = Math.max(mix[k] || 0, w[k]);
    sfx.ambience(mix, immediate ? 0.3 : Math.max(1.2, fade));

    const space = forcedSpace || SCORES[name].space || 'outdoor';
    reverb.setSpace(space, immediate ? 0.05 : Math.max(0.8, fade));
  }

  /* ---------- gesture unlock ---------- */
  let unlocked = false;
  const GESTURES = ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'click'];

  function onGesture() { unlock().catch(() => {}); }

  async function unlock() {
    if (!build()) return false;
    if (actx.state === 'suspended') {
      try { await actx.resume(); } catch { return false; }
    }
    if (actx.state !== 'running') return false;
    if (!unlocked) {
      unlocked = true;
      for (const g of GESTURES) globalThis.removeEventListener?.(g, onGesture, true);
      // Start the transport now that we are actually allowed to make noise.
      music.start();
      applyContext(wantContext, { immediate: true, fade: 0.6 });
      ctx?.bus?.emit('audio:unlocked', api);
    }
    return true;
  }
  for (const g of GESTURES) {
    globalThis.addEventListener?.(g, onGesture, { capture: true, passive: true });
  }

  /* Build the graph immediately if the page already has permission (a
     returning visitor who has interacted with this origin). Free when it
     fails, instant music when it works.

     Screenshot runs skip it: there will never be a gesture, so the only
     thing an eager context buys the harness is a repeated autoplay
     warning in everyone else's console output. */
  if (!ctx?.flags?.shot) {
    build();
    if (actx && actx.state === 'running') { unlocked = true; music.start(); }
  }

  /* ---------- listener ---------- */
  const lpos = [0, 0, 0], lfwd = [0, 0, -1], lup = [0, 1, 0];
  let listenerAcc = 0;

  function updateListener(dt) {
    const cam = ctx?.camera;
    if (!cam || !actx?.listener) return;
    const e = cam.matrixWorld?.elements;
    if (!e) return;
    /* Damp the listener toward the camera: a hard-snapped listener makes
       panning jitter audibly behind a spring-follow camera. */
    lpos[0] = damp(lpos[0], e[12], 12, dt);
    lpos[1] = damp(lpos[1], e[13], 12, dt);
    lpos[2] = damp(lpos[2], e[14], 12, dt);
    lfwd[0] = -e[8]; lfwd[1] = -e[9]; lfwd[2] = -e[10];
    lup[0] = e[4]; lup[1] = e[5]; lup[2] = e[6];

    const L = actx.listener;
    const t = actx.currentTime;
    if (L.positionX) {
      L.positionX.setTargetAtTime(lpos[0], t, 0.02);
      L.positionY.setTargetAtTime(lpos[1], t, 0.02);
      L.positionZ.setTargetAtTime(lpos[2], t, 0.02);
      L.forwardX.setTargetAtTime(lfwd[0], t, 0.02);
      L.forwardY.setTargetAtTime(lfwd[1], t, 0.02);
      L.forwardZ.setTargetAtTime(lfwd[2], t, 0.02);
      L.upX.setTargetAtTime(lup[0], t, 0.02);
      L.upY.setTargetAtTime(lup[1], t, 0.02);
      L.upZ.setTargetAtTime(lup[2], t, 0.02);
    } else if (L.setPosition) {
      L.setPosition(lpos[0], lpos[1], lpos[2]);
      L.setOrientation(lfwd[0], lfwd[1], lfwd[2], lup[0], lup[1], lup[2]);
    }
  }

  /* ---------- ducking ---------- */
  let duckUntil = 0;

  function duckFor(seconds = 2, amount = 0.35) {
    if (!built) return api;
    const t = actx.currentTime;
    duckUntil = Math.max(duckUntil, t + Math.max(0.05, seconds));
    const amt = clamp(amount, 0.05, 1);
    duck.gain.cancelScheduledValues(t);
    duck.gain.setValueAtTime(duck.gain.value, t);
    duck.gain.linearRampToValueAtTime(amt, t + 0.18);
    duck.gain.setValueAtTime(amt, duckUntil);
    duck.gain.linearRampToValueAtTime(1, duckUntil + 0.7);
    return api;
  }

  /* ---------- the public API ---------- */
  const api = {
    /* --- state --- */
    get ready() { return built && !!actx; },
    get running() { return !!actx && actx.state === 'running'; },
    get suspended() { return !actx || actx.state !== 'running'; },
    get unavailable() { return failed ? String(failed.message || failed) : null; },
    get actx() { return actx; },
    get context() { return built ? music.context : wantContext; },
    get pendingContext() { return built ? music.pending : null; },
    contexts: CONTEXT_NAMES,
    spaces: Object.keys(SPACES),
    surfaces: SURFACES,
    get sfxNames() { return built ? sfx.names : []; },
    get beds() { return built ? sfx.beds : []; },
    get stings() { return built ? music.stings : []; },
    get voices() { return built ? music.voices + sfx.voices : 0; },
    get bar() { return built ? music.bar : 0; },
    get bpm() { return built ? music.bpm : 0; },
    get notes() { return built ? music.notes : []; },
    get muted() { return vol.muted; },

    /* --- lifecycle --- */
    init() { build(); return api; },
    resume() { return unlock(); },

    /* --- musical context ---
       The change is queued inside music.js and committed on the next bar
       line, so a zone transition never cuts a note in half. */
    setContext(name, opts = {}) { applyContext(name, opts); return api; },
    /** Seconds until a queued context change actually lands. */
    timeToTransition() { return built ? music.timeToBar() : 0; },

    /* --- effects --- */
    sfx(name, opts) {
      if (!built || vol.muted) return false;
      if (actx.state !== 'running') return false;
      return sfx.play(name, opts || {});
    },
    hasSfx(name) { return built ? sfx.has(name) : false; },
    setSurface(name) { if (built) sfx.setSurface(name); return api; },
    get surface() { return built ? sfx.surface : 'grass'; },

    /** Directly drive an ambience bed (0..1). Contexts do this for you. */
    bed(name, level, fade = 2) { return built ? sfx.bed(name, level, fade) : false; },
    bedLevel(name) { return built ? sfx.bedLevel(name) : 0; },

    /* --- cinematic hooks --- */
    sting(name = 'title') {
      if (!built || vol.muted || actx.state !== 'running') return api;
      music.sting(name);
      return api;
    },
    duckFor,

    /* --- mix --- */
    get musicVolume() { return vol.music; },
    set musicVolume(v) { api.setMusicVolume(v); },
    setMusicVolume(v) {
      vol.music = clamp(+v || 0, 0, 1);
      if (built) musicGain.gain.setTargetAtTime(vol.music, actx.currentTime, 0.05);
      persist(); return api;
    },
    get sfxVolume() { return vol.sfx; },
    set sfxVolume(v) { api.setSfxVolume(v); },
    setSfxVolume(v) {
      vol.sfx = clamp(+v || 0, 0, 1);
      if (built) sfxGain.gain.setTargetAtTime(vol.sfx, actx.currentTime, 0.05);
      persist(); return api;
    },
    get masterVolume() { return vol.master; },
    set masterVolume(v) { api.setMasterVolume(v); },
    setMasterVolume(v) {
      vol.master = clamp(+v || 0, 0, 1);
      if (built && !vol.muted) master.gain.setTargetAtTime(vol.master, actx.currentTime, 0.05);
      persist(); return api;
    },
    mute(on = true) {
      vol.muted = !!on;
      if (built) master.gain.setTargetAtTime(vol.muted ? 0 : vol.master, actx.currentTime, 0.04);
      persist(); return api;
    },
    toggleMute() { return api.mute(!vol.muted); },

    /* --- world state --- */
    setWeather(name) {
      wantWeather = WEATHER[name] ? name : 'clear';
      if (built) applyContext(wantContext, { fade: 3 });
      return api;
    },
    get weather() { return wantWeather; },
    get hour() { return hour; },

    /** Feed the sky's clock in; in auto mode this flips explore <-> night. */
    setTimeOfDay(h) {
      hour = ((+h || 0) % 24 + 24) % 24;
      if (autoNight) {
        const isNight = hour < 5.5 || hour >= 20;
        if (isNight && wantContext === 'explore') applyContext('night', { fade: 6 });
        else if (!isNight && wantContext === 'night') applyContext('explore', { fade: 6 });
      }
      return api;
    },
    setAutoNight(on) { autoNight = !!on; return api; },

    /** Override the reverb space, e.g. walking into a cave mid-zone. */
    setSpace(name) {
      forcedSpace = SPACES[name] ? name : null;
      if (built) reverb.setSpace(forcedSpace || SCORES[wantContext]?.space || 'outdoor', 1.0);
      return api;
    },
    get space() { return built ? reverb.space : null; },

    /* --- teardown --- */
    stopMusic(opts) { if (built) music.stop(opts); return api; },
    stop() {
      if (!built) return api;
      music.stop({ fade: 0.8 });
      sfx.stopBeds(0.8);
      return api;
    },

    /* --- frame --- */
    update(dt) {
      if (!built || actx.state !== 'running') return;
      music.tick();
      const w = ctx?.wind?.strength;
      sfx.update(dt, { wind: typeof w === 'number' ? w : 0.4 });
      listenerAcc += dt;
      if (listenerAcc >= 1 / 30) { updateListener(listenerAcc); listenerAcc = 0; }
    },

    dispose() {
      for (const g of GESTURES) globalThis.removeEventListener?.(g, onGesture, true);
      clearInterval(keepAlive);
      if (!built) return;
      try { music.dispose(); sfx.dispose(); reverb.dispose(); } catch {}
      try {
        musicGain.disconnect(); sfxGain.disconnect();
        duck.disconnect(); master.disconnect(); limiter.disconnect();
      } catch {}
      try { actx.close(); } catch {}
      built = false;
    },
  };

  /* The frame loop is the primary clock for the scheduler, but rAF is
     throttled when the tab is hidden and stops entirely when a mobile
     browser backgrounds it. A slow timer keeps the score from stalling —
     and, more importantly, from scheduling a catch-up burst on return. */
  const keepAlive = setInterval(() => {
    if (built && actx.state === 'running') music.tick();
  }, 120);
  keepAlive?.unref?.();   // no-op in a browser; lets a node test exit cleanly

  /* ---------- bus wiring ----------
     Other subsystems are built in parallel and none of them import this
     module. Everything below is a *listener*: emit the event and audio
     responds if it can. All are harmless no-ops if nobody emits them. */
  const bus = ctx?.bus;
  if (bus) {
    bus.on('sfx', (p) => {
      if (typeof p === 'string') api.sfx(p);
      else if (p && p.name) api.sfx(p.name, p);
    });
    bus.on('audio:context', (p) => api.setContext(typeof p === 'string' ? p : p?.name, p || {}));
    bus.on('audio:sting', (p) => api.sting(typeof p === 'string' ? p : p?.name));
    bus.on('audio:duck', (p) => duckFor(typeof p === 'number' ? p : p?.seconds ?? 2, p?.amount ?? 0.35));
    bus.on('audio:mute', (p) => api.mute(!!p));
    bus.on('audio:surface', (p) => api.setSurface(typeof p === 'string' ? p : p?.name));
    bus.on('audio:weather', (p) => api.setWeather(typeof p === 'string' ? p : p?.name));

    /* Convenience wiring for the events the other agents are most likely
       to emit. Names deliberately mirror their namespaces. */
    bus.on('wally:step', (p) => api.sfx('step', { position: p?.position, surface: p?.surface, gain: p?.gain ?? 0.9 }));
    bus.on('wally:land', (p) => api.sfx(p?.heavy ? 'land.heavy' : 'land', { position: p?.position, surface: p?.surface }));
    bus.on('wally:jump', (p) => api.sfx('jump', { position: p?.position }));
    bus.on('wally:earflap', (p) => api.sfx('ear.flap', { position: p?.position, gain: p?.gain ?? 0.7 }));
    bus.on('wally:splash', (p) => api.sfx('splash', { position: p?.position }));
    bus.on('wally:trunk', (p) => api.sfx('trunk', { position: p?.position }));
    bus.on('ui:click', () => api.sfx('ui.click'));
    bus.on('ui:select', () => api.sfx('ui.select'));
    bus.on('ui:back', () => api.sfx('ui.back'));
    bus.on('ui:error', () => api.sfx('ui.error'));
    bus.on('ui:toast', () => api.sfx('ui.toast'));
    bus.on('dialogue:blip', (p) => api.sfx(
      p?.voice === 'low' ? 'talk.low' : p?.voice === 'high' ? 'talk.high' : 'talk.blip'
    ));
    bus.on('dialogue:open', () => duckFor(0.8, 0.55));
    bus.on('game:money', () => api.sfx('coins'));
    bus.on('game:levelup', () => { api.sfx('levelup'); api.sting('victory'); });
    bus.on('game:quest', () => { api.sfx('quest.done'); api.sting('quest'); });
    bus.on('game:zone', (p) => api.setContext(typeof p === 'string' ? p : p?.audio || p?.name));
    bus.on('sky:hour', (p) => api.setTimeOfDay(typeof p === 'number' ? p : p?.hour));
    bus.on('intro:start', () => api.setContext('cinematic', { immediate: true, fade: 1.5 }));
    bus.on('intro:title', () => api.sting('title'));
    bus.on('intro:done', () => api.setContext('explore', { fade: 3 }));
  }

  /* ---------- debug hooks ---------- */
  const dbg = globalThis.WALLY?.debug;
  if (dbg) {
    dbg.audio = api;
    dbg.audioContext = (n) => api.setContext(n);
    dbg.audioSfx = (n, o) => api.sfx(n, o);
    dbg.audioSting = (n) => api.sting(n);
    dbg.audioResume = () => api.resume();
    dbg.audioState = () => ({
      ready: api.ready, running: api.running, context: api.context,
      pending: api.pendingContext, bar: api.bar, bpm: Math.round(api.bpm),
      voices: api.voices, muted: api.muted, weather: wantWeather,
      space: built ? reverb.space : null,
      layers: built ? music.layerGains() : null,
      beds: built ? Object.fromEntries(sfx.beds.map((b) => [b, sfx.bedLevel(b)])) : null,
    });
  }

  /* Start the game at the overworld score. Nothing sounds until the first
     gesture; this only records intent (and, on a page that already has
     audio permission, starts it straight away). Screenshot runs stay
     silent so the harness never pays for the scheduler. */
  applyContext(ctx?.flags?.shot ? 'silence' : 'explore', { immediate: true, fade: 0.5 });

  return api;
}
