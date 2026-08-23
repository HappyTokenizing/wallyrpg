/* does a SECONDARY-button double click still wake the faded pad? */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 60000 });
await page.waitForTimeout(3500);
const cdp = await ctx.newCDPSession(page);
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.hideUI(true); WALLY.debug.idle(1); });
await page.waitForTimeout(3000);
const before = await page.evaluate(() => WALLY.debug.idle());
const mouse = (type, x, y, button = 'none', buttons = 0) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
async function click(x, y, b, mask) { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, b, mask); await page.waitForTimeout(50); await mouse('mouseReleased', x, y, b, 0); }
await click(195, 500, 'right', 2); await page.waitForTimeout(90); await click(195, 500, 'right', 2);
await page.waitForTimeout(700);
const afterRight = await page.evaluate(() => WALLY.debug.idle());
await page.evaluate(() => { WALLY.debug.idle(1); });
await page.waitForTimeout(3000);
const before2 = await page.evaluate(() => WALLY.debug.idle());
await click(195, 500, 'left', 1); await page.waitForTimeout(90); await click(195, 500, 'left', 1);
await page.waitForTimeout(700);
const afterLeft = await page.evaluate(() => WALLY.debug.idle());
console.log('hidden before right-dbl:', before.hidden, '| after right-dbl:', afterRight.hidden, 'wakes', afterRight.wakes);
console.log('hidden before left-dbl :', before2.hidden, '| after left-dbl :', afterLeft.hidden, 'wakes', afterLeft.wakes);
await browser.close(); server.close();
