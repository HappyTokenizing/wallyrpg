import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8' };
const server = createServer(async (rq,rs)=>{const c=decodeURIComponent(rq.url.split('?')[0]);
 try{const b=await readFile(join(ROOT,c==='/'?'index.html':c));rs.writeHead(200,{'content-type':MIME[extname(c)]||'application/octet-stream'});rs.end(b);}catch{rs.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r)); const port=server.address().port;
const browser=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--hide-scrollbars','--mute-audio']});
const page=await browser.newPage({viewport:{width:1600,height:900}});
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro&shot=1`,{waitUntil:'load',timeout:120000});
await page.waitForFunction('window.__WALLY_READY__===true',null,{timeout:120000});
await page.waitForTimeout(4000);

const r = await page.evaluate(async () => {
  const out = {};
  const grab = () => {
    let g=null; WALLY.ctx.scene.traverse(o=>{ if(o.name==='balloon.envGroup') g=o; });
    if(!g) return null;
    g.updateWorldMatrix(true,true);
    const bb=(obj)=>{let miny=1e9,maxy=-1e9,n=0,cy=0;
      obj.traverse(o=>{ if(!o.isMesh||!o.geometry?.attributes.position||o.userData.isOutlineHull) return;
        const p=o.geometry.attributes.position,m=o.matrixWorld.elements;
        for(let i=0;i<p.count;i++){const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
          const wy=m[1]*x+m[5]*y+m[9]*z+m[13];
          if(wy<miny)miny=wy; if(wy>maxy)maxy=wy; cy+=wy; n++;}});
      return {miny:+miny.toFixed(4),maxy:+maxy.toFixed(4),mid:+(cy/Math.max(1,n)).toFixed(4),n};};
    const o={};
    g.children.forEach((c,i)=>{ o[c.name||('child'+i)]=bb(c); });
    return o;
  };
  /* A: force a real morph so setInflate cannot early-return */
  WALLY.debug.balloonPose(0.4);
  WALLY.debug.balloonPose(1.0);
  out.forcedFull = grab();
  /* B: the real thing — actually flying, envelope full */
  WALLY.debug.balloon({alt:60});
  await new Promise(r=>{let n=0;const t=()=>(++n>90?r():requestAnimationFrame(t));requestAnimationFrame(t);});
  out.inFlight = grab();
  out.flightInfo = WALLY.debug.balloonInfo();
  /* C: what a fresh build with no morph reports (the early-return case) */
  WALLY.debug.balloon(false);
  out.afterPutAway = grab();
  return out;
});
console.log(JSON.stringify(r,null,1));
const f=r.inFlight, ff=r.forcedFull;
const gap=(o)=>o? +(o['child2'].miny - o['balloon.envelope'].maxy).toFixed(4) : null;
console.log('\nCROWN RING BOTTOM minus ENVELOPE TOP (metres, +ve = floating clear):');
console.log('  forced full inflation :', gap(ff));
console.log('  ACTUALLY FLYING       :', gap(f));
await browser.close(); server.close();
