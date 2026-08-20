/* ============================================================
   signs.js — every location's nameboard.

   Players navigate this island by reading signs, so legibility at
   gameplay distance is the whole specification. Each board carries the
   location's name and its emoji glyph straight out of game/data.js,
   painted to a canvas at boot — no external assets anywhere.

   The board is a real object: a chamfered timber panel, a painted
   face, a moulded frame, an iron bracket bolted to the wall and two
   eye-rings it hangs from. It swings in ctx.wind like everything else.
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
export function createSign(ctx, loc, S, meta, rng, lib) {
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

  /* legibility at gameplay distance is the whole specification, and a
     1.9 m board on a 13 m frontage was 40 px wide from the street */
  const bw = clamp(loc.size.w * 0.34, 2.3, 3.5);
  const bh = bw * (208 / 512) * 1.28;

  const pivot = new THREE.Group();
  pivot.name = `sign.${loc.id}`;

  const kit = new Kit(makeAO({ ground: 1, groundH: 0.01, under: 0.72 }));
  const board = new THREE.Group();

  /* bracket: an arm off the wall with a diagonal stay and two eyes.
     The arm is a BRACKET, not a boom — scaling it with the board threw
     a 3.5 m board two and a half metres clear of its own wall. */
  const arm = clamp(bw * 0.46, 1.0, 1.5);
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
  board.position.set(0, -bh / 2 - 0.34, arm - 0.06);
  pivot.add(bracket, board);

  const anchor = meta.signAnchor;
  pivot.position.copy(anchor);

  const phase = rng() * 6.283;
  return {
    group: pivot, board, mat, tex,
    width: bw, height: bh,
    localPos: anchor.clone().add(new THREE.Vector3(0, -bh / 2 - 0.34, arm - 0.06)),
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
    dispose() { tex.dispose(); mat.dispose(); faceGeo.dispose(); backing.geometry.dispose(); bracket.geometry.dispose(); },
  };
}
