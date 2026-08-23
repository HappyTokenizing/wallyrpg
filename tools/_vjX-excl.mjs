#!/usr/bin/env node
/* VERIFY JUDGE — exclusion audit of surfacetest's new disc guards.
   For each of the six probe spots surfacetest uses, raster at 0.5 m
   and report what the `prop`, `insideAShell` and `lip` skips remove,
   and what those removed points WOULD have measured. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = process.env.WROOT || '/Users/herwig/Documents/GitHub/wallyrpg';
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
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(4000);

await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE, phys = c.phys;
  const frames = (n) => new Promise((res) => { let k = 0; const t = () => (++k >= n ? res() : requestAnimationFrame(t)); requestAnimationFrame(t); });
  const BASE = /outline|hull|contactShadow|cloth|drift|grass|foliage|detail|bush|reed|water|sky|cloud/i;
  const LIP = /\blip\b/i;
  const tg = (withLip) => {
    const out = [];
    for (const r of [c.world?.groundGroup, c.city?.root].filter(Boolean)) r.traverse((o) => {
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
  const ray = new T.Raycaster(); const D = new T.Vector3(0, -1, 0); const O = new T.Vector3();
  const drawn = (x, z, from, t) => { O.set(x, from + 0.45, z); ray.set(O, D); ray.far = 6; const h = ray.intersectObjects(t, false); return h.length ? { y: h[0].point.y, on: h[0].object.name || '?' } : null; };
  const bn = (id) => phys.world.bodies.get(id)?.opts?.name || `#${id}`;
  window.__spots = function () {
    const W = c.world; const out = [];
    for (let a = 0; a < 6.28; a += 0.9) {
      for (let r = 40; r < 520; r += 6) {
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (W.heightAt(x, z) < 0.2) break;
        if (W.shoreDistAt(x, z) < 5) { out.push({ id: 'beach', x, z }); break; }
      }
      if (out.filter((o) => o.id === 'beach').length >= 2) break;
    }
    for (const [id, rec] of c.city.locations) {
      if (!rec.door) continue;
      const ax = Math.sin(rec.loc.yaw), az = Math.cos(rec.loc.yaw);
      if (rec.kit === 'pier') out.push({ id: `pier (${id})`, x: rec.door.x + ax * 2, z: rec.door.z + az * 2 });
      else if (out.filter((o) => o.id.startsWith('thr')).length < 2) out.push({ id: `thr (${id})`, x: rec.door.x + ax * 2.2, z: rec.door.z + az * 2.2 });
    }
    return out;
  };
  window.__place4 = async function (x, z) {
    const p = phys.player;
    p.teleport(new T.Vector3(x, phys.groundAt(x, z).y + 0.1, z)); await frames(30);
    p.teleport(new T.Vector3(x, phys.groundAt(x, z).y + 0.1, z)); await frames(30);
    return { y: +p.simPosition.y.toFixed(2) };
  };
  window.__audit = function (r, step, pad) {
    const A = tg(true), B = tg(false);
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
    const out = [];
    for (let dx = -r; dx <= r + 1e-9; dx += step) for (let dz = -r; dz <= r + 1e-9; dz += step) {
      if (dx * dx + dz * dz > r * r) continue;
      const x = q.x + dx, z = q.z + dz;
      const g = phys.groundAt(x, z);
      if (!g.hit) continue;
      if (Math.abs(g.y - q.y) > 1.5) continue;
      const prop = !!phys.world.bodies.get(g.body)?.opts?.prop;
      const shell = inShell(x, z);
      const a = drawn(x, z, g.y, A), b = drawn(x, z, g.y, B);
      out.push({ x: +x.toFixed(2), z: +z.toFixed(2), prop, shell,
        eL: a ? +(g.y - a.y).toFixed(3) : null, oL: a ? a.on : null,
        e: b ? +(g.y - b.y).toFixed(3) : null, o: b ? b.on : null, body: bn(g.body) });
    }
    return out;
  };
});

const SINK = 0.12, FLOAT = 0.14;
const spots = await page.evaluate(() => window.__spots());
const PAD = +(process.env.WPAD || 0.7);
console.log(`exclusion audit, 0.5 m raster r=6, FOOT_PAD ${PAD}\n`);
for (const s of spots) {
  await page.evaluate(([x, z]) => window.__place4(x, z), [s.x, s.z]);
  const pts = await page.evaluate(([r, st, p]) => window.__audit(r, st, p), [6, 0.5, PAD]);
  const kept = pts.filter((p) => !p.prop && !p.shell && p.e !== null);
  const byProp = pts.filter((p) => p.prop);
  const byShell = pts.filter((p) => !p.prop && p.shell);
  const byLip = pts.filter((p) => !p.prop && !p.shell && p.e === null && p.eL !== null);
  const lipChanged = pts.filter((p) => !p.prop && !p.shell && p.e !== null && p.eL !== null && Math.abs(p.eL - p.e) > 0.001);
  const bad = (a, k) => a.filter((p) => p[k] !== null && (p[k] < -SINK || p[k] > FLOAT));
  const rng = (a, k) => { const v = a.map((p) => p[k]).filter((x) => x !== null); return v.length ? `[${Math.min(...v).toFixed(3)}, ${Math.max(...v).toFixed(3)}]` : '-'; };
  console.log(`${s.id.padEnd(24)} ${String(pts.length).padStart(4)} raw -> ${kept.length} measured`);
  console.log(`   removed by prop:${byProp.length}  shell:${byShell.length}  (lip meshes hit on ${lipChanged.length + byLip.length} kept pts)`);
  console.log(`   kept range ${rng(kept, 'e')}   would-fail among kept: ${bad(kept, 'e').length}`);
  console.log(`   HAD THE PROP SKIP NOT BEEN THERE : range ${rng(byProp, 'e')}   would-fail ${bad(byProp, 'e').length}`);
  console.log(`   HAD THE SHELL SKIP NOT BEEN THERE: range ${rng(byShell, 'e')}   would-fail ${bad(byShell, 'e').length}`
    + (bad(byShell, 'e').length ? `  worst on ${bad(byShell, 'e').sort((a, b) => a.e - b.e)[0].o}` : ''));
  console.log(`   HAD THE LIP NOT BEEN SKIPPED     : range ${rng(kept, 'eL')}   would-fail ${bad(kept, 'eL').length}`
    + (bad(kept, 'eL').length ? `  worst ${Math.min(...bad(kept, 'eL').map((p) => p.eL)).toFixed(3)}` : ''));
}
await browser.close(); server.close();
