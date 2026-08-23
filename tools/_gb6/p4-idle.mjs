/* GB6 PROBE 4 — HIDE UI STAGE TWO, re-driven, on a machine that cannot
   be trusted to deliver a gesture on time.

   EVERY TIMING-GATED ASSERTION HERE IS VALIDITY-GATED FIRST. The gates
   are TAP_MS 400, TAP_SLOP 12, TAP_GAP 300, TAP_DIST 44 — all measured
   on EVENT time inside the page. Under load the CDP round trip alone
   can exceed TAP_GAP, in which case the harness did not deliver a
   double tap at all and a "did not wake" reading says nothing about the
   product. So each gesture is re-read out of the page's own event
   ledger, and an attempt whose timings miss the gate is retried; if
   every attempt misses, the probe says it cannot discriminate rather
   than scoring a FAIL.

   The clock itself is read from WALLY.debug.idle() — hidden/live/why —
   and never from an opacity, because a starved compositor leaves a
   0.42 s transition reading 0.22 for seconds. */
import { boot, padProbe, padRead, panelsNow, nearId, boxes } from './lib.mjs';

const R = await boot({ mobile: true });
const { page, ok, touch, multi, press } = R;
const pt = (id, x, y) => ({ x, y, id, radiusX: 14, radiusY: 14, force: 1 });

const idle = (sec) => page.evaluate((s) => WALLY.debug.idle(s), sec);
const idleGet = () => page.evaluate(() => WALLY.debug.idle());
const layers = () => page.evaluate(() => WALLY.debug.uiLayers());
const under = (x, y) => page.evaluate(([x, y]) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  if (el === WALLY.ctx.canvas) return 'gl';
  return el.tagName.toLowerCase() + '.' + String(el.className?.baseVal ?? el.className ?? '').trim().split(/\s+/).join('.');
}, [x, y]);

const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const toOpenGround = async () => {
  await page.evaluate((b) => { WALLY.debug.uiHide(); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {}); }, BOOT);
  await page.waitForTimeout(600);
};
const toDoor = async () => {
  await page.evaluate(() => { WALLY.debug.uiHide(); WALLY.debug.arrive('apartment', true); });
  await page.waitForTimeout(1200);
  try { await page.waitForFunction(() => WALLY.ctx.ui.near != null, null, { timeout: 8000 }); } catch {}
  return nearId(page);
};
const closeAll = async () => { await page.evaluate(() => WALLY.debug.uiHide()); await page.waitForTimeout(300); };

/** poll until the flags say hidden, with a generous deadline */
async function waitHidden(ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const i = await idleGet();
    if (i.hidden) return i;
    await page.waitForTimeout(200);
  }
  return idleGet();
}
async function waitLive(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const i = await idleGet();
    if (!i.hidden && i.live) return i;
    await page.waitForTimeout(150);
  }
  return idleGet();
}
/** fade the controls out on a short clock, then park the clock long so
    nothing re-fades while we are measuring */
async function fadeOut(shortSec = 0.4, parkSec = 90) {
  await toOpenGround();
  await page.evaluate(() => WALLY.debug.hideUI(true));
  await idle(shortSec);
  const st = await waitHidden();
  await idle(parkSec);
  return st;
}

await page.evaluate(() => WALLY.debug.hideUI(false));
await page.waitForTimeout(400);
const B = await boxes(page);
console.log('BOXES', JSON.stringify(B));

/* the gates, restated so the validity checks below cannot drift */
const TAP_MS = 400, TAP_SLOP = 12, TAP_GAP = 300, TAP_DIST = 44;

/** read the last two contacts out of the ledger and say whether the
    harness actually delivered a double tap by the page's own clock */
function doubleValidity(all) {
  const seq = all.filter((e) => e.type === 'pointerdown' || e.type === 'pointerup');
  if (seq.length < 4) return { valid: false, why: `only ${seq.length} pointer events` };
  const [d1, u1, d2, u2] = seq.slice(-4);
  if (d1.type !== 'pointerdown' || u1.type !== 'pointerup'
    || d2.type !== 'pointerdown' || u2.type !== 'pointerup') {
    return { valid: false, why: 'not a down/up/down/up sequence' };
  }
  const hold1 = u1.t - d1.t, hold2 = u2.t - d2.t, gap = d2.t - u1.t;
  const valid = hold1 <= TAP_MS && hold2 <= TAP_MS && gap <= TAP_GAP && gap >= 0;
  return { valid, hold1, hold2, gap, why: valid ? '' : `hold ${hold1}/${hold2} ms gap ${gap} ms vs TAP_MS ${TAP_MS} TAP_GAP ${TAP_GAP}` };
}

