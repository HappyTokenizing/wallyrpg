#!/usr/bin/env node
/* ============================================================
   _judge-sky.mjs — JUDGE'S OWN RIG. Written from scratch so that no
   claim in this review rests on a rig authored by the agent whose
   work is under review.

   WHY IT IS NOT _sky-minute.mjs. That rig renders a frame per sample,
   so a minute is the finest grid it can afford, and the whole history
   of this defect is holes that live between grid points. The colour
   pipeline is a pure function of the hour (fogOut / horizonOut / dawn
   are recomputed from tod every update and none of them is damped —
   only sunI, ambI and exposure are), so it can be sampled as finely
   as arithmetic allows and the extrema FOUND rather than sampled at.

   It drives lighting.update() directly with the SAME wx object
   sky.js passes it — captured by wrapping update() once on boot, so
   the weather state is the live one and not a synthesised clear.

   Reports per sample, all gamma space:
     bandC   chroma of fogOut — THE BAND. This is the colour the dome
             paints at h=0 and the one scene.fog gets; it is where
             every notch in this file's history has lived.
     bandH   its hue in degrees
     horC    chroma of horizonOut (the dome above the band)
     dawn    lighting's own dawn scalar
     cancel  how much chroma a 50/50 of horizonColor and fogColor
             loses — the quantity the shipped band blend keys off
     opp     the old red-minus-blue opposition test
     t       the blend parameter actually used

   usage:
     node tools/_judge-sky.mjs --step 0.05 --from 7:00 --to 10:00 \
          --rules ship,prev,lerp --json /tmp/x.json
     node tools/_judge-sky.mjs --step 0.05 --day --swap-head
   ============================================================ */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIGHTING = join(ROOT, 'src/world/lighting.js');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
const arg = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : f; };
const has = (n) => process.argv.includes(`--${n}`);
const mins = (s) => { const [h, m] = String(s).split(':'); return (+h) * 60 + (+(m ?? 0)); };
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}${(m % 1) ? '.' + Math.round((m % 1) * 100).toString().padStart(2, '0') : ''}`;

const STEP = +arg('step', 0.1);
const WINDOWS = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--from') WINDOWS.push([mins(process.argv[i + 1]), null]);
  if (process.argv[i] === '--to' && WINDOWS.length) WINDOWS[WINDOWS.length - 1][1] = mins(process.argv[i + 1]);
}
if (has('day')) WINDOWS.push([0, 1440]);
if (!WINDOWS.length) WINDOWS.push([mins('7:00'), mins('10:00')]);
const SWAP = has('swap-head');
const RULES = SWAP ? ['head'] : arg('rules', 'ship').split(',');
const JSONOUT = arg('json', null);

let backup = null;
if (SWAP) {
  backup = join(tmpdir(), `judge.lighting.${process.pid}.js`);
  await copyFile(LIGHTING, backup);
  console.log(`# working-tree lighting.js backed up to ${backup}`);
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

