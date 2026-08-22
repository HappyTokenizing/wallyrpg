/* ============================================================
   rides.js — the SCOOTER and the MOTORCYCLE.

   bike.js builds the bicycle and explains why a vehicle Wally sits on
   belongs to the character layer rather than to world/: it is only ever
   in frame when he is, it is parented under his root so it inherits his
   yaw and his bank for free, and its seat height is a contract with a
   bone. All of that is true three times over now. This file is the
   other two machines; everything structural in bike.js's header applies
   here unchanged.

   WHAT ACTUALLY HAD TO BE DIFFERENT
   ---------------------------------
   The brief for an upgrade the player worked for is a SILHOUETTE brief.
   A scooter that is a bicycle with a fairing, or a motorcycle that is a
   scooter with bigger wheels, fails the moment it is forty metres away
   and eleven pixels tall — which is where the player spends most of
   their time looking at it. So each machine is built around one
   dominant mass that the other two do not have at all:

     bicycle      a BASKET over a thin open lattice. Air everywhere:
                  you can see the road through the frame.
     scooter      a LEG SHIELD. One broad continuous panel from the
                  deck to the bars, and a fat rear body. Almost no air
                  below the seat, and a rider whose feet are on a floor.
     motorcycle   a TANK and an ENGINE. The mass is in the MIDDLE, low
                  and long, the wheels are half again as big, and the
                  rider is folded down over the top of it.

   Filled black at 24 px those three are a comb, a slab and a barbell.
   That is the test this file is written against, and `shots/c-sil.png`
   is it run for real.

   FITTED, NOT CHOSEN. anim.js publishes SCOOT_SEAT and MOTO_SEAT — the
   pelvis offset, the ankle station and the shoulder angles it poses the
   skeleton with. RIDE_FIT below reads those records and derives the
   deck height, the peg station and the seat top FROM them, so the
   footrest cannot drift away from the foot when a posture is re-tuned:
   there is one number and the prop is downstream of it. What CANNOT be
   derived is the bar position, because the arm is short and abducted
   and the reach saturates (see bike.js's BARS note) — so the grips are
   MEASURED off the posed skeleton with WALLY.debug.rideInfo() and
   written into BARS below as the answer.

   FORWARD IS +Z. Origin on the ground under the seat's own centre-line,
   same as the bicycle.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { BUILD, LAND, BRAND, CATEGORY, CLAY } from '../core/palette.js';
import { SCOOT_SEAT, MOTO_SEAT } from './anim.js';

/* ------------------------------------------------------------------
   THE FIT, AND WHY IT IS MEASURED RATHER THAN DERIVED.

   The first pass computed every station from the seat records above:
   sole = footY - boot, seat top = 0.524 + dy - sit. It came out 30 to
   56 mm wrong on every one of them, in the same direction, and the
   reason is instructive. A pose is not the sum of its authored angles.
   breathe() writes a position offset onto spine and chest on every
   frame of every clip, expression.js writes another, the hips carry a
   girth scale, and the whole chain compounds — so the pelvis lands
   about 24 mm below where the seat record says it should and the ankle,
   hanging off the pelvis, follows it down and then some.

   So these are READINGS, not arithmetic. Each one is
   WALLY.debug.rideInfo() with the posture live, in root-local metres,
   averaged across the breath, minus the standing height of the bone
   from the ground (ankle 0.128, hip 0.524). The derivation is left in
   the comments as the sanity check it is, and the number that ships is
   the one the rig actually produced.

     scooter   ankle 0.293 -> sole 0.165   hips 0.482 -> seat 0.411
     moto      ankle 0.352 -> sole 0.224   hips 0.520 -> seat 0.449

   SIT is the other half of that: on the bicycle the pelvis measures
   0.536 over a 0.465 saddle, so a seated figure of this build compresses
   71 mm into any seat. That one IS transferable and it is used below.
   ------------------------------------------------------------------ */
const ANKLE_STAND = 0.128;    // the foot bone's height when he stands
const SIT = 0.071;            // measured on the bicycle: hips 0.536, saddle 0.465

export const RIDE_FIT = {
  scooter: {
    deckY: 0.165,             // measured sole; footY - ANKLE_STAND would say 0.190
    deckZ: 0.122,             // measured; SCOOT_SEAT.footZ says 0.112
    seatY: 0.482 - SIT,       // 0.411
    seatZ: SCOOT_SEAT.dz,
    footX: 0.130,
  },
  motorcycle: {
    pegY: 0.224,              // measured sole
    pegZ: -0.310,             // measured; MOTO_SEAT.footZ says -0.285
    seatY: 0.520 - SIT,       // 0.449
    seatZ: MOTO_SEAT.dz,
    footX: 0.166,
  },
};

/* THE BARS GO TO THE HANDS, NOT THE OTHER WAY ROUND — bike.js's rule,
   and it holds harder here. Measured off handL/handR with the posture
   live and averaged across the pair (they are deliberately asymmetric).
   Both come out further OUT and further BACK than any drawing of a
   motorcycle would suggest, because Wally's arm is 0.30 H on a body
   whose seat sits 185 mm behind the origin: the reach is saturated, and
   a bar that reached forward to a steering head would need arms he does
   not have. The answer on the bicycle was swept-back bars; the answer
   here is the same, and on a big machine pulled-back bars read as a
   cruiser, which is exactly what a retired fleet bike should be. */
