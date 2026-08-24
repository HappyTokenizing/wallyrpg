/* _vjE.mjs — (1) can the select() hole actually corrupt a hand-back's
   yield decision, and (2) the assistive path measured by ACTIVATION
   rather than by whether a panel happened to open. */
import { boot, driver, load, cpus } from './_gb11-lib.mjs';
const b = await boot(); const d = driver(b.page, b.cdp);
console.log('load at boot', load(), '·', cpus(), 'cpus');
let pass = 0, fail = 0;
const ok = (c,n,x) => { c?pass++:fail++; console.log(`${c?'PASS':'FAIL'}  ${n}\n        ${x}`); };

console.log('\n===== 1. does select() corrupt the hand-back yield? =====');
await b.page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.padHandBackStall(0); });
await d.wait(350);
await d.tabTo('Menu');
await b.page.evaluate(() => WALLY.debug.kbReset());
const jc = await d.padAt('Jump');
await d.touch('touchStart', jc.x, jc.y); await d.wait(110); await d.touch('touchEnd', jc.x, jc.y);
await d.wait(300);
await d.thumb('Menu');                       // pause sheet, thumb-opened
await d.wait(320);
await b.page.evaluate(() => WALLY.debug.padHandBackStall(25));
const res = await d.btnIn('resume');
await d.touch('touchStart', res.x, res.y); await d.wait(50); await d.touch('touchEnd', res.x, res.y);
await d.wait(20);
/* INSIDE the hand-back window, do exactly what menus.js:1010 does */
const sel = await b.page.evaluate(() => {
  const ta = document.createElement('textarea');
  ta.value = 'save'; document.body.appendChild(ta);
  ta.select();                               // menus.js Copy button
  window.__vjta = ta;
  return { moved: document.activeElement === ta };
});
await d.wait(1000);
await b.page.evaluate(() => { WALLY.debug.padHandBackStall(0); window.__vjta?.remove(); });
const rec = await b.page.evaluate(() => WALLY.debug.focusRestore());
const pad = await b.page.evaluate(() => WALLY.debug.padKeyboard());
const rep = await b.page.evaluate(() => WALLY.debug.kb());
console.log('  select moved focus:', sel.moved);
console.log('  restore record   :', JSON.stringify(rec));
console.log('  padKeyboard      :', JSON.stringify(pad));
console.log('  violations       :', rep.violations.length);
ok(rec && rec.moved === false,
  'SEL-2 [a UI focus move that skips kb.focus() must NOT be read as the player moving]',
  `rec.moved ${rec && rec.moved}, rec.site ${rec && rec.site}, kept ${rec && rec.kept}, violations ${rep.violations.length}, load ${load()}`);

console.log('\n===== 2. assistive path, measured by ACTIVATION =====');
/* count real activations rather than guessing from panels: every pad
   button's verb goes through the pad, so watch for a click with
   detail 0 (the AT/keyboard activation shape) on the focused button */
await b.page.evaluate(() => {
  window.__act = [];
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.w-abtn');
    if (btn) window.__act.push({ lab: btn.getAttribute('aria-label'), detail: e.detail });
  }, true);
});
const labels = await b.page.evaluate(() =>
  [...document.querySelectorAll('.w-abtn')].map(e => e.getAttribute('aria-label')).filter(Boolean));
const bad = [];
for (const L of labels) {
  await b.page.evaluate(() => { WALLY.ctx.ui.closeAll(); window.__act = []; });
  await d.wait(400);
  const t = await d.tabTo(L);
  if (!t) { bad.push(L + ':unreachable'); continue; }
  const fBefore = await d.focusNow();
  await d.key('Space', 30);
  await d.wait(500);
  const act = await b.page.evaluate(() => window.__act.slice());
  const fAfter = await d.focusNow();
  const activated = act.some(a => a.lab === L);
  if (!activated) bad.push(`${L}:noactivation`);
  if (fBefore.where === 'pad' && fAfter.where === 'body') bad.push(`${L}:focusDROPPED`);
  console.log(`   ${L.padEnd(14)} tabs=${String(t.tabs).padEnd(3)} activated=${String(activated).padEnd(5)} detail=${JSON.stringify(act.map(a=>a.detail))} focus ${fBefore.where}->${fAfter.where}`);
}
ok(bad.length === 0,
  'AT-2 [a genuine Tab then Space ACTIVATES every focusable pad button, and focus is never taken from the player]',
  bad.length ? JSON.stringify(bad) : `${labels.length}/${labels.length} activated, none dropped to body, load ${load()}`);

console.log(`\n${fail===0?'ALL GREEN':'FAILURES: '+fail} — ${pass} passed, ${fail} failed · pageerrors ${b.errs.length} · load ${load()}`);
await b.close();
