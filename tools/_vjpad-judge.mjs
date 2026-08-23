/* _vjpad-judge.mjs — INDEPENDENT verification of the pad's primary-button
   gate. Not a copy of touchtest.mjs: every effect is measured twice, once
   at the CONTROL (the 'down'/'live' class touch.js's own handler adds, via
   a MutationObserver — handler entry past the guard) and once in GAME
   STATE (panels, position, controller velocity, stick axes).

   Positive controls are half the run: a pad that refuses everything passes
   every negative. */
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

/* EVERY NUMBER IN THIS FILE IS TAKEN AT A LOAD, AND THE LOAD IS PRINTED.
   Two rounds running have had assertions fail under load and pass on a
   quiet box, and one judge was handed a run at load 579 where baseline
   assertions failed. A red with no load beside it is not a report. */
console.log('LOAD AT START  ' + execSync('uptime').toString().trim());
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
let fails = 0;
const ok = (cond, msg, extra = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '   ' + extra : ''}`);
  return cond;
};

const ctxMobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctxMobile.newPage();
page.on('pageerror', e => { console.log('PAGEERROR', e.message.split('\n')[0]); fails++; });
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
/* THE THIRD ARGUMENT. waitForFunction's signature is (fn, ARG, options)
   — the two-argument form this file used passed the options object as
   the page ARGUMENT and silently kept the 30 s default. Boot here is now
   ~35 s (the wally mesh build alone logs 26.5 s under swiftshader;
   src/character/wally.js belongs to another workflow), so the whole
   suite died at this line before one assertion ran. Same trap
   tools/touchtest.mjs documents at its own boot. */
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(3500);
const cdp = await ctxMobile.newCDPSession(page);

await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.hideUI(false); });
await page.waitForTimeout(600);

const st0 = await page.evaluate(() => WALLY.debug.touchState());
ok(st0.enabled, 'boot: touch controls auto-enabled at 390x844 hasTouch/isMobile', JSON.stringify(st0));

/* ---------------- the probe ---------------- */
await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const els = {
    act: q('.w-acts .w-abtn.act'),
    jump: q('.w-acts .w-abtn.jump'),
    stick: q('.w-stick'),
  };
  [...document.querySelectorAll('.w-acts .shortcuts .w-abtn')].forEach((b, i) => {
    els['sc' + i] = b;
  });
  window.__jEls = els;
  window.__jReset = () => {
    window.__J = { arm: [], ev: [], menus: [], verbs: [], toasts: [] };
  };
  window.__jReset();
  if (window.__jOn) return;
  window.__jOn = true;
  /* HANDLER ENTRY, AT THE REAL ELEMENT. touch.js adds 'down' to a pad
     button inside its own pointerdown handler, below the guard, and
     'live' to the stick inside down(). If the class never lands, the
     handler body never ran. Nothing here is inferred from game state. */
  const mo = new MutationObserver((recs) => {
    for (const r of recs) {
      const name = Object.keys(window.__jEls).find((k) => window.__jEls[k] === r.target);
      const cl = r.target.classList;
      const on = name === 'stick' ? cl.contains('live') : cl.contains('down');
      const last = window.__J.arm.filter((a) => a.el === name).pop();
      if (!last || last.on !== on) window.__J.arm.push({ el: name, on, t: Math.round(performance.now()) });
    }
  });
  for (const k of Object.keys(window.__jEls)) {
    if (window.__jEls[k]) mo.observe(window.__jEls[k], { attributes: true, attributeFilter: ['class'] });
  }
  const desc = (t) => !t ? null : (t.id || (t.tagName.toLowerCase() + '.' + String(t.className?.baseVal ?? t.className ?? '').trim().split(/\s+/).join('.')));
  for (const t of ['pointerdown', 'pointerup', 'click', 'auxclick']) {
    document.addEventListener(t, (e) => {
      window.__J.ev.push({ type: e.type, target: desc(e.target), button: e.button, detail: e.detail,
        /* THE GESTURE HAS TO BE MEASURED, NOT ASSUMED. touch.js judges a
           double tap on wall-clock gap, contact duration and travel
           (TAP_GAP / TAP_MS / TAP_DIST). On a loaded machine a 70 ms
           script gap arrives as 900 ms, and every wake assertion then
           fails for a reason that has nothing to do with the pad. These
           three fields let the suite read back what was really
           delivered and refuse to judge a fixture that never was one. */
        ts: Math.round(e.timeStamp), x: Math.round(e.clientX || 0), y: Math.round(e.clientY || 0),
        inPad: !!e.target.closest?.('.w-touch'),
        onCtl: Object.keys(window.__jEls).find((k) => window.__jEls[k]?.contains?.(e.target)) || null });
    }, true);
  }
  document.addEventListener('contextmenu', (e) => {
    window.__J.menus.push({ target: desc(e.target), inPad: !!e.target.closest?.('.w-touch'), prevented: e.defaultPrevented });
  }, false);
  /* THE VERB. touch.js calls these api properties; the game's keyboard
     handlers call module-local functions, so only the pad lands here. */
  const u = WALLY.ctx.ui;
  const wrap = (k) => { const o = u[k].bind(u); u[k] = (...a) => { window.__J.verbs.push(k); return o(...a); }; };
  ['interact', 'openPhone', 'openDesk', 'show'].forEach(wrap);
  const ot = u.toast.bind(u);
  u.toast = (...a) => { window.__J.toasts.push(String(a[0])); return ot(...a); };
});

const reset = () => page.evaluate(() => window.__jReset());
const read = () => page.evaluate(() => ({
  arm: window.__J.arm, menus: window.__J.menus, verbs: window.__J.verbs, toasts: window.__J.toasts,
  /* `tg` (the target's own description) is carried through because X2
     needs to say WHERE a refused press actually landed, not only that
     it did not land on the control. */
  ev: window.__J.ev.map((e) => ({ t: e.type, b: e.button, d: e.detail, on: e.onCtl, inPad: e.inPad, tg: e.target, ts: e.ts, x: e.x, y: e.y })),
  panels: WALLY.ctx.ui.panels.slice(),
  stick: +(WALLY.debug.touchState().t ?? 0),
  pos: (() => { const p = WALLY.ctx.wally.position; return { x: +p.x.toFixed(2), z: +p.z.toFixed(2) }; })(),
  vy: +WALLY.ctx.wally.controller.velocity.y.toFixed(2),
  grounded: WALLY.ctx.wally.controller.grounded,
}));
/* ============================================================
   THE FIXTURE GATE FOR GESTURES, and it is the same idea as DOORGATE.

   touch.js judges a double tap on three numbers it owns — TAP_GAP 300
   ms between tap one's release and tap two's landing, TAP_MS 400 ms per
   contact, TAP_DIST 44 px between the landings. Every one of them is
   WALL CLOCK, and this machine runs three other browser suites at a
   load average north of 300: a scripted 70 ms gap was measured arriving
   as a second and a half. Under that, `wakes === before + 1` fails
   because no double tap was ever delivered — a red that says nothing
   about the pad, in a file whose whole purpose is to say something
   about the pad.

   So the gesture is READ BACK from the probe's own event log and judged
   by touch.js's numbers before any wake claim is evaluated. Not
   delivered as a double tap -> BLOCKED, with the measured gap printed,
   never a silent pass and never a misattributed fail. wakeAttempt()
   retries a handful of times first, because a delivery this suite can
   control is better than an excuse.

   NOTE WHICH DIRECTION THIS CUTS. It gates the FIXTURE, not the
   outcome: a gesture that WAS delivered inside all three gates and did
   not wake the pad is a real failure and is reported as one. K3 (one
   press must not wake) stays outside it — that fixture is a single
   press and cannot fail to be one.
   ============================================================ */
const TAP_GAP = 300, TAP_DIST = 44, TAP_MS = 400;      // touch.js's own numbers
function gestureOf(r) {
  const downs = r.ev.filter((e) => e.t === 'pointerdown');
  const ups = r.ev.filter((e) => e.t === 'pointerup');
  if (downs.length < 2 || ups.length < 2) {
    return { ok: false, why: `only ${downs.length} pointerdown / ${ups.length} pointerup delivered` };
  }
  const hold1 = ups[0].ts - downs[0].ts, hold2 = ups[1].ts - downs[1].ts;
  const gap = downs[1].ts - ups[0].ts;
  const dist = Math.round(Math.hypot(downs[1].x - downs[0].x, downs[1].y - downs[0].y));
  const ok = gap >= 0 && gap <= TAP_GAP && hold1 <= TAP_MS && hold2 <= TAP_MS && dist <= TAP_DIST;
  return { ok, hold1, hold2, gap, dist, buttons: downs.slice(0, 2).map((d) => d.b),
    why: ok ? '' : `gap ${gap}ms (TAP_GAP ${TAP_GAP}), holds ${hold1}/${hold2}ms (TAP_MS ${TAP_MS}), ${dist}px apart (TAP_DIST ${TAP_DIST})` };
}
/** Fade, then deliver a double press; retry until the browser actually
    delivers one inside touch.js's gates. `after2` runs between the
    second release and the settle, for the one caller that needs to
    press something during the fade-in. */
async function wakeAttempt(mode, button, x, y, { tries = 5, sec = 0.5, after2 = null, accept = null } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const before = await goFaded(sec);
    if (!before.hidden) {
      /* say WHY it did not fade. `moving` true is the character, not the
         pad: the idle clock takes movement as presence, so a body still
         sliding after a warp holds the fade off indefinitely and every
         wake assertion below it is unmeasurable rather than wrong. */
      last = { before, g: { ok: false, why: 'the pad never faded: ' + JSON.stringify({ hidden: before.hidden, why: before.why, moving: before.moving, t: before.t }) } };
      continue;
    }
    const domBefore = await padDom();
    await reset();
    if (mode === 'mouse') { await mousePress(x, y, button, 40); await page.waitForTimeout(70); await mousePress(x, y, button, 40); }
    else { await tap(x, y, 50); await page.waitForTimeout(70); await tap(x, y, 50); }
    const extra = after2 ? await after2() : null;
    /* STOP THE CLOCK BEFORE MEASURING THE WAKE. goFaded runs a 0.5 s
       window and that window keeps running after the wake — measured
       directly in tools/_vjpad-drift2.mjs: one second after a committed
       double click the pad had faded again (hidden true, wakes 1). Every
       reading below would then be racing a second fade and
       `hidden === false` would be a coin toss rather than a claim. The
       long window changes nothing about whether the wake happened; it
       only stops the next fade. */
    await page.evaluate(() => WALLY.debug.idle(60));
    await page.waitForTimeout(900);
    const r = await read();
    last = { before, domBefore, r, extra, tries: i + 1, after: await idleGet(), dom: await padDom(), g: gestureOf(r) };
    if (last.g.ok && (!accept || accept(last))) break;
  }
  return last;
}
/** An assertion that depends on a double gesture having been delivered
    as one. Blocked, not green and not red, when it was not. */
const okTap = (a, cond, msg, extra = '') => {
  if (!a || !a.g.ok) {
    fails++;
    console.log(`BLOCKED  ${msg}   [no double gesture was delivered in ${a?.tries ?? 0} attempts: ${a?.g?.why || 'none'}] — not evaluated`);
    return false;
  }
  return ok(cond, msg, extra);
};
/** WAIT FOR THE JUMP, DO NOT SAMPLE FOR IT. A single read 90 ms after
    the press is a coin toss on a loaded machine: one rAF with a huge dt
    integrates the whole arc, so he takes off and lands between two
    samples and the probe reads vy 0, grounded true — a green feature
    reported as broken. Polls, and returns the peak it saw. */
async function airborneWithin(ms = 1800) {
  const t0 = Date.now();
  let best = { vy: 0, grounded: true };
  while (Date.now() - t0 < ms) {
    const s = await page.evaluate(() => ({ vy: +WALLY.ctx.wally.controller.velocity.y.toFixed(2), grounded: WALLY.ctx.wally.controller.grounded }));
    if (s.vy > best.vy) best = { ...best, vy: s.vy };
    if (s.grounded === false) best = { ...best, grounded: false };
    if (s.vy > 0.8 || s.grounded === false) return { ...best, jumped: true, ms: Date.now() - t0 };
    await page.waitForTimeout(60);
  }
  return { ...best, jumped: false, ms: Date.now() - t0 };
}
const armedOn = (r, el) => r.arm.some((a) => a.el === el && a.on);
const reachedCtl = (r, el, btn) => r.ev.some((e) => e.t === 'pointerdown' && e.on === el && e.b === btn);

const box = (sel, i = 0) => page.evaluate(([s, k]) => {
  const b = [...document.querySelectorAll(s)][k];
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: b.getAttribute('aria-label') || s };
}, [sel, i]);
const ACT = await box('.w-acts .w-abtn.act');
const JUMP = await box('.w-acts .w-abtn.jump');
const SC = [];
for (let i = 0; i < 4; i++) SC.push(await box('.w-acts .shortcuts .w-abtn', i));
const STICK = await box('.w-stick');
console.log('   geometry', JSON.stringify({ ACT, JUMP, SC: SC.map(s => s.label), STICK }));

/* ---------------- input ---------------- */
/* CDP `buttons` is the bitmask of what is HELD; `button` names the one
   that changed. back/forward were missing, so mousePress(...,'back')
   passed buttons undefined — section D needs all four. */
const MASK = { left: 1, middle: 4, right: 2, back: 8, forward: 16 };
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
const touch = (type, x, y) => multi(type, type === 'touchEnd' || type === 'touchCancel' ? [] : [P(x, y)]);
async function tap(x, y, hold = 70) {
  await touch('touchStart', x, y);
  await page.waitForTimeout(hold);
  await touch('touchEnd', x, y);
}

/* ============================================================
   THE LATCHED MOVEMENT KEY.

   Measured, in this file, by the rest gate below: mid-run the elephant
   walks at 2.44 m/s — exactly walkSpeed — with the thumbstick at t 0,
   and wally.keyboardInput() reads {x 0.4, z -0.92}. That is the
   KEYBOARD path, not the pad: touch.js's input() falls back to
   keyboardInput whenever the stick is at zero, and wally.js latches
   keys[e.code] on keydown until a keyup arrives. Something in this
   page holds a movement key down; this harness only ever dispatches
   Enter (P10), which keyboardInput does not read.

   IT IS NOT THE PAD'S, AND IT IS NOT COSMETIC. moving() is an input to
   the idle clock, so a latched key means the controls never fade —
   which makes the whole I section, K3/K4 and X3 unmeasurable rather
   than wrong — and it makes every "he stopped" reading noise.

   So the harness flushes the keyboard before any fixture that needs him
   standing still, and SAYS SO when it had to. A keyup for a key that
   was never down is a no-op, so this cannot hide a pad defect: the pad
   does not read the keyboard and the stick is measured separately. */
const MOVE_KEYS = { KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Space: 32, ShiftLeft: 16, ShiftRight: 16 };
async function flushKeys() {
  for (const [code, vk] of Object.entries(MOVE_KEYS)) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', code, key: code.startsWith('Key') ? code.slice(3).toLowerCase() : code,
      windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    });
  }
}
/** What the keys alone are asking for right now — with no stick and no
    override in front of them. */
const kbNow = () => page.evaluate(() => {
  const o = WALLY.ctx.wally.keyboardInput ? WALLY.ctx.wally.keyboardInput({}) : null;
  return o ? { x: +o.x.toFixed(2), z: +o.z.toFixed(2), jump: !!o.jump, run: !!o.run } : 'no keyboardInput on ctx.wally';
});
const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const toOpenGround = async () => {
  await page.evaluate((b) => { WALLY.ctx.ui.closeAll(); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {}); }, BOOT);
  await page.waitForTimeout(800);
};
/* ============================================================
   THE DOOR PRECONDITION IS A GATE, NOT A NOTE.

   P5 in the previous round measured verbs ["interact"] with panels []
   and was RIGHT: an arrival card was up, so Enter took interact()'s
   DIALOGUE branch and advanced the card instead of opening the door.
   The fix then was one dismissal and one setup line at P5 alone —
   which leaves every other door assertion in the file free to make the
   same mistake, and a suite that measures the wrong branch is worse
   than one that fails.

   So the precondition is now enforced for ALL of them, in one place.
   toDoor() dismisses, then MEASURES four things (near, dlg.isOpen, a
   live .w-dlg card in the DOM, an empty panel stack) and publishes the
   verdict. okDoor() REFUSES TO EVALUATE its claim when that verdict is
   dirty: it prints BLOCKED and counts a failure, rather than running an
   assertion whose green would mean nothing. G1/G2 below prove the gate
   can actually go dirty — an unfalsifiable precondition is the same
   nothing in a different colour.
   ============================================================ */
let DOOR = { clean: false, why: 'not at a door yet' };
/** `afterDismiss` runs BETWEEN the dismissal and the measurement, and
    exists for exactly one caller: X8, which uses it to raise a card in
    that gap so toDoor's OWN measurement has to come back dirty. Nothing
    else passes it, so no existing assertion changes shape. */
async function toDoor(tag = '', afterDismiss = null) {
  DOOR = { clean: false, why: 'arrive() never landed' };
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.arrive('apartment', true); });
  let near = null;
  for (let i = 0; i < 40 && !near; i++) {
    await page.waitForTimeout(200);
    near = await page.evaluate(() => WALLY.ctx.ui.near?.id ?? null);
  }
  /* dismiss whatever the arrival put up, THEN look */
  await page.evaluate(() => { WALLY.ctx.ui.hide('dialogue'); WALLY.ctx.ui.closeAll(); });
  await page.waitForTimeout(500);
  if (afterDismiss) { await afterDismiss(); await page.waitForTimeout(500); }
  const s = await page.evaluate(() => ({
    near: WALLY.ctx.ui.near?.id ?? null,
    dlgOpen: !!WALLY.ctx.ui.dialogueOpen,
    /* :not(.out) — dialogue.js's close() adds .out and removes the node
       280 ms later, so a card on its way out is NOT a card up. Without
       this the gate reads dirty for a quarter second after every
       dismissal and blocks the assertion that follows it (X8b did). */
    card: !!document.querySelector('.w-dlg:not(.out)'),
    panels: WALLY.ctx.ui.panels.slice(),
    modal: !!WALLY.ctx.ui.modal,
  }));
  const clean = s.near !== null && !s.dlgOpen && !s.card && s.panels.length === 0 && !s.modal;
  DOOR = { clean, why: clean ? '' : JSON.stringify(s), ...s };
  ok(clean, `DOORGATE${tag ? ' [' + tag + ']' : ''}: at a door with NO dialogue card and no panel up — so Enter's verb is interact()'s DOOR branch, not its dialogue-advance branch`,
    JSON.stringify(s));
  return clean ? s.near : null;
}
/** An assertion that depends on the door branch. Blocked, not green,
    when the precondition above did not hold. */
const okDoor = (cond, msg, extra = '') => {
  if (!DOOR.clean) {
    fails++;
    console.log(`BLOCKED  ${msg}   [door precondition dirty: ${DOOR.why}] — not evaluated`);
    return false;
  }
  return ok(cond, msg, extra);
};
const closeAll = async () => { await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); }); await page.waitForTimeout(500); };

console.log('\n--- NEGATIVES: a second mouse button is not a thumb ---');

/* R1  BRANCH bindPress pointerdown -> secondary(e) true, on Enter */
let door = await toDoor('R1');
await reset();
await mousePress(ACT.x, ACT.y, 'right');
await page.waitForTimeout(800);
let r = await read();
okDoor(reachedCtl(r, 'act', 2),
  'R1a [setup]: a real button-2 pointerdown reached the Enter button itself, at a door',
  `near ${door}, ev ${JSON.stringify(r.ev.filter(e => e.t !== 'click'))}`);
ok(!armedOn(r, 'act') && r.verbs.length === 0 && r.panels.length === 0,
  'R1 [BRANCH bindPress/pointerdown, secondary]: right press on Enter never arms the button, never runs interact(), opens no panel',
  `arm ${JSON.stringify(r.arm)}, verbs ${JSON.stringify(r.verbs)}, panels ${JSON.stringify(r.panels)}, toasts ${JSON.stringify(r.toasts)}`);
ok(r.menus.length >= 1 && r.menus.every((m) => m.inPad && m.prevented === true),
  'R1b [BRANCH root contextmenu handler]: the menu the refused press would have dropped over the pad is cancelled',
  JSON.stringify(r.menus));

/* R2  the whole bindPress row, one right press each */
door = await toDoor('R2');
await reset();
for (const b of SC) { await mousePress(b.x, b.y, 'right', 50); await page.waitForTimeout(160); }
await page.waitForTimeout(600);
r = await read();
ok(SC.every((b, i) => reachedCtl(r, 'sc' + i, 2)),
  'R2a [setup]: a button-2 pointerdown reached each of Phone, Places, Desk, Menu',
  JSON.stringify(r.ev.filter(e => e.t === 'pointerdown').map(e => [e.on, e.b])));
ok(!r.arm.some((a) => a.on) && r.verbs.length === 0 && r.panels.length === 0,
  'R2 [BRANCH bindPress/pointerdown x4 shortcuts]: not one of the four shortcuts arms or opens anything — one guard, not four copies',
  `arm ${JSON.stringify(r.arm)}, verbs ${JSON.stringify(r.verbs)}, panels ${JSON.stringify(r.panels)}`);

/* R3  BRANCH jump pointerdown -> secondary */
await toOpenGround();
await reset();
await mousePress(JUMP.x, JUMP.y, 'right', 220);
await page.waitForTimeout(300);
r = await read();
ok(reachedCtl(r, 'jump', 2),
  'R3a [setup]: a button-2 pointerdown reached the Jump button itself', JSON.stringify(r.ev.filter(e => e.t === 'pointerdown').map(e => [e.on, e.b])));
ok(!armedOn(r, 'jump') && r.grounded === true && r.vy < 0.5,
  'R3 [BRANCH jump/pointerdown, secondary]: right press on Jump does not arm it and he never leaves the ground',
  `arm ${JSON.stringify(r.arm)}, vy ${r.vy}, grounded ${r.grounded}`);

/* R4  BRANCH stick down() -> secondary */
await toOpenGround();
await reset();
const from4 = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, z: p.z }; });
await mouse('mouseMoved', STICK.x, STICK.y);
await mouse('mousePressed', STICK.x, STICK.y, 'right', 2);
for (let i = 1; i <= 5; i++) { await mouse('mouseMoved', STICK.x, STICK.y - i * 16, 'right', 2); await page.waitForTimeout(30); }
await page.waitForTimeout(360);
const mid4 = await read();
await mouse('mouseReleased', STICK.x, STICK.y - 80, 'right', 0);
await page.waitForTimeout(400);
const moved4 = await page.evaluate((f) => { const p = WALLY.ctx.wally.position; return +Math.hypot(p.x - f.x, p.z - f.z).toFixed(2); }, from4);
ok(reachedCtl(mid4, 'stick', 2) || mid4.ev.some(e => e.t === 'pointerdown' && e.b === 2 && e.inPad),
  'R4a [setup]: a button-2 pointerdown landed on the stick zone', JSON.stringify(mid4.ev.filter(e => e.t === 'pointerdown').map(e => [e.on, e.b, e.inPad])));
ok(!armedOn(mid4, 'stick') && mid4.stick === 0 && moved4 < 0.25,
  'R4 [BRANCH stick down(), secondary]: an 80 px right-drag never deflects the stick and moves him nothing (was 1.57 m)',
  `arm ${JSON.stringify(mid4.arm)}, t ${mid4.stick}, moved ${moved4} m`);

/* R5  MIDDLE, every control */
door = await toDoor('R5');
await reset();
await mousePress(ACT.x, ACT.y, 'middle');
await page.waitForTimeout(200);
for (const b of SC) { await mousePress(b.x, b.y, 'middle', 50); await page.waitForTimeout(140); }
await mousePress(JUMP.x, JUMP.y, 'middle', 200);
await page.waitForTimeout(200);
await mouse('mouseMoved', STICK.x, STICK.y);
await mouse('mousePressed', STICK.x, STICK.y, 'middle', 4);
for (let i = 1; i <= 4; i++) { await mouse('mouseMoved', STICK.x, STICK.y - i * 18, 'middle', 4); await page.waitForTimeout(30); }
await page.waitForTimeout(250);
r = await read();
await mouse('mouseReleased', STICK.x, STICK.y - 72, 'middle', 0);
await page.waitForTimeout(400);
const midDowns = r.ev.filter((e) => e.t === 'pointerdown' && e.b === 1 && e.inPad);
okDoor(midDowns.length === 7,
  'R5a [setup]: seven button-1 (middle) pointerdowns landed inside the pad — Enter, four shortcuts, Jump, stick',
  `${midDowns.length} middle presses on ${JSON.stringify(midDowns.map(e => e.on))}`);
ok(!r.arm.some((a) => a.on) && r.verbs.length === 0 && r.panels.length === 0 && r.stick === 0 && r.grounded === true,
  'R5 [BRANCH secondary(), button 1]: middle button — the one with no context menu to give it away — presses nothing anywhere on the pad',
  `arm ${JSON.stringify(r.arm)}, verbs ${JSON.stringify(r.verbs)}, panels ${JSON.stringify(r.panels)}, t ${r.stick}, vy ${r.vy}`);

/* R6  BRANCH bindPress end() -> the FIRE-POINT test (a different branch
       from the pointerdown one): primary released first as a pointermove,
       so the only pointerup the armed button gets carries button 2. */
door = await toDoor('R6');
await reset();
await mouse('mouseMoved', ACT.x, ACT.y);
await mouse('mousePressed', ACT.x, ACT.y, 'left', 1);
await page.waitForTimeout(80);
await mouse('mousePressed', ACT.x, ACT.y, 'right', 3);
await page.waitForTimeout(60);
await mouse('mouseReleased', ACT.x, ACT.y, 'left', 2);
await page.waitForTimeout(60);
await mouse('mouseReleased', ACT.x, ACT.y, 'right', 0);
await page.waitForTimeout(800);
r = await read();
const up6 = r.ev.filter((e) => e.t === 'pointerup' && e.on === 'act');
okDoor(armedOn(r, 'act') && up6.length === 1 && up6[0].b === 2,
  'R6a [setup]: the button really armed on button 0 and the only pointerup it received carries button 2',
  `arm ${JSON.stringify(r.arm)}, ups ${JSON.stringify(up6.map(u => u.b))}`);
ok(r.verbs.length === 0 && r.panels.length === 0,
  'R6 [BRANCH bindPress/end, secondary at the fire point]: the chorded secondary release fires no verb',
  `verbs ${JSON.stringify(r.verbs)}, panels ${JSON.stringify(r.panels)}`);
ok(r.arm.filter((a) => a.el === 'act').pop()?.on === false,
  'R6b [BRANCH end() disarms ABOVE the refusal]: the same release took the button OUT of the down state — not left armed and dead',
  JSON.stringify(r.arm.filter(a => a.el === 'act')));
await reset();
await mousePress(ACT.x, ACT.y, 'left');
await page.waitForTimeout(800);
r = await read();
ok(armedOn(r, 'act') && r.verbs.includes('interact') && r.panels.includes('place'),
  'R6c [positive control after the refusal]: the very next primary press on the same Enter opens the door',
  `arm ${JSON.stringify(r.arm)}, verbs ${JSON.stringify(r.verbs)}, panels ${JSON.stringify(r.panels)}`);
await closeAll();

console.log('\n--- POSITIVE CONTROLS: everything above passes on a pad that refuses everything ---');

/* P1  primary MOUSE on Enter at a door */
door = await toDoor('P1');
await reset();
await mousePress(ACT.x, ACT.y, 'left');
await page.waitForTimeout(800);
r = await read();
okDoor(armedOn(r, 'act') && r.verbs.includes('interact') && r.panels.includes('place'),
  'P1 [BRANCH bindPress, primary mouse]: a LEFT press on Enter arms it, runs interact() and opens the door',
  `arm ${JSON.stringify(r.arm)}, verbs ${JSON.stringify(r.verbs)}, panels ${JSON.stringify(r.panels)}, toasts ${JSON.stringify(r.toasts)}`);
await closeAll();

/* P2  primary MOUSE on each shortcut */
const scVerb = ['openPhone', 'openPhone', 'openDesk', 'show'];
const scPanel = ['phone', 'phone', 'desk', 'pause'];
for (let i = 0; i < 4; i++) {
  await closeAll();
  await reset();
  await mousePress(SC[i].x, SC[i].y, 'left');
  await page.waitForTimeout(700);
  r = await read();
  ok(armedOn(r, 'sc' + i) && r.verbs.includes(scVerb[i]) && r.panels.includes(scPanel[i]),
    `P2.${i} [BRANCH bindPress, primary mouse]: ${SC[i].label} arms and opens ${scPanel[i]}`,
    `arm ${JSON.stringify(r.arm)}, verbs ${JSON.stringify(r.verbs)}, panels ${JSON.stringify(r.panels)}`);
}
await closeAll();

/* P3  primary MOUSE on Jump, and a left-drag on the stick */
await toOpenGround();
await reset();
/* held open while the poll runs — see airborneWithin */
await mouse('mouseMoved', JUMP.x, JUMP.y);
await mouse('mousePressed', JUMP.x, JUMP.y, 'left', 1);
const air = await airborneWithin(1800);
await mouse('mouseReleased', JUMP.x, JUMP.y, 'left', 0);
r = await read();
ok(armedOn(r, 'jump') && air.jumped,
  'P3 [BRANCH jump, primary mouse]: a LEFT press on Jump arms it and leaves the ground',
  `arm ${JSON.stringify(r.arm)}, peak vy ${air.vy}, grounded ${air.grounded}, seen after ${air.ms} ms`);
await page.waitForTimeout(1200);

await toOpenGround();
await reset();
const from = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, z: p.z }; });
await mouse('mouseMoved', STICK.x, STICK.y);
await mouse('mousePressed', STICK.x, STICK.y, 'left', 1);
for (let i = 1; i <= 5; i++) { await mouse('mouseMoved', STICK.x, STICK.y - i * 16, 'left', 1); await page.waitForTimeout(30); }
await page.waitForTimeout(500);
const midP = await read();
await mouse('mouseReleased', STICK.x, STICK.y - 80, 'left', 0);
await page.waitForTimeout(400);
const movedP = await page.evaluate((f) => { const p = WALLY.ctx.wally.position; return +Math.hypot(p.x - f.x, p.z - f.z).toFixed(2); }, from);
ok(armedOn(midP, 'stick') && midP.stick > 0.5 && movedP > 0.5,
  'P4 [BRANCH stick down(), primary mouse]: the same 80 px drag on the LEFT button deflects the stick and walks him',
  `arm ${JSON.stringify(midP.arm)}, t ${midP.stick}, moved ${movedP} m`);

/* P5  TOUCH on all seven — the population the guard must never touch.
       THE DIALOGUE IS DISMISSED FIRST, and this is not tidying: the run
       before this one measured verbs ["interact"] with panels [] here and
       it was RIGHT — an arrival card was up, so Enter advanced it instead
       of opening the door. WALLY.debug.interact() said so in one line
       ("path dialogue, advanced the card"), which is the whole argument
       for the reason field. That precondition is now DOORGATE, enforced
       for every door assertion in the file and not just this one — see
       the block above toDoor(). P5a keeps its own reading of the DOM as
       the second measurement of the same fact. */
door = await toDoor('P5');
const dlgOpen = await page.evaluate(() => !!document.querySelector('.w-dlg:not(.out)'));
await reset();
await tap(ACT.x, ACT.y, 70);
await page.waitForTimeout(800);
r = await read();
const whyP5 = await page.evaluate(() => WALLY.debug.interact());
okDoor(dlgOpen === false && whyP5.path === 'door', 'P5a [BRANCH interact(), which path]: no card in the DOM, and the verb that ran reports path "door" — not the dialogue-advance branch', `near ${door}, dialogue ${dlgOpen}, why ${JSON.stringify(whyP5)}`);
okDoor(armedOn(r, 'act') && r.verbs.includes('interact') && r.panels.includes('place'),
  'P5 [BRANCH bindPress, finger]: a one-finger tap on Enter opens the door (touch contacts are always button 0)',
  `arm ${JSON.stringify(r.arm)}, verbs ${JSON.stringify(r.verbs)}, panels ${JSON.stringify(r.panels)}, ev ${JSON.stringify(r.ev)}, why ${JSON.stringify(whyP5)}`);
await closeAll();
for (let i = 0; i < 4; i++) {
  await closeAll();
  await reset();
  await tap(SC[i].x, SC[i].y, 70);
  await page.waitForTimeout(700);
  r = await read();
  ok(armedOn(r, 'sc' + i) && r.verbs.includes(scVerb[i]) && r.panels.includes(scPanel[i]),
    `P6.${i} [BRANCH bindPress, finger]: ${SC[i].label} still opens ${scPanel[i]} under a thumb`,
    `verbs ${JSON.stringify(r.verbs)}, panels ${JSON.stringify(r.panels)}`);
}
await closeAll();
await toOpenGround();
await reset();
await touch('touchStart', JUMP.x, JUMP.y);
const airT = await airborneWithin(1800);
await touch('touchEnd', JUMP.x, JUMP.y);
r = await read();
ok(armedOn(r, 'jump') && airT.jumped,
  'P7 [BRANCH jump, finger]: a thumb on Jump still jumps', `peak vy ${airT.vy}, grounded ${airT.grounded}, seen after ${airT.ms} ms`);
await page.waitForTimeout(1200);

/* P8  MULTITOUCH — the fix this round was built on top of: walk on the
       stick and press Enter with the other thumb. */
door = await toDoor('P8');
await reset();
const fromM = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, z: p.z }; });
await multi('touchStart', [P(STICK.x, STICK.y, 1)]);
await page.waitForTimeout(60);
await multi('touchMove', [P(STICK.x + 6, STICK.y - 40, 1)]);
await page.waitForTimeout(60);
await multi('touchMove', [P(STICK.x + 8, STICK.y - 62, 1)]);
await page.waitForTimeout(260);
const walking = await page.evaluate(() => ({ t: +WALLY.debug.touchState().t.toFixed(2), near: WALLY.ctx.ui.near?.id ?? null }));
await multi('touchStart', [P(STICK.x + 8, STICK.y - 62, 1), P(ACT.x, ACT.y, 2)]);
await page.waitForTimeout(90);
/* CDP touchEnd carries the points that were RELEASED, not the ones that
   remain — so this lifts Enter's contact and leaves the stick down. */
await multi('touchEnd', [P(ACT.x, ACT.y, 2)]);
await page.waitForTimeout(700);
r = await read();
const stillWalking = await page.evaluate(() => +WALLY.debug.touchState().t.toFixed(2));
await multi('touchEnd', [P(STICK.x + 8, STICK.y - 62, 1)]);
await page.waitForTimeout(400);
ok(walking.t > 0.3 && walking.near !== null,
  'P8a [setup]: he was walking on the stick (t>0.3) and the door was still in range when the second thumb landed',
  JSON.stringify(walking));
ok(armedOn(r, 'act') && r.verbs.includes('interact') && r.panels.includes('place'),
  'P8 [BRANCH bindPress under a second contact]: walking on the stick, Enter under the other thumb STILL opens the door',
  `arm ${JSON.stringify(r.arm)}, verbs ${JSON.stringify(r.verbs)}, panels ${JSON.stringify(r.panels)}, stick still down t=${stillWalking}, clicks ${JSON.stringify(r.ev.filter(e => e.t === 'click'))}`);
await closeAll();

/* P9  KEYBOARD / AT: detail-0 click, no pointer sequence at all.
       BRANCH bindPress's click listener (e.detail === 0). */
await closeAll();
await reset();
const kb = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.w-acts .shortcuts .w-abtn')][2];   // Desk
  b.focus();
  const focused = document.activeElement === b;
  b.click();                                    // detail 0, no pointer events
  return { focused };
});
await page.waitForTimeout(700);
r = await read();
const clicks9 = r.ev.filter((e) => e.t === 'click');
ok(kb.focused && clicks9.length === 1 && clicks9[0].d === 0 && r.ev.every((e) => e.t !== 'pointerdown'),
  'P9a [setup]: the activation really was the AT shape — one click, detail 0, no pointerdown in front of it',
  JSON.stringify(r.ev));
ok(r.verbs.includes('openDesk') && r.panels.includes('desk'),
  'P9 [BRANCH bindPress click, detail 0]: a keyboard / assistive-technology activation still presses the button',
  `verbs ${JSON.stringify(r.verbs)}, panels ${JSON.stringify(r.panels)}`);
await closeAll();

/* P10 the same for Enter, through a REAL key event on the focused button */
door = await toDoor('P10');
await reset();
await page.evaluate(() => document.querySelector('.w-acts .w-abtn.act').focus());
/* ============================================================
   nativeVirtualKeyCode IS A macOS KEYCODE ON macOS, AND THIS LINE
   PASSED A WINDOWS ONE. Every failure this file has ever reported
   BELOW this point came from these three lines.

   `nativeVirtualKeyCode: 13` is Windows VK_RETURN. On macOS, native
   keycode 13 is the letter W. Chrome auto-repeats the key it resolves
   NATIVELY, so one Enter press here began an endless KeyW keydown
   storm — ~3700 events a second, and it never stops. Measured in
   tools/_keyprobe.mjs, one fresh browser per variant:

     rawKeyDown Enter  nativeVirtualKeyCode 13 -> repeats code KeyW
     rawKeyDown KeyW   nativeVirtualKeyCode 87 -> repeats code Numpad5
     rawKeyDown Space  nativeVirtualKeyCode 32 -> repeats code KeyU

   (macOS keycode 87 IS keypad-5 and 32 IS U — the mapping is exact,
   which is what identifies the cause rather than suggesting it.)

   THAT STORM IS THE "LATCHED MOVEMENT KEY" X4-pre REPORTS. wally.js
   holds keys.KeyW true, so the elephant walks for the rest of the
   session; moving() is then true forever, the idle clock never fades
   the pad, and K3/I1/I3a/X1/X3/X4-pre/X4/X5/X7/X7b were all measuring
   a machine with a key stuck down. flushKeys() could not rescue it:
   its keyUp clears keys.KeyW for a few milliseconds and the next
   repeat sets it again. The flood also saturates the renderer, which
   is where the huge dt behind "drift 1.59 m in 0.6 s" comes from.

   Playwright's keyboard fills in the correct native code per platform,
   so the fix is to stop hand-rolling the descriptor. keyUP is safe
   either way (a keyup starts no repeat), which is why flushKeys below
   was never the problem.
   ============================================================ */
await page.keyboard.press('Enter');
await page.waitForTimeout(800);
r = await read();
const c10 = r.ev.filter((e) => e.t === 'click');
okDoor(c10.length >= 1 && c10.every((e) => e.d === 0) && r.verbs.includes('interact') && r.panels.includes('place'),
  'P10 [BRANCH bindPress click, detail 0, real key event]: pressing Enter on the focused pad button opens the door',
  `clicks ${JSON.stringify(c10)}, verbs ${JSON.stringify(r.verbs)}, panels ${JSON.stringify(r.panels)}`);
await closeAll();

/* P11 THE CLAIM BOTH CORRECTED HEADERS NOW MAKE: two pad buttons pressed
       together BOTH ARM and both reach their own pointerup; the first
       release wins and the loser is refused by the release-inside test
       (its rect is 0x0 inside the winner's display:none subtree), not by
       a missing event. The old headers said "neither one fires". */
await closeAll();
await reset();
await multi('touchStart', [P(SC[0].x, SC[0].y, 1)]);
await page.waitForTimeout(50);
await multi('touchStart', [P(SC[0].x, SC[0].y, 1), P(SC[3].x, SC[3].y, 2)]);
await page.waitForTimeout(90);
const bothArmed = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.w-acts .shortcuts .w-abtn')];
  return [b[0].classList.contains('down'), b[3].classList.contains('down')];
});
await multi('touchEnd', [P(SC[0].x, SC[0].y, 1)]);            // Phone releases first
await page.waitForTimeout(300);
const rectAfter = await page.evaluate(() => {
  const r = document.querySelector('.w-acts')?.getBoundingClientRect();
  return r ? [Math.round(r.width), Math.round(r.height)] : null;
});
await multi('touchEnd', [P(SC[3].x, SC[3].y, 2)]);            // Menu, the loser
await page.waitForTimeout(600);
r = await read();
ok(bothArmed[0] === true && bothArmed[1] === true,
  'P11a [the header\'s first claim]: BOTH buttons armed under two simultaneous contacts — the old "neither one fires" was wrong in both directions',
  `Phone down ${bothArmed[0]}, Menu down ${bothArmed[1]}`);
ok(r.verbs.length === 1 && r.verbs[0] === 'openPhone' && r.panels.includes('phone') && !r.panels.includes('pause'),
  'P11 [the header\'s second claim]: the FIRST release wins and the loser is refused — by the release-inside test, whose rect is now ' + JSON.stringify(rectAfter),
  `verbs ${JSON.stringify(r.verbs)}, panels ${JSON.stringify(r.panels)}`);
await closeAll();

console.log('\n--- A REFUSED INTERACT SAYS WHY ---');
await toOpenGround();
const why1 = await page.evaluate(() => { WALLY.ctx.ui.closeAll(); const ran = WALLY.ctx.ui.interact(); return { ran, ...WALLY.debug.interact() }; });
ok(why1.ran === false && why1.path === 'door' && typeof why1.why === 'string' && /no door in range/.test(why1.why),
  'W1 [BRANCH hud.interact, no door]: the silent refusal now names its cause', JSON.stringify(why1));
const why2 = await page.evaluate(() => { WALLY.ctx.ui.openPhone(); const ran = WALLY.ctx.ui.interact(); const d = WALLY.debug.interact(); WALLY.ctx.ui.closeAll(); return { ran, ...d }; });
ok(why2.ran === false && why2.path === 'panel' && /phone/.test(why2.why),
  'W2 [BRANCH interact() modal-stack early return]: says which sheet refused it', JSON.stringify(why2));
await closeAll();
/* the sequence the original silent no-op was measured in */
door = await toDoor('W3');
await page.evaluate(() => WALLY.ctx.ui.openPhone());
await page.waitForTimeout(400);
await page.evaluate(() => WALLY.ctx.ui.openDesk());
await page.waitForTimeout(400);
const stacked = await page.evaluate(() => WALLY.ctx.ui.panels.slice());
await page.evaluate(() => WALLY.ctx.ui.closeAll());
await page.waitForTimeout(400);
await reset();
await tap(ACT.x, ACT.y, 70);
await page.waitForTimeout(800);
r = await read();
const why3 = await page.evaluate(() => WALLY.debug.interact());
ok(stacked.length === 2, 'W3a [setup]: a phone-plus-desk pair really was stacked at the door', JSON.stringify(stacked));
okDoor(r.verbs.includes('interact') && r.panels.includes('place') && why3.ok === true,
  'W3 [BRANCH the stacked-panel repro]: Enter straight after a stacked pair closes opens the door, and says which',
  `verbs ${JSON.stringify(r.verbs)}, panels ${JSON.stringify(r.panels)}, why ${JSON.stringify(why3.why)}`);
await closeAll();

/* ============================================================
   G — THE DOOR GATE CAN GO DIRTY.

   Every DOORGATE line above is worthless if the gate cannot fail. A
   precondition that is structurally true is the same as no precondition
   at all, and this suite has been green for the wrong reason five times
   on this project. So: put a real card up at the door, run the SAME
   measurement toDoor() runs, and require it to come back dirty — and
   then show what the block bought, which is that Enter in that state
   takes interact()'s DIALOGUE branch and would have advanced the card
   under an assertion that says "opens the door".
   ============================================================ */
console.log('\n--- THE DOOR GATE ITSELF ---');
await closeAll();
door = await toDoor('G');                            // clean, asserted by toDoor
const gateWasClean = DOOR.clean;
/* THE BLOCK BODY IS THE WHOLE FIX, and it cost this suite its last
   three sections. ui.dialogue() returns the promise that resolves when
   the card is DISMISSED (ui.js line 24: `dialogue(spec) -> Promise`,
   dlg.open's `return promise`), and page.evaluate awaits whatever its
   function returns. The arrow that returned it therefore parked here
   forever with the card up: the run died silently at this line and G,
   K and I — the door gate, the secondary-wake decision and the whole
   idle feature — never executed at all. Returning undefined leaves the
   promise unawaited, which is correct: the card staying up IS the
   fixture. Same family as the waitForFunction trap at the boot. */
await page.evaluate(() => { WALLY.ctx.ui.dialogue(); });
await page.waitForTimeout(600);
const dirty = await page.evaluate(() => ({
  near: WALLY.ctx.ui.near?.id ?? null,
  dlgOpen: !!WALLY.ctx.ui.dialogueOpen,
  card: !!document.querySelector('.w-dlg:not(.out)'),
  panels: WALLY.ctx.ui.panels.slice(),
}));
const gateNowClean = dirty.near !== null && !dirty.dlgOpen && !dirty.card && dirty.panels.length === 0;
ok(gateWasClean === true && dirty.card === true && dirty.dlgOpen === true && gateNowClean === false,
  'G1 [BRANCH toDoor()\'s precondition, the FALSE side]: with a card up at the same door the gate reads DIRTY — the gate above is falsifiable, not decorative',
  `clean before ${gateWasClean}, after ${JSON.stringify(dirty)}`);
/* and what the gate was protecting: the other branch of interact() */
await reset();
await tap(ACT.x, ACT.y, 70);
await page.waitForTimeout(800);
r = await read();
const whyG = await page.evaluate(() => WALLY.debug.interact());
ok(r.verbs.includes('interact') && whyG.path === 'dialogue' && !r.panels.includes('place'),
  'G2 [BRANCH interact() dialogue-advance]: with a card up, the very same tap on Enter runs interact() and opens NO door — exactly the shape that read as a green door assertion last round',
  `verbs ${JSON.stringify(r.verbs)}, panels ${JSON.stringify(r.panels)}, why ${JSON.stringify(whyG)}`);
/* G3 — the blocker actually blocks. Run okDoor while the gate is dirty
   against a claim that is TRUE, and require it to refuse anyway. */
DOOR = { clean: false, why: 'G3 self-test' };
const before3 = fails;
const g3 = okDoor(true, 'G3 [self-test of okDoor, expected BLOCKED]: a trivially true claim is still refused while the gate is dirty');
ok(g3 === false && fails === before3 + 1,
  'G3 [BRANCH okDoor\'s refusal path]: okDoor returned false and counted a failure for a claim that was true — the block is a real early return, not a comment',
  `returned ${g3}, fails ${before3} -> ${fails}`);
fails--;                                             // undo the deliberate one
await page.evaluate(() => { WALLY.ctx.ui.hide('dialogue'); WALLY.ctx.ui.closeAll(); });
await closeAll();

/* ============================================================
   K — THE EIGHTH POINTERDOWN. What was decided this round about a
   SECONDARY-button double click on the faded pad, asserted.

   THE DECISION, from ONE PRIMARY-BUTTON GATE in src/ui/touch.js: the
   seven CONTROLS are gated, the eighth pointerdown (the document-capture
   wake detector) is NOT, and a right-button double click wakes the pad
   exactly as a left one does. Kept deliberately, because a wake runs no
   verb and refusing it would take the only way back from a player whose
   primary is not button 0 — the pause gear is faded out with everything
   else. touchtest.mjs asserts it as PAD-27; this is the independent
   reading of the same claim, from a different probe.

   BOTH HALVES, or it is not the decision:
     K1  the wake happens                    (measured in the clock AND in the DOM)
     K2  and nothing else does               (no verb, no panel, no arm)
   AND TWO DISCRIMINATORS, because "the pad came back" is the sort of
   thing that is true for the wrong reason:
     K3  ONE right click does not wake       — so K1 is the double-tap
                                               detector, not any press
     K4  a LEFT double click wakes the same  — so K1 is not the pad
                                               waking itself on a timer
   ============================================================ */
console.log('\n--- K: A SECONDARY DOUBLE CLICK ON THE FADED PAD ---');
/* the DOM half of "faded", measured at the cluster, not inferred */
const padDom = () => page.evaluate(() => {
  const root = document.querySelector('.w-touch');
  const acts = document.querySelector('.w-acts');
  return {
    idlehide: !!root?.classList.contains('w-idlehide'),
    idlewake: !!root?.classList.contains('w-idlewake'),
    actsOp: +(+getComputedStyle(acts).opacity).toFixed(2),
  };
});
const idleGet = () => page.evaluate(() => WALLY.debug.idle());
/** Stand still with a short window until the clock actually fires. */
async function goFaded(sec = 0.5) {
  /* A LATCHED MOVEMENT KEY IS PRESENCE TO THIS CLOCK — see the block
     above flushKeys. The fixture here is "he is standing still", so the
     keyboard is released before the clock is asked to fire; without it
     the pad never fades and every wake assertion downstream reports a
     failure that belongs to a key nobody pressed. */
  await flushKeys();
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.hideUI(true); });
  await page.evaluate((s) => WALLY.debug.idle(s), sec);
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(200);
    const s = await idleGet();
    /* HIDDEN IS THE FLAG; THE FADE IS 0.42 s LONGER. K0 asks the
       cluster's computed opacity to be under 0.05 and read 0.37 off a
       fade that was still running — a fixture measured before it
       finished, which is the same error as measuring a control mid
       fade-IN. Wait the transition out before answering. */
    if (s.hidden) { await page.waitForTimeout(600); return await idleGet(); }
  }
  return await idleGet();
}
/* K's contacts land on the hidden ENTER at a door — the one spot on the
   screen where a stray verb shows up as a panel. */
door = await toDoor('K');
const K = await wakeAttempt('mouse', 'right', ACT.x, ACT.y);
const fade1 = K.before, dom1 = K.domBefore ?? {}, wokeR = K.after ?? {}, domR = K.dom ?? {};
r = K.r ?? { ev: [], arm: [], verbs: [], panels: [], toasts: [] };
const rDowns = r.ev.filter((e) => e.t === 'pointerdown' && e.b === 2);
okTap(K, DOOR.clean && fade1.hidden === true && dom1.idlehide === true && dom1.actsOp < 0.05
   && rDowns.length === 2 && K.g.buttons.every((b) => b === 2),
  'K0 [setup]: the pad really was faded at a door (clock hidden AND .w-idlehide AND the cluster at opacity ' + dom1.actsOp + ') and BOTH pointerdowns of the double click carried button 2 — and the pair arrived inside touch.js\'s own gates, ' + K.g.gap + ' ms apart and ' + K.g.dist + ' px apart, on attempt ' + K.tries,
  `door clean ${DOOR.clean}, idle ${JSON.stringify({ hidden: fade1.hidden, why: fade1.why, wakes: fade1.wakes })}, dom ${JSON.stringify(dom1)}, downs ${JSON.stringify(rDowns.map((e) => e.b))}`);
okTap(K, wokeR.hidden === false && wokeR.wakes === fade1.wakes + 1 && domR.idlehide === false && domR.actsOp > 0.5,
  'K1 [BRANCH tapDown/tapUp with NO e.button filter — the documented exception]: a RIGHT-button double click brings the controls back, exactly as a left one does; the wake counter moved and .w-idlehide came off the cluster',
  `idle ${JSON.stringify({ hidden: wokeR.hidden, wakes: wokeR.wakes, live: wokeR.live })}, dom ${JSON.stringify(domR)}`);
okTap(K, DOOR.clean && !armedOn(r, 'act') && r.verbs.length === 0 && r.panels.length === 0,
  'K2 [BRANCH the gate is about VERBS]: those two right clicks sat on top of the hidden Enter at a door and fired nothing — no arm, no interact(), no panel; the wake is the whole effect',
  `arm ${JSON.stringify(r.arm)}, verbs ${JSON.stringify(r.verbs)}, panels ${JSON.stringify(r.panels)}, toasts ${JSON.stringify(r.toasts)}`);

/* K3 — the discriminator. If ANY press woke it, K1 proves nothing. */
const fade3 = await goFaded(0.5);
await reset();
await mousePress(ACT.x, ACT.y, 'right', 50);
await page.waitForTimeout(1200);                       // well past TAP_GAP (300 ms)
const after3 = await idleGet();
const dom3 = await padDom();
const r3 = await read();
ok(fade3.hidden === true && r3.ev.some((e) => e.t === 'pointerdown' && e.b === 2),
  'K3a [setup]: the pad was faded again and a single button-2 pointerdown was delivered on top of it',
  `hidden ${fade3.hidden}, downs ${JSON.stringify(r3.ev.filter((e) => e.t === 'pointerdown').map((e) => e.b))}`);
ok(after3.hidden === true && after3.wakes === fade3.wakes && dom3.idlehide === true,
  'K3 [BRANCH tapUp, the pending-only path]: ONE right click leaves it faded — K1 is the double-tap detector committing, not "a secondary press wakes the pad"',
  `idle ${JSON.stringify({ hidden: after3.hidden, wakes: after3.wakes, pending: after3.pending })}, dom ${JSON.stringify(dom3)}`);

/* K4 — the comparison that makes K1 a decision rather than an accident. */
const K4 = await wakeAttempt('mouse', 'left', ACT.x, ACT.y);
const fade4 = K4.before, woke4 = K4.after ?? {}, r4 = K4.r ?? { verbs: [], panels: [] };
okTap(K4, fade4.hidden === true && woke4.hidden === false && woke4.wakes === fade4.wakes + 1
   && r4.verbs.length === 0 && r4.panels.length === 0,
  'K4 [BRANCH the same detector, button 0]: a LEFT double click on the same faded Enter does exactly what the right one did — wakes, fires nothing. Right and left are the same line, which is the claim',
  `left ${JSON.stringify({ hidden: woke4.hidden, wakes: woke4.wakes })}, verbs ${JSON.stringify(r4.verbs)}, panels ${JSON.stringify(r4.panels)}`);

/* ============================================================
   I — THE IDLE FEATURE ITSELF: it fades, a double TAP wakes it, and a
   CAMERA DRAG does not.

   THE TRAP THIS SECTION IS BUILT AROUND is I3. "The drag did not wake
   it" is trivially true of a drag that never happened — the fourth of
   the five wrong-reason greens on this project was exactly that shape.
   So I3 measures the CAMERA as well: the same gesture has to have moved
   the view, and by much more than the idle auto-orbit drifts on its own
   over an identical window with no input at all. Both numbers are
   printed.
   ============================================================ */
console.log('\n--- I: FADE, DOUBLE TAP, CAMERA DRAG ---');
await toOpenGround();
const camAz = () => page.evaluate(() => {
  const c = WALLY.ctx.camera; const v = new WALLY.ctx.THREE.Vector3();
  c.getWorldDirection(v);
  return Math.atan2(v.x, v.z);
});
const dAz = (a, b) => { let d = Math.abs(a - b) % (Math.PI * 2); return +(d > Math.PI ? Math.PI * 2 - d : d).toFixed(4); };

/* I1 — it fades. Measured in the clock AND at the cluster. */
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.hideUI(true); });
await page.evaluate(() => WALLY.debug.idle(1.0));
/* START FROM UP, EXPLICITLY. I1's claim is that standing still takes
   the controls AWAY, which is unmeasurable if they were already away —
   and they are, whenever the K section above ends faded (it does, if a
   wake there was not delivered). Hide UI off puts them back and stops
   the clock; the line below re-arms it. Without this the assertion
   fails on `beforeFade.idlehide === false` and blames the fade. */
await page.evaluate(() => { WALLY.debug.hideUI(false); });
await page.waitForTimeout(700);
await page.evaluate(() => { WALLY.debug.hideUI(true); WALLY.debug.idle(1.0); });
await page.waitForTimeout(300);
const beforeFade = await padDom();
const fadeI = await goFaded(1.0);
const domI = await padDom();
ok(beforeFade.idlehide === false && fadeI.hidden === true && fadeI.why === 'hidden'
   && domI.idlehide === true && domI.actsOp < 0.05,
  'I1 [BRANCH idleTick, idleT >= idleDelay]: standing still past the window fades the bottom controls out — the clock says hidden and the cluster is at opacity ' + domI.actsOp,
  `before ${JSON.stringify(beforeFade)}, idle ${JSON.stringify({ hidden: fadeI.hidden, why: fadeI.why, t: fadeI.t })}, dom ${JSON.stringify(domI)}`);

/* I2 — a double TAP (real touch contacts, not the mouse of K1/K4) wakes
        it, and the controls become LIVE afterwards, which is the flag
        the DOM cannot answer (see the note on `live` in touch.js). */
const I2 = await wakeAttempt('touch', 'left', 195, 470);
const wakesBefore = I2.before.wakes;
const wokeT = I2.after ?? {}, domT = I2.dom ?? {}, rT = I2.r ?? { verbs: [], panels: [] };
okTap(I2, I2.before.hidden === true && wokeT.hidden === false && wokeT.wakes === wakesBefore + 1 && domT.idlehide === false
   && wokeT.live === true && rT.verbs.length === 0 && rT.panels.length === 0,
  'I2 [BRANCH tapUp COMMIT, two finger contacts]: a double TAP brings the controls back, they go live once the fade finishes, and the waking contact fires nothing on the way',
  `idle ${JSON.stringify({ hidden: wokeT.hidden, wakes: wokeT.wakes, live: wokeT.live })}, dom ${JSON.stringify(domT)}, verbs ${JSON.stringify(rT.verbs)}`);

/* I3 — a camera drag is not activity and is not a wake. */
const fadeD = await goFaded(1.0);
const domD0 = await padDom();
/* the control window FIRST: how far the view drifts on its own in the
   same wall-clock time with no contact at all */
const az0 = await camAz();
await page.waitForTimeout(900);
const azIdle = await camAz();
const driftIdle = dAz(az0, azIdle);
/* now the drag — one contact, on the canvas well clear of the pad,
   150 px across, far past TAP_SLOP (12 px) */
await reset();
const azA = await camAz();
await multi('touchStart', [P(120, 330, 7)]);
await page.waitForTimeout(60);
for (let i = 1; i <= 6; i++) { await multi('touchMove', [P(120 + i * 25, 330, 7)]); await page.waitForTimeout(45); }
await page.waitForTimeout(60);
await multi('touchEnd', [P(270, 330, 7)]);
await page.waitForTimeout(900);
const azB = await camAz();
const dragTurn = dAz(azA, azB);
const afterDrag = await idleGet();
const domD1 = await padDom();
const rD = await read();
ok(fadeD.hidden === true && domD0.idlehide === true && dragTurn > 0.08 && dragTurn > driftIdle * 3,
  'I3a [setup — the half that has been wrong before]: the pad was faded AND the drag was really delivered — it turned the camera ' + dragTurn + ' rad, against ' + driftIdle + ' rad of idle auto-orbit over the same 0.9 s with no finger down',
  `hidden ${fadeD.hidden}, dom ${JSON.stringify(domD0)}, turn ${dragTurn}, drift ${driftIdle}`);
ok(afterDrag.hidden === true && afterDrag.wakes === fadeD.wakes && domD1.idlehide === true
   && rD.verbs.length === 0 && rD.panels.length === 0,
  'I3 [BRANCH tapMove past TAP_SLOP -> c.cand = false, and tapUp\'s "not a tap clears pending"]: that camera drag woke nothing — still faded, wake counter unmoved',
  `idle ${JSON.stringify({ hidden: afterDrag.hidden, wakes: afterDrag.wakes, pending: afterDrag.pending })}, dom ${JSON.stringify(domD1)}`);

/* I4 — and the way back still works AFTER the drag, so I3 is not a pad
        that has simply died. The drag must not have poisoned the
        detector: tapUp cleared `pending`, so a fresh double tap is the
        only thing that can bring it back, and it does. */
const I4 = await wakeAttempt('touch', 'left', 195, 470);
const beforeI4 = I4.before, wokeI4 = I4.after ?? {};
okTap(I4, beforeI4.hidden === true && wokeI4.hidden === false && wokeI4.wakes === beforeI4.wakes + 1,
  'I4 [positive control after I3]: a double tap straight after the refused drag still wakes it — I3 measured a refusal, not a broken detector',
  `before ${JSON.stringify({ hidden: beforeI4.hidden, wakes: beforeI4.wakes })}, after ${JSON.stringify({ hidden: wokeI4.hidden, wakes: wokeI4.wakes })}`);

/* put the world back the way the rest of the file expects it */
await page.evaluate(() => { WALLY.debug.idle(null); WALLY.debug.hideUI(false); WALLY.ctx.ui.closeAll(); });
await page.waitForTimeout(600);
const restored = await idleGet();
ok(restored.hidden === false && restored.armed === false,
  'I5 [BRANCH idleTick !idleArmed()]: turning Hide UI back off brings the controls back and stops the clock',
  JSON.stringify({ hidden: restored.hidden, armed: restored.armed, why: restored.why }));

/* ============================================================
   X — ADDED THIS ROUND, and every one of them names the branch it
   enters. The rule this section was written under: no refusal without
   the matching positive beside it, and no "it did not happen" without
   a measurement proving the gesture was delivered. Five greens on this
   project were green for the wrong reason and every one of them was a
   negative standing on its own.
   ============================================================ */
console.log('\n--- X: THE BRANCHES THE SECTIONS ABOVE DID NOT ENTER ---');
const posNow = () => page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: +p.x.toFixed(2), z: +p.z.toFixed(2) }; });
const dist = (a, b) => +Math.hypot(a.x - b.x, a.z - b.z).toFixed(2);
const stickT = () => page.evaluate(() => +(WALLY.debug.touchState().t ?? 0).toFixed(2));

/* ------------------------------------------------------------
   X1 / X2 — WHAT THE SECONDARY WAKE HANDS BACK.

   K1 proves a right-button double click brings the controls back. It
   does not prove the pad you get back can be pressed, and "the
   controls came back" is exactly the kind of claim that is also true
   of a pad that is drawn and dead — which is the whole reason `live`
   exists as a flag separate from `hidden`. So both sides of the fade-in,
   in order, on the same button the wake landed on:

     X2  controlsLive() === false — the 0.42 s inert window. style.js
         puts pointer-events:none on the cluster for .w-idlewake, so the
         press is refused before bindPress ever sees it; the setup
         asserts a real button-0 pointerdown was delivered at Enter's
         own coordinates and did NOT reach the control.
     X1  controlsLive() === true  — the same coordinates once the fade
         has finished must open the door. THIS is the half that makes
         K1 a feature rather than a cosmetic flicker.
   ------------------------------------------------------------ */
door = await toDoor('X1');
/* The inert-window press rides along INSIDE the wake attempt, between
   tap two's release and the settle, so no round trip sits between the
   commit and the press it has 0.42 s to beat. `accept` makes a missed
   window a retry rather than a red. */
const X12 = await wakeAttempt('mouse', 'right', ACT.x, ACT.y, {
  after2: async () => {
    await mouse('mouseMoved', ACT.x, ACT.y);
    await mouse('mousePressed', ACT.x, ACT.y, 'left', 1);
    await page.waitForTimeout(25);
    await mouse('mouseReleased', ACT.x, ACT.y, 'left', 0);
    /* `live` only ever goes false -> true across a fade-in, so reading
       it false AFTER the release proves it was false AT the release. */
    return await idleGet();
  },
  accept: (l) => l.extra && l.extra.hidden === false && l.extra.live === false,
});
const inWindow = !!(X12?.extra && X12.extra.hidden === false && X12.extra.live === false);
const dnX2 = X12?.r ? X12.r.ev.filter((e) => e.t === 'pointerdown' && e.b === 0) : [];
if (!X12?.g?.ok || !inWindow) {
  fails += 2;
  console.log(`BLOCKED  X2a/X2 [BRANCH controlsLive() === false, the fade-in]   [fixture never assembled in ${X12?.tries ?? 0} attempts: gesture ${X12?.g?.why || 'not delivered'}; window ${JSON.stringify(X12?.extra ? { hidden: X12.extra.hidden, live: X12.extra.live } : null)}] — not evaluated`);
} else {
  /* THE TARGET IS THE EVIDENCE, AND IT IS NOT THE PAD. .w-touch is
     pointer-events:none at the root and its children re-enable it
     (style.js), so .w-idlewake taking that back off the cluster means
     the press falls THROUGH to the canvas. `inPad === false` is the
     positive reading of "the hit test refused it", not a miss: an
     assertion that demanded inPad true here would be measuring a pad
     that was still pressable. */
  ok(dnX2.length === 1 && dnX2[0].on === null && dnX2[0].inPad === false,
    'X2a [setup]: a primary press really was delivered at Enter\'s own coordinates DURING the fade-in (idle.hidden false, idle.live false) — and it landed on the canvas behind the pad instead of on the button, which is pointer-events refusing it at the hit test',
    `idle at the release ${JSON.stringify({ hidden: X12.extra.hidden, live: X12.extra.live })}, downs ${JSON.stringify(dnX2.map((e) => [e.tg, e.b, e.inPad]))}, attempt ${X12.tries}`);
  ok(X12.r.verbs.length === 0 && X12.r.panels.length === 0 && !armedOn(X12.r, 'act'),
    'X2 [BRANCH controlsLive() === false, the fade-in]: a primary press on the waking Enter at a door arms nothing and opens nothing while the cluster is still inert',
    `arm ${JSON.stringify(X12.r.arm)}, verbs ${JSON.stringify(X12.r.verbs)}, panels ${JSON.stringify(X12.r.panels)}`);
}

await page.evaluate(() => WALLY.debug.idle(60));      // see the note in wakeAttempt
let liveX1 = await idleGet();
for (let i = 0; i < 30 && !liveX1.live; i++) { await page.waitForTimeout(120); liveX1 = await idleGet(); }
await reset();
await mousePress(ACT.x, ACT.y, 'left', 70);
await page.waitForTimeout(800);
r = await read();
okTap(X12, liveX1.live === true && armedOn(r, 'act') && r.verbs.includes('interact') && r.panels.includes('place'),
  'X1 [BRANCH controlsLive() === true, reached THROUGH the secondary wake]: once the fade finishes, the very same Enter opens the door — the right-button wake handed back a working pad, not a picture of one',
  `live ${liveX1.live}, arm ${JSON.stringify(r.arm)}, verbs ${JSON.stringify(r.verbs)}, panels ${JSON.stringify(r.panels)}`);
await closeAll();

/* ------------------------------------------------------------
   X3 — AND THE MIDDLE BUTTON WAKES TOO.

   K covers buttons 2 and 0. The decision written in touch.js is "NO
   e.button FILTER EITHER", which a guard reading `e.button === 2` would
   satisfy for the whole K section. Button 1 is the third value and the
   one with no context menu to give it away.
   ------------------------------------------------------------ */
const nearX3 = await page.evaluate(() => WALLY.ctx.ui.near?.id ?? null);
const X3 = await wakeAttempt('mouse', 'middle', ACT.x, ACT.y);
const fadeM = X3.before, wokeM = X3.after ?? {}, domM = X3.dom ?? {}, rM = X3.r ?? { ev: [], verbs: [], panels: [] };
const dnM = rM.ev.filter((e) => e.t === 'pointerdown' && e.b === 1);
okTap(X3, fadeM.hidden === true && dnM.length === 2 && nearX3 !== null,
  'X3a [setup]: the pad was faded with the door still in range and BOTH pointerdowns of the double click carried button 1 (middle)',
  `near ${nearX3}, hidden ${fadeM.hidden}, downs ${JSON.stringify(dnM.map((e) => e.b))}`);
okTap(X3, wokeM.hidden === false && wokeM.wakes === fadeM.wakes + 1 && domM.idlehide === false
   && rM.verbs.length === 0 && rM.panels.length === 0,
  'X3 [BRANCH tapDown/tapUp, button 1]: a MIDDLE double click wakes the pad and fires nothing — the exception really is "no button filter", not "button 2 tolerated"',
  `idle ${JSON.stringify({ hidden: wokeM.hidden, wakes: wokeM.wakes })}, dom ${JSON.stringify(domM)}, verbs ${JSON.stringify(rM.verbs)}, panels ${JSON.stringify(rM.panels)}`);

/* ------------------------------------------------------------
   THE FIXTURE FOR X4..X7, AND IT IS NOT A FORMALITY.

   idle().moving is only computed when idleArmed(), so Hide UI has to be
   ON for X5 to be able to read jumpHeld at all — and the window has to
   be long enough that nothing fades under these four. But `idle(60)`
   alone does NOT un-fade a pad that is already hidden: if any wake
   above was not delivered, the cluster is still pointer-events:none and
   every gesture below falls through to the canvas, arming nothing. That
   is exactly how X4..X7 came back as eight reds that said `arm []` and
   `t 0` on a loaded machine. Hide UI OFF first (which un-fades and
   stops the clock), then ON with a long window.

   AND THE BASELINE. X4, X5 and X7 all use MOTION as evidence — he
   stopped, he kept walking. On a thrashing machine one rAF with a huge
   dt moves him metres with no input at all, which makes "he stopped"
   unmeasurable. So his own drift with nothing touched is measured
   first, and the block says so instead of the assertions failing
   mysteriously one after another.
   ------------------------------------------------------------ */
await page.evaluate(() => { WALLY.debug.hideUI(false); });
await page.waitForTimeout(700);
await page.evaluate(() => { WALLY.debug.idle(60); WALLY.debug.hideUI(true); });
await page.waitForTimeout(500);
/** Warp, let him settle, and measure the drift he has with nothing
    touched — twice over, because a warp drops him 0.3 m and a body
    still landing is not yet at rest. Reports the CONTROLLER VELOCITY
    beside the position delta: v ~ 0 with the position moving means
    something is teleporting him, v at walking speed means an input is
    still held, and the two have different owners. */
async function restCheck(tries = 3) {
  let last = null;
  let flushed = false;
  for (let i = 0; i < tries; i++) {
    if (i > 0) { await flushKeys(); flushed = true; await page.waitForTimeout(400); }
    await toOpenGround();
    await page.waitForTimeout(1200);
    const a = await posNow();
    const va = await page.evaluate(() => { const v = WALLY.ctx.wally.controller.velocity; return { x: +v.x.toFixed(2), y: +v.y.toFixed(2), z: +v.z.toFixed(2) }; });
    await page.waitForTimeout(600);
    const b = await posNow();
    const t = await stickT();
    /* WHO IS DRIVING HIM. touch.js's input() falls back to the keyboard
       whenever the stick is at zero, so walking speed with stick t 0 has
       two possible sources and they have different owners: a stuck
       movement KEY (this harness dispatches key events, so that would be
       ours) or an input function installed over the default by game.js
       (which would not be). keyboardInput() answers it in one line — it
       reports what the KEYS alone say, with no stick and no override in
       front of them. */
    const kb = await page.evaluate(() => {
      const o = WALLY.ctx.wally.keyboardInput ? WALLY.ctx.wally.keyboardInput({}) : null;
      return o ? { x: +o.x.toFixed(2), z: +o.z.toFixed(2), jump: !!o.jump, run: !!o.run } : 'no keyboardInput on ctx.wally';
    });
    last = { drift: dist(a, b), v: va, kb, t, a, b, tries: i + 1, flushed };
    if (last.drift < 0.15) break;
  }
  return last;
}
const REST = await restCheck();
const preX = await idleGet();
ok(preX.hidden === false && preX.armed === true && preX.live === true && REST.drift < 0.15,
  'X4-pre [fixture for X4..X7]: the controls are UP and pressable (hidden false, live true) with the idle clock armed on a 60 s window — and he is at rest, drifting ' + REST.drift + ' m in 0.6 s with nothing touched, so the motion X4/X5/X7 measure is the pad\'s and not the machine\'s',
  `idle ${JSON.stringify({ hidden: preX.hidden, armed: preX.armed, live: preX.live, delay: preX.delay })}, drift ${REST.drift} m after ${REST.tries} settle(s)${REST.flushed ? ' (a latched movement key had to be released first — see flushKeys)' : ''}, controller v ${JSON.stringify(REST.v)}, KEYBOARD reads ${JSON.stringify(REST.kb)}, stick t ${REST.t}, ${JSON.stringify(REST.a)} -> ${JSON.stringify(REST.b)}`);
/** A claim whose evidence is that he STOPPED, or that he KEPT WALKING.
    Blocked when he was not at rest to begin with: on a machine that
    moves him with nothing touched, both readings are noise. */
const okRest = (cond, msg, extra = '') => {
  if (!(REST.drift < 0.15)) {
    fails++;
    console.log(`BLOCKED  ${msg}   [he was not at rest before this ran: ${REST.drift} m in 0.6 s with nothing touched, controller v ${JSON.stringify(REST.v)}, keyboard ${JSON.stringify(REST.kb)}, stick t ${REST.t}] — not evaluated`);
    return false;
  }
  return ok(cond, msg, extra);
};

/* ------------------------------------------------------------
   X4 — THE STICK'S OWN CHORDED RELEASE.

   R6 exercises the "no button test at the release" rule for bindPress.
   The stick has its own copy of it, with its own comment ("refusing it
   strands the knob at full deflection and walks him away on his own"),
   and nothing measured it. Chrome sends a chorded mouse ONE pointerup,
   carrying the last button released — so a `secondary(e)` guard in up()
   would leave the knob out and the player walking.

   THE FAILURE IS IN THE WORLD, so it is measured there: after the
   button-2 release he must STOP. A stranded stick moves him metres in
   the window this samples.
   ------------------------------------------------------------ */
await toOpenGround();
await page.waitForTimeout(900);            // a warp drops him 0.3 m; let him land
await reset();
await mouse('mouseMoved', STICK.x, STICK.y);
await mouse('mousePressed', STICK.x, STICK.y, 'left', 1);
for (let i = 1; i <= 5; i++) { await mouse('mouseMoved', STICK.x, STICK.y - i * 16, 'left', 1); await page.waitForTimeout(30); }
await page.waitForTimeout(300);
const midX4 = await read();
const movingHeld = (await idleGet()).moving;
await mouse('mousePressed', STICK.x, STICK.y - 80, 'right', 3);      // chord ON
await page.waitForTimeout(70);
await mouse('mouseReleased', STICK.x, STICK.y - 80, 'left', 2);      // primary goes first
await page.waitForTimeout(70);
const chordT = await stickT();
await mouse('mouseReleased', STICK.x, STICK.y - 80, 'right', 0);     // the only pointerup
await page.waitForTimeout(900);
const rX4 = await read();
const restT = await stickT();
const pA4 = await posNow();
await page.waitForTimeout(600);
const pB4 = await posNow();
const upsX4 = rX4.ev.filter((e) => e.t === 'pointerup' && e.inPad);
const lastStick = rX4.arm.filter((a) => a.el === 'stick').pop();
/* ------------------------------------------------------------
   X4a/X4 WERE RESTATED, AND THE OLD WORDING WAS A GREEN WAITING TO HAPPEN.

   This pair was written before THE CHORD WINDOW closed (PAD-32 in
   tools/touchtest.mjs). Its setup asserted `chordT > 0.5` — the knob
   still OUT after the primary release — and its claim was then "the
   button-2 release put the knob home". Both describe the code as it was.

   The stick now lets go at the PRIMARY release, which Chrome delivers as
   a pointermove: `if (e.pointerType === 'mouse' && !(e.buttons & 1)) up(e)`.
   So `chordT` is 0 by the time the old setup looked, and the old setup
   fails — which is how this was found. Worse, had it been loosened
   instead, X4's claim would have gone on passing while naming the WRONG
   CAUSE: the knob is already home before the button-2 pointerup arrives,
   so that pointerup demonstrably is not what put it there. That is the
   seventh instance of an assertion green for the wrong reason on this
   project and it is written down rather than quietly patched.

   RESTATED: chordT === 0 IS the discriminator — it is read after the
   primary release and before the button-2 one, so it separates "the
   chord window let go" from "the late pointerup let go" by construction.
   up()'s missing button test is still exercised, as the defence in depth
   it now is: the button-2 pointerup lands on a stick with id already
   null and must change nothing.
   ------------------------------------------------------------ */
ok(armedOn(midX4, 'stick') && midX4.stick > 0.5 && chordT === 0 && upsX4.length === 1 && upsX4[0].b === 2,
  'X4a [setup, RESTATED — see the block above]: the stick armed on button 0, and the CHORD WINDOW had already put the knob home at the primary release (t ' + chordT + ', read before the button-2 release) — while the ONE pointerup the stick ever receives still carries button 2',
  `t mid ${midX4.stick}, t after the primary release ${chordT}, ups ${JSON.stringify(upsX4.map((e) => e.b))}`);
okRest(restT === 0 && lastStick?.on === false && dist(pA4, pB4) < 0.15,
  'X4 [BRANCH the chord window in pointermove, plus up()\'s absent button test as defence in depth]: he STOPPED and stayed stopped — knob home, .live off, drifting ' + dist(pA4, pB4) + ' m in 0.6 s against the metres a stranded stick would carry him, and the late button-2 pointerup found stick.id already null and re-deflected nothing',
  `t ${restT}, arm ${JSON.stringify(rX4.arm.filter((a) => a.el === 'stick'))}, ${JSON.stringify(pA4)} -> ${JSON.stringify(pB4)}`);
ok(movingHeld === true,
  'X4b [the probe is live, for X5]: idle().moving read TRUE with the stick down — so the false X5 reads below is a measurement and not a constant',
  `moving while held ${movingHeld}`);

/* ------------------------------------------------------------
   X5 — JUMP'S CHORDED RELEASE, AND THE LATCH BEHIND IT.

   Same rule, third copy (jumpUp). The DOM half is the 'down' class
   coming off. The half that matters is jumpHeld: it is an input to
   moving() (touch.js), so a latched jumpHeld is a five-second idle
   clock that can never fire again — the feature the I section tests,
   silently dead. X4b just proved that flag reads true when it should.
   ------------------------------------------------------------ */
await toOpenGround();
await reset();
await mouse('mouseMoved', JUMP.x, JUMP.y);
await mouse('mousePressed', JUMP.x, JUMP.y, 'left', 1);
const airX5 = await airborneWithin(1800);          // polled, not sampled
await mouse('mousePressed', JUMP.x, JUMP.y, 'right', 3);
await page.waitForTimeout(70);
await mouse('mouseReleased', JUMP.x, JUMP.y, 'left', 2);
await page.waitForTimeout(70);
await mouse('mouseReleased', JUMP.x, JUMP.y, 'right', 0);
await page.waitForTimeout(2600);
const rX5 = await read();
const idleX5 = await idleGet();
const upsX5 = rX5.ev.filter((e) => e.t === 'pointerup' && e.on === 'jump');
const lastJump = rX5.arm.filter((a) => a.el === 'jump').pop();
ok(armedOn(rX5, 'jump') && airX5.jumped && upsX5.length === 1 && upsX5[0].b === 2,
  'X5a [setup]: Jump armed on button 0 and really left the ground, and the ONE pointerup it received carries button 2',
  `peak vy ${airX5.vy}, grounded ${airX5.grounded}, seen after ${airX5.ms} ms, ups ${JSON.stringify(upsX5.map((e) => e.b))}`);
okRest(lastJump?.on === false && rX5.grounded === true && idleX5.moving === false,
  'X5 [BRANCH jumpUp from a button-2 pointerup]: the chorded release disarmed Jump AND cleared jumpHeld — idle().moving is false with him back on the ground, so the idle clock can still fire',
  `arm ${JSON.stringify(rX5.arm.filter((a) => a.el === 'jump'))}, grounded ${rX5.grounded}, vy ${rX5.vy}, moving ${idleX5.moving}`);

/* ------------------------------------------------------------
   X6 — JUMP'S OWN detail-0 CLICK.

   P9 and P10 cover bindPress's click listener. Jump is not a bindPress
   button: it has a separate click handler of its own (jumpHeld = true,
   then jumpUp 140 ms later), and no assertion in this file had entered
   it. A keyboard or screen-reader player who can open every door and
   press every shortcut but cannot jump is the gap this closes.
   ------------------------------------------------------------ */
await toOpenGround();
await reset();
const kbJ = await page.evaluate(() => {
  const b = document.querySelector('.w-acts .w-abtn.jump');
  b.focus();
  const focused = document.activeElement === b;
  b.click();
  return { focused };
});
const airJ = await airborneWithin(1800);
const rX6 = await read();
const cJ = rX6.ev.filter((e) => e.t === 'click');
ok(kbJ.focused && cJ.length === 1 && cJ[0].d === 0 && cJ[0].on === 'jump' && rX6.ev.every((e) => e.t !== 'pointerdown'),
  'X6a [setup]: the activation was the AT shape on JUMP — one click, detail 0, no pointerdown in front of it',
  JSON.stringify(rX6.ev));
ok(airJ.jumped,
  'X6 [BRANCH jumpBtn click, detail 0]: a keyboard / assistive-technology activation on Jump still jumps',
  `peak vy ${airJ.vy}, grounded ${airJ.grounded}, seen after ${airJ.ms} ms`);
await page.waitForTimeout(1600);

/* ------------------------------------------------------------
   X7 — THE OTHER THUMB LIFTING IS NOT THE STICK LIFTING.

   P8 puts two contacts down and reads the door. It cannot see this,
   because the verb it fires raises a sheet that releases the pad
   anyway — P8 prints "stick still down t=0" and is right to. So the
   claim "walking on the stick survives the second thumb" is measured
   here instead, with a second control that opens nothing (Jump), and
   the branch is up()'s `e.pointerId !== stick.id` early return: the
   jump contact's pointerup must not take the stick with it.

   X7b is the discriminator. A stick that can NEVER be released passes
   X7, so its own contact is lifted afterwards and required to stop him.
   ------------------------------------------------------------ */
await toOpenGround();
await reset();
await multi('touchStart', [P(STICK.x, STICK.y, 11)]);
await page.waitForTimeout(60);
await multi('touchMove', [P(STICK.x + 6, STICK.y - 40, 11)]);
await page.waitForTimeout(60);
await multi('touchMove', [P(STICK.x + 8, STICK.y - 62, 11)]);
await page.waitForTimeout(300);
const walk7 = await stickT();
await multi('touchStart', [P(STICK.x + 8, STICK.y - 62, 11), P(JUMP.x, JUMP.y, 12)]);
await page.waitForTimeout(140);
const both7 = await page.evaluate(() => ({
  jump: document.querySelector('.w-acts .w-abtn.jump').classList.contains('down'),
  t: +(WALLY.debug.touchState().t ?? 0).toFixed(2),
}));
await multi('touchEnd', [P(JUMP.x, JUMP.y, 12)]);        // ONLY the jump contact lifts
await page.waitForTimeout(400);
const after7 = await page.evaluate(() => ({
  jump: document.querySelector('.w-acts .w-abtn.jump').classList.contains('down'),
  t: +(WALLY.debug.touchState().t ?? 0).toFixed(2),
  live: document.querySelector('.w-stick').classList.contains('live'),
}));
const pA7 = await posNow();
await page.waitForTimeout(600);
const pB7 = await posNow();
await multi('touchEnd', [P(STICK.x + 8, STICK.y - 62, 11)]);   // now the stick's own
await page.waitForTimeout(500);
const end7 = await stickT();
const pC7 = await posNow();
await page.waitForTimeout(600);
const pD7 = await posNow();
ok(walk7 > 0.5 && both7.jump === true && both7.t > 0.5 && after7.jump === false,
  'X7a [setup — the contact under test is the one that moved]: he was walking (t ' + walk7 + '), the SECOND contact armed Jump, and that contact really lifted (its .down came off)',
  JSON.stringify({ walk7, both7, after7 }));
okRest(after7.t > 0.5 && after7.live === true && dist(pA7, pB7) > 0.3,
  'X7 [BRANCH stick up(), pointerId mismatch early return]: the other thumb lifting left the stick deflected and him still walking — he covers ' + dist(pA7, pB7) + ' m in the 0.6 s after it',
  `t ${after7.t}, live ${after7.live}, ${JSON.stringify(pA7)} -> ${JSON.stringify(pB7)}`);
okRest(end7 === 0 && dist(pC7, pD7) < 0.15,
  'X7b [the discriminator]: lifting the STICK\'S OWN contact does release it and does stop him (' + dist(pC7, pD7) + ' m in 0.6 s) — X7 is an early return keyed on pointerId, not a stick that cannot be let go',
  `t ${end7}, ${JSON.stringify(pC7)} -> ${JSON.stringify(pD7)}`);

/* ============================================================
   X8 — THE DOOR GATE, END TO END.

   G1..G3 prove the precondition can read dirty and that okDoor's
   refusal is a real early return. What they do NOT exercise is the
   path that actually protects the file: toDoor() making that
   measurement ITSELF and publishing it. G3 sets DOOR by hand, which is
   a test of the blocker and not of the gate.

   So: raise a card in the gap between toDoor's dismissal and toDoor's
   measurement (the afterDismiss hook, which exists for this and has no
   other caller), and require toDoor to fail its own DOORGATE line,
   publish clean:false, and block the next door claim — a TRUE one.
   Two deliberate failures are counted and then subtracted, and X8b is
   the positive control that DOOR is not left stuck dirty afterwards.
   ============================================================ */
console.log('\n--- X8: THE DOOR GATE, END TO END ---');
await page.evaluate(() => { WALLY.debug.idle(null); WALLY.debug.hideUI(false); WALLY.ctx.ui.closeAll(); });
await page.waitForTimeout(700);
const f0 = fails;
await toDoor('X8 — THE FAIL ON THE NEXT LINE IS THE ASSERTION', () => page.evaluate(() => { WALLY.ctx.ui.dialogue(); }));
const dirtyX8 = { ...DOOR };
const blockedX8 = okDoor(true, 'X8 [self-test, EXPECTED BLOCKED]: a claim that is TRUE, refused because toDoor measured a card at the door');
const spentX8 = fails - f0;
fails = f0;                                        // undo both deliberate ones
ok(dirtyX8.clean === false && dirtyX8.card === true && dirtyX8.near !== null
   && blockedX8 === false && spentX8 === 2,
  'X8 [BRANCH toDoor()\'s own clean=false path]: a card raised at the door makes toDoor FAIL its DOORGATE line and publish a dirty verdict, and the next door assertion is blocked rather than evaluated — the gate is the file\'s, not the self-test\'s',
  `verdict ${JSON.stringify({ clean: dirtyX8.clean, near: dirtyX8.near, card: dirtyX8.card, dlgOpen: dirtyX8.dlgOpen })}, okDoor returned ${blockedX8}, failures spent ${spentX8}`);
await page.evaluate(() => { WALLY.ctx.ui.hide('dialogue'); WALLY.ctx.ui.closeAll(); });
await page.waitForTimeout(500);
door = await toDoor('X8-recover');
await reset();
await tap(ACT.x, ACT.y, 70);
await page.waitForTimeout(800);
const rX8 = await read();
const whyX8 = await page.evaluate(() => WALLY.debug.interact());
okDoor(rX8.verbs.includes('interact') && rX8.panels.includes('place') && whyX8.path === 'door',
  'X8b [positive control]: with the card dismissed the gate reads clean again and okDoor EVALUATES — a tap on Enter opens the door by the door branch, so the block above was transient state and not a suite that has stopped asserting',
  `verbs ${JSON.stringify(rX8.verbs)}, panels ${JSON.stringify(rX8.panels)}, why ${JSON.stringify(whyX8.path)}`);
await closeAll();
await page.evaluate(() => { WALLY.debug.idle(null); WALLY.debug.hideUI(false); WALLY.ctx.ui.closeAll(); });
await page.waitForTimeout(500);

/* ============================================================================
   D — THE TAB-FOCUS STALENESS. The round under test.

   THE DEFECT AS THE PLAYER MET IT. A genuine Tab puts the ring on a pad
   button. That is the supported assistive route and PAD-30 exists to protect
   it. Every later pad contact then calls e.preventDefault() on its own
   pointerdown FIRST -- the PAD-29 fix, which is what stops a press taking
   focus -- and the same call means nothing ever takes that focus AWAY again.
   So the bookmark sticks, the detail-0 click listener at the bottom of
   bindPress goes on answering to it, and the player who tabbed to Menu,
   walked on the thumbstick, and pressed SPACE meaning JUMP got a pause sheet.
   Only a tap on the CANVAS cleared it.

   THE FIX UNDER TEST is `driving` in src/ui/touch.js: a routing flag set by a
   contact only a player on their thumbs produces (stick down(), jump
   pointerdown, and a shortcut at its FIRE POINT in bindPress's `end`), read
   by the one new early return `if (driving) return` in the detail-0 click
   listener, and cleared by a `focusin` anywhere in the pad root. Focus is
   deliberately NOT blurred.

   WHY EVERY CLAIM HERE IS PAIRED. "Space jumps" is green on a page where
   Space was never stolen in the first place, and "the button still answers
   Tab-then-Space" is green on a pad whose buttons all fire on everything. So
   each measurement below carries its own discriminator:

     · D0 runs BEFORE anything sets `driving` and proves the theft is LIVE --
       a tabbed button really does eat Space and Enter. Without D0 green, D2's
       green would be free.
     · D2 asserts BOTH halves in one line: peak vy from a poll (never a
       handler count) AND an empty verb/panel list. A Space that jumped and
       ALSO opened the phone is a fail here, and would have been a pass for a
       suite that only looked at vy.
     · D2's setup reads WALLY.debug.padKeyboard() at three moments and
       requires the transition padTakesSpace true -> false. A fixture where
       the Tab silently missed reads padFocused false and is refused, not
       passed.
   ============================================================================ */
console.log('\n--- D: THE TAB-FOCUS STALENESS ---');
await page.evaluate(() => { WALLY.debug.idle(null); WALLY.debug.hideUI(false); WALLY.ctx.ui.closeAll(); });
await page.waitForTimeout(500);

/* WALLY.debug.padKeyboard() is touch.js's own report of the routing
   decision: `driving`, where the bookmark actually sits, and the one
   sentence a player would say -- would Space fire the focused button. */
const padKb = () => page.evaluate(() => WALLY.debug.padKeyboard());
/** activeElement, named, and whether it is inside the pad root. */
const activeNow = () => page.evaluate(() => {
  const a = document.activeElement;
  const inPad = !!(a && a !== document.body && a.closest?.('.w-touch'));
  return { tag: a ? a.tagName : null, label: a?.getAttribute?.('aria-label') ?? null,
    cls: a && a !== document.body ? String(a.className || '') : null, inPad, isBody: a === document.body };
});
/* THE PAD'S FOCUSABLE POPULATION, PUBLISHED ONCE so every D fixture, the
   tab-order walk and the fade section all talk about the same six elements.
   The stick is not focusable and is not here; it is still one of the seven
   controls in D8's gate matrix. */
await page.evaluate(() => {
  window.__dEls = {
    act: document.querySelector('.w-acts .w-abtn.act'),
    jump: document.querySelector('.w-acts .w-abtn.jump'),
  };
  [...document.querySelectorAll('.w-acts .shortcuts .w-abtn')].forEach((b, i) => { window.__dEls['sc' + i] = b; });
});
const D_FOCUSABLE = [
  { k: 'act', pt: ACT, label: 'Enter or talk' },
  { k: 'jump', pt: JUMP, label: 'Jump' },
  { k: 'sc0', pt: SC[0], label: 'Phone' },
  { k: 'sc1', pt: SC[1], label: 'Places' },
  { k: 'sc2', pt: SC[2], label: 'Desk' },
  { k: 'sc3', pt: SC[3], label: 'Menu' },
];
/* KEYS GO THROUGH PLAYWRIGHT. nativeVirtualKeyCode is a macOS keycode on
   macOS and a hand-rolled Windows one starts an auto-repeat storm of a
   DIFFERENT key -- see the block above P10. */
const dKey = (k) => page.keyboard.press(k);
/** A GENUINE Tab traversal to one of the six, never el.focus(). Returns the
    number of Tabs it took, or 0 if it never arrived -- which every caller
    treats as a refusal to measure rather than as a result. */
async function tabTo(k, max = 40) {
  await page.evaluate(() => { document.activeElement?.blur?.(); });
  await page.waitForTimeout(60);
  for (let i = 0; i < max; i++) {
    await dKey('Tab');
    const hit = await page.evaluate((kk) => document.activeElement === window.__dEls[kk], k);
    if (hit) return i + 1;
  }
  return 0;
}
/** Walk the whole tab order from the top and record, in order, which of the
    six pad buttons it lands on. `dir` -1 walks it backwards with Shift+Tab. */
/* THE TAB ORDER IS A CYCLE, AND THE FIRST WRITING OF THIS COMPARED RAW
   PREFIXES. 46 Tabs round a six-button page wrap several times, and the
   forward and backward walks do not start from the same place — the
   browser resumes sequential navigation from wherever focus last was, so
   the forward walk opened on sc3 and the backward one on act. Comparing
   the two lists head-to-head therefore reported a mismatch for two
   traversals that are in fact exact reverses of each other. What the
   claim is actually about is the CYCLE, so the cycle is what is
   extracted and compared. */
async function tabWalk(dir = 1, steps = 44) {
  await page.evaluate(() => { document.activeElement?.blur?.(); });
  await page.waitForTimeout(60);
  const seen = [];
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press(dir === 1 ? 'Tab' : 'Shift+Tab');
    const k = await page.evaluate(() => {
      const a = document.activeElement;
      return Object.keys(window.__dEls).find((n) => window.__dEls[n] === a) ?? null;
    });
    if (k && seen[seen.length - 1] !== k) seen.push(k);
  }
  const cyc = [];
  for (let i = 0; i < seen.length; i++) { if (i > 0 && seen[i] === seen[0]) break; cyc.push(seen[i]); }
  return { seen, cyc };
}
const rot = (a, k) => a.slice(k).concat(a.slice(0, k));
/** Same buttons, same order, read from a different starting point. */
const sameCycle = (a, b) => a.length > 0 && a.length === b.length
  && a.some((_, i) => JSON.stringify(rot(a, i)) === JSON.stringify(b));
/* THE THREE CONTACTS THAT SET `driving`, one per branch of the fix. Each is a
   REAL touch contact through Input.dispatchTouchEvent -- pointerType 'touch',
   which is what direct() tests for. A mouse press would leave `driving` false
   by design and would make every D2 row green for the wrong reason. */
/* ============================================================
   SPACE HAS TO BE HELD, AND THE FIRST WRITING OF THIS TAPPED IT.

   page.keyboard.press('Space') is a keydown and a keyup a few
   milliseconds apart. wally.js LATCHES keys.Space on keydown and SAMPLES
   it in the update loop, so on a loaded box — where a frame can be tens
   of milliseconds wide — the press opens and closes between two frames
   and the jump never happens. Measured, and it is not a subtle rate: 17
   of 18 rows read peak vy 0.00, and the one that jumped read 7.43, which
   is what identifies a sampling race rather than a refused key.

   That would have been reported as "the fix broke Space" — a red that
   says nothing about the pad, in the section whose whole purpose is to
   say something about the pad. So the key is HELD across the poll, the
   way P3 holds the mouse button across airborneWithin and the way
   tools/_vjpad-focus.mjs S1 holds Space across its own.

   AND THE ANSWER IS PEAK VERTICAL VELOCITY PLUS HEIGHT GAINED, never a
   handler count and never `grounded` on its own: touch.js's own header
   records that grounded FLICKERS on a ground snap, so a jumped flag
   built on it can go true with nobody leaving the floor. Height gained
   cannot.
   ============================================================ */
async function dJump(ms = 1700) {
  const y0 = await page.evaluate(() => WALLY.ctx.wally.position.y);
  await page.keyboard.down(' ');
  const t0 = Date.now();
  let vy = 0, top = y0, air = false;
  while (Date.now() - t0 < ms) {
    const s = await page.evaluate(() => ({ vy: +WALLY.ctx.wally.controller.velocity.y.toFixed(2),
      g: WALLY.ctx.wally.controller.grounded, y: WALLY.ctx.wally.position.y }));
    if (s.vy > vy) vy = s.vy;
    if (s.y > top) top = s.y;
    if (!s.g) air = true;
    await page.waitForTimeout(45);
  }
  await page.keyboard.up(' ');
  await page.waitForTimeout(250);
  return { vy, rise: +(top - y0).toFixed(3), air };
}
const D_CONTACT = {
  /* BRANCH src/ui/touch.js stick down(): `if (direct(e)) driving = true` */
  stick: async () => {
    await multi('touchStart', [P(STICK.x, STICK.y, 9)]);
    await page.waitForTimeout(60);
    for (let i = 1; i <= 4; i++) { await multi('touchMove', [P(STICK.x + 4, STICK.y - i * 18, 9)]); await page.waitForTimeout(40); }
    const t = await stickT();
    await page.waitForTimeout(220);
    await multi('touchEnd', [P(STICK.x + 4, STICK.y - 72, 9)]);
    await page.waitForTimeout(320);
    return { proof: 'stick t ' + t, ok: t > 0.5 };
  },
  /* BRANCH jumpBtn pointerdown: `if (direct(e)) driving = true` */
  jump: async () => {
    await multi('touchStart', [P(JUMP.x, JUMP.y, 9)]);
    await page.waitForTimeout(140);
    const down = await page.evaluate(() => document.querySelector('.w-acts .w-abtn.jump').classList.contains('down'));
    await multi('touchEnd', [P(JUMP.x, JUMP.y, 9)]);
    await page.waitForTimeout(700);                  // let the hop finish
    return { proof: 'jump armed ' + down, ok: down === true };
  },
  /* BRANCH bindPress `end`, at the FIRE POINT -- past the rect test, past
     controlsLive, pointerType touch. Deliberately the only one of the three
     that waits for the press to actually fire. */
  shortcut: async () => {
    await reset();
    /* THE CONTACT IS SPLIT SO THE BOOKMARK CAN BE READ WHILE IT IS DOWN.
       The first writing read activeElement 650 ms after the tap, by which
       time the verb had run and its SHEET was up — so "BODY" there was a
       reading about the phone panel, not about the pad, and it could not
       tell the two apart. The question is whether the PAD's own contact
       moves the keyboard's bookmark, and the only moment that answers it
       is with the finger down and the verb not yet run: bindPress fires
       at pointerup. */
    await multi('touchStart', [P(SC[0].x, SC[0].y, 9)]);
    await page.waitForTimeout(110);
    const atContact = await activeNow();
    await multi('touchEnd', [P(SC[0].x, SC[0].y, 9)]);
    await page.waitForTimeout(650);
    const rr = await read();
    const afterVerb = await activeNow();
    const fired = rr.verbs.includes('openPhone') || rr.panels.includes('phone');
    /* THE BOOKMARK IS READ HERE, WITH THE SHEET STILL UP, and that is the
       whole difference between two very different claims. This shortcut's
       verb OPENS A PANEL, and dialogue/menu code gives its own first
       control focus; closing that panel then removes the focused node and
       activeElement falls back to <body>. Measured after the close, all
       six shortcut rows read BODY — which says nothing about whether the
       PAD took the bookmark away, and the pad is what this section is
       about. Read at the fire point it separates the two exactly. */
    /* close WITHOUT blurring -- closeAll() in this file also blurs, and a
       blur here would clear the very bookmark the fixture is about. */
    await page.evaluate(() => WALLY.ctx.ui.closeAll());
    await page.waitForTimeout(450);
    return { proof: 'phone fired ' + fired, ok: fired, atContact, afterVerb };
  },
};

/* ---------------------------------------------------------------------------
   D0 — THE DISCRIMINATOR, AND IT RUNS FIRST.
   BRANCH: bindPress / jumpBtn `click` listener, detail 0, with `driving`
   FALSE. This is both the assistive path the fix must not break AND the
   proof that a tabbed pad button really does own the next keystroke -- so
   every "Space jumped instead" below is a claim that could have failed.
   --------------------------------------------------------------------------- */
const d0 = [];
for (const c of D_FOCUSABLE) {
  for (const kc of ['Space', 'Enter']) {
    await toOpenGround();
    await flushKeys();
    await page.evaluate(() => WALLY.ctx.ui.closeAll());
    const steps = await tabTo(c.k);
    const kb = await padKb();
    await reset();
    let air = null;
    if (c.k === 'jump') { await dKey(kc); air = await airborneWithin(1600); }   // the AT click is edge-triggered, so a tap is the right fixture here
    else { await dKey(kc); await page.waitForTimeout(650); }
    const rr = await read();
    const acted = c.k === 'jump' ? (air.jumped === true) : (rr.verbs.length > 0 || rr.panels.length > 0);
    d0.push({ ctl: c.k, key: kc, steps, acted, kb, verbs: rr.verbs, panels: rr.panels, air,
      clicks: rr.ev.filter((e) => e.t === 'click').map((e) => [e.on, e.d]) });
    await closeAll();
  }
}
const d0miss = d0.filter((x) => x.steps === 0);
ok(d0miss.length === 0,
  `D0a [setup — a GENUINE Tab, never el.focus()]: a real Tab traversal lands on each of the ${D_FOCUSABLE.length} pad buttons. (The step counts differ because the browser resumes sequential navigation from wherever focus last sat; the claim about the ORDER is D5's, which walks a whole cycle.)`,
  JSON.stringify(d0.filter((x) => x.key === 'Space').map((x) => [x.ctl, x.steps + ' tabs'])));
