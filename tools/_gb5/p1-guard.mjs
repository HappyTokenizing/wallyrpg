/* PROBE 1 — the primary-button guard, swept across EVERY pad control,
   every button index, press and drag, touch and real mouse. */
import { boot, padProbe, padRead, panelsNow, nearId, boxes, clsDown, BTN_INDEX } from './lib.mjs';

const R = await boot({ mobile: true });
const { page, ok, mouseAt, mousePress, mouseDrag, press, touch } = R;

const st0 = await page.evaluate(() => WALLY.debug.touchState());
ok(st0.enabled, 'rig: touch layer up on the phone context', JSON.stringify(st0));

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

await page.evaluate(() => WALLY.debug.hideUI(false));
await page.waitForTimeout(500);
const B = await boxes(page);
console.log('BOXES', JSON.stringify(B));
const CTRL = [
  ['Enter', B.act],
  ['Jump', B.jump],
  ['Phone', B.sc[0]],
  ['Places', B.sc[1]],
  ['Desk', B.sc[2]],
  ['Menu', B.sc[3]],
  ['Stick', B.stick],
];

/* ============ A. POSITIVE CONTROLS, REAL TOUCH ============ */
const door = await toDoor();
await padProbe(page);
await press(B.act.x, B.act.y, 60);
await page.waitForTimeout(900);
let p = await padRead(page); let pn = await panelsNow(page);
ok(door !== null && p.act === 1 && pn.includes('place'),
  'A1 [touch primary, Enter at a door]: still opens', `near ${door} act ${p.act} panels ${JSON.stringify(pn)} toasts ${JSON.stringify(p.toasts)}`);
await closeAll();

for (const [n, b] of [['Phone', B.sc[0]], ['Places', B.sc[1]], ['Desk', B.sc[2]], ['Menu', B.sc[3]]]) {
  await padProbe(page);
  await press(b.x, b.y, 60);
  await page.waitForTimeout(700);
  p = await padRead(page); pn = await panelsNow(page);
  ok(p.sc === 1, `A2 [touch primary, ${n}]: the shortcut still runs`, `sc ${p.sc} panels ${JSON.stringify(pn)}`);
  await closeAll();
}

await toOpenGround(); await page.waitForTimeout(900);
await touch('touchStart', B.jump.x, B.jump.y);
await page.waitForTimeout(180);
const airA = await page.evaluate(() => ({ vy: +WALLY.ctx.wally.controller.velocity.y.toFixed(2) }));
await touch('touchEnd', B.jump.x, B.jump.y);
ok(airA.vy > 0.5, 'A3 [touch primary, Jump]: still leaves the ground', `vy ${airA.vy}`);
await page.waitForTimeout(900);

await touch('touchStart', B.stick.x, B.stick.y);
await page.waitForTimeout(50);
await touch('touchMove', B.stick.x, B.stick.y - 60);
await page.waitForTimeout(500);
const stA = await page.evaluate(() => ({ t: +WALLY.debug.touchState().t.toFixed(2),
  sp: +Math.hypot(WALLY.ctx.wally.controller.velocity.x, WALLY.ctx.wally.controller.velocity.z).toFixed(2) }));
await touch('touchEnd', B.stick.x, B.stick.y - 60);
await page.waitForTimeout(600);
ok(stA.t > 0.5 && stA.sp > 1, 'A4 [touch primary, thumbstick]: still deflects and walks', JSON.stringify(stA));

/* ============ B. SECONDARY SWEEP — PRESS ============ */
async function jumpVy() {
  return page.evaluate(() => ({ vy: +WALLY.ctx.wally.controller.velocity.y.toFixed(2),
    g: WALLY.ctx.wally.controller.grounded }));
}
async function stickState() {
  return page.evaluate(() => ({ t: +WALLY.debug.touchState().t.toFixed(2),
    sp: +Math.hypot(WALLY.ctx.wally.controller.velocity.x, WALLY.ctx.wally.controller.velocity.z).toFixed(2) }));
}

