/* ============================================================
   signs.js — every location's nameboard.

   Players navigate this island by reading signs, so legibility at
   gameplay distance is the whole specification. Each board carries the
   location's name and its emoji glyph straight out of game/data.js,
   painted to a canvas at boot — no external assets anywhere.

   The board is a real object: a chamfered timber panel, a painted
   face, a moulded frame, an iron bracket bolted to the wall and two
   eye-rings it hangs from. It swings in ctx.wind like everything else.

   ------------------------------------------------------------------
   THE HEADROOM CONTRACT — why the boards moved.

   Every board on the island used to hang from a fixed anchor and drop
   `bh/2 + 0.34` BELOW it, on a bracket that stood the panel a metre and
   three quarters clear of its own wall. On the tall forms that reads
   fine. On a shopfront it put a 3.5 x 1.8 m slab in the street with its
   bottom edge at 0.5-0.8 m — below Wally's 1.58 m head, square across
   the door, hiding the shopfront it was naming. Fifteen of the
   twenty-eight boards were at or under head height, and every one of
   them was walk-through: signs.js registered nothing with ctx.phys.

   Two changes, and they are the same change:

     1. THE BOARD IS SOLVED, NOT PLACED. `meta.signAnchor` now only
        fixes where on the frontage the bracket goes; the height is
        solved so the board's LOWEST point clears HEADROOM above the
        ground beneath it. The solve only ever RAISES — the temple and
        stadium boards deliberately ride high and must not be dragged
        down — and it is bounded by `meta.signCeil`, the architectural
        line above which a board would foul a window or the eaves. When
        the frontage genuinely cannot give the room the board SHRINKS
        rather than floating up through the first-floor sills, down to a
        legibility floor of MIN_W; below that the board stays low and
        the collider is what saves it.

     2. THE BOARD IS SOLID. One oriented box per panel, registered from
        city.js's wirePhysics (ctx.phys does not exist while the world
        stage runs). The bracket is not in it — a 13 cm arm is not worth
        a body, and keeping the box to the panel keeps it off the
        camera's clearance rays.

   The bracket kept its reach on purpose. Shortening it was tried and
   measured: a 0.6 m arm tucks the panel behind the porch canopy on a
   shopfront and behind the veranda roof on a market stall, and half a
   name is worse than no name. The length was never what was wrong with
   these boards — the height was. Where no bracket can reach past what a
   frontage hangs in front of itself, the form says so with
   `meta.signSill` and the board goes ABOVE it instead.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { BRAND, BUILD, LAND } from '../core/palette.js';
import { clamp, lerp, damp } from '../core/contracts.js';
import { boxRound, cyl, torusG, sphereG, TRS, mixHex, shadeHex, hexOf, C, Kit, makeAO } from './kits.js';

const css = (h) => '#' + (hexOf(h) >>> 0).toString(16).padStart(6, '0');

/* ------------------------------------------------------------------
   The painted face.
   ------------------------------------------------------------------ */
