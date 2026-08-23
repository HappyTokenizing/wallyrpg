/* round six, probe 3: the things preventDefault-first could plausibly
   have changed — two thumbs on Jump, the focus exposure window, the
   compat click, and focus movement through the rest of the UI. */
import { boot, boxes, padProbe2 } from '../_gb7/lib.mjs';

const t = await boot();
const { page, ok, multi, cdp } = t;
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
const posY = () => page.evaluate(() => {
  const w = WALLY.ctx.wally;
  const o = w?.root || w?.group || w?.object || w?.model;
  return o ? +o.position.y.toFixed(3) : null;
});
const jstate = () => page.evaluate(() => {
  const s = WALLY.debug.touchState();
  return { jump: s.jump, down: document.querySelector('.w-abtn.jump')?.classList.contains('down') };
});
async function apex(ms) {
  let peak = -1e9; const end = Date.now() + ms;
  while (Date.now() < end) { const y = await posY(); if (y !== null && y > peak) peak = y; }
  return +peak.toFixed(3);
}
async function ground() {
  let last = null;
  for (let i = 0; i < 50; i++) { const y = await posY(); if (y !== null && last !== null && Math.abs(y-last) < 0.002) return y; last = y; await W(100); }
  return last;
}

/* ---------- 3a. variable jump height, one thumb ---------- */
console.log('--- PAD-37  variable jump height still varies ---');
const g0 = await ground();
console.log('ground y =', g0);
const heights = {};
for (const hold of [60, 500]) {
  await ground();
  await multi('touchStart', [P(b.jump.x, b.jump.y, 1)]);
  await W(hold);
  await multi('touchEnd', []);
  heights[hold] = await apex(900);
  await W(1400);
}
console.log('apex short(60ms) =', heights[60], ' apex long(500ms) =', heights[500]);
ok(heights[500] > heights[60] + 0.05,
  'PAD-37 a long hold on Jump goes higher than a short tap',
  `short ${heights[60]}  long ${heights[500]}  ground ${g0}`);

/* ---------- 3b. two thumbs on Jump, each lifting first ---------- */
console.log('\n--- PAD-38  two thumbs on Jump ---');
/* B lifts first: the resting second thumb must NOT cancel A's held jump */
await ground();
await multi('touchStart', [P(b.jump.x - 8, b.jump.y, 1)]);            // A owns it
await W(70);
await multi('touchStart', [P(b.jump.x - 8, b.jump.y, 1), P(b.jump.x + 8, b.jump.y, 2)]);  // B rests
await W(70);
const heldBoth = await jstate();
await multi('touchEnd', [P(b.jump.x - 8, b.jump.y, 1)]);              // B lifts, A stays
await W(60);
const afterBup = await jstate();
ok(afterBup.jump === true || afterBup.down === true,
  'PAD-38a the resting second thumb lifting does NOT cancel the held jump',
  `both=${JSON.stringify(heldBoth)} afterBlift=${JSON.stringify(afterBup)}`);
await multi('touchEnd', []);                                          // A lifts
await W(60);
const afterAup = await jstate();
ok(afterAup.jump === false && afterAup.down === false,
  'PAD-38b the owning thumb lifting DOES release it', JSON.stringify(afterAup));
const apexB = await apex(900); await W(1400);

/* A lifts first, B still resting: jump must release (A owned it) */
await ground();
await multi('touchStart', [P(b.jump.x - 8, b.jump.y, 1)]);
await W(70);
await multi('touchStart', [P(b.jump.x - 8, b.jump.y, 1), P(b.jump.x + 8, b.jump.y, 2)]);
await W(70);
await multi('touchEnd', [P(b.jump.x + 8, b.jump.y, 2)]);              // A lifts, B stays
await W(60);
const afterAfirst = await jstate();
ok(afterAfirst.jump === false && afterAfirst.down === false,
  'PAD-38c the owner lifting first releases even with a thumb still resting',
  JSON.stringify(afterAfirst));
await multi('touchEnd', []);
await W(1400);

/* and the height of a two-thumb hold matches a one-thumb hold */
await ground();
await multi('touchStart', [P(b.jump.x - 8, b.jump.y, 1)]);
await W(70);
await multi('touchStart', [P(b.jump.x - 8, b.jump.y, 1), P(b.jump.x + 8, b.jump.y, 2)]);
await W(430);
await multi('touchEnd', []);
const apex2 = await apex(900);
ok(apex2 > heights[60] + 0.05,
  'PAD-38d a 500 ms two-thumb hold still gets the FULL jump',
  `two-thumb ${apex2}  one-thumb long ${heights[500]}  short ${heights[60]}`);
await W(1400);

/* ---------- 3c. how long does a Tab-borne focus survive? ---------- */
console.log('\n--- PAD-36b  what clears a pad button focus ---');
async function tabTo(label, max = 26) {
  await page.evaluate(() => document.activeElement?.blur?.());
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await focusNow() === label) return true;
  }
  return false;
}
for (const [what, act] of [
  ['a touch tap on the CANVAS',    async () => { await multi('touchStart', [P(195, 300, 9)]); await W(60); await multi('touchEnd', []); }],
  ['a touch tap on the STICK',     async () => { await multi('touchStart', [P(b.stick.x, b.stick.y, 9)]); await W(60); await multi('touchEnd', []); }],
  ['a touch tap on JUMP',          async () => { await multi('touchStart', [P(b.jump.x, b.jump.y, 9)]); await W(60); await multi('touchEnd', []); }],
  ['a MOUSE click on the CANVAS',  async () => { await t.mousePress(195, 300, 'left', 60); }],
]) {
  await clearPanels(); await W(500);
  const got = await tabTo('Menu');
  if (!got) { console.log(`  (could not Tab to Menu for "${what}")`); continue; }
  await act();
  await W(250);
  const f = await focusNow();
  console.log(`  Tab->Menu, then ${what.padEnd(28)} -> focus is ${f === null ? 'CLEARED' : f}`);
}

/* ---------- 3d. focus still moves through sheets / phone / settings ---------- */
console.log('\n--- PAD-39  focus through the rest of the UI ---');
for (const [name, open] of [
  ['phone',    () => page.evaluate(() => WALLY.ctx.ui.openPhone())],
  ['desk',     () => page.evaluate(() => WALLY.ctx.ui.openDesk())],
  ['pause',    () => page.evaluate(() => WALLY.ctx.ui.show('pause'))],
]) {
  await clearPanels(); await W(400);
  await open(); await W(900);
  await page.evaluate(() => document.activeElement?.blur?.());
  const seen = [];
  for (let i = 0; i < 10; i++) { await page.keyboard.press('Tab'); seen.push(await focusNow()); }
  const distinct = [...new Set(seen.filter(Boolean))];
  ok(distinct.length >= 2, `PAD-39 Tab still moves inside the ${name} sheet`,
    `${distinct.length} distinct stops: ${JSON.stringify(distinct.slice(0, 6))}`);
}
await clearPanels();

console.log(`\nFAILS ${t.fails}`);
console.log('ERRS', JSON.stringify(t.errs));
await t.close();
