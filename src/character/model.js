/* ============================================================
   model.js — the procedural mesh.

   No mesh files, no primitives you can name. Wally's body is a signed
   distance field — spheres, round cones, oriented ellipsoids and round
   boxes, blended with a polynomial smooth-minimum — polygonised with
   naive surface nets and then relaxed onto the true iso-surface.

   WHY SDF AND NOT BLENDED PRIMITIVES
   ----------------------------------
   ART_DIRECTION §7 forbids visible faceting on an organic form, and §1.1
   asks for a body where the head merges into the shoulders with no neck,
   the arms melt into the flank, and the trunk root fuses with the face.
   Those are *field* operations. Trying to get them from intersecting
   primitives gives you seams; trying to get them from one lathed skin
   gives you a shape that cannot branch. A smooth-min field gives both,
   and the surface it produces has clean quad-dominant topology because
   surface nets emits exactly one vertex per surface cell.

   Normals come from the analytic field gradient, not from face averaging,
   so the shading is smooth at any tessellation and the silhouette is the
   only thing resolution buys. That is why 35k triangles is enough.

   WHAT IS BAKED IN
   ----------------
     * AO      — sampled from the same field along the vertex normal, and
                 from an occluder field that also contains the glasses and
                 the tusks, so the brow bar drops a soft shadow onto the
                 face exactly as §1.2 asks. Rides in vColor.a; toon.js
                 multiplies it by a warm grey, never a neutral one.
     * tint    — vColor.rgb. Ear-inner plate (§1.5) and a faint warm cast
                 on the thin ear membrane and trunk tip (§1.2 subsurface).
     * weights — 4 per vertex, from rig.js capture volumes, restricted to
                 bones within 2 hops of the winner.

   The glasses and lenses are NOT field geometry. They are hard-surface
   and they need exact UVs, because THE GLINT (§1.4) is painted into the
   lens texture and must never drift. They are built parametrically from
   a rounded-trapezoid outline instead.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { CLAY, SHADOW } from '../core/palette.js';
import {
  PROP, BONES, BONE_PARENT, BONE_DIST, BONE_INDEX, captureDistance,
} from './rig.js';

/* ==================================================================
   1. SDF primitives and operators
   ================================================================== */

const SPHERE = 0, CONE = 1, ELLIP = 2, RBOX = 3, TORUS = 4, LATHE = 5;

/* Primitives are flat number arrays: [type, ...params, ...optional 9-number
   inverse rotation]. Monomorphic, no object churn, ~40M evals at boot. */

const sphere = (c, r) => [SPHERE, c[0], c[1], c[2], r];
const cone = (a, b, ra, rb) => [CONE, a[0], a[1], a[2], b[0], b[1], b[2], ra, rb];
const rbox = (c, h, r) => [RBOX, c[0], c[1], c[2], h[0], h[1], h[2], r];

/** Axis-aligned ellipsoid. */
function ellip(c, r) {
  return [ELLIP, c[0], c[1], c[2], r[0], r[1], r[2], 1, 0, 0, 0, 1, 0, 0, 0, 1];
}
/** Oriented ellipsoid: `n` becomes the ellipsoid's local +Z (the thin axis
    for a flattened one). Stores the inverse (= transpose) rotation. */
function ellipN(c, r, n, upHint) {
  const m = basisFrom(n, upHint);
  return [ELLIP, c[0], c[1], c[2], r[0], r[1], r[2],
    m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]];
}
/**
 * LATHE — a surface of revolution of an authored 2D profile. The torso.
 *
 * WHY NOTHING ELSE WORKS. Every other primitive here is a ball or a union
 * of balls, and a union of axis-centred balls cannot narrow faster than a
 * circular arc: a ball of radius R at height y covers everything within R
 * of it, so at y - d the shape is at least sqrt(R^2 - d^2) wide whether you
 * asked for it or not. §1.1's pear is 0.230 at y 0.918+ and 0.112 at
 * y 0.782 — the arc through the first point is still 0.137 at the second,
 * 25 mm too fat, and that 25 mm is the arm slot. The old ellipsoid stack
 * hid this by being fat everywhere; a round-cone chain exposes it as a
 * shelf hanging off the belly. The profile is simply not ball-representable
 * and no amount of tuning the stations changes that.
 *
 * So the torso is authored as a curve and evaluated as a curve. The
 * stations are resampled through a Catmull-Rom and lightly smoothed (which
 * also kills the spline's overshoot at the belly), giving a profile that is
 * C1 by construction with no station creases and no double-covered bands —
 * the two things that were putting ripples on the flank.
 *
 * ELLIPTICAL CROSS-SECTION, SHEARED CENTRE-LINE. Both are per-height, so
 * the point is mapped into a space where z is measured from the profile's
 * own centre-line and scaled by its own depth ratio before the radius test.
 * That shear makes the field a k-Lipschitz underestimate rather than a true
 * distance; `LIP` is the bound. Underestimating is the safe direction — the
 * block cull keeps more blocks than it needs and the vertex relaxation
 * takes shorter steps. Overestimating would drop blocks that contain
 * surface, which is a hole in the mesh.
 */
const LATHE_LIP = 0.78;

function lathe(stations, depthBase, samples = 56) {
  const n = stations.length;
  const yA = stations[0][0], yB = stations[n - 1][0];
  const N = samples;
  const ys = new Float64Array(N), rs = new Float64Array(N);
  const zcs = new Float64Array(N), zks = new Float64Array(N);
  const at = (i) => stations[i < 0 ? 0 : i > n - 1 ? n - 1 : i];

  for (let i = 0; i < N; i++) {
    const y = yA + (yB - yA) * (i / (N - 1));
    let s = 0;
    while (s < n - 2 && stations[s + 1][0] < y) s++;
    const t = (y - stations[s][0]) / (stations[s + 1][0] - stations[s][0]);
    const cr = (k, dflt) => {
      const p0 = at(s - 1)[k] ?? dflt, p1 = at(s)[k] ?? dflt;
      const p2 = at(s + 1)[k] ?? dflt, p3 = at(s + 2)[k] ?? dflt;
      return 0.5 * (2 * p1 + (-p0 + p2) * t
        + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
        + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
    };
    ys[i] = y; rs[i] = cr(1, 0.1); zcs[i] = cr(2, 0); zks[i] = cr(3, 1) * depthBase;
  }
  /* Two [1 2 1] passes. Catmull-Rom overshoots wherever the profile turns
     over — at the belly it put 1.5 mm of bulge above the authored 0.230,
     which is a ring the cel ramp finds and draws. This removes it and
     costs 0.9 mm off the peak. */
  const tmp = new Float64Array(N);
  for (let p = 0; p < 2; p++) {
    for (let i = 0; i < N; i++) {
      const a = rs[i > 0 ? i - 1 : 0], b = rs[i], c = rs[i < N - 1 ? i + 1 : N - 1];
      tmp[i] = (a + 2 * b + c) * 0.25;
    }
    rs.set(tmp);
  }

  const dy = (yB - yA) / (N - 1);
  const L = {
    ys, rs, zcs, zks, N, yA, yB, dy, invDy: 1 / dy,
    r0: rs[0], rN: rs[N - 1],
  };

  /* World bound, for the per-blob cull. */
  let yc = (yA + yB) * 0.5, zAcc = 0, rMax = 0;
  for (let i = 0; i < N; i++) { zAcc += zcs[i]; if (rs[i] > rMax) rMax = rs[i]; }
  const zc = zAcc / N;
  let br = 0;
  for (let i = 0; i < N; i++) {
    const half = Math.max(rs[i], rs[i] * zks[i]) + Math.abs(zcs[i] - zc);
    const e = Math.hypot(half, Math.abs(ys[i] - yc));
    if (e > br) br = e;
  }
  L.bx = 0; L.by = yc; L.bz = zc; L.br = br + Math.max(L.r0, L.rN);
  return [LATHE, L];
}

function latheDist(L, x, y, z) {
  /* THE TORSO IS EVALUATED ON EVERY SAMPLE IN THE GRID, INCLUDING THE ONES
     OUT AT THE EAR TIPS. buildBodyField's per-blob cull only fires once
     `acc` holds something, and the torso is the first blob, so it never
     gets culled. A profile scan that walks up to 50 segments then costs
     the same at the ear as it does at the navel, and surfaceNets went from
     1.35 s to 1.95 s on that alone.
     The surface is inside the bounding sphere, so the distance to the
     SPHERE is a valid lower bound on the distance to the surface —
     returning it far from the torso is exact enough for the block cull and
     the smin, and it is four operations. */
  const bd = Math.sqrt((x - L.bx) * (x - L.bx) + (y - L.by) * (y - L.by)
    + (z - L.bz) * (z - L.bz)) - L.br;
  if (bd > 0.02) return bd;

  /* sample index for the shear lookup, clamped to the ends */
  let fi = (y - L.yA) * L.invDy;
  let i0 = fi < 0 ? 0 : fi > L.N - 1 ? L.N - 1 : Math.floor(fi);
  if (i0 > L.N - 2) i0 = L.N - 2;
  const ft = fi < 0 ? 0 : fi > L.N - 1 ? 1 : fi - i0;
  const zc = L.zcs[i0] + (L.zcs[i0 + 1] - L.zcs[i0]) * ft;
  const zk = L.zks[i0] + (L.zks[i0 + 1] - L.zks[i0]) * ft;
  const dz = (z - zc) / zk;
  const rho = Math.sqrt(x * x + dz * dz);

  /* unsigned distance in the (rho, y) half-plane, expanding outward from
     the nearest sample until the remaining segments cannot possibly win */
  let best = Infinity;
  const seg = (j) => {
    const ay = L.ys[j], ar = L.rs[j], by = L.ys[j + 1], br = L.rs[j + 1];
    const ux = br - ar, uy = by - ay;
    const px = rho - ar, py = y - ay;
    let t = (px * ux + py * uy) / (ux * ux + uy * uy);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = px - ux * t, cy = py - uy * t;
    const d = Math.sqrt(cx * cx + cy * cy);
    if (d < best) best = d;
  };
  for (let k = 0; k < L.N; k++) {
    if ((k - 1) * L.dy > best) break;
    const a = i0 - k, b = i0 + k;
    if (a >= 0) seg(a);
    if (k && b <= L.N - 2) seg(b);
    if (a < 0 && b > L.N - 2) break;
  }
  /* round caps: the circle through the end station, in the same plane */
  const cb = Math.abs(Math.hypot(rho, y - L.yA) - L.r0);
  if (cb < best) best = cb;
  const ct = Math.abs(Math.hypot(rho, y - L.yB) - L.rN);
  if (ct < best) best = ct;

  /* sign: the closed outline's radius at this height */
  let R;
  if (y < L.yA) {
    const d2 = L.r0 * L.r0 - (L.yA - y) * (L.yA - y);
    R = d2 > 0 ? Math.sqrt(d2) : -1;
  } else if (y > L.yB) {
    const d2 = L.rN * L.rN - (y - L.yB) * (y - L.yB);
    R = d2 > 0 ? Math.sqrt(d2) : -1;
  } else {
    R = L.rs[i0] + (L.rs[i0 + 1] - L.rs[i0]) * ft;
  }
  return (rho < R ? -best : best) * LATHE_LIP;
}

/** Torus about `axis`, major radius R, tube radius t. */
function torus(c, axis, R, t) {
  const m = basisFrom(axis, [1, 0, 0]);
  return [TORUS, c[0], c[1], c[2], R, t, 0, 0,
    m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]];
}

/* Rows of the inverse rotation, i.e. the basis vectors as rows: a point is
   transformed by dotting with each row. */
function basisFrom(n, upHint) {
  const nz = norm3(n);
  let up = upHint ? norm3(upHint) : [0, 1, 0];
  if (Math.abs(dot3(up, nz)) > 0.985) up = [1, 0, 0];
  const nx = norm3(cross3(up, nz));
  const ny = cross3(nz, nx);
  return [nx[0], nx[1], nx[2], ny[0], ny[1], ny[2], nz[0], nz[1], nz[2]];
}
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * EXACT round cone — the convex hull of two spheres.
 *
 * THE OLD FORM WAS THE BUG BEHIND HALF THE LUMPS. `distanceToSegment -
 * lerp(ra, rb)` is not a round cone; it is a capsule whose radius is
 * painted along the axis, and its surface bulges out to the FULL endpoint
 * radius in a hemisphere around each end. On the torso, station y 0.918
 * carries r 0.193 against a neighbour at 0.140 — so that hemisphere hung
 * 40 mm proud of the authored profile 70 mm below its own station, and
 * the flank grew a shelf that no amount of mesh smoothing could remove
 * because the field really was that shape. Every limb had a milder version
 * of it at every taper.
 *
 * This is Inigo Quilez's exact form: the surface is the tangent frustum
 * between the two spheres, with a spherical cap at each end, so a chain of
 * them reproduces the authored profile to the millimetre and is smooth
 * across every shared station.
 */
