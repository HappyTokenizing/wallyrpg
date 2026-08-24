/* _vjSpace.mjs — ONE question, runnable against either build:
   after a genuine Tab onto a pad button, does SPACE fire the button,
   jump, or both? Peak vertical velocity, with a no-key control. */
import { boot, driver, load, cpus } from './_gb11-lib.mjs';
const b = await boot(); const d = driver(b.page, b.cdp);
console.log('load at boot', load(), '·', cpus(), 'cpus');
const panels = () => b.page.evaluate(() => WALLY.ctx.ui.panels.slice());
async function pk(ms = 420, press = true) {
  await b.page.evaluate(() => { window.__pk = { vy: -1e9, go: true, left: false };
    const st = () => { const c = WALLY.ctx.wally.controller;
      window.__pk.vy = Math.max(window.__pk.vy, c.velocity.y);
      if (!c.grounded) window.__pk.left = true; if (window.__pk.go) requestAnimationFrame(st); };
    requestAnimationFrame(st); });
  if (press) { await d.keyDown('Space'); await d.wait(ms); await d.keyUp('Space'); } else await d.wait(ms);
  await d.wait(120);
  return b.page.evaluate(() => { window.__pk.go = false; return window.__pk; });
}
const clean = async () => { await b.page.evaluate(() => WALLY.ctx.ui.closeAll()); await d.wait(450); };

await clean();
let r = await pk(420, false);
console.log(`CONTROL no key            peakVy ${r.vy.toFixed(2)} left ${r.left} panels ${JSON.stringify(await panels())}`);
await clean();
r = await pk();
console.log(`SPACE, nothing focused    peakVy ${r.vy.toFixed(2)} left ${r.left} panels ${JSON.stringify(await panels())}`);
await clean();
const t = await d.tabTo('Menu');
console.log(`tabbed to Menu            ${JSON.stringify(t)}`);
r = await pk();
const p = await panels();
console.log(`TABBED then SPACE         peakVy ${r.vy.toFixed(2)} left ${r.left} panels ${JSON.stringify(p)}`);
console.log(`\nVERDICT  button fired: ${p.length > 0}   ALSO jumped: ${r.vy > 0.5 && r.left}   load ${load()}`);
await b.close();
