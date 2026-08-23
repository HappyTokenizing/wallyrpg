/* 4. RE-TAP · 5. SLEEP · the `left` floor. */
import { boot, reporter } from './lib.mjs';
const R = reporter();
const B = await boot(); const { page } = B;
const RATE = await page.evaluate(() => WALLY.ctx.game.data.strideCost('walk', null));
const ROAD = { ax: -273.6, az: -19.8, bx: -225.0, bz: 75.6 };

/* ===== 4. RE-TAP THE SAME ROW, THREE TIMES ===== */
const out = await page.evaluate(async ([road]) => {
  const c = WALLY.ctx;
  V.setup({ time: 10 * 60, energy: 100 });
  if (c.game.state.loc !== 'library') c.game.enter('library');
  V.place(road.ax, road.az);
  await new Promise(r => setTimeout(r, 1000));
  const tap = () => new Promise(async (res) => {
    const host = document.createElement('div'); host.style.cssText='position:fixed;left:-9999px';
    document.body.appendChild(host);
    c.ui.renderTravelModes(host, 'treasury', () => {});
    const row = [...host.querySelectorAll('.w-card')].find(e => ((e.querySelector('.t')||{}).textContent||'').trim()==='On foot');
    const label = { t: (row.querySelector('.t')||{}).textContent, d: (row.querySelector('.d')||{}).textContent };
    row.click();
    setTimeout(() => { host.remove(); res({ label, route: JSON.parse(JSON.stringify(c.game.route)) }); }, 250);
  });
  const evs = []; c.bus.on('route', (e) => evs.push({ kind: e.kind, to: e.to, resumed: e.resumed, spent: e.spent, why: e.why }));
  const e0 = V.snap().energy, m0 = V.snap().metres;
  const legs = []; let quote = null;
  for (let i = 0; i < 3; i++) {
    const t = await tap();
    if (i === 0) quote = t.route;
    const w = await V.walkRoad(road.ax, road.az, road.bx, road.bz, 110, { budget: 150000, legBudget: 45000, stop: 6, run: true });
    legs.push({ atTap: { spent: t.route.spent, walked: t.route.walked, energy: t.route.energy, metres: t.route.metres, left: t.route.left },
      label: t.label, odo: w.odo, energy: w.energy,
      after: w.after.route ? { spent: w.after.route.spent, walked: w.after.route.walked, left: w.after.route.left } : null });
  }
  const s = V.snap();
  return { quote, legs, evs, totalEnergy: +(e0 - s.energy).toFixed(4), totalOdo: +(s.metres - m0).toFixed(2), route: s.route };
}, [ROAD]);

console.log('quote at the first tap:', JSON.stringify(out.quote));
for (const [i,l] of out.legs.entries())
  console.log(`  tap ${i+1}  board row: "${l.label.d}"\n         at tap: spent=${l.atTap.spent} walked=${l.atTap.walked} left=${l.atTap.left}` +
              `\n         walked ${l.odo} m for ${l.energy} e -> ledger spent=${l.after && l.after.spent} walked=${l.after && l.after.walked} left=${l.after && l.after.left}`);
console.log(`TOTAL: ${out.totalOdo} m for ${out.totalEnergy} e   (road x rate = ${(out.totalOdo*RATE).toFixed(3)})   quote was ${out.quote.energy}`);
console.log('route events:', JSON.stringify(out.evs));
R.ok(Math.abs(out.totalEnergy - out.totalOdo*RATE)/(out.totalOdo*RATE) < 0.03, 're-tapping charges the road exactly ONCE — no double charge');
R.ok(out.legs[1].atTap.spent > 0 && out.legs[2].atTap.spent > out.legs[1].atTap.spent,
  'the ledger CARRIES ON across a re-tap (spent is not reset)', out.legs.map(l=>l.atTap.spent).join(' -> '));
R.ok(out.legs[2].atTap.walked > out.legs[0].odo * 1.8, 'walked accumulates across re-taps', String(out.legs[2].atTap.walked));
R.ok(out.totalEnergy <= out.quote.energy, `total energy (${out.totalEnergy}) does not exceed the quote (${out.quote.energy}) — was 94.58 vs 33.6`);
R.ok(out.evs.filter(e=>e.kind==='set').every(e=>e.to==='treasury'), 'every set event named the same destination');
R.ok(out.evs.filter(e=>e.kind==='set' && e.resumed).length === 2, 'taps 2 and 3 were RESUMES, not new journeys', JSON.stringify(out.evs.map(e=>e.kind+':'+!!e.resumed)));