const d0stale = d0.filter((x) => !(x.kb.padFocused === true && x.kb.driving === false && x.kb.padTakesSpace === true));
ok(d0stale.length === 0,
  'D0b [setup]: at the moment each key was pressed the pad reported padFocused true, driving false, padTakesSpace TRUE — the button really did own the keystroke',
  d0stale.length ? JSON.stringify(d0stale.map((x) => [x.ctl, x.key, x.kb])) : `${d0.length}/${d0.length} rows`);
/* THE JUMP ROWS ARE JUDGED ON VELOCITY. `grounded` flickers on a ground
   snap (touch.js's own header says so), so a jumped flag resting on it
   can go true with nobody leaving the floor. */
const d0dead = d0.filter((x) => (x.ctl === 'jump' ? !(x.acted && x.air.vy > 0.8) : !x.acted));
ok(d0dead.length === 0,
  'D0 [BRANCH the detail-0 click listener with driving FALSE — THE ASSISTIVE PATH, AND BREAKING IT IS WORSE THAN THE BUG]: every pad button, reached by a genuine Tab, still activates on BOTH Space and Enter',
  d0dead.length ? JSON.stringify(d0dead.map((x) => [x.ctl, x.key, x.verbs, x.panels, x.air]))
    : `${d0.length}/${d0.length} activated; Jump's two rows by peak vy ${JSON.stringify(d0.filter((x) => x.ctl === 'jump').map((x) => [x.key, x.air.vy]))}`);
