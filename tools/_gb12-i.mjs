/* _gb12-i.mjs — the BACK mouse button over the pad unloaded the game.
   Three arms, one boot each: over the pad, over the bare canvas, and
   over the pad with a preventDefault listener armed — which decides
   whether this is preventable at all or a browser default no page can
   refuse. Real Input.dispatchMouseEvent throughout. */
import { boot, driver, load, cpus } from './_gb12-lib.mjs';
console.log('LOAD at boot:', load(), `(${cpus()} cpus)`);

async function arm(where, guard) {
  const B = await boot(); const d = driver(B.page, B.cdp);
  let navs = 0; B.page.on('framenavigated', (f) => { if (f === B.page.mainFrame()) navs++; });
  if (guard) await B.page.evaluate(() => {
    window.__pd = 0;
    document.addEventListener('mousedown', (e) => { if (e.button === 3 || e.button === 4) { e.preventDefault(); window.__pd++; } }, true);
  });
  const p = where === 'pad' ? await d.padAt('Phone') : { x: 195, y: 300 };
  const url0 = B.page.url();
  await d.mouse('mousePressed', p.x, p.y, 'back', 8, 1); await d.wait(120);
  await d.mouse('mouseReleased', p.x, p.y, 'back', 8, 1); await d.wait(900);
  const aliveNow = await B.page.evaluate(() => typeof window.WALLY !== 'undefined').catch(() => false);
  const pd = guard ? await B.page.evaluate(() => window.__pd).catch(() => 'lost') : null;
  const url1 = B.page.url();
  console.log(`  ${(where + (guard ? ' + preventDefault guard' : '')).padEnd(28)} navigations ${navs}  game still loaded: ${aliveNow}  url ${url0 === url1 ? 'unchanged' : url0 + ' -> ' + url1}${guard ? `  preventDefault calls ${pd}` : ''}`);
  await B.close();
  return { navs, aliveNow };
}
await arm('pad', false);
await arm('canvas', false);
await arm('pad', true);
console.log('LOAD at end:', load());
