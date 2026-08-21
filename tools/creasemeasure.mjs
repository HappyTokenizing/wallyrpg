#!/usr/bin/env node
/* ============================================================
   creasemeasure.mjs — the arm/flank crease FLOOR ruler.

   Reports, per height f (crown-to-sole fraction), scanning inward from
   the figure's image-left silhouette edge across the arm/flank junction:

     floor   luminance at the bottom of the crease  (spec #A9A9A8 = 169)
     depth   1 - floor / min(flanking peaks)
     armMM   mm for the ARM side (outboard of the floor) to climb back
             to 90% of its own peak
     flnkMM  mm for the FLANK side (inboard of the floor) to do the same
             — the reference recovers in 15-25 mm
     gap     mm of BACKGROUND inside the window, dropped from the profile
     R-B     mean red-minus-blue over +/-4 mm of the floor. §1.2 requires
             warm occlusion on the character, never blue: this must stay
             positive. The reference's crease runs +9 to +15.

   ------------------------------------------------------------
   ROUND 8 — THE BACKGROUND WAS BEING MEASURED AS CREASE.

   Every earlier printing of this table had a REF column that was pure
   fiction below f 0.48, and a round of tuning was spent chasing it.
   ref/wally-ref-cool.png is cut on BLACK. At f 0.50-0.68 a row that
   walks inward from the silhouette edge crosses the arm, then TRUE
   BACKGROUND in the slot between arm and flank, then the flank. The old
   scan sampled every pixel in that window, so the black slot — luma 0
   to 16 — became the "crease floor": the reference appeared to have a
   floor of 0-16 and a depth of 0.90-1.00, and this build was told to
   dig a near-black gash to match a HOLE in the image. It did, and the
   gash is the defect that sent the work back.

   THE FIX, and it is the whole point of this revision: BOTH IMAGES ARE
   MASKED AND BACKGROUND PIXELS ARE DELETED FROM THE PROFILE BEFORE ANY
   MINIMUM IS TAKEN. They are not sampled, not clamped, not averaged in
   — they are dropped, and the millimetres dropped are printed as `gap`,
   so a row that crosses a hole says so instead of lying quietly.

   The two images need two different masks and neither is a threshold:

     REFERENCE — flood fill inward from the image border through pixels
     below luma 26. A plain "dark = background" test punches a hole
     straight through the true-black sunglass lenses (§1.4, #0A0A0A);
     only connectivity to the border separates the field from the lens.

     GAME — the studio backdrop is #E6E7E9 against #D3D3D2 clay AND it
     carries a vignette: measured on a studio frame, the border alone
     runs luma 190-210, which straddles mid flank (#CFCFCE = 207). No
     threshold can cut that silhouette. The mask therefore comes from a
     second frame shot through WALLY.debug.studioBG([1,0,1]) — same
     pose, same camera, magenta field — the trick tools/armslot.mjs and
     tools/creasetest.mjs already use. studioBG repaints the backdrop
     quad and drops the contact shadow and nothing else, so the two
     frames agree on every figure pixel. The mask is eroded 2 px to
     swallow the anti-aliased rim and any sub-pixel idle drift between
     the two shots. A leaked backdrop pixel in this build is BRIGHT, so
     it would fake a peak rather than a floor — it is dropped either way.

   ALSO CORRECTED HERE: the recovery column used to walk from the floor
   toward index 0 — that is the OUTBOARD side, the arm — while calling
   itself the flank's. Both walls are now walked and both are printed,
   armMM outboard and flnkMM inboard, because the asymmetry armSeam()
   is built on (broad arm wall, sharp flank edge) is only visible when
   the two are separate numbers.

   Usage
     node tools/creasemeasure.mjs                  # shoot cool + compare
     node tools/creasemeasure.mjs --pose welcome   # gash check, no ref
     node tools/creasemeasure.mjs --no-shot        # reuse the PNGs
     node tools/creasemeasure.mjs --f 0.44,0.56
     node tools/creasemeasure.mjs --side R
     node tools/creasemeasure.mjs --dump 0.56      # raw masked profile
   ============================================================ */

import { readFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);

const POSE = arg('pose', 'cool');
const REF = arg('ref', 'ref/wally-ref-cool.png');
const SIDE = arg('side', 'L').toUpperCase();      // L = image-left (the hanging arm)
const W = +arg('w', 900), H = +arg('h', 1300);
const WAIT = +arg('wait', 8000);
const EXTRA = arg('extra', '');
const DUMP = arg('dump', null);
const F_ROWS = arg('f', '0.44,0.50,0.56,0.62,0.68').split(',').map(Number);
const SHOT = `shots/_cm-${POSE}.png`;
const MASKSHOT = `shots/_cm-${POSE}-bg.png`;
const BODY_H_MM = 1600;          // §1.1: H = 1.60 m
const WINDOW_MM = +arg('win', 210);
const EDGE_SKIP_MM = 5;
const ERODE_PX = 2;

/* ---------- PNG ---------- */
function decodePNG(buf) {
  let p = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bitDepth = d[8]; colorType = d[9]; }
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('only 8-bit PNGs: ' + bitDepth);
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!ch) throw new Error('colour type ' + colorType);
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
          const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); break;
        }
        default: throw new Error('filter ' + f);
      }
      out[o + x] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/* ---------- masks: 1 = figure, 0 = background ----------
   See the ROUND 8 header. Neither of these is a threshold over the
   whole image; both GROW THE BACKGROUND from the border inward, which
   is what keeps the black lenses and the darkest clay inside the
   figure where they belong. */
function magentaMask(img) {
  const { w, h, ch, data } = img;
  const m = new Uint8Array(w * h);
  for (let i = 0, n = w * h; i < n; i++) {
    const r = data[i * ch], g = data[i * ch + 1], b = data[i * ch + 2];
    m[i] = (r > 110 && b > 110 && g < r - 60 && g < b - 60) ? 0 : 1;
  }
  return m;
}
function darkFloodMask(img, dark = 26) {
  const { w, h, ch, data } = img;
  const isDark = new Uint8Array(w * h);
  for (let i = 0, n = w * h; i < n; i++) {
    isDark[i] = luma(data[i * ch], data[i * ch + 1], data[i * ch + 2]) < dark ? 1 : 0;
  }
  const bg = new Uint8Array(w * h);
  const st = [];
  for (let x = 0; x < w; x++) st.push(x, x + (h - 1) * w);
  for (let y = 0; y < h; y++) st.push(y * w, y * w + w - 1);
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
/* Shrink the figure by r px: the anti-aliased rim is a blend of clay and
   field and belongs to neither, and on the game side the mask comes from
   a second shot that idle motion may have moved a fraction of a pixel. */
function erode(mask, w, h, r) {
  let cur = mask;
  for (let pass = 0; pass < r; pass++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!cur[i]) continue;
        if (x > 0 && !cur[i - 1]) continue;
        if (x < w - 1 && !cur[i + 1]) continue;
        if (y > 0 && !cur[i - w]) continue;
        if (y < h - 1 && !cur[i + w]) continue;
        next[i] = 1;
      }
    }
    cur = next;
  }
  return cur;
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
   Walk inward from the silhouette edge over a PHYSICAL window so the
   two images, whose mm/px differ by 15%, compare directly. Masked
   pixels are DROPPED, never sampled — see the header. */
