#!/usr/bin/env node
/* VERIFY JUDGE #16 — measure a block out of a PNG with my own code.
   Two readings, deliberately separate, because the ultra row is about
   exactly this distinction:
     SOLID  largest axis-aligned rectangle that is under DARK all the
            way through (histogram + stack, the standard sweep)
     DARK   the 4-connected near-black component it sits in, and that
            component's bounding box / fill / row+col completeness
   node tools/_vj16/measure.mjs <png> [<png>...]                       */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const DARK = 44;

function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0, bd = 8; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString('ascii', p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9]; }
    else if (type === 'IDAT') idat.push(d); else if (type === 'IEND') break;
    p += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  const raw = inflateSync(Buffer.concat(idat)); const st = w * ch;
  const out = Buffer.alloc(h * st); let q = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[q++]; const ro = y * st, po = ro - st;
    for (let i = 0; i < st; i++) {
      const a = i >= ch ? out[ro + i - ch] : 0, b = y > 0 ? out[po + i] : 0;
      const cc = (y > 0 && i >= ch) ? out[po + i - ch] : 0; const x = raw[q++];
      let v;
      if (f === 0) v = x; else if (f === 1) v = x + a; else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else { const pp = a + b - cc, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - cc); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : cc); }
      out[ro + i] = v & 255;
    }
  }
  return { w, h, ch, d: out };
}

for (const path of process.argv.slice(2)) {
  const { w, h, ch, d } = decodePng(readFileSync(path));
  const dark = new Uint8Array(w * h);
  for (let i = 0, o = 0; i < w * h; i++, o += ch) {
    dark[i] = Math.max(d[o], d[o + 1], d[o + 2]) <= DARK ? 1 : 0;
  }
  /* ---- largest all-dark rectangle: histogram + stack ---- */
  const hgt = new Int32Array(w);
  let bestA = 0, bestR = null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) hgt[x] = dark[y * w + x] ? hgt[x] + 1 : 0;
    const st = [];
    for (let x = 0; x <= w; x++) {
      const cur = x === w ? -1 : hgt[x];
      while (st.length && hgt[st[st.length - 1]] >= cur) {
        const t = st.pop();
        const left = st.length ? st[st.length - 1] + 1 : 0;
        const ww = x - left, hh = hgt[t];
        if (ww * hh > bestA) { bestA = ww * hh; bestR = { x: left, y: y - hh + 1, w: ww, h: hh }; }
      }
      st.push(x);
    }
  }
  /* ---- the 4-connected dark component containing that rect's centre ---- */
  let comp = null;
  if (bestR) {
    const seed = (bestR.y + (bestR.h >> 1)) * w + bestR.x + (bestR.w >> 1);
    const seen = new Uint8Array(w * h); const stack = [seed]; seen[seed] = 1;
    let n = 0, minx = w, maxx = -1, miny = h, maxy = -1;
    const rows = new Int32Array(h), cols = new Int32Array(w);
    while (stack.length) {
      const p = stack.pop(); const x = p % w, y = (p - x) / w;
      n++; rows[y]++; cols[x]++;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (x > 0 && !seen[p - 1] && dark[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < w - 1 && !seen[p + 1] && dark[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && !seen[p - w] && dark[p - w]) { seen[p - w] = 1; stack.push(p - w); }
      if (y < h - 1 && !seen[p + w] && dark[p + w]) { seen[p + w] = 1; stack.push(p + w); }
    }
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    let fullRows = 0, fullCols = 0;
    for (let y = miny; y <= maxy; y++) if (rows[y] >= bw * 0.98) fullRows++;
    for (let x = minx; x <= maxx; x++) if (cols[x] >= bh * 0.98) fullCols++;
    comp = { x: minx, y: miny, w: bw, h: bh, area: n,
      fill: +(n / (bw * bh)).toFixed(4),
      rows: +(fullRows / bh).toFixed(3), cols: +(fullCols / bw).toFixed(3) };
  }
  console.log(`\n${path}   (${w}x${h})`);
  console.log(`  SOLID rectangle : ${bestR ? `${bestR.w}x${bestR.h} at ${bestR.x},${bestR.y}  area ${bestA}` : 'none'}`);
  console.log(`  DARK component  : ${comp ? `${comp.w}x${comp.h} at ${comp.x},${comp.y}  area ${comp.area}  fill ${comp.fill}  rows ${comp.rows}  cols ${comp.cols}` : 'none'}`);
}
