/* ============================================================
   humans.js — the parametric human.

   Everyone in Bull Bear City except Wally is a human, and every human
   is generated from the same twelve numbers the original 2D game used
   for its portraits (see the `art.js` section of ref/original-wally.html
   and the CLIENTS table in src/game/data.js):

       skin  face  hair  hairCol  beard  specs  hat  hue  age  mood

   THE ONE RULE THIS FILE EXISTS TO OBEY
   -------------------------------------
   They must look like they came out of the same kiln as Wally. That is
   not a style note, it is the acceptance criterion: ART_DIRECTION §1.2
   is a *material* law and §5 says every world material derives from one
   of five, of which characters get exactly one — clay. So:

     * one shared ctx.mat.clay() material for every human in the game,
       the same factory Wally's skin comes from, with the same velvet
       grain, the same warm-grey shade tint and no outline;
     * every surface is a smooth-min field polygonised with surface
       nets and normalled from the analytic gradient, so nothing is a
       nameable primitive and nothing facets (§7);
     * ambient occlusion is baked from the field into vColor.a, which
       toon.js multiplies by a warm grey — the same path Wally's AO
       takes, which is why a human standing next to him reads as the
       same material and not as a different renderer's idea of clay;
     * proportions are toy proportions: 4.5 heads tall, chunky limbs,
       no neck to speak of, hands that are mittens with a thumb.

   WHY THE COLOUR IS NOT IN THE GEOMETRY
   -------------------------------------
   Twenty-four named clients plus a wandering crowd is fifty-odd
   characters, and building a body mesh each would cost seconds at boot
   and megabytes on the GPU. So the *shape* caches are shared and only
   the colour is per-character:

     - one body field, meshed once, its position/normal/skin attributes
       shared by reference between every SkinnedMesh in the game;
     - head shells cached per face shape (6), hair per style (17),
       beards, glasses and hats cached per type;
     - each cached geometry carries a per-vertex PART id and its bind-pose
       y, and a character resolves those to actual colours at spawn.
       That is what lets sleeve length, hem height, boot height and the
       whole palette vary per person over shared vertices.

   Cost: 2 draw calls per human (body, head+hair+hat merged), ~6k tris
   body + ~5k head, one material for the entire population.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { CLAY } from '../core/palette.js';
import { clamp, lerp } from '../core/contracts.js';

/* ==================================================================
   0. The human palette.

   palette.js is the canonical colour set and it is owned by another
   module, so the eight skin tones and thirteen hair colours the design
   calls for live here instead, transcribed verbatim from the original
   game's SKINS / HAIRCOLS tables. They belong in palette.js and should
   be folded in there; until then this block is the single place any
   human colour is written down. Nothing below inlines a hex.
   ================================================================== */

export const HUMAN = {
  /* b = base, s = shade, d = deep crease, l = lit. The clay shader does
     the shading; we only need `b` for albedo and `d` for the sculpted
     details (nostril, lip line, eye socket) that want a darker plate. */
  skin: {
    porcelain: { b: 0xf0d2bc, s: 0xd4a98e, d: 0xb0836a, l: 0xfbe6d6 },
    fair:      { b: 0xe8c1a2, s: 0xc89876, d: 0xa2745a, l: 0xf6dcc6 },
    warm:      { b: 0xdca982, s: 0xb98462, d: 0x94634a, l: 0xefc9a8 },
    olive:     { b: 0xc79468, s: 0xa0714c, d: 0x7c543a, l: 0xdfb68c },
    tan:       { b: 0xb07a50, s: 0x8c5b3a, d: 0x6b432b, l: 0xcc9a6e },
    bronze:    { b: 0x95603c, s: 0x74472b, d: 0x573320, l: 0xb37e56 },
    deep:      { b: 0x6e4530, s: 0x523021, d: 0x3c2117, l: 0x8c5f44 },
    ebony:     { b: 0x4e3020, s: 0x3a2116, d: 0x2a170f, l: 0x6b4530 },
  },

  /* THE DARKEST HAIR IS NOT BLACK. 0x231c1e is 1.5 % linear luminance;
     multiply it by a 0.30 AO floor and a 0.50 shadow and a beard lands
     on #010101, which §7 forbids outright and which is exactly what the
     review measured on Rico's jaw. 0x2f2529 is still unmistakably black
     hair and survives all three multiplications with a hue. */
  hair: {
    black: 0x2f2529, darkbrown: 0x3d2a22, brown: 0x5e3d28, chestnut: 0x7a4a2a,
    auburn: 0x8e3f26, ginger: 0xb25a28, blonde: 0xc69a55, platinum: 0xdcc9a4,
    grey: 0x9a9490, silver: 0xc6c2be, white: 0xe4e0da, teal: 0x3e6e72,
    plum: 0x5e3554,
  },

  /* Head silhouettes — the six FACES of the original, re-proportioned
     for a 4.5-heads-tall toy. rx/ry/rz are the cranium half-axes in
     metres, `jaw` narrows the mandible and `chin` is how far the chin
     ball drops below it.

     THE NUMBER YOU CHECK IS HEADS-PER-FIGURE, MEASURED ON THE RENDER.
     The first pass mapped the original's 52 px ellipse straight into
     metres, which gave a 0.311 m head on a 1.68 m body: 5.4 heads, i.e.
     an ordinary slim adult standing next to a 2.9-head vinyl elephant.
     A lineup of them read as low-poly extras from a different game, and
     that mismatch is the one defect the brief calls fatal.

     Head height is ry * 1.62 + chin + 0.006 (cranium, mandible drop,
     chin ball), so 4.5 heads on 1.68 m — 0.373 m — fixes ry at 0.194
     for the round face and everything else scales from it. Width does
     NOT follow: 0.30 m across gives a head/shoulder ratio of 0.68, big
     and toy-like, while Wally's 0.556 m ball still reads 1.85x wider
     than any human's, which is his whole silhouette. */
  face: {
    round:  { rx: 0.1500, ry: 0.1940, rz: 0.1455, jaw: 1.00, chin: 0.052 },
    oval:   { rx: 0.1385, ry: 0.2070, rz: 0.1390, jaw: 0.86, chin: 0.062 },
    square: { rx: 0.1550, ry: 0.1910, rz: 0.1455, jaw: 1.10, chin: 0.044 },
    heart:  { rx: 0.1520, ry: 0.1960, rz: 0.1440, jaw: 0.72, chin: 0.064 },
    long:   { rx: 0.1320, ry: 0.2160, rz: 0.1365, jaw: 0.82, chin: 0.066 },
    broad:  { rx: 0.1620, ry: 0.1845, rz: 0.1500, jaw: 1.06, chin: 0.046 },
  },

  /* THE SCLERA IS NOT WHITE. §1.2's lit clay tops out at #DEDEDD and its
     crease sits at #A9A9A8, so a #F4ECE2 eyeball is the brightest thing
     on the whole figure — brighter than a lit cheek by fifteen points —
     and a bright patch on a matte object reads as paint, not as an eye.
     Wally solves the same problem by having no eyes at all. A human
     needs them, so they are pitched at clay's own mid-tone and the iris
     carries the contrast instead. */
  eye: 0x2e2119,
  eyeWhite: 0xdfd5c8,

  /* headwear, colours as the original drew them */
  hat: {
    cap:    { a: 0x3e6e9b, b: 0x2e5378 },
    flat:   { a: 0x6a6252, b: 0x57503f },
    beanie: { a: 0x7a4a7e, b: 0x5e3862 },
    chef:   { a: 0xf6f3ec, b: 0xeae5da },
    helm:   { a: 0xe0a62e, b: 0xc88c1e },
    visor:  { a: 0x2e7a62, b: 0x256653 },
    beret:  { a: 0x9b4438, b: 0x7e3529 },
    fedora: { a: 0x4a423a, b: 0x2e2a26 },
    bucket: { a: 0x6e8a5e, b: 0x5e7a4e },
    top:    { a: 0x2a2a30, b: 0x7a4a38 },
    crown:  { a: 0xe4b33c, b: 0xc99a28 },
  },

  /* spectacle frames — satin near-black, the same value as Wally's
     frame so the two characters' hardest edge matches (§1.4) */
  specFrame: CLAY.frame,
  specLens: 0xcfe0e8,

  /* trouser / skirt neutrals a shirt hue gets paired with. Never the
     shirt hue itself: a character in one colour head to toe reads as a
     mannequin, and the original always split the palette. */
  neutral: [0x3b4356, 0x4e4238, 0x2f3a3f, 0x5a4a3c, 0x36404a, 0x453b46, 0x5e5a4e],
  /* SHOES MAY NOT BE BLACK. §7 forbids pure black anywhere in frame, and
     a shoe is the one surface that is simultaneously the darkest albedo
     on the figure, the deepest in its own AO and the most likely to be
     inside a cast shadow — 0x241f1e measured out at #000014 on the
     ground in the review shot, which is a hole in the picture. The
     darkest boot here is 0x453a34, which lands at #0d1420 under the
     same three multiplications: still reads as black leather, still has
     a hue. */
  /* And they may not be near-black either. A shoe is the one surface
     that is simultaneously the lowest albedo on the figure, the deepest
     in its own AO and the most likely to be in a cast shadow, so it is
     the first thing to collapse into an unreadable clod at the bottom of
     the frame — which is what stopped the feet reading as the soft
     rounded stubs they are actually modelled as. Lifted about 25 %:
     still unmistakably boot leather, still darker than any trouser, and
     now with enough range left for the terminator to cross the toe. */
  shoe: [0x63513f, 0x5a4b42, 0x715943, 0x515a68, 0x7d6851],
};

/* ------------------------------------------------------------------
   Colour helpers. All work in gamma space and hand back linear THREE
   colours, because vertex colours are consumed in the working space.
   ------------------------------------------------------------------ */
const _c = new THREE.Color();
const _mix = new THREE.Color();
export const srgb = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

/** hex | '#rrggbb' -> integer */
export function hexOf(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseInt(v.replace('#', ''), 16) || 0;
  return 0;
}
/** Lighten (+) or darken (-) in gamma space, k in -1..1. */
export function shade(hex, k) {
  _c.setHex(hexOf(hex), THREE.SRGBColorSpace);
  const g = [_c.r, _c.g, _c.b].map((v) => Math.pow(Math.max(v, 0), 1 / 2.2));
  const t = k >= 0 ? k : -k;
  for (let i = 0; i < 3; i++) g[i] = k >= 0 ? lerp(g[i], 1, t) : g[i] * (1 - t);
  return new THREE.Color(...g.map((v) => Math.pow(v, 2.2)));
}
export function mixCol(a, b, t) {
  const A = a.isColor ? a : srgb(hexOf(a));
  const B = b.isColor ? b : srgb(hexOf(b));
  return A.clone().lerp(B, t);
}
/**
 * §7 forbids pure black in frame, and a character albedo is multiplied
 * three more times before it reaches the screen — by its own baked AO
 * (floor 0.30), by the shade band, and by whatever cast shadow it is
 * standing in. Black hair at 1.5 % linear luminance therefore measures
 * out at #010101 on a beard, which the review flagged. Anything darker
 * than the floor is lifted toward a warm near-black that survives all
 * three multiplications with a hue still in it.
 */
const _floor = srgb(0x463c42);
export function noBlack(col, min = 0.028) {
  const l = 0.2126 * col.r + 0.7152 * col.g + 0.0722 * col.b;
  if (l >= min) return col;
  return col.clone().lerp(_floor, clamp(1 - l / min, 0, 1) * 0.62);
}

/* ==================================================================
   1. Signed distance field
   ================================================================== */

/* A primitive is { d(x,y,z), bx,by,bz,br } — a closure plus a bounding
   sphere. The bound is what makes the mesher affordable: a blob whose
   bound cannot lower the running minimum is skipped outright, and on a
   figure made of two arms, two legs and a head that is most of them. */
const prim = (d, bx, by, bz, br) => ({ d, bx, by, bz, br });

/** Axis-aligned ellipsoid, gradient-corrected distance (exact at the
    surface, asymptotically correct away from it — the naive
    (|p/r|-1)*min(r) form underestimates by the axis ratio and that
    breaks both the bound cull and the smooth-min). */
export function esph(c, r) {
  const cx = c[0], cy = c[1], cz = c[2];
  const rx = r[0], ry = r[1], rz = r[2];
  const irx = 1 / rx, iry = 1 / ry, irz = 1 / rz;
  const rmin = Math.min(rx, ry, rz);
  return prim((x, y, z) => {
    const ux = (x - cx) * irx, uy = (y - cy) * iry, uz = (z - cz) * irz;
    const k0 = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (k0 < 1e-7) return -rmin;
    const vx = ux * irx, vy = uy * iry, vz = uz * irz;
    const k1 = Math.sqrt(vx * vx + vy * vy + vz * vz);
    return k0 * (k0 - 1) / k1;
  }, cx, cy, cz, Math.max(rx, ry, rz));
}

/** Ellipsoid with an orientation: `n` becomes the local +Z (the thin
    axis of a flattened plate — ears, hair curtains, hat brims). */
export function esphN(c, r, n, upHint) {
  const m = basis(n, upHint);
  const cx = c[0], cy = c[1], cz = c[2];
  const rx = r[0], ry = r[1], rz = r[2];
  const irx = 1 / rx, iry = 1 / ry, irz = 1 / rz;
  const rmin = Math.min(rx, ry, rz);
  return prim((x, y, z) => {
    const dx = x - cx, dy = y - cy, dz = z - cz;
    const lx = m[0] * dx + m[1] * dy + m[2] * dz;
    const ly = m[3] * dx + m[4] * dy + m[5] * dz;
    const lz = m[6] * dx + m[7] * dy + m[8] * dz;
    const ux = lx * irx, uy = ly * iry, uz = lz * irz;
    const k0 = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (k0 < 1e-7) return -rmin;
    const vx = ux * irx, vy = uy * iry, vz = uz * irz;
    const k1 = Math.sqrt(vx * vx + vy * vy + vz * vz);
    return k0 * (k0 - 1) / k1;
  }, cx, cy, cz, Math.max(rx, ry, rz));
}

function basis(n, upHint) {
  const nz = norm3(n);
  let up = upHint ? norm3(upHint) : [0, 1, 0];
  if (Math.abs(up[0] * nz[0] + up[1] * nz[1] + up[2] * nz[2]) > 0.985) up = [1, 0, 0];
  const nx = norm3(cross3(up, nz));
  const ny = cross3(nz, nx);
  return [nx[0], nx[1], nx[2], ny[0], ny[1], ny[2], nz[0], nz[1], nz[2]];
}
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function norm3(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

/**
 * Exact round cone — the convex hull of two spheres (Inigo Quilez).
 * NOT `segmentDistance - lerp(ra, rb)`: that is a capsule with a
 * painted radius, and it bulges to the full endpoint radius in a
 * hemisphere around each end, which puts a shelf on every taper.
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

/**
 * A limb: round cone from a to b. `kx`/`kz` scale the whole space
 * about the origin, which turns a circular tube into an elliptical
 * one — the torso is deeper than it is wide nowhere and narrower
 * front-to-back everywhere, which is what stops a stack of round cones
 * reading as a drainpipe.
 */
export function tube(a, b, ra, rb, kx = 1, kz = 1) {
  const ikx = 1 / kx, ikz = 1 / kz;
  const ax = a[0] * ikx, ay = a[1], az = a[2] * ikz;
  const bx = b[0] * ikx, by = b[1], bz = b[2] * ikz;
  const m = Math.min(kx, kz, 1);
  const cx = (a[0] + b[0]) * 0.5, cy = (a[1] + b[1]) * 0.5, cz = (a[2] + b[2]) * 0.5;
  const half = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 0.5;
  const rmax = Math.max(ra, rb) * Math.max(kx, kz, 1);
  return prim((x, y, z) => roundCone(x * ikx, y, z * ikz, ax, ay, az, bx, by, bz, ra, rb) * m,
    cx, cy, cz, half + rmax);
}

/** Rounded box — feet, hat crowns, brims. */
export function rbox(c, h, r) {
  const cx = c[0], cy = c[1], cz = c[2];
  const hx = h[0], hy = h[1], hz = h[2];
  return prim((x, y, z) => {
    const qx = Math.abs(x - cx) - hx, qy = Math.abs(y - cy) - hy, qz = Math.abs(z - cz) - hz;
    const mx = qx > 0 ? qx : 0, my = qy > 0 ? qy : 0, mz = qz > 0 ? qz : 0;
    return Math.sqrt(mx * mx + my * my + mz * mz)
      + Math.min(Math.max(qx, Math.max(qy, qz)), 0) - r;
  }, cx, cy, cz, Math.hypot(hx, hy, hz) + r);
}

/** Torus about `axis` — spectacle rims, hat bands, the crown circlet. */
export function ring(c, axis, R, t) {
  const m = basis(axis, [0, 1, 0]);
  const cx = c[0], cy = c[1], cz = c[2];
  return prim((x, y, z) => {
    const dx = x - cx, dy = y - cy, dz = z - cz;
    const lx = m[0] * dx + m[1] * dy + m[2] * dz;
    const ly = m[3] * dx + m[4] * dy + m[5] * dz;
    const lz = m[6] * dx + m[7] * dy + m[8] * dz;
    const rr = Math.sqrt(lx * lx + ly * ly) - R;
    return Math.sqrt(rr * rr + lz * lz) - t;
  }, cx, cy, cz, R + t);
}

/** Polynomial smooth minimum — C1, cheap, never spikes. */
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
 * A named group of primitives, smooth-unioned at `k` internally and
 * merged into the running field at `join`. `part` is the id the tint
 * pass reads back; `bone` is the skinning hint.
 *
 * A chain of round cones that share endpoints wants k ~ 0.004: they are
 * already tangent-continuous across the shared sphere, and smin
 * subtracts k/4 wherever the two agree, so a generous k grows a ring of
 * bulge at every station instead of a fillet.
 */
export const blob = (part, prims, k = 0.004, join = 0.03, bone = null) =>
  ({ part, prims, k, join, bone });

/** Build a field object from blobs, plus optional carve/dish shapes and
 *  optional `keeps` — regions the result is INTERSECTED with.
 *
 *  A keep is what lets a beard be the head's own offset surface clipped
 *  to a jaw, rather than a stack of ellipsoids trying to approximate the
 *  head and getting it wrong by a few millimetres in every direction.
 *  Each keep is { prims, k, join }; its prims union, and the union is
 *  smooth-max'd into the field. */
export function makeField(blobs, carves = [], keeps = []) {
  for (const b of blobs) {
    let cx = 0, cy = 0, cz = 0;
    for (const p of b.prims) { cx += p.bx; cy += p.by; cz += p.bz; }
    const n = b.prims.length || 1;
    cx /= n; cy /= n; cz /= n;
    let r = 0;
    for (const p of b.prims) {
      const e = Math.hypot(p.bx - cx, p.by - cy, p.bz - cz) + p.br;
      if (e > r) r = e;
    }
    b.bx = cx; b.by = cy; b.bz = cz; b.br = r + b.k * 0.5 + b.join * 0.5;
  }
  const nB = blobs.length;
  const nC = carves.length;
  /* A CARVE THAT CANNOT REACH THE POINT DOES NOT NEED EVALUATING.
     This field is called about 280 000 times to mesh one head and it
     used to evaluate every carve — eye sockets, mouth slit, nostrils,
     the mento-labial shelf, a dozen of them — at every one of those
     points, including points a whole head away from the mouth. Each
     carve is a bounded primitive: `smax(acc, -p, k)` can only differ
     from `acc` when `p < k - acc`, and `p >= dist - br` because the
     primitive is inside its own bounding sphere. So the test below is
     exact under the same bound the blob loop above has always used,
     and it is the single largest saving in the mesher. */
  const cPad = 0.02;

  function d(x, y, z) {
    let acc = 1e9;
    for (let i = 0; i < nB; i++) {
      const b = blobs[i];
      const dx = x - b.bx, dy = y - b.by, dz = z - b.bz;
      /* the same cull as before, without the square root: skip when
         dist - br > acc + join + 0.02 */
      const lim = acc + b.join + cPad + b.br;
      if (lim > 0 && dx * dx + dy * dy + dz * dz > lim * lim) continue;
      const ps = b.prims;
      let v = ps[0].d(x, y, z);
      for (let j = 1; j < ps.length; j++) v = smin(v, ps[j].d(x, y, z), b.k);
      acc = acc === 1e9 ? v : smin(acc, v, b.join);
    }
    if (acc === 1e9) acc = 1;
    for (let i = 0; i < nC; i++) {
      const c = carves[i], p = c.p;
      const lim = c.k + cPad - acc + p.br;
      if (lim <= 0) continue;
      const dx = x - p.bx, dy = y - p.by, dz = z - p.bz;
      if (dx * dx + dy * dy + dz * dz > lim * lim) continue;
      acc = smax(acc, -p.d(x, y, z), c.k);
    }
    for (let i = 0; i < keeps.length; i++) {
      const kp = keeps[i], ps = kp.prims;
      let v = ps[0].d(x, y, z);
      for (let j = 1; j < ps.length; j++) v = smin(v, ps[j].d(x, y, z), kp.k ?? 0.010);
      acc = smax(acc, v, kp.join ?? 0.012);
    }
    return acc;
  }

  /** Which blob owns a point — the tint / weight lookup. */
  function partAt(x, y, z) {
    let best = 1e9, part = blobs[0] ? blobs[0].part : 0, bone = null;
    for (let i = 0; i < nB; i++) {
      const b = blobs[i];
      const dx = x - b.bx, dy = y - b.by, dz = z - b.bz;
      const lim = best + b.br;
      if (lim > 0 && dx * dx + dy * dy + dz * dz > lim * lim) continue;
      let v = b.prims[0].d(x, y, z);
      for (let j = 1; j < b.prims.length; j++) v = smin(v, b.prims[j].d(x, y, z), b.k);
      if (v < best) { best = v; part = b.part; bone = b.bone; }
    }
    return { part, bone };
  }

  /* Grid bounds, derived. Never author these: a literal bound that
     falls behind a sculpt edit clips the mesh open and the hole is
     invisible in code and unmistakable on screen. */
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const b of blobs) {
    const pad = b.k * 0.25 + b.join * 0.25;
    for (const p of b.prims) {
      const e = p.br + pad;
      lo[0] = Math.min(lo[0], p.bx - e); hi[0] = Math.max(hi[0], p.bx + e);
      lo[1] = Math.min(lo[1], p.by - e); hi[1] = Math.max(hi[1], p.by + e);
      lo[2] = Math.min(lo[2], p.bz - e); hi[2] = Math.max(hi[2], p.bz + e);
    }
  }
  /* A keep can only ever shrink the result, so its own box clips the
     grid — without this a beard clipped out of an offset skull would
     make the mesher walk a whole head-sized volume to find a jaw. */
  for (const kp of keeps) {
    const klo = [1e9, 1e9, 1e9], khi = [-1e9, -1e9, -1e9];
    for (const p of kp.prims) {
      const e = p.br + (kp.join ?? 0.012);
      klo[0] = Math.min(klo[0], p.bx - e); khi[0] = Math.max(khi[0], p.bx + e);
      klo[1] = Math.min(klo[1], p.by - e); khi[1] = Math.max(khi[1], p.by + e);
      klo[2] = Math.min(klo[2], p.bz - e); khi[2] = Math.max(khi[2], p.bz + e);
    }
    for (let i = 0; i < 3; i++) { lo[i] = Math.max(lo[i], klo[i]); hi[i] = Math.min(hi[i], khi[i]); }
  }
  const m = 0.022;
  return {
    d, partAt,
    bounds: { min: [lo[0] - m, lo[1] - m, lo[2] - m], max: [hi[0] + m, hi[1] + m, hi[2] + m] },
  };
}

