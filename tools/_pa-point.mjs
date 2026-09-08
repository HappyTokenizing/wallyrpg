import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n,d)=>{const i=process.argv.indexOf('--'+n);return i>-1&&process.argv[i+1]?process.argv[i+1]:d;};
const PTS = JSON.parse(arg('pts','[[-24,-200],[-24.01,-200.19],[-23,-200],[-25,-200],[-24,-199],[-24,-201]]'));
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8'};
const server=createServer(async(rq,rs)=>{const c=decodeURIComponent(rq.url.split('?')[0]);try{const b=await readFile(join(ROOT,c==='/'?'index.html':c));rs.writeHead(200,{'content-type':MIME[extname(c)]||'application/octet-stream'});rs.end(b);}catch{rs.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const browser=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--hide-scrollbars']});
const page=await browser.newPage({viewport:{width:960,height:540}});
page.on('pageerror',e=>console.log('PAGEERROR',e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`,{waitUntil:'load',timeout:180000});
await page.waitForFunction('window.__WALLY_READY__===true',null,{timeout:180000});
await page.waitForTimeout(4000);
const rows = await page.evaluate(async (PTS) => {
  const c=window.WALLY.ctx,T=window.WALLY.THREE,phys=c.phys;
  const frames=n=>new Promise(r=>{let i=0;const f=()=>(++i>=n?r():requestAnimationFrame(f));requestAnimationFrame(f);});
  const [ax,az]=PTS[0];
  phys.player.teleport(new T.Vector3(ax,c.phys.groundAt(ax,az).y+0.4,az)); await frames(6);
  phys.player.teleport(new T.Vector3(ax,c.phys.groundAt(ax,az).y+0.4,az)); await frames(6);
  const SKIP=/outline|hull|contactShadow|cloth|drift|grass|\blip\b|foliage|detail|bush|reed|\bwater\b|sky|cloud/i;
  const targets=[];
  for(const r of [c.world?.groundGroup,c.city?.root].filter(Boolean)) r.traverse(o=>{
    if(!o.isMesh&&!o.isInstancedMesh)return; if(o.userData.isOutlineHull||o.userData.noPrepass)return;
    if(SKIP.test(o.name||''))return; for(let p=o;p;p=p.parent) if(p.visible===false)return; targets.push(o);});
  const ray=new T.Raycaster(); const DOWN=new T.Vector3(0,-1,0);
  const out=[];
  for(const [x,z] of PTS){
    const g=c.phys.groundAt(x,z);
    ray.set(new T.Vector3(x,g.y+3.0,z),DOWN); ray.far=12;
    const hits=ray.intersectObjects(targets,false);
    const seen={}; for(const h of hits){ const n=h.object.name||'?'; if(seen[n]===undefined) seen[n]=+h.point.y.toFixed(4); }
    out.push({x,z, coll:+g.y.toFixed(4), ny:+g.normal.y.toFixed(3), body:phys.world.bodies.get(g.body)?.opts?.name||'plane',
      hAt:+c.world.heightAt(x,z).toFixed(4), top: c.world.topAt? (c.world.topAt(x,z)) : null, hits:seen});
  }
  return out;
}, PTS);
for(const r of rows) console.log(`(${r.x},${r.z}) coll ${r.coll} ny ${r.ny} body ${r.body} | heightAt ${r.hAt} | topAt ${r.top===null?'-':(+r.top).toFixed?.(4)??r.top} | drawn ${JSON.stringify(r.hits)}`);
await browser.close(); server.close();
