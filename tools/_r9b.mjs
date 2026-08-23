/* _r9b.mjs — ROUND NINE part 2: widen off the control arm.
   Sheets opened/closed by different modalities, nesting, a vanished
   opener, a faded pad, the screen reader, and every other focus()
   in the layer. Real CDP input only. */
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

const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctxM.newPage();
page.on('pageerror', e => { console.log('PAGEERROR', e.message.split('\n')[0]); fails++; });
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 90000 });
await page.waitForTimeout(3500);
const cdp = await ctxM.newCDPSession(page);
const P = (x, y) => [{ x, y, id: 1, radiusX: 14, radiusY: 14, force: 1 }];
const touch = (t, x, y) => cdp.send('Input.dispatchTouchEvent', { type: t, touchPoints: (t === 'touchEnd' || t === 'touchCancel') ? [] : P(x, y) });
const wait = (ms) => page.waitForTimeout(ms);
const KEYS = {
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  KeyP: { key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, text: 'p' },
  KeyM: { key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77, text: 'm' },
  KeyO: { key: 'o', code: 'KeyO', windowsVirtualKeyCode: 79, text: 'o' },
};
const keyDown = (n) => cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...KEYS[n] });
const keyUp = (n) => cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...KEYS[n], text: undefined });
const key = async (n, h = 30) => { await keyDown(n); await wait(h); await keyUp(n); };

const padKb = () => page.evaluate(() => WALLY.debug.padKeyboard());
const restore = () => page.evaluate(() => WALLY.debug.focusRestore());
const panels = () => page.evaluate(() => WALLY.ctx.ui.panels.slice());
const focusNow = () => page.evaluate(() => { const a = document.activeElement;
  if (!a || a === document.body) return { label: null, inPad: false };
  return { label: a.getAttribute?.('aria-label') || a.className || a.tagName, inPad: !!a.closest?.('.w-touch') }; });
const padAt = (l) => page.evaluate((L) => { const b = [...document.querySelectorAll('.w-abtn')].find(e => e.getAttribute('aria-label') === L);
  if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, l);
const tabTo = async (l, max = 90) => { for (let i = 0; i < max; i++) { await key('Tab', 8); await wait(10);
  const f = await focusNow(); if (f.inPad && f.label === l) return { ...f, tabs: i + 1 }; } return null; };
const reset = async () => { await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); }); await wait(320); };
const thumbTap = async (l, h = 70) => { const c = await padAt(l); if (!c) return false;
  await touch('touchStart', c.x, c.y); await wait(h); await touch('touchEnd', c.x, c.y); await wait(320); return true; };
const thumbJump = async (h = 110) => { const c = await padAt('Jump');
  await touch('touchStart', c.x, c.y); await wait(h); await touch('touchEnd', c.x, c.y); await wait(260); };
const arm = () => page.evaluate(() => {
  if (window.__R9armed) { window.__R9 = { focus: [], sign: [] }; return true; }
  window.__R9armed = true; window.__R9 = { focus: [], sign: [] };
  const lbl = (el) => !el ? null : (el.getAttribute?.('aria-label') || el.className || el.tagName);
  const t = WALLY.ctx.ui.touch, o = t.uiWillFocus;
  t.uiWillFocus = function (el) { const r = o.call(t, el); window.__R9.sign.push({ el: lbl(el), r }); return r; };
  document.addEventListener('focusin', (e) => window.__R9.focus.push({ el: lbl(e.target),
    inPad: !!e.target.closest?.('.w-touch'), drivingAfter: WALLY.debug.padKeyboard().driving }), false);
  return true;
});
const led = () => page.evaluate(() => window.__R9);
const jumpVy = async (ms = 200) => { await keyDown('Space'); await wait(ms);
  const v = await page.evaluate(() => ({ vy: +WALLY.ctx.wally.controller.velocity.y.toFixed(2) }));
  await keyUp('Space'); return v.vy; };

await page.evaluate(() => { WALLY.debug.hideUI(false); WALLY.ctx.ui.closeAll(); });
await wait(500);

/* stale state the whole rule is about: one Tab ever, then thumbs */
const stale = async () => { await reset(); const t = await tabTo('Menu'); await thumbJump(); return t; };
const resumeBtn = () => page.evaluate(() => {
  const b = [...document.querySelectorAll('.w-pause button, .w-sheet button')].find(e => /resume/i.test(e.textContent || ''));
  if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});

