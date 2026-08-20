import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const ROOT='/Users/herwig/Desktop/Claude files/wally-rpg';
const MIME={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml'};
const server=createServer(async(q,s)=>{try{const c=decodeURIComponent(q.url.split('?')[0]);const p=join(ROOT,c==='/'?'index.html':c);if(!p.startsWith(ROOT)){s.writeHead(403).end();return;}const b=await readFile(p);s.writeHead(200,{'content-type':MIME[extname(p)]||'application/octet-stream','cache-control':'no-store'});s.end(b);}catch{s.writeHead(404).end('nf');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const PORT=server.address().port;
const browser=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--force-color-profile=srgb','--hide-scrollbars','--mute-audio']});
const page=await browser.newPage({viewport:{width:1600,height:900}});
await page.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`,{waitUntil:'load',timeout:60000});
await page.waitForFunction('window.__WALLY_READY__===true',{timeout:45000});
await page.waitForTimeout(6000);
const cdp=await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval',{interval:100});
await cdp.send('Profiler.start');
await page.waitForTimeout(4000);
const {profile}=await cdp.send('Profiler.stop');
await browser.close(); server.close();
const self=new Map();
const byId=new Map(profile.nodes.map(n=>[n.id,n]));
const counts=new Map();
for(const id of profile.samples) counts.set(id,(counts.get(id)||0)+1);
const total=profile.samples.length;
const durMs=(profile.endTime-profile.startTime)/1000;
for(const [id,c] of counts){
  const n=byId.get(id); if(!n) continue;
  const f=n.callFrame;
  const key=`${f.functionName||'(anon)'}  ${(f.url||'').split('/').slice(-1)[0]}:${f.lineNumber+1}`;
  self.set(key,(self.get(key)||0)+c);
}
const rows=[...self.entries()].sort((a,b)=>b[1]-a[1]).slice(0,28);
console.log(`CPU self-time, ${durMs.toFixed(0)} ms wall, ${total} samples @100us`);
for(const [k,c] of rows){
  const ms=c/total*durMs;
  console.log(`  ${(ms/durMs*100).toFixed(1).padStart(5)}%  ${(ms).toFixed(0).padStart(5)} ms total   ${k}`);
}
