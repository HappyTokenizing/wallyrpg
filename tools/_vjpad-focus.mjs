/* _vjpad-focus.mjs — THE FOCUS-GRAB ROUND.
   ==========================================================================
   Extends tools/_vjpad-judge.mjs, which measured the primary-button gate but
   never once read document.activeElement. That is the hole this file fills.

   THE DEFECT. `secondary(e)` returned ABOVE the `e.preventDefault()` in all
   three controls, so a refused right/middle press ran no verb — every
   assertion in the previous judge stayed green — but the browser's default
   action still ran, and the default action of a pointerdown on a <button> is
   TO FOCUS IT. The pad then held focus, and the player's next Space or Enter
   was delivered to that button as a click with detail 0 — which is exactly
   the shape bindPress's assistive-technology listener accepts. Every refused
   verb ran one keystroke late, and Space stopped being Jump.

   WHY THIS FILE DOES NOT TRUST A NULL. "activeElement is not in the pad" is
   the expected reading whether the fix works OR the browser never focuses
   buttons on mousedown at all. On macOS that is a live possibility, and a
   suite that cannot tell those apart is measuring the platform, not the pad.
   So every no-focus claim here is gated on MIMIC-B: a button carrying the
   BROKEN ordering, right-pressed by the same CDP call at the same moment,
   which must be observed to take focus. No grab on the mimic -> BLOCKED, not
   passed. MIMIC-A carries the FIXED ordering and must not take focus, which
   isolates the ordering itself as the cause.
   ========================================================================== */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try {
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' });
    rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const LOAD0 = execSync('uptime').toString().trim();
console.log('LOAD AT START  ' + LOAD0);

const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
let fails = 0, blocked = 0;
const ok = (cond, msg, extra = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '   ' + extra : ''}`);
  return cond;
};
const ctxMobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctxMobile.newPage();
page.on('pageerror', e => { console.log('PAGEERROR', e.message.split('\n')[0]); fails++; });
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(3500);
const cdp = await ctxMobile.newCDPSession(page);
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.hideUI(false); });
await page.waitForTimeout(600);

/* ================= the probe =================
   INSTALLED THROUGH A NAMED, IDEMPOTENT FUNCTION rather than one evaluate at
   boot. A verb under test can raise a sheet that navigates, and a navigation
   silently destroys the JS context along with every listener this file
   measures through — which shows up as a probe that "isn't a function"
   rather than as a wrong number, but would show up as a SILENT ZERO for any
   counter read after it. installProbe() is therefore re-run before every
   section, and navigations are logged and counted. */
/* DOCUMENT IDENTITY, NOT framenavigated. The first version of F4 counted
   `framenavigated`, which ALSO fires for same-document history moves — it
   read 94 while the document had never once been replaced, and would have
   condemned a healthy run. A token minted at install time and re-read later
   answers the only question that matters: is this the same document, with
   the same listeners, that the measurement was taken through. */
let navs = 0;
page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs++; });
const docId = () => page.evaluate(() => window.__docId ?? null);
const installProbe = () => page.evaluate(() => {
  /* IDEMPOTENT AND NON-DESTRUCTIVE. read() calls this too, so it must never
     clear the log it is about to be asked for — only reset() does that. */
  if (window.__fInstalled && window.__F) return 'already';
  window.__docId = window.__docId || ('doc-' + Math.random().toString(36).slice(2));
  if (window.__fInstalled) { window.__fReset(); return 'relog'; }
  window.__fInstalled = true;
  window.__docId = 'doc-' + Math.random().toString(36).slice(2);
  const q = (s) => document.querySelector(s);
  const els = { act: q('.w-acts .w-abtn.act'), jump: q('.w-acts .w-abtn.jump'), stick: q('.w-stick') };
  [...document.querySelectorAll('.w-acts .shortcuts .w-abtn')].forEach((b, i) => { els['sc' + i] = b; });
  window.__fEls = els;
  const desc = (t) => !t ? null : (t.tagName ? t.tagName.toLowerCase() + '.' + String(t.className?.baseVal ?? t.className ?? '').trim().split(/\s+/).join('.') : String(t));
  window.__fDesc = desc;
  window.__fReset = () => { window.__F = { focusin: [], ev: [], arm: [], verbs: [], keys: [] }; };
  window.__fReset();
  /* HANDLER ENTRY AT THE REAL ELEMENT: touch.js adds 'down' inside its own
     pointerdown handler, BELOW the gate. Class on == the guard was passed. */
  const mo = new MutationObserver((recs) => {
    for (const r of recs) {
      const name = Object.keys(window.__fEls).find((k) => window.__fEls[k] === r.target);
      const on = name === 'stick' ? r.target.classList.contains('live') : r.target.classList.contains('down');
      const last = window.__F.arm.filter((a) => a.el === name).pop();
      if (!last || last.on !== on) window.__F.arm.push({ el: name, on, t: Math.round(performance.now()) });
    }
  });
  for (const k of Object.keys(els)) if (els[k]) mo.observe(els[k], { attributes: true, attributeFilter: ['class'] });
  /* THE FOCUS GRAB IS A TRANSIENT. Sampling activeElement afterwards can be
     fooled by anything that blurs in between, so the EVENT is logged too and
     both are asserted. focusin bubbles; focus does not. */
  document.addEventListener('focusin', (e) => {
    window.__F.focusin.push({ tg: desc(e.target),
      inPad: !!e.target.closest?.('.w-touch'),
      ctl: Object.keys(window.__fEls).find((k) => window.__fEls[k]?.contains?.(e.target)) || null,
      mimic: e.target.id || null, t: Math.round(performance.now()) });
  }, true);
  for (const t of ['pointerdown', 'pointerup', 'click']) {
    document.addEventListener(t, (e) => {
      window.__F.ev.push({ t: e.type, b: e.button, d: e.detail, id: e.pointerId,
        pt: e.pointerType, tg: desc(e.target),
        on: Object.keys(window.__fEls).find((k) => window.__fEls[k]?.contains?.(e.target)) || null,
        inPad: !!e.target.closest?.('.w-touch'), ts: Math.round(e.timeStamp) });
    }, true);
  }
  window.addEventListener('keydown', (e) => { window.__F.keys.push({ code: e.code, tg: desc(e.target) }); }, true);
  const u = WALLY.ctx.ui;
  ['interact', 'openPhone', 'openDesk', 'show'].forEach((k) => {
    const o = u[k].bind(u); u[k] = (...a) => { window.__F.verbs.push(k); return o(...a); };
  });

  /* ---- THE MIMICS: the two orderings, side by side, real <button>s ---- */
  const mk = (id, left) => {
    const b = document.createElement('button');
    b.id = id; b.type = 'button'; b.textContent = id;
    b.style.cssText = `position:fixed;top:8px;left:${left}px;width:70px;height:34px;z-index:99999;`;
    document.body.appendChild(b);
    return b;
  };
  const secondary = (e) => e.button > 0 && !(e.button === 5 && e.pointerType === 'pen');
  const mA = mk('mimicFIXED', 8);
  mA.addEventListener('pointerdown', (e) => { e.preventDefault(); if (secondary(e)) return; }, false);
  const mB = mk('mimicBROKEN', 88);
  mB.addEventListener('pointerdown', (e) => { if (secondary(e)) return; e.preventDefault(); }, false);
  mB.addEventListener('contextmenu', (e) => e.preventDefault(), false);
  mA.addEventListener('contextmenu', (e) => e.preventDefault(), false);
  return 'installed';
});
await installProbe();
const DOC0 = await page.evaluate(() => window.__docId);
const reset = async () => { await installProbe(); await page.evaluate(() => { window.__fReset(); }); };
const read = async () => { await installProbe(); return page.evaluate(() => ({
  ...window.__F,
  active: ((t) => !t ? null : (t.tagName ? t.tagName.toLowerCase() + '.' + String(t.className?.baseVal ?? t.className ?? '').trim().split(/\s+/).join('.') : String(t)))(document.activeElement),
  activeId: document.activeElement?.id || null,
  inPad: !!document.activeElement?.closest?.('.w-touch'),
  ctl: Object.keys(window.__fEls).find((k) => window.__fEls[k]?.contains?.(document.activeElement)) || null,
  panels: WALLY.ctx.ui.panels.slice(),
  stick: +(WALLY.debug.touchState().t ?? 0),
  vy: +WALLY.ctx.wally.controller.velocity.y.toFixed(2),
  grounded: WALLY.ctx.wally.controller.grounded,
})); };
const blur = () => page.evaluate(() => document.activeElement?.blur?.());

/* ================= geometry ================= */
const box = (sel, i = 0) => page.evaluate(([s, k]) => {
  const b = [...document.querySelectorAll(s)][k];
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: b.getAttribute('aria-label') || b.id || s };
}, [sel, i]);
const ACT = await box('.w-acts .w-abtn.act');
const JUMP = await box('.w-acts .w-abtn.jump');
const SC = [];
for (let i = 0; i < 4; i++) SC.push(await box('.w-acts .shortcuts .w-abtn', i));
const STICK = await box('.w-stick');
const MA = await box('#mimicFIXED');
const MB = await box('#mimicBROKEN');
/* THE SEVEN CONTROLS, named once. Six are focusable <button>s; the stick is
   a <div> and can only ever read null — it is carried so the census is the
   pad's own list and not a list of the things that happened to pass. */
const CTLS = [
  { k: 'act', ...ACT }, { k: 'sc0', ...SC[0] }, { k: 'sc1', ...SC[1] },
  { k: 'sc2', ...SC[2] }, { k: 'sc3', ...SC[3] }, { k: 'jump', ...JUMP },
  { k: 'stick', ...STICK },
];
console.log('   geometry ' + JSON.stringify({ CTLS: CTLS.map(c => [c.k, c.x, c.y]), MA, MB }));
if (CTLS.some(c => c.x == null)) { console.log('FATAL: a control was not found'); process.exit(1); }

/* ================= input ================= */
const MASK = { left: 1, middle: 4, right: 2, back: 8, forward: 16 };
const BTNNO = { left: 0, middle: 1, right: 2, back: 3, forward: 4 };
const mouse = (type, x, y, button = 'none', buttons = 0) => cdp.send('Input.dispatchMouseEvent',
  { type, x, y, button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
async function mousePress(x, y, button = 'left', hold = 70) {
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, button, MASK[button]);
  await page.waitForTimeout(hold);
  await mouse('mouseReleased', x, y, button, 0);
}
const P = (x, y, id = 1) => ({ x, y, id, radiusX: 14, radiusY: 14, force: 1 });
const multi = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
/* ==========================================================================
   KEYS GO THROUGH PLAYWRIGHT, NOT THROUGH A HAND-ROLLED CDP DESCRIPTOR.

   `nativeVirtualKeyCode` is a macOS keycode on macOS, and the previous
   judge passed WINDOWS ones. Chrome auto-repeats the key it resolves
   NATIVELY, so a hand-rolled descriptor starts an endless storm of a
   DIFFERENT key at ~3700 events a second. Measured in tools/_keyprobe.mjs:

     rawKeyDown Enter  nativeVirtualKeyCode 13 -> repeats code KeyW
     rawKeyDown KeyW   nativeVirtualKeyCode 87 -> repeats code Numpad5
     rawKeyDown Space  nativeVirtualKeyCode 32 -> repeats code KeyU

   macOS keycode 13 IS W, 87 IS keypad-5, 32 IS U. Section N asserts this
   so the suite can never quietly go back to it: an Enter that silently
   holds W down is a harness that walks the character through every
   subsequent fixture.
   ========================================================================== */
const PW = { Space: ' ', Enter: 'Enter', Tab: 'Tab' };
const key = (code) => page.keyboard.press(PW[code] ?? code);
const keyDown = (code) => page.keyboard.down(PW[code] ?? code);
const keyUp = (code) => page.keyboard.up(PW[code] ?? code);
/* WAIT FOR THE JUMP, DO NOT SAMPLE FOR IT — the previous judge's lesson: one
   rAF with a huge dt integrates the whole arc between two samples. Returns
   the PEAK vy and the peak height gain, which is what "variable jump height"
   is actually about. */
async function airborne(ms = 2000) {
  const t0 = Date.now();
  const y0 = await page.evaluate(() => WALLY.ctx.wally.position.y);
  let vy = 0, air = false, top = y0;
  while (Date.now() - t0 < ms) {
    const s = await page.evaluate(() => ({ vy: +WALLY.ctx.wally.controller.velocity.y.toFixed(2), g: WALLY.ctx.wally.controller.grounded, y: WALLY.ctx.wally.position.y }));
    if (s.vy > vy) vy = s.vy;
    if (s.y > top) top = s.y;
    if (!s.g) air = true;
    if (air && s.g && Date.now() - t0 > 250) break;
    await page.waitForTimeout(45);
  }
  return { vy, air, rise: +(top - y0).toFixed(3), ms: Date.now() - t0 };
}
const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft'];
const VK = { KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Space: 32, ShiftLeft: 16 };
async function flushKeys() {
  for (const c of MOVE_KEYS) await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: c, key: c, windowsVirtualKeyCode: VK[c], nativeVirtualKeyCode: VK[c] });
}
const toOpenGround = async () => {
  await flushKeys();
  await page.evaluate((b) => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {}); }, BOOT);
  await page.waitForTimeout(1000);
};
const closeAll = async () => { await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); }); await page.waitForTimeout(450); };

/* ==========================================================================
   M — THE MIMIC GATE. Everything in section F depends on this.
   ========================================================================== */
/* ==========================================================================
   N — THE HARNESS'S OWN KEYBOARD IS NOT ALLOWED TO HOLD A KEY DOWN.
   Runs FIRST, because every section below dispatches keys and a storm makes
   all of them measure a machine with a key stuck down.
   ========================================================================== */
console.log('\n--- N: the harness keyboard does not latch ---');
await page.evaluate(() => { window.__NK = []; addEventListener('keydown', (e) => window.__NK.push(e.code), true); });
await page.keyboard.press('Enter');
await page.keyboard.press(' ');
await page.keyboard.press('Tab');
await page.waitForTimeout(1200);
const stormN = await page.evaluate(() => { const k = window.__NK.slice(); window.__NK = []; return k; });
const repeats = stormN.filter((c, i) => stormN.indexOf(c) !== i);
ok(stormN.length <= 6 && repeats.length === 0,
  'N1 [BRANCH the harness\'s key dispatch]: Enter, Space and Tab each arrive exactly once and nothing auto-repeats — a hand-rolled nativeVirtualKeyCode made Enter hold KeyW down at ~3700/s and walked the character through every fixture after it',
  `${stormN.length} keydowns in 1.2 s: ${JSON.stringify(stormN)}`);
const kbN = await page.evaluate(() => { const o = WALLY.ctx.wally.keyboardInput({}); return { x: +o.x.toFixed(2), z: +o.z.toFixed(2), jump: o.jump, run: o.run }; });
ok(kbN.x === 0 && kbN.z === 0 && !kbN.jump && !kbN.run,
  'N2 [BRANCH wally.js keys{} after the harness has typed]: no movement key is latched — keyboardInput() is camera-relative and returns early on (0,0), so a non-zero read here would be proof of a stuck key',
  JSON.stringify(kbN));

console.log('\n--- M: is the focus grab even a thing in this browser? ---');
await closeAll();
await reset();
await mousePress(MB.x, MB.y, 'right', 80);
await page.waitForTimeout(300);
let r = await read();
const GRABS = r.activeId === 'mimicBROKEN' && r.focusin.some(f => f.mimic === 'mimicBROKEN');
ok(r.ev.some(e => e.t === 'pointerdown' && e.b === 2 && e.tg?.includes('button')),
  'M0 [setup]: a real button-2 pointerdown was delivered to the mimic',
  JSON.stringify(r.ev.filter(e => e.t === 'pointerdown')));
ok(GRABS,
  'M1 [THE GATE — BROKEN ordering, gate above preventDefault]: a refused right press on a <button> that returns BEFORE preventDefault DOES take focus in this Chrome. This is what makes every no-focus claim below a measurement instead of a platform reading',
  `active ${r.activeId}, focusin ${JSON.stringify(r.focusin)}`);
await blur();
await reset();
await mousePress(MA.x, MA.y, 'right', 80);
await page.waitForTimeout(300);
r = await read();
ok(r.activeId !== 'mimicFIXED' && !r.focusin.some(f => f.mimic === 'mimicFIXED'),
  'M2 [BRANCH the FIXED ordering, preventDefault above the gate]: the identical button with the two lines swapped does NOT take focus — the ordering is the whole cause, isolated from everything else about the pad',
  `active ${r.activeId}, focusin ${JSON.stringify(r.focusin)}`);
/* M3 proves the probe can SEE a focus, so an all-null section is not a
   probe that reads nothing. */
await page.evaluate(() => document.getElementById('mimicFIXED').focus());
r = await read();
ok(r.activeId === 'mimicFIXED', 'M3 [self-test of the probe]: an explicit .focus() IS reported by the same reader that reports null below', `active ${r.activeId}`);
await blur();
/** A no-focus claim, refused rather than passed when the browser never grabs. */
const okFocus = (cond, msg, extra = '') => {
  if (!GRABS) { blocked++; fails++; console.log(`BLOCKED  ${msg}   [M1 red: this Chrome never took focus on the broken mimic, so a null activeElement says nothing] — not evaluated`); return false; }
  return ok(cond, msg, extra);
};

/* ==========================================================================
   F — A REFUSED PRESS MUST NOT FOCUS THE CONTROL.
   BRANCH: the `e.preventDefault()` first line in bindPress/pointerdown,
   jumpBtn/pointerdown and the stick's down(), on the path where
   `secondary(e)` is TRUE — i.e. preventDefault runs and THEN the gate
   returns. All four secondary buttons on all seven controls.
   ========================================================================== */
console.log('\n--- F: a refused secondary press focuses nothing ---');
/* ==========================================================================
   THE BACK BUTTON REALLY DOES NAVIGATE, AND preventDefault DOES NOT STOP IT.
   The first run of this section died with "WALLY is not defined" after the
   main frame went to about:blank: mouse button 3 is an app command Chrome
   handles above the page, so the pad's preventDefault — which genuinely
   stops the FOCUS default — cannot stop the history move. Destroying the
   document mid-suite would make every later reading a silent zero.

   So the fixture pushes same-document history entries in front of the run.
   A back press then still performs its navigation (the behaviour is
   measured, not suppressed: popstate is counted and reported below) but it
   moves WITHIN this document, so the context, the listeners and the game
   survive and the pad's own handling is exercised exactly as before.
   ========================================================================== */
await page.evaluate(() => {
  window.__pops = 0;
  addEventListener('popstate', () => { window.__pops++; });
  for (let i = 0; i < 80; i++) history.pushState({ pad: i }, '');
});
const SECOND = ['right', 'middle', 'back', 'forward'];
const fRows = [];
for (const c of CTLS) {
  for (const b of SECOND) {
    await closeAll();
    await reset();
    await mousePress(c.x, c.y, b, 70);
    await page.waitForTimeout(220);
    const rr = await read();
    const reached = rr.ev.some(e => e.t === 'pointerdown' && e.on === c.k && e.b === BTNNO[b]);
    fRows.push({ ctl: c.k, btn: b, reached, armed: rr.arm.some(a => a.el === c.k && a.on),
      inPad: rr.inPad, ctlFocus: rr.ctl, active: rr.active,
      focusinPad: rr.focusin.filter(f => f.inPad), verbs: rr.verbs, panels: rr.panels });
  }
}
const notReached = fRows.filter(f => !f.reached);
ok(notReached.length === 0,
  `F0 [setup — the press must actually land on the control, or the null below is about nothing]: all ${fRows.length} secondary presses (7 controls x right/middle/back/forward) reached their control's own pointerdown`,
  notReached.length ? JSON.stringify(notReached.map(f => [f.ctl, f.btn])) : 'all 28 landed');
