/* GB6 PROBE 1 — THE CHORDED SEQUENCES.

   The gate's own comment names ONE reachable chord (left down, right
   down, LEFT up, right up) and puts the fire-point test below the
   disarm for it. This drives all four orders, on all three kinds of
   control (a bindPress button, Jump, the thumbstick), with right AND
   middle as the second button, and asks two questions of each:

     · did a verb fire?            (must not, unless the release that
                                    ends the gesture is a genuine b0
                                    pointerup)
     · was anything left ARMED or DEFLECTED afterwards?
       — the stick at full deflection walking him away on his own,
         Jump latched, a button stuck 'down', or a control that has
         stopped answering the next honest press.

   Every chord is followed by a plain primary press to prove the
   control still works. */
import { boot, padProbe, padRead, panelsNow, nearId, boxes, clsDown } from './lib.mjs';

const R = await boot({ mobile: true });
const { page, ok, mouseAt, mousePress, press } = R;

const MASKB = { left: 1, middle: 4, right: 2 };

const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const toOpenGround = async () => {
  await page.evaluate((b) => { WALLY.ctx.ui.closeAll(); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {}); }, BOOT);
  await page.waitForTimeout(800);
};
const toDoor = async () => {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.arrive('apartment', true); });
  await page.waitForTimeout(1200);
  try { await page.waitForFunction(() => WALLY.ctx.ui.near != null, null, { timeout: 5000 }); } catch {}
  await page.waitForTimeout(300);
  return nearId(page);
};
const closeAll = async () => { await page.evaluate(() => WALLY.ctx.ui.closeAll()); await page.waitForTimeout(400); };

await page.evaluate(() => WALLY.debug.hideUI(false));
await page.waitForTimeout(400);
const B = await boxes(page);
console.log('BOXES', JSON.stringify(B));

/* a chord: steps like [['down','left'],['down','right'],['up','left'],['up','right']] */
async function chord(x, y, steps, hold = 70) {
  let mask = 0;
  await mouseAt('mouseMoved', x, y, 'none', 0);
  for (const [act, btn] of steps) {
    if (act === 'down') { mask |= MASKB[btn]; await mouseAt('mousePressed', x, y, btn, mask); }
    else { mask &= ~MASKB[btn]; await mouseAt('mouseReleased', x, y, btn, mask); }
    await page.waitForTimeout(hold);
  }
}

const stickState = () => page.evaluate(() => ({
  t: +WALLY.debug.touchState().t.toFixed(2),
  live: document.querySelector('.w-stick')?.classList.contains('live') ?? null,
  sp: +Math.hypot(WALLY.ctx.wally.controller.velocity.x, WALLY.ctx.wally.controller.velocity.z).toFixed(2),
}));
const jumpState = () => page.evaluate(() => ({
  vy: +WALLY.ctx.wally.controller.velocity.y.toFixed(2),
  down: document.querySelector('.w-abtn.jump')?.classList.contains('down') ?? null,
}));
const pos = () => page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, z: p.z }; });
const dist = (a, b) => +Math.hypot(a.x - b.x, a.z - b.z).toFixed(2);

const ORDERS = [
  ['L-down R-down R-up L-up', (b) => [['down', 'left'], ['down', b], ['up', b], ['up', 'left']], true],
  ['L-down R-down L-up R-up', (b) => [['down', 'left'], ['down', b], ['up', 'left'], ['up', b]], false],
  ['R-down L-down R-up L-up', (b) => [['down', b], ['down', 'left'], ['up', b], ['up', 'left']], false],
  ['R-down L-down L-up R-up', (b) => [['down', b], ['down', 'left'], ['up', 'left'], ['up', b]], false],
];

