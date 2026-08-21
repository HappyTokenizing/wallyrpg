#!/usr/bin/env node
/* ============================================================
   armslot.mjs — THE ARM-SLOT RULER.

   Reads a magenta-backdrop studio PNG (see below) and reports, for
   every scanline across the arm band, the INTERIOR background runs
   between the figure's left and right extents — i.e. the daylight
   ART_DIRECTION §1.1 demands between arm and flank.

   Produce the PNG with exactly:
     node tools/shot.mjs shots/x.png --wait 6000 \
       --eval "WALLY.debug.studioBG&&WALLY.debug.studioBG([1,0,1]);WALLY.debug.studio('cool')" \
       --w 900 --h 1300

   Usage: node tools/armslot.mjs shots/x.png [--f0 0.33] [--f1 0.60] [--step 0.03]

   A correct result is TWO interior runs per scanline, one per arm.
   Grey-on-grey eyeballing is useless here; three rounds were wrong
   because of it.
   ============================================================ */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/* --- minimal PNG decode via the browserless route: use playwright? no.
   Decode with zlib + a hand-rolled unfilter; PNGs from Chrome are
   8-bit RGBA, non-interlaced. --- */
import { inflateSync } from 'node:zlib';

function decodePNG(buf) {
  let p = 8; // skip signature
  let w = 0, h = 0, bitDepth = 0, colorType = 0;
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
  if (bitDepth !== 8) throw new Error('bit depth ' + bitDepth + ' unsupported');
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!ch || colorType === 3) throw new Error('color type ' + colorType + ' unsupported');
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

/* magenta backdrop test: strong R and B, weak G. Wally's clay is
   ~#D3D3D2 (neutral) and his lenses are near-black, so nothing on the
   figure comes close. Anti-aliased edge pixels are ambiguous by
   construction, so the test is deliberately loose on the BG side and a
   run has to be >= 2 px to count at all. */
function isBG(r, g, b) { return r > 110 && b > 110 && g < r - 60 && g < b - 60; }

const file = process.argv[2] || 'shots/_slot.png';
function arg(n, d) { const i = process.argv.indexOf('--' + n); return i > -1 ? +process.argv[i + 1] : d; }
const F0 = arg('f0', 0.33), F1 = arg('f1', 0.60), STEP = arg('step', 0.03);
const MINRUN = arg('minrun', 2);

const img = decodePNG(await readFile(resolve(ROOT, file)));
const { w, h, ch, data } = img;
const px = (x, y) => { const o = (y * w + x) * ch; return [data[o], data[o + 1], data[o + 2]]; };

/* figure bbox: any non-background pixel */
let top = -1, bot = -1;
for (let y = 0; y < h; y++) {
  let any = false;
  for (let x = 0; x < w; x++) { const [r, g, b] = px(x, y); if (!isBG(r, g, b)) { any = true; break; } }
  if (any) { if (top < 0) top = y; bot = y; }
}
if (top < 0) { console.log('NO FIGURE FOUND — is the backdrop magenta?'); process.exit(1); }

const figH = bot - top + 1;
const mmPerPx = 1600 / figH;   // §1.1: H = 1.60 m
console.log(`figure ${figH}px  (top=${top} bot=${bot})   ${mmPerPx.toFixed(3)} mm/px   image ${w}x${h}`);

const rows = [];
for (let f = F0; f <= F1 + 1e-9; f += STEP) {
  const y = Math.round(top + f * (figH - 1));
  if (y < 0 || y >= h) continue;
  /* figure extents on this row */
  let l = -1, r = -1;
  for (let x = 0; x < w; x++) { const [R, G, B] = px(x, y); if (!isBG(R, G, B)) { if (l < 0) l = x; r = x; } }
  if (l < 0) { rows.push({ f, y, runs: [], l, r }); continue; }
  /* interior background runs */
  const runs = [];
  let s = -1;
  for (let x = l; x <= r; x++) {
    const [R, G, B] = px(x, y);
    const bg = isBG(R, G, B);
    if (bg && s < 0) s = x;
    if (!bg && s >= 0) { if (x - s >= MINRUN) runs.push([s, x - 1]); s = -1; }
  }
  rows.push({ f, y, runs, l, r });
}

const cx = (() => {   // figure centre column, for left/right labelling
  let lo = 1e9, hi = -1e9;
  for (const rw of rows) if (rw.l >= 0) { lo = Math.min(lo, rw.l); hi = Math.max(hi, rw.r); }
  return (lo + hi) / 2;
})();

let ok = 0;
for (const rw of rows) {
  const mm = rw.runs.map(([a, b]) => (b - a + 1) * mmPerPx);
  const side = rw.runs.map(([a, b]) => ((a + b) / 2 < cx ? 'L' : 'R'));
  const label = rw.runs.length
    ? '[' + rw.runs.map((_, i) => `${side[i]}:${mm[i].toFixed(0)}`).join(' ') + ']'
    : '[]';
  const two = rw.runs.length === 2 && mm.every(v => v >= 35) && side[0] !== side[1];
  if (two) ok++;
  console.log(`f=${rw.f.toFixed(2)}  y=${rw.y}  span=${rw.l}..${rw.r}  ${label}${two ? '  OK' : ''}`);
}
console.log(`\n${ok}/${rows.length} scanlines with TWO interior gaps >= 35 mm, one per side.`);