const armedAny = fRows.filter(f => f.armed);
ok(armedAny.length === 0,
  'F1 [BRANCH the gate itself, all 4 secondary buttons x 7 controls]: not one refused press armed its control — the gate still refuses middle, right, back and forward everywhere',
  armedAny.length ? JSON.stringify(armedAny.map(f => [f.ctl, f.btn])) : '0 of 28 armed');
const focused = fRows.filter(f => f.inPad || f.focusinPad.length);
okFocus(focused.length === 0,
  'F2 [BRANCH preventDefault ABOVE the gate — THE FIX]: after every one of the 28 refused presses, nothing in the pad is focused and no focusin ever fired inside it',
  focused.length ? JSON.stringify(focused.map(f => [f.ctl, f.btn, f.active, f.focusinPad])) : 'activeElement outside .w-touch 28/28, focusin-in-pad 0');
const ranVerb = fRows.filter(f => f.verbs.length || f.panels.length);
ok(ranVerb.length === 0, 'F3 [BRANCH the gate, game state]: no refused press ran a verb or opened a panel',
  ranVerb.length ? JSON.stringify(ranVerb.map(f => [f.ctl, f.btn, f.verbs, f.panels])) : 'verbs [] panels [] on all 28');
const pops = await page.evaluate(() => window.__pops);
const docNow = await docId();
ok(docNow === DOC0 && docNow !== null,
  'F4 [the document survived]: the token minted when the probe was installed is still in the page, so all 28 readings above came from the probe that was installed for them — not from a silent zero after a reload',
  `doc ${DOC0} -> ${docNow}, same-document history moves ${pops}, framenavigated events ${navs} (same-document moves fire this too)`);
