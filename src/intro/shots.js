/* ============================================================
   shots.js — the storyboard, and the two props the storyboard needs.

   Nothing here touches the camera or the clock; intro.js is the
   director and this file is the shot list, the gulls and the bicycle.

   ------------------------------------------------------------------
   THE CUT IS A TOOL, NOT A FAILURE
   ------------------------------------------------------------------
   ctx.cam.cinematic() plays ONE Catmull-Rom through its control
   points. Calling it again replaces the timeline, which is a hard
   cut — so the opener is four calls, not one 35-second drone take:

     SEQ A  the sea      0.000 -> 11.111   (2.5 bars)
     SEQ B  the island  11.111 -> 20.000   (2.0 bars)
     SEQ C  the arrival 20.000 -> 26.667   (1.5 bars)
     SEQ D  the hero    26.667 -> 34.667   (1.8 bars, title on 7.0)

   Every cut lands on a bar line of the `cinematic` score (54 bpm,
   4/4 -> a 4.444 s bar), and the title lands on bar 7 exactly, which
   is where `ctx.audio.sting('title')` is fired.

   The C->D cut is also doing story work: he is riding at 26.666 and
   standing in the 'cool' pose at 26.668. A cut is the only way to
   dismount a character who has no dismount animation, and it is what
   a real edit would do anyway.

   ------------------------------------------------------------------
   WHY THE SHOTS SIT WHERE THEY SIT
   ------------------------------------------------------------------
   Sun azimuth is (hour - 12) * 15 deg about +Y (world/lighting.js),
   so at 06:00 the sun sits almost exactly along -X. Everything
   follows from that:

   * SEQ A opens 220 m off the east coast looking WEST, so the sun is
     on the horizon 3 deg left of the axis, its glitter path runs
     straight at the lens, and the Golden Heights cliff closes the
     right of the frame. Measured, not guessed — see shots/intro-0.
   * SEQ B is a crane-up-and-back. Fitting a 970 x 760 m island in a
     52 deg lens needs ~600 m of standoff, and scene.fog is 60/420 by
     default, so the whole thing is a flat lavender wash unless the
     fog is opened. intro.js pushes fog.far every frame while the
     aerials are up (it is stage 13, so it writes AFTER sky.update)
     and eases it back for the ground shots.
   * SEQ D is solved for the light, not the map. With the sun near
     -X, a camera looking north-east puts it 35 deg behind the lens
     and, crucially, on the LEFT: dot(sun, cameraRight) = -0.49. That
     is ART_DIRECTION 1.2's "large soft key from upper-left", which
     is the lighting the reference renders of Wally are made under
     and the only lighting his sunglass glint reads cleanly in.
     RIDE_YAW is derived from that constraint; the ride direction is
     downstream of it.
   ============================================================ */

import { SEA } from '../core/palette.js';
/* ONE BICYCLE IN THE GAME, NOT TWO. See createBicycle at the foot of
   this file for why the intro's private model is gone. */
import { createBike } from '../character/bike.js';

/* 54 bpm, 4/4 — one bar of SCORES.cinematic in src/audio/music.js. */
export const BAR = 4 * 60 / 54;          // 4.4444 s

export const TIMING = {
  sea:      0 * BAR,                     //  0.000
  island:   2.5 * BAR,                   // 11.111
  arrival:  4.5 * BAR,                   // 20.000
  hero:     6.0 * BAR,                   // 26.667
  title:    7.0 * BAR,                   // 31.111
  end:      7.8 * BAR,                   // 34.667
};

/* He faces this bearing when he stops. Solved in the header note:
   it is the ride direction that puts the dawn sun on the camera's
   left in the hero shot. */
export const RIDE_YAW = -0.349;

