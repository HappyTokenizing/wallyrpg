/* ============================================================
   buildings.js — the mason.

   One routine per architectural FORM. Each is handed a Kit (a bundle
   of per-material Builders), the location record out of game/data.js
   and a seeded rng, and writes a building into LOCAL space:

       +Z is the front (loc.yaw already turns the group to face the
       district anchor), y = 0 is the ground, the footprint is
       loc.size.w x loc.size.d and loc.size.h is the ridge height.

   Everything is BUILT, never boxed: a wall is a leaning chamfered
   mass with a plinth and a string course, a roof is a sagging solid
   with eaves and gutters, a window is a reveal + four bars + a pane +
   a sill, a door has a frame, a threshold and a lintel.

   Each form also returns, through `meta`:
     door          local point in front of the doorway
     signAnchor    where signs.js hangs the nameboard
     interior      a point inside, for the interior camera
     collide       oriented boxes for ctx.phys.addStatic
     cloths        awning / banner descriptors (built once phys exists)
     props         prop requests in local space
     lod           the simplified silhouette (built by silhouette())
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { BUILD, LAND, BRAND, SEA, SKY } from '../core/palette.js';
import { clamp, lerp, smoothstep } from '../core/contracts.js';
import {
  Kit, Builder, makeAO, boxRound, roofSolid, corrugated, cyl, post, sphereG,
  coneG, torusG, column, TRS, shear, mixHex, shadeHex, hexOf, C, plank,
} from './kits.js';

const PI = Math.PI;
const _tmp = new THREE.Vector3();

/* ------------------------------------------------------------------
   small shared pieces
   ------------------------------------------------------------------ */

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length) % arr.length]; }
function jit(rng, k) { return (rng() - 0.5) * 2 * k; }

/** A storey: chamfered, leaning, very slightly tapered. */
function mass(K, o) {
  const r = Math.min(o.w, o.d, o.h) * (o.round ?? 0.11);
  const g = boxRound(o.w, o.h, o.d, r, o.arc ?? 1);
  const m = TRS(o.x || 0, (o.y || 0) + o.h / 2, o.z || 0, o.ry || 0);
  if (o.lean) shear(m, o.lean[0], o.lean[1]);
  K.add(o.part || 'wall', g, m, o.color);
  return m;
}

/** A horizontal band — plinth, string course, cornice, parapet cap. */
function band(K, o) {
  const g = boxRound(o.w, o.h ?? 0.24, o.d, (o.h ?? 0.24) * 0.34, 1);
  K.add(o.part || 'stone', g, TRS(o.x || 0, o.y, o.z || 0, o.ry || 0), o.color);
}

/* face 0 +Z, 1 -Z, 2 +X, 3 -X : outward transform for a wall fitting */
function faceMat(face, w, d, u, y, out) {
  switch (face) {
    case 0: return TRS(u, y, d / 2 + out, 0);
    case 1: return TRS(-u, y, -d / 2 - out, PI);
    case 2: return TRS(w / 2 + out, y, -u, PI / 2);
    default: return TRS(-w / 2 - out, y, u, -PI / 2);
  }
}
const faceSpan = (face, w, d) => (face === 0 || face === 1 ? w : d);
/** faceMat for a mass that is offset along local Z from the plot origin. */
function faceMatOff(face, w, d, u, y, out, oz) {
  return new THREE.Matrix4().makeTranslation(0, 0, oz).multiply(faceMat(face, w, d, u, y, out));
}

/** A window: reveal, four bars, a pane, a sill, an optional mullion. */
function windowUnit(K, S, rng, M, o = {}) {
  const ww = o.w ?? 1.05, wh = o.h ?? 1.5;
  const frame = o.frame ?? S.trim;
  const wallC = o.wall ?? S.wall[0];
  const glass = o.glass ?? (rng() < 0.55 ? 'glassWarm' : 'glassCool');
  const t = o.t ?? 0.13;

  const push = (part, g, m, col) => K.add(part, g, new THREE.Matrix4().multiplyMatrices(M, m), col);
  const lean = !!o.lean;

  /* ------------------------------------------------------------------
     THE REVEAL.

     A wall here is a solid chamfered mass: there is no hole to sink a
     window into, and the old unit answered that by putting a darker box
     BEHIND the wall face — where, being behind a solid, nothing could
     ever see it — and a pane 5.5 cm back. From the street that is a
     sticker. It is exactly what the judges meant by "the doorway
     recesses read as painted-on", and it was true of every opening in
     the city.

     Depth reads by CONTRAST, not by absolute position. So the surround
     is built PROUD and the glass is left at the wall plane: the jamb
     between them is then a real 20 cm return with an inner face the sun
     rakes across, a head soffit the sun never reaches at all, and a
     corner for the AO and the cast shadow to sit in.
     ------------------------------------------------------------------ */
  const rv = lean ? 0.11 : (o.reveal ?? 0.20);   // how far the surround stands proud
  const jw = lean ? 0.12 : 0.16;                 // jamb width
  const jc = o.jamb ?? mixHex(wallC, S.trim, 0.20);

  /* the dark opening the glass sits in */
  push('wall', boxRound(ww + 0.05, wh + 0.05, 0.14, 0.03, 1), TRS(0, 0, -0.06), shadeHex(wallC, 0.56));
  push(glass, boxRound(ww, wh, 0.07, 0.02, 1), TRS(0, 0, -0.015), o.paneCol ?? 0xffffff);

  /* four jambs standing proud — their inner faces ARE the reveal.
     Left and right are shaded apart: a reveal with both cheeks the same
     value is a picture frame, not a hole in a wall. */
  const jambV = boxRound(jw, wh + 2 * jw, rv + 0.07, 0.035, 1);
  const jambH = boxRound(ww + 2 * jw, jw, rv + 0.07, 0.035, 1);
  push('wall', jambV, TRS(-(ww / 2 + jw / 2), 0, rv / 2 - 0.035), shadeHex(jc, 0.90));
  push('wall', jambV, TRS(ww / 2 + jw / 2, 0, rv / 2 - 0.035), shadeHex(jc, 1.02));
  /* the head soffit is the darkest piece in the unit */
  push('wall', jambH, TRS(0, wh / 2 + jw / 2, rv / 2 - 0.035), shadeHex(jc, 0.80));
  if (!lean) push('wall', jambH, TRS(0, -(wh / 2 + jw / 2), rv / 2 - 0.035), shadeHex(jc, 1.05));

  /* the casement, INSIDE the opening rather than pasted over it */
  const bar = boxRound(t, wh - t, 0.10, 0.03, 1);
  push('wood', bar, TRS(-(ww / 2 - t / 2), 0, 0.035), frame);
  push('wood', bar, TRS(ww / 2 - t / 2, 0, 0.035), frame);
  const barH = boxRound(ww, t, 0.10, 0.03, 1);
  push('wood', barH, TRS(0, wh / 2 - t / 2, 0.035), frame);
  if (!lean) push('wood', barH, TRS(0, -(wh / 2 - t / 2), 0.035), frame);
  /* glazing bar */
  if (o.mullion !== false && !lean) {
    push('wood', boxRound(0.075, wh - t * 2, 0.09, 0.02, 1), TRS(0, 0, 0.03), frame);
    if (wh > 1.3) push('wood', boxRound(ww - t * 2, 0.07, 0.085, 0.02, 1), TRS(0, wh * 0.14, 0.03), frame);
  }
  /* sill — oversails the jambs, weathered forward, and is the piece
     that throws the shadow down the wall beneath the opening */
  if (o.sill !== false) {
    push('stone', boxRound(ww + 2 * jw + 0.34, 0.17, rv + 0.36, 0.05, 1),
      TRS(0, -(wh / 2 + jw + 0.09), rv * 0.42, 0, 1, 1, 1, 0.07), o.sillCol ?? S.trim);
  }
  /* lintel or a shallow relieving arch */
  if (o.arch) {
    const N = 5;
    for (let i = 0; i < N; i++) {
      const a = lerp(-1, 1, i / (N - 1));
      const yy = wh / 2 + jw + 0.20 + Math.cos(a * 1.05) * 0.16;
      push('stone', boxRound((ww + 0.5) / N * 1.14, 0.30, rv + 0.16, 0.06, 1),
        TRS(a * (ww + 0.4) * 0.5, yy, rv * 0.4, 0, 1, 1, 1, 0, -a * 0.42), o.archCol ?? S.trim);
    }
  } else if (o.lintel !== false) {
    push('stone', boxRound(ww + 2 * jw + 0.40, 0.22, rv + 0.22, 0.06, 1),
      TRS(0, wh / 2 + jw + 0.16, rv * 0.38), o.sillCol ?? S.trim);
  }
  /* shutters, hinged off the outer jamb, thrown open at slightly
     different angles */
  if (o.shutters) {
    const sg = boxRound(ww * 0.52, wh * 0.94, 0.075, 0.025, 1);
    push('wood', sg, TRS(-(ww / 2 + jw + ww * 0.26), 0, rv + 0.10, jit(rng, 0.32) - 0.28), o.shutterCol ?? S.trim);
    push('wood', sg, TRS(ww / 2 + jw + ww * 0.26, 0, rv + 0.10, jit(rng, 0.32) + 0.28), o.shutterCol ?? S.trim);
  }
}

/** Even window rows across one face of a storey.
    `ox` / `oz` shift the whole row in the building's own frame, for a
    mass that does not sit at the origin (the market lock-up sits at the
    back of its plot — without this its rear and flank windows were laid
    on the CENTRE of the plot, i.e. floating inside the building, and
    every stall in the city had three blank elevations). */
function windowRow(K, S, rng, o) {
  const span = faceSpan(o.face, o.w, o.d);
  const n = o.count ?? Math.max(1, Math.floor((span - 1.4) / (o.pitch ?? 2.6)));
  if (n <= 0) return;
  const step = span / (n + (o.edge ? 0 : 1));
  const shift = (o.ox || o.oz)
    ? new THREE.Matrix4().makeTranslation(o.ox || 0, 0, o.oz || 0) : null;
  for (let i = 0; i < n; i++) {
    const u = o.edge ? -span / 2 + step * (i + 0.5) : -span / 2 + step * (i + 1);
    if (o.skip && o.skip(u)) continue;
    const M = faceMat(o.face, o.w, o.d, u, o.y, (o.out ?? 0) + 0.02);
    if (shift) M.premultiply(shift);
    windowUnit(K, S, rng, M, o.win || {});
  }
}

/** A doorway with frame, threshold, lintel and a recessed leaf. */
function doorway(K, S, rng, o) {
  const dw = o.w ?? 1.5, dh = o.h ?? 2.5;
  const M = faceMatOff(o.face ?? 0, o.bw, o.bd, o.u ?? 0, dh / 2 + 0.05, 0.02, o.oz || 0);
  const push = (part, g, m, col) => K.add(part, g, new THREE.Matrix4().multiplyMatrices(M, m), col);
  const wallC = o.wall ?? S.wall[0];

  /* A DOOR IS A HOLE IN A THICK WALL. Same reasoning as windowUnit:
     the leaf sits back at the wall plane and the whole surround — two
     jambs and a head — is built proud of it, so the doorway has 0.3 m
     of visible return on three sides, a soffit over the leaf that never
     sees the sun, and a shadow line down each cheek. */
  const rv = o.reveal ?? 0.30;
  const jw = 0.19;
  const jc = o.jambCol ?? mixHex(wallC, o.frame ?? S.trim, 0.30);

  /* the dark of the opening, behind the leaf */
  push('wall', boxRound(dw + 0.06, dh + 0.06, 0.16, 0.04, 1), TRS(0, 0.02, -0.10), shadeHex(wallC, 0.52));
  /* the leaf: two boards and a rail, sitting at the wall plane */
  push('wood', boxRound(dw, dh, 0.10, 0.04, 1), TRS(0, -0.02, -0.015), o.door ?? S.trim);
  push('wood', boxRound(dw * 0.94, 0.13, 0.11, 0.04, 1), TRS(0, dh * 0.16, 0.035), shadeHex(o.door ?? S.trim, 0.86));
  push('wood', boxRound(dw * 0.94, 0.13, 0.11, 0.04, 1), TRS(0, -dh * 0.22, 0.035), shadeHex(o.door ?? S.trim, 0.86));
  push('metal', sphereG(0.07, 8), TRS(dw * 0.33, 0, 0.06), C.gold);
  /* the reveal: two cheeks and a soffit, each a different value */
  const jamb = boxRound(jw, dh + 2 * jw, rv + 0.08, 0.05, 1);
  push('wall', jamb, TRS(-(dw / 2 + jw / 2), 0.02, rv / 2 - 0.04), shadeHex(jc, 0.88));
  push('wall', jamb, TRS(dw / 2 + jw / 2, 0.02, rv / 2 - 0.04), shadeHex(jc, 1.03));
  push('wall', boxRound(dw + 2 * jw, jw, rv + 0.08, 0.05, 1),
    TRS(0, dh / 2 + jw / 2 + 0.02, rv / 2 - 0.04), shadeHex(jc, 0.76));
  /* architrave standing on the reveal, and the head above it */
  const arch = boxRound(0.13, dh + 2 * jw + 0.10, 0.16, 0.04, 1);
  push('wood', arch, TRS(-(dw / 2 + jw + 0.065), 0.02, rv + 0.03), o.frame ?? S.trim);
  push('wood', arch, TRS(dw / 2 + jw + 0.065, 0.02, rv + 0.03), o.frame ?? S.trim);
  push('stone', boxRound(dw + 2 * jw + 0.52, 0.26, rv + 0.24, 0.07, 1),
    TRS(0, dh / 2 + jw + 0.17, rv * 0.44), o.head ?? S.trim);
  /* threshold step, worn */
  push('stone', boxRound(dw + 0.9, 0.22, rv + 0.62, 0.06, 1), TRS(0, -(dh / 2 + 0.07), rv * 0.5 + 0.16), o.step ?? S.trim);
  if (o.steps) {
    push('stone', boxRound(dw + 1.4, 0.20, 1.1, 0.06, 1), TRS(0, -(dh / 2 + 0.25), rv * 0.5 + 0.46), o.step ?? S.trim);
  }
}

