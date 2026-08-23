/* Why did a real touch on the .w-hint row do nothing? */
import { chromium } from 'playwright-core';
import { serve } from './lib.mjs';
const { server, port } = await serve();
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load' , timeout: 120000 });
await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 120000 });
await page.waitForTimeout(3500);
const cdp = await ctx.newCDPSession(page);
const tap = async (x, y) => {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1, radiusX: 14, radiusY: 14, force: 1 }] });
  await page.waitForTimeout(70);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(500);
};

for (const scenario of ['pad ON, hud shown', 'pad OFF, hud shown', 'pad OFF + hide UI (the trap)']) {
  await page.evaluate((s) => {
    const u = WALLY.ctx.ui; u.closeAll();
    u.setTouch(s === 'pad ON, hud shown');
    u.setHideUI(s === 'pad OFF + hide UI (the trap)');
    window.__log = [];
    const b = [...document.querySelectorAll('.w-hint')].pop();
    if (b && !b.__spy) { b.__spy = 1; for (const t of ['pointerdown', 'touchstart', 'click']) b.addEventListener(t, (e) => window.__log.push(t + (e.defaultPrevented ? '(prevented)' : '')), true); }
  }, scenario);
  await page.waitForTimeout(700);
  const r = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.w-hint')].pop();
    if (!b) return null;
    const q = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    const par = getComputedStyle(b.parentElement);
    return { text: b.textContent, cx: q.x + q.width / 2, cy: q.y + q.height / 2, w: q.width, h: q.height,
      pe: cs.pointerEvents, parentPE: par.pointerEvents, parentDisplay: par.display, parentOp: par.opacity,
      hit: (() => { const e = document.elementFromPoint(q.x + q.width / 2, q.y + q.height / 2); return e ? e.className : null; })() };
  });
  if (!r) { console.log(`${scenario}: NO .w-hint`); continue; }
  await tap(r.cx, r.cy);
  const after = await page.evaluate(() => ({ panels: WALLY.ctx.ui.panels, log: window.__log }));
  console.log(`\n${scenario}`);
  console.log('   hint:', JSON.stringify(r));
  console.log('   after a real touch ->', JSON.stringify(after));
  /* and the same button by a scripted click, for the control */
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); [...document.querySelectorAll('.w-hint')].pop().click(); });
  await page.waitForTimeout(500);
  console.log('   after a scripted .click() ->', JSON.stringify(await page.evaluate(() => WALLY.ctx.ui.panels)));
  await page.evaluate(() => WALLY.ctx.ui.closeAll());
}

/* and: does the Touch-controls switch show the truth? */
const sw = await page.evaluate(async () => {
  const u = WALLY.ctx.ui; u.closeAll(); u.setTouch(false);
  await new Promise((r) => setTimeout(r, 400));
  u.show('settings');
  await new Promise((r) => setTimeout(r, 700));
  const row = [...document.querySelectorAll('.w-kv')].find((e) => (e.querySelector('span') || {}).textContent === 'Touch controls');
  return { padReally: u.touch.enabled, switchShows: row.querySelector('.w-switch').classList.contains('on'), setting: WALLY.ctx.game.state.settings.touch };
});
console.log('\nTouch-controls switch vs reality:', JSON.stringify(sw));

await browser.close(); server.close();