const RIDE = {
  yaw: RIDE_YAW,
  dist: 24.5,                            // metres of road he covers
  t0: 19.30,                             // rolls into shot before the cut
  brake: TIMING.hero - 1.25,
  stop: TIMING.hero,
};
/* v * ( (brake - t0) + 0.5 * brakeTime ) = dist */
RIDE.speed = RIDE.dist / ((RIDE.brake - RIDE.t0) + 0.5 * (RIDE.stop - RIDE.brake));

/* Metres of road behind him at time t (0 at t0, dist at stop). */
export function ridePath(t) {
  if (t <= RIDE.t0) return 0;
  if (t >= RIDE.stop) return RIDE.dist;
  const cruise = RIDE.speed * (RIDE.brake - RIDE.t0);
  if (t <= RIDE.brake) return RIDE.speed * (t - RIDE.t0);
  const b = t - RIDE.brake;
  const bt = RIDE.stop - RIDE.brake;
  return cruise + RIDE.speed * b * (1 - b / (2 * bt));
}
/** Ride speed in m/s at time t — drives pedal cadence and wheel spin. */
export function rideSpeed(t) {
  if (t <= RIDE.t0 || t >= RIDE.stop) return 0;
  if (t <= RIDE.brake) return RIDE.speed;
  return RIDE.speed * (1 - (t - RIDE.brake) / (RIDE.stop - RIDE.brake));
}
export { RIDE };

/* ------------------------------------------------------------------
   THE STAGE — chosen against the world that is actually there.

   RIDE_YAW is solved for the light and the spawn is chosen by the
   game, but the city is built by another agent and moves under this
   one. On the build this was written against, Wally spawns 3 m from
   `marketsq.infill.wall`: a blank stucco slab taller than the frame.
   No rotation fixes that — every camera 7 m from him either has the
   wall beside the lens or has it filling the backdrop.

   So the opener picks its own stage: a small ring search for a clear
   patch near his spawn, and a bearing sweep at that patch. Both are
   scored by casting from his head to each camera position this
   storyboard uses, and by sweeping each hero lens' own fan.

   THE FAN THRESHOLD IS THE SUBJECT'S OWN DEPTH, not a fixed radius.
   A wall 10 m behind him is a backdrop and the f/1.8 cinematic DOF
   will make it a good one; the same wall at 6 m is beside the lens
   and eats a fifth of the frame. A flat "anything within 16 m" rule
   charged the good case MORE than the bad one, because the good one
   fills more rays — which is how the first two attempts at this both
   picked a worse frame than they started with.

   Staying put and staying on the light-solved bearing are both
   preferences, priced in metres and in degrees, so when the city is
   clear around him nothing moves at all.
   ------------------------------------------------------------------ */
const PROBES = [                      // [forward, right, up, fanTheFrame]
  [6.60, 2.28, 1.75, 1], [12.2, 4.20, 2.90, 1],
  [3.50, 11.0, 5.40, 0], [6.00, 26.0, 34.0, 0],
];

/* Horizontal fan across the frame, in radians off the aim axis. The
   hero lens is 32 deg vertical on 16:9, i.e. +/- 0.47 rad horizontal,
   so nine rays put a sample every 0.13 rad — 6 % of frame width. Five
   was not enough: the wall that survived the first fix sat in the gap
   between the 0.25 and 0.50 samples and still took a fifth of the
   frame. */
const FAN = [-0.52, -0.39, -0.26, -0.13, 0, 0.13, 0.26, 0.39, 0.52];
const FAN_COARSE = [-0.45, -0.15, 0.15, 0.45];

