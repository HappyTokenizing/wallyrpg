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

  /* ALL THE CARVES AT ONCE, NOT ONE AFTER ANOTHER — WHICH IS WHY THERE
     WAS A CLIFF IN A ROAD JUNCTION.

     Each segment used to pull the grid straight at its own profile:
       H[o] = lerp(H[o], mine, m * 0.92)
     applied in edge order. On a single road that converges on the
     profile and is fine. WHERE TWO ROUTES MEET IT IS LAST-WRITER-WINS,
     and the last writer is a different edge at one grid node than it is
     at the node 2 m away. Two profiles that differ by 0.8 m at a
     junction therefore land on adjacent nodes of a 2 m heightfield, and
     what the player gets is a 48-degree face with a road drawn down it.

     Measured at the Iron Hills / Green Edge junction (-24, -200): the
     collision normal is n.y 0.671, which is 48 degrees — the exact
     slope limit controller.js will let him stand on — inside a graded
     road corridor, on both this build and a clean HEAD archive. It is
     also the whole of what tools/surfacetest.mjs had left to report
     there once the ribbon stopped bridging: raw error 0.001 m, and a
     capsule-lift term of 0.152 m that is not a defect in the ground so
     much as the ground being too steep to be a road at all.

     So the segments ACCUMULATE and the grid is written once. Three
     fields, all in the terrain's own indexing:
       CT/CW  a weighted mean of every profile that reaches this node,
              weighted m*m so the flat centre of a road outvotes the
              feathered skirt of the one crossing it;
       CS     the blend strength the sequential version would have
              reached, built up the same way it was — 1-prod(1-0.92m) —
              so a node covered by four segments is still pulled 99 %
              of the way onto the road and the roads do not go soft.
     Coverage (PATH) and strength are therefore unchanged and only the
     TARGET is different: a junction ramps between the two roads that
     make it instead of stepping between them. */
  const CT = new Float64Array(H.length);
  const CW = new Float64Array(H.length);
  const CS = new Float32Array(H.length);

  function carve(pts, h, width, prio) {
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
          if (m <= 0) continue;
          const o = IX(i2, j);
          if (m > PATH[o]) PATH[o] = m;
          const w = m * m * prio;
          CT[o] += w * lerp(h0, h1, t);
          CW[o] += w;
          CS[o] += 0.92 * m * (1 - CS[o]);
        }
      }
    }
  }

