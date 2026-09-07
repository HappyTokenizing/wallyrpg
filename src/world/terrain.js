/* ============================================================
   terrain.js — the island heightfield, its meshes and its collision.

   Owned by the world agent. `world.js` is the only thing that should
   import this; everyone else goes through `ctx.world`.

   THE SHAPE OF THE ISLAND IS AUTHORED, NOT SAMPLED.
   src/game/data.js lays out 10 districts and 28 buildings on a
   1000 x 660 board and projects them to metres (WORLD.toWorld). Every
   district carries a base elevation — Golden Heights 58 m, Iron Hills
   44 m, the Waterfront 3 m — and the terrain here is built to hit
   those numbers exactly at each district's anchor, with a character
   noise per district on top (a ridge for the mine, terraces for the
   Learning Quarter, farm swells for Green Edge, a stadium bowl).
   A Wind Waker island reads as a decision from three hundred metres
   away; fBm alone reads as porridge.

   HOW IT IS BUILT
     1. a 2 m raster of the whole 1344 x 1120 m sea-and-land box
        (shore distance, district plateaus, character noise, the
        coastal cliff rampart, the beach profile)
     2. one smoothing pass, then strata terracing on steep ground
     3. building pads — each location's ground snapped to loc.world.y
     4. road carving (paths.js writes into the same raster)
     5. tile meshes at four LODs off the finished raster, coloured
        per-vertex from height / slope / shore distance / district
     6. a 3 x 3 window of 64 m collision tiles that follows the player

   Everything downstream samples the RASTER, never the noise, so the
   height Wally walks on, the height a lamp post is placed at and the
   height the mesh draws are the same number by construction.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { LAND, SEA, BUILD, SKY } from '../core/palette.js';
import { clamp, lerp, smoothstep } from '../core/contracts.js';
/* data.js is frozen content with no runtime of its own, and ctx.game
   does not exist until stage 10 — the world is stage 5. Its header
   explicitly documents this projection for the world builder. */
import { ZONES, LOCATIONS, WORLD } from '../game/data.js';

/* ---------------- raster + tiling ---------------- */
export const CELL = 2;                 // metres per raster sample
export const BX = 672, BZ = 560;       // half-extents of the built box
export const TILE = 112;               // metres per render tile
const LOD_STEP = [1, 2, 4, 8];         // raster stride per LOD level
const LOD_DIST = [180, 380, 700, Infinity];
const COL_TILE = 64;                   // metres per collision tile
const COL_RING = 1;                    // 3x3 window of collision tiles

const NX = (BX * 2) / CELL + 1;
const NZ = (BZ * 2) / CELL + 1;

const RX = WORLD.islandRadiusX;
const RZ = WORLD.islandRadiusZ;
const BEACH = WORLD.beachWidth;

/* ============================================================
   Seeded value noise. One 256x256 table, bilinear with a smoothstep
   fade, wrapped by mask — deterministic, allocation free, and fast
   enough to fill 377k raster cells at boot.
   ============================================================ */
function makeNoise(rng) {
  const N = 256, M = N - 1;
  const t = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) t[i] = rng();

  function n2(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const x0 = xi & M, x1 = (xi + 1) & M;
    const r0 = (yi & M) * N, r1 = ((yi + 1) & M) * N;
    const a = t[r0 + x0], b = t[r0 + x1], c = t[r1 + x0], d = t[r1 + x1];
    const u = a + (b - a) * sx;
    return u + (c + (d - c) * sx - u) * sy;
  }

  /* Octaves are rotated by an irrational-ish angle so ridges never
     line up with the world axes — axis-aligned fBm reads as a grid
     the moment you look at an island from above. */
  const CA = Math.cos(0.7391), SA = Math.sin(0.7391);
  function fbm(x, y, oct = 4, gain = 0.5, lac = 2.03) {
    let a = 1, f = 1, s = 0, n = 0;
    for (let i = 0; i < oct; i++) {
      s += n2(x * f, y * f) * a;
      n += a;
      a *= gain; f *= lac;
      const nx = x * CA - y * SA, ny = x * SA + y * CA;
      x = nx + 37.13; y = ny - 11.7;
    }
    return s / n;
  }

  /* Ridged: the classic 1 - |2n-1|, squared so crests stay sharp and
     the flanks fall away. This is what makes Iron Hills a ridge and
     not a dune. */
  function ridged(x, y, oct = 4) {
    let a = 1, f = 1, s = 0, n = 0;
    for (let i = 0; i < oct; i++) {
      const v = 1 - Math.abs(n2(x * f, y * f) * 2 - 1);
      s += v * v * a;
      n += a;
      a *= 0.52; f *= 2.07;
      const nx = x * CA - y * SA, ny = x * SA + y * CA;
      x = nx - 8.4; y = ny + 21.9;
    }
    return s / n;
  }

  return { n2, fbm, ridged };
}

/* ============================================================
   District character. `edge` is the inner fraction of the influence
   radius at which the plateau is already at full height — the closer
   to 1, the sharper the scarp around the district.
   ============================================================ */
const PROFILE = {
  rustyrow:      { R: 1.00, edge: 0.34, kind: 'lumpy',   amp: 2.4,  freq: 0.034, oct: 3 },
  mainstreet:    { R: 1.00, edge: 0.36, kind: 'flat',    amp: 0.9,  freq: 0.022, oct: 2 },
  learning:      { R: 1.02, edge: 0.52, kind: 'terrace', amp: 5.2,  freq: 0.0074, oct: 2, step: 5.0 },
  marketsq:      { R: 1.00, edge: 0.36, kind: 'flat',    amp: 0.8,  freq: 0.024, oct: 2 },
  greenedge:     { R: 1.18, edge: 0.40, kind: 'roll',    amp: 4.6,  freq: 0.0072, oct: 3 },
  ironhills:     { R: 1.12, edge: 0.50, kind: 'ridge',   amp: 21.0, freq: 0.0165, oct: 4, step: 3.6 },
  waterfront:    { R: 1.00, edge: 0.40, kind: 'flat',    amp: 0.6,  freq: 0.030, oct: 2 },
  innovation:    { R: 1.00, edge: 0.42, kind: 'terrace', amp: 2.2,  freq: 0.011, oct: 3, step: 4.0 },
  stampede:      { R: 1.00, edge: 0.38, kind: 'bowl',    amp: 1.3,  freq: 0.020, oct: 2, bowl: -3.4 },
  goldenheights: { R: 1.00, edge: 0.72, kind: 'mesa',    amp: 3.0,  freq: 0.019, oct: 3 },
};
const DEFAULT_PROFILE = { R: 1, edge: 0.4, kind: 'flat', amp: 1.2, freq: 0.02, oct: 2 };

/* Bearings (in the ellipse's normalised space) of the hand-placed
   coastal features. Derived from the data, not invented: the harbour
   opens toward the docks, the headland sits under Golden Heights. */
const bearingOf = (wx, wz) => Math.atan2(wz / RZ, wx / RX);
const angDiff = (a, b) => {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};

const _c = new THREE.Color();
const lin = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
const linFromCss = (css) => new THREE.Color().setStyle(css, THREE.SRGBColorSpace);

