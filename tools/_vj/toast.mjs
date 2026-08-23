import { chromium } from 'playwright-core';
import { serve } from './lib.mjs';
const { server, port } = await serve();
const browser = await chromium.launch({ channel:'chrome', args:['--enable-unsafe-swiftshader','--hide-scrollbars'] });
for(const [tag,vp,t] of [['touch',{width:390,height:844},true],['desk',{width:1280,height:760},false]]){
  const ctx = await browser.newContext({viewport:vp,hasTouch:t,isMobile:t});
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`,{waitUntil:'load',timeout:120000});
  await page.waitForFunction('window.__WALLY_READY__===true',{timeout:120000});
  await page.waitForTimeout(3000);
  const out = await page.evaluate(async ()=>{
    const m = await import('/src/ui/touch.js');
    const seen=[];
    const u=WALLY.ctx.ui;
    u.toast('Your phone buzzed. '+m.actionPhrase('phone',{cap:true})+'.','token');
    await new Promise(r=>setTimeout(r,600));
    for(const e of document.querySelectorAll('.w-toast, .w-toast *')) if(e.textContent) seen.push(e.textContent.trim());
    /* and: is the word "Phone" visible anywhere on screen right now? */
    const visiblePhone=[...document.querySelectorAll('*')].filter(e=>{
      const own=[...e.childNodes].filter(n=>n.nodeType===3).map(n=>n.nodeValue).join('').trim();
      if(own!=='Phone')return false; const r=e.getBoundingClientRect(); const cs=getComputedStyle(e);
      return r.width>0&&r.height>0&&cs.display!=='none'&&cs.visibility!=='hidden'&&+cs.opacity>0;
    }).length;
    return { touchUI:m.touchUI(), phrase:m.actionPhrase('phone',{cap:true}), toast:[...new Set(seen)].slice(0,3), visiblePhoneWords:visiblePhone };
  });
  console.log(tag, JSON.stringify(out));
  await ctx.close();
}
await browser.close(); server.close();
