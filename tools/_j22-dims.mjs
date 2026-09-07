#!/usr/bin/env node
/* ============================================================
   _j22-dims.mjs — ROUND 6 JUDGE, part 3. THE DIMENSIONS NOTHING IN
   THIS REPO HAS EVER SAMPLED.

   Every sky number in src/world/lighting.js, and every number
   tools/_sky-minute.mjs prints, comes off ONE configuration:

     · quality high, weather clear;
     · TWO bearings (anti and sun), so the dome is sampled at two of
       360 degrees;
     · a camera at 150 m over open water with nothing in frame;
     · and a MEAN over the whole sky column, which is a statistic that
       cannot tell "the sky is one pale colour" from "the sky is pale
       here and blue there".

   contracts.js rule 3 says a claim measured in one configuration is a
   claim about that configuration. So:

   --plan bearings   16 bearings at 22.5 deg, both crossings, three
                     rules. Also reports SPREAD: the sky column is cut
                     into 8 vertical slices and bandSat is measured per
                     slice, so a dome that is pale in one sector and
                     coloured in another cannot hide inside its mean.
   --plan band       BANDING. Nothing in this repo has ever measured
                     contouring in the SKY (tools/_sky-envelope.mjs
                     measures it on the balloon only). A crossing that
                     works by dropping chroma to 0.056 and lifting
                     value toward 0.96 is exactly a bright near-neutral
                     vertical ramp across 500 px, which is the textbook
                     8-bit contouring case. Measured on the row-median
                     luma profile (medians kill the grain, so what is
                     left is the quantisation): the longest flat run in
                     rows, and the largest row-to-row step.
   --plan weather    clear / cloudy / rain / storm. NOTE: the axis
                     _sky-minute.mjs documents as "storm|overcast|
                     clear" has no `overcast` state — weather.js
                     authors clear/cloudy/rain/storm — so a run asking
                     for overcast silently measures clear.
   --plan tier       low / med / high / ultra, one page load each.
   --plan balloon    boarded, 260 m, envelope in frame.
   --plan interior   camera inside a building looking out.

   usage: node tools/_j22-dims.mjs --plan bearings [--out shots/_j22d]
   ============================================================ */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };
const arg = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : f; };
const PLAN = arg('plan', 'bearings');
const OUT = arg('out', null);
const RULES = arg('rules', 'prev,warp,ship').split(',');
const HOURS = arg('hours', '7.65,17.32').split(',').map(Number);   /* 07:39 and 17:19 */
const W = +arg('w', 960), H = +arg('h', 540);
const hhmm = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;

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

/* ---------- the in-page measurement. Sky-region definitions are the
   SAME as tools/_sky-minute.mjs so the numbers are comparable, with
   two additions: per-slice bandSat (spatial) and the row-median luma
   profile (banding). ---------- */
