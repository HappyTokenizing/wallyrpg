/* ============================================================
   physics.js — ctx.phys. The simulation spine.

   Owns: a static collision world (triangle soup + AABB proxies), the
   character controller, the spring-chain solver, verlet cloth and
   buoyant bodies. No rendering, no geometry, no materials.

   FIXED TIMESTEP. Everything here is integrated at exactly 60 Hz with
   an accumulator, and every output a renderer reads is INTERPOLATED
   toward the render time. Variable-dt integration visibly jitters — a
   capsule resolving against a stair edge at 143 fps and again at 61 fps
   lands in different places, and ears solved at a variable dt change
   their damping ratio every frame. Neither is acceptable.

     ctx.phys.step(dt)      feeds the accumulator, runs 0..n fixed steps,
                            then interpolates. main.js does this for you
                            via update().
     ctx.phys.fixedDt       1/60
     ctx.phys.alpha         0..1 interpolation remainder

   PHASING inside a frame (main.js runs all update(), then all lateUpdate()):

     phys.update        accumulator; controllers, cloth and buoyancy step
                        here, so ctx.wally reads a settled position in ITS
                        update
     wally.update       poses the skeleton from that position
     phys.lateUpdate    spring chains step here — they hang off bones whose
                        world matrices only exist once the rig has posed —
                        then write their quaternions, and cloth geometry
                        is synced
     cam.lateUpdate     follows the interpolated capsule

   Chains still run at the fixed dt: update() records how many fixed steps
   it took and lateUpdate() runs exactly that many, then interpolates.

   THE FALLBACK PLANE. Until world.js registers geometry the collision
   world behaves as an infinite plane at y = 0, so groundAt(), raycast()
   and the controller all work standalone. The moment any static is
   registered the plane switches itself off. Pin it with setGroundPlane(y),
   kill it with setGroundPlane(null), restore with setGroundPlane('auto').

   ------------------------------------------------------------
   PUBLIC API — other modules code against exactly this.
   ------------------------------------------------------------
   World
     addStatic(mesh|group|geometry|box3, opts) -> id | id[]  bakes world matrices
     addAABB(box3, opts)                       -> id         12-tri proxy, cheap
     addTriangles(positions, indices, opts)    -> id
     remove(id | id[])                         -> bool
     clearStatics()
     setGroundPlane(y | null | 'auto')
     raycast(origin, dir, maxDist)  -> {point, normal, distance, tri, body, plane} | null
     groundAt(x, z, out?)           -> {y, normal, hit, plane, distance, body}
     heightAt(x, z)                 -> number
     capsuleCast(a, b, r, out?)     -> contacts[]

   Bodies
     createController(opts) -> CharacterController   (see CONTROLLER_DEFAULTS)
     createChain(opts)      -> SpringChain           (see CHAIN_DEFAULTS / CHAIN_PRESETS)
     createCloth(opts)      -> Cloth                 (see CLOTH_DEFAULTS)
     createBuoy(opts)       -> BuoyantBody           (see BUOY_DEFAULTS)
     createSpring(opts)     -> Spring1   scalar damped spring
     createSpringVec3(opts) -> Spring3   vector damped spring
     createSquash(opts)     -> SquashSpring
     Every body has .dispose(); phys drops disposed bodies on the next step.

   Wiring
     player                 the controller ctx.wally drives (first one made)
     setWaterLevel(fn|number|null)
     windAt(x, z, phase)    the shared wind as a world vector
     world                  the raw CollisionWorld if you need to go deeper
     stats                  {triangles, controllers, chains, cloths, buoys, steps}

   Bus events emitted
     'phys:land'    {position, impact, speed, normal, body}
     'phys:jump'    {position, speed}
     'phys:step'    {position, speed, normal, running}
     'water:splash' {x, y, z, radius, strength}
     'water:ripple' {x, y, z, radius, strength}

   Bus events consumed
     'world:collision'  an Object3D / Box3 / array of them to register
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { clamp } from '../core/contracts.js';

import { CollisionWorld } from './collision.js';
import { CharacterController, CONTROLLER_DEFAULTS } from './controller.js';
import {
  SpringChain, Spring1, Spring3, SquashSpring,
  CHAIN_DEFAULTS, CHAIN_PRESETS,
} from './springs.js';
import { Cloth, CLOTH_DEFAULTS } from './verlet.js';
import { BuoyantBody, BUOY_DEFAULTS } from './buoyancy.js';

export const FIXED_HZ = 60;
export const FIXED_DT = 1 / FIXED_HZ;
const MAX_STEPS_PER_FRAME = 5;      // 83 ms of catch-up, then we drop time

const _wv = new THREE.Vector3();
const _imp = new THREE.Vector3();
const _zero = Object.freeze({ x: 0, y: 0, z: 0 });

export async function init(ctx = {}) {
  const world = new CollisionWorld({
    cellSize: ctx.physCellSize ?? 2.0,
    groundPlane: 'auto',
    groundPlaneY: 0,
  });

  const controllers = [];
  const chains = [];
  const cloths = [];
  const buoys = [];

  let acc = 0;
  let alpha = 0;
  let steps = 0;
  let simTime = 0;

  /* ---------------------------------------------------------------
     Wind bridge. Everything secondary reads the SAME field the shaders
     do (ART_DIRECTION §2.3), so when it gusts the ears, the flags and
     the grass gust together.

     ctx.wind.vector() gives the world XZ push; ctx.wind.sample() gives a
     phased scalar so two ears — or the two ends of a flag — are never in
     lockstep. A small +Y term is added because a real gust lifts a thin
     membrane rather than only shoving it sideways.
     --------------------------------------------------------------- */
  function windAt(x, z, phase = 0) {
    const W = ctx.wind;
    if (!W) return _zero;
    if (W.vector) W.vector(x, z, _wv); else _wv.set(0, 0, 0);
    if (W.sample) {
      const s = W.sample(x, z, phase);
      const d = W.uniforms?.uWindDir?.value;
      if (d) { _wv.x += d.x * s * 0.45; _wv.z += d.y * s * 0.45; }
      _wv.y += s * 0.16;
    }
    return _wv;
  }

  /* ---------------------------------------------------------------
     Water bridge. water.js boots AFTER phys in the stage order, so its
     height function is resolved lazily and cached once it exists.
     --------------------------------------------------------------- */
  let waterFn = null;
  let waterOverride;                     // undefined = auto-detect
  function waterLevelAt(x, z) {
    if (waterOverride !== undefined) {
      if (waterOverride === null) return -Infinity;
      return typeof waterOverride === 'function' ? waterOverride(x, z) : waterOverride;
    }
    if (!waterFn) {
      const w = ctx.water;
      if (!w) return -Infinity;
      const f = w.heightAt || w.levelAt || w.surfaceAt || w.waveHeight;
      if (typeof f === 'function') waterFn = (px, pz) => f.call(w, px, pz);
      else if (typeof w.level === 'number') waterFn = () => w.level;
      else return -Infinity;
    }
    return waterFn(x, z);
  }

  const bus = ctx.bus ?? { emit() {}, on() { return () => {}; } };

  /* ---------------------------------------------------------------
     CLOTH LEVEL OF DETAIL.

     The city hangs fifty-odd awnings, banners and washing lines over a
     970 m island, and the solver is the single most expensive thing in
     the frame: iterations x constraints x cloths x fixed steps. At the
     far end of the island a 1.5 m flag is four pixels across, and it was
     being solved to exactly the same tolerance as the one over Wally's
     head. Distance buys the pass counts down and, past 160 m, runs the
     sheet on one fixed step in four.

     What it deliberately does NOT do is stretch the timestep. Verlet's
     stability is dt^2 and a cloth handed a variable dt gains energy, so
     a distant flag animates SLOWER, never wronger, and nothing can
     explode when the camera turns.

     `scale` multiplies both the full iterations and the structural-only
     passes; the floor of 1 keeps every sheet rigid enough not to visibly
     stretch. Hysteresis: a tier is only left after the distance crosses
     the next threshold by 15%, so a flag on a boundary cannot flicker.
     No camera (the headless tests) => tier 0 => authored quality.
     --------------------------------------------------------------- */
  const CLOTH_LOD = [
    { d: 35, scale: 1, skip: 1 },
    { d: 80, scale: 0.5, skip: 1 },
    { d: 160, scale: 0.28, skip: 2 },
    { d: Infinity, scale: 0.18, skip: 4 },
  ];
  let lodPhase = 0;
  function applyClothLod(c, tier) {
    if (c._lodTier === tier) return;
    c._lodTier = tier;
    const L = CLOTH_LOD[tier];
    if (L.scale >= 1) c.setLod(-1, -1, 1);
    else {
      c.setLod(
        Math.max(1, Math.round(c.opts.iterations * L.scale)),
        Math.max(1, Math.round(c.opts.structuralPasses * L.scale)),
        L.skip,
      );
    }
  }
  function updateClothLod() {
    const cam = ctx.camera;
    if (!cam || !cloths.length || api.clothLod === false) return;
    const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
    for (let i = 0; i < cloths.length; i++) {
      const c = cloths[i];
      if (c._lodTier === undefined) { c._lodTier = -1; c.lodPhase = (lodPhase++) & 7; }
      const p = c.centre || c.origin;
      const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      let tier = 0;
      while (tier < CLOTH_LOD.length - 1 && d > CLOTH_LOD[tier].d) tier++;
      /* Only climb back down a tier once we are well inside it. */
      if (tier < c._lodTier && d > CLOTH_LOD[tier].d * 0.85) tier = c._lodTier;
      applyClothLod(c, tier);
    }
  }

  /* ---------------------------------------------------------------
     One fixed step. Order matters: controllers move first (everything
     else reacts to where the player ended up), then cloth, then floating
     bodies. Bone-driven chains are stepped from lateUpdate instead.
     --------------------------------------------------------------- */
  function fixedStep(h) {
    for (let i = controllers.length - 1; i >= 0; i--) {
      const c = controllers[i];
      if (c._dead) { controllers.splice(i, 1); continue; }
      c.step(h);
    }
    for (let i = cloths.length - 1; i >= 0; i--) {
      const c = cloths[i];
      if (c._dead) { cloths.splice(i, 1); continue; }
      if (c.auto && c.enabled && c.lodDue()) c.step(h);
    }
    for (let i = buoys.length - 1; i >= 0; i--) {
      const b = buoys[i];
      if (b._dead) { buoys.splice(i, 1); continue; }
      if (b.auto && b.enabled) b.step(h);
    }
    for (let i = chains.length - 1; i >= 0; i--) {
      const c = chains[i];
      if (c._dead) { chains.splice(i, 1); continue; }
      if (c.auto && c.enabled && c.phaseHint === 'update') { c.beginFrame(); c.step(h); }
    }
    simTime += h;
  }

  /**
   * Advance the simulation. Feed it the real frame dt; it runs whole
   * 60 Hz steps and leaves the remainder in the accumulator.
   * main.js calls this through update() — you do not normally call it.
   * @returns {number} fixed steps executed this call
   */
  function step(dt) {
    if (!(dt > 0)) { alpha = clamp(acc / FIXED_DT, 0, 1); steps = 0; return 0; }
    updateClothLod();                 // once a frame, not once a substep
    acc += Math.min(dt, 0.25);
    steps = 0;
    while (acc >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      fixedStep(FIXED_DT);
      acc -= FIXED_DT;
      steps++;
    }
    /* Behind by more than we can catch up on: drop the debt rather than
       spiralling. A stall must not turn into a slow-motion replay. */
    if (steps >= MAX_STEPS_PER_FRAME && acc > FIXED_DT) acc = 0;
    alpha = clamp(acc / FIXED_DT, 0, 1);

    for (let i = 0; i < controllers.length; i++) controllers[i].interpolate(alpha);
    for (let i = 0; i < buoys.length; i++) buoys[i].interpolate(alpha);
    for (let i = 0; i < chains.length; i++) {
      const c = chains[i];
      if (c.phaseHint === 'update') c.interpolate(alpha);
    }
    return steps;
  }

  /* ---------------------------------------------------------------
     Public API
     --------------------------------------------------------------- */
  const api = {
    world,
    THREE,
    get fixedDt() { return FIXED_DT; },
    get alpha() { return alpha; },
    get simTime() { return simTime; },
    get stepsLastFrame() { return steps; },
    /** Distance LOD for cloth. false = every sheet at authored quality. */
    clothLod: true,

    /* ---- static world ---- */
    /** Register a Mesh / Group / BufferGeometry / Box3. Matrices are baked. */
    addStatic(source, opts) {
      if (!source) return null;
      if (source.isBox3) return world.addBox(source, opts);
      return world.addMesh(source, opts);
    },
    /** Cheap 12-triangle proxy. Buildings, crates, kerbs, invisible walls. */
    addAABB(box, opts) { return world.addBox(box, opts); },
    addTriangles(positions, indices, opts) { return world.addTriangles(positions, indices, opts); },
    remove(id) {
      if (Array.isArray(id)) { let ok = true; for (const i of id) ok = world.remove(i) && ok; return ok; }
      return world.remove(id);
    },
    clearStatics() { world.clear(); return api; },
    /** y pins the fallback plane, null removes it, 'auto' = only while empty. */
    setGroundPlane(y) { world.setGroundPlane(y); return api; },

    /**
     * Cast a ray. `dir` need not be normalised, `maxDist` is in metres.
     * @returns {point, normal, distance, tri, body, plane} | null
     * The record is REUSED between calls — copy anything you keep.
     */
    raycast(origin, dir, maxDist = Infinity, out = null) {
      return world.raycast(origin, dir, maxDist, out);
    },

    /**
     * The ground under (x, z). Never returns null: with nothing
     * registered it answers the flat fallback plane at y = 0.
     * @returns {y, normal, hit, plane, distance, body}  (reused unless `out`)
     */
    groundAt(x, z, out = null) { return world.groundAt(x, z, out); },
    /** Just the height — terrain queries, prop placement, foot IK. */
    heightAt(x, z) { return world.groundAt(x, z).y; },
    /** Every contact for a capsule (a..b, r). Records are pooled. */
    capsuleCast(a, b, r, out = []) { return world.capsuleContacts(a, b, r, out); },

    /* ---- water ---- */
    /** number | (x,z)=>y | null (no water). Omit and phys finds ctx.water. */
    setWaterLevel(v) { waterOverride = v; waterFn = null; return api; },
    waterLevelAt,

    /* ---- bodies ---- */
    /** Capsule character controller. @see CONTROLLER_DEFAULTS */
    createController(opts = {}) {
      const c = new CharacterController(world, opts);
      c.waterLevelFn = opts.waterLevel ?? waterLevelAt;
      c._dead = false;
      const dispose = c.dispose.bind(c);
      c.dispose = () => { c._dead = true; dispose(); };

      c.onLand((e) => bus.emit('phys:land', e));
      c.onJump((e) => bus.emit('phys:jump', e));
      c.onStep((e) => bus.emit('phys:step', e));
      c.onRipple((e) => bus.emit('water:ripple', e));

      controllers.push(c);
      if (opts.player !== false && !api.player) api.player = c;
      return c;
    },

    /**
     * N-bone damped-spring chain — ears, trunk, tail, ropes, hanging
     * signs, camera booms. @see CHAIN_DEFAULTS, CHAIN_PRESETS.
     * The wind sampler and the fixed-step driving are wired for you.
     */
    createChain(opts = {}) {
      const preset = opts.preset ? CHAIN_PRESETS[opts.preset] : null;
      const c = new SpringChain({ ...(preset || {}), ...opts });
      c.windSampler = opts.wind === null ? null : (opts.wind ?? windAt);
      /* Bone/root-driven chains must solve after the rig posed. */
      c.phaseHint = opts.phase3d ?? ((opts.bones || opts.root) ? 'late' : 'update');
      c._dead = false;
      const dispose = c.dispose.bind(c);
      c.dispose = () => { c._dead = true; dispose(); };
      if (opts.follow) c.follow(opts.follow === true ? api.player : opts.follow);
      chains.push(c);
      return c;
    },

    /** Verlet cloth grid — flags, awnings, banners, sails. @see CLOTH_DEFAULTS */
    createCloth(opts = {}) {
      const c = new Cloth(opts);
      c.windSampler = opts.wind === null ? null : (opts.wind ?? windAt);
      c._dead = false;
      const dispose = c.dispose.bind(c);
      c.dispose = () => { c._dead = true; dispose(); };
      cloths.push(c);
      return c;
    },

    /** Floating body: submerged volume, drag, righting, ripple callbacks. */
    createBuoy(opts = {}) {
      const b = new BuoyantBody(opts);
      b.waterLevelFn = waterLevelAt;
      b.windSampler = windAt;
      b._dead = false;
      const dispose = b.dispose.bind(b);
      b.dispose = () => { b._dead = true; dispose(); };
      b.onSplash((e) => bus.emit('water:splash', e));
      b.onRipple((e) => bus.emit('water:ripple', e));
      buoys.push(b);
      return b;
    },

    createSpring(opts) { return new Spring1(opts); },
    createSpringVec3(opts) { return new Spring3(opts); },
    createSquash(opts) { return new SquashSpring(opts); },

    /** Sample the shared wind as a world vector. (x, z, phase) -> Vector3. */
    windAt,

    /** The controller ctx.wally drives. Set by the first createController. */
    player: null,

    /* ---- driving ---- */
    step,

    get stats() {
      return {
        triangles: world.triangleCount,
        bodies: world.bodies.size,
        controllers: controllers.length,
        chains: chains.length,
        cloths: cloths.length,
        buoys: buoys.length,
        steps,
        alpha: +alpha.toFixed(3),
        plane: world.planeActive ? world.planeY : null,
      };
    },

    /* ---- module contract ---- */
    update(dt) { step(dt); },

    lateUpdate() {
      /* Chains hang off bones, and bone world matrices only exist once
         the rig posed in ctx.wally.update(). Run them here, at the same
         fixed dt update() used, then interpolate for the remainder. */
      for (let i = chains.length - 1; i >= 0; i--) {
        const c = chains[i];
        if (c._dead) { chains.splice(i, 1); continue; }
        if (!c.enabled || !c.auto || c.phaseHint !== 'late') continue;
        c.beginFrame();
        for (let s = 0; s < steps; s++) c.step(FIXED_DT);
        c.interpolate(alpha);
        c.apply();
      }
      /* sync() is a no-op for a cloth that did not move this frame. */
      for (let i = 0; i < cloths.length; i++) {
        const c = cloths[i];
        if (c.enabled && c.geometry) c.sync();
      }
    },

    dispose() {
      for (const c of controllers) c.dispose();
      for (const c of chains) c.dispose();
      for (const c of cloths) c.dispose();
      for (const b of buoys) b.dispose();
      controllers.length = chains.length = cloths.length = buoys.length = 0;
      world.clear();
    },
  };

  /* ---------------------------------------------------------------
     Late arrivals. world.js boots before us and water.js after, but
     either may push collision geometry at any time.
     --------------------------------------------------------------- */
  bus.on?.('world:collision', (payload) => {
    if (!payload) return;
    if (Array.isArray(payload)) payload.forEach((p) => api.addStatic(p?.object ?? p, p?.opts));
    else api.addStatic(payload.object ?? payload, payload.opts);
  });

  /* If world.js already published a collider, ingest it now. */
  const wc = ctx.world?.collider ?? ctx.world?.collision ?? null;
  if (wc) api.addStatic(wc);
  const wl = ctx.world?.colliders;
  if (Array.isArray(wl)) for (const b of wl) api.addStatic(b);

  /* ---------------------------------------------------------------
     Debug hooks for tools/shot.mjs --eval.
     --------------------------------------------------------------- */
  const dbg = (typeof window !== 'undefined' && window.WALLY?.debug) || null;
  if (dbg) {
    dbg.physStats = () => api.stats;
    dbg.physGround = (x = 0, z = 0) => {
      const g = api.groundAt(x, z);
      return { y: g.y, n: [g.normal.x, g.normal.y, g.normal.z], plane: g.plane };
    };
    dbg.physTeleport = (x, y, z) => { api.player?.teleport(new THREE.Vector3(x, y, z)); };
    /* Kick every chain — the fastest way to see the flap in a screenshot. */
    dbg.physGust = (mx = 9, my = 3, mz = 0) => {
      _imp.set(mx, my, mz);
      for (const c of chains) c.impulse(_imp);
      return chains.length;
    };
    dbg.physSetPlane = (y) => api.setGroundPlane(y);
    /* Per-cloth LOD census: tier, distance, and whether it is alive. */
    dbg.physClothCensus = (all = false) => {
      const cam = ctx.camera?.position;
      const tiers = [0, 0, 0, 0];
      let worst = 1, deadNear = 0;
      const rows = cloths.map((c) => {
        const p = c.centre || c.origin;
        const d = cam ? Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z) : 0;
        const t = Math.max(0, c._lodTier | 0);
        tiers[t]++;
        worst = Math.max(worst, c.maxStretch);
        if (t === 0 && c.energy < 1e-7) deadNear++;
        return {
          t, d: +d.toFixed(0), it: c.lodIter, sp: c.lodStruct, sk: c.lodSkip,
          e: +c.energy.toExponential(1),
          p: [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)],
        };
      });
      rows.sort((a, b) => a.d - b.d);
      return {
        tiers, worstStretch: +worst.toFixed(3), stillNearCloths: deadNear,
        nearest: rows.slice(0, 6), farthest: rows.slice(-3),
        ...(all ? { rows } : null),
      };
    };
    /* Force every cloth to authored quality — the A/B for the LOD. */
    dbg.physClothLod = (on = true) => {
      api.clothLod = !!on;
      if (!on) for (const c of cloths) { c._lodTier = 0; c.setLod(-1, -1, 1); }
      return cloths.length;
    };
    /* Where the fixed step actually goes. Averages over `frames` frames
       and returns ms/frame per subsystem — use this before optimising
       anything in here, the answer has never once been the obvious one. */
    dbg.physProfile = (frames = 40) => {
      const T = { ctl: 0, cloth: 0, chain: 0, buoy: 0, total: 0, n: 0, cn: 0 };
      const raw = { ctl: [], cloth: [], chain: [], buoy: [] };
      const hook = (list, key, cnt) => list.map((b) => {
        const f = b.step.bind(b);
        raw[key].push(b);
        b.step = (h) => { const t = performance.now(); const r = f(h); T[key] += performance.now() - t; if (cnt) T[cnt]++; return r; };
        return b;
      });
      hook(controllers, 'ctl'); hook(cloths, 'cloth', 'cn'); hook(chains, 'chain'); hook(buoys, 'buoy');
      const outer = api.update.bind(api);
      api.update = (dt) => { const t = performance.now(); const r = outer(dt); T.total += performance.now() - t; T.n++; return r; };
      return new Promise((res) => {
        const tick = () => {
          if (T.n < frames) return requestAnimationFrame(tick);
          for (const k of Object.keys(raw)) for (const b of raw[k]) delete b.step;
          api.update = (dt) => { step(dt); };
          const q = (x) => +(x / T.n).toFixed(3);
          res({
            frames: T.n, physMs: q(T.total), controllerMs: q(T.ctl), clothMs: q(T.cloth),
            chainMs: q(T.chain), buoyMs: q(T.buoy),
            clothStepsPerFrame: q(T.cn), msPerClothStep: +(T.cloth / Math.max(1, T.cn)).toFixed(4),
            stepsPerFrame: q(steps * T.n), lod: api.clothLod !== false,
          });
        };
        requestAnimationFrame(tick);
      });
    };
  }

  return api;
}

export {
  CollisionWorld, CharacterController, SpringChain, Spring1, Spring3,
  SquashSpring, Cloth, BuoyantBody,
  CONTROLLER_DEFAULTS, CHAIN_DEFAULTS, CHAIN_PRESETS, CLOTH_DEFAULTS, BUOY_DEFAULTS,
};
export default init;
