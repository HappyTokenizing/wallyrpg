/* ============================================================
   life.js — evidence that somebody was just here.

   THE OBSERVATION THIS FILE EXISTS FOR. After the district pass the
   city was correctly furnished and still read as a set: everything in
   it was in its resting state, arranged, and — measured off ten
   doorstep frames — essentially all of it stood between the ground and
   the knee. A street that is furnished only at ankle height is a
   street nobody lives above.

   So this file adds two things the prop catalogue structurally cannot:

     VERTICALITY. Window boxes, hanging baskets, pigeons on an eave,
     a nest in a corner, a bicycle hung on a wall, chalk at child
     height. All of it between 0.4 m and the eaves, which is the band
     the eye actually travels when you walk down a street.

     ONE-OFFS. Five objects that exist exactly once on the island, each
     in a different district, each somewhere a player has a reason to
     stand. A thing you meet forty times is set dressing. A thing you
     meet once is a memory.

   WHY IT IS FREE. Every piece here is written into the building's OWN
   Kit, between buildings.js handing city.js the kit and city.js
   merging it — so it lands inside the four-to-six meshes that building
   was always going to draw. It adds no draw call, it is frustum-culled
   with its building, and it vanishes with it at silhouette LOD. The
   only cost is triangles, and the whole facade set is under 500 of
   them per building.

   THE ONE RULE that makes that true: NOTHING HERE MAY INTRODUCE A
   MATERIAL FAMILY ITS HOST DOES NOT ALREADY HAVE. A Kit builds one
   mesh per family, so a hanging basket that reaches for `hedge` on a
   building whose kit has no foliage in it would cost that building a
   whole extra InstancedMesh — 28 of them across the city, twice that
   with outline hulls. fam() below resolves every request against what
   the host actually carries and falls back to `wall`, which the
   founding berm guarantees on every building in the game.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { BUILD, LAND, BRAND, SEA, SKY } from '../core/palette.js';
import { clamp } from '../core/contracts.js';
import {
  Kit, boxRound, cyl, post, sphereG, coneG, torusG, TRS, mixHex, shadeHex, C,
} from './kits.js';

const PI = Math.PI;
/* The instruments are on a roof or on a mast, where the ground-based
   AO baker's "darken everything under 0.9 m" would blacken the whole
   object: they get a flat, slightly-lifted term instead. */
const AO_FLAT = () => 0.92;

/* ------------------------------------------------------------------
   THE OUTLINE STROKE IS THE FLOOR ON DETAIL SIZE, AND IT COST THIS
   FILE A WHOLE ROUND TO LEARN.

   §2.2's inverted hull is an expansion along the normals sized to land
   at ~1.6 px on screen, which for the city materials is an
   outlineWidth of 3.0-3.6. It is drawn from the object's own albedo
   darkened 55 %. On anything with real bulk that is a stroke. On
   anything THINNER than the stroke, the two hull faces meet in the
   middle and the object stops being an object and becomes a dark
   smear — and if two such parts are near each other, the smears merge
   and the pair becomes one black patch.

   The first version of this file had 2 cm chalk lines on a wall, 1.2 cm
   basket chains and 3 cm bicycle tubes. Photographed from a settled
   capsule at the apartment doorstep, the chalk was a black rectangle
   with pale scratches in it, the basket was a black dot and the bike
   was a black smudge — every one of them measured right in the source
   and wrong on the screen.

   So: nothing in the life set is thinner than THIN_MIN in any
   dimension you can see it across, and the pieces that cannot obey
   that (chalk writing, bicycle spokes) were replaced with pieces that
   can. This is the same line kits.js draws at 0.13 m for chamfers and
   props.js draws at 0.20 m for its own, read from the other side.
   ------------------------------------------------------------------ */
const THIN_MIN = 0.05;

/**
 * Resolve a wanted material family against what this kit actually has.
 * See "THE ONE RULE" above. `wall` is the guaranteed fallback: every
 * building in the game gets a founding berm or a paved disc, and both
 * are built in the stone/wall builder.
 */
function famOf(K, want) {
  const alias = want === 'woodH' ? 'wood' : want === 'stone' ? 'wall' : want;
  return K.parts.has(alias) ? want : 'wall';
}

/* ------------------------------------------------------------------
   The pieces. Every one is written in the building's local frame:
   +z is the front face, x runs along it, y is up from the founding
   line, and the caller has already worked out which band is safe.
   ------------------------------------------------------------------ */

/**
 * A pigeon, side-on. ~60 triangles.
 *
 * BUILT PALE ON PURPOSE. A realistic slate-grey pigeon at realistic
 * scale came back from the first photograph as a black bolt on the
 * gutter: the hull ate it. This one is a third bigger than a real
 * bird, its body is near-white so the darkened hull reads as an
 * outline rather than as the whole object, and only the head is dark —
 * which is also what makes it read as a bird rather than as a lump.
 */