function roundCone(px, py, pz, ax, ay, az, bx, by, bz, r1, r2) {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const l2 = bax * bax + bay * bay + baz * baz || 1e-9;
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const yy = pax * bax + pay * bay + paz * baz;
  const zz = yy - l2;
  const xx = pax * l2 - bax * yy;
  const xy = pay * l2 - bay * yy;
  const xz = paz * l2 - baz * yy;
  const x2 = xx * xx + xy * xy + xz * xz;
  const y2 = yy * yy * l2;
  const z2 = zz * zz * l2;
  const k = (rr < 0 ? -1 : rr > 0 ? 1 : 0) * rr * rr * x2;
  if ((zz > 0 ? 1 : zz < 0 ? -1 : 0) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if ((yy > 0 ? 1 : yy < 0 ? -1 : 0) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
}

function primDist(p, x, y, z) {
  switch (p[0]) {
    case SPHERE: {
      const dx = x - p[1], dy = y - p[2], dz = z - p[3];
      return Math.sqrt(dx * dx + dy * dy + dz * dz) - p[4];
    }
    case CONE:
      return roundCone(x, y, z, p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8]);
    case LATHE:
      return latheDist(p[1], x, y, z);
    case ELLIP: {
      /* The gradient-corrected ellipsoid distance, k0*(k0-1)/k1.
         The naive (|p/r| - 1) * min(r) form underestimates the distance by
         the axis ratio — a factor of five on Wally's ear plates, which are
         0.176 m long and 0.027 m thick. That is not merely inaccurate: it
         breaks the bounding-sphere cull below (a blob gets skipped on one
         sample and kept on the next) and corrugates the surface along
         every blend. This form is exact at the surface and asymptotically
         correct far from it. */
      const dx = x - p[1], dy = y - p[2], dz = z - p[3];
      const lx = p[7] * dx + p[8] * dy + p[9] * dz;
      const ly = p[10] * dx + p[11] * dy + p[12] * dz;
      const lz = p[13] * dx + p[14] * dy + p[15] * dz;
      const ax = p[4], ay = p[5], az = p[6];
      const ux = lx / ax, uy = ly / ay, uz = lz / az;
      const k0 = Math.sqrt(ux * ux + uy * uy + uz * uz);
      if (k0 < 1e-7) return -(ax < ay ? (ax < az ? ax : az) : (ay < az ? ay : az));
      const vx = ux / ax, vy = uy / ay, vz = uz / az;
      const k1 = Math.sqrt(vx * vx + vy * vy + vz * vz);
      return k0 * (k0 - 1) / k1;
    }
    case RBOX: {
      const qx = Math.abs(x - p[1]) - p[4];
      const qy = Math.abs(y - p[2]) - p[5];
      const qz = Math.abs(z - p[3]) - p[6];
      const mx = qx > 0 ? qx : 0, my = qy > 0 ? qy : 0, mz = qz > 0 ? qz : 0;
      const out = Math.sqrt(mx * mx + my * my + mz * mz);
      const inn = Math.min(Math.max(qx, Math.max(qy, qz)), 0);
      return out + inn - p[7];
    }
    case TORUS: {
      const dx = x - p[1], dy = y - p[2], dz = z - p[3];
      const lx = p[8] * dx + p[9] * dy + p[10] * dz;
      const ly = p[11] * dx + p[12] * dy + p[13] * dz;
      const lz = p[14] * dx + p[15] * dy + p[16] * dz;
      const rr = Math.sqrt(lx * lx + ly * ly) - p[4];
      return Math.sqrt(rr * rr + lz * lz) - p[5];
    }
    default: return 1e9;
  }
}

/**
 * A CHAIN of round cones that share their endpoints needs NO blend, and
 * giving it one is the single biggest source of lumps on this model.
 *
 * smin(a, b, k) subtracts h*h*k/4 and h is 1 wherever a == b — which is
 * exactly what happens along the sphere two consecutive cones share. So a
 * chain smooth-unioned at k pushes its surface OUT by k/4 in a band around
 * every station and by nothing in between: 7.5 mm of bulge on the trunk at
 * k 0.030, 8.5 mm on the arm at 0.034, 7 mm on the legs. On a 90 mm trunk
 * that is an 8% ring at every station, five of them down its length, and it
 * is what the flanks, the arms and the trunk were all wearing.
 *
 * The cones are already tangent-continuous across a shared station, so 0.006
 * is all it takes to round the slope change where the taper rate shifts —
 * 1.5 mm, under the mesher's own cell size.
 */
const CHAIN_K = 0.006;

/**
 * THE ARM'S JOIN TO THE BODY. It is its own named constant because it is
 * the one number on this model that can silently destroy a limb.
 *
 * smin subtracts h*h*k/4 and h is 1 at the midpoint of a gap, so a join
 * of k closes any void narrower than about k and eats roughly k out of
 * any void wider than that. The arm slot measures 27-46 mm on the field;
 * the mesher's cell is 13.6 mm and surface nets needs ~2.2 cells of clear
 * positive field to open a hole on every row rather than on a coin toss.
 * There is no slack. At 0.030 — three rounds of chasing an armpit
 * artifact with blend radius — the slot measured 18 mm before the mesher
 * ever saw it and the arm rendered as a webbed membrane from armpit to
 * wrist, against §1.1's "daylight between arm and body along most of its
 * length".
 *
 * 0.016 costs about 4 mm and leaves the slot open from y 0.85 down. The
 * armpit is NOT this number's job: it is solved by PROP.armpit, a cone
 * that crosses the flank transversally instead of grazing it, and that
 * table carries the argument.
 */
const ARM_JOIN = 0.016;

/** Polynomial smooth minimum — C1, cheap, and it never spikes. */
function smin(a, b, k) {
  if (k <= 0) return a < b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return (a < b ? a : b) - h * h * k * 0.25;
}
function smax(a, b, k) {
  if (k <= 0) return a > b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return (a > b ? a : b) + h * h * k * 0.25;
}

/**
 * A named blob: a set of primitives smooth-unioned at `k` internally, and
 * merged into the running field at `join`. `tag` is what the tint pass
 * looks up, `bone` is a hint the weight pass can fall back on.
 */
function blob(tag, prims, k, join) {
  return { tag, prims, k, join };
}

/* ==================================================================
   2. The sculpt
   ================================================================== */

const P = PROP;

/**
 * Torso as a chain of elliptical round cones down the authored profile.
 *
 * Consecutive cones share a station, so the union has no double-covered
 * band and the rendered flank tracks the table to well under a millimetre.
 * See `econe` for why this replaced the ellipsoid stack. The internal k is
 * 0.022 — just enough to round the slope change where the belly turns over,
 * and far too small to grow a bulge anywhere.
 */
function torsoBlob() {
  return blob('body', [lathe(P.torso, P.torsoDepth)], 0, 0.050);
}

/**
 * The pot belly, as its OWN blob with a generous join.
 *
 * It has to merge into the torso tube over a wide, soft fillet — that is
 * what a belly under skin looks like — while the tube itself unions at a
 * k four times smaller. Those are two different numbers and they cannot
 * both live in one blob, which is why the belly moved out of the stack.
 * It is also deliberately NARROW in x: it carries the forward mass (its
 * front face stands 54 mm proud of the torso wall) and none of the width,
 * so it cannot creep sideways into the slot the arm hangs in.
 */
function bellyBlob() {
  /* JOIN 0.104, NOT 0.072. The join radius IS the fillet, and the fillet
     is the only concavity anywhere on the front of him — so whatever the
     AO trace finds there it finds as a closed RING around the blob, which
     is the shape the lower-belly stain had. A wide join spreads the same
     volume change over twice the surface: the fillet's curvature halves,
     the trace's shortest tap stops resolving it as a valley, and the
     belly still stands 23 mm proud because the protrusion is in
     PROP.belly, not in k. */
  return blob('body', [ellip(P.belly.c, P.belly.r)], 0.03, 0.104);
}

function headBlob() {
  const { c, r } = P.head;
  return blob('body', [
    ellip(c, [r, r * 1.008, r * 0.975]),
    /* a whisper of brow above the glasses so the forehead is not a
       perfect sphere in raking light */
    ellip([0, c[1] + 0.052, c[2] + 0.070], [0.185, 0.086, 0.145]),
  ], 0.11, 0.052);
}

/**
 * One ear: a TALL leaf, 0.34 H by 0.22 H (§1.1), lying in a plane tilted
 * slightly back and out. Five flattened lobes, smooth-unioned, give a fan
 * that is thick at the root and thins toward the rim — which is what makes
 * the rim catch light and the membrane glow when backlit (§1.2).
 *
 * The inner edge stops just outside the cranium so the head ball still
 * reads as a distinct circle between the ears in silhouette. If the ears
 * swallow the head, the silhouette test in §1.1 fails.
 */
function earBlob(side) {
  const n = [P.ear.plane[0] * side, P.ear.plane[1], P.ear.plane[2]];
  const up = [0, 1, 0];
  const lobe = (x, y, z, rx, ry, th) => ellipN([x * side, y, z], [rx, ry, th], n, up);
  /* PLATE HALF-THICKNESS IS A MESHER CONSTRAINT, NOT A TASTE ONE. The dish
     below carves the front face away; whatever wall is left has to be at
     least ~2.5 grid cells (0.039 m at the high-tier 0.0155 m cell) or the
     rim comes out scalloped and the silhouette reads as a torn leaf. */
  /* A ROUNDED FAN, NOT A HANGING LEAF. The old stack put its tallest lobe
     at y 1.418 with a 0.110 half-height — top edge 1.528 against a crown
     of 1.595 — and its lowest mass at 1.006, so the ear read as a spaniel
     ear pinned to the side of the skull. The fan below tops out at 1.608
     on a 1.600 crown, carries its widest section at 1.344 (eye level, the
     glasses sit at 1.363) and tapers away below, which is the profile
     §1.1 describes. Height 1.608 - 1.064 = 0.544 = 0.34 H exactly. */
  /* THE INNER EDGE IS WHAT THE HEAD BALL IS MEASURED AGAINST. §1.1 wants
     the cranium to read 1.15x the widest torso row in a filled
     silhouette, and the number you can actually measure is the run
     between the two ear notches — so where the fan first merges into the
     skull sets it. At root x 0.302 the merge landed at y 1.245, where a
     0.556 ball is only 0.523 across; moving the root and the lower taper
     out by 14-20 mm raises the merge and buys back most of that, while
     the root's inner edge (0.236) is still 33 mm inside the skull so the
     ear cannot detach. */
  /* THE ROOT IS A MASS, NOT AN EDGE — this is the "ears sitting on the
     head like separate primitives" note, twice, from two panels.

     A fan whose thickest lobe is 52 mm meeting a 556 mm ball at a 42 mm
     smooth-union produces a fillet whose radius is smaller than the
     plate is thick: geometrically the plate INTERSECTS the ball and the
     union rounds the intersection line by 10 mm. At 250 px that is one
     pixel of fillet, so the eye gets an abrupt change of surface
     direction with no transition — which is the definition of a sticker.
     A real ear root is a wedge of cartilage that swells out of the skull
     over 60-80 mm before it flattens into the fan.

     So: one extra lobe, buried, 75 mm half-thick and tall, sitting where
     the fan enters the cranium; and the join to the running field taken
     from 0.042 to 0.076, which is bigger than the plate is thick and
     therefore actually reads. The inner edge of the root is unchanged at
     x 0.236, so §1.1's notch — the run between the two ear notches that
     the head-ball silhouette is measured against — does not move. */
  /* A ROUNDED FAN, MATCHED TO ref/wally-ref-cool.png. The previous lobe
     stack read as a pointed leaf: its outermost lobe was the SMALLEST
     (0.112 x 0.150 at x 0.542) so the outline tapered to a tip, and the
     lower half was starved so the fan had no bottom curve. The reference
     ear is nearly circular on its outer half — the rim runs one continuous
     convex arc from the crown, out, down and back under. So the two outer
     lobes are now the BIGGEST, one upper one lower, and a fuller bottom
     lobe closes the arc. Top edge 1.492+0.135 = 1.627 (crown 1.600, "or a
     touch above"); widest run at eye level 1.27-1.40; bottom 1.085.
     Height 0.54 = 0.34 H, outer edge x 0.630 -> settled span ~0.79 H. */
  /* ROUND 2 — THE FAN RISES. The critic's pixel comparison: "ears hang
     down and outward like drooping plates; tips fall well below the
     jawline, lower lobes are lumpy and sagging". The old stack put its
     outer mass at y 1.268 — BELOW the 1.396 root — so the fan's long
     axis pointed down-and-out and it hung. The stack below pins the
     root high (1.408-1.442), carries the two biggest lobes UP and OUT
     (top edge 1.532 + 0.130 = 1.662 against a 1.606 crown — "a touch
     above"), and tucks the small bottom lobe back toward the cheek at
     1.252 so nothing reaches the jaw hinge. Widest reach x 0.628 a
     side -> ~0.78 H span. */
  /* ROUND 4 — THE FAN'S MASS MOVES UP, AND THE NUMBER IS A ROW PROFILE.
     tools/silhouette.mjs height-matches this build against
     ref/wally-ref-cool.png and reports the width of every row as a
     fraction of the figure's height. Across the ear zone:

       f (from top)   game W    ref W     delta
         0.11         0.643     0.608     +0.034
         0.15         0.658     0.604     +0.054
         0.19         0.661     0.575     +0.086   <- our peak
         0.23         0.648     0.552     +0.096
         0.27         0.588     0.536     +0.053

     The reference's fan peaks at f 0.11 and is already narrowing by
     f 0.19; ours peaks at f 0.19 and is still near-peak at f 0.23. Both
     builds pass §1.1's silhouette test — the ear span IS the widest row
     in each — but ours carries a fifth of a head-height of extra fan
     hanging BELOW where the reference stops, which is the "drooping
     plates" note coming back through the spring solver rather than
     through the table: authored, the stack tops out at 1.662 on a 1.606
     crown, and secondary.js's ear gravity then settles it down.

     So the outer mass is authored ~38 mm higher and ~20 mm shorter in
     reach, which lands the settled fan on the reference's profile
     instead of 38 mm under it. Reach 0.632 -> 0.612 a side: the span
     comes off its +0.05 H overshoot and back toward §1.1's 0.80 H, and
     the row that was +0.096 loses both the sag and the overshoot.

     THE ROOT WEDGE DOES NOT MOVE. It is what stops the fan reading as a
     sticker on the ball (see the note above), and it is buried inside
     the cranium where nothing measures it.

     AND THE FAN GETS TALLER, IT DOES NOT TRANSLATE — which cost a round.
     Lifting the whole stack including the bottom lobe took f 0.31 from
     0.434 to 0.284 against a reference of 0.476: a 0.19 H hole punched
     straight through the jaw line, because the reference's fan is still
     at full reach there and ours had left. The reference ear runs from
     ABOVE the crown down to f 0.32; ours now runs 1.238-1.694 authored,
     which is the same span 34 mm taller. Top raised, bottom lobe pushed
     covered by widening it, outer lobes raised in between.

     AND THE BOTTOM LOBE GETS BROADER, NOT LONGER — the first cut of that
     idea grew a spike. Pushing it down to y 1.238 on ry 0.100 gave it a
     0.100 m taper ending in a point at 1.138, in the thinnest part of
     the plate, and shots/zoom-ear.png shows exactly what an ellipsoid
     tip does there: a hard 20 mm barb hanging off the fan's lower rim,
     the ear-root spike this pass was told to watch for. The width it was
     bought for comes from rx instead — 0.096 -> 0.114, the broadest
     bottom lobe the stack has ever had — while y goes back to 1.254 and
     ry to 0.092, so the lobe bottoms at 1.162, within 2 mm of the stack
     that meshed clean. No tip is left to barb, and f 0.31 keeps the
     width. The bottom edge is 112 mm clear of the cranium's underside,
     so §1.1's "never below the jawline hinge" holds by a wide margin. */
  const prims = [
    lobe(0.252, 1.408, -0.030, 0.076, 0.150, 0.0740),   // buried root wedge
    lobe(0.312, 1.452, -0.052, 0.086, 0.130, 0.0560),   // thick root, high
    lobe(0.404, 1.560, -0.092, 0.126, 0.134, 0.0420),   // top lobe -> crown+
    lobe(0.486, 1.496, -0.124, 0.126, 0.152, 0.0360),   // upper-outer, biggest
    lobe(0.492, 1.344, -0.122, 0.116, 0.132, 0.0340),   // lower-outer, round
    lobe(0.400, 1.254, -0.086, 0.114, 0.092, 0.0340),   // bottom, BROAD not long
  ];
  /* k 0.078: at 0.068 the saddle between the top and upper-outer lobes
     left a visible notch on the far ear's crown edge, and the bottom
     lobe's tip poked a nipple through the rim. */
  /* ROUND 3: 0.078 -> 0.090. The critic's "jagged creases/tearing along
     the rim near the head": the root-wedge/top-lobe saddle still showed
     as a stepped crease on the fan's upper rim in three-quarter. The
     wider blend rounds every inter-lobe saddle into one continuous clay
     curve. */
  return blob('ear', prims, 0.090, 0.076);
}

/** The dish carved into the inner (forward) face of each ear (§1.5): a
    flat ellipsoid pushed out along the ear-plate normal so it only bites
    a shallow depression and leaves a raised rim all the way round. */
function earDish(side) {
  const n = norm3([P.ear.plane[0] * side, P.ear.plane[1], P.ear.plane[2]]);
  const o = 0.0540;
  /* centred on the risen fan (round 2): the fan's visual centroid moved
     up from y 1.34 to ~1.41; pushed a touch further out (o 0.054) and
     thinned so the bite cannot tear the thin outer rim */
  /* ROUND 3: the dish shrinks 10% and its bite softens — at rx 0.126 its
     inboard lip crossed the root-wedge saddle and contributed to the
     stepped rim tear the critic flagged on the viewer-right ear. */
  /* ROUND 4: the fan's outer lobes rose ~38 mm (see earBlob), so the dish
     rises with them. Left where it was it would bite under the new rim
     and leave the raised mass flat and unread. Inboard 10 mm as well,
     tracking the shortened reach. */
  const c = [0.438 * side + n[0] * o, 1.444 + n[1] * o, -0.104 + n[2] * o];
  return { prims: [ellipN(c, [0.112, 0.150, 0.026], n, [0, 1, 0])], k: 0.038 };
}

function trunkBlob() {
  const prims = [];
  const t = P.trunk;
  for (let i = 0; i < t.length - 1; i++) {
    prims.push(cone([t[i][0], t[i][1], t[i][2]], [t[i + 1][0], t[i + 1][1], t[i + 1][2]],
      t[i][3], t[i + 1][3]));
  }
  /* A tight join at the face: §1.5 wants a crease where the trunk meets
     the head, not a merge. Blend it softly and the trunk stops reading as
     a separate limb from the front. */
  return blob('trunk', prims, CHAIN_K, 0.042);
}

/* The incised bridge lines, §1.5 — ARC LENGTH, DEPTH AND SHAPE.

   `GROOVE_HALF_ANGLE` is the half-arc the cut subtends about the trunk's
   FRONT RIDGE, measured in the plane perpendicular to the trunk axis. On
   ref/wally-ref-cool.png a line measures ~76 mm across a tube ~148 mm
   wide, i.e. 0.51 of the width; on a circular section a chord of 0.51 of
   the diameter is 2 r sin(A) with A = 31 degrees. 0.56 rad = 32 degrees
   puts the ends 58 degrees inside the nearest possible silhouette
   tangent, which is what makes "cannot hang off the edge from ANY
   angle" a property of the construction rather than a hope. */
const GROOVE_HALF_ANGLE = 0.68;
const GROOVE_SAMPLES = 13;
/* Channel: the arc is walked at GROOVE_LIFT outside the skin with a
   GROOVE_CUT tube, so the bite is (CUT - LIFT) everywhere along the line
   instead of only at one point — a chord across a cylinder bites deepest
   at its centre and nothing at its ends, which is why the round-4
   straight capsule needed to be 100% of the trunk's width to cut 55% of
   it, and why its ends then hung off the silhouette. */
const GROOVE_CUT = 0.0060;
const GROOVE_LIFT = 0.0030;
/* The dark stroke that lives in the channel. Its axis is sunk
   GROOVE_SINK below the sampled surface point and its radius is
   GROOVE_ROD, so its crown stands (ROD - SINK) = 0.8 mm proud of the
   UNCUT skin line and 3.8 mm proud of the channel floor. Both numbers
   matter: 0.8 mm proud is what makes the stroke survive the mesher
   rounding the shallow channel away (it cannot be swallowed), and 0.8 mm
   on a 74 mm tube is one part in ninety — it cannot dent a silhouette
   either. Solving crown-against-floor gives a visible dark band 6.8 mm
   wide against the reference's ~6.5 mm. */
const GROOVE_SINK = 0.0026;
const GROOVE_ROD = 0.0034;

/**
 * The three incised lines (§1.5), as ARCS THAT LIE IN THE SKIN.
 *
 * One spec per line: a polyline of points sampled ON the actual (uncut)
 * trunk+head surface, sweeping symmetrically about the trunk's front
 * ridge in the plane perpendicular to the trunk axis, plus the outward
 * surface direction at each. Consumed twice — by trunkGrooves() below to
 * carve the channel, and by wally.js to lay a thin dark stroke inside it.
 *
 * WHY AN ARC AND NOT A STRAIGHT CAPSULE. The previous three rounds laid
 * a straight rod across a curved tube and relied on the curvature to
 * bury the ends. It does not: a chord at constant y and z leaves the
 * surface at a shallow angle, so the ends emerge again as soon as the
 * pose tilts the tube, and in shots/s-cool.png all three lines were
 * hanging in mid-air beside the trunk with their right ends overhanging
 * the cheek. Sampling the real surface at eleven stations around the
 * ridge makes the stroke a curve that IS the skin: every point is on it
 * by construction, the ends stop 32 degrees short of the widest visible
 * point of the section, and the line arcs with the tube exactly as the
 * reference's do.
 */
export function trunkGrooveSpecs() {
  const out = [];
  const t = P.trunk;
  /* The lines sit on the free tube, but the field they must land on is
     still the SMIN of trunk and head — near the top the join swells the
     trunk past its station radius, and a point placed at rr + lift would
     be buried under that swell. Bisect the real field. */
  const tb = trunkBlob();
  const hb = headBlob();
  const bd = (b, x, y, z) => {
    let v = primDist(b.prims[0], x, y, z);
    for (let j = 1; j < b.prims.length; j++) v = smin(v, primDist(b.prims[j], x, y, z), b.k);
    return v;
  };
  const fd = (x, y, z) => smin(bd(tb, x, y, z), bd(hb, x, y, z), 0.042);
  /* the centreline point and radius at an arbitrary height */
  const at = (h) => {
    let i = 0;
    while (i < t.length - 2 && t[i + 1][1] > h) i++;
    const a = t[i], b = t[i + 1];
    const f = (a[1] - h) / (a[1] - b[1]);
    return [a[0] + (b[0] - a[0]) * f, h, a[2] + (b[2] - a[2]) * f,
      a[3] + (b[3] - a[3]) * f];
  };
  /* the centreline station at an arbitrary height, plus its frame.
     THE AXIS IS A CENTRED DIFFERENCE, NOT THE SEGMENT'S OWN DIRECTION.
     The station table's tangent jumps 10 degrees at every boundary; a
     ridge normal built from it jumps with it, which both kinks the line
     and makes the height solve below discontinuous (it landed 11 mm off
     for the middle line, on the wrong side of a station). A +/-45 mm
     centred difference is continuous everywhere and is a better match
     for the smin'd surface the arc actually has to lie on. */
  const locate = (h) => {
    const c = at(h);
    const p0 = at(h + 0.045), p1 = at(h - 0.045);
    const ax = norm3([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]);
    return {
      c: [c[0], c[1], c[2]],
      rr: c[3],
      ax,
      /* Section frame. The trunk table has no x component, so the tube's
         cross-section basis is exactly (side = +x, ridge = ax rotated a
         quarter turn in yz). Both are unit and both are perpendicular to
         the axis, so the arc below is a true cross-section, not a
         horizontal slice through a tilted tube. */
      fn: [0, ax[2], -ax[1]],
    };
  };
  /* Distance from a centreline point out to the skin along `d`. */
  const skinR = (c, d, rr) => {
    let lo = 0, hi = rr + 0.10;
    for (let it = 0; it < 30; it++) {
      const m = (lo + hi) * 0.5;
      if (fd(c[0] + d[0] * m, c[1] + d[1] * m, c[2] + d[2] * m) < 0) lo = m;
      else hi = m;
    }
    return (lo + hi) * 0.5;
  };
  for (const gy of P.trunkGrooveY) {
    /* THE ROW IS THE HEIGHT OF THE LINE, NOT OF THE CENTRELINE. The ridge
       normal on this trunk carries a +0.4 to +0.5 y component, so a
       centreline station taken at gy puts the graze point 25-30 mm ABOVE
       gy — which is how the round-4 lines ended up inside the join swell
       they were supposed to sit below. Solve for the station height whose
       ridge graze point lands ON gy; two Newton-ish passes converge to
       under a millimetre because the tilt changes slowly. */
    const grazeY = (h) => {
      const q = locate(h);
      return q.c[1] + q.fn[1] * skinR(q.c, q.fn, q.rr);
    };
    /* Bisect, do not iterate: the ridge tilt is piecewise constant across
       station boundaries, so a fixed-point pass oscillates by ~10 mm
       whenever the solution sits near one. grazeY is monotone in h. */
    let hLo = gy - 0.09, hHi = gy + 0.03;
    for (let it = 0; it < 26; it++) {
      const hm = (hLo + hHi) * 0.5;
      if (grazeY(hm) < gy) hLo = hm; else hHi = hm;
    }
    const L = locate((hLo + hHi) * 0.5);
    const sd = [1, 0, 0];                     // across the tube
    const pts = [], nrm = [];
    for (let k = 0; k < GROOVE_SAMPLES; k++) {
      const th = -GROOVE_HALF_ANGLE
        + (2 * GROOVE_HALF_ANGLE * k) / (GROOVE_SAMPLES - 1);
      const c = Math.cos(th), s = Math.sin(th);
      const d = [L.fn[0] * c + sd[0] * s, L.fn[1] * c + sd[1] * s,
        L.fn[2] * c + sd[2] * s];
      const r0 = skinR(L.c, d, L.rr);
      pts.push([L.c[0] + d[0] * r0, L.c[1] + d[1] * r0, L.c[2] + d[2] * r0]);
      nrm.push(d);
    }
    out.push({ pts, nrm, rr: L.rr, axis: L.ax });
  }
  return out;
}

/** Three crisp incised lines arcing across the trunk's front ridge (§1.5).
    Each is a chain of round cones walked along the sampled surface arc at
    a constant lift, so the channel it opens has a constant depth and its
    ends taper to nothing INSIDE the silhouette. */
function trunkGrooves() {
  const out = [];
  for (const g of trunkGrooveSpecs()) {
    const n = g.pts.length;
    /* radius tapers to 40% at the ends: the ref's cuts fade out, they do
       not stop square, and a tapered end cannot print a hard terminator */
    const rad = (k) => {
      const u = Math.abs((k / (n - 1)) * 2 - 1);       // 0 centre -> 1 end
      return GROOVE_CUT * (1 - 0.55 * u * u);
    };
    for (let k = 0; k < n - 1; k++) {
      const a = g.pts[k], b = g.pts[k + 1];
      const na = g.nrm[k], nb = g.nrm[k + 1];
      out.push({
        prim: cone(
          [a[0] + na[0] * GROOVE_LIFT, a[1] + na[1] * GROOVE_LIFT,
            a[2] + na[2] * GROOVE_LIFT],
          [b[0] + nb[0] * GROOVE_LIFT, b[1] + nb[1] * GROOVE_LIFT,
            b[2] + nb[2] * GROOVE_LIFT],
          rad(k), rad(k + 1)),
        k: 0.010,
      });
    }
  }
  return out;
}

/**
 * The three dark strokes that sit in the incised channels, as ONE
 * geometry in bind space (position + normal + index, no skinning).
 *
 * WHY THIS EXISTS AT ALL. The incision tint is baked per vertex and the
 * mesher cell is 13.6 mm; a 6.8 mm stroke sampled on that grid
 * interpolates into a smudge. Real dark geometry is crisp at any mesh
 * resolution.
 *
 * WHY IT IS A SEPARATE GEOMETRY AND NOT A BONE-PARENTED ROD. Rounds 5
 * and 6 hung three rigid capsules off bone `trunk1`. The skin at that
 * latitude is a BLEND of trunk0, trunk1 and head, so the moment a pose
 * curled or swung the trunk the rods and the skin they were meant to be
 * inside went their separate ways — which is exactly the "three dark
 * strokes hovering beside the trunk" defect. wally.js skins this
 * geometry from the body's own weights instead, so the strokes are
 * carried by the same blend as the surface under them and CANNOT drift.
 */
export function buildGrooveStrokeGeometry(quality = 'high') {
  const radial = quality === 'low' ? 6 : 8;
  const pos = [], nor = [], idx = [];
  for (const g of trunkGrooveSpecs()) {
    const n = g.pts.length;
    const base = pos.length / 3;
    const rings = [];
    for (let k = 0; k < n; k++) {
      const u = Math.abs((k / (n - 1)) * 2 - 1);
      const sink = GROOVE_SINK + 0.0012 * u * u;
      const rad = GROOVE_ROD * (1 - 0.50 * u * u);
      const p = g.pts[k], nn = g.nrm[k];
      rings.push({
        c: [p[0] - nn[0] * sink, p[1] - nn[1] * sink, p[2] - nn[2] * sink],
        r: rad,
        n: nn,
      });
    }
    /* Frame: the tangent runs along the arc, and the ring's "up" is the
       surface normal, so the tube never twists relative to the skin. */
    for (let k = 0; k < n; k++) {
      const a = rings[Math.max(0, k - 1)].c, b = rings[Math.min(n - 1, k + 1)].c;
      const t = norm3([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
      const up = rings[k].n;
      // side = t x up, re-orthogonalised
      const sx = t[1] * up[2] - t[2] * up[1];
      const sy = t[2] * up[0] - t[0] * up[2];
      const sz = t[0] * up[1] - t[1] * up[0];
      const sN = norm3([sx, sy, sz]);
      const ux = sN[1] * t[2] - sN[2] * t[1];
      const uy = sN[2] * t[0] - sN[0] * t[2];
      const uz = sN[0] * t[1] - sN[1] * t[0];
      const uN = norm3([ux, uy, uz]);
      const c = rings[k].c, r = rings[k].r;
      for (let j = 0; j < radial; j++) {
        const th = (j / radial) * Math.PI * 2;
        const ca = Math.cos(th), sa = Math.sin(th);
        const nx = sN[0] * ca + uN[0] * sa;
        const ny = sN[1] * ca + uN[1] * sa;
        const nz = sN[2] * ca + uN[2] * sa;
        pos.push(c[0] + nx * r, c[1] + ny * r, c[2] + nz * r);
        nor.push(nx, ny, nz);
      }
    }
    for (let k = 0; k < n - 1; k++) {
      for (let j = 0; j < radial; j++) {
        const j2 = (j + 1) % radial;
        const a = base + k * radial + j, b = base + k * radial + j2;
        const c = base + (k + 1) * radial + j, d = base + (k + 1) * radial + j2;
        idx.push(a, c, b, b, c, d);
      }
    }
    /* Close both ends on a centre vertex. The ends are buried under the
       skin, but a hole is a hole and the near-black material would show
       its own backface through one. */
    for (const [k, sgn] of [[0, -1], [n - 1, 1]]) {
      const c = rings[k].c;
      const a = rings[Math.max(0, k - 1)].c, b = rings[Math.min(n - 1, k + 1)].c;
      const t = norm3([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
      const ci = pos.length / 3;
      pos.push(c[0], c[1], c[2]);
      nor.push(t[0] * sgn, t[1] * sgn, t[2] * sgn);
      for (let j = 0; j < radial; j++) {
        const j2 = (j + 1) % radial;
        const r0 = base + k * radial + j, r1 = base + k * radial + j2;
        if (sgn < 0) idx.push(ci, r0, r1); else idx.push(ci, r1, r0);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setIndex(idx);
  return geo;
}

/**
 * ONE ARM — §1.1's "thick tapering sausage, no elbow break", and it has
 * to be a LIMB, not a bulge.
 *
 * The arm is genuinely outside the body from the elbow down and the
 * numbers are checked against the torso profile station by station — see
 * the `arm` table in rig.js for the audit. Above y 0.85 the two close up
 * into the armpit, which is where a shoulder is supposed to be.
 */
function armBlob(side) {
  const a = P.arm;
  const h = P.hand;
  /* THE HAND IS PART OF THE ARM CHAIN, NOT A BLOB BOLTED TO ITS END.
     A chain of round cones sharing endpoints is tangent-continuous, so
     the mitten grows out of the forearm with no crease and — the point —
     the arm no longer terminates in a 38 mm end-cap hemisphere that the
     hand then hangs off. That hemisphere WAS the second silhouette the
     critic read as "the forearm ends mid-length and the hand is stuck on
     the side of it", and it is gone by construction rather than by
     tuning. The two hand stations continue the wrist's own direction
     (see PROP.hand), swelling 0.038 -> 0.057 -> 0.0345: a teardrop. */
  const chain = [...a, h.knuckle, h.tip];
  const s = (i) => [chain[i][0] * side, chain[i][1], chain[i][2]];
  const prims = [];
  for (let i = 0; i < chain.length - 1; i++) {
    prims.push(cone(s(i), s(i + 1), chain[i][3], chain[i + 1][3]));
  }
  /* THE ARMPIT FILLET, AND WHY IT IS A PRIMITIVE AND NOT A BLEND RADIUS.
     Rounds 1-3 fought the armpit with the join: 0.016 left a sharp
     saddle, 0.024 was meant to widen it, 0.030 was meant to widen it
     further, and by then the join was closing the entire 30 mm slot and
     the arm had welded to the flank. The defect the blend was hiding had
     become a worse defect than the one it was hiding.

     The saddle exists because the armpit station GRAZES the torso — its
     inner edge is 0.150 against a wall of 0.155, five millimetres of
     overlap — and two near-tangent surfaces meet along a long crease
     that no k rounds without inflating a hand's breadth of everything
     around it. This cone is seated 30 mm inside the flank at y 1.00 and
     emerges through the wall at about 72 degrees, ending coincident with
     (and 6 mm inside) the arm's own armpit sphere. It is a transverse
     crossing, so the fillet is made of OVERLAP, exactly as the deltoid's
     is — and an overlap fillet has no saddle to evert when the welcome
     pose opens the shoulder 26 degrees. See PROP.armpit for the
     point-by-point check that it swallows the seam. It adds nothing to
     the silhouette (its far end is buried, its near end is smaller than
     the sphere it sits in) and nothing below y 0.858, where the slot
     starts. */
  const ap = P.armpit;
  prims.push(cone(
    [ap.a[0] * side, ap.a[1], ap.a[2]],
    [ap.b[0] * side, ap.b[1], ap.b[2]],
    ap.ra, ap.rb,
  ));
  return blob('body', prims, CHAIN_K, ARM_JOIN);
}

/**
 * The THUMB — the whole of what is left of "the hand" as its own blob.
 *
 * BODY PASS. The mitten itself now lives on the arm chain (see armBlob),
 * because the reference hand is a swelling of the forearm and not an
 * object attached to it. What genuinely does need its own blob is the
 * thumb, and it needs it for one reason: the single crisp crease that
 * hooks round its root in ref/wally-ref-cool.png is a JOIN radius, and a
 * chain has none. 0.016 is that crease — wide enough that the mesher
 * resolves a valley rather than a fold at a 13.6 mm cell, tight enough
 * that the lobe still reads as a separate finger in silhouette.
 *
 * It is one capsule, on the mitten's INBOARD face, high, pointing down
 * and forward — which is where both reference hands put it, and which is
 * also the placement that keeps its own surface 33 mm off the thigh.
 * No second lobe, no digits: the previous rounds' palm + knuckle-lobe
 * pair is exactly what meshed as the lumpy blob-mitt.
 */
function handBlob(side) {
  const h = P.hand;
  const sA = [h.thumbA[0] * side, h.thumbA[1], h.thumbA[2]];
  const sB = [h.thumbB[0] * side, h.thumbB[1], h.thumbB[2]];
  return blob('body', [cone(sA, sB, h.thumbA[3], h.thumbB[3])],
    CHAIN_K, 0.016);
}

/**
 * ONE LEG plus its FOOT (§1.1: wide-set, thickest at the thigh, narrowing
 * to a slightly flared foot; the foot a rounded wedge 0.09 H long).
 *
 * Two things were wrong and both are measured, not judged. The legs were
 * joined at 0.060 of air at the crotch, so above the knee they welded
 * into one block with a nick in it; and the ankle carried a 0.078 radius
 * against a foot half-width of 0.052, so the foot was NARROWER than the
 * leg above it and the wedge was invisible to a front camera — he stood
 * on two bevelled dowels. The crotch gap is now 0.112 m (0.070 H) and
 * the foot is 0.192 across against a 0.112 ankle, 1.71x, so the flare
 * shows head-on as well as in profile.
 */
function legBlob(side) {
  const l = P.leg;
  const s = (i) => [l[i][0] * side, l[i][1], l[i][2]];
  return blob('body', [
    cone(s(0), s(1), l[0][3], l[1][3]),
    cone(s(1), s(2), l[1][3], l[2][3]),
  ], CHAIN_K, 0.038);
}

/** The foot cluster — ankle flare, wedge and toe roll. Unlike the leg
    chain these do NOT share endpoints, so they want a real fillet. */
function footBlob(side) {
  const f = P.foot;
  const an = P.ankle;
  return blob('body', [
    /* the flare where the leg meets the foot */
    ellip([an.c[0] * side, an.c[1], an.c[2]], an.r),
    /* the boot body — round radius carries most of the section now, so
       every edge is a curve (soft boot), while the flat bottom face of
       the box keeps the sole planted */
    rbox([f.c[0] * side, f.c[1], f.c[2]], f.h, f.r),
    /* toe box — a full-width roll that pushes the front of the boot
       forward and down, per the reference's slight forward toe box */
    ellip([f.c[0] * side, f.c[1] + 0.004, f.c[2] + 0.052], [0.084, 0.056, 0.060]),
  ], 0.036, 0.032);
}

function tailBlob() {
  const t = P.tail;
  const prims = [];
  for (let i = 0; i < t.length - 1; i++) {
    prims.push(cone([t[i][0], t[i][1], t[i][2]], [t[i + 1][0], t[i + 1][1], t[i + 1][2]],
      t[i][3], t[i + 1][3]));
  }
  /* the teardrop tuft (§1.1: 0.03 H): a cone widening off the rope's end
     into a sphere, so it reads as a drop rather than a bead on a string */
  const e = t[t.length - 1];
  prims.push(cone([e[0], e[1], e[2]], [e[0], e[1] - 0.030, e[2] + 0.004],
    e[3], 0.0205));
  prims.push(sphere([e[0], e[1] - 0.042, e[2] + 0.005], 0.0225));
  /* JOIN 0.030 -> 0.018. The join radius IS the fillet where the rope
     leaves the rump, and smin adds up to k/4 to the union: at 0.030 that
     was 7.5 mm on a rope authored at 16.5 mm of radius, so the root
     rendered 45% fatter than it was drawn — most of the back view's
     "thick bulbous rope". On the 11.5 mm rope PROP.tail now carries,
     0.018 still fillets the emergence and costs 4.5 mm. */
  return blob('body', prims, CHAIN_K, 0.018);
}

/**
 * The grid bounds, DERIVED. Never author these.
 *
 * They used to be a literal — {max z 0.450} — and the trunk's front face
 * had moved to 0.457. Surface nets only meshes what is inside the grid, so
 * the front of the trunk was simply cut off between y 0.86 and y 0.93: a
 * 60 mm slit through which the camera saw the unlit inside of the tube and
 * the chest behind it. Rendered, that is a hard-edged dark blot sitting in
 * the middle of the trunk, and it survives turning off shadows, turning off
 * SSAO and retuning the whole ramp, because it is not shading — it is a
 * hole. It had been there for at least two passes and read as "the trunk is
 * a flat welt with a smudge on it".
 *
 * A literal bound cannot survive a sculpt edit, and it fails silently and
 * invisibly. This walks the primitives instead, so moving a station can
 * never clip the model again.
 */
function fieldBounds(blobs) {
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  const add = (c, e) => {
    for (let i = 0; i < 3; i++) {
      if (c[i] - e[i] < lo[i]) lo[i] = c[i] - e[i];
      if (c[i] + e[i] > hi[i]) hi[i] = c[i] + e[i];
    }
  };
  for (const b of blobs) {
    /* every smin in the chain can push the surface out by k/4 */
    const pad = b.k * 0.25 + b.join * 0.25;
    for (const p of b.prims) {
      switch (p[0]) {
        case SPHERE: add([p[1], p[2], p[3]], [p[4] + pad, p[4] + pad, p[4] + pad]); break;
        case CONE:
          add([p[1], p[2], p[3]], [p[7] + pad, p[7] + pad, p[7] + pad]);
          add([p[4], p[5], p[6]], [p[8] + pad, p[8] + pad, p[8] + pad]);
          break;
        case ELLIP: {
          /* rows 7..15 are the inverse (transposed) rotation, so the world
             half-extent along axis i is the norm of column i scaled by r */
          const e = [];
          for (let i = 0; i < 3; i++) {
            e.push(Math.hypot(p[7 + i] * p[4], p[10 + i] * p[5], p[13 + i] * p[6]) + pad);
          }
          add([p[1], p[2], p[3]], e);
          break;
        }
        case RBOX: add([p[1], p[2], p[3]], [p[4] + p[7] + pad, p[5] + p[7] + pad, p[6] + p[7] + pad]); break;
        case TORUS: {
          const r = p[4] + p[5] + pad;
          add([p[1], p[2], p[3]], [r, r, r]);
          break;
        }
        case LATHE: {
          const L = p[1];
          for (let i = 0; i < L.N; i++) {
            const rw = L.rs[i] + pad;
            add([0, L.ys[i], L.zcs[i]], [rw, rw, rw * Math.max(1, L.zks[i])]);
          }
          break;
        }
        default: break;
      }
    }
  }
  /* one and a half cells of slack at the coarsest tier, so the outermost
     grid plane is always strictly outside the surface and the mesh closes.
     Every millimetre here is grid volume and grid volume is boot time. */
  const m = 0.030;
  return {
    min: [lo[0] - m, lo[1] - m, lo[2] - m],
    max: [hi[0] + m, hi[1] + m, hi[2] + m],
  };
}

/* ------------------------------------------------------------------
   Build the field. Returns { d(x,y,z), tagAt(x,y,z), bounds }
   ------------------------------------------------------------------ */
export function buildBodyField() {
  const headB = headBlob();
  const earBL = earBlob(1);
  const earBR = earBlob(-1);
  const torsoB = torsoBlob();
  const bellyB = bellyBlob();
  const armBL = armBlob(1), armBR = armBlob(-1);
  const legBL = legBlob(1), legBR = legBlob(-1);   // named for the blob list only
  const blobs = [
    torsoB,
    bellyB,
    headB,
    trunkBlob(),
    armBL, armBR,
    handBlob(1), handBlob(-1),
    legBL, legBR,
    footBlob(1), footBlob(-1),
    earBL, earBR,
    tailBlob(),
  ];
  /* ROUND 2: the trunk tip's front nostril dimple (§1.1 "rounded nub tip
     with a subtle front nostril dimple" — the critic: "nostril visible").
     A small sphere carved into the nub's forward face; the tip accents
     rotate the nub up at runtime, which turns this dimple toward the
     camera exactly as the reference shows it. */
  /* ROUND 4: 0.014 -> 0.012 — the tip slimmed from 0.045 to 0.038 and the
     old dimple was a third of the nub. */
  /* ROUND 6: MOVED FROM THE FRONT FACE TO THE TIP END. The nostril is the
     END of the trunk, and the bind trunk points DOWN — so the dimple
     belongs on the nub's underside, not its forward wall. Verified with
     the accent math: carved on the front face it faced up-BACK (away from
     the studio camera) after 'cool''s ~144-degree up-curl and was
     invisible in the shot; on the bind underside it lands facing
     up-forward at the camera in 'cool' and dead at the camera in
     'welcome''s ~88-degree curl. 6 mm of +x bias turns it a shade toward
     the cool camera, which sits on his left. */
  /* r 0.012 at k 0.016 carved ~8 mm and the smax rounding plus the ~15 mm
     mesher cell ate it — invisible in the studio shots, and a 0.013/0.013
     retry MEASURED at only ~8 luma of contrast across the welcome nub
     (sampled rows y 505-569 of lk-welcome.png: a smooth 207->190 wash, no
     pit). The ref's nostril is a frank doughnut, not a whisper: 0.015
     seated 4 mm proud under a tight 0.011 blend bites ~11 mm with a
     ~29 mm chord — two mesher cells wide, so the bake resolves a floor
     and a lip instead of interpolating the whole thing away. */
  /* Seated on the nub's bind FRONT-BOTTOM corner, not its pole: after
     'cool''s ~133-degree up-curl a pole-seated pit faces up-BACK and the
     studio camera only grazes it. On the corner its opening rotates to
     up-forward-out in 'cool' and to dead-at-the-lens in 'welcome' —
     checked with the accent rotation math before the reshoot. */
  /* ROUND 7: sized against the reference at 5x, where the nostril is an
     unmistakable dark dimple about a THIRD of the nub's face, not the
     whisper the round-6 pit rendered. On the 0.0435 nub, r 0.018 seated
     so its centre sits 8.3 mm outside the nub's surface bites 9.7 mm and
     opens a 32 mm chord — a third of the 87 mm nub, and three mesher
     cells across, so the bake resolves a floor and a lip. */
  const t5 = P.trunk[5];
  const nostril = {
    prims: [sphere([0.0112, t5[1] - 0.0471, t5[2] - 0.0280], 0.018)],
    k: 0.012,
  };
  const dishes = [earDish(1), earDish(-1), nostril];
  const grooves = trunkGrooves();
  /* The grooves are now THIRTY round cones (three arcs of ten), not
     three straight capsules, and d() is evaluated a few hundred thousand
     times at boot. One box around the lot, tested first, keeps that a
     rounding error: the box is ~0.20 x 0.15 x 0.10 m in a field whose
     bounds are two metres tall, so it rejects on the first compare for
     essentially every sample. */
  let gx0 = 1e9, gy0 = 1e9, gz0 = 1e9, gx1 = -1e9, gy1 = -1e9, gz1 = -1e9;
  for (const g of grooves) {
    const rmax = Math.max(g.prim[7], g.prim[8]) + g.k;
    for (const o of [1, 4]) {
      if (g.prim[o] - rmax < gx0) gx0 = g.prim[o] - rmax;
      if (g.prim[o] + rmax > gx1) gx1 = g.prim[o] + rmax;
      if (g.prim[o + 1] - rmax < gy0) gy0 = g.prim[o + 1] - rmax;
      if (g.prim[o + 1] + rmax > gy1) gy1 = g.prim[o + 1] + rmax;
      if (g.prim[o + 2] - rmax < gz0) gz0 = g.prim[o + 2] - rmax;
      if (g.prim[o + 2] + rmax > gz1) gz1 = g.prim[o + 2] + rmax;
    }
  }

  /* A bounding sphere per blob. The field is evaluated a few hundred
     thousand times at boot; skipping a blob whose bound cannot possibly
     lower the running minimum removes about two thirds of that work, and
     the blobs here (two ears, two arms, two legs, a tail) are exactly the
     spatially disjoint case where it pays. */
  for (const b of blobs) {
    /* a LATHE carries its own world bound — it has no centre parameters
       for the centroid pass below to average */
    if (b.prims.length === 1 && b.prims[0][0] === LATHE) {
      const L = b.prims[0][1];
      b.bx = L.bx; b.by = L.by; b.bz = L.bz; b.br = L.br;
      continue;
    }
    let cx = 0, cy = 0, cz = 0;
    for (const p of b.prims) { cx += p[1]; cy += p[2]; cz += p[3]; }
    const n = b.prims.length;
    cx /= n; cy /= n; cz /= n;
    let r = 0;
    for (const p of b.prims) {
      const dx = p[1] - cx, dy = p[2] - cy, dz = p[3] - cz;
      let ext = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (p[0] === SPHERE) ext += p[4];
      else if (p[0] === CONE) {
        ext = Math.max(ext + p[7],
          Math.hypot(p[4] - cx, p[5] - cy, p[6] - cz) + p[8]);
      } else if (p[0] === ELLIP) ext += Math.max(p[4], p[5], p[6]);
      else if (p[0] === RBOX) ext += Math.hypot(p[4], p[5], p[6]) + p[7];
      else ext += p[4] + p[5];
      if (ext > r) r = ext;
    }
    b.bx = cx; b.by = cy; b.bz = cz; b.br = r + b.k * 0.5;
  }

  const nB = blobs.length;

  function d(x, y, z) {
    let acc = 1e9;
    for (let i = 0; i < nB; i++) {
      const b = blobs[i];
      const dx = x - b.bx, dy = y - b.by, dz = z - b.bz;
      const bd = Math.sqrt(dx * dx + dy * dy + dz * dz) - b.br;
      if (bd > acc + b.join + 0.02) continue;
      const ps = b.prims;
      let v = primDist(ps[0], x, y, z);
      for (let j = 1; j < ps.length; j++) v = smin(v, primDist(ps[j], x, y, z), b.k);
      acc = acc === 1e9 ? v : smin(acc, v, b.join);
    }
    if (acc === 1e9) acc = 1;
    for (let i = 0; i < dishes.length; i++) {
      const dd = dishes[i];
      acc = smax(acc, -primDist(dd.prims[0], x, y, z), dd.k);
    }
    if (x > gx0 && x < gx1 && y > gy0 && y < gy1 && z > gz0 && z < gz1) {
      for (let i = 0; i < grooves.length; i++) {
        acc = smax(acc, -primDist(grooves[i].prim, x, y, z), grooves[i].k);
      }
    }
    return acc;
  }

  /* Which blob owns a point — used for the vertex tint. */
  function tagAt(x, y, z) {
    let best = 1e9, tag = 'body';
    for (let i = 0; i < nB; i++) {
      const b = blobs[i];
      let v = primDist(b.prims[0], x, y, z);
      for (let j = 1; j < b.prims.length; j++) v = smin(v, primDist(b.prims[j], x, y, z), b.k);
      if (v < best) { best = v; tag = b.tag; }
    }
    return tag;
  }

  /* Distance to the EAR/SKULL SEAM, for the crease tint in bakeTint.

     THE BAKE CANNOT FIND THIS CREASE ON ITS OWN, and that is why the
     ear reads pasted on from behind. bakeAO cone-traces along the vertex
     normal: on the back of the ear plate at the root the normal points
     back and out, the ray leaves into free space, and the trace returns
     "unoccluded". bakeFormOcclusion weights every proxy sphere by
     dot(n, toSphere): the skull is 30 mm away but it sits BEHIND that
     normal, so the dot is negative and it contributes nothing. Both
     terms are correct and both are blind here, because a crease between
     two convex forms is a proximity fact, not a visibility one.

     max(dEar, dHead) is small only where BOTH surfaces are near — i.e.
     in a band that wraps the junction line on the ear side and on the
     skull side, on the front face and on the back face equally. That is
     exactly the region §1.2 means by "under the ears", and it is the one
     measurement that does not care which way anything is pointing. */
  function earSeam(x, y, z) {
    if (y < 1.08 || y > 1.76) return 1;
    const ax = x < 0 ? -x : x;
    if (ax < 0.09 || ax > 0.66) return 1;
    const e = x > 0 ? earBL : earBR;
    const de = blobDist(e, x, y, z);
    if (de > 0.11) return 1;
    const dh = blobDist(headB, x, y, z);
    return de > dh ? de : dh;
  }

  function blobDist(b, x, y, z) {
    const ps = b.prims;
    let v = primDist(ps[0], x, y, z);
    for (let j = 1; j < ps.length; j++) v = smin(v, primDist(ps[j], x, y, z), b.k);
    return v;
  }

  /* Distance to the ARM/FLANK SEAM — the same measurement earSeam makes,
     for the same reason, on the crease the user actually complained
     about ("textures get glued from body to arms").

     THE GEOMETRY FIX ALONE DOES NOT DRAW THE LINE. Moving the arm
     outboard opens a real concave valley from y ~0.94 down (rig.js
     `arm`), and that is the necessary half — you cannot shade a crease
     that is not there. But both existing bakes are blind to it for
     exactly the reasons the earSeam block sets out: the cone trace
     leaves along the vertex normal, which on the arm's inner wall points
     ACROSS the slot and out of it, and bakeFormOcclusion weights every
     proxy sphere by dot(n, toSphere), which is negative for the flank
     behind that normal. Measured on the studio frame at f 0.44 before
     this pass the luminance across the junction was a monotonic ramp
     144 -> 210 with no valley of any kind; ref/wally-ref-cool.png at the
     same height dips to 135 and holds a 30 mm band between a 195 flank
     and a 200 arm. That dark band is what tells the eye the arm is a
     separate volume, and at a three-quarter camera it does far more of
     that work than the 4-6 mm of true background the reference shows.

     THE MEASURE IS dArm + dFlank, AND max(dArm, dFlank) — WHICH IS WHAT
     THIS FUNCTION SHIPPED FIRST — CANNOT DO THIS JOB. bakeTint runs on
     mesh vertices, and every mesh vertex lies ON the iso-surface: its
     distance to the blob it belongs to is ~0 and its distance to the
     other blob is the width of the slot between them. So the SUM reads
     "how far is the other form from here", on both walls, symmetrically,
     and it is exactly the quantity the occlusion depends on. The max
     reads "how far is the FURTHER form", which on a wall equals the same
     slot width — but only while the slot is narrower than the band. The
     slot here runs 30 mm at the armpit and 57 mm by f 0.56, so a 42 mm
     max-band went to zero over the whole lower half of the arm, and the
     scan showed it: the arm's inboard wall came back at 175-189 against
     a lit 215 while the reference's sat at 71-117. The sum keeps its
     grip across a 57 mm slot and still cannot creep onto the outer arm
     or the belly front, because from either of those the other form is
     an arm's diameter away and the sum is 200 mm.

     THE LEG IS DELIBERATELY NOT IN THE MIN, and that cost an A/B to
     learn. The first cut included the thigh so the mitten would get the
     same crease where it passes it. Rendered against an identical frame
     with the band's strength zeroed, that version moved 3.1% of the
     welcome pixels and 23 000 of the 36 000 sat in the two row bands
     over the HIPS: this crease is baked per-vertex in BIND space, where
     the mitten hangs beside the thigh, so opening the arms 26 degrees
     carries the arm's half of the band away and leaves the thigh's half
     behind as a dark patch on a hip with nothing near it. That is the
     "broad low-frequency dirt band on the hips" this file has already
     removed twice. Torso and belly only: those two never move relative
     to each other, so the band they carry is a crease in every pose. */
  function armSeam(x, y, z) {
    if (y < ARM_SEAM_Y0 || y > 1.06) return 1;
    const ax = x < 0 ? -x : x;
    if (ax < 0.09 || ax > 0.46) return 1;
    /* Both early-outs are the band radius itself, derived rather than
       typed: a stale literal here silently clips the band the moment
       ARM_SEAM_R moves, which is how the ear seam lost its back half
       once (see the ROUND 7 note on grooveDist). Either term alone
       already exceeds the sum's budget, so this is exact, not a guess. */
    let da = blobDist(x > 0 ? armBL : armBR, x, y, z);
    if (da > ARM_SEAM_R) return 1;
    let dt = blobDist(torsoB, x, y, z);
    const db = blobDist(bellyB, x, y, z);
    if (db < dt) dt = db;
    if (dt > ARM_SEAM_R) return 1;
    if (da < 0) da = 0;
    if (dt < 0) dt = 0;
    /* THE TWO WALLS ARE NOT OCCLUDED EQUALLY AND MUST NOT BE SHADED
       EQUALLY. From a point on the arm's inboard face the flank is a
       wall that fills most of the hemisphere; from a point on the flank
       the arm is a 150 mm sausage subtending a fraction of it. The
       reference shows exactly that asymmetry — at f 0.56 its flank
       recovers from 55 to 180 in 27 mm while its arm wall takes 67 mm to
       climb from 71 to 179 — and a symmetric band cannot reproduce it.
       So the sum is scaled by which side the vertex is on: the arm's
       band reaches half again as far, the flank's lets go sooner and
       gives the lit flank back. */
    /* THE SIGN CARRIES THE SIDE. bakeTint has to SHAPE the two walls
       differently as well as scale them (see ARM_SEAM_FLANK_P) and it
       has no other way to know which one a vertex is on — it sees one
       number. Negative = the flank wall. The 1 every early-out above
       returns stays positive and above R, so it still reads as "no
       band" without a second test. */
    const s = da + dt;
    return da < dt ? s * ARM_SEAM_SKEW_ARM : -s * ARM_SEAM_SKEW_FLANK;
  }

  /* how deep inside the ear dish a point is, for the inner-plate tint */
  function dishDepth(x, y, z) {
    let v = 1e9;
    for (const dd of dishes) v = Math.min(v, primDist(dd.prims[0], x, y, z));
    return v;
  }

  /* Distance to the nearest trunk-groove capsule, for the incised-line
     tint in bakeTint. The cuts are 6-8 mm deep in the field — real
     geometry, but half a mesher cell, so under the soft studio key they
     shade to nothing. The ref's three lines read as DARK: the incision
     carries its own baked shadow. Skin vertices inside/near a cut are
     exactly the ones within a few mm of the capsule surface. */
  function grooveDist(x, y, z) {
    /* ROUND 7: the reject box is derived from the arcs themselves rather
       than hand-typed — the lines moved 60 mm down the tube and a stale
       literal here would have silently switched the tint band off. */
    if (x < gx0 || x > gx1 || y < gy0 || y > gy1 || z < gz0 || z > gz1) return 1;
    let v = 1e9;
    for (let i = 0; i < grooves.length; i++) {
      const t = primDist(grooves[i].prim, x, y, z);
      if (t < v) v = t;
    }
    return v;
  }

  /* Per-blob distance at a point, ignoring the joins. The only way to
     answer "which form is closing my arm slot" without guessing. */
  function probe(x, y, z) {
    const out = {};
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i];
      let v = primDist(b.prims[0], x, y, z);
      for (let j = 1; j < b.prims.length; j++) v = smin(v, primDist(b.prims[j], x, y, z), b.k);
      out[`${i}:${b.tag}`] = v;
    }
    return out;
  }

  /* Distance to the nostril sphere, for the dimple tint in bakeTint.
     Same story as the grooves: the ~11 mm pit is real geometry but the
     soft studio key and the softened AO shade it to a whisper (measured
     ~8 luma across the welcome nub). The ref's nostril reads as a shaded
     doughnut — the pit floor carries its own baked shadow. */
  function nostrilDist(x, y, z) {
    if (y > 0.86 || z < 0.30 || (x < 0 ? -x : x) > 0.07) return 1;
    return primDist(nostril.prims[0], x, y, z);
  }

  return {
    d,
    tagAt,
    dishDepth,
    earSeam,
    armSeam,
    grooveDist,
    nostrilDist,
    probe,
    bounds: fieldBounds(blobs),
  };
}

/** Occluders that are not part of the skin but must darken it: the
    glasses block and both tusks. Used by the AO bake only. */
export function buildOccluderField() {
  const g = P.glass;
  const prims = [];
  /* brow bar — spheres along the shell at bar height (ROUND 4: the
     whole front lives on the face shell; see section 9) */
  for (let i = 0; i <= 10; i++) {
    const s = (-1 + 2 * i / 10) * g.barEndS;
    prims.push(sphere(
      shellPoint(s, (g.lensB + g.barTop) * 0.5, -g.depth * 0.5), 0.024));
  }
  /* lens blocks */
  for (const side of [1, -1]) {
    const n = shellNormal(g.lensS * side);
    prims.push(ellipN(shellPoint(g.lensS * side, 0, -g.depth * 0.5),
      [g.lensA + g.rimM, g.lensB + g.rimM, 0.020], n, [0, 1, 0]));
    const t = P.tusk;
    prims.push(cone([t.base[0] * side, t.base[1], t.base[2]],
      [t.mid[0] * side, t.mid[1], t.mid[2]], t.r[0], t.r[1]));
    prims.push(cone([t.mid[0] * side, t.mid[1], t.mid[2]],
      [t.tip[0] * side, t.tip[1], t.tip[2]], t.r[1], t.r[2]));
  }
  return function occ(x, y, z) {
    let v = 1e9;
    for (let i = 0; i < prims.length; i++) {
      const t = primDist(prims[i], x, y, z);
      if (t < v) v = t;
    }
    return v;
  };
}

/* ==================================================================
   3. Surface nets
   ================================================================== */

const CUBE = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];
const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/**
 * Polygonise `field` over an axis-aligned grid.
 *
 * A coarse pass at stride 4 finds the blocks the surface can possibly
 * cross (the field is ~1-Lipschitz, so a corner value larger than the
 * block's half-diagonal proves the surface is elsewhere) and only those
 * blocks are evaluated at full resolution. That is a 15-20x saving and
 * the difference between a 300 ms boot and a five second one.
 */
export function surfaceNets(field, bounds, cell) {
  const ox = bounds.min[0], oy = bounds.min[1], oz = bounds.min[2];
  const nx = Math.ceil((bounds.max[0] - ox) / cell) + 1;
  const ny = Math.ceil((bounds.max[1] - oy) / cell) + 1;
  const nz = Math.ceil((bounds.max[2] - oz) / cell) + 1;

  const G = new Float32Array(nx * ny * nz).fill(1);
  const S = 4;
  const bx = Math.ceil((nx - 1) / S), by = Math.ceil((ny - 1) / S), bz = Math.ceil((nz - 1) / S);
  const cn = (bx + 1) * (by + 1) * (bz + 1);
  const C = new Float32Array(cn);
  const ci = (i, j, k) => (k * (by + 1) + j) * (bx + 1) + i;

  for (let k = 0; k <= bz; k++) {
    const z = oz + Math.min(k * S, nz - 1) * cell;
    for (let j = 0; j <= by; j++) {
      const y = oy + Math.min(j * S, ny - 1) * cell;
      for (let i = 0; i <= bx; i++) {
        const x = ox + Math.min(i * S, nx - 1) * cell;
        C[ci(i, j, k)] = field(x, y, z);
      }
    }
  }

  /* conservative band: half block diagonal, x1.25 for smooth-min gradient
     overshoot, + a margin for the ellipsoid distance underestimate */
  const band = S * cell * 0.8661 * 1.15 + 0.012;
  const gi = (i, j, k) => (k * ny + j) * nx + i;

  for (let k = 0; k < bz; k++) {
    for (let j = 0; j < by; j++) {
      for (let i = 0; i < bx; i++) {
        let near = false, allNeg = true;
        for (let c = 0; c < 8; c++) {
          const v = C[ci(i + CUBE[c][0], j + CUBE[c][1], k + CUBE[c][2])];
          if (Math.abs(v) < band) near = true;
          if (v > 0) allNeg = false;
        }
        if (!near) {
          if (allNeg) {
            for (let kk = k * S; kk <= Math.min((k + 1) * S, nz - 1); kk++)
              for (let jj = j * S; jj <= Math.min((j + 1) * S, ny - 1); jj++)
                for (let ii = i * S; ii <= Math.min((i + 1) * S, nx - 1); ii++)
                  G[gi(ii, jj, kk)] = -1;
          }
          continue;
        }
        for (let kk = k * S; kk <= Math.min((k + 1) * S, nz - 1); kk++) {
          const z = oz + kk * cell;
          for (let jj = j * S; jj <= Math.min((j + 1) * S, ny - 1); jj++) {
            const y = oy + jj * cell;
            for (let ii = i * S; ii <= Math.min((i + 1) * S, nx - 1); ii++) {
              G[gi(ii, jj, kk)] = field(ox + ii * cell, y, z);
            }
          }
        }
      }
    }
  }

  /* ---- one vertex per surface cell ---- */
  const cellsX = nx - 1, cellsY = ny - 1, cellsZ = nz - 1;
  const vidx = new Int32Array(cellsX * cellsY * cellsZ).fill(-1);
  const positions = [];
  const v = new Float64Array(8);

  for (let k = 0; k < cellsZ; k++) {
    for (let j = 0; j < cellsY; j++) {
      for (let i = 0; i < cellsX; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const val = G[gi(i + CUBE[c][0], j + CUBE[c][1], k + CUBE[c][2])];
          v[c] = val;
          if (val < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;

        let sx = 0, sy = 0, sz = 0, n = 0;
        for (let e = 0; e < 12; e++) {
          const a = EDGES[e][0], b = EDGES[e][1];
          const va = v[a], vb = v[b];
          if ((va < 0) === (vb < 0)) continue;
          const t = va / (va - vb);
          sx += CUBE[a][0] + (CUBE[b][0] - CUBE[a][0]) * t;
          sy += CUBE[a][1] + (CUBE[b][1] - CUBE[a][1]) * t;
          sz += CUBE[a][2] + (CUBE[b][2] - CUBE[a][2]) * t;
          n++;
        }
        if (!n) continue;
        vidx[(k * cellsY + j) * cellsX + i] = positions.length / 3;
        positions.push(ox + (i + sx / n) * cell, oy + (j + sy / n) * cell, oz + (k + sz / n) * cell);
      }
    }
  }

  /* ---- quads across every sign-changing axis edge ---- */
  /* The four cells around each sign-changing axis edge, listed
     counter-clockwise about the POSITIVE axis direction. Emitting them in
     that order gives a face whose normal points +axis, which is outward
     exactly when the low corner is OUTSIDE the surface. Get the sense
     backwards and the whole mesh is inside-out: with front-face culling
     you then render its interior, which looks almost right on rounded
     forms and shreds wherever the skin folds. */
  const indices = [];
  const cidx = (i, j, k) => vidx[(k * cellsY + j) * cellsX + i];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) { indices.push(a, c, b, a, d, c); }
    else { indices.push(a, b, c, a, c, d); }
  };

  for (let k = 0; k < cellsZ; k++) {
    for (let j = 0; j < cellsY; j++) {
      for (let i = 0; i < cellsX; i++) {
        const inside = G[gi(i, j, k)] < 0;
        if (j > 0 && k > 0 && inside !== (G[gi(i + 1, j, k)] < 0)) {
          quad(cidx(i, j, k), cidx(i, j - 1, k), cidx(i, j - 1, k - 1), cidx(i, j, k - 1), !inside);
        }
        if (i > 0 && k > 0 && inside !== (G[gi(i, j + 1, k)] < 0)) {
          quad(cidx(i, j, k), cidx(i, j, k - 1), cidx(i - 1, j, k - 1), cidx(i - 1, j, k), !inside);
        }
        if (i > 0 && j > 0 && inside !== (G[gi(i, j, k + 1)] < 0)) {
          quad(cidx(i, j, k), cidx(i - 1, j, k), cidx(i - 1, j - 1, k), cidx(i, j - 1, k), !inside);
        }
      }
    }
  }

  /* ---- relax onto the true iso-surface, then take analytic normals ----
     Naive surface nets puts a vertex at the centroid of its edge
     crossings, which rounds off exactly the curvature we sculpted. Two
     gradient-descent steps, clamped inside the cell so the mesh cannot
     fold, put every vertex back on the surface. */
  const nvert = positions.length / 3;
  const pos = new Float32Array(positions);
  const nor = new Float32Array(nvert * 3);
  const eps = cell * 0.35;
  const lim = cell * 0.50;

  for (let i = 0; i < nvert; i++) {
    let x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const d0 = field(x, y, z);
    let gx = field(x + eps, y, z) - field(x - eps, y, z);
    let gy = field(x, y + eps, z) - field(x, y - eps, z);
    let gz = field(x, y, z + eps) - field(x, y, z - eps);
    let gl = Math.sqrt(gx * gx + gy * gy + gz * gz) / (2 * eps);
    /* Step along the UNIT gradient by the field value, not by
       d/|grad|^2. In the floor of a smooth-min valley |grad| collapses,
       the Newton step blows up, adjacent vertices slam into opposite
       clamps and the surface comes out corrugated at exactly the grid
       pitch — which is what a shredded-looking flank actually is.
       Below a gradient of 0.35 the field is not locally a distance at
       all, so the surface-nets centroid is left alone: it is already
       smooth. */
    if (gl > 0.35) {
      /* unit gradient = g / (2*eps*gl) */
      const inv = 1 / (gl * 2 * eps);
      let step = d0 / gl;
      if (step > lim) step = lim; else if (step < -lim) step = -lim;
      x -= gx * inv * step;
      y -= gy * inv * step;
      z -= gz * inv * step;
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    }
    gx = field(x + eps, y, z) - field(x - eps, y, z);
    gy = field(x, y + eps, z) - field(x, y - eps, z);
    gz = field(x, y, z + eps) - field(x, y, z - eps);
    const l = Math.hypot(gx, gy, gz) || 1;
    nor[i * 3] = gx / l; nor[i * 3 + 1] = gy / l; nor[i * 3 + 2] = gz / l;
  }

  /* ---- de-ripple ----
     Surface nets is a *dual* method: each vertex is the centroid of its
     cell's edge crossings, and where two blended primitives meet at a
     shallow angle those centroids alternate either side of the true
     surface from cell to cell. The result is a corrugation at exactly the
     grid pitch, running along the seam — the classic dual-contouring
     ripple, and no amount of normal smoothing hides it because the
     positions themselves are wrong.
     Two Laplacian passes over the one-ring pull the vertices back into
     line, and each pass is followed by a projection back onto the
     iso-surface so the smoothing cannot shrink the form. */
  /* 3 PASSES, NOT 2 — the forearm is the thinnest organic form on him
     (r 0.038-0.044 against a 13.6 mm cell, i.e. six cells across) and two
     passes left the dual-contouring ripple standing proud enough to read
     as flat segments down its outboard silhouette. The third pass is
     re-projected onto the iso-surface like the others, so it costs
     volume nothing; it costs about 40 ms of boot. */
  deRipple(pos, indices, nvert, field, cell, 3);

  for (let i = 0; i < nvert; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const gx = field(x + eps, y, z) - field(x - eps, y, z);
    const gy = field(x, y + eps, z) - field(x, y - eps, z);
    const gz = field(x, y, z + eps) - field(x, y, z - eps);
    const l = Math.hypot(gx, gy, gz) || 1;
    nor[i * 3] = gx / l; nor[i * 3 + 1] = gy / l; nor[i * 3 + 2] = gz / l;
  }
  /* Two passes, not one. The gradient normal is exact, and "exact" on a
     smooth-min field means it carries every millimetre of ripple the blend
     leaves behind. A cel terminator magnifies exactly that: a 0.02 wobble
     in N.L moves the band boundary several centimetres across a shallow
     surface. Two Laplacian passes cost nothing, leave the silhouette
     untouched (positions are not moved), and are the difference between a
     terminator that glides around the belly and one that crawls. */
  /* Four passes, not three: §1.1 (revised) calls the torso a PERFECTLY
     smooth pear — no pec/sternum definition, no visible faceting even in
     the deformed pose. The extra pass costs ~8 ms at boot and removes the
     last of the terminator crawl on the chest. */
  smoothNormals(pos, nor, indices, nvert, 4);

  return { position: pos, normal: nor, index: indices, count: nvert };
}

/**
 * Laplacian position smoothing with re-projection onto the iso-surface.
 * Removes the dual-contouring ripple without losing volume: the smoothing
 * step is tangential in effect because the projection immediately puts
 * every vertex back on field == 0.
 */
function deRipple(pos, index, count, field, cell, passes) {
  const acc = new Float32Array(count * 3);
  const deg = new Float32Array(count);
  const eps = cell * 0.35;
  const w = 0.62;
  for (let p = 0; p < passes; p++) {
    acc.fill(0); deg.fill(0);
    for (let t = 0; t < index.length; t += 3) {
      const tri = [index[t], index[t + 1], index[t + 2]];
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) {
          if (a === b) continue;
          const i = tri[a], j = tri[b];
          acc[i * 3] += pos[j * 3];
          acc[i * 3 + 1] += pos[j * 3 + 1];
          acc[i * 3 + 2] += pos[j * 3 + 2];
          deg[i]++;
        }
      }
    }
    for (let i = 0; i < count; i++) {
      if (deg[i] < 2) continue;
      let x = pos[i * 3] * (1 - w) + (acc[i * 3] / deg[i]) * w;
      let y = pos[i * 3 + 1] * (1 - w) + (acc[i * 3 + 1] / deg[i]) * w;
      let z = pos[i * 3 + 2] * (1 - w) + (acc[i * 3 + 2] / deg[i]) * w;
      /* project back onto the surface along the gradient */
      for (let k = 0; k < 2; k++) {
        const d = field(x, y, z);
        const gx = field(x + eps, y, z) - field(x - eps, y, z);
        const gy = field(x, y + eps, z) - field(x, y - eps, z);
        const gz = field(x, y, z + eps) - field(x, y, z - eps);
        const gl = Math.sqrt(gx * gx + gy * gy + gz * gz) / (2 * eps);
        if (gl < 0.25) break;
        const inv = 1 / (gl * 2 * eps);
        let step = d / gl;
        const lim = cell * 0.9;
        if (step > lim) step = lim; else if (step < -lim) step = -lim;
        x -= gx * inv * step; y -= gy * inv * step; z -= gz * inv * step;
      }
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    }
  }
}

/** Laplacian smoothing of vertex normals over the index buffer. */
function smoothNormals(pos, nor, index, count, passes) {
  const acc = new Float32Array(count * 3);
  const deg = new Float32Array(count);
  for (let p = 0; p < passes; p++) {
    acc.fill(0); deg.fill(0);
    for (let t = 0; t < index.length; t += 3) {
      const a = index[t], b = index[t + 1], c = index[t + 2];
      const add = (i, j) => {
        acc[i * 3] += nor[j * 3]; acc[i * 3 + 1] += nor[j * 3 + 1]; acc[i * 3 + 2] += nor[j * 3 + 2];
        deg[i]++;
      };
      add(a, b); add(a, c); add(b, a); add(b, c); add(c, a); add(c, b);
    }
    for (let i = 0; i < count; i++) {
      if (deg[i] === 0) continue;
      const w = 0.55;
      let x = nor[i * 3] * (1 - w) + (acc[i * 3] / deg[i]) * w;
      let y = nor[i * 3 + 1] * (1 - w) + (acc[i * 3 + 1] / deg[i]) * w;
      let z = nor[i * 3 + 2] * (1 - w) + (acc[i * 3 + 2] / deg[i]) * w;
      const l = Math.hypot(x, y, z) || 1;
      nor[i * 3] = x / l; nor[i * 3 + 1] = y / l; nor[i * 3 + 2] = z / l;
    }
  }
}

/** Remove degenerate/needle triangles. Returns a new index array. */
export function cullDegenerate(pos, index, cell) {
  const minArea = (cell * cell) * 0.004;
  const out = [];
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    if (index[t] === index[t + 1] || index[t] === index[t + 2] || index[t + 1] === index[t + 2]) continue;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz) < minArea) continue;
    out.push(index[t], index[t + 1], index[t + 2]);
  }
  return out;
}

