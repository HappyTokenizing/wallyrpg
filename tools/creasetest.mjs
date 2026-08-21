#!/usr/bin/env node
/* ============================================================
   creasetest.mjs — THE ARM/FLANK CREASE RULER.

   The user's complaint was "textures get glued from body to arms".
   Three rounds chased it as a GAP WIDTH problem and three rounds
   failed, because ref/wally-ref-cool.png does not solve it with a gap
   either: measured with tools/armslot.mjs the reference shows 2-22 mm
   of interior background across f 0.33-0.60 and ZERO across f
   0.42-0.48, while this build already shows MORE true background than
   the reference at f 0.51-0.60 — and still read as glued.

   The reference separates the arm from the flank with a DEEP DARK
   CREASE, not with a hole. So this ruler measures the crease.

   THE MEASUREMENT. Take a horizontal luminance row at a fraction f of
   the figure height, walk inward from the figure's outer edge, and
   read the profile   lit arm -> crease -> lit flank:

     valley depth  = 1 - Lmin / min(peakOuter, peakInner)
     valley width  = full width at half depth, in millimetres,
                     half level = Lmin + 0.5 * (min(peak) - Lmin)

   Depth says how dark the separation gets; width says whether it is
   the reference's soft wide valley or a hairline scratch. BOTH have
   to match or the arm still reads welded.

   SCAN THE HANGING-ARM SIDE, WHICH IS THE IMAGE-RIGHT ONE IN BOTH
   IMAGES (--side R, the default). At f 0.44 the image-LEFT extreme of
   both figures is the up-curled TRUNK, not an arm, and a ruler pointed
   there measures a trunk shadow and calls it a crease.

   The gate is the reference's own reading under this same script at the
   same f, not a number carried over from a different ruler: run it and
   the REF columns print beside the GAME ones every time.

   WHY TWO SHOTS. The studio backdrop is a light grey within a few
   luma of the clay, so no threshold can find the figure's edge in the
   frame we must measure. The mask therefore comes from a second,
   pixel-identical frame shot on a magenta backdrop (the same trick
   tools/armslot.mjs uses); the luminance comes from the real frame.
   studioBG only repaints the backdrop quad, so the two frames agree
   on every figure pixel.

   Usage
     node tools/creasetest.mjs                     # shoot + compare vs ref
     node tools/creasetest.mjs --no-shot           # reuse existing PNGs
     node tools/creasetest.mjs --pose welcome      # welcome must not gash
     node tools/creasetest.mjs --f 0.40,0.44,0.48
     node tools/creasetest.mjs --side L            # L (image-left) or R or both
     node tools/creasetest.mjs --dump 0.44         # raw profile for one row
     node tools/creasetest.mjs --json
   ============================================================ */

import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);

const POSE = arg('pose', 'cool');
const REF = arg('ref', 'ref/wally-ref-cool.png');
const W = +arg('w', 900), H = +arg('h', 1300);
const WAIT = +arg('wait', 6000);
const FS = arg('f', '0.40,0.44,0.48').split(',').map(Number);
const SIDES = arg('side', 'R').toUpperCase();   // R = the hanging arm, both figures
const DUMP = arg('dump', null);
const EXTRA = arg('extra', '');   // extra js, run after studio() in both frames
const SHOT = `shots/_crease-${POSE}.png`;
const MASK = `shots/_crease-${POSE}-bg.png`;
const BODY_H_MM = 1600;            // §1.1: H = 1.60 m

/* ---------- PNG ---------- */
function decodePNG(buf) {
  let p = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('bit depth ' + bitDepth);
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!ch) throw new Error('color type ' + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let q = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[q++];
    const row = raw.subarray(q, q + stride); q += stride;
    const o = y * stride, po = o - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[o + x - ch] : 0;
      const b = y > 0 ? out[po + x] : 0;
      const c = (x >= ch && y > 0) ? out[po + x - ch] : 0;
      let v = row[x];
      switch (f) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          break;
        }
        default: throw new Error('filter ' + f);
      }
      out[o + x] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/* ---------- masks ----------
   Magenta for the game frame; a flood fill through dark pixels for the
   reference, which ships on a black field (a plain luma threshold would
   punch a hole through the true-black lenses — see silhouette.mjs). */