/* =====================================================================
   5. A TAB LANDING INSIDE THE HAND-BACK WINDOW
   ===================================================================== */
console.log('\n== 5. a Tab pressed inside the hand-back window ==');
await stale();
await thumbTap('Menu');
const res5 = await resumeBtn();
await arm();
await touch('touchStart', res5.x, res5.y); await wait(50); await touch('touchEnd', res5.x, res5.y);
await keyDown('Tab'); await keyUp('Tab');          // straight into the window
await wait(900);
const f5 = await focusNow(); const kb5 = await padKb(); const rec5 = await restore();
await key('Space'); await wait(700);
const pan5 = await panels();
console.log('  ledger:', JSON.stringify((await led()).focus), JSON.stringify((await led()).sign));
ok(rec5 && rec5.attempts > 1,
  'R9-7-pre [the window really was open when the Tab arrived]', JSON.stringify(rec5));
ok(kb5.driving === false && pan5.length === 1,
  'R9-7 [a Tab inside the hand-back window is still the player]: the fresh Tab clears the flag and the following Space fires a pad button',
  `focus ${JSON.stringify(f5)}, kb ${JSON.stringify(kb5)}, panels ${JSON.stringify(pan5)}`);

/* =====================================================================
   6. MODALITY CROSSINGS
   ===================================================================== */
console.log('\n== 6. opened by touch / closed by keyboard, and the reverse ==');
/* 6a: thumb opens, ESCAPE closes */
await stale();
await arm();
await thumbTap('Menu');
const panA = await panels();
await key('Escape'); await wait(800);
const kb6a = await padKb(); const rec6a = await restore(); const vy6a = await jumpVy(); await wait(500);
const pan6a = await panels();
ok(panA.length === 1 && pan6a.length === 0 && vy6a > 1,
  'R9-8 [thumb-opened, keyboard-closed: Space still jumps]',
  `kb ${JSON.stringify(kb6a)}, restore ${JSON.stringify(rec6a)}, vy ${vy6a}, panels ${JSON.stringify(pan6a)}`);

/* 6b: KEYBOARD opens (tab+Space), thumb closes */
await reset();
const t6 = await tabTo('Menu');
await arm();
await key('Space'); await wait(700);
const panB = await panels();
const kb6bOpen = await padKb();
const res6 = await resumeBtn();
await touch('touchStart', res6.x, res6.y); await wait(60); await touch('touchEnd', res6.x, res6.y);
await wait(900);
const kb6b = await padKb(); const rec6b = await restore();
await key('Space'); await wait(700);
const pan6b = await panels();
ok(t6 !== null && panB.includes('pause') && kb6bOpen.driving === false,
  'R9-9-pre [set up]: a keyboard player opened the pause sheet with Space, flag still clear', JSON.stringify(kb6bOpen));
ok(kb6b.driving === true && pan6b.length === 0,
  'R9-9 [keyboard-opened, THUMB-closed: the thumb on Resume sets the flag, and the restored bookmark does not hand Space back]',
  `kb ${JSON.stringify(kb6b)}, restore ${JSON.stringify(rec6b)}, panels ${JSON.stringify(pan6b)}`);

/* =====================================================================
   7. NESTED SHEETS AND A SHEET CLOSED BY OPENING ANOTHER
   ===================================================================== */
console.log('\n== 7. nesting ==');
await stale();
await arm();
await thumbTap('Menu');
await page.evaluate(() => WALLY.ctx.ui.show('settings'));
await wait(500);
const panN = await panels();
await page.evaluate(() => WALLY.ctx.ui.hide());
await wait(500);
const rec7a = await restore(); const kb7a = await padKb();
await page.evaluate(() => WALLY.ctx.ui.hide());
await wait(800);
const rec7b = await restore(); const kb7b = await padKb();
const vy7 = await jumpVy(); await wait(400);
const pan7 = await panels();
ok(panN.length === 2,
  'R9-10-pre [two panels really stacked]', JSON.stringify(panN));
ok(kb7a.driving === true && kb7b.driving === true && vy7 > 1 && pan7.length === 0,
  'R9-10 [nested sheets: neither the hand-back DOWN the stack nor the one OUT of it speaks for the player]',
  `inner ${JSON.stringify(rec7a)} -> ${JSON.stringify(kb7a)}; outer ${JSON.stringify(rec7b)} -> ${JSON.stringify(kb7b)}; vy ${vy7}`);

