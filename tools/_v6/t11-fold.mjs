/* what is below the fold in Places, at each size */
import { boot } from './lib.mjs';
for (const [tag,w,h,dsf,touch] of [['portrait',390,844,3,true],['landscape',844,390,3,true],['desktop',1400,900,2,false]]) {
  const B = await boot({ viewport:{width:w,height:h}, dsf, ctx: touch?{hasTouch:true,isMobile:true}:{} });
  const { page } = B;
  await page.evaluate(()=>{const st=WALLY.ctx.game.state;for(const l of WALLY.ctx.game.data.locations){st.known[l.id]=true;st.access[l.id]=true;}st.time=11*60;});
  await page.evaluate(()=>WALLY.ctx.ui.show('places'));
  await page.waitForTimeout(1400);
  const m = await page.evaluate(()=>{
    /* find the scroller that holds the app body */
    let sc=null; for (const e of document.querySelectorAll('*')) { if (e.scrollHeight - e.clientHeight > 8 && e.clientHeight > 100) { sc = e; break; } }
    const vis = (e)=>{const b=e.getBoundingClientRect();return b.bottom<=innerHeight+0.5 && b.top>=-0.5;};
    const items = [];
    const push=(sel,name)=>{const e=document.querySelector(sel); if(e){const b=e.getBoundingClientRect();items.push({name, top:+b.top.toFixed(1), bottom:+b.bottom.toFixed(1), visible: vis(e)});}};
    push('.w-map-svg','map');
    const btns=[...document.querySelectorAll('button')].filter(b=>/Full map|Point me|Look around/.test(b.textContent||''));
    for (const b of btns){const r=b.getBoundingClientRect();items.push({name:'btn:'+b.textContent.trim().slice(0,12),top:+r.top.toFixed(1),bottom:+r.bottom.toFixed(1),visible:vis(b)});}
    push('.w-label','district blurb');
    push('.w-card','place card');
    const cards=[...document.querySelectorAll('.w-card')];
    cards.forEach((c,i)=>{const r=c.getBoundingClientRect();items.push({name:'card'+i+':'+(c.querySelector('.t')?c.querySelector('.t').textContent:'').slice(0,14),top:+r.top.toFixed(1),bottom:+r.bottom.toFixed(1),visible:vis(c)});});
    return { vh: innerHeight, scroll: sc?{sh:sc.scrollHeight, ch:sc.clientHeight, over:+(sc.scrollHeight-sc.clientHeight).toFixed(0), cls:sc.className}:null, items };
  });
  console.log(`\n== ${tag} ${w}x${h} == vh ${m.vh}, scroller ${JSON.stringify(m.scroll)}`);
  for (const i of m.items) console.log(`   ${i.visible?'  visible':'BELOW-FOLD'}  ${i.name.padEnd(26)} ${i.top} .. ${i.bottom}`);
  await B.close();
}
