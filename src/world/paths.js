/* ============================================================
   paths.js — the road network.

   Nothing here is hand-drawn. The graph comes straight out of
   src/game/data.js: every location is wired to its district anchor by
   a lane, and the ten district anchors are wired to each other by a
   minimum spanning tree plus the shortest few extra links, so the
   island has loops instead of a star.

   Each route is then RELAXED against the terrain before it is cut:

     - it is smoothed, so nothing is a ruled line between two points
     - it is pushed out of every building's clearance circle
     - it is pushed inland whenever it strays onto the beach
     - it follows contours: the lateral component of the terrain
       gradient is subtracted each iteration, so a road goes around a
       hill the way a cart track does rather than straight over it

   Then it is CARVED: the height profile along the route is smoothed
   (cut and fill, clamped to +/- 3.5 m so we never build a viaduct)
   and the heightfield is pulled onto it with a soft-edged mask. The
   same mask is the road's own coverage field, which the terrain
   colouring reads for worn edges and which `ctx.world.pathAt()`
   exposes to the city and NPC agents.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { LAND, BUILD } from '../core/palette.js';
import { clamp, lerp, smoothstep } from '../core/contracts.js';
import { ZONES, LOCATIONS } from '../game/data.js';

const ROAD_W = 6.4;      // district-to-district road
const LANE_W = 4.2;      // building lane
const FEATHER = 2.6;     // worn edge, metres

export function createPaths(ctx, terrain) {
  const rng = ctx.makeRng('wally.paths.v1');
  const { H, PATH, NX, NZ, CELL, gx0, gz0, IX } = terrain;

  /* ------------------------------------------------------------
     Graph
     ------------------------------------------------------------ */
  const nodes = [];
  const nodeByKey = new Map();
  const addNode = (key, x, z, kind, ref) => {
    let n = nodeByKey.get(key);
    if (n) return n;
    n = { key, x, z, kind, ref, i: nodes.length };
    nodes.push(n); nodeByKey.set(key, n);
    return n;
  };

  const zoneKeys = Object.keys(ZONES);
  for (const k of zoneKeys) addNode('zone:' + k, ZONES[k].world.x, ZONES[k].world.z, 'zone', ZONES[k]);
  for (const l of LOCATIONS) addNode('loc:' + l.id, l.world.x, l.world.z, 'loc', l);

  const edges = [];
  const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

  /* --- district trunk roads: Prim MST over the anchors --- */
  const anchors = zoneKeys.map((k) => nodeByKey.get('zone:' + k));
  {
    const inTree = new Set([anchors[0].key]);
    const rest = anchors.slice(1);
    const chosen = [];
    while (rest.length) {
      let best = null, bi = -1, bd = Infinity;
      for (let i = 0; i < rest.length; i++) {
        for (const a of anchors) {
          if (!inTree.has(a.key)) continue;
          const d = dist2(a, rest[i]);
          if (d < bd) { bd = d; best = a; bi = i; }
        }
      }
      chosen.push([best, rest[bi]]);
      inTree.add(rest[bi].key);
      rest.splice(bi, 1);
    }
    for (const [a, b] of chosen) edges.push({ a, b, kind: 'road', width: ROAD_W });

    /* Loops. Without these the island is a tree and every journey
       doubles back on itself. */
    const have = new Set(chosen.map(([a, b]) => a.key + '|' + b.key).concat(chosen.map(([a, b]) => b.key + '|' + a.key)));
    const extra = [];
    for (let i = 0; i < anchors.length; i++) {
      for (let j = i + 1; j < anchors.length; j++) {
        const a = anchors[i], b = anchors[j];
        if (have.has(a.key + '|' + b.key)) continue;
        extra.push({ a, b, d: dist2(a, b) });
      }
    }
    extra.sort((p, q) => p.d - q.d);
    for (const e of extra.slice(0, 4)) edges.push({ a: e.a, b: e.b, kind: 'road', width: ROAD_W * 0.9 });
  }

  /* --- lanes: every building onto its own district anchor --- */
  for (const l of LOCATIONS) {
    const a = nodeByKey.get('zone:' + l.z);
    const b = nodeByKey.get('loc:' + l.id);
    if (!a || !b || dist2(a, b) < 4) continue;
    edges.push({ a, b, kind: 'lane', width: LANE_W });
  }

  /* ------------------------------------------------------------
     Routing
     ------------------------------------------------------------ */
  const _g = { x: 0, z: 0 };
  function gradient(x, z, out) {
    const e = CELL;
    out.x = (terrain.heightAt(x + e, z) - terrain.heightAt(x - e, z)) / (2 * e);
    out.z = (terrain.heightAt(x, z + e) - terrain.heightAt(x, z - e)) / (2 * e);
    return out;
  }

  function routePoints(e) {
    const a = e.a, b = e.b;
    const L = dist2(a, b);
    const n = Math.max(4, Math.round(L / 16));
    const dx = (b.x - a.x) / L, dz = (b.z - a.z) / L;
    const px = -dz, pz = dx;
    /* one seeded lateral bow, so no two routes read the same */
    const bow = (rng() - 0.5) * Math.min(46, L * 0.16);
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const s = Math.sin(t * Math.PI);
      pts.push({
        x: a.x + (b.x - a.x) * t + px * bow * s,
        z: a.z + (b.z - a.z) * t + pz * bow * s,
      });
    }

    const locked = new Set([0, n]);
    for (let it = 0; it < 26; it++) {
      for (let i = 1; i < n; i++) {
        if (locked.has(i)) continue;
        const p = pts[i], pm = pts[i - 1], pp = pts[i + 1];
        /* smoothing */
        let nx2 = lerp(p.x, (pm.x + pp.x) * 0.5, 0.34);
        let nz2 = lerp(p.z, (pm.z + pp.z) * 0.5, 0.34);

        /* contour following: kill the lateral component of the slope */
        let tx = pp.x - pm.x, tz = pp.z - pm.z;
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;
        const qx = -tz, qz = tx;
        gradient(nx2, nz2, _g);
        const lat = _g.x * qx + _g.z * qz;
        const k = clamp(Math.abs(lat) * 6.5, 0, 5.5);
        nx2 -= qx * Math.sign(lat) * k;
        nz2 -= qz * Math.sign(lat) * k;

        /* keep off the buildings */
        for (const l of LOCATIONS) {
          if (e.b.ref === l || e.a.ref === l) continue;
          const ddx = nx2 - l.world.x, ddz = nz2 - l.world.z;
          const d = Math.hypot(ddx, ddz);
          const need = l.radius + e.width * 0.5 + 1.5;
          if (d > need || d < 1e-4) continue;
          const push = (need - d);
          nx2 += (ddx / d) * push;
          nz2 += (ddz / d) * push;
        }

        /* and off the sand */
        const sd = terrain.shoreDistAt(nx2, nz2);
        if (sd < 34) {
          const inward = 34 - sd;
          const gl = Math.hypot(nx2, nz2) || 1;
          nx2 -= (nx2 / gl) * inward * 0.22;
          nz2 -= (nz2 / gl) * inward * 0.22;
        }

        p.x = nx2; p.z = nz2;
      }
    }

    /* resample to a fixed 6 m so the carve and the ribbon are even */
    const out = [];
    let acc = 0;
    out.push({ x: pts[0].x, z: pts[0].z });
    for (let i = 1; i <= n; i++) {
      const p0 = pts[i - 1], p1 = pts[i];
      const seg = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      let travelled = 0;
      while (acc + (seg - travelled) >= 3.5) {
        travelled += 3.5 - acc;
        const t = travelled / seg;
        out.push({ x: lerp(p0.x, p1.x, t), z: lerp(p0.z, p1.z, t) });
        acc = 0;
      }
      acc += seg - travelled;
    }
    out.push({ x: pts[n].x, z: pts[n].z });
    return out;
  }

  /* ------------------------------------------------------------
     Carving
     ------------------------------------------------------------ */
  function profile(pts) {
    const h = pts.map((p) => terrain.heightAt(p.x, p.z));
    const base = h.slice();
    for (let it = 0; it < 8; it++) {
      const s = h.slice();
      for (let i = 1; i < h.length - 1; i++) h[i] = lerp(s[i], (s[i - 1] + s[i + 1]) * 0.5, 0.55);
    }
    /* cut and fill, but only ever a little: this is a dirt road, not
       an engineered grade */
    for (let i = 0; i < h.length; i++) h[i] = clamp(h[i], base[i] - 3.5, base[i] + 3.5);
    return h;
  }

  function carve(pts, h, width) {
    const half = width * 0.5;
    const reach = half + FEATHER;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i], p1 = pts[i + 1];
      const h0 = h[i], h1 = h[i + 1];
      const minx = Math.min(p0.x, p1.x) - reach, maxx = Math.max(p0.x, p1.x) + reach;
      const minz = Math.min(p0.z, p1.z) - reach, maxz = Math.max(p0.z, p1.z) + reach;
      const i0 = Math.max(0, Math.floor((minx - gx0) / CELL));
      const i1 = Math.min(NX - 1, Math.ceil((maxx - gx0) / CELL));
      const j0 = Math.max(0, Math.floor((minz - gz0) / CELL));
      const j1 = Math.min(NZ - 1, Math.ceil((maxz - gz0) / CELL));
      const ex = p1.x - p0.x, ez = p1.z - p0.z;
      const el2 = ex * ex + ez * ez || 1;
      for (let j = j0; j <= j1; j++) {
        const z = gz0 + j * CELL;
        for (let i2 = i0; i2 <= i1; i2++) {
          const x = gx0 + i2 * CELL;
          let t = ((x - p0.x) * ex + (z - p0.z) * ez) / el2;
          t = clamp(t, 0, 1);
          const d = Math.hypot(x - (p0.x + ex * t), z - (p0.z + ez * t));
          if (d > reach) continue;
          const m = smoothstep(reach, half, d);
          const o = IX(i2, j);
          if (m > PATH[o]) PATH[o] = m;
          H[o] = lerp(H[o], lerp(h0, h1, t), m * 0.92);
        }
      }
    }
  }

  for (const e of edges) {
    e.points = routePoints(e);
    e.height = profile(e.points);
  }
  /* trunk roads first so lanes tie into an already-graded surface */
  for (const e of edges) if (e.kind === 'road') carve(e.points, e.height, e.width);
  for (const e of edges) if (e.kind === 'lane') carve(e.points, e.height, e.width);

  /* ------------------------------------------------------------
     Ribbons. Built after the terrain is final so they sit on the
     heights the player actually walks on.
     ------------------------------------------------------------ */
  const group = new THREE.Group();
  group.name = 'paths';

  const material = ctx.mat.plaster({
    name: 'road',
    color: 0xffffff,
    vertexColors: true,
    variation: 0.0,
    edgeWear: 0.0,
    varScale: 0.26,
    relief: 0.42,
    grain: 0.014,
    grainScale: 3.0,
    grainAlbedo: 0.10,
    grainFade: [16, 90],
    macro: 0.55,
    macroScale: 0.42,
    term: 0.34,
    bandSoft: 0.020,
    band2: 0.16,
    core: 0.64,
    coreSoft: 0.028,
    rim: 0.0,
    skyBounce: 0.055,
    spec: 0.03,
    outline: false,
    noOutline: true,
  });
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  material.polygonOffsetUnits = -4;

  /* The compacted track is the dirt swatch with a little stone dust
     in it; the verge is plain dirt. Both are palette entries — the
     road never invents a colour of its own. */
  const C_ROAD = new THREE.Color().setHex(LAND.dirt, THREE.SRGBColorSpace)
    .lerp(new THREE.Color().setHex(BUILD.stone, THREE.SRGBColorSpace), 0.14);
  const C_WORN = new THREE.Color().setHex(LAND.dirt, THREE.SRGBColorSpace)
    .lerp(new THREE.Color().setHex(LAND.grassShade, THREE.SRGBColorSpace), 0.22);
  const _cc = new THREE.Color();

  /**
   * Resample a polyline so no segment is longer than `step`, keeping
   * every original vertex. XZ only — the ribbon looks the height up per
   * vertex, which is the whole point of doing this.
   */
  function densify(pts, step) {
    if (pts.length < 2) return pts;
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(1, Math.ceil(d / step));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      }
    }
    return out;
  }

  function buildRibbons() {
    /* One merged mesh per district keeps the draw calls in single
       figures while still letting the frustum throw most of them
       away. */
    const buckets = new Map();
    for (const e of edges) {
      const key = e.a.kind === 'zone' ? e.a.key : e.b.key;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(e);
    }

    for (const [key, list] of buckets) {
      const pos = [], nrm = [], col = [], uv = [], idx = [];
      let base = 0;
      for (const e of list) {
        /* A 6 m CHORD OVER A 2 m HEIGHTFIELD IS A BRIDGE.

           The centreline is resampled to a fixed 6 m so that the carve
           is even (see relax()), and the ribbon used to take one vertex
           ring per centreline point. Every quad was therefore a flat
           6 m plank laid across ground that turns every 2 m: over a dip
           it spans the dip, and the drawn tarmac floats above the
           collision surface. Measured with tools/surfacetest.mjs on the
           Iron Hills lane, the road was drawn up to 0.50 m over the
           ground the controller actually stands on — Wally walking a
           road with his ankles in it, which is exactly what the user
           photographed on a bench and a bin.

           The heightfield's own resolution is CELL = 2 m and the
           collision tiles are built from it vertex for vertex, so a
           ribbon sampled every 1.5 m cannot disagree with the collider
           by more than the raster disagrees with itself. It costs about
           four times the road vertices, which across the whole island
           is a few thousand — under a tenth of one building. */
        const pts = densify(e.points, 1.5);
        const half = e.width * 0.38;   // the ribbon rides INSIDE the carve
        const ring = [];
        for (let i = 0; i < pts.length; i++) {
          const p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(pts.length - 1, i + 1)];
          let tx = p1.x - p0.x, tz = p1.z - p0.z;
          const tl = Math.hypot(tx, tz) || 1;
          tx /= tl; tz /= tl;
          ring.push({ x: pts[i].x, z: pts[i].z, px: -tz, pz: tx });
        }
        const wear = ctx.makeRng('road.' + key + '.' + base);
        for (let i = 0; i < ring.length; i++) {
          const r = ring[i];
          for (let s = -1; s <= 1; s++) {
            const w = half * s * (s === 0 ? 0 : 1);
            const x = r.x + r.px * w, z = r.z + r.pz * w;
            /* 0.09 m was a z-fighting guard from before the material
               carried a polygon offset. It is now belt AND braces, and
               nine centimetres is a step the player can see himself
               standing in. Three is under the noise. */
            const y = terrain.heightAt(x, z) + 0.03;
            const n = terrain.normalAt(x, z);
            pos.push(x, y, z);
            nrm.push(n.x, n.y, n.z);
            uv.push(i * 0.18, s * 0.5 + 0.5);
            _cc.copy(s === 0 ? C_ROAD : C_WORN);
            const k = 0.88 + 0.24 * wear();
            col.push(_cc.r * k, _cc.g * k, _cc.b * k);
          }
        }
        for (let i = 0; i < ring.length - 1; i++) {
          const a0 = base + i * 3, b0 = a0 + 3;
          for (let s = 0; s < 2; s++) {
            const a = a0 + s, b = a0 + s + 1, c = b0 + s + 1, d = b0 + s;
            idx.push(a, b, c, a, c, d);
          }
        }
        base += ring.length * 3;
      }
      if (!idx.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, material);
      mesh.name = 'road.' + key;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.renderOrder = 1;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
    }
  }

  /** Distance from (x,z) to the nearest road centreline, in metres. */
  function distanceToRoad(x, z) {
    let best = Infinity;
    for (const e of edges) {
      const pts = e.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i], p1 = pts[i + 1];
        const ex = p1.x - p0.x, ez = p1.z - p0.z;
        const el2 = ex * ex + ez * ez || 1;
        const t = clamp(((x - p0.x) * ex + (z - p0.z) * ez) / el2, 0, 1);
        const d = Math.hypot(x - (p0.x + ex * t), z - (p0.z + ez * t));
        if (d < best) best = d;
      }
    }
    return best;
  }

  return {
    group, material, nodes, edges,
    buildRibbons, distanceToRoad,
    dispose() {
      group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
      material.dispose();
    },
  };
}
