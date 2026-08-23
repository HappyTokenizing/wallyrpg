/* PROBE 6 — the cases the shipped suite does NOT contain, plus the two
   second-order questions the focus defect raises.

   Not in tools/touchtest.mjs: three rapid Enters through a dialogue,
   rapid repeats at all, a press that slides ON to a control, a release
   OFF-SCREEN, and the headline two-finger case driven in BOTH lift
   orders. Everything else on the re-run list is in that suite and it is
   green (216/216). */
import { boot, padProbe, padRead, panelsNow, nearId, boxes, clsDown } from './lib.mjs';

const R = await boot({ mobile: true });
const { page, ok, mouseAt, mousePress, multi, touch, press } = R;

const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const toOpenGround = () => page.evaluate((b) => {
  WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.hide('dialogue'); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {});
}, BOOT);
const toDoor = async () => {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.hide('dialogue'); WALLY.debug.arrive('apartment', true); });
  await page.waitForTimeout(1200);
  try { await page.waitForFunction(() => WALLY.ctx.ui.near != null, { timeout: 5000 }); } catch {}
  await page.waitForTimeout(300);
  return nearId(page);
};
const hush = async () => {
  await page.evaluate(() => { WALLY.ctx.ui.hide('dialogue'); WALLY.ctx.ui.closeAll(); });
  await page.waitForTimeout(700);
};
const blur = () => page.evaluate(() => document.activeElement?.blur?.());
const active = () => page.evaluate(() => {
  const a = document.activeElement;
  return a === document.body ? 'BODY' : (a?.getAttribute?.('aria-label') || a?.tagName || null);
});
const cardText = () => page.evaluate(() => document.querySelector('.w-dlg .w-dlg-tx')?.textContent?.replace(/\s+/g, ' ').trim() || null);
const idle = (s) => page.evaluate((v) => WALLY.debug.idle(v), s);

await page.evaluate(() => WALLY.debug.hideUI(false));
await page.waitForTimeout(500);
const B = await boxes(page);
const P = (x, y, id) => ({ x, y, id, radiusX: 14, radiusY: 14, force: 1 });

/* ============ 1. THREE RAPID ENTERS, EXACTLY THREE PAGES ============ */
await toOpenGround(); await hush();
await padProbe(page);
await page.evaluate(() => { WALLY.ctx.ui.dialogue({ speaker: 'Rig',
  text: ['PAGE ONE', 'PAGE TWO', 'PAGE THREE', 'PAGE FOUR', 'PAGE FIVE', 'PAGE SIX'] }); return true; });
await page.waitForTimeout(700);
const seq = [await cardText()];
for (let i = 0; i < 3; i++) { await press(B.act.x, B.act.y, 45); await page.waitForTimeout(200); seq.push(await cardText()); }
let p = await padRead(page);
const open1 = await page.evaluate(() => !!WALLY.ctx.ui.dialogueOpen);
ok(p.act === 3 && seq[0] === 'PAGE ONE' && seq[3] === 'PAGE FOUR' && open1 === true,
  'RPT-1 [three rapid Enters advance a dialogue exactly three pages]: no drop, no double',
  `act ${p.act}, pages ${JSON.stringify(seq)}, still open ${open1}`);
await hush();

/* ============ 2. RAPID REPEATS — six taps, six verbs ============ */
await toOpenGround(); await hush();
await padProbe(page);
await page.evaluate(() => { WALLY.ctx.ui.dialogue({ speaker: 'Rig',
  text: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] }); return true; });
await page.waitForTimeout(600);
for (let i = 0; i < 6; i++) { await press(B.act.x, B.act.y, 35); await page.waitForTimeout(110); }
await page.waitForTimeout(500);
p = await padRead(page);
const txt2 = await cardText();
ok(p.act === 6 && txt2 === 'G',
  'RPT-2 [six taps 110 ms apart]: six verbs, six pages — nothing dropped and nothing fired twice',
  `act ${p.act}, page "${txt2}"`);
await hush();

