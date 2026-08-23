import { chromium } from 'playwright-core';
import { serve } from './lib.mjs';
const OUT='/Users/herwig/Documents/GitHub/wallyrpg/shots/vj';
const { server, port } = await serve();
const browser = await chromium.launch({ channel:'chrome', args:['--enable-unsafe-swiftshader','--hide-scrollbars'] });
for (const [tag,vp,touch] of [['390',{width:390,height:844},true],['desk',{width:1440,height:900},false]]){
  const ctx = await browser.newContext({ viewport:vp, hasTouch:touch, isMobile:touch, deviceScaleFactor:3 });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`,{waitUntil:'load',timeout:120000});
  await page.waitForFunction('window.__WALLY_READY__===true',{timeout:120000});
  await page.waitForTimeout(3000);
  await page.evaluate(()=>{WALLY.ctx.ui.closeAll();WALLY.ctx.ui.dialogue({speaker:'Wally',portrait:'wally',text:['Twenty minutes and a bicycle. That is all I need.']});});
  await page.waitForTimeout(1800);
  const r = await page.evaluate(()=>{const e=document.querySelector('.w-dlg');const q=e.getBoundingClientRect();return {x:q.x,y:q.y,w:q.width,h:q.height};});
  await page.screenshot({path:`${OUT}/dlg-wally-${tag}.png`, clip:{x:Math.max(0,r.x-4),y:Math.max(0,r.y-4),width:Math.min(vp.width-r.x+4,r.w+8),height:r.h+8}});
  console.log(tag,'dlg rect',JSON.stringify(r));
  await ctx.close();
}
await browser.close(); server.close();
