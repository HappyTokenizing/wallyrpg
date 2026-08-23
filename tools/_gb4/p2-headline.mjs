/* P2 — THE HEADLINE, at the apartment door, plus everything two contacts
   can do to the new pointer path. Counters are handler entries (ui.click
   is the first statement of every bindPress verb) AND game state (panels),
   which are separable and both read. Lift order is now dispatched on the
   MEASURED touchEnd semantics — see lib.mjs hand(). */
import { boot, instrument, arm, stop, padGeom, hand, toDoor, reporter, verbList, count } from './lib.mjs';

const R = reporter();
const B = await boot();
const { page, cdp } = B;
await instrument(page);
const H = hand(cdp, page);
const closeAll = () => page.evaluate(() => WALLY.ctx.ui.closeAll());
const near = () => page.evaluate(() => !!WALLY.ctx.ui.near);
const speed = () => page.evaluate(() => { const c = WALLY.ctx.wally.controller; const v = c && (c.velocity || c.vel); return v ? +Math.hypot(v.x, v.z).toFixed(2) : null; });
async function atDoor() { await toDoor(page); await closeAll(); await page.waitForTimeout(500); return padGeom(page); }
const tape = (r) => r.log.filter(e => e.ty !== 'pointermove' && !e.ty.startsWith('touch'))
  .map(e => `${e.ty}#${e.id}${e.detail ? '(d' + e.detail + ')' : ''}->${e.tgt.split('.').slice(0, 2).join('.')}`).join(' ');
const order = (r) => r.log.filter(e => e.ty === 'pointerdown' || e.ty === 'pointerup').map(e => `${e.ty === 'pointerdown' ? 'v' : '^'}${e.id}`).join(' ');

/* ================= 1. STICK HELD, ENTER TAPPED, BOTH LIFT ORDERS ======== */
for (const first of ['enter', 'stick']) {
  const g = await atDoor();
  await arm(page);
  await H.down(1, g.zone.cx, g.zone.cy);          // thumb parked on the stick
  await H.wait(150);
  await H.down(2, g.act.cx, g.act.cy);            // other thumb taps Enter
  await H.wait(200);
  if (first === 'enter') { await H.up(2); await H.wait(150); await H.up(1); }
  else { await H.up(1); await H.wait(150); await H.up(2); }
  await H.wait(800);
  const r = await stop(page);
  R.ok(count(r, 'interact') === 1 && r.panels.length === 1,
    `P2-1${first === 'enter' ? 'a' : 'b'} HEADLINE: stick held, Enter tapped, ${first} lifts first -> the door opens`,
    `verbs ${verbList(r)} panels ${JSON.stringify(r.panels)} | ${order(r)}`);
  await closeAll(); await page.waitForTimeout(400);
}

/* ================= 2. WALKING ON THE STICK, THEN ENTER ================= */
let g = await atDoor();
await arm(page);
await H.down(1, g.zone.cx, g.zone.cy);
await H.wait(60);
await H.move(1, g.zone.cx + 10, g.zone.cy - 26);   // a real deflection
await H.wait(320);
const sp = await speed(); const n0 = await near();
await H.down(2, g.act.cx, g.act.cy);
await H.wait(200);
await H.up(2);                                     // Enter lifts, stick stays down
await H.wait(250);
const spAfter = await speed();
await H.up(1);
await H.wait(800);
let r = await stop(page);
R.ok(sp > 0.2, 'P2-2a he really was walking on the stick when Enter was pressed', `speed ${sp} m/s, ui.near ${n0}`);
R.ok(count(r, 'interact') === 1,
  'P2-2b HEADLINE: walking on the stick and then pressing Enter runs the verb',
  `verbs ${verbList(r)}`);
R.ok(r.panels.length === 1,
  'P2-2c ...and the door actually opened (handler entry and outcome measured separately)',
  `panels ${JSON.stringify(r.panels)} near-at-press ${n0}`);
await closeAll(); await page.waitForTimeout(400);

/* ================= 3. A FINGER PARKED ANYWHERE, THEN ENTER ============== */
g = await atDoor();
await arm(page);
await H.down(1, 195, 300);                        // canvas, mid screen
await H.wait(150);
await H.down(2, g.act.cx, g.act.cy);
await H.wait(200);
await H.up(2);
await H.wait(100);
await H.up(1);
await H.wait(800);
r = await stop(page);
R.ok(count(r, 'interact') === 1 && r.panels.length === 1,
  'P2-3 HEADLINE: a finger parked on the canvas, then Enter -> the door opens',
  `verbs ${verbList(r)} panels ${JSON.stringify(r.panels)} | ${order(r)}`);
await closeAll(); await page.waitForTimeout(400);

