/* GB6 PROBE 3 — the re-run list, everything that does NOT depend on the
   idle clock. The binding, the suppression path and the assertions have
   all changed since these were last driven.

     · stick held + Enter, in BOTH lift orders, with the door opening
     · walking + Enter, door in range asserted at the tap
     · a finger parked on the canvas + Enter
     · two contacts on the SAME button — Enter, and Jump
     · a press that slides OFF, and one that slides ON
     · a system cancel mid-press
     · a release off the button and off the screen
     · rapid repeats
     · three rapid Enters through a dialogue: exactly three pages
     · keyboard / AT activation, including straight after a stray contact
*/
import { boot, padProbe, padRead, panelsNow, nearId, boxes, clsDown } from './lib.mjs';

const R = await boot({ mobile: true });
const { page, ok, touch, multi, press } = R;
const pt = (id, x, y) => ({ x, y, id, radiusX: 14, radiusY: 14, force: 1 });

const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const toOpenGround = async () => {
  await page.evaluate((b) => { WALLY.debug.uiHide(); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {}); }, BOOT);
  await page.waitForTimeout(700);
};
const toDoor = async () => {
  await page.evaluate(() => { WALLY.debug.uiHide(); WALLY.debug.arrive('apartment', true); });
  await page.waitForTimeout(1200);
  try { await page.waitForFunction(() => WALLY.ctx.ui.near != null, null, { timeout: 5000 }); } catch {}
  await page.waitForTimeout(300);
  return nearId(page);
};
const closeAll = async () => { await page.evaluate(() => WALLY.debug.uiHide()); await page.waitForTimeout(400); };
const why = () => page.evaluate(() => WALLY.debug.interact());

await page.evaluate(() => WALLY.debug.hideUI(false));
await page.waitForTimeout(400);
const B = await boxes(page);
console.log('BOXES', JSON.stringify(B));

/* ============ 1. TWO FINGERS: STICK + ENTER, BOTH LIFT ORDERS ============ */
for (const enterFirst of [true, false]) {
  const door = await toDoor();
  await padProbe(page);
  await multi('touchStart', [pt(1, B.stick.x, B.stick.y)]);
  await page.waitForTimeout(60);
  await multi('touchMove', [pt(1, B.stick.x, B.stick.y - 70)]);
  await page.waitForTimeout(160);
  const deflected = await page.evaluate(() => +WALLY.debug.touchState().t.toFixed(2));
  const nearAtTap = await nearId(page);
  await multi('touchStart', [pt(1, B.stick.x, B.stick.y - 70), pt(2, B.act.x, B.act.y)]);
  await page.waitForTimeout(80);
  if (enterFirst) {
    await multi('touchEnd', [pt(2, B.act.x, B.act.y)]);
    await page.waitForTimeout(120);
    await multi('touchEnd', [pt(1, B.stick.x, B.stick.y - 70)]);
  } else {
    await multi('touchEnd', [pt(1, B.stick.x, B.stick.y - 70)]);
    await page.waitForTimeout(120);
    await multi('touchEnd', [pt(2, B.act.x, B.act.y)]);
  }
  await page.waitForTimeout(900);
  const p = await padRead(page); const pn = await panelsNow(page);
  ok(deflected > 0.5 && nearAtTap !== null,
    `2F-pre [${enterFirst ? 'Enter lifts first' : 'stick lifts first'}]: the stick really was deflected and a door really was in range at the tap`,
    `t ${deflected} near ${nearAtTap}`);
  ok(p.act === 1 && pn.includes('place'),
    `2F [${enterFirst ? 'Enter lifts first' : 'stick lifts first'}]: Enter under the second thumb runs the verb AND the door opens`,
    `act ${p.act} panels ${JSON.stringify(pn)} why ${JSON.stringify(await why())} clicks ${JSON.stringify(p.clicks.map((c) => [c.target, c.detail]))}`);
  ok((await page.evaluate(() => +WALLY.debug.touchState().t.toFixed(2))) === 0,
    `2F-state [${enterFirst ? 'Enter first' : 'stick first'}]: the stick is back at rest`);
  await closeAll();
}

