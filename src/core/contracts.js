/* ============================================================
   contracts.js — the shared spine of WALLY RPG.

   READ THIS BEFORE WRITING ANY MODULE.

   Every subsystem in this game is a module that exports exactly one
   function:

       export async function init(ctx) { ...; return handle; }

   `ctx` is the single shared context object created here. A subsystem
   may READ anything on ctx, but may only WRITE to the namespace it
   owns (declared in OWNERSHIP below). This is what lets many agents
   build in parallel without colliding.

   The returned `handle` may implement any of:

       update(dt, elapsed)   called every frame, before render
       lateUpdate(dt)        called after update, before render (camera, IK)
       resize(w, h)          called on viewport change
       dispose()             called on teardown

   Nothing else is required. A subsystem that returns nothing is legal.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';

/* ------------------------------------------------------------
   OWNERSHIP — which module may write which ctx namespace.
   ------------------------------------------------------------
   ctx.render     render/*        renderer, composer, passes, quality
   ctx.mat        render/toon.js  material factories
   ctx.wind       core/wind.js    global wind uniforms
   ctx.sky        world/sky.js    sky, sun, lighting rig, time of day
   ctx.world      world/*         terrain, city, props, foliage
   ctx.water      world/water.js  ocean + ripples
   ctx.wally      character/*     the player character + rig + anim
   ctx.phys       physics/*       collision world, controller
   ctx.cam        core/camera.js  camera rig
   ctx.game       game/*          state, economy, quests, save
   ctx.ui         ui/*            hud, phone, dialogue
   ctx.intro      intro/*         the opening cinematic
   ctx.audio      audio/*         music + sfx
   ------------------------------------------------------------ */

/* Tiny synchronous event bus. Subsystems talk through this, never by
   importing each other. `on` returns an unsubscribe function. */
export function createBus() {
  const map = new Map();
  return {
    on(type, fn) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
      return () => map.get(type)?.delete(fn);
    },
    once(type, fn) {
      const off = this.on(type, (...a) => { off(); fn(...a); });
      return off;
    },
    emit(type, payload) {
      const s = map.get(type);
      if (!s) return;
      for (const fn of [...s]) {
        try { fn(payload); }
        catch (e) { console.error(`[bus] ${type} handler threw:`, e); }
      }
    },
    clear() { map.clear(); },
  };
}

/* ============================================================
   QUALITY TIERS.

   A TIER IS A PROMISE ABOUT A FRAME TIME, NOT A WISH LIST. The table
   this replaces made no such promise and could not have kept one:
   measured in the Main Street fly-to at 1600x900 on an M1 Max — the
   heaviest scene in the game — it ran

     low    120 fps      (8.3 ms)   twice its target, and looked it
     med     70 fps     (14.2 ms)
     high    48 fps     (20.7 ms)   <- the DEFAULT for a good GPU
     ultra   46 fps     (21.9 ms)   <- what pickQuality actually chose

   and on a Retina panel, where devicePixelRatio is 2, high and ultra
   asked for `min(devicePixelRatio, 2)` and rendered 5.8 megapixels
   instead of 1.4: measured, 31 fps. So the tier the probe handed this
   machine missed 60 fps by a factor of two, and the tier below it
   missed by 25 %, while the bottom tier had 100 % of headroom it was
   not spending on anything.

   WHAT THE FRAME IS ACTUALLY MADE OF, measured at high, 1600x900,
   pixelRatio 1, by alternating the streamed foliage on and off six
   times inside one process:

     whole frame                20.4 ms
     everything except grass    15.0 ms
     the grass field             5.4 ms

   Three conclusions drive every number below.

   1. pixelRatio > 1 is the single most expensive line in the table
      and it buys the least: SMAA already resolves the edges. Every
      tier now renders at 1:1. That alone is 51 fps against 37 on this
      machine.
   2. A shadow cascade is a second traversal of a 1500-call scene.
      Dropping high from three to two, and its bloom chain from five
      mips to four, is 2.2 ms — more than a third of the whole grass
      field — for a difference that lives in the far half of the
      shadow map.
   3. Grass is bought by DISTANCE, not by density. Thinning the
      carpet is what two blind reviews called "acid shards"; the
      near field is the whole read. So the ladder moves grassDist
      48 / 70 / 92 / 110 and keeps density high everywhere, and low
      gets MORE grass than it used to have, not less, because it was
      the tier with a hundred per cent of headroom and the sparsest
      field in the game.

   Every expensive feature still checks ctx.quality before switching
   itself on. Tier is chosen at boot from a GPU probe and may be
   forced with ?quality=low|med|high|ultra.
   ============================================================ */
/* bloomMips IS A SAFETY NUMBER AS WELL AS A LOOKS NUMBER, AND 3 IS A
   FLOOR. A non-finite texel that reaches the scene buffer is smeared
   by the bloom pyramid into a solid black block roughly 2^(mips+1) px
   on a side — MEASURED cold-boot per tier: 94x106 at 3, 206x218 at 4,
   428x432 at 5. tools/blacksquares.mjs is what catches that block, and
   its floor is a measured 36x36. At 2 mips the block MEASURES 38x42
   (area 1554) — 1.1x that floor, and under both of its solid-pass side
   floors, so one of its two detectors goes blind and the gate is down
   to detector 1b alone. Do not lower any bloomMips below 3 to buy
   frames: postfx.js clamps at 3 and blacksquares FAILS the gate on a
   tier that asks for less. Drop `bloom: false` instead — a tier with
   no pyramid cannot make the block at all. */