console.log(`   NOTE  the back/forward presses performed ${pops} same-document history moves. preventDefault() on pointerdown stops the FOCUS default but does NOT stop Chrome's back/forward app command — the pad refuses the verb (F1/F3) and cannot refuse the navigation. Harmless on a touch device, which has no such button; noted rather than asserted.`);

/* ==========================================================================
   S — SPACE IS STILL JUMP AFTER A REFUSAL.
   BRANCH: wally.js keydown -> keys.Space -> controller jump, WITH the pad's
   detail-0 click listener NOT entered. Measured as PEAK VERTICAL VELOCITY
   and height gained, never as a handler count: a handler count cannot tell a
   jump from a button that merely heard something.
   ========================================================================== */
console.log('\n--- S: the keystroke after a refusal ---');
/* S0 — the discriminator, and it runs FIRST. If a pad button holding focus
   did NOT steal Space, then S1's green would be free. This is the theft,
   reproduced deliberately. */
await toOpenGround();
await reset();
await page.evaluate(() => document.querySelector('.w-acts .shortcuts .w-abtn').focus());
await key('Space', { text: ' ' });
await page.waitForTimeout(400);
r = await read();
const STEALABLE = r.verbs.length > 0 || r.panels.length > 0;
ok(STEALABLE,
  'S0 [THE DISCRIMINATOR — deliberately reproduced theft]: with a shortcut button focused, Space runs THAT BUTTON\'S verb (detail-0 click). So "Space still jumps" below is a claim that can fail',
  `verbs ${JSON.stringify(r.verbs)}, panels ${JSON.stringify(r.panels)}`);