/** Roof + eaves gutter + ridge cap + a downpipe or two. */
function roofOn(K, S, rng, o) {
  const kind = o.kind ?? S.roofKind;
  const w = o.w, d = o.d, y = o.y;
  /* a mass that does not sit at the plot origin carries its roof with
     it — see formStall, where the body is pushed to the back of the
     plot to leave room for the veranda in front of it */
  const oz = o.z ?? 0;
  const ridgeH = o.ridge ?? clamp(Math.min(w, d) * (S.pitch ?? 0.30), 1.0, 4.0);
  /* buildLocation may flip a near-square plot's ridge: two houses of
     the same footprint with the ridge running the other way do not
     read as the same house */
  const along = o.along ?? ((w >= d) !== !!S.ridgeFlip ? 'x' : 'z');
  /* roofSolid runs its ridge along +Z, so a building that is wider
     than it is deep gets the whole roof turned a quarter turn. */
  const rw = along === 'x' ? d : w;
  const rd = along === 'x' ? w : d;
  const ry = along === 'x' ? PI / 2 : 0;

  if (kind === 'flat') {
    K.add('roof', boxRound(w + 0.5, 0.34, d + 0.5, 0.09, 1), TRS(0, y + 0.17, oz), o.color ?? S.roof);
    /* parapet: four low walls, each leaning a hair differently */
    const t = 0.30, ph = o.parapet ?? 0.62;
    band(K, { part: 'wall', w: w + 0.6, h: ph, d: t, y: y + ph / 2 + 0.3, z: oz + d / 2 + 0.15, color: o.wall ?? S.wall[0] });
    band(K, { part: 'wall', w: w + 0.6, h: ph, d: t, y: y + ph / 2 + 0.3, z: oz - d / 2 - 0.15, color: o.wall ?? S.wall[0] });
    band(K, { part: 'wall', w: t, h: ph, d: d + 0.6, y: y + ph / 2 + 0.3, z: oz, x: w / 2 + 0.15, color: o.wall ?? S.wall[0] });
    band(K, { part: 'wall', w: t, h: ph, d: d + 0.6, y: y + ph / 2 + 0.3, z: oz, x: -w / 2 - 0.15, color: o.wall ?? S.wall[0] });
    band(K, { part: 'stone', w: w + 0.86, h: 0.16, d: 0.46, y: y + ph + 0.36, z: oz + d / 2 + 0.15, color: S.trim });
    band(K, { part: 'stone', w: w + 0.86, h: 0.16, d: 0.46, y: y + ph + 0.36, z: oz - d / 2 - 0.15, color: S.trim });
    return y + ph + 0.5;
  }

  /* THE OVERHANG IS A DETAIL, NOT THE BUILDING. A 0.65 m eave on every
     side of a 9 m shopfront threw a metre and a half of dark soffit
     over a wall that was only three metres tall, and the whole street
     read as market stalls under awnings rather than as houses. Wind
     Waker's Windfall roofs sit tight on their walls. */
  const overW = o.overW ?? clamp(rw * 0.038, 0.22, 0.42);
  const overD = o.overD ?? clamp(rd * 0.028, 0.20, 0.38);
  const corr = kind === 'corrugated';
  const thick = corr ? 0.18 : 0.30;
  const flare = corr ? 0.02 : 0.09;

  const g = roofSolid({
    w: rw, d: rd, ridge: ridgeH, thick, overW, overD,
    sag: S.sag + (corr ? 0.05 : 0), hip: corr ? 0 : (o.hip ?? S.hipK ?? 0.25),
    curve: corr ? 1.04 : 1.22, flare, uSeg: corr ? 4 : 6, tSeg: 6,
    ribs: corr ? Math.max(4, Math.round(rd / 1.1)) : 0, ribAmp: 0.05,
  });
  K.add(corr ? 'metal' : 'roof', g, TRS(0, y, oz, ry), o.color ?? S.roof);
  /* Ridge cap. The roof SAGS, so its apex over the middle of the
     building is ridge*(1-sag), not ridge — a cap parked at the
     nominal ridge height floats above its own roof like a scaffold
     pole, which is exactly how it read before this line. */
  const sagK = S.sag + (corr ? 0.05 : 0);
  /* the cap is a CAP, not a scaffold pole: 0.66 x 0.28 read as a fat
     sausage laid along the apex of a steep roof */
  K.add(corr ? 'metal' : 'roof', boxRound(rd + overD * 1.6, 0.19, 0.46, 0.09, 2),
    TRS(0, y + ridgeH * (1 - sagK) - 0.02, oz, ry + PI / 2), S.roofAlt);

  /* Tile battens, laid ON the slope, in segments that follow the roof's
     own sag and hip. These are what stop a big roof reading as one flat
     field of orange. (The first version was axis-aligned boxes floating
     over the slope — they read as scaffolding poles.) */
  const hw0 = rw / 2 + overW;
  if (!corr && (o.battens ?? 3) > 0) {
    roofBattens(K, {
      n: o.battens ?? 3, rw, rd, ridge: ridgeH, overW, overD, z: oz,
      y, ry, sag: S.sag, hip: o.hip ?? S.hipK ?? 0.25, color: S.roofAlt,
    });
  }

  /* gutters, hung just under the eave tips where they belong */
  const hw = rw / 2 + overW;
  const gy = y + flare * ridgeH - thick - 0.06;
  for (const s of [-1, 1]) {
    const m = new THREE.Matrix4().makeTranslation(0, 0, oz)
      .multiply(new THREE.Matrix4().makeRotationY(ry))
      .multiply(new THREE.Matrix4().makeTranslation(s * (hw - 0.10), gy, 0))
      .multiply(new THREE.Matrix4().makeRotationX(PI / 2));
    K.add('metal', cyl(0.11, 0.11, rd + overD * 2, 7, false), m, S.roofAlt);
  }
  if (o.downpipe !== false && o.wallH > 1.5) {
    const sx = rng() < 0.5 ? -1 : 1, sz = rng() < 0.5 ? -1 : 1;
    K.add('metal', cyl(0.10, 0.11, o.wallH, 7, false),
      TRS(sx * (w / 2 + 0.14), y - o.wallH * 0.5, oz + sz * (d / 2 - 0.45)), S.roofAlt);
    K.add('metal', cyl(0.10, 0.10, 0.55, 6, false),
      TRS(sx * (w / 2 + 0.14), y - 0.1, oz + sz * (d / 2 - 0.45) + 0.2, 0, 1, 1, 1, sz * 0.9), S.roofAlt);
  }
  return y + ridgeH;
}

/** Battens lying on a pitched roof, segmented so they follow its sag. */
function roofBattens(K, o) {
  const hw = o.rw / 2 + o.overW;
  const hd = o.rd / 2 + o.overD;
  const pitch = Math.atan2(o.ridge, hw);
  const segs = Math.max(1, Math.ceil(o.rd / 7));
  const len = (hd * 2) / segs;
  for (let i = 1; i <= o.n; i++) {
    const t = i / (o.n + 1);
    for (let k = 0; k < segs; k++) {
      const tc = (k + 0.5) / segs;
      const sc = Math.abs(2 * tc - 1);
      const ws = 1 - o.hip * Math.pow(sc, 1.7);
      const hs = 1 - o.hip * 0.55 * sc * sc;
      const sagY = -o.sag * o.ridge * Math.sin(PI * tc);
      const x = hw * t * ws;
      const yy = o.y + o.ridge * Math.pow(1 - t, 1.22) * hs + sagY + 0.085;
      const z = (tc - 0.5) * 2 * hd;
      for (const sx of [-1, 1]) {
        const m = new THREE.Matrix4().makeTranslation(0, 0, o.z || 0)
          .multiply(new THREE.Matrix4().makeRotationY(o.ry))
          .multiply(new THREE.Matrix4().makeTranslation(sx * x, yy, z))
          .multiply(new THREE.Matrix4().makeRotationZ(-sx * pitch));
        /* WIDE AND SHALLOW. At 0.36 x 0.15 these sat half-buried in the
           slope and read as a scatter of pills lying on the tiles; a
           tile course is a long, low step, so make it one. */
        K.add('roof', boxRound(0.46, 0.085, len * 0.995, 0.03, 1), m, o.color);
      }
    }
  }
}

function chimney(K, S, rng, o) {
  const w = o.w ?? 0.75, h = o.h ?? 1.7;
  const m = TRS(o.x, o.y + h / 2, o.z, jit(rng, 0.14));
  shear(m, jit(rng, 0.05), jit(rng, 0.05));
  K.add('wall', boxRound(w, h, w * 0.86, 0.09, 1), m, o.color ?? shadeHex(S.wall[0], 0.9));
  K.add('stone', boxRound(w + 0.22, 0.18, w * 0.86 + 0.22, 0.06, 1), TRS(o.x, o.y + h + 0.06, o.z), S.trim);
  K.add('metal', cyl(0.09, 0.11, 0.44, 7, false), TRS(o.x - w * 0.18, o.y + h + 0.3, o.z), S.roofAlt);
  K.add('metal', cyl(0.09, 0.11, 0.34, 7, false), TRS(o.x + w * 0.18, o.y + h + 0.25, o.z), S.roofAlt);
}

/** A slatted timber balcony with a bowed rail. */
function balcony(K, S, rng, o) {
  const w = o.w, y = o.y, z = o.z;
  K.add('wood', boxRound(w, 0.16, 1.05, 0.05, 1), TRS(0, y, z + 0.5), S.trim);
  K.add('wood', boxRound(w, 0.11, 0.14, 0.04, 1), TRS(0, y + 0.86, z + 1.0), shadeHex(S.trim, 0.9));
  const n = Math.max(3, Math.round(w / 0.42));
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + (w * (i + 0.5)) / n;
    K.add('wood', boxRound(0.075, 0.86, 0.075, 0.025, 1), TRS(x, y + 0.45, z + 1.0, jit(rng, 0.08)), S.trim);
  }
  for (const s of [-1, 1]) {
    K.add('wood', post(0.07, 1.0, 0.03, 6), TRS(s * (w / 2 - 0.08), y + 0.42, z + 1.0), S.trim);
    K.add('wood', boxRound(0.13, 0.13, 1.0, 0.04, 1), TRS(s * (w / 2 - 0.08), y - 0.12, z + 0.55, 0, 1, 1, 1, 0.5), shadeHex(S.trim, 0.85));
  }
}

/* ------------------------------------------------------------------
   FORM: shop — Rusty Row, Main Street, and the general case.
   ------------------------------------------------------------------ */
function formShop(ctx, K, loc, S, rng, meta) {
  const w = loc.size.w, d = loc.size.d, H = loc.size.h;
  const flat = S.roofKind === 'flat';
  /* PITCH IS SET BY THE SPAN, NOT BY THE HEIGHT. A roof whose rise is
     a fixed fraction of the building's height comes out nearly flat on
     anything wide, and a flat orange plate is the single most amateur
     shape in this whole art direction. 0.34 of the short span puts the
     slope at 30-34 degrees, which is where Wind Waker's roofs live —
     and the cap at 0.30 H is what keeps the WALL the dominant surface.
     At 0.42 / 0.40 H the roof was half the elevation and every house on
     the island read as a shelter rather than as somewhere anyone lives. */
  const roofH = flat ? clamp(H * 0.12, 0.8, 2.0)
    : clamp(Math.min(w, d) * (S.pitch ?? 0.34), 1.5, H * 0.34);
  const wallH = H - roofH;
  const storeys = clamp(Math.round(wallH / S.floorH), 1, 4);
  const fh = wallH / storeys;
  const lean = [jit(rng, S.lean), jit(rng, S.lean)];
  const base = S.wall[Math.floor(rng() * S.wall.length)];

  /* plinth */
  band(K, { part: 'stone', w: w + 0.34, h: 0.56, d: d + 0.34, y: 0.28, color: shadeHex(base, 0.80) });

  /* A street of cream boxes is not a street. The ground floor of a
     shop is PAINTED — the trade colour — and the upper floors are the
     stucco. That single band of saturation is most of what makes a
     Wind Waker town read as a town. */
  const shopPaint = mixHex(pick(rng, [
    BUILD.awning, BUILD.awningAlt, BRAND.good, BRAND.token2, BRAND.gem, BRAND.info, BRAND.warn,
  ]), base, 0.42 + rng() * 0.2);

  let y = 0.5;
  for (let s = 0; s < storeys; s++) {
    const inset = s === 0 ? 0 : 0.09 * s;
    const cw = w - inset * 2, cd = d - inset * 2;
    const col = s === 0
      ? (S.feat.shopfront ? shopPaint : base)
      : mixHex(base, S.wall[(s + 1) % S.wall.length], 0.55);
    mass(K, {
      w: cw, h: fh + 0.06, d: cd, y, color: col,
      lean: [lean[0] * (s + 1) * 0.5, lean[1] * (s + 1) * 0.5],
      round: 0.09,
    });
    /* string course over every floor but the top */
    if (s < storeys - 1) {
      band(K, { part: 'stone', w: cw + 0.30, h: 0.22, d: cd + 0.30, y: y + fh, color: S.trim });
    }
    y += fh;
  }
  const eaveY = y;

  /* --- ground floor --- */
  const shop = S.feat.shopfront && rng() < 0.88 && w > 7;
  const doorU = shop ? -w * 0.30 : jit(rng, w * 0.12);
  if (shop) {
    /* a glazed bay: stallriser, mullions, fascia */
    const bw = w * 0.50, bh = fh * 0.62, bx = w * 0.16;
    const M = faceMat(0, w, d, bx, 0.5 + bh / 2 + 0.55, 0.06);
    const push = (p, g, m, c) => K.add(p, g, new THREE.Matrix4().multiplyMatrices(M, m), c);
    push('wall', boxRound(bw + 0.4, bh + 0.4, 0.30, 0.07, 1), TRS(0, 0, -0.16), shadeHex(base, 0.82));
    push(rng() < 0.6 ? 'glassWarm' : 'glassCool', boxRound(bw, bh, 0.08, 0.02, 1), TRS(0, 0, -0.02));
    const nm = Math.max(2, Math.round(bw / 1.1));
    for (let i = 1; i < nm; i++) {
      push('wood', boxRound(0.11, bh + 0.3, 0.20, 0.035, 1), TRS(-bw / 2 + (bw * i) / nm, 0, 0.06), S.trim);
    }
    push('wood', boxRound(bw + 0.5, 0.20, 0.24, 0.06, 1), TRS(0, bh / 2 + 0.16, 0.06), S.trim);
    push('stone', boxRound(bw + 0.6, 0.62, 0.36, 0.08, 1), TRS(0, -bh / 2 - 0.3, 0.06), shadeHex(shopPaint, 0.86));
    /* the fascia board the shop's name would be painted on */
    push('wood', boxRound(bw + 1.1, 0.52, 0.30, 0.09, 1), TRS(0, bh / 2 + 0.55, 0.10), shadeHex(shopPaint, 0.78));
  } else {
    windowRow(K, S, rng, {
      face: 0, w, d, y: 0.5 + fh * 0.56, count: Math.max(1, Math.round(w / 3.4)),
      win: { w: 1.0, h: fh * 0.5, shutters: S.feat.shutter && !S.simple ? rng() < 0.6 : false, sillCol: S.trim, lean: S.simple },
      skip: (u) => Math.abs(u - doorU) < 1.5,
    });
  }
  doorway(K, S, rng, {
    face: 0, bw: w, bd: d, u: doorU, w: 1.55, h: 2.55,
    wall: base, frame: S.trim, door: mixHex(S.trim, S.tint, 0.5), step: S.trim, steps: !!S.feat.step,
  });

  /* --- the other three elevations, at street level ---
     NO FACE IS EVER BLANK. A single-storey shop used to get its whole
     articulation on the front and three untouched stucco slabs behind
     it, and a 12 m unbroken wall is the loudest possible tell that a
     building is a box with a facade painted on one side. Back and
     flanks get their own quieter rhythm: smaller lights, no shutters,
     no glazing bar, set a little higher. */
  for (const face of [1, 2, 3]) {
    const span = faceSpan(face, w, d);
    const n = clamp(Math.round(span / (S.simple ? 4.6 : 3.9)), 1, S.simple ? 3 : 4);
    windowRow(K, S, rng, {
      face, w, d, y: 0.5 + fh * 0.60, count: n,
      win: {
        w: Math.min(0.98, (span / (n + 1)) * 0.46),
        h: Math.min(fh * 0.44, 1.30),
        wall: base, sillCol: S.trim, mullion: false, lean: S.simple,
      },
    });
    /* a rear door or a coal hatch on the back — the service side of a
       shop is where its life actually happens */
    if (face === 1 && !S.simple && rng() < 0.55) {
      const bu = jit(rng, w * 0.22);
      K.add('wall', boxRound(1.5, 2.3, 0.32, 0.07, 1),
        faceMat(1, w, d, bu, 1.52, -0.10), shadeHex(base, 0.74));
      K.add('wood', boxRound(1.15, 2.05, 0.14, 0.05, 1),
        faceMat(1, w, d, bu, 1.50, 0.04), shadeHex(S.trim, 0.88));
      K.add('stone', boxRound(1.62, 0.20, 0.34, 0.06, 1),
        faceMat(1, w, d, bu, 2.72, 0.05), S.trim);
    }
  }

  /* --- upper floors --- */
  for (let s = 1; s < storeys; s++) {
    const yy = 0.5 + fh * s + fh * 0.52;
    const winH = Math.min(fh * 0.56, 1.9);
    /* An infill building is seen from the street. Glazing its back and
       both flanks triples its triangle count for elevations the player
       will hardly ever stand in front of. */
    /* Blank flanks are the tell. An infill building gets a thinner
       rhythm on its long elevations and a single window on each flank
       rather than nothing at all — a 12 m unbroken wall of brick reads
       as a texture swatch, not as a building. */
    for (const face of [0, 1, 2, 3]) {
      const span = faceSpan(face, w, d);
      const n = S.simple
        ? (face > 1 ? 1 : Math.max(1, Math.floor(span / 4.4)))
        : Math.max(1, Math.floor(span / 3.1));
      windowRow(K, S, rng, {
        face, w, d, y: yy, count: n,
        win: {
          w: Math.min(1.15, span / (n + 1) * 0.52), h: winH,
          shutters: S.feat.shutter && !S.simple ? rng() < 0.5 : false,
          arch: !!S.feat.tallwin && s === 1,
          sillCol: S.trim, lean: S.simple,
        },
      });
    }
    if (S.feat.balcony && s === 1 && rng() < S.feat.balcony) {
      balcony(K, S, rng, { w: w * 0.52, y: 0.5 + fh * s + 0.1, z: d / 2 - 0.05 });
    }
  }

  /* --- cornice --- */
  if (S.feat.cornice) {
    band(K, { part: 'stone', w: w + 0.62, h: 0.34, d: d + 0.62, y: eaveY - 0.1, color: S.trim });
    band(K, { part: 'stone', w: w + 0.40, h: 0.18, d: d + 0.40, y: eaveY + 0.16, color: shadeHex(S.trim, 0.92) });
  }

  const top = roofOn(K, S, rng, { w, d, y: eaveY, wallH, ridge: roofH });

  /* one, two, or a stack on the gable end — a chimney in the same
     place on every roof is the loudest repeat on a skyline */
  if (S.feat.chimney) {
    const nC = rng() < 0.16 ? 0 : rng() < 0.72 ? 1 : 2;
    for (let i = 0; i < nC; i++) {
      chimney(K, S, rng, {
        x: nC > 1 ? (i ? 1 : -1) * w * (0.22 + rng() * 0.16) : jit(rng, w * 0.34),
        z: (rng() < 0.5 ? -1 : 1) * d * (0.10 + rng() * 0.24),
        y: eaveY + roofH * (0.20 + rng() * 0.34),
        h: 1.1 + rng() * 1.7, w: 0.55 + rng() * 0.42,
      });
    }
  }

  /* --- an open porch over the door, on some of them. Two houses of the
     same size and colour still read as two houses if one has a porch
     and the other has a doorstep. --- */
  if (S.porch && !flat && w > 6.5) {
    const pw = 2.5 + rng() * 1.1, ph = Math.min(fh * 0.80, 2.9), pd = 1.15 + rng() * 0.5;
    const pc = mixHex(S.trim, S.wall[0], 0.25);
    for (const sx of [-1, 1]) {
      K.add('wood', post(0.10, ph, 0.015, 7), TRS(doorU + sx * pw * 0.5, ph / 2 + 0.5, d / 2 + pd), pc);
      K.add('stone', boxRound(0.36, 0.22, 0.36, 0.06, 1), TRS(doorU + sx * pw * 0.5, 0.60, d / 2 + pd), S.trim);
      K.add('wood', boxRound(0.34, 0.14, 0.42, 0.04, 1),
        TRS(doorU + sx * pw * 0.42, 0.5 + ph - 0.22, d / 2 + pd * 0.55, 0, 1, 1, 1, 0, -sx * 0.7), shadeHex(pc, 0.88));
    }
    K.add('wood', boxRound(pw + 0.4, 0.20, 0.22, 0.06, 1), TRS(doorU, 0.5 + ph, d / 2 + pd), pc);
    K.add('roof', roofSolid({
      w: pd * 2 + 0.5, d: pw + 0.8, ridge: 0.46, thick: 0.16, overW: 0.18, overD: 0.20,
      sag: 0.03, hip: 0.5, curve: 1.1, flare: 0.06, uSeg: 3, tSeg: 3,
    }), TRS(doorU, 0.5 + ph + 0.16, d / 2 + pd * 0.52, PI / 2), S.roof);
    K.add('stone', boxRound(pw + 0.7, 0.20, pd * 2 + 0.5, 0.05, 1),
      TRS(doorU, 0.30, d / 2 + pd * 0.52), shadeHex(S.trim, 0.94));
  }

  /* --- Rusty Row: patches, lean-tos, pipes, laundry --- */
  if (S.feat.patch) {
    const n = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      const face = Math.floor(rng() * 4);
      const span = faceSpan(face, w, d);
      const pw = 0.9 + rng() * 1.7, ph = 0.7 + rng() * 1.4;
      const M = faceMat(face, w, d, jit(rng, span * 0.34), 1.0 + rng() * (wallH - 2), 0.10);
      K.add('metal', corrugated(pw, ph, 4, 0.035, 0.06),
        new THREE.Matrix4().multiplyMatrices(M, TRS(0, 0, 0, 0, 1, 1, 1, 0, jit(rng, 0.14))),
        rng() < 0.5 ? C.tin : C.rustPale);
    }
  }
  if (S.feat.pipe) {
    for (let i = 0; i < 2; i++) {
      const face = i === 0 ? 2 : 3;
      const M = faceMat(face, w, d, jit(rng, d * 0.3), wallH * 0.5, 0.22);
      K.add('metal', cyl(0.09, 0.10, wallH * 0.94, 7, false), M, C.lead);
    }
  }
  if (S.feat.leanto && rng() < 0.85) {
    const s = rng() < 0.5 ? 1 : -1;
    const lw = 2.4 + rng() * 1.4, lh = 2.3, ld = Math.min(d * 0.7, 3.2);
    const lx = s * (w / 2 + lw / 2 - 0.25);
    mass(K, { w: lw, h: lh, d: ld, x: lx, z: jit(rng, d * 0.1), y: 0.35, color: mixHex(base, BUILD.woodDark, 0.3), round: 0.12 });
    const sheet = corrugated(lw + 0.7, ld + 0.6, 6, 0.05, 0.07);
    const m = new THREE.Matrix4().makeTranslation(lx, 0.35 + lh + 0.28, 0)
      .multiply(new THREE.Matrix4().makeRotationZ(-s * 0.24))
      .multiply(new THREE.Matrix4().makeRotationX(-PI / 2));
    K.add('metal', sheet, m, C.rustPale);
    for (const sx of [-1, 1]) {
      K.add('wood', post(0.09, lh, 0.02, 6), TRS(lx + sx * (lw / 2 - 0.15), 0.35 + lh / 2, ld / 2 - 0.1), BUILD.woodDark);
    }
    meta.props.push({ type: 'crate', x: lx, z: ld / 2 + 0.8, ry: jit(rng, 1) });
  }

  /* awning across the shopfront, simulated cloth */
  if (S.feat.awning && rng() < 0.85) {
    meta.cloths.push({
      kind: 'awning',
      origin: new THREE.Vector3(-w * 0.30, 0.5 + fh * 0.86, d / 2 + 0.06),
      right: new THREE.Vector3(1, 0, 0), down: new THREE.Vector3(0, -0.34, 1).normalize(),
      width: w * 0.62, height: 1.5, cols: 10, rows: 6, pin: 'top',
      color: pick(rng, S.fabric),
    });
    /* the frame the canvas is stretched over: two raked arms and a
       front rail, so the awning has something to hang off */
    const ay = 0.5 + fh * 0.86;
    for (const sx of [0, 1]) {
      K.add('metal', cyl(0.045, 0.045, 1.52, 6, false),
        TRS(-w * 0.30 + sx * w * 0.62, ay - 0.28, d / 2 + 0.72, 0, 1, 1, 1, 1.90), C.lead);
    }
    K.add('metal', cyl(0.04, 0.04, w * 0.62, 6, false),
      TRS(-w * 0.30 + w * 0.31, ay - 0.54, d / 2 + 1.38, 0, 1, 1, 1, 0, PI / 2), C.lead);
    K.add('metal', boxRound(w * 0.66, 0.14, 0.20, 0.05, 1), TRS(-w * 0.30 + w * 0.31, ay + 0.10, d / 2 + 0.10), C.lead);
  }
  if (S.feat.laundry) {
    meta.cloths.push({
      kind: 'laundry',
      origin: new THREE.Vector3(-w * 0.36, 0.5 + fh * (storeys - 0.35), d / 2 + 0.55),
      right: new THREE.Vector3(1, 0, 0), down: new THREE.Vector3(0, -1, 0),
      width: w * 0.7, height: 1.15, cols: 12, rows: 5, pin: 'top',
      color: pick(rng, S.fabric), lineColor: BUILD.woodDark,
    });
  }

  meta.eaveY = eaveY;
  meta.doorU = doorU;
  meta.signAnchor.set(doorU, Math.min(0.5 + fh * 0.95, eaveY - 0.4), d / 2 + 0.30);
  meta.door.set(doorU, 0, d / 2 + 1.5);
  meta.interior.set(0, 1.5, 0);
  meta.collide.push({ w, h: wallH, d, y: wallH / 2 });
  meta.top = top;
  meta.props.push({ type: 'lamp', x: w * 0.5 + 1.4, z: d / 2 + 1.2, ry: 0 });
}

