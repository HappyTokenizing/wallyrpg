#!/usr/bin/env node
/* ============================================================
   blacksquares.mjs — "sometimes random black squares appear in the
   intro or in the game."

   WHAT A BLACK SQUARE ACTUALLY IS HERE. The post chain is a mip
   pyramid. bloomPreMat divides by max(br, 1e-5) with br taken from the
   linear scene buffer; if that sample is NaN or Inf the quotient is
   NaN, the 13-tap Karis downsample carries it into every mip, the tent
   upsample carries it back out, and the composite adds the result to
   an UnsignedByte target where a non-finite value lands as zero. One
   bad texel in the scene buffer therefore arrives on screen as a solid
   block roughly 2^MIPS pixels on a side. It is square because the
   pyramid is. The same shape comes out of a render target that was
   sampled before anything was drawn into it — a resize that
   reallocates a buffer between passes, a quality tier swap that
   rebuilds the chain mid-frame.

   So the symptom has two signatures and this file tests for both,
   independently, because either detector alone has a blind spot:

     1. NEAR-BLACK REGION, by bounding-box fill. Flood-fill every
        4-connected run of pixels darker than DARK, then ask whether
        the component FILLS its own bounding box. Real dark art — a
        doorway, a shadow under an eave, foliage at night — is ragged
        and fills maybe half of its box. A dead block fills ~1.0.

     2. EXACTLY-UNIFORM RECTANGLE. Every shipped frame carries grain
        (compositeMat, uGrain 0.018) and a dithered sky, so a run of
        pixels that are BIT-IDENTICAL over hundreds of pixels is not
        art. This one does not care about brightness, which is what
        makes it independent: it catches a dead buffer that clears to
        something other than black, which detector 1 would walk past.

   FALSE POSITIVES ARE THE WHOLE DIFFICULTY. Three real things in this
   game are legitimately flat black rectangles: the intro letterbox
   bars (#camLetterbox, DOM), full-screen fades, and the UI sheets.
   Rather than guess at them geometrically, the page is asked for the
   client rects of every visible opaque DOM overlay before each shot
   and those rects are subtracted. Frames that are simply black all
   over (an intro fade) are counted and reported but are not a square.
   `--control` prints every candidate with its scores and fails
   nothing, which is how the thresholds below were set.

   THE RESIZE PATH MATTERS AND MOST HARNESSES CANNOT REACH IT.
   tools/_verify-driver.mjs's /viewport rebuilds the browser context
   and reboots the game, so by construction it can never test a resize
   that lands mid-run. /resize calls page.setViewportSize on the SAME
   page, which is the burst a rotation or a fullscreen change actually
   delivers. Every resize below goes through /resize, and each one is
   sampled three times: immediately, at 120 ms, and settled.

     node tools/blacksquares.mjs                 # the gate
     node tools/blacksquares.mjs --control       # print scores, fail nothing
     node tools/blacksquares.mjs --only play,resize
     node tools/blacksquares.mjs --keep          # keep every PNG
     node tools/blacksquares.mjs --nan           # also run the non-finite
                                                 # probe on every sample
   ============================================================ */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, rmSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTDIR = join(ROOT, 'shots', '_blacksquares');
const argv = process.argv.slice(2);
const CONTROL = argv.includes('--control');
const KEEP = argv.includes('--keep');
const NANPROBE = argv.includes('--nan');
const VERBOSE = argv.includes('--verbose') || CONTROL;
const ONLY = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 && argv[i + 1] ? argv[i + 1].split(',').map((s) => s.trim()) : null;
})();

/* ==================================================================
   thresholds

   Set by running --control over every scenario below on a tree with a
   known-clean frame and taking the worst score the real art produced,
   then leaving a margin. The numbers that matter:

     the darkest ragged art region measured   fill 0.62  (foliage mass)
     the largest uniform run in a clean frame  384 px    (flat sky band
                                                          where grain
                                                          rounds to the
                                                          same byte)
   ================================================================== */
const DARK = 44;          // max(r,g,b) at or below this is "near black"
const FILL = 0.80;        // component area / bbox area for a block
const MIN_FRAC = 1 / 9000; // smallest block worth calling a square, of frame
const MIN_PX = 220;       // ...but never smaller than this many pixels
const ASPECT = 6;         // a block is not 6x longer than it is tall
const UNIFORM_MIN_PX = 1400; // exactly-identical pixels needed to be a rect
const FULL_FRAME = 0.80;  // >= this much of the frame is a fade, not a square
const COVERED = 0.70;     // bbox this much inside DOM overlay rects -> not ours

/* ------------------------------------------------------------------
   PNG -> RGBA8. No dependency; the repo vendors only three and
   playwright. Handles the colour types playwright emits (6 and 2).
   ------------------------------------------------------------------ */
