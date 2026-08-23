import { chromium } from 'playwright-core';
import { serve } from './lib.mjs';
const { server, port } = await serve();
const browser = await chromium.launch({ channel:'chrome', args:['--enable-unsafe-swiftshader','--hide-scrollbars'] });
const page = await browser.newPage({ viewport:{width:1280,height:760} });
page.on('pageerror',e=>console.log('PE',e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`,{waitUntil:'load',timeout:120000});
await page.waitForFunction('window.__WALLY_READY__===true',{timeout:120000});
await page.waitForTimeout(3500);
console.log('input fn wiring:', JSON.stringify(await page.evaluate(()=>{
  const c=WALLY.ctx; const ctl=c.wally.controller;
  return { hasInputFn: typeof ctl._inputFn, hasTHREE: !!WALLY.THREE, camType: c.camera.type,
    camHasGWD: typeof c.camera.getWorldDirection };
})));
// try steering straight for 4 s in 4 different sign conventions, measure displacement
for (const conv of ['WORLD','WORLDNEG','x=right,z=fwd','x=-right,z=fwd']){
  const d = await page.evaluate(async (cv)=>{
    const c=WALLY.ctx; const p0={x:c.wally.root.position.x,z:c.wally.root.position.z};
    const T = {x:p0.x+120,z:p0.z};             // 120 m east
    const f = new WALLY.THREE.Vector3();
    c.ui.setBaseInput(()=>{
      const w=c.wally.root.position; c.camera.getWorldDirection(f); f.y=0; f.normalize();
      const rx=-f.z, rz=f.x;
      const dx=T.x-w.x, dz=T.z-w.z, L=Math.hypot(dx,dz)||1;
      const ux=dx/L, uz=dz/L;
      let ix, iz;
      if(cv==='WORLD'){ix=ux;iz=uz;}
      else if(cv==='WORLDNEG'){ix=-ux;iz=-uz;}
      else {ix=ux*rx+uz*rz; iz=ux*f.x+uz*f.z;
        if(cv.includes('-right'))ix=-ix; if(cv.includes('-fwd'))iz=-iz;}
      return {x:ix,z:iz,jump:false,jumpHeld:false,run:true};
    });
    await new Promise(r=>setTimeout(r,4000));
    const p1={x:c.wally.root.position.x,z:c.wally.root.position.z};
    c.ui.setBaseInput(null);
    const before=Math.hypot(T.x-p0.x,T.z-p0.z), after=Math.hypot(T.x-p1.x,T.z-p1.z);
    // teleport back
    c.wally.warpTo(p0.x,c.wally.root.position.y+0.3,p0.z,{});
    return {conv:cv, closedBy:+(before-after).toFixed(1), moved:+Math.hypot(p1.x-p0.x,p1.z-p0.z).toFixed(1)};
  }, conv);
  console.log(JSON.stringify(d));
  await page.waitForTimeout(600);
}
await browser.close(); server.close();
