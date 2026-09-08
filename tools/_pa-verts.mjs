import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8'};
const server=createServer(async(rq,rs)=>{const c=decodeURIComponent(rq.url.split('?')[0]);try{const b=await readFile(join(ROOT,c==='/'?'index.html':c));rs.writeHead(200,{'content-type':MIME[extname(c)]||'application/octet-stream'});rs.end(b);}catch{rs.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--hide-scrollbars']});
const page=await browser.newPage({viewport:{width:960,height:540}});
page.on('pageerror',e=>console.log('PAGEERROR',e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?skipIntro`,{waitUntil:'load',timeout:180000});
await page.waitForFunction('window.__WALLY_READY__===true',null,{timeout:180000});
await page.waitForTimeout(3000);
const out = await page.evaluate(() => {
  const c=window.WALLY.ctx;
  const res=[];
  c.world.groundGroup.traverse(o=>{
    if(!o.isMesh||!/^road\./.test(o.name||''))return;
    const p=o.geometry.attributes.position; let n=0, worst=0, wv=null, sum=0;
    const near=[];
    for(let i=0;i<p.count;i++){
      const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
      const d=Math.hypot(x-(-24),z-(-200));
      if(d>3) continue;
      const h=c.world.heightAt(x,z); const e=y-h;
      near.push({x:+x.toFixed(2),z:+z.toFixed(2),y:+y.toFixed(3),h:+h.toFixed(3),e:+e.toFixed(3),d:+d.toFixed(2)});
      n++; sum+=e; if(Math.abs(e)>Math.abs(worst)){worst=e;wv={x:+x.toFixed(2),z:+z.toFixed(2),e:+e.toFixed(3)};}
    }
    near.sort((a,b)=>a.d-b.d);
    if(n) res.push({name:o.name,n,mean:+(sum/n).toFixed(4),worst:+worst.toFixed(4),wv,near:near.slice(0,10)});
  });
  return res;
});
for(const r of out){ console.log(`${r.name}: ${r.n} verts within 3 m, mean y-heightAt ${r.mean}, worst ${r.worst} at ${JSON.stringify(r.wv)}`);
  for(const v of r.near) console.log('    ', JSON.stringify(v)); }
await browser.close(); server.close();
