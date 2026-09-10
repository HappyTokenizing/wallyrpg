/* ============================================================
   trees.js — five sculpted species, placed by district.

   THE RULE THIS FILE EXISTS TO OBEY: a Wind Waker tree is a SCULPTURE.
   A cone of alpha cards is an automatic fail. So every canopy here is
   closed geometry — overlapping lumpy ellipsoids, smooth-normalled by
   construction (the normal is the ellipsoid's, not the deformed
   surface's, which is what keeps a 168-triangle blob from faceting) —
   and every trunk is a swept tube with real taper and real branches.
   The only outline in the file is on the canopy silhouette (§5.5).

   SPECIES AND WHERE THEY GROW  (ctx.game.data district anchors)
     orchard    Green Edge      squat, wide, fruit, planted in rows
     palm       Waterfront      leaning ringed trunk, drooping fronds
     pine       Iron Hills      tall, stacked tiers, blue-green
     topiary    Golden Heights  formal spheres on a stone planter
     broadleaf  everywhere else the island is wild

   MOTION
   Canopies ride ctx.wind through ctx.mat's TOON_WIND path, whose
   phase is `dot(worldPos.xz, k)` — per VERTEX, not per object. That
   single detail is why a canopy here swells and ripples as a gust
   crosses it instead of sliding sideways as a rigid lump, and it is
   also the leaf-level flutter §2.3 asks for. Trunks take a tenth of
   the same bend so the whole tree leans together; palms take a third
   of it, because palms should look like they are about to lose.

   DRAWING
   Trees are placed once and then packed into per (species, variant,
   LOD) InstancedMeshes every few frames by distance and frustum, so
   ~400 trees on the island cost a dozen draw calls and only the ones
   you can see spend any triangles.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { LAND, BUILD, BRAND, SHADOW } from '../core/palette.js';
import { clamp, lerp, smoothstep } from '../core/contracts.js';
import { SOLID_TOP } from './props.js';

/* ------------------------------------------------------------
   Geometry kit
   ------------------------------------------------------------ */

const lump = (x, y, z, s) =>
  Math.sin(x * 1.7 + s) * Math.cos(y * 1.3 - s * 0.7) * Math.sin(z * 1.9 + s * 1.3);

function mergeGeos(list) {
  let vc = 0, ic = 0;
  for (const g of list) {
    vc += g.attributes.position.count;
    ic += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vc * 3);
  const nor = new Float32Array(vc * 3);
  const uv = new Float32Array(vc * 2);
  const idx = vc > 65535 ? new Uint32Array(ic) : new Uint16Array(ic);
  let vo = 0, io = 0;
  for (const g of list) {
    const p = g.attributes.position, nn = g.attributes.normal, u = g.attributes.uv;
    pos.set(p.array, vo * 3);
    if (nn) nor.set(nn.array, vo * 3);
    if (u) uv.set(u.array, vo * 2);
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.array[i] + vo;
    else for (let i = 0; i < p.count; i++) idx[io++] = i + vo;
    vo += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/**
 * Bake a vertical occlusion gradient into the vertex-colour alpha.
 * toon.js reads vColor.a as a warm AO term, which is what stops the
 * underside of a canopy reading as flat lit paint — and declaring a
 * colour attribute at all is what lets the per-tree instanceColor
 * reach the fragment shader (USE_INSTANCING_COLOR alone does not).
 */
function bakeAO(geo, floor = 0.58) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const y0 = bb.min.y, y1 = Math.max(bb.max.y, y0 + 0.001);
  const p = geo.attributes.position;
  const col = new Float32Array(p.count * 4);
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) - y0) / (y1 - y0);
    col[i * 4] = col[i * 4 + 1] = col[i * 4 + 2] = 1;
    col[i * 4 + 3] = lerp(floor, 1, smoothstep(0.02, 0.62, t));
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  return geo;
}

/**
 * A lumpy ellipsoid whose normals are the TRUE normals of the lumpy
 * surface, taken by central difference on the sphere parameter.
 *
 * The obvious shortcut — shade it as if it were still a smooth
 * ellipsoid — is what a canopy looked like on the first pass: the
 * shading said "sphere" while the silhouette and the self-shadowing
 * said "faceted lump", and the eye resolves that disagreement as
 * low-poly rock. Four extra noise taps per vertex at BUILD time buys
 * a canopy that reads as one soft mass at any tessellation.
 */
export function deformSphere(cx, cy, cz, rx, ry, rz, seed, seg, ring, amp, smooth = 0.5) {
  const g = new THREE.SphereGeometry(1, seg, ring);
  const p = g.attributes.position;
  const n = g.attributes.normal;

  const dAt = (ux, uy, uz) => 1
    + amp * lump(ux * 2.1, uy * 2.1, uz * 2.1, seed)
    + amp * 0.45 * lump(ux * 4.9, uy * 4.9, uz * 4.9, seed + 3.1);

  const E = 0.055;
  const P = (ux, uy, uz, out) => {
    const l = Math.hypot(ux, uy, uz) || 1;
    ux /= l; uy /= l; uz /= l;
    const d = dAt(ux, uy, uz);
    out[0] = ux * d * rx; out[1] = uy * d * ry; out[2] = uz * d * rz;
    return out;
  };
  const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0], e = [0, 0, 0];

  for (let i = 0; i < p.count; i++) {
    const ux = p.getX(i), uy = p.getY(i), uz = p.getZ(i);
    /* tangent frame on the sphere */
    let t1x = -uz, t1y = 0, t1z = ux;
    if (t1x * t1x + t1z * t1z < 1e-6) { t1x = 1; t1y = 0; t1z = 0; }
    let l1 = Math.hypot(t1x, t1y, t1z); t1x /= l1; t1y /= l1; t1z /= l1;
    const t2x = uy * t1z - uz * t1y, t2y = uz * t1x - ux * t1z, t2z = ux * t1y - uy * t1x;

    P(ux + t1x * E, uy + t1y * E, uz + t1z * E, a);
    P(ux - t1x * E, uy - t1y * E, uz - t1z * E, b);
    P(ux + t2x * E, uy + t2y * E, uz + t2z * E, c);
    P(ux - t2x * E, uy - t2y * E, uz - t2z * E, e);

    const dx1 = a[0] - b[0], dy1 = a[1] - b[1], dz1 = a[2] - b[2];
    const dx2 = c[0] - e[0], dy2 = c[1] - e[1], dz2 = c[2] - e[2];
    let nx = dy1 * dz2 - dz1 * dy2;
    let ny = dz1 * dx2 - dx1 * dz2;
    let nz = dx1 * dy2 - dy1 * dx2;
    let l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) { nx = ux / rx; ny = uy / ry; nz = uz / rz; l = Math.hypot(nx, ny, nz) || 1; }
    nx /= l; ny /= l; nz /= l;
    if (nx * ux + ny * uy + nz * uz < 0) { nx = -nx; ny = -ny; nz = -nz; }

    /* Blend back toward the smooth ellipsoid normal. THE TWO-BAND
       RAMP IS A THRESHOLD, and a threshold on a normal that swings
       +/-30 degrees across a lump breaks the canopy into hard-edged
       patches — which reads as faceting no matter how many triangles
       are under it. The lump stays in the silhouette, where it is
       doing the work; it only comes half way into the shading. */
    if (smooth > 0) {
      const ex = ux / rx, ey = uy / ry, ez = uz / rz;
      const el = Math.hypot(ex, ey, ez) || 1;
      nx = lerp(nx, ex / el, smooth);
      ny = lerp(ny, ey / el, smooth);
      nz = lerp(nz, ez / el, smooth);
      const bl = Math.hypot(nx, ny, nz) || 1;
      nx /= bl; ny /= bl; nz /= bl;
    }

    const d = dAt(ux, uy, uz);
    p.setXYZ(i, cx + ux * d * rx, cy + uy * d * ry, cz + uz * d * rz);
    n.setXYZ(i, nx, ny, nz);
  }
  return g;
}