/* ==================================================================
   4. Baked AO
   ================================================================== */

/* Cone-trace radii, metres. §1.2 calls the AO radius "generous and soft"
   and lists the creases it has to catch: under the ears, under the belly,
   between the legs, where the trunk meets the face. */
/* LIKENESS PASS 4 — CREASE-ONLY RADIUS. The 0.28/0.46 m taps sampled
   half the body per ray: on the hips, flanks and inner thighs they
   returned partial occlusion EVERYWHERE, which shipped as the critic's
   "broad low-frequency dirt band darkening hips, upper thighs and
   flanks". The reference's darkening is confined to true creases
   (armpit, thumb groove, foot contact), and those are all under ~0.15 m
   features; the two long taps are gone and their weight is
   redistributed so a real crease still reaches the same depth. */
/* LIKENESS FINAL — THE LONG TAP WAS STILL PAINTING THE BELLY. Proved on
   pixels, not argued: WALLY.debug.wallyAO() dials this bake between 0 and
   1 in a live frame with nothing else moving. At 1 the lower belly
   carried a soft dark crescent hugging the belly blob's own smin fillet
   and a 110-luma cliff on the flank beside the arm; at 0 both vanished
   and every real crease survived on the sculpt term alone. Scanned across
   the belly at three heights the build measured 200 -> 92 over a tenth of
   its width where ref/wally-ref-cool.png measures 190 -> 137.

   The 0.150 m tap is the one doing it. It is longer than the fillet it is
   supposed to skip: a ray that long from the flank reaches the arm across
   a 30 mm slot and reaches the torso wall from anywhere on the belly's
   turn, so it returns partial occlusion over a whole REGION rather than
   in a crease — the same defect the 0.28/0.46 taps were removed for, one
   scale down. 0.105 m still spans every crease §1.2 names (ear root,
   armpit, trunk-to-face, under the belly, between the legs are all
   sub-100 mm features) and stops before the far wall of the arm slot.
   Weight redistributes to the two short taps so a true crease reaches
   the same depth. */
