#!/usr/bin/env node
/* ============================================================
   _mp-pixels.mjs — WHAT THE PIXELS COST AND WHAT THEY BUY.

   Two numbers per row, and they are different KINDS of number:

     COST     GPU time per frame, EXT_disjoint_timer_query_webgl2,
              limiter off so the clock cannot drop out from under the
              reading. Median over ~5 s.
     SHARPNESS mean |Laplacian| of the luma of the COMPOSITED page, in
              a fixed 300x300 CSS crop, captured at a FIXED output
              resolution for every row. That is the point: at
              deviceScaleFactor 3 the browser hands the compositor a
              1170x2532 surface no matter what, so a 390x844 drawing
              buffer arrives there upscaled 3x and a 1170x2532 one does
              not. The metric is measured on the image a player's eye
              actually receives, not on the render target.

   THE A/B IS ON ONE PAGE LOAD. `WALLY.debug.pixelRatio(v)` pins the
   ratio through the shipped syncViewport path — the same call the
   governor makes — so the world, the camera, the hour, the streamed
   foliage and every compiled program are identical across the three
   rows and the ONLY thing that changed is the size of the buffer.
   Rebooting per row would have re-rolled all of that.

   THE LOAD GATE. This box runs other toolchains; a previous agent
   measured the same viewport 3-4x apart because of it, and one page
   load with two other headless Chromes moved p50 from 7.6 ms to 16.3
   and back. Every row waits for a 1-minute load average under
   --maxload, re-reads it after the sample, and prints both. A row
   whose load moved materially is a row to throw away, and it is
   printed as a row so that it can be.

       node tools/_mp-pixels.mjs [--maxload 5] [--secs 5] [--place mainstreet]
   ============================================================ */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { INJECT, stats } from './_sm-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const MAXLOAD = +arg('maxload', 5), SECS = +arg('secs', 5), PLACE = arg('place', 'mainstreet');
