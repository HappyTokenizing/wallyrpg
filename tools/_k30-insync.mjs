#!/usr/bin/env node
/* ============================================================
   _k30-insync.mjs — WHAT A NON-INTEGER PIXEL RATIO DOES TO
   viewport().inSync, WHICH IS THIS PROJECT'S LANDSCAPE-BUG DETECTOR.

   renderer.js: "inSync:false is the hard-edged frame the user shot."
   It is computed as

       canvas.width  === Math.round(cssW * pr)
       canvas.height === Math.round(cssH * pr)

   but three.js sizes the backing store with Math.FLOOR(css * pr). While
   `pixelRatio` was 1 on every tier those two agreed for every viewport,
   so the check could not misfire. The megapixel budget makes the ratio
   irrational — 1.2638125740085917 at 1600x900 — and floor and round now
   agree only when the product's fractional part happens to be under a
   half. At 1600x900 it is 0.43 and the check still reads true, which is
   luck rather than law.

   This sweeps viewport shapes, lets the SHIPPED governor take its own
   notch (no override — an override is not the shipping path), and
   prints what the detector says. A viewport where it reads false with
   nothing wrong is a detector that will be ignored the day it is right.
   ============================================================ */
import { boot, sleep, ENVSTATE } from './_j26-lib.mjs';

const SIZES = (process.argv[2] || '1600x900,1440x900,1366x768,1280x800,390x844')
  .split(',').map(s => s.split('x').map(Number));

console.log('# _k30-insync — headless Chrome, ANGLE Metal, M1 Max. The governor takes its own notch; no pixelRatio override.');
console.log('# want = Math.round(css * pr), what viewport() compares against. buffer = Math.floor(css * pr), what three.js allocates.');
console.log('');
console.log('  ' + 'css box'.padEnd(11) + 'dsf'.padEnd(5) + 'ceiling'.padEnd(10) + 'pixelRatio'.padEnd(22) +
  'buffer'.padEnd(12) + 'want'.padEnd(12) + 'inSync');
for (const [w, h] of SIZES) {
  const logs = [];
  const { page, close } = await boot({ w, h, dpr: 2, logs, qs: '?skipIntro&hour=12.5' });
  await sleep(6000);
  const env = await page.evaluate(ENVSTATE);
  /* the same decision the frame loop takes, just without waiting a second for it */
  await page.evaluate(() => { for (let i = 0; i < 3; i++) WALLY.debug.governorStep(+1); });
  await sleep(1200);
  const vp = await page.evaluate(() => WALLY.debug.viewport());
  console.log('  ' + `${w}x${h}`.padEnd(11) + '2'.padEnd(5) + String(vp.prCeiling).padEnd(10) +
    String(vp.pixelRatio).padEnd(22) + `${vp.buffer[0]}x${vp.buffer[1]}`.padEnd(12) +
    `${vp.want[0]}x${vp.want[1]}`.padEnd(12) + String(vp.inSync) +
    (vp.inSync ? '' : `   <- detector reads DESYNC on a frame that is fine (tier '${env.tier}')`));
  await close();
}
