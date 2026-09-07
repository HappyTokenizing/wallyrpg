/* ============================================================
   props.js — the clutter that makes a district look lived in.

   Every prop type is built ONCE as a small set of merged, vertex-
   coloured geometries (one per material family) and then stamped
   across the island with InstancedMesh, so four hundred crates,
   barrels, benches, lamps, bins, carts, bicycles, planters, fences
   and bollards cost about thirty draw calls in total.

   Two things every prop gets:
     - a soft CONTACT SHADOW: a multiply-blended decal, one instanced
       draw call for the whole city. ART_DIRECTION forbids hard contact
       darkening, so this is wide and feathered.
     - deterministic variation from ctx.makeRng — three colour variants
       per type, a scale jitter and a yaw, chosen by seed. Nothing
       repeats and nothing changes between builds.

   Lamps read ctx.sky.isNight through the shared lamp material and
   come on at dusk.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { BUILD, LAND, BRAND, SEA, SHADOW } from '../core/palette.js';
import { clamp, lerp } from '../core/contracts.js';
import {
  Kit, makeAO, boxRound as boxRoundFull, corrugated, cyl, post, sphereG, coneG, torusG,
  TRS, mixHex, shadeHex, hexOf, C, plank,
} from './kits.js';

const PI = Math.PI;

/* ------------------------------------------------------------------
   Street furniture is built out of sticks, and a chamfered stick is
   108 triangles: kits.js rounds every one of a box's twelve edges, at
   four vertices per edge per face, whether or not the edge is 2 cm
   long. A crate is seventeen slats and battens and so cost 1836
   triangles — more than the building it leans against.

   The chamfer earns that on a wall. It cannot earn it on a bicycle
   spoke. Below THIN metres the rounding is smaller than the outline
   stroke that already draws the edge (§2.2's ~1.6 px hull), so parts
   that thin drop to a plain twelve-triangle box and the silhouette,
   the vertex AO and the outline are all unchanged. Chunky parts —
   hedges, shipping containers, planters — keep their rounding.
   ------------------------------------------------------------------ */
const THIN = 0.20;
const boxRound = (w, h, d, r = 0.1, arc = 1) =>
  boxRoundFull(w, h, d, r, Math.min(w, h, d) < THIN ? 0 : arc);

/* ------------------------------------------------------------------
   The catalogue. Each factory writes into a Kit in local space with
   its base at y = 0, and reports its footprint radius + height.
   ------------------------------------------------------------------ */
const AO = () => makeAO({ ground: 0.42, groundH: 0.9, under: 0.45 });

/* ==================================================================
   EVIDENCE OF LIFE — the small shapes that say somebody was just here.

   These are not props. They are two-dozen-triangle pieces bolted onto
   props that already exist, in families those props already use, so
   that the furniture the city is full of can be caught MID-USE rather
   than merely present. A bench is a bench; a bench with a jacket over
   the back and a mug on the slats is a bench somebody is coming back
   to. That difference costs about 90 triangles.

   THE ONE RULE. Each of these must add NO material family to its
   host, because a family is a whole extra InstancedMesh per cell. So
   the mug is enamel (metal, which every host already has), the
   newspaper is drawn in the wood builder's vertex colour, and the
   gull is stone-white in the family the bollard is already carved
   from. The jacket is the single exception — cloth in a wood grain
   reads as a plank — and it is used on exactly one host.
   ================================================================== */

/** An enamel mug, handle out. ~34 triangles, in the `metal` family. */
function mug(K, x, y, z, ry, col) {
  K.add('metal', cyl(0.045, 0.038, 0.085, 7, true), TRS(x, y + 0.043, z), col);
  K.add('metal', torusG(0.034, 0.020, 6, 4), TRS(x + Math.cos(ry) * 0.05, y + 0.05, z + Math.sin(ry) * 0.05, 0, 1, 1, 1, 0, ry + PI / 2), shadeHex(col, 0.8));
  K.add('metal', cyl(0.046, 0.046, 0.008, 7, true), TRS(x, y + 0.086, z), shadeHex(col, 0.74));
}

/**
 * A jacket slung over a rail — two folds and a sleeve.
 *
 * THE FAMILY IS THE CALLER'S, and that is the whole design. Cloth
 * wants `hedge` (matte, no grain direction), but a bench's kit has no
 * hedge in it, so asking for one would have cost the bench a whole
 * extra InstancedMesh per cell just to carry three boxes. It goes in
 * `metal` instead — which for this material library is a wood shader
 * with the grain turned down to 0.26 and a banded 0.26 specular, i.e.
 * a waxed jacket — and costs nothing.
 */
function jacket(K, fam, x, y, z, ry, col) {
  K.add(fam, boxRound(0.36, 0.30, 0.13, 0.05, 1), TRS(x, y - 0.10, z, ry, 1, 1, 1, 0, 0.10), col);
  K.add(fam, boxRound(0.32, 0.26, 0.11, 0.05, 1), TRS(x + 0.02, y - 0.30, z + 0.05, ry * 0.8, 1, 1, 1, 0.16, -0.12), shadeHex(col, 0.88));
  K.add(fam, boxRound(0.10, 0.30, 0.10, 0.04, 1), TRS(x - 0.15, y - 0.26, z + 0.02, ry, 1, 1, 1, 0.2, 0.3), shadeHex(col, 0.94));
}

/** A herring gull, standing, head turned. Built in one family. */
function gull(K, fam, x, y, z, ry, body, wing, beak) {
  const c = Math.cos(ry), s = Math.sin(ry);
  const at = (u, h, v) => TRS(x + u * c + v * s, y + h, z - u * s + v * c, ry);
  K.add(fam, sphereG(0.085, 6), at(0, 0.085, 0, 0), body);
  /* the body reads as a bird because it is longer than it is wide and
     the tail lifts — the sphere on its own is a pebble */
  K.add(fam, boxRound(0.09, 0.055, 0.16, 0.026, 1), TRS(x + 0.10 * s, y + 0.10, z + 0.10 * c, ry, 1, 1, 1, -0.34), body);
  K.add(fam, sphereG(0.048, 5), at(0, 0.175, -0.055, 0), body);
  K.add(fam, coneG(0.028, 0.075, 4), TRS(x - 0.09 * s, y + 0.168, z - 0.09 * c, ry, 1, 1, 1, PI / 2 + 0.2), beak);
  for (const sx of [-1, 1]) {
    K.add(fam, boxRound(0.055, 0.065, 0.16, 0.02, 1), TRS(x + sx * 0.055 * c, y + 0.10, z - sx * 0.055 * s, ry, 1, 1, 1, -0.2), wing);
  }
}

/* ------------------------------------------------------------------
   FLAP GEOMETRY — sheets for the wind-driven `flap` family.

   Built growing UP from a rail at local y = 0, because TOON_WIND's
   height term increases with the LOCAL y attribute (roots planted,
   tips whipping — see the note on mats.flap in kits.js). Everything
   made here is therefore hung by rolling the instance pi about X.
   ------------------------------------------------------------------ */
/** A rectangular sheet, top edge on the rail at y=0. 12 triangles. */
function sheet(w, h, cols = 2, rows = 3) {
  const g = new THREE.PlaneGeometry(w, h, cols, rows);
  g.translate(0, h / 2, 0);
  return g;
}
/** A bunting pennant: base on the rail, apex at the tip. 1 triangle. */
function pennantG(w, h) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-w / 2, 0, 0, w / 2, 0, 0, 0, h, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 0.5, 0], 2));
  g.setIndex([0, 1, 2]);
  return g;
}
/**
 * The roll that hangs a flap prop. Compose the placement matrix, then
 * multiply by this: local +y becomes world down, so the rail stays
 * where you put it and the cloth falls from it.
 */
export const FLAP_HANG = new THREE.Matrix4().makeRotationX(PI);