function scoreYaw(ctx, anchor, yaw, fanRays) {
  const cast = ctx.phys?.raycast;
  const ground = ctx.world?.heightAt;
  const T = ctx.THREE;
  const eye = _eye.set(anchor.x, anchor.y + 1.20, anchor.z);
  const p = _p, d = _d;
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  const rx = -fz, rz = fx;
  let s = 0;
  void T;

  for (const [a, b, h, fan] of PROBES) {
    p.set(anchor.x + fx * a + rx * b, anchor.y + h, anchor.z + fz * a + rz * b);
    d.subVectors(p, eye);
    const len = d.length() || 1;
    d.divideScalar(len);
    if (cast) {
      const hit = cast(eye, d, len);
      if (hit) s += 5.0 * (1 - hit.distance / len);   // blocked, and how early
    }
    if (ground && p.y < ground(p.x, p.z) + 0.5) s += 4.0;

    if (!cast || !fan) continue;
    const ax = anchor.x - p.x, az = anchor.z - p.z;
    const al = Math.hypot(ax, az) || 1;
    const near = al + 2.5;
    for (const o of fanRays) {
      const c = Math.cos(o), sn = Math.sin(o);
      d.set((ax * c - az * sn) / al, 0, (ax * sn + az * c) / al);
      const hit = cast(p, d, near);
      if (hit) s += 3.5 * Math.max(0, 1 - hit.distance / near);
    }
  }

  /* The road he rides in on: flat enough, and nothing across it. */
  for (let i = 1; i <= 4; i++) {
    const t = (i / 4) * RIDE.dist;
    const x = anchor.x - fx * t, z = anchor.z - fz * t;
    if (ground && Math.abs(ground(x, z) - anchor.y) > 4.5) s += 1.1;
  }
  if (cast) {
    d.set(-fx, 0, -fz);
    const hit = cast(eye, d, RIDE.dist);
    if (hit) s += 3.0 * (1 - hit.distance / RIDE.dist);
  }
  return s;
}

let _eye = null, _p = null, _d = null, _c = null;

/**
 * Pick where the last two sequences are staged.
 * @returns {{anchor: Vector3, yaw: number, moved: number, score: number}}
 */
export function chooseStage(ctx, spawn) {
  const T = ctx?.THREE;
  const fallback = () => ({
    anchor: (T ? new T.Vector3(spawn.x, spawn.y, spawn.z) : spawn),
    yaw: RIDE_YAW, moved: 0, score: 0,
  });
  if (!T || (!ctx.phys?.raycast && !ctx.world?.heightAt)) return fallback();

  _eye = _eye || new T.Vector3();
  _p = _p || new T.Vector3();
  _d = _d || new T.Vector3();
  _c = _c || new T.Vector3();

  const ground = ctx.world?.heightAt;
  const shore = ctx.world?.shoreDistAt;
  const slope = ctx.world?.slopeAt;

  let best = null;
  for (const rad of [0, 11, 19, 27]) {
    const spokes = rad === 0 ? 1 : 8;
    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * Math.PI * 2;
      const x = spawn.x + Math.sin(a) * rad;
      const z = spawn.z + Math.cos(a) * rad;
      const y = ground ? ground(x, z) : spawn.y;
      /* Dry land, gentle ground, well inside the shoreline.
         world.shoreDistAt is metres INLAND (positive), not the signed
         ellipse SDF from data.js — reading it the other way round
         rejected every candidate and silently fell back. */
      if (y < 1.2) continue;
      if (shore && shore(x, z) < 30) continue;
      if (slope && slope(x, z) > 0.42) continue;

      _c.set(x, y, z);
      let s = rad * 0.055;                            // prefer his own spawn
      let bestYaw = RIDE_YAW, bestYawScore = Infinity;
      for (let k = -9; k <= 9; k++) {                 // coarse, 20 deg steps
        const yaw = RIDE_YAW + k * (Math.PI / 9);
        const q = scoreYaw(ctx, _c, yaw, FAN_COARSE) + Math.abs(k) * 0.44;
        if (q < bestYawScore) { bestYawScore = q; bestYaw = yaw; }
      }
      s += bestYawScore;
      if (!best || s < best.score) {
        best = { x, y, z, yaw: bestYaw, score: s, moved: rad };
      }
    }
  }
  if (!best) return fallback();

  /* Refine the bearing at the chosen patch with the full fan. */
  _c.set(best.x, best.y, best.z);
  let yaw = best.yaw, yawScore = Infinity;
  for (let k = -6; k <= 6; k++) {
    const y2 = best.yaw + k * (Math.PI / 36);         // 5 deg steps
    const q = scoreYaw(ctx, _c, y2, FAN) + Math.abs(k) * 0.10;
    if (q < yawScore) { yawScore = q; yaw = y2; }
  }

  return {
    anchor: new T.Vector3(best.x, best.y, best.z),
    yaw, moved: best.moved, score: +yawScore.toFixed(2),
  };
}

