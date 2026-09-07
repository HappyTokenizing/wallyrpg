import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..'); const OUT=join(ROOT,'shots/judge/glow');
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8'};
const server=createServer(async(rq,rs)=>{const c=decodeURIComponent(rq.url.split('?')[0]);
 try{const b=await readFile(join(ROOT,c==='/'?'index.html':c));rs.writeHead(200,{'content-type':MIME[extname(c)]||'application/octet-stream'});rs.end(b);}catch{rs.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r)); const port=server.address().port;
const browser=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--hide-scrollbars','--mute-audio']});
const page=await browser.newPage({viewport:{width:1200,height:800}});
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro&shot=1`,{waitUntil:'load',timeout:120000});
await page.waitForFunction('window.__WALLY_READY__===true',null,{timeout:120000});
await page.waitForTimeout(4000); await mkdir(OUT,{recursive:true});
const ev=(f,a)=>page.evaluate(f,a), wait=m=>page.waitForTimeout(m);

/* pin the world: night, balloon at a fixed spot, camera frozen on it */
const setup = await ev(async () => {
  WALLY.debug.setHour(22);
  WALLY.debug.balloon({ alt: 30 });
  await new Promise(r=>{let n=0;const t=()=>(++n>150?r():requestAnimationFrame(t));requestAnimationFrame(t);});
  WALLY.debug.balloonStick(0,0);
  const w = WALLY.ctx.wally.position.clone();
  WALLY.debug.camFree();
  const cam = WALLY.ctx.camera;
  cam.position.set(w.x - 16, w.y + 4, w.z - 16);
  cam.lookAt(w.x, w.y + 5.5, w.z);
  cam.updateMatrixWorld(true);
  // freeze the machine exactly where it is
  window.__PIN = () => { WALLY.ctx.wally.position.copy(w);
    cam.position.set(w.x-16, w.y+4, w.z-16); cam.lookAt(w.x, w.y+5.5, w.z); cam.updateMatrixWorld(true); };
  // read the envelope material's emissive uniform
  let env=null; WALLY.ctx.scene.traverse(o=>{ if(o.name==='balloon.envelope') env=o; });
  return { w: w.toArray().map(n=>+n.toFixed(2)), mat: env? env.material.name : null,
    uni: env && env.material.uniforms ? Object.keys(env.material.uniforms).filter(k=>/emis|glow|light/i.test(k)) : null };
});
console.log('SETUP', JSON.stringify(setup));
const readU = () => ev(()=>{ let env=null; WALLY.ctx.scene.traverse(o=>{ if(o.name==='balloon.envelope') env=o; });
  let th=null; WALLY.ctx.scene.traverse(o=>{ if(o.name==='balloon.throat') th=o; });
  return { env: env?.material?.uniforms?.uEmissive?.value ?? null, throat: th?.material?.uniforms?.uEmissive?.value ?? null }; });

for (const [on,name] of [[false,'off'],[true,'on']]) {
  await ev((o)=>{ WALLY.debug.balloonBurn(o); }, on);
  for (let i=0;i<70;i++){ await ev(()=>window.__PIN()); await wait(16); }
  await ev(()=>window.__PIN());
  await page.screenshot({ path: join(OUT, 'night-'+name+'.png'), timeout:20000 });
  console.log('night', name, 'uEmissive', JSON.stringify(await readU()));
}
/* and by day for reference */
await ev(()=>WALLY.debug.setHour(13));
for (const [on,name] of [[false,'off'],[true,'on']]) {
  await ev((o)=>{ WALLY.debug.balloonBurn(o); }, on);
  for (let i=0;i<70;i++){ await ev(()=>window.__PIN()); await wait(16); }
  await ev(()=>window.__PIN());
  await page.screenshot({ path: join(OUT, 'day-'+name+'.png'), timeout:20000 });
  console.log('day', name, 'uEmissive', JSON.stringify(await readU()));
}
await browser.close(); server.close();
