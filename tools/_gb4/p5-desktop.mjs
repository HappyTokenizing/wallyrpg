/* P5 — THE SAME PAD UNDER A MOUSE. A hybrid can have this layer up
   (Settings > Touch controls, ?touch=1, or one genuine touchstart) and
   then drive it with a mouse, where pointerdown/pointerup fire and
   NOTHING is ever cancelled by a pan — which is the only place the
   inside-the-rect release test can actually be exercised, because on a
   real finger the platform cancels the contact first. */
import { boot, instrument, arm, stop, padGeom, toDoor, reporter, verbList, count } from './lib.mjs';

const R = reporter();
const B = await boot({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false, query: '?skipIntro&touch=1' });
const { page, cdp } = B;
await instrument(page);
const closeAll = () => page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.hide('dialogue'); });

const M = {
  async move(x, y, buttons = 0) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: buttons ? 'left' : 'none', buttons }); },
  async down(x, y, button = 'left') {
    const bit = button === 'left' ? 1 : button === 'right' ? 2 : 4;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: bit, clickCount: 1 });
  },
  async up(x, y, button = 'left') {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
  },
  async click(x, y, button = 'left', hold = 120) { await this.move(x, y); await this.down(x, y, button); await page.waitForTimeout(hold); await this.up(x, y, button); },
};
const tape = (r) => r.log.filter(e => e.ty !== 'pointermove')
  .map(e => `${e.ty}${e.detail ? '(d' + e.detail + ')' : ''}->${e.tgt.split('.').slice(0, 2).join('.')}`).join(' ');

const en = await page.evaluate(() => WALLY.debug.touchState());
R.ok(en.enabled, 'P5-0 ?touch=1 puts the pad up on a desktop (the hybrid case)', JSON.stringify(en));

await toDoor(page); await closeAll(); await page.waitForTimeout(600);
let g = await padGeom(page);
console.log('desktop pad geometry:', JSON.stringify({ act: g.act, phone: g.phone }));

/* ---- 1. an ordinary left click ---- */
await arm(page);
await M.click(g.act.cx, g.act.cy);
await page.waitForTimeout(900);
let r = await stop(page);
console.log('   left-click tape:', tape(r));
R.ok(count(r, 'padpress') === 1 && count(r, 'interact') === 1 && r.panels.length === 1,
  'P5-1 a left mouse click on Enter fires exactly once and opens the door',
  `padpress ${count(r, 'padpress')} verbs ${verbList(r)} panels ${JSON.stringify(r.panels)}`);
const survived = r.bub.filter(b => b.ty === 'click');
R.ok(survived.length === 0, 'P5-1b ...and its click is swallowed, so the sheet it opened is not dismissed', JSON.stringify(survived));
await closeAll(); await page.waitForTimeout(500);

/* ---- 2. press on the button, release OFF it ---- */
await toDoor(page); await page.waitForTimeout(400);
await arm(page);
await M.move(g.act.cx, g.act.cy);
await M.down(g.act.cx, g.act.cy);
await page.waitForTimeout(60);
await M.move(g.act.cx - 260, g.act.cy - 180, 1);
await page.waitForTimeout(60);
await M.up(g.act.cx - 260, g.act.cy - 180);
await page.waitForTimeout(900);
r = await stop(page);
console.log('   slide-off tape:', tape(r));
R.ok(count(r, 'padpress') === 0 && r.panels.length === 0,
  'P5-2 press on Enter, release 300 px away -> refused (the release-inside test, on the one input that can reach it)',
  `verbs ${verbList(r) || 'none'} panels ${JSON.stringify(r.panels)}`);

