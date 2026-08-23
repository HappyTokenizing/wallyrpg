/* P4b — the keyboard against the FADE, with the clock actually running.
   (In p4 a stray dialogue was suspending stage two, so nothing faded and
   the two assertions built on it measured nothing. Attribution: my
   harness. Here the dialogue is closed and the state is re-read.) */
import { boot, instrument, arm, stop, padGeom, hand, toDoor, keyPress, reporter, verbList, count } from './lib.mjs';

const R = reporter();
const B = await boot();
const { page, cdp } = B;
await instrument(page);
const H = hand(cdp, page);
const active = () => page.evaluate(() => {
  const a = document.activeElement;
  return a ? (a.tagName.toLowerCase() + (a.getAttribute && a.getAttribute('aria-label') ? '[' + a.getAttribute('aria-label') + ']' : '') + '.' + String(a.className || '').trim().split(/\s+/).join('.')) : 'null';
});
const tab = async () => { await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' }); };
const clear = () => page.evaluate(() => {
  const ui = WALLY.ctx.ui;
  ui.closeAll(); ui.hide('dialogue');
  return { panels: ui.panels.slice(), dlg: ui.dialogueOpen };
});

await toDoor(page);
let c = await clear();
await page.evaluate(() => { WALLY.debug.hideUI(true); WALLY.debug.idle(1.2); return null; });
await page.waitForTimeout(500);
R.ok(c.panels.length === 0 && c.dlg === false, 'P4b-0 nothing is suspending the clock', JSON.stringify(c));

/* focus Enter, then hold still until it fades under the focus ring */
await page.evaluate(() => document.querySelector('.w-abtn.act').focus({ preventScroll: true }));
const before = await active();
await page.waitForTimeout(2600);
const idleNow = await page.evaluate(() => WALLY.debug.idle());
const after = await active();
console.log(`   focus before ${before}\n   focus after  ${after}\n   idle ${JSON.stringify(idleNow)}`);
R.ok(idleNow.hidden === true, 'P4b-1 the controls faded with focus sitting on Enter', `hidden ${idleNow.hidden} why ${idleNow.why}`);

await arm(page);
await keyPress(cdp, 'Enter');
await page.waitForTimeout(900);
let r = await stop(page);
const idleAfter = await page.evaluate(() => WALLY.debug.idle());
R.ok(count(r, 'padpress') === 0 && r.panels.length === 0,
  'P4b-2 a keyboard Enter on a FADED-OUT Enter button fires nothing',
  `focus ${after} verbs ${verbList(r) || 'none'} panels ${JSON.stringify(r.panels)} hidden ${idleAfter.hidden}`);

/* can Tab reach it while faded? */
await page.evaluate(() => document.body.focus());
let reached = null;
for (let k = 0; k < 40 && !reached; k++) {
  await tab();
  const a = await active();
  if (a.includes('w-abtn')) reached = { k: k + 1, a };
}
const idle3 = await page.evaluate(() => WALLY.debug.idle());
R.ok(idle3.hidden === true, 'P4b-3a still faded through the tab sweep', `hidden ${idle3.hidden} why ${idle3.why}`);
R.ok(!reached,
  'P4b-3b while faded, Tab cannot reach the pad (it is out of the tab order)',
  reached ? `reached ${reached.a} after ${reached.k} tabs` : '40 tabs, never reached');

/* and the pad still answers the keyboard once it is back */
await H.down(1, 195, 300); await H.up(1);
await H.wait(90);
await H.down(1, 195, 300); await H.up(1);
await H.wait(1200);
const idle4 = await page.evaluate(() => WALLY.debug.idle());
await page.evaluate(() => document.querySelector('.w-abtn.act').focus({ preventScroll: true }));
await arm(page);
await keyPress(cdp, 'Enter');
await page.waitForTimeout(900);
r = await stop(page);
R.ok(idle4.hidden === false && count(r, 'padpress') === 1,
  'P4b-4 ...and once woken, the keyboard reaches it again',
  `hidden ${idle4.hidden} verbs ${verbList(r) || 'none'} panels ${JSON.stringify(r.panels)}`);

console.log(`\n${R.fails} failure(s). page errors: ${B.errs.length}`, B.errs.slice(0, 6).join(' | '));
await B.close();
