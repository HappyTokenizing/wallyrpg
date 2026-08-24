/* _gb12-c.mjs — THE NEIGHBOURHOOD OF THE RACE.
   Everything that can move focus inside the hand-back's window, and
   what the new yield does about it. Real dispatched touches and keys;
   the ONE script focus is the screen-reader rotor case, which is BY
   DEFINITION a focus with no DOM input event behind it (PAD-7) and is
   labelled as such wherever it appears. */
import { boot, driver, load, cpus, clock, readClock, mark, fmt } from './_gb12-lib.mjs';

console.log('LOAD at boot:', load(), `(${cpus()} cpus)`);
const B = await boot(); const d = driver(B.page, B.cdp);
await clock(B.page);
const padKb = () => B.page.evaluate(() => WALLY.debug.padKeyboard());
const rest  = () => B.page.evaluate(() => WALLY.debug.focusRestore());
const nPan  = () => B.page.evaluate(() => WALLY.ctx.ui.panels.length);
const setStall = (n) => B.page.evaluate((k) => WALLY.debug.padHandBackStall(k), n);
let fails = 0, N = 0;
const ok = (c, name, detail = '') => { N++; if (!c) fails++;
  console.log(`${c ? 'FINE   ' : 'BROKEN '} ${name}${detail ? '\n           ' + detail : ''}`); return c; };

/* the standard opening: one Tab ever, then thumbs, then a thumb close */
async function upToTheLift(stall) {
  await setStall(stall);
  await d.reset(); await d.wait(200);
  const t = await d.tabTo('Menu'); if (!t) throw new Error('no Menu by Tab');
  await d.thumb('Jump', 70, 260);                 // driving := true
  await d.thumb('Menu', 70, 430);                 // pause sheet, by thumb
  const res = await d.btnIn('resume'); if (!res) throw new Error('no Resume');
  await readClock(B.page);
  await d.touch('touchStart', res.x, res.y); await d.wait(70);
  await mark(B.page, 'LIFT');
  await d.touch('touchEnd', res.x, res.y);
}
async function settle(ms = 900) {
  await d.wait(ms);
  const c = await readClock(B.page);
  return { c, f: await d.focusNow(), r: await rest(), kb: await padKb() };
}
const line = (tag, s, extra = '') => console.log(
  `  ${tag.padEnd(30)} ring ${(s.f.label + '/' + s.f.where).padEnd(24)} sign ${s.r?.signed ? 'Y' : 'n'} moved ${s.r?.moved ? 'Y' : 'n'} land ${s.r?.landed ? 'Y' : 'n'} att ${String(s.r?.attempts).padStart(2)}  drv ${s.kb.driving ? 'Y' : 'n'} takesSpace ${s.kb.padTakesSpace ? 'Y' : 'n'} ${extra}`);

console.log('\n──── 1. A TAB THAT LANDS OUTSIDE THE CLOSING PANEL, ON A LIVE ELEMENT ────');
/* two Shift-Tabs: the first goes to the panel title (dying), the
   second out of the panel entirely and onto the live HUD. */
for (const stall of [9, 0]) {
  let reverted = 0, n = 0, landedOutside = 0;
  let sample = null;
  for (let i = 0; i < 5; i++) {
    await upToTheLift(stall);
    await d.wait(8);
    await d.key('Tab', 12, d.SHIFT); await d.wait(14); await d.key('Tab', 12, d.SHIFT);
    const mid = await d.focusNow();
    const s = await settle(900); n++;
    if (mid.where !== 'panel' && mid.where !== 'DYING' && mid.where !== 'body') landedOutside++;
    if (mid.label && s.f.label !== mid.label) reverted++;
    if (i === 0) { sample = { mid, s }; line(`stall ${stall} #1  (was on ${mid.label}/${mid.where})`, s); }
  }
  console.log(`  stall ${stall}: the 2nd Shift-Tab left the panel ${landedOutside}/${n};  the hand-back then moved the ring off it ${reverted}/${n}`);
  if (stall === 9) console.log('  ledger:\n           ' + fmt(sample.s.c));
}

console.log('\n──── 2. A FOCUS THAT IS NEITHER THE PLAYER NOR THE HAND-BACK ────');
/* the screen-reader rotor (PAD-7): a bare programmatic focus, no DOM
   input event of any kind. SCRIPT focus, and that is the case. */
