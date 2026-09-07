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
     - the FIRST INTERACTION OF ANY KIND, ANYWHERE ON THE PAGE, unlocks
       it and starts the score at the context the game has already asked
       for. See the big comment on GESTURE UNLOCK below: on a phone the
       event you have to listen for is not the one you would guess, and
       getting it wrong is a game that is silent on mobile and perfect
       on every desktop you test it on.
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
     setWeather(name)             'clear'|'cloudy'|'rain'|'storm' -> BOOLEAN
     setTimeOfDay(hour)           auto day/night context in auto mode
     setSpace(name)               force a reverb preset
     stop() / stopMusic()
     voices                       live voice count (for the test harness)
     env                          the live environment the beds ride
   ============================================================ */

import { clamp, damp, lerp, smoothstep } from '../core/contracts.js';
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

/* ============================================================
   WHICH DISTRICT SOUNDS LIKE WHAT — and the one thing this table is
   for that the identical table in ui.js could never do.

   ui.js has carried this map since the districts were named, and it
   is complete: all ten. It has also never once fired from walking.
   Its only caller is the `place` event, which only state.setLoc()
   emits, which only game.js's travel/enter emit — so a player heard a
   district ONLY by entering a building in it. MEASURED before this
   change, walked (warped, then 3 s of real frames) to the centre of
   six districts with nothing entered, M1 Max / headless Chrome
   channel=chrome / SwiftShader / 1280x720 / load average 14-25 across
   the run, four other headless-Chrome workflows live in this tree:

     marketsq      world.zoneAt marketsq       ctx.audio.context explore
     ironhills     world.zoneAt ironhills      ctx.audio.context explore
     greenedge     world.zoneAt greenedge      ctx.audio.context explore
     waterfront    world.zoneAt waterfront     ctx.audio.context explore
     goldenheights world.zoneAt goldenheights  ctx.audio.context explore
     mainstreet    world.zoneAt mainstreet     ctx.audio.context explore

   market bed 0.000 and cave bed 0.000 in all six, confirmed by an
   AnalyserNode on the bed's own gain node and not by bedLevel(). The
   world knew where he was the whole time. That is a citation, not a
   revert check — WALLY.debug.audioRevertZone() is the revert check,
   and it is a switch in this module driven on one page load.

   TWO TABLES, ONE AUTHORITY. Deleting ui.js's copy is not mine to do,
   so instead the `game:zone` listener resolves the DISTRICT ID it
   carries through this table first and only falls back to the context
   name ui.js computed. Both paths — the sampler below and ui.js's
   door — therefore land on these ten lines, and ui.js's copy cannot
   drift away from them because nothing reads it.
   ============================================================ */
const ZONE_CONTEXT = {
  rustyrow: 'town', mainstreet: 'town', learning: 'town', marketsq: 'market',
  greenedge: 'farm', ironhills: 'mine', waterfront: 'explore',
  innovation: 'town', stampede: 'town', goldenheights: 'heights',
};

/* The contexts the walking driver is allowed to overwrite. Everything
   else — title, cinematic, sail, tense, interior, silence — is somebody
   else's decision about the whole frame, and a sampler that stomps the
   opening cinematic 250 ms after main.js names it is a worse bug than
   the one this fixes. The driver stands down until the context comes
   back to one of its own. */
const ZONE_OWNED = new Set([...Object.values(ZONE_CONTEXT), 'explore', 'night']);

/* WHICH DISTRICTS YIELD TO THE NIGHT SCORE, AND WHY IT IS NOT ALL OF
   THEM. `town`, `market` and `farm` are sounds of daytime ACTIVITY —
   chatter, hawkers, birdsong — and a market bed at 0.80 at two in the
   morning is a market that never closes. `mine` and `heights` are
   properties of the PLACE: a cave drone and a ridge wind are the same
   at 2 a.m. as at noon, and silencing them would make the two most
   distinctive districts on the island the two that vanish after dark.
   The night bed and its crickets are layered over both by mixFor()'s
   env.night rule regardless, so Iron Hills at night is drone + crickets
   rather than either one alone. */
const NIGHT_YIELDS = new Set(['town', 'market', 'farm', 'explore']);

/* ============================================================
   THE WEATHER LAYER.

   THE WEATHER HAD NEVER BEEN AUDIBLE. Measured end to end on this
   build before the fix (headless Chrome, real page load, a real
   gesture, WALLY.debug.setWeather(n, 0) for each of the four states):
   ctx.sky.weatherName went clear -> rain -> storm -> cloudy while
   ctx.audio.weather stayed "clear" and bedLevel('rain') stayed 0.000
   throughout. Three faults in the same few lines produced that:

     · audio.js listened on `audio:weather` and NOTHING ANYWHERE emits
       it. The world's own event is `weather`, emitted by
       src/world/weather.js set(). The listener had never once fired,
       so rain and storm shipped silent for the life of the game.
     · this table authored clear / rain / storm. weather.js authors
       FOUR — clear, cloudy, rain, storm — so `cloudy`, a state the
       world can really be in, fell through to `clear`.
     · setWeather() returned the api object, which is truthy, so a
       caller could not tell an applied state from a dropped one. That
       is the tenth instance on this project of a component reporting
       something other than what it did, and the identical defect
       weather.js's own header now warns about for `overcast`.

   All three are fixed below and asserted by tools/audiotest.mjs
   PASS W. The names here are weather.js's WEATHER_NAMES and no
   others; an unknown one is refused loudly and setWeather returns a
   boolean.

   Each row is what that state sounds like AT FULL STRENGTH:

     rain   the rain bed heard in the open, around you
     roof   rain heard ON something — a roof, an awning, a bridge —
            which is a different sound, not a quieter one
     wind   a FLOOR under the wind bed, over whatever the context asked
     hush   how far the LIVING beds duck (gulls, birdsong, market
            chatter, crowd). Nothing sings in a downpour and the market
            square empties in a storm. That, more than the hiss, is
            what makes weather read as weather.

   NOTHING HERE IS APPLIED AS A STEP. The live row is
   lerp(from, to, progress) where progress is ctx.sky.weatherProgress —
   weather.js's own damped scalar, the one its clouds and its fog ride
   — so a storm arrives and leaves over the sky's 150 s instead of
   switching on the event. weatherRow() below names the fallback branch
   for a boot with no sky.
   ============================================================ */
const WEATHER = {
  clear:  { rain: 0.00, roof: 0.00, wind: 0.00, hush: 0.00 },
  cloudy: { rain: 0.00, roof: 0.00, wind: 0.34, hush: 0.16 },
  rain:   { rain: 0.62, roof: 0.72, wind: 0.50, hush: 0.62 },
  storm:  { rain: 0.95, roof: 0.96, wind: 0.92, hush: 0.88 },
};
export const WEATHER_NAMES = Object.keys(WEATHER);

/* The beds weather, altitude and shelter are allowed to duck. Every
   one of them is something ALIVE and outdoors; `room`, `cave` and
   `waves` are deliberately not in the list. */
const HUSHED = ['gulls', 'forest', 'market', 'crowd'];
/* Contexts whose surf is allowed to be silenced by the world. See
   the sea note in mixFor() for why the three cinematic ones are not. */
const SEA_CAPPED = new Set(['explore', 'night', 'town', 'market', 'farm',
  'mine', 'heights', 'tense', 'interior']);

/* A no-op stand-in used when Web Audio is unavailable or blocked. Every
   method exists and returns something sane, so no caller ever has to
   check whether audio is present. */
