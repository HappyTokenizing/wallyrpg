/* ============================================================
   home.js — THE PLAYER'S HOME, WHICH UPGRADES WITH HIM.

   game/data.js sells five homes and game/game.js emits
   `unlock {key:'home', home:<id>}` the moment he moves in:

     rusty      Rusty Row Apartment        $0        patched, cheap
     studio     Main Street Studio         $3,400
     loft       Market Square Loft         $14,000
     water      Waterfront Apartment       $40,000
     penthouse  Golden Heights Penthouse   $220,000  the top floor

   Until now the world showed one building for all five. This file is
   the five, and city.js swaps them at runtime on that event.

   THE RULE — a home BELONGS TO ITS DISTRICT.
   ------------------------------------------------------------
   Each tier is built out of the architecture kit of the district it
   is named after (ZONE_KIT: rundown -> city -> market -> water ->
   gold), through the SAME mason every other building in Bull Bear
   City goes through (buildLocation), and is then dressed by hand on
   top. So the studio is a Main Street building, the loft is a Market
   Square building and the penthouse is a Golden Heights building —
   the same materials, the same roofs, the same palette as their
   neighbours — while the ladder from patched tin to marble-and-gold
   is legible in one glance.

   THE FOOTPRINT NEVER CHANGES. All five are the apartment's own
   11 x 10 m plot, so the collision volume city.js baked into its one
   static body at boot stays exactly correct through every upgrade;
   what grows is the HEIGHT, the storey count, the material and the
   condition.

   OWNERSHIP: world agent. Reads game/data.js, writes nothing.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { BUILD, LAND, BRAND, SEA } from '../core/palette.js';
import { clamp } from '../core/contracts.js';
import { ZONES } from '../game/data.js';
import {
  kitFor, boxRound, cyl, post, sphereG, coneG, torusG, corrugated, plank,
  TRS, mixHex, shadeHex, desatHex, C,
} from './kits.js';
import { buildLocation } from './buildings.js';

const PI = Math.PI;
const jit = (rng, a) => (rng() * 2 - 1) * a;

/* THE MASON'S OWN ARITHMETIC, recovered.

   formShop and formGlass in buildings.js decide the storey count and
   floor height from loc.size.h and the (already re-rolled) S.floorH.
   Dressing that does not agree with them lands balconies between
   floors and string courses across the middle of a window — which is
   the single loudest tell that a facade was decorated rather than
   designed. These two reproduce those decisions exactly, from the
   same inputs, so every band, sill and balcony sits on a real floor
   line. If buildings.js ever changes its mind, change these with it. */
function shopFloors(loc, S) {
  const w = loc.size.w, d = loc.size.d, H = loc.size.h;
  const flat = S.roofKind === 'flat';
  const roofH = flat ? clamp(H * 0.12, 0.8, 2.0)
    : clamp(Math.min(w, d) * (S.pitch ?? 0.34), 1.5, H * 0.34);
  const wallH = H - roofH;
  const storeys = clamp(Math.round(wallH / S.floorH), 1, 4);
  return { storeys, fh: wallH / storeys, wallH, roofH, y0: 0.5 };
}
function glassFloors(loc, S) {
  const H = loc.size.h;
  const storeys = clamp(Math.round(H / S.floorH), 2, 5);
  return { storeys, fh: (H - 0.9) / storeys, y0: 0.5 };
}

/* ------------------------------------------------------------------
   THE LADDER. `zone` picks the district kit; `form` the mason;
   `h` the total height in metres, which is what turns into storeys.
   ------------------------------------------------------------------ */