/** Canopy blob: the true normal, softened a touch toward +Y so the
    underside picks up sky instead of going flat black. */
function blob(cx, cy, cz, rx, ry, rz, seed, seg, ring, amp = 0.20) {
  const g = deformSphere(cx, cy, cz, rx, ry, rz, seed, seg, ring, amp, 0.74);
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) {
    const x = n.getX(i), y = n.getY(i) + 0.16, z = n.getZ(i);
    const l = Math.hypot(x, y, z) || 1;
    n.setXYZ(i, x / l, y / l, z / l);
  }
  return g;
}

/** Swept tube along a polyline, radius per ring. */
function tube(pts, radii, sides) {
  const rings = pts.length;
  const pos = [], nor = [], uv = [], idx = [];
  const tan = new THREE.Vector3(), ax = new THREE.Vector3(), az = new THREE.Vector3();
  for (let i = 0; i < rings; i++) {
    const p = pts[i];
    tan.copy(pts[Math.min(i + 1, rings - 1)]).sub(pts[Math.max(i - 1, 0)]);
    if (tan.lengthSq() < 1e-9) tan.set(0, 1, 0);
    tan.normalize();
    ax.set(Math.abs(tan.x) > 0.9 ? 0 : 1, 0, Math.abs(tan.x) > 0.9 ? 1 : 0);
    az.crossVectors(tan, ax).normalize();
    ax.crossVectors(az, tan).normalize();
    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = ax.x * ca + az.x * sa, dy = ax.y * ca + az.y * sa, dz = ax.z * ca + az.z * sa;
      pos.push(p.x + dx * radii[i], p.y + dy * radii[i], p.z + dz * radii[i]);
      nor.push(dx, dy, dz);
      uv.push(s / sides, i * 0.55);
    }
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let s = 0; s < sides; s++) {
      const a = i * (sides + 1) + s, b = a + 1, c = a + sides + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** A trunk described by height, base/top radius, lean and an S-curve. */
function trunkGeo(h, r0, r1, leanX, leanZ, bow, rings, sides) {
  const pts = [], rad = [];
  /* Start below ground. A trunk that begins exactly at y = 0 shows a
     flat open disc the moment the tree stands on any slope, and the
     tree reads as a sticker floating over the hill. */
  pts.push(new THREE.Vector3(0, -0.75, 0));
  rad.push(r0 * 1.22);
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    const s = Math.sin(t * Math.PI) * bow;
    pts.push(new THREE.Vector3(
      leanX * t * t + s * 0.6,
      t * h,
      leanZ * t * t - s * 0.35));
    rad.push(lerp(r0, r1, Math.pow(t, 0.72)));
  }
  return tube(pts, rad, sides);
}

