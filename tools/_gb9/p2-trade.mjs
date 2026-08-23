/* ROUND SEVEN, PROBE 2 — THE TRADE, with the rig bugs from p1 fixed:
   panels are shut via Escape and confirmed, and the routing flag is read
   from WALLY.debug.padKeyboard(). */
import { boot, boxes, padProbe2 } from '../_gb7/lib.mjs';
import { who, tabTo, tabOrder, peakVy, closeAll, padOnly, PAD_LABELS } from './lib9.mjs';

const t = await boot();
const { page, ok, press } = t;
await padProbe2(page);
const b = await boxes(page);
console.log('STATE0', JSON.stringify(await who(page)));

/* ---------- 1. tab order, pad buttons only ---------- */
await closeAll(page);
const fwd = padOnly(await tabOrder(page, 12, 'Tab'));
await page.evaluate(() => document.activeElement?.blur?.());
const back = padOnly(await tabOrder(page, 14, 'Shift+Tab'));
console.log('PAD FWD ', JSON.stringify(fwd));
console.log('PAD BACK', JSON.stringify(back));
ok(JSON.stringify(fwd) === JSON.stringify(PAD_LABELS),
  'TRADE-1 forward Tab visits all six pad buttons in DOM order', JSON.stringify(fwd));
ok(JSON.stringify(back) === JSON.stringify(PAD_LABELS.slice().reverse()),
  'TRADE-2 Shift-Tab retraces them exactly reversed', JSON.stringify(back));

/* ---------- 2. genuine Tab then Space / Enter on every button ---------- */
for (const key of ['Space', 'Enter']) {
  for (const L of PAD_LABELS) {
    await closeAll(page);
    await page.waitForTimeout(200);
    const n = await tabTo(page, L);
    const k = await who(page);
    if (/Jump/.test(L)) {
      const pv = peakVy(page, 850);
      await page.keyboard.press(key);
      const r = await pv;
      ok(n > 0 && r.peak > 1.0, `TRADE-3 Tab(${n}) "${L}" + ${key} jumps`,
        `peakVy=${r.peak} padTakesSpace=${k.padTakesSpace} driving=${k.driving}`);
    } else {
      const p0 = await page.evaluate(() => ({ a: window.__pad.act, s: window.__pad.sc, p: WALLY.ctx.ui.panels.length }));
      await page.keyboard.press(key);
      await page.waitForTimeout(500);
      const p1 = await page.evaluate(() => ({ a: window.__pad.act, s: window.__pad.sc, p: WALLY.ctx.ui.panels.length,
        why: WALLY.debug.interact() }));
      const d = (p1.a - p0.a) + (p1.s - p0.s) + (p1.p - p0.p);
      ok(n > 0 && d > 0, `TRADE-3 Tab(${n}) "${L}" + ${key} activates`,
        `dact=${p1.a - p0.a} dsc=${p1.s - p0.s} dpanels=${p1.p - p0.p} why=${p1.why} padTakesSpace=${k.padTakesSpace}`);
    }
  }
}

/* ---------- 3. incidental touch: where does focus land ---------- */
await closeAll(page);
for (const [name, x, y] of [
  ['canvas', 195, 300], ['stick', b.stick.x, b.stick.y],
  ['jump', b.jump.x, b.jump.y], ['shortcutPhone', b.sc[0].x, b.sc[0].y],
  ['actEnter', b.act.x, b.act.y]]) {
  await closeAll(page);
  await tabTo(page, 'Menu');
  const pre = await who(page);
  await press(x, y, 70);
  await page.waitForTimeout(300);
  const post = await who(page);
  await page.keyboard.press('Tab');
  const nxt = await page.evaluate(() => document.activeElement?.getAttribute?.('aria-label') || '<body>');
  console.log(`INCIDENTAL ${name}: pre=${pre.focus} -> post=${post.focus} isBody=${post.isBody} driving=${post.driving} nextTab=${nxt}`);
  ok(!post.isBody, `TRADE-4 ${name} touch leaves focus somewhere real`,
    `focus=${post.focus} driving=${post.driving}`);
}

/* ---------- 4. focus while the pad FADES, and when it wakes ---------- */
await closeAll(page);
await page.evaluate(() => { WALLY.ctx.ui.hideUI = true; });
await page.waitForTimeout(400);
await tabTo(page, 'Menu');
console.log('PRE-FADE', JSON.stringify(await who(page)));
for (let i = 0; i < 14; i++) {
  await page.waitForTimeout(1000);
  const w = await who(page);
  if (w.hidden) { console.log(`FADED after ~${i + 1}s`, JSON.stringify(w)); break; }
  if (i === 13) console.log('NEVER FADED', JSON.stringify(w));
}
const inFade = await who(page);
const st = await page.evaluate(() => {
  const e = [...document.querySelectorAll('.w-touch button')]
    .find(x => x.getAttribute('aria-label') === 'Menu');
  const cs = getComputedStyle(e);
  return { vis: cs.visibility, op: cs.opacity, tabbable: e.tabIndex };
});
console.log('IN-FADE', JSON.stringify(inFade), 'menu', JSON.stringify(st));
ok(inFade.hidden === true, 'TRADE-5 the idle fade fired with focus parked on Menu', JSON.stringify(inFade));
ok(!inFade.isBody, 'TRADE-6 the fade did NOT dump the tabbed-to focus to <body>',
  `focus=${inFade.focus} isBody=${inFade.isBody}`);
const resume = await tabOrder(page, 3, 'Tab');
console.log('TAB RESUMES AT', JSON.stringify(resume));
/* Space while faded and still "focused" — does a hidden button fire? */
await tabTo(page, 'Menu').catch(() => {});
const wf = await who(page);
const q0 = await page.evaluate(() => WALLY.ctx.ui.panels.length);
await page.keyboard.press('Space');
await page.waitForTimeout(450);
const q1 = await page.evaluate(() => WALLY.ctx.ui.panels.length);
console.log('SPACE WHILE FADED', JSON.stringify(wf), 'panels', q0, '->', q1);

console.log('PAGEERRORS', JSON.stringify(t.errs));
console.log(`FAILS ${t.fails}`);
await t.close();
