/* ROUND SEVEN, PROBE 7 — the capture-loss class ON THE BUTTONS.
   PAD-38 in tools/touchtest.mjs measures this on the STICK ZONE only
   (`z`). The buttons run the same lostIsRelease wrapper and were never
   given a rate. Also: fire-twice, fire-on-blur, sheet+focus, and the
   shortcut-vs-act focus discriminator. */
import { boot, boxes, padProbe2, MASK } from '../_gb7/lib.mjs';
import { who, tabTo, closeAll } from './lib9.mjs';

const t = await boot();
const { page, ok, cdp, press } = t;
await padProbe2(page);
const b = await boxes(page);
const shut = async () => { await page.evaluate(() => WALLY.ctx.ui.closeAll()); await page.waitForTimeout(200); };

/* count capture losses on the ACT button, split by whether a button was
   still held when Chrome dropped it (the pathological shape) */
await page.evaluate(() => {
  const el = document.querySelector('.w-abtn.act');
  window.__capB = { spurious: 0, clean: 0 };
  el.addEventListener('lostpointercapture', (e) => {
    if (e.buttons) window.__capB.spurious++; else window.__capB.clean++;
  }, true);
});
const capReset = () => page.evaluate(() => { window.__capB = { spurious: 0, clean: 0 }; });
const capRead = () => page.evaluate(() => ({ ...window.__capB }));

const mAt = (type, x, y, button = 'none', buttons = 0, pointerType = 'mouse') =>
  cdp.send('Input.dispatchMouseEvent', { type, x, y, button, buttons, pointerType,
    clickCount: type === 'mouseMoved' ? 0 : 1 });

/** one press-drag-release wholly inside the button; returns true if the
    verb ran */
async function mouseTapAct() {
  const a0 = await page.evaluate(() => window.__pad.act);
  const { x, y } = b.act;
  await mAt('mouseMoved', x, y);
  await mAt('mousePressed', x, y, 'left', MASK.left);
  for (let i = 1; i <= 4; i++) {
    await mAt('mouseMoved', x + i * 2, y + i * 2, 'left', MASK.left);
    await page.waitForTimeout(20);
  }
  await mAt('mouseReleased', x + 8, y + 8, 'left', 0);
  await page.waitForTimeout(160);
  const a1 = await page.evaluate(() => window.__pad.act);
  return a1 > a0;
}
async function touchTapAct() {
  const a0 = await page.evaluate(() => window.__pad.act);
  const { x, y } = b.act;
  const P = (px, py) => [{ x: px, y: py, id: 1, radiusX: 14, radiusY: 14, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: P(x, y) });
  for (let i = 1; i <= 4; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: P(x + i * 2, y + i * 2) });
    await page.waitForTimeout(20);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(160);
  const a1 = await page.evaluate(() => window.__pad.act);
  return a1 > a0;
}

const N = 20;
/* interleaved A/B on ONE page so load and session are shared */
await shut();
const offDead = [], onDead = [];
await capReset();
for (let i = 0; i < N; i++) {
  await page.evaluate(() => WALLY.debug.padCaptureRetry(false));
  offDead.push((await mouseTapAct()) ? 0 : 1);
  await page.evaluate(() => WALLY.debug.padCaptureRetry(true));
  onDead.push((await mouseTapAct()) ? 0 : 1);
}
const capM = await capRead();
await page.evaluate(() => WALLY.debug.padCaptureRetry(true));
console.log('BUTTON MOUSE capture events', JSON.stringify(capM));
console.log('  retry OFF dead', offDead.join(''), '=', offDead.reduce((a, c) => a + c, 0), '/', N);
console.log('  retry ON  dead', onDead.join(''), '=', onDead.reduce((a, c) => a + c, 0), '/', N);
ok(onDead.reduce((a, c) => a + c, 0) === 0,
  'CAPB-1 with the re-take armed, no primary mouse press on the Enter button is lost',
  `${onDead.reduce((a, c) => a + c, 0)}/${N} dead, ${capM.spurious} spurious loss(es)`);
if (capM.spurious === 0) console.log('  NOTE: no spurious loss occurred on the button in this run — the A/B had nothing to discriminate.');