export const HOME_TIERS = [
  {
    id: 'rusty', name: 'Rusty Row Apartment', zone: 'rustyrow', form: 'shop',
    h: 11.5, floorH: 2.8, tint: 0x6a5744,
    feat: { patch: 1, pipe: 1, shutter: 1, chimney: 1, leanto: 1, laundry: 1, balcony: 0, step: 0 },
    /* the whole envelope pulled toward dirt and grey */
    grime: 0.34, dress: dressRusty,
  },
  {
    id: 'studio', name: 'Main Street Studio', zone: 'mainstreet', form: 'shop',
    h: 14.0, floorH: 3.2, tint: 0x6e5c48,
    feat: { awning: 1, cornice: 1, chimney: 1, balcony: 1, lamp: 1, step: 1, shopfront: 0, shutter: 1 },
    grime: 0.10, dress: dressStudio,
  },
  {
    id: 'loft', name: 'Market Square Loft', zone: 'marketsq', form: 'shop',
    h: 17.5, floorH: 3.1, tint: 0x8a6a3e, roofKind: 'tile',
    feat: { awning: 1, cornice: 1, balcony: 1, bunting: 1, step: 1, chimney: 1, tallwin: 1 },
    grime: 0.03, dress: dressLoft,
  },
  {
    id: 'water', name: 'Waterfront Apartment', zone: 'waterfront', form: 'shop',
    h: 20.0, floorH: 3.3, tint: 0x4d7f96, roofKind: 'tile',
    feat: { cornice: 1, balcony: 1, awning: 1, step: 1, quoin: 1, tallwin: 1 },
    grime: 0.0, dress: dressWater,
  },
  {
    id: 'penthouse', name: 'Golden Heights Penthouse', zone: 'goldenheights', form: 'glass',
    h: 24.5, floorH: 3.5, tint: 0xc9a23c,
    feat: { curtainwall: 1, roofgarden: 1, brise: 1, goldtrim: 1, step: 1 },
    grime: 0.0, dress: dressPenthouse,
  },
];

export const HOME_IDS = HOME_TIERS.map((t) => t.id);
export function homeTierIndex(id) {
  const i = HOME_TIERS.findIndex((t) => t.id === id);
  return i < 0 ? 0 : i;
}

/* ==================================================================
   BUILD ONE TIER.

   Returns { K, meta, loc, S } exactly as buildLocation does, so
   city.js can put it through the same ground-founding, merging,
   outline-registration and LOD path as the other 28 buildings.
   ================================================================== */
export function buildHomeTier(ctx, { tier, base, rng }) {
  const T = typeof tier === 'number' ? HOME_TIERS[clamp(tier, 0, 4)] : tier;

  /* A synthetic location: the apartment's own plot, its own facing,
     its own footprint — and this tier's height and district. */
  const loc = {
    ...base,
    id: 'apartment',
    z: T.zone,
    kit: 'interior',
    tint: T.tint,
    size: { w: base.size.w, d: base.size.d, h: T.h },
  };

  const S = kitFor(loc, ZONES);
  S.form = T.form;
  if (T.floorH) S.floorH = T.floorH;
  if (T.roofKind) S.roofKind = T.roofKind;
  S.feat = { ...S.feat, ...T.feat };
  /* Nobody lives in a shop: kill the shopfront the district kit would
     otherwise glaze the ground floor with. */
  S.feat.shopfront = 0;
  S.storeys = undefined;

  /* CONDITION. A cheap flat is not a nice flat painted brown — it is
     the same palette gone grey and dirty. Every wall, roof and trim
     colour is pulled toward dirt and toward its own luminance by the
     tier's `grime`, which is the single number that carries "patched
     and cheap" all the way up to "the top floor of the city". */
  if (T.grime > 0) {
    const g = T.grime;
    S.wall = S.wall.map((c) => desatHex(mixHex(c, LAND.dirt, g * 0.55), g * 0.75));
    S.roof = desatHex(mixHex(S.roof, LAND.rock, g * 0.5), g * 0.6);
    S.trim = desatHex(mixHex(S.trim, LAND.dirt, g * 0.45), g * 0.5);
    if (S.roofPal) S.roofPal = S.roofPal.map((c) => desatHex(mixHex(c, LAND.rock, g * 0.5), g * 0.6));
  }

  const built = buildLocation(ctx, loc, S, rng);
  /* Only the top tier keeps the mason's own roof garden props etc.
     Props are merged into one instanced system at boot and cannot
     take new members at runtime, so a tier's dressing must be
     geometry, not props. */
  built.meta.props.length = 0;

  try { T.dress(built.K, loc, S, rng, built.meta); }
  catch (e) { console.warn('[home] dressing failed for', T.id, e); }

  return { K: built.K, meta: built.meta, loc, S, tier: T };
}

/* ==================================================================
   DRESSING — what makes each rung of the ladder read at a glance.
   Every colour is a recipe over palette.js; nothing is a fresh hex.
   ================================================================== */

