#!/usr/bin/env node
/* ============================================================
   _j26-first.mjs — WHAT DOES THE *FIRST* FRAME RENDER AT?

   The claim in renderer.js is: "The first frame renders at the tier's
   pixelRatio, which is 1 on every tier — i.e. exactly the frame this
   project has always measured. Anything above that is climbed to,
   later, by the governor." That claim is UNTESTABLE by any rig that
   waits for __WALLY_READY__ and then reads the ratio: on this box the
   governor has already taken both notches by frame 266, about 4.4 s,
   and _j26-pr.mjs's own "BOOT" row read 2 because of exactly that.

   So this installs a recorder BEFORE the page's own script runs
   (page.addInitScript), which latches the ratio and the drawing buffer
   on the first animation frame at which window.WALLY.ctx exists.

   It also samples the ladder every 500 ms for 8 s, so the CLIMB — not
   just its endpoint — is on the record with a time next to it.
   ============================================================ */
import { boot, FIRST_FRAME, sleep, load1, loadGate } from './_j26-lib.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const MAXLOAD = +arg('maxload', 4);

const CASES = [
  ['phone   390x844  dsf 1', { w: 390, h: 844, phone: true, dpr: 1 }],
  ['phone   390x844  dsf 2', { w: 390, h: 844, phone: true, dpr: 2 }],
  ['phone   390x844  dsf 3', { w: 390, h: 844, phone: true, dpr: 3 }],
  ['desktop 1600x900 dsf 2', { w: 1600, h: 900, phone: false, dpr: 2 }],
];

console.log('# _j26-first — the ratio the FIRST frame renders at, and the climb after it.');
console.log('# recorder installed with page.addInitScript, before any of the game\'s own script.');
console.log('# rig: headless Chrome (channel chrome), ANGLE Metal on Apple M1 Max, limiter ON (real vsync).\n');

for (const [label, opts] of CASES) {
  const l0 = await loadGate(MAXLOAD);
  const logs = [];
  const { page, close } = await boot({ ...opts, logs, initScript: FIRST_FRAME, qs: '?skipIntro&hour=12.5' });
  const first = await page.evaluate(() => window.__J26_FIRST__);
  const track = [];
  for (let i = 0; i < 24; i++) {
    track.push(await page.evaluate(() => {
      const el = WALLY.ctx.renderer.domElement, g = WALLY.debug.governorState();
      return { f: WALLY.ctx.frame, t: +performance.now().toFixed(0), pr: g.pixelRatio, step: g.step, cap: g.cap,
        buf: `${el.width}x${el.height}`, settle: g.settle };
    }));
    await sleep(500);
  }
  const l1 = load1();
  console.log(`=== ${label}`);
  console.log('    FIRST FRAME: ' + JSON.stringify(first));
  const moves = [];
  let prev = null;
  for (const t of track) { if (!prev || t.pr !== prev.pr) moves.push(t); prev = t; }
  console.log('    ladder over 12 s (only the changes): ' + JSON.stringify(moves));
  console.log('    log: ' + JSON.stringify(await page.evaluate(() => WALLY.debug.governorState().log)));
  console.log(`    load ${l0} -> ${l1};  page errors ${logs.filter(l => /PAGEERROR/.test(l)).length}\n`);
  await close();
}
console.log(`# load (1-min) at end: ${load1()}`);