function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0, bd = 8;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9]; }
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bd !== 8) throw new Error('unexpected bit depth ' + bd);
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  if (!ch) throw new Error('unexpected colour type ' + ct);
  const raw = inflateSync(Buffer.concat(idat));
  const st = w * ch;
  const out = Buffer.alloc(h * st);
  let q = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[q++];
    const row = raw.subarray(q, q + st); q += st;
    const o = y * st, po = o - st;
    for (let x = 0; x < st; x++) {
      const a = x >= ch ? out[o + x - ch] : 0;
      const b = y > 0 ? out[po + x] : 0;
      const c = (x >= ch && y > 0) ? out[po + x - ch] : 0;
      let v = row[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      out[o + x] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}

/* Fraction of `box` that lies inside the union of `rects`. Rects are
   client rects in CSS px, which is also the screenshot's coordinate
   system at deviceScaleFactor 1. Approximated by sampling the box on a
   24x24 lattice — exact union area is not worth the code here. */
function coveredBy(box, rects) {
  if (!rects || !rects.length) return 0;
  let inside = 0, n = 0;
  for (let j = 0; j < 24; j++) {
    for (let i = 0; i < 24; i++) {
      const x = box.x0 + ((box.x1 - box.x0) * (i + 0.5)) / 24;
      const y = box.y0 + ((box.y1 - box.y0) * (j + 0.5)) / 24;
      n++;
      for (const r of rects) {
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { inside++; break; }
      }
    }
  }
  return inside / n;
}

/* How rectangular is a component, beyond merely filling its box?
   `mask` is a 0/1 grid of width `w`; the fraction of bbox ROWS and of
   bbox COLUMNS that are essentially complete is returned. This is the
   discriminator fill alone gets wrong: Wally's two sunglass lenses
   measured fill 0.72 in a 150x70 box, but only a third of that box's
   rows are complete, because there is a bridge of face between them.
   A dead block completes ~every row and ~every column. */
function rectangularity(mask, w, box) {
  const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
  const need = 0.85;
  let rows = 0, cols = 0;
  for (let y = box.y0; y <= box.y1; y++) {
    let c = 0;
    for (let x = box.x0; x <= box.x1; x++) if (mask[y * w + x]) c++;
    if (c >= bw * need) rows++;
  }
  for (let x = box.x0; x <= box.x1; x++) {
    let c = 0;
    for (let y = box.y0; y <= box.y1; y++) if (mask[y * w + x]) c++;
    if (c >= bh * need) cols++;
  }
  return { rows: rows / bh, cols: cols / bw };
}
const RECT = 0.85;        // this fraction of rows AND columns must be complete

/* ==================================================================
   DETECTOR 1 — near-black regions, scored by bounding-box fill.
   ================================================================== */
function findDarkBlocks(img, rects) {
  const { w, h, ch, data } = img;
  const n = w * h;
  const dark = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += ch) {
    const m = Math.max(data[p], data[p + 1], data[p + 2]);
    if (m <= DARK) dark[i] = 1;
  }
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const minArea = Math.max(MIN_PX, Math.round(n * MIN_FRAC));
  const out = [];
  let fullFrameDark = 0;
  for (let s = 0; s < n; s++) {
    if (!dark[s] || seen[s]) continue;
    let sp = 0; stack[sp++] = s; seen[s] = 1;
    let area = 0, x0 = w, x1 = -1, y0 = h, y1 = -1;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w, y = (i / w) | 0;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && dark[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < w - 1 && dark[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[sp++] = i + 1; }
      if (y > 0 && dark[i - w] && !seen[i - w]) { seen[i - w] = 1; stack[sp++] = i - w; }
      if (y < h - 1 && dark[i + w] && !seen[i + w]) { seen[i + w] = 1; stack[sp++] = i + w; }
    }
    if (area < minArea) continue;
    if (area >= n * FULL_FRAME) { fullFrameDark += area; continue; }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const fill = area / (bw * bh);
    const asp = bw / bh;
    const box = { x0, y0, x1, y1 };
    const rc = rectangularity(dark, w, box);
    const cand = {
      kind: 'dark', area, bw, bh, x: x0, y: y0,
      fill: +fill.toFixed(3), aspect: +asp.toFixed(2),
      rows: +rc.rows.toFixed(2), cols: +rc.cols.toFixed(2),
      cover: +coveredBy(box, rects).toFixed(2),
    };
    /* A full-width strip on the top or bottom edge is a letterbox bar,
       whether it came from #camLetterbox or from the camera's own. */
    cand.letterbox = bw >= w * 0.985 && (y0 <= 1 || y1 >= h - 2) && bh <= h * 0.32;
    cand.hit = fill >= FILL && asp <= ASPECT && asp >= 1 / ASPECT
      && rc.rows >= RECT && rc.cols >= RECT
      && !cand.letterbox && cand.cover < COVERED;
    out.push(cand);
  }
  return { cands: out, fullFrameDark };
}

