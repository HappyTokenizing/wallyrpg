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

  return {
    trunk: trunkParts.length ? mergeGeos(trunkParts) : null,
    canopy: canopyParts.length ? bakeAO(mergeGeos(canopyParts), 0.56) : null,
    extra: extraParts.length ? mergeGeos(extraParts) : null,
    height,
  };
}

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

  function addTree(kind, x, z, rng, opts = {}) {
    const y = W.heightAt(x, z);
    const v = (opts.variant != null ? opts.variant : (rng() * VARIANTS) | 0) % VARIANTS;
    const sh = shapes.get(kind + v);
    const s = (opts.scale ?? 1) * (0.74 + rng() * 0.66);
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
    trees.push(t);
    const k = skey(x, z);
    let a = cell.get(k);
    if (!a) cell.set(k, a = []);
    a.push(t);
    return t;
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
      addTree(kind, x, z, env.rngFor('plant.' + x + ',' + z));
      acc = 99;
      return true;
    },

    clear(x, z, r) {
      let n = 0;
      for (const t of trees) {
        if (t.dead) continue;
        if (Math.hypot(t.x - x, t.z - z) < r + 1.2) { t.dead = true; n++; }
      }
      if (n) acc = 99;
      return n;
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
      /* 8 Hz is plenty: a tree that pops into the frustum one frame
         late is invisible, and repacking 400 matrices every frame is
         not. Forced immediately after a plant() or clear(). */
      if (acc >= 0.125) { acc = 0; repack(); }
    },

    dispose() {
      for (const parts of buckets.values()) for (const m of parts) { m.geometry.dispose(); m.dispose(); }
      group.parent?.remove(group);
    },
  };
}
