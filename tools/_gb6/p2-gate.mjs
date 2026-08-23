/* GB6 PROBE 2 — the rest of the gate attack.

   1. CONTEXTMENU. Suppressed inside the pad (the pad binds it), and
      NOT suppressed on ordinary interface outside it. The canvas is
      measured separately because core/camera.js:783 suppresses it
      there too — that is a different owner and a different rule.
   2. WHAT A REFUSED PRESS STILL DOES. `secondary(e)` returns BEFORE
      `e.preventDefault()`, and that call's own comment says it is
      there to stop the focus grab. So a refused press may still focus
      the button — and every pad button carries a detail-0 click
      listener for keyboards and assistive technology. If both hold,
      the next Space/Enter keystroke runs the verb the gate just
      refused, off a secondary button.
   3. HIGHER BUTTON INDICES on every control (back/forward are driven
      LAST, they can navigate the page away).
   4. PEN, and PEN BARREL, and a synthetic ERASER (button 5). */
import { boot, padProbe, padRead, panelsNow, nearId, boxes, BTN_INDEX } from './lib.mjs';

const R = await boot({ mobile: true });
const { page, ok, mouseAt, mousePress, press } = R;

const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const toOpenGround = async () => {
  await page.evaluate((b) => { WALLY.ctx.ui.closeAll(); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {}); }, BOOT);
  await page.waitForTimeout(700);
};
const toDoor = async () => {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.arrive('apartment', true); });
  await page.waitForTimeout(1200);
  try { await page.waitForFunction(() => WALLY.ctx.ui.near != null, null, { timeout: 5000 }); } catch {}
  await page.waitForTimeout(300);
  return nearId(page);
};
const closeAll = async () => { await page.evaluate(() => WALLY.ctx.ui.closeAll()); await page.waitForTimeout(400); };
const active = () => page.evaluate(() => {
  const a = document.activeElement;
  if (!a) return null;
  return { tag: a.tagName.toLowerCase(), label: a.getAttribute?.('aria-label') || null,
    cls: String(a.className || '').slice(0, 40), inPad: !!a.closest?.('.w-touch') };
});
const blur = () => page.evaluate(() => document.activeElement?.blur?.());

await page.evaluate(() => WALLY.debug.hideUI(false));
await page.waitForTimeout(400);
const B = await boxes(page);
console.log('BOXES', JSON.stringify(B));

/* ============ 1. CONTEXTMENU ============ */
const menuLog = () => page.evaluate(() => {
  window.__ctx = [];
  if (!window.__ctxOn) {
    window.__ctxOn = true;
    document.addEventListener('contextmenu', (e) => {
      window.__ctx.push({
        target: e.target.tagName.toLowerCase() + '.' + String(e.target.className?.baseVal ?? e.target.className ?? '').trim().split(/\s+/).join('.'),
        inPad: !!e.target.closest?.('.w-touch'),
        onCanvas: e.target === WALLY.ctx.canvas,
        prevented: e.defaultPrevented,
      });
    }, false);
  }
  return true;
});
const menuRead = () => page.evaluate(() => window.__ctx.slice());

await menuLog();
await toOpenGround();
for (const [name, box] of [['Enter', B.act], ['Jump', B.jump], ['Phone', B.sc[0]], ['Stick', B.stick]]) {
  await page.evaluate(() => { window.__ctx = []; });
  await mousePress(box.x, box.y, 'right', 70);
  await page.waitForTimeout(350);
  const m = await menuRead();
  ok(m.length === 1 && m[0].inPad === true && m[0].prevented === true,
    `CTX-1 [${name}]: a right press inside the pad raises a contextmenu and the pad cancels it`,
    JSON.stringify(m));
  await closeAll();
}

/* on the canvas — a DIFFERENT owner (core/camera.js), recorded not judged */
await page.evaluate(() => { window.__ctx = []; });
await mousePress(195, 300, 'right', 70);
await page.waitForTimeout(350);
const mCanvas = await menuRead();
console.log('CTX-canvas (camera.js owns this one):', JSON.stringify(mCanvas));

/* outside the pad and off the canvas: a real sheet. A player must still
   be able to raise the platform menu over ordinary interface. */
