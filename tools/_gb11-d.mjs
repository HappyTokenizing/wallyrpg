/* _gb11-d.mjs — ROUND TEN part D. Part C printed a single hand-back
   record carrying moved:true AND signed:true, which ui.js says cannot
   happen (`if (!moved) { rec.signed = ... }`). Either I misread the
   code or a close is producing MORE THAN ONE hand-back and
   d.focusRestore() — a single `lastRestore` slot — is showing me the
   last one while I attribute it to the first.

   So: poll the record every animation frame and keep every DISTINCT
   one, and log every uiWillFocus() call beside it. Then the count of
   hand-backs per close is a measurement, not an assumption. */
import { boot, driver, load, cpus } from './_gb11-lib.mjs';

console.log('LOAD at boot:', load(), `(${cpus()} cpus)`);
const B = await boot();
const d = driver(B.page, B.cdp);

await B.page.evaluate(() => {
  window.__R = []; window.__S = []; window.__R0 = performance.now();
  const t = WALLY.ctx.ui.touch;
  const real = t.uiWillFocus;
  t.uiWillFocus = function (el) {
    const r = real.call(t, el);
    window.__S.push({ t: +(performance.now() - window.__R0).toFixed(1),
      el: el?.getAttribute?.('aria-label') || el?.className || el?.tagName, ret: r });
    return r;
  };
  let lastJson = '';
  const tick = () => {
    let r = null; try { r = WALLY.debug.focusRestore(); } catch (e) {}
    if (r) { const j = JSON.stringify(r);
      if (j !== lastJson) { lastJson = j; window.__R.push({ t: +(performance.now() - window.__R0).toFixed(1), r }); } }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const recs = () => B.page.evaluate(() => { const a = { R: window.__R.slice(), S: window.__S.slice() };
  window.__R = []; window.__S = []; window.__R0 = performance.now(); return a; });

const stale = async () => { await d.reset(); const t = await d.tabTo('Menu'); await d.thumb('Jump', 110, 240); return t; };
const openPause = async () => { await d.thumb('Menu', 70, 340); return (await d.panels()).includes('pause'); };
const show = (a) => `\n     handbacks: ${a.R.map(x => `${x.t}[to=${x.r.to} from=${x.r.from} a=${x.r.attempts} mv=${x.r.moved}->${x.r.movedTo} sg=${x.r.signed} land=${x.r.landed} yld=${x.r.yielded}]`).join('\n                ')}\n     signatures: ${a.S.map(x => `${x.t}(${x.el})=${x.ret}`).join(' ')}`;

console.log('\n== 1. ONE close, no Tab: how many hand-backs does a close make? ==');
await stale(); await openPause(); await d.wait(400);
await recs();
{
  const rb = await d.btnIn('resume');
  await d.touch('touchStart', rb.x, rb.y); await d.wait(45); await d.touch('touchEnd', rb.x, rb.y);
  await d.wait(900);
  console.log(show(await recs()));
  console.log('     padKb:', JSON.stringify(await d.padKb()), 'focus:', JSON.stringify(await d.focusNow()));
}

console.log('\n== 2. TWO Tabs straddling the close ==');
for (let i = 0; i < 3; i++) {
  await stale(); await openPause(); await d.wait(300);
  const rb = await d.btnIn('resume');
  await recs();
  await d.touch('touchStart', rb.x, rb.y); await d.wait(45); await d.touch('touchEnd', rb.x, rb.y);
  await d.keyDown('Tab'); await d.keyUp('Tab');
  await d.keyDown('Tab'); await d.keyUp('Tab');
  await d.wait(900);
  const a = await recs(); const kb = await d.padKb(); const f = await d.focusNow();
  console.log(`  run${i}: deaf=${kb.driving} end=${f.where}/${f.label}${show(a)}`);
}

console.log('\n== 3. the quiet Tab, with the full record ==');
for (let i = 0; i < 2; i++) {
  await stale(); await openPause(); await d.wait(420);
  await d.key('Tab', 25); await d.wait(420);
  const mid = await d.focusNow();
  await recs();
  const rb = await d.btnIn('resume');
  await d.touch('touchStart', rb.x, rb.y); await d.wait(45); await d.touch('touchEnd', rb.x, rb.y);
  await d.wait(900);
  const a = await recs(); const kb = await d.padKb(); const f = await d.focusNow();
  console.log(`  run${i}: ringAfterTab=${mid.where}/${mid.label} deaf=${kb.driving} end=${f.where}/${f.label}${show(a)}`);
}

console.log('\nerrs:', JSON.stringify(B.errs));
console.log('LOAD at end:', load());
await B.close();
