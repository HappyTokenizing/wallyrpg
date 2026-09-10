#!/usr/bin/env node
/* ============================================================
   silhouette.mjs — the LIKENESS RULER.

   Reproduces the judge's proportion measurement so it is repeatable
   rather than re-argued. It renders Wally on a black field via
   WALLY.debug.studio(pose) + WALLY.debug.studioBG([0,0,0]), cuts the
   frame to a binary silhouette mask, cuts ref/wally-ref-cool.png the
   same way (it already ships on a black field), height-matches the two
   and compares them row by row.

   WHY A FLOOD FILL AND NOT A THRESHOLD. The sunglasses are #0A0A0A and
   the lens panels are true black — on a black backdrop a plain luma
   threshold punches a hole through the middle of the face and the mask
   stops being a silhouette. Background is therefore whatever a flood
   fill reaches from the image border through dark pixels; everything
   else is figure, including every dark thing enclosed by lit clay.

   TWO IoU NUMBERS, BECAUSE THEY ANSWER DIFFERENT QUESTIONS.
     bboxIoU    — each mask stretched to fill a common square. Pure
                  shape agreement with aspect ratio divided out. This is
                  the 0.506 the judge quoted.
     heightIoU  — both scaled to a common figure height (top of the
                  silhouette to sole = 1000 px), aspect preserved,
                  aligned on the sole line and on the LEG AXIS (the
                  centroid of the bottom 12% of the figure, which is the
                  one landmark a pose cannot swing around). This is the
                  honest one: it punishes a figure that is the right
                  shape at the wrong build.

   Usage
     node tools/silhouette.mjs                       # pose cool
     node tools/silhouette.mjs --pose welcome
     node tools/silhouette.mjs --save shots/mask     # dump both masks
     node tools/silhouette.mjs --json                # machine readable
   ============================================================ */

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.glsl': 'text/plain',
  '.wasm': 'application/wasm',
};

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);

const POSE  = arg('pose', 'cool');
const CAM   = arg('cam', null);
const REF   = arg('ref', 'ref/wally-ref-cool.png');
const W     = +arg('w', 900), H = +arg('h', 1300);
const WAIT  = +arg('wait', 6000);
const THR   = +arg('thr', 24);
const TURN  = +arg('turn', 0);        // extra camera orbit, degrees
const SAVE  = arg('save', null);
const JSONO = flag('json');

/* ---------- static server (+ a blank same-origin page for canvas work) ---------- */
const server = createServer(async (req, res) => {
  const clean = decodeURIComponent(req.url.split('?')[0]);
  if (clean === '/__blank') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>ruler</title>');
    return;
  }
  try {
    const path = join(ROOT, clean === '/' ? 'index.html' : clean);
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
         '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
});

/* ---------- 1. render the game on a black field ---------- */
const game = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
game.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
await game.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil: 'load', timeout: 60000 });
await game.waitForFunction('window.__WALLY_READY__ === true', null, { timeout: 45000 })
  .catch(() => logs.push('never ready'));
await game.evaluate(([p, c, t]) => {
  window.WALLY.debug.studio(p, c || undefined);
  window.WALLY.debug.studioBG([0, 0, 0]);
  if (t) window.WALLY.debug.turntable(t);
}, [POSE, CAM, TURN]).catch(e => logs.push('EVAL ' + e.message));
await game.waitForTimeout(WAIT);
await game.evaluate(() => new Promise(r => { let n = 0; const t = () => (++n > 6 ? r() : requestAnimationFrame(t)); requestAnimationFrame(t); }));
const shotBuf = await game.screenshot({ animations: 'allow', timeout: 20000 });
const tris = await game.evaluate(() => window.WALLY?.ctx?.renderer?.info?.render?.triangles ?? -1).catch(() => -1);
await game.close();

/* ---------- 2. measure, in a canvas, same origin ---------- */
const lab = await browser.newPage({ viewport: { width: 400, height: 300 } });
await lab.goto(`http://127.0.0.1:${PORT}/__blank`);

