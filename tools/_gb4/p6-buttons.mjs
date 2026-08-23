/* P6 — the secondary-mouse-button finding, nailed down:
     · reached through the SETTINGS switch rather than ?touch=1, so it is
       not an artefact of the query flag
     · what the player actually gets: the verb AND the context menu
     · which controls are affected, and which already were before this
       change (Jump and the stick have always acted at pointerdown) */
import { boot, instrument, arm, stop, padGeom, toDoor, reporter, verbList, count } from './lib.mjs';

const R = reporter();
const B = await boot({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false, query: '?skipIntro' });
const { page, cdp } = B;
await instrument(page);
const closeAll = () => page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.hide('dialogue'); });

/* the layer comes up the way a player turns it on: the setting */
const on = await page.evaluate(() => {
  const st = WALLY.ctx.game.state;
  st.settings.touch = true;
  WALLY.ctx.ui.setTouch(true);
  return { setting: st.settings.touch, enabled: WALLY.debug.touchState().enabled };
});
R.ok(on.enabled, 'P6-0 the pad is up on a desktop through Settings > Touch controls', JSON.stringify(on));

/* record contextmenu too — a right press does both things at once */
await page.evaluate(() => {
  window.__ctx = 0;
  addEventListener('contextmenu', () => { window.__ctx++; }, true);
});

const M = {
  async move(x, y) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }); },
  async press(x, y, button, hold = 120) {
    const bit = button === 'left' ? 1 : button === 'right' ? 2 : 4;
    await this.move(x, y);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: bit, clickCount: 1 });
    await page.waitForTimeout(hold);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
  },
};

await toDoor(page); await closeAll(); await page.waitForTimeout(600);
const g = await padGeom(page);

for (const btn of ['right', 'middle']) {
  await toDoor(page); await closeAll(); await page.waitForTimeout(500);
  await page.evaluate(() => { window.__ctx = 0; });
  await arm(page);
  await M.press(g.act.cx, g.act.cy, btn);
  await page.waitForTimeout(900);
  const r = await stop(page);
  const menus = await page.evaluate(() => window.__ctx);
  const clicks = r.log.filter(e => e.ty === 'click').length;
  R.ok(count(r, 'padpress') === 0,
    `P6-1${btn === 'right' ? 'a' : 'b'} a ${btn}-button press on Enter fires nothing`,
    `padpress ${count(r, 'padpress')} verbs ${verbList(r) || 'none'} panels ${JSON.stringify(r.panels)} | clicks in the sequence: ${clicks} | contextmenu events: ${menus}`);
  await closeAll(); await page.waitForTimeout(400);
}

/* which controls answer a right press */
const table = [];
for (const [name, pt] of [['Enter', [g.act.cx, g.act.cy]], ['Jump', [g.jump.cx, g.jump.cy]],
  ['Phone', [g.phone.cx, g.phone.cy]], ['Places', [g.places.cx, g.places.cy]],
  ['Desk', [g.desk.cx, g.desk.cy]], ['Menu', [g.menu.cx, g.menu.cy]]]) {
  await toDoor(page); await closeAll(); await page.waitForTimeout(450);
  await arm(page);
  await M.press(pt[0], pt[1], 'right');
  await page.waitForTimeout(800);
  const r = await stop(page);
  const fired = name === 'Jump' ? (r.vy > 0.6) : (count(r, 'padpress') > 0);
  table.push(`${name}:${fired ? 'FIRES' : 'no'}`);
  await closeAll(); await page.waitForTimeout(350);
}
console.log('   right-press by control:', table.join('  '));

/* and the thumbstick: does a right-drag walk him? */
await closeAll(); await page.waitForTimeout(400);
const zc = (await padGeom(page)).zone;
await arm(page);
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: zc.cx, y: zc.cy, button: 'none', buttons: 0 });
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: zc.cx, y: zc.cy, button: 'right', buttons: 2, clickCount: 1 });
await page.waitForTimeout(60);
for (let i = 1; i <= 5; i++) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: zc.cx, y: zc.cy - i * 12, button: 'right', buttons: 2 }); await page.waitForTimeout(60); }
const t = await page.evaluate(() => WALLY.debug.touchState());
const sp = await page.evaluate(() => { const c = WALLY.ctx.wally.controller; const v = c && (c.velocity || c.vel); return v ? +Math.hypot(v.x, v.z).toFixed(2) : null; });
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: zc.cx, y: zc.cy - 60, button: 'right', buttons: 0, clickCount: 1 });
await page.waitForTimeout(500);
const r2 = await stop(page);
R.ok(t.t === 0,
  'P6-2 a right-button drag on the thumbstick does not deflect it',
  `stick t ${typeof t.t === 'number' ? t.t.toFixed(2) : t.t}, speed ${sp}, moved ${r2.moved} m`);

console.log(`\n${R.fails} failure(s). page errors: ${B.errs.length}`, B.errs.slice(0, 6).join(' | '));
await B.close();
