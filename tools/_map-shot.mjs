/* _map-shot.mjs — MAP AGENT: PNG of each chart at each size, cropped to
   the chart, so the numbers can be looked at. node tools/_map-shot.mjs [tag] */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const M = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const srv = createServer(async (rq, rs) => {
  try { const c = decodeURIComponent(rq.url.split('?')[0]);
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': M[extname(c)] || 'application/octet-stream', 'cache-control': 'no-store' }); rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const TAG = process.argv[2] || 'm5';
const br = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio'] });
for (const c of [{ n: 'phone', w: 390, h: 844 }, { n: 'land', w: 844, h: 390 }, { n: 'desk', w: 1400, h: 900 }]) {
  const pg = await br.newPage({ viewport: { width: c.w, height: c.h }, deviceScaleFactor: 2 });
  await pg.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil: 'load', timeout: 120000 });
  await pg.waitForFunction('window.__WALLY_READY__===true', { timeout: 180000 });
  await pg.waitForTimeout(6000);
  await pg.evaluate(() => { const g = window.WALLY.ctx.game;
    for (const l of g.data.locations) { g.state.known[l.id] = true; g.state.access[l.id] = true; } });
  for (const v of ['places', 'map']) {
    await pg.evaluate((x) => window.WALLY.debug.ui(x), v);
    await pg.waitForTimeout(1800);
    const el = await pg.$('.w-map');
    if (el) await el.screenshot({ path: join(ROOT, 'shots', `${TAG}-${c.n}-${v}.png`) });
  }
  await pg.close();
}
await br.close(); srv.close();
console.log('shots written');
