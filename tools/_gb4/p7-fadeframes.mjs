/* P7 — the two reds in round three's own suite that look like harness
   artefacts, settled by direct measurement, plus the regression items I
   had not yet driven myself: a notification must not wake, the stick
   must unlatch on touchCancel, Settings must restore a faded pad, and a
   rotation must re-centre the seam. */
import { boot, instrument, arm, stop, padGeom, hand, toDoor, reporter, verbList, count } from './lib.mjs';

const R = reporter();
const B = await boot();
const { page, cdp } = B;
await instrument(page);
const H = hand(cdp, page);
const idleGet = () => page.evaluate(() => WALLY.debug.idle());
const idleSet = (s) => page.evaluate((v) => WALLY.debug.idle(v), s);

await toDoor(page);
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.hide('dialogue'); WALLY.debug.hideUI(true); WALLY.debug.idle(1.2); return null; });
await page.waitForTimeout(600);
const g = await padGeom(page);
const goIdle = async () => { await page.waitForTimeout(1200 + 900); return idleGet(); };

/* ---- 1. EVERY FRAME of a fade-in: what is opaque, what is hittable ---- */
let i = await goIdle();
R.ok(i.hidden, 'P7-0 faded', `why ${i.why}`);
/* the wake itself has to be a real gesture: drive it, then sample */
await arm(page);
await H.down(1, 195, 300); await H.up(1);
await H.wait(80);
await H.down(1, 195, 300); await H.up(1);
const sample = await page.evaluate(([jx, jy]) => new Promise((res) => {
  const out = [];
  const jump = document.querySelector('.w-abtn.jump');
  const acts = document.querySelector('.w-acts');
  const t0 = performance.now();
  const step = () => {
    const el = document.elementFromPoint(jx, jy);
    out.push({
      t: Math.round(performance.now() - t0),
      acts: +(+getComputedStyle(acts).opacity).toFixed(2),
      btn: +(+getComputedStyle(jump).opacity).toFixed(2),
      live: WALLY.debug.idle().live,
      under: el ? el.tagName.toLowerCase() : 'null',
      inBtn: !!(el && el.closest && el.closest('.w-abtn.jump')),
    });
    if (performance.now() - t0 > 800) { res(out); return; }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}), [g.jump.cx, g.jump.cy]);
await stop(page);
const inert = sample.filter(s => !s.live);
const live = sample.filter(s => s.live);
console.log('   fade-in samples (t, acts-op, button-op, live, under, inJumpButton):');
for (const s of sample.filter((_, k) => k % 4 === 0)) console.log(`     ${String(s.t).padStart(4)}  acts ${s.acts}  btn ${s.btn}  live ${s.live}  ${s.under}  inBtn ${s.inBtn}`);
R.ok(inert.length > 0 && inert.every(s => !s.inBtn),
  'P7-1 for every frame the cluster is inert, the jump point resolves OUTSIDE the button',
  `${inert.length} inert frames, worst under ${JSON.stringify([...new Set(inert.map(s => s.under))])}`);
R.ok(live.length > 0 && live.every(s => s.inBtn),
  'P7-2 the moment it goes live, the same point is inside the jump button again (round three read the tag name, which is the svg icon)',
  `${live.length} live frames, under ${JSON.stringify([...new Set(live.map(s => s.under))])}`);
R.ok(inert.every(s => s.btn === 1) && inert.every(s => s.acts < 1),
  'P7-3 mid-fade it is the CONTAINER that is transparent; each button reads opacity 1 — which is why an element-based assertion is blind here',
  `button opacities ${JSON.stringify([...new Set(inert.map(s => s.btn))])}, container ${JSON.stringify([...new Set(inert.map(s => s.acts))])}`);

/* ---- 2. a notification must not wake ---- */
i = await goIdle();
const w0 = i.wakes;
await page.evaluate(() => {
  const ui = WALLY.ctx.ui;
  ui.toast && ui.toast('a toast');
  WALLY.ctx.bus && WALLY.ctx.bus.emit && WALLY.ctx.bus.emit('notify', { title: 'Note', text: 'a notification' });
  ui.banner && ui.banner('BANNER', 'over the faded controls');
  return true;
});
await page.waitForTimeout(1600);
let i2 = await idleGet();
R.ok(i2.hidden === true && i2.wakes === w0,
  'P7-4 a toast, a banner and a notification do not wake the controls',
  `hidden ${i2.hidden} wakes ${w0} -> ${i2.wakes} why ${i2.why}`);

/* ---- 3. the thumbstick: hold, then a system cancel ---- */
await page.evaluate(() => WALLY.debug.idle(20));
await H.down(1, 195, 300); await H.up(1); await H.wait(80);
await H.down(1, 195, 300); await H.up(1); await H.wait(900);   // wake
await page.waitForTimeout(500);
const g2 = await padGeom(page);
await arm(page);
await H.down(1, g2.zone.cx, g2.zone.cy);
await H.wait(60);
await H.move(1, g2.zone.cx + 6, g2.zone.cy - 34);
await H.wait(400);
const held = await page.evaluate(() => WALLY.debug.touchState());
await H.cancel();
await H.wait(700);
const after = await page.evaluate(() => WALLY.debug.touchState());
const sp = await page.evaluate(() => { const c = WALLY.ctx.wally.controller; const v = c && (c.velocity || c.vel); return v ? +Math.hypot(v.x, v.z).toFixed(2) : null; });
await stop(page);
R.ok(held.t > 0 && after.t === 0 && !after.active && sp < 0.5,
  'P7-5 a thumbstick hold that the system cancels unlatches: the stick returns to rest and he stops',
  `held t ${held.t.toFixed(2)} -> ${after.t}, active ${after.active}, speed ${sp}`);

/* ---- 4. Settings turning Hide UI off while faded restores the pad ---- */
await idleSet(1.2);
i = await goIdle();
R.ok(i.hidden, 'P7-6a faded before the settings change');
await page.evaluate(() => WALLY.debug.hideUI(false));
await page.waitForTimeout(700);
i2 = await idleGet();
const gg = await padGeom(page);
R.ok(i2.hidden === false && gg.act.hit,
  'P7-6b turning Hide UI off while the controls are faded brings them straight back',
  `hidden ${i2.hidden} why ${i2.why} act op ${gg.act.op} vis ${gg.act.vis}`);

/* ---- 5. the touch layer switched off and on while faded ---- */
await page.evaluate(() => WALLY.debug.hideUI(true));
await idleSet(1.2);
i = await goIdle();
R.ok(i.hidden, 'P7-7a faded again');
await page.evaluate(() => WALLY.ctx.ui.setTouch(false));
await page.waitForTimeout(400);
const offState = await page.evaluate(() => ({ t: WALLY.debug.touchState(), i: WALLY.debug.idle() }));
await page.evaluate(() => WALLY.ctx.ui.setTouch(true));
await page.waitForTimeout(600);
const onState = await page.evaluate(() => ({ t: WALLY.debug.touchState(), i: WALLY.debug.idle() }));
const g3 = await padGeom(page);
R.ok(offState.t.enabled === false && onState.t.enabled === true && onState.i.hidden === false && g3.act.hit,
  'P7-8 Settings > Touch controls off and on again while faded leaves the pad up and pressable',
  `off ${offState.t.enabled}/${offState.i.why} -> on ${onState.t.enabled}/${onState.i.why} hidden ${onState.i.hidden} act op ${g3.act.op}`);

/* and it really is pressable */
await toDoor(page); await page.evaluate(() => WALLY.ctx.ui.closeAll());
await page.waitForTimeout(500);
const g4 = await padGeom(page);
await arm(page);
await H.tap(g4.act.cx, g4.act.cy, 250);
await H.wait(900);
let r = await stop(page);
R.ok(count(r, 'interact') === 1 && r.panels.length === 1,
  'P7-9 ...and one tap on it opens the door',
  `verbs ${verbList(r)} panels ${JSON.stringify(r.panels)}`);
await page.evaluate(() => WALLY.ctx.ui.closeAll());

/* ---- 6. rotation re-centres the seam ---- */
await page.evaluate(() => { WALLY.debug.hideUI(true); WALLY.debug.idle(1.2); return null; });
i = await goIdle();
R.ok(i.hidden, 'P7-10a faded before the rotation');
const seamBefore = (await padGeom(page)).seam;
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(900);
const seamAfter = (await padGeom(page)).seam;
const centred = Math.abs((seamAfter.x + seamAfter.w / 2) - 422) < 8;
R.ok(centred,
  'P7-10b the seam re-centres on rotation while the controls are faded',
  `before centre ${seamBefore.x + seamBefore.w / 2} of 390; after ${seamAfter.x + seamAfter.w / 2} of 844`);
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(600);

console.log(`\n${R.fails} failure(s). page errors: ${B.errs.length}`, B.errs.slice(0, 6).join(' | '));
await B.close();
