/* GB13-J — WHY THE STANDING SET NEVER REACHES ITS OWN NEW ASSERTIONS.
   touchtest.mjs died at PAD-41 on `WALLY.debug.kbFocus is not a
   function`, ~740 lines before KB-1..KB-13 — the assertions that ARE
   the rebuild. Is the hook missing at boot, or is it destroyed by
   something the suite does on the way there? */
import { boot, driver, loadNow } from './_gb13-lib.mjs';
const b = await boot();
const d = driver(b.page, b.cdp);
console.log('BOOT  ' + loadNow('at boot'));
const probe = (tag) => b.page.evaluate((t) => ({ tag: t,
  kbFocus: typeof WALLY.debug.kbFocus, kbSmuggle: typeof WALLY.debug.kbSmuggle,
  kb: typeof WALLY.debug.kb, padKeyboard: typeof WALLY.debug.padKeyboard,
  nKeys: Object.keys(WALLY.debug).length,
  kbKeys: Object.keys(WALLY.debug).filter(k => /^kb/i.test(k)) }), tag);
console.log('  at boot                :', JSON.stringify(await probe('boot')));

/* the suite's own PAD-40 sequence, which is what runs immediately before */
await b.page.evaluate(() => { WALLY.debug.hideUI(false); WALLY.ctx.ui.closeAll(); });
await d.wait(300);
console.log('  after hideUI/closeAll  :', JSON.stringify(await probe('a')));
await d.tabTo('Menu');
await d.thumb('Jump', 70, 300);
console.log('  after tab+thumb        :', JSON.stringify(await probe('b')));
const cv = await b.page.evaluate(() => { const c = WALLY.ctx.canvas.getBoundingClientRect();
  return { x: c.left + c.width/2, y: c.top + c.height/3 }; });
await d.touch('touchStart', cv.x, cv.y); await d.wait(60);
await d.touch('touchEnd', cv.x, cv.y); await d.wait(300);
console.log('  after a canvas drag    :', JSON.stringify(await probe('c')));
await b.page.evaluate(() => WALLY.debug.landscape(true)); await d.wait(400);
console.log('  after landscape(true)  :', JSON.stringify(await probe('d')));
await b.page.evaluate(() => WALLY.debug.landscape(false)); await d.wait(400);
console.log('  after landscape(false) :', JSON.stringify(await probe('e')));

/* and the one line the suite runs at 3918, on its own */
const r = await b.page.evaluate(() => {
  const el = [...document.querySelectorAll('.w-abtn')].find(e => e.getAttribute('aria-label') === 'Menu');
  document.activeElement?.blur?.();
  return { hasEl: !!el, typeofFn: typeof WALLY.debug.kbFocus,
    ret: typeof WALLY.debug.kbFocus === 'function' ? WALLY.debug.kbFocus('panel.restore', el) : 'MISSING',
    landed: document.activeElement === el };
});
console.log('  the suite line 3916-19 :', JSON.stringify(r));
console.log('  ERRORS: ' + (b.errs.length ? b.errs.join(' | ') : 'none'));
console.log('END   ' + loadNow('at end'));
await b.close();
