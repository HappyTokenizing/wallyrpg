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
    ready: false, running: false, suspended: true, muted: true, unlocked: false,
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
  /* Does the game WANT a score right now? The watchdog restarts a
     transport that stopped by accident, so it has to be able to tell that
     from one the game stopped on purpose — stop() and stopMusic() must
     stay stopped. Only the unlock and an explicit setContext turn this
     back on. */
  let wantPlaying = false;
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

    const mix = { ...(AMBIENCE[name] || {}) };
    const w = WEATHER[wantWeather] || WEATHER.clear;
    for (const k in w) mix[k] = Math.max(mix[k] || 0, w[k]);
    sfx.ambience(mix, immediate ? 0.3 : Math.max(1.2, fade));

    const space = forcedSpace || SCORES[name].space || 'outdoor';
    reverb.setSpace(space, immediate ? 0.05 : Math.max(0.8, fade));
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
    stopMusic(opts) { wantPlaying = false; if (built) music.stop(opts); return api; },
    stop() {
      wantPlaying = false;
      if (!built) return api;
      music.stop({ fade: 0.8 });
      sfx.stopBeds(0.8);
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
    dbg.audioPump = (why) => api.pump(why || 'debug');
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
