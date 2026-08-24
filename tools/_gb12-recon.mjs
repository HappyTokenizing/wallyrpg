import { boot, driver, load, cpus } from './_gb12-lib.mjs';
console.log('LOAD at boot:', load(), `(${cpus()} cpus)`);
const B = await boot(); const d = driver(B.page, B.cdp);
await d.tabTo('Menu'); await d.thumb('Jump', 70, 250); await d.thumb('Menu', 70, 450);
const info = await B.page.evaluate(() => {
  const all = [...document.querySelectorAll('button,[href],input,select,textarea,[tabindex]')]
    .filter(e => e.getClientRects().length > 0 && !e.disabled);
  const nm = (e) => (e.getAttribute('aria-label') || (e.textContent || '').trim().slice(0, 16) || e.className);
  const zone = (e) => e.closest('.w-touch') ? 'PAD' : (e.closest('.w-pause,.w-sheet,.w-phone') ? 'PANEL' : 'other');
  const pause = document.querySelector('.w-pause');
  return {
    order: all.map((e, i) => `${i}:${zone(e)}:${nm(e)}`),
    pauseChildren: pause ? [...pause.querySelectorAll('button')].map(nm) : null,
    panelsRootIdx: all.findIndex(e => e.closest('.w-pause,.w-sheet')),
    padIdx: all.findIndex(e => e.closest('.w-touch')),
    panelsEl: document.querySelector('#panels,.w-panels')?.className || null,
  };
});
console.log(JSON.stringify(info, null, 1).slice(0, 3000));
console.log('LOAD at end:', load());
await B.close();