let browser = null, out = { env: null, step: STEP, swapHead: SWAP, rules: {} };
try {
  browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'] });
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__WALLY_READY__ === true', { timeout: 90000 });
  out.loadS = (Date.now() - t0) / 1000;
  out.env = await page.evaluate(() => {
    const gl = WALLY.ctx.renderer.getContext();
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return { gpu: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?', tier: WALLY.ctx.quality?.name || '?', weather: WALLY.ctx.sky.weatherName, hasRule: typeof WALLY.debug.skyRule === 'function' };
  });
  /* capture the live wx by wrapping update() once */
  await page.evaluate(() => {
    const L = WALLY.ctx.sky.lighting;
    const real = L.update.bind(L);
    window.__WX__ = null;
    L.update = (dt, hour, wx) => { window.__WX__ = wx; return real(dt, hour, wx); };
  });
  await page.evaluate(() => new Promise(r => { let n = 0; const t = () => (++n > 4 ? r() : requestAnimationFrame(t)); requestAnimationFrame(t); }));

  const SCAN = ([list, rule]) => {
    const { ctx, THREE } = WALLY;
    const L = ctx.sky.lighting;
    if (rule && rule !== 'head' && WALLY.debug.skyRule) WALLY.debug.skyRule(rule);
    const wx = window.__WX__;
    const gam = (v) => Math.pow(Math.max(v, 0), 0.45455);
    const chroma = (c) => { const r = gam(c.r), g = gam(c.g), b = gam(c.b); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx > 1e-4 ? (mx - mn) / mx : 0; };
    const hue = (c) => { const r = gam(c.r), g = gam(c.g), b = gam(c.b); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (d < 1e-6) return -1; let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return ((h * 60) % 360 + 360) % 360; };
    const val = (c) => Math.max(gam(c.r), gam(c.g), gam(c.b));
    const swarm = (c) => { const r = gam(c.r), b = gam(c.b), mx = Math.max(r, gam(c.g), b); return mx > 1e-4 ? Math.max(-1, Math.min(1, (r - b) / mx)) : 0; };
    const tmp = new THREE.Color();
    const rows = [];
    for (const m of list) {
      L.update(1 / 60, m / 60, wx);
      const ch = chroma(L.horizonColor), cf = chroma(L.fogColor);
      tmp.copy(L.horizonColor).lerp(L.fogColor, 0.5);
      const cavg = (ch + cf) * 0.5;
      const cancel = cavg > 1e-4 ? Math.max(0, Math.min(1, 1 - chroma(tmp) / cavg)) : 0;
      const sh = swarm(L.horizonColor), sf = swarm(L.fogColor);
      const opp = sh * sf < 0 ? Math.max(0, Math.min(Math.abs(sh), Math.abs(sf)) - 0.05) : 0;
      rows.push({
        m,
        bandC: +chroma(L.fogOut).toFixed(4), bandH: +hue(L.fogOut).toFixed(1), bandV: +val(L.fogOut).toFixed(3),
        band: '#' + L.fogOut.getHexString(THREE.SRGBColorSpace).toUpperCase(),
        horC: +chroma(L.horizonOut).toFixed(4), horH: +hue(L.horizonOut).toFixed(1),
        hor: '#' + L.horizonOut.getHexString(THREE.SRGBColorSpace).toUpperCase(),
        zenC: +chroma(L.skyOut).toFixed(4),
        tabHorC: +ch.toFixed(4), tabFogC: +cf.toFixed(4),
        dawn: +L.dawn.toFixed(4), cancel: +cancel.toFixed(4), opp: +opp.toFixed(4),
        el: +L.tod.sunEl.toFixed(2), grade: L.grade,
      });
    }
    return rows;
  };

  const LIST = [];
  for (const [a, b] of WINDOWS) for (let m = a; m <= b + 1e-9; m += STEP) LIST.push(+m.toFixed(4));
  for (const rule of RULES) {
    /* chunked so the evaluate payload stays sane */
    const acc = [];
    for (let i = 0; i < LIST.length; i += 4000) acc.push(...await page.evaluate(SCAN, [LIST.slice(i, i + 4000), rule]));
    out.rules[rule] = acc;
    console.log(`# ${rule}: ${acc.length} samples`);
  }
  out.errs = errs.slice(0, 5);
} finally {
  if (browser) await browser.close();
  server.close();
  if (SWAP && backup) { await copyFile(backup, LIGHTING); console.log('# lighting.js restored'); }
}
console.log(`GPU ${out.env?.gpu} tier ${out.env?.tier} weather ${out.env?.weather} load ${out.loadS?.toFixed(1)}s step ${STEP}min`);
if (JSONOUT) { await writeFile(JSONOUT, JSON.stringify(out)); console.log(`# json -> ${JSONOUT}`); }
/* a terse extremum report so the file is useful without the json */
for (const [rule, rows] of Object.entries(out.rules)) {
  let lo = rows[0];
  for (const r of rows) if (r.bandC < lo.bandC) lo = r;
  console.log(`${rule.padEnd(5)} min bandC ${lo.bandC.toFixed(4)} at ${hhmm(lo.m)}  ${lo.band} hue ${lo.bandH}  horC ${lo.horC}`);
}