/* ------------------------------------------------------------------
   The storyboard. `anchor` is where Wally is standing when the intro
   starts — the shots are built around it, so the cinematic always
   delivers him to his real gameplay spawn and control is handed over
   without a teleport.
   ------------------------------------------------------------------ */
export function storyboard(anchor, ground, yaw = RIDE_YAW) {
  const W = anchor;
  const y = (dx, dz) => (ground ? ground(W.x + dx, W.z + dz) : W.y);

  const f = { x: Math.sin(yaw), z: Math.cos(yaw) };                  // his forward
  const r = { x: -f.z, z: f.x };                                     // his right

  /* Point at W + forward*a + right*b + up*h. */
  const P = (a, b, h) => [W.x + f.x * a + r.x * b, W.y + h, W.z + f.z * a + r.z * b];
  /* Where he is at director time t, plus `h` metres up. */
  const at = (t, h) => {
    const back = RIDE.dist - ridePath(t);
    return [W.x - f.x * back, W.y + h, W.z - f.z * back];
  };

  return {
    f, r, yaw, anchor: W, groundY: y,

    /* ---------------- SEQ A — the sea ----------------
       Low, slow, and almost nothing happens. 39 m of drift over 11 s
       is a boat's idle, not a camera move: the frame is carried by
       the water, the glitter path and the gulls. ART_DIRECTION 7
       forbids a static frame; it does not forbid a patient one. */
    sea: {
      name: 'sea',
      fog: [230, 2100],
      grade: 'golden',
      opts: { handheld: 0.36, letterbox: true, tension: 0.5 },
      shots: [
        { position: [704, 2.52, 336], target: [-1500, 62, 206], fov: 42,
          dof: { aperture: 6.2, focus: 215 }, duration: 4.2, ease: 'linear' },
        { position: [686, 2.38, 328], target: [-1500, 60, 203], fov: 41,
          dof: { aperture: 6.2, focus: 200 }, duration: 4.2, ease: 'cubicOut' },
        { position: [666, 2.24, 318], target: [-1500, 58, 200], fov: 40,
          dof: { aperture: 5.8, focus: 190 }, duration: 3.0, ease: 'hold' },
      ],
    },

    /* ---------------- SEQ B — the island ----------------
       A crane up and back. B0 and B1 carry equal durations on
       purpose: ease 'in' ends at parameter rate 1/dur and ease 'out'
       starts at 1/dur, so the two segments join with no acceleration
       seam and the whole climb reads as one gesture that accelerates
       off the water and settles at the apex. */
    island: {
      name: 'island',
      fog: [260, 2600],
      grade: 'golden',
      opts: { handheld: 0.20, letterbox: true, tension: 0.42 },
      shots: [
        { position: [334, 9.5, 436], target: [176, 18, 250], fov: 46,
          dof: { aperture: 5.0, focus: 170 }, duration: 3.0, ease: 'in' },
        { position: [392, 118, 512], target: [40, 22, 70], fov: 50,
          dof: { aperture: 4.0, focus: 340 }, duration: 3.0, ease: 'out' },
        { position: [462, 292, 608], target: [-70, 20, -70], fov: 52,
          dof: { aperture: 3.4, focus: 560 }, duration: 2.889, ease: 'hold' },
      ],
    },

    /* ---------------- SEQ C — the arrival ----------------
       The aim points are where he WILL be, so the camera tracks a
       moving subject with a static spline. Drops 34 m to 2 m while
       closing from 50 m to 8: the descent and the approach are the
       same move. */
    arrival: {
      name: 'arrival',
      fog: [110, 900],
      grade: 'day',
      opts: { handheld: 0.30, letterbox: true, tension: 0.5 },
      shots: [
        { position: P(6.0, 26.0, 34.0), target: at(TIMING.arrival, 1.15), fov: 42,
          dof: { aperture: 4.6, focus: 52 }, duration: 3.333, ease: 'in' },
        { position: P(3.5, 11.0, 5.4), target: at(TIMING.arrival + 3.333, 1.15), fov: 38,
          dof: { aperture: 6.0, focus: 18 }, duration: 3.334, ease: 'out' },
        { position: P(2.2, 7.5, 2.3), target: [W.x, W.y + 1.10, W.z], fov: 36,
          dof: { aperture: 6.6, focus: 8.4 }, duration: 1.2, ease: 'hold' },
      ],
    },

    /* ---------------- SEQ D — the hero + the title ----------------
       12.9 m to 7.0 m over exactly one bar, arriving on the downbeat
       the sting is fired on. The framing is solved backwards from the
       title: head at 42 % of frame height, feet at 86 %, which leaves
       the band from 12 % to 41 % — inside the letterbox — empty for
       the lockup. */
    hero: {
      name: 'hero',
      fog: [80, 700],
      grade: 'golden',
      opts: { handheld: 0.42, letterbox: true, tension: 0.5 },
      shots: [
        { position: P(12.2, 4.2, 2.90), target: [W.x, W.y + 1.34, W.z], fov: 33,
          dof: { aperture: 6.2 }, duration: TIMING.title - TIMING.hero, ease: 'smoother' },
        { position: P(6.60, 2.28, 1.75), target: [W.x, W.y + 1.44, W.z], fov: 32,
          dof: { aperture: 7.4 }, duration: 6.0, ease: 'hold' },
      ],
    },
  };
}

