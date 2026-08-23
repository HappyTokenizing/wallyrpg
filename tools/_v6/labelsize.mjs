import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { chromium } from 'playwright-core';
const ROOT=process.argv[2], TAG=process.argv[3];
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css','.json':'application/json','.png':'image/png','.glsl':'text/plain','.wasm':'application/wasm','.ico':'image/x-icon','.svg':'image/svg+xml','.webp':'image/webp','.jpg':'image/jpeg'};
const server=createServer(async(rq,rs)=>{const c=decodeURIComponent((rq.url||'/').split('?')[0]);
 try{const p=join(ROOT,c==='/'?'index.html':c);const b=await readFile(p);rs.writeHead(200,{'content-type':MIME[extname(p)]||'application/octet-stream','cache-control':'no-store'});rs.end(b);}catch{rs.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r)); const PORT=server.address().port;
const browser=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader','--hide-scrollbars','--mute-audio']});
for (const [tag,w,h,dsf,touch] of [['portrait',390,844,3,true],['landscape',844,390,3,true]]) {
  const c2=await browser.newContext({viewport:{width:w,height:h},deviceScaleFactor:dsf,...(touch?{hasTouch:true,isMobile:true}:{})});
  const page=await c2.newPage(); page.setDefaultTimeout(180000);
  await page.goto(`http://127.0.0.1:${PORT}/index.html?skipIntro`,{waitUntil:'load'});
  await page.waitForFunction('window.__WALLY_READY__===true',null,{timeout:180000});
  await page.waitForTimeout(3500);
  await page.evaluate(()=>{const st=WALLY.ctx.game.state;for(const l of WALLY.ctx.game.data.locations){st.known[l.id]=true;st.access[l.id]=true;}st.time=11*60;});
  await page.evaluate(()=>{WALLY.ctx.ui.closeAll?.();WALLY.ctx.ui.openMap();});
  await page.waitForTimeout(1300);
  const m = await page.evaluate(()=>{
    const svg=document.querySelector('.w-map-svg');
    const vb=svg.getAttribute('viewBox').split(' ').map(Number);
    const box=svg.getBoundingClientRect();
    const ts=[...svg.querySelectorAll('text')].filter(t=>!t.classList.contains('wm-ico')&&(t.textContent||'').trim().length>2);
    const hs=ts.map(t=>t.getBoundingClientRect().height).filter(x=>x>0);
    const ws=ts.map(t=>t.getBoundingClientRect().width).filter(x=>x>0);
    /* island extent on screen: from the location pin circles */
    const pins=[...svg.querySelectorAll('circle')].map(c=>c.getBoundingClientRect()).filter(b=>b.width>10&&b.width<90);
    const px=Math.max(...pins.map(p=>p.x+p.width))-Math.min(...pins.map(p=>p.x));
    const py=Math.max(...pins.map(p=>p.y+p.height))-Math.min(...pins.map(p=>p.y));
    return { vb, mapCss:[+box.width.toFixed(1),+box.height.toFixed(1)],
      labelH:+(hs.reduce((a,b)=>a+b,0)/hs.length).toFixed(2), labelWmax:+Math.max(...ws).toFixed(1),
      pinSpanCss:[+px.toFixed(1),+py.toFixed(1)], pinD:+ (pins[0]?pins[0].width:0).toFixed(1), nPins:pins.length,
      inkPerIsland:+((hs.reduce((a,b)=>a+b,0)*0+ws.reduce((a,b)=>a+b,0)*(hs.reduce((a,b)=>a+b,0)/hs.length))/(px*py)).toFixed(3) };
  });
  console.log(TAG, tag, JSON.stringify(m));
  await c2.close();
}
await browser.close(); server.close();