/* ---------------- A. ENTER (a bindPress button) ---------------- */
for (const second of ['right', 'middle']) {
  for (const [label, mk, primaryEndsIt] of ORDERS) {
    const door = await toDoor();
    await padProbe(page);
    await chord(B.act.x, B.act.y, mk(second));
    await page.waitForTimeout(800);
    const p = await padRead(page);
    const pn = await panelsNow(page);
    const why = await page.evaluate(() => WALLY.debug.interact());
    const evs = p.downs.map((d) => `d${d.button}`).concat(p.ups.map((u) => `u${u.button}`)).join(',');
    ok(p.downs.some((d) => d.inPad),
      `A-pre [${second} chord "${label}" really reached Enter]`, `events ${evs}`);
    if (primaryEndsIt) {
      ok(p.act === 1 && pn.includes('place'),
        `A [${label} / ${second}]: the gesture ENDS on a genuine primary release, so Enter fires`,
        `act ${p.act} panels ${JSON.stringify(pn)} why ${JSON.stringify(why)} ev ${evs} clicks ${JSON.stringify(p.clicks.map((c) => [c.target, c.detail]))}`);
    } else {
      ok(p.act === 0 && pn.length === 0,
        `A [${label} / ${second}]: no verb fires`,
        `act ${p.act} panels ${JSON.stringify(pn)} ev ${evs} clicks ${JSON.stringify(p.clicks.map((c) => [c.target, c.detail]))}`);
    }
    ok((await clsDown(page, '.w-abtn.act')) === false,
      `A-state [${label} / ${second}]: Enter is not left visually armed`);
    /* ...and it still answers */
    await closeAll();
    await toDoor();
    await padProbe(page);
    await press(B.act.x, B.act.y, 60);
    await page.waitForTimeout(900);
    const p2 = await padRead(page); const pn2 = await panelsNow(page);
    ok(p2.act === 1 && pn2.includes('place'),
      `A-after [${label} / ${second}]: the very next finger press still opens the door`,
      `act ${p2.act} panels ${JSON.stringify(pn2)}`);
    await closeAll();
  }
}

/* ---------------- B. JUMP ---------------- */
for (const second of ['right', 'middle']) {
  for (const [label, mk] of ORDERS) {
    await toOpenGround();
    await padProbe(page);
    await chord(B.jump.x, B.jump.y, mk(second), 90);
    await page.waitForTimeout(120);
    const mid = await jumpState();
    await page.waitForTimeout(1400);
    const rest = await jumpState();
    const grounded = await page.evaluate(() => WALLY.ctx.wally.controller.grounded);
    ok(rest.down === false && grounded === true,
      `B [${label} / ${second}] on Jump: nothing latched, he is back on the ground`,
      `mid ${JSON.stringify(mid)} rest ${JSON.stringify(rest)}`);
    /* jump still works */
    await padProbe(page);
    await page.evaluate(() => WALLY.ctx.ui.closeAll());
    await R.touch('touchStart', B.jump.x, B.jump.y);
    await page.waitForTimeout(180);
    const air = await jumpState();
    await R.touch('touchEnd', B.jump.x, B.jump.y);
    await page.waitForTimeout(1200);
    ok(air.vy > 0.5, `B-after [${label} / ${second}]: Jump still leaves the ground`, JSON.stringify(air));
  }
}

/* ---------------- C. THE THUMBSTICK ---------------- */
for (const second of ['right', 'middle']) {
  for (const [label, mk] of ORDERS) {
    await toOpenGround();
    const p0 = await pos();
    /* chord with a 70 px pull between the two downs, so a stick that
       armed really is deflected when the chord ends */
    let mask = 0;
    const steps = mk(second);
    await mouseAt('mouseMoved', B.stick.x, B.stick.y, 'none', 0);
    for (let i = 0; i < steps.length; i++) {
      const [act, btn] = steps[i];
      if (act === 'down') { mask |= MASKB[btn]; await mouseAt('mousePressed', B.stick.x, B.stick.y, btn, mask); }
      else { mask &= ~MASKB[btn]; await mouseAt('mouseReleased', B.stick.x, B.stick.y - 70, btn, mask); }
      await page.waitForTimeout(60);
      if (i === 0) {
        for (let k = 1; k <= 4; k++) {
          await mouseAt('mouseMoved', B.stick.x, B.stick.y - k * 18, 'none', mask);
          await page.waitForTimeout(25);
        }
      }
    }
    const during = await stickState();
    await page.waitForTimeout(1000);
    const after = await stickState();
    const moved = dist(await pos(), p0);
    ok(after.t === 0 && after.live === false && after.sp < 0.25,
      `C [${label} / ${second}] on the stick: nothing left deflected when the chord ends`,
      `during ${JSON.stringify(during)} after ${JSON.stringify(after)} moved ${moved} m`);
    /* and it still steers */
    await R.touch('touchStart', B.stick.x, B.stick.y);
    await page.waitForTimeout(50);
    await R.touch('touchMove', B.stick.x, B.stick.y - 60);
    await page.waitForTimeout(450);
    const st = await stickState();
    await R.touch('touchEnd', B.stick.x, B.stick.y - 60);
    await page.waitForTimeout(500);
    ok(st.t > 0.5 && st.sp > 1, `C-after [${label} / ${second}]: the stick still deflects and walks`, JSON.stringify(st));
  }
}

console.log(`\n${R.fails} FAIL(S)`);
await R.close();
process.exit(R.fails ? 1 : 0);
