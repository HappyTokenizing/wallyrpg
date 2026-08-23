/* P3 — the pad against the fade. Every event my instrument records
   carries the idle flags AS THEY WERE at that event, so "the contact
   landed while the cluster was inert" is read off the tape rather than
   inferred from a round trip. `live` is the explicit flag, not
   uiLayers().hit — the button's own opacity is 1 for the whole fade. */
import { boot, instrument, arm, stop, padGeom, hand, toDoor, reporter, verbList, count } from './lib.mjs';

const R = reporter();
const B = await boot();
const { page, cdp } = B;
await instrument(page);
const H = hand(cdp, page);
const closeAll = () => page.evaluate(() => WALLY.ctx.ui.closeAll());
const idleGet = () => page.evaluate(() => WALLY.debug.idle());
const idleSet = (s) => page.evaluate((v) => WALLY.debug.idle(v), s);
const tape = (r) => r.log.filter(e => e.ty !== 'pointermove' && !e.ty.startsWith('touch'))
  .map(e => `${e.ty}#${e.id}${e.detail ? '(d' + e.detail + ')' : ''}[live=${e.live}]->${e.tgt.split('.').slice(0, 2).join('.')}`).join(' ');

await toDoor(page); await closeAll();
await page.evaluate(() => WALLY.debug.hideUI(true));
await page.waitForTimeout(600);
const D = 1.4;
await idleSet(D);
const g = await padGeom(page);
const goIdle = async () => { await page.waitForTimeout(D * 1000 + 900); return idleGet(); };
const fadeMs = await page.evaluate(() => {
  const d = getComputedStyle(document.querySelector('.w-stickzone')).transitionDuration || '0s';
  let m = 0; for (const v of d.split(',')) m = Math.max(m, (parseFloat(v) || 0) * 1000);
  return m;
});
console.log('fade duration read off the CSS:', fadeMs, 'ms');

/* ---- 1. it fades ---- */
let i = await goIdle();
R.ok(i.hidden === true && i.live === false, 'P3-1 the controls fade out on the idle clock', JSON.stringify(i));

/* ---- 2. a double tap wakes, and fires NOTHING at the door ---- */
await arm(page);
await H.down(1, g.act.cx, g.act.cy); await H.up(1);
await H.wait(90);
await H.down(1, g.act.cx, g.act.cy); await H.up(1);
await H.wait(900);
let r = await stop(page);
i = await idleGet();
console.log('   wake tape:', tape(r));
R.ok(i.hidden === false && count(r, 'padpress') === 0 && r.panels.length === 0,
  'P3-2 a double tap on the HIDDEN Enter at a door wakes and fires no verb',
  `hidden ${i.hidden} verbs ${verbList(r) || 'none'} panels ${JSON.stringify(r.panels)}`);

/* ---- 3. a press DURING the fade-in is refused ---- */
i = await goIdle();
R.ok(i.hidden, 'P3-3a re-armed (faded)', `why ${i.why}`);
await arm(page);
await H.down(1, 195, 300); await H.up(1);        // wake on the canvas, away from the pad
await H.wait(70);
await H.down(1, 195, 300); await H.up(1);        // commit -> the fade-in starts
await H.wait(60);
await H.down(1, g.act.cx, g.act.cy);             // land on Enter mid-fade
await H.wait(70);
await H.up(1);
await H.wait(1200);
r = await stop(page);
const padDown = r.log.find(e => e.ty === 'pointerdown' && e.y > 700 && e.x > 300);
console.log('   mid-fade tape:', tape(r));
R.ok(padDown && padDown.live === false,
  'P3-3b the Enter press really did land while the cluster was inert',
  padDown ? `live=${padDown.live} hidden=${padDown.hid}` : 'no such contact');
R.ok(count(r, 'padpress') === 0 && r.panels.length === 0,
  'P3-3c a press that lands and lifts during the 0.42 s fade-in fires nothing',
  `verbs ${verbList(r) || 'none'} panels ${JSON.stringify(r.panels)}`);