for (const target of ['hud', 'pad']) {
  let n = 0, unsigned = 0, yanked = 0, drvCleared = 0;
  for (let i = 0; i < 4; i++) {
    await upToTheLift(9);
    await d.wait(10);
    const put = await B.page.evaluate((t) => {
      const el = t === 'pad'
        ? [...document.querySelectorAll('.w-touch .w-abtn')].find(e => e.getAttribute('aria-label') === 'Jump')
        : [...document.querySelectorAll('button,[tabindex]')].find(e => !e.closest('.w-touch') && !e.closest('.w-pause,.w-sheet,.w-phone') && e.getClientRects().length);
      if (!el) return null;
      el.focus();                                   // ROTOR: no input event exists for this
      return el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 16);
    }, target);
    const s = await settle(900); n++;
    if (!s.r?.signed) unsigned++;
    if (put && s.f.label !== put) yanked++;
    if (s.kb.driving === false) drvCleared++;
    if (i === 0) line(`rotor -> ${target} (${put})`, s);
  }
  console.log(`  rotor onto the ${target}: hand-back went unsigned ${unsigned}/${n}, ring yanked off the rotor's target ${yanked}/${n}, driving cleared ${drvCleared}/${n}`);
}

console.log('\n──── 3. A SECOND SHEET OPENED INSIDE THE FIRST\'S HAND-BACK WINDOW ────');
/* pushSheet() itself calls handBack(). Two hand-backs in flight is a
   focus mover the residual does not enumerate. Real thumbs only. */
for (const stall of [9, 0]) {
  let n = 0, unsigned = 0, stolen = 0, drvCleared = 0;
  for (let i = 0; i < 5; i++) {
    await upToTheLift(stall);
    await d.wait(stall ? 40 : 10);
    const opened = await d.thumb('Phone', 60, 500);   // a second real thumb press
    const s = await settle(700); n++;
    const panels = await nPan();
    if (!s.r?.signed) unsigned++;
    if (s.f.where === 'pad' && panels > 0) stolen++;
    if (s.kb.driving === false) drvCleared++;
    if (i === 0) line(`stall ${stall} thumb Phone (+${stall ? 40 : 10}ms)`, s, `panels ${panels} openedPad=${opened}`);
  }
  console.log(`  stall ${stall}: close hand-back went unsigned ${unsigned}/${n};  focus ended on the PAD while a sheet is open ${stolen}/${n};  driving cleared ${drvCleared}/${n}`);
}

console.log('\n──── 4. THE RETRY, ATTEMPT BY ATTEMPT ────');
/* the Tab lands between attempts; sweep which attempt it lands before */
for (const stall of [0, 1, 2, 3, 5, 9, 14]) {
  await upToTheLift(stall);
  await d.wait(30);
  await d.key('Tab', 15);
  const s = await settle(900);
  line(`stall ${stall} (Tab at +30ms)`, s);
}

console.log('\n──── 5. DOES THE HAND-BACK EVER GIVE UP AND LEAVE FOCUS NOWHERE? ────');
{
  /* the shipping arm never returns early — only the rejected 'all'
     does. But the retry can still expire. Kill the target mid-window. */
  await setStall(9);
  await d.reset(); await d.wait(200);
  await d.tabTo('Menu'); await d.thumb('Jump', 70, 250); await d.thumb('Menu', 70, 430);
  const res = await d.btnIn('resume');
  await readClock(B.page);
  await d.touch('touchStart', res.x, res.y); await d.wait(70);
  await d.touch('touchEnd', res.x, res.y);
  await d.wait(20);
  const killed = await B.page.evaluate(() => {          // the pad is torn down mid-window
    WALLY.ctx.ui.setTouch(false); return true; });
  const s = await settle(1200);
  line('pad turned off inside the window', s, `killed=${killed}`);
  await B.page.evaluate(() => WALLY.ctx.ui.setTouch(true)); await d.wait(400);
  ok(s.f.where !== 'body' || s.r?.landed === false,
    'if the hand-back cannot land it says so (landed=false) rather than claiming a landing it never made',
    JSON.stringify(s.r));
}
await setStall(0);
console.log(`\n${fails} BROKEN of ${N} asserted`);
console.log('errs:', JSON.stringify(B.errs));
console.log('LOAD at end:', load());
await B.close();
