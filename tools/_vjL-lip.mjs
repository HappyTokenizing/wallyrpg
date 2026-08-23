#!/usr/bin/env node
/* VERIFY JUDGE — independent raster of the sod lip + threshold probes.
   WROOT=<tree> node vj-lip.mjs                                        */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = process.env.WROOT;
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
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--enable-unsafe-webgpu', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(4000);

await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE, phys = c.phys;
  const frames = (n) => new Promise((res) => { let k = 0; const t = () => (++k >= n ? res() : requestAnimationFrame(t)); requestAnimationFrame(t); });
  // my own target collection; `mode` decides whether lip counts as drawn ground
  const BASE = /outline|hull|contactShadow|cloth|drift|grass|foliage|detail|bush|reed|water|sky|cloud/i;
  const LIP = /\blip\b/i;
  window.__targets = function (withLip) {
    const roots = [c.world?.groundGroup, c.city?.root].filter(Boolean);
    const out = [];
    for (const r of roots) r.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return;
      if (o.userData.isOutlineHull || o.userData.noPrepass) return;
      const nm = o.name || '';
      if (BASE.test(nm)) return;
      if (!withLip && LIP.test(nm)) return;
      for (let p = o; p; p = p.parent) if (p.visible === false) return;
      out.push(o);
    });
    return out;
  };
  const ray = new T.Raycaster(); const DOWN = new T.Vector3(0, -1, 0); const O = new T.Vector3();
  window.__drawn = function (x, z, from, targets) {
    O.set(x, from + 0.45, z); ray.set(O, DOWN); ray.far = 6;
    const h = ray.intersectObjects(targets, false);
    return h.length ? { y: h[0].point.y, on: h[0].object.name || '?' } : null;
  };
  window.__place = async function (x, z, wait = 30) {
    const p = phys.player;
    p.teleport(new T.Vector3(x, phys.groundAt(x, z).y + 0.1, z));
    await frames(wait);
    p.teleport(new T.Vector3(x, phys.groundAt(x, z).y + 0.1, z));
    await frames(wait);
    return { y: +p.simPosition.y.toFixed(3), grounded: p.grounded };
  };
  const bn = (id) => phys.world.bodies.get(id)?.opts?.name || `#${id}`;
  window.__bodyName = bn;
  /* raster: returns every point with both readings */
  window.__raster = function (r, step, pad) {
    const twL = window.__targets(true), twoL = window.__targets(false);
    const q = phys.player.simPosition;
    const foots = [];
    for (const [, rec] of c.city.locations) {
      if (!rec.loc?.size) continue;
      foots.push({ x: rec.loc.world.x, z: rec.loc.world.z, cs: Math.cos(rec.loc.yaw), sn: Math.sin(rec.loc.yaw), hw: rec.loc.size.w / 2 + pad, hd: rec.loc.size.d / 2 + pad });
    }
    const inShell = (x, z) => foots.some((f) => {
      const dx = x - f.x, dz = z - f.z;
      return Math.abs(dx * f.cs - dz * f.sn) <= f.hw && Math.abs(dx * f.sn + dz * f.cs) <= f.hd;
    });
    const n = new T.Vector3();
    const out = [];
    for (let dx = -r; dx <= r + 1e-9; dx += step) {
      for (let dz = -r; dz <= r + 1e-9; dz += step) {
        if (dx * dx + dz * dz > r * r) continue;
        const x = q.x + dx, z = q.z + dz;
        const g = phys.groundAt(x, z);
        if (!g.hit) continue;
        if (Math.abs(g.y - q.y) > 1.5) continue;
        const prop = !!phys.world.bodies.get(g.body)?.opts?.prop;
        const shell = inShell(x, z);
        const a = window.__drawn(x, z, g.y, twL);
        const b = window.__drawn(x, z, g.y, twoL);
        c.world.normalAt(x, z, n);
        out.push({
          x: +x.toFixed(2), z: +z.toFixed(2), prop, shell,
          gy: +g.y.toFixed(3), gny: +g.normal.y.toFixed(3), tny: +n.y.toFixed(3),
          errL: a ? +(g.y - a.y).toFixed(3) : null, onL: a ? a.on : null,
          err: b ? +(g.y - b.y).toFixed(3) : null, on: b ? b.on : null,
          body: bn(g.body),
        });
      }
    }
    return out;
  };
  /* point probe */
  window.__pt = function (x, z, pad) {
    const twL = window.__targets(true), twoL = window.__targets(false);
    const g = phys.groundAt(x, z);
    const a = window.__drawn(x, z, g.y, twL), b = window.__drawn(x, z, g.y, twoL);
    const foots = [];
    for (const [id, rec] of c.city.locations) {
      if (!rec.loc?.size) continue;
      const dx = x - rec.loc.world.x, dz = z - rec.loc.world.z;
      const cs = Math.cos(rec.loc.yaw), sn = Math.sin(rec.loc.yaw);
      const u = Math.abs(dx * cs - dz * sn), v = Math.abs(dx * sn + dz * cs);
      foots.push({ id, u: +u.toFixed(2), v: +v.toFixed(2), hw: rec.loc.size.w / 2, hd: rec.loc.size.d / 2, kit: rec.kit });
    }
    foots.sort((p, q2) => (p.u - p.hw + p.v - p.hd) - (q2.u - q2.hw + q2.v - q2.hd));
    return {
      x, z, gy: +g.y.toFixed(3), gny: +g.normal.y.toFixed(3), body: bn(g.body),
      prop: !!phys.world.bodies.get(g.body)?.opts?.prop,
      drawnLip: a && { y: +a.y.toFixed(3), on: a.on }, drawn: b && { y: +b.y.toFixed(3), on: b.on },
      err: b ? +(g.y - b.y).toFixed(3) : null, errL: a ? +(g.y - a.y).toFixed(3) : null,
      nearest: foots.slice(0, 3),
    };
  };
  /* how proud is every lip tongue over walkable ground?  (its own census) */
  window.__lipcensus = function () {
    const W = c.world;
    const grp = W.groundGroup.getObjectByName('terrain.lip') || null;
    const out = { meshes: 0, tris: 0 };
    if (!grp) return out;
    const box = new T.Box3();
    grp.traverse((o) => { if (o.isMesh) { out.meshes++; o.geometry.computeBoundingBox(); out.tris += o.geometry.attributes.position.count / 3; } });
    return out;
  };
  /* every kit: how far does DRAWN city geometry sprawl past loc.size? */
  window.__sprawl = function () {
    const rows = [];
    const box = new T.Box3(), v = new T.Vector3();
    for (const [id, rec] of c.city.locations) {
      if (!rec.loc?.size || !rec.group) continue;
      const cs = Math.cos(rec.loc.yaw), sn = Math.sin(rec.loc.yaw);
      let mu = 0, mv = 0;
      rec.group.traverse((o) => {
        if (!o.isMesh && !o.isInstancedMesh) return;
        if (o.userData.isOutlineHull) return;
        o.geometry.computeBoundingBox();
        const bb = o.geometry.boundingBox;
        for (let i = 0; i < 8; i++) {
          v.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z);
          o.localToWorld(v);
          const dx = v.x - rec.loc.world.x, dz = v.z - rec.loc.world.z;
          mu = Math.max(mu, Math.abs(dx * cs - dz * sn));
          mv = Math.max(mv, Math.abs(dx * sn + dz * cs));
        }
      });
      rows.push({ id, kit: rec.kit, w: rec.loc.size.w, d: rec.loc.size.d, overU: +(mu - rec.loc.size.w / 2).toFixed(2), overV: +(mv - rec.loc.size.d / 2).toFixed(2) });
    }
    return rows;
  };
});