await page.evaluate(() => WALLY.ctx.ui.openPhone());
await page.waitForTimeout(900);
const sheetPt = await page.evaluate(() => {
  const el = document.querySelector('.w-sheet, .w-phone, .w-panel, .w-card');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 30), sel: el.className };
});
if (!sheetPt) {
  ok(false, 'CTX-2 [outside the pad]: no sheet element found to press — probe cannot discriminate');
} else {
  await page.evaluate(() => { window.__ctx = []; });
  await mousePress(sheetPt.x, sheetPt.y, 'right', 70);
  await page.waitForTimeout(350);
  const m2 = await menuRead();
  ok(m2.length === 1 && m2[0].inPad === false && m2[0].prevented === false,
    'CTX-2 [outside the pad]: a right press on the phone sheet raises a contextmenu and NOTHING cancels it',
    `${JSON.stringify(m2)} at ${sheetPt.sel}`);
}
await closeAll();

/* ============ 2. WHAT A REFUSED PRESS LEAVES BEHIND: FOCUS ============ */
/* control zero: with nothing focused, does the GAME's own key handler
   open a door on Space or Enter? If it does, everything below is
   measuring the wrong thing. */
await toDoor();
await blur();
await padProbe(page);
for (const k of ['Space', 'Enter']) {
  await page.keyboard.press(k);
  await page.waitForTimeout(500);
}
let p = await padRead(page); let pn = await panelsNow(page);
const act0 = await active();
ok(p.act === 0 && p.sc === 0 && pn.length === 0,
  'F0 [control: with nothing focused, Space and Enter at a door open nothing through the pad]',
  `act ${p.act} sc ${p.sc} panels ${JSON.stringify(pn)} activeElement ${JSON.stringify(act0)}`);
await closeAll();

/* control one: a PRIMARY press reaches preventDefault, so it must NOT focus */
await toDoor();
await blur();
await mousePress(B.act.x, B.act.y, 'left', 60);
await page.waitForTimeout(600);
const afterPrimary = await active();
ok(!(afterPrimary && afterPrimary.inPad),
  'F1 [control: a PRIMARY press focuses nothing]: preventDefault below the gate suppresses the focus grab',
  JSON.stringify(afterPrimary));
await closeAll();

/* the case */
for (const [name, sel, box] of [
  ['Enter', '.w-abtn.act', B.act],
  ['Jump', '.w-abtn.jump', B.jump],
  ['Phone', '.w-abtn.sm', B.sc[0]],
]) {
  for (const btn of ['right', 'middle']) {
    if (name === 'Enter') await toDoor(); else await toOpenGround();
    await blur();
    await padProbe(page);
    await mousePress(box.x, box.y, btn, 70);
    await page.waitForTimeout(500);
    const a = await active();
    const focused = await page.evaluate((s) => document.activeElement === document.querySelector(s), sel);
    ok(true, `F2-info [${btn} press on ${name}] left activeElement =`, JSON.stringify(a) + ` isTheButton ${focused}`);
    if (focused) {
      /* ...and now the keyboard */
      const before = await page.evaluate(() => ({
        vy: +WALLY.ctx.wally.controller.velocity.y.toFixed(2) }));
      await page.keyboard.press('Space');
      await page.waitForTimeout(400);
      p = await padRead(page); pn = await panelsNow(page);
      const vy = await page.evaluate(() => +WALLY.ctx.wally.controller.velocity.y.toFixed(2));
      const why = await page.evaluate(() => WALLY.debug.interact());
      const fired = name === 'Jump' ? (vy > 0.5) : (p.act > 0 || p.sc > 0 || pn.length > 0);
      ok(!fired,
        `F3 [${btn} press on ${name}, then Space]: the refused press does not hand the verb to the keyboard`,
        `act ${p.act} sc ${p.sc} panels ${JSON.stringify(pn)} vy ${before.vy}->${vy} why ${JSON.stringify(why)} clicks ${JSON.stringify(p.clicks.map((c) => [c.target, c.detail]))}`);
    }
    await closeAll();
  }
}