const CATALOGUE = {
  crate(v, rng) {
    const K = new Kit(AO());
    const s = 0.78 + v * 0.1;
    const col = [mixHex(BUILD.wood, LAND.sand, 0.2), BUILD.wood, mixHex(BUILD.wood, BUILD.woodDark, 0.4)][v];
    const dark = shadeHex(col, 0.82);
    for (const [ax, sz] of [[0, 1], [0, -1], [1, 1], [1, -1]]) {
      for (let i = 0; i < 3; i++) {
        const y = s * (0.18 + i * 0.31);
        const g = boxRound(ax ? 0.07 : s * 0.98, s * 0.26, ax ? s * 0.98 : 0.07, 0.022, 1);
        K.add('wood', g, TRS(ax ? sz * s * 0.5 : 0, y, ax ? 0 : sz * s * 0.5), i === 1 ? dark : col);
      }
    }
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      K.add('wood', boxRound(0.1, s, 0.1, 0.03, 1), TRS(sx * s * 0.49, s * 0.5, sz * s * 0.49), dark);
    }
    K.add('wood', boxRound(s * 1.02, 0.09, s * 1.02, 0.03, 1), TRS(0, s * 0.99, 0), col);
    return { K, r: s * 0.78, h: s };
  },

  barrel(v, rng) {
    const K = new Kit(AO());
    const h = 0.92, r = 0.34;
    const col = [BUILD.wood, mixHex(BUILD.wood, BUILD.awning, 0.22), mixHex(BUILD.woodDark, BUILD.wood, 0.5)][v];
    const pts = [];
    pts.push(new THREE.Vector2(0.001, 0));
    pts.push(new THREE.Vector2(r * 0.86, 0));
    for (let i = 1; i <= 5; i++) {
      const t = i / 6;
      pts.push(new THREE.Vector2(r * (0.86 + 0.28 * Math.sin(t * PI)), h * t));
    }
    pts.push(new THREE.Vector2(r * 0.86, h));
    pts.push(new THREE.Vector2(0.001, h));
    K.add('wood', new THREE.LatheGeometry(pts, 13), null, col);
    for (const t of [0.12, 0.5, 0.88]) {
      K.add('metal', torusG(r * (0.9 + 0.24 * Math.sin(t * PI)), 0.035, 14, 6), TRS(0, h * t, 0, 0, 1, 1, 1, PI / 2), C.lead);
    }
    if (v === 2) {
      /* the barrel everybody uses as a table: a mug, a rolled paper
         and a dealt hand of cards, all in families it already has */
      mug(K, 0.09, h, -0.06, 2.3, mixHex(C.paper, BUILD.awningAlt, 0.25));
      K.add('wood', cyl(0.03, 0.03, 0.30, 5, true), TRS(-0.10, h + 0.03, 0.08, 0, 1, 1, 1, 0, PI / 2 + 0.5), C.paper);
      for (let i = 0; i < 3; i++) {
        K.add('wood', boxRound(0.085, 0.018, 0.115, 0, 1), TRS(-0.02 + i * 0.05, h + 0.005, 0.14 - i * 0.03, i * 0.5), C.paper);
      }
    }
    return { K, r: r * 1.2, h };
  },

  bench(v, rng) {
    const K = new Kit(AO());
    const w = 1.85, sh = 0.46;
    const wood = [BUILD.wood, mixHex(BUILD.wood, BUILD.woodDark, 0.35), mixHex(BUILD.wood, BUILD.awning, 0.18)][v];
    for (let i = 0; i < 3; i++) {
      K.add('woodH', plank(w, 0.075, 0.16, rng), TRS(0, sh, -0.18 + i * 0.19), i % 2 ? shadeHex(wood, 0.92) : wood);
    }
    for (let i = 0; i < 3; i++) {
      K.add('woodH', plank(w, 0.16, 0.07, rng), TRS(0, sh + 0.22 + i * 0.19, -0.30, 0, 1, 1, 1, -0.16), i % 2 ? shadeHex(wood, 0.92) : wood);
    }
    for (const sx of [-1, 1]) {
      K.add('metal', boxRound(0.08, sh, 0.09, 0.025, 1), TRS(sx * (w / 2 - 0.16), sh / 2, 0.14), C.lead);
      K.add('metal', boxRound(0.08, sh + 0.62, 0.09, 0.025, 1), TRS(sx * (w / 2 - 0.16), (sh + 0.62) / 2, -0.30, 0, 1, 1, 1, -0.16), C.lead);
      K.add('metal', boxRound(0.09, 0.08, 0.62, 0.025, 1), TRS(sx * (w / 2 - 0.16), 0.05, -0.06), C.lead);
    }
    if (v === 2) {
      /* SOMEBODY IS COMING BACK FOR THIS. A jacket left over the back
         rail and a mug on the slats — the same bench, mid-use. */
      jacket(K, 'metal', 0.34, sh + 0.62, -0.30, 0.5, mixHex(BUILD.awningAlt, BRAND.ink, 0.22));
      mug(K, -w * 0.24, sh + 0.075, -0.02, 1.1, C.paper);
      K.add('woodH', boxRound(0.30, 0.035, 0.22, 0, 1), TRS(-w * 0.05, sh + 0.09, 0.02, 0.4), C.paper);
    }
    return { K, r: 1.0, h: sh + 0.9 };
  },

  lamp(v, rng) {
    const K = new Kit(AO());
    const h = 3.5 + v * 0.35;
    const iron = v === 2 ? C.gold : C.lead;
    K.add('metal', cyl(0.13, 0.24, 0.38, 10, true), TRS(0, 0.19, 0), shadeHex(iron, 0.85));
    K.add('metal', post(0.075, h, 0.006, 8), TRS(0, h / 2 + 0.3, 0), iron);
    K.add('metal', torusG(0.14, 0.028, 12, 6), TRS(0, h * 0.62, 0, 0, 1, 1, 1, PI / 2), iron);
    K.add('metal', boxRound(0.10, 0.10, 0.52, 0.03, 1), TRS(0, h + 0.24, 0.2), iron);
    /* lantern: a tapered glass housing with a cap and a finial */
    K.add('metal', coneG(0.22, 0.26, 8), TRS(0, h + 0.60, 0.38), iron);
    K.add('metal', sphereG(0.055, 8), TRS(0, h + 0.78, 0.38), iron);
    K.add('lamp', boxRound(0.42, 0.50, 0.42, 0.10, 1), TRS(0, h + 0.24, 0.38), 0xffffff);
    /* THE BULB THAT WAS INSIDE THE LANTERN. There used to be a second
       emissive here — sphereG(0.20, 8), 80 triangles — concentric with
       the housing above. The housing's inner face is at 0.21 m on
       every axis and the sphere's radius was 0.20, so it was sealed
       inside an OPAQUE emissive box (M.emissive sets no transparency)
       and could not put a fragment on the screen from any angle. There
       are 531 street lamps on this island: 42 480 triangles that were
       drawn into the depth buffer, the main pass and four shadow
       cascades and were never once visible. */
    K.add('metal', boxRound(0.48, 0.07, 0.48, 0.02, 1), TRS(0, h + 0.52, 0.38), iron);
    for (let i = 0; i < 4; i++) {
      K.add('metal', boxRound(0.035, 0.50, 0.035, 0.012, 1), TRS(Math.sin(i * PI / 2) * 0.21, h + 0.24, 0.38 + Math.cos(i * PI / 2) * 0.21), iron);
    }
    return { K, r: 0.42, h: h + 0.8, tall: true };
  },

  bin(v, rng) {
    const K = new Kit(AO());
    const h = 0.86, r = 0.31;
    const col = [C.tin, mixHex(C.tin, LAND.grassShade, 0.4), mixHex(C.tin, BUILD.awning, 0.3)][v];
    K.add('metal', cyl(r, r * 0.86, h, 12, true), TRS(0, h / 2, 0), col);
    for (const t of [0.25, 0.7]) K.add('metal', torusG(r * lerp(0.86, 1, t) + 0.015, 0.03, 12, 6), TRS(0, h * t, 0, 0, 1, 1, 1, PI / 2), shadeHex(col, 0.8));
    K.add('metal', cyl(r * 1.06, r * 1.02, 0.09, 12, true), TRS(0, h + 0.04, 0), shadeHex(col, 0.88));
    K.add('metal', torusG(0.075, 0.022, 10, 6), TRS(0, h + 0.13, 0), C.lead);
    return { K, r: r * 1.2, h: h + 0.15 };
  },

  cart(v, rng) {
    const K = new Kit(AO());
    const w = 1.5, l = 2.2, bh = 0.62;
    const wood = [BUILD.wood, mixHex(BUILD.wood, BUILD.awning, 0.2), mixHex(BUILD.wood, BUILD.woodDark, 0.3)][v];
    K.add('woodH', boxRound(w, 0.12, l, 0.04, 1), TRS(0, 0.72, 0), wood);
    for (const sx of [-1, 1]) K.add('woodH', boxRound(0.09, bh, l, 0.03, 1), TRS(sx * w / 2, 0.72 + bh / 2, 0, 0, 1, 1, 1, 0, sx * 0.1), shadeHex(wood, 0.9));
    for (const sz of [-1, 1]) K.add('woodH', boxRound(w, bh, 0.09, 0.03, 1), TRS(0, 0.72 + bh / 2, sz * l / 2, 0, 1, 1, 1, sz * 0.1), shadeHex(wood, 0.9));
    for (const sx of [-1, 1]) {
      K.add('wood', torusG(0.42, 0.075, 16, 6), TRS(sx * (w / 2 + 0.09), 0.44, l * 0.16, 0, 1, 1, 1, 0, PI / 2), BUILD.woodDark);
      K.add('metal', torusG(0.42, 0.03, 16, 6), TRS(sx * (w / 2 + 0.09), 0.44, l * 0.16, 0, 1, 1, 1, 0, PI / 2), C.lead);
      for (let i = 0; i < 6; i++) {
        K.add('wood', boxRound(0.05, 0.8, 0.05, 0.018, 1), TRS(sx * (w / 2 + 0.09), 0.44, l * 0.16, 0, 1, 1, 1, 0, (i * PI) / 6), BUILD.woodDark);
      }
      K.add('wood', boxRound(0.09, 0.09, 1.5, 0.03, 1), TRS(sx * w * 0.32, 0.66, -l * 0.62, 0, 1, 1, 1, -0.16), BUILD.woodDark);
    }
    return { K, r: 1.3, h: 1.4 };
  },

  bike(v, rng) {
    const K = new Kit(AO());
    const col = [BUILD.awningAlt, BRAND.good, BUILD.awning][v];
    const R = 0.34;
    for (const sz of [-0.52, 0.52]) {
      K.add('metal', torusG(R, 0.035, 16, 6), TRS(0, R, sz), BRAND.ink);
      K.add('metal', torusG(R * 0.28, 0.02, 10, 5), TRS(0, R, sz), C.lead);
      for (let i = 0; i < 4; i++) K.add('metal', boxRound(0.014, R * 1.9, 0.014, 0.006, 1), TRS(0, R, sz, 0, 1, 1, 1, (i * PI) / 4), C.lead);
    }
    K.add('metal', boxRound(0.05, 0.05, 0.95, 0.018, 1), TRS(0, R + 0.30, 0, 0, 1, 1, 1, 0.14), col);
    K.add('metal', boxRound(0.05, 0.62, 0.05, 0.018, 1), TRS(0, R + 0.24, -0.42, 0, 1, 1, 1, -0.20), col);
    K.add('metal', boxRound(0.05, 0.66, 0.05, 0.018, 1), TRS(0, R + 0.22, 0.36, 0, 1, 1, 1, 0.26), col);
    K.add('metal', boxRound(0.05, 0.56, 0.05, 0.018, 1), TRS(0, R + 0.16, 0.14, 0, 1, 1, 1, -0.5), col);
    K.add('wood', boxRound(0.12, 0.07, 0.30, 0.03, 1), TRS(0, R + 0.56, -0.36), BRAND.ink);
    K.add('metal', boxRound(0.52, 0.045, 0.045, 0.016, 1), TRS(0, R + 0.60, 0.44), C.lead);
    K.add('metal', torusG(0.10, 0.02, 10, 5), TRS(0, R * 0.62, 0.52, 0, 1, 1, 1, 0, PI / 2), C.lead);
    return { K, r: 0.62, h: 1.05 };
  },

  produce(v, rng) {
    const K = new Kit(AO());
    const s = 0.8;
    const wood = mixHex(BUILD.wood, LAND.sand, 0.25);
    for (const [ax, sz] of [[0, 1], [0, -1], [1, 1], [1, -1]]) {
      K.add('wood', boxRound(ax ? 0.06 : s, 0.34, ax ? s : 0.06, 0.02, 1), TRS(ax ? sz * s * 0.5 : 0, 0.17, ax ? 0 : sz * s * 0.5), wood);
    }
    const pal = [
      [BUILD.awning, BRAND.warn, mixHex(BRAND.good, LAND.grassLit, 0.4)],
      [BRAND.token, mixHex(BUILD.awning, BRAND.token, 0.5), BRAND.warn],
      [mixHex(BRAND.good, LAND.grassLit, 0.5), BRAND.gem, BUILD.awning],
    ][v];
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * PI * 2 + v;
      const rr = 0.10 + (i % 3) * 0.022;
      K.add('hedge', sphereG(rr, 8), TRS(Math.sin(a) * s * 0.28, 0.36 + (i % 2) * 0.14, Math.cos(a) * s * 0.28, 0, 1, 0.9, 1), pal[i % 3]);
    }
    K.add('hedge', sphereG(0.13, 9), TRS(0, 0.48, 0), pal[1]);
    return { K, r: s * 0.8, h: 0.62 };
  },

  plant(v, rng) {
    const K = new Kit(AO());
    const pot = [BUILD.roof, mixHex(BUILD.roof, BUILD.woodDark, 0.3), mixHex(BUILD.stone, BUILD.roof, 0.4)][v];
    const potPts = [
      new THREE.Vector2(0.001, 0), new THREE.Vector2(0.24, 0), new THREE.Vector2(0.30, 0.16),
      new THREE.Vector2(0.36, 0.46), new THREE.Vector2(0.40, 0.52), new THREE.Vector2(0.36, 0.56),
      new THREE.Vector2(0.001, 0.56),
    ];
    K.add('roof', new THREE.LatheGeometry(potPts, 13), null, pot);
    K.add('hedge', sphereG(0.40, 10), TRS(0, 0.80, 0, 0, 1.1, 0.92, 1.1), v === 1 ? C.leaf : C.hedge);
    K.add('hedge', sphereG(0.26, 9), TRS(0.20, 1.02, -0.08, 0, 1, 0.9, 1), C.leaf);
    K.add('hedge', sphereG(0.22, 9), TRS(-0.18, 0.98, 0.12, 0, 1, 0.9, 1), mixHex(C.leaf, LAND.grassLit, 0.4));
    if (v === 2) {
      K.add('hedge', sphereG(0.10, 7), TRS(0.16, 1.16, 0.1), BUILD.awning);
      K.add('hedge', sphereG(0.09, 7), TRS(-0.14, 1.10, -0.14), BRAND.warn);
    }
    return { K, r: 0.5, h: 1.3 };
  },

  hedge(v, rng) {
    const K = new Kit(AO());
    const w = 1.9 + v * 0.3, h = 1.0 + v * 0.12, d = 1.0;
    K.add('hedge', boxRound(w, h, d, 0.32, 2), TRS(0, h / 2, 0), v === 1 ? C.hedge : mixHex(C.hedge, C.leaf, 0.35));
    K.add('hedge', sphereG(0.42, 8), TRS(-w * 0.28, h + 0.1, 0, 0, 1.2, 0.6, 1.2), C.leaf);
    K.add('hedge', sphereG(0.40, 8), TRS(w * 0.28, h + 0.08, 0, 0, 1.2, 0.6, 1.2), C.leaf);
    K.add('stone', boxRound(w + 0.34, 0.26, d + 0.34, 0.07, 1), TRS(0, 0.13, 0), C.stoneWarm);
    return { K, r: w * 0.6, h: h + 0.4 };
  },

  fence(v, rng) {
    const K = new Kit(AO());
    const w = 2.4, h = 1.15;
    const wood = [BUILD.wood, mixHex(BUILD.wood, LAND.sand, 0.3), BUILD.woodDark][v];
    for (const sx of [-1, 1]) K.add('wood', post(0.075, h, 0.01, 6), TRS(sx * w / 2, h / 2, 0), shadeHex(wood, 0.88));
    for (let i = 0; i < 3; i++) K.add('woodH', plank(w, 0.13, 0.06, rng), TRS(0, 0.32 + i * 0.32, 0, 0, 1, 1, 1, 0, 0.012 * (i - 1)), wood);
    if (v === 2) {
      /* THE PANEL SOMEBODY MENDED. A fence that has always been a
         fence has no history; one with a bright new board let into it,
         a brace nailed across the break and two clean nailheads has
         been broken once and cared about since. Same family, +42
         triangles, and it is the only one of these in a run. */
      const fresh = mixHex(LAND.sand, BUILD.wood, 0.34);
      K.add('woodH', plank(w * 0.38, 0.15, 0.065, rng), TRS(w * 0.16, 0.64, 0.012, 0, 1, 1, 1, 0, 0.02), fresh);
      K.add('woodH', boxRound(w * 0.42, 0.09, 0.05, 0, 1), TRS(w * 0.16, 0.62, -0.055, 0, 1, 1, 1, 0, 0.52), fresh);
      for (const sx of [-1, 1]) K.add('wood', cyl(0.026, 0.026, 0.05, 4, true), TRS(w * 0.16 + sx * w * 0.16, 0.64, 0.055, 0, 1, 1, 1, PI / 2), C.lead);
    }
    return { K, r: w * 0.55, h };
  },

  bollard(v, rng) {
    const K = new Kit(AO());
    const h = [0.85, 0.7, 0.95][v];
    const col = [C.lead, C.stoneWarm, C.tinDark][v];
    K.add('stone', cyl(0.14, 0.19, h, 10, true), TRS(0, h / 2, 0), col);
    K.add('stone', sphereG(0.15, 9), TRS(0, h, 0, 0, 1, 0.8, 1), col);
    K.add('stone', torusG(0.165, 0.028, 10, 6), TRS(0, h * 0.82, 0, 0, 1, 1, 1, PI / 2), shadeHex(col, 0.82));
    K.add('stone', cyl(0.26, 0.28, 0.1, 10, true), TRS(0, 0.05, 0), shadeHex(col, 0.86));
    /* A GULL ON THE MOORING POST. The waterfront's own bollards get
       one about one time in nine, which means you meet a few of them
       walking the quay and none of them anywhere else in the game. */
    if (v === 2) gull(K, 'stone', 0, h + 0.10, 0, 0.9, BRAND.paper, mixHex(BUILD.metal, BRAND.paper, 0.45), BRAND.warn);
    return { K, r: 0.32, h };
  },

  hay(v, rng) {
    const K = new Kit(AO());
    const r = 0.62, w = 1.15;
    K.add('hedge', cyl(r, r, w, 14, true), TRS(0, r, 0, 0, 1, 1, 1, 0, PI / 2), [C.hay, mixHex(C.hay, LAND.sand, 0.4), mixHex(C.hay, BUILD.wood, 0.25)][v]);
    for (const t of [0.28, 0.72]) K.add('wood', torusG(r + 0.02, 0.03, 14, 5), TRS(-w / 2 + w * t, r, 0, 0, 1, 1, 1, 0, PI / 2), BUILD.woodDark);
    if (v === 2) {
      /* left standing in the bale, which is where a fork lives between
         two jobs and never where a tidy game would put it */
      K.add('wood', cyl(0.038, 0.034, 1.30, 5, true), TRS(0.18, r + 0.60, 0.10, 0, 1, 1, 1, -0.34, 0.16), BUILD.wood);
      K.add('wood', boxRound(0.26, 0.075, 0.075, 0, 1), TRS(0.10, r + 1.22, 0.06, 0, 1, 1, 1, -0.34, 0.16), BUILD.woodDark);
      for (const sx of [-1, 0, 1]) {
        K.add('wood', cyl(0.026, 0.020, 0.34, 4, true), TRS(0.36 + sx * 0.055, r * 0.55, 0.24, 0, 1, 1, 1, -0.34, 0.16), C.lead);
      }
    }
    return { K, r: 0.8, h: r * 2 };
  },

  container(v, rng) {
    const K = new Kit(AO());
    const w = 5.2, h = 2.5, d = 2.3;
    const col = [C.containerA, C.containerB, C.containerC][v];
    K.add('metal', boxRound(w, h, d, 0.10, 1), TRS(0, h / 2, 0), col);
    for (const sz of [-1, 1]) {
      K.add('metal', corrugated(w * 0.96, h * 0.86, 14, 0.045, 0.06), TRS(0, h / 2, sz * (d / 2 + 0.02), sz > 0 ? 0 : PI), shadeHex(col, 0.94));
    }
    for (const sx of [-1, 1]) {
      K.add('metal', boxRound(0.17, h, d + 0.06, 0.05, 1), TRS(sx * w / 2, h / 2, 0), shadeHex(col, 0.8));
      for (let i = 0; i < 4; i++) {
        K.add('metal', boxRound(0.09, h * 0.9, 0.09, 0.03, 1), TRS(sx * (w / 2 - 0.02), h / 2, -d / 2 + 0.2 + i * (d - 0.4) / 3), shadeHex(col, 0.72));
      }
    }
    K.add('metal', boxRound(w + 0.08, 0.15, d + 0.08, 0.05, 1), TRS(0, h - 0.05, 0), shadeHex(col, 0.86));
    K.add('metal', boxRound(w + 0.08, 0.15, d + 0.08, 0.05, 1), TRS(0, 0.08, 0), shadeHex(col, 0.78));
    return { K, r: w * 0.55, h };
  },

  /* ==================================================================
     DISTRICT VOCABULARY.

     Everything above this line is furniture that could stand in any
     district on the island, and scattering more of it with different
     weights is exactly what produced "the city reads as generic".
     Everything below it belongs to ONE place and reads wrong anywhere
     else — that is the whole point of it. A cable drum says Iron Hills
     the way a lobster pot says Waterfront, without a label.

     Each is built to the same contract as the catalogue above: one
     factory, base at y = 0, reports {K, r, h}, gets a measured collider
     from solidFor() and an entry in PROP_FOOTPRINT so the doorway
     corridor can refuse it before it is ever placed.

     KEPT DELIBERATELY CHEAP. Every type is another InstancedMesh per
     material family per cell, and the district set is twenty types —
     so each of these uses one or two families and no chamfer arcs on
     anything thinner than THIN. The whole set costs about what four
     crates cost.
     ================================================================== */

  /* --- Rusty Row: what a street with no money leaves outside --- */
  tyres(v, rng) {
    const K = new Kit(AO());
    const R = 0.42, tube = 0.13;
    const n = 3 + v;
    for (let i = 0; i < n; i++) {
      K.add('metal', torusG(R, tube, 12, 6),
        TRS(0.03 * (i % 2 ? 1 : -1), tube + i * tube * 1.7, 0.02 * (i % 3 - 1),
          (i * 0.7) % PI, 1, 1, 1, PI / 2), i % 2 ? shadeHex(BRAND.ink, 1.25) : shadeHex(BRAND.ink, 1.05));
    }
    return { K, r: R + tube, h: tube * 2 + (n - 1) * tube * 1.7 };
  },

  gasbottle(v, rng) {
    const K = new Kit(AO());
    const h = 0.92, r = 0.20;
    const col = [BRAND.warn, mixHex(BUILD.awningAlt, C.tin, 0.35), C.rustPale][v];
    for (const [dx, dz, dy] of [[0, 0, 0], [0.44, 0.06, 0], [0.22, 0.38, 0]]) {
      K.add('metal', cyl(r * 0.9, r, h, 10, true), TRS(dx, h / 2 + dy, dz), col);
      K.add('metal', cyl(r * 0.55, r * 0.9, 0.12, 8, true), TRS(dx, h + 0.06 + dy, dz), shadeHex(col, 0.84));
      K.add('metal', torusG(r * 0.30, 0.028, 8, 5), TRS(dx, h + 0.15 + dy, dz, 0, 1, 1, 1, PI / 2), C.lead);
      K.add('metal', torusG(r + 0.012, 0.024, 10, 5), TRS(dx, h * 0.72 + dy, dz, 0, 1, 1, 1, PI / 2), shadeHex(col, 0.78));
    }
    return { K, r: 0.52, h: h + 0.2 };
  },

  /* --- Main Street: the furniture a civic pavement carries --- */
  postbox(v, rng) {
    const K = new Kit(AO());
    const h = 1.32, r = 0.28;
    const col = [BUILD.awning, mixHex(BUILD.awning, BRAND.ink, 0.24), BRAND.token2 ?? BUILD.awning][v] ?? BUILD.awning;
    K.add('metal', cyl(r * 0.92, r, h, 12, true), TRS(0, h / 2, 0), col);
    K.add('metal', cyl(r * 0.99, r * 0.99, 0.10, 12, true), TRS(0, h + 0.05, 0), shadeHex(col, 0.86));
    K.add('metal', sphereG(r * 0.92, 12), TRS(0, h + 0.10, 0, 0, 1, 0.52, 1), shadeHex(col, 0.92));
    /* the slot, and the collection plate under it */
    K.add('metal', boxRound(0.34, 0.075, 0.10, 0.02, 1), TRS(0, h * 0.82, r * 0.92), BRAND.ink);
    K.add('metal', boxRound(0.30, 0.22, 0.06, 0.02, 1), TRS(0, h * 0.42, r * 0.95), C.paper);
    K.add('metal', cyl(r * 1.16, r * 1.24, 0.13, 12, true), TRS(0, 0.065, 0), C.lead);
    return { K, r: r * 1.3, h: h + 0.28 };
  },

  newsbox(v, rng) {
    const K = new Kit(AO());
    const bh = 0.66, bw = 0.44, bd = 0.36, leg = 0.34;
    const cols = [BRAND.info, BRAND.good, BRAND.warn];
    for (let i = 0; i < 2 + (v ? 1 : 0); i++) {
      const x = -0.26 + i * 0.52;
      const col = cols[(i + v) % 3];
      K.add('metal', boxRound(bw, bh, bd, 0.05, 1), TRS(x, leg + bh / 2, 0), col);
      /* the glazed front the front page shows through */
      K.add('metal', boxRound(bw * 0.74, bh * 0.52, 0.05, 0.02, 1), TRS(x, leg + bh * 0.68, bd / 2 + 0.01), C.paper);
      K.add('metal', boxRound(bw + 0.05, 0.07, bd + 0.05, 0.02, 1), TRS(x, leg + bh + 0.02, 0, 0, 1, 1, 1, -0.12), shadeHex(col, 0.8));
      for (const sx of [-1, 1]) {
        K.add('metal', boxRound(0.05, leg, 0.05, 0.015, 1), TRS(x + sx * (bw / 2 - 0.05), leg / 2, 0), C.lead);
      }
    }
    return { K, r: 0.55, h: leg + bh + 0.1 };
  },

  /* --- Learning Quarter: chalk dust and second chances --- */
  chalkboard(v, rng) {
    const K = new Kit(AO());
    const bw = 1.10, bh = 0.86, legH = 0.62;
    const wood = [BUILD.wood, BUILD.woodDark, mixHex(BUILD.wood, LAND.sand, 0.3)][v];
    for (const sz of [-1, 1]) {
      K.add('wood', boxRound(bw + 0.14, bh + 0.14, 0.07, 0.03, 1),
        TRS(0, legH + bh / 2 + 0.1, sz * 0.16, 0, 1, 1, 1, sz * 0.18), wood);
      K.add('wood', boxRound(bw * 0.94, bh * 0.9, 0.03, 0, 1),
        TRS(0, legH + bh / 2 + 0.1, sz * (0.16 + 0.05), 0, 1, 1, 1, sz * 0.18), shadeHex(BRAND.ink, 1.45));
      for (const sx of [-1, 1]) {
        K.add('wood', boxRound(0.07, legH + 0.2, 0.07, 0.02, 1),
          TRS(sx * bw * 0.46, (legH + 0.2) / 2, sz * 0.20, 0, 1, 1, 1, sz * 0.18), wood);
      }
    }
    /* the chalk tray and a stub of chalk on it */
    K.add('wood', boxRound(bw + 0.10, 0.06, 0.30, 0.02, 1), TRS(0, legH + 0.10, 0), shadeHex(wood, 0.88));
    K.add('wood', boxRound(0.10, 0.045, 0.045, 0, 1), TRS(bw * 0.2, legH + 0.15, 0.03), C.paper);
    return { K, r: 0.72, h: legH + bh + 0.24 };
  },

  bookbarrow(v, rng) {
    const K = new Kit(AO());
    const w = 0.92, l = 0.62, bedY = 0.46;
    const wood = [BUILD.wood, mixHex(BUILD.wood, BUILD.woodDark, 0.4), mixHex(BUILD.wood, LAND.sand, 0.25)][v];
    K.add('woodH', boxRound(w, 0.08, l, 0.03, 1), TRS(0, bedY, 0), wood);
    for (const sz of [-1, 1]) K.add('woodH', boxRound(w, 0.34, 0.07, 0.025, 1), TRS(0, bedY + 0.19, sz * l / 2), shadeHex(wood, 0.9));
    for (const sx of [-1, 1]) {
      K.add('woodH', boxRound(0.07, 0.34, l, 0.025, 1), TRS(sx * w / 2, bedY + 0.19, 0), shadeHex(wood, 0.9));
      K.add('metal', boxRound(0.05, bedY, 0.05, 0.015, 1), TRS(sx * (w / 2 - 0.07), bedY / 2, l * 0.34), C.lead);
      K.add('metal', torusG(0.14, 0.03, 10, 5), TRS(sx * (w / 2 - 0.02), 0.14, -l * 0.28, PI / 2), C.lead);
      K.add('metal', boxRound(0.05, 0.60, 0.05, 0.015, 1), TRS(sx * (w / 2 - 0.07), 0.34, -l * 0.34, 0, 1, 1, 1, 0.55), C.lead);
    }
    /* the books: three ranks of spines, leaning */
    const spine = [BRAND.info, BRAND.good, BUILD.awning, BRAND.gem, BRAND.warn];
    for (let i = 0; i < 9; i++) {
      K.add('woodH', boxRound(0.075, 0.30, 0.22, 0, 1),
        TRS(-w * 0.40 + (w * 0.80 * i) / 8, bedY + 0.20, ((i % 3) - 1) * 0.15, 0, 1, 1, 1, 0, (i % 4 - 1.5) * 0.10),
        spine[i % spine.length]);
    }
    return { K, r: 0.60, h: bedY + 0.4 };
  },

  /* --- Market Square: what a market leaves on the cobbles --- */
  pallets(v, rng) {
    const K = new Kit(AO());
    const w = 1.10, d = 0.90, t = 0.115;
    const n = 4 + v * 2;
    const wood = mixHex(BUILD.wood, LAND.sand, 0.30);
    for (let i = 0; i < n; i++) {
      const y = t * (i + 0.5), sk = (i % 3 - 1) * 0.05, ry = (i % 5 - 2) * 0.05;
      for (let b = 0; b < 3; b++) {
        K.add('woodH', boxRound(w, 0.045, 0.14, 0, 1),
          TRS(sk, y + 0.032, -d / 2 + 0.07 + (b * (d - 0.14)) / 2, ry), i % 2 ? shadeHex(wood, 0.9) : wood);
      }
      for (let b = 0; b < 4; b++) {
        K.add('woodH', boxRound(0.13, 0.035, d, 0, 1),
          TRS(sk - w / 2 + 0.065 + (b * (w - 0.13)) / 3, y - 0.035, 0, ry), shadeHex(wood, 0.84));
      }
    }
    return { K, r: 0.72, h: t * n };
  },

  sacks(v, rng) {
    const K = new Kit(AO());
    const col = [C.hay, mixHex(C.hay, LAND.dirt, 0.32), mixHex(BRAND.paper, LAND.sand, 0.5)][v];
    const put = (x, y, z, ry, s) => {
      K.add('hedge', sphereG(0.30, 9), TRS(x, y + 0.22, z, ry, 1.15 * s, 0.78 * s, 0.86 * s), col);
      K.add('hedge', sphereG(0.13, 7), TRS(x, y + 0.40 * s, z, ry, 0.9 * s, 0.7 * s, 0.9 * s), shadeHex(col, 0.88));
    };
    put(-0.28, 0, 0.06, 0.3, 1);
    put(0.30, 0, -0.08, -0.5, 1.05);
    put(0.02, 0.32, 0.02, 1.1, 0.95);
    if (v) put(-0.10, 0.62, -0.10, 2.0, 0.88);
    return { K, r: 0.62, h: v ? 1.0 : 0.72 };
  },

  /* --- Green Edge: a farmyard, not a field with objects in it --- */
  churn(v, rng) {
    const K = new Kit(AO());
    const h = 0.78, r = 0.21;
    const col = [C.tin, mixHex(C.tin, LAND.grassShade, 0.22), C.tinDark][v];
    for (const [dx, dz] of [[0, 0], [0.46, 0.10], [0.23, -0.36]]) {
      K.add('metal', cyl(r * 0.68, r, h, 11, true), TRS(dx, h / 2, dz), col);
      K.add('metal', cyl(r * 0.74, r * 0.66, 0.16, 10, true), TRS(dx, h + 0.06, dz), shadeHex(col, 0.86));
      K.add('metal', torusG(r * 0.70, 0.024, 10, 5), TRS(dx, h + 0.14, dz, 0, 1, 1, 1, PI / 2), C.lead);
      K.add('metal', torusG(r * 0.92, 0.026, 11, 5), TRS(dx, h * 0.55, dz, 0, 1, 1, 1, PI / 2), shadeHex(col, 0.8));
    }
    return { K, r: 0.52, h: h + 0.2 };
  },

  trough(v, rng) {
    const K = new Kit(AO());
    const w = 1.9, h = 0.52, d = 0.68;
    const stone = [C.stoneWarm, mixHex(C.stoneWarm, LAND.rock, 0.4), mixHex(C.stoneWarm, C.soil, 0.22)][v];
    K.add('stone', boxRound(w, h, d, 0.07, 1), TRS(0, h / 2, 0), stone);
    K.add('stone', boxRound(w - 0.28, 0.16, d - 0.26, 0.05, 1), TRS(0, h - 0.05, 0), shadeHex(stone, 0.62));
    /* the water in it, and the standpipe over the end */
    /* NOT glassCool: that family is the night-curve emissive and a
       cattle trough would come on at dusk with the shop windows. */
    K.add('hedge', boxRound(w - 0.30, 0.05, d - 0.28, 0.02, 1), TRS(0, h - 0.11, 0), SEA.shallow);
    K.add('metal', cyl(0.05, 0.05, 0.86, 7, false), TRS(w / 2 - 0.14, 0.43 + h, 0), C.lead);
    K.add('metal', cyl(0.045, 0.045, 0.26, 6, false), TRS(w / 2 - 0.14, h + 0.82, -0.10, 0, 1, 1, 1, PI / 2), C.lead);
    return { K, r: w * 0.55, h: h + 0.9 };
  },

  /* --- Iron Hills: the hills remember being rich --- */
  cabledrum(v, rng) {
    const K = new Kit(AO());
    const R = 0.86, wdt = 0.82, hubR = 0.34;
    const wood = [BUILD.woodDark, mixHex(BUILD.woodDark, C.rust, 0.28), BUILD.wood][v];
    for (const sx of [-1, 1]) {
      K.add('wood', cyl(R, R, 0.10, 16, true), TRS(sx * (wdt / 2 - 0.05), R, 0, 0, 1, 1, 1, 0, PI / 2), wood);
      for (let i = 0; i < 6; i++) {
        /* the flange's face is the YZ plane — the axle runs along X —
           so a spoke spins about X, not about Z */
        K.add('wood', boxRound(0.06, R * 1.9, 0.11, 0, 1),
          TRS(sx * (wdt / 2 + 0.02), R, 0, 0, 1, 1, 1, (i * PI) / 6, 0), shadeHex(wood, 0.86));
      }
    }
    K.add('metal', cyl(hubR, hubR, wdt, 12, true), TRS(0, R, 0, 0, 1, 1, 1, 0, PI / 2), C.lead);
    /* the cable still on it */
    for (let i = 0; i < 5; i++) {
      K.add('metal', cyl(hubR + 0.10 + i * 0.055, hubR + 0.10 + i * 0.055, wdt - 0.16, 13, true),
        TRS(0, R, 0, 0, 1, 1, 1, 0, PI / 2), i % 2 ? C.tinDark : shadeHex(C.lead, 1.1));
    }
    return { K, r: R, h: R * 2 };
  },

  oildrum(v, rng) {
    const K = new Kit(AO());
    const h = 0.92, r = 0.30;
    const col = [C.rust, mixHex(BUILD.awningAlt, C.rustPale, 0.4), mixHex(BRAND.warn, C.rust, 0.4)][v];
    /* two upright and one on its side, the way a yard actually leaves them */
    for (const [dx, dz] of [[0, 0], [0.68, 0.12]]) {
      K.add('metal', cyl(r, r, h, 12, true), TRS(dx, h / 2, dz), col);
      for (const t of [0.3, 0.7]) K.add('metal', torusG(r + 0.02, 0.032, 12, 5), TRS(dx, h * t, dz, 0, 1, 1, 1, PI / 2), shadeHex(col, 0.76));
      K.add('metal', cyl(r * 0.96, r * 0.96, 0.06, 12, true), TRS(dx, h + 0.02, dz), shadeHex(col, 0.88));
    }
    if (v) {
      K.add('metal', cyl(r, r, h, 12, true), TRS(0.34, r, -0.72, 0.4, 1, 1, 1, 0, PI / 2), shadeHex(col, 0.9));
      for (const t of [0.3, 0.7]) {
        K.add('metal', torusG(r + 0.02, 0.032, 12, 5),
          TRS(0.34 + (t - 0.5) * h * 0.92, r, -0.72 - (t - 0.5) * h * 0.38, PI / 2 + 0.4), shadeHex(col, 0.72));
      }
    }
    return { K, r: 0.72, h };
  },

  /* --- Waterfront: rope, pots and gulls --- */
  ropecoil(v, rng) {
    const K = new Kit(AO());
    const col = [C.hay, mixHex(C.hay, LAND.dirt, 0.3), mixHex(BRAND.paper, C.hay, 0.4)][v];
    let R = 0.52;
    for (let i = 0; i < 4; i++) {
      K.add('hedge', torusG(R, 0.055, 14, 5), TRS(0, 0.055 + i * 0.085, 0, i * 0.6, 1, 1, 1, PI / 2),
        i % 2 ? shadeHex(col, 0.88) : col);
      R -= 0.075;
    }
    /* the free end, flopped over the side */
    K.add('hedge', cyl(0.05, 0.05, 0.66, 5, false), TRS(0.44, 0.06, 0.22, 0.7, 1, 1, 1, 0, PI / 2 - 0.2), shadeHex(col, 0.82));
    /* a bitt to coil it round, on the taller variant */
    if (v) {
      K.add('metal', cyl(0.10, 0.12, 0.52, 9, true), TRS(0, 0.26, 0), C.lead);
      K.add('metal', cyl(0.15, 0.13, 0.08, 9, true), TRS(0, 0.54, 0), shadeHex(C.lead, 0.86));
    }
    return { K, r: 0.62, h: v ? 0.62 : 0.4 };
  },

  lobsterpot(v, rng) {
    const K = new Kit(AO());
    const w = 0.78, d = 0.56, h = 0.36;
    const lath = [mixHex(BUILD.wood, LAND.sand, 0.35), BUILD.wood, mixHex(BUILD.wood, SEA.wet, 0.18)][v];
    /* one matrix for the whole pot — see the note in escooter */
    const one = (oy, yaw) => {
      const M = TRS(0, oy, 0, yaw);
      const put = (fam, g, m, c) => K.add(fam, g, new THREE.Matrix4().multiplyMatrices(M, m), c);
      put('wood', boxRound(w, 0.06, d, 0.02, 1), TRS(0, 0.03, 0), shadeHex(lath, 0.86));
      /* the hoops: half-round ribs across the base, ringing the X axis */
      for (let i = 0; i < 5; i++) {
        put('wood', torusG(h * 0.86, 0.028, 10, 5),
          TRS(0, 0.05, -d / 2 + (d * i) / 4, PI / 2, 1, 1, 0.92), lath);
      }
      for (const sz of [-1, 1]) {
        put('wood', boxRound(w * 0.94, 0.05, 0.05, 0, 1), TRS(0, h * 0.80, sz * d * 0.34), shadeHex(lath, 0.92));
      }
      put('wood', boxRound(w * 0.94, 0.05, 0.05, 0, 1), TRS(0, h * 0.86, 0), shadeHex(lath, 0.92));
      /* the net stretched over them */
      put('hedge', boxRound(w * 0.88, 0.03, d * 0.84, 0, 1), TRS(0, h * 0.84, 0), mixHex(C.hay, LAND.grassShade, 0.35));
    };
    one(0, 0);
    if (v) one(h * 0.92, 0.42);
    return { K, r: 0.52, h: v ? h * 1.92 : h };
  },

  /* --- Innovation District: six startups per building --- */
  escooter(v, rng) {
    const K = new Kit(AO());
    const R = 0.17, deck = 0.13;
    const col = [BRAND.info, BRAND.good, BRAND.token][v];
    /* ONE MATRIX PER SCOOTER. A yaw passed into each part's own TRS
       spins the part and leaves the position alone, which turns a
       scooter into a pile of correctly-angled bits in a straight line.
       The whole machine is built along +Z and then placed. */
    const one = (x, z, yaw) => {
      const M = TRS(x, 0, z, yaw);
      const put = (fam, g, m, c) => K.add(fam, g, new THREE.Matrix4().multiplyMatrices(M, m), c);
      put('metal', boxRound(0.20, 0.06, 0.84, 0.02, 1), TRS(0, deck, 0), BRAND.ink);
      for (const sz of [-1, 1]) {
        put('metal', torusG(R, 0.05, 10, 5), TRS(0, R, sz * 0.42), BRAND.ink);
        put('metal', torusG(R * 0.34, 0.022, 8, 5), TRS(0, R, sz * 0.42), C.lead);
      }
      /* the steering column rakes back over the front wheel */
      put('metal', boxRound(0.06, 1.00, 0.06, 0.02, 1), TRS(0, deck + 0.48, 0.36, 0, 1, 1, 1, -0.16), col);
      put('metal', boxRound(0.44, 0.05, 0.05, 0.015, 1), TRS(0, deck + 0.96, 0.28), C.lead);
      put('metal', boxRound(0.15, 0.17, 0.06, 0.02, 1), TRS(0, deck + 0.82, 0.30), col);
      put('metal', boxRound(0.10, 0.10, 0.16, 0.03, 1), TRS(0, R + 0.02, -0.42), col);
    };
    one(-0.30, 0, 0.10);
    one(0.32, 0.06, -0.16);
    if (v) one(0.94, -0.04, 0.05);
    return { K, r: v ? 0.86 : 0.62, h: deck + 1.05 };
  },

  techplanter(v, rng) {
    const K = new Kit(AO());
    const w = 1.6, h = 0.52, d = 0.62;
    const shell = [C.rust, mixHex(C.tinDark, BUILD.metal, 0.3), mixHex(C.rustPale, BUILD.woodDark, 0.3)][v];
    K.add('metal', boxRound(w, h, d, 0.04, 1), TRS(0, h / 2, 0), shell);
    K.add('metal', boxRound(w + 0.07, 0.07, d + 0.07, 0.02, 1), TRS(0, h - 0.02, 0), shadeHex(shell, 0.82));
    K.add('metal', boxRound(w - 0.14, 0.10, d - 0.14, 0.03, 1), TRS(0, h - 0.10, 0), C.soil);
    /* ornamental grasses — blades, not a shrub ball */
    for (let i = 0; i < 13; i++) {
      const t = i / 12;
      K.add('hedge', boxRound(0.05, 0.62 + (i % 3) * 0.17, 0.05, 0, 1),
        TRS(-w * 0.42 + w * 0.84 * t, h + 0.30, ((i % 3) - 1) * 0.16,
          i * 0.9, 1, 1, 1, ((i % 5) - 2) * 0.10, ((i % 4) - 1.5) * 0.12),
        i % 3 ? C.leaf : mixHex(C.leaf, C.hay, 0.4));
    }
    return { K, r: w * 0.55, h: h + 0.9 };
  },

  /* --- Stampede: a stadium approach on a match day --- */
  barrier(v, rng) {
    const K = new Kit(AO());
    const w = 2.1, h = 1.05;
    const col = [C.tin, mixHex(C.tin, BRAND.warn, 0.30), C.tinDark][v];
    for (const yy of [h - 0.06, h * 0.52]) {
      K.add('metal', cyl(0.045, 0.045, w, 6, false), TRS(0, yy, 0, 0, 1, 1, 1, 0, PI / 2), col);
    }
    for (const sx of [-1, 1]) {
      K.add('metal', cyl(0.05, 0.05, h, 7, false), TRS(sx * (w / 2 - 0.05), h / 2, 0), col);
      /* the splayed foot that stops it toppling */
      K.add('metal', cyl(0.04, 0.04, 0.62, 6, false), TRS(sx * (w / 2 - 0.05), 0.16, 0, 0, 1, 1, 1, PI / 2), shadeHex(col, 0.84));
      K.add('metal', cyl(0.038, 0.038, 0.40, 6, false), TRS(sx * (w / 2 - 0.05), 0.30, 0.14, 0, 1, 1, 1, 0.9), shadeHex(col, 0.84));
    }
    for (let i = 1; i < 5; i++) {
      K.add('metal', cyl(0.03, 0.03, h * 0.56, 5, false), TRS(-w / 2 + (w * i) / 5, h * 0.76, 0), shadeHex(col, 0.92));
    }
    return { K, r: w * 0.52, h };
  },

  turnstile(v, rng) {
    const K = new Kit(AO());
    const h = 1.02, r = 0.55;
    const col = [C.lead, C.tinDark, mixHex(C.lead, BRAND.warn, 0.22)][v];
    K.add('metal', cyl(0.20, 0.26, h, 10, true), TRS(0, h / 2, 0), col);
    K.add('metal', cyl(0.24, 0.20, 0.12, 10, true), TRS(0, h + 0.05, 0), shadeHex(col, 0.86));
    for (let i = 0; i < 3; i++) {
      K.add('metal', cyl(0.045, 0.045, r, 6, false),
        TRS(Math.sin(i * 2.094) * r * 0.5, h - 0.08, Math.cos(i * 2.094) * r * 0.5,
          i * 2.094 + PI / 2, 1, 1, 1, 0, PI / 2), shadeHex(col, 1.1));
    }
    /* the pier it is bolted to, and the paint on the kerb */
    K.add('stone', boxRound(0.66, 0.26, 0.66, 0.05, 1), TRS(0, 0.13, 0), C.stoneCool);
    K.add('metal', boxRound(0.30, 0.22, 0.05, 0.02, 1), TRS(0, h * 0.72, 0.25), BRAND.token);
    return { K, r: 0.62, h: h + 0.2 };
  },

  /* --- Golden Heights: where the money already lives --- */
  urn(v, rng) {
    const K = new Kit(AO());
    const stone = [C.marble, C.stoneWarm, mixHex(C.marble, C.gold, 0.14)][v];
    K.add('stone', boxRound(0.62, 0.30, 0.62, 0.05, 1), TRS(0, 0.15, 0), shadeHex(stone, 0.9));
    K.add('stone', boxRound(0.46, 0.52, 0.46, 0.06, 1), TRS(0, 0.56, 0), stone);
    const pts = [
      new THREE.Vector2(0.001, 0), new THREE.Vector2(0.16, 0), new THREE.Vector2(0.20, 0.10),
      new THREE.Vector2(0.34, 0.34), new THREE.Vector2(0.36, 0.52), new THREE.Vector2(0.30, 0.66),
      new THREE.Vector2(0.34, 0.72), new THREE.Vector2(0.30, 0.76), new THREE.Vector2(0.001, 0.76),
    ];
    K.add('stone', new THREE.LatheGeometry(pts, 14), TRS(0, 0.82, 0), stone);
    for (const sx of [-1, 1]) K.add('stone', torusG(0.10, 0.028, 8, 5), TRS(sx * 0.33, 1.32, 0, PI / 2, 1, 1, 1, PI / 2), shadeHex(stone, 0.88));
    K.add('hedge', sphereG(0.30, 10), TRS(0, 1.60, 0, 0, 1.25, 0.72, 1.25), C.hedge);
    K.add('hedge', sphereG(0.17, 8), TRS(0.16, 1.72, -0.08), mixHex(BUILD.awning, BRAND.paper, 0.25));
    K.add('hedge', sphereG(0.15, 8), TRS(-0.15, 1.70, 0.10), mixHex(BRAND.token, BRAND.paper, 0.3));
    return { K, r: 0.44, h: 1.86 };
  },

  topiary(v, rng) {
    const K = new Kit(AO());
    const potR = 0.40;
    const pot = [C.marble, C.stoneWarm, mixHex(C.stoneCool, C.marble, 0.4)][v];
    K.add('stone', cyl(potR, potR * 0.78, 0.54, 14, true), TRS(0, 0.27, 0), pot);
    K.add('stone', torusG(potR + 0.02, 0.05, 14, 5), TRS(0, 0.52, 0, 0, 1, 1, 1, PI / 2), shadeHex(pot, 0.88));
    K.add('stone', cyl(potR * 0.86, potR * 0.86, 0.08, 12, true), TRS(0, 0.55, 0), C.soil);
    K.add('wood', cyl(0.07, 0.09, 0.42, 7, false), TRS(0, 0.78, 0), BUILD.woodDark);
    /* three clipped balls up a standard — money's own shrub */
    const g = [0.42, 0.33, 0.24];
    let y = 1.06;
    for (let i = 0; i < 3; i++) {
      K.add('hedge', sphereG(g[i], 11), TRS(0, y, 0, i * 0.7, 1, 0.94, 1), i % 2 ? C.hedge : mixHex(C.hedge, C.leaf, 0.3));
      if (i < 2) K.add('wood', cyl(0.055, 0.06, 0.26, 6, false), TRS(0, y + g[i] + 0.08, 0), BUILD.woodDark);
      y += g[i] + g[i + 1] * 0.9 + 0.16;
    }
    return { K, r: 0.5, h: 2.1 };
  },

  orecart(v, rng) {
    const K = new Kit(AO());
    const w = 1.15, h = 0.8, d = 1.5;
    K.add('metal', boxRound(w, h, d, 0.09, 1), TRS(0, 0.62, 0, 0, 1, 1, 1, 0.06), [C.rust, C.tinDark, C.rustPale][v]);
    K.add('metal', boxRound(w * 0.86, 0.1, d * 0.86, 0.03, 1), TRS(0, 0.98, 0), shadeHex(C.soil, 1.1));
    for (let i = 0; i < 5; i++) {
      K.add('stone', sphereG(0.13 + (i % 2) * 0.04, 7), TRS(-0.3 + (i % 3) * 0.3, 1.03, -0.3 + Math.floor(i / 3) * 0.5), mixHex(LAND.rock, C.soil, 0.4));
    }
    K.add('metal', boxRound(w * 0.9, 0.14, d * 0.9, 0.04, 1), TRS(0, 0.28, 0), C.lead);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      K.add('metal', cyl(0.19, 0.19, 0.09, 10, true), TRS(sx * w * 0.5, 0.19, sz * d * 0.32, 0, 1, 1, 1, 0, PI / 2), C.lead);
    }
    return { K, r: 0.95, h: 1.15 };
  },

  /* ==================================================================
     MID-USE. Not stored, not arranged — put down.

     Everything above this line is furniture in its resting state, and
     a city entirely in its resting state reads as a showroom. These
     three are caught in the middle of a job: a sweeping half done, a
     board wheeled out this morning and chalked, a signpost that only
     exists because two districts meet at that spot.

     All three are deliberately ONE material family, so each costs one
     InstancedMesh per cell rather than the two to four the older
     district shapes cost.
     ================================================================== */

  /* A besom leaning where it was left, and the pile it got halfway
     through. The pile is the whole point: a broom against a wall is a
     tool, a broom against a wall with a heap of sweepings and the pan
     still on the ground beside it is somebody's interrupted morning. */
  broom(v, rng) {
    const K = new Kit(AO());
    const wood = [BUILD.wood, mixHex(BUILD.wood, BUILD.woodDark, 0.4), mixHex(BUILD.wood, LAND.sand, 0.3)][v];
    /* THIRTY DEGREES, NOT SEVENTEEN. Photographed at the smaller lean
       this read as a pole standing on end in the middle of a plaza.
       The lean has to be steep enough to say "propped against
       something" from the side as well as head-on — and the wall pass
       turns it so the handle falls toward the wall. */
    const lean = 0.52 + v * 0.04;
    const L = 1.46;
    K.add('wood', cyl(0.034, 0.042, L, 5, true), TRS(Math.sin(lean) * L * 0.5, Math.cos(lean) * L * 0.5, 0, 0, 1, 1, 1, 0, -lean), wood);
    /* THE HEAD IS THE OBJECT. A besom is mostly bristle; the first
       version gave it a 0.115 m dark stub and the whole thing read as
       a walking stick. Straw-pale, splayed wide, fanned, so it has a
       silhouette of its own at three metres. */
    const straw = mixHex(C.hay, LAND.sand, 0.25);
    K.add('wood', cyl(0.075, 0.20, 0.46, 7, true), TRS(0.055, 0.25, 0, 0, 1, 1, 1, 0, -lean), straw);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * PI * 2;
      K.add('wood', cyl(0.030, 0.075, 0.40, 4, true),
        TRS(0.06 + Math.cos(a) * 0.085, 0.23, Math.sin(a) * 0.085, 0, 1, 1, 1, Math.sin(a) * 0.22, -lean + Math.cos(a) * 0.18),
        i % 2 ? straw : shadeHex(straw, 0.88));
    }
    K.add('wood', torusG(0.088, 0.032, 7, 4), TRS(0.075, 0.40, 0, 0, 1, 1, 1, PI / 2 - lean), C.lead);
    /* THE HALF-SWEPT PILE is the part that says somebody was
       interrupted, and it has to be big enough and PALE enough to read
       against a dark plaza: the first one was two flat brown discs on
       brown paving and could not be seen from three metres. */
    /* AND IT SITS 8 cm PROUD, WHICH IS NOT A MISTAKE. city.js places
       every prop on world.heightAt(), and surfacetest's whole reason
       for existing is that the ground you SEE is a four-LOD mesh plus
       plaza pads that runs up to ~0.15 m above what heightAt() reports.
       Every other prop in the catalogue is tall enough not to care.
       This one keeps its entire story in the bottom 20 cm — and
       photographed on Market Square's paving, the pile, the pan and
       half the head were under the plaza and the broom read as a stick
       leaning on a wall. A soft heap sitting 8 cm high on flat ground
       is invisible; a soft heap 8 cm under it does not exist. */
    const LIFT = 0.085;
    const dust = mixHex(C.hay, LAND.dirt, 0.34);
    K.add('wood', sphereG(0.30, 7), TRS(-0.40, LIFT + 0.03, 0.06, 0.6, 1.15, 0.62, 0.95), dust);
    K.add('wood', sphereG(0.19, 6), TRS(-0.62, LIFT, -0.10, 1.2, 1.35, 0.50, 0.95), shadeHex(dust, 0.94));
    /* and the few leaves that have not been got yet */
    for (let i = 0; i < 4; i++) {
      K.add('wood', boxRound(0.15, 0.06, 0.11, 0.02, 1),
        TRS(-0.30 - i * 0.16, LIFT + 0.04 + (i % 2) * 0.06, 0.20 - i * 0.11, i * 1.3, 1, 1, 1, 0, (i % 3 - 1) * 0.3),
        i % 2 ? mixHex(BUILD.awning, C.hay, 0.45) : mixHex(BRAND.warn, LAND.dirt, 0.3));
    }
    /* the pan, tipped on its edge against the pile */
    K.add('wood', boxRound(0.30, 0.06, 0.26, 0.02, 1), TRS(-0.34, LIFT + 0.10, -0.30, 0.5, 1, 1, 1, -0.5), C.tin);
    K.add('wood', boxRound(0.28, 0.16, 0.06, 0.02, 1), TRS(-0.37, LIFT + 0.16, -0.39, 0.5), C.tin);
    return { K, r: 0.46, h: L * Math.cos(lean) + 0.1 };
  },

  /* The A-board a shop wheels out. The chalked face is the only
     hand-lettering in the street and it is deliberately unreadable —
     three ruled lines and a price, which is what writing looks like at
     the distance you actually see one from. */
  sandwich(v, rng) {
    const K = new Kit(AO());
    const bw = 0.62, bh = 0.94, splay = 0.30;
    const wood = [BUILD.wood, mixHex(BUILD.wood, LAND.sand, 0.32), BUILD.woodDark][v];
    /* NOT BLACK. §7 forbids it, and a slate rendered at BRAND.ink is a
       hole punched in a Wind Waker frame — the first version of this
       read as a black slab from thirty metres. Real slate is a
       green-grey and it reads as darker than everything round it
       without ever being the darkest thing on screen. */
    const slate = mixHex(BRAND.ink, LAND.grassShade, 0.30);
    const chalk = mixHex(BRAND.paper, BUILD.stucco, 0.30);
    /* ONE MATRIX PER LEAF — the same lesson as the escooter. Splaying
       each part with its own rx tilts the part about its own centre
       and leaves the chalk floating off the face it is written on (and
       the first version splayed them the wrong way, giving a V rather
       than an A). A leaf is built flat in its own frame, chalk and
       all, and then stood up. */
    const leaf = (sz) => {
      const M = TRS(0, bh / 2 + 0.03, sz * 0.10, 0, 1, 1, 1, -sz * splay);
      const put = (g, m, c) => K.add('wood', g, new THREE.Matrix4().multiplyMatrices(M, m), c);
      put(boxRound(bw + 0.10, bh + 0.10, 0.05, 0.02, 1), TRS(0, 0, 0), wood);
      put(boxRound(bw, bh * 0.88, 0.02, 0, 1), TRS(0, 0, sz * 0.035), slate);
      if (sz < 0) return;
      /* the chalk, on the leaf that faces the street: a heading, two
         ruled lines and a price. Deliberately unreadable — that is
         what writing looks like from the distance you see one from. */
      put(boxRound(bw * 0.62, 0.070, 0.030, 0, 1), TRS(0, bh * 0.30, 0.052), chalk);
      for (let i = 0; i < 2; i++) {
        put(boxRound(bw * (0.52 - i * 0.14), 0.050, 0.030, 0, 1), TRS(-bw * 0.04, bh * (0.09 - i * 0.13), 0.052), shadeHex(chalk, 0.86));
      }
      put(boxRound(bw * 0.26, 0.11, 0.030, 0, 1), TRS(bw * 0.14, -bh * 0.22, 0.052), BRAND.token);
      /* the chalk stub on the ledge, and the dust it has left */
      put(boxRound(bw + 0.06, 0.05, 0.10, 0, 1), TRS(0, -bh * 0.50, 0.06), shadeHex(wood, 0.86));
      put(boxRound(0.10, 0.050, 0.050, 0, 1), TRS(bw * 0.28, -bh * 0.50 + 0.04, 0.075, 0.4), chalk);
    };
    leaf(1); leaf(-1);
    /* the hinge rail and the cord that stops it splaying flat */
    K.add('wood', cyl(0.018, 0.018, bw + 0.06, 4, true), TRS(0, bh + 0.02, 0, 0, 1, 1, 1, 0, PI / 2), shadeHex(wood, 0.8));
    K.add('wood', cyl(0.008, 0.008, 0.34, 4, true), TRS(0, 0.24, 0, 0, 1, 1, 1, PI / 2), C.hay);
    return { K, r: 0.42, h: bh + 0.12 };
  },

  /* THE SEAM MARKER. Two districts meet along a line nothing in the
     world draws, and a fingerpost is what a real town puts there: a
     leaning post, two painted arms pointing opposite ways down the
     lane, a milestone at the foot with the distance cut into it and
     forty years of lichen on the north face. Placed by construction on
     the boundary itself — see the seam pass in city.js. */
  fingerpost(v, rng) {
    const K = new Kit(AO());
    const H = 2.35;
    const wood = mixHex(BRAND.paper, LAND.sand, 0.26 + v * 0.12);
    const post0 = mixHex(BUILD.woodDark, BRAND.paper, 0.34);
    K.add('wood', post(0.075, H, 0.014, 6), TRS(0, H / 2, 0, 0, 1, 1, 1, 0.03, 0.035), post0);
    K.add('wood', sphereG(0.10, 6), TRS(0.08, H + 0.03, 0), post0);
    K.add('wood', coneG(0.075, 0.14, 6), TRS(0.085, H + 0.13, 0), post0);
    /* two arms, one above the other, pointing opposite ways — the
       lower one droops a little, because they all do */
    for (const [i, sx] of [[0, 1], [1, -1]]) {
      const ay = H - 0.24 - i * 0.30;
      const g = boxRound(0.86, 0.16, 0.045, 0, 1);
      K.add('wood', g, TRS(sx * 0.43, ay, 0, 0, 1, 1, 1, 0, sx * (0.04 + i * 0.05)), wood);
      /* the pointed end */
      K.add('wood', coneG(0.085, 0.16, 4), TRS(sx * 0.90, ay, 0, 0, 1, 1.0, 0.28, 0, sx * (PI / 2)), wood);
      /* the painted lettering: one bar per word */
      for (let k = 0; k < 2; k++) {
        K.add('wood', boxRound(0.24 - k * 0.07, 0.055, 0.030, 0, 1),
          TRS(sx * (0.26 + k * 0.30), ay + 0.02, 0.030, 0, 1, 1, 1, 0, sx * 0.04), BRAND.ink);
      }
    }
    /* the milestone, half sunk, lichened on one face */
    K.add('stone', boxRound(0.30, 0.44, 0.20, 0.07, 1), TRS(0.34, 0.16, 0.26, 0.4), C.stoneWarm);
    K.add('stone', boxRound(0.24, 0.12, 0.055, 0, 1), TRS(0.34, 0.28, 0.36, 0.4), shadeHex(C.stoneWarm, 0.7));
    K.add('stone', boxRound(0.26, 0.14, 0.16, 0.05, 1), TRS(0.33, 0.30, 0.21, 0.4), mixHex(C.stoneWarm, LAND.grassShade, 0.34));
    return { K, r: 0.34, h: H + 0.2 };
  },

  /* ==================================================================
     STRUNG — the only new thing in this file that MOVES, and it moves
     for the price of a vertex shader rather than a cloth solver.

     v0 is a run of bunting; v1 is a line of washing. Both are hung
     between two fixed points ABOVE head height, which is what makes
     them free: nothing overhead needs a collider, so they add nothing
     to phys, and their triangles are in the flap material's own
     InstancedMesh rather than a per-cloth mesh with a per-cloth solver.

     Modelled growing UP from the cord at local y = 0 and hung by
     multiplying the placement matrix by FLAP_HANG. The cord bows +y
     here so that it sags once it is rolled over.
     ================================================================== */
  strung(v, rng) {
    const K = new Kit(() => 0.95);
    const W = 5.2, sag = 0.42;
    /* the cord, four segments of catenary */
    const cordAt = (t) => Math.sin(t * PI) * sag;
    for (let i = 0; i < 4; i++) {
      const t0 = i / 4, t1 = (i + 1) / 4;
      const x0 = -W / 2 + W * t0, x1 = -W / 2 + W * t1;
      const y0 = cordAt(t0), y1 = cordAt(t1);
      const len = Math.hypot(x1 - x0, y1 - y0);
      K.add('flap', cyl(0.020, 0.020, len, 4, false),
        TRS((x0 + x1) / 2, (y0 + y1) / 2, 0, 0, 1, 1, 1, 0, PI / 2 - Math.atan2(y1 - y0, x1 - x0)),
        /* NOT PALE STRAW. A 3 cm cord in C.hay came back from the
           Market Hall as a bright white wire drawn across a shopfront:
           at that thickness the outline hull is most of the object and
           a pale albedo makes the whole thing glow. Tarred line. */
        mixHex(C.hay, BUILD.woodDark, 0.52));
    }
    if (v === 0) {
      /* BUNTING: eleven pennants, four colours, none of them square to
         the cord. One triangle each. */
      const pal = [BUILD.awning, C.canvasCrm, BUILD.awningAlt, BRAND.token, mixHex(BRAND.good, BRAND.paper, 0.3)];
      for (let i = 0; i < 11; i++) {
        const t = (i + 0.5) / 11;
        K.add('flap', pennantG(0.26, 0.36), TRS(-W / 2 + W * t, cordAt(t) + 0.02, 0, (i % 3 - 1) * 0.16, 1, 1, 1, 0, (i % 5 - 2) * 0.06), pal[i % pal.length]);
      }
    } else {
      /* WASHING: five garments, pegged, and a gap where one came in */
      const pal = [C.canvasCrm, mixHex(BUILD.awningAlt, BRAND.paper, 0.5), BRAND.paper,
        mixHex(BUILD.awning, BRAND.paper, 0.42), mixHex(LAND.grassLit, BRAND.paper, 0.5)];
      const wid = [0.62, 0.46, 0.70, 0.40, 0.56];
      const hgt = [0.74, 0.52, 0.80, 0.44, 0.62];
      let x = -W / 2 + 0.42;
      for (let i = 0; i < 5; i++) {
        const t = (x + W / 2) / W;
        K.add('flap', sheet(wid[i], hgt[i]), TRS(x, cordAt(t) + 0.01, 0, (i % 2 ? 0.06 : -0.05)), pal[i]);
        /* two pegs each, which is what makes it read as hung rather
           than as coloured rectangles floating under a string */
        for (const sx of [-1, 1]) {
          K.add('flap', boxRound(0.055, 0.11, 0.055, 0, 1), TRS(x + sx * wid[i] * 0.42, cordAt(t) - 0.01, 0.012), BUILD.wood);
        }
        x += wid[i] + (i === 2 ? 0.55 : 0.24);
      }
    }
    return { K, r: W * 0.5, h: 1.0, air: true };
  },
};