/* THE ROAD NETWORK'S OWN NUMBERS, PUBLISHED.

   `quads`/`fanned`/`worstSag` are filled by buildRibbons() and one of
   them is already cited by name eighty lines below ("Count:
   ctx.world.paths.stats.fanned") — a citation that has never been
   readable, because world.js republishes this module as
   `{nodes, edges, at}` and drops the stats. tools/_pa-census.mjs
   section D printed `paths: undefined` for exactly that reason.

   The three below are the ones a floor census wants and nothing else
   knows: how much road there is to kerb, how it splits between trunk
   roads and lanes, and how many junctions there are — the junction
   count being the ceiling on how many desire paths ground.js can cut
   at corners, which is what sent it looking for destinations instead.
   They are filled at route time, not at draw time, so they are right
   even if buildRibbons() has not run. */
  const stats = {
    quads: 0, fanned: 0, refined: 0, edges: 0, worstSag: 0, verts: 0, tris: 0,
    roadMetres: 0, laneMetres: 0, junctions: 0,
  };

  for (const e of edges) {
    e.points = routePoints(e);
    e.height = profile(e.points);
    /* measured along the ROUTED polyline, not end to end: these roads
       bend round contours and the straight-line figure is 15 % short */
    let m = 0;
    for (let i = 1; i < e.points.length; i++) {
      m += Math.hypot(e.points[i].x - e.points[i - 1].x, e.points[i].z - e.points[i - 1].z);
    }
    e.metres = m;
    if (e.kind === 'road') stats.roadMetres += m; else stats.laneMetres += m;
  }
  /* a junction is a node more than two edges meet at */
  {
    const deg = new Map();
    for (const e of edges) {
      deg.set(e.a.key, (deg.get(e.a.key) || 0) + 1);
      deg.set(e.b.key, (deg.get(e.b.key) || 0) + 1);
    }
    for (const d of deg.values()) if (d > 2) stats.junctions++;
  }
  stats.roadMetres = Math.round(stats.roadMetres);
  stats.laneMetres = Math.round(stats.laneMetres);
  stats.edges = edges.length;
  /* A TRUNK ROAD STILL OUTRANKS A LANE. The old ordering said so by
     carving roads first and letting the lanes overwrite them, which
     gave the lane the last word — the opposite of what the comment
     claimed. Said as a weight it means what it says: at a junction the
     graded surface leans 2:1 toward the through road. */
  for (const e of edges) carve(e.points, e.height, e.width, e.kind === 'road' ? 2 : 1);
  for (let o = 0; o < H.length; o++) {
    if (CW[o] > 0) H[o] = lerp(H[o], CT[o] / CW[o], CS[o]);
  }

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
    let quads = 0, fanned = 0, worstSag = 0, refined = 0;
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
           collision tiles are built from it vertex for vertex, so the
           chord that matters is the one between ribbon vertices — and
           1.5 m was NOT short enough. It is not the raster that a
           bridge spans, it is the KINK: rasterised at 0.5 m over every
           road mesh, a 1.5 m ring still stood 0.276 m over the ground
           at (-24, -200), where the Green Edge lane crosses a bank that
           falls 0.6 m per metre and then flattens inside one metre.

           Halved again to 0.75 m — the same chord the ring now uses
           across — the tail collapses: 17 of 68910 sample points past
           surfacetest's 0.12 m, from 273 before either change, p99.9
           0.089 m. It costs 47.8k road vertices and 82.8k triangles
           across the whole island, in a 5.4 M triangle scene.

           WHAT IS LEFT IS NOT CHORD LENGTH. The worst point is still
           (-24, -200) at 0.254 m, and halving the chord moved it by
           two centimetres, because TWO ribbons are drawn there: the
           district buckets each build their own mesh and the Green
           Edge and Iron Hills lanes overlap across the boundary
           (0.132 m and 0.041 m over the ground at the same point). A
           downward ray takes the higher of the two, so at a junction
           the tail belongs to whichever lane crosses the bank
           sideways. Cutting the ribbon at the boundary, or letting one
           lane win a junction, is the fix; it is not this one. */
        const half = e.width * 0.38;   // the ribbon rides INSIDE the carve
        /* THE CHORD IS CHOSEN PER ROUTE, BY MEASURING IT, NOT SET ONCE
           FOR THE ISLAND.

           0.75 m below is the number the two notes above paid for, and
           on the 130-odd routes that cross open ground it is more than
           enough. It is not enough on the handful cut into a hillside,
           for the reason set out at the bottom of this function: the
           sag of a flat quad over a corner in the ground falls only as
           the SQUARE of the chord, so a route that is 0.25 m out at
           0.75 m is still 0.06 m out at 0.375 m and no single global
           number is right for both kinds of ground.

           So each route is DRY-RUN first — the lattice is walked with
           nothing but heightAt, no rng drawn and no vertex emitted —
           and the chord is halved until the worst quad in it stops
           bridging or the floor is reached. A route that was already
           fine is built at exactly 0.75 m from exactly the same rng
           stream as before, so its geometry is unchanged to the bit.
           Only the rough ones pay, and they pay four times the
           vertices for the stretch that needs it. */
        const STEP0 = 0.75, STEP_MIN = 0.1875;
        const sagOf = (step) => {
          const q = densify(e.points, step);
          const ns = Math.max(1, Math.ceil(half / step));
          let w = 0;
          for (let i = 0; i < q.length - 1; i++) {
            const a0 = q[Math.max(0, i - 1)], a1 = q[Math.min(q.length - 1, i + 1)];
            const b0 = q[i], b1 = q[Math.min(q.length - 1, i + 2)];
            let tx = a1.x - a0.x, tz = a1.z - a0.z; let tl = Math.hypot(tx, tz) || 1;
            const pax = -tz / tl, paz = tx / tl;
            tx = b1.x - b0.x; tz = b1.z - b0.z; tl = Math.hypot(tx, tz) || 1;
            const pbx = -tz / tl, pbz = tx / tl;
            for (let s = -ns; s < ns; s++) {
              const u0 = (half * s) / ns, u1 = (half * (s + 1)) / ns;
              const P = [[q[i].x + pax * u0, q[i].z + paz * u0], [q[i].x + pax * u1, q[i].z + paz * u1],
                [q[i + 1].x + pbx * u1, q[i + 1].z + pbz * u1], [q[i + 1].x + pbx * u0, q[i + 1].z + pbz * u0]];
              let mx = 0, mz = 0, mh = 0;
              for (const [px2, pz2] of P) { mx += px2 * 0.25; mz += pz2 * 0.25; mh += terrain.heightAt(px2, pz2) * 0.25; }
              /* the four edge midpoints matter as much as the middle:
                 a quad's edges are shared with its neighbours and a
                 centre vertex cannot move them */
              let sag = mh - terrain.heightAt(mx, mz);
              for (let k = 0; k < 4; k++) {
                const A = P[k], B = P[(k + 1) % 4];
                const ex2 = (A[0] + B[0]) * 0.5, ez2 = (A[1] + B[1]) * 0.5;
                const es = (terrain.heightAt(A[0], A[1]) + terrain.heightAt(B[0], B[1])) * 0.5 - terrain.heightAt(ex2, ez2);
                if (es > sag) sag = es;
              }
              if (sag > w) w = sag;
            }
          }
          return w;
        };
        let STEP = STEP0;
        while (STEP > STEP_MIN && sagOf(STEP) > 0.045) STEP *= 0.5;
        if (STEP < STEP0) refined++;
        const pts = densify(e.points, STEP);
        /* ...AND ACROSS IT, FOR THE SAME REASON.

           The paragraph above densified the ribbon ALONG the centreline
           and then left it three vertices wide, so every quad was still
           a flat plank up to `half` metres ACROSS — 3.0 m on a main
           road, laid over the same 2 m heightfield. Rasterised at 0.5 m
           over every road mesh, that bridge stood up to 0.404 m over the
           ground it is drawn on at (-23, -200) on the Green Edge lane,
           with 273 of 68903 sample points past surfacetest's 0.12 m.
           That is what the suite reads as a SINK: he stands on the
           terrain collider, which is heightAt vertex for vertex, while
           the tarmac is drawn above his feet — worst walk sample
           -0.139 m at (-314.2, 166) on Rusty Row. Same cure as along:
           no chord, either way, longer than 0.75 m. */
        const NS = Math.max(1, Math.ceil(half / STEP));   // columns per side
        const COLS = NS * 2 + 1;
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
          for (let s = -NS; s <= NS; s++) {
            const t = s / NS;                    // -1 verge .. 0 crown .. +1
            const w = half * t;
            const x = r.x + r.px * w, z = r.z + r.pz * w;
            /* 0.09 m was a z-fighting guard from before the material
               carried a polygon offset. It is now belt AND braces, and
               nine centimetres is a step the player can see himself
               standing in. Three is under the noise. */
            const y = terrain.heightAt(x, z) + 0.03;
            const n = terrain.normalAt(x, z);
            pos.push(x, y, z);
            nrm.push(n.x, n.y, n.z);
            /* 0.12 uv per METRE, not per ring: the ring pitch halved
               and an index-based u would have run the road texture
               twice as fast for a change that is supposed to be
               geometry only. */
            uv.push(i * STEP * 0.12, t * 0.5 + 0.5);
            /* SAMPLED, NOT INTERPOLATED. Three vertices across gave the
               quad a linear crown-to-verge ramp between C_ROAD and
               C_WORN; mixing on |t| is that same ramp evaluated at every
               new column, so the extra geometry changes the surface and
               not the paint. */
            _cc.copy(C_ROAD).lerp(C_WORN, Math.abs(t));
            const k = 0.88 + 0.24 * wear();
            col.push(_cc.r * k, _cc.g * k, _cc.b * k);
          }
        }
        /* AND THE LAST PLACE IT STILL BRIDGES IS THE TOE OF A CUT BANK,
           WHERE NO CHORD LENGTH FIXES IT BECAUSE THE GROUND IS A CORNER.

           The two notes above shortened the chord until the tail
           collapsed, then said the remainder was the two district
           ribbons overlapping at (-24, -200). Re-measured, that is not
           what it is. Every ribbon vertex on the island sits at exactly
           heightAt + 0.030 — 27 greenedge and 64 ironhills vertices
           within 3 m of that point, mean 0.0300, worst 0.0300 — so no
           vertex is wrong. What is wrong is the QUAD BETWEEN them. The
           road is cut into a hillside, `half` is 2.43 m so the ribbon's
           outer columns run up the bank, and at the toe the terrain
           turns a corner: heightAt is 40.374 at (-24, -200) and 40.674
           half a metre away. A flat quad laid over a corner stands
           above it in the middle however short its sides are — halving
           the chord only QUARTERS the sag, which is exactly why 1.5 m
           to 0.75 m moved the worst point by two centimetres, and why
           halving again would have moved it by half of nothing. The
           overlap was a red herring: the higher of the two ribbons was
           simply whichever one's quad happened to span the corner.
           Drawn, it is a 0.25 m lip you can see daylight under.

           So the quads that bridge are found and BROKEN, and only
           those. A quad's bilinear centre is the mean of its four
           corners; the ground under that centre is one heightAt call.
           Where the first stands more than SAG over the second the quad
           gets a centre vertex ON the ground and four triangles instead
           of two, which puts a real sample in the middle of the corner.
           The centre vertex interpolates its neighbours' attributes and
           draws nothing from the wear rng, so every quad that was
           already right is byte-identical to before this paragraph,
           colour included — which is what keeps screenshots comparable.
           It is watertight without neighbour bookkeeping because the
           new vertex is interior: no edge of any quad moves, so no
           T-junction can appear against a quad that was left alone.

           SAG is 0.045 and not 0.12. It is not a tolerance being met,
           it is the size of defect worth two triangles, set at a third
           of surfacetest's SINK_TOL so the fix has headroom rather than
           landing on the line. Count: ctx.world.paths.stats.fanned. */
        const SAG = 0.045;
        for (let i = 0; i < ring.length - 1; i++) {
          const a0 = base + i * COLS, b0 = a0 + COLS;
          for (let s = 0; s < COLS - 1; s++) {
            const a = a0 + s, b = a0 + s + 1, c = b0 + s + 1, d = b0 + s;
            quads++;
            const cx = (pos[a * 3] + pos[b * 3] + pos[c * 3] + pos[d * 3]) * 0.25;
            const cz = (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2] + pos[d * 3 + 2]) * 0.25;
            const chord = (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1] + pos[d * 3 + 1]) * 0.25;
            const gy = terrain.heightAt(cx, cz) + 0.03;
            const sag = chord - gy;
            if (sag <= SAG) { idx.push(a, b, c, a, c, d); continue; }
            if (sag > worstSag) worstSag = sag;
            const m = pos.length / 3;
            const nn = terrain.normalAt(cx, cz);
            pos.push(cx, gy, cz);
            nrm.push(nn.x, nn.y, nn.z);
            uv.push((uv[a * 2] + uv[c * 2]) * 0.5, (uv[a * 2 + 1] + uv[c * 2 + 1]) * 0.5);
            for (let k = 0; k < 3; k++) {
              col.push((col[a * 3 + k] + col[b * 3 + k] + col[c * 3 + k] + col[d * 3 + k]) * 0.25);
            }
            fanned++;
            idx.push(a, b, m, b, c, m, c, d, m, d, a, m);
          }
        }
        base = pos.length / 3;
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
      stats.verts += pos.length / 3;
      stats.tris += idx.length / 3;
    }
    stats.quads = quads; stats.fanned = fanned; stats.refined = refined;
    stats.edges = edges.length;
    stats.worstSag = +worstSag.toFixed(4);
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
    group, material, nodes, edges, stats,
    buildRibbons, distanceToRoad,
    dispose() {
      group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
      material.dispose();
    },
  };
}
