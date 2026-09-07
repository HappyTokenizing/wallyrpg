#!/usr/bin/env node
/* JUDGE — PERFORMANCE, isolated. 1600x900, one browser, nothing else running.
   renderer.info.autoReset is FALSE here: `calls` is a WHOLE FRAME (every
   pass) sampled at the end of the frame, which is what main.js publishes. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8'};
const server=createServer(async(rq,rs)=>{const c=decodeURIComponent(rq.url.split('?')[0]);
 try{const b=await readFile(join(ROOT,c==='/'?'index.html':c));rs.writeHead(200,{'content-type':MIME[extname(c)]||'application/octet-stream'});rs.end(b);}catch{rs.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r)); const port=server.address().port;
const browser=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-gpu-rasterization','--hide-scrollbars','--mute-audio']});
const page=await browser.newPage({viewport:{width:1600,height:900}});
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`,{waitUntil:'load',timeout:120000});
await page.waitForFunction('window.__WALLY_READY__===true',null,{timeout:120000});
await page.waitForTimeout(6000);
const ev=(f,a)=>page.evaluate(f,a);
console.log('quality', JSON.stringify(await ev(()=>({q:WALLY.ctx.quality?.name, dpr:WALLY.ctx.renderer.getPixelRatio(), size:[innerWidth,innerHeight]}))));

/* a real sample: 6 s of frames, ms from rAF deltas, calls/tris read at the end of a frame */
const sample = (label, secs=6) => ev(async (s) => {
  const t0=performance.now(); const ms=[]; let last=t0;
  const info = WALLY.ctx.renderer.info;
  const calls=[], tris=[];
  while (performance.now()-t0 < s*1000) {
    await new Promise(r=>requestAnimationFrame(r));
    const n=performance.now(); ms.push(n-last); last=n;
    calls.push(info.render.calls); tris.push(info.render.triangles);
  }
  const med=a=>{const v=a.slice().sort((x,y)=>x-y); return v[v.length>>1];};
  const p95=a=>{const v=a.slice().sort((x,y)=>x-y); return v[Math.floor(v.length*0.95)];};
  ms.shift(); ms.shift();
  return { n:ms.length, msMed:+med(ms).toFixed(2), msP95:+p95(ms).toFixed(2), msMax:+Math.max(...ms).toFixed(2),
    fpsMed:+(1000/med(ms)).toFixed(1), fpsP5:+(1000/p95(ms)).toFixed(1),
    calls:med(calls), tris:med(tris) };
}, secs);

const rows=[];
const at = async (label, setup, secs=6) => { if (setup) await ev(setup); await page.waitForTimeout(2500);
  const r = await sample(label, secs); rows.push({label, ...r}); console.log(label, JSON.stringify(r)); };

await at('A  on foot, spawn (open ground)', null);
await at('B  on foot, Main Street', ()=>{ WALLY.debug.arrive && WALLY.debug.arrive('cafe', true); });
await at('C  on foot, Market Square', ()=>{ WALLY.debug.arrive && WALLY.debug.arrive('markethall', true); });
await at('D  balloon, boarding (envelope inflating)', ()=>{ const g=WALLY.ctx.game; g.actions.grantRide('balloon'); g.actions.equipRide('balloon'); }, 4);
await at('E  balloon aloft   20 m', ()=>{ WALLY.debug.balloon({alt:20}); WALLY.debug.balloonStick(0,0); });
await at('F  balloon aloft   60 m', ()=>{ WALLY.debug.balloon({alt:60}); });
await at('G  balloon aloft  120 m', ()=>{ WALLY.debug.balloon({alt:120}); });
await at('H  balloon aloft  240 m', ()=>{ WALLY.debug.balloon({alt:240}); });
await at('I  balloon aloft  500 m', ()=>{ WALLY.debug.balloon({alt:500}); });
/* the machine's own cost, differenced across whole frames, at two altitudes */
for (const alt of [20, 120]) {
  const c = await ev(async (a)=>{ WALLY.debug.balloon({alt:a});
    await new Promise(r=>setTimeout(r,900)); return WALLY.debug.balloonCost(40); }, alt);
  console.log(`balloonCost @${alt} m`, JSON.stringify(c));
}
/* and the moored machine, on the ground, seen from the follow camera */
await ev(()=>{ WALLY.debug.balloon(false); WALLY.ctx.game.actions.equipRide(null); });
await page.waitForTimeout(4000);
await at('J  on foot, balloon moored beside him', null);
console.log('\n| scene | median ms | p95 ms | median fps | 5th-pct fps | draw calls | triangles |');
console.log('|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.label} | ${r.msMed} | ${r.msP95} | ${r.fpsMed} | ${r.fpsP5} | ${r.calls} | ${r.tris} |`);
await browser.close(); server.close();
