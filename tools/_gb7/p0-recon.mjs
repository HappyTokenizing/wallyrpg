/* round five recon: prove the rig boots, find the pad, find a door. */
import { boot, boxes, padProbe2, padState } from './lib.mjs';

const t = await boot();
const { page, ok } = t;

const st0 = await page.evaluate(() => WALLY.debug.touchState());
ok(st0.enabled, 'RECON-1 controls auto-enable on the phone', JSON.stringify(st0));

const b = await boxes(page);
console.log('BOXES', JSON.stringify(b));
ok(!!b.act && !!b.jump && !!b.stick, 'RECON-2 Enter, Jump and the stick all have boxes');
ok(b.sc.length === 4, `RECON-3 four shortcuts (got ${b.sc.length})`, JSON.stringify(b.sc.map(s => s.label)));

const layers = await page.evaluate(() => WALLY.debug.uiLayers());
console.log('LAYERS', JSON.stringify(layers));

const near = await page.evaluate(() => {
  const n = WALLY.ctx.ui.near; return n ? (n.id || n.key || String(n)) : null;
});
console.log('NEAR', near);
const why0 = await page.evaluate(() => WALLY.debug.interact());
console.log('WHY0', JSON.stringify(why0));

await padProbe2(page);
console.log('STATE', JSON.stringify(await padState(page)));

/* what does the debug surface actually offer? */
const hooks = await page.evaluate(() => Object.keys(WALLY.debug).sort());
console.log('DEBUG HOOKS', hooks.join(' '));

/* does a plain primary tap on Enter still work at all? */
await t.press(b.act.x, b.act.y, 60);
await page.waitForTimeout(500);
const s1 = await padState(page);
console.log('AFTER PLAIN TAP', JSON.stringify(s1.why), JSON.stringify(s1.panels));

console.log(`FAILS ${t.fails}`);
await t.close();
