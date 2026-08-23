/* PROBE 4 — THE HYBRID, REACHED THE WAY A PLAYER REACHES IT.

   No ?touch= flag and no coarse pointer: a 1280x800 desktop context with
   hasTouch false, where the pad must NOT arm by itself, and is then
   switched on by pressing the real "Touch controls" switch in the real
   Settings sheet with a real mouse. That is the population the whole
   primary-button guard exists for, and it is the one configuration the
   suite reaches only through a query flag. */
import { boot, padProbe, padRead, panelsNow, nearId, boxes, BTN_INDEX } from './lib.mjs';

const R = await boot({ mobile: false });
const { page, ok, mouseAt, mousePress, mouseDrag } = R;

const st0 = await page.evaluate(() => WALLY.debug.touchState());
ok(st0.enabled === false, 'W1 [desktop never arms]: no pad at boot on a fine-pointer context', JSON.stringify(st0));

/* --- through Settings, with a real mouse on the real switch --- */
await page.evaluate(() => WALLY.debug.ui('settings'));
await page.waitForTimeout(900);
const sw = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.w-kv')].find((r) => /Touch controls/.test(r.textContent));
  if (!row) return null;
  const s = row.querySelector('.w-switch');
  const r = s.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, on: s.classList.contains('on') };
});
ok(sw !== null, 'W2 [the Settings sheet really has a Touch controls switch]', JSON.stringify(sw));
if (!sw) { console.log('\ncannot continue'); await R.close(); process.exit(1); }
await mousePress(sw.x, sw.y, 'left', 60);
await page.waitForTimeout(900);
const st1 = await page.evaluate(() => ({ ...WALLY.debug.touchState(),
  saved: !!WALLY.ctx.game?.state?.settings?.touch }));
ok(st1.enabled === true && st1.saved === true,
  'W3 [the switch turns the pad on]: the layer is up with no query flag and no coarse pointer', JSON.stringify(st1));
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.hide('dialogue'); });
await page.waitForTimeout(800);
await page.evaluate(() => WALLY.debug.hideUI(false));
await page.waitForTimeout(600);

const B = await boxes(page);
console.log('BOXES', JSON.stringify(B));
if (!B.act || !B.jump || !B.stick || B.sc.length !== 4) {
  ok(false, 'W4 [the pad is laid out]', JSON.stringify(B)); await R.close(); process.exit(1);
}
ok(true, 'W4 [the pad is laid out on the desktop viewport]', `enter ${B.act.w}px, ${B.sc.length} shortcuts`);

const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const toOpenGround = () => page.evaluate((b) => {
  WALLY.ctx.ui.closeAll(); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {});
}, BOOT);
const toDoor = async () => {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.hide('dialogue'); WALLY.debug.arrive('apartment', true); });
  await page.waitForTimeout(1200);
  try { await page.waitForFunction(() => WALLY.ctx.ui.near != null, { timeout: 5000 }); } catch {}
  await page.waitForTimeout(300);
  return nearId(page);
};
const closeAll = async () => {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.hide('dialogue'); });
  await page.waitForTimeout(500);
};
const blur = () => page.evaluate(() => document.activeElement?.blur?.());
const active = () => page.evaluate(() => {
  const a = document.activeElement;
  return a === document.body ? 'BODY' : (a?.getAttribute?.('aria-label') || a?.tagName || null);
});

const CTRL = [['Enter', B.act], ['Jump', B.jump], ['Phone', B.sc[0]], ['Places', B.sc[1]],
  ['Desk', B.sc[2]], ['Menu', B.sc[3]], ['Stick', B.stick]];

/* --- the sweep, on the Settings-reached layer --- */
for (const btn of ['right', 'middle']) {
  const bi = BTN_INDEX[btn];
  for (const [name, box] of CTRL) {
    if (name === 'Enter') await toDoor(); else await toOpenGround();
    await page.waitForTimeout(500);
    await padProbe(page); await blur();
    if (name === 'Jump' || name === 'Stick') {
      await mouseAt('mouseMoved', box.x, box.y);
      await mouseAt('mousePressed', box.x, box.y, btn, { right: 2, middle: 4 }[btn]);
      await page.waitForTimeout(220);
      const mid = await page.evaluate(() => ({
        vy: +WALLY.ctx.wally.controller.velocity.y.toFixed(2), g: WALLY.ctx.wally.controller.grounded,
        t: +WALLY.debug.touchState().t.toFixed(2) }));
      await mouseAt('mouseReleased', box.x, box.y, btn, 0);
      await page.waitForTimeout(400);
      const pr = await padRead(page);
      ok(pr.downs.some((d) => d.button === bi && d.inPad), `S-pre [${btn} really reached ${name}]`,
        JSON.stringify(pr.downs.map((d) => [d.target, d.button])));
      ok(name === 'Jump' ? (mid.g === true && mid.vy < 0.5) : mid.t === 0,
        `S [${btn} press on ${name}] fires nothing`, JSON.stringify(mid));
    } else {
      await mousePress(box.x, box.y, btn, 60);
      await page.waitForTimeout(600);
      const pr = await padRead(page); const pnn = await panelsNow(page);
      ok(pr.downs.some((d) => d.button === bi && d.inPad), `S-pre [${btn} really reached ${name}]`,
        JSON.stringify(pr.downs.map((d) => [d.target, d.button])));
      ok(pr.act === 0 && pr.sc === 0 && pnn.length === 0, `S [${btn} press on ${name}] fires nothing`,
        `act ${pr.act} sc ${pr.sc} panels ${JSON.stringify(pnn)}`);
    }
    /* AND THE FOCUS IT LEAVES BEHIND, which is the whole point of
       running this on the hybrid: a keyboard is plugged in here. */
    const a = await active();
    ok(a === 'BODY', `S-focus [${btn} press on ${name} focuses nothing]`, `activeElement ${a}`);
    await closeAll(); await blur();
  }
}

