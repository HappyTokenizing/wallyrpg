/* 6b. THE LONG JOURNEY, walked for real — library -> City Treasury. */
import { boot, reporter } from './lib.mjs';
const R = reporter();
const B = await boot(); const { page } = B;
const WAY = ['bank','broker','mineral','exchange','treasury'];

const walkIt = async (bike) => page.evaluate(async ([WAY, bike]) => {
  const c = WALLY.ctx;
  V.setup({ time: 9*60, energy: 100, money: 5000, bike: !!bike, equip: bike ? 'bike' : null });
  if (c.game.state.loc !== 'library') c.game.enter('library');
  const p = V.locPos('library'); V.place(p[0], p[1]); await new Promise(r=>setTimeout(r,1200));
  const host=document.createElement('div');host.style.cssText='position:fixed;left:-9999px';document.body.appendChild(host);
  c.ui.renderTravelModes(host,'treasury',()=>{});
  const row=[...host.querySelectorAll('.w-card')].find(e=>((e.querySelector('.t')||{}).textContent||'').trim()===(bike?'Bicycle':'On foot'));
  row.click(); await new Promise(r=>setTimeout(r,300)); host.remove();
  const quote = JSON.parse(JSON.stringify(c.game.route));
  const w = await V.walkPath(WAY.map(id=>V.locPos(id)), { stop: 12, run: true, budget: 300000, legBudget: 65000 });
  let entered = null;
  const t = V.locPos('treasury');
  if (Math.hypot(w.pos[0]-t[0], w.pos[1]-t[1]) < 40) entered = c.game.enter('treasury');
  return { quote, odo: w.odo, energy: w.energy, mins: w.mins, reached: w.reached, of: w.of, stops: w.stops.length, entered, endLoc: c.game.state.loc, pos: w.pos, route: c.game.route };
}, [WAY, bike]);

const ride = async (rowName) => page.evaluate(async ([rowName]) => {
  const c = WALLY.ctx;
  V.setup({ time: 9*60, energy: 100, money: 5000 });
  if (c.game.state.loc !== 'library') c.game.enter('library');
  const p = V.locPos('library'); V.place(p[0], p[1]); await new Promise(r=>setTimeout(r,600));
  const b = V.snap();
  const host=document.createElement('div');host.style.cssText='position:fixed;left:-9999px';document.body.appendChild(host);
  c.ui.renderTravelModes(host,'treasury',()=>{});
  const row=[...host.querySelectorAll('.w-card')].find(e=>((e.querySelector('.t')||{}).textContent||'').trim()===rowName);
  row.click(); await new Promise(r=>setTimeout(r,700)); host.remove();
  const a = V.snap();
  c.ui.closeAll?.();
  return { money:+(b.money-a.money).toFixed(2), energy:+(b.energy-a.energy).toFixed(3), mins:+(a.time-b.time).toFixed(1), arrived: a.loc==='treasury' };
}, [rowName]);

const foot = await walkIt(false);
console.log('WALK  quote', JSON.stringify(foot.quote));
console.log(`      MEASURED ${foot.odo} m of road, ${foot.energy} e, ${foot.mins} game-min, waypoints ${foot.reached}/${foot.of}, sidesteps ${foot.stops}, ended at ${foot.endLoc}`);
const bikeR = await walkIt(true);
console.log('BIKE  quote', JSON.stringify(bikeR.quote));
console.log(`      MEASURED ${bikeR.odo} m, ${bikeR.energy} e, ${bikeR.mins} game-min, waypoints ${bikeR.reached}/${bikeR.of}, ended at ${bikeR.endLoc}`);
const metro = await ride('Metro');
const yoo = await ride('Yoober');
console.log('METRO ', JSON.stringify(metro));
console.log('YOOBER', JSON.stringify(yoo));
R.ok(foot.odo > 500, 'the long walk really happened', String(foot.odo));
R.ok(foot.energy > metro.energy, `walking is more tiring than the Metro (${foot.energy} vs ${metro.energy})`);
R.ok(metro.money < yoo.money/5, `the Metro is cheap next to a Yoober ($${metro.money} vs $${yoo.money})`);
R.ok(yoo.energy < 1.5, 'the Yoober costs almost no energy');
R.ok(bikeR.energy < foot.energy*0.45, `the bike is the reward (${bikeR.energy} e vs ${foot.energy} e)`);
await B.close();
console.log(`\n${R.fails} failure(s). page errors: ${B.errs.length}`, B.errs.slice(0,4).join(' | '));
