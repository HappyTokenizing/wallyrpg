/* the ADVANCE row, which only exists on a multi-page card — I missed it
   first time by handing the dialogue a single page. */
import { boot } from './lib.mjs';
for (const [tag, w, h, dsf, touch] of [['phone',390,844,3,true],['desktop',1400,900,2,false]]) {
  const B = await boot({ viewport:{width:w,height:h}, dsf, ctx: touch?{hasTouch:true,isMobile:true}:{} });
  const { page } = B;
  for (const who of ['wally','mabel']) {
    const out = await page.evaluate(async ([who]) => {
      WALLY.ctx.ui.closeAll?.();
      WALLY.ctx.ui.dialogue({ speaker: who==='wally'?'Wally':'Mabel', role: who==='wally'?'You':'Retired teacher',
        portrait: who, text: ['Page one, which has a page after it.', 'Page two.'] });
      await new Promise(r=>setTimeout(r,2000));
      const el = document.querySelector('.w-dlg');
      const more = el.querySelector('.w-dlg-more');
      const key = more.querySelector('.key');
      const cs = key ? getComputedStyle(key) : null;
      const r=(e)=>{const b=e.getBoundingClientRect();return {x:+b.x.toFixed(1),y:+b.y.toFixed(1),w:+b.width.toFixed(1),h:+b.height.toFixed(1)};};
      return { moreText: (more.textContent||'').trim(), moreDisplay: getComputedStyle(more).display,
        keyHTML: key ? key.outerHTML.slice(0,200) : null, keyDisplay: cs?cs.display:null,
        keyBox: key?r(key):null, card: r(el), touchUI: !!(matchMedia('(pointer: coarse)').matches) };
    }, [who]);
    console.log(`${tag}/${who}:`, JSON.stringify(out));
    const c = out.card;
    await page.screenshot({ path: `shots/_v6/chip-${tag}-${who}.png`, clip: { x: Math.max(0,c.x-8), y: Math.max(0,c.y-8), width: Math.min(w-c.x+8,c.w+16), height: Math.min(h-c.y+8,c.h+16) } });
  }
  console.log(tag,'errors',B.errs.length, B.errs.slice(0,3).join(' | '));
  await B.close();
}
