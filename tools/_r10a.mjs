/* _r9e.mjs — ROUND NINE part 5. The regression, proved as an A/B on ONE
   page at ONE load: the signature ON (shipping) against the signature
   OFF (byte-for-byte the pre-fix behaviour, since ui.js reads
   touch.uiWillFocus off the object at call time and an always-false
   answer means nothing is ever signed and every restore clears the
   flag). Alternating arms, twenty gestures each, identical finger
   events, one Tab. Plus the census of where that Tab actually lands. */
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
const KEYS = { Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 } };
const keyDown = (n) => cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...KEYS[n] });
const keyUp = (n) => cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...KEYS[n], text: undefined });
const key = async (n, h = 25) => { await keyDown(n); await wait(h); await keyUp(n); };
const padKb = () => page.evaluate(() => WALLY.debug.padKeyboard());
const focusNow = () => page.evaluate(() => { const a = document.activeElement;
  if (!a || a === document.body) return { label: null, where: 'body' };
  return { label: a.getAttribute?.('aria-label') || a.className || a.tagName,
    where: a.closest?.('.w-touch') ? 'pad' : (a.closest?.('.w-sheet,.w-pause,.w-phone') ? (a.closest('.out') ? 'DYING' : 'panel') : 'other') }; });
const padAt = (l) => page.evaluate((L) => { const b = [...document.querySelectorAll('.w-abtn')].find(e => e.getAttribute('aria-label') === L);
  const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, l);
const tabTo = async (l, max = 90) => { for (let i = 0; i < max; i++) { await key('Tab', 8); await wait(10);
  const f = await focusNow(); if (f.where === 'pad' && f.label === l) return { ...f, tabs: i + 1 }; } return null; };
const reset = async () => { await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); }); await wait(300); };
const thumbTap = async (l, h = 70) => { const c = await padAt(l);
  await touch('touchStart', c.x, c.y); await wait(h); await touch('touchEnd', c.x, c.y); await wait(320); };
const thumbJump = async (h = 110) => { const c = await padAt('Jump');
  await touch('touchStart', c.x, c.y); await wait(h); await touch('touchEnd', c.x, c.y); await wait(260); };
const resumeBtn = () => page.evaluate(() => {
  const b = [...document.querySelectorAll('.w-pause button, .w-sheet button')].find(e => /resume/i.test(e.textContent || ''));
  const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await page.evaluate(() => { WALLY.debug.hideUI(false); WALLY.ctx.ui.closeAll(); });
await wait(400);
const setMode = (m) => page.evaluate((v) => WALLY.debug.padHandBackYield(v), m);
const stale = async () => { await reset(); const t = await tabTo('Menu'); await thumbJump(); return t; };
/* ONE gesture: thumbs Jump, thumbs Menu, thumbs Resume, then TAB on
   the closing lift, then read who owns the next Space. */
const gesture = async () => {
  await stale();
  await thumbTap('Menu');
  const rb = await resumeBtn();
  await touch('touchStart', rb.x, rb.y); await wait(45); await touch('touchEnd', rb.x, rb.y);
  await keyDown('Tab'); await keyUp('Tab');
  await wait(800);
  const kb = await padKb(); const f = await focusNow();
  const r = await page.evaluate(() => WALLY.debug.focusRestore());
  return { driving: kb.driving, takes: kb.padTakesSpace, focus: f.label, where: f.where, r };
};
console.log('\n== three arms, alternating, ONE page ==');
const N = 12;
const MODES = ['sign', 'none', 'all'];
const arms = {}; for (const m of MODES) arms[m] = { deaf: 0, heard: 0, lost: 0, rows: [] };
for (let i = 0; i < N; i++) {
  const order = MODES.slice(i % 3).concat(MODES.slice(0, i % 3));
  for (const m of order) {
    await setMode(m);
    const g = await gesture();
    const deaf = (g.driving === true);
    arms[m][deaf ? 'deaf' : 'heard']++;
    if (g.where !== 'pad') arms[m].lost++;
    arms[m].rows.push(`${g.where}:${g.focus}/${deaf ? 'DEAF' : 'ok'}${g.r?.moved ? '*' : ''}`);
  }
}
await setMode('sign');
for (const m of MODES) console.log(`  ${m.padEnd(5)} deaf ${arms[m].deaf}/${N}  place-lost ${arms[m].lost}/${N}\n        ${arms[m].rows.join(' ')}`);
console.log('\nLOAD at end:', load());
await browser.close(); server.close();
process.exit(0);
