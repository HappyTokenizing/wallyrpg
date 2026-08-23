import { chromium } from 'playwright-core';
import { serve } from './lib.mjs';
const { server, port } = await serve();
const browser = await chromium.launch({ channel:'chrome', args:['--enable-unsafe-swiftshader','--hide-scrollbars'] });
const page = await browser.newPage({viewport:{width:1280,height:760}});
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`,{waitUntil:'load',timeout:120000});
await page.waitForFunction('window.__WALLY_READY__===true',{timeout:120000});
await page.waitForTimeout(3000);
console.log(JSON.stringify(await page.evaluate(()=>{
  const g=WALLY.ctx.game,D=g.data,st=g.state;
  for(const l of D.locations) st.known[l.id]=true;
  st.energy=100; st.time=600; st.money=5000; g.clearRoute('x');
  if(st.loc!=='apartment') g.enter('apartment');
  const a=D.locationById.apartment.world,b=D.locationById.treasury.world;
  const dx=b.x-a.x,dz=b.z-a.z,L=Math.hypot(dx,dz);
  const walkFull=()=>{g.resetStride();g.stride(a.x,a.z);for(let d=30;d<=L;d+=30)g.stride(a.x+dx/L*d,a.z+dz/L*d);};
  const q1=g.travel('treasury','walk'); walkFull();
  const first={quote:q1.energy,spent:+g.route.spent.toFixed(2),energy:+st.energy.toFixed(2)};
  const q2=g.travel('treasury','walk'); walkFull();
  const second={spent:+g.route.spent.toFixed(2),energy:+st.energy.toFixed(2)};
  const q3=g.travel('treasury','walk'); walkFull();
  const third={spent:+g.route.spent.toFixed(2),energy:+st.energy.toFixed(2)};
  return {quotedEnergy:q1.energy, afterOneWalk:first, afterRepick1:second, afterRepick2:third,
    totalBurned:+(100-st.energy).toFixed(2), stillAtApartment:st.loc};
},)));
await browser.close(); server.close();
