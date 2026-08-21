/* strafetest.mjs — prove A and D move the player the correct way.

   Reads the camera's own right-vector, then presses A and D and checks
   which side of that vector the player actually travelled. Pure geometry,
   no eyeballing: dot(displacement, cameraRight) must be negative for A
   and positive for D.  */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try {
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' });
    rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
page.on('pageerror', e => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 60000 });
await page.waitForTimeout(3500);

const state = () => page.evaluate(() => {
  const c = WALLY.ctx, w = c.wally;
  const f = new c.THREE.Vector3();
  c.camera.getWorldDirection(f); f.y = 0; f.normalize();
  // right = forward x up, for Y-up right-handed
  return {
    pos: [w.root.position.x, w.root.position.z],
    right: [-f.z, f.x],
  };
});

async function press(key, ms = 600) {
  /* Sample VELOCITY against the camera basis at the SAME INSTANT, after a
     short press. Integrating displacement over seconds is confounded: the
     follow camera rotates while you strafe, so the path curves and the net
     displacement can end up perpendicular to the basis you started with. */
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  const r = await page.evaluate(() => {
    const c = WALLY.ctx, w = c.wally, ct = w.controller;
    const v = ct && (ct.velocity || ct.vel);
    const f = new c.THREE.Vector3();
    c.camera.getWorldDirection(f); f.y = 0; f.normalize();
    const right = [-f.z, f.x];
    if (!v) return null;
    const sp = Math.hypot(v.x, v.z);
    return { speed: +sp.toFixed(2), alongRight: +((v.x * right[0] + v.z * right[1])).toFixed(2) };
  });
  await page.keyboard.up(key);
  await page.waitForTimeout(900);
  return { key, moved: r ? r.speed : 0, alongRight: r ? r.alongRight : 0 };
}

const A = await press('KeyA');
const D = await press('KeyD');

const verdict = (r, wantSign) => {
  if (r.moved < 0.4) return 'DID NOT MOVE';
  return Math.sign(r.alongRight) === wantSign ? 'CORRECT' : 'REVERSED';
};

console.log(`A: moved ${A.moved} m, along cameraRight ${A.alongRight}  -> ${verdict(A, -1)}  (expect LEFT / negative)`);
console.log(`D: moved ${D.moved} m, along cameraRight ${D.alongRight}  -> ${verdict(D, +1)}  (expect RIGHT / positive)`);

const ok = verdict(A, -1) === 'CORRECT' && verdict(D, +1) === 'CORRECT';
console.log(ok ? '\nPASS — strafe directions correct' : '\nFAIL — strafe still wrong');

await browser.close();
server.close();
process.exit(ok ? 0 : 1);