/* Director marks for WALLY.debug.introShot(n). Each is a sequence and
   the index of the control point to start that sequence from, so a
   jump lands on that exact framing rather than somewhere along a
   spline between two of them. */
export const MARKS = [
  { n: 0, seq: 'sea',      from: 0, t: TIMING.sea,              label: 'sea — dawn, drifting' },
  { n: 1, seq: 'sea',      from: 1, t: TIMING.sea + 4.2,        label: 'sea — closing on the coast' },
  { n: 2, seq: 'island',   from: 0, t: TIMING.island,           label: 'island — skimming in' },
  { n: 3, seq: 'island',   from: 2, t: TIMING.island + 6.0,     label: 'island — the reveal' },
  { n: 4, seq: 'arrival',  from: 0, t: TIMING.arrival,          label: 'arrival — the descent' },
  { n: 5, seq: 'arrival',  from: 1, t: TIMING.arrival + 3.333,  label: 'arrival — the bicycle' },
  { n: 6, seq: 'hero',     from: 0, t: TIMING.hero,             label: 'hero — the push in' },
  { n: 7, seq: 'hero',     from: 1, t: TIMING.title + 0.70,     label: 'title — WALLY RPG' },
];

/* ==================================================================
   GULLS — the life in the opening frame.

   Wind Waker never shows you an empty sea. Seven birds on two
   distance rings: the near pair sit inside SEQ A's near-focus field
   and read as soft foreground, the far five sit on the focal plane
   and are sharp. That split is what makes a flat water shot read as
   having depth.
   ================================================================== */
