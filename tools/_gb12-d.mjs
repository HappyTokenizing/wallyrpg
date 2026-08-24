/* _gb12-d.mjs — REACHABILITY, AND THE TWO LANDINGS.
   A single Shift-Tab lands on a LIVE PAD BUTTON (the pad sits before
   the panels in the DOM); a single Tab lands INSIDE the dying panel.
   Both at shipping timing, offsets round-robined so machine drift
   cannot settle on one of them, with the true delta between the key
   and the hand-back's own focus measured per gesture. */
import { boot, driver, load, cpus, clock, readClock, mark, fmt } from './_gb12-lib.mjs';

console.log('LOAD at boot:', load(), `(${cpus()} cpus)`);
const B = await boot(); const d = driver(B.page, B.cdp);
await clock(B.page);
const padKb = () => B.page.evaluate(() => WALLY.debug.padKeyboard());
const setStall = (n) => B.page.evaluate((k) => WALLY.debug.padHandBackStall(k), n);

async function gesture({ offset, shift, stall = 0 }) {
  await setStall(stall);
  await d.reset(); await d.wait(200);
  if (!await d.tabTo('Menu')) return { err: 'no Menu' };
  await d.thumb('Jump', 70, 250);
  await d.thumb('Menu', 70, 420);
  const res = await d.btnIn('resume'); if (!res) return { err: 'no Resume' };
  await readClock(B.page);
  await d.touch('touchStart', res.x, res.y); await d.wait(70);
  await d.touch('touchEnd', res.x, res.y);
  if (offset > 0) await d.wait(offset);
  await d.key('Tab', 15, shift ? d.SHIFT : 0);
  await d.wait(800);
  const c = await readClock(B.page);
  const f = await d.focusNow(); const kb = await padKb();
  const ki = c.findIndex(e => e.ev === 'keydown' && e.key === 'Tab');
  const ins = c.filter(e => e.ev === 'focusin');
  const tabLand = c.slice(ki + 1).find(e => e.ev === 'focusin');
  const hb = [...ins].reverse().find(e => e.where === 'pad' && (!tabLand || e.t > tabLand.t) && e.el === 'Menu');
  const te = c.find(e => e.ev === 'touchend');
  return { f, kb, c,
    keyT: ki >= 0 ? c[ki].t : null, teT: te ? te.t : null,
    landedOn: tabLand ? `${tabLand.el}/${tabLand.where}` : null,
    reverted: !!(tabLand && hb && hb.t > tabLand.t),
    afterLift: (ki >= 0 && te) ? +(c[ki].t - te.t).toFixed(1) : null };
}

for (const [name, shift] of [['SHIFT-TAB (lands outside, on the pad)', true], ['TAB (lands inside the dying panel)', false]]) {
  console.log(`\n──── ${name} — SHIPPING WINDOW (stall 0) ────`);
  const OFF = [0, 4, 8, 12, 16, 22, 30];
  const tal = {}; for (const o of OFF) tal[o] = { n: 0, live: 0, dying: 0, rev: 0, deaf: 0, deltas: [] };
  for (let r = 0; r < 5; r++) for (const o of OFF) {           // round-robin
    const x = await gesture({ offset: o, shift });
    if (x.err) continue;
    const T = tal[o]; T.n++;
    if (x.afterLift != null) T.deltas.push(x.afterLift);
    if (x.landedOn?.endsWith('/pad')) T.live++;
    if (x.landedOn?.endsWith('/DYING')) T.dying++;
    if (x.reverted) T.rev++;
    if (x.f.where === 'pad' && x.kb.padTakesSpace === false) T.deaf++;
  }
  console.log('  offset  n   key landed after the lift    tab landed on a LIVE pad button   ...on the dying panel   the hand-back then reverted it   DEAF');
  for (const o of OFF) {
    const T = tal[o]; const ds = T.deltas.sort((a, b) => a - b);
    const med = ds.length ? ds[ds.length >> 1] : null;
    console.log(`  +${String(o).padEnd(4)}  ${String(T.n).padStart(2)}   median ${String(med).padStart(6)}ms (${ds[0]}..${ds[ds.length - 1]})` +
      `      ${String(T.live).padStart(2)}/${T.n}                          ${String(T.dying).padStart(2)}/${T.n}                 ${String(T.rev).padStart(2)}/${T.n}                   ${T.deaf}/${T.n}`);
  }
  console.log('  LOAD now:', load());
}

console.log('\n──── ONE REVERTED GESTURE, IN FULL ────');
{
  for (let i = 0; i < 6; i++) {
    const x = await gesture({ offset: 0, shift: true });
    if (x.reverted) { console.log('           ' + fmt(x.c)); console.log('  kb:', JSON.stringify(x.kb)); break; }
    if (i === 5) console.log('  (no reverted gesture in 6 tries at +0ms — see the rates above)');
  }
}

console.log('\n──── IS A FADED PAD BUTTON "focusable()" TO THE HAND-BACK? ────');
{
  /* focusable() = isConnected && !disabled && getClientRects().length.
     visibility:hidden keeps the rects and loses the focus. If both are
     true, the hand-back records a landing it did not make AND leaves
     its signature armed for 50 ms with nothing to consume it. */
  const r = await B.page.evaluate(() => {
    const b = [...document.querySelectorAll('.w-touch .w-abtn')].find(e => e.getAttribute('aria-label') === 'Menu');
    if (!b) return { err: 'no Menu button' };
    const before = { rects: b.getClientRects().length, vis: getComputedStyle(b).visibility };
    const cluster = b.closest('.w-acts') || b.parentElement;
    const prev = cluster.style.visibility;
    cluster.style.visibility = 'hidden';
    const faded = { rects: b.getClientRects().length, vis: getComputedStyle(b).visibility };
    document.body.focus?.(); b.focus({ preventScroll: true });
    const took = document.activeElement === b;
    /* what the hand-back's own predicate would say */
    const wouldTry = !!b && b.isConnected && !b.disabled && typeof b.focus === 'function' && b.getClientRects().length > 0;
    cluster.style.visibility = prev;
    return { before, faded, took, wouldTry };
  });
  console.log('  ', JSON.stringify(r));
  console.log(`  => focusable() says "try it": ${r.wouldTry}; focus() actually took: ${r.took}`);
}
await setStall(0);
console.log('\nerrs:', JSON.stringify(B.errs));
console.log('LOAD at end:', load());
await B.close();
