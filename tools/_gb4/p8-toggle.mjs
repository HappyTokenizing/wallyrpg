/* P8 — isolate the P7-9 red: after Settings > Touch controls is switched
   off and back on, does one tap on Enter still open the door? Control
   tap first, same door, same coordinates, same gesture. */
import { boot, instrument, arm, stop, padGeom, hand, toDoor, reporter, verbList, count } from './lib.mjs';

const R = reporter();
const B = await boot();
const { page, cdp } = B;
await instrument(page);
const H = hand(cdp, page);
const closeAll = () => page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.hide('dialogue'); });
const tape = (r) => r.log.filter(e => e.ty !== 'pointermove' && !e.ty.startsWith('touch'))
  .map(e => `${e.ty}#${e.id}${e.detail ? '(d' + e.detail + ')' : ''}[live=${e.live}]->${e.tgt.split('.').slice(0, 3).join('.')}`).join(' ');

async function tapEnter(label) {
  await toDoor(page); await closeAll(); await page.waitForTimeout(600);
  const g = await padGeom(page);
  await arm(page);
  await H.tap(g.act.cx, g.act.cy, 250);
  await H.wait(900);
  const r = await stop(page);
  console.log(`   [${label}] act ${g.act.cx},${g.act.cy} hit=${g.act.hit} under=${g.root.underAct} rootcls="${g.root.cls}" laidOut=${g.root.laidOut} near=${g.near} idle=${JSON.stringify(g.idle)}`);
  console.log(`   [${label}] tape: ${tape(r)}`);
  console.log(`   [${label}] verbs: ${verbList(r) || 'none'}  panels ${JSON.stringify(r.panels)}`);
  return r;
}

let r = await tapEnter('control');
R.ok(count(r, 'interact') === 1 && r.panels.length === 1, 'P8-1 CONTROL: a tap on Enter opens the door', `verbs ${verbList(r)}`);
await closeAll(); await page.waitForTimeout(400);

/* the switch, twice, with the controls UP */
const t1 = await page.evaluate(() => { WALLY.ctx.ui.setTouch(false); return WALLY.debug.touchState(); });
await page.waitForTimeout(500);
const t2 = await page.evaluate(() => { WALLY.ctx.ui.setTouch(true); return WALLY.debug.touchState(); });
await page.waitForTimeout(700);
console.log('   switch: off ->', JSON.stringify(t1), ' on ->', JSON.stringify(t2));
r = await tapEnter('after off/on, controls up');
R.ok(count(r, 'interact') === 1 && r.panels.length === 1,
  'P8-2 after Touch controls off and on (controls up), a tap on Enter still opens the door',
  `verbs ${verbList(r) || 'none'} panels ${JSON.stringify(r.panels)}`);
await closeAll(); await page.waitForTimeout(400);

/* now the P7 path: the switch thrown while the controls are FADED */
await page.evaluate(() => { WALLY.debug.hideUI(true); WALLY.debug.idle(1.2); return null; });
await page.waitForTimeout(2400);
let idle = await page.evaluate(() => WALLY.debug.idle());
R.ok(idle.hidden === true, 'P8-3a faded before the switch', `why ${idle.why}`);
await page.evaluate(() => WALLY.ctx.ui.setTouch(false));
await page.waitForTimeout(500);
await page.evaluate(() => WALLY.ctx.ui.setTouch(true));
await page.waitForTimeout(700);
idle = await page.evaluate(() => WALLY.debug.idle());
console.log('   idle after the switch:', JSON.stringify(idle));
r = await tapEnter('after off/on from faded');
R.ok(count(r, 'interact') === 1 && r.panels.length === 1,
  'P8-4 after the switch is thrown while faded, a tap on Enter opens the door',
  `verbs ${verbList(r) || 'none'} panels ${JSON.stringify(r.panels)}`);

/* is it the switch at all, or is it Hide UI still being on? */
await closeAll();
await page.evaluate(() => { WALLY.debug.hideUI(false); return null; });
await page.waitForTimeout(700);
r = await tapEnter('hide UI off again');
R.ok(count(r, 'interact') === 1 && r.panels.length === 1,
  'P8-5 with Hide UI off again, a tap on Enter opens the door',
  `verbs ${verbList(r) || 'none'} panels ${JSON.stringify(r.panels)}`);

/* and with Hide UI ON but the clock nowhere near expiring */
await closeAll();
await page.evaluate(() => { WALLY.debug.hideUI(true); WALLY.debug.idle(60); return null; });
await page.waitForTimeout(600);
r = await tapEnter('hide UI on, long clock');
R.ok(count(r, 'interact') === 1 && r.panels.length === 1,
  'P8-6 with Hide UI on and the controls up, a tap on Enter opens the door',
  `verbs ${verbList(r) || 'none'} panels ${JSON.stringify(r.panels)}`);

console.log(`\n${R.fails} failure(s). page errors: ${B.errs.length}`, B.errs.slice(0, 6).join(' | '));
await B.close();