const d0detail = d0.filter((x) => x.clicks.some((cl) => cl[1] !== 0));
ok(d0detail.length === 0,
  'D0c [BRANCH the detail test itself]: every one of those activations arrived as a click with detail 0 — the assistive shape, not a synthesised pointer',
  JSON.stringify(d0.map((x) => [x.ctl, x.key, x.clicks])));

/* ---------------------------------------------------------------------------
   D1/D2 — TAB, THEN A THUMB, THEN SPACE. THE WHOLE DEFECT.
   BRANCH: `if (driving) return` in the detail-0 click listener, with driving
   set by each of its three writers in turn. 6 buttons x 3 contacts = 18.
   --------------------------------------------------------------------------- */
const d2 = [];
for (const c of D_FOCUSABLE) {
  for (const [cname, contact] of Object.entries(D_CONTACT)) {
    await toOpenGround();
    await flushKeys();
    await page.evaluate(() => WALLY.ctx.ui.closeAll());
    const steps = await tabTo(c.k);
    const kbBefore = await padKb();
    const proof = await contact();
    const kbAfter = await padKb();
    const actAfter = await activeNow();
    await toOpenGround();                      // back to open ground for the jump
    await flushKeys();
    await page.evaluate(() => WALLY.ctx.ui.closeAll());
    await reset();
    const air = await dJump(1700);              // HELD, not tapped — see the block above dJump
    const rr = await read();
    d2.push({ ctl: c.k, contact: cname, steps, proof, kbBefore, kbAfter, actAfter,
      air, verbs: rr.verbs, panels: rr.panels });
    await closeAll();
  }
}
const d2bad = d2.filter((x) => x.steps === 0 || !x.proof.ok
  || x.kbBefore.padTakesSpace !== true || x.kbAfter.driving !== true);