function signCanvas(loc, tint, opts = {}) {
  const W = 512, H = 208;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');

  const paper = css(opts.paper ?? BRAND.paper);
  const ink = css(opts.ink ?? BRAND.ink);
  const accent = css(tint);

  /* ground */
  g.fillStyle = paper;
  g.fillRect(0, 0, W, H);

  /* a hand-painted wash so the board is never a flat fill */
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, 'rgba(255,255,255,0.55)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.0)');
  grd.addColorStop(1, 'rgba(0,0,0,0.13)');
  g.fillStyle = grd;
  g.fillRect(0, 0, W, H);

  /* border: an accent field with a thin ink keyline inside it */
  g.fillStyle = accent;
  g.fillRect(0, 0, W, 16); g.fillRect(0, H - 16, W, 16);
  g.fillRect(0, 0, 16, H); g.fillRect(W - 16, 0, 16, H);
  g.strokeStyle = ink; g.lineWidth = 4; g.globalAlpha = 0.85;
  g.strokeRect(22, 22, W - 44, H - 44);
  g.globalAlpha = 1;

  /* the glyph, on an accent roundel so it reads even where the
     platform has no colour-emoji font */
  const cy = H / 2, r = 60;
  const cx = 96;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fillStyle = mixHexCss(tint, BRAND.paper, 0.30); g.fill();
  g.lineWidth = 6; g.strokeStyle = ink; g.globalAlpha = 0.75; g.stroke(); g.globalAlpha = 1;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '76px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
  g.fillStyle = ink;
  try { g.fillText(loc.ico || '•', cx, cy + 4); } catch (e) { /* glyphless platform */ }

  /* the name — fitted, wrapped to two lines if it has to be */
  const boxX = 176, boxW = W - boxX - 34;
  const words = String(loc.n || '').split(/\s+/);
  let size = 62, lines = [String(loc.n || '')];
  const fits = (arr, s) => {
    g.font = `700 ${s}px "Trebuchet MS",Verdana,Geneva,sans-serif`;
    return arr.every((l) => g.measureText(l).width <= boxW);
  };
  while (size > 22 && !fits(lines, size)) {
    if (lines.length === 1 && words.length > 1) {
      let best = 1, bestD = Infinity;
      for (let i = 1; i < words.length; i++) {
        const a = words.slice(0, i).join(' ').length, b = words.slice(i).join(' ').length;
        if (Math.abs(a - b) < bestD) { bestD = Math.abs(a - b); best = i; }
      }
      lines = [words.slice(0, best).join(' '), words.slice(best).join(' ')];
      size = 56;
    } else if (lines.length === 2 && size <= 34 && words.length > 2) {
      const t = Math.ceil(words.length / 3);
      lines = [words.slice(0, t).join(' '), words.slice(t, t * 2).join(' '), words.slice(t * 2).join(' ')].filter(Boolean);
      size = 40;
    } else size -= 2;
  }
  g.font = `700 ${size}px "Trebuchet MS",Verdana,Geneva,sans-serif`;
  g.textAlign = 'left'; g.textBaseline = 'middle';
  const lh = size * 1.06;
  const y0 = cy - ((lines.length - 1) * lh) / 2;
  for (let i = 0; i < lines.length; i++) {
    /* a soft drop so the letters survive bloom and haze */
    g.fillStyle = 'rgba(0,0,0,0.20)';
    g.fillText(lines[i], boxX + 3, y0 + i * lh + 3);
    g.fillStyle = ink;
    g.fillText(lines[i], boxX, y0 + i * lh);
  }

  /* two painted studs, because a real board has fixings */
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.beginPath(); g.arc(34, 34, 6, 0, 6.29); g.fill();
  g.beginPath(); g.arc(W - 34, H - 34, 6, 0, 6.29); g.fill();

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

function mixHexCss(a, b, k) {
  a = hexOf(a); b = hexOf(b);
  const m = (sa, sb) => Math.round(lerp(sa, sb, k));
  return '#' + (
    (m((a >> 16) & 255, (b >> 16) & 255) << 16) |
    (m((a >> 8) & 255, (b >> 8) & 255) << 8) |
    m(a & 255, b & 255)
  ).toString(16).padStart(6, '0');
}

/* ------------------------------------------------------------------
   The object.
   ------------------------------------------------------------------ */
/* The clearance the solve is aiming for, and the size floor it will
   not trade away to get it.

   HEADROOM is Wally's 1.584 m standing height plus his jump: the
   controller clears about 0.5 m, so 2.15 m is the first number he
   cannot reach the underside of by running and jumping at it. */
const HEADROOM = 2.15;
const MIN_W = 2.40;                       // legibility floor
const MAX_W = 3.60;
/* 512 x 208 px of painted face, at its own aspect. The 1.28 vertical
   stretch this used to carry was buying letter height by distorting
   every glyph and the roundel with it — and it was also 0.4 m of the
   headroom the board needed. Undistorted, wider, higher. */
const ASPECT = 208 / 512;
/* Panel extents relative to the bracket anchor, from the geometry
   below: the frame rails add 0.095 above and below the panel and the
   eye-rings drop it by HANG. */
const HANG = 0.30;
const RAIL = 0.095;

/**
 * Where the board hangs and how big it is, in the building's LOCAL
 * frame — the frame meta.signAnchor is written in, whose y = 0 is the
 * building's own base plane and whose world position is site.groundY.
 *
 * Lifted out of createSign because the player's APARTMENT is rebuilt at
 * runtime every time he moves up a tier, and each tier is a different
 * building with a different frontage. city.js kept the sign object
 * across that rebuild — so the one board in the game the player looks
 * at every day was solved against a building that no longer existed,
 * which is why it was the lowest-hanging board on the island. It is
 * re-solved on rebuild now (see reposition()).
 *
 * `fixed` pins the panel size when the caller cannot rebuild the
 * geometry; the height solve then works with what it has.
 */