export const SCOOT_BARS = { x: 0.406, y: 0.866, z: 0.241 };
export const MOTO_BARS = { x: 0.463, y: 0.843, z: 0.170 };

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();

/* ==================================================================
   The shared toolkit — materials in §5's vocabulary and a capsule that
   re-orients per tube.

   THESE ARE bike.js's NUMBERS, ON PURPOSE. Three vehicles built by one
   city ought to look like they came out of the same paint shop, and the
   grain amplitude (0.0011, i.e. 0.037 of perturbation once toon.js
   scales it), the band softness and the outline width are what make the
   bicycle read as a made object next to clay. Copying them is the point;
   the only thing that changes machine to machine is the colour.
   ================================================================== */
function makeKit(ctx, tag) {
  const owned = [];
  const mats = [];

  const paint = (color, o = {}) => {
    const m = ctx.mat.toon({
      name: tag + '.paint',
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

  const capCache = new Map();
  const capsuleGeo = (r, len) => {
    const key = `${r.toFixed(3)}|${len.toFixed(3)}`;
    let g = capCache.get(key);
    if (!g) {
      g = new THREE.CapsuleGeometry(r, Math.max(len - r * 2, 0.001), 3, 10);
      owned.push(g);
      capCache.set(key, g);
    }
    return g;
  };

  /** A capsule from a to b. Chunky and rounded is the brief: a cylinder
      ends in a flat disc and every joint then shows a polygon cap (§7). */
  const tube = (parent, a, b, r, mat) => {
    _a.fromArray(a); _b.fromArray(b);
    _d.subVectors(_b, _a);
    const len = _d.length();
    const m = new THREE.Mesh(capsuleGeo(r, len), mat);
    m.position.copy(_a).addScaledVector(_d, 0.5);
    m.quaternion.setFromUnitVectors(UP, _d.normalize());
    parent.add(m);
    return m;
  };

  /** A squashed sphere — the one form both bodies are actually made of.
      s = [x,y,z] half-axes.

      THE SEGMENT COUNT IS A BUDGET DECISION AND IT IS THE WHOLE BUDGET.
      Twenty rounded masses at 14x10 is 5 600 triangles before a single
      wheel; at 12x8 it is 3 800, and the two are indistinguishable under
      a two-band ramp because the terminator crossing a 200 mm blob is
      one soft line either way. Anything under 120 mm gets 10x7 and
      nothing gets more than 16 — the tank and the leg shield, which are
      the two masses a player actually looks at. */
  const lump = (parent, c, s, mat, seg = 12) => {
    const g = new THREE.SphereGeometry(1, seg, Math.max(6, Math.round(seg * 0.68)));
    g.scale(s[0], s[1], s[2]);
    owned.push(g);
    const m = new THREE.Mesh(g, mat);
    m.position.set(c[0], c[1], c[2]);
    parent.add(m);
    return m;
  };

  /** A wheel. bike.js's argument for the section applies at every size —
      a thin hoop aliases into dashes at distance, a balloon reads as one
      rounded volume at four pixels — so the tyre keeps its fat torus and
      the savings come out of the segment counts instead.

      `spokes` 0 gives a SOLID DISC, which is not a cost dodge: a scooter
      has pressed steel wheels and a motorcycle has spokes, and that is
      one more line of separation between the two silhouettes at the
      distance where only the wheels are left. */
  const wheel = (R, sec, tyreMat, metalMat, spokes = 5) => {
    const w = new THREE.Group();
    const tg = new THREE.TorusGeometry(R - sec, sec, 7, 18);
    const rg = new THREE.TorusGeometry(R - sec * 2.1, sec * 0.42, 5, 14);
    const hg = new THREE.CapsuleGeometry(R * 0.20, R * 0.24, 2, 8);
    owned.push(tg, rg, hg);
    const tyre = new THREE.Mesh(tg, tyreMat); tyre.rotation.y = Math.PI / 2;
    const rim = new THREE.Mesh(rg, metalMat); rim.rotation.y = Math.PI / 2;
    const hub = new THREE.Mesh(hg, metalMat); hub.rotation.z = Math.PI / 2;
    w.add(tyre, rim, hub);
    const sr = R - sec * 2.1;
    if (spokes > 0) {
      for (let i = 0; i < spokes; i++) {
        const g = new THREE.BoxGeometry(0.014, sr * 2, R * 0.10);
        owned.push(g);
        const sp = new THREE.Mesh(g, metalMat);
        sp.rotation.x = (i / spokes) * Math.PI;
        w.add(sp);
      }
    } else {
      const g = new THREE.CylinderGeometry(sr, sr, 0.026, 16);
      owned.push(g);
      const disc = new THREE.Mesh(g, metalMat);
      disc.rotation.z = Math.PI / 2;
      w.add(disc);
    }
    return w;
  };

  /** A mudguard: a partial torus over the top of a wheel. §5 — it is the
      most Wind-Waker line on either machine and it is what stops a wheel
      reading as a bare ring. */
  const guard = (parent, R, sec, y, z, arc, roll, mat) => {
    const g = new THREE.TorusGeometry(R + sec * 0.30, sec * 0.52, 5, 16, arc);
    owned.push(g);
    const m = new THREE.Mesh(g, mat);
    m.position.set(0, y, z);
    m.rotation.y = Math.PI / 2;
    m.rotation.x = roll;
    parent.add(m);
    return m;
  };

  return {
    paint, tube, lump, wheel, guard, capsuleGeo, owned, mats,
    dispose() {
      for (const g of owned) g.dispose();
      for (const m of mats) m.dispose?.();
      capCache.clear();
    },
  };
}

/** Count what a machine actually costs, so the report is a measurement
    and not a guess. Called by WALLY.debug.rideInfo().

    THE OUTLINE HULLS ARE COUNTED SEPARATELY, not ignored and not folded
    in. §2.2 puts an inverted-hull stroke on world geometry, so every
    painted mesh here carries a second non-indexed copy of itself: the
    first pass at this counted them as body triangles and reported a
    bicycle at 16 000, which is why anyone reading it would have thought
    the model was eight times its real size. `triangles` is the machine.
    `outline` is the tax §2.2 charges. `drawn` is what the GPU sees. */
export function triangleCost(root) {
  let tris = 0, hull = 0, meshes = 0, hulls = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    const n = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    if (o.userData.isOutlineHull) { hull += n; hulls++; } else { tris += n; meshes++; }
  });
  return {
    triangles: Math.round(tris), meshes,
    outline: Math.round(hull), outlineMeshes: hulls,
    drawn: Math.round(tris + hull),
  };
}

/* ==================================================================
   THE SCOOTER — "Barnaby's Scooter", route 6, thirty years.

   A small stand-over step-through: the deck is a floor, the shield is a
   wall, and the rider sits in it rather than on it. Painted the deep
   teal of a municipal transport livery with cream panels, which is the
   one colour pair in the palette that cannot be confused with the
   bicycle's orange at any distance or in any light — and against grass,
   which is where half the island is, teal separates and olive does not.
   ================================================================== */
export function createScooter(ctx) {
  const T = THREE;
  const F = RIDE_FIT.scooter;
  const K = makeKit(ctx, 'scooter');
  const group = new T.Group();
  group.name = 'wally.scooter';

  /* FAT LITTLE WHEELS, AND A WHEELBASE THE FLOOR HAS TO FIT INSIDE.
     THE FLOOR IS THE CONSTRAINT, not the styling. His soles land at
     z +0.11 and the pan has to reach forward from behind them to the
     base of the leg shield, or the two read as separate objects with a
     gap of daylight between — which is exactly what the first pass
     looked like. At floor height (y 0.10) a 0.196 m wheel occupies
     z 0.35 to 0.69 about an axle at 0.52, so the pan can run to 0.31
     and the shield can stand on the end of it. That is where the front
     axle went, and the rear followed to keep the machine stubby: 0.99
     between the axles, against the bicycle's 0.94 and the
     motorcycle's 1.28. */
  const R = 0.196;                 // small fat wheels — the scooter tell
  const SEC = 0.060;
  const FZ = 0.520, RZ = -0.470;   // axles

  const bodyMat = K.paint(CATEGORY.Stocks, { name: 'scooter.body' });
  const panelMat = K.paint(BUILD.stucco, {
    name: 'scooter.panel', spec: 0.12, rim: 0.30,
    grain: 0.0013, grainScale: 19, grainAlbedo: 0.060,
  });
  const metalMat = K.paint(BUILD.metal, {
    name: 'scooter.metal', spec: 0.30, specPow: 40, specBanded: true, rim: 0.46,
    grain: 0.0006, grainScale: 26, grainAlbedo: 0.035,
  });
  /* §7: never pure black. Through the shade law this still reads as
     rubber and never bottoms out. */
  const tyreMat = K.paint(LAND.rockShade, {
    name: 'scooter.tyre', color: 0x3a3c41,
    spec: 0.05, specPow: 14, rim: 0.22,
    grain: 0.0016, grainScale: 30, grainAlbedo: 0.070, grainShade: 0.22,
  });
  const seatMat = ctx.mat.wood
    ? ctx.mat.wood({ name: 'scooter.seat', color: BUILD.woodDark, outline: true, outlineWidth: 3.0 })
    : K.paint(BUILD.woodDark, { name: 'scooter.seat' });
  if (ctx.mat.wood) K.mats.push(seatMat);
  const lampMat = K.paint(BUILD.glassLit, {
    name: 'scooter.lamp', spec: 0.42, specPow: 60, specBanded: true, rim: 0.55, skyBounce: 0.30,
  });

  /* ---- the steering half ----
     Fork, front wheel, front guard, bars and the headlight nacelle all
     turn together. The leg shield does NOT — it is bodywork, bolted to
     the frame, and a shield that swung with the bars would read as the
     whole scooter folding in half. */
  const steer = new T.Group();
  group.add(steer);

  const wheels = [];
  {
    /* PRESSED DISCS, not spokes. See `wheel` — it is the wheel a scooter
       actually has, and at forty metres it is the last thing separating
       these two silhouettes after the bodywork has gone to one blob. */
    const fw = K.wheel(R, SEC, tyreMat, metalMat, 0);
    fw.position.set(0, R, FZ);
    steer.add(fw);
    wheels.push(fw);
    const rw = K.wheel(R, SEC, tyreMat, metalMat, 0);
    rw.position.set(0, R, RZ);
    group.add(rw);
    wheels.push(rw);
  }

  /* ---- THE FLOOR ----
     A FLOOR, not a pair of pedals, and the single clearest statement
     that this is not a bicycle: his soles are flat on a surface. Its
     height is RIDE_FIT.deckY, which is where the posed ankle actually
     put the sole — measured, see the header. */
  {
    const d = new T.Group();
    d.position.set(0, F.deckY - 0.034, F.deckZ - 0.010);
    K.lump(d, [0, 0, 0], [0.166, 0.036, 0.214], bodyMat, 12);
    /* a rubber mat inset into it — one value change across the top face,
       which is what says "stand here" and stops the pan reading as a
       painted plank */
    K.lump(d, [0, 0.026, 0.004], [0.134, 0.016, 0.178], tyreMat, 10);
    /* THE SKIRTS STOP AT THE PAN, NOT BELOW IT. They close the floor off
       to the road so it reads as a floor in side view instead of a plank
       between two wheels — but the first pass hung them 11 mm UNDER the
       ground plane, and a teal fin sticking out of the tarmac is the one
       thing in shots/_scootside.png you cannot stop looking at. */
    /* 0.083 off the road, which is where the haunches below also
       bottom out: a floor pan that hangs lower than the panels either
       side of it reads as a plate bolted underneath rather than as the
       underside of one skin. */
    for (const s of [-1, 1]) K.lump(d, [s * 0.156, -0.020, 0], [0.026, 0.030, 0.202], bodyMat, 8);
    group.add(d);
    /* THE HAUNCH — the rounded corner where the floor turns up into the
       leg shield, and the single piece that stopped these reading as
       three objects in a row. A Vespa has no join there; it is one
       pressed skin that turns through ninety degrees, and without a mass
       IN the corner the eye finds the two flat panels instead of the
       curve between them. */
    K.lump(group, [0, F.deckY + 0.030, F.deckZ + 0.166], [0.168, 0.106, 0.110], bodyMat, 12);
    /* and the same corner at the back, into the body */
    K.lump(group, [0, F.deckY + 0.022, F.deckZ - 0.236], [0.164, 0.098, 0.112], bodyMat, 10);
  }

  /* ---- THE LEG SHIELD ---- the silhouette, and the reason this is not
     a bicycle. One broad continuous panel standing between the rider's
     shins and the road: it rises off the front lip of the floor and
     sweeps up and back toward the bars, and it is WIDE and TALL — wider
     than the floor, wider than his knees, and reaching two thirds of the
     way to the grips — because a short narrow one reads as a number
     plate on a stick. Two lumps rather than a plate, so it has a rounded
     section and the terminator crosses it as a curve. */
  {
    const sh = new T.Group();
    /* IT STANDS ON THE FRONT OF THE FLOOR AND LEANS BACK TOWARD THE
       RIDER — negative rotation, and the sign of it is the difference
       between a Vespa and a milk float. At -0.18 the base lands at
       z 0.312, which is the front lip of the pan, and the top comes back
       to z 0.204 where it is 100 mm clear of his knees. */
    sh.position.set(0, 0.420, 0.268);
    sh.rotation.x = -0.18;
    K.lump(sh, [0, 0, 0], [0.198, 0.268, 0.062], panelMat, 16);
    K.lump(sh, [0, 0.196, -0.026], [0.158, 0.120, 0.056], panelMat, 12);
    /* the rolled edge, in the body colour: the one line that makes it a
       pressed panel instead of a slab */
    {
      const g = new T.TorusGeometry(0.194, 0.022, 5, 18, Math.PI * 1.22);
      K.owned.push(g);
      const m = new T.Mesh(g, bodyMat);
      m.rotation.z = -Math.PI * 0.61;
      m.scale.set(1, 1.48, 1);
      m.position.set(0, 0.004, -0.002);
      sh.add(m);
    }
    group.add(sh);
  }

  /* ---- the body: a fat rounded tail under and behind the seat ----
     The Vespa "cheeks". Two of them, so there is a waist between the
     rider's calves and the widest point sits behind him where it does
     not fight the floor. Its top is 10 mm under the seat: a body that
     rises past the seat is a body he is sitting IN.

     IT IS DELIBERATELY OVERSIZED FOR THE SEAT HEIGHT. Wally's leg is
     0.30 H, so his seat can only ever be 0.41 m up — proportionally
     half what a Vespa's is on a person — and a body scaled to THAT
     leaves a machine that reads as a child's toy under an adult. The
     mass goes back and outward instead of up: 0.40 m across the cheeks
     against a 0.30 m floor. */
  {
    K.lump(group, [0, 0.256, -0.290], [0.194, 0.150, 0.258], bodyMat, 14);
    for (const s of [-1, 1]) {
      K.lump(group, [s * 0.152, 0.240, -0.306], [0.102, 0.132, 0.218], bodyMat, 10);
    }
    /* THE BODY STOPS 35 mm SHORT OF THE SEAT. Level with it and the
       saddle vanishes into the bodywork and he reads as sitting on a
       teal boulder — which is what the first pass did. */
    /* the engine cowl and the pipe, offset to the right the way every
       scooter's are. An exhaust is 40 mm of chrome and it is the detail
       that says this one BURNS something. */
    K.lump(group, [0.192, 0.200, -0.424], [0.074, 0.086, 0.126], bodyMat, 10);
    K.lump(group, [0.200, 0.146, -0.480], [0.036, 0.036, 0.080], metalMat, 8);
    /* the spine that carries the seat forward over the floor. It runs
       UNDER the ankle station and inboard of both boots: 58 mm of radius
       on the centre-line clears them by 60 mm. The first version of it —
       at hip height — ran straight through both of his shins. */
    K.tube(group, [0, 0.240, -0.170], [0, F.deckY + 0.020, 0.100], 0.058, bodyMat);
  }

  /* ---- the seat ---- a soft saddle wedge, wide at the back. */
  {
    const g = new T.SphereGeometry(1, 14, 10);
    g.scale(0.118, 0.052, 0.190);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const z = p.getZ(i);
      if (z > 0) { const k = 1 - Math.min(z / 0.100, 1) * 0.44; p.setX(i, p.getX(i) * k); }
    }
    g.computeVertexNormals();
    K.owned.push(g);
    const seat = new T.Mesh(g, seatMat);
    seat.position.set(0, F.seatY - 0.016, F.seatZ);
    seat.rotation.x = -0.05;
    group.add(seat);
  }

  /* ---- the bars, the nacelle and the headlight ----
     THE BARS SWEEP BACK AND OUT to SCOOT_BARS, which is where his
     mittens measure. The column leans back with the steering head, so
     what the sweep actually costs is one extra segment per side. */
  {
    const B = SCOOT_BARS;
    /* THE COLUMN LEANS BACK HARDER THAN THE SHIELD DOES, and that is
       the whole reason it is not a kick-scooter. On a Vespa the
       steering column is BEHIND the leg shield and you never see it;
       the first pass ran it up the front at z 0.42 against a shield at
       0.27, so a bare grey pole stood in front of the bodywork for the
       full height of the machine and that pole is the single loudest
       thing in the silhouette. Raked to 0.33 at the bottom and 0.24 at
       the top it stays behind the panel at every height, and the
       trailing arm then reaches forward to the axle the way a scooter's
       actually does. */
    const HEAD = [0, 0.620, 0.240];             // top of the steering head
    K.tube(steer, [0, 0.230, 0.330], HEAD, 0.046, metalMat);
    K.tube(steer, HEAD, [0, B.y - 0.010, B.z + 0.092], 0.040, metalMat);

    /* THE HANDLEBAR IS A BODY PANEL, NOT A TUBE — and getting that
       wrong is what made the first pass read as a kick-scooter. On a
       Vespa the bar, the headlight, the speedometer and the cables are
       all inside ONE pressed shell nearly as wide as the grips, and it
       is the second-largest mass on the machine after the leg shield.
       Two thin tubes with a pod in the middle is a bicycle's front end
       with a lamp on it. So: a wide flattened lump, the grips poking out
       of its ends, and the tubes only visible as the last 60 mm. */
    const nac = new T.Group();
    nac.position.set(0, B.y + 0.006, B.z + 0.062);
    nac.rotation.x = -0.16;
    K.lump(nac, [0, 0, 0], [0.230, 0.072, 0.088], panelMat, 16);
    K.lump(nac, [0, -0.012, 0.052], [0.128, 0.062, 0.062], panelMat, 12);
    const lamp = K.lump(nac, [0, -0.014, 0.104], [0.062, 0.062, 0.028], lampMat, 12);
    lamp.scale.z = 0.8;
    {
      const g = new T.TorusGeometry(0.062, 0.013, 4, 14);
      K.owned.push(g);
      const m = new T.Mesh(g, metalMat);
      m.position.set(0, -0.014, 0.112);
      nac.add(m);
    }
    steer.add(nac);

    for (const s of [-1, 1]) {
      K.tube(steer, [s * 0.190, B.y + 0.006, B.z + 0.048], [s * (B.x - 0.014), B.y, B.z - 0.008], 0.024, metalMat);
      const grip = new T.Mesh(K.capsuleGeo(0.038, 0.130), tyreMat);
      grip.position.set(s * (B.x - 0.020), B.y, B.z - 0.006);
      grip.rotation.z = Math.PI / 2;
      grip.rotation.y = s * 0.18;
      steer.add(grip);
      /* mirrors on stalks — small, and the detail that reads at distance
         as "this thing is road legal" */
      K.tube(steer, [s * (B.x - 0.086), B.y + 0.020, B.z + 0.016],
        [s * (B.x - 0.058), B.y + 0.146, B.z + 0.028], 0.012, metalMat);
      const mir = K.lump(steer, [s * (B.x - 0.056), B.y + 0.160, B.z + 0.030],
        [0.044, 0.030, 0.014], metalMat, 8);
      mir.rotation.y = s * 0.5;
    }
  }

  /* ---- forks and guards ----
     A scooter's front suspension is a single trailing arm on ONE side,
     which is a lovely piece of specificity and reads instantly as not a
     bicycle fork. */
  {
    K.tube(steer, [-0.054, 0.246, 0.330], [-0.054, R, FZ], 0.032, metalMat);
    K.guard(steer, R, SEC, R, FZ, Math.PI * 0.80, Math.PI * 0.14, bodyMat);
    K.guard(group, R, SEC, R, RZ, Math.PI * 0.52, Math.PI * 0.34, bodyMat);
  }

  /* ---- the pannier ----
     "Half a litre of engine and thirty years of route knowledge in the
     pannier." The bicycle has its basket; this has the box Barnaby
     carried a route book in, and it is what makes the object HIS rather
     than a scooter. */
  {
    /* A FLAT CASE ON A RACK, not a pot. The first pass gave it a round
       body and a lid of a different colour and it read as a jam jar
       strapped to the back — see shots/_scootside.png. Wide, low, square
       in the body's own paint with a leather lid, sitting on two chrome
       rails clear of the seat. */
    const box = new T.Group();
    box.position.set(0, 0.458, -0.462);
    box.rotation.x = 0.05;
    K.lump(box, [0, 0, 0], [0.146, 0.040, 0.082], bodyMat, 10);
    /* one leather strap over the lid — not a lid in a second colour,
       which is what made it read as a jam jar */
    K.lump(box, [0, 0.026, 0], [0.038, 0.022, 0.086], seatMat, 8);
    group.add(box);
    for (const s of [-1, 1]) {
      K.tube(group, [s * 0.100, 0.396, -0.404], [s * 0.110, 0.428, -0.452], 0.014, metalMat);
    }
  }

  return finish(ctx, group, {
    kind: 'scooter', R, wheels, steer,
    SADDLE: { x: 0, y: F.seatY, z: F.seatZ },
    BARS: SCOOT_BARS,
    REST: { y: F.deckY, z: F.deckZ },
    standLean: -0.16,
  }, K);
}

