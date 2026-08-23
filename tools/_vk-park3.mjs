/* _vk-park3.mjs — photograph the PARKED machine from the follow camera
   the way a player would ever see it: standing off it and walking back
   towards it, so the rig is behind his shoulder and the prop is in the
   middle of the frame. Three bearings. All movement is WASD, chosen
   against the camera basis because WASD is camera-relative.

   node tools/_vk-park3.mjs <ride> <prefix>
*/
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const RIDE = process.argv[2] || 'bike';
const PRE = process.argv[3] || '/tmp/vk-park3';

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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(3500);

async function goTo(x, z, stop, budget = 40) {
  for (let s = 0; s < budget; s++) {
    const q = await page.evaluate(([tx, tz]) => {
      const c = window.WALLY.ctx, w = c.wally, p = w.root.position;
      const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
      const f = new window.WALLY.THREE.Vector3();
      c.camera.getWorldDirection(f); f.y = 0; f.normalize();
      return { d, fwd: (dx * f.x + dz * f.z) / (d || 1), right: (dx * -f.z + dz * f.x) / (d || 1) };
    }, [x, z]);
    if (q.d < stop) return q.d;
    const ks = [];
    if (q.fwd > 0.35) ks.push('KeyW'); else if (q.fwd < -0.35) ks.push('KeyS');
    if (q.right > 0.35) ks.push('KeyD'); else if (q.right < -0.35) ks.push('KeyA');
    if (!ks.length) ks.push(q.fwd >= 0 ? 'KeyW' : 'KeyS');
    for (const k of ks) await page.keyboard.down(k);
    await page.waitForTimeout(Math.min(260, Math.max(90, (q.d - stop) * 60)));
    for (const k of ks) await page.keyboard.up(k);
  }
  return -1;
}

const setup = await page.evaluate((ride) => {
  const c = window.WALLY.ctx, w = c.wally;
  const cy = c.world && (c.world.city || c.city);
  const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : 0; } catch (e) { return 0; } };
  const v = cy.doorPosition('apartment');
  const sx = v.x + 5, sz = v.z + 1;
  w.setPosition(sx, H(sx, sz), sz);
  c.game.actions.grantRide(ride);
  c.game.actions.equipRide(ride);
  return { door: [v.x, v.y, v.z] };
}, RIDE);
await page.waitForTimeout(2600);
await goTo(setup.door[0], setup.door[2], 2.4);
await page.waitForTimeout(700);
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
await page.waitForTimeout(2600);

const bike = await page.evaluate(() => {
  const b = window.WALLY.ctx.wally.bike;
  return { x: b.group.position.x, y: b.group.position.y, z: b.group.position.z, rotZ: b.group.rotation.z, yaw: b.group.rotation.y, stand: b.stand.visible };
});
console.error('BIKE ' + JSON.stringify(bike));

let i = 0;
for (const bearing of [0, 2.1, 4.2]) {
  const vx = bike.x + Math.cos(bearing) * 6.5, vz = bike.z + Math.sin(bearing) * 6.5;
  const away = await goTo(vx, vz, 1.4);
  await page.waitForTimeout(500);
  const near = await goTo(bike.x, bike.z, 3.0);
  await page.waitForTimeout(1300);
  await page.screenshot({ path: `${PRE}-view${++i}.png` });
  console.error(`view${i} bearing=${bearing} away=${away} near=${near}`);
}
console.error('ERRS ' + JSON.stringify(errs.slice(0, 5)));
await browser.close();
server.close();