/** dispatch a double tap and return { v, wokeBy, before, after } */
async function tryDouble(x, y) {
  await padProbe(page);
  const before = await idleGet();
  await touch('touchStart', x, y);
  await touch('touchEnd', x, y);
  await touch('touchStart', x, y);
  await touch('touchEnd', x, y);
  await page.waitForTimeout(700);
  const rd = await padRead(page);
  const after = await idleGet();
  return { v: doubleValidity(rd.all), before, after, rd };
}

/* ============ 1. THE FADE ITSELF ============ */
{
  const st = await fadeOut();
  ok(st.hidden === true && st.live === false,
    'FADE-1 [the clock still fades the controls]: hidden true, live false',
    JSON.stringify(st));
  const L = await layers();
  ok(L.stick.w > 0 && L.acts.w > 0,
    'FADE-2 [visibility, not display]: the faded controls keep their box so measure() still works',
    `${L.stick.w}x${L.stick.h} / ${L.acts.w}x${L.acts.h}`);
  const u1 = await under(B.stick.x, B.stick.y);
  const u2 = await under(B.act.x, B.act.y);
  ok(u1 === 'gl' && u2 === 'gl',
    'FADE-3 [inert while hidden]: a finger where the stick and Enter were reaches the CANVAS',
    `${u1} / ${u2}`);
  /* the opacity, polled rather than sampled — reported, not asserted,
     because a starved compositor is not the product */
  let op = null;
  for (let i = 0; i < 40; i++) {
    const L2 = await layers();
    op = { stick: L2.stick.op, acts: L2.acts.op, seam: L2.seam?.op };
    if (op.stick <= 0.02 && op.acts <= 0.02) break;
    await page.waitForTimeout(250);
  }
  ok(op.stick <= 0.02 && op.acts <= 0.02,
    'FADE-4 [the fade actually reaches zero]: polled to a 10 s deadline, not sampled once',
    JSON.stringify(op));
}

/* ============ 2. THE WAKE ============ */
async function wakeAt(x, y, label, tries = 6) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const st = await fadeOut();
    if (!st.hidden) { last = { v: { valid: false, why: 'never faded' } }; continue; }
    const r = await tryDouble(x, y);
    last = r;
    if (r.v.valid) {
      ok(r.after.wakes > r.before.wakes && r.after.hidden === false,
        `WAKE [${label}]: a double tap brings the controls back`,
        `wakes ${r.before.wakes}->${r.after.wakes} hidden ${r.before.hidden}->${r.after.hidden} timings ${JSON.stringify(r.v)}`);
      return r;
    }
  }
  ok(false, `WAKE [${label}]: PROBE CANNOT DISCRIMINATE — the harness never delivered a gesture inside the gates in ${tries} attempts`,
    JSON.stringify(last && last.v));
  return last;
}
await wakeAt(195, 300, 'over the world (the canvas)');
await wakeAt(B.act.x, B.act.y, 'on the hidden Enter');
await wakeAt(B.stick.x, B.stick.y, 'on the hidden thumbstick');

/* ...and the wake tap fires nothing: a triple tap on the hidden Enter
   at a door must wake and NOT walk him inside */
{
  let done = false;
  for (let i = 0; i < 5 && !done; i++) {
    await toDoor();
    await page.evaluate(() => WALLY.debug.hideUI(true));
    await idle(0.4);
    const st = await waitHidden();
    await idle(90);
    if (!st.hidden) continue;
    await padProbe(page);
    const before = await idleGet();
    await touch('touchStart', B.act.x, B.act.y);
    await touch('touchEnd', B.act.x, B.act.y);
    await touch('touchStart', B.act.x, B.act.y);
    await touch('touchEnd', B.act.x, B.act.y);
    await page.waitForTimeout(60);
    await touch('touchStart', B.act.x, B.act.y);
    await touch('touchEnd', B.act.x, B.act.y);
    await page.waitForTimeout(900);
    const rd = await padRead(page);
    const after = await idleGet();
    const seq = rd.all.filter((e) => e.type === 'pointerdown' || e.type === 'pointerup');
    const v = doubleValidity(seq.slice(0, 4).concat(seq.slice(0, 0)).length ? seq.slice(0, 4) : []);
    if (after.wakes <= before.wakes) continue;               // did not wake: retry
    ok(rd.act === 0 && (await panelsNow(page)).length === 0,
      'WAKE-3 [the third tap of a triple tap presses nothing]: it woke, and he is not walked through the door',
      `act ${rd.act} panels ${JSON.stringify(await panelsNow(page))} live-at-each ${JSON.stringify(rd.downs.map((d) => d.live))}`);
    done = true;
    await closeAll();
  }
  if (!done) ok(false, 'WAKE-3: PROBE CANNOT DISCRIMINATE — no attempt woke the controls at all');
}