/* ---- 1. RUSTY ROW: patched, propped up, still standing ---------- */
function dressRusty(K, loc, S, rng, meta) {
  const w = loc.size.w, d = loc.size.d;
  const eave = meta.eaveY || 8;
  const tin = mixHex(C.tin, LAND.rock, 0.30);
  const rust = mixHex(C.rust, LAND.dirt, 0.35);
  const board = mixHex(BUILD.woodDark, LAND.dirt, 0.30);

  /* corrugated patches nailed over the render, front and both flanks */
  const faces = [[0, d / 2], [2, -w / 2], [3, w / 2]];
  for (let i = 0; i < 7; i++) {
    const f = faces[i % 3];
    const pw = 1.2 + rng() * 2.2, ph = 0.9 + rng() * 1.6;
    const u = jit(rng, (f[0] === 0 ? w : d) * 0.34);
    const y = 1.1 + rng() * (eave - 2.2);
    const m = f[0] === 0
      ? TRS(u, y, f[1] + 0.10, 0, 1, 1, 1, 0, jit(rng, 0.12))
      : TRS(f[1] + (f[0] === 2 ? -0.10 : 0.10), y, u, PI / 2, 1, 1, 1, 0, jit(rng, 0.12));
    K.add('metal', corrugated(pw, ph, Math.max(4, Math.round(pw * 3)), 0.035, 0.05), m,
      i % 2 ? tin : rust);
  }
  /* one window boarded shut */
  {
    const u = jit(rng, w * 0.26);
    for (let b = 0; b < 3; b++) {
      K.add('wood', boxRound(1.35, 0.24, 0.09, 0.03, 1),
        TRS(u, 3.6 + b * 0.34, d / 2 + 0.14, 0, 1, 1, 1, 0, jit(rng, 0.09)), board);
    }
  }
  /* a tarpaulin corner over the roof, weighted with bricks */
  K.add('metal', boxRound(w * 0.52, 0.06, d * 0.42, 0.05, 1),
    TRS(w * 0.16, eave + 0.55, -d * 0.10, jit(rng, 0.2), 1, 1, 1, 0.05, 0.03),
    mixHex(BUILD.awningAlt, LAND.dirt, 0.52));
  for (let i = 0; i < 4; i++) {
    K.add('wall', boxRound(0.42, 0.20, 0.26, 0.04, 1),
      TRS(w * 0.16 + jit(rng, w * 0.2), eave + 0.68, -d * 0.10 + jit(rng, d * 0.16), rng() * PI),
      shadeHex(C.brick, 0.9));
  }
  /* a rust-streaked water tank on legs */
  {
    const tx = -w * 0.26, tz = -d * 0.20, ty = eave + 0.6;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      K.add('metal', cyl(0.075, 0.075, 1.1, 5, false), TRS(tx + sx * 0.52, ty + 0.55, tz + sz * 0.52), C.lead);
    }
    K.add('metal', cyl(0.78, 0.82, 1.5, 12, true), TRS(tx, ty + 1.85, tz), rust);
    K.add('metal', cyl(0.86, 0.86, 0.12, 12, true), TRS(tx, ty + 2.62, tz), C.tinDark);
  }
  /* a crooked aerial */
  K.add('metal', cyl(0.05, 0.05, 2.9, 5, false), TRS(w * 0.30, eave + 1.9, d * 0.22, 0, 1, 1, 1, 0.13, 0.09), C.lead);
  for (let i = 0; i < 4; i++) {
    K.add('metal', cyl(0.028, 0.028, 1.1 - i * 0.16, 4, false),
      TRS(w * 0.30 + 0.16 * i * 0.2, eave + 2.3 + i * 0.34, d * 0.22, 0, 1, 1, 1, 0, PI / 2), C.lead);
  }
  /* a sagging downpipe that has come away from the wall */
  K.add('metal', cyl(0.10, 0.10, eave - 1.0, 6, false),
    TRS(-w / 2 + 0.35, (eave - 1.0) / 2 + 0.5, d / 2 - 0.5, 0, 1, 1, 1, 0.03, 0.05), rust);
  K.add('metal', cyl(0.11, 0.11, 0.8, 6, false),
    TRS(-w / 2 + 0.55, 0.55, d / 2 - 0.30, 0, 1, 1, 1, 1.15), rust);
  /* two props holding the lean-to up, and a stack of pallets */
  for (const sx of [-1, 1]) {
    K.add('wood', post(0.09, 2.3, 0.03, 6),
      TRS(sx * (w / 2 + 0.9), 1.15, d / 2 - 1.4, 0, 1, 1, 1, 0, sx * 0.10), board);
  }
  for (let i = 0; i < 3; i++) {
    K.add('wood', plank(1.25, 0.13, 0.85, rng),
      TRS(w / 2 + 1.25, 0.22 + i * 0.16, d / 2 + 0.6, 0.3 + jit(rng, 0.2)), board);
  }
  /* a bare bulb over the door — the one warm thing about the place */
  K.add('metal', cyl(0.04, 0.04, 0.55, 5, false), TRS(0.95, 3.05, d / 2 + 0.28, 0, 1, 1, 1, 1.25), C.lead);
  K.add('lamp', sphereG(0.14, 8), TRS(0.95, 2.95, d / 2 + 0.72), BUILD.glassLit);

  /* The washing line is §2.3's signature and exactly right here — but
     it comes from S.feat.laundry through the mason, like every other
     line in Rusty Row. Pushing a second one here hung a nine-metre
     blank sheet across the whole facade. */
}

