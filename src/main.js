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

  /* ---- frame loop ---- */
  const perf = { fps: 0, ms: 0, frames: 0, acc: 0, calls: 0, tris: 0 };
  let last = performance.now();

  function frame(now) {
    const raw = (now - last) / 1000;
    last = now;
    // Clamp dt so an alt-tab or a slow first frame can't launch Wally
    // into orbit; 1/20s is the longest step any integrator here sees.
    const dt = Math.min(raw, 0.05);

    ctx.dt = dt;
    ctx.elapsed += dt;
    ctx.frame++;

    for (const h of ctx._handles) if (h.update) h.update(dt, ctx.elapsed);
    for (const h of ctx._handles) if (h.lateUpdate) h.lateUpdate(dt, ctx.elapsed);

    if (ctx.render?.render) ctx.render.render();
    else renderer.render(scene, camera);

    perf.acc += raw; perf.frames++;
    if (perf.acc >= 0.5) {
      perf.fps = Math.round(perf.frames / perf.acc);
      perf.ms = +(perf.acc / perf.frames * 1000).toFixed(2);
      perf.calls = renderer.info.render.calls;
      perf.tris = renderer.info.render.triangles;
      perf.acc = 0; perf.frames = 0;
      window.__WALLY_PERF__ = { ...perf };
      ctx.bus.emit('perf', perf);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /* ---- resize ---- */
  const onResize = () => {
    const w = innerWidth, h = innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    for (const hd of ctx._handles) if (hd.resize) hd.resize(w, h);
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
    goEl?.focus?.({ preventScroll: true });

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
