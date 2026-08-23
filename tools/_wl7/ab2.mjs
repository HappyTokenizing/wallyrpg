#!/usr/bin/env node
/* WHO ALREADY BREAKS THE BRINK LINE? Same cameras as ab.mjs, three
   variants: terrain alone, terrain+grass, terrain+grass+lip. Scores
   each layer by the pixels of sky/sea it bites out of the brink
   silhouette — the one job the lip was invented for.
   node tools/_wl7/ab2.mjs                                            */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = process.env.WROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.env.WOUT || '/private/tmp/claude-501/-Users-herwig-Desktop-Claude-files/648e6001-7010-404a-9eea-f16c59f21a5d/scratchpad/wl7/ab2';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (p < buf.length) { const len = buf.readUInt32BE(p); const type = buf.toString('ascii', p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
    else if (type === 'IDAT') idat.push(d); else if (type === 'IEND') break; p += 12 + len; }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  const raw = inflateSync(Buffer.concat(idat)); const st = w * ch; const out = Buffer.alloc(h * st); let q = 0;
  for (let y = 0; y < h; y++) { const f = raw[q++]; const ro = y * st, po = ro - st;
    for (let i = 0; i < st; i++) { const a = i >= ch ? out[ro + i - ch] : 0, b = y > 0 ? out[po + i] : 0;
      const cc = (y > 0 && i >= ch) ? out[po + i - ch] : 0; const x = raw[q++]; let v;
      if (f === 0) v = x; else if (f === 1) v = x + a; else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else { const pp = a + b - cc, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - cc); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : cc); }
      out[ro + i] = v & 255; } }
  return { w, h, ch, d: out };
}
const isBg = (r, g, b) => (b > r + 16 && b >= g - 6) || (r > 205 && g > 210 && b > 215);
function bite(a, b) {
  const A = decodePng(readFileSync(a)), B = decodePng(readFileSync(b));
  let n = 0;
  for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) {
    const o = (y * A.w + x) * A.ch;
    if (isBg(A.d[o], A.d[o + 1], A.d[o + 2]) && !isBg(B.d[o], B.d[o + 1], B.d[o + 2])
      && Math.abs(A.d[o + 1] - B.d[o + 1]) + Math.abs(A.d[o + 2] - B.d[o + 2]) > 16) n++;
  }
  return n;
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
await mkdir(OUT, { recursive: true });
await page.evaluate(() => {
  const c = window.WALLY.ctx, W = c.world;
  for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.display = 'none';
  const w = c.wally?.root || c.wally?.group; if (w) w.visible = false;
  const RAF = window.requestAnimationFrame.bind(window);
  let frozen = null;
  window.requestAnimationFrame = (cb) => RAF((t) => cb(frozen === null ? t : frozen));
  window.__freeze = (on) => { frozen = on ? performance.now() : null; };
  window.__lip = (on) => { const g = W.groundGroup.getObjectByName('terrain.lip'); if (g) g.visible = !!on; };
  /* THE LOD HOOK RE-SHOWS THEM EVERY FRAME. grass.js's lod() writes
     mesh.visible each update, so hiding the meshes does nothing that
     survives to the screenshot. Hide their PARENTS instead — a group
     nobody's update loop touches — and report what was hidden so the
     toggle is not taken on trust. */
  window.__grass = (on) => {
    const par = new Set(); let n = 0;
    c.scene.traverse((o) => { if (/^grass\./.test(o.name || '')) { n++; if (o.parent) par.add(o.parent); } });
    for (const g of par) g.visible = !!on;
    return { meshes: n, groups: [...par].map((g) => g.name || '(unnamed)') };
  };
  let want = null;
  window.__lock = (p, t) => { want = { p, t }; };
  const cam = c.camera;
  const tick = () => { if (want) { cam.position.set(...want.p); cam.lookAt(...want.t); cam.updateMatrixWorld(true); } requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
const CAMS = JSON.parse(process.env.WCAMS);
const rep = [];
for (const cme of CAMS) {
  const { label, eye, at } = cme;
  const ty = await page.evaluate(([x, z]) => window.WALLY.ctx.world.heightAt(x, z), at);
  const aim = [at[0], ty + 0.6, at[1]];
  await page.evaluate(([p, t]) => window.__lock(p, t), [eye, aim]);
  await page.evaluate(() => { window.__lip(false); window.__grass(false); });
  await page.waitForTimeout(1500);
  const n = await page.evaluate(() => window.__grass(false));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__freeze(true));
  await page.waitForTimeout(200);
  const f = {};
  const shot = async (tag) => { f[tag] = join(OUT, `${label}-${tag}.png`); await page.waitForTimeout(320); await page.screenshot({ path: f[tag] }); };
  await shot('0-bare');
  await page.evaluate(() => window.__grass(true)); await shot('1-grass');
  await page.evaluate(() => window.__lip(true)); await shot('2-grass-lip');
  await page.evaluate(() => window.__freeze(false));
  const bGrass = bite(f['0-bare'], f['1-grass']);
  const bLip = bite(f['1-grass'], f['2-grass-lip']);
  console.log(`${label.padEnd(18)} grass bites ${String(bGrass).padStart(6)} px of sky at the brink; the lip adds ${String(bLip).padStart(6)} px  (${n.meshes} grass meshes in ${n.groups.join('/')})`);
  rep.push({ label, grass: bGrass, lip: bLip });
}
await writeFile(join(OUT, 'report.json'), JSON.stringify(rep, null, 1));
console.log(`\nwrote ${OUT}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await browser.close(); server.close();
