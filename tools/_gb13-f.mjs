/* GB13-F — THE INVARIANT. Both Tab directions, swept across the
   hand-back window with the stall hook (a race you must WIN to enter
   goes green on a quiet box for no reason, and this box is not quiet).
   Plus the question the register does not ask: when the keyboard
   BELONGS to a control, does the GAME still take the keystroke? */
import { boot, driver, loadNow, kbState } from './_gb13-lib.mjs';
const say = (id, v, note) => console.log(`${v.padEnd(7)} ${id}  ${note}`);
const b = await boot();
const d = driver(b.page, b.cdp);
await b.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
await b.page.bringToFront(); await d.wait(250);
console.log('BOOT  ' + loadNow('at boot'));

await b.page.evaluate(() => {
  window.__J = 0;
  WALLY.ctx.bus.on('phys:jump', () => window.__J++);
});
const jumps = () => b.page.evaluate(() => window.__J);
const resetJ = () => b.page.evaluate(() => { window.__J = 0; });
const rec = () => b.page.evaluate(() => WALLY.debug.focusRestore());
const arm = async () => { await b.page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.kbReset(); }); await d.wait(320); };

/* ============ F-1: THE DOUBLE ACTION.
   The invariant's first clause is "the keyboard belongs to the GAME
   unless the player put it on a UI control themselves". Put it on one
   themselves and see whether the game lets go. wally.js:868 binds
   keydown on window with no focus guard at all. ============ */
await arm();
const tabbed = await d.tabTo('Menu');
const s1 = await kbState(b.page);
await resetJ();
await d.key('Space', 40); await d.wait(420);
const j1 = await jumps();
const p1 = await b.page.evaluate(() => WALLY.ctx.ui.panels.slice());
say('F-1', j1 > 0 ? 'BROKEN' : 'FINE',
  `player TABBED to "${s1.focus}" himself (padTakesSpace=${s1.padTakesSpace}, so the keyboard belongs to the `
  + `CONTROL): one Space -> panel=${JSON.stringify(p1)} AND phys:jump fired ${j1}x  (${loadNow()})`);

/* the same key with the keyboard on NOTHING, as the control */
await arm(); await resetJ();
await d.key('Space', 40); await d.wait(420);
const j0 = await jumps();
say('F-1b', j0 > 0 ? 'FINE' : 'VOID',
  `CONTROL same Space with focus on <body>: phys:jump ${j0}x — confirms the observable works and the game does own it`);

/* a non-modal pad control: does its verb AND a jump both run? */
await arm();
const act = await d.tabTo('Act') || await d.tabTo('Interact') || await d.tabTo('A');
if (act) {
  await resetJ();
  const i0 = await b.page.evaluate(() => WALLY.debug.interact());
  await d.key('Space', 40); await d.wait(420);
  const i1 = await b.page.evaluate(() => WALLY.debug.interact());
  const j = await jumps();
  say('F-1c', j > 0 ? 'BROKEN' : 'FINE',
    `TABBED to the "${act.label}" button (non-modal verb): interact ${JSON.stringify(i0)} -> ${JSON.stringify(i1)}, `
    + `phys:jump ${j}x — the button's verb and a jump on ONE keystroke`);
} else say('F-1c', 'VOID', 'no non-modal action button reachable by Tab');

/* ============ F-2: the hand-back window, BOTH directions, swept.
   stall holds the window open so a dispatched Tab lands inside it
   every time instead of racing a box at load ~6.5 on 10 cpu. ====== */
async function sweep(dir, stall, offsets) {
  const rows = [];
  for (const off of offsets) {
    await arm();
    await b.page.evaluate((n) => WALLY.debug.padHandBackStall(n), stall);
    await d.thumb('Menu', 70, 420);                        // open pause with a thumb
    const resume = await d.btnIn('resume|close|back');
    if (!resume) { rows.push(`${off}:NOBTN`); continue; }
    /* close it with a thumb, then press Tab at `off` ms into the window */
    await d.touch('touchStart', resume.x, resume.y);
    await d.wait(50);
    await d.touch('touchEnd', resume.x, resume.y);
    await d.wait(off);
    await d.key('Tab', 8, dir === 'shift' ? d.SHIFT : 0);
    await d.wait(900);
    await b.page.evaluate(() => WALLY.debug.padHandBackStall(0));
    const r = await rec();
    const f = await d.focusNow();
    const k = await kbState(b.page);
    rows.push({ off, moved: r?.moved, kept: r?.kept, site: r?.site, landed: r?.landed,
      attempts: r?.attempts, movedTo: r?.movedTo, endedOn: f.label, where: f.where,
      driving: k.driving, padTakesSpace: k.padTakesSpace });
  }
  return rows;
}
const OFF = [0, 40, 90, 150, 220];
const fwd = await sweep('fwd', 14, OFF);
const rev = await sweep('shift', 14, OFF);
const fmtRow = (r) => typeof r === 'string' ? r
  : `off${String(r.off).padStart(3)}ms moved=${r.moved} kept=${r.kept} site=${r.site} landed=${r.landed} `
  + `att=${r.attempts} dest="${r.movedTo}" ended="${r.endedOn}"[${r.where}] takesSpace=${r.padTakesSpace}`;
console.log('\n  FORWARD TAB across the window (stall 14):');
fwd.forEach(r => console.log('    ' + fmtRow(r)));
console.log('  SHIFT-TAB across the window (stall 14):');
rev.forEach(r => console.log('    ' + fmtRow(r)));

/* the failure this is hunting: the keystroke loses its DESTINATION —
   the player moved, and ended up somewhere they did not choose */
const lost = [...fwd, ...rev].filter(r => typeof r === 'object' && r.moved
  && r.kept === false && r.where !== 'DYING' && r.movedTo && r.endedOn !== r.movedTo);
const dropped = [...fwd, ...rev].filter(r => typeof r === 'object' && r.endedOn === null);
say('F-2', lost.length ? 'BROKEN' : 'FINE',
  `${[...fwd,...rev].filter(r=>typeof r==='object').length} sweeps, both directions: `
  + `${lost.length} keystrokes lost a LIVE destination, ${dropped.length} ended on <body>  (${loadNow()})`);
if (lost.length) lost.forEach(r => console.log('      LOST: ' + fmtRow(r)));
if (dropped.length) dropped.forEach(r => console.log('      BODY: ' + fmtRow(r)));

console.log('\nERRORS: ' + (b.errs.length ? b.errs.join(' | ') : 'none'));
console.log('END   ' + loadNow('at end'));
await b.close();