ok(d2bad.length === 0,
  `D1 [setup — the fixture is the defect's own recipe]: in all ${d2.length} rows a genuine Tab landed on the button (padTakesSpace TRUE), the contact really happened, and the pad then reported driving TRUE`,
  d2bad.length ? JSON.stringify(d2bad.map((x) => [x.ctl, x.contact, x.steps, x.proof, x.kbBefore, x.kbAfter]))
    : `${d2.length}/${d2.length}: padTakesSpace true -> driving true`);
const d2dead = d2.filter((x) => !(x.air.vy > 1.5 && x.air.rise > 0.15));
ok(d2dead.length === 0,
  'D2 [BRANCH `if (driving) return`, measured as PEAK VERTICAL VELOCITY AND HEIGHT GAINED]: after a Tab and a thumb, the Space the player meant as JUMP jumps — all ' + d2.length + ' rows leave the ground, peak vy ' +
  Math.min(...d2.map((x) => x.air.vy)).toFixed(2) + '..' + Math.max(...d2.map((x) => x.air.vy)).toFixed(2) + ', rising ' +
  Math.min(...d2.map((x) => x.air.rise)).toFixed(2) + '..' + Math.max(...d2.map((x) => x.air.rise)).toFixed(2) + ' m',
  d2dead.length ? JSON.stringify(d2dead.map((x) => [x.ctl, x.contact, x.air])) : JSON.stringify(d2.map((x) => [x.ctl, x.contact, x.air.vy, x.air.rise])));
