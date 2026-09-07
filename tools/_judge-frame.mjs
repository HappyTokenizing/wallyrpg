#!/usr/bin/env node
/* ============================================================
   _judge-frame.mjs — JUDGE'S OWN rendered-frame sampler.

   Same measured quantities as tools/_sky-minute.mjs so the numbers
   are comparable with the ones in lighting.js's comments, but:

     · times are a LIST and may be FRACTIONAL minutes, because the
       dense state scan (tools/_judge-sky.mjs) puts the true extrema
       at 07:38.30 and 17:19.40, which no integer-minute grid visits;
     · it renders both bearings for every sample by default;
     · --repeat N re-renders the whole plan N times so the cloud-drift
       noise is measured in the same run rather than quoted.

   Rules run minute-major / rule-minor on ONE page load so drift is
   common-mode; HEAD comes from --swap-head (a real HEAD checkout of
   src/world/lighting.js, restored in a finally).

   usage:
     node tools/_judge-frame.mjs --times 7:38,7:38.3,17:19.4 \
       --rules prev,ship --modes anti,sun --out shots/_jf --json x.json
     node tools/_judge-frame.mjs --times ... --swap-head
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
const mins = (s) => { const p = String(s).split(':'); return (+p[0]) * 60 + (+(p[1] ?? 0)); };
const tag = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}${String(Math.floor(m % 60)).padStart(2, '0')}${(m % 1) ? 'p' + Math.round((m % 1) * 100) : ''}`;
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}${(m % 1) ? '.' + String(Math.round((m % 1) * 100)).padStart(2, '0') : ''}`;

const W = +arg('w', 960), H = +arg('h', 540);
let TIMES = [];
const tArg = arg('times', null);
if (tArg) TIMES = tArg.split(',').map(mins);
/* --range from,to,step — COMMA separated, because a time contains a
   colon and the first draft of this line split on ':' and silently
   produced a one-sample plan that looked like a finished sweep. */
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] !== '--range') continue;
  const [a, b, st] = String(process.argv[i + 1] || '').split(',');
  if (a == null || b == null || !(+st > 0)) { console.error(`--range wants from,to,step (got "${process.argv[i + 1]}")`); process.exit(2); }
  for (let m = mins(a); m <= mins(b) + 1e-9; m += (+st)) TIMES.push(+m.toFixed(3));
}
if (!TIMES.length) TIMES = [mins('7:38')];
const SWAP = has('swap-head');
const RULES = SWAP ? ['head'] : arg('rules', 'ship').split(',');
const MODES = arg('modes', 'anti,sun').split(',');
const REPEAT = +arg('repeat', 1);
const SETTLE = +arg('settle', 8);
const SHOTMODE = has('png');   /* also screenshot + measure the PNG, to prove the fast path */
const OUTPNG = arg('out', null);
const JSONOUT = arg('json', null);