/* ------------------------------------------------------------------
   SOLIDITY.

   Every prop above is a thing you can see and therefore a thing you
   must not walk through — the shipped bug was that not one of them was
   registered with ctx.phys, so the whole catalogue was scenery you
   could stand inside. A bin. A bench. A shipping container.

   THE FOOTPRINT IS MEASURED, NOT TYPED IN. The default collider is the
   bounding box of the prop's OWN merged geometry, taken once per type
   at build time, so it can never drift away from the art the way a
   hand-copied table does. Only two kinds of prop need an override:

     * ones whose silhouette is mostly soft — a lamp's lantern head, a
       potted plant's leaves, a market crate's heap of veg. You should
       be able to brush the greenery and be stopped by the pot.
     * ones that are round. A square box circumscribing a barrel stops
       you 40% of a radius short of it at the corners, which reads as an
       invisible wall; inscribing it lets you stand inside the staves.
       0.90 of the radius splits the difference: at most 3 cm of overlap
       on the flats, 9 cm of air at the corners, neither of them visible.

   `top` clamps the collider's height, and every collider is capped at
   SOLID_TOP again on top of that.

   THE CAP IS NOT ONLY A SAVING. Nothing above the capsule's 1.62 m
   crown can ever be touched by the character, so a 4.3 m lamp post
   that collides to 1.7 m is identical to play — but the collision world
   is not read only by the character. core/camera.js scores its resting
   azimuth by raycasting ctx.phys from the subject's chest to the boom,
   and the first version of this pass, which collided lamps to 1.9 m and
   containers to their full 2.5 m, silently moved that azimuth 40
   degrees and broke tools/drifttest.mjs. A collider taller than the
   thing that has to walk around it is not describing collision, it is
   editing somebody else's camera.

   `base` is pushed below zero so a prop standing on a slope never
   leaves a gap between its box and the ground under it.
   ------------------------------------------------------------------ */
