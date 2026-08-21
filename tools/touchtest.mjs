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