/* ==================================================================
   2. Surface nets

   One vertex per surface cell, quads across every sign-changing axis
   edge, one Newton relaxation onto the true iso-surface, analytic
   gradient normals, then two Laplacian normal passes. A coarse stride-4
   pass finds the blocks the surface can cross so the full-resolution
   field is only evaluated where it matters — 4 to 8x on a figure that
   is mostly air.
   ================================================================== */

const CUBE = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

export function surfaceNets(field, bounds, cell, opts = {}) {
  const ox = bounds.min[0], oy = bounds.min[1], oz = bounds.min[2];
  const nx = Math.ceil((bounds.max[0] - ox) / cell) + 1;
  const ny = Math.ceil((bounds.max[1] - oy) / cell) + 1;
  const nz = Math.ceil((bounds.max[2] - oz) / cell) + 1;
  const G = new Float32Array(nx * ny * nz).fill(1);
  /* NEIGHBOURING BLOCKS SHARE A FACE, AND THAT FACE USED TO BE SAMPLED
     TWICE. The block loop below walks [k*S, (k+1)*S] inclusive, so every
     boundary plane belongs to two blocks: 125 samples per block of which
     only 64 are its own. Measured on a head, that was 128 000 field
     evaluations where 70 000 would do — nearly a quarter of the whole
     mesher. One byte per grid point buys all of it back, exactly: the
     values written are identical, only the duplicate work is gone. */
  const done = new Uint8Array(nx * ny * nz);
  const gi = (i, j, k) => (k * ny + j) * nx + i;

  /* coarse block pass */
  /* Block stride for the coarse skip pass. 2, not 4: the reject band
     scales with S but carries a fixed 10 mm of slack, so a smaller
     block wastes proportionally less of the grid on shell it does not
     need. Measured over a head, a body and a hair shell, S=2 costs 6-7 %
     fewer field evaluations than S=4 and — verified by hashing position,
     normal and index — produces a bit-identical mesh: a block can only
     be skipped when every corner is further from the surface than the
     block's own half-diagonal, so no cell that carries a sign change
     ever touches a skipped corner. */
  const S = opts.blockStride ?? 2;
  const bx = Math.ceil((nx - 1) / S), by = Math.ceil((ny - 1) / S), bz = Math.ceil((nz - 1) / S);
  const C = new Float32Array((bx + 1) * (by + 1) * (bz + 1));
  const ci = (i, j, k) => (k * (by + 1) + j) * (bx + 1) + i;
  for (let k = 0; k <= bz; k++) {
    const z = oz + Math.min(k * S, nz - 1) * cell;
    for (let j = 0; j <= by; j++) {
      const y = oy + Math.min(j * S, ny - 1) * cell;
      for (let i = 0; i <= bx; i++) C[ci(i, j, k)] = field(ox + Math.min(i * S, nx - 1) * cell, y, z);
    }
  }
  const band = S * cell * 0.8661 * 1.2 + 0.010;
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
                for (let ii = i * S; ii <= Math.min((i + 1) * S, nx - 1); ii++) G[gi(ii, jj, kk)] = -1;
          }
          continue;
        }
        for (let kk = k * S; kk <= Math.min((k + 1) * S, nz - 1); kk++) {
          const z = oz + kk * cell;
          for (let jj = j * S; jj <= Math.min((j + 1) * S, ny - 1); jj++) {
            const y = oy + jj * cell;
            const row = (kk * ny + jj) * nx;
            for (let ii = i * S; ii <= Math.min((i + 1) * S, nx - 1); ii++) {
              const g = row + ii;
              if (done[g]) continue;
              done[g] = 1;
              G[g] = field(ox + ii * cell, y, z);
            }
          }
        }
      }
    }
  }

  /* one vertex per surface cell */
  const cx = nx - 1, cy = ny - 1, cz2 = nz - 1;
  const vidx = new Int32Array(cx * cy * cz2).fill(-1);
  const pts = [];
  const v = new Float64Array(8);
  for (let k = 0; k < cz2; k++) {
    for (let j = 0; j < cy; j++) {
      for (let i = 0; i < cx; i++) {
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
        vidx[(k * cy + j) * cx + i] = pts.length / 3;
        pts.push(ox + (i + sx / n) * cell, oy + (j + sy / n) * cell, oz + (k + sz / n) * cell);
      }
    }
  }

  /* quads, wound so the face normal points out of the surface */
  const indices = [];
  const cidx = (i, j, k) => vidx[(k * cy + j) * cx + i];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) indices.push(a, c, b, a, d, c);
    else indices.push(a, b, c, a, c, d);
  };
  for (let k = 0; k < cz2; k++) {
    for (let j = 0; j < cy; j++) {
      for (let i = 0; i < cx; i++) {
        const inside = G[gi(i, j, k)] < 0;
        if (j > 0 && k > 0 && inside !== (G[gi(i + 1, j, k)] < 0))
          quad(cidx(i, j, k), cidx(i, j - 1, k), cidx(i, j - 1, k - 1), cidx(i, j, k - 1), !inside);
        if (i > 0 && k > 0 && inside !== (G[gi(i, j + 1, k)] < 0))
          quad(cidx(i, j, k), cidx(i, j, k - 1), cidx(i - 1, j, k - 1), cidx(i - 1, j, k), !inside);
        if (i > 0 && j > 0 && inside !== (G[gi(i, j, k + 1)] < 0))
          quad(cidx(i, j, k), cidx(i - 1, j, k), cidx(i - 1, j - 1, k), cidx(i, j - 1, k), !inside);
      }
    }
  }

  const nv = pts.length / 3;
  const pos = new Float32Array(pts);
  const nor = new Float32Array(nv * 3);
  const eps = cell * 0.35, lim = cell * 0.5;

  for (let i = 0; i < nv; i++) {
    let x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const d0 = field(x, y, z);
    const gx = field(x + eps, y, z) - field(x - eps, y, z);
    const gy = field(x, y + eps, z) - field(x, y - eps, z);
    const gz = field(x, y, z + eps) - field(x, y, z - eps);
    const gl = Math.sqrt(gx * gx + gy * gy + gz * gz) / (2 * eps);
    /* Step along the UNIT gradient by the field value. The Newton step
       d/|grad|^2 blows up in the floor of a smooth-min valley, where
       |grad| collapses — adjacent vertices slam into opposite clamps
       and the surface corrugates at exactly the grid pitch. */
    if (gl > 0.35) {
      const inv = 1 / (gl * 2 * eps);
      let step = d0 / gl;
      if (step > lim) step = lim; else if (step < -lim) step = -lim;
      x -= gx * inv * step; y -= gy * inv * step; z -= gz * inv * step;
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    }
  }

  /* de-ripple: dual methods alternate their vertices either side of the
     true surface wherever two blended forms meet at a shallow angle.
     One Laplacian pass with re-projection removes the corrugation
     without shrinking the form. */
  for (let k = 0; k < (opts.relax ?? 1); k++) laplacian(pos, indices, nv, field, cell, eps);

  for (let i = 0; i < nv; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const gx = field(x + eps, y, z) - field(x - eps, y, z);
    const gy = field(x, y + eps, z) - field(x, y - eps, z);
    const gz = field(x, y, z + eps) - field(x, y, z - eps);
    const l = Math.hypot(gx, gy, gz) || 1;
    nor[i * 3] = gx / l; nor[i * 3 + 1] = gy / l; nor[i * 3 + 2] = gz / l;
  }
  /* Three passes, not two. The gradient normal is exact, and exact on a
     smooth-min field means it carries every ripple the blend leaves —
     which a two-band ramp magnifies into a hard-edged patch wandering
     across a cheek. Positions are untouched, so the silhouette is not
     softened; only the shading is. */
  smoothNormals(nor, indices, nv, opts.normalPasses ?? 3);

  return { position: pos, normal: nor, index: indices, count: nv };
}

function laplacian(pos, idx, nv, field, cell, eps) {
  const acc = new Float32Array(nv * 3);
  const cnt = new Uint16Array(nv);
  for (let t = 0; t < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e], b = idx[t + (e + 1) % 3];
      acc[a * 3] += pos[b * 3]; acc[a * 3 + 1] += pos[b * 3 + 1]; acc[a * 3 + 2] += pos[b * 3 + 2];
      cnt[a]++;
      acc[b * 3] += pos[a * 3]; acc[b * 3 + 1] += pos[a * 3 + 1]; acc[b * 3 + 2] += pos[a * 3 + 2];
      cnt[b]++;
    }
  }
  const lim = cell * 0.6;
  for (let i = 0; i < nv; i++) {
    if (!cnt[i]) continue;
    const w = 0.5;
    let x = lerp(pos[i * 3], acc[i * 3] / cnt[i], w);
    let y = lerp(pos[i * 3 + 1], acc[i * 3 + 1] / cnt[i], w);
    let z = lerp(pos[i * 3 + 2], acc[i * 3 + 2] / cnt[i], w);
    /* re-project so smoothing cannot eat the volume */
    const d0 = field(x, y, z);
    const gx = field(x + eps, y, z) - field(x - eps, y, z);
    const gy = field(x, y + eps, z) - field(x, y - eps, z);
    const gz = field(x, y, z + eps) - field(x, y, z - eps);
    const gl = Math.sqrt(gx * gx + gy * gy + gz * gz) / (2 * eps);
    if (gl > 0.35) {
      const inv = 1 / (gl * 2 * eps);
      let step = d0 / gl;
      if (step > lim) step = lim; else if (step < -lim) step = -lim;
      x -= gx * inv * step; y -= gy * inv * step; z -= gz * inv * step;
    }
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
  }
}

function smoothNormals(nor, idx, nv, passes) {
  const acc = new Float32Array(nv * 3);
  const cnt = new Uint16Array(nv);
  for (let p = 0; p < passes; p++) {
    acc.fill(0); cnt.fill(0);
    for (let t = 0; t < idx.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = idx[t + e], b = idx[t + (e + 1) % 3];
        acc[a * 3] += nor[b * 3]; acc[a * 3 + 1] += nor[b * 3 + 1]; acc[a * 3 + 2] += nor[b * 3 + 2];
        cnt[a]++;
        acc[b * 3] += nor[a * 3]; acc[b * 3 + 1] += nor[a * 3 + 1]; acc[b * 3 + 2] += nor[a * 3 + 2];
        cnt[b]++;
      }
    }
    for (let i = 0; i < nv; i++) {
      if (!cnt[i]) continue;
      const x = nor[i * 3] + acc[i * 3] / cnt[i] * 0.85;
      const y = nor[i * 3 + 1] + acc[i * 3 + 1] / cnt[i] * 0.85;
      const z = nor[i * 3 + 2] + acc[i * 3 + 2] / cnt[i] * 0.85;
      const l = Math.hypot(x, y, z) || 1;
      nor[i * 3] = x / l; nor[i * 3 + 1] = y / l; nor[i * 3 + 2] = z / l;
    }
  }
}

/**
 * Ambient occlusion — WALLY'S LAW, ray for ray.
 *
 * THE OLD RADII WERE THE DEFECT. Five taps out to 0.145 m on a 1.68 m
 * figure is a *contact* trace: it finds the 20 mm creases the sculpt
 * carves and nothing else, so a human stood next to Wally had crisp
 * nostrils and a completely unshaded armpit, jaw, crotch and elbow.
 * §1.2 does not describe a contact term — "AO radius is generous and
 * *soft*; hard contact darkening looks like plastic and is forbidden" —
 * and model.js's own note lists the creases it has to catch as
 * "0.2-0.4 m features on a 1.6 m character". Wally traces to 0.460 m.
 * A human is the same 1.68 m tall, so the radii here are his, scaled
 * only by the 0.84 ratio of a human head to his cranium.
 *
 * Three things follow from copying him and they are all load-bearing:
 * cosine-ish tap WEIGHTS (a near tap is worth three times a far one, so
 * the crease still wins over the room), a floor of 0.36 rather than
 * 0.30 (§1.2 gives the deepest crease as a 24 % value drop, not 40 —
 * below the floor a warm-grey multiply turns clay into dirt), and three
 * Laplacian passes over the one-ring, which is what turns a per-vertex
 * cone trace from a stencil with a hard rim into a shadow.
 */
const AO_T = [0.026, 0.062, 0.126, 0.235, 0.386];
const AO_W = [0.30, 0.26, 0.20, 0.14, 0.10];

/** One vertex's cone trace. Shared by the field bake and the
    hard-surface pieces, so a hat brim and a cheek occlude by the same
    law and cannot read as two different renderers' AO. */
export function traceAO(field, x, y, z, nx, ny, nz, strength = 1.0) {
  let occ = 0;
  for (let s = 0; s < AO_T.length; s++) {
    const t = AO_T[s];
    let d = field(x + nx * t, y + ny * t, z + nz * t);
    if (d < 0) d = 0;
    occ += AO_W[s] * (t - d) / t;
  }
  const a = 1 - strength * occ;
  return a < 0.36 ? 0.36 : a > 1 ? 1 : a;
}

export function bakeAO(pos, nor, nv, field, strength = 1.0, index = null) {
  const ao = new Float32Array(nv);
  for (let i = 0; i < nv; i++) {
    ao[i] = traceAO(field, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2],
      nor[i * 3], nor[i * 3 + 1], nor[i * 3 + 2], strength);
  }
  blurAO(ao, index, nv, 3);
  for (let i = 0; i < nv; i++) ao[i] = Math.pow(ao[i], 0.90);
  return ao;
}

/** Laplacian blur over the mesh one-ring. §1.2 forbids hard contact
    darkening outright and a bare cone trace has a hard edge wherever its
    longest ray first clears the occluder. */
export function blurAO(ao, index, nv, passes = 3) {
  if (!index || !index.length) return ao;
  const acc = new Float32Array(nv);
  const deg = new Uint16Array(nv);
  for (let p = 0; p < passes; p++) {
    acc.fill(0); deg.fill(0);
    for (let t = 0; t < index.length; t += 3) {
      const a = index[t], b = index[t + 1], c = index[t + 2];
      acc[a] += ao[b] + ao[c]; deg[a] += 2;
      acc[b] += ao[a] + ao[c]; deg[b] += 2;
      acc[c] += ao[a] + ao[b]; deg[c] += 2;
    }
    for (let i = 0; i < nv; i++) {
      if (!deg[i]) continue;
      ao[i] = ao[i] * 0.38 + (acc[i] / deg[i]) * 0.62;
    }
  }
  return ao;
}

/* ==================================================================
   3. Proportions and skeleton

   4.5 heads tall (ART brief), chunky, and — like Wally — essentially
   neckless: the head sits on the shoulders with a 40 mm stub between.
   H is the standing height; every station below is quoted in metres at
   H = 1.68 so the table can be read against a tape measure.
   ================================================================== */

