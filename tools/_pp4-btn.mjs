/* _pp4-btn.mjs — does the capture-loss defect reach the Enter BUTTON, and is the
   chorded gesture really the discriminator? Also: the focus ring, and the canvas path. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
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

const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctxM.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message.split('\n')[0]));
page.on('console', m => { if (m.type() === 'warning' && /passive/i.test(m.text())) console.log('CONSOLE-WARN', m.text()); });
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 120000 });
await page.waitForTimeout(3500);
const cdp = await ctxM.newCDPSession(page);

const mouseAt = (type, x, y, button = 'none', buttons = 0) =>
  cdp.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button, buttons, clickCount: button === 'none' ? 0 : 1 });
const P = (x, y) => [{ x, y, id: 1, radiusX: 14, radiusY: 14, force: 1 }];
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : P(x, y) });

await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.hideUI(false); });
await page.waitForTimeout(600);

const act = await page.evaluate(() => {
  const b = document.querySelector('.w-abtn.big.act');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) };
});
console.log('Enter button:', JSON.stringify(act));

/* count real ui.interact() invocations, calling through. Nothing is in range at
   the boot spot, so the verb genuinely runs and genuinely does nothing. */
await page.evaluate(() => {
  const ui = WALLY.ctx.ui;
  const orig = ui.interact;
  window.__fired = 0;
  Object.defineProperty(ui, 'interact', {
    configurable: true, writable: true,
    value: function () { window.__fired++; return orig.apply(this, arguments); },
  });
  window.__cap = { spurious: 0, clean: 0 };
  document.querySelector('.w-abtn.big.act').addEventListener('lostpointercapture', (e) => {
    if (e.buttons) window.__cap.spurious++; else window.__cap.clean++;
  }, true);
});

const J = [[5, -4], [-6, 3], [4, 6], [-3, -5]];
/** THE CHORDED SHAPE: button "none" while buttons is still 1. */
const chordPress = async () => {
  await mouseAt('mouseMoved', act.x, act.y);
  await mouseAt('mousePressed', act.x, act.y, 'left', 1);
  await page.waitForTimeout(25);
  for (const [dx, dy] of J) { await mouseAt('mouseMoved', act.x + dx, act.y + dy, 'none', 1); await page.waitForTimeout(20); }
  await mouseAt('mouseReleased', act.x, act.y, 'left', 0);
  await page.waitForTimeout(140);
};
/** THE ORDINARY SHAPE, the one that discriminates nothing. */
const plainPress = async () => {
  await mouseAt('mouseMoved', act.x, act.y);
  await mouseAt('mousePressed', act.x, act.y, 'left', 1);
  await page.waitForTimeout(25);
  for (const [dx, dy] of J) { await mouseAt('mouseMoved', act.x + dx, act.y + dy, 'left', 1); await page.waitForTimeout(20); }
  await mouseAt('mouseReleased', act.x, act.y, 'left', 0);
  await page.waitForTimeout(140);
};
const fired = () => page.evaluate(() => window.__fired);
const capRead = () => page.evaluate(() => window.__cap);
const capZero = () => page.evaluate(() => { window.__cap = { spurious: 0, clean: 0 }; });

const runArm = async (gesture, retry, n) => {
  await page.evaluate((r) => WALLY.debug.padCaptureRetry(r), retry);
  const a = await fired(); await gesture(); const b = await fired();
  return b - a;
};

const N = 20;
let onHits = 0, offHits = 0;
await capZero();
for (let i = 0; i < N; i++) {
  onHits += await runArm(chordPress, true, 1);
  offHits += await runArm(chordPress, false, 1);
}
const capChord = await capRead();
console.log(`\nCHORDED (button:none, buttons:1) — ${N * 2} presses`);
console.log(`  spurious losses (buttons set): ${capChord.spurious}   clean: ${capChord.clean}`);
console.log(`  retry ON : ${onHits}/${N} presses fired  (lost ${N - onHits})`);
console.log(`  retry OFF: ${offHits}/${N} presses fired  (lost ${N - offHits})`);

