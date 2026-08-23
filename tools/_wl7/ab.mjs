#!/usr/bin/env node
/* THE SILHOUETTE A/B. The lip exists for one reason: to break the hard
   line where the plateau meets the face. So score a camera by exactly
   that and nothing else — pixels that are SKY OR SEA with the lip
   hidden and are NOT with it shown. That is the feature doing its job,
   measured; on-screen area (the judge's rig) rewards the broadside
   slab instead, which is the failure.
   Cameras are places the physics controller actually stands.
   WTARGETS='[[x,z,"label"],...] '  node tools/_wl7/ab.mjs             */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.WROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.env.WOUT || '/private/tmp/claude-501/-Users-herwig-Desktop-Claude-files/648e6001-7010-404a-9eea-f16c59f21a5d/scratchpad/wl7/ab';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString('ascii', p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
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
/* background = sky or sea or cloud: everything the brink is drawn against */
const isBg = (r, g, b) => (b > r + 16 && b >= g - 6) || (r > 205 && g > 210 && b > 215);
function bite(offPath, onPath) {
  const A = decodePng(readFileSync(offPath)), B = decodePng(readFileSync(onPath));
  let n = 0, minx = 1e9, maxx = -1, miny = 1e9, maxy = -1, chg = 0;
  for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) {
    const o = (y * A.w + x) * A.ch;
    const bgA = isBg(A.d[o], A.d[o + 1], A.d[o + 2]);
    const bgB = isBg(B.d[o], B.d[o + 1], B.d[o + 2]);
    if (Math.abs(A.d[o] - B.d[o]) + Math.abs(A.d[o + 1] - B.d[o + 1]) + Math.abs(A.d[o + 2] - B.d[o + 2]) > 24) {
      chg++; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    if (bgA && !bgB && Math.abs(A.d[o + 1] - B.d[o + 1]) + Math.abs(A.d[o + 2] - B.d[o + 2]) > 16) n++;
  }
  return { bite: n, changed: chg, box: chg ? [minx, miny, maxx - minx + 1, maxy - miny + 1] : null, w: A.w, h: A.h };
}

const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c)); rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b); }
  catch { rs.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const t0 = Date.now();
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 300000 });
await page.waitForTimeout(3000);
console.log(`boot ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await mkdir(OUT, { recursive: true });

await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE, W = c.world, phys = c.phys;
  const frames = (n) => new Promise((res) => { let k = 0; const t = () => (++k >= n ? res() : requestAnimationFrame(t)); requestAnimationFrame(t); });
  window.__frames = frames;
  /* HUD and every other DOM overlay out of the way — it is owned by
     another workflow and it is not what is being judged. */
  for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.display = 'none';
  /* FREEZE THE WORLD FOR THE PAIR. main.js's step() takes dt from the
     rAF timestamp, so handing it the same timestamp twice makes dt 0:
     wind, grass, clouds, water and particles all stop where they are,
     and the only thing that differs between the two frames is the
     thing being toggled. Without it 83k pixels of a 921k frame change
     between two shots of the SAME camera and the diff is meaningless. */
  const RAF = window.requestAnimationFrame.bind(window);
  let frozen = null;
  window.requestAnimationFrame = (cb) => RAF((t) => cb(frozen === null ? t : frozen));
  window.__freeze = (on) => { frozen = on ? performance.now() : null; return frozen !== null; };
  window.__lip = (on) => { const g = W.groundGroup.getObjectByName('terrain.lip'); if (g) g.visible = !!on; return !!g; };
  /* WALLY OUT OF FRAME. He is owned by another workflow, he is
     animating, and a moving subject in an A/B pair is a false diff. */
  window.__hideW = () => { const w = c.wally?.root || c.wally?.group; if (w) w.visible = false; return !!w; };
  window.__stand = async function (x, z) {
    const p = phys.player, g = phys.groundAt(x, z);
    if (!g) return null;
    p.teleport(new T.Vector3(x, g.y + 0.1, z)); await frames(8);
    if (!p.grounded) return null;
    const sp = p.simPosition;
    if (Math.hypot(sp.x - x, sp.z - z) > 1.2) return null;
    return { x: +sp.x.toFixed(2), y: +sp.y.toFixed(2), z: +sp.z.toFixed(2) };
  };
  let want = null;
  window.__lock = (p, t) => { want = { p, t }; };
  const cam = c.camera;
  const tick = () => { if (want) { cam.position.set(want.p[0], want.p[1], want.p[2]); cam.lookAt(want.t[0], want.t[1], want.t[2]); cam.updateMatrixWorld(true); } requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
await page.evaluate(() => window.__hideW());

const TARGETS = JSON.parse(process.env.WTARGETS || '[]');
const RADII = (process.env.WRADII || '10,16,24,34').split(',').map(Number);
const rep = [];
for (const [tx, tz, label] of TARGETS) {
  console.log(`\n=== ${label} (${tx}, ${tz}) ===`);
  const ty = await page.evaluate(([x, z]) => window.WALLY.ctx.world.heightAt(x, z), [tx, tz]);
  /* the aim point is the brink itself, at eye height above it */
  const aim = [tx, ty + 0.6, tz];
  const spots = [];
  for (const r of RADII) for (let a = 0; a < 360; a += 20) {
    const rad = a * Math.PI / 180;
    const s = await page.evaluate(([x, z]) => window.__stand(x, z), [tx + Math.cos(rad) * r, tz + Math.sin(rad) * r]);
    if (s) spots.push({ ...s, r });
  }
  await page.setViewportSize({ width: 640, height: 360 });
  await page.waitForTimeout(400);
  let best = null;
  const tOff = join(OUT, '_s-off.png'), tOn = join(OUT, '_s-on.png');
  for (const s of spots) {
    const eye = [s.x, s.y + 1.55, s.z];
    if (Math.hypot(s.x - tx, s.z - tz) < 5) continue;
    await page.evaluate(([p, t]) => window.__lock(p, t), [eye, aim]);
    await page.evaluate(() => window.__lip(false)); await page.waitForTimeout(150);
    await page.evaluate(() => window.__freeze(true)); await page.waitForTimeout(60);
    await page.screenshot({ path: tOff });
    await page.evaluate(() => window.__lip(true)); await page.waitForTimeout(120);
    await page.screenshot({ path: tOn });
    await page.evaluate(() => window.__freeze(false));
    const b = bite(tOff, tOn);
    if (!best || b.bite > best.b.bite) best = { eye, s, b };
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(500);
  if (!best || !best.b.changed) { console.log('   the lip changes nothing from anywhere a player can stand'); rep.push({ label, visible: false }); continue; }
  const d = Math.hypot(best.s.x - tx, best.s.z - tz);
  console.log(`   ${spots.length} standable spots; best eye (${best.eye.map((q) => q.toFixed(1)).join(', ')}) at ${d.toFixed(1)} m`);
  console.log(`   sky/sea bitten into by the lip: ${best.b.bite} px of ${best.b.changed} changed (at 640x360)`);
  await page.evaluate(([p, t]) => window.__lock(p, t), [best.eye, aim]);
  const outs = {};
  await page.evaluate((v) => window.__lip(v), false);
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__freeze(true));
  await page.waitForTimeout(120);
  for (const on of [false, true]) {
    await page.evaluate((v) => window.__lip(v), on);
    await page.waitForTimeout(300);
    outs[on ? 'on' : 'off'] = join(OUT, `${label}-${on ? 'on' : 'off'}.png`);
    await page.screenshot({ path: outs[on ? 'on' : 'off'] });
  }
  const full = bite(outs.off, outs.on);
  console.log(`   at 1280x720: ${full.bite} px of sky/sea bitten, ${full.changed} changed, bbox ${full.box}`);
  if (full.box) {
    const pad = Math.max(70, Math.round(Math.max(full.box[2], full.box[3]) * 0.55));
    const x0 = Math.max(0, full.box[0] - pad), y0 = Math.max(0, full.box[1] - pad);
    const w = Math.min(1280 - x0, full.box[2] + pad * 2), h = Math.min(720 - y0, full.box[3] + pad * 2);
    for (const on of [false, true]) {
      await page.evaluate((v) => window.__lip(v), on);
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(OUT, `crop-${label}-${on ? 'on' : 'off'}.png`), clip: { x: x0, y: y0, width: w, height: h } });
    }
  }
  await page.evaluate(() => window.__freeze(false));
  await page.evaluate(() => window.__lip(true));
  rep.push({ label, eye: best.eye, dist: +d.toFixed(1), bite: full.bite, changed: full.changed, box: full.box });
}
await writeFile(join(OUT, 'report.json'), JSON.stringify(rep, null, 1));
console.log(`\nwrote ${OUT}   total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await browser.close(); server.close();
