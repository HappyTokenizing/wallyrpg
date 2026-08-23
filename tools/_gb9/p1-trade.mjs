/* ROUND SEVEN, PROBE 1 — THE TRADE THE FIX MAKES.
   Genuine Tab activation, tab order, SR-style incidental touch,
   focus under the fade, focus under a sheet, double/blur fire. */
import { boot, boxes, padProbe2, padRead, padState } from '../_gb7/lib.mjs';
import { who, tabTo, tabOrder, peakVy } from './lib9.mjs';

const t = await boot();
const { page, ok, cdp, press, tapOnce } = t;
await padProbe2(page);
const b = await boxes(page);
console.log('BOXES', JSON.stringify(b));
console.log('STATE0', JSON.stringify(await who(page)));

/* ---------- 1. what is focusable, and in what order ---------- */
const focusables = await page.evaluate(() => [...document.querySelectorAll(
  '.w-touch button, .w-touch [tabindex], .w-touch a[href]')].map(e => ({
    label: e.getAttribute('aria-label'), cls: e.className,
    ti: e.getAttribute('tabindex'), disabled: e.disabled ?? null,
    vis: getComputedStyle(e).visibility, op: getComputedStyle(e).opacity })));
console.log('PAD FOCUSABLES', JSON.stringify(focusables, null, 1));

await page.evaluate(() => document.activeElement?.blur?.());
const fwd = await tabOrder(page, 12, 'Tab');
console.log('TAB ORDER FWD', JSON.stringify(fwd));
const back = await tabOrder(page, 12, 'Shift+Tab');
console.log('TAB ORDER BACK', JSON.stringify(back));

const padFwd = fwd.filter(x => x !== '<body>');
const padBack = back.filter(x => x !== '<body>');
ok(padFwd.length >= 6, `TRADE-1 Tab reaches the pad buttons (${padFwd.length})`, JSON.stringify(padFwd));
/* reverse of the forward walk should be the backward walk, modulo where it turns round */
const revOk = JSON.stringify(padBack.slice(1)) === JSON.stringify(padFwd.slice(0, padBack.length - 1).reverse());
ok(revOk, 'TRADE-2 Shift-Tab retraces the forward order', `fwd=${JSON.stringify(padFwd)} back=${JSON.stringify(padBack)}`);

/* ---------- 2. a genuine Tab then Space / Enter must activate ---------- */
const labels = await page.evaluate(() => [...document.querySelectorAll('.w-touch button')]
  .map(e => e.getAttribute('aria-label')).filter(Boolean));
console.log('LABELS', JSON.stringify(labels));

for (const key of ['Space', 'Enter']) {
  for (const L of labels) {
    await page.evaluate(() => { window.__pad.act = 0; window.__pad.sc = 0; window.__pad.toasts = []; });
    await page.evaluate(() => { const u = WALLY.ctx.ui; u.panels.slice().forEach(() => u.back?.()); });
    await page.waitForTimeout(250);
    const n = await tabTo(page, L);
    const isJump = /jump/i.test(L);
    let fired;
    if (isJump) {
      const pv = peakVy(page, 850);
      await page.keyboard.press(key);
      fired = (await pv).peak;
      ok(n > 0 && fired > 1.0, `TRADE-3 Tab(${n}) to "${L}" then ${key} jumps`, `peakVy=${fired}`);
    } else {
      const before = await page.evaluate(() => ({ a: window.__pad.act, s: window.__pad.sc, p: WALLY.ctx.ui.panels.length }));
      await page.keyboard.press(key);
      await page.waitForTimeout(450);
      const after = await page.evaluate(() => ({ a: window.__pad.act, s: window.__pad.sc, p: WALLY.ctx.ui.panels.length }));
      fired = (after.a - before.a) + (after.s - before.s) + (after.p - before.p);
      ok(n > 0 && fired > 0, `TRADE-3 Tab(${n}) to "${L}" then ${key} activates`,
        `d(act,sc,panels)=${after.a - before.a},${after.s - before.s},${after.p - before.p}`);
    }
  }
}
await page.evaluate(() => { const u = WALLY.ctx.ui; u.panels.slice().forEach(() => u.back?.()); });
await page.waitForTimeout(300);