/** A drooping palm frond: tapered ribbon folded along its midrib. */
function frondGeo(len, width, droop, seg, rng) {
  const pos = [], nor = [], uv = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const x = t * len;
    const y = -droop * t * t * (0.6 + 0.4 * t);
    const w = width * Math.sin(Math.PI * Math.pow(t, 0.62)) * (1 - 0.25 * t);
    const fold = w * 0.42;
    /* left, ridge, right */
    pos.push(x, y, -w); nor.push(-0.32, 0.86, -0.4); uv.push(t, 0);
    pos.push(x, y + fold, 0); nor.push(0, 1, 0); uv.push(t, 0.5);
    pos.push(x, y, w); nor.push(-0.32, 0.86, 0.4); uv.push(t, 1);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 3;
    idx.push(a, a + 3, a + 1, a + 1, a + 3, a + 4);
    idx.push(a + 1, a + 4, a + 2, a + 2, a + 4, a + 5);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function rot(g, rx, ry) {
  const m = new THREE.Matrix4().makeRotationY(ry).multiply(new THREE.Matrix4().makeRotationZ(rx));
  g.applyMatrix4(m);
  return g;
}
function move(g, x, y, z) { g.translate(x, y, z); return g; }

/* ------------------------------------------------------------
   Species
   ------------------------------------------------------------ */

const KINDS = ['broadleaf', 'orchard', 'palm', 'pine', 'topiary'];
const VARIANTS = 2;

function buildSpecies(kind, variant, hi, rng) {
  const seg = hi ? 16 : 8, ring = hi ? 10 : 6;
  const sides = hi ? 10 : 5, trings = hi ? 6 : 3;
  const trunkParts = [], canopyParts = [], extraParts = [];
  let height = 6;

  if (kind === 'broadleaf') {
    const h = 4.0 + variant * 0.8 + rng() * 0.6;
    const lx = (rng() - 0.5) * 0.7, lz = (rng() - 0.5) * 0.7;
    trunkParts.push(trunkGeo(h, 0.58, 0.24, lx, lz, 0.26 + rng() * 0.2, trings, sides));
    if (hi) {
      for (let b = 0; b < 3; b++) {
        const a = (b / 3) * Math.PI * 2 + rng() * 0.9;
        const y0 = h * (0.56 + rng() * 0.14);
        const len = 1.3 + rng() * 0.7;
        const pts = [], rad = [];
        for (let i = 0; i < 4; i++) {
          const t = i / 3;
          pts.push(new THREE.Vector3(
            lx * (y0 / h) ** 2 + Math.cos(a) * len * t,
            y0 + len * t * (0.75 - 0.2 * t),
            lz * (y0 / h) ** 2 + Math.sin(a) * len * t));
          rad.push(lerp(0.22, 0.08, t));
        }
        trunkParts.push(tube(pts, rad, 5));
      }
    }
    /* A CANOPY IS A MASS, NOT A DISC. Five equal blobs on one ring at
       one height is a flying saucer; what reads as a Wind Waker tree
       is one dominant crown with smaller shoulders pushed out and
       DOWN around it, so the silhouette has a top, a waist and an
       underside for the AO to sit in. */
    const cx0 = lx * 0.9, cz0 = lz * 0.9;
    const top = h + 1.35;
    canopyParts.push(blob(cx0, top + 0.30, cz0, 2.10, 1.86, 2.10,
      variant * 5.1, seg, ring, 0.26));
    const nb = hi ? 5 : 4;
    for (let b = 0; b < nb; b++) {
      const a = (b / nb) * Math.PI * 2 + variant * 0.7 + rng() * 0.5;
      const rr = 1.55 + rng() * 0.5;
      const dy = -0.62 + rng() * 1.15;
      canopyParts.push(blob(
        cx0 + Math.cos(a) * rr, top + dy, cz0 + Math.sin(a) * rr,
        1.38 + rng() * 0.42, 1.20 + rng() * 0.36, 1.38 + rng() * 0.42,
        b * 2.7 + variant * 5.1, seg, ring, 0.26));
    }
    height = top + 2.1;

  } else if (kind === 'orchard') {
    const h = 2.5 + rng() * 0.4;
    trunkParts.push(trunkGeo(h, 0.46, 0.24, 0, 0, 0.2, trings, sides));
    if (hi) {
      for (let b = 0; b < 3; b++) {
        const a = (b / 3) * Math.PI * 2 + 0.5;
        const pts = [], rad = [];
        for (let i = 0; i < 3; i++) {
          const t = i / 2;
          pts.push(new THREE.Vector3(Math.cos(a) * 0.95 * t, h * 0.8 + 0.9 * t, Math.sin(a) * 0.95 * t));
          rad.push(lerp(0.16, 0.07, t));
        }
        trunkParts.push(tube(pts, rad, 5));
      }
    }
    const top = h + 1.25;
    canopyParts.push(blob(0, top + 0.22, 0, 1.82, 1.52, 1.82, variant * 2.2, seg, ring, 0.22));
    const nb = hi ? 4 : 3;
    for (let b = 0; b < nb; b++) {
      const a = (b / nb) * Math.PI * 2 + variant + rng() * 0.4;
      canopyParts.push(blob(Math.cos(a) * 1.28, top - 0.42 + rng() * 0.7, Math.sin(a) * 1.28,
        1.14, 1.02, 1.14, b * 3.3 + variant * 2.2, seg, ring, 0.22));
    }
    if (hi) {
      for (let f = 0; f < 7; f++) {
        const a = rng() * Math.PI * 2, r = 1.1 + rng() * 0.8;
        extraParts.push(blob(Math.cos(a) * r, top + (rng() - 0.6) * 0.9, Math.sin(a) * r,
          0.15, 0.15, 0.15, f, 6, 4, 0.05));
      }
    }
    height = top + 1.6;

  } else if (kind === 'palm') {
    const h = 5.2 + variant * 1.1 + rng();
    const lx = 0.85 + rng() * 0.5;
    const lz = (rng() - 0.5) * 0.4;
    trunkParts.push(trunkGeo(h, 0.31, 0.17, lx, lz, 0.34, hi ? 8 : 4, sides));
    const tipX = lx, tipY = h;
    const nf = hi ? 8 : 5;
    for (let f = 0; f < nf; f++) {
      const a = (f / nf) * Math.PI * 2 + variant * 0.4;
      const g = frondGeo(2.5 + rng() * 0.7, 0.44, 1.35 + rng() * 0.5, hi ? 7 : 4, rng);
      rot(g, -0.42 + rng() * 0.2, a);
      move(g, tipX, tipY + 0.1, lz);
      canopyParts.push(g);
    }
    canopyParts.push(blob(tipX, tipY + 0.08, lz, 0.42, 0.34, 0.42, 7.7, 8, 5, 0.14));
    if (hi) {
      for (let c = 0; c < 3; c++) {
        const a = c * 2.2;
        extraParts.push(blob(tipX + Math.cos(a) * 0.34, tipY - 0.30, lz + Math.sin(a) * 0.34,
          0.17, 0.17, 0.17, c, 6, 4, 0.05));
      }
    }
    height = h + 1.2;

  } else if (kind === 'pine') {
    const h = 5.4 + variant * 1.4 + rng() * 0.8;
    trunkParts.push(trunkGeo(h, 0.44, 0.14, 0, 0, 0.1, trings, sides));
    const tiers = hi ? 5 : 3;
    for (let t = 0; t < tiers; t++) {
      const u = t / (tiers - 1);
      const y = h * (0.30 + 0.72 * u);
      const r = lerp(2.05, 0.60, Math.pow(u, 0.9));
      canopyParts.push(blob(0, y, 0, r, r * 0.70, r, t * 4.4 + variant * 1.9, seg, ring, 0.24));
    }
    height = h * 1.05 + 1.2;

  } else { /* topiary */
    const h = 1.55;
    extraParts.push(tube(
      [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.62, 0), new THREE.Vector3(0, 0.72, 0)],
      [0.62, 0.56, 0.50], hi ? 12 : 7));
    trunkParts.push(trunkGeo(h, 0.16, 0.13, 0, 0, 0, 3, sides));
    canopyParts.push(blob(0, h + 0.62, 0, 0.86, 0.80, 0.86, 1.1 + variant, seg, ring, 0.05));
    canopyParts.push(blob(0, h + 1.72, 0, 0.60, 0.56, 0.60, 4.2 + variant, seg, ring, 0.05));
    if (hi) canopyParts.push(blob(0, h + 2.52, 0, 0.36, 0.34, 0.36, 8.3 + variant, seg, ring, 0.04));
    height = h + 3.1;
  }

  /* THE CROWN IS MEASURED OFF THE MERGED CANOPY, never typed in — the
     rule props.js solidFor() already follows, so it cannot drift away
     from the art when a species is resculpted. Per axis rather than one
     radius: a palm's fronds are 5 m across and 2 m deep, and a single
     square box round that is mostly air. 0.90 inscribes the box in the
     round mass exactly as props.js does for barrels and bins. */
  const canopyGeo = canopyParts.length ? bakeAO(mergeGeos(canopyParts), 0.56) : null;
  let crown = null;
  if (canopyGeo) {
    canopyGeo.computeBoundingBox();
    const bb = canopyGeo.boundingBox;
    if (bb && Number.isFinite(bb.min.y)) {
      crown = {
        rx: (bb.max.x - bb.min.x) * 0.5 * 0.90,
        rz: (bb.max.z - bb.min.z) * 0.5 * 0.90,
        cx: (bb.max.x + bb.min.x) * 0.5,
        cz: (bb.max.z + bb.min.z) * 0.5,
        base: bb.min.y, top: bb.max.y,
      };
    }
  }

  return {
    trunk: trunkParts.length ? mergeGeos(trunkParts) : null,
    canopy: canopyGeo,
    extra: extraParts.length ? mergeGeos(extraParts) : null,
    height,
    solid: TRUNK_SOLID[kind],
    crown,
  };
}

/* ------------------------------------------------------------------
   WHAT A TREE STOPS YOU WITH.

   A trunk is solid. A canopy is not, and it is worth being explicit
   about why: a broadleaf crown here is a 4 m ball of geometry hanging
   between 4 m and 7 m up, so a walking character can never reach it —
   but its BOUNDING BOX reaches the ground, and the lazy move (hand the
   tree mesh to addStatic) would wall off a 4 m circle of grass under
   every one of 782 trees and turn the woods into a maze of invisible
   pillars. Only the trunk gets a box, and only up to 2 m: the exact
   part of the tree a 1.62 m capsule can touch.

   `r` is the half-extent of a square box inside the round trunk,
   measured at the trunk's mid-collider height rather than at its flared
   base, so you can put your shoulder against the bark. The topiary is
   the exception — what stops you there is its stone planter, which is
   both wider and shorter than the little trunk standing in it.
   ------------------------------------------------------------------ */
const TRUNK_SOLID = {
  broadleaf: { r: 0.42, top: SOLID_TOP },
  orchard: { r: 0.33, top: SOLID_TOP },
  palm: { r: 0.24, top: SOLID_TOP },
  pine: { r: 0.33, top: SOLID_TOP },
  topiary: { r: 0.52, top: 0.86 },
};
/* below the ground line, so a trunk on a hillside never floats its box */
const TRUNK_BASE = -0.9;

