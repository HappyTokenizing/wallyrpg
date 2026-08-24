/* _gb12-e.mjs — THE THIRD UN-SIGNER, AND THE STANDING SET'S KEY HALF
   re-measured with the discriminations the previous pass could not
   make. Real dispatched touches and keys throughout. */
import { boot, driver, load, cpus, clock, readClock, fmt } from './_gb12-lib.mjs';

console.log('LOAD at boot:', load(), `(${cpus()} cpus)`);
const B = await boot(); const d = driver(B.page, B.cdp);
await clock(B.page);
let fails = 0, N = 0;
const ok = (c, name, detail = '') => { N++; if (!c) fails++;
  console.log(`${c ? 'FINE   ' : 'BROKEN '} ${name}${detail ? '\n           ' + detail : ''}`); return c; };
const padKb = () => B.page.evaluate(() => WALLY.debug.padKeyboard());
const rest  = () => B.page.evaluate(() => WALLY.debug.focusRestore());
const nPan  = () => B.page.evaluate(() => WALLY.ctx.ui.panels.length);
const setStall = (n) => B.page.evaluate((k) => WALLY.debug.padHandBackStall(k), n);
const vy = () => B.page.evaluate(() => (WALLY.ctx.phys?.controller?.vy ?? null));

console.log('\n──── 1. A DIALOGUE CHOICE FOCUS INSIDE THE HAND-BACK WINDOW ────');
/* dialogue.js:174 `chBox.firstChild?.focus?.()` is a THIRD focus() in
   this layer. ui.js's residual enumerates exactly two and calls the
   containment "asserted rather than assumed". Optional chaining is
   why a grep for `.focus(` misses it. */
{
  for (const withChoices of [true, false]) {
    let unsigned = 0, drvCleared = 0, n = 0;
    for (let i = 0; i < 3; i++) {
      await setStall(9);
      await d.reset(); await d.wait(200);
      await d.tabTo('Menu'); await d.thumb('Jump', 70, 250); await d.thumb('Menu', 70, 420);
      const res = await d.btnIn('resume'); if (!res) break;
      await readClock(B.page);
      await d.touch('touchStart', res.x, res.y); await d.wait(60);
      await d.touch('touchEnd', res.x, res.y);
      await d.wait(30);
      try {
        await B.page.evaluate((ch) => { try { WALLY.debug.ui('dialogue', ch
          ? { speaker: 'X', text: 'pick', portrait: 'wally', choices: [{ label: 'A' }, { label: 'B' }] }
          : { speaker: 'X', text: 'no choices here', portrait: 'wally' }); } catch (e) { window.__dlgErr = String(e); } }, withChoices);
      } catch (e) { console.log('  dialogue open threw:', String(e).split('\n')[0]); }
      await d.wait(900);
      const r = await rest(); const kb = await padKb(); n++;
      if (r && r.signed === false) unsigned++;
      if (kb.driving === false) drvCleared++;
      if (i === 0) console.log(`  choices=${withChoices}: rec ${JSON.stringify(r)}  kb ${JSON.stringify(kb)}`);
      try { await d.key('Escape', 20); await d.wait(150); await B.page.evaluate(() => WALLY.ctx.ui.closeAll()); } catch (e) {}
      await d.wait(300);
    }
    console.log(`  a dialogue WITH${withChoices ? '' : 'OUT'} choices opening in the window: hand-back unsigned ${unsigned}/${n}, driving cleared ${drvCleared}/${n}`);
  }
  await setStall(0);
}

console.log('\n──── 2. tab, touch, tab, SPACE — WHAT ACTUALLY FIRED? ────');
/* the standing set asserts "the button fires". A panel count cannot
   see JUMP firing, so the ring's destination decides what to measure. */
for (const target of ['Menu', 'Jump']) {
  await d.reset(); await d.wait(200);
  await d.tabTo('Menu'); await d.thumb('Jump', 110, 250);
  /* walk the ring on to the target with real Tabs */
  let f = null;
  for (let i = 0; i < 8; i++) { await d.key('Tab', 15); await d.wait(30); f = await d.focusNow();
    if (f.where === 'pad' && f.label === target) break; }
  const kb = await padKb(); const p0 = await nPan(); const v0 = await vy();
  await d.key('Space', 25); await d.wait(400);
  const p1 = await nPan(); const v1 = await vy();
  const panel = p1 > p0, jumped = (v1 !== v0) || (v1 > 0.5);
  ok(kb.padTakesSpace === true && (target === 'Menu' ? panel : jumped),
    `tab, touch, tab to ${target}, Space: that button's own verb runs`,
    `${JSON.stringify(kb)} ring=${f?.where}/${f?.label} panels ${p0}->${p1} vy ${v0}->${v1}`);
}