for (const btn of ['middle', 'right']) {
  const bi = BTN_INDEX[btn];
  for (const [name, box] of CTRL) {
    if (name === 'Enter') await toDoor(); else await toOpenGround();
    await page.waitForTimeout(600);
    await padProbe(page);
    if (name === 'Jump' || name === 'Stick') {
      await mouseAt('mouseMoved', box.x, box.y);
      await mouseAt('mousePressed', box.x, box.y, btn, { middle: 4, right: 2 }[btn]);
      await page.waitForTimeout(220);
      const mid = name === 'Jump' ? await jumpVy() : await stickState();
      await mouseAt('mouseReleased', box.x, box.y, btn, 0);
      await page.waitForTimeout(500);
      const pr = await padRead(page);
      const reached = pr.downs.some((d) => d.button === bi && d.inPad);
      const quiet = name === 'Jump' ? (mid.g === true && mid.vy < 0.5) : (mid.t === 0 && mid.sp < 0.2);
      ok(reached, `B-pre [${btn} press really reached ${name}]`, JSON.stringify(pr.downs.map((d) => [d.target, d.button])));
      ok(quiet, `B [${btn} press on ${name}] fires nothing`, JSON.stringify(mid));
      ok((await clsDown(page, name === 'Jump' ? '.w-abtn.jump' : '.w-stick')) !== true,
        `B-state [${name} not left visually held after a ${btn} press]`);
    } else {
      await mousePress(box.x, box.y, btn, 60);
      await page.waitForTimeout(700);
      const pr = await padRead(page); const pnn = await panelsNow(page);
      const reached = pr.downs.some((d) => d.button === bi && d.inPad);
      ok(reached, `B-pre [${btn} press really reached ${name}]`, JSON.stringify(pr.downs.map((d) => [d.target, d.button])));
      ok(pr.act === 0 && pr.sc === 0 && pnn.length === 0,
        `B [${btn} press on ${name}] fires nothing`, `act ${pr.act} sc ${pr.sc} panels ${JSON.stringify(pnn)} aux ${JSON.stringify(pr.aux.map((a) => a.button))}`);
    }
    await closeAll();
  }
}

/* ============ C. SECONDARY SWEEP — DRAG (down on the control, move, up) ============ */
for (const btn of ['middle', 'right']) {
  for (const [name, box] of CTRL) {
    if (name === 'Enter') await toDoor(); else await toOpenGround();
    await page.waitForTimeout(600);
    await padProbe(page);
    const before = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, z: p.z }; });
    await mouseDrag(box.x, box.y, 0, -70, btn, 5);
    await page.waitForTimeout(600);
    const pr = await padRead(page); const pnn = await panelsNow(page);
    const after = await page.evaluate((f) => { const p = WALLY.ctx.wally.position;
      return +Math.hypot(p.x - f.x, p.z - f.z).toFixed(2); }, before);
    const dlgC = await page.evaluate(() => !!WALLY.ctx.ui.dialogueOpen);
    ok(pr.act === 0 && pr.sc === 0 && pnn.length === 0 && after < 0.3,
      `C [${btn} drag from ${name}] fires nothing and moves him nothing`,
      `act ${pr.act} sc ${pr.sc} panels ${JSON.stringify(pnn)} moved ${after} m dlgOpen ${dlgC}`);
    await closeAll();
  }
}

/* ============ D. PRIMARY MOUSE STILL WORKS EVERYWHERE ============ */
const doorD = await toDoor();
const preD = await page.evaluate(() => ({ dlg: !!WALLY.ctx.ui.dialogueOpen,
  card: document.querySelector('.w-dlg')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 70) || null,
  cap: document.querySelector('.w-abtn.act .cap')?.textContent || null,
  modal: !!WALLY.ctx.ui.modal }));
console.log('D1-pre', JSON.stringify(preD));
await padProbe(page);
await mousePress(B.act.x, B.act.y, 'left', 60);
await page.waitForTimeout(120);
const pnEarly = await panelsNow(page);
await page.waitForTimeout(800);
p = await padRead(page); pn = await panelsNow(page);
const whyD = await page.evaluate(() => WALLY.debug.interact?.() ?? null);
ok(doorD !== null && p.act === 1 && pn.includes('place'),
  'D1 [mouse primary, Enter at a door]: opens',
  `near ${doorD} act ${p.act} panels@120ms ${JSON.stringify(pnEarly)} panels ${JSON.stringify(pn)} toasts ${JSON.stringify(p.toasts)} why ${JSON.stringify(whyD)} clicks ${JSON.stringify(p.clicks.map((c) => [c.target, c.detail]))} ups ${JSON.stringify(p.ups.map((u) => [u.target, u.button]))}`);
await closeAll();

