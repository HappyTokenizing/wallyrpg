#!/usr/bin/env node
/* VERIFY JUDGE #16 — THE LIP AS ART, take 2.
   The camera is chosen by VISIBILITY, not by geometry guesswork: every
   spot phys says he can stand on is scored by how many of the tongue's
   135 vertices are unoccluded from an eye 1.55 m above it, times the
   tongue's angular size. Then the magenta frame is PIXEL-COUNTED, so a
   "photograph" that shows nothing is caught rather than described.
   node tools/_vj16/art2.mjs                                           */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.WROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.env.WOUT || '/private/tmp/claude-501/-Users-herwig-Desktop-Claude-files/648e6001-7010-404a-9eea-f16c59f21a5d/scratchpad/vj16/art2';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0, bd = 8; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString('ascii', p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9]; }
    else if (type === 'IDAT') idat.push(d); else if (type === 'IEND') break;
    p += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  const raw = inflateSync(Buffer.concat(idat)); const st = w * ch;
  const out = Buffer.alloc(h * st); let q = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[q++]; const ro = y * st, po = ro - st;
    for (let i = 0; i < st; i++) {
      const a = i >= ch ? out[ro + i - ch] : 0, b = y > 0 ? out[po + i] : 0;
      const cc = (y > 0 && i >= ch) ? out[po + i - ch] : 0; const x = raw[q++];
      let v;
      if (f === 0) v = x; else if (f === 1) v = x + a; else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else { const pp = a + b - cc, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - cc); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : cc); }
      out[ro + i] = v & 255;
    }
  }
  return { w, h, ch, d: out };
}
/* magenta = the paint colour, after the whole post chain. Measured
   rather than assumed: r high, b high, g low, r and b within 60. */
function magentaPixels(path) {
  const { w, h, ch, d } = decodePng(readFileSync(path));
  let n = 0; let minx = 1e9, maxx = -1, miny = 1e9, maxy = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * ch, r = d[o], g = d[o + 1], b = d[o + 2];
    if (r > 110 && b > 90 && g < Math.min(r, b) - 45) {
      n++; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
  }
  return { n, box: n ? [minx, miny, maxx - minx + 1, maxy - miny + 1] : null, w, h };
}

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