/* 7b — a sheet closed by OPENING another (closeAll + push) */
await stale();
await arm();
await thumbTap('Menu');
await page.evaluate(() => WALLY.debug.ui('phone'));   // closeAll(), then push
await wait(700);
const pan7b = await panels();
const kb7c = await padKb(); const rec7c = await restore();
await key('Escape'); await wait(400); await key('Escape'); await wait(800);
const kb7d = await padKb();
const vy7b = await jumpVy(); await wait(400);
const pan7d = await panels();
console.log('  sheet-replaces-sheet ledger:', JSON.stringify((await led()).focus), JSON.stringify((await led()).sign));
ok(pan7b.includes('phone'),
  'R9-11-pre [the second sheet really replaced the first]', JSON.stringify(pan7b));
ok(kb7c.driving === true && kb7d.driving === true && vy7b > 1 && pan7d.length === 0,
  'R9-11 [a sheet closed by opening another: the closeAll hand-back is still signed]',
  `on replace ${JSON.stringify(rec7c)} ${JSON.stringify(kb7c)}; after ${JSON.stringify(kb7d)}, vy ${vy7b}, panels ${JSON.stringify(pan7d)}`);

/* =====================================================================
   8. THE OPENER NO LONGER EXISTS ON CLOSE
   ===================================================================== */
console.log('\n== 8. the opener is gone ==');
/* 8a — the opener button DISABLED while the sheet is up */
await stale();
await thumbTap('Menu');
await arm();
const dis = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.w-abtn')].find(e => e.getAttribute('aria-label') === 'Menu');
  b.disabled = true; return !!b.disabled;
});
await key('Escape'); await wait(1000);
const rec8a = await restore(); const kb8a = await padKb(); const f8a = await focusNow();
await page.evaluate(() => { const b = [...document.querySelectorAll('.w-abtn')].find(e => e.getAttribute('aria-label') === 'Menu'); b.disabled = false; });
const vy8a = await jumpVy(); await wait(400);
const pan8a = await panels();
ok(dis === true,
  'R9-12-pre [the opener really was disabled before the close]', `disabled ${dis}`);
ok(kb8a.driving === true && vy8a > 1 && pan8a.length === 0,
  'R9-12 [a hand-back that never lands leaves nothing armed: Space still jumps]',
  `restore ${JSON.stringify(rec8a)}, kb ${JSON.stringify(kb8a)}, focus ${JSON.stringify(f8a)}, vy ${vy8a}`);

/* 8b — THE PAD FADED at the moment of the close. focusable() reads
   getClientRects(), which a visibility:hidden element still has. */
console.log('\n== 8b. the pad FADED under the hand-back ==');
await page.evaluate(() => WALLY.debug.hideUI(true));
await stale();
await page.evaluate(() => WALLY.debug.idle(0.4));
await wait(1600);
const idleBefore = await page.evaluate(() => WALLY.debug.idle());
const faded = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.w-abtn')].find(e => e.getAttribute('aria-label') === 'Menu');
  const cl = b.closest('.w-acts') || b.parentElement;
  return { vis: getComputedStyle(b).visibility, clusterVis: getComputedStyle(cl).visibility,
    rects: b.getClientRects().length, disabled: !!b.disabled, connected: b.isConnected };
});
/* what does ui.js's focusable() say, and does focus() actually land? */
const fadedProbe = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.w-abtn')].find(e => e.getAttribute('aria-label') === 'Menu');
  document.activeElement?.blur?.();
  const uiSaysFocusable = !!b && b.isConnected && !b.disabled && typeof b.focus === 'function' && b.getClientRects().length > 0;
  const signed = WALLY.debug.padSignFocus(b);
  b.focus({ preventScroll: true });
  return { uiSaysFocusable, signed, landed: document.activeElement === b,
    active: document.activeElement === document.body ? 'body' : (document.activeElement?.getAttribute?.('aria-label') || document.activeElement?.className) };
});
console.log('  faded pad:', JSON.stringify(faded), 'idle', JSON.stringify(idleBefore));
console.log('  faded focus probe:', JSON.stringify(fadedProbe));
ok(!(fadedProbe.uiSaysFocusable === true && fadedProbe.landed === false),
  'R9-13 [ui.js focusable() agrees with the browser about a FADED pad button]: the hand-back must not report a landing, sign a signature and burn its retries on a focus() the browser silently refused',
  JSON.stringify(fadedProbe));