function scanRow(img, mask, y, side, mmPerPx) {
  const { w, ch, data } = img;
  let l = -1, r = -1;
  for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (l < 0) l = x; r = x; }
  if (l < 0 || r - l < 8) return null;
  const dir = side === 'L' ? 1 : -1;
  const x0 = side === 'L' ? l : r;

  const nWin = Math.round(WINDOW_MM / mmPerPx);
  const raw = [], rb = [], xs = [];
  let gapPx = 0;
  for (let i = 0; i < nWin; i++) {
    const x = x0 + dir * i;
    if (x < 0 || x >= w) break;
    const idx = y * w + x;
    if (!mask[idx]) { gapPx++; continue; }
    const o = idx * ch;
    raw.push(luma(data[o], data[o + 1], data[o + 2]));
    rb.push(data[o] - data[o + 2]);
    xs.push(x);
  }
  const n = raw.length;
  if (n < 20) return null;

  /* smooth over +/-2 mm: kills the clay grain, invisible to a 30 mm valley */
  const k = Math.max(1, Math.round(2.0 / mmPerPx));
  const p = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = -k; j <= k; j++) { const t = i + j; if (t >= 0 && t < n) { s += raw[t]; c++; } }
    p[i] = s / c;
  }

  const skip = Math.max(1, Math.round(EDGE_SKIP_MM / mmPerPx));
  const lo = skip, hi = n - 1 - skip;
  if (hi <= lo + 4) return null;

  let floor = Infinity, fi = -1;
  for (let i = lo; i <= hi; i++) if (p[i] < floor) { floor = p[i]; fi = i; }
  let peakOut = -Infinity, iOut = -1;
  for (let i = skip; i < fi; i++) if (p[i] > peakOut) { peakOut = p[i]; iOut = i; }
  let peakIn = -Infinity, iIn = -1;
  for (let i = fi + 1; i <= n - 1; i++) if (p[i] > peakIn) { peakIn = p[i]; iIn = i; }
  if (iOut < 0 || iIn < 0) return null;

  const base = Math.min(peakOut, peakIn);
  const depth = 1 - floor / base;

  /* recovery, BOTH walls: mm from the floor to 90% of that side's peak */
  let armMM = null;
  for (let i = fi; i >= 0; i--) if (p[i] >= peakOut * 0.9) { armMM = (fi - i) * mmPerPx; break; }
  let flankMM = null;
  for (let i = fi; i < n; i++) if (p[i] >= peakIn * 0.9) { flankMM = (i - fi) * mmPerPx; break; }

  const span = Math.max(1, Math.round(4 / mmPerPx));
  const meanRB = (c0) => {
    let t = 0, m = 0;
    for (let j = c0 - span; j <= c0 + span; j++) if (j >= 0 && j < n) { t += rb[j]; m++; }
    return m ? t / m : 0;
  };

  return {
    floor, depth, peakOut, peakIn, fi, iOut, iIn,
    armMM, flankMM, gapMM: gapPx * mmPerPx,
    warmCrease: meanRB(fi), warmLit: meanRB(iOut),
    profile: p, xs, mmPerPx, n,
  };
}

function measure(img, mask, rows, side) {
  const { w, h } = img;
  const { top, bot } = extents(mask, w, h);
  const figH = bot - top;
  const mmPerPx = BODY_H_MM / figH;
  const res = rows.map((f) => {
    const y = Math.round(top + figH * f);
    const s = scanRow(img, mask, y, side, mmPerPx);
    return s ? { f, y, ...s } : null;
  });
  return { figH, mmPerPx, top, bot, res };
}

/* ---------- shots ---------- */
function shoot(out, evalJs) {
  const r = spawnSync('node', [
    'tools/shot.mjs', out, '--w', String(W), '--h', String(H),
    '--wait', String(WAIT), '--eval', evalJs,
  ], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stdout || '', r.stderr || '');
    throw new Error('shot failed: ' + out);
  }
}
if (!flag('no-shot')) {
  shoot(SHOT, `WALLY.debug.studio('${POSE}');${EXTRA}`);
  shoot(MASKSHOT, `WALLY.debug.studioBG&&WALLY.debug.studioBG([1,0,1]);WALLY.debug.studio('${POSE}');${EXTRA}`);
}
for (const f of [SHOT, MASKSHOT]) {
  if (!existsSync(resolve(ROOT, f))) { console.error('missing', f, '(drop --no-shot)'); process.exit(1); }
}

