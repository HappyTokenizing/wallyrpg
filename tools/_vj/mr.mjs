#!/usr/bin/env node
/* ============================================================
   markruler.mjs — hold the flat WALLY MARK to the 3D character.

   Rasterises wallyMarkup() from src/ui/style.js on a BLACK field at
   900 px, cuts a silhouette the way tools/silhouette.mjs does
   (border-connected flood fill through dark pixels — NEVER a luma
   threshold, which punches straight through the #0A0A0A lenses),
   cuts a front-on render of the in-game character the same way, then
   crops BOTH to the HEAD BLOCK (top of the silhouette down to the
   first row below the widest row narrower than 0.42 x the widest)
   and reports IoU.

   Also reports the two canon facts a silhouette can actually settle:
     topRuns   — how many separate runs the top 4% of the block has.
                 2 = the ear tips are ABOVE the crown (canon).
                 1 = the crown is the top of the head, ears sit flat
                     sideways below it (the likeness error §1.1 calls
                     the single worst one).
     crownDrop — how far below the block top the two runs merge, in
                 block heights. That IS "how far the ears rise above
                 the crown".
     topWidth  — width of the top 6% of the block over the ear
                 span. Asymmetry-sensitive; read it, do not chase it.

   usage: node tools/markruler.mjs shots/av/front-head.png shots/av mytag
     the render: node tools/shot.mjs shots/av/front-head.png --w 900 --h 1000 \\
       --eval "(()=>{WALLY.debug.studio('cool','ears');WALLY.debug.studioBG([0,0,0]);return 1})()"
   ============================================================ */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

import { dirname, resolve as _res } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const RENDER = process.argv[2] || join(ROOT, 'shots/av/front-head.png');
const OUT = process.argv[3] || join(ROOT, 'shots/av');
const TAG = process.argv[4] || 'x';