const beaches = await page.evaluate(() => {
  const W = window.WALLY.ctx.world; const out = [];
  for (let a = 0; a < 6.28; a += 0.9) {
    for (let r = 40; r < 520; r += 6) {
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (W.heightAt(x, z) < 0.2) break;
      if (W.shoreDistAt(x, z) < 5) { out.push({ id: 'beach', x, z }); break; }
    }
    if (out.length >= 2) break;
  }
  return out;
});
console.log('BEACH SPOTS', JSON.stringify(beaches.map((b) => [+b.x.toFixed(2), +b.z.toFixed(2)])));

const SINK = 0.12;
for (const b of beaches) {
  const at = await page.evaluate(([x, z]) => window.__place(x, z), [b.x, b.z]);
  const pts = await page.evaluate(([r, s, p]) => window.__raster(r, s, p), [6, 0.25, 0.7]);
  const usable = pts.filter((p) => !p.prop && !p.shell);
  const withLip = usable.filter((p) => p.errL !== null);
  const noLip = usable.filter((p) => p.err !== null);
  const sinkL = withLip.filter((p) => p.errL < -SINK);
  const sinkN = noLip.filter((p) => p.err < -SINK);
  const walkL = sinkL.filter((p) => p.gny >= Math.cos(48 * Math.PI / 180));
  console.log(`\n=== beach at ${b.x.toFixed(2)},${b.z.toFixed(2)}  player y ${at.y} grounded=${at.grounded}`);
  console.log(`   raster 0.25 m r=6 : ${pts.length} raw, ${usable.length} usable, ${withLip.length} with drawn hit (lip counted), ${noLip.length} (lip skipped)`);
  console.log(`   LIP COUNTED   : ${sinkL.length} pts sink > ${SINK}   worst ${sinkL.length ? Math.min(...sinkL.map((p) => p.errL)).toFixed(3) : '-'}   (walkable n.y: ${walkL.length})`);
  console.log(`   LIP SKIPPED   : ${sinkN.length} pts sink > ${SINK}   worst ${sinkN.length ? Math.min(...sinkN.map((p) => p.err)).toFixed(3) : '-'}`);
  const byMesh = {};
  for (const p of sinkL) byMesh[p.onL] = (byMesh[p.onL] || 0) + 1;
  console.log('   sink meshes (lip counted):', JSON.stringify(byMesh));
  for (const p of sinkL.slice(0, 6)) console.log(`      ${p.x},${p.z} errL ${p.errL} on ${p.onL}  gny ${p.gny} body ${p.body}`);
  const lipHits = withLip.filter((p) => /lip/i.test(p.onL || ''));
  console.log(`   points whose drawn hit IS a lip mesh: ${lipHits.length}`);
  const lo = withLip.length ? Math.min(...withLip.map((p) => p.errL)) : 0;
  const hi = withLip.length ? Math.max(...withLip.map((p) => p.errL)) : 0;
  const lo2 = noLip.length ? Math.min(...noLip.map((p) => p.err)) : 0;
  const hi2 = noLip.length ? Math.max(...noLip.map((p) => p.err)) : 0;
  console.log(`   range lip-counted [${lo.toFixed(3)}, ${hi.toFixed(3)}]   lip-skipped [${lo2.toFixed(3)}, ${hi2.toFixed(3)}]`);
}

