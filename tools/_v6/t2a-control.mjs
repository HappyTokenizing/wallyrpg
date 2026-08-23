/* 2 CONTROL · 3 CAP · 4 RE-TAP · 5 SLEEP — all with real movement. */
import { boot, reporter } from './lib.mjs';
const R = reporter();
const B = await boot();
const { page } = B;

const RATE = await page.evaluate(() => WALLY.ctx.game.data.strideCost('walk', null));
console.log('foot rate e/m =', RATE, ' HOP_METRES =', await 0);

/* ============ 2. THE CONTROL ============ */
console.log('\n===== 2. SAME ROAD, ROUTE vs NO ROUTE =====');
const ROAD = { ax: -370.8, az: 203.4, bx: -257.4, bz: 226.8 };   // apartment <-> Noodle Cart Alley

async function arm(routed) {
  return await page.evaluate(async ([routed, road]) => {
    V.setup({ time: 9 * 60 });
    V.place(road.ax, road.az);
    await new Promise(r => setTimeout(r, 900));
    if (routed) {
      const host = document.createElement('div'); host.style.cssText='position:fixed;left:-9999px';
      document.body.appendChild(host);
      WALLY.ctx.ui.renderTravelModes(host, 'treasury', () => {});
      const foot = [...host.querySelectorAll('.w-card')].find(e => ((e.querySelector('.t')||{}).textContent||'').trim()==='On foot');
      foot.click(); await new Promise(r=>setTimeout(r,250)); host.remove();
    } else {
      WALLY.ctx.game.clearRoute('control-arm-B');
      WALLY.ctx.ui.setDestination(null);
    }
    const live = !!WALLY.ctx.game.route;
    const out = await V.walkRoad(road.ax, road.az, road.bx, road.bz, 200, { budget: 150000, stop: 5, run: true });
    return { ...out, live, arrow: V.arrow().all };
  }, [routed, ROAD]);
}
const A = await arm(true);
const Bm = await arm(false);
console.log(`  WITH a route   odo ${A.odo} m  energy ${A.energy}  e/m ${(A.energy/A.odo).toFixed(5)}  route live: ${A.live}`);
console.log(`  arrow: ${A.arrow}`);
console.log(`  NO route       odo ${Bm.odo} m  energy ${Bm.energy}  e/m ${(Bm.energy/Bm.odo).toFixed(5)}  route live: ${Bm.live}`);
console.log(`  arrow: ${Bm.arrow}`);
R.ok(A.live === true && Bm.live === false, 'the two arms really differ in route state');
R.ok(Bm.energy > 0, 'the SAME road with NO route is charged (was 0.00)', `${Bm.energy} e over ${Bm.odo} m`);
const perA = A.energy / A.odo, perB = Bm.energy / Bm.odo;
R.ok(Math.abs(perA - perB) / perA < 0.02, `per-metre cost matches route vs no route (${perA.toFixed(5)} vs ${perB.toFixed(5)})`);
R.ok(Math.abs(perB - RATE) / RATE < 0.02, `no-route rate is the table's foot rate ${RATE}`);


await B.close();
console.log(`\n${R.fails} failure(s). page errors: ${B.errs.length}`, B.errs.slice(0,6).join(' | '));
