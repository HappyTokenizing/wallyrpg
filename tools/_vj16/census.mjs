#!/usr/bin/env node
/* VERIFY JUDGE #16 — independent sod-lip census.
   Does NOT call window.__lip(). Walks the merged lip meshes myself,
   applies matrixWorld (and reports whether that mattered), splits into
   135-vertex tongues, and measures proud THREE ways:
     A. vs world.heightAt      (what __lip does)
     B. vs the DRAWN ground mesh under the vertex, lip excluded
        (surfacetest's own stated standard: "the collision world is not
         the world")
     C. vs the collision heightfield via phys.groundAt
   WROOT=<tree> node census.mjs                                        */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = process.env.WROOT || '/Users/herwig/Documents/GitHub/wallyrpg';
const OUT = process.env.WOUT || '/private/tmp/claude-501/-Users-herwig-Desktop-Claude-files/648e6001-7010-404a-9eea-f16c59f21a5d/scratchpad/vj16';
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
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 240000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 240000 });
await page.waitForTimeout(4000);
await mkdir(OUT, { recursive: true });

const res = await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE;
  const W = c.world, grp = W.groundGroup.getObjectByName('terrain.lip');
  if (!grp) return { none: true };
  const COS = Math.cos(48 * Math.PI / 180);
  const BLADE = 0.24, TOL = 0.12;

  /* ---- does matrixWorld matter at all? ---- */
  grp.updateMatrixWorld(true);
  const mwNonIdentity = [];
  grp.traverse((o) => {
    if (!o.isMesh) return;
    const e = o.matrixWorld.elements;
    const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    let d = 0; for (let i = 0; i < 16; i++) d = Math.max(d, Math.abs(e[i] - I[i]));
    if (d > 1e-6) mwNonIdentity.push({ name: o.name, d: +d.toFixed(4) });
  });

  /* ---- drawn-ground raycast targets, lip EXCLUDED ---- */
  const BASE = /outline|hull|contactShadow|cloth|drift|grass|foliage|detail|bush|reed|water|sky|cloud/i;
  const LIP = /\blip\b/i;
  const targets = [];
  for (const r of [W.groundGroup, c.city?.root].filter(Boolean)) r.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    if (o.userData.isOutlineHull || o.userData.noPrepass) return;
    const nm = o.name || '';
    if (BASE.test(nm) || LIP.test(nm)) return;
    for (let p = o; p; p = p.parent) if (p.visible === false) return;
    targets.push(o);
  });
  const ray = new T.Raycaster(); const DOWN = new T.Vector3(0, -1, 0); const O = new T.Vector3();
  function drawnUnder(x, y, z) {
    O.set(x, y + 0.05, z); ray.set(O, DOWN); ray.far = 60;
    const h = ray.intersectObjects(targets, false);
    return h.length ? { y: h[0].point.y, n: h[0].face ? h[0].face.normal.clone().applyNormalMatrix(new T.Matrix3().getNormalMatrix(h[0].object.matrixWorld)).normalize() : null, on: h[0].object.name || '?' } : null;
  }

  const v = new T.Vector3(), n = new T.Vector3();
  const VPI = 135;
  const tongues = [];
  let verts = 0;
  let overAll_A = 0, overTol_A = 0, worstA = 0, atA = [0, 0];
  let overAll_B = 0, overTol_B = 0, worstB = 0, atB = [0, 0], onB = '';
  let nonWalkTerrainButWalkDrawn = 0;   // the sampling hole: terrain steep, drawn floor flat
  const holeExamples = [];

  for (const m of grp.children) {
    if (!m.isMesh) continue;
    m.updateMatrixWorld(true);
    const P = m.geometry.attributes.position;
    for (let b = 0; b + VPI <= P.count; b += VPI) {
      let cx = 0, cz = 0, topY = -Infinity, botY = Infinity, air = -Infinity;
      let tProud = 0, tProudAt = null;
      let tProudB = 0;
      for (let i = b; i < b + VPI; i++) {
        v.fromBufferAttribute(P, i).applyMatrix4(m.matrixWorld);
        verts++;
        cx += v.x; cz += v.z;
        if (v.y > topY) topY = v.y;
        if (v.y < botY) botY = v.y;
        const gh = W.heightAt(v.x, v.z);
        const prA = v.y - gh;
        if (prA > air) air = prA;
        W.normalAt(v.x, v.z, n);
        const walkA = n.y >= COS;
        if (prA > 0 && walkA) {
          overAll_A++;
          if (prA > TOL) { overTol_A++; }
          if (prA > worstA) { worstA = prA; atA = [v.x, v.z]; }
          if (prA > tProud) { tProud = prA; tProudAt = [v.x, v.z]; }
        }
        /* B: against the drawn ground, lip excluded */
        const d = drawnUnder(v.x, v.y, v.z);
        if (d) {
          const prB = v.y - d.y;
          const walkB = d.n ? d.n.y >= COS : false;
          if (prB > 0 && walkB) {
            overAll_B++;
            if (prB > TOL) overTol_B++;
            if (prB > worstB) { worstB = prB; atB = [v.x, v.z]; onB = d.on; }
            if (prB > tProudB) tProudB = prB;
            if (!walkA && prB > TOL) {
              nonWalkTerrainButWalkDrawn++;
              if (holeExamples.length < 8) holeExamples.push({ x: +v.x.toFixed(1), z: +v.z.toFixed(1), prB: +prB.toFixed(3), on: d.on, terrainNy: +n.y.toFixed(3) });
            }
          }
        }
      }
      cx /= VPI; cz /= VPI;
      /* root/brink metrics for the art pass */
      const rootY = W.heightAt(cx, cz);
      W.normalAt(cx, cz, n);
      const e = 6;
      const gx = (W.heightAt(cx + e, cz) - W.heightAt(cx - e, cz)) / (2 * e);
      const gz = (W.heightAt(cx, cz + e) - W.heightAt(cx, cz - e)) / (2 * e);
      const grad = Math.hypot(gx, gz);
      /* daylight measured properly: minimum clearance under the LOWEST
         part of the mat, and the max clearance anywhere on it */
      tongues.push({
        x: +cx.toFixed(2), z: +cz.toFixed(2),
        topY: +topY.toFixed(2), botY: +botY.toFixed(2),
        hang: +(topY - botY).toFixed(3),
        air: +air.toFixed(3),
        grad: +grad.toFixed(3),
        faceDeg: +(Math.atan(grad) * 180 / Math.PI).toFixed(1),
        proud: +tProud.toFixed(3),
        proudB: +tProudB.toFixed(3),
        proudAt: tProudAt,
        // fall-line direction (downhill unit) for camera placement
        dx: grad > 1e-6 ? -gx / grad : 0, dz: grad > 1e-6 ? -gz / grad : 0,
        rootY: +rootY.toFixed(2),
      });
    }
  }

  const census = c.world.terrain.lipGateCensus ? c.world.terrain.lipGateCensus() : null;
  return {
    mwNonIdentity, verts, tongues,
    A: { overAll: overAll_A, overTol: overTol_A, worst: +worstA.toFixed(3), at: atA.map((q) => +q.toFixed(1)) },
    B: { overAll: overAll_B, overTol: overTol_B, worst: +worstB.toFixed(3), at: atB.map((q) => +q.toFixed(1)), on: onB },
    hole: { n: nonWalkTerrainButWalkDrawn, ex: holeExamples },
    censusRows: census ? census.length : null,
    censusPlaced: census ? census.filter((r) => r.placed).length : null,
  };
});

