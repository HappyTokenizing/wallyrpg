/* r9a.mjs — ROUND NINE, gesture breaker.
   Start at the control arm that found PAD-41/PANEL-7, then widen into
   everything the signature could have broken. Real CDP input only. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';

const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(ROOT + (c === '/' ? '/index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[c.slice(c.lastIndexOf('.'))] || 'application/octet-stream' }); rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const load = () => execSync('uptime').toString().split('load averages:')[1].trim();
console.log('LOAD at boot:', load(), '(10 cpus)');

const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
let fails = 0;
const ok = (c, m, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${x ? '\n        ' + x : ''}`); return c; };
const note = (m) => console.log(`note  ${m}`);

const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctxM.newPage();
page.on('pageerror', e => { console.log('PAGEERROR', e.message.split('\n')[0]); fails++; });
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 90000 });
await page.waitForTimeout(3500);
const cdp = await ctxM.newCDPSession(page);
const P = (x, y) => [{ x, y, id: 1, radiusX: 14, radiusY: 14, force: 1 }];
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: (type === 'touchEnd' || type === 'touchCancel') ? [] : P(x, y) });
const wait = (ms) => page.waitForTimeout(ms);

/* ---- raw key dispatch, not page.keyboard sugar ---- */
const KEYS = {
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, text: '\t' },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  KeyP: { key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, text: 'p' },
  KeyM: { key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77, text: 'm' },
  KeyO: { key: 'o', code: 'KeyO', windowsVirtualKeyCode: 79, text: 'o' },
};
const keyDown = (n) => cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...KEYS[n] });
const keyUp = (n) => cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...KEYS[n], text: undefined });
const key = async (n, hold = 30) => { await keyDown(n); await wait(hold); await keyUp(n); };

const padKb = () => page.evaluate(() => WALLY.debug.padKeyboard());
const restore = () => page.evaluate(() => WALLY.debug.focusRestore());
const panels = () => page.evaluate(() => WALLY.ctx.ui.panels.slice());
const focusNow = () => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return { label: null, inPad: false };
  return { label: a.getAttribute?.('aria-label') || a.className || a.tagName, inPad: !!a.closest?.('.w-touch'), disabled: !!a.disabled };
});
const padAt = (label) => page.evaluate((l) => {
  const b = [...document.querySelectorAll('.w-abtn')].find((e) => e.getAttribute('aria-label') === l);
  if (!b) return null; const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
}, label);
const tabTo = async (label, max = 90) => {
  for (let i = 0; i < max; i++) {
    await key('Tab', 10); await wait(12);
    const f = await focusNow();
    if (f.inPad && f.label === label) return { ...f, tabs: i + 1 };
  }
  return null;
};
const reset = async () => {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); });
  await wait(320);
};

/* ---- the ledger ---- */
const arm = () => page.evaluate(() => {
  if (window.__R9armed) { window.__R9 = { focus: [], sign: [], shows: [] }; return true; }
  window.__R9armed = true;
  window.__R9 = { focus: [], sign: [], shows: [] };
  const lbl = (el) => !el ? null : (el.getAttribute?.('aria-label') || el.className || el.tagName);
  const t = WALLY.ctx.ui.touch;
  const o = t.uiWillFocus;
  t.uiWillFocus = function (el) { const r = o.call(t, el); window.__R9.sign.push({ el: lbl(el), r, at: Math.round(performance.now()) }); return r; };
  /* bubble phase: runs AFTER touch.js's capture listener, so `driving`
     here is the value the pad's rule left behind for this focusin */
  document.addEventListener('focusin', (e) => {
    window.__R9.focus.push({ el: lbl(e.target), inPad: !!e.target.closest?.('.w-touch'),
      drivingAfter: WALLY.debug.padKeyboard().driving, at: Math.round(performance.now()) });
  }, false);
  const u = WALLY.ctx.ui; const os = u.show.bind(u);
  u.show = (...a) => { window.__R9.shows.push(String(a[0])); return os(...a); };
  return true;
});
const led = () => page.evaluate(() => window.__R9);
const jumpVy = async (ms = 200) => {
  await keyDown('Space'); await wait(ms);
  const v = await page.evaluate(() => ({ vy: +WALLY.ctx.wally.controller.velocity.y.toFixed(2), g: WALLY.ctx.wally.controller.grounded }));
  await keyUp('Space'); return v;
};
const thumbTap = async (label, hold = 70) => { const c = await padAt(label); if (!c) return false;
  await touch('touchStart', c.x, c.y); await wait(hold); await touch('touchEnd', c.x, c.y); await wait(300); return true; };