const gImg = decodePNG(readFileSync(resolve(ROOT, SHOT)));
const gMaskImg = decodePNG(readFileSync(resolve(ROOT, MASKSHOT)));
let gMask = magentaMask(gMaskImg);
let magentaPx = 0;
for (let i = 0; i < gMask.length; i++) if (!gMask[i]) magentaPx++;
if (magentaPx < gMask.length * 0.2) {
  console.error('the mask frame is not magenta — is WALLY.debug.studioBG missing?');
  process.exit(1);
}
gMask = erode(gMask, gImg.w, gImg.h, ERODE_PX);
const game = measure(gImg, gMask, F_ROWS, SIDE);

let ref = null;
if (POSE === 'cool' && existsSync(resolve(ROOT, REF))) {
  const rImg = decodePNG(readFileSync(resolve(ROOT, REF)));
  const rMask = erode(darkFloodMask(rImg), rImg.w, rImg.h, ERODE_PX);
  ref = measure(rImg, rMask, F_ROWS, SIDE);
}

/* ---------- report ---------- */
const F = (v, n = 3) => String(Math.round(v)).padStart(n);
const M = (v) => (v == null ? '   -' : String(Math.round(v)).padStart(4));
console.log(`\n  pose ${POSE}  side ${SIDE}  window ${WINDOW_MM} mm  ` +
  `game figure ${game.figH}px (${game.mmPerPx.toFixed(2)} mm/px)` +
  (ref ? `   ref ${ref.figH}px (${ref.mmPerPx.toFixed(2)} mm/px)` : ''));
console.log('  background MASKED OUT of both profiles (magenta frame / dark flood).' +
  '   spec deep crease #A9A9A8 = luma 169\n');
console.log('    f  | GAME floor  depth  armMM flnkMM  gap    R-B' +
  (ref ? '  | REF floor  depth  armMM flnkMM  gap    R-B' : ''));
const cell = (s) => (s
  ? `${F(s.floor)}    ${s.depth.toFixed(3)}  ${M(s.armMM)}  ${M(s.flankMM)}  ${F(s.gapMM)}  ${(s.warmCrease >= 0 ? '+' : '') + s.warmCrease.toFixed(1)}`
  : '  --      --      --     --    --     --  ');
for (let i = 0; i < F_ROWS.length; i++) {
  const g = game.res[i], r = ref && ref.res[i];
  console.log(`   ${F_ROWS[i].toFixed(2)} |  ${cell(g)}` + (ref ? `  |  ${cell(r)}` : ''));
}
const gm = game.res.filter(Boolean);
if (gm.length) {
  console.log(`\n  game floor range ${Math.round(Math.min(...gm.map(x => x.floor)))}-${Math.round(Math.max(...gm.map(x => x.floor)))}` +
    `   (target 140-170; below ~120 is the gash, above ~185 is the glued ramp)`);
  console.log(`  crease warmth R-B min ${Math.min(...gm.map(x => x.warmCrease)).toFixed(1)}` +
    `   (§1.2: must stay positive; ref +9..+15)`);
  console.log(`  arm-side lit peaks ${gm.map(x => Math.round(x.peakOut)).join(' ')}` +
    (ref ? `    ref ${ref.res.filter(Boolean).map(x => Math.round(x.peakOut)).join(' ')}` : ''));
}

if (DUMP != null) {
  const i = F_ROWS.indexOf(+DUMP);
  const s = i >= 0 && game.res[i];
  if (s) {
    console.log(`\n  raw masked profile, GAME f ${DUMP} (row y=${s.y}, x:luma):`);
    console.log('  ' + s.xs.map((x, k) => `${x}:${Math.round(s.profile[k])}`).join(' '));
    if (ref && ref.res[i]) {
      const t = ref.res[i];
      console.log(`\n  raw masked profile, REF f ${DUMP} (row y=${t.y}, x:luma):`);
      console.log('  ' + t.xs.map((x, k) => `${x}:${Math.round(t.profile[k])}`).join(' '));
    }
  }
}