await closeAll();
/* S1 — right press on a shortcut, then Space. */
await toOpenGround();
await reset();
await mousePress(SC[0].x, SC[0].y, 'right', 70);
await page.waitForTimeout(250);
const preS1 = await read();
await keyDown('Space');
const airS1 = await airborne(1800);
await keyUp('Space');
await page.waitForTimeout(300);
r = await read();
ok(preS1.ev.some(e => e.t === 'pointerdown' && e.on === 'sc0' && e.b === 2) && !preS1.inPad,
  'S1a [setup]: the right press really landed on the Phone shortcut and left nothing in the pad focused',
  `active ${preS1.active}, ctl ${preS1.ctl}`);
ok(airS1.vy > 1.5 && airS1.air === true,
  `S1 [BRANCH wally.js keys.Space -> jump, after a refused press]: Space still jumps — peak vy ${airS1.vy}, rose ${airS1.rise} m, left the ground`,
  JSON.stringify(airS1));
okFocus(r.verbs.length === 0 && !r.panels.includes('phone'),
  'S1b [BRANCH bindPress click detail-0 NOT entered]: that same Space did not open the Phone — the keystroke was not rebound to the button the refused press touched',
  `verbs ${JSON.stringify(r.verbs)}, panels ${JSON.stringify(r.panels)}`);
