/* _vjA.mjs — VERIFY JUDGE, rig A: THE INVARIANT, measured by PEAK
   vertical velocity rather than a single sample.
   Real CDP input at 390x844, hasTouch, isMobile. */
import { boot, driver, load, cpus, installLedger, ledger } from './_gb11-lib.mjs';

const L0 = load();
const b = await boot();
const d = driver(b.page, b.cdp);
await installLedger(b.page);
console.log(`load at boot ${L0} · ${cpus()} cpus`);

let pass = 0, fail = 0;
const ok = (c, name, detail) => { c ? pass++ : fail++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`); };

/* PEAK vy, not a sample. Poll every frame for the whole flight. */
async function peakJump(ms = 420) {
  await b.page.evaluate(() => {
    window.__pk = { vy: -1e9, grounded0: WALLY.ctx.wally.controller.grounded, left: false, n: 0 };
    const step = () => {
      const c = WALLY.ctx.wally.controller;
      window.__pk.vy = Math.max(window.__pk.vy, c.velocity.y);
      if (!c.grounded) window.__pk.left = true;
      window.__pk.n++;
      if (window.__pk.go) requestAnimationFrame(step);
    };
    window.__pk.go = true; requestAnimationFrame(step);
  });
  await d.keyDown('Space');
  await d.wait(ms);
  await d.keyUp('Space');
  await d.wait(120);
  const r = await b.page.evaluate(() => { window.__pk.go = false; return window.__pk; });
  return { peakVy: +r.vy.toFixed(2), leftGround: r.left, samples: r.n };
}
const panels = () => b.page.evaluate(() => WALLY.ctx.ui.panels.slice());
const kbr = () => b.page.evaluate(() => WALLY.debug.kb());

/* put him somewhere he can jump, nothing modal */
async function clean() {
  await b.page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.kbReset(); WALLY.debug.padHandBackStall(0); });
  await d.wait(420);
}
/* a real finger on the thumbstick, walking */
async function thumbWalk() {
  const s = await d.stickAt(); if (!s) return false;
  await d.touch('touchStart', s.x, s.y); await d.wait(60);
  await d.touch('touchMove', s.x, s.y - 40); await d.wait(120);
  await d.touch('touchMove', s.x, s.y - 55); await d.wait(160);
  await d.touch('touchEnd', s.x, s.y - 55); await d.wait(160);
  return true;
}

console.log('\n================ A. THE INVARIANT, four cases ================');

/* --- 1. never tabbed, then thumbs: Space is the GAME's --- */
await clean();
await thumbWalk();
let j = await peakJump();
let p = await panels();
ok(j.peakVy > 0.5 && j.leftGround && p.length === 0,
  'INV-1 [never-tabbed-then-thumbs -> Space JUMPS]',
  `peakVy ${j.peakVy}, leftGround ${j.leftGround}, samples ${j.samples}, panels ${JSON.stringify(p)}, load ${load()}`);

/* --- 2. tabbed ONCE, then thumbs: the thumbs take it back --- */
await clean();
const t2 = await d.tabTo('Menu');
await thumbWalk();
j = await peakJump();
p = await panels();
ok(t2 !== null && j.peakVy > 0.5 && j.leftGround && p.length === 0,
  'INV-2 [tabbed-once-then-thumbs -> Space JUMPS, the Tab is not permanent]',
  `tabbedTo ${JSON.stringify(t2)}, peakVy ${j.peakVy}, leftGround ${j.leftGround}, panels ${JSON.stringify(p)}, load ${load()}`);

/* --- 3. tabbed, NO thumbs after: Space belongs to the BUTTON --- */
await clean();
const t3 = await d.tabTo('Menu');
const f3before = await d.focusNow();
j = await peakJump();
p = await panels();
const f3after = await d.focusNow();
ok(t3 !== null && p.length > 0 && !j.leftGround && j.peakVy < 0.5,
  'INV-3 [tabbed-then-Space -> the BUTTON fires, he does NOT jump]',
  `panels ${JSON.stringify(p)}, peakVy ${j.peakVy}, leftGround ${j.leftGround}, focus ${JSON.stringify(f3before)}->${JSON.stringify(f3after)}, load ${load()}`);

/* --- 4. tab, touch, tab again, Space: the SECOND Tab is deliberate --- */
await clean();
const t4a = await d.tabTo('Menu');
await thumbWalk();                         // thumbs take the keyboard back
const t4b = await d.tabTo('Menu');         // ...and a fresh Tab claims it again
j = await peakJump();
p = await panels();
ok(t4a !== null && t4b !== null && p.length > 0 && !j.leftGround,
  'INV-4 [tab-touch-tab-Space -> the fresh Tab wins, the BUTTON fires]',
  `tabs ${t4a && t4a.tabs}/${t4b && t4b.tabs}, panels ${JSON.stringify(p)}, peakVy ${j.peakVy}, leftGround ${j.leftGround}, load ${load()}`);

console.log('\n================ B. the ledger is clean ================');
const r = await kbr();
ok(r.violations.length === 0, 'INV-5 [no undeclared focus/blur reached the DOM across all four cases]',
  `violations ${r.violations.length} ${JSON.stringify(r.violations.slice(0,2))}, playerMoves ${r.playerMoves}, pageerrors ${b.errs.length}`);

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILURES: ' + fail} — ${pass} passed, ${fail} failed · load at end ${load()}`);
await b.close();
process.exit(fail ? 1 : 0);