for (const [i, n] of [[0, 'Phone'], [1, 'Places'], [2, 'Desk'], [3, 'Menu']]) {
  await padProbe(page);
  await mousePress(B.sc[i].x, B.sc[i].y, 'left', 60);
  await page.waitForTimeout(700);
  p = await padRead(page); pn = await panelsNow(page);
  ok(p.sc === 1, `D2 [mouse primary, ${n}]: runs`, `sc ${p.sc} panels ${JSON.stringify(pn)}`);
  await closeAll();
}
await toOpenGround(); await page.waitForTimeout(900);
await mouseAt('mouseMoved', B.jump.x, B.jump.y);
await mouseAt('mousePressed', B.jump.x, B.jump.y, 'left', 1);
await page.waitForTimeout(200);
const airD = await jumpVy();
await mouseAt('mouseReleased', B.jump.x, B.jump.y, 'left', 0);
ok(airD.vy > 0.5, 'D3 [mouse primary, Jump]: leaves the ground', JSON.stringify(airD));
await page.waitForTimeout(900);

await toOpenGround(); await page.waitForTimeout(700);
await mouseAt('mouseMoved', B.stick.x, B.stick.y);
await mouseAt('mousePressed', B.stick.x, B.stick.y, 'left', 1);
for (let i = 1; i <= 5; i++) { await mouseAt('mouseMoved', B.stick.x, B.stick.y - i * 14, 'left', 1); await page.waitForTimeout(30); }
await page.waitForTimeout(400);
const stD = await stickState();
await mouseAt('mouseReleased', B.stick.x, B.stick.y - 70, 'left', 0);
await page.waitForTimeout(500);
ok(stD.t > 0.5 && stD.sp > 1, 'D4 [mouse primary, thumbstick]: deflects and walks', JSON.stringify(stD));

/* ============ E. PEN ============ */
const doorE = await toDoor();
await padProbe(page);
await mousePress(B.act.x, B.act.y, 'left', 60, 'pen');
await page.waitForTimeout(900);
p = await padRead(page); pn = await panelsNow(page);
ok(p.downs.some((d) => d.ptype === 'pen'), 'E-pre [a pen contact really reached Enter]',
  JSON.stringify(p.downs.map((d) => [d.target, d.ptype, d.button])));
ok(doorE !== null && p.act === 1 && pn.includes('place'),
  'E1 [pen tip, button 0, on Enter]: the pad accepts it — a stylus is not a secondary button',
  `act ${p.act} panels ${JSON.stringify(pn)} toasts ${JSON.stringify(p.toasts)}`);
await closeAll();

const doorE2 = await toDoor();
await padProbe(page);
await mousePress(B.act.x, B.act.y, 'right', 60, 'pen');
await page.waitForTimeout(900);
p = await padRead(page); pn = await panelsNow(page);
ok(p.downs.some((d) => d.ptype === 'pen' && d.button === 2), 'E-pre2 [a pen BARREL press really reached Enter]',
  JSON.stringify(p.downs.map((d) => [d.target, d.ptype, d.button])));
ok(p.act === 0 && pn.length === 0, 'E2 [pen barrel button on Enter]: refused',
  `act ${p.act} panels ${JSON.stringify(pn)}`);
await closeAll();

/* ============ F. ERASER (synthetic — CDP has no eraser button) ============ */
const doorF = await toDoor();
await padProbe(page);
const fRes = await page.evaluate(() => {
  const b = document.querySelector('.w-abtn.act');
  const mk = (t, button, buttons) => new PointerEvent(t, { bubbles: true, cancelable: true,
    composed: true, pointerId: 77, pointerType: 'pen', isPrimary: true, button, buttons,
    clientX: b.getBoundingClientRect().left + 10, clientY: b.getBoundingClientRect().top + 10 });
  b.dispatchEvent(mk('pointerdown', 5, 32));
  b.dispatchEvent(mk('pointerup', 5, 0));
  return true;
});
await page.waitForTimeout(700);
p = await padRead(page); pn = await panelsNow(page);
ok(fRes && p.downs.some((d) => d.button === 5), 'F-pre [a synthetic eraser pointerdown reached Enter]',
  JSON.stringify(p.downs.map((d) => [d.target, d.ptype, d.button])));
ok(p.act === 0 && pn.length === 0, 'F [pen ERASER, button 5, on Enter]: refused (SYNTHETIC — CDP cannot dispatch a real eraser)',
  `act ${p.act} panels ${JSON.stringify(pn)}`);
await closeAll();