function solveBoard(loc, meta, site = {}, fixed = null) {
  const anchor = meta.signAnchor.clone();

  /* The ground UNDER the board, not the building's base plane. A pier
     names itself from its deck; a shop founded on the low side of its
     own footprint stands on terrain that is often a quarter of a metre
     above y = 0, and clearance measured off the wrong plane is not
     clearance. */
  let base = meta.signBase ?? 0;
  if (site.world && site.groundY != null) {
    const c = Math.cos(site.yaw || 0), s = Math.sin(site.yaw || 0);
    const wx = loc.world.x + anchor.x * c + anchor.z * s;
    const wz = loc.world.z - anchor.x * s + anchor.z * c;
    base = Math.max(base, site.world.heightAt(wx, wz) - site.groundY);
  }

  /* The line the board's top may not cross. eaveY is the fallback and
     it is a generous one — the forms that need a tighter answer (a
     shopfront under its first-floor sills, a stall under its own
     veranda plate) set meta.signCeil themselves. Never below where the
     form already put the board: a ceiling must not drag one DOWN. */
  const curTop = anchor.y - HANG + RAIL;
  const ceil = Math.max(meta.signCeil ?? ((meta.eaveY ?? anchor.y) - 0.30), curTop);

  /* legibility at gameplay distance is the whole specification, and a
     1.9 m board on a 13 m frontage was 40 px wide from the street */
  let bw = fixed ? fixed.bw : clamp(loc.size.w * 0.34, MIN_W, MAX_W);
  let bh = fixed ? fixed.bh : bw * ASPECT;

  /* The board's bottom has to clear a head — and, on the forms that
     carry a veranda or a lean-to across their whole frontage, it also
     has to clear THAT, because no bracket is long enough to reach past
     a three-metre market porch and a board behind one is a board nobody
     can read from the street. `meta.signSill` is that line. */
  const floorY = Math.max(base + HEADROOM, meta.signSill ?? -Infinity);

  /* room = what is left between the floor line and the ceiling once
     the frame rails are paid for. Shrink into it if we have to; never
     below the legibility floor. */
  if (!fixed) {
    const room = ceil - floorY - 2 * RAIL;
    if (bh > room) {
      bh = Math.max(room, MIN_W * ASPECT);
      bw = Math.max(bh / ASPECT, MIN_W);
      bh = bw * ASPECT;
    }
  }

  /* Raise only. A board that already hangs clear — a temple pediment,
     the stadium fascia — keeps the height its own form chose for it. */
  const wantY = floorY + HANG + bh + RAIL;
  const capY = Math.max(anchor.y, ceil + HANG - RAIL);
  anchor.y = clamp(Math.max(anchor.y, wantY), anchor.y, capY);

  return { anchor, base, bw, bh, bottom: anchor.y - HANG - bh - RAIL };
}