export const H = 1.68;

export const PROP = {
  H,
  sole: 0.000, ankle: 0.092, knee: 0.440, hip: 0.848, crotch: 0.792,
  waist: 0.995, chest: 1.185, shoulder: 1.248, collar: 1.272, chin: 1.308,
  headC: 1.486, crown: 1.680,

  /* torso profile: (y, halfWidth, depthRatio). Depth is 0.74-0.82 of
     width — a human is a flattened barrel, not a tube, and getting that
     ratio wrong is what makes a stylised figure read as a skittle. */
  /* CHUNKY IS A MEASUREMENT, NOT A MOOD. The first pass ran a 0.294 m
     chest against a 0.268 m head and 0.116 m arms, and rendered as a
     slim mannequin standing next to a vinyl elephant — the one defect
     the brief calls the most damaging. A toy figure carries its mass in
     the trunk and the upper arm: the chest is now 0.316 across, the
     shoulder span 0.436 (1.63 head-widths, against Wally's ear-to-
     shoulder logic), and the limbs are 15-20 % fatter everywhere. */
  torso: [
    [0.800, 0.124, 0.86],
    [0.872, 0.152, 0.80],   // hips, widest below the waist
    [0.968, 0.132, 0.79],   // waist, narrowest
    [1.070, 0.146, 0.78],
    [1.180, 0.162, 0.76],   // chest, widest above
    [1.272, 0.148, 0.74],   // collar — square, not tapered to a spire
  ],
  shoulderX: 0.152,
  /* THE HAND MUST NOT TOUCH THE THIGH IN BIND POSE, and "touch" means
     "come within two mesher cells of". The first pass put the palm's
     inner edge at x 0.170 against a thigh whose outer edge is 0.196:
     they overlapped by 26 mm, surface nets welded them into one
     surface, and the moment a talk gesture raised the arm the weld
     stretched into a flat blade running from the shoulder to the knee.
     No weight table can fix that — the topology is wrong.
     The arm therefore hangs forward as well as out (z -0.004 -> 0.078,
     the same trick rig.js uses on Wally), which buys the clearance in
     the cheap axis.

     THE ABDUCTION IS BAKED, NOT POSED. These stations are authored with
     the arm hanging straight down, and straight down the upper arm is
     24 mm INSIDE the flank all the way to the elbow — the smooth union
     welds them and crowd.js's 0.20 rad of live shoulder abduction then
     stretches that weld into the poncho the review blocked. A weld is a
     topology fault and no join radius or weight table can undo it. So
     ARM_ABDUCT below rotates the whole chain — elbow, wrist, palm,
     thumb, digits, capture volumes and bones — outward about the
     shoulder BEFORE anything is meshed. Daylight opens at y 1.02, which
     is where an armpit belongs, and crowd.js keeps only 0.03 rad of live
     abduction so the skin barely has to deform at all. */
  arm: [
    [0.156, 1.238, -0.004, 0.076],   // shoulder
    [0.192, 1.008,  0.030, 0.062],   // elbow
    [0.220, 0.796,  0.078, 0.052],   // wrist
  ],
  /* HANDS HAVE FINGERS. §1.1 gives Wally "4 stubby digits + thumb, each
     a rounded capsule" and a crowd standing next to him with two
     ellipsoids of soap on the end of each arm is two stylisation levels
     in one frame — the single loudest note in the review.
     Four digits at 11 mm radius cannot be resolved by a 21.5 mm body
     cell, so the hand is meshed as its own field at the head cell and
     merged into the body geometry (see handField / CELL_HAND). The palm
     shrinks to make room: a 62 mm half-height palm swallows a 30 mm
     digit whole. */
  /* A HAND IN THIS MATERIAL IS A MITTEN WITH DIGITS SUGGESTED IN IT.
     The first pass gave it a 60 mm-deep palm and a 52 mm knuckle line
     with the digits splayed 16 mm apart at the tip — a wide flat fan,
     which read as a maple leaf hanging off a sleeve and was the one
     piece of the figure that could not possibly have come out of the
     same kiln as §1.1's "4 stubby digits + thumb, each a rounded
     capsule". The palm is now nearly as deep as it is wide, the digits
     are fatter, shorter and very nearly parallel, and they blend at a
     radius that leaves a groove rather than a gap. */
  palm: { c: [0.238, 0.748, 0.112], r: [0.029, 0.042, 0.041] },
  thumb: { c: [0.214, 0.762, 0.134], r: [0.023, 0.029, 0.024] },
  /* digit i fans off the front-bottom of the palm; `t` is -1..1 across
     the knuckle line, index finger at t = -1 on the left hand */
  digit: { r0: 0.0156, r1: 0.0132, len: 0.041, spread: 0.0212, y: 0.706, z: 0.114 },
  leg: [
    [0.106, 0.846,  0.004, 0.096],   // hip
    [0.099, 0.440,  0.008, 0.078],   // knee
    [0.094, 0.104, -0.006, 0.056],   // ankle
  ],
  /* A SHOE IS NOT A BRICK. h.y 0.014 with r 0.034 leaves a 104 x 144 mm
     flat top plane and two flat side planes on the largest unbroken
     area of the figure, and a 21.5 mm cell renders those as visible
     polygon facets — §7's one absolute prohibition on an organic form.
     The flat core is now 28 x 20 x 88 mm inside a 38 mm round radius, so
     every visible surface is curved and the two-band ramp has something
     to travel across; the heel and toe balls below break the profile so
     it reads as a shoe and not as a loaf. Sole sits 2 mm above y = 0. */
  foot: { c: [0.096, 0.050, 0.046], h: [0.014, 0.010, 0.044], r: 0.038 },
  neck: { a: [0, 1.190, 0.000], b: [0, 1.316, 0.006], ra: 0.070, rb: 0.062 },
};

/* Radians of shoulder abduction baked into every station below the
   shoulder. See the note on PROP.arm. */
export const ARM_ABDUCT = 0.17;

/** Authored arm-down point -> baked bind-pose point, on side `s`. */
export function abduct(p, s = 1) {
  const px = PROP.arm[0][0], py = PROP.arm[0][1];
  const c = Math.cos(ARM_ABDUCT), sn = Math.sin(ARM_ABDUCT);
  const dx = p[0] - px, dy = p[1] - py;
  return [(px + dx * c - dy * sn) * s, py + dx * sn + dy * c, p[2]];
}
/* The bind-pose arm chain and hand stations, both sides derived by
   negating x. Everything downstream reads these, never PROP.arm. */
export const ARM_W = PROP.arm.map((a) => {
  const p = abduct(a);
  return [p[0], p[1], p[2], a[3]];
});
export const PALM_W = abduct(PROP.palm.c);
export const THUMB_W = abduct(PROP.thumb.c);
export const DIGIT_W = abduct([PROP.palm.c[0], PROP.digit.y, PROP.digit.z]);

/* Bone table. 17 bones — a tenth of a film rig and everything a
   stylised toy needs. Bind rotation is identity for every bone, so a
   pose is literally a set of euler angles and a blend is a lerp. */
const BASE = [
  { name: 'root',  parent: null,   w: [0, 0, 0] },
  { name: 'hips',  parent: 'root', w: [0, 0.880, 0.004] },
  { name: 'spine', parent: 'hips', w: [0, 1.020, 0.008] },
  { name: 'chest', parent: 'spine', w: [0, 1.170, 0.000] },
  { name: 'head',  parent: 'chest', w: [0, 1.290, 0.004] },
];
const LEFT = [
  { name: 'armL0', parent: 'chest', w: ARM_W[0].slice(0, 3) },
  { name: 'armL1', parent: 'armL0', w: ARM_W[1].slice(0, 3) },
  { name: 'handL', parent: 'armL1', w: ARM_W[2].slice(0, 3) },
  { name: 'legL0', parent: 'hips',  w: PROP.leg[0].slice(0, 3) },
  { name: 'legL1', parent: 'legL0', w: PROP.leg[1].slice(0, 3) },
  { name: 'footL', parent: 'legL1', w: [PROP.leg[2][0], PROP.leg[2][1] - 0.026, PROP.leg[2][2]] },
];
const mirrorName = (n) => n.replace(/L(\d*)$/, 'R$1');

export const BONES = (() => {
  const out = BASE.map((b) => ({ ...b }));
  for (const b of LEFT) out.push({ ...b });
  for (const b of LEFT) {
    out.push({
      name: mirrorName(b.name),
      parent: /L\d*$/.test(b.parent) ? mirrorName(b.parent) : b.parent,
      w: [-b.w[0], b.w[1], b.w[2]],
    });
  }
  return out;
})();
export const BONE_INDEX = (() => {
  const m = Object.create(null);
  BONES.forEach((b, i) => { m[b.name] = i; });
  return m;
})();
const BONE_PARENT = BONES.map((b) => (b.parent == null ? -1 : BONE_INDEX[b.parent]));

/* Tree distance between every pair of bones. Skin weights are only ever
   shared between bones within two hops, and that restriction is not an
   optimisation — it is the difference between a limb and a sail. The
   hand's capture sphere and the thigh's capsule come within a few
   centimetres of each other with the arms down, so a nearest-two blend
   with no relationship test hands a strip of palm to legR0; the moment
   the arm swings, those vertices stay behind and the mesh stretches a
   flat triangle from the shoulder to the knee. It is unmistakable in a
   frame and invisible in the weight table. */
const BONE_DIST = (() => {
  const n = BONES.length;
  const adj = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    const p = BONE_PARENT[i];
    if (p >= 0) { adj[i].push(p); adj[p].push(i); }
  }
  const D = new Uint8Array(n * n).fill(255);
  for (let s = 0; s < n; s++) {
    D[s * n + s] = 0;
    const q = [s];
    for (let h = 0; h < q.length; h++) {
      const v = q[h];
      const dv = D[s * n + v];
      if (dv >= 3) continue;
      for (const w of adj[v]) {
        if (D[s * n + w] === 255) { D[s * n + w] = dv + 1; q.push(w); }
      }
    }
  }
  return D;
})();

/** Capture volumes — capsules that decide which bone owns which skin.
    Deliberately simpler than the sculpt: blobby geometry, clean joints. */
const CAP = {
  hips:  [['c', -0.078, 0.868, 0.004, 0.078, 0.868, 0.004, 0.128, 0.128]],
  spine: [['c', 0, 0.960, 0.008, 0, 1.086, 0.006, 0.126, 0.136]],
  chest: [['c', 0, 1.098, 0.002, 0, 1.244, -0.006, 0.146, 0.134],
          ['s', 0, 1.324, 0.004, 0.074]],
  head:  [['s', 0, 1.400, 0.004, 0.130]],
  /* the arm volumes are derived from the baked chain so they can never
     drift out from under the sculpt when ARM_ABDUCT changes */
  armL0: [['c', ...abduct([0.156, 1.234, -0.004]), ...abduct([0.192, 1.018, 0.030]), 0.074, 0.064]],
  armL1: [['c', ...abduct([0.194, 0.994, 0.032]), ...abduct([0.220, 0.810, 0.076]), 0.064, 0.056]],
  handL: [['s', ...abduct([0.238, 0.726, 0.115]), 0.094]],
  legL0: [['c', 0.106, 0.840, 0.004, 0.099, 0.452, 0.008, 0.100, 0.084]],
  legL1: [['c', 0.099, 0.428, 0.008, 0.094, 0.116, -0.006, 0.084, 0.066]],
  footL: [['b', 0.096, 0.050, 0.048, 0.054, 0.026, 0.078, 0.038]],
};
for (const k of Object.keys(CAP)) {
  if (!/L\d*$/.test(k)) continue;
  CAP[mirrorName(k)] = CAP[k].map((p) => {
    const q = p.slice();
    if (q[0] === 's' || q[0] === 'b') q[1] = -q[1];
    else { q[1] = -q[1]; q[4] = -q[4]; }
    return q;
  });
}

function capDist(caps, x, y, z) {
  let d = Infinity;
  for (const p of caps) {
    let v;
    if (p[0] === 's') {
      v = Math.hypot(x - p[1], y - p[2], z - p[3]) - p[4];
    } else if (p[0] === 'c') {
      const ux = p[4] - p[1], uy = p[5] - p[2], uz = p[6] - p[3];
      const uu = ux * ux + uy * uy + uz * uz || 1e-9;
      const px = x - p[1], py = y - p[2], pz = z - p[3];
      let t = (px * ux + py * uy + pz * uz) / uu;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      v = Math.hypot(px - ux * t, py - uy * t, pz - uz * t) - (p[7] + (p[8] - p[7]) * t);
    } else {
      const qx = Math.abs(x - p[1]) - p[4], qy = Math.abs(y - p[2]) - p[5], qz = Math.abs(z - p[3]) - p[6];
      const mx = Math.max(qx, 0), my = Math.max(qy, 0), mz = Math.max(qz, 0);
      v = Math.hypot(mx, my, mz) + Math.min(Math.max(qx, Math.max(qy, qz)), 0) - p[7];
    }
    if (v < d) d = v;
  }
  return d;
}

export function buildSkeleton() {
  const bones = [];
  const byName = Object.create(null);
  for (let i = 0; i < BONES.length; i++) {
    const def = BONES[i];
    const b = new THREE.Bone();
    b.name = def.name;
    const p = BONE_PARENT[i];
    const pw = p >= 0 ? BONES[p].w : [0, 0, 0];
    b.position.set(def.w[0] - pw[0], def.w[1] - pw[1], def.w[2] - pw[2]);
    b.quaternion.identity();
    bones.push(b);
    byName[def.name] = b;
    if (p >= 0) bones[p].add(b);
  }
  bones[0].updateMatrixWorld(true);
  return { bones, byName, rootBone: bones[0], skeleton: new THREE.Skeleton(bones) };
}

/* ==================================================================
   4. Part ids

   These ride in the geometry as a Uint8 attribute and are resolved to
   colours per character. Everything downstream of the mesher is
   colour-agnostic, which is why one body mesh can dress fifty people.
   ================================================================== */
export const PART = {
  TORSO: 0, ARM: 1, HAND: 2, LEG: 3, FOOT: 4, NECK: 5,
  SKIN: 10, EAR: 11, LIP: 12, EYEW: 13, IRIS: 14, BROW: 15,
  HAIR: 16, HAIRDK: 17, BEARD: 18, FRAME: 19, LENS: 20,
  HAT: 21, HATB: 22, HATC: 23, NOSE: 24,
};

/* ==================================================================
   5. The body — three cached fields, shared by everyone

   THREE BODIES, NOT ONE RECOLOURED. A lineup of fourteen people who are
   the same torso, the same arm and the same leg with different jumpers
   is the amateur tell §6 asks us not to be, and ±16 % of bone scale on
   a shared skin does not read at all: girth carried by a bone is a
   uniform swell, not a different person. So the field takes a shape
   record and three of them are meshed and cached — a lean one, the
   standard one and a heavy one with a paunch and a thicker neck. The
   head cache already does exactly this, at the same cost.

   Everything below the shape record is stations in metres, and the
   stations are the SAME in all three: the skeleton, the capture volumes
   and every pose in crowd.js are authored against them, so a variant
   may change how wide a station is but never where it is.
   ================================================================== */

export const BODY_SHAPES = [
  /* g = the girth this variant already carries, so the residual bone
     scale a character gets is spec.build / g and stays near 1. */
  {
    key: 'lean', g: 0.85,
    w: [0.90, 0.87, 0.90, 0.86, 0.88, 0.93], depth: 0.98,
    limb: 0.88, arm: 0.88, leg: 0.90, shoulder: 0.94, neck: 0.92,
    armOut: -0.008, foot: 0.94,
  },
  {
    key: 'mid', g: 1.00,
    w: [1, 1, 1, 1, 1, 1], depth: 1,
    limb: 1, arm: 1, leg: 1, shoulder: 1, neck: 1,
    armOut: 0, foot: 1,
  },
  {
    key: 'heavy', g: 1.20,
    w: [1.20, 1.24, 1.30, 1.30, 1.10, 1.02], depth: 1.10,
    limb: 1.16, arm: 1.16, leg: 1.14, shoulder: 1.08, neck: 1.16,
    armOut: 0.030, foot: 1.06,
  },
];
export const BODY_SHAPE_BY_KEY = Object.fromEntries(BODY_SHAPES.map((s) => [s.key, s]));

