#!/usr/bin/env node
/* ============================================================
   _sky-table.mjs — per-hour sky measurement.

   For every hour it points the camera at the sun's bearing and at the
   opposite bearing, both dead level, screenshots the FINAL composited
   frame (ACES + grade + bloom + vignette + grain all included, because
   that is what a player sees), and measures three things over the sky
   region only:

     mean       the average sky colour
     gSmall     % of sky pixels whose GREEN is the smallest channel
                (the magenta tell — see THE DAWN STOP in sky.js)
     grad       sum |top row - row just above the horizon| over rgb,
                out of 765. This is the number that separates a sky
                from a lid.

   The horizon row is PROJECTED from the live camera each shot, never
   assumed to be the middle of the frame.

   usage: node tools/_sky-table.mjs [--hours 16,17,18] [--out shots/x]
          [--json /tmp/a.json] [--w 960] [--h 540]
   ============================================================ */

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };

function arg(n, f) { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : f; }

const W = +arg('w', 960), H = +arg('h', 540);
const HOURS = arg('hours', '0,3,5,6,7,8,9,10,12,13,14,15,16,16.5,17,17.5,18,19,20,21,22')
  .split(',').map(Number);
const MODES = arg('modes', 'sun,anti').split(',');
const OUTPNG = arg('out', null);
const JSONOUT = arg('json', null);

