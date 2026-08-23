/* _r9c.mjs — ROUND NINE part 3. Corrections to two of my own probes,
   the reachability of the focusable() blindness, and the shape that
   still puts the pause sheet under a Space meant as a jump. */
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
};
const keyDown = (n) => cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...KEYS[n] });
const keyUp = (n) => cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...KEYS[n], text: undefined });
const key = async (n, h = 30) => { await keyDown(n); await wait(h); await keyUp(n); };
const padKb = () => page.evaluate(() => WALLY.debug.padKeyboard());
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
const jumpVy = async (ms = 200) => { await keyDown('Space'); await wait(ms);
  const v = await page.evaluate(() => +WALLY.ctx.wally.controller.velocity.y.toFixed(2)); await keyUp('Space'); return v; };
const resumeBtn = () => page.evaluate(() => {
  const b = [...document.querySelectorAll('.w-pause button, .w-sheet button')].find(e => /resume/i.test(e.textContent || ''));
  if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});

/* ===== the permanent instrument: every hand-back attempt, what the
   element looked like, and whether the focus ACTUALLY landed ===== */
await page.evaluate(() => {
  window.__A = [];
  const t = WALLY.ctx.ui.touch, o = t.uiWillFocus;
  const lbl = (el) => !el ? null : (el.getAttribute?.('aria-label') || el.className || el.tagName);
  t.uiWillFocus = function (el) {
    const r = o.call(t, el);
    const cs = getComputedStyle(el);
    const rec = { el: lbl(el), signed: r, vis: cs.visibility, disp: cs.display, op: cs.opacity,
      rects: el.getClientRects().length, at: Math.round(performance.now()) };
    window.__A.push(rec);
    /* the focus() call is the very next statement in ui.js; check on a
       microtask so we read the result of it */
    queueMicrotask(() => { rec.actually = (document.activeElement === el); });
    return r;
  };
  window.__F = [];
  document.addEventListener('focusin', (e) => window.__F.push({ el: lbl(e.target),
    inPad: !!e.target.closest?.('.w-touch'), driving: WALLY.debug.padKeyboard().driving, at: Math.round(performance.now()) }), false);
});
await page.evaluate(() => { WALLY.debug.hideUI(false); WALLY.ctx.ui.closeAll(); });
await wait(400);
const attempts = () => page.evaluate(() => window.__A.splice(0));
const foci = () => page.evaluate(() => window.__F.splice(0));

const stale = async () => { await reset(); const t = await tabTo('Menu'); await thumbJump(); return t; };

/* =====================================================================
   R9-7 REDO. My own assertion was wrong: the Tab that lands inside the
   window lands on JUMP, whose verb is a jump and not a sheet.
   ===================================================================== */
console.log('\n== 5b. the Tab inside the hand-back window, asserted correctly ==');
await stale();
await thumbTap('Menu');
const res = await resumeBtn();
await attempts(); await foci();
await touch('touchStart', res.x, res.y); await wait(50); await touch('touchEnd', res.x, res.y);
await keyDown('Tab'); await keyUp('Tab');
await wait(900);
const fA = await focusNow(); const kbA = await padKb();
const ledA = await foci(); const attA = await attempts();
console.log('  focusin order:', JSON.stringify(ledA));
console.log('  hand-back attempts:', JSON.stringify(attA));
const vyA = await jumpVy(); await wait(400);
const panA = await panels();
ok(kbA.driving === false,
  'R9-7 [a Tab inside the hand-back window is still the PLAYER]: the flag is cleared by it, so the pad answers the next key',
  `focus ${JSON.stringify(fA)}, kb ${JSON.stringify(kbA)}`);
ok(panA.length === 0 && vyA > 1,
  'R9-7b [...and the key does the thing the focused button does]: with focus left on Jump the Space jumps and opens nothing',
  `vy ${vyA}, panels ${JSON.stringify(panA)}`);

/* =====================================================================
   R9-11 REDO. The phone is at HOME here, so ONE Escape closes it; the
   second Escape is the window-bound pause shortcut, which is what my
   first pass misread as a defect.
   ===================================================================== */
console.log('\n== 7b. a sheet closed by opening another, with the phone at HOME ==');
await stale();
await thumbTap('Menu');
await page.evaluate(() => WALLY.debug.ui('phone'));
await wait(700);
const panP = await panels();
const homeP = await page.evaluate(() => { const b = document.querySelector('.w-phone .w-appbody');
  return { home: !!b && b.classList.contains('home'), tiles: document.querySelectorAll('.w-phone .w-app').length }; });
await attempts(); await foci();
await key('Escape'); await wait(900);
const panQ = await panels(); const kbQ = await padKb();
const vyQ = await jumpVy(); await wait(400);
const panR = await panels();
console.log('  phone home?', JSON.stringify(homeP), 'attempts', JSON.stringify(await attempts()));
ok(panP.includes('phone') && panQ.length === 0,
  'R9-11-pre [one Escape really closes a phone that is on its home grid]',
  `${JSON.stringify(panP)} -> ${JSON.stringify(panQ)}, ${JSON.stringify(homeP)}`);
