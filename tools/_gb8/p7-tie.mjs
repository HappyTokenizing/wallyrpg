import { boot, boxes, padProbe2 } from '../_gb7/lib.mjs';
const t = await boot();
const { page, ok, multi } = t;
await padProbe2(page);
const b = await boxes(page);
const W = (ms) => page.waitForTimeout(ms);
const P = (x,y,id) => ({ x, y, id, radiusX: 14, radiusY: 14, force: 1 });
const focusNow = () => page.evaluate(() => { const a = document.activeElement;
  if (!a || a === document.body) return null;
  return (a.getAttribute?.('aria-label') || a.tagName + '.' + String(a.className||'')).trim(); });

/* why did the Enter button see no compat click? */
const actInfo = await page.evaluate(() => { const e = document.querySelector('.w-abtn.act');
  const c = getComputedStyle(e); const r = e.getBoundingClientRect();
  return { cls: e.className, pe: c.pointerEvents, op: c.opacity, vis: c.visibility,
    hit: (() => { const el = document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
      return el ? el.className || el.tagName : null; })() }; });
console.log('ENTER button when "off":', JSON.stringify(actInfo));

/* settings sheet: does focus move there? */
const names = await page.evaluate(() => Object.keys(WALLY.ctx.ui).filter(k => /open|show/i.test(k)));
console.log('ui open/show API:', names.join(' '));
let opened = null;
for (const n of ['settings', 'options']) {
  const okk = await page.evaluate((nn) => { try { WALLY.ctx.ui.show(nn); return WALLY.ctx.ui.panels.slice(); } catch (e) { return 'ERR ' + e.message; } }, n);
  console.log(`  ui.show('${n}') -> ${JSON.stringify(okk)}`);
  if (Array.isArray(okk) && okk.includes(n)) { opened = n; break; }
}
if (opened) {
  await W(900);
  await page.evaluate(() => document.activeElement?.blur?.());
  const seen = [];
  for (let i = 0; i < 10; i++) { await page.keyboard.press('Tab'); seen.push(await focusNow()); }
  const d = [...new Set(seen.filter(Boolean))];
  ok(d.length >= 2, `PAD-48 Tab still moves inside the ${opened} sheet`, JSON.stringify(d.slice(0,6)));
} else {
  console.log('  (no settings panel by that name — the pause sheet carries it; covered by PAD-39)');
}
console.log(`\nFAILS ${t.fails}`); console.log('ERRS', JSON.stringify(t.errs));
await t.close();
