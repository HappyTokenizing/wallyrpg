/* _gb11-h.mjs — ROUND TEN part H. The standing set's POINTER half, run
   independently: the primary-button gate on all seven controls, the
   capture-loss A/B with the chorded gesture, and the Enter cases.
   Real Input.dispatchMouseEvent / dispatchTouchEvent throughout. The
   ONE synthetic event is lostpointercapture, which no input API can
   produce — and the contact underneath it is a real dispatched one. */
import { boot, driver, load, cpus } from './_gb11-lib.mjs';

console.log('LOAD at boot:', load(), `(${cpus()} cpus)`);
const B = await boot();
const d = driver(B.page, B.cdp);
let fails = 0, n = 0;
const ok = (c, name, detail = '') => { n++; if (!c) fails++;
  console.log(`${c ? 'FINE   ' : 'BROKEN '} ${name}${detail ? '\n           ' + detail : ''}`); return c; };

const snapshot = () => B.page.evaluate(() => ({
  panels: WALLY.ctx.ui.panels.length,
  jump: WALLY.debug.touchState().jump.held,
  axes: (() => { const a = WALLY.debug.touchState(); return +(Math.abs(a.x) + Math.abs(a.z)).toFixed(3); })(),
  act: JSON.stringify(WALLY.debug.interact() || null),
}));
const changed = (a, b) => a.panels !== b.panels || a.jump !== b.jump || a.axes !== b.axes || a.act !== b.act;

console.log('\n──── THE PRIMARY-BUTTON GATE ON ALL SEVEN CONTROLS ────');
{
  const stick = await d.stickAt();
  const controls = [];
  for (const l of ['Phone', 'Places', 'Desk', 'Menu', 'Enter or talk', 'Jump']) {
    const p = await d.padAt(l); if (p) controls.push({ name: l, ...p });
  }
  if (stick) controls.push({ name: 'stick', x: stick.x, y: stick.y });
  console.log(`  controls found: ${controls.length} — ${controls.map(c => c.name).join(', ')}`);
  const BTN = [['left', 1], ['middle', 4], ['right', 2], ['back', 8], ['forward', 16]];
  const grid = {};
  for (const c of controls) {
    grid[c.name] = {};
    for (const [b, mask] of BTN) {
      await d.reset(); await d.wait(120);
      const before = await snapshot();
      await d.mouse('mousePressed', c.x, c.y, b, mask, 1);
      await d.wait(70);
      if (c.name === 'stick') { await d.mouse('mouseMoved', c.x + 40, c.y - 40, b, mask, 0); await d.wait(70); }
      const mid = await snapshot();
      await d.mouse('mouseReleased', c.x, c.y, b, mask, 1);
      await d.wait(280);
      const after = await snapshot();
      grid[c.name][b] = changed(before, mid) || changed(before, after);
    }
  }
  console.log('  control        ' + BTN.map(([b]) => b.padEnd(8)).join(''));
  for (const c of controls) console.log(`  ${c.name.padEnd(14)} ` + BTN.map(([b]) => (grid[c.name][b] ? 'FIRED' : '-').padEnd(8)).join(''));
  const leak = [];
  for (const c of controls) for (const [b] of BTN) if (b !== 'left' && grid[c.name][b]) leak.push(`${c.name}/${b}`);
  ok(leak.length === 0, 'no verb on the pad fires from a secondary button (middle, right, back, forward)',
    leak.length ? 'fired: ' + leak.join(', ') : 'seven controls x four secondary buttons, none fired');
  const leftWorks = controls.filter(c => grid[c.name].left).length;
  ok(leftWorks >= 5, `BRANCH CHECK: the same dispatch on PRIMARY does fire (${leftWorks}/${controls.length}) — otherwise the row above is blind`,
    controls.map(c => `${c.name}:${grid[c.name].left ? 'fired' : 'no'}`).join(' '));
}