/* ------------------------------------------------------------------
   AND WHAT A TREE STOPS A BALLOON WITH.

   The paragraph above is right about the character and wrong about the
   machine: a hot air balloon meets the canopy and never the trunk, and
   until this pass it flew through a beech. So the crown gets a box too
   — but only ever ABOVE CANOPY_BASE, and only ever WHILE SOMETHING
   THAT CAN REACH IT EXISTS. Both halves of that were paid for.

   CANOPY_BASE is the floor. The walkable circle of grass under a tree
   is the thing this must not take away, so nothing is registered below
   2.90 m of the tree's own base: 1.62 m of capsule, 0.35 m of step
   offset and a metre of daylight over the top of both. Enforced at the
   BOX'S CORNERS, not at its local floor — see crownFloor() — because
   the box leans with the tree and a palm's crown sits a metre off its
   own axis: the naive clamp left a palm at (-458, 38) hanging at
   2.38 m. With the corner pass all 757 crowns sit at exactly 2.90 m
   or higher over the terrain under their own trunk.

   AND THE HONEST LIMIT OF THAT RULE, which the gate is what makes
   harmless: "over the terrain under its own trunk" is not "over the
   ground". A six-metre crown on a hillside overhangs ground that is
   metres lower, and 18 of the island's 3 028 bottom corners clear the
   ground beneath THEM by less than a capsule's 1.97 m — the worst, a
   pine at (41, -226), is 1.19 m INSIDE the hill. Nothing walks under a
   registered crown, so nothing meets those. Anyone who ever takes the
   gate away must fix this first, and the symptom is already on record:
   a test capsule walked downhill from that pine deviated 2.17 m.

   THE GATE IS THE PART THAT IS NOT OBVIOUS, AND IT IS MEASURED.
   collision.js groundAt() casts DOWN FROM THE TOP OF THE WORLD and
   answers the first solid it meets, and three consumers ask it with no
   fromY: secondary.js's foot IK (twice) and camera.js's lensFloor and
   skyline. A canopy is the first solid this island would ever have
   over ground you can walk on, so a permanently-registered crown is
   not a canopy, it is an edit to somebody else's camera and somebody
   else's legs. Hung one 2.90–7.20 m crown over Wally's head through
   phys's own public API, on this build, changing no source:

     ankles   0.10 m over the terrain -> 0.94 m   (legs at full stretch
              reaching for a target 7 m up; he walks on tiptoe under
              every tree in the wood)
     camera   0.91 m over the terrain -> 7.92 m   (the lens floor takes
              the crown for the ground and the shot leaves for the sky)

   Both recovered the moment the box was removed. props.js says it
   shorter: a collider taller than the thing that has to walk around it
   is not describing collision.

   So canopies exist exactly while the balloon does. wally.js already
   emits 'wally:fly' on both edges of a flight — it is the same event
   that turns foot IK off for the ride ("his feet are on a deck") — and
   that is the whole wiring. On foot the collision world is byte for
   byte what it was before this pass; aloft, every crown is solid.

   AND ALOFT IT IS THE CROWNS AROUND HER, not the crowns on the island.
   The sentence above used to be true of all 757 at once and it cost
   the worst frame in the game to say so; the window that replaced it
   is at setCanopies() below, and it changes which crowns are live and
   nothing else about any one of them.
   ------------------------------------------------------------------ */
const CANOPY_BASE = 2.90;
/* below this a crown box is not worth a body: the clamp has eaten it */
const CANOPY_MIN_H = 0.40;

/* ------------------------------------------------------------------
   NOTHING GROWS IN THE CARRIAGEWAY.

   plantable() gates on turf(), and turf() only FADES with road
   coverage — it multiplies by 1 - smoothstep(0.10, 0.40, pathAt), so a
   candidate standing on the worn shoulder still scores 0.4 and still
   gets planted. That is right for a blade of grass and wrong for a
   trunk. A full-scale broadleaf is a 1.2 m collider inside a 1.7 m
   flare: measured on the island, four of the 782 trunk boxes reach
   road coverage between 0.41 and 0.93 — one Golden Heights topiary
   with its AXIS at 0.73, which is the middle of a street, and one
   Rusty Row broadleaf a metre off the kerb of the fork outside the
   player's own flat. Walking that district runs the capsule into it at
   (-322.9, 168.4) and grinds there for a second and a half.

   Trees were the one solid the city never asked this of: it vetoes a
   PROP that lands in a doorway corridor, and nothing was vetoing a
   trunk that landed in a road. So the trunk is measured against the
   carriageway explicitly — the disc its box occupies, PLUS the capsule
   that has to get past it, has to stay under ROAD_EDGE. A candidate
   that fails is walked down the coverage gradient; one that cannot get
   clear inside 3 m is not planted. Four trees move; 778 do not, and
   the walk consumes no rng, so every other tree is bit-identical.
   ------------------------------------------------------------------ */
const ROAD_EDGE = 0.42;      // pathAt at the worn edge of the carriageway
const WALK_R = 0.35;         // the controller capsule, ART_DIRECTION §4