/* ---- 2. MAIN STREET STUDIO: small, but everything works ---------- */
function dressStudio(K, loc, S, rng, meta) {
  const w = loc.size.w, d = loc.size.d;
  const eave = meta.eaveY || 10;
  const paint = mixHex(BUILD.awningAlt, BRAND.paper, 0.30);

  /* a painted front door with a proper stone step and a brass number */
  K.add('wood', boxRound(1.5, 2.45, 0.14, 0.05, 1), TRS(0.2, 1.72, d / 2 + 0.14), paint);
  K.add('wall', boxRound(2.1, 0.24, 1.05, 0.06, 1), TRS(0.2, 0.16, d / 2 + 0.52), C.stoneWarm);
  K.add('wall', boxRound(1.9, 0.18, 0.85, 0.05, 1), TRS(0.2, 0.36, d / 2 + 0.42), C.marble);
  K.add('gold', boxRound(0.30, 0.34, 0.05, 0.04, 1), TRS(0.2, 2.62, d / 2 + 0.22), C.gold);
  /* a fanlight over it */
  K.add('glassWarm', boxRound(1.5, 0.42, 0.07, 0.05, 1), TRS(0.2, 3.06, d / 2 + 0.16), 0xffffff);
  K.add('wood', boxRound(1.72, 0.14, 0.18, 0.05, 1), TRS(0.2, 3.34, d / 2 + 0.18), S.trim);

  /* window boxes on the first floor, planted — on the real sill line */
  const F = shopFloors(loc, S);
  const sill = F.y0 + F.fh + F.fh * 0.30;
  for (const u of [-w * 0.28, w * 0.30]) {
    K.add('wood', boxRound(1.35, 0.36, 0.42, 0.07, 1), TRS(u, sill, d / 2 + 0.32), S.trim);
    for (let i = 0; i < 4; i++) {
      K.add('hedge', sphereG(0.20, 7),
        TRS(u - 0.45 + i * 0.30, sill + 0.27, d / 2 + 0.32 + jit(rng, 0.08), 0, 1, 0.8, 1),
        i % 2 ? C.leaf : mixHex(C.leaf, BRAND.bad, 0.35));
    }
  }
  /* a clean cast downpipe and gutter, fixed flat to the wall */
  K.add('metal', cyl(0.09, 0.09, eave - 0.6, 8, false), TRS(-w / 2 + 0.30, (eave - 0.6) / 2 + 0.5, d / 2 - 0.34), C.lead);
  K.add('metal', boxRound(w + 0.5, 0.20, 0.24, 0.07, 1), TRS(0, eave + 0.06, d / 2 + 0.30), C.lead);
  /* a wall lantern by the door */
  K.add('metal', cyl(0.045, 0.045, 0.62, 6, false), TRS(-1.35, 3.05, d / 2 + 0.24, 0, 1, 1, 1, 1.28), C.lead);
  K.add('metal', boxRound(0.34, 0.40, 0.34, 0.06, 1), TRS(-1.35, 2.86, d / 2 + 0.62), C.lead);
  K.add('lamp', sphereG(0.13, 8), TRS(-1.35, 2.86, d / 2 + 0.62), BUILD.glassLit);
  /* a chimney pot that is not falling off */
  K.add('wall', boxRound(1.0, 1.5, 1.0, 0.10, 1), TRS(-w * 0.28, eave + 1.0, -d * 0.18), mixHex(C.brick, S.wall[0], 0.25));
  K.add('roof', cyl(0.24, 0.28, 0.55, 9, true), TRS(-w * 0.28, eave + 2.0, -d * 0.18), C.rustPale);

  meta.cloths.push({
    kind: 'awning',
    origin: new THREE.Vector3(-1.5, 3.55, d / 2 + 0.12),
    right: new THREE.Vector3(1, 0, 0), down: new THREE.Vector3(0, -0.42, 1).normalize(),
    width: 3.4, height: 1.25, cols: 9, rows: 5, pin: 'top',
    color: mixHex(BUILD.awningAlt, BRAND.paper, 0.12),
  });
}

