/* ROUND SEVEN, PROBE 4 — the headline done HONESTLY.
   p3's teardown called blur(), so padFocused was false in every row and
   HEAD-1/HEAD-3 asserted nothing. Here focus is established BEFORE the
   touch and never touched again until the key is pressed. Sheets are
   shut with ui.closeAll() only — no blur — and every row reports
   padFocused at the instant of the keypress so a vacuous row is visible. */
import { boot, boxes, padProbe2 } from '../_gb7/lib.mjs';
import { who, tabTo, peakVy, PAD_LABELS } from './lib9.mjs';

const t = await boot();
const { page, ok, press } = t;
await padProbe2(page);
const b = await boxes(page);

const shut = async () => { await page.evaluate(() => WALLY.ctx.ui.closeAll()); await page.waitForTimeout(250); };
/** wait until he is actually standing still on the ground */
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

/* ---------- CONTROL: does a bare Space jump at all, repeatedly? ---------- */
await shut();
await page.evaluate(() => document.activeElement?.blur?.());
const ctrl = [];
for (let i = 0; i < 6; i++) {
  await grounded(page);
  const pv = peakVy(page, 850);
  await page.keyboard.press('Space');
  ctrl.push((await pv).peak);
}
console.log('CONTROL bare Space peaks', JSON.stringify(ctrl));
ok(ctrl.filter(x => x > 1).length >= 5,
  'CTRL-1 a bare Space jumps repeatably (the measurement is trustworthy)', JSON.stringify(ctrl));

/* ---------- THE HEADLINE ---------- */
const TOUCHES = [
  ['stick', b.stick.x, b.stick.y],
  ['jump', b.jump.x, b.jump.y],
  ['shortcut(Phone)', b.sc[0].x, b.sc[0].y],
  ['canvas', 195, 300],
];
for (const [tname, tx, ty] of TOUCHES) {
  for (const L of PAD_LABELS) {
    await shut();
    await grounded(page);
    const n = await tabTo(page, L);                 // focus FIRST
    if (n < 0) { ok(false, `HEAD-setup Tab to ${L} failed under ${tname}`); continue; }
    await press(tx, ty, 80);                        // the thumbs speak
    await page.waitForTimeout(200);
    await shut();                                   // no blur in here
    await grounded(page);
    const k = await who(page);                      // state AT the keypress
    const p0 = await page.evaluate(() => WALLY.ctx.ui.panels.slice());
    const pv = peakVy(page, 900);
    await page.keyboard.press('Space');
    const r = await pv;
    const p1 = await page.evaluate(() => WALLY.ctx.ui.panels.slice());
    const gained = p1.filter(x => !p0.includes(x));
    const vac = !k.padFocused ? ' [VACUOUS: focus already off the pad]' : '';
    ok(gained.length === 0 && r.peak > 1.0,
      `HEAD ${tname} + "${L}" + SPACE -> game wins${vac}`,
      `peakVy=${r.peak} gained=${JSON.stringify(gained)} padFocused=${k.padFocused} driving=${k.driving} takesSpace=${k.padTakesSpace}`);
  }
}

/* ---------- THE FADE: time-resolved, and never tabbed into ----------
   A Tab during the faded window fires focusin, which resets idleT and
   un-fades the pad — so p3's "Space while faded" measured a woken pad.
   Here focus is placed before the fade and nothing touches it after. */
await shut();
await page.evaluate(() => WALLY.debug.hideUI(true));
await page.waitForTimeout(400);
await tabTo(page, 'Menu');
console.log('PRE-FADE', JSON.stringify(await who(page)));
let hitAt = null;
for (let i = 0; i < 16; i++) {
  await page.waitForTimeout(250);
  const h = await page.evaluate(() => WALLY.debug.idle().hidden);
  if (h) { hitAt = i * 250; break; }
}
console.log('HIDDEN FIRST SEEN AT ~', hitAt, 'ms');
const sample = async (tag) => {
  const s = await page.evaluate(() => {
    const e = [...document.querySelectorAll('.w-touch button')]
      .find(x => x.getAttribute('aria-label') === 'Menu');
    const acts = document.querySelector('.w-acts');
    const a = document.activeElement;
    const i = WALLY.debug.idle();
    return {
      btnVis: getComputedStyle(e).visibility, btnOp: getComputedStyle(e).opacity,
      actsVis: getComputedStyle(acts).visibility, actsOp: getComputedStyle(acts).opacity,
      focus: a && a !== document.body ? (a.getAttribute?.('aria-label') || a.className) : null,
      isBody: a === document.body,
      hidden: i.hidden, live: i.live, t: i.t,
    };
  });
  console.log(`  FADE@${tag}`, JSON.stringify(s));
  return s;
};
const s0 = await sample('t+0');
await page.waitForTimeout(500); const s500 = await sample('t+500');
await page.waitForTimeout(1000); const s1500 = await sample('t+1500');
await page.waitForTimeout(2000); const s3500 = await sample('t+3500');

ok(s3500.actsVis === 'hidden',
  'FADE-A the faded cluster really does end up visibility:hidden', JSON.stringify(s3500));
ok(s3500.isBody === true,
  'FADE-B ...and that takes the tabbed-to focus off the button (to <body>)',
  `focus=${s3500.focus} isBody=${s3500.isBody}`);

/* Now: with the pad settled-faded and focus wherever it landed, does a
   Space fire a pad button? Read `hidden` immediately either side. */
const g0 = await page.evaluate(() => ({ p: WALLY.ctx.ui.panels.slice(), h: WALLY.debug.idle().hidden,
  f: document.activeElement === document.body ? null : document.activeElement?.getAttribute?.('aria-label') }));
await page.keyboard.press('Space');
await page.waitForTimeout(500);
const g1 = await page.evaluate(() => ({ p: WALLY.ctx.ui.panels.slice(), h: WALLY.debug.idle().hidden }));
console.log('SPACE WHILE SETTLED-FADED', JSON.stringify(g0), '->', JSON.stringify(g1));
ok(JSON.stringify(g0.p) === JSON.stringify(g1.p),
  'FADE-C a Space while the pad is faded fires no pad button',
  `${JSON.stringify(g0)} -> ${JSON.stringify(g1)}`);

console.log('PAGEERRORS', JSON.stringify(t.errs));
console.log(`FAILS ${t.fails}`);
await t.close();
