#!/usr/bin/env node
/* Independent profiler — SHIP JUDGE. Wraps every ctx handle update/lateUpdate,
   measures exactly N frames (rAF-counted), reports ms/frame per subsystem. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const ROOT = '/Users/herwig/Desktop/Claude files/wally-rpg';
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.glsl':'text/plain','.wasm':'application/wasm' };
const server = createServer(async (req,res)=>{ try{ const c=decodeURIComponent(req.url.split('?')[0]); const p=join(ROOT,c==='/'?'index.html':c); if(!p.startsWith(ROOT)){res.writeHead(403).end();return;} const b=await readFile(p); res.writeHead(200,{'content-type':MIME[extname(p)]||'application/octet-stream','cache-control':'no-store'}); res.end(b);}catch{res.writeHead(404).end();} });
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const PORT = server.address().port;

const EVAL   = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : null;
const LABEL  = process.argv[3] || 'scene';
const SETTLE = +(process.argv[4] || 9000);
const NFRAMES= +(process.argv[5] || 40);

const browser = await chromium.launch({ channel:'chrome', args:['--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-gpu-rasterization','--force-color-profile=srgb','--hide-scrollbars','--mute-audio'] });
const page = await browser.newPage({ viewport:{width:1600,height:900}, deviceScaleFactor:1 });
page.on('pageerror', e => console.log('[PAGEERROR]', e.message));
await page.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil:'load', timeout:60000 });
await page.waitForFunction('window.__WALLY_READY__ === true', { timeout:45000 }).catch(()=>console.log('[warn] never ready'));
if (EVAL) console.log('[eval]', JSON.stringify(await page.evaluate(EVAL).catch(e=>'ERR '+e.message)));
await page.waitForTimeout(SETTLE);

const out = await page.evaluate(async (N) => {
  const ctx = window.WALLY.ctx;
  const nameOf = (h) => { for (const k of Object.keys(ctx)) if (ctx[k] === h) return k; return 'anon'; };
  const acc = {}; const samples = {};
  const undo = [];
  for (const h of ctx._handles) {
    const n = nameOf(h);
    for (const m of ['update','lateUpdate']) {
      if (typeof h[m] !== 'function') continue;
      const orig = h[m].bind(h);
      const key = n + (m === 'lateUpdate' ? '.lateUpdate' : '.update');
      samples[key] = [];
      h[m] = (...a) => { const t = performance.now(); try { return orig(...a); } finally { const d = performance.now()-t; acc[key]=(acc[key]||0)+d; samples[key].push(d); } };
      undo.push(() => { delete h[m]; });
    }
  }
  if (ctx.render?.render) {
    const orig = ctx.render.render.bind(ctx.render);
    samples.RENDER = [];
    ctx.render.render = (...a) => { const t = performance.now(); try { return orig(...a); } finally { const d=performance.now()-t; acc.RENDER=(acc.RENDER||0)+d; samples.RENDER.push(d); } };
    undo.push(() => { delete ctx.render.render; });
  }
  const t0 = performance.now(); const f0 = ctx.frame;
  await new Promise(res => { let n=0; const tick=()=>{ if(++n>=N) return res(); requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  const wall = performance.now() - t0; const frames = ctx.frame - f0;
  for (const u of undo) u();
  const st = {};
  for (const [k,v] of Object.entries(samples)) {
    if (!v.length) continue;
    const s = v.slice().sort((a,b)=>a-b);
    st[k] = { n:v.length, mean:+(v.reduce((a,b)=>a+b,0)/v.length).toFixed(4), med:+s[s.length>>1].toFixed(4), max:+s[s.length-1].toFixed(4) };
  }
  const R = ctx.renderer;
  return { wall, frames, st, calls:R?.info?.render?.calls ?? -1, tris:R?.info?.render?.triangles ?? -1, perf: window.__WALLY_PERF__ };
}, NFRAMES).catch(e => ({ err: e.message }));

await browser.close(); server.close();
if (out.err) { console.log('ERR', out.err); process.exit(1); }
const frameMs = out.wall / out.frames;
console.log(`\n=== ${LABEL} — ${out.frames} frames in ${out.wall.toFixed(0)} ms ===`);
console.log(`  frame ${frameMs.toFixed(2)} ms  (${(1000/frameMs).toFixed(1)} fps)  calls ${out.calls}  tris ${out.tris}`);
const rows = Object.entries(out.st).sort((a,b)=>b[1].mean-a[1].mean);
let sum=0;
for (const [k,v] of rows) { sum+=v.mean; if (v.mean>=0.005||/wally/.test(k)) console.log(`  ${k.padEnd(24)} mean ${v.mean.toFixed(3)}  med ${v.med.toFixed(3)}  max ${v.max.toFixed(3)}  n=${v.n}`); }
console.log(`  CPU accounted ${sum.toFixed(2)} ms / ${frameMs.toFixed(2)} ms`);
console.log(`  in-game perf: ${JSON.stringify(out.perf)}`);