/* thresholds */
console.log('\n=== THRESHOLD POINTS ===');
for (const [name, x, z] of [['apartment', -364.28, 201.53], ['trunkdepot', -279.06, 146.26], ['apartment.b', -365.78, 198.53], ['apartment.c', -367.28, 196.53], ['apartment.chamfer', -364.28, 201.78]]) {
  await page.evaluate(([px, pz]) => window.__place(px, pz), [x, z]);
  const r = await page.evaluate(([px, pz, pad]) => window.__pt(px, pz, pad), [x, z, 0.7]);
  console.log(`${name.padEnd(18)} err ${String(r.err).padStart(7)} (lip-counted ${r.errL})  gy ${r.gy} body ${r.body} prop=${r.prop}`);
  console.log(`   drawn: ${r.drawn ? r.drawn.on + ' @ ' + r.drawn.y : 'none'}`);
  console.log(`   nearest shells: ${r.nearest.map((f) => `${f.id}[${f.kit}] u=${f.u}/${f.hw} v=${f.v}/${f.hd} margin=${(Math.max(f.u - f.hw, f.v - f.hd)).toFixed(2)}`).join(' | ')}`);
}

/* sprawl */
const sprawl = await page.evaluate(() => window.__sprawl());
sprawl.sort((a, b) => Math.max(b.overU, b.overV) - Math.max(a.overU, a.overV));
console.log('\n=== DRAWN SPRAWL PAST loc.size (per location, metres) ===');
console.log(`   n=${sprawl.length}  max ${Math.max(...sprawl.map((s) => Math.max(s.overU, s.overV))).toFixed(2)}  min ${Math.min(...sprawl.map((s) => Math.max(s.overU, s.overV))).toFixed(2)}`);
for (const s of sprawl.slice(0, 6)) console.log(`   ${s.id.padEnd(18)} ${String(s.kit).padEnd(10)} over ${s.overU} / ${s.overV}`);
console.log('   ...');
for (const s of sprawl.slice(-4)) console.log(`   ${s.id.padEnd(18)} ${String(s.kit).padEnd(10)} over ${s.overU} / ${s.overV}`);

await browser.close(); server.close();
