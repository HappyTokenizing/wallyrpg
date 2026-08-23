import { chromium } from 'playwright-core';
import { serve } from './lib.mjs';
const { server, port } = await serve();
const browser = await chromium.launch({ channel:'chrome', args:['--enable-unsafe-swiftshader','--hide-scrollbars'] });
for(const [tag,vp] of [['portrait 390x844',{width:390,height:844}],['landscape 844x390',{width:844,height:390}],['small 360x640',{width:360,height:640}]]){
  const ctx = await browser.newContext({viewport:vp,hasTouch:true,isMobile:true});
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`,{waitUntil:'load',timeout:120000});
  await page.waitForFunction('window.__WALLY_READY__===true',{timeout:120000});
  await page.waitForTimeout(3000);
  const r = await page.evaluate(async ()=>{
    WALLY.ctx.ui.closeAll();
    WALLY.ctx.ui.dialogue({speaker:'Otto',text:['A line long enough to make the card its full height and then some more words after that.','Two.']});
    await new Promise(r=>setTimeout(r,1500));
    const out=[];
    for(const b of document.querySelectorAll('.w-touch .w-abtn')){
      const q=b.getBoundingClientRect(); const e=document.elementFromPoint(q.x+q.width/2,q.y+q.height/2);
      out.push({what:(b.querySelector('.cap')||{}).textContent||b.getAttribute('aria-label'),ok:!!(e&&b.contains(e)),hit:e?e.className:null});
    }
    const s=document.querySelector('.w-stick').getBoundingClientRect();
    const se=document.elementFromPoint(s.x+s.width/2,s.y+s.height/2);
    out.push({what:'stick',ok:!!(se&&(se.closest('.w-stickzone')||se.closest('.w-stick'))),hit:se?se.className:null});
    const d=document.querySelector('.w-dlg').getBoundingClientRect();
    return {out,dlg:[Math.round(d.x),Math.round(d.y),Math.round(d.width),Math.round(d.height)],vh:innerHeight,clipped:d.y<0||d.y+d.height>innerHeight};
  });
  console.log(`\n${tag}  card ${JSON.stringify(r.dlg)} vh=${r.vh} clipped=${r.clipped}`);
  for(const o of r.out) console.log(`   ${o.ok?'clear  ':'COVERED'}  ${o.what}  (${o.hit})`);
  await ctx.close();
}
await browser.close(); server.close();
