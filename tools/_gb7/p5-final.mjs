/* GB7 PROBE 5 — everything still uncovered, each section fenced so one
   crash under load does not cost the rest. */
import { boot, padProbe, padRead, panelsNow, boxes } from '../_gb6/lib.mjs';
import { appendFileSync } from 'node:fs';
const LOG = process.env.GB7LOG || '/dev/null';
const mark = (s) => { try { appendFileSync(LOG, `[${new Date().toISOString().slice(11, 19)}] ${s}\n`); } catch {} console.log(s); };

mark('booting');
const R = await boot({ mobile: true });
mark('booted');
const { page, ok, touch, press, mousePress } = R;
const idle = (s) => page.evaluate((v) => WALLY.debug.idle(v), s);
const idleGet = () => page.evaluate(() => WALLY.debug.idle());
const layers = () => page.evaluate(() => WALLY.debug.uiLayers());
const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const toOpenGround = async () => {
  await page.evaluate((b) => { WALLY.debug.uiHide(); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {}); }, BOOT);
  await page.waitForTimeout(500);
};
const closeAll = async () => { await page.evaluate(() => WALLY.debug.uiHide()); await page.waitForTimeout(300); };
async function waitHidden(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const i = await idleGet(); if (i.hidden) return i; await page.waitForTimeout(200); }
  return idleGet();
}
async function fadeOut() {
  await toOpenGround();
  await page.evaluate(() => WALLY.debug.hideUI(true));
  await idle(0.4);
  const st = await waitHidden();
  await idle(90);
  return st;
}
await page.evaluate(() => WALLY.debug.hideUI(false));
await page.waitForTimeout(300);
const B = await boxes(page);
mark('boxes ' + JSON.stringify(B.act));

const section = async (name, fn) => {
  mark(`>> ${name}`);
  try { await fn(); } catch (e) { mark(`!! ${name} THREW: ${String(e).split('\n')[0].slice(0, 140)}`); }
  try { await closeAll(); await idle(null); await page.evaluate(() => WALLY.debug.hideUI(false)); await page.waitForTimeout(250); } catch {}
  mark(`<< ${name}`);
};

await section('SUSP', async () => {
  const st = await fadeOut();
  await page.evaluate(() => { WALLY.ctx.ui.dialogue({ speaker: 'Probe', text: ['ONE', 'TWO'] }); });
  await page.waitForTimeout(900);
  const during = await idleGet();
  ok(st.hidden === true && during.hidden === false && during.why === 'dialogue',
    'SUSP-1 [a conversation opening on a faded screen hands the pad back]',
    `before hidden ${st.hidden}, during ${JSON.stringify(during)}`);
  /* and Enter really works in it */
  await padProbe(page);
  await press(B.act.x, B.act.y, 55);
  await page.waitForTimeout(700);
  const rd = await padRead(page);
  const w = await page.evaluate(() => WALLY.debug.interact());
  ok(rd.act === 1 && w.path === 'dialogue',
    'SUSP-1b [and Enter advances the card the pad was handed back for]', JSON.stringify(w));
  await page.evaluate(() => WALLY.ctx.ui.closeAll());
  await page.waitForTimeout(600);
  const after = await idleGet();
  ok(after.t <= 0.35, 'SUSP-2 [the clock is handed back whole, not mid-count]', JSON.stringify(after));
});

await section('SHEET', async () => {
  const st = await fadeOut();
  await page.evaluate(() => WALLY.ctx.ui.openPhone());
  await page.waitForTimeout(900);
  const during = await idleGet();
  await padProbe(page);
  await touch('touchStart', 195, 300); await touch('touchEnd', 195, 300);
  await touch('touchStart', 195, 300); await touch('touchEnd', 195, 300);
  await page.waitForTimeout(600);
  const rd = await padRead(page);
  ok(st.hidden === true && during.hidden === false && (during.why === 'modal' || during.why === 'dialogue'),
    'SHEET-1 [a sheet opening on a faded screen also hands the pad back]', JSON.stringify(during));
  ok(rd.downs.length === 2 && rd.clicks.length >= 2,
    'SHEET-2 [with a sheet up the detector eats nothing]: both taps delivered',
    `downs ${rd.downs.length} clicks ${rd.clicks.length}`);
});

await section('SET', async () => {
  const st = await fadeOut();
  await page.evaluate(() => WALLY.debug.hideUI(false));
  await page.waitForTimeout(700);
  const after = await idleGet();
  ok(st.hidden === true && after.hidden === false && after.why === 'nohideui',
    'SET-1 [Hide UI switched off while faded]: everything comes back and says why', JSON.stringify(after));
  await padProbe(page);
  await press(B.sc[0].x, B.sc[0].y, 60);
  await page.waitForTimeout(800);
  const rd = await padRead(page); const pn = await panelsNow(page);
  ok(rd.sc >= 1 && pn.includes('phone'), 'SET-2 [and a real press works straight after]', `sc ${rd.sc} panels ${JSON.stringify(pn)}`);
});

