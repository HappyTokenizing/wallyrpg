/* P10 — the two edge cases P1 left ambiguous, with the tape printed:
   what actually refuses a slide-off on a finger (the rect test, or the
   platform cancelling the contact), and what a release off the bottom
   of the screen really produces. */
import { boot, instrument, arm, stop, padGeom, hand, toDoor, reporter, verbList, count } from './lib.mjs';

const R = reporter();
const B = await boot();
const { page, cdp } = B;
await instrument(page);
const H = hand(cdp, page);
const closeAll = () => page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.hide('dialogue'); });
const tape = (r) => r.log.filter(e => !e.ty.startsWith('touch'))
  .map(e => `${e.ty}#${e.id}${e.detail ? '(d' + e.detail + ')' : ''}@${e.x},${e.y}->${e.tgt.split('.').slice(0, 2).join('.')}`).join('\n     ');
async function atDoor() { await toDoor(page); await closeAll(); await page.waitForTimeout(500); return padGeom(page); }

/* ---- 1. a SMALL slide, just past the button edge ---- */
let g = await atDoor();
const halfW = g.act.w / 2;
await arm(page);
await H.down(1, g.act.cx, g.act.cy);
await H.wait(60);
await H.move(1, g.act.cx - halfW - 14, g.act.cy);       // ~47 px: just outside the left edge
await H.wait(80);
await H.up(1);
await H.wait(900);
let r = await stop(page);
console.log(`   button is ${g.act.w}x${g.act.h} at ${g.act.x},${g.act.y}; slid to ${g.act.cx - halfW - 14},${g.act.cy}`);
console.log('   small-slide-off tape:\n     ' + tape(r));
const cancelled = r.log.some(e => e.ty === 'pointercancel');
const upOutside = r.log.find(e => e.ty === 'pointerup');
R.ok(count(r, 'padpress') === 0 && r.panels.length === 0,
  'P10-1 a press that slides just past the button edge and lifts there fires nothing',
  `verbs ${verbList(r) || 'none'} | refused by ${cancelled ? 'a platform pointercancel' : 'the release-inside test at ' + (upOutside ? upOutside.x + ',' + upOutside.y : '?')}`);

/* ---- 2. a SMALL slide onto the button from just outside ---- */
g = await atDoor();
await arm(page);
await H.down(1, g.act.cx - halfW - 14, g.act.cy);
await H.wait(60);
await H.move(1, g.act.cx, g.act.cy);
await H.wait(80);
await H.up(1);
await H.wait(900);
r = await stop(page);
console.log('   small-slide-on tape:\n     ' + tape(r));
R.ok(count(r, 'padpress') === 0 && r.panels.length === 0,
  'P10-2 a press that starts just outside Enter and lifts on its centre fires nothing',
  `verbs ${verbList(r) || 'none'}`);

/* ---- 3. released off the bottom edge of the screen ---- */
g = await atDoor();
await arm(page);
await H.down(1, g.act.cx, g.act.cy);
await H.wait(60);
let dispatchErr = null;
try {
  await H.move(1, g.act.cx, 900);
  await H.wait(60);
  await H.up(1);
} catch (e) { dispatchErr = e.message.split('\n')[0]; }
await H.wait(900);
r = await stop(page);
console.log('   off-screen tape:\n     ' + tape(r));
const last = r.log[r.log.length - 1];
R.ok(count(r, 'padpress') === 0 && r.panels.length === 0,
  'P10-3 a contact dragged off the bottom of the screen and released there fires nothing',
  `verbs ${verbList(r) || 'none'} | last event ${last ? last.ty + '@' + last.x + ',' + last.y : 'none'} ${dispatchErr ? '| dispatch: ' + dispatchErr : ''}`);

/* ---- 4. ...and a press that leaves and COMES BACK still fires ---- */
g = await atDoor();
await arm(page);
await H.down(1, g.act.cx, g.act.cy);
await H.wait(60);
await H.move(1, g.act.cx - 6, g.act.cy - 6);
await H.wait(60);
await H.move(1, g.act.cx, g.act.cy);
await H.wait(60);
await H.up(1);
await H.wait(900);
r = await stop(page);
console.log('   wobble tape:\n     ' + tape(r));
R.ok(count(r, 'padpress') === 1 && r.panels.length === 1,
  'P10-4 a press that wobbles a few px and lifts on the button still opens the door',
  `verbs ${verbList(r) || 'none'} panels ${JSON.stringify(r.panels)}`);

console.log(`\n${R.fails} failure(s). page errors: ${B.errs.length}`, B.errs.slice(0, 6).join(' | '));
await B.close();