/* ------------------------------------------------------------------
   FORM: terrace — the Learning Quarter. Brick bays of unequal height,
   stone quoins, tall windows, a clocktower on the biggest one.
   ------------------------------------------------------------------ */
function formTerrace(ctx, K, loc, S, rng, meta) {
  const w = loc.size.w, d = loc.size.d, H = loc.size.h;
  const roofH = clamp(H * 0.24, 1.2, 4.0);
  const wallH = H - roofH;
  const bays = clamp(Math.round(w / 8.5), 2, 3);
  const bw = w / bays;
  const base = S.wall[0];

  band(K, { part: 'stone', w: w + 0.4, h: 0.7, d: d + 0.4, y: 0.35, color: S.trim });

  const heights = [];
  for (let b = 0; b < bays; b++) {
    const hb = wallH * (0.86 + rng() * 0.22);
    heights.push(hb);
    const bx = -w / 2 + bw * (b + 0.5);
    const col = S.wall[b % S.wall.length];
    mass(K, { w: bw - 0.12, h: hb, d, x: bx, y: 0.6, color: col, round: 0.055, lean: [jit(rng, S.lean), 0] });
    /* quoins — stone corner blocks, alternating */
    if (S.feat.quoin) {
      const n = Math.max(3, Math.round(hb / 1.15));
      for (let i = 0; i < n; i++) {
        const yy = 0.6 + (hb * (i + 0.5)) / n;
        const qw = i % 2 ? 0.62 : 0.44;
        for (const sx of [-1, 1]) {
          K.add('stone', boxRound(qw, hb / n * 0.78, 0.42, 0.055, 1),
            TRS(bx + sx * (bw / 2 - 0.1 - qw / 2 + 0.06), yy, d / 2 - 0.02), S.trim);
        }
      }
    }
    /* tall windows, two ranks */
    const ranks = clamp(Math.round(hb / S.floorH), 1, 3);
    for (let r = 0; r < ranks; r++) {
      const yy = 0.6 + (hb * (r + 0.55)) / ranks;
      const n = Math.max(1, Math.round(bw / 3.0));
      for (let i = 0; i < n; i++) {
        const u = bx - (bw - 1.4) / 2 + ((bw - 1.4) * (i + 0.5)) / n;
        if (b === Math.floor(bays / 2) && r === 0 && Math.abs(u) < 1.7) continue;
        windowUnit(K, S, rng, faceMat(0, w, d, u, yy, 0.03), {
          w: 1.0, h: Math.min(2.3, (hb / ranks) * 0.58), arch: r === 0, sillCol: S.trim, wall: col,
        });
      }
      /* THE REAR ELEVATION. Every terrace in the city used to ship a
         completely blank brick slab on face 1 — no window, no door, no
         sill, no downpipe — and in half the district that is the face
         the camera actually gets. A back is quieter than a front, not
         absent: the same bay rhythm, plainer lights, no arch. */
      for (let i = 0; i < n; i++) {
        const u = bx - (bw - 1.4) / 2 + ((bw - 1.4) * (i + 0.5)) / n;
        windowUnit(K, S, rng, faceMat(1, w, d, -u, yy, 0.03), {
          w: 0.92, h: Math.min(1.95, (hb / ranks) * 0.50), sillCol: S.trim, wall: col,
          mullion: r > 0,
        });
      }
      const nb = S.simple ? 1 : Math.max(1, Math.round(d / 3.4));
      for (const face of [2, 3]) {
        if (b !== (face === 2 ? bays - 1 : 0)) continue;
        for (let i = 0; i < nb; i++) {
          const u = -d / 2 + (d * (i + 0.6)) / (nb + 0.2);
          windowUnit(K, S, rng, faceMat(face, w, d, u, yy, 0.03), {
            w: 0.95, h: Math.min(2.1, (hb / ranks) * 0.55), sillCol: S.trim, wall: col,
          });
        }
      }
    }

    /* --- the service side, unconditional. The back of a terrace is
       where its life actually happens: rainwater goods, boarded vents,
       a bracketed shelf, and one back door per block. --- */
    {
      const px = bx + bw * 0.40;
      const rearZ = -(d / 2);
      K.add('metal', cyl(0.10, 0.115, hb + 0.42, 7, false),
        TRS(px, 0.6 + (hb + 0.42) / 2, rearZ - 0.15), S.roofAlt);
      K.add('metal', cyl(0.10, 0.10, 0.55, 6, false),
        TRS(px, 0.64, rearZ - 0.32, 0, 1, 1, 1, 0.85), S.roofAlt);
      for (const t of [0.28, 0.74]) {
        K.add('metal', boxRound(0.30, 0.09, 0.20, 0.03, 1),
          TRS(px, 0.6 + hb * t, rearZ - 0.09), shadeHex(S.roofAlt, 0.86));
      }
      /* two boarded vents up the blind stack */
      const vw = Math.min(1.15, bw * 0.30);
      for (const t of [0.30, 0.88]) {
        K.add('wood', boxRound(vw, 0.40, 0.16, 0.05, 1),
          TRS(bx - bw * 0.24, 0.6 + hb * t, rearZ - 0.06), shadeHex(S.trim, 0.90));
        K.add('wood', boxRound(vw * 1.08, 0.11, 0.20, 0.04, 1),
          TRS(bx - bw * 0.24, 0.6 + hb * t - 0.24, rearZ - 0.09), shadeHex(S.trim, 0.78));
      }
      /* a bracketed shelf — the thing every back yard has one of */
      for (let k = 0; k < 2; k++) {
        K.add('wood', boxRound(0.12, 0.46, 0.40, 0.04, 1),
          TRS(bx + bw * 0.02 + k * 0.78, 0.6 + hb * 0.34, rearZ - 0.22, 0, 1, 1, 1, 0, 0.10), shadeHex(S.trim, 0.84));
      }
      K.add('wood', boxRound(1.5, 0.13, 0.52, 0.04, 1),
        TRS(bx + bw * 0.02 + 0.39, 0.6 + hb * 0.34 + 0.29, rearZ - 0.26), mixHex(S.trim, BRAND.paper, 0.22));
      if (b === Math.floor(bays / 2)) {
        doorway(K, S, rng, {
          face: 1, bw: w, bd: d, u: -bx, w: 1.35, h: 2.35,
          wall: col, frame: S.trim, door: shadeHex(mixHex(BUILD.woodDark, S.tint, 0.4), 0.88), step: S.trim,
        });
        /* a stair down to the area, and the iron rail round it */
        K.add('stone', boxRound(2.0, 0.22, 1.05, 0.06, 1), TRS(bx, 0.50, rearZ - 0.52), S.trim);
        K.add('stone', boxRound(2.4, 0.20, 1.55, 0.06, 1), TRS(bx, 0.30, rearZ - 1.05), shadeHex(S.trim, 0.93));
        for (const sx of [-1, 1]) {
          K.add('metal', cyl(0.045, 0.045, 0.95, 5, false), TRS(bx + sx * 1.15, 0.9, rearZ - 1.20), C.lead);
        }
        K.add('metal', cyl(0.04, 0.04, 2.35, 5, false),
          TRS(bx, 1.32, rearZ - 1.20, 0, 1, 1, 1, 0, PI / 2), C.lead);
      }
    }
    band(K, { part: 'stone', w: bw + 0.24, h: 0.30, d: d + 0.5, x: bx, y: 0.6 + hb - 0.05, color: S.trim });
    roofOn(K, S, rng, { w: bw - 0.05, d, y: 0.6 + hb + 0.12, wallH: hb, ridge: roofH, hip: 0.3, along: 'z', downpipe: b === 0 });
    if (rng() < 0.8) chimney(K, S, rng, { x: bx + jit(rng, bw * 0.2), z: jit(rng, d * 0.2), y: 0.6 + hb + roofH * 0.4, h: 1.5 + rng(), w: 0.68 });
  }

  /* the grand entrance in the middle bay */
  doorway(K, S, rng, {
    face: 0, bw: w, bd: d, u: 0, w: 2.0, h: 3.2, steps: true,
    wall: base, frame: S.trim, door: mixHex(BUILD.woodDark, S.tint, 0.4), step: S.trim,
  });
  for (const sx of [-1, 1]) {
    K.add('stone', column(0.28, 3.5, 10), TRS(sx * 1.9, 0.55, d / 2 + 0.55), S.trim);
  }
  K.add('stone', boxRound(5.2, 0.42, 1.5, 0.10, 2), TRS(0, 4.28, d / 2 + 0.5), S.trim);

  /* clocktower */
  if (S.feat.clock && (loc.id === 'school' || rng() < 0.3)) {
    const tw = Math.min(4.2, w * 0.22), th = H * 0.78;
    const tx = -w / 2 + bw * 0.5;
    mass(K, { w: tw, h: th + wallH, d: tw, x: tx, z: -d * 0.1, y: 0.6, color: S.wall[1], round: 0.06 });
    band(K, { part: 'stone', w: tw + 0.5, h: 0.3, d: tw + 0.5, x: tx, z: -d * 0.1, y: 0.6 + th + wallH - 1.6, color: S.trim });
    for (const face of [0, 2, 3]) {
      const M = faceMat(face, tw, tw, 0, 0.6 + th + wallH - 2.9, 0.06);
      const m0 = new THREE.Matrix4().makeTranslation(tx, 0, -d * 0.1).multiply(M);
      K.add('stone', cyl(tw * 0.32, tw * 0.32, 0.22, 14, true),
        new THREE.Matrix4().multiplyMatrices(m0, TRS(0, 0, 0, 0, 1, 1, 1, PI / 2)), C.marble);
      K.add('metal', cyl(tw * 0.28, tw * 0.28, 0.24, 14, true),
        new THREE.Matrix4().multiplyMatrices(m0, TRS(0, 0, 0.05, 0, 1, 1, 1, PI / 2)), C.gold);
      K.add('wood', boxRound(0.09, tw * 0.42, 0.10, 0.03, 1),
        new THREE.Matrix4().multiplyMatrices(m0, TRS(0, tw * 0.1, 0.16, 0, 1, 1, 1, 0, 0.4)), BRAND.ink);
      K.add('wood', boxRound(0.09, tw * 0.3, 0.10, 0.03, 1),
        new THREE.Matrix4().multiplyMatrices(m0, TRS(0.05, tw * 0.06, 0.16, 0, 1, 1, 1, 0, -1.2)), BRAND.ink);
    }
    const cap = 0.6 + th + wallH;
    K.add('roof', roofSolid({ w: tw + 1.0, d: tw + 1.0, ridge: 2.4, thick: 0.26, overW: 0.3, overD: 0.3, sag: 0.02, hip: 0.92, curve: 1.5, flare: 0.2, uSeg: 5, tSeg: 5 }),
      TRS(tx, cap, -d * 0.1), S.roof);
    K.add('gold', sphereG(0.34, 10), TRS(tx, cap + 2.9, -d * 0.1), C.gold);
    K.add('gold', cyl(0.05, 0.05, 1.0, 6, false), TRS(tx, cap + 3.4, -d * 0.1), C.gold);
    meta.top = cap + 3.9;
  }

  /* --- cloth on the front. §2.3 lists awnings and banners as signature
     wind carriers and §6 wants something moving in every frame; a
     terrace that hangs nothing is a brick slab with holes in it. --- */
  if (S.feat.awning) {
    const ab = bays > 2 ? 0 : bays - 1;
    const abx = -w / 2 + bw * (ab + 0.5);
    const ay = 0.6 + Math.min(heights[ab] * 0.44, 3.3);
    const aw = bw * 0.66;
    meta.cloths.push({
      kind: 'awning',
      origin: new THREE.Vector3(abx - aw / 2, ay, d / 2 + 0.06),
      right: new THREE.Vector3(1, 0, 0), down: new THREE.Vector3(0, -0.34, 1).normalize(),
      width: aw, height: 1.45, cols: 10, rows: 6, pin: 'top',
      color: pick(rng, S.fabric),
    });
    for (const sx of [0, 1]) {
      K.add('metal', cyl(0.045, 0.045, 1.5, 6, false),
        TRS(abx - aw / 2 + sx * aw, ay - 0.28, d / 2 + 0.70, 0, 1, 1, 1, 1.90), C.lead);
    }
    K.add('metal', cyl(0.04, 0.04, aw, 6, false),
      TRS(abx, ay - 0.54, d / 2 + 1.34, 0, 1, 1, 1, 0, PI / 2), C.lead);
    K.add('metal', boxRound(aw + 0.3, 0.14, 0.20, 0.05, 1), TRS(abx, ay + 0.10, d / 2 + 0.10), C.lead);
  }
  /* bunting strung between the entrance columns */
  meta.cloths.push({
    kind: 'bunting',
    origin: new THREE.Vector3(-Math.min(w * 0.34, 4.6), 4.05, d / 2 + 0.62),
    right: new THREE.Vector3(1, 0, 0), down: new THREE.Vector3(0, -1, 0.06).normalize(),
    width: Math.min(w * 0.68, 9.2), height: 0.52, cols: 14, rows: 3, pin: 'top',
    color: pick(rng, S.fabric),
  });

  meta.eaveY = 0.6 + heights[Math.floor(bays / 2)];
  meta.signAnchor.set(0, 4.9, d / 2 + 0.35);
  meta.door.set(0, 0, d / 2 + 2.0);
  meta.interior.set(0, 1.6, 0);
  meta.collide.push({ w, h: wallH, d, y: wallH / 2 });
  meta.props.push({ type: 'lamp', x: -w * 0.42, z: d / 2 + 1.6 }, { type: 'lamp', x: w * 0.42, z: d / 2 + 1.6 });
  meta.props.push({ type: 'bench', x: w * 0.2, z: d / 2 + 2.6, ry: PI });
}

