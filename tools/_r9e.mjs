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
const panels = () => page.evaluate(() => WALLY.ctx.ui.panels.slice());
const focusNow = () => page.evaluate(() => { const a = document.activeElement;
  if (!a || a === document.body) return { label: null, where: 'body' };
  return { label: a.getAttribute?.('aria-label') || a.className || a.tagName,
    where: a.closest?.('.w-touch') ? 'pad' : (a.closest?.('.w-sheet,.w-pause,.w-phone') ? (a.closest('.out') ? 'DYING PANEL' : 'panel') : 'other') }; });
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

/* the debug switch this suite does not have: turn the SIGNATURE off.
   ui.js calls touch.uiWillFocus?.(el) — a property read at call time —
   so an always-false answer arms nothing, isUiRestore() is always
   false, and every hand-back clears the flag: the pre-fix behaviour. */
await page.evaluate(() => {
  const t = WALLY.ctx.ui.touch;
  window.__realSign = t.uiWillFocus;
  window.__signOn = true;
  t.uiWillFocus = function (el) { return window.__signOn ? window.__realSign.call(t, el) : false; };
  window.__tabLand = [];
});
const setSign = (on) => page.evaluate((v) => { window.__signOn = v; return window.__signOn; }, on);

const stale = async () => { await reset(); const t = await tabTo('Menu'); await thumbJump(); return t; };

/* ONE gesture: thumbs Jump, thumbs Menu, thumbs Resume, then TAB —
   the documented way out — then read who owns the next Space. */
const gesture = async () => {
  await stale();
  await thumbTap('Menu');
  const rb = await resumeBtn();
  await touch('touchStart', rb.x, rb.y); await wait(45); await touch('touchEnd', rb.x, rb.y);
  await keyDown('Tab'); await keyUp('Tab');
  await wait(800);
  const kb = await padKb(); const f = await focusNow();
  return { driving: kb.driving, takes: kb.padTakesSpace, focus: f.label, where: f.where };
};

console.log('\n== the A/B: signature ON vs OFF, alternating, one page ==');
const N = 16;
const arms = { on: { deaf: 0, heard: 0, rows: [] }, off: { deaf: 0, heard: 0, rows: [] } };
for (let i = 0; i < N; i++) {
  for (const which of (i % 2 ? ['off', 'on'] : ['on', 'off'])) {
    await setSign(which === 'on');
    const g = await gesture();
    /* DEAF = the player pressed Tab and the pad still refuses the key */
    const deaf = (g.driving === true);
    arms[which][deaf ? 'deaf' : 'heard']++;
    arms[which].rows.push(`${g.where}:${g.focus}/${deaf ? 'DEAF' : 'ok'}`);
  }
}
await setSign(true);
console.log('  signature ON  (shipping):', JSON.stringify({ deaf: arms.on.deaf, heard: arms.on.heard }));
console.log('   ', arms.on.rows.join(' '));
console.log('  signature OFF (pre-fix): ', JSON.stringify({ deaf: arms.off.deaf, heard: arms.off.heard }));
console.log('   ', arms.off.rows.join(' '));
ok(arms.off.deaf === 0,
  'R9-24-pre [the OFF arm is really the old behaviour]: with nothing signed, every hand-back clears the flag and the Tab is never lost',
  `pre-fix deaf ${arms.off.deaf}/${N}`);
ok(arms.on.deaf === 0,
  'R9-24 [the fix did not make the player’s Tab conditional on a frame race]: with the signature shipping, a Tab pressed as the sheet closes still hands the keyboard back every time',
  `shipping deaf ${arms.on.deaf}/${N}, pre-fix deaf ${arms.off.deaf}/${N}`);

/* =====================================================================
   THE CENSUS: where does that Tab actually land, and at what offset
   from the closing lift does the answer stop changing?
   ===================================================================== */
console.log('\n== the edges of the window ==');
for (const off of [0, 30, 80, 150, 320, 600]) {
  const seen = { deaf: 0, heard: 0, land: {} };
  for (let i = 0; i < 6; i++) {
    await stale();
    await thumbTap('Menu');
    const rb = await resumeBtn();
    await touch('touchStart', rb.x, rb.y); await wait(45); await touch('touchEnd', rb.x, rb.y);
    if (off) await wait(off);
    await keyDown('Tab'); await keyUp('Tab');
    await wait(60);
    const mid = await focusNow();
    await wait(750);
    const kb = await padKb(); const f = await focusNow();
    seen[kb.driving ? 'deaf' : 'heard']++;
    const k = `${mid.where}:${mid.label}`;
    seen.land[k] = (seen.land[k] || 0) + 1;
  }
  console.log(`  Tab at +${off} ms: deaf ${seen.deaf}/6, heard ${seen.heard}/6, the Tab landed on ${JSON.stringify(seen.land)}`);
}

console.log('\nLOAD at end:', load());
console.log(`\n${fails ? 'FAIL' : 'PASS'} — ${fails} failing`);
await browser.close(); server.close();
process.exit(0);
