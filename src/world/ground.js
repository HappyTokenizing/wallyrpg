/* ============================================================
   ground.js — THE FLOOR.

   A city is mostly floor, and until this file nothing drew it. The
   roads were a tan ribbon whose edge faded into grass over two and a
   half metres of colour blend; every lamp post, bin and bench in the
   city stood in a lawn; and from the balloon the whole island read as
   a meadow with tracks worn across it. Photographed at eye height on
   Main Street from a settled capsule at (-140, 12) — good sky, good
   houses, and no street anywhere in the frame.

   What a street is, in the order the eye reads it:

     THE KERB      a hard, lit line where the carriageway stops. It is
                   the single mark that turns a track into a street,
                   and it is the one thing you can see from a hundred
                   and seventy metres up as well as from three.
     THE GUTTER    the channel between kerb and tarmac, which is where
                   a town keeps its dirt. Stained under every gully.
     THE FOOTWAY   flags, ten centimetres up. Somewhere to put the
                   lamp post that is currently standing in a field.
     THE FALL      the flags do not stop at a line, they die back into
                   the ground over a third of a metre.

   And four things that are only worth doing because the four above
   exist to hang them on:

     THE SILL      a band of boundary setts laid ACROSS the road on the
                   exact Voronoi bisector where one district becomes
                   another — under the fingerpost that already stands
                   there. The paving changes colour across it. You do
                   not read a sign to know you have left Rusty Row; you
                   walk over the line and the floor changes.
     THE GULLY     a cast grating at the kerb foot, and the stain that
                   fans out of it along the channel.
     THE MANHOLE   one iron cover in the carriageway per street.
     THE DESIRE    the worn chord across the inside of every junction
       PATH        corner, from the end of one pavement to the end of
                   the next. Nobody walks a right angle.
     THE APPROACH  the ground between a named building's door and the
                   nearest carriageway. Laid flags in the districts that
                   could afford them, a beaten track in the ones that
                   could not. Without it every building in this city
                   stands on mown grass with nothing leading to it.

   WHERE THE PAVING IS, AND WHERE IT DELIBERATELY IS NOT.
   Paving is keyed on distance to the nearest BUILDING, not on the
   district disc: the discs have radii of 112-147 m and their centres
   are 200-230 m apart, so "inside the district" is very nearly the
   whole road network and paving by it would have kerbed the open
   country. Kerbs where there are houses; a bare verge between towns;
   and the boundary sill standing in the gap between the two, which is
   exactly where a parish stone stands in a real one.

   THE TWO MEASURED RULES THIS FILE OBEYS
   --------------------------------------
   1. NO CHORD LONGER THAN 0.75 m, along the road or across it. This is
      paths.js's hard-won number (see the two long notes there): a 2 m
      heightfield under a longer chord is a bridge, the drawn surface
      floats over the collision surface, and tools/surfacetest.mjs
      reads it as Wally sinking to the ankles. Everything here is
      sampled at 0.75 m along, and no column pair is wider than that
      across.
   2. EVERYTHING DRAWN PROUD OF THE TERRAIN IS IN THE COLLISION WORLD.
      A raised pavement phys has never heard of is 0.10 m of drawn
      stone over the ground his feet are actually on — the same failure
      as a floating road, with the sign flipped, and surfacetest calls
      it a sink. Registered with ctx.phys as a triangle strip, the way
      world/city.js already registers the founding berms, and covering
      the WHOLE ledge (channel, kerb face, flags, fall) rather than
      only the flags: measured, registering the flags alone left the
      0.36 m fall standing 0.121 m over the terrain and both Rusty Row
      threshold rows went red.
      The kerb face holds its ANGLE, not its width: 0.10 m of rise over
      0.12 m of run is 40 degrees, and where the ground climbs away
      from the carriageway and the upstand grows the run widens with
      it. That keeps the face inside controller.js's 48 degree slope
      limit and far inside its 0.35 m step offset, so he walks up onto
      a pavement without ever being stopped by one — and it keeps the
      capsule off a normal steep enough for surfacetest's capsule-lift
      identity to read the lift itself as a sink.

   PUBLIC API
     createGround(ctx, world, opts) -> {
       group, collision {positions, indices}, stats,
       pavedAt(x,z)   1 where a floor was laid, for foliage.js
       topAt(x,z)     the drawn floor height, or null for bare terrain
     }
     findSeams(world, ZONES, opts) -> [{x, z, tx, tz, a, b, width}]
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { BUILD, LAND, BRAND, SKY } from '../core/palette.js';
import { clamp, lerp, smoothstep } from '../core/contracts.js';
import { mixHex, C, linear } from './kits.js';

const PI = Math.PI;

/* ------------------------------------------------------------------
   Section geometry, metres. Every one of these is measured against
   something: see the header.
   ------------------------------------------------------------------ */
const SAMPLE = 0.75;   // chord along the kerb — paths.js's number
const LIFT = 0.035;    // drawn height over heightAt; the ribbon uses 0.03
const GUT = 0.16;      // gutter channel, flat, at carriageway level
const CHAM = 0.12;     // kerb face run
const RISE = 0.10;     // kerb face rise  -> 40 deg, under the slope limit
const KERB = 0.20;     // the kerbstone itself, a course of its own
const FOOT = 1.30;     // footway width, behind the kerbstone
const SKIRT = 0.36;    // the fall from the flags back to grade
const NODE_FADE = 8.0; // taper to nothing this far from a junction
const MAX_UPSTAND = 0.30;  // past this the bank has won; drop the paving

/* ------------------------------------------------------------------
   THE DISTRICT'S OWN FLOOR.

   The previous two rounds gave each district a confined vocabulary of
   OBJECTS. This is the same idea applied to the surface they stand on,
   and it is worth more per square metre than any of them, because the
   floor is the largest thing in every frame.

   Nothing here invents a colour. Every entry is a recipe over
   src/core/palette.js and world/kits.js's C, the same way
   ZONE_KIT's walls and roofs are.
   ------------------------------------------------------------------ */
const PAVING = {
  /* cheap rent: patched black-top, a kerb nobody has replaced */
  rundown: { flag: mixHex(BUILD.stone, BRAND.ink, 0.44), kerb: mixHex(BUILD.stone, BUILD.woodDark, 0.44), joint: 0.34 },
  /* a civic high street: grey slabs, granite edging */
  city: { flag: mixHex(BUILD.stone, BUILD.metal, 0.30), kerb: mixHex(BUILD.stone, BUILD.metal, 0.56), joint: 0.20 },
  /* chalk dust: warm york stone walked on for a century */
  learn: { flag: mixHex(C.stoneWarm, LAND.dirt, 0.24), kerb: mixHex(C.stoneWarm, BRAND.ink, 0.38), joint: 0.26 },
  /* everything for sale: warm setts, laid and relaid */
  market: { flag: mixHex(BUILD.stone, LAND.dirt, 0.32), kerb: mixHex(C.brick, BRAND.ink, 0.30), joint: 0.40 },
  /* fields: hardstanding, not pavement — dirt with stone rolled in */
  farm: { flag: mixHex(LAND.dirt, BUILD.stone, 0.30), kerb: mixHex(LAND.rock, LAND.dirt, 0.42), joint: 0.30 },
  /* the hills: crushed slag, dark and glittering */
  mine: { flag: mixHex(LAND.rock, BRAND.ink, 0.34), kerb: mixHex(LAND.rockShade, BRAND.ink, 0.20), joint: 0.24 },
  /* the harbour: grey granite, wet-looking even when it is not */
  water: { flag: mixHex(BUILD.stone, BUILD.metal, 0.46), kerb: mixHex(BUILD.metal, BRAND.ink, 0.40), joint: 0.24 },
  /* six startups per building: poured concrete, too clean, faintly cool */
  tech: { flag: mixHex(mixHex(BUILD.stone, BRAND.paper, 0.22), BUILD.metal, 0.26), kerb: C.stoneCool, joint: 0.12 },
  /* a match-day approach: broad grey concrete, scuffed */
  stadium: { flag: mixHex(mixHex(BUILD.stone, LAND.dirt, 0.20), BUILD.metal, 0.20), kerb: mixHex(BUILD.stone, BRAND.ink, 0.36), joint: 0.28 },
  /* where the money lives: dressed pale stone, and it is swept. The
     brightest floor on the island, on purpose — you can see which
     district you are climbing toward from the bottom of the hill. */
  gold: { flag: mixHex(BUILD.stone, BRAND.paper, 0.28), kerb: C.stoneWarm, joint: 0.14 },
};
const PAVING_FALLBACK = PAVING.city;

/* The boundary sill belongs to NEITHER district — that is the whole
   point of it, exactly as the fingerpost above it belongs to neither.
   One stone, used nowhere else on the island. */
