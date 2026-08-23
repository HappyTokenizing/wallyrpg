/* P1 — WHAT MOVING OFF CLICK BROKE, single contact, controls fully live,
   Hide UI OFF, at the apartment door. Every case is one the compatibility
   click used to decide for free. 250 ms holds throughout: a press of
   700 ms or more gets no compat click at all in this Chrome, so a long
   press would be green for a platform reason. */
import { boot, instrument, arm, stop, padGeom, hand, toDoor, reporter, verbList, count } from './lib.mjs';

const R = reporter();
const B = await boot();
const { page, cdp } = B;
await instrument(page);
const H = hand(cdp, page);
const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const closeAll = () => page.evaluate(() => WALLY.ctx.ui.closeAll());
const dclass = () => page.evaluate(() => [...document.querySelectorAll('.w-acts .w-abtn')].filter(b => b.classList.contains('down')).map(b => b.getAttribute('aria-label')));

async function atDoor() { await toDoor(page); await closeAll(); await page.waitForTimeout(500); return padGeom(page); }
const tape = (r) => r.log.filter(e => e.ty !== 'pointermove' && e.ty !== 'touchstart' && e.ty !== 'touchend')
  .map(e => `${e.ty}${e.detail ? '(d' + e.detail + ')' : ''}->${e.tgt.split('.').slice(0, 2).join('.')}`).join(' ');

/* ---------- 1. CONTROL ---------- */
let g = await atDoor();
await arm(page); await H.tap(g.act.cx, g.act.cy, 250); await H.wait(800);
let r = await stop(page);
R.ok(count(r, 'interact') === 1 && r.panels.length === 1,
  'P1-1 CONTROL: a plain 250 ms tap on a live Enter opens the door',
  `verbs ${verbList(r)} panels ${JSON.stringify(r.panels)}`);
await closeAll(); await page.waitForTimeout(400);

/* ---------- 2. STARTS ON THE BUTTON, SLIDES OFF, LIFTS OUTSIDE ---------- */
g = await atDoor();
await arm(page);
await H.down(1, g.act.cx, g.act.cy);
await H.wait(60);
for (let i = 1; i <= 5; i++) { await H.move(1, g.act.cx - i * 30, g.act.cy - i * 24); await H.wait(24); }
await H.up(1);
await H.wait(800);
r = await stop(page);
R.ok(count(r, 'padpress') === 0 && r.panels.length === 0,
  'P1-2 press starts on Enter and slides 150 px off before release -> refused, as a click would have been',
  `verbs ${verbList(r) || 'none'} panels ${JSON.stringify(r.panels)} | ${tape(r)}`);
R.ok((await dclass()).length === 0, 'P1-2b ...and no button is left wearing .down', JSON.stringify(await dclass()));

/* ---------- 3. STARTS OFF THE BUTTON, SLIDES ON, LIFTS ON IT ---------- */
g = await atDoor();
await arm(page);
await H.down(1, g.act.cx - 150, g.act.cy - 120);       // canvas, up-left of the pad
await H.wait(60);
for (let i = 1; i <= 5; i++) { await H.move(1, g.act.cx - 150 + i * 30, g.act.cy - 120 + i * 24); await H.wait(24); }
await H.up(1);
await H.wait(800);
r = await stop(page);
R.ok(count(r, 'padpress') === 0 && r.panels.length === 0,
  'P1-3 press starts off the button and slides onto Enter before release -> refused',
  `verbs ${verbList(r) || 'none'} panels ${JSON.stringify(r.panels)} | ${tape(r)}`);

/* ---------- 4. CANCELLED MID-PRESS ---------- */
g = await atDoor();
await arm(page);
await H.down(1, g.act.cx, g.act.cy);
await H.wait(120);
await H.cancel();
await H.wait(800);
r = await stop(page);
R.ok(count(r, 'padpress') === 0 && r.panels.length === 0,
  'P1-4 a contact the system cancels mid-press fires nothing',
  `verbs ${verbList(r) || 'none'} | ${tape(r)}`);
R.ok((await dclass()).length === 0, 'P1-4b ...and the button is not left pressed', JSON.stringify(await dclass()));

