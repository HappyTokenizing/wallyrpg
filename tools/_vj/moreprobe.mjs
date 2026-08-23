import { chromium } from 'playwright-core';
import { serve } from './lib.mjs';
const { server, port } = await serve();
const browser = await chromium.launch({ channel:'chrome', args:['--enable-unsafe-swiftshader','--hide-scrollbars'] });
for (const [tag,vp,touch] of [['390',{width:390,height:844},true],['desk',{width:1440,height:900},false]]){
  const ctx = await browser.newContext({ viewport:vp, hasTouch:touch, isMobile:touch });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`,{waitUntil:'load',timeout:120000});
  await page.waitForFunction('window.__WALLY_READY__===true',{timeout:120000});
  await page.waitForTimeout(3000);
  await page.evaluate(()=>{WALLY.ctx.ui.closeAll();WALLY.ctx.ui.dialogue({speaker:'Wally',portrait:'wally',text:['One.']});});
  await page.waitForTimeout(2000);
  console.log(tag, JSON.stringify(await page.evaluate(async ()=>{
    const m=await import('/src/ui/touch.js');
    const more=document.querySelector('.w-dlg-more');
    return { touchUI:m.touchUI(), moreHTML: more?more.outerHTML:null,
      moreText: more?more.textContent:null,
      allDlgText:[...document.querySelectorAll('.w-dlg *')].map(e=>e.className+':'+([...e.childNodes].filter(n=>n.nodeType===3).map(n=>n.nodeValue).join('').trim())).filter(s=>s.split(':')[1]) };
  })));
  await ctx.close();
}
await browser.close(); server.close();
