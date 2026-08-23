import { boot, reporter } from './lib.mjs';
const B = await boot(); const { page } = B;
const ROAD = { ax: -370.8, az: 203.4, bx: -257.4, bz: 226.8 };
for (const routed of [true, false, true, false]) {
  const out = await page.evaluate(async ([routed, road]) => {
    V.setup({ time: 9*60 });
    V.place(road.ax, road.az);
    await new Promise(r=>setTimeout(r,900));
    if (routed) {
      const host=document.createElement('div');host.style.cssText='position:fixed;left:-9999px';document.body.appendChild(host);
      WALLY.ctx.ui.renderTravelModes(host,'treasury',()=>{});
      [...host.querySelectorAll('.w-card')].find(e=>((e.querySelector('.t')||{}).textContent||'').trim()==='On foot').click();
      await new Promise(r=>setTimeout(r,250)); host.remove();
    } else { WALLY.ctx.game.clearRoute('x'); WALLY.ctx.ui.setDestination(null); }
    const trace=[]; const c=WALLY.ctx; const m0=c.game.state.stats.metres;
    V.aim(road.bx, road.bz, { stop: 5, run: true });
    for (let i=0;i<80;i++){ await new Promise(r=>setTimeout(r,250));
      const p=c.wally.position; trace.push([+p.x.toFixed(1),+p.z.toFixed(1),+(c.game.state.stats.metres-m0).toFixed(1)]);
      if (Math.hypot(road.bx-p.x, road.bz-p.z)<5) break; }
    V.halt();
    return { routed, trace: trace.filter((_,i)=>i%8===0).concat([trace[trace.length-1]]), n: trace.length, loc: c.game.state.loc,
      route: c.game.route ? c.game.route.to : null };
  }, [routed, ROAD]);
  console.log(out.routed ? 'ROUTED' : 'NOROUTE', 'loc', out.loc, 'route', out.route, 'samples', out.n);
  console.log('   ', JSON.stringify(out.trace));
}
await B.close();
