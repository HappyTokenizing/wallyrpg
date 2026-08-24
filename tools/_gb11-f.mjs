/* _gb11-f.mjs — ROUND TEN part F. src/ui/ui.js changed mtime at
   18:35:54, in the middle of this round's probes, so no claim of mine
   may cite a run and a source read at different times. This probe
   FETCHES ITS OWN ui.js from inside the page it is measuring and
   prints the signing lines beside the numbers they explain.

   The decisive experiment is the A/B the previous round designed and
   left behind: 'sign' (shipping) against 'none' (pre-fix,
   unconditional signature). They are only different arms if the
   `moved` guard exists. If the two arms come out identical, the
   shipping arm IS the pre-fix arm and the fix is not in the build. */
import { boot, driver, load, cpus } from './_gb11-lib.mjs';
import { execSync } from 'node:child_process';

const stat = () => execSync('stat -f "%Sm %z" -t "%H:%M:%S" /Users/herwig/Documents/GitHub/wallyrpg/src/ui/ui.js').toString().trim();
console.log('LOAD at boot:', load(), `(${cpus()} cpus)`);
console.log('ui.js at boot:', stat(), ' md5', execSync('md5 -q /Users/herwig/Documents/GitHub/wallyrpg/src/ui/ui.js').toString().trim());

const B = await boot();
const d = driver(B.page, B.cdp);

console.log('\n=== the source the browser actually loaded, read from inside it ===');
const src = await B.page.evaluate(async () => {
  const t = await (await fetch('/src/ui/ui.js')).text();
  const lines = t.split('\n');
  const i = lines.findIndex(l => l.includes('rec.signed = touch.uiWillFocus'));
  return { n: t.length, at: i + 1,
    ctx: lines.slice(i - 3, i + 4).map((l, k) => `${i - 2 + k}| ${l}`),
    guard: /if \(!moved\) \{[^}]*rec\.signed/.test(t),
    hasMovedConst: t.includes('const moved = yieldMode'),
    hasFocusMovedSince: t.includes('function focusMovedSince') };
});
console.log('  bytes', src.n, ' signing line', src.at);
console.log('  `if (!moved)` guard present:', src.guard);
console.log('  `const moved = ...` present:', src.hasMovedConst, '  focusMovedSince present:', src.hasFocusMovedSince);
console.log(src.ctx.join('\n'));

const stale = async () => { await d.reset(); const t = await d.tabTo('Menu'); await d.thumb('Jump', 110, 240); return t; };
const openPause = async () => { await d.thumb('Menu', 70, 340); return (await d.panels()).includes('pause'); };

/* one gesture, parameterised by WHERE the Tab goes */
async function gesture(kind) {
  await stale(); await openPause(); await d.wait(300);
  const rb = await d.btnIn('resume');
  if (kind === 'quiet') {                      // Tab long before the close
    await d.key('Tab', 20); await d.wait(400);
    await d.touch('touchStart', rb.x, rb.y); await d.wait(45); await d.touch('touchEnd', rb.x, rb.y);
  } else if (kind === 'lift') {                // Tab racing the lift
    await d.touch('touchStart', rb.x, rb.y); await d.wait(45);
    const q = d.touch('touchEnd', rb.x, rb.y);
    await d.keyDown('Tab'); await d.keyUp('Tab'); await q;
  } else if (kind === 'after') {               // Tab just after the close begins
    await d.touch('touchStart', rb.x, rb.y); await d.wait(45); await d.touch('touchEnd', rb.x, rb.y);
    await d.keyDown('Tab'); await d.keyUp('Tab');
  } else if (kind === 'none') {                // control
    await d.touch('touchStart', rb.x, rb.y); await d.wait(45); await d.touch('touchEnd', rb.x, rb.y);
  }
  await d.wait(750);
  const kb = await d.padKb(); const f = await d.focusNow(); const r = await d.restore();
  return { deaf: kb.driving === true, f, r };
}

console.log('\n=== the A/B the last round designed: shipping vs pre-fix, one page, alternating ===');
const KINDS = ['quiet', 'lift', 'after', 'none'];
const N = 7;
const acc = {};
for (const m of ['sign', 'none']) for (const k of KINDS) acc[m + '/' + k] = { n: 0, deaf: 0, mv: 0, sg: 0, body: 0, ends: {} };
for (let i = 0; i < N; i++) {
  for (const m of (i % 2 ? ['none', 'sign'] : ['sign', 'none'])) {
    await B.page.evaluate((x) => WALLY.debug.padHandBackYield(x), m);
    for (const k of KINDS) {
      const g = await gesture(k);
      const a = acc[m + '/' + k]; a.n++;
      if (g.deaf) a.deaf++;
      if (g.r?.moved) a.mv++;
      if (g.r?.signed) a.sg++;
      if (g.f.where === 'body') a.body++;
      const e = `${g.f.where}:${g.f.label}`; a.ends[e] = (a.ends[e] || 0) + 1;
    }
  }
}
await B.page.evaluate(() => WALLY.debug.padHandBackYield('sign'));
console.log('arm                | DEAF  | record says moved | record says signed | ring on body | ring ended');
for (const m of ['sign', 'none']) for (const k of KINDS) { const a = acc[m + '/' + k];
  console.log(`${(m + ' / ' + k).padEnd(18)} | ${String(a.deaf).padStart(2)}/${a.n} |        ${String(a.mv).padStart(2)}/${a.n}        |        ${String(a.sg).padStart(2)}/${a.n}         |     ${String(a.body).padStart(2)}/${a.n}     | ${JSON.stringify(a.ends)}`); }

const same = KINDS.every(k => acc['sign/' + k].deaf === acc['none/' + k].deaf && acc['sign/' + k].sg === acc['none/' + k].sg);
console.log(`\n  the two arms are identical on every kind: ${same}`);
console.log('  ("sign" and "none" differ ONLY by the `if (!moved)` guard. Identical arms = the guard is not executing.)');

console.log('\nui.js at end:', stat(), ' md5', execSync('md5 -q /Users/herwig/Documents/GitHub/wallyrpg/src/ui/ui.js').toString().trim());
console.log('errs:', JSON.stringify(B.errs));
console.log('LOAD at end:', load());
await B.close();