export const QUALITY_TIERS = {
  /* Integrated graphics and phones. Measured 120 fps here, which is
     the point: this tier has to hold 60 on a machine three to four
     times slower than the one it was measured on. */
  low: {
    name: 'low',
    pixelRatio: 1,
    shadowCascades: 1, shadowSize: 1024, shadowSoft: false,
    ssao: false, bloom: true, bloomMips: 3, dof: false,
    outline: true, grain: true, grass: 0.90, grassDist: 46,
    waterReflect: false, particles: 0.3, anisotropy: 2, msaa: 0,
  },
  /* Older discrete parts. DOF comes off here rather than at high:
     it is a full-screen pass, and a tier for a weak GPU should spend
     its budget on the things that are in focus. */
  med: {
    name: 'med',
    pixelRatio: 1,
    shadowCascades: 2, shadowSize: 1280, shadowSoft: true,
    ssao: true, bloom: true, bloomMips: 4, dof: false,
    outline: true, grain: true, grass: 1.15, grassDist: 58,
    waterReflect: false, particles: 0.6, anisotropy: 4, msaa: 0,
  },
  /* THE DEFAULT, AND THE ONE THAT HAS TO HOLD 60 AT 1600x900 IN THE
     CITY. Everything here was moved for a measured millisecond:
     pixelRatio 2 -> 1, a third shadow cascade and a fifth bloom mip
     gone, and the grass ring pulled from 110 m to 88 while its
     density stays near full so the near field is untouched. */
  high: {
    name: 'high',
    pixelRatio: 1,
    shadowCascades: 2, shadowSize: 1792, shadowSoft: true,
    ssao: true, bloom: true, bloomMips: 4, dof: true,
    outline: true, grain: true, grass: 1.35, grassDist: 68,
    waterReflect: true, particles: 1.0, anisotropy: 8, msaa: 0,
  },
  /* OPT-IN ONLY — see pickQuality. Nothing this project has been
     measured on holds 60 fps here, so nothing is handed it
     automatically. It is what you switch on for a screenshot, or on
     hardware faster than anything tested. */
  ultra: {
    name: 'ultra',
    pixelRatio: 1,
    shadowCascades: 3, shadowSize: 2048, shadowSoft: true,
    ssao: true, bloom: true, bloomMips: 5, dof: true,
    outline: true, grain: true, grass: 1.40, grassDist: 110,
    waterReflect: true, particles: 1.4, anisotropy: 16, msaa: 0,
  },
};

/* Probe the GPU and pick a starting tier.

   THIS USED TO HAND AN M1 MAX 'ultra', WHICH MEASURED 46 fps. A probe
   that names a tier the hardware cannot run is worse than no probe:
   the player never sees the frame rate the game was designed at and
   has no reason to suspect a setting is responsible. The fast-GPU
   branch now returns 'high' — retuned above until it genuinely held
   60 fps in the heaviest scene — and 'ultra' is reachable only
   through ?quality=ultra.

   Headless SwiftShader reports as a software renderer and gets 'med':
   the old code gave it 'high' for "correct visuals", but every visual
   law in ART_DIRECTION is a colour and a shape law, not a shadow
   cascade count, and a screenshot that takes four seconds a frame to
   capture is its own kind of wrong. */
export function pickQuality(renderer) {
  const forced = new URLSearchParams(location.search).get('quality');
  if (forced && QUALITY_TIERS[forced]) return { ...QUALITY_TIERS[forced] };

  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const name = (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '') || '';
  const soft = /swiftshader|llvmpipe|software|webkit webgl/i.test(name);

  if (soft) return { ...QUALITY_TIERS.med, name: 'med(sw)' };
  if (/apple m[1-9]|radeon pro|geforce rtx|geforce gtx 1[6-9]|rtx/i.test(name)) {
    return { ...QUALITY_TIERS.high };
  }
  if (/intel|uhd|iris/i.test(name)) return { ...QUALITY_TIERS.low };
  return { ...QUALITY_TIERS.med };
}

/* The context. Created once in main.js and threaded through every init. */
export function createContext({ canvas, renderer, scene, camera }) {
  const params = new URLSearchParams(location.search);

  const ctx = {
    THREE,
    canvas, renderer, scene, camera,

    bus: createBus(),
    clock: new THREE.Clock(),
    quality: pickQuality(renderer),

    /* Set by main.js each frame. Read-only for subsystems. */
    dt: 0,
    elapsed: 0,
    frame: 0,

    /* Boot flags from the query string. */
    flags: {
      shot: params.has('shot'),            // headless screenshot run
      scene: params.get('scene') || null,  // jump straight to a scene
      skipIntro: params.has('skipIntro') || params.has('shot'),
      debug: params.has('debug'),
      pose: params.get('pose') || null,
      hour: params.has('hour') ? +params.get('hour') : null,
    },

    /* Namespaces — each filled by its owning module (see OWNERSHIP). */
    render: null, mat: null, wind: null, sky: null,
    world: null, water: null, wally: null, phys: null,
    cam: null, game: null, ui: null, intro: null, audio: null,

    /* Subsystems that want a frame callback are collected here by main. */
    _handles: [],
  };

  /* Deterministic RNG so the world generates identically every run —
     screenshots must be comparable between builds. */
  ctx.rng = mulberry32(0x5eed1e);
  ctx.makeRng = (seed) => mulberry32(typeof seed === 'string' ? hashStr(seed) : seed);

  return ctx;
}

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* Small maths helpers everyone needs. Import from here, don't re-declare. */
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (v - a) / (b - a);
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/* Frame-rate independent exponential smoothing. Use this instead of
   `a = lerp(a, b, 0.1)` — that one is a physics bug at variable dt. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

/* Critically damped spring — the camera, ears and trunk all use this.
   Returns [newValue, newVelocity]. */
export function spring(value, velocity, target, stiffness, damping, dt) {
  const f = (target - value) * stiffness - velocity * damping;
  const v = velocity + f * dt;
  return [value + v * dt, v];
}