export function bodyField(shape = BODY_SHAPES[1]) {
  const S = typeof shape === 'string' ? (BODY_SHAPE_BY_KEY[shape] || BODY_SHAPES[1]) : shape;
  const T = PROP.torso.map((r, i) => [r[0], r[1] * S.w[i], Math.min(0.99, r[2] * S.depth)]);
  const torsoPrims = [];
  for (let i = 0; i < T.length - 1; i++) {
    const kz = (T[i][2] + T[i + 1][2]) * 0.5;
    torsoPrims.push(tube([0, T[i][0], 0], [0, T[i + 1][0], 0], T[i][1], T[i + 1][1], 1, kz));
  }
  /* A chest that is only a stack of cones has no shoulder: the deltoid
     is a separate ball, set inboard of the arm so an arm that lifts
     rotates the shoulder with it instead of tearing a bat wing out of
     the flank. */
  /* THE SHOULDER IS A BALL AND IT HAS TO BE ONE. A torso profile that
     tapers into a collar and an arm chain that starts below it leaves a
     40-degree slope from the neck to the deltoid, and a figure with
     sloping shoulders reads as timid and thin no matter how wide the
     chest is. The ball sits at collar height, inboard of the arm, so the
     top line runs flat from the neck out to the arm and then turns.

     IT ALSO HAS TO BE A BALL AND NOT A FILLET. A 55 mm smooth-min on a
     162 mm half-chest blends a third of the chest away and drags a web
     from the deltoid down the flank to the elbow: every figure came out
     of the review as a bell with no shoulder, no chest and no waist,
     and every sleeve flared outward at the hem. The join is now 18 mm —
     under one mesher cell of fillet — and the ball has grown to carry
     the shoulder on its own volume instead of on the blend. */
  /* A SHOULDER IS A DOME, NOT A CORNER. The ball itself was right; its
     join was not. 18 mm of fillet against a 162 mm half-chest leaves a
     visible crease running down from the collar to the arm and a hard
     top corner where the deltoid meets the trapezius — the "square
     slabs" the review named. 34 mm is still a third of what welded the
     chest into a bell, and it is enough that the top line runs over the
     shoulder as one continuous curve. The second ball is the trapezius
     ramp between the neck and the deltoid: without it the run from the
     collar to the shoulder is a straight chamfer whatever the fillet
     does, because there is no mass there to curve. */
  /* THREE MASSES, NOT TWO. Two balls give the top line a curve and then
     a corner where the outer one ends — the "square slab" note. The
     third sits low and outboard, under the deltoid's outer face, so the
     line turns through the shoulder and keeps turning into the arm
     instead of stopping. Nothing here is a fillet: the join only rounds
     what the volumes have already put in the right place. */
  const deltoid = (s) => [
    esph([0.128 * S.shoulder * s, 1.238, 0.002],
      [0.098 * S.shoulder, 0.088 * S.shoulder, 0.092 * S.shoulder]),
    esph([0.062 * S.shoulder * s, 1.262, -0.002],
      [0.072 * S.shoulder, 0.054 * S.shoulder, 0.076 * S.shoulder]),
    esph([0.156 * S.shoulder * s, 1.186, 0.004],
      [0.062 * S.shoulder, 0.062 * S.shoulder, 0.070 * S.shoulder]),
  ];

  const armX = (i) => ARM_W[i][0] + S.armOut;
  /* THE ELBOW AND THE WRIST ARE FORMS. A two-cone chain from shoulder to
     wrist is a straight tapered tube — precisely the "straight tapered
     boxes, not soft rounded limbs" the review called out — because the
     only thing that happens along it is that it gets thinner. A joint
     swells; the mass above and below it does not run in one line. */
  const armPrims = (s) => {
    const A = ARM_W;
    const out = [];
    for (let i = 0; i < A.length - 1; i++) {
      out.push(tube([armX(i) * s, A[i][1], A[i][2]], [armX(i + 1) * s, A[i + 1][1], A[i + 1][2]],
        A[i][3] * S.arm, A[i + 1][3] * S.arm));
    }
    /* biceps mass, high on the upper arm */
    out.push(esph([(armX(0) + (armX(1) - armX(0)) * 0.42) * s,
      A[0][1] + (A[1][1] - A[0][1]) * 0.42,
      A[0][2] + (A[1][2] - A[0][2]) * 0.42 + 0.006],
    [0.070 * S.arm, 0.062 * S.arm, 0.066 * S.arm]));
    /* the elbow itself — a ball, so the limb has a hinge in silhouette */
    out.push(esph([armX(1) * s, A[1][1], A[1][2] - 0.006],
      [0.058 * S.arm, 0.054 * S.arm, 0.058 * S.arm]));
    return out;
  };
  const legPrims = (s) => {
    const L = PROP.leg;
    const out = [];
    for (let i = 0; i < L.length - 1; i++) {
      out.push(tube([L[i][0] * s, L[i][1], L[i][2]], [L[i + 1][0] * s, L[i + 1][1], L[i + 1][2]],
        L[i][3] * S.leg, L[i + 1][3] * S.leg));
    }
    /* knee cap and calf. Same argument as the elbow: a leg that narrows
       monotonically from hip to ankle is a dowel with a taper on it. */
    out.push(esph([L[1][0] * s, L[1][1] + 0.006, L[1][2] + 0.012],
      [0.072 * S.leg, 0.062 * S.leg, 0.068 * S.leg]));
    out.push(esph([L[1][0] * s, L[1][1] - 0.098, L[1][2] - 0.026],
      [0.066 * S.leg, 0.086 * S.leg, 0.062 * S.leg]));
    return out;
  };
  /* The shoe: a rounded slab whose flat core is smaller than its round
     radius in every axis, plus a heel ball behind and a toe ball in
     front so the profile has an instep to break it. */
  const F = PROP.foot, ff = S.foot;
  const footPrims = (s) => [
    esph([PROP.leg[2][0] * s, 0.114, -0.004], [0.046 * ff, 0.050, 0.050 * ff]),
    rbox([F.c[0] * s, F.c[1], F.c[2]], [F.h[0] * ff, F.h[1], F.h[2] * ff], F.r),
    esph([F.c[0] * s, F.c[1] + 0.006, -0.028], [0.040 * ff, 0.042, 0.036 * ff]),
    esph([F.c[0] * s, F.c[1] - 0.004, 0.100], [0.043 * ff, 0.034, 0.044 * ff]),
  ];

  /* The seat. In profile a torso that ends at the hip station is a tube
     cut off square; the buttock is what turns the line and it is the one
     mass a two-band ramp can read from behind. */
  const seat = esph([0, 0.856, -0.052 * S.depth],
    [0.150 * S.w[1], 0.088, 0.076 * S.depth]);
  /* Pectoral / upper-back mass, so the chest is not a cylinder either. */
  const pec = esph([0, 1.176, 0.030 * S.depth],
    [0.148 * S.w[4], 0.062, 0.062 * S.depth]);

  const nk = PROP.neck;
  const blobs = [
    blob(PART.TORSO, [...torsoPrims, seat, pec], 0.017, 0.024, 'spine'),
    /* join 0.034 — see the deltoid note. The blend is now doing the job
       a fillet is for (rounding a corner) instead of the job a volume is
       for (carrying the shoulder), which is why it can afford to be
       generous without dragging a web down the flank. */
    blob(PART.TORSO, deltoid(1), 0.038, 0.046, 'chest'),
    blob(PART.TORSO, deltoid(-1), 0.038, 0.046, 'chest'),
    /* 0.038 at the collar: §1.1's law for Wally is that the head sits
       directly on the shoulders with no neck, and a neck tube welded on
       at 0.026 leaves a visible step where it meets the trapezius. */
    blob(PART.NECK, [tube(nk.a, nk.b, nk.ra * S.neck, nk.rb * S.neck)], 0.01, 0.038, 'head'),
    /* 0.022 at the armpit. The bake already opens daylight at y 1.02, so
       a fillet of one mesher cell rounds the corner without closing the
       slot: model.js makes exactly this trade on Wally's arm. */
    blob(PART.ARM, armPrims(1), 0.019, 0.026, 'armL0'),
    blob(PART.ARM, armPrims(-1), 0.019, 0.026, 'armR0'),
    blob(PART.LEG, legPrims(1), 0.021, 0.026, 'legL0'),
    blob(PART.LEG, legPrims(-1), 0.021, 0.026, 'legR0'),
    blob(PART.FOOT, footPrims(1), 0.034, 0.030, 'footL'),
    blob(PART.FOOT, footPrims(-1), 0.034, 0.030, 'footR'),
  ];
  return makeField(blobs);
}

/**
 * The hand, as its own field.
 *
 * Four digits at an 12 mm radius cannot survive a 21.5 mm body cell —
 * surface nets needs a clear cell and a half across a gap before it will
 * open one, so meshed with the body they come back as a paddle no matter
 * what the join is. The hand is therefore meshed on its own at the head
 * cell and merged into the body geometry afterwards; the skin-weight
 * pass runs over every body vertex regardless of which field made it, so
 * the digits ride the hand bone with no extra plumbing.
 *
 * The stub of forearm at the top is deliberately thinner than the body's
 * own arm so it hides inside it: it exists only so the wrist gets a
 * crease and the palm has something to occlude against.
 */
export function handField(s = 1, shape = BODY_SHAPES[1]) {
  const S = typeof shape === 'string' ? (BODY_SHAPE_BY_KEY[shape] || BODY_SHAPES[1]) : shape;
  const A = ARM_W, P = PROP.palm, D = PROP.digit;
  const o = S.armOut;
  const px = PALM_W[0] + o;
  /* the digit fan is authored across the knuckle line in arm-down space
     and rides the same bake as the rest of the chain, so the fingers
     point along the forearm rather than straight at the floor */
  const ca = Math.cos(ARM_ABDUCT), sa = Math.sin(ARM_ABDUCT);
  /* The stub is a QUARTER of the forearm, not all of it. Its only jobs
     are to give the wrist a crease for the AO bake and to hide the seam
     inside the body's own arm; meshing the whole forearm at the hand
     cell tripled the grid for nothing and put more triangles in two
     hands than in the entire body. */
  const st = 0.74;
  const sx = A[1][0] + (A[2][0] - A[1][0]) * st;
  const sy = A[1][1] + (A[2][1] - A[1][1]) * st;
  const sz = A[1][2] + (A[2][2] - A[1][2]) * st;
  const sr = (A[1][3] + (A[2][3] - A[1][3]) * st) * S.arm * 0.88;
  const prims = [
    tube([(sx + o) * s, sy, sz], [(A[2][0] + o) * s, A[2][1], A[2][2]],
      sr, A[2][3] * S.arm * 0.94),
    esph([px * s, PALM_W[1], PALM_W[2]], [P.r[0] * S.limb, P.r[1], P.r[2] * S.limb]),
  ];
  const digits = [];
  for (let i = 0; i < 4; i++) {
    const t = (i - 1.5) / 1.5;                       // -1 (index) .. 1 (little)
    const shorten = 1 - Math.abs(t) * 0.12 - (t > 0.6 ? 0.14 : 0);
    /* THE KNUCKLE LINE RUNS FRONT-TO-BACK, NOT SIDE-TO-SIDE.
       It used to fan along x, which puts the back of the hand facing
       forward — the hand rotated a quarter turn about the forearm — and
       an arm hanging at the side then ends in a flipper splayed out
       across the hip. model.js fans Wally's four digits along z
       (`bz = pc[2] + u * pitch * 1.5`) for exactly this reason: a
       relaxed arm hangs with the palm toward the thigh. The palm is
       flattened in x to match, so the whole hand is a paddle whose thin
       axis is medial-lateral, which is what a hand is. */
    const ax0 = px - Math.abs(t) * 0.005;
    const ay0 = DIGIT_W[1];
    const bz0 = D.z - t * D.spread * 1.05;
    const len = D.len * shorten;
    /* NEARLY PARALLEL, AND CURLED. 16 mm of splay per digit opened the
       tips to 96 mm across and turned the hand into a fan; 5 mm reads as
       a relaxed hand. Each digit is two short cones with the second bent
       back under the palm, so the hand hangs with the soft curl a
       relaxed one has instead of pointing four spikes at the pavement. */
    const mx = ax0 + len * 0.58 * sa;
    const my = ay0 - len * 0.58 * ca;
    const mz = bz0 + 0.016 * shorten;
    digits.push(tube([ax0 * s, ay0, bz0], [mx * s, my, mz], D.r0, D.r1 * 1.06));
    /* second phalanx bent back under the palm — a relaxed hand curls */
    digits.push(tube([mx * s, my, mz],
      [(mx + len * 0.42 * sa) * s, my - len * 0.38 * ca, mz + 0.003],
      D.r1 * 1.06, D.r1 * 0.86));
  }
  /* the thumb sits inboard and forward, angled across the palm */
  const th = tube([(THUMB_W[0] + o) * s, THUMB_W[1] + 0.014, THUMB_W[2] - 0.008],
    [(THUMB_W[0] + o - 0.006) * s, THUMB_W[1] - 0.026, THUMB_W[2] + 0.024],
    PROP.thumb.r[0], PROP.thumb.r[0] * 0.84);
  /* Wally's hand blends its digit cluster at k 0.009 and joins it to the
     palm at 0.020 — a groove between digits, never a gap, and never a
     butt joint at the knuckle. These are his numbers. */
  return makeField([
    blob(PART.HAND, prims, 0.018, 0.014, s > 0 ? 'handL' : 'handR'),
    blob(PART.HAND, digits, 0.009, 0.016, s > 0 ? 'handL' : 'handR'),
    blob(PART.HAND, [th], 0.008, 0.016, s > 0 ? 'handL' : 'handR'),
  ]);
}

/* ==================================================================
   6. The head shell — cranium, jaw, nose, ears, cached per face shape
   ================================================================== */

/** Feature stations, derived from a face record — shared by the head
    shell, the eyes/brows/mouth pass and the beards, so they cannot
    drift apart. */
export function faceStations(F) {
  const cy = PROP.headC;
  return {
    cy,
    crown: cy + F.ry,
    jawY: cy - F.ry * 0.62,
    chinY: cy - F.ry * 0.62 - F.chin,
    eyeY: cy - F.ry * 0.20,
    eyeX: F.rx * 0.40,
    eyeZ: F.rz * 0.885,
    browY: cy - F.ry * 0.20 + 0.032,
    /* THE MOUTH SITS TWO THIRDS OF THE WAY FROM EYE TO CHIN, NOT FIVE
       SIXTHS. jawY - chin*0.42 put it 77 % of the way down, three
       millimetres under a nose that ran to the same station — no
       philtrum at all, and no room above the lip for a beard to stop.
       Anchoring both to the eye-to-chin span puts 23 mm of upper lip
       between them, which is where a moustache goes. */
    mouthY: cy - F.ry * 0.20 - (F.ry * 0.42 + F.chin) * 0.72,
    /* the nose BASE — the underside of the ball, not its centre. Every
       feature that has to sit under a nose (moustache, philtrum, the
       hole a beard leaves for it) measures from this one number. */
    noseY: cy - F.ry * 0.20 - (F.ry * 0.42 + F.chin) * 0.50,
    hairline: cy + F.ry * 0.40,
  };
}

/**
 * The head.
 *
 * THE FACE MAY NOT BE A PLANE. The review's single loudest note was
 * that a human's features read as decals on a plate while Wally's read
 * as sculpted volume, and the cause was arithmetic: the whole front of
 * the skull was one ellipsoid, its brow a 30 mm-tall wafer buried at
 * 0.60 rz, and the only things standing off it were a 26 mm nose ball
 * and a set of separately-meshed beads. A two-band ramp on a surface
 * with no curvature has nothing to draw and a cone trace on a surface
 * with no crease has nothing to darken, so the features could only ever
 * be colour.
 *
 * Everything below is therefore *volume*: a brow that sweeps up and out
 * over each socket, a malar swell under it, a temple hollow behind it, a
 * gonial angle, a mental protuberance, a nose with a bridge and two
 * wings, and two lip pads with a slit between them. All of it in the
 * same language as model.js — round cones and ellipsoids under a
 * polynomial smooth-min, at the same blend radii — because the point is
 * not that a human has a nose, it is that the nose is made of the same
 * clay as Wally's trunk.
 */