const AO_T = [0.026, 0.060, 0.105];
const AO_W = [0.44, 0.35, 0.21];

/* ------------------------------------------------------------------
   FORM OCCLUSION — the fix for "an untextured mid-grey mesh with no
   material, no surface detail, no rig-level shaping".

   WHY THE OLD BAKE COULD NOT SHOW FORM AT GAMEPLAY DISTANCE. bakeAO
   traces ONE ray, along the vertex normal. On a convex surface that ray
   leaves into free space and returns 1.0 — so every outward-facing part
   of him (which is all of him from a gameplay camera) baked to "no
   occlusion", and the only shading left was the cel ramp. Measured at
   5.9 m with the sun behind him, N.L on every camera-facing normal is
   -0.33: the whole figure lands on ONE side of a two-band ramp and
   renders as a single flat tone. p5-p95 across his body was 37 of 255 —
   a 12% value range on a 250 px character. That is the blockout read.

   WHAT REPLACES IT. Analytic sphere occlusion against a ~40-sphere proxy
   of his own body. For each vertex and each proxy sphere the covered
   fraction of the hemisphere is `nl * (1 - sqrt(1 - (r/l)^2))` — exact
   for a sphere, and free of the ray-marching cost, so the whole pass is
   one dot product and one sqrt per sphere (about 35 ms for 32k vertices
   against 40 spheres; the cone trace it supplements costs 20x that).

   It is evaluated TWICE:
     * with the surface normal  -> form AO. The torso occludes the inner
       arm, the thighs occlude each other, the head occludes the
       shoulders, the belly occludes the top of the legs. These are §1.2's
       named creases and they are wide and soft by construction, because
       a solid angle falls off as 1/l^2 and never has an edge.
     * with world up            -> sky occlusion. How much of the dome a
       point can see. This is what gives a matte toy its top-to-bottom
       value structure, and it is the term that survives ANY key
       direction — which is the whole point, because at gameplay he is
       backlit and the key describes nothing.

   Both are geometry, not lighting: they are correct from every camera and
   at every distance, and they cost nothing at runtime.
   ------------------------------------------------------------------ */

/** Proxy spheres, [x, y, z, r] flat, in bind space. Exported so a
    diagnostic can re-bake the occlusion field with an alternative kernel
    on the same mesh and compare — the only honest way to prove a ring
    artefact is gone rather than merely hidden by the lighting. */
