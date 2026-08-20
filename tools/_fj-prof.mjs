/* independent subsystem profiler — judge's own, does not reuse tools/_judge-prof.mjs */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const ROOT = '/Users/herwig/Desktop/Claude files/wally-rpg';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8', '.css':'text/css', '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.svg':'image/svg+xml' };
const server = createServer(async (req,res)=>{
  try{ const c=decodeURIComponent(req.url.split('?')[0]);
    const p=join(ROOT, c==='/'?'index.html':c);
    if(!p.startsWith(ROOT)){res.writeHead(403).end();return;}
    const b=await readFile(p);
    res.writeHead(200,{'content-type':MIME[extname(p)]||'application/octet-stream','cache-control':'no-store'});
    res.end(b);
  }catch{res.writeHead(404).end('nf');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const PORT=server.address().port;
const browser = await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-gpu-rasterization','--force-color-profile=srgb','--hide-scrollbars','--mute-audio']});
const page = await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',e.message));
await page.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`,{waitUntil:'load',timeout:60000});
await page.waitForFunction('window.__WALLY_READY__===true',{timeout:45000});

// install wrappers
await page.evaluate(()=>{
  const ctx = window.WALLY.ctx;
  const NAMES = ['render','mat','wind','sky','world','city','foliage','water','phys','wally','npc','cam','game','ui','audio','intro'];
  const nameOf = (h)=>{ for(const n of NAMES) if(ctx[n]===h) return n; return 'anon'; };
  const P = window.__PROF__ = { on:false, n:0, t:{}, wall:0 };
  for (const h of ctx._handles){
    const nm = nameOf(h);
    for (const k of ['update','lateUpdate']){
      if (typeof h[k] !== 'function') continue;
      const orig = h[k].bind(h);
      h[k] = function(...a){
        if(!P.on) return orig(...a);
        const t0=performance.now(); const r=orig(...a); const t1=performance.now();
        const key = nm + (k==='lateUpdate'?'.late':'');
        P.t[key]=(P.t[key]||0)+(t1-t0); return r;
      };
    }
  }
  // render
  if (ctx.render && typeof ctx.render.render === 'function'){
    const orig = ctx.render.render.bind(ctx.render);
    ctx.render.render = function(...a){
      if(!P.on) return orig(...a);
      const t0=performance.now(); const r=orig(...a); const t1=performance.now();
      P.t['RENDER']=(P.t['RENDER']||0)+(t1-t0);
      P.n++;
      return r;
    };
  }
});

async function run(label, setup, settle, dur){
  if (setup) await page.evaluate(setup).catch(e=>console.log('setup err',e.message));
  await page.waitForTimeout(settle);
  await page.evaluate(()=>{ const P=window.__PROF__; P.t={}; P.n=0; P.wall=performance.now(); P.on=true; });
  await page.waitForTimeout(dur);
  const out = await page.evaluate(()=>{ const P=window.__PROF__; P.on=false;
    const wall=performance.now()-P.wall;
    const r=window.WALLY.ctx.renderer.info.render;
    return {t:P.t,n:P.n,wall, calls:r.calls, tris:r.triangles, perf:window.__WALLY_PERF__};
  });
  const n=out.n;
  const rows = Object.entries(out.t).map(([k,v])=>[k, v/n]).sort((a,b)=>b[1]-a[1]);
  const sum = rows.reduce((s,r)=>s+r[1],0);
  console.log(`\n===== ${label} =====`);
  console.log(`frames ${n} over ${out.wall.toFixed(0)} ms  ->  ${(n/out.wall*1000).toFixed(1)} fps  (${(out.wall/n).toFixed(2)} ms/frame wall)`);
  console.log(`draw calls ${out.calls}   triangles ${out.tris}   in-page perf ${JSON.stringify(out.perf)}`);
  console.log(`  ${'subsystem'.padEnd(16)} ms/frame   % of instrumented`);
  for(const [k,v] of rows) if (v>0.005) console.log(`  ${k.padEnd(16)} ${v.toFixed(3).padStart(7)}   ${(v/sum*100).toFixed(1)}%`);
  console.log(`  ${'-- instrumented'.padEnd(16)} ${sum.toFixed(3).padStart(7)}`);
  console.log(`  ${'-- unaccounted'.padEnd(16)} ${(out.wall/n - sum).toFixed(3).padStart(7)}  (rAF idle / vsync / GPU wait / browser)`);
}

await run('BOOT SCENE (spawn)', null, 6000, 4000);
await run('CITY SCENE (mainstreet)', `WALLY.debug.flyTo('mainstreet')`, 6000, 4000);

await browser.close(); server.close();