const d2stole = d2.filter((x) => x.verbs.length > 0 || x.panels.length > 0);
ok(d2stole.length === 0,
  'D2b [THE OTHER HALF OF THE SAME LINE]: not one of those 18 Spaces also ran the focused button\'s verb — a Space that jumped AND opened the phone would pass a vy-only assertion and is a failure here',
  d2stole.length ? JSON.stringify(d2stole.map((x) => [x.ctl, x.contact, x.verbs, x.panels])) : 'verbs [] panels [] on 18/18');
/* D2c IS SPLIT, AND THE SPLIT IS THE FINDING RATHER THAN A CONCESSION.
   The stick and Jump touch nothing but the pad, so their rows answer the
   design claim directly. A SHORTCUT's verb opens a sheet, that sheet
   takes focus for its own controls, and closing it removes the focused
   node — so activeElement is at <body> afterwards for a reason that has
   nothing to do with this pad or this fix, and asserting on the reading
   after the close would have blamed the pad for the panel's doing. The
   pad's own behaviour is read at the FIRE POINT instead, which is the
   last moment before the sheet exists. */
const d2yanked = d2.filter((x) => x.contact !== 'shortcut' && x.actAfter.inPad !== true);
ok(d2yanked.length === 0,
  'D2c [BRANCH the deliberate NON-blur, on the two contacts that touch nothing but the pad]: after a thumb on the stick or on Jump, the keyboard\'s bookmark is still on the pad button the player tabbed to — blur() would have fixed the same symptom by restarting sequential navigation from the top of the document, which under a screen reader mid-traversal is the worse failure',
  JSON.stringify(d2.filter((x) => x.contact !== 'shortcut').map((x) => [x.ctl, x.contact, x.actAfter.label ?? x.actAfter.tag])));
