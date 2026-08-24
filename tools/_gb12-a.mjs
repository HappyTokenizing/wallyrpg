/* _gb12-a.mjs — THE HAND-BACK WINDOW, SWEPT.
   A Tab at every offset across the closing lift. Real dispatched
   touches and keys throughout; the only script call is the debug
   stall, which moves WHEN the landing attempt happens and nothing
   else. Every number printed is measured on this page at this load. */
import { boot, driver, load, cpus, clock, readClock, mark, fmt } from './_gb12-lib.mjs';

const L0 = load();
console.log('LOAD at boot:', L0, `(${cpus()} cpus)`);
const B = await boot();
const d = driver(B.page, B.cdp);
await clock(B.page);

const padKb = () => B.page.evaluate(() => WALLY.debug.padKeyboard());
const rest  = () => B.page.evaluate(() => WALLY.debug.focusRestore());
const nPan  = () => B.page.evaluate(() => WALLY.ctx.ui.panels.length);
const setStall = (n) => B.page.evaluate((k) => WALLY.debug.padHandBackStall(k), n);
const setMode  = (m) => B.page.evaluate((k) => WALLY.debug.padHandBackYield(k), m);

/* the key sequences under test, all real dispatched keys */
const SEQ = {
  tab:      async () => { await d.key('Tab', 20); },
  shifttab: async () => { await d.key('Tab', 20, d.SHIFT); },
  twotab:   async () => { await d.key('Tab', 12); await d.wait(14); await d.key('Tab', 12); },
  repeat:   async () => { await d.keyDown('Tab'); await d.wait(12);
                          await d.keyDown('Tab', 0, { autoRepeat: true }); await d.wait(12);
                          await d.keyDown('Tab', 0, { autoRepeat: true }); await d.wait(12);
                          await d.keyUp('Tab'); },
};

async function trial({ offset, stall = 0, seq = 'tab', mode = 'sign', verbose = false }) {
  await setMode(mode); await setStall(stall);
  await d.reset(); await d.wait(200);
  /* ONE Tab, ever — the single-variable setup the ninth breaker used */
  const t = await d.tabTo('Menu');
  if (!t) return { err: 'never reached Menu by Tab' };
  await d.thumb('Jump', 70, 260);                       // driving := true
  const kb0 = await padKb();
  await d.thumb('Menu', 70, 420);                       // pause sheet, by thumb
  const open = await nPan();
  if (open < 1) return { err: 'sheet did not open' };
  const res = await d.btnIn('resume|close|back|done');
  if (!res) return { err: 'no close button in sheet' };
  await readClock(B.page);
  await mark(B.page, 'press Resume');
  await d.touch('touchStart', res.x, res.y); await d.wait(70);
  await mark(B.page, 'THE CLOSING LIFT');
  await d.touch('touchEnd', res.x, res.y);
  if (offset > 0) await d.wait(offset);
  await mark(B.page, 'TAB');
  await SEQ[seq]();
  await d.wait(900);
  const c = await readClock(B.page);
  const f = await d.focusNow(); const r = await rest(); const kb = await padKb();
  /* THE MEANING: with the ring on a pad button, does Space fire it? */
  const before = await nPan();
  await d.key('Space', 25); await d.wait(420);
  const after = await nPan();
  const fired = after > before;
  /* the real gap between the lift and the Tab, measured not assumed */
  const lift = c.find(e => e.mark === 'THE CLOSING LIFT');
  const tab  = c.find(e => e.ev === 'keydown' && e.key === 'Tab');
  const gap  = (lift && tab) ? +(tab.t - lift.t).toFixed(1) : null;
  return { kb0, panelsOpen: open, focus: f, rec: r, kb, fired, gap, clock: c, closeBtn: res.label };
}

const row = (tag, x) => {
  if (x.err) { console.log(`  ${tag.padEnd(26)} ERROR ${x.err}`); return; }
  const deaf = x.focus.where === 'pad' && x.kb.padTakesSpace === false;
  console.log(`  ${tag.padEnd(26)} gap ${String(x.gap).padStart(6)}ms  focus ${(x.focus.label + '/' + x.focus.where).padEnd(22)}` +
    ` att ${String(x.rec?.attempts).padStart(2)} land ${x.rec?.landed ? 'Y' : 'n'} sign ${x.rec?.signed ? 'Y' : 'n'} moved ${x.rec?.moved ? 'Y' : 'n'}` +
    `  driving ${x.kb.driving ? 'Y' : 'n'}  takesSpace ${x.kb.padTakesSpace ? 'Y' : 'n'}  SPACE ${x.fired ? 'fired the button' : 'went to the game'}` +
    `  ${deaf ? '<< DEAF' : ''}`);
};

console.log('\n──── BRANCH CHECK: is this a real, multi-attempt close at all? ────');
{
  const x = await trial({ offset: 400, stall: 0 });
  console.log('  close button found:', x.closeBtn, ' panels open before close:', x.panelsOpen);
  console.log('  hand-back record  :', JSON.stringify(x.rec));
  console.log('  kb after thumb Jump (driving must be Y):', JSON.stringify(x.kb0));
  console.log('  ledger:\n           ' + fmt(x.clock));
  row('Tab long after (+400ms)', x);
}

console.log('\n──── A TAB AT EVERY OFFSET ACROSS THE LIFT (stall 0, the shipping window) ────');
for (const off of [0, 8, 16, 30, 80, 150]) {
  const x = await trial({ offset: off, stall: 0 });
  row(`+${off}ms`, x);
}
console.log('  LOAD now:', load());

console.log('\n──── THE SAME, WITH THE WINDOW HELD OPEN (stall 9 — the Tab lands INSIDE it) ────');
for (const off of [0, 8, 16, 30, 80, 150]) {
  const x = await trial({ offset: off, stall: 9 });
  row(`+${off}ms stall9`, x);
}

console.log('\n──── SHIFT-TAB, KEY REPEAT, TWO TABS ────');
for (const seq of ['shifttab', 'repeat', 'twotab']) {
  for (const off of [0, 16, 80]) {
    const x = await trial({ offset: off, stall: 0, seq });
    row(`${seq} +${off}ms`, x);
  }
  const x = await trial({ offset: 8, stall: 9, seq });
  row(`${seq} +8ms stall9`, x);
}

await setStall(0); await setMode('sign');
console.log('\nerrs:', JSON.stringify(B.errs));
console.log('LOAD at end:', load());
await B.close();