const SOLID_BASE = -0.22;
/* the controller capsule is 1.62 m; 0.10 of slack for the solver skin */
export const SOLID_TOP = 1.72;
const SOLID = {
  crate: {},
  barrel: { round: 1 },
  bench: {},
  /* the post and its base plate — the lantern is out of reach */
  lamp: { hx: 0.21, hz: 0.21 },
  bin: { round: 1 },
  /* body and bed. The draught shafts are a 5 cm pole 2 m out in front,
     and colliding them would lay a tripwire across the market. */
  cart: { hx: 0.82, hz: 1.14, top: 1.40 },
  bike: { hx: 0.28, hz: 0.92, top: 1.05 },
  /* the crate. The heap of produce on top of it is soft. */
  produce: { hx: 0.43, hz: 0.43, top: 0.66 },
  /* the pot. The foliage above it is soft. */
  plant: { hx: 0.38, hz: 0.38, top: 0.60 },
  hedge: {},
  fence: { hz: 0.12 },
  bollard: { round: 1 },
  hay: { round: 1 },
  container: {},
  orecart: { hx: 0.66, hz: 0.82, top: 1.08 },

  /* --- the district set. Same two rules as above: round things are
     inscribed, and anything whose silhouette is mostly soft collides
     to the hard thing underneath it. --- */
  tyres: { round: 1 },
  gasbottle: {},
  postbox: { round: 1 },
  newsbox: {},
  /* the frame; the board itself is a thin sheet you brush past */
  chalkboard: { hz: 0.26 },
  bookbarrow: { hx: 0.50, hz: 0.38, top: 0.86 },
  pallets: {},
  sacks: { round: 1, top: 0.80 },
  churn: {},
  /* the tub. The standpipe over it is out of the way. */
  trough: { top: 0.60 },
  cabledrum: { round: 1 },
  oildrum: {},
  ropecoil: { round: 1, top: 0.42 },
  lobsterpot: {},
  /* the two decks; the handlebars are at chest height and soft */
  escooter: { top: 0.40 },
  /* the trough. The grasses are grass. */
  techplanter: { top: 0.62 },
  barrier: { hz: 0.34 },
  turnstile: { round: 1 },
  /* the plinth and the bowl; the planting on top is soft */
  urn: { hx: 0.32, hz: 0.32, top: 1.40 },
  topiary: { round: 1, top: 0.60 },

  /* --- the mid-use set ---
     The swept pile, the ball and the chalk trail are all shorter than
     the controller's 0.35 m step offset, so a collider on them would
     be a box the capsule steps over without ever testing. What is
     collided here is the part you could actually walk into: the
     broom's head and handle, the A-board's frame, the fingerpost and
     its milestone. */
  broom: { hx: 0.17, hz: 0.17, top: 1.05 },
  sandwich: { hz: 0.24 },
  fingerpost: { hx: 0.34, hz: 0.34, top: 1.30 },
  /* `strung` is deliberately absent: bunting and washing are hung at
     2.9 m and up, a metre clear of the 1.72 m the capsule can reach,
     so the only collider it could have is one nothing can ever touch. */
};

