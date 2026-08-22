/* ============================================================
   scatter.js — everything between the grass and the trees.

   Bushes, flowers, waterline reeds, boulders, fallen leaves, and the
   drift of leaf litter that crosses the lens. ART_DIRECTION §2.3 and
   §6 both say the same thing in different words: a still frame of
   this game must still feel windy, and there must be something moving
   in EVERY frame. The terrain module already runs a pollen shell; this
   adds the heavier, slower, more readable layer — actual leaves,
   tumbling, catching the key light as they turn.

   Four of the five layers are chunk-streamed by foliage.js and ride
   the same shader splice as the grass, so they thin with distance and
   part around Wally exactly as the blades do. Boulders take the
   distance fade but neither the bend nor the push: a rock that leans
   away from the player is a beach ball.

   The fifth is the drift, which is camera-relative and recycled
   upwind in JS — a vertex shader cannot decide that a leaf has left
   the shot and should come back on the other side.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { LAND, BUILD, BRAND, SKY } from '../core/palette.js';
import { clamp, lerp, smoothstep } from '../core/contracts.js';
import { deformSphere } from './trees.js';

/* ------------------------------------------------------------
   A petal / leaflet cluster, drawn once to a canvas. White, so the
   per-instance tint decides whether it is a cornflower, a poppy or
   last autumn's leaf. No external assets anywhere (BUILD_BRIEF).
   ------------------------------------------------------------ */
function petalTexture(ctx, size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.clearRect(0, 0, size, size);
  const rng = ctx.makeRng('foliage.petal');
  const S = size / 128;
  const cx = size * 0.5, cy = size * 0.54;

  const petal = (a, len, wid, v) => {
    g.save();
    g.translate(cx, cy);
    g.rotate(a);
    const grd = g.createLinearGradient(0, 0, 0, -len);
    const hi = Math.round(215 + v * 40);
    grd.addColorStop(0, `rgba(${hi * 0.62 | 0},${hi * 0.62 | 0},${hi * 0.62 | 0},1)`);
    grd.addColorStop(1, `rgba(${hi},${hi},${hi},1)`);
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(0, 0);
    g.bezierCurveTo(wid, -len * 0.34, wid * 0.86, -len * 0.9, 0, -len);
    g.bezierCurveTo(-wid * 0.86, -len * 0.9, -wid, -len * 0.34, 0, 0);
    g.fill();
    g.restore();
  };

  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    petal(a, (36 + rng() * 14) * S, (15 + rng() * 6) * S, rng());
  }
  /* a bright core so a flower has a middle and a leaf has a stalk end */
  const cg = g.createRadialGradient(cx, cy, 0, cx, cy, 13 * S);
  cg.addColorStop(0, 'rgba(255,255,255,1)');
  cg.addColorStop(1, 'rgba(240,240,240,0)');
  g.fillStyle = cg;
  g.beginPath(); g.arc(cx, cy, 13 * S, 0, Math.PI * 2); g.fill();

  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = ctx.quality.anisotropy || 1;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/* ------------------------------------------------------------
   Geometry
   ------------------------------------------------------------ */

/**
 * Lumpy dome, unit height, base at y = 0.
 *
 * Normals come from trees.js/deformSphere — the true normal of the
 * deformed surface, not of the ellipsoid it started as. Shading a
 * lumpy shape as if it were smooth is exactly how a bush ends up
 * looking like a low-poly boulder someone painted green.
 */
function domeGeo(rx, ry, rz, seed, seg, ring, amp, ao0 = 0.42) {
  const g = deformSphere(0, 0, 0, rx, ry * 0.5, rz, seed, seg, ring, amp, 0.45);
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 4);
  for (let i = 0; i < p.count; i++) {
    const y = Math.max(0, p.getY(i) + ry * 0.5);
    p.setXYZ(i, p.getX(i), y, p.getZ(i));
    const a = lerp(ao0, 1, smoothstep(0.02, 0.6, y / ry));
    col[i * 4] = col[i * 4 + 1] = col[i * 4 + 2] = 1;
    col[i * 4 + 3] = a;
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  return g;
}