await section('HOLD', async () => {
  /* THE TRAP: a press of 700 ms or more normally gets no compatibility
     click. The pad is pointer-driven, so duration must not matter. */
  for (const ms of [250, 700, 1500]) {
    await page.evaluate(() => { WALLY.debug.uiHide(); WALLY.debug.arrive('apartment', true); });
    await page.waitForTimeout(1300);
    await padProbe(page);
    await press(B.act.x, B.act.y, ms);
    await page.waitForTimeout(900);
    const rd = await padRead(page); const pn = await panelsNow(page);
    ok(rd.act === 1 && pn.includes('place'), `HOLD-${ms} [a ${ms} ms press on Enter]: still opens the door`,
      `act ${rd.act} panels ${JSON.stringify(pn)} clicks ${JSON.stringify(rd.clicks.map((c) => [c.target, c.detail]))}`);
    await closeAll();
  }
});

await section('ROT', async () => {
  const st = await fadeOut();
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(1100);
  const rot = await idleGet();
  ok(st.hidden === true && rot.hidden === true,
    'ROT-1 [rotation while faded]: they stay faded, nothing stranded', JSON.stringify(rot));
  await page.evaluate(() => WALLY.debug.hideUI(false));
  await page.waitForTimeout(900);
  const L2 = await layers();
  ok(L2.stick.x >= 0 && L2.stick.w > 0 && L2.act.x + L2.act.w <= 846,
    'ROT-2 [the pad re-measures into the landscape frame]',
    `stick ${L2.stick.x},${L2.stick.y}; act right ${L2.act.x + L2.act.w}/844`);
  const BL = await boxes(page);
  await padProbe(page);
  await press(BL.sc[0].x, BL.sc[0].y, 60);
  await page.waitForTimeout(800);
  const rd = await padRead(page); const pn = await panelsNow(page);
  ok(rd.sc >= 1 && pn.includes('phone'), 'ROT-3 [and a press lands on the re-measured box]',
    `sc ${rd.sc} panels ${JSON.stringify(pn)}`);
  await page.evaluate(() => WALLY.ctx.ui.closeAll());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
});

await section('CTXFADE', async () => {
  const st = await fadeOut();
  await padProbe(page);
  await mousePress(B.act.x, B.act.y, 'right', 70);
  await page.waitForTimeout(500);
  const rd = await padRead(page);
  const after = await idleGet();
  ok(st.hidden === true, 'CTXF-pre [the controls really were faded]');
  console.log(`CTXF-info: menus ${JSON.stringify(rd.menus)}  act ${rd.act} sc ${rd.sc}  hidden after ${after.hidden} wakes ${after.wakes}`);
  ok(rd.act === 0 && rd.sc === 0, 'CTXF [a right press on a FADED Enter fires nothing]',
    `act ${rd.act} sc ${rd.sc}`);
});

await section('MIDFOCUS', async () => {
  /* the focus hole, from the MIDDLE button and from a PEN BARREL */
  for (const [label, btn] of [['middle', 'middle'], ['right', 'right']]) {
    await toOpenGround();
    await page.evaluate(() => document.activeElement?.blur?.());
    await padProbe(page);
    await mousePress(B.sc[3].x, B.sc[3].y, btn, 70);      // Menu
    await page.waitForTimeout(350);
    const f = await page.evaluate(() => {
      const a = document.activeElement;
      return a && a.closest?.('.w-touch') ? (a.getAttribute('aria-label') || a.className) : null;
    });
    await page.keyboard.press('Space');
    await page.waitForTimeout(700);
    const rd = await padRead(page); const pn = await panelsNow(page);
    ok(f !== null, `FOCUS-pre [${label} press on Menu leaves it focused]`, String(f));
    ok(rd.sc === 0 && pn.length === 0,
      `FOCUS [${label} press on Menu, then Space]: must not hand Menu's verb to the keystroke`,
      `sc ${rd.sc} panels ${JSON.stringify(pn)} focus ${f}`);
    await closeAll();
  }
});

await section('BG', async () => {
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
    'BG-1 [three whole windows away in another app]: the controls did not fade, and the clock says why', JSON.stringify(away));
  ok(back.t <= 0.35, 'BG-2 [the window is handed back whole]', JSON.stringify(back));
});

await section('STRADDLE', async () => {
  let done = false, note = '', tries = 0;
  for (; tries < 6 && !done; tries++) {
    await toOpenGround();
    await page.evaluate(() => WALLY.debug.hideUI(true));
    await idle(0.55);
    await page.waitForTimeout(140);
    await padProbe(page);
    const before = await idleGet();
    if (before.hidden) { note = 'already hidden at tap one'; await idle(null); continue; }
    await touch('touchStart', B.act.x, B.act.y); await touch('touchEnd', B.act.x, B.act.y);
    const mid = await idleGet();
    await page.waitForTimeout(130);
    const midHidden = (await idleGet()).hidden;
    await touch('touchStart', B.act.x, B.act.y); await touch('touchEnd', B.act.x, B.act.y);
    await page.waitForTimeout(800);
    const rd = await padRead(page); const pn = await panelsNow(page);
    if (!(mid.hidden === false && midHidden === true)) {
      note = `fade did not land between the taps (${mid.hidden} -> ${midHidden})`; await idle(null); continue;
    }
    ok(rd.act === 0 && pn.length === 0,
      'STRADDLE [tap one live, the fade lands, tap two on the faded Enter]: no verb runs',
      `act ${rd.act} panels ${JSON.stringify(pn)}`);
    done = true;
  }
  if (!done) mark(`STRADDLE: PROBE CANNOT DISCRIMINATE — ${tries} attempts, last reason: ${note}`);
});

mark(`\n${R.fails} FAIL(S)   pageerrors ${R.errs.length}`);
await R.close();