if (res.none) { console.log('no lip group'); }
else {
  const t = res.tongues;
  console.log(`matrixWorld non-identity meshes: ${res.mwNonIdentity.length}` + (res.mwNonIdentity.length ? ' ' + JSON.stringify(res.mwNonIdentity.slice(0, 3)) : ' (so __lip skipping matrixWorld is harmless here)'));
  console.log(`tongues (verts/135): ${t.length}   vertices: ${res.verts}`);
  console.log(`lipGateCensus rows: ${res.censusRows}  placed: ${res.censusPlaced}`);
  console.log(`A vs heightAt : over walkable at all ${res.A.overAll}, past 0.12 ${res.A.overTol}, worst ${res.A.worst} m at ${res.A.at}`);
  console.log(`B vs DRAWN    : over walkable at all ${res.B.overAll}, past 0.12 ${res.B.overTol}, worst ${res.B.worst} m at ${res.B.at} on ${res.B.on}`);
  console.log(`sampling hole (terrain says unwalkable, drawn floor says walkable, >0.12): ${res.hole.n}`);
  if (res.hole.ex.length) console.log('   ' + JSON.stringify(res.hole.ex));
  const by = (k) => [...t].sort((a, b) => b[k] - a[k]).slice(0, 8).map((r) => `(${r.x},${r.z}) air=${r.air} hang=${r.hang} face=${r.faceDeg}deg proud=${r.proud}`);
  console.log('\nTOP BY AIR (daylight):'); by('air').forEach((s) => console.log('   ' + s));
  console.log('\nTOP BY HANG:'); by('hang').forEach((s) => console.log('   ' + s));
  console.log('\nTOP BY FACE STEEPNESS:'); by('grad').forEach((s) => console.log('   ' + s));
  console.log('\nTOP BY PROUD:'); by('proud').forEach((s) => console.log('   ' + s));
  const airs = t.map((r) => r.air).sort((a, b) => a - b);
  console.log(`\nair distribution: min ${airs[0]} p50 ${airs[airs.length >> 1]} max ${airs[airs.length - 1]}`);
  await writeFile(join(OUT, 'census.json'), JSON.stringify(res, null, 1));
  console.log(`\nwrote ${join(OUT, 'census.json')}`);
}
await browser.close(); server.close();