/* ============ 2. A FINGER PARKED ON THE CANVAS + ENTER ============ */
{
  const door = await toDoor();
  await padProbe(page);
  await multi('touchStart', [pt(1, 195, 300)]);
  await page.waitForTimeout(200);
  await multi('touchStart', [pt(1, 195, 300), pt(2, B.act.x, B.act.y)]);
  await page.waitForTimeout(80);
  await multi('touchEnd', [pt(2, B.act.x, B.act.y)]);
  await page.waitForTimeout(120);
  await multi('touchEnd', [pt(1, 195, 300)]);
  await page.waitForTimeout(900);
  const p = await padRead(page); const pn = await panelsNow(page);
  ok(door !== null && p.act === 1 && pn.includes('place'),
    'PARK [a finger resting on the canvas + Enter]: the door opens',
    `act ${p.act} panels ${JSON.stringify(pn)} why ${JSON.stringify(await why())}`);
  await closeAll();
}

/* ============ 3. TWO CONTACTS ON THE SAME BUTTON ============ */
{
  const door = await toDoor();
  await padProbe(page);
  const lx = B.act.x - 18, rx = B.act.x + 18;
  await multi('touchStart', [pt(1, lx, B.act.y)]);
  await page.waitForTimeout(60);
  await multi('touchStart', [pt(1, lx, B.act.y), pt(2, rx, B.act.y)]);
  await page.waitForTimeout(80);
  await multi('touchEnd', [pt(1, lx, B.act.y)]);
  await page.waitForTimeout(150);
  await multi('touchEnd', [pt(2, rx, B.act.y)]);
  await page.waitForTimeout(900);
  const p = await padRead(page); const pn = await panelsNow(page);
  ok(p.downs.filter((d) => d.inPad).length >= 2, 'SAME-pre [both contacts really landed inside the pad]',
    JSON.stringify(p.downs.map((d) => [d.target, d.id])));
  ok(p.act === 1, 'SAME [two thumbs on one Enter]: the verb runs exactly once',
    `act ${p.act} panels ${JSON.stringify(pn)}`);
  await closeAll();
}
/* the same question of JUMP, which has no per-contact ownership at all */
{
  await toOpenGround();
  await padProbe(page);
  const lx = B.jump.x - 14, rx = B.jump.x + 14;
  await multi('touchStart', [pt(1, lx, B.jump.y)]);
  await page.waitForTimeout(70);
  const heldA = await clsDown(page, '.w-abtn.jump');
  await multi('touchStart', [pt(1, lx, B.jump.y), pt(2, rx, B.jump.y)]);
  await page.waitForTimeout(70);
  const heldAB = await clsDown(page, '.w-abtn.jump');
  await multi('touchEnd', [pt(1, lx, B.jump.y)]);
  await page.waitForTimeout(90);
  const heldAfterFirstLift = await clsDown(page, '.w-abtn.jump');
  await multi('touchEnd', [pt(2, rx, B.jump.y)]);
  await page.waitForTimeout(120);
  const heldEnd = await clsDown(page, '.w-abtn.jump');
  ok(heldA === true && heldAB === true, 'JMP2-pre [both contacts really landed on Jump and it read as held]',
    `A ${heldA} AB ${heldAB}`);
  ok(heldAfterFirstLift === true,
    'JMP2 [two thumbs on Jump, one lifts]: the button is still held by the finger that is still on it',
    `after first lift held=${heldAfterFirstLift}, after both ${heldEnd}`);
  ok(heldEnd === false, 'JMP2-state [and it lets go when the last finger does]');
  await page.waitForTimeout(1200);
}