function pigeon(K, f, x, y, z, ry, body, head) {
  K.add(f, sphereG(0.105, 7), TRS(x, y + 0.10, z, ry, 1.0, 0.95, 1.35), body);
  K.add(f, sphereG(0.062, 6), TRS(x + Math.sin(ry) * 0.10, y + 0.185, z + Math.cos(ry) * 0.10, ry), head);
  K.add(f, coneG(0.026, 0.07, 4), TRS(x + Math.sin(ry) * 0.155, y + 0.175, z + Math.cos(ry) * 0.155, ry, 1, 1, 1, PI / 2), BRAND.warn);
  K.add(f, boxRound(0.075, 0.055, 0.15, 0.02, 1), TRS(x - Math.sin(ry) * 0.115, y + 0.115, z - Math.cos(ry) * 0.115, ry, 1, 1, 1, 0.35), shadeHex(body, 0.84));
}

/** A cat, curled, asleep. The only one on the island. ~150 triangles. */
function cat(K, f, x, y, z, ry, coat) {
  const dark = shadeHex(coat, 0.74);
  /* the curl: a flattened body ring with the tail brought round it */
  K.add(f, sphereG(0.16, 8), TRS(x, y + 0.10, z, ry, 1.25, 0.74, 1.0), coat);
  K.add(f, sphereG(0.112, 7), TRS(x + Math.cos(ry) * 0.14, y + 0.115, z - Math.sin(ry) * 0.14, ry, 1, 0.92, 1), coat);
  /* THE HEAD AND THE EARS ARE THE READ. Tucked as far down as a real
     sleeping cat tucks it, the head was inside the body silhouette and
     the whole animal photographed as a pale boulder on a shelf. It
     sits a little proud, and the ears stand up: two triangles above
     the line of the back is the entire difference between a cat and a
     stone at three metres. */
  K.add(f, sphereG(0.088, 6), TRS(x + Math.cos(ry) * 0.175, y + 0.125, z - Math.sin(ry) * 0.175, ry, 1, 0.92, 1), coat);
  K.add(f, sphereG(0.052, 5), TRS(x + Math.cos(ry) * 0.245, y + 0.105, z - Math.sin(ry) * 0.245, ry, 1, 0.9, 0.9), dark);
  for (const sx of [-1, 1]) {
    K.add(f, coneG(0.058, 0.105, 4), TRS(x + Math.cos(ry) * 0.155 + Math.sin(ry) * sx * 0.058, y + 0.205, z - Math.sin(ry) * 0.155 + Math.cos(ry) * sx * 0.058, ry, 1, 1, 1, 0.12, sx * 0.16), dark);
  }
  /* the tail, laid round the nose — the shape that says "asleep".
     Nothing under THIN_MIN: a 2 cm tail tip is a black bead. */
  for (let i = 0; i < 5; i++) {
    const a = ry + 1.5 + i * 0.42;
    K.add(f, sphereG(0.055 - i * 0.003, 5),
      TRS(x + Math.cos(a) * 0.195, y + 0.052, z - Math.sin(a) * 0.195, ry), i % 2 ? dark : coat);
  }
}

/** A swallow's nest: a mud cup wedged into a corner, with a rim. */
function nest(K, f, x, y, z, ry) {
  const mud = mixHex(LAND.dirt, BUILD.stucco, 0.25);
  K.add(f, sphereG(0.135, 6), TRS(x, y, z, ry, 1.0, 0.85, 0.75), mud);
  K.add(f, torusG(0.110, 0.050, 8, 4), TRS(x, y + 0.062, z - 0.012, 0, 1, 1, 1, PI / 2), shadeHex(mud, 0.88));
  K.add(f, sphereG(0.060, 5), TRS(x - 0.035, y + 0.085, z - 0.03, ry, 1, 0.8, 1), mixHex(C.hay, LAND.dirt, 0.3));
}