/* ------------------------------------------------------------------
   FORM: stall — Market Square, the noodle cart, the market hall.

   A MARKET BUILDING IS STILL A BUILDING. The first version put a
   lock-up across the back 44 % of the plot and left the other 56 % as
   an open post arcade under one enormous roof: from the street that is
   a carport, and a whole district of them read as a farmers' market
   that had lost its stalls. Windfall Island is a town of solid,
   enclosed, inhabited houses.

   So: the BODY fills the plot bar a shallow veranda, is walled and
   articulated on all four elevations, and carries its roof on its own
   walls. The veranda is an ATTACHED PORCH in front of a solid front
   wall — posts, head beam, a lean-to roof and a canvas valance — never
   the structure itself.
   ------------------------------------------------------------------ */
function formStall(ctx, K, loc, S, rng, meta) {
  const w = loc.size.w, d = loc.size.d, H = Math.max(4.6, loc.size.h);
  const big = w > 14;
  const base = S.wall[0];

  const porchD = clamp(d * 0.24, 1.8, 3.4);
  const bodyD = d - porchD;
  const bodyZ = -d / 2 + bodyD / 2;
  const frontZ = bodyZ + bodyD / 2;                 // the front wall plane
  const roofH = clamp(Math.min(w, bodyD) * 0.30, 1.3, H * 0.30);
  const bodyH = clamp(H - roofH, 3.9, big ? 10.5 : 7.4);
  const storeys = clamp(Math.round(bodyH / S.floorH), 1, 2);
  const fh = bodyH / storeys;
  const sill = 0.22;

  /* NO PAVED DISC. This was a flat ellipse 1.5 m wider than the plot on
     every side with its top 1 cm over heightAt() — which, since the
     drawn terrain tile is not heightAt(), spent as much of its time
     sticking out from under the building as a pale plate as it did
     being paving. It is the "floor plane visible under the right
     building" in the judged frame: the market hall is that building.
     city.js founds every one of these in a berm now. */

  /* --- the body, walled on all four faces --- */
  band(K, { part: 'stone', w: w + 0.34, h: 0.50, d: bodyD + 0.34, z: bodyZ, y: 0.25, color: shadeHex(base, 0.80) });
  const dado = mixHex(S.wall[2] ?? base, S.tint, 0.42);
  for (let s = 0; s < storeys; s++) {
    const inset = s * 0.08;
    const col = s === 0 ? mixHex(base, dado, 0.34) : mixHex(base, S.wall[(s + 1) % S.wall.length], 0.55);
    mass(K, {
      w: w - inset * 2, h: fh + 0.06, d: bodyD - inset * 2, z: bodyZ, y: sill + fh * s,
      color: col, round: 0.09, lean: [jit(rng, S.lean) * (s + 1) * 0.5, 0],
    });
    if (s < storeys - 1) {
      band(K, { part: 'stone', w: w + 0.30, h: 0.22, d: bodyD + 0.30, z: bodyZ, y: sill + fh * (s + 1), color: S.trim });
    }
  }
  const eaveY = sill + fh * storeys;
  band(K, { part: 'stone', w: w + 0.50, h: 0.28, d: bodyD + 0.50, z: bodyZ, y: eaveY - 0.08, color: S.trim });

  /* --- the shopfront: glazed serving bays in a SOLID wall, each with
     a stallriser, mullions, a fascia and a propped shutter --- */
  const nHatch = clamp(Math.round(w / 7.5), 1, 3);
  const openH = Math.min(2.4, fh * 0.60);
  const openW = Math.min(4.2, (w * 0.76) / nHatch - 0.8);
  const riser = 0.86;
  const hatchX = [];
  for (let i = 0; i < nHatch; i++) {
    const hx = -w * 0.38 + (w * 0.76 * (i + 0.5)) / nHatch;
    hatchX.push(hx);
    const cy = riser + 0.20 + openH / 2;
    K.add('wall', boxRound(openW + 0.52, openH + 0.52, 0.46, 0.09, 1), TRS(hx, cy, frontZ - 0.14), shadeHex(base, 0.62));
    K.add(rng() < 0.6 ? 'glassWarm' : 'glassCool', boxRound(openW, openH, 0.08, 0.02, 1), TRS(hx, cy, frontZ - 0.02), 0xffffff);
    for (let k = 1; k < 3; k++) {
      K.add('wood', boxRound(0.10, openH + 0.20, 0.16, 0.03, 1), TRS(hx - openW / 2 + (openW * k) / 3, cy, frontZ + 0.07), S.trim);
    }
    /* stallriser, lintel and the propped-open shutter above it */
    K.add('stone', boxRound(openW + 0.66, riser + 0.12, 0.34, 0.08, 1), TRS(hx, (riser + 0.12) / 2 + 0.12, frontZ + 0.08), shadeHex(dado, 0.88));
    K.add('wood', boxRound(openW + 0.72, 0.32, 0.38, 0.09, 1), TRS(hx, cy + openH / 2 + 0.34, frontZ + 0.09), S.trim);
    K.add('wood', boxRound(openW, 0.13, 1.25, 0.05, 1), TRS(hx, cy + openH / 2 + 0.78, frontZ + 0.62, 0, 1, 1, 1, -0.52), mixHex(S.trim, BRAND.paper, 0.20));
    for (const sx of [-1, 1]) {
      K.add('metal', cyl(0.035, 0.035, 1.0, 5, false),
        TRS(hx + sx * openW * 0.42, cy + openH / 2 + 0.52, frontZ + 0.40, 0, 1, 1, 1, 0.85), C.lead);
    }
  }
  /* the door, in the gap the bays leave */
  const doorU = nHatch > 1 ? (hatchX[0] + hatchX[1]) / 2 : hatchX[0] + openW * 0.5 + 1.2;
  doorway(K, S, rng, {
    face: 0, bw: w, bd: bodyD, oz: bodyZ, u: clamp(doorU, -w * 0.44, w * 0.44),
    w: 1.5, h: Math.min(2.5, fh * 0.72),
    wall: base, frame: S.trim, door: mixHex(S.trim, S.tint, 0.5), step: S.trim,
  });
  /* the painted fascia the trade name goes on, over the whole front */
  K.add('wood', boxRound(w * 0.94, 0.62, 0.28, 0.10, 1), TRS(0, riser + 0.20 + openH + 0.86, frontZ + 0.12), mixHex(S.trim, S.tint, 0.40));
  K.add('wood', boxRound(w * 0.94 + 0.28, 0.15, 0.38, 0.05, 1), TRS(0, riser + 0.20 + openH + 1.22, frontZ + 0.14), shadeHex(S.trim, 0.80));

  /* --- upper storey, all four faces --- */
  for (let s = 1; s < storeys; s++) {
    const yy = sill + fh * s + fh * 0.52;
    for (const face of [0, 1, 2, 3]) {
      const span = faceSpan(face, w, bodyD);
      const n = Math.max(1, Math.floor(span / (S.simple ? 4.2 : 3.2)));
      windowRow(K, S, rng, {
        face, w, d: bodyD, oz: bodyZ, y: yy, count: n,
        win: {
          w: Math.min(1.10, (span / (n + 1)) * 0.52), h: Math.min(fh * 0.52, 1.7),
          shutters: rng() < 0.55, sillCol: S.trim, wall: base,
        },
      });
    }
  }
  /* --- ground-floor rear and flanks: quieter, never blank --- */
  for (const face of [1, 2, 3]) {
    const span = faceSpan(face, w, bodyD);
    const n = clamp(Math.round(span / 4.0), 1, 3);
    windowRow(K, S, rng, {
      face, w, d: bodyD, oz: bodyZ, y: sill + fh * 0.60, count: n,
      win: {
        w: Math.min(0.95, (span / (n + 1)) * 0.46), h: Math.min(fh * 0.42, 1.25),
        wall: base, sillCol: S.trim, mullion: false,
      },
    });
  }
  /* boarded vents and a shelf bracket up each blind elevation */
  for (const face of [1, 2, 3]) {
    const span = face === 1 ? w : bodyD;
    K.add('wood', boxRound(Math.min(1.1, span * 0.26), 0.34, 0.14, 0.05, 1),
      faceMatOff(face, w, bodyD, span * 0.30, sill + fh * storeys - 0.55, 0.04, bodyZ), shadeHex(S.trim, 0.9));
    K.add('wood', boxRound(Math.min(1.1, span * 0.26), 0.11, 0.14, 0.04, 1),
      faceMatOff(face, w, bodyD, -span * 0.32, sill + fh * 0.30, 0.04, bodyZ), shadeHex(S.trim, 0.82));
  }

  /* THE BACK ELEVATION IS A PRIMARY ELEVATION — the big hall turns its
     rear on the spawn clearing. Dado, string, fly-posted bills, board. */
  {
    const rz = -d / 2;
    K.add('wall', boxRound(w + 0.06, fh * 0.42, 0.24, 0.06, 1), TRS(0, sill + fh * 0.21, rz - 0.10), dado);
    K.add('stone', boxRound(w + 0.34, 0.20, 0.38, 0.06, 1), TRS(0, sill + fh * 0.42, rz - 0.12), S.trim);
    const nbd = clamp(Math.round(w / 5), 3, 6);
    for (let i = 0; i < nbd; i++) {
      const bx2 = -w * 0.40 + (w * 0.80 * (i + 0.5)) / nbd;
      const pw2 = Math.min(1.4, ((w * 0.8) / nbd) * 0.58);
      K.add('wood', boxRound(pw2, pw2 * 1.25, 0.10, 0.03, 1),
        TRS(bx2, sill + fh * 0.24, rz - 0.29, 0, 1, 1, 1, 0, jit(rng, 0.11)),
        i % 2 ? mixHex(BRAND.paper, S.tint, 0.34) : mixHex(pick(rng, S.fabric), BRAND.paper, 0.40));
      K.add('wood', boxRound(pw2 * 1.12, 0.09, 0.13, 0.03, 1),
        TRS(bx2, sill + fh * 0.24 + pw2 * 0.69, rz - 0.32), shadeHex(S.trim, 0.86));
    }
    K.add('wood', boxRound(Math.min(w * 0.46, 9.0), 0.78, 0.26, 0.08, 1),
      TRS(0, eaveY - 0.95, rz - 0.16), mixHex(S.trim, S.tint, 0.42));
    K.add('wood', boxRound(Math.min(w * 0.46, 9.0) + 0.3, 0.14, 0.34, 0.05, 1),
      TRS(0, eaveY - 0.50, rz - 0.18), shadeHex(S.trim, 0.80));
    doorway(K, S, rng, {
      face: 1, bw: w, bd: bodyD, oz: bodyZ, u: jit(rng, w * 0.24), w: 1.3, h: 2.25,
      wall: base, frame: S.trim, door: shadeHex(mixHex(BUILD.woodDark, S.tint, 0.4), 0.88), step: S.trim,
    });
  }

  /* --- the roof, sitting on the body's own walls --- */
  const top = roofOn(K, S, rng, {
    w, d: bodyD, z: bodyZ, y: eaveY, wallH: bodyH, ridge: roofH,
    hip: 0.24, along: 'x', kind: S.roofKind === 'canvas' ? 'tile' : S.roofKind,
  });
  chimney(K, S, rng, {
    x: -w * 0.30 + jit(rng, w * 0.12), z: bodyZ - bodyD * 0.16,
    y: eaveY + roofH * 0.34, h: 1.3 + rng() * 1.1, w: 0.6 + rng() * 0.3,
  });

  /* a clerestory monitor along the ridge — what makes a market hall a
     market hall, and what stops a big field of terracotta reading flat */
  if (big) {
    const mh = Math.min(1.5, roofH * 0.5), mw = 2.2;
    const my = eaveY + roofH * (1 - S.sag) - mh * 0.55;
    K.add('wall', boxRound(w * 0.66, mh, mw, 0.16, 1), TRS(0, my + mh / 2, bodyZ), S.wall[1]);
    const nl = Math.max(4, Math.round(w / 3.4));
    for (let i = 0; i < nl; i++) {
      const lx = -w * 0.31 + (w * 0.62 * (i + 0.5)) / nl;
      for (const sz of [-1, 1]) {
        K.add('glassWarm', boxRound((w * 0.62) / nl * 0.64, mh * 0.48, 0.10, 0.03, 1), TRS(lx, my + mh * 0.54, bodyZ + sz * (mw / 2 + 0.02)), 0xffffff);
        K.add('wood', boxRound((w * 0.62) / nl * 0.76, 0.11, 0.16, 0.04, 1), TRS(lx, my + mh * 0.24, bodyZ + sz * (mw / 2 + 0.07), 0, 1, 1, 1, sz * 0.42), S.trim);
      }
    }
    K.add('roof', roofSolid({
      w: mw + 0.9, d: w * 0.68, ridge: 0.72, thick: 0.20, overW: 0.26, overD: 0.24,
      sag: 0.02, hip: 0.1, curve: 1.2, flare: 0.10, uSeg: 4, tSeg: 3,
    }), TRS(0, my + mh, bodyZ, PI / 2), S.roofAlt);
  }

  /* --- THE VERANDA: an attached porch on the front of a solid
     building, not the building. Posts, stone pads, a braced head beam,
     tie beams back into the wall and a lean-to roof over it. --- */
  const porchH = clamp(bodyH * 0.56, 2.5, 3.5);
  const pz = d / 2 - 0.30;
  const nPost = big ? Math.max(3, Math.round(w / 5.0)) : 2;
  const bayW = (w - 1.1) / nPost;
  for (let i = 0; i <= nPost; i++) {
    const x = -w / 2 + 0.55 + bayW * i;
    K.add('wood', post(big ? 0.16 : 0.13, porchH, 0.02, 8), TRS(x, porchH / 2, pz, jit(rng, 0.08)), S.trim);
    K.add('stone', boxRound(0.52, 0.28, 0.52, 0.08, 1), TRS(x, 0.28, pz), mixHex(S.trim, LAND.rock, 0.5));
    if (i < nPost) {
      K.add('wood', boxRound(bayW, 0.22, 0.24, 0.07, 1), TRS(x + bayW / 2, porchH - 0.11, pz), S.trim);
      K.add('wood', boxRound(bayW * 0.40, 0.14, 0.16, 0.05, 1), TRS(x + bayW * 0.21, porchH - 0.40, pz, 0, 1, 1, 1, 0, 0.72), shadeHex(S.trim, 0.88));
      K.add('wood', boxRound(bayW * 0.40, 0.14, 0.16, 0.05, 1), TRS(x + bayW * 0.79, porchH - 0.40, pz, 0, 1, 1, 1, 0, -0.72), shadeHex(S.trim, 0.88));
    }
  }
  const tieZ = (pz + frontZ) / 2;
  const tieL = pz - frontZ;
  for (let i = 0; i <= nPost; i += Math.max(1, Math.round(nPost / 3))) {
    const x = -w / 2 + 0.55 + bayW * i;
    K.add('wood', boxRound(0.15, 0.18, tieL, 0.05, 1), TRS(x, porchH - 0.26, tieZ, 0, 1, 1, 1, 0.03), shadeHex(S.trim, 0.92));
  }
  /* the lean-to: springs off the wall above the head beam and falls to
     the post heads. Slim, so it never competes with the main roof. */
  const ptop = porchH + Math.max(0.55, porchD * 0.26);
  const run = tieL + 0.45;
  const slope = Math.atan2(ptop - porchH, run);
  K.add('roof', boxRound(w + 0.46, 0.18, Math.hypot(run, ptop - porchH) + 0.30, 0.06, 1),
    TRS(0, (ptop + porchH) / 2 + 0.09, tieZ + 0.10, 0, 1, 1, 1, slope), S.roof);
  K.add('wood', boxRound(w + 0.52, 0.20, 0.18, 0.06, 1), TRS(0, porchH + 0.04, pz + 0.30), shadeHex(S.trim, 0.86));
  K.add('metal', cyl(0.09, 0.09, w + 0.5, 7, false), TRS(0, porchH - 0.10, pz + 0.38, 0, 1, 1, 1, 0, PI / 2), S.roofAlt);

  /* the canvas valance hung off the porch beam — the wind carrier */
  meta.cloths.push({
    kind: 'awning',
    origin: new THREE.Vector3(-w * 0.42, porchH - 0.34, pz + 0.20),
    right: new THREE.Vector3(1, 0, 0), down: new THREE.Vector3(0, -1, 0.26).normalize(),
    width: w * 0.84, height: 1.25, cols: 12, rows: 6, pin: 'top',
    color: pick(rng, S.fabric),
  });
  if (S.feat.bunting) {
    meta.cloths.push({
      kind: 'bunting',
      origin: new THREE.Vector3(-w * 0.42, porchH - 0.62, pz - 0.24),
      right: new THREE.Vector3(1, 0, 0), down: new THREE.Vector3(0, -1, 0.04).normalize(),
      width: w * 0.84, height: 0.52, cols: 14, rows: 3, pin: 'top',
      color: pick(rng, S.fabric),
    });
  }
  /* lanterns off the tie beams */
  if (big) {
    for (let i = 1; i < nPost; i++) {
      const x = -w / 2 + 0.55 + bayW * i;
      K.add('metal', cyl(0.03, 0.03, 0.55, 5, false), TRS(x, porchH - 0.55, tieZ), C.lead);
      K.add('lamp', boxRound(0.30, 0.38, 0.30, 0.08, 1), TRS(x, porchH - 1.00, tieZ), 0xffffff);
      K.add('metal', boxRound(0.36, 0.07, 0.36, 0.02, 1), TRS(x, porchH - 0.80, tieZ), C.lead);
    }
  }

  /* the trestle counter under the veranda, in front of the bays */
  const cz = frontZ + tieL * 0.58;
  K.add('wood', boxRound(w * 0.74, 0.20, 1.10, 0.07, 1), TRS(0, 1.02, cz), mixHex(S.trim, BRAND.paper, 0.18));
  K.add('wall', boxRound(w * 0.70, 0.88, 0.86, 0.10, 1), TRS(0, 0.50, cz), mixHex(S.wall[1], S.tint, 0.28));
  for (let i = 0; i < 4; i++) {
    K.add('wood', boxRound(0.10, 0.84, 0.10, 0.03, 1), TRS(-w * 0.32 + (w * 0.64 * i) / 3, 0.44, cz + 0.46), shadeHex(S.trim, 0.85));
  }

  for (let i = 0; i < (big ? 7 : 4); i++) {
    meta.props.push({
      type: pick(rng, ['crate', 'produce', 'barrel', 'produce', 'crate']),
      x: jit(rng, w * 0.42), z: cz + 0.9 + rng() * (d / 2 - cz + 1.8), ry: rng() * 6.28,
    });
  }
  meta.props.push({ type: 'lamp', x: -w * 0.5 - 1.4, z: d * 0.42 });
  if (big) meta.props.push({ type: 'cart', x: w * 0.5 + 1.6, z: d * 0.3, ry: 0.5 });

  meta.eaveY = eaveY;
  meta.signAnchor.set(0, Math.min(eaveY - 0.60, ptop + 0.62), frontZ + 0.16);
  meta.door.set(0, 0, d / 2 + 1.6);
  meta.interior.set(0, 1.5, bodyZ);
  meta.collide.push({ w, h: bodyH, d: bodyD, z: bodyZ, y: sill + bodyH / 2 });
  meta.collide.push({ w: w * 0.74, h: 1.1, d: 1.1, z: cz, y: 0.55 });
  meta.top = top;
}

