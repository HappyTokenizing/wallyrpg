/* round six recon: boot, find the pad, learn the focus surface. */
import { boot, boxes, padProbe2, padState } from '../_gb7/lib.mjs';

const t = await boot();
const { page, ok } = t;

const st0 = await page.evaluate(() => WALLY.debug.touchState());
ok(st0.enabled, 'RECON-1 controls auto-enable on the phone', JSON.stringify(st0));

const b = await boxes(page);
console.log('BOXES', JSON.stringify(b));
ok(!!b.act && !!b.jump && !!b.stick, 'RECON-2 Enter, Jump and the stick all have boxes');
ok(b.sc.length === 4, `RECON-3 four shortcuts (got ${b.sc.length})`, JSON.stringify(b.sc.map(s=>s.label)));

const hooks = await page.evaluate(() => Object.keys(WALLY.debug).sort());
console.log('DEBUG HOOKS', hooks.join(' '));

/* what is focusable in the pad, and what is the tab order? */
const foc = await page.evaluate(() => {
  const all = [...document.querySelectorAll('.w-touch button, .w-touch [tabindex]')];
  return all.map(e => ({
    cls: e.className, label: e.getAttribute('aria-label'),
    tabindex: e.getAttribute('tabindex'), tag: e.tagName,
    disabled: e.disabled ?? null,
  }));
});
console.log('PAD FOCUSABLES', JSON.stringify(foc, null, 1));

/* does the game bind Enter as a key at all, with nothing focused? */
await padProbe2(page);
await page.evaluate(() => document.activeElement?.blur?.());
const before = await page.evaluate(() => ({ act: window.__pad.act, panels: WALLY.ctx.ui.panels.slice() }));
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
const after = await page.evaluate(() => ({ act: window.__pad.act, panels: WALLY.ctx.ui.panels.slice(),
  focus: document.activeElement ? document.activeElement.tagName + '.' + document.activeElement.className : null }));
console.log('ENTER KEY, NOTHING FOCUSED  before', JSON.stringify(before), 'after', JSON.stringify(after));

/* and the E key, which ui.js actually binds */
await page.keyboard.press('KeyE');
await page.waitForTimeout(400);
console.log('E KEY', JSON.stringify(await page.evaluate(() => ({ act: window.__pad.act, panels: WALLY.ctx.ui.panels.slice() }))));

console.log('STATE', JSON.stringify(await padState(page)));
console.log(`FAILS ${t.fails}`);
await t.close();
