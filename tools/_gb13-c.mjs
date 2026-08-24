/* GB13-C — the same attack, with THE TRIP ITSELF ASSERTED.
   Round eleven's own first cut reported 7->7 on a trip that never
   happened, because the page under test was never the fronted tab to
   begin with. Every trip below verifies hasFocus true -> false -> true
   and counts the focusin, and a measurement taken across a trip that
   did not happen is discarded rather than reported. */
import { boot, driver, loadNow, kbState } from './_gb13-lib.mjs';

const out = [];
const say = (id, v, note) => { out.push([id, v]); console.log(`${v.padEnd(7)} ${id}  ${note}`); };
const b = await boot();
const d = driver(b.page, b.cdp);
await b.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
const other = await b.ctxM.newPage(); await other.goto('about:blank');
await b.page.bringToFront(); await d.wait(300);
console.log('BOOT  ' + loadNow('at boot') + ' · focus emulation OFF');

const hasFocus = () => b.page.evaluate(() => document.hasFocus());
await b.page.evaluate(() => {
  window.__FI = [];
  document.addEventListener('focusin', (e) => window.__FI.push(
    'in:' + (e.target.getAttribute?.('aria-label') || e.target.className || e.target.tagName)), true);
});
const drainFI = () => b.page.evaluate(() => { const f = window.__FI.slice(); window.__FI = []; return f; });

/** A trip that is a MEASUREMENT: true -> false -> true, or it did not
    happen and its numbers are thrown away. */
async function trip(ms = 450) {
  const f0 = await hasFocus();
  await other.bringToFront(); await b.page.waitForTimeout(ms);
  const f1 = await hasFocus();
  await b.page.bringToFront(); await b.page.waitForTimeout(ms);
  const f2 = await hasFocus();
  return { real: f0 === true && f1 === false && f2 === true, f0, f1, f2 };
}
const arm = async () => {
  await b.page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.kbReset(); });
  await d.wait(320); await drainFI();
};
const panelTop = () => b.page.evaluate(() => {
  const p = WALLY.ctx.ui.panels; return p.length ? (p[p.length-1].className || p[p.length-1].tagName) : null; });

/* ===== C-1: tabbed once, then thumbs. The documented player. ===== */
await arm();
if (!await d.tabTo('Menu')) { console.log('SETUP FAILED'); await b.close(); process.exit(2); }
await d.thumb('Jump', 70, 340);
await drainFI();
const pre = await kbState(b.page);
say('C-pre', pre.driving && pre.padFocused && !pre.padTakesSpace ? 'OK' : 'SETUP',
  `tabbed-once-then-thumbs: driving=${pre.driving} focus="${pre.focus}" padTakesSpace=${pre.padTakesSpace} playerMoves=${pre.playerMoves}`);

const t1 = await trip();
const fi1 = await drainFI();
const post = await kbState(b.page);
if (!t1.real) say('C-1', 'VOID', `the trip did not happen (${JSON.stringify(t1)}) — discarded, not reported as green`);
else say('C-1', post.driving === pre.driving ? 'FINE' : 'BROKEN',
  `nothing touched, no gesture, one trip to another tab and back: driving ${pre.driving} -> ${post.driving}, `
  + `padTakesSpace ${pre.padTakesSpace} -> ${post.padTakesSpace}, playerMoves ${pre.playerMoves} -> ${post.playerMoves}, `
  + `focusin the BROWSER authored = ${JSON.stringify(fi1)}  (${loadNow()})`);

await b.page.evaluate(() => WALLY.ctx.ui.closeAll()); await d.wait(280);
await d.key('Space', 30); await d.wait(380);
const top = await panelTop();
say('C-2', top ? 'BROKEN' : 'FINE',
  `HIS NEXT SPACE, on his thumbs, after coming back: ${top ? 'opened "'+top+'"' : 'jumped (no panel)'}  (${loadNow()})`);

/* ===== C-3: 5 of 5? ===== */
const runs = [];
for (let i = 0; i < 5; i++) {
  await arm();
  await d.tabTo('Menu');
  await d.thumb('Jump', 70, 300);
  const a = await kbState(b.page);
  const t = await trip(380);
  const z = await kbState(b.page);
  runs.push(!t.real ? 'VOID' : (a.driving && !z.driving ? 'FLIPPED' : `${a.driving}->${z.driving}`));
}
const flipped = runs.filter(r => r === 'FLIPPED').length;
const voids = runs.filter(r => r === 'VOID').length;
say('C-3', flipped ? 'BROKEN' : (voids === 5 ? 'VOID' : 'FINE'),
  `${flipped} of ${5 - voids} real trips took the keyboard off the game: [${runs.join(', ')}]  (${loadNow()})`);

/* ===== C-4: CONTROL — the keyboard parked OUTSIDE the pad region.
   If this flips too the finding is about trips, not about the region
   test. A real focusable outside the pad: open the pause sheet, whose
   root ui.js focuses, then close it is wrong (focus moves) — instead
   Tab to a HUD/menu control that is not inside .w-touch.        ===== */
await arm();
const outside = await b.page.evaluate(() => {
  const all = [...document.querySelectorAll('button, [tabindex]')]
    .filter(e => !e.closest('.w-touch') && e.getClientRects().length && !e.disabled);
  const el = all[0]; if (!el) return null;
  el.setAttribute('data-gb13', '1');
  return el.getAttribute('aria-label') || el.className || el.tagName;
});
if (!outside) say('C-4', 'VOID', 'no focusable control outside the pad root to park on');
else {
  await b.page.evaluate(() => WALLY.debug.kbFocus('sheet.input', '[data-gb13]'));
  await d.thumb('Jump', 70, 300);
  const a = await kbState(b.page);
  const t = await trip(380);
  const z = await kbState(b.page);
  say('C-4', !t.real ? 'VOID' : (a.driving === z.driving ? 'FINE' : 'BROKEN'),
    `CONTROL keyboard parked on "${outside}" OUTSIDE the pad: driving ${a.driving} -> ${z.driving}, `
    + `playerMoves ${a.playerMoves} -> ${z.playerMoves} — the arrival still counts document-wide, `
    + `but only a pad-region arrival moves the routing bit`);
}

const rep = await b.page.evaluate(() => WALLY.debug.kb());
say('C-5', 'NOTE', `guard=${rep.guard} violations=${rep.violations.length} — no focus() was dispatched, so the `
  + `runtime half is silent by construction; the static half scans src/ and the mover is Chrome.`);

console.log('\nERRORS: ' + (b.errs.length ? b.errs.join(' | ') : 'none'));
console.log('END   ' + loadNow('at end'));
await other.close(); await b.close();
