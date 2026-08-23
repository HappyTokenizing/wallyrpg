import { chromium } from 'playwright-core';
import { serve } from './lib.mjs';
const { server, port } = await serve();
const browser = await chromium.launch({ channel:'chrome', args:['--enable-unsafe-swiftshader','--hide-scrollbars'] });
const page = await browser.newPage({ viewport:{width:1280,height:760} });
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`,{waitUntil:'load',timeout:120000});
await page.waitForFunction('window.__WALLY_READY__===true',{timeout:120000});
await page.waitForTimeout(3000);
const before = await page.evaluate(async ()=>{
  const c=WALLY.ctx,g=c.game,st=g.state;
  for(const l of g.data.locations) st.known[l.id]=true;
  const host=document.createElement('div');document.body.appendChild(host);
  c.ui.renderTravelModes(host,'cafe',()=>{});
  [...host.querySelectorAll('.w-card')].find(e=>(e.querySelector('.t')||{}).textContent==='On foot').click();
  host.remove(); await new Promise(r=>setTimeout(r,200));
  g.save();
  return { route:g.route, arrow:(document.querySelector('.w-obj .t')||{}).textContent };
});
console.log('before reload:', JSON.stringify(before));
await page.reload({waitUntil:'load'});
await page.waitForFunction('window.__WALLY_READY__===true',{timeout:120000});
await page.waitForTimeout(3500);
const after = await page.evaluate(()=>({ route:WALLY.ctx.game.route, arrow:(document.querySelector('.w-obj .t')||{}).textContent, sub:(document.querySelector('.w-obj .d')||{}).textContent }));
console.log('after  reload:', JSON.stringify(after));
// and does stride still charge toward the invisible destination?
const charge = await page.evaluate(()=>{
  const g=WALLY.ctx.game,p=WALLY.ctx.wally.root.position;
  g.resetStride(); g.stride(p.x,p.z);
  let t=0; for(let i=1;i<=10;i++) t+=g.stride(p.x+i*20,p.z);
  return { charged:+t.toFixed(3), route:g.route, energy:+g.state.energy.toFixed(2) };
});
console.log('200 m walked after the reload:', JSON.stringify(charge));
await browser.close(); server.close();
