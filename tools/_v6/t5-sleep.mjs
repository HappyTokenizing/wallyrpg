/* 5. SLEEP ON A LIVE ROUTE — dropped or re-quoted? */
import { boot, reporter } from './lib.mjs';
const R = reporter();
const B = await boot(); const { page } = B;

const sl = await page.evaluate(async () => {
  const c = WALLY.ctx;
  V.setup({ time: 13*60, energy: 100 });
  if (c.game.state.loc !== 'apartment') c.game.enter('apartment');
  const apt = V.locPos('apartment'); V.place(apt[0], apt[1]);
  await new Promise(r=>setTimeout(r,800));
  const host=document.createElement('div');host.style.cssText='position:fixed;left:-9999px';document.body.appendChild(host);
  c.ui.renderTravelModes(host,'treasury',()=>{});
  const row=[...host.querySelectorAll('.w-card')].find(e=>((e.querySelector('.t')||{}).textContent||'').trim()==='On foot');
  row.click(); await new Promise(r=>setTimeout(r,300)); host.remove();
  /* walk a bit so the ledger is non-empty when he sleeps on it */
  const nc = V.locPos('noodlecart');
  await V.walkRoad(apt[0], apt[1], nc[0], nc[1], 40, { budget: 40000, legBudget: 20000, stop: 6, run: true });
  V.place(apt[0], apt[1]); await new Promise(r=>setTimeout(r,600));
  const evs=[]; c.bus.on('route',(e)=>evs.push({kind:e.kind,to:e.to,why:e.why,spent:e.spent}));
  const before={route:JSON.parse(JSON.stringify(c.game.route||{})),arrow:V.arrow().all,day:c.game.state.day,energy:V.snap().energy};
  const res=c.game.actions.sleep();
  await new Promise(r=>setTimeout(r,700));
  return { before, res, after:{route:c.game.route,routeTo:c.game.routeTo,arrow:V.arrow().all,day:c.game.state.day,energy:V.snap().energy}, evs };
});
console.log('before sleep route:', JSON.stringify(sl.before.route));
console.log('   arrow:', sl.before.arrow);
console.log('sleep returned:', JSON.stringify(sl.res));
console.log('after  sleep route:', JSON.stringify(sl.after.route), 'routeTo', sl.after.routeTo, '| day', sl.before.day, '->', sl.after.day);
console.log('   arrow:', sl.after.arrow);
console.log('   route events during sleep:', JSON.stringify(sl.evs));
R.ok(sl.before.route && sl.before.route.to === 'treasury' && sl.before.route.spent > 0, 'a live, part-spent route was on the books', JSON.stringify(sl.before.route));
R.ok(sl.after.day > sl.before.day, 'he actually slept');
R.ok(sl.after.route === null && sl.after.routeTo === null, 'the live route was DROPPED by sleeping');
R.ok(sl.evs.some(e=>e.kind==='clear'), 'a proper clear event fired with a reason', JSON.stringify(sl.evs));
R.ok(!String(sl.after.arrow).includes('City Treasury'), 'the arrow stopped naming the dropped destination', sl.after.arrow);

/* …and that walking after the night is charged at foot rate with no ghost ledger */
const post = await page.evaluate(async () => {
  const c = WALLY.ctx; const apt = V.locPos('apartment'), nc = V.locPos('noodlecart');
  V.place(apt[0], apt[1]); await new Promise(r=>setTimeout(r,700));
  const w = await V.walkRoad(apt[0],apt[1],nc[0],nc[1],60,{budget:60000,legBudget:25000,stop:6,run:true});
  return { odo: w.odo, energy: w.energy, route: c.game.route };
});
console.log(`morning-after walk: ${post.odo} m for ${post.energy} e  (e/m ${(post.energy/post.odo).toFixed(5)}), route ${JSON.stringify(post.route)}`);
R.ok(post.route === null, 'no route came back from the dead');
R.ok(post.energy > 0, 'and the road is still charged');
await B.close();
console.log(`\n${R.fails} failure(s). page errors: ${B.errs.length}`, B.errs.slice(0,6).join(' | '));
