#!/usr/bin/env node
/* _k27-climb — DOES `high` ACTUALLY CLIMB NOW, ON A REAL PAGE LOAD?
   Everything else in this change is a constant and a table. This is
   the only check that the governor, untouched, does the thing the new
   constants were chosen for: boot at the frame that always shipped and
   then take exactly one notch, to the budget ceiling, on this device's
   own evidence. Driven the way mobilebugs drives the phone —
   governorStep(), which takes the SAME decision governorTick() takes
   and obeys the same learned cap, so a lift here is a lift there.
   Also prints the FIRST FRAME, because by the time a rig has awaited
   __WALLY_READY__ the governor has had time to move. */
import { boot, sleep, load1, ENVSTATE, FIRST_FRAME } from './_j26-lib.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const W = +arg('w', 1600), H = +arg('h', 900), DSF = +arg('dsf', 2);

const logs = [];
console.log(`# _k27-climb — headless Chrome (channel chrome), ANGLE Metal on Apple M1 Max, macOS 14.4. load ${load1()}`);
const { page, close } = await boot({ w: W, h: H, phone: false, dpr: DSF, logs, qs: '?skipIntro&hour=12.5', initScript: FIRST_FRAME });
await sleep(6000);
const env = await page.evaluate(ENVSTATE);
const first = await page.evaluate(() => window.__J26_FIRST__);
console.log(`box ${W}x${H} @ deviceScaleFactor ${DSF}   tier '${env.tier}'  msaa ${env.msaa}  prMax ${env.pixelRatioMax}  budget ${env.pixelBudget} Mpx`);
console.log(`FIRST FRAME: pixelRatio ${first && first.pixelRatio}  canvas ${first && first.canvas.join('x')}  (tier pixelRatio ${first && first.tierPixelRatio})`);

await sleep(6000);
const vp = await page.evaluate(() => WALLY.debug.viewport());
console.log(`ceiling here: prCeiling ${vp.prCeiling}  ladder step ${vp.prStep}  buffer ${vp.buffer.join('x')} = ${vp.mpx} Mpx  samples ${vp.samples}  inSync ${vp.inSync}`);

console.log('\nnotch  ->  pixelRatio   buffer          Mpx     capped   (governorStep(+1), same decision the frame loop takes)');
for (let i = 0; i < 4; i++) {
  const r = await page.evaluate(() => WALLY.debug.governorStep(+1));
  await sleep(1200);
  const v = await page.evaluate(() => WALLY.debug.viewport());
  console.log(`  ${i + 1}    ->  ${String(r.after).padEnd(11)} ${v.buffer.join('x').padEnd(15)} ${String(v.mpx).padEnd(7)} ${r.capped ? 'CAPPED — the ladder has nothing left above the budget' : ''}`);
}
const gs = await page.evaluate(() => WALLY.debug.governorState());
console.log(`\nstate: step ${gs.step}/${gs.cap} of ladder ${JSON.stringify(gs.ladder)}   log: ${JSON.stringify(gs.log)}`);
console.log(`\n# page errors ${logs.filter(l => /PAGEERROR/.test(l)).length}   load at end ${load1()}`);
await close();
