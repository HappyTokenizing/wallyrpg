#!/usr/bin/env node
/* VERIFY JUDGE #16 — THE LIP AS ART, take 3: judge it at its BEST.
   art2 picked cameras by vertex visibility, which favours close
   edge-on views and is unfair to the art. This sweeps standable spots
   and picks the one where the tongue covers the MOST screen — its most
   flattering honest angle — then shoots magenta + plain there. Also
   dumps the per-vertex clearance histogram for each tongue, which is
   what AIR_MIN's max-over-vertices hides.
   node tools/_vj16/art3.mjs                                           */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.WROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.env.WOUT || '/private/tmp/claude-501/-Users-herwig-Desktop-Claude-files/648e6001-7010-404a-9eea-f16c59f21a5d/scratchpad/vj16/art3';
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
function magenta(path) {
  const { w, h, ch, d } = decodePng(readFileSync(path));
  let n = 0, minx = 1e9, maxx = -1, miny = 1e9, maxy = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * ch, r = d[o], g = d[o + 1], b = d[o + 2];
    if (r > 110 && b > 90 && g < Math.min(r, b) - 45) { n++; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
  }
  return { n, box: n ? [minx, miny, maxx - minx + 1, maxy - miny + 1] : null };
}

const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c)); rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b); }
  catch { rs.writeHead(404).end(); }
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
  window.__paint = function (on) {
    const g = W.groundGroup.getObjectByName('terrain.lip'); if (!g) return 0; let n = 0;
    g.traverse((o) => { if (!o.isMesh) return; if (on) { o.userData._m = o.userData._m || o.material; o.material = new T.MeshBasicMaterial({ color: 0xff00ff, fog: false }); } else if (o.userData._m) o.material = o.userData._m; n++; });
    return n;
  };
  window.__tongue = function (x, z) {
    const g = W.groundGroup.getObjectByName('terrain.lip'); const v = new T.Vector3(); const VPI = 135;
    let best = null, bd = Infinity;
    for (const m of g.children) {
      if (!m.isMesh) continue; m.updateMatrixWorld(true);
      const P = m.geometry.attributes.position;
      for (let b = 0; b + VPI <= P.count; b += VPI) {
        let cx = 0, cy = 0, cz = 0; const pts = [];
        for (let i = b; i < b + VPI; i++) { v.fromBufferAttribute(P, i).applyMatrix4(m.matrixWorld); cx += v.x; cy += v.y; cz += v.z; pts.push([v.x, v.y, v.z]); }
        cx /= VPI; cy /= VPI; cz /= VPI;
        const d = (cx - x) ** 2 + (cz - z) ** 2;
        if (d < bd) { bd = d; best = { cx, cy, cz, pts }; }
      }
    }
    return best;
  };
  /* the histogram AIR_MIN's max hides: clearance over the raster at
     every vertex, not the largest one */
  window.__clearance = function (pts) {
    const out = [];
    for (const [x, y, z] of pts) out.push(y - W.heightAt(x, z));
    out.sort((a, b) => a - b);
    const q = (f) => +out[Math.min(out.length - 1, Math.floor(f * out.length))].toFixed(3);
    return { n: out.length, min: q(0), p25: q(0.25), p50: q(0.5), p75: q(0.75), max: +out[out.length - 1].toFixed(3),
      under0_1: out.filter((v) => v < 0.1).length, under0_25: out.filter((v) => v < 0.25).length };
  };
  window.__spots = async function (tx, tz, radii) {
    const p = phys.player; const out = [];
    for (const r of radii) for (let a = 0; a < 360; a += 20) {
      const rad = a * Math.PI / 180, x = tx + Math.cos(rad) * r, z = tz + Math.sin(rad) * r;
      const g = phys.groundAt(x, z); if (!g) continue;
      p.teleport(new T.Vector3(x, g.y + 0.1, z)); await frames(5);
      if (!p.grounded) continue;
      const sp = p.simPosition;
      if (Math.hypot(sp.x - x, sp.z - z) > 1.0) continue;
      out.push({ x: +sp.x.toFixed(2), y: +sp.y.toFixed(2), z: +sp.z.toFixed(2), r });
    }
    return out;
  };
  let want = null;
  window.__lock = (p, t) => { want = { p, t }; };
  const cam = c.camera;
  const tick = () => { if (want) { cam.position.set(want.p[0], want.p[1], want.p[2]); cam.lookAt(want.t[0], want.t[1], want.t[2]); cam.updateMatrixWorld(true); } requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});

