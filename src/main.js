/* ============================================================
   main.js — boot sequence and frame loop.

   Order matters. Each stage may depend on everything before it and
   nothing after it:

     1  render     renderer, composer, quality
     2  mat        material factories (needs render for encoding)
     3  wind       global wind uniforms (materials read these)
     4  sky        sun, lights, time of day, fog
     5  world      terrain, city, foliage, props
     6  water      ocean (needs terrain heights)
     7  phys       collision world (needs world geometry)
     8  wally      character (needs phys to stand on)
     9  cam        camera rig (needs wally to follow)
    10  game       state, economy, quests, save
    11  ui         hud, phone, dialogue
    12  audio      music + sfx
    13  intro      cinematic (takes over camera until done)
   ============================================================ */

import * as THREE from '../vendor/three.module.js';
import { createContext } from './core/contracts.js';

import { init as initRender } from './render/renderer.js';
import { init as initMat }    from './render/toon.js';
import { init as initWind }   from './core/wind.js';
import { init as initSky }    from './world/sky.js';
import { init as initWorld }  from './world/world.js';
import { init as initFoliage } from './world/foliage.js';
import { init as initCity }   from './world/city.js';
import { init as initWater }  from './world/water.js';
import { init as initPhys }   from './physics/physics.js';
import { init as initWally }  from './character/wally.js';
import { init as initNpc }    from './character/npc.js';
import { init as initCam }    from './core/camera.js';
import { init as initGame }   from './game/game.js';
import { init as initUI }     from './ui/ui.js';
import { kb }                 from './ui/kbowner.js';
import { init as initAudio }  from './audio/audio.js';
import { init as initIntro }  from './intro/intro.js';

const STAGES = [
  ['render', initRender], ['mat', initMat],   ['wind', initWind],
  ['sky',    initSky],    ['world', initWorld], ['city',  initCity], ['foliage', initFoliage], ['water', initWater],
  ['phys',   initPhys],   ['wally', initWally], ['npc',   initNpc],   ['cam',   initCam],
  ['game',   initGame],   ['ui',    initUI],    ['audio', initAudio],
  ['intro',  initIntro],
];

