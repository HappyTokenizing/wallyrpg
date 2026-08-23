/* VJ 1-2: travel rule, arrow, energy accrual, economy comment — my own path */
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

await page.evaluate(() => {
  window.setup = (locId, ride) => {
    const c = WALLY.ctx, st = c.game.state;
    st.known[locId] = true; st.money = 5000; st.energy = 100; st.hunger = 10;
    st.rides = { owned: { bike: false, scooter: false, motorcycle: false }, equipped: null };
    if (ride) st.rides.owned[ride] = true;
    st.bike = { owned: !!st.rides.owned.bike, equipped: false };
    c.game.clearRoute('vj'); st.time = 10 * 60;
    if (st.loc !== 'apartment') c.game.enter('apartment');
    return st.loc;
  };
  window.arrow = () => ({
    t: (document.querySelector('.w-obj .t') || {}).textContent || '',
    d: (document.querySelector('.w-obj .d') || {}).textContent || '',
  });
  window.snap = () => {
    const c = WALLY.ctx, st = c.game.state, p = c.wally.root.position;
    return { loc: st.loc, money: +st.money.toFixed(2), time: st.time, energy: +st.energy.toFixed(3),
      equipped: st.rides.equipped, route: c.game.route, travel: st.travel,
      pos: [+p.x.toFixed(2), +p.z.toFixed(2)], arrow: window.arrow(), trips: st.stats.trips };
  };
});

const NAMES = await page.evaluate(() => {
  const o = {}; for (const l of WALLY.ctx.game.data.locations) o[l.id] = l.n; return o;
});

/* ============ A. the six modes, through the REAL fare board UI ============ */
console.log('\n===== A. THE FARE BOARD, TAPPED =====');
const LEGS = [
  { mode: 'walk', ride: null, row: 'On foot', to: 'noodlecart' },
  { mode: 'bike', ride: 'bike', row: 'Bicycle', to: 'stadium' },
  { mode: 'bike', ride: 'scooter', row: 'Scooter', to: 'bank' },
  { mode: 'bike', ride: 'motorcycle', row: 'Motorcycle', to: 'markethall' },
  { mode: 'train', ride: null, row: 'Metro', to: 'noodlecart' },
  { mode: 'trunk', ride: null, row: 'Yoober', to: 'stadium' },
];
for (const leg of LEGS) {
  const out = await page.evaluate(async ([to, ride, row]) => {
    const c = WALLY.ctx;
    setup(to, ride);
    /* leave a QUEST objective live and do NOT clear the destination:
       the arrow must be taken over by the choice, not by a blank slate */
    c.ui.setDestination(null);
    const before = window.snap();
    const host = document.createElement('div'); document.body.appendChild(host);
    c.ui.renderTravelModes(host, to, () => {});
    const cards = [...host.querySelectorAll('.w-card')].map((e) => ({
      t: (e.querySelector('.t') || {}).textContent || '',
      d: (e.querySelector('.d') || {}).textContent || '',
      m: (e.querySelector('.m') || {}).textContent || '',
      dis: !!e.disabled,
    }));
    const el = [...host.querySelectorAll('.w-card')]
      .find((e) => ((e.querySelector('.t') || {}).textContent || '').trim() === row);
    if (!el) { host.remove(); return { before, cards, missing: true }; }
    el.click();
    await new Promise((r) => setTimeout(r, 60));
    const after = window.snap();
    host.remove();
    return { before, after, cards, toast: (document.querySelector('.w-toast') || {}).textContent || '' };
  }, [leg.to, leg.ride, leg.row]);
  await page.waitForTimeout(700);
  const settled = await page.evaluate(() => window.snap());
  const fast = leg.mode === 'train' || leg.mode === 'trunk';
  const label = `${leg.row}→${leg.to}`;
  if (out.missing) { R.ok(false, `${label}: row present on the board`, JSON.stringify(out.cards)); continue; }
  const dist = Math.hypot(settled.pos[0] - out.before.pos[0], settled.pos[1] - out.before.pos[1]);
  if (fast) {
    R.ok(settled.loc === leg.to, `${label}: FAST — state.loc moved`, settled.loc);
    R.ok(dist > 50, `${label}: FAST — he was relocated (${dist.toFixed(1)} m)`);
    R.ok(settled.money < out.before.money, `${label}: FAST — it charged him`, `$${out.before.money}→$${settled.money}`);
    R.ok(settled.time > out.before.time, `${label}: FAST — the clock burned`, `${out.before.time}→${settled.time}`);
    R.ok(settled.route === null, `${label}: FAST — no route left behind`);
  } else {
    R.ok(settled.loc === 'apartment', `${label}: SELF — state.loc did NOT move`, settled.loc);
    R.ok(dist < 2, `${label}: SELF — he was NOT relocated (${dist.toFixed(2)} m)`);
    R.ok(settled.money === out.before.money, `${label}: SELF — cost nothing`, String(settled.money));
    R.ok(settled.route && settled.route.to === leg.to, `${label}: SELF — route is live`, JSON.stringify(settled.route));
    const nm = NAMES[leg.to];
    R.ok(settled.arrow.t.includes(nm) || settled.arrow.d.includes(nm),
      `${label}: SELF — the route ARROW retargeted to "${nm}"`, JSON.stringify(settled.arrow));
    if (leg.ride) R.ok(settled.equipped === leg.ride, `${label}: SELF — it equipped the ${leg.ride}`, String(settled.equipped));
    else R.ok(settled.equipped === null, `${label}: SELF — nothing mounted`, String(settled.equipped));
  }
  console.log(`      board: ${out.cards.map((c) => `[${c.t}|${c.m}|${c.dis ? 'X' : 'o'}] ${c.d}`).join('  ')}`);
}
await browser.close(); server.close();
console.log(`\n${R.fails} failure(s). page errors: ${errs.length} ${errs.join(' | ')}`);
