/* VJ 2: does energy accrue over the journey, and what happens with NO route */
import { chromium } from 'playwright-core';
import { serve, reporter } from './lib.mjs';

const { server, port } = await serve();
const R = reporter();
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 120000 });
await page.waitForTimeout(3000);

/* ---------- 1. accrual profile over a real walked leg ---------- */
console.log('\n===== ACCRUAL PROFILE (walk, apartment -> mine, 5 hops) =====');
const prof = await page.evaluate(async () => {
  const c = WALLY.ctx, g = c.game, st = g.state;
  st.known.mine = true; st.money = 5000; st.energy = 100; st.hunger = 10;
  st.rides = { owned: {}, equipped: null }; st.bike = { owned: false, equipped: false };
  st.time = 600; g.clearRoute('vj');
  const r = g.travel('mine', 'walk');
  const A = g.data.locationById.apartment.world, B = g.data.locationById.mine.world;
  const D = Math.hypot(A.x - B.x, A.z - B.z);
  const samples = [];
  // feed positions along the straight line in 40 steps of <=40 m
  const N = 60;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = A.x + (B.x - A.x) * t, z = A.z + (B.z - A.z) * t;
    g.stride(x, z);
    if (i % 6 === 0) samples.push({ frac: +t.toFixed(2), m: Math.round(D * t), spent: +(g.route ? g.route.spent : -1).toFixed(3), energy: +st.energy.toFixed(3) });
  }
  return { quote: r, D: +D.toFixed(1), samples, route: g.route, energy: st.energy };
});
console.log('  quote', JSON.stringify(prof.quote));
console.log('  straight-line distance', prof.D, 'm');
for (const s of prof.samples) console.log(`   ${String(s.m).padStart(4)} m  spent ${s.spent}  energy ${s.energy}`);
const mid = prof.samples[Math.floor(prof.samples.length / 2)];
R.ok(mid.spent > 0.2 * prof.quote.energy && mid.spent < 0.8 * prof.quote.energy,
  'energy accrues DURING the journey, not in a lump', `${mid.spent} of ${prof.quote.energy} at ${mid.m} m`);
R.ok(prof.samples.every((s, i) => i === 0 || s.spent >= prof.samples[i - 1].spent),
  'and monotonically');
const capAt = prof.samples.find((s) => s.spent >= prof.quote.energy - 1e-6);
console.log(`  cap reached at ${capAt ? capAt.m + ' m' : 'never'} of a ${prof.D} m straight line (quoted ${prof.quote.metres} m)`);

/* ---------- 2. THE CONTROL: walk the same road with NO route ---------- */
console.log('\n===== CONTROL: the same road with NO route set =====');
const ctrl = await page.evaluate(async () => {
  const c = WALLY.ctx, g = c.game, st = g.state;
  st.energy = 100; st.time = 600; g.clearRoute('vj'); g.resetStride();
  const A = g.data.locationById.apartment.world, B = g.data.locationById.mine.world;
  const N = 60; let charged = 0;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    charged += g.stride(A.x + (B.x - A.x) * t, A.z + (B.z - A.z) * t);
  }
  const before = st.loc;
  const e = g.enter('mine');
  return { charged, energy: +st.energy.toFixed(3), enter: e, loc: st.loc, before, trips: st.stats.trips };
});
console.log('  ', JSON.stringify(ctrl));
R.ok(ctrl.charged === 0, 'CONTROL: with no route, the identical road charged ' + ctrl.charged + ' energy');
R.ok(ctrl.loc === 'mine', 'CONTROL: and enter() still put him at the mine — the journey was free');

/* ---------- 3. ambient drain: does time alone cost energy? ---------- */
console.log('\n===== AMBIENT: does standing still cost energy? =====');
const amb = await page.evaluate(async () => {
  const g = WALLY.ctx.game, st = g.state;
  st.energy = 100; g.clearRoute('vj');
  const t0 = st.time, e0 = st.energy;
  await new Promise((r) => setTimeout(r, 6000));
  return { dt: +(st.time - t0).toFixed(2), de: +(st.energy - e0).toFixed(3) };
});
console.log('  ', JSON.stringify(amb));
R.ok(true, `ambient over ${amb.dt} game-min: energy delta ${amb.de}`);

/* ---------- 4. route survives a save/load; does the ARROW? ---------- */
console.log('\n===== SAVE / LOAD: route vs arrow =====');
const sl = await page.evaluate(async () => {
  const c = WALLY.ctx, g = c.game, st = g.state;
  st.known.stadium = true; st.energy = 100; g.clearRoute('vj');
  const host = document.createElement('div'); document.body.appendChild(host);
  c.ui.renderTravelModes(host, 'stadium', () => {});
  const el = [...host.querySelectorAll('.w-card')].find((e) => (e.querySelector('.t') || {}).textContent === 'On foot');
  el.click(); host.remove();
  await new Promise((r) => setTimeout(r, 120));
  const arrowBefore = (document.querySelector('.w-obj .t') || {}).textContent;
  const routeBefore = g.route;
  g.save();
  /* reload the run from the save, the way the boot path does */
  const okLoad = g.load ? g.load() : null;
  await new Promise((r) => setTimeout(r, 300));
  return { arrowBefore, routeBefore, afterRoute: g.route, arrowAfter: (document.querySelector('.w-obj .t') || {}).textContent, okLoad };
});
console.log('  ', JSON.stringify(sl));

await browser.close(); server.close();
console.log(`\n${R.fails} failure(s). page errors: ${errs.length} ${errs.join(' | ')}`);