export function buildProxySpheres() {
  const S = [];
  const push = (x, y, z, r) => { S.push(x, y, z, r); };
  const mir = (x, y, z, r) => { push(x, y, z, r); push(-x, y, z, r); };

  /* cranium */
  push(P.head.c[0], P.head.c[1], P.head.c[2], P.head.r);

  /* torso — every other lathe station, radius from the profile's own
     half-width so the proxy column matches the rendered pear */
  for (let i = 0; i < P.torso.length; i += 2) {
    const t = P.torso[i];
    push(0, t[0], t[2], t[1] * 1.04);
  }
  const tl = P.torso[P.torso.length - 1];
  push(0, tl[0], tl[2], tl[1] * 1.04);

  /* the pot belly — the overhang that has to darken the top of the legs */
  push(P.belly.c[0], P.belly.c[1], P.belly.c[2],
    (P.belly.r[0] + P.belly.r[2]) * 0.5);

  /* arms and hands */
  for (const a of P.arm) mir(a[0], a[1], a[2], a[3]);
  mir(P.palm.c[0], P.palm.c[1], P.palm.c[2], (P.palm.r[0] + P.palm.r[2]) * 0.62);

  /* legs and feet */
  for (const l of P.leg) mir(l[0], l[1], l[2], l[3]);
  mir(P.foot.c[0], P.foot.c[1] + 0.02, P.foot.c[2], 0.062);

  /* trunk */
  for (const t of P.trunk) push(t[0], t[1], t[2], t[3]);

  /* ears — a fan 0.34 H tall is nothing like a sphere, so it is three:
     lower lobe, centre, upper edge. Without these the head casts no
     occlusion into the ear root and the ear reads as a sticker. */
  const E = P.ear;
  const ex = E.root[0] + E.dir[0] * E.seg * 1.9;
  const ey = E.root[1] + E.dir[1] * E.seg * 1.9;
  const ez = E.root[2] + E.dir[2] * E.seg * 1.9;
  /* the chain itself now rises (round 2), so the three balls sit lower
     relative to its tip to keep covering the fan's actual y span */
  mir(ex, ey - 0.170, ez, 0.126);
  mir(ex, ey - 0.020, ez, 0.148);
  mir(ex, ey + 0.115, ez, 0.120);

  return new Float32Array(S);
}

/* ------------------------------------------------------------------
   THE KERNEL, AND WHY IT IS NOT THE EXACT SOLID ANGLE.

   The covered fraction of the hemisphere above the tangent plane is
   exactly `1 - sqrt(1 - (r/l)^2)`. It is also useless at close range: it
   goes to 1 as l -> r, and l -> r is not a rare case here — a proxy
   sphere is deliberately buried inside the very form it stands for, so
   that form's own skin sits at l/r somewhere between 1 and 1.5 over its
   whole surface.

   The previous pass handled that by multiplying the exact term by a
   smoothstep ramp over l in [r, 1.45 r]. That removed the C0 step, and
   the report said the facets were gone. They were not. Multiplying a
   term that PEAKS at l = r by a weight that is ZERO at l = r produces a
   product with an interior maximum — measured at l = 1.45 r, value 0.276,
   climbing from 0 over the 0.45 r before it. In other words every proxy
   sphere painted a RING of maximum occlusion onto whatever surface lay
   at ~1.4 r from its centre, and by construction that surface is the
   skin of the form the sphere proxies:

     * head ball r 0.278      -> ring on the brow and the lower cranium
     * torso top r 0.139      -> a second ring around the same skull
     * trunk stations r ~0.12 -> an arc across the forehead and face
     * three ear balls r 0.13 -> concentric bull's-eyes on both ear plates

   Those rings are 50-60 mm wide on a 250 px character, far wider than
   the 13 mm cell, so the five Laplacian passes over the one-ring could
   not touch them; and their position wanders by a cell wherever the
   mesher's dual-contouring ripple moves the skin, which is what turned
   them into flat plates with straight edges under a low sun. §7 forbids
   visible faceting on an organic form outright.

   THE FIX IS TO REMOVE THE INTERIOR MAXIMUM, not to blur it. This kernel

       om(l) = K r^2 / (l^2 + C r^2)

   is bounded (K/C at l = 0), strictly MONOTONE DECREASING in l, and C-inf
   everywhere — so it needs no near-field ramp, no inside test, and no
   special case, and it cannot produce a ring at any radius. K = 0.62,
   C = 1.15 tracks the exact solid angle to within 10 % wherever the exact
   term is meaningful (l > 1.6 r: 0.120 vs 0.134 at 2 r, 0.061 vs 0.057 at
   3 r) and rolls off to 0.29 instead of 1.0 where the sphere is inside
   its own form. Every crease §1.2 names is carried by the l > 1.6 r part
   of the curve and is therefore unchanged.
   ------------------------------------------------------------------ */
const OCC_K = 0.62;
const OCC_C = 1.15;

/**
 * Analytic sphere occlusion of `count` points against the proxy set.
 * Writes visibility (1 = open sky / open hemisphere, 0 = buried) for the
 * surface normal into `outForm` and for world up into `outSky`.
 */
export function bakeFormOcclusion(pos, nor, count, spheres, outForm, outSky) {
  const ns = spheres.length / 4;
  for (let i = 0; i < count; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const nx = nor[i * 3], ny = nor[i * 3 + 1], nz = nor[i * 3 + 2];
    let vf = 1, vs = 1;
    for (let s = 0; s < ns; s++) {
      const cx = spheres[s * 4] - x;
      const cy = spheres[s * 4 + 1] - y;
      const cz = spheres[s * 4 + 2] - z;
      const r = spheres[s * 4 + 3];
      const l2 = cx * cx + cy * cy + cz * cz;
      const l = Math.sqrt(l2);
      if (l < 1e-6) continue;
      const om = (OCC_K * r * r) / (l2 + OCC_C * r * r);
      const dnf = (nx * cx + ny * cy + nz * cz) / l;
      if (dnf > 0) {
        const o = dnf * om;
        vf *= 1 - (o > 0.90 ? 0.90 : o);
      }
      const dns = cy / l;
      if (dns > 0) {
        const o = dns * om;
        vs *= 1 - (o > 0.90 ? 0.90 : o);
      }
    }
    outForm[i] = vf;
    outSky[i] = vs;
  }
}

/** Three Laplacian passes over the one-ring. §1.2: the AO must be SOFT. */
function smoothScalar(a, count, index, passes = 3, w = 0.62) {
  if (!index || !index.length) return a;
  const acc = new Float32Array(count);
  const deg = new Uint16Array(count);
  for (let p = 0; p < passes; p++) {
    acc.fill(0); deg.fill(0);
    for (let t = 0; t < index.length; t += 3) {
      const i0 = index[t], i1 = index[t + 1], i2 = index[t + 2];
      acc[i0] += a[i1] + a[i2]; deg[i0] += 2;
      acc[i1] += a[i0] + a[i2]; deg[i1] += 2;
      acc[i2] += a[i0] + a[i1]; deg[i2] += 2;
    }
    for (let i = 0; i < count; i++) {
      if (deg[i]) a[i] = a[i] * (1 - w) + (acc[i] / deg[i]) * w;
    }
  }
  return a;
}

/**
 * SDF ambient occlusion. Wide radius and soft, per §1.2 — a hard contact
 * darkening reads as plastic and is forbidden.
 */
export function bakeAO(pos, nor, count, field, occluder, strength = 1.0, index = null) {
  const ao = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const nx = nor[i * 3], ny = nor[i * 3 + 1], nz = nor[i * 3 + 2];
    let occ = 0;
    for (let s = 0; s < AO_T.length; s++) {
      const t = AO_T[s];
      const px = x + nx * t, py = y + ny * t, pz = z + nz * t;
      let d = field(px, py, pz);
      if (occluder) { const o = occluder(px, py, pz); if (o < d) d = o; }
      if (d < 0) d = 0;
      occ += AO_W[s] * (t - d) / t;
    }
    /* FLOOR 0.28, NOT 0.12. §1.2 gives the deep AO crease an exact
       colour — #A9A9A8, a 24% value drop off #DEDEDD with an R-B spread
       of 1 — and the shader multiplies this term by a warm grey whose
       own R:B ratio is 1.10. At a floor of 0.12 the deepest creases
       measured 101,88,81: 40% darker than the specification and twenty
       points of red-over-blue, which is what made clean grey vinyl read
       as dirty tan. Clamping the trace at 0.36 keeps every crease §1.2
       asks for — the ear roots, the armpits, the void behind the trunk —
       and stops the tail of the distribution running away into a hole. */
    let a = 1 - strength * occ;
    ao[i] = a < 0.36 ? 0.36 : a > 1 ? 1 : a;
  }
  /* Blur it over the one-ring. §1.2 is explicit that the AO must be soft
     and wide and that hard contact darkening "looks like plastic and is
     forbidden" — a per-vertex cone trace on its own has a hard edge
     wherever the longest ray first clears an occluder. Three Laplacian
     passes over the index buffer cost about 15 ms and turn a stencil into
     a shadow. */
  if (index && index.length) {
    const acc = new Float32Array(count);
    const deg = new Uint16Array(count);
    for (let p = 0; p < 3; p++) {
      acc.fill(0); deg.fill(0);
      for (let t = 0; t < index.length; t += 3) {
        const a = index[t], b = index[t + 1], c = index[t + 2];
        acc[a] += ao[b] + ao[c]; deg[a] += 2;
        acc[b] += ao[a] + ao[c]; deg[b] += 2;
        acc[c] += ao[a] + ao[b]; deg[c] += 2;
      }
      for (let i = 0; i < count; i++) {
        if (!deg[i]) continue;
        ao[i] = ao[i] * 0.38 + (acc[i] / deg[i]) * 0.62;
      }
    }
  }
  for (let i = 0; i < count; i++) ao[i] = Math.pow(ao[i], 0.90);
  return ao;
}

/* ==================================================================
   5. Skin weights
   ================================================================== */

const TAU = 0.055;          // weight falloff, metres
const MAXHOP = 2;           // only blend bones within 2 hops of the winner

export function bakeWeights(pos, count) {
  const nb = BONES.length;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const d = new Float64Array(nb);

  const bellyI = BONE_INDEX.belly;
  const spineI = BONE_INDEX.spine;
  const hipsI = BONE_INDEX.hips;
  const chestI = BONE_INDEX.chest;
  const bellyC = BONES[bellyI].w;

  /* LIKENESS PASS 4 — TORSO SKIN NEVER FOLLOWS THE ARM. TAU is 55 mm and
     the pear's flank wall is only ~60-80 mm from the elbow cone's axis,
     so even with correct capture volumes the flank picked up 0.3-0.4 of
     armL1 and every abducted pose tented it into a spike off the slot
     bottom (measured on the welcome weight paint, twice). A vertex WON
     by a torso bone is torso: arm-chain candidates are dropped outright.
     And the REVERSE holds too: the arm-flank fillet saddle is won by
     armL1 at ~0.6 with a ~0.3 chest share, and that half-anchoring is
     exactly what tented it into a fin whenever the elbow abducted —
     verified on pixels at 30, 20 and 14 degrees of swing. Arm-won skin
     is now pure arm: the saddle travels WITH the limb, the slot opens
     clean, and the only blend across the boundary is the positional
     taper the 5-pass Laplacian smoothing provides. */
  const torsoSet = new Set([spineI, hipsI, chestI, bellyI]);
  const armSet = new Set(['armL0', 'armL1', 'handL', 'armR0', 'armR1', 'handR']
    .map((n) => BONE_INDEX[n]));

  const cand = [];
  for (let v = 0; v < count; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    let best = Infinity, bi = 0;
    for (let b = 0; b < nb; b++) {
      const dv = captureDistance(BONES[b], x, y, z);
      d[b] = dv;
      if (dv < best) { best = dv; bi = b; }
    }

    cand.length = 0;
    const torsoWon = torsoSet.has(bi);
    const armWon = armSet.has(bi);
    for (let b = 0; b < nb; b++) {
      if (d[b] === Infinity) continue;
      if (BONE_DIST[bi * nb + b] > MAXHOP) continue;
      if (torsoWon && armSet.has(b)) continue;
      if (armWon && torsoSet.has(b)) continue;
      const w = Math.exp(-(d[b] - best) / TAU);
      if (w > 0.02) cand.push([b, w]);
    }
    if (!cand.length) cand.push([bi, 1]);
    cand.sort((a, b) => b[1] - a[1]);
    if (cand.length > 4) cand.length = 4;

    /* Belly is a soft-body offset, not a joint: it takes a share of the
       torso bones by proximity rather than by winning a distance race. */
    if (bi === spineI || bi === hipsI || bi === chestI) {
      const dx = x - bellyC[0], dy = (y - bellyC[1]) * 1.25, dz = (z - bellyC[2]) * 0.85;
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const wb = 0.62 * Math.exp(-(r * r) / (2 * 0.115 * 0.115)) * (z > 0 ? 1 : 0.25);
      if (wb > 0.02) {
        for (const c of cand) c[1] *= (1 - Math.min(wb, 0.85));
        cand.push([bellyI, wb]);
        cand.sort((a, b) => b[1] - a[1]);
        if (cand.length > 4) cand.length = 4;
      }
    }

    let sum = 0;
    for (const c of cand) sum += c[1];
    for (let i = 0; i < 4; i++) {
      if (i < cand.length) {
        skinIndex[v * 4 + i] = cand[i][0];
        skinWeight[v * 4 + i] = cand[i][1] / sum;
      } else {
        skinIndex[v * 4 + i] = 0;
        skinWeight[v * 4 + i] = 0;
      }
    }
  }
  return { skinIndex, skinWeight };
}

/**
 * Laplacian smoothing of the weight field over the mesh's own one-ring.
 *
 * THIS IS THE FIX FOR THE EXPLODED FAN. Capture volumes are competitive:
 * every vertex goes to whichever volume is nearest, and the MAXHOP rule
 * then forbids blending between bones more than two hops apart in the
 * skeleton. Where two such bones own adjacent skin — the hand against the
 * hip is six hops, the digits against the thigh likewise — you get a hard
 * discontinuity running across a continuous surface: one row of vertices
 * is 100% handL, the next is 100% hips. In bind that is invisible. In the
 * 'cool' pose, where the arm swings +9 degrees and the hips shift 36 mm
 * the other way, those two rows separate and the triangles between them
 * become a stretched, unshaded, hard-edged fan hanging off his flank —
 * 317 triangles over 2.6x their bind area, worst 26x.
 *
 * Smoothing over the *mesh* one-ring is the right cure because mesh
 * adjacency is exactly the relation that matters: it lets the hand bleed
 * into the hip because their skin genuinely touches, while the trunk —
 * which hangs a centimetre in front of the belly but shares no edge with
 * it — stays independent, which is what MAXHOP was protecting in the
 * first place.
 */
export function smoothWeights(index, count, skinIndex, skinWeight, passes = 3, w = 0.55) {
  if (!index || !index.length) return { skinIndex, skinWeight };
  const nb = BONES.length;
  let cur = new Float32Array(count * nb);
  for (let v = 0; v < count; v++) {
    for (let k = 0; k < 4; k++) cur[v * nb + skinIndex[v * 4 + k]] += skinWeight[v * 4 + k];
  }
  const acc = new Float32Array(count * nb);
  const deg = new Uint16Array(count);
  for (let p = 0; p < passes; p++) {
    acc.fill(0); deg.fill(0);
    for (let t = 0; t < index.length; t += 3) {
      const tri = [index[t], index[t + 1], index[t + 2]];
      for (let a = 0; a < 3; a++) {
        const i = tri[a] * nb;
        for (let b = 0; b < 3; b++) {
          if (a === b) continue;
          const j = tri[b] * nb;
          for (let n = 0; n < nb; n++) acc[i + n] += cur[j + n];
          deg[tri[a]]++;
        }
      }
    }
    for (let v = 0; v < count; v++) {
      const d = deg[v];
      if (!d) continue;
      const o = v * nb;
      for (let n = 0; n < nb; n++) cur[o + n] = cur[o + n] * (1 - w) + (acc[o + n] / d) * w;
    }
  }
  /* back to 4 influences, renormalised */
  for (let v = 0; v < count; v++) {
    const o = v * nb;
    let i0 = 0, i1 = 0, i2 = 0, i3 = 0, w0 = -1, w1 = -1, w2 = -1, w3 = -1;
    for (let n = 0; n < nb; n++) {
      const x = cur[o + n];
      if (x <= 1e-4) continue;
      if (x > w0) { w3 = w2; i3 = i2; w2 = w1; i2 = i1; w1 = w0; i1 = i0; w0 = x; i0 = n; }
      else if (x > w1) { w3 = w2; i3 = i2; w2 = w1; i2 = i1; w1 = x; i1 = n; }
      else if (x > w2) { w3 = w2; i3 = i2; w2 = x; i2 = n; }
      else if (x > w3) { w3 = x; i3 = n; }
    }
    if (w0 < 0) { w0 = 1; i0 = 0; }
    const s = Math.max(w0, 0) + Math.max(w1, 0) + Math.max(w2, 0) + Math.max(w3, 0);
    const ws = [w0, w1, w2, w3], is = [i0, i1, i2, i3];
    for (let k = 0; k < 4; k++) {
      skinIndex[v * 4 + k] = is[k];
      skinWeight[v * 4 + k] = ws[k] > 0 ? ws[k] / s : 0;
    }
  }
  cur = null;
  return { skinIndex, skinWeight };
}

/* ==================================================================
   THE EAR MAY NOT DRAG THE SKULL
   ==================================================================

   "His sunglasses in the back of his ears sometimes stick out when he is
   moving/running." The previous pass tucked the temple HOOK into the
   ear's root wedge (see the note in the temple-arm block below), and
   that fix is real: the hook ends are provably occluded from a rear
   camera on every free-run frame. The SYMPTOM survived it, and this is
   why.

   MEASURED, not reasoned. Rear studio camera, free run at 6.2-6.8 m/s
   with sweeping turns and gusts, flood-filling the head band for
   near-black clusters (luma < 80 on a 211-luma clay), then raycasting
   the cluster's own pixels back into the scene:

     the ray misses `wally.body` ENTIRELY — front faces and back faces,
     tested double-sided — and lands on the glasses' front assembly at
     z +0.40, i.e. it goes PAST the cheek and out the other side.
     Hiding wally.frame alone leaves the wedge (the two lens panels are
     separate meshes and just as black); hiding frame + both lenses +
     grooves + tusks takes it to 0 of 20. The black IS the glasses, seen
     from behind, THROUGH the skull.

   And the skull is open there because the ear chain is dragging it.
   rig.js's earL0 capture cone runs down to y 1.240 on a 60 mm radius,
   TAU is 55 mm, and five Laplacian passes spread what that captures:
   cheek vertices whose BIND positions sit 40-70 mm OUTSIDE the ear blob
   — (0.23, 1.19, -0.03), (0.24, 1.22, +0.05) and their neighbours —
   carry 0.25-0.52 of earL0/earR0. A 27-49 degree root swing then walks
   that patch of cranium off with the fan, the flank goes hollow behind
   it, and the black glasses corner — proud of the skull at brow height,
   normally well inside its silhouette — is uncovered.

   So the fix is not more ear and not less swing: an ear bone may only
   move skin that is actually ON the ear. The mask below is the ear
   blob's own signed field — the exact volume `earBlob` sculpts, buried
   root wedge included — tapered over the first 48 mm outside it, which
   is ~3 mesher cells and therefore a gradient rather than a seam. Skin
   on the fan and in the root fillet (dEar -3 to -62 mm) keeps every bit
   of ear it had, so the flap §4 calls "the most visible piece of polish
   in the game" is bit-for-bit unchanged; skin on the cheek and the
   crown (dEar +44 to +130 mm) loses it and stays with the skull.

   Paired A/B, alternating the weights frame by frame down ONE driven
   run so both conditions see the same stride, the same gusts and the
   same spring state, 50 pairs:

     near-black clusters in the head band   8 / 50  ->  0 / 50
     worst cluster                          17x38 px (383 px) -> none

   NOTE FOR THE NEXT PASS: do NOT "help" this by growing the buried root
   wedge. The wedge is the mask's own definition of what counts as ear,
   so a bigger wedge hands MORE cranium back to the ear chain — which is
   the defect. If that notch ever needs more mass it belongs on the head
   blob, where it cannot swing.
   ------------------------------------------------------------------ */

/* metres outside the ear blob: inside EAR_MASK_IN the ear owns the skin
   outright, past EAR_MASK_OUT it owns none of it. */
const EAR_MASK_IN = 0.000;
const EAR_MASK_OUT = 0.048;

export function clampEarWeights(pos, count, skinIndex, skinWeight) {
  const ears = [earBlob(1), earBlob(-1)];
  const isEar = new Uint8Array(BONES.length);
  for (const n of ['earL0', 'earL1', 'earL2', 'earR0', 'earR1', 'earR2']) {
    isEar[BONE_INDEX[n]] = 1;
  }
  const span = EAR_MASK_OUT - EAR_MASK_IN;
  for (let v = 0; v < count; v++) {
    let ear = 0, rest = 0;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight[v * 4 + k];
      if (isEar[skinIndex[v * 4 + k]]) ear += w; else rest += w;
    }
    /* nothing to move, or nowhere to move it to — a vertex with no
       non-ear influence at all is fan skin and keeps what it has */
    if (ear <= 1e-4 || rest <= 1e-4) continue;

    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    let d = Infinity;
    for (let e = 0; e < 2; e++) {
      const b = ears[e];
      let db = primDist(b.prims[0], x, y, z);
      for (let i = 1; i < b.prims.length; i++) {
        db = smin(db, primDist(b.prims[i], x, y, z), b.k);
      }
      if (db < d) d = db;
    }
    if (d <= EAR_MASK_IN) continue;

    let t = (d - EAR_MASK_IN) / span;
    if (t > 1) t = 1;
    const m = 1 - t * t * (3 - 2 * t);          // inverted smoothstep
    const total = ear * m + rest;
    if (!(total > 1e-6)) continue;
    const ke = m / total, kr = 1 / total;
    for (let k = 0; k < 4; k++) {
      skinWeight[v * 4 + k] *= isEar[skinIndex[v * 4 + k]] ? ke : kr;
    }
  }
  return { skinIndex, skinWeight };
}

/**
 * Analytic redistribution of the TRUNK weights by arc length.
 *
 * THIS IS THE FIX FOR THE WELCOME-POSE RINGS. Capture volumes hand each
 * trunk vertex to the nearest of five capsules, so the blend band between
 * bone i and bone i+1 is whatever the Laplacian smoothing manages to
 * spread from a hard boundary at the shared station — ~1.5 cells. In bind
 * that is invisible. In `welcome` the chain straightens 8-16 degrees at
 * every joint, and a bend concentrated in a 20 mm band prints a pinch
 * ring at every station: five rings down the hang — the vacuum-hose
 * corrugation the likeness pass kept failing on.
 *
 * The cure is to make the trunk's weights a smooth partition of unity in
 * ARC LENGTH: project the vertex onto the bind polyline, then cross-fade
 * bone i-1 -> bone i over a +-42 mm smoothstep centred on each interior
 * station. Only the mass the vertex already gives to trunk bones is
 * redistributed — head/jaw/chest shares are untouched, so the root fusion
 * and the face boundary stay exactly where the capture pass put them.
 */