/* ==================================================================
   THE MOTORCYCLE — "Thunderhead 900", the one Dispatch retired.

   Bigger, heavier, more planted, and the mass is in the MIDDLE: a long
   tank the rider's knees close on, an engine hanging under it, a pipe
   down the right flank. Wheels half again the scooter's. The livery is
   the fleet's own brick red over a charcoal frame with a lot of chrome,
   which reads as old municipal equipment somebody has kept — not as a
   toy, and not as the orange bicycle.
   ================================================================== */
export function createMotorcycle(ctx) {
  const T = THREE;
  const F = RIDE_FIT.motorcycle;
  const K = makeKit(ctx, 'moto');
  const group = new T.Group();
  group.name = 'wally.motorcycle';

  const R = 0.262;                 // big — the first thing you read
  const SEC = 0.082;               // and fat
  const FZ = 0.660, RZ = -0.615;

  const tankMat = K.paint(CATEGORY.Sports, { name: 'moto.tank' });
  const frameMat = K.paint(LAND.rockShade, {
    name: 'moto.frame', spec: 0.20, specPow: 32, specBanded: true, rim: 0.30,
  });
  const metalMat = K.paint(BUILD.metal, {
    name: 'moto.metal', spec: 0.34, specPow: 44, specBanded: true, rim: 0.50,
    grain: 0.0006, grainScale: 26, grainAlbedo: 0.035,
  });
  const tyreMat = K.paint(LAND.rockShade, {
    name: 'moto.tyre', color: 0x3a3c41,
    spec: 0.05, specPow: 14, rim: 0.22,
    grain: 0.0016, grainScale: 30, grainAlbedo: 0.070, grainShade: 0.22,
  });
  const seatMat = ctx.mat.wood
    ? ctx.mat.wood({ name: 'moto.seat', color: CLAY.frame, outline: true, outlineWidth: 3.0 })
    : K.paint(BUILD.woodDark, { name: 'moto.seat' });
  if (ctx.mat.wood) K.mats.push(seatMat);
  const lampMat = K.paint(BUILD.glassLit, {
    name: 'moto.lamp', spec: 0.42, specPow: 60, specBanded: true, rim: 0.55, skyBounce: 0.30,
  });

  const steer = new T.Group();
  group.add(steer);

  const wheels = [];
  {
    const fw = K.wheel(R, SEC, tyreMat, metalMat, 6);
    fw.position.set(0, R, FZ);
    steer.add(fw);
    wheels.push(fw);
    /* the rear is a size fatter — a detail nobody names and everybody
       reads as "this one is powerful" */
    const rw = K.wheel(R + 0.008, SEC + 0.014, tyreMat, metalMat, 6);
    rw.position.set(0, R + 0.008, RZ);
    group.add(rw);
    wheels.push(rw);
  }

  /* ---- THE TANK ---- the mass, and the silhouette. It runs from over
     the engine back to the seat nose, is widest where his thighs close
     on it and tucks in at the front so the bars clear it.

     ITS TOP IS AT 0.660, WHICH IS NOT A STYLE CHOICE. The measured
     grips sit at y 0.843 and z 0.170 — that is over the tank, because
     his arms are short and his seat is 185 mm back — so a tank any
     taller would have his mittens inside it. 180 mm of daylight between
     the tank and the grip is what a cruiser looks like, and it is also
     the only place those two numbers can both be true. */
  {
    K.lump(group, [0, 0.552, 0.100], [0.176, 0.108, 0.242], tankMat, 16);
    K.lump(group, [0, 0.516, -0.096], [0.146, 0.090, 0.130], tankMat, 12);
    for (const s of [-1, 1]) K.lump(group, [s * 0.116, 0.500, 0.070], [0.084, 0.084, 0.172], tankMat, 10);
    /* the filler cap — 40 mm of chrome that makes the top of the tank a
       surface rather than a blob */
    {
      const g = new T.CylinderGeometry(0.038, 0.042, 0.020, 10);
      K.owned.push(g);
      const m = new T.Mesh(g, metalMat);
      m.position.set(0, 0.662, 0.140);
      m.rotation.x = -0.10;
      group.add(m);
    }
  }

  /* ---- THE ENGINE ---- under the tank, ahead of the rider's shins,
     and FINNED, because a fin stack is the one shape that still says
     ENGINE at six pixels. */
  {
    K.lump(group, [0, 0.372, 0.086], [0.130, 0.112, 0.148], frameMat, 12);
    for (let i = 0; i < 4; i++) {
      const g = new T.BoxGeometry(0.262, 0.018, 0.176 - i * 0.008);
      K.owned.push(g);
      const m = new T.Mesh(g, metalMat);
      m.position.set(0, 0.322 + i * 0.048, 0.092);
      group.add(m);
    }
    /* crankcase and the drive to the back wheel */
    K.lump(group, [0, 0.272, 0.006], [0.116, 0.076, 0.166], metalMat, 10);
    K.tube(group, [0.076, 0.266, -0.050], [0.068, R + 0.008, RZ], 0.026, metalMat);
    /* THE PIPE. Down the right flank, under the peg, to a muffler
       behind it — asymmetric, which is what stops a machine
       photographed from the left and from the right reading as the same
       machine twice, and low enough that his boot clears it. */
    K.tube(group, [0.096, 0.296, 0.166], [0.142, 0.212, -0.120], 0.030, metalMat);
    K.tube(group, [0.142, 0.212, -0.120], [0.156, 0.226, -0.516], 0.036, metalMat);
    K.lump(group, [0.156, 0.230, -0.556], [0.046, 0.046, 0.086], metalMat, 10);
  }

  /* ---- the frame: a spine over the engine, and a swingarm back ---- */
  {
    K.tube(group, [0, 0.612, 0.336], [0, 0.470, -0.166], 0.036, frameMat);
    for (const s of [-1, 1]) {
      K.tube(group, [s * 0.068, 0.470, 0.330], [s * 0.084, 0.298, 0.062], 0.028, frameMat);
      K.tube(group, [s * 0.084, 0.288, -0.048], [s * 0.068, R + 0.008, RZ], 0.028, frameMat);
      /* the shock, inboard of his shins by 60 mm */
      K.tube(group, [s * 0.074, 0.452, -0.186], [s * 0.070, R + 0.076, RZ + 0.076], 0.022, metalMat);
    }
  }

  /* ---- the seat and the tail ---- */
  {
    const g = new T.SphereGeometry(1, 14, 10);
    g.scale(0.116, 0.048, 0.215);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const z = p.getZ(i);
      if (z > 0) { const k = 1 - Math.min(z / 0.120, 1) * 0.52; p.setX(i, p.getX(i) * k); }
    }
    g.computeVertexNormals();
    K.owned.push(g);
    const seat = new T.Mesh(g, seatMat);
    seat.position.set(0, F.seatY - 0.014, F.seatZ);
    seat.rotation.x = -0.06;
    group.add(seat);
    /* the tail hump, and a lamp in the back of it */
    K.lump(group, [0, F.seatY + 0.006, F.seatZ - 0.236], [0.102, 0.068, 0.108], tankMat, 12);
    K.lump(group, [0, F.seatY + 0.008, F.seatZ - 0.330], [0.046, 0.030, 0.022], lampMat, 8);
  }

  /* ---- the pegs ---- REAL, and exactly where the posed ankle lands:
     RIDE_FIT.pegY / pegZ are readings off the rig, not a guess at where
     a foot ought to go. */
  for (const s of [-1, 1]) {
    K.tube(group, [s * 0.096, F.pegY + 0.030, F.pegZ], [s * 0.158, F.pegY + 0.014, F.pegZ], 0.022, metalMat);
    const g = new T.BoxGeometry(0.056, 0.020, 0.100);
    K.owned.push(g);
    const m = new T.Mesh(g, frameMat);
    m.position.set(s * 0.170, F.pegY + 0.010, F.pegZ);
    group.add(m);
  }

  /* ---- the front end: raked forks, a big lamp, pulled-back bars ---- */
  {
    const B = MOTO_BARS;
    const YOKE = [0, 0.688, 0.452];             // top of the steering head
    K.tube(group, [0, 0.596, 0.344], YOKE, 0.042, frameMat);
    /* THE RAKE IS THE POSTURE OF THE MACHINE. Forks dropping straight
       down give an upright commuter; laid out to a front axle 210 mm
       ahead of the yoke they give the long low planted line the whole
       object is supposed to have. */
    for (const s of [-1, 1]) {
      K.tube(steer, [s * 0.086, 0.742, 0.428], [s * 0.078, R, FZ], 0.032, metalMat);
      K.tube(steer, [s * 0.086, 0.552, 0.482], [s * 0.080, 0.372, FZ - 0.056], 0.040, frameMat);
      /* THE PULLBACK. A riser off the yoke, then a long sweep back and
         out to the measured grip. Two segments, and it is the same
         answer bike.js reached for the same reason: the bar goes to the
         hand, because the arm cannot go to the bar. */
      K.tube(steer, [s * 0.052, 0.806, 0.442], [s * 0.230, 0.828, 0.372], 0.026, metalMat);
      K.tube(steer, [s * 0.230, 0.828, 0.372], [s * (B.x - 0.016), B.y, B.z + 0.008], 0.026, metalMat);
      const grip = new T.Mesh(K.capsuleGeo(0.040, 0.140), tyreMat);
      grip.position.set(s * (B.x - 0.022), B.y - 0.004, B.z);
      grip.rotation.z = Math.PI / 2;
      grip.rotation.y = s * 0.22;
      steer.add(grip);
      /* mirrors, high and wide, on the risers where they belong */
      K.tube(steer, [s * 0.238, 0.834, 0.372], [s * 0.276, 0.958, 0.380], 0.012, metalMat);
      const mir = K.lump(steer, [s * 0.282, 0.972, 0.382], [0.048, 0.032, 0.014], frameMat, 8);
      mir.rotation.y = s * 0.46;
    }
    K.tube(steer, [0, 0.740, 0.436], [0, 0.812, 0.446], 0.030, metalMat);
    /* THE HEADLIGHT — big, round and between the forks. On a machine
       this size it is the most recognisable thing about the front of it,
       and the chrome shell is what keeps it from reading as a sticker. */
    const lamp = K.lump(steer, [0, 0.700, 0.512], [0.092, 0.092, 0.062], lampMat, 14);
    lamp.scale.z = 0.9;
    {
      const g = new T.TorusGeometry(0.092, 0.020, 5, 16);
      K.owned.push(g);
      const m = new T.Mesh(g, metalMat);
      m.position.set(0, 0.700, 0.524);
      steer.add(m);
    }
    K.guard(steer, R, SEC, R + 0.020, FZ, Math.PI * 0.62, Math.PI * 0.16, tankMat);
    K.guard(group, R + 0.008, SEC + 0.014, R + 0.034, RZ, Math.PI * 0.52, Math.PI * 0.36, tankMat);
  }

  return finish(ctx, group, {
    kind: 'motorcycle', R, wheels, steer,
    SADDLE: { x: 0, y: F.seatY, z: F.seatZ },
    BARS: MOTO_BARS,
    REST: { y: F.pegY, z: F.pegZ },
    standLean: -0.20,
  }, K);
}