const { wallyMarkup } = await import(process.env.VJ_STYLE ?? join(ROOT, 'src/ui/style.js'));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const clean = decodeURIComponent(req.url.split('?')[0]);
  if (clean === '/__blank') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><meta charset="utf-8"><title>ruler</title>'); return; }
  try {
    const path = join(ROOT, clean); if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404).end('nf'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const browser = await chromium.launch({ channel: 'chrome', args: ['--force-color-profile=srgb', '--hide-scrollbars'] });

/* ---- 1. rasterise the mark on black, with a generous black margin so
        the border flood fill has somewhere to start ---- */
const S = 900, M = 90;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -8 80 80" width="${S}" height="${S}">${wallyMarkup('r')}</svg>`;
const markPage = await browser.newPage({ viewport: { width: S + M * 2, height: S + M * 2 }, deviceScaleFactor: 1 });
await markPage.goto(`http://127.0.0.1:${PORT}/__blank`);
await markPage.setContent(`<body style="margin:0;background:#000"><div style="padding:${M}px;background:#000">${svg}</div></body>`);
await markPage.waitForTimeout(250);
await mkdir(OUT, { recursive: true }).catch(() => {});
const markPath = join(OUT, `${TAG}-mark-raster.png`);
await markPage.screenshot({ path: markPath });
const markBuf = await readFile(markPath);
await markPage.close();

/* ---- 2. measure, in a canvas, same origin ---- */
const lab = await browser.newPage({ viewport: { width: 400, height: 300 } });
await lab.goto(`http://127.0.0.1:${PORT}/__blank`);
const renderBuf = await readFile(resolve(RENDER));

const out = await lab.evaluate(async ([markURL, renURL, thr]) => {
  /* --- silhouette.mjs's maskOf, verbatim in behaviour --- */
  async function maskOf(src) {
    const img = new Image(); img.src = src; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const w = c.width, h = c.height, n = w * h;
    const dark = new Uint8Array(n);
    for (let i = 0; i < n; i++) { const o = i * 4; const l = 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]; dark[i] = l <= thr ? 1 : 0; }
    const bg = new Uint8Array(n); const st = new Int32Array(n); let sp = 0;
    const push = (i) => { if (!bg[i] && dark[i]) { bg[i] = 1; st[sp++] = i; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (sp) { const i = st[--sp], x = i % w, y = (i / w) | 0;
      if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (y > 0) push(i - w); if (y < h - 1) push(i + w); }
    const m = new Uint8Array(n); for (let i = 0; i < n; i++) m[i] = bg[i] ? 0 : 1;
    const lbl = new Int32Array(n).fill(-1); let best = -1, bestN = 0;
    for (let s = 0; s < n; s++) { if (!m[s] || lbl[s] >= 0) continue;
      let cnt = 0; sp = 0; st[sp++] = s; lbl[s] = s;
      while (sp) { const i = st[--sp]; cnt++; const x = i % w, y = (i / w) | 0;
        const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
        for (const j of nb) if (j >= 0 && m[j] && lbl[j] < 0) { lbl[j] = s; st[sp++] = j; } }
      if (cnt > bestN) { bestN = cnt; best = s; } }
    for (let i = 0; i < n; i++) if (m[i] && lbl[i] !== best) m[i] = 0;
    return { m, w, h };
  }

  function rows(M) {
    const { m, w, h } = M;
    const lo = new Int32Array(h).fill(-1), hi = new Int32Array(h).fill(-1), fill = new Int32Array(h), runs = new Int32Array(h);
    let x0 = w, x1 = -1, y0 = h, y1 = -1;
    for (let y = 0; y < h; y++) {
      let a = -1, b = -1, f = 0, r = 0, prev = 0;
      for (let x = 0; x < w; x++) { const v = m[y * w + x]; if (v) { if (a < 0) a = x; b = x; f++; if (!prev) r++; } prev = v; }
      lo[y] = a; hi[y] = b; fill[y] = f; runs[y] = r;
      if (a >= 0) { if (y < y0) y0 = y; if (y > y1) y1 = y; if (a < x0) x0 = a; if (b > x1) x1 = b; }
    }
    return { ...M, lo, hi, fill, runs, x0, x1, y0, y1, bw: x1 - x0 + 1, bh: y1 - y0 + 1 };
  }

  /* HEAD BLOCK: top of the silhouette down to the first row below the
     widest row that is narrower than 0.42 x the widest. In the mark that
     is where only the trunk is left; in the render it is the same place,
     above the shoulders. */
  function headBlock(A) {
    let wid = 0, wy = A.y0;
    for (let y = A.y0; y <= A.y1; y++) { const wd = A.lo[y] < 0 ? 0 : A.hi[y] - A.lo[y] + 1; if (wd > wid) { wid = wd; wy = y; } }
    let yB = A.y1;
    for (let y = wy; y <= A.y1; y++) { const wd = A.lo[y] < 0 ? 0 : A.hi[y] - A.lo[y] + 1; if (wd < wid * 0.42) { yB = y; break; } }
    /* head-ball width: the widest row INSIDE the single-run band (below
       the ear tips the ears merge with the skull, so this is measured on
       the narrowest run-count-1 row band just under the merge) */
    let x0 = A.w, x1 = -1;
    for (let y = A.y0; y <= yB; y++) { if (A.lo[y] < 0) continue; if (A.lo[y] < x0) x0 = A.lo[y]; if (A.hi[y] > x1) x1 = A.hi[y]; }
    return { yA: A.y0, yB, span: wid, spanAtY: wy, x0, x1, bh: yB - A.y0 + 1 };
  }

  /* CROWN DROP — the one canon fact a front silhouette can settle on its
     own. Walk down the CENTRE COLUMN of the block. While the centre is
     background, the only things in the silhouette are the two ear tips,
     so the ears are ABOVE the crown. The first filled centre row is the
     crown. crownDrop = how far that sits below the top of the block, in
     block heights. 0.000 means the crown IS the top and the ears hang
     below it sideways — §1.1's "single worst likeness error".
     Measured on the centre column and not on a run count because a run
     count is one stray antialiased pixel away from lying. */
  function topStats(A, B, cx) {
    const x = Math.round(cx);
    let crown = B.yA;
    for (let y = B.yA; y <= B.yB; y++) { if (A.m[y * A.w + x]) { crown = y; break; } crown = y; }
    /* width of the top 6% of the block, over the ear span: small = two
       pointed ear tips, large = a dome */
    const band = Math.max(2, Math.round(B.bh * 0.06));
    let wtop = 0;
    for (let y = B.yA; y < B.yA + band; y++) { const wd = A.lo[y] < 0 ? 0 : A.hi[y] - A.lo[y] + 1; if (wd > wtop) wtop = wd; }
    return { crownDrop: (crown - B.yA) / B.bh, topWidth: wtop / B.span };
  }

  function centroidX(A, B) { let s = 0, c = 0; for (let y = B.yA; y <= B.yB; y++) for (let x = A.x0; x <= A.x1; x++) if (A.m[y * A.w + x]) { s += x; c++; } return c ? s / c : (B.x0 + B.x1) / 2; }
  const at = (A, x, y) => { const xi = Math.round(x), yi = Math.round(y); if (xi < 0 || yi < 0 || xi >= A.w || yi >= A.h) return 0; return A.m[yi * A.w + xi]; };

  /* aspect-preserving IoU: both blocks scaled to block height = SH,
     aligned on the block top and the block's own x centroid */
  function blockIoU(A, Ba, Bm, Bb, SH) {
    const sa = SH / Ba.bh, sb = SH / Bb.bh;
    const ax = centroidX(A.A, Ba), bx = centroidX(Bm.A, Bb);
    const PAD = Math.round(SH * 1.2);
    let inter = 0, uni = 0;
    for (let j = 0; j < SH; j++) {
      const ya = Ba.yA + j / sa, yb = Bb.yA + j / sb;
      for (let i = -PAD; i <= PAD; i++) {
        const a = at(A.A, ax + i / sa, ya), b = at(Bm.A, bx + i / sb, yb);
        if (a | b) { uni++; if (a & b) inter++; }
      }
    }
    return uni ? inter / uni : 0;
  }
  /* aspect divided out: each block stretched to a common square */
  function bboxIoU(A, Ba, Bm, Bb, S) {
    let inter = 0, uni = 0;
    const aw = Ba.x1 - Ba.x0 + 1, bw = Bb.x1 - Bb.x0 + 1;
    for (let j = 0; j < S; j++) { const fy = (j + 0.5) / S;
      for (let i = 0; i < S; i++) { const fx = (i + 0.5) / S;
        const a = at(A.A, Ba.x0 + fx * aw, Ba.yA + fy * Ba.bh);
        const b = at(Bm.A, Bb.x0 + fx * bw, Bb.yA + fy * Bb.bh);
        if (a | b) { uni++; if (a & b) inter++; } } }
    return uni ? inter / uni : 0;
  }

  function dump(A, Ba, Bm, Bb) {
    const SH = 700, PAD = Math.round(SH * 0.9);
    const c = document.createElement('canvas'); c.width = PAD * 2 + 1; c.height = SH;
    const g = c.getContext('2d'); const im = g.createImageData(c.width, c.height);
    const sa = SH / Ba.bh, sb = SH / Bb.bh;
    const ax = centroidX(A.A, Ba), bx = centroidX(Bm.A, Bb);
    for (let j = 0; j < SH; j++) { const ya = Ba.yA + j / sa, yb = Bb.yA + j / sb;
      for (let i = -PAD; i <= PAD; i++) {
        const a = at(A.A, ax + i / sa, ya), b = at(Bm.A, bx + i / sb, yb);
        const o = (j * c.width + (i + PAD)) * 4;
        im.data[o] = a || b ? 235 : 10; im.data[o + 1] = a && b ? 215 : (a ? 110 : 34); im.data[o + 2] = a && b ? 205 : (a ? 100 : 34); im.data[o + 3] = 255; } }
    g.putImageData(im, 0, 0); return c.toDataURL('image/png');
  }

  /* paint one mask on its own so the mask itself can be eyeballed —
     a ruler nobody has looked at is a number nobody should trust */
  function paint(A, B) {
    const c = document.createElement('canvas'); c.width = A.w; c.height = A.h;
    const g = c.getContext('2d'); const im = g.createImageData(A.w, A.h);
    for (let i = 0; i < A.w * A.h; i++) { const o = i * 4; const v = A.m[i] ? 235 : 14;
      im.data[o] = v; im.data[o + 1] = v; im.data[o + 2] = v; im.data[o + 3] = 255; }
    /* block window in red */
    for (const y of [B.yA, B.yB]) for (let x = 0; x < A.w; x++) { const o = (y * A.w + x) * 4; im.data[o] = 230; im.data[o + 1] = 40; im.data[o + 2] = 40; }
    g.putImageData(im, 0, 0); return c.toDataURL('image/png');
  }

  const mk = rows(await maskOf(markURL));
  const rn = rows(await maskOf(renURL));
  const bmk = headBlock(mk), brn = headBlock(rn);
  const A = { A: mk }, Bm = { A: rn };
  const tmk = topStats(mk, bmk, centroidX(mk, bmk)), trn = topStats(rn, brn, centroidX(rn, brn));
  return {
    mark: { span: bmk.span, blockH: bmk.bh, aspect: (bmk.x1 - bmk.x0 + 1) / bmk.bh, ...tmk },
    ren:  { span: brn.span, blockH: brn.bh, aspect: (brn.x1 - brn.x0 + 1) / brn.bh, ...trn },
    blockIoU: blockIoU(A, bmk, Bm, brn, 1000),
    bboxIoU:  bboxIoU(A, bmk, Bm, brn, 512),
    overlay:  dump(A, bmk, Bm, brn),
    maskMark: paint(mk, bmk),
    maskRen:  paint(rn, brn),
  };
}, [`data:image/png;base64,${markBuf.toString('base64')}`, `data:image/png;base64,${renderBuf.toString('base64')}`, 24]);

await writeFile(join(OUT, `${TAG}-overlay.png`), Buffer.from(out.overlay.split(',')[1], 'base64'));
await writeFile(join(OUT, `${TAG}-maskmark.png`), Buffer.from(out.maskMark.split(',')[1], 'base64'));
await writeFile(join(OUT, `${TAG}-maskren.png`), Buffer.from(out.maskRen.split(',')[1], 'base64'));
delete out.overlay; delete out.maskMark; delete out.maskRen;
await browser.close(); server.close();

const f = (x) => (typeof x === 'number' ? x.toFixed(3) : String(x));
console.log(`\n=== MARK RULER  [${TAG}]  mark vs ${RENDER.split('/').pop()} ===`);
console.log(`  head-block IoU (aspect kept) : ${f(out.blockIoU)}`);
console.log(`  head-block IoU (bbox-square) : ${f(out.bboxIoU)}`);
console.log(`  block aspect  w/h            : mark ${f(out.mark.aspect)}   render ${f(out.ren.aspect)}`);
console.log(`  crown drop below ear tips     : mark ${f(out.mark.crownDrop)}   render ${f(out.ren.crownDrop)}   (0 = ears do NOT rise above the crown)`);
console.log(`  top-band width / ear span     : mark ${f(out.mark.topWidth)}   render ${f(out.ren.topWidth)}`);
console.log(JSON.stringify(out));