/* ==================================================================
   DETECTOR 2 — exactly-uniform rectangles.

   Independent of detector 1 on purpose: it never looks at brightness,
   only at whether the pixels are bit-identical. A render target that
   was never written clears to whatever the driver left in it, which is
   flat; art that went through the grain pass never is.

   Works on 8x8 blocks (a block is uniform only if all 64 pixels match
   exactly), then joins touching blocks of the SAME colour.
   ================================================================== */
function findUniformRects(img, rects) {
  const { w, h, ch, data } = img;
  const B = 8;
  const bw = Math.floor(w / B), bh = Math.floor(h / B);
  const col = new Int32Array(bw * bh).fill(-1);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const p0 = ((by * B) * w + bx * B) * ch;
      const r = data[p0], g = data[p0 + 1], b = data[p0 + 2];
      let uni = true;
      for (let y = 0; y < B && uni; y++) {
        const row = ((by * B + y) * w + bx * B) * ch;
        for (let x = 0; x < B; x++) {
          const p = row + x * ch;
          if (data[p] !== r || data[p + 1] !== g || data[p + 2] !== b) { uni = false; break; }
        }
      }
      if (uni) col[by * bw + bx] = (r << 16) | (g << 8) | b;
    }
  }
  const nb = bw * bh;
  const seen = new Uint8Array(nb);
  const stack = new Int32Array(nb);
  const member = new Uint8Array(nb);   // reused per component, for rectangularity
  const out = [];
  const minBlocks = Math.max(Math.ceil(UNIFORM_MIN_PX / (B * B)),
    Math.ceil((w * h * MIN_FRAC) / (B * B)));
  for (let s = 0; s < nb; s++) {
    if (col[s] < 0 || seen[s]) continue;
    const c = col[s];
    let sp = 0; stack[sp++] = s; seen[s] = 1;
    member.fill(0);
    let cnt = 0, x0 = bw, x1 = -1, y0 = bh, y1 = -1;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % bw, y = (i / bw) | 0;
      cnt++; member[i] = 1;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      const push = (j) => { if (j >= 0 && j < nb && col[j] === c && !seen[j]) { seen[j] = 1; stack[sp++] = j; } };
      if (x > 0) push(i - 1);
      if (x < bw - 1) push(i + 1);
      if (y > 0) push(i - bw);
      if (y < bh - 1) push(i + bw);
    }
    if (cnt < minBlocks) continue;
    const px = cnt * B * B;
    if (px >= w * h * FULL_FRAME) continue;      // a fade, not a square
    const rw = (x1 - x0 + 1) * B, rh = (y1 - y0 + 1) * B;
    const box = { x0: x0 * B, y0: y0 * B, x1: (x1 + 1) * B, y1: (y1 + 1) * B };
    const fill = px / (rw * rh);
    const asp = rw / rh;
    const rc = rectangularity(member, bw, { x0, y0, x1, y1 });
    const cand = {
      kind: 'uniform', area: px, bw: rw, bh: rh, x: box.x0, y: box.y0,
      fill: +fill.toFixed(3), aspect: +asp.toFixed(2),
      rows: +rc.rows.toFixed(2), cols: +rc.cols.toFixed(2),
      rgb: [(c >> 16) & 255, (c >> 8) & 255, c & 255],
      cover: +coveredBy(box, rects).toFixed(2),
    };
    cand.letterbox = rw >= w * 0.985 && (box.y0 <= B || box.y1 >= h - B) && rh <= h * 0.32;
    cand.hit = fill >= FILL && asp <= ASPECT && asp >= 1 / ASPECT
      && rc.rows >= RECT && rc.cols >= RECT
      && !cand.letterbox && cand.cover < COVERED;
    out.push(cand);
  }
  return out;
}

/* ------------------------------------------------------------------
   `--file a.png [b.png ...]` — run both detectors over PNGs that some
   other harness produced and print every candidate. No browser. This
   is how a frame from tools/shot.mjs, or a screenshot a player sent
   in, gets the same verdict the gate applies.
   ------------------------------------------------------------------ */
