/* round six, probe 2: PAD-30 — a GENUINE Tab to each pad button, then
   Space, then Enter, must still activate it. This is the assistive path. */
import { boot, boxes, padProbe2, vy } from '../_gb7/lib.mjs';

const t = await boot();
const { page, ok } = t;
await padProbe2(page);
const b = await boxes(page);
const W = (ms) => page.waitForTimeout(ms);

const focusNow = () => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return null;
  return (a.getAttribute?.('aria-label') || a.tagName + '.' + String(a.className||'')).trim();
});
const clearPanels = () => page.evaluate(() => { for (const n of WALLY.ctx.ui.panels.slice()) WALLY.ctx.ui.hide(n); });

/* ---------- 2a. can Tab reach the pad at all, and in what order? ---------- */
console.log('--- PAD-30a  the tab order through the pad ---');
await page.evaluate(() => document.activeElement?.blur?.());
const order = [];
for (let i = 0; i < 24; i++) {
  await page.keyboard.press('Tab');
  const f = await focusNow();
  order.push(f);
  if (order.filter(x => x === f).length > 2) break;
}
console.log('TAB ORDER', JSON.stringify(order));
const padLabels = ['Jump', 'Enter or talk', 'Phone', 'Places', 'Desk', 'Menu'];
const reached = padLabels.filter(l => order.includes(l));
ok(reached.length === padLabels.length,
  `PAD-30a Tab reaches every pad button (${reached.length}/${padLabels.length})`,
  `missing ${JSON.stringify(padLabels.filter(l => !order.includes(l)))}`);

/* ---------- 2b. Tab to each button, then Space / Enter ---------- */
/* THE TAB ORDER IS NOT STABLE — the HUD's notification pills enter and
   leave it — so an index walk measured once drifts. Check every step. */
async function tabTo(label, max = 26) {
  await page.evaluate(() => document.activeElement?.blur?.());
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await focusNow() === label) return true;
  }
  return false;
}
async function peakVy(ms = 600) {
  let peak = 0; const end = Date.now() + ms;
  while (Date.now() < end) { const v = await vy(page); if (v !== null && v > peak) peak = v; }
  return +peak.toFixed(2);
}
async function ground() {
  for (let i = 0; i < 40; i++) { const v = await vy(page); if (v !== null && Math.abs(v) < 0.02) return true; await W(100); }
  return false;
}

console.log('\n--- PAD-30b  Tab then Space / Enter must run the verb ---');
for (const key of ['Space', 'Enter']) {
  for (const label of ['Phone', 'Places', 'Desk', 'Menu', 'Enter or talk']) {
    await clearPanels(); await W(600);
    const got = await tabTo(label);
    if (!got) { ok(false, `PAD-30b Tab could not reach ${label}`); continue; }
    const p0 = await page.evaluate(() => ({ panels: WALLY.ctx.ui.panels.slice(), sc: window.__pad.sc, act: window.__pad.act }));
    await page.keyboard.press(key);
    await W(450);
    const p1 = await page.evaluate(() => ({ panels: WALLY.ctx.ui.panels.slice(), sc: window.__pad.sc, act: window.__pad.act }));
    const fired = (p1.sc > p0.sc) || (p1.act > p0.act) || (p1.panels.length > p0.panels.length);
    ok(fired, `PAD-30b Tab->${key.padEnd(5)} on ${label.padEnd(13)} runs the verb`,
      `sc ${p0.sc}->${p1.sc} act ${p0.act}->${p1.act} panels ${JSON.stringify(p1.panels)}`);
  }
}

/* ---------- 2c. Tab to Jump, then Space / Enter, must leave the ground ---------- */
console.log('\n--- PAD-30c  Tab to Jump then Space / Enter ---');
for (const key of ['Space', 'Enter']) {
  await clearPanels(); await W(600); await ground();
  const got = await tabTo('Jump');
  if (!got) { ok(false, `PAD-30c Tab could not reach Jump`); continue; }
  await page.keyboard.press(key);
  const pk = await peakVy(700);
  ok(pk > 1, `PAD-30c Tab->${key.padEnd(5)} on Jump leaves the ground`, `peak vy ${pk}`);
  await W(1400);
}

/* ---------- 2d. does a PRIMARY tap on the pad steal/keep focus? ---------- */
console.log('\n--- PAD-36  a primary tap while a pad button holds focus ---');
await clearPanels(); await W(600);
const gotMenu = await tabTo('Menu');
console.log('reached Menu by Tab:', gotMenu);
const fA = await focusNow();
await t.press(b.jump.x, b.jump.y, 60);          // real touch tap on Jump
await W(250);
const fB = await focusNow();
console.log(`focus before tap = ${fA}   after a primary TOUCH tap on Jump = ${fB}`);
await ground();
const p0 = await page.evaluate(() => ({ panels: WALLY.ctx.ui.panels.slice(), sc: window.__pad.sc }));
await page.keyboard.press('Space');
const pk = await peakVy(700);
const p1 = await page.evaluate(() => ({ panels: WALLY.ctx.ui.panels.slice(), sc: window.__pad.sc }));
console.log(`then Space -> peak vy ${pk}, sc ${p0.sc}->${p1.sc}, panels ${JSON.stringify(p1.panels)}`);
ok(p1.sc === p0.sc && p1.panels.length === p0.panels.length,
  'PAD-36 Space after a primary tap elsewhere on the pad runs no stale verb',
  `focus stayed ${fB}`);

console.log(`\nFAILS ${t.fails}`);
console.log('ERRS', JSON.stringify(t.errs));
await t.close();