/* ==================================================================
   Shared tail end — registration, culling policy and the live API.
   Kept identical to bike.js's so wally.js can treat all three machines
   as one type of thing.
   ================================================================== */
function finish(ctx, group, spec, K) {
  if (ctx.mat.register) ctx.mat.register(group, { castShadow: true, receiveShadow: true });
  /* Nothing here is frustum-culled on its own: the group rides Wally's
     root and his bounding sphere already covers it, and a wheel that
     pops out at the frame edge is a worse defect than a draw call. */
  group.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });

  let spin = 0, steerAng = 0;

  const api = {
    group,
    kind: spec.kind,
    SADDLE: spec.SADDLE,
    BARS: spec.BARS,
    REST: spec.REST,
    /* bike.js publishes PEDAL; nothing on a motor has one, but wally.js
       reads `.PEDAL` when it reports the fit, so give it the footrest
       under the same key rather than making the caller branch. */
    PEDAL: { y: spec.REST.y, z: spec.REST.z, r: 0 },
    wheels: spec.wheels,
    steer: spec.steer,
    crank: null,

    /** Roll the wheels for `speed` metres/second. No crank: a motor's
        wheels are geared to an engine the player never sees, so the
        only honest drive is distance over radius. */
    update(dt, speed) {
      const v = Number.isFinite(speed) ? speed : 0;
      spin += (v * dt) / spec.R;
      if (!Number.isFinite(spin)) spin = 0;
      for (const w of spec.wheels) w.rotation.x = spin;
      return spin;
    },

    /** No-op: the bicycle's contract, kept so the caller has one path. */
    setCrankPhase() {},

    /** Point the front wheel where the machine is turning. Small — five
        degrees — because the rider's mittens are on the grips and a bar
        that swings further than the hands do is worse than one that
        does not move at all. */
    setSteer(a) {
      steerAng = a;
      if (spec.steer) spec.steer.rotation.y = a;
    },
    get steerAngle() { return steerAng; },

    /** Parked: leaned over on its side stand. Both machines are heavy
        enough that they lean further than the bicycle does. */
    park(on = true) {
      group.rotation.z = on ? spec.standLean : 0;
    },

    dispose() {
      group.parent?.remove(group);
      K.dispose();
    },
  };
  return api;
}

export default { createScooter, createMotorcycle, RIDE_FIT, triangleCost };