/* ---- 3. press OFF the button, release on it ---- */
await toDoor(page); await page.waitForTimeout(400);
await arm(page);
await M.move(g.act.cx - 260, g.act.cy - 180);
await M.down(g.act.cx - 260, g.act.cy - 180);
await page.waitForTimeout(60);
await M.move(g.act.cx, g.act.cy, 1);
await page.waitForTimeout(60);
await M.up(g.act.cx, g.act.cy);
await page.waitForTimeout(900);
r = await stop(page);
console.log('   slide-on tape:', tape(r));
R.ok(count(r, 'padpress') === 0 && r.panels.length === 0,
  'P5-3 press off the button, release on Enter -> refused',
  `verbs ${verbList(r) || 'none'} panels ${JSON.stringify(r.panels)}`);

/* ---- 4. the SECONDARY buttons, which never produced a click at all ---- */
for (const [btn, name] of [['right', 'right'], ['middle', 'middle']]) {
  await toDoor(page); await closeAll(); await page.waitForTimeout(500);
  await arm(page);
  await M.click(g.act.cx, g.act.cy, btn);
  await page.waitForTimeout(900);
  r = await stop(page);
  console.log(`   ${name}-button tape:`, tape(r));
  R.ok(count(r, 'padpress') === 0 && r.panels.length === 0,
    `P5-4${name === 'right' ? 'a' : 'b'} a ${name}-button press on Enter fires nothing (a click never fired for it)`,
    `padpress ${count(r, 'padpress')} verbs ${verbList(r) || 'none'} panels ${JSON.stringify(r.panels)}`);
  await closeAll(); await page.waitForTimeout(400);
}

/* ---- 5. the same on a shortcut, and on Jump ---- */
await toDoor(page); await closeAll(); await page.waitForTimeout(400);
g = await padGeom(page);
await arm(page);
await M.click(g.phone.cx, g.phone.cy, 'right');
await page.waitForTimeout(800);
r = await stop(page);
R.ok(count(r, 'padpress') === 0,
  'P5-5 a right-button press on Phone fires nothing',
  `verbs ${verbList(r) || 'none'} panels ${JSON.stringify(r.panels)}`);
await closeAll(); await page.waitForTimeout(400);
await arm(page);
await M.click(g.jump.cx, g.jump.cy, 'right');
await page.waitForTimeout(900);
r = await stop(page);
R.ok(r.vy < 0.6, 'P5-6 a right-button press on Jump does not jump', `peak vy ${r.vy.toFixed(2)}`);

/* ---- 7. a mouse double click on Enter ---- */
await toDoor(page); await closeAll(); await page.waitForTimeout(500);
await arm(page);
await M.click(g.act.cx, g.act.cy, 'left', 60);
await page.waitForTimeout(60);
await M.click(g.act.cx, g.act.cy, 'left', 60);
await page.waitForTimeout(900);
r = await stop(page);
console.log('   double-click tape:', tape(r));
R.ok(r.panels.length >= 1,
  'P5-7 a fast mouse double click on Enter does not leave the screen empty (press one is not undone by a stray click)',
  `padpress ${count(r, 'padpress')} interact ${count(r, 'interact')} panels ${JSON.stringify(r.panels)}`);
await closeAll();

/* ---- 8. the plain desktop, with no touch flag at all ---- */
const ctx2 = await B.browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false, deviceScaleFactor: 1 });
const p2 = await ctx2.newPage();
await p2.goto(`http://127.0.0.1:${B.port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 120000 });
await p2.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 120000 });
await p2.waitForTimeout(3000);
const d = await p2.evaluate(() => { WALLY.debug.hideUI(true); return { touch: WALLY.debug.touchState(), idle: WALLY.debug.idle(), pad: !!document.querySelector('.w-abtn.act') }; });
await p2.waitForTimeout(2500);
const d2 = await p2.evaluate(() => WALLY.debug.idle());
R.ok(d.touch.enabled === false && d.idle.armed === false && d2.armed === false && d2.hidden === false,
  'P5-8 a plain desktop gets no pad and stage two never arms, even with Hide UI on',
  `enabled ${d.touch.enabled} armed ${d2.armed} why ${d2.why}`);

console.log(`\n${R.fails} failure(s). page errors: ${B.errs.length}`, B.errs.slice(0, 6).join(' | '));
await B.close();
