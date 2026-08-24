import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { SNAP } from './_gb13-snaplib.mjs';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
export function loadNow(tag = '') {
  const la = execSync('uptime').toString().split('load averages:')[1].trim();
  return `load ${la} / ${execSync('sysctl -n hw.ncpu').toString().trim()} cpu${tag ? ' · ' + tag : ''}`;
}
export async function boot({ url = '/index.html?skipIntro', settle = 4000 } = {}) {
  const server = createServer(async (rq, rs) => {
    const c = decodeURIComponent(rq.url.split('?')[0]);
    try {
      const b = await readFile(SNAP + (c === '/' ? '/index.html' : c));
      rs.writeHead(200, { 'content-type': MIME[c.slice(c.lastIndexOf('.'))] || 'application/octet-stream' });
      rs.end(b);
    } catch { rs.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
  const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  const page = await ctxM.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message.split('\n')[0]));
  await page.goto(`http://127.0.0.1:${port}${url}`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 90000 });
  await page.waitForTimeout(settle);
  const cdp = await ctxM.newCDPSession(page);
  await page.evaluate(() => { WALLY.debug.hideUI(false); WALLY.ctx.ui.closeAll(); });
  await page.waitForTimeout(400);
  return { server, browser, ctxM, page, cdp, errs, close: async () => { await browser.close(); server.close(); } };
}
export { driver, kbState } from './_gb13-lib.mjs';
