/* _vk-swap.mjs — park the bicycle, then equip a different machine, and
   see what happens to the one that was left standing there. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(3500);

const probe = () => page.evaluate(() => {
  const c = window.WALLY.ctx, w = c.wally, ps = w.rideProps;
  const one = (p) => p ? { parent: p.group.parent === c.scene ? 'scene' : (p.group.parent === w.root ? 'root' : (p.group.parent ? 'other' : 'none')),
    visible: p.group.visible, rotZ: +p.group.rotation.z.toFixed(3),
    pos: [+p.group.position.x.toFixed(2), +p.group.position.y.toFixed(2), +p.group.position.z.toFixed(2)],
    stand: p.stand ? p.stand.visible : null,
    camDist: +c.camera.position.distanceTo(p.group.position).toFixed(1) } : null;
  return { ride: w.rideId, riding: w.riding, props: Object.fromEntries(Object.keys(ps).map((k) => [k, one(ps[k])])),
    playerAt: [+w.root.position.x.toFixed(1), +w.root.position.z.toFixed(1)] };
});

await page.evaluate((cull) => { const a = window.WALLY.ctx.game.actions; a.grantRide('bike'); if (!cull) a.grantRide('scooter'); a.equipRide('bike'); }, process.argv.includes('--cullonly'));
await page.waitForTimeout(2200);
await page.keyboard.down('KeyW'); await page.waitForTimeout(1200); await page.keyboard.up('KeyW');
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
await page.waitForTimeout(2500);
console.log('AFTER PARK   ' + JSON.stringify(await probe()));
if (!process.argv.includes('--cullonly')) await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide('scooter'));
await page.waitForTimeout(2500);
console.log('AFTER SWAP   ' + JSON.stringify(await probe()));
/* now ride a long way off and see whether the abandoned bicycle is culled */
await page.keyboard.down('ShiftLeft'); await page.keyboard.down('KeyW');
await page.waitForTimeout(process.argv.includes('--cullonly') ? 4000 : 12000);
await page.keyboard.up('KeyW'); await page.keyboard.up('ShiftLeft');
await page.waitForTimeout(1200);
console.log('FAR AWAY     ' + JSON.stringify(await probe()));
if (process.argv.includes('--cullonly')) {
  /* walk back towards it and watch the cull flip */
  for (const [k, ms] of [['KeyS', 2500], ['KeyS', 2500], ['KeyS', 2500], ['KeyS', 2500]]) {
    await page.keyboard.down(k); await page.waitForTimeout(ms); await page.keyboard.up(k);
    await page.waitForTimeout(400);
    const p = await probe();
    console.log('  back  dist=' + p.props.bike.camDist + ' visible=' + p.props.bike.visible);
  }
}
console.log('ERRS ' + JSON.stringify(errs.slice(0, 5)));
await browser.close(); server.close();
