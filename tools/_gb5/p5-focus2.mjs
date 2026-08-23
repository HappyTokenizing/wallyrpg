/* PROBE 5 — pin the focus defect down, and rule out the alternatives.

   Probe 2 measured: a right or middle press on any pad BUTTON focuses
   it, and the next Space or Enter keystroke then runs that button's
   verb through the detail-0 assistive-technology listener.

   Three things have to be true before that is the guard's fault:
     1. with nothing focused, Space at a door must NOT open the door
        (otherwise S1 measured the game's own key handler);
     2. a PRIMARY press must not focus (it reaches e.preventDefault());
     3. preventDefault on a SECONDARY pointerdown must really suppress
        the focus grab in this Chrome — otherwise the pre-guard code
        focused too and this is not a regression. That one is measured
        on a bare page with no game in it. */
import { boot, padProbe, padRead, panelsNow, nearId, boxes } from './lib.mjs';

const R = await boot({ mobile: true });
const { page, ok, mouseAt, mousePress, press } = R;

const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const toDoor = async () => {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.arrive('apartment', true); });
  await page.waitForTimeout(1200);
  try { await page.waitForFunction(() => WALLY.ctx.ui.near != null, { timeout: 5000 }); } catch {}
  await page.waitForTimeout(300);
  return nearId(page);
};
const hush = async () => { await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.dialogue?.(null); }); await page.waitForTimeout(500); };
const active = () => page.evaluate(() => {
  const a = document.activeElement;
  return a === document.body ? 'BODY' : (a?.getAttribute?.('aria-label') || a?.tagName || null);
});
const blur = () => page.evaluate(() => document.activeElement?.blur?.());

await page.evaluate(() => WALLY.debug.hideUI(false));
await page.waitForTimeout(500);
const B = await boxes(page);

/* 1. CONTROL — Space at a door with nothing focused */
await toDoor(); await hush(); await toDoor();
await blur();
await padProbe(page);
const dlgPre = await page.evaluate(() => !!WALLY.ctx.ui.dialogueOpen);
await page.keyboard.press('Space');
await page.waitForTimeout(900);
let p = await padRead(page), pn = await panelsNow(page);
ok(dlgPre === false, 'C0-pre [no dialogue card is up]', `dialogueOpen ${dlgPre}`);
ok(p.act === 0 && !pn.includes('place'),
  'C1 [control: SPACE at a door with nothing focused]: does not open the door — Space is the jump key',
  `active ${await active()}, act ${p.act}, panels ${JSON.stringify(pn)}`);

/* 2. CONTROL — a PRIMARY press does not focus */
await blur();
await mousePress(B.jump.x, B.jump.y, 'left', 60);
await page.waitForTimeout(400);
const afterLeft = await active();
ok(afterLeft === 'BODY', 'C2 [control: a mouse PRIMARY press on Jump focuses nothing]', `active ${afterLeft}`);
await blur();
await page.waitForTimeout(700);

/* 3. THE DEFECT, stated as its consequence, on all four buttons */
await hush();
for (const [name, box, keyName, verb] of [
  ['Enter', B.act, 'Space', 'act'],
  ['Enter', B.act, 'Enter', 'act'],
  ['Phone', B.sc[0], 'Space', 'sc'],
  ['Menu', B.sc[3], 'Enter', 'sc'],
]) {
  await toDoor(); await blur();
  await padProbe(page);
  await mousePress(box.x, box.y, 'right', 60);
  await page.waitForTimeout(250);
  const f = await active();
  await page.keyboard.press(keyName);
  await page.waitForTimeout(800);
  p = await padRead(page); pn = await panelsNow(page);
  const fired = verb === 'act' ? p.act : p.sc;
  ok(fired === 0 && pn.length === 0,
    `X [right press on ${name}, then ${keyName}]: the refused press must not hand the keyboard the button`,
    `focused ${f}, ${verb} ${fired}, panels ${JSON.stringify(pn)}, clicks ${JSON.stringify(p.clicks.map((c) => [c.target, c.detail]))}`);
  await page.evaluate(() => WALLY.ctx.ui.closeAll());
  await blur(); await page.waitForTimeout(400);
}

/* 3b. the PEN BARREL press does it too */
await toDoor(); await blur();
await padProbe(page);
await mousePress(B.act.x, B.act.y, 'right', 60, 'pen');
await page.waitForTimeout(250);
const fPen = await active();
await page.keyboard.press('Space');
await page.waitForTimeout(800);
p = await padRead(page); pn = await panelsNow(page);
ok(p.act === 0 && pn.length === 0,
  'X-pen [a pen BARREL press on Enter, then Space]: same',
  `focused ${fPen}, act ${p.act}, panels ${JSON.stringify(pn)}`);
await page.evaluate(() => WALLY.ctx.ui.closeAll()); await blur();

/* 3c. is it drawn? a focus ring on a button the player never pressed */
await blur();
await mousePress(B.act.x, B.act.y, 'right', 60);
await page.waitForTimeout(300);
const ring = await page.evaluate(() => {
  const b = document.querySelector('.w-abtn.act');
  return { focused: document.activeElement === b, visible: b.matches(':focus-visible'),
    outline: getComputedStyle(b).outlineStyle + ' ' + getComputedStyle(b).outlineWidth };
});
ok(ring.focused === false, 'X-ring [a refused press leaves no focus on the button at all]', JSON.stringify(ring));
await blur();

/* 4. THE BARE PAGE — does preventDefault on a secondary pointerdown
      suppress the focus grab in this Chrome? If yes, the pre-guard
      code did not focus and this round introduced it. */
const bare = await R.context.newPage();
await bare.setContent(`<!doctype html><style>button{width:120px;height:60px;font-size:20px}</style>
  <button id="a">A</button><button id="b">B</button>
  <script>
    a.addEventListener('pointerdown', e => e.preventDefault());   // the old shape
    b.addEventListener('pointerdown', e => { if (e.button > 0) return; e.preventDefault(); }); // the new shape
    document.addEventListener('contextmenu', e => e.preventDefault());
  </script>`);
const bcdp = await R.context.newCDPSession(bare);
const bpress = async (x, y, button) => {
  await bcdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await bcdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: { left: 1, right: 2, middle: 4 }[button], clickCount: 1 });
  await bare.waitForTimeout(60);
  await bcdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
  await bare.waitForTimeout(200);
};
const boxA = await bare.evaluate(() => { const r = a.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
const boxB = await bare.evaluate(() => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
const act = () => bare.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
await bare.evaluate(() => document.activeElement?.blur?.());
await bpress(boxA.x, boxA.y, 'right');
const bareOld = await act();
await bare.evaluate(() => document.activeElement?.blur?.());
await bpress(boxB.x, boxB.y, 'right');
const bareNew = await act();
ok(bareOld === 'BODY' && bareNew === 'b',
  'Bare [preventDefault on a right-button pointerdown DOES suppress the focus grab in this Chrome]: unguarded button A takes no focus, guarded button B takes it — so the early return is what focuses',
  `A(preventDefault always) -> ${bareOld}; B(returns first on button>0) -> ${bareNew}`);

console.log(`\n${R.fails} FAIL(S)`);
await R.close();
process.exit(R.fails ? 1 : 0);