export function createGulls(ctx, opts = {}) {
  const T = ctx.THREE;
  const rng = ctx.makeRng ? ctx.makeRng('intro.gulls') : Math.random;
  const count = Math.max(4, Math.round((opts.count ?? 9) * (ctx.quality?.particles ?? 1)));

  const group = new T.Group();
  group.name = 'intro.gulls';

  /* Wing: a long, strongly swept, hard-tapering sheet — span 1.0 to a
     root chord of 0.22, which is the 4.5:1 a gull actually is. The
     first pass used a 1.6:1 stub and at 20 px on screen it read as a
     scrap of paper, not a bird: at this size the SILHOUETTE is the
     whole model and nothing else about it matters.

     The dark primaries are vertex colours multiplying the albedo
     (USE_COLOR in toon.js) rather than a second mesh, so a gull is
     three meshes, not five, and the tip darkens along the span
     instead of stopping at a seam. */
  const wingGeo = (() => {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array([
      0.00, 0, 0.105, 0.00, 0, -0.115,
      0.52, 0, 0.010, 0.52, 0, -0.105,
      1.00, 0, -0.115, 1.00, 0, -0.155,
    ]), 3));
    g.setAttribute('normal', new T.BufferAttribute(new Float32Array([
      0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
    ]), 3));
    g.setAttribute('color', new T.BufferAttribute(new Float32Array([
      1.00, 1.00, 1.00, 1.00, 1.00, 1.00,
      0.93, 0.93, 0.95, 0.88, 0.88, 0.91,
      0.34, 0.35, 0.40, 0.30, 0.31, 0.36,
    ]), 3));
    g.setIndex([0, 2, 1, 1, 2, 3, 2, 4, 3, 3, 4, 5]);
    return g;
  })();

  const bodyGeo = new T.SphereGeometry(0.5, 9, 6);
  bodyGeo.scale(0.105, 0.098, 0.42);

  const featherMat = ctx.mat?.toon
    ? ctx.mat.toon({
        color: SEA.foam, side: T.DoubleSide, vertexColors: true,
        term: 0.10, bandSoft: 0.05, band2: 0.22, rim: 0.62, spec: 0.05,
        grain: 0.25, skyBounce: 0.30, outline: false,
      })
    : new T.MeshLambertMaterial({ color: SEA.foam, side: T.DoubleSide, vertexColors: true });

  const birds = [];
  for (let i = 0; i < count; i++) {
    const b = new T.Group();
    b.add(new T.Mesh(bodyGeo, featherMat));

    for (const s of [-1, 1]) {
      const shoulder = new T.Group();
      shoulder.position.set(0.040 * s, 0.028, 0.03);
      const wing = new T.Mesh(wingGeo, featherMat);
      wing.scale.set(0.62 * s, 1, 1);
      shoulder.add(wing);
      b.add(shoulder);
      b.userData[s < 0 ? 'wingL' : 'wingR'] = shoulder;
    }

    /* Two rings. The near three sit 26-50 m out, inside SEQ A's near
       blur, so they read as soft foreground; the rest sit 70-170 m
       out, on the focal plane, and are sharp. That split is the
       cheapest depth cue there is. */
    const near = i < 3;
    b.userData.p = {
      along: near ? 20 + rng() * 18 : 60 + rng() * 100,
      side: (rng() * 2 - 1) * (near ? 11 : 40),
      up: near ? 4 + rng() * 8 : 7 + rng() * 24,
      flap: 1.7 + rng() * 1.3,
      phase: rng() * 6.283,
      glide: 0.30 + rng() * 0.36,
      drift: 0.5 + rng() * 0.9,
      bob: 0.5 + rng() * 1.1,
      scale: near ? 1.15 + rng() * 0.35 : 1.0 + rng() * 0.3,
    };
    b.scale.setScalar(b.userData.p.scale);
    group.add(b);
    birds.push(b);
  }

  if (ctx.mat?.register) ctx.mat.register(group, { castShadow: false, receiveShadow: false, noOutline: true });
  group.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });

  /* Anchor: the flock is laid out in the opening camera's own frame,
     so it composes against that shot rather than sitting wherever the
     island happens to be. */
  const A = opts.from || [704, 2.5, 336];
  const B = opts.toward || [-1500, 62, 206];
  const ax = B[0] - A[0], ay = B[1] - A[1], az = B[2] - A[2];
  const al = Math.hypot(ax, ay, az) || 1;
  const fx = ax / al, fy = ay / al, fz = az / al;
  const sx = -fz, sz = fx;               // horizontal side vector

  const api = {
    group,
    visible: true,
    update(dt, elapsed) {
      if (!group.visible) return;
      for (const b of birds) {
        const p = b.userData.p;
        /* Slow lateral drift plus a lazy vertical bob; when a gull
           leaves the frame it wraps back in on the other side. */
        p.side += p.drift * dt * (p.phase > 3.14 ? -1 : 1);
        if (p.side > 62) p.side = -62;
        if (p.side < -62) p.side = 62;
        const bob = Math.sin(elapsed * 0.34 + p.phase) * p.bob;

        b.position.set(
          A[0] + fx * p.along + sx * p.side,
          A[1] + fy * p.along + p.up + bob,
          A[2] + fz * p.along + sz * p.side,
        );
        /* Face the way they are drifting, banked into the turn. */
        const dir = p.phase > 3.14 ? -1 : 1;
        b.rotation.set(0, Math.atan2(sx * dir, sz * dir), Math.sin(elapsed * 0.34 + p.phase) * 0.16);

        /* Flap, then glide: a sine that is clipped flat for part of
           the cycle. A pure sine reads as a metronome, not a bird. */
        const ph = elapsed * p.flap + p.phase;
        const raw = Math.sin(ph);
        const g = p.glide;
        const a = raw > g ? (raw - g) / (1 - g) : raw < -g ? (raw + g) / (1 - g) : 0;
        /* A gliding gull holds a shallow dihedral. At -0.14 the wings
           drooped and the silhouette read as a paper scrap; +0.12 is
           the shallow V you actually recognise from below. */
        const beat = a * 0.90 + 0.12;
        b.userData.wingL.rotation.z = -beat;
        b.userData.wingR.rotation.z = beat;
      }
    },
    dispose() {
      group.parent?.remove(group);
      wingGeo.dispose(); bodyGeo.dispose();
      featherMat.dispose?.();
    },
  };
  return api;
}

