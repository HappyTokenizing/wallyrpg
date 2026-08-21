/* ============================================================
   bike.js — Wally's bicycle. A PROP, owned by the character layer.

   WHY IT LIVES HERE AND NOT IN world/ OR intro/
   ---------------------------------------------
   It is only ever in the frame when Wally is, it is parented under his
   root so it inherits his yaw and his lean, and its saddle height is a
   contract with a bone in rig.js. That makes it part of the character,
   not part of the city.

   WHAT IT REUSES. src/intro/shots.js already builds a bicycle for the
   opening flight, and src/character/anim.js already has the
   'ride-bicycle' clip the intro drives. The CLIP is shared verbatim —
   this module does not add a second riding animation, it extends the
   existing one into a locomotion ladder. The MODEL is rebuilt here for
   three reasons the intro's could not satisfy:

     * ART_DIRECTION §5 asks for chunky, rounded, matte forms in the
       same painted / weathered-wood vocabulary as the world. The
       intro's bike is a wire-thin diagram — 30 mm tubes, box spokes,
       a 7-segment torus tyre — because it is only ever seen from
       twelve metres in a moving shot. This one is looked at from the
       follow camera at four metres, all day.
     * It has to sit under a SPECIFIC pelvis. SADDLE, BARS and PEDAL
       below are published so wally.js can lift the skeleton onto them
       instead of guessing, and so the numbers can be checked.
     * intro/shots.js belongs to another agent. Importing it would make
       the whole game fail to boot the moment they rename an export.

   `createBike` is exported so the intro can adopt it later if its owner
   wants one bicycle in the game rather than two.

   GEOMETRY BUDGET: ~1 900 triangles, 11 draw calls, five materials, all
   of them shared across the two wheels. Built once at boot, hidden
   until the player owns and equips it.

   FORWARD IS +Z, matching Wally's root and every building on the
   island. Origin is on the ground directly under the bottom bracket.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { BUILD, LAND, BRAND } from '../core/palette.js';

/* ------------------------------------------------------------------
   THE THREE NUMBERS ANOTHER MODULE IS ALLOWED TO DEPEND ON.

   SADDLE.y is where the hips bone has to end up. wally.js reads it,
   measures where the ride clip actually puts the pelvis, and lifts the
   skeleton's root bone by the difference — so if this frame is ever
   re-proportioned, the rider follows it without a second number being
   edited anywhere.
   ------------------------------------------------------------------ */
/* MEASURED OFF THE RIDER, NOT CHOSEN. WALLY.debug.bikeInfo() reports
   where his hips, feet and hands actually are in the riding pose, in
   root-local metres; these are those numbers. At the shipped tuning the
   ankle sits within 22 mm of the pedal through the whole stroke and the
   grips are under the mittens, which is the difference between a rider
   and a man hovering near a bicycle.

   THE BARS ARE SWEPT BACK, and that is a consequence rather than a
   style choice: his arms are 0.30 H long on a body with a head-ball
   0.348 H across, so his hands come to rest 0.90 m up and only 0.35 m
   forward. A bar that reached out to the head tube would need arms he
   does not have. Swept-back bars — a Dutch city bike — put the grips
   exactly where the hands already are, and they suit the front basket,
   the upright back and the whole shape of the animal. */
export const SADDLE = { x: 0, y: 0.465, z: -0.075 };
export const BARS = { x: 0.352, y: 0.882, z: 0.278 };
export const PEDAL = { y: 0.215, z: 0.030, r: 0.078 };