/* ============ 3. RAPID REPEATS ON JUMP ============ */
await toOpenGround(); await page.waitForTimeout(900);
let jumps = 0;
for (let i = 0; i < 4; i++) {
  await touch('touchStart', B.jump.x, B.jump.y);
  await page.waitForTimeout(120);
  const v = await page.evaluate(() => +WALLY.ctx.wally.controller.velocity.y.toFixed(2));
  if (v > 0.5) jumps++;
  await touch('touchEnd', B.jump.x, B.jump.y);
  await page.waitForTimeout(900);
}
ok(jumps >= 3, 'RPT-3 [four rapid Jump presses]: at least three left the ground', `${jumps}/4`);
ok((await clsDown(page, '.w-abtn.jump')) === false, 'RPT-3b [Jump is not left stuck down]');

/* ============ 4. A PRESS THAT SLIDES ON ============ */
const door4 = await toDoor();
await padProbe(page);
await touch('touchStart', B.act.x, B.act.y - 150);       // canvas, above the button
await page.waitForTimeout(60);
await touch('touchMove', B.act.x, B.act.y);              // ...slides onto Enter
await page.waitForTimeout(60);
await touch('touchEnd', B.act.x, B.act.y);
await page.waitForTimeout(900);
p = await padRead(page); let pn = await panelsNow(page);
ok(door4 !== null && p.act === 0 && !pn.includes('place'),
  'SL-1 [a press that slides ON to Enter]: a contact that began on the canvas never arms the button',
  `near ${door4}, act ${p.act}, panels ${JSON.stringify(pn)}, clicks ${JSON.stringify(p.clicks.map((c) => [c.target, c.detail]))}`);
ok((await clsDown(page, '.w-abtn.act')) === false, 'SL-1b [and Enter is not left held]');
await hush();

/* ============ 5. RELEASE OFF-SCREEN ============ */
const door5 = await toDoor();
await padProbe(page);
await touch('touchStart', B.act.x, B.act.y);
await page.waitForTimeout(60);
await touch('touchMove', -40, 400);                      // dragged off the left edge
await page.waitForTimeout(60);
await touch('touchEnd', -40, 400);
await page.waitForTimeout(900);
p = await padRead(page); pn = await panelsNow(page);
ok(door5 !== null && p.act === 0 && !pn.includes('place'),
  'OFF-1 [a press on Enter released OFF-SCREEN]: the release-inside test refuses it',
  `near ${door5}, act ${p.act}, panels ${JSON.stringify(pn)}, up ${JSON.stringify(p.up && [p.up.target, p.up.button])}`);
ok((await clsDown(page, '.w-abtn.act')) === false, 'OFF-1b [and it let the button go]');
await padProbe(page);
await press(B.act.x, B.act.y, 60);
await page.waitForTimeout(900);
p = await padRead(page); pn = await panelsNow(page);
ok(p.act === 1 && pn.includes('place'), 'OFF-1c [the next press still opens the door]',
  `act ${p.act}, panels ${JSON.stringify(pn)}`);
await hush();

/* ============ 6. THE HEADLINE CASE, BOTH LIFT ORDERS ============ */
for (const order of ['enter-first', 'stick-first']) {
  const d = await toDoor();
  await padProbe(page);
  await multi('touchStart', [P(B.stick.x, B.stick.y, 1)]);
  await page.waitForTimeout(60);
  await multi('touchMove', [P(B.stick.x, B.stick.y - 40, 1)]);
  await page.waitForTimeout(240);
  await multi('touchStart', [P(B.stick.x, B.stick.y - 40, 1), P(B.act.x, B.act.y, 2)]);
  await page.waitForTimeout(90);
  if (order === 'enter-first') {
    await multi('touchEnd', [P(B.stick.x, B.stick.y - 40, 1)]);          // Enter lifts
    await page.waitForTimeout(120);
    await multi('touchEnd', []);                                          // stick lifts
  } else {
    await multi('touchEnd', [P(B.act.x, B.act.y, 2)]);                    // stick lifts
    await page.waitForTimeout(120);
    await multi('touchEnd', []);                                          // Enter lifts
  }
  await page.waitForTimeout(900);
  p = await padRead(page); pn = await panelsNow(page);
  ok(d !== null && p.act === 1 && pn.includes('place'),
    `HEAD [stick held + Enter, ${order} lift]: the game's main verb runs and the door opens`,
    `near ${d}, act ${p.act}, panels ${JSON.stringify(pn)}, toasts ${JSON.stringify(p.toasts)}`);
  await hush();
}

