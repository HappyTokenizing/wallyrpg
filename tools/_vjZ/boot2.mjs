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
page.on('pageerror', e => console.log('PAGEERROR', e.message.split('\n').slice(0,4).join(' | ')));
page.on('console', m => console.log('CONSOLE', m.type(), m.text().slice(0,240)));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(15000);
console.log(JSON.stringify(await page.evaluate(() => ({
  ready: window.__WALLY_READY__,
  boot: document.getElementById('bootStage')?.textContent || document.getElementById('bootStatus')?.textContent,
  ctxKeys: Object.keys(window.WALLY?.ctx || {}),
  dbg: Object.keys(window.WALLY?.debug || {}),
})), null, 1));
await browser.close(); server.close();