if (argv.includes('--file')) {
  const files = argv.slice(argv.indexOf('--file') + 1).filter((a) => !a.startsWith('--'));
  let bad = 0;
  for (const f of files) {
    const img = decodePng(readFileSync(resolve(f)));
    const d1 = findDarkBlocks(img, []);
    const d2 = findUniformRects(img, []);
    const cands = [...d1.cands, ...d2].sort((a, b) => b.area - a.area);
    console.log(`${f}  ${img.w}x${img.h}  ${cands.length} candidate(s)`
      + (d1.fullFrameDark ? `  [${d1.fullFrameDark}px full-frame dark]` : ''));
    for (const c of cands.slice(0, 12)) {
      console.log(`   ${c.hit ? 'HIT ' : '    '}${c.kind.padEnd(7)} ${c.bw}x${c.bh} at ${c.x},${c.y}`
        + ` area=${c.area} fill=${c.fill} rows=${c.rows} cols=${c.cols} aspect=${c.aspect}`
        + `${c.letterbox ? ' LETTERBOX' : ''}${c.rgb ? ` rgb=${c.rgb.join(',')}` : ''}`);
      if (c.hit) bad++;
    }
  }
  process.exit(bad ? 1 : 0);
}

/* ==================================================================
   driver
   ================================================================== */
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

