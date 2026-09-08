/* ============================================================
   world.js — ctx.world. The island everything else stands on.

   Boot stage 5: after render/mat/wind/sky, before water, physics,
   Wally, the city, the foliage and the NPCs. Those last three attach
   their own content to the scene-graph roots created here.

   WHAT THIS MODULE OWNS
     - the heightfield (terrain.js) and the road network (paths.js)
     - the four scene-graph roots every other world agent hangs off
     - the ground queries: heightAt / normalAt / zoneAt / locationAt /
       shoreDistAt / pathAt / placeOnGround
     - terrain collision, streamed into ctx.phys as a 3x3 window of
       64 m tiles around the player
     - a drift of pollen so no frame of this game is ever still

   THE COORDINATE LAW is src/game/data.js's, not ours:
       world.x = (map.x - 500) * 0.9      +X east
       world.z = (map.y - 330) * 0.9      +Z south
       +Y up, metres, sea level y = 0
   Every district's base elevation, every building's ground height,
   yaw, footprint and clearance circle come from that file. Nothing
   about the layout is invented here.

   API — other modules code against exactly this.
   ------------------------------------------------------------
   Groups          groundGroup  propGroup  foliageGroup  cityGroup
   Queries         heightAt(x,z)              metres
                   normalAt(x,z,out?)         Vector3, unit
                   slopeAt(x,z)               0..1  (1 - n.y)
                   zoneAt(x,z)                zone record | null
                   locationAt(x,z)            location record | null
                   nearestLocation(x,z)       {loc, dist}
                   shoreDistAt(x,z)           metres, >0 inland
                   pathAt(x,z)                0..1 road coverage
                   isWater / isBeach / isRoad (x,z)
                   groundColorAt(x,z,out?)    linear THREE.Color
   Placement       placeOnGround(obj,x,z,opts)
                     opts {offset, align 0..1, yaw, scale, jitter, rng}
                   groundPoint(x,z,out?)      Vector3
   Data            bounds Box3, seaLevel, beachWidth, islandRadiusX/Z,
                   zones, locations, paths {nodes, edges}
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { BRAND, LAND } from '../core/palette.js';
import { clamp, damp, lerp, smoothstep } from '../core/contracts.js';
import { ZONES, LOCATIONS, LOC_BY_ID, WORLD } from '../game/data.js';
import { createTerrain, TILE, CELL } from './terrain.js';
import { createPaths } from './paths.js';

export async function init(ctx) {
  const t0 = performance.now();

  /* ================================================================
     1. Scene-graph roots.
        Created unconditionally, and BEFORE anything can fail, so the
        city / foliage / NPC agents always have somewhere to attach.
     ================================================================ */
  const root = new THREE.Group();
  root.name = 'world';
  const groundGroup = new THREE.Group(); groundGroup.name = 'world.ground';
  const propGroup = new THREE.Group(); propGroup.name = 'world.props';
  const foliageGroup = new THREE.Group(); foliageGroup.name = 'world.foliage';
  const cityGroup = new THREE.Group(); cityGroup.name = 'world.city';
  root.add(groundGroup, cityGroup, propGroup, foliageGroup);
  ctx.scene.add(root);

  /* ================================================================
     2. Terrain, then roads, then the building pads, then the meshes.
        Order matters: routes are relaxed against the raw landscape,
        carved into it, and only then do the pads flatten the ground
        under each building — so a lane always arrives at a level
        forecourt instead of ending in a step.
     ================================================================ */
  const terrain = createTerrain(ctx);
  const paths = createPaths(ctx, terrain);
  terrain.padPass();
  terrain.smoothPass(0.16);
  terrain.finalise();
  paths.buildRibbons();

  groundGroup.add(terrain.group);
  groundGroup.add(paths.group);
  /* Rock registers itself inside terrain.js — it wants outlines and
     shadow casting, which the two register() calls below deliberately
     switch off for the heightfield. */
  groundGroup.add(terrain.rockGroup);
  ctx.mat.register(terrain.group, { outline: false, castShadow: false, receiveShadow: true });
  ctx.mat.register(paths.group, { outline: false, castShadow: false, receiveShadow: true });

  /* ================================================================
     3. Pollen. §6: "something is moving in the wind in every single
        frame", and the terrain is the one module guaranteed to be in
        every exterior shot. A hundred motes riding ctx.wind, kept in
        a shell around the camera and recycled upwind.
     ================================================================ */
  const motes = makeMotes(ctx, terrain);
  if (motes) propGroup.add(motes.mesh);

  /* ================================================================
     4. Queries
     ================================================================ */
  const _v = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _q2 = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);

  const heightAt = terrain.heightAt;
  const normalAt = terrain.normalAt;

  function locationAt(x, z) {
    for (const l of LOCATIONS) {
      const dx = x - l.world.x, dz = z - l.world.z;
      if (dx * dx + dz * dz <= l.radius * l.radius) return l;
    }
    return null;
  }
  function nearestLocation(x, z) {
    let best = null, bd = Infinity;
    for (const l of LOCATIONS) {
      const d = Math.hypot(x - l.world.x, z - l.world.z);
      if (d < bd) { bd = d; best = l; }
    }
    return { loc: best, dist: bd };
  }

  const isWater = (x, z) => heightAt(x, z) < WORLD.seaLevel;
  const isBeach = (x, z) => {
    const d = terrain.shoreDistAt(x, z);
    return d > -2 && d < WORLD.beachWidth + 6;
  };
  const isRoad = (x, z) => terrain.pathAt(x, z) > 0.35;

  /**
   * Stand `obj` on the ground at (x, z).
   *   offset  metres above the surface (default 0)
   *   align   0..1 how much to tilt into the slope (default 0)
   *   yaw     radians about +Y, applied before the align tilt
   *   scale   uniform scale
   *   jitter  metres of deterministic XZ scatter (needs `rng`)
   */
  function placeOnGround(obj, x, z, opts = {}) {
    let px = x, pz = z;
    if (opts.jitter && opts.rng) {
      px += (opts.rng() - 0.5) * 2 * opts.jitter;
      pz += (opts.rng() - 0.5) * 2 * opts.jitter;
    }
    const y = heightAt(px, pz) + (opts.offset || 0);
    obj.position.set(px, y, pz);
    const yaw = opts.yaw;
    if (yaw != null) obj.rotation.y = yaw;
    const align = opts.align || 0;
    if (align > 0) {
      normalAt(px, pz, _v);
      _q.setFromUnitVectors(UP, _v);
      _q2.identity().slerp(_q, clamp(align, 0, 1));
      if (yaw != null) _q2.multiply(new THREE.Quaternion().setFromAxisAngle(UP, yaw));
      obj.quaternion.copy(_q2);
    }
    if (opts.scale != null) obj.scale.setScalar(opts.scale);
    obj.updateMatrix?.();
    return obj;
  }
  function groundPoint(x, z, out) {
    return (out || new THREE.Vector3()).set(x, heightAt(x, z), z);
  }

  /* ================================================================
     5. Collision + LOD, driven from the frame loop.
     ================================================================ */
  let bootSnap = false;
  const _cam = new THREE.Vector3();

  function currentFocus() {
    const p = ctx.phys?.player?.position;
    if (p) return p;
    ctx.camera.getWorldPosition(_cam);
    return _cam;
  }

  /* ================================================================
     6. Debug hooks
     ================================================================ */
  const dbg = (window.WALLY && window.WALLY.debug) || {};
  const camState = { active: false, pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 50, near: 0.6, far: 4000, fog: 0 };

  /* THE HAZE IS A GAMEPLAY LAW, NOT A DIAGNOSTIC ONE. §2.4 pales
     everything toward #B8DEF0 past ~120 m and sky/lighting.js honours
     that with scene.fog at near 60 / far 420 — so an island shot from
     900 m out is, correctly, a rectangle of haze. A debug camera that
     stands further back than the fog swaps in a longer-range Fog of
     the same colour for as long as it holds the camera, and puts the
     sky module's own object back the moment it lets go. */
  /* ================================================================
     6a. THE HAZE RANGE (§2.4).

     §2.4 says "distance haze pales everything toward #B8DEF0 past
     ~120 m". sky/lighting.js — which this module does not own —
     builds its Fog at near 60 / far 420, i.e. the ramp is half over
     before the spec says it should start, and it shows: measured on
     the shore camera, headland grass came back #5f947e (hue 155, sat
     36) against LAND.grassLit's hue 95 / sat 60, and beach sand came
     back #b3b49f (hue 63, sat 12) against LAND.sand's hue 44 / sat
     29. That is a 58-degree hue rotation toward teal and a quarter of
     the saturation left, on ground 120 m from the lens.

     The fix belongs in lighting.js and has been asked for there; in
     the meantime the range is remapped here, after every subsystem
     has updated and before the frame is drawn. It is a REMAP, not an
     override: lighting.js drives near/far down together to thicken
     the haze in weather, so the weather signal is recovered from
     where its own numbers sit inside their known range and re-applied
     to the corrected one. Colour is untouched — that is lighting's.
     ================================================================ */
  /* PUSHED BACK TOO FAR ON THE LAST PASS. near 150 / far 720 put the
     fog factor at 0.09 on ground 200 m out and 0.05 at the treeline —
     i.e. the correction for an over-hazed mid-ground removed the
     aerial perspective altogether, and the review duly reported that
     the distant hills were the same value as the grass at the camera.
     100 / 520 leaves 120 m essentially clear (0.04, so the headland
     keeps its hue) and still reaches 0.24 at 200 m and 0.72 at 400 —
     which is what §2.4's "pales everything past ~120 m" asks for. */
  const HAZE = { near: [28, 100], far: [200, 520], srcNear: [14, 60], srcFar: [130, 420] };
  function regradeHaze() {
    const f = ctx.scene.fog;
    if (!f || f === dbgFog || !f.isFog) return;
    const t = clamp((f.near - HAZE.srcNear[0]) / (HAZE.srcNear[1] - HAZE.srcNear[0]), 0, 1);
    const tf = clamp((f.far - HAZE.srcFar[0]) / (HAZE.srcFar[1] - HAZE.srcFar[0]), 0, 1);
    f.near = lerp(HAZE.near[0], HAZE.near[1], t);
    f.far = lerp(HAZE.far[0], HAZE.far[1], tf);
  }

  let dbgFog = null, savedFog;
  function setDebugFog(near, far) {
    if (!near) {
      if (savedFog !== undefined) { ctx.scene.fog = savedFog; savedFog = undefined; }
      return;
    }
    if (savedFog === undefined) savedFog = ctx.scene.fog;
    if (!dbgFog) dbgFog = new THREE.Fog(0xb8def0, near, far);
    dbgFog.near = near; dbgFog.far = far;
    if (ctx.sky?.fogColor) dbgFog.color.copy(ctx.sky.fogColor);
    ctx.scene.fog = dbgFog;
  }

  function takeCamera(px, py, pz, tx, ty, tz, fov = 50, near = 0.6, far = 4000, fogFar = 0) {
    camState.active = true;
    camState.pos.set(px, py, pz);
    camState.look.set(tx, ty, tz);
    camState.fov = fov; camState.near = near; camState.far = far; camState.fog = fogFar;
    setDebugFog(fogFar ? fogFar * 0.16 : 0, fogFar);
    /* camera.js documents three ways to stand its rig down; override()
       is the cooperative one and the highest priority mode it has. */
    ctx.cam?.override?.(camState.pos, camState.look, fov);
    ctx.bus.emit('cam:override', { owner: 'world.debug' });
    applyCamera();
    return {
      pos: camState.pos.toArray(), look: camState.look.toArray(),
      fov, near, far, fogFar,
    };
  }
  function applyCamera() {
    if (!camState.active) return;
    const cam = ctx.camera;
    cam.position.copy(camState.pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(camState.look);
    if (cam.isPerspectiveCamera) {
      cam.fov = camState.fov;
      cam.near = camState.near;
      cam.far = camState.far;
      cam.updateProjectionMatrix();
    }
    if (camState.fog && dbgFog && ctx.sky?.fogColor) dbgFog.color.copy(ctx.sky.fogColor);
  }

  let orbitTarget = null, orbitDist = 60, orbitHeight = 26;

  function resolveTarget(id) {
    if (LOC_BY_ID[id]) {
      const l = LOC_BY_ID[id];
      return { x: l.world.x, z: l.world.z, y: heightAt(l.world.x, l.world.z), r: Math.max(24, l.radius * 1.7), yaw: l.yaw, name: l.n, elev: 0.22 };
    }
    if (ZONES[id]) {
      const z = ZONES[id];
      return { x: z.world.x, z: z.world.z, y: heightAt(z.world.x, z.world.z), r: Math.max(78, z.world.radius * 0.62), yaw: z.yaw, name: z.n, elev: 0.17 };
    }
    return null;
  }

  dbg.flyTo = (id, opts = {}) => {
    const t = resolveTarget(id);
    if (!t) { console.warn(`[world] no zone or location "${id}"`); return null; }
    const d = opts.dist ?? t.r;
    const el = opts.elev ?? t.elev ?? 0.24;       // fraction of d
    /* Approach from the district anchor's own facing, so a building
       is seen from its front rather than from its back wall. */
    const a = (t.yaw ?? 0) + (opts.turn ?? 0);
    orbitTarget = t; orbitDist = d; orbitHeight = d * el + 3;
    return takeCamera(
      t.x + Math.sin(a) * d, t.y + orbitHeight, t.z + Math.cos(a) * d,
      t.x, t.y + 4, t.z,
      opts.fov ?? 50, Math.max(0.4, d * 0.008), 4000, opts.fogFar ?? (d > 190 ? d * 3.2 : 0),
    );
  };

  dbg.orbit = (deg = 0, opts = {}) => {
    const t = orbitTarget || resolveTarget('mainstreet');
    orbitTarget = t;
    const a = THREE.MathUtils.degToRad(deg);
    const d = opts.dist ?? orbitDist;
    return takeCamera(
      t.x + Math.sin(a) * d, t.y + (opts.height ?? orbitHeight), t.z + Math.cos(a) * d,
      t.x, t.y + 3, t.z,
      opts.fov ?? 48, Math.max(0.6, d * 0.01), 4000, opts.fogFar ?? (d > 190 ? d * 3.2 : 0),
    );
  };

  dbg.topDown = (tilt = 0.42, height = 900) => {
    const back = height * Math.tan(tilt);
    return takeCamera(0, height, back, 0, 6, -30, 54, height * 0.06, 4000, 2600);
  };

  /** A low, reverent horizon shot — the silhouette test (§6). */
  dbg.vista = (deg = 200, dist = 880, height = 130) => {
    const a = THREE.MathUtils.degToRad(deg);
    return takeCamera(Math.sin(a) * dist, height, Math.cos(a) * dist, 0, 30, 0, 40, 4, 4000, 2100);
  };

  /* The cliffs are the hardest thing on this island to review: they
     are wherever the coast happens to be rocky, and no zone anchor
     points at one. This finds the biggest sea cliffs on the island by
     (height x steepness) and stands off one of them at rock scale. */
  function cliffSites() {
    const T = terrain;
    const out = [];
    for (let j = 0; j < T.NZ; j += 5) {
      for (let i = 0; i < T.NX; i += 5) {
        const o = T.IX(i, j);
        const d = T.SD[o];
        if (d < -4 || d > 40) continue;
        const x = T.wx(i), z = T.wz(j), h = T.H[o];
        if (h < 8) continue;
        out.push({ x, z, h, score: h * T.wideSteep(x, z, 8) });
      }
    }
    out.sort((a, b) => b.score - a.score);
    /* Thin out neighbours so "site 1" is a different headland rather
       than the cell next door to site 0. */
    const keep = [];
    for (const c of out) {
      if (keep.some((k) => Math.hypot(k.x - c.x, k.z - c.z) < 180)) continue;
      keep.push(c);
      if (keep.length >= 8) break;
    }
    return keep;
  }

  dbg.cliffCam = (idx = 0, opts = {}) => {
    const sites = cliffSites();
    if (!sites.length) return null;
    const c = sites[Math.min(idx, sites.length - 1)];
    const l = Math.hypot(c.x, c.z) || 1;
    const ox = c.x / l, oz = c.z / l;            // outward, toward open sea
    const d = opts.dist ?? 74;
    return takeCamera(
      c.x + ox * d, (opts.height ?? c.h * 0.52 + 9), c.z + oz * d,
      c.x - ox * 10, c.h * 0.46, c.z - oz * 10,
      opts.fov ?? 46, 0.5, 4000, 0,
    );
  };

  /* A CAMERA OUT OVER A DROP, BELOW THE TURF LINE, AIMED BACK AT A
     BRINK YOU NAME. This is the framing every argument about the
     island's edges needs and almost never gets: from on top of a
     brink looking down, a cliff and a shelf are the same picture.
     (It used to have a sibling, lipCam, that ranked the sod tongues
     for you. The tongues are gone — see terrain.js — and this is the
     half that was about the terrain rather than about them.) */
  /* THE ART-REVIEW CAMERA, and the reason it had to exist.

     Every other debug camera in this file frames a PLACE — a district,
     a building, a cliff. Reviewing a 40 cm object needed something
     none of them do: stand at arm's length off a given world point and
     look straight at it. Doing it through the gameplay camera instead
     puts Wally's head between the lens and the thing (his boom is 4.2 m
     behind him and the subject is 3 m in front), which is how a whole
     gallery run of screenshots came back photographing the back of his
     ears; and moving the eye off the boom by hand is the trap that
     voided a previous agent's entire photo set.

       WALLY.debug.lookAt(x, y, z, { dist: 3, az: 35, el: 14, fov: 38 })

     az is degrees clockwise from +Z, el degrees above the subject. */
  dbg.lookAt = (x, y = 0, z = 0, opts = {}) => {
    const d = Math.max(0.4, opts.dist ?? 4);
    const a = THREE.MathUtils.degToRad(opts.az ?? 35);
    const el = THREE.MathUtils.degToRad(opts.el ?? 14);
    const h = Math.cos(el) * d;
    return takeCamera(
      x + Math.sin(a) * h, y + Math.sin(el) * d, z + Math.cos(a) * h,
      x, y, z,
      opts.fov ?? 40, Math.max(0.1, d * 0.03), 4000, opts.fogFar ?? 0,
    );
  };

  dbg.spotCam = (x, z, opts = {}) => {
    const e = 6;
    const gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
    const gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
    const m = Math.hypot(gx, gz) || 1;
    const ux = gx / m, uz = gz / m;                 // uphill
    const d = opts.dist ?? 16;
    const y = heightAt(x, z);
    return takeCamera(
      x - ux * d, y - (opts.drop ?? 5), z - uz * d,
      x + ux * 1.5, y + 0.3, z + uz * 1.5,
      opts.fov ?? 42, 0.4, 4000, 0,
    );
  };

  /* A height transect straight into the face — the only honest way to
     tell a sculpted shelf from a shaded one. */
  dbg.cliffProbe = (idx = 0, n = 44) => {
    const sites = cliffSites();
    if (!sites.length) return null;
    const c = sites[Math.min(idx, sites.length - 1)];
    const l = Math.hypot(c.x, c.z) || 1;
    const ox = c.x / l, oz = c.z / l;
    const ys = [];
    for (let k = 0; k < n; k++) {
      const t = 30 - k * 2;
      ys.push(+heightAt(c.x + ox * t, c.z + oz * t).toFixed(2));
    }
    return { site: [Math.round(c.x), Math.round(c.z)], h: +c.h.toFixed(1), ys };
  };

  dbg.releaseCamera = () => {
    camState.active = false;
    setDebugFog(0);
    ctx.cam?.releaseOverride?.();
    ctx.cam?.resume?.();
    ctx.bus.emit('cam:release', { owner: 'world.debug' });
  };

  dbg.worldStats = () => ({
    rasterMs: terrain.stats.rasterMs,
    tiles: terrain.tiles.length,
    lod: terrain.tiles.reduce((a, t) => { a[t.level] = (a[t.level] || 0) + 1; return a; }, {}),
    colliderTiles: terrain.colliderCount(),
    roads: paths.edges.length,
    buildMs: Math.round(buildMs),
  });
  dbg.worldHeight = (x = 0, z = 0) => ({
    y: +heightAt(x, z).toFixed(3),
    slope: +terrain.slopeAt(x, z).toFixed(3),
    shore: +terrain.shoreDistAt(x, z).toFixed(1),
    zone: terrain.zoneAt(x, z)?.id ?? null,
    path: +terrain.pathAt(x, z).toFixed(2),
  });
  dbg.worldWire = (on = true) => { terrain.material.wireframe = !!on; paths.material.wireframe = !!on; };
  /* groundTurf(0..2) — the per-pixel turf mosaic's master strength.
     0 leaves only the vertex colour, which is the only way to tell
     which of the two layers a measured hue shift came from. */
  dbg.groundTurf = (v = 1) => terrain.setTurf(v);
  dbg.worldPaths = (on = true) => { paths.group.visible = !!on; };

  /* ================================================================
     THE TERRAIN STREAM BUDGET.

     update() below drives three of terrain.js's queues — collider
     tiles, rock sectors, tile geometries — and terrain.js takes a
     COUNT for each. A count is not a budget: three tile geometries in
     one frame is three unbounded geometry builds, and a profile caught
     one world frame at 9-10 ms doing exactly that. 1.2 ms matches the
     foliage streamer's BUILD_MS, so the two streamers together cannot
     claim more than a third of a 60 fps frame.

     'count' is the rule that shipped and 'budget' the new one; both
     live in update() and WALLY.debug.worldStreamMode() drives them on
     one page load, so tools/_fa-stream.mjs can watch the old rule
     produce a tail the new one does not.
     ================================================================ */
  const STREAM_MS = 1.2;
  let streamMode = 'budget';
  let streamMs = 0;
  const slog = [];
  const qOf = (a, p) => { if (!a.length) return 0; const v = a.slice().sort((x, y) => x - y); return +v[Math.min(v.length - 1, Math.max(0, Math.ceil(v.length * p) - 1))].toFixed(3); };
  dbg.worldStream = () => ({ mode: streamMode, budgetMs: STREAM_MS, frames: slog.length,
    p50: qOf(slog, 0.5), p95: qOf(slog, 0.95), p99: qOf(slog, 0.99), worst: qOf(slog, 1) });
  dbg.worldStreamMode = (m) => { if ((m === 'count' || m === 'budget') && m !== streamMode) { streamMode = m; slog.length = 0; } return streamMode; };

  if (window.WALLY) window.WALLY.debug = dbg;

  const buildMs = performance.now() - t0;
  console.log(`[world] island built in ${Math.round(buildMs)} ms — ` +
    `${terrain.tiles.length} tiles, ${paths.edges.length} roads, raster ${terrain.stats.rasterMs} ms`);

  /* ================================================================
     7. ctx.world
     ================================================================ */
  const bounds = terrain.bounds;

  return {
    /* --- scene-graph roots --- */
    root, groundGroup, propGroup, foliageGroup, cityGroup,

    /* --- queries --- */
    heightAt,
    normalAt,
    slopeAt: terrain.slopeAt,
    zoneAt: terrain.zoneAt,
    locationAt, nearestLocation,
    shoreDistAt: terrain.shoreDistAt,
    pathAt: terrain.pathAt,
    isWater, isBeach, isRoad,
    groundColorAt(x, z, out) {
      return terrain.groundColor(x, z, heightAt(x, z), normalAt(x, z, _v).y, out);
    },
    distanceToRoad: paths.distanceToRoad,

    /* --- placement --- */
    placeOnGround, groundPoint,

    /* --- data --- */
    bounds,
    size: new THREE.Vector3(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z),
    seaLevel: WORLD.seaLevel,
    beachWidth: WORLD.beachWidth,
    islandRadiusX: WORLD.islandRadiusX,
    islandRadiusZ: WORLD.islandRadiusZ,
    tileSize: TILE,
    cellSize: CELL,
    zones: ZONES,
    locations: LOCATIONS,
    locationById: LOC_BY_ID,
    paths: { nodes: paths.nodes, edges: paths.edges, at: terrain.pathAt, stats: paths.stats },
    terrain,

    /* phys ingests `collider` at its own init; ours is streamed
       instead, from update() — see terrain.updateCollision. */
    collider: null,

    /* --- frame --- */
    update(dt, elapsed) {
      /* One-shot safety net, and it has to run BEFORE the first
         collision tile exists. Wally's controller spawns at (0,0,0)
         and the ground at the origin is 14 m up, so the very first
         fixed step would resolve a capsule buried in a hillside by
         shoving it sideways — which is also how the streamed
         collision window ended up chasing him across four tiles
         before anything had placed him. world.update runs before
         phys.update, so this lands first. */
      if (!bootSnap && ctx.phys?.player) {
        bootSnap = true;
        const p = ctx.phys.player.position;
        const h = heightAt(p.x, p.z);
        if (p.y < h - 0.2) ctx.phys.player.teleport(_v.set(p.x, h + 0.05, p.z));
      }

      const f = currentFocus();
      const tS = performance.now();

      if (streamMode === 'count') {
        /* THE RULE THAT SHIPPED, verbatim, kept as the revert switch.
           Three COUNTERS: up to two collider tiles, four rock sectors
           and three tile geometries in one frame, none of them costed.
           foliage.js learned this lesson in its own comment — "the
           streamer is a budget, not a counter" — and this call site
           never did. Three tile geometries is where a single 9-10 ms
           world frame came from. */
        terrain.updateCollision(f.x, f.z, 2);
        terrain.updateRockCollision(f.x, f.z, 4);
        terrain.updateLOD(ctx.camera);
        terrain.processPending(ctx.quality.name === 'low' ? 1 : 3);
      } else {
        /* ONE SHARED MILLISECOND BUDGET, spent in priority order.
           terrain.js owns these three queues and takes a COUNT, so the
           budget is applied here, at the call site, by asking for ONE
           item at a time until the clock says stop. Each is cheap to
           re-enter: updateCollision early-returns once its centre
           matches and its queue is empty, and processPending returns
           immediately on an empty queue, so the loop costs nothing on
           the frames — the overwhelming majority — where there is no
           work to do.

           THE ORDER IS THE PRIORITY, and it is not the order of cost.
           Collision first: ground he can fall through is a bug, a tile
           still at its coarse LOD is not. Rock next, for the same
           reason. Tile geometry last, because updateLOD has already
           put a coarser geo on the mesh and the frame renders. */
        const B = STREAM_MS;
        const spent = () => performance.now() - tS >= B;
        /* ALWAYS AT LEAST ONE of each, then more only while the clock
           allows. A budget that can refuse every item is an island
           that never sharpens and a player who falls through it; the
           overshoot is now bounded by ONE item of one kind rather than
           by two colliders plus four rock sectors plus three tile
           geometries taken together. The counts are the ones that
           shipped, so the streaming RATE is unchanged on a frame with
           room and only clipped on a frame without. */
        terrain.updateCollision(f.x, f.z, 1);
        if (!spent()) terrain.updateCollision(f.x, f.z, 1);
        for (let k = 0; k < 4; k++) { terrain.updateRockCollision(f.x, f.z, 1); if (spent()) break; }
        terrain.updateLOD(ctx.camera);
        const maxGeo = ctx.quality.name === 'low' ? 1 : 3;
        for (let k = 0; k < maxGeo; k++) { terrain.processPending(1); if (spent()) break; }
      }
      streamMs = performance.now() - tS;
      slog.push(streamMs); if (slog.length > 512) slog.shift();
      motes?.update(dt, elapsed);
    },

    lateUpdate() { regradeHaze(); applyCamera(); },

    dispose() {
      terrain.dispose();
      paths.dispose();
      motes?.dispose();
      ctx.scene.remove(root);
    },
  };
}