const server = createServer(async (req, res) => {
  try {
    const clean = decodeURIComponent(req.url.split('?')[0]);
    const p = join(ROOT, clean === '/' ? 'index.html' : clean);
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404).end('nf'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}`));
page.on('console', m => { if (m.type() === 'error') logs.push(`[error] ${m.text()}`); });

const t0 = Date.now();
await page.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__ === true', null, { timeout: 90000 });
const loadS = (Date.now() - t0) / 1000;

/* ---- WHAT THIS RUN IS ACTUALLY RUNNING ON. Measured here, at the
   moment of use, because "60 fps" and even "what colour is that"
   mean different things on SwiftShader than on a real GPU. ---- */
const env = await page.evaluate(() => {
  const gl = WALLY.ctx.renderer.getContext();
  const d = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    gpu: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown',
    tier: WALLY.ctx.quality.name || 'high',
    perf: window.__WALLY_PERF__ || null,
  };
});

const settle = () => page.evaluate(() => new Promise(r => {
  let n = 0; const t = () => (++n > 24 ? r() : requestAnimationFrame(t)); requestAnimationFrame(t);
}));

/* The HUD is DOM over the canvas and its pills are dark grey — left in
   frame they walk the mean and the green-smallest count. */
await page.evaluate(() => {
  for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.display = 'none';
});

/* THE CAMERA THIS TABLE IS MEASURED FROM, and why it is not skyCam().
   skyCam sits at y = 24 inside the city: at most bearings the frame is
   a wall, and 'sky pixels above the horizon row' were terracotta roof.
   150 m is above every building and below the lowest cloud deck (210 m,
   clouds.js), so a dead-level look gives horizon exactly at frame
   centre with nothing but sky above it. The dome follows the camera and
   is a function of direction only, so its colours are identical to
   those at eye level — only the occluders are gone. */
const aim = ([hh, flip]) => {
  WALLY.debug.setHour(hh);
  const { ctx, THREE } = WALLY;
  ctx.cam?.setEnabled?.(false);
  const cam = ctx.camera;
  const d = ctx.sky.sunDirection;
  const az = Math.atan2(d.x, d.z) + (flip ? Math.PI : 0);
  cam.position.set(0, 150, 0);
  cam.lookAt(Math.sin(az) * 4000, 150, Math.cos(az) * 4000);
  cam.updateMatrixWorld();
  return +(az * 180 / Math.PI).toFixed(1);
};

const MEASURE = async ([url, horizonY]) => {
  const bmp = await createImageBitmap(await (await fetch(url)).blob());
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const w = bmp.width, h = bmp.height;
  const d = g.getImageData(0, 0, w, h).data;
  const y1 = Math.max(2, Math.min(h - 2, Math.floor(horizonY) - 10));   // last sky row
  const y0 = 2;
  if (y1 - y0 < 20) return null;
  let R = 0, G = 0, B = 0, n = 0, gs = 0;
  const rows = [];
  for (let y = y0; y <= y1; y++) {
    let rr = 0, gg = 0, bb = 0, m = 0;
    for (let x = 0; x < w; x += 2) {
      const o = (y * w + x) * 4;
      const r = d[o], gv = d[o + 1], b = d[o + 2];
      rr += r; gg += gv; bb += b; m++;
      R += r; G += gv; B += b; n++;
      if (gv < r && gv < b) gs++;
    }
    rows.push([rr / m, gg / m, bb / m]);
  }
  const nb = Math.max(2, Math.round(rows.length * 0.06));
  const avg = (a, s, e) => { let r = 0, g2 = 0, b = 0; for (let i = s; i < e; i++) { r += a[i][0]; g2 += a[i][1]; b += a[i][2]; } const k = e - s; return [r / k, g2 / k, b / k]; };
  const top = avg(rows, 0, nb), bot = avg(rows, rows.length - nb, rows.length);
  const grad = Math.abs(top[0] - bot[0]) + Math.abs(top[1] - bot[1]) + Math.abs(top[2] - bot[2]);
  const hex = (a) => '#' + a.map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  /* HSV saturation of the mean, gamma space — the "is it a colour or a
     wash" number §2.1 cares about. */
  const mean = [R / n, G / n, B / n];
  const mx = Math.max(...mean), mn = Math.min(...mean);
  return {
    mean: hex(mean), meanRGB: mean.map(v => +v.toFixed(1)),
    sat: +(mx > 0 ? (mx - mn) / mx : 0).toFixed(3),
    gSmall: +(100 * gs / n).toFixed(1),
    grad: +grad.toFixed(1),
    top: hex(top), bot: hex(bot),
    rows: rows.filter((_, i) => i % Math.max(1, Math.floor(rows.length / 12)) === 0).map(hex),
    horizonY: Math.round(horizonY),
  };
};

const results = [];
for (const hour of HOURS) {
  for (const mode of MODES) {
    await page.evaluate(aim, [hour, mode === 'anti']);
    await settle();
    const info = await page.evaluate(() => {
      const { ctx, THREE } = WALLY;
      const cam = ctx.camera;
      const f = new THREE.Vector3(); cam.getWorldDirection(f);
      f.y = 0; f.normalize();
      const p = new THREE.Vector3().copy(cam.position).addScaledVector(f, 100000).project(cam);
      const sky = WALLY.debug.sky();
      const L = ctx.sky.lighting;
      return {
        horizonY: (1 - (p.y * 0.5 + 0.5)) * window.innerHeight,
        sky, dawn: +L.dawn.toFixed(3), horizonGlow: +L.horizonGlow.toFixed(3),
        bandPow: +ctx.sky.uniforms.uBandPow.value.toFixed(2),
        bandWidth: +ctx.sky.uniforms.uBandWidth.value.toFixed(3),
        dawnAmt: +ctx.sky.uniforms.uDawnAmt.value.toFixed(3),
        haze: '#' + L.fogOut.getHexString(THREE.SRGBColorSpace).toUpperCase(),
        zen: '#' + L.skyOut.getHexString(THREE.SRGBColorSpace).toUpperCase(),
        hor: '#' + L.horizonOut.getHexString(THREE.SRGBColorSpace).toUpperCase(),
        dmid: '#' + L.dawnMid.getHexString(THREE.SRGBColorSpace).toUpperCase(),
      };
    });
    const buf = await page.screenshot({ animations: 'allow', timeout: 30000 });
    const url = `data:image/png;base64,${buf.toString('base64')}`;
    const st = await page.evaluate(MEASURE, [url, info.horizonY]);
    results.push({ hour, mode, ...st, state: info });
    if (OUTPNG) {
      await mkdir(resolve(ROOT, OUTPNG), { recursive: true }).catch(() => {});
      await writeFile(resolve(ROOT, OUTPNG, `h${String(hour).replace('.', '_')}-${mode}.png`), buf);
    }
  }
}

await browser.close();
server.close();

console.log(`GPU: ${env.gpu}   tier: ${env.tier}   load: ${loadS.toFixed(2)}s   perf: ${JSON.stringify(env.perf)}`);
console.log('hour  mode  mean     sat   gSmall  grad   top->bot            dawn  hglow bandPow haze     zen      grade');
for (const r of results) {
  if (!r.mean) { console.log(`${r.hour} ${r.mode} FAILED`); continue; }
  console.log(
    `${String(r.hour).padEnd(5)} ${r.mode.padEnd(5)} ${r.mean} ${String(r.sat).padEnd(5)} ` +
    `${String(r.gSmall).padStart(5)}% ${String(r.grad).padStart(6)}  ${r.top}->${r.bot}  ` +
    `${String(r.state.dawn).padEnd(5)} ${String(r.state.horizonGlow).padEnd(5)} ${String(r.state.bandPow).padEnd(5)}  ` +
    `${r.state.haze} ${r.state.zen} ${r.state.sky.grade}`);
}
if (JSONOUT) await writeFile(JSONOUT, JSON.stringify({ env, loadS, results }, null, 1));
if (logs.length) console.log('--- page errors ---\n' + logs.slice(0, 10).join('\n'));
