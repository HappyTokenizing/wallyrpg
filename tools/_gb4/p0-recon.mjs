/* P0 — RECON. Before any assertion depends on it:
     · is the layer up, and where is every pad button
     · what does my multi-touch dispatch model actually produce in the
       page's own pointerId stream (I refuse to assume CDP's semantics)
     · what is this harness's timeStamp skew, and what does a nominal
       300 ms harness gap measure as in the page's event clock
     · the raw event tape of one honest 250 ms tap on a live Enter */
import { boot, instrument, arm, stop, padGeom, hand, toDoor, reporter, verbList } from './lib.mjs';

const R = reporter();
const B = await boot();
const { page, cdp } = B;
await instrument(page);
const H = hand(cdp, page);

const st0 = await page.evaluate(() => WALLY.debug.touchState());
R.ok(st0.enabled, 'P0-1 touch layer auto-enabled on the phone context', JSON.stringify(st0));

const door = await toDoor(page);
const g = await padGeom(page);
console.log('\ndoor:', JSON.stringify(door));
console.log('geom:', JSON.stringify({
  act: g.act, jump: g.jump, phone: g.phone, places: g.places, desk: g.desk, menu: g.menu,
  zone: g.zone, idle: g.idle,
}, null, 1));

/* ---- 1. what my hand() model really produces ---- */
await arm(page);
await H.down(1, g.zone.cx, g.zone.cy);          // finger A on the stick
await H.wait(60);
await H.down(2, g.act.cx, g.act.cy);            // finger B on Enter
await H.wait(120);
await H.up(2);                                   // B lifts
await H.wait(80);
await H.up(1);                                   // A lifts
await H.wait(400);
let r = await stop(page);
console.log('\nTWO-FINGER TAPE (window capture):');
for (const e of r.log) if (e.ty !== 'pointermove') console.log(`  ${String(e.ty).padEnd(14)} id=${e.id} d=${e.detail} @${e.x},${e.y}  -> ${e.tgt}`);
console.log('verbs:', verbList(r), '| panels', JSON.stringify(r.panels));
const ids = [...new Set(r.log.filter(e => e.ty === 'pointerdown').map(e => e.id))];
const ups = [...new Set(r.log.filter(e => e.ty === 'pointerup').map(e => e.id))];
R.ok(ids.length === 2 && ups.length === 2,
  'P0-2 my active-set model produces TWO distinct pointer contacts, each with its own down and up',
  `downs ${JSON.stringify(ids)} ups ${JSON.stringify(ups)}`);
const clicks = r.log.filter(e => e.ty === 'click');
console.log('clicks in the two-finger sequence:', clicks.length, JSON.stringify(clicks.map(c => [c.tgt, c.detail])));

/* ---- 2. skew: harness wall gap vs the page's own event clock ---- */
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); });
await page.waitForTimeout(500);
await arm(page);
await H.down(1, 195, 400); await H.up(1);
await H.wait(300);                               // nominal TAP_GAP
await H.down(1, 195, 400); await H.up(1);
await H.wait(300);
r = await stop(page);
const downs = r.log.filter(e => e.ty === 'pointerdown');
const upsL = r.log.filter(e => e.ty === 'pointerup');
if (downs.length >= 2 && upsL.length >= 1) {
  const pageGap = downs[1].ts - upsL[0].ts;         // what touch.js measures
  const skew = downs[0].now - downs[0].ts;          // handler entry minus event stamp
  console.log(`\nSKEW: e.timeStamp -> handler entry = ${skew} ms (both contacts: ${downs.map(d => d.now - d.ts).join(', ')})`);
  console.log(`A nominal 300 ms harness gap measures ${pageGap} ms in the page's event clock (TAP_GAP is 300).`);
  R.ok(true, `P0-3 instrument calibration recorded`, `skew ${skew} ms, 300 ms nominal -> ${pageGap} ms measured`);
} else R.ok(false, 'P0-3 could not calibrate', JSON.stringify(r.log.map(e => e.ty)));

/* ---- 3. one honest 250 ms tap on a live Enter, at the door ---- */
await toDoor(page);
await page.waitForTimeout(400);
const g2 = await padGeom(page);
await arm(page);
await H.tap(g2.act.cx, g2.act.cy, 250);
await H.wait(700);
r = await stop(page);
console.log('\nONE-FINGER TAP ON ENTER (250 ms):');
for (const e of r.log) if (e.ty !== 'pointermove') console.log(`  ${String(e.ty).padEnd(14)} id=${e.id} d=${e.detail} -> ${e.tgt}   live=${e.live}`);
console.log('bubble survivors:', JSON.stringify(r.bub.map(b => [b.ty, b.tgt, b.dp])));
console.log('verbs:', verbList(r), '| panels', JSON.stringify(r.panels0), '->', JSON.stringify(r.panels));
console.log('el hits:', JSON.stringify(r.elHits));
R.ok(r.verbs.some(v => v.v === 'interact') && r.panels.length > 0,
  'P0-4 CONTROL: one finger on a live Enter at a door opens the door',
  `verbs ${verbList(r)} panels ${JSON.stringify(r.panels)}`);

console.log(`\n${R.fails} failure(s). page errors: ${B.errs.length}`, B.errs.slice(0, 6).join(' | '));
await B.close();