/** A planted window box on a pair of brackets. */
function windowBox(K, fw, fh, x, y, z, w, rng) {
  const trough = mixHex(BUILD.wood, BUILD.woodDark, 0.30);
  K.add(fw, boxRound(w, 0.24, 0.28, 0.05, 1), TRS(x, y, z + 0.16), trough);
  K.add(fw, boxRound(w + 0.06, 0.05, 0.32, 0.02, 1), TRS(x, y + 0.13, z + 0.16), shadeHex(trough, 0.88));
  for (const sx of [-1, 1]) {
    K.add(fw, boxRound(0.07, 0.22, 0.22, 0, 1), TRS(x + sx * (w * 0.42), y - 0.14, z + 0.10, 0, 1, 1, 1, 0.6), shadeHex(trough, 0.8));
  }
  /* the planting: a low mass with two flowers and one trailer that has
     got away over the front edge — the trailer is what stops it
     reading as a box with a green lid on it */
  const n = Math.max(3, Math.round(w * 3.4));
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    K.add(fh, sphereG(0.085 + (i % 2) * 0.02, 6),
      TRS(x - w * 0.42 + w * 0.84 * t, y + 0.17, z + 0.16 + ((i % 3) - 1) * 0.05, i * 1.1, 1.15, 0.8, 1.0),
      i % 3 ? C.leaf : mixHex(C.leaf, LAND.grassLit, 0.4));
  }
  for (let i = 0; i < 3; i++) {
    K.add(fh, sphereG(0.062, 5), TRS(x - w * 0.28 + w * 0.28 * i, y + 0.27, z + 0.20, 0, 1, 0.9, 1),
      [BUILD.awning, BRAND.token, BRAND.gem][i]);
  }
  K.add(fh, sphereG(0.075, 5), TRS(x + w * 0.30, y - 0.02, z + 0.28, 0, 0.85, 1.9, 0.85), mixHex(C.leaf, LAND.grassShade, 0.4));
  K.add(fh, sphereG(0.065, 5), TRS(x + w * 0.33, y - 0.22, z + 0.29, 0, 0.8, 1.7, 0.8), mixHex(C.leaf, LAND.grassShade, 0.55));
}

/** A hanging basket on a wall bracket. Nothing under THIN_MIN: the
    first version's 1.2 cm chain photographed as a black dot. */
function basket(K, fw, fh, x, y, z, sx) {
  K.add(fw, cyl(0.055, 0.055, 0.46, 5, true), TRS(x, y + 0.22, z + 0.03, 0, 1, 1, 1, 0, 0), C.lead);
  K.add(fw, cyl(0.050, 0.050, 0.34, 5, true), TRS(x, y + 0.44, z + 0.17, 0, 1, 1, 1, PI / 2), C.lead);
  K.add(fw, cyl(0.032, 0.032, 0.26, 4, true), TRS(x, y + 0.31, z + 0.31), C.lead);
  K.add(fw, cyl(0.20, 0.13, 0.17, 10, true), TRS(x, y + 0.10, z + 0.31), shadeHex(BUILD.wood, 0.8));
  K.add(fh, sphereG(0.20, 7), TRS(x, y + 0.18, z + 0.31, sx, 1.05, 0.72, 1.05), C.hedge);
  for (let i = 0; i < 4; i++) {
    const a = sx + i * 1.57;
    K.add(fh, sphereG(0.075, 5), TRS(x + Math.cos(a) * 0.12, y + 0.24, z + 0.31 + Math.sin(a) * 0.12, 0, 1, 0.85, 1),
      [BUILD.awning, BRAND.token, BRAND.gem, BRAND.paper][i]);
  }
  /* the trailing end, hanging below the basket */
  K.add(fh, sphereG(0.085, 5), TRS(x + 0.08, y - 0.05, z + 0.33, 0, 0.85, 2.0, 0.85), mixHex(C.leaf, LAND.grassShade, 0.45));
}

/**
 * A bicycle hung flat on a wall by its frame.
 *
 * NO SPOKES. A spoke is 2 mm of steel and there is no honest way to
 * draw one here: at any thickness the hull can render, three of them
 * inside a 0.6 m wheel merge into a black disc. A pale hub plate and a
 * dark tyre is what a bike reads as at four metres anyway, and it is
 * what the ground `bike` prop should probably learn from too.
 */
function wallBike(K, f, x, y, z, col) {
  for (const sx of [-1, 1]) {
    K.add(f, torusG(0.30, 0.055, 14, 4), TRS(x + sx * 0.46, y, z + 0.15, 0, 1, 1, 1, 0, 0), BRAND.ink);
    K.add(f, cyl(0.235, 0.235, 0.045, 12, true), TRS(x + sx * 0.46, y, z + 0.15, 0, 1, 1, 1, PI / 2), shadeHex(C.lead, 1.35));
    K.add(f, cyl(0.075, 0.075, 0.09, 7, true), TRS(x + sx * 0.46, y, z + 0.16, 0, 1, 1, 1, PI / 2), C.lead);
  }
  K.add(f, boxRound(0.86, 0.075, 0.075, 0.02, 1), TRS(x, y + 0.22, z + 0.17, 0, 1, 1, 1, 0, 0.10), col);
  K.add(f, boxRound(0.52, 0.070, 0.070, 0.02, 1), TRS(x - 0.10, y - 0.10, z + 0.17, 0, 1, 1, 1, 0, -0.62), col);
  K.add(f, boxRound(0.44, 0.070, 0.070, 0.02, 1), TRS(x + 0.22, y - 0.02, z + 0.17, 0, 1, 1, 1, 0, 0.85), col);
  K.add(f, boxRound(0.28, 0.085, 0.10, 0.03, 1), TRS(x - 0.28, y + 0.30, z + 0.17), BRAND.ink);
  /* the two hooks it is actually hanging on */
  for (const sx of [-1, 1]) K.add(f, torusG(0.070, 0.032, 6, 4), TRS(x + sx * 0.24, y + 0.34, z + 0.07, 0, 1, 1, 1, PI / 2), C.lead);
}

