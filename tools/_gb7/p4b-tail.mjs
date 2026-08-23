/* GB7 PROBE 4b — the tail of the fade list that round six never reached:
   a dialogue restoring the pad, a sheet delivering both taps, background
   time not banked, Settings while faded, rotation. Plus a retry-until-
   valid STRADDLE, which round six could not set up. */
import { boot, padProbe, padRead, panelsNow, boxes } from '../_gb6/lib.mjs';
import { appendFileSync } from 'node:fs';
const LOG = process.env.GB7LOG || '/dev/null';
const mark = (s) => { try { appendFileSync(LOG, `[${new Date().toISOString().slice(11,19)}] ${s}\n`); } catch {} console.log(s); };
mark('booting');
const t0 = Date.now();
const R = await boot({ mobile: true });
mark(`booted in ${Date.now() - t0} ms`);
const { page, ok, touch, press } = R;
const idle = (sec) => page.evaluate((s) => WALLY.debug.idle(s), sec);
const idleGet = () => page.evaluate(() => WALLY.debug.idle());
const layers = () => page.evaluate(() => WALLY.debug.uiLayers());
const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const toOpenGround = async () => {
  await page.evaluate((b) => { WALLY.debug.uiHide(); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {}); }, BOOT);
  await page.waitForTimeout(600);
};
const closeAll = async () => { await page.evaluate(() => WALLY.debug.uiHide()); await page.waitForTimeout(300); };
async function waitHidden(ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const i = await idleGet(); if (i.hidden) return i; await page.waitForTimeout(200); }
  return idleGet();
}
async function fadeOut(shortSec = 0.4, parkSec = 90) {
  await toOpenGround();
  await page.evaluate(() => WALLY.debug.hideUI(true));
  await idle(shortSec);
  const st = await waitHidden();
  await idle(parkSec);
  return st;
}
await page.evaluate(() => WALLY.debug.hideUI(false));
await page.waitForTimeout(400);
const B = await boxes(page);

mark('--- entering section');
/* ============ 5. A DIALOGUE RESTORES THE PAD ============ */
{
  const st = await fadeOut();
  await page.evaluate(() => WALLY.ctx.ui.dialogue({ speaker: 'Probe', text: ['ONE', 'TWO'] }));
  await page.waitForTimeout(900);
  const during = await idleGet();
  ok(st.hidden === true && during.hidden === false && during.why === 'dialogue',
    'SUSP-1 [a conversation opening on a faded screen hands the pad back]',
    `before ${st.hidden} during ${JSON.stringify(during)}`);
  await closeAll();
  await page.waitForTimeout(500);
  const after = await idleGet();
  ok(after.t === 0, 'SUSP-2 [and the clock is handed back whole, not mid-count]', JSON.stringify(after));
  await idle(null);
}
{
  const st = await fadeOut();
  await page.evaluate(() => WALLY.ctx.ui.openPhone());
  await page.waitForTimeout(900);
  const during = await idleGet();
  await padProbe(page);
  await touch('touchStart', 195, 300); await touch('touchEnd', 195, 300);
  await touch('touchStart', 195, 300); await touch('touchEnd', 195, 300);
  await page.waitForTimeout(600);
  const rd = await padRead(page);
  ok(during.hidden === false && (during.why === 'modal' || during.why === 'dialogue'),
    'SHEET-1 [a sheet also hands the pad back]', JSON.stringify(during));
  ok(rd.downs.length === 2 && rd.clicks.length >= 2,
    'SHEET-2 [with a sheet up the detector eats nothing]: both taps are delivered',
    `downs ${rd.downs.length} clicks ${rd.clicks.length}`);
  await closeAll();
  await idle(null);
}

mark('--- entering section');
/* ============ 6. BACKGROUND TIME IS NOT IDLE TIME ============ */
{
  await toOpenGround();
  await page.evaluate(() => WALLY.debug.hideUI(true));
  await idle(3);
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const reallyHidden = await page.evaluate(() => document.hidden);
  await page.waitForTimeout(9000);
  const away = await idleGet();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(400);
  const back = await idleGet();
  await page.evaluate(() => { delete document.hidden; delete document.visibilityState; });
  ok(reallyHidden === true, 'BG-pre [the page really reported itself hidden]');
  ok(away.hidden === false && away.why === 'background',
    'BG-1 [three whole windows in another app]: the controls did not fade and the clock says why', JSON.stringify(away));
  ok(back.t <= 0.35, 'BG-2 [the window is handed back whole]', JSON.stringify(back));
  await idle(null);
}