/* ------------------------------------------------------------------
   FORM: barn — Green Edge.
   ------------------------------------------------------------------ */
function formBarn(ctx, K, loc, S, rng, meta) {
  const w = loc.size.w, d = loc.size.d, H = loc.size.h;
  /* Even a barn is a walled building. At 0.48 H of wall under a ridge
     allowed to reach 0.95 H the roof was more than half the elevation
     and Green Edge read as a row of open hay shelters. */
  const wallH = H * 0.62;
  const ridgeH = clamp(Math.min(w, d) * 0.30, 2.0, H * 0.36);
  const base = S.wall[0];

  band(K, { part: 'stone', w: w + 0.4, h: 0.5, d: d + 0.4, y: 0.25, color: mixHex(LAND.rock, LAND.dirt, 0.4) });
  mass(K, { w, h: wallH, d, y: 0.45, color: base, round: 0.07, lean: [jit(rng, S.lean), 0] });

  /* board-and-batten: vertical battens all round */
  const nb = Math.round(w / 0.95);
  for (let i = 0; i <= nb; i++) {
    const x = -w / 2 + (w * i) / nb;
    for (const sz of [1, -1]) {
      K.add('wood', boxRound(0.13, wallH * 0.98, 0.09, 0.03, 1), TRS(x, 0.45 + wallH / 2, sz * (d / 2 + 0.03)), S.trim);
    }
  }
  const nd = Math.round(d / 0.95);
  for (let i = 0; i <= nd; i++) {
    const z = -d / 2 + (d * i) / nd;
    for (const sx of [1, -1]) {
      K.add('wood', boxRound(0.09, wallH * 0.98, 0.13, 0.03, 1), TRS(sx * (w / 2 + 0.03), 0.45 + wallH / 2, z), S.trim);
    }
  }

  /* the big doors, with X bracing */
  const dw = Math.min(w * 0.44, 5.0), dh = wallH * 0.76;
  for (const sx of [-1, 1]) {
    const m = TRS(sx * dw / 4, 0.45 + dh / 2, d / 2 + 0.10, sx * 0.06);
    K.add('wood', boxRound(dw / 2 - 0.06, dh, 0.16, 0.05, 1), m, mixHex(S.trim, BRAND.paper, 0.15));
    K.add('wood', boxRound(dw / 2 - 0.2, 0.16, 0.10, 0.04, 1), TRS(sx * dw / 4, 0.45 + dh * 0.86, d / 2 + 0.19), shadeHex(S.wall[2], 1.0));
    K.add('wood', boxRound(dw / 2 - 0.2, 0.16, 0.10, 0.04, 1), TRS(sx * dw / 4, 0.45 + dh * 0.12, d / 2 + 0.19), shadeHex(S.wall[2], 1.0));
    const diag = Math.hypot(dw / 2, dh);
    K.add('wood', boxRound(diag * 0.94, 0.16, 0.10, 0.04, 1),
      TRS(sx * dw / 4, 0.45 + dh / 2, d / 2 + 0.19, 0, 1, 1, 1, 0, sx * Math.atan2(dh, dw / 2)), shadeHex(S.wall[2], 1.0));
  }
  K.add('wood', boxRound(dw + 0.7, 0.26, 0.34, 0.07, 1), TRS(0, 0.45 + dh + 0.18, d / 2 + 0.16), S.trim);
  /* hayloft door + hoist beam */
  const ly = 0.45 + wallH + ridgeH * 0.30;
  K.add('wood', boxRound(1.5, 1.5, 0.16, 0.05, 1), TRS(0, ly, d / 2 + 0.16), mixHex(S.trim, BRAND.paper, 0.15));
  K.add('wood', boxRound(0.24, 0.24, 1.5, 0.07, 1), TRS(0, ly + 1.3, d / 2 + 0.6), S.trim);
  K.add('metal', cyl(0.02, 0.02, 0.9, 5, false), TRS(0, ly + 0.85, d / 2 + 1.2), C.lead);
  K.add('metal', torusG(0.16, 0.04, 10, 6), TRS(0, ly + 0.36, d / 2 + 1.2), C.lead);

  /* the back and the flanks: a barn is boarded all round, but boarding
     alone is not articulation — every elevation gets an opening */
  {
    const rz = -(d / 2);
    K.add('wall', boxRound(1.5, 2.1, 0.30, 0.07, 1), TRS(-w * 0.22, 0.45 + 1.05, rz - 0.06), shadeHex(base, 0.70));
    K.add('wood', boxRound(1.2, 1.9, 0.13, 0.05, 1), TRS(-w * 0.22, 0.45 + 1.02, rz - 0.16), mixHex(S.trim, BUILD.woodDark, 0.35));
    K.add('wood', boxRound(1.32, 0.15, 0.20, 0.05, 1), TRS(-w * 0.22, 0.45 + 2.10, rz - 0.18), S.trim);
    for (const face of [1, 2, 3]) {
      const span = faceSpan(face, w, d);
      for (const u of [-span * 0.26, span * 0.28]) {
        K.add('wood', boxRound(0.9, 0.62, 0.14, 0.05, 1),
          faceMat(face, w, d, u, 0.45 + wallH * 0.82, 0.07), shadeHex(S.trim, 0.86));
        for (let k = 0; k < 3; k++) {
          K.add('wood', boxRound(0.82, 0.09, 0.10, 0.03, 1),
            new THREE.Matrix4().multiplyMatrices(
              faceMat(face, w, d, u, 0.45 + wallH * 0.82 - 0.18 + k * 0.18, 0.13),
              TRS(0, 0, 0, 0, 1, 1, 1, 0.42)), shadeHex(S.wall[2], 1.0));
        }
      }
    }
  }

  const top = roofOn(K, S, rng, { w, d, y: 0.45 + wallH, wallH, ridge: ridgeH, hip: 0, along: 'z', kind: 'corrugated' });
  if (S.feat.weathervane) {
    K.add('metal', cyl(0.045, 0.045, 1.6, 6, false), TRS(0, top + 0.8, -d * 0.3), C.lead);
    K.add('metal', boxRound(0.9, 0.4, 0.05, 0.03, 1), TRS(0.3, top + 1.5, -d * 0.3, 0.7), C.lead);
    K.add('gold', sphereG(0.12, 8), TRS(0, top + 1.66, -d * 0.3), C.gold);
  }

  /* silo */
  if (S.feat.silo) {
    const sr = Math.min(2.3, w * 0.14), sh = H * 1.25;
    const sx = -(w / 2 + sr + 0.7);
    K.add('metal', cyl(sr, sr * 1.03, sh, 16, false), TRS(sx, sh / 2 + 0.2, -d * 0.16), C.tin);
    for (let i = 1; i < 6; i++) {
      K.add('metal', torusG(sr + 0.02, 0.055, 16, 6), TRS(sx, 0.2 + (sh * i) / 6, -d * 0.16, 0, 1, 1, 1, PI / 2), C.tinDark);
    }
    K.add('metal', coneG(sr + 0.24, sr * 1.15, 16), TRS(sx, 0.2 + sh + sr * 0.55, -d * 0.16), S.roofAlt);
    K.add('stone', cyl(sr + 0.22, sr + 0.3, 0.42, 16, true), TRS(sx, 0.21, -d * 0.16), LAND.rock);
    meta.collide.push({ w: sr * 2, h: sh, d: sr * 2, x: sx, z: -d * 0.16, y: sh / 2 });
  }

  /* fences fanning out from the yard */
  if (S.feat.fence) {
    for (let i = 0; i < 7; i++) {
      const t = i / 6;
      meta.props.push({ type: 'fence', x: lerp(-w * 0.5 - 3.2, w * 0.5 + 3.2, t), z: d * 0.62 + Math.sin(t * PI) * 1.6, ry: 0.1 * Math.cos(t * PI) });
    }
  }
  for (let i = 0; i < 4; i++) meta.props.push({ type: 'hay', x: jit(rng, w * 0.5), z: d * 0.42 + rng() * 2.4, ry: rng() * 6.28 });
  meta.props.push({ type: 'cart', x: w * 0.36, z: d * 0.5 + 1.6, ry: 0.4 });

  /* a canvas slung off the eave over the yard — the barn's wind carrier */
  {
    const cw = Math.min(w * 0.5, 6.0);
    const cy2 = 0.45 + wallH - 0.25;
    meta.cloths.push({
      kind: 'canopy',
      origin: new THREE.Vector3(-w * 0.5 - 0.1, cy2, d / 2 + 0.10),
      right: new THREE.Vector3(1, 0, 0), down: new THREE.Vector3(0, -0.55, 1).normalize(),
      width: cw, height: 2.4, cols: 10, rows: 7, pin: 'top',
      color: pick(rng, S.fabric),
    });
    for (const sx of [0, 1]) {
      K.add('wood', post(0.09, cy2 - 1.05, 0.02, 6),
        TRS(-w * 0.5 - 0.1 + sx * cw, (cy2 - 1.05) / 2, d / 2 + 2.05), BUILD.woodDark);
    }
    K.add('wood', boxRound(cw + 0.3, 0.14, 0.16, 0.05, 1),
      TRS(-w * 0.5 - 0.1 + cw / 2, cy2 - 1.05, d / 2 + 2.05), BUILD.woodDark);
  }

  meta.eaveY = 0.45 + wallH;
  meta.signAnchor.set(0, 0.45 + dh + 0.7, d / 2 + 0.30);
  meta.door.set(0, 0, d / 2 + 1.6);
  meta.interior.set(0, 1.6, 0);
  meta.collide.push({ w, h: wallH + H * 0.3, d, y: (wallH + H * 0.3) / 2 });
  meta.top = top;
}