/**
 * A MEND. The brief asked for chalk on a wall and a repainted door in
 * a slightly wrong colour; the first of those is unbuildable here (see
 * THIN_MIN — a 2 cm chalk line photographed as part of a black
 * rectangle) and the second is the better half of the idea anyway.
 *
 * Three kinds, all with real volume:
 *   0  a repaint that stopped — a rectangle of newer, wrong-toned
 *      paint with the roller line still showing at its edge
 *   1  a rendered patch where the plaster came off, in fresh grey
 *      that nobody has got round to matching
 *   2  boards nailed over a window that is not being replaced
 *
 * The wrong tone is the whole point. A patch in the same colour is
 * invisible; a patch two steps off says somebody did this later, in a
 * hurry, with what they had.
 */
function mend(K, f, x, y, z, wall, kind, rng) {
  if (kind === 0) {
    const paint = mixHex(wall, rng() < 0.5 ? BUILD.awningAlt : LAND.grassShade, 0.20 + rng() * 0.14);
    const w = 1.15 + rng() * 0.5, h = 1.35 + rng() * 0.4;
    K.add(f, boxRound(w, h, 0.055, 0.02, 1), TRS(x, y + h * 0.5, z + 0.02), paint);
    /* the ragged top edge where the roller ran out */
    for (let i = 0; i < 3; i++) {
      K.add(f, boxRound(w * 0.30, 0.16 + (i % 2) * 0.09, 0.052, 0.02, 1),
        TRS(x - w * 0.32 + w * 0.32 * i, y + h + 0.05, z + 0.019), paint);
    }
  } else if (kind === 1) {
    const render = mixHex(BUILD.stone, BUILD.metal, 0.28);
    const w = 0.85 + rng() * 0.5, h = 0.95 + rng() * 0.35;
    K.add(f, boxRound(w, h, 0.07, 0.05, 2), TRS(x, y + h * 0.5, z + 0.015), render);
    K.add(f, boxRound(w * 0.55, h * 0.42, 0.085, 0.05, 2), TRS(x + w * 0.18, y + h * 0.78, z + 0.012), shadeHex(render, 0.94));
  } else {
    const board = mixHex(BUILD.wood, LAND.sand, 0.30);
    for (let i = 0; i < 3; i++) {
      K.add(f, boxRound(1.05, 0.22, 0.06, 0.02, 1),
        TRS(x, y + 0.35 + i * 0.30, z + 0.03, 0, 1, 1, 1, 0, (i - 1) * 0.035), i % 2 ? shadeHex(board, 0.9) : board);
    }
    K.add(f, boxRound(1.10, 0.20, 0.06, 0.02, 1), TRS(x, y + 0.65, z + 0.035, 0, 1, 1, 1, 0, 0.85), shadeHex(board, 0.82));
  }
}

/* ==================================================================
   THE FIVE ONE-OFFS.

   Each exists once in the game. Each is on a named location a player
   has a reason to walk to, in a different district, so that finding
   one is a thing that happens on its own day rather than five things
   that happen on one street.
   ================================================================== */