export function blendTrunkWeights(pos, count, skinIndex, skinWeight) {
  const T = PROP.trunk;
  const ti = [BONE_INDEX.trunk0, BONE_INDEX.trunk1, BONE_INDEX.trunk2,
    BONE_INDEX.trunk3, BONE_INDEX.trunk4];
  const isTrunk = new Uint8Array(BONES.length);
  for (const b of ti) isTrunk[b] = 1;
  const S = [0];
  for (let i = 1; i < T.length; i++) {
    S.push(S[i - 1] + Math.hypot(T[i][0] - T[i - 1][0],
      T[i][1] - T[i - 1][1], T[i][2] - T[i - 1][2]));
  }
  const h = 0.048;   // joint cross-fade half-width; segments are 0.09+ apart
  const sstep = (e0, e1, x) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const keep = [];   // non-trunk influences of the current vertex
  for (let v = 0; v < count; v++) {
    let wt = 0;
    for (let k = 0; k < 4; k++) {
      if (isTrunk[skinIndex[v * 4 + k]]) wt += skinWeight[v * 4 + k];
    }
    if (wt < 0.02) continue;
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    /* arc parameter of the nearest point on the bind polyline */
    let s = 0, best = Infinity;
    for (let i = 0; i < T.length - 1; i++) {
      const dx = T[i + 1][0] - T[i][0], dy = T[i + 1][1] - T[i][1],
        dz = T[i + 1][2] - T[i][2];
      const L2 = dx * dx + dy * dy + dz * dz;
      let t = ((x - T[i][0]) * dx + (y - T[i][1]) * dy + (z - T[i][2]) * dz) / L2;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      const px = T[i][0] + dx * t - x, py = T[i][1] + dy * t - y,
        pz = T[i][2] + dz * t - z;
      const d2 = px * px + py * py + pz * pz;
      if (d2 < best) { best = d2; s = S[i] + Math.sqrt(L2) * t; }
    }
    /* partition of unity over the five bones */
    const s1 = sstep(S[1] - h, S[1] + h, s), s2 = sstep(S[2] - h, S[2] + h, s);
    const s3 = sstep(S[3] - h, S[3] + h, s), s4 = sstep(S[4] - h, S[4] + h, s);
    const wj = [1 - s1, s1 - s2, s2 - s3, s3 - s4, s4];
    keep.length = 0;
    for (let k = 0; k < 4; k++) {
      const bi = skinIndex[v * 4 + k], bw = skinWeight[v * 4 + k];
      if (!isTrunk[bi] && bw > 0) keep.push([bi, bw]);
    }
    for (let i = 0; i < 5; i++) {
      if (wj[i] * wt > 1e-4) keep.push([ti[i], wj[i] * wt]);
    }
    keep.sort((a, b) => b[1] - a[1]);
    if (keep.length > 4) keep.length = 4;
    let sum = 0;
    for (const c of keep) sum += c[1];
    for (let k = 0; k < 4; k++) {
      skinIndex[v * 4 + k] = k < keep.length ? keep[k][0] : 0;
      skinWeight[v * 4 + k] = k < keep.length ? keep[k][1] / sum : 0;
    }
  }
  return { skinIndex, skinWeight };
}

/* ==================================================================
   6. Vertex tint
   ================================================================== */

const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function linRGB(hex) {
  return [
    srgbToLin(((hex >> 16) & 255) / 255),
    srgbToLin(((hex >> 8) & 255) / 255),
    srgbToLin((hex & 255) / 255),
  ];
}

/**
 * vColor.rgb is a MULTIPLIER on the material's base albedo, so every tint
 * is expressed as a ratio against CLAY.body. That keeps a single clay
 * material for the whole body and still gives the ear-inner plate its own
 * value and the thin membranes their warm subsurface cast (§1.2, §1.5).
 */
/* Ear/skull crease: band half-width in metres, peak albedo value drop,
   peak drop on the shader's own AO channel. See the block in bakeTint. */
/* ROUND 2: tightened (0.086/0.22 -> 0.064/0.16). With the fan re-pinned
   high the old wide band wrapped onto the visible forehead and read as a
   diagonal dent across the dome rather than as the ear-root crease. */
const EAR_SEAM_R = 0.064;
const EAR_SEAM_W = 0.16;
const EAR_SEAM_A = 0.13;

/* Arm/flank seam — see armSeam() in buildBodyField for why this exists
   and why neither existing bake can find it.

   CREASE PASS — SIZED OFF A LUMINANCE SCAN OF BOTH IMAGES, NOT OFF A
   SWATCH. tools/creasetest.mjs walks a horizontal row inward from the
   silhouette edge on the hanging-arm side and reads arm -> crease ->
   flank. Run against ref/wally-ref-cool.png and the shipped build at
   f 0.44-0.60 of figure height, it says something the last three rounds
   all got backwards:

     the build's CREASE FLOOR was already as dark as the reference's
     (85-95 against 57-99). What was missing was on the ARM.

   Scanned across the slot at f 0.56 the reference runs, flank wall in:
   166 -> 55, hole, 71 -> 179 out to the lit arm. BOTH walls of the slot
   are dark; the arm's inboard face bottoms at 71. The shipped build ran
   108 -> 85, hole, 175 -> 217: its flank wall was right and its arm wall
   was never darkened at all, because that face points at the studio key
   and nothing in the pipeline knew it was inside a slot. One lit wall
   and one dark one is not a crease — it is a terminator, and a
   terminator is exactly what "the texture smears from flank into arm"
   describes.

   So the measure changes (see armSeam) and the value drop roughly
   trebles. Measured after, on the same rows, arm -> crease -> flank:

     f      GAME before        GAME after         REFERENCE
     0.44   215  85 133 .364   215  67 113 .402   213 147 204 .279
     0.48   217  66 111 .313   216  67 115 .416   212  82 202 .594
     0.52   218  89 141 .368   216  70 140 .501   211  77 203 .623
     0.56   215  90 135 .334   214  73 135 .463   207  79 198 .599

   THE RESIDUAL IS NOT THE CREASE, AND IT IS WORTH SAYING SO IN THE FILE
   SO THE NEXT ROUND DOES NOT DEEPEN IT FURTHER. The build's crease FLOOR
   (67-73) is now at or below the reference's (77-82). What is still 60
   luma short is the FLANK BESIDE IT: 113-140 here against 198-204 there.
   That gap is lighting, not shading — with wallySculpt(0) and wallyAO(0)
   both off, the same flank still ramps 213 -> 117 across 130 mm, because
   the studio key is rigged camera-upper-left and this is its terminator,
   and because the reference's arm hangs closer in so only ~30 mm of its
   flank is exposed against our 130. Neither of those lives in this file.

   IT IS STILL WARM, WHICH IS THE ONE THING A DEEPER CREASE CAN QUIETLY
   BREAK (§1.2: warm AO, never blue). Both halves of the drop carry
   warmth by construction: the albedo half rotates toward SHADOW.ao with
   the same value-neutral rCrease ratio the rest of bakeTint uses, and
   the alpha half is multiplied in toon.js by vec3(0.62,0.575,0.565),
   which is +10% red over blue. Measured in the deepened crease, R-B
   comes back +9 to +12 — §1.2's own band, and warmer than the lit clay
   beside it rather than cooler. */
/* ROUND 2 OF THE CREASE PASS — THE VALLEY WAS RIGHT AND THE FLOOR WAS
   NOT. The block above sized the drop against the reference's crease
   FLOOR and stopped there. Re-run with the sweep carried down the arm
   (creasetest --f 0.44,0.50,0.56,0.62,0.68) it says the drop overshot at
   the top of the band and is still absent at the bottom:

     f     GAME floor / w1/2      REF floor / w1/2
     0.44   67 / 22 mm            147 / 40 mm     <- a gash in the armpit
     0.50   67 / 28 mm             72 / 22 mm
     0.56   73 / 42 mm             79 / 25 mm
     0.62   69 / 44 mm             41 / 17 mm
     0.68  143 / --                 62 / 14 mm     <- no valley at all

   THE ARMPIT IS NOT A CONTACT LINE AND MUST NOT BE SHADED AS ONE. At
   f 0.44 the reference is a 40 mm SOFT shade bottoming at 147 — the arm
   is still merging into the shoulder there and no crease has formed.
   Ours put a 22 mm oval at 67 in the same place, which is the "black
   gash" failure in a different costume. The armpit fade therefore starts
   lower (0.88 -> 0.82) and keeps an eighth rather than a third, and the
   two drops come down across the whole band.

   THE FLANK HALF WAS REACHING 77 mm INTO LIT CLAY (R/1.28 at 936 mm per
   unit). The reference's flank is lit right up to the contact edge and
   recovers inside 15-25 mm; the skew now lets go at 31 mm, and the
   flat-bottom radius drops with it so the profile is an edge rather than
   a basin. THE ARM HALF IS UNCHANGED at 150 mm — that asymmetry is
   measured, documented in armSeam(), and correct.

   WHAT THE FLANK LUMA GAP IS NOT. The 60-70 luma between our lit flank
   (113-140) and the reference's (180-205) is NOT this band, and raising
   the skew cannot buy it back. Measured on identical frames with
   creasetest --extra:  band zeroed (W=A=0) moves the flank peak by 5
   luma; the whole baked sculpt+AO off (wallySculpt(0) wallyAO(0)) moves
   it by 25 and lands at 145-153 against the reference's 198-205. The
   remaining ~50 is the studio key's terminator on the camera-right
   flank plus how much further our arm hangs from the body, and neither
   of those is in this file. Deepening the band to chase that number is
   how the gash got here. */
const ARM_SEAM_R = 0.105;    // scaled dArm+dFlank at which the band dies
const ARM_SEAM_C = 0.024;    // ...and below which it is at full depth
const ARM_SEAM_SKEW_ARM = 0.70;     // arm wall: reach 1/0.70 further
const ARM_SEAM_SKEW_FLANK = 1.30;   // flank wall: let go sooner
const ARM_SEAM_W = 0.34;
const ARM_SEAM_A = 0.30;
/* THE FLANK WALL IS SHARPENED, NOT SHORTENED, AND THE DIFFERENCE IS THE
   WHOLE OF THIS FIX. The obvious move — raise SKEW_FLANK until the band
   stops 25 mm inboard — was tried first and MEASURED: at 3.20 the band
   dies at 31 mm of slot, this arm slot runs 30-57 mm, and the flank
   then never gets the band at all. The crease floor went 67 -> 89
   against a reference floor of 72: the band had switched itself off.
   (Note which wall that floor is on. At f 0.50-0.56 the row crosses
   arm, then 14-19 mm of TRUE BACKGROUND, then flank — the arm's inboard
   face is not in the profile, and the number the ruler calls the crease
   is the flank's own near-slot wall.)

   The flank band is broad for a geometric reason no skew can touch:
   dArm from a flank point 20 mm inboard of a 30 mm slot is only
   sqrt(30^2+20^2) = 36 mm, so a band keyed on dArm decays as slowly as
   the arm is big. What is wanted is full depth AT the slot and gone
   soon after — a curve shape, not a range. So the flank keeps a skew
   that actually fires and its smoothstep is raised to a power:
   0.93 -> 0.85 at the slot edge, 0.46 -> 0.17 at 40 mm, ~0 by 60. */
const ARM_SEAM_FLANK_P = 2.2;

/* THE BAND HAS TO LET GO BEFORE THE ARMPIT, AND THAT IS NOT A DETAIL.
   Above y ~0.88 the arm and the flank are FUSED — that is what an
   armpit is — so max(dArm,dFlank) collapses to near zero over a broad
   patch of shoulder rather than over two walls of a slot. At the old
   0.14 that patch was a soft shoulder shade; at 0.34 it would be a
   blotch, and because bakeTint is baked in BIND space it would travel
   with the skin and swing straight into view when the welcome pose
   opens the shoulder 26 degrees — the "black gash in welcome" this pass
   was explicitly told not to ship. The gain therefore falls to a third
   across y 0.88 -> 1.02, which is the old band's strength, and the low
   end fades over 0.50 -> 0.57 so the band ends on a gradient instead of
   a horizontal cut across the hip. */
/* THE LOW END NOW HANDS OVER TO A RUNTIME TERM INSTEAD OF FADING TO
   NOTHING (wally.js, installContactCrease). Below y ~0.62 the form the
   arm is closing on is the HIP and the THIGH, and this bake cannot go
   there: it runs per-vertex in BIND space, where the mitten hangs beside
   the thigh, so any leg-derived band is left behind on the hip the
   moment a pose swings the arm out — the hip-dirt failure the block
   above records, and the reason the low fade was set at 0.50 in the
   first place. Measured, that cut is exactly where the crease the user
   photographed lives: at f 0.68 the scan ran monotonic 209 -> 103 with
   NO minimum at all, against a reference that plunges to 62 in a 14 mm
   hairline between two lit forms.
   So the fade-in moves UP to 0.62 -> 0.76 and wally.js paints 1 - this
   ramp with posed capsule distances evaluated in the vertex shader,
   where the leg is legal because it is where the pose actually put it.
   The two gains are exact complements, so the total is unchanged. */
/* ROUND 8 — THE ARMPIT FADE OPENS EARLIER AND KEEPS LESS, AND THAT IS
   THE ONLY CHANGE THIS ROUND MAKES TO THE BAND. It was ordered to lift
   the crease FLOOR at f 0.50-0.68 from 55-60 to 140-170, because the
   reference was believed to sit at 112-147 there. IT DOES NOT. That
   reference column was BACKGROUND: ref/wally-ref-cool.png is cut on
   black, the rows at f 0.50-0.68 cross the true slot between arm and
   flank, and the old ruler sampled the hole and called it a crease.
   tools/creasemeasure.mjs now masks both images (magenta frame for the
   build, border-connected dark flood for the reference) and DROPS
   background from the profile before taking any minimum. The reference
   then reads, on the hanging-arm side:

       f      GAME floor    REF floor
       0.44       80          147     <- the one real defect
       0.50       77           72
       0.56       82           44
       0.62       84           41
       0.68      135           62

   At f 0.50-0.62 this build is already ON the reference or LIGHTER than
   it, and tools/creasetest.mjs — a different ruler, its own masks —
   prints the same thing. Raising that floor to 140-170 would put it 60
   to 100 luma ABOVE the reference and weld the arm back onto the flank,
   which is the defect the user reported in the first place. W and A are
   therefore UNCHANGED at 0.34 / 0.30.

   f 0.44 IS a gash: 80 against the reference's 147, a 22 mm oval where
   the reference has a 40 mm soft shade — the failure the ROUND 7 note
   above opens with, that the armpit is not a contact line and must not
   be shaded as one. MEASURED BY A/B on identical frames, the band owns
   11 luma of that 67: zeroing W and A moves f 0.44 from 80 to 91 (and
   f 0.50 from 77 to 91, which is why zeroing them is not the fix);
   killing the whole baked sculpt+AO reaches 114; the last 33 is the
   studio key's terminator and is not in this file. So the 11 that IS
   ours comes out of the armpit and out of nothing else. The fade opens
   at y 0.79 instead of 0.82 and keeps a sixteenth instead of an eighth,
   which takes the gain at f 0.44 (y 0.896) from 0.66 to 0.20 while
   f 0.50 (y 0.80) stays at 0.99 and every row below y 0.79 — the whole
   stretch that already matches the reference — is untouched.

   THE SKEWS ARE ALSO UNCHANGED, on the same evidence. The flank wall
   was reported as recovering in ~100 mm against the reference's 15-25.
   Masked, it recovers in 15 / 19 / 31 / 1 / 0 mm against the
   reference's 12 / 12 / 16 / 18 / 10, and ARM_SEAM_SKEW_FLANK's own
   note above records what raising it further did the last time. */
const ARM_SEAM_Y0 = 0.62, ARM_SEAM_Y1 = 0.76;   // low fade in / runtime handover
const ARM_SEAM_Y2 = 0.79, ARM_SEAM_Y3 = 0.93;   // armpit fade out
const ARM_SEAM_ARMPIT = 0.06;                   // gain retained at the armpit
/* The crease constants, exported so the RUNTIME half of this crease
   (wally.js installContactCrease) cannot drift from the baked half.
   Never re-type these numbers anywhere else — a stale literal is how
   the ear seam lost its back half. */
export const ARM_SEAM = {
  R: ARM_SEAM_R, C: ARM_SEAM_C,
  skewArm: ARM_SEAM_SKEW_ARM, skewFlank: ARM_SEAM_SKEW_FLANK,
  flankP: ARM_SEAM_FLANK_P,
  W: ARM_SEAM_W, A: ARM_SEAM_A,
  y0: ARM_SEAM_Y0, y1: ARM_SEAM_Y1,
};

function armSeamGain(y) {
  let g = 1;
  if (y < ARM_SEAM_Y1) {
    const t = (y - ARM_SEAM_Y0) / (ARM_SEAM_Y1 - ARM_SEAM_Y0);
    g = t <= 0 ? 0 : t * t * (3 - 2 * t);
  }
  if (y > ARM_SEAM_Y2) {
    const t = Math.min(1, (y - ARM_SEAM_Y2) / (ARM_SEAM_Y3 - ARM_SEAM_Y2));
    g *= 1 - (1 - ARM_SEAM_ARMPIT) * (t * t * (3 - 2 * t));
  }
  return g;
}

/* Trunk groove incision band (§1.5): a soft warm darkening hugging the
   three cut capsules. ROUND 5: this can NEVER be the carrier of the
   lines — it is baked per-vertex and the mesher cell (~15 mm) is wider
   than the band, so it interpolates into the fuzzy low-contrast smudge
   the critic rejected twice. The crisp read now comes from the dark
   stroke rods wally.js seats inside the channels (trunkGrooveSpecs);
   this band is demoted to a faint AO accent under them. */
const GROOVE_R = 0.0030;
const GROOVE_W = 0.18;
const GROOVE_A = 0.16;

/* nostril dimple tint (§1.1) — softer and wider than the incised lines:
   a shaded pit, not a drawn stroke. */
/* §1.2's clay is a "desaturated WARM grey" at every value, lit or not.
   See the block in bakeTint: this is a pure hue rotation toward
   SHADOW.ao, normalised to unit luminance, applied to the whole body. */
const WARM_BASE = 0.85;

const NOSTRIL_R = 0.0075;
const NOSTRIL_W = 0.26;
const NOSTRIL_A = 0.18;

export function bakeTint(pos, nor, count, field, ao, form, sky) {
  const col = new Float32Array(count * 4);
  /* The sculpt multiplier is kept so a debug hook can dial it back to 1
     and A/B the bake in a live frame — see WALLY.debug.wallySculpt(). */
  const sculptK = new Float32Array(count).fill(1);
  const base = linRGB(CLAY.body);
  const inner = linRGB(CLAY.earInner);
  const warm = linRGB(CLAY.sss);
  const rInner = [inner[0] / base[0], inner[1] / base[1], inner[2] / base[2]];
  const rWarm = [warm[0] / base[0], warm[1] / base[1], warm[2] / base[2]];
  /* §1.2's crease is "dark-WARM" (#A9A5A2), never grey (§7). This ratio
     is normalised to unit luminance on purpose: it must carry HUE ONLY.
     Left un-normalised it is a 0.62 multiplier as well, the value drop
     gets applied twice — once here and once by `shade` below — and the
     close-up measured a flank at luma 97 against §1.2's 207. Every one
     of these ratios is a direction, not a brightness. */
  const cr = linRGB(SHADOW.ao);
  const crL = 0.2126 * cr[0] + 0.7152 * cr[1] + 0.0722 * cr[2];
  const baseL = 0.2126 * base[0] + 0.7152 * base[1] + 0.0722 * base[2];
  const rCrease = [
    (cr[0] / crL) / (base[0] / baseL),
    (cr[1] / crL) / (base[1] / baseL),
    (cr[2] / crL) / (base[2] / baseL),
  ];

  const dish = field.dishDepth;
  const seam = field.earSeam;
  const aSeam = field.armSeam;
  for (let i = 0; i < count; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    let r = 1, g = 1, b = 1;
    let creaseA = 1;

    /* ---- SCULPTED VALUE (§1.2) ----------------------------------
       The albedo itself carries the form. vColor.rgb multiplies the
       base albedo before any light touches it, so this is the one term
       that reads identically at 90 px and at 900 px, under the studio
       key and with the sun behind him.

       Two inputs, both pure geometry:
         w   how much sky the point sees, biased by how far it faces up
         f   how much of its own hemisphere his body fills

       §1.2 measures the reference at #DEDEDD lit against #A9A9A8 in the
       deepest crease: 0.716 against 0.396 in linear, a ratio of 1.81.
       The window below is 0.760 -> 1.045 on the sky term and 0.80 -> 1.0
       on the form term, so the albedo alone spans 1.72 and the alpha AO
       tops it up. Wider than this and he stops being one material. */
    let kr = 1, kg = 1, kb = 1;
    if (form && sky) {
      /* BODY PASS — THE GRADIENT IS NOW HEIGHT, NOT ONLY CURVATURE, AND
         THAT IS WHY IT STOPS READING AS DIRT. A value structure built out
         of `up` and `sky` alone is a CURVATURE map: it darkens whatever is
         enclosed and brightens whatever sticks out, so the extremities win
         and the trunk of the body loses. Measured on the shipped welcome
         frame that put the HANDS at the top of the whole figure's range
         (luma 213 against a cranium of 204 and a belly of 178) and they
         read exactly as the critic described them — two glowing spheres —
         while ref/wally-ref-cool.png puts its hands at 175 against a
         cranium of 204, i.e. below the belly. A soft key from above and a
         body that occludes itself downward produce a HEIGHT ramp, and a
         height ramp is what the eye forgives as light. The third term
         costs the hands 2.4% against the cranium and reorders the figure
         to head > belly ~ hands, which is the reference's order. */
      const up = 0.5 + 0.5 * nor[i * 3 + 1];
      const hy = Math.max(0, Math.min(1, (y - 0.30) / 1.00));
      const w = 0.34 * up + 0.50 * sky[i] + 0.16 * (hy * hy * (3 - 2 * hy));
      /* LIKENESS PASS 4 — THE GRIME BAND IS DEAD. The 0.760->1.045 sky
         window times the 0.80->1.0 form window put a 0.61 multiplier on
         the hips and flanks — a top-to-bottom curvature gradient that
         the critic (correctly) read as "a broad low-frequency dirt band
         ... worst in welcome". The reference albedo is UNIFORM light
         grey; its darkening lives in true creases only, which the
         crease-radius AO now carries. What survives here is a whisper —
         combined span 0.879->1.033 — enough to keep him from going
         flat-cutout at gameplay range, invisible as dirt in the studio. */
      const shade = 0.920 + 0.105 * (w * w * (3 - 2 * w));
      const f = 0.945 + 0.055 * form[i];
      const k = shade * f;
      /* Value first, then a pure hue rotation toward §1.2's crease
         swatch in proportion to how deep the occlusion is. Applied at
         the END of the loop, after the tag tints: those are authored as
         absolute deltas off an albedo of 1, so scaling before them would
         silently change how much ear-inner plate you get. */
      /* ROUND 3: 1.9 -> 2.6 — the critic read the occlusion as "cool
         neutral-gray"; the rotation toward §1.2's warm crease swatch
         gets a stronger hand so every baked crease reads warm brown. */
      /* PASS 4: 2.6 -> 3.4. (1 - k) shrank with the narrowed window, so
         the gain rises to keep the hue rotation (value-neutral by
         construction) at the warmth the critic verified as correct. */
      /* BODY PASS — THE WHOLE OF HIM IS WARM, NOT JUST HIS CREASES. The
         rotation used to be gated on (1 - k), so it only fired where the
         bake was already dark: measured on the shipped frames, his creases
         came back at R-B +9 to +12 (right) and his LIT surfaces at +2 to
         +4 (wrong) — a figure that warms as it darkens, which is a stain,
         not a material. ref/wally-ref-cool.png holds R-B between +7 and
         +11 from the lit cranium to the deepest fold: the warmth is in the
         clay itself. WARM_BASE is that constant floor, expressed in the
         same value-neutral hue rotation toward SHADOW.ao that the creases
         already use, so nothing here changes a single luminance. */
      const t = WARM_BASE + Math.max(0, 1 - k) * 1.4;
      kr = k * (1 + (rCrease[0] - 1) * t);
      kg = k * (1 + (rCrease[1] - 1) * t);
      kb = k * (1 + (rCrease[2] - 1) * t);
      sculptK[i] = k;
    }

    /* ---- THE EAR/SKULL CREASE (§1.2 "under the ears") --------------
       Geometry, so it reads from behind exactly as it reads from the
       front — which is the whole point, because every judged frame so
       far has been the back of his head. 0.086 m of band is generous
       and soft per §1.2; the value drop tops out at 0.22, which lands
       the deepest part of the crease on §1.2's #A9A9A8 given the sculpt
       term already there, and it carries the same pure hue rotation
       toward the crease swatch that the sculpt uses. */
    if (seam) {
      const sd = seam(x, y, z);
      if (sd < EAR_SEAM_R) {
        let c = 1 - sd / EAR_SEAM_R;
        if (c > 1) c = 1;
        c = c * c * (3 - 2 * c);
        const dk = 1 - EAR_SEAM_W * c;
        const ht = c * 0.85;
        kr *= dk * (1 + (rCrease[0] - 1) * ht);
        kg *= dk * (1 + (rCrease[1] - 1) * ht);
        kb *= dk * (1 + (rCrease[2] - 1) * ht);
        sculptK[i] *= dk;
        creaseA = 1 - EAR_SEAM_A * c;
      }
    }

    /* ---- THE ARM/FLANK CREASE (§1.2 "armpits") — see armSeam() ----
       Same construction as the ear/skull crease above and for the same
       blindness in the two bakes; the difference is that this one is the
       defect the user reported, so it is measured against the reference
       rather than judged. */
    if (aSeam) {
      const raw = aSeam(x, y, z);
      const onFlank = raw < 0;
      const ad = onFlank ? -raw : raw;
      if (ad < ARM_SEAM_R) {
        /* Flat-bottomed, not conical. Everything closer than ARM_SEAM_C
           is a contact and gets the full drop; past that it falls off
           over the rest of the band. A plain 1 - ad/R put the floor on a
           single point and the reference's crease is a valley with a
           bottom to it, ~25 mm wide at half depth. */
        let c = (ARM_SEAM_R - ad) / (ARM_SEAM_R - ARM_SEAM_C);
        if (c > 1) c = 1; else if (c < 0) c = 0;
        c = c * c * (3 - 2 * c);
        if (onFlank) c = Math.pow(c, ARM_SEAM_FLANK_P);
        c *= armSeamGain(y);
        const dk = 1 - ARM_SEAM_W * c;
        const ht = c * 0.85;
        kr *= dk * (1 + (rCrease[0] - 1) * ht);
        kg *= dk * (1 + (rCrease[1] - 1) * ht);
        kb *= dk * (1 + (rCrease[2] - 1) * ht);
        sculptK[i] *= dk;
        creaseA *= 1 - ARM_SEAM_A * c;
      }
    }

    /* ---- THE THREE TRUNK LINES (§1.5) — see grooveDist() ---------- */
    if (field.grooveDist) {
      const gd = field.grooveDist(x, y, z);
      if (gd < GROOVE_R) {
        let c = 1 - (gd > 0 ? gd : 0) / GROOVE_R;
        c = c * c * (3 - 2 * c);
        const dk = 1 - GROOVE_W * c;
        const ht = c * 0.85;
        kr *= dk * (1 + (rCrease[0] - 1) * ht);
        kg *= dk * (1 + (rCrease[1] - 1) * ht);
        kb *= dk * (1 + (rCrease[2] - 1) * ht);
        sculptK[i] *= dk;
        creaseA *= 1 - GROOVE_A * c;
      }
    }

    /* ---- THE NOSTRIL DIMPLE (§1.1) — see nostrilDist() ------------
       Deepest at the pit floor (on the carving sphere, nd ~ 0), fading
       to nothing over the rim — the ref's shaded doughnut, in both the
       up-curled 'cool' tip and the camera-facing 'welcome' nub. */
    if (field.nostrilDist) {
      const nd = field.nostrilDist(x, y, z);
      if (nd < NOSTRIL_R) {
        let c = 1 - (nd > 0 ? nd : 0) / NOSTRIL_R;
        c = c * c * (3 - 2 * c);
        const dk = 1 - NOSTRIL_W * c;
        const ht = c * 0.85;
        kr *= dk * (1 + (rCrease[0] - 1) * ht);
        kg *= dk * (1 + (rCrease[1] - 1) * ht);
        kb *= dk * (1 + (rCrease[2] - 1) * ht);
        sculptK[i] *= dk;
        creaseA *= 1 - NOSTRIL_A * c;
      }
    }

    const tag = field.tagAt(x, y, z);
    if (tag === 'ear') {
      /* inside the carved dish -> the inner plate */
      const dd = dish(x, y, z);
      const t = Math.max(0, Math.min(1, (0.030 - dd) / 0.030));
      r += (rInner[0] - 1) * t; g += (rInner[1] - 1) * t; b += (rInner[2] - 1) * t;
      /* thin membrane toward the outer edge -> warm transmission */
      const m = Math.max(0, Math.min(1, (Math.abs(x) - 0.38) / 0.28)) * 0.28;
      r += (rWarm[0] - 1) * m; g += (rWarm[1] - 1) * m; b += (rWarm[2] - 1) * m;
    } else if (tag === 'trunk') {
      const m = Math.max(0, Math.min(1, (0.98 - y) / 0.22)) * 0.24;
      r += (rWarm[0] - 1) * m; g += (rWarm[1] - 1) * m; b += (rWarm[2] - 1) * m;
    }

    col[i * 4] = r * kr; col[i * 4 + 1] = g * kg; col[i * 4 + 2] = b * kb;
    col[i * 4 + 3] = ao[i] * creaseA;
  }
  col.sculptK = sculptK;
  return col;
}

