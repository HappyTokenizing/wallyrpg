/* _kb6-b.mjs — ROUND SIX, the two open defects, each with its own
   revert arm on ONE page at ONE load.

     6a  a Shift-Tab landing on a LIVE element outside the closing
         panel had its destination taken away        (kbKeep)
     6b  a dialogue opening inside the retry window looked like the
         player moving focus                          (kbWho)

   Real CDP input at 390x844, hasTouch, isMobile. No element.click().
   The window is HELD OPEN with padHandBackStall rather than raced:
   the branch is a 7-10 ms race and a suite that has to WIN one goes
   green on a quiet box for no reason.  */
import { boot, driver, load, cpus } from './_gb11-lib.mjs';

const L0 = load();
const b = await boot();
const d = driver(b.page, b.cdp);
const page = b.page;
console.log(`load at boot ${L0} · ${cpus()} cpus`);

const ev = (fn, arg) => page.evaluate(fn, arg);
const STALL = 25;

/** one Tab ever, then nothing but thumbs — the PANEL-7 state */
async function armOneTab() {
  await ev(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.kbReset(); WALLY.debug.padHandBackStall(0); });
  await d.wait(300);
  const t = await d.tabTo('Menu');
  await d.thumb('Jump');
  return t;
}

/** thumb Menu open, thumb Resume shut, with the window held open and
    `during` run at the moment the close begins. */
async function thumbRoundTrip(during) {
  await d.thumb('Menu');
  await d.wait(300);
  await ev((n) => WALLY.debug.padHandBackStall(n), STALL);
  const res = await d.btnIn('resume');
  await d.touch('touchStart', res.x, res.y); await d.wait(50); await d.touch('touchEnd', res.x, res.y);
  await d.wait(20);
  if (during) await during();
  await d.wait(900);
  await ev(() => WALLY.debug.padHandBackStall(0));
  return { restore: await d.restore(), pad: await d.padKb(), focus: await d.focusNow() };
}

/* ============================================================
   6a — the Shift-Tab that lands on a live pad button
   ============================================================ */
console.log('\n=== 6a  a Shift-Tab onto a LIVE element outside the closing panel ===');
for (const keep of ['never', 'survivor']) {
  await ev((m) => WALLY.debug.kbKeep(m), keep);
  await armOneTab();
  const out = await thumbRoundTrip(async () => { await d.key('Tab', 10, d.SHIFT); });
  console.log(`  keep=${keep.padEnd(9)} landedOn=${JSON.stringify(out.focus)}`);
  console.log(`               kept=${out.restore.kept} survivor=${out.restore.survivor} site=${out.restore.site} handbackAimedAt=${out.restore.to}`);
  console.log(`               padTakesSpace=${out.pad.padTakesSpace} (the keystroke's MEANING)`);
}
await ev(() => WALLY.debug.kbKeep('survivor'));

/* the guard: the SAME gesture with a forward Tab, which cannot reach
   a survivor because the panel's own buttons come next in DOM order.
   The yield must be taken ZERO times here. */
console.log('\n--- 6a guard: forward Tab has no survivor to reach; the yield must NOT fire ---');
await armOneTab();
{
  const out = await thumbRoundTrip(async () => { await d.key('Tab', 10, 0); });
  console.log(`  forward      landedOn=${JSON.stringify(out.focus)}`);
  console.log(`               kept=${out.restore.kept} movedTo=${out.restore.movedTo} site=${out.restore.site} landed=${out.restore.landed}`);
  console.log(`               padTakesSpace=${out.pad.padTakesSpace}`);
}

/* ============================================================
   6b — a dialogue with choices opening inside the retry window
   ============================================================ */
console.log('\n=== 6b  a dialogue opening inside the hand-back window ===');
const openDialogue = () => ev(() => {
  const ui = WALLY.ctx.ui;
  ui.dialogue({ speaker: 'Wally', text: 'x', choices: [{ label: 'Yes', value: 1 }, { label: 'No', value: 2 }] });
  ui.interact();                      // complete the typewriter -> showChoices() -> focus
  const a = document.activeElement;
  return a ? (a.textContent || '').trim().slice(0, 8) + '/' + a.tagName : 'body';
});
/* THE REVERT ARM IS ROUND FIVE WHOLE, both switches. Backing out only
   whoMode leaves 6a's survivor test in place, and the dialogue's own
   choice button IS a live survivor — so the yield swallows the defect
   and the arm reads green for the wrong reason. Measured: who=active
   with keep=survivor gave site=null, kept, padTakesSpace=false. One
   fix masking another is exactly how a suite goes green over a live
   bug, so the arm restores BOTH. */
for (const [who, keep, arm] of [['active', 'never', 'round 5'], ['owner', 'survivor', 'round 6']]) {
  await ev(([w, k]) => { WALLY.debug.kbWho(w); WALLY.debug.kbKeep(k); }, [who, keep]);
  await armOneTab();
  let landed = null;
  const out = await thumbRoundTrip(async () => { landed = await openDialogue(); });
  await ev(() => WALLY.ctx.ui.hide('dialogue'));
  await d.wait(300);
  console.log(`  ${arm} (who=${who}, keep=${keep})  dialogueFocused=${landed}`);
  console.log(`               moved=${out.restore.moved} movedTo=${out.restore.movedTo} site=${out.restore.site} signed=${out.restore.signed}`);
  console.log(`               padTakesSpace=${out.pad.padTakesSpace}   <- true is DEFECT 3 for a thumb-only player`);
}
await ev(() => { WALLY.debug.kbWho('owner'); WALLY.debug.kbKeep('survivor'); });

/* the guard: the same window with NOTHING opening in it. Nothing
   moved, so the restore must be faithful and signed in both arms —
   an assertion that asserts the ABSENCE of the fault, so a reader can
   tell a real green from a blind probe. */
console.log('\n--- 6b guard: an empty window; nothing moved, so nothing may be adopted ---');
for (const [who, keep, arm] of [['active', 'never', 'round 5'], ['owner', 'survivor', 'round 6']]) {
  await ev(([w, k]) => { WALLY.debug.kbWho(w); WALLY.debug.kbKeep(k); }, [who, keep]);
  await armOneTab();
  const out = await thumbRoundTrip(null);
  console.log(`  ${arm}  moved=${out.restore.moved} site=${out.restore.site} signed=${out.restore.signed} padTakesSpace=${out.pad.padTakesSpace}`);
}
await ev(() => { WALLY.debug.kbWho('owner'); WALLY.debug.kbKeep('survivor'); });

/* ============================================================
   the register, after all of that
   ============================================================ */
const r = await ev(() => WALLY.debug.kb());
console.log('\n=== the register after every path above ===');
console.log(`  violations ${r.violations.length}  ${JSON.stringify(r.violations.map(v => v.kind + ':' + v.el))}`);
console.log(`  playerMoves ${r.playerMoves}  gameHasKeyboard ${r.gameHasKeyboard}`);
console.log(`\nload at end ${load()}   pageerrors ${JSON.stringify(b.errs)}`);
await b.close();