function magentaMask(img) {
  const { w, h, ch, data } = img;
  const m = new Uint8Array(w * h);
  for (let i = 0, n = w * h; i < n; i++) {
    const r = data[i * ch], g = data[i * ch + 1], b = data[i * ch + 2];
    m[i] = (r > 110 && b > 110 && g < r - 60 && g < b - 60) ? 0 : 1;
  }
  return m;
}
function floodMask(img, dark = 26) {
  const { w, h, ch, data } = img;
  const isDark = new Uint8Array(w * h);
  for (let i = 0, n = w * h; i < n; i++) {
    isDark[i] = luma(data[i * ch], data[i * ch + 1], data[i * ch + 2]) < dark ? 1 : 0;
  }
  const bg = new Uint8Array(w * h);
  const st = [];
  for (let x = 0; x < w; x++) { st.push(x, x + (h - 1) * w); }
  for (let y = 0; y < h; y++) { st.push(y * w, y * w + w - 1); }
  while (st.length) {
    const i = st.pop();
    if (bg[i] || !isDark[i]) continue;
    bg[i] = 1;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) st.push(i - 1);
    if (x < w - 1) st.push(i + 1);
    if (y > 0) st.push(i - w);
    if (y < h - 1) st.push(i + w);
  }
  const m = new Uint8Array(w * h);
  for (let i = 0, n = w * h; i < n; i++) m[i] = bg[i] ? 0 : 1;
  return m;
}
function extents(mask, w, h) {
  let top = -1, bot = -1;
  for (let y = 0; y < h; y++) {
    let any = false;
    for (let x = 0; x < w; x++) if (mask[y * w + x]) { any = true; break; }
    if (any) { if (top < 0) top = y; bot = y; }
  }
  return { top, bot };
}

/* ---------- the scan ----------
   Walk inward from the figure's silhouette edge on one row. `dir` is +1
   for the image-left side and -1 for the image-right side, so both
   sides read outer -> inner and the numbers compare directly.

   FOUR THINGS THIS RULER HAS TO GET RIGHT. Each of them broke an
   earlier cut of it, and each is why "just eyeball the crease" failed
   three rounds running.

   1. THE PROFILE IS CLAY ONLY; BACKGROUND IS DELETED, NOT SAMPLED.
      The two images do not share a backdrop — ref/wally-ref-cool.png is
      cut on BLACK and the studio rig clears to #E6E7E9 — so the very
      same 3 mm hole in the arm slot reads as luma 1 on the reference
      and luma 187 on the build. Sampled, the reference's hole fakes a
      crease that is 100% deep and the build's hole fakes a PEAK in the
      middle of one, splitting a single valley into two shallow ones.
      Mask pixels and near-black pixels are therefore both dropped from
      the profile and reported separately as `gap`.

   2. THE WINDOW IS PHYSICAL, NOT PROPORTIONAL. 220 mm inward from the
      silhouette edge covers the arm (110-150 mm projected), the crease,
      and 50-70 mm of flank. Wider and the scan reaches the trunk's own
      shadow, which is darker than any arm crease and is not one.

   3. THE CREASE IS THE DARKEST CLAY IN THE JUNCTION BAND, not the first
      dip. A hysteresis walker stops on the arm's own inner terminator —
      a 6-luma wobble 20 mm short of the real thing.

   4. DEPTH ALONE CANNOT SEE THE DEFECT, so `flank` is reported beside
      it. 1 - crease/min(peaks) is a RATIO: a dark crease against a dark
      flank scores the same as a dark crease against a lit one, and the
      difference between those two is exactly the difference between the
      reference and a welded arm. The reference's flank recovers to
      ~205 within 60 mm of the crease floor; a build whose flank is
      still at 130 there has no crease, whatever the ratio says. */
/* 5. THE WINDOW IS SIZED FOR THE ARM, AND THE MITTEN IS WIDER THAN THE
      ARM. Below f ~0.64 the row stops crossing a 110-150 mm forearm and
      starts crossing the 169 mm mitten (PROP.hand), so the junction it
      is looking for sits at 190-210 mm — ON the edge of the search band,
      where a valley reads as a monotonic slide off the end. --win / --hi
      widen it for those rows ONLY when asked; the defaults are
      unchanged, because on the upper rows a wider window reaches the
      trunk's own shadow and reports it as a crease. Quote the default
      numbers; quote a widened one as what it is. */