/* --- and the primary still presses, on this route too --- */
const doorP = await toDoor();
await padProbe(page);
await mousePress(B.act.x, B.act.y, 'left', 60);
await page.waitForTimeout(900);
let p = await padRead(page), pn = await panelsNow(page);
ok(doorP !== null && p.act === 1 && pn.includes('place'),
  'P1 [primary on Enter, Settings-reached layer]: opens the door',
  `near ${doorP} act ${p.act} panels ${JSON.stringify(pn)} toasts ${JSON.stringify(p.toasts)}`);
await closeAll();
for (const [i, n] of [[0, 'Phone'], [1, 'Places'], [2, 'Desk'], [3, 'Menu']]) {
  await padProbe(page);
  await mousePress(B.sc[i].x, B.sc[i].y, 'left', 60);
  await page.waitForTimeout(700);
  p = await padRead(page); pn = await panelsNow(page);
  ok(p.sc === 1, `P2 [primary on ${n}]: runs`, `sc ${p.sc} panels ${JSON.stringify(pn)}`);
  await closeAll();
}
await toOpenGround(); await page.waitForTimeout(700);
await mouseAt('mouseMoved', B.jump.x, B.jump.y);
await mouseAt('mousePressed', B.jump.x, B.jump.y, 'left', 1);
await page.waitForTimeout(200);
const airP = await page.evaluate(() => +WALLY.ctx.wally.controller.velocity.y.toFixed(2));
await mouseAt('mouseReleased', B.jump.x, B.jump.y, 'left', 0);
ok(airP > 0.5, 'P3 [primary on Jump]: leaves the ground', `vy ${airP}`);
await page.waitForTimeout(900);
await toOpenGround(); await page.waitForTimeout(600);
await mouseAt('mouseMoved', B.stick.x, B.stick.y);
await mouseAt('mousePressed', B.stick.x, B.stick.y, 'left', 1);
for (let i = 1; i <= 5; i++) { await mouseAt('mouseMoved', B.stick.x, B.stick.y - i * 14, 'left', 1); await page.waitForTimeout(30); }
await page.waitForTimeout(400);
const stP = await page.evaluate(() => ({ t: +WALLY.debug.touchState().t.toFixed(2),
  sp: +Math.hypot(WALLY.ctx.wally.controller.velocity.x, WALLY.ctx.wally.controller.velocity.z).toFixed(2) }));
await mouseAt('mouseReleased', B.stick.x, B.stick.y - 70, 'left', 0);
ok(stP.t > 0.5 && stP.sp > 1, 'P4 [primary drag on the thumbstick]: deflects and walks', JSON.stringify(stP));
await page.waitForTimeout(700);

/* --- THE CONSEQUENCE ON THE HYBRID: right press, then a keystroke --- */
const doorX = await toDoor();
await blur();
await padProbe(page);
const dlgX = await page.evaluate(() => !!WALLY.ctx.ui.dialogueOpen);
await mousePress(B.act.x, B.act.y, 'right', 60);
await page.waitForTimeout(250);
const fX = await active();
await page.keyboard.press('Space');
await page.waitForTimeout(900);
p = await padRead(page); pn = await panelsNow(page);
ok(doorX !== null && dlgX === false, 'X-pre [at a door, no card up]', `near ${doorX}, dialogueOpen ${dlgX}`);
ok(p.act === 0 && !pn.includes('place'),
  'X1 [hybrid: right press on Enter, then SPACE]: the refused press must not walk him through the door',
  `focused ${fX}, act ${p.act}, panels ${JSON.stringify(pn)}, clicks ${JSON.stringify(p.clicks.map((c) => [c.target, c.detail]))}, why ${JSON.stringify(await page.evaluate(() => WALLY.debug.interact?.()))}`);

console.log(`\n${R.fails} FAIL(S)`);
await R.close();
process.exit(R.fails ? 1 : 0);