const thumbJump = async (hold = 110) => { const c = await padAt('Jump');
  await touch('touchStart', c.x, c.y); await wait(hold); await touch('touchEnd', c.x, c.y); await wait(260); };

await page.evaluate(() => { WALLY.debug.hideUI(false); WALLY.ctx.ui.closeAll(); });
await wait(500);
console.log('LOAD after boot:', load());

/* =====================================================================
   1. THE CONTROL ARM THAT FOUND IT — two arms, one variable
   ===================================================================== */
console.log('\n== 1. the single-variable control arm ==');

const runArm = async (tabFirst) => {
  await reset();
  let t = null;
  if (tabFirst) t = await tabTo('Menu');
  await arm();
  await thumbJump();
  const afterJump = await padKb();
  await thumbTap('Menu');
  const pan = await panels();
  /* close it with a real finger on Resume */
  const res = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.w-pause button, .w-sheet button')]
      .find((e) => /resume|close|back/i.test(e.textContent || '') || e.classList.contains('w-x'));
    if (!b) return null; const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, txt: (b.textContent || '').trim().slice(0, 14) };
  });
  if (res) { await touch('touchStart', res.x, res.y); await wait(60); await touch('touchEnd', res.x, res.y); await wait(700); }
  const afterClose = await padKb();
  const rec = await restore();
  const pan2 = await panels();
  const v = await jumpVy();
  await wait(500);
  const pan3 = await panels();
  return { t, afterJump, pan, res, afterClose, rec, pan2, v, pan3, led: await led() };
};

const A = await runArm(false);
const B = await runArm(true);
console.log('  never-tabbed arm:', JSON.stringify({ afterJump: A.afterJump, afterClose: A.afterClose, restore: A.rec, vy: A.v, panels: A.pan3 }));
console.log('  tabbed-once arm:', JSON.stringify({ tab: B.t?.tabs, afterJump: B.afterJump, afterClose: B.afterClose, restore: B.rec, vy: B.v, panels: B.pan3 }));
console.log('  tabbed arm focusin ledger:', JSON.stringify(B.led.focus));
console.log('  tabbed arm sign ledger:', JSON.stringify(B.led.sign));

ok(A.pan.length === 1 && B.pan.length === 1 && B.t !== null,
  'R9-1-pre [both arms really ran]: a thumb opened the pause sheet in each, and the tabbed arm really did land a Tab on Menu',
  `A panels ${JSON.stringify(A.pan)}, B panels ${JSON.stringify(B.pan)}, B tabs ${B.t?.tabs}, resume btn "${A.res?.txt}"/"${B.res?.txt}"`);
ok(A.v.vy > 1 && A.pan3.length === 0,
  'R9-1 [never tabbed, thumbs only: Space jumps]', `vy ${A.v.vy}, panels ${JSON.stringify(A.pan3)}`);
ok(B.v.vy > 1 && B.pan3.length === 0,
  'R9-2 [tabbed once then thumbs only: Space STILL jumps — the PANEL-7 fix, re-measured]',
  `vy ${B.v.vy}, panels ${JSON.stringify(B.pan3)}, driving after close ${B.afterClose.driving}`);
ok(B.rec && B.rec.attempts > 1 && B.rec.landed === true && B.rec.signed === true,
  'R9-2b [and it went through the RETRY, signed on the attempt that landed]', JSON.stringify(B.rec));

/* =====================================================================
   2. tabbed, then Space with NO touch in between
   ===================================================================== */
