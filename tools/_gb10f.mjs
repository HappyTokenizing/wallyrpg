/* _gb10f.mjs — ROUND EIGHT: the capture-loss guard, on BOTH arms, interleaved. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => { const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b);
  } catch { rs.writeHead(404).end(); } });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctxM.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(3500);
const cdp = await ctxM.newCDPSession(page);
let fails = 0;
const ok = (c, m, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${x ? '\n            ' + x : ''}`); return c; };
const note = (m) => console.log('      ' + m);

/* INSTRUMENT: every capture event on the three controls, with its buttons. */
await page.evaluate(() => {
  window.__cap = [];
  window.__hits = 0;
  const ui = WALLY.ctx.ui; const f = ui.interact;
  ui.interact = function (...a) { window.__hits++; return f.apply(this, a); };
  const watch = (el, name) => {
    for (const t of ['gotpointercapture', 'lostpointercapture', 'pointerdown', 'pointerup', 'pointercancel'])
      el.addEventListener(t, (e) => window.__cap.push({ el: name, t: e.type, b: e.button, bs: e.buttons, pt: e.pointerType }), true);
  };
  watch(document.querySelector('.w-stickzone'), 'stick');
  const act = document.querySelector('.w-touch .w-abtn.act'); watch(act, 'enter');
  window.__rects = () => {
    const z = document.querySelector('.w-stick').getBoundingClientRect();
    const a = document.querySelector('.w-touch .w-abtn.act').getBoundingClientRect();
    return { stick: { x: z.left + z.width / 2, y: z.top + z.height / 2 },
             enter: { x: a.left + a.width / 2, y: a.top + a.height / 2 } };
  };
});
const R = await page.evaluate(() => window.__rects());
const clearCap = () => page.evaluate(() => { window.__cap = []; window.__hits = 0; });
const readCap = () => page.evaluate(() => ({ cap: window.__cap.slice(), hits: window.__hits }));
const stickT = () => page.evaluate(() => WALLY.debug.touchState().axes ? WALLY.debug.touchState().axes.t : WALLY.ctx.ui.touch ? null : null);
const axes = () => page.evaluate(() => { const s = WALLY.debug.touchState(); return s.axes || s; });
const setRetry = (on) => page.evaluate((o) => WALLY.debug.padCaptureRetry(o), on);

const M = (o) => cdp.send('Input.dispatchMouseEvent', o);
/* THE CHORDED GESTURE. Chrome turns a second button pressed or released
   while another is down into a POINTERMOVE, and it is that move —
   button "none", buttons still 1 — that provokes the capture loss.
   Plain left-button moves do not. */
