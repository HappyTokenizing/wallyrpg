/* GB7 PROBE 3 — pen / stylus / eraser, the context menu in and out of the
   pad, the back-button attribution, and PRIMARY-STILL-WORKS on real touch. */
import { boot, boxes, padProbe2, rawMouse, MASK, walkSpeed } from './lib.mjs';

const R = await boot({ mobile: true });
const { page, ok, cdp } = R;
const M = rawMouse(cdp);
const W = (ms) => page.waitForTimeout(ms);
await page.evaluate(() => WALLY.debug.hideUI(false));
await W(300);
const B = await boxes(page);
const HOME = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const reset = async () => { await page.evaluate(() => WALLY.debug.uiHide()).catch(() => {});
  await page.evaluate((h) => WALLY.ctx.wally.warpTo(h.x, h.y + 0.05, h.z, {}), HOME); await W(700); };
const arm = () => padProbe2(page);
const led = () => page.evaluate(() => ({ act: window.__pad.act, sc: window.__pad.sc,
  menus: window.__pad.menus.slice(),
  ev: window.__pad.ev.map(e => `${e.type} b${e.button}/m${e.buttons} ${e.ptype} ${e.target}`) }));
async function peakY(ms = 900) {
  return page.evaluate((d) => new Promise((res) => {
    const p = WALLY.ctx.wally.position; const y0 = p.y; let best = 0;
    const t = setInterval(() => { best = Math.max(best, p.y - y0); }, 16);
    setTimeout(() => { clearInterval(t); res(+best.toFixed(3)); }, d);
  }), ms);
}

/* ============ 1. POINTER TYPES ============ */
const cases = [
  ['pen tip',        'pen',   'left',  1,  {}, true],
  ['pen barrel',     'pen',   'right', 2,  {}, false],
  ['pen middle',     'pen',   'middle', 4, {}, false],
  ['pen ERASER (buttons mask 32)', 'pen', 'left', 32, {}, null],
  ['mouse tip',      'mouse', 'left',  1,  {}, true],
];
for (const [label, ptype, btn, mask, extra, wantFire] of cases) {
  await reset(); await arm();
  await M('mouseMoved', B.act.x, B.act.y, 'none', 0, ptype, { force: 0.5, ...extra });
  await M('mousePressed', B.act.x, B.act.y, btn, mask, ptype, { force: 0.5, ...extra });
  await W(80);
  await M('mouseReleased', B.act.x, B.act.y, btn, 0, ptype, { force: 0, ...extra });
  await W(350);
  const L = await led();
  const downs = L.ev.filter((s) => s.startsWith('pointerdown'));
  const reached = downs.length > 0;
  ok(reached, `PT-pre [${label}]: the contact really reached the page`, JSON.stringify(L.ev.slice(0, 3)));
  if (wantFire === null) {
    console.log(`PT [${label}]: PROBE CANNOT DISCRIMINATE — CDP has no eraser; the page saw ${JSON.stringify(downs)} and the verb ran ${L.act}x`);
  } else {
    ok(L.act === (wantFire ? 1 : 0),
      `PT [${label}]: verb ran ${L.act}x, wanted ${wantFire ? 1 : 0}`, JSON.stringify(L.ev.slice(-4)));
  }
}

/* pen tip on the stick and on Jump, because a stylus is a whole hand */
await reset(); await arm();
await M('mouseMoved', B.stick.x, B.stick.y, 'none', 0, 'pen', { force: 0.5 });
await M('mousePressed', B.stick.x, B.stick.y, 'left', 1, 'pen', { force: 0.5 });
for (let j = 1; j <= 5; j++) { await M('mouseMoved', B.stick.x, B.stick.y - 14 * j, 'left', 1, 'pen', { force: 0.5 }); await W(22); }
await W(120);
const penT = await page.evaluate(() => +WALLY.debug.touchState().t.toFixed(2));
const penSpd = await walkSpeed(page);
await M('mouseReleased', B.stick.x, B.stick.y - 70, 'left', 0, 'pen', { force: 0 });
await W(300);
const penT2 = await page.evaluate(() => +WALLY.debug.touchState().t.toFixed(2));
ok(penT > 0.5 && (penSpd ?? 0) > 0.2, `PT-stick [pen tip]: deflects and walks (t ${penT}, speed ${penSpd})`);
ok(penT2 === 0, `PT-stick [pen tip]: back to rest (t ${penT2})`);

await reset();
let pk = peakY(1000); await W(30);
await M('mouseMoved', B.jump.x, B.jump.y, 'none', 0, 'pen', { force: 0.5 });
await M('mousePressed', B.jump.x, B.jump.y, 'left', 1, 'pen', { force: 0.5 });
await W(140);
await M('mouseReleased', B.jump.x, B.jump.y, 'left', 0, 'pen', { force: 0 });
ok((await pk) > 0.15, `PT-jump [pen tip]: leaves the ground`);

await reset();
pk = peakY(1000); await W(30);
await M('mouseMoved', B.jump.x, B.jump.y, 'none', 0, 'pen', { force: 0.5 });
await M('mousePressed', B.jump.x, B.jump.y, 'right', 2, 'pen', { force: 0.5 });
await W(140);
await M('mouseReleased', B.jump.x, B.jump.y, 'right', 0, 'pen', { force: 0 });
const barrelRise = await pk;
const barrelStuck = await page.evaluate(() => document.querySelector('.w-abtn.jump')?.classList.contains('down'));
ok(barrelRise < 0.05 && barrelStuck === false,
  `PT-jump [pen barrel]: refused and not stranded (rise ${barrelRise}, down ${barrelStuck})`);