/* ============ 3. HIGHER BUTTON INDICES ============ */
for (const [name, box] of [['Enter', B.act], ['Jump', B.jump], ['Phone', B.sc[0]], ['Stick', B.stick]]) {
  if (name === 'Enter') await toDoor(); else await toOpenGround();
  await padProbe(page);
  const p0 = await page.evaluate(() => { const q = WALLY.ctx.wally.position; return { x: q.x, z: q.z }; });
  for (const btn of ['back', 'forward']) {
    await mousePress(box.x, box.y, btn, 60);
    await page.waitForTimeout(400);
  }
  const alive = await page.evaluate(() => !!(window.WALLY && WALLY.debug && WALLY.debug.touchState));
  if (!alive) { ok(false, `IDX [${name}]: the PAGE NAVIGATED away — probe cannot discriminate`); break; }
  p = await padRead(page); pn = await panelsNow(page);
  const moved = await page.evaluate((f) => { const q = WALLY.ctx.wally.position;
    return +Math.hypot(q.x - f.x, q.z - f.z).toFixed(2); }, p0);
  const reached = p.downs.filter((d) => d.button >= 3 && d.inPad).length;
  ok(reached >= 1, `IDX-pre [${name}]: back/forward presses really reached the pad`,
    JSON.stringify(p.downs.map((d) => [d.target, d.button])));
  ok(p.act === 0 && p.sc === 0 && pn.length === 0 && moved < 0.3,
    `IDX [${name}]: button 3 and 4 fire nothing and move him nothing`,
    `act ${p.act} sc ${p.sc} panels ${JSON.stringify(pn)} moved ${moved}`);
  await closeAll();
}

/* ============ 4. PEN, BARREL, ERASER ============ */
const doorP = await toDoor();
await padProbe(page);
await mousePress(B.act.x, B.act.y, 'left', 60, 'pen');
await page.waitForTimeout(900);
p = await padRead(page); pn = await panelsNow(page);
ok(p.downs.some((d) => d.ptype === 'pen'), 'PEN-pre [a pen contact really reached Enter]',
  JSON.stringify(p.downs.map((d) => [d.target, d.ptype, d.button])));
ok(doorP !== null && p.act === 1 && pn.includes('place'),
  'PEN-1 [pen tip, button 0]: a stylus presses Enter exactly as a thumb does',
  `act ${p.act} panels ${JSON.stringify(pn)} why ${JSON.stringify(await page.evaluate(() => WALLY.debug.interact()))}`);
await closeAll();

await toDoor();
await padProbe(page);
await mousePress(B.act.x, B.act.y, 'right', 60, 'pen');
await page.waitForTimeout(800);
p = await padRead(page); pn = await panelsNow(page);
ok(p.downs.some((d) => d.ptype === 'pen' && d.button === 2), 'PEN-pre2 [a pen BARREL press really reached Enter]',
  JSON.stringify(p.downs.map((d) => [d.target, d.ptype, d.button])));
ok(p.act === 0 && pn.length === 0, 'PEN-2 [pen barrel]: refused', `act ${p.act} panels ${JSON.stringify(pn)}`);
await closeAll();

/* eraser: CDP cannot dispatch button 5, so this half is SYNTHETIC and
   is paired with the same synthesis at button 0 as its control */
for (const [b, mask, label, wantFire] of [[5, 32, 'ERASER (button 5)', false], [0, 1, 'the same synthetic path at button 0', true]]) {
  await toDoor();
  await padProbe(page);
  await page.evaluate(({ b, mask }) => {
    const el = document.querySelector('.w-abtn.act');
    const r = el.getBoundingClientRect();
    const mk = (t, button, buttons) => new PointerEvent(t, { bubbles: true, cancelable: true,
      composed: true, pointerId: 900 + button, pointerType: 'pen', isPrimary: true, button, buttons,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
    el.dispatchEvent(mk('pointerdown', b, mask));
    el.dispatchEvent(mk('pointerup', b, 0));
  }, { b, mask });
  await page.waitForTimeout(800);
  p = await padRead(page); pn = await panelsNow(page);
  const fired = p.act > 0 || pn.length > 0;
  ok(p.downs.some((d) => d.button === b && d.inPad), `ERA-pre [${label} reached Enter]`,
    JSON.stringify(p.downs.map((d) => [d.target, d.ptype, d.button])));
  ok(fired === wantFire, `ERA [${label}]: ${wantFire ? 'fires' : 'refused'}`,
    `act ${p.act} panels ${JSON.stringify(pn)}`);
  await closeAll();
}

console.log(`\n${R.fails} FAIL(S)`);
await R.close();
process.exit(R.fails ? 1 : 0);