/* S2 — the same for Jump itself, the control the defect note measured. */
await toOpenGround();
await reset();
await mousePress(JUMP.x, JUMP.y, 'right', 70);
await page.waitForTimeout(250);
const preS2 = await read();
await keyDown('Space');
const airS2 = await airborne(1800);
await keyUp('Space');
ok(preS2.ev.some(e => e.t === 'pointerdown' && e.on === 'jump' && e.b === 2) && !preS2.inPad && preS2.grounded === true,
  'S2a [setup]: a right press landed on Jump, focused nothing, and he was still on the ground', `active ${preS2.active}, grounded ${preS2.grounded}`);
ok(airS2.vy > 1.5 && airS2.air === true,
  `S2 [BRANCH the same, on Jump]: Space after a refused press on Jump still jumps — peak vy ${airS2.vy}, rose ${airS2.rise} m`, JSON.stringify(airS2));
/* S3 — the refused press itself must not have jumped him (positive control
   the other way: S2's jump has to come from the KEY, not the press). */
await toOpenGround();
await reset();
await mousePress(JUMP.x, JUMP.y, 'right', 300);
const airS3 = await airborne(900);
ok(airS3.air === false && airS3.vy < 0.8,
  `S3 [the other-way control]: the refused press on its own never leaves the ground (peak vy ${airS3.vy}) — so S2's jump is the Space key, not the press`, JSON.stringify(airS3));

/* ==========================================================================
   E — THE PAD'S ENTER STILL INTERACTS AFTER A REFUSAL.
   BRANCH: bindPress `end` on the PRIMARY path, reached only if the refused
   press left nothing in `pressing` (it returns before pressing.set) — a
   refusal that stuck would make the button dead for the session.
   ========================================================================== */
console.log('\n--- E: the Enter button after a refusal ---');
/* THE DOOR PRECONDITION IS A GATE, NOT A NOTE — the previous judge's rule,
   kept: Enter at a door with a dialogue card up takes interact()'s
   DIALOGUE-ADVANCE branch, not its DOOR branch, and a suite that measures
   the wrong branch is worse than one that fails. :not(.out) because
   dialogue.js's close() leaves the node in the DOM for 280 ms. */
const doorState = () => page.evaluate(() => ({
  near: WALLY.ctx.ui.near?.id ?? null,
  dlgOpen: !!WALLY.ctx.ui.dialogueOpen,
  card: !!document.querySelector('.w-dlg:not(.out)'),
  panels: WALLY.ctx.ui.panels.slice(),
  modal: !!WALLY.ctx.ui.modal,
}));
let doorOK = false, doorInfo = null;
async function toDoor() {
  await flushKeys();
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.arrive('apartment', true); });
  let near = null;
  for (let i = 0; i < 40 && !near; i++) {
    await page.waitForTimeout(200);
    near = await page.evaluate(() => WALLY.ctx.ui.near?.id ?? null);
  }
  await page.evaluate(() => { WALLY.ctx.ui.hide('dialogue'); WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); });
  await page.waitForTimeout(600);
  doorInfo = await doorState();
  doorOK = doorInfo.near !== null && !doorInfo.dlgOpen && !doorInfo.card
    && doorInfo.panels.length === 0 && !doorInfo.modal;
  return doorOK;
}
const okDoor = (cond, msg, extra = '') => {
  if (!doorOK) { blocked++; fails++; console.log(`BLOCKED  ${msg}   [door precondition dirty: ${JSON.stringify(doorInfo)}] — not evaluated`); return false; }
  return ok(cond, msg, extra);
};
await toDoor();
ok(doorOK, 'E-GATE: at a door with no card and no panel up — so the Enter button\'s verb is interact()\'s DOOR branch', JSON.stringify(doorInfo));
if (doorOK) {
  await reset();
  await mousePress(ACT.x, ACT.y, 'right', 70);       // refuse
  await page.waitForTimeout(250);
  const midE = await read();
  await mousePress(ACT.x, ACT.y, 'left', 90);        // then the real thing
  await page.waitForTimeout(700);
  r = await read();
  okDoor(!midE.arm.some(a => a.el === 'act' && a.on) && !midE.inPad,
    'E0 [setup]: the right press on Enter was refused and focused nothing', `active ${midE.active}`);
  okDoor(r.arm.some(a => a.el === 'act' && a.on) && r.verbs.includes('interact') && r.panels.length > 0,
    'E1 [BRANCH bindPress end, primary, straight after a refusal]: the Enter button still arms and still opens the door — the refused press did not leave it stuck in `pressing`',
    `arm ${JSON.stringify(r.arm)}, verbs ${JSON.stringify(r.verbs)}, panels ${JSON.stringify(r.panels)}`);
  await closeAll();
} else {
  okDoor(true, 'E1 [BRANCH bindPress end, primary after refusal]');
}

