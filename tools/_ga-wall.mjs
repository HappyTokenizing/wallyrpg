#!/usr/bin/env node
/* _ga-wall.mjs — WHAT IS THE CLIPTEST WALL PLANE ACTUALLY ON?

   cliptest section 1b picks the surface by raycasting at four heights
   and taking the first hit whose normal.y < 0.8. This prints, for the
   propertyoffice's four faces:
     · every one of the four height rays: hit distance, normal, and the
       NAME of the body it landed on
     · the building's own rendered wall plane, from the city record
     · where the walk ends, measured against BOTH planes
   so "the wall has a hole" and "the ray found something newer" can be
   told apart by reading, not by arguing.                            */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* --root <dir> serves a DIFFERENT src tree with THIS probe. That is the
   revert direction contracts.js rule 1 asks for: today's instrument,
   yesterday's code. */
const rootArg = process.argv.indexOf('--root');
const ROOT = rootArg > 0 ? resolve(process.argv[rootArg + 1])
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(4000);

const out = await page.evaluate(async () => {
  const c = window.WALLY.ctx;
  const T = window.WALLY.THREE;
  const phys = c.phys, world = phys.world, p = phys.player;
  const frames = (n) => new Promise((res) => { let k = 0; const t = () => (++k >= n ? res() : requestAnimationFrame(t)); requestAnimationFrame(t); });
  const nameOf = (bid) => (world.bodies.get(bid)?.opts?.name) || `#${bid}`;

  const rec = c.city.locations.get('propertyoffice');
  const cen = { x: rec.center.x, y: rec.groundY + 1.0, z: rec.center.z };
  const yaw = rec.loc.yaw, sz = rec.loc.size;
  const door = rec.door ? { x: rec.door.x, y: rec.door.y, z: rec.door.z } : null;

  const park = async (x, z) => {
    p.teleport(new T.Vector3(x, phys.groundAt(x, z).y + 0.2, z));
    await frames(36);
    p.teleport(new T.Vector3(x, phys.groundAt(x, z).y + 0.2, z));
    await frames(36);
  };
  await park(cen.x, cen.z + sz.d * 0.5 + 8);

  const faces = [];
  for (const k of [0, 1, 2, 3]) {
    const a = yaw + k * Math.PI / 2;
    const dir = new T.Vector3(Math.sin(a), 0, Math.cos(a));
    const dist = 6.5;
    const sx = cen.x + dir.x * dist, sz2 = cen.z + dir.z * dist;
    const g0 = phys.groundAt(sx, sz2);
    p.teleport(new T.Vector3(sx, g0.y + 0.05, sz2));
    await frames(30);
    const start = p.simPosition.clone();
    const toward = new T.Vector3(-dir.x, 0, -dir.z);

    /* every height, not just the first that qualifies */
    const rays = [];
    for (const hy of [0.95, 0.55, 1.4, 0.3]) {
      const o = new T.Vector3(start.x, start.y + hy, start.z);
      const hit = phys.raycast(o, toward, dist + 3);
      rays.push(hit ? {
        hy, d: +hit.distance.toFixed(3), body: nameOf(hit.body),
        ny: +hit.normal.y.toFixed(3),
        pt: [+hit.point.x.toFixed(3), +hit.point.y.toFixed(3), +hit.point.z.toFixed(3)],
        vertical: hit.normal.y < 0.8,
      } : { hy, miss: true });
    }
    /* the first that cliptest would take */
    const picked = rays.find((r) => !r.miss && r.vertical) || null;

    /* the building's own nominal wall plane on this face: the local
       half-extent along the approach axis, taken back to world */
    const halfLocal = (k % 2 === 0) ? sz.d / 2 : sz.w / 2;

    /* and the DRAWN wall: sample the city's render meshes with a
       three.js ray, which is a different instrument from phys */
    let drawn = null;
    {
      const rc = new T.Raycaster(new T.Vector3(start.x, start.y + 0.95, start.z), toward.clone().normalize(), 0, dist + 3);
      const meshes = [];
      c.scene.traverse((o) => { if (o.isMesh && !o.userData.isOutlineHull && o.visible) meshes.push(o); });
      const hits = rc.intersectObjects(meshes, false);
      const h = hits.find((h2) => h2.face && Math.abs(h2.face.normal.y) < 0.8);
      if (h) drawn = { d: +h.distance.toFixed(3), obj: h.object.name || h.object.parent?.name || '?' };
      if (hits.length) drawn = { ...(drawn || {}), first: +hits[0].distance.toFixed(3), firstObj: hits[0].object.name || hits[0].object.parent?.name || '?' };
    }

    /* now walk in, and measure against BOTH the picked plane and the
       nominal wall plane */
    let minPicked = Infinity, minWall = Infinity, minDraw = Infinity;
    if (picked) {
      const hp = new T.Vector3(...picked.pt);
      const hn = new T.Vector3();
      { const o = new T.Vector3(start.x, start.y + picked.hy, start.z); const hit = phys.raycast(o, toward, dist + 3); hn.copy(hit.normal); }
      const wallPt = new T.Vector3(cen.x + dir.x * halfLocal, cen.y, cen.z + dir.z * halfLocal);
      const drawPt = drawn && drawn.d ? new T.Vector3(start.x, start.y + 0.95, start.z).addScaledVector(toward, drawn.d) : null;
      p.setInputFn(() => ({ x: -dir.x, z: -dir.z, run: true }));
      for (let i = 0; i < 180; i++) {
        await frames(1);
        const q = p.simPosition;
        const lat = Math.abs((q.x - start.x) * dir.z - (q.z - start.z) * dir.x);
        if (lat >= 1.0) continue;
        for (const h of [p.radius, 0.8, p.height - p.radius]) {
          const dP = (q.x - hp.x) * hn.x + (q.y + h - hp.y) * hn.y + (q.z - hp.z) * hn.z;
          if (dP < minPicked) minPicked = dP;
          const dW = (q.x - wallPt.x) * dir.x + (q.z - wallPt.z) * dir.z;
          if (dW < minWall) minWall = dW;
          if (drawPt) { const dD = (q.x - drawPt.x) * dir.x + (q.z - drawPt.z) * dir.z; if (dD < minDraw) minDraw = dD; }
        }
      }
      p.setInputFn(null); p.setInput({ x: 0, z: 0 });
    }
    faces.push({
      k, rays, picked: picked ? { hy: picked.hy, d: picked.d, body: picked.body, ny: picked.ny } : null,
      drawn, halfLocal: +halfLocal.toFixed(3),
      minPicked: Number.isFinite(minPicked) ? +minPicked.toFixed(3) : null,
      minWall: Number.isFinite(minWall) ? +minWall.toFixed(3) : null,
      minDraw: Number.isFinite(minDraw) ? +minDraw.toFixed(3) : null,
      end: p.simPosition.toArray().map((v) => +v.toFixed(2)),
    });
  }

  /* which faces is the door on? */
  let doorFace = null;
  if (door) {
    let bd = Infinity;
    for (const k of [0, 1, 2, 3]) {
      const a = yaw + k * Math.PI / 2;
      const dir = new T.Vector3(Math.sin(a), 0, Math.cos(a));
      const halfLocal = (k % 2 === 0) ? sz.d / 2 : sz.w / 2;
      const wx = cen.x + dir.x * halfLocal, wz = cen.z + dir.z * halfLocal;
      const d = Math.hypot(door.x - wx, door.z - wz);
      if (d < bd) { bd = d; doorFace = k; }
    }
  }

  /* body inventory near the building */
  const near = [];
  for (const [id, r] of world.bodies) {
    if (!r.count) continue;
    const cc = r.aabb.getCenter(new T.Vector3());
    const d = Math.hypot(cc.x - cen.x, cc.z - cen.z);
    if (d < 40) near.push({ name: r.opts?.name || `#${id}`, tris: r.count, d: +d.toFixed(1) });
  }
  near.sort((a, b) => a.d - b.d);

  return { loc: 'propertyoffice', cen, yaw: +yaw.toFixed(3), sz, door, doorFace, faces, near: near.slice(0, 14) };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
server.close();