const PICKS = JSON.parse(process.env.WPICKS || '[]');
const rep = [];
for (const [tx, tz, label] of PICKS) {
  console.log(`\n=== ${label} (${tx}, ${tz}) ===`);
  await page.evaluate(async ([x, z]) => {
    const c = window.WALLY.ctx, T = window.WALLY.THREE;
    const g = c.phys.groundAt(x, z);
    c.phys.player.teleport(new T.Vector3(x, (g ? g.y : c.world.heightAt(x, z)) + 0.5, z));
    await window.__frames(60);
  }, [tx, tz]);
  const tv = await page.evaluate(([x, z]) => window.__tongue(x, z), [tx, tz]);
  const cl = await page.evaluate((p) => window.__clearance(p), tv.pts);
  console.log(`   clearance over the raster, all 135 verts: min ${cl.min}  p25 ${cl.p25}  p50 ${cl.p50}  p75 ${cl.p75}  MAX ${cl.max}`);
  console.log(`   verts with under 0.10 m of ground clearance: ${cl.under0_1}/135   under 0.25 m: ${cl.under0_25}/135`);
  const spots = await page.evaluate(([x, z]) => window.__spots(x, z, [7, 10, 14, 20, 28]), [tx, tz]);
  await page.evaluate(() => window.__paint(true));
  let best = null;
  const tmp = join(OUT, `_probe.png`);
  for (const s of spots) {
    const eye = [s.x, s.y + 1.55, s.z];
    if (Math.hypot(s.x - tv.cx, s.z - tv.cz) < 4) continue;
    await page.evaluate(([p, t]) => window.__lock(p, t), [eye, [tv.cx, tv.cy, tv.cz]]);
    await page.waitForTimeout(130);
    await page.screenshot({ path: tmp });
    const m = magenta(tmp);
    if (!best || m.n > best.m.n) best = { eye, s, m };
  }
  await page.evaluate(() => window.__paint(false));
  if (!best || !best.m.box) { console.log('   never visible from any standable spot'); rep.push({ label, cl, visible: false }); continue; }
  console.log(`   BEST view: eye (${best.eye.map((q) => q.toFixed(1)).join(', ')})  dist ${Math.hypot(best.s.x - tv.cx, best.s.z - tv.cz).toFixed(1)} m  ${best.m.n} px  bbox ${best.m.box.join(',')}`);
  const box = best.m.box;
  const pad = Math.max(90, Math.round(Math.max(box[2], box[3]) * 0.8));
  const cx0 = Math.max(0, box[0] - pad), cy0 = Math.max(0, box[1] - pad);
  const cw = Math.min(1280 - cx0, box[2] + pad * 2), chh = Math.min(720 - cy0, box[3] + pad * 2);
  for (const paint of [true, false]) {
    await page.evaluate((on) => window.__paint(on), paint);
    await page.evaluate(([p, t]) => window.__lock(p, t), [best.eye, [tv.cx, tv.cy, tv.cz]]);
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUT, `${label}-BEST-${paint ? 'magenta' : 'plain'}.png`) });
    await page.screenshot({ path: join(OUT, `crop-${label}-BEST-${paint ? 'magenta' : 'plain'}.png`), clip: { x: cx0, y: cy0, width: cw, height: chh } });
  }
  await page.evaluate(() => window.__paint(false));
  rep.push({ label, cl, eye: best.eye, px: best.m.n, box, visible: true });
}
await writeFile(join(OUT, 'report.json'), JSON.stringify(rep, null, 1));
console.log('\nwrote ' + OUT);
await browser.close(); server.close();
