import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const ROOT='/Users/herwig/Documents/GitHub/wallyrpg';
const M={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8'};
const s=createServer(async(rq,rs)=>{try{const c=decodeURIComponent(rq.url.split('?')[0]);
const b=await readFile(join(ROOT,c==='/'?'index.html':c));rs.writeHead(200,{'content-type':M[extname(c)]||'application/octet-stream','cache-control':'no-store'});rs.end(b);}catch{rs.writeHead(404).end();}});
await new Promise(r=>s.listen(0,'127.0.0.1',r)); const P=s.address().port;
const br=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-gpu-rasterization','--force-color-profile=srgb','--hide-scrollbars','--mute-audio']});
const pg=await br.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
const errs=[]; pg.on('pageerror',e=>errs.push(e.message.split('\n')[0]));
pg.on('console',m=>{if(m.type()==='error')errs.push('con: '+m.text().slice(0,140));});
await pg.goto(`http://127.0.0.1:${P}/index.html?skipIntro`,{waitUntil:'load',timeout:120000});
await pg.waitForFunction('window.__WALLY_READY__===true',{timeout:180000});
await pg.waitForTimeout(4000);
// walk a bit so it is real gameplay, not a frozen spawn
await pg.keyboard.down('KeyW'); await pg.waitForTimeout(2500); await pg.keyboard.up('KeyW');
await pg.waitForTimeout(3000);
const st=await pg.evaluate(()=>{
  const c=window.WALLY.ctx; const info=c.renderer?.info||c.render?.renderer?.info;
  return { fps: window.__WALLY_PERF__?.fps, ms: window.__WALLY_PERF__?.ms,
    calls: window.__WALLY_PERF__?.calls, tris: window.__WALLY_PERF__?.tris,
    infoCalls: info?.render?.calls, infoTris: info?.render?.triangles,
    progs: info?.programs?.length, pos:[+c.wally.root.position.x.toFixed(1),+c.wally.root.position.z.toFixed(1)],
    npcQueued: c.npc?.queued, quality: c.quality?.name };
});
console.log(JSON.stringify(st,null,1));
if(errs.length)console.log('ERRORS:',errs.slice(0,6).join(' | ')); else console.log('no page errors');
await pg.screenshot({path: join(ROOT,'shots','vj-gameplay-1600.png')});
console.log('wrote shots/vj-gameplay-1600.png');
await br.close(); s.close();
