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

  const status = document.getElementById('bootStatus');
  for (const [name, init] of STAGES) {
    if (status) status.textContent = name;
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
  }

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
  const el = document.getElementById('bootStatus');
  if (el) el.textContent = 'boot failed: ' + e.message;
  window.__WALLY_READY__ = true;   // let the harness capture the failure state
});