/* ==================================================================
   THE BICYCLE — and it is now the SAME bicycle the player rides.

   THIS FILE USED TO BUILD ITS OWN. That second model is gone, and its
   removal is the fix for three defects at once rather than a tidy-up:

     * ITS CRANK RAN AT 2.3x ITS OWN RIDER. `crank.rotation.x = spin *
       0.42` derived the pedals from the WHEEL — one crank revolution
       per 5.017 m, measured — while intro.js drove the rider's legs at
       one cycle per 2.198 m. Feet and cranks disagreed by 2.28x for
       the whole of the shot the player sees first.
     * ITS FEET WERE NOWHERE NEAR ITS PEDALS. Its bottom bracket sat at
       y 0.300 with a saddle at 0.920 — 0.620 m of seat-to-crank on an
       animal whose legs are 0.30 H. Measured across the ride shot, the
       left ankle sat 376 mm above the pedal plate and wandered 268 mm.
       It was a bicycle built for someone else.
     * ITS MATERIALS BROKE §1.2. It passed `grain: 0.35` to ctx.mat.toon
       — a normal perturbation of six radians, which scrambles the
       normal outright. bike.js's own header calls that number out by
       name and says do not copy it; this file was where it was copied
       from.

   character/bike.js's model has none of those: SADDLE, BARS and PEDAL
   are MEASURED against this rider (see its header), its wheels roll
   from distance through their own radii, and its crank takes the pedal
   phase straight from the animator. bike.js has said since it was
   written that `createBike` is exported "so the intro can adopt it
   later if its owner wants one bicycle in the game rather than two".
   This is that. Both files are now owned by the same agent, so the
   rename risk that argued for a private copy is gone too.

   WHAT THIS WRAPPER ADDS is the intro's own idiom and nothing else:
   park() here takes a WORLD placement (the intro's bicycle is a scene
   prop, not a child of Wally's root), where the prop's own park() only
   knows about the stand and the lean.

   Forward is +Z, on both models, so `group.rotation.y = yaw` still
   matches the convention data.js uses for every building on the island.
   ================================================================== */
