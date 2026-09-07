import { boot } from './lib.mjs';
import { loadavg } from 'node:os';
const la = () => +loadavg()[0].toFixed(2);
console.log('load before boot', la());
const { page, close } = await boot({ query:'skipIntro&shot=1', viewport:{width:1600,height:900}, settle:6000 });
await page.evaluate(() => { WALLY.debug.setHour(13);
  const info = WALLY.ctx.render?.renderer?.info || WALLY.ctx.renderer.info;
  window.__S = (ms) => new Promise(r => { const d=[],c=[],t=[]; let last=performance.now(); const t0=last;
    const tick=()=>{const n=performance.now(); d.push(n-last); last=n; c.push(info.render.calls); t.push(info.render.triangles);
      if(n-t0<ms) requestAnimationFrame(tick); else { const s=d.slice(5).sort((a,b)=>a-b), cs=c.slice(5).sort((a,b)=>a-b), ts=t.slice(5).sort((a,b)=>a-b);
        r({ n:s.length, fps:+(1000/s[s.length>>1]).toFixed(1), msP50:+s[s.length>>1].toFixed(2), msP95:+s[Math.floor(s.length*0.95)].toFixed(2),
            calls:cs[cs.length>>1], tris:ts[ts.length>>1] }); } };
    requestAnimationFrame(tick); }); });
for (const [n,a] of [['ground',0],['alt200',200]]) {
  await page.evaluate(x=>{ WALLY.debug.balloon(false); if(x>0){WALLY.debug.balloon({alt:x}); WALLY.debug.balloonStick(0,0);} }, a);
  await page.waitForTimeout(6000);
  const l0 = la(); const r = await page.evaluate(()=>window.__S(6000)); const l1 = la();
  console.log(n, JSON.stringify({ ...r, loadBefore:l0, loadAfter:l1 }));
}
await close();
console.log('load after', la());