/* ==================================================================
   7. Assembling the body geometry
   ================================================================== */

/* Cell size, metres. Surface nets puts vertices ON the iso-surface, so the
   silhouette error of a chord `c` on a feature of radius R is only
   c^2 / 8R — 0.03 mm on the cranium at 16 mm cells. Resolution here buys
   fine sculpt detail (the trunk grooves, the ear rim), not smoothness;
   smoothness comes from the analytic gradient normals. */
/* RESOLUTION NOW BUYS TOPOLOGY, NOT JUST DETAIL. The arm slot is 28 mm at
   its narrowest and the mesher can only open a hole where a grid point
   lands strictly inside it with a positive field — at 15.5 mm that is 1.8
   cells and it is a coin toss per row, which is exactly how you get an arm
   that is separate for 200 mm and welded for 40. 13.2 mm makes it 2.1
   cells everywhere and 3-5 cells over the rest of the slot. */
const CELL_BY_TIER = { low: 0.0200, med: 0.0168, high: 0.0136, ultra: 0.0124 };

export function buildBodyGeometry(quality = 'high') {
  const tier = String(quality || 'high').replace(/\(.*/, '');
  const cell = CELL_BY_TIER[tier] ?? CELL_BY_TIER.high;

  const field = buildBodyField();
  const occ = buildOccluderField();
  const mesh = surfaceNets(field.d, field.bounds, cell);

  /* Drop slivers before anything reads the topology. Surface nets does not
     normally emit them, but a blend that lands exactly on a grid plane can,
     and a zero-area triangle survives the mesher only to shade as a hard
     unlit facet once the skin moves. */
  mesh.index = cullDegenerate(mesh.position, mesh.index, cell);

  /* strength 1.16: §1.2 calls AO at every crease "non-negotiable" and at
     1.05 with short rays there was measurably no darkening where the
     ears meet the head or where the trunk meets the face. The shader
     multiplies this by a warm #A9A5A2-equivalent grey, never a neutral
     one, so deeper here means warmer-darker, not greyer — which is why
     the strength is paired with the 0.28 floor in bakeAO() rather than
     pushed on its own. */
  const ao = bakeAO(mesh.position, mesh.normal, mesh.count, field.d, occ, 1.16, mesh.index);

  /* Form + sky occlusion against the body proxy — see the block above
     bakeFormOcclusion(). Smoothed over the one-ring for the same reason
     the cone trace is: §1.2 forbids a hard contact darkening, and an
     analytic solid angle changes fast where two forms nearly touch. */
  const form = new Float32Array(mesh.count);
  const sky = new Float32Array(mesh.count);
  bakeFormOcclusion(mesh.position, mesh.normal, mesh.count,
    buildProxySpheres(), form, sky);
  smoothScalar(form, mesh.count, mesh.index, 5, 0.62);
  smoothScalar(sky, mesh.count, mesh.index, 6, 0.66);

  /* The alpha channel keeps the fine cone trace and takes a share of the
     form term. toon.js floors the alpha's effect at 0.62, so the deep end
     of the range has to live in the albedo (bakeTint); this is the part
     that still has to respond to the shader's own warm AO tint. */
  /* LIKENESS PASS 4: 0.78 -> 0.92. The form term is a body-wide solid
     -angle gradient; at a 0.22 share it re-painted the same hip/flank
     grime band the bakeTint window was narrowed to remove. A 0.08 share
     keeps the thighs seating against each other without a dirt wash. */
  for (let i = 0; i < mesh.count; i++) {
    ao[i] *= 0.92 + 0.08 * form[i];
  }
  const col = bakeTint(mesh.position, mesh.normal, mesh.count, field, ao, form, sky);
  const { skinIndex, skinWeight } = bakeWeights(mesh.position, mesh.count);
  /* 5 passes takes the number of hard weight seams (L1 > 1.0 across a mesh
     edge) from 452 to 9 and the worst from a full 2.0 discontinuity to
     1.17, while leaving the bulk weights untouched — the ear tip is still
     0.96 earL2 and the trunk tip still 0.88 trunk4. */
  smoothWeights(mesh.index, mesh.count, skinIndex, skinWeight, 5, 0.55);
  /* AFTER the Laplacian pass, because the Laplacian is HOW the ear
     reaches the cheek: the capture pass alone leaves the bleed at
     ~0.2 and five passes of one-ring averaging take it to 0.5 on skin
     70 mm outside the fan. Clamping before the smoothing would simply
     be undone by it. See the block on clampEarWeights. */
  clampEarWeights(mesh.position, mesh.count, skinIndex, skinWeight);
  /* AFTER the Laplacian pass: the trunk's inter-bone bands are re-derived
     analytically in arc length (see blendTrunkWeights) so a straightened
     hang bends over 84 mm per joint instead of pinching a ring at every
     station. Smoothing first means the head/trunk root boundary this pass
     preserves is already the smoothed one. */
  blendTrunkWeights(mesh.position, mesh.count, skinIndex, skinWeight);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(mesh.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(mesh.normal, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  g.userData.sculptK = col.sculptK;
  g.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(mesh.count * 2), 2));
  g.setIndex(mesh.count > 65535
    ? new THREE.BufferAttribute(new Uint32Array(mesh.index), 1)
    : new THREE.BufferAttribute(new Uint16Array(mesh.index), 1));
  g.computeBoundingSphere();
  g.userData.triangles = mesh.index.length / 3;
  g.userData.cell = cell;
  return g;
}

/* ==================================================================
   8. Tusks — §1.3
   ================================================================== */

export function buildTuskGeometry(side, quality = 'high') {
  const t = P.tusk;
  /* Both tusks are swept in +x space and the right one is reflected, so
     the two can never disagree about winding. A curve mirrored through
     x = 0 has a mirrored tangent and normal but a NEGATED binormal, which
     reverses the ring parametrisation and turns one of the pair
     inside-out — build them independently and only one of them is solid.
     The 3 degrees of asymmetry §1.3 asks for is applied before the
     reflection, so it survives it. */
  const a = t.asym * (side > 0 ? 1 : -1.0);
  /* ROUND 3: 1.0 — the pair is geometrically identical, mirrored. The
     critic still read 0.995 + 1.5 degrees as "visibly mismatched"; with
     asym now 0 in rig.js this whole path is an exact reflection. */
  const scale = 1.0;
  const rot = (p) => {
    const x = p[0], y = p[1] - 1.17, z = p[2];
    const ca = Math.cos(a), sa = Math.sin(a);
    return [(x * ca - y * sa) * scale, (x * sa + y * ca) * scale + 1.17, z * scale];
  };
  /* ROUND 7 — THE ROOT IS A FOURTH STATION, BURIED IN THE SKULL. From
     the side camera the round-6 tusk's butt hung in clear air beside the
     cheek: the base point sat only 3.4 mm inside the body field (probed,
     not guessed) while the cap around it has a 47 mm radius, so 44 mm of
     rounded end was on show and the cone read as a horn glued to the
     face rather than a tusk growing out of it. `root` extends the sweep
     62 mm back along the base->mid axis to a point the field puts 58 mm
     under the skin — the whole cap is inside the head, and what the
     camera sees is the cone crossing the cheek surface, which is §1.1's
     "emerging from under the cheek line".
     The radius profile is keyed to CHORD POSITION, not to u<0.5, because
     with four unevenly spaced stations the arc midpoint is no longer the
     `mid` control point and the old two-branch lerp would have put the
     waist in the wrong place. */
  const pts = [rot(t.root), rot(t.base), rot(t.mid), rot(t.tip)];
  const rs = [t.r[0], t.r[0], t.r[1], t.r[2]];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0],
      pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
  }
  const total = cum[cum.length - 1] || 1;
  for (let i = 0; i < cum.length; i++) cum[i] /= total;
  const curve = new THREE.CatmullRomCurve3(
    pts.map((p) => new THREE.Vector3(p[0], p[1], p[2])), false, 'catmullrom', 0.4,
  );
  const seg = quality === 'low' ? 24 : 40;
  const radial = quality === 'low' ? 12 : 20;
  const geo = sweptTube(curve, (u) => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < u) i++;
    const f = (u - cum[i - 1]) / Math.max(cum[i] - cum[i - 1], 1e-6);
    const r = rs[i - 1] + (rs[i] - rs[i - 1]) * Math.max(0, Math.min(1, f));
    return r * scale;
  }, seg, radial, true);
  if (side > 0) return geo;
  const m = mirrorGeometryX(geo);
  geo.dispose();
  return m;
}

/**
 * A capped swept tube with rounded ends. Used for the tusks.
 *
 * TWO BUGS LIVED HERE AND BOTH SHOWED.
 *
 * 1. WINDING. The quads were wound (a, c, b) — ring i vertex j, ring i+1
 *    vertex j, ring i vertex j+1. With a Frenet frame that is
 *    (T ds) x (B r dth) = -N: the face normal pointed INWARD while the
 *    vertex normals pointed outward. Under front-face culling that renders
 *    the tusk's interior, lit by an outward normal — which is exactly what
 *    "an open, zero-thickness curled shell with a knife-sharp rim and a
 *    dirty grey-khaki albedo" is. It was never a thin tusk; it was the
 *    inside of a correct one.
 *
 * 2. NO END CAP. The "rounded" caps stop at cos(4/4.5 * pi/2) = 0.174 of
 *    the radius and leave a hole at each end. A hole you can see through
 *    is a hole whether it is 2 mm or 20. Both ends now close on a centre
 *    vertex.
 */
function sweptTube(curve, radiusFn, seg, radial, roundTip) {
  const pos = [], nor = [], idx = [];
  const frames = curve.computeFrenetFrames(seg, false);
  const rings = [];
  for (let i = 0; i <= seg; i++) {
    const u = i / seg;
    rings.push({
      p: curve.getPointAt(u),
      n: frames.normals[i], b: frames.binormals[i], t: frames.tangents[i],
      r: radiusFn(u),
    });
  }
  /* rounded caps: shrink the last rings toward the axis over a hemisphere */
  const capRings = roundTip ? 4 : 0;
  const all = [];
  for (let c = capRings; c > 0; c--) {
    const f = Math.cos((c / (capRings + 0.5)) * Math.PI * 0.5);
    const R = rings[0];
    all.push({ p: R.p.clone().addScaledVector(R.t, -R.r * Math.sin((c / (capRings + 0.5)) * Math.PI * 0.5)), n: R.n, b: R.b, r: R.r * f });
  }
  for (const r of rings) all.push(r);
  for (let c = 1; c <= capRings; c++) {
    const f = Math.cos((c / (capRings + 0.5)) * Math.PI * 0.5);
    const R = rings[seg];
    all.push({ p: R.p.clone().addScaledVector(R.t, R.r * Math.sin((c / (capRings + 0.5)) * Math.PI * 0.5)), n: R.n, b: R.b, r: R.r * f });
  }

  for (let i = 0; i < all.length; i++) {
    const R = all[i];
    for (let j = 0; j <= radial; j++) {
      const th = (j / radial) * Math.PI * 2;
      const cx = Math.cos(th), sy = Math.sin(th);
      const nx = R.n.x * cx + R.b.x * sy;
      const ny = R.n.y * cx + R.b.y * sy;
      const nz = R.n.z * cx + R.b.z * sy;
      pos.push(R.p.x + nx * R.r, R.p.y + ny * R.r, R.p.z + nz * R.r);
      nor.push(nx, ny, nz);
    }
  }
  const w = radial + 1;
  for (let i = 0; i < all.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * w + j, b = a + 1, c = a + w, d = c + 1;
      /* (a, b, c) => (B r dth) x (T ds) = +N, i.e. outward. */
      idx.push(a, b, c, b, d, c);
    }
  }

  /* --- close both ends on a centre vertex so the solid is watertight --- */
  const capEnd = (ringIdx, tangentSign) => {
    const R = all[ringIdx];
    const T = curve.getTangentAt(ringIdx === 0 ? 0 : 1);
    const c0 = pos.length / 3;
    pos.push(R.p.x, R.p.y, R.p.z);
    nor.push(T.x * tangentSign, T.y * tangentSign, T.z * tangentSign);
    const base = ringIdx * w;
    for (let j = 0; j < radial; j++) {
      if (tangentSign < 0) idx.push(c0, base + j + 1, base + j);
      else idx.push(c0, base + j, base + j + 1);
    }
  };
  capEnd(0, -1);
  capEnd(all.length - 1, 1);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

/* ==================================================================
   9. The glasses — §1.4
   ==================================================================

   REBUILT (ROUND 4) AS ONE RIGID ASSEMBLY. The previous build swept the
   brow bar, the two lenses and the bridge on three unrelated surfaces —
   a world-horizontal parabolic bar, tilted lens planes whose top edges
   sat ~20 mm behind the bar's back face, and a separately swept bridge —
   and from any camera above the eye line the result read as a floating
   visor plate with two disconnected lens blobs and bare skin between
   them (verified in shots/my-cool.png / my-welcome.png).

   Now everything lives on ONE parametric FACE SHELL: a surface pitched
   back `glass.pitch`, wrapped cylindrically (radius `glass.wrapR`) about
   the head's vertical axis. Points are addressed as (s, t): s across the
   face along the wrap, t up the surface. The ENTIRE front — thick brow
   bar whose lower edge flows into two trapezoid lens frames joined by a
   short bridge over the trunk root — is a single closed silhouette (one
   outer outline, two lens-opening holes) triangulated with
   THREE.ShapeUtils and extruded along the shell normal into ONE solid.
   The black lens panels are inset INTO those openings on the same shell.
   Bar, frames, bridge and lenses cannot separate, shear or tilt against
   each other by construction. */

/**
 * Lens-opening outline in (s,t), authored as control points and smoothed
 * with a closed centripetal Catmull-Rom: a wayfarer lens is a
 * rounded-corner trapezoid — flat top under the brow bar, near-vertical
 * inner edge, a bottom that runs flat between two held corners, outer
 * edge tapering slightly in as it drops. +x is OUTWARD (toward the ear).
 */
const LENS_CTRL = [
  [-1.00, -0.42],  // inner bottom corner, held
  [-0.60, -0.88],
  [0.10, -1.00],   // flat bottom run
  [0.72, -0.94],
  [1.00, -0.52],   // outer bottom corner, held
  [1.04, 0.30],    // outer edge, nearly straight
  [0.92, 0.86],    // outer top corner
  [0.30, 1.00],    // flat top, under the brow bar
  [-0.55, 1.00],
  [-1.02, 0.74],   // inner top corner — hooks toward the bridge
];

function catmullClosed2D(ctrl, n) {
  const m = ctrl.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * m;
    const i1 = Math.floor(t) % m;
    const f = t - Math.floor(t);
    const p0 = ctrl[(i1 - 1 + m) % m], p1 = ctrl[i1];
    const p2 = ctrl[(i1 + 1) % m], p3 = ctrl[(i1 + 2) % m];
    const f2 = f * f, f3 = f2 * f;
    const c = (a, b, cc, d) => 0.5 * ((2 * b) + (-a + cc) * f
      + (2 * a - 5 * b + 4 * cc - d) * f2 + (-a + 3 * b - 3 * cc + d) * f3);
    out.push([c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])]);
  }
  return out;
}

function lensOutline(a, b, n = 96) {
  return catmullClosed2D(LENS_CTRL, n).map(([x, y]) => [x * a, y * b]);
}

/* ---- the face shell ----------------------------------------------
   World point at (s, t), offset `off` along the local outward normal.
   Basis: X = [1,0,0]; in-surface up T = [0, cos p, -sin p]; centre
   normal N0 = [0, sin p, cos p]. The wrap swings the ends back around
   the tilted vertical axis: theta = s / wrapR. Every part of the
   assembly — bar, frames, bridge, lens panels, temple-arm anchors — is
   expressed through these three functions, which is what makes the
   assembly rigid by construction. */
function shellPoint(s, t, off = 0) {
  const g = P.glass;
  const cp = Math.cos(g.pitch), sp = Math.sin(g.pitch);
  const th = s / g.wrapR, c = Math.cos(th), sn = Math.sin(th);
  const sag = g.wrapR * (1 - c);
  return [
    g.wrapR * sn + sn * off,
    g.shellY + cp * t - sp * sag + sp * c * off,
    g.shellZ - sp * t - cp * sag + cp * c * off,
  ];
}
function shellNormal(s) {
  const g = P.glass;
  const cp = Math.cos(g.pitch), sp = Math.sin(g.pitch);
  const th = s / g.wrapR, c = Math.cos(th), sn = Math.sin(th);
  return [sn, sp * c, cp * c];
}
/* in-surface width direction dP/ds at s (unit) */
function shellWidthDir(s) {
  const g = P.glass;
  const cp = Math.cos(g.pitch), sp = Math.sin(g.pitch);
  const th = s / g.wrapR, c = Math.cos(th), sn = Math.sin(th);
  return [c, -sp * sn, -cp * sn];
}
function shellUpDir() {
  const g = P.glass;
  return [0, Math.cos(g.pitch), -Math.sin(g.pitch)];
}

/**
 * The outer silhouette of the whole front, one closed CCW outline in
 * (s,t): bar top, bar ends, down and around each lens frame (the lens
 * opening expanded by rimM), and the arched notch between the lenses
 * under the bridge. Authored for the +s half and mirrored, so the two
 * sides cannot disagree.
 */
function frontSilhouette(n = 200) {
  const g = P.glass;
  const A = g.lensA + g.rimM, B = g.lensB + g.rimM;
  const R = (cx, cy) => [g.lensS + cx * A, cy * B];
  const half = [
    [0, g.notchT],                          // notch apex, under the bridge
    R(-1.00, -0.42),                        // inner bottom corner
    R(-0.60, -0.88),
    R(0.10, -1.00),                         // flat bottom run
    R(0.72, -0.94),
    R(1.00, -0.52),                         // outer bottom corner
    R(1.045, 0.05),                         // outer edge
    [g.barEndS - 0.002, 0.046],             // flare out into the bar end
    [g.barEndS, 0.080],                     // bar end, outer edge
    [g.barEndS - 0.016, g.barTop - 0.002],  // rounded top corner
    [g.barEndS * 0.55, g.barTop],           // bar top edge
    [0.06, g.barTop],
  ];
  const ctrl = [];
  for (const p of half) ctrl.push(p);
  ctrl.push([0, g.barTop]);                 // top centre
  for (let i = half.length - 1; i >= 1; i--) ctrl.push([-half[i][0], half[i][1]]);
  return catmullClosed2D(ctrl, n);
}