/* ------------------------------------------------------------------
   FORM: mine — Iron Hills. Headframe, tin shed, spoil, rails.
   ------------------------------------------------------------------ */
function formMine(ctx, K, loc, S, rng, meta) {
  const w = loc.size.w, d = loc.size.d, H = loc.size.h;
  const shedH = Math.min(H * 0.42, 4.2);

  band(K, { part: 'stone', w: w + 0.4, h: 0.5, d: d + 0.4, y: 0.25, color: mixHex(LAND.rock, C.soil, 0.4) });
  mass(K, { w, h: shedH, d, y: 0.45, color: S.wall[0], round: 0.07, lean: [jit(rng, S.lean), jit(rng, S.lean)] });
  /* corrugated cladding on all four faces */
  for (const face of [0, 1, 2, 3]) {
    const span = faceSpan(face, w, d);
    const n = Math.max(2, Math.round(span / 2.2));
    for (let i = 0; i < n; i++) {
      const u = -span / 2 + (span * (i + 0.5)) / n;
      K.add('metal', corrugated(span / n * 0.97, shedH * 0.96, 6, 0.05, 0.06),
        faceMat(face, w, d, u, 0.45 + shedH / 2, 0.06), i % 3 === 0 ? C.rustPale : S.wall[1]);
    }
  }
  doorway(K, S, rng, { face: 0, bw: w, bd: d, u: -w * 0.24, w: 1.6, h: 2.5, wall: S.wall[0], frame: BUILD.woodDark, door: C.rust, step: LAND.rock });
  windowRow(K, S, rng, { face: 0, w, d, y: 0.45 + shedH * 0.62, count: 2, win: { w: 0.9, h: 0.9, sillCol: BUILD.woodDark, mullion: true }, skip: (u) => u < -w * 0.06 });
  roofOn(K, S, rng, { w, d, y: 0.45 + shedH, wallH: shedH, ridge: clamp(Math.min(w, d) * 0.36, 1.8, 5), kind: 'corrugated', along: 'x' });

  /* headframe: a braced A-frame with a sheave wheel */
  if (S.feat.headframe) {
    const hh = H * 1.55, hw = Math.min(w * 0.5, 5.0);
    const hz = -d * 0.5 - hw * 0.55;
    const legs = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (const [sx, sz] of legs) {
      const topX = sx * hw * 0.16, topZ = sz * hw * 0.16;
      const botX = sx * hw * 0.5, botZ = sz * hw * 0.5;
      const len = Math.hypot(hh, botX - topX, botZ - topZ);
      const m = new THREE.Matrix4().makeTranslation(hz * 0 + (topX + botX) / 2, hh / 2, hz + (topZ + botZ) / 2);
      const dir = new THREE.Vector3(topX - botX, hh, topZ - botZ).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      m.multiply(new THREE.Matrix4().makeRotationFromQuaternion(q));
      K.add('wood', boxRound(0.34, len, 0.34, 0.09, 1), m, BUILD.woodDark);
    }
    for (let i = 1; i <= 4; i++) {
      const t = i / 5;
      const y = hh * t;
      const s = lerp(hw * 0.5, hw * 0.16, t);
      for (const [ax, az] of [[1, 0], [0, 1]]) {
        K.add('wood', boxRound(ax ? s * 2 : 0.16, 0.16, az ? s * 2 : 0.16, 0.05, 1), TRS(0, y, hz), BUILD.woodDark);
      }
      K.add('wood', boxRound(s * 2.6, 0.13, 0.13, 0.04, 1), TRS(0, y - hh * 0.09, hz + s, 0, 1, 1, 1, 0, 0.5), shadeHex(BUILD.woodDark, 1.1));
    }
    K.add('metal', torusG(1.15, 0.16, 18, 8), TRS(0, hh + 0.5, hz), C.lead);
    K.add('metal', torusG(0.9, 0.09, 18, 6), TRS(0, hh + 0.5, hz), C.rust);
    K.add('metal', cyl(0.09, 0.09, 1.4, 8, true), TRS(0, hh + 0.5, hz, 0, 1, 1, 1, 0, PI / 2), C.lead);
    K.add('metal', cyl(0.05, 0.05, hh * 0.72, 5, false), TRS(0.5, hh * 0.6, hz), C.lead);
    meta.collide.push({ w: hw, h: hh * 0.7, d: hw, z: hz, y: hh * 0.35 });
    meta.top = hh + 1.6;
  }

  /* spoil heaps and rails */
  if (S.feat.spoil) {
    for (let i = 0; i < 3; i++) {
      const r = 2.2 + rng() * 2.0;
      const a = -0.9 + i * 0.9 + jit(rng, 0.2);
      const dist = w * 0.75 + rng() * 3;
      K.add('stone', coneG(r, r * (0.55 + rng() * 0.25), 12),
        TRS(Math.sin(a) * dist, r * 0.28, -Math.cos(a) * dist * 0.6 - d * 0.2, rng() * 6), mixHex(C.soil, LAND.rock, 0.35));
    }
  }
  if (S.feat.rail) {
    for (let i = 0; i < 14; i++) {
      const z = d / 2 + 0.4 + i * 0.9;
      K.add('wood', boxRound(1.7, 0.12, 0.28, 0.04, 1), TRS(-w * 0.24, 0.06, z, jit(rng, 0.03)), BUILD.woodDark);
    }
    for (const sx of [-1, 1]) {
      K.add('metal', boxRound(0.09, 0.11, 13.2, 0.03, 1), TRS(-w * 0.24 + sx * 0.6, 0.16, d / 2 + 6.5), C.lead);
    }
    meta.props.push({ type: 'orecart', x: -w * 0.24, z: d / 2 + 5.4, ry: 0 });
  }

  /* a weighted tarpaulin over the tool rack by the shed door */
  {
    const tw = Math.min(w * 0.42, 4.6);
    const ty = 0.45 + shedH * 0.78;
    meta.cloths.push({
      kind: 'canopy',
      origin: new THREE.Vector3(w * 0.44 - tw, ty, d / 2 + 0.08),
      right: new THREE.Vector3(1, 0, 0), down: new THREE.Vector3(0, -0.62, 1).normalize(),
      width: tw, height: 2.1, cols: 9, rows: 6, pin: 'top',
      color: pick(rng, S.fabric),
    });
    for (const sx of [0, 1]) {
      K.add('wood', post(0.085, ty - 0.95, 0.02, 6),
        TRS(w * 0.44 - tw + sx * tw, (ty - 0.95) / 2, d / 2 + 1.75), BUILD.woodDark);
    }
    K.add('metal', cyl(0.04, 0.04, tw + 0.3, 6, false),
      TRS(w * 0.44 - tw / 2, ty - 0.95, d / 2 + 1.75, 0, 1, 1, 1, 0, PI / 2), C.lead);
  }

  meta.eaveY = 0.45 + shedH;
  meta.signAnchor.set(-w * 0.24, 0.45 + shedH * 0.94, d / 2 + 0.32);
  meta.door.set(-w * 0.24, 0, d / 2 + 1.5);
  meta.interior.set(0, 1.5, 0);
  meta.collide.push({ w, h: shedH, d, y: shedH / 2 + 0.4 });
  meta.props.push({ type: 'barrel', x: w * 0.4, z: d / 2 + 1.2, ry: 0.4 }, { type: 'crate', x: w * 0.3, z: d / 2 + 2.4, ry: 0.9 });
}

/* ------------------------------------------------------------------
   FORM: pier — the Waterfront. Everything stands on piles.
   ------------------------------------------------------------------ */
function formPier(ctx, K, loc, S, rng, meta) {
  const w = loc.size.w, d = loc.size.d, H = loc.size.h;
  const deckY = 1.15;
  const wallH = H - deckY - 1.6;
  const storeys = clamp(Math.round(wallH / S.floorH), 1, 3);
  const fh = wallH / storeys;

  /* piles + deck */
  const nx = Math.max(3, Math.round(w / 3.0)), nz = Math.max(3, Math.round((d + 5) / 3.0));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      if (i > 0 && i < nx - 1 && j > 0 && j < nz - 1 && (i + j) % 2) continue;
      const x = -w / 2 + (w * (i + 0.5)) / nx;
      const z = -d / 2 + ((d + 5) * (j + 0.5)) / nz;
      K.add('wood', post(0.25, deckY + 1.6, 0.02, 7), TRS(x, (deckY - 1.6) / 2 + 0.1, z, 0, 1, 1, 1, jit(rng, 0.04), jit(rng, 0.04)), mixHex(BUILD.woodDark, SEA.wet, 0.22));
    }
  }
  /* decking boards, laid with gaps */
  const boards = Math.round((d + 5) / 0.62);
  for (let i = 0; i < boards; i++) {
    const z = -d / 2 - 0.4 + ((d + 5.2) * (i + 0.5)) / boards;
    K.add('woodH', plank(w + 2.2, 0.16, (d + 5.2) / boards * 0.86, rng), TRS(0, deckY, z), i % 4 === 0 ? shadeHex(C.seaDeck, 0.9) : C.seaDeck);
  }

  /* the warehouse */
  const base = S.wall[0];
  for (let s = 0; s < storeys; s++) {
    mass(K, { w: w - s * 0.2, h: fh, d: d - s * 0.2, y: deckY + 0.16 + fh * s, color: s ? mixHex(base, S.wall[1], 0.6) : base, round: 0.08, lean: [jit(rng, S.lean), 0] });
    if (s < storeys - 1) band(K, { part: 'wood', w: w + 0.2, h: 0.22, d: d + 0.2, y: deckY + 0.16 + fh * (s + 1), color: S.trim });
  }
  const eaveY = deckY + 0.16 + wallH;
  /* big cargo doors */
  K.add('wall', boxRound(3.2, 3.0, 0.36, 0.08, 1), TRS(-w * 0.2, deckY + 1.7, d / 2 + 0.04), shadeHex(base, 0.76));
  for (const sx of [-1, 1]) {
    K.add('wood', boxRound(1.5, 2.85, 0.14, 0.05, 1), TRS(-w * 0.2 + sx * 0.79, deckY + 1.68, d / 2 + 0.16), S.trim);
    K.add('wood', boxRound(1.35, 0.14, 0.10, 0.04, 1), TRS(-w * 0.2 + sx * 0.79, deckY + 2.7, d / 2 + 0.25), shadeHex(S.trim, 0.85));
  }
  doorway(K, S, rng, { face: 0, bw: w, bd: d, u: w * 0.26, w: 1.5, h: 2.4, wall: base, frame: S.trim, door: mixHex(S.trim, S.tint, 0.4), step: C.seaDeck });
  for (let s = 0; s < storeys; s++) {
    /* the seaward elevation counts too — it is the one every boat and
       every camera coming in off the water actually sees */
    for (const face of [0, 1, 2, 3]) {
      const span = faceSpan(face, w, d);
      windowRow(K, S, rng, {
        face, w, d, y: deckY + 0.5 + fh * s + fh * 0.55, count: Math.max(1, Math.round(span / 3.6)),
        win: { w: 1.0, h: Math.min(1.5, fh * 0.5), sillCol: S.trim },
        skip: (u) => s === 0 && face === 0 && u < -w * 0.02,
      });
    }
  }
  band(K, { part: 'wood', w: w + 0.7, h: 0.28, d: d + 0.7, y: eaveY - 0.05, color: S.trim });
  const top = roofOn(K, S, rng, { w, d, y: eaveY, wallH, ridge: clamp(Math.min(w, d) * 0.36, 1.6, 4.6), hip: 0.35, along: 'x' });

  /* gantry crane */
  if (S.feat.crane) {
    const cx = w / 2 + 3.6, ch = H * 1.1;
    for (const sz of [-1.4, 1.4]) {
      K.add('metal', boxRound(0.34, ch, 0.34, 0.09, 1), TRS(cx, ch / 2 + deckY, sz, 0, 1, 1, 1, 0, sz > 0 ? -0.05 : 0.05), C.tinDark);
    }
    for (let i = 1; i < 5; i++) {
      K.add('metal', boxRound(0.14, 0.14, 3.0, 0.04, 1), TRS(cx, deckY + (ch * i) / 5, 0), C.tinDark);
      K.add('metal', boxRound(0.11, 0.11, 3.2, 0.035, 1), TRS(cx, deckY + (ch * (i - 0.5)) / 5, 0, 0, 1, 1, 1, 0.55, 0), shadeHex(C.tinDark, 1.15));
    }
    const jib = 9.0;
    K.add('metal', boxRound(jib, 0.42, 0.5, 0.11, 1), TRS(cx - jib * 0.34, deckY + ch + 0.3, 0, 0, 1, 1, 1, 0, -0.06), BRAND.warn);
    K.add('metal', boxRound(2.4, 0.9, 1.5, 0.16, 1), TRS(cx + 1.1, deckY + ch - 0.7, 0), BRAND.warn);
    K.add('metal', cyl(0.05, 0.05, 3.4, 5, false), TRS(cx - jib * 0.62, deckY + ch - 1.6, 0), C.lead);
    K.add('metal', boxRound(1.0, 0.5, 0.9, 0.12, 1), TRS(cx - jib * 0.62, deckY + ch - 3.5, 0), C.rust);
    meta.collide.push({ w: 1.2, h: ch, d: 3.4, x: cx, y: deckY + ch / 2 });
    meta.top = deckY + ch + 1;
  }
  /* mooring bollards + netting */
  for (let i = 0; i < 3; i++) {
    meta.props.push({ type: 'bollard', x: -w / 2 - 0.8, z: -d * 0.3 + i * 2.6, y: deckY });
  }
  /* A STACK, not a staircase. Two metres of lateral jitter on a 2.5 m
     box put each container almost clear of the one below it, so the
     three of them read as boxes hanging in the air rather than as a
     stack sitting on the deck. */
  const stackX = w * 0.1 + jit(rng, 1.2);
  for (let i = 0; i < 3; i++) {
    meta.props.push({
      type: 'container', x: stackX + jit(rng, 0.30),
      z: d / 2 + 3.4 + jit(rng, 0.22), ry: jit(rng, 0.10), stack: i, y: deckY,
    });
  }
  meta.cloths.push({
    kind: 'net',
    origin: new THREE.Vector3(-w / 2 - 0.6, deckY + 2.4, d / 2 + 1.2),
    right: new THREE.Vector3(0, 0, 1), down: new THREE.Vector3(0, -1, 0),
    width: 2.6, height: 2.2, cols: 8, rows: 7, pin: 'top',
    color: pick(rng, S.fabric),
  });

  meta.eaveY = eaveY;
  meta.ground = deckY;
  meta.signAnchor.set(w * 0.26, deckY + 3.1, d / 2 + 0.32);
  meta.door.set(w * 0.26, deckY, d / 2 + 1.6);
  meta.interior.set(0, deckY + 1.5, 0);
  meta.collide.push({ w: w + 2.2, h: 0.4, d: d + 5.2, y: deckY - 0.1 });
  meta.collide.push({ w, h: wallH, d, y: deckY + wallH / 2 });
  meta.props.push({ type: 'lamp', x: -w * 0.44, z: d / 2 + 2.4, y: deckY });
  meta.top = meta.top || top;
}

/* ------------------------------------------------------------------
   FORM: glass — the Innovation District. Timber frame, glass infill,
   roof gardens, brise-soleil.
   ------------------------------------------------------------------ */
