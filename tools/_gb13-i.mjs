/* GB13-I — A SHEET CLOSED BY OPENING ANOTHER.
   focusReturn is banked by the FIRST panel only and nulled when it is
   spent. If a second sheet REPLACES the first, the replace spends the
   address; the second sheet's close then has nothing to hand back and
   the player who deliberately focused a control ends on <body>.
   Control arm: the identical gesture with ONE sheet. */
import { boot, driver, loadNow, kbState } from './_gb13-lib.mjs';
const say = (id, v, note) => console.log(`${v.padEnd(7)} ${id}  ${note}`);
const b = await boot();
const d = driver(b.page, b.cdp);
await b.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
await b.page.bringToFront(); await d.wait(250);
console.log('BOOT  ' + loadNow('at boot'));
const arm = async () => { await b.page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.kbReset(); }); await d.wait(340); };
const stampFocus = () => b.page.evaluate(() => {
  document.querySelectorAll('[data-gb13me]').forEach(e => e.removeAttribute('data-gb13me'));
  const a = document.activeElement; if (!a || a === document.body) return null;
  a.setAttribute('data-gb13me', '1');
  return a.getAttribute('aria-label') || (a.textContent||'').trim().slice(0,18) || a.className;
});
const backHome = () => b.page.evaluate(() => {
  const m = document.querySelector('[data-gb13me]');
  const a = document.activeElement;
  return { home: !!m && a === m, alive: !!m && m.isConnected,
    onBody: !a || a === document.body,
    endedOn: a && a !== document.body ? (a.getAttribute?.('aria-label') || (a.textContent||'').trim().slice(0,18) || a.className) : null };
});
const rec = () => b.page.evaluate(() => WALLY.debug.focusRestore());
const panels = () => b.page.evaluate(() => WALLY.ctx.ui.panels.slice());

/* ---- CONTROL: one sheet. Tab to Menu, open pause, Escape. ---- */
async function oneSheet() {
  await arm();
  if (!await d.tabTo('Menu')) return null;
  const mine = await stampFocus();
  await d.thumb('Menu', 70, 450);
  const p1 = await panels();
  await d.key('Escape', 25); await d.wait(1000);
  return { mine, p1, ...(await backHome()), rec: await rec(), kb: await kbState(b.page) };
}
/* ---- THE CASE: a second sheet REPLACES the first, then Escape. ---- */
async function swapped(second) {
  await arm();
  if (!await d.tabTo('Menu')) return null;
  const mine = await stampFocus();
  await d.thumb('Menu', 70, 450);
  const p1 = await panels();
  await b.page.evaluate((s) => WALLY.debug.ui(s), second);
  await d.wait(500);
  const p2 = await panels();
  await d.key('Escape', 25); await d.wait(1000);
  return { mine, p1, p2, ...(await backHome()), rec: await rec(), kb: await kbState(b.page) };
}

const c = await oneSheet();
say('I-1', c && c.home ? 'FINE' : 'BROKEN',
  `CONTROL one sheet: tabbed to "${c?.mine}", opened ${JSON.stringify(c?.p1)}, Escape -> `
  + `back on the same node=${c?.home} ended="${c?.endedOn}" onBody=${c?.onBody} `
  + `site=${c?.rec?.site} landed=${c?.rec?.landed} attempts=${c?.rec?.attempts}  (${loadNow()})`);

for (const second of ['phone', 'map']) {
  const s = await swapped(second);
  if (!s) { say('I-2:' + second, 'VOID', 'no Tab to Menu'); continue; }
  say('I-2:' + second, s.home ? 'FINE' : (s.onBody ? 'BROKEN' : 'SUSPECT'),
    `tabbed to "${s.mine}", opened ${JSON.stringify(s.p1)}, then "${second}" REPLACED it ${JSON.stringify(s.p2)}, `
    + `Escape -> back on the same node=${s.home} (still alive=${s.alive}) ended="${s.endedOn}" onBody=${s.onBody}; `
    + `last hand-back site=${s.rec?.site} to="${s.rec?.to}" landed=${s.rec?.landed}  (${loadNow()})`);
}

/* ---- and the same shape driven with a THUMB on the pad's own
   shortcut buttons, which is how a player would really do it ---- */
await arm();
await d.tabTo('Menu');
const mine3 = await stampFocus();
await d.thumb('Menu', 70, 450);
const q1 = await panels();
await d.thumb('Phone', 70, 500);
const q2 = await panels();
await d.key('Escape', 25); await d.wait(1000);
const v3 = await backHome();
say('I-3', v3.home ? 'FINE' : (v3.onBody ? 'BROKEN' : 'SUSPECT'),
  `THUMB-driven: tabbed to "${mine3}", thumb Menu ${JSON.stringify(q1)}, thumb Phone ${JSON.stringify(q2)}, `
  + `Escape -> home=${v3.home} ended="${v3.endedOn}" onBody=${v3.onBody}  (${loadNow()})`);

const rep = await b.page.evaluate(() => WALLY.debug.kb());
say('I-4', rep.violations.length === 0 ? 'FINE' : 'BROKEN',
  `after every path above: violations=${rep.violations.length}`);

console.log('\nERRORS: ' + (b.errs.length ? b.errs.join(' | ') : 'none'));
console.log('END   ' + loadNow('at end'));
await b.close();