const R = 0.225;             // wheel radius, tyre included
const BASE = 0.94;           // axle to axle
const AXZ = BASE * 0.5;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export function createBike(ctx, opts = {}) {
  const T = THREE;
  const group = new T.Group();
  group.name = 'wally.bike';
  const owned = [];
  const mats = [];

  /* ================================================================
     Materials — §5's five, three of which apply here.

     PAINTED for the frame (it is a manufactured, painted object, same
     family as a shutter or a market stall), WEATHERED WOOD for the
     saddle and the basket, and a matte near-black rubber for the tyres
     that is NOT pure black (§7).

     GRAIN. toon.js delivers the normal perturbation as `uGrain * 34`,
     so these are amplitudes in units of 1/34: 0.0011 * 34 = 0.037 on
     the frame, a fine paint tooth you can see at a 2x crop and not at
     four metres. The intro's bicycle passes 0.35 here, which is a
     perturbation of six radians — it scrambles the normal outright.
     Do not copy that number.

     OUTLINED, unlike Wally. §2.2 puts the inverted-hull stroke on world
     geometry and §1.2 forbids it on the clay; a bicycle is a made
     object, so it takes the stroke and the character it carries does
     not. That contrast is also what stops the two fusing into one grey
     mass in the follow camera.
     ================================================================ */
  const paint = (color, o = {}) => {
    const m = ctx.mat.toon({
      name: 'bike.paint',
      color,
      term: 0.17, bandSoft: 0.075, band2: 0.13,
      spec: 0.16, specPow: 30, specBanded: true,
      rim: 0.34,
      skyBounce: 0.16,
      grain: 0.0011, grainScale: 21, grainAlbedo: 0.055, grainShade: 0.16,
      grainFade: [26, 96],
      outline: true, outlineWidth: 3.0,
      ...o,
    });
    mats.push(m);
    return m;
  };

  const frameMat = paint(BRAND.token, { name: 'bike.frame' });
  const metalMat = paint(BUILD.metal, {
    name: 'bike.metal', spec: 0.30, specPow: 40, specBanded: true, rim: 0.46,
    grain: 0.0006, grainScale: 26, grainAlbedo: 0.035,
  });
  /* §7: never pure black. #3a3c41 through the shade law still reads as
     rubber and never bottoms out. */
  const tyreMat = paint(LAND.rockShade, {
    name: 'bike.tyre', color: 0x3a3c41,
    spec: 0.05, specPow: 14, rim: 0.22,
    grain: 0.0016, grainScale: 30, grainAlbedo: 0.070, grainShade: 0.22,
  });
  const woodMat = ctx.mat.wood
    ? ctx.mat.wood({ name: 'bike.saddle', color: BUILD.woodDark, outline: true, outlineWidth: 3.0 })
    : paint(BUILD.woodDark, { name: 'bike.saddle' });
  const basketMat = ctx.mat.wood
    ? ctx.mat.wood({ name: 'bike.basket', color: BUILD.wood, woodScale: 2.2, outline: true, outlineWidth: 3.0 })
    : paint(BUILD.wood, { name: 'bike.basket' });
  if (ctx.mat.wood) { mats.push(woodMat, basketMat); }

  /* ================================================================
     One capsule, re-oriented per tube. CHUNKY AND ROUNDED IS THE
     WHOLE BRIEF: a cylinder ends in a flat disc and every joint in
     the frame then shows a visible polygon cap (§7). A capsule ends
     in a hemisphere, so two tubes meeting at an angle blend into a
     soft knuckle without a fillet, which is exactly how the world's
     posts and railings are built.
     ================================================================ */
  const capCache = new Map();
  function capsuleGeo(r, len) {
    const key = `${r.toFixed(3)}|${len.toFixed(3)}`;
    let g = capCache.get(key);
    if (!g) {
      g = new T.CapsuleGeometry(r, Math.max(len - r * 2, 0.001), 3, 10);
      owned.push(g);
      capCache.set(key, g);
    }
    return g;
  }

  function tube(parent, a, b, r, mat) {
    _a.fromArray(a); _b.fromArray(b);
    _d.subVectors(_b, _a);
    const len = _d.length();
    const m = new T.Mesh(capsuleGeo(r, len), mat);
    m.position.copy(_a).addScaledVector(_d, 0.5);
    m.quaternion.setFromUnitVectors(UP, _d.normalize());
    parent.add(m);
    return m;
  }

  /* ================================================================
     Wheels — fat, soft-shouldered, five chunky spokes.

     THE TYRE IS A THICK TORUS, NOT A HOOP. 72 mm of section on a
     315 mm wheel is a balloon tyre: it reads as one rounded volume at
     any distance, it catches the terminator across its section the way
     every other rounded form in the game does, and it survives being
     four pixels tall in a vista. A 46 mm hoop at seven radial segments
     — the intro's — is a wire ring that aliases into dashes.
     ================================================================ */
  const tyreGeo = new T.TorusGeometry(R - 0.058, 0.058, 9, 26);
  const rimGeo = new T.TorusGeometry(R - 0.122, 0.026, 6, 22);
  const hubGeo = new T.CapsuleGeometry(0.042, 0.048, 3, 10);
  owned.push(tyreGeo, rimGeo, hubGeo);

  const wheels = [];
  for (const s of [1, -1]) {
    const w = new T.Group();
    w.position.set(0, R, s * AXZ);
    const tyre = new T.Mesh(tyreGeo, tyreMat);
    tyre.rotation.y = Math.PI / 2;
    const rim = new T.Mesh(rimGeo, metalMat);
    rim.rotation.y = Math.PI / 2;
    const hub = new T.Mesh(hubGeo, metalMat);
    hub.rotation.z = Math.PI / 2;
    w.add(tyre, rim, hub);
    const sr = R - 0.122;
    for (let i = 0; i < 5; i++) {
      const sp = new T.Mesh(capsuleGeo(0.015, sr * 2), metalMat);
      sp.rotation.x = (i / 5) * Math.PI;
      w.add(sp);
    }
    group.add(w);
    wheels.push(w);
  }

  /* ================================================================
     Frame. A step-through loop, not a diamond: it is rounder, it is
     what a city bike is, and it leaves the space between saddle and
     bars empty so the RIDER reads instead of a lattice of tubes in
     front of his belly.
     ================================================================ */
  const BB = [0, PEDAL.y, PEDAL.z];
  const CROWN = [0, 0.318, 0.392];               // fork crown / bottom of head tube
  /* A SLACK HEAD ANGLE — the tube leans BACK as it rises and the fork
     rakes forward from the crown. That is what a city bike does, and
     here it is also what lets the bar centre sit at z 0.330 (where a
     stem can reach it) while the front axle is out at 0.470 (where the
     wheelbase needs it). A vertical head tube would have put the stem
     behind its own steerer. */
  const HEAD_HI = [0, 0.742, 0.338];             // top of head tube
  const BAR_C = [0, BARS.y, BARS.z + 0.055];     // bar centre, ahead of the grips
  const SEAT_HI = [SADDLE.x, SADDLE.y - 0.042, SADDLE.z];
  const KNEE = [0, 0.415, 0.170];                // the step-through's low point
  const RAX = [0, R, -AXZ];
  const FAX = [0, R, AXZ];

  tube(group, BB, CROWN, 0.042, frameMat);                   // down tube, fat
  tube(group, CROWN, HEAD_HI, 0.038, frameMat);              // head tube
  /* The step-through curve, in two segments so it is a CURVE and not a
     diagonal. It is what makes the frame read as a rounded loop rather
     than a triangle of sticks, and it leaves the space in front of his
     belly empty so the RIDER is the silhouette. */
  tube(group, SEAT_HI, KNEE, 0.036, frameMat);
  tube(group, KNEE, [0, 0.600, 0.372], 0.036, frameMat);
  tube(group, BB, SEAT_HI, 0.040, frameMat);                 // seat tube
  for (const s of [-1, 1]) {
    tube(group, [CROWN[0] + s * 0.014, CROWN[1] + 0.020, CROWN[2] + 0.004],
      [FAX[0] + s * 0.050, FAX[1], FAX[2]], 0.026, frameMat);            // fork
    tube(group, [RAX[0] + s * 0.054, RAX[1], RAX[2]], SEAT_HI, 0.022, frameMat);  // seat stay
    tube(group, [RAX[0] + s * 0.054, RAX[1], RAX[2]], BB, 0.025, frameMat);       // chain stay
  }

  /* Mudguards — the single most Wind-Waker silhouette on the object,
     and the thing that stops the wheels reading as two bare rings. */
  {
    const g = new T.TorusGeometry(R + 0.026, 0.028, 5, 15, Math.PI * 0.78);
    owned.push(g);
    for (const s of [1, -1]) {
      const m = new T.Mesh(g, frameMat);
      m.position.set(0, R, s * AXZ);
      m.rotation.y = Math.PI / 2;
      /* The arc starts at +x of the torus's own plane, which after the
         y-rotation is +z (forward). Roll it back so the guard sits over
         the TOP of the wheel and trails behind it. */
      m.rotation.x = Math.PI * (s > 0 ? 0.16 : 0.38);
      group.add(m);
    }
  }

  /* ================================================================
     Bars, grips and the bell.
     ================================================================ */
  tube(group, HEAD_HI, BAR_C, 0.028, metalMat);              // stem
  for (const s of [-1, 1]) {
    /* The sweep, in two segments: straight out from the stem, then a
       bend back toward the rider. A single straight bar would put the
       grip 50 mm in front of the mitten and 80 mm outboard of it. */
    tube(group, BAR_C, [s * 0.205, BARS.y + 0.010, BARS.z + 0.046], 0.024, metalMat);
    tube(group, [s * 0.205, BARS.y + 0.010, BARS.z + 0.046],
      [s * (BARS.x - 0.010), BARS.y, BARS.z - 0.022], 0.024, metalMat);
    /* Rubber grips: fatter than the bar, so the mitten has something to
       close around and the bar end is never a flat disc. */
    const grip = new T.Mesh(capsuleGeo(0.040, 0.140), tyreMat);
    grip.position.set(s * (BARS.x - 0.020), BARS.y + 0.002, BARS.z + 0.004);
    grip.rotation.z = Math.PI / 2;
    grip.rotation.y = s * 0.22;
    group.add(grip);
  }
  {
    /* The bell. One small dome and the object stops being a bicycle in
       general and becomes his. */
    const g = new T.SphereGeometry(0.048, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.60);
    owned.push(g);
    const bell = new T.Mesh(g, frameMat);
    /* On his LEFT bar. On the right it lands over his face in every
       side-on shot, which is where the drivetrain is photographed. */
    bell.position.set(-(BARS.x - 0.135), BARS.y + 0.026, BARS.z + 0.026);
    group.add(bell);
  }

  /* ================================================================
     Saddle — a rounded wedge, wide at the back, nosed forward.
     ================================================================ */
  {
    const g = new T.SphereGeometry(0.5, 14, 10);
    g.scale(0.108, 0.052, 0.190);
    /* Pull the nose in so it is a saddle and not an egg. */
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const z = p.getZ(i);
      if (z > 0) {
        const k = 1 - Math.min(z / 0.095, 1) * 0.62;
        p.setX(i, p.getX(i) * k);
      }
    }
    g.computeVertexNormals();
    owned.push(g);
    const saddle = new T.Mesh(g, woodMat);
    saddle.position.set(SADDLE.x, SADDLE.y - 0.018, SADDLE.z);
    saddle.rotation.x = -0.07;
    group.add(saddle);
    /* seat post — without it the saddle floats off the top of the
       seat tube, which is the first thing the eye finds */
    tube(group, [SADDLE.x, SADDLE.y - 0.100, SADDLE.z],
      [SADDLE.x, SADDLE.y - 0.026, SADDLE.z], 0.028, metalMat);
  }

  /* ================================================================
     Crank and pedals. The arms are 180 degrees apart so the two feet
     in `ride-bicycle` — which pedal in antiphase — land on them.
     ================================================================ */
  /* THE CHAINLINE IS WIDE ON PURPOSE. A real crank sits 75 mm off the
     centre-line; Wally's legs hang at x 0.134-0.150 because his thighs
     are as thick as his shins are long. Setting the arms at 0.075 puts
     the pedals 70 mm INBOARD of his feet, and from the side camera —
     the one that shows the drivetrain — that reads as feet hovering
     beside the pedals rather than on them. 0.108, with the pedal plate
     itself offset a further 0.028 outboard, lands the tread under the
     measured foot. It is a toy: the cranks are allowed to be as wide as
     the animal. */
  const crank = new T.Group();
  crank.position.set(BB[0], BB[1], BB[2]);
  tube(crank, [-0.100, 0, 0], [0.100, 0, 0], 0.028, metalMat);
  {
    const g = new T.TorusGeometry(0.086, 0.015, 5, 18);
    owned.push(g);
    const ring = new T.Mesh(g, metalMat);
    ring.rotation.y = Math.PI / 2;
    ring.position.x = 0.112;
    crank.add(ring);
  }
  for (const s of [-1, 1]) {
    const arm = new T.Group();
    arm.position.set(s * 0.108, 0, 0);
    /* The two arms are 180 degrees apart, and the LEFT one is at
       rotation 0 because bikeBody() gives the left leg pedal phase 0,
       whose bottom-of-stroke is the crank hanging straight down. */
    arm.rotation.x = s > 0 ? 0 : Math.PI;
    tube(arm, [0, 0, 0], [0, -PEDAL.r, 0], 0.022, metalMat);
    const g = new T.BoxGeometry(0.070, 0.026, 0.112);
    owned.push(g);
    const pedal = new T.Mesh(g, woodMat);
    pedal.position.set(s * 0.028, -PEDAL.r - 0.014, 0);
    arm.add(pedal);
    crank.add(arm);
  }
  group.add(crank);

  /* ================================================================
     The front basket — the detail that makes it HIS bike and not a
     bike. A tapered open drum with a rolled rim: rounded, chunky, and
     it silhouettes as one shape instead of five thin panels.
     ================================================================ */
  {
    const basket = new T.Group();
    basket.position.set(0, 0.596, 0.468);
    const wall = new T.CylinderGeometry(0.148, 0.122, 0.198, 14, 1, true);
    const floor = new T.CylinderGeometry(0.122, 0.122, 0.022, 14);
    const rim = new T.TorusGeometry(0.148, 0.020, 5, 16);
    owned.push(wall, floor, rim);
    const w = new T.Mesh(wall, basketMat);
    /* An open drum has to show its inside too. A mirrored second copy
       is one extra draw of 28 triangles and keeps the shared material
       single-sided, which the outline hull pass needs. */
    const wm = new T.Mesh(wall, basketMat);
    wm.scale.set(-1, 1, 1);
    const f = new T.Mesh(floor, basketMat);
    f.position.y = -0.088;
    const r = new T.Mesh(rim, frameMat);
    r.position.y = 0.099;
    r.rotation.x = Math.PI / 2;
    basket.add(w, wm, f, r);
    basket.rotation.x = -0.10;
    group.add(basket);
    /* two chunky struts down to the fork crown, so it is CARRIED and
       not floating — the thing that reads wrong about every basket
       nobody bothered to hang */
    for (const s of [-1, 1]) {
      tube(group, [s * 0.096, 0.520, 0.472], [s * 0.024, 0.348, 0.392], 0.016, metalMat);
    }
    /* and a hanger back to the head tube */
    tube(group, [0, 0.660, 0.436], [0, 0.700, 0.348], 0.018, metalMat);
  }

  /* Kickstand — only visible when parked. A bike standing on two
     wheels with nothing under it reads as falling over. */
  const stand = tube(group, [-0.048, 0.205, -0.085], [-0.190, 0.006, -0.190], 0.019, metalMat);
  stand.visible = false;

  if (ctx.mat.register) ctx.mat.register(group, { castShadow: true, receiveShadow: true });
  /* Nothing here is frustum-culled on its own: the group rides Wally's
     root and his bounding sphere already covers it, and a wheel that
     pops out at the frame edge is a worse defect than a draw call. */
  group.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });

  let spin = 0;
  const api = {
    group,
    SADDLE, BARS, PEDAL,
    wheels, crank, stand,

    /** Roll the wheels and turn the cranks for `speed` metres/second.
        The crank ratio is the intro's: one revolution per 2.6 m, which
        is also `CLIPS['ride-bicycle'].cycle`, so the pedals under his
        feet and the feet themselves cannot drift apart. */
    update(dt, speed) {
      const v = Number.isFinite(speed) ? speed : 0;
      spin += (v * dt) / R;
      if (!Number.isFinite(spin)) spin = 0;
      for (const w of wheels) w.rotation.x = spin;
      crank.rotation.x = (spin * R) / 2.6 * Math.PI * 2;
      return crank.rotation.x;
    },

    /** Drive the cranks straight from the animator's pedal phase so the
        pedal is always under the foot, whatever the blend is doing. */
    setCrankPhase(ph) {
      crank.rotation.x = ph;
    },

    /** Lean it on its stand, as a parked prop. */
    park(on = true) {
      stand.visible = !!on;
      group.rotation.z = on ? -0.14 : 0;
      if (on) crank.rotation.x = 1.15;
    },

    dispose() {
      group.parent?.remove(group);
      for (const g of owned) g.dispose();
      for (const m of mats) m.dispose?.();
      capCache.clear();
    },
  };

  return api;
}

export default createBike;
