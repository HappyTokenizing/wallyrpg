/* GB7 PROBE 1 — ATTACK THE GATE.
   Every control x every button index, as a press and as a drag, in the
   MOBILE context where the pad is up on its own (a phone with a mouse /
   a touchscreen laptop that ticked Touch controls). Touch fingers are
   always button 0, so the button matrix is necessarily a MOUSE matrix;
   the touch half of the mandate is the "primary still works" half and
   is driven with real touch events at the end. */
import { boot, boxes, padProbe2, padState, rawMouse, MASK, walkSpeed, vy } from './lib.mjs';

const R = await boot({ mobile: true });
const { page, ok, cdp } = R;
const M = rawMouse(cdp);
const W = (ms) => page.waitForTimeout(ms);

await page.evaluate(() => WALLY.debug.hideUI(false));
await W(300);
const B = await boxes(page);
console.log('BOXES', JSON.stringify(B));
const HOME = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });

const reset = async () => {
  await page.evaluate(() => { WALLY.debug.uiHide(); }).catch(() => {});
  await W(350);
};
const arm = async () => { await padProbe2(page); };
const ledger = async () => {
  try {
    return await page.evaluate(() => ({ act: window.__pad.act, sc: window.__pad.sc,
      menus: window.__pad.menus.slice(),
      ev: window.__pad.ev.map(e => `${e.type}:b${e.button}/m${e.buttons}:${e.target}`) }));
  } catch (err) { return { act: -1, sc: -1, menus: [], ev: ['CONTEXT DESTROYED: ' + String(err).slice(0, 80)] }; }
};
/* KEEP THE DOCUMENT ALIVE UNDER A BACK/FORWARD PRESS. Chrome maps mouse
   buttons 3/4 to history navigation at the browser level, which tears the
   page down and makes every later assertion unreadable. Two pushState
   entries turn that traversal into a SAME-DOCUMENT one, so the pad
   survives and the question "did the pad fire a verb" stays answerable.
   Whether the navigation happens at all is measured separately below. */
const stackHistory = () => page.evaluate(() => {
  if (location.hash !== '#gb7b') { history.pushState({}, '', '#gb7a'); history.pushState({}, '', '#gb7b'); }
  return location.hash;
});

const BUTTONS = ['left', 'middle', 'right', 'back', 'forward'];
const IDX = { left: 0, middle: 1, right: 2, back: 3, forward: 4 };

async function mpress(x, y, button, hold = 70, ptype = 'mouse', drag = 0) {
  await M('mouseMoved', x, y, 'none', 0, ptype);
  await M('mousePressed', x, y, button, MASK[button], ptype);
  if (drag) {
    for (let i = 1; i <= 3; i++) { await M('mouseMoved', x + drag * i / 3, y, button, MASK[button], ptype); await W(15); }
  }
  await W(hold);
  await M('mouseReleased', x + drag, y, button, 0, ptype);
  await W(180);
}

/* ---------- did the page survive back/forward? ---------- */
const url0 = page.url().split('#')[0];
const navGuard = async (label) => {
  const dead = await page.evaluate(() => !!window.WALLY).catch(() => false);
  if (!dead || page.url().split('#')[0] !== url0) {
    console.log(`NAV  ${label}: the page navigated to ${page.url()} — probe cannot discriminate`);
    await page.goto(url0 + '?skipIntro', { waitUntil: 'load', timeout: 180000 });
    await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 240000 });
    await W(3000);
    await page.evaluate(() => WALLY.debug.hideUI(false));
    return true;
  }
  return false;
};

/* ================= A. ENTER + the four shortcuts, press and drag ============ */
const namedBtns = [['Enter', B.act, 'act'], ...B.sc.map((s) => [s.label, s, 'sc'])];

for (const mode of ['press', 'drag']) {
  for (const btn of BUTTONS) {
    for (const [name, box, kind] of namedBtns) {
      await reset(); await arm();
      await stackHistory();
      await mpress(box.x, box.y, btn, 70, 'mouse', mode === 'drag' ? 6 : 0);
      const L = await ledger();
      if (await navGuard(`${btn} ${mode} ${name}`)) continue;
      const fired = kind === 'act' ? L.act : L.sc;
      const want = btn === 'left' ? 1 : 0;
      ok(fired === want,
        `GATE-${mode}/${btn}/${name}: verb ran ${fired}x, wanted ${want}x`,
        fired !== want ? JSON.stringify(L.ev.slice(-6)) : '');
    }
  }
}