/* ==========================================================================
   T — THE ASSISTIVE PATH, REACHED BY A GENUINE TAB.
   BRANCH: `bind(btn,'click', e => { if (e.detail === 0) run(); })`. The
   previous judge reached it with el.focus(); a real Tab additionally proves
   the button is in the tab order, which is the thing a screen-reader user
   actually has. Both Space AND Enter, on every focusable control.
   ========================================================================== */
console.log('\n--- T: Tab, then Space / Enter — the path that is SUPPOSED to work ---');
const FOCUSABLE = CTLS.filter(c => c.k !== 'stick');
async function tabTo(k) {
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.evaluate(() => document.body.focus?.());
  for (let i = 0; i < 40; i++) {
    await key('Tab');
    const hit = await page.evaluate((kk) => (document.activeElement === window.__fEls[kk]), k);
    if (hit) return i + 1;
  }
  return 0;
}
const tRows = [];
for (const c of FOCUSABLE) {
  for (const kc of ['Space', 'Enter']) {
    await toOpenGround();
    const steps = await tabTo(c.k);
    await reset();
    let air = null;
    if (c.k === 'jump') { await key(kc, { text: kc === 'Space' ? ' ' : '\r' }); air = await airborne(1600); }
    else { await key(kc, { text: kc === 'Space' ? ' ' : '\r' }); await page.waitForTimeout(600); }
    const rr = await read();
    const acted = c.k === 'jump' ? (air.air === true || air.vy > 1.5) : (rr.verbs.length > 0 || rr.panels.length > 0);
    tRows.push({ ctl: c.k, key: kc, steps, acted, verbs: rr.verbs, panels: rr.panels, air,
      clicks: rr.ev.filter(e => e.t === 'click').map(e => [e.on, e.d]) });
    await closeAll();
  }
}
const unreached = tRows.filter(t => t.steps === 0);
ok(unreached.length === 0,
  `T0 [setup — a GENUINE Tab, not el.focus()]: all ${FOCUSABLE.length} pad buttons are reachable in the real tab order`,
  JSON.stringify(tRows.filter(t => t.key === 'Space').map(t => [t.ctl, t.steps + ' tabs'])));
const dead = tRows.filter(t => !t.acted);
ok(dead.length === 0,
  'T1 [BRANCH bindPress/jump click, detail 0 — the AT path, deliberately kept]: every pad button, reached by a real Tab, still activates on BOTH Space and Enter',
  dead.length ? JSON.stringify(dead.map(t => [t.ctl, t.key, t.verbs, t.panels, t.air])) : `${tRows.length}/${tRows.length} activated`);
const wrongDetail = tRows.filter(t => t.clicks.some(c => c[1] !== 0));
ok(wrongDetail.length === 0,
  'T2 [BRANCH the detail test itself]: every activation arrived as a click with detail 0 — the AT shape, not a synthesised pointer',
  JSON.stringify(tRows.map(t => [t.ctl, t.key, t.clicks])));

/* ==========================================================================
   J — TWO THUMBS ON JUMP. BOTH LIFT ORDERS, and the branch is
   `if (jumpId !== null) return` on the second pointerdown plus `jumpOwns`
   in jumpEnd. BOTH orders are run because entering only the order that
   works is how this project has been fooled before.
   ========================================================================== */
console.log('\n--- J: two thumbs on Jump ---');
const jumpDown = () => page.evaluate(() => document.querySelector('.w-acts .w-abtn.jump').classList.contains('down'));
/* touchState().jump is {held, id} — the held flag AND WHICH CONTACT OWNS IT.
   The id is the half that tells "he let go" from "the wrong finger let go
   for him", which is the entire question in this section. */
const heldFlag = () => page.evaluate(() => WALLY.debug.touchState?.().jump ?? null);
/* J-BASE: the variable-height reference, ONE thumb. A short hold and a long
   hold must differ, or "variable jump height survives" is unmeasurable. */
async function oneThumb(holdMs) {
  await toOpenGround();
  await reset();
  await multi('touchStart', [P(JUMP.x, JUMP.y, 21)]);
  const t0 = Date.now();
  const poll = airborne(1800);
  await page.waitForTimeout(holdMs);
  await multi('touchEnd', [P(JUMP.x, JUMP.y, 21)]);
  const a = await poll;
  return { ...a, held: Date.now() - t0 };
}
const shortJ = await oneThumb(60);
const longJ = await oneThumb(420);
const VARIABLE = longJ.rise > shortJ.rise + 0.05;
ok(VARIABLE,
  `J0 [setup/discriminator — variable jump height is real and measurable]: one thumb, 60 ms vs 420 ms, rise ${shortJ.rise} m vs ${longJ.rise} m`,
  JSON.stringify({ shortJ, longJ }));
/* J1 — ORDER A: second thumb lands, SECOND lifts first. The resting thumb
   must not cancel the held jump. */
await toOpenGround();
await reset();
await multi('touchStart', [P(JUMP.x, JUMP.y, 31)]);
const pollA = airborne(1900);
await page.waitForTimeout(50);
await multi('touchStart', [P(JUMP.x, JUMP.y, 31), P(JUMP.x + 6, JUMP.y + 6, 32)]);   // second thumb
await page.waitForTimeout(60);
const bothA = { down: await jumpDown(), held: await heldFlag() };
await multi('touchEnd', [P(JUMP.x + 6, JUMP.y + 6, 32)]);                             // SECOND lifts
await page.waitForTimeout(70);
const afterSecondA = { down: await jumpDown(), held: await heldFlag() };
await page.waitForTimeout(290);
await multi('touchEnd', [P(JUMP.x, JUMP.y, 31)]);                                     // owner lifts
const airA = await pollA;
await page.waitForTimeout(200);
const restA = { down: await jumpDown(), held: await heldFlag() };
r = await read();
const idsA = [...new Set(r.ev.filter(e => e.t === 'pointerdown').map(e => e.id))];
ok(r.ev.filter(e => e.t === 'pointerdown' && e.on === 'jump').length >= 2 && idsA.length >= 2,
  'J1a [setup — MEASURING THE RIGHT CONTACT]: two DISTINCT pointerdowns really reached Jump, so the second contact existed',
  JSON.stringify(r.ev.filter(e => e.on === 'jump').map(e => [e.t, e.id, e.b])));