const result = await lab.evaluate(async ([gameURL, refURL, thr]) => {
  /* ---- decode to a binary mask (1 = figure) ---- */
  async function maskOf(src) {
    const img = new Image(); img.src = src; await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const w = c.width, h = c.height, n = w * h;
    /* dark[] — candidate background by luma */
    const dark = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const l = 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];
      dark[i] = l <= thr ? 1 : 0;
    }
    /* flood the border through dark pixels -> true background */
    const bg = new Uint8Array(n);
    const st = new Int32Array(n); let sp = 0;
    const push = (i) => { if (!bg[i] && dark[i]) { bg[i] = 1; st[sp++] = i; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (sp) {
      const i = st[--sp], x = i % w, y = (i / w) | 0;
      if (x > 0) push(i - 1); if (x < w - 1) push(i + 1);
      if (y > 0) push(i - w); if (y < h - 1) push(i + w);
    }
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = bg[i] ? 0 : 1;
    /* keep the largest connected component: kills specks and any UI crumb */
    const lbl = new Int32Array(n).fill(-1);
    let best = -1, bestN = 0;
    for (let s = 0; s < n; s++) {
      if (!m[s] || lbl[s] >= 0) continue;
      let cnt = 0; sp = 0; st[sp++] = s; lbl[s] = s;
      while (sp) {
        const i = st[--sp]; cnt++;
        const x = i % w, y = (i / w) | 0;
        const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
        for (const j of nb) if (j >= 0 && m[j] && lbl[j] < 0) { lbl[j] = s; st[sp++] = j; }
      }
      if (cnt > bestN) { bestN = cnt; best = s; }
    }
    for (let i = 0; i < n; i++) if (m[i] && lbl[i] !== best) m[i] = 0;
    return { m, w, h, area: bestN };
  }

  /* ---- bbox + per-row extents ---- */
  function analyse(M) {
    const { m, w, h } = M;
    let x0 = w, x1 = -1, y0 = h, y1 = -1;
    const lo = new Int32Array(h).fill(-1), hi = new Int32Array(h).fill(-1), fill = new Int32Array(h);
    for (let y = 0; y < h; y++) {
      let a = -1, b = -1, f = 0;
      for (let x = 0; x < w; x++) if (m[y * w + x]) { if (a < 0) a = x; b = x; f++; }
      lo[y] = a; hi[y] = b; fill[y] = f;
      if (a >= 0) { if (y < y0) y0 = y; if (y > y1) y1 = y; if (a < x0) x0 = a; if (b > x1) x1 = b; }
    }
    return { ...M, x0, x1, y0, y1, lo, hi, fill, bw: x1 - x0 + 1, bh: y1 - y0 + 1 };
  }

  /* ---- normalised row-width profile, N samples top -> bottom ----
     Total width alone is too blunt: it cannot tell "his left arm is thin"
     from "his right arm is thin", and on this reference the whole left
     bulge between f 0.35 and 0.47 is the UP-CURLED TRUNK, not a shoulder.
     So every row is also reported as two half-widths measured from the
     leg axis: L = axis - leftEdge, R = rightEdge - axis. */
  function profile(A, N, axis) {
    const w = [], L = [], R = [];
    for (let k = 0; k < N; k++) {
      const f = (k + 0.5) / N;
      const y = Math.min(A.y1, Math.max(A.y0, Math.round(A.y0 + f * (A.bh - 1))));
      if (A.lo[y] < 0) { w.push(0); L.push(0); R.push(0); continue; }
      w.push((A.hi[y] - A.lo[y] + 1) / A.bh);
      L.push((axis - A.lo[y]) / A.bh);
      R.push((A.hi[y] - axis) / A.bh);
    }
    return { w, L, R };
  }

  /* ---- leg axis: centroid x of the bottom 12% of the figure ---- */
  function legAxis(A) {
    const yA = A.y1 - Math.round(A.bh * 0.12), yB = A.y1;
    let s = 0, c = 0;
    for (let y = yA; y <= yB; y++) for (let x = A.x0; x <= A.x1; x++) if (A.m[y * A.w + x]) { s += x; c++; }
    return c ? s / c : (A.x0 + A.x1) / 2;
  }

  /* ---- resample a mask into a target grid ---- */
  function sampleAt(A, x, y) {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= A.w || yi >= A.h) return 0;
    return A.m[yi * A.w + xi];
  }

  /* IoU with each bbox stretched to a common square (aspect divided out) */
  function bboxIoU(A, B, S) {
    let inter = 0, uni = 0;
    for (let j = 0; j < S; j++) {
      const fy = (j + 0.5) / S;
      const ay = A.y0 + fy * A.bh, by = B.y0 + fy * B.bh;
      for (let i = 0; i < S; i++) {
        const fx = (i + 0.5) / S;
        const a = sampleAt(A, A.x0 + fx * A.bw, ay);
        const b = sampleAt(B, B.x0 + fx * B.bw, by);
        if (a | b) { uni++; if (a & b) inter++; }
      }
    }
    return uni ? inter / uni : 0;
  }

  /* IoU with both scaled to figure height = SH, aspect kept, aligned on
     the sole line and the leg axis */
  function heightIoU(A, B, SH, dx) {
    const sa = SH / A.bh, sb = SH / B.bh;
    const ax = legAxis(A) + (dx || 0) / sa, bx = legAxis(B);
    const PAD = Math.round(SH * 0.75);           // canvas half-width, generous
    let inter = 0, uni = 0;
    for (let j = 0; j < SH; j++) {
      const ya = A.y1 - (SH - 1 - j) / sa, yb = B.y1 - (SH - 1 - j) / sb;
      for (let i = -PAD; i <= PAD; i++) {
        const a = sampleAt(A, ax + i / sa, ya);
        const b = sampleAt(B, bx + i / sb, yb);
        if (a | b) { uni++; if (a & b) inter++; }
      }
    }
    return uni ? inter / uni : 0;
  }
  /* THE SAME IoU WITH THE SIDEWAYS ALIGNMENT FREE. The leg-axis alignment
     is the honest one, but it cannot tell "wrong shape" from "same shape,
     standing 5% of a body-height to one side of where the reference
     stands". Sweeping the offset and keeping the best separates them:
     if bestIoU is far above heightIoU, the residual is placement — a
     lean in the pose or a camera that sees the figure off its own leg
     axis — and re-sculpting to chase it would be sculpting a shadow. */
  function bestShift(A, B, SH) {
    let best = -1, at = 0;
    for (let d = -120; d <= 120; d += 6) {
      const v = heightIoU(A, B, SH, d);
      if (v > best) { best = v; at = d; }
    }
    return { iou: best, dx: at / SH };
  }

  const gm = analyse(await maskOf(gameURL));
  const rm = analyse(await maskOf(refURL));
  const N = 50;
  const gp = profile(gm, N, legAxis(gm)), rp = profile(rm, N, legAxis(rm));

  /* widest row overall, and widest row in the top 30% (the ear span) */
  const stat = (p) => {
    let mi = 0; for (let i = 0; i < p.length; i++) if (p[i] > p[mi]) mi = i;
    const top = Math.floor(p.length * 0.30);
    let ei = 0; for (let i = 0; i < top; i++) if (p[i] > p[ei]) ei = i;
    return { max: p[mi], maxAtF: (mi + 0.5) / p.length, ear: p[ei], earAtF: (ei + 0.5) / p.length, earRatio: p[ei] / p[mi] };
  };

  /* CROTCH — and it has to be the LEG fork, not the first hole in the
     figure. Scanning down for "the first row with two runs" finds the
     daylight between arm and flank long before it finds the legs, and
     that gap sits 0.15 H higher, so the number it returns is not the one
     anybody means. Instead: take the enclosed BACKGROUND region that the
     shins stand either side of near the sole line, flood it, and report
     its topmost pixel. That is the fork by construction. */
  const crotch = (A, axis) => {
    const { m, w, h } = A;
    /* seed: interior background nearest the leg axis, low down */
    const yS = A.y1 - Math.round(A.bh * 0.06);
    let seed = -1, bestD = 1e9;
    for (let x = A.x0; x <= A.x1; x++) {
      if (m[yS * w + x]) continue;
      let L = false, R = false;
      for (let i = A.x0; i < x; i++) if (m[yS * w + i]) { L = true; break; }
      for (let i = x + 1; i <= A.x1; i++) if (m[yS * w + i]) { R = true; break; }
      if (!L || !R) continue;
      const d = Math.abs(x - axis);
      if (d < bestD) { bestD = d; seed = yS * w + x; }
    }
    if (seed < 0) return null;
    const seen = new Uint8Array(w * h);
    const st = new Int32Array(w * h); let sp = 0;
    seen[seed] = 1; st[sp++] = seed;
    let top = A.y1;
    while (sp) {
      const i = st[--sp], x = i % w, y = (i / w) | 0;
      if (y < top) top = y;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) {
        if (j < 0 || seen[j] || m[j]) continue;
        const jy = (j / w) | 0, jx = j % w;
        /* stay inside the figure's own bbox and inside the row's span,
           so the fill cannot leak out past a foot into open sky */
        if (jy < A.y0 || jy > A.y1 || A.lo[jy] < 0 || jx <= A.lo[jy] || jx >= A.hi[jy]) continue;
        seen[j] = 1; st[sp++] = j;
      }
    }
    return (top - A.y0) / A.bh;
  };

  /* LEAN — how far the head/ear block's own centre of area sits to one
     side of the leg axis, in figure heights, measured on EACH image
     independently. Unlike every delta above this is not a comparison, so
     it survives a change of pose: it answers "is he standing over his
     own feet" for whichever frame you hand it. */
  const lean = (A, axis) => {
    const yA = A.y0 + Math.round(A.bh * 0.05), yB = A.y0 + Math.round(A.bh * 0.30);
    let s = 0, c = 0;
    for (let y = yA; y <= yB; y++) for (let x = A.x0; x <= A.x1; x++) if (A.m[y * A.w + x]) { s += x; c++; }
    return c ? (s / c - axis) / A.bh : 0;
  };

  /* fraction of total figure area sitting in the top 40% of the height */
  const topMass = (A) => {
    const cut = A.y0 + Math.round(A.bh * 0.40);
    let t = 0, all = 0;
    for (let y = A.y0; y <= A.y1; y++) { all += A.fill[y]; if (y < cut) t += A.fill[y]; }
    return t / all;
  };

  /* paint a mask out so it can be looked at — a ruler nobody has eyeballed
     is a number nobody should trust */
  function dump(A, B) {
    /* A in white, B (height-matched, leg-axis aligned) in red, overlap grey */
    const SH = 900, PAD = Math.round(SH * 0.55);
    const c = document.createElement('canvas');
    c.width = PAD * 2 + 1; c.height = SH;
    const g = c.getContext('2d');
    const im = g.createImageData(c.width, c.height);
    const sa = SH / A.bh, sb = SH / B.bh;
    const ax = legAxis(A), bx = legAxis(B);
    for (let j = 0; j < SH; j++) {
      const ya = A.y1 - (SH - 1 - j) / sa, yb = B.y1 - (SH - 1 - j) / sb;
      for (let i = -PAD; i <= PAD; i++) {
        const a = sampleAt(A, ax + i / sa, ya), b = sampleAt(B, bx + i / sb, yb);
        const o = (j * c.width + (i + PAD)) * 4;
        im.data[o] = a || b ? 230 : 12;
        im.data[o + 1] = a && b ? 210 : (a ? 120 : 30);
        im.data[o + 2] = a && b ? 200 : (a ? 110 : 30);
        im.data[o + 3] = 255;
      }
    }
    g.putImageData(im, 0, 0);
    return c.toDataURL('image/png');
  }

  return {
    game: { w: gm.w, h: gm.h, bw: gm.bw, bh: gm.bh, aspect: gm.bw / gm.bh, prof: gp.w, L: gp.L, R: gp.R, ...stat(gp.w), crotch: crotch(gm, legAxis(gm)), lean: lean(gm, legAxis(gm)), topMass: topMass(gm) },
    ref:  { w: rm.w, h: rm.h, bw: rm.bw, bh: rm.bh, aspect: rm.bw / rm.bh, prof: rp.w, L: rp.L, R: rp.R, ...stat(rp.w), crotch: crotch(rm, legAxis(rm)), lean: lean(rm, legAxis(rm)), topMass: topMass(rm) },
    bboxIoU:   bboxIoU(gm, rm, 512),
    heightIoU: heightIoU(gm, rm, 1000, 0),
    best:      bestShift(gm, rm, 1000),
    overlay:   dump(gm, rm),
  };
}, [`data:image/png;base64,${shotBuf.toString('base64')}`, `http://127.0.0.1:${PORT}/${REF}`, THR]);