/* ============ 7. FINGER ON ENTER + A MOUSE RIGHT PRESS ON THE SAME BUTTON ============ */
const door7 = await toDoor();
await padProbe(page); await blur();
await touch('touchStart', B.act.x, B.act.y);
await page.waitForTimeout(80);
await mouseAt('mouseMoved', B.act.x, B.act.y);
await mouseAt('mousePressed', B.act.x, B.act.y, 'right', 2);
await page.waitForTimeout(80);
await mouseAt('mouseReleased', B.act.x, B.act.y, 'right', 0);
await page.waitForTimeout(80);
await touch('touchEnd', B.act.x, B.act.y);
await page.waitForTimeout(900);
p = await padRead(page); pn = await panelsNow(page);
ok(door7 !== null && p.act === 1 && pn.includes('place'),
  'MIX-1 [a right press landing on a button a finger is already holding]: the finger still fires on its own release',
  `near ${door7}, act ${p.act}, panels ${JSON.stringify(pn)}`);
ok((await active()) === 'BODY', 'MIX-2 [and the right press left no focus behind]', `active ${await active()}`);
await hush(); await blur();

/* ============ 8. DOES THE STOLEN FOCUS SURVIVE THE FADE? ============ */
await page.evaluate(() => WALLY.debug.hideUI(true));
await page.waitForTimeout(500);
await idle(1.0);
const door8 = await toDoor();
await padProbe(page); await blur();
await mousePress(B.act.x, B.act.y, 'right', 60);         // steals focus
await page.waitForTimeout(200);
const f8a = await active();
await page.waitForTimeout(2600);                          // stand still: the controls fade
const st8 = await idle();
const f8b = await active();
await page.keyboard.press('Space');
await page.waitForTimeout(900);
p = await padRead(page); pn = await panelsNow(page);
ok(st8.hidden === true, 'FD-pre [the controls really faded out]', JSON.stringify(st8));
ok(p.act === 0 && !pn.includes('place'),
  'FD-1 [a keystroke on a button the player cannot see]: with the pad faded out, Space must not run Enter',
  `focus before the fade ${f8a}, after it ${f8b}, act ${p.act}, panels ${JSON.stringify(pn)}, clicks ${JSON.stringify(p.clicks.map((c) => [c.target, c.detail]))}`);
await page.evaluate(() => { WALLY.debug.hideUI(false); WALLY.debug.idle(null); WALLY.ctx.ui.closeAll(); });
await blur();

/* ============ 9. A RIGHT PRESS DURING THE FADE-IN ============ */
await page.evaluate(() => WALLY.debug.hideUI(true));
await page.waitForTimeout(400);
await idle(1.0);
const door9 = await toDoor();
await page.waitForTimeout(2600);
const st9 = await idle();
await padProbe(page); await blur();
await touch('touchStart', 200, 400); await touch('touchEnd', 200, 400);
await touch('touchStart', 200, 400); await touch('touchEnd', 200, 400);   // wake
await page.waitForTimeout(120);                                            // mid fade-in
const live9 = (await idle()).live;
await mousePress(B.act.x, B.act.y, 'right', 50);
await page.waitForTimeout(150);
const f9 = await active();
await page.keyboard.press('Space');
await page.waitForTimeout(900);
p = await padRead(page); pn = await panelsNow(page);
ok(st9.hidden === true && live9 === false, 'FI-pre [pressed mid fade-in]', `hidden ${st9.hidden}, live at the press ${live9}`);
ok(p.act === 0 && !pn.includes('place'),
  'FI-1 [a right press during the fade-in, then Space]: the inert window holds',
  `focused ${f9}, act ${p.act}, panels ${JSON.stringify(pn)}`);
await page.evaluate(() => { WALLY.debug.hideUI(false); WALLY.debug.idle(null); WALLY.ctx.ui.closeAll(); });

console.log(`\n${R.fails} FAIL(S)`);
await R.close();
process.exit(R.fails ? 1 : 0);
