/* 6. THE USER'S DESIGN — metro vs walk vs Yoober, one short and one
   long journey, every number measured off the real board and the real
   road. */
import { boot, reporter } from './lib.mjs';
const R = reporter();
const B = await boot(); const { page } = B;

const board = async (from, to, opts = {}) => page.evaluate(async ([from, to, opts]) => {
  const c = WALLY.ctx;
  V.setup({ time: 10*60, energy: 100, money: 5000, bike: !!opts.bike, equip: opts.bike ? 'bike' : null });
  if (c.game.state.loc !== from) c.game.enter(from);
  const p = V.locPos(from); V.place(p[0], p[1]); await new Promise(r=>setTimeout(r,700));
  const host=document.createElement('div');host.style.cssText='position:fixed;left:-9999px';document.body.appendChild(host);
  c.ui.renderTravelModes(host,to,()=>{});
  const rows=[...host.querySelectorAll('.w-card')].map(e=>({t:(e.querySelector('.t')||{}).textContent,d:(e.querySelector('.d')||{}).textContent,m:(e.querySelector('.m')||{}).textContent,dis:!!e.disabled}));
  host.remove();
  return rows;
}, [from, to, opts]);

const ride = async (from, to, rowName, opts = {}) => page.evaluate(async ([from, to, rowName, opts]) => {
  const c = WALLY.ctx;
  V.setup({ time: 10*60, energy: 100, money: 5000, bike: !!opts.bike, equip: opts.bike ? 'bike' : null });
  if (c.game.state.loc !== from) c.game.enter(from);
  const p = V.locPos(from); V.place(p[0], p[1]); await new Promise(r=>setTimeout(r,700));
  const b = V.snap();
  const host=document.createElement('div');host.style.cssText='position:fixed;left:-9999px';document.body.appendChild(host);
  c.ui.renderTravelModes(host,to,()=>{});
  const row=[...host.querySelectorAll('.w-card')].find(e=>((e.querySelector('.t')||{}).textContent||'').trim()===rowName);
  if (!row) { host.remove(); return { missing: true }; }
  row.click(); await new Promise(r=>setTimeout(r,600)); host.remove();
  const a = V.snap();
  return { loc: a.loc, money: +(b.money-a.money).toFixed(2), energy: +(b.energy-a.energy).toFixed(3), mins: +(a.time-b.time).toFixed(1), arrived: a.loc===to };
}, [from, to, rowName, opts]);

const walkIt = async (from, to, waypoints, opts = {}) => page.evaluate(async ([from, to, waypoints, opts]) => {
  const c = WALLY.ctx;
  V.setup({ time: 10*60, energy: 100, money: 5000, bike: !!opts.bike, equip: opts.bike ? 'bike' : null });
  if (c.game.state.loc !== from) c.game.enter(from);
  const p = V.locPos(from); V.place(p[0], p[1]); await new Promise(r=>setTimeout(r,900));
  const host=document.createElement('div');host.style.cssText='position:fixed;left:-9999px';document.body.appendChild(host);
  c.ui.renderTravelModes(host,to,()=>{});
  const row=[...host.querySelectorAll('.w-card')].find(e=>((e.querySelector('.t')||{}).textContent||'').trim()===(opts.bike?'Bicycle':'On foot'));
  row.click(); await new Promise(r=>setTimeout(r,300)); host.remove();
  const quote = JSON.parse(JSON.stringify(c.game.route));
  const pts = waypoints.map(id => V.locPos(id));
  const w = await V.walkPath(pts, { stop: 10, run: !!opts.run, budget: opts.budget ?? 300000, legBudget: 70000 });
  /* close the journey at the door the way a player does */
  let entered = null;
  if (Math.hypot(w.pos[0]-V.locPos(to)[0], w.pos[1]-V.locPos(to)[1]) < 30) entered = c.game.enter(to);
  return { quote, ...w, entered, endLoc: c.game.state.loc };
}, [from, to, waypoints, opts]);

async function journey(tag, from, to, waypoints, opts = {}) {
  console.log(`\n================ ${tag}: ${from} -> ${to} ================`);
  const rows = await board(from, to, { bike: true });
  for (const r of rows) console.log('   BOARD ', String(r.t).padEnd(20), String(r.m).padEnd(10), r.d, r.dis?'[X]':'');
  const foot = await walkIt(from, to, waypoints, { run: !!opts.run, budget: opts.budget });
  console.log(`   WALK   quote ${foot.quote.energy} e / ${foot.quote.metres} m / ~${foot.quote.mins} min`);
  console.log(`          MEASURED: ${foot.odo} m of road, ${foot.energy} energy, ${foot.mins} game-min, waypoints ${foot.reached}/${foot.of}, ended at ${foot.endLoc}`);
  const bike = opts.bike === false ? null : await walkIt(from, to, waypoints, { bike: true, run: !!opts.run, budget: opts.budget });
  if (bike) console.log(`   BIKE   quote ${bike.quote.energy} e / ~${bike.quote.mins} min · MEASURED ${bike.odo} m, ${bike.energy} energy, ${bike.mins} game-min, ended at ${bike.endLoc}`);
  const metro = await ride(from, to, 'Metro');
  const yoo = await ride(from, to, 'Yoober');
  console.log(`   METRO  $${metro.money}  ${metro.energy} energy  ${metro.mins} min  arrived=${metro.arrived}`);
  console.log(`   YOOBER $${yoo.money}  ${yoo.energy} energy  ${yoo.mins} min  arrived=${yoo.arrived}`);
  return { rows, foot, bike, metro, yoo };
}

/* SHORT: City Library -> Property Office, 1 hop */
const S = await journey('SHORT', 'library', 'propertyoffice', ['propertyoffice'], { run: true, budget: 90000 });
/* LONG: City Library -> City Treasury, 6 hops, right across the island */
const L = await journey('LONG', 'library', 'treasury', ['bank','broker','mineral','exchange','treasury'], { run: true, budget: 420000 });

console.log('\n================ THE TRADE, MEASURED ================');
for (const [tag, J] of [['SHORT', S], ['LONG', L]]) {
  console.log(`${tag}  walk ${J.foot.energy} e / $0 / ${J.foot.mins} min   ·   metro ${J.metro.energy} e / $${J.metro.money} / ${J.metro.mins} min   ·   yoober ${J.yoo.energy} e / $${J.yoo.money} / ${J.yoo.mins} min   ·   bike ${J.bike?J.bike.energy:'-'} e / $0 / ${J.bike?J.bike.mins:'-'} min`);
  R.ok(J.foot.energy > J.metro.energy, `${tag}: walking is more tiring than the Metro (${J.foot.energy} vs ${J.metro.energy})`);
  R.ok(J.metro.money > 0 && J.metro.money < J.yoo.money / 3, `${tag}: the Metro costs little money next to a Yoober ($${J.metro.money} vs $${J.yoo.money})`);
  R.ok(J.yoo.energy < 1.5 && J.yoo.money > 20, `${tag}: the Yoober is the expensive, effortless escape`);
  if (J.bike) R.ok(J.bike.energy < J.foot.energy * 0.6, `${tag}: the bike is the reward — ${J.bike.energy} e vs ${J.foot.energy} e on foot`);
}
R.ok(L.yoo.money / S.yoo.money > 2.5, `Yoober scales with distance ($${S.yoo.money} -> $${L.yoo.money})`);
await B.close();
console.log(`\n${R.fails} failure(s). page errors: ${B.errs.length}`, B.errs.slice(0,6).join(' | '));