/* optional mask dump for eyeballing */
if (SAVE) {
  await mkdir(dirname(resolve(ROOT, SAVE + '-game.png')), { recursive: true }).catch(() => {});
  await writeFile(resolve(ROOT, SAVE + '-game.png'), shotBuf);
  await writeFile(resolve(ROOT, SAVE + '-overlay.png'),
    Buffer.from(result.overlay.split(',')[1], 'base64'));
}
delete result.overlay;
await browser.close(); server.close();

/* ---------- report ---------- */
if (JSONO) { console.log(JSON.stringify(result)); process.exit(0); }

const g = result.game, r = result.ref;
const f3 = (x) => (x == null ? ' n/a ' : x.toFixed(3));
console.log(`\n=== SILHOUETTE RULER — pose '${POSE}'${CAM ? ' cam ' + CAM : ''}${TURN ? ' turn ' + TURN : ''} vs ${REF} ===`);
console.log(`  bbox-normalised IoU : ${f3(result.bboxIoU)}`);
console.log(`  height-matched IoU  : ${f3(result.heightIoU)}   (leg-axis aligned)`);
console.log(`  best-shift IoU      : ${f3(result.best.iou)}   at ${(result.best.dx >= 0 ? '+' : '') + result.best.dx.toFixed(3)} H sideways`);
console.log(`  aspect  (w/h)       : game ${f3(g.aspect)}   ref ${f3(r.aspect)}`);
console.log(`  widest row          : game ${f3(g.max)} H at f ${f3(g.maxAtF)}   ref ${f3(r.max)} H at f ${f3(r.maxAtF)}`);
console.log(`  ear span row        : game ${f3(g.ear)} H at f ${f3(g.earAtF)}   ref ${f3(r.ear)} H at f ${f3(r.earAtF)}`);
console.log(`  ear / widest        : game ${f3(g.earRatio)}   ref ${f3(r.earRatio)}    <- 1.000 means ears ARE the widest row`);
console.log(`  crotch (f from top) : game ${f3(g.crotch)}   ref ${f3(r.crotch)}`);
console.log(`  head over feet      : game ${f3(g.lean)}   ref ${f3(r.lean)}   <- head-block centre minus leg axis, +H = viewer right`);
console.log(`  mass in top 40%     : game ${f3(g.topMass)}   ref ${f3(r.topMass)}`);
{ /* how far the upper body sits off the ref's, sideways — this is the
     number that separates a camera-azimuth mismatch from a real
     proportion error, so it is printed before the profile table. */
  let sh = 0, wd = 0, n = 0;
  for (let i = 0; i < g.prof.length; i++) {
    const f = (i + 0.5) / g.prof.length;
    if (f < 0.05 || f > 0.47) continue;
    sh += ((g.R[i] - r.R[i]) - (g.L[i] - r.L[i])) / 2;
    wd += (g.prof[i] - r.prof[i]); n++;
  }
  console.log(`  upper-body shift    : ${(sh / n >= 0 ? '+' : '') + (sh / n).toFixed(3)} H toward viewer-right (f 0.05-0.47)`);
  console.log(`  upper-body width    : ${(wd / n >= 0 ? '+' : '') + (wd / n).toFixed(3)} H vs ref`);
}
console.log(`  triangles           : ${tris}`);
console.log(`\n  row profile — widths in FIGURE HEIGHTS, f = fraction from the top.`);
console.log(`  L / R are half-widths from the leg axis (his RIGHT = viewer left = L).`);
console.log(`    f    | game  W    L    R  | ref   W    L    R  |  dW     dL     dR`);
const sg = (v) => (v >= 0 ? '+' : '') + v.toFixed(3);
for (let i = 0; i < g.prof.length; i++) {
  const f = (i + 0.5) / g.prof.length;
  console.log(`   ${f.toFixed(2)} | ${g.prof[i].toFixed(3)} ${g.L[i].toFixed(3)} ${g.R[i].toFixed(3)}` +
              ` | ${r.prof[i].toFixed(3)} ${r.L[i].toFixed(3)} ${r.R[i].toFixed(3)}` +
              ` | ${sg(g.prof[i] - r.prof[i])} ${sg(g.L[i] - r.L[i])} ${sg(g.R[i] - r.R[i])}`);
}
if (logs.length) console.log('\nlogs: ' + logs.join(' | '));
