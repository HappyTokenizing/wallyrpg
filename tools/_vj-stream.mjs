/* post-ready NPC streaming cost + fps during it */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8' };
const server = createServer(async (rq,rs)=>{ try{ const c=decodeURIComponent(rq.url.split('?')[0]);
  const b=await readFile(join(ROOT,c==='/'?'index.html':c));
  rs.writeHead(200,{'content-type':MIME[extname(c)]||'application/octet-stream','cache-control':'no-store'}); rs.end(b);}catch{rs.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const P=server.address().port;
const browser=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--hide-scrollbars','--mute-audio']});
const page=await browser.newPage({viewport:{width:1280,height:720}});
await page.goto(`http://127.0.0.1:${P}/index.html`,{waitUntil:'load',timeout:120000});
await page.waitForFunction('window.__WALLY_READY__===true',{timeout:180000});
const out = await page.evaluate(()=>new Promise(res=>{
  const t0=performance.now(); const s=[]; let lastFrame=t0, worst=0;
  const raf=()=>{ const n=performance.now(); const d=n-lastFrame; if(d>worst) worst=d; lastFrame=n;
    if(n-t0<9000) requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
  const tick=()=>{ const npc=window.WALLY?.ctx?.npc;
    s.push([Math.round(performance.now()-t0), npc?npc.queued:-1, npc?(npc.stats?.built??-1):-1,
      Math.round(window.__WALLY_PERF__?.fps??0)]);
    if(performance.now()-t0>9000) return res({s,worst:Math.round(worst),
      perf:window.WALLY?.ctx?.npc?.perf, stats:window.WALLY?.ctx?.npc?.stats});
    setTimeout(tick,300); };
  tick();
}));
console.log('sample (ms/queued/built/fps):'); console.log(out.s.map(x=>x.join('/')).join('  '));
console.log('worst frame gap during first 9s of play:', out.worst, 'ms');
console.log('npc.perf at +9s:', JSON.stringify({build:out.perf?.build, total:out.perf?.total, clients:out.perf?.clients, place:out.perf?.place}));
console.log('npc.stats:', JSON.stringify(out.stats));
await browser.close(); server.close();