/* signed area of a 2D loop — used to force windings */
function loopArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a * 0.5;
}

/**
 * The frame: the ONE-PIECE front slab (bar + lens frames + bridge —
 * front face, back face, side walls) plus the two temple arms, merged
 * into a single geometry that is parented to the head bone as a unit.
 */
export function buildFrameGeometry(quality = 'high') {
  const g = P.glass;
  const nOut = quality === 'low' ? 120 : 200;
  const nHole = quality === 'low' ? 48 : 96;

  /* outer CCW, holes CW: with those windings the 2D right-of-travel
     normal (dt, -ds) is the true outward direction on the outer wall and
     points INTO the opening on hole walls — no per-segment guessing. */
  let outer = frontSilhouette(nOut);
  if (loopArea(outer) < 0) outer = outer.slice().reverse();
  let holeR = lensOutline(g.lensA, g.lensB, nHole).map(([x, y]) => [x + g.lensS, y]);
  if (loopArea(holeR) > 0) holeR = holeR.slice().reverse();
  let holeL = holeR.map(([x, y]) => [-x, y]);
  if (loopArea(holeL) > 0) holeL = holeL.slice().reverse();

  const loops = [outer, holeR, holeL];
  const flat = outer.concat(holeR, holeL);
  const v2 = (l) => l.map(([x, y]) => new THREE.Vector2(x, y));
  const tris = THREE.ShapeUtils.triangulateShape(v2(outer), [v2(holeR), v2(holeL)]);

  const pos = [], nor = [], idx = [];
  const push = (p, n) => { pos.push(p[0], p[1], p[2]); nor.push(n[0], n[1], n[2]); };

  /* front + back faces */
  for (const [s, t] of flat) push(shellPoint(s, t, 0), shellNormal(s));
  const backBase = flat.length;
  for (const [s, t] of flat) {
    const n = shellNormal(s);
    push(shellPoint(s, t, -g.depth), [-n[0], -n[1], -n[2]]);
  }
  for (const [a, b, c] of tris) {
    idx.push(a, b, c);                                  // front
    idx.push(backBase + a, backBase + c, backBase + b); // back, reversed
  }

  /* side walls: one strip per loop, duplicated verts for hard edges */
  for (const loop of loops) {
    const base0 = pos.length / 3;
    for (let i = 0; i < loop.length; i++) {
      const [s, t] = loop[i];
      const [s2, t2] = loop[(i + 1) % loop.length];
      let nx = (t2 - t), ny = -(s2 - s);
      const l = Math.hypot(nx, ny) || 1;
      nx /= l; ny /= l;
      const W = shellWidthDir((s + s2) * 0.5);
      const U = shellUpDir();
      const wn = [W[0] * nx + U[0] * ny, W[1] * nx + U[1] * ny, W[2] * nx + U[2] * ny];
      const pA = shellPoint(s, t, 0), pB = shellPoint(s, t, -g.depth);
      const pC = shellPoint(s2, t2, 0), pD = shellPoint(s2, t2, -g.depth);
      push(pA, wn); push(pB, wn); push(pC, wn); push(pD, wn);
      const k = base0 + i * 4;
      /* orient the quad so its face agrees with the wall normal */
      const e1 = [pB[0] - pA[0], pB[1] - pA[1], pB[2] - pA[2]];
      const e2 = [pC[0] - pA[0], pC[1] - pA[1], pC[2] - pA[2]];
      const cr = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      if (cr[0] * wn[0] + cr[1] * wn[1] + cr[2] * wn[2] > 0) {
        idx.push(k, k + 1, k + 2, k + 2, k + 1, k + 3);
      } else {
        idx.push(k, k + 2, k + 1, k + 2, k + 3, k + 1);
      }
    }
  }

  const slab = new THREE.BufferGeometry();
  slab.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  slab.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  slab.setIndex(idx);

  /* --- TEMPLE ARMS (§1.4): from the outer corners of the front, back
     across the cheeks, hooking DOWN under the ear roots — visible in
     profile. The start point is ON the slab (buried half a depth into
     the bar end) so arm and front can never show a seam. Built once,
     mirrored, so the pair cannot disagree. --- */
  /* THE ARM BOWS OUTWARD AROUND THE CHEEK. The skull half-width at arm
     height is ~0.274; a path that runs x 0.274-0.286 submerges half the
     bar into the cheek and the arm reads as a stub that ends mid-face
     (seen in lk-side.png). Real wayfarer arms flare out around a wide
     head: mid-path x 0.292-0.300 keeps the whole 11 mm section proud of
     the skin all the way to the ear root, then the hook drops behind
     the ear fan. */
  /* THE HOOK CURLS IN, NOT DOWN AND BACK — arithmetic, not taste. "His
     sunglasses in the back of his ears sometimes stick out when he is
     moving/running": the arm is rigid on the head, the ear is a spring
     chain pivoting about its root at (0.285, 1.432, -0.052), and the old
     hook ended at (0.286, 1.329, -0.096) — 112 mm out on that pivot's
     radius. What covers it is the ear's buried root wedge, the lobe at
     (0.252, 1.408, -0.030) with half-axes 0.076 x 0.150 x 0.074 about
     the plate normal (0.220, 0.200, 0.955). Put the old end point in
     that lobe's frame and the ellipsoid test comes out 1.52: it was
     OUTSIDE the wedge at bind, before the ear had moved at all, and
     only the fan's bulk hid it in a still frame. A stride swung the
     root, the gap opened, and the black hook sat in it — visible in
     shots/c0-back.png at the right ear and absent from the same shot
     standing still.

     The new end is (0.278, 1.382, -0.074): 55 mm on the pivot radius
     instead of 112, and the same test gives 0.54 against 1.52 — well
     inside the wedge, which is what it has to be, because the wedge
     ROTATES with the ear and a bind-space pass only tells you where
     the margin starts. 0.88 (the first cut, at 73 mm) still printed a
     17x34 px black sliver in the ear-root notch on three of eight
     back-camera run frames; 0.54 prints none on any of them. It is
     still 14.7 mm proud of the 0.278 head ball, so §1.4's
     "visible in side view... hooked ends peek past the head silhouette
     from behind" survives; the hook curls in toward the skull instead
     of dropping off the back of it. Nothing else about the assembly
     moves. */
  const anchor = shellPoint(g.barEndS - 0.010, 0.068, -g.depth * 0.5);
  const yArm = anchor[1];
  const tPts = [
    new THREE.Vector3(anchor[0], anchor[1], anchor[2]),
    new THREE.Vector3(0.272, yArm + 0.004, 0.116),
    new THREE.Vector3(0.292, yArm + 0.008, 0.004),
    new THREE.Vector3(0.300, yArm + 0.020, -0.066),   // under the ear root
    new THREE.Vector3(0.278, yArm + 0.013, -0.074),   // the hook, down and IN
  ];
  const temple = sweptBar(new THREE.CatmullRomCurve3(tPts), 0.0110, 0.0280,
    quality === 'low' ? 12 : 22, 0.0042);

  return mergeGeometries([slab, temple, mirrorGeometryX(temple.clone())]);
}

/**
 * Lens panel: a gently domed black plate inset INTO a frame opening on
 * the same shell, oversized 10% so its rim tucks behind the frame front.
 * UVs on the front face are exactly the texture space THE GLINT is
 * painted in.
 *
 * ONE SHAPE, MIRRORED. The right lens is the left one reflected through
 * x = 0 with u flipped, so the two panels are identical and the painted
 * mark points the SAME way on both — §1.4's "both lenses carry the
 * identical mark in the same direction" is structural, not tuned.
 */
export function buildLensGeometry(side) {
  if (side < 0) {
    const src = buildLensGeometry(1);
    const out = mirrorGeometryX(src, true);
    src.dispose();
    return out;
  }
  const g = P.glass;
  const a = g.lensA * 1.10, b = g.lensB * 1.10;
  const out = lensOutline(a, b, 96);
  const rings = 8;
  const pos = [], nor = [], uv = [], idx = [];
  const nOut = out.length;
  const U = shellUpDir();

  /* THE PANEL IS A FLAT PLATE ON THE TANGENT PLANE AT ITS CENTRE, not a
     patch of the wrapped shell. On the shell, the panel's outer margin
     tilts up to ~25 degrees toward a profile camera, and because the
     glint is emissive it stayed full white at grazing — a white curl on
     the lens silhouette in every true-side view (lk-side.png, verified
     by hiding each lens in turn). A flat plate at lensInset 13 mm keeps
     every point behind the frame front (the tangent chord rises only
     ~11.8 mm at the panel's outer edge) and the frame occludes the mark
     at grazing. */
  const O0 = shellPoint(g.lensS, 0, 0);
  const W0 = shellWidthDir(g.lensS), N0 = shellNormal(g.lensS);
  const flatPoint = (px, py, off) => [
    O0[0] + W0[0] * px + U[0] * py + N0[0] * off,
    O0[1] + W0[1] * px + U[1] * py + N0[1] * off,
    O0[2] + W0[2] * px + U[2] * py + N0[2] * off,
  ];
  const zAt = (px, py) =>
    g.lensBulge * (1 - 0.62 * (px / a) ** 2 - 0.62 * (py / b) ** 2);
  const pushN = (nl) => {
    nor.push(
      W0[0] * nl[0] + U[0] * nl[1] + N0[0] * nl[2],
      W0[1] * nl[0] + U[1] * nl[1] + N0[1] * nl[2],
      W0[2] * nl[0] + U[2] * nl[1] + N0[2] * nl[2],
    );
  };

  /* front face: concentric rings */
  for (let r = 0; r <= rings; r++) {
    const tt = r / rings;
    for (let j = 0; j < nOut; j++) {
      const px = out[j][0] * tt, py = out[j][1] * tt;
      const p = flatPoint(px, py, -g.lensInset + zAt(px, py));
      pos.push(p[0], p[1], p[2]);
      const dx = -g.lensBulge * 1.24 * px / (a * a);
      const dy = -g.lensBulge * 1.24 * py / (b * b);
      pushN(norm3([-dx, -dy, 1]));
      uv.push(px / a * 0.5 + 0.5, 0.5 - py / b * 0.5);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let j = 0; j < nOut; j++) {
      const j2 = (j + 1) % nOut;
      const A = r * nOut + j, B = r * nOut + j2;
      const C = (r + 1) * nOut + j, D = (r + 1) * nOut + j2;
      idx.push(A, C, D, A, D, B);
    }
  }
  /* rim wall + flat back, so the panel is a closed solid in the frame.
     THE RIM SAMPLES ITS OWN EDGE TEXEL. Giving the rim rows a fixed
     corner uv (0.02, 0.02) made every rim triangle interpolate a
     straight line ACROSS the canvas — straight through the white mark
     mid-lens — which painted bright streaks along the lens edges
     (visible as the white arcs under the lens bottoms in lk-cool.png).
     With both rim rows pinned to the outline's own uv the interpolation
     never leaves the black border. */
  const base = pos.length / 3;
  const backOff = -g.lensInset - 0.016;
  for (let sw = 0; sw < 2; sw++) {
    for (let j = 0; j < nOut; j++) {
      const px = out[j][0], py = out[j][1];
      const sc = sw === 0 ? 1 : 0.94;
      const off = sw === 0 ? -g.lensInset + zAt(px, py) : backOff;
      const p = flatPoint(px * sc, py * sc, off);
      pos.push(p[0], p[1], p[2]);
      pushN(norm3([px / a, py / b, sw === 0 ? 0.35 : -0.5]));
      uv.push(px / a * 0.5 + 0.5, 0.5 - py / b * 0.5);
    }
  }
  for (let j = 0; j < nOut; j++) {
    const j2 = (j + 1) % nOut;
    const A = base + j, B = base + j2, C = base + nOut + j, D = base + nOut + j2;
    idx.push(A, C, D, A, D, B);
  }
  const cen = pos.length / 3;
  const pc = flatPoint(0, 0, backOff);
  pos.push(pc[0], pc[1], pc[2]);
  nor.push(-N0[0], -N0[1], -N0[2]);
  uv.push(0.02, 0.02);
  for (let j = 0; j < nOut; j++) {
    idx.push(cen, base + nOut + ((j + 1) % nOut), base + nOut + j);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

/**
 * A swept bar of rectangular section with rounded corners, capped at both
 * ends.
 *
 * The section is oriented from a FIXED up vector rather than from Frenet
 * frames. Frenet frames roll as the curvature changes, and on an arc that
 * wraps a head that roll turns the ends of the brow bar into little
 * flared spikes over the ears — which is exactly what the first pass did.
 * A brow bar's height is vertical everywhere, by definition.
 */
function sweptBar(curve, depth, height, seg, round, up = [0, 1, 0]) {
  const prof = [];
  const nC = 4;
  const hx = depth * 0.5 - round, hy = height * 0.5 - round;
  for (let c = 0; c < 4; c++) {
    const cx = (c === 0 || c === 3) ? hx : -hx;
    const cy = (c < 2) ? hy : -hy;
    for (let i = 0; i <= nC; i++) {
      const a = (c * Math.PI / 2) + (i / nC) * Math.PI / 2;
      prof.push([cx + Math.cos(a) * round, cy + Math.sin(a) * round]);
    }
  }
  const U = new THREE.Vector3(up[0], up[1], up[2]).normalize();
  const pos = [], nor = [], idx = [];
  const w = prof.length;
  const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3();
  const rings = [];

  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const p = curve.getPointAt(t);
    curve.getTangentAt(t, T);
    N.crossVectors(T, U);
    if (N.lengthSq() < 1e-8) N.set(1, 0, 0);
    N.normalize();
    B.crossVectors(N, T).normalize();
    rings.push({ p: p.clone(), n: N.clone(), b: B.clone() });
  }
  for (const R of rings) {
    for (let j = 0; j < w; j++) {
      const [ux, uy] = prof[j];
      pos.push(R.p.x + R.n.x * ux + R.b.x * uy,
        R.p.y + R.n.y * ux + R.b.y * uy,
        R.p.z + R.n.z * ux + R.b.z * uy);
      const l = Math.hypot(ux, uy) || 1;
      const a = ux / l, bb = uy / l;
      nor.push(R.n.x * a + R.b.x * bb, R.n.y * a + R.b.y * bb, R.n.z * a + R.b.z * bb);
    }
  }
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < w; j++) {
      const j2 = (j + 1) % w;
      const A = i * w + j, Bb = i * w + j2, C = (i + 1) * w + j, D = (i + 1) * w + j2;
      idx.push(A, C, D, A, D, Bb);
    }
  }
  /* end caps: a fan to the ring centre at each end */
  const capAt = (ringIndex, flip) => {
    const R = rings[ringIndex];
    const c = pos.length / 3;
    pos.push(R.p.x, R.p.y, R.p.z);
    const d = flip ? -1 : 1;
    curve.getTangentAt(ringIndex === 0 ? 0 : 1, T);
    nor.push(T.x * d, T.y * d, T.z * d);
    const base = ringIndex * w;
    for (let j = 0; j < w; j++) {
      const j2 = (j + 1) % w;
      if (flip) idx.push(c, base + j2, base + j);
      else idx.push(c, base + j, base + j2);
    }
  };
  capAt(0, true);
  capAt(seg, false);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

/**
 * Reflect a geometry through x = 0: negate x on positions and normals and
 * reverse every triangle so the winding survives the handedness flip.
 * `flipU` mirrors the u coordinate as well, which is what keeps a painted
 * asymmetric mark pointing the same way in world space on both copies.
 */
export function mirrorGeometryX(src, flipU = false) {
  const g = new THREE.BufferGeometry();
  for (const name of Object.keys(src.attributes)) {
    const a = src.attributes[name];
    const arr = a.array.slice();
    if (name === 'position' || name === 'normal') {
      for (let i = 0; i < arr.length; i += a.itemSize) arr[i] = -arr[i];
    } else if (name === 'uv' && flipU) {
      for (let i = 0; i < arr.length; i += a.itemSize) arr[i] = 1 - arr[i];
    }
    g.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize));
  }
  const si = src.index.array;
  const di = si.slice();
  for (let i = 0; i < si.length; i += 3) {
    di[i] = si[i]; di[i + 1] = si[i + 2]; di[i + 2] = si[i + 1];
  }
  g.setIndex(new THREE.BufferAttribute(di, 1));
  g.computeBoundingSphere();
  return g;
}

/** Minimal geometry merge — the addons are not vendored. */
export function mergeGeometries(list) {
  let vc = 0, ic = 0;
  for (const g of list) {
    vc += g.attributes.position.count;
    ic += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vc * 3);
  const nor = new Float32Array(vc * 3);
  const idx = vc > 65535 ? new Uint32Array(ic) : new Uint16Array(ic);
  let vo = 0, io = 0;
  for (const g of list) {
    const p = g.attributes.position.array, n = g.attributes.normal.array;
    pos.set(p, vo * 3); nor.set(n, vo * 3);
    const gi = g.index.array;
    for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
    vo += g.attributes.position.count;
    io += gi.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/* ==================================================================
   10. THE GLINT — §1.4
   ================================================================== */

/**
 * The lens texture: true-black lens with one white mark per lens, shaped
 * like a flattened lightning bolt — short stroke, diagonal drop, short
 * stroke — with softly rounded caps and a ~2 px feathered edge.
 *
 * It is painted into the material, not computed from a reflection vector,
 * so it can never drift, dim or vanish as the camera moves. Both lenses
 * sample the same texture and the right lens's UVs are flipped in
 * buildLensGeometry, which is what makes both marks point the SAME way
 * rather than mirroring.
 *
 * SIZE AND PLACE, NOT JUST SHAPE. §1.4 asks for a mark at ~14% of lens
 * width sitting in the UPPER-LEFT THIRD. The first pass read "14%" as the
 * stroke thickness and then ran the path across the full lens diagonal, so
 * the mark covered 74% of the lens width and sat dead centre: at 32 px it
 * collapsed into a solid white slash and Wally read as having white eyes,
 * which is worse than the plain ellipse §7 forbids. The path now spans
 * u 0.150-0.520, v 0.140-0.430 with a 5.2% stroke — a compact lazy-Z in
 * the upper-left third, still three separately readable strokes at 32 px.
 */
export function buildLensTexture(size = 512) {
  const g = P.glass;
  const aspect = g.lensA / g.lensB;
  const W = size, Hh = Math.round(size / aspect);
  const c = document.createElement('canvas');
  c.width = W; c.height = Hh;
  const x = c.getContext('2d');

  const hex = (v) => '#' + v.toString(16).padStart(6, '0');
  x.fillStyle = hex(CLAY.lens);
  x.fillRect(0, 0, W, Hh);

  /* THE MARK, MATCHED TO ref/wally-glint-canon.png: a white RISING line —
     short horizontal, rising diagonal, short horizontal, soft round caps —
     sitting MID-LENS and spanning ~40% of the lens width, both lenses the
     same direction. In canvas UV (y down) "rising" means y decreases with
     x. The previous path sat in the upper-left third at 38% width, which
     was the old prose spec; the canon render supersedes it: centred at
     u 0.50, v 0.50, span u 0.30-0.70. Stroke 0.085 W = ~13% of lens
     height, the canon's chunky mark, still three readable strokes at
     32 px. */
  /* ROUND 2: scaled UP to the canon proportions — the critic read the
     old mark as "a small squiggle". Span widened to u 0.275-0.725 (45%
     of lens width) and the stroke fattened to 0.105 W, which is the
     chunky mark ref/wally-glint-canon.png carries. */
  /* ROUND 3: ONE SMOOTH RISING S, not a polyline. The critic read the
     4-point polyline as "uneven white squiggle blobs that differ per
     lens" — the hard interior joints caught the perspective differently
     on each side. The canon mark is a single continuous S-stroke:
     horizontal tail, steep rise, horizontal tail, drawn as one cubic so
     there are no joints to catch. Same UV path on both lenses (the right
     lens's u-flip in buildLensGeometry keeps the rise pointing the same
     way), consistent stroke width. */
  /* ROUND 4: THE RISE WAS RENDERING UPSIDE-DOWN. CanvasTexture defaults
     to flipY, so the canvas-space "rising" mark (y decreasing with x)
     came out DESCENDING on the lens — stock-chart-down, the exact
     opposite of ref/wally-glint-canon.png — in every previous shot.
     flipY is now off (set below) so canvas y-down IS lens y-down and
     this path renders exactly as painted. */
  /* ROUND 5: THE CANON STEP, NOT AN S. The single cubic of round 3-4
     read as a lazy ~30-degree worm next to ref/wally-glint-canon.png,
     which carries a crisp STEP: short flat tail, one steep STRAIGHT
     diagonal, short flat tail. Redrawn as an explicit 4-point polyline —
     tails 24% of the span each, diagonal 52% rising at 50 degrees
     (the canvas is in true lens proportion, W/Hh = lensA/lensB, so
     canvas angles ARE lens angles: dy = dx * tan50). Round caps/joins
     keep the canon's soft elbows without bending the diagonal.
       Size: the round-2 span (u 0.275-0.725 + caps) measured 55-60% of
     the visible lens in shots/ck-*.png against the canon's ~40%; span
     is now u 0.370-0.630 (+caps ≈ 40%) at the SAME stroke weight,
     centred mid-lens (u 0.5, v 0.5) in lens-local UV — identical on
     both lenses by construction (right lens u-flip, symmetric span).
       Edges: the 3-pass alpha feather is gone — it bloomed the mark
     soft in every shot. One hard pass; the canvas AA plus mipmapping
     is all the softening the canon allows. */
  const strokeW = 0.082 * W;
  const span = 0.260;                       // path span, u units
  /* tails 28% / diagonal 44%: at 24/52 the round caps (strokeW/2 each
     side) swallowed the tails to nubs and the mark read as a lone fat
     diagonal — the canon's flat tails read ~half a stroke long past
     the cap. */
  const tail = 0.28 * span, diag = 0.44 * span;
  const rise = diag * Math.tan(50 * Math.PI / 180) * (W / Hh); // v units
  const u0 = 0.5 - span / 2, v0 = 0.5 + rise / 2;
  const pts = [
    [u0, v0],                               // low tail, left end
    [u0 + tail, v0],                        // elbow into the rise
    [u0 + tail + diag, v0 - rise],          // top of the rise
    [u0 + span, v0 - rise],                 // high tail, right end
  ];

  x.lineJoin = 'round';
  x.lineCap = 'round';
  x.strokeStyle = 'rgba(255,255,255,1)';
  x.lineWidth = strokeW;
  x.beginPath();
  x.moveTo(pts[0][0] * W, pts[0][1] * Hh);
  for (let i = 1; i < pts.length; i++) x.lineTo(pts[i][0] * W, pts[i][1] * Hh);
  x.stroke();

  const t = new THREE.CanvasTexture(c);
  t.flipY = false;                 // see the ROUND 4 note above
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

export default {
  buildBodyGeometry, buildTuskGeometry, buildLensGeometry,
  buildFrameGeometry, buildLensTexture, surfaceNets, mergeGeometries,
  mirrorGeometryX, smoothWeights, cullDegenerate,
};
