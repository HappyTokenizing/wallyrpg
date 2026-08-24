/* _vjD.mjs — the RUNTIME half against the two shapes the STATIC half
   let through: an unregistered site id, and select(). */
import { boot, driver, load, cpus } from './_gb11-lib.mjs';
const b = await boot(); const d = driver(b.page, b.cdp);
console.log('load at boot', load(), '·', cpus(), 'cpus');
const r = await b.page.evaluate(() => {
  const out = {};
  const v = () => WALLY.debug.kb().violations.length;
  const pm = () => WALLY.debug.kb().playerMoves;

  WALLY.debug.kbReset();
  const btn = document.querySelector('.w-abtn');

  /* (b) UNREGISTERED SITE ID through the declared route */
  let before = v();
  const ret = WALLY.debug.kbFocus('bogus.site', '.w-abtn');
  out.unknownSite = { before, after: v(), returned: ret,
    kinds: WALLY.debug.kb().violations.map(x => x.kind) };

  /* (b2) and does strict mode THROW, as the module claims? */
  WALLY.debug.kbReset();
  out.strictThrows = (() => {
    try { WALLY.ctx; } catch (e) {}
    return 'not-reachable-from-debug';
  })();

  /* (c) select() — moves focus, calls no focus(), contains no `focus` */
  WALLY.debug.kbReset();
  const ta = document.createElement('textarea');
  ta.value = 'save-data'; document.body.appendChild(ta);
  before = v(); const pmB = pm();
  ta.select();
  const movedTo = document.activeElement === ta;
  out.select = { movedFocus: movedTo, violBefore: before, violAfter: v(),
    playerMoves: pmB + ' -> ' + pm(), lastPlayer: WALLY.debug.kb().lastPlayer };
  ta.remove();

  /* (c2) and the same thing through an INPUT, which is what a real
     save/export field usually is */
  WALLY.debug.kbReset();
  const inp = document.createElement('input');
  inp.value = 'x'; document.body.appendChild(inp);
  const pmB2 = pm();
  inp.select();
  out.selectInput = { movedFocus: document.activeElement === inp,
    viol: v(), playerMoves: pmB2 + ' -> ' + pm() };
  inp.remove();
  return out;
});
console.log(JSON.stringify(r, null, 2));
console.log('\nload at end', load());
await b.close();