mark('--- entering section');
/* ============ 7. SETTINGS AND ROTATION WHILE FADED ============ */
{
  const st = await fadeOut();
  await page.evaluate(() => WALLY.debug.hideUI(false));
  await page.waitForTimeout(600);
  const after = await idleGet();
  ok(st.hidden === true && after.hidden === false && after.why === 'nohideui',
    'SET-1 [turning Hide UI off while faded]: everything comes straight back and says why', JSON.stringify(after));
  /* and the controls are really pressable again, not merely flagged live */
  await padProbe(page);
  await press(B.sc[0].x, B.sc[0].y, 60);
  await page.waitForTimeout(700);
  const rd = await padRead(page); const pn = await panelsNow(page);
  ok(rd.sc >= 1 && pn.includes('phone'),
    'SET-2 [and a real press works straight after]: Phone opens', `sc ${rd.sc} panels ${JSON.stringify(pn)}`);
  await closeAll();
  await idle(null);
}
{
  const st = await fadeOut();
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(1000);
  const rot = await idleGet();
  ok(st.hidden === true && rot.hidden === true,
    'ROT-1 [a rotation while the controls are faded]: they stay faded, nothing is stranded', JSON.stringify(rot));
  await page.evaluate(() => WALLY.debug.hideUI(false));
  await page.waitForTimeout(900);
  const L2 = await layers();
  ok(L2.stick.x >= 0 && L2.stick.w > 0 && L2.act.x + L2.act.w <= 844 + 2,
    'ROT-2 [and the pad re-measures into the landscape frame]',
    `stick ${L2.stick.x},${L2.stick.y} ${L2.stick.w}x${L2.stick.h}; act right ${L2.act.x + L2.act.w}/844`);
  /* and it still WORKS in landscape */
  const BL = await boxes(page);
  await padProbe(page);
  await press(BL.sc[0].x, BL.sc[0].y, 60);
  await page.waitForTimeout(700);
  const rd = await padRead(page); const pn = await panelsNow(page);
  ok(rd.sc >= 1 && pn.includes('phone'), 'ROT-3 [and a press lands on the re-measured box]',
    `sc ${rd.sc} panels ${JSON.stringify(pn)} box ${JSON.stringify(BL.sc[0])}`);
  await closeAll();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  await idle(null);
}

mark('--- entering section');
/* ============ 8. STRADDLE, retried until the harness really lands it ====== */
{
  let done = false, tries = 0, note = '';
  for (; tries < 8 && !done; tries++) {
    await toOpenGround();
    await page.evaluate(() => WALLY.debug.hideUI(true));
    await idle(0.55);
    await page.waitForTimeout(120);
    /* tap one BEFORE the fade, tap two AFTER it, inside TAP_GAP (300 ms) */
    await padProbe(page);
    const before = await idleGet();
    if (before.hidden) { note = 'already hidden at tap one'; continue; }
    await touch('touchStart', B.act.x, B.act.y); await touch('touchEnd', B.act.x, B.act.y);
    const mid = await idleGet();
    await page.waitForTimeout(120);
    const midHidden = (await idleGet()).hidden;
    await touch('touchStart', B.act.x, B.act.y); await touch('touchEnd', B.act.x, B.act.y);
    await page.waitForTimeout(800);
    const rd = await padRead(page); const pn = await panelsNow(page);
    const after = await idleGet();
    if (!(mid.hidden === false && midHidden === true)) { note = `fade did not land between the taps (mid ${mid.hidden} -> ${midHidden})`; continue; }
    ok(rd.act === 0 && pn.length === 0,
      'STRADDLE [tap one live, fade, tap two on the faded Enter]: no verb runs',
      `act ${rd.act} panels ${JSON.stringify(pn)} hidden after ${after.hidden} wakes ${after.wakes}`);
    done = true;
    await closeAll();
  }
  if (!done) console.log(`STRADDLE: PROBE CANNOT DISCRIMINATE — ${tries} attempts, last reason: ${note}`);
  await idle(null);
}

console.log(`\n${R.fails} FAIL(S)   pageerrors ${R.errs.length}`);
await R.close();