function mergeSimple(list) {
  let vc = 0, ic = 0;
  for (const g of list) {
    vc += g.attributes.position.count;
    ic += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3);
  const uv = new Float32Array(vc * 2), col = new Float32Array(vc * 4);
  const idx = vc > 65535 ? new Uint32Array(ic) : new Uint16Array(ic);
  let vo = 0, io = 0;
  for (const g of list) {
    const p = g.attributes.position;
    pos.set(p.array, vo * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, vo * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, vo * 2);
    if (g.attributes.color) col.set(g.attributes.color.array, vo * 4);
    else col.fill(1, vo * 4, (vo + p.count) * 4);
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.array[i] + vo;
    else for (let i = 0; i < p.count; i++) idx[io++] = i + vo;
    vo += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(col, 4));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/** Two crossed cards, unit height, base at y = 0. vec3 colour so the
    alpha test keeps working (a vec4 colour would multiply into it). */
function crossCardGeo() {
  const pos = [], nor = [], uv = [], col = [], idx = [];
  for (let k = 0; k < 2; k++) {
    const a = k * Math.PI * 0.5;
    const dx = Math.cos(a) * 0.5, dz = Math.sin(a) * 0.5;
    const nx = -Math.sin(a), nz = Math.cos(a);
    const base = k * 4;
    const rows = [[0, 0.34], [1, 1.0]];
    for (const [y, lit] of rows) {
      for (const s of [-1, 1]) {
        pos.push(dx * s, y, dz * s);
        nor.push(nx * 0.35, 0.94, nz * 0.35);
        uv.push(s > 0 ? 1 : 0, y);
        const v = lerp(0.62, 1.06, lit);
        col.push(v, v, v);
      }
    }
    idx.push(base, base + 1, base + 3, base, base + 3, base + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** A tall waterline reed — three rows, unit height, curving. */
function reedGeo() {
  const Y = [0, 0.45, 0.8, 1.0], Wd = [0.035, 0.028, 0.016, 0], Z = [0, 0.04, 0.16, 0.40];
  const AO = [0.34, 0.62, 0.9, 1.0];
  const pos = [], nor = [], uv = [], col = [], idx = [];
  for (let r = 0; r < 4; r++) {
    const w = Wd[r];
    for (const x of (w > 0 ? [-w, w] : [0])) {
      pos.push(x, Y[r], Z[r]);
      nor.push(0, 0.82, -0.57);
      uv.push(0.5, Y[r]);
      col.push(1, 1, 1, AO[r]);
    }
  }
  for (let r = 0; r < 2; r++) { const a = r * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
  idx.push(4, 5, 6);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/* ============================================================ */
export function createScatter(ctx, env) {
  const W = env.world;
  const { CHUNK, GRASS_DIST, DENS } = env;
  const group = new THREE.Group();
  group.name = 'foliage.scatter';

  const tex = petalTexture(ctx);

  const _c = new THREE.Color();
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _q2 = new THREE.Quaternion();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();
  const _n = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

  /* ------------------------------------------------------------
     Shared layer factory: build → InstancedMesh, lod → count.
     ------------------------------------------------------------ */
  /* ------------------------------------------------------------
     SOLID SCATTER.

     Grass, flowers, litter and reeds are things you walk THROUGH — the
     grass shader parts around Wally precisely to say so — and giving a
     cornflower a collider would be both absurd and thousands of boxes.
     Boulders are the one scattered layer you walk INTO: they run to 2 m
     across and a metre tall.

     They are also the one layer that streams, so their boxes stream
     with them: registered when a chunk builds, dropped when it is
     evicted or rebuilt at a new band. That holds the live count to the
     few dozen inside the rock layer's own range instead of carrying
     every boulder on a 970 m island in the grid forever.

     A rock standing less than the controller's 0.35 m step offset proud
     of the ground is skipped. He steps over those, and a box there
     would only ever be a stumble.
     ------------------------------------------------------------ */
  const _sm = new THREE.Matrix4();
  const _sq = new THREE.Quaternion();
  const _sp2 = new THREE.Vector3();
  const _ssc = new THREE.Vector3();
  const _soff = new THREE.Matrix4();

  function makeLayer({ name, geo, mat, range, lod, density, pick, dress, solid, minCount = 3 }) {
    const LOD = new THREE.Vector4(lod[0], lod[1], lod[2], lod[3]);
    let sbb = null;
    /** One oriented box per boulder, from that boulder's own matrix. */
    function addSolids(mesh, n) {
      if (!solid || !ctx.phys || !ctx.phys.addOBB) return;
      if (!sbb) { geo.computeBoundingBox(); sbb = geo.boundingBox.clone(); }
      const cx = (sbb.max.x + sbb.min.x) * 0.5, cz = (sbb.max.z + sbb.min.z) * 0.5;
      const sx = (sbb.max.x - sbb.min.x) * solid.shrink;
      const sz = (sbb.max.z - sbb.min.z) * solid.shrink;
      const top = sbb.max.y, base = sbb.min.y - 0.6;
      const ids = [];
      for (let i = 0; i < n; i++) {
        mesh.getMatrixAt(i, _sm);
        _sm.decompose(_sp2, _sq, _ssc);
        if (_sp2.y + top * _ssc.y - W.heightAt(_sp2.x, _sp2.z) < solid.minRise) continue;
        _sm.multiply(_soff.makeTranslation(cx, (top + base) * 0.5, cz));
        ids.push(ctx.phys.addOBB(sx, top - base, sz, _sm, { name: `scatter.${name}`, prop: true }));
      }
      if (ids.length) mesh.userData.colIds = ids;
    }
    return {
      name, range, material: mat, LOD, solid: !!solid,
      build(ci, cj) {
        const ox = ci * CHUNK, oz = cj * CHUNK;
        const want = Math.round(CHUNK * CHUNK * density * DENS.value);
        if (want < 1) return null;
        const rng = ctx.makeRng((0x9e37 ^ (ci * 40503) ^ (cj * 55501) ^ name.length * 7919) >>> 0);
        const hits = [];
        for (let k = 0; k < want; k++) {
          const x = ox + rng() * CHUNK, z = oz + rng() * CHUNK;
          const w = pick(x, z, rng);
          if (w <= 0 || rng() > w) continue;
          hits.push(x, z);
        }
        const n = hits.length >> 1;
        if (n < minCount) return null;

        const g = geo.clone();
        const ranks = new Float32Array(n);
        for (let i = 0; i < n; i++) ranks[i] = (i + 0.5) / n;
        g.setAttribute('aFolRank', new THREE.InstancedBufferAttribute(ranks, 1));

        const mesh = new THREE.InstancedMesh(g, mat, n);
        mesh.name = `${name}.${ci},${cj}`;
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.userData.total = n;
        for (let i = 0; i < n; i++) dress(mesh, i, hits[i * 2], hits[i * 2 + 1], rng, ranks[i]);
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        addSolids(mesh, n);
        return mesh;
      },
      lod(mesh, d) {
        const total = mesh.userData.total;
        const a = env.allowedAt(d, LOD);
        const n = Math.min(total, Math.ceil(total * clamp(a + 0.004, 0, 1)));
        mesh.count = n;
        mesh.visible = n > 0;
      },
      release(mesh) {
        const ids = mesh?.userData?.colIds;
        if (!ids) return;
        ctx.phys?.remove(ids);
        mesh.userData.colIds = null;
      },
    };
  }

  /* place an instance standing on the ground, tilted into the slope */
  function stand(mesh, i, x, z, yaw, sx, sy, sz, tilt, drop = 0) {
    _p.set(x, W.heightAt(x, z) - drop, z);
    W.normalAt(x, z, _n);
    _q.setFromUnitVectors(UP, _n);
    _q2.identity().slerp(_q, tilt);
    _q.setFromAxisAngle(UP, yaw);
    _q2.multiply(_q);
    _s.set(sx, sy, sz);
    _m.compose(_p, _q2, _s);
    mesh.setMatrixAt(i, _m);
  }

  /* ------------------------------------------------------------
     1. Flowers and fallen leaves — one geometry, one material, two
        very different tints and two very different orientations.
     ------------------------------------------------------------ */
  const FLOWER_TINTS = [SKY.dawn, BRAND.gem, BRAND.warn, BRAND.token, BRAND.bad, BRAND.gem];
  const LITTER_TINTS = [BRAND.token2, BUILD.wood, LAND.dirt, BRAND.token];
  const flowerCol = FLOWER_TINTS.map((h) => env.lin(h));
  const litterCol = LITTER_TINTS.map((h) => env.lin(h));

  const detailMat = ctx.mat.foliage({
    name: 'foliage.detail',
    color: 0xffffff,
    map: tex,
    alphaTest: 0.38,
    side: THREE.DoubleSide,
    vertexColors: true,
    sss: 0.42,
    sssColor: LAND.grassLit,
    rim: 0.16,
    skyBounce: 0.06,
    grain: 0.006,
    wind: 0.14,
    windBase: 0,
    windHeight: 1,
    outline: false,
    noOutline: true,
  });
  env.noBackflip(detailMat);
  /* 0.58, NOT 0.46. At 110 m of grass this put the last flower at
     50 m — which on a gameplay camera is the exact depth the eye
     reads as the middle distance, and two blind rounds duly reported
     "the midground has a bald flat green patch where the grass cards
     stop". It is not a density problem, it is a PLACEMENT one: the
     ring was landing in the middle of the composition instead of out
     past it. 64 m puts it behind everything the frame reads as the
     field, and the ramp is stretched (0.28 rather than 0.34 of range
     at full density) so the extra area is thinned, not paid for at
     full price. */
  const detailRange = GRASS_DIST * 0.58;
  env.patch(detailMat, env.folUniforms({
    d1: detailRange * 0.28, d2: detailRange * 0.72, d3: detailRange, frac: 0.18,
    bend: 0.42, push: 0.40,
  }));

  const CARD = crossCardGeo();
  const detailLayer = makeLayer({
    name: 'detail',
    geo: CARD, mat: detailMat, range: detailRange,
    lod: [detailRange * 0.28, detailRange * 0.72, detailRange, 0.18],
    density: 0.42,
    pick(x, z) {
      const t = env.turf(x, z);
      if (t < 0.35) return 0;
      if (env.clearance(x, z) < 0.8) return 0;
      /* flowers grow in patches, never as a uniform sprinkle */
      return t * Math.pow(env.clump(x, z, 0.055), 1.8) * 1.5;
    },
    dress(mesh, i, x, z, rng) {
      const litter = rng() < 0.34;
      if (litter) {
        const s = 0.10 + rng() * 0.08;
        stand(mesh, i, x, z, rng() * Math.PI * 2, s, s * 0.16, s, 0.95, 0.01);
        _c.copy(litterCol[(rng() * litterCol.length) | 0]).multiplyScalar(0.7 + rng() * 0.4);
      } else {
        const s = 0.095 + rng() * 0.085;
        stand(mesh, i, x, z, rng() * Math.PI * 2, s, s * (1.1 + rng() * 0.6), s, 0.35);
        _c.copy(flowerCol[(rng() * flowerCol.length) | 0]).multiplyScalar(0.62 + rng() * 0.30);
      }
      mesh.setColorAt(i, _c);
    },
  });

  /* ------------------------------------------------------------
     2. Bushes.
     ------------------------------------------------------------ */
  const bushMat = ctx.mat.foliage({
    name: 'foliage.bush',
    color: env.mixHex(LAND.grassLit, LAND.grassShade, 0.58),
    map: false, alphaTest: 0,
    side: THREE.FrontSide,
    vertexColors: true,
    sss: 0.34, sssColor: LAND.grassLit,
    rim: 0.20, skyBounce: 0.08, grain: 0.010, grainScale: 3.6,
    term: 0.13, band2: 0.24, core: 0.50,
    wind: 0.30, windBase: 0, windHeight: 1,
    outline: true, outlineWidth: 2.6,
  });
  const bushRange = GRASS_DIST * 0.8;
  env.patch(bushMat, env.folUniforms({
    d1: bushRange * 0.4, d2: bushRange * 0.75, d3: bushRange, frac: 0.30,
    bend: 0.16, push: 0.10,
  }));

  /* A BUSH IS NOT A PEBBLE. One smooth dome reads as a boulder that
     someone painted green; what makes it read as leaves is a cluster
     of similar-sized lobes with deep notches between them, so the
     silhouette breaks up and the outline pass has something to draw. */
  /* A BUSH IS A CLUSTER OF SMALL LOBES. Two or three big smooth
     domes read as a boulder someone painted green — measured against
     the first pass, which is exactly what they looked like. Eight
     small ones of similar size, packed into a rough ball with real
     notches between them, give the outline pass a scalloped
     silhouette to draw and the eye reads leaves. */
  const BUSH = mergeSimple((() => {
    const parts = [domeGeo(0.34, 0.86, 0.34, 1.3, 8, 5, 0.30)];
    const ring = [
      [0.30, 0.06, 0.14, 4.9], [-0.28, 0.03, -0.18, 8.1],
      [-0.08, 0.05, 0.31, 12.7], [0.16, 0.02, -0.30, 17.3],
      [0.20, 0.34, 0.19, 21.9], [-0.21, 0.31, 0.11, 26.5],
      [0.02, 0.45, -0.20, 31.1],
    ];
    for (const [x, y, z, sd] of ring) {
      const r = 0.20 + (sd % 7) * 0.014;
      parts.push(domeGeo(r, r * 1.9, r, sd, 7, 5, 0.34).translate(x, y, z));
    }
    return parts;
  })());
  const bushLayer = makeLayer({
    name: 'bush', geo: BUSH, mat: bushMat, range: bushRange,
    lod: [bushRange * 0.4, bushRange * 0.75, bushRange, 0.30],
    density: 0.016,
    pick(x, z) {
      const t = env.turf(x, z);
      if (t < 0.4) return 0;
      if (env.clearance(x, z) < 2.2) return 0;
      return t * Math.pow(env.clump(x, z, 0.021), 1.5) * 1.6;
    },
    dress(mesh, i, x, z, rng) {
      const s = 0.40 + rng() * 0.38;
      stand(mesh, i, x, z, rng() * Math.PI * 2, s * (0.80 + rng() * 0.26), s * (0.94 + rng() * 0.44),
        s * (0.80 + rng() * 0.26), 0.4, 0.06);
      const v = 0.82 + rng() * 0.34;
      _c.setRGB(v * (0.96 + rng() * 0.08), v, v * 0.95);
      mesh.setColorAt(i, _c);
    },
  });

  /* ------------------------------------------------------------
     3. Boulders. No bend, no push — they are rocks.
     ------------------------------------------------------------ */
  const rockMat = ctx.mat.plaster({
    name: 'foliage.rock',
    color: LAND.rock, tint2: LAND.rockShade,
    edgeColor: LAND.cliff,
    variation: 0.24, varScale: 0.5, edgeWear: 0.3, relief: 0.3,
    vertexColors: true,
    macro: 0.3,
    wind: 0.001,                 // keeps the TOON_WIND path alive to splice into
    windBase: 0, windHeight: 1,
    outline: true, outlineWidth: 3.0,
  });
  const rockRange = GRASS_DIST * 0.8;
  env.patch(rockMat, env.folUniforms({
    d1: rockRange * 0.5, d2: rockRange * 0.8, d3: rockRange, frac: 0.35,
    bend: 0, push: 0,
  }));

  const ROCK = mergeSimple([
    domeGeo(0.9, 0.72, 0.78, 2.2, 8, 5, 0.26, 0.55),
    domeGeo(0.42, 0.34, 0.40, 6.6, 6, 4, 0.3, 0.55).translate(0.62, 0.0, -0.34),
  ]);
  const rockLayer = makeLayer({
    name: 'rock', geo: ROCK, mat: rockMat, range: rockRange,
    lod: [rockRange * 0.5, rockRange * 0.8, rockRange, 0.35],
    density: 0.009,
    /* 0.66 of a lumpy dome's bounding box: a boulder is round on plan
       and its box has to sit inside the silhouette, not around it. */
    solid: { shrink: 0.66, minRise: 0.35 },
    pick(x, z) {
      const h = W.heightAt(x, z);
      if (h < 0.6) return 0;
      if (W.shoreDistAt(x, z) < env.BEACH * 0.3) return 0;
      if (env.clearance(x, z) < 2.5) return 0;
      if (W.pathAt(x, z) > 0.3) return 0;
      const st = W.slopeAt(x, z);
      if (st > 0.62) return 0;
      /* more rock where the ground is steep or high, few in a meadow */
      return clamp(0.15 + st * 2.2 + smoothstep(24, 52, h) * 0.7, 0, 1)
        * lerp(0.4, 1.4, env.clump(x, z, 0.017));
    },
    dress(mesh, i, x, z, rng) {
      const s = 0.5 + rng() * 1.5;
      stand(mesh, i, x, z, rng() * Math.PI * 2,
        s * (0.85 + rng() * 0.4), s * (0.55 + rng() * 0.5), s * (0.85 + rng() * 0.4),
        0.8, s * 0.22);
      const v = 0.86 + rng() * 0.3;
      _c.setRGB(v, v * (0.99 + rng() * 0.03), v * (1.0 + rng() * 0.05));
      mesh.setColorAt(i, _c);
    },
  });

  /* ------------------------------------------------------------
     4. Reeds at the waterline.
     ------------------------------------------------------------ */
  const reedMat = ctx.mat.foliage({
    name: 'foliage.reed',
    color: env.mixHex(LAND.grassShade, LAND.dirt, 0.22),
    map: false, alphaTest: 0,
    side: THREE.DoubleSide,
    vertexColors: true,
    sss: 0.30, sssColor: LAND.grassLit,
    rim: 0, skyBounce: 0.05, grain: 0.006,
    wind: 0.2, windBase: 0, windHeight: 1,
    outline: false, noOutline: true,
  });
  env.noBackflip(reedMat);
  const reedRange = GRASS_DIST * 0.7;
  env.patch(reedMat, env.folUniforms({
    d1: reedRange * 0.4, d2: reedRange * 0.75, d3: reedRange, frac: 0.18,
    bend: 1.05, push: 0.7,
  }));

  const REED = reedGeo();
  const reedLayer = makeLayer({
    name: 'reed', geo: REED, mat: reedMat, range: reedRange,
    lod: [reedRange * 0.4, reedRange * 0.75, reedRange, 0.18],
    density: 1.6, minCount: 6,
    pick(x, z) {
      const sd = W.shoreDistAt(x, z);
      if (sd < -2.5 || sd > 10) return 0;
      const h = W.heightAt(x, z);
      if (h < -0.7 || h > 1.9) return 0;
      if (W.slopeAt(x, z) > 0.34) return 0;
      /* reeds grow in stands, not as a fringe all the way round */
      return smoothstep(0.42, 0.72, env.clump(x, z, 0.031)) * 0.9;
    },
    dress(mesh, i, x, z, rng) {
      const h = 0.75 + rng() * 0.85;
      stand(mesh, i, x, z, rng() * Math.PI * 2, h * 0.9, h, h * 0.9, 0.25, 0.06);
      const v = 0.8 + rng() * 0.4;
      _c.setRGB(v * 1.02, v, v * 0.86);
      mesh.setColorAt(i, _c);
    },
  });

  /* ------------------------------------------------------------
     5. The drift. §6: something moves in every single frame.
     ------------------------------------------------------------ */
  const N = Math.max(14, Math.round(40 * (ctx.quality.particles ?? 1)));
  const driftMat = ctx.mat.foliage({
    name: 'foliage.drift',
    color: 0xffffff,
    map: tex,
    alphaTest: 0.34,
    side: THREE.DoubleSide,
    vertexColors: true,
    sss: 0.95, sssColor: LAND.grassLit,
    rim: 0.9, grain: 0,
    wind: 0,
    outline: false, noOutline: true,
    shadowStrength: 0.25,
  });
  env.noBackflip(driftMat);
  const driftGeo = new THREE.PlaneGeometry(1, 1);
  {
    const n = driftGeo.attributes.position.count;
    driftGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  }
  const drift = new THREE.InstancedMesh(driftGeo, driftMat, N);
  drift.name = 'foliage.drift';
  drift.frustumCulled = false;
  drift.castShadow = false;
  drift.receiveShadow = false;
  drift.userData.noPrepass = true;
  drift.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(drift);

  const dRng = env.rngFor('drift');
  const DR = 24;
  const dp = new Float32Array(N * 3);
  const dph = new Float32Array(N);
  const dsc = new Float32Array(N);
  const dsp = new Float32Array(N * 3);          // tumble axis
  const dcam = new THREE.Vector3();
  const dwind = new THREE.Vector3();
  const dq = new THREE.Quaternion();
  const daxis = new THREE.Vector3();

  function respawn(i, cx, cz, seeded) {
    const a = dRng() * Math.PI * 2;
    const r = seeded ? Math.sqrt(dRng()) * DR : DR * (0.8 + dRng() * 0.2);
    const wx = ctx.wind?.uniforms.uWindDir.value.x ?? 1;
    const wz = ctx.wind?.uniforms.uWindDir.value.y ?? 0;
    const x = seeded ? cx + Math.cos(a) * r : cx - wx * r - wz * (dRng() - 0.5) * DR;
    const z = seeded ? cz + Math.sin(a) * r : cz - wz * r + wx * (dRng() - 0.5) * DR;
    dp[i * 3] = x;
    dp[i * 3 + 1] = W.heightAt(x, z) + 0.4 + dRng() * 4.2;
    dp[i * 3 + 2] = z;
    dph[i] = dRng() * 6.283;
    dsc[i] = 0.10 + dRng() * 0.13;
    dsp[i * 3] = dRng() - 0.5; dsp[i * 3 + 1] = dRng() - 0.5; dsp[i * 3 + 2] = dRng() - 0.5;
  }
  for (let i = 0; i < N; i++) {
    respawn(i, 0, 0, true);
    _c.copy(litterCol[(dRng() * litterCol.length) | 0]).lerp(env.lin(LAND.grassLit), dRng() * 0.6);
    _c.multiplyScalar(0.85 + dRng() * 0.4);
    drift.setColorAt(i, _c);
  }
  if (drift.instanceColor) drift.instanceColor.needsUpdate = true;

  function updateDrift(dt, elapsed) {
    ctx.camera.getWorldPosition(dcam);
    ctx.wind?.vector(dcam.x, dcam.z, dwind);
    const wx = (dwind.x || 0.5) * 2.4, wz = (dwind.z || 0.3) * 2.4;
    for (let i = 0; i < N; i++) {
      const o = i * 3;
      dp[o] += (wx + Math.sin(elapsed * 1.3 + dph[i]) * 0.7) * dt;
      dp[o + 2] += (wz + Math.cos(elapsed * 1.05 + dph[i] * 1.6) * 0.7) * dt;
      dp[o + 1] += (Math.sin(elapsed * 1.9 + dph[i]) * 0.55 - 0.22) * dt;
      const ddx = dp[o] - dcam.x, ddz = dp[o + 2] - dcam.z;
      const d2 = ddx * ddx + ddz * ddz;
      if (d2 > DR * DR || d2 < 1.6) { respawn(i, dcam.x, dcam.z, false); continue; }
      const g = W.heightAt(dp[o], dp[o + 2]);
      if (dp[o + 1] < g + 0.25) { respawn(i, dcam.x, dcam.z, false); continue; }
      if (dp[o + 1] > g + 6.5) dp[o + 1] = g + 6.5;
      daxis.set(dsp[o], dsp[o + 1], dsp[o + 2]).normalize();
      dq.setFromAxisAngle(daxis, elapsed * (1.4 + dph[i] * 0.22) + dph[i]);
      _p.set(dp[o], dp[o + 1], dp[o + 2]);
      _s.setScalar(dsc[i]);
      _m.compose(_p, dq, _s);
      drift.setMatrixAt(i, _m);
    }
    drift.instanceMatrix.needsUpdate = true;
  }

  return {
    group,
    layers: [detailLayer, bushLayer, rockLayer, reedLayer],
    update(dt, elapsed) { updateDrift(dt, elapsed); },
    dispose() {
      CARD.dispose(); BUSH.dispose(); ROCK.dispose(); REED.dispose();
      driftGeo.dispose(); drift.dispose(); tex.dispose();
      group.parent?.remove(group);
    },
  };
}