/* ===== the `left` floor: walk past the quote ===== */
console.log('\n===== `left` past the quote =====');
const lf = await page.evaluate(async ([road]) => {
  const c = WALLY.ctx;
  V.setup({ time: 10*60, energy: 100 });
  if (c.game.state.loc !== 'library') c.game.enter('library');
  V.place(road.ax, road.az); await new Promise(r=>setTimeout(r,900));
  const host=document.createElement('div');host.style.cssText='position:fixed;left:-9999px';document.body.appendChild(host);
  c.ui.renderTravelModes(host,'school',()=>{});
  [...host.querySelectorAll('.w-card')].find(e=>((e.querySelector('.t')||{}).textContent||'').trim()==='On foot').click();
  await new Promise(r=>setTimeout(r,250)); host.remove();
  const q = JSON.parse(JSON.stringify(c.game.route));
  const w = await V.walkRoad(road.ax, road.az, road.bx, road.bz, 220, { budget: 180000, legBudget: 45000, stop: 6, run: true });
  return { q, odo: w.odo, energy: w.energy, route: c.game.route };
}, [ROAD]);
console.log(`quote ${lf.q.energy} e / ${lf.q.metres} m; walked ${lf.odo} m for ${lf.energy} e; route now`, JSON.stringify(lf.route));
R.ok(lf.energy > lf.q.energy, 'he really overspent the quote');
R.ok(lf.route && lf.route.left === 0, '`left` floors at 0, it does not go negative', String(lf.route && lf.route.left));
R.ok(lf.route && lf.route.spent > lf.route.energy, 'spent is allowed past the quote (the quote is not a cap)', `${lf.route&&lf.route.spent} > ${lf.route&&lf.route.energy}`);

/* ===== 5. SLEEP WITH A LIVE ROUTE ===== */
console.log('\n===== 5. SLEEP ON A LIVE ROUTE =====');
const sl = await page.evaluate(async () => {
  const c = WALLY.ctx;
  V.setup({ time: 21*60, energy: 100 });
  if (c.game.state.loc !== 'apartment') c.game.enter('apartment');
  const apt = V.locPos('apartment'); V.place(apt[0], apt[1]);
  await new Promise(r=>setTimeout(r,700));
  const host=document.createElement('div');host.style.cssText='position:fixed;left:-9999px';document.body.appendChild(host);
  c.ui.renderTravelModes(host,'treasury',()=>{});
  [...host.querySelectorAll('.w-card')].find(e=>((e.querySelector('.t')||{}).textContent||'').trim()==='On foot').click();
  await new Promise(r=>setTimeout(r,300)); host.remove();
  const evs=[]; c.bus.on('route',(e)=>evs.push({kind:e.kind,to:e.to,why:e.why,spent:e.spent}));
  const before={route:JSON.parse(JSON.stringify(c.game.route)),arrow:V.arrow().all,day:c.game.state.day};
  const res=c.game.actions.sleep();
  await new Promise(r=>setTimeout(r,600));
  return { before, res, after:{route:c.game.route,routeTo:c.game.routeTo,arrow:V.arrow().all,day:c.game.state.day}, evs };
});
console.log('before:', JSON.stringify(sl.before.route), '\n  arrow:', sl.before.arrow);
console.log('after :', JSON.stringify(sl.after.route), 'routeTo', sl.after.routeTo, ' day', sl.before.day, '->', sl.after.day);
console.log('  arrow:', sl.after.arrow, '\n  events:', JSON.stringify(sl.evs));
R.ok(sl.after.day > sl.before.day, 'he actually slept');
R.ok(sl.after.route === null && sl.after.routeTo === null, 'the live route was DROPPED by sleeping');
R.ok(sl.evs.some(e=>e.kind==='clear'), 'a proper clear event fired', JSON.stringify(sl.evs));
R.ok(!String(sl.after.arrow).includes('City Treasury'), 'the arrow stopped naming the dropped destination', sl.after.arrow);

/* the other way in: a save carrying yesterday's route */
const stale = await page.evaluate(() => {
  const st = WALLY.ctx.game.state;
  st.route = { to:'treasury', from:'apartment', mode:'walk', ride:null, mins:106, energy:33.6, metres:832, walked:0, spent:0, day: st.day-1, set:600 };
  const seen = WALLY.ctx.game.route;
  return { seen, routeTo: WALLY.ctx.game.routeTo, raw: st.route };
});
console.log('stale route from yesterday ->', JSON.stringify(stale));
R.ok(stale.seen === null && stale.raw === null, "a route quoted yesterday cannot meter him today");

await B.close();
console.log(`\n${R.fails} failure(s). page errors: ${B.errs.length}`, B.errs.slice(0,6).join(' | '));