/* ============ 4. SLIDE OFF / SLIDE ON ============ */
{
  const door = await toDoor();
  await padProbe(page);
  await touch('touchStart', B.act.x, B.act.y);
  await page.waitForTimeout(60);
  await touch('touchMove', B.act.x - 130, B.act.y - 60);
  await page.waitForTimeout(60);
  await touch('touchEnd', B.act.x - 130, B.act.y - 60);
  await page.waitForTimeout(800);
  const p = await padRead(page); const pn = await panelsNow(page);
  ok(door !== null && p.act === 0 && pn.length === 0,
    'SLIDE-OFF [lands on Enter, slides 130 px away, lifts]: fires nothing',
    `act ${p.act} panels ${JSON.stringify(pn)}`);
  ok((await clsDown(page, '.w-abtn.act')) === false, 'SLIDE-OFF-state [and Enter is not left armed]');
  await closeAll();
}
{
  const door = await toDoor();
  await padProbe(page);
  await touch('touchStart', B.act.x - 130, B.act.y - 60);
  await page.waitForTimeout(60);
  await touch('touchMove', B.act.x, B.act.y);
  await page.waitForTimeout(60);
  await touch('touchEnd', B.act.x, B.act.y);
  await page.waitForTimeout(900);
  const p = await padRead(page); const pn = await panelsNow(page);
  const clickOnPad = p.clicks.filter((c) => c.inPad).map((c) => [c.target, c.detail]);
  ok(door !== null && p.act === 0 && pn.length === 0,
    'SLIDE-ON [lands on the canvas, slides ONTO Enter, lifts on it]: fires nothing — the press never armed the button',
    `act ${p.act} panels ${JSON.stringify(pn)} clicks-in-pad ${JSON.stringify(clickOnPad)}`);
  await closeAll();
}

/* ============ 5. SYSTEM CANCEL MID-PRESS ============ */
{
  const door = await toDoor();
  await padProbe(page);
  await touch('touchStart', B.act.x, B.act.y);
  await page.waitForTimeout(90);
  const armed = await clsDown(page, '.w-abtn.act');
  await R.cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await page.waitForTimeout(700);
  const p = await padRead(page); const pn = await panelsNow(page);
  ok(armed === true, 'CANCEL-pre [the press really armed Enter first]');
  ok(p.act === 0 && pn.length === 0, 'CANCEL [a system cancel mid-press]: runs no verb',
    `act ${p.act} panels ${JSON.stringify(pn)}`);
  ok((await clsDown(page, '.w-abtn.act')) === false, 'CANCEL-state [and lets the button go]');
  await padProbe(page);
  await press(B.act.x, B.act.y, 60);
  await page.waitForTimeout(900);
  const p2 = await padRead(page); const pn2 = await panelsNow(page);
  ok(p2.act === 1 && pn2.includes('place'), 'CANCEL-after [the very next press opens the door]',
    `act ${p2.act} panels ${JSON.stringify(pn2)}`);
  await closeAll();
}

/* ============ 6. RELEASE OFF-SCREEN ============ */
{
  const door = await toDoor();
  await padProbe(page);
  await touch('touchStart', B.act.x, B.act.y);
  await page.waitForTimeout(60);
  await touch('touchMove', 380, 843);
  await page.waitForTimeout(50);
  await touch('touchMove', 389, 900);            // below the viewport
  await page.waitForTimeout(50);
  await touch('touchEnd', 389, 900);
  await page.waitForTimeout(800);
  const p = await padRead(page); const pn = await panelsNow(page);
  ok(p.act === 0 && pn.length === 0, 'OFFSCR [a release below the bottom of the screen]: fires nothing',
    `act ${p.act} panels ${JSON.stringify(pn)} lastUp ${JSON.stringify(p.up && [p.up.target, p.up.inPad])}`);
  ok((await clsDown(page, '.w-abtn.act')) === false, 'OFFSCR-state [and Enter is not left armed]');
  await closeAll();
}

/* ============ 7. RAPID REPEATS ============ */
{
  await toOpenGround();
  let left = 0;
  for (let i = 0; i < 4; i++) {
    await touch('touchStart', B.jump.x, B.jump.y);
    await page.waitForTimeout(70);
    const vy = await page.evaluate(() => +WALLY.ctx.wally.controller.velocity.y.toFixed(2));
    await touch('touchEnd', B.jump.x, B.jump.y);
    if (vy > 0.5) left++;
    await page.waitForTimeout(900);
  }
  ok(left >= 3, 'RPT-JUMP [four rapid Jump presses]: at least three left the ground', `${left}/4`);
}
{
  /* rapid Phone open/close: press, close, press, close */
  await toOpenGround();
  let opened = 0;
  for (let i = 0; i < 3; i++) {
    await padProbe(page);
    await press(B.sc[0].x, B.sc[0].y, 55);
    await page.waitForTimeout(600);
    const pn = await panelsNow(page);
    if (pn.includes('phone')) opened++;
    await closeAll();
  }
  ok(opened === 3, 'RPT-PHONE [three rapid Phone presses, each after a close]: all three open the phone', `${opened}/3`);
}