/**
 * Local-space collider for one prop type: measure the built geometry,
 * then apply the type's override. Returns FULL extents plus the centre
 * offset in the prop's own frame, so the instance matrix can carry the
 * yaw and the scale jitter untouched.
 */
function solidFor(type, meshes) {
  const o = SOLID[type];
  if (!o) return null;
  const bb = new THREE.Box3();
  const tmp = new THREE.Box3();
  for (const m of meshes) {
    m.geometry.computeBoundingBox();
    if (m.geometry.boundingBox) bb.union(tmp.copy(m.geometry.boundingBox));
  }
  if (bb.isEmpty() || !Number.isFinite(bb.min.x)) return null;
  const k = o.round ? 0.90 : 1;
  const hx = o.hx ?? ((bb.max.x - bb.min.x) * 0.5 * k);
  const hz = o.hz ?? ((bb.max.z - bb.min.z) * 0.5 * k);
  const cx = o.hx != null ? 0 : (bb.max.x + bb.min.x) * 0.5;
  const cz = o.hz != null ? 0 : (bb.max.z + bb.min.z) * 0.5;
  const top = Math.min(o.top ?? Infinity, bb.max.y, SOLID_TOP);
  if (!(top > 0.12) || hx < 0.02 || hz < 0.02) return null;
  return { sx: hx * 2, sz: hz * 2, sy: top - SOLID_BASE, cx, cy: (top + SOLID_BASE) * 0.5, cz };
}

