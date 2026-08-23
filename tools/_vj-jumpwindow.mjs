/* How much headroom does the EXISTING spaceJump() single sample have?
   touchtest.mjs's PANEL-7 reads velocity.y ONCE, 190 ms after keydown,
   and asserts > 1.0. Under load the sample lands late. Measure the
   decay curve so the margin is a number and not an opinion. */
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
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(3500);
const B = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
for (let k = 0; k < 3; k++) {
  await page.evaluate((b) => { WALLY.ctx.ui.closeAll(); WALLY.debug.hideUI(false); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {}); }, B);
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    window.__tr = []; window.__on = true; const t0 = performance.now();
    const t = () => { if (!window.__on) return;
      const c = WALLY.ctx.wally.controller, v = c && (c.velocity || c.vel);
      if (v) window.__tr.push([+(performance.now() - t0).toFixed(0), +v.y.toFixed(2)]);
      requestAnimationFrame(t); };
    requestAnimationFrame(t);
  });
  await page.keyboard.down('Space');
  await page.waitForTimeout(190);
  const at190 = await page.evaluate(() => +WALLY.ctx.wally.controller.velocity.y.toFixed(2));
  await page.keyboard.up('Space');
  await page.waitForTimeout(600);
  const tr = await page.evaluate(() => { window.__on = false; return window.__tr; });
  const peak = Math.max(...tr.map(r => r[1]));
  const cross = tr.find(r => r[1] < 1.0 && r[0] > 40);
  console.log(`run ${k}: peak ${peak}  sample-at-190ms ${at190}  vy<1.0 first at t=${cross ? cross[0] : '-'}ms  frames ${tr.length}`);
}
await browser.close(); server.close();