const SILL_STONE = mixHex(mixHex(BUILD.stone, LAND.rock, 0.62), LAND.sand, 0.14);
const SILL_JOINT = mixHex(LAND.rock, BRAND.ink, 0.40);
const IRON = mixHex(BUILD.metal, BRAND.ink, 0.52);
const IRON_DARK = mixHex(BUILD.metal, BRAND.ink, 0.72);
/* what standing water does to stone: darker, and toward the sea, not
   toward black. ART §2.1 — nothing in this game goes to grey-black. */
const WET = mixHex(SKY.horizon, BRAND.ink, 0.62);
const WORN_EARTH = mixHex(LAND.dirt, LAND.grassShade, 0.14);

/* ------------------------------------------------------------------
   Resample a polyline so no segment is longer than `step`, keeping
   every original vertex. XZ only — the caller looks the height up per
   sample, which is the entire reason for doing this.
   ------------------------------------------------------------------ */
function densify(pts, step) {
  if (!pts || pts.length < 2) return pts || [];
  const out = [{ x: pts[0].x, z: pts[0].z }];
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

/**
 * WHERE ONE DISTRICT BECOMES ANOTHER, MEASURED.
 *
 * A point is on a seam when its two nearest district centres are
 * within `eq` metres of each other: that is the Voronoi bisector, the
 * same partition city.js scatters its district vocabulary by, so a
 * seam marker cannot land anywhere except exactly where the vocabulary
 * changes. Walked along the road ribbons rather than sampled over the
 * island, because a boundary you can read is one you cross.
 *
 * This used to live inline in city.js, where it placed the ten
 * fingerposts. It is here now because the sill and the post have to be
 * in the SAME place or neither of them means anything, and two copies
 * of a Voronoi test drift apart the first time one of them is touched.
 */
export function findSeams(world, ZONES, { eq = 7, gap = 78 } = {}) {
  const keys = Object.keys(ZONES);
  const twoNearest = (x, z) => {
    let b0 = Infinity, b1 = Infinity, z0 = null, z1 = null;
    for (const zid of keys) {
      const c = ZONES[zid].world;
      const d = Math.hypot(x - c.x, z - c.z);
      if (d < b0) { b1 = b0; z1 = z0; b0 = d; z0 = zid; }
      else if (d < b1) { b1 = d; z1 = zid; }
    }
    return { b0, b1, z0, z1 };
  };
  const out = [];
  for (const e of world.paths?.edges || []) {
    const pts = e.points;
    if (!pts || pts.length < 3) continue;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i], q = pts[i - 1];
      const n = twoNearest(p.x, p.z);
      if (!n.z1 || n.b1 - n.b0 > eq) continue;
      /* both districts have to actually reach this point — two centres
         can be equidistant from open country a long way from either */
      if (n.b0 > Math.max(ZONES[n.z0].world.radius, 96)) continue;
      let near = false;
      for (const s of out) if (Math.hypot(s.x - p.x, s.z - p.z) < gap) { near = true; break; }
      if (near) continue;
      const seg = Math.hypot(p.x - q.x, p.z - q.z) || 1;
      out.push({
        x: p.x, z: p.z,
        tx: (p.x - q.x) / seg, tz: (p.z - q.z) / seg,
        a: n.z0, b: n.z1, width: e.width || 5,
      });
    }
  }
  return out;
}

/* ==================================================================
   THE BUILDER
   ================================================================== */
/**
 * @param {object} ctx
 * @param {object} world      ctx.world
 * @param {object} opts
 *   opts.sites   [{x, z, r}]  every building on the island, named and
 *                unnamed. Paving is keyed on distance to the nearest
 *                one of these — see the header.
 *   opts.seams   findSeams() output, so the sill lands under the post
 *   opts.zoneKit (x, z) -> the ZONE_KIT name for that ground
 *   opts.rng     ctx.makeRng(...)
 */