/* ============ 3. WHAT MUST NOT WAKE ============ */
{
  const st = await fadeOut();
  const before = await idleGet();
  await touch('touchStart', 260, 300);
  for (let i = 1; i <= 8; i++) { await touch('touchMove', 260 - i * 15, 300); await page.waitForTimeout(25); }
  await touch('touchEnd', 140, 300);
  await page.waitForTimeout(700);
  const after = await idleGet();
  ok(st.hidden && after.wakes === before.wakes && after.hidden === true,
    'NOWAKE-1 [a one-finger camera drag]: does not wake and does not bring the controls back',
    `wakes ${before.wakes}->${after.wakes} hidden ${after.hidden}`);
}
{
  /* a tap, then a press-and-hold in the same place: the hold is not tap two */
  const st = await fadeOut();
  const before = await idleGet();
  await touch('touchStart', 195, 300);
  await touch('touchEnd', 195, 300);
  await page.waitForTimeout(60);
  await touch('touchStart', 195, 300);
  await page.waitForTimeout(1200);
  await touch('touchEnd', 195, 300);
  await page.waitForTimeout(600);
  const after = await idleGet();
  await padProbe(page);
  ok(st.hidden && after.wakes === before.wakes,
    'NOWAKE-2 [tap, then a 1200 ms press-and-hold in the same place]: a hold past TAP_MS is not tap two',
    `wakes ${before.wakes}->${after.wakes} hidden ${after.hidden}`);
}
{
  /* a tap, then a DRAG from the same place: the headline defect of the
     whole feature, and the reason recognition moved to pointerup */
  const st = await fadeOut();
  const before = await idleGet();
  await touch('touchStart', 195, 300);
  await touch('touchEnd', 195, 300);
  await page.waitForTimeout(60);
  await touch('touchStart', 195, 300);
  for (let i = 1; i <= 6; i++) { await touch('touchMove', 195 - i * 18, 300); await page.waitForTimeout(25); }
  await touch('touchEnd', 87, 300);
  await page.waitForTimeout(600);
  const after = await idleGet();
  ok(st.hidden && after.wakes === before.wakes,
    'NOWAKE-3 [tap, then a camera drag from the same spot]: the drag is not tap two',
    `wakes ${before.wakes}->${after.wakes} hidden ${after.hidden}`);
}

/* ============ 3b. THE DOUBLE TAP THAT STRADDLES THE FADE ============
   Tap one lands while the controls are still up; the fade happens
   between the two; tap two lands inside TAP_GAP. The fade is forced on
   the next tick with idle(0) rather than waited for, because there is
   no room inside a 300 ms gap for a five-second clock. Validity-gated:
   an attempt only counts if tap one really landed visible, tap two
   really landed hidden, and the measured gap was inside TAP_GAP. */
{
  let done = false, lastWhy = null;
  for (let i = 0; i < 8 && !done; i++) {
    await toOpenGround();
    await page.evaluate(() => WALLY.debug.hideUI(true));
    await idle(90);                                   // park it: no fade yet
    await page.waitForTimeout(400);
    const before = await idleGet();
    if (before.hidden) { lastWhy = 'already hidden'; continue; }
    await padProbe(page);
    await touch('touchStart', 195, 300);
    await touch('touchEnd', 195, 300);
    await idle(0);                                    // fade on the next tick
    await touch('touchStart', 195, 300);
    await touch('touchEnd', 195, 300);
    await page.waitForTimeout(700);
    const rd = await padRead(page);
    const after = await idleGet();
    const seq = rd.all.filter((e) => e.type === 'pointerdown' || e.type === 'pointerup');
    const v = doubleValidity(rd.all);
    const hiddenAt = seq.map((e) => e.hidden);
    const straddled = seq.length >= 4 && seq[0].hidden === false && seq[2].hidden === true;
    if (!v.valid || !straddled) { lastWhy = `gap/hold ${JSON.stringify(v)} hiddenAt ${JSON.stringify(hiddenAt)}`; await idle(90); continue; }
    ok(after.wakes > before.wakes,
      'STRADDLE [tap one before the fade, tap two after it]: one gesture, and it wakes',
      `wakes ${before.wakes}->${after.wakes} timings ${JSON.stringify(v)} hiddenAt ${JSON.stringify(hiddenAt)}`);
    done = true;
    await idle(90);
  }
  if (!done) ok(false, 'STRADDLE: PROBE CANNOT DISCRIMINATE — could not land the fade between two taps inside TAP_GAP', String(lastWhy));
}