/* ================= 4. PHONE AND MENU TOGETHER ================= */
for (const first of ['phone', 'menu']) {
  g = await atDoor();
  await arm(page);
  await H.down(1, g.phone.cx, g.phone.cy);
  await H.down(2, g.menu.cx, g.menu.cy);
  await H.wait(200);
  if (first === 'phone') { await H.up(1); await H.wait(90); await H.up(2); }
  else { await H.up(2); await H.wait(90); await H.up(1); }
  await H.wait(900);
  r = await stop(page);
  const rootNow = (await padGeom(page)).root;
  console.log(`   ${first}-first tape: ${tape(r)}`);
  R.ok(count(r, 'padpress') === 2,
    `P2-4${first === 'phone' ? 'a' : 'b'} HEADLINE: Phone and Menu pressed together, ${first} released first -> BOTH fire`,
    `padpress ${count(r, 'padpress')} verbs ${verbList(r)} panels ${JSON.stringify(r.panels)} rootdisp ${rootNow && rootNow.disp}`);
  await closeAll(); await page.waitForTimeout(500);
}

/* ================= 5. A SHEET TAKES THE SCREEN UNDER A HELD BUTTON ====== */
/* finger A holds Enter at the door; finger B taps Phone, which puts the
   whole pad behind a sheet. A then lifts, still over where Enter was.
   A compatibility click is hit-tested at DISPATCH and could never have
   landed on a button inside a display:none subtree. */
g = await atDoor();
await arm(page);
await H.down(1, g.act.cx, g.act.cy);            // A: hold Enter
await H.wait(120);
await H.down(2, g.phone.cx, g.phone.cy);        // B: press Phone
await H.wait(160);
await H.up(2);                                  // B lifts -> phone opens
await H.wait(700);
const padNow = await padGeom(page);
await H.up(1);                                  // A lifts, over a pad that is gone
await H.wait(900);
r = await stop(page);
console.log('   sheet-under-press tape:', tape(r));
R.ok(count(r, 'openPhone') === 1, 'P2-5a the Phone press itself worked', `verbs ${verbList(r)}`);
R.ok(count(r, 'interact') === 0,
  'P2-5b a button held while a SHEET takes the screen fires nothing when the finger lifts',
  `interact ${count(r, 'interact')} rootdisp ${padNow.root && padNow.root.disp} laidOut ${padNow.root && padNow.root.laidOut} panels ${JSON.stringify(r.panels)}`);
await closeAll(); await page.waitForTimeout(500);

/* ================= 6. CAPTURE vs THE THUMBSTICK ================= */
g = await atDoor();
await arm(page);
await H.down(1, g.zone.cx, g.zone.cy);          // starts on the stick
await H.wait(60);
for (let i = 1; i <= 6; i++) { await H.move(1, g.zone.cx + (g.act.cx - g.zone.cx) * i / 6, g.zone.cy + (g.act.cy - g.zone.cy) * i / 6); await H.wait(25); }
await H.up(1);                                   // lifts ON Enter
await H.wait(800);
r = await stop(page);
R.ok(count(r, 'padpress') === 0 && r.panels.length === 0,
  'P2-6 a contact that started on the STICK and lifted on Enter does not press Enter',
  `verbs ${verbList(r) || 'none'} panels ${JSON.stringify(r.panels)}`);
const rest = await page.evaluate(() => WALLY.debug.touchState());
R.ok(rest.t === 0 && !rest.active, 'P2-6b ...and the stick let go', JSON.stringify(rest));

g = await atDoor();
await arm(page);
await H.down(1, g.act.cx, g.act.cy);            // starts on Enter
await H.wait(60);
for (let i = 1; i <= 6; i++) { await H.move(1, g.act.cx + (g.zone.cx - g.act.cx) * i / 6, g.act.cy + (g.zone.cy - g.act.cy) * i / 6); await H.wait(25); }
await H.up(1);                                   // lifts inside the stick zone
await H.wait(800);
r = await stop(page);
R.ok(count(r, 'padpress') === 0 && r.moved < 0.4,
  'P2-7 a contact that started on ENTER and was dragged into the stick zone neither fires Enter nor drives him',
  `verbs ${verbList(r) || 'none'} moved ${r.moved} m`);

/* ================= 7. THE STICK SURVIVES A PAD PRESS BESIDE IT ========== */
g = await atDoor();
await arm(page);
await H.down(1, g.zone.cx, g.zone.cy);
await H.wait(60);
await H.move(1, g.zone.cx + 8, g.zone.cy - 30);
await H.wait(320);
const spA = await speed();
await H.down(2, g.act.cx, g.act.cy);            // a press beside it...
await H.wait(150);
await H.move(2, g.act.cx - 70, g.act.cy - 50);  // ...that slides off and is refused
await H.wait(140);
await H.up(2);
await H.wait(300);
const spB = await speed();
await H.up(1);
await H.wait(600);
r = await stop(page);
R.ok(spA > 0.2 && spB > 0.2,
  'P2-8 a second contact that lands on Enter and slides off does not stop the walking thumbstick',
  `speed before ${spA} -> after ${spB}; verbs ${verbList(r) || 'none'}`);
R.ok(count(r, 'padpress') === 0, 'P2-8b ...and that slid-off press fired nothing', `verbs ${verbList(r) || 'none'}`);
await closeAll();

console.log(`\n${R.fails} failure(s). page errors: ${B.errs.length}`, B.errs.slice(0, 6).join(' | '));
await B.close();