/* ---------- 5. ENDS OFF-SCREEN ---------- */
g = await atDoor();
await arm(page);
await H.down(1, g.act.cx, g.act.cy);
await H.wait(60);
await H.move(1, g.act.cx, 843);
await H.wait(30);
let offErr = null;
try { await H.move(1, g.act.cx, 980); } catch (e) { offErr = e.message.split('\n')[0]; }
await H.wait(30);
await H.up(1);
await H.wait(800);
r = await stop(page);
const lastUp = r.log.filter(e => e.ty === 'pointerup').pop();
R.ok(count(r, 'padpress') === 0 && r.panels.length === 0,
  'P1-5 a contact dragged off the bottom of the screen and released there fires nothing',
  `verbs ${verbList(r) || 'none'} lastUp@${lastUp ? lastUp.x + ',' + lastUp.y : '-'} ${offErr ? 'dispatch:' + offErr : ''}`);

/* ---------- 6. TWO FINGERS ON THE SAME BUTTON ---------- */
for (const order of ['first-lifts-first', 'second-lifts-first']) {
  g = await atDoor();
  await arm(page);
  await H.down(1, g.act.cx - 8, g.act.cy - 6);
  await H.wait(70);
  await H.down(2, g.act.cx + 8, g.act.cy + 6);
  await H.wait(120);
  if (order === 'first-lifts-first') { await H.up(1); await H.wait(90); await H.up(2); }
  else { await H.up(2); await H.wait(90); await H.up(1); }
  await H.wait(800);
  r = await stop(page);
  R.ok(count(r, 'padpress') === 1 && count(r, 'interact') === 1 && r.panels.length === 1,
    `P1-6 two fingers on the SAME Enter (${order}) fire it exactly once`,
    `padpress ${count(r, 'padpress')} interact ${count(r, 'interact')} panels ${JSON.stringify(r.panels)}`);
  await closeAll(); await page.waitForTimeout(400);
}

/* ---------- 7. RAPID REPEAT, in open ground so nothing modal intervenes ---------- */
await page.evaluate((b) => { WALLY.ctx.ui.closeAll(); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {}); }, BOOT);
await page.waitForTimeout(1200);
g = await padGeom(page);
await arm(page);
for (let i = 0; i < 4; i++) { await H.down(1, g.phone.cx, g.phone.cy); await H.wait(60); await H.up(1); await H.wait(70); }
await H.wait(900);
r = await stop(page);
const phoneRuns = count(r, 'openPhone');
console.log('   rapid tape:', tape(r));
R.ok(count(r, 'padpress') === 4,
  'P1-7 four rapid presses of Phone arm and fire exactly four times',
  `padpress ${count(r, 'padpress')} openPhone ${phoneRuns} panels ${JSON.stringify(r.panels)}`);
const survivingClicks = r.bub.filter(b => b.ty === 'click');
R.ok(survivingClicks.length === 0,
  'P1-7b ...and not one of their compatibility clicks survives to the document',
  survivingClicks.length ? JSON.stringify(survivingClicks) : 'all eaten');
await closeAll(); await page.waitForTimeout(500);

/* ---------- 8. RAPID REPEAT AT THE DOOR: does press one's click come back
     and dismiss what press two opened? ---------- */
g = await atDoor();
await arm(page);
await H.down(1, g.act.cx, g.act.cy); await H.wait(50); await H.up(1);
await H.wait(40);
await H.down(1, g.act.cx, g.act.cy); await H.wait(50); await H.up(1);
await H.wait(1000);
r = await stop(page);
console.log('   door double tape:', tape(r));
console.log('   bubble:', JSON.stringify(r.bub.filter(b => b.ty === 'click' || b.ty === 'pointerup').map(b => [b.ty, b.tgt, b.dp])));
R.ok(r.panels.length >= 1,
  'P1-8 two rapid taps on Enter at the door leave the place sheet OPEN (no trailing click dismissed it)',
  `padpress ${count(r, 'padpress')} interact ${count(r, 'interact')} panels ${JSON.stringify(r.panels)}`);
await closeAll(); await page.waitForTimeout(400);

console.log(`\n${R.fails} failure(s). page errors: ${B.errs.length}`, B.errs.slice(0, 6).join(' | '));
await B.close();