console.log('\n──── A CAPTURE LOSS WITH THE CONTACT STILL DOWN ────');
{
  /* the chorded gesture: button NONE (-1), buttons 1 — a real
     lostpointercapture while the contact is still down. An ordinary
     left (button 0, buttons 1) is a different event and, as the brief
     says, cannot discriminate. */
  const lose = (sel, id, buttons) => B.page.evaluate(([s, i, b]) => {
    const el = s === 'stick' ? (document.querySelector('.w-stick')?.closest('*') || document.querySelector('.w-zone') || document.querySelector('[class*="zone"]'))
      : [...document.querySelectorAll('.w-abtn')].find(e => e.getAttribute('aria-label') === s);
    if (!el) return 'no element';
    el.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: i, button: -1, buttons: b, bubbles: true }));
    return 'sent';
  }, [sel, id, buttons]);

  for (const retry of [true, false]) {
    await B.page.evaluate((r) => WALLY.debug.padCaptureRetry(r), retry);
    /* BUTTON: press Jump for real, tear the capture away chorded, then
       release for real. With the retry on the press must survive and
       the verb must run. */
    let btnFired = 0, stickAlive = 0;
    for (let i = 0; i < 4; i++) {
      await d.reset(); await d.wait(120);
      const j = await d.padAt('Jump');
      await d.touch('touchStart', j.x, j.y); await d.wait(50);
      await lose('Jump', 1, 1);                     // chorded: still down
      await d.wait(50);
      const before = await snapshot();
      await d.touch('touchEnd', j.x, j.y); await d.wait(300);
      const after = await snapshot();
      if (before.act !== after.act || before.jump !== after.jump || true) { /* jump verb: read vy */ }
      const flew = await B.page.evaluate(() => WALLY.ctx.phys?.controller?.vy ?? WALLY.debug.touchState().jump.held);
      if (flew) btnFired++;
      /* STICK: drag it, tear the capture away chorded mid-drag, keep dragging */
      await d.reset(); await d.wait(120);
      const s = await d.stickAt();
      await d.touch('touchStart', s.x, s.y); await d.wait(40);
      await d.touch('touchMove', s.x + 45, s.y - 10); await d.wait(40);
      await lose('stick', 1, 1);
      await d.touch('touchMove', s.x + 55, s.y - 12); await d.wait(60);
      const ax = (await snapshot()).axes;
      await d.touch('touchEnd', s.x + 55, s.y - 12); await d.wait(200);
      if (ax > 0.15) stickAlive++;
    }
    console.log(`  captureRetry=${String(retry).padEnd(5)}  Jump survived the loss ${btnFired}/4   stick still deflected after the loss ${stickAlive}/4`);
    if (retry) {
      ok(btnFired >= 3, 'a chorded capture loss does not kill a button press (retry on)', `${btnFired}/4`);
      ok(stickAlive >= 3, 'a chorded capture loss does not strand the thumbstick (retry on)', `${stickAlive}/4`);
    }
  }
  await B.page.evaluate(() => WALLY.debug.padCaptureRetry(true));

  /* the touch path: a loss carrying buttons 0 is a release, and on the
     touch path the real pointerup arrives anyway, so it must be a
     no-op rather than a double release. */
  await d.reset(); await d.wait(120);
  const s = await d.stickAt();
  await d.touch('touchStart', s.x, s.y); await d.wait(40);
  await d.touch('touchMove', s.x + 45, s.y - 10); await d.wait(60);
  const live = (await snapshot()).axes;
  await lose('stick', 1, 0);                        // buttons 0 = released
  await d.wait(80);
  const afterLoss = (await snapshot()).axes;
  await d.touch('touchEnd', s.x + 45, s.y - 10); await d.wait(200);
  const afterUp = (await snapshot()).axes;
  ok(live > 0.15, 'BRANCH CHECK: the stick was really deflected before the loss', `axes ${live}`);
  ok(afterUp < 0.05, 'a loss carrying buttons 0 leaves the stick releasable, not stuck', `live ${live} -> loss ${afterLoss} -> up ${afterUp}`);
}

console.log('\n──── ENTER ────');
{
  /* stick held plus Enter */
  await d.reset(); await d.wait(150);
  const s = await d.stickAt();
  await d.touch('touchStart', s.x, s.y); await d.wait(40);
  await d.touch('touchMove', s.x + 45, s.y - 10); await d.wait(300);
  const walking = (await snapshot()).axes;
  const a0 = await B.page.evaluate(() => JSON.stringify(WALLY.debug.interact() || null));
  const e = await d.padAt('Enter or talk');
  await d.touch('touchStart', e.x, e.y, 2); await d.wait(60);
  await B.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: s.x + 45, y: s.y - 10, id: 1, radiusX: 14, radiusY: 14, force: 1 }] });
  await d.wait(300);
  const a1 = await B.page.evaluate(() => JSON.stringify(WALLY.debug.interact() || null));
  await d.touch('touchEnd', s.x + 45, s.y - 10);
  await d.wait(200);
  ok(walking > 0.15, 'BRANCH CHECK: he was really walking when Enter was pressed', `axes ${walking}`);
  ok(a0 !== a1, 'Enter fires with the stick still held', `${a0} -> ${a1}`);

  /* two thumbs on Jump: the second contact must not steal the release */
  await d.reset(); await d.wait(150);
  const j = await d.padAt('Jump');
  await B.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: j.x - 8, y: j.y, id: 1, radiusX: 14, radiusY: 14, force: 1 }] });
  await d.wait(60);
  await B.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [
    { x: j.x - 8, y: j.y, id: 1, radiusX: 14, radiusY: 14, force: 1 }, { x: j.x + 8, y: j.y, id: 2, radiusX: 14, radiusY: 14, force: 1 }] });
  await d.wait(60);
  const own = await B.page.evaluate(() => WALLY.debug.touchState().jump);
  await B.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: j.x - 8, y: j.y, id: 1, radiusX: 14, radiusY: 14, force: 1 }] });
  await d.wait(80);
  const stillHeld = await B.page.evaluate(() => WALLY.debug.touchState().jump);
  await B.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await d.wait(200);
  const released = await B.page.evaluate(() => WALLY.debug.touchState().jump);
  ok(own.held === true && own.id === 1, 'BRANCH CHECK: the FIRST thumb owns Jump', JSON.stringify(own));
  ok(stillHeld.held === true, 'the second thumb lifting does not let go of Jump for the first', JSON.stringify(stillHeld));
  ok(released.held === false, '...and the owning thumb lifting does', JSON.stringify(released));
}

console.log(`\n${fails} BROKEN of ${n}`);
console.log('errs:', JSON.stringify(B.errs));
console.log('LOAD at end:', load());
await B.close();