const d2fire = d2.filter((x) => x.contact === 'shortcut');
ok(d2fire.every((x) => x.proof.atContact?.inPad === true),
  'D2d [the same claim on the shortcut path, read WITH THE FINGER STILL DOWN]: a real touch contact on a shortcut does not move the keyboard\'s bookmark off the button the player tabbed to — bindPress fires at pointerup, so this is the pad\'s contact and nothing else. Focus is at <body> after the verb because the SHEET it opened is a different piece of code with its own focus handling; that is reported beside each row rather than blamed on this fix',
  JSON.stringify(d2fire.map((x) => [x.ctl,
    'with the finger down: ' + (x.proof.atContact?.label ?? x.proof.atContact?.tag),
    'after the verb (sheet up): ' + (x.proof.afterVerb?.label ?? x.proof.afterVerb?.tag),
    'after the sheet closed: ' + (x.actAfter.label ?? x.actAfter.tag)])));
/* AND THE REFUSAL DOES NOT DEPEND ON THE BOOKMARK SURVIVING. Those six
   rows lost focus to <body> and D2/D2b still passed for them, because
   `driving` is the routing flag and padFocused is not consulted by the
   click listener's early return. Stated so the split above cannot be
   read as six rows quietly excused. */
ok(d2fire.every((x) => x.kbAfter.driving === true && x.air.vy > 1.5),
  'D2e [the six excused rows are still asserted]: on every shortcut row the pad reported driving TRUE and Space still jumped — the refusal rides on `driving`, not on where the bookmark ended up, so nothing was excused by the split above',
  JSON.stringify(d2fire.map((x) => [x.ctl, x.kbAfter.driving, x.air.vy])));