const MEASURE = async ([url, horizonY]) => {
  const bmp = await createImageBitmap(await (await fetch(url)).blob());
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const w = bmp.width, h = bmp.height;
  const d = g.getImageData(0, 0, w, h).data;
  const y1 = Math.max(2, Math.min(h - 2, Math.floor(horizonY) - 10)), y0 = 2;
  if (y1 - y0 < 20) return null;
  const satOf = (a) => { const x = Math.max(...a), y = Math.min(...a); return +(x > 0 ? (x - y) / x : 0).toFixed(3); };
  const hex = (a) => '#' + a.map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();

  /* rows, whole width */
  const rows = [], rowMed = [];
  let R = 0, G = 0, B = 0, n = 0, gs = 0;
  const SL = 8, slice = Array.from({ length: SL }, () => []);
  for (let y = y0; y <= y1; y++) {
    let rr = 0, gg = 0, bb = 0, m = 0;
    const lum = [];
    const sacc = Array.from({ length: SL }, () => [0, 0, 0, 0]);
    for (let x = 0; x < w; x += 2) {
      const o = (y * w + x) * 4;
      const r = d[o], gv = d[o + 1], b = d[o + 2];
      rr += r; gg += gv; bb += b; m++; R += r; G += gv; B += b; n++;
      if (gv < r && gv < b) gs++;
      lum.push(0.2126 * r + 0.7152 * gv + 0.0722 * b);
      const si = Math.min(SL - 1, Math.floor(x / w * SL));
      sacc[si][0] += r; sacc[si][1] += gv; sacc[si][2] += b; sacc[si][3]++;
    }
    rows.push([rr / m, gg / m, bb / m]);
    for (let i = 0; i < SL; i++) slice[i].push([sacc[i][0] / sacc[i][3], sacc[i][1] / sacc[i][3], sacc[i][2] / sacc[i][3]]);
    lum.sort((a, b) => a - b);
    rowMed.push(lum[lum.length >> 1]);
  }
  const nb = (a) => Math.max(2, Math.round(a * 0.18));
  const avg = (a, s, e) => { let r = 0, g2 = 0, b = 0; for (let i = s; i < e; i++) { r += a[i][0]; g2 += a[i][1]; b += a[i][2]; } const k = e - s; return [r / k, g2 / k, b / k]; };
  const bandMean = avg(rows, rows.length - nb(rows.length), rows.length);
  const zenMean = avg(rows, 0, nb(rows.length));
  const g6 = Math.max(2, Math.round(rows.length * 0.06));
  const top = avg(rows, 0, g6), bot = avg(rows, rows.length - g6, rows.length);
  const grad = Math.abs(top[0] - bot[0]) + Math.abs(top[1] - bot[1]) + Math.abs(top[2] - bot[2]);

  /* SPATIAL: bandSat per vertical slice of the frame */
  const sliceSat = slice.map(s => satOf(avg(s, s.length - nb(s.length), s.length)));
  const sliceHex = slice.map(s => hex(avg(s, s.length - nb(s.length), s.length)));

  /* BANDING: on the row-median luma profile. A contour is a long flat
     run followed by a step; grain/dither shows up as a run length of 1
     and is therefore invisible to this. */
  let run = 1, maxRun = 1, maxRunAt = 0, maxStep = 0, maxStepAt = 0, levels = 1;
  const q = rowMed.map(v => Math.round(v));
  for (let i = 1; i < q.length; i++) {
    const st = Math.abs(rowMed[i] - rowMed[i - 1]);
    if (st > maxStep) { maxStep = st; maxStepAt = i; }
    if (q[i] === q[i - 1]) run++;
    else { if (run > maxRun) { maxRun = run; maxRunAt = i - 1; } run = 1; levels++; }
  }
  if (run > maxRun) { maxRun = run; maxRunAt = q.length - 1; }
  const span = Math.abs(rowMed[rowMed.length - 1] - rowMed[0]);

  const mean = [R / n, G / n, B / n];
  return {
    mean: hex(mean), sat: satOf(mean), bandSat: satOf(bandMean), band: hex(bandMean),
    zenSat: satOf(zenMean), gSmall: +(100 * gs / n).toFixed(1), grad: +grad.toFixed(1),
    sliceSat, sliceHex, spread: +(Math.max(...sliceSat) - Math.min(...sliceSat)).toFixed(3),
    rows: rows.length, bandRGB: bandMean.map(v => +v.toFixed(2)),
    maxRun, maxRunAt, maxStep: +maxStep.toFixed(2), maxStepAt, levels, lumSpan: +span.toFixed(1),
    bandPx: +(maxRun / rows.length * 100).toFixed(1),
  };
};

const results = [];
let env = null;

