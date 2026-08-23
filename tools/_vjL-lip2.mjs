#!/usr/bin/env node
/* VERIFY JUDGE — sod-lip census over its own vertices + free rasters + shots.
   WROOT=<tree> node tools/_vjL-lip2.mjs [--shot]                        */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = process.env.WROOT;
const TAG = process.env.WTAG || 'x';
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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(4000);

const census = await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE, W = c.world;
  const grp = W.groundGroup.getObjectByName('terrain.lip');
  if (!grp) return { err: 'no terrain.lip group' };
  const COS = Math.cos(48 * Math.PI / 180);
  const v = new T.Vector3(), n = new T.Vector3();
  let meshes = 0, verts = 0;
  const perInstance = [];
  const VPI = 135;                 // makeSodGeo -> 45 tris, non-indexed
  for (const m of grp.children) {
    if (!m.isMesh) continue;
    meshes++;
    const pos = m.geometry.attributes.position;
    verts += pos.count;
    m.updateMatrixWorld(true);
    for (let base = 0; base + VPI <= pos.count; base += VPI) {
      let proudMax = -Infinity, proudNy = 0, px = 0, pz = 0, walkAny = false, walkProud = -Infinity, wx = 0, wz = 0;
      for (let i = base; i < base + VPI; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        const h = W.heightAt(v.x, v.z);
        W.normalAt(v.x, v.z, n);
        const pr = v.y - h;
        if (pr > proudMax) { proudMax = pr; proudNy = n.y; px = v.x; pz = v.z; }
        if (n.y >= COS) { walkAny = true; if (pr > walkProud) { walkProud = pr; wx = v.x; wz = v.z; } }
      }
      perInstance.push({ proud: +proudMax.toFixed(3), ny: +proudNy.toFixed(3), x: +px.toFixed(1), z: +pz.toFixed(1), walkAny, walkProud: +walkProud.toFixed(3), wx: +wx.toFixed(1), wz: +wz.toFixed(1) });
    }
  }
  return { meshes, verts, tongues: perInstance.length, remainder: verts % VPI, perInstance, statsLip: W.terrain?.stats?.lip ?? c.world.stats?.lip ?? null };
});

if (census.err) { console.log('CENSUS ERROR', census.err); }
else {
  const pi = census.perInstance;
  const proudWalk = pi.filter((p) => p.walkAny && p.walkProud > 0.12);
  const proudWalk0 = pi.filter((p) => p.walkAny && p.walkProud > 0);
  console.log(`LIP CENSUS  meshes=${census.meshes} verts=${census.verts} tongues=${census.tongues} (remainder ${census.remainder})`);
  console.log(`   tongues with ANY walkable ground under them: ${pi.filter((p) => p.walkAny).length}`);
  console.log(`   ... standing proud of it at all (>0 m):       ${proudWalk0.length}`);
  console.log(`   ... standing proud of it past SINK_TOL 0.12:  ${proudWalk.length}`);
  const srt = [...proudWalk].sort((a, b) => b.walkProud - a.walkProud);
  console.log('   worst 6 by proud-over-walkable:');
  for (const p of srt.slice(0, 6)) console.log(`      ${p.wx},${p.wz}  proud ${p.walkProud} m`);
  const anyProud = pi.filter((p) => p.proud > 0.12);
  console.log(`   tongues standing >0.12 m proud of the heightfield anywhere: ${anyProud.length} / ${pi.length}`);
}

