/* ROUND SEVEN, PROBE 8 — capture loss on the BUTTONS, second attempt.
   p7 saw 0 spurious losses in 40 drags and therefore could not
   discriminate. PAD-38 provokes the event with mouseMoved carrying
   button='none' + buttons=1 (the chorded-move shape) over a long drag;
   p7 used button='left' over 8 px. Here the shape is copied exactly and
   the travel is folded back inside the button so the release still
   lands in the rect. */
import { boot, boxes, padProbe2, MASK } from '../_gb7/lib.mjs';

const t = await boot();
const { page, ok, cdp } = t;
await padProbe2(page);
const b = await page.evaluate(() => {
  const e = document.querySelector('.w-abtn.act');
  const r = e.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
});
console.log('ACT BUTTON', JSON.stringify(b));

await page.evaluate(() => {
  const el = document.querySelector('.w-abtn.act');
  window.__capB = { spurious: 0, clean: 0, got: 0 };
  el.addEventListener('gotpointercapture', () => { window.__capB.got++; }, true);
  el.addEventListener('lostpointercapture', (e) => {
    if (e.buttons) window.__capB.spurious++; else window.__capB.clean++;
  }, true);
});
const capReset = () => page.evaluate(() => { window.__capB = { spurious: 0, clean: 0, got: 0 }; });
const capRead = () => page.evaluate(() => ({ ...window.__capB }));
const mAt = (type, x, y, button = 'none', buttons = 0) =>
  cdp.send('Input.dispatchMouseEvent', { type, x, y, button, buttons,
    clickCount: type === 'mouseMoved' ? 0 : 1 });
const shut = async () => { await page.evaluate(() => WALLY.ctx.ui.closeAll()); await page.waitForTimeout(150); };

/* travel that stays inside the rect: out to the edge and back to centre */
const R = Math.min(b.w, b.h) / 2 - 6;
async function drag() {
  await shut();
  const a0 = await page.evaluate(() => window.__pad.act);
  await mAt('mouseMoved', b.x, b.y);
  await mAt('mousePressed', b.x, b.y, 'left', MASK.left);
  await page.waitForTimeout(40);
  /* EXACTLY PAD-38's move shape: button 'none', buttons 1 */
  for (let k = 1; k <= 4; k++) {
    const ang = k * Math.PI / 2;
    await mAt('mouseMoved', b.x + Math.cos(ang) * R, b.y + Math.sin(ang) * R, 'none', 1);
    await page.waitForTimeout(30);
  }
  await mAt('mouseMoved', b.x, b.y, 'none', 1);
  await page.waitForTimeout(30);
  await mAt('mouseReleased', b.x, b.y, 'left', 0);
  await page.waitForTimeout(220);
  const a1 = await page.evaluate(() => window.__pad.act);
  return a1 > a0;                       // did the verb run?
}

const N = 20;
const onDead = [], offDead = [];
await capReset();
for (let i = 0; i < N; i++) {
  await page.evaluate(() => WALLY.debug.padCaptureRetry(true));
  onDead.push((await drag()) ? 0 : 1);
  await page.evaluate(() => WALLY.debug.padCaptureRetry(false));
  offDead.push((await drag()) ? 0 : 1);
}
await page.evaluate(() => WALLY.debug.padCaptureRetry(true));
const cap = await capRead();
const dOn = onDead.reduce((a, c) => a + c, 0), dOff = offDead.reduce((a, c) => a + c, 0);
console.log('CAPTURE EVENTS ON THE BUTTON', JSON.stringify(cap), `(${N * 2} drags)`);
console.log('  retry ON  dead', onDead.join(''), '=', dOn, '/', N);
console.log('  retry OFF dead', offDead.join(''), '=', dOff, '/', N);

ok(cap.spurious > 0,
  'CAPB-3 the pathological event (capture dropped with buttons still set) occurs on a BUTTON too',
  `${cap.spurious} spurious, ${cap.clean} clean, ${cap.got} granted across ${N * 2} drags`);
ok(dOn === 0, 'CAPB-4 with the re-take armed no button press is lost', `${dOn}/${N} dead`);
console.log(cap.spurious === 0
  ? '  VERDICT: cannot discriminate — the event did not occur on the button with this shape either.'
  : `  VERDICT: discriminating. retry OFF loses ${dOff}/${N}, retry ON loses ${dOn}/${N}.`);

console.log('PAGEERRORS', JSON.stringify(t.errs));
console.log(`FAILS ${t.fails}`);
await t.close();
