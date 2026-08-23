/* ROUND SEVEN, PROBE 3 — THE HEADLINE, plus fade-with-focus and
   sheet-with-focus, with hideUI driven through WALLY.debug.hideUI(). */
import { boot, boxes, padProbe2 } from '../_gb7/lib.mjs';
import { who, tabTo, tabOrder, peakVy, closeAll, PAD_LABELS } from './lib9.mjs';

const t = await boot();
const { page, ok, press } = t;
await padProbe2(page);
const b = await boxes(page);

/* ============ THE HEADLINE ============
   Tab to a pad button, touch the pad, then press Space / Enter.
   The GAME's verbs must win. Jump is measured by peak vy, never by a
   handler count. */
const TOUCHES = [
  ['stick', b.stick.x, b.stick.y],
  ['jump', b.jump.x, b.jump.y],
  ['shortcut(Phone)', b.sc[0].x, b.sc[0].y],
  ['canvas', 195, 300],
];

for (const [tname, tx, ty] of TOUCHES) {
  for (const L of PAD_LABELS) {
    await closeAll(page);
    await page.waitForTimeout(150);
    const n = await tabTo(page, L);
    if (n < 0) { ok(false, `HEAD-setup could not Tab to ${L}`); continue; }
    /* the touch that says "I am on my thumbs" */
    await press(tx, ty, 80);
    await page.waitForTimeout(220);
    await closeAll(page);          // a shortcut tap opens a sheet; shut it
    await page.waitForTimeout(150);
    const k = await who(page);

    /* SPACE -> the game must jump, and no pad sheet may open */
    const p0 = await page.evaluate(() => WALLY.ctx.ui.panels.slice());
    const pv = peakVy(page, 900);
    await page.keyboard.press('Space');
    const r = await pv;
    const p1 = await page.evaluate(() => WALLY.ctx.ui.panels.slice());
    const gained = p1.filter(x => !p0.includes(x));
    const jumped = r.peak > 1.0;
    ok(gained.length === 0,
      `HEAD-1 ${tname} then SPACE with "${L}" focused opens no pad sheet`,
      `gained=${JSON.stringify(gained)} driving=${k.driving} padFocused=${k.padFocused} takesSpace=${k.padTakesSpace}`);
    ok(jumped, `HEAD-2 ${tname} then SPACE with "${L}" focused JUMPS`,
      `peakVy=${r.peak} driving=${k.driving} padFocused=${k.padFocused}`);

    /* ENTER -> must not activate the tabbed-to button either */
    await closeAll(page);
    await page.waitForTimeout(150);
    const e0 = await page.evaluate(() => ({ p: WALLY.ctx.ui.panels.slice(), a: window.__pad.act, s: window.__pad.sc }));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    const e1 = await page.evaluate(() => ({ p: WALLY.ctx.ui.panels.slice(), a: window.__pad.act, s: window.__pad.sc }));
    const eg = e1.p.filter(x => !e0.p.includes(x));
    ok(e1.s === e0.s && eg.length === 0,
      `HEAD-3 ${tname} then ENTER with "${L}" focused does not fire the button`,
      `gained=${JSON.stringify(eg)} dsc=${e1.s - e0.s} dact=${e1.a - e0.a} driving=${(await who(page)).driving}`);
  }
}

/* ============ THE FADE, WITH FOCUS PARKED ON A PAD BUTTON ============ */
await closeAll(page);
await page.evaluate(() => WALLY.debug.hideUI(true));
await page.waitForTimeout(400);
const armed = await who(page);
console.log('HIDEUI ARMED', JSON.stringify(armed));
await tabTo(page, 'Menu');
console.log('PRE-FADE', JSON.stringify(await who(page)));
let faded = null;
for (let i = 0; i < 16; i++) {
  await page.waitForTimeout(1000);
  const w = await who(page);
  if (w.hidden) { faded = { s: i + 1, w }; break; }
}
console.log('FADE RESULT', JSON.stringify(faded));
ok(!!faded, 'FADE-1 the idle fade fires even with focus parked on Menu',
  faded ? `after ~${faded.s}s` : JSON.stringify(await who(page)));