const ONCE = {
  /* RUSTY ROW — the cat. Asleep on the noodle cart's front shelf, out
     of the steam, on the side you approach from — because a one-off
     nobody can find is a one-off nobody has. */
  noodlecart(ctx, K, loc, meta, lift) {
    const f = famOf(K, 'wall');
    const fw = famOf(K, 'wood');
    /* ON THE STREET SIDE OF THE COUNTER, not behind it. The stall form
       is an open veranda and a shelf set inside it is a shelf the
       player walks past without ever seeing — which for the only cat
       in the game is the same as not having one. */
    const x = loc.size.w * 0.32, z = loc.size.d / 2 + 0.34, y = 1.06 + lift;
    K.add(fw, boxRound(0.80, 0.10, 0.56, 0.03, 1), TRS(x, y, z), mixHex(BUILD.wood, BUILD.woodDark, 0.4));
    for (const sx of [-1, 1]) {
      K.add(fw, boxRound(0.09, 0.24, 0.09, 0.02, 1), TRS(x + sx * 0.30, y - 0.16, z, 0, 1, 1, 1, 0, sx * 0.35), mixHex(BUILD.wood, BUILD.woodDark, 0.55));
    }
    /* a warm ginger-and-cream, so it is not the same grey as Wally */
    cat(K, f, x, y + 0.05, z, 1.4, mixHex(BRAND.paper, BUILD.awning, 0.26));
    return 'a cat asleep on the counter shelf';
  },

  /* MAIN STREET — the half-finished paint job. Somebody started on the
     door frame, got to lunch, and left the evidence: a dust sheet with
     a boot print in it, a pot with the brush laid across it, and the
     plank of test colours where they were choosing. */
  cafe(ctx, K, loc, meta, lift) {
    const fw = famOf(K, 'wood'), f = famOf(K, 'wall');
    const d = loc.size.d / 2, x = loc.size.w * 0.30, g = lift;
    const sheetCol = mixHex(BRAND.paper, LAND.dirt, 0.22);
    K.add(f, boxRound(1.5, 0.05, 1.1, 0.02, 1), TRS(x, g + 0.03, d + 0.70, 0.12), sheetCol);
    K.add(f, boxRound(0.55, 0.06, 0.42, 0.02, 1), TRS(x - 0.25, g + 0.06, d + 0.55, 0.5), shadeHex(sheetCol, 0.9));
    /* the pot, the brush across it, and the drip beside it */
    const paint = mixHex(BUILD.awningAlt, BRAND.paper, 0.36);
    K.add(fw, cyl(0.14, 0.13, 0.22, 9, true), TRS(x + 0.22, g + 0.14, d + 0.72), C.tin);
    K.add(fw, cyl(0.125, 0.125, 0.03, 9, true), TRS(x + 0.22, g + 0.25, d + 0.72), paint);
    K.add(fw, boxRound(0.055, 0.055, 0.32, 0, 1), TRS(x + 0.22, g + 0.29, d + 0.80, 0.4), BUILD.wood);
    K.add(fw, boxRound(0.10, 0.055, 0.13, 0, 1), TRS(x + 0.24, g + 0.29, d + 0.95, 0.4), paint);
    K.add(f, boxRound(0.19, 0.030, 0.16, 0, 1), TRS(x + 0.44, g + 0.05, d + 0.62, 0.9), paint);
    /* the test plank leaning on the wall: four candidate colours, and
       the one they went with painted twice */
    const swat = [paint, mixHex(BUILD.awning, BRAND.paper, 0.4), mixHex(LAND.grassShade, BRAND.paper, 0.45), paint];
    K.add(fw, boxRound(0.30, 1.05, 0.045, 0, 1), TRS(x - 0.62, g + 0.52, d + 0.34, 0, 1, 1, 1, -0.16), mixHex(BUILD.wood, LAND.sand, 0.4));
    for (let i = 0; i < 4; i++) {
      K.add(fw, boxRound(0.26, 0.21, 0.038, 0, 1), TRS(x - 0.62, g + 0.20 + i * 0.24, d + 0.375 + i * 0.038, 0, 1, 1, 1, -0.16), swat[i]);
    }
    return 'a half-finished paint job, pot and brush still out';
  },

  /* LEARNING QUARTER — the weather vane. A cockerel on the library
     ridge that turns to the real wind. Its spindle is returned to
     city.js so the wind can drive it; see createWindInstruments. */
  library(ctx, K, loc, meta) { return null; },

  /* STAMPEDE — the ball. Resting against the bottom step, waiting for
     whoever put it there to come back out. */
  stadium(ctx, K, loc, meta, lift) {
    const f = famOf(K, 'wall');
    const d = loc.size.d / 2;
    const x = -2.4, z = d + 1.6, g = lift;
    K.add(f, sphereG(0.135, 9), TRS(x, g + 0.132, z, 0.6), BRAND.paper);
    /* the panels, which is what makes a sphere a ball */
    for (let i = 0; i < 5; i++) {
      const a = 0.6 + i * 1.256;
      K.add(f, sphereG(0.052, 5), TRS(x + Math.cos(a) * 0.102, g + 0.132 + Math.sin(i * 1.9) * 0.07, z + Math.sin(a) * 0.102, 0, 1, 1, 0.35), BRAND.ink);
    }
    return 'a ball resting against the bottom step';
  },
};

/**
 * Dress one building with the life set. Called by city.js after
 * buildings.js has handed over the kit and before it is merged, so
 * everything written here lands in meshes that already exist.
 *
 * Returns a short note when the building got a one-off, so the build
 * log can say where they are.
 */