/* THE POINTER ID IS THE BROWSER'S, NOT THE CDP TOUCH ID. Dispatching touch
   points 31 and 32 produced pointerIds 4 and 5, so an assertion written
   against 31 fails while the pad is behaving perfectly — and, worse, one
   written against the wrong id could PASS for the wrong contact. The owner
   is therefore read back out of the event log rather than assumed. */
const downsA = r.ev.filter(e => e.t === 'pointerdown' && e.on === 'jump');
const firstIdA = downsA[0]?.id, secondIdA = downsA[1]?.id;
ok(firstIdA != null && secondIdA != null && firstIdA !== secondIdA && bothA.held?.id === firstIdA,
  `J1a2 [MEASURING THE RIGHT CONTACT]: Jump is owned by pointerId ${firstIdA}, the FIRST contact, with ${secondIdA} resting on it — so the lift below really is the non-owner's`,
  JSON.stringify({ firstIdA, secondIdA, bothA }));
ok(afterSecondA.down === true && afterSecondA.held?.held === true && afterSecondA.held?.id === firstIdA,
  `J1 [BRANCH jumpEnd -> jumpOwns false, the non-owner release]: the SECOND thumb lifting left Jump still held BY THE ORIGINAL CONTACT (${firstIdA}) — a resting thumb does not cancel a held jump`,
  JSON.stringify({ bothA, afterSecondA }));
ok(restA.down === false,
  'J1b [the discriminator]: the OWNER lifting does release it — J1 is a pointerId test, not a button that cannot be let go',
  JSON.stringify(restA));
ok(airA.rise > shortJ.rise + 0.05,
  `J1c [BRANCH the held rise survives]: the two-thumb hold still produced the LONG jump (rise ${airA.rise} m vs the 60 ms reference ${shortJ.rise} m) — variable height survived the second contact`,
  JSON.stringify(airA));
/* J2 — ORDER B: OWNER lifts first, second thumb still resting. The jump must
   cut at the owner's lift (variable height), and the resting thumb must not
   re-trigger or hold it. */
await toOpenGround();
await reset();
await multi('touchStart', [P(JUMP.x, JUMP.y, 41)]);
const pollB = airborne(1900);
await page.waitForTimeout(40);
await multi('touchStart', [P(JUMP.x, JUMP.y, 41), P(JUMP.x + 6, JUMP.y + 6, 42)]);
await page.waitForTimeout(30);
await multi('touchEnd', [P(JUMP.x, JUMP.y, 41)]);                                     // OWNER lifts first
await page.waitForTimeout(80);
const afterOwnerB = { down: await jumpDown(), held: await heldFlag() };
await page.waitForTimeout(400);
const stillB = { down: await jumpDown(), held: await heldFlag() };
await multi('touchEnd', [P(JUMP.x + 6, JUMP.y + 6, 42)]);
const airB = await pollB;
r = await read();
ok(r.ev.filter(e => e.t === 'pointerdown' && e.on === 'jump').length >= 2,
  'J2a [setup]: both contacts reached Jump in this order too',
  JSON.stringify(r.ev.filter(e => e.on === 'jump').map(e => [e.t, e.id])));
ok(afterOwnerB.down === false && stillB.down === false && afterOwnerB.held?.id === null,
  'J2 [BRANCH the owner\'s release, with a non-owner still down]: the owner lifting DID release Jump (jumpId back to null) and the resting second thumb neither kept it held nor re-took it',
  JSON.stringify({ afterOwnerB, stillB }));
ok(airB.rise < longJ.rise - 0.03 || airB.rise <= shortJ.rise + 0.12,
  `J2b [BRANCH the cut is real]: releasing early cut the rise (${airB.rise} m) well short of the 420 ms hold (${longJ.rise} m) — the second thumb did not extend it`,
  JSON.stringify({ airB, shortJ: shortJ.rise, longJ: longJ.rise }));

/* ==========================================================================
   P — THE POSITIVE HALF. Primary still works on all seven.
   ========================================================================== */
console.log('\n--- P: primary still works on all seven ---');
const pRows = [];
for (const c of FOCUSABLE) {
  await toOpenGround();
  await reset();
  let air = null;
  await mousePress(c.x, c.y, 'left', 120);
  if (c.k === 'jump') air = await airborne(1600); else await page.waitForTimeout(650);
  const rr = await read();
  const armed = rr.arm.some(a => a.el === c.k && a.on);
  const acted = c.k === 'jump' ? (air.air || air.vy > 1.5) : (rr.verbs.length > 0 || rr.panels.length > 0);
  pRows.push({ ctl: c.k, armed, acted, verbs: rr.verbs, panels: rr.panels, air });
  await closeAll();
}
/* the stick, measured as movement rather than a panel */
await toOpenGround();
await reset();
const pos0 = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, z: p.z }; });
await mouse('mouseMoved', STICK.x, STICK.y);
await mouse('mousePressed', STICK.x, STICK.y, 'left', 1);
for (let i = 1; i <= 5; i++) { await mouse('mouseMoved', STICK.x, STICK.y - i * 18, 'left', 1); await page.waitForTimeout(35); }
await page.waitForTimeout(700);
const stickLive = await read();
const pos1 = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, z: p.z }; });
await mouse('mouseReleased', STICK.x, STICK.y - 90, 'left', 0);
const moved = +Math.hypot(pos1.x - pos0.x, pos1.z - pos0.z).toFixed(2);
const padDead = pRows.filter(p => !p.armed || !p.acted);
ok(padDead.length === 0,
  'P1 [BRANCH every control\'s PRIMARY path — THE IMPORTANT HALF]: a left press arms and fires all six pad buttons. A pad that refused everything would pass every negative above',
  padDead.length ? JSON.stringify(padDead) : JSON.stringify(pRows.map(p => [p.ctl, p.panels.length ? p.panels : (p.air ? 'vy ' + p.air.vy : 'ok')])));
