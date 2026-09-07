#!/usr/bin/env node
/* ============================================================
   _fa-mobile.mjs — THE MOBILE PICTURE, FOR THE TIER A PHONE ACTUALLY
   GETS, AT THE RESOLUTION A PHONE ACTUALLY HAS.

   Two gaps this closes, both of them holes in every mobile number this
   project has:

   1. THE TIER. Every 390x844 measurement so far ran tier 'high',
      because pickQuality() reads the GPU string and nothing else, and
      on this rig that string is an M1 Max. tools/_fa-tier.mjs drives
      the real function down each branch: a phone reporting 'Apple GPU'
      or an Adreno gets 'med', and an iPad reporting 'Apple M2' gets
      'high'. So 'high' at 390x844 describes a tablet and a narrow
      desktop window, and NOTHING that has ever been profiled describes
      a handset. ?quality= forces the branch.

   2. THE PIXELS. Every tier sets pixelRatio 1 and renderer.js clamps
      to it, so a dpr-3 handset renders 390x844 and lets the compositor
      upscale. --force-dpr lifts that clamp through the shipped resize
      path to find out what the pixels would cost.

   THE LOAD GATE. This box runs another agent's toolchain; _fa-contend
   moved the same scene from p50 7.6 to 16.3 with no code change. Every
   row here WAITS for a load average under `--maxload` and re-reads the
   load after the sample, and prints both, so a row that drifted is
   visible as a row rather than hiding in an average.
   ============================================================ */
import { boot, INJECT, stats } from './_sm-lib.mjs';
import { execSync } from 'node:child_process';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const MAXLOAD = +arg('maxload', 9), SECS = +arg('secs', 4), PLACE = arg('place', 'markethall');
const load = () => +execSync('uptime').toString().split('load averages:')[1].trim().split(/\s+/)[0];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function gate() { for (let i = 0; i < 40 && load() > MAXLOAD; i++) await sleep(10000); return load(); }

const TIERS = ['high', 'med', 'low'];
const DPRS = [1, 3];

console.log(`# 390x844 css, ${PLACE}, limiter OFF, M1 Max / ANGLE Metal / headless Chrome`);
console.log(`# load gate: each row waits for 1-min load <= ${MAXLOAD}; the load BEFORE and AFTER the sample is printed`);
console.log(`# 'med' is the tier a real iPhone/Android gets; 'high' is the tier every prior 390x844 measurement used\n`);
console.log(`  ${'tier'.padEnd(6)}${'dpr'.padEnd(5)}${'buffer'.padEnd(12)}${'Mpx'.padEnd(6)}  ${'gpuP50'.padStart(7)} ${'gpuP95'.padStart(7)} | ${'frmP50'.padStart(6)} ${'frmP95'.padStart(6)} ${'worst'.padStart(6)} | ${'cpuP50'.padStart(6)} | calls | load`);

for (const tier of TIERS) {
  const logs = [];
  const { page, close } = await boot({ w: 390, h: 844, qs: `?skipIntro&quality=${tier}`, logs, limiter: false });
  await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
  await page.waitForTimeout(6000);
  await page.evaluate((p) => WALLY.debug.arrive(p, true), PLACE);
  await page.waitForTimeout(3000);
  await page.evaluate(INJECT);
  const got = await page.evaluate(() => WALLY.ctx.quality.name);
  if (got !== tier) console.log(`  !! asked for ${tier}, got ${got}`);

  for (const d of DPRS) {
    const buf = await page.evaluate((dd) => {
      WALLY.ctx.quality.pixelRatio = dd;
      WALLY.ctx.renderer.setPixelRatio(dd);
      WALLY.ctx.render.syncViewport(true);
      const gl = WALLY.ctx.renderer.getContext();
      return [gl.drawingBufferWidth, gl.drawingBufferHeight];
    }, d);
    await page.waitForTimeout(2500);
    const l0 = await gate();
    await page.evaluate(() => window.__SMP__.start('m', 'frame'));
    await page.waitForTimeout(SECS * 1000);
    await page.evaluate(() => window.__SMP__.stop());
    const r = await page.evaluate(() => window.__SMP__.read());
    const c = await page.evaluate(() => WALLY.debug.perf());
    const gpu = stats(r.rec.slice(1).map(x => x.gpu).filter(x => x != null));
    const mpx = (buf[0] * buf[1]) / 1e6;
    console.log(`  ${got.padEnd(6)}${String(d).padEnd(5)}${(buf[0] + 'x' + buf[1]).padEnd(12)}${mpx.toFixed(2).padEnd(6)}  ` +
      `${String(gpu ? gpu.p50 : '-').padStart(7)} ${String(gpu ? gpu.p95 : '-').padStart(7)} | ${String(c.p50).padStart(6)} ${String(c.p95).padStart(6)} ${String(c.worst).padStart(6)} | ${String(c.cpuMs).padStart(6)} | ${String(c.calls).padStart(5)} | ${l0}->${load()}`);
  }
  console.log(`  ${('  errors ' + logs.filter(l => /PAGEERROR/.test(l)).length)}`);
  await close();
}