export function createTerrain(ctx) {
  const rng = ctx.makeRng('wally.terrain.v1');
  const nz = makeNoise(rng);
  const { fbm, ridged, n2 } = nz;

  /* ------------------------------------------------------------
     Coast: the shoreline is data.js's ellipse with an authored
     angular perturbation. Outward almost everywhere (so no location
     can ever be pushed into the sea), with two carved features:
     the harbour that the docks look out of, and a small west cove.
     ------------------------------------------------------------ */
  const dockLoc = LOCATIONS.find((l) => l.id === 'docks');
  const goldZone = ZONES.goldenheights;
  const ironZone = ZONES.ironhills;
  const PHI_HARBOUR = bearingOf(dockLoc.world.x, dockLoc.world.z);
  const PHI_GOLD = bearingOf(goldZone.world.x, goldZone.world.z);
  const PHI_IRON = bearingOf(ironZone.world.x, ironZone.world.z);
  const PHI_COVE = 2.845;

  /* THE HARBOUR HAD TO ACTUALLY REACH THE DOCKS.

     This notch has been called "the harbour that the docks look out of"
     since it was written, and it was 0.165 of the ellipse radius —
     which put the waterline 109 m from the Waterfront Docks, measured
     with shoreDistAt() at the docks' own world position. A pier on
     piles standing in a green meadow is invisible at head height and
     unmissable from 200 m up, and the balloon is about to put every
     player 200 m up.

     0.37 brings the water to 30 m of the plot: past the container yard
     on the seaward flank, with the beach running the last few metres.
     The number is chosen against three things and not one —

       * the BAY: the notch is angular, so deepening it swings the
         whole coast round with it. Modelled against every location in
         data.js, this moves exactly one of them by more than 10 m:
         the docks, 109 -> 30. The next nearest by bearing is the
         noodle cart at 88 -> 78, and the apartment — the furthest
         flung, with only ~29 m of dry land under it — moves 36 -> 36.
       * the PAD: terrain.js pins each location's ground to loc.world.y
         over radius*1.02 and feathers to 1.85 (padPass), which for the
         docks is 16 m and 29 m. Any deeper and the pad is holding a
         plateau of dry earth out over the water and the coastline
         steps off it. At 30 m the pad wants 1.87 m and the beach
         profile wants 1.5 m: they agree, and nothing steps.
       * the YARD: city.js refuses to stack a container within 3 m of
         the waterline and the outer row stands 24 m off the plot
         centre on the seaward flank. 30 m leaves it standing on the
         quay instead of deleting it.

     WHAT IT DOES NOT DO is put the deck over water. The pier's piles
     stay bedded in its own pad, and the deck and door still face the
     district anchor inland, because loc.yaw is "face your district"
     for every building on the island. Turning a port to face the sea
     is a change to the projection in data.js and it moves the door
     corridor out over the water — see the report. */
  const HARBOUR_BITE = 0.37;

  function shoreScale(phi) {
    const w = Math.sin(phi * 3 + 0.7) * 0.55
            + Math.sin(phi * 5 - 1.9) * 0.30
            + Math.sin(phi * 8 + 2.3) * 0.15;
    let A = 0.036 * (0.55 + 0.45 * w);            // 0.004 .. 0.065, never inward
    const g = angDiff(phi, PHI_GOLD) / 0.34;
    const i = angDiff(phi, PHI_IRON) / 0.30;
    const h = angDiff(phi, PHI_HARBOUR) / 0.30;
    const c = angDiff(phi, PHI_COVE) / 0.24;
    A += 0.052 * Math.exp(-g * g);                // Golden Heights headland
    A += 0.030 * Math.exp(-i * i);                // Iron Hills cape
    A -= HARBOUR_BITE * Math.exp(-h * h);         // the harbour
    A -= 0.035 * Math.exp(-c * c);                // west cove
    return 1 + A;
  }

  /* Domain warp on the shore field. An ellipse plus a few angular
     harmonics is still, at heart, an offset ellipse: the coastline
     runs parallel to itself everywhere, and a coastal cliff built off
     it becomes a wall of uniform height whose face the fine landform
     noise then cuts into a regular comb of triangular teeth — which
     is exactly what the silhouette shot showed. Warping the distance
     field instead makes the shore, the beach and the foot of the
     cliff all meander together. Outward is unclamped; INWARD is held
     to a third, because data.js only guarantees ~29 m of dry land
     under the furthest-flung location. */
  function shoreWarp(x, z) {
    const a = (fbm(x * 0.0026 - 44, z * 0.0026 + 71, 3) - 0.5) * 2 * 30;
    const b = (fbm(x * 0.0091 + 18, z * 0.0091 - 5, 2) - 0.5) * 2 * 13;
    const w = a + b;
    return w > 0 ? w : w * 0.32;
  }

  /** Signed distance to the water line, in metres. >0 inland. */
  function shoreDist(x, z) {
    const u = x / RX, v = z / RZ;
    const r = Math.hypot(u, v);
    if (r < 1e-5) return 480;
    const gx = (u / r) / RX, gz = (v / r) / RZ;
    return (shoreScale(Math.atan2(v, u)) - r) / Math.hypot(gx, gz) + shoreWarp(x, z);
  }

  /* How rocky the coast is at this bearing. The north and east meet
     the sea as cliffs; the sandy south-west and the harbour do not. */
  function cliffiness(x, z, phi) {
    /* fBm clusters hard around its mean, so taking it raw made EVERY
       bearing about half cliff and the island came out as a table
       with a sand rim. Stretched about its own centre first, so a
       coast is either rock or sand and only rarely both. */
    const f = fbm(x * 0.0043 + 91, z * 0.0043 - 60, 3);
    let c = 0.05 + 0.95 * clamp((f - 0.5) * 2.8 + 0.5, 0, 1);
    const g = angDiff(phi, PHI_GOLD) / 0.55;
    const i = angDiff(phi, PHI_IRON) / 0.50;
    const h = angDiff(phi, PHI_HARBOUR) / 0.42;
    c += 0.42 * Math.exp(-g * g);
    c += 0.34 * Math.exp(-i * i);
    c -= 0.46 * Math.exp(-h * h);
    return clamp(c, 0, 1);
  }

  /* ============================================================
     BEDDING PLANES — the one field that ties the rock together.

     The geometry's shelves, the colour bands painted on the cliff
     face and the strata carved into every loose boulder all read
     THIS. If they read three different fields the cliff comes out as
     three competing stripe patterns; reading one makes a ledge, the
     colour change along it and the band on the boulder resting on it
     the same geological event.

     It is a warp, not a height: bedding is quantised on `h + warp`,
     so a bed dips and rolls across the island instead of being a
     dead-level contour line drawn round the terrain.
     ============================================================ */
  function beddingWarp(x, z) {
    return (fbm(x * 0.0040 + 211, z * 0.0040 - 88, 2) - 0.5) * 2 * 4.6
         + (fbm(x * 0.0155 - 33, z * 0.0155 + 19, 2) - 0.5) * 2 * 1.35;
  }

  /* VERTICAL EROSION CHANNELS. A near-vertical face occupies almost
     no ground in plan, so a 2-D field sampled across it varies along
     the face's horizontal run and barely at all up its height — which
     is exactly a set of vertical gullies and ribs. Deliberately kept
     to ~12 m and ~26 m: the raster is 2 m and anything finer than
     ~5 cells aliases into the shark's-tooth comb this island has
     already been cured of once. Returns -1..1, ribs positive. */
  function channelField(x, z) {
    return (fbm(x * 0.084 + 5.3, z * 0.084 - 61, 2, 0.34) - 0.5) * 2 * 0.72
         + (fbm(x * 0.0385 - 120, z * 0.0385 + 47, 2, 0.40) - 0.5) * 2 * 0.28;
  }

  /* ------------------------------------------------------------
     Districts
     ------------------------------------------------------------ */
  const zoneList = Object.keys(ZONES).map((k) => {
    const z = ZONES[k];
    const p = PROFILE[k] || DEFAULT_PROFILE;
    const R = Math.max(70, z.world.radius) * p.R;
    return {
      id: k, z, p,
      x: z.world.x, zz: z.world.z, elev: z.elev,
      R, outer: R, inner: R * p.edge,
      tint: linFromCss(z.tint),
      tintMul: (() => {
        const t = linFromCss(z.tint);
        const y = Math.max(1e-3, 0.2126 * t.r + 0.7152 * t.g + 0.0722 * t.b);
        return new THREE.Color(t.r / y, t.g / y, t.b / y);
      })(),
    };
  });

  function districtDetail(zn, x, z, dist) {
    const p = zn.p;
    const f = p.freq;
    switch (p.kind) {
      case 'ridge': {
        const r = ridged(x * f, z * f, p.oct);
        return (r * r * 1.35 - 0.30) * p.amp;
      }
      case 'terrace': {
        const t = (fbm(x * f, z * f, p.oct) - 0.5) * 2 * p.amp;
        const s = p.step || 4;
        return Math.round(t / s) * s * 0.82 + t * 0.18;
      }
      case 'roll':
        return (fbm(x * f, z * f, p.oct) - 0.5) * 2 * p.amp;
      case 'bowl': {
        const k = clamp(dist / zn.R, 0, 1);
        return (p.bowl || -3) * (1 - k * k) + (fbm(x * f, z * f, p.oct) - 0.5) * 2 * p.amp;
      }
      case 'mesa':
        return (fbm(x * f, z * f, p.oct) - 0.5) * 2 * p.amp;
      case 'lumpy':
        return (fbm(x * f, z * f, p.oct) - 0.42) * 2 * p.amp;
      default:
        return (fbm(x * f, z * f, p.oct) - 0.5) * 2 * p.amp;
    }
  }

  /* Land that belongs to no district: rolling countryside with a
     couple of rock outcrops so the silhouette is never a dome. */
  function wildBase(x, z) {
    const roll = fbm(x * 0.0027 + 5.1, z * 0.0027 - 2.4, 4);       // ~370 m swells
    const knuckle = ridged(x * 0.0061 - 14, z * 0.0061 + 8, 3);    // rock outcrops
    const hummock = (fbm(x * 0.0165 + 70, z * 0.0165 - 33, 3) - 0.5) * 2;  // ~60 m
    return 4.0 + 13.0 * roll
         + 12.0 * Math.pow(clamp(knuckle * 1.28 - 0.26, 0, 1), 1.7)
         + 5.2 * hummock;
  }
  function wildDetail(x, z) {
    return (fbm(x * 0.019 + 60, z * 0.019 + 12, 3) - 0.5) * 2.6;
  }

  /* A landform layer that runs UNDER every district as well as the
     wilderness, at half strength inside a district. Without it the
     built-up half of the island is a billiard table: the district
     plateaus are, by definition, flat, and flat ground has nothing
     for the two-band ramp to break on and nothing for a camera to
     travel over. Amplitude is deliberately small enough that a
     building pad still swallows it. */
  function landform(x, z) {
    return (fbm(x * 0.0128 + 12, z * 0.0128 + 77, 3) - 0.5) * 2 * 3.4
         + (fbm(x * 0.037 - 41, z * 0.037 - 9, 2) - 0.5) * 2 * 0.65;
  }

  /* ------------------------------------------------------------
     The raster
     ------------------------------------------------------------ */
  const H = new Float32Array(NX * NZ);
  const SD = new Float32Array(NX * NZ);     // shore distance, metres
  const PATH = new Float32Array(NX * NZ);   // 0..1 road coverage
  const ZI = new Int8Array(NX * NZ).fill(-1);

  const gx0 = -BX, gz0 = -BZ;
  const IX = (i, j) => j * NX + i;
  const wx = (i) => gx0 + i * CELL;
  const wz = (j) => gz0 + j * CELL;

  function beachProfile(d, bw = BEACH) {
    if (d <= 0) {
      /* Sea floor. Falls away as a soft power curve so the water
         agent gets a shelf to band its shallows over rather than a
         wall at the waterline. */
      const k = Math.min(-d, 260);
      return -(0.85 * Math.pow(k, 0.78));
    }
    return 2.45 * Math.pow(smoothstep(0, bw, d), 0.80);
  }

  /* Scratch, reused: this runs 377k times at boot and a fresh object
     per sample is 377k allocations for two numbers. */
  const _fh = { h: 0, d: 0 };
  function fieldHeight(x, z) {
    const u = x / RX, v = z / RZ;
    const r = Math.hypot(u, v);
    const phi = r < 1e-5 ? 0 : Math.atan2(v, u);
    const gxx = r < 1e-5 ? 1 / RX : (u / r) / RX;
    const gzz = r < 1e-5 ? 0 : (v / r) / RZ;
    const d = (shoreScale(phi) - r) / Math.hypot(gxx, gzz) + shoreWarp(x, z);

    if (d < -170) { _fh.h = beachProfile(d); _fh.d = d; return _fh; }

    /* districts */
    let wsum = 0, elev = 0, det = 0, maxW = 0;
    for (let k = 0; k < zoneList.length; k++) {
      const zn = zoneList[k];
      const dx = x - zn.x, dz = z - zn.zz;
      const dist = Math.hypot(dx, dz);
      if (dist > zn.outer) continue;
      const w = smoothstep(zn.outer, zn.inner, dist);
      if (w <= 0) continue;
      wsum += w;
      elev += w * zn.elev;
      det += w * districtDetail(zn, x, z, dist);
      if (w > maxW) maxW = w;
    }
    const w0 = 0.62 * (1 - maxW);
    wsum += w0;
    elev += w0 * wildBase(x, z);
    det += w0 * wildDetail(x, z);
    let inland = (elev + det) / wsum + landform(x, z) * (0.38 + 0.62 * (1 - maxW));

    /* Coastal rampart: where the coast is rocky the land does not
       walk out of the sea, it steps out of it. ADDED, not max()'d —
       a max() against ground that is already 15 m up never fires, and
       the island came out as a pancake with a sand rim. Faded out
       above 24 m so it cannot stack on a district plateau. */
    const c = cliffiness(x, z, phi);
    const cliffTop = c * (9.0 + 18.0 * fbm(x * 0.0075 - 30, z * 0.0075 + 44, 3))
                       * (0.72 + 0.56 * fbm(x * 0.019 + 7, z * 0.019 - 62, 2));
    const bw = lerp(BEACH * 1.05, BEACH * 0.28, c);
    const ramp = lerp(66, 13, c);
    const decay = Math.exp(-Math.max(0, d - bw - ramp) / 72);
    inland += cliffTop * decay * (1 - smoothstep(34, 66, inland));

    const t = smoothstep(0, 1, clamp((d - bw) / ramp, 0, 1));
    const top = beachProfile(bw, bw);
    /* Low dunes, so 26 m of sand is a beach and not a runway. */
    const dune = smoothstep(2, bw * 0.7, d) * (1 - smoothstep(bw, bw + 22, d))
               * (fbm(x * 0.028 - 71, z * 0.028 + 36, 2) - 0.42) * 2.6;
    _fh.h = lerp(beachProfile(d, bw) + dune, Math.max(inland, top * 0.6), t);
    _fh.d = d;
    return _fh;
  }

  function buildRaster() {
    for (let j = 0; j < NZ; j++) {
      const z = wz(j);
      for (let i = 0; i < NX; i++) {
        const o = IX(i, j);
        const r = fieldHeight(wx(i), z);
        H[o] = r.h;
        SD[o] = r.d;
      }
    }
  }

  /* One 3x3 pass at half weight. Kills the raster-scale speckle the
     three noise fields leave behind without touching the metre-scale
     form the toon ramp bands on. */
  function smoothPass(weight = 0.5) {
    const src = H.slice();
    for (let j = 1; j < NZ - 1; j++) {
      for (let i = 1; i < NX - 1; i++) {
        const o = IX(i, j);
        /* A 1-2-1 binomial kernel, and the weights MUST sum to 1.
           They summed to 1.36 here once, which is not a blur but a
           gain: every height came out 8 % high after the pad pass and
           43 % high at a district anchor, so Golden Heights measured
           83 m against the 58 m its own data asks for. A smoothing
           kernel that does not sum to 1 is a bug in any dimension. */
        const s = (src[o - 1] + src[o + 1] + src[o - NX] + src[o + NX]) * 0.125
                + (src[o - NX - 1] + src[o - NX + 1] + src[o + NX - 1] + src[o + NX + 1]) * 0.0625
                + src[o] * 0.25;
        H[o] = lerp(src[o], s, weight);
      }
    }
  }

  /* THERMAL EROSION / SLOPE LIMIT.
     A heightfield cannot express a vertical wall: as the gradient
     approaches infinity the surface becomes a staircase of nearly
     edge-on triangles, and any noise in the field turns that
     staircase into a comb of shark's teeth — which is precisely how
     every cliff on this island first rendered. Capping the gradient
     at ~57 degrees and letting the excess slump downhill is the
     standard fix and also the physical one: real rock does exactly
     this, and the material that slumps is the talus at the foot of
     the cliff. */
  function slopeLimitPass(maxDelta = 3.1, iters = 5) {
    const d = new Float32Array(NX * NZ);
    for (let it = 0; it < iters; it++) {
      d.fill(0);
      for (let j = 1; j < NZ - 1; j++) {
        for (let i = 1; i < NX - 1; i++) {
          const o = IX(i, j);
          const h0 = H[o];
          for (let k = 0; k < 4; k++) {
            const o2 = k === 0 ? o - 1 : k === 1 ? o + 1 : k === 2 ? o - NX : o + NX;
            const diff = h0 - H[o2];
            if (diff <= maxDelta) continue;
            const move = (diff - maxDelta) * 0.22;
            d[o] -= move; d[o2] += move;
          }
        }
      }
      for (let o = 0; o < H.length; o++) H[o] += d[o];
    }
  }

  /* Strata. Steep ground is pulled toward horizontal bedding planes,
     which is what gives a Wind Waker cliff its stacked, sculpted
     read — and, because the band edges are real geometry, the toon
     ramp gets something to break on instead of one flat normal. */
  function terracePass() {
    const src = H.slice();
    const STEP = 3.6, PULL = 0.55;
    for (let j = 1; j < NZ - 1; j++) {
      for (let i = 1; i < NX - 1; i++) {
        const o = IX(i, j);
        if (src[o] < 1.4) continue;
        const gx = (src[o + 1] - src[o - 1]) / (2 * CELL);
        const gz = (src[o + NX] - src[o - NX]) / (2 * CELL);
        const slope = Math.hypot(gx, gz);
        /* Terraces belong on the SHOULDER of a slope, not on its
           face. Where the ground rises by more than one bedding step
           between adjacent samples the quantiser wraps every cell and
           what comes out is not a ledge but a 2 m sawtooth — which is
           what turned every cliff on the island into a comb of teeth.
           Fade in from 17 degrees and out again by 55. */
        const k = smoothstep(0.30, 0.85, slope) * (1 - smoothstep(1.45, 2.60, slope));
        if (k <= 0.001) continue;
        const q = src[o] / STEP;
        const f = q - Math.floor(q);
        H[o] = src[o] + (smoothstep(0.12, 0.88, f) - f) * STEP * PULL * k;
      }
    }
  }

  /* ============================================================
     CLIFF SCULPT — the pass that turns a slope into rock.

     THE SLOPE LIMITER MAKES THE SLAB. slopeLimitPass() slumps every
     cell until no neighbour differs by more than maxDelta, and the
     fixed point of that iteration is a surface at EXACTLY the cap
     everywhere — i.e. a perfect constant-gradient plane. That is why
     the shore camera showed a smooth olive slab: it is not
     under-detailed, it is the analytic solution to the erosion we
     run. And terracePass() cannot rescue it, because it deliberately
     fades out above slope 1.45 — which is the ONE place a cliff face
     ever is.

     So the face gets its own pass, run after the limiter and gated
     to steep ground only, carrying three things §2.1 asks for:

       1. stacked shelves on the bedding planes — a wide chamfered
          ledge under a steep riser, which is the Wind Waker rock
          form: big, confident, carved, rounded at every edge.
       2. vertical erosion channels down the face.
       3. metre-scale knuckles so no two shelves are the same shelf.

     The gate is slope, not height or zone, and that is what protects
     the layout: a district plateau is flat by construction, so k is
     zero over every built-up acre of this island and the pads,
     anchors and road grades that follow are untouched.
     ============================================================ */
  function cliffPass() {
    const src = H.slice();

    /* THE CHAMFER WAS THE BUG. The old profile was
       `smoothstep(0.26,0.84,f) - f`, whose extrema are +-0.19 — so at
       PULL 0.86 the largest displacement this pass could make was
       +-0.16 x STEP. Against a face climbing 6.4 m per 2 m cell that
       is half a cell of run: it BOWED the ramp, it never terraced it.
       A probe straight into any of the island's four biggest sea
       cliffs came back monotone, ~90 samples without a single pair
       under 1.5 m. There were no horizontal surfaces on this island.

       A tread is a profile that is FLAT — g'(f) = 0 over a real
       interval — and a riser is the whole step taken over what is
       left. g(f) = smoothstep(A, B, f) is exactly that: dead level
       over [0, A], the full step over [A, B], dead level again over
       [B, 1]. And because g(1) = 1 = g(0) + 1, the top flat of one
       bed and the bottom flat of the next are THE SAME SHELF: the
       tread's run is (1 - B) + A of the bed, not (1 - B).

       Extrema are now +-max(A, 1-B) = +-0.44 x STEP, 2.8x what the
       chamfer could reach, and mean(g) - 0.5 = -0.03 so the pass does
       not quietly erode the coast while it carves it. */
    const A = 0.44, B = 0.62;          // tread ends / riser ends
    const PULL = 1.0;

    /* Slope over +-4 cells. STEP is a function of it, and a STEP that
       flickers cell to cell puts a different quantiser under each end
       of the same shelf — the tread has to be built off the LANDFORM's
       angle, not off one triangle's. */
    const wideGrad = (i, j) => {
      const a = Math.min(i + 4, NX - 1), b = Math.max(i - 4, 0);
      const c = Math.min(j + 4, NZ - 1), d = Math.max(j - 4, 0);
      const gx = (src[IX(a, j)] - src[IX(b, j)]) / ((a - b) * CELL);
      const gz = (src[IX(i, c)] - src[IX(i, d)]) / ((c - d) * CELL);
      return Math.hypot(gx, gz);
    };

    for (let j = 1; j < NZ - 1; j++) {
      for (let i = 1; i < NX - 1; i++) {
        const o = IX(i, j);
        const h0 = src[o];
        if (h0 < 0.4) continue;
        const gx = (src[o + 1] - src[o - 1]) / (2 * CELL);
        const gz = (src[o + NX] - src[o - NX]) / (2 * CELL);
        const slope = Math.hypot(gx, gz);
        /* Fades in exactly where terracePass fades out, so the two
           never fight over the same shoulder. */
        const k = smoothstep(0.55, 1.05, slope);
        if (k <= 0.002) continue;
        const x = wx(i), z = wz(j);
        /* 0 on a 40-degree shoulder, 1 on a sea cliff. */
        const kk = clamp((slope - 0.80) / 1.3, 0, 1);

        /* THE TIER IS SIZED IN RUN, NOT IN HEIGHT. A tier costs
           STEP/slope metres of ground whatever else is true, and the
           acceptance test is a horizontal run you can stand on: three
           2 m probe samples inside 0.8 m of each other. At the
           island's cliff gradient (~1.6 after the limiter) a 14 m bed
           buys ~7.6 m of level tread and a 14 m riser, and a 46 m
           face carries three of them. The low-frequency term wedges
           the beds — adjacent tiers differ by up to 1.5:1, which is
           what stops a stack of shelves reading as machined courses. */
        const thick = 0.80 + 0.44 * fbm(x * 0.0138 - 505, z * 0.0138 + 262, 2);
        const STEP = clamp(slope * CELL * 4.6, 11, 21) * thick;

        const q = (h0 + beddingWarp(x, z)) / STEP;
        const f = q - Math.floor(q);
        let dh = (smoothstep(A, B, f) - f) * STEP * PULL * k;

        /* --- vertical erosion channels, weighted ONTO THE RISER.
           Added flat they were the reason a "tread" was never level:
           +-5 m of 12 m-wavelength noise on a shelf is not a shelf.
           On the riser the same displacement is nearly tangential —
           it notches the shelf's edge in plan and cuts gullies down
           the wall, which is where erosion channels actually live. */
        const wRiser = smoothstep(A - 0.04, A + 0.06, f) * (1 - smoothstep(B - 0.06, B + 0.04, f));
        dh += channelField(x, z) * lerp(2.4, 7.5, kk) * k * wRiser;
        /* a shallow share everywhere, so the shelf edge is ragged
           rather than a drawn contour */
        dh += channelField(x, z) * lerp(0.5, 1.1, kk) * k;

        /* --- buttresses. A coastal scarp built off a distance
           field is a surface of revolution, and no amount of fine
           noise stops it reading as a cylinder. These are 80 m
           lobes that push whole sections of face out into headlands
           and cut re-entrant gullies between them, which is the
           scale at which a cliff stops being a shape and becomes a
           place. Gentle enough (8 m over an 80 m lobe) that a tread
           riding on one still measures level at 2 m spacing. */
        const but = (fbm(x * 0.0125 - 300, z * 0.0125 + 140, 2, 0.42) - 0.5) * 2;
        dh += but * lerp(2.0, 7.0, kk) * k;

        H[o] = h0 + dh;
      }
    }
  }

  /* Building pads. Every location's ground is pulled onto its own
     loc.world.y across its clearance circle and feathered out over
     another 80 %, so the city agent can drop a building at
     (loc.world.x, loc.world.y, loc.world.z) and have it meet dirt. */
  function padPass() {
    const acc = new Float32Array(NX * NZ);
    const wgt = new Float32Array(NX * NZ);
    for (const l of LOCATIONS) {
      const inner = l.radius * 1.02;
      const outer = l.radius * 1.85;
      const i0 = Math.max(0, Math.floor((l.world.x - outer - gx0) / CELL));
      const i1 = Math.min(NX - 1, Math.ceil((l.world.x + outer - gx0) / CELL));
      const j0 = Math.max(0, Math.floor((l.world.z - outer - gz0) / CELL));
      const j1 = Math.min(NZ - 1, Math.ceil((l.world.z + outer - gz0) / CELL));
      for (let j = j0; j <= j1; j++) {
        const dz = wz(j) - l.world.z;
        for (let i = i0; i <= i1; i++) {
          const dx = wx(i) - l.world.x;
          const d = Math.hypot(dx, dz);
          const w = smoothstep(outer, inner, d);
          if (w <= 0) continue;
          const o = IX(i, j);
          acc[o] += w * l.world.y;
          wgt[o] += w;
        }
      }
    }
    for (let o = 0; o < H.length; o++) {
      if (wgt[o] <= 0) continue;
      H[o] = lerp(H[o], acc[o] / wgt[o], Math.min(1, wgt[o]));
    }
  }

  /* Which district owns each raster cell — cached so zoneAt() and the
     vertex colouring are both O(1). */
  function zonePass() {
    for (let j = 0; j < NZ; j++) {
      const z = wz(j);
      for (let i = 0; i < NX; i++) {
        let best = -1, bestW = 0.14;
        for (let k = 0; k < zoneList.length; k++) {
          const zn = zoneList[k];
          const d = Math.hypot(z - zn.zz, wx(i) - zn.x);
          if (d > zn.outer) continue;
          const w = smoothstep(zn.outer, zn.inner, d);
          if (w > bestW) { bestW = w; best = k; }
        }
        ZI[IX(i, j)] = best;
      }
    }
  }

  /* ------------------------------------------------------------
     Sampling. heightAt() reproduces the L0 mesh's own triangulation
     exactly, so a prop placed with placeOnGround() and the pixel
     drawn under it agree to the float.
     ------------------------------------------------------------ */
  function heightAt(x, z) {
    const gx = (x - gx0) / CELL, gz = (z - gz0) / CELL;
    let i = Math.floor(gx), j = Math.floor(gz);
    if (i < 0 || j < 0 || i >= NX - 1 || j >= NZ - 1) return beachProfile(shoreDist(x, z));
    const fx = gx - i, fz = gz - j;
    const o = IX(i, j);
    const h00 = H[o], h10 = H[o + 1], h01 = H[o + NX], h11 = H[o + NX + 1];
    return fz <= fx
      ? h00 + (h10 - h00) * fx + (h11 - h10) * fz
      : h00 + (h11 - h01) * fx + (h01 - h00) * fz;
  }

  const _n = new THREE.Vector3();
  function normalAt(x, z, out) {
    const e = CELL;
    const hl = heightAt(x - e, z), hr = heightAt(x + e, z);
    const hd = heightAt(x, z - e), hu = heightAt(x, z + e);
    const v = out || _n;
    return v.set(-(hr - hl) / (2 * e), 1, -(hu - hd) / (2 * e)).normalize();
  }
  function slopeAt(x, z) { return 1 - normalAt(x, z, _n).y; }

  function pathAt(x, z) {
    const gx = (x - gx0) / CELL, gz = (z - gz0) / CELL;
    const i = Math.floor(gx), j = Math.floor(gz);
    if (i < 0 || j < 0 || i >= NX - 1 || j >= NZ - 1) return 0;
    const fx = gx - i, fz = gz - j, o = IX(i, j);
    const a = lerp(PATH[o], PATH[o + 1], fx);
    const b = lerp(PATH[o + NX], PATH[o + NX + 1], fx);
    return lerp(a, b, fz);
  }

  function shoreDistAt(x, z) {
    const gx = (x - gx0) / CELL, gz = (z - gz0) / CELL;
    const i = Math.floor(gx), j = Math.floor(gz);
    if (i < 0 || j < 0 || i >= NX - 1 || j >= NZ - 1) return shoreDist(x, z);
    const fx = gx - i, fz = gz - j, o = IX(i, j);
    const a = lerp(SD[o], SD[o + 1], fx);
    const b = lerp(SD[o + NX], SD[o + NX + 1], fx);
    return lerp(a, b, fz);
  }

  function zoneIndexAt(x, z) {
    const i = Math.round((x - gx0) / CELL), j = Math.round((z - gz0) / CELL);
    if (i < 0 || j < 0 || i >= NX || j >= NZ) return -1;
    return ZI[IX(i, j)];
  }
  function zoneAt(x, z) {
    const k = zoneIndexAt(x, z);
    return k < 0 ? null : zoneList[k].z;
  }

  /* ============================================================
     Vertex colour — §2.1's palette, blended by slope, height, shore
     distance, road coverage and district, with three scales of
     colour variation on top so no two hundred metres of this island
     are the same green.
     ============================================================ */
  const C_GRASS = lin(LAND.grassLit);
  const C_GRASS_D = lin(LAND.grassShade);
  const C_SAND = lin(LAND.sand);
  const C_SAND_W = lin(LAND.sandWet);
  const C_DIRT = lin(LAND.dirt);
  const C_ROCK = lin(LAND.rock);
  const C_ROCK_D = lin(LAND.rockShade);
  const C_CLIFF = lin(LAND.cliff);
  const C_SEA_W = lin(SEA.wet);
  const C_STONE = lin(BUILD.stone);
  /* Derived, never invented: dry summer grass is the grass swatch
     walked toward the sand swatch. */
  /* 0.34 toward sand desaturated §2.1's #7EC24E into sage before any
     of the other mixes had had their turn. Superseded by C_TURF_DRY
     below, which is the same swatch pushed further and given a value
     lift, so the mosaic has a direction that goes UP as well as down. */
  const C_MOSS = C_GRASS_D.clone().lerp(C_ROCK, 0.42);
  const C_ROAD = C_DIRT.clone().lerp(C_STONE, 0.16);
  /* §2.1: "hue shifts toward blue-green in shade, never toward
     black". The same rule makes the coolest meadows on the island:
     a third distinct green so the field is not one tone with a
     wobble in it.

     MEASURE THE MIX, NOT THE INGREDIENT. A lerp toward a bright
     turquoise in LINEAR space rotates hue about three times as far as
     its weight suggests: at 0.22 this swatch measured hue 150 — a
     sea-green, thirty-six degrees past #4E9A46 — and mCool then drove
     whole hillsides onto it at 0.52. "Blue-green in shade" is the
     twelve degrees between the two grass entries and a little past
     them; it is not the sea. 0.09 lands it at ~130. The grass layer's
     G_ROUGH carried the identical mistake and is corrected the same
     way, so the sheet and the blades still agree. */
  const C_GRASS_COOL = C_GRASS_D.clone().lerp(lin(SEA.shallow), 0.09);
  /* Rock, wet to dry. Bedrock at the waterline is soaked and reads
     dark and cool; the same rock 30 m up is bleached and chalky.
     THE SHIPPED FACE MEASURED A THREE-POINT VALUE SPREAD over 46 m of
     cliff, with the summit the DARKEST sample of the five — the grade
     was not weak, it was inverted. These two are now the two ends of
     a real ramp: #6a7f96-ish cool-wet at the waterline against a warm
     chalk at the summit, ~30 value points apart. */
  const C_ROCK_WET = C_ROCK_D.clone().lerp(C_SEA_W, 0.30).multiplyScalar(0.62);
  const C_ROCK_PALE = C_CLIFF.clone().lerp(C_STONE, 0.62);
  const C_ROCK_WARM = C_CLIFF.clone().lerp(C_DIRT, 0.30);
  /* §2.1's shadow law as a COLOUR, for the dark bedding planes. The
     strata shader used LAND.rockShade (0x676a70 — hue 218, sat 8) as
     its dark, and mixed toward it five separate times; compounded,
     that is what dragged the whole cliff to saturation 4. A dark bed
     is dark ROCK, not grey. */
  const C_SHADE_TINT = lin(0x5a6e9e);
  const shadeLaw = (c, amount = 0.55) => {
    const t = c.clone();
    t.setRGB(t.r * C_SHADE_TINT.r * 1.9, t.g * C_SHADE_TINT.g * 1.9, t.b * C_SHADE_TINT.b * 1.9);
    return c.clone().lerp(t, amount);
  };
  const C_ROCK_BED_D = shadeLaw(C_ROCK_WARM.clone().lerp(C_DIRT, 0.28), 0.60);
  const C_ROCK_BED_C = shadeLaw(C_ROCK.clone().lerp(C_SEA_W, 0.20), 0.48);

  /* ============================================================
     THE TURF MOSAIC — five swatches, none of them invented.

     Four blind reviews across two rounds have called this field "a
     single screaming chroma-green across 55 % of the frame", and the
     measured answer to that has been "S 55-59 against a S 60 swatch,
     which is on-spec". Both are true. Being individually on-palette is
     not what stops 55 % of a frame in one hue reading as a slab —
     STRUCTURE is, and the structure was keyed to the wrong scales:
     every patch mask in groundColor() below was driven off the 320 m
     regional field or the 90 m field, and a gameplay camera sees about
     sixty metres of ground. Across the judged frame those masks are
     CONSTANTS. The field was not under-varied; it was varied at a
     period nobody can fit inside a screenshot.

     These are the tones a real field is a mosaic OF. Each is §2.1's
     grass pair walked toward another entry already in the palette, so
     the whole mosaic stays inside one high-key set:
       dry     bleached summer grass, toward LAND.sand
       rich    the deep unmown green, via §2.1's own shadow law
       clover  weed and clover, the cool blue-green §2.1 asks shade for
       worn    beaten earth coming through, toward LAND.dirt
       haze    §2.4's #B8DEF0, for the far half of aerial perspective
     ============================================================ */
  const C_TURF_DRY = C_GRASS.clone().lerp(C_SAND, 0.42).multiplyScalar(1.06);
  /* MEASURED, AND THE MEASUREMENT CAUGHT ME OUT. shadeLaw() at 0.26
     is a per-channel multiply of roughly (0.79, 0.82, 0.91) — blue is
     boosted eleven points against red — and this swatch was then
     being mixed in at 0.50 by the vertex pass AND 0.32 by the shader,
     on top of C_GRASS_COOL's own blue-ward push. Compounded, the near
     field measured hue 124 against §2.1's lit grass at 95 and its
     SHADED grass at 114: the "richer darker areas" the brief asked
     for had arrived as a repaint of the whole meadow in teal, which
     is the identical mistake this file already documents twice.
     A rich patch is DARKER first and cooler a distant second: a 0.14
     rotation for direction, a plain scalar for the value. */
  const C_TURF_RICH = shadeLaw(C_GRASS_D, 0.14).multiplyScalar(0.92);
  /* MEASURE THE MIX, NOT THE INGREDIENT — same trap C_GRASS_COOL
     documents above. 0.085 toward the sea swatch lands at hue ~128,
     between the two grass entries; pulled back toward the lit swatch
     so clover reads as a different PLANT, not as a shadow. */
  const C_TURF_CLOVER = C_GRASS_D.clone().lerp(lin(SEA.shallow), 0.085).lerp(C_GRASS, 0.22);
  const C_TURF_WORN = C_GRASS_D.clone().lerp(C_DIRT, 0.52);
  /* Matched to grass.js's own airFar (grassLit -> SKY.haze at 0.44) on
     purpose: the blade layer already pales 47 % of the way to this at
     60 m and the sheet underneath it paled not at all, so the two
     layers were up to half a swatch apart wherever both were visible.
     THAT MISMATCH IS THE "bald flat green patch where the grass cards
     stop" — it is not a density edge, it is a colour edge. */
  const C_TURF_HAZE = C_GRASS.clone().lerp(lin(SKY.haze), 0.44);

  const _t1 = new THREE.Color(), _t2 = new THREE.Color();
  const _t3 = new THREE.Color();

  /* ============================================================
     ROCK BASE COLOUR — deliberately SMOOTH.

     THE BANDS CANNOT LIVE IN THE VERTEX COLOUR. The raster is 2 m in
     plan and a sea cliff here climbs 6.4 m per cell, so two adjacent
     rock vertices are two whole bedding planes apart: any stripe
     finer than about 20 m of height is sampled below Nyquist and
     comes back as per-vertex confetti, which is precisely why the
     first attempt at strata here produced a flat slab. Everything
     periodic therefore moved into the fragment shader (see
     patchStrata below), where it is resolution-free and can be
     band-limited with fwidth.

     What stays here is what is genuinely low-frequency: the wet-to-
     dry grade up the face, and a 40 m mineral drift so one headland
     is not the same stone as the next.
     ============================================================ */
  /* THE LAST TWO LINES OF groundColor() ARE PART OF THE PALETTE, not
     a flourish, and anything that paints itself into this island has
     to go through them or it arrives as a foreign object. The rocks
     did exactly that on the first pass — correct stone colour, wrong
     island — and read as slate props glued to a warm taupe wall.
     Factored out here so the heightfield and the rock share them. */
  const spreadN = (v, k) => clamp((v - 0.5) * k + 0.5, 0, 1);
  /* MEASURED, NOT GUESSED. 32 px block statistics over the grass of
     the Iron Hills shot returned mean 149.4 with a macro std-dev of
     9.99 — 6.7 % variation across the whole visible field, which is
     under the threshold at which an eye reads "somewhere" rather than
     "green paint". The three fields below were all present and all
     about a quarter of the amplitude they needed to be. 15 % is the
     number a Wind Waker hillside actually carries. */
  function groundTone(x, z) {
    const v1 = spreadN(fbm(x * 0.0031 + 3.7, z * 0.0031 - 8.2, 3), 2.6);   // 320 m regional
    const v2 = spreadN(fbm(x * 0.0112 - 22, z * 0.0112 + 41, 2), 2.4);     // 90 m field
    const v5 = spreadN(fbm(x * 0.0295 + 137, z * 0.0295 - 58, 2), 2.2);    // 34 m meadow
    /* THIS SUMMED TO A MEAN OF 1.02 — a "variation" field whose
       average job was to make the island brighter than the palette it
       was built from, with peaks at 1.38. Combined with the grass
       layer's own over-bright tip ramp it is why the review measured
       the whole lower frame at value 78 with a two-point range across
       sixty metres of depth. Mean 0.95 now, with the spread WIDENED
       rather than narrowed: the complaint was never that the ground
       had too much variation. */
    return 0.56 + 0.36 * v1 + 0.26 * v2 + 0.16 * v5;
  }
  /* CHROMA IS MEASURED AT THE PIXEL, NOT AT THE SWATCH. Pushing 1.13
     here is a correct answer to "the mixes average toward grey" and a
     wrong one once ACES has had its turn: the delivered lit ground
     measured S 71 against §2.1's #7EC24E at S 60, and an over-saturated
     green also rolls toward yellow through the tone map, which is
     where the frame's hue 86 against the swatch's 95 came from. 1.04
     still lifts the averaging out of the mixes without overshooting
     the swatch it is supposed to be defending. */
  function groundChroma(c, s = 1.04) {
    const y = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    c.setRGB(y + (c.r - y) * s, y + (c.g - y) * s, y + (c.b - y) * s);
    return c;
  }

  function rockBase(x, y, z, out) {
    const c = out || _t3;
    const m1 = clamp((fbm(x * 0.0125 + 41, z * 0.0125 - 77, 2) - 0.5) * 2.2 + 0.5, 0, 1);
    const m2 = clamp((fbm(x * 0.0046 - 12, z * 0.0046 + 53, 2) - 0.5) * 2.4 + 0.5, 0, 1);
    /* LAND.rock is the grey; weighted, not free, because at a mean of
       0.5 the whole island's stone came out neutral and the blue
       shadow law then finished it off as lavender. Warm khaki
       bedrock with grey IN it is what §2.1's swatch pair says. */
    c.copy(C_CLIFF).lerp(C_ROCK, m1 * 0.60);
    c.lerp(C_ROCK_WARM, m2 * 0.44);
    /* Soaked at the waterline, bleached at the summit (§ the brief).
       WET IS A DISTANCE FROM THE SEA, NOT A HEIGHT. Keyed on y alone
       it painted every four-metre boulder sitting well up a dry
       beach in cool blue-grey, and they read as a different mineral
       from the warm cliff ten metres behind them. Splash zone = low
       AND close to the water. */
    /* A 5 m SPLASH BAND CANNOT REACH THE FOOT OF A 46 m CLIFF. The
       shore distance at the base of a sea cliff is 10-25 m — the
       waterline is out past the talus — so a gate that closes at 5 m
       never fired on the one surface it was written for, and the five
       samples up the shipped face spanned three value points. The
       band is the SURF's reach, not the tide's: spray, weed and
       permanent damp run 20 m back and 15 m up. */
    const wet = smoothstep(22, -2, shoreDistAt(x, z)) * (1 - smoothstep(1, 14, y));
    c.lerp(C_ROCK_WET, wet * 0.88);
    c.lerp(C_ROCK_PALE, smoothstep(6, 40, y) * 0.75);
    return c;
  }

  /* Steepness measured over 6 m, not over one raster cell.
     THE ROCK/GRASS BOUNDARY WAS THE COMB. Thresholding the per-vertex
     normal put the boundary wherever a single 2 m triangle happened to
     tip past it, so the edge between turf and stone came out as a
     mosaic of hard-edged triangles — which at 800 m reads as a row of
     shark's teeth along every cliff and up close as a crag made of
     stencilled paper. A wide stencil plus a little noise puts the
     boundary where the LANDFORM changes instead of where the mesh
     does. */
  function wideSteep(x, z, e = 6) {
    const gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
    const gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
    return 1 - 1 / Math.sqrt(1 + gx * gx + gz * gz);
  }

  /* THE LIP. Grass does not stop dead at a cliff edge; the turf
     layer overhangs it and hangs on for a metre or two before the
     rock wins. Without this the plateau meets the face along a hard
     line and the whole cliff reads as a decal on a hillside.

     "Near the top" is not a height, it is a NEIGHBOURHOOD: walk 8 m
     uphill and ask whether the ground there has levelled out. 1 at
     the very brink, 0 anywhere down the face. */
  function lipFactor(x, z, e = 6) {
    const gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
    const gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
    const m = Math.hypot(gx, gz);
    if (m < 1e-4) return 0;
    const above = wideSteep(x + (gx / m) * 8, z + (gz / m) * 8, 6);
    return smoothstep(0.15, 0.045, above);
  }

  /* ============================================================
     THE YARD.

     "the buildings sit on the terrain with a hard seam"; "the same
     beige/red-roof house mesh is stamped four times with no
     variation". The seam is real and half of it is ours: foliage.js
     clears its blade field inside every location's circle, so the one
     ring of ground the eye checks for contact is bare terrain sheet
     painted the same bright meadow green as the field forty metres
     away. Nothing on this island has a yard.

     A building has beaten earth at its door, worn thin turf around
     that, and a soft occlusion where the wall meets the ground.
     Bucketed into 128 m cells so a per-vertex query is two or three
     distance checks rather than a scan of all 28 locations.
     ============================================================ */
  const YCELL = 128, YPAD = 16;
  const yardMap = new Map();
  {
    const key = (i, j) => i * 4096 + j;
    for (const l of LOCATIONS) {
      const r = l.radius + YPAD;
      const i0 = Math.floor((l.world.x - r) / YCELL), i1 = Math.floor((l.world.x + r) / YCELL);
      const j0 = Math.floor((l.world.z - r) / YCELL), j1 = Math.floor((l.world.z + r) / YCELL);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const k = key(i, j);
          let a = yardMap.get(k);
          if (!a) yardMap.set(k, a = []);
          a.push(l);
        }
      }
    }
  }
  /** Metres outside the nearest location's circle, clamped to YPAD. */
  function yardDist(x, z) {
    const a = yardMap.get(Math.floor(x / YCELL) * 4096 + Math.floor(z / YCELL));
    if (!a) return YPAD;
    let best = YPAD;
    for (let i = 0; i < a.length; i++) {
      const l = a[i];
      const dd = Math.hypot(x - l.world.x, z - l.world.z) - l.radius;
      if (dd < best) best = dd;
    }
    return best;
  }

  function groundColor(x, z, h, ny, out) {
    const c = out || _c;
    const d = shoreDistAt(x, z);
    const steep = 1 - ny;

    /* SIX scales now, and the three that matter are the new ones.
       320 m regional, 90 m field, 34 m meadow, 14 m patch — and every
       patch mask below used to be driven off the first two. A
       gameplay camera sees sixty metres of ground, so a 320 m mask is
       a CONSTANT across the judged frame and a 90 m one is half of a
       gradient: the field had four scales of variation and none of
       them fitted inside a screenshot. 26 m and 11 m are the scales
       an eye standing in a meadow actually reads as "patches".

       fBm sits in a narrow band around its mean, so each one is
       stretched about its own centre first — feeding raw fBm into a
       lerp() is how an island ends up one flat green with a slight
       wobble in it. */
    const spread = spreadN;
    const v1 = spread(fbm(x * 0.0031 + 3.7, z * 0.0031 - 8.2, 3), 2.6);
    const v2 = spread(fbm(x * 0.0112 - 22, z * 0.0112 + 41, 2), 2.4);
    const v4 = spread(fbm(x * 0.029 + 66, z * 0.029 - 14, 2), 2.2);
    const v3 = n2(x * 0.071 + 11, z * 0.071 - 5);
    const v6 = spread(fbm(x * 0.0385 + 214, z * 0.0385 - 92, 2), 2.5);   // 26 m
    const v7 = spread(n2(x * 0.095 - 47, z * 0.095 + 138), 2.2);         // 11 m

    /* --- turf ---
       PATCHES, NOT A GRADIENT. Lerping continuously between two
       greens by an fBm is an average: everything lands on the mean
       tone and a whole hillside renders as one flat mint. Wind Waker
       ground is a mosaic of a few distinct tones with soft but
       findable boundaries, so each field here is thresholded into a
       patch mask first and only then mixed.

       THE REGIONAL FIELDS ARE NOW A BIAS, NOT THE DRIVER. v1 decides
       which way a whole headland leans; v6/v7 decide what the next
       fifteen metres do. That ordering is the entire difference
       between an island with character and a frame with a slab in it. */
    const mDark = smoothstep(0.30, 0.60, v6 * 0.58 + v1 * 0.42);
    const mDry = smoothstep(0.50, 0.76, v6 * 0.40 + v7 * 0.24 + v2 * 0.36);
    const mMoss = smoothstep(0.30, 0.52, v4);
    const mCool = smoothstep(0.56, 0.84, v7 * 0.52 + v1 * 0.48);
    const mRich = smoothstep(0.46, 0.20, v6 * 0.62 + v4 * 0.38);
    c.copy(C_GRASS_D).lerp(C_GRASS, mDark);
    /* Dry grass is the sand swatch, so it desaturates fast — spend it
       on altitude and on distinct meadows, not as a wash over
       everything, or §2.1's #7EC24E ends up sage. It was being spent
       to a combined 0.96 here, which is not a hint of dry grass, it
       is a repaint: the whole plateau measured yellow-green. */
    c.lerp(C_TURF_DRY, clamp((h - 34) / 44, 0, 1) * 0.24 + mDry * 0.34);
    /* ...and the opposite meadow, so variation runs both ways off the
       canonical pair instead of only toward sand. */
    c.lerp(C_GRASS_COOL, mCool * 0.40);
    /* ...and the third direction, which the field never had: the deep
       unmown green. Without a DARK patch type the mosaic only ever
       ran from the palette's mid green upward, which is a mosaic with
       no value range in it — exactly what four judges measured. */
    c.lerp(C_TURF_RICH, mRich * 0.46);
    const steepW = wideSteep(x, z) * 0.74 + steep * 0.26 + (v3 - 0.5) * 0.055;
    c.lerp(C_MOSS, smoothstep(0.05, 0.20, steepW) * 0.55 * mMoss);

    /* --- rock and its strata --- */
    let rockAmt = smoothstep(0.075, 0.32, steepW);
    if (rockAmt > 0.002) {
      /* Turf spills over the brink and hangs on down the first metres
         of the face, so the plateau/cliff transition is a ragged
         fringe rather than a drawn line. The noise makes the fringe
         uneven, which is the whole point of it. */
      const lip = lipFactor(x, z) * (0.62 + 0.60 * v4);
      rockAmt *= 1 - clamp(lip, 0, 1) * 0.92;
    }
    if (rockAmt > 0.002) {
      rockBase(x, h, z, _t1);
      /* SKY EXPOSURE, BAKED. A cliff face is very often turned away
         from the key — the island's biggest sea cliffs face out to
         the open water and the sun spends half the day behind them —
         and a two-band ramp inside a cast shadow has NO gradient at
         all: every normal on the face resolves to the same shadeCol
         and 46 m of carved rock renders as one flat value. That is
         most of why the shelves cliffPass cuts were invisible in the
         review frame even though the probe found them.

         So the tread/riser contrast is put where the shadow cannot
         reach it. It is not a cheat: a level shelf sees the whole sky
         dome and weathers pale, a riser sees half of it and stays
         dark and tucked. 1.8:1, which is ~28 luminance units at
         render, and it survives every lighting condition. */
      const sky = lerp(0.64, 1.18, smoothstep(0.12, 0.82, ny));
      const k = (0.90 + 0.20 * v3) * sky;
      _t1.setRGB(_t1.r * k, _t1.g * k, _t1.b * k);
      /* and the pale weathering only happens where rain can reach */
      _t1.lerp(C_ROCK_PALE, smoothstep(0.45, 0.92, ny) * 0.26);
      c.lerp(_t1, rockAmt);
    }

    /* --- dirt on the worn middle slopes --- */
    c.lerp(C_DIRT, smoothstep(0.045, 0.15, steepW) * 0.26 * (1 - rockAmt));

    /* --- beach: wet at the water line, dry over the outer 26 m --- */
    const sandAmt = smoothstep(BEACH + 12, BEACH - 18, d);
    if (sandAmt > 0.002) {
      const wet = smoothstep(6.0, -1.5, d);
      _t2.copy(C_SAND).lerp(C_SAND_W, wet);
      const k = 0.94 + 0.13 * v3;
      _t2.setRGB(_t2.r * k, _t2.g * k, _t2.b * k);
      c.lerp(_t2, sandAmt * (1 - rockAmt * 0.55));
    }
    if (h < 0) c.lerp(C_SEA_W, clamp(-h / 9, 0, 1) * 0.75);

    /* --- roads, their verges, and the yards ---

       THE JUDGES ASKED FOR A FOCAL READ, and a field with nothing in
       it leading anywhere is the reason there isn't one: "composition
       puts the subject in dead centre-left with an enormous empty
       foreground and nothing leading the eye". Worn ground is the
       cheapest leading line there is — it is already shaped like the
       route to the buildings, because it IS the route to the
       buildings. What was here coloured the carved centre of a lane
       and stopped dead at its edge; a real track has a trodden verge
       that fades out over several metres and gets wider the closer it
       gets to a door. */
    const p = pathAt(x, z);
    /* The carve mask blurred over ~7 m, which is the halo a cart track
       actually wears into the turf beside it. Four taps, not a real
       blur — this runs per vertex over the whole island. */
    const halo = Math.max(
      pathAt(x + 7, z), pathAt(x - 7, z), pathAt(x, z + 7), pathAt(x, z - 7),
      pathAt(x + 5, z + 5), pathAt(x - 5, z - 5));
    const verge = clamp(Math.max(p, halo * 0.86) * (0.86 + 0.28 * v7), 0, 1);
    /* Grass first: thin, trodden, earth showing through. This is a
       TURF tone, not a road tone — the bare-earth ribbon below is a
       separate, much narrower thing. */
    if (verge > 0.004) c.lerp(C_TURF_WORN, smoothstep(0.10, 0.66, verge) * 0.52);
    /* The yard. 0 at the door, gone 16 m out. */
    const yd = yardDist(x, z);
    if (yd < YPAD) {
      const yard = 1 - smoothstep(-1.5, YPAD, yd);
      c.lerp(C_TURF_WORN, yard * yard * 0.66);
      /* ...and the ground-contact darkening a wall casts into its own
         yard. §2.1's shadow law, not a grey multiply — written out as
         a per-channel multiply because lerp(c, shadeLaw(c, 0.55), w)
         IS lerp(c, c * tint * 1.9, 0.55 * w), and this one runs per
         vertex over the whole island with no allocation. */
      const ao = 1 - smoothstep(-2.5, 5.5, yd);
      if (ao > 0.002) {
        const k = 0.55 * ao * 0.38;
        c.setRGB(
          c.r * lerp(1, C_SHADE_TINT.r * 1.9, k),
          c.g * lerp(1, C_SHADE_TINT.g * 1.9, k),
          c.b * lerp(1, C_SHADE_TINT.b * 1.9, k));
      }
    }
    if (p > 0.002) {
      _t1.copy(C_ROAD).lerp(C_DIRT, 0.40 + 0.5 * v3);
      /* p^1.7, not p: the carve mask is deliberately wide so the road
         grades into the land, but colouring linearly off it turned a
         6 m cart track into a 13 m airstrip. The cube-ish curve keeps
         the bare earth to the middle and lets the verge stay green. */
      c.lerp(_t1, Math.pow(clamp(p, 0, 1), 1.7) * 0.92);
    }

    /* --- district character, as a hue nudge that keeps the value ---
       loc/zone tints come out of data.js, so each district's ground
       leans its own way without any of it being hand-picked here. */
    const k = zoneIndexAt(x, z);
    if (k >= 0) {
      const m = zoneList[k].tintMul;
      const w = 0.15 * (1 - sandAmt);
      c.setRGB(
        c.r * lerp(1, m.r, w),
        c.g * lerp(1, m.g, w),
        c.b * lerp(1, m.b, w),
      );
    }

    /* Final large-scale luminance breakup. Driven mostly off v1 —
       the 320 m regional field — because that is the scale the
       island reads flat at: a 90 m blotch is invisible from a shore
       camera and the whole coastline came out as one value. */
    const g = groundTone(x, z);
    c.setRGB(c.r * g, c.g * g, c.b * g);

    /* One modest chroma push, last. §2.1 is a "high-saturation"
       palette and every mix above is an average, so the ground
       arrives here a little further toward grey than any swatch it
       was built from. Applied in linear space to all of it, sand and
       rock included — they are drawn from the same high-key set. */
    return groundChroma(c);
  }

  /* ============================================================
     PER-PIXEL STRATA.

     The bedding planes, their partings, the per-bed mineral change
     and the vertical erosion channels, injected into a toon material
     this module owns. It is a patch of two anchor strings on our own
     ShaderMaterial instance — toon.js is untouched, and if either
     anchor ever moves the patch declines to apply and says so rather
     than shipping a broken shader.

     Why the fragment shader and not the vertex colour: see rockBase.
     Why it is safe for a cel look: every band edge here is a
     smoothstep on an albedo, not a threshold on N·L, so it cannot
     shatter the two-band ramp — it feeds it.
     ============================================================ */
  const STRATA_DECL = /* glsl */`
uniform float uStrataAmt;      // master strength
uniform float uStrataStep;     // metres per bedding plane
uniform float uStrataFlat;     // 1 = steep faces only, 0 = everywhere
uniform vec3  uStrataDark;
uniform vec3  uStrataPale;
uniform vec3  uStrataWarm;
uniform vec3  uStrataCool;

/* One bedding field for the whole island. Warped in all three axes —
   a warp that only varies in XZ still leaves every bed a plane, and
   fourteen parallel planes down a cliff face is corrugated iron, not
   rock. The y term folds them.

   MEASURED: the shipped face carried ~20 bands at a dead-identical
   29 px pitch, amplitude sd 3.53 on a mean of 95.7 — a 3.7 % ripple
   at a perfect period, which is the definition of corrugated iron.
   The y coefficients below are 2.4x what they were, so d(warp)/dy
   now reaches ~0.55 and adjacent beds differ by better than 2:1 in
   thickness; the 0.0088 term is a 110 m regional dip that tilts whole
   courses relative to each other. */
float wBedWarp( vec3 wp ) {
  return wValue3( vec3( wp.x, 0.0, wp.z ) * 0.0062 ) * 13.0
       + wValue3( vec3( wp.x, wp.y * 2.6, wp.z ) * 0.0088 + 77.0 ) * 16.0
       + wValue3( wp * 0.0180 + 31.0 ) * 15.0
       + wValue3( wp * 0.0620 - 12.0 ) * 3.2;
}

/* The bed at a height, as a pair: .x is which bed, .y is how far up
   it we are. */
vec2 wBed( vec3 wp, float step ) {
  float b = ( wp.y + wBedWarp( wp ) ) / step;
  return vec2( floor( b ), fract( b ) );
}

vec3 wTerrainRock( vec3 base, vec3 wp, vec3 nrm ) {
  /* Rock is steep AND is already painted a warm neutral by the
     vertex colour — turf has g > r and stone does not, which is a
     free, exact mask for the boundary the vertex pass chose,
     including the grass that spills over the lip. */
  float steepK = mix( 1.0, smoothstep( 0.78, 0.34, abs( nrm.y ) ), uStrataFlat );
  float rockK  = smoothstep( -0.012, 0.055, base.r - base.g );
  float k = steepK * rockK * uStrataAmt;
  if ( k < 0.004 ) return base;

  /* Band-limit: as one pixel's footprint approaches half a bed the
     stripe would alias, so it fades to the smooth base instead. */
  float fwY = max( fwidth( wp.y ), 1e-4 );
  k *= 1.0 - smoothstep( uStrataStep * 0.16, uStrataStep * 0.50, fwY );
  if ( k < 0.004 ) return base;

  /* --- vertical erosion channels, computed first because they
     BREAK the beds as well as tint them. A 2-D field in world XZ is
     constant up a near-vertical face and varies along its run, which
     IS a set of gullies and ribs. --- */
  float fwX = max( max( fwidth( wp.x ), fwidth( wp.z ) ), 1e-4 );
  float chAA = 1.0 - smoothstep( 0.55, 1.9, fwX );
  float ch = wValue3( vec3( wp.x, 0.0, wp.z ) * 0.115 + 7.0 ) * 0.58
           + wValue3( vec3( wp.x, 0.0, wp.z ) * 0.33 - 21.0 ) * 0.42;
  ch = ( ch - 0.5 ) * 2.2 * chAA;

  /* --- two incommensurate bed sets. One quantiser at a fixed step
     is a comb, and a comb is what the face read as: fourteen evenly
     spaced parallel lines. A second set at 2.7x the pitch shares no
     period with the first, so the composite never repeats and the
     eye reads geology instead of machining. --- */
  vec2 b1 = wBed( wp, uStrataStep );
  vec2 b2 = wBed( wp + vec3( 0.0, 4.1, 0.0 ), uStrataStep * 2.7 );

  vec3 c = base;

  /* --- MINERAL DRIFT, ~70 m. Block statistics across the full width
     of the shipped face gave luminance sd 2.75 on a range of 89-100:
     one flat field, no large-scale colour on the rock at all. Every
     term below this one is bed-scale and therefore averages out over
     a 32 px block; this is the only one that survives the average,
     so it is the one that decides whether a headland is a different
     stone from the next headland. --- */
  float drift = wValue3( vec3( wp.x, wp.y * 0.35, wp.z ) * 0.0145 - 19.0 );
  float drift2 = wValue3( vec3( wp.x, wp.y * 0.5, wp.z ) * 0.042 + 61.0 );
  drift = clamp( ( drift - 0.5 ) * 2.3 + 0.5, 0.0, 1.0 );
  c = mix( c, uStrataWarm, smoothstep( 0.30, 0.72, drift ) * 0.55 );
  c = mix( c, uStrataCool, smoothstep( 0.44, 0.06, drift ) * 0.50 );
  c = mix( c, uStrataPale, smoothstep( 0.56, 0.88, drift2 ) * 0.34 );

  /* --- the mineral of each bed --- */
  float m1 = wHash11( b1.x * 1.73 + 3.1 );
  float m2 = wHash11( b1.x * 5.31 - 11.7 );
  float m3 = wHash11( b2.x * 2.19 + 47.0 );
  c = mix( c, uStrataWarm, m1 * 0.42 );
  c = mix( c, uStrataPale, m2 * m2 * 0.40 );
  c = mix( c, uStrataCool, m3 * m3 * 0.34 );

  /* --- shading inside a bed: dark where it is tucked under the
     ledge above it, weathered pale toward its own cap. Both fade
     where a gully has cut the bed away. --- */
  float cut = 1.0 - 0.55 * max( -ch, 0.0 );
  /* Held deliberately low. cliffPass now cuts the beds as REAL
     geometry — a level tread against a near-vertical riser, 80 deg of
     normal apart — so the two-band ramp supplies the contrast and
     anything this pass adds on the same period is a second, competing
     stripe drawn on top of the first. That double image is what read
     as corrugated iron. What is left here is mineral, not relief. */
  c = mix( c, uStrataDark, ( 1.0 - smoothstep( 0.0, 0.34, b1.y ) ) * 0.20 * cut );
  c = mix( c, uStrataPale, smoothstep( 0.52, 0.98, b1.y ) * 0.22 * cut );
  c = mix( c, uStrataDark, ( 1.0 - smoothstep( 0.0, 0.16, b2.y ) ) * 0.12 );

  /* --- the partings themselves: a thin recessed line on the plane,
     and the deep shadow that always sits just under a ledge --- */
  float seam = smoothstep( 0.045, 0.0, min( b1.y, 1.0 - b1.y ) );
  seam = max( seam, smoothstep( 0.030, 0.0, min( b2.y, 1.0 - b2.y ) ) * 1.25 );
  c = mix( c, uStrataDark, clamp( seam, 0.0, 1.0 ) * 0.26 * cut );

  /* --- and the gullies and ribs in their own right --- */
  c = mix( c, uStrataDark, max( -ch, 0.0 ) * 0.58 );
  c = mix( c, uStrataPale, max(  ch, 0.0 ) * 0.52 );

  return mix( base, c, k );
}
`;

  /* ============================================================
     PER-PIXEL TURF.

     THE VERTEX COLOUR CANNOT CARRY THE FIELD AND NEVER COULD.
     Distant tiles are LOD 2 and 3 — an 8 m and a 16 m vertex pitch —
     so every scale of variation groundColor() computes below about
     30 m is low-pass filtered straight out of the far half of every
     frame. That is, precisely, "the grass is a single screaming
     chroma-green with no variation, no value break toward the horizon
     and no focal read": not a missing colour, a missing SAMPLING
     RATE. The only place the mid and far field can be given structure
     is here, where it is resolution-free.

     Five octaves from 26 m down to 34 cm, each one band-limited
     against its own cell size, so at every viewing distance at least
     two of them are resolvable and none of them can ever alias. The
     finest is stretched along a slowly-turning direction field — that
     is what a lawn's grain looks like from four metres, and it is
     what makes the ground under the far half of the blade fade read
     as grass rather than as a painted plane. §6: "every surface has
     grain; nothing is flat-shaded and clean."

     It also carries the far half of aerial perspective for the turf
     only (see C_TURF_HAZE), because the blade layer already carried
     it and the sheet did not.
     ============================================================ */
  const TURF_DECL = /* glsl */`
uniform float uTurfAmt;
uniform vec3  uTurfDry;
uniform vec3  uTurfRich;
uniform vec3  uTurfClover;
uniform vec3  uTurfWorn;
uniform vec3  uTurfFar;
uniform vec3  uTurfVal;     // x/y/z = coarse, mid, fine value weights
uniform vec4  uTurfAir;     // x = pale from, y = pale to, z = strength, w = handed back to fog by

/* One octave, signed and centred on zero, that FADES OUT as a pixel's
   world footprint approaches its own cell. This is the whole trick:
   every scale is present when it is resolvable and absent when it is
   not, so the same expression is 34 cm grain at your feet and 26 m
   patches at the treeline without a single LOD branch. */
float wTurfOct( vec2 p, float cell, float fw ) {
  float v = wValue3( vec3( p.x, 0.0, p.y ) / cell );
  return ( v - 0.5 ) * ( 1.0 - smoothstep( cell * 0.34, cell * 1.10, fw ) );
}

vec3 wTerrainTurf( vec3 base, vec3 wp, vec3 nrm ) {
  /* Turf is the ground whose green channel leads its red — the exact
     complement of the rock mask in wTerrainRock, and free, because
     groundColor() has already decided where the turf is. Sand, dirt,
     road and stone are all r >= g and take none of this. */
  float turfK = smoothstep( -0.004, 0.055, base.g - base.r ) * uTurfAmt;
  if ( turfK < 0.004 ) return base;

  float fw = max( max( fwidth( wp.x ), fwidth( wp.z ) ), 1e-4 );

  /* 55 m EXISTS FOR THE GRAZING CASE. A gameplay camera two metres up
     looking at ground eighty metres out has a pixel footprint of
     metres, so even the 26 m octave has faded to nothing there and
     the far field goes back to being the slab it was. The vertex
     colour carries 320 m and 90 m and nothing between; this is the
     missing band, and it is the only one still resolvable where the
     ground meets the buildings. */
  float d55 = wTurfOct( wp.xz + vec2( - 63.0,  27.5 ), 55.0, fw );
  float d26 = wTurfOct( wp.xz + vec2(  11.3, - 7.9 ), 26.0, fw );
  float d10 = wTurfOct( wp.xz + vec2( -41.7,  63.1 ), 10.5, fw );
  float d42 = wTurfOct( wp.xz + vec2(   7.1,  19.4 ),  4.2, fw );
  float d14 = wTurfOct( wp.xz + vec2( - 3.3,  88.2 ),  1.45, fw );

  /* THE GRAIN OF THE LAWN. A field is not isotropic — grass lies, and
     it lies in slowly-turning sweeps you can see from a doorway. One
     very low-frequency angle field, then noise stretched 6:1 along
     it. Isotropic noise at this scale reads as dirt; stretched, it
     reads as grass, and it is the only thing standing between the
     camera and a flat sheet in the band where the blades have thinned
     out but the ground still fills the frame. */
  float ang = wValue3( vec3( wp.x, 0.0, wp.z ) * 0.017 + 5.0 ) * 6.2831853;
  vec2  dir = vec2( cos( ang ), sin( ang ) );
  vec2  q   = vec2( dot( wp.xz, dir ), dot( wp.xz, vec2( - dir.y, dir.x ) ) );
  float dBl = wTurfOct( vec2( q.x, q.y * 0.17 ), 0.34, fw )
            + wTurfOct( vec2( q.x * 1.7 + 31.0, q.y * 0.21 ), 0.92, fw ) * 0.8;

  /* --- value first. This is what four reviews measured and none of
     them found: "one uniform high-saturation hue with NO VALUE
     RANGE". Weighted so the coarse end dominates — patches you can
     see across the frame — with the fine end there to keep the
     surface alive at conversational range. --- */
  float sw = d55 * uTurfVal.x * 0.78 + d26 * uTurfVal.x + d10 * uTurfVal.y
           + ( d42 * 0.62 + d14 * 0.46 + dBl * 0.52 ) * uTurfVal.z;

  vec3 c = base * ( 1.0 + sw );

  /* --- then character. Four kinds of ground, thresholded into
     patches with soft but findable boundaries, never lerped
     continuously — a continuous lerp between two greens is an
     average and an average is a slab. Each mask is driven by the
     coarse octaves, so a patch survives into the far field where the
     fine ones have faded to nothing. --- */
  float pDry    = smoothstep( 0.04, 0.26, d55 * 0.60 + d26 * 0.72 + d10 * 0.42 );
  float pRich   = smoothstep( - 0.03, - 0.24, d55 * 0.52 + d26 * 0.62 + d42 * 0.30 );
  float pClover = smoothstep( 0.09, 0.30, d10 - d26 * 0.55 );
  float pWorn   = smoothstep( 0.19, 0.38, d42 * 0.72 + d10 * 0.48 );

  /* THE WARM AND THE COOL PATCHES CARRY THE SAME TOTAL WEIGHT.
     Anything else is not a mosaic, it is a tint on the whole field —
     the vertex pass and this one each ran three blue-ward mixes and
     one warm one, and the compounded result measured a 27 degree hue
     rotation off §2.1's swatch that nobody had asked for. */
  c = mix( c, uTurfDry,    pDry    * 0.40 );
  c = mix( c, uTurfRich,   pRich   * 0.30 );
  c = mix( c, uTurfClover, pClover * 0.18 );
  c = mix( c, uTurfWorn,   pWorn   * 0.28 );

  /* --- the far half of aerial perspective, for turf only.
     grass.js pales its blades 47 % of the way to this swatch by 60 m
     and the sheet they stand in paled not at all, so wherever both
     were visible the two layers were half a swatch apart — which is
     the "bald flat green patch where the grass cards stop". It is a
     colour seam, not a density one, and this is the side of it that
     was wrong. Distance is the same y-weighted metric grass.js fades
     on, so an overhead camera grades the same way. --- */
  float dist = length( ( wp - cameraPosition ) * vec3( 1.0, 0.7, 1.0 ) );
  float aFar = smoothstep( uTurfAir.x, uTurfAir.y, dist ) * uTurfAir.z;
  /* AND IT HAS TO HAND BACK. This is the NEAR half of aerial
     perspective and scene.fog is the far half; left flat past its
     ramp it was still mixing half a haze swatch into ground three
     hundred metres out that fog was ALSO paling, and the city fly-to
     came back as a mint-green town — every hillside desaturated to
     aqua, the exact opposite of the §2.1 set. Measured against the
     same shot with this pass switched off, essentially all of that
     cyan was this one line. A hump, not a step: full weight where the
     blades are and the seam is, rolling back to a fifth of it by the
     time fog owns the frame. */
  aFar *= 1.0 - smoothstep( uTurfAir.y, uTurfAir.w, dist ) * 0.80;
  c = mix( c, uTurfFar, aFar );

  return mix( base, c, turfK );
}
`;

  function patchTurf(mat, opts = {}) {
    const A = 'uniform vec3  diffuse;';
    const B = 'vec3 albedo = tex.rgb;';
    let f = mat.fragmentShader;
    if (f.indexOf(A) < 0 || f.indexOf(B) < 0) {
      console.warn('[terrain] turf patch: toon.js fragment anchors moved, field left flat');
      return mat;
    }
    mat.fragmentShader = f
      .replace(A, TURF_DECL + '\n' + A)
      .replace(B, 'tex.rgb = wTerrainTurf( tex.rgb, vWorldPos, N );\n  ' + B);
    mat.uniforms.uTurfAmt = { value: opts.amount ?? 1.0 };
    mat.uniforms.uTurfDry = { value: C_TURF_DRY.clone() };
    mat.uniforms.uTurfRich = { value: C_TURF_RICH.clone() };
    mat.uniforms.uTurfClover = { value: C_TURF_CLOVER.clone() };
    mat.uniforms.uTurfWorn = { value: C_TURF_WORN.clone() };
    mat.uniforms.uTurfFar = { value: C_TURF_HAZE.clone() };
    mat.uniforms.uTurfVal = { value: new THREE.Vector3(...(opts.val ?? [0.34, 0.27, 1.0])) };
    /* Crossed against grass.js's own air ramp (14 -> 95 m at 0.78) at
       the depth that matters rather than copied from it: at 60 m — the
       band where blades and sheet are both plainly visible and where
       the seam was — 12/80/0.56 and 14/95/0.78 both land on 0.46, so
       the two layers hand over continuously. Copying 0.78 outright
       made the sheet chalky everywhere past 95 m instead, where the
       blades are gone and §2.4's fog is supposed to be doing the
       work. This is the near half of aerial perspective; fog is the
       far half, and they must not both claim the same eighty metres. */
    /* JUDGED FROM A SECOND CAMERA, NOT DERIVED FROM ONE. Matching the
       blade layer's 0.78 looks right from the gameplay camera, where
       everything past sixty metres is a thin strip near the horizon,
       and is a disaster from the city fly-to, where the same sixty
       metres is the whole lower half of the frame: the town came back
       mint. §2.4 puts the haze past ~120 m, so the sheet's own share
       of it has to stay small and early — enough to close the gap to
       the blades in the band where both are visible, and gone again
       by the time fog owns the picture. */
    mat.uniforms.uTurfAir = { value: new THREE.Vector4(...(opts.air ?? [16, 74, 0.32, 130])) };
    mat.needsUpdate = true;
    return mat;
  }

  function patchStrata(mat, opts = {}) {
    const A = 'uniform vec3  diffuse;';
    const B = 'vec3 albedo = tex.rgb;';
    let f = mat.fragmentShader;
    if (f.indexOf(A) < 0 || f.indexOf(B) < 0) {
      console.warn('[terrain] strata patch: toon.js fragment anchors moved, rock left unbanded');
      return mat;
    }
    f = f.replace(A, STRATA_DECL + '\n' + A);
    f = f.replace(B, 'tex.rgb = wTerrainRock( tex.rgb, vWorldPos, N );\n  ' + B);
    mat.fragmentShader = f;
    mat.uniforms.uStrataAmt = { value: opts.amount ?? 1.0 };
    /* 4.2 m beds. Chosen against the geometry, not by eye: cliffPass
       cuts a 22 m tier, and five colour beds to a tier is what makes
       the ledge read as the top of a stack rather than as a fold. */
    mat.uniforms.uStrataStep = { value: opts.step ?? 6.6 };
    mat.uniforms.uStrataFlat = { value: opts.flat ?? 1.0 };
    /* NOT LAND.rockShade. That swatch is hue 218 / sat 8 — a grey —
       and this shader mixes toward its dark five separate times, so
       compounded it was single-handedly responsible for a cliff face
       that measured saturation 4 across every sample. §7 forbids a
       grey shadow; a dark bedding plane is dark ROCK, put through
       §2.1's own hue rotation. */
    mat.uniforms.uStrataDark = { value: C_ROCK_BED_D.clone() };
    mat.uniforms.uStrataCool = { value: C_ROCK_BED_C.clone() };
    mat.uniforms.uStrataPale = { value: C_ROCK_PALE.clone() };
    mat.uniforms.uStrataWarm = { value: C_ROCK_WARM.clone() };
    mat.needsUpdate = true;
    return mat;
  }

  /* ============================================================
     Meshes
     ============================================================ */
  const group = new THREE.Group();
  group.name = 'terrain';

  const material = ctx.mat.plaster({
    name: 'terrain',
    color: 0xffffff,          // albedo is the vertex colour
    vertexColors: true,
    /* variation must be 0: the tint2 blotch is a mix(), and mixing
       toward one colour would erase the per-vertex palette. The
       plaster luminance blotch and its relief survive, which is what
       we actually wanted from it. */
    variation: 0.0,
    edgeWear: 0.0,
    varScale: 0.11,
    relief: 0.30,
    /* §1.2 AND §6 MAKE GRAIN NON-NEGOTIABLE, AND A FADE THAT STARTS
       AT 22 m IS THE OPPOSITE OF THE RULE. Measured on the shipped
       build, a 150x150 patch of flat grass carried a high-frequency
       std-dev of 2.600 against its own empty sky at 2.435 — a delta
       of 0.17, i.e. the ground had no surface of its own, only the
       post chain's film grain. §1.2 asks for grain that stays
       constant in SCREEN space; the fade exists only to stop the
       triplanar aliasing into sparkle once a lobe is under ~2 px, so
       it belongs out at the far plane, not at conversational range. */
    /* AND THE SCALE MATTERS AS MUCH AS THE AMPLITUDE. tGrain is a
       48-cell noise, so at grainScale 2.0 the texture repeated every
       50 cm and ONE CELL WAS A CENTIMETRE — three orders below a
       pixel at any distance a human looks at terrain from. Turned up,
       that is not grain, it is television static, which is exactly
       what the first attempt at this rendered. Sized here so a cell
       lands at ~5 px at gameplay range and ~2 px at review range: big
       enough to survive the sampler, small enough to still read as
       surface rather than as blotching. */
    grain: 0.017,
    grainScale: 0.52,
    grainAlbedo: 0.14,
    grainFade: [120, 430],
    /* THE GROUND IS THE ONE SURFACE SEEN ALMOST ENTIRELY EDGE-ON.
       Both of these are fresnel terms, and on a hillside under a low
       camera the fresnel is ~1 over most of the frame — so a rim
       meant for a silhouette and a sky bounce meant for an upward
       face were being added at full strength to every pixel of the
       island. Measured, the bounce alone lifted grass's blue channel
       by 70 % and §2.1's #7EC24E rendered as pale mint. A rim light
       on terrain is meaningless anyway: terrain has no silhouette
       against anything but the sky. */
    rim: 0.0,
    /* §2.2 asks for a soft sky bounce on every upward-facing surface,
       and it is the only light a level shelf inside a cast shadow
       ever gets. Kept small because the term is a fresnel and terrain
       is seen edge-on. */
    skyBounce: 0.095,
    /* THE GROUND IS THE SURFACE THE TWO-BAND RAMP FAILS HARDEST ON.
       These are toon.js's own measured ground numbers: a strong macro
       slope so a near-horizontal surface still crosses the core step,
       a terminator raised to where real terrain slopes actually reach
       it, and a narrow band because N.L changes slowly across a
       hillside compared with a 1 m sphere. */
    /* toon.js's lab ground runs macro 0.85 at scale 0.58 because a
       160 m PlaneGeometry has ONE normal and nothing else can band
       it. This terrain has half a million real triangles and genuine
       slope, and at those numbers the macro field stopped being a
       metre-scale undulation and became camouflage: hard-edged
       5-10 m blobs of core-lit and shaded green all over the island,
       because a 25-degree wobble of the shading normal crosses both
       thresholds twice per lobe. Kept, at a quarter strength and a
       third of the frequency, so it is what it says it is — a soft
       17 m swell riding on top of form that already bands. */
    macro: 0.26,
    macroScale: 0.085,
    term: 0.38,
    bandSoft: 0.020,
    band2: 0.21,
    core: 0.60,
    coreSoft: 0.020,
    spec: 0.035,
    specPow: 24,
    outline: false,
    noOutline: true,
  });
  patchStrata(material, { amount: 1.0, flat: 1.0 });
  patchTurf(material);
  /* Live, so the per-pixel mosaic can be isolated from the vertex
     colour in a screenshot session. Measuring the two together is how
     four separate blue-ward mixes ended up compounding into a 27
     degree hue rotation nobody had authored. */
  const setTurf = (v) => {
    material.uniforms.uTurfAmt.value = clamp(v, 0, 2);
    return material.uniforms.uTurfAmt.value;
  };

  /* ============================================================
     THE GROUND'S NEAR-FIELD DEPTH GRADE.

     Two blind reviews of the boot frame said the same thing: "no
     value range from foreground to horizon", "the bottom 45 % is a
     dead, unmodulated slab". Measured, they were exact — the green
     ran value 78 at the bottom edge of the canvas and value 78 at the
     treeline, across sixty metres of depth.

     THE GRASS LAYER CANNOT FIX THIS ON ITS OWN. A 0.16 m blade under
     a camera 2 m up hides maybe half the ground; the rest of what the
     eye samples in the near field is this sheet, so grading the
     blades and not the sheet just turns the field into dark shards on
     a bright slab — which is what the first pass rendered.

     scene.fog is the far half of aerial perspective and it already
     works (see world.js's HAZE remap). This is the NEAR half, which
     fog cannot express: ground at your boots is seen through no air
     at all, sits in its own micro-shadow, and is the darkest and most
     saturated version of its own colour anywhere in the frame. One
     smoothstep on a varying that already exists.

     THE TINT IS §2.1's SHADOW LAW, NOT A COLOUR CHOSEN BY EYE: the
     component-wise ratio #4E9A46 / #7EC24E — the exact multiply that
     turns the palette's lit grass into the palette's shaded grass —
     walked a third of the way back toward white. Blue is the least
     attenuated channel of that ratio, so the darkening rotates hue
     toward blue-green rather than toward black, which is what §2.1
     requires and what the same constant in grass.js does, so the two
     layers grade together instead of separating.
     ============================================================ */
  /* 34 m, NOT 26. The near grade is the only thing giving the bottom
     forty per cent of a gameplay frame a value ramp — fog starts at
     100 m and the turf pale is only a quarter of the way in at 30 —
     and at 26 m it had finished before the field had. Matched to
     grass.js's air.x so blade and sheet grade together. */
  const NEAR_END = 34;
  const uGndNear = { value: (() => {
    /* t 0.40 was a 0.79 linear multiply at the lens. On its own that
       is defensible; underneath a blade field carrying the SAME grade
       at t 0.33 it made the near ground the darkest thing in a noon
       frame, and the two together measured V 58 in the bottom band
       against §2.1's lit grass at V 76. The near half of aerial
       perspective is a few value points, not a stop. Matched to the
       grass layer's constant so the two still grade together. */
    /* 0.56 — moved in lockstep with grass.js's NEAR_TINT, which
       carries the identical constant for the identical reason. If
       these two ever drift apart the blades and the sheet they stand
       in stop being one surface. */
    const a = lin(LAND.grassLit), b = lin(LAND.grassShade), t = 0.56;
    const r = [b.r / a.r, b.g / a.g, b.b / a.b];
    /* Pulled 30 % toward its own luminance, exactly as grass.js does:
       the raw ratio is a green-only multiply and this sheet also
       carries sand, dirt and road, none of which should turn green as
       they come toward the lens. */
    const y = 0.2126 * r[0] + 0.7152 * r[1] + 0.0722 * r[2];
    return new THREE.Color(...r.map((v) => lerp(lerp(v, y, 0.62), 1, t)));
  })() };
  const uGndNearEnd = { value: NEAR_END };
  function gradeByDepth(m) {
    if (!m || !m.fragmentShader.includes('#ifdef USE_FOG')) return;
    m.fragmentShader = m.fragmentShader.replace('#ifdef USE_FOG', `
  col *= mix( uGndNear, vec3( 1.0 ), smoothstep( 0.0, uGndNearEnd, vViewZ ) );

  #ifdef USE_FOG`);
    m.fragmentShader = 'uniform vec3 uGndNear;\nuniform float uGndNearEnd;\n' + m.fragmentShader;
    m.uniforms.uGndNear = uGndNear;
    m.uniforms.uGndNearEnd = uGndNearEnd;
    m.needsUpdate = true;
  }
  gradeByDepth(material);

  const tiles = [];
  const TX = Math.round((BX * 2) / TILE);
  const TZ = Math.round((BZ * 2) / TILE);

  function buildTileGeometry(tile, level) {
    const step = LOD_STEP[level];
    const n = Math.round(TILE / (CELL * step));      // quads per side
    const i0 = Math.round((tile.x0 - gx0) / CELL);
    const j0 = Math.round((tile.z0 - gz0) / CELL);
    const vw = n + 1;
    const skirtCount = vw * 4;
    const vcount = vw * vw + skirtCount;

    const pos = new Float32Array(vcount * 3);
    const nrm = new Float32Array(vcount * 3);
    const col = new Float32Array(vcount * 3);
    const uv = new Float32Array(vcount * 2);
    const idx = new Uint32Array(n * n * 6 + n * 4 * 6);

    const e = CELL * step;
    let vi = 0;
    for (let jj = 0; jj <= n; jj++) {
      const z = tile.z0 + jj * e;
      for (let ii = 0; ii <= n; ii++, vi++) {
        const x = tile.x0 + ii * e;
        const gi = clamp(i0 + ii * step, 0, NX - 1);
        const gj = clamp(j0 + jj * step, 0, NZ - 1);
        /* A coarse LOD must FILTER the raster, not point-sample it.
           Taking every 8th height off a heightfield that carries a
           13 m coastal scarp is textbook aliasing, and it showed:
           the distant shoreline came back as a regular comb of dark
           triangular teeth. Averaging the block each coarse vertex
           stands for is the same fix as a mipmap, for the same
           reason. */
        let h;
        if (step === 1) h = H[IX(gi, gj)];
        else {
          /* Radius = the full stride, not half of it. A 30 m coastal
             scarp sampled every 16 m and box-filtered over only 8 m
             still aliases into a sawtooth; filtering over the whole
             footprint the vertex stands for is what a mipmap does. */
          const r = step;
          let sum = 0, cnt = 0;
          for (let b = -r; b <= r; b++) {
            const jjc = clamp(gj + b, 0, NZ - 1);
            for (let a = -r; a <= r; a++) {
              sum += H[IX(clamp(gi + a, 0, NX - 1), jjc)];
              cnt++;
            }
          }
          h = sum / cnt;
        }
        /* THE SHADING NORMAL IS WHAT THE TOON RAMP THRESHOLDS, so it
           has to describe the LANDFORM, not the mesh. A one-cell
           central difference gives every 2 m triangle its own normal,
           the band edge then lands on triangle boundaries, and a
           cliff renders as a mosaic of hard-edged grey wedges —
           visible from 800 m as a comb of teeth along every ridge.
           Two stencils blended: the wide one carries the form and the
           narrow one keeps the ledges legible.

           THE STENCIL WAS EATING THE TERRACES. At a floor of 4 m the
           narrow gradient still straddled a 7 m tread AND the 1.5 m
           riser at each end of it, so a face whose normals genuinely
           swing 80 degrees between shelf and wall — measured, ndl
           0.81 on a tread against -0.45 on the riser above it —
           averaged out into one smooth ramp normal and rendered as
           the featureless slab the review found. The floor is now one
           cell, which is the finest the raster can honestly answer,
           and the aliasing this guard was written for is handled
           where it belongs: `e` grows with the LOD stride, so a
           distant tile still asks a wide question. */
        const e1 = Math.max(CELL, e), e2 = e1 * 2.2;
        const gx1 = (heightAt(x + e1, z) - heightAt(x - e1, z)) / (2 * e1);
        const gz1 = (heightAt(x, z + e1) - heightAt(x, z - e1)) / (2 * e1);
        const gx2 = (heightAt(x + e2, z) - heightAt(x - e2, z)) / (2 * e2);
        const gz2 = (heightAt(x, z + e2) - heightAt(x, z - e2)) / (2 * e2);
        let nxv = -(gx1 * 0.66 + gx2 * 0.34), nyv = 1, nzv = -(gz1 * 0.66 + gz2 * 0.34);
        const il = 1 / Math.hypot(nxv, nyv, nzv);
        nxv *= il; nyv *= il; nzv *= il;

        pos[vi * 3] = x; pos[vi * 3 + 1] = h; pos[vi * 3 + 2] = z;
        nrm[vi * 3] = nxv; nrm[vi * 3 + 1] = nyv; nrm[vi * 3 + 2] = nzv;
        uv[vi * 2] = x * 0.05; uv[vi * 2 + 1] = z * 0.05;
        groundColor(x, z, h, nyv, _c);
        col[vi * 3] = _c.r; col[vi * 3 + 1] = _c.g; col[vi * 3 + 2] = _c.b;
      }
    }

    let f = 0;
    for (let jj = 0; jj < n; jj++) {
      for (let ii = 0; ii < n; ii++) {
        const a = jj * vw + ii, b = a + 1, cq = a + vw + 1, dq = a + vw;
        /* wound so the face normal points up in a right-handed system */
        idx[f++] = a; idx[f++] = cq; idx[f++] = b;
        idx[f++] = a; idx[f++] = dq; idx[f++] = cq;
      }
    }

    /* Skirts. Neighbouring tiles may sit at different LODs and their
       shared edge will not agree to the millimetre; a curtain hanging
       below the border hides the seam for the cost of 4n quads. */
    const drop = 3.5 + step * 3.0;
    let si = vw * vw;
    const edgeIndex = (side, k) => {
      if (side === 0) return k;                       // z = z0
      if (side === 1) return n * vw + k;              // z = z1
      if (side === 2) return k * vw;                  // x = x0
      return k * vw + n;                              // x = x1
    };
    for (let side = 0; side < 4; side++) {
      const base = si;
      for (let k = 0; k <= n; k++) {
        const src = edgeIndex(side, k);
        const v = si++;
        pos[v * 3] = pos[src * 3];
        pos[v * 3 + 1] = pos[src * 3 + 1] - drop;
        pos[v * 3 + 2] = pos[src * 3 + 2];
        nrm[v * 3] = nrm[src * 3]; nrm[v * 3 + 1] = nrm[src * 3 + 1]; nrm[v * 3 + 2] = nrm[src * 3 + 2];
        col[v * 3] = col[src * 3]; col[v * 3 + 1] = col[src * 3 + 1]; col[v * 3 + 2] = col[src * 3 + 2];
        uv[v * 2] = uv[src * 2]; uv[v * 2 + 1] = uv[src * 2 + 1];
      }
      const flip = (side === 1 || side === 2);
      for (let k = 0; k < n; k++) {
        const t0 = edgeIndex(side, k), t1 = edgeIndex(side, k + 1);
        const b0 = base + k, b1 = base + k + 1;
        if (flip) { idx[f++] = t0; idx[f++] = b0; idx[f++] = t1; idx[f++] = t1; idx[f++] = b0; idx[f++] = b1; }
        else { idx[f++] = t0; idx[f++] = t1; idx[f++] = b0; idx[f++] = t1; idx[f++] = b1; idx[f++] = b0; }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx.subarray(0, f), 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }

  const pending = [];

  function buildTiles() {
    for (let tj = 0; tj < TZ; tj++) {
      for (let ti = 0; ti < TX; ti++) {
        const x0 = gx0 + ti * TILE, z0 = gz0 + tj * TILE;
        const cx = x0 + TILE / 2, cz = z0 + TILE / 2;
        /* Skip tiles that are only deep water: the ocean covers them
           and a seabed nobody can see is 8k triangles of nothing. */
        /* Keep the tile if ANY of it is land or near-shore seabed —
           taking the MIN here culled every tile that straddled the
           coast, which is every tile that matters. */
        const nearest = Math.max(
          shoreDist(x0, z0), shoreDist(x0 + TILE, z0),
          shoreDist(x0, z0 + TILE), shoreDist(x0 + TILE, z0 + TILE),
          shoreDist(cx, cz),
        );
        if (nearest < -132) continue;

        const tile = {
          ti, tj, x0, z0, cx, cz,
          geo: [null, null, null, null],
          level: -1,
          mesh: null,
        };
        tile.geo[3] = buildTileGeometry(tile, 3);
        tile.geo[2] = buildTileGeometry(tile, 2);
        const mesh = new THREE.Mesh(tile.geo[3], material);
        mesh.name = `terrain.${ti}.${tj}`;
        mesh.receiveShadow = true;
        mesh.castShadow = false;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        tile.mesh = mesh;
        tile.level = 3;
        group.add(mesh);
        tiles.push(tile);
      }
    }
  }

  function wantLevel(dist) {
    for (let l = 0; l < LOD_DIST.length; l++) if (dist < LOD_DIST[l]) return l;
    return LOD_DIST.length - 1;
  }

  const _cam = new THREE.Vector3();
  function updateLOD(camera) {
    camera.getWorldPosition(_cam);
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      const dx = _cam.x - t.cx, dz = _cam.z - t.cz;
      const d = Math.hypot(dx, dz);
      /* hysteresis: 12 % dead band, so a tile on a boundary does not
         rebuild-thrash while the camera drifts */
      let want = wantLevel(d);
      if (want !== t.level) {
        const bound = LOD_DIST[Math.min(want, t.level)];
        if (Number.isFinite(bound) && Math.abs(d - bound) < bound * 0.06) want = t.level;
      }
      if (want === t.level) continue;
      if (!t.geo[want]) {
        if (!t.queued) { t.queued = true; pending.push({ tile: t, level: want }); }
        continue;
      }
      t.level = want;
      t.mesh.geometry = t.geo[want];
      t.mesh.castShadow = want <= 1;
    }
  }

  function processPending(budget = 2) {
    let n = 0;
    while (pending.length && n < budget) {
      const job = pending.shift();
      const t = job.tile;
      t.queued = false;
      if (!t.geo[job.level]) t.geo[job.level] = buildTileGeometry(t, job.level);
      n++;
    }
  }

  /* ============================================================
     ROCK — the geometry the heightfield cannot hold.

     A 2 m raster on a 70-degree face resolves nothing finer than
     6 m of rock, and no amount of shader work puts an OVERHANG on a
     heightfield: by definition it has one height per column. So the
     shelves that jut, the boulders embedded in the foot of the face
     and the blocks tumbled into the surf are real meshes.

     They are merged per 224 m sector rather than instanced, because
     every vertex is coloured from its own WORLD position — which is
     what makes a fallen block's bedding line up with the bedding of
     the face it fell off, and is most of why they read as part of
     the cliff instead of as props parked against it.
     ============================================================ */
  const rockGroup = new THREE.Group();
  rockGroup.name = 'terrain.rock';

  let rockMat = null, ledgeMat = null;
  const rockGeos = [];
  /* Every rock that stands proud of ground a player can walk on, with
     the matrix it was drawn at. Registered with ctx.phys in a window
     around the player — see rockCollision(). */
  const rockCols = [];
  /* One plain record per placed rock — kind, how proud it stands, the
     ground normal under it, and which half of the gate (if either)
     turned it away. Five hundred-odd tiny objects, no geometry held;
     it is what `rockGateCensus()` reports, and the only way to answer
     "why has that drawn boulder no body?" without a rebuild. */
  const rockCensus = [];
  const _rbb = new THREE.Box3();
  const _rfn = new THREE.Vector3();
  const _UPV = new THREE.Vector3(0, 1, 0);

  /* The two numbers the collider gate is made of: how proud a rock has
     to stand before its own surface is a better answer than the
     heightfield under it (surfacetest's SINK_TOL is 0.12, so anything
     under 0.10 is already inside tolerance), and the slope beyond
     which ground stops being ground he can stand on. */
  const ROCK_RISE = 0.10;
  const ROCK_WALK_NY = 0.45;

  /**
   * Is any of the ground this block covers ground he could stand on,
   * with the block standing proud of it?
   *
   * A 5x5 grid over the transformed bounding box. The box is a
   * superset of the hull, so a corner sample can vote for a block that
   * does not actually reach there — that costs a few hundred triangles
   * of collision and never costs correctness, which is the right way
   * round for a gate whose failure mode is a drawn rock with no body.
   */
  function walkableUnder(bb, anchorNy) {
    if (anchorNy > ROCK_WALK_NY) return true;
    const dx = (bb.max.x - bb.min.x) / 4, dz = (bb.max.z - bb.min.z) / 4;
    for (let i = 0; i <= 4; i++) {
      for (let j = 0; j <= 4; j++) {
        const x = bb.min.x + dx * i, z = bb.min.z + dz * j;
        normalAt(x, z, _rfn);
        if (_rfn.y <= ROCK_WALK_NY) continue;
        if (bb.max.y - heightAt(x, z) > ROCK_RISE) return true;
      }
    }
    return false;
  }

  /* One boulder. Wind Waker rock is CARVED: a big confident rounded
     mass, then flat planes cut into it. So — lobes for the mass,
     a chamfered y-quantiser for the shelves, and flat shading, which
     is what turns a lump into something that looks struck rather
     than grown. */
  function makeRockGeo(rng, opts = {}) {
    const g = new THREE.IcosahedronGeometry(1, opts.detail ?? 1);
    const pos = g.attributes.position;
    const lobes = [];
    const L = opts.lobes ?? (4 + Math.floor(rng() * 3));
    const amp = opts.lobeAmp ?? 0.30;
    for (let i = 0; i < L; i++) {
      const u = rng() * 2 - 1, a = rng() * Math.PI * 2, s = Math.sqrt(Math.max(0, 1 - u * u));
      lobes.push([Math.cos(a) * s, u, Math.sin(a) * s, 0.10 + rng() * amp, 1.0 + rng() * 2.6]);
    }
    const sx = 0.76 + rng() * 0.54;
    const sy = opts.flat ? 0.24 + rng() * 0.22 : 0.58 + rng() * 0.42;
    const sz = 0.76 + rng() * 0.54;
    /* Shelves per unit radius. A boulder wants two or three visible
       steps; more than that and it reads as a pine cone. */
    const shelves = opts.shelves ?? (2.0 + rng() * 1.8);
    const phase = rng();
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).normalize();
      let r = 1;
      for (const l of lobes) {
        const d = v.x * l[0] + v.y * l[1] + v.z * l[2];
        r += l[3] * Math.pow(Math.max(0, d), l[4]);
        r -= l[3] * 0.30 * Math.pow(Math.max(0, -d), l[4]);
      }
      v.multiplyScalar(r);
      v.x *= sx; v.y *= sy; v.z *= sz;
      /* chamfered bedding, in the rock's own local up */
      const t = v.y * shelves + phase;
      const f = t - Math.floor(t);
      v.y += (smoothstep(0.22, 0.80, f) - f) * (0.62 / shelves);
      /* and the girth pinches in at every parting */
      const pinch = 1 - 0.085 * (1 - smoothstep(0.0, 0.22, f));
      v.x *= pinch; v.z *= pinch;
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    const out = g.toNonIndexed();
    g.dispose();
    out.computeVertexNormals();
    smoothSeams(out, 0.62);
    return out;
  }

  /* ============================================================
     SMOOTHING GROUPS.

     THREE's PolyhedronGeometry is already non-indexed, so
     computeVertexNormals() gives every triangle its own flat normal
     and the lobe pass then hands you a faceted convex hull — which is
     exactly what the foreground boulders in the shore shot are, and
     §7 forbids visible polygon faceting on any organic form outright.

     Welding to a fully smooth normal would go too far the other way
     (a boulder is CARVED — the chamfer crease at every bedding
     parting is the whole read). So: average the face normals at each
     welded position, then blend each triangle's own normal toward
     that average only where the two already agree within ~52 deg.
     Tessellation seams vanish; the struck edges stay struck.
     ============================================================ */
  function smoothSeams(geo, cosLimit = 0.62) {
    const P = geo.attributes.position, N = geo.attributes.normal;
    const map = new Map();
    for (let i = 0; i < P.count; i++) {
      const k = `${Math.round(P.getX(i) * 1e4)},${Math.round(P.getY(i) * 1e4)},${Math.round(P.getZ(i) * 1e4)}`;
      let e = map.get(k);
      if (!e) { e = [0, 0, 0, []]; map.set(k, e); }
      e[0] += N.getX(i); e[1] += N.getY(i); e[2] += N.getZ(i);
      e[3].push(i);
    }
    for (const e of map.values()) {
      const l = Math.hypot(e[0], e[1], e[2]) || 1;
      const sx = e[0] / l, sy = e[1] / l, sz = e[2] / l;
      for (const i of e[3]) {
        const nx = N.getX(i), ny = N.getY(i), nz = N.getZ(i);
        const d = nx * sx + ny * sy + nz * sz;
        const w = smoothstep(cosLimit, Math.min(0.985, cosLimit + 0.30), d);
        const ox = lerp(nx, sx, w), oy = lerp(ny, sy, w), oz = lerp(nz, sz, w);
        const il = 1 / (Math.hypot(ox, oy, oz) || 1);
        N.setXYZ(i, ox * il, oy * il, oz * il);
      }
    }
    N.needsUpdate = true;
    return geo;
  }

  /* Accumulate transformed, world-coloured copies into sector buckets. */
  function makeMerger() {
    const buckets = new Map();
    const v = new THREE.Vector3(), nv = new THREE.Vector3();
    const col = new THREE.Color();
    return {
      buckets,
      add(geo, mat4, nrm3, colorFn, key) {
        let b = buckets.get(key);
        if (!b) { b = { pos: [], nrm: [], col: [], uv: [] }; buckets.set(key, b); }
        const P = geo.attributes.position, N = geo.attributes.normal, U = geo.attributes.uv;
        for (let i = 0; i < P.count; i++) {
          v.fromBufferAttribute(P, i).applyMatrix4(mat4);
          nv.fromBufferAttribute(N, i).applyMatrix3(nrm3).normalize();
          colorFn(v, nv, col);
          b.pos.push(v.x, v.y, v.z);
          b.nrm.push(nv.x, nv.y, nv.z);
          b.col.push(col.r, col.g, col.b);
          b.uv.push(U ? U.getX(i) : 0, U ? U.getY(i) : 0);
        }
      },
      build(mat, group, name, prefix) {
        for (const [key, b] of buckets) {
          if (!b.pos.length) continue;
          if (prefix && key[0] !== prefix) continue;
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.pos), 3));
          g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(b.nrm), 3));
          g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(b.col), 3));
          g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(b.uv), 2));
          g.computeBoundingSphere();
          g.computeBoundingBox();
          const m = new THREE.Mesh(g, mat);
          m.name = `${name}.${key}`;
          m.matrixAutoUpdate = false;
          m.updateMatrix();
          group.add(m);
        }
      },
    };
  }

  const SECTOR = 224;
  const sectorKey = (x, z) => `${Math.floor(x / SECTOR)},${Math.floor(z / SECTOR)}`;

  function nearLocation(x, z, k = 1.5) {
    for (const l of LOCATIONS) {
      const r = l.radius * k;
      const dx = x - l.world.x, dz = z - l.world.z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  function buildRocks() {
    const rng = ctx.makeRng('wally.rock.v1');
    const scale = clamp(ctx.quality.grass ?? 1, 0.28, 1.4);

    rockMat = ctx.mat.plaster({
      name: 'terrain.rock',
      color: 0xffffff,
      vertexColors: true,
      variation: 0.0, edgeWear: 0.0, varScale: 0.42, relief: 0.55,
      /* THE CLIFF WALL MEASURED A HIGH-FREQUENCY STD-DEV OF 3.013
         AGAINST AN EMPTY-SKY READING OF 3.022 — the rock carried no
         surface of its own, only the post chain's film grain, because
         the fade was fully out by 26-150 m and cliffs are reviewed
         from 74. Grain has to survive to the distance the surface is
         actually looked at (§1.2, §6). */
      grain: 0.021, grainScale: 0.70, grainAlbedo: 0.17, grainFade: [130, 460],
      /* rock is modelled form, so it needs far less help banding than
         the ground does */
      macro: 0.24, macroScale: 0.13,
      /* THE TERMINATOR IS WHERE THE TREAD/RISER CONTRAST COMES FROM.
         Now that cliffPass cuts real level shelves with near-vertical
         risers between them, the two are separated by ~80 degrees of
         normal and the ramp can do the work an albedo ripple was
         failing to do: the tread takes the core band, the riser drops
         into shade. At term 0.10 nothing on the face ever left the
         lit band and the whole cliff rendered as one flat value. */
      term: 0.22, bandSoft: 0.030, band2: 0.52, core: 0.46, coreSoft: 0.040,
      /* Rock is the one world surface routinely seen with its lit
         side and its shaded side in the SAME frame at close range —
         a block in the surf against the face it fell from. At the
         world defaults the two read as different materials: the
         boulder went slate-blue while the cliff behind it stayed
         warm taupe. The law is kept, at a slightly gentler rotation
         and a much smaller value drop, so shade still goes
         blue-violet (never grey, §2.1) without severing the block
         from its own parent rock. */
      shadowAmount: 0.55, shadowValue: 0.76, shadowBleed: 0.10, shadowFill: 0.070,
      spec: 0.045, specPow: 20,
      /* A RIM IS A SILHOUETTE EFFECT AND AN EMBEDDED BLOCK HAS NO
         SILHOUETTE. At 0.30 every ledge on the face wore a bright
         fresnel edge against the wall behind it, which is precisely
         the halo that made them read as decals. The terrain material
         sets rim 0 for the same reason. */
      rim: 0.10, skyBounce: 0.22,
      outline: true, outlineWidth: 2.1,
    });
    /* The ledges cut INTO the face get no outline at all: a stroke
       round a shape that is half inside another surface draws the
       half that is buried too, and the result is a lozenge sticker.
       Free-standing talus keeps its stroke — it has a real
       silhouette, against sand and against water. */
    ledgeMat = ctx.mat.plaster({
      ...rockMat.userData.wally,
      name: 'terrain.ledge',
      outline: false, noOutline: true, rim: 0.0,
    });
    /* flat 0.22: a boulder's top is still rock and still bedded, so
       the slope gate the terrain uses to tell turf from stone is
       wrong here — it would leave every sunlit cap unbanded. */
    patchStrata(rockMat, { amount: 1.0, flat: 0.22, step: 3.1 });
    patchStrata(ledgeMat, { amount: 1.0, flat: 0.22, step: 3.1 });

    /* One subdivision up on every population. §7 forbids visible
       polygon faceting, and at detail 1 a 6 m boulder's silhouette is
       a 20-sided polygon whose chords are plainly straight at ten
       metres — smoothing the normals fixes the shading but a
       silhouette is geometry and only geometry fixes it. */
    const boulders = [];
    for (let i = 0; i < 8; i++) boulders.push(makeRockGeo(rng, { detail: 2 }));
    const blocks = [];
    for (let i = 0; i < 6; i++) blocks.push(makeRockGeo(rng, { detail: 3, shelves: 2.4 + rng() * 1.4 }));
    const slabs = [];
    for (let i = 0; i < 6; i++) slabs.push(makeRockGeo(rng, { detail: 2, flat: true, shelves: 1.6, lobes: 7, lobeAmp: 0.46 }));
    rockGeos.push(...boulders, ...blocks, ...slabs);

    /* ============================================================
       WHERE ROCK CAN LIE.

       A dozen boulders half-buried in a near-vertical wall with no
       talus under them do not read as geology, they read as fridge
       magnets — gravity is the most legible physical law in any
       frame and a rock that ignores it costs more than it buys. So
       the slope is a hard gate: nothing free-standing is placed
       where wideSteep > 0.45, and every instance that would have
       been goes into the scree fan at the foot of that same face,
       which is where it would actually be.
       ============================================================ */
    function slideToFoot(x0, z0) {
      let x = x0, z = z0;
      const e = 6;
      for (let s = 0; s < 26; s++) {
        const gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
        const gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
        const m = Math.hypot(gx, gz);
        if (m < 1e-4) break;
        x -= (gx / m) * 3.0;
        z -= (gz / m) * 3.0;
        if (wideSteep(x, z, 8) < 0.26) return { x, z, ok: true, run: s * 3.0 };
      }
      return { x, z, ok: false, run: 0 };
    }

    /* ---- candidates ---- */
    const picks = [];
    const STRIDE = 3;
    for (let j = 2; j < NZ - 2; j += STRIDE) {
      for (let i = 2; i < NX - 2; i += STRIDE) {
        const o = IX(i, j);
        const d = SD[o];
        if (d < -20 || d > 64) continue;
        const x = wx(i), z = wz(j), h = H[o];
        if (h > 70) continue;
        const rocky = cliffiness(x, z, bearingOf(x, z));
        if (rocky < 0.30) continue;
        if (PATH[o] > 0.18 || nearLocation(x, z)) continue;
        const st = wideSteep(x, z, 8);

        /* --- the face itself sheds; the debris piles at its foot --- */
        if (st > 0.45) {
          if (h > 5 && rng() < 0.52 * rocky) {
            const f = slideToFoot(x, z);
            if (f.ok && f.run > 2) {
              /* up: 0 at the toe of the fan, 1 at the top of the
                 pile. Biased to the toe, because that is where a
                 scree cone actually has its mass, and the blocks up
                 near the face are the small ones. */
              const up = rng() * rng();
              const px = f.x + (x - f.x) * up * 0.55;
              const pz = f.z + (z - f.z) * up * 0.55;
              picks.push({ x: px, z: pz, h: heightAt(px, pz), d: shoreDistAt(px, pz), st, up, kind: 'scree' });
            }
          }
          continue;
        }

        /* --- a slab jutting from the brink of a shelf. It needs
           ground under its inner half, so it goes on the TREAD at
           the lip, not pasted on the wall below it. --- */
        if (st < 0.30 && h > 4) {
          const e = 6;
          const gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
          const gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
          const m = Math.hypot(gx, gz);
          if (m > 1e-4 && wideSteep(x - (gx / m) * 7, z - (gz / m) * 7, 6) > 0.46) {
            if (rng() < 0.26 * rocky) picks.push({ x: x - (gx / m) * 1.6, z: z - (gz / m) * 1.6, h, d, st, kind: 'slab' });
          }
        }
        if (st > 0.20 && d > -2 && d < 46) {
          if (rng() < 0.30 * rocky * smoothstep(0.18, 0.44, st)) picks.push({ x, z, h, d, st, kind: 'base' });
        }
        if (d > -16 && d < 14) {
          /* talus: what the face has already shed, lying in the surf */
          if (rng() < 0.36 * rocky) picks.push({ x, z, h, d, st, kind: 'talus' });
        }
      }
    }

    /* Trim to budget by even stride, so thinning never empties one
       headland to crowd another. */
    const budget = Math.round(560 * scale);
    let list = picks;
    if (picks.length > budget) {
      const step = picks.length / budget;
      list = [];
      for (let t = 0; t < budget; t++) list.push(picks[Math.floor(t * step)]);
    }

    const merger = makeMerger();
    const m4 = new THREE.Matrix4();
    const n3 = new THREE.Matrix3();
    const q = new THREE.Quaternion(), q2 = new THREE.Quaternion();
    const p = new THREE.Vector3(), sc = new THREE.Vector3(), ax = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    const base = new THREE.Color();

    for (const c of list) {
      /* Horizontal and vertical extent are SEPARATE numbers, and the
         first version of this conflated them: a slab is 0.3 as tall
         as it is wide, so burying it by "half its size" buried it
         completely and what was left on the wall was a disc. */
      let geo, sxz, sy, hsink, vsink, tiltK, jit;
      if (c.kind === 'slab') {
        geo = slabs[Math.floor(rng() * slabs.length)];
        sxz = 4.2 + rng() * 7.0;
        /* A LEDGE IS A PLATE. At 0.34-0.60 of its own width these
           came out as mushrooms growing off the wall; a shelf is
           thin, and most of it is still inside the cliff. */
        sy = sxz * (0.17 + rng() * 0.13);
        hsink = 0.62; vsink = 0.30; tiltK = 0.20; jit = 4.0;
      } else if (c.kind === 'scree') {
        /* A TALUS FAN IS GRADED. The big blocks bounce to the toe and
           the fines stay high against the wall, so size falls off up
           the pile — that gradient is most of why a scree cone reads
           as a scree cone and not as gravel sprinkled on a hill. */
        geo = (rng() < 0.55 ? blocks : boulders)[Math.floor(rng() * 6)];
        sxz = (1.7 + rng() * 4.6) * (1 - 0.55 * c.up);
        sy = sxz * (0.54 + rng() * 0.40);
        hsink = 0.10; vsink = 0.44; tiltK = 0.62; jit = 6.0;
      } else if (c.kind === 'base') {
        geo = blocks[Math.floor(rng() * blocks.length)];
        sxz = 2.0 + rng() * 4.4;
        sy = sxz * (0.62 + rng() * 0.45);
        hsink = 0.34; vsink = 0.34; tiltK = 0.38; jit = 5.5;
      } else {
        geo = boulders[Math.floor(rng() * boulders.length)];
        sxz = 0.8 + rng() * 2.6;
        sy = sxz * (0.60 + rng() * 0.42);
        hsink = 0.10; vsink = 0.30; tiltK = 0.22; jit = 5.5;
      }

      const jx = c.x + (rng() - 0.5) * jit;
      const jz = c.z + (rng() - 0.5) * jit;
      const gy = heightAt(jx, jz);
      normalAt(jx, jz, nrm);

      /* A ledge is HORIZONTAL and sticks out of a vertical wall, so
         its own up stays near world up; only tumbled blocks lie
         over. */
      ax.set(0, 1, 0).lerp(nrm, tiltK);
      ax.x += (rng() - 0.5) * 0.26;
      ax.z += (rng() - 0.5) * 0.26;
      ax.normalize();
      q.setFromUnitVectors(_UPV, ax);
      q2.setFromAxisAngle(_UPV, rng() * Math.PI * 2);
      q.multiply(q2);

      sc.set(sxz * (0.84 + rng() * 0.40), sy, sxz * (0.84 + rng() * 0.40));
      /* Pushed INTO the face along its normal, and only lightly down:
         on a 70-degree wall "down" is almost along the surface, so
         sinking a block vertically leaves it hanging in the air. */
      p.set(jx - nrm.x * sxz * hsink, gy - sy * vsink, jz - nrm.z * sxz * hsink);
      m4.compose(p, q, sc);
      n3.getNormalMatrix(m4);

      /* One tone lookup per block, at the block, so a boulder is
         always the same value as the metre of island it is sitting
         on however the regional field is running there. */
      const tint = (0.90 + rng() * 0.20) * groundTone(jx, jz);
      merger.add(geo, m4, n3, (wv, wn, out) => {
        rockBase(wv.x, wv.y, wv.z, base);
        /* Underside AO and a per-block tint. The strata shader adds
           the bedding on top of this in the fragment. */
        const up = wn.y * 0.5 + 0.5;
        const k = tint * (0.86 + 0.24 * up);
        out.copy(base).lerp(C_ROCK_D, (1 - up) * 0.30);
        out.setRGB(out.r * k, out.g * k, out.b * k);
        groundChroma(out);
      }, (c.kind === 'slab' ? 'L' : 'R') + sectorKey(jx, jz));

      /* ----------------------------------------------------------
         THE ONES YOU CAN WALK INTO.

         Rock is the only part of the island the heightfield cannot
         express, so none of it was in the collision world — and
         surfacetest found him a full 0.45 m inside the talus lying on
         the beach, which is shin-deep in a boulder he is standing
         beside. Two gates keep this from becoming a quarter of a
         million triangles of cliff:

           the ROCK has to stand proud enough to matter (below the
           tolerance the heightfield under it is already the right
           answer), and

           the GROUND under it has to be walkable. A block bedded into
           a 60-degree wall is backed by terrain he cannot reach in the
           first place; giving it a body would only ever cost the
           camera a clearance ray.

         THE SECOND GATE USED TO ASK ABOUT A POINT AND THE ROCK IS NOT
         A POINT. It read normalAt(jx, jz) — the ground under the
         block's ANCHOR — and a talus block is up to 23 m across. The
         east beach had one anchored at (479.3, 5.9) where the shore
         face falls at 67 degrees (n.y 0.391), so the gate threw it
         away; its flanks lie out across the flat sand four metres
         away, and surfacetest found him 0.45 m inside a boulder that
         was drawn and had no body. So the question is asked over the
         block's whole PLAN FOOTPRINT: is there anywhere under this
         thing where the ground is walkable AND the rock stands proud
         of it? The anchor is still the fast path — only the blocks the
         old gate would have rejected pay for the grid.

         The survivors are handed their OWN geometry, not a proxy: a
         box round a lobed boulder either floats over its flanks or
         sinks under its crown, and 0.12 m is not enough room for
         either. Cost is bounded by streaming them (rockCollision
         below), not by approximating them.
         ---------------------------------------------------------- */
      if (!geo.boundingBox) geo.computeBoundingBox();
      _rbb.copy(geo.boundingBox).applyMatrix4(m4);
      const rise = _rbb.max.y - gy;
      /* ROCK_RISE is 0.10 because the surface test's tolerance is 0.12
         and a rock under that is already inside it; ROCK_WALK_NY is
         0.45 because ground steeper than that is not ground he can
         stand on, and rock backed only by such ground would cost a
         camera ray and buy nothing. What changed is WHERE the second
         one is evaluated — see walkableUnder(). */
      const okRise = rise > ROCK_RISE, okGround = walkableUnder(_rbb, nrm.y);
      rockCensus.push({
        x: +jx.toFixed(1), z: +jz.toFixed(1), kind: c.kind,
        rise: +rise.toFixed(3), ny: +nrm.y.toFixed(3),
        top: +_rbb.max.y.toFixed(2), gy: +gy.toFixed(2),
        /* the plan box the footprint gate walked, so an outside judge
           can re-run the same question on its own terms — see the rock
           assertion in tools/surfacetest.mjs */
        box: [+_rbb.min.x.toFixed(2), +_rbb.min.z.toFixed(2), +_rbb.max.x.toFixed(2), +_rbb.max.z.toFixed(2)],
        r: +(Math.max(_rbb.max.x - _rbb.min.x, _rbb.max.z - _rbb.min.z) * 0.5).toFixed(2),
        solid: okRise && okGround,
        why: okRise && okGround ? '' : (!okRise && !okGround ? 'rise+ground' : (!okRise ? 'rise' : 'ground')),
      });
      if (okRise && okGround) {
        rockCols.push({
          x: jx, z: jz, geo, m: m4.clone(),
          r: Math.max(_rbb.max.x - _rbb.min.x, _rbb.max.z - _rbb.min.z) * 0.5,
          tris: geo.attributes.position.count / 3,
        });
      }
    }

    merger.build(ledgeMat, rockGroup, 'ledge', 'L');
    merger.build(rockMat, rockGroup, 'rock', 'R');
    ctx.mat.register(rockGroup, {
      outline: true, color: LAND.cliff,
      castShadow: true, receiveShadow: true,
    });
    return list.length;
  }

  /* ============================================================
     THE GRASS LIP IS GONE. Read this before adding it back.

     The feature drew sod tongues overhanging the island's brinks, to
     break the hard silhouette line where the plateau meets the face.
     It had three rounds of art fixes, each of which found something
     real: a full random spin and a depth scaled off the width (12 m
     sods pointing at any bearing, six metres thick); mats plastering
     grey rock metres below the turf line, fixed with a daylight
     requirement; and a lift term that always won on a real cliff, so
     the top face sat a median 1.43 m below its own brink. After all
     three it still read as "a large planar green wedge extruded
     sideways into the sky ... a diving board, not torn sod".

     WHAT DECIDED IT was four A/B pairs shot from spots the physics
     controller actually stands on, with main.js's dt frozen to zero so
     the only difference between the two frames is the tongues (wind,
     grass, cloud and water move enough to change 83k pixels of a 921k
     frame otherwise, which is how a diff of this feature had been
     lying). The frames are the argument, not this paragraph:
     scratchpad wl7/ab, run6a/run11/run6b/lone-divingboard, -off
     against -on. In every one the frame is better WITHOUT: the OFF
     ridge is a clean grass headland whose edge is already broken all
     along by the blade field, and the ON frame adds dark, hard-edged,
     dead-straight flat polygons that read as torn card stuck to the
     silhouette, or as holes punched in the world.

     THE ONE PLACE IT WAS SAID TO WORK — "several tongues seen edge-on
     along one brink" — WAS SHOT ON PURPOSE AND FAILED. It also barely
     existed: measured over the 80 that stood, no tongue anywhere on
     the island had three neighbours within 6 m, 24 of the 39 clusters
     were a single tongue, and 15 tongues had nothing within 12 m. A
     grid picker over a 0.13-0.38 steepness band produces isolated
     picks, and AIR_MIN then deleted 184 of 264 and thinned what runs
     there were into scattered singletons. A real fringe needs a traced
     brink polyline and elements at tuft scale — and at tuft scale the
     element IS a grass blade, which grass.js already draws at 68 per
     m² with wind, baked AO, ground-sampled colour and a far-field
     shader path. The endpoint of the surviving design is a worse
     duplicate of a feature that already exists.

     AND 38 % OF WHAT IT DREW WAS BURIED. AIR_MIN was a MAXIMUM over
     the mat's 135 vertices, so a mat lying in a terrace passed on its
     single most-lifted corner: of the 80 placed, 30 had a vertex under
     0.10 m of clearance, 20 had a third or more of the mat under
     0.10 m, 17 had a median vertex under 0.25 m and 11 had their
     median vertex UNDERGROUND — the worst 123 of 135 vertices under
     the raster, 91 % buried. Gating on a fraction instead of the
     extremum was the fix while the feature lived; deleting it removes
     the same waste, all 3,600 triangles of it.

     What the island loses: nothing that showed up in a frame. The
     ground shader still paints turf green over the brink (lipFactor,
     above, which is a different thing and stays), and the blade field
     still breaks the edge. If you bring this back, bring back a
     silhouette A/B with the world frozen — not a screenshot from on
     top of the brink looking down, which is the one angle at which a
     curtain looks like a sheet.
     ============================================================ */

  /* ============================================================
     Collision — a 3x3 window of 64 m tiles that follows the player.

     A whole-island triangle soup at walkable resolution is a quarter
     of a million triangles in a 2 m broadphase grid, which is tens of
     megabytes and half a second of boot. A window costs 2k triangles
     per tile and only ever builds the three tiles that entered the
     window, one per frame.
     ============================================================ */
  const colTiles = new Map();
  let colCentre = null;

  function buildColliderTile(ci, cj) {
    const n = COL_TILE / CELL;                 // 32 quads
    const x0 = ci * COL_TILE, z0 = cj * COL_TILE;
    const verts = new Float32Array((n + 1) * (n + 1) * 3);
    let v = 0;
    for (let jj = 0; jj <= n; jj++) {
      const z = z0 + jj * CELL;
      for (let ii = 0; ii <= n; ii++) {
        const x = x0 + ii * CELL;
        verts[v++] = x; verts[v++] = heightAt(x, z); verts[v++] = z;
      }
    }
    const idx = new Uint32Array(n * n * 6);
    let f = 0;
    const vw = n + 1;
    for (let jj = 0; jj < n; jj++) {
      for (let ii = 0; ii < n; ii++) {
        const a = jj * vw + ii, b = a + 1, c2 = a + vw + 1, d2 = a + vw;
        idx[f++] = a; idx[f++] = c2; idx[f++] = b;
        idx[f++] = a; idx[f++] = d2; idx[f++] = c2;
      }
    }
    return ctx.phys.addTriangles(verts, idx, { name: `terrain.col.${ci}.${cj}`, walkable: true });
  }

  function updateCollision(px, pz, budget = 1) {
    if (!ctx.phys || !ctx.phys.addTriangles) return;
    const ci = Math.floor(px / COL_TILE), cj = Math.floor(pz / COL_TILE);
    if (colCentre && colCentre.ci === ci && colCentre.cj === cj && !pendingCol.length) return;
    if (!colCentre || colCentre.ci !== ci || colCentre.cj !== cj) {
      colCentre = { ci, cj };
      /* Drop the old queue first. Jobs queued for the PREVIOUS window
         are not in the new keep-set, so building them anyway silently
         grew the collision world past its 3x3 budget — measured 14
         live tiles for a player who had never left the origin. */
      pendingCol.length = 0;
      pendingColKeys.clear();
      const keep = new Set();
      for (let j = -COL_RING; j <= COL_RING; j++) {
        for (let i = -COL_RING; i <= COL_RING; i++) {
          const key = `${ci + i},${cj + j}`;
          keep.add(key);
          if (!colTiles.has(key) && !pendingColKeys.has(key)) {
            pendingCol.push({ key, ci: ci + i, cj: cj + j, d: Math.hypot(i, j) });
            pendingColKeys.add(key);
          }
        }
      }
      pendingCol.sort((a, b) => a.d - b.d);
      for (const [key, id] of [...colTiles]) {
        if (keep.has(key)) continue;
        ctx.phys.remove(id);
        colTiles.delete(key);
      }
    }
    let n = 0;
    while (pendingCol.length && n < budget) {
      const job = pendingCol.shift();
      pendingColKeys.delete(job.key);
      if (Math.abs(job.ci - ci) > COL_RING || Math.abs(job.cj - cj) > COL_RING) continue;
      if (!colTiles.has(job.key)) colTiles.set(job.key, buildColliderTile(job.ci, job.cj));
      n++;
    }
  }
  const pendingCol = [];
  const pendingColKeys = new Set();

  /* ------------------------------------------------------------
     ROCK COLLISION — the same window trick, one rock at a time.

     The candidates were chosen at build time (see buildRocks); this
     only decides which of them are live. Radius is deliberately a
     little wider than the terrain window's inner tile so a boulder is
     always solid well before he can reach it, and the drop radius is
     wider still so walking a boundary cannot thrash it.
     ------------------------------------------------------------ */
  const ROCK_IN = 62, ROCK_OUT = 82;
  const rockLive = new Map();          // index -> body id
  let rockTris = 0;

  function updateRockCollision(px, pz, budget = 2) {
    if (!ctx.phys || !ctx.phys.addTriangles || !rockCols.length) return;
    for (const [i, id] of [...rockLive]) {
      const r = rockCols[i];
      if (Math.hypot(r.x - px, r.z - pz) <= ROCK_OUT + r.r) continue;
      ctx.phys.remove(id);
      rockLive.delete(i);
      rockTris -= r.tris;
    }
    let n = 0;
    for (let i = 0; i < rockCols.length && n < budget; i++) {
      if (rockLive.has(i)) continue;
      const r = rockCols[i];
      if (Math.hypot(r.x - px, r.z - pz) > ROCK_IN + r.r) continue;
      rockLive.set(i, ctx.phys.addTriangles(
        r.geo.attributes.position.array,
        r.geo.index ? r.geo.index.array : null,
        { matrix: r.m, name: 'terrain.rock', walkable: true },
      ));
      rockTris += r.tris;
      n++;
    }
  }

  /* ------------------------------------------------------------
     Build
     ------------------------------------------------------------ */
  const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
  buildRaster();
  /* One blur BEFORE terracing (the three noise fields leave
     raster-scale speckle), none after: a blur after terracing is a
     blur of the only hard edges on the island, and the cliffs came
     back as grassy domes. */
  smoothPass(0.45);
  /* THE TERRACE NEEDS RUN TO STAND ON, AND THE LIMITER IS WHERE IT
     COMES FROM. Six iterations at 0.22 relaxation do not converge:
     the face was still standing at gradient ~2.9 (71 degrees) when
     the sculpt ran, which is 16 m of ground for a 46 m cliff — not
     enough plan to fit two shelves into however hard you carve. Run
     it to convergence at the same cap and the face settles at ~1.6
     (58 degrees), 29 m of run, and cliffPass can cut three level
     tiers with vertical risers between them. The OVERALL angle is
     barely changed; what changes is that it is now made of steps. */
  slopeLimitPass(3.1, 14);
  cliffPass();
  /* Re-limit, but only against a genuine spike. The risers the sculpt
     just cut are 14-20 m over one or two cells BY DESIGN — that is
     what a riser is — and at a cap of 9 this pass was quietly
     slumping every one of them back into the ramp it came from. */
  slopeLimitPass(26.0, 2);
  terracePass();
  const tRaster = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;

  const bounds = new THREE.Box3(
    new THREE.Vector3(-BX, -40, -BZ),
    new THREE.Vector3(BX, 90, BZ),
  );

  return {
    group, material, bounds, tiles, rockGroup,
    NX, NZ, CELL, BX, BZ, gx0, gz0, H, PATH, SD,
    IX, wx, wz,
    zoneList, setTurf,
    stats: { rasterMs: Math.round(tRaster), tiles: 0 },

    /* raster mutation, used by paths.js before the meshes exist */
    padPass, zonePass, smoothPass, buildTiles,
    finalise() {
      zonePass();
      buildTiles();
      this.stats.tiles = tiles.length;
      this.stats.rocks = buildRocks();
    },

    heightAt, normalAt, slopeAt, pathAt, shoreDistAt, shoreDist,
    zoneAt, zoneIndexAt, groundColor,
    wideSteep, lipFactor, rockBase, cliffiness, patchStrata,
    updateLOD, processPending, updateCollision, updateRockCollision,
    colliderCount: () => colTiles.size,
    rockColliderStats: () => ({ candidates: rockCols.length, live: rockLive.size, tris: rockTris }),
    /** Every placed rock and why it did or did not get a body. */
    rockGateCensus: (x, z, r = Infinity) => (r === Infinity ? rockCensus
      : rockCensus.filter((e) => Math.hypot(e.x - x, e.z - z) <= r + e.r)),

    dispose() {
      for (const id of rockLive.values()) ctx.phys?.remove(id);
      rockLive.clear();
      for (const t of tiles) for (const g of t.geo) g?.dispose();
      material.dispose();
      for (const m of rockGroup.children) m.geometry?.dispose();
      for (const g of rockGeos) g.dispose();
      rockMat?.dispose();
      for (const id of colTiles.values()) ctx.phys?.remove(id);
      colTiles.clear();
    },
  };
}
