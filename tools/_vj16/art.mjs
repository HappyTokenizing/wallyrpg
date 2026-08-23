#!/usr/bin/env node
/* VERIFY JUDGE #16 — THE LIP AS ART.
   Picks tongues by measurement (most daylight / longest hang / steepest
   face / worst proud), finds a spot the PHYSICS says the player can
   actually stand, puts the camera at his eye there, and shoots each
   tongue magenta and plain. Also re-measures proud LOCALLY (camera near
   the tongue, so the drawn LOD is the near one) against the drawn mesh
   within 2.5 m and against phys.groundAt.
   node tools/_vj16/art.mjs                                            */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.WROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.env.WOUT || '/private/tmp/claude-501/-Users-herwig-Desktop-Claude-files/648e6001-7010-404a-9eea-f16c59f21a5d/scratchpad/vj16/art';
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

/* the four picks, chosen from census.json by measurement */
const PICKS = JSON.parse(process.env.WPICKS || '[]');

await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE;
  const W = c.world, phys = c.phys;
  const frames = (n) => new Promise((res) => { let k = 0; const t = () => (++k >= n ? res() : requestAnimationFrame(t)); requestAnimationFrame(t); });
  window.__frames = frames;
  const COS = Math.cos(48 * Math.PI / 180);

  window.__paint = function (on) {
    const g = W.groundGroup.getObjectByName('terrain.lip');
    if (!g) return 0;
    let n = 0;
    g.traverse((o) => {
      if (!o.isMesh) return;
      if (on) { o.userData._m = o.userData._m || o.material; o.material = new T.MeshBasicMaterial({ color: 0xff00ff }); }
      else if (o.userData._m) { o.material = o.userData._m; }
      n++;
    });
    return n;
  };

  /* Vertices of the tongue nearest (x,z), in world space. */
  window.__tongueVerts = function (x, z) {
    const g = W.groundGroup.getObjectByName('terrain.lip');
    const v = new T.Vector3(); const VPI = 135;
    let best = null, bd = Infinity;
    for (const m of g.children) {
      if (!m.isMesh) continue;
      m.updateMatrixWorld(true);
      const P = m.geometry.attributes.position;
      for (let b = 0; b + VPI <= P.count; b += VPI) {
        let cx = 0, cz = 0; const pts = [];
        for (let i = b; i < b + VPI; i++) {
          v.fromBufferAttribute(P, i).applyMatrix4(m.matrixWorld);
          cx += v.x; cz += v.z; pts.push([v.x, v.y, v.z]);
        }
        cx /= VPI; cz /= VPI;
        const d = (cx - x) ** 2 + (cz - z) ** 2;
        if (d < bd) { bd = d; best = { cx, cz, pts }; }
      }
    }
    return best;
  };

  /* LOCAL re-measure: drawn ground within 2.5 m under each vertex,
     walkability judged by the controller's own raster normal, plus
     phys.groundAt. Camera must already be near, so the LOD is near. */
  const BASE = /outline|hull|contactShadow|cloth|drift|grass|foliage|detail|bush|reed|water|sky|cloud/i;
  const LIP = /\blip\b/i;
  window.__localProud = function (pts) {
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
    const n = new T.Vector3();
    let wDraw = 0, wDrawOn = '', wPhys = 0, wRas = 0, nOver = 0;
    for (const [x, y, z] of pts) {
      W.normalAt(x, z, n);
      const walk = n.y >= COS;
      const pr = y - W.heightAt(x, z);
      if (walk && pr > wRas) wRas = pr;
      O.set(x, y + 0.05, z); ray.set(O, DOWN); ray.far = 2.5;
      const h = ray.intersectObjects(targets, false);
      if (h.length && walk) {
        const d = y - h[0].point.y;
        if (d > 0.12) nOver++;
        if (d > wDraw) { wDraw = d; wDrawOn = h[0].object.name || '?'; }
      }
      const ga = phys.groundAt(x, z);
      if (ga && walk) { const d = y - ga.y; if (d > wPhys) wPhys = d; }
    }
    return { wRas: +wRas.toFixed(3), wDraw: +wDraw.toFixed(3), wDrawOn, wPhys: +wPhys.toFixed(3), nOver };
  };

  /* A SPOT THE PHYSICS SAYS HE CAN STAND. Ring search; teleport, settle,
     require grounded and require the ground not to have moved him far. */
  window.__standSpot = async function (tx, tz, radii, eye) {
    const p = phys.player;
    const out = [];
    for (const r of radii) {
      for (let a = 0; a < 360; a += 15) {
        const rad = a * Math.PI / 180;
        const x = tx + Math.cos(rad) * r, z = tz + Math.sin(rad) * r;
        const g = phys.groundAt(x, z);
        if (!g) continue;
        p.teleport(new T.Vector3(x, g.y + 0.1, z));
        await frames(6);
        if (!p.grounded) continue;
        const sp = p.simPosition;
        if (Math.hypot(sp.x - x, sp.z - z) > 1.2) continue;   // slid away: not standable
        out.push({ x: +sp.x.toFixed(2), y: +sp.y.toFixed(2), z: +sp.z.toFixed(2), r, a });
      }
    }
    return out;
  };

  window.__shoot = async function (ex, ey, ez, tx, ty, tz) {
    const cam = c.camera;
    if (c.cameraRig) c.cameraRig.enabled = false;
    if (c.ctrl) c.ctrl.enabled = false;
    window.__camOverride = true;
    cam.position.set(ex, ey, ez);
    cam.lookAt(tx, ty, tz);
    cam.updateMatrixWorld(true);
    await frames(3);
    cam.position.set(ex, ey, ez);
    cam.lookAt(tx, ty, tz);
    cam.updateMatrixWorld(true);
    /* project the tongue centre so the crop can be aimed */
    const v = new window.WALLY.THREE.Vector3(tx, ty, tz).project(cam);
    return { sx: Math.round((v.x * 0.5 + 0.5) * window.innerWidth), sy: Math.round((-v.y * 0.5 + 0.5) * window.innerHeight) };
  };
});

