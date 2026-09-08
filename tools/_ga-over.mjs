#!/usr/bin/env node
/* _ga-over.mjs — for one prop, every surface a downward ray meets and
   which way each one faces. Answers what the "building mesh: wall" row
   is actually made of.                                                */
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
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?skipIntro&partcensus`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(4000);

/* the sample points: the worst rows the census named */
const PTS = JSON.parse(process.argv[2] || '[[-347.8,-121.9],[-244.5,1.3],[26.5,-160.1],[-398.7,175.1],[-120.6,-81]]');

const out = await page.evaluate(async (pts) => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE;
  const SKIP = /outline|hull|contactShadow|cloth|drift|grass|\blip\b|foliage|detail|bush|reed|\bwater\b|sky|cloud|prop\./i;
  const targets = [];
  for (const r of [c.world.groundGroup, c.city.root].filter(Boolean)) {
    r.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return;
      if (o.userData.isOutlineHull || o.userData.noPrepass) return;
      if (SKIP.test(o.name || '')) return;
      targets.push(o);
    });
  }
  /* find the prop instance nearest each sample point, for its true y */
  const insts = [];
  c.scene.getObjectByName('city.propsRoot').traverse((o) => {
    if (!o.isInstancedMesh) return;
    const n = o.name || ''; if (/\.outline$/.test(n)) return;
    const m = /^prop\.([a-z]+)\./.exec(n); if (!m) return;
    o.updateWorldMatrix(true, false);
    const mat = new T.Matrix4(), p = new T.Vector3(), q = new T.Quaternion(), s = new T.Vector3();
    for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, mat); mat.premultiply(o.matrixWorld); mat.decompose(p, q, s); insts.push({ type: m[1], x: p.x, y: p.y, z: p.z }); }
  });
  const ray = new T.Raycaster(); const DOWN = new T.Vector3(0, -1, 0);
  const n3 = new T.Matrix3(), nv = new T.Vector3();
  const rows = [];
  for (const [x, z] of pts) {
    let best = null, bd = Infinity;
    for (const it of insts) { const d = Math.hypot(it.x - x, it.z - z); if (d < bd) { bd = d; best = it; } }
    ray.set(new T.Vector3(best.x, best.y + 1.2, best.z), DOWN); ray.far = 8;
    const hs = ray.intersectObjects(targets, false).map((h) => {
      n3.getNormalMatrix(h.object.matrixWorld);
      nv.copy(h.face ? h.face.normal : new T.Vector3(0, 1, 0)).applyMatrix3(n3).normalize();
      return { name: h.object.name || '?', y: +h.point.y.toFixed(3), rel: +(h.point.y - best.y).toFixed(3), ny: +nv.y.toFixed(2) };
    });
    rows.push({ at: [x, z], type: best.type, y: +best.y.toFixed(3), hits: hs.slice(0, 8) });
  }
  return rows;
}, PTS);
for (const r of out) {
  console.log(`\n${r.type} at ${r.at.join(',')}  base y=${r.y}`);
  for (const h of r.hits) console.log(`   ${(h.rel >= 0 ? '+' : '') + h.rel.toFixed(3)} m  ny=${String(h.ny).padStart(6)}  ${h.name}`);
}
await browser.close(); server.close();