console.log('\n== 2. a keyboard player who never touched anything ==');
await reset();
const t2 = await tabTo('Menu');
await arm();
const kb2 = await padKb();
await key('Space');
await wait(700);
const pan2 = await panels();
ok(t2 !== null && kb2.padTakesSpace === true, 'R9-3-pre [set up]: Tab lands on Menu, pad would answer Space', JSON.stringify(kb2));
ok(pan2.length === 1 && pan2.includes('pause'),
  'R9-3 [tabbed, then Space with no touch in between: the focused button FIRES]', `panels ${JSON.stringify(pan2)}`);

/* =====================================================================
   3. tab, touch, TAB AGAIN, Space
   ===================================================================== */
console.log('\n== 3. a fresh focus after a touch is obeyed ==');
await reset();
const t3a = await tabTo('Menu');
await thumbJump();
const kb3a = await padKb();
await arm();
const t3b = await tabTo('Menu');            // tab all the way round again
const kb3b = await padKb();
await key('Space');
await wait(700);
const pan3 = await panels();
ok(t3a !== null && kb3a.driving === true, 'R9-4-pre [set up]: the thumb really set the flag after the first Tab', JSON.stringify(kb3a));
ok(t3b !== null && kb3b.driving === false && pan3.includes('pause'),
  'R9-4 [tab, touch, TAB AGAIN, Space: the button fires — a fresh focus is obeyed]',
  `${JSON.stringify(kb3b)}, panels ${JSON.stringify(pan3)}`);

/* =====================================================================
   4. THE RESTORE'S OWN RETRY WINDOW
   ===================================================================== */
console.log('\n== 4. inside the hand-back window ==');
/* 4a — TAB inside the window. The window is the frames between the
   close and the focus landing; the pad is display:none for the first
   of them. Fire the Tab with no wait at all after the closing lift. */
const insideWindow = async (what) => {
  await reset();
  const t = await tabTo('Menu');
  await arm();
  await thumbJump();
  await thumbTap('Menu');
  const pan = await panels();
  const res = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.w-pause button, .w-sheet button')]
      .find((e) => /resume/i.test(e.textContent || ''));
    if (!b) return null; const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await touch('touchStart', res.x, res.y);
  await wait(50);
  await touch('touchEnd', res.x, res.y);       // the close begins HERE
  /* no wait: the next line is dispatched into the retry window */
  if (what === 'tab') { await keyDown('Tab'); await keyUp('Tab'); }
  if (what === 'space') { await keyDown('Space'); await keyUp('Space'); }
  if (what === 'touch') { const c = await padAt('Jump'); await touch('touchStart', c.x, c.y); await touch('touchEnd', c.x, c.y); }
  await wait(900);
  return { t, pan, kb: await padKb(), rec: await restore(), panels: await panels(), led: await led(), focus: await focusNow() };
};
const W1 = await insideWindow('tab');
console.log('  TAB in window:', JSON.stringify({ kb: W1.kb, rec: W1.rec, panels: W1.panels, focus: W1.focus }));
console.log('   ledger:', JSON.stringify(W1.led.focus), JSON.stringify(W1.led.sign));
const W2 = await insideWindow('space');
console.log('  SPACE in window:', JSON.stringify({ kb: W2.kb, rec: W2.rec, panels: W2.panels, focus: W2.focus }));
console.log('   ledger:', JSON.stringify(W2.led.focus), JSON.stringify(W2.led.sign));
const W3 = await insideWindow('touch');
console.log('  TOUCH in window:', JSON.stringify({ kb: W3.kb, rec: W3.rec, panels: W3.panels, focus: W3.focus }));
console.log('   ledger:', JSON.stringify(W3.led.focus), JSON.stringify(W3.led.sign));

ok(W2.panels.length === 0,
  'R9-5 [a SPACE landing inside the hand-back window does not reopen the sheet]',
  `panels ${JSON.stringify(W2.panels)}, kb ${JSON.stringify(W2.kb)}`);
ok(W3.kb.driving === true,
  'R9-6 [a TOUCH inside the window still says "thumbs"]', JSON.stringify(W3.kb));

console.log('\nLOAD at end of part 1:', load());
console.log(`\n${fails ? 'FAIL' : 'PASS'} — ${fails} failing`);
await browser.close(); server.close();
process.exit(0);
