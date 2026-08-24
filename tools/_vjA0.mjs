/* control: is my peak-vy measurement measuring the KEYPRESS, or the weather? */
import { boot, driver, load, cpus } from './_gb11-lib.mjs';
const b = await boot(); const d = driver(b.page, b.cdp);
console.log('load', load(), cpus(), 'cpus');
async function peak(label, press, ms = 420) {
  await b.page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.kbReset(); });
  await d.wait(500);
  await b.page.evaluate(() => {
    window.__pk = { vy: -1e9, go: true, left: false, trace: [] };
    const st = () => { const c = WALLY.ctx.wally.controller;
      window.__pk.vy = Math.max(window.__pk.vy, c.velocity.y);
      window.__pk.trace.push(+c.velocity.y.toFixed(2));
      if (!c.grounded) window.__pk.left = true;
      if (window.__pk.go) requestAnimationFrame(st); }; requestAnimationFrame(st); });
  if (press) { await d.keyDown('Space'); await d.wait(ms); await d.keyUp('Space'); }
  else { await d.wait(ms); }
  await d.wait(120);
  const r = await b.page.evaluate(() => { window.__pk.go = false; return window.__pk; });
  console.log(`${label.padEnd(34)} peakVy ${r.vy.toFixed(2)}  left ${r.left}  panels ${JSON.stringify(await 0 || [])}`);
  console.log('        trace', JSON.stringify(r.trace.slice(0, 26)));
  return r;
}
await peak('CONTROL: no key at all', false);
await peak('SPACE, nothing focused', true);
const t = await d.tabTo('Menu');
console.log('tabbed to', JSON.stringify(t));
await b.page.evaluate(() => { window.__q = WALLY.debug.padKeyboard(); });
console.log('padKeyboard after Tab', JSON.stringify(await b.page.evaluate(() => WALLY.debug.padKeyboard())));
/* now Space WITHOUT the closeAll/kbReset that peak() does, because that
   reset is what was wiping the Tab */
await b.page.evaluate(() => { window.__pk = { vy: -1e9, go: true, left: false, trace: [] };
  const st = () => { const c = WALLY.ctx.wally.controller;
    window.__pk.vy = Math.max(window.__pk.vy, c.velocity.y); window.__pk.trace.push(+c.velocity.y.toFixed(2));
    if (!c.grounded) window.__pk.left = true; if (window.__pk.go) requestAnimationFrame(st); }; requestAnimationFrame(st); });
await d.keyDown('Space'); await d.wait(420); await d.keyUp('Space'); await d.wait(120);
const r = await b.page.evaluate(() => { window.__pk.go = false; return window.__pk; });
console.log('TABBED then SPACE (no reset)      peakVy', r.vy.toFixed(2), 'left', r.left,
  'panels', JSON.stringify(await b.page.evaluate(() => WALLY.ctx.ui.panels.slice())));
console.log('        trace', JSON.stringify(r.trace.slice(0, 26)));
await b.close();
