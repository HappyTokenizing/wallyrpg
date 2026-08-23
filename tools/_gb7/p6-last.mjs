/* GB7 PROBE 6 — the three things still open:
   1. STRADDLE, with the clock set long enough that the harness can
      actually get tap one in BEFORE the fade.
   2. JMP2, confirmed independently: two thumbs on Jump, one lifts.
   3. THE WINDOW INSIDE A CHORD: the stick is armed by the primary, the
      primary release arrives as a pointermove nobody sees, so between
      that and the secondary release the stick is following a mouse with
      no primary button held. Sample INSIDE the window, not after it. */
import { boot, padProbe, padRead, panelsNow, boxes, clsDown } from '../_gb6/lib.mjs';
import { appendFileSync } from 'node:fs';
const LOG = process.env.GB7LOG || '/dev/null';
const mark = (s) => { try { appendFileSync(LOG, `[${new Date().toISOString().slice(11, 19)}] ${s}\n`); } catch {} console.log(s); };
mark('booting');
const R = await boot({ mobile: true });
mark('booted');
const { page, ok, touch, multi, cdp } = R;
const M = (t, x, y, b = 'none', m = 0) => cdp.send('Input.dispatchMouseEvent', {
  type: t, x, y, button: b, buttons: m, pointerType: 'mouse', clickCount: t === 'mouseMoved' ? 0 : 1 });
const pt = (id, x, y) => ({ x, y, id, radiusX: 14, radiusY: 14, force: 1 });
const idle = (s) => page.evaluate((v) => WALLY.debug.idle(v), s);
const idleGet = () => page.evaluate(() => WALLY.debug.idle());
const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const toOpenGround = async () => {
  await page.evaluate((b) => { WALLY.debug.uiHide(); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {}); }, BOOT);
  await page.waitForTimeout(500);
};
await page.evaluate(() => WALLY.debug.hideUI(false));
await page.waitForTimeout(300);
const B = await boxes(page);

/* ===== 1. STRADDLE ===== */
mark('>> STRADDLE');
{
  let done = false, note = '', tries = 0;
  for (const delay of [1.6, 2.2, 3.0, 1.6, 2.2, 3.0]) {
    if (done) break;
    tries++;
    try {
      await toOpenGround();
      await page.evaluate(() => WALLY.debug.hideUI(true));
      await idle(delay);
      /* wait until the clock is close to firing, then tap */
      const t0 = Date.now();
      while (Date.now() - t0 < delay * 1000 + 500) {
        const i = await idleGet();
        if (i.hidden) break;
        if (i.t > delay - 0.45) break;
        await page.waitForTimeout(60);
      }
      const before = await idleGet();
      if (before.hidden) { note = `already hidden at tap one (t ${before.t})`; await idle(null); continue; }
      await padProbe(page);
      await touch('touchStart', B.act.x, B.act.y); await touch('touchEnd', B.act.x, B.act.y);
      const mid = await idleGet();
      await page.waitForTimeout(150);
      const midHidden = (await idleGet()).hidden;
      await touch('touchStart', B.act.x, B.act.y); await touch('touchEnd', B.act.x, B.act.y);
      await page.waitForTimeout(900);
      const rd = await padRead(page); const pn = await panelsNow(page);
      const after = await idleGet();
      if (!(mid.hidden === false && midHidden === true)) {
        note = `fade did not land between the taps (${mid.hidden} -> ${midHidden}, t ${before.t}/${delay})`;
        await idle(null); continue;
      }
      ok(rd.act === 0 && pn.length === 0,
        'STRADDLE [tap one live, the fade lands between them, tap two on the faded Enter]: no verb runs',
        `act ${rd.act} panels ${JSON.stringify(pn)} woke ${after.wakes} hidden ${after.hidden}`);
      done = true;
    } catch (e) { note = 'threw: ' + String(e).split('\n')[0].slice(0, 90); }
    await idle(null);
  }
  if (!done) mark(`STRADDLE: PROBE CANNOT DISCRIMINATE — ${tries} attempts, last reason: ${note}`);
}
await page.evaluate(() => { WALLY.debug.uiHide(); WALLY.debug.hideUI(false); });
await page.waitForTimeout(400);
mark('<< STRADDLE');