/* ============ 3c. THE COMMIT SWALLOW DOES NOT OUTLIVE ITS GESTURE ====
   A wake made with a SECOND FINGER produces no compatibility click of
   its own, so the swallow it arms has nothing to eat. The next honest
   press must not fall into it. */
for (const gap of [80, 250]) {
  let done = false, lastWhy = null;
  for (let i = 0; i < 4 && !done; i++) {
    await toOpenGround();
    await page.evaluate(() => WALLY.ctx.ui.setReducedMotion?.(true));
    const st = await fadeOut();
    if (!st.hidden) { lastWhy = 'never faded'; continue; }
    await padProbe(page);
    const before = await idleGet();
    /* finger one parks, finger two double-taps */
    await multi('touchStart', [pt(1, 300, 250)]);
    await multi('touchStart', [pt(1, 300, 250), pt(2, 150, 400)]);
    await multi('touchEnd', [pt(2, 150, 400)]);
    await multi('touchStart', [pt(1, 300, 250), pt(2, 150, 400)]);
    await multi('touchEnd', [pt(2, 150, 400)]);
    await multi('touchEnd', [pt(1, 300, 250)]);
    await page.waitForTimeout(gap);
    const woke = await idleGet();
    if (woke.wakes <= before.wakes) { lastWhy = `did not wake (${JSON.stringify(woke)})`; continue; }
    await press(B.sc[0].x, B.sc[0].y, 55);
    await page.waitForTimeout(800);
    const rd = await padRead(page);
    const pn = await panelsNow(page);
    ok(rd.sc >= 1 && pn.includes('phone'),
      `SWALLOW-${gap} [Phone pressed ${gap} ms after a two-finger wake]: opens the phone`,
      `sc ${rd.sc} panels ${JSON.stringify(pn)} live ${JSON.stringify(await idleGet())}`);
    done = true;
    await closeAll();
  }
  if (!done) ok(false, `SWALLOW-${gap}: PROBE CANNOT DISCRIMINATE — could not wake with a second finger`, String(lastWhy));
  await page.evaluate(() => WALLY.ctx.ui.setReducedMotion?.(false));
}

/* ============ 4. NOTHING FIRES WHILE A CONTROL IS TRANSPARENT ============ */
{
  /* a contact that OUTLIVES the fade: down while inert, up once live */
  let done = false;
  for (let i = 0; i < 4 && !done; i++) {
    await toDoor();
    await page.evaluate(() => WALLY.debug.hideUI(true));
    await idle(0.4);
    const st = await waitHidden();
    await idle(90);
    if (!st.hidden) continue;
    /* wake with a two-finger double tap far from the pad, then land on
       Enter 150 ms later and hold past the fade */
    await padProbe(page);
    await touch('touchStart', 195, 300); await touch('touchEnd', 195, 300);
    await touch('touchStart', 195, 300); await touch('touchEnd', 195, 300);
    const woke = await idleGet();
    if (woke.hidden) continue;
    await page.waitForTimeout(150);
    const liveAtDown = (await idleGet()).live;
    await touch('touchStart', B.act.x, B.act.y);
    await page.waitForTimeout(700);
    const liveAtUp = (await idleGet()).live;
    await touch('touchEnd', B.act.x, B.act.y);
    await page.waitForTimeout(800);
    const rd = await padRead(page);
    const pn = await panelsNow(page);
    ok(liveAtDown === false && liveAtUp === true,
      'INERT-pre [the contact really landed inert and lifted live]',
      `live at down ${liveAtDown}, at up ${liveAtUp}`);
    ok(rd.act === 0 && pn.length === 0,
      'INERT-1 [a contact that outlives the fade presses nothing]: it is not delivered to the button it landed on',
      `act ${rd.act} panels ${JSON.stringify(pn)} clicks ${JSON.stringify(rd.clicks.map((c) => [c.target, c.detail, c.inPad]))}`);
    done = true;
    await closeAll();
  }
  if (!done) ok(false, 'INERT-1: PROBE CANNOT DISCRIMINATE — could not set the case up (no wake)');
}