/* touch arm */
await capReset();
const tDead = [];
for (let i = 0; i < N; i++) tDead.push((await touchTapAct()) ? 0 : 1);
const capT = await capRead();
console.log('BUTTON TOUCH capture events', JSON.stringify(capT), 'dead', tDead.reduce((a, c) => a + c, 0), '/', N);
ok(tDead.reduce((a, c) => a + c, 0) === 0 && capT.spurious === 0,
  'CAPB-2 the same class cannot happen on a finger on the button',
  `${tDead.reduce((a, c) => a + c, 0)}/${N} dead, ${capT.spurious} spurious, ${capT.clean} clean`);

/* ---------- fire twice / fire on blur, clean ---------- */
await shut();
const n1 = await tabTo(page, 'Phone');
const c0 = await page.evaluate(() => ({ s: window.__pad.sc, p: WALLY.ctx.ui.panels.length }));
await page.keyboard.down('Space'); await page.waitForTimeout(150); await page.keyboard.up('Space');
await page.waitForTimeout(600);
const c1 = await page.evaluate(() => ({ s: window.__pad.sc, p: WALLY.ctx.ui.panels.length }));
ok(n1 > 0 && (c1.s - c0.s) === 1, 'TWICE-1 one genuine held Space fires the verb exactly once',
  `dsc=${c1.s - c0.s} dpanels=${c1.p - c0.p}`);
await shut();
const n2 = await tabTo(page, 'Phone');
const d0 = await page.evaluate(() => ({ s: window.__pad.sc, p: WALLY.ctx.ui.panels.length }));
await page.evaluate(() => document.activeElement?.blur?.());
await page.waitForTimeout(500);
const d1 = await page.evaluate(() => ({ s: window.__pad.sc, p: WALLY.ctx.ui.panels.length }));
ok(n2 > 0 && d1.s === d0.s && d1.p === d0.p, 'TWICE-2 nothing fires on a blur',
  `${JSON.stringify(d0)} -> ${JSON.stringify(d1)}`);
/* and a real finger tap must fire once, not twice (compat click) */
await shut();
const f0 = await page.evaluate(() => window.__pad.act);
await press(b.act.x, b.act.y, 70);
await page.waitForTimeout(500);
const f1 = await page.evaluate(() => window.__pad.act);
ok(f1 - f0 === 1, 'TWICE-3 a finger tap on Enter fires the verb exactly once (compat click swallowed)',
  `dact=${f1 - f0}`);

/* ---------- sheet + focus ---------- */
await shut();
const ns = await tabTo(page, 'Menu');
const s0 = await who(page);
await page.keyboard.press('KeyP');
await page.waitForTimeout(800);
const s1 = await who(page);
await page.keyboard.press('Escape');
await page.waitForTimeout(800);
const s2 = await who(page);
console.log(`SHEET focus: before=${s0.focus} during=${s1.focus} after=${s2.focus} (driving ${s0.driving}->${s2.driving})`);
ok(ns > 0, 'SHEET-0 setup', `tabs=${ns}`);
ok(s2.focus === s0.focus, 'SHEET-1 closing the sheet restores the focus the player had',
  `before=${s0.focus} after=${s2.focus} isBody=${s2.isBody}`);

/* ---------- shortcut vs act: which one moves focus, and why ---------- */
for (const [name, x, y, opens] of [['act', b.act.x, b.act.y, false], ['shortcut Phone', b.sc[0].x, b.sc[0].y, true]]) {
  await shut();
  await tabTo(page, 'Menu');
  await press(x, y, 70);
  await page.waitForTimeout(300);
  const mid = await who(page);
  await page.evaluate(() => WALLY.ctx.ui.closeAll());
  await page.waitForTimeout(300);
  const post = await who(page);
  console.log(`FOCUSMOVE ${name}: opensPanel=${opens} duringTap=${mid.focus} afterClose=${post.focus} driving=${post.driving}`);
}

console.log('PAGEERRORS', JSON.stringify(t.errs));
console.log(`FAILS ${t.fails}`);
await t.close();
