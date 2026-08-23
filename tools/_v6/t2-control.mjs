/* 2. THE CONTROL — one fixed road, walked twice: routed and unrouted. */
import { boot, reporter } from './lib.mjs';
const R = reporter();
const B = await boot(); const { page } = B;
const RATE = await page.evaluate(() => WALLY.ctx.game.data.strideCost('walk', null));
/* City Library <-> Property Office: 107 m of clean street, verified
   traversable in both directions by tools/_v6/t2probe.mjs */
const ROAD = { ax: -273.6, az: -19.8, bx: -225.0, bz: 75.6 };
const TARGET = 200;

async function arm(routed) {
  return await page.evaluate(async ([routed, road, TARGET]) => {
    const c = WALLY.ctx;
    V.setup({ time: 9 * 60 });
    if (c.game.state.loc !== 'library') c.game.enter('library');
    V.place(road.ax, road.az);
    await new Promise(r => setTimeout(r, 1000));
    if (routed) {
      const host = document.createElement('div'); host.style.cssText='position:fixed;left:-9999px';
      document.body.appendChild(host);
      c.ui.renderTravelModes(host, 'treasury', () => {});
      [...host.querySelectorAll('.w-card')].find(e => ((e.querySelector('.t')||{}).textContent||'').trim()==='On foot').click();
      await new Promise(r=>setTimeout(r,250)); host.remove();
    } else { c.game.clearRoute('control-B'); c.ui.setDestination(null); }
    const live = !!c.game.route;
    const out = await V.walkRoad(road.ax, road.az, road.bx, road.bz, TARGET, { budget: 180000, legBudget: 40000, stop: 6, run: true });
    return { ...out, live, arrow: V.arrow().all, equipped: c.game.state.rides.equipped };
  }, [routed, ROAD, TARGET]);
}
const A = await arm(true);
const N = await arm(false);
console.log('foot rate from the table:', RATE, 'e/m');
console.log(`\n  WITH a route   odo ${A.odo} m  energy ${A.energy}  e/m ${(A.energy/A.odo).toFixed(5)}  live=${A.live}`);
console.log(`     arrow: ${A.arrow}`);
console.log(`  NO route       odo ${N.odo} m  energy ${N.energy}  e/m ${(N.energy/N.odo).toFixed(5)}  live=${N.live}`);
console.log(`     arrow: ${N.arrow}`);
R.ok(A.live === true && N.live === false, 'the two arms really differ in route state');
R.ok(A.odo > 150 && N.odo > 150, 'both arms actually covered the road', `${A.odo} / ${N.odo}`);
R.ok(N.energy > 0, 'the SAME road with NO route is charged (it was 0.00)', `${N.energy} e over ${N.odo} m`);
const pa = A.energy / A.odo, pn = N.energy / N.odo;
R.ok(Math.abs(pa - pn) / pa < 0.02, `per-metre cost MATCHES routed vs unrouted (${pa.toFixed(5)} vs ${pn.toFixed(5)})`);
R.ok(Math.abs(pn - RATE) / RATE < 0.02, `unrouted rate is the table's own foot rate (${RATE})`);
/* normalise to the same distance so the headline is comparable */
console.log(`\n  normalised to 200 m:  routed ${(pa*200).toFixed(2)} e   unrouted ${(pn*200).toFixed(2)} e   (was 8.08 vs 0.00)`);
await B.close();
console.log(`\n${R.fails} failure(s). page errors: ${B.errs.length}`, B.errs.slice(0,6).join(' | '));
