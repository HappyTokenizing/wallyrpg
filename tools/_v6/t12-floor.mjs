/* Can a wandering player beat the road tax? Two candidate holes. */
import { boot, reporter } from './lib.mjs';
const R = reporter();
const B = await boot(); const { page } = B;
const ROAD = { ax: -273.6, az: -19.8, bx: -225.0, bz: 75.6 };

/* (a) THE ENERGY FLOOR. clamp(0,100) means the marginal metre at 0 is free. */
const floor = await page.evaluate(async ([road]) => {
  const c = WALLY.ctx;
  V.setup({ time: 10*60, energy: 2 });
  if (c.game.state.loc !== 'library') c.game.enter('library');
  V.place(road.ax, road.az); await new Promise(r=>setTimeout(r,900));
  const w = await V.walkRoad(road.ax, road.az, road.bx, road.bz, 200, { budget: 150000, legBudget: 40000, stop: 6, run: true });
  const at0 = V.snap().energy;
  const w2 = await V.walkRoad(road.ax, road.az, road.bx, road.bz, 200, { budget: 150000, legBudget: 40000, stop: 6, run: true });
  return { first: { odo: w.odo, e: w.energy }, at0, second: { odo: w2.odo, e: w2.energy }, end: V.snap().energy };
}, [ROAD]);
console.log('starting at 2.0 energy:', JSON.stringify(floor));
R.ok(floor.at0 === 0, 'the bar floors at 0', String(floor.at0));
R.ok(floor.second.e === 0 && floor.second.odo > 150, `at zero the road is FREE — ${floor.second.odo} m for ${floor.second.e} energy`);

/* (b) THE WARP GUARD. MAX_STEP_M = 40 at 8 Hz. */
const warp = await page.evaluate(() => {
  const c = WALLY.ctx, g = c.game, d = g.data;
  const speeds = { foot: 5.90, bicycle: 8.80, scooter: 13.20, motorcycle: 26.40 };
  const out = {};
  for (const k of Object.keys(speeds)) out[k] = +(40 / speeds[k]).toFixed(2);   // seconds of stall to clear 40 m
  /* and prove the guard is real, by hand */
  g.clearRoute('x'); g.state.energy = 100; g.resetStride();
  g.stride(0,0); g.stride(39,0);
  const under = 100 - g.state.energy;
  g.state.energy = 100; g.resetStride();
  g.stride(0,0); g.stride(41,0);
  const over = 100 - g.state.energy;
  return { stallSecondsToWarp: out, charged39: +under.toFixed(3), charged41: +over.toFixed(3), rate: d.strideCost('walk') };
});
console.log('warp guard:', JSON.stringify(warp));
R.ok(warp.charged39 > 1 && warp.charged41 === 0, '39 m in one sample is billed, 41 m is a free warp');
console.log('   a frame stall long enough to clear 40 m in one 8 Hz sample:', JSON.stringify(warp.stallSecondsToWarp), 'seconds');
await B.close();
console.log(`\n${R.fails} failure(s). page errors: ${B.errs.length}`);
