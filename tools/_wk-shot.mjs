import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(3500);
await page.evaluate(() => {
  const c = window.WALLY.ctx, w = c.wally;
  const cy = c.world.city || c.city; const v = cy.doorPosition('apartment');
  const H = (x,z)=>{try{const h=c.world.heightAt(x,z);return Number.isFinite(h)?h:0}catch(e){return 0}};
  w.setPosition(v.x + 3, H(v.x+3, v.z+1), v.z + 1);
  c.game.actions.grantRide('bike'); c.game.actions.grantRide('scooter');
  c.game.actions.equipRide('bike');
});
await page.waitForTimeout(2500);
console.error('rideInfo ' + JSON.stringify(await page.evaluate(() => {
  const r = window.WALLY.debug.rideInfo();
  return { id: r.id, cost: r.cost, characterTotal: r.characterTotal };
})));
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
await page.waitForTimeout(2600);
await page.screenshot({ path: '/tmp/wk-parked-near.png' });
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide('scooter'));
await page.waitForTimeout(2600);
await page.screenshot({ path: '/tmp/wk-parked-scooter.png' });
console.error('state ' + JSON.stringify(await page.evaluate(() => window.WALLY.ctx.wally.bikeState)));
/* back off 50 m and look at it */
await page.evaluate(() => {
  const c = window.WALLY.ctx, w = c.wally, T = window.WALLY.THREE;
  const b = w.rideProps.bike;
  const H = (x,z)=>{try{const h=c.world.heightAt(x,z);return Number.isFinite(h)?h:0}catch(e){return 0}};
  const f = new T.Vector3(); c.camera.getWorldDirection(f); f.y=0; f.normalize();
  const x = c.camera.position.x - f.x*46, z = c.camera.position.z - f.z*46;
  w.setPosition(x, H(x,z), z);
});
await page.waitForTimeout(2200);
await page.screenshot({ path: '/tmp/wk-parked-far.png' });
console.error('far ' + JSON.stringify(await page.evaluate(() => {
  const c = window.WALLY.ctx, w = c.wally, T = window.WALLY.THREE;
  const b = w.rideProps.bike;
  const box = new T.Box3().setFromObject(b.group); const s = box.getBoundingSphere(new T.Sphere());
  const d = c.camera.position.distanceTo(s.center);
  const fovS = 720/(2*Math.tan(c.camera.fov*Math.PI/360));
  const sc = s.center.clone().project(c.camera);
  return { camD: +d.toFixed(1), px: +((2*s.radius/d)*fovS).toFixed(1), visible: b.group.visible,
    onScreen: sc.z>-1&&sc.z<1&&Math.abs(sc.x)<1&&Math.abs(sc.y)<1,
    screen: [Math.round((sc.x*.5+.5)*1280), Math.round((-sc.y*.5+.5)*720)] };
})));
console.error('ERRS ' + JSON.stringify(errs.slice(0,5)));
await browser.close(); server.close();