/* ================= B. JUMP, press and drag ============ */
for (const mode of ['press', 'drag']) {
  for (const btn of BUTTONS) {
    await reset(); await arm(); await stackHistory();
    await page.evaluate((h) => WALLY.ctx.wally.warpTo(h.x, h.y + 0.05, h.z, {}), HOME);
    await W(700);
    await M('mouseMoved', B.jump.x, B.jump.y, 'none', 0, 'mouse');
    await M('mousePressed', B.jump.x, B.jump.y, btn, MASK[btn], 'mouse');
    if (mode === 'drag') { for (let i = 1; i <= 3; i++) { await M('mouseMoved', B.jump.x + 2 * i, B.jump.y, btn, MASK[btn], 'mouse'); await W(12); } }
    await W(60);
    const heldClass = await page.evaluate(() => document.querySelector('.w-abtn.jump')?.classList.contains('down')).catch(() => null);
    const air = await vy(page).catch(() => null);
    await W(120);
    const air2 = await vy(page).catch(() => null);
    await M('mouseReleased', B.jump.x + (mode === 'drag' ? 6 : 0), B.jump.y, btn, 0, 'mouse');
    await W(250);
    if (await navGuard(`${btn} ${mode} Jump`)) continue;
    const left = Math.max(air ?? -9, air2 ?? -9) > 0.6;
    const want = btn === 'left';
    ok(heldClass === want && left === want,
      `GATE-${mode}/${btn}/Jump: down-class ${heldClass}, left-ground ${left}, wanted ${want}`,
      `vy ${air}/${air2}`);
    const stuck = await page.evaluate(() => document.querySelector('.w-abtn.jump')?.classList.contains('down')).catch(() => null);
    ok(stuck === false, `GATE-${mode}/${btn}/Jump: not left stranded down after release`);
  }
}

/* ================= C. THE THUMBSTICK, press and drag ============ */
for (const mode of ['press', 'drag']) {
  for (const btn of BUTTONS) {
    await reset(); await arm(); await stackHistory();
    await page.evaluate((h) => WALLY.ctx.wally.warpTo(h.x, h.y + 0.05, h.z, {}), HOME);
    await W(700);
    await M('mouseMoved', B.stick.x, B.stick.y, 'none', 0, 'mouse');
    await M('mousePressed', B.stick.x, B.stick.y, btn, MASK[btn], 'mouse');
    if (mode === 'drag') {
      for (let i = 1; i <= 5; i++) { await M('mouseMoved', B.stick.x, B.stick.y - 14 * i, btn, MASK[btn], 'mouse'); await W(25); }
    }
    await W(120);
    const t = await page.evaluate(() => +WALLY.debug.touchState().t.toFixed(2)).catch(() => -1);
    const spd = await walkSpeed(page).catch(() => null);
    await M('mouseReleased', B.stick.x, B.stick.y - (mode === 'drag' ? 70 : 0), btn, 0, 'mouse');
    await W(300);
    if (await navGuard(`${btn} ${mode} stick`)) continue;
    const t2 = await page.evaluate(() => +WALLY.debug.touchState().t.toFixed(2)).catch(() => -1);
    const want = btn === 'left' && mode === 'drag';
    ok((t > 0.2) === want,
      `GATE-${mode}/${btn}/stick: deflection ${t}, wanted ${want ? '>0.2' : '0'}`, `speed ${spd}`);
    ok(t2 === 0, `GATE-${mode}/${btn}/stick: returns to rest after release (t=${t2})`);
  }
}

/* ================= D. PRIMARY STILL WORKS — real fingers ============ */
await reset(); await arm();
await R.press(B.act.x, B.act.y, 60); await W(400);
let L = await ledger();
ok(L.act === 1, `PRIMARY-touch/Enter: a real finger still runs the verb (${L.act})`);

