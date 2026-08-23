#!/usr/bin/env node
/* VERIFY JUDGE #16 — build the paste corpus myself.
   Captures a clean 1600x900 gameplay frame AND its own DOM overlay
   rects off the same page in the same second (same selector list
   blacksquares.mjs uses), then cuts the med-tier 204x216 block
   BIT-EXACT out of a guard-false nanInject frame and pastes it at 23
   positions, choosing the top-clip x positions from the REAL chip
   geometry rather than from remembered coordinates.
   node tools/_vj16/corpus.mjs <naninject-med.png> <outdir>            */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = resolve(process.argv[2]);
const OUT = resolve(process.argv[3]);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

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
function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, cr]);
}
function encodePng(w, h, ch, d) {
  const st = w * ch; const raw = Buffer.alloc(h * (st + 1));
  for (let y = 0; y < h; y++) { raw[y * (st + 1)] = 0; d.copy(raw, y * (st + 1) + 1, y * st, y * st + st); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ch === 4 ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c)); rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b); }
  catch { rs.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro&quality=med`, { waitUntil: 'load', timeout: 240000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 240000 });
await page.waitForTimeout(9000);
await mkdir(OUT, { recursive: true });

const OVERLAY_JS = `(() => {
  const out = [];
  const roots = ['#ui', '#overlay', '#boot', '#camLetterbox', '.w-film', '.w-notify', '.w-endroot', '.w-warp'];
  const seen = new Set();
  for (const sel of roots) {
    for (const host of document.querySelectorAll(sel)) {
      const all = [host, ...host.querySelectorAll('*')];
      for (const el of all) {
        if (seen.has(el)) continue; seen.add(el);
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const op = parseFloat(cs.opacity);
        if (!(op > 0.55)) continue;
        const bg = cs.backgroundColor || '';
        const m = bg.match(/rgba?\\(([^)]+)\\)/);
        const alpha = m ? (m[1].split(',')[3] === undefined ? 1 : parseFloat(m[1].split(',')[3])) : 0;
        const hasBg = (alpha > 0.55) || (cs.backgroundImage && cs.backgroundImage !== 'none');
        if (!hasBg) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        out.push({ x: r.left, y: r.top, w: r.width, h: r.height });
      }
    }
  }
  return out;
})()`;

/* clean frame and its rects, off the same page in the same second */
const rects = await page.evaluate(OVERLAY_JS);
const cleanPath = join(OUT, 'clean.png');
await page.screenshot({ path: cleanPath });
await writeFile(join(OUT, 'overlays.json'), JSON.stringify(rects, null, 1));
console.log(`clean frame + ${rects.length} overlay rects captured`);
/* which chips sit on the top edge, and where the gap between them is */
const top = rects.filter((r) => r.y < 60 && r.h > 8 && r.w > 20).sort((a, b) => a.x - b.x);
console.log('top-edge chips:');
for (const r of top) console.log(`   x ${Math.round(r.x)}..${Math.round(r.x + r.w)}  y ${Math.round(r.y)}..${Math.round(r.y + r.h)}  (${Math.round(r.w)}x${Math.round(r.h)})`);
await browser.close(); server.close();

/* ---- cut the block bit-exact ---- */
const src = decodePng(readFileSync(SRC));
const BX = 698, BY = 342, BW = 204, BH = 216;
const block = Buffer.alloc(BW * BH * src.ch);
for (let y = 0; y < BH; y++) {
  src.d.copy(block, y * BW * src.ch, ((BY + y) * src.w + BX) * src.ch, ((BY + y) * src.w + BX + BW) * src.ch);
}
console.log(`cut ${BW}x${BH} block bit-exact from ${SRC} at ${BX},${BY}`);

const clean = decodePng(readFileSync(cleanPath));
function paste(px, py, name) {
  const d = Buffer.from(clean.d);
  for (let y = 0; y < BH; y++) {
    const ty = py + y; if (ty < 0 || ty >= clean.h) continue;
    for (let x = 0; x < BW; x++) {
      const tx = px + x; if (tx < 0 || tx >= clean.w) continue;
      const so = (y * BW + x) * src.ch, to = (ty * clean.w + tx) * clean.ch;
      d[to] = block[so]; d[to + 1] = block[so + 1]; d[to + 2] = block[so + 2];
      if (clean.ch === 4) d[to + 3] = 255;
    }
  }
  writeFileSync(join(OUT, name + '.png'), encodePng(clean.w, clean.h, clean.ch, d));
}

/* pick the top-clip x positions from the REAL geometry: the widest gap
   between top chips, and the left edge of each chip so the block fuses */
const gaps = [];
for (let i = 0; i + 1 < top.length; i++) {
  const a = top[i], b = top[i + 1];
  const g = b.x - (a.x + a.w);
  if (g > 40) gaps.push({ x0: a.x + a.w, x1: b.x, w: g });
}
gaps.sort((a, b) => b.w - a.w);
const GAPX = gaps.length ? Math.round(gaps[0].x0 + gaps[0].w / 2 - BW / 2) : 780;
/* the money chip: the right-hand group's leftmost chip */
const money = top.filter((r) => r.x > 800)[0] || top[top.length - 1];
const MONEYX = Math.round(money.x - BW / 2);
const toast = top.filter((r) => r.x < 400).sort((a, b) => b.w - a.w)[0] || top[0];
const TOASTX = Math.round(toast.x + 20);
console.log(`gap centre x=${GAPX}, money chip at x=${Math.round(money.x)} -> paste x=${MONEYX}, left chip at x=${Math.round(toast.x)} -> paste x=${TOASTX}`);

const POS = [
  ['whole-grass', 600, 500],
  ['whole-mid', 300, 400],
  ['whole-right', 1200, 550],
  ['whole-low', 700, 640],
  ['left-half', -102, 400],
  ['left-74', -130, 400],
  ['left-60', -144, 400],
  ['right-half', 1600 - 102, 400],
  ['bottom-70', 600, 900 - 70],
  ['bottom-40', 600, 900 - 40],
  [`top70-gap${GAPX}`, GAPX, -146],
  [`top40-gap${GAPX}`, GAPX, -176],
  [`top28-gap${GAPX}`, GAPX, -188],
  [`top70-money${MONEYX}`, MONEYX, -146],
  [`top40-money${MONEYX}`, MONEYX, -176],
  [`top28-money${MONEYX}`, MONEYX, -188],
  [`top70-toast${TOASTX}`, TOASTX, -146],
  [`top40-toast${TOASTX}`, TOASTX, -176],
  [`top28-toast${TOASTX}`, TOASTX, -188],
  ['top-whole-gap', GAPX, 60],
  ['top70-farleft', 40, -146],
  ['corner-tl', -80, -80],
  ['corner-br', 1600 - 120, 900 - 120],
];
for (const [n, x, y] of POS) paste(x, y, n);
console.log(`\npasted ${POS.length} positions into ${OUT}`);
console.log(POS.map((p) => p[0]).join('\n'));