/* ============ 2. CONTEXT MENU, in the pad and out of it ============ */
for (const [label, box] of [['Enter', B.act], ['Jump', B.jump], ['thumbstick', B.stick], ['Phone', B.sc[0]]]) {
  await reset(); await arm();
  await M('mouseMoved', box.x, box.y, 'none', 0, 'mouse');
  await M('mousePressed', box.x, box.y, 'right', 2, 'mouse');
  await M('mouseReleased', box.x, box.y, 'right', 0, 'mouse');
  await W(300);
  const L = await led();
  ok(L.menus.length > 0 && L.menus.every((m) => m.inPad && m.prevented),
    `CTX-in [${label}]: contextmenu raised inside the pad and suppressed`, JSON.stringify(L.menus));
}

/* outside the pad: on the canvas (camera.js suppresses it) and on a sheet */
await reset(); await arm();
await M('mouseMoved', 195, 300, 'none', 0, 'mouse');
await M('mousePressed', 195, 300, 'right', 2, 'mouse');
await M('mouseReleased', 195, 300, 'right', 0, 'mouse');
await W(300);
let L = await led();
console.log(`CTX-canvas [bare canvas]: ${JSON.stringify(L.menus)}`);

await page.evaluate(() => WALLY.debug.ui('settings'));
await W(1000);
const sheet = await page.evaluate(() => {
  for (const sel of ['.w-sheet', '.w-panel', '.w-card', '.w-modal', '.w-scrim', '.w-sheetwrap']) {
    const el = document.querySelector(sel);
    if (el) { const r = el.getBoundingClientRect(); if (r.width > 40 && r.height > 40)
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(60, r.height / 3)), sel }; }
  }
  return null;
});
if (!sheet) {
  console.log('CTX-out: no sheet element found — PROBE CANNOT DISCRIMINATE');
} else {
  await page.evaluate(() => { window.__pad.menus.length = 0; });
  await M('mouseMoved', sheet.x, sheet.y, 'none', 0, 'mouse');
  await M('mousePressed', sheet.x, sheet.y, 'right', 2, 'mouse');
  await M('mouseReleased', sheet.x, sheet.y, 'right', 0, 'mouse');
  await W(300);
  L = await led();
  ok(L.menus.length > 0 && L.menus.every((m) => !m.inPad && !m.prevented),
    `CTX-out [${sheet.sel}]: contextmenu NOT suppressed outside the pad`, JSON.stringify(L.menus));
}
await reset();

/* ============ 3. BACK BUTTON — whose navigation is it? ============ */
for (const [label, box] of [['over the pad Enter', B.act], ['over the bare canvas', { x: 195, y: 300 }]]) {
  await page.evaluate(() => { history.pushState({}, '', '#a'); history.pushState({}, '', '#b'); }).catch(() => {});
  await W(150);
  await M('mouseMoved', box.x, box.y, 'none', 0, 'mouse');
  await M('mousePressed', box.x, box.y, 'back', 8, 'mouse');
  await M('mouseReleased', box.x, box.y, 'back', 0, 'mouse');
  await W(500);
  const h = await page.evaluate(() => location.hash).catch(() => 'CONTEXT DESTROYED');
  console.log(`BACK-nav [${label}]: hash went #b -> ${h}`);
}
await page.evaluate(() => { location.hash = ''; }).catch(() => {});
await reset();

/* ============ 4. PRIMARY STILL WORKS — REAL FINGERS, every control ======= */
await arm();
await R.press(B.act.x, B.act.y, 60); await W(450);
L = await led();
ok(L.act === 1, `PRIMARY-touch/Enter: a real finger runs the verb (${L.act})`);
for (const s of B.sc) {
  await reset(); await arm();
  await R.press(s.x, s.y, 60); await W(700);
  L = await led();
  ok(L.sc >= 1, `PRIMARY-touch/${s.label}: a real finger opens it (${L.sc})`);
}
await reset();
pk = peakY(1000); await W(30);
await R.touch('touchStart', B.jump.x, B.jump.y); await W(140);
await R.touch('touchEnd', B.jump.x, B.jump.y);
ok((await pk) > 0.15, `PRIMARY-touch/Jump: a real finger leaves the ground`);
await reset();
await R.touch('touchStart', B.stick.x, B.stick.y);
for (let i = 1; i <= 5; i++) { await R.touch('touchMove', B.stick.x, B.stick.y - 14 * i); await W(25); }
await W(150);
const ft = await page.evaluate(() => +WALLY.debug.touchState().t.toFixed(2));
const fs = await walkSpeed(page);
await R.touch('touchEnd', B.stick.x, B.stick.y - 70);
await W(300);
const ft2 = await page.evaluate(() => +WALLY.debug.touchState().t.toFixed(2));
ok(ft > 0.5 && (fs ?? 0) > 0.2, `PRIMARY-touch/stick: a real thumb deflects and walks (t ${ft}, speed ${fs})`);
ok(ft2 === 0, `PRIMARY-touch/stick: back to rest (t ${ft2})`);

console.log(`\nFAILS ${R.fails}   pageerrors ${R.errs.length}`);
await R.close();