/* and if it lies, does the stale signature swallow the next real focus? */
if (fadedProbe.uiSaysFocusable === true && fadedProbe.landed === false) {
  await page.evaluate(() => WALLY.debug.idle(undefined));
  const woke = await page.evaluate(() => { const c = [...document.querySelectorAll('.w-abtn')].find(e => e.getAttribute('aria-label') === 'Menu');
    return getComputedStyle(c).visibility; });
  console.log('  after wake, Menu visibility:', woke);
}
await page.evaluate(() => { WALLY.debug.idle(undefined); WALLY.debug.hideUI(false); });
await wait(900);

/* =====================================================================
   9. THE SCREEN READER, DIRECTLY
   ===================================================================== */
console.log('\n== 9. a screen reader moving its own cursor ==');
await stale();                                        // driving true, focus on Menu
await arm();
const srMoved = await page.evaluate(() => {           // rotor: bare focus, no key, no contact
  const b = [...document.querySelectorAll('.w-abtn')].find(e => e.getAttribute('aria-label') === 'Phone');
  b.focus({ preventScroll: true }); return document.activeElement === b;
});
await wait(200);
const kb9 = await padKb();
/* ...and the AT activation: a detail-0 click, which is what VoiceOver
   sends after its own focus move */
const fired9 = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.w-abtn')].find(e => e.getAttribute('aria-label') === 'Phone');
  const before = WALLY.ctx.ui.panels.length;
  b.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
  return { before };
});
await wait(700);
const pan9 = await panels();
ok(srMoved && kb9.driving === false,
  'R9-14 [an unsigned programmatic focus is still the player]: a rotor move with no keystroke and no contact clears the flag',
  JSON.stringify(kb9));
ok(pan9.includes('phone'),
  'R9-15 [...and the AT activation that follows it FIRES]: detail-0 click on the focused pad button opens the phone',
  `panels ${JSON.stringify(pan9)}, ${JSON.stringify(fired9)}`);

/* 9b — the same, straight after a RESTORE (the new state) */
await page.evaluate(() => WALLY.ctx.ui.closeAll()); await wait(600);
await stale();
await thumbTap('Menu');
await key('Escape'); await wait(900);
const kb9bPre = await padKb();
await arm();
const srMoved2 = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.w-abtn')].find(e => e.getAttribute('aria-label') === 'Phone');
  b.focus({ preventScroll: true }); return document.activeElement === b;
});
await wait(200);
const kb9b = await padKb();
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.w-abtn')].find(e => e.getAttribute('aria-label') === 'Phone');
  b.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
});
await wait(700);
const pan9b = await panels();
ok(kb9bPre.driving === true,
  'R9-16-pre [the restore really left the flag set]', JSON.stringify(kb9bPre));
ok(srMoved2 && kb9b.driving === false && pan9b.includes('phone'),
  'R9-16 [a screen reader can still get out of the state a RESTORE leaves behind]: rotor move then AT activation opens the phone',
  `${JSON.stringify(kb9b)}, panels ${JSON.stringify(pan9b)}`);

/* =====================================================================
   10. EVERY OTHER focus() IN THE LAYER
   ===================================================================== */
console.log('\n== 10. the layer’s other focus() calls ==');
await page.evaluate(() => WALLY.ctx.ui.closeAll()); await wait(500);
await stale();                                        // driving true
await arm();
const kb10a = await padKb();
/* a sheet with a search input: ui.js focuses it 80 ms after open */
await page.evaluate(() => WALLY.debug.ui('map'));
await wait(900);
const inputFocus = await focusNow();
const kb10b = await padKb();
await page.evaluate(() => WALLY.ctx.ui.closeAll());
await wait(900);
const kb10c = await padKb();
const vy10 = await jumpVy(); await wait(400);
const pan10 = await panels();
console.log('  after a search-input focus:', JSON.stringify({ inputFocus, kb10a, kb10b, kb10c, vy10 }));
ok(kb10b.driving === true && kb10c.driving === true && vy10 > 1 && pan10.length === 0,
  'R9-17 [an <input> focus inside a sheet is neither a restore nor a player]: it is outside the cluster, so it neither clears the flag nor burns a signature',
  `${JSON.stringify(kb10b)} -> ${JSON.stringify(kb10c)}, vy ${vy10}`);

console.log('\nLOAD at end:', load());
console.log(`\n${fails ? 'FAIL' : 'PASS'} — ${fails} failing`);
await browser.close(); server.close();
process.exit(0);