/* ---- 4. a contact that OUTLIVES the fade-in: lands inert, lifts live ---- */
i = await goIdle();
R.ok(i.hidden, 'P3-4a re-armed (faded)');
await arm(page);
await H.down(1, 195, 300); await H.up(1);
await H.wait(70);
await H.down(1, 195, 300); await H.up(1);        // commit
await H.wait(60);
await H.down(1, g.act.cx, g.act.cy);             // lands inert...
await H.wait(630);                               // ...and lifts long after the fade (still < 700 ms: a compat click IS sent)
await H.up(1);
await H.wait(1000);
r = await stop(page);
const down4 = r.log.find(e => e.ty === 'pointerdown' && e.y > 700 && e.x > 300);
const up4 = r.log.filter(e => e.ty === 'pointerup').pop();
const click4 = r.log.filter(e => e.ty === 'click').pop();
console.log('   outlives-fade tape:', tape(r));
R.ok(down4 && down4.live === false && up4 && up4.live === true,
  'P3-4b the contact really straddled the fade (landed inert, lifted live)',
  `down live=${down4 && down4.live} up live=${up4 && up4.live}`);
R.ok(count(r, 'padpress') === 0 && r.panels.length === 0,
  'P3-4c ...and it fired nothing — the retargeted click carries detail 1 and the pointer path never armed',
  `verbs ${verbList(r) || 'none'} click ${click4 ? click4.tgt + ' d' + click4.detail : 'none'} panels ${JSON.stringify(r.panels)}`);

/* ---- 5. the fade lands under a resting thumb ---- */
await page.evaluate(() => WALLY.debug.idle(1.0));
await page.waitForTimeout(300);
await arm(page);
await H.down(1, g.act.cx, g.act.cy);             // thumb parks on Enter and stays
await H.wait(2600);                              // the clock runs out under it
const midHold = await idleGet();
await H.up(1);
await H.wait(900);
r = await stop(page);
console.log('   thumb-through-fade tape:', tape(r));
R.ok(midHold.hidden === true,
  'P3-5a a thumb resting on Enter is not presence — the controls faded under it',
  `hidden ${midHold.hidden} why ${midHold.why}`);
R.ok(count(r, 'padpress') === 0 && r.panels.length === 0,
  'P3-5b ...and lifting that thumb fires nothing',
  `verbs ${verbList(r) || 'none'} panels ${JSON.stringify(r.panels)}`);
await idleSet(D);

/* ---- 6. TAP_GAP and TAP_DIST, measured in the page's own event clock ---- */
i = await goIdle();
const w0 = i.wakes;
await arm(page);
await H.down(1, 195, 300); await H.up(1);
await H.wait(430);                               // aiming well past TAP_GAP
await H.down(1, 195, 300); await H.up(1);
await H.wait(700);
r = await stop(page);
let i2 = await idleGet();
const ups = r.log.filter(e => e.ty === 'pointerup');
const downs = r.log.filter(e => e.ty === 'pointerdown');
const measuredGap = (ups[0] && downs[1]) ? downs[1].ts - ups[0].ts : null;
R.ok(i2.wakes === w0 && measuredGap > 300,
  'P3-6 two taps separated by more than TAP_GAP do not wake',
  `measured gap ${measuredGap} ms (TAP_GAP 300), wakes ${w0} -> ${i2.wakes}`);

i = await goIdle();
const w1 = i.wakes;
await arm(page);
await H.down(1, 150, 300); await H.up(1);
await H.wait(90);
await H.down(1, 150 + 70, 300); await H.up(1);   // 70 px apart: past TAP_DIST 44
await H.wait(700);
r = await stop(page);
i2 = await idleGet();
const d2 = r.log.filter(e => e.ty === 'pointerdown');
const measuredDist = (d2[0] && d2[1]) ? Math.round(Math.hypot(d2[1].x - d2[0].x, d2[1].y - d2[0].y)) : null;
const gap2 = (r.log.filter(e => e.ty === 'pointerup')[0] && d2[1]) ? d2[1].ts - r.log.filter(e => e.ty === 'pointerup')[0].ts : null;
R.ok(i2.wakes === w1,
  'P3-7 two taps further apart than TAP_DIST do not wake',
  `measured ${measuredDist} px apart (TAP_DIST 44), gap ${gap2} ms, wakes ${w1} -> ${i2.wakes}`);

