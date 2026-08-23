/* VJ 4: FORCE the trap past the switches and drive the way back with
   real CDP touches. */
import { chromium } from 'playwright-core';
import { serve, reporter } from './lib.mjs';
const { server, port } = await serve();
const R = reporter();
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 120000 });
await page.waitForTimeout(3500);
const cdp = await ctx.newCDPSession(page);
async function tap(x, y) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1, radiusX: 14, radiusY: 14, force: 1 }] });
  await page.waitForTimeout(70);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(450);
}

/* force the pair the switches now refuse */
await page.evaluate(() => { const u = WALLY.ctx.ui; u.closeAll(); u.setTouch(false); u.setHideUI(true); });
await page.waitForTimeout(700);
const state0 = await page.evaluate(() => ({ pad: WALLY.ctx.ui.touch.enabled, hide: WALLY.ctx.ui.hideUI }));
console.log('forced state:', JSON.stringify(state0));

const what = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('button, [role=button]')) {
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0 || r.width < 8 || r.height < 8) continue;
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    out.push({ text: (el.textContent || '').trim(), cls: el.className, cx: r.x + r.width / 2, cy: r.y + r.height / 2,
      w: Math.round(r.width), h: Math.round(r.height), reachable: !!(hit && el.contains(hit)) });
  }
  return out;
});
console.log('what is on screen:');
for (const o of what) console.log(`   ${o.reachable ? 'TAPPABLE' : 'covered '}  "${o.text}"  ${o.cls}  ${o.w}x${o.h} @ ${Math.round(o.cx)},${Math.round(o.cy)}`);
R.ok(what.some((o) => o.reachable), 'the forced trap still has SOMETHING tappable', String(what.filter((o) => o.reachable).length));
R.ok(what.every((o) => o.h >= 44 || !o.reachable), 'and every tappable thing clears the 44 px touch target',
  what.filter((o) => o.reachable).map((o) => `${o.text}=${o.w}x${o.h}`).join(' '));

const menu = what.find((o) => /Menu/.test(o.text) && o.reachable);
if (!menu) { R.ok(false, 'a Menu control is reachable'); } else {
  await tap(menu.cx, menu.cy);
  const open = await page.evaluate(() => WALLY.ctx.ui.panels);
  console.log('after tapping', JSON.stringify(menu.text), '->', JSON.stringify(open));
  R.ok(Array.isArray(open) && open.includes('pause'), 'a real CDP touch on it opens the pause menu — there IS a route back', JSON.stringify(open));
  /* and from there, get the HUD back */
  const back = await page.evaluate(async () => {
    const u = WALLY.ctx.ui; u.show('settings');
    await new Promise((r) => setTimeout(r, 700));
    const row = [...document.querySelectorAll('.w-kv')].find((e) => (e.querySelector('span') || {}).textContent === 'Touch controls');
    if (!row) return { err: 'no row' };
    const sw = row.querySelector('.w-switch'); const r = sw.getBoundingClientRect();
    row.scrollIntoView({ block: 'center' });
    await new Promise((rr) => setTimeout(rr, 400));
    const r2 = sw.getBoundingClientRect();
    return { cx: r2.x + r2.width / 2, cy: r2.y + r2.height / 2, on: sw.classList.contains('on') };
  });
  console.log('touch-controls switch at', JSON.stringify(back));
  if (back.cx) {
    await tap(back.cx, back.cy);
    const fin = await page.evaluate(() => ({ pad: WALLY.ctx.ui.touch.enabled, hide: WALLY.ctx.ui.hideUI }));
    console.log('after tapping Touch controls:', JSON.stringify(fin));
    R.ok(fin.pad && !fin.hide, 'and turning the pad back on restores the HUD too — fully recovered', JSON.stringify(fin));
  }
}

await browser.close(); server.close();
console.log(`\n${R.fails} failure(s).`);