/* ---- 3. MARKET SQUARE LOFT: tall glazing, bunting, roof terrace -- */
function dressLoft(K, loc, S, rng, meta) {
  const w = loc.size.w, d = loc.size.d;
  const eave = meta.eaveY || 13;
  const iron = mixHex(BUILD.metal, BRAND.ink, 0.45);
  const F = shopFloors(loc, S);

  /* THE LOFT WINDOW — one big industrial light, mullioned, filling the
     top floor. This is the shape that says "loft" from across the
     square, and it is sized to the real storey, not to a guess. */
  const gh = Math.min(4.6, F.fh * 0.94);
  const gy = F.y0 + F.fh * (F.storeys - 1) + F.fh * 0.5;
  K.add('wall', boxRound(w * 0.62 + 0.5, gh + 0.4, 0.34, 0.10, 1), TRS(0, gy, d / 2 + 0.06), shadeHex(S.wall[0], 0.88));
  K.add('glassWarm', boxRound(w * 0.62, gh, 0.10, 0.03, 1), TRS(0, gy, d / 2 + 0.22), 0xffffff);
  for (let i = 1; i < 5; i++) {
    K.add('metal', boxRound(0.09, gh + 0.1, 0.16, 0.03, 1),
      TRS(-w * 0.31 + (w * 0.62 * i) / 5, gy, d / 2 + 0.28), iron);
  }
  for (let i = 1; i < 3; i++) {
    K.add('metal', boxRound(w * 0.62, 0.09, 0.16, 0.03, 1),
      TRS(0, gy - gh / 2 + (gh * i) / 3, d / 2 + 0.28), iron);
  }
  /* an iron hoist beam over it — an old market warehouse, converted */
  K.add('wood', boxRound(0.30, 0.30, 1.9, 0.06, 1), TRS(0, eave - 0.55, d / 2 + 0.85), BUILD.woodDark);
  K.add('metal', torusG(0.19, 0.045, 12, 6), TRS(0, eave - 1.05, d / 2 + 1.55, 0, 1, 1, 1, PI / 2), iron);

  /* a slim balcony with an iron rail, on a real floor line */
  const by = F.y0 + F.fh * Math.max(1, F.storeys - 2) + 0.12;
  K.add('wall', boxRound(w * 0.66, 0.22, 1.25, 0.06, 1), TRS(0, by, d / 2 + 0.62), C.stoneWarm);
  for (let i = 0; i <= 10; i++) {
    K.add('metal', cyl(0.035, 0.035, 0.95, 5, false), TRS(-w * 0.33 + (w * 0.66 * i) / 10, by + 0.58, d / 2 + 1.16), iron);
  }
  K.add('metal', boxRound(w * 0.66, 0.08, 0.12, 0.03, 1), TRS(0, by + 1.06, d / 2 + 1.16), iron);
  for (const sx of [-1, 1]) {
    K.add('metal', cyl(0.035, 0.035, 1.24, 5, false), TRS(sx * w * 0.33, by + 0.58, d / 2 + 0.62, 0, 1, 1, 1, PI / 2), iron);
  }

  /* roof terrace: parapet, planters, a small pergola */
  K.add('wall', boxRound(w + 0.4, 0.85, 0.36, 0.08, 1), TRS(0, eave + 0.42, d / 2 + 0.10), shadeHex(S.wall[0], 0.92));
  for (let i = 0; i < 4; i++) {
    const x = -w * 0.32 + i * (w * 0.21);
    K.add('wood', boxRound(1.15, 0.48, 0.90, 0.10, 1), TRS(x, eave + 0.60, d * 0.12), S.trim);
    K.add('hedge', sphereG(0.52, 9), TRS(x, eave + 1.05, d * 0.12, 0, 1, 0.78, 1), i % 2 ? C.leaf : C.hedge);
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    K.add('wood', post(0.09, 2.2, 0.02, 6), TRS(sx * w * 0.26, eave + 1.2, -d * 0.16 + sz * 1.1), BUILD.wood);
  }
  for (let i = 0; i < 5; i++) {
    K.add('wood', boxRound(w * 0.56, 0.09, 0.11, 0.03, 1), TRS(0, eave + 2.28, -d * 0.16 - 1.1 + i * 0.55), BUILD.wood);
  }

  /* bunting across the front — Market Square's own signature (§2.3) */
  meta.cloths.push({
    kind: 'bunting',
    origin: new THREE.Vector3(-w * 0.46, eave - 0.4, d / 2 + 1.05),
    right: new THREE.Vector3(1, 0, 0), down: new THREE.Vector3(0, -1, 0.06).normalize(),
    width: w * 0.92, height: 0.95, cols: 14, rows: 4, pin: 'top',
    color: BRAND.token,
  });
}