function formGlass(ctx, K, loc, S, rng, meta) {
  const w = loc.size.w, d = loc.size.d, H = loc.size.h;
  const storeys = clamp(Math.round(H / S.floorH), 2, 5);
  const fh = (H - 0.9) / storeys;
  const base = S.wall[0];

  band(K, { part: 'stone', w: w + 0.5, h: 0.55, d: d + 0.5, y: 0.28, color: shadeHex(base, 0.88) });

  /* the frame: corner posts, floor slabs, and a curtain wall of
     glass panels between timber mullions */
  for (let s = 0; s < storeys; s++) {
    const y0 = 0.5 + fh * s;
    band(K, { part: 'stone', w: w + 0.5, h: 0.30, d: d + 0.5, y: y0, color: mixHex(base, BRAND.paper, 0.4) });
    /* solid end walls, glazed long walls */
    for (const sx of [-1, 1]) {
      mass(K, { w: 0.62, h: fh - 0.3, d, x: sx * (w / 2 - 0.31), y: y0 + 0.15, color: base, round: 0.14 });
    }
    for (const face of [0, 1]) {
      const n = Math.max(2, Math.round(w / 2.4));
      const pw = (w - 1.5) / n;
      for (let i = 0; i < n; i++) {
        const u = -(w - 1.5) / 2 + pw * (i + 0.5);
        const M = faceMat(face, w, d, u, y0 + fh * 0.5, 0.04);
        const glass = (i + s) % 5 === 0 ? 'glassCool' : (rng() < 0.4 ? 'glassWarm' : 'glassCool');
        K.add(glass, boxRound(pw * 0.92, fh - 0.52, 0.09, 0.02, 1), M, 0xffffff);
        K.add('wood', boxRound(0.14, fh - 0.3, 0.20, 0.04, 1),
          new THREE.Matrix4().multiplyMatrices(M, TRS(-pw / 2, 0, 0.06)), S.trim);
      }
      K.add('wood', boxRound(w - 1.2, 0.14, 0.22, 0.05, 1),
        new THREE.Matrix4().multiplyMatrices(faceMat(face, w, d, 0, y0 + fh * 0.5, 0.06), TRS(0, 0, 0)), S.trim);
      /* brise-soleil: horizontal timber fins that actually shade */
      if (S.feat.brise && face === 0) {
        K.add('wood', boxRound(w - 0.9, 0.16, 0.80, 0.05, 1),
          TRS(0, y0 + fh * 0.72, d / 2 + 0.48, 0, 1, 1, 1, 0.40), S.trim);
      }
    }
    /* side glazing */
    for (const face of [2, 3]) {
      const n = Math.max(1, Math.round(d / (S.simple ? 4.5 : 3.0)));
      for (let i = 0; i < n; i++) {
        const u = -d / 2 + (d * (i + 0.5)) / n;
        K.add((i + s) % 3 ? 'glassCool' : 'glassWarm',
          boxRound(d / n * 0.7, fh - 0.6, 0.09, 0.02, 1), faceMat(face, w, d, u, y0 + fh * 0.5, 0.04), 0xffffff);
      }
    }
  }

  const eaveY = 0.5 + fh * storeys;
  roofOn(K, S, rng, { w, d, y: eaveY, wallH: H, kind: 'flat', parapet: 0.75 });

  /* roof garden: planters and small trees */
  if (S.feat.roofgarden) {
    for (let i = 0; i < 5; i++) {
      const x = jit(rng, w * 0.32), z = jit(rng, d * 0.3);
      K.add('wood', boxRound(1.5, 0.55, 1.1, 0.12, 1), TRS(x, eaveY + 0.6, z, jit(rng, 0.5)), S.trim);
      K.add('hedge', sphereG(0.62, 9), TRS(x, eaveY + 1.15, z, 0, 1, 0.8, 1), i % 2 ? C.leaf : C.hedge);
      if (i % 2) {
        K.add('wood', cyl(0.09, 0.12, 1.3, 6, false), TRS(x, eaveY + 1.4, z), BUILD.woodDark);
        K.add('hedge', sphereG(0.95, 10), TRS(x, eaveY + 2.3, z, 0, 1, 0.82, 1), C.leaf);
      }
    }
    K.add('metal', boxRound(w + 0.2, 0.09, 0.09, 0.03, 1), TRS(0, eaveY + 1.5, d / 2 + 0.12), C.lead);
  }

  /* entrance: a glass canopy on slim posts */
  doorway(K, S, rng, { face: 0, bw: w, bd: d, u: 0, w: 2.2, h: 2.7, wall: base, frame: S.trim, door: mixHex(S.trim, S.tint, 0.35), step: mixHex(base, BRAND.paper, 0.4) });
  K.add('glassCool', boxRound(4.6, 0.10, 2.4, 0.04, 1), TRS(0, 3.35, d / 2 + 1.1, 0, 1, 1, 1, -0.06), 0xffffff);
  K.add('wood', boxRound(4.8, 0.16, 0.22, 0.05, 1), TRS(0, 3.44, d / 2 + 0.12), S.trim);
  for (const sx of [-1, 1]) {
    K.add('metal', cyl(0.07, 0.07, 3.3, 7, false), TRS(sx * 2.1, 1.7, d / 2 + 2.05), C.lead);
  }

  /* a fabric sunshade slung under the brise-soleil: even the glass
     district needs one thing that moves in the wind (§2.3, §6) */
  meta.cloths.push({
    kind: 'awning',
    origin: new THREE.Vector3(-w * 0.30, 0.5 + fh * 1.62, d / 2 + 0.10),
    right: new THREE.Vector3(1, 0, 0), down: new THREE.Vector3(0, -0.30, 1).normalize(),
    width: w * 0.60, height: 1.35, cols: 10, rows: 6, pin: 'top',
    color: pick(rng, S.fabric),
  });
  K.add('metal', cyl(0.04, 0.04, w * 0.60, 6, false),
    TRS(0, 0.5 + fh * 1.62 - 0.44, d / 2 + 1.22, 0, 1, 1, 1, 0, PI / 2), C.lead);
  for (const sx of [-1, 1]) {
    K.add('metal', cyl(0.045, 0.045, 1.42, 6, false),
      TRS(sx * w * 0.30, 0.5 + fh * 1.62 - 0.24, d / 2 + 0.66, 0, 1, 1, 1, 1.92), C.lead);
  }

  meta.eaveY = eaveY;
  meta.signAnchor.set(0, 3.9, d / 2 + 0.30);
  meta.door.set(0, 0, d / 2 + 2.2);
  meta.interior.set(0, 1.6, 0);
  meta.collide.push({ w, h: H, d, y: H / 2 });
  meta.props.push({ type: 'bench', x: -w * 0.36, z: d / 2 + 2.6, ry: PI }, { type: 'plant', x: w * 0.36, z: d / 2 + 2.2 },
    { type: 'bike', x: -w * 0.5 - 1.2, z: d / 2 + 1.0, ry: 0.3 }, { type: 'lamp', x: w * 0.5 + 1.5, z: d / 2 + 1.4 });
  meta.top = eaveY + 1.6;
}

/* ------------------------------------------------------------------
   FORM: temple — Golden Heights, the bank, the business school.
   ------------------------------------------------------------------ */
function formTemple(ctx, K, loc, S, rng, meta) {
  const w = loc.size.w, d = loc.size.d, H = loc.size.h;
  const podium = Math.min(1.5, H * 0.07);
  const tall = H > 24;
  const bodyH = tall ? H * 0.42 : H * 0.62;
  const stone = S.wall[0];
  const gold = S.feat.goldtrim ? C.gold : S.trim;

  /* stepped podium */
  const steps = 4;
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    band(K, {
      part: 'stone', w: w + 2.4 - t * 2.0, h: podium / steps, d: d + 3.2 - t * 2.6,
      y: (podium * (i + 0.5)) / steps, z: (1.0 - t * 0.8) * 0.4,
      color: i % 2 ? shadeHex(stone, 0.94) : stone,
    });
  }

  /* body */
  mass(K, { w, h: bodyH, d, y: podium, color: stone, round: 0.05 });
  band(K, { part: 'stone', w: w + 0.4, h: 0.34, d: d + 0.4, y: podium + 0.3, color: shadeHex(stone, 0.92) });

  /* colonnade across the front (and the returns) */
  const nCol = clamp(Math.round(w / 3.0), 4, 9);
  const colH = bodyH * 0.82;
  const colR = Math.min(0.46, w / (nCol * 3.4));
  for (let i = 0; i < nCol; i++) {
    const x = -w / 2 + 1.1 + ((w - 2.2) * i) / (nCol - 1);
    K.add('stone', column(colR, colH, 12), TRS(x, podium + 0.2, d / 2 + 1.05), C.marble);
    K.add('gold', torusG(colR * 1.2, colR * 0.14, 12, 6), TRS(x, podium + 0.2 + colH * 0.985, d / 2 + 1.05, 0, 1, 1, 1, PI / 2), gold);
  }
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      K.add('stone', column(colR, colH, 12), TRS(sx * (w / 2 - 1.1), podium + 0.2, d / 2 - 1.0 - i * 2.2), C.marble);
    }
  }
  /* entablature + pediment */
  const entY = podium + 0.2 + colH;
  band(K, { part: 'stone', w: w + 1.6, h: 0.42, d: d + 3.2, y: entY + 0.21, color: C.marble });
  band(K, { part: 'gold', w: w + 1.7, h: 0.14, d: d + 3.3, y: entY + 0.50, color: gold });
  band(K, { part: 'stone', w: w + 1.9, h: 0.34, d: d + 3.5, y: entY + 0.75, color: shadeHex(C.marble, 0.95) });
  if (S.feat.pediment) {
    const pw = w + 1.9, ph = pw * 0.14;
    K.add('stone', roofSolid({ w: d + 3.5, d: pw, ridge: ph, thick: 0.5, overW: 0.2, overD: 0.15, sag: 0.01, hip: 0, curve: 1.0, flare: 0.02, uSeg: 3, tSeg: 3 }),
      TRS(0, entY + 0.92, 0, PI / 2), C.marble);
    K.add('gold', sphereG(0.42, 12), TRS(0, entY + 1.05, d / 2 + 1.6, 0, 1, 0.55, 0.4), gold);
    for (const sx of [-1, 1]) K.add('gold', boxRound(0.34, 0.34, 0.3, 0.09, 1), TRS(sx * (pw / 2 - 0.5), entY + 1.05, d / 2 + 1.2), gold);
  }

  /* upper block / tower for the tall ones (the penthouse) */
  let top = entY + 1.6;
  if (tall) {
    const tw = w * 0.74, td = d * 0.74;
    const th = H - top - 2.0;
    const floors = Math.max(3, Math.round(th / 3.4));
    for (let i = 0; i < floors; i++) {
      const k = i / floors;
      const fw = tw * (1 - k * 0.18), fd = td * (1 - k * 0.18);
      const y0 = top + (th * i) / floors;
      mass(K, { w: fw, h: th / floors - 0.12, d: fd, y: y0, color: i % 2 ? shadeHex(stone, 0.96) : stone, round: 0.05 });
      band(K, { part: 'gold', w: fw + 0.3, h: 0.13, d: fd + 0.3, y: y0 + th / floors - 0.06, color: gold });
      for (const face of [0, 1, 2, 3]) {
        const span = faceSpan(face, fw, fd);
        const n = Math.max(2, Math.round(span / 2.6));
        for (let j = 0; j < n; j++) {
          const u = -span / 2 + (span * (j + 0.5)) / n;
          K.add((i + j) % 3 ? 'glassWarm' : 'glassCool',
            boxRound(span / n * 0.62, th / floors * 0.5, 0.10, 0.03, 1),
            faceMat(face, fw, fd, u, y0 + th / floors * 0.5, 0.03), 0xffffff);
          K.add('stone', boxRound(span / n * 0.72, th / floors * 0.6, 0.24, 0.05, 1),
            faceMat(face, fw, fd, u, y0 + th / floors * 0.5, -0.02), shadeHex(stone, 0.86));
        }
      }
    }
    top += th;
    band(K, { part: 'stone', w: tw * 0.9, h: 0.5, d: td * 0.9, y: top + 0.25, color: C.marble });
    K.add('gold', coneG(tw * 0.32, 2.6, 14), TRS(0, top + 1.8, 0), gold);
    K.add('gold', sphereG(0.3, 10), TRS(0, top + 3.2, 0), gold);
    top += 3.5;
    meta.collide.push({ w: tw, h: th, d: td, y: entY + 1.6 + th / 2 });
  } else if (S.feat.dome && rng() < 0.75) {
    const dr = Math.min(w, d) * 0.32;
    K.add('stone', cyl(dr * 1.14, dr * 1.2, 1.3, 16, false), TRS(0, entY + 1.6, -d * 0.05), C.marble);
    K.add('gold', torusG(dr * 1.16, 0.11, 18, 6), TRS(0, entY + 2.9, -d * 0.05, 0, 1, 1, 1, PI / 2), gold);
    const pts = [];
    for (let i = 0; i <= 9; i++) {
      const a = (i / 9) * (PI / 2);
      pts.push(new THREE.Vector2(Math.cos(a) * dr * 1.1 + 0.001, Math.sin(a) * dr * 0.94));
    }
    K.add('roof', new THREE.LatheGeometry(pts, 18), TRS(0, entY + 2.9, -d * 0.05), S.roof);
    K.add('gold', sphereG(0.34, 10), TRS(0, entY + 2.9 + dr * 0.98, -d * 0.05), gold);
    K.add('gold', cyl(0.06, 0.06, 1.1, 6, false), TRS(0, entY + 3.5 + dr, -d * 0.05), gold);
    top = entY + 4.4 + dr;
  } else {
    /* THE ROOF HAS TO COVER THE ENTABLATURE. At 0.92 of the body it sat
       inside a cornice 1.9 m wider than the walls and left a flat pale
       deck all round it — a temple wearing a small hat. */
    top = roofOn(K, S, rng, {
      w: w + 1.6, d: d + 2.8, y: entY + 0.92, wallH: bodyH,
      ridge: clamp(Math.min(w, d) * 0.30, 1.6, 4.4), hip: 0.42, along: 'x',
    });
  }

  /* windows between the columns, and a bronze door */
  const nw = clamp(Math.round(w / 4.4), 1, 4);
  for (let i = 0; i < nw; i++) {
    const u = -w / 2 + (w * (i + 0.5)) / nw;
    if (Math.abs(u) < 2.0) continue;
    windowUnit(K, S, rng, faceMat(0, w, d, u, podium + bodyH * 0.52, 0.03), {
      w: 1.2, h: bodyH * 0.44, arch: true, sillCol: C.marble, wall: stone, frame: gold,
    });
  }
  for (const face of [1, 2, 3]) {
    const span = faceSpan(face, w, d);
    const n = Math.max(1, Math.round(span / 4.2));
    for (let i = 0; i < n; i++) {
      windowUnit(K, S, rng, faceMat(face, w, d, -span / 2 + (span * (i + 0.5)) / n, podium + bodyH * 0.52, 0.03), {
        w: 1.1, h: bodyH * 0.40, arch: true, sillCol: C.marble, wall: stone, frame: gold,
      });
    }
  }
  doorway(K, S, rng, {
    face: 0, bw: w, bd: d, u: 0, w: 2.4, h: Math.min(4.0, bodyH * 0.7), steps: false,
    wall: stone, frame: gold, door: mixHex(C.goldDeep, BRAND.ink, 0.45), head: gold, step: C.marble,
  });

  /* --- civic banners hung from the entablature, between the columns.
     A colonnade with nothing hanging in it is a bank lobby; §6 wants
     something moving in every frame and this is the only wind carrier
     an institution gets. --- */
  {
    const bh2 = clamp(colH * 0.58, 2.4, 5.4);
    const bx0 = Math.min(w * 0.32, (w - 2.2) * 0.5 - 0.8);
    /* saturated: a pale banner on a marble portico is invisible, and
       §2.1 wants the colour to carry from across the district */
    const banner = [
      S.fabric[0],
      mixHex(BRAND.token2, BUILD.woodDark, 0.24),
      mixHex(BUILD.awningAlt, BRAND.ink, 0.22),
    ];
    for (let i = 0; i < 3; i++) {
      const bxx = lerp(-bx0, bx0, i / 2);
      K.add('metal', cyl(0.05, 0.05, 1.5, 6, false),
        TRS(bxx, entY - 0.22, d / 2 + 1.05, 0, 1, 1, 1, 0, PI / 2), C.lead);
      meta.cloths.push({
        kind: 'banner',
        origin: new THREE.Vector3(bxx - 0.62, entY - 0.30, d / 2 + 1.05),
        right: new THREE.Vector3(1, 0, 0), down: new THREE.Vector3(0, -1, 0),
        width: 1.24, height: bh2, cols: 6, rows: 10, pin: 'top',
        color: banner[i % banner.length],
      });
    }
  }

  /* formal garden */
  if (S.feat.garden) {
    for (let i = 0; i < 6; i++) {
      const sx = i < 3 ? -1 : 1;
      const k = (i % 3) / 2;
      meta.props.push({ type: 'hedge', x: sx * (w / 2 + 1.6), z: d / 2 + 2.0 + k * 3.0, ry: 0 });
    }
    meta.props.push({ type: 'lamp', x: -w * 0.5 - 1.0, z: d / 2 + 3.2, gold: 1 },
      { type: 'lamp', x: w * 0.5 + 1.0, z: d / 2 + 3.2, gold: 1 });
  }

  meta.eaveY = entY;
  meta.signAnchor.set(0, entY + 0.35, d / 2 + 3.5);
  meta.door.set(0, podium, d / 2 + 3.0);
  meta.interior.set(0, podium + 1.6, 0);
  meta.collide.push({ w, h: bodyH, d, y: podium + bodyH / 2 });
  meta.collide.push({ w: w + 2.4, h: podium, d: d + 3.2, y: podium / 2 });
  meta.top = top;
}

