/* _vjA-strip.mjs — side-view frames across the pedal stroke, plus the
   parked pose. node tools/_vjA-strip.mjs <outdir> [ride] [speed] */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || '/tmp/strip';
const RIDE = process.argv[3] || 'bike';
const SPEED = +(process.argv[4] || 5.2);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };

await mkdir(OUT, { recursive: true });
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try {
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' });
    rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 900, height: 620 }, deviceScaleFactor: 3 });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(3500);

await page.evaluate(([r, s]) => window.WALLY.debug.ride(r, s, 'bikeSide'), [RIDE, SPEED]);
await page.waitForTimeout(2500);

const N = 8;
for (let i = 0; i < N; i++) {
  const ph = i / N;
  await page.evaluate((p) => window.WALLY.debug.locoStep(p, 12), ph);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `${RIDE}-ph${String(i)}.png`), clip: { x: 230, y: 300, width: 460, height: 240 } });
}
await page.evaluate(() => window.WALLY.debug.locoPhase(null));

/* the parked pose, forced — nothing in gameplay calls park(true) */
await page.evaluate(() => {
  const w = window.WALLY.ctx.wally;
  if (w.bike && w.bike.park) w.bike.park(true);
});
await page.waitForTimeout(800);
await page.screenshot({ path: join(OUT, `${RIDE}-parked.png`) });

const parked = await page.evaluate(() => {
  const b = window.WALLY.ctx.wally.bike;
  return { stand: b.stand ? b.stand.visible : null, rotZ: b.group.rotation.z, crank: b.crank ? b.crank.rotation.x : null };
});
console.log('parked state', JSON.stringify(parked));

await browser.close();
server.close();