/* ---- 4. WATERFRONT: glass balconies, salt-pale render, a mast ---- */
function dressWater(K, loc, S, rng, meta) {
  const w = loc.size.w, d = loc.size.d;
  const eave = meta.eaveY || 17;
  const steel = mixHex(BUILD.metal, BRAND.paper, 0.32);
  const glassRail = mixHex(SEA.shallow, BRAND.paper, 0.42);

  /* A BALCONY ON EVERY FLOOR ABOVE THE GROUND, cantilevered and
     glazed, each one on its own real slab line. The stack of
     horizontals is the whole silhouette read at this rung. */
  const F = shopFloors(loc, S);
  for (let s = 1; s < F.storeys; s++) {
    const y = F.y0 + F.fh * s + 0.14;
    if (y > eave - 1.6) break;
    K.add('wall', boxRound(w * 0.86, 0.28, 2.1, 0.08, 1), TRS(0, y, d / 2 + 1.0), C.marble);
    K.add('glassCool', boxRound(w * 0.86, 1.05, 0.08, 0.03, 1), TRS(0, y + 0.66, d / 2 + 2.0), glassRail);
    K.add('metal', boxRound(w * 0.86 + 0.1, 0.09, 0.14, 0.04, 1), TRS(0, y + 1.22, d / 2 + 2.0), steel);
    for (const sx of [-1, 1]) {
      K.add('glassCool', boxRound(0.08, 1.05, 2.0, 0.03, 1), TRS(sx * w * 0.43, y + 0.66, d / 2 + 1.0), glassRail);
      K.add('metal', cyl(0.05, 0.05, 2.1, 6, false), TRS(sx * w * 0.43, y + 1.22, d / 2 + 1.0, 0, 1, 1, 1, PI / 2), steel);
    }
    /* the soffit under each slab, so it reads as cantilevered */
    K.add('wall', boxRound(w * 0.80, 0.10, 1.9, 0.05, 1), TRS(0, y - 0.20, d / 2 + 1.0), shadeHex(C.marble, 0.84));
  }

  /* a deep entrance canopy on two steel props */
  K.add('wall', boxRound(4.8, 0.26, 2.4, 0.09, 1), TRS(0, 3.5, d / 2 + 1.4), C.marble);
  for (const sx of [-1, 1]) {
    K.add('metal', cyl(0.08, 0.08, 3.4, 8, false), TRS(sx * 2.1, 1.75, d / 2 + 2.3), steel);
  }
  K.add('glassCool', boxRound(2.6, 2.7, 0.10, 0.03, 1), TRS(0, 1.85, d / 2 + 0.16), glassRail);

  /* the flagpole. Waterfront: everything here has a mast on it. */
  K.add('metal', cyl(0.09, 0.13, 7.5, 8, false), TRS(w * 0.34, eave + 3.6, -d * 0.20), steel);
  K.add('metal', sphereG(0.17, 8), TRS(w * 0.34, eave + 7.4, -d * 0.20), C.gold);
  for (let i = 0; i < 2; i++) {
    K.add('metal', cyl(0.04, 0.04, 2.4, 5, false),
      TRS(w * 0.34, eave + 4.4 + i * 1.7, -d * 0.20, 0, 1, 1, 1, 0, PI / 2), steel);
  }
  /* parapet with a stainless coping */
  K.add('wall', boxRound(w + 0.5, 0.9, d + 0.5, 0.09, 1), TRS(0, eave + 0.45, 0), shadeHex(C.marble, 0.94));
  K.add('metal', boxRound(w + 0.7, 0.13, d + 0.7, 0.05, 1), TRS(0, eave + 0.95, 0), steel);

  meta.cloths.push({
    kind: 'banner',
    origin: new THREE.Vector3(w * 0.34 + 0.06, eave + 7.0, -d * 0.20),
    right: new THREE.Vector3(0, 0, 1), down: new THREE.Vector3(0, -1, 0).normalize(),
    width: 2.3, height: 1.5, cols: 8, rows: 6, pin: 'left',
    color: mixHex(BRAND.info, BRAND.paper, 0.18),
  });
}