export function createBicycle(ctx) {
  const prop = createBike(ctx);
  prop.group.name = 'intro.bicycle';

  const api = {
    group: prop.group,
    /** Where the rider's pelvis has to land. The intro reads it rather
        than keeping a second copy — that constant getting out of step
        with the frame is exactly how the feet left the pedals. */
    SADDLE: prop.SADDLE,
    PEDAL: prop.PEDAL,
    R: prop.R,

    /** Axle to axle, read off the prop rather than typed in again. */
    wheelbase: prop.wheels.length > 1
      ? Math.abs(prop.wheels[0].position.z - prop.wheels[1].position.z) : 0,

    /** Roll the wheels by `metres` of ground. See bike.js `roll`. */
    roll(metres) { return prop.roll(metres); },

    /** The parked lean and the stand's design contact point, read off
        the prop. parkArrival() hands both to solveParkPose; keeping a
        second copy of either here is how the intro's park solve came to
        be a generation behind the gameplay one. */
    get parkLean() { return prop.parkLean; },
    get standFoot() { return prop.standFoot; },

    /** Take it off the stand — it is being RIDDEN again.
        Only the debug seek needs this: seeking to the hero mark parks
        the machine, and seeking BACK to the ride mark handed it to
        driveCharacter with the kickstand still out and the park lean
        still on the group. A ridden bicycle standing on its stand is
        the same defect as a parked one without. */
    unpark() {
      prop.park(false);
      prop.group.rotation.order = 'XYZ';
      prop.group.rotation.set(0, 0, 0);
    },

    /** Turn the cranks to a pedal phase in radians. The intro takes
        this from the ride clip's own cycle, never from the wheel. */
    setCrankPhase(ph) { prop.setCrankPhase(ph); },

    /**
     * Lean it on its stand at a world placement, pitched `pitch` about
     * its own lateral axis so both wheels touch a sloping stage.
     *
     * ROTATION ORDER IS LOAD-BEARING. Default 'XYZ' composes Rx*Ry*Rz,
     * which applies the pitch OUTSIDE the yaw — about the world x axis
     * — so a bicycle parked facing east would tip sideways instead of
     * nose-up. 'YXZ' gives Ry*Rx*Rz: yaw in the world, pitch about the
     * machine's own lateral axis, and then prop.park()'s lean on z,
     * innermost, about its own forward axis. wally.js's parkProp() sets
     * the same order for the same reason; see the note there, and the
     * measured before/after that made it necessary.
     *
     * @param {number} pitch radians, NEGATIVE for nose-up (three.js Rx
     *        sends (0,0,L) to y = -L sin x, so +z falls on a positive x)
     * @param {number} [roll] radians about its own forward axis. Omit
     *        for the flat-ground lean; parkArrival passes the conformed
     *        roll so the kickstand sits on the ground's cross-slope
     *        rather than on the machine's own contact plane.
     */
    park(x, y, z, yaw, pitch = 0, roll) {
      prop.group.position.set(x, y, z);
      prop.group.rotation.order = 'YXZ';
      prop.group.rotation.set(Number.isFinite(pitch) ? pitch : 0, yaw, 0);
      prop.park(true, roll);
    },

    dispose() { prop.dispose(); },
  };
  return api;
}

export default { storyboard, MARKS, TIMING, BAR, createGulls, createBicycle };