/* ---------------------------------------------------------------------------
   D3 — AND ENTER STILL INTERACTS.
   "Enter" on this pad is TWO different things and they are measured
   separately, because conflating them is how a green would mean nothing:

     · the pad's ENTER-OR-TALK BUTTON, pressed with a thumb (D3a). This is
       the control the player actually has on a phone.
     · the ENTER KEY (D3b). src/ui/ui.js binds the game's interact to KeyE,
       NOT to Enter — the Enter key only ever reaches interact() THROUGH the
       focused pad button's detail-0 click. So after a thumb, a refused Enter
       does nothing at all, and that is the fix's stated cost, reported here
       as a measurement rather than asserted as a feature.
     · the game's own KeyE (D3c), which the pad never touches.
   BRANCH: bindPress `end` on the primary path (D3a); the same
   `if (driving) return` as D2 (D3b); ui.js onKey case 'KeyE' (D3c).
   --------------------------------------------------------------------------- */
const d3 = [];
/* THE CONTACT HERE IS JUMP OR A SHORTCUT, NOT THE STICK, AND THAT IS THE
   FIXTURE RATHER THAN A PREFERENCE: the stick WALKS HIM, and a door that has
   gone out of range makes every reading below "nothing happened" for a reason
   that is not the pad. Both of these set `driving` through their own writer
   and leave him standing exactly where he was. D2 already covers the stick on
   all six buttons. */
/* BOTH ROWS USE THE JUMP CONTACT, and the first writing of this used the
   shortcut for one of them. A shortcut's verb opens a sheet, the sheet
   takes focus, closing it drops activeElement to <body> — measured, and
   it made the sc3 row read padFocused false, which means its Enter was
   pressed with NOTHING focused and its green would have been free. The
   jump contact sets `driving` through its own writer, opens nothing and
   leaves him standing at the door. The shortcut writer is not skipped;
   D2/D2d/D2e cover it on all six buttons. */
const D3_ROWS = [
  { k: 'sc2', contact: 'jump' },        // Desk, driving set at jumpBtn pointerdown
  { k: 'sc3', contact: 'jump' },        // Menu, same writer, different bookmark
];
const doorNow = () => page.evaluate(() => ({
  near: WALLY.ctx.ui.near?.id ?? null,
  dlgOpen: !!WALLY.ctx.ui.dialogueOpen,
  card: !!document.querySelector('.w-dlg:not(.out)'),
  panels: WALLY.ctx.ui.panels.slice(),
  modal: !!WALLY.ctx.ui.modal,
}));
for (const row of D3_ROWS) {
  door = await toDoor('D3 ' + row.k);
  const steps = await tabTo(row.k);
  const kbB = await padKb();
  await D_CONTACT[row.contact]();
  /* THE DOOR GATE, RE-MEASURED IN PLACE. toDoor() is not called again on
     purpose — arrive() raises an arrival card, and dialogue.js gives its
     first choice focus, which would move the very bookmark this row is
     about. So the precondition is re-READ instead of re-established, and
     a dirty read blocks the row rather than quietly changing its branch. */
  const dstate = await doorNow();
  const stillClean = dstate.near !== null && !dstate.dlgOpen && !dstate.card
    && dstate.panels.length === 0 && !dstate.modal;
  DOOR = { clean: stillClean, why: stillClean ? '' : JSON.stringify(dstate), ...dstate };
  const kbA = await padKb();
  await reset();
  await dKey('Enter');
  await page.waitForTimeout(700);
  const rEnterKey = await read();
  const whyKey = await page.evaluate(() => WALLY.debug.interact());
  await reset();
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); });
  await page.waitForTimeout(300);
  await tap(ACT.x, ACT.y, 80);
  await page.waitForTimeout(800);
  const rEnterBtn = await read();
  const whyBtn = await page.evaluate(() => WALLY.debug.interact());
  await reset();
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); });
  await page.waitForTimeout(300);
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(700);
  const whyE = await page.evaluate(() => WALLY.debug.interact());
  const rE = await read();
  d3.push({ ctl: row.k, contact: row.contact, steps, kbB, kbA, clean: stillClean, dstate,
    key: { verbs: rEnterKey.verbs, panels: rEnterKey.panels, why: whyKey.path + '/' + whyKey.ok },
    btn: { verbs: rEnterBtn.verbs, panels: rEnterBtn.panels, why: whyBtn.path + '/' + whyBtn.ok },
    e: { verbs: rE.verbs, panels: rE.panels, why: whyE.path + '/' + whyE.ok } });
  await closeAll();
}
DOOR = { clean: d3.every((x) => x.clean), why: d3.map((x) => x.why ?? '').join(''), ...(d3[0]?.dstate ?? {}) };
okDoor(d3.every((x) => x.steps > 0 && x.kbB.padTakesSpace === true
  && x.kbA.driving === true && x.kbA.padFocused === true),
  'D3-pre [setup]: both rows tabbed to a SHORTCUT — whose verb is openDesk / show(pause) and never interact(), so the door opening below cannot be the focused button firing — the contact set driving, and the bookmark was STILL on that shortcut when the keys were pressed',
  JSON.stringify(d3.map((x) => [x.ctl, x.contact, x.steps, x.kbB.padTakesSpace, x.kbA])));
okDoor(d3.every((x) => x.btn.verbs.includes('interact') && x.btn.panels.includes('place') && x.btn.why === 'door/true'),
  'D3a [BRANCH bindPress end, primary, after the Tab and the thumb]: the pad\'s ENTER-OR-TALK button under a real finger still opens the door, by interact()\'s DOOR branch — the control the player actually has on a phone is untouched',
  JSON.stringify(d3.map((x) => [x.ctl, x.btn])));
/* THE EMPTY `verbs` LIST HERE IS THE DISCRIMINATOR, NOT A MISS, and the
   first writing of this asserted the opposite and went red for it. The
   probe wraps ui.interact as an API PROPERTY, which is what touch.js
   calls; ui.js's KeyE handler calls the module-local interact() and
   never touches that property — this file's own header says so at THE
   VERB. So a KeyE that opens the door with verbs EMPTY is proof the door
   opened through the GAME's path and not through the pad, which is
   exactly the claim. Judged on the door: the panel that came up and
   WALLY.debug.interact()'s own report of which branch ran. */
okDoor(d3.every((x) => x.e.panels.includes('place') && x.e.why === 'door/true' && x.e.verbs.length === 0),
  'D3c [BRANCH ui.js onKey case KeyE]: the game\'s own interact key still interacts after all of it — the door opens by interact()\'s DOOR branch with the pad\'s wrapped API untouched (verbs []), which is what shows the key reached the GAME and was not re-routed through a focused button',
  JSON.stringify(d3.map((x) => [x.ctl, x.e])));
const d3keyRan = d3.filter((x) => x.key.verbs.length > 0 || x.key.panels.length > 0);
console.log('   NOTE  D3b — the ENTER KEY after a Tab and a thumb: ' + JSON.stringify(d3.map((x) => [x.ctl, x.key])) + '. src/ui/ui.js binds the game\'s interact to KeyE and NOT to Enter, so the Enter key reaches a verb only THROUGH the focused pad button\'s detail-0 click, which `driving` refuses. A player who tabbed to a shortcut and then used their thumbs therefore has a dead Enter KEY until they Tab again (D4 restores it in one Tab). That is the cost this design states in its own header; reported as a measurement, not asserted as a feature.');
okDoor(d3keyRan.length === 0,
  'D3b [BRANCH the refusal, on the Enter key]: that refused Enter did not run the SHORTCUT\'s verb either — the refusal is a refusal and not a redirect, so nothing opened behind the player\'s back',
  JSON.stringify(d3.map((x) => [x.ctl, x.key.verbs, x.key.panels])));

/* ---------------------------------------------------------------------------
   D4 — THE HANDBACK. BRANCH: the capture-phase `focusin` listener,
   `driving = false`. The refusal has to end, and it has to end on a FOCUS
   rather than on a Tab keystroke: a screen reader moves its own cursor with
   swipes and rotor gestures and never presses Tab.
   --------------------------------------------------------------------------- */
await toOpenGround();
await flushKeys();
await page.evaluate(() => WALLY.ctx.ui.closeAll());
await tabTo('sc3');
await D_CONTACT.stick();
const kbDriving = await padKb();
const tabsBack = await tabTo('sc3');
const kbHandback = await padKb();
await reset();
await dKey('Space');
await page.waitForTimeout(700);
const rD4 = await read();
/* the programmatic half: a bare .focus(), no keystroke anywhere near it */
await toOpenGround();
await flushKeys();
await page.evaluate(() => WALLY.ctx.ui.closeAll());
await tabTo('sc0');
await D_CONTACT.stick();
const kbD4b0 = await padKb();
await page.evaluate(() => { document.activeElement?.blur?.(); window.__dEls.sc2.focus(); });
await page.waitForTimeout(250);
const kbD4b1 = await padKb();
await reset();
await dKey('Space');
await page.waitForTimeout(700);
const rD4b = await read();
ok(kbDriving.driving === true && tabsBack > 0,
  'D4-pre [setup]: the walk really had left driving TRUE, and the Tab really did land back on Menu after ' + tabsBack + ' tabs',
  JSON.stringify({ kbDriving, tabsBack }));
ok(kbHandback.driving === false && kbHandback.padTakesSpace === true
  && (rD4.verbs.length > 0 || rD4.panels.length > 0),
  'D4 [BRANCH focusin -> driving = false]: a fresh Tab hands the keyboard straight back — driving clears, padTakesSpace goes true again, and Space opens the sheet exactly as D0 says it must. The refusal lasts until the player says otherwise and not one keystroke longer',
  `kb ${JSON.stringify(kbHandback)}, verbs ${JSON.stringify(rD4.verbs)}, panels ${JSON.stringify(rD4.panels)}`);
ok(kbD4b0.driving === true && kbD4b1.driving === false && (rD4b.verbs.length > 0 || rD4b.panels.length > 0),
  'D4b [BRANCH the same listener, reached WITHOUT a keystroke]: a bare programmatic .focus() on a different pad button — the shape a screen reader\'s own cursor move arrives as, with no Tab anywhere near it — hands it back too. A Tab-only rule would have left that player refused',
  `driving ${kbD4b0.driving} -> ${kbD4b1.driving}, verbs ${JSON.stringify(rD4b.verbs)}, panels ${JSON.stringify(rD4b.panels)}`);
await closeAll();

/* ---------------------------------------------------------------------------
   D5 — TAB ORDER, FORWARDS AND BACKWARDS.
   BRANCH: the DOM order of .w-acts, with no tabindex anywhere on the pad.
   Shift-Tab must produce the EXACT reverse, not merely "some pad buttons".
   --------------------------------------------------------------------------- */
