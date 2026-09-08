import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const M={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8'};
const sv=createServer(async(q,r)=>{const c=decodeURIComponent(q.url.split('?')[0]);try{const b=await readFile(join(ROOT,c==='/'?'index.html':c));r.writeHead(200,{'content-type':M[extname(c)]||'application/octet-stream'});r.end(b);}catch{r.writeHead(404).end();}});
await new Promise(r=>sv.listen(0,'127.0.0.1',r));
const br=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--hide-scrollbars']});
const pg=await br.newPage({viewport:{width:960,height:540}});
await pg.goto(`http://127.0.0.1:${sv.address().port}/index.html?skipIntro`,{waitUntil:'load',timeout:180000});
await pg.waitForFunction('window.__WALLY_READY__===true',null,{timeout:180000});
await pg.waitForTimeout(3000);
console.log(JSON.stringify(await pg.evaluate(()=>{
  const c=WALLY.ctx; const tri=(g)=>{let t=0;g.traverse(o=>{if(o.isMesh&&o.geometry?.index)t+=o.geometry.index.count/3*(o.isInstancedMesh?o.count:1);});return Math.round(t);};
  const roads=c.scene.getObjectByName('paths'), gr=c.scene.getObjectByName('city.ground');
  return { roadTris:tri(roads), roadMeshes:roads.children.length, groundTris:gr?tri(gr):null,
    pathStats: c.world.paths?.stats ?? (c.world.terrain?.paths?.stats ?? null),
    sceneTris: tri(c.scene), info: c.renderer.info.render };
})));
await br.close(); sv.close();