/* ---------- 3. incidental touch: where does focus land, can we get back ---------- */
const MENU = labels.find(l => /menu/i.test(l)) || labels[labels.length - 1];
for (const [name, x, y] of [
  ['canvas', 195, 300], ['stick', b.stick.x, b.stick.y],
  ['jump', b.jump.x, b.jump.y], ['shortcut0', b.sc[0].x, b.sc[0].y]]) {
  await tabTo(page, MENU);
  const pre = await who(page);
  await press(x, y, 70);
  await page.waitForTimeout(250);
  const post = await who(page);
  console.log(`INCIDENTAL ${name}: pre=${JSON.stringify(pre.focus)} post=${JSON.stringify(post.focus)} driving=${post.driving} isBody=${post.isBody}`);
  ok(post.focus !== null, `TRADE-4 ${name} touch keeps a focus somewhere (not <body>)`,
    `focus=${post.focus} isBody=${post.isBody}`);
  /* and can the player get back to where they were with one Tab? */
  await page.keyboard.press('Tab');
  const nxt = await page.evaluate(() => document.activeElement?.getAttribute?.('aria-label') || '<body>');
  console.log(`  after one Tab -> ${nxt}`);
}

/* ---------- 4. focus while the pad FADES, and when it wakes ---------- */
await page.evaluate(() => { WALLY.ctx.ui.hideUI = true; });
await tabTo(page, MENU);
const preFade = await who(page);
console.log('PRE-FADE', JSON.stringify(preFade));
await page.waitForTimeout(9000);              // let the idle clock run out
const inFade = await who(page);
const fadeVis = await page.evaluate(() => {
  const e = [...document.querySelectorAll('.w-touch button')].find(x => /menu/i.test(x.getAttribute('aria-label') || ''));
  return e ? { vis: getComputedStyle(e).visibility, op: getComputedStyle(e).opacity } : null; });
console.log('IN-FADE', JSON.stringify(inFade), 'menuStyle', JSON.stringify(fadeVis));
ok(inFade.hidden === true, 'TRADE-5 the idle fade actually fired', JSON.stringify(inFade));
ok(!inFade.isBody, 'TRADE-6 the fade did NOT dump a tabbed-to focus to <body>',
  `focus=${inFade.focus} isBody=${inFade.isBody}`);
/* where does Tab resume from now? */
const resume = await tabOrder(page, 4, 'Tab');
console.log('TAB AFTER FADE', JSON.stringify(resume));

/* wake it and look again */
await tapOnce(195, 300, 60); await page.waitForTimeout(900);
console.log('AFTER WAKE', JSON.stringify(await who(page)));

/* ---------- 5. focus while a sheet is open, and after it closes ---------- */
await page.evaluate(() => { WALLY.ctx.ui.hideUI = false; });
await page.waitForTimeout(600);
await tabTo(page, MENU);
const preSheet = await who(page);
await page.keyboard.press('KeyP');
await page.waitForTimeout(700);
const inSheet = await who(page);
console.log('SHEET pre', JSON.stringify(preSheet.focus), 'in', JSON.stringify(inSheet));
await page.keyboard.press('Escape');
await page.waitForTimeout(700);
const postSheet = await who(page);
console.log('SHEET after close', JSON.stringify(postSheet));
ok(!postSheet.isBody || preSheet.isBody,
  'TRADE-7 closing a sheet does not strand focus on <body>', JSON.stringify(postSheet));

/* ---------- 6. does anything fire twice, or fire on a blur? ---------- */
await page.evaluate(() => { window.__pad.act = 0; window.__pad.sc = 0; });
const PHONE = labels.find(l => /phone/i.test(l)) || labels[0];
await tabTo(page, PHONE);
const c0 = await page.evaluate(() => ({ a: window.__pad.act, s: window.__pad.sc }));
await page.keyboard.press('Space');
await page.waitForTimeout(600);
const c1 = await page.evaluate(() => ({ a: window.__pad.act, s: window.__pad.sc }));
ok((c1.s - c0.s) <= 1 && (c1.a - c0.a) <= 1,
  'TRADE-8 one genuine Space fires the verb exactly once',
  `dact=${c1.a - c0.a} dsc=${c1.s - c0.s}`);
await page.evaluate(() => { const u = WALLY.ctx.ui; u.panels.slice().forEach(() => u.back?.()); });
await page.waitForTimeout(400);

/* blur-fire: focus a button, then move focus away, and see if anything ran */
await tabTo(page, PHONE);
const d0 = await page.evaluate(() => ({ a: window.__pad.act, s: window.__pad.sc, p: WALLY.ctx.ui.panels.length }));
await page.evaluate(() => document.activeElement?.blur?.());
await page.waitForTimeout(400);
const d1 = await page.evaluate(() => ({ a: window.__pad.act, s: window.__pad.sc, p: WALLY.ctx.ui.panels.length }));
ok(d1.a === d0.a && d1.s === d0.s && d1.p === d0.p,
  'TRADE-9 nothing fires on a blur', `${JSON.stringify(d0)} -> ${JSON.stringify(d1)}`);

console.log('PAGEERRORS', JSON.stringify(t.errs));
console.log(`FAILS ${t.fails}`);
await t.close();