export function headField(F, mood) {
  const S = faceStations(F);
  const cy = S.cy;
  const jaw = F.rx * F.jaw;
  const cranium = [
    esph([0, cy, 0.004], [F.rx, F.ry, F.rz]),
    /* THE OCCIPUT. A skull is not symmetric front-to-back: the back of
       it hangs lower and further out than the forehead, and without it
       the head reads as a ball with a face painted on the front — which
       is exactly the failure this file exists to fix. */
    esph([0, cy + F.ry * 0.02, -F.rz * 0.30], [F.rx * 0.95, F.ry * 0.90, F.rz * 0.82]),
    /* the forehead is flatter and stands slightly forward of the ball */
    esph([0, S.browY + F.ry * 0.40, F.rz * 0.30], [F.rx * 0.70, F.ry * 0.32, F.rz * 0.70]),
  ];
  /* BROW — a swept ridge per side plus the glabella between them, built
     from three balls along an arc because an axis-aligned ellipsoid
     cannot rise as it travels outward and a brow that does not rise is a
     shelf. It stands 12-16 mm proud of the forehead, which is more than
     the 0.040 join eats, so the socket beneath it gets a real shadow. */
  const browRidge = (s) => {
    const out = [];
    for (let i = 0; i < 3; i++) {
      const t = i / 2;                                   // 0 inner .. 1 outer
      out.push(esph([
        (F.rx * 0.15 + t * F.rx * 0.62) * s,
        S.browY + 0.014 + t * t * 0.012,
        F.rz * (0.76 - t * 0.30),
      ], [0.026 + t * 0.008, 0.019, 0.030]));
    }
    return out;
  };
  const glabella = esph([0, S.browY + 0.010, F.rz * 0.78], [F.rx * 0.20, 0.022, 0.026]);
  /* CHEEKBONE. The widest point of a face is the malar, not the cranium,
     and it sits under the outer end of the brow with a hollow beneath
     it. Sized so its outer edge lands ON F.rx: it gives the cheek a
     curve to shade across without widening the head by a millimetre. */
  const cheek = (s) => esph([F.rx * 0.64 * s, S.eyeY - 0.032, F.rz * 0.50],
    [0.050, 0.038, 0.056]);
  const mandible = [
    esph([0, S.jawY, 0.018], [jaw, F.ry * 0.44, F.rz * 0.92]),
    /* the gonial angle — the corner where the jaw turns up to the ear.
       Without it the mandible is a spoon and the profile has no line. */
    esph([jaw * 0.78, S.jawY - 0.004, -F.rz * 0.14], [0.028, 0.042, 0.038]),
    esph([-jaw * 0.78, S.jawY - 0.004, -F.rz * 0.14], [0.028, 0.042, 0.038]),
    esph([0, S.chinY + 0.030, 0.034], [jaw * 0.58, 0.036, F.rz * 0.64]),
    /* mental protuberance: the chin proper, standing forward of the jaw */
    esph([0, S.chinY + 0.028, F.rz * 0.60], [jaw * 0.36, 0.028, F.rz * 0.36]),
  ];
  /* THE NOSE HAS TO CLEAR THE FACE BY MORE THAN THE BLEND EATS. At a
     ball 17 mm proud on a join of 0.026 the smooth union swallowed
     three quarters of it and both close-ups came back with no nose at
     all — a face with eyes, a mouth and nothing between them, which is
     the uncanny one. 30 mm proud on a join of 0.013 leaves a nose that
     casts its own AO down onto the lip.
     THE WINGS ARE NOT OPTIONAL EITHER. A bridge and a ball is a snout;
     what makes it a nose is that it is widest at the base, where two
     alae flare either side of the tip and the nostrils sit between
     them. */
  const nose = [
    tube([0, S.eyeY + 0.038, F.rz * 0.80], [0, S.noseY + 0.038, F.rz * 0.97], 0.015, 0.025),
    esph([0, S.noseY + 0.024, F.rz * 1.05], [0.032, 0.027, 0.036]),
    esph([0.025, S.noseY + 0.015, F.rz * 0.93], [0.016, 0.017, 0.026]),
    esph([-0.025, S.noseY + 0.015, F.rz * 0.93], [0.016, 0.017, 0.026]),
  ];
  /* LIPS ARE VOLUME. A slit carved into a smooth jaw is a dark line and
     at two metres it collapses into the drawn arc §1.5 forbids. Two
     pads, the lower one fuller and set slightly further out, give the
     mouth a form that catches the key on the upper roll and drops into
     shadow under the lower one — which is what a mouth looks like on a
     matte object. The carve below still cuts the line between them. */
  const lips = [
    esph([0, S.mouthY + 0.011, F.rz * 0.93], [0.031, 0.0105, 0.028]),
    esph([0, S.mouthY - 0.013, F.rz * 0.94], [0.027, 0.0125, 0.029]),
  ];
  /* EAR — helix, lobe and (below) a concha dish, so it is a rounded fan
     with a rim and not a flake of skin. Same construction as Wally's
     ear in model.js, at a tenth of the size. */
  const ear = (s) => [
    esphN([F.rx * s * 0.94, S.eyeY + 0.002, -0.006], [0.029, 0.047, 0.015], [s, 0.06, -0.16], [0, 1, 0]),
    esphN([F.rx * s * 0.92, S.eyeY - 0.044, 0.004], [0.018, 0.019, 0.013], [s, 0.06, -0.16], [0, 1, 0]),
  ];
  const blobs = [
    blob(PART.SKIN, cranium, 0.072, 0.046, 'head'),
    blob(PART.SKIN, [...browRidge(1), ...browRidge(-1), glabella], 0.030, 0.034, 'head'),
    blob(PART.SKIN, [cheek(1)], 0.02, 0.044, 'head'),
    blob(PART.SKIN, [cheek(-1)], 0.02, 0.044, 'head'),
    blob(PART.SKIN, mandible, 0.058, 0.062, 'head'),
    blob(PART.NOSE, nose, 0.014, 0.013, 'head'),
    /* SKIN, not LIP. partAt hands a vertex to the nearest blob, and the
       lip pads are the nearest thing to the whole philtrum, the chin and
       half the cheek — so tagging the blob painted a fist-sized brown
       patch across the lower face. The pads are tagged by their own
       shapes below, which is 22 mm of lip and nothing else. */
    blob(PART.SKIN, lips, 0.012, 0.014, 'head'),
    blob(PART.EAR, ear(1), 0.02, 0.020, 'head'),
    blob(PART.EAR, ear(-1), 0.02, 0.020, 'head'),
  ];
  /* eye sockets: a shallow dish either side of the nose, so the eyes
     sit IN the face and pick up an AO ring rather than floating on it */
  /* THE SOCKETS HAVE TO CLEAR THE BRIDGE. At x = eyeX with a 34 mm
     mm radius the two dishes met in the middle of the face and took the
     nose with them — a nose 48 mm proud of the cheek measured, and
     rendered as nothing at all, because the carve that was supposed to
     seat the eyes was eating it from both sides. */
  const carves = [1, -1].map((s) => ({
    p: esph([S.eyeX * 1.12 * s, S.eyeY, F.rz * 1.06], [0.030, 0.024, 0.030]),
    k: 0.026,
  }));
  /* TEMPLE HOLLOW. The one carve that stops a cranium reading as a ball:
     a skull is pinched between the brow's outer end and the ear, and the
     shadow that sits there is what separates a forehead from a scalp.
     Shallow — it takes 8-10 mm out of a 150 mm half-width. */
  for (const s of [1, -1]) {
    carves.push({
      p: esph([F.rx * 0.90 * s, S.browY + 0.036, F.rz * 0.26], [0.034, 0.044, 0.046]),
      k: 0.030,
    });
  }
  /* CONCHA. The dish inside the ear rim, pushed out along the ear's own
     plate normal so it leaves the helix standing proud all the way
     round — the same trick model.js uses on Wally's ear dish. */
  for (const s of [1, -1]) {
    const n = norm3([s, 0.06, -0.16]);
    const o = 0.013;
    carves.push({
      p: esphN([F.rx * s * 0.94 + n[0] * o, S.eyeY + 0.004 + n[1] * o, -0.006 + n[2] * o],
        [0.016, 0.027, 0.013], [s, 0.06, -0.16], [0, 1, 0]),
      k: 0.010,
    });
  }
  /* MENTO-LABIAL CREASE — the soft shelf between the lower lip and the
     chin ball. It is what makes the chin read as a separate mass rather
     than as the bottom of the mouth. */
  carves.push({
    p: esph([0, S.mouthY - (S.mouthY - S.chinY) * 0.42, F.rz * 1.02],
      [0.044, 0.014, 0.030]),
    k: 0.022,
  });
  /* THE MOUTH IS SCULPTED, NOT PAINTED. §1.5 states the law for Wally
     — "a soft indent, sculpted, then AO'd, never a drawn line" — and a
     human face in the same material has to obey it. Three lozenges of
     lip colour laid on a smooth jaw disappeared completely at portrait
     distance: no crease means no AO, and without AO a matte surface has
     nothing to show. A carved slit gives the line its own shadow, and
     the tint pass below finds the vertices inside it. */
  const smile = mood === 'stern' ? -0.006 : mood === 'warm' ? 0.012 : 0.004;
  const mouth = [];
  for (let i = -1; i <= 1; i++) {
    mouth.push({
      /* pushed 3 % further out than it was: the lip pads now stand ~18
         mm proud of the cheek, and a slit authored against a flat face
         cuts most of the way through them. */
      p: esph([i * 0.0165,
        S.mouthY - smile * (1 - Math.abs(i)) + Math.abs(i) * smile * 0.5,
        F.rz * (1.09 - Math.abs(i) * 0.05)],
      [0.015, 0.0058, 0.024]),
      k: 0.012,
    });
  }
  carves.push(...mouth);
  /* nostrils: two dimples under the ball, between the wings. They moved
     out with the alae — authored against the old flat nose they were
     carving air. */
  for (const sd of [1, -1]) {
    carves.push({
      p: esph([sd * 0.0185, S.noseY + 0.002, F.rz * 1.00], [0.009, 0.009, 0.018]),
      k: 0.008,
    });
  }
  /* ---- BROW HAIR IS GEOMETRY, AND IT IS PART OF THE SKULL ----
     It used to be three separate hard-surface beads per side, merged in
     with the eyes: three balls with air between them, tagged dark, sat
     on a forehead. At any distance past a metre that is six dots in a
     row, which is the single most damaging thing in the whole figure —
     a decal so literal it reads as a printing error.
     A brow is a continuous roll of mass lying on the supraorbital ridge,
     so it belongs in the head's own field, smooth-unioned to it at a
     radius under one mesher cell: five overlapping balls per side, each
     seated against the surface the rest of the skull actually has
     (bisected, not guessed), standing 9 mm proud so the socket carve
     beneath can put a real shadow under it. The tint pass finds the
     vertices that belong to it; the geometry is skin all the way. */
  const base = makeField(blobs.slice(), carves);
  const browZ = (x, y) => {
    let lo = 0, hi = F.rz * 1.6;
    if (base.d(x, y, lo) > 0) return F.rz;
    for (let i = 0; i < 20; i++) {
      const m = (lo + hi) * 0.5;
      if (base.d(x, y, m) < 0) lo = m; else hi = m;
    }
    return lo;
  };
  const tilt = mood === 'stern' ? 0.30 : mood === 'warm' ? -0.14 : 0.05;
  const browHair = [];
  for (const s of [1, -1]) {
    for (let i = 0; i < 4; i++) {
      const t = i / 3;                                    // 0 inner .. 1 outer
      /* 0.24 rx inboard, 0.66 rx out: a 39 mm glabella gap between the
         pair (any less and they meet in a unibrow) and an outer end at
         0.115 m, short of the 0.150 m temple. */
      const bx = (F.rx * 0.24 + t * F.rx * 0.42) * s;
      const by = S.browY + 0.006 + t * t * 0.011 - tilt * (0.5 - t) * 0.030;
      browHair.push(esph([bx, by, browZ(bx, by) - 0.0062],
        [0.0172 - t * 0.0016, 0.0122, 0.0168]));
    }
  }
  /* k 0.010, not 0.020: the balls already overlap by 60 %, so all the
     blend has to do is take the scallop off the top edge. A generous k
     here bulges the waists out past the balls themselves, and the tint
     pass — which finds the roll by distance — then either misses the
     waists (a row of dashes) or is opened up until it floods the whole
     forehead. Both of those were on screen. */
  blobs.push(blob(PART.SKIN, browHair, 0.010, 0.013, 'head'));

  const field = makeField(blobs, carves);
  field.lipShapes = lips;
  field.browShapes = browHair;
  return field;
}

/* ==================================================================
   7. Hair, beards, glasses, hats — cached per style, canonical cranium
   ================================================================== */

const CANON = HUMAN.face.round;

/**
 * HAIR IS SOLID, NOT A SHELL, and that is a mesher constraint rather
 * than a modelling choice. A cap made by hollowing an inflated cranium
 * leaves a wall 16-22 mm thick; at the 13.8 mm cell this pass runs at
 * that is barely one and a half grid planes, and surface nets cannot
 * resolve a wall it cannot get two samples across — the rim comes out
 * scalloped where it survives at all. A solid dome over an opaque skull
 * looks identical from every angle a camera can reach, costs half the
 * primitives, and cannot tear.
 *
 * The hairline is therefore not a horizontal cut but a rounded box
 * standing in front of the face: it removes hair from the forehead and
 * the temples up to `hairline` and leaves the back and sides covered,
 * which is what a hairline actually is. Styles with no curtain get an
 * additional flat cut under the ears.
 */
function hairField(style) {
  const F = CANON;
  const S = faceStations(F);
  const cy = S.cy;
  const prims = [];
  const carves = [];

  /** open the face up to `yTop` */
  const hairline = (yTop, width = 0.86) => carves.push({
    p: rbox([0, yTop - 0.20, F.rz * 0.60 + 0.30], [F.rx * width, 0.20, 0.30], 0.020),
    k: 0.024,
  });
  /** flat cut under the ears, for styles that do not hang */
  const nape = (yLow) => carves.push({ p: rbox([0, yLow - 0.5, 0], [0.5, 0.5, 0.5], 0), k: 0.014 });
  /** solid dome standing `t` proud of the skull */
  const cap = (t) => prims.push(esph([0, cy + 0.004, 0.002], [F.rx + t, F.ry + t * 0.85, F.rz + t]));
  /** a mass hanging behind and beside the head down to `yEnd` */
  const curtain = (yEnd, halfW, depth, zc) =>
    prims.push(tube([0, cy + F.ry * 0.10, zc], [0, yEnd, zc - 0.012], halfW, halfW * 0.90,
      1, depth / halfW));

  switch (style) {
    case 'bald': return null;
    case 'receding':
      cap(0.022);
      hairline(cy + F.ry * 0.78, 0.66);
      nape(S.eyeY + 0.010);
      break;
    case 'buzz':
      cap(0.020); hairline(S.hairline - 0.006); nape(S.eyeY - 0.020);
      break;
    case 'short':
      cap(0.025); hairline(S.hairline); nape(S.eyeY - 0.034);
      break;
    case 'side':
      cap(0.023);
      prims.push(esph([-F.rx * 0.44, cy + F.ry * 0.68, F.rz * 0.44], [0.062, 0.032, 0.062]));
      hairline(S.hairline + 0.008, 0.80); nape(S.eyeY - 0.030);
      break;
    case 'quiff':
      cap(0.021);
      prims.push(esph([0, cy + F.ry * 0.92, F.rz * 0.40], [0.070, 0.050, 0.058]));
      prims.push(esph([0, cy + F.ry * 1.16, F.rz * 0.10], [0.052, 0.036, 0.046]));
      hairline(S.hairline + 0.014, 0.78); nape(S.eyeY - 0.020);
      break;
    case 'bob':
      cap(0.026); curtain(S.jawY - 0.020, 0.134, 0.116, -0.008);
      hairline(S.hairline - 0.004, 0.80);
      break;
    case 'long':
      cap(0.026); curtain(cy - F.ry * 2.70, 0.132, 0.108, -0.012);
      hairline(S.hairline, 0.80);
      break;
    case 'wavy':
      cap(0.028); curtain(cy - F.ry * 2.30, 0.136, 0.112, -0.010);
      prims.push(esph([-0.112, cy - F.ry * 1.55, -0.034], [0.046, 0.062, 0.048]));
      prims.push(esph([0.112, cy - F.ry * 1.95, -0.030], [0.046, 0.060, 0.046]));
      hairline(S.hairline + 0.006, 0.78);
      break;
    case 'locs':
      cap(0.026); curtain(cy - F.ry * 2.20, 0.128, 0.100, -0.014);
      for (let i = 0; i < 5; i++) {
        const a = -0.80 + i * 0.40;
        prims.push(tube([Math.sin(a) * 0.116, cy - F.ry * 0.30, Math.cos(a) * -0.100],
          [Math.sin(a) * 0.128, cy - F.ry * 2.30, Math.cos(a) * -0.104], 0.021, 0.018));
      }
      hairline(S.hairline, 0.78);
      break;
    case 'braids':
      cap(0.024);
      for (const s of [1, -1]) {
        for (let i = 0; i < 5; i++) {
          prims.push(esph([s * (F.rx + 0.006), S.eyeY - 0.030 - i * 0.070, -0.014 - i * 0.006],
            [0.031, 0.034, 0.031]));
        }
      }
      hairline(S.hairline, 0.80); nape(S.eyeY - 0.026);
      break;
    case 'pony':
      cap(0.024);
      prims.push(esph([0, cy + F.ry * 0.18, -F.rz - 0.028], [0.050, 0.052, 0.046]));
      prims.push(tube([0, cy + F.ry * 0.12, -F.rz - 0.034], [0, cy - F.ry * 1.30, -F.rz + 0.010], 0.042, 0.026));
      hairline(S.hairline, 0.80); nape(S.eyeY - 0.024);
      break;
    case 'bun':
      cap(0.023);
      prims.push(esph([0, cy + F.ry * 0.90, -F.rz * 0.56], [0.058, 0.054, 0.056]));
      hairline(S.hairline, 0.80); nape(S.eyeY - 0.028);
      break;
    case 'afro':
      prims.push(esph([0, cy + 0.016, -0.008], [F.rx + 0.064, F.ry + 0.048, F.rz + 0.060]));
      hairline(S.hairline + 0.012, 0.74);
      nape(S.eyeY - 0.048);
      break;
    case 'curly': {
      cap(0.022);
      const pts = [[-0.086, 0.60, 0.24], [0.086, 0.60, 0.24], [-0.062, 0.98, -0.30],
        [0.062, 0.98, -0.30], [0, 1.10, 0.26], [-0.104, 0.14, -0.42], [0.104, 0.14, -0.42]];
      for (const p of pts) prims.push(esph([p[0], cy + F.ry * p[1], F.rz * p[2]], [0.044, 0.042, 0.044]));
      hairline(S.hairline + 0.010, 0.76); nape(S.eyeY - 0.030);
      break;
    }
    case 'mohawk':
      prims.push(tube([0, cy + F.ry * 0.40, F.rz * 0.58], [0, cy + F.ry * 1.30, -F.rz * 0.06], 0.032, 0.026, 0.38, 1));
      prims.push(tube([0, cy + F.ry * 1.30, -F.rz * 0.06], [0, cy + F.ry * 0.46, -F.rz * 0.82], 0.026, 0.021, 0.38, 1));
      break;
    case 'headscarf':
      cap(0.027);
      prims.push(esph([0, S.eyeY - 0.014, -F.rz * 0.52], [F.rx * 0.96, 0.070, 0.078]));
      prims.push(tube([0, S.jawY, -F.rz * 0.84], [0.040, cy - F.ry * 1.55, -F.rz * 0.64], 0.042, 0.026, 1, 0.7));
      hairline(S.hairline - 0.030, 0.92);
      break;
    default:
      cap(0.025); hairline(S.hairline); nape(S.eyeY - 0.034);
  }
  if (!prims.length) return null;
  return makeField([blob(PART.HAIR, prims, 0.026, 0.030, 'head')], carves);
}

/**
 * THE BEARD IS THE FACE, OFFSET — and that is the whole fix.
 *
 * The first pass approximated the mandible with two ellipsoids and
 * inflated them by 8 mm. Two things went wrong and both are visible in
 * the review shot. 8 mm is under one 13.8 mm mesher cell, so the layer
 * resolved to a sheet of near-zero thickness whose boundary against the
 * skin had no relief and no occlusion — the "painted-on decal" §1.5
 * forbids. And an ellipsoid is not a jaw: where the approximation ran
 * proud of the real head the beard bulged into a balaclava, and where it
 * ran shy it vanished, so the thickness the eye actually saw varied from
 * nothing to twenty millimetres across one cheek.
 *
 * Taking the head's own field and subtracting `t` gives the exact offset
 * surface: t millimetres of relief everywhere, by construction, over a
 * chin, a jaw and a lip alike. The region it grows on is then a `keep`
 * — a jaw box for a full beard, a chin ball for a goatee, a lozenge
 * under the nose for a moustache — and the mouth is carved out of it.
 * beardGeo bakes the AO against min(beard, head), so the edge where the
 * shell lifts off the cheek sits in its own shadow.
 */
function beardField(kind) {
  const F = CANON;
  const S = faceStations(F);
  const jaw = F.rx * F.jaw;
  const HF = headField(F, '');
  const carves = [];
  const keeps = [];
  /** the head grown by `t` — t of relief everywhere, exactly */
  const shell = (t) => prim((x, y, z) => HF.d(x, y, z) - t,
    0, S.cy, 0.02, F.ry * 1.30 + t);

  /* 20 mm of relief on a 13.8 mm cell is a cell and a half — enough for
     surface nets to resolve two samples across the step, which is the
     minimum for the boundary to carry an edge rather than a colour. */
  const T_FULL = 0.021, T_STUBBLE = 0.016, T_TASH = 0.019;

  /* The jaw region. Half-width is 0.96 of the mandible, NOT 1.0: a beard
     that reaches the outline of the skull is a balaclava, and the shell
     is already following the head's own curve so it falls away at the
     sides on its own. */
  const jawBox = (top) => rbox([0, top - 0.30, 0.02],
    [jaw * 0.96 - 0.030, 0.30, F.rz * 1.10 - 0.030], 0.030);
  const mouthCut = () => carves.push({
    p: esph([0, S.mouthY, F.rz * 1.02], [0.046, 0.016, 0.062]), k: 0.012,
  });
  /* THE NOSE IS NOT PART OF THE BEARD. A jaw region that reaches the
     cheekbones necessarily contains the nose, and because the shell is
     the head offset the nose grew a 21 mm coat of hair and vanished:
     the review's face shot had eyes, a mouth and nothing between them.
     Carving a nose-shaped hole out of the beard is the only place this
     belongs — the region is a region, and the nose is a hole in it. */
  const noseCut = () => carves.push({
    p: esph([0, S.noseY + 0.050, F.rz * 1.06], [0.040, 0.050, 0.072]), k: 0.010,
  });
  /* the upper lip only — the band between the mouth hole and the nose */
  const tash = () => esph([0, (S.mouthY + S.noseY) * 0.5 + 0.008, F.rz * 0.94],
    [0.044, 0.014, 0.070]);

  switch (kind) {
    case 'none': case undefined: return null;
    case 'stubble':
      /* join 0.030, not 0.016. A `keep` is a smooth-max, so its join IS
         the softness of the beard's boundary: at 0.016 the shell ended
         in a step under one mesher cell wide and the edge read as a
         painted line however dark it was. 0.030 lets the layer thin out
         over two cells, which is what makes it hair lying on a cheek. */
      keeps.push({ prims: [jawBox(S.mouthY + 0.048)], join: 0.030 });
      mouthCut(); noseCut();
      return makeField([blob(PART.BEARD, [shell(T_STUBBLE)], 0.010, 0.020, 'head')], carves, keeps);
    case 'moustache':
      keeps.push({ prims: [tash()], join: 0.020 });
      return makeField([blob(PART.BEARD, [shell(T_TASH)], 0.010, 0.020, 'head')], carves, keeps);
    case 'goatee':
      keeps.push({
        prims: [tash(), esph([0, S.mouthY - 0.032, F.rz * 0.80], [0.036, 0.040, 0.062])],
        k: 0.024, join: 0.020,
      });
      mouthCut();
      return makeField([blob(PART.BEARD, [shell(T_FULL)], 0.010, 0.020, 'head')], carves, keeps);
    case 'full':
      /* join 0.030, not 0.016. A `keep` is a smooth-max, so its join IS
         the softness of the beard's boundary: at 0.016 the shell ended
         in a step under one mesher cell wide and the edge read as a
         painted line however dark it was. 0.030 lets the layer thin out
         over two cells, which is what makes it hair lying on a cheek. */
      keeps.push({ prims: [jawBox(S.mouthY + 0.048)], join: 0.030 });
      mouthCut(); noseCut();
      return makeField([blob(PART.BEARD, [shell(T_FULL)], 0.010, 0.020, 'head')], carves, keeps);
    default: return null;
  }
}