const load = () => { try { return +execSync('uptime').toString().split('load averages:')[1].trim().split(/\s+/)[0]; } catch { return NaN; } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function gate() {
  for (let i = 0; i < 60 && load() > MAXLOAD; i++) { if (i === 0) process.stderr.write(`  (waiting for load <= ${MAXLOAD}, now ${load()})\n`); await sleep(10000); }
  return load();
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  try {
    const c = decodeURIComponent(rq.url.split('?')[0]);
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream', 'cache-control': 'no-store' });
    rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const tmp = await mkdtemp(join(tmpdir(), 'mppx-'));

/* mean |Laplacian| of luma — high-frequency energy, i.e. how much
   detail survived to the composited surface. One python call per
   image; PIL and numpy only. */
const LAP = `
import sys, numpy as np
from PIL import Image
a = np.asarray(Image.open(sys.argv[1]).convert('L'), dtype=np.float32)
L = (4*a[1:-1,1:-1] - a[:-2,1:-1] - a[2:,1:-1] - a[1:-1,:-2] - a[1:-1,2:])
print(round(float(np.abs(L).mean()), 4), a.shape[1], a.shape[0])
`;
await writeFile(join(tmp, 'lap.py'), LAP);
const sharpness = (png) => {
  const out = execSync(`python3 ${join(tmp, 'lap.py')} ${png}`).toString().trim().split(/\s+/);
  return { lap: +out[0], w: +out[1], h: +out[2] };
};

const PIXEL7_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';

/* deviceScaleFactor is FIXED at 3 for every row of a viewport, so the
   composited surface is a constant size and the sharpness numbers in a
   block are comparable. Only the drawing buffer moves. */
const VIEWPORTS = [
  { label: 'phone   390x844',   w: 390,  h: 844, phone: true,  clip: { x: 45, y: 250, width: 300, height: 300 } },
  { label: 'desktop 1600x900',  w: 1600, h: 900, phone: false, clip: { x: 650, y: 300, width: 300, height: 300 } },
];
const DSF = 3;

console.log('# _mp-pixels — GPU cost and composited sharpness vs the drawing buffer.');
console.log('# rig: headless Chrome (channel chrome), ANGLE Metal Renderer on an Apple M1 Max,');
console.log('#      10 cores, macOS 14.4, --disable-frame-rate-limit --disable-gpu-vsync,');
console.log(`#      deviceScaleFactor ${DSF} on every row so the composited surface is a fixed size,`);
console.log(`#      ?skipIntro&hour=12.5, arrive('${PLACE}'), ONE page load per viewport.`);
console.log(`# sharpness = mean |Laplacian| of luma over a 300x300 CSS crop (${300 * DSF}x${300 * DSF} px).`);
console.log(`# load gate ${MAXLOAD}; the 1-min average BEFORE and AFTER each sample is printed.\n`);

for (const V of VIEWPORTS) {
  const l00 = await gate();
  const browser = await chromium.launch({ channel: 'chrome', args: [
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio',
    '--disable-frame-rate-limit', '--disable-gpu-vsync'] });
  const c = await browser.newContext({
    viewport: { width: V.w, height: V.h }, deviceScaleFactor: DSF,
    hasTouch: V.phone, isMobile: V.phone, ...(V.phone ? { userAgent: PIXEL7_UA } : {}),
  });
  const page = await c.newPage();
  const logs = [];
  page.on('pageerror', e => logs.push(e.message.split('\n')[0]));
  await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro&hour=12.5`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 180000 }).catch(() => logs.push('never ready'));
  await sleep(5000);
  await page.evaluate((p) => { try { WALLY.debug.arrive(p, true); } catch (e) {} }, PLACE);
  await sleep(6000);
  /* The governor must not move the thing being measured. */
  await page.evaluate(() => WALLY.debug.governor(false));
  await page.evaluate(INJECT);

  const head = await page.evaluate(() => ({
    tier: WALLY.ctx.quality.name, cls: WALLY.ctx.quality.name,
    dpr: devicePixelRatio, gpu: window.__SMP__.gpuName,
    ceiling: WALLY.debug.viewport().prCeiling, max: WALLY.ctx.quality.pixelRatioMax,
    budget: WALLY.ctx.quality.pixelBudget,
  }));
  console.log(`${V.label}   tier ${head.tier}   devicePixelRatio ${head.dpr}   `
    + `tier ceiling here ${head.ceiling} (max ${head.max}, budget ${head.budget} Mpx)`);
  console.log(`  ${'pr'.padEnd(5)}${'buffer'.padEnd(12)}${'Mpx'.padEnd(7)}${'gpuP50'.padStart(7)}${'gpuP95'.padStart(8)}`
    + `${'frmP50'.padStart(8)}${'cpuP50'.padStart(8)}${'calls'.padStart(7)}   ${'sharp'.padStart(7)}  ${'vs pr1'.padStart(7)}  load`);

  let base = null;
  for (const pr of [1, 2, 3]) {
    const l0 = await gate();
    const set = await page.evaluate((v) => { WALLY.debug.pixelRatio(v); return WALLY.debug.viewport(); }, pr);
    await sleep(2500);                                   // shader recompiles + target realloc
    await page.evaluate(() => window.__SMP__.start('pr', 'frame'));
    await sleep(SECS * 1000);
    const rec = await page.evaluate(() => { window.__SMP__.stop(); return window.__SMP__.read(); });
    const l1 = load();
    const png = join(tmp, `${V.phone ? 'p' : 'd'}-${pr}.png`);
    await page.screenshot({ path: png, clip: V.clip });
    /* the whole frame too — a number is not a look, and ART_DIRECTION
       §6 is judged by eye. shots/ so it survives the temp dir. */
    await page.screenshot({ path: join(ROOT, 'shots', `mp-${V.phone ? 'phone' : 'desktop'}-pr${pr}.png`) });
    const sh = sharpness(png);
    if (pr === 1) base = sh.lap;
    const gpu = stats(rec.rec.map(r => r.gpu).filter(x => x != null));
    const frm = stats(rec.rec.map(r => r.wall));
    const cpu = stats(rec.rec.map(r => r.cpu));
    const calls = rec.rec.length ? rec.rec[rec.rec.length - 1].calls : 0;
    console.log(`  ${String(set.pixelRatio).padEnd(5)}${set.buffer.join('x').padEnd(12)}${String(set.mpx).padEnd(7)}`
      + `${String(gpu ? gpu.p50 : '-').padStart(7)}${String(gpu ? gpu.p95 : '-').padStart(8)}`
      + `${String(frm ? frm.p50 : '-').padStart(8)}${String(cpu ? cpu.p50 : '-').padStart(8)}${String(calls).padStart(7)}`
      + `   ${String(sh.lap).padStart(7)}  ${String(base ? '+' + Math.round((sh.lap / base - 1) * 100) + '%' : '-').padStart(7)}`
      + `  ${l0}->${l1}${Math.abs(l1 - l0) > 1.5 ? '  << LOAD MOVED, DISCARD' : ''}`);
  }
  console.log(`  crop written to ${tmp}/${V.phone ? 'p' : 'd'}-{1,2,3}.png   page errors: ${logs.length}`);
  if (logs.length) for (const e of [...new Set(logs)].slice(0, 3)) console.log('    - ' + e.slice(0, 120));
  console.log('');
  await browser.close();
}
server.close();