async function boot() {
  const canvas = document.getElementById('gl');

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,          // we resolve AA in post (SMAA), see render/postfx.js
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
    depth: true,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    50, innerWidth / innerHeight, 0.1, 4000
  );
  camera.position.set(0, 3, 8);

  const ctx = createContext({ canvas, renderer, scene, camera });
  window.WALLY = { ctx, THREE, debug: {} };   // debug + screenshot handle

  /* ---- boot progress ------------------------------------------------
     Weights are MEASURED, not guessed — timed over a full cold boot at
     1280x720. An evenly-weighted 16-stage bar would sit visibly frozen
     on whichever stage happens to dominate, which is worse than no bar.

     These numbers are from AFTER the npc streaming rewrite. npc used to
     be 63.5% of a 13.3 s boot; it now plans everyone at boot and meshes
     the distant population lazily over the first seconds of play, so the
     stage fell to 1.75 s and the shape of the boot changed completely:

       wally 35.9% · npc 27.3% · city 20.7% · world 9.3% · audio 3.1%
       everything else under 1% each

     RE-MEASURE THESE IF YOU CHANGE WHAT A STAGE DOES. A stale weight
     table does not fail loudly — the bar just races and then crawls.
     Stages not listed get MIN_W so they still nudge the bar visibly. */
  const STAGE_W = {
    render: 0.2, mat: 1.0, wind: 0.1, sky: 0.2, world: 9.3, city: 20.7,
    foliage: 0.7, water: 0.9, phys: 0.2, wally: 35.9, npc: 27.3,
    cam: 0.1, game: 0.2, ui: 0.5, audio: 3.1, intro: 0.2,
  };
  const MIN_W = 0.1;
  const totalW = STAGES.reduce((a, [n]) => a + (STAGE_W[n] ?? MIN_W), 0);

  const elStage = document.getElementById('bootStage');
  const elPct = document.getElementById('bootPct');
  const elFill = document.getElementById('bootFill');

  let doneW = 0;            // weight of fully-completed stages
  let curW = 0;             // weight of the stage in flight
  let shown = -1;

  function paint(frac) {
    const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    if (pct === shown) return;
    shown = pct;
    if (elFill) elFill.style.width = pct + '%';
    if (elPct) elPct.textContent = pct + '%';
  }

  /* Stages may report progress WITHIN themselves. ctx.boot.sub(f) moves the
     bar across the current stage's slice; ctx.boot.tick(f) does that and
     also yields a frame, which is the only way the bar can actually repaint
     during a long synchronous build. */
  ctx.boot = {
    sub(f) {
      paint((doneW + curW * Math.max(0, Math.min(1, f))) / totalW);
    },
    async tick(f) {
      ctx.boot.sub(f);
      await new Promise((r) => requestAnimationFrame(() => r()));
    },
    label(text) { if (elStage) elStage.textContent = text; },
  };

  /* Which stage a frame handle came from. A WeakMap rather than a property
     on the handle: these are other agents' objects and we do not write to
     them. It is what turns "something threw" into "wally.update threw". */
  const hname = new WeakMap();
  const nameOf = (h, i) => hname.get(h) || `handle#${i}`;

  for (const [name, init] of STAGES) {
    curW = STAGE_W[name] ?? MIN_W;
    ctx.boot.label(name);
    ctx.boot.sub(0);
    // Let the label and bar paint before a stage blocks the main thread.
    await new Promise((r) => requestAnimationFrame(() => r()));
    try {
      const handle = await init(ctx);
      if (handle) {
        ctx[name] = handle;
        hname.set(handle, name);
        ctx._handles.push(handle);
      }
    } catch (e) {
      console.error(`[boot] stage "${name}" failed:`, e);
      ctx.bus.emit('boot:error', { name, error: e });
    }
    doneW += curW;
    curW = 0;
    paint(doneW / totalW);
  }
  ctx.boot.label('ready');
  paint(1);

  /* ================================================================
     THE FRAME LOOP — and why it is wrapped the way it is.

     This loop used to re-arm requestAnimationFrame on its LAST line,
     with no try/catch anywhere in it. That made every module's update()
     a single point of failure for the whole session: one throw, the rAF
     was never re-armed, every subsystem stopped at once, and the last
     painted frame sat on screen looking like a GPU hang rather than a
     crash. MEASURED on this build before the change — inject one
     handle whose update() throws and ctx.frame goes 34 -> 36 and then
     never moves again; three seconds later it is still 36, with a
     single pageerror in the console and nothing else. Not hypothetical
     either: a ReferenceError out of another module's in-flight edit
     took a whole boot stage down this week.

     Three rules now:

       1  rAF IS RE-ARMED FIRST, before a single line of work. Nothing
          below can cost us the next frame.
       2  EVERY HOOK RUNS IN ITS OWN try/catch. A throw costs that one
          module that one frame — the handles after it in the list
          still update, and the frame still renders. One try/catch
          around the whole batch would still let handle #2 starve
          handles #3..#16 forever, which is most of the game.
       3  A THROW IS LOUD, ONCE, AND THEN BOUNDED. Swallowing quietly
          is exactly how src/audio/music.js came to lose the score
          behind three console.warns (see the note there). So: the
          first FAULT_LOGS throws from a hook print a full stack at
          console.ERROR level — the level tools/shot.mjs greps for, so
          every screenshot tool in tools/ now exits non-zero on one —
          then one line every FAULT_QUIET ms while it keeps failing,
          and at FAULT_LIMIT the hook is switched off for the session
          with a banner on screen and an entry in
          window.__WALLY_HEALTH__. A module throwing sixty times a
          second is not going to fix itself, and sixty stack traces a
          second is as unreadable as none at all.
     ================================================================ */
  const FAULT_LIMIT = 12;      // throws from one hook before it is switched off
  const FAULT_LOGS = 3;        // full stack traces before we rate-limit
  const FAULT_QUIET = 30000;   // ms between "still throwing" lines

  /* The place a developer looks after the fact — and what
     tools/audiotest.mjs asserts against. */
  const health = { frames: 0, errors: 0, disabled: [], sources: {}, last: null };
  window.__WALLY_HEALTH__ = health;

  const faults = new Map();
  const injected = [];
  let faultBanner = null;
  let bannerPlaced = 0;

  /* THE BANNER GOES UNDER THE HUD, NEVER OVER IT.
     ----------------------------------------------------------------
     It used to be top:0, full width, 27 px tall. MEASURED at 1600x900
     with a hook disabled: the top pill row sits at y 12..40, so the
     banner covered the day/clock/energy/hunger pills on the left and
     the money, TICKER, reputation and city-percent badges on the
     right — sliced through the middle with only their bottom third
     showing. pointer-events:none, so nothing was ever blocked, and it
     only exists in a fault state — but a fault report that hides the
     four numbers a player is trying to read is a poor way to report a
     fault, and the render-fallback screenshot is exactly where you
     want to see both at once.

     So the position is MEASURED rather than guessed. The top HUD
     clusters are `.w-bar` (src/ui/hud.js builds .w-bar.left — pills,
     objective card, lock strip — and .w-bar.right — the badge row);
     we take the lowest edge of the ones that are actually visible and
     sit BANNER_GAP under it. Three cases, all checked:

       · HUD up        → under the deepest cluster
       · Hide UI on    → style.js hides .w-bar with VISIBILITY, not
                         display, so those boxes still have live rects
                         (deliberately — touch.js measures one of them).
                         The COMPUTED style is what is read here, so
                         they are skipped and the banner rises to the
                         top of an empty screen.
       · no UI at all  → nothing matches, same top edge.

     Re-measured on resize and, while a banner is up, twice a second:
     orientation, Hide UI and a two-line objective all move that edge,
     and a banner is not allowed to drift back over the numbers later
     just because it was placed correctly once. Half the viewport is
     the ceiling — a HUD deep enough to push it further than that is a
     UI bug, and the fault still has to be readable through it. */
  const BANNER_GAP = 8;

  function placeBanner() {
    if (!faultBanner) return;
    bannerPlaced = performance.now();
    let y = 0;
    try {
      const vh = innerHeight || 900;
      for (const el of document.querySelectorAll('.w-bar')) {
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.height <= 0 || r.top > vh * 0.5) continue;
        if (r.bottom > y) y = r.bottom;
      }
      y = Math.min(y, vh * 0.5);
    } catch { y = 0; }
    faultBanner.style.top = Math.round(Math.max(0, y) + BANNER_GAP) + 'px';
  }

  function banner(text) {
    try {
      if (!faultBanner) {
        faultBanner = document.createElement('div');
        faultBanner.id = 'wallyFault';
        /* Inset and rounded rather than edge-to-edge: a floating strip
           reads as something the GAME is telling you, where a
           full-bleed bar welded to the top of the window reads as
           browser chrome — and once it is not at y=0 it has no edge to
           hang off anyway. */
        faultBanner.style.cssText = 'position:fixed;left:8px;right:8px;top:8px;z-index:99999;'
          + 'font:600 12px/1.45 ui-monospace,Menlo,Consolas,monospace;'
          + 'background:#3a0d12ee;color:#ffbcbc;border:1px solid #7c1d26;border-radius:6px;'
          + 'padding:6px 10px;pointer-events:none;white-space:pre-wrap;'
          + 'box-shadow:0 2px 10px rgba(0,0,0,.35);';
        document.body.appendChild(faultBanner);
      }
      faultBanner.textContent = text;
      placeBanner();
    } catch { /* no DOM is not a reason to stop the game */ }
  }

  function onFault(key, e) {
    let f = faults.get(key);
    if (!f) { f = { n: 0, off: false, logged: 0, at: 0, message: null }; faults.set(key, f); }
    f.n++;
    f.message = String(e?.message || e);
    health.errors++;
    health.sources[key] = f.n;
    health.last = { at: key, message: f.message, frame: ctx.frame, count: f.n };
    try { ctx.bus?.emit?.('frame:error', { at: key, error: e, count: f.n }); } catch { /* the bus is not allowed to make this worse */ }

    if (f.n >= FAULT_LIMIT && !f.off) {
      f.off = true;
      health.disabled.push(key);
      console.error(`[frame] ${key} has thrown ${f.n} times — DISABLED for the rest of the session. `
        + 'The rest of the game keeps running without it. Last error:', e);
      banner(`${key} disabled after ${f.n} errors — ${f.message}`);
      return f;
    }
    const now = performance.now();
    if (f.logged < FAULT_LOGS) {
      f.logged++; f.at = now;
      console.error(`[frame] ${key} threw (${f.n}/${FAULT_LIMIT}) — this frame is lost, the session is not:`, e);
    } else if (now - f.at > FAULT_QUIET) {
      f.at = now;
      console.error(`[frame] ${key} is still throwing — ${f.n} times so far: ${f.message}`);
    }
    return f;
  }

  function runHook(h, hook, name, dt, elapsed) {
    const fn = h && h[hook];
    if (typeof fn !== 'function') return;
    const key = name + '.' + hook;
    const f = faults.get(key);
    if (f && f.off) return;
    try { fn.call(h, dt, elapsed); }
    catch (e) { onFault(key, e); }
  }

  /* The renderer is the one hook that may not simply be switched off: a
     disabled render() is a black screen, which is worse than losing the
     post stack. So it degrades instead — once render.render has thrown
     its way to FAULT_LIMIT we fall through to the plain forward path,
     which has no composer in it to go wrong. */
  function draw() {
    const post = ctx.render?.render;
    if (typeof post === 'function' && !faults.get('render.render')?.off) {
      try { post.call(ctx.render); return; }
      catch (e) {
        const f = onFault('render.render', e);
        if (f.off) console.error('[frame] falling back to the plain forward render path.');
      }
    }
    try { renderer.render(scene, camera); }
    catch (e) { onFault('renderer.render', e); }
  }

  const perf = { fps: 0, ms: 0, frames: 0, acc: 0, calls: 0, tris: 0 };
  let last = performance.now();

  function frame(now) {
    /* RULE 1. The next frame is booked before anything can go wrong. */
    requestAnimationFrame(frame);
    /* RULE 2 lives inside step(); this is only the backstop for a throw
       in the loop's own arithmetic. */
    try { step(now); }
    catch (e) { onFault('main.frame', e); }
  }

  function step(now) {
    const raw = (now - last) / 1000;
    last = now;
    // Clamp dt so an alt-tab or a slow first frame can't launch Wally
    // into orbit; 1/20s is the longest step any integrator here sees.
    const dt = Math.min(raw, 0.05);

    ctx.dt = dt;
    ctx.elapsed += dt;
    ctx.frame++;
    health.frames = ctx.frame;

    /* Indexed, and the length is re-read every iteration: a module may
       add a handle mid-frame (streamed content does) and a cached
       length would either miss it or run off the end. */
    const hs = ctx._handles;
    for (let i = 0; i < hs.length; i++) runHook(hs[i], 'update', nameOf(hs[i], i), dt, ctx.elapsed);
    for (let i = 0; i < hs.length; i++) runHook(hs[i], 'lateUpdate', nameOf(hs[i], i), dt, ctx.elapsed);

    draw();

    /* Only while a fault banner is on screen, and only twice a second:
       one forced layout read every 500 ms during a state that already
       means something is broken is cheap, and it is what keeps the
       banner under a HUD that has since changed height. */
    if (faultBanner && now - bannerPlaced > 500) placeBanner();

    perf.acc += raw; perf.frames++;
    if (perf.acc >= 0.5) {
      perf.fps = Math.round(perf.frames / perf.acc);
      perf.ms = +(perf.acc / perf.frames * 1000).toFixed(2);
      perf.calls = renderer.info.render.calls;
      perf.tris = renderer.info.render.triangles;
      perf.acc = 0; perf.frames = 0;
      /* The error counters ride along with the perf block because that
         is the object every tool in tools/ already prints. */
      window.__WALLY_PERF__ = { ...perf, errors: health.errors, disabled: health.disabled.length };
      ctx.bus.emit('perf', perf);
    }
  }
  requestAnimationFrame(frame);

  /* ---- fault injection ----
     Throwing on purpose is the only way to prove the guards above are
     load-bearing rather than assumed; tools/audiotest.mjs PASS F drives
     these. The injected handle goes to the FRONT of the list by default,
     because the interesting assertion is that the handles AFTER it still
     get their frame. */
  window.WALLY.debug.health = () => ({
    ...health, disabled: health.disabled.slice(), sources: { ...health.sources },
    frame: ctx.frame, fps: perf.fps,
  });
  window.WALLY.debug.injectFault = (opts = {}) => {
    const {
      name = 'faultinjector', hook = 'update', times = Infinity,
      first = true, message = 'injected fault',
    } = opts;
    let left = times === true ? Infinity : Number(times);
    const h = { [hook]() { if (left-- > 0) throw new Error(message); } };
    hname.set(h, name);
    if (first) ctx._handles.unshift(h); else ctx._handles.push(h);
    injected.push(h);
    /* `left` is reported as a string: JSON turns Infinity into null,
       and a test that prints "times: null" reads like a bug. */
    return { name, hook, times: String(left), at: first ? 0 : ctx._handles.length - 1 };
  };
  window.WALLY.debug.clearFaults = () => {
    for (const h of injected) {
      const i = ctx._handles.indexOf(h);
      if (i >= 0) ctx._handles.splice(i, 1);
    }
    injected.length = 0;
    faults.clear();
    health.errors = 0; health.disabled.length = 0;
    health.sources = {}; health.last = null;
    try { faultBanner?.remove(); } catch {}
    faultBanner = null;
    return true;
  };

  /* ---- resize ---- */
  const onResize = () => {
    const w = innerWidth, h = innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    /* Same rule as the frame loop: one module's resize() may not stop
       the fifteen after it from being told the window changed. */
    for (let i = 0; i < ctx._handles.length; i++) {
      const hd = ctx._handles[i];
      if (!hd || typeof hd.resize !== 'function') continue;
      try { hd.resize(w, h); } catch (e) { onFault(nameOf(hd, i) + '.resize', e); }
    }
    /* After the HUD has been told, not before: the strip it sits under
       is a different height in the other orientation. */
    placeBanner();
  };
  addEventListener('resize', onResize);
  onResize();

  /* ================================================================
     THE START BEAT
     ----------------------------------------------------------------
     An AudioContext is created `suspended` and only a real user
     gesture may resume it. The opener therefore cannot simply roll:
     notes scheduled into a suspended context are never heard, so the
     score and the title sting play to nobody and the first thirty
     seconds of the game are silent. The fix is the oldest convention
     in the medium — one keystroke to start — which is also what the
     2D original did with PRESS START.

     Three paths, in order of preference:

       1. flags.shot / flags.skipIntro — how every tool in tools/
          boots. No prompt, no gesture, no intro, no waiting. Nothing
          here may ever block those.
       2. Audio already permitted (a returning player, a permissive
          browser) or missing altogether — no prompt either. Asking
          for a click the policy does not need is just a worse first
          frame.
       3. Otherwise, PRESS ANY KEY. On the gesture, in this order and
          inside the gesture's own task: name the cinematic score,
          resume the context, drop the boot screen, roll the opener.
          music.js only snaps tempo to a new score while the
          transport is stopped, so naming it first is what puts bar 0
          at 54 bpm — and the title beat lands on bar 7 at 31.11 s
          only because of that.

     Audio never gates the game. If the context refuses to resume, or
     Web Audio is missing entirely, the door opens anyway and WALLY
     RPG plays in silence.
     ================================================================ */
  const bootEl = document.getElementById('boot');
  const goEl = document.getElementById('bootGo');

  /* TOUCH DEVICES HAVE NO KEY TO PRESS. "Press any key" is meaningless on
     a phone, so the start chip and the intro's skip hint both say "tap"
     there instead. A coarse pointer ALONE is not the test — a laptop with
     a touchscreen has both, and its owner still has a keyboard — so this
     asks for a coarse pointer AND the absence of any fine one. Kept in
     sync with the same test in src/intro/titlecard.js. */
  const touchOnly = typeof matchMedia === 'function'
    && matchMedia('(pointer: coarse)').matches
    && !matchMedia('(any-pointer: fine)').matches;
  if (goEl) goEl.textContent = touchOnly ? 'Tap the screen to begin' : 'Press any key to begin';

  function reveal() {
    bootEl?.classList.remove('ask');
    bootEl?.classList.add('gone');
  }

  let opened = false;
  async function begin() {
    if (opened) return;
    opened = true;
    ctx.audio?.setContext?.('cinematic', { immediate: true, fade: 0.6 });
    /* Raced, never simply awaited. A blocked context's resume() can
       return a promise that never settles at all, and the one thing
       the start beat may not do is leave the player looking at the
       loading screen. Worst case the opener rolls a beat late and
       silent, which is still a game. */
    try {
      await Promise.race([
        Promise.resolve(ctx.audio?.resume?.()).catch(() => false),
        new Promise((r) => setTimeout(r, 1200)),
      ]);
    } catch { /* silence is allowed */ }
    reveal();
    ctx.intro?.play?.();
  }

  function ask() {
    /* The chip's wording is set ONCE, above, from `touchOnly`. This used to
       re-derive it here with a THIRD capability test — (hover: none) and
       (pointer: coarse) — and overwrite it with a shorter string. That was
       invisible in the headless rig, which auto-allows audio so ask() never
       runs; on a real phone the AudioContext is always suspended until a
       gesture, so ask() is the path that ALWAYS runs and its wording was the
       only one anyone ever saw. One test, one assignment, no second opinion. */
    bootEl?.classList.add('ask');
    /* THE FOURTH CALL SITE, and the one that proves the point. It is
       in main.js, not in the ui layer at all, and it is optional
       chained twice — so every audit that grepped src/ui for
       `.focus(` counted it as zero. Focus moves in src go through
       kbowner now precisely so the count cannot be wrong again. */
    kb.focus('boot.chip', goEl, { preventScroll: true });

    const go = (e) => {
      /* Leave the browser's own chords alone: reloading or opening
         dev tools must not be swallowed as the start beat. */
      if (e && e.type === 'keydown'
        && (e.key === 'F5' || e.key === 'F12' || e.metaKey || e.ctrlKey || e.altKey)) return;
      if (opened) return;
      removeEventListener('keydown', go, true);
      removeEventListener('pointerdown', go, true);
      removeEventListener('touchstart', go, true);
      begin();
    };
    addEventListener('keydown', go, { capture: true });
    addEventListener('pointerdown', go, { capture: true });
    addEventListener('touchstart', go, { capture: true, passive: true });
  }

  async function openTheDoor() {
    if (ctx.flags?.shot || ctx.flags?.skipIntro) { reveal(); opened = true; return; }

    const a = ctx.audio;
    let allowed = !a || !!a.unavailable || a.running === true;
    if (!allowed) {
      /* Outside a gesture, resume() either succeeds on a permitted
         origin or never settles at all. Race it rather than bet on
         which, and re-read the state afterwards. */
      allowed = await Promise.race([
        Promise.resolve(a.resume?.()).catch(() => false),
        new Promise((r) => setTimeout(() => r(false), 400)),
      ]).then(() => a.running === true).catch(() => false);
    }
    if (allowed) begin(); else ask();
  }

  /* ---- ready signal for tools/shot.mjs ----
     Wait two frames so the first render (and any lazily-compiled
     shaders) have actually landed before a screenshot is taken.
     __WALLY_READY__ is set here and NOT behind the start beat: a tool
     that boots without ?shot / ?skipIntro must still be able to see
     the page, and nothing in tools/ may ever hang on a keystroke. */
  requestAnimationFrame(() => requestAnimationFrame(() => {
    window.__WALLY_READY__ = true;
    ctx.bus.emit('ready');
    window.WALLY.debug.begin = () => { begin(); return true; };
    window.WALLY.debug.started = () => opened;
    /* Pose the loading screen for a screenshot. The harness is only
       allowed to look once boot has finished, by which point the
       screen is already gone, so there is otherwise no way to see it.
         bootScreen('load', 62)  the determinate bar, mid-boot
         bootScreen('ask')       the start beat */
    window.WALLY.debug.bootScreen = (mode = 'ask', pct = 62) => {
      if (!bootEl) return null;
      if (goEl && !goEl.textContent.trim()) goEl.textContent = 'Press any key to begin';
      bootEl.classList.remove('gone');
      bootEl.classList.toggle('ask', mode === 'ask');
      if (mode !== 'ask') { ctx.boot.label('city'); paint(pct / 100); }
      return mode;
    };
    openTheDoor();
  }));

  return ctx;
}

boot().catch(e => {
  console.error('[boot] fatal', e);
  const el = document.getElementById('bootStage') || document.getElementById('bootStatus');
  if (el) el.textContent = 'boot failed: ' + e.message;
  window.__WALLY_READY__ = true;   // let the harness capture the failure state
});
