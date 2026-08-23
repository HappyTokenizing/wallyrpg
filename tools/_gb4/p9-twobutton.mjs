/* P9 — the discriminator for P2-4. Two pad buttons pressed together
   produced ONE verb. Is that the multi-touch defect coming back, or is
   it the first verb's SHEET taking the screen out from under the second
   button? Same gesture, in open ground, with Enter as the first release
   — where interact() opens nothing at all. Plus the rapid-repeat case
   re-taken somewhere no sheet can intervene. */
import { boot, instrument, arm, stop, padGeom, hand, reporter, verbList, count } from './lib.mjs';

const R = reporter();
const B = await boot();
const { page, cdp } = B;
await instrument(page);
const H = hand(cdp, page);
const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const open = async () => {
  await page.evaluate((b) => { WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.hide('dialogue'); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {}); }, BOOT);
  await page.waitForTimeout(1200);
  return padGeom(page);
};
const tape = (r) => r.log.filter(e => e.ty !== 'pointermove' && !e.ty.startsWith('touch'))
  .map(e => `${e.ty}#${e.id}${e.detail ? '(d' + e.detail + ')' : ''}->${e.tgt.split('.').slice(0, 2).join('.')}`).join(' ');

/* ---- 0. in open ground, Enter opens nothing ---- */
let g = await open();
R.ok(g.near === false, 'P9-0 open ground: no door in range', `near ${g.near} panels ${JSON.stringify(g.panels)}`);

/* ---- 1. Enter + Phone together, Enter released first ---- */
await arm(page);
await H.down(1, g.act.cx, g.act.cy);
await H.down(2, g.phone.cx, g.phone.cy);
await H.wait(200);
await H.up(1);                                   // Enter first: it opens nothing
await H.wait(90);
await H.up(2);                                   // then Phone
await H.wait(900);
let r = await stop(page);
console.log('   enter+phone tape:', tape(r));
R.ok(count(r, 'padpress') === 2,
  'P9-1 two pad buttons pressed together BOTH fire when the first one opens no sheet',
  `padpress ${count(r, 'padpress')} verbs ${verbList(r)} panels ${JSON.stringify(r.panels)}`);
await page.evaluate(() => WALLY.ctx.ui.closeAll());
await page.waitForTimeout(600);

/* ---- 2. three fingers: Enter + Jump + Places ---- */
g = await open();
await arm(page);
await H.down(1, g.act.cx, g.act.cy);
await H.down(2, g.jump.cx, g.jump.cy);
await H.down(3, g.places.cx, g.places.cy);
await H.wait(220);
await H.up(1); await H.wait(70);
await H.up(3); await H.wait(70);
await H.up(2);
await H.wait(900);
r = await stop(page);
console.log('   three-finger tape:', tape(r));
R.ok(count(r, 'padpress') === 2 && r.vy > 0.6,
  'P9-2 three fingers on three controls: both pad buttons fire and the jump launches',
  `padpress ${count(r, 'padpress')} verbs ${verbList(r)} peak vy ${r.vy.toFixed(2)} panels ${JSON.stringify(r.panels)}`);
await page.evaluate(() => WALLY.ctx.ui.closeAll());
await page.waitForTimeout(600);

/* ---- 3. rapid repeat where no sheet can intervene ---- */
g = await open();
await arm(page);
for (let i = 0; i < 5; i++) { await H.down(1, g.act.cx, g.act.cy); await H.wait(55); await H.up(1); await H.wait(70); }
await H.wait(900);
r = await stop(page);
const clicks = r.log.filter(e => e.ty === 'click');
const escaped = r.bub.filter(b => b.ty === 'click');
console.log('   rapid tape:', tape(r));
R.ok(count(r, 'padpress') === 5 && count(r, 'interact') === 5,
  'P9-3 five rapid presses of Enter fire exactly five times — no press dropped, none doubled',
  `padpress ${count(r, 'padpress')} interact ${count(r, 'interact')}`);
R.ok(escaped.length === 0,
  'P9-3b ...and every one of their compatibility clicks was swallowed',
  `${clicks.length} clicks dispatched, ${escaped.length} reached the document ${JSON.stringify(escaped)}`);

/* ---- 4. the tightest repeat this harness can dispatch ---- */
g = await open();
await arm(page);
for (let i = 0; i < 4; i++) { await H.down(1, g.act.cx, g.act.cy); await H.up(1); }
await H.wait(900);
r = await stop(page);
const clicks4 = r.log.filter(e => e.ty === 'click');
const escaped4 = r.bub.filter(b => b.ty === 'click');
const gaps = [];
for (let k = 1; k < r.log.length; k++) if (r.log[k].ty === 'pointerdown') {
  const prevUp = r.log.slice(0, k).reverse().find(e => e.ty === 'pointerup');
  if (prevUp) gaps.push(r.log[k].ts - prevUp.ts);
}
console.log('   tight tape:', tape(r));
R.ok(count(r, 'padpress') === 4,
  'P9-4 four presses with no gap at all still fire four times',
  `padpress ${count(r, 'padpress')} measured lift-to-land gaps ${JSON.stringify(gaps)} ms`);
R.ok(escaped4.length === 0,
  'P9-4b ...and none of their clicks escaped the swallow either',
  `${clicks4.length} clicks, ${escaped4.length} escaped ${JSON.stringify(escaped4)}`);

/* ---- 5. a press that slides from Enter onto the Jump button ---- */
g = await open();
await arm(page);
await H.down(1, g.act.cx, g.act.cy);
await H.wait(60);
await H.move(1, g.jump.cx, g.jump.cy);
await H.wait(120);
await H.up(1);
await H.wait(900);
r = await stop(page);
console.log('   enter->jump tape:', tape(r));
R.ok(count(r, 'padpress') === 0 && r.vy < 0.6,
  'P9-5 a press that starts on Enter and lifts on Jump fires neither',
  `padpress ${count(r, 'padpress')} peak vy ${r.vy.toFixed(2)}`);

console.log(`\n${R.fails} failure(s). page errors: ${B.errs.length}`, B.errs.slice(0, 6).join(' | '));
await B.close();