await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE, W = c.world, phys = c.phys;
  const frames = (n) => new Promise((res) => { let k = 0; const t = () => (++k >= n ? res() : requestAnimationFrame(t)); requestAnimationFrame(t); });
  window.__frames = frames;
  const LIP = /\blip\b/i;
  window.__paint = function (on) {
    const g = W.groundGroup.getObjectByName('terrain.lip'); if (!g) return 0; let n = 0;
    g.traverse((o) => { if (!o.isMesh) return; if (on) { o.userData._m = o.userData._m || o.material; o.material = new T.MeshBasicMaterial({ color: 0xff00ff, fog: false }); } else if (o.userData._m) o.material = o.userData._m; n++; });
    return n;
  };
  window.__hideOtherTongues = function (keepCx, keepCz) { return 0; };
  window.__tongueVerts = function (x, z) {
    const g = W.groundGroup.getObjectByName('terrain.lip'); const v = new T.Vector3(); const VPI = 135;
    let best = null, bd = Infinity;
    for (const m of g.children) {
      if (!m.isMesh) continue; m.updateMatrixWorld(true);
      const P = m.geometry.attributes.position;
      for (let b = 0; b + VPI <= P.count; b += VPI) {
        let cx = 0, cz = 0, cy = 0; const pts = [];
        for (let i = b; i < b + VPI; i++) { v.fromBufferAttribute(P, i).applyMatrix4(m.matrixWorld); cx += v.x; cz += v.z; cy += v.y; pts.push([v.x, v.y, v.z]); }
        cx /= VPI; cz /= VPI; cy /= VPI;
        const d = (cx - x) ** 2 + (cz - z) ** 2;
        if (d < bd) { bd = d; best = { cx, cy, cz, pts }; }
      }
    }
    return best;
  };
  /* occluders: everything drawable EXCEPT the lip itself */
  function occluders() {
    const out = [];
    c.scene.traverse((o) => {
      if (!o.isMesh) return;
      if (LIP.test(o.name || '')) return;
      if (o.userData.isOutlineHull) return;
      for (let p = o; p; p = p.parent) if (p.visible === false) return;
      out.push(o);
    });
    return out;
  }
  window.__vis = function (eye, pts) {
    const occ = occluders();
    const ray = new T.Raycaster(); const O = new T.Vector3(eye[0], eye[1], eye[2]); const D = new T.Vector3();
    let seen = 0; let maxAng = 0;
    for (let i = 0; i < pts.length; i += 3) {
      const P = new T.Vector3(pts[i][0], pts[i][1], pts[i][2]);
      D.copy(P).sub(O); const dist = D.length(); D.normalize();
      ray.set(O, D); ray.far = dist - 0.05;
      const h = ray.intersectObjects(occ, false);
      if (!h.length) { seen++; if (1 / dist > maxAng) maxAng = 1 / dist; }
    }
    return { seen, n: Math.ceil(pts.length / 3), maxAng };
  };
  window.__standSpot = async function (tx, tz, radii) {
    const p = phys.player; const out = [];
    for (const r of radii) for (let a = 0; a < 360; a += 12) {
      const rad = a * Math.PI / 180; const x = tx + Math.cos(rad) * r, z = tz + Math.sin(rad) * r;
      const g = phys.groundAt(x, z); if (!g) continue;
      p.teleport(new T.Vector3(x, g.y + 0.1, z)); await frames(5);
      if (!p.grounded) continue;
      const sp = p.simPosition;
      if (Math.hypot(sp.x - x, sp.z - z) > 1.0) continue;
      out.push({ x: +sp.x.toFixed(2), y: +sp.y.toFixed(2), z: +sp.z.toFixed(2), r, a });
    }
    return out;
  };
  let want = null;
  window.__lock = (p, t) => { want = { p, t }; };
  const cam = c.camera;
  const tick = () => { if (want) { cam.position.set(want.p[0], want.p[1], want.p[2]); cam.lookAt(want.t[0], want.t[1], want.t[2]); cam.updateMatrixWorld(true); } requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window.__proj = (t) => { const v = new T.Vector3(t[0], t[1], t[2]).project(cam); return { sx: Math.round((v.x * 0.5 + 0.5) * window.innerWidth), sy: Math.round((-v.y * 0.5 + 0.5) * window.innerHeight) }; };
  window.__hud = (on) => { for (const id of ['hud', 'w-hud', 'ui', 'w-ui']) { const e = document.getElementById(id); if (e) e.style.visibility = on ? '' : 'hidden'; } const r = document.querySelectorAll('#w-hud,.w-hud,#hud,.hud'); r.forEach((e) => e.style.visibility = on ? '' : 'hidden'); return r.length; };
});

