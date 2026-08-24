/* _r9f.mjs — ROUND NINE part 6. The mechanism of the DEAF arm, as an
   event ledger rather than an inference: where the player's Tab lands
   when it loses the race, and what the hand-back does to it. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => { const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(ROOT + (c === '/' ? '/index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[c.slice(c.lastIndexOf('.'))] || 'application/octet-stream' }); rs.end(b);
  } catch { rs.writeHead(404).end(); } });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const load = () => execSync('uptime').toString().split('load averages:')[1].trim();
console.log('LOAD at boot:', load(), '(10 cpus)');
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctxM.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 90000 });
await page.waitForTimeout(3500);
const cdp = await ctxM.newCDPSession(page);
const P = (x, y) => [{ x, y, id: 1, radiusX: 14, radiusY: 14, force: 1 }];
const touch = (t, x, y) => cdp.send('Input.dispatchTouchEvent', { type: t, touchPoints: (t === 'touchEnd' || t === 'touchCancel') ? [] : P(x, y) });
const wait = (ms) => page.waitForTimeout(ms);
const K = { Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 } };
const kd = (n) => cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...K[n] });
const ku = (n) => cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...K[n] });
const key = async (n, h = 20) => { await kd(n); await wait(h); await ku(n); };
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
const resumeBtn = () => page.evaluate(() => { const b = [...document.querySelectorAll('.w-pause button, .w-sheet button')].find(e => /resume/i.test(e.textContent || ''));
  const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });

await page.evaluate(() => {
  window.__L = [];
  const lbl = (e) => !e ? null : (e.getAttribute?.('aria-label') || e.className || e.tagName);
  const zone = (e) => !e ? 'body' : (e.closest?.('.w-touch') ? 'pad' : (e.closest?.('.w-sheet,.w-pause,.w-phone') ? (e.closest('.out') ? 'DYING' : 'panel') : 'other'));
  const t = WALLY.ctx.ui.touch, o = t.uiWillFocus;
  t.uiWillFocus = function (el) { const r = o.call(t, el); window.__L.push({ ev: 'SIGN', el: lbl(el), zone: zone(el), r, at: +performance.now().toFixed(1) }); return r; };
  document.addEventListener('focusin', (e) => window.__L.push({ ev: 'focusin', el: lbl(e.target), zone: zone(e.target),
    driving: WALLY.debug.padKeyboard().driving, at: +performance.now().toFixed(1) }), false);
  document.addEventListener('keydown', (e) => { if (e.key === 'Tab') window.__L.push({ ev: 'TAB', at: +performance.now().toFixed(1) }); }, true);
});
await page.evaluate(() => { WALLY.debug.hideUI(false); WALLY.ctx.ui.closeAll(); });
await wait(400);

console.log('\n== the DEAF arm, event by event ==');
for (let i = 0; i < 8; i++) {
  await reset();
  await tabTo('Menu');
  const j = await padAt('Jump');
  await touch('touchStart', j.x, j.y); await wait(110); await touch('touchEnd', j.x, j.y); await wait(260);
  const m = await padAt('Menu');
  await touch('touchStart', m.x, m.y); await wait(70); await touch('touchEnd', m.x, m.y); await wait(320);
  const rb = await resumeBtn();
  await page.evaluate(() => { window.__L = []; });
  await touch('touchStart', rb.x, rb.y); await wait(45); await touch('touchEnd', rb.x, rb.y);
  await kd('Tab'); await ku('Tab');
  await wait(800);
  const kb = await padKb(); const f = await focusNow();
  const L = await page.evaluate(() => window.__L);
  const t0 = L.length ? L[0].at : 0;
  const trace = L.map(x => `${x.ev}${x.el ? '(' + x.zone + ':' + x.el + (x.r !== undefined ? ' r=' + x.r : '') + (x.driving !== undefined ? ' d=' + (x.driving ? 1 : 0) : '') + ')' : ''}@+${(x.at - t0).toFixed(0)}`).join('  ');
  console.log(`  ${kb.driving ? 'DEAF' : ' ok '} focus ${f.where}:${f.label} takesSpace ${kb.padTakesSpace}\n        ${trace}`);
}
console.log('\nLOAD at end:', load());
await browser.close(); server.close();
process.exit(0);