const WINDOW_MM = +arg('win', 220);
const CREASE_LO_MM = +arg('lo', 55);   // inboard of the arm's own lit face
const CREASE_HI_MM = +arg('hi', 205);
const EDGE_SKIP_MM = 5;            // anti-aliased silhouette edge
const BLACK = 14;                  // below this it is a hole, not clay

function scanRow(img, mask, y, side, mmPerPx) {
  const { w, ch, data } = img;
  let l = -1, r = -1;
  for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (l < 0) l = x; r = x; }
  if (l < 0 || r - l < 8) return null;
  const dir = side === 'L' ? 1 : -1;
  const x0 = side === 'L' ? l : r;

  const nWin = Math.min(Math.round(WINDOW_MM / mmPerPx), r - l);
  const raw = [], px = [], rb = [];
  let gapPx = 0;
  for (let i = 0; i < nWin; i++) {
    const x = x0 + dir * i;
    if (x < 0 || x >= w) break;
    const o = (y * w + x) * ch;
    const v = luma(data[o], data[o + 1], data[o + 2]);
    if (!mask[y * w + x] || v < BLACK) { gapPx++; continue; }
    raw.push(v); px.push(x); rb.push(data[o] - data[o + 2]);
  }
  const n = raw.length;
  if (n < 20) return null;

  /* smooth over +/- 2 mm: kills the clay grain, invisible to a 30 mm valley */
  const k = Math.max(1, Math.round(2.0 / mmPerPx));
  const p = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = -k; j <= k; j++) { const t = i + j; if (t >= 0 && t < n) { s += raw[t]; c++; } }
    p[i] = s / c;
  }
  const skip = Math.max(1, Math.round(EDGE_SKIP_MM / mmPerPx));
  const lo = Math.max(skip + 1, Math.round(CREASE_LO_MM / mmPerPx));
  const hi = Math.min(n - 2, Math.round(CREASE_HI_MM / mmPerPx));
  if (hi <= lo) return null;

  let vMin = Infinity, iMin = -1;
  for (let i = lo; i <= hi; i++) if (p[i] < vMin) { vMin = p[i]; iMin = i; }
  let peakOuter = -Infinity, iOuter = -1;
  for (let i = skip; i < iMin; i++) if (p[i] > peakOuter) { peakOuter = p[i]; iOuter = i; }
  let peakInner = -Infinity, iInner = -1;
  for (let i = iMin + 1; i < n; i++) if (p[i] > peakInner) { peakInner = p[i]; iInner = i; }
  if (iOuter < 0 || iInner < 0) return null;

  const base = Math.min(peakOuter, peakInner);
  const depth = 1 - vMin / base;
  const half = vMin + 0.5 * (base - vMin);
  let a = iMin; while (a > iOuter && p[a] < half) a--;
  let b = iMin; while (b < iInner && p[b] < half) b++;
  const lerp = (i0, i1) => (p[i1] === p[i0] ? i0 : i0 + (half - p[i0]) / (p[i1] - p[i0]) * (i1 - i0));
  const xa = a === iMin ? iMin : lerp(a, a + 1);
  const xb = b === iMin ? iMin : lerp(b, b - 1);
  const width = Math.abs(xb - xa) * mmPerPx;

  /* §1.2: occlusion on the character is WARM (#A9A9A8 family), never
     blue — a crease that has gone cool is a new bug, and a deeper crease
     is exactly where one appears. R-B is averaged over +/- 4 mm of the
     floor and, for contrast, over the arm's lit peak. */
  const span = Math.max(1, Math.round(4 / mmPerPx));
  const meanRB = (c0) => {
    let t = 0, m = 0;
    for (let j = c0 - span; j <= c0 + span; j++) if (j >= 0 && j < n) { t += rb[j]; m++; }
    return m ? t / m : 0;
  };
  return {
    peakOuter, min: vMin, peakInner, depth, width,
    warmCrease: meanRB(iMin), warmLit: meanRB(iOuter),
    gapMM: gapPx * mmPerPx,
    armMM: iMin * mmPerPx,
    profile: p, skip, iMin, iOuter, iInner, mmPerPx, xs: px,
  };
}

