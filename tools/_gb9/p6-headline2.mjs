/* ROUND SEVEN, PROBE 6 — THE HEADLINE, measured correctly.
   Fixes both rig faults found in p3/p4:
     - focus is established BEFORE the touch and never blurred by the rig
     - Space/Enter are HELD 150 ms, because wally.js reads jump as a
       level (`o.jump = !!keys.Space`) and a sub-frame press is invisible
       (p5: hold 0 -> 1/5 jumps, hold 40 ms -> 5/5)
   Every row prints padFocused at the instant of the keypress, so a
   vacuous row cannot be mistaken for a pass. */
import { boot, boxes, padProbe2 } from '../_gb7/lib.mjs';
import { who, tabTo, peakVy, PAD_LABELS } from './lib9.mjs';

const t = await boot();
const { page, ok, press } = t;
await padProbe2(page);
const b = await boxes(page);

const shut = async () => { await page.evaluate(() => WALLY.ctx.ui.closeAll()); await page.waitForTimeout(250); };
const holdKey = async (k, ms = 150) => {
  await page.keyboard.down(k); await page.waitForTimeout(ms); await page.keyboard.up(k);
};
async function grounded(page, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await page.evaluate(() => {
      const c = WALLY.ctx.wally?.controller; const v = c && (c.velocity || c.vel);
      return v ? Math.abs(v.y) : null;
    });
    if (v !== null && v < 0.08) return true;
    await page.waitForTimeout(120);
  }
  return false;
}

/* CONTROL, with the corrected hold */
await shut(); await page.evaluate(() => document.activeElement?.blur?.());
const ctrl = [];
for (let i = 0; i < 5; i++) {
  await grounded(page);
  const pv = peakVy(page, 900); await holdKey('Space'); ctrl.push((await pv).peak);
}
ok(ctrl.filter(x => x > 1).length >= 4, 'CTRL bare held Space jumps', JSON.stringify(ctrl));

/* `act` (Enter or talk) is the bindPress representative that does NOT
   open a sheet, so focus survives it and the row stays meaningful.
   A real shortcut opens its panel and moves focus into it — that row is
   reported but flagged, because the probe cannot discriminate there. */
const TOUCHES = [
  ['stick', b.stick.x, b.stick.y],
  ['jump', b.jump.x, b.jump.y],
  ['act(bindPress)', b.act.x, b.act.y],
  ['shortcut(Phone)', b.sc[0].x, b.sc[0].y],
  ['canvas', 195, 300],
];

for (const [tname, tx, ty] of TOUCHES) {
  for (const L of PAD_LABELS) {
    /* ---- SPACE ---- */
    await shut(); await grounded(page);
    const n = await tabTo(page, L);
    if (n < 0) { ok(false, `setup: Tab to ${L} failed (${tname})`); continue; }
    await press(tx, ty, 80);
    await page.waitForTimeout(200);
    await page.evaluate(() => WALLY.ctx.ui.closeAll());   // no blur
    await page.waitForTimeout(200);
    await grounded(page);
    const k = await who(page);
    const p0 = await page.evaluate(() => WALLY.ctx.ui.panels.slice());
    const pv = peakVy(page, 900);
    await holdKey('Space');
    const r = await pv;
    const p1 = await page.evaluate(() => WALLY.ctx.ui.panels.slice());
    const gained = p1.filter(x => !p0.includes(x));
    const tag = k.padFocused ? '' : ' [VACUOUS: focus left the pad]';
    ok(gained.length === 0 && r.peak > 1.0,
      `HEAD ${tname} + "${L}" + SPACE -> game wins${tag}`,
      `peakVy=${r.peak} gained=${JSON.stringify(gained)} padFocused=${k.padFocused} driving=${k.driving} takesSpace=${k.padTakesSpace}`);

    /* ---- ENTER ---- */
    await shut(); await grounded(page);
    const n2 = await tabTo(page, L);
    if (n2 < 0) continue;
    await press(tx, ty, 80);
    await page.waitForTimeout(200);
    await page.evaluate(() => WALLY.ctx.ui.closeAll());
    await page.waitForTimeout(200);
    const k2 = await who(page);
    const e0 = await page.evaluate(() => ({ p: WALLY.ctx.ui.panels.slice(), s: window.__pad.sc, a: window.__pad.act }));
    await holdKey('Enter');
    await page.waitForTimeout(450);
    const e1 = await page.evaluate(() => ({ p: WALLY.ctx.ui.panels.slice(), s: window.__pad.sc, a: window.__pad.act }));
    const eg = e1.p.filter(x => !e0.p.includes(x));
    const tag2 = k2.padFocused ? '' : ' [VACUOUS: focus left the pad]';
    ok(eg.length === 0 && e1.s === e0.s,
      `HEAD ${tname} + "${L}" + ENTER -> button refused${tag2}`,
      `gained=${JSON.stringify(eg)} dsc=${e1.s - e0.s} dact=${e1.a - e0.a} padFocused=${k2.padFocused} driving=${k2.driving}`);
  }
}

console.log('PAGEERRORS', JSON.stringify(t.errs));
console.log(`FAILS ${t.fails}`);
await t.close();