const PICKS = JSON.parse(process.env.WPICKS || '[]');
const report = [];
for (const [tx, tz, label] of PICKS) {
  console.log(`\n=== ${label}  (${tx}, ${tz}) ===`);
  await page.evaluate(async ([x, z]) => {
    const c = window.WALLY.ctx, T = window.WALLY.THREE;
    const g = c.phys.groundAt(x, z);
    c.phys.player.teleport(new T.Vector3(x, (g ? g.y : c.world.heightAt(x, z)) + 0.5, z));
    await window.__frames(60);
  }, [tx, tz]);
  const tv = await page.evaluate(([x, z]) => window.__tongueVerts(x, z), [tx, tz]);
  const spots = await page.evaluate(([x, z]) => window.__standSpot(x, z, [6, 9, 13, 18, 25, 34]), [tx, tz]);
  const scored = [];
  for (const s of spots) {
    const eye = [s.x, s.y + 1.55, s.z];
    const v = await page.evaluate(([e, p]) => window.__vis(e, p), [eye, tv.pts]);
    const dist = Math.hypot(s.x - tv.cx, s.z - tv.cz);
    if (dist < 4) continue;
    scored.push({ ...s, eye, seen: v.seen, n: v.n, dist, score: (v.seen / v.n) / Math.max(6, dist) });
  }
  scored.sort((a, b) => b.score - a.score);
  console.log(`   ${spots.length} standable spots; best visibility ${scored[0] ? (scored[0].seen + '/' + scored[0].n + ' verts at ' + scored[0].dist.toFixed(1) + ' m') : 'none'}`);
  /* three cameras: best overall, best close, best from below */
  const cams = [];
  if (scored[0]) cams.push(['best', scored[0]]);
  const close = scored.find((s) => s.dist < 12 && s.seen > s.n * 0.25 && s !== scored[0]);
  if (close) cams.push(['close', close]);
  const below = scored.filter((s) => tv.cy - s.eye[1] > 1.5 && s.seen > 0).sort((a, b) => b.seen / b.dist - a.seen / a.dist)[0];
  if (below && below !== scored[0] && below !== close) cams.push(['below', below]);

  for (const [tag, s] of cams) {
    console.log(`   cam ${tag}: eye (${s.eye.map((q) => q.toFixed(1)).join(', ')})  dist ${s.dist.toFixed(1)} m  ${s.seen}/${s.n} verts visible  tongue ${(tv.cy - s.eye[1]).toFixed(2)} m above eye`);
    const shots = {};
    for (const paint of [true, false]) {
      await page.evaluate((on) => window.__paint(on), paint);
      await page.evaluate(([p, t]) => window.__lock(p, t), [s.eye, [tv.cx, tv.cy, tv.cz]]);
      await page.waitForTimeout(800);
      const proj = await page.evaluate((t) => window.__proj(t), [tv.cx, tv.cy, tv.cz]);
      const nm = join(OUT, `${label}-${tag}-${paint ? 'magenta' : 'plain'}.png`);
      await page.screenshot({ path: nm });
      shots[paint ? 'm' : 'p'] = { nm, proj };
    }
    await page.evaluate(() => window.__paint(false));
    const mp = magentaPixels(shots.m.nm);
    console.log(`      magenta pixels on screen: ${mp.n}${mp.box ? '  bbox ' + mp.box.join(',') : ''}`);
    /* crop both to the magenta bbox, padded, so the two are comparable */
    if (mp.box) {
      const pad = Math.max(70, Math.round(Math.max(mp.box[2], mp.box[3]) * 0.9));
      const cx0 = Math.max(0, mp.box[0] - pad), cy0 = Math.max(0, mp.box[1] - pad);
      const cw = Math.min(1280 - cx0, mp.box[2] + pad * 2), chh = Math.min(720 - cy0, mp.box[3] + pad * 2);
      for (const paint of [true, false]) {
        await page.evaluate((on) => window.__paint(on), paint);
        await page.evaluate(([p, t]) => window.__lock(p, t), [s.eye, [tv.cx, tv.cy, tv.cz]]);
        await page.waitForTimeout(700);
        await page.screenshot({ path: join(OUT, `crop-${label}-${tag}-${paint ? 'magenta' : 'plain'}.png`), clip: { x: cx0, y: cy0, width: cw, height: chh } });
      }
      await page.evaluate(() => window.__paint(false));
    }
    report.push({ label, tag, eye: s.eye, dist: +s.dist.toFixed(1), seen: s.seen, n: s.n, magenta: mp.n, box: mp.box, aboveEye: +(tv.cy - s.eye[1]).toFixed(2) });
  }
}
await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 1));
console.log('\nwrote ' + OUT);
await browser.close(); server.close();
