/* GB6 PROBE 5 — THE DESKTOP, AND THE HYBRID THE GUARD EXISTS FOR.

   1. A fine-pointer desktop with no touch and no flag must get NO pad
      at all — the population that can never be harmed by any of this.
   2. The same desktop with the layer switched on (?touch=1 is the
      supported route: it is what Settings › Touch controls sets) is a
      mouse driving a thumb interface. That is the only place a middle
      or right button can reach a pad control at all, so the whole gate
      is re-swept there with a REAL mouse: primary must work everywhere,
      secondary must fire nothing anywhere, and nothing may be left
      armed or deflected. */
import { boot, padProbe, padRead, panelsNow, nearId, boxes, clsDown, BTN_INDEX } from './lib.mjs';

/* ---------- 1. a plain desktop ---------- */
{
  const R = await boot({ mobile: false, query: '?skipIntro' });
  const st = await R.page.evaluate(() => WALLY.debug.touchState());
  const L = await R.page.evaluate(() => WALLY.debug.uiLayers());
  R.ok(st.enabled === false, 'DESK-1 [desktop never arms]: no pad on a fine-pointer context with no touch',
    JSON.stringify(st));
  R.ok(!L.stick || L.stick.hit === false, 'DESK-2 [and nothing of it is reachable]',
    JSON.stringify(L.stick));
  /* a right press where the pad would be must not reach a pad control */
  await R.mousePress(80, 720, 'right', 60);
  await R.page.waitForTimeout(400);
  const pn = await panelsNow(R.page);
  R.ok(pn.length === 0, 'DESK-3 [a right press over the empty bottom-left corner opens nothing]', JSON.stringify(pn));
  console.log(`DESK ${R.fails} FAIL(S)`);
  if (R.fails) process.exitCode = 1;
  await R.close();
}

/* ---------- 2. the hybrid ---------- */
const R = await boot({ mobile: false, query: '?skipIntro&touch=1' });
const { page, ok, mouseAt, mousePress, mouseDrag } = R;
const MASKB = { left: 1, middle: 4, right: 2 };

const st0 = await page.evaluate(() => WALLY.debug.touchState());
ok(st0.enabled === true, 'HYB-0 [the layer is up on a desktop when it is asked for]', JSON.stringify(st0));

const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const toOpenGround = async () => {
  await page.evaluate((b) => { WALLY.debug.uiHide(); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {}); }, BOOT);
  await page.waitForTimeout(700);
};
const toDoor = async () => {
  await page.evaluate(() => { WALLY.debug.uiHide(); WALLY.debug.arrive('apartment', true); });
  await page.waitForTimeout(1200);
  try { await page.waitForFunction(() => WALLY.ctx.ui.near != null, null, { timeout: 8000 }); } catch {}
  return nearId(page);
};
const closeAll = async () => { await page.evaluate(() => WALLY.debug.uiHide()); await page.waitForTimeout(350); };

await page.evaluate(() => WALLY.debug.hideUI(false));
await page.waitForTimeout(400);
const B = await boxes(page);
console.log('HYB BOXES', JSON.stringify(B));
const CTRL = [['Enter', B.act], ['Jump', B.jump], ['Phone', B.sc[0]], ['Places', B.sc[1]],
  ['Desk', B.sc[2]], ['Menu', B.sc[3]], ['Stick', B.stick]];

const jumpVy = () => page.evaluate(() => ({ vy: +WALLY.ctx.wally.controller.velocity.y.toFixed(2),
  g: WALLY.ctx.wally.controller.grounded }));
const stickState = () => page.evaluate(() => ({ t: +WALLY.debug.touchState().t.toFixed(2),
  sp: +Math.hypot(WALLY.ctx.wally.controller.velocity.x, WALLY.ctx.wally.controller.velocity.z).toFixed(2) }));