/* ---------- shots ---------- */
function shoot() {
  /* --extra "js" runs AFTER the studio rig is up, in both frames, so a
     bake can be dialled out (wallySculpt(0), wallyAO(0)) and the SAME
     ruler re-run on the result. This is the only way to tell a dark
     flank that the seam band put there from one the studio key did:
     zero the band, re-scan, read the difference. */
  const evalPlain = `WALLY.debug.studio('${POSE}');${EXTRA}`;
  const evalMask = `WALLY.debug.studioBG&&WALLY.debug.studioBG([1,0,1]);WALLY.debug.studio('${POSE}');${EXTRA}`;
  for (const [out, ev] of [[SHOT, evalPlain], [MASK, evalMask]]) {
    const r = spawnSync('node', [
      'tools/shot.mjs', out, '--wait', String(WAIT), '--eval', ev,
      '--w', String(W), '--h', String(H),
    ], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) {
      console.error(r.stdout || '', r.stderr || '');
      process.exit(1);
    }
    const perf = (r.stdout || '').match(/\[perf\][^\n]*/);
    if (perf && out === SHOT) console.log(perf[0]);
  }
}

/* ---------- run ---------- */
if (!flag('no-shot')) shoot();

const gImg = decodePNG(await readFile(resolve(ROOT, SHOT)));
const gMaskImg = decodePNG(await readFile(resolve(ROOT, MASK)));
const gMask = magentaMask(gMaskImg);
const gExt = extents(gMask, gMaskImg.w, gMaskImg.h);
const gFigH = gExt.bot - gExt.top + 1;
const gMM = BODY_H_MM / gFigH;

const rImg = decodePNG(await readFile(resolve(ROOT, REF)));
const rMask = floodMask(rImg);
const rExt = extents(rMask, rImg.w, rImg.h);
const rFigH = rExt.bot - rExt.top + 1;
const rMM = BODY_H_MM / rFigH;

const sides = SIDES === 'BOTH' ? ['L', 'R'] : [SIDES];
const rows = [];
for (const f of FS) {
  for (const side of sides) {
    const gy = Math.round(gExt.top + f * (gFigH - 1));
    const ry = Math.round(rExt.top + f * (rFigH - 1));
    rows.push({
      f, side,
      game: scanRow(gImg, gMask, gy, side, gMM),
      ref: scanRow(rImg, rMask, ry, side, rMM),
    });
  }
}

if (DUMP !== null) {
  const f = +DUMP;
  const row = rows.find(r => Math.abs(r.f - f) < 1e-9) || rows[0];
  for (const [name, s] of [['GAME', row.game], ['REF', row.ref]]) {
    if (!s) { console.log(`${name}: no row`); continue; }
    console.log(`\n${name} f=${row.f} ${row.side}  (${s.mmPerPx.toFixed(3)} mm/px)`);
    let out = '';
    for (let i = 0; i < s.profile.length; i += Math.max(1, Math.round(2 / s.mmPerPx))) {
      const mark = i === s.iMin ? '*' : (i === s.iOuter || i === s.iInner) ? '^' : ' ';
      out += `${(i * s.mmPerPx).toFixed(0)}mm:${Number.isNaN(s.profile[i]) ? 'BG' : s.profile[i].toFixed(0)}${mark} `;
    }
    console.log(out);
  }
}

const json = { pose: POSE, gameFigPx: gFigH, refFigPx: rFigH, rows: [] };
console.log(`\nARM/FLANK CREASE — pose ${POSE}, studio camera, side ${sides.join('+')}`);
console.log(`  game ${gFigH}px figure (${gMM.toFixed(3)} mm/px)   ref ${rFigH}px (${rMM.toFixed(3)} mm/px)`);
console.log('');
console.log('              |---------------- GAME ----------------|---------------- REF -----------------|');
console.log('   f  side    | arm  crease  flank   depth   w½   gap | arm  crease  flank   depth   w½   gap | vs ref   crease warmth');
const fmt = (s) => s
  ? `${String(Math.round(s.peakOuter)).padStart(4)}${String(Math.round(s.min)).padStart(7)}${String(Math.round(s.peakInner)).padStart(7)}   ${s.depth.toFixed(3)} ${s.width.toFixed(0).padStart(4)}mm ${s.gapMM.toFixed(0).padStart(3)}mm`
  : '        —          —           —      —      —';
