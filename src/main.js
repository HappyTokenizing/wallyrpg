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
     1280x720. Boot is ~13 s and one stage is nearly two thirds of it:

       npc 63.5% · wally 17.3% · city 10.5% · world 4.7% · audio 1.7%
       render 1.0% · everything else under 0.5% each

     An evenly-weighted 16-stage bar would therefore sit frozen around
     50% for eight seconds, which is worse than no bar at all. Stages not
     listed here get MIN_W so they still nudge the bar visibly. */
  const STAGE_W = {
    render: 1.0, mat: 0.5, wind: 0.1, sky: 0.2, world: 4.7, city: 10.5,
    foliage: 0.3, water: 0.5, phys: 0.6, wally: 17.3, npc: 63.5,
    cam: 0.1, game: 0.2, ui: 0.4, audio: 1.7, intro: 0.5,
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

  /* ---- ready signal for tools/shot.mjs ----
     Wait two frames so the first render (and any lazily-compiled
     shaders) have actually landed before a screenshot is taken. */
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.getElementById('boot')?.classList.add('gone');
    window.__WALLY_READY__ = true;
    ctx.bus.emit('ready');
  }));

  return ctx;
}

boot().catch(e => {
  console.error('[boot] fatal', e);
  const el = document.getElementById('bootStage') || document.getElementById('bootStatus');
  if (el) el.textContent = 'boot failed: ' + e.message;
  window.__WALLY_READY__ = true;   // let the harness capture the failure state
});