console.log('\n──── 3. THREE RAPID ENTERS ADVANCE A DIALOGUE EXACTLY THREE PAGES ────');
{
  await d.reset(); await d.wait(200);
  await B.page.evaluate(() => WALLY.debug.ui('dialogue', { speaker: 'X', portrait: 'wally',
    text: ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'] }));
  await d.wait(900);                                  // let page 1 finish typing
  const read = () => B.page.evaluate(() => {
    const c = document.querySelector('.w-dlg,.w-dialogue,[class*="dlg"]');
    return (c?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  });
  const p0 = await read();
  for (let i = 0; i < 3; i++) { await d.key('Enter', 20); await d.wait(90); }
  await d.wait(500);
  const p1 = await read();
  const idx = (s) => ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'].findIndex(p => s.includes(p));
  ok(idx(p0) === 0 && idx(p1) === 3, 'three rapid Enters advance exactly three pages',
    `"${p0}" (page ${idx(p0)}) -> "${p1}" (page ${idx(p1)})`);
  await B.page.evaluate(() => WALLY.ctx.ui.closeAll()); await d.wait(300);
}

console.log('\n──── 4. SLIDES, CANCEL, OFF-SCREEN RELEASE, RAPID REPEATS ────');
{
  const jp = await d.padAt('Jump'); const mn = await d.padAt('Menu');
  const jumpedBy = async (fn) => { await d.reset(); await d.wait(200);
    const v0 = await vy(); await fn(); await d.wait(350); const v1 = await vy();
    return { v0, v1, fired: v1 !== v0 }; };

  const slideOff = await jumpedBy(async () => {
    await d.touch('touchStart', jp.x, jp.y); await d.wait(60);
    await d.touch('touchMove', jp.x, jp.y - 180); await d.wait(60);
    await d.touch('touchEnd', jp.x, jp.y - 180); });
  ok(!slideOff.fired, 'a finger that slides OFF Jump before lifting does not fire it', JSON.stringify(slideOff));

  const slideOn = await jumpedBy(async () => {
    await d.touch('touchStart', jp.x, jp.y - 180); await d.wait(60);
    await d.touch('touchMove', jp.x, jp.y); await d.wait(60);
    await d.touch('touchEnd', jp.x, jp.y); });
  ok(!slideOn.fired, 'a finger that slides ON to Jump from outside does not fire it', JSON.stringify(slideOn));

  const cancelled = await jumpedBy(async () => {
    await d.touch('touchStart', jp.x, jp.y); await d.wait(60);
    await B.cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); });
  ok(!cancelled.fired, 'a cancelled contact does not fire the button', JSON.stringify(cancelled));

  const offScreen = await jumpedBy(async () => {
    await d.touch('touchStart', jp.x, jp.y); await d.wait(60);
    await d.touch('touchMove', jp.x, 900); await d.wait(40);
    await d.touch('touchEnd', jp.x, 900); });
  ok(!offScreen.fired, 'a release off the bottom of the screen does not fire the button', JSON.stringify(offScreen));

  /* BRANCH CHECK: the same button, pressed and released cleanly, does fire */
  const clean = await jumpedBy(async () => {
    await d.touch('touchStart', jp.x, jp.y); await d.wait(70); await d.touch('touchEnd', jp.x, jp.y); });
  ok(clean.fired, 'BRANCH CHECK: a clean press of Jump does fire it — the four rows above are not blind', JSON.stringify(clean));

  /* rapid repeats on a panel button: five fast taps must not stack five panels */
  await d.reset(); await d.wait(200);
  for (let i = 0; i < 5; i++) { await d.touch('touchStart', mn.x, mn.y); await d.wait(30); await d.touch('touchEnd', mn.x, mn.y); await d.wait(40); }
  await d.wait(700);
  const stacked = await B.page.evaluate(() => WALLY.ctx.ui.panels.slice());
  ok(stacked.filter(p => p === 'pause').length <= 1, 'five rapid taps on Menu do not stack five pause sheets', JSON.stringify(stacked));
  await d.reset();
}
console.log(`\n${fails} BROKEN of ${N} asserted`);
console.log('errs:', JSON.stringify(B.errs));
console.log('LOAD at end:', load());
await B.close();