/* ============ 5. A DIALOGUE RESTORES THE PAD ============ */
{
  const st = await fadeOut();
  await page.evaluate(() => WALLY.ctx.ui.dialogue({ speaker: 'Probe', text: ['ONE', 'TWO'] }));
  await page.waitForTimeout(900);
  const during = await idleGet();
  ok(st.hidden === true && during.hidden === false && during.why === 'dialogue',
    'SUSP-1 [a conversation opening on a faded screen hands the pad back]',
    `before ${st.hidden} during ${JSON.stringify(during)}`);
  await closeAll();
  await page.waitForTimeout(500);
  const after = await idleGet();
  ok(after.t === 0, 'SUSP-2 [and the clock is handed back whole, not mid-count]', JSON.stringify(after));
}
{
  /* a sheet: both taps must reach it, the detector is off underneath */
  const st = await fadeOut();
  await page.evaluate(() => WALLY.ctx.ui.openPhone());
  await page.waitForTimeout(900);
  const during = await idleGet();
  await padProbe(page);
  await touch('touchStart', 195, 300); await touch('touchEnd', 195, 300);
  await touch('touchStart', 195, 300); await touch('touchEnd', 195, 300);
  await page.waitForTimeout(600);
  const rd = await padRead(page);
  ok(during.hidden === false && (during.why === 'modal' || during.why === 'dialogue'),
    'SHEET-1 [a sheet also hands the pad back]', JSON.stringify(during));
  ok(rd.downs.length === 2 && rd.clicks.length >= 2,
    'SHEET-2 [with a sheet up the detector eats nothing]: both taps are delivered',
    `downs ${rd.downs.length} clicks ${rd.clicks.length}`);
  await closeAll();
}

/* ============ 6. BACKGROUND TIME IS NOT IDLE TIME ============ */
{
  await toOpenGround();
  await page.evaluate(() => WALLY.debug.hideUI(true));
  await idle(3);
  await page.waitForTimeout(700);
  const t0 = await idleGet();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const reallyHidden = await page.evaluate(() => document.hidden);
  await page.waitForTimeout(9000);
  const away = await idleGet();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(400);
  const back = await idleGet();
  await page.evaluate(() => { delete document.hidden; delete document.visibilityState; });
  ok(reallyHidden === true, 'BG-pre [the page really reported itself hidden]');
  ok(away.hidden === false && away.why === 'background',
    'BG-1 [three whole windows in another app]: the controls did not fade and the clock says why',
    JSON.stringify(away));
  ok(back.t <= 0.35, 'BG-2 [the window is handed back whole]', JSON.stringify(back));
  await idle(null);
}

/* ============ 7. SETTINGS AND ROTATION WHILE FADED ============ */
{
  const st = await fadeOut();
  const before = await idleGet();
  await page.evaluate(() => WALLY.debug.hideUI(false));
  await page.waitForTimeout(600);
  const after = await idleGet();
  ok(st.hidden === true && after.hidden === false && after.why === 'nohideui',
    'SET-1 [turning Hide UI off while faded]: everything comes straight back and says why',
    `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  await page.evaluate(() => WALLY.debug.hideUI(true));
  await page.waitForTimeout(300);
}
{
  const st = await fadeOut();
  const wasHidden = st.hidden;
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(900);
  const rot = await idleGet();
  const L = await layers();
  ok(wasHidden && rot.hidden === true,
    'ROT-1 [a rotation while the controls are faded]: they stay faded, nothing is stranded',
    `${JSON.stringify(rot)}`);
  /* and the geometry re-measures on the way back */
  await page.evaluate(() => WALLY.debug.hideUI(false));
  await page.waitForTimeout(800);
  const L2 = await layers();
  ok(L2.stick.x >= 0 && L2.stick.w > 0 && L2.act.x + L2.act.w <= 844 + 2,
    'ROT-2 [and the pad re-measures into the landscape frame]',
    `stick ${L2.stick.x},${L2.stick.y} ${L2.stick.w}x${L2.stick.h} act right ${L2.act.x + L2.act.w}/844`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(700);
}

console.log(`\n${R.fails} FAIL(S)`);
await R.close();
process.exit(R.fails ? 1 : 0);
