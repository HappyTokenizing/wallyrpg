/* 12. DIALOGUE — Wally speaking and a client speaking, phone and desktop. */
import { boot } from './lib.mjs';
import { mkdirSync } from 'node:fs';
mkdirSync('/Users/herwig/Documents/GitHub/wallyrpg/shots/_v6', { recursive: true });
const SIZES = [['phone', 390, 844, 3, true], ['desktop', 1400, 900, 2, false]];
for (const [tag, w, h, dsf, touch] of SIZES) {
  const B = await boot({ viewport: { width: w, height: h }, dsf, ctx: touch ? { hasTouch: true, isMobile: true } : {} });
  const { page } = B;
  const client = await page.evaluate(() => {
    const cs = WALLY.ctx.game.data.clients; const c = cs.find(x=>x.id==='mabel') || cs[0];
    return { id: c.id, n: c.n, role: c.role || c.job || '' };
  });
  for (const who of ['wally', client.id]) {
    await page.evaluate(async ([who, n, role]) => {
      WALLY.ctx.ui.closeAll?.();
      WALLY.ctx.ui.dialogue({
        speaker: who === 'wally' ? 'Wally' : n,
        role: who === 'wally' ? 'You' : (role || 'Client'),
        portrait: who,
        text: ['Nine dollars on the Metro and a quarter of your day. Walking it is free and it costs you the morning.'],
      });
      await new Promise(r=>setTimeout(r,2600));
    }, [who, client.n, client.role]);
    await page.waitForTimeout(400);
    const geo = await page.evaluate(() => {
      const el = document.querySelector('.w-dlg'); if (!el) return null;
      const por = el.querySelector('.w-dlg-por');
      const svg = por ? por.querySelector('svg') : null;
      const r = (e)=>{const b=e.getBoundingClientRect();return {x:+b.x.toFixed(1),y:+b.y.toFixed(1),w:+b.width.toFixed(1),h:+b.height.toFixed(1)};};
      return { card: r(el), por: por?r(por):null, svg: svg?r(svg):null,
        svgClass: svg?svg.getAttribute('class'):null,
        hasRing: svg ? !!svg.querySelector('circle[stroke]') : false,
        hasClip: svg ? !!svg.querySelector('clipPath') : false,
        more: (el.querySelector('.w-dlg-more')||{}).textContent };
    });
    console.log(`${tag} / ${who}:`, JSON.stringify(geo));
    await page.screenshot({ path: `shots/_v6/dlg-${tag}-${who}.png` });
    /* a tight crop of just the card */
    if (geo) {
      const c = geo.card;
      await page.screenshot({ path: `shots/_v6/dlgcard-${tag}-${who}.png`,
        clip: { x: Math.max(0,c.x-6), y: Math.max(0,c.y-6), width: Math.min(w-c.x+6, c.w+12), height: Math.min(h-c.y+6, c.h+12) } });
    }
  }
  console.log(`${tag} page errors:`, B.errs.length, B.errs.slice(0,3).join(' | '));
  await B.close();
}
console.log('wrote shots/_v6/dlg*-*.png');
