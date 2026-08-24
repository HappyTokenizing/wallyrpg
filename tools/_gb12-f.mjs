/* _gb12-f.mjs — the rows _gb12-e ran BLIND, re-measured on discriminators
   that actually move: the bus event `phys:jump` for the jump verb, and
   .w-dlg-tx for the dialogue page. Real dispatched touches and keys. */
import { boot, driver, load, cpus } from './_gb12-lib.mjs';
console.log('LOAD at boot:', load(), `(${cpus()} cpus)`);
const B = await boot(); const d = driver(B.page, B.cdp);
let fails = 0, N = 0;
const ok = (c, name, detail = '') => { N++; if (!c) fails++;
  console.log(`${c ? 'FINE   ' : 'BROKEN '} ${name}${detail ? '\n           ' + detail : ''}`); return c; };
await B.page.evaluate(() => { window.__J = 0; WALLY.ctx.bus.on('phys:jump', () => { window.__J++; }); });
const jumps = () => B.page.evaluate(() => window.__J);
const padKb = () => B.page.evaluate(() => WALLY.debug.padKeyboard());
const nPan = () => B.page.evaluate(() => WALLY.ctx.ui.panels.length);
const dlgPage = () => B.page.evaluate(() => (document.querySelector('.w-dlg-tx')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40));

console.log('\n──── tab, touch, tab, SPACE — WHAT ACTUALLY FIRED ────');
for (const target of ['Menu', 'Jump']) {
  await d.reset(); await d.wait(250);
  await d.tabTo('Menu'); await d.thumb('Jump', 110, 300);
  let f = null;
  for (let i = 0; i < 9; i++) { await d.key('Tab', 15); await d.wait(35); f = await d.focusNow();
    if (f.where === 'pad' && f.label === target) break; }
  const kb = await padKb(); const p0 = await nPan(); const j0 = await jumps();
  await d.key('Space', 25); await d.wait(450);
  const p1 = await nPan(); const j1 = await jumps();
  ok(f?.label === target && kb.padTakesSpace === true && (target === 'Menu' ? p1 > p0 : j1 > j0),
    `tab, touch, tab to ${target}, Space: that button's own verb runs`,
    `${JSON.stringify(kb)} ring=${f?.where}/${f?.label} panels ${p0}->${p1} phys:jump ${j0}->${j1}`);
}

console.log('\n──── THREE RAPID ENTERS ADVANCE A DIALOGUE EXACTLY THREE PAGES ────');
{
  await d.reset(); await d.wait(200);
  const PAGES = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'];
  await B.page.evaluate((p) => WALLY.debug.ui('dialogue', { speaker: 'X', portrait: 'wally', text: p }), PAGES);
  await d.wait(1200);
  const p0 = await dlgPage();
  for (let i = 0; i < 3; i++) { await d.key('Enter', 20); await d.wait(110); }
  await d.wait(600);
  const p1 = await dlgPage();
  const idx = (s) => PAGES.findIndex(p => s.includes(p));
  ok(idx(p0) === 0 && idx(p1) === 3, 'three rapid Enters advance a dialogue exactly three pages',
    `"${p0}" (page ${idx(p0)}) -> "${p1}" (page ${idx(p1)})`);
  await B.page.evaluate(() => WALLY.ctx.ui.closeAll()); await d.wait(400);
}

console.log('\n──── SLIDES, CANCEL, OFF-SCREEN RELEASE ────');
{
  const jp = await d.padAt('Jump');
  const run = async (fn) => { await d.reset(); await d.wait(250);
    const j0 = await jumps(); await fn(); await d.wait(450); const j1 = await jumps();
    return { j0, j1, fired: j1 > j0 }; };
  const clean = await run(async () => { await d.touch('touchStart', jp.x, jp.y); await d.wait(70); await d.touch('touchEnd', jp.x, jp.y); });
  ok(clean.fired, 'BRANCH CHECK: a clean press of Jump fires the jump verb — everything below can see it', JSON.stringify(clean));
  const off = await run(async () => { await d.touch('touchStart', jp.x, jp.y); await d.wait(60);
    await d.touch('touchMove', jp.x, jp.y - 200); await d.wait(60); await d.touch('touchEnd', jp.x, jp.y - 200); });
  ok(!off.fired, 'a finger that slides OFF Jump before lifting does not fire it', JSON.stringify(off));
  const on = await run(async () => { await d.touch('touchStart', jp.x, jp.y - 200); await d.wait(60);
    await d.touch('touchMove', jp.x, jp.y); await d.wait(60); await d.touch('touchEnd', jp.x, jp.y); });
  ok(!on.fired, 'a finger that slides ON to Jump from outside does not fire it', JSON.stringify(on));
  const can = await run(async () => { await d.touch('touchStart', jp.x, jp.y); await d.wait(60);
    await B.cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); });
  ok(!can.fired, 'a cancelled contact does not fire the button', JSON.stringify(can));
  const offscr = await run(async () => { await d.touch('touchStart', jp.x, jp.y); await d.wait(60);
    await d.touch('touchMove', jp.x, 920); await d.wait(40); await d.touch('touchEnd', jp.x, 920); });
  ok(!offscr.fired, 'a release off the bottom of the screen does not fire the button', JSON.stringify(offscr));
  const rapid = await run(async () => { for (let i = 0; i < 3; i++) {
    await d.touch('touchStart', jp.x, jp.y); await d.wait(40); await d.touch('touchEnd', jp.x, jp.y); await d.wait(60); } });
  console.log(`  rapid repeats: three fast taps on Jump produced ${rapid.j1 - rapid.j0} jump events`);
}
console.log(`\n${fails} BROKEN of ${N} asserted`);
console.log('errs:', JSON.stringify(B.errs));
console.log('LOAD at end:', load());
await B.close();
