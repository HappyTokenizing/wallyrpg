/* GB13-D — the rate, and the consequence a player would feel.
   Every trip prints its own hasFocus triple so a VOID is visible as a
   rig failure rather than counted as a pass. */
import { boot, driver, loadNow, kbState } from './_gb13-lib.mjs';
const say = (id, v, note) => console.log(`${v.padEnd(7)} ${id}  ${note}`);
const b = await boot();
const d = driver(b.page, b.cdp);
await b.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
const other = await b.ctxM.newPage(); await other.goto('about:blank');
await b.page.bringToFront(); await d.wait(300);
console.log('BOOT  ' + loadNow('at boot') + ' · focus emulation OFF');

const hasFocus = () => b.page.evaluate(() => document.hasFocus());
async function trip(ms = 450) {
  await b.page.bringToFront(); await b.page.waitForTimeout(200);   // guarantee f0
  const f0 = await hasFocus();
  await other.bringToFront(); await b.page.waitForTimeout(ms);
  const f1 = await hasFocus();
  await b.page.bringToFront(); await b.page.waitForTimeout(ms);
  const f2 = await hasFocus();
  return { real: f0 && !f1 && f2, tri: `${+f0}${+f1}${+f2}` };
}
const arm = async () => { await b.page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.kbReset(); }); await d.wait(320); };
const panels = () => b.page.evaluate(() => WALLY.ctx.ui.panels.map(p => p.className || p.tagName));

/* ===== D-1: 6 runs, each one a fresh tabbed-once-then-thumbs ===== */
const runs = [];
for (let i = 0; i < 6; i++) {
  await arm();
  if (!await d.tabTo('Menu')) { runs.push('NOTAB'); continue; }
  await d.thumb('Jump', 70, 300);
  const a = await kbState(b.page);
  if (!a.driving) { runs.push('NOARM'); continue; }
  const t = await trip(400);
  const z = await kbState(b.page);
  runs.push(!t.real ? `VOID(${t.tri})` : (a.driving && !z.driving ? 'FLIPPED' : `held(${t.tri})`));
}
const real = runs.filter(r => !r.startsWith('VOID') && r !== 'NOTAB' && r !== 'NOARM').length;
const flip = runs.filter(r => r === 'FLIPPED').length;
say('D-1', flip ? 'BROKEN' : (real ? 'FINE' : 'VOID'),
  `${flip} of ${real} real trips took the keyboard off a thumbs player: [${runs.join(', ')}]  (${loadNow()})`);

/* ===== D-2: the Space, driven, with NOTHING done in between ===== */
await arm();
await d.tabTo('Menu'); await d.thumb('Jump', 70, 300);
const before = await kbState(b.page);
const t = await trip(400);
const mid = await kbState(b.page);
const p0 = await panels();
await d.key('Space', 30); await d.wait(420);
const p1 = await panels();
say('D-2', !t.real ? 'VOID' : (p1.length > p0.length ? 'BROKEN' : 'FINE'),
  `driving ${before.driving}->${mid.driving}, padTakesSpace ${before.padTakesSpace}->${mid.padTakesSpace}; `
  + `then ONE Space with no gesture in between: panels ${JSON.stringify(p0)} -> ${JSON.stringify(p1)}  (${loadNow()})`);

/* ===== D-3: and a thumb hands it straight back (the repair path) = */
await d.page.evaluate(() => WALLY.ctx.ui.closeAll()); await d.wait(300);
await d.thumb('Jump', 70, 300);
const rec = await kbState(b.page);
say('D-3', rec.driving ? 'FINE' : 'BROKEN',
  `one thumb on Jump after the flip puts it back: driving=${rec.driving} padTakesSpace=${rec.padTakesSpace} `
  + `— the defect costs ONE keystroke, it does not latch`);

console.log('\nERRORS: ' + (b.errs.length ? b.errs.join(' | ') : 'none'));
console.log('END   ' + loadNow('at end'));
await other.close(); await b.close();