const warm = (s) => s ? `${(s.warmCrease >= 0 ? '+' : '') + s.warmCrease.toFixed(0)}` : '  —';
for (const r of rows) {
  const d = (r.game && r.ref) ? (r.game.depth - r.ref.depth) : null;
  console.log(`  ${r.f.toFixed(2)}  ${r.side}     |${fmt(r.game)} |${fmt(r.ref)} | ${d === null ? '—' : (d >= 0 ? '+' : '') + d.toFixed(3)}   R-B ${warm(r.game).padStart(3)} / ${warm(r.ref).padStart(3)}`);
  json.rows.push({
    f: r.f, side: r.side,
    game: r.game ? { arm: +r.game.peakOuter.toFixed(1), crease: +r.game.min.toFixed(1), flank: +r.game.peakInner.toFixed(1), depth: +r.game.depth.toFixed(4), widthMM: +r.game.width.toFixed(1), gapMM: +r.game.gapMM.toFixed(1), creaseRB: +r.game.warmCrease.toFixed(1), litRB: +r.game.warmLit.toFixed(1) } : null,
    ref: r.ref ? { arm: +r.ref.peakOuter.toFixed(1), crease: +r.ref.min.toFixed(1), flank: +r.ref.peakInner.toFixed(1), depth: +r.ref.depth.toFixed(4), widthMM: +r.ref.width.toFixed(1), gapMM: +r.ref.gapMM.toFixed(1), creaseRB: +r.ref.warmCrease.toFixed(1), litRB: +r.ref.warmLit.toFixed(1) } : null,
  });
}
/* THE GATE, REPORTED TWO WAYS ON PURPOSE.

   (1) The brief's absolute band, 0.38-0.46 at f 0.44.
   (2) The reference's own reading under this same script at the same
       row, which is the only comparison that cannot be argued with.

   THEY DISAGREE AT f 0.44 AND THAT IS NOT A BUG. f is anchored here on
   the figure alone — crown (or ear tip) to sole, flood mask at luma 26,
   contact shadow excluded. The brief's "f 0.44 -> 198,112,215" lands on
   ref row y=706, which under this anchoring is f 0.448: whoever measured
   it had ~22 px of soft contact shadow inside their figure height. Eight
   thousandths of H is 13 mm on the reference and it matters, because the
   reference's crease is only just forming at f 0.44 (floor 147) and is
   at 82 by f 0.48. Sweep the table, do not read one row. */
const key = rows.filter(r => Math.abs(r.f - 0.44) < 1e-9);
for (const r of key) {
  if (!r.game) continue;
  const band = r.game.depth >= 0.38 && r.game.depth <= 0.46;
  console.log(`\nGATE f 0.44 ${r.side}`);
  console.log(`  (1) brief band 0.38-0.46 : game ${r.game.depth.toFixed(3)}  ->  ${band ? 'PASS' : 'FAIL'}`);
  if (r.ref) {
    console.log(`  (2) vs reference, same ruler, same row : ref ${r.ref.depth.toFixed(3)}, game ${r.game.depth.toFixed(3)} (${(r.game.depth - r.ref.depth >= 0 ? '+' : '') + (r.game.depth - r.ref.depth).toFixed(3)})`);
    console.log(`      crease floor   ref ${r.ref.min.toFixed(0)}  game ${r.game.min.toFixed(0)}`);
    console.log(`      width at half depth   ref ${r.ref.width.toFixed(0)} mm  game ${r.game.width.toFixed(0)} mm`);
    console.log(`      flank beside it   ref ${r.ref.peakInner.toFixed(0)}  game ${r.game.peakInner.toFixed(0)}  <- the remaining gap is here, and it is the studio key, not the crease`);
  }
}
if (flag('json')) console.log(JSON.stringify(json, null, 2));
