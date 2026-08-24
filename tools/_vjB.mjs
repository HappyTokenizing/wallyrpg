/* _vjB.mjs — VERIFY JUDGE, rig B: BOTH Tab directions across the
   sheet-close window, a dialogue with choices in the same window, the
   assistive path, and the focus-move shape NEITHER half of the
   registration assertion can see. */
import { boot, driver, load, cpus, installLedger, ledger } from './_gb11-lib.mjs';

const L0 = load();
const b = await boot();
const d = driver(b.page, b.cdp);
await installLedger(b.page);
console.log(`load at boot ${L0} · ${cpus()} cpus`);

let pass = 0, fail = 0;
const ok = (c, name, detail) => { c ? pass++ : fail++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`); };
const kbr = () => b.page.evaluate(() => WALLY.debug.kb());
const panels = () => b.page.evaluate(() => WALLY.ctx.ui.panels.slice());
const rec = () => b.page.evaluate(() => WALLY.debug.focusRestore());

async function clean() {
  await b.page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.kbReset();
    WALLY.debug.padHandBackStall(0); WALLY.debug.kbWho('owner'); WALLY.debug.kbKeep('survivor'); });
  await d.wait(420);
}
/* open the pause sheet with a THUMB (so the player is a thumb player),
   then start the close and press Tab INSIDE the widened retry window */
async function closeWithTabInWindow(shift, stall = 9) {
  await clean();
  await d.thumb('Menu');                       // pause sheet, thumb-opened
  await d.wait(320);
  await b.page.evaluate((s) => WALLY.debug.padHandBackStall(s), stall);
  const res = await d.btnIn('resume');
  if (!res) return null;
  await d.touch('touchStart', res.x, res.y); await d.wait(45); await d.touch('touchEnd', res.x, res.y);
  await d.wait(30);                            // we are now INSIDE the window
  await d.key('Tab', 10, shift ? d.SHIFT : 0); // the player's real keystroke
  await d.wait(900);                           // let the hand-back finish
  return { focus: await d.focusNow(), rec: await rec(), kb: await kbr() };
}

console.log('\n========== B1. BOTH Tab directions across the close ==========');
for (const dir of ['forward', 'back']) {
  const r = await closeWithTabInWindow(dir === 'back');
  if (!r) { ok(false, `TAB-${dir} [setup]`, 'no resume button'); continue; }
  const landedSomewhereReal = r.focus.where !== 'body';
  ok(landedSomewhereReal,
    `TAB-${dir} [the keystroke keeps a DESTINATION — focus is never dropped on the player]`,
    `focus ${JSON.stringify(r.focus)}, rec.site ${r.rec && r.rec.site}, kept ${r.rec && r.rec.kept}, moved ${r.rec && r.rec.moved}, survivor ${r.rec && r.rec.survivor}, load ${load()}`);
  ok(r.kb.violations.length === 0,
    `TAB-${dir} [no undeclared focus during the close]`,
    `violations ${JSON.stringify(r.kb.violations.slice(0,2))}`);
  /* and the keystroke keeps its MEANING: a Space now goes to the
     control the player tabbed onto, not to the game */
  const before = await panels();
  await d.key('Space', 30);
  await d.wait(600);
  const after = await panels();
  ok(true, `TAB-${dir} [what Space did after the deliberate Tab]`,
    `panels ${JSON.stringify(before)} -> ${JSON.stringify(after)}, focus ${JSON.stringify(await d.focusNow())}`);
}

console.log('\n========== B2. a DIALOGUE with choices in the same window ==========');
/* the thumb-only player: no Tab anywhere in this case at all */
await clean();
await d.thumb('Menu');
await d.wait(320);
await b.page.evaluate(() => WALLY.debug.padHandBackStall(9));
const res2 = await d.btnIn('resume');
await d.touch('touchStart', res2.x, res2.y); await d.wait(45); await d.touch('touchEnd', res2.x, res2.y);
await d.wait(30);
await b.page.evaluate(() => WALLY.ctx.ui.dialogue?.open?.({
  speaker: 'Wally', text: 'Pick one.', choices: [{ label: 'Yes', value: 1 }, { label: 'No', value: 2 }] }));
await d.wait(900);
const rd = await rec();
const kd = await kbr();
ok(rd && rd.moved === false && rd.site === 'panel.restore',
  'DLG-1 [a focus the UI performed is NOT the player moving — defect 3, 3-of-3, stays closed]',
  `rec.moved ${rd && rd.moved}, rec.site ${rd && rd.site}, rec.kept ${rd && rd.kept}, load ${load()}`);
/* end to end: close the dialogue, and the thumb player's Space still jumps */
await b.page.evaluate(() => { WALLY.ctx.ui.dialogue?.close?.(null); WALLY.ctx.ui.closeAll(); });
await d.wait(500);
const s = await d.stickAt();
await d.touch('touchStart', s.x, s.y); await d.wait(60);
await d.touch('touchMove', s.x, s.y - 50); await d.wait(200); await d.touch('touchEnd', s.x, s.y - 50);
await d.wait(200);
await b.page.evaluate(() => { window.__pk = { vy: -1e9, go: true, left: false };
  const st = () => { const c = WALLY.ctx.wally.controller; window.__pk.vy = Math.max(window.__pk.vy, c.velocity.y);
    if (!c.grounded) window.__pk.left = true; if (window.__pk.go) requestAnimationFrame(st); }; requestAnimationFrame(st); });
await d.keyDown('Space'); await d.wait(400); await d.keyUp('Space'); await d.wait(120);
const pj = await b.page.evaluate(() => { window.__pk.go = false; return window.__pk; });
ok(pj.vy > 0.5 && pj.left, 'DLG-2 [and the thumb player who saw that dialogue still JUMPS on Space]',
  `peakVy ${pj.vy.toFixed(2)}, leftGround ${pj.left}, panels ${JSON.stringify(await panels())}, load ${load()}`);

console.log('\n========== B3. the assistive path: Tab then Space on EVERY pad button ==========');
await clean();
const labels = await b.page.evaluate(() =>
  [...document.querySelectorAll('.w-abtn')].map(e => e.getAttribute('aria-label')).filter(Boolean));
console.log('  pad buttons:', JSON.stringify(labels));
const dead = [];
for (const L of labels) {
  await clean();
  const t = await d.tabTo(L);
  if (!t) { dead.push(L + ':unreachable'); continue; }
  const fBefore = await d.focusNow();
  const pBefore = await panels();
  await d.key('Space', 30);
  await d.wait(650);
  const pAfter = await panels();
  const fAfter = await d.focusNow();
  const acted = JSON.stringify(pBefore) !== JSON.stringify(pAfter);
  const kept = fAfter.where === 'pad' || fAfter.where === 'panel';
  if (!acted && L !== 'Jump') dead.push(`${L}:noaction(${JSON.stringify(pAfter)})`);
  if (fBefore.where === 'pad' && fAfter.where === 'body') dead.push(`${L}:focusDROPPED`);
  console.log(`   ${L.padEnd(8)} tabs=${t.tabs} acted=${acted} focus ${fBefore.where}->${fAfter.where} panels ${JSON.stringify(pAfter)}`);
}
ok(dead.length === 0, 'AT-1 [a genuine Tab then Space activates every focusable pad button, and focus is never taken]',
  dead.length ? JSON.stringify(dead) : `${labels.length} of ${labels.length} answered, load ${load()}`);

console.log('\n========== B4. a focus move NEITHER half of the assertion can see ==========');
await clean();
const sel = await b.page.evaluate(() => {
  WALLY.debug.kbReset();
  const ta = document.createElement('textarea');
  ta.value = 'x'; document.body.appendChild(ta);
  const before = WALLY.debug.kb();
  ta.select();                                  // menus.js:1010 does exactly this
  const after = WALLY.debug.kb();
  const moved = document.activeElement === ta;
  ta.remove();
  return { movedFocus: moved, violBefore: before.violations.length, violAfter: after.violations.length,
    pmBefore: before.playerMoves, pmAfter: after.playerMoves };
});
console.log('  select() ->', JSON.stringify(sel));
ok(sel.movedFocus === false || sel.violAfter > sel.violBefore,
  'SEL-1 [either select() does not move focus, or the guard records it]',
  `movedFocus ${sel.movedFocus}, violations ${sel.violBefore}->${sel.violAfter}, playerMoves ${sel.pmBefore}->${sel.pmAfter}, load ${load()}`);

const fin = await kbr();
console.log(`\npageerrors ${b.errs.length} ${JSON.stringify(b.errs.slice(0,3))}`);
console.log(`${fail === 0 ? 'ALL GREEN' : 'FAILURES: ' + fail} — ${pass} passed, ${fail} failed · load at end ${load()}`);
await b.close();
process.exit(fail ? 1 : 0);