async function runLoad(query, plan) {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'] });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${PORT}/index.html?shot=1${query}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__WALLY_READY__ === true', { timeout: 120000 });
  const loadS = (Date.now() - t0) / 1000;
  env = await page.evaluate(() => {
    const gl = WALLY.ctx.renderer.getContext();
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return { gpu: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?', tier: WALLY.ctx.quality.name,
      hasBalloon: typeof WALLY.debug.balloon === 'function',
      hasWeather: typeof WALLY.debug.setWeather === 'function',
      worldKeys: Object.keys(WALLY.ctx.world || {}) };
  });
  await page.evaluate(() => { for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.display = 'none'; });
  const settle = () => page.evaluate(() => new Promise(r => { let n = 0; const t = () => (++n > 20 ? r() : requestAnimationFrame(t)); requestAnimationFrame(t); }));

  /* aim: az is an ABSOLUTE bearing offset from the sun's own azimuth */
  const aim = ([hh, offDeg, rule, wx, mode]) => {
    if (rule && WALLY.debug.skyRule) WALLY.debug.skyRule(rule);
    if (wx) { const ok = WALLY.debug.setWeather(wx, 0); if (!ok) return { bad: wx }; }
    WALLY.debug.setHour(hh);
    const { ctx } = WALLY;
    ctx.cam?.setEnabled?.(false);
    const cam = ctx.camera;
    const d = ctx.sky.sunDirection;
    const az = Math.atan2(d.x, d.z) + offDeg * Math.PI / 180;
    let eye = [0, 150, 0];
    if (mode === 'balloon') { WALLY.debug.balloon({ alt: 260 }); const p = ctx.wally.position; eye = [p.x - Math.sin(az) * 30, p.y + 8, p.z - Math.cos(az) * 30]; }
    if (mode === 'interior' && WALLY.__j22_interior) eye = WALLY.__j22_interior;
    cam.position.set(eye[0], eye[1], eye[2]);
    cam.lookAt(eye[0] + Math.sin(az) * 4000, eye[1], eye[2] + Math.cos(az) * 4000);
    cam.updateMatrixWorld();
    return { az: +(az * 180 / Math.PI).toFixed(1), wx: ctx.sky.weather?.name ?? WALLY.debug.sky?.().weather };
  };

  for (const job of plan) {
    const st0 = await page.evaluate(aim, [job.hour, job.off, job.rule, job.weather || null, job.mode || null]);
    if (st0 && st0.bad) { console.log(`!! weather state "${st0.bad}" REJECTED by weather.js — no such preset`); continue; }
    await settle();
    const info = await page.evaluate(() => {
      const { ctx, THREE } = WALLY;
      const cam = ctx.camera; const f = new THREE.Vector3(); cam.getWorldDirection(f); f.y = 0; f.normalize();
      const p = new THREE.Vector3().copy(cam.position).addScaledVector(f, 100000).project(cam);
      const L = ctx.sky.lighting;
      return { horizonY: (1 - (p.y * 0.5 + 0.5)) * window.innerHeight,
        hor: '#' + L.horizonOut.getHexString(THREE.SRGBColorSpace).toUpperCase(),
        wx: WALLY.debug.sky().weather, cloud: WALLY.debug.sky().cloud };
    });
    const buf = await page.screenshot({ animations: 'allow', timeout: 30000 });
    const st = await page.evaluate(MEASURE, [`data:image/png;base64,${buf.toString('base64')}`, info.horizonY]);
    results.push({ ...job, ...st, wx: info.wx, cloud: info.cloud, hor: info.hor, az: st0.az, tier: env.tier });
    if (OUT) {
      await mkdir(resolve(ROOT, OUT), { recursive: true }).catch(() => {});
      await writeFile(resolve(ROOT, OUT, `${job.tag}.png`), buf);
    }
  }
  await browser.close();
  return { loadS, errs };
}

let loadInfo = null;
if (PLAN === 'bearings') {
  const plan = [];
  for (const hour of HOURS) for (let i = 0; i < 16; i++) for (const rule of RULES)
    plan.push({ hour, off: i * 22.5, rule, tag: `br-${hhmm(hour).replace(':', '')}-${String(i * 22.5).padStart(5, '0')}-${rule}` });
  loadInfo = await runLoad('', plan);
} else if (PLAN === 'band') {
  const plan = [];
  for (const hour of [7.5, 7.6, 7.65, 7.7, 17.2, 17.3, 17.32, 17.4]) for (const rule of RULES) for (const off of [180, 0])
    plan.push({ hour, off, rule, tag: `bd-${hhmm(hour).replace(':', '')}-${off}-${rule}` });
  loadInfo = await runLoad('', plan);
} else if (PLAN === 'weather') {
  const plan = [];
  for (const weather of ['clear', 'cloudy', 'rain', 'storm', 'overcast']) for (const hour of HOURS) for (const rule of RULES)
    plan.push({ hour, off: 180, rule, weather, tag: `wx-${weather}-${hhmm(hour).replace(':', '')}-${rule}` });
  loadInfo = await runLoad('', plan);
} else if (PLAN === 'tier') {
  for (const q of ['low', 'med', 'high', 'ultra']) {
    const plan = [];
    for (const hour of HOURS) for (const rule of RULES) for (const off of [180, 0])
      plan.push({ hour, off, rule, q, tag: `q-${q}-${hhmm(hour).replace(':', '')}-${off}-${rule}` });
    loadInfo = await runLoad(`&quality=${q}`, plan);
  }
} else if (PLAN === 'balloon') {
  const plan = [];
  for (const hour of HOURS) for (const rule of RULES) for (const off of [180, 0])
    plan.push({ hour, off, rule, mode: 'balloon', tag: `bl-${hhmm(hour).replace(':', '')}-${off}-${rule}` });
  loadInfo = await runLoad('', plan);
}