if (faded) {
  const w = faded.w;
  const style = await page.evaluate(() => {
    const e = [...document.querySelectorAll('.w-touch button')]
      .find(x => x.getAttribute('aria-label') === 'Menu');
    return { vis: getComputedStyle(e).visibility, op: getComputedStyle(e).opacity };
  });
  console.log('FADED MENU STYLE', JSON.stringify(style), 'focus now', w.focus, 'isBody', w.isBody);
  ok(w.isBody === true || w.focus === null,
    'FADE-2 [EXPECTED BY DESIGN] visibility:hidden drops the focus to <body>',
    `focus=${w.focus} isBody=${w.isBody} — the documented bounded cost`);
  const resume = await tabOrder(page, 3, 'Tab');
  console.log('TAB RESUMES AT', JSON.stringify(resume));
  /* Space while faded: nothing may fire */
  const f0 = await page.evaluate(() => WALLY.ctx.ui.panels.slice());
  await page.keyboard.press('Space');
  await page.waitForTimeout(450);
  const f1 = await page.evaluate(() => WALLY.ctx.ui.panels.slice());
  ok(JSON.stringify(f0) === JSON.stringify(f1),
    'FADE-3 Space while faded fires no pad button', `${JSON.stringify(f0)} -> ${JSON.stringify(f1)}`);
  /* wake it, and see whether a focus survives / can be re-established */
  await press(195, 300, 60);
  await page.waitForTimeout(1200);
  const wk = await who(page);
  console.log('AFTER WAKE', JSON.stringify(wk));
  const nb = await tabTo(page, 'Menu');
  ok(nb > 0, 'FADE-4 after the wake the player can Tab back to Menu', `tabs=${nb}`);
  const g0 = await page.evaluate(() => WALLY.ctx.ui.panels.slice());
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  const g1 = await page.evaluate(() => WALLY.ctx.ui.panels.slice());
  ok(g1.length > g0.length, 'FADE-5 ...and Space there works again',
    `${JSON.stringify(g0)} -> ${JSON.stringify(g1)}`);
}
await page.evaluate(() => WALLY.debug.hideUI(false));
await closeAll(page);

/* ============ FOCUS WHILE A SHEET IS OPEN, AND AFTER IT CLOSES ============ */
await page.waitForTimeout(400);
const nb2 = await tabTo(page, 'Menu');
const s0 = await who(page);
await page.keyboard.press('KeyP');          // phone, via the game's own key
await page.waitForTimeout(800);
const s1 = await who(page);
console.log('SHEET OPEN', JSON.stringify(s1));
await page.keyboard.press('Escape');
await page.waitForTimeout(800);
const s2 = await who(page);
console.log('SHEET CLOSED', JSON.stringify(s2));
ok(nb2 > 0, 'SHEET-0 tabbed to Menu first', `tabs=${nb2}`);
ok(s2.panels.length === 0, 'SHEET-1 Escape closed it', JSON.stringify(s2.panels));
console.log(`SHEET focus: before=${s0.focus} during=${s1.focus} after=${s2.focus}`);
/* after the sheet closes, does a Space still reach the right place? */
const h0 = await page.evaluate(() => WALLY.ctx.ui.panels.slice());
await page.keyboard.press('Space');
await page.waitForTimeout(500);
const h1 = await page.evaluate(() => WALLY.ctx.ui.panels.slice());
console.log('SPACE AFTER SHEET CLOSE', JSON.stringify(h0), '->', JSON.stringify(h1),
  JSON.stringify(await who(page)));

console.log('PAGEERRORS', JSON.stringify(t.errs));
console.log(`FAILS ${t.fails}`);
await t.close();