/* --- A. PRIMARY WORKS EVERYWHERE (the control that stops a gate which
       refuses everything from passing every negative test) --- */
{
  const door = await toDoor();
  await padProbe(page);
  await mousePress(B.act.x, B.act.y, 'left', 60);
  await page.waitForTimeout(900);
  const p = await padRead(page); const pn = await panelsNow(page);
  ok(door !== null && p.act === 1 && pn.includes('place'),
    'HYB-A1 [mouse primary on Enter at a door]: opens the door',
    `act ${p.act} panels ${JSON.stringify(pn)} why ${JSON.stringify(await page.evaluate(() => WALLY.debug.interact()))}`);
  await closeAll();
}
for (const [i, n] of [[0, 'Phone'], [1, 'Places'], [2, 'Desk'], [3, 'Menu']]) {
  await padProbe(page);
  await mousePress(B.sc[i].x, B.sc[i].y, 'left', 60);
  await page.waitForTimeout(700);
  const p = await padRead(page); const pn = await panelsNow(page);
  ok(p.sc === 1, `HYB-A2 [mouse primary on ${n}]: the shortcut runs`, `sc ${p.sc} panels ${JSON.stringify(pn)}`);
  await closeAll();
}
{
  await toOpenGround();
  await mouseAt('mouseMoved', B.jump.x, B.jump.y);
  await mouseAt('mousePressed', B.jump.x, B.jump.y, 'left', 1);
  await page.waitForTimeout(200);
  const air = await jumpVy();
  await mouseAt('mouseReleased', B.jump.x, B.jump.y, 'left', 0);
  await page.waitForTimeout(1200);
  ok(air.vy > 0.5, 'HYB-A3 [mouse primary on Jump]: leaves the ground', JSON.stringify(air));
}
{
  await toOpenGround();
  await mouseAt('mouseMoved', B.stick.x, B.stick.y);
  await mouseAt('mousePressed', B.stick.x, B.stick.y, 'left', 1);
  for (let i = 1; i <= 5; i++) { await mouseAt('mouseMoved', B.stick.x, B.stick.y - i * 14, 'left', 1); await page.waitForTimeout(30); }
  await page.waitForTimeout(400);
  const s = await stickState();
  await mouseAt('mouseReleased', B.stick.x, B.stick.y - 70, 'left', 0);
  await page.waitForTimeout(600);
  const rest = await stickState();
  ok(s.t > 0.5 && s.sp > 1, 'HYB-A4 [mouse primary drag on the thumbstick]: deflects and walks', JSON.stringify(s));
  ok(rest.t === 0, 'HYB-A4b [and it comes back to rest]', JSON.stringify(rest));
}

/* --- B. SECONDARY FIRES NOTHING, ANYWHERE --- */
for (const btn of ['middle', 'right']) {
  for (const [name, box] of CTRL) {
    if (name === 'Enter') await toDoor(); else await toOpenGround();
    await padProbe(page);
    if (name === 'Stick') {
      const before = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, z: p.z }; });
      await mouseDrag(box.x, box.y, 0, -80, btn, 5);
      await page.waitForTimeout(500);
      const s = await stickState();
      const moved = await page.evaluate((f) => { const p = WALLY.ctx.wally.position;
        return +Math.hypot(p.x - f.x, p.z - f.z).toFixed(2); }, before);
      const pr = await padRead(page);
      ok(pr.downs.some((d) => d.button === BTN_INDEX[btn] && d.inPad),
        `HYB-B-pre [${btn} really reached the stick]`, JSON.stringify(pr.downs.map((d) => [d.target, d.button])));
      ok(s.t === 0 && moved < 0.3, `HYB-B [${btn} drag on the thumbstick]: no deflection, no movement`,
        `${JSON.stringify(s)} moved ${moved} m`);
    } else if (name === 'Jump') {
      await mouseAt('mouseMoved', box.x, box.y);
      await mouseAt('mousePressed', box.x, box.y, btn, MASKB[btn]);
      await page.waitForTimeout(220);
      const mid = await jumpVy();
      await mouseAt('mouseReleased', box.x, box.y, btn, 0);
      await page.waitForTimeout(500);
      const pr = await padRead(page);
      ok(pr.downs.some((d) => d.button === BTN_INDEX[btn] && d.inPad),
        `HYB-B-pre [${btn} really reached Jump]`, JSON.stringify(pr.downs.map((d) => [d.target, d.button])));
      ok(mid.g === true && mid.vy < 0.5, `HYB-B [${btn} press on Jump]: does not leave the ground`, JSON.stringify(mid));
      ok((await clsDown(page, '.w-abtn.jump')) === false, `HYB-B-state [Jump not left held after ${btn}]`);
    } else {
      await mousePress(box.x, box.y, btn, 60);
      await page.waitForTimeout(600);
      const pr = await padRead(page); const pn = await panelsNow(page);
      ok(pr.downs.some((d) => d.button === BTN_INDEX[btn] && d.inPad),
        `HYB-B-pre [${btn} really reached ${name}]`, JSON.stringify(pr.downs.map((d) => [d.target, d.button])));
      ok(pr.act === 0 && pr.sc === 0 && pn.length === 0,
        `HYB-B [${btn} press on ${name}]: fires nothing`,
        `act ${pr.act} sc ${pr.sc} panels ${JSON.stringify(pn)} aux ${JSON.stringify(pr.aux.map((a) => a.button))}`);
    }
    await closeAll();
  }
}

/* --- C. AND THE PRIMARY STILL WORKS AFTER ALL THAT --- */
{
  const door = await toDoor();
  await padProbe(page);
  await mousePress(B.act.x, B.act.y, 'left', 60);
  await page.waitForTimeout(900);
  const p = await padRead(page); const pn = await panelsNow(page);
  ok(door !== null && p.act === 1 && pn.includes('place'),
    'HYB-C [after the whole secondary sweep, a primary press still opens the door]',
    `act ${p.act} panels ${JSON.stringify(pn)}`);
  await closeAll();
}

console.log(`\n${R.fails} FAIL(S)`);
await R.close();
process.exit(R.fails ? 1 : 0);
