#!/usr/bin/env node
/* ============================================================
   _judge-ground.mjs — DID THE SKY WORK MOVE THE GROUND?

   The claim under test is "cast shadows and grass are unchanged".
   lighting.js does not touch the key light or the shadow tint, but it
   DOES set scene.fog from the same blend it paints the band with, and
   the hemisphere fill takes the sky colour — so "unchanged" is a
   measurement, not a code reading.

   Camera: a ground-level three-quarter view on Wally, so the frame
   carries lit grass, shaded grass and his cast shadow at once. Same
   framing for every rule and hour; the rules are switched on ONE page
   load so nothing but the rule differs.

   Measured, over the whole frame:
     grassLit / grassShade  mean RGB of green-dominant pixels split at
       the 15th/85th luma percentile — the same construction as
       tools/_grass.py, so the two are comparable.
     shadeRatio  grassShade / grassLit per channel. ART_DIRECTION §2.1
       makes this the shade LAW ("hue shifts toward blue-green in
       shade, never toward black"), and it is the number that has to
       hold if cast shadows are unchanged.
     dark        the 3rd-percentile luma of the frame — where the
       darkest cast shadow sits.

   usage: node tools/_judge-ground.mjs --hours 7,7.638,8,12,17,17.323,18.5 \
            --rules prev,ship [--swap-head] [--out shots/_jg]
   ============================================================ */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIGHTING = join(ROOT, 'src/world/lighting.js');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
const arg = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : f; };
const has = (n) => process.argv.includes(`--${n}`);
const HOURS = arg('hours', '7,7.638,8,12,17,17.323,18.5').split(',').map(Number);
const SWAP = has('swap-head');
const RULES = SWAP ? ['head'] : arg('rules', 'prev,ship').split(',');
const OUT = arg('out', null);
const JSONOUT = arg('json', null);

let backup = null;
if (SWAP) {
  backup = join(tmpdir(), `judgeground.lighting.${process.pid}.js`);
  await copyFile(LIGHTING, backup);
  await writeFile(LIGHTING, execFileSync('git', ['show', 'HEAD:src/world/lighting.js'], { cwd: ROOT, maxBuffer: 1 << 26 }));
  console.log('# HEAD lighting.js swapped in');
}
const server = createServer(async (req, res) => {
  try {
    const c = decodeURIComponent(req.url.split('?')[0]);
    const p = join(ROOT, c === '/' ? 'index.html' : c);
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const b = await readFile(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(b);
  } catch { res.writeHead(404).end('nf'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
let browser = null; const rows = []; let gpu = '?', loadS = 0; const errs = [];
try {
  browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'] });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', e => errs.push(e.message));
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__WALLY_READY__ === true', { timeout: 90000 });
  loadS = (Date.now() - t0) / 1000;
  gpu = await page.evaluate(() => { const gl = WALLY.ctx.renderer.getContext(); const d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?'; });
  await page.evaluate(() => { for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.display = 'none'; });
  const settle = () => page.evaluate(() => new Promise(r => { let n = 0; const t = () => (++n > 10 ? r() : requestAnimationFrame(t)); requestAnimationFrame(t); }));

  const SETUP = ([hh, rule]) => {
    if (rule && rule !== 'head' && WALLY.debug.skyRule) WALLY.debug.skyRule(rule);
    WALLY.debug.setHour(hh);
    const p = WALLY.ctx.wally.position;
    WALLY.debug.lookAt(p.x, p.y, p.z, { dist: 11, az: 128, el: 9, fov: 42 });
    return [p.x.toFixed(1), p.y.toFixed(1), p.z.toFixed(1)];
  };
  const MEASURE = () => {
    const { ctx } = WALLY; const r = ctx.renderer;
    ctx.render.render();
    const gl = r.getContext(); const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4); r.setRenderTarget(null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const G = [], L = [];
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let i = 0; i < w * h; i++) {
      const o = i * 4, R = px[o], g = px[o + 1], B = px[o + 2];
      sr += R; sg += g; sb += B; n++;
      L.push(0.2126 * R + 0.7152 * g + 0.0722 * B);
      if (g > R * 1.12 && g > B * 1.12 && g > 26) G.push([R, g, B, 0.2126 * R + 0.7152 * g + 0.0722 * B]);
    }
    L.sort((a, b) => a - b);
    if (G.length < 3000) return { n: G.length, frame: [sr / n, sg / n, sb / n], dark: L[Math.floor(L.length * 0.03)] };
    const ls = G.map(x => x[3]).sort((a, b) => a - b);
    const lo = ls[Math.floor(ls.length * 0.15)], hi = ls[Math.floor(ls.length * 0.85)];
    const mean = (sel) => { let a = 0, b = 0, c = 0, k = 0; for (const g of G) if (sel(g[3])) { a += g[0]; b += g[1]; c += g[2]; k++; } return k ? [a / k, b / k, c / k, k] : null; };
    return { n: G.length, lit: mean(v => v >= hi), shade: mean(v => v <= lo), frame: [sr / n, sg / n, sb / n], dark: L[Math.floor(L.length * 0.03)] };
  };
  for (const hh of HOURS) for (const rule of RULES) {
    await page.evaluate(SETUP, [hh, rule]);
    await settle();
    const st = await page.evaluate(MEASURE);
    rows.push({ hour: hh, rule, ...st });
    if (OUT) { const buf = await page.screenshot({ animations: 'allow' }); await mkdir(resolve(ROOT, OUT), { recursive: true }).catch(() => {}); await writeFile(resolve(ROOT, OUT, `${rule}-h${String(hh).replace('.', 'p')}.png`), buf); }
  }
} finally { if (browser) await browser.close(); server.close(); if (SWAP && backup) { await copyFile(backup, LIGHTING); console.log('# lighting.js restored'); } }
const f3 = (a) => a ? a.slice(0, 3).map(v => v.toFixed(1)).join(',') : '--';
console.log(`GPU ${gpu} load ${loadS.toFixed(1)}s  rules ${RULES.join(',')}${SWAP ? ' (HEAD SWAP)' : ''}`);
console.log('hour     rule   grassPx  grassLit(RGB)      grassShade(RGB)    shadeRatio R/G/B      dark  frameMean');
for (const r of rows) {
  const rr = (r.lit && r.shade) ? [0, 1, 2].map(i => (r.shade[i] / r.lit[i]).toFixed(3)).join('/') : '--';
  console.log(`${String(r.hour).padEnd(8)} ${r.rule.padEnd(5)} ${String(r.n).padStart(7)}  ${f3(r.lit).padEnd(18)} ${f3(r.shade).padEnd(18)} ${rr.padEnd(20)} ${String(Math.round(r.dark)).padStart(4)}  ${f3(r.frame)}`);
}
if (JSONOUT) await writeFile(JSONOUT, JSON.stringify(rows, null, 1));
if (errs.length) console.log('page errors: ' + errs.slice(0, 4).join(' | '));