/* Glasses and hats are hard-surface objects, so they are built from
   tori and rounded boxes directly rather than from a field — a wire
   frame is exactly a swept circle and meshing it as a blob would round
   it into a doughnut of putty. */
function specsGeo(kind) {
  if (!kind || kind === 'none') return null;
  const F = CANON;
  const S = faceStations(F);
  const z = F.rz * 0.90;
  const eyeY = kind === 'halfmoon' ? S.eyeY - 0.013 : S.eyeY;
  const ex = S.eyeX * 1.06;
  const parts = [];
  const push = (g, part) => { g.userData.part = part; parts.push(g); };
  const rx = kind === 'thick' ? 0.046 : kind === 'square' ? 0.043 : 0.040;
  const ry = kind === 'halfmoon' ? 0.020 : kind === 'thick' ? 0.033 : 0.030;
  const th = kind === 'thick' ? 0.0068 : kind === 'square' ? 0.0050 : 0.0042;
  for (const s of [1, -1]) {
    const rim = new THREE.TorusGeometry(1, th, 7, kind === 'square' ? 4 : 22);
    if (kind === 'square') rim.rotateZ(Math.PI / 4);
    rim.scale(rx, ry, 1);
    rim.translate(ex * s, eyeY, z + 0.018);
    push(rim, PART.FRAME);
    /* THE LENS WAS THE GIANT WHITE EYE. An 80 x 60 mm opaque #CFE0E8
       disc, on a face whose lit skin tops out around #EFC9A8, standing
       in front of a 34 mm eye: every spectacle-wearer in the crowd read
       as a pair of enormous white eggs, which is what the review saw and
       blamed on the eyes themselves. Glass has no albedo — the only
       honest way to draw it in a two-band matte ramp with no
       transparency budget is not to. Rim, bridge and temple arms read as
       spectacles on their own, and the sculpted eye behind them is now
       the thing you actually see. */
    /* temple arm running back toward the ear */
    const t2 = new THREE.CylinderGeometry(th * 0.7, th * 0.7, 0.11, 5);
    t2.rotateX(Math.PI / 2);
    t2.rotateY(0.42 * s);
    t2.translate((ex + rx * 0.86) * s, eyeY + 0.008, z - 0.030);
    push(t2, PART.FRAME);
  }
  const span = Math.max(0.006, ex * 2 - rx * 1.8);
  const br = new THREE.CylinderGeometry(th * 0.8, th * 0.8, span, 5);
  br.rotateZ(Math.PI / 2);
  br.translate(0, eyeY + (kind === 'halfmoon' ? 0.002 : 0.004), z + 0.018);
  push(br, PART.FRAME);
  return mergeTagged(parts);
}

/**
 * Hats are hard-surface objects and are built as real geometry rather
 * than as a field: a brim is a disc and a crown is a cylinder, and
 * putting either through a smooth-min mesher rounds it into putty.
 *
 * Every one is placed against two numbers only — how far it stands
 * proud of the crown, and where its rim sits on the face — so a hat
 * cannot drift off the skull when a face shape changes the cranium.
 */
function hatGeo(kind) {
  if (!kind || kind === 'none') return null;
  const F = CANON;
  const S = faceStations(F);
  const parts = [];
  const push = (g, part) => { g.userData.part = part; parts.push(g); };
  const PHI = Math.PI * 0.62;
  const RIM = -Math.cos(PHI);                 // 0.366 of the half-height
  /** dome standing `t` proud of the crown with its rim at `rimY` */
  const dome = (t, rimY, seg = 20) => {
    const h = Math.max(0.03, (S.crown + t - rimY) / (1 + RIM));
    const g = new THREE.SphereGeometry(1, seg, 12, 0, Math.PI * 2, 0, PHI);
    g.scale(F.rx + t, h, F.rz + t);
    g.translate(0, S.crown + t - h, 0);
    return g;
  };
  const band = (t, y, h) => {
    const g = new THREE.CylinderGeometry(F.rx + t, F.rx + t, h, 22);
    g.scale(1, 1, (F.rz + t) / (F.rx + t));
    g.translate(0, y, 0);
    return g;
  };
  const brim = (outer, inner, y, h = 0.011) => {
    const g = new THREE.CylinderGeometry(inner, outer, h, 26, 1);
    g.scale(1, 1, 1.10);
    g.translate(0, y, 0);
    return g;
  };
  /** the forward peak of a cap or a visor */
  const peak = (y, len) => {
    const g = new THREE.CylinderGeometry(F.rx + 0.006, F.rx - 0.010, 0.010, 18, 1, false, -0.95, 1.9);
    g.scale(1, 1, len);
    g.translate(0, y, F.rz * 0.30);
    return g;
  };

  switch (kind) {
    case 'cap':
      push(dome(0.018, S.browY - 0.004), PART.HAT);
      push(peak(S.browY - 0.008, 1.55), PART.HATB);
      push(new THREE.SphereGeometry(0.012, 8, 6).translate(0, S.crown + 0.026, 0), PART.HATB);
      break;
    case 'flat':
      push(dome(0.012, S.hairline - 0.004, 22), PART.HAT);
      push(brim(F.rx + 0.058, F.rx + 0.016, S.hairline - 0.008, 0.012), PART.HATB);
      break;
    case 'beanie':
      push(dome(0.024, S.eyeY + 0.016), PART.HAT);
      push(band(0.028, S.eyeY + 0.030, 0.030), PART.HATB);
      push(new THREE.SphereGeometry(0.020, 10, 8).translate(0, S.crown + 0.042, 0), PART.HATC);
      break;
    case 'chef':
      push(band(0.012, S.hairline + 0.002, 0.050), PART.HATB);
      push(dome(0.034, S.hairline + 0.022, 22), PART.HAT);
      push(new THREE.SphereGeometry(1, 16, 10).scale(F.rx * 0.52, 0.036, F.rz * 0.52)
        .translate(0, S.crown + 0.064, 0), PART.HAT);
      break;
    case 'helm':
      push(dome(0.024, S.eyeY + 0.010), PART.HAT);
      push(new THREE.BoxGeometry(0.020, 0.030, (F.rz + 0.024) * 1.86)
        .translate(0, S.crown + 0.026, 0), PART.HATB);
      push(brim(F.rx + 0.046, F.rx + 0.020, S.eyeY + 0.008, 0.013), PART.HATB);
      break;
    case 'visor':
      push(band(0.020, S.browY + 0.004, 0.034), PART.HAT);
      push(peak(S.browY - 0.008, 1.55), PART.HATB);
      break;
    case 'beret': {
      const d = dome(0.030, S.hairline - 0.010, 22);
      d.rotateX(-0.18);
      d.translate(0, 0.006, -0.014);
      push(d, PART.HAT);
      push(new THREE.SphereGeometry(0.012, 8, 6).translate(0.010, S.crown + 0.032, -0.030), PART.HATB);
      break;
    }
    case 'fedora':
      push(dome(0.010, S.hairline + 0.004), PART.HAT);
      push(band(0.015, S.hairline + 0.014, 0.024), PART.HATB);
      push(brim(F.rx + 0.070, F.rx + 0.014, S.hairline, 0.011), PART.HAT);
      break;
    case 'bucket':
      push(dome(0.018, S.hairline - 0.002), PART.HAT);
      { const b = new THREE.CylinderGeometry(F.rx + 0.056, F.rx + 0.014, 0.032, 24, 1);
        b.scale(1, 1, 1.06); b.translate(0, S.hairline - 0.014, 0); push(b, PART.HATB); }
      break;
    case 'top':
      { const c3 = new THREE.CylinderGeometry(F.rx * 0.88, F.rx * 0.92, 0.140, 22, 1);
        c3.scale(1, 1, F.rz / F.rx); c3.translate(0, S.crown + 0.062, 0); push(c3, PART.HAT); }
      push(band(-F.rx * 0.08, S.crown + 0.006, 0.024), PART.HATB);
      push(brim(F.rx + 0.058, F.rx + 0.046, S.crown - 0.008, 0.012), PART.HAT);
      break;
    case 'crown': {
      const r = F.rx + 0.008;
      push(band(0.008, S.crown - 0.006, 0.030), PART.HATB);
      for (let i = 0; i < 6; i++) {
        const a = i / 6 * Math.PI * 2;
        const sp = new THREE.ConeGeometry(0.016, 0.050, 6);
        sp.translate(Math.sin(a) * r * 0.92, S.crown + 0.030, Math.cos(a) * (F.rz + 0.008) * 0.92);
        push(sp, PART.HAT);
      }
      break;
    }
    default: return null;
  }
  return mergeTagged(parts);
}

/* Eyes, brows and the mouth line — small, but they are the whole
   difference between a person and a mannequin, and they are what
   `mood` and `age` are for. */
function faceGeo(F, mood, age) {
  const S = faceStations(F);
  const parts = [];
  const push = (g, part, aoScale, aoStrength) => {
    g.userData.part = part;
    if (aoScale !== undefined) g.userData.aoScale = aoScale;
    if (aoStrength !== undefined) g.userData.aoStrength = aoStrength;
    parts.push(g);
  };
  /* MEASURE THE FACE, DO NOT GUESS AT IT. Every station here used to be
     a fraction of F.rz, and a fraction cannot know about the brow ridge
     or the socket carve: the brow came out 9 mm INSIDE the cranium on
     every one of the fourteen review figures, and the eyeball came out
     19 mm proud of a dished socket — a bead pressed into clay. So the
     head field is evaluated and the surface is found by bisection along
     z, and the features are seated against the number that comes back. */
  const HF = headField(F, mood);
  const surfZ = (x, y) => {
    let lo = 0, hi = F.rz * 1.5;
    if (HF.d(x, y, lo) > 0) return F.rz;           // off the face entirely
    for (let i = 0; i < 22; i++) {
      const m = (lo + hi) * 0.5;
      if (HF.d(x, y, m) < 0) lo = m; else hi = m;
    }
    return lo;
  };

  const eyeSurf = surfZ(S.eyeX, S.eyeY);
  /* THE EYE OCCLUDES THE LID AND THE LID OCCLUDES THE EYE. Sampled
     against the head alone, a sclera learns nothing about the fold
     sitting on top of it and a lid learns nothing about the ball under
     it — so neither carries the crease that is the entire difference
     between a sculpted eye and a decal. The pieces below add themselves
     to `occ` as they are built and the merge traces against
     min(head, everything), which is the same trick beardField uses. */
  const occ = [];
  const occField = (x, y, z) => {
    let v = HF.d(x, y, z);
    for (let i = 0; i < occ.length; i++) {
      const t = occ[i].d(x, y, z);
      if (t < v) v = t;
    }
    return v;
  };
  /* ---- HOW BIG AN EYE IS, MEASURED ----
     The old sclera was 47.6 x 34.4 mm on a 373 mm head, tinted #F4ECE2
     and covered by a lid that sat BEHIND it — so a bright oval a
     thirteenth of the whole head high stood proud of the face with a
     small dark dot in it. That is a googly eye, it is the loudest decal
     on the figure, and it is why a crowd of these could never stand next
     to a character who has no eyes at all.
     A lid can only hide a ball if its front face is in front of that
     ball's, so both lids now reach past the sclera and the visible
     aperture is what is left between their rims: 14 mm on a 34 mm ball,
     with a 20 mm iris filling almost all of it and two 7 mm slivers of
     (clay-valued, not white) sclera either side. That reads as an eye at
     a metre and as a soft dark almond at ten, which is exactly the
     behaviour of every other sculpted feature on this head. */
  const droop = age > 1 ? 0.0016 : 0;
  for (const s of [1, -1]) {
    const ez = eyeSurf - 0.0048;
    const w = new THREE.SphereGeometry(1, 14, 10);
    w.scale(0.0194, 0.0124, 0.0116);
    w.translate(S.eyeX * s, S.eyeY, ez);
    push(w, PART.EYEW, 0.94, 0.42);
    occ.push(esph([S.eyeX * s, S.eyeY, ez], [0.0194, 0.0124, 0.0116]));
    /* the iris nearly fills the aperture — the white is a sliver either
       side of it, never a field with a dot on it */
    const ir = new THREE.SphereGeometry(1, 12, 9);
    ir.scale(0.0096, 0.0098, 0.0086);
    ir.translate(S.eyeX * s + 0.0007 * s, S.eyeY - 0.0014, ez + 0.0046);
    push(ir, PART.IRIS, 0.86, 0.42);
    /* UPPER LID — a skin fold whose front face clears the sclera's, so
       it genuinely occludes rather than intersecting it. Its rim is the
       top of the aperture and it drops a shadow into it. The aperture
       between the two rims is 16 mm: any less and the lids meet, which
       is a figure with its eyes shut, not a sculpted eye. */
    const lid = new THREE.SphereGeometry(1, 16, 10);
    lid.scale(0.0248, 0.0136, 0.0168);
    lid.translate(S.eyeX * s, S.eyeY + 0.0214 - droop, ez - 0.0038);
    push(lid, PART.SKIN, 0.90);
    occ.push(esph([S.eyeX * s, S.eyeY + 0.0214 - droop, ez - 0.0038],
      [0.0248, 0.0136, 0.0168]));
    /* lower lid: the same trick, thinner, so the eye sits ON something */
    const low = new THREE.SphereGeometry(1, 14, 9);
    low.scale(0.0212, 0.0064, 0.0152);
    low.translate(S.eyeX * s, S.eyeY - 0.0182, ez - 0.0032);
    push(low, PART.SKIN, 0.92);
    occ.push(esph([S.eyeX * s, S.eyeY - 0.0182, ez - 0.0032], [0.0212, 0.0064, 0.0152]));
  }
  return mergeTagged(parts, occField);
}

/* ------------------------------------------------------------------
   Merge helper: a set of THREE geometries, each with userData.part,
   into one non-indexed-free geometry carrying a `part` Uint8 attribute.
   ------------------------------------------------------------------ */