/* ------------------------------------------------------------ */
export function createTrees(ctx, env) {
  const W = env.world;
  const q = env.quality;
  const group = new THREE.Group();
  group.name = 'foliage.trees';

  const FAR = 380;                       // beyond the fog's far plane
  const SPLIT = 64;                      // hi/lo LOD switch
  const MAXI = 190;                      // instances per bucket mesh

  /* ---------------- materials ---------------- */
  const tint = {
    broadleaf: env.mixHex(LAND.grassLit, LAND.grassShade, 0.52),
    orchard: env.mixHex(LAND.grassLit, LAND.grassShade, 0.30),
    palm: env.mixHex(LAND.grassLit, LAND.grassShade, 0.62),
    pine: env.mixHex(LAND.grassShade, SHADOW.tint, 0.22),
    topiary: env.mixHex(LAND.grassShade, BRAND.good, 0.30),
  };

  const canopyMat = {};
  for (const k of KINDS) {
    canopyMat[k] = ctx.mat.foliage({
      name: 'foliage.canopy.' + k,
      color: tint[k],
      map: false,
      alphaTest: 0,
      side: THREE.FrontSide,
      vertexColors: true,       // canopy AO + the per-tree tint
      sssColor: LAND.grassLit,
      sss: k === 'pine' ? 0.34 : 0.58,
      rim: 0.55,
      term: 0.13,
      band2: 0.22,
      core: 0.52,
      grain: 0.010,
      grainScale: 3.2,
      grainAlbedo: 0.13,
      wind: k === 'topiary' ? 0.14 : k === 'palm' ? 0.72 : 0.46,
      windBase: k === 'palm' ? 3.6 : k === 'topiary' ? 1.4 : 3.0,
      windHeight: 3.4,
      outline: true,
      outlineWidth: 3.0,
    });
  }
  const trunkMat = ctx.mat.wood({
    name: 'foliage.trunk',
    color: BUILD.wood, tint2: BUILD.woodDark,
    grainDir: [0, 1, 0], woodScale: 0.9, woodAmount: 0.9,
    wind: 0.10, windBase: 0, windHeight: 6,
    outline: true, outlineWidth: 2.8,
  });
  const palmTrunkMat = ctx.mat.wood({
    name: 'foliage.trunk.palm',
    color: BUILD.wood, tint2: BUILD.woodDark,
    grainDir: [0, 1, 0], woodScale: 2.4, woodAmount: 1.0,
    wind: 0.30, windBase: 0, windHeight: 6.5,
    outline: true, outlineWidth: 2.8,
  });
  const fruitMat = ctx.mat.plaster({
    name: 'foliage.fruit', color: BRAND.bad, tint2: BRAND.token,
    variation: 0.12, edgeWear: 0.05, relief: 0.05,
    outline: true, outlineWidth: 2.2,
  });
  const planterMat = ctx.mat.plaster({
    name: 'foliage.planter', color: BUILD.stone, tint2: LAND.rock,
    outline: true, outlineWidth: 3.0,
  });
  const coconutMat = ctx.mat.plaster({
    name: 'foliage.coconut', color: BUILD.woodDark, tint2: BUILD.wood,
    variation: 0.1, outline: true, outlineWidth: 2.2,
  });

  const windBase = new Map();
  for (const m of [...Object.values(canopyMat), trunkMat, palmTrunkMat]) {
    windBase.set(m, m.uniforms.uWindWeight.value);
  }

  function extraMat(kind) {
    return kind === 'topiary' ? planterMat : kind === 'palm' ? coconutMat : fruitMat;
  }
  function trunkMatFor(kind) { return kind === 'palm' ? palmTrunkMat : trunkMat; }

  /* ---------------- geometry + buckets ---------------- */
  const buckets = new Map();             // key -> { parts:[{mesh}], cap }
  const shapes = new Map();              // kind/variant -> { hi, lo }

  for (const k of KINDS) {
    for (let v = 0; v < VARIANTS; v++) {
      const rngHi = ctx.makeRng('tree.' + k + v);
      const rngLo = ctx.makeRng('tree.' + k + v);
      shapes.set(k + v, { hi: buildSpecies(k, v, true, rngHi), lo: buildSpecies(k, v, false, rngLo) });
    }
  }

  /* ---------------- placement ---------------- */
  const trees = [];
  const _m4 = new THREE.Matrix4();
  const _pv = new THREE.Vector3();
  const _qv = new THREE.Quaternion();
  const _sv = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const cell = new Map();                 // 12 m spacing hash
  const SP = 12;
  const skey = (x, z) => Math.floor(x / SP) * 8192 + Math.floor(z / SP);

  function tooClose(x, z, minD) {
    const i0 = Math.floor((x - minD) / SP), i1 = Math.floor((x + minD) / SP);
    const j0 = Math.floor((z - minD) / SP), j1 = Math.floor((z + minD) / SP);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const a = cell.get(i * 8192 + j);
        if (!a) continue;
        for (const t of a) if (Math.hypot(t.x - x, t.z - z) < minD) return true;
      }
    }
    return false;
  }

  /** Worst road coverage anywhere on the disc of radius r about (x, z). */
  function roadOver(x, z, r) {
    let worst = W.pathAt(x, z);
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      const v = W.pathAt(x + Math.cos(ang) * r, z + Math.sin(ang) * r);
      if (v > worst) worst = v;
    }
    return worst;
  }

  /** Walk (x, z) off the carriageway, or null if it cannot get clear.
      Steepest descent on pathAt in 0.5 m steps — six of them, so a tree
      never travels more than 3 m from where the placer meant it. */
  function offRoad(x, z, r) {
    if (roadOver(x, z, r) <= ROAD_EDGE) return null;      // already clear
    for (let k = 0; k < 6; k++) {
      let bx = x, bz = z, best = Infinity;
      for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * Math.PI * 2;
        const nx = x + Math.cos(ang) * 0.5, nz = z + Math.sin(ang) * 0.5;
        const v = roadOver(nx, nz, r);
        if (v < best) { best = v; bx = nx; bz = nz; }
      }
      x = bx; z = bz;
      if (best <= ROAD_EDGE) return { x, z };
    }
    return { x: NaN, z: NaN };                            // give up, drop it
  }

  function addTree(kind, x, z, rng, opts = {}) {
    const v = (opts.variant != null ? opts.variant : (rng() * VARIANTS) | 0) % VARIANTS;
    const sh = shapes.get(kind + v);
    const s = (opts.scale ?? 1) * (0.74 + rng() * 0.66);
    /* Off the road BEFORE anything is sampled from the position — the
       height, the normal and the collider all follow from it. The
       clearance asked for is the box's own half-width at this instance's
       scale plus the capsule that has to walk past it. */
    const solid = sh.hi.solid;
    if (solid) {
      const moved = offRoad(x, z, solid.r * s * 1.14 + WALK_R);
      if (moved) {
        if (!Number.isFinite(moved.x)) return null;
        x = moved.x; z = moved.z;
      }
    }
    const y = W.heightAt(x, z);
    const t = {
      kind, v, x, y, z, s,
      yaw: opts.yaw ?? rng() * Math.PI * 2,
      h: sh.hi.height * s,
      m: new THREE.Matrix4(),
      c: new THREE.Color(),
      d: 0,
    };
    _pv.set(x, y - 0.12 * s, z);
    W.normalAt(x, z, _sv);
    _qv.setFromUnitVectors(UP, _sv);
    const tilt = new THREE.Quaternion().identity().slerp(_qv, kind === 'topiary' ? 0.1 : 0.35);
    tilt.multiply(_qv.setFromAxisAngle(UP, t.yaw));
    _sv.set(s * (0.88 + rng() * 0.26), s * (0.86 + rng() * 0.34), s * (0.88 + rng() * 0.26));
    t.m.compose(_pv, tilt, _sv);
    const cv = 0.80 + rng() * 0.40;
    t.c.setRGB(cv * (0.94 + rng() * 0.12), cv, cv * (0.92 + rng() * 0.16));
    t.solid = sh.hi.solid || null;
    t.crown = sh.hi.crown || null;
    trees.push(t);
    /* A tree planted mid-flight gets its crown from the window on the
       next frame, not here — see streamCanopies. 'island' keeps the
       old behaviour so the revert really is the old rule. */
    if (physWired) { addTrunkCollider(t); if (canopiesOn && canopyMode === 'island') addCanopyCollider(t); }
    const k = skey(x, z);
    let a = cell.get(k);
    if (!a) cell.set(k, a = []);
    a.push(t);
    return t;
  }

  /* ---------------- trunk collision ----------------
     Trees are placed at foliage-init time, which is BEFORE the physics
     stage boots, so the boxes are handed over on the first update
     instead — and plant() / clear() keep them in step after that. */
  let physWired = false;
  const _colM = new THREE.Matrix4();
  const _colT = new THREE.Matrix4();
  function addTrunkCollider(t) {
    const s = t.solid;
    if (!s || t.dead || t.colId != null) return;
    _colM.copy(t.m).multiply(_colT.makeTranslation(0, (s.top + TRUNK_BASE) * 0.5, 0));
    t.colId = ctx.phys.addOBB(s.r * 2, s.top - TRUNK_BASE, s.r * 2, _colM,
      { name: `tree.${t.kind}`, prop: true });
  }

  /* THE /sy IS THE WHOLE OF THIS FUNCTION.

     t.m carries each tree's own size — that is why the trunk boxes
     measure 1.31 to 2.66 m over their terrain rather than a flat
     SOLID_TOP of 1.72 — and the crown numbers coming out of
     buildSpecies() are in the species' LOCAL frame, which that scale
     is about to multiply. CANOPY_BASE is a world height, so it has to
     be divided by the tree's vertical scale before it can be compared
     with a local one. Without the division a sapling at s = 0.74 gets
     its canopy floor at 0.74 x 2.90 = 2.15 m of world height, and the
     rule this whole design rests on is quietly gone. */
  const _cv = new THREE.Vector3();
  /** The local Y this tree's crown box may start at, or null when the
      clamps have eaten it. One function, so the rig that measures the
      floor is measuring the rule that ships. */
  function crownFloor(t) {
    const c = t.crown;
    if (!c) return null;
    const e = t.m.elements;
    const sy = Math.hypot(e[4], e[5], e[6]) || 1;
    let base = Math.max(c.base, CANOPY_BASE / sy);
    if (!(c.top - base > CANOPY_MIN_H)) return null;
    /* AND THEN THE CORNERS, because the box is TILTED and OFFSET.
       t.m leans the tree 0.35 of the way onto the terrain normal and a
       palm's crown sits a metre downwind of its own axis, so a floor
       2.90 m up the tree's local Y is not 2.90 m of world height at the
       low corner: measured over the island before this clause, the
       lowest corner on the island was a palm's at 2.38 m. Raising the
       local base by d lifts the bottom face by e[5] * d and leaves the
       top where the leaves are, so one pass is exact. */
    let low = Infinity;
    for (let i = 0; i < 4; i++) {
      _cv.set(c.cx + (i & 1 ? c.rx : -c.rx), base, c.cz + (i & 2 ? c.rz : -c.rz)).applyMatrix4(t.m);
      if (_cv.y < low) low = _cv.y;
    }
    const want = t.y + CANOPY_BASE;
    if (low < want && e[5] > 1e-3) {
      base += (want - low) / e[5];
      if (!(c.top - base > CANOPY_MIN_H)) return null;
    }
    return base;
  }
  function addCanopyCollider(t) {
    const c = t.crown;
    if (!c || t.dead || t.crownId != null || t.crownNo || !ctx.phys?.addOBB) return;
    const base = crownFloor(t);
    /* REMEMBERED, not recomputed. crownFloor() depends on t.m and
       t.crown and neither moves after placement, so a crown the clamps
       have eaten is eaten for the life of the session — and the stream
       below would otherwise re-derive four transformed corners for
       every one of them on every frame of every flight. */
    if (base == null) { t.crownNo = 1; return; }
    const h = c.top - base;
    _colM.copy(t.m).multiply(_colT.makeTranslation(c.cx, base + h * 0.5, c.cz));
    t.crownId = ctx.phys.addOBB(c.rx * 2, h, c.rz * 2, _colM,
      { name: `canopy.${t.kind}`, prop: true });
  }
  function dropColliders(t) {
    if (t.crownId != null) { ctx.phys?.remove(t.crownId); t.crownId = null; }
    if (t.colId == null) return;
    ctx.phys?.remove(t.colId);
    t.colId = null;
  }

  /* ------------------------------------------------------------------
     THE SWITCH, and it is a revert switch, not a debug hook: on is
     what a balloon meets, off is the island exactly as it was before
     canopies existed, and the two run on one page load so the A/B is a
     measurement rather than a number quoted from a dead build. The
     game drives it from 'wally:fly' below and never calls it directly;
     a test drives it to hold the island still on either side.

     AND THE ISLAND IS NO LONGER REGISTERED IN ONE GO — THAT WAS THE
     WORST FRAME IN THE GAME. 'island' is the rule this replaced, kept
     runnable beside the shipping one for exactly the reason above, and
     what was wrong with it is a frame: every live crown on the island
     went into the collision world inside a single setCanopies(true) —
     757 addOBB calls, 9 084 triangles hashed into the broadphase grid
     — on the frame the balloon boards, which is flyPhase 'boarding'
     and has no cut over it to hide behind. The matching removals land
     on the landing, where the player is watching the basket touch
     down. Both ends of a flight paid for a world-sized edit to answer
     a question about the fifty metres around one machine.

     terrain.js already answers this for rocks — updateRockCollision(),
     a window around the player at ROCK_IN 62 / ROCK_OUT 82, a couple
     of bodies a frame, hysteresis so walking a boundary cannot thrash
     one — and a canopy is the same shape of problem with the BALLOON
     at the centre. Same radii, deliberately: they were chosen so a solid is
     live long before anything can reach it, and a balloon's drift
     ceiling (RIDE_TUNE.balloon, 9.0 m/s) is slower than a run.

     WHAT THIS DOES NOT CHANGE, because all three were paid for:
       · the gate. Crowns still exist only while something that can
         reach them is in the air — see CANOPY_BASE's header for the
         0.94 m ankles and the 7.92 m lens that buys;
       · the floor. Nothing is registered below 2.90 m of world height
         in either mode: the window decides WHICH crowns, crownFloor()
         still decides where each one starts;
       · what a balloon meets. Inside CANOPY_IN the collision world is
         body for body what 'island' builds.
     ------------------------------------------------------------------ */
  const CANOPY_IN = 62, CANOPY_OUT = 82;   // terrain.js's rock window, verbatim
  const CANOPY_BUDGET = 4;                 // crowns registered per frame
  let canopiesOn = false;
  let canopyMode = 'stream';               // 'stream' ships | 'island' is the prior rule
  let canopyStreamed = 0;                  // adds made by the stream this session

  /* WHERE THE WINDOW IS CENTRED, and it is the machine the crowns
     exist for rather than the character: root carries the basket for
     the whole of a flight (wally.js flyUpdate integrates the balloon
     ON root and ctx.wally.position IS root.position), so the one
     handle answers for both. Null before wally boots — the world stage
     is earlier — and a null focus registers nothing rather than
     guessing at an origin nobody is standing on. */
  function canopyFocus() {
    const p = ctx.wally?.position;
    return p && Number.isFinite(p.x) && Number.isFinite(p.z) ? p : null;
  }

  /**
   * One pass of the window: drop what has left it, add what has
   * entered, at most `budget` additions. Horizontal distance, like the
   * rock window — she may descend at any moment, so an altitude test
   * would only take away the margin the radius is there to provide.
   * @returns {number} crowns registered this pass
   */
  function streamCanopies(budget = CANOPY_BUDGET) {
    if (!canopiesOn || canopyMode !== 'stream' || !physWired) return 0;
    const f = canopyFocus();
    if (!f) return 0;
    const fx = f.x, fz = f.z;
    for (const t of trees) {
      if (t.crownId == null) continue;
      if (!t.dead && Math.hypot(t.x - fx, t.z - fz) <= CANOPY_OUT) continue;
      ctx.phys?.remove(t.crownId);
      t.crownId = null;
    }
    let n = 0;
    for (const t of trees) {
      if (n >= budget) break;
      if (t.dead || t.crownId != null || t.crownNo || !t.crown) continue;
      if (Math.hypot(t.x - fx, t.z - fz) > CANOPY_IN) continue;
      addCanopyCollider(t);
      if (t.crownId != null) { n++; canopyStreamed++; }
    }
    return n;
  }

  /**
   * @param {boolean} on
   * @param {'stream'|'island'} [mode]  which rule to run. Naming the
   *   mode with `on` unchanged re-runs the window unbudgeted, so a test
   *   can switch rules mid-flight and measure both on one page load
   *   without waiting for the stream to catch up.
   */
  function setCanopies(on, mode) {
    const modeChanged = (mode === 'stream' || mode === 'island') && mode !== canopyMode;
    if (mode === 'stream' || mode === 'island') canopyMode = mode;
    on = on !== false;
    if (on === canopiesOn) {
      if (on && physWired && modeChanged) {
        if (canopyMode === 'island') { for (const t of trees) if (!t.dead) addCanopyCollider(t); }
        else streamCanopies(1e9);
      }
      return canopiesOn;
    }
    canopiesOn = on;
    if (!physWired) return canopiesOn;
    if (!on) {
      for (const t of trees) {
        if (t.crownId == null) continue;
        ctx.phys?.remove(t.crownId);
        t.crownId = null;
      }
      return canopiesOn;
    }
    if (canopyMode === 'island') { for (const t of trees) if (!t.dead) addCanopyCollider(t); }
    else streamCanopies();
    return canopiesOn;
  }
  const offFly = ctx.bus?.on?.('wally:fly', (e) => setCanopies(!!e?.flying)) || null;

  function wirePhysics() {
    if (physWired || !ctx.phys?.addOBB) return 0;
    physWired = true;
    for (const t of trees) addTrunkCollider(t);
    if (canopiesOn) { if (canopyMode === 'island') { for (const t of trees) if (!t.dead) addCanopyCollider(t); } else streamCanopies(1e9); }
    return trees.length;
  }

  function plantable(x, z, minTurf = 0.35, pad = 1.5) {
    if (env.turf(x, z) < minTurf) return false;
    if (env.clearance(x, z) < pad) return false;
    if (W.slopeAt(x, z) > 0.42) return false;
    return true;
  }

  function kindFor(x, z) {
    const zn = W.zoneAt(x, z);
    if (zn) {
      if (zn.id === 'greenedge') return 'orchard';
      if (zn.id === 'waterfront') return 'palm';
      if (zn.id === 'ironhills') return 'pine';
      if (zn.id === 'goldenheights') return 'topiary';
    }
    const h = W.heightAt(x, z);
    if (W.shoreDistAt(x, z) < env.BEACH * 2.1) return 'palm';
    if (h > 27) return 'pine';
    return 'broadleaf';
  }

  function placeAll() {
    const rng = env.rngFor('trees');
    const TARGET = Math.round(360 * clamp((q.grass ?? 1) * 0.75 + 0.35, 0.4, 1.35));

    /* --- 1. Green Edge, planted in rows. An orchard is the one place
             on this island where regularity is the point. --- */
    const ge = W.zones.greenedge.world;
    const gy = W.zones.greenedge.yaw ?? 0;
    const ca = Math.cos(gy), sa = Math.sin(gy);
    let orch = 0;
    for (let a = -9; a <= 9 && orch < 128; a++) {
      for (let b = -9; b <= 9 && orch < 128; b++) {
        const u = a * 8.4, v = b * 7.2;
        const x = ge.x + u * ca - v * sa + (rng() - 0.5) * 0.9;
        const z = ge.z + u * sa + v * ca + (rng() - 0.5) * 0.9;
        if (!plantable(x, z, 0.55, 3)) continue;
        if (tooClose(x, z, 5.5)) continue;
        addTree('orchard', x, z, rng, { yaw: gy + (rng() - 0.5) * 0.5, scale: 1.0 });
        orch++;
      }
    }

    /* --- 2. Golden Heights: topiary flanking every doorway. --- */
    for (const l of W.locations) {
      if (l.z !== 'goldenheights') continue;
      for (const off of [-0.62, 0.62, -2.5, 2.5]) {
        const a = l.yaw + off;
        const r = l.radius + 2.2;
        const x = l.world.x + Math.sin(a) * r, z = l.world.z + Math.cos(a) * r;
        if (W.heightAt(x, z) < 1 || W.slopeAt(x, z) > 0.5) continue;
        if (tooClose(x, z, 3.2)) continue;
        addTree('topiary', x, z, rng, { yaw: l.yaw, scale: 1.0 });
      }
    }

    /* --- 3. Palms along the sand line, thickest at the Waterfront. --- */
    const RX = W.islandRadiusX, RZ = W.islandRadiusZ;
    for (let i = 0; i < 900; i++) {
      const a = (i / 900) * Math.PI * 2;
      for (let k = 0; k < 2; k++) {
        const inset = env.BEACH * (0.9 + rng() * 1.5);
        const rx = RX - inset, rz = RZ - inset;
        const x = Math.cos(a) * rx + (rng() - 0.5) * 12;
        const z = Math.sin(a) * rz + (rng() - 0.5) * 12;
        if (!plantable(x, z, 0.10, 2)) continue;
        if (W.shoreDistAt(x, z) > env.BEACH * 2.6) continue;
        const zn = W.zoneAt(x, z);
        const p = zn && zn.id === 'waterfront' ? 0.55 : 0.16;
        if (rng() > p) continue;
        if (tooClose(x, z, 9)) continue;
        addTree('palm', x, z, rng, { scale: 0.95 });
      }
    }

    /* --- 4. The wild island: clumped groves and real clearings. --- */
    const cand = [];
    for (let x = -RX; x <= RX; x += 11) {
      for (let z = -RZ; z <= RZ; z += 11) {
        const jx = x + (rng() - 0.5) * 8, jz = z + (rng() - 0.5) * 8;
        if (!plantable(jx, jz, 0.4, 4)) continue;
        const c = env.clump(jx, jz, 0.0115);
        const score = env.turf(jx, jz) * Math.pow(c, 2.1) * (0.55 + 0.45 * rng());
        if (score < 0.03) continue;
        cand.push({ x: jx, z: jz, score });
      }
    }
    cand.sort((a, b) => b.score - a.score);
    let placed = 0;
    for (const c of cand) {
      if (placed >= TARGET) break;
      if (tooClose(c.x, c.z, 7.5)) continue;
      const k = kindFor(c.x, c.z);
      addTree(k, c.x, c.z, rng, { scale: k === 'pine' ? 1.05 : 1.0 });
      placed++;
    }
  }
  placeAll();

  /* ---------------- instanced buckets ---------------- */
  function makeBucket(kind, v, lodName) {
    const sh = shapes.get(kind + v)[lodName];
    const parts = [];
    const push = (geo, mat, outline) => {
      if (!geo) return;
      const n = Math.min(MAXI, Math.max(8, countOf(kind, v)));
      const mesh = new THREE.InstancedMesh(geo, mat, n);
      mesh.name = `tree.${kind}${v}.${lodName}`;
      mesh.frustumCulled = false;          // we cull per tree, on the CPU
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      /* instanceColor only reaches the fragment shader on a material
         that also declares vertex colours — see bakeAO(). */
      if (mat.vertexColors) {
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
      /* wind displaces the canopy, so the shadow has to displace with
         it or every tree drops a shadow of a tree standing still */
      if (mat.userData.depthMaterial) mesh.customDepthMaterial = mat.userData.depthMaterial;
      if (outline) {
        const hull = ctx.mat.outline(mesh);
        if (hull) { hull.frustumCulled = false; mesh.userData.hull = hull; }
      }
      mesh.count = 0;
      group.add(mesh);
      parts.push(mesh);
    };
    push(sh.trunk, trunkMatFor(kind), false);
    push(sh.canopy, canopyMat[kind], true);
    push(sh.extra, extraMat(kind), false);
    return parts;
  }
  function countOf(kind, v) {
    let n = 0;
    for (const t of trees) if (t.kind === kind && t.v === v) n++;
    return n;
  }
  for (const k of KINDS) {
    for (let v = 0; v < VARIANTS; v++) {
      if (!countOf(k, v)) continue;
      buckets.set(k + v + 'hi', makeBucket(k, v, 'hi'));
      buckets.set(k + v + 'lo', makeBucket(k, v, 'lo'));
    }
  }

  /* ---------------- per-frame packing ---------------- */
  const frustum = new THREE.Frustum();
  const pm = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  const camPos = new THREE.Vector3();
  let acc = 0, drawn = 0, tris = 0;

  function repack() {
    ctx.camera.getWorldPosition(camPos);
    pm.multiplyMatrices(ctx.camera.projectionMatrix, ctx.camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pm);

    for (const parts of buckets.values()) for (const m of parts) m.count = 0;
    drawn = 0; tris = 0;

    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      if (t.dead) continue;
      const dx = t.x - camPos.x, dz = t.z - camPos.z, dy = t.y + t.h * 0.5 - camPos.y;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > FAR) continue;
      sphere.center.set(t.x, t.y + t.h * 0.5, t.z);
      sphere.radius = t.h * 0.62 + 1.4;
      if (!frustum.intersectsSphere(sphere)) continue;

      const parts = buckets.get(t.kind + t.v + (d < SPLIT ? 'hi' : 'lo'));
      if (!parts) continue;
      drawn++;
      for (const m of parts) {
        const k = m.count;
        if (k >= m.instanceMatrix.count) continue;
        m.instanceMatrix.array.set(t.m.elements, k * 16);
        if (m.instanceColor) {
          m.instanceColor.array[k * 3] = t.c.r;
          m.instanceColor.array[k * 3 + 1] = t.c.g;
          m.instanceColor.array[k * 3 + 2] = t.c.b;
        }
        m.count = k + 1;
      }
    }

    for (const parts of buckets.values()) {
      for (const m of parts) {
        m.visible = m.count > 0;
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
        const h = m.userData.hull;
        if (h) { h.count = m.count; h.visible = m.visible; }
        if (m.count) tris += m.count * (m.geometry.index.count / 3);
      }
    }
  }
  repack();

  /* ---------------- API ---------------- */
  return {
    group,
    kinds: KINDS,

    plant(kind, x, z) {
      if (!KINDS.includes(kind)) return false;
      if (env.clearance(x, z) < 0.5) return false;
      /* addTree answers null when the trunk cannot be got off the road */
      if (!addTree(kind, x, z, env.rngFor('plant.' + x + ',' + z))) return false;
      acc = 99;
      return true;
    },

    clear(x, z, r) {
      let n = 0;
      for (const t of trees) {
        if (t.dead) continue;
        if (Math.hypot(t.x - x, t.z - z) < r + 1.2) { t.dead = true; dropColliders(t); n++; }
      }
      if (n) acc = 99;
      return n;
    },

    /** Hand every trunk to ctx.phys. Called once, from foliage.update. */
    wirePhysics,
    get solidCount() { let n = 0; for (const t of trees) if (t.colId != null) n++; return n; },

    /** The canopy switch. Driven by 'wally:fly'; exposed so a test can
        run the island with crowns and without on one page load.
        setCanopies(true, 'island') is the rule this round replaced —
        every crown at once — and setCanopies(true, 'stream') is what
        ships. Both run live, so the A/B is a measurement. */
    setCanopies,
    get canopiesOn() { return canopiesOn; },
    get canopyMode() { return canopyMode; },
    get crownCount() { let n = 0; for (const t of trees) if (t.crownId != null) n++; return n; },
    /** What the window is doing, for a rig that wants the shape of the
        stream rather than a single frame of it. */
    canopyStats() {
      const f = canopyFocus();
      let live = 0, eligible = 0, eaten = 0, inWindow = 0;
      for (const t of trees) {
        if (t.crownId != null) live++;
        if (t.dead || !t.crown) continue;
        if (t.crownNo) { eaten++; continue; }
        eligible++;
        if (f && Math.hypot(t.x - f.x, t.z - f.z) <= CANOPY_IN) inWindow++;
      }
      return {
        mode: canopyMode, on: canopiesOn, live, eligible, eaten, inWindow,
        streamed: canopyStreamed, budget: CANOPY_BUDGET,
        radius: [CANOPY_IN, CANOPY_OUT],
        focus: f ? [+f.x.toFixed(2), +f.y.toFixed(2), +f.z.toFixed(2)] : null,
      };
    },
    /** Every live crown box in world space — what a rig measures the
        fit of against the drawn canopy. */
    crownBoxes(limit = 1e9) {
      const out = [];
      const p = new THREE.Vector3();
      for (const t of trees) {
        if (t.dead || !t.crown || out.length >= limit) continue;
        const c = t.crown;
        const base = crownFloor(t);
        if (base == null) continue;
        const h = c.top - base;
        /* the eight world corners, so a rig can ask the question that
           matters — how low does this box actually reach — instead of
           re-deriving it and getting the tilt wrong */
        const corners = [];
        let low = Infinity, high = -Infinity;
        for (let i = 0; i < 8; i++) {
          p.set(c.cx + (i & 1 ? c.rx : -c.rx), i & 4 ? c.top : base, c.cz + (i & 2 ? c.rz : -c.rz)).applyMatrix4(t.m);
          corners.push([p.x, p.y, p.z]);
          if (p.y < low) low = p.y;
          if (p.y > high) high = p.y;
        }
        p.set(c.cx, base + h * 0.5, c.cz).applyMatrix4(t.m);
        out.push({
          kind: t.kind, v: t.v, x: t.x, y: t.y, z: t.z, s: t.s,
          live: t.crownId != null,
          centre: [p.x, p.y, p.z], corners,
          lowOverBase: low - t.y, highOverBase: high - t.y,
          local: { rx: c.rx, rz: c.rz, base, top: c.top, h },
        });
      }
      return out;
    },

    setWind(k) {
      for (const [m, base] of windBase) m.uniforms.uWindWeight.value = base * k;
    },

    /**
     * The best CAMERA for a grove shot, not the best point in the wood.
     *
     * Every cheaper heuristic here failed the same way: the densest
     * tree, the centroid of its neighbours, the peak of a density
     * grid — each one names a place, and a place is not a shot. A
     * district plants its trees in a ring around its buildings, so
     * the dense point is often a clearing and the camera comes back
     * with an empty field and trees off both edges.
     *
     * So score the thing we actually want: stand somewhere, look
     * somewhere, and count the trees that land inside the frame
     * between 6 and 70 m. Brute force over a few hundred candidate
     * poses, once, on demand, in a debug path.
     */
    bestView(fovDeg = 50, dist = 24) {
      const live = trees.filter((t) => !t.dead);
      if (!live.length) return { px: 0, pz: 0, tx: 0, tz: 0, n: 0 };
      const cosHalf = Math.cos(THREE.MathUtils.degToRad(fovDeg * 0.5) * 0.82);
      let best = null, bn = -1;
      const step = Math.max(1, Math.floor(live.length / 220));
      for (let i = 0; i < live.length; i += step) {
        const t = live[i];
        for (let a = 0; a < 8; a++) {
          const ang = (a / 8) * Math.PI * 2;
          const dx = Math.sin(ang), dz = Math.cos(ang);
          const px = t.x - dx * dist, pz = t.z - dz * dist;
          if (env.blocked(px, pz, 5)) continue;
          if (env.turf(px, pz) < 0.2) continue;
          let n = 0;
          for (const o of live) {
            const ox = o.x - px, oz = o.z - pz;
            const d = Math.hypot(ox, oz);
            if (d < 6 || d > 70) continue;
            if ((ox * dx + oz * dz) / d < cosHalf) continue;
            /* weight the near ones: a shot is made by what fills it */
            n += 1 + 2 / (1 + d * 0.06);
          }
          if (n > bn) { bn = n; best = { px, pz, tx: t.x + dx * 26, tz: t.z + dz * 26, n }; }
        }
      }
      return best || { px: 0, pz: 0, tx: 0, tz: 0, n: 0 };
    },

    stats() {
      const byKind = {};
      for (const t of trees) if (!t.dead) byKind[t.kind] = (byKind[t.kind] || 0) + 1;
      return { total: trees.filter((t) => !t.dead).length, drawn, tris: Math.round(tris), byKind };
    },

    update(dt) {
      acc += dt;
      /* THE WINDOW, EVERY FRAME, AND ONLY WHILE SOMETHING IS FLYING.
         It early-outs on `canopiesOn` before it touches the tree list,
         so on foot — which is nearly all of the session — this line
         costs one boolean. Aloft it is two passes over 782 trees and
         at most CANOPY_BUDGET registrations. Not on the 8 Hz timer
         with repack(): a crown that arrives an eighth of a second late
         is a crown the balloon has already flown through. */
      if (canopiesOn) streamCanopies();
      /* 8 Hz is plenty: a tree that pops into the frustum one frame
         late is invisible, and repacking 400 matrices every frame is
         not. Forced immediately after a plant() or clear(). */
      if (acc >= 0.125) { acc = 0; repack(); }
    },

    dispose() {
      offFly?.();
      setCanopies(false);
      for (const parts of buckets.values()) for (const m of parts) { m.geometry.dispose(); m.dispose(); }
      group.parent?.remove(group);
    },
  };
}
