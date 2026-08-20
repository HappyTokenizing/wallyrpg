#!/usr/bin/env node
/* Independent subsystem profiler for WALLY RPG — written by the final judge.
   Wraps every ctx handle's update/lateUpdate and ctx.render.render with a
   performance.now() pair, accumulates over ~4s of real frames, reports ms/frame.
   CPU time only: renderer.render() returns once commands are submitted, so the
   gap between summed CPU and the real rAF interval is GPU + browser compositing. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = '/Users/herwig/Desktop/Claude files/wally-rpg';
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.glsl':'text/plain','.wasm':'application/wasm' };
const server = createServer(async (req,res)=>{ try{ const c=decodeURIComponent(req.url.split('?')[0]); const p=join(ROOT,c==='/'?'index.html':c); if(!p.startsWith(ROOT)){res.writeHead(403).end();return;} const b=await readFile(p); res.writeHead(200,{'content-type':MIME[extname(p)]||'application/octet-stream','cache-control':'no-store'}); res.end(b);}catch{res.writeHead(404).end();} });
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const PORT = server.address().port;

const EVAL = process.argv[2] || null;
const LABEL = process.argv[3] || 'scene';
const SETTLE = +(process.argv[4] || 9000);

const browser = await chromium.launch({ channel:'chrome', args:['--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-gpu-rasterization','--force-color-profile=srgb','--hide-scrollbars','--mute-audio'] });
const page = await browser.newPage({ viewport:{width:1600,height:900}, deviceScaleFactor:1 });
await page.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil:'load', timeout:60000 });
await page.waitForFunction('window.__WALLY_READY__ === true', { timeout:45000 }).catch(()=>{});
if (EVAL) await page.evaluate(EVAL).catch(e=>console.log('EVAL ERR', e.message));
await page.waitForTimeout(SETTLE);

const out = await page.evaluate(async () => {
  const ctx = window.WALLY.ctx;
  const nameOf = (h) => { for (const k of Object.keys(ctx)) if (ctx[k] === h) return k; return 'anon'; };
  const acc = {}; const bump = (k,v) => { acc[k] = (acc[k]||0)+v; };
  const undo = [];
  for (const h of ctx._handles) {
    const n = nameOf(h);
    for (const m of ['update','lateUpdate']) {
      if (typeof h[m] !== 'function') continue;
      const orig = h[m].bind(h);
      const key = n + (m === 'lateUpdate' ? '.late' : '');
      h[m] = (...a) => { const t = performance.now(); try { return orig(...a); } finally { bump(key, performance.now()-t); } };
      undo.push(() => { delete h[m]; });
    }
  }
  if (ctx.render?.render) {
    const orig = ctx.render.render.bind(ctx.render);
    ctx.render.render = (...a) => { const t = performance.now(); try { return orig(...a); } finally { bump('RENDER', performance.now()-t); } };
    undo.push(() => { delete ctx.render.render; });
  }
  // measure over ~4s of real frames
  const t0 = performance.now(); const f0 = ctx.frame;
  await new Promise(r => setTimeout(r, 4000));
  const wall = performance.now() - t0; const frames = ctx.frame - f0;
  for (const u of undo) u();
  const R = window.WALLY.ctx.renderer || null;
  return { wall, frames, acc,
           calls: R?.info?.render?.calls ?? -1, tris: R?.info?.render?.triangles ?? -1,
           perf: window.__WALLY_PERF__ };
}).catch(e => ({ err: e.message }));

await browser.close(); server.close();
if (out.err) { console.log('ERR', out.err); process.exit(1); }
const perFrame = (v) => (v / out.frames);
const rows = Object.entries(out.acc).map(([k,v]) => [k, perFrame(v)]).sort((a,b)=>b[1]-a[1]);
const sum = rows.reduce((s,r)=>s+r[1],0);
const frameMs = out.wall / out.frames;
console.log(`\n=== ${LABEL} — ${out.frames} frames in ${out.wall.toFixed(0)} ms ===`);
console.log(`  measured frame        : ${frameMs.toFixed(2)} ms  (${(1000/frameMs).toFixed(1)} fps)   calls ${out.calls}  tris ${out.tris}`);
for (const [k,v] of rows) if (v >= 0.005) console.log(`  ${k.padEnd(22)}: ${v.toFixed(2)} ms   ${(100*v/frameMs).toFixed(1)}%`);
console.log(`  ${'— CPU accounted —'.padEnd(22)}: ${sum.toFixed(2)} ms   ${(100*sum/frameMs).toFixed(1)}%`);
console.log(`  ${'— idle/GPU/compos —'.padEnd(22)}: ${(frameMs-sum).toFixed(2)} ms   ${(100*(frameMs-sum)/frameMs).toFixed(1)}%`);
console.log(`  in-game perf counter  : ${JSON.stringify(out.perf)}`);