export function dressLife(ctx, K, loc, S, meta, rng, opts = {}) {
  const zid = loc.z;
  const w = loc.size.w, d = loc.size.d, dz = d / 2;
  const eave = meta.eaveY || 0;
  const doorU = meta.door ? meta.door.x : 0;
  const fw = famOf(K, 'wood'), fh = famOf(K, 'hedge'), f = famOf(K, 'wall');

  /* ----------------------------------------------------------------
     1. THE EAVE COURSE. Birds sit on the top of a wall; they do not
     sit on a spire or on the twelfth floor. The band is 2.6 m (above
     a doorway, so they are over your head) to 13 m (past which they
     are a speck and the triangles are wasted).
     ---------------------------------------------------------------- */
  if (eave > 2.6 && eave < 13 && w > 4) {
    const shore = zid === 'waterfront';
    const n = 2 + Math.floor(rng() * 3);
    const spread = Math.min(w * 0.72, 7.5);
    for (let i = 0; i < n; i++) {
      const u = -spread / 2 + (spread * (i + 0.3 + rng() * 0.5)) / n;
      /* one of them faces the other way, which is the whole difference
         between a row of birds and a decoration */
      const ry = (i === n - 1 ? PI : 0) + (rng() - 0.5) * 0.7;
      const body = shore ? BRAND.paper : mixHex(BUILD.metal, SKY.horizon, 0.20);
      pigeon(K, f, u, eave + 0.04, dz + 0.02, ry, body, shadeHex(body, 0.82));
    }
    /* and a nest wedged into the corner under the eave */
    if (rng() < 0.55) {
      const sx = rng() < 0.5 ? -1 : 1;
      nest(K, f, sx * (w / 2 - 0.30), eave - 0.34, dz - 0.03, sx * 0.4);
    }
  }

  /* ----------------------------------------------------------------
     2. THE BAND ABOVE THE DOOR. A window box on the first-floor line
     and a basket on a bracket beside the door — the two things that
     put green above head height on an English street and the two this
     city had none of.

     THE HEIGHT IS DERIVED, NOT GUESSED. buildings.js does not publish
     its sill lines, so this takes the one line every form does
     publish — the eaves — and works down: 0.56 of the wall is the
     first-floor sill on a two-storey shop and is, on anything taller,
     still a wall band with windows in it. A box on a wall between
     windows is a box on a wall; a box across a window is a window box.
     Neither of them is wrong, which is why this is safe to do blind.
     ---------------------------------------------------------------- */
  if (eave > 4.2 && w > 5 && zid !== 'ironhills') {
    const sill = clamp(eave * 0.56, 2.9, 5.4);
    const bw = Math.min(1.3, w * 0.17);
    for (const sx of [-1, 1]) {
      const u = sx * Math.max(bw * 0.9, w * 0.26);
      if (Math.abs(u - doorU) < bw) continue;
      if (rng() < 0.25) continue;
      windowBox(K, fw, fh, u, sill, dz, bw, rng);
    }
  }
  if (eave > 2.8 && w > 4.5) {
    const sx = rng() < 0.5 ? -1 : 1;
    const bx = doorU + sx * clamp(w * 0.20, 1.5, 2.6);
    if (Math.abs(bx) < w / 2 - 0.6) basket(K, fw, fh, bx, 2.36, dz, rng() * 6.28);
  }

  /* ----------------------------------------------------------------
     3. THINGS THAT HAVE A HISTORY, on the wall itself.
     ---------------------------------------------------------------- */
  if ((zid === 'rustyrow' || zid === 'innovation' || zid === 'learning') && w > 6 && rng() < 0.5) {
    wallBike(K, f, -w * 0.30 + rng() * w * 0.2, 1.85, dz,
      zid === 'innovation' ? BRAND.info : mixHex(BUILD.awning, BRAND.paper, 0.2));
  }
  /* A MEND ON THE FRONT. Only in the districts that would have one:
     Golden Heights has the money to match its paint and Innovation's
     buildings are ten years old. Rusty Row gets the most, because it
     is the one district whose whole character is repair. */
  const MEND_P = { rustyrow: 0.62, ironhills: 0.42, waterfront: 0.34, greenedge: 0.30, learning: 0.22, marketsq: 0.20, mainstreet: 0.16, stampede: 0.18 };
  if ((MEND_P[zid] || 0) > rng() && w > 5) {
    const cx = -w * 0.34 + rng() * w * 0.42;
    if (Math.abs(cx - doorU) > 1.7) {
      /* a repaint or a render patch anywhere; boards over a window
         only where a window has actually been given up on */
      const kind = zid === 'rustyrow' && rng() < 0.34 ? 2 : rng() < 0.55 ? 0 : 1;
      mend(K, f, cx, kind === 2 ? 1.30 : 0.55 + rng() * 0.5, dz + 0.05, S.wall ? S.wall[0] : BUILD.stucco, kind, rng);
    }
  }

  /* ----------------------------------------------------------------
     4. SOMETHING STRUNG ACROSS THE FRONT.

     §2.3 names laundry and bunting as signature wind carriers and the
     only ones in this city are verlet cloths on the buildings the
     mason happened to choose — 46 of them, against a hard ceiling of
     56, because each one is a solver and a draw call.

     So this hangs the cheap kind: two iron hooks written into the
     building's own kit, and a note left in `meta` for city.js to hang
     an instanced `strung` prop between them. The hooks are real
     geometry on a real wall, which is the only reason the run reads as
     attached to anything.

     WHY THE SPAN IS NOT THE BUILDING'S WIDTH. The prop is one
     prototype, and stretching one 5.2 m run across a 14 m frontage
     would give it 1.4 m shirts. The hooks are set to what the run can
     honestly cover and the ends are where a real line's ends are:
     inside the corners, not on them.
     ---------------------------------------------------------------- */
  const RUN = { rustyrow: 1, waterfront: 1, marketsq: 0, mainstreet: 0, learning: 0, greenedge: 1 };
  const runKind = RUN[zid];
  if (runKind != null && w > 6.4 && eave > 4.0 && rng() < (runKind ? 0.55 : 0.42)) {
    /* ABOVE THE AWNING, AND PROUD OF IT. Photographed on the Market
       Hall, the bunting was strung at eave * 0.46 — which for a shop
       is within a few centimetres of where buildings.js hangs its
       shopfront awning, and 0.62 m out from a wall is inside the
       1.4 m that awning projects. Nine of the eleven pennants were
       behind a sheet of orange canvas. The run now clears the awning
       line in BOTH axes: above it, and standing out past its front
       rail, which is also where a real one is strung. */
    const sep = clamp(w * 0.72, 4.4, 6.2);
    const y = clamp(eave * (runKind ? 0.66 : 0.62), 3.9, 5.8);
    const z = dz + 0.88;
    for (const sx of [-1, 1]) {
      K.add(f, cyl(0.035, 0.035, 0.92, 4, true), TRS(sx * sep * 0.5, y + 0.06, dz + 0.44, 0, 1, 1, 1, PI / 2), C.lead);
      K.add(f, torusG(0.070, 0.030, 6, 4), TRS(sx * sep * 0.5, y, z, 0, 1, 1, 1, 0, PI / 2), C.lead);
    }
    meta.strung = { u0: -sep * 0.5, u1: sep * 0.5, y, z, kind: runKind, span: sep };
  }

  /* ----------------------------------------------------------------
     5. THE ONE-OFF, if this is the place that has it.
     ---------------------------------------------------------------- */
  const once = ONCE[loc.id];
  if (once) {
    try { return once(ctx, K, loc, meta, opts.lift || 0); }
    catch (e) { console.warn('[life] one-off failed', loc.id, e); }
  }
  return null;
}