let backup = null;
if (SWAP) {
  backup = join(tmpdir(), `judgeframe.lighting.${process.pid}.js`);
  await copyFile(LIGHTING, backup);
  console.log(`# backup ${backup}`);
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

let browser = null; const results = []; let env = null, loadS = 0; const logs = [];
try {
  browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'] });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') logs.push(`[error] ${m.text()}`); });
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__WALLY_READY__ === true', { timeout: 90000 });
  loadS = (Date.now() - t0) / 1000;
  env = await page.evaluate(() => {
    const gl = WALLY.ctx.renderer.getContext();
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return { gpu: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?', tier: WALLY.ctx.quality?.name || '?', weather: WALLY.ctx.sky.weatherName, hasRule: typeof WALLY.debug.skyRule === 'function' };
  });
  await page.evaluate(() => { for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.display = 'none'; });
  const settle = (k) => page.evaluate((kk) => new Promise(r => { let n = 0; const t = () => (++n > kk ? r() : requestAnimationFrame(t)); requestAnimationFrame(t); }), k);

  /* same camera as tools/_sky-minute.mjs: 150 m, dead level, sun or
     anti-sun bearing — so these numbers sit next to that rig's */
  const aim = ([hh, flip, rule]) => {
    if (rule && rule !== 'head' && WALLY.debug.skyRule) WALLY.debug.skyRule(rule);
    WALLY.debug.setHour(hh);
    const { ctx } = WALLY;
    ctx.cam?.setEnabled?.(false);
    const cam = ctx.camera, d = ctx.sky.sunDirection;
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
    const y1 = Math.max(2, Math.min(h - 2, Math.floor(horizonY) - 10)), y0 = 2;
    if (y1 - y0 < 20) return null;
    let R = 0, G = 0, B = 0, n = 0, gs = 0;
    const rows = [];
    for (let y = y0; y <= y1; y++) {
      let rr = 0, gg = 0, bb = 0, m = 0;
      for (let x = 0; x < w; x += 2) {
        const o = (y * w + x) * 4, r = d[o], gv = d[o + 1], b = d[o + 2];
        rr += r; gg += gv; bb += b; m++; R += r; G += gv; B += b; n++;
        if (gv < r && gv < b) gs++;
      }
      rows.push([rr / m, gg / m, bb / m]);
    }
    const nb = Math.max(2, Math.round(rows.length * 0.06));
    const avg = (a, s, e) => { let r = 0, g2 = 0, b = 0; for (let i = s; i < e; i++) { r += a[i][0]; g2 += a[i][1]; b += a[i][2]; } const k = e - s; return [r / k, g2 / k, b / k]; };
    const top = avg(rows, 0, nb), bot = avg(rows, rows.length - nb, rows.length);
    const grad = Math.abs(top[0] - bot[0]) + Math.abs(top[1] - bot[1]) + Math.abs(top[2] - bot[2]);
    const hex = (a) => '#' + a.map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
    const mean = [R / n, G / n, B / n];
    const satOf = (a) => { const x = Math.max(...a), y = Math.min(...a); return +(x > 0 ? (x - y) / x : 0).toFixed(3); };
    const hueOf = (a) => { const [r, g2, b] = a, mx = Math.max(r, g2, b), mn = Math.min(r, g2, b), dd = mx - mn; if (dd < 0.5) return -1; let hh = mx === r ? ((g2 - b) / dd) % 6 : mx === g2 ? (b - r) / dd + 2 : (r - g2) / dd + 4; return +(((hh * 60) % 360 + 360) % 360).toFixed(0); };
    const k18 = Math.max(2, Math.round(rows.length * 0.18));
    const bandMean = avg(rows, rows.length - k18, rows.length), zenMean = avg(rows, 0, k18);
    /* green-smallest measured on the BAND ROWS ALONE as well: the
       whole-column figure is diluted by a zenith that is never
       magenta, so it understates a magenta band by ~5x */
    let gsB = 0, nB = 0;
    for (let y = y1 - k18 + 1; y <= y1; y++) for (let x = 0; x < w; x += 2) { const o = (y * w + x) * 4; nB++; if (d[o + 1] < d[o] && d[o + 1] < d[o + 2]) gsB++; }
    return { mean: hex(mean), sat: satOf(mean), bandSat: satOf(bandMean), zenSat: satOf(zenMean), band: hex(bandMean), bandHue: hueOf(bandMean), gSmall: +(100 * gs / n).toFixed(1), gSmallBand: +(100 * gsB / nB).toFixed(1), grad: +grad.toFixed(1), top: hex(top), bot: hex(bot) };
  };


  /* ------------------------------------------------------------------
     THE FAST PATH, AND WHY IT IS NOT A SHORTCUT.

     Screenshot -> base64 -> createImageBitmap costs ~7 s a sample on
     this machine, which is why every sweep in this project so far has
     been on a ten-minute grid: the grid was chosen by the rig's
     throughput, not by the defect. So the frame is measured where it
     is drawn — ctx.render.render() composes into the default
     framebuffer and gl.readPixels reads it back in the SAME task,
     before the compositor can clear it. Nothing but the aggregated
     numbers crosses the CDP boundary.

     --png runs BOTH paths on every sample and prints the difference,
     which is how this path was proved equivalent rather than assumed
     to be. */
  const FAST = ([horizonY, wantPng]) => {
    const { ctx } = WALLY;
    const r = ctx.renderer;
    ctx.render.render();
    const gl = r.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    r.setRenderTarget(null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    /* readPixels is bottom-up; horizonY is a top-down CSS y. The
       drawing buffer may be a devicePixelRatio multiple of CSS px. */
    const sc = h / window.innerHeight;
    const y1css = Math.max(2, Math.min(h / sc - 2, Math.floor(horizonY) - 10)), y0css = 2;
    if (y1css - y0css < 20) return null;
    let R = 0, G = 0, B = 0, n = 0, gs = 0;
    const rows = [];
    for (let yc = y0css; yc <= y1css; yc++) {
      const yb = Math.round(h - 1 - yc * sc);           /* flip */
      if (yb < 0 || yb >= h) continue;
      let rr = 0, gg = 0, bb = 0, m = 0;
      for (let x = 0; x < w; x += Math.max(1, Math.round(2 * sc))) {
        const o = (yb * w + x) * 4, rv = px[o], gv = px[o + 1], bv = px[o + 2];
        rr += rv; gg += gv; bb += bv; m++; R += rv; G += gv; B += bv; n++;
        if (gv < rv && gv < bv) gs++;
      }
      rows.push([rr / m, gg / m, bb / m]);
    }
    if (rows.length < 20) return null;
    const nb = Math.max(2, Math.round(rows.length * 0.06));
    const avg = (a, s, e) => { let r2 = 0, g2 = 0, b2 = 0; for (let i = s; i < e; i++) { r2 += a[i][0]; g2 += a[i][1]; b2 += a[i][2]; } const k = e - s; return [r2 / k, g2 / k, b2 / k]; };
    const top = avg(rows, 0, nb), bot = avg(rows, rows.length - nb, rows.length);
    const grad = Math.abs(top[0] - bot[0]) + Math.abs(top[1] - bot[1]) + Math.abs(top[2] - bot[2]);
    const hex = (a) => '#' + a.map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
    const mean = [R / n, G / n, B / n];
    const satOf = (a) => { const x = Math.max(...a), y = Math.min(...a); return +(x > 0 ? (x - y) / x : 0).toFixed(3); };
    const hueOf = (a) => { const [rr, g2, b] = a, mx = Math.max(rr, g2, b), mn = Math.min(rr, g2, b), dd = mx - mn; if (dd < 0.5) return -1; let hh = mx === rr ? ((g2 - b) / dd) % 6 : mx === g2 ? (b - rr) / dd + 2 : (rr - g2) / dd + 4; return +(((hh * 60) % 360 + 360) % 360).toFixed(0); };
    const k18 = Math.max(2, Math.round(rows.length * 0.18));
    const bandMean = avg(rows, rows.length - k18, rows.length), zenMean = avg(rows, 0, k18);
    let gsB = 0, nB = 0;
    for (let i = rows.length - k18; i < rows.length; i++) {
      const yb = Math.round(h - 1 - (y0css + i) * sc);
      if (yb < 0 || yb >= h) continue;
      for (let x = 0; x < w; x += Math.max(1, Math.round(2 * sc))) { const o = (yb * w + x) * 4; nB++; if (px[o + 1] < px[o] && px[o + 1] < px[o + 2]) gsB++; }
    }
    return { mean: hex(mean), sat: satOf(mean), bandSat: satOf(bandMean), zenSat: satOf(zenMean), band: hex(bandMean), bandHue: hueOf(bandMean), gSmall: +(100 * gs / n).toFixed(1), gSmallBand: nB ? +(100 * gsB / nB).toFixed(1) : -1, grad: +grad.toFixed(1), top: hex(top), bot: hex(bot) };
  };

  const PLAN = [];
  for (let rep = 0; rep < REPEAT; rep++) for (const m of TIMES) for (const rule of RULES) PLAN.push([m, rule, rep]);
  for (const [m, rule, rep] of PLAN) {
    for (const mode of MODES) {
      await page.evaluate(aim, [m / 60, mode === 'anti', SWAP ? null : rule]);
      await settle(SETTLE);
      const info = await page.evaluate(() => {
        const { ctx, THREE } = WALLY, cam = ctx.camera;
        const f = new THREE.Vector3(); cam.getWorldDirection(f); f.y = 0; f.normalize();
        const p = new THREE.Vector3().copy(cam.position).addScaledVector(f, 100000).project(cam);
        const L = ctx.sky.lighting;
        return { horizonY: (1 - (p.y * 0.5 + 0.5)) * window.innerHeight, dawn: +L.dawn.toFixed(3), haze: '#' + L.fogOut.getHexString(THREE.SRGBColorSpace).toUpperCase(), hor: '#' + L.horizonOut.getHexString(THREE.SRGBColorSpace).toUpperCase(), grade: L.grade };
      });
      const st = await page.evaluate(FAST, [info.horizonY, false]);
      let cmp = null;
      if (OUTPNG || SHOTMODE) {
        const buf = await page.screenshot({ animations: 'allow', timeout: 30000 });
        if (SHOTMODE) {
          const st2 = await page.evaluate(MEASURE, [`data:image/png;base64,${buf.toString('base64')}`, info.horizonY]);
          cmp = { png: st2, dSat: +(st2.sat - st.sat).toFixed(4), dBand: +(st2.bandSat - st.bandSat).toFixed(4), dGs: +(st2.gSmall - st.gSmall).toFixed(2), dGrad: +(st2.grad - st.grad).toFixed(2) };
        }
        if (OUTPNG) { await mkdir(resolve(ROOT, OUTPNG), { recursive: true }).catch(() => {}); await writeFile(resolve(ROOT, OUTPNG, `${rule}-${tag(m)}-${mode}${REPEAT > 1 ? '-r' + rep : ''}.png`), buf); }
      }
      results.push({ m, time: hhmm(m), rule, mode, rep, ...st, state: info, cmp });
    }
  }
} finally {
  if (browser) await browser.close();
  server.close();
  if (SWAP && backup) { await copyFile(backup, LIGHTING); console.log('# lighting.js restored'); }
}
console.log(`GPU ${env?.gpu} tier ${env?.tier} weather ${env?.weather} load ${loadS.toFixed(1)}s ${W}x${H} rules ${RULES.join(',')}${SWAP ? ' (HEAD SWAP)' : ''}`);
console.log('time      rule  mode  mean     sat   bandSat band     hue  gS%   gSband%  grad  dawn  grade   haze');
for (const r of results) {
  if (!r.mean) { console.log(`${r.time} ${r.rule} ${r.mode} FAILED`); continue; }
  console.log(`${r.time.padEnd(9)} ${r.rule.padEnd(5)} ${r.mode.padEnd(4)} ${r.mean} ${String(r.sat).padEnd(5)} ${String(r.bandSat).padEnd(6)}  ${r.band} ${String(r.bandHue).padStart(4)} ${String(r.gSmall).padStart(5)} ${String(r.gSmallBand).padStart(7)} ${String(r.grad).padStart(6)} ${String(r.state.dawn).padEnd(5)} ${r.state.grade.padEnd(6)} ${r.state.haze}`);
}
if (JSONOUT) await writeFile(JSONOUT, JSON.stringify({ env, loadS, swapHead: SWAP, results }, null, 1));
if (SHOTMODE) {
  const d = results.filter(r => r.cmp);
  const mx = (k) => d.reduce((p, c) => Math.max(p, Math.abs(c.cmp[k])), 0);
  console.log(`# readPixels vs screenshot over ${d.length} samples: max |dSat| ${mx('dSat')}  max |dBandSat| ${mx('dBand')}  max |dgSmall| ${mx('dGs')}  max |dGrad| ${mx('dGrad')}`);
}
if (logs.length) console.log('--- page errors ---\n' + logs.slice(0, 8).join('\n'));
