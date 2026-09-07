#!/usr/bin/env node
/* Is the flight camera's boom seeded on the wrong side?
   Measured: the azimuth of the camera AROUND the subject, and the angle
   between the lens' look direction and the direction to the subject,
   every frame from the moment the override takes over. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8' };
const server=createServer(async(rq,rs)=>{const c=decodeURIComponent(rq.url.split('?')[0]);
 try{const b=await readFile(join(ROOT,c==='/'?'index.html':c));rs.writeHead(200,{'content-type':MIME[extname(c)]||'application/octet-stream'});rs.end(b);}catch{rs.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r)); const port=server.address().port;
const browser=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--hide-scrollbars','--mute-audio']});
const page=await browser.newPage({viewport:{width:1280,height:720}});
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`,{waitUntil:'load',timeout:120000});
await page.waitForFunction('window.__WALLY_READY__===true',null,{timeout:120000});
await page.waitForTimeout(4500);
await mkdir(join(ROOT,'shots/judge/cam'),{recursive:true});
await page.evaluate(()=>{ window.__C=[]; const c=WALLY.ctx.camera,w=WALLY.ctx.wally;
  let t0=performance.now();
  const tick=()=>{ const d=new (c.getWorldDirection(new (window.__V||Object)) ,0); };
  // simple sampler
  const V = c.getWorldDirection.bind(c);
  const samp=()=>{
    const p=c.position, wp=w.position;
    const dx=p.x-wp.x, dz=p.z-wp.z;
    const boomAz = Math.atan2(dx,dz)*57.2958;            // where the camera SITS, around him
    const dir = c.getWorldDirection(c.userData.__d || (c.userData.__d = new p.constructor()));
    const lookAz = Math.atan2(dir.x,dir.z)*57.2958;
    // angle between the look direction and the direction to the subject
    const tx=wp.x-p.x, ty=(wp.y+0.9)-p.y, tz=wp.z-p.z;
    const l=Math.hypot(tx,ty,tz)||1;
    const dot=(dir.x*tx+dir.y*ty+dir.z*tz)/l;
    window.__C.push({ ms:+(performance.now()-t0).toFixed(0),
      ph:(()=>{try{return WALLY.debug.balloonInfo().phase;}catch(e){return '';}})(),
      mode:WALLY.ctx.cam?.mode||'', boomAz:+boomAz.toFixed(1), lookAz:+lookAz.toFixed(1),
      offAxis:+(Math.acos(Math.max(-1,Math.min(1,dot)))*57.2958).toFixed(1),
      dist:+Math.hypot(dx,dz).toFixed(2), camY:+p.y.toFixed(2), wy:+wp.y.toFixed(2) });
    if (window.__C.length<3000) requestAnimationFrame(samp);
  };
  requestAnimationFrame(samp);
});
await page.waitForTimeout(1200);
await page.evaluate(()=>{ const g=WALLY.ctx.game; g.actions.grantRide('balloon'); g.actions.equipRide('balloon'); });
/* film the first two seconds densely */
for (let i=0;i<12;i++){ await page.waitForTimeout(160);
  await page.screenshot({path: join(ROOT,'shots/judge/cam','t'+String(i).padStart(2,'0')+'.png'), timeout:20000}); }
await page.waitForTimeout(9000);
const C = await page.evaluate(()=>window.__C);
const first = C.findIndex(r=>r.mode==='override');
console.log('override starts at sample', first);
console.log('ms    phase     mode      boomAz  lookAz  offAxis  dist  camY');
for (let i=Math.max(0,first-4); i<Math.min(C.length, first+150); i+=2) {
  const r=C[i];
  console.log(`${String(r.ms).padStart(5)} ${r.ph.padEnd(9)} ${r.mode.padEnd(9)} ${String(r.boomAz).padStart(7)} ${String(r.lookAz).padStart(7)} ${String(r.offAxis).padStart(7)} ${String(r.dist).padStart(6)} ${String(r.camY).padStart(6)}`);
}
console.log('\nlater (settled flight):');
for (let i=C.length-40;i<C.length;i+=4){ const r=C[i];
  console.log(`${String(r.ms).padStart(5)} ${r.ph.padEnd(9)} ${r.mode.padEnd(9)} ${String(r.boomAz).padStart(7)} ${String(r.lookAz).padStart(7)} ${String(r.offAxis).padStart(7)} ${String(r.dist).padStart(6)} ${String(r.camY).padStart(6)}`); }
await browser.close(); server.close();