for (const s of B.sc) {
  await reset(); await arm();
  await R.press(s.x, s.y, 60); await W(600);
  L = await ledger();
  ok(L.sc >= 1, `PRIMARY-touch/${s.label}: a real finger still opens it (${L.sc})`);
}

await reset(); await arm();
await page.evaluate((h) => WALLY.ctx.wally.warpTo(h.x, h.y + 0.05, h.z, {}), HOME);
await W(700);
await R.touch('touchStart', B.jump.x, B.jump.y);
await W(90);
const jvy = await vy(page);
await R.touch('touchEnd', B.jump.x, B.jump.y);
await W(200);
ok((jvy ?? -9) > 0.6, `PRIMARY-touch/Jump: a real finger leaves the ground (vy ${jvy})`);

await reset();
await page.evaluate((h) => WALLY.ctx.wally.warpTo(h.x, h.y + 0.05, h.z, {}), HOME);
await W(700);
await R.touch('touchStart', B.stick.x, B.stick.y);
for (let i = 1; i <= 5; i++) { await R.touch('touchMove', B.stick.x, B.stick.y - 14 * i); await W(25); }
await W(150);
const ft = await page.evaluate(() => +WALLY.debug.touchState().t.toFixed(2));
const fspd = await walkSpeed(page);
await R.touch('touchEnd', B.stick.x, B.stick.y - 70);
await W(250);
ok(ft > 0.5 && (fspd ?? 0) > 0.2, `PRIMARY-touch/stick: a real thumb deflects and walks (t ${ft}, speed ${fspd})`);

/* --------- and the primary MOUSE on every control, one more time --------- */
await reset(); await arm();
await mpress(B.act.x, B.act.y, 'left');
L = await ledger();
ok(L.act === 1, `PRIMARY-mouse/Enter: ${L.act}`);

/* ====== E. WHOSE NAVIGATION IS THE BACK BUTTON'S? ====== */
for (const where of [['pad Enter', B.act], ['bare canvas', { x: 195, y: 300 }]]) {
  await reset();
  await page.evaluate(() => { history.pushState({}, '', '#gb7a'); history.pushState({}, '', '#gb7b'); });
  await W(150);
  await mpress(where[1].x, where[1].y, 'back');
  await W(400);
  const h = await page.evaluate(() => location.hash).catch(() => 'DEAD');
  console.log(`BACK-nav [${where[0]}]: hash after a back press = ${h} (started #gb7b)`);
}
await reset();

/* ====== F. CONTEXTMENU, inside the pad and outside it ====== */
await arm();
await M('mouseMoved', B.act.x, B.act.y, 'none', 0, 'mouse');
await M('mousePressed', B.act.x, B.act.y, 'right', 2, 'mouse');
await M('mouseReleased', B.act.x, B.act.y, 'right', 0, 'mouse');
await W(300);
let menus = await page.evaluate(() => window.__pad.menus.slice());
ok(menus.length > 0 && menus.every((m) => m.inPad && m.prevented),
  `CTX-in [right press on Enter]: menu suppressed inside the pad`, JSON.stringify(menus));

/* outside the pad: raise a sheet and right-press its body */
await page.evaluate(() => WALLY.debug.ui('settings'));
await W(900);
const sheet = await page.evaluate(() => {
  const el = document.querySelector('.w-sheet, .w-panel, .w-modal, .w-scrim');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 40), sel: el.className };
});
if (!sheet) {
  console.log('CTX-out: no sheet element found — probe cannot discriminate');
} else {
  await page.evaluate(() => { window.__pad.menus.length = 0; });
  await M('mouseMoved', sheet.x, sheet.y, 'none', 0, 'mouse');
  await M('mousePressed', sheet.x, sheet.y, 'right', 2, 'mouse');
  await M('mouseReleased', sheet.x, sheet.y, 'right', 0, 'mouse');
  await W(300);
  menus = await page.evaluate(() => window.__pad.menus.slice());
  ok(menus.length > 0 && menus.every((m) => !m.inPad && !m.prevented),
    `CTX-out [right press on ${sheet.sel}]: menu NOT suppressed outside the pad`, JSON.stringify(menus));
}
await reset();

console.log(`\nFAILS ${R.fails}   pageerrors ${R.errs.length}`);
await R.close();
