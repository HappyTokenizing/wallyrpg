/* round six, probe 4: two thumbs on Jump, done with the CORRECT CDP
   convention (touchEnd carries the points being RELEASED) and an
   IN-PAGE rAF apex sampler, so neither box load nor round-trip latency
   can decide the answer. */
import { boot, boxes, padProbe2 } from '../_gb7/lib.mjs';

const t = await boot();
const { page, ok, multi } = t;
await padProbe2(page);
const b = await boxes(page);
const W = (ms) => page.waitForTimeout(ms);
const P = (x, y, id) => ({ x, y, id, radiusX: 14, radiusY: 14, force: 1 });

/* in-page sampler: every rAF, record y and vy */
await page.evaluate(() => {
  window.__jm = { on: false, maxY: -1e9, minY: 1e9, maxVy: -1e9, n: 0 };
  const obj = () => { const w = WALLY.ctx.wally; return w?.root || w?.group || w?.object || w?.model; };
  const ctrl = () => WALLY.ctx.wally?.controller;
  const tick = () => {
    if (window.__jm.on) {
      const o = obj(), c = ctrl();
      if (o) { window.__jm.maxY = Math.max(window.__jm.maxY, o.position.y);
               window.__jm.minY = Math.min(window.__jm.minY, o.position.y); }
      const v = c && (c.velocity || c.vel);
      if (v) window.__jm.maxVy = Math.max(window.__jm.maxVy, v.y);
      window.__jm.n++;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const armS = () => page.evaluate(() => { window.__jm = { on: true, maxY: -1e9, minY: 1e9, maxVy: -1e9, n: 0 }; });
const readS = () => page.evaluate(() => ({ rise: +(window.__jm.maxY - window.__jm.minY).toFixed(3),
  maxVy: +window.__jm.maxVy.toFixed(2), n: window.__jm.n, on: (window.__jm.on = false) }));
const jstate = () => page.evaluate(() => ({ ...WALLY.debug.touchState().jump,
  down: document.querySelector('.w-abtn.jump')?.classList.contains('down'),
  ctrlHeld: !!(WALLY.ctx.wally?.controller?.input?.jumpHeld) }));
const settle = async () => { await W(1800); };

/* ---------- 4a. variable jump height, one thumb ---------- */
console.log('--- PAD-40  variable jump height ---');
const rise = {};
for (const hold of [60, 550]) {
  await settle(); await armS();
  await multi('touchStart', [P(b.jump.x, b.jump.y, 1)]);
  await W(hold);
  await multi('touchEnd', [P(b.jump.x, b.jump.y, 1)]);
  await W(1100);
  rise[hold] = await readS();
  console.log(`  hold ${hold}ms -> rise ${rise[hold].rise}  maxVy ${rise[hold].maxVy}  (${rise[hold].n} frames)`);
}
ok(rise[550].rise > rise[60].rise + 0.05,
  'PAD-40 a long hold on Jump rises higher than a short tap (variable jump height)',
  `short ${rise[60].rise}  long ${rise[550].rise}`);

/* ---------- 4b. two thumbs, the NON-OWNER lifts first ---------- */
console.log('\n--- PAD-41  two thumbs on Jump, non-owner lifts first ---');
await settle(); await armS();
await multi('touchStart', [P(b.jump.x - 8, b.jump.y, 1)]);              // A takes it
await W(70);
const owner0 = await jstate();
await multi('touchStart', [P(b.jump.x - 8, b.jump.y, 1), P(b.jump.x + 8, b.jump.y, 2)]);  // B rests
await W(70);
const both = await jstate();
await multi('touchEnd', [P(b.jump.x + 8, b.jump.y, 2)]);               // B (non-owner) LIFTS
await W(80);
const afterB = await jstate();
ok(afterB.held === true && afterB.id === owner0.id,
  'PAD-41 the resting second thumb lifting does NOT cancel the held jump',
  `owner ${owner0.id} -> ${afterB.id}, held ${afterB.held}, ctrlHeld ${afterB.ctrlHeld}`);
await W(400);
await multi('touchEnd', [P(b.jump.x - 8, b.jump.y, 1)]);               // A lifts
await W(80);
const afterA = await jstate();
ok(afterA.held === false && afterA.id === null,
  'PAD-41b the OWNER lifting does let go', JSON.stringify(afterA));
await W(1100);
const r41 = await readS();
console.log(`  two-thumb ~550ms hold -> rise ${r41.rise}  maxVy ${r41.maxVy}`);
ok(r41.rise > rise[60].rise + 0.05,
  'PAD-41c a two-thumb hold still gets the FULL variable-height jump',
  `two-thumb ${r41.rise}  one-thumb long ${rise[550].rise}  short ${rise[60].rise}`);

/* ---------- 4c. two thumbs, the OWNER lifts first ---------- */
console.log('\n--- PAD-42  two thumbs on Jump, owner lifts first ---');
await settle(); await armS();
await multi('touchStart', [P(b.jump.x - 8, b.jump.y, 1)]);
await W(70);
const o2 = await jstate();
await multi('touchStart', [P(b.jump.x - 8, b.jump.y, 1), P(b.jump.x + 8, b.jump.y, 2)]);
await W(70);
await multi('touchEnd', [P(b.jump.x - 8, b.jump.y, 1)]);               // A (owner) LIFTS
await W(80);
const afterOwner = await jstate();
ok(afterOwner.held === false && afterOwner.id === null,
  'PAD-42 the owner lifting first releases even with a thumb still on the glass',
  `owner ${o2.id} -> ${afterOwner.id}, held ${afterOwner.held}`);
await W(300);
const stillResting = await jstate();
ok(stillResting.held === false && stillResting.id === null,
  'PAD-42b the still-resting thumb does not re-latch the jump', JSON.stringify(stillResting));
await multi('touchEnd', [P(b.jump.x + 8, b.jump.y, 2)]);               // B lifts late
await W(80);
const afterLate = await jstate();
ok(afterLate.held === false && afterLate.id === null,
  'PAD-42c and the late lift of the resting thumb re-latches nothing', JSON.stringify(afterLate));
await readS();

console.log(`\nFAILS ${t.fails}`);
console.log('ERRS', JSON.stringify(t.errs));
await t.close();