/* free rasters at named centres, lip counted vs skipped */
const spots = (process.env.WSPOTS || '390,214;313,-276;484,0;263.56,332.13').split(';').map((s) => s.split(',').map(Number));
await page.evaluate((ns) => { window.__NOSTOREY = ns; }, !!process.env.WNOSTOREY);
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
  window.__place2 = async function (x, z) {
    const p = phys.player;
    p.teleport(new T.Vector3(x, phys.groundAt(x, z).y + 0.1, z)); await frames(30);
    p.teleport(new T.Vector3(x, phys.groundAt(x, z).y + 0.1, z)); await frames(30);
    return { y: +p.simPosition.y.toFixed(3), grounded: p.grounded };
  };
  window.__ras2 = function (cx, cz, r, step) {
    const A = tg(true), B = tg(false);
    const q = phys.player.simPosition;
    const n = new T.Vector3(); const out = [];
    for (let dx = -r; dx <= r + 1e-9; dx += step) for (let dz = -r; dz <= r + 1e-9; dz += step) {
      if (dx * dx + dz * dz > r * r) continue;
      const x = cx + dx, z = cz + dz;
      const g = phys.groundAt(x, z);
      if (!g.hit) continue;
      if (!window.__NOSTOREY && Math.abs(g.y - q.y) > 1.5) continue;
      if (phys.world.bodies.get(g.body)?.opts?.prop) continue;
      const a = drawn(x, z, g.y, A), b = drawn(x, z, g.y, B);
      c.world.normalAt(x, z, n);
      out.push({ x: +x.toFixed(2), z: +z.toFixed(2), gny: +g.normal.y.toFixed(3), tny: +n.y.toFixed(3),
        eL: a ? +(g.y - a.y).toFixed(3) : null, oL: a ? a.on : null,
        e: b ? +(g.y - b.y).toFixed(3) : null, o: b ? b.on : null });
    }
    return out;
  };
});

const COS = Math.cos(48 * Math.PI / 180);
for (const [x, z] of spots) {
  const at = await page.evaluate(([a, b]) => window.__place2(a, b), [x, z]);
  const pts = await page.evaluate(([a, b, r]) => window.__ras2(a, b, r, 0.25), [x, z, +(process.env.WRAD||6)]);
  const wl = pts.filter((p) => p.eL !== null);
  const sL = wl.filter((p) => p.eL < -0.12);
  const sLw = sL.filter((p) => p.gny >= COS);
  const sN = pts.filter((p) => p.e !== null && p.e < -0.12);
  const lipHit = wl.filter((p) => /lip/i.test(p.oL));
  const byMesh = {}; for (const p of sL) byMesh[p.oL] = (byMesh[p.oL] || 0) + 1;
  console.log(`\nRASTER 0.25 @ ${x},${z}  (player y ${at.y} grounded=${at.grounded})  ${pts.length} pts`);
  console.log(`   lip COUNTED : ${sL.length} sink pts (${sLw.length} walkable) worst ${sL.length ? Math.min(...sL.map((p) => p.eL)).toFixed(3) : '-'}  meshes ${JSON.stringify(byMesh)}`);
  console.log(`   lip SKIPPED : ${sN.length} sink pts worst ${sN.length ? Math.min(...sN.map((p) => p.e)).toFixed(3) : '-'}`);
  console.log(`   drawn hit is a lip mesh at ${lipHit.length} pts` + (lipHit.length ? `  worst err ${Math.min(...lipHit.map((p) => p.eL)).toFixed(3)}` : ''));
}

if (process.argv.includes('--shot')) {
  await mkdir('/private/tmp/claude-501/-Users-herwig-Desktop-Claude-files/648e6001-7010-404a-9eea-f16c59f21a5d/scratchpad/shots', { recursive: true });
  for (const [nm, x, z] of [['brink', 313, -276], ['eastcliff', 390, 214]]) {
    await page.evaluate(([a, b]) => window.__place2(a, b), [x, z]);
    await page.waitForTimeout(1500);
    for (const on of [true, false]) {
      await page.evaluate((v) => { const g = window.WALLY.ctx.world.groundGroup.getObjectByName('terrain.lip'); if (g) g.visible = v; }, on);
      await page.waitForTimeout(600);
      const buf = await page.screenshot();
      await writeFile(`/private/tmp/claude-501/-Users-herwig-Desktop-Claude-files/648e6001-7010-404a-9eea-f16c59f21a5d/scratchpad/shots/${TAG}-${nm}-lip${on ? 'ON' : 'OFF'}.png`, buf);
    }
    await page.evaluate(() => { const g = window.WALLY.ctx.world.groundGroup.getObjectByName('terrain.lip'); if (g) g.visible = true; });
    console.log(`shot ${nm}`);
  }
}
await browser.close(); server.close();