export function createGround(ctx, world, opts = {}) {
  const t0 = performance.now();
  const sites = opts.sites || [];
  const seams = opts.seams || [];
  const zoneKit = opts.zoneKit || (() => 'city');
  const rng = opts.rng || ctx.makeRng('wally.ground');
  const edges = world.paths?.edges || [];

  const group = new THREE.Group();
  group.name = 'city.ground';

  /* ----------------------------------------------------------------
     The material. One for the whole floor: colour rides in the vertex
     attribute, so ten districts of paving, a gutter, cast iron, a
     boundary sill and a worn earth path are ONE draw call per merged
     chunk. Same trick city/kits.js uses for the walls.

     Grain is deliberately finer and flatter than the road's: this is
     dressed stone, and ART §1.2's rule ("if a frame reads fuzzy the
     grain is too coarse") bites hardest on a surface that fills the
     bottom third of every gameplay frame.
     ---------------------------------------------------------------- */
  const material = ctx.mat.plaster({
    name: 'city.ground',
    color: 0xffffff,
    vertexColors: true,
    variation: 0.0,
    edgeWear: 0.0,
    varScale: 0.26,
    relief: 0.30,
    grain: 0.010,
    grainScale: 4.6,
    grainAlbedo: 0.085,
    grainFade: [14, 84],
    macro: 0.40,
    macroScale: 0.36,
    term: 0.34,
    bandSoft: 0.020,
    band2: 0.16,
    core: 0.64,
    coreSoft: 0.028,
    rim: 0.0,
    skyBounce: 0.055,
    spec: 0.04,
    outline: false,
    noOutline: true,
  });
  /* Deeper than the road ribbon's -2/-4: the gutter deliberately laps
     two centimetres over the tarmac so there is no seam of terrain
     showing between them, and the loser of that fight must always be
     the road. */
  material.polygonOffset = true;
  material.polygonOffsetFactor = -4;
  material.polygonOffsetUnits = -8;

  /* ----------------------------------------------------------------
     Buffers. Drawn geometry is bucketed by district so the frustum can
     throw most of the island away; collision is one flat list.
     ---------------------------------------------------------------- */
  const buckets = new Map();
  const bucket = (k) => {
    let b = buckets.get(k);
    if (!b) buckets.set(k, b = { pos: [], nrm: [], col: [], idx: [], n: 0 });
    return b;
  };
  const colPos = [], colIdx = [];
  let colN = 0;

  const _c0 = new THREE.Color(), _c1 = new THREE.Color();
  const _c2 = new THREE.Color(), _c3 = new THREE.Color();
  const lin = (hex) => linear(hex);
  const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

  /* ----------------------------------------------------------------
     THE SECTION IS THREE VALUES, AND THE CODE ENFORCES IT.

     The first cut let each district name a flag stone and a kerb stone
     by hand, and Main Street's landed on 182 and 183: the kerbstone
     and the flags were the same value, so the pavement photographed at
     three metres was one flat grey band with a dark line at the road
     side and no kerb in it anywhere. Choosing ten pairs of colours by
     eye and getting all ten right is not a thing anyone does.

     So the district still chooses its STONE — its hue, which is what
     tells Rusty Row from Golden Heights — and this normalises the
     VALUE. The kerbstone is always 0.82 of the flags and the channel
     always 0.56 of the kerbstone, which is three legible steps in
     every district whatever colour they are made of. The chamfer
     between them faces up and out and the toon ramp lights it a band
     brighter, which is the arris.
     ---------------------------------------------------------------- */
  const palCache = new Map();
  function paletteFor(kit) {
    let p = palCache.get(kit);
    if (p) return p;
    const src = PAVING[kit] || PAVING_FALLBACK;
    const flag = lin(src.flag).clone();
    const kerb = lin(src.kerb).clone();
    const lf = lum(flag), lk = lum(kerb);
    if (lk > 1e-4) kerb.multiplyScalar((lf * 0.82) / lk);
    const gut = kerb.clone().multiplyScalar(0.56).lerp(lin(WET), 0.20);
    p = { flag, kerb, gut, joint: src.joint };
    palCache.set(kit, p);
    return p;
  }

  /** push one vertex, return its index within the bucket */
  function vert(b, x, y, z, c, k = 1) {
    b.pos.push(x, y, z);
    b.nrm.push(0, 1, 0);
    b.col.push(c.r * k, c.g * k, c.b * k);
    return b.n++;
  }
  function quad(b, a, bb, c, d) { b.idx.push(a, bb, c, a, c, d); }

  /** the same triangle, in the collision list */
  const colVert = (x, y, z) => { colPos.push(x, y, z); return colN++; };
  function colQuad(a, bb, c, d) { colIdx.push(a, bb, c, a, c, d); }

  /* ----------------------------------------------------------------
     WHERE THE TOWN IS.

     Distance to the nearest building, bucketed into a 64 m hash so
     this is a handful of compares per sample rather than a scan of a
     hundred and eleven buildings — it is called about twelve thousand
     times during the walk.
     ---------------------------------------------------------------- */
  const HCELL = 64, HPAD = 70;
  const hash = new Map();
  const hkey = (i, j) => i * 4096 + j;
  sites.forEach((s, k) => {
    const r = (s.r || 8) + HPAD;
    for (let i = Math.floor((s.x - r) / HCELL); i <= Math.floor((s.x + r) / HCELL); i++) {
      for (let j = Math.floor((s.z - r) / HCELL); j <= Math.floor((s.z + r) / HCELL); j++) {
        const key = hkey(i, j);
        let a = hash.get(key);
        if (!a) hash.set(key, a = []);
        a.push(k);
      }
    }
  });
  function builtDist(x, z) {
    const a = hash.get(hkey(Math.floor(x / HCELL), Math.floor(z / HCELL)));
    if (!a) return HPAD;
    let best = HPAD;
    for (let i = 0; i < a.length; i++) {
      const s = sites[a[i]];
      const dx = x - s.x, dz = z - s.z;
      const d = Math.sqrt(dx * dx + dz * dz) - (s.r || 8);
      if (d < best) best = d;
    }
    return best;
  }
  /* 1 hard against a frontage, 0 out in the fields.

     14 -> 34 m, measured from the balloon rather than argued: at
     18 -> 46 the paving reached 4.1 km of centreline out of a 4.2 km
     network and the island had no country road left on it at all,
     which threw away half the point of keying on buildings. At this
     band the streets are paved and the long hauls between districts
     are a verge — and the boundary sill stands in the gap, which is
     where a parish stone stands in a real one. */
  const builtUp = (x, z) => 1 - smoothstep(14, 34, builtDist(x, z));

  /* ----------------------------------------------------------------
     WHAT WE PAVED, AND HOW HIGH IT IS. Two questions, one sparse map.

     (a) foliage.js needs to know where NOT to grow grass. The verge
         grew blades because nothing ever told it not to, and after
         this pass a good deal of that verge is under stone. Read by
         turf(), so a blade inside a footway is never built rather than
         built and hidden — which is where the triangles this file
         spends come back from.

     (b) city.js needs to know how high the floor is before it puts a
         lamp post on it. Every prop in this city is placed at
         world.heightAt(), and a raised pavement means a lamp post
         standing at heightAt is a lamp post sunk to its ankles in the
         flags — the exact bug tools/surfacetest.mjs exists for, applied
         to street furniture instead of to Wally.

     Sparse, because the paved area is about five thousand square
     metres out of a 970 m island: a full raster at this pitch would be
     five million cells to hold twenty thousand answers.
     ---------------------------------------------------------------- */
  /* 0.25 m, and the cell size is the whole argument.

     At 0.5 m the cells a 1.5 m footway touches reach up to half a
     metre outside it, and topAt() then answers "the floor here is
     0.11 m up" for ground that is bare terrain. Two things went wrong
     on that: tools/cliptest.mjs's kerb probe found the kerb line a
     quarter of a metre out and read his feet as 0.165 m below a
     pavement he was standing beside, and — the one that matters —
     city.js places street furniture at floorY(), so a bench in that
     band would have been stood on a pavement that is not there.

     A quarter of a metre is inside the flags either way, and the map
     is sparse: about ninety thousand cells for five thousand square
     metres of paving, on a 970 m island where a full raster at this
     pitch would be fifteen million. */
  const MCELL = 0.25;
  const mkey = (x, z) => (Math.floor(x / MCELL) + 8192) * 20000 + (Math.floor(z / MCELL) + 8192);
  const paved = new Map();
  /**
   * @param y the floor height here, or null to mark the cell as covered
   *          without claiming a height. Grass is suppressed on a
   *          slightly WIDER footprint than the height is published
   *          for — a blade at the very edge of the flags should not
   *          grow, and a bench there should still stand on the ground.
   */
  function markPaved(x, z, r, y) {
    const i0 = Math.floor((x - r) / MCELL), i1 = Math.floor((x + r) / MCELL);
    const j0 = Math.floor((z - r) / MCELL), j1 = Math.floor((z + r) / MCELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = (i + 8192) * 20000 + (j + 8192);
        const prev = paved.get(k);
        /* the higher surface wins: two kerbs lapping at a junction, or
           a sill crossing a footway, must not hand back the lower one */
        if (prev === undefined || (y != null && (prev == null || y > prev))) paved.set(k, y ?? prev ?? null);
      }
    }
  }
  /** 1 where this file has laid something over the ground. */
  const pavedAt = (x, z) => (paved.has(mkey(x, z)) ? 1 : 0);
  /** the height of the drawn floor here, or null if it is just terrain. */
  const topAt = (x, z) => { const v = paved.get(mkey(x, z)); return v == null ? null : v; };

  /* ----------------------------------------------------------------
     THE WALK.
     ---------------------------------------------------------------- */
  const H = world.heightAt, SLOPE = world.slopeAt, SHORE = world.shoreDistAt;
  let kerbMetres = 0, gullies = 0, manholes = 0, sills = 0, paths = 0;
  const gullyList = [];

  /* a seam is laid once, on whichever edge passes closest to it */
  const laidSeams = new Set();

  for (const e of edges) {
    const pts = densify(e.points, SAMPLE);
    if (pts.length < 4) continue;
    const half = (e.width || 5) * 0.38;      // the ribbon's own half-width
    const bkey = e.a?.kind === 'zone' ? e.a.key : (e.b?.key || 'road');

    /* --- per-sample state, resolved once and reused by both sides --- */
    const S = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(pts.length - 1, i + 1)];
      let tx = p1.x - p0.x, tz = p1.z - p0.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      /* taper to nothing at both ends of the polyline. Junctions are
         where two kerbs would cross each other and the carriageway,
         and an open mouth at a corner is what a real junction has
         anyway — a dropped kerb. It is also where the desire path
         below picks the pavement back up. */
      const dEnd = Math.min(i, pts.length - 1 - i) * SAMPLE;
      let k = smoothstep(0, NODE_FADE, dEnd) * builtUp(p.x, p.z);
      /* nothing kerbed on a bank, on sand, or in the sea */
      if (SHORE(p.x, p.z) < 12) k = 0;
      k *= 1 - smoothstep(0.16, 0.30, SLOPE(p.x, p.z));
      S.push({ x: p.x, z: p.z, px: -tz, pz: tx, tx, tz, k, g: H(p.x, p.z), seam: null, patch: 1 });
    }
    /* THE PATCH WALK. Per-sample white noise is speckle; what a real
       pavement has is stretches — a section relaid five years after the
       one next to it. A damped random walk over the samples gives runs
       eight to fifteen metres long, for one multiply. */
    {
      let pv = 1;
      for (const s of S) {
        pv += (rng() - 0.5) * 0.085;
        pv = clamp(pv, 0.87, 1.10);
        s.patch = pv;
      }
    }
    /* ONE SILL PER SEAM, NOT ONE PER SAMPLE THAT MATCHES.

       The first cut asked "is there a seam within 2.2 m of this
       sample?" at every one of them — and the samples are 0.75 m
       apart, so eleven boundaries came out as seventy-seven overlapping
       stone bands stacked down the middle of the road. Ask the other
       way round: each seam claims the single nearest sample on this
       edge, and a seam already claimed elsewhere claims nothing. */
    for (const sm of seams) {
      if (laidSeams.has(sm)) continue;
      let bi = -1, bd = 3.0;
      for (let i = 2; i < S.length - 2; i++) {
        const d = Math.hypot(S[i].x - sm.x, S[i].z - sm.z);
        if (d < bd) { bd = d; bi = i; }
      }
      if (bi >= 0) { S[bi].seam = sm; laidSeams.add(sm); }
    }

    /* --- which district's floor is this? resolved per sample, so the
           paving genuinely changes at the bisector --- */
    for (const s of S) {
      const pal = paletteFor(zoneKit(s.x, s.z));
      s.flag = pal.flag;
      s.kerb = pal.kerb;
      s.gut = pal.gut;
      s.joint = pal.joint;
    }

    /* --- gullies: one every ~38 m of paved kerb, sides alternating.
           A drain is a thing you notice once; six in a row is wallpaper. */
    let acc = 0, side = rng() < 0.5 ? 1 : -1;
    for (let i = 2; i < S.length - 2; i++) {
      if (S[i].k < 0.55) { acc = 0; continue; }
      acc += SAMPLE;
      if (acc < 34 + rng() * 10) continue;
      acc = 0;
      S[i].gully = side;
      side = -side;
      gullies++;
    }

    /* ============================================================
       1. THE SECTION, both sides.
       ============================================================ */
    for (const sgn of [1, -1]) {
      const b = bucket(bkey);
      let prev = null, prevCol = null;
      for (let i = 0; i < S.length; i++) {
        const s = S[i];
        const k = s.k;
        if (k < 0.02) { prev = null; prevCol = null; continue; }

        const px = s.px * sgn, pz = s.pz * sgn;
        const at = (u) => [s.x + px * u, s.z + pz * u];

        /* SIX COLUMNS, AND THE FIFTH IS THE WHOLE POINT.

           The first cut of this file ran gutter / kerb-top / flags /
           fall, and photographed from three metres it was a white
           paper ribbon: the kerb and the pavement were the same stone
           at the same value, so there was no EDGE in it, only a change
           of ground colour. A kerbstone is its own course, 0.20 m of
           different stone laid between the channel and the flags, and
           putting one in is the difference between a street and a
           painted stripe. */
        const c0 = half - 0.02;         // laps the tarmac by 2 cm
        const c1 = half + GUT;          // channel, at carriageway level
        let c2 = c1 + CHAM;             // top of the kerb face
        let c2b = c2 + KERB;            // back of the kerbstone
        let c3 = c2b + FOOT * k;        // back of the flags

        const road = s.g + LIFT;
        /* the walkable top: level across, and never buried by ground
           that rises away from the carriageway */
        let top = Math.max(road + RISE * k, Math.max(H(...at(c2)), H(...at(c2 + KERB + FOOT * k))) + 0.045);
        /* past a certain upstand the bank has won and this is a
           retaining wall, not a kerb. Give up rather than draw one. */
        if (top - road > MAX_UPSTAND) { prev = null; prevCol = null; continue; }

        /* A FACE NO STEEPER THAN THE KERB IS SUPPOSED TO BE.

           The upstand is not always RISE: where the ground climbs away
           from the carriageway the top follows it, up to MAX_UPSTAND.
           With a fixed 0.12 m run that turns the kerb face into a
           0.30/0.12 wall — 68 degrees — and since the face is in the
           collision world, the capsule then rests on a 68 degree normal
           and surfacetest's capsule-lift identity (radius * (1/n.y - 1),
           0.29 m at that angle) reads the whole lift as a SINK. The
           face and the fall are therefore WIDENED to hold their angle,
           not steepened to hold their width. */
        /* 1.15 WAS NOT ENOUGH, FOR TWO REASONS, BOTH MEASURED.

           A run of 1.15 x the rise is a 41 degree face ACROSS the road.
           The face also falls ALONG it, and a triangle that is 41
           degrees one way and ten the other is 42 degrees to the sky:
           surfacetest walked onto one at (-32.45, -209.06) on Iron
           Hills and read n.y 0.671 — 48 degrees, the slope limit — for
           a capsule-lift of 0.156 m and the only sample left past
           tolerance in the whole suite. And ONE PASS was not plenty:
           widening the face moves c2 and c3 outward, `top` is then
           recomputed off the ground under the NEW columns, and where
           the bank is climbing the new top is higher than the one the
           run was sized for, so the face ends up steeper than the
           number above says. Two passes converge; the second moves it
           by millimetres.

           1.55 is 33 degrees across, which leaves room for the fall
           along the road and still lands inside 40. It costs width, not
           height: the footway is pushed away from the channel where the
           upstand is large, which is what a real kerb does on a bank. */
        let cham = Math.max(CHAM, (top - road) * 1.55);
        c2 = c1 + cham; c2b = c2 + KERB; c3 = c2b + FOOT * k;
        for (let pass = 0; pass < 2; pass++) {
          top = Math.max(road + RISE * k, Math.max(H(...at(c2)), H(...at(c3))) + 0.045);
          cham = Math.max(CHAM, (top - road) * 1.55);
          c2 = c1 + cham; c2b = c2 + KERB; c3 = c2b + FOOT * k;
        }
        const [x2, z2] = at(c2), [x2b, z2b] = at(c2b), [x3, z3] = at(c3);
        top = Math.max(road + RISE * k, Math.max(H(x2, z2), H(x3, z3)) + 0.045);

        /* --- the paint ---
           Every value below is set against the grass it lies next to.
           LAND.grassLit has a luminance of 171 and the first cut's
           flags came out at 208: the pavement was the brightest thing
           in the lower half of every frame and it pulled the eye off
           the buildings. The flags now sit at or just under the turf,
           and the only thing in the section allowed to be brighter
           than its surroundings is the 0.20 m top of the kerb. */

        /* A GUTTER IS WHERE A TOWN KEEPS ITS DIRT — the darkest line in
           the section, and what makes the kerb read as an edge rather
           than as a change of paint. Always faintly damp. */
        _c0.copy(s.gut);
        /* the stain: standing water under a gully, fanning along the
           channel. Nothing is drawn for this — it is the gutter's own
           vertices, wet. */
        let wet = 0;
        for (let j = Math.max(0, i - 6); j < Math.min(S.length, i + 7); j++) {
          if (S[j].gully !== sgn) continue;
          wet = Math.max(wet, 1 - Math.abs(j - i) / 7);
        }
        if (wet > 0) _c0.lerp(lin(WET), wet * 0.66);

        /* the kerbstone: its own course, at 0.82 of the flags */
        _c1.copy(s.kerb);

        /* THE FLAGS: a course joint every third sample — 2.25 m, a
           course of big civic slabs — and s.patch, a damped random walk
           so a stretch of pavement is a slightly different age from the
           stretch before it rather than one colour for two hundred
           metres. A slab pattern is not worth thirty thousand instanced
           setts to be looked at from three metres; it is worth a
           modulation on vertices that already exist.

           A JOINT IS A DARK LINE, NOT A DIM SLAB. Modulating the flag
           colour's BRIGHTNESS by a fifth every third sample was
           invisible in every frame it was photographed in: the toon
           ramp's lit band and the material's own macro noise between
           them swallow a value change of that size on a surface this
           flat. Shifting the colour toward the CHANNEL instead puts a
           cool dark line across the flags, which is what a joint
           actually is and what the eye is looking for. */
        const joint = (i % 3 === 0);
        if (joint) _c2.copy(s.flag).lerp(s.gut, 0.20 + s.joint * 0.30);
        else _c2.copy(s.flag);
        const speck = 0.95 + rng() * 0.10;
        const flagK = speck * s.patch;

        /* THE FALL. Flags do not stop at a line: the back edge is dirt
           where the turf has crept over it for years. Taken most of the
           way to worn earth and a little toward the grass shade, so
           from the balloon the paving has a soft outer edge and a hard
           inner one — which is exactly the right way round. */
        _c3.copy(s.flag).lerp(lin(WORN_EARTH), 0.74).lerp(lin(LAND.grassShade), 0.16);
        /* the fall widens for the same reason the face does */
        const drop = clamp(top - (H(...at(c3 + SKIRT)) + 0.008), -0.10, 0.26);
        const c4 = c3 + Math.max(SKIRT, drop * 1.4);
        const [x4, z4] = at(c4);
        const yb = clamp(H(x4, z4) + 0.008, top - 0.28, top + 0.10);

        /* TWO VERTICES AT c2b, AND THAT IS THE WHOLE FIX.

           A shared vertex means a shared colour, so a strip that ran
           gutter / kerb-top / flags interpolated the kerbstone's value
           across the entire 1.30 m of footway behind it: the pavement
           came out as a gradient from kerb colour to flag colour and
           the kerbstone was not a course, it was the light end of a
           ramp. Photographed at three metres there was no line in it at
           all. Doubling the column at the back of the kerbstone — same
           position, two colours — makes it a hard edge, and the pair
           costs no triangles because the zero-width quad between them
           is skipped below. */
        const cols = [
          [at(c0), road, _c0, 1.00],
          [at(c1), road, _c0, 0.94],
          [[x2, z2], top, _c1, speck],
          [[x2b, z2b], top, _c1, speck * 0.97],
          [[x2b, z2b], top, _c2, flagK],
          [[x3, z3], top, _c2, flagK * 0.985],
          [[x4, z4], yb, _c3, speck * 0.92],
        ];
        const cur = cols.map((c) => vert(b, c[0][0], c[1], c[0][1], c[2], c[3]));
        if (prev) {
          /* WINDING. +1 side and -1 side mirror each other, so one of
             them must wind the other way or half the floor is
             backfacing and vanishes. */
          for (let m = 0; m < cur.length - 1; m++) {
            /* the doubled column is a colour break, not a surface */
            if (cols[m][0][0] === cols[m + 1][0][0] && cols[m][0][1] === cols[m + 1][0][1]) continue;
            if (sgn > 0) quad(b, prev[m], prev[m + 1], cur[m + 1], cur[m]);
            else quad(b, prev[m], cur[m], cur[m + 1], prev[m + 1]);
          }
        }
        prev = cur;

        /* --- the same ledge, in the collision world ---

           EVERYTHING DRAWN ABOVE THE TERRAIN IS IN HERE, and the first
           cut of this file got that wrong in a way tools/surfacetest.mjs
           caught within one run. It registered the FLAGS only (c2..c3),
           on the reasoning that the chamfer and the outer fall are
           surfaces you pass over rather than stand on — but surfacetest
           does not ask what you stand on, it asks whether the drawn
           ground and the collision ground AGREE, over a half-metre
           raster. They did not: probed at the Rusty Row thresholds the
           drawn skirt stood 0.121 m over the terrain phys was answering
           with, which is the same defect as a floating road, and both
           threshold rows went red.

           So the strip runs c1 (the channel, at carriageway level) to
           c4 (back at grade): every vertex of the ledge, at the same
           0.75 m pitch it is drawn at, so the two surfaces are the same
           surface. It costs three quads a sample a side instead of one
           — 60k triangles island-wide against the berms' 23k — and it
           is the difference between a pavement and a picture of one. */
        const ac = [
          colVert(...xy(at(c1), road)),
          colVert(x2, top, z2),
          colVert(x3, top, z3),
          colVert(x4, yb, z4),
        ];
        if (prevCol) {
          for (let m = 0; m < ac.length - 1; m++) {
            if (sgn > 0) colQuad(prevCol[m], prevCol[m + 1], ac[m + 1], ac[m]);
            else colQuad(prevCol[m], ac[m], ac[m + 1], prevCol[m + 1]);
          }
        }
        prevCol = ac;

        /* the walkable band only — the gutter is at road level and the
           skirt is a fall, and neither is somewhere to stand a bench.
           Height on the flags exactly; grass suppressed a little wider,
           out over the kerb face and the top of the fall. */
        const mx = s.x + px * ((c2 + c3) * 0.5), mz = s.z + pz * ((c2 + c3) * 0.5);
        markPaved(mx, mz, (c3 - c2) * 0.5, top);
        markPaved(mx, mz, (c3 - c2) * 0.5 + 0.34, null);
        kerbMetres += SAMPLE;

        if (s.gully === sgn) gullyList.push({ x: s.x, z: s.z, px, pz, half, y: road, bkey });
      }
    }

    /* ============================================================
       2. THE SILL — a band of boundary setts laid across the road.
       ============================================================ */
    for (let i = 0; i < S.length; i++) {
      if (!S[i].seam) continue;
      const s = S[i];
      const b = bucket(bkey);
      const w = half + GUT + CHAM;
      const y = s.g + LIFT + 0.012;
      /* three courses along the road: a dark joint, the sill proper,
         a dark joint. 1.5 m deep — a stride and a half, so you cross
         it deliberately rather than clip a corner of it. */
      const along = [-0.75, -0.52, 0.52, 0.75];
      const cols = [-w, -w * 0.5, 0, w * 0.5, w];
      const grid = [];
      for (let a = 0; a < along.length; a++) {
        const row = [];
        const cx = s.x + s.tx * along[a], cz = s.z + s.tz * along[a];
        for (const u of cols) {
          const x = cx + s.px * u, z = cz + s.pz * u;
          const c = (a === 0 || a === along.length - 1) ? lin(SILL_JOINT) : lin(SILL_STONE);
          row.push(vert(b, x, Math.max(y, H(x, z) + LIFT), z, c, 0.94 + rng() * 0.12));
        }
        grid.push(row);
      }
      for (let a = 0; a < grid.length - 1; a++) {
        for (let u = 0; u < cols.length - 1; u++) {
          quad(b, grid[a][u], grid[a][u + 1], grid[a + 1][u + 1], grid[a + 1][u]);
        }
      }
      markPaved(s.x, s.z, w, null);
      sills++;
    }

    /* ============================================================
       3. ONE MANHOLE PER STREET, in the carriageway.
       ============================================================ */
    {
      let bestI = -1, bestK = 0.6;
      for (let i = 6; i < S.length - 6; i++) {
        if (S[i].seam) continue;
        const kk = S[i].k * (0.6 + 0.4 * rng());
        if (kk > bestK) { bestK = kk; bestI = i; }
      }
      if (bestI > 0) {
        const s = S[bestI];
        const b = bucket(bkey);
        const off = (rng() < 0.5 ? 1 : -1) * half * 0.42;
        const cx = s.x + s.px * off, cz = s.z + s.pz * off;
        const y = s.g + LIFT + 0.014;
        const R = 0.34, N = 14;
        const mid = vert(b, cx, y, cz, lin(IRON), 1.04);
        const ring = [];
        for (let a = 0; a < N; a++) {
          const th = (a / N) * PI * 2;
          ring.push(vert(b, cx + Math.cos(th) * R, y, cz + Math.sin(th) * R, lin(IRON_DARK), 0.94));
        }
        /* WOUND FOR +Y. A fan built counter-clockwise in (x, z) is
           clockwise seen from above, and a manhole with its normal in
           the ground is a manhole you cannot see. */
        for (let a = 0; a < N; a++) b.idx.push(mid, ring[(a + 1) % N], ring[a]);
        manholes++;
      }
    }
  }

  /* ================================================================
     4. THE GULLIES themselves — a cast grating at the kerb foot.
     Four slots, which is what makes it read as iron rather than as a
     dark rectangle. Twelve triangles each.
     ================================================================ */
  for (const g of gullyList) {
    /* into the SAME merged mesh as the kerb it sits in. An island-wide
       "all the gullies" bucket is one draw call with a 900 m bounding
       sphere, submitted to the main pass and all four shadow cascades
       every frame, carrying fifty gratings. */
    const b = bucket(g.bkey);
    const y = g.y + 0.008;
    const u0 = g.half + 0.005, u1 = g.half + GUT + CHAM * 0.4;
    const NS = 7;
    const rowA = [], rowB = [];
    /* along the kerb */
    const ax = -g.pz, az = g.px;          // tangent = perpendicular of the normal
    for (let s = 0; s <= NS; s++) {
      const t = s / NS;
      const u = u0 + (u1 - u0) * t;
      const dark = (s % 2) ? 0.55 : 1.0;   // the slots
      for (const [row, along] of [[rowA, -0.21], [rowB, 0.21]]) {
        const x = g.x + ax * along + g.px * u;
        const z = g.z + az * along + g.pz * u;
        row.push(vert(b, x, y, z, lin(dark > 0.9 ? IRON : IRON_DARK), dark));
      }
    }
    /* same reason as the manhole: rowA -> rowB is the road tangent and
       s is the outward normal, and that pair winds face-down. */
    for (let s = 0; s < NS; s++) quad(b, rowA[s], rowB[s], rowB[s + 1], rowA[s + 1]);
  }

  /* ================================================================
     5. DESIRE PATHS.

     Nobody walks a right angle. Where two lanes leave a junction at
     less than a hundred and fifty degrees, the corner between them is
     cut — and because the kerb tapers away over the last eight metres
     of every polyline (see NODE_FADE), the chord lands exactly on the
     two pavement ends and joins them up.

     This is the cheapest thing in the file and the most human: eight
     triangles of bare earth, and the reason it works is that it is
     evidence of a decision somebody else made before you got here.
     ================================================================ */
  {
    const byNode = new Map();
    for (const e of edges) {
      const pts = e.points;
      if (!pts || pts.length < 4) continue;
      for (const [node, from, to] of [[e.a, pts[0], pts[3]], [e.b, pts[pts.length - 1], pts[pts.length - 4]]]) {
        if (!node) continue;
        const dx = to.x - from.x, dz = to.z - from.z;
        const l = Math.hypot(dx, dz) || 1;
        const bk = e.a?.kind === 'zone' ? e.a.key : (e.b?.key || 'road');
        let a = byNode.get(node.key);
        if (!a) byNode.set(node.key, a = { x: from.x, z: from.z, key: bk, arms: [] });
        a.arms.push({ dx: dx / l, dz: dz / l });
      }
    }
    for (const n of byNode.values()) {
      if (builtUp(n.x, n.z) < 0.35) continue;
      /* TWO PER JUNCTION, TIGHTEST FIRST.

         Main Street's anchor has eight arms, which is twenty-eight
         corners, and cutting all of them turns a crossroads into a
         cobweb — eighty-three chords over the island, and from the
         balloon they read as damage rather than as use. The two
         sharpest corners are the two people would actually cut. */
      /* A CORNER WORTH CUTTING IS 35 to 150 DEGREES. Wider than that
         and the road is straight and there is nothing to cut; tighter
         and the chord is shorter than a stride and reads as a scuff.
         Sorted tightest-usable first, because that is the one somebody
         actually cuts. */
      const pairs = [];
      for (let i = 0; i < n.arms.length; i++) {
        for (let j = i + 1; j < n.arms.length; j++) {
          const cs = n.arms[i].dx * n.arms[j].dx + n.arms[i].dz * n.arms[j].dz;
          const ang = Math.acos(clamp(cs, -1, 1)) * 180 / PI;
          if (ang < 35 || ang > 150) continue;
          pairs.push([i, j, ang]);
        }
      }
      pairs.sort((a, b) => a[2] - b[2]);
      for (const [i, j] of pairs.slice(0, 2)) {
        {
          const A = n.arms[i], B = n.arms[j];
          const D = 7.5 + rng() * 2.5;
          const ax = n.x + A.dx * D, az = n.z + A.dz * D;
          const bx = n.x + B.dx * D, bz = n.z + B.dz * D;
          if (Math.hypot(bx - ax, bz - az) < 5) continue;
          if (SLOPE((ax + bx) / 2, (az + bz) / 2) > 0.26) continue;
          if (SHORE((ax + bx) / 2, (az + bz) / 2) < 12) continue;
          const b = bucket(n.key);
          const steps = Math.max(3, Math.ceil(Math.hypot(bx - ax, bz - az) / SAMPLE));
          let prev = null;
          for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            /* bowed toward the corner: people cut it, they do not
               chord it exactly */
            const bow = Math.sin(t * PI) * 0.22;
            const x = ax + (bx - ax) * t + (n.x - (ax + bx) / 2) * bow;
            const z = az + (bz - az) * t + (n.z - (az + bz) / 2) * bow;
            let nx = -(bz - az), nz = (bx - ax);
            const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
            /* worn narrow at the ends, wide in the middle, exactly the
               way a real one is */
            const w = (0.42 + 0.34 * Math.sin(t * PI));
            const y = H(x, z) + 0.028;
            const edge = lin(WORN_EARTH), mid = lin(mixHex(LAND.dirt, BUILD.stone, 0.12));
            const va = vert(b, x - nx * w, H(x - nx * w, z - nz * w) + 0.024, z - nz * w, edge, 0.92);
            const vm = vert(b, x, y, z, mid, 1.0);
            const vb = vert(b, x + nx * w, H(x + nx * w, z + nz * w) + 0.024, z + nz * w, edge, 0.92);
            const cur = [va, vm, vb];
            if (prev) { quad(b, prev[0], prev[1], cur[1], cur[0]); quad(b, prev[1], prev[2], cur[2], cur[1]); }
            prev = cur;
            markPaved(x, z, w, null);
          }
          paths++;
        }
      }
    }
  }

  /* ================================================================
     5b. DESIRE PATHS TO DESTINATIONS.

     THE ARGUMENT THIS ANSWERS. The off-road ground was asked for kerbs
     and it was the wrong request: the island has ten districts because
     the country between them is country, and kerbing it makes one
     suburb. What the open ground lacks is not street furniture, it is
     EVIDENCE THAT ANYBODY GOES THERE. A meadow with a worn line across
     it toward the mine head has a person in it. A meadow with a kerb
     round it has a council in it.

     Section 5 already owns the mechanism and it spends all eleven of
     its tracks on junction corners — inside the built-up band, where
     there is a pavement to cut across. Nothing points it at the places
     people actually walk to, which are the ones with no road: the
     mine head up in the Iron Hills, the water, the top of a hill.

     A DESTINATION IS SOMEWHERE WITH NO ROAD TO IT, and all three kinds
     are derived, never listed:

       ADIT    a place of work behind a building: the mine head. Handed
               in by city.js, which needs the same point to break its
               fence on. See THE MINE IS FENCED OFF there.
       SHORE   the waterline, from wherever a road runs close enough to
               the coast that somebody would leave it and walk down.
       SUMMIT  a local high point, far from any road and any building.
               Nobody builds a path up a hill and everybody walks one.

     WHAT IS NOT HERE, AND WHY. The obvious fourth kind is "a named
     building the lane network leaves short", and it was written, run,
     and deleted: MEASURED, ALL TWENTY-EIGHT NAMED DOORS ARE WITHIN
     11.3 m OF A CARRIAGEWAY (the mine's own door is the furthest).
     paths.js wires every location to its district anchor by a lane and
     the lane ends at the building, so that branch could never fire on
     any world this game generates. It is recorded here rather than left
     in as an empty loop, because a rule that cannot fire is worse than
     no rule: it reads like coverage.

     THE ROUTE IS NOT A RULED LINE. A straight chord over a hillside is
     the one thing a real track never is, and drawn across a 30 degree
     slope it also breaks the 0.75 m chord rule this file's header
     opens with. So each one is relaxed the way paths.js relaxes a road
     — smoothed, pushed off the buildings, and with the LATERAL
     component of the terrain gradient subtracted each iteration, so it
     works round a slope rather than straight up it — and then walked
     at the same 0.75 m sample as everything else here.

     Flush with the terrain, like §6's approaches, so nothing has to
     collide with it.
     ================================================================ */
  let destPaths = 0, destTris = 0;
  const destLog = [];
  {
    const MAX_LEN = 150, MIN_LEN = 14;

    /* every road sample, the same list §6 builds its "nearest
       carriageway" from */
    const road = [];
    for (const e of edges) {
      for (const p of densify(e.points, 3.0)) road.push({ x: p.x, z: p.z, w: (e.width || 5) * 0.5 });
    }
    if (road.length) {
      const nearestRoad = (x, z) => {
        let best = null, bd = Infinity;
        for (const r of road) {
          const d = (x - r.x) * (x - r.x) + (z - r.z) * (z - r.z);
          if (d < bd) { bd = d; best = r; }
        }
        return { r: best, d: Math.sqrt(bd) };
      };

      /* ---- the three kinds of destination ---- */
      const dests = [];

      /* ADIT. city.js's point, taken as given: it owns the building
         and the fence that has to break on the same bearing. */
      for (const a of opts.adits || []) {
        dests.push({ kind: 'adit', id: a.id, x: a.x, z: a.z, kit: a.kit, bucket: a.bucket, stop: 0.0 });
      }

      /* SHORE. Walk down the gradient of shoreDistAt from a road
         sample near the coast until the sand is reached. Sampled every
         nth road point and then thinned, so one district does not get
         nine parallel tracks onto the same beach. */
      {
        const cand = [];
        for (let i = 0; i < road.length; i += 3) {
          const r = road[i];
          const s = SHORE(r.x, r.z);
          if (s < 30 || s > 120) continue;      // on the sand already, or a district inland
          /* the way the sea is: minus the gradient of "distance inland" */
          const e2 = 6;
          let gx = (SHORE(r.x + e2, r.z) - SHORE(r.x - e2, r.z)) / (2 * e2);
          let gz = (SHORE(r.x, r.z + e2) - SHORE(r.x, r.z - e2)) / (2 * e2);
          const gl = Math.hypot(gx, gz);
          if (gl < 0.3) continue;               // flat in shore-distance: no clear way down
          gx /= gl; gz /= gl;
          /* march seaward to the top of the sand */
          let tx = r.x, tz = r.z, ok = false;
          for (let k = 0; k < 60; k++) {
            tx -= gx * 4; tz -= gz * 4;
            const sd = SHORE(tx, tz);
            if (sd <= 7) { ok = sd > 1.5; break; }
            if (H(tx, tz) < world.seaLevel + 0.2) break;
          }
          if (!ok) continue;
          if (SLOPE(tx, tz) > 0.5) continue;
          cand.push({ kind: 'shore', id: 'shore', x: tx, z: tz, from: r, d: Math.hypot(tx - r.x, tz - r.z) });
        }
        /* one per stretch of coast: 130 m apart, shortest walk first,
           because that is the one somebody would actually make */
        cand.sort((a, b) => a.d - b.d);
        const taken = [];
        for (const c2 of cand) {
          if (taken.some((t) => Math.hypot(t.x - c2.x, t.z - c2.z) < 130)) continue;
          taken.push(c2);
          if (taken.length >= 5) break;
        }
        for (const t of taken) dests.push({ ...t, kit: opts.zoneKit ? opts.zoneKit(t.x, t.z) : null, stop: 1.0 });
      }

      /* SUMMIT. A coarse grid, keeping cells that beat all eight of
         their neighbours and stand clear of every road and every
         building. `prom` is the crudest possible prominence — how far
         it stands over the mean of its ring — and it is enough to tell
         a hill from a bump on a plain. */
      {
        const G = 34, R2 = 470;
        const peaks = [];
        for (let x = -R2; x <= R2; x += G) {
          for (let z = -R2; z <= R2; z += G) {
            const h = H(x, z);
            if (h < world.seaLevel + 14) continue;
            if (builtDist(x, z) < 40) continue;
            if (SLOPE(x, z) > 0.30) continue;
            let top = true, sum = 0, n2 = 0;
            for (let i = -1; i <= 1 && top; i++) {
              for (let j = -1; j <= 1; j++) {
                if (!i && !j) continue;
                const nh = H(x + i * G, z + j * G);
                sum += nh; n2++;
                if (nh > h) { top = false; break; }
              }
            }
            if (!top) continue;
            const nr = nearestRoad(x, z);
            if (nr.d < 34 || nr.d > MAX_LEN) continue;
            peaks.push({ kind: 'summit', id: 'summit', x, z, prom: h - sum / n2 });
          }
        }
        peaks.sort((a, b) => b.prom - a.prom);
        const taken = [];
        for (const p of peaks) {
          if (taken.some((t) => Math.hypot(t.x - p.x, t.z - p.z) < 200)) continue;
          taken.push(p);
          if (taken.length >= 4) break;
        }
        for (const t of taken) dests.push({ ...t, kit: opts.zoneKit ? opts.zoneKit(t.x, t.z) : null, stop: 1.0 });
      }

      /* ---- route and draw ---- */
      for (const d of dests) {
        const from = d.from || nearestRoad(d.x, d.z).r;
        if (!from) continue;
        /* leave the carriageway at its edge, and stop short of the
           destination so the track does not fight a plinth or a berm */
        const dx0 = d.x - from.x, dz0 = d.z - from.z;
        const L0 = Math.hypot(dx0, dz0);
        if (L0 < MIN_LEN || L0 > MAX_LEN) continue;
        const ux = dx0 / L0, uz = dz0 / L0;
        const ax = from.x + ux * (from.w + 0.6), az = from.z + uz * (from.w + 0.6);
        const bx = d.x - ux * d.stop, bz = d.z - uz * d.stop;
        const poly = crossCountry(ax, az, bx, bz, null);
        if (!poly) continue;
        /* ONE BUCKET FOR ALL TEN, NOT ONE PER DISTRICT.

           §7 draws a mesh per bucket, and these tracks run through the
           country BETWEEN the districts — country that has no paving,
           so bucketing them the way the footway is bucketed added five
           new meshes for 4.3 k triangles: measured, ground went from 10
           meshes to 15. Five draw calls, mostly culled, against one that
           never is. At four thousand triangles in a six-million frame
           the call is what costs and the triangles are noise, so they
           share a bucket and the island-wide bounding sphere is the
           price. The key is only ever the mesh's NAME (see §7), so
           nothing else moves. */
        const bb = bucket('desire');
        const before = bb.idx.length;
        wornTrack(bb, poly, d.kind);
        destTris += (bb.idx.length - before) / 3;
        destPaths++;
        destLog.push(`${d.kind}${d.id && d.id !== d.kind ? ':' + d.id : ''}@${Math.round(d.x)},${Math.round(d.z)} ${Math.round(L0)}m`);
      }
    }
  }

  /** paths.js's relaxation, at a footpath's scale: smooth, subtract the
      lateral slope so the line works round a hillside instead of over
      it, and stay out of the buildings and out of the sea. Returns a
      polyline at SAMPLE spacing, or null if it could not stay dry. */
  function crossCountry(ax, az, bx, bz, exceptId) {
    const L = Math.hypot(bx - ax, bz - az);
    const n = Math.max(4, Math.round(L / 10));
    /* A RULED LINE IS THE ONE THING A DESIRE PATH NEVER IS. Photographed
       from the balloon, the 134 m track up the north headland ran dead
       straight across gentle ground — the contour term has nothing to
       push against on a slope that shallow, so the seed line survived
       untouched and read as a scratch on the map rather than as a path.
       Two seeded harmonics: one long bow, and a second at three times
       the frequency and a fifth the amplitude, which is the difference
       between an arc somebody drew and a line worn by people who each
       walked it slightly differently. Amplitude is a ninth of the
       length and capped at 9 m — a footpath meanders, it does not
       detour. */
    const ux0 = (bx - ax) / (L || 1), uz0 = (bz - az) / (L || 1);
    const px = -uz0, pz = ux0;
    const amp = Math.min(9, L * 0.11) * (rng() - 0.5) * 2;
    const amp2 = amp * 0.2 * (rng() < 0.5 ? -1 : 1);
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const off = Math.sin(t * PI) * amp + Math.sin(t * PI * 3) * amp2;
      pts.push({ x: ax + (bx - ax) * t + px * off, z: az + (bz - az) * t + pz * off });
    }
    const e2 = 2.0;
    for (let it = 0; it < 22; it++) {
      for (let i = 1; i < n; i++) {
        const p = pts[i], pm = pts[i - 1], pp = pts[i + 1];
        let nx = lerp(p.x, (pm.x + pp.x) * 0.5, 0.38);
        let nz = lerp(p.z, (pm.z + pp.z) * 0.5, 0.38);
        /* contour: kill the component of the slope across the line */
        let tx = pp.x - pm.x, tz = pp.z - pm.z;
        const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
        const qx = -tz, qz = tx;
        const gx = (H(nx + e2, nz) - H(nx - e2, nz)) / (2 * e2);
        const gz = (H(nx, nz + e2) - H(nx, nz - e2)) / (2 * e2);
        const lat = gx * qx + gz * qz;
        /* 2.2 not paths.js's 6.5: a person on foot takes a slope a
           cart cannot, so the track leans round a hill without
           wandering half a district sideways to do it */
        const k = clamp(Math.abs(lat) * 2.2, 0, 2.6);
        nx -= qx * Math.sign(lat) * k;
        nz -= qz * Math.sign(lat) * k;
        /* off the buildings — except the one we are walking TO */
        for (const s of sites) {
          if (exceptId && s.id === exceptId) continue;
          const ddx = nx - s.x, ddz = nz - s.z;
          const dd = Math.hypot(ddx, ddz);
          const need = (s.r || 8) + 1.8;
          if (dd > need || dd < 1e-4) continue;
          nx += (ddx / dd) * (need - dd);
          nz += (ddz / dd) * (need - dd);
        }
        p.x = nx; p.z = nz;
      }
    }
    /* A TRACK THAT GOES THROUGH THE SEA IS NOT A TRACK. The relaxation
       can push a coastal line seaward; if it ends up in the water
       anywhere, the whole route is thrown away rather than clipped —
       half a track ending at the tideline is worse than none. */
    for (const p of pts) if (H(p.x, p.z) < world.seaLevel + 0.15) return null;
    const out = densify(pts, SAMPLE);
    return out.length >= 4 ? out : null;
  }

  /** A worn footpath over an arbitrary polyline. §6's approach track
      with three things changed, all of them photographed at eye height
      on the north headland before they were:

        WIDTH. §6 draws 1.0-1.5 m because it is a path to a front door
        that a cart also uses. A cross-country desire path is one person
        wide. At §6's width it read as a mud ROAD — a flat brown ribbon
        painted across a meadow.

        ENDS. `sin(t*PI) * 2.6` reaches full width in the first four per
        cent of the run, so both ends were square: the track stopped
        dead in open grass with a visible straight edge across it. A
        path that starts nowhere has to LOOK like it starts nowhere, so
        the width now ramps over a fixed FADE metres at each end
        regardless of how long the path is, and it never quite closes —
        a hairline of packed earth is what the end of a worn line
        actually is.

        EDGE. The outer column is taken most of the way to the grass
        rather than most of the way to the dirt, and the paving mark is
        narrower than the geometry, so foliage.js grows blades back over
        the fringe. Grass growing INTO the edge is the whole difference
        between a track and a stripe; §6 deliberately marks its full
        width, and that is right for a made approach and wrong here. */
  function wornTrack(b, poly, kind) {
    const N = poly.length - 1;
    const wide = kind === 'adit' ? 0.40 : 0.32;
    const FADE = 7;                       // metres of ramp at each end
    /* run length, so the ramp is in metres and not in fractions */
    let len = 0;
    const at = [0];
    for (let i = 1; i <= N; i++) { len += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].z - poly[i - 1].z); at.push(len); }
    let prev = null;
    for (let i = 0; i <= N; i++) {
      const p = poly[i];
      const q = poly[Math.min(N, i + 1)], o = poly[Math.max(0, i - 1)];
      let nx = -(q.z - o.z), nz = (q.x - o.x);
      const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
      const ramp = Math.min(smoothstep(0, FADE, at[i]), smoothstep(0, FADE, len - at[i]));
      const w = wide * (0.24 + 0.76 * ramp) * (0.84 + rng() * 0.32);
      const jl = (rng() - 0.5) * 0.11, jr = (rng() - 0.5) * 0.11;
      /* "turf gone, soil packed": darker than the grass, never paler */
      const mid = lin(mixHex(LAND.dirt, BRAND.ink, 0.22));
      _c0.copy(mid).lerp(lin(LAND.grassShade), 0.52).lerp(lin(WORN_EARTH), 0.18);
      const speck = 0.92 + rng() * 0.14;
      const xl = p.x - nx * (w + jl), zl = p.z - nz * (w + jl);
      const xr = p.x + nx * (w + jr), zr = p.z + nz * (w + jr);
      const cur = [
        vert(b, xl, H(xl, zl) + 0.022, zl, _c0, speck * 0.93),
        vert(b, p.x, H(p.x, p.z) + 0.026, p.z, mid, speck),
        vert(b, xr, H(xr, zr) + 0.022, zr, _c0, speck * 0.93),
      ];
      if (prev) { quad(b, prev[0], prev[1], cur[1], cur[0]); quad(b, prev[1], prev[2], cur[2], cur[1]); }
      prev = cur;
      markPaved(p.x, p.z, w * 0.66, null);
    }
  }

  /* ================================================================
     6. THE APPROACH.

     A hundred and eleven buildings stand on mown grass with nothing
     leading to them, and that is most of why they read as models
     placed on a lawn rather than as premises on a street.

     WHICH HUNDRED AND ELEVEN, MEASURED. Not the twenty-eight named
     ones: paths.js wires every location to its district anchor by a
     lane and the lane ENDS at the building, so twenty-five of the
     twenty-eight doors are inside three metres of a carriageway and
     the pavement above already reaches them. Only school, docks and
     mine are further out. It is the EIGHTY-THREE UNNAMED NEIGHBOURS —
     the ones that actually fill a gameplay frame — that have no lane,
     no door and nothing worn between them and the road. Forty-nine of
     the hundred and eleven end up wanting a path; the rest are either
     already on the pavement or a field away from any lane.

     WHAT that ground is is the district's, the same way its walls and
     its street furniture are:

       LAID   Main Street, the Learning Quarter, Innovation, Golden
              Heights and the Waterfront get a made path: straight,
              even-edged, in the district's own flags. Somebody paid
              for it.
       WORN   Rusty Row, Green Edge, Iron Hills, Market Square and the
              Stampede approach get a track: bowed, ragged-edged,
              beaten earth with a little stone trodden into it. Nobody
              paid for it; it is simply where people walk.

     Flush with the terrain, so nothing has to collide with it and the
     approach a door needs (see doorBlocked() in city.js) is untouched.
     Marked in the paved map with NO height, so the grass stops but a
     bin standing on it still stands on the ground.
     ================================================================ */
  let approaches = 0;
  {
    /* the districts that had their pavement made for them */
    const LAID = new Set(['city', 'learn', 'tech', 'gold', 'water']);
    /* every road sample, so "nearest carriageway" is a real answer and
       not the nearest node */
    const road = [];
    for (const e of edges) {
      const pts = densify(e.points, 2.0);
      const half = (e.width || 5) * 0.38;
      for (const p of pts) road.push({ x: p.x, z: p.z, half });
    }
    for (const d of opts.doors || []) {
      let best = null, bd = Infinity;
      for (const r of road) {
        const dd = (d.x - r.x) * (d.x - r.x) + (d.z - r.z) * (d.z - r.z);
        if (dd < bd) { bd = dd; best = r; }
      }
      if (!best) continue;
      const dist = Math.sqrt(bd);
      /* nothing to draw if the pavement already reaches the doorstep,
         and nothing worth drawing if the nearest lane is a field away */
      const stop = best.half + GUT + CHAM + KERB + FOOT + SKIRT * 0.5;
      /* THE NAMED TWENTY-EIGHT ALREADY HAVE ONE. Measured: paths.js
         wires every location to its district anchor by a lane and the
         lane ENDS at the building, so twenty-five of the twenty-eight
         doors are inside three metres of a carriageway and want no
         path at all. It is the EIGHTY-THREE UNNAMED NEIGHBOURS that
         stand on mown grass with nothing leading to them, and they are
         what fills a gameplay frame. `d.r` is a building's own radius:
         a named door starts at the door, an unnamed one starts just
         clear of its own footprint. */
      const start = d.r ? d.r + 0.6 : 1.1;
      if (dist < stop + start + 2.5 || dist > (d.r ? 46 : 62)) continue;

      const pal = PAVING[d.kit] || PAVING_FALLBACK;
      const laid = LAID.has(d.kit);
      /* start a little outside the door so the path does not fight the
         building's own plinth and berm */
      const ux = (best.x - d.x) / dist, uz = (best.z - d.z) / dist;
      const ax = d.x + ux * start, az = d.z + uz * start;
      const bx = best.x - ux * stop, bz = best.z - uz * stop;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 3) continue;
      const steps = Math.max(4, Math.ceil(len / SAMPLE));
      const b = bucket(d.bucket || 'approach');
      /* the bow: a made path is a straight line and a worn one is not */
      const bowAmp = laid ? 0 : (rng() - 0.5) * Math.min(3.2, len * 0.18);
      let nx = -(bz - az) / len, nz = (bx - ax) / len;
      let prev = null;
      for (let s2 = 0; s2 <= steps; s2++) {
        const t = s2 / steps;
        const bow = Math.sin(t * PI) * bowAmp;
        const x = ax + (bx - ax) * t + nx * bow;
        const z = az + (bz - az) * t + nz * bow;
        /* a made path keeps its width; a worn one narrows where fewer
           feet have been and frays at the edges */
        const w = laid
          ? 0.80
          : (0.46 + 0.30 * Math.sin(t * PI)) * (0.85 + rng() * 0.30);
        const jl = laid ? 0 : (rng() - 0.5) * 0.14;
        const jr = laid ? 0 : (rng() - 0.5) * 0.14;
        /* BEATEN EARTH, NOT DUSTY STONE. A worn track a shade lighter
           than the dirt under it disappears into a green field —
           photographed at the Rusty Row flat it was a scuff you had to
           look for. What a path people actually use looks like is the
           turf gone and the soil packed: darker than the ground beside
           it, not paler. */
        const mid = laid ? lin(pal.flag) : lin(mixHex(LAND.dirt, BRAND.ink, 0.20));
        _c0.copy(mid).lerp(lin(WORN_EARTH), laid ? 0.30 : 0.46);
        const cv = (s2 % 3 === 0 && laid) ? 1 - pal.joint * 0.8 : 1;
        const speck = 0.93 + rng() * 0.13;
        const xl = x - nx * (w + jl), zl = z - nz * (w + jl);
        const xr = x + nx * (w + jr), zr = z + nz * (w + jr);
        const cur = [
          vert(b, xl, H(xl, zl) + 0.026, zl, _c0, speck * 0.94),
          vert(b, x, H(x, z) + 0.030, z, mid, speck * cv),
          vert(b, xr, H(xr, zr) + 0.026, zr, _c0, speck * 0.94),
        ];
        if (prev) { quad(b, prev[0], prev[1], cur[1], cur[0]); quad(b, prev[1], prev[2], cur[2], cur[1]); }
        prev = cur;
        /* the whole width, not 85 % of it: grass growing back over the
           edge of a track is charming at a kerb, where there is stone
           under it, and is just a thinner track here */
        markPaved(x, z, w, null);
      }
      approaches++;
    }
  }

  /* ================================================================
     7. Merge and hand over.
     ================================================================ */
  let tris = 0;
  for (const [key, b] of buckets) {
    if (!b.idx.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
    geo.setIndex(b.idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = 'ground.' + key;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.renderOrder = 2;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
    tris += b.idx.length / 3;
  }

  const stats = {
    /* where the gullies and the boundary sills actually ended up, so a
       screenshot rig can be aimed at one instead of hunting for it */
    gullyAt: gullyList.map((g) => [+g.x.toFixed(1), +g.z.toFixed(1)]),
    sillAt: [...laidSeams].map((s2) => [+s2.x.toFixed(1), +s2.z.toFixed(1), `${s2.a}|${s2.b}`]),
    kerbMetres: Math.round(kerbMetres),
    gullies, manholes, sills, desirePaths: paths, approaches,
    destPaths, destTris, destAt: destLog,
    meshes: group.children.length,
    tris: Math.round(tris),
    colTris: colIdx.length / 3,
    ms: Math.round(performance.now() - t0),
  };

  return {
    group, material, stats, pavedAt, topAt,
    collision: colIdx.length
      ? { positions: new Float32Array(colPos), indices: colIdx }
      : null,
    dispose() {
      group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
      material.dispose();
    },
  };

  /** [x,z] pair + y -> the three args vert() wants. */
  function xy(p, y) { return [p[0], y, p[1]]; }
}