function nullAudio(reason) {
  const api = {
    unavailable: reason,
    ready: false, running: false, suspended: true, muted: true, unlocked: false,
    context: 'silence', pendingContext: null,
    contexts: CONTEXT_NAMES, sfxNames: [], beds: [], surfaces: SURFACES,
    spaces: Object.keys(SPACES), stings: [], notes: [],
    voices: 0, bar: 0, bpm: 0,
    weather: 'clear', weatherNames: WEATHER_NAMES,
    env: { rain: 0, roof: 0, wind: 0, hush: 0, shelter: 0, shore: 0, sea: 1,
      altitude: 0, night: 0, zone: null, zoneRaw: null, zoneDwell: 0 },
    musicVolume: 0, sfxVolume: 0, masterVolume: 0,
    init: () => api, resume: () => Promise.resolve(false),
    setContext: () => api, timeToTransition: () => 0,
    sfx: () => false, hasSfx: () => false, setSurface: () => api,
    sting: () => api, duckFor: () => api,
    setMusicVolume: () => api, setSfxVolume: () => api, setMasterVolume: () => api,
    mute: () => api, toggleMute: () => api,
    /* FALSE, not the api object: "I did not apply that" is the honest
       answer from a module that cannot make a sound at all. */
    setWeather: () => false,
    setTimeOfDay: () => api, setAutoNight: () => api,
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
  /* Does the game WANT a score right now? The watchdog restarts a
     transport that stopped by accident, so it has to be able to tell that
     from one the game stopped on purpose — stop() and stopMusic() must
     stay stopped. Only the unlock and an explicit setContext turn this
     back on. */
  let wantPlaying = false;
  let wantWeather = 'clear';
  let wxFrom = 'clear';           // the state the blend is travelling FROM
  let wxFade = 150;               // seconds, as the world reported it
  let wxLocal = 1;                // the no-sky fallback's own progress
  let wxSource = 'local';         // which branch weatherRow() last took
  let autoNight = true;
  /* THE REVERT SWITCH for this round, flipped by
     WALLY.debug.audioRevertZone(). False = the rule this file shipped
     with: no zone driver at all, and a surf floor that ignores where
     the sea is. See the hook at the bottom of the file. */
  let zoneRule = true;
  let hour = 10;
  let forcedSpace = null;

  /* ============================================================
     THE ENVIRONMENT — what the soundscape reacts to that is not a
     musical context.

     SAMPLED, NOT PUSHED, and 4 Hz is the whole cost. The modules that
     own these facts (world, sky, phys, wally) do not import us and
     mostly do not emit anything about them: sky.js emits `sky:hour`
     and nothing else, world.js emits nothing at all, and the events
     physics DOES emit are named phys:* while this file was listening
     for wally:*. Waiting for six other agents to emit six new events
     is how the weather stayed silent for a year. So we read ctx.

     Everything in here is a 0..1 scalar and everything is damped —
     nothing steps. Read live from ctx.audio.env. */
  const env = {
    rain: 0,        // the open-air rain bed, blended across the change
    roof: 0,        // rain heard on a roof above you
    wind: 0,        // weather's floor under the wind bed
    hush: 0,        // how far the living beds duck
    shelter: 0,     // 0 in the open, 1 with something over his head
    shore: 0,       // 0..1, how close the water is — the surf FLOOR
    sea: 1,         // 0..1, how much sea is audible here — the CEILING
    altitude: 0,    // 0..1, height over the ground (the balloon)
    night: 0,       // the sky's own night factor
    zone: null,     // the district he is COMMITTED to (post-hysteresis)
    zoneRaw: null,  // what world.zoneAt() says this instant
    zoneDwell: 0,   // seconds the candidate has been held
  };

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

    /* The context tells us itself when it changes state — which is how
       we learn that a resume() we could not await has landed, and how
       we learn that the OS took the audio away again. */
    try {
      actx.onstatechange = () => {
        if (!actx) return;
        if (actx.state === 'running') {
          finish();
          /* finish() only starts the transport the FIRST time. Coming
             back from a suspend it returns true and schedules nothing —
             which is a running context with a dead scheduler, i.e.
             silence. pump() is what re-arms the transport. */
          pump('statechange');
        } else nudge();
      };
    } catch {}

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

    /* A stopped transport will not play the new context on its own, and
       a zone change that produces silence is the same bug from the
       player's side as a scheduler that starved. */
    if (wantPlaying && unlocked && !music.running && name !== 'silence' && actx.state === 'running') {
      music.start();
      music.setContext(name, { fade, immediate: true });
      music.tick();
    }

    bedsOff = false;              // an explicit context un-stops the beds
    sfx.ambience(mixFor(name), immediate ? 0.3 : Math.max(1.2, fade));
    pushed.clear();               // the whole mix has just been re-issued

    const space = forcedSpace || SCORES[name].space || 'outdoor';
    reverb.setSpace(space, immediate ? 0.05 : Math.max(0.8, fade));
  }

  /* ============================================================
     THE MIX — one function, so the context and the environment can
     never be applied from two different places and disagree.

     applyContext() issues the WHOLE mix on a zone change, at the zone
     change's own fade. refreshEnv() then nudges only the handful of
     beds the environment moves, and only when one of them has actually
     drifted — because re-issuing the whole mix four times a second
     would cancel and shorten every crossfade a context change had in
     flight (sfx.bed() does cancelScheduledValues), which is a smooth
     transition turned into a 0.6 s chase.
     ============================================================ */

  /** The live weather row: lerp(from, to, progress). */
  function weatherRow() {
    const to = WEATHER[wantWeather] || WEATHER.clear;
    const from = WEATHER[wxFrom] || WEATHER.clear;
    /* THE BRANCH, NAMED.

       `sky` is the shipping path. ctx.sky.weatherProgress is
       weather.js's own damped 0->1, stepped in the same update() with
       the same lambda as the cloud cover and the fog, so the soundscape
       physically cannot be part-way through a change the sky is not
       making. tools/audiotest.mjs W6 asserts audio's blended rain
       against ctx.sky.rainfall at a point mid-fade, which is a
       cross-check against another module's number rather than against
       our own.

       `local` is the fallback, and it is a real path, not a guard:
       tools/test-audio.mjs drives this whole module against an
       OfflineAudioContext with no ctx.sky at all. It damps the same
       0->1 with the same law and the same lambda (4 / fade) that
       weather.js uses, from the fade the `weather` event carried.
       W7 asserts it by deleting ctx.sky for the duration. */
    let p;
    if (ctx?.sky && typeof ctx.sky.weatherProgress === 'number') {
      p = ctx.sky.weatherProgress; wxSource = 'sky';
    } else {
      p = wxLocal; wxSource = 'local';
    }
    p = clamp(p, 0, 1);
    return {
      rain: lerp(from.rain, to.rain, p),
      roof: lerp(from.roof, to.roof, p),
      wind: lerp(from.wind, to.wind, p),
      hush: lerp(from.hush, to.hush, p),
    };
  }

  /** The full bed mix for a context, under the current environment. */
  function mixFor(name) {
    const mix = { ...(AMBIENCE[name] || {}) };

    /* --- weather. `roof` and `rain` are two BEDS, not one level:
       rain on an awning is a different sound from rain in the open, so
       stepping under one crossfades rather than turns anything down. */
    const open = 1 - env.shelter;
    mix.rain = Math.max(mix.rain || 0, env.rain * open);
    mix.roof = Math.max(mix.roof || 0, env.roof * env.shelter);
    if (env.wind > 0) mix.wind = Math.max(mix.wind || 0, env.wind * (1 - env.shelter * 0.55));

    /* --- THE SEA, WHICH USED TO IGNORE WHERE THE SEA IS.
       `explore` authors waves 0.34 and, until this line, that was the
       level everywhere the context was explore — MEASURED at the
       centre of Iron Hills, 218.4 m from the water and 40 m above it,
       waves bed 0.340, AnalyserNode RMS 0.0279 on the bed's own gain.
       Surf, in a mine. The old rule below only ever RAISED the level,
       so a floor authored for a beach became a floor for the whole
       island: a floor that ignores the world is a floor in the wrong
       place.

       So there are two rules now and they are not the same rule:
         shore  the FLOOR — a beach in `town` is audible surf whatever
                the context wanted;
         sea    the CEILING — 218 m inland the sea is inaudible
                whatever the context wanted.
       Applied ceiling-then-floor, which on a beach is a no-op because
       both read 1 there.

       ELEVATION IS DELIBERATELY NOT IN THIS. The mine is 44 m up and
       height makes surf MORE audible in the real world, not less — it
       is the 218 metres that silences it, and folding in a height term
       would be a second knob tuned to make one measurement come out
       right. Distance only.

       THE CINEMATIC CONTEXTS ARE EXEMPT. `title`, `cinematic` and
       `sail` frame the camera somewhere the sampler is not looking:
       env reads ctx.wally.position first, so the intro's flight over
       the water would be scored from wherever his body was parked and
       the title card would lose its surf to a number about the wrong
       point in space. */
    if (zoneRule && SEA_CAPPED.has(name) && mix.waves) {
      mix.waves *= env.sea * (1 - env.shelter * 0.6);
    }

    /* --- the shore. The waves bed is a context decision, but standing
       on a beach in `town` should still be audible surf; this only ever
       raises it. */
    if (env.shore > 0) {
      /* the shelter term is part of THIS round and so is gated with the
         rest of it — a revert that leaves half a rule behind is not a
         revert. */
      mix.waves = Math.max(mix.waves || 0, env.shore * 0.62 * (zoneRule ? 1 - env.shelter * 0.6 : 1));
    }

    /* --- night. `night` used to arrive only with the night CONTEXT, so
       2 a.m. in town had no crickets in it at all. The sky already
       publishes its own night factor; ride that instead, and only
       outdoors. */
    if (env.night > 0) {
      mix.night = Math.max(mix.night || 0, env.night * 0.5 * (1 - env.shelter * 0.7));
    }

    /* --- what ducks. Weather, shelter and height all quieten the
       living beds, and they compound rather than compete. */
    const quiet = clamp(1 - Math.max(env.hush, env.shelter * 0.5, env.altitude * 0.92), 0, 1);
    for (const k of HUSHED) if (mix[k]) mix[k] *= quiet;

    /* --- altitude. Up in the balloon the ground goes away and the wind
       is the whole world. */
    if (env.altitude > 0.02) {
      mix.wind = Math.max(mix.wind || 0, 0.30 + env.altitude * 0.55);
      mix.gulls = Math.max(mix.gulls || 0, env.altitude * 0.30);
    }

    return mix;
  }

  /* Only the beds the environment can move. Everything else belongs to
     the context and is left alone between zone changes. */
  const ENV_BEDS = ['rain', 'roof', 'wind', 'waves', 'night', ...HUSHED];
  const pushed = new Map();
  /* Set by stop(), cleared by applyContext(). See refreshEnv(). */
  let bedsOff = false;

  /** Nudge the environment-driven beds toward the live mix. */
  function refreshEnv(fade = 0.7) {
    if (!built) return 0;
    /* STOP MEANS STOP — the same rule `wantPlaying` enforces for the
       transport, and for the same reason. stop() fades every bed out;
       a sampler that runs 250 ms later and pushes the context's wind
       and gulls straight back up has un-stopped the module without
       anybody asking, and tools/test-audio.mjs caught exactly that
       (82 voices still scheduled after a stop). Only an explicit
       applyContext clears it. */
    if (bedsOff) return 0;
    const mix = mixFor(wantContext);
    let moved = 0;
    for (const k of ENV_BEDS) {
      const v = mix[k] || 0;
      const was = pushed.has(k) ? pushed.get(k) : sfx.bedLevel(k);
      /* A DEAD BAND, and it is what keeps this cheap: a settled world
         issues no AudioParam ramps at all. 0.012 is under a third of a
         dB at these levels — inaudible, and small enough that a 150 s
         fade still gets ~50 steps rather than reading as a staircase. */
      if (Math.abs(v - was) < 0.012) continue;
      /* sfx.bed() returns FALSE for a name the bank has no recipe for,
         and the old code here would have thrown that away — a mix that
         asks for a bed nobody built is a level that silently never
         moves. It is the same class of failure as the bar that fails
         inside its own try/catch, so it climbs the same ladder. */
      if (!sfx.bed(k, v, fade)) {
        throw new Error(`ambience bed "${k}" does not exist in the bank `
          + `(have: ${sfx.beds.join(', ')}) — the mix is asking for a level `
          + 'nothing can produce');
      }
      pushed.set(k, v);
      moved++;
    }
    return moved;
  }

  /* ============================================================
     THE SAMPLER. Four times a second, and this is its whole cost:
     one heightAt, one shoreDistAt, and — only while rain is actually
     audible — one DDA ray straight up. Measured below in
     ctx.audio.env.ms.
     ============================================================ */
  const UP = { x: 0, y: 1, z: 0 };
  let envAcc = 0;
  /* A WINDOW, NOT A SAMPLE. One pass of this is well under Chrome's
     performance.now() resolution and reads as a flat 0.000 ms, which
     is a number that says nothing — the same mistake as quoting one
     frame's reciprocal as an fps. Sum and count instead, and publish
     the mean with n beside it so the reader can see what it is a mean
     of. */
  let envMsSum = 0, envSamples = 0;
  const envMs = () => (envSamples ? envMsSum / envSamples : 0);

  /* SHELTER IS THE ONE SIGNAL THAT COULD FAIL WITHOUT SAYING SO.
     Every other scalar here comes from a module that publishes it; this
     one is a query whose answer is "no" both when he is standing in the
     open and when the roofs were never registered as collision
     geometry. Those are indistinguishable from the level, so the rays
     and the hits are COUNTED and published: `shelterRays` climbing with
     `shelterHits` stuck at 0 for a whole rainy walk through Main Street
     is the shape of the second case, and tools/audiotest.mjs W5 asserts
     a hit under a real building rather than asserting the level. */
  let shelterRays = 0, shelterHits = 0;
  let steps = 0, strikes = 0;

  /* WHICH FOOTSTEP RECIPE THE GROUND UNDER HIM ASKS FOR.

     Asked of ctx.world at the step position rather than tracked as a
     mode somebody has to remember to set: setSurface() is a global on
     the bank and it has exactly one caller in the whole repo — the
     debug hook. A surface that is queried is right on a beach, in the
     shallows and on a road for free, and it cannot drift.

     NO try/catch. If one of these queries starts throwing, the
     listener's safe() wrapper counts it and prints a stack; swallowing
     it here would give us a game that silently walks on grass forever.
     Rural districts have dirt roads, the built ones have paving —
     ironhills and greenedge are the two the city never reached. */
  const RURAL = new Set(['greenedge', 'ironhills']);

  function surfaceAt(pos) {
    const w = ctx?.world;
    if (!w || !pos) return undefined;          // let sfx.js use its own default
    if (w.isWater?.(pos.x, pos.z)) return 'water';
    if (w.isRoad?.(pos.x, pos.z)) {
      return RURAL.has(w.zoneAt?.(pos.x, pos.z)?.id) ? 'dirt' : 'stone';
    }
    if (w.isBeach?.(pos.x, pos.z)) return 'sand';
    return 'grass';
  }

  /* Metres. SEA_FAR is past the far edge of the built-up interior —
     Market Square sits 398 m from the water and Main Street 331 m, so
     the middle of this island is silent surf, which is the point. */
  const SEA_NEAR = 14, SEA_FAR = 190;

  /* ============================================================
     THE WALKING DRIVER — the emitter the district map never had.

     HYSTERESIS, AND WHY IT IS DWELL AND NOT A DEADBAND. Ten districts
     on one island means a great many seams, and terrain.js's zoneAt()
     is a raster lookup with a smoothstep weight and a 0.14 cutoff:
     along a seam two districts trade the cell back and forth, and
     between them is unclaimed ground that reads `null` (= explore).
     A player walking a seam would otherwise hear the score change bar
     after bar. There is no distance-to-boundary to threshold on —
     zoneAt returns a district or nothing — so the guard is TIME, which
     is the dimension the player actually experiences:

       a candidate district must hold for ZONE_HOLD seconds of
       CONTINUOUS sampling before it is committed.

     At 4 Hz that is five consecutive agreeing samples. A player
     standing exactly on a seam where the answer alternates never
     accumulates five of anything and never flips at all — the failure
     mode is "stays on the old district", which is the right one.
     ZONE_HOLD is 1.25 s: shorter than the bar the change is committed
     on anyway (music.js queues a context to the next bar line, 2.3 s
     at the explore score's tempo, so a genuine crossing costs the
     player nothing), and at a 4.2 m/s run it is 5.3 m of overshoot
     past the line, which is under half a house.

     DOES ENTERING A BUILDING STILL OVERRIDE? It does not, and it does
     not need to: there are no interiors in this game. ui.js's arrive()
     warps him to city.doorPosition(), a point 1.5 m off the facade,
     OUTDOORS and inside that location's own district — so the door and
     the ground he is standing on resolve through ZONE_CONTEXT to the
     same answer by construction. If interiors are ever built, the
     override goes here, as a `forced` that outranks the candidate.

     WHAT IT WILL NOT TOUCH: anything outside ZONE_OWNED. See that set.
     ============================================================ */
  const ZONE_HOLD = 1.25;
  let zoneCand = null, zoneDwellT = 0, zoneCommitted = null, zoneArmed = false;

  /* ============================================================
     IS IT DARK — and the reason this is not simply `hour >= 20`.

     THE NIGHT SCORE WAS UNREACHABLE IN PLAY. Not unmeasured:
     unreachable. audio.js learned the time from the `sky:hour` event,
     and `sky:hour` is emitted in exactly one place in this repo —
     inside sky.js's setHour(), whose only caller is
     WALLY.debug.setHour. The clock the GAME runs is a different
     wire: game.js's tickClock/advance emits `hour`, sky.js turns that
     into an eased `hourTarget`, and its own drifting hour is never
     published to anybody.

     MEASURED on this build before the fix, playing the clock forward
     with game.time.advance() the way a bus ride does — no debug
     setHour anywhere (M1 Max, headless Chrome channel=chrome,
     SwiftShader, 1280x720, load average 14-25 across the run — four
     other headless-Chrome workflows were live in this tree):

       game hour   7  ->  8  -> 11 -> 15 -> 19 -> 22 -> 0
       sky.hour  9.50  8.62  11.36 15.31 19.35 22.45 0.57
       sky.night 0.000 0.000 0.000 0.000 0.725 1.000 1.000
       audio.hour  10    10    10    10    10    10    10

     Ten o'clock in the morning, at midnight, with the sky fully dark.
     autoNight has never once fired in a real session in the life of
     this game. The night bed still arrived (env.night reads
     ctx.sky.night directly and that is why it climbed to 0.499), so
     the crickets were there and the SCORE never was — which is
     exactly how this looks like a working feature from the outside.

     The repair is this file's own house rule, the one in the header
     of THE ENVIRONMENT above: sample it, do not wait to be told. The
     sampler already reads ctx.sky four times a second for `night`, so
     it reads the hour on the same tick, and the decision itself now
     rides ctx.sky.night — the world's OWN dusk curve, the one the
     lighting uses — rather than a pair of hour literals that have to
     be kept in step with a palette table in another file.

     A DEADBAND, not a threshold: 0.55 to fall, 0.45 to lift. Same
     reason as the district dwell. sky.night is monotonic in the
     clock so it should not chatter, but a threshold that CAN chatter
     is one someone else's retune away from doing it.
     ============================================================ */
  let isNightNow = false;

  function updateNight() {
    const n = ctx?.sky?.night;
    if (zoneRule && typeof n === 'number') {
      if (isNightNow ? n < 0.45 : n >= 0.55) isNightNow = !isNightNow;
      return;
    }
    /* No sky, or the revert switch: the rule as it shipped, on the
       hour this module was last TOLD about. */
    isNightNow = hour < 5.5 || hour >= 20;
  }
  /** Pure read — nightNow() is called from getters and must not move. */
  const nightNow = () => isNightNow;

  /** What the world says the score should be, right here, right now. */
  function contextForZone(zid) {
    const c = (zid && ZONE_CONTEXT[zid]) || 'explore';
    return (nightNow() && NIGHT_YIELDS.has(c)) ? 'night' : c;
  }

  function driveZone(dt, p, world) {
    const raw = world.zoneAt(p.x, p.z)?.id ?? null;
    /* KEPT LIVE EVEN WHEN REVERTED, because it is the whole finding:
       under the old rule the world still knows the district and the
       score still does not. */
    env.zoneRaw = raw;
    if (!zoneRule) { env.zone = null; env.zoneDwell = 0; zoneArmed = false; return; }

    if (!zoneArmed) {
      /* THE FIRST SAMPLE COMMITS. A dwell on the opening sample would
         spend the first second and a quarter of the session in the
         wrong district, and there is nothing to be sticky about yet. */
      zoneCommitted = raw; zoneArmed = true; zoneCand = null; zoneDwellT = 0;
    } else if (raw === zoneCommitted) {
      zoneCand = null; zoneDwellT = 0;          // back inside: forget the wobble
    } else if (raw === zoneCand) {
      zoneDwellT += dt;
      if (zoneDwellT >= ZONE_HOLD) { zoneCommitted = raw; zoneCand = null; zoneDwellT = 0; }
    } else {
      zoneCand = raw; zoneDwellT = dt;          // a new candidate, from this sample
    }
    env.zone = zoneCommitted;
    env.zoneDwell = +zoneDwellT.toFixed(2);

    /* The driver only ever writes over its own. A cinematic, a sail or
       a stop() parks it until the context comes back. */
    if (!ZONE_OWNED.has(wantContext)) return;
    const want = contextForZone(zoneCommitted);
    if (want !== wantContext) applyContext(want, { fade: 4 });
  }

  function sampleEnv(dt) {
    const t0 = globalThis.performance?.now?.() ?? 0;

    /* the no-sky fallback's own progress — same law, same lambda as
       weather.js. Stepped unconditionally so the branch is exercised
       whether or not the sky is the one being read. */
    if (wxLocal < 1) {
      const p = damp(wxLocal, 1, 4 / Math.max(0.5, wxFade), dt);
      wxLocal = p > 0.9995 ? 1 : p;
    }

    const row = weatherRow();
    env.rain = row.rain; env.roof = row.roof;
    env.wind = row.wind; env.hush = row.hush;

    const sky = ctx?.sky;
    env.night = typeof sky?.night === 'number' ? clamp(sky.night, 0, 1) : 0;
    /* THE CLOCK, SAMPLED. See the long note on updateNight(): the only
       emitter of `sky:hour` in this repo is a debug hook, so the event
       this module used to wait for does not arrive during play. */
    if (zoneRule && typeof sky?.hour === 'number' && Number.isFinite(sky.hour)) {
      hour = ((sky.hour % 24) + 24) % 24;
    }
    updateNight();

    const world = ctx?.world;
    const p = ctx?.wally?.position || ctx?.camera?.position || null;
    if (p && world && Number.isFinite(p.x + p.y + p.z)) {
      if (typeof world.heightAt === 'function') {
        /* 6 m of clearance before "aloft" begins, so a hill and a
           rooftop do not read as a balloon. */
        env.altitude = clamp((p.y - world.heightAt(p.x, p.z) - 6) / 44, 0, 1);
      }
      if (typeof world.shoreDistAt === 'function') {
        /* shoreDistAt is signed: negative out at sea, 0 at the line. */
        const d = world.shoreDistAt(p.x, p.z);
        env.shore = smoothstep(64, 5, Math.abs(d));
        /* On or over the water the sea is the whole world; inland it
           fades out over SEA_NEAR..SEA_FAR. Both edges are metres and
           both are visible in ctx.audio.env. */
        env.sea = d <= 0 ? 1 : smoothstep(SEA_FAR, SEA_NEAR, d);
      }
      if (typeof world.zoneAt === 'function') driveZone(dt, p, world);
      let want = 0;
      if (typeof ctx?.phys?.raycast === 'function') {
        shelterRays++;
        /* From above his head, straight up. The DDA flips the normal
           toward the ray, so a roof modelled one-sided still registers.

           CAST UNCONDITIONALLY, not only while it is raining. Gating it
           on rain was cheaper by one ray every 250 ms and cost the
           signal its only self-diagnosis: `shelterHits` stuck at 0 is
           supposed to mean "the roofs are not in the collision world",
           and under a rain gate it also means "it has not rained yet",
           which are not the same finding. Measured cost of the whole
           sampler INCLUDING this ray: 0.0126 ms mean over n=262
           (M1 Max, headless Chrome, SwiftShader, 1280x720, load avg
           4.7) against a 16.7 ms vsync-capped frame. */
        const hit = ctx.phys.raycast({ x: p.x, y: p.y + 2.0, z: p.z }, UP, 14);
        if (hit) { want = 1; shelterHits++; }
      }
      /* ~1.8 s to cross, so walking under an awning is a move rather
         than a cut, and a lamppost overhead does not flicker. */
      env.shelter = damp(env.shelter, want, 2.2, dt);
    }

    const moved = refreshEnv();
    envMsSum += (globalThis.performance?.now?.() ?? 0) - t0;
    envSamples++;
    return moved;
  }

  /* ---------- teardown of the graph (not of the module) ---------- */
  let rebuilds = 0;

  function teardownGraph() {
    rebuilds++;
    if (built) {
      try { music.dispose(); sfx.dispose(); reverb.dispose(); } catch {}
      try {
        musicGain.disconnect(); sfxGain.disconnect();
        duck.disconnect(); master.disconnect(); limiter.disconnect();
      } catch {}
    }
    try { actx?.close?.(); } catch {}
    actx = master = limiter = duck = musicGain = sfxGain = null;
    reverb = music = sfx = null;
    silentBuf = null;
    built = false;
  }

  /* ============================================================
     GESTURE UNLOCK — the mobile path.

     This is the part that was silent on a phone, and every line of it
     is load-bearing. Four things a desktop browser lets you get away
     with and a mobile one does not:

     1  WHICH EVENT. Only an "activation triggering input event" grants
        the transient user activation that `resume()` needs. On a
        TOUCHSCREEN that is `pointerup` / `touchend` — NOT `pointerdown`
        and NOT `touchstart`, which carry no activation at all. The
        compatibility `mousedown`/`click` that a tap synthesises do
        carry it, but they are suppressed outright the moment any
        handler calls `preventDefault()` — which src/ui/touch.js does on
        every `pointerdown` in the joystick zone, as every touch
        controller must. Listening to the "down" half only is therefore
        a game that is permanently silent on a phone, which is exactly
        what this was.

     2  SYNCHRONOUSLY. Activation is transient. Nothing between the
        listener and `resume()` may await, defer to a rAF or a timeout,
        or the browser no longer considers us user-activated and the
        resume silently never settles. `onGesture` is not async, and
        `unlockSync` does its work before it returns — the promise
        bookkeeping happens afterwards, off the critical path.

     3  A BUFFER MUST ACTUALLY PLAY. iOS and some Android builds leave
        the output path muted until a source has been started from
        inside the gesture; the context reads `running` and you hear
        nothing. One frame of zeroes settles it.

     4  IT MAY HAVE TO BE BUILT IN THE GESTURE. A few builds only
        honour a context CREATED under activation, not merely resumed.
        We keep the cheap path (build at boot) and fall back: two
        refused resumes and the next gesture throws the dead context
        away and constructs a fresh one inside the handler.

     Nothing here throws, and nothing here is removed until the context
     is genuinely running — every later interaction is another attempt.
     ============================================================ */
  const SHOT = !!ctx?.flags?.shot;
  /* Has anybody actually ASKED to be unlocked yet? The transport may
     not start before main.js has named the opening score (see the note
     on the eager build below): the cinematic's cuts are struck against
     54 bpm bar lines from bar 0, and a transport that started a beat
     early under the overworld's 76 bpm costs the opener its timing.
     statechange, visibilitychange and the keep-alive timer may
     therefore COMPLETE an unlock, but none of them may start one. */
  let wantUnlock = false;
  let unlocked = false;
  let resumeAttempts = 0;
  let recreate = false;
  let silentBuf = null;
  let watchdog = null;
  let lastNudge = 0;

  const GESTURES = [
    'pointerdown', 'pointerup', 'touchstart', 'touchend',
    'mousedown', 'mouseup', 'click', 'keydown', 'keyup',
  ];

  /* Strictly synchronous, and it never throws into someone else's
     input handler. */
  function onGesture() { try { unlockSync(); } catch {} }

  /** One frame of silence, started inside the gesture. See (3). */
  function primeSilence() {
    if (!actx) return;
    try {
      if (!silentBuf) silentBuf = actx.createBuffer(1, 1, actx.sampleRate || 22050);
      const s = actx.createBufferSource();
      s.buffer = silentBuf;
      s.connect(actx.destination);
      s.onended = () => { try { s.disconnect(); } catch {} };
      if (s.start) s.start(0); else s.noteOn?.(0);
    } catch { /* a prime that fails must not cost us the resume */ }
  }

  /** Commit, but only once the context is genuinely making sound. */
  function finish() {
    if (!wantUnlock) return false;
    if (!built || !actx || actx.state !== 'running') return false;
    if (!unlocked) {
      unlocked = true;
      wantPlaying = wantContext !== 'silence';
      recreate = false;
      resumeAttempts = 0;
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      for (const g of GESTURES) globalThis.removeEventListener?.(g, onGesture, true);
      // Start the transport now that we are actually allowed to make noise.
      music.start();
      applyContext(wantContext, { immediate: true, fade: 0.6 });
      /* Schedule the first bar HERE. A running context with a stopped
         scheduler is still silence, and the frame loop may be a whole
         vsync away — or throttled, if the unlock came from a tab that
         has just become visible again. */
      music.tick();
      ctx?.bus?.emit('audio:unlocked', api);
    }
    return true;
  }

  /* If a gesture's resume produced nothing, arrange for the next one to
     rebuild the context from scratch inside its own handler. See (4). */
  function armWatchdog() {
    if (watchdog || unlocked) return;
    watchdog = setTimeout(() => {
      watchdog = null;
      if (unlocked || !actx) return;
      if (finish()) return;
      if (resumeAttempts >= 2 && rebuilds < 2) recreate = true;
    }, 500);
    watchdog?.unref?.();
  }

  function unlockSync() {
    /* Screenshot runs never build a context at all — there will never
       be a gesture, and an eager one only buys the harness a repeated
       autoplay warning in everybody's console output. Every tool in
       tools/ boots with ?shot, so this is the guard that keeps them
       silent and fast. */
    if (SHOT || failed) return false;
    wantUnlock = true;
    if (unlocked) return finish();

    if (recreate) { recreate = false; teardownGraph(); }
    if (!build()) return false;

    // (3) — before the resume, so it is queued the instant we are live.
    primeSilence();

    if (actx.state !== 'running') {
      resumeAttempts++;
      try {
        // (2) — called here, not after an await. Never awaited inline:
        // a blocked context's resume() can stay pending forever.
        const p = actx.resume();
        if (p && typeof p.then === 'function') p.then(() => finish(), () => {});
      } catch { /* older builds throw where newer ones reject */ }
      armWatchdog();
    }
    return finish();
  }

  for (const g of GESTURES) {
    /* window, capture phase: the first stop on the way to ANY target,
       so a tap that lands on the loading screen, the title card, the
       touch controls or a modal scrim unlocks exactly as well as one on
       the canvas. Passive — we must never interfere with the gesture we
       are riding. */
    globalThis.addEventListener?.(g, onGesture, { capture: true, passive: true });
  }

  /* ---------- staying unlocked ----------
     A mobile browser re-suspends the context when the tab is hidden,
     the screen locks or a call arrives, and nothing brings it back on
     its own — the player returns to a silent world. The page keeps
     STICKY activation after that first gesture, so a resume from here
     is allowed even though we are not in a handler. */
  function nudge() {
    if (!unlocked || !built || !actx || actx.state === 'running') return;
    const now = Date.now();
    if (now - lastNudge < 400) return;
    lastNudge = now;
    try {
      const p = actx.resume();
      if (p && typeof p.then === 'function') p.then(() => pump('resumed'), () => {});
    } catch {}
  }

  /* ============================================================
     THE TRANSPORT WATCHDOG.

     Reported from the field: "my music cut off after playing for some
     time, and then stayed off and came back after some time." Not a
     crash, not a mute — an intermittent, self-healing silence. Web Audio
     gives you four ways to produce exactly that, and the fix for each is
     different, so all four are handled:

       1  THE SCHEDULER STARVED. Covered in music.js: the look-ahead now
          tracks how often tick() is really being called, because a
          hidden tab clamps both of our clocks and 0.28 s of score is not
          enough to bridge a 1 s timer.
       2  THE CONTEXT WAS SUSPENDED and came back — nudge() above. But a
          RESUMED CONTEXT WITH A DEAD SCHEDULER IS STILL SILENCE, and
          that is the bug this function exists for: the old
          visibilitychange path re-armed the context and nothing re-armed
          the transport.
       3  A MUTED BUS. music.heal() — a cross-fade interrupted by a
          suspend leaves the score playing into a gain of zero.
       4  SOMETHING WE HAVE NOT THOUGHT OF. Hence the last branch: if the
          transport believes it is playing but the wire has been empty
          for SILENT_LIMIT seconds, re-anchor regardless of the reason.
          That turns any permanent dropout into a short gap.

     Every path that could possibly wake us — frame loop, keep-alive
     timer, statechange, visibilitychange, pageshow, focus — goes through
     here. It is a handful of number comparisons; it may be called often.
     ============================================================ */
  const SILENT_LIMIT = 1.0;     // seconds of empty wire before we re-clock
  const HIDDEN_HORIZON = 1.8;   // seconds of score to keep ahead when hidden
  let recoveries = 0;
  let lastStallLog = 0;

  /* ============================================================
     FAULT REPORTING — the other half of the watchdog.

     Everything above this line handles a transport that has gone quiet
     WITHOUT throwing. This handles the one that throws, which used to
     be the module's blind spot: update() wrapped the whole frame in one
     try/catch behind one console.warn, gated on a `loggedUpdateError`
     flag that was set once and never cleared. So a music.tick() that
     began throwing produced exactly one warning for the life of the
     page, took the ambience beds and the 3D listener down with it (they
     are after tick() inside the same try), and reported a green
     console for the rest of the session. "Cut off and stayed off" with
     nothing in the log is the precise shape of that.

     The replacement:
       · every sub-call gets its OWN guard, so a failing tick cannot
         starve the beds;
       · the first three throws print a full stack at ERROR level —
         tools/shot.mjs greps for errors, not warnings, so a screenshot
         run now fails on this;
       · after that, one line every FAULT_QUIET ms, so a per-frame
         failure cannot turn into a per-frame console flood;
       · and it ESCALATES rather than just narrating: five in a row
         resets the transport, forty rebuilds the whole graph once —
         and the bar-level failure below climbs the SAME ladder, three
         failed resets to the same rebuild, because a ladder the
         reported bug cannot climb is a ladder with two rungs.
     ============================================================ */
  const FAULT_LOGS = 3;
  const FAULT_QUIET = 10000;
  const faults = new Map();
  let hardRecoveries = 0;

  /* `silent` is for a fault that has ALREADY been reported by whoever
     detected it — checkBarFailures() below prints a line naming the bar
     count and the rung, which is strictly more useful than this generic
     one. It still has to be counted here, because the counter is what
     the ladder climbs. */
  function fault(where, e, { silent = false } = {}) {
    let f = faults.get(where);
    if (!f) { f = { where, n: 0, run: 0, logged: 0, at: 0, message: null }; faults.set(where, f); }
    f.n++; f.run++;
    f.message = String(e?.message || e);
    const now = Date.now();
    if (silent) return f;
    if (f.logged < FAULT_LOGS) {
      f.logged++; f.at = now;
      console.error(`[audio] ${where} threw (${f.n}) — the score does not get to fail quietly:`, e);
    } else if (now - f.at > FAULT_QUIET) {
      f.at = now;
      console.error(`[audio] ${where} has thrown ${f.n} times and is still failing: ${f.message}`);
    }
    return f;
  }

  /** Run one piece of the frame with its own guard, and escalate on it. */
  function safe(where, fn) {
    try {
      const v = fn();
      const f = faults.get(where);
      if (f) f.run = 0;
      return v;
    } catch (e) {
      escalate(fault(where, e));
      return undefined;
    }
  }

  /* THE LADDER — reset, then rebuild — and it has to be climbable from
     BOTH shapes of failure, which it was not.

     Counted on CONSECUTIVE failures, so a transient never reaches the
     REBUILD — and say it that way, because a long enough transient
     does climb the lower rungs, and it should. MEASURED on this build
     with WALLY.debug.audioBreakTick(n), explore score, 2.31 s bars:

       n = 3   ~7 s silent   0 alarms, 0 resets, hardRecoveries 0.
                             peak barFails 3, back to 0 one bar after
                             the fault clears, notes 14 -> 32. Nothing
                             escalates at all: 3 is under BAR_ALARM_RUN.
       n = 8   ~18 s silent  peak barFails 8, TWO alarms 5.0 s apart,
                             one transport reset each, then it heals on
                             its own with notes back on the wire and
                             hardRecoveries still 0.

     THE COUNTS ARE THE MEASUREMENT; THE WALL CLOCK IS NOT. Those two
     rows reproduce exactly, run to run, and they are what
     tools/audiotest.mjs F3/F3b actually assert. The seconds do not:
     the ladder only advances on a BAR LINE, so the whole sequence
     slides with the phase of the bar the injection happens to land
     in. The ORIGIN moves by whole 2.31 s bars (and by the 500 ms poll
     the timings are read at); the ~5.0 s SPACING between rungs does
     not. The n = 8 row read its two alarms at 9.1 s and 14.1 s with
     healing at 16.1 s on the run this comment was written from, and
     14.1 s / 19.1 s with healing at 21.1 s on another run of the same
     tree — a five-second shift of the origin, the spacing unchanged.
     Read the spacing, not the clock, and expect any single timestamp
     in this file to move by a bar or two.

     Eighteen seconds of a room the player can hear is empty SHOULD
     ring the alarm and reset the transport — that is what BAR_ALARM_RUN
     is for. What must never happen on a transient is the TOP rung: the
     rebuild is once per session and would throw away a context that
     was about to come back by itself. So the invariant is "a transient
     never reaches the rebuild", not "a transient never escalates".
     PASS G is the permanent case, where the ladder does reach it.

     WHAT WAS BROKEN. checkBarFailures() used to call music.recover()
     directly and never came through here, so a bar-level fault
     incremented no counter and could not reach the rebuild.
     MEASURED on this build: 45 s of a permanently throwing
     scheduleBar() gave recoveries 5, hardRecoveries 0 — and it would
     have gone on resetting the transport every 10 s for the life of
     the page without ever trying the one thing left. Only a throw out
     of music.tick() ITSELF could reach the rebuild, and the bar-level
     throw — the one that produced the reported dropout — is precisely
     the one that cannot throw out of tick(), because music.js catches
     it per bar. The exact fault the ladder exists for was the one it
     could not escalate. Both shapes now count into the same map and
     end at the same rung.

     MEASURED after the fix, same permanently throwing scheduleBar():
     THREE alarms — one transport reset each — and then the graph
     rebuilt on the next rung, hardRecoveries 0 -> 1, with the score
     audible again on the new context about six seconds later. The
     run this was written from read those four events at 9.1 s,
     14.1 s, 19.1 s and 24.1 s; like every timestamp above they are
     bar-phase dependent and the whole sequence slides by whole 2.31 s
     bars with the bar the injection lands in, while the ~5.0 s
     spacing between rungs holds. tools/audiotest.mjs PASS G is that
     run, and what it asserts is the counts and the ordering. */
  function escalate(f) {
    if (f.where === 'music.bar') {
      /* The bar ladder ticks on ALARMS, not on frames: one bar failure
         is one symptom every BAR_ALARM_QUIET, not sixty a second. Three
         resets that fail to make a bar land, then the graph. */
      if (f.run > BAR_RESETS) {
        rebuildGraph(`${BAR_RESETS} transport resets have not made a single bar land`);
        return;
      }
      console.error(`[audio] resetting the transport (reset ${f.run} of ${BAR_RESETS}) — `
        + 'a bar that will not schedule is silence, whatever the flags say.');
      recoveries++;
      try { music.recover(); } catch (e) { fault('music.recover', e); }
      return;
    }
    if (f.where !== 'music.tick' && f.where !== 'watchdog') return;
    if (f.run === 5) {
      console.error('[audio] the transport has failed five times running — '
        + 'resetting it rather than playing to an empty room.');
      recoveries++;
      try { music.recover(); } catch (e) { fault('music.recover', e); }
    } else if (f.run === 40) {
      rebuildGraph('40 consecutive failures out of the transport itself');
    }
  }

  /* Last resort, once per session. If the transport will not come back
     after a reset then the fault is in the graph or the context itself
     — a device change, a context the OS has quietly killed — and the
     only thing left is to build a new one. The page has sticky
     activation by this point, so the fresh context may resume without
     another gesture.

     ONCE, and shared between the two ladders on purpose: a rebuild that
     did not fix it will not fix it the second time either, and a
     rebuild loop would be a worse failure than the silence. */
  function rebuildGraph(why) {
    if (hardRecoveries >= 1) return false;
    hardRecoveries++;
    console.error(`[audio] the transport will not come back (${why}) — rebuilding the audio graph.`);
    try {
      teardownGraph();
      if (build() && wantPlaying) { music.start(); music.tick(); }
    } catch (e) { console.error('[audio] rebuild failed:', e); }
    return true;
  }

  /* THE FAILURE THIS MODULE WAS ACTUALLY LOSING, and it never threw
     anywhere update() could see it. music.js catches a bad bar inside
     its own scheduling loop, so tick() returns normally having written
     nothing to the wire — and `silentFor` stays 0.000, because the loop
     still advances the clock it is failing to fill. MEASURED against the
     real module: a bar that throws every time is three log lines in two
     minutes, silentFor 0.000 throughout, running true, and a silent
     game. The consecutive-failure count is the only symptom that
     exists, so it is read every frame rather than waited for.

     BAR_ALARM_RUN is 4 because a bar of `explore` is 4 beats at 104 bpm
     = 2.31 s, so four in a row is already nine seconds of a room the
     player can hear is empty. BAR_ALARM_QUIET spaces the rungs: it is
     the ladder's clock as well as the log's, and 5 s is two bars — long
     enough for a reset to have been given a fair chance to land one,
     short enough that the whole ladder is spent inside half a minute
     rather than after the player has already quit. */
  const BAR_ALARM_RUN = 4;        // consecutive failed bars before the alarm
  const BAR_ALARM_QUIET = 5000;   // ms between rungs (and between log lines)
  const BAR_RESETS = 3;           // resets that must fail before the rebuild
  let barAlarmAt = 0;
  let barLogs = 0;
  let barLogAt = 0;

  function checkBarFailures() {
    const run = music.barFails;
    if (run < BAR_ALARM_RUN) {
      /* A bar reached the wire. The ladder counts CONSECUTIVE alarms, so
         this is where it is torn down — and it is torn down on the
         SYMPTOM clearing, never on us having reacted to it. */
      if (run === 0) {
        const f0 = faults.get('music.bar');
        if (f0 && f0.run) { f0.run = 0; barLogs = 0; }
      }
      return;
    }
    const now = Date.now();
    if (now - barAlarmAt < BAR_ALARM_QUIET) return;
    barAlarmAt = now;

    /* Counted into the SAME map every other audio fault uses. This is a
       real throw — it happened inside music.js's own per-bar try/catch,
       which is exactly why it never reached safe() — so it gets a real
       fault record, and the rungs above become reachable from here. It
       is logged by hand rather than by fault(), because the bar count
       and the rung are worth more than a generic line. */
    const f = fault('music.bar', new Error(music.lastError || 'scheduleBar failed'),
      { silent: true });
    if (barLogs <= BAR_RESETS || now - barLogAt > FAULT_QUIET * 3) {
      barLogs++; barLogAt = now;
      console.error(`[audio] the score has failed to schedule ${run} bars in a row — `
        + `the room is silent while every flag still says "playing" `
        + `(alarm ${f.run}; the graph is rebuilt at ${BAR_RESETS + 1}). `
        + `Last error: ${music.lastError}`);
    }
    escalate(f);
  }

  function pump(reason = 'frame') {
    if (!built || !actx) return;
    if (actx.state !== 'running') { nudge(); return; }
    if (!unlocked) return;
    try {
      if (wantPlaying && !music.running && wantContext !== 'silence') {
        /* The transport was stopped — by stop(), or by a graph rebuild —
           and nothing was going to start it again. */
        music.start();
        applyContext(wantContext, { immediate: true, fade: 0.6 });
        recoveries++;
        console.warn(`[audio] transport was stopped (${reason}) — restarted`);
      } else {
        const gap = music.silentFor;
        if (gap > SILENT_LIMIT) {
          music.reanchor();
          recoveries++;
          if (Date.now() - lastStallLog > 5000) {
            lastStallLog = Date.now();
            console.warn(`[audio] transport stalled ${gap.toFixed(2)}s (${reason}) — re-anchored`);
          }
        }
      }
      music.heal();
      music.tick();
      /* A clean pass clears the run. The ladder in escalate() counts
         CONSECUTIVE failures on purpose — a transient that heals itself
         must never reach the rebuild. (It may well ring the alarm and
         cost a transport reset first; see the ladder comment above for
         the measured 3-bar and 8-bar runs.) */
      const f = faults.get('watchdog');
      if (f) f.run = 0;
    } catch (e) {
      /* This used to console.warn on every pass. The keep-alive timer
         runs at 120 ms, so a persistent fault here was eight warnings a
         second, forever — which is its own kind of invisible. */
      escalate(fault('watchdog', e));
    }
  }

  /* Only ever a RE-resume. Coming back to the tab is not a request to
     start the score for the first time — the gesture listeners above
     own that, and starting one here would jump the start beat. */
  const onVisible = () => {
    const hidden = globalThis.document?.visibilityState === 'hidden';
    /* Widen the horizon BEFORE the throttling starts, not after the first
       starved tick — going quiet is what makes Chrome throttle us harder
       still, so the first gap is the one that must not happen. */
    if (built && music) { try { music.setHorizon(hidden ? HIDDEN_HORIZON : 0); } catch {} }
    if (hidden) {
      if (built && actx?.state === 'running') { try { music.tick(); } catch {} }
      return;
    }
    nudge();
    pump('visible');
  };
  globalThis.document?.addEventListener?.('visibilitychange', onVisible, false);
  globalThis.addEventListener?.('pageshow', onVisible, false);
  globalThis.addEventListener?.('focus', onVisible, false);

  /* Build the graph immediately if the page already has permission (a
     returning visitor who has interacted with this origin). Free when it
     fails, instant music when it works.

     THE TRANSPORT IS NOT STARTED HERE, even when the context is already
     running. main.js names the score for the opening beat and only then
     calls resume(); music.js can snap the tempo to a new score while it
     is stopped but has to glide once it is running, and the cinematic's
     cuts and its title are cut against exact 54 bpm bar lines from bar 0.
     Starting a bar early costs the whole opener its timing. unlock() does
     the starting, and unlock() runs either from the start beat or from
     the player's first gesture — always before anything needs to be heard.

     Screenshot runs skip the build entirely: there will never be a
     gesture, so the only thing an eager context buys the harness is a
     repeated autoplay warning in everyone else's console output. */
  if (!ctx?.flags?.shot) build();

  /* ---------- listener ---------- */
  const lpos = [0, 0, 0], lfwd = [0, 0, -1], lup = [0, 1, 0];
  let listenerAcc = 0;
  let wdAcc = 0;

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

    /* Scheduler health. `silentFor` is the number to look at when someone
       says the music stopped: seconds of context clock past the far edge
       of what the scheduler has actually written. It is 0 while the score
       is playing, whatever `running` claims. */
    get transport() {
      if (!built) return null;
      return {
        state: actx.state, unlocked, playing: music.running,
        bar: music.bar, bpm: Math.round(music.bpm),
        silentFor: +music.silentFor.toFixed(3),
        horizon: +music.horizon.toFixed(2),
        tickGap: +music.tickGap.toFixed(3),
        reanchors: music.reanchors,
        errors: music.errors,
        /* Bars that have failed IN A ROW. The one number that is
           non-zero while a throwing scheduler plays to an empty room —
           `silentFor` cannot see that case at all. */
        barFails: music.barFails,
        lastError: music.lastError,
        recoveries,
        hardRecoveries,
        /* Which rung of the bar ladder we are on: consecutive ALARMS,
           not consecutive bars. `> BAR_RESETS` is the rebuild. */
        barAlarms: faults.get('music.bar')?.run || 0,
        faults: Object.fromEntries([...faults.values()].map((f) => [f.where, f.n])),
        voices: music.voices,
        tracked: music.tracked,
        busGain: +music.out.gain.value.toFixed(3),
        /* The environment layer's own liveness. `steps` not climbing
           while the player walks is a dead footstep wire, which is
           precisely the failure that shipped; `shelterRays` climbing
           with `shelterHits` at 0 through a rainy town is roofs that
           are not in the collision world. */
        steps, strikes, shelterRays, shelterHits,
        envMs: +envMs().toFixed(4), envSamples,
      };
    },
    /** Force a watchdog pass. The test harness uses it; so can a player
        who has left the tab for an hour and clicked back in. */
    pump(reason = 'manual') { pump(reason); return api; },

    /* --- lifecycle --- */
    init() { build(); return api; },

    /* Callable from inside a gesture handler (the unlock is done before
       this returns, so the caller's activation still counts) or from
       anywhere else (the promise then just reports what happened).

       The promise ALWAYS settles. A blocked context's own resume() can
       stay pending for the life of the page, and main.js's start beat
       must never be left waiting on it — so we poll our own state and
       give up after 1.5 s with the truth. */
    resume() {
      if (SHOT) return Promise.resolve(false);
      if (unlockSync()) return Promise.resolve(true);
      return new Promise((res) => {
        let done = false;
        const settle = (v) => {
          if (done) return;
          done = true; clearInterval(iv); clearTimeout(to); res(v);
        };
        const iv = setInterval(() => { if (finish()) settle(true); }, 60);
        const to = setTimeout(() => settle(api.running === true), 1500);
        iv?.unref?.(); to?.unref?.();
      });
    },
    /** True once a gesture has actually got sound out of the device. */
    get unlocked() { return unlocked; },

    /* --- musical context ---
       The change is queued inside music.js and committed on the next bar
       line, so a zone transition never cuts a note in half. */
    setContext(name, opts = {}) {
      /* An explicit request for a score is also a request to be playing:
         it undoes a previous stop() as far as the watchdog is concerned. */
      if (name && name !== 'silence') wantPlaying = true;
      applyContext(name, opts);
      return api;
    },
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

    /* --- world state ---

       RETURNS A BOOLEAN, and an unknown name is refused rather than
       quietly mapped to `clear`. The old signature returned the api
       object — truthy for every input, including the three-quarters of
       weather.js's vocabulary this table did not author — so a caller
       had no way to tell an applied state from a dropped one. Same
       defect, same shape, same missing state as the `overcast` note in
       src/world/weather.js; that one cost a screenshot campaign a whole
       axis. The wording below is deliberately its wording.

       `opts.from` and `opts.fade` come off the world's `weather` event
       and are what makes the change ARRIVE rather than switch. */
    setWeather(name, opts = {}) {
      if (!WEATHER[name]) {
        console.error(`[audio] unknown weather "${name}" — audio.js authors `
          + `${WEATHER_NAMES.join(', ')} (weather.js's four, and no others). `
          + `NOTHING CHANGED; the soundscape is still "${wantWeather}". `
          + 'A caller that ignores this false is hearing the previous state.');
        return false;
      }
      if (name === wantWeather) return true;
      wxFrom = wantWeather;
      wantWeather = name;
      wxFade = Number(opts.fade);
      if (!Number.isFinite(wxFade) || wxFade < 0) wxFade = 150;
      wxLocal = wxFade <= 0 ? 1 : 0;
      /* Do NOT re-issue the context here. The beds move on the sampler,
         over the sky's own fade; a fade:3 applyContext was the old
         switch and it is exactly what "a storm should arrive and leave"
         rules out. A fade of 0 is the debug snap, so settle it now. */
      if (built && wxFade <= 0) { sampleEnv(1 / 30); refreshEnv(0.05); }
      return true;
    },
    get weather() { return wantWeather; },
    get weatherNames() { return WEATHER_NAMES; },
    /** The live environment the beds are riding. Read-only in practice. */
    get env() {
      return {
        ...env,
        source: wxSource, from: wxFrom, to: wantWeather, fade: wxFade,
        /* read defensively: the sampler decided the branch up to 250 ms
           ago and ctx.sky can be gone by now (PASS W10 removes it). */
        progress: (wxSource === 'sky' && typeof ctx?.sky?.weatherProgress === 'number')
          ? +clamp(ctx.sky.weatherProgress, 0, 1).toFixed(4)
          : +wxLocal.toFixed(4),
        shelterRays, shelterHits,
        ms: +envMs().toFixed(4), samples: envSamples,
      };
    },
    get hour() { return hour; },

    /** Feed the sky's clock in; in auto mode this flips explore <-> night. */
    setTimeOfDay(h) {
      hour = ((+h || 0) % 24 + 24) % 24;
      updateNight();
      /* TWO WRITERS, ONE DECISION. Once the walking driver has armed
         (i.e. there is a world and a body to sample), IT decides the
         context, night included — contextForZone() runs the same
         nightNow() predicate this branch does. Leaving both live meant
         dawn in a town fired explore from here and town from the
         sampler 250 ms later: two queued bar changes for one sunrise.
         This branch is the no-world fallback and is still the only
         path when audio runs without ctx.world (tools/test-audio.mjs,
         the offline context) — which is the branch PASS Z's Z9 drives
         by turning the driver off. */
      if (autoNight && !(zoneRule && zoneArmed)) {
        const isNight = nightNow();
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
    stopMusic(opts) { wantPlaying = false; if (built) music.stop(opts); return api; },
    stop() {
      wantPlaying = false;
      if (!built) return api;
      music.stop({ fade: 0.8 });
      sfx.stopBeds(0.8);
      bedsOff = true;
      pushed.clear();
      return api;
    },

    /* --- frame ---
       Nothing in here may throw into main.js's frame loop. main.js now
       guards every hook itself — a throw from here costs audio one frame
       rather than the session — but this module still contains its own
       failures, because it is the one that knows how to recover from
       them and main.js only knows how to switch a subsystem off.

       ONE GUARD PER SUB-CALL, not one around the frame. The old shape
       was a single try/catch behind a single console.warn gated on a
       flag that was set once and never cleared: a throwing tick() also
       stopped the ambience beds and the 3D listener (they sit after it
       in the same block) and said so exactly once for the life of the
       page. See the FAULT REPORTING note above. */
    update(dt) {
      if (!built || !actx) return;
      if (actx.state !== 'running') { safe('nudge', nudge); return; }

      safe('music.tick', () => music.tick());

      /* The full watchdog four times a second — cheap, but no reason to
         run the gain reads on every frame. pump() carries its own guard. */
      wdAcc += dt;
      if (wdAcc >= 0.25) { wdAcc = 0; pump('frame'); }

      /* The score can stop dead without a single exception reaching this
         function; music.js catches its own bad bars. So ask it. */
      safe('barcheck', checkBarFailures);

      const w = ctx?.wind?.strength;
      safe('sfx.update', () => sfx.update(dt, { wind: typeof w === 'number' ? w : 0.4 }));

      /* The environment, four times a second, on its OWN guard. It
         reads four other modules' public queries and any one of them
         can start throwing after somebody else's edit — and a sampler
         that fails quietly is a world that stops responding to the
         weather with a green console, which is the exact bug this file
         was found with. safe() counts it and prints a stack. */
      envAcc += dt;
      if (envAcc >= 0.25) {
        const d = envAcc; envAcc = 0;
        safe('env', () => sampleEnv(d));
      }

      listenerAcc += dt;
      if (listenerAcc >= 1 / 30) {
        safe('listener', () => updateListener(listenerAcc));
        listenerAcc = 0;
      }
    },

    dispose() {
      for (const g of GESTURES) globalThis.removeEventListener?.(g, onGesture, true);
      globalThis.document?.removeEventListener?.('visibilitychange', onVisible, false);
      globalThis.removeEventListener?.('pageshow', onVisible, false);
      globalThis.removeEventListener?.('focus', onVisible, false);
      clearInterval(keepAlive);
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      if (!built) return;
      try { if (actx) actx.onstatechange = null; } catch {}
      teardownGraph();
    },
  };

  /* The frame loop is the primary clock for the scheduler, but rAF is
     throttled when the tab is hidden and stops entirely when a mobile
     browser backgrounds it. A slow timer keeps the score from stalling —
     and, more importantly, from scheduling a catch-up burst on return. */
  const keepAlive = setInterval(() => {
    if (!built || !actx) return;
    /* pump() ticks, heals and re-anchors — and a phone that re-suspended
       us without ever firing a statechange we heard (it happens on return
       from a call) is picked up by its nudge(). This timer is the ONLY
       clock left in a hidden tab, so it has to carry the watchdog too,
       not just the tick. */
    pump('keepalive');
  }, 120);
  keepAlive?.unref?.();   // no-op in a browser; lets a node test exit cleanly

  /* ============================================================
     BUS WIRING.

     A LISTENER NOBODY CALLS IS NOT WIRING, AND THIS BLOCK WAS MOSTLY
     LISTENERS NOBODY CALLS. Counted across src/ on the tree this note
     was written on: of the 28 events subscribed here, 22 had ZERO
     emitters anywhere in the codebase. The soundscape was not
     under-tuned, it was unplugged — and every one of them looked
     plausible in review because the names were the names another agent
     would obviously have used.

     What was really being emitted, and what this file was listening
     for, are two different vocabularies:

       emitted                    listened for        result
       ------------------------   -----------------   -----------------
       weather   (weather.js)     audio:weather       rain SILENT
       sky:lightning (weather.js) — nothing —         storms SILENT
       phys:step (physics.js)     wally:step          NO FOOTSTEPS AT ALL
       phys:land / phys:jump      wally:land/jump     silent
       water:splash               wally:splash        (water.js re-emits
                                                       `sfx`, so covered)
       money / quest (state.js)   game:money/:quest   ui.js plays its own

     So every listener below is now bound to a name something in this
     repo ACTUALLY emits, verified by grep and by tools/audiotest.mjs
     PASS W. The old `audio:*` and `wally:*` names are kept alongside,
     not replaced: they are the module's public command channel and
     tools/test-audio.mjs and the debug hooks drive them.

     EVERY NEW HANDLER RUNS UNDER safe(). ctx.bus's own emit() catches
     and console.errors a throwing handler, which keeps the emitter
     alive but feeds nothing to the escalation ladder — the same shape
     as the caught-per-bar scheduleBar() that made the score fail
     silently while the console stayed green. A handler that starts
     throwing has to climb the same rungs as everything else.
     ============================================================ */
  const bus = ctx?.bus;
  /* The unsubscribers for the listeners this round added, and the
     switch WALLY.debug.audioRevertWiring() throws. */
  const newWiring = [];
  let wireEnvironment = () => {};
  let reverted = false;
  if (bus) {
    /** Bind a listener that cannot fail quietly. */
    const on = (type, where, fn) => bus.on(type, (p) => safe(where, () => fn(p)));

    on('sfx', 'bus.sfx', (p) => {
      if (typeof p === 'string') api.sfx(p);
      else if (p && p.name) api.sfx(p.name, p);
    });
    bus.on('audio:context', (p) => api.setContext(typeof p === 'string' ? p : p?.name, p || {}));
    bus.on('audio:sting', (p) => api.sting(typeof p === 'string' ? p : p?.name));
    bus.on('audio:duck', (p) => duckFor(typeof p === 'number' ? p : p?.seconds ?? 2, p?.amount ?? 0.35));
    bus.on('audio:mute', (p) => api.mute(!!p));
    bus.on('audio:surface', (p) => api.setSurface(typeof p === 'string' ? p : p?.name));

    /* `audio:weather` is the module's COMMAND channel and stays exactly
       where it was — which is also what makes the revert below honest:
       back the new wiring out and this is all that is left, i.e. the
       shipping code, i.e. silence. */
    bus.on('audio:weather', (p) => api.setWeather(typeof p === 'string' ? p : p?.name, p || {}));

    /* ============================================================
       THE FIVE THE WORLD ACTUALLY EMITS — registered together, and
       unsubscribable together, so WALLY.debug.audioRevertWiring(false)
       can put the module back into the state this round found it in
       ON THE SAME PAGE LOAD. That is the strong form of a revert check
       (contracts.js rule 1, first bullet: a switch in the module,
       shipping rule and prior rule side by side): the alternative is
       quoting a before-number, which stays in the file reading like
       evidence long after the code it describes is gone.
       ============================================================ */
    wireEnvironment = () => {
      /* ---- THE WEATHER. `weather` is the world's own event, emitted
         by src/world/weather.js set(). The payload's `from` and `fade`
         are what let the change arrive over the sky's minutes instead
         of switching. */
      newWiring.push(on('weather', 'bus.weather', (p) => api.setWeather(
        typeof p === 'string' ? p : p?.name, (p && typeof p === 'object') ? p : {})));

      /* ---- THUNDER. weather.js has been emitting this since lightning
         shipped, with a comment saying "audio can schedule the thunder
         itself" — and nothing anywhere listened, so every storm in this
         game has flashed in silence. The flash carries its own delay;
         that delay IS the distance, so read it as one: a strike four
         seconds out is a long dull roll, one at half a second is a
         crack. */
      newWiring.push(on('sky:lightning', 'bus.lightning', (p) => {
        const d = clamp(Number(p?.delay ?? 1.2), 0, 6);
        const near = clamp(1 - d / 4.2, 0, 1);
        api.sfx('thunder', {
          delay: d,
          gain: (0.45 + 0.85 * clamp(Number(p?.intensity ?? 0.8), 0, 1.4)) * (0.30 + 0.80 * near),
          pitch: 0.50 + 0.60 * near,
          length: 1.9 - near * 0.8,
          vary: 0.10,
        });
        strikes++;
      }));

      /* ---- FOOTSTEPS, WHICH THIS GAME HAS NEVER HAD.
         sfx.js has authored six surface recipes since it was written —
         grass, sand, wood, stone, water, dirt — and nothing in the repo
         has ever called one of them. physics/controller.js has emitted
         a stride event the whole time, on `phys:step`; this file
         listened on `wally:step`, which has no emitter. One name.

         The surface comes from ctx.world's own queries rather than from
         a flag somebody has to remember to set, so it is right on a
         beach, in the shallows and on a road without anybody
         maintaining it. And it is WET: sky.wetness is a signal
         weather.js publishes that nothing was reading, so a stone
         street after rain now has puddles in it. */
      newWiring.push(on('phys:step', 'bus.step', (p) => {
        const pos = p?.position;
        if (!pos) return;
        const surf = surfaceAt(pos);
        const run = !!p?.running;
        api.sfx('step', {
          position: pos, surface: surf,
          gain: (run ? 1.0 : 0.72) * (0.85 + 0.3 * (ctx?.rng?.() ?? 0.5)),
          pitch: run ? 1.06 : 1.0,
        });
        /* A puddle underfoot. Only on hard ground — grass and sand do
           not hold water in a way you can hear. */
        const wet = clamp(Number(ctx?.sky?.wetness ?? 0), 0, 1);
        if (wet > 0.35 && (surf === 'stone' || surf === 'dirt' || surf === 'wood')
            && (ctx?.rng?.() ?? 1) < wet * 0.45) {
          api.sfx('splash.small', { position: pos, gain: 0.10 + wet * 0.16, pitch: 1.5 + wet * 0.5 });
        }
        steps++;
      }));
      newWiring.push(on('phys:land', 'bus.land', (p) => {
        const impact = clamp(Number(p?.impact ?? 0.3), 0, 1);
        api.sfx(impact > 0.55 ? 'land.heavy' : 'land', {
          position: p?.position, surface: surfaceAt(p?.position),
          gain: 0.5 + impact * 0.7,
        });
      }));
      newWiring.push(on('phys:jump', 'bus.jump',
        (p) => api.sfx('jump', { position: p?.position, gain: 0.75 })));
    };
    wireEnvironment();

    /* Kept: the module's own command channel, and what the other
       character agents were told to emit. */
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
    /* ONE TABLE DECIDES. ui.js emits { name, zone } from the `place`
       event, where `name` is ITS copy of the district map. Resolve the
       DISTRICT through ZONE_CONTEXT first so the door and the ground
       cannot disagree, and fall back to the name for any caller that
       emits a bare context (the intro, WALLY.debug.audioContext). */
    bus.on('game:zone', (p) => {
      if (typeof p === 'string') return api.setContext(p);
      const byZone = p?.zone && ZONE_CONTEXT[p.zone];
      api.setContext(byZone ? contextForZone(p.zone) : (p?.audio || p?.name));
    });
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
    dbg.audioPump = (why) => api.pump(why || 'debug');

    /* ---- the environment layer, for tools/audiotest.mjs PASS W ----
       These read and drive the SHIPPING path; none of them is a
       parallel implementation. audioEnv() is api.env verbatim plus the
       bed levels the mix actually produced, so an assertion can check
       the level rather than the intent. */
    dbg.audioEnv = () => ({
      ...api.env,
      weather: wantWeather,
      beds: built
        ? Object.fromEntries(sfx.beds.map((b) => [b, +sfx.bedLevel(b).toFixed(4)]))
        : null,
      skyWeather: ctx?.sky?.weatherName ?? null,
      skyRain: typeof ctx?.sky?.rainfall === 'number' ? +ctx.sky.rainfall.toFixed(4) : null,
      skyProgress: typeof ctx?.sky?.weatherProgress === 'number'
        ? +ctx.sky.weatherProgress.toFixed(4) : null,
    });
    /** How many of each one-shot the bank has actually scheduled — the
        only visibility there is into the five EMITTER beds (gulls, and
        the shout / bird / drip / cricket layers), which have no
        continuous signal for an analyser to read. */
    dbg.audioEmitted = () => (built ? sfx.emitted : null);
    /** Force a sampler pass now rather than waiting for the 4 Hz tick. */
    dbg.audioSampleEnv = (dt = 0.25) => { sampleEnv(dt); return dbg.audioEnv(); };
    /** A window onto the SHIPPING surface query, not a copy of it —
        this is the same function the phys:step handler calls. */
    dbg.audioSurfaceAt = (x, z) => surfaceAt({ x, y: 0, z });
    /** Drive setWeather directly, bypassing the world. Returns the BOOLEAN. */
    dbg.audioWeather = (n, fade = 0) => api.setWeather(n, { fade });

    /* ============================================================
       THE TAP — a real AnalyserNode on a real gain node.

       Everything else on this object reports an INTENT. bedLevel() is
       the number mixFor() asked for; env is what the sampler decided;
       `beds` in audioEnv() is bedLevel() by another name. All three
       stay correct while the bed is silent — the node never built, the
       ramp never scheduled, the graph disconnected by a rebuild — and
       that is the exact shape of failure this project keeps finding.

       So: hang an analyser off the node the signal really passes
       through and read the samples. The analyser has no OUTPUT
       connection, so it is a tap and not an insert: it cannot change
       what the player hears.

         audioTap('waves')  a bed, at sfx.js's `mod` node
         audioTap('amb')    every bed summed  (sfx.ambOut)
         audioTap('sfx')    the one-shot bank (sfx.out) — the ONLY
                            place gulls, crickets, birds, market shouts
                            and cave drips exist, because those five
                            beds are emitters with no continuous
                            signal of their own
         audioTap('music')  the score
         audioTap('master') everything, post-duck

       Returns null for a bed that has never been built, which is a
       finding and not a failure of the instrument.
       ============================================================ */
    dbg.audioTap = (name) => {
      if (!built) return null;
      const node = name === 'amb' ? sfx.ambOut
        : name === 'sfx' ? sfx.out
        : name === 'music' ? music.out
        : name === 'master' ? master
        : sfx.bedNode(name);
      if (!node) return null;
      const an = actx.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0;      // no averaging: raw samples
      node.connect(an);                  // tap, not insert — no output
      const buf = new Float32Array(an.fftSize);
      return {
        name,
        /** RMS of the last 2048 samples (~46 ms at 44.1 kHz). */
        rms() {
          an.getFloatTimeDomainData(buf);
          let s = 0;
          for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
          return Math.sqrt(s / buf.length);
        },
        /** Absolute peak, for one-shots that fall between RMS windows. */
        peak() {
          an.getFloatTimeDomainData(buf);
          let m = 0;
          for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > m) m = v; }
          return m;
        },
        dispose() { try { node.disconnect(an); } catch { /* already gone */ } },
      };
    };
    /* ============================================================
       RUNTIME REVERT for THIS round — the walking driver and the sea
       ceiling, off, on the same page load, with the module put back
       into the state this round found it in. contracts.js rule 1,
       first bullet: a switch in the module, shipping rule and prior
       rule side by side, rather than a before-number quoted in a
       comment that goes on reading like evidence after the code it
       describes is gone.

       OFF is exactly the old file:
         · no zone is ever committed and nothing is ever driven from
           where he is standing, so the score is whatever the last
           `place` event said — which, walking, is nothing;
         · mixFor()'s surf is a floor and only a floor, so `explore`
           authors 0.34 waves at the bottom of a mine again;
         · setTimeOfDay() goes back to owning the day/night flip on
           its own, because with the driver off nothing else would.

       tools/audiotest.mjs PASS Z, Z9-Z11, flips it and re-runs the
       same three assertions, which must then fail.
       ============================================================ */
    dbg.audioRevertZone = (on = false) => {
      zoneRule = !!on;
      zoneCand = null; zoneDwellT = 0; zoneArmed = false; zoneCommitted = null;
      env.zone = null; env.zoneDwell = 0;
      updateNight();
      /* Put the module back where the un-driven build always sat:
         `explore`, because the only thing that ever moved it was a
         door. Same reasoning as audioRevertWiring's reset to `clear`. */
      applyContext(nightNow() ? 'night' : 'explore', { fade: 0.4 });
      return { zoneRule, context: wantContext };
    };
    /** The driver's live state — candidate, dwell, and what it committed. */
    dbg.audioZone = () => ({
      raw: env.zoneRaw, committed: env.zone, dwell: env.zoneDwell,
      hold: ZONE_HOLD, night: nightNow(), rule: zoneRule, armed: zoneArmed,
      hour: +hour.toFixed(2), skyNight: typeof ctx?.sky?.night === 'number' ? +ctx.sky.night.toFixed(3) : null,
      context: wantContext, want: contextForZone(env.zone),
      sea: +env.sea.toFixed(4), shore: +env.shore.toFixed(4),
    });

    /* RUNTIME REVERT — the shipping wiring and the wiring as it was,
       side by side on one page load, which is the strong form this
       project asks for (contracts.js, HOW THIS PROJECT PROVES A FIX,
       rule 1). `off` unsubscribes the four listeners this round added
       and puts back exactly what was there before: a listener on
       `audio:weather`, which nothing emits. tools/audiotest.mjs W8
       flips it and re-runs the same assertions, which must then fail. */
    dbg.audioRevertWiring = (on = false) => {
      if (!bus) return null;
      if (!on && !reverted) {
        for (const off of newWiring) off();
        newWiring.length = 0;
        reverted = true;
      } else if (on && reverted) {
        wireEnvironment();
        reverted = false;
      }
      /* Put the module back to the state the un-wired build was always
         in — `clear`, because nothing ever told it otherwise — so the
         reverted run starts where the shipping build started rather
         than wherever the last assertion left it. */
      wxFrom = 'clear'; wantWeather = 'clear'; wxLocal = 1; wxFade = 150;
      steps = 0; strikes = 0; shelterRays = 0; shelterHits = 0;
      sampleEnv(1 / 30); refreshEnv(0.05);
      return { reverted, listeners: newWiring.length, weather: wantWeather };
    };
    /* Simulate cause (3): a fade-out left at zero, so the score plays
       perfectly into a muted bus. heal() must put it back. */
    dbg.audioBreakBus = () => {
      if (!built) return null;
      const t = actx.currentTime;
      music.out.gain.cancelScheduledValues(t);
      music.out.gain.value = 0;
      return +music.out.gain.value.toFixed(3);
    };
    /* Simulate the worst case: the transport is dead and nothing in the
       game knows it, while the player is still very much expecting a
       score. Only the watchdog can get out of this one. */
    dbg.audioKillTransport = () => {
      if (!built) return null;
      music.stop({ hard: true });      // NOT api.stop(): intent is untouched
      return music.running === false;
    };
    dbg.audioTransport = () => api.transport;
    /* Simulate the cause the module used to lose entirely: a bar that
       throws. Web Audio throws in exactly this place when it is handed a
       value it does not like, and music.js catches it per bar — so the
       tick returns normally, the wire stays empty, silentFor reads 0.000
       and the console is green. `n = true` means forever.
         audioBreakTick(3)           three bad bars: ~7 s of silence,
                                     peak barFails 3, 0 alarms, 0 resets,
                                     heals a bar after the fault clears
         audioBreakTick(8)           THE DEFAULT. Eight bad bars is ~18 s
                                     of silence: peak barFails 8, TWO
                                     alarms ~5.0 s apart, one transport
                                     reset each, then it heals on its own.
                                     hardRecoveries stays 0 — a transient
                                     never reaches the rebuild, which is
                                     the invariant. Both runs MEASURED on
                                     this build, and it is the COUNTS that
                                     reproduce: the ladder steps on bar
                                     lines, so every timestamp slides by
                                     whole 2.31 s bars with the bar the
                                     injection lands in. This build read
                                     the two alarms at 9.1 / 14.1 s and
                                     healing at 16.1 s; another run of the
                                     same tree read 14.1 / 19.1 s and
                                     21.1 s. See tools/audiotest.mjs F3b.
         audioBreakTick(true)        permanent, until cleared
         audioBreakTick(3, 'tick')   the whole tick throws, not just a bar
       Used by tools/audiotest.mjs PASS F. */
    dbg.audioBreakTick = (n = 8, where = 'bar') => (built ? music.injectFault(n, where) : null);
    dbg.audioClearFault = () => {
      if (!built) return null;
      music.clearFault();
      faults.clear();
      barAlarmAt = 0; barLogs = 0; barLogAt = 0;
      return true;
    };
    /* Simulate the failure this all exists for: freeze the transport as
       if the tab had been backgrounded for `seconds` and every clock had
       been throttled away. The watchdog should pick it up within a tick
       of the next pump. Used by tools/audiotest.mjs PASS E. */
    dbg.audioStall = (seconds = 3) => {
      if (!built) return null;
      music.setHorizon(0);
      return music.stall(seconds);
    };
    dbg.audioState = () => ({
      ready: api.ready, running: api.running, context: api.context,
      unlocked, resumeAttempts, rebuilds, state: actx?.state ?? null,
      transport: api.transport,
      pending: api.pendingContext, bar: api.bar, bpm: Math.round(api.bpm),
      voices: api.voices, muted: api.muted, weather: wantWeather,
      env: api.env,
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
