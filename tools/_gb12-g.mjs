/* _gb12-g.mjs — the same rows against the RIGHT control and the RIGHT
   key. Jump fires on CONTACT by design, so slide-off/cancel/off-screen
   have to be measured on a bindPress button (Menu, which fires at
   pointerup inside its own rect). And the interact key is E on a
   keyboard, 'Enter' only as the pad button's label. */
import { boot, driver, load, cpus } from './_gb12-lib.mjs';
console.log('LOAD at boot:', load(), `(${cpus()} cpus)`);
const B = await boot(); const d = driver(B.page, B.cdp);
let fails = 0, N = 0;
const ok = (c, name, detail = '') => { N++; if (!c) fails++;
  console.log(`${c ? 'FINE   ' : 'BROKEN '} ${name}${detail ? '\n           ' + detail : ''}`); return c; };
const nPan = () => B.page.evaluate(() => WALLY.ctx.ui.panels.length);
const dlgPage = () => B.page.evaluate(() => (document.querySelector('.w-dlg-tx')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40));

console.log('\n──── SLIDES, CANCEL, OFF-SCREEN RELEASE — on a PRESS button (Menu) ────');
{
  const m = await d.padAt('Menu');
  const run = async (fn) => { await d.reset(); await d.wait(250);
    const p0 = await nPan(); await fn(); await d.wait(500); const p1 = await nPan();
    await d.reset(); return { p0, p1, fired: p1 > p0 }; };
  const clean = await run(async () => { await d.touch('touchStart', m.x, m.y); await d.wait(70); await d.touch('touchEnd', m.x, m.y); });
  ok(clean.fired, 'BRANCH CHECK: a clean press of Menu opens the sheet — every row below can see a firing', JSON.stringify(clean));
  const off = await run(async () => { await d.touch('touchStart', m.x, m.y); await d.wait(60);
    await d.touch('touchMove', m.x, m.y - 220); await d.wait(60); await d.touch('touchEnd', m.x, m.y - 220); });
  ok(!off.fired, 'a finger that slides OFF Menu before lifting does not fire it', JSON.stringify(off));
  const on = await run(async () => { await d.touch('touchStart', m.x, m.y - 220); await d.wait(60);
    await d.touch('touchMove', m.x, m.y); await d.wait(60); await d.touch('touchEnd', m.x, m.y); });
  ok(!on.fired, 'a finger that slides ON to Menu from outside does not fire it', JSON.stringify(on));
  const can = await run(async () => { await d.touch('touchStart', m.x, m.y); await d.wait(60);
    await B.cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); });
  ok(!can.fired, 'a cancelled contact does not fire the button', JSON.stringify(can));
  const offscr = await run(async () => { await d.touch('touchStart', m.x, m.y); await d.wait(60);
    await d.touch('touchMove', m.x, 930); await d.wait(40); await d.touch('touchEnd', m.x, 930); });
  ok(!offscr.fired, 'a release off the bottom of the screen does not fire the button', JSON.stringify(offscr));
}

console.log('\n──── THREE RAPID INTERACTS ADVANCE A DIALOGUE EXACTLY THREE PAGES ────');
{
  const PAGES = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'];
  const idx = (s) => PAGES.findIndex(p => s.includes(p));
  for (const route of ['KeyE', 'Enter', 'padEnter']) {
    await d.reset(); await d.wait(250);
    await B.page.evaluate((p) => WALLY.debug.ui('dialogue', { speaker: 'X', portrait: 'wally', text: p }), PAGES);
    await d.wait(1400);                                    // page 1 finishes typing
    const p0 = await dlgPage();
    if (route === 'padEnter') {
      const e = await d.padAt('Enter or talk');
      for (let i = 0; i < 3; i++) { await d.touch('touchStart', e.x, e.y); await d.wait(45);
        await d.touch('touchEnd', e.x, e.y); await d.wait(120); }
    } else for (let i = 0; i < 3; i++) { await d.key(route, 20); await d.wait(120); }
    await d.wait(700);
    const p1 = await dlgPage();
    console.log(`  ${route.padEnd(9)} "${p0}" (page ${idx(p0)}) -> "${p1}" (page ${idx(p1)})   advanced ${idx(p1) - idx(p0)}`);
    if (route === 'KeyE' || route === 'padEnter')
      ok(idx(p0) === 0 && idx(p1) - idx(p0) === 3, `three rapid ${route === 'KeyE' ? 'E keys' : 'thumb taps on the pad Enter'} advance exactly three pages`,
        `"${p0}" -> "${p1}"`);
    await B.page.evaluate(() => WALLY.ctx.ui.closeAll()); await d.wait(400);
  }
}
console.log(`\n${fails} BROKEN of ${N} asserted`);
console.log('errs:', JSON.stringify(B.errs));
console.log('LOAD at end:', load());
await B.close();