function mergeTagged(list, aoField) {
  let nv = 0, ni = 0;
  for (const g of list) {
    nv += g.attributes.position.count;
    ni += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const part = new Uint8Array(nv);
  /* A hard-surface piece still has to occlude by the same law as the
     skin next to it or the two read as two different renderers — which
     is precisely how an eyeball ends up looking like a bead glued to a
     plate. Where an `aoField` is given (the head, for eyes / brows /
     spectacles / hats) the piece gets Wally's own cone trace against it,
     so an eye sits in the shadow of its socket and a brim darkens the
     brow beneath it. The sky term on top is the cheap approximation that
     still matters on a matte object: undersides go warm-dark.
     `aoScale` is how a part meant to sit INSIDE something buys itself
     the extra contact the trace cannot see. */
  const ao = new Float32Array(nv);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0, io = 0;
  for (const g of list) {
    if (!g.attributes.normal) g.computeVertexNormals();
    const p = g.attributes.position.array, n = g.attributes.normal.array;
    const c = g.attributes.position.count;
    pos.set(p.subarray(0, c * 3), vo * 3);
    nor.set(n.subarray(0, c * 3), vo * 3);
    part.fill(g.userData.part ?? 0, vo, vo + c);
    const k = g.userData.aoScale ?? 1;
    /* A piece that lives at the bottom of a hole traces every ray into
       an occluder and lands on the 0.36 floor whatever its albedo is —
       which turns a sculpted eye into a black socket, i.e. back into a
       decal by the other route. `aoStrength` lets a piece take the
       shadow of its surroundings at a fraction of full weight; it still
       gets the gradient, it just does not bottom out. */
    const as = g.userData.aoStrength ?? 1.0;
    const useField = aoField && g.userData.fieldAO !== false;
    for (let i = 0; i < c; i++) {
      let a = 0.80 + 0.20 * clamp(n[i * 3 + 1] * 0.5 + 0.5, 0, 1);
      if (useField) {
        a *= traceAO(aoField, p[i * 3], p[i * 3 + 1], p[i * 3 + 2],
          n[i * 3], n[i * 3 + 1], n[i * 3 + 2], as);
      }
      a *= k;
      ao[vo + i] = a < 0.36 ? 0.36 : a > 1 ? 1 : a;
    }
    if (g.index) {
      const gi2 = g.index.array;
      for (let i = 0; i < gi2.length; i++) idx[io + i] = gi2[i] + vo;
      io += gi2.length;
    } else {
      for (let i = 0; i < c; i++) idx[io + i] = i + vo;
      io += c;
    }
    vo += c;
    g.dispose();
  }
  blurAO(ao, idx, nv, 2);
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.userData.part = part;
  out.userData.ao = ao;
  return out;
}

/** Field -> geometry with part ids and baked AO.
 *  `opts.aoField` bakes the occlusion against a DIFFERENT field than the
 *  one that made the surface — which is the whole fix for hair and
 *  beards. A beard shell sampled against itself has no idea a face is
 *  underneath it, so its boundary against the skin comes out with no
 *  relief at all and reads as paint (§1.5). Sampled against
 *  min(beard, head) the edge sits in its own shadow and the underside of
 *  the jaw goes properly dark. */
function meshField(field, cell, aoStrength = 1.0, opts) {
  const m = surfaceNets(field.d, field.bounds, cell, opts);
  const nv = m.count;
  const part = new Uint8Array(nv);
  for (let i = 0; i < nv; i++) {
    part[i] = field.partAt(m.position[i * 3], m.position[i * 3 + 1], m.position[i * 3 + 2]).part;
  }
  /* A form that is smooth-unioned into the skull is skin as far as
     partAt is concerned — which is exactly what we want geometrically
     and exactly wrong for colour. Lips and brows are therefore tagged by
     the shapes that made them, after the fact: a vertex inside (or
     within a hair of) one of those shapes belongs to it. */
  /* TEST THE UNION, NOT THE PARTS. Testing each ball separately tags the
     caps and misses the waists between them — a smooth-min surface at
     the join of two overlapping balls stands up to k/4 outside BOTH of
     them — so a continuous brow came back as a row of dashes, which is
     the six-dot defect again wearing a different hat. */
  /* AND FADE, DO NOT SWITCH. A hard threshold on a field sampled at one
     vertex per 11 mm cell gives a stair-stepped, speckled boundary — a
     brow drawn with pinking shears. A brow does not have an outline;
     it thins out. `mix` carries how much of the tagged colour a vertex
     takes, over a 5 mm band, and buildHead lerps back toward skin. */
  const mix = new Float32Array(nv).fill(1);
  const retag = (shapes, id, eps, k, feather) => {
    if (!shapes || !shapes.length) return;
    const f = feather ?? 0.005;
    for (let i = 0; i < nv; i++) {
      const x = m.position[i * 3], y = m.position[i * 3 + 1], z = m.position[i * 3 + 2];
      let v = shapes[0].d(x, y, z);
      for (let j = 1; j < shapes.length; j++) v = smin(v, shapes[j].d(x, y, z), k);
      if (v >= eps + f) continue;
      part[i] = id;
      const t = clamp((eps + f - v) / f, 0, 1);
      mix[i] = t * t * (3 - 2 * t);
    }
  };
  retag(field.lipShapes, PART.LIP, 0.0010, 0.012, 0.0055);
  retag(field.browShapes, PART.BROW, 0.0016, 0.010, 0.0050);
  const ao = bakeAO(m.position, m.normal, nv, opts?.aoField || field.d, aoStrength, m.index);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
  g.setIndex(nv > 65535 ? new THREE.Uint32BufferAttribute(m.index, 1) : new THREE.Uint16BufferAttribute(m.index, 1));
  g.userData.part = part;
  g.userData.mix = mix;
  g.userData.ao = ao;
  g.userData.triangles = m.index.length / 3;
  return g;
}

/* ==================================================================
   8. The factory
   ================================================================== */

/** Deterministic spec for an anonymous city-dweller. */
export function randomSpec(rng, seedName = 'npc') {
  const pick = (a) => a[Math.floor(rng() * a.length) % a.length];
  const skins = Object.keys(HUMAN.skin);
  const faces = Object.keys(HUMAN.face);
  const hairs = ['bald', 'receding', 'buzz', 'short', 'side', 'quiff', 'bob', 'long',
    'wavy', 'locs', 'braids', 'pony', 'bun', 'afro', 'curly', 'mohawk', 'headscarf'];
  const hcols = Object.keys(HUMAN.hair);
  const beards = ['none', 'none', 'none', 'stubble', 'moustache', 'goatee', 'full'];
  const specs = ['none', 'none', 'none', 'round', 'square', 'halfmoon', 'thick'];
  const hats = ['none', 'none', 'none', 'none', 'cap', 'flat', 'beanie', 'bucket', 'visor', 'beret', 'fedora'];
  const hues = ['#4A7BC4', '#C4553D', '#3E8E8C', '#8A6C3E', '#5F9B58', '#B98CC0', '#D08A2B',
    '#6D8A3C', '#B4646E', '#7B5EA7', '#3E7BB0', '#C0518B', '#5A5148', '#2F8280'];
  return {
    id: seedName,
    n: '',
    skin: pick(skins), face: pick(faces),
    hair: pick(hairs), hairCol: pick(hcols),
    beard: rng() < 0.55 ? 'none' : pick(beards),
    specs: pick(specs), hat: pick(hats),
    hue: pick(hues),
    age: Math.floor(rng() * 3),
    mood: pick(['', 'warm', 'warm', 'stern']),
    /* ±16 % of girth and ±10 % of height, applied as bone scale on one
       shared mesh, is invisible: the review counted fourteen identical
       bells in a row. The range is now wide enough to matter and it
       picks one of three genuinely different bodies (BODY_SHAPES) rather
       than swelling a single one. */
    build: 0.78 + rng() * 0.52,
    stature: 0.88 + rng() * 0.26,
  };
}

/**
 * createHumans(ctx) — the shared caches, the shared material and the
 * one call that turns a spec into a person in the scene.
 */
export function createHumans(ctx) {
  const t0 = performance.now();
  /* BOOT PROFILER. This module was 63 % of a 13.9 s cold boot and every
     number in the rework below was read off this object, so it stays —
     a boot budget you cannot re-measure is a boot budget that grows
     back. It is a handful of performance.now() calls per character. */
  const T = {
    bodiesFine: 0, bodiesCoarse: 0, skin: 0,
    cacheMiss: 0, skel: 0, bodyCol: 0, head: 0, mesh: 0, n: 0,
    m: {},
  };
  const miss = (k, t) => { const e = T.m[k] || (T.m[k] = { n: 0, ms: 0 }); e.n++; e.ms += now() - t; };
  const now = () => performance.now();
  const q = ctx.quality || {};
  const tier = String(q.name || 'high').replace(/\(.*/, '');
  const CELL_BODY = tier === 'low' ? 0.030 : tier === 'med' ? 0.025 : 0.0215;
  const CELL_HEAD = tier === 'low' ? 0.017 : tier === 'med' ? 0.0136 : 0.0112;
  const CELL_HAIR = tier === 'low' ? 0.019 : tier === 'med' ? 0.016 : 0.0138;

  /* ---- the one material every human in the game shares ----
     Wally's clay, with his terminator numbers. The albedo is white and
     the whole palette rides in vColor, which is what makes fifty
     characters one draw call each and — more importantly — makes the
     shading law identical to his. §1.2 forbids an outline on clay and
     asks for the warm-grey shade tint, both inherited from clay(). */
  /* Kept as a named object, not written inline, so `fadeMaterial()`
     below can build a twin that is identical by construction rather
     than identical by somebody remembering to update both. */
  const CLAY_PARAMS = {
    name: 'npc.clay',
    color: 0xffffff,
    vertexColors: true,
    /* WALLY'S GRAIN, NOT A QUIETER ONE. §1.2 calls the velvet grain
       non-negotiable and it is what separates clay from plastic, so a
       human standing next to him may not carry two thirds of it at a
       tenth finer a scale: at 10.6 / 0.052 the shirt read smooth beside
       a flank that read woven, which is a material mismatch and reads as
       a different renderer. These are his numbers verbatim. */
    grain: 0.00046,
    grainScale: 9.4,
    grainAlbedo: 0.066,
    grainShade: 0.34,
    grainFade: [16, 66],
    sss: 0.17,
    /* §2.2's two-band ramp, aimed at a head rather than at a sphere.
       Wally's 0.18/0.055 lands his terminator at 0.29 of the cranium
       radius, which is where a 0.556 m ball is genuinely turning. A
       0.30 m human head with a jaw, a brow and eye sockets in it has
       far less curvature to spare, and at 0.18 the boundary sat on the
       flat of the cheek and broke into hard-edged patches. 0.13 pushes
       it out to 0.36 R and the wider soft band spans the wander. */
    /* 0.16, not 0.13 — a step back toward Wally's 0.18 now that there is
       something for the band to travel across. The old number was set
       against a face that WAS a plane: with no brow, no malar and no
       chin the boundary had no gradient to lock onto and had to be
       pushed out onto the limb to stop it blotching. The sculpt above
       gives it curvature everywhere, so it can come back in to where the
       surface is genuinely turning and the three tones read. */
    term: 0.16,
    bandSoft: 0.060,
    band2: 0.13,
    core: 0.79,
    coreSoft: 0.11,
    shadowAmount: 0.50,
    shadowValue: 0.66,
    shadowBleed: 0.10,
    shadowFill: 0.030,
    skyBounce: 0.10,
    shadowStrength: 0.30,
    shadowTint: CLAY.bodyAO,
    ao: 1.0,
  };
  const material = ctx.mat.clay(CLAY_PARAMS);

  /* ---- bodies: one mesh per BODY_SHAPE, attributes shared by
     reference between every character that wears that shape.

     The hands are meshed separately at CELL_HAND and appended: four
     digits at a 12 mm radius are under one body cell and come out of the
     mesher as a paddle no matter what the join is. Everything after the
     append — the weight pass, bodyColors, the shared attributes — treats
     the result as one array, which is why this costs nothing but the
     mesher time. */
  const CELL_HAND = tier === 'low' ? 0.0150 : tier === 'med' ? 0.0120 : 0.0098;
  const nShapes = tier === 'low' ? 1 : tier === 'med' ? 2 : 3;
  const shapeList = nShapes === 3 ? BODY_SHAPES
    : nShapes === 2 ? [BODY_SHAPES[0], BODY_SHAPES[2]]
      : [BODY_SHAPES[1]];

  /** concat a list of meshField outputs into one set of shared arrays */
  function mergeBody(list) {
    let nv = 0, ni = 0;
    for (const g of list) { nv += g.attributes.position.count; ni += g.index.count; }
    const pos = new Float32Array(nv * 3);
    const nor = new Float32Array(nv * 3);
    const part = new Uint8Array(nv);
    const ao = new Float32Array(nv);
    const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
    let vo = 0, io = 0, tris = 0;
    for (const g of list) {
      const c = g.attributes.position.count;
      pos.set(g.attributes.position.array.subarray(0, c * 3), vo * 3);
      nor.set(g.attributes.normal.array.subarray(0, c * 3), vo * 3);
      part.set(g.userData.part.subarray(0, c), vo);
      ao.set(g.userData.ao.subarray(0, c), vo);
      const gi = g.index.array;
      for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
      io += gi.length; vo += c; tris += gi.length / 3;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    out.userData.part = part;
    out.userData.ao = ao;
    out.userData.triangles = tris;
    out.computeBoundingSphere();
    return out;
  }

  const names = BONES.map((b) => b.name);
  const caps = names.map((n) => CAP[n] || null);
  const _cd = new Float32Array(names.length);

  /** capture-volume skin weights for one body's vertices */
  function skinFor(posArr, nvB) {
    const _t = now();
    const skinIdx = new Uint16Array(nvB * 4);
    const skinW = new Float32Array(nvB * 4);
    for (let v = 0; v < nvB; v++) {
      const x = posArr[v * 3], y = posArr[v * 3 + 1], z = posArr[v * 3 + 2];
      let b0 = -1, d0 = 1e9;
      for (let i = 0; i < names.length; i++) {
        if (!caps[i]) { _cd[i] = 1e9; continue; }
        const dd = capDist(caps[i], x, y, z);
        _cd[i] = dd;
        if (dd < d0) { d0 = dd; b0 = i; }
      }
      if (b0 < 0) { b0 = BONE_INDEX.hips; d0 = 0; }
      /* the runner-up may only be a bone within two hops of the winner */
      let b1 = -1, d1 = 1e9;
      const nb = names.length;
      for (let i = 0; i < nb; i++) {
        if (i === b0 || _cd[i] >= 1e9) continue;
        if (BONE_DIST[b0 * nb + i] > 2) continue;
        if (_cd[i] < d1) { d1 = _cd[i]; b1 = i; }
      }
      /* Blend the two nearest over a 45 mm band. Wider than that and a
         knee bends like a garden hose; narrower and the seam creases. */
      const band = 0.045;
      const w1 = b1 >= 0 ? clamp(1 - (d1 - d0) / band, 0, 1) * 0.5 : 0;
      skinIdx[v * 4] = b0; skinW[v * 4] = 1 - w1;
      skinIdx[v * 4 + 1] = b1 >= 0 ? b1 : b0; skinW[v * 4 + 1] = w1;
    }
    T.skin += now() - _t;
    return {
      i: new THREE.Uint16BufferAttribute(skinIdx, 4),
      w: new THREE.Float32BufferAttribute(skinW, 4),
    };
  }

  /* ---- DETAIL TIERS ----
     Twenty-four named clients are the only people in this game you ever
     stand a metre from: you walk up to them, the prompt appears, the
     camera frames their head. The other ~377 are street traffic that
     passes at two to forty metres. Meshing both at the same cell put
     34 000 triangles on every one of them — as many as Wally, the hero,
     carries — and with four shadow cascades on top that is 170 000
     triangles per pedestrian. The sculpt below is identical for both;
     only the grid it is sampled on changes. `coarse` is 1.40x on the
     body and 1.38x on the head, which halves the count and is invisible
     past about two metres because surface nets puts its vertices ON the
     iso-surface and takes its normals from the analytic gradient —
     resolution here buys silhouette, not smoothness. */
  const COARSE = { body: 1.40, hand: 1.30, head: 1.38, hair: 1.34 };
  const buildBodies = (mul) => shapeList.map((S) => {
    /* WALLY'S PASS COUNTS, NOT HALF OF THEM. model.js runs two
       de-ripple passes and three normal passes over its body and that is
       what makes a smooth-min seam disappear under a two-band ramp; the
       body here was running one and three, so every blend on the flank
       still carried the dual-contouring corrugation the ramp magnifies
       into a hard-edged patch. Two and four costs 90 ms once, for three
       cached bodies, and is the difference between clay and shrink-wrap.
       AO strength 1.22 is his 1.16 plus a little, because a clothed
       figure has seams a naked elephant does not (§1.2: every crease). */
    const src = mergeBody([
      meshField(bodyField(S), CELL_BODY * mul.body, 1.22, { relax: 2, normalPasses: 4 }),
      meshField(handField(1, S), CELL_HAND * mul.hand, 1.05, { relax: 2, normalPasses: 4 }),
      meshField(handField(-1, S), CELL_HAND * mul.hand, 1.05, { relax: 2, normalPasses: 4 }),
    ]);
    const pos = src.attributes.position;
    const nv = pos.count;
    const y = new Float32Array(nv);
    for (let i = 0; i < nv; i++) y[i] = pos.array[i * 3 + 1];
    const sk = skinFor(pos.array, nv);
    return {
      S, src, nv, y,
      part: src.userData.part, ao: src.userData.ao,
      pos, nor: src.attributes.normal, idx: src.index,
      skinI: sk.i, skinW: sk.w,
    };
  });
  /* THE BODY CACHE IS BUILT WHEN A BODY IS FIRST ASKED FOR, NOT AT
     STARTUP. Six meshed bodies (three shapes, two detail tiers) were
     900 ms of a boot that had not yet placed a single person, and the
     tier a run actually needs depends on who it builds first: a boot
     that only stands the nearby named clients up never needs the coarse
     set at all until the crowd streams in, a second later, off the
     critical path. */
  const BODIES = {};
  function bodySet(detail) {
    let list = BODIES[detail];
    if (!list) {
      const _tb = now();
      list = BODIES[detail] = detail === 'coarse'
        ? buildBodies({ body: COARSE.body, hand: COARSE.hand })
        : buildBodies({ body: 1, hand: 1 });
      if (detail === 'coarse') T.bodiesCoarse = now() - _tb; else T.bodiesFine = now() - _tb;
    }
    return list;
  }
  /** pick the cached body whose own girth is closest to this spec */
  function bodyFor(build, detail) {
    const list = bodySet(detail === 'coarse' ? 'coarse' : 'fine');
    let best = list[0], bd = 1e9;
    for (const b of list) {
      const d = Math.abs(b.S.g - build);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  /* ---- lazy caches ---- */
  const cHead = new Map(), cHair = new Map(), cBeard = new Map();
  const cSpecs = new Map(), cHat = new Map(), cFace = new Map();
  const built = [];
  const remember = (g) => { if (g) built.push(g); return g; };

  /* EXPRESSION IS SUB-CELL ON A PEDESTRIAN. `mood` moves the mouth
     slit's corners by 6-12 mm and tilts the brow roll by up to 9 mm;
     `age` moves the lid and the nasolabial fold by less again. The
     coarse tier samples the head on a 15.5 mm grid, so every one of
     those offsets is under one cell and the mesh that comes back is the
     same mesh. Keying the coarse caches on them meshed eighteen head
     shells and fifty-four face sets to produce six and six distinct
     results — 1.1 s of a boot spent on differences that cannot exist in
     the output. The named clients are meshed fine and looked at from a
     metre, and they keep every one of them. */
  const moodFor = (mood, detail) => (detail === 'coarse' ? '' : (mood || ''));

  const headGeo = (face, mood, detail) => {
    const key = face + '|' + moodFor(mood, detail) + '|' + detail;
    if (!cHead.has(key)) {
      const _t = now();
      const cell = CELL_HEAD * (detail === 'coarse' ? COARSE.head : 1);
      /* The face is the one surface a player ever gets within a metre
         of, and a two-band ramp on a nearly-flat cheek breaks into a
         hard-edged patch wherever the normal field still carries a
         millimetre of blend ripple. Two relaxation passes and five
         normal passes cost 40 ms per cached face shape and are the
         difference between clay and faceted plastic. */
      cHead.set(key, remember(meshField(
        headField(HUMAN.face[face] || CANON, moodFor(mood, detail)), cell, 1.22,
        { relax: 2, normalPasses: 5 })));
      T.cacheMiss += now() - _t; miss('head.' + detail, _t);
    }
    return cHead.get(key);
  };
  /* The canonical cranium, as a field. Hair and beards are shells that
     lie ON it, and a shell sampled for AO against only itself learns
     nothing about the face underneath — which is why the review found
     the hairline and the beard boundary reading as flat paint with a
     razor edge. Occluding them against min(shell, head) puts the edge in
     its own shadow, the way §1.5 requires a sculpted feature to be. */
  const canonHead = headField(CANON, '');
  const shellAO = (f) => (x, y, z) => Math.min(f.d(x, y, z), canonHead.d(x, y, z));

  const hairGeo = (style, detail) => {
    const key = style + '|' + detail;
    if (!cHair.has(key)) {
      const _t = now();
      const f = hairField(style);
      const cell = CELL_HAIR * (detail === 'coarse' ? COARSE.hair : 1);
      cHair.set(key, f
        ? remember(meshField(f, cell, 1.20, { relax: 2, normalPasses: 4, aoField: shellAO(f) }))
        : null);
      T.cacheMiss += now() - _t; miss('hair.' + detail, _t);
    }
    return cHair.get(key);
  };
  const beardGeo = (kind, detail) => {
    const key = kind + '|' + detail;
    if (!cBeard.has(key)) {
      const _t = now();
      const f = beardField(kind);
      const cell = CELL_HAIR * (detail === 'coarse' ? COARSE.hair : 1);
      cBeard.set(key, f
        ? remember(meshField(f, cell, 1.32, { relax: 2, normalPasses: 4, aoField: shellAO(f) }))
        : null);
      T.cacheMiss += now() - _t; miss('beard.' + detail, _t);
    }
    return cBeard.get(key);
  };
  const specsGeoC = (k) => {
    if (!cSpecs.has(k)) { const _t = now(); cSpecs.set(k, remember(specsGeo(k))); T.cacheMiss += now() - _t; miss('specs', _t); }
    return cSpecs.get(k);
  };
  const hatGeoC = (k) => {
    if (!cHat.has(k)) { const _t = now(); cHat.set(k, remember(hatGeo(k))); T.cacheMiss += now() - _t; miss('hat', _t); }
    return cHat.get(k);
  };
  /* `age` survives into the coarse tier and `mood` does not, and the
     difference is not taste. Mood is a 3 mm push on a surface sampled
     every 15.5 mm — measured, over three face shapes: mean 0.03 mm,
     worst 4.7 mm, not one vertex moved by a whole cell. Age moves the
     lid, the fold and the brow as separate pieces of geometry, at the
     scale you can see across a street, and it is one of the eleven axes
     the crowd's variety is made of. What must not happen is the two
     disagreeing: these features are seated by bisection against the head
     field, so faceGeo is handed exactly the mood its shell was meshed
     with. */
  const faceGeoC = (face, mood, age, detail) => {
    const m = moodFor(mood, detail);
    const a = age;
    const key = face + '|' + m + '|' + a;
    if (!cFace.has(key)) {
      const _t = now();
      cFace.set(key, remember(faceGeo(HUMAN.face[face] || CANON, m, a)));
      T.cacheMiss += now() - _t; miss('face', _t);
    }
    return cFace.get(key);
  };

  /* ------------------------------------------------------------
     Colour resolution — spec + part id -> vColor
     ------------------------------------------------------------ */
  function palette(spec, rng) {
    const sk = HUMAN.skin[spec.skin] || HUMAN.skin.warm;
    const hc = HUMAN.hair[spec.hairCol] ?? HUMAN.hair.brown;
    const shirt = srgb(hexOf(spec.hue || 0x5e6880));
    const neutral = HUMAN.neutral[Math.floor(rng() * HUMAN.neutral.length)];
    /* 0.78 toward one of seven near-identical slates gave a crowd whose
       legs were all the same mud. Pulling almost all the way to the
       neutral and then lightening a third of them puts denim, khaki and
       charcoal in the same street. */
    const trouser = rng() < 0.26
      ? shade(neutral, 0.20 + rng() * 0.20)
      : mixCol(shirt, neutral, 0.90);
    const shoeC = noBlack(srgb(HUMAN.shoe[Math.floor(rng() * HUMAN.shoe.length)]));
    const hat = HUMAN.hat[spec.hat] || HUMAN.hat.cap;
    return {
      skin: srgb(sk.b),
      skinS: srgb(sk.s),
      skinD: srgb(sk.d),
      hair: noBlack(srgb(hc)),
      hairDk: noBlack(shade(hc, -0.20)),
      /* A beard takes the light differently from a scalp and it is the
         one hair surface a player gets within a metre of, so it carries a
         touch of the skin's own deep tone rather than the scalp's flat
         dark — and it is floored so it can never render as a black hole
         in the middle of a face (§7). */
      beard: noBlack(mixCol(hc, sk.d, 0.20), 0.038),
      brow: noBlack(mixCol(shade(hc, -0.20), sk.s, 0.24), 0.034),
      shirt,
      shirtDk: shade(hexOf(spec.hue || 0x5e6880), -0.28),
      trouser,
      shoe: shoeC,
      hatA: srgb(hat.a),
      hatB: srgb(hat.b),
      hatC: shade(hat.a, 0.20),
      frame: srgb(HUMAN.specFrame),
      lens: srgb(HUMAN.specLens),
      /* THE SCLERA IS PITCHED AGAINST THE FACE IT IS IN. A fixed pale
         value is fine on porcelain and catastrophic on `ebony`: #DFD5C8
         against a #4E3020 cheek is a four-fold luminance step inside a
         25 mm feature, and the two-band ramp then draws it as a pair of
         white eggs — the googly-eye read that survived shrinking the
         eyeball twice. Mixing over half way toward this skin's own LIT
         tone keeps the eye a light form on every face and a beacon on
         none, which is the same reasoning §1.2 applies to Wally's tusks:
         they are the brightest thing on him and they still sit inside
         the clay's range. */
      eyeW: mixCol(srgb(HUMAN.eyeWhite), srgb(sk.l), 0.58),
      iris: srgb(HUMAN.eye),
      /* A LIP IS A FORM, NOT A COLOUR. At 0.34 toward #9E5A50 the two
         pads plus the carved slit rendered as one brown blotch in the
         middle of the face — the drawn arc §1.5 forbids, in paint this
         time. The pads are already sculpted and already carry their own
         AO; the tint only has to say "this is not cheek". */
      lip: mixCol(sk.s, 0x9e5a50, 0.10),
      /* Sleeve, hem, collar and boot top are per-person, which is the
         whole point of resolving colour late: a crowd where everyone's
         shirt stops at the same millimetre reads as a uniform.

         `sleeve` IS A HEIGHT, NOT A LENGTH, and the first pass had the
         sense of it inverted — 1.06 leaves the shirt on the upper arm
         only, i.e. a T-shirt, and two thirds of the crowd came out in
         short sleeves with a pale skin stripe running from the shoulder
         to a mitten. Most people wear long sleeves. */
      sleeve: (() => { const r = rng(); return r < 0.72 ? 0.795 : r < 0.88 ? 0.95 : 1.10; })(),
      hem: rng() < 0.16 ? 0.62 : 0.985,
      collar: 1.238,
      bootTop: 0.11 + rng() * 0.11,
      cuff: rng() < 0.35,
    };
  }

  /* ---- THE SEAM IS A CREASE, AND A CREASE IS AO ----
     Sleeve, hem, collar and boot-top are colour changes on one
     continuous surface, so they arrive as razor lines with identical
     shading either side: a decal, which is the exact charge §1.5 lays
     against a drawn feature. A real cuff sits in its own shadow. The
     baked AO cannot know where a hem is — it is resolved per person,
     long after the mesh — so the dip is applied here, where the height
     of every vertex and this person's garment stations are both in
     hand. 14 mm wide, 22 % deep, smooth: the same soft-and-wide law
     §1.2 states for clay, not a hard contact line. */
  const SEAM_W = 0.014;
  function seamAO(y, stations) {
    let k = 1;
    for (let i = 0; i < stations.length; i++) {
      const d = Math.abs(y - stations[i]) / SEAM_W;
      if (d < 1) k *= 1 - 0.22 * (1 - d * d) * (1 - d * d);
    }
    return k;
  }

  function bodyColors(B, pal) {
    const n = B.nv;
    const bodyPart = B.part, bodyY = B.y, bodyAO = B.ao;
    const arr = new Float32Array(n * 4);
    const torsoSeams = [pal.collar, pal.hem];
    const armSeams = [pal.sleeve];
    const legSeams = [pal.bootTop];
    for (let i = 0; i < n; i++) {
      const p = bodyPart[i], y = bodyY[i];
      let c;
      switch (p) {
        case PART.NECK: c = pal.skin; break;
        case PART.HAND: c = pal.skin; break;
        case PART.FOOT: c = pal.shoe; break;
        case PART.ARM:
          c = y > pal.sleeve
            ? (pal.cuff && y < pal.sleeve + 0.030 ? pal.shirtDk : pal.shirt)
            : pal.skin;
          break;
        case PART.LEG: c = y < pal.bootTop ? pal.shoe : pal.trouser; break;
        default:
          /* Collar and belt: two 26-30 mm bands in the shirt's own dark.
             They are the whole difference between a dressed figure and a
             two-colour sock puppet, and they cost nothing — the shared
             mesh already carries the height of every vertex. */
          c = y > pal.collar ? pal.shirtDk
            : y > pal.hem ? pal.shirt
              : (y > pal.hem - 0.030 ? pal.shirtDk : pal.trouser);
      }
      let a = bodyAO[i];
      if (p === PART.ARM) a *= seamAO(y, armSeams);
      else if (p === PART.LEG) a *= seamAO(y, legSeams);
      else if (p === PART.TORSO) a *= seamAO(y, torsoSeams);
      arr[i * 4] = c.r; arr[i * 4 + 1] = c.g; arr[i * 4 + 2] = c.b;
      arr[i * 4 + 3] = a;
    }
    return new THREE.Float32BufferAttribute(arr, 4);
  }

  function partColor(p, pal) {
    switch (p) {
      case PART.SKIN: case PART.NECK: case PART.NOSE: return pal.skin;
      case PART.EAR: return pal.skinS;
      case PART.LIP: return pal.lip;
      case PART.EYEW: return pal.eyeW;
      case PART.IRIS: return pal.iris;
      case PART.BROW: return pal.brow;
      case PART.HAIR: return pal.hair;
      case PART.HAIRDK: return pal.hairDk;
      case PART.BEARD: return pal.beard;
      case PART.FRAME: return pal.frame;
      case PART.LENS: return pal.lens;
      case PART.HAT: return pal.hatA;
      case PART.HATB: return pal.hatB;
      case PART.HATC: return pal.hatC;
      default: return pal.skin;
    }
  }

  /* Merge the head pieces a character actually wears into one geometry,
     mapping the canonical-cranium pieces onto this face shape. */
  function buildHead(spec, pal, detail) {
    const F = HUMAN.face[spec.face] || CANON;
    const cy = PROP.headC;
    const sx = F.rx / CANON.rx, sy = F.ry / CANON.ry, sz = F.rz / CANON.rz;
    const pieces = [];
    const add = (g, warp) => { if (g) pieces.push({ g, warp }); };
    add(headGeo(spec.face, spec.mood, detail), false);
    add(faceGeoC(spec.face, spec.mood, spec.age | 0, detail), false);
    add(hairGeo(spec.hair, detail), true);
    add(beardGeo(spec.beard, detail), true);
    add(specsGeoC(spec.specs), true);
    add(hatGeoC(spec.hat), true);

    /* Where the hat's rim sits, so the skin under it can be darkened.
       The head field knows nothing about hats — it is meshed once per
       face shape and cached — so without this the brim floats: a hat is
       only convincingly ON a head when the head is darker under it. */
    let hatRim = Infinity;
    {
      const hg = hatGeoC(spec.hat);
      if (hg) {
        const a = hg.attributes.position.array;
        const pt = hg.userData.part;
        for (let i = 0; i < hg.attributes.position.count; i++) {
          if (pt[i] === PART.HAT || pt[i] === PART.HATB) {
            const y = cy + (a[i * 3 + 1] - cy) * sy;
            if (y < hatRim) hatRim = y;
          }
        }
      }
    }

    /* THE HAIRLINE IS A CREASE AND IT HAS TO CARRY AO. Hair is meshed
       once per style against the canonical cranium; the head is meshed
       once per face shape and knows nothing about it. So the boundary
       arrived with identical shading on both sides — a razor line
       between two flat colours, which is a decal by §1.5's definition
       whatever the geometry underneath is doing. hairGeo's own AO field
       already darkens the hair side (shellAO); this is the skin side.
       The front rim is measured off the cached mesh in the same way the
       hat rim is, and the band beneath it takes 26 % — soft and wide,
       per §1.2, never a contact line. */
    let hairRim = Infinity;
    {
      const hg = hairGeo(spec.hair, detail);
      if (hg) {
        const a = hg.attributes.position.array;
        const n = hg.attributes.position.count;
        for (let i = 0; i < n; i++) {
          const z = a[i * 3 + 2] * sz;
          if (z < F.rz * 0.42) continue;                  // frontal vertices only
          if (Math.abs(a[i * 3] * sx) > F.rx * 0.62) continue;
          const y = cy + (a[i * 3 + 1] - cy) * sy;
          if (y < hairRim) hairRim = y;
        }
      }
    }

    let nv = 0, ni = 0;
    for (const p of pieces) { nv += p.g.attributes.position.count; ni += p.g.index.count; }
    const pos = new Float32Array(nv * 3);
    const nor = new Float32Array(nv * 3);
    const col = new Float32Array(nv * 4);
    const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
    let vo = 0, io = 0;
    for (const p of pieces) {
      const gp = p.g.attributes.position.array;
      const gn = p.g.attributes.normal.array;
      const c = p.g.attributes.position.count;
      const part = p.g.userData.part;
      const pmix = p.g.userData.mix;
      const ao = p.g.userData.ao;
      const inx = 1 / sx, iny = 1 / sy, inz = 1 / sz;
      for (let i = 0; i < c; i++) {
        let x = gp[i * 3], y = gp[i * 3 + 1], z = gp[i * 3 + 2];
        let nxv = gn[i * 3], nyv = gn[i * 3 + 1], nzv = gn[i * 3 + 2];
        if (p.warp) {
          /* the cached piece was built on the round cranium; map it onto
             this one about the head centre. Normals take the inverse
             transpose, which for a diagonal map is the reciprocal. */
          x *= sx; y = cy + (y - cy) * sy; z *= sz;
          nxv *= inx; nyv *= iny; nzv *= inz;
          const l = Math.hypot(nxv, nyv, nzv) || 1;
          nxv /= l; nyv /= l; nzv /= l;
        }
        pos[(vo + i) * 3] = x; pos[(vo + i) * 3 + 1] = y; pos[(vo + i) * 3 + 2] = z;
        nor[(vo + i) * 3] = nxv; nor[(vo + i) * 3 + 1] = nyv; nor[(vo + i) * 3 + 2] = nzv;
        let cc = partColor(part[i], pal);
        if (pmix && pmix[i] < 0.999) {
          cc = _mix.copy(pal.skin).lerp(cc, pmix[i]);
        }
        let a = ao[i];
        if (hatRim < Infinity && y < hatRim && y > hatRim - 0.085
          && part[i] !== PART.HAT && part[i] !== PART.HATB && part[i] !== PART.HATC) {
          a *= lerp(0.62, 1, clamp((hatRim - y) / 0.085, 0, 1));
        }
        if (hairRim < Infinity && (part[i] === PART.SKIN || part[i] === PART.BROW)
          && z > 0 && y < hairRim + 0.006 && y > hairRim - 0.052) {
          const t = clamp((hairRim + 0.006 - y) / 0.058, 0, 1);
          a *= lerp(0.74, 1, t * t * (3 - 2 * t));
        }
        col[(vo + i) * 4] = cc.r; col[(vo + i) * 4 + 1] = cc.g; col[(vo + i) * 4 + 2] = cc.b;
        col[(vo + i) * 4 + 3] = a;
      }
      const gi2 = p.g.index.array;
      for (let i = 0; i < gi2.length; i++) idx[io + i] = gi2[i] + vo;
      io += gi2.length; vo += c;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    /* the head geometry is authored in world-standing space and hangs
       off the head bone, so shift it into that bone's frame */
    const hw = BONES[BONE_INDEX.head].w;
    g.translate(-hw[0], -hw[1], -hw[2]);
    g.computeBoundingSphere();
    return g;
  }

  const _tmpGeos = [];

  /**
   * Turn a spec into a person. Returns the pieces the animator and the
   * NPC module need; the caller adds `root` to the scene.
   */
  function build(spec, seed, detail = 'fine') {
    T.n++;
    let _t = now();
    const rng = ctx.makeRng(seed || ('human.' + (spec.id || 'x')));
    const pal = palette(spec, rng);

    const rig = buildSkeleton();
    const root = new THREE.Group();
    root.name = 'npc.' + (spec.id || 'x');
    root.add(rig.rootBone);
    T.skel += now() - _t; _t = now();

    const B = bodyFor(spec.build ?? 1, detail);
    const bodyGeo = new THREE.BufferGeometry();
    bodyGeo.setAttribute('position', B.pos);
    bodyGeo.setAttribute('normal', B.nor);
    bodyGeo.setAttribute('skinIndex', B.skinI);
    bodyGeo.setAttribute('skinWeight', B.skinW);
    bodyGeo.setAttribute('color', bodyColors(B, pal));
    bodyGeo.setIndex(B.idx);
    bodyGeo.boundingSphere = B.src.boundingSphere;
    T.bodyCol += now() - _t; _t = now();

    const body = new THREE.SkinnedMesh(bodyGeo, material);
    body.name = root.name + '.body';
    body.castShadow = true;
    body.receiveShadow = true;
    /* npc.js does its own distance + frustum culling on the root, and a
       skinned mesh's bind-pose bounding sphere is the wrong shape once
       an arm goes up — leave three's culler out of it */
    body.frustumCulled = false;
    root.add(body);
    root.updateMatrixWorld(true);
    body.bind(rig.skeleton);
    T.mesh += now() - _t; _t = now();

    const headG = buildHead(spec, pal, detail);
    T.head += now() - _t;
    _tmpGeos.push(headG);
    const head = new THREE.Mesh(headG, material);
    head.name = root.name + '.head';
    head.castShadow = true;
    head.receiveShadow = true;
    head.frustumCulled = false;
    rig.byName.head.add(head);

    /* Girth is carried by the CACHED BODY now, so what is left for the
       bones is only the residual between this person's build and the
       shape they were given — a few per cent, well inside what a shared
       skin can take without creasing at the joints. Stature stays a
       uniform scale on the root. */
    const b = clamp((spec.build ?? 1) / B.S.g, 0.90, 1.12);
    const st = clamp(spec.stature ?? 1, 0.86, 1.16);
    rig.byName.hips.scale.set(b, 1, b);
    rig.byName.spine.scale.set(1 + (b - 1) * 0.8, 1, 1 + (b - 1) * 0.8);
    rig.byName.chest.scale.set(1 + (b - 1) * 0.6, 1, 1 + (b - 1) * 0.6);
    root.scale.setScalar(st);

    return {
      spec, root, body, head, pal,
      bones: rig.bones, byName: rig.byName, skeleton: rig.skeleton,
      height: H * st,
      dispose() {
        bodyGeo.dispose();
        headG.dispose();
        root.removeFromParent();
      },
    };
  }

  /* ================================================================
     THE FADE MATERIAL — one person dissolving, and nobody else.

     A character who "leaves mysteriously" has to stop being there in a
     way that reads as INTENDED. Hiding the object is a despawn and the
     eye catches it every time; walking them past a wall needs a wall.
     A dissolve is the honest answer, and the whole population shares a
     single opaque clay material, so it needs a second one — identical
     in every shading term, transparent, with the alpha on a uniform.

     WHY NOT `opacity`. toon.js has one, but the population's geometry
     carries a FOUR-component colour attribute (rgb = the palette,
     alpha = the baked cone-traced AO), so three compiles the shader
     with USE_COLOR_ALPHA and `tex *= vColor` multiplies the material
     opacity by the AO. Fading through that path would make the creases
     transparent first: a person dissolving from the inside out, which
     is a special effect nobody asked for. So the final write takes
     `uFade` directly and leaves tex.a alone.

     The shading is otherwise bit-identical because the parameters are
     the same object, and toon.js hands out the sun/ambient/shadow
     uniforms BY REFERENCE from its globals — so the twin tracks the
     time of day, the weather and the grade with no extra plumbing.

     It is built on first use. Most sessions never need it.
     ================================================================ */
  let fadeMat = null;
  function fadeMaterial() {
    if (fadeMat) return fadeMat;
    fadeMat = ctx.mat.clay({ ...CLAY_PARAMS, name: 'npc.clay.fade', transparent: true });
    const MARK = 'gl_FragColor = vec4( col, tex.a );';
    if (fadeMat.fragmentShader.indexOf(MARK) < 0) {
      console.warn('[humans] toon.js output line moved; the fade will not fade');
      return fadeMat;
    }
    fadeMat.uniforms.uFade = { value: 1 };
    fadeMat.fragmentShader = 'uniform float uFade;\n'
      + fadeMat.fragmentShader.replace(MARK, 'gl_FragColor = vec4( col, tex.a * uFade );');
    fadeMat.needsUpdate = true;
    return fadeMat;
  }

  const buildMs = +(performance.now() - t0).toFixed(1);

  return {
    material, build, palette, randomSpec, PART, HUMAN, H, PROP, BONES, BONE_INDEX,
    /** The transparent twin of `material`, for a character who has to
        stop being there on purpose. Its alpha is uniforms.uFade. */
    fadeMaterial,
    stats: {
      /* getters, because the body caches are lazy now — reading these
         before anyone has been built would otherwise force the very
         work the laziness exists to defer. */
      get bodyTriangles() { return BODIES.fine ? BODIES.fine[0].src.userData.triangles : 0; },
      get bodyTrianglesCoarse() { return BODIES.coarse ? BODIES.coarse[0].src.userData.triangles : 0; },
      get bodyVertices() { return BODIES.fine ? BODIES.fine[0].nv : 0; },
      get bodyShapes() { return (BODIES.fine || BODIES.coarse || []).length; },
      bones: BONES.length,
      buildMs,
    },
    /** live boot profile — see the T declaration at the top of this fn */
    perf: T,
    dispose() {
      material.dispose();
      fadeMat?.dispose();
      for (const k of Object.keys(BODIES)) for (const b of BODIES[k]) b.src.dispose();
      for (const g of built) g?.dispose();
      for (const g of _tmpGeos) g.dispose();
    },
  };
}

export default createHumans;
