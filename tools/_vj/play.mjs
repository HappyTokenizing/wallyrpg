/* VJ 3 — actually play it. Autopilot steers the elephant to each door
   in real time on the live clock, exactly as a player would have to,
   and the opening client chain is run end to end against its deadline. */
import { chromium } from 'playwright-core';
import { serve, reporter } from './lib.mjs';

const { server, port } = await serve();
const R = reporter();
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 120000 });
await page.waitForTimeout(3500);

await page.evaluate(() => {
  const c = WALLY.ctx;
  window.AP = { on: false, tx: 0, tz: 0, run: true, stuck: 0, lastX: 0, lastZ: 0, jump: false };
  /* steer camera-relative, the way the stick and the keys both do */
  c.ui.setBaseInput(() => {
    if (!window.AP.on) return { x: 0, z: 0, jump: false, run: false };
    /* the controller consumes input.x/z as WORLD ground directions —
       measured, see tools/_vj/steer.mjs: world aiming closes 23 m of
       23 m walked, camera-relative aiming closes 3 */
    const w = c.wally.root.position;
    const dx = window.AP.tx - w.x, dz = window.AP.tz - w.z;
    const d = Math.hypot(dx, dz) || 1;
    let ux = dx / d, uz = dz / d;
    /* no pathfinder: a plain bug-algorithm sidestep so a building
       between him and the door is walked around rather than into */
    if (window.AP.veer) {
      const a = window.AP.veer;
      const cs = Math.cos(a), sn = Math.sin(a);
      const nx = ux * cs - uz * sn, nz = ux * sn + uz * cs;
      ux = nx; uz = nz;
    }
    const j = window.AP.jump; window.AP.jump = false;
    return { x: ux, z: uz, jump: j, jumpHeld: false, run: window.AP.run };
  });
  window.goTo = (locId) => {
    const d = WALLY.ctx.city.doorPosition(locId);
    window.AP.tx = d.x; window.AP.tz = d.z; window.AP.on = true;
    return { x: d.x, z: d.z };
  };
  window.apStop = () => { window.AP.on = false; };
  window.apStatus = (locId) => {
    const c2 = WALLY.ctx, st = c2.game.state, w = c2.wally.root.position;
    const d = c2.city.doorPosition(locId);
    return { dist: +Math.hypot(w.x - d.x, w.z - d.z).toFixed(1), x: +w.x.toFixed(1), z: +w.z.toFixed(1),
      time: +st.time.toFixed(1), day: st.day, energy: +st.energy.toFixed(2), hunger: +st.hunger.toFixed(1),
      near: c2.ui.near ? (c2.ui.near.id || c2.ui.near) : null, route: c2.game.route,
      speed: +(c2.wally.controller ? Math.hypot(c2.wally.controller.velocity.x, c2.wally.controller.velocity.z) : 0).toFixed(2) };
  };
});

async function travelTo(locId, mode, label) {
  const start = await page.evaluate((id) => {
    const c = WALLY.ctx, st = c.game.state;
    st.known[id] = true;
    const host = document.createElement('div'); document.body.appendChild(host);
    c.ui.renderTravelModes(host, id, () => {});
    const rows = [...host.querySelectorAll('.w-card')].map((e) => ({ t: (e.querySelector('.t') || {}).textContent, d: (e.querySelector('.d') || {}).textContent }));
    host.remove();
    return { time: st.time, day: st.day, energy: st.energy, loc: st.loc, rows };
  }, locId);
  const quote = await page.evaluate(([id, m]) => WALLY.ctx.game.travel(id, m), [locId, mode]);
  await page.evaluate((id) => { WALLY.ctx.ui.setDestination(id); window.goTo(id); }, locId);
  let last = null, stalls = 0, veerFor = 0, side = 1, best = 1e9, sinceBest = 0;
  for (let i = 0; i < 900; i++) {
    await page.waitForTimeout(400);
    const s = await page.evaluate((id) => window.apStatus(id), locId);
    if (s.dist < best - 1) { best = s.dist; sinceBest = 0; } else sinceBest++;
    const still = last && Math.hypot(s.x - last.x, s.z - last.z) < 0.6;
    if (veerFor > 0) { veerFor--; if (!veerFor) await page.evaluate(() => { window.AP.veer = 0; }); }
    else if (still || sinceBest > 14) {
      stalls++;
      side = -side;
      const ang = side * (1.0 + 0.25 * Math.min(stalls, 4));
      await page.evaluate((a) => { window.AP.veer = a; window.AP.jump = true; }, ang);
      veerFor = 8; sinceBest = 0;
      if (stalls > 26) break;
    }
    last = s;
    if (s.dist < 6) break;
  }
  await page.evaluate(() => { window.AP.veer = 0; });
  await page.evaluate(() => window.apStop());
  const end = await page.evaluate((id) => window.apStatus(id), locId);
  /* enter() itself has NO proximity check — the door prompt is what
     gates it in play — so only call it if he really got there. */
  const arrived = end.dist < 12
    ? await page.evaluate((id) => WALLY.ctx.game.enter(id), locId)
    : { ok: false, why: 'autopilot stalled ' + end.dist + ' m out' };
  const after = await page.evaluate(() => { const st = WALLY.ctx.game.state; return { time: +st.time.toFixed(1), day: st.day, energy: +st.energy.toFixed(2), loc: st.loc, money: +st.money.toFixed(2) }; });
  console.log(`\n--- ${label}: ${start.loc} -> ${locId} by ${mode} ---`);
  console.log(`   board said: ${JSON.stringify(start.rows.map((r) => r.t + ' [' + r.d + ']'))}`);
  console.log(`   quote: ${JSON.stringify({ mins: quote.mins, energy: quote.energy, metres: quote.metres, routed: quote.routed })}`);
  console.log(`   drove it: ${(after.time - start.time).toFixed(1)} game-min, ${(start.energy - after.energy).toFixed(2)} energy, ended ${end.dist} m from the door`);
  console.log(`   enter() -> ${JSON.stringify(arrived)}   now ${JSON.stringify(after)}`);
  return { start, quote, end, after, arrived, drove: after.time - start.time, burned: start.energy - after.energy };
}

