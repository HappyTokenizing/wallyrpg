import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const ROOT='/Users/herwig/Desktop/Claude files/wally-rpg';
const MIME={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml'};
const server=createServer(async(q,s)=>{try{const c=decodeURIComponent(q.url.split('?')[0]);const p=join(ROOT,c==='/'?'index.html':c);const b=await readFile(p);s.writeHead(200,{'content-type':MIME[extname(p)]||'application/octet-stream','cache-control':'no-store'});s.end(b);}catch{s.writeHead(404).end('nf');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const P=server.address().port;
const b=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--hide-scrollbars','--mute-audio']});
const page=await b.newPage({viewport:{width:1600,height:900}});
await page.goto(`http://127.0.0.1:${P}/index.html?shot=1`,{waitUntil:'load'});
await page.waitForFunction('window.__WALLY_READY__===true',{timeout:45000});
await page.waitForTimeout(6000);
const r=await page.evaluate(async()=>{
  const ctx=window.WALLY.ctx, R=ctx.renderer;
  const snap=()=>({programs:R.info.programs.length, calls:R.info.render.calls, geo:R.info.memory.geometries, tex:R.info.memory.textures, frame:R.info.render.frame});
  const a=snap();
  // count objects in scene + how many carry skinning + how many materials
  let objs=0, meshes=0, skinned=0, inst=0, matsUp=0; const mats=new Set();
  ctx.scene.traverse(o=>{objs++; if(o.isMesh){meshes++; if(o.isSkinnedMesh)skinned++; if(o.isInstancedMesh)inst++;
    const m=o.material; (Array.isArray(m)?m:[m]).forEach(x=>{if(x){mats.add(x.uuid); if(x.needsUpdate)matsUp++;}});}
    if(o.matrixAutoUpdate===false) ; });
  await new Promise(res=>{let n=0;const t=()=>(++n>120?res():requestAnimationFrame(t));requestAnimationFrame(t);});
  const c=snap();
  // count matrixAutoUpdate=true objects
  let auto=0; ctx.scene.traverse(o=>{if(o.matrixAutoUpdate)auto++;});
  return {before:a, after:c, objs, meshes, skinned, inst, materials:mats.size, matsFlaggedNeedsUpdate:matsUp, matrixAutoUpdate:auto,
          shadowAuto:R.shadowMap.autoUpdate, shadowNeeds:R.shadowMap.needsUpdate, shadowType:R.shadowMap.type,
          lights:(()=>{let n=0,s=0;ctx.scene.traverse(o=>{if(o.isLight){n++;if(o.castShadow)s++;}});return {n,shadowCasters:s};})()};
});
console.log(JSON.stringify(r,null,2));
await b.close(); server.close();