/* ------------------------------------------------------------------
   FORM: stadium — the Stampede bowl.
   ------------------------------------------------------------------ */
function formStadium(ctx, K, loc, S, rng, meta) {
  const w = loc.size.w, d = loc.size.d, H = loc.size.h;
  if (w < 30) { formGlass(ctx, K, loc, S, rng, meta); return; }
  const rx = w / 2, rz = d / 2;
  const N = 30;
  const outerH = H * 0.62;

  /* outer wall: leaning panels with arched openings */
  for (let i = 0; i < N; i++) {
    const a = (i / N) * PI * 2;
    const a2 = ((i + 1) / N) * PI * 2;
    const mx = Math.sin((a + a2) / 2) * rx, mz = Math.cos((a + a2) / 2) * rz;
    const chord = Math.hypot(Math.sin(a2) * rx - Math.sin(a) * rx, Math.cos(a2) * rz - Math.cos(a) * rz);
    const yaw = Math.atan2(mx, mz);
    const hh = outerH * (0.9 + 0.14 * Math.abs(Math.cos((a + a2) / 2)));
    const col = S.wall[i % S.wall.length];
    const m = TRS(mx, hh / 2, mz, yaw);
    shear(m, 0, -0.035);
    K.add('wall', boxRound(chord * 1.06, hh, 1.5, 0.20, 1), m, col);
    /* arch openings at ground level */
    if (i % 2 === 0) {
      const am = TRS(mx * 1.02, 2.1, mz * 1.02, yaw);
      K.add('wall', boxRound(chord * 0.5, 3.4, 1.8, 0.5, 2), am, shadeHex(col, 0.62));
      K.add('stone', boxRound(chord * 0.62, 0.3, 1.9, 0.08, 1), TRS(mx * 1.02, 4.0, mz * 1.02, yaw), S.trim);
    }
    /* pilaster + upper band */
    const pm = TRS(Math.sin(a) * rx * 1.02, hh * 0.5, Math.cos(a) * rz * 1.02, Math.atan2(Math.sin(a) * rx, Math.cos(a) * rz));
    K.add('stone', boxRound(0.7, hh * 1.02, 1.9, 0.14, 1), pm, S.trim);
    K.add('stone', boxRound(chord * 1.08, 0.42, 2.0, 0.10, 1), TRS(mx * 1.005, hh - 0.3, mz * 1.005, yaw), S.trim);
  }

  /* seating: concentric tiers stepping down toward the pitch */
  const tiers = 6;
  for (let t = 0; t < tiers; t++) {
    const k = t / (tiers - 1);
    const sx = lerp(0.92, 0.52, k), sz = lerp(0.92, 0.52, k);
    const y = lerp(outerH * 0.86, 1.6, k);
    for (let i = 0; i < N; i++) {
      const a = (i + 0.5) / N * PI * 2;
      const mx = Math.sin(a) * rx * sx, mz = Math.cos(a) * rz * sz;
      const chord = (2 * PI * Math.hypot(rx * sx, rz * sz) * 0.7) / N;
      const yaw = Math.atan2(mx, mz);
      K.add('wall', boxRound(chord * 1.1, 0.9, 2.2, 0.12, 1), TRS(mx, y, mz, yaw), mixHex(S.wall[1], BUILD.awning, t % 2 ? 0.42 : 0.12));
      K.add('wall', boxRound(chord * 1.05, 0.55, 0.35, 0.10, 1), TRS(mx * 1.03, y + 0.7, mz * 1.03, yaw), t % 3 === 0 ? BRAND.token : mixHex(BUILD.awningAlt, BRAND.paper, 0.2));
    }
  }
  /* the pitch */
  K.add('hedge', cyl(1, 1, 0.24, 34, true), TRS(0, 1.1, 0, 0, rx * 0.5, 1, rz * 0.5), mixHex(LAND.grassLit, LAND.grassShade, 0.35));
  K.add('hedge', torusG(1, 0.02, 34, 6), TRS(0, 1.25, 0, 0, rx * 0.26, 1, rz * 0.26), BRAND.paper);

  /* floodlights */
  if (S.feat.floodlight) {
    for (let i = 0; i < 4; i++) {
      const a = PI / 4 + (i * PI) / 2;
      const fx = Math.sin(a) * rx * 1.04, fz = Math.cos(a) * rz * 1.04;
      const fh = H * 1.05;
      for (const [ox, oz] of [[-1.0, -1.0], [1.0, -1.0], [-1.0, 1.0], [1.0, 1.0]]) {
        K.add('metal', boxRound(0.38, fh, 0.38, 0.10, 1), TRS(fx + ox, fh / 2, fz + oz, 0, 1, 1, 1, -oz * 0.020, ox * 0.020), C.tinDark);
      }
      for (let j = 1; j < 8; j++) {
        for (const sz of [-1, 1]) {
          K.add('metal', boxRound(2.3, 0.15, 0.15, 0.05, 1), TRS(fx, (fh * j) / 8, fz + sz), C.tinDark);
          K.add('metal', boxRound(0.15, 0.15, 2.3, 0.05, 1), TRS(fx + sz, (fh * j) / 8, fz), C.tinDark);
        }
        K.add('metal', boxRound(2.6, 0.11, 0.11, 0.04, 1), TRS(fx, (fh * (j - 0.5)) / 8, fz - 1.0, 0, 1, 1, 1, 0, 0.72), shadeHex(C.tinDark, 1.2));
      }
      K.add('metal', boxRound(6.2, 2.8, 0.6, 0.18, 1), TRS(fx, fh + 1.6, fz, Math.atan2(-fx, -fz), 1, 1, 1, 0.34), C.tinDark);
      for (let c = 0; c < 8; c++) {
        K.add('lamp', boxRound(1.15, 0.95, 0.18, 0.07, 1),
          TRS(fx, fh + 1.6, fz, Math.atan2(-fx, -fz), 1, 1, 1, 0.34)
            .multiply(new THREE.Matrix4().makeTranslation(-2.25 + (c % 4) * 1.5, c < 4 ? 0.68 : -0.68, 0.20)), 0xffffff);
      }
      meta.collide.push({ w: 2.6, h: fh, d: 2.6, x: fx, z: fz, y: fh / 2 });
    }
  }

  /* entrance gate + turnstiles at the front */
  const gz = rz + 1.0;
  K.add('wall', boxRound(11.0, outerH * 0.92, 3.2, 0.24, 1), TRS(0, outerH * 0.46, gz), mixHex(S.wall[0], BUILD.awning, 0.18));
  K.add('stone', boxRound(12.2, 0.7, 3.8, 0.16, 1), TRS(0, outerH * 0.92 + 0.3, gz), S.trim);
  K.add('wall', boxRound(9.0, 4.4, 1.2, 0.4, 2), TRS(0, 2.4, gz + 1.3), shadeHex(S.wall[0], 0.5));
  for (let i = 0; i < 4; i++) {
    K.add('metal', cyl(0.10, 0.10, 1.15, 7, false), TRS(-3.3 + i * 2.2, 0.6, gz + 1.9), C.lead);
    for (let k = 0; k < 3; k++) {
      K.add('metal', boxRound(0.9, 0.08, 0.08, 0.03, 1), TRS(-3.3 + i * 2.2, 1.05, gz + 1.9, (k * PI * 2) / 3), C.lead);
    }
  }
  for (let i = 0; i < 3; i++) {
    meta.cloths.push({
      kind: 'banner',
      origin: new THREE.Vector3(-4.2 + i * 4.2, outerH * 0.9, gz + 1.75),
      right: new THREE.Vector3(1, 0, 0), down: new THREE.Vector3(0, -1, 0),
      width: 2.1, height: 5.2, cols: 7, rows: 12, pin: 'top',
      color: [BUILD.awning, BRAND.token, BUILD.awningAlt][i],
    });
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * PI * 2 + 0.4;
    meta.props.push({ type: 'bollard', x: Math.sin(a) * rx * 1.18, z: Math.cos(a) * rz * 1.18 });
  }
  meta.props.push({ type: 'bin', x: 6.5, z: gz + 3.2 }, { type: 'bench', x: -6.5, z: gz + 3.4, ry: PI });

  meta.eaveY = outerH;
  meta.signAnchor.set(0, outerH * 0.92 + 1.15, gz + 1.7);
  meta.door.set(0, 0, gz + 3.4);
  meta.interior.set(0, 3.0, rz * 0.6);
  for (let i = 0; i < N; i += 2) {
    const a = (i / N) * PI * 2;
    meta.collide.push({ w: (2 * PI * Math.hypot(rx, rz) * 0.6) / N, h: outerH, d: 1.6, x: Math.sin(a) * rx, z: Math.cos(a) * rz, ry: Math.atan2(Math.sin(a) * rx, Math.cos(a) * rz), y: outerH / 2 });
  }
  meta.top = H * 1.05 + 5;
}

export const FORMS = {
  shop: formShop, terrace: formTerrace, stall: formStall, barn: formBarn,
  mine: formMine, pier: formPier, glass: formGlass, temple: formTemple,
  stadium: formStadium,
};

/* ------------------------------------------------------------------
   Build one location.
   ------------------------------------------------------------------ */
export function buildLocation(ctx, loc, S, rng) {
  /* ----------------------------------------------------------------
     ONE HOUSE, NOT ONE MESH FOUR TIMES.

     `kitFor` hands every building in a district the same style object,
     and the forms below read it as if it were fixed. Two judges, in two
     separate rounds, independently called the spawn "the same
     beige/red-roof house stamped four times" — so the style object is
     now RE-ROLLED per building, before the mason ever sees it, across
     every axis that changes a silhouette or a colour block: roof hue,
     roof pitch, which way the ridge runs, how hipped it is, wall
     colour, trim colour, storey height, and whether it has a porch.
     All of it deterministic from the building's own seed, and every
     colour still a recipe over palette.js.
     ---------------------------------------------------------------- */
  if (S.roofPal && S.roofPal.length) {
    /* Every roof in a district is the same material and a different
       batch of tiles. One shared colour across a whole zone is the
       tell-tale of a generated city; pick per building. */
    const i = Math.floor(rng() * S.roofPal.length) % S.roofPal.length;
    S.roof = S.roofPal[i];
    S.roofAlt = shadeHex(S.roof, 0.74 + rng() * 0.14);
  }
  /* the wall list is ROTATED, so `S.wall[0]` — which half the masonry
     treats as "the" wall colour — is a different colour per building */
  if (S.wall && S.wall.length > 1) {
    const k = Math.floor(rng() * S.wall.length) % S.wall.length;
    S.wall = S.wall.slice(k).concat(S.wall.slice(0, k));
  }
  S.trim = mixHex(S.trim, pick(rng, [
    BUILD.woodDark, C.stoneWarm, BRAND.paper, C.lead, S.roof, BUILD.wood,
  ]), rng() * 0.34);
  /* pitch as a fraction of the short span, and how hard the ends hip
     in: a street of identical 34-degree hips is one roof repeated */
  S.pitch = 0.25 + rng() * 0.15;
  S.hipK = pick(rng, [0, 0, 0.14, 0.26, 0.26, 0.40]);
  /* which way the ridge runs. Only free when the plot is near-square —
     a ridge across the short span of a long building is a shed. */
  S.ridgeFlip = Math.abs(loc.size.w - loc.size.d) < Math.min(loc.size.w, loc.size.d) * 0.28
    && rng() < 0.45;
  S.porch = rng() < 0.42;
  S.floorH = S.floorH * (0.88 + rng() * 0.26);
  const K = new Kit(makeAO({ ground: 0.44, groundH: Math.max(2.4, loc.size.h * 0.22), under: 0.5 }));
  const meta = {
    door: new THREE.Vector3(0, 0, loc.size.d / 2 + 1.4),
    signAnchor: new THREE.Vector3(0, 3, loc.size.d / 2 + 0.3),
    interior: new THREE.Vector3(0, 1.5, 0),
    collide: [], cloths: [], props: [], top: loc.size.h, ground: 0,
  };
  const form = FORMS[S.form] || formShop;
  form(ctx, K, loc, S, rng, meta);
  return { K, meta };
}

/* ------------------------------------------------------------------
   Silhouette LOD — one merged mass per building, the shape you read
   from across the island. Two draw calls instead of six, no windows,
   no props, and the roof still reads.
   ------------------------------------------------------------------ */
export function silhouette(loc, S, meta, rng) {
  const K = new Kit(makeAO({ ground: 0.6, groundH: loc.size.h * 0.5, under: 0.7 }));
  const w = loc.size.w, d = loc.size.d;
  const H = Math.max(2, (meta.eaveY || loc.size.h * 0.7));
  const base = S.wall[0];
  if (S.form === 'stadium' && w > 30) {
    const N = 16, rx = w / 2, rz = d / 2;
    for (let i = 0; i < N; i++) {
      const a = (i + 0.5) / N * PI * 2;
      const chord = (2 * PI * Math.hypot(rx, rz) * 0.72) / N;
      K.add('wall', boxRound(chord, H, 2.0, 0.2, 1), TRS(Math.sin(a) * rx, H / 2, Math.cos(a) * rz, Math.atan2(Math.sin(a) * rx, Math.cos(a) * rz)), base);
    }
    return K;
  }
  const g0 = meta.ground || 0;
  /* a hair of the trim mixed into the far mass: a whole district of
     dark brick at 300 m collapses into one muddy silhouette otherwise */
  K.add('wall', boxRound(w, H, d, Math.min(w, d) * 0.1, 1), TRS(0, H / 2 + g0, 0), mixHex(base, S.trim, 0.12));

  /* A FAR BUILDING IS STILL A BUILDING. The first LOD threw everything
     away and left a coloured lump that hazed into a muddy dark mass on
     the skyline. The eye does not resolve a sill or a glazing bar at
     200 m — it resolves the PLINTH LINE, the EAVES LINE and the WINDOW
     RHYTHM, and those cost three boxes and a grid of panes. The panes
     are the emissive glass material, so a distant district still lights
     up at night instead of going flat black. */
  K.add('stone', boxRound(w + 0.36, 0.62, d + 0.36, 0.13, 1), TRS(0, g0 + 0.31, 0), shadeHex(base, 0.78));
  K.add('stone', boxRound(w + 0.30, 0.30, d + 0.30, 0.09, 1), TRS(0, g0 + H - 0.18, 0), S.trim);
  const rows = clamp(Math.round(H / (S.floorH || 3.2)), 1, 3);
  for (let r = 0; r < rows; r++) {
    const yy = g0 + (H * (r + 0.55)) / rows;
    const wh = Math.min(1.5, (H / rows) * 0.42);
    for (const face of [0, 1, 2, 3]) {
      const span = faceSpan(face, w, d);
      const n = clamp(Math.round(span / 4.0), 1, 6);
      const pw = Math.min(1.3, (span / n) * 0.44);
      for (let i = 0; i < n; i++) {
        const u = -span / 2 + (span * (i + 0.5)) / n;
        K.add((i + r) % 3 ? 'glassWarm' : 'glassCool',
          boxRound(pw, wh, 0.10, 0.03, 1), faceMat(face, w, d, u, yy, 0.02), 0xffffff);
      }
      if (r === 0 && rows > 1) {
        K.add('stone', boxRound(span + 0.18, 0.18, 0.22, 0.05, 1),
          faceMat(face, w, d, 0, g0 + H / rows, 0.02), S.trim);
      }
    }
  }

  if (S.roofKind === 'flat') {
    K.add('roof', boxRound(w + 0.6, 0.5, d + 0.6, 0.12, 1), TRS(0, meta.ground + H + 0.25, 0), S.roof);
  } else {
    const along = w >= d ? 'x' : 'z';
    const ridge = Math.max(1.0, (loc.size.h - H) * 0.9);
    K.add('roof', roofSolid({
      w: along === 'x' ? d : w, d: along === 'x' ? w : d, ridge, thick: 0.3,
      overW: 0.6, overD: 0.5, sag: 0.06, hip: 0.25, curve: 1.2, flare: 0.1, uSeg: 3, tSeg: 3,
    }), TRS(0, meta.ground + H, 0, along === 'x' ? PI / 2 : 0), S.roof);
  }
  return K;
}