/* ===== 2. TWO THUMBS ON JUMP ===== */
mark('>> JMP2');
try {
  await toOpenGround();
  const lx = B.jump.x - 13, rx = B.jump.x + 13;
  await multi('touchStart', [pt(1, lx, B.jump.y)]);
  await page.waitForTimeout(80);
  const a = await clsDown(page, '.w-abtn.jump');
  await multi('touchStart', [pt(1, lx, B.jump.y), pt(2, rx, B.jump.y)]);
  await page.waitForTimeout(80);
  const ab = await clsDown(page, '.w-abtn.jump');
  await multi('touchEnd', [pt(2, rx, B.jump.y)]);          // the SECOND finger lifts
  await page.waitForTimeout(110);
  const afterSecondLift = await clsDown(page, '.w-abtn.jump');
  await multi('touchEnd', [pt(1, lx, B.jump.y)]);
  await page.waitForTimeout(150);
  const end = await clsDown(page, '.w-abtn.jump');
  ok(a === true && ab === true, 'JMP2-pre [both contacts landed on Jump and it read as held]', `A ${a} AB ${ab}`);
  ok(afterSecondLift === true,
    'JMP2 [two thumbs on Jump, the SECOND one lifts]: still held by the finger still on it',
    `after that lift held=${afterSecondLift}; after both ${end}`);
  ok(end === false, 'JMP2-state [and it lets go when the last finger does]');
} catch (e) { mark('!! JMP2 threw ' + String(e).slice(0, 100)); }
await page.waitForTimeout(1200);
mark('<< JMP2');

/* ===== 3. THE WINDOW INSIDE A CHORD ===== */
mark('>> CHWIN');
try {
  await toOpenGround();
  await M('mouseMoved', B.stick.x, B.stick.y);
  await M('mousePressed', B.stick.x, B.stick.y, 'left', 1);
  for (let j = 1; j <= 5; j++) { await M('mouseMoved', B.stick.x, B.stick.y - 14 * j, 'left', 1); await page.waitForTimeout(20); }
  const armed = await page.evaluate(() => +WALLY.debug.touchState().t.toFixed(2));
  await M('mousePressed', B.stick.x, B.stick.y - 70, 'right', 3);      // chord in
  await page.waitForTimeout(60);
  await M('mouseReleased', B.stick.x, B.stick.y - 70, 'left', 2);      // PRIMARY up -> pointermove
  await page.waitForTimeout(60);
  const insideT = await page.evaluate(() => +WALLY.debug.touchState().t.toFixed(2));
  /* and it FOLLOWS the mouse with no primary held */
  await M('mouseMoved', B.stick.x + 60, B.stick.y, 'none', 2);
  await page.waitForTimeout(80);
  const followed = await page.evaluate(() => WALLY.debug.touchState());
  await M('mouseReleased', B.stick.x + 60, B.stick.y, 'right', 0);     // the only pointerup
  await page.waitForTimeout(350);
  const afterT = await page.evaluate(() => +WALLY.debug.touchState().t.toFixed(2));
  ok(armed > 0.5, 'CHWIN-pre [the primary drag really deflected the stick]', `t ${armed}`);
  mark(`CHWIN-info: INSIDE the chord, primary already released, deflection ${insideT}; after a further move with no primary held, x ${(+followed.x).toFixed(2)} z ${(+followed.z).toFixed(2)} t ${(+followed.t).toFixed(2)}`);
  ok(afterT === 0, 'CHWIN [the secondary release still frees the stick]', `t ${afterT}`);
} catch (e) { mark('!! CHWIN threw ' + String(e).slice(0, 100)); }
mark('<< CHWIN');

mark(`\n${R.fails} FAIL(S)   pageerrors ${R.errs.length}`);
await R.close();
