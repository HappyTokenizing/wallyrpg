/* touchtest.mjs — prove the thumbstick actually moves the elephant.

   Boots the game in a MOBILE context (hasTouch + isMobile, so
   `(pointer: coarse)` really matches and the controls auto-detect
   their way on with nobody forcing them), then drives the stick with
   REAL touch events dispatched through CDP — Input.dispatchTouchEvent
   goes in at the top of the browser's input pipeline, so the page sees
   exactly what a finger produces, pointer events and all.

   The check is tools/strafetest.mjs's: sample the controller's VELOCITY
   and the camera basis at the SAME INSTANT and take a dot product.
   Integrating displacement is confounded — the follow camera rotates
   while you move, so the path curves away from the basis you started
   with and a correct control reads as a wrong one.

   Also asserts, in a second, touch-less context, that a desktop gets
   no controls at all.  */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'],
});

let fails = 0;
const ok = (cond, msg, extra = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '   ' + extra : ''}`);
  return cond;
};

/* ================= 1. the phone ================= */
const ctxMobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 1,
});
const page = await ctxMobile.newPage();
page.on('pageerror', e => { console.log('PAGEERROR', e.message.split('\n')[0]); fails++; });
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 60000 });
await page.waitForTimeout(3500);

const cdp = await ctxMobile.newCDPSession(page);
const P = (x, y) => [{ x, y, id: 1, radiusX: 14, radiusY: 14, force: 1 }];
const touch = (type, x, y) =>
  cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : P(x, y),
  });

/* --- it turned itself on, with no help --- */
const state0 = await page.evaluate(() => WALLY.debug.touchState());
ok(state0.enabled, 'controls auto-enable on a coarse-pointer device', JSON.stringify(state0));

/* where the stick is resting, in CSS px */
const rest = await page.evaluate(() => {
  const el = document.querySelector('.w-stick');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width) };
});
ok(rest && rest.w > 90, 'thumbstick is in the document and thumb-sized',
  rest ? `${rest.w}px at ${Math.round(rest.x)},${Math.round(rest.y)}` : 'missing');
if (!rest) { console.log('\nFAIL — no stick to push'); await browser.close(); server.close(); process.exit(1); }

/* Read velocity and the camera basis in the same evaluate, same frame. */
const sample = () => page.evaluate(() => {
  const c = WALLY.ctx, w = c.wally, ct = w.controller;
  const v = ct && (ct.velocity || ct.vel);
  const f = new c.THREE.Vector3();
  c.camera.getWorldDirection(f); f.y = 0; f.normalize();
  const right = [-f.z, f.x];                       // camera right, Y-up RH
  if (!v) return null;
  const sp = Math.hypot(v.x, v.z);
  return {
    speed: +sp.toFixed(2),
    alongFwd: +(v.x * f.x + v.z * f.z).toFixed(2),
    alongRight: +(v.x * right[0] + v.z * right[1]).toFixed(2),
    stick: WALLY.debug.touchState(),
  };
});

/* Push the stick and hold it. `dx, dy` are CSS px from where the thumb
   first lands — which is wherever we put it, the stick floats. */
async function push(dx, dy, ms = 700) {
  const x = rest.x, y = rest.y;
  await touch('touchStart', x, y);
  await page.waitForTimeout(60);
  /* a couple of moves, as a finger would */
  await touch('touchMove', x + dx * 0.5, y + dy * 0.5);
  await page.waitForTimeout(40);
  await touch('touchMove', x + dx, y + dy);
  await page.waitForTimeout(ms);
  const r = await sample();
  await touch('touchEnd', x + dx, y + dy);
  await page.waitForTimeout(800);
  return r;
}

const WALK = await page.evaluate(() => WALLY.ctx.wally.controller.opts.walkSpeed);
const RUN = await page.evaluate(() => WALLY.ctx.wally.controller.opts.runSpeed);

/* --- forward: thumb up the screen --- */
const up = await push(0, -70);
ok(up.speed > 0.4, 'stick UP moves him', `${up.speed} m/s`);
ok(up.alongFwd > 0.75 * up.speed, 'stick UP is camera-FORWARD',
  `along fwd ${up.alongFwd} of ${up.speed}`);
ok(up.stick.t > 0.9, 'a 70 px push is full deflection', `t=${up.stick.t.toFixed(2)}`);
ok(up.speed > WALK + 0.3, 'a full push RUNS', `${up.speed} vs walk ${WALK}`);

/* --- right: thumb across the screen --- */
const right = await push(70, 0);
ok(right.speed > 0.4, 'stick RIGHT moves him', `${right.speed} m/s`);
ok(right.alongRight > 0.75 * right.speed, 'stick RIGHT is camera-RIGHT (not mirrored)',
  `along right ${right.alongRight} of ${right.speed}`);

/* --- left: the sign that was wrong in the keyboard path --- */
const left = await push(-70, 0);
ok(left.alongRight < -0.75 * left.speed, 'stick LEFT is camera-LEFT',
  `along right ${left.alongRight} of ${left.speed}`);

/* --- back --- */
const back = await push(0, 70);
ok(back.alongFwd < -0.75 * back.speed, 'stick DOWN is camera-BACK',
  `along fwd ${back.alongFwd} of ${back.speed}`);

/* --- analogue: a small push walks --- */
const R = up.stick.R;
const small = await push(0, -Math.round(R * 0.45), 900);
ok(small.speed > 0.25, 'a small push still moves him', `${small.speed} m/s`);
ok(small.speed < WALK + 0.25, 'a small push WALKS, it does not run',
  `${small.speed} vs walk ${WALK} / run ${RUN}`);

/* --- dead zone --- */
const dead = await push(0, -Math.round(R * 0.10), 450);
ok(dead.speed < 0.15, 'inside the dead zone nothing happens', `${dead.speed} m/s`);

/* --- the jump button --- */
const jumpBox = await page.evaluate(() => {
  const b = document.querySelector('.w-abtn.jump');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width) };
});
ok(jumpBox && jumpBox.w >= 44, 'jump button is at least 44 px', jumpBox ? jumpBox.w + 'px' : 'missing');
if (jumpBox) {
  await touch('touchStart', jumpBox.x, jumpBox.y);
  await page.waitForTimeout(220);
  const air = await page.evaluate(() => {
    const ct = WALLY.ctx.wally.controller;
    return { vy: +ct.velocity.y.toFixed(2), grounded: ct.grounded };
  });
  await touch('touchEnd', jumpBox.x, jumpBox.y);
  await page.waitForTimeout(900);
  ok(air.vy > 0.5 || !air.grounded, 'jump button leaves the ground',
    `vy ${air.vy}, grounded ${air.grounded}`);
}

/* ================= the action pad's pecking order =================
   ENTER is the game's main verb — every door, desk, client and shop
   goes through it — so it holds the corner-most, largest seat and
   JUMP is the smaller one offset up-and-left. This block exists
   because that used to be the other way round, and because the
   caption is written from JS (touch.js) where a DOM reorder can
   silently retarget it. */
const padBoxes = () => page.evaluate(() => {
  const box = (s) => {
    const e = document.querySelector(s);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return {
      l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right),
      b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height),
    };
  };
  return {
    act: box('.w-abtn.act'), jump: box('.w-abtn.jump'),
    actCap: box('.w-abtn.act .cap'), jumpCap: box('.w-abtn.jump .cap'),
    badge: box('.w-abtn .badge'), badgeHost: box('.w-abtn.sm'),
    cap: document.querySelector('.w-abtn.act .cap')?.textContent ?? null,
    vw: innerWidth, vh: innerHeight,
  };
});
const pad = await padBoxes();
ok(pad.act && pad.jump, 'both pad buttons are in the document');
ok(pad.act.w > pad.jump.w, 'ENTER is the larger of the two',
  `enter ${pad.act.w}px vs jump ${pad.jump.w}px`);
ok(pad.act.w >= 44 && pad.jump.w >= 44, 'both pad buttons clear 44 px',
  `${pad.act.w} / ${pad.jump.w}`);
ok(pad.act.l > pad.jump.l && pad.act.b > pad.jump.b,
  'ENTER sits LOWER-RIGHT of JUMP (the thumb\'s resting corner)',
  `enter l${pad.act.l} b${pad.act.b} vs jump l${pad.jump.l} b${pad.jump.b}`);
ok(pad.cap === 'Enter / Talk', 'the resting caption says what the button does',
  JSON.stringify(pad.cap));
/* The caption is absolutely positioned at left:50% under a 66 px
   button whose right edge is 12 px off the screen. */
ok(pad.actCap.r <= pad.vw - 4 && pad.actCap.l >= 0,
  '"Enter / Talk" stays inside the frame', `${pad.actCap.l}..${pad.actCap.r} of ${pad.vw}`);
const capsClear = pad.actCap.l > pad.jumpCap.r || pad.actCap.t > pad.jumpCap.b
  || pad.jumpCap.t > pad.actCap.b;
ok(capsClear, 'the two captions never overlap each other',
  `enter ${pad.actCap.l}..${pad.actCap.r}@${pad.actCap.t}, jump ${pad.jumpCap.l}..${pad.jumpCap.r}@${pad.jumpCap.t}`);
/* the unread badge rides the Phone shortcut, not the pad */
ok(pad.badge && pad.badgeHost
  && Math.abs(pad.badge.r - pad.badgeHost.r) < 8 && Math.abs(pad.badge.t - pad.badgeHost.t) < 8,
  'the badge still lands on the corner of the button that carries it',
  JSON.stringify(pad.badge));

/* --- LANDSCAPE, where the pad lies down in one row along the bottom
       edge. Same order, same sizes, and the long caption still has to
       fit: in portrait it clears the right edge by 14 px, and here the
       bar is only 390 px tall so the caption is also the lowest thing
       on screen. This is ALSO where the Enter tap is tested, because
       landscape is the layout that lifts the dialogue card clear of
       the pad — in portrait the card lies on the floor over both
       buttons and a tap there would be answered by the card. --- */
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(900);
const land = await padBoxes();
ok(land.act.w > land.jump.w && land.act.l > land.jump.l && land.act.b > land.jump.b,
  'landscape: ENTER is still the bigger, lower-right button',
  `enter ${land.act.w}px @${land.act.l},${land.act.b}  jump ${land.jump.w}px @${land.jump.l},${land.jump.b}`);
ok(land.actCap.r <= land.vw - 4 && land.actCap.b <= land.vh - 4,
  'landscape: "Enter / Talk" clears the right and bottom edges',
  `cap r${land.actCap.r}/${land.vw}, b${land.actCap.b}/${land.vh}`);
ok(land.actCap.l > land.jumpCap.r || land.actCap.t > land.jumpCap.b,
  'landscape: the captions still do not overlap');

/* --- tapping ENTER interacts. A dialogue is the observable proof:
       the card advances, which is the same ui.interact() a door uses. --- */
await page.evaluate(() => WALLY.debug.ui('dialogue'));
await page.waitForTimeout(900);
const talkCap = await page.evaluate(() => document.querySelector('.w-abtn.act .cap').textContent);
ok(talkCap === 'More', 'mid-dialogue the caption becomes "More"', JSON.stringify(talkCap));
const actC = { x: (land.act.l + land.act.r) / 2, y: (land.act.t + land.act.b) / 2 };
/* THE TAP MUST LAND ON THE BUTTON. The dialogue card also advances on
   click, so without this the whole check passes through a card that
   happens to be covering the pad. */
const onTop = await page.evaluate(([x, y]) => {
  const b = document.querySelector('.w-abtn.act');
  const t = document.elementFromPoint(x, y);
  return !!t && (t === b || b.contains(t));
}, [actC.x, actC.y]);
ok(onTop, 'the dialogue card leaves ENTER reachable, so the tap is really the button\'s');
/* Wait out the typewriter, then prove the line has SETTLED — otherwise
   "the text changed" could just be the next character arriving and the
   tap would never have had to do anything. */
const dlgTx = () => page.evaluate(() => document.querySelector('.w-dlg-tx')?.textContent || '');
await page.waitForTimeout(3200);
const settled0 = await dlgTx();
await page.waitForTimeout(600);
const line0 = await dlgTx();
ok(settled0 === line0 && line0.length > 0, 'the dialogue line has finished typing before we tap',
  `${line0.length} chars`);
await touch('touchStart', actC.x, actC.y);
await page.waitForTimeout(90);
await touch('touchEnd', actC.x, actC.y);
await page.waitForTimeout(900);
const line1 = await dlgTx();
ok(line1 !== line0 && line1.length > 0, 'tapping ENTER advances the dialogue — it still interacts',
  `"${line0.slice(0, 28)}…" -> "${line1.slice(0, 28)}…"`);
await page.evaluate(() => { WALLY.ctx.ui.hide('dialogue'); WALLY.ctx.ui.closeAll(); });
await page.waitForTimeout(800);
const restCap = await page.evaluate(() => document.querySelector('.w-abtn.act .cap').textContent);
ok(restCap === 'Enter / Talk', 'and the caption goes back to "Enter / Talk"', JSON.stringify(restCap));

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(900);

/* --- tapping JUMP still jumps, now that it is the smaller one --- */
const jc = { x: (pad.jump.l + pad.jump.r) / 2, y: (pad.jump.t + pad.jump.b) / 2 };
await touch('touchStart', jc.x, jc.y);
await page.waitForTimeout(220);
const air2 = await page.evaluate(() => {
  const ct = WALLY.ctx.wally.controller;
  return { vy: +ct.velocity.y.toFixed(2), grounded: ct.grounded };
});
await touch('touchEnd', jc.x, jc.y);
await page.waitForTimeout(900);
ok(air2.vy > 0.5 || !air2.grounded, 'tapping JUMP in its new seat still jumps',
  `vy ${air2.vy}, grounded ${air2.grounded}`);

/* ================= HIDE UI =================
   Settings › Comfort. The two TOP clusters go; the thumbstick and
   the whole bottom-right cluster stay, and so does every layer that
   is a RESPONSE to the player. A finger must still reach the pad. */
const layers = () => page.evaluate(() => WALLY.debug.uiLayers());
const shown = await layers();
ok(shown.barLeft.hit && shown.barRight.hit, 'HUD: the top bars start visible');

await page.evaluate(() => WALLY.debug.hideUI(true));
await page.waitForTimeout(700);
const hid = await layers();
ok(!hid.barLeft.hit, 'Hide UI: the day/clock/energy/objective cluster is gone',
  `vis ${hid.barLeft.vis} op ${hid.barLeft.op}`);
ok(!hid.barRight.hit, 'Hide UI: the money/ticker/rep/city cluster is gone',
  `vis ${hid.barRight.vis} op ${hid.barRight.op}`);
ok(hid.stick.hit && hid.acts.hit, 'Hide UI: the thumbstick and the bottom-right cluster stay');
ok(hid.act.hit && hid.jump.hit, 'Hide UI: Enter and Jump are still drawn');
ok(hid.barLeft.w > 0 && hid.barLeft.h > 0,
  'Hide UI: the objective strip keeps its BOX — the pointer maths and the toast dock still measure it',
  `${hid.barLeft.w}x${hid.barLeft.h}`);
ok(hid.toasts !== null && hid.prompt !== null,
  'Hide UI: the toast and world-prompt layers are still in the document');

/* the buttons are not merely painted — a real finger reaches them */
const hitAt = (sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  const r = e.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!top && (top === e || e.contains(top));
}, sel);
ok(await hitAt('.w-abtn.act'), 'Hide UI: Enter is still hit-testable');
ok(await hitAt('.w-abtn.jump'), 'Hide UI: Jump is still hit-testable');
ok(await hitAt('.w-stickzone'), 'Hide UI: the thumbstick zone is still hit-testable');

/* the way back out: the gear on the pad opens the pause menu */
const gear = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.w-acts .shortcuts .w-abtn')].pop();
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: b.getAttribute('aria-label') };
});
await touch('touchStart', gear.x, gear.y);
await page.waitForTimeout(80);
await touch('touchEnd', gear.x, gear.y);
await page.waitForTimeout(800);
const paused = await page.evaluate(() => WALLY.ctx.ui.panels);
ok(paused.includes('pause'), 'Hide UI: the pause menu is still reachable from the pad',
  `${gear.label} -> ${JSON.stringify(paused)}`);
await page.evaluate(() => WALLY.ctx.ui.closeAll());
await page.waitForTimeout(500);

/* and it comes back */
await page.evaluate(() => WALLY.debug.hideUI(false));
await page.waitForTimeout(700);
const restored = await layers();
ok(restored.barLeft.hit && restored.barRight.hit, 'Hide UI off: both top clusters come back',
  `left op ${restored.barLeft.op}, right op ${restored.barRight.op}`);

/* --- a drag OUTSIDE the stick zone orbits instead of moving --- */
const yaw0 = await page.evaluate(() => WALLY.ctx.cam.yaw);
await touch('touchStart', 300, 300);
await page.waitForTimeout(50);
for (let i = 1; i <= 6; i++) { await touch('touchMove', 300 - i * 16, 300); await page.waitForTimeout(22); }
const midMove = await page.evaluate(() => ({
  speed: +Math.hypot(WALLY.ctx.wally.controller.velocity.x, WALLY.ctx.wally.controller.velocity.z).toFixed(2),
  yaw: WALLY.ctx.cam.yaw,
}));
await touch('touchEnd', 204, 300);
await page.waitForTimeout(700);
const yaw1 = await page.evaluate(() => WALLY.ctx.cam.yaw);
const dyaw = Math.abs(Math.atan2(Math.sin(yaw1 - yaw0), Math.cos(yaw1 - yaw0)));
ok(dyaw > 0.15, 'a drag outside the stick zone orbits the camera', `${(dyaw * 57.3).toFixed(1)} deg`);
ok(midMove.speed < 0.2, 'and does NOT move him', `${midMove.speed} m/s`);

/* --- the stick lets go --- */
const rested = await page.evaluate(() => WALLY.debug.touchState());
ok(!rested.active && rested.t === 0, 'stick returns to rest on release', JSON.stringify(rested));

/* --- a keyboard attached to a tablet still drives him. The touch
       input function REPLACES wally's built-in WASD read at the seam,
       so it has to fall back to it when the stick is at rest. --- */
await page.keyboard.down('KeyW');
await page.waitForTimeout(600);
const kbTouch = await sample();
await page.keyboard.up('KeyW');
await page.waitForTimeout(700);
ok(kbTouch.speed > 0.4 && kbTouch.alongFwd > 0.75 * kbTouch.speed,
  'a keyboard still works WITH the touch controls on',
  `${kbTouch.speed} m/s, along fwd ${kbTouch.alongFwd}`);

/* --- opening and closing a panel must not uninstall the stick. The
       modal grab used to restore setInput(null) unconditionally. --- */
await page.evaluate(() => WALLY.debug.ui('phone'));
await page.waitForTimeout(500);
const shut = await page.evaluate(() => !document.querySelector('.w-touch').classList.contains('hidden'));
ok(!shut, 'the pad hides while a panel owns the screen');
await page.evaluate(() => WALLY.ctx.ui.closeAll());
await page.waitForTimeout(600);
const after = await push(0, -70, 600);
ok(after.speed > 0.4, 'the stick still moves him after a panel opened and closed',
  `${after.speed} m/s`);

await ctxMobile.close();

/* ================= 2. the desktop ================= */
const ctxDesk = await browser.newContext({ viewport: { width: 1600, height: 900 }, hasTouch: false });
const dpage = await ctxDesk.newPage();
dpage.on('pageerror', e => { console.log('PAGEERROR(desktop)', e.message.split('\n')[0]); fails++; });
await dpage.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
await dpage.waitForFunction('window.__WALLY_READY__===true', { timeout: 60000 });
await dpage.waitForTimeout(2500);

const desk = await dpage.evaluate(() => ({
  touch: WALLY.debug.touchState(),
  hidden: !!document.querySelector('.w-touch.hidden'),
  visibleStick: !!document.querySelector('.w-stickzone')?.getClientRects().length,
  hints: document.querySelectorAll('.w-hint').length,
  bodyClass: document.body.className,
}));
ok(!desk.touch.enabled, 'desktop: touch controls stay off', JSON.stringify(desk.touch));
ok(desk.hidden && !desk.visibleStick, 'desktop: the stick is not rendered at all');
ok(desk.hints === 4, 'desktop: the P/M/O/Esc key hints are still there', desk.hints + ' hints');
ok(!/w-touch-on/.test(desk.bodyClass), 'desktop: no touch class on <body>');

/* keyboard still drives, with the touch module loaded */
await dpage.keyboard.down('KeyW');
await dpage.waitForTimeout(600);
const kb = await dpage.evaluate(() => {
  const c = WALLY.ctx, v = c.wally.controller.velocity;
  const f = new c.THREE.Vector3();
  c.camera.getWorldDirection(f); f.y = 0; f.normalize();
  return { speed: +Math.hypot(v.x, v.z).toFixed(2), alongFwd: +(v.x * f.x + v.z * f.z).toFixed(2) };
});
await dpage.keyboard.up('KeyW');
ok(kb.speed > 0.4 && kb.alongFwd > 0.75 * kb.speed, 'desktop: W still walks him forward',
  `${kb.speed} m/s, along fwd ${kb.alongFwd}`);

/* the mouse orbit now tracks a pointerId — make sure it still drags */
const dyaw0 = await dpage.evaluate(() => WALLY.ctx.cam.yaw);
await dpage.mouse.move(800, 450);
await dpage.mouse.down();
for (let i = 1; i <= 8; i++) await dpage.mouse.move(800 - i * 14, 450);
await dpage.mouse.up();
await dpage.waitForTimeout(300);
const dyaw1 = await dpage.evaluate(() => WALLY.ctx.cam.yaw);
const dd = Math.abs(Math.atan2(Math.sin(dyaw1 - dyaw0), Math.cos(dyaw1 - dyaw0)));
ok(dd > 0.15, 'desktop: mouse drag still orbits the camera', `${(dd * 57.3).toFixed(1)} deg`);

await browser.close();
server.close();
console.log(fails ? `\nFAIL — ${fails} check(s) failed` : '\nPASS — touch controls move the elephant, desktop untouched');
process.exit(fails ? 1 : 0);