const PORT = await freePort();
const drv = spawn(process.execPath, [join(ROOT, 'tools', '_verify-driver.mjs')], {
  cwd: ROOT,
  env: { ...process.env, VJ_PORT: String(PORT), VJ_W: '1600', VJ_H: '900', VJ_QS: '?skipIntro' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let drvOut = '';
drv.stdout.on('data', (d) => { drvOut += d; });
drv.stderr.on('data', (d) => { drvOut += d; });
const dead = new Promise((_, rej) => drv.on('exit', (c) => rej(new Error('driver exited ' + c + '\n' + drvOut))));

const base = `http://127.0.0.1:${PORT}`;
async function ctl(path, body) {
  const r = await fetch(base + path, { method: 'POST', body: body ?? '' });
  return r.json();
}
/* Same, but a driver-side exception is an error here rather than a
   silently missing PNG three lines later. */
async function must(path, body) {
  const r = await ctl(path, body);
  if (r && r.__err) throw new Error(path + ' -> ' + r.__err);
  return r;
}
/* Reboot the page on a query string and WAIT for the game, not for the
   navigation. A cold boot of the full island runs 40 s here and the
   driver's own readiness wait is best-effort. */
async function reboot(qs) {
  await must('/reload?qs=' + encodeURIComponent(qs));
  for (let i = 0; i < 90; i++) {
    const ok = await evalIn('return window.__WALLY_READY__ === true && !!window.WALLY;').catch(() => false);
    if (ok) return true;
    await wait(1000);
  }
  throw new Error('game never became ready after reboot(' + qs + ')');
}
/* A NEW browser context at a new size — a cold boot, not a resize.
   Only for "does it render correctly at this shape at all"; the
   mid-run path is /resize and lives in the resize scenarios. */
async function viewport(w, h, qs = '?skipIntro') {
  await must(`/viewport?w=${w}&h=${h}&qs=${encodeURIComponent(qs)}`);
  for (let i = 0; i < 90; i++) {
    const ok = await evalIn('return window.__WALLY_READY__ === true && !!window.WALLY;').catch(() => false);
    if (ok) return true;
    await wait(1000);
  }
  throw new Error(`game never became ready at ${w}x${h}`);
}
async function evalIn(js) {
  const r = await ctl('/eval', js);
  if (r.r && r.r.__err) throw new Error('eval: ' + r.r.__err);
  return r.r;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* wait for the driver to come up */
await Promise.race([
  (async () => {
    for (let i = 0; i < 240; i++) {
      try { const r = await fetch(base + '/ping', { method: 'POST' }); if (r.ok) return; } catch { /* not yet */ }
      await wait(500);
    }
    throw new Error('driver never answered\n' + drvOut);
  })(),
  dead,
]);

/* ------------------------------------------------------------------
   Ask the page which parts of the frame are DOM, not render output.
   Only elements with an actually opaque background count — #ui is a
   full-screen transparent host and must not blank the whole test.
   ------------------------------------------------------------------ */
const OVERLAY_JS = `
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
`;

let shotN = 0;
const findings = [];
const scores = [];
let samples = 0, fades = 0;

async function sample(label, opts = {}) {
  shotN++;
  const name = `${String(shotN).padStart(4, '0')}-${label.replace(/[^a-z0-9]+/gi, '-')}.png`;
  const path = join(SHOTDIR, name);
  const rects = await evalIn(OVERLAY_JS).catch(() => []);
  await must(`/shot?p=${encodeURIComponent('shots/_blacksquares/' + name)}`);
  const img = decodePng(readFileSync(path));
  const d1 = findDarkBlocks(img, rects);
  const d2 = findUniformRects(img, rects);
  const cands = [...d1.cands, ...d2];
  const hits = cands.filter((c) => c.hit);
  samples++;
  if (d1.fullFrameDark) fades++;
  let nan = null;
  if (NANPROBE && !opts.noNan) {
    nan = await evalIn('const p = WALLY.debug.nanProbe(); return p.any ? p : null;').catch(() => null);
  }
  /* A debug-buffer view is a raw intermediate put straight on screen:
     no grain, no tone map, and legitimately flat over most of its
     area. It is here to be LOOKED at, so it reports and never fails. */
  if (opts.diagnostic) for (const c of cands) c.hit = false;
  const worst = cands.slice().sort((a, b) => b.area - a.area)[0];
  if (VERBOSE && (worst || nan)) {
    console.log(`    ${label}  ${img.w}x${img.h}  ` + (worst
      ? `worst ${worst.kind} ${worst.bw}x${worst.bh} fill=${worst.fill}`
        + ` rows=${worst.rows} cols=${worst.cols} cover=${worst.cover}`
        + `${worst.letterbox ? ' LETTERBOX' : ''}${worst.hit ? '  <<< HIT' : ''}`
      : 'clean') + (nan ? `  NAN ${JSON.stringify(nan.scene)}` : ''));
  }
  for (const c of cands) scores.push({ label, ...c });
  if (hits.length) {
    findings.push({ label, file: path, w: img.w, h: img.h, hits, nan });
    console.log(`  HIT  ${label}  ->  ${name}`);
    for (const c of hits) {
      console.log(`       ${c.kind} ${c.bw}x${c.bh} at ${c.x},${c.y} area=${c.area} `
        + `fill=${c.fill} rows=${c.rows} cols=${c.cols} aspect=${c.aspect} cover=${c.cover}`
        + (c.rgb ? ` rgb=${c.rgb.join(',')}` : ''));
    }
  } else if (!KEEP && !opts.keep) {
    try { unlinkSync(path); } catch { /* fine */ }
  }
  return hits.length;
}

/* ==================================================================
   THE DETECTOR'S OWN SELF-TEST.

   A run that reports "no black squares" is worth nothing until the
   detector has been shown seeing one. So before anything else, an
   unlit black quad is parented to the camera and rendered THROUGH THE
   WHOLE CHAIN — tone map, lift, grain, FXAA, and the DOM film and
   vignette layers on top — and the detectors are pointed at it.

   This is not ceremony. It is what set DARK. A black region does not
   arrive on screen as 0,0,0: the grade's lift adds a constant in
   display-linear space, and a planted pure-black quad MEASURED
   0..3, 1..7, 29..37 here — max channel 37. A detector thresholding
   at "near zero" walks straight past a genuine black square in this
   game, and would report a clean sweep while the bug was on screen.
   (The intro letterbox bars measure 18,20,28 for the same reason,
   which is why they have to be excluded by shape rather than by
   being too dark to notice.)
   ================================================================== */
const PLANT_JS = (px) => `
  const c = WALLY.ctx, T = c.THREE, cam = c.camera;
  if (window.__bsPlant) { window.__bsPlant.parent.remove(window.__bsPlant); window.__bsPlant = null; }
  const d = 2.0;
  const vh = 2 * d * Math.tan(T.MathUtils.degToRad(cam.fov) * 0.5);
  const cssH = c.renderer.domElement.height / c.renderer.getPixelRatio();
  const side = vh * (${px} / cssH);
  const m = new T.Mesh(new T.PlaneGeometry(side, side),
    new T.MeshBasicMaterial({ color: 0x000000, fog: false, toneMapped: false, depthTest: false }));
  m.position.set(0, 0, -d);
  m.renderOrder = 9999;
  m.frustumCulled = false;
  cam.add(m);
  window.__bsPlantAdded = !cam.parent;
  if (!cam.parent) c.scene.add(cam);
  window.__bsPlant = m;
  return { side: +side.toFixed(4), cssH };
`;
const UNPLANT_JS = `
  const c = WALLY.ctx;
  const m = window.__bsPlant;
  if (m) { m.parent.remove(m); m.geometry.dispose(); m.material.dispose(); window.__bsPlant = null; }
  if (window.__bsPlantAdded && c.camera.parent === c.scene) c.scene.remove(c.camera);
  window.__bsPlantAdded = false;
  return 1;
`;

async function selfTest() {
  console.log('\n== self-test: can the detector see a planted black square? ==');
  const results = [];
  for (const px of [110, 32]) {
    await evalIn(PLANT_JS(px));
    await wait(400);
    const before = findings.length;
    await sample(`selftest-plant-${px}px`, { keep: true });
    const saw = findings.length > before;
    results.push({ px, saw });
    console.log(`   planted ${px}x${px} px  ->  ${saw ? 'DETECTED' : 'MISSED'}`);
    /* the planted square is not a real defect: take it back off the books */
    if (saw) findings.pop();
    await evalIn(UNPLANT_JS);
    await wait(300);
  }
  await sample('selftest-clean', { keep: true });
  return results;
}

/* ==================================================================
   scenarios
   ================================================================== */
const VIEWPORTS = [[1600, 900], [1400, 900], [1280, 720], [844, 390], [390, 844]];
const scenarios = {};

/* ---- the intro, all the way through, with the cinematic running --- */
scenarios.intro = async () => {
  await reboot('');
  await evalIn('WALLY.debug.begin(); return WALLY.debug.introState && WALLY.debug.introState();');
  for (let i = 0; i < 74; i++) {
    await wait(480);
    await sample(`intro-t${i}`);
  }
  await evalIn('WALLY.debug.skipIntro && WALLY.debug.skipIntro(); return 1;').catch(() => {});
};

/* ---- resizing DURING the intro, not only during play -------------
   The intro owns the camera, the letterbox and its own title layout,
   and it is the half of the user's report that no resize test had
   ever covered. */
scenarios.introResize = async () => {
  await reboot('');
  await evalIn('WALLY.debug.begin(); return 1;');
  const flips = [[1600, 900], [844, 390], [390, 844], [1280, 720], [1024, 1366], [1600, 900], [700, 900]];
  for (let i = 0; i < flips.length; i++) {
    await wait(1600);                     // let the cinematic advance a beat
    const [w, h] = flips[i];
    await ctl(`/resize?w=${w}&h=${h}`);
    await sample(`introResize-${w}x${h}-immediate`);
    await wait(120);
    await sample(`introResize-${w}x${h}-120ms`);
    await wait(700);
    await sample(`introResize-${w}x${h}-settled`);
  }
  await ctl('/resize?w=1600&h=900');
};

/* ---- gameplay at every viewport ---------------------------------- */
scenarios.play = async () => {
  for (const [w, h] of VIEWPORTS) {
    await viewport(w, h);
    await wait(2500);
    for (let i = 0; i < 8; i++) {
      await ctl('/keydown?k=KeyW');
      await wait(700);
      await sample(`play-${w}x${h}-${i}`);
      await ctl('/keyup?k=KeyW');
      if (i % 3 === 1) await ctl('/key?k=KeyA&ms=350');
      if (i % 3 === 2) await ctl('/key?k=Space&ms=120');
    }
  }
  await viewport(1600, 900);
  await wait(2500);
};

/* ---- true mid-run resizes, sampled three ways -------------------- */
scenarios.resize = async () => {
  const flips = [
    [1600, 900], [844, 390], [390, 844], [844, 390], [1280, 720], [720, 1280],
    [1600, 900], [1, 900], [1600, 1], [1600, 900], [2400, 900], [900, 1600],
    [1024, 768], [768, 1024], [1600, 900],
  ];
  await ctl('/keydown?k=KeyW');
  for (const [w, h] of flips) {
    await ctl(`/resize?w=${Math.max(1, w)}&h=${Math.max(1, h)}`);
    await sample(`resize-${w}x${h}-immediate`);
    await wait(120);
    await sample(`resize-${w}x${h}-120ms`);
    await wait(600);
    await sample(`resize-${w}x${h}-settled`);
  }
  await ctl('/keyup?k=KeyW');
  await ctl('/resize?w=1600&h=900');
  await wait(500);
};

/* ---- fullscreen and the landscape lock ---------------------------
   Headless Chrome refuses both requestFullscreen and
   screen.orientation.lock, so the game's own path is driven AND the
   event burst it would deliver is synthesised — the reconciler in
   renderer.js binds fullscreenchange / orientationchange, and the
   ordering of that burst against the size change is the thing that
   strands a buffer. */
scenarios.fullscreen = async () => {
  for (const [w, h] of [[844, 390], [390, 844], [1600, 900]]) {
    const real = await evalIn(`
      try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); return 'ok'; }
      catch (e) { return 'refused: ' + String(e.message).slice(0, 60); }
    `);
    await ctl(`/resize?w=${w}&h=${h}`);
    await evalIn(`
      window.dispatchEvent(new Event('orientationchange'));
      document.dispatchEvent(new Event('fullscreenchange'));
      window.dispatchEvent(new Event('resize'));
      return 1;
    `);
    await sample(`fullscreen-enter-${w}x${h}-immediate`);
    await wait(120); await sample(`fullscreen-enter-${w}x${h}-120ms`);
    await wait(600); await sample(`fullscreen-enter-${w}x${h}-settled`);
    if (VERBOSE) console.log(`    requestFullscreen -> ${real}`);
    await evalIn(`try { await document.exitFullscreen(); } catch (e) {}
      document.dispatchEvent(new Event('fullscreenchange'));
      window.dispatchEvent(new Event('resize')); return 1;`);
    await ctl('/resize?w=1600&h=900');
    await sample(`fullscreen-exit-immediate`);
    await wait(120); await sample(`fullscreen-exit-120ms`);
    await wait(600); await sample(`fullscreen-exit-settled`);
  }
  /* the landscape switch, exactly as ui/menus.js drives it */
  for (const on of [true, false, true, false]) {
    const st = await evalIn(`return WALLY.debug.landscape ? await WALLY.debug.landscape(${on}) : null;`)
      .catch((e) => ({ err: String(e.message).slice(0, 80) }));
    if (VERBOSE) console.log(`    landscape(${on}) -> ${JSON.stringify(st)}`);
    await sample(`landscape-${on}-immediate`);
    await ctl(`/resize?w=${on ? 844 : 390}&h=${on ? 390 : 844}`);
    await sample(`landscape-${on}-resized`);
    await wait(600);
    await sample(`landscape-${on}-settled`);
  }
  await ctl('/resize?w=1600&h=900');
  await wait(600);
};

/* ---- quality tier changes at runtime -----------------------------
   setQuality() reassigns q in place, calls setPixelRatio, rebuilds the
   cascades, flips ssao/bloom/dof/grain and then resizes the whole
   chain. Every render target in the pool is reallocated by that, and
   MIPS worth of bloom buffers change meaning. Resize on top of it. */
scenarios.quality = async () => {
  const tiers = await evalIn(`
    const m = await import('/src/core/contracts.js');
    return Object.keys(m.QUALITY_TIERS);
  `).catch(() => ['low', 'med', 'high', 'ultra']);
  for (const t of tiers) {
    const applied = await evalIn(`
      const m = await import('/src/core/contracts.js');
      const tier = m.QUALITY_TIERS['${t}'];
      if (!tier) return null;
      WALLY.ctx.render.setQuality({ ...tier });
      return { name: WALLY.ctx.quality.name, pr: WALLY.ctx.renderer.getPixelRatio() };
    `).catch((e) => ({ err: String(e.message).slice(0, 80) }));
    if (VERBOSE) console.log(`    setQuality(${t}) -> ${JSON.stringify(applied)}`);
    await sample(`quality-${t}-immediate`);
    await wait(120); await sample(`quality-${t}-120ms`);
    await wait(500); await sample(`quality-${t}-settled`);
    /* and a resize while the new chain is still warm */
    await ctl('/resize?w=844&h=390');
    await sample(`quality-${t}-resize-immediate`);
    await wait(400); await sample(`quality-${t}-resize-settled`);
    await ctl('/resize?w=1600&h=900');
    await wait(400); await sample(`quality-${t}-restore`);
  }
};

/* ---- heavy panels ------------------------------------------------ */
scenarios.panels = async () => {
  const panels = ['map', 'phone', 'market', 'settings', 'pause', 'desk', 'travel', 'place', 'hud'];
  for (const p of panels) {
    await evalIn(`WALLY.debug.ui('${p}'); return 1;`).catch(() => {});
    await wait(450);
    await sample(`panel-${p}-open`);
    await ctl('/resize?w=844&h=390');
    await sample(`panel-${p}-resize-immediate`);
    await wait(500);
    await sample(`panel-${p}-resize-settled`);
    await ctl('/resize?w=1600&h=900');
    await wait(400);
    await evalIn(`WALLY.debug.ui('hud'); return 1;`).catch(() => {});
    await wait(350);
    await sample(`panel-${p}-closed`);
  }
  await evalIn('WALLY.debug.uiAll && WALLY.debug.uiAll(); return 1;').catch(() => {});
  await wait(600);
  await sample('panel-uiAll');
  await ctl('/resize?w=390&h=844');
  await sample('panel-uiAll-resize');
  await wait(600);
  await sample('panel-uiAll-settled');
  await ctl('/resize?w=1600&h=900');
  await wait(500);
};

/* ---- reallocate a render target while a pass is mid-flight -------
   The one thing a resize test cannot reach from the outside: the
   composer's pool being rebuilt from inside the frame loop, between
   the main pass and the post chain. Driven from a rAF callback so it
   lands in the same task as render(), and repeated so it hits every
   phase of the chain. */
scenarios.realloc = async () => {
  const r = await evalIn(`
    const c = WALLY.ctx;
    let n = 0;
    await new Promise((done) => {
      const sizes = [[1600,900],[800,450],[1200,700],[400,900],[1600,900]];
      const tick = () => {
        const [w, h] = sizes[n % sizes.length];
        /* resize the chain from inside the frame, not from an event */
        c.render.resize(w, h);
        c.render.syncViewport(true);
        if (++n < 60) requestAnimationFrame(tick); else done();
      };
      requestAnimationFrame(tick);
    });
    return { n, vp: WALLY.debug.viewport() };
  `).catch((e) => ({ err: String(e.message).slice(0, 120) }));
  if (VERBOSE) console.log('    realloc -> ' + JSON.stringify(r));
  await sample('realloc-immediate');
  await wait(120); await sample('realloc-120ms');
  await wait(700); await sample('realloc-settled');

  /* the debug buffers: each one puts a post intermediate straight on
     screen, so an intermediate that is dead shows as itself. */
  for (const b of ['bloom', 'dof', 'ao', 'scene', null]) {
    await evalIn(`WALLY.ctx.render.setDebugBuffer(${b ? `'${b}'` : 'null'}); return 1;`).catch(() => {});
    await wait(250);
    await sample(`realloc-buffer-${b || 'off'}`, { diagnostic: !!b });
  }
  await evalIn('WALLY.ctx.render.setDebugBuffer(null); return 1;').catch(() => {});
  await wait(300);
};

/* ==================================================================
   run
   ================================================================== */
rmSync(SHOTDIR, { recursive: true, force: true });
mkdirSync(SHOTDIR, { recursive: true });

const order = ['intro', 'introResize', 'play', 'resize', 'fullscreen', 'quality', 'panels', 'realloc'];
const t0 = Date.now();
let failed = null;
let blind = null;
try {
  /* Prove the non-finite probe can see a NaN on THIS driver before any
     zero it reports is allowed to mean anything (postfx.js §7). */
  const self = await evalIn('return WALLY.debug.nanSelfTest ? WALLY.debug.nanSelfTest(1) : null;').catch(() => null);
  if (self) console.log(`probe self-test: ok=${self.ok} landed=${self.landed} raw=${self.raw} frac=${self.frac}`);

  const st = await selfTest();
  const missed = st.filter((r) => !r.saw);
  if (missed.length) blind = missed.map((r) => r.px + 'px').join(', ');

  for (const name of order) {
    if (ONLY && !ONLY.includes(name)) continue;
    console.log(`\n== ${name} ==`);
    await Promise.race([scenarios[name](), dead]);
  }
} catch (e) {
  failed = e;
}

const logs = await ctl('/logs?n=40').catch(() => ({ logs: [] }));
await ctl('/quit').catch(() => {});
drv.kill('SIGKILL');

console.log(`\n${samples} frames sampled in ${((Date.now() - t0) / 1000).toFixed(0)} s`
  + `, ${fades} carrying a full-frame fade`);

if (CONTROL) {
  const top = scores.sort((a, b) => b.fill - a.fill || b.area - a.area).slice(0, 25);
  console.log('\nworst 25 candidates by fill (nothing fails in --control):');
  for (const c of top) {
    console.log(`  fill=${c.fill.toFixed(3)} rows=${String(c.rows).padEnd(4)} cols=${String(c.cols).padEnd(4)}`
      + ` ${String(c.area).padStart(7)}px ${c.kind.padEnd(7)}`
      + ` ${c.bw}x${c.bh} cover=${c.cover}${c.letterbox ? ' LETTERBOX' : ''}  ${c.label}`);
  }
}

const pageErrs = (logs.logs || []).filter((l) => l.startsWith('[PAGEERROR]') || l.startsWith('[CRASH]'));
if (pageErrs.length) { console.log('\npage errors:'); for (const l of pageErrs) console.log('  ' + l); }

if (failed) { console.error('\nFAIL — harness error: ' + failed.message); process.exit(1); }
if (blind) {
  console.error(`\nFAIL — the detector MISSED its own planted square (${blind}). `
    + 'Every "no black squares" below this line is meaningless until that is fixed.');
  process.exit(1);
}
if (!CONTROL && findings.length) {
  console.error(`\nFAIL — ${findings.length} frame(s) contain a black square:`);
  for (const f of findings) console.error(`  ${f.label}  ${f.file}`);
  process.exit(1);
}
if (!CONTROL && pageErrs.length) { console.error('\nFAIL — page errors above'); process.exit(1); }
console.log(CONTROL ? '\ncontrol run complete' : '\nPASS — no black squares');
if (!KEEP) { try { if (!readdirSync(SHOTDIR).length) rmSync(SHOTDIR, { recursive: true, force: true }); } catch { /* fine */ } }
process.exit(0);