/* freeze the camera every frame so the game's own rig cannot take it back */
await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const cam = c.camera;
  let want = null;
  window.__lock = (p, t) => { want = { p, t }; };
  const tick = () => {
    if (want) { cam.position.set(want.p[0], want.p[1], want.p[2]); cam.lookAt(want.t[0], want.t[1], want.t[2]); cam.updateMatrixWorld(true); }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const report = [];
for (const pk of PICKS) {
  const [tx, tz, label] = pk;
  console.log(`\n=== ${label}  (${tx}, ${tz}) ===`);
  // move the player there first so the LOD + collision window are local
  await page.evaluate(async ([x, z]) => {
    const c = window.WALLY.ctx, T = window.WALLY.THREE;
    const g = c.phys.groundAt(x, z);
    c.phys.player.teleport(new T.Vector3(x, (g ? g.y : c.world.heightAt(x, z)) + 0.5, z));
    await window.__frames(60);
  }, [tx, tz]);

  const tv = await page.evaluate(([x, z]) => window.__tongueVerts(x, z), [tx, tz]);
  const local = await page.evaluate((pts) => window.__localProud(pts), tv.pts);
  console.log(`   local re-measure: worst over walkable ground — raster ${local.wRas} m, drawn(<=2.5 m) ${local.wDraw} m on ${local.wDrawOn}, phys.groundAt ${local.wPhys} m; verts past 0.12 vs drawn: ${local.nOver}`);

  const spots = await page.evaluate(([x, z]) => window.__standSpot(x, z, [8, 12, 16, 22, 30], 1.6), [tx, tz]);
  console.log(`   standable spots found: ${spots.length}`);
  if (!spots.length) { report.push({ label, tx, tz, local, spots: 0 }); continue; }

  // tongue centre height
  const ty = tv.pts.reduce((a, p) => a + p[1], 0) / tv.pts.length;
  // choose the spot that looks most UP at the tongue (largest elevation
  // difference below it) at a sane distance — that is the broadside view
  const scored = spots.map((s) => ({ ...s, drop: ty - s.y, dist: Math.hypot(s.x - tx, s.z - tz) }))
    .filter((s) => s.dist > 5)
    .sort((a, b) => (b.drop / Math.max(6, b.dist)) - (a.drop / Math.max(6, a.dist)));
  const picks = [scored[0], scored.find((s) => s.drop < 1.0 && s.dist < 14) || scored[scored.length - 1]].filter(Boolean);

  for (let k = 0; k < picks.length; k++) {
    const s = picks[k];
    const ex = s.x, ey = s.y + 1.55, ez = s.z;
    console.log(`   camera ${k}: eye (${ex.toFixed(1)}, ${ey.toFixed(1)}, ${ez.toFixed(1)})  dist ${s.dist.toFixed(1)} m  tongue is ${(ty - ey).toFixed(2)} m above the eye`);
    for (const paint of [false, true]) {
      await page.evaluate((on) => window.__paint(on), paint);
      const proj = await page.evaluate(([a, b, cc, d, e, f]) => window.__shoot(a, b, cc, d, e, f), [ex, ey, ez, tv.cx, ty, tv.cz]);
      await page.evaluate(([p, t]) => window.__lock(p, t), [[ex, ey, ez], [tv.cx, ty, tv.cz]]);
      await page.waitForTimeout(700);
      const nm = `${label}-cam${k}-${paint ? 'magenta' : 'plain'}.png`;
      await page.screenshot({ path: join(OUT, nm) });
      // tight crop around the tongue
      const cw = 420, chh = 300;
      const cx0 = Math.max(0, Math.min(1280 - cw, proj.sx - cw / 2));
      const cy0 = Math.max(0, Math.min(720 - chh, proj.sy - chh / 2));
      await page.screenshot({ path: join(OUT, `crop-${nm}`), clip: { x: cx0, y: cy0, width: cw, height: chh } });
    }
    await page.evaluate(() => window.__paint(false));
    report.push({ label, tx, tz, local, cam: k, eye: [+ex.toFixed(1), +ey.toFixed(1), +ez.toFixed(1)], dist: +s.dist.toFixed(1), aboveEye: +(ty - ey).toFixed(2) });
  }
}
await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 1));
console.log('\nwrote ' + OUT);
await browser.close(); server.close();