ok(kbQ.driving === true && vyQ > 1 && panR.length === 0,
  'R9-11 [a sheet closed by opening another: the flag survives both hand-backs and Space still jumps]',
  `kb ${JSON.stringify(kbQ)}, vy ${vyQ}, panels ${JSON.stringify(panR)}`);

/* =====================================================================
   R9-13 REACHABILITY. focusable() calls a visibility:hidden button
   focusable. Is a real hand-back ever attempted against one?
   Battery: every close path, with Hide UI on and the window short.
   ===================================================================== */
console.log('\n== 8c. is the focusable() blindness reachable by a real close? ==');
await page.evaluate(() => { WALLY.debug.hideUI(true); WALLY.debug.idle(0.3); });
const bad = [];
const closers = [
  ['thumb Resume', async () => { const r = await resumeBtn(); if (!r) return; await touch('touchStart', r.x, r.y); await wait(50); await touch('touchEnd', r.x, r.y); }],
  ['Escape', async () => { await key('Escape'); }],
  ['ui.hide()', async () => { await page.evaluate(() => WALLY.ctx.ui.hide()); }],
  ['closeAll()', async () => { await page.evaluate(() => WALLY.ctx.ui.closeAll()); }],
];
for (const [name, close] of closers) {
  for (const dwell of [0, 400, 1200]) {
    await stale();
    await thumbTap('Menu');
    await wait(dwell);                     // let the clock run under the sheet
    const idleUnder = await page.evaluate(() => WALLY.debug.idle());
    await attempts();
    await close();
    await wait(1000);
    const a = await attempts();
    const f = await focusNow();
    const liar = a.filter(x => x.signed && x.actually === false);
    const hiddenAttempt = a.filter(x => x.vis === 'hidden');
    console.log(`  ${name} dwell ${dwell}: idleUnder ${JSON.stringify({ h: idleUnder.hidden, t: idleUnder.t, why: idleUnder.why })} attempts ${JSON.stringify(a)} focus ${JSON.stringify(f)}`);
    if (liar.length || hiddenAttempt.length) bad.push({ name, dwell, liar, hiddenAttempt });
  }
}
ok(bad.length === 0,
  'R9-13 [no real close ever aims a hand-back at a visibility:hidden button]: the focusable() blindness is latent, not live — every attempt measured landed where it said it did',
  bad.length ? JSON.stringify(bad) : 'four close paths x three dwells, all clean');
await page.evaluate(() => { WALLY.debug.idle(undefined); WALLY.debug.hideUI(false); });
await wait(700);

/* =====================================================================
   R9-9 FORMALISED — a finger on a SHEET is not a finger on the pad.
   ===================================================================== */
console.log('\n== 6c. the keyboard-opened, thumb-closed sheet ==');
await reset();
const t9 = await tabTo('Menu');
await key('Space'); await wait(700);
const pan9a = await panels();
const r9 = await resumeBtn();
await touch('touchStart', r9.x, r9.y); await wait(60); await touch('touchEnd', r9.x, r9.y);
await wait(900);
const kb9 = await padKb(); const f9 = await focusNow();
const vy9 = await jumpVy(); await wait(500);
const pan9b = await panels();
ok(t9 !== null && pan9a.includes('pause'),
  'R9-18-pre [set up]: the sheet really was opened from the keyboard', JSON.stringify(pan9a));
console.log('  after the thumb close:', JSON.stringify({ kb9, f9, vy9, pan9b }));
ok(pan9b.length === 0 && vy9 > 1,
  'R9-18 [a real finger closing the sheet counts as driving]: the very next Space is a jump, not the pause sheet again',
  `kb ${JSON.stringify(kb9)}, focus ${JSON.stringify(f9)}, vy ${vy9}, panels ${JSON.stringify(pan9b)}`);

/* control: the identical gesture with the sheet closed by the KEYBOARD
   must, by the design's own sentence, still hand Space to the button */
await reset();
const t9b = await tabTo('Menu');
await key('Space'); await wait(700);
await key('Escape'); await wait(900);
const kb9c = await padKb();
await key('Space'); await wait(700);
const pan9c = await panels();
console.log('  keyboard-open/keyboard-close control:', JSON.stringify({ kb9c, pan9c }));

/* and the third arm: the ONLY difference from R9-18 is where the
   finger landed — pad button vs sheet button */
await reset();
const t9d = await tabTo('Menu');
await key('Space'); await wait(700);
await key('Escape'); await wait(600);       // close it from the keyboard
await thumbJump();                          // ...then one real finger ON THE PAD
const kb9d = await padKb();
const vy9d = await jumpVy(); await wait(500);
const pan9d = await panels();
ok(kb9d.driving === true && pan9d.length === 0 && vy9d > 1,
  'R9-19 [the same session with the finger on a PAD button instead: Space jumps]: the single variable is WHICH element the finger landed on, and it decides whether the pad believes the player is on their thumbs',
  `kb ${JSON.stringify(kb9d)}, vy ${vy9d}, panels ${JSON.stringify(pan9d)}`);

console.log('\nLOAD at end:', load());
console.log(`\n${fails ? 'FAIL' : 'PASS'} — ${fails} failing`);
await browser.close(); server.close();
process.exit(0);
