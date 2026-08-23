/* round six, probe 5: the keyboard theft the fix did NOT close.
   Focus reaches a pad button by the DELIBERATE route (Tab). Every
   later pad contact preventDefaults, so nothing takes the focus away,
   and the player's Space is still bound to that button. */
import { boot, boxes, padProbe2 } from '../_gb7/lib.mjs';

const t = await boot();
const { page, ok, multi } = t;
await padProbe2(page);
const b = await boxes(page);
const W = (ms) => page.waitForTimeout(ms);
const P = (x, y, id) => ({ x, y, id, radiusX: 14, radiusY: 14, force: 1 });

const focusNow = () => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return null;
  return (a.getAttribute?.('aria-label') || a.tagName + '.' + String(a.className||'')).trim();
});
const clearPanels = () => page.evaluate(() => { for (const n of WALLY.ctx.ui.panels.slice()) WALLY.ctx.ui.hide(n); });
async function tabTo(label, max = 26) {
  await page.evaluate(() => document.activeElement?.blur?.());
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await focusNow() === label) return true;
  }
  return false;
}
const tap = async (pt, id = 9, hold = 60) => {
  await multi('touchStart', [P(pt.x, pt.y, id)]); await W(hold); await multi('touchEnd', [P(pt.x, pt.y, id)]);
};

/* ---------- 5a. CONTROL: does a primary touch tap focus a bare button? ---------- */
console.log('--- MECH  is it the pad\'s preventDefault that suppresses the focus move? ---');
await page.evaluate(() => {
  const d = document.createElement('button');
  d.id = 'gb8ctl'; d.textContent = 'ctl';
  d.setAttribute('aria-label', 'GB8CONTROL');
  d.style.cssText = 'position:fixed;left:20px;top:120px;width:90px;height:44px;z-index:99999';
  document.body.appendChild(d);
  /* a second one that preventDefaults its own pointerdown, like the pad does */
  const p = d.cloneNode(true); p.id = 'gb8pd'; p.setAttribute('aria-label', 'GB8PREVENTED');
  p.style.top = '180px';
  p.addEventListener('pointerdown', (e) => e.preventDefault(), false);
  document.body.appendChild(p);
});
for (const [lab, y] of [['GB8CONTROL', 142], ['GB8PREVENTED', 202]]) {
  await page.evaluate(() => document.activeElement?.blur?.());
  await tap({ x: 65, y });
  await W(200);
  console.log(`  primary TOUCH tap on ${lab.padEnd(13)} -> focus is ${await focusNow()}`);
}
await page.evaluate(() => { document.getElementById('gb8ctl')?.remove(); document.getElementById('gb8pd')?.remove(); });

/* ---------- 5b. the theft, on every button, with a real finger ---------- */
console.log('\n--- PAD-43  a tabbed pad button keeps the keyboard across every later contact ---');
const VICTIMS = [['Menu', 'pause'], ['Phone', 'phone'], ['Desk', 'desk'], ['Places', 'phone']];
for (const [label, expect] of VICTIMS) {
  await clearPanels(); await W(600);
  if (!await tabTo(label)) { console.log(`  (could not Tab to ${label})`); continue; }
  await tap(b.jump);                              // a legitimate primary tap on JUMP
  await W(250);
  const stillFocused = await focusNow();
  const p0 = await page.evaluate(() => ({ panels: WALLY.ctx.ui.panels.slice(), sc: window.__pad.sc }));
  await page.keyboard.press('Space');             // the player means JUMP
  await W(500);
  const p1 = await page.evaluate(() => ({ panels: WALLY.ctx.ui.panels.slice(), sc: window.__pad.sc }));
  const stolen = p1.sc > p0.sc || p1.panels.length > p0.panels.length;
  ok(!stolen,
    `PAD-43 Tab->${label.padEnd(6)}, tap Jump, then SPACE must jump and not run ${label}'s verb`,
    `focus after the tap = ${stillFocused}; panels ${JSON.stringify(p1.panels)} (expected [] , ${label} opens "${expect}")`);
}

/* ---------- 5c. and with the THUMBSTICK, the control a player actually holds ---------- */
console.log('\n--- PAD-44  same, but the intervening contact is the thumbstick ---');
await clearPanels(); await W(600);
if (await tabTo('Menu')) {
  await multi('touchStart', [P(b.stick.x, b.stick.y, 3)]);
  await multi('touchMove', [P(b.stick.x, b.stick.y - 40, 3)]);
  await W(300);
  await multi('touchEnd', [P(b.stick.x, b.stick.y - 40, 3)]);
  await W(250);
  const f = await focusNow();
  const p0 = await page.evaluate(() => ({ panels: WALLY.ctx.ui.panels.slice(), sc: window.__pad.sc }));
  await page.keyboard.press('Space');
  await W(500);
  const p1 = await page.evaluate(() => ({ panels: WALLY.ctx.ui.panels.slice(), sc: window.__pad.sc }));
  ok(p1.sc === p0.sc && p1.panels.length === p0.panels.length,
    'PAD-44 Tab->Menu, WALK on the stick, then SPACE must jump and not open the pause sheet',
    `focus after the walk = ${f}; panels ${JSON.stringify(p1.panels)}`);
}

/* ---------- 5d. is it reachable WITHOUT Tab? does a sheet hand focus back? ---------- */
console.log('\n--- PAD-45  can focus land on a pad button without a Tab? ---');
await clearPanels(); await W(600);
await page.evaluate(() => document.activeElement?.blur?.());
await tap(b.sc.find(s => s.label === 'Menu'));    // open the pause sheet by FINGER
await W(900);
const fOpen = await focusNow();
await clearPanels(); await W(700);
const fClosed = await focusNow();
console.log(`  finger-tap Menu -> sheet open, focus = ${fOpen};  sheet closed, focus = ${fClosed}`);
ok(fClosed === null,
  'PAD-45 closing a finger-opened sheet leaves nothing in the pad focused',
  `focus = ${fClosed}`);

console.log(`\nFAILS ${t.fails}`);
console.log('ERRS', JSON.stringify(t.errs));
await t.close();
