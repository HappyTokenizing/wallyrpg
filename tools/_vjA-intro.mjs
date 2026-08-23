/* _vjA-intro.mjs — is the INTRO drivetrain forward too?
   Samples the intro's own bicycle prop and Wally's ankle during the
   ride beat, in his root frame, against measured travel. */
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
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(3000);

await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE;
  const rows = [];
  window.__IN = { rows, on: false, start() { rows.length = 0; this.on = true; }, stop() { this.on = false; return rows; } };
  const inv = new T.Matrix4(), V = new T.Vector3();
  const loc = (o, x, y, z) => { V.set(x, y, z); o.localToWorld(V); V.applyMatrix4(inv); return [+V.x.toFixed(5), +V.y.toFixed(5), +V.z.toFixed(5)]; };
  c._handles.push({
    lateUpdate() {
      if (!window.__IN.on) return;
      const w = c.wally; if (!w) return;
      const bike = c.scene.getObjectByName('intro.bicycle');
      const root = w.root; root.updateMatrixWorld(true);
      inv.copy(root.matrixWorld).invert();
      const r = {
        t: c.elapsed,
        pos: [root.position.x, root.position.y, root.position.z],
        fwd: (() => { const f = new T.Vector3(0, 0, 1).applyQuaternion(root.quaternion); return [f.x, f.z]; })(),
        ankleL: loc(w.bones.footL, 0, 0, 0),
        vis: bike ? bike.visible : null,
      };
      if (bike && bike.visible) {
        let crank = null, wheel = null;
        bike.traverse((o) => {
          if (crank === null && o.isGroup && o.children.some((k) => k.isGroup)) { /* skip */ }
        });
        /* the crank group is the one whose children are two arm groups */
        for (const ch of bike.children) {
          if (!crank && ch.isGroup && ch.children.some((k) => k.isGroup)) crank = ch;
          if (!wheel && ch.isGroup && ch.children.length > 3 && ch.children.every((k) => k.isMesh)) wheel = ch;
        }
        if (!r.tree) r.tree = bike.children.map((k) => `${k.type}:${k.children.length}:${k.position.z.toFixed(2)}`).join('|');
        if (crank) { const arm = crank.children.find((k) => k.isGroup); r.crankTip = loc(arm, 0, -0.165, 0); r.crankRot = crank.rotation.x; }
        if (wheel) { r.rim = loc(wheel, 0, 0.28, 0); r.wheelRot = wheel.rotation.x; r.wheelPos = [wheel.position.x, wheel.position.y, wheel.position.z]; }
      }
      rows.push(r);
    },
  });
});

await page.evaluate(() => window.WALLY.debug.introShot(4));
await page.evaluate(() => window.__IN.start());
await page.waitForTimeout(5000);
const rows = await page.evaluate(() => window.__IN.stop());
console.log(JSON.stringify({ n: rows.length, rows }));
await browser.close();
server.close();