console.log(`rig: node ${process.version} + playwright chrome, ${W}x${H}, GPU ${env?.gpu}, tier ${env?.tier}, ` +
  `load ${loadInfo?.loadS?.toFixed(1)}s, plan=${PLAN}, la=${(await import('node:os')).loadavg().map(v => v.toFixed(1)).join('/')}`);
if (env?.worldKeys) console.log(`ctx.world keys: ${env.worldKeys.join(',')}`);

if (PLAN === 'bearings') {
  console.log('\nhour   rule  | bandSat by bearing (0=toward sun, 180=anti), 22.5 deg steps        | min   max   range  worst-slice-spread');
  for (const hour of HOURS) for (const rule of RULES) {
    const rs = results.filter(r => r.hour === hour && r.rule === rule).sort((a, b) => a.off - b.off);
    const v = rs.map(r => r.bandSat);
    console.log(`${hhmm(hour)}  ${rule.padEnd(5)}| ${v.map(x => x.toFixed(2)).join(' ')} | ${Math.min(...v).toFixed(3)} ${Math.max(...v).toFixed(3)} ` +
      `${(Math.max(...v) - Math.min(...v)).toFixed(3)}   ${Math.max(...rs.map(r => r.spread)).toFixed(3)}`);
  }
  console.log('\ngSmall % by bearing (the magenta tell) — anything above ~10 is a lid in that sector');
  for (const hour of HOURS) for (const rule of RULES) {
    const rs = results.filter(r => r.hour === hour && r.rule === rule).sort((a, b) => a.off - b.off);
    console.log(`${hhmm(hour)}  ${rule.padEnd(5)}| ${rs.map(r => String(r.gSmall).padStart(5)).join('')}`);
  }
} else if (PLAN === 'band') {
  console.log('\nBANDING on the row-median luma profile of the sky column');
  console.log('hour   off  rule  | rows  lumSpan  levels  longest-flat-run(px / % of column)  max-row-step  band     bandSat');
  for (const r of results) console.log(`${hhmm(r.hour)}  ${String(r.off).padStart(3)}  ${r.rule.padEnd(5)}| ${String(r.rows).padStart(4)} ` +
    `${String(r.lumSpan).padStart(7)}  ${String(r.levels).padStart(6)}  ${String(r.maxRun).padStart(10)} px / ${String(r.bandPx).padStart(4)}%      ` +
    `${String(r.maxStep).padStart(6)}      ${r.band}  ${r.bandSat}`);
} else {
  console.log('\ntag                          wx      cloud  bandSat band     sat    gSmall  grad   spread  flatRun%  maxStep');
  for (const r of results) console.log(`${r.tag.padEnd(28)} ${String(r.wx).padEnd(7)} ${String(r.cloud).padEnd(6)} ` +
    `${String(r.bandSat).padEnd(6)}  ${r.band}  ${String(r.sat).padEnd(6)} ${String(r.gSmall).padStart(5)}% ${String(r.grad).padStart(6)} ` +
    `${String(r.spread).padEnd(6)}  ${String(r.bandPx).padStart(6)}%  ${r.maxStep}`);
}
const J = arg('json', null);
if (J) await writeFile(J, JSON.stringify({ env, plan: PLAN, results }, null, 1));
server.close();