/* ------------------------------------------------------------------
   Contact shadow — one instanced multiply decal for the whole city.

   The geometry is a shallow dome: a centre vertex lifted, two rings,
   and a rim pushed under the ground. Only x and z are scaled by the
   instance matrix, so the vertical profile is the same absolute
   half-metre whatever the prop's footprint is — which is what makes it
   robust against the terrain LOD error that buried the flat version.
   ------------------------------------------------------------------ */
function shadowDomeGeometry(seg = 14) {
  const pos = [0, 0.26, 0], uv = [0.5, 0.5], idx = [];
  const rings = [[0.24, 0.13], [0.38, -0.06], [0.5, -0.44]];
  for (let r = 0; r < rings.length; r++) {
    const [rad, y] = rings[r];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * PI * 2;
      const cx = Math.cos(a) * rad, cz = Math.sin(a) * rad;
      pos.push(cx, y, cz);
      uv.push(0.5 + cx, 0.5 + cz);
    }
  }
  for (let i = 0; i < seg; i++) idx.push(0, 1 + ((i + 1) % seg), 1 + i);
  for (let r = 0; r < rings.length - 1; r++) {
    const a0 = 1 + r * seg, b0 = a0 + seg;
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      idx.push(a0 + i, a0 + j, b0 + i, a0 + j, b0 + j, b0 + i);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function contactShadowMaterial(ctx) {
  const col = new THREE.Color().setHex(SHADOW.contact, THREE.SRGBColorSpace);
  return new THREE.ShaderMaterial({
    name: 'city.contact',
    uniforms: { uColor: { value: col }, uStrength: { value: 0.55 } },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 wp = vec4( position, 1.0 );
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
        #endif
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uStrength;
      varying vec2 vUv;
      void main() {
        float d = length( vUv - 0.5 ) * 2.0;
        /* wide and feathered — §7 forbids hard-edged contact shadows */
        float a = smoothstep( 1.0, 0.15, d );
        a *= a * uStrength;
        gl_FragColor = vec4( mix( vec3( 1.0 ), uColor, a ), 1.0 );
      }`,
    blending: THREE.MultiplyBlending,
    premultipliedAlpha: true,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
}

/* ------------------------------------------------------------------
   The prop system.

   SPATIAL CHUNKING. Every prop type used to become exactly one
   InstancedMesh holding all of its instances island-wide. That is the
   right call count and completely the wrong bounding volume: a single
   `prop.crate.wood` spanning a 970 m island has a 430 m bounding
   sphere, so it intersects EVERY frustum in the game and is therefore
   never culled by anything. Its 183 600 triangles were being submitted
   once for the depth prepass, once for the main pass, twice more for
   the outline hull, and once for each of the four shadow cascades —
   eight full copies of every crate on the island, every frame, most of
   them behind the camera.

   Instances are bucketed into CELL-metre cells instead. A cell's
   bounding sphere is a fraction of the island, so three's own frustum
   test throws away the ones that are not on screen and each shadow
   cascade only pays for the props that are actually inside it.

   HOW BIG A CELL SHOULD BE IS A PRICE, AND THE PRICE MOVED. A cell is
   bought with a draw call and paid for in triangles that get submitted
   when only part of the cell is on screen, so the right size is
   wherever those two meet. Measured in the Main Street fly-to at
   1600x900 on an M1 Max, with the depth prepass gone:

     one draw call        ~3.0 us   (marginal, main + hulls + cascades)
     one thousand tris    ~0.064 us (7.1 M tris -> 68 k moved the whole
                                     frame by 0.45 ms, and halving the
                                     resolution moves it by 0.3)

   which puts the break-even at roughly FORTY THOUSAND triangles per
   cell. At 48 m a crate cell held about nine thousand, so the split
   was costing four draw calls to save a fifth of one call's worth of
   geometry — the bucketing had been tuned when the frame still drew
   every prop eight times (depth prepass, main, two hull passes, four
   cascades) and that frame no longer exists. 144 m keeps a bounding
   sphere near 100 m, which still culls most of a 970 m island and
   still keeps the far half of the town out of the cascades, while
   cutting the prop mesh count by about nine.

   Measured effect on the city frame: 1013 draw calls -> 890, and the
   triangles that buys back are inside the noise. */
const CELL = 144;
const cellKey = (m) => `${Math.floor(m.elements[12] / CELL)},${Math.floor(m.elements[14] / CELL)}`;
const _offM = new THREE.Matrix4();

export function createProps(ctx, lib, rng) {
  const group = new THREE.Group();
  group.name = 'city.props';
  const requests = new Map();      // `${type}#${variant}` -> [{m, r}]
  const built = [];
  const shadowList = [];
  let shadowMesh = null;
  const lampMeshes = [];
  /* one record per INSTANCE — never one per batch. See registerColliders. */
  const colliders = [];
  const colliderIds = [];

  function add(type, m4, opt = {}) {
    if (!CATALOGUE[type]) return;
    /* two variants, not three: every extra variant is another
       InstancedMesh per material family, and the frame budget notices */
    const explicit = opt.variant != null;
    const v = explicit ? Math.min(opt.variant, 2) : Math.floor(rng() * 2) % 2;
    const key = `${type}#${v}`;
    if (!requests.has(key)) requests.set(key, []);
    requests.get(key).push({ m: m4, shadow: opt.shadow !== false, explicit });
  }

  /* ----------------------------------------------------------------
     A VARIANT NOBODY CAN SEE IS A DRAW CALL FOR NOTHING.

     Every `type#variant` becomes one InstancedMesh per material family
     per cell, and the split is bought so that two of a thing standing
     near each other are not the same object twice. That argument is
     about DENSITY, and it stops being true at the bottom of the
     catalogue: there are eight cattle troughs on a 970 m island, in
     three material families, and splitting them across two variants
     cost six meshes — twelve draw calls with their outline hulls — to
     make a difference between two objects that are never in frame
     together, and in most cases are two districts apart.

     Measured over the built city, twenty-one types are under the
     threshold; collapsing their randomly-chosen variants recovers
     eighteen meshes. An EXPLICIT variant is never collapsed: the port
     yard alternates container colours down a stack on purpose, and
     Golden Heights' lamps are gilt on purpose. Both of those are
     compositions, not variety, and both stay.
     ---------------------------------------------------------------- */
  const MIN_SPLIT = 18;
  function collapseVariants() {
    const perType = new Map();
    for (const [key, list] of requests) {
      const t = key.slice(0, key.indexOf('#'));
      perType.set(t, (perType.get(t) || 0) + list.length);
    }
    let saved = 0;
    for (const [key, list] of [...requests]) {
      const i = key.indexOf('#');
      const t = key.slice(0, i);
      if (key.slice(i + 1) === '0' || perType.get(t) >= MIN_SPLIT) continue;
      const move = list.filter((it) => !it.explicit);
      if (!move.length) continue;
      const keep = list.filter((it) => it.explicit);
      const k0 = `${t}#0`;
      if (!requests.has(k0)) requests.set(k0, []);
      requests.get(k0).push(...move);
      if (keep.length) requests.set(key, keep); else { requests.delete(key); saved++; }
    }
    return saved;
  }

  function build() {
    const collapsed = collapseVariants();
    for (const [key, list] of requests) {
      const [type, vs] = key.split('#');
      const v = +vs;
      let spec;
      try { spec = CATALOGUE[type](v, rng); }
      catch (e) { console.warn('[city] prop failed', type, e); continue; }
      const meshes = lib.meshes(spec.K, `prop.${type}.${v}`);

      /* bucket this type's instances by world cell */
      const cells = new Map();
      for (const it of list) {
        const k = cellKey(it.m);
        let c = cells.get(k);
        if (!c) { c = []; cells.set(k, c); }
        c.push(it);
      }
      /* A cell holding a handful of crates is a draw call that buys
         nothing, so sweep the stragglers into a single leftover mesh
         rather than emitting a chunk each. The threshold rose with the
         cell size for the same reason the cell size did: below about a
         dozen instances a chunk cannot hold enough triangles to be
         worth its own submission. */
      const spare = [];
      for (const [k, c] of [...cells]) {
        if (c.length < 12) { spare.push(...c); cells.delete(k); }
      }
      if (spare.length) cells.set('spare', spare);

      for (const proto of meshes) {
        for (const [k, c] of cells) {
          const im = new THREE.InstancedMesh(proto.geometry, proto.material, c.length);
          im.name = `${proto.name}@${k}`;
          im.castShadow = true;
          im.receiveShadow = true;
          for (let i = 0; i < c.length; i++) im.setMatrixAt(i, c[i].m);
          im.instanceMatrix.needsUpdate = true;
          im.computeBoundingSphere();
          group.add(im);
          built.push(im);
          if (proto.userData.family === 'lamp') lampMeshes.push(im);
          ctx.mat.register(im, { outline: proto.userData.family !== 'lamp' });
        }
        /* the protos are templates only — the instanced copies own the
           geometry from here on */
        proto.geometry.userData.shared = true;
      }
      /* ONE COLLIDER PER INSTANCE, NOT ONE PER BATCH.

         The instances above are bucketed into shared InstancedMeshes,
         and the tempting shortcut — hand phys the batch and let it take
         a bounding volume — is the same mistake that once gave a single
         crate mesh a 424 m bounding sphere. A batch's bounds are the
         hull of everything in it and describe nothing you can touch. So
         the collider is built from each instance's own matrix, and the
         only thing shared is the twelve-triangle unit box inside phys.  */
      const solid = solidFor(type, meshes);
      if (solid) {
        for (const it of list) {
          const m = new THREE.Matrix4().copy(it.m);
          if (solid.cx || solid.cy || solid.cz) {
            m.multiply(_offM.makeTranslation(solid.cx, solid.cy, solid.cz));
          }
          colliders.push({ type, sx: solid.sx, sy: solid.sy, sz: solid.sz, m });
        }
      }

      /* one contact decal per instance, sized to the footprint.
         `air` types never get one: a bunting run's contact with the
         ground is a shadow of a thing three metres over it, and the
         decal is a ground-contact darkening, not a cast shadow. */
      for (const it of list) {
        if (!it.shadow || spec.air) continue;
        const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
        it.m.decompose(p, q, s);
        shadowList.push({ x: p.x, y: p.y, z: p.z, r: spec.r * 2.3 * Math.max(s.x, s.z) });
      }
    }
    if (shadowList.length) {
      /* A FLAT DECAL 3.5 cm OVER heightAt() IS A DECAL NOBODY SEES.
         terrain.js draws its tiles at four LODs and a coarse tile
         box-filters the raster, so the ground you can see runs up to a
         quarter of a metre above what heightAt() reports even close to
         the camera — every one of these was lying under it, which is
         why the judges could say there is "no contact shadow anywhere"
         while the city was drawing one under every crate in it.

         So the decal is a shallow DOME, not a plane: high in the middle,
         its rim driven below the ground. Whatever the drawn surface is
         doing, the dome breaks through it, and the darkening that shows
         is the part nearest the object — which is the part that matters. */
      const geo = shadowDomeGeometry();
      shadowMesh = new THREE.InstancedMesh(geo, contactShadowMaterial(ctx), shadowList.length);
      shadowMesh.name = 'city.contactShadows';
      shadowMesh.castShadow = false;
      shadowMesh.receiveShadow = false;
      shadowMesh.userData.noPrepass = true;
      shadowMesh.userData.noOutline = true;
      shadowMesh.renderOrder = 2;
      const m = new THREE.Matrix4();
      for (let i = 0; i < shadowList.length; i++) {
        const s = shadowList[i];
        const gy = ctx.world?.heightAt ? ctx.world.heightAt(s.x, s.z) : s.y;
        m.compose(
          new THREE.Vector3(s.x, Math.max(gy, s.y) - 0.02, s.z),
          new THREE.Quaternion(),
          new THREE.Vector3(s.r, 1, s.r),
        );
        shadowMesh.setMatrixAt(i, m);
      }
      shadowMesh.instanceMatrix.needsUpdate = true;
      shadowMesh.computeBoundingSphere();
      group.add(shadowMesh);
    }
    requests.clear();
    if (collapsed) console.log(`[city] ${collapsed} prop variant meshes collapsed (under ${MIN_SPLIT} island-wide)`);
    return group;
  }

  /* ----------------------------------------------------------------
     Shadow range. The cascade set only covers `far` metres (see
     SHADOW_FAR in render/renderer.js) and csm.js fades the last 18 %
     of that to nothing, so a chunk further away than the cascade set
     reaches cannot put a single texel on screen — but three would
     still happily rasterise it into cascade 3, which is fitted to a
     150 m sphere. One distance test per chunk per LOD tick removes it.
     ---------------------------------------------------------------- */
  const _c = new THREE.Vector3();
  function cullShadows(camPos, far) {
    const lim = far + 24;                 // slack for a long raking shadow
    for (const m of built) {
      const bs = m.boundingSphere;
      if (!bs) continue;
      _c.copy(bs.center).applyMatrix4(m.matrixWorld);
      m.castShadow = _c.distanceTo(camPos) - bs.radius < lim;
    }
  }

  /**
   * Hand every instance's oriented box to ctx.phys.
   *
   * Called once, from city.js's wirePhysics, because the world stage
   * boots BEFORE the physics stage and ctx.phys does not exist while
   * build() is running. `skip(x, z, type)` lets the caller veto a
   * collider — city.js uses it to keep doorway approaches clear.
   */
  function registerColliders(phys, skip) {
    if (!phys || !phys.addOBB || colliderIds.length) return 0;
    for (const c of colliders) {
      const e = c.m.elements;
      if (skip && skip(e[12], e[14], c.type)) continue;
      colliderIds.push(phys.addOBB(c.sx, c.sy, c.sz, c.m, { name: `prop.${c.type}`, prop: true }));
    }
    return colliderIds.length;
  }

  return {
    group, add, build, cullShadows, registerColliders,
    get colliders() { return colliders; },
    get colliderCount() { return colliderIds.length; },
    get count() { return built.reduce((a, m) => a + m.count, 0); },
    get meshes() { return built; },
    dispose() {
      const geos = new Set();
      for (const m of built) geos.add(m.geometry);
      for (const g of geos) g.dispose();
      shadowMesh?.geometry.dispose();
      shadowMesh?.material.dispose();
    },
  };
}

export const PROP_TYPES = Object.keys(CATALOGUE);

/* The factories themselves, so a triangle budget can be MEASURED off
   the real geometry rather than counted by hand off the source. Every
   per-instance number quoted in this file was got by importing this in
   node, building the kit and reading Builder.triangles — which is how
   the lamp's hidden inner bulb was found. */
export { CATALOGUE as PROP_CATALOGUE };

/**
 * Plan-view radius of each prop, for callers that have to decide WHERE
 * to put one before anything has been built. It mirrors the `r` each
 * CATALOGUE factory reports; the factories cannot be asked for it at
 * placement time because running one builds its geometry.
 *
 * city.js uses this to keep prop bodies out of doorway approaches. That
 * has to be a placement decision rather than a collision one: refusing
 * a container its collider would leave a 5 m box you can walk through,
 * which is the exact bug this whole pass exists to kill.
 */
export const PROP_FOOTPRINT = {
  crate: 0.69, barrel: 0.41, bench: 1.00, lamp: 0.42, bin: 0.37,
  cart: 1.30, bike: 0.62, produce: 0.64, plant: 0.50, hedge: 1.38,
  fence: 1.32, bollard: 0.32, hay: 0.80, container: 2.86, orecart: 0.95,
  /* the district set */
  tyres: 0.55, gasbottle: 0.52, postbox: 0.36, newsbox: 0.55,
  chalkboard: 0.72, bookbarrow: 0.60, pallets: 0.72, sacks: 0.62,
  churn: 0.52, trough: 1.05, cabledrum: 0.86, oildrum: 0.72,
  ropecoil: 0.62, lobsterpot: 0.52, escooter: 0.86, techplanter: 0.88,
  barrier: 1.09, turnstile: 0.62, urn: 0.44, topiary: 0.50,
  /* the mid-use set. `strung` is hung overhead and is never offered to
     the doorway guard — bunting over a shop door is the point of it. */
  broom: 0.42, sandwich: 0.42, fingerpost: 0.55, strung: 2.60,
};
