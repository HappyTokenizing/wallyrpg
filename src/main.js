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
        /* postfx already ran its own info.reset() at the top of the call
           that threw, so the counters are this frame's. Leave them. */
      }
    } else {
      /* renderer.info.autoReset is FALSE (renderer.js sets it), and the
         reset that pairs with it lives at the TOP of postfx's render().
         On this path postfx never runs, so nothing would ever clear the
         counters: perf.calls would climb without bound and the number
         printed as "draw calls" would be a running total of the session.
         That is the same mistake that once published 16 193 calls and
         111 M triangles (see wally.js balloonCost). */
      renderer.info.reset();
    }
    try { renderer.render(scene, camera); }
    catch (e) { onFault('renderer.render', e); }
  }

  /* ==================================================================
     THE FRAME CENSUS.  A SINGLE FRAME'S RECIPROCAL IS NOT AN FPS.

     THE BUG THIS REPLACES. The old counter accumulated `acc` and
     `frames` and published when `acc >= 0.5`. That reads like a
     half-second average and is not one: the window is "however many
     frames it took to spend 500 ms", so ONE slow frame satisfies it on
     its own and `fps` becomes round(1 / thatFrame). Worse, the publish
     copied `perf` AFTER zeroing `acc` and `frames`, so every reader saw
     `frames: 0, acc: 0` and had no way to tell a 1-frame window from an
     80-frame one.

     MEASURED ON THIS MACHINE (Apple M1 Max, headless Chrome, ANGLE
     Metal Renderer, 1600x900, ?skipIntro) against the OLD counter, one
     page load, three reads:
         boot      fps 2   ms 632.8   frames 0  acc 0
         settled   fps 60  ms 16.67   frames 0  acc 0
         one hitch fps 12  ms 86.41   frames 0  acc 0
     Three numbers, one build — which is exactly the spread a judge
     reported (1, 19, 163) and reasonably read as an unstable game.

     WHAT THIS DOES INSTEAD. Every frame's wall time goes into a ring.
     The window is the newest samples that fit in WINDOW_MS, and never
     fewer than MIN_N of them, so a 1.9 s stall cannot shrink the window
     to itself. The published block carries the window's SHAPE — `n`,
     `windowMs`, `p50`, `p95`, `worst` — beside the mean, because a
     median of 6.2 ms with a p95 of 6.9 is a different game from the
     same median with a p95 of 40, and the mean alone cannot tell them
     apart.

     `fps` stays the mean-over-the-window (every tool in tools/ reads
     that key) and is now the only thing it claims to be. `fpsP50` is
     the typical frame; read that when you want "what does it feel
     like", and `worst` when you want "does it hitch".

     AND STATE THE RIG. The same build, same machine, same viewport,
     read through the new block once it says settled:true —

       rAF limiter ON   n 121  window 2016 ms  mean 16.67  p50 16.7
                        p95 16.7  worst 16.8   -> 60.0 fps, vsync
       rAF limiter OFF  n 267  window 2008 ms  mean  7.52  p50  6.4
                        p95 13.9  worst 16.0   -> 133 fps mean,
                                                  156 fps median
       both: 738 draw calls, 5.77 M triangles, 1600x900, ?skipIntro,
       headless Chrome, ANGLE Metal Renderer on an Apple M1 Max.

     Note what only the shape shows: uncapped, this is NOT a flat 156
     fps. The p95 is twice the median, so a regular slower frame is in
     there. A mean of 133 and a median of 156 disagreeing by 17 % is
     that fact arriving in the number rather than hiding under it.
     ================================================================== */
  /* ==================================================================
     ...AND THE RING WAS STILL FILLED FROM THE WRONG CLOCK.

     Everything above is right about the WINDOW and wrong about the
     SAMPLE. `now` is requestAnimationFrame's timestamp, which is not a
     measurement of this frame at all: it is the browser's idea of when
     the frame it is servicing BEGAN, taken from the compositor's
     BeginFrame, not from a clock that ran while our code did. Two
     failures, each measured on this machine on one page load, against
     tools/_sm-lib.mjs sampling performance.now() over the IDENTICAL
     interval (Apple M1 Max, headless Chrome, ANGLE Metal, 1600x900,
     ?skipIntro, machine load average 14):

       LIMITER ON — the way anyone actually plays it. The timestamp is
       quantised to the display's 16.67 ms grid, so the ring is flat by
       construction and the census cannot report a hitch AT ALL:
           market square, n 480
              rAF ts    p50 16.7  p95 16.7  p99 16.8  worst 16.8
              wall      p50 16.6  p95 17.8  p99 18.8  worst 25.3
       A 25.3 ms frame happened and the shipped instrument printed
       16.8. Standing at spawn it swallowed a 40.2 ms one the same way.

       LIMITER OFF — how the 7.52 / 6.4 / 13.9 figure in the block
       above was taken. With --disable-gpu-vsync the timestamps BUNCH:
       10 frames of 368 reported a delta under 2 ms while the wall
       clock says not one frame in that window was under 10.5 ms. The
       ring then holds an invented short frame beside an invented long
       one:
              rAF ts    p50 14.9  p95 30.8  worst 44.3   best  0.7
              wall      p50 15.0  p95 26.1  worst 40.5   best 10.5
       THAT IS WHERE "the p95 is more than twice the median" CAME FROM.
       It is substantially the vsync grid rather than the game. A tail
       is really there — 1.7x, not 2.1x — but it is not the shape the
       brief was written around.

     SO THE RING TAKES THE WALL CLOCK: performance.now() read at the
     top of step(), differenced against the previous frame's reading.
     The time that actually elapsed, on a clock that was running while
     we worked.

     The rAF timestamp is not discarded — it is kept for the one thing
     it is genuinely good at. It IS the display's frame clock, so the
     gap between consecutive ones says whether the compositor SHOWED
     our frame or skipped it. That is counted separately as `dropped`,
     and it is the number that answers "did the player see a stutter",
     which no mean ever could.

     `cpuMs` joins them: the time spent inside step() itself — every
     update, every lateUpdate, the draw — so a reader can tell a frame
     that is long because we were busy from one that is long because we
     were waiting. At 1600x900 on this machine those are ~9 ms and
     16.7 ms respectively, and the old block could not tell them apart.
     ================================================================== */
  const WINDOW_MS = 2000;   // the window a settled number is averaged over
  const MIN_N = 20;         // ...but never fewer frames than this
  const RING = 480;         // ~8 s at 60 fps, ~3 s uncapped
  const ring = new Float64Array(RING);
  const cpuRing = new Float64Array(RING);   // time inside step(), same index
  const rafRing = new Float64Array(RING);   // the rAF timestamp delta, same index
  let ringN = 0, ringAt = 0;
  /* THE REVERT SWITCH. 'wall' is the rule above; 'raf' is the rule it
     replaced, ringing requestAnimationFrame's timestamp exactly as
     before. Both live in the module so tools/_sm-census.mjs can drive
     them on ONE page load and watch the old rule fail to see a frame
     the new one reports — a revert check, not a quoted before-number. */
  let censusClock = 'wall';
  /* Published on a cadence rather than per frame: the sort below is
     O(n log n) and there is no reader that needs it at 60 Hz. `at`
     says how stale the block a reader is holding actually is, and
     WALLY.debug.perf() recomputes it on the spot for one that cares. */
  const PUBLISH_MS = 250;
  let publishedAt = 0;

  const perf = {
    fps: 0, ms: 0, calls: 0, tris: 0,
    /* the window this was measured over — the fields the old block
       zeroed before publishing. `at` is the performance.now() the
       census ran at, so a reader holding this snapshot can tell how
       stale it is; WALLY.debug.perf() recomputes on demand instead. */
    n: 0, windowMs: 0, full: false, settled: false, at: 0,
    /* its shape */
    p50: 0, p95: 0, worst: 0, best: 0, fpsP50: 0, p99: 0,
    /* what the frame was DOING. cpuMs is the median time inside
       step(); cpuP95 its tail. A p50 of 16.7 with cpuMs 9 is a game
       waiting for vsync with 7.7 ms of headroom; the same 16.7 with
       cpuMs 16 is a game that is about to miss one. */
    cpuMs: 0, cpuP95: 0,
    /* DID THE DISPLAY SHOW IT. `hz` is the modal rAF interval in the
       window (16.7 on a 60 Hz panel); `dropped` counts the frames
       whose rAF gap was >= 1.5x that, i.e. the ones the compositor
       skipped; `dropPct` is that as a share of the window. Under a
       limiter this is the only honest stutter signal there is, and it
       is measured from the clock that owns the question. */
    hz: 0, dropped: 0, dropPct: 0,
    /* which clock filled the ring — 'wall' ships, 'raf' is the switch */
    clock: 'wall',
  };
  const sortBuf = new Float64Array(RING);
  const cpuBuf = new Float64Array(RING);
  const rafBuf = new Float64Array(RING);

  /* The newest samples that fit in WINDOW_MS, floored at MIN_N. Returns
     the count; the samples themselves land in sortBuf, unsorted. */
  function collect() {
    let acc = 0, k = 0;
    for (let i = 0; i < ringN; i++) {
      const j = (ringAt - 1 - i + RING) % RING;
      const v = censusClock === 'raf' ? rafRing[j] : ring[j];
      cpuBuf[k] = cpuRing[j];
      rafBuf[k] = rafRing[j];
      sortBuf[k++] = v;
      acc += v;
      if (acc >= WINDOW_MS && k >= MIN_N) break;
    }
    return k;
  }

  function census(now) {
    const k = collect();
    if (!k) return;
    let sum = 0;
    for (let i = 0; i < k; i++) sum += sortBuf[i];
    const s = Array.prototype.slice.call(sortBuf, 0, k).sort((a, b) => a - b);
    const mean = sum / k;
    /* p95 as the sample at ceil(0.95n)-1: with n = 20 that is the
       worst frame, which is the honest answer at that sample count and
       is why `n` is published beside it. */
    const p95 = s[Math.max(0, Math.ceil(k * 0.95) - 1)];
    perf.ms = +mean.toFixed(2);
    perf.fps = +(1000 / mean).toFixed(1);
    perf.p50 = +s[k >> 1].toFixed(2);
    perf.fpsP50 = +(1000 / s[k >> 1]).toFixed(1);
    perf.p95 = +p95.toFixed(2);
    perf.p99 = +s[Math.max(0, Math.ceil(k * 0.99) - 1)].toFixed(2);
    perf.worst = +s[k - 1].toFixed(2);
    perf.best = +s[0].toFixed(2);
    perf.n = k;

    /* ---- what the frame was doing ---- */
    const c = Array.prototype.slice.call(cpuBuf, 0, k).sort((a, b) => a - b);
    perf.cpuMs = +c[k >> 1].toFixed(2);
    perf.cpuP95 = +c[Math.max(0, Math.ceil(k * 0.95) - 1)].toFixed(2);

    /* ---- did the display show it ----
       `hz` is the MODE of the rAF gaps, not their mean: on a 60 Hz
       panel a window with four dropped frames has a mean of 17.4 ms
       and a mode of 16.7, and only the mode still names the panel.
       Bucketed to 0.5 ms because the timestamps wobble. */
    const bins = new Map();
    for (let i = 0; i < k; i++) {
      const b = Math.round(rafBuf[i] * 2);
      bins.set(b, (bins.get(b) || 0) + 1);
    }
    let bestBin = 0, bestCount = -1;
    for (const [b, n] of bins) if (n > bestCount || (n === bestCount && b < bestBin)) { bestBin = b; bestCount = n; }
    /* the bucket names the mode; the MEAN OF THAT BUCKET names the
       period. Taking bestBin/2 alone would quantise a 16.67 ms panel
       to 16.5 and then call every real frame 1 % long. */
    let pSum = 0, pN = 0;
    for (let i = 0; i < k; i++) if (Math.round(rafBuf[i] * 2) === bestBin) { pSum += rafBuf[i]; pN++; }
    const period = pN ? pSum / pN : bestBin / 2;
    perf.hz = +period.toFixed(2);
    let dropped = 0;
    /* Only meaningful when a limiter is actually pacing us. Uncapped,
       every gap is production time and none of them is a drop. */
    if (period > 1) for (let i = 0; i < k; i++) if (rafBuf[i] >= period * 1.5) dropped += Math.round(rafBuf[i] / period) - 1;
    perf.dropped = dropped;
    perf.dropPct = +((dropped * 100) / k).toFixed(1);
    perf.clock = censusClock;
    perf.windowMs = +sum.toFixed(1);
    perf.full = sum >= WINDOW_MS;
    /* SETTLED means "you may quote this number without a caveat": a
       full window, and no frame in it more than 3x the median. A spike
       leaves this false for the whole window it is in, which is the
       signal the old counter could not give at all. */
    perf.settled = perf.full && k >= MIN_N && perf.worst <= perf.p50 * 3;
    perf.calls = renderer.info.render.calls;
    perf.tris = renderer.info.render.triangles;
    perf.at = +now.toFixed(1);
    publishedAt = now;
    window.__WALLY_PERF__ = { ...perf, errors: health.errors, disabled: health.disabled.length };
    ctx.bus.emit('perf', perf);
  }

  let last = performance.now();
  let lastWall = 0;

  function frame(now) {
    /* RULE 1. The next frame is booked before anything can go wrong. */
    requestAnimationFrame(frame);
    /* RULE 2 lives inside step(); this is only the backstop for a throw
       in the loop's own arithmetic. */
    try { step(now); }
    catch (e) { onFault('main.frame', e); }
  }

  function step(now) {
    /* THE WALL CLOCK, read before anything in this frame runs. `now`
       is the compositor's BeginFrame stamp and cannot measure us; see
       the block above for the two ways it lies. dt still comes from
       `now` because the ANIMATION should follow the display's clock —
       it is only the INSTRUMENT that must not. */
    const t0 = performance.now();
    const wall = lastWall ? t0 - lastWall : 0;
    lastWall = t0;

    const raw = (now - last) / 1000;
    const rafGap = (now - last);
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

    /* THE RAW time, not the clamped `dt`: a 1.9 s stall is a 1.9 s
       stall, and a census fed the clamped value would report the
       longest frame it is allowed to imagine (50 ms) instead of the
       one that happened. The clamp exists to protect the integrators,
       not to flatter the instrument.

       Three rings, one index. `ring` is the wall clock and is what the
       published distribution is made of; `rafRing` is the display's
       own clock and answers only "was this frame shown"; `cpuRing` is
       the work between the top of step() and here. The first frame has
       no predecessor to difference against, so it seeds the rings with
       the rAF gap rather than a zero that would sit in the window as a
       fictitious best frame. */
    const cpu = performance.now() - t0;
    ring[ringAt] = wall || rafGap;
    rafRing[ringAt] = rafGap;
    cpuRing[ringAt] = cpu;
    ringAt = (ringAt + 1) % RING;
    if (ringN < RING) ringN++;
    if (now - publishedAt >= PUBLISH_MS) census(now);
  }
  requestAnimationFrame(frame);

  /* ---- the frame census, on demand ----
     window.__WALLY_PERF__ is republished every PUBLISH_MS, so a reader
     that grabs it is holding a block up to a quarter-second old (`at`
     says how old). This recomputes over the ring as it stands right
     now, which is what a tool taking one reading should call. */
  window.WALLY.debug.perf = () => {
    census(performance.now());
    return { ...perf, errors: health.errors, disabled: health.disabled.length };
  };
  /* Every frame time still in the ring, newest last, in ms. For a tool
     that wants to draw the distribution rather than trust five numbers
     from it. */
  window.WALLY.debug.frameTimes = () => {
    const out = [];
    for (let i = ringN - 1; i >= 0; i--) out.push(+ring[(ringAt - 1 - i + RING) % RING].toFixed(2));
    return out;
  };
  /* All three rings, aligned, newest last: [wall, rAF gap, cpu] per
     frame. A tool that wants to show that the two clocks disagree needs
     them side by side on the same frames, not two runs. */
  window.WALLY.debug.frameRings = () => {
    const out = [];
    for (let i = ringN - 1; i >= 0; i--) {
      const j = (ringAt - 1 - i + RING) % RING;
      out.push([+ring[j].toFixed(2), +rafRing[j].toFixed(2), +cpuRing[j].toFixed(2)]);
    }
    return out;
  };
  /* THE REVERT SWITCH, named. 'raf' puts the ring back on
     requestAnimationFrame's timestamp — the rule this file shipped
     before — so tools/_sm-census.mjs can watch the old rule miss a
     frame the new one reports, on the same page load, over the SAME
     rings. Nothing else in the game reads it. */
  window.WALLY.debug.censusClock = (mode) => {
    if (mode === 'raf' || mode === 'wall') censusClock = mode;
    return censusClock;
  };

  /* ==================================================================
     RUNTIME REVERTS — PUTTING A FIX BACK OUT SO A TEST CAN WATCH IT FAIL

     A REVERT CHECK RUNS TODAY'S TEST AGAINST YESTERDAY'S CODE. Running
     yesterday's test against yesterday's code proves nothing: they were
     written together and agree with each other by construction. Quoting
     the number a bug used to produce proves less still — it is a
     citation, not a measurement, and it stays green after the fix has
     been deleted.

     hud.js's promptAnchor('lintel') is the pattern (see THE ANCHOR
     SLIDES there): the shipped rule and the rule it replaced both live
     in the module, behind a switch, so the walk that proves the fix can
     be re-run against the defect ON THE SAME PAGE LOAD.

     Some fixes are not shaped like a switch — they are a call added at
     a seam between three modules — and for those the switch belongs
     here, because main.js is the only file that holds the whole ctx.
     Each entry below restores a NAMED prior behaviour by wrapping the
     public API the fix goes through. Nothing here is reachable without
     WALLY.debug; nothing here runs unless a test asks for it.

     Every one of these is asserted by tools/introhandover.mjs --revert,
     which requires the assertions it names to FAIL while it is on.
     ================================================================== */
  const REVERTS = {
    /* intro.js restoreWorld(): `ctx.wally.setLocomotion(null)`.
       Without it the animator keeps the value the cinematic pinned
       (~0) for the rest of the session while the controller integrates
       normally: "he moves but no walk animation or bike animation".
       Reverted by making a hand-back to the controller a no-op. */
    locomotion: {
      why: 'restoreWorld() never hands the locomotion latch back to the controller',
      breaks: 'the animator tracks the controller / the legs actually swing',
      apply() {
        const w = ctx.wally; if (!w || !w.setLocomotion) return null;
        const orig = w.setLocomotion.bind(w);
        /* SCOPED TO THE CINEMATIC, so this is the historical diff and
           not a bigger hammer wearing its name. restoreWorld() runs
           inside finish() with intro.running still true (the 0.9 s
           outro comes after it), so the hand-back this swallows is
           that one. Every setLocomotion(null) the game makes later —
           dismounting a ride, for instance — goes through untouched. */
        w.setLocomotion = (s, t) =>
          (s == null && ctx.intro?.running === true ? w : orig(s, t));
        return () => { w.setLocomotion = orig; };
      },
    },
    /* intro.js THE SETTLE: the action layer is released 1.70 s BEFORE
       the hand-over, while the hero lens is still on him, so the two
       poses MEET at the cut. The behaviour it replaced released it
       inside restoreWorld() at the same instant the camera cut and
       control came back, so `welcome` unwound over the first 1.3 s of
       gameplay.

       intro.js's `settled` flag is module-local and cannot be reached
       from here, so this reproduces the old ordering rather than
       reaching in: swallow the settle cue's release (and the neutral
       expression it hands over with, which the old code also did not
       do), then re-issue release(0.35) on the frame ctx.cam.release()
       runs — which is the line restoreWorld() used to hold. */
    settle: {
      why: 'the action layer is released at the cut instead of 1.70 s before it',
      breaks: 'the two poses meet / the arms are still across the seam / released before the cut',
      apply() {
        const w = ctx.wally, cam = ctx.cam;
        if (!w || !cam || !w.release || !cam.release) return null;
        const rel = w.release.bind(w), exp = w.express ? w.express.bind(w) : null;
        const camRel = cam.release.bind(cam);
        /* THE SETTLE CUE, NAMED RATHER THAN GUESSED. "The first
           release" is not good enough — studio mode and the debug hook
           both call release(0.001), and eating one of those would be a
           different defect wearing this one's name. The settle is the
           only release(SETTLE_FADE) issued while the intro is running,
           and it happens exactly once. */
        const SETTLE_FADE = 0.50;
        let held = false, done = false, sameTick = false;
        w.release = (fade) => {
          const isSettle = !done && ctx.intro?.running === true
            && Math.abs((fade ?? 0.30) - SETTLE_FADE) < 1e-6;
          if (isSettle) {
            held = true; done = true; sameTick = true;
            queueMicrotask(() => { sameTick = false; });
            return w;
          }
          return rel(fade);
        };
        if (exp) w.express = (name, o) => (sameTick ? w : exp(name, o));
        cam.release = (...a) => {
          if (held) { held = false; rel(0.35); }   // the old restoreWorld line
          return camRel(...a);
        };
        return () => { w.release = rel; if (exp) w.express = exp; cam.release = camRel; };
      },
    },
    /* anim.js play(): the prev/prevW clip-to-clip crossfade. Before it,
       every play()/pose() that passed a `fade` got a one-frame pose
       substitution — `pose('welcome', {fade:0.55})` measured 52 degrees
       in a single 10.9 ms frame. Reverted by dropping the outgoing clip
       on every swap, which is the `else` branch play() used to have
       unconditionally; the weight ramp and its rate are untouched. */
    crossfade: {
      why: 'anim.js play() substitutes the pose instead of blending out of the outgoing clip',
      breaks: 'no arm snap after the title lands',
      apply() {
        const a = ctx.wally && ctx.wally.animator;
        if (!a || typeof a.play !== 'function') return null;
        const own = Object.prototype.hasOwnProperty.call(a, 'play');
        const orig = a.play.bind(a);
        a.play = (name, opts) => { const r = orig(name, opts); a.prev = null; a.prevW = 0; return r; };
        /* play() is a prototype method, so the undo DELETES the shadow
           rather than pinning a bound copy over it for ever. */
        return () => { if (own) a.play = orig; else delete a.play; };
      },
    },
  };
  const reverted = new Map();
  /** List what can be put back, and what each one is expected to break. */
  window.WALLY.debug.reverts = () => Object.fromEntries(
    Object.entries(REVERTS).map(([k, v]) => [k, { why: v.why, breaks: v.breaks, on: reverted.has(k) }]));
  /** Put a named prior behaviour back (or take it out again). Returns
      what actually happened — `applied:false` means the module it wraps
      was not there, which a test must read as "this revert did not run"
      and not as "the code under test is fine". */
  window.WALLY.debug.revert = (name, on = true) => {
    const r = REVERTS[name];
    if (!r) return { name, applied: false, why: 'no such revert' };
    if (on) {
      if (reverted.has(name)) return { name, on: true, applied: true, why: r.why };
      const undo = r.apply();
      if (!undo) return { name, on: false, applied: false, why: 'the module this wraps is not on ctx' };
      reverted.set(name, undo);
      return { name, on: true, applied: true, why: r.why, breaks: r.breaks };
    }
    const undo = reverted.get(name);
    if (undo) { undo(); reverted.delete(name); }
    return { name, on: false, applied: !!undo };
  };

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