/* ---- 8. a press-and-hold is not tap two ---- */
i = await goIdle();
const w2 = i.wakes;
await arm(page);
await H.down(1, 195, 300); await H.up(1);        // tap one
await H.wait(60);
await H.down(1, 195, 300);
await H.wait(650);                               // held past TAP_MS 400
await H.up(1);
await H.wait(700);
r = await stop(page);
i2 = await idleGet();
const dl = r.log.filter(e => e.ty === 'pointerdown');
const ul = r.log.filter(e => e.ty === 'pointerup');
const heldFor = (dl[1] && ul[1]) ? ul[1].ts - dl[1].ts : null;
R.ok(i2.wakes === w2,
  'P3-8 a press-and-hold right after a tap is not tap two',
  `contact two held ${heldFor} ms (TAP_MS 400), wakes ${w2} -> ${i2.wakes}`);

/* ---- 9. a camera drag does not wake, and still steers ---- */
i = await goIdle();
const w3 = i.wakes;
const yaw0 = await page.evaluate(() => WALLY.ctx.cam.yaw);
await arm(page);
await H.drag(200, 420, 150, 0, 10, 26);
await H.wait(600);
r = await stop(page);
i2 = await idleGet();
const yaw1 = await page.evaluate(() => WALLY.ctx.cam.yaw);
const spin = Math.abs(Math.atan2(Math.sin(yaw1 - yaw0), Math.cos(yaw1 - yaw0)));
R.ok(i2.wakes === w3 && i2.hidden === true,
  'P3-9 a camera drag over the faded controls does not wake',
  `wakes ${w3} -> ${i2.wakes}, hidden ${i2.hidden}`);
R.ok(spin > 0.15, 'P3-9b ...and the drag really turned the camera', `${(spin * 57.3).toFixed(1)} deg`);

/* ---- 10. a dialogue restores the pad ---- */
i = await goIdle();
R.ok(i.hidden, 'P3-10a faded before the conversation');
await page.evaluate(() => { WALLY.ctx.ui.dialogue({ speaker: 'Test', text: ['PAGE-0', 'PAGE-1', 'PAGE-2', 'PAGE-3', 'PAGE-4'] }); return true; });
await page.waitForTimeout(900);
i = await idleGet();
const gg = await padGeom(page);
R.ok(i.hidden === false && i.why === 'dialogue',
  'P3-10b a dialogue opening over faded controls brings the pad back',
  `hidden ${i.hidden} why ${i.why} act op ${gg.act.op}`);

/* ---- 11. Enter advances the conversation, once per tap ---- */
await page.waitForTimeout(600);
const pageOf = () => page.evaluate(() => {
  const el = document.querySelector('.w-dlg .gh') || document.querySelector('.w-dlg');
  return el ? (el.textContent || '').trim().slice(0, 12) : null;
});
const p0 = await pageOf();
await arm(page);
await H.tap(g.act.cx, g.act.cy, 250);
await H.wait(900);
r = await stop(page);
const p1 = await pageOf();
R.ok(count(r, 'interact') === 1 && p0 !== p1,
  'P3-11 one tap of Enter advances the conversation exactly one page',
  `interact ${count(r, 'interact')} page "${p0}" -> "${p1}"`);
await arm(page);
for (let k = 0; k < 3; k++) { await H.down(1, g.act.cx, g.act.cy); await H.wait(60); await H.up(1); await H.wait(90); }
await H.wait(900);
r = await stop(page);
const p2 = await pageOf();
const dlgOpen = await page.evaluate(() => WALLY.ctx.ui.dialogueOpen);
R.ok(count(r, 'interact') === 3,
  'P3-12 three rapid taps of Enter run the verb exactly three times — no click path fires alongside the pointer path',
  `interact ${count(r, 'interact')} padpress ${count(r, 'padpress')} page "${p1}" -> "${p2}" dialogueOpen ${dlgOpen}`);
const strayClicks = r.bub.filter(b => b.ty === 'click');
R.ok(strayClicks.length === 0,
  'P3-12b ...and not one of their compatibility clicks reached the document',
  strayClicks.length ? JSON.stringify(strayClicks) : 'all eaten');
await page.evaluate(() => WALLY.ctx.ui.closeAll());

console.log(`\n${R.fails} failure(s). page errors: ${B.errs.length}`, B.errs.slice(0, 6).join(' | '));
await B.close();
