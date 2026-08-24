/* _gb12-b.mjs — WHERE DOES THE TAB LAND, AND WHERE DOES THE RING END?
   Three arms on ONE page at ONE load, alternating, so the rate means
   something. Plus the branch check the whole round hangs on: with the
   yield disabled ('none') my rig must still be able to produce DEAF,
   or "0 DEAF" is a blind probe and not a result. */
import { boot, driver, load, cpus, clock, readClock, mark, fmt } from './_gb12-lib.mjs';

console.log('LOAD at boot:', load(), `(${cpus()} cpus)`);
const B = await boot();
const d = driver(B.page, B.cdp);
await clock(B.page);
const padKb = () => B.page.evaluate(() => WALLY.debug.padKeyboard());
const rest  = () => B.page.evaluate(() => WALLY.debug.focusRestore());
const nPan  = () => B.page.evaluate(() => WALLY.ctx.ui.panels.length);
const setStall = (n) => B.page.evaluate((k) => WALLY.debug.padHandBackStall(k), n);
const setMode  = (m) => B.page.evaluate((k) => WALLY.debug.padHandBackYield(k), m);

async function trial({ offset = 0, stall = 0, mode = 'sign', shift = false }) {
  await setMode(mode); await setStall(stall);
  await d.reset(); await d.wait(200);
  const t = await d.tabTo('Menu'); if (!t) return { err: 'no Menu by Tab' };
  await d.thumb('Jump', 70, 260);
  await d.thumb('Menu', 70, 420);
  if (await nPan() < 1) return { err: 'sheet did not open' };
  const res = await d.btnIn('resume|close|back|done'); if (!res) return { err: 'no close btn' };
  await readClock(B.page);
  await d.touch('touchStart', res.x, res.y); await d.wait(70);
  await mark(B.page, 'LIFT');
  await d.touch('touchEnd', res.x, res.y);
  if (offset > 0) await d.wait(offset);
  await d.key('Tab', 20, shift ? d.SHIFT : 0);
  await d.wait(900);
  const c = await readClock(B.page);
  const f = await d.focusNow(); const r = await rest(); const kb = await padKb();
  const before = await nPan();
  await d.key('Space', 25); await d.wait(420);
  const fired = (await nPan()) > before;
  /* WHERE THE TAB LANDED, from the record: the first focusin strictly
     after the Tab keydown. And what held the ring just before it. */
  const ki = c.findIndex(e => e.ev === 'keydown' && e.key === 'Tab');
  const landings = c.slice(ki + 1).filter(e => e.ev === 'focusin');
  const beforeTab = c.slice(0, ki).filter(e => e.ev === 'focusin').pop();
  return { mode, f, r, kb, fired, clock: c,
    tabLanded: landings[0] ? `${landings[0].el}/${landings[0].where}` : 'nothing moved',
    afterTab: landings.map(x => `${x.el}/${x.where}@${x.t}`).join(' -> '),
    ringBefore: beforeTab ? `${beforeTab.el}/${beforeTab.where}` : '(none)' };
}

const row = (tag, x) => {
  if (x.err) { console.log(`  ${tag.padEnd(20)} ERROR ${x.err}`); return; }
  const deaf = x.f.where === 'pad' && x.kb.padTakesSpace === false;
  const back = x.tabLanded !== 'nothing moved' && x.f.label === x.ringBefore.split('/')[0];
  console.log(`  ${tag.padEnd(20)} tab landed ${x.tabLanded.padEnd(22)} ring ended ${(x.f.label + '/' + x.f.where).padEnd(20)}` +
    ` sign ${x.r?.signed ? 'Y' : 'n'} moved ${x.r?.moved ? 'Y' : 'n'} yielded ${x.r?.yielded ? 'Y' : 'n'}` +
    ` drv ${x.kb.driving ? 'Y' : 'n'} space ${x.fired ? 'BUTTON' : 'game  '}` +
    ` ${deaf ? '<<DEAF' : ''}${back ? ' <<RING WENT BACK' : ''}`);
};

console.log('\n──── THREE ARMS, WINDOW HELD OPEN (stall 9), TAB AT +8ms, ALTERNATING ────');
const tally = { sign: { deaf: 0, back: 0, body: 0, n: 0 }, none: { deaf: 0, back: 0, body: 0, n: 0 }, all: { deaf: 0, back: 0, body: 0, n: 0 } };
for (let i = 0; i < 6; i++) {
  for (const mode of ['sign', 'none', 'all']) {
    const x = await trial({ offset: 8, stall: 9, mode });
    if (x.err) { console.log('  ERR', x.err); continue; }
    const T = tally[mode]; T.n++;
    if (x.f.where === 'pad' && x.kb.padTakesSpace === false) T.deaf++;
    if (x.f.where === 'body') T.body++;
    if (x.tabLanded !== 'nothing moved' && x.f.label === x.ringBefore.split('/')[0]) T.back++;
    if (i === 0) row(`${mode} #${i + 1}`, x);
  }
}
console.log('  ---- rates, one page, one load, alternating arms ----');
for (const m of ['sign', 'none', 'all']) {
  const T = tally[m];
  console.log(`  ${m.padEnd(5)}  DEAF ${T.deaf}/${T.n}   ring put back where it started ${T.back}/${T.n}   keyboard left on <body> ${T.body}/${T.n}`);
}
console.log('  LOAD now:', load());

console.log('\n──── ONE LEDGER, IN FULL, FOR EACH ARM (stall 9, +8ms) ────');
for (const mode of ['sign', 'none', 'all']) {
  const x = await trial({ offset: 8, stall: 9, mode });
  console.log(`  --- ${mode} ---   tab landed ${x.tabLanded}   after: ${x.afterTab}`);
  console.log('           ' + fmt(x.clock));
  console.log('           rec ' + JSON.stringify(x.r) + '  kb ' + JSON.stringify(x.kb));
}

console.log('\n──── SHIPPING WINDOW (stall 0): DOES A REAL TAB EVER LAND INSIDE IT? ────');
{
  let inside = 0, n = 0, deaf = 0, back = 0;
  for (let i = 0; i < 12; i++) {
    const x = await trial({ offset: 0, stall: 0, mode: 'sign' });
    if (x.err) continue; n++;
    if (x.r?.moved) inside++;
    if (x.f.where === 'pad' && x.kb.padTakesSpace === false) deaf++;
    if (x.tabLanded !== 'nothing moved' && x.f.label === x.ringBefore.split('/')[0]) back++;
  }
  console.log(`  Tab at +0ms, shipping stall: landed inside the window ${inside}/${n},  DEAF ${deaf}/${n},  ring put back ${back}/${n}`);
}
await setStall(0); await setMode('sign');
console.log('\nerrs:', JSON.stringify(B.errs));
console.log('LOAD at end:', load());
await B.close();
