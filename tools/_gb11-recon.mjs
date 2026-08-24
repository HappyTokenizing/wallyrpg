/* _gb11-recon.mjs — what is actually on the page, measured, before any claim. */
import { boot, driver, load, cpus, installLedger, ledger } from './_gb11-lib.mjs';
console.log('LOAD at boot:', load(), `(${cpus()} cpus)`);
const B = await boot();
const d = driver(B.page, B.cdp);
await installLedger(B.page);

console.log('\n== pad controls ==');
console.log(JSON.stringify(await B.page.evaluate(() => {
  const root = document.querySelector('.w-touch');
  const btns = [...document.querySelectorAll('.w-abtn')].map(b => ({
    lab: b.getAttribute('aria-label'), cls: b.className, tag: b.tagName,
    r: (() => { const r = b.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })(),
  }));
  return { rootCls: root?.className, rootDisp: root && getComputedStyle(root).display,
    n: btns.length, btns,
    others: [...(root?.querySelectorAll('*') || [])].filter(e => !e.classList.contains('w-abtn') && (e.tagName === 'BUTTON' || e.className?.toString?.().includes('stick'))).map(e => e.className?.toString?.().slice(0, 40)) };
}), null, 1));

console.log('\n== debug surface ==');
console.log(JSON.stringify(await B.page.evaluate(() => ({
  padKeyboard: WALLY.debug.padKeyboard(),
  focusRestore: WALLY.debug.focusRestore(),
  yield: WALLY.debug.padHandBackYield(),
  stall: WALLY.debug.padHandBackStall(),
  panels: WALLY.ctx.ui.panels,
  hasTouchState: typeof WALLY.debug.touchState === 'function' && WALLY.debug.touchState(),
  hasInteract: typeof WALLY.debug.interact === 'function',
  uiKeys: Object.keys(WALLY.ctx.ui).slice(0, 60),
  dbgKeys: Object.keys(WALLY.debug).filter(k => /pad|focus|idle|touch|key|interact|hide/i.test(k)),
})), null, 1));

console.log('\n== open the pause sheet by thumb, list what is in it ==');
const t = await d.tabTo('Menu');
console.log('tabTo Menu:', JSON.stringify(t));
await d.thumb('Jump', 110, 260);
console.log('after thumb Jump:', JSON.stringify(await d.padKb()));
await d.thumb('Menu');
console.log('panels:', JSON.stringify(await d.panels()));
console.log('restore(open):', JSON.stringify(await d.restore()));
console.log('focus:', JSON.stringify(await d.focusNow()));
console.log(JSON.stringify(await B.page.evaluate(() => {
  const p = document.querySelector('.w-pause') || document.querySelector('.w-sheet');
  return { cls: p?.className, focusables: [...p.querySelectorAll('button,[href],input,select,textarea,[tabindex]')].map(e => (e.textContent || '').trim().slice(0, 22) || e.tagName) };
}), null, 1));
const rb = await d.btnIn('resume');
console.log('resume btn:', JSON.stringify(rb));

console.log('\n== close by thumb on Resume, no Tab: the baseline hand-back ==');
await ledger(B.page);
await d.touch('touchStart', rb.x, rb.y); await d.wait(45); await d.touch('touchEnd', rb.x, rb.y);
await d.wait(900);
console.log('ledger:', JSON.stringify(await ledger(B.page)));
console.log('restore:', JSON.stringify(await d.restore()));
console.log('padKb:', JSON.stringify(await d.padKb()));
console.log('focus:', JSON.stringify(await d.focusNow()));
console.log('panels:', JSON.stringify(await d.panels()));

console.log('\nerrs:', JSON.stringify(B.errs));
console.log('LOAD at end:', load());
await B.close();
