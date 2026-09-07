#!/usr/bin/env node
/* ============================================================
   _sky-branch.mjs — which of the two claimed fixes is load-bearing?

   sky.js's THE DAWN STOP says the mauve was the two-colour vertical
   ramp and "it was never the haze".
   lighting.js's THE DAWN MUD says the mauve was the haze — a warm and
   a cool entry averaged to a neutral and painted flat across the band.

   Both cannot be the fix. So each is switched OFF on its own, at three
   hours, and the frame is measured:

     base    as shipped
     dawn0   sky.js's dawn stop + dawn band exponent forced off
             (lighting.dawn is what sky.js reads; lighting's own
             internal use of it is untouched, so this isolates
             exactly the claim sky.js makes)
     hazeC   lighting's fogOut replaced with the 16:00 pale cyan,
             everything else untouched — isolates the claim
             lighting.js makes

   A fix that is load-bearing shows a big delta when switched off.
   ============================================================ */

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
function arg(n, f) { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : f; }
const HOURS = arg('hours', '7,8,17').split(',').map(Number);
const OUT = arg('out', 'shots/_skybranch');

const server = createServer(async (req, res) => {
  try {
    const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const b = await readFile(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(b);
  } catch { res.writeHead(404).end('nf'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__ === true', { timeout: 90000 });
const loadS = (Date.now() - t0) / 1000;
const gpu = await page.evaluate(() => { const gl = WALLY.ctx.renderer.getContext(); const d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?'; });
await page.evaluate(() => { for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.display = 'none'; });

const settle = () => page.evaluate(() => new Promise(r => { let n = 0; const t = () => (++n > 20 ? r() : requestAnimationFrame(t)); requestAnimationFrame(t); }));

const MEASURE = async ([url, horizonY]) => {
  const bmp = await createImageBitmap(await (await fetch(url)).blob());
  const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const w = bmp.width, d = g.getImageData(0, 0, bmp.width, bmp.height).data;
  const y1 = Math.floor(horizonY) - 10, rows = [];
  let R = 0, G = 0, B = 0, n = 0, gs = 0;
  for (let y = 2; y <= y1; y++) {
    let rr = 0, gg = 0, bb = 0, m = 0;
    for (let x = 0; x < w; x += 2) { const o = (y * w + x) * 4; rr += d[o]; gg += d[o + 1]; bb += d[o + 2]; m++; R += d[o]; G += d[o + 1]; B += d[o + 2]; n++; if (d[o + 1] < d[o] && d[o + 1] < d[o + 2]) gs++; }
    rows.push([rr / m, gg / m, bb / m]);
  }
  const nb = Math.max(2, Math.round(rows.length * 0.06));
  const avg = (s, e) => { let r = 0, g2 = 0, b = 0; for (let i = s; i < e; i++) { r += rows[i][0]; g2 += rows[i][1]; b += rows[i][2]; } const k = e - s; return [r / k, g2 / k, b / k]; };
  const top = avg(0, nb), bot = avg(rows.length - nb, rows.length);
  const hex = a => '#' + a.map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  const mean = [R / n, G / n, B / n]; const mx = Math.max(...mean), mn = Math.min(...mean);
  return { mean: hex(mean), sat: +((mx - mn) / mx).toFixed(3), gSmall: +(100 * gs / n).toFixed(1),
    grad: +(Math.abs(top[0] - bot[0]) + Math.abs(top[1] - bot[1]) + Math.abs(top[2] - bot[2])).toFixed(1),
    top: hex(top), bot: hex(bot) };
};

const CASES = {
  base: () => {},
  dawn0: () => { const L = WALLY.ctx.sky.lighting; Object.defineProperty(L, 'dawn', { get: () => 0, configurable: true }); },
  /* THE REVERT CHECK for lighting.js's claim. Put the haze back to
     what THE DAWN MUD says it replaced: the flat 50/50 average of the
     horizon and fog entries, boosted, with no chroma weighting and no
     warm push. If that comment's fix is load-bearing, the hours it
     claims to have saved collapse here. */
  mud50: () => {
    const { ctx, THREE } = WALLY; const L = ctx.sky.lighting;
    const c = new THREE.Color();
    const boost = (x, k = 4.0, gain = 1.02) => {
      const mx = Math.max(x.r, x.g, x.b);
      const cool = mx > 1e-5 ? Math.max(0, Math.min(1, 1 - x.r / mx)) : 0;
      const c2 = cool * cool, sat = Math.min(4.4, 1 + k * c2), g = gain - 0.513 * c2;
      const l = x.r * 0.2126 + x.g * 0.7152 + x.b * 0.0722;
      x.setRGB(Math.max(0, l + (x.r - l) * sat) * g, Math.max(0, l + (x.g - l) * sat) * g, Math.max(0, l + (x.b - l) * sat) * g);
      return x;
    };
    Object.defineProperty(L, 'fogOut', {
      get: () => boost(c.copy(L.horizonColor).lerp(L.fogColor, 0.5)), configurable: true,
    });
  },
};

const rows = [];
for (const [name, setup] of Object.entries(CASES)) {
  /* a fresh page per case: the overrides are one-way */
  if (name !== 'base') { await page.reload({ waitUntil: 'load' }); await page.waitForFunction('window.__WALLY_READY__ === true', { timeout: 90000 }); await page.evaluate(() => { for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.display = 'none'; }); }
  await page.evaluate(setup);
  for (const hour of HOURS) {
    await page.evaluate((hh) => {
      WALLY.debug.setHour(hh);
      const { ctx, THREE } = WALLY; ctx.cam?.setEnabled?.(false);
      const cam = ctx.camera, d = ctx.sky.sunDirection;
      const az = Math.atan2(d.x, d.z) + Math.PI;      // away from the sun
      cam.position.set(0, 150, 0);
      cam.lookAt(Math.sin(az) * 4000, 150, Math.cos(az) * 4000);
      cam.updateMatrixWorld();
    }, hour);
    await settle();
    const hy = await page.evaluate(() => {
      const { ctx, THREE } = WALLY, cam = ctx.camera, f = new THREE.Vector3();
      cam.getWorldDirection(f); f.y = 0; f.normalize();
      const p = new THREE.Vector3().copy(cam.position).addScaledVector(f, 1e5).project(cam);
      return (1 - (p.y * 0.5 + 0.5)) * window.innerHeight;
    });
    const buf = await page.screenshot({ animations: 'allow' });
    const st = await page.evaluate(MEASURE, [`data:image/png;base64,${buf.toString('base64')}`, hy]);
    rows.push({ hour, name, ...st });
    await mkdir(resolve(ROOT, OUT), { recursive: true }).catch(() => {});
    await writeFile(resolve(ROOT, OUT, `h${hour}-${name}.png`), buf);
  }
}
await browser.close(); server.close();
console.log(`GPU: ${gpu}   load: ${loadS.toFixed(2)}s   (anti-sun bearing, level, 150 m)`);
console.log('hour  case   mean     sat    gSmall  grad   top->bot');
for (const r of rows) console.log(`${String(r.hour).padEnd(5)} ${r.name.padEnd(6)} ${r.mean} ${String(r.sat).padEnd(6)} ${String(r.gSmall).padStart(5)}% ${String(r.grad).padStart(6)}  ${r.top}->${r.bot}`);