/* ==================================================================
   THE TWO INSTRUMENTS.

   Everything else in this file is still. These two are the only
   objects in the game that read the wind's DIRECTION rather than its
   strength, and they are the reason the wind is legible at all: a
   grass field bending tells you there is wind, a vane tells you which
   way, and once one thing on the skyline is pointing, every gust in
   §2.3 has somewhere to be read.

   They are two draw calls each and they are worth it because they are
   one-offs. Do not scatter them.
   ================================================================== */
export function createWindInstruments(ctx, lib) {
  const group = new THREE.Group();
  group.name = 'city.wind';
  const spinners = [];
  const built = [];
  const iron = C.lead;

  const emit = (K, name, node) => {
    for (const m of lib.meshes(K, name)) { node.add(m); ctx.mat.register(m); built.push(m); }
  };

  /**
   * THE VANE. A cockerel and an arrow on a spindle, over a fixed
   * compass cross. Everything above the bearing turns; the cross and
   * the mast do not, which is the whole reading — without a fixed
   * reference a turning object is just an animation.
   */
  function addVane(x, y, z, s = 1) {
    const stat = new Kit(AO_FLAT);
    stat.add('metal', post(0.05 * s, 1.30 * s, 0.01, 6), TRS(0, 0.65 * s, 0), iron);
    stat.add('metal', sphereG(0.075 * s, 6), TRS(0, 0.72 * s, 0), iron);
    for (const [ax, az] of [[1, 0], [0, 1]]) {
      stat.add('metal', cyl(0.018 * s, 0.018 * s, 0.66 * s, 4, true),
        TRS(0, 0.98 * s, 0, 0, 1, 1, 1, az ? PI / 2 : 0, ax ? PI / 2 : 0), iron);
    }
    for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      stat.add('metal', boxRound(0.09 * s, 0.13 * s, 0.02 * s, 0, 1), TRS(ax * 0.36 * s, 0.98 * s, az * 0.36 * s), iron);
    }
    const spin = new Kit(AO_FLAT);
    /* the arrow: a head one way, flights the other, on a light beam */
    spin.add('metal', cyl(0.020 * s, 0.020 * s, 0.86 * s, 4, true), TRS(0, 0, 0, 0, 1, 1, 1, PI / 2), iron);
    spin.add('metal', coneG(0.075 * s, 0.20 * s, 5), TRS(0, 0, 0.52 * s, 0, 1, 1, 1, PI / 2), iron);
    for (const sx of [-1, 1]) {
      spin.add('metal', boxRound(0.015 * s, 0.20 * s, 0.24 * s, 0, 1), TRS(sx * 0.055 * s, 0, -0.40 * s, 0, 1, 1, 1, 0, sx * 0.25), iron);
    }
    /* the cockerel, in silhouette: body, breast, comb, tail */
    spin.add('metal', boxRound(0.035 * s, 0.26 * s, 0.40 * s, 0.06, 1), TRS(0, 0.30 * s, 0.06 * s), iron);
    spin.add('metal', sphereG(0.10 * s, 6), TRS(0, 0.40 * s, 0.20 * s, 0, 0.35, 1, 1), iron);
    spin.add('metal', coneG(0.055 * s, 0.14 * s, 4), TRS(0, 0.40 * s, 0.32 * s, 0, 0.35, 1, 1, PI / 2), iron);
    for (let i = 0; i < 3; i++) {
      spin.add('metal', coneG(0.045 * s, 0.11 * s, 4), TRS(0, 0.53 * s + i * 0.01 * s, 0.20 * s - i * 0.06 * s, 0, 0.32, 1, 1), iron);
    }
    for (let i = 0; i < 4; i++) {
      spin.add('metal', boxRound(0.028 * s, 0.34 * s - i * 0.05 * s, 0.09 * s, 0.03, 1),
        TRS(0, 0.40 * s + i * 0.03 * s, -0.14 * s - i * 0.05 * s, 0, 1, 1, 1, 0.5 + i * 0.16), iron);
    }
    const node = new THREE.Group();
    node.position.set(x, y, z);
    const pivot = new THREE.Group();
    pivot.position.y = 1.06 * s;
    emit(stat, 'city.vane.mast', node);
    emit(spin, 'city.vane.cock', pivot);
    node.add(pivot);
    group.add(node);
    /* a vane points INTO the wind */
    spinners.push({ pivot, into: true, yaw: 0, sock: null });
    return node;
  }

  /**
   * THE WINDSOCK. Streams downwind on a swivel and lifts toward the
   * horizontal as the wind gets up — so it reads STRENGTH as well as
   * direction, which nothing else on the island does.
   */
  function addSock(x, y, z, s = 1) {
    const stat = new Kit(AO_FLAT);
    stat.add('metal', post(0.055 * s, 3.1 * s, 0.012, 6), TRS(0, 1.55 * s, 0), iron);
    stat.add('metal', torusG(0.085 * s, 0.020 * s, 8, 4), TRS(0, 3.02 * s, 0, 0, 1, 1, 1, PI / 2), iron);
    for (const sx of [-1, 1]) {
      stat.add('metal', cyl(0.022 * s, 0.022 * s, 1.05 * s, 4, true), TRS(sx * 0.30 * s, 0.62 * s, 0, 0, 1, 1, 1, 0, sx * 0.62), iron);
    }
    const spin = new Kit(AO_FLAT);
    spin.add('metal', torusG(0.20 * s, 0.022 * s, 10, 4), TRS(0, 0, 0.05 * s, 0, 1, 1, 1, PI / 2), iron);
    /* five bands, orange and white, tapering — the standard sock */
    for (let i = 0; i < 5; i++) {
      const r0 = 0.20 - i * 0.026, r1 = 0.20 - (i + 1) * 0.026;
      spin.add('flap', cyl(r1 * s, r0 * s, 0.30 * s, 9, false),
        TRS(0, 0, (0.20 + i * 0.30) * s, 0, 1, 1, 1, PI / 2), i % 2 ? BRAND.paper : BRAND.token);
    }
    const node = new THREE.Group();
    node.position.set(x, y, z);
    const pivot = new THREE.Group();
    pivot.position.y = 3.02 * s;
    const sock = new THREE.Group();
    pivot.add(sock);
    emit(stat, 'city.sock.mast', node);
    emit(spin, 'city.sock.sock', sock);
    node.add(pivot);
    group.add(node);
    spinners.push({ pivot, into: false, yaw: 0, sock });
    return node;
  }

  const _damp = (a, b, l, dt) => {
    let d = b - a;
    while (d > PI) d -= PI * 2;
    while (d < -PI) d += PI * 2;
    return a + d * (1 - Math.exp(-l * dt));
  };

  return {
    group, addVane, addSock,
    get count() { return spinners.length; },
    update(dt) {
      const w = ctx.wind;
      if (!w || !spinners.length) return;
      const d = w.uniforms.uWindDir.value;
      const str = clamp(w.strength, 0, 1.4);
      for (const s of spinners) {
        const want = s.into ? Math.atan2(-d.x, -d.y) : Math.atan2(d.x, d.y);
        /* A VANE THAT SNAPS IS A COMPASS, NOT A VANE. wind.js turns
           its direction over ~20 s and gusts on top; damped at 1.4 the
           vane trails the turn by a beat and overshoots a gust, which
           is the only part of this anyone actually notices. */
        s.yaw = _damp(s.yaw, want, s.into ? 1.4 : 2.2, Math.min(dt, 0.05));
        s.pivot.rotation.y = s.yaw;
        /* the sock lifts from hanging to horizontal with strength */
        if (s.sock) s.sock.rotation.x = -1.15 + clamp(str, 0, 1) * 1.05;
      }
    },
    dispose() { for (const m of built) m.geometry.dispose(); },
  };
}
