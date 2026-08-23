/* PROBE 3 — two things probe 1 could not finish.

   (a) D1. A MOUSE PRIMARY press on Enter at the apartment door entered
       ui.interact() (act 1) and opened nothing, toasted nothing. That is
       the exact shape of the "silent no-op" PAD-25/26 was built to make
       falsifiable, and this time it came out of a long sweep. Repeat it
       with WALLY.debug.interact() read every time.

   (b) I. A mouse BACK-button press over the pad navigated the page away
       from the game. Discriminate: does the same press on the CANVAS do
       it too? If it does, it is Chrome, not the pad. */
import { boot, padProbe, padRead, panelsNow, nearId, boxes } from './lib.mjs';

const R = await boot({ mobile: true });
const { page, ok, mouseAt, mousePress, mouseDrag, press } = R;

const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const toOpenGround = () => page.evaluate((b) => {
  WALLY.ctx.ui.closeAll(); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {});
}, BOOT);
const toDoor = async () => {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.arrive('apartment', true); });
  await page.waitForTimeout(1200);
  try { await page.waitForFunction(() => WALLY.ctx.ui.near != null, { timeout: 5000 }); } catch {}
  await page.waitForTimeout(300);
  return nearId(page);
};
const closeAll = async () => { await page.evaluate(() => WALLY.ctx.ui.closeAll()); await page.waitForTimeout(400); };
const why = () => page.evaluate(() => WALLY.debug.interact?.() ?? null);

await page.evaluate(() => WALLY.debug.hideUI(false));
await page.waitForTimeout(500);
const B = await boxes(page);

/* ---------- (a) the silent no-op ---------- */
console.log('--- (a) mouse primary on Enter at the door, 6 plain repeats ---');
for (let i = 0; i < 6; i++) {
  const d = await toDoor();
  await padProbe(page);
  await mousePress(B.act.x, B.act.y, 'left', 60);
  await page.waitForTimeout(900);
  const p = await padRead(page), pn = await panelsNow(page), w = await why();
  ok(d !== null && p.act === 1 && pn.includes('place'),
    `Sa${i} [mouse primary on Enter at a door] opens`,
    `near ${d}, act ${p.act}, panels ${JSON.stringify(pn)}, toasts ${JSON.stringify(p.toasts)}, why ${JSON.stringify(w)}`);
  await closeAll();
}

console.log('--- (a2) the same, each preceded by the right-drag on the stick that sat in front of the failure ---');
for (let i = 0; i < 4; i++) {
  await toOpenGround(); await page.waitForTimeout(400);
  await mouseDrag(B.stick.x, B.stick.y, 0, -70, 'right', 5);
  await page.waitForTimeout(400);
  await closeAll();
  const d = await toDoor();
  await padProbe(page);
  await mousePress(B.act.x, B.act.y, 'left', 60);
  await page.waitForTimeout(900);
  const p = await padRead(page), pn = await panelsNow(page), w = await why();
  ok(d !== null && p.act === 1 && pn.includes('place'),
    `Sb${i} [right-drag on the stick, then a mouse primary on Enter] opens`,
    `near ${d}, act ${p.act}, panels ${JSON.stringify(pn)}, toasts ${JSON.stringify(p.toasts)}, why ${JSON.stringify(w)}`);
  await closeAll();
}

console.log('--- (a3) the same with a FINGER, for the comparison ---');
for (let i = 0; i < 3; i++) {
  const d = await toDoor();
  await padProbe(page);
  await press(B.act.x, B.act.y, 60);
  await page.waitForTimeout(900);
  const p = await padRead(page), pn = await panelsNow(page), w = await why();
  ok(d !== null && p.act === 1 && pn.includes('place'),
    `Sc${i} [finger on Enter at a door] opens`,
    `near ${d}, act ${p.act}, panels ${JSON.stringify(pn)}, why ${JSON.stringify(w)}`);
  await closeAll();
}

/* ---------- (b) the back button ---------- */
console.log('--- (b) the mouse back button: pad vs canvas ---');
await toOpenGround(); await page.waitForTimeout(400);
/* give the document a history entry of its own so a back press pops
   rather than leaving the game — then popstate is the measurement */
await page.evaluate(() => {
  window.__pop = 0;
  addEventListener('popstate', () => { window.__pop++; });
  history.pushState({ gb5: 1 }, '', location.href);
  history.pushState({ gb5: 2 }, '', location.href);
});
const popsBefore = await page.evaluate(() => window.__pop);
await mousePress(240, 300, 'back', 60);           // the canvas
await page.waitForTimeout(700);
const popCanvas = await page.evaluate(() => window.__pop);
await page.evaluate(() => history.pushState({ gb5: 3 }, '', location.href));
await mousePress(B.act.x, B.act.y, 'back', 60);   // the pad's Enter
await page.waitForTimeout(700);
const popPad = await page.evaluate(() => window.__pop);
ok(true, 'Bk-info [history pops]', `before ${popsBefore}, after a back press on the CANVAS ${popCanvas}, after one on ENTER ${popPad}`);
ok(popCanvas > popsBefore,
  'Bk1 [the canvas does not stop a back-button press either]: this is Chrome, not the pad',
  `canvas pops ${popsBefore} -> ${popCanvas}`);
ok(popPad > popCanvas,
  'Bk2 [and the pad does not stop it]: a mouse side button over the controls navigates the game away',
  `pad pops ${popCanvas} -> ${popPad}`);
/* and does it FIRE anything on the way out? */
await padProbe(page);
const d2 = await toDoor();
await padProbe(page);
await mousePress(B.act.x, B.act.y, 'back', 60);
await page.waitForTimeout(600);
const alive = await page.evaluate(() => !!(window.WALLY && WALLY.debug && WALLY.debug.touchState));
if (!alive) { ok(false, 'Bk3 — the page left the game, cannot read the pad'); }
else {
  const p = await padRead(page), pn = await panelsNow(page);
  ok(p.downs.some((x) => x.button === 3 && x.inPad), 'Bk3-pre [a button-3 pointerdown really reached Enter]',
    JSON.stringify(p.downs.map((x) => [x.target, x.button])));
  ok(p.act === 0 && pn.length === 0, 'Bk3 [and it fires nothing on the pad]',
    `near ${d2}, act ${p.act}, panels ${JSON.stringify(pn)}`);
}

console.log(`\n${R.fails} FAIL(S)`);
await R.close();
process.exit(R.fails ? 1 : 0);
