/* VJ — the travel edges the round's own suite does not cover */
import { chromium } from 'playwright-core';
import { serve, reporter } from './lib.mjs';
const { server, port } = await serve();
const R = reporter();
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 120000 });
await page.waitForTimeout(3000);
await page.evaluate(() => {
  window.setup = (o) => {
    const g = WALLY.ctx.game, st = g.state;
    st.money = 5000; st.energy = 100; st.hunger = 5; st.time = o.time ?? 600;
    st.rides = { owned: { bike: false, scooter: false, motorcycle: false, ...(o.owned || {}) }, equipped: o.equipped ?? null };
    st.bike = { owned: !!st.rides.owned.bike, equipped: st.rides.equipped === 'bike' };
    for (const l of g.data.locations) st.known[l.id] = true;
    g.clearRoute('vj'); g.resetStride();
    if (st.loc !== 'apartment') g.enter('apartment');
    return { equipped: st.rides.equipped };
  };
});

/* 1. two rides in the shed: does the row the board shows match the one travel() mounts? */
console.log('\n===== 1. TWO RIDES IN THE SHED =====');
const two = await page.evaluate(() => {
  const c = WALLY.ctx, g = c.game;
  setup({ owned: { bike: true, motorcycle: true }, equipped: null });
  const host = document.createElement('div'); document.body.appendChild(host);
  c.ui.renderTravelModes(host, 'stadium', () => {});
  const rideRow = [...host.querySelectorAll('.w-card')].map((e) => (e.querySelector('.t') || {}).textContent)
    .find((t) => /Bicycle|Scooter|Motorcycle/.test(t));
  host.remove();
  const r = g.travel('stadium', 'bike');
  return { rowSaid: rideRow, mounted: g.state.rides.equipped, result: r };
});
console.log('  ', JSON.stringify(two));
R.ok(/Motorcycle/i.test(two.rowSaid) === (two.mounted === 'motorcycle'),
  '1. the board names the ride travel() actually mounts', `row "${two.rowSaid}" vs mounted "${two.mounted}"`);

/* 2. a refused row must leave the shed exactly as it was */
console.log('\n===== 2. A REFUSED ROW MUST NOT REARRANGE THE SHED =====');
const refused = await page.evaluate(() => {
  const g = WALLY.ctx.game;
  const out = [];
  /* the Treasury shuts at 15:00 — try it at 20:00 with a bicycle in the shed */
  setup({ owned: { bike: true }, equipped: null, time: 20 * 60 });
  const before = g.state.rides.equipped;
  const r = g.travel('treasury', 'bike');
  out.push({ case: 'place is shut', before, after: g.state.rides.equipped, r, route: g.route });
  /* and too tired to ride */
  setup({ owned: { bike: true }, equipped: null });
  g.state.energy = 0.4;
  const before2 = g.state.rides.equipped;
  const r2 = g.travel('treasury', 'bike');
  out.push({ case: 'flat out of energy', before: before2, after: g.state.rides.equipped, r: r2, route: g.route });
  return out;
});
for (const c of refused) {
  console.log(`   ${c.case}: ${JSON.stringify(c.r)}  shed ${c.before} -> ${c.after}  route ${JSON.stringify(c.route)}`);
  if (!c.r.ok) R.ok(c.after === c.before, `2. "${c.case}" refused and the shed is unchanged`, `${c.before} -> ${c.after}`);
  else console.log(`      (not refused — nothing to roll back)`);
}

/* 3. the energy cap is per ROUTE: quote the cheapest, walk the furthest */
console.log('\n===== 3. THE CAP IS PER ROUTE =====');
const cap = await page.evaluate(() => {
  const g = WALLY.ctx.game, D = g.data;
  setup({});
  /* the cheapest possible quote: the nearest known place */
  const here = D.locationById[g.state.loc].world;
  let near = null, nd = 1e9;
  for (const l of D.locations) {
    if (l.id === g.state.loc) continue;
    const d = Math.hypot(l.world.x - here.x, l.world.z - here.z);
    if (d < nd) { nd = d; near = l; }
  }
  const q = g.travel(near.id, 'walk');
  const far = D.locationById.treasury.world;
  /* now walk 900 m of real ground in <=40 m steps */
  let x = here.x, z = here.z, done = 0;
  const dx = far.x - here.x, dz = far.z - here.z, L = Math.hypot(dx, dz);
  const ux = dx / L, uz = dz / L;
  g.resetStride(); g.stride(x, z);
  while (done < 900) { done += 30; g.stride(here.x + ux * done, here.z + uz * done); }
  return { quotedTo: near.id, quotedM: q.metres, quotedE: q.energy, walked: 900, spent: g.route ? g.route.spent : null, energy: +g.state.energy.toFixed(2) };
});
console.log('  ', JSON.stringify(cap));
R.ok(cap.spent <= cap.quotedE + 1e-6,
  `3. 900 m of road cost only the ${cap.quotedE}-energy quote of a ${cap.quotedM} m hop`, JSON.stringify(cap));

/* 4. re-routing mid-journey: what happens to the spend already made? */
console.log('\n===== 4. RE-ROUTING MID-JOURNEY =====');
const rr = await page.evaluate(() => {
  const g = WALLY.ctx.game, D = g.data;
  setup({});
  const ev = []; const off = g.on ? g.on('route', (e) => ev.push(e.kind)) : null;
  const a = D.locationById.apartment.world, b = D.locationById.treasury.world;
  g.travel('treasury', 'walk');
  const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
  g.resetStride(); g.stride(a.x, a.z);
  for (let d = 30; d <= L * 0.8; d += 30) g.stride(a.x + dx / L * d, a.z + dz / L * d);
  const mid = { spent: +g.route.spent.toFixed(2), energy: +g.state.energy.toFixed(2) };
  /* he changes his mind and re-picks the SAME place */
  g.travel('treasury', 'walk');
  const after = { spent: g.route ? +g.route.spent.toFixed(3) : null, energy: +g.state.energy.toFixed(2) };
  /* and walks the rest */
  for (let d = L * 0.8; d <= L; d += 30) g.stride(a.x + dx / L * d, a.z + dz / L * d);
  const end = { spent: g.route ? +g.route.spent.toFixed(2) : null, energy: +g.state.energy.toFixed(2) };
  if (off) off();
  return { mid, after, end, events: ev, quote: 21 };
});
console.log('  ', JSON.stringify(rr));
R.ok(rr.after.spent === 0, '4. re-picking the same row resets the ledger to zero mid-journey', JSON.stringify(rr.after));
console.log('   -> total energy burned over one journey with one re-pick: '
  + (100 - rr.end.energy).toFixed(2) + ' against a quote of ' + rr.quote);

/* 5. does a route survive the night? */
console.log('\n===== 5. A ROUTE ACROSS A DAY ROLLOVER =====');
const night = await page.evaluate(() => {
  const g = WALLY.ctx.game;
  setup({});
  g.travel('treasury', 'walk');
  const before = { day: g.state.day, route: g.route };
  g.state.loc = 'apartment';
  const s = g.actions && g.actions.sleep ? g.actions.sleep() : null;
  return { before, sleep: s, after: { day: g.state.day, route: g.route } };
});
console.log('  ', JSON.stringify(night));

await browser.close(); server.close();
console.log(`\n${R.fails} failure(s). page errors: ${errs.length} ${errs.join(' | ')}`);