export function createSign(ctx, loc, S, meta, rng, lib, site = {}) {
  const tint = S.tint;
  const tex = signCanvas(loc, tint);
  const mat = ctx.mat.toon({
    name: `sign.${loc.id}`,
    map: tex, color: 0xffffff,
    term: 0.12, bandSoft: 0.032, band2: 0.16, core: 0.52,
    spec: 0.05, specPow: 22, rim: 0.42, skyBounce: 0.16,
    grain: 0.008, grainScale: 5.0, grainAlbedo: 0.06,
    /* a whisper of self-illumination: the board must still be readable
       under a night sky without turning into a lamp */
    emissive: 0.10, emissiveColor: BRAND.paper,
    outline: true, outlineWidth: 3.0,
  });

  const solved = solveBoard(loc, meta, site, null);
  const anchor = solved.anchor;
  let base = solved.base;
  const bw = solved.bw, bh = solved.bh;
  let boardBottom = solved.bottom;

  const pivot = new THREE.Group();
  pivot.name = `sign.${loc.id}`;

  const kit = new Kit(makeAO({ ground: 1, groundH: 0.01, under: 0.72 }));
  const board = new THREE.Group();

  /* bracket: an arm off the wall with a diagonal stay and two eyes.
     The arm is a BRACKET, not a boom — scaling it with the board threw
     a 3.5 m board two and a half metres clear of its own wall.

     The bracket LENGTH is not what was wrong with these boards — the
     height was. A panel 1.5 m clear of the wall with its bottom edge at
     0.6 m is a billboard standing in the doorway; the same panel at
     2.2 m is a hanging shop sign you walk under, and it needs that
     reach to hang in FRONT of the awning rather than behind it.
     (Measured: shortening the arm to 0.6 m put the Apartment board
     behind its own porch canopy and the Noodle Cart board behind its
     veranda roof — the name half readable from the street.) */
  const arm = clamp(bw * 0.42, 1.00, 1.45);
  kit.add('metal', boxRound(0.13, 0.13, arm, 0.04, 1), TRS(0, 0, arm / 2 - 0.05), C.lead);
  kit.add('metal', boxRound(0.10, 0.10, arm * 0.9, 0.035, 1), TRS(0, -arm * 0.32, arm * 0.42, 0, 1, 1, 1, 0.62), C.lead);
  kit.add('metal', boxRound(0.30, 0.30, 0.16, 0.06, 1), TRS(0, 0, 0.02), C.lead);
  kit.add('metal', sphereG(0.07, 8), TRS(0, 0.02, arm - 0.06), C.gold);
  for (const sx of [-1, 1]) {
    kit.add('metal', torusG(0.075, 0.022, 10, 6), TRS(sx * bw * 0.36, -0.16, arm - 0.06, 0, 1, 1, 1, 0, Math.PI / 2), C.lead);
    kit.add('metal', cyl(0.022, 0.022, 0.30, 5, false), TRS(sx * bw * 0.36, -0.30, arm - 0.06), C.lead);
  }
  const bracket = new THREE.Mesh(kit.b('metal').build(`sign.${loc.id}.bracket`), lib.mats.signIron);
  bracket.name = `sign.${loc.id}.bracket`;

  /* the panel itself: timber back, moulded frame, painted face */
  const pk = new Kit(makeAO({ ground: 1, groundH: 0.01, under: 0.8 }));
  pk.add('wood', boxRound(bw, bh, 0.13, 0.04, 1), TRS(0, 0, 0), mixHex(BUILD.woodDark, tint, 0.35));
  pk.add('wood', boxRound(bw + 0.16, 0.13, 0.20, 0.045, 1), TRS(0, bh / 2 + 0.03, 0.01), mixHex(BUILD.wood, tint, 0.3));
  pk.add('wood', boxRound(bw + 0.16, 0.13, 0.20, 0.045, 1), TRS(0, -bh / 2 - 0.03, 0.01), mixHex(BUILD.wood, tint, 0.3));
  pk.add('wood', boxRound(0.13, bh + 0.24, 0.20, 0.045, 1), TRS(-bw / 2 - 0.03, 0, 0.01), mixHex(BUILD.wood, tint, 0.3));
  pk.add('wood', boxRound(0.13, bh + 0.24, 0.20, 0.045, 1), TRS(bw / 2 + 0.03, 0, 0.01), mixHex(BUILD.wood, tint, 0.3));
  const backing = new THREE.Mesh(pk.b('wood').build(`sign.${loc.id}.board`), lib.mats.signBoard);

  /* both faces of the board are painted, and they are ONE mesh: the
     plane is doubled in geometry rather than in draw calls */
  const fw = bw * 0.94, fh2 = bh * 0.9;
  const faceGeo = new THREE.BufferGeometry();
  faceGeo.setAttribute('position', new THREE.Float32BufferAttribute([
    -fw / 2, -fh2 / 2, 0.075, fw / 2, -fh2 / 2, 0.075, fw / 2, fh2 / 2, 0.075, -fw / 2, fh2 / 2, 0.075,
    fw / 2, -fh2 / 2, -0.075, -fw / 2, -fh2 / 2, -0.075, -fw / 2, fh2 / 2, -0.075, fw / 2, fh2 / 2, -0.075,
  ], 3));
  faceGeo.setAttribute('normal', new THREE.Float32BufferAttribute([
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1,
  ], 3));
  faceGeo.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1,
  ], 2));
  faceGeo.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  const face = new THREE.Mesh(faceGeo, mat);
  face.name = `sign.${loc.id}.face`;

  board.add(backing, face);
  board.position.set(0, -bh / 2 - HANG, arm - 0.06);
  pivot.add(bracket, board);

  pivot.position.copy(anchor);

  /* ----------------------------------------------------------------
     The collider, deferred.

     ctx.phys does not exist while the world stage runs, so this is a
     closure city.js calls from wirePhysics. The box is the PANEL only,
     sized to the frame rather than the swing: the board swings +/- 0.34
     rad in the wind and a collider that tracked it would be a moving
     static, which the grid cannot express. A fixed box at rest is the
     honest approximation — it is within 4 cm of the panel at the
     extremes of a 1.5 m half-width.
     ---------------------------------------------------------------- */
  let colId = null;
  const _cm = new THREE.Matrix4();
  const _cv = new THREE.Vector3();

  const phase = rng() * 6.283;
  return {
    group: pivot, board, mat, tex,
    width: bw, height: bh,
    /* what the solve decided, in the building's local frame — this is
       what tools/cliptest.mjs and the report are measured against */
    get anchorY() { return anchor.y; },
    get bottomY() { return boardBottom; },
    get clearance() { return boardBottom - base; },
    /**
     * Re-solve against a NEW meta, keeping the panel geometry. For the
     * apartment, which is a different building every tier: the board
     * has to find the new frontage's headroom, sill and eaves, or it
     * goes on hanging where the building it was born on put it.
     */
    reposition(nextMeta, nextSite = site, phys = ctx.phys) {
      const r = solveBoard(loc, nextMeta, nextSite, { bw, bh });
      anchor.copy(r.anchor);
      boardBottom = r.bottom;
      base = r.base;
      pivot.position.copy(anchor);
      pivot.updateWorldMatrix(true, false);
      if (colId !== null) { phys?.remove(colId); colId = null; this.registerCollider(phys); }
      return r;
    },
    registerCollider(phys) {
      if (colId !== null || !phys || !phys.addOBB) return null;
      pivot.updateWorldMatrix(true, false);
      board.updateWorldMatrix(true, false);
      /* the panel's world centre at rest, with the sway taken out: the
         board's own local offset, put through the pivot's matrix */
      _cv.set(0, -bh / 2 - HANG, arm - 0.06).applyMatrix4(pivot.matrixWorld);
      _cm.copy(pivot.matrixWorld);
      _cm.setPosition(_cv);
      /* strip the pivot's scale, keep its yaw; addOBB bakes the matrix */
      colId = phys.addOBB(bw + 0.16, bh + 0.19, 0.26, _cm, { name: 'sign.board', prop: true });
      return colId;
    },
    get colliderId() { return colId; },
    localPos: anchor.clone().add(new THREE.Vector3(0, -bh / 2 - HANG, arm - 0.06)),
    update(dt, elapsed, wind, worldX, worldZ) {
      /* a hanging board is a pendulum with a lot of drag: it lags the
         gust and settles slowly. Wind Waker's signs never stop moving.

         THE CLAMPS ARE NOT DECORATION. damp() is lerp(a, b, 1-e^(-k dt));
         one frame delivered with a non-positive or non-finite dt — a
         clock jump, a paused tab, a debug hook that reposes the world —
         makes that factor enormously negative and throws the value to
         1e10 in a single step, from which it decays back over minutes.
         Every nameboard in the city was hanging at a garbage angle, most
         of them showing the reader the BACK of the painted face. Bound
         both the timestep and the result and it cannot happen. */
      const h = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
      const s = wind ? wind.sample(worldX, worldZ, phase) : Math.sin(elapsed + phase);
      const sw = Number.isFinite(s) ? s : 0;
      const rz = damp(board.rotation.z, clamp(sw * 0.16, -0.34, 0.34), 4.5, h);
      const rx = damp(board.rotation.x, Math.sin(elapsed * 1.7 + phase) * 0.025, 4, h);
      board.rotation.z = Number.isFinite(rz) ? clamp(rz, -0.34, 0.34) : 0;
      board.rotation.x = Number.isFinite(rx) ? clamp(rx, -0.06, 0.06) : 0;
    },
    dispose() {
      if (colId !== null) { ctx.phys?.remove(colId); colId = null; }
      tex.dispose(); mat.dispose(); faceGeo.dispose(); backing.geometry.dispose(); bracket.geometry.dispose();
    },
  };
}