/* ---- 5. GOLDEN HEIGHTS PENTHOUSE: marble, gold, the top floor ---- */
function dressPenthouse(K, loc, S, rng, meta) {
  const w = loc.size.w, d = loc.size.d;
  const eave = meta.eaveY || 26;
  const gold = C.gold;
  const goldDeep = C.goldDeep;

  /* A PODIUM WITH STEPS. Nothing else in the ladder is approached; you
     arrive at this one. */
  for (let i = 0; i < 3; i++) {
    K.add('wall', boxRound(w + 2.6 - i * 0.7, 0.30, d + 2.6 - i * 0.7, 0.08, 1),
      TRS(0, 0.15 + i * 0.30, 0), i % 2 ? C.marble : C.stoneWarm);
  }
  for (let i = 0; i < 3; i++) {
    K.add('wall', boxRound(5.4 - i * 0.5, 0.30, 1.0, 0.06, 1), TRS(0, 0.15 + i * 0.30, d / 2 + 2.4 - i * 0.9), C.marble);
  }
  /* two gold-banded columns flanking the entrance */
  for (const sx of [-1, 1]) {
    K.add('wall', cyl(0.44, 0.50, 6.6, 14, false), TRS(sx * 2.9, 4.2, d / 2 + 1.5), C.marble);
    K.add('gold', cyl(0.56, 0.56, 0.34, 14, true), TRS(sx * 2.9, 1.05, d / 2 + 1.5), gold);
    K.add('gold', cyl(0.56, 0.50, 0.42, 14, true), TRS(sx * 2.9, 7.4, d / 2 + 1.5), gold);
  }
  /* a gold canopy between them */
  K.add('gold', boxRound(6.6, 0.30, 2.6, 0.10, 1), TRS(0, 7.6, d / 2 + 1.5), goldDeep);
  K.add('gold', boxRound(6.9, 0.14, 0.22, 0.05, 1), TRS(0, 7.82, d / 2 + 2.75), gold);

  /* GOLD STRING COURSES up the tower, laid exactly on formGlass's own
     floor slabs — the vertical rhythm that makes it read as tall
     rather than merely big. */
  const F = glassFloors(loc, S);
  for (let s = 1; s <= F.storeys; s++) {
    const y = F.y0 + F.fh * s;
    if (y > eave + 0.01) break;
    K.add('gold', boxRound(w + 0.75, 0.16, d + 0.75, 0.05, 1), TRS(0, y, 0), s % 2 ? gold : goldDeep);
  }
  /* chamfered gold corner piers, full height */
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    K.add('gold', boxRound(0.42, eave - 0.6, 0.42, 0.10, 1),
      TRS(sx * (w / 2 + 0.06), (eave - 0.6) / 2 + 0.5, sz * (d / 2 + 0.06)), goldDeep);
  }

  /* THE CROWN. A stepped parapet, gold finials, and the private
     glass box set back on the roof — the actual penthouse. */
  K.add('wall', boxRound(w + 1.2, 0.55, d + 1.2, 0.10, 1), TRS(0, eave + 0.30, 0), C.marble);
  K.add('gold', boxRound(w + 1.5, 0.24, d + 1.5, 0.07, 1), TRS(0, eave + 0.68, 0), gold);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    K.add('gold', cyl(0.26, 0.34, 0.7, 10, true), TRS(sx * (w / 2 + 0.4), eave + 1.15, sz * (d / 2 + 0.4)), gold);
    K.add('gold', sphereG(0.26, 10), TRS(sx * (w / 2 + 0.4), eave + 1.66, sz * (d / 2 + 0.4)), gold);
    K.add('gold', coneG(0.16, 0.55, 8), TRS(sx * (w / 2 + 0.4), eave + 2.12, sz * (d / 2 + 0.4)), goldDeep);
  }
  /* the penthouse itself: a glazed pavilion, stepped back, with its
     own terrace and a gold pergola */
  const pw = w * 0.66, pd = d * 0.62, py = eave + 0.85;
  K.add('wall', boxRound(pw + 0.5, 0.28, pd + 0.5, 0.07, 1), TRS(0, py, -d * 0.06), C.marble);
  K.add('glassWarm', boxRound(pw, 3.3, pd, 0.10, 1), TRS(0, py + 1.85, -d * 0.06), 0xffffff);
  for (const sx of [-1, 1]) {
    K.add('gold', boxRound(0.16, 3.4, 0.16, 0.04, 1), TRS(sx * pw / 2, py + 1.85, -d * 0.06 - pd / 2), gold);
    K.add('gold', boxRound(0.16, 3.4, 0.16, 0.04, 1), TRS(sx * pw / 2, py + 1.85, -d * 0.06 + pd / 2), gold);
  }
  K.add('gold', boxRound(pw + 0.7, 0.26, pd + 0.7, 0.07, 1), TRS(0, py + 3.66, -d * 0.06), goldDeep);
  /* the terrace in front of the pavilion: hedges, a pergola, a rail */
  for (let i = 0; i < 4; i++) {
    const x = -w * 0.30 + i * (w * 0.20);
    K.add('wall', boxRound(1.05, 0.46, 0.95, 0.09, 1), TRS(x, eave + 0.95, d * 0.28), C.marble);
    K.add('hedge', sphereG(0.50, 10), TRS(x, eave + 1.38, d * 0.28, 0, 1, 0.76, 1), i % 2 ? C.leaf : C.hedge);
  }
  for (const sx of [-1, 1]) {
    K.add('gold', cyl(0.09, 0.09, 2.4, 8, false), TRS(sx * w * 0.28, eave + 1.75, d * 0.06), gold);
  }
  for (let i = 0; i < 4; i++) {
    K.add('gold', boxRound(w * 0.62, 0.08, 0.10, 0.03, 1), TRS(0, eave + 2.9, d * 0.06 - 0.5 + i * 0.34), gold);
  }

  /* A GILDED BANNER, hung clear of the glass on its own jack staff.
     Pinned flat against the curtain wall it read as an orange plate
     stuck to the tower; out here it is the one thing on the building
     that moves (§2.3, §6). */
  K.add('gold', cyl(0.07, 0.07, 3.0, 7, false),
    TRS(-1.9, eave + 0.35, d / 2 + 1.55, 0, 1, 1, 1, 0, PI / 2), gold);
  K.add('gold', sphereG(0.14, 8), TRS(-0.4, eave + 0.35, d / 2 + 1.55), gold);
  meta.cloths.push({
    kind: 'banner',
    origin: new THREE.Vector3(-3.3, eave + 0.30, d / 2 + 1.55),
    right: new THREE.Vector3(1, 0, 0), down: new THREE.Vector3(0, -1, 0).normalize(),
    width: 2.6, height: 3.4, cols: 8, rows: 10, pin: 'top',
    color: mixHex(BRAND.token, BRAND.warn, 0.35),
  });
}
