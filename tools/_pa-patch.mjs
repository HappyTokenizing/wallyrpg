/* Static raster of the junction patch. No walk, no capsule -> identical
   measurement in any build. Run from inside the tree under test. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i+1] ? process.argv[i+1] : d; };
const CX = +arg('x', -24), CZ = +arg('z', -200), R = +arg('r', 10), STEP = +arg('step', 0.5);
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b); }
  catch { rs.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader','--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', e => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(4000);

const res = await page.evaluate(async ([CX, CZ, R, STEP]) => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE, phys = c.phys;
  const frames = (n) => new Promise(r => { let i = 0; const f = () => (++i >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  /* stream the collision window onto the patch */
  const g0 = c.phys.groundAt(CX, CZ);
  phys.player.teleport(new T.Vector3(CX, g0.y + 0.4, CZ));
  await frames(6);
  phys.player.teleport(new T.Vector3(CX, c.phys.groundAt(CX, CZ).y + 0.4, CZ));
  await frames(6);
  const SKIP = /outline|hull|contactShadow|cloth|drift|grass|\blip\b|foliage|detail|bush|reed|\bwater\b|sky|cloud/i;
  const targets = [];
  for (const r of [c.world?.groundGroup, c.city?.root].filter(Boolean)) r.traverse(o => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    if (o.userData.isOutlineHull || o.userData.noPrepass) return;
    if (SKIP.test(o.name || '')) return;
    for (let p = o; p; p = p.parent) if (p.visible === false) return;
    targets.push(o);
  });
  const ray = new T.Raycaster(); const DOWN = new T.Vector3(0,-1,0); const O = new T.Vector3();
  let n = 0, past = 0, worst = 0, wx = 0, wz = 0, wm = '', wcol = '';
  let nw = 0, pastW = 0, rawWorst = 0, rwm = '', rwx = 0, rwz = 0;
  const byMesh = {}, byMeshRaw = {};
  for (let x = CX - R; x <= CX + R + 1e-6; x += STEP) for (let z = CZ - R; z <= CZ + R + 1e-6; z += STEP) {
    const g = c.phys.groundAt(x, z);
    if (!g || !isFinite(g.y)) continue;
    O.set(x, g.y + 0.45, z); ray.set(O, DOWN); ray.far = 6;
    const hits = ray.intersectObjects(targets, false);
    if (!hits.length) continue;
    const ny = Math.max(g.normal ? g.normal.y : 1, 0.5);
    const lift = 0.34 * (1 / ny - 1);
    const err = g.y - hits[0].point.y - lift;
    n++;
    const nm = hits[0].object.name || '?';
    if (err < -0.12) { past++; byMesh[nm] = (byMesh[nm] || 0) + 1; }
    if (err < worst) { worst = err; wx = x; wz = z; wm = nm; wcol = (g.bodyName || g.name || ''); }
    /* RAW GEOMETRY, NO CAPSULE TERM: how far the drawn surface stands
       over the collision surface. Gated on a normal he can stand on,
       because the lift identity is meaningless where no capsule rests. */
    if (ny > 0.68) {
      nw++;
      const raw = g.y - hits[0].point.y;
      if (raw < -0.12) { pastW++; byMeshRaw[nm] = (byMeshRaw[nm] || 0) + 1; }
      if (raw < rawWorst) { rawWorst = raw; rwm = nm; rwx = x; rwz = z; }
    }
  }
  return { n, past, worst, wx, wz, wm, byMesh, nw, pastW, rawWorst, rwm, rwx, rwz, stats: c.world.paths?.stats };
}, [CX, CZ, R, STEP]);
console.log(`patch ${CX},${CZ} r=${R} step=${STEP}:  ${res.past} of ${res.n} past -0.12   worst ${res.worst.toFixed(4)} at ${res.wx.toFixed(2)},${res.wz.toFixed(2)} on ${res.wm}`);
console.log('  past-tol by drawn mesh:', JSON.stringify(res.byMesh));
console.log(`RAW drawn-over-collision, walkable normals only (n.y>0.68): ${res.pastW} of ${res.nw} past 0.12 m   worst ${res.rawWorst.toFixed(4)} at ${res.rwx.toFixed(2)},${res.rwz.toFixed(2)} on ${res.rwm}`);
console.log('  raw past-tol by drawn mesh:', JSON.stringify(res.byMeshRaw));
console.log('  paths.stats:', JSON.stringify(res.stats));
await browser.close(); server.close();
