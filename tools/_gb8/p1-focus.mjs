/* round six, probe 1: after a REFUSED secondary press on every control,
   is anything focused, and does the keyboard still belong to the game? */
import { boot, boxes, padProbe2, vy } from '../_gb7/lib.mjs';

const t = await boot();
const { page, ok, mousePress } = t;
await padProbe2(page);
const b = await boxes(page);
const W = (ms) => page.waitForTimeout(ms);

/* keep the document alive under a back/forward press (round-five trick) */
const stackHistory = () => page.evaluate(() => {
  if (location.hash !== '#gb8b') { history.pushState({}, '', '#gb8a'); history.pushState({}, '', '#gb8b'); }
  return location.hash;
});
const alive = async () => await page.evaluate(() => !!window.WALLY).catch(() => false);

const CONTROLS = [
  ['stick', b.stick], ['Jump', b.jump], ['Enter', b.act],
  ...b.sc.map(s => [s.label, s]),
];
console.log('CONTROLS', CONTROLS.map(c => c[0]).join(', '));

const focusNow = () => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return null;
  return (a.getAttribute?.('aria-label') || a.tagName + '.' + String(a.className||'')).trim();
}).catch(() => 'DEAD');
const blur = () => page.evaluate(() => { document.activeElement?.blur?.(); }).catch(()=>{});

/* ---------- 1a. focus after a refused press ---------- */
console.log('\n--- PAD-31  refused secondary press must not focus ---');
for (const [name, box] of CONTROLS) {
  for (const btn of ['right', 'middle', 'back', 'forward']) {
    await stackHistory(); await blur();
    await mousePress(box.x, box.y, btn, 60);
    await W(150);
    if (!await alive()) { console.log(`NAV   ${btn} on ${name}: document torn down — cannot discriminate`); continue; }
    const f = await focusNow();
    ok(f === null, `PAD-31 ${btn.padEnd(7)} press on ${name.padEnd(6)} focuses nothing`, f ? `focus=${f}` : '');
  }
}

/* ---------- 1b. after a refused press, Space still jumps ---------- */
console.log('\n--- PAD-32/33  Space after a refused press is still JUMP, and runs no verb ---');
async function peakVy(ms = 600) {
  let peak = 0; const end = Date.now() + ms;
  while (Date.now() < end) { const v = await vy(page); if (v !== null && v > peak) peak = v; }
  return +peak.toFixed(2);
}
async function ground() {
  for (let i = 0; i < 40; i++) { const v = await vy(page); if (v !== null && Math.abs(v) < 0.02) return true; await W(100); }
  return false;
}
const clearPanels = () => page.evaluate(() => { for (const n of WALLY.ctx.ui.panels.slice()) WALLY.ctx.ui.hide(n); }).catch(()=>{});

await ground();
await page.keyboard.down('Space');
const baseJump = await peakVy(600);
await page.keyboard.up('Space');
ok(baseJump > 1, 'PAD-32a control: Space with nothing focused jumps', `peak vy ${baseJump}`);
await W(1500); await ground();

for (const [name, box] of CONTROLS) {
  await stackHistory(); await blur();
  await mousePress(box.x, box.y, 'right', 60);
  await W(150);
  const p0 = await page.evaluate(() => ({ panels: WALLY.ctx.ui.panels.slice(), sc: window.__pad.sc, act: window.__pad.act }));
  await page.keyboard.down('Space');
  const pk = await peakVy(600);
  await page.keyboard.up('Space');
  const p1 = await page.evaluate(() => ({ panels: WALLY.ctx.ui.panels.slice(), sc: window.__pad.sc, act: window.__pad.act }));
  ok(pk > 1, `PAD-32 right on ${name.padEnd(6)} then Space -> JUMPS`, `peak vy ${pk}`);
  ok(p1.sc === p0.sc && p1.act === p0.act && p1.panels.length === p0.panels.length,
    `PAD-33 right on ${name.padEnd(6)} then Space -> NO verb`,
    `sc ${p0.sc}->${p1.sc} act ${p0.act}->${p1.act} panels ${JSON.stringify(p1.panels)}`);
  await clearPanels(); await W(1200); await ground();
}

/* ---------- 1c. after a refused press, Enter runs nothing ---------- */
console.log('\n--- PAD-34  Enter after a refused press runs no verb ---');
for (const [name, box] of CONTROLS) {
  await stackHistory(); await blur();
  await mousePress(box.x, box.y, 'right', 60);
  await W(150);
  const p0 = await page.evaluate(() => ({ panels: WALLY.ctx.ui.panels.slice(), sc: window.__pad.sc, act: window.__pad.act }));
  await page.keyboard.press('Enter');
  await W(400);
  const p1 = await page.evaluate(() => ({ panels: WALLY.ctx.ui.panels.slice(), sc: window.__pad.sc, act: window.__pad.act }));
  ok(p1.sc === p0.sc && p1.act === p0.act && p1.panels.length === p0.panels.length,
    `PAD-34 right on ${name.padEnd(6)} then Enter -> no verb`,
    `sc ${p0.sc}->${p1.sc} act ${p0.act}->${p1.act} panels ${JSON.stringify(p1.panels)}`);
  await clearPanels(); await W(300);
}

/* ---------- 1d. does the pad now swallow the browser's back button? ---------- */
console.log('\n--- PAD-35  whose navigation is the back button? ---');
for (const [label, box] of [['pad Enter', b.act], ['pad stick', b.stick], ['bare canvas', { x: 195, y: 300 }]]) {
  await page.evaluate(() => { history.pushState({}, '', '#gb8a'); history.pushState({}, '', '#gb8b'); }).catch(()=>{});
  await W(150);
  await mousePress(box.x, box.y, 'back', 70);
  await W(450);
  const h = await page.evaluate(() => location.hash).catch(() => 'DEAD');
  console.log(`BACK-nav [${label.padEnd(11)}] hash after a back press = ${h}   (started #gb8b)`);
}

console.log(`\nFAILS ${t.fails}`);
console.log('ERRS', JSON.stringify(t.errs));
await t.close();