/* ============================================================
   Pollen / dust motes.

   Small alpha-cut cards riding the shared wind field, kept inside a
   shell around the camera. Deliberately JS-driven rather than
   shader-driven: they have to RECYCLE (a mote that leaves the shell
   reappears upwind), and that is a decision a vertex shader cannot
   make. 90 instances is one draw call.
   ============================================================ */
function makeMotes(ctx, terrain) {
  const q = ctx.quality;
  const N = Math.max(24, Math.round(96 * (q.particles ?? 1)));
  if (N <= 0) return null;

  const tex = moteTexture(ctx);
  const mat = ctx.mat.foliage({
    name: 'world.pollen',
    map: tex,
    color: BRAND.paper,
    alphaTest: 0.34,
    sss: 0.85,
    sssColor: LAND.sand,
    rim: 0.9,
    grain: 0,
    wind: 0,
    outline: false,
    noOutline: true,
    side: THREE.DoubleSide,
    /* A mote is a speck of light in the air, not a leaf: park it
       permanently in the core band and take it out of the shadow map
       so it never reads as a dark shape drifting past the lens. */
    term: -1, core: -1, shadowStrength: 0,
  });
  mat.userData.noPrepass = true;

  const geo = new THREE.PlaneGeometry(1, 1);
  const mesh = new THREE.InstancedMesh(geo, mat, N);
  mesh.name = 'world.pollen';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.noPrepass = true;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const rng = ctx.makeRng('wally.pollen');
  const RADIUS = 38;
  const p = new Float32Array(N * 3);
  const ph = new Float32Array(N);
  const sc = new Float32Array(N);
  const cam = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const wind = new THREE.Vector3();

  function respawn(i, cx, cz, seeded) {
    const a = rng() * Math.PI * 2;
    const r = seeded ? Math.sqrt(rng()) * RADIUS : RADIUS * (0.82 + rng() * 0.18);
    const wx = ctx.wind?.uniforms.uWindDir.value.x ?? 1;
    const wz = ctx.wind?.uniforms.uWindDir.value.y ?? 0;
    const x = seeded ? cx + Math.cos(a) * r : cx - wx * r + -wz * (rng() - 0.5) * RADIUS;
    const z = seeded ? cz + Math.sin(a) * r : cz - wz * r + wx * (rng() - 0.5) * RADIUS;
    p[i * 3] = x;
    p[i * 3 + 1] = terrain.heightAt(x, z) + 0.5 + rng() * 5.5;
    p[i * 3 + 2] = z;
    ph[i] = rng() * 6.283;
    sc[i] = 0.030 + rng() * 0.048;
  }
  for (let i = 0; i < N; i++) respawn(i, 0, 0, true);

  return {
    mesh,
    update(dt, elapsed) {
      ctx.camera.getWorldPosition(cam);
      const w = ctx.wind;
      if (w) w.vector(cam.x, cam.z, wind);
      const wx = (wind.x || 0.4) * 1.9, wz = (wind.z || 0.2) * 1.9;
      ctx.camera.getWorldQuaternion(quat);
      for (let i = 0; i < N; i++) {
        const o = i * 3;
        const bob = Math.sin(elapsed * 1.7 + ph[i]) * 0.5;
        p[o] += (wx + Math.sin(elapsed * 0.9 + ph[i]) * 0.45) * dt;
        p[o + 2] += (wz + Math.cos(elapsed * 1.1 + ph[i] * 1.7) * 0.45) * dt;
        p[o + 1] += bob * dt;
        const dx = p[o] - cam.x, dz = p[o + 2] - cam.z;
        const d2 = dx * dx + dz * dz;
        /* Out of the shell, or close enough to the lens to read as an
           object rather than as a speck. */
        if (d2 > RADIUS * RADIUS || d2 < 9) { respawn(i, cam.x, cam.z, false); continue; }
        const g = terrain.heightAt(p[o], p[o + 2]);
        if (p[o + 1] < g + 0.35) p[o + 1] = g + 0.35;
        if (p[o + 1] > g + 7.5) p[o + 1] = g + 7.5;
        pos.set(p[o], p[o + 1], p[o + 2]);
        scl.setScalar(sc[i]);
        m.compose(pos, quat, scl);
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() { geo.dispose(); mat.dispose(); tex.dispose(); },
  };
}

/* A soft round mote, drawn once to a 64 px canvas. No external
   assets anywhere in this game (BUILD_BRIEF). */
function moteTexture(ctx) {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.92)');
  grad.addColorStop(0.75, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = ctx.quality.anisotropy || 1;
  return t;
}