async function chordDrag(x, y, dx, dy, steps = 6) {
  await M({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await page.waitForTimeout(20);
  await M({ type: 'mousePressed', x, y, button: 'right', buttons: 3, clickCount: 1 });   // chord ON  -> pointermove b2
  await page.waitForTimeout(20);
  await M({ type: 'mouseReleased', x, y, button: 'right', buttons: 1, clickCount: 1 });  // chord OFF -> pointermove b2, buttons back to 1
  await page.waitForTimeout(20);
  for (let i = 1; i <= steps; i++) {                                                      // the "button none, buttons 1" moves
    await M({ type: 'mouseMoved', x: x + (dx * i) / steps, y: y + (dy * i) / steps, button: 'none', buttons: 1 });
    await page.waitForTimeout(22);
  }
  const mid = await axes();
  await M({ type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', buttons: 0, clickCount: 1 });
  await page.waitForTimeout(60);
  return mid;
}
async function plainDrag(x, y, dx, dy, steps = 6) {
  await M({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await page.waitForTimeout(20);
  for (let i = 1; i <= steps; i++) {
    await M({ type: 'mouseMoved', x: x + (dx * i) / steps, y: y + (dy * i) / steps, button: 'none', buttons: 1 });
    await page.waitForTimeout(22);
  }
  const mid = await axes();
  await M({ type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', buttons: 0, clickCount: 1 });
  await page.waitForTimeout(60);
  return mid;
}
const P = (x, y, id = 1) => [{ x, y, id, radiusX: 14, radiusY: 14, force: 1 }];
async function touchDrag(x, y, dx, dy, steps = 6) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: P(x, y) });
  await page.waitForTimeout(20);
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: P(x + (dx * i) / steps, y + (dy * i) / steps) });
    await page.waitForTimeout(22);
  }
  const mid = await axes();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(60);
  return mid;
}

console.log('\n===== 0. CAN THIS GESTURE PROVOKE THE FAULT AT ALL? =====');
await clearCap();
await plainDrag(R.stick.x, R.stick.y, 0, -60);
const p0 = await readCap();
const plainLoss = p0.cap.filter(c => c.t === 'lostpointercapture');
await clearCap();
await chordDrag(R.stick.x, R.stick.y, 0, -60);
const c0 = await readCap();
const chordLoss = c0.cap.filter(c => c.t === 'lostpointercapture');
console.log(`  plain left drag : ${p0.cap.map(c => `${c.t}/b${c.b}/bs${c.bs}`).join(' ')}`);
console.log(`  chorded drag    : ${c0.cap.map(c => `${c.t}/b${c.b}/bs${c.bs}`).join(' ')}`);
note(`lostpointercapture — plain ${plainLoss.length}, chorded ${chordLoss.length}`);
const canDiscriminate = chordLoss.length > 0;
if (!canDiscriminate) note('!! NEITHER gesture produced a capture loss on this build/load — see the verdict below');

console.log('\n===== 1. BOTH ARMS, RETRY ON AND OFF, INTERLEAVED =====');
const N = 24;                       // 24 trials per arm = 12 on / 12 off, alternating
const res = { stick: { on: { dead: 0, n: 0 }, off: { dead: 0, n: 0 } },
              enter: { on: { dead: 0, n: 0 }, off: { dead: 0, n: 0 } } };
const losses = [];
for (let i = 0; i < N; i++) {
  const on = i % 2 === 0;                       // ALTERNATE, so drift cannot land on one arm
  await setRetry(on);
  /* --- stick --- */
  await clearCap();
  const mid = await chordDrag(R.stick.x, R.stick.y, 0, -60);
  const cs = await readCap();
  losses.push(...cs.cap.filter(c => c.t === 'lostpointercapture').map(c => ({ el: c.el, b: c.b, bs: c.bs, pt: c.pt })));
  const t = mid && typeof mid.t === 'number' ? mid.t : -1;
  const k = on ? 'on' : 'off'; res.stick[k].n++;
  if (t <= 0.01) res.stick[k].dead++;
  /* --- enter button: the chord that DOES leave a legal primary release --- */
  await clearCap();
  await M({ type: 'mousePressed', x: R.enter.x, y: R.enter.y, button: 'left', buttons: 1, clickCount: 1 });
  await page.waitForTimeout(20);
  await M({ type: 'mousePressed', x: R.enter.x, y: R.enter.y, button: 'right', buttons: 3, clickCount: 1 });
  await page.waitForTimeout(20);
  await M({ type: 'mouseReleased', x: R.enter.x, y: R.enter.y, button: 'right', buttons: 1, clickCount: 1 });
  await page.waitForTimeout(20);
  for (let s = 1; s <= 4; s++) { await M({ type: 'mouseMoved', x: R.enter.x + s, y: R.enter.y, button: 'none', buttons: 1 }); await page.waitForTimeout(20); }
  await M({ type: 'mouseReleased', x: R.enter.x, y: R.enter.y, button: 'left', buttons: 0, clickCount: 1 });
  await page.waitForTimeout(80);
  const ce = await readCap();
  losses.push(...ce.cap.filter(c => c.t === 'lostpointercapture').map(c => ({ el: c.el, b: c.b, bs: c.bs, pt: c.pt })));
  res.enter[k].n++;
  if (ce.hits === 0) res.enter[k].dead++;
  await page.evaluate(() => WALLY.ctx.ui.closeAll());
}
console.log(`  STICK  retry ON : ${res.stick.on.dead}/${res.stick.on.n} dead drags     retry OFF: ${res.stick.off.dead}/${res.stick.off.n}`);
console.log(`  ENTER  retry ON : ${res.enter.on.dead}/${res.enter.on.n} dead presses   retry OFF: ${res.enter.off.dead}/${res.enter.off.n}`);
const withButtons = losses.filter(l => l.bs !== 0);
console.log(`  lostpointercapture seen: ${losses.length} total, ${withButtons.length} with buttons still set`);
if (losses.length) note(JSON.stringify(losses.slice(0, 8)));

if (!canDiscriminate && losses.length === 0) {
  ok(false, 'RIG [this probe CANNOT DISCRIMINATE]: the chorded gesture produced ZERO lostpointercapture events on either control, so the retry-on/retry-off split below is measuring nothing. No verdict on the guard.',
    `${res.stick.on.dead}/${res.stick.on.n} vs ${res.stick.off.dead}/${res.stick.off.n} is not evidence`);
} else {
  ok(res.stick.on.dead <= res.stick.off.dead, '1-stick [the retry helps, or at least never hurts, the thumbstick]',
    `ON ${res.stick.on.dead}/${res.stick.on.n}  OFF ${res.stick.off.dead}/${res.stick.off.n}`);
  ok(res.enter.on.dead <= res.enter.off.dead, '1-enter [and the new coverage helps, or at least never hurts, the buttons]',
    `ON ${res.enter.on.dead}/${res.enter.on.n}  OFF ${res.enter.off.dead}/${res.enter.off.n}`);
}

console.log('\n===== 2. THE TOUCH PATH IS STILL A NO-OP =====');
await setRetry(true);
const tl = [];
for (let i = 0; i < 12; i++) {
  await clearCap();
  const mid = await touchDrag(R.stick.x, R.stick.y, 0, -60);
  const c = await readCap();
  tl.push(...c.cap.filter(x => x.t === 'lostpointercapture'));
}
const badTouch = tl.filter(l => l.bs !== 0);
console.log(`  12 finger drags: ${tl.length} lostpointercapture, ${badTouch.length} carrying buttons != 0`);
ok(badTouch.length === 0,
  '2 [every capture loss on a FINGER carries buttons 0, so the retry never engages on the touch path]',
  tl.length ? JSON.stringify(tl.slice(0, 6)) : 'no capture losses on the touch path at all');
/* and the fingers still actually work */
await clearCap();
const tm = await touchDrag(R.stick.x, R.stick.y, 0, -60);
ok(tm && tm.t > 0.2, '2b [and a finger drag still deflects the stick]', JSON.stringify(tm));

console.log(`\n${fails} FAIL`);
await browser.close(); server.close(); process.exit(0);