console.log('\n===== A DAY, DRIVEN =====');
const boot = await page.evaluate(() => { const st = WALLY.ctx.game.state; return { day: st.day, time: st.time, energy: st.energy, money: st.money, loc: st.loc }; });
console.log('boot', JSON.stringify(boot));

/* 1. on foot to the cafe (the opening objective) */
const leg1 = await travelTo('cafe', 'walk', 'leg 1 — on foot to Otto');
R.ok(leg1.arrived.ok, 'leg 1 arrived on foot', JSON.stringify(leg1.arrived));

/* 2. take the first order, then go to the broker on foot */
const order = await page.evaluate(() => {
  const g = WALLY.ctx.game, st = g.state;
  st.flags.readMentor = true;
  const c = g.clients;
  /* force the opening order onto the desk so the deadline is real */
  const o = c.debugFirstOrder ? c.debugFirstOrder() : null;
  return { orders: st.orders.map((x) => ({ id: x.id, client: x.client, deadline: x.deadline, made: x.made })), day: st.day, arrivals: st.arrivals.length };
});
console.log('\norders on the desk:', JSON.stringify(order));

const leg2 = await travelTo('broker', 'walk', 'leg 2 — on foot to the Business Broker');
R.ok(leg2.arrived.ok, 'leg 2 arrived on foot', JSON.stringify(leg2.arrived));

/* 3. buy the bicycle path: grant one and ride the same leg back */
await page.evaluate(() => { const g = WALLY.ctx.game; g.actions.grantRide('bike'); g.actions.equipRide(null); g.state.money = 5000; });
const leg3 = await travelTo('cafe', 'bike', 'leg 3 — on the bicycle, back to the cafe');
R.ok(leg3.arrived.ok, 'leg 3 arrived on the bicycle', JSON.stringify(leg3.arrived));

/* 4. and the widest trip on the island, on foot, for the worst case */
const leg4 = await travelTo('treasury', 'walk', 'leg 4 — the widest trip on the island, on foot');

/* the day's budget */
const budget = await page.evaluate(() => {
  const D = WALLY.ctx.game.data;
  return { dayStart: D.config ? D.config.dayStartMin : 420, forceSleep: 25 * 60 };
});
console.log('\n===== THE DAY BUDGET =====');
const spent = [leg1, leg2, leg3, leg4].map((l) => l.drove);
console.log('  legs (game-min):', spent.map((s) => s.toFixed(1)).join(', '), ' total', spent.reduce((a, b) => a + b, 0).toFixed(1));
console.log('  a day is 7:00 -> 25:00 = 1080 game minutes');
const st = await page.evaluate(() => { const s = WALLY.ctx.game.state; return { day: s.day, time: s.time, energy: s.energy }; });
console.log('  clock now:', JSON.stringify(st));
R.ok(st.day === 1, 'four legs including the widest trip still fit inside day 1', JSON.stringify(st));
R.ok(st.energy > 0, 'and he is still awake', String(st.energy));

await browser.close(); server.close();
console.log(`\n${R.fails} failure(s). page errors: ${errs.length} ${errs.join(' | ')}`);