/* ============ 8. THREE RAPID ENTERS THROUGH A DIALOGUE ============ */
{
  await toOpenGround();
  await page.evaluate(() => {
    WALLY.ctx.ui.dialogue({ speaker: 'Probe', text: ['PAGE ZERO', 'PAGE ONE', 'PAGE TWO', 'PAGE THREE', 'PAGE FOUR', 'PAGE FIVE'] });
  });
  await page.waitForTimeout(500);
  /* let page zero finish typing, so every tap below is an ADVANCE and
     not a "complete the line" */
  const full = () => page.evaluate(() => document.querySelector('.w-dlg-tx .gh')?.textContent ?? null);
  const shown = () => page.evaluate(() => document.querySelector('.w-dlg-tx .lv')?.textContent ?? null);
  for (let i = 0; i < 30; i++) {
    if ((await shown()) === (await full())) break;
    await page.waitForTimeout(120);
  }
  const p0 = await full();
  await padProbe(page);
  for (let i = 0; i < 3; i++) {
    await touch('touchStart', B.act.x, B.act.y);
    await touch('touchEnd', B.act.x, B.act.y);
    await page.waitForTimeout(90);
  }
  await page.waitForTimeout(1200);
  const p3 = await full();
  const rd = await padRead(page);
  const open = await page.evaluate(() => !!WALLY.ctx.ui.dialogueOpen);
  ok(p0 === 'PAGE ZERO', 'DLG-pre [page zero had finished typing before the three taps]', String(p0));
  ok(p3 === 'PAGE THREE' && open,
    'DLG-3 [three rapid Enters advance exactly three pages]: not two, not four',
    `"${p0}" -> "${p3}" open ${open} act ${rd.act} clicks ${JSON.stringify(rd.clicks.map((c) => [c.target, c.detail]))} cardClicks ${rd.card}`);
  await page.evaluate(() => WALLY.ctx.ui.closeAll());
  await page.waitForTimeout(400);
}

/* ============ 9. KEYBOARD / AT ACTIVATION ============ */
{
  const door = await toDoor();
  await padProbe(page);
  await page.evaluate(() => document.querySelector('.w-abtn.act').focus());
  await page.waitForTimeout(150);
  const focused = await page.evaluate(() => document.activeElement === document.querySelector('.w-abtn.act'));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  const p = await padRead(page); const pn = await panelsNow(page);
  const d0 = p.clicks.filter((c) => c.detail === 0 && c.inPad).length;
  ok(focused, 'AT-pre [Enter really holds keyboard focus]');
  ok(p.act === 1 && pn.includes('place'), 'AT-1 [keyboard activation]: Enter on the focused button opens the door',
    `act ${p.act} panels ${JSON.stringify(pn)} detail0-clicks-in-pad ${d0}`);
  await closeAll();
}
{
  /* ...and straight after a stray contact, which is what the deleted
     capture-phase window used to eat */
  const door = await toDoor();
  await padProbe(page);
  await touch('touchStart', 195, 300);
  await page.waitForTimeout(60);
  await touch('touchMove', 250, 320);
  await page.waitForTimeout(60);
  await touch('touchEnd', 250, 320);
  await page.waitForTimeout(200);
  await page.evaluate(() => document.querySelector('.w-abtn.act').focus());
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  const p = await padRead(page); const pn = await panelsNow(page);
  ok(p.act === 1 && pn.includes('place'),
    'AT-2 [keyboard activation straight after a stray camera drag]: still delivered',
    `act ${p.act} panels ${JSON.stringify(pn)} why ${JSON.stringify(await why())}`);
  await closeAll();
}

console.log(`\n${R.fails} FAIL(S)`);
await R.close();
process.exit(R.fails ? 1 : 0);
