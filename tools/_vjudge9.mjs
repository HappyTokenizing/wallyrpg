import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
const ROOT='/Users/herwig/Documents/GitHub/wallyrpg';
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8'};
const server=createServer(async(rq,rs)=>{const c=decodeURIComponent(rq.url.split('?')[0]);
 try{const b=await readFile(join(ROOT,c==='/'?'index.html':c));rs.writeHead(200,{'content-type':MIME[extname(c)]||'application/octet-stream'});rs.end(b);}catch{rs.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r)); const port=server.address().port;
const browser=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader']});
const ctxB=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,deviceScaleFactor:1,
 userAgent:'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36'});
const page=await ctxB.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro=1`,{waitUntil:'load',timeout:90000});
for(let i=0;i<120;i++){if(await page.evaluate(()=>window.__WALLY_READY__===true).catch(()=>0))break;await page.waitForTimeout(300);}
await page.waitForTimeout(3000);
const cdp=await ctxB.newCDPSession(page);
const t=(k,x,y)=>cdp.send('Input.dispatchTouchEvent',{type:k,touchPoints:k==='touchEnd'?[]:[{x,y,radiusX:12,radiusY:12,force:1}]});
const snap=(ms=900)=>page.evaluate((MS)=>new Promise(res=>{const w=WALLY.ctx.wally;let b=null;
 w.root.traverse(o=>{if(!b&&o.name==='legL0')b=o;});const s=[];const t0=performance.now();
 const st=()=>{s.push(b.rotation.x); if(performance.now()-t0<MS)requestAnimationFrame(st);
  else res({speed:+(w.controller.planarSpeed||0).toFixed(2),loco:w.animator.locoName,
   animSpeed:+(w.animator.speed||0).toFixed(2),range:+(Math.max(...s)-Math.min(...s)).toFixed(3),
   action:w.animator.action?.clip?.name??null});};requestAnimationFrame(st);}),ms);
console.log('WALK -> RUN LADDER (thumbstick pushed progressively further)');
console.log(' rest      ', JSON.stringify(await snap()));
await t('touchStart',90,684); await page.waitForTimeout(120);
for(const dy of [12,22,34,50,80]){
  await t('touchMove',90,684-dy); await page.waitForTimeout(1300);
  console.log(` push ${String(dy).padStart(2)}px `, JSON.stringify(await snap()));
}
for(const dy of [34,18,10]){
  await t('touchMove',90,684-dy); await page.waitForTimeout(1300);
  console.log(` back ${String(dy).padStart(2)}px `, JSON.stringify(await snap()));
}
await t('touchEnd',90,674); await page.waitForTimeout(1600);
console.log(' released  ', JSON.stringify(await snap(1200)));
console.log('errors:',errs.length,JSON.stringify([...new Set(errs)].slice(0,3)));
await browser.close(); server.close();
