#!/usr/bin/env node
/* Subsystem profiler for WALLY RPG — wraps each ctx handle's update/lateUpdate
   plus the render call and averages over a window of real frames.

   node prof.mjs [--eval "WALLY.debug.flyTo('mainstreet')"] [--w 1600] [--h 900]
                 [--settle 8000] [--sample 4000]
*/
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const ROOT = '/Users/herwig/Desktop/Claude files/wally-rpg';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8', '.css':'text/css', '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.svg':'image/svg+xml',
  '.glsl':'text/plain', '.wasm':'application/wasm' };

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i+1] ? process.argv[i+1] : d; };
const W = +arg('w', 1600), H = +arg('h', 900);
const SETTLE = +arg('settle', 6000), SAMPLE = +arg('sample', 4000);
const EVAL = arg('eval', null);
const LABEL = arg('label', 'scene');

const server = createServer(async (req, res) => {
  try {
    const clean = decodeURIComponent(req.url.split('?')[0]);
    const path = join(ROOT, clean === '/' ? 'index.html' : clean);
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-gpu-rasterization',
         '--force-color-profile=srgb','--hide-scrollbars','--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));

await page.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__ === true', { timeout: 45000 }).catch(() => errs.push('never ready'));

if (EVAL) { const r = await page.evaluate(EVAL).catch(e => 'EVAL ERROR ' + e.message); if (r) errs.push('[eval] ' + JSON.stringify(r)); }
await page.waitForTimeout(SETTLE);

// install instrumentation
await page.evaluate(() => {
  const ctx = window.WALLY.ctx;
  const nameOf = (h) => {
    for (const k of Object.keys(ctx)) if (ctx[k] === h) return k;
    return 'anon';
  };
  const stats = window.__PROF__ = { subs: {}, frames: 0, totalUpdate: 0, render: 0, wall: 0, gpuInfoCalls: 0, tris: 0 };
  let lastNow = performance.now();
  for (const h of ctx._handles) {
    const n = nameOf(h);
    stats.subs[n] = { update: 0, late: 0 };
    if (h.update && !h.__profWrapped) {
      const orig = h.update.bind(h);
      h.update = (dt, el) => { const t = performance.now(); orig(dt, el); stats.subs[n].update += performance.now() - t; };
    }
    if (h.lateUpdate && !h.__profWrapped) {
      const orig = h.lateUpdate.bind(h);
      h.lateUpdate = (dt, el) => { const t = performance.now(); orig(dt, el); stats.subs[n].late += performance.now() - t; };
    }
    h.__profWrapped = true;
  }
  if (ctx.render?.render && !ctx.render.__profRenderWrapped) {
    const orig = ctx.render.render.bind(ctx.render);
    ctx.render.render = () => { const t = performance.now(); orig(); stats.render += performance.now() - t; };
    ctx.render.__profRenderWrapped = true;
  }
  // wall-clock frame counter
  const tick = () => {
    const now = performance.now();
    const d = now - lastNow; stats.wall += d; lastNow = now; stats.frames++; (stats.hist ||= []).push(+d.toFixed(2));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(() => { lastNow = performance.now(); requestAnimationFrame(tick); });
});

await page.waitForTimeout(SAMPLE);

const out = await page.evaluate(() => {
  const s = window.__PROF__;
  const r = window.WALLY.ctx.renderer.info.render;
  return { ...JSON.parse(JSON.stringify(s)), calls: r.calls, tris: r.triangles,
           perf: window.__WALLY_PERF__ || null };
});
await browser.close(); server.close();

const f = Math.max(1, out.frames);
const rows = Object.entries(out.subs)
  .map(([k, v]) => ({ name: k, ms: (v.update + v.late) / f, up: v.update / f, late: v.late / f }))
  .sort((a, b) => b.ms - a.ms);
let sumUpdate = 0; rows.forEach(r => sumUpdate += r.ms);
console.log(`\n=== ${LABEL}  ${W}x${H}  frames=${out.frames} over ${SAMPLE}ms ===`);
console.log(`wall frame: ${(out.wall / f).toFixed(2)} ms  =>  ${(1000 / (out.wall / f)).toFixed(1)} fps   (reported fps ${out.perf?.fps})`);
console.log(`render():   ${(out.render / f).toFixed(2)} ms`);
console.log(`updates Σ:  ${sumUpdate.toFixed(2)} ms`);
console.log(`draw calls: ${out.calls}   tris: ${out.tris}`);
{ const h=(out.hist||[]).slice(1).sort((a,b)=>a-b); const q=(x)=>h[Math.min(h.length-1,Math.floor(h.length*x))];
  console.log(`frame ms  p50 ${q(.5)}  p90 ${q(.9)}  p99 ${q(.99)}  max ${h[h.length-1]}   >18ms: ${h.filter(v=>v>18).length}/${h.length}   >20ms: ${h.filter(v=>v>20).length}`); }
console.log('--- per subsystem (ms/frame) ---');
for (const r of rows) if (r.ms >= 0.005) console.log(`  ${r.name.padEnd(10)} ${r.ms.toFixed(2)}  (update ${r.up.toFixed(2)} / late ${r.late.toFixed(2)})`);
if (errs.length) console.log('errors: ' + errs.join(' | '));
console.log(JSON.stringify({ label: LABEL, fps: +(1000 / (out.wall / f)).toFixed(1), frameMs: +(out.wall / f).toFixed(2), render: +(out.render / f).toFixed(2), updates: +sumUpdate.toFixed(2), calls: out.calls, tris: out.tris, subs: rows.map(r => [r.name, +r.ms.toFixed(2)]) }));