/* ...and the same synthetic path with button 0 must still fire, or F proves nothing */
const doorF2 = await toDoor();
await padProbe(page);
await page.evaluate(() => {
  const b = document.querySelector('.w-abtn.act');
  const r = b.getBoundingClientRect();
  const mk = (t, button, buttons) => new PointerEvent(t, { bubbles: true, cancelable: true,
    composed: true, pointerId: 78, pointerType: 'pen', isPrimary: true, button, buttons,
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
  b.dispatchEvent(mk('pointerdown', 0, 1));
  b.dispatchEvent(mk('pointerup', 0, 0));
});
await page.waitForTimeout(800);
p = await padRead(page); pn = await panelsNow(page);
ok(doorF2 !== null && p.act === 1 && pn.includes('place'),
  'F2 [the SAME synthetic path with button 0]: fires — so F above measured the button, not the synthesis',
  `act ${p.act} panels ${JSON.stringify(pn)}`);
await closeAll();

/* ============ G. DOWN b0, UP a different button ============ */
const doorG = await toDoor();
await padProbe(page);
await mouseAt('mouseMoved', B.act.x, B.act.y);
await mouseAt('mousePressed', B.act.x, B.act.y, 'left', 1);
await page.waitForTimeout(80);
await mouseAt('mouseReleased', B.act.x, B.act.y, 'middle', 0);
await page.waitForTimeout(800);
p = await padRead(page); pn = await panelsNow(page);
ok(p.down?.button === 0 && p.up?.button === 1, 'G-pre [down b0, up b1 really delivered]',
  `down b${p.down?.button} up b${p.up?.button}`);
ok(p.act === 0 && pn.length === 0, 'G1 [a press armed on b0 whose release reports b1] fires nothing',
  `act ${p.act} panels ${JSON.stringify(pn)}`);
ok((await clsDown(page, '.w-abtn.act')) === false, 'G2 [...and the button was LET GO, not left armed]');
await padProbe(page);
await mousePress(B.act.x, B.act.y, 'left', 60);
await page.waitForTimeout(900);
p = await padRead(page); pn = await panelsNow(page);
ok(p.act === 1 && pn.includes('place'), 'G3 [the very next primary press still opens the door]',
  `act ${p.act} panels ${JSON.stringify(pn)} toasts ${JSON.stringify(p.toasts)}`);
await closeAll();

/* ============ H. right press begins on a control, releases elsewhere ============ */
const doorH = await toDoor();
await padProbe(page);
await mouseAt('mouseMoved', B.act.x, B.act.y);
await mouseAt('mousePressed', B.act.x, B.act.y, 'right', 2);
await page.waitForTimeout(80);
await mouseAt('mouseMoved', 190, 300, 'right', 2);
await page.waitForTimeout(60);
await mouseAt('mouseReleased', 190, 300, 'right', 0);
await page.waitForTimeout(800);
p = await padRead(page); pn = await panelsNow(page);
ok(p.downs.some((d) => d.button === 2 && d.inPad), 'H-pre [the right press really began inside the pad]',
  JSON.stringify(p.downs.map((d) => [d.target, d.button])));
ok(p.act === 0 && pn.length === 0, 'H1 [a right press that starts on Enter and lifts on the canvas] fires nothing',
  `act ${p.act} panels ${JSON.stringify(pn)}`);
ok((await clsDown(page, '.w-abtn.act')) === false, 'H2 [...and Enter is not left held]');
/* and the pad still works right after */
await padProbe(page);
await press(B.act.x, B.act.y, 60);
await page.waitForTimeout(900);
p = await padRead(page); pn = await panelsNow(page);
ok(p.act === 1 && pn.includes('place'), 'H3 [a finger straight after it still opens the door]',
  `act ${p.act} panels ${JSON.stringify(pn)}`);
await closeAll();

/* ============ I. back / forward buttons (index 3 and 4) — LAST, they can navigate ============ */
const doorI = await toDoor();
for (const btn of ['back', 'forward']) {
  await padProbe(page);
  await mousePress(B.act.x, B.act.y, btn, 60);
  await page.waitForTimeout(700);
  const alive = await page.evaluate(() => !!(window.WALLY && WALLY.debug && WALLY.debug.touchState));
  if (!alive) { ok(false, `I [${btn} button] — the PAGE NAVIGATED, probe cannot discriminate`); break; }
  p = await padRead(page); pn = await panelsNow(page);
  const reached = p.downs.some((d) => d.button === BTN_INDEX[btn] && d.inPad);
  ok(reached, `I-pre [${btn}-button press really reached Enter]`, JSON.stringify(p.downs.map((d) => [d.target, d.button])));
  ok(p.act === 0 && pn.length === 0, `I [${btn} button on Enter] fires nothing`,
    `act ${p.act} panels ${JSON.stringify(pn)}`);
  await closeAll();
}

console.log(`\n${R.fails} FAIL(S)`);
await R.close();
process.exit(R.fails ? 1 : 0);