await toOpenGround();
await flushKeys();
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.idle(null); });
await page.waitForTimeout(400);
const fwd = await tabWalk(1);
const rev = await tabWalk(-1);
ok(fwd.cyc.length === D_FOCUSABLE.length && new Set(fwd.cyc).size === D_FOCUSABLE.length,
  `D5a [BRANCH sequential focus navigation, forwards]: one forward cycle reaches all ${D_FOCUSABLE.length} pad buttons, each exactly once, and closes on itself`,
  `cycle ${JSON.stringify(fwd.cyc)} out of ${fwd.seen.length} landings in 44 tabs`);
ok(sameCycle(fwd.cyc.slice().reverse(), rev.cyc),
  'D5 [BRANCH the same, backwards with Shift-Tab]: Shift-Tab walks the pad in the exact reverse of the forward cycle — the same six inverted, not "some of them". Compared as a CYCLE because the two traversals start wherever focus last sat, which is not the same place',
  `forward ${JSON.stringify(fwd.cyc)}, reversed ${JSON.stringify(fwd.cyc.slice().reverse())}, backward ${JSON.stringify(rev.cyc)}`);
const tabIdx = await page.evaluate(() => Object.entries(window.__dEls).map(([k, e]) => [k, e.getAttribute('tabindex')]));
ok(tabIdx.every(([, v]) => v === null),
  'D5b [BRANCH the absence of a tabindex]: not one pad button carries an explicit tabindex, so D5\'s order IS the document order and nothing on this pad jumps the queue',
  JSON.stringify(tabIdx));

/* ---------------------------------------------------------------------------
   D6 — A FOCUSED BUTTON, THE IDLE FADE, AND THE WAY BACK.
   style.js gives the faded cluster `visibility:hidden`, which takes every
   button out of the tab order AND out of the accessibility tree. So the
   question is not cosmetic: WHERE DOES FOCUS GO, and can the player get back.
   BRANCHES: the `idleT = 0` line in the focusin listener (D6a); the absence
   of a focused-button clause in idleSuspended() (D6b); the CSS visibility
   flip (D6c/D6d); the double-tap wake (D6e).
   --------------------------------------------------------------------------- */
await toOpenGround();
await flushKeys();
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.hideUI(true); WALLY.debug.idle(4); });
await page.waitForTimeout(2400);                       // bank ~2.4 s of a 4 s window
const idleBanked = await idleGet();
await tabTo('sc3');
await page.waitForTimeout(120);
const idleAfterFocus = await idleGet();
ok(idleBanked.t > 1.2 && idleBanked.hidden === false,
  'D6-pre [setup]: the clock was armed and really COUNTING (banked ' + idleBanked.t + ' s of a 4 s window) before the focus arrived — a clock already at zero would make D6a green for free',
  JSON.stringify({ t: idleBanked.t, hidden: idleBanked.hidden, why: idleBanked.why, moving: idleBanked.moving }));
ok(idleAfterFocus.t < idleBanked.t && idleAfterFocus.t < 0.9,
  'D6a [BRANCH focusin -> idleT = 0]: focus landing on Menu resets the idle clock, so a keyboard player gets a WHOLE window from the moment they arrive instead of having the button pulled out from under them mid-decision by a clock they never touched',
  `banked ${idleBanked.t} s -> ${idleAfterFocus.t} s`);
/* D6b — a RESET, NOT A SUSPENSION. Focus stays exactly where it is and the
   pad must still fade a full window later; suspending the clock here was the
   first shape of this fix and it switched stage two off for the session. */
let d6fade = null;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(250);
  d6fade = await idleGet();
  if (d6fade.hidden) break;
}
await page.waitForTimeout(700);                        // wait the 0.42 s transition out
const domFaded = await padDom();
const actFaded = await activeNow();
const kbFaded = await padKb();
ok(d6fade.hidden === true && domFaded.idlehide === true && domFaded.actsOp < 0.05,
  'D6b [BRANCH idleSuspended() has NO focused-button clause — a reset, not a suspension]: with focus still parked on Menu the pad fades a full window later anyway. Suspending the clock here broke seven assertions that had nothing to do with the keyboard, by the fade simply never arriving',
  `idle ${JSON.stringify({ hidden: d6fade.hidden, t: d6fade.t, why: d6fade.why })}, dom ${JSON.stringify(domFaded)}`);
const vis = await page.evaluate(() => {
  const a = document.querySelector('.w-acts');
  return { visibility: getComputedStyle(a).visibility, pe: getComputedStyle(a).pointerEvents };
});
ok(vis.visibility === 'hidden',
  'D6c [setup for D6d — the mechanism, measured not assumed]: the faded cluster really is at visibility:hidden, which is what takes its buttons out of the tab order and out of the accessibility tree',
  JSON.stringify(vis));
/* WHERE FOCUS WENT. Reported as a measurement first and asserted second: the
   honest answer is what the browser did, not what we hoped. */
console.log(`   WHERE FOCUS WENT when the fade landed under it: ${JSON.stringify(actFaded)}  padKeyboard ${JSON.stringify(kbFaded)}`);
const fadedWalk = (await tabWalk(1)).seen;
ok(fadedWalk.length === 0,
  'D6d [BRANCH visibility:hidden]: while the pad is faded a full forward traversal reaches NONE of the six buttons — they are genuinely out of the tab order, so the player cannot be left tabbing to an invisible control',
  `traversal landed on ${JSON.stringify(fadedWalk)}`);
/* D6e — AND THE WAY BACK. A double tap on the canvas wakes the pad; the six
   buttons must come back into the tab order, or "focus went to <body>" would
   be a one-way door out of the pad for a keyboard player.

   Delivered through wakeAttempt(), so the gesture is READ BACK from the probe
   and judged against touch.js's own TAP_GAP / TAP_MS / TAP_DIST before the
   claim is evaluated. On a loaded box a scripted 70 ms gap has been measured
   arriving as a second and a half; a fixture that was never a double tap is
   BLOCKED here, never a silent pass and never a misattributed red. */
const D6W = await wakeAttempt('touch', 'left', 195, 470);
const d6wake = D6W.after ?? {};
const wokeWalk = (d6wake.hidden === false) ? (await tabWalk(1)).cyc : [];
const wokeActive = await activeNow();
okTap(D6W, d6wake.hidden === false && d6wake.live === true
  && wokeWalk.length === D_FOCUSABLE.length && new Set(wokeWalk).size === D_FOCUSABLE.length,
  'D6e [BRANCH the wake, then sequential navigation again]: after the pad wakes, a forward traversal reaches all six buttons again — the fade parks focus at <body> and D6d\'s exclusion is temporary, not a one-way door out of the pad',
  `idle ${JSON.stringify({ hidden: d6wake.hidden, live: d6wake.live, wakes: d6wake.wakes })}, traversal ${JSON.stringify(wokeWalk)}, active after the walk ${JSON.stringify(wokeActive)}`);
await page.evaluate(() => { WALLY.debug.idle(null); WALLY.debug.hideUI(false); WALLY.ctx.ui.closeAll(); });
await page.waitForTimeout(600);

/* ---------------------------------------------------------------------------
   D7 — THE BUTTON GATE, ALL SEVEN CONTROLS x ALL FOUR NON-PRIMARY BUTTONS,
   RE-MEASURED AT THIS LOAD ON THE CODE THAT NOW CARRIES THE FOCUS FIX.
   BRANCH: `secondary(e)` in bindPress/pointerdown, jumpBtn/pointerdown and
   the stick's down(), BELOW the e.preventDefault() -- and the same
   preventDefault, which is what stops a refused press taking focus.

   BACK AND FORWARD REALLY NAVIGATE. Mouse buttons 3/4 are app commands Chrome
   handles above the page: preventDefault stops the FOCUS default and cannot
   stop the history move. Same-document entries are pushed in front of the run
   so the document, the probe and the game survive it -- otherwise every
   reading after the first back press is a silent zero from a fresh page.
   --------------------------------------------------------------------------- */
const DOC7 = await page.evaluate(() => { window.__doc7 = window.__doc7 || ('t' + Math.random()); return window.__doc7; });
await page.evaluate(() => {
  window.__pops7 = 0;
  addEventListener('popstate', () => { window.__pops7++; });
  for (let i = 0; i < 80; i++) history.pushState({ pad7: i }, '');
});
const D_CTLS = [
  { k: 'act', pt: ACT }, { k: 'jump', pt: JUMP },
  { k: 'sc0', pt: SC[0] }, { k: 'sc1', pt: SC[1] }, { k: 'sc2', pt: SC[2] }, { k: 'sc3', pt: SC[3] },
  { k: 'stick', pt: STICK },
];
const BTNNO = { right: 2, middle: 1, back: 3, forward: 4 };
const gate = [];
for (const c of D_CTLS) {
  for (const b of ['right', 'middle', 'back', 'forward']) {
    await closeAll();
    await reset();
    await mousePress(c.pt.x, c.pt.y, b, 70);
    await page.waitForTimeout(240);
    const rr = await read();
    const act = await activeNow();
    gate.push({ ctl: c.k, btn: b,
      reached: rr.ev.some((e) => e.t === 'pointerdown' && e.on === c.k && e.b === BTNNO[b]),
      armed: rr.arm.some((a) => a.el === c.k && a.on),
      verbs: rr.verbs, panels: rr.panels, stick: rr.stick, focused: act.inPad });
  }
}
const gateMiss = gate.filter((g) => !g.reached);
ok(gateMiss.length === 0,
  `D7a [setup — the press must actually LAND, or the empty readings below are about nothing]: all ${gate.length} secondary presses (7 controls x right/middle/back/forward) reached their own control's pointerdown`,
  gateMiss.length ? JSON.stringify(gateMiss.map((g) => [g.ctl, g.btn])) : `all ${gate.length} landed`);
const gateArmed = gate.filter((g) => g.armed || g.verbs.length || g.panels.length || g.stick > 0.1);
ok(gateArmed.length === 0,
  'D7 [BRANCH secondary(e) in all three controls]: the gate still refuses middle, right, back and forward on every one of the seven controls — nothing armed, no verb ran, no panel opened, the stick never deflected',
  gateArmed.length ? JSON.stringify(gateArmed.map((g) => [g.ctl, g.btn, g.armed, g.verbs, g.panels, g.stick])) : `0 of ${gate.length} armed`);
const gateFocus = gate.filter((g) => g.focused);
ok(gateFocus.length === 0,
  'D7b [BRANCH e.preventDefault() ABOVE the gate — the PAD-29 fix, still standing under the PAD-35 one]: not one refused press left anything in the pad focused, so none of them can hand the next Space to a button the player never chose',
  gateFocus.length ? JSON.stringify(gateFocus.map((g) => [g.ctl, g.btn])) : `activeElement outside .w-touch on all ${gate.length}`);
const doc7now = await page.evaluate(() => window.__doc7 ?? null);
const pops7 = await page.evaluate(() => window.__pops7 ?? -1);
ok(doc7now === DOC7 && doc7now !== null,
  'D7c [the document survived the back/forward presses]: the token minted before the run is still in the page, so all 28 readings came from the probe installed for them and not from a silent zero after a navigation',
  `doc ${DOC7} -> ${doc7now}, same-document history moves ${pops7}`);

/* D7d — THE POSITIVE HALF. A pad that refused everything would pass all of
   D7. The primary has to still work on all seven. */
const prim = [];
for (const c of D_CTLS) {
  if (c.k === 'stick') {
    await toOpenGround(); await flushKeys(); await page.waitForTimeout(500);
    await reset();
    await mouse('mouseMoved', STICK.x, STICK.y);
    await mouse('mousePressed', STICK.x, STICK.y, 'left', 1);
    for (let i = 1; i <= 5; i++) { await mouse('mouseMoved', STICK.x, STICK.y - i * 16, 'none', 1); await page.waitForTimeout(30); }
    await page.waitForTimeout(320);
    const mid = await read();
    await mouse('mouseReleased', STICK.x, STICK.y - 80, 'left', 0);
    await page.waitForTimeout(350);
    prim.push({ ctl: 'stick', worked: mid.stick > 0.5 && armedOn(mid, 'stick'), how: 't ' + mid.stick });
  } else if (c.k === 'jump') {
    await toOpenGround(); await flushKeys(); await page.waitForTimeout(500);
    await reset();
    await mouse('mouseMoved', JUMP.x, JUMP.y);
    await mouse('mousePressed', JUMP.x, JUMP.y, 'left', 1);
    const a = await airborneWithin(1800);
    await mouse('mouseReleased', JUMP.x, JUMP.y, 'left', 0);
    prim.push({ ctl: 'jump', worked: a.jumped === true, how: 'peak vy ' + a.vy });
  } else if (c.k === 'act') {
    door = await toDoor('D7d act');
    await reset();
    await mousePress(ACT.x, ACT.y, 'left', 90);
    await page.waitForTimeout(800);
    const rr = await read();
    const why = await page.evaluate(() => WALLY.debug.interact());
    prim.push({ ctl: 'act', worked: rr.verbs.includes('interact') && rr.panels.includes('place') && why.path === 'door',
      how: 'verbs ' + JSON.stringify(rr.verbs) + ' panels ' + JSON.stringify(rr.panels) + ' path ' + why.path });
    await closeAll();
  } else {
    await closeAll();
    await reset();
    await mousePress(c.pt.x, c.pt.y, 'left', 90);
    await page.waitForTimeout(750);
    const rr = await read();
    prim.push({ ctl: c.k, worked: rr.verbs.length > 0 || rr.panels.length > 0,
      how: 'verbs ' + JSON.stringify(rr.verbs) + ' panels ' + JSON.stringify(rr.panels) });
    await closeAll();
  }
}
const primDead = prim.filter((p) => !p.worked);
ok(primDead.length === 0,
  'D7d [THE POSITIVE CONTROL FOR D7 — a pad that refused everything would pass every line above]: the PRIMARY button still works on all seven controls',
  JSON.stringify(prim.map((p) => [p.ctl, p.worked, p.how])));
await closeAll();

/* ---------------------------------------------------------------------------
   D8 — THE CAPTURE-LOSS RATE, AS A NUMBER, A/B ON ONE PAGE AT ONE LOAD.
   BRANCH: lostIsRelease()'s `buttons & 1` test on the stick's
   lostpointercapture binding. WALLY.debug.padCaptureRetry(false) restores the
   old "a capture loss is a release" behaviour, so the before and after are
   measured on the SAME page at the SAME load — which is the only way a rate
   comparison on this box means anything.

   A DEAD DRAG IS MEASURED AT THE STICK AND IN THE WORLD, both: t at full
   deflection AND metres travelled. `t` alone would call a stick that
   deflected and then dropped a live drag.
   --------------------------------------------------------------------------- */
const N_DRAG = 24;
async function dragRun(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    await toOpenGround();
    await flushKeys();
    await page.waitForTimeout(420);
    const from = await posNow();
    await mouse('mouseMoved', STICK.x, STICK.y);
    await mouse('mousePressed', STICK.x, STICK.y, 'left', 1);
    await page.waitForTimeout(40);
    for (let k = 1; k <= 4; k++) { await mouse('mouseMoved', STICK.x, STICK.y - k * 18, 'none', 1); await page.waitForTimeout(30); }
    const t = await stickT();
    await page.waitForTimeout(360);
    const moved = dist(from, await posNow());
    await mouse('mouseReleased', STICK.x, STICK.y - 72, 'left', 0);
    await page.waitForTimeout(320);
    rows.push({ t, moved, dead: !(t > 0.9 && moved > 0.3) });
  }
  return rows;
}
await page.evaluate(() => WALLY.debug.padCaptureRetry(false));    // the OLD behaviour
const dragBefore = await dragRun(N_DRAG);
await page.evaluate(() => WALLY.debug.padCaptureRetry(true));     // the fix
const dragAfter = await dragRun(N_DRAG);
const deadB = dragBefore.filter((d) => d.dead).length;
const deadA = dragAfter.filter((d) => d.dead).length;
ok(deadB > 0,
  `D8-pre [THE DISCRIMINATOR — without it D8 is a claim about a browser that never drops a capture]: with the re-take switched OFF, ${deadB} of ${N_DRAG} primary mouse drags on the thumbstick died. Chrome really is granting the capture and dropping it again inside the gesture on this box, at this load`,
  `t/moved per drag ${JSON.stringify(dragBefore.map((d) => [d.t, d.moved]))}`);
ok(deadA === 0,
  `D8 [BRANCH lostIsRelease, the buttons&1 test]: with the re-take ON, ${N_DRAG - deadA} of ${N_DRAG} drags reach full deflection AND walk him — dead-drag rate ${(100 * deadB / N_DRAG).toFixed(0)}% before, ${(100 * deadA / N_DRAG).toFixed(0)}% after, same page, same load`,
  `after: ${JSON.stringify(dragAfter.map((d) => [d.t, d.moved]))}`);
console.log(`   CAPTURE-LOSS RATE  before ${deadB}/${N_DRAG} dead (${(100 * deadB / N_DRAG).toFixed(0)}%), after ${deadA}/${N_DRAG} dead (${(100 * deadA / N_DRAG).toFixed(0)}%)`);
await page.evaluate(() => WALLY.debug.padCaptureRetry(true));
await closeAll();

const LOAD_END = execSync('uptime').toString().trim();
console.log('\nLOAD AT END  ' + LOAD_END);

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILED'}`);
await browser.close();
server.close();
process.exit(fails ? 1 : 0);
