/* count colliding label boxes on the full map, in both trees */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { chromium } from 'playwright-core';
const ROOT = process.argv[2];
const TAGN = process.argv[3];
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css','.json':'application/json','.png':'image/png','.glsl':'text/plain','.wasm':'application/wasm','.ico':'image/x-icon','.svg':'image/svg+xml','.webp':'image/webp','.jpg':'image/jpeg'};
const server=createServer(async(rq,rs)=>{const c=decodeURIComponent((rq.url||'/').split('?')[0]);
 try{const p=join(ROOT,c==='/'?'index.html':c);const b=await readFile(p);rs.writeHead(200,{'content-type':MIME[extname(p)]||'application/octet-stream','cache-control':'no-store'});rs.end(b);}catch{rs.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const PORT=server.address().port;
const browser=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--hide-scrollbars','--mute-audio']});
for (const [tag,w,h,dsf,touch] of [['portrait',390,844,3,true],['landscape',844,390,3,true],['desktop',1400,900,2,false]]) {
  const ctxo=await browser.newContext({viewport:{width:w,height:h},deviceScaleFactor:dsf,...(touch?{hasTouch:true,isMobile:true}:{})});
  const page=await ctxo.newPage(); page.setDefaultTimeout(180000);
  await page.goto(`http://127.0.0.1:${PORT}/index.html?skipIntro`,{waitUntil:'load',timeout:180000});
  await page.waitForFunction('window.__WALLY_READY__===true',null,{timeout:180000});
  await page.waitForTimeout(3500);
  await page.evaluate(()=>{const st=WALLY.ctx.game.state;for(const l of WALLY.ctx.game.data.locations){st.known[l.id]=true;st.access[l.id]=true;}st.time=11*60;});
  for (const view of ['places','fullmap']) {
    await page.evaluate((v)=>{WALLY.ctx.ui.closeAll?.(); if(v==='places')WALLY.ctx.ui.show('places'); else WALLY.ctx.ui.openMap();},view);
    await page.waitForTimeout(1300);
    const m = await page.evaluate(()=>{
      const svg=document.querySelector('.w-map-svg'); if(!svg) return null;
      const box=svg.getBoundingClientRect();
      const texts=[...svg.querySelectorAll('text')].filter(t=>!t.classList.contains('wm-ico') && (t.textContent||'').trim().length>2);
      const boxes=texts.map(t=>{const b=t.getBoundingClientRect();return {t:t.textContent.trim(),x:b.x,y:b.y,w:b.width,h:b.height,fs:+getComputedStyle(t).fontSize.replace('px','')};})
        .filter(b=>b.w>0&&b.h>0);
      let pairs=0, area=0; const hit=new Set();
      for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){
        const a=boxes[i],b=boxes[j];
        const ox=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x);
        const oy=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);
        if(ox>1&&oy>2){pairs++;area+=ox*oy;hit.add(a.t);hit.add(b.t);}
      }
      /* labels struck by a PIN circle */
      const pins=[...svg.querySelectorAll('circle')].map(c=>c.getBoundingClientRect()).filter(b=>b.width>10);
      let struck=0; const st=new Set();
      for(const a of boxes){for(const p of pins){
        const ox=Math.min(a.x+a.w,p.x+p.width)-Math.max(a.x,p.x), oy=Math.min(a.y+a.h,p.y+p.height)-Math.max(a.y,p.y);
        if(ox>3&&oy>4){struck++;st.add(a.t);break;}}}
      return { mapW:+box.width.toFixed(1), mapH:+box.height.toFixed(1), bottom:+box.bottom.toFixed(1), vh:innerHeight,
        n:boxes.length, pairs, area:+area.toFixed(0), collided:hit.size, struckByPin:st.size,
        fsRange:[Math.min(...boxes.map(b=>b.fs)),Math.max(...boxes.map(b=>b.fs))],
        worst:[...hit].slice(0,8) };
    });
    console.log(`${TAGN} ${tag} ${view}:`, JSON.stringify(m));
  }
  await ctxo.close();
}
await browser.close(); server.close();
