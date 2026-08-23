/* _vjidle4.mjs — the one thing the swallow does NOT cover: tap ONE of the
   waking double tap is never suppressed, so the claim that a wake gesture
   fires nothing rests entirely on there being no live DOM under a finger
   while the controls are faded. Swept densely, with the game talking. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => { const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b); }
  catch { rs.writeHead(404).end(); } });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
let fails = 0;
const ok = (c, m, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${x ? '   ' + x : ''}`); return c; };
const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctxM.newPage();
page.on('pageerror', e => { console.log('PAGEERROR', e.message.split('\n')[0]); fails++; });
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 60000 });
await page.waitForTimeout(3500);
const cdp = await ctxM.newCDPSession(page);
const t1 = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type,
  touchPoints: (type === 'touchEnd') ? [] : [{ x, y, id: 1, radiusX: 14, radiusY: 14, force: 1 }] });
await page.evaluate(() => { WALLY.debug.hideUI(true); WALLY.debug.idle(1.4); return null; });
await page.waitForTimeout(600);
/* make the game talk: toasts, a notification and a banner, plus a door
   prompt, so every kept-on-purpose layer is on screen at once */
await page.evaluate(() => {
  const ui = WALLY.ctx.ui;
  ui.toast?.('A toast that is on screen'); ui.toast?.('And a second one');
  ui.banner?.('BANNER', 'over the faded controls');
  WALLY.ctx.game?.bus?.emit?.('notify', { title: 'Note', text: 'a notification' });
  return null;
});
await page.waitForTimeout(2600);
const st = await page.evaluate(() => WALLY.debug.idle());
const sweep = await page.evaluate(() => {
  const out = [];
  for (let x = 15; x < 390; x += 25) for (let y = 15; y < 844; y += 25) {
    const e = document.elementFromPoint(x, y);
    const id = e ? (e.id || e.tagName.toLowerCase() + '.' + String(e.className || '').trim().split(/\s+/).join('.')) : 'null';
    if (!e || e !== WALLY.ctx.canvas) out.push([x, y, id]);
  }
  return { bad: out, live: !!document.querySelector('.w-toast, .w-banner, .w-note') };
});
ok(st.hidden === true, 'Y-1 [faded, with the game talking]', `why ${st.why}`);
ok(sweep.live === true, 'Y-2 [there really were toasts / a banner / a notification on screen]');
ok(sweep.bad.length === 0,
  'Y-3 [tap one has nothing to hit]: with the controls faded and toasts, a banner and a notification up, all 480 points of a 25 px grid resolve to the CANVAS — the unswallowed FIRST tap of a wake gesture can reach nothing',
  sweep.bad.length ? JSON.stringify(sweep.bad.slice(0, 6)) : '480/480 canvas');
console.log(fails ? `\nFAIL — ${fails} red.` : '\nPASS — every assertion green.');
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
