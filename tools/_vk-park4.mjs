/* _vk-park4.mjs — park at a door, then look at the parked machine with
   the player's own camera controls: a drag on the canvas orbits the
   FOLLOW rig (camera.js line ~701) and the wheel zooms it. No debug
   camera, no override — the rig stays in 'follow' the whole time.

   node tools/_vk-park4.mjs <ride> <prefix>
*/
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const RIDE = process.argv[2] || 'bike';
const PRE = process.argv[3] || '/tmp/vk-park4';

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
    await page.waitForTimeout(Math.min(240, Math.max(80, (q.d - stop) * 60)));
    for (const k of ks) await page.keyboard.up(k);
  }
  return -1;
}

const door = await page.evaluate((ride) => {
  const c = window.WALLY.ctx, w = c.wally;
  const cy = c.world.city || c.city;
  const v = cy.doorPosition('apartment');
  const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : 0; } catch (e) { return 0; } };
  w.setPosition(v.x + 5, H(v.x + 5, v.z + 1), v.z + 1);
  c.game.actions.grantRide(ride);
  c.game.actions.equipRide(ride);
  return [v.x, v.y, v.z];
}, RIDE);
await page.waitForTimeout(2600);
await goTo(door[0], door[2], 2.4);
await page.waitForTimeout(700);
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
await page.waitForTimeout(2800);

/* zoom the follow rig out with the wheel, the player's own control */
await page.mouse.move(640, 380);
for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(90); }
await page.waitForTimeout(900);

async function shot(name) {
  const st = await page.evaluate(() => {
    const c = window.WALLY.ctx, T = window.WALLY.THREE, w = c.wally, b = w.bike;
    const p = new T.Vector3(b.group.position.x, b.group.position.y + 0.4, b.group.position.z).project(c.camera);
    return { mode: c.cam.mode, camDist: +c.camera.position.distanceTo(w.root.position).toFixed(2),
      bikeVisible: b.group.visible, standVisible: b.stand.visible, rotZ: +b.group.rotation.z.toFixed(3),
      screen: [Math.round((p.x * 0.5 + 0.5) * 1280), Math.round((-p.y * 0.5 + 0.5) * 720)], inFront: p.z < 1 };
  });
  await page.screenshot({ path: `${PRE}-${name}.png` });
  console.error(name + ' ' + JSON.stringify(st));
}
await shot('orbit0');
/* drag to orbit: a one-finger drag anywhere on the canvas */
for (const [name, dx] of [['orbit1', -260], ['orbit2', -260], ['orbit3', -260]]) {
  await page.mouse.move(640, 380);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(640 + (dx * i) / 8, 380); await page.waitForTimeout(45); }
  await page.mouse.up();
  await page.waitForTimeout(1400);
  await shot(name);
}
console.error('ERRS ' + JSON.stringify(errs.slice(0, 5)));
await browser.close();
server.close();