await page.evaluate(() => WALLY.debug.padCaptureRetry(true));
await capZero();
let pOn = 0, pOff = 0;
for (let i = 0; i < N; i++) {
  pOn += await runArm(plainPress, true, 1);
  pOff += await runArm(plainPress, false, 1);
}
const capPlain = await capRead();
console.log(`\nORDINARY LEFT-BUTTON MOVES — ${N * 2} presses  (the shape that discriminates nothing)`);
console.log(`  spurious losses: ${capPlain.spurious}   clean: ${capPlain.clean}`);
console.log(`  retry ON : ${pOn}/${N}   retry OFF: ${pOff}/${N}`);
await page.evaluate(() => WALLY.debug.padCaptureRetry(true));

/* --- touch on the same button --- */
await capZero();
let tHits = 0;
for (let i = 0; i < N; i++) {
  const a = await fired();
  await touch('touchStart', act.x, act.y);
  await page.waitForTimeout(30);
  for (const [dx, dy] of J) { await touch('touchMove', act.x + dx, act.y + dy); await page.waitForTimeout(20); }
  await touch('touchEnd', act.x, act.y);
  await page.waitForTimeout(160);
  tHits += (await fired()) - a;
}
const capT = await capRead();
console.log(`\nREAL FINGER on the same button — ${N} presses`);
console.log(`  fired ${tHits}/${N}, spurious ${capT.spurious}, clean ${capT.clean}`);

/* --- the ring --- */
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); });
await page.waitForTimeout(500);
const mc = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.w-abtn')].find(e => e.getAttribute('aria-label') === 'Menu');
  const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await touch('touchStart', mc.x, mc.y); await page.waitForTimeout(70); await touch('touchEnd', mc.x, mc.y);
await page.waitForTimeout(500);
console.log('\nRING on a thumb-opened panel:', JSON.stringify(await page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return { focus: 'body' };
  const s = getComputedStyle(a);
  return { el: a.className, fv: a.matches(':focus-visible'),
    outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, outlineColor: s.outlineColor };
})));

/* --- the canvas path --- */
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); });
await page.waitForTimeout(400);
const key = async (k, code, kc) => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
  await page.waitForTimeout(20);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
  await page.waitForTimeout(30);
};
const who = () => page.evaluate(() => { const a = document.activeElement; return a?.getAttribute?.('aria-label') || a?.tagName || 'null'; });
for (let i = 0; i < 80; i++) { await key('Tab', 'Tab', 9); if ((await who()) === 'Menu') break; }
console.log('\nCANVAS before:', await who(), JSON.stringify(await page.evaluate(() => WALLY.debug.padKeyboard())));
const yaw0 = await page.evaluate(() => WALLY.ctx.cam.yaw);
await touch('touchStart', 195, 300);
await page.waitForTimeout(40);
for (let k = 1; k <= 6; k++) { await touch('touchMove', 195 - k * 12, 300); await page.waitForTimeout(25); }
await touch('touchEnd', 195 - 72, 300);
await page.waitForTimeout(350);
const yaw1 = await page.evaluate(() => WALLY.ctx.cam.yaw);
console.log('CANVAS after :', await who(), JSON.stringify(await page.evaluate(() => WALLY.debug.padKeyboard())));
console.log('  camera orbited:', (Math.abs(Math.atan2(Math.sin(yaw1 - yaw0), Math.cos(yaw1 - yaw0))) * 57.3).toFixed(1), 'deg');
/* and Space must NOT open a panel now */
await page.evaluate(() => WALLY.ctx.ui.closeAll());
await key(' ', 'Space', 32);
await page.waitForTimeout(400);
console.log('  Space after canvas touch opened a panel?', await page.evaluate(() => WALLY.ctx.ui.modal));
/* Tab hands it back */
await key('Tab', 'Tab', 9);
await page.waitForTimeout(100);
console.log('  after one Tab:', JSON.stringify(await page.evaluate(() => WALLY.debug.padKeyboard())));

await browser.close(); server.close();