ok(stickLive.arm.some(a => a.el === 'stick' && a.on) && stickLive.stick > 0.5 && moved > 0.5,
  `P2 [BRANCH stick down(), primary]: the seventh control still works — stick t ${stickLive.stick}, he covered ${moved} m`,
  JSON.stringify({ pos0, pos1 }));
await mouse('mouseReleased', STICK.x, STICK.y - 90, 'left', 0);
await page.waitForTimeout(400);

/* ==========================================================================
   W — WALKING ON THE STICK, THEN THE ENTER BUTTON, STILL OPENS THE DOOR.
   Two contacts, different controls, the stick's one still down.
   ========================================================================== */
console.log('\n--- W: walking + Enter ---');
/* BACK TO A DOOR FIRST. The P section warps him to open ground and walks him
   4.8 m, so the door fixture from E is long gone by here — the first run of
   this section pressed Enter with near null, interact() ran its no-door
   branch and opened nothing, and W1 failed for a reason that had nothing to
   do with the stick. Re-established, and re-gated below AFTER the walk,
   because the walk itself can carry him out of range. */
await toDoor();
if (doorOK) {
  await reset();
  await multi('touchStart', [P(STICK.x, STICK.y, 51)]);
  await page.waitForTimeout(60);
  await multi('touchMove', [P(STICK.x + 4, STICK.y - 22, 51)]);
  await page.waitForTimeout(60);
  await multi('touchMove', [P(STICK.x + 5, STICK.y - 30, 51)]);
  await page.waitForTimeout(140);
  const walkW = await page.evaluate(() => +(WALLY.debug.touchState().t ?? 0).toFixed(2));
  const nearW = await doorState();
  await multi('touchStart', [P(STICK.x + 6, STICK.y - 48, 51), P(ACT.x, ACT.y, 52)]);
  await page.waitForTimeout(90);
  await multi('touchEnd', [P(ACT.x, ACT.y, 52)]);
  await page.waitForTimeout(700);
  r = await read();
  await multi('touchEnd', [P(STICK.x + 6, STICK.y - 48, 51)]);
  doorInfo = nearW; doorOK = nearW.near !== null && !nearW.card && nearW.panels.length === 0;
  okDoor(walkW > 0.3 && nearW.near !== null,
    `W0 [setup]: he really was walking on the stick (t ${walkW}) and really was at a door when Enter was pressed`,
    JSON.stringify({ walkW, near: nearW.near }));
  okDoor(r.verbs.includes('interact') && r.panels.length > 0,
    'W1 [BRANCH bindPress end while the stick owns another contact]: walking on the stick and pressing Enter still opens the door',
    `verbs ${JSON.stringify(r.verbs)}, panels ${JSON.stringify(r.panels)}, arm ${JSON.stringify(r.arm)}`);
  await closeAll();
} else {
  okDoor(true, 'W1 [BRANCH stick held + Enter opens the door]');
}

/* ==========================================================================
   X — THE PEN ERASER CARVE-OUT. Arithmetic only, and it says so.
   CDP's mouse button enum has no eraser (none/left/middle/right/back/
   forward), so button 5 CANNOT be delivered as a trusted event from this
   harness. The branch is exercised with a synthesised PointerEvent, which
   proves the ARITHMETIC of `secondary()` and nothing about hardware.
   ========================================================================== */
console.log('\n--- X: the pen eraser carve-out (synthetic — arithmetic only) ---');
const eraser = await page.evaluate(() => {
  const f = (btn, pt) => {
    let refused = null;
    const sec = (e) => e.button > 0 && !(e.button === 5 && e.pointerType === 'pen');
    const el = document.createElement('button'); document.body.appendChild(el);
    el.addEventListener('pointerdown', (e) => { refused = sec(e); }, false);
    el.dispatchEvent(new PointerEvent('pointerdown', { button: btn, pointerType: pt, bubbles: true, cancelable: true }));
    el.remove();
    return refused;
  };
  return { penTip: f(0, 'pen'), penBarrel: f(2, 'pen'), penEraser: f(5, 'pen'),
    mouseEraserNo: f(5, 'mouse'), touch0: f(0, 'touch'), mouseRight: f(2, 'mouse') };
});
ok(eraser.penEraser === false && eraser.penTip === false && eraser.penBarrel === true
  && eraser.mouseEraserNo === true && eraser.touch0 === false && eraser.mouseRight === true,
  'X1 [BRANCH secondary(), the PEN_ERASER carve-out — SYNTHETIC, arithmetic only]: a pen ERASER (button 5, pointerType pen) is treated as a contact; a pen BARREL (2) is refused; the carve-out does not leak to a mouse claiming button 5',
  JSON.stringify(eraser));
console.log('   NOTE  X1 is a synthesised PointerEvent. CDP cannot deliver button 5, so nothing here is evidence about a real pen. Untrusted events also do not perform the focus default, so X1 says NOTHING about the focus grab for a pen.');

console.log('\nLOAD AT END    ' + execSync('uptime').toString().trim());
console.log(`\n${fails === 0 ? 'ALL GREEN' : fails + ' FAILURE(S)'}${blocked ? ' (' + blocked + ' blocked)' : ''}`);
await browser.close();
server.close();
process.exit(fails ? 1 : 0);
