#!/usr/bin/env node
/* ============================================================
   tools/test-game.mjs — the game-systems test suite.

   Plain node. Imports src/game/*.js directly, so those modules must
   never touch `document`, `window` or `localStorage` at import time.
   There is no DOM here and nothing is mocked.

       node tools/test-game.mjs
       node tools/test-game.mjs --verbose

   Exits non-zero on the first hard failure summary.
   ============================================================ */

import DATA, {
  CONFIG, CATEGORIES, ASSETS, ASSET_BY_ID, VENUES, VENUE_LOC,
  CLIENTS, CLIENT_BY_ID, COURSES, COURSE_BY_ID, OFFICE_STAGES,
  HOMES, HOME_BY_ID, ZONES, LOCATIONS, LOC_BY_ID, WORLD, MAP,
  TRAVEL, JOBS, EMPLOYEE_POOL, IPOS, IPO_STEPS, STADIUM_STEPS,
  NEWS_POOL, QUESTS, MILESTONES, TIPS, MORNING_NOTES,
  hops, fare, worldDistance,
} from '../src/game/data.js';
import { newState, mulberry32 } from '../src/game/state.js';
import { createGame } from '../src/game/game.js';

const VERBOSE = process.argv.includes('--verbose');

/* ---------------- micro test framework ---------------- */
let pass = 0;
const fails = [];
let group = '';
const T = (name) => { group = name; if (VERBOSE) console.log('\n— ' + name); };
function ok(cond, msg, detail) {
  if (cond) { pass++; if (VERBOSE) console.log('  ok  ' + msg); return true; }
  fails.push(`[${group}] ${msg}` + (detail != null ? `  (${detail})` : ''));
  return false;
}
const eq = (a, b, msg) => ok(a === b, msg, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const num = (v, msg) => ok(Number.isFinite(v), msg, `got ${v}`);

/* Walk any structure and complain about NaN / Infinity / undefined
   numbers. This is the "never NaNs" assertion, applied to everything. */
function scanFinite(o, path, out, seen = new Set()) {
  if (o == null) return out;
  if (typeof o === 'number') { if (!Number.isFinite(o)) out.push(`${path} = ${o}`); return out; }
  if (typeof o !== 'object') return out;
  if (seen.has(o)) return out;
  seen.add(o);
  if (Array.isArray(o)) { o.forEach((v, i) => scanFinite(v, `${path}[${i}]`, out, seen)); return out; }
  for (const k of Object.keys(o)) scanFinite(o[k], `${path}.${k}`, out, seen);
  return out;
}
const badNumbers = (s) => scanFinite(s, 'state', []);

/* ============================================================
   1. CONTENT COUNTS — the headline numbers from the brief
   ============================================================ */
T('content counts');
eq(ASSETS.length, 69, '69 assets');
eq(CLIENTS.length, 24, '24 clients');
eq(LOCATIONS.length, 28, '28 locations');
eq(Object.keys(ZONES).length, 10, '10 zones');
eq(Object.keys(VENUES).length, 9, '9 market venues');
eq(Object.keys(CATEGORIES).length, 10, '10 asset categories');
eq(COURSES.length, 10, '10 courses');
eq(OFFICE_STAGES.length, 6, '6 office stages');
eq(HOMES.length, 5, '5 homes');
eq(EMPLOYEE_POOL.length, 10, '10 employees');
eq(IPOS.length, 4, '4 IPOs');
eq(STADIUM_STEPS.length, 10, '10-step stadium questline');
eq(CONFIG.totalAssets, ASSETS.length, 'CONFIG.totalAssets agrees with the catalogue');
ok(Object.keys(TRAVEL).length >= 3, 'at least 3 fast-travel modes');
ok(NEWS_POOL.length >= 12, 'a news pool worth rolling', NEWS_POOL.length);
ok(MILESTONES.length === 11, 'milestones every 10% plus the 5%', MILESTONES.length);

/* ============================================================
   2. CONTENT INTEGRITY — no dangling references
   ============================================================ */
T('content integrity');
const dupe = (arr, key = 'id') => {
  const seen = new Set(), out = [];
  for (const x of arr) { if (seen.has(x[key])) out.push(x[key]); seen.add(x[key]); }
  return out;
};
eq(dupe(ASSETS).length, 0, 'asset ids unique', dupe(ASSETS));
eq(dupe(CLIENTS).length, 0, 'client ids unique', dupe(CLIENTS));
eq(dupe(LOCATIONS).length, 0, 'location ids unique', dupe(LOCATIONS));
eq(dupe(QUESTS).length, 0, 'quest ids unique', dupe(QUESTS));

for (const a of ASSETS) {
  ok(!!CATEGORIES[a.cat], `asset ${a.id} has a real category`, a.cat);
  ok(!!VENUES[a.ven], `asset ${a.id} has a real venue`, a.ven);
  ok(Number.isFinite(a.v) && a.v > 0, `asset ${a.id} has a value`, a.v);
  ok(a.q >= 1 && a.q <= 5, `asset ${a.id} liquidity 1..5`, a.q);
  ok(a.tq >= 1 && a.tq <= 3, `asset ${a.id} tokenization difficulty 1..3`, a.tq);
}
ok(ASSETS.some((a) => a.div), 'some assets pay dividends');
ok(ASSETS.some((a) => a.cpn), 'some assets pay coupons');
ok(ASSETS.filter((a) => a.cat === 'Farm').every((a) => a.farm >= 1), 'every Farm asset has a farm tier');
ok(ASSETS.filter((a) => a.cat === 'Minerals').every((a) => a.mine >= 1), 'every Minerals asset has a mine tier');

for (const v of Object.keys(VENUES)) {
  const V = VENUES[v];
  ok(Number.isFinite(V.spread) && V.spread > 0 && V.spread < 0.5, `venue ${v} has a sane spread`, V.spread);
  ok(Array.isArray(V.hours) && V.hours.length === 2 && V.hours[0] < V.hours[1], `venue ${v} has opening hours`, V.hours);
  ok(!VENUE_LOC[v] || !!LOC_BY_ID[VENUE_LOC[v]], `venue ${v} maps to a real location`, VENUE_LOC[v]);
}
for (const c of CLIENTS) {
  ok(c.fav.every((f) => !!CATEGORIES[f]), `client ${c.id} favours real categories`, c.fav);
  ok(c.hate.every((f) => !!CATEGORIES[f]), `client ${c.id} dislikes real categories`, c.hate);
  ok(!c.fav.some((f) => c.hate.includes(f)), `client ${c.id} does not both love and hate a category`);
  ok(c.budget >= 1 && c.budget <= 5, `client ${c.id} budget tier 1..5`, c.budget);
  ok(c.patience >= 1 && c.patience <= 5, `client ${c.id} patience 1..5`, c.patience);
  ok(!!ZONES[c.home], `client ${c.id} lives in a real zone`, c.home);
  ok(ASSETS.some((a) => !c.hate.includes(a.cat)), `client ${c.id} can be sold something`);
}
for (const c of COURSES) {
  ok((c.req || []).every((r) => !!COURSE_BY_ID[r]), `course ${c.id} prerequisites exist`, c.req);
  ok(!(c.req || []).includes(c.id), `course ${c.id} is not its own prerequisite`);
  ok(Number.isFinite(c.cost) && Number.isFinite(c.hours) && Number.isFinite(c.energy), `course ${c.id} is fully costed`);
}
/* prerequisite graph is acyclic and every course is reachable */
{
  const done = new Set();
  for (let pass2 = 0; pass2 < COURSES.length + 1; pass2++) {
    for (const c of COURSES) if (!done.has(c.id) && (c.req || []).every((r) => done.has(r))) done.add(c.id);
  }
  eq(done.size, COURSES.length, 'every course is reachable through its prerequisites');
}
for (const ip of IPOS) {
  ok(!!ASSET_BY_ID[ip.id], `IPO ${ip.id} lists a real asset`);
  ok(!!CLIENT_BY_ID[ip.client], `IPO ${ip.id} has a real client sponsor`, ip.client);
}
for (const j of Object.keys(JOBS)) {
  const J = JOBS[j];
  ok(Number.isFinite(J.base) && Number.isFinite(J.mult) && J.hrs > 0, `job ${j} is costed`);
  ok(!!LOC_BY_ID[J.loc], `job ${j} happens somewhere real`, J.loc);
  ok(J.locs.length >= 1 && J.locs.every((id) => LOC_BY_ID[id].acts.includes('job:' + j)),
    `job ${j} agrees with the locations that offer it`, J.locs);
}
for (const e of EMPLOYEE_POOL) ok(Number.isFinite(e.salary) && e.salary > 0, `employee ${e.id} has a salary`);
for (const h of HOMES) ok(Number.isFinite(h.rent) && Number.isFinite(h.rest), `home ${h.id} has rent and rest`);
for (const o of OFFICE_STAGES) ok(o.slots >= 1 && o.invCap >= 1, `office ${o.n} has slots and capacity`);
for (const n of NEWS_POOL) ok(!!ASSET_BY_ID[n.a], `news "${n.h}" points at a real asset`, n.a);
for (const q of QUESTS) {
  ok(typeof q.check === 'function', `quest ${q.id} has a check()`);
  ok(!q.loc || q.loc === 'office' || !!LOC_BY_ID[q.loc], `quest ${q.id} points at a real place`, q.loc);
  ok(q.act >= 1 && q.act <= 5, `quest ${q.id} belongs to one of the five acts`, q.act);
}
for (const k of Object.keys(TIPS)) ok(!!TIPS[k].t && !!TIPS[k].d, `tip ${k} has a title and body`);
for (const m of MORNING_NOTES) ok(m.day >= 1 && !!m.msg, `morning note day ${m.day} is well formed`);

/* ============================================================
   3. THE 3D COORDINATE CONVENTION
   ============================================================ */
T('3d world layout');
num(WORLD.scale, 'WORLD.scale is a number');
num(WORLD.islandRadiusX, 'WORLD.islandRadiusX is a number');
num(WORLD.islandRadiusZ, 'WORLD.islandRadiusZ is a number');
ok(WORLD.islandRadiusX * 2 > 700 && WORLD.islandRadiusX * 2 < 1200,
  'the island is roughly 900 m across', WORLD.islandRadiusX * 2);

for (const l of LOCATIONS) {
  ok(!!ZONES[l.z], `location ${l.id} is in a real zone`, l.z);
  ok(l.x >= 0 && l.x <= MAP.w && l.y >= 0 && l.y <= MAP.h, `location ${l.id} sits on the 2D map`, `${l.x},${l.y}`);
  ok(l.world && num(l.world.x, `${l.id}.world.x`) && num(l.world.y, `${l.id}.world.y`) && num(l.world.z, `${l.id}.world.z`),
    `location ${l.id} has 3D world coordinates`);
  /* the documented projection must actually hold */
  const px = (l.x - MAP.w / 2) * WORLD.scale;
  const pz = (l.y - MAP.h / 2) * WORLD.scale;
  ok(Math.abs(l.world.x - px) < 0.02 && Math.abs(l.world.z - pz) < 0.02,
    `location ${l.id} obeys the documented map→world projection`, `${l.world.x},${l.world.z} vs ${px},${pz}`);
  /* everything walkable is inside the shoreline ellipse */
  const e = (l.world.x / WORLD.islandRadiusX) ** 2 + (l.world.z / WORLD.islandRadiusZ) ** 2;
  ok(e <= 1.0, `location ${l.id} is on dry land`, e.toFixed(3));
  num(l.yaw, `location ${l.id} has a facing`);
  ok(l.size && l.size.w > 0 && l.size.d > 0 && l.size.h > 0, `location ${l.id} has a footprint`);
  ok(l.radius > 0, `location ${l.id} has a clearance radius`);
  ok(Array.isArray(l.hours) && l.hours[0] <= l.hours[1], `location ${l.id} has opening hours`);
  ok(!!l.kit && !!l.ico && !!l.desc, `location ${l.id} is dressed (kit/icon/description)`);
  ok(Array.isArray(l.acts), `location ${l.id} lists its actions`);
}
/* no two buildings overlap */
{
  let clashes = 0;
  for (let i = 0; i < LOCATIONS.length; i++) {
    for (let j = i + 1; j < LOCATIONS.length; j++) {
      const a = LOCATIONS[i], b = LOCATIONS[j];
      const d = Math.hypot(a.world.x - b.world.x, a.world.z - b.world.z);
      if (d < (a.radius + b.radius) * 0.5) clashes++;
    }
  }
  eq(clashes, 0, 'no two buildings occupy the same ground');
}
for (const k of Object.keys(ZONES)) {
  const z = ZONES[k];
  const w = z.world;
  ok(w && num(w.x, `${k}.world.x`) && num(w.z, `${k}.world.z`) && num(w.y, `${k}.world.y`), `zone ${k} has a world anchor`);
  ok(w.min.x < w.max.x && w.min.z < w.max.z, `zone ${k} has a real bounding box`);
  ok(w.radius > 0, `zone ${k} has a radius`);
  const mine = LOCATIONS.filter((l) => l.z === k);
  ok(mine.length >= 1, `zone ${k} contains at least one location`);
  ok(mine.every((l) => l.world.x >= w.min.x && l.world.x <= w.max.x && l.world.z >= w.min.z && l.world.z <= w.max.z),
    `zone ${k} bounds contain all its locations`);
  num(z.elev, `zone ${k} has a base elevation`);
}
ok(ZONES.goldenheights.world.y > 40, 'Golden Heights is a headland', ZONES.goldenheights.world.y);
ok(ZONES.ironhills.world.y > 30, 'Iron Hills is a ridge', ZONES.ironhills.world.y);
ok(ZONES.waterfront.world.y < 8, 'the Waterfront is at sea level', ZONES.waterfront.world.y);

T('travel maths');
num(worldDistance('apartment', 'stadium'), 'worldDistance returns a number');
eq(worldDistance('apartment', 'apartment'), 0, 'distance to yourself is zero');
ok(hops('apartment', 'stadium') >= 1, 'hops across the city is at least 1');
for (const m of Object.keys(TRAVEL)) {
  const f = fare(m, 'apartment', 'exchange');
  ok(Number.isFinite(f.cost) && f.cost >= 0, `fare(${m}) costs a real amount`, f.cost);
  ok(Number.isFinite(f.mins) && f.mins > 0, `fare(${m}) takes real time`, f.mins);
}
ok(fare('bike', 'apartment', 'exchange').cost === 0, 'the bicycle is always free');
ok(fare('taxi', 'apartment', 'exchange').mins < fare('bike', 'apartment', 'exchange').mins,
  'a TRUNK ride beats the bicycle on time');

/* ============================================================
   4. BOOT — headless, no DOM
   ============================================================ */
T('headless boot');
ok(typeof globalThis.document === 'undefined', 'no document exists in this process');
ok(typeof globalThis.window === 'undefined', 'no window exists in this process');

const game = createGame({ seed: 0x5eed1e, autosave: false });
ok(!!game, 'createGame() returned a handle');
eq(game.state.day, 1, 'a new game starts on day 1');
eq(game.state.money, CONFIG.startMoney, 'a new game starts with $250');
eq(game.state.loc, 'apartment', 'you wake up in your apartment');
eq(game.officeLoc(), 'apartment', 'the office starts as the folding table');
eq(badNumbers(game.state).length, 0, 'a fresh state contains no NaNs', badNumbers(game.state));

T('progressive discovery');
const known0 = LOCATIONS.filter((l) => game.known(l.id));
ok(known0.length >= 3 && known0.length <= 6, 'day one shows a handful of places', known0.length);
ok(game.known('apartment'), 'you know where you live');
ok(!game.known('penthouse'), 'the penthouse is not day-one knowledge');

T('api surface');
for (const k of ['data', 'state', 'time', 'economy', 'quests', 'clients', 'actions',
  'travel', 'enter', 'fares', 'here', 'officeLoc', 'isOpen', 'known', 'nearest', 'zoneAt',
  'hud', 'save', 'load', 'exportSave', 'importSave', 'newGame', 'hasSave']) {
  ok(game[k] !== undefined, `ctx.game.${k} exists`);
}
for (const k of ['price', 'buyPrice', 'sellPrice', 'buy', 'sell', 'tokenize', 'canTokenize',
  'tokenizeCost', 'cityPct', 'netWorth', 'acceptOrder', 'completeOrder', 'newDay', 'afford']) {
  ok(typeof game.economy[k] === 'function', `ctx.game.economy.${k} exists`);
}
for (const k of ['current', 'check', 'complete', 'progress', 'knows', 'milestones']) {
  ok(typeof game.quests[k] === 'function', `ctx.game.quests.${k} exists`);
}
ok(!!game.hud().clock, 'hud() reports a clock');
ok(game.quests.current() !== null, 'there is always a next objective on day 1');

T('time');
const t0 = game.time.minutes;
game.time.advance(90);
eq(game.time.minutes, t0 + 90, 'advance(90) moves 90 minutes');
ok(['Night', 'Morning', 'Afternoon', 'Evening'].includes(game.time.phase), 'phase is one of four', game.time.phase);
ok(game.time.norm >= 0 && game.time.norm <= 1, 'time.norm is 0..1', game.time.norm);
ok(game.time.hour >= 0 && game.time.hour < 24, 'hour is clamped 0..23');

T('economy basics');
{
  const id = 'trnk';
  ok(game.economy.buyPrice(id) > game.economy.sellPrice(id), 'the spread costs you money');
  const before = game.state.money;
  const r = game.economy.buy(id, 1);
  ok(r.ok, 'you can buy a cheap stock on day 1', r.why);
  eq(game.economy.owned(id), 1, 'the unit landed in inventory');
  ok(game.state.money < before, 'money went down');
  const r2 = game.economy.sell(id, 1);
  ok(r2.ok, 'and you can sell it back', r2.why);
  eq(game.economy.owned(id), 0, 'inventory is empty again');
  ok(game.state.money < before, 'selling back at the spread lost money — as designed');
  ok(!game.economy.buy('not_a_real_asset', 1).ok, 'a bogus asset id is refused');
  ok(!game.economy.sell(id, 99).ok, 'you cannot sell what you do not have');
  ok(!game.economy.buy(id, 1e9).ok, 'you cannot buy what you cannot afford');
}

/* ============================================================
   5. THE 30-DAY RUN
   ============================================================ */
T('30-day simulated run');
const sim = createGame({ seed: 0xbadc0de, autosave: false });
const seen = { day: 0, hour: 0, money: 0, rep: 0, unlock: 0, quest: 0, client: 0 };
for (const e of Object.keys(seen)) sim.bus.on(e, () => seen[e]++);

const errors = [];
const nanAt = [];
function step(label, fn) {
  try {
    const r = fn();
    const bad = badNumbers(sim.state);
    if (bad.length) nanAt.push(`${label}: ${bad.slice(0, 3).join(', ')}`);
    return r;
  } catch (e) {
    errors.push(`${label}: ${e && e.stack ? e.stack.split('\n')[0] : e}`);
    return null;
  }
}

const startMoney = sim.state.money;
let peakMoney = startMoney;
let courseTaken = false, tokenizedOne = false, orderDone = 0, jobsRun = 0;

/* Read the mentor's message so act-1 step one can close. */
step('read messages', () => sim.actions.readMessages());

for (let day = 1; day <= 30; day++) {
  /* --- morning: eat if hungry --- */
  if (sim.state.hunger > 45) step('eat', () => sim.actions.eat(6, 34));

  /* --- take whatever is on the desk that we can afford --- */
  step('accept', () => {
    for (const o of sim.state.arrivals.slice()) {
      if (sim.state.orders.length >= sim.economy.orderSlots()) break;
      const cost = o.items.reduce((t, it) => t + sim.economy.buyPrice(it.a) * it.q, 0);
      if (cost > sim.state.money * 0.85) continue;
      sim.actions.accept(o);
    }
  });

  /* --- work a shift or two for cash --- */
  for (let s = 0; s < 2; s++) {
    if (sim.state.energy < 30 || sim.time.hour > 17) break;
    const r = step('work', () => sim.actions.work('drive', 0.5 + (day % 7) / 14));
    if (r && r.ok) jobsRun++;
  }

  /* --- source everything the open orders need --- */
  step('source', () => {
    for (const o of sim.state.orders.slice()) {
      for (const it of o.items) {
        const need = it.q - sim.economy.free(it.a);
        if (need > 0) sim.economy.buy(it.a, need);
      }
    }
  });

  /* --- deliver at the desk --- */
  step('deliver', () => {
    if (sim.state.loc !== sim.officeLoc()) sim.travel(sim.officeLoc(), 'bike');
    for (const o of sim.state.orders.slice()) {
      if (sim.economy.canComplete(o)) { if (sim.actions.deliver(o).ok) orderDone++; }
    }
  });

  /* --- a class, once we can pay for it. Market Fundamentals needs
         Asset Inspection first, so we walk the prerequisite chain and
         let courseAvailable() — not the bot — decide if we can go. --- */
  if (!courseTaken) {
    if (sim.known('school') && sim.state.loc !== 'school') step('travel school', () => sim.travel('school', 'bike'));
    for (const cid of ['inspection', 'fundamentals']) {
      if (sim.state.skills[cid]) continue;
      if (!sim.actions.courseAvailable(cid).ok) break;
      const r = step('enrol ' + cid, () => sim.actions.enrol(cid, 0.9));
      if (!r || !r.ok) break;
    }
    if (sim.state.skills.fundamentals) courseTaken = true;
  }

  /* --- tokenize anything we are allowed to --- */
  if (!tokenizedOne) {
    step('tokenize', () => {
      for (const id of Object.keys(sim.state.inv)) {
        if (sim.economy.canTokenize(id).ok) { if (sim.economy.tokenize(id).ok) { tokenizedOne = true; break; } }
      }
      /* nothing owned outright? buy the cheapest tokenizable thing. */
      if (!tokenizedOne && sim.state.money > 700) {
        const cheap = sim.economy.sourceable()
          .filter((a) => a.tq === 1).sort((a, b) => sim.economy.price(a.id) - sim.economy.price(b.id))[0];
        if (cheap && sim.economy.buy(cheap.id, 1).ok && sim.economy.tokenize(cheap.id).ok) tokenizedOne = true;
      }
    });
  }

  /* --- upgrade the desk when we can --- */
  step('office', () => { if (sim.state.rep >= 12 && sim.state.money > 2500) sim.actions.upgradeOffice(); });

  /* --- travel somewhere real so travel/fares get exercised --- */
  step('wander', () => {
    const dests = LOCATIONS.filter((l) => sim.known(l.id) && l.id !== sim.state.loc);
    if (!dests.length) return;
    const d = dests[day % dests.length];
    const opts = sim.fares(d.id);
    const usable = opts.filter((o) => o.ok);
    if (usable.length) sim.travel(d.id, usable[usable.length - 1].mode);
  });

  peakMoney = Math.max(peakMoney, sim.state.money);
  if (sim.state.hunger > 70) step('eat2', () => sim.actions.eat(6, 34));
  step('sleep', () => sim.actions.sleep());
}

eq(errors.length, 0, '30 days ran without throwing', errors.slice(0, 4).join(' | '));
eq(nanAt.length, 0, '30 days ran without producing a NaN', nanAt.slice(0, 4).join(' | '));
eq(sim.state.day, 31, 'thirty sleeps land you on day 31', sim.state.day);
ok(jobsRun > 10, 'the bot actually worked for a living', jobsRun);
ok(orderDone >= 1, 'at least one client order was completed', orderDone);
ok(sim.state.stats.ordersDone >= 1, 'stats.ordersDone recorded it', sim.state.stats.ordersDone);
ok(courseTaken && sim.state.skills.fundamentals, 'a course was passed');
ok(tokenizedOne && sim.state.stats.tokenized >= 1, 'an asset was tokenized');
ok(sim.economy.cityPct() >= 1, 'the city is measurably tokenized', sim.economy.cityPct() + '%');
ok(peakMoney > startMoney, 'the run earned money', `$${startMoney} → peak $${peakMoney}`);
ok(sim.state.stats.earned > sim.state.stats.spent * 0.5, 'earnings are in the right ballpark',
  `earned ${sim.state.stats.earned} spent ${sim.state.stats.spent}`);
ok(sim.state.rep > 0, 'reputation grew', sim.state.rep);
ok(sim.state.stats.trips > 10, 'the bot travelled', sim.state.stats.trips);
ok(sim.quests.progress().done >= 4, 'the story advanced', JSON.stringify(sim.quests.progress()));
ok(LOCATIONS.filter((l) => sim.known(l.id)).length > known0.length, 'the city opened up',
  LOCATIONS.filter((l) => sim.known(l.id)).length);
ok(sim.state.money >= 0, 'money never went negative');
ok(sim.state.energy >= 0 && sim.state.energy <= 100, 'energy stayed in range', sim.state.energy);
ok(sim.state.hunger >= 0 && sim.state.hunger <= 100, 'hunger stayed in range', sim.state.hunger);
ok(sim.state.hist.trnk.length > 1 && sim.state.hist.trnk.length <= 14, 'price history is a rolling window',
  sim.state.hist.trnk.length);
for (const a of ASSETS) {
  const p = sim.state.prices[a.id];
  if (!(Number.isFinite(p) && p >= a.v * 0.41 && p <= a.v * 2.71)) {
    ok(false, `price of ${a.id} stayed inside its band after 30 rolls`, p);
    break;
  }
}
pass++;

T('events fired');
for (const e of ['day', 'hour', 'money', 'rep', 'unlock', 'quest', 'client']) {
  ok(seen[e] > 0, `ctx.bus emitted '${e}' during the run`, seen[e]);
}

/* ============================================================
   6. SAVE ROUND-TRIP
   ============================================================ */
T('save → export → import → load');
{
  const before = JSON.parse(JSON.stringify(sim.state));
  ok(sim.save(true), 'save() wrote to storage');
  ok(sim.hasSave(), 'hasSave() sees it');

  const text = sim.exportSave();
  ok(typeof text === 'string' && text.length > 500, 'exportSave() produced JSON', text.length);
  ok(JSON.parse(text).version === CONFIG.version, 'the export is versioned');

  const imported = sim.importSave(text);
  ok(!!imported, 'importSave() accepted its own export');
  eq(JSON.stringify(sim.state), JSON.stringify(before), 'export → import round-trips identically');

  const loaded = sim.load();
  ok(!!loaded, 'load() read the save back');
  eq(JSON.stringify(sim.state), JSON.stringify(before), 'save → load round-trips identically');

  eq(sim.state.money, before.money, 'money survived the round trip');
  eq(sim.state.day, before.day, 'the day survived');
  eq(Object.keys(sim.state.inv).length, Object.keys(before.inv).length, 'inventory survived');
  eq(Object.keys(sim.state.tokenized).length, Object.keys(before.tokenized).length, 'tokenization survived');

  ok(sim.importSave('} not json {') === null, 'garbage text is refused, not crashed on');
  ok(sim.importSave(JSON.stringify({ hello: 'world' })) === null, 'an unversioned object is refused');
  ok(sim.importSave(JSON.stringify({ version: 999, money: 5 })) === null, 'a save from the future is refused');

  /* a v4 save must migrate forward without losing anything */
  const legacy = JSON.parse(JSON.stringify(before));
  legacy.version = 4;
  delete legacy.stats;
  delete legacy.pawnStock;
  delete legacy.settings;
  legacy.money = 'not a number';
  legacy.inv.__ghost__ = { qty: 3, cost: 1 };
  const mig = sim.importSave(JSON.stringify(legacy));
  ok(!!mig, 'a v4 save migrates forward');
  eq(mig.version, CONFIG.version, 'and lands on the current version');
  ok(Number.isFinite(mig.money), 'a corrupt money field is repaired', mig.money);
  ok(!mig.inv.__ghost__, 'a holding of a non-existent asset is dropped');
  ok(!!mig.stats && !!mig.settings, 'missing sub-objects are forward-filled');
  eq(Object.keys(mig.tokenized).length, Object.keys(before.tokenized).length, 'no tokenized asset was lost in migration');
  eq(badNumbers(mig).length, 0, 'the migrated save has no NaNs', badNumbers(mig));

  /* restore the good state so later tests read a sane world */
  sim.importSave(text);
}

/* ============================================================
   7. QUEST REACHABILITY
   ============================================================ */
T('quest reachability');
{
  /* Every quest predicate must be satisfiable. We build the state a
     completed run would produce and assert each check() flips true —
     a quest whose check() can never pass is a dead objective. */
  const S = newState(mulberry32(1));
  S.flags.readMentor = true;
  S.stats = { ...S.stats, jobsDone: 9, ordersDone: 9, tokenized: 69, ipos: 4, minigames: 40 };
  S.orders = [{ id: 'x', client: 'fenn', items: [] }];
  S.funds = [{ id: 'f1', client: 'fenn', items: [], value: 1, weekly: 1, satisfaction: 90, made: 1 }];
  S.skills = Object.fromEntries(COURSES.map((c) => [c.id, true]));
  S.unlocks = { treasury: true, exchange: true, swap: true, farmcoop: true, mineral: true };
  S.office = 5;
  S.employees = ['pim'];
  S.farm = { ...S.farm, owned: true, lvl: 3 };
  S.mine = { ...S.mine, owned: true, lvl: 3 };
  S.stadium = { step: 10, restored: true, fanVote: 1, group: 1 };
  S.clients.maple.met = true;
  S.visited.goldenheights = true;
  S.home = 'penthouse';
  for (const a of ASSETS) { S.inv[a.id] = { qty: 1, cost: a.v, locked: 0 }; S.tokenized[a.id] = true; }

  let unreachable = [];
  for (const q of QUESTS) {
    let r = false;
    try { r = !!q.check(S); } catch (e) { r = false; }
    if (!r) unreachable.push(q.id);
  }
  eq(unreachable.length, 0, "every quest's check() is reachable", unreachable.join(', '));

  /* and each predicate must be FALSE on a fresh state, or it is not an objective */
  const fresh = newState(mulberry32(2));
  const alreadyTrue = QUESTS.filter((q) => { try { return !!q.check(fresh); } catch (e) { return false; } }).map((q) => q.id);
  eq(alreadyTrue.length, 0, 'no quest is already complete on day 1', alreadyTrue.join(', '));

  /* the objective chain must walk from first to last without a gap */
  const g = createGame({ seed: 7, autosave: false });
  eq(g.quests.current().id, QUESTS[0].id, 'the first objective is the first quest');
  let walked = 0;
  while (g.quests.current() && walked < QUESTS.length + 2) { g.quests.complete(g.quests.current()); walked++; }
  eq(walked, QUESTS.length, 'the objective chain walks all the way to the end', walked);
  eq(g.quests.current(), null, 'and then there are no objectives left');
  eq(g.quests.progress().pct, 100, 'progress reports 100%');
  eq(badNumbers(g.state).length, 0, 'completing every quest produced no NaNs');
}

/* ============================================================
   8. MILESTONES, CLIENTS, TOKENIZATION EDGE CASES
   ============================================================ */
T('tokenization + milestones');
{
  const g = createGame({ seed: 11, autosave: false });
  g.state.money = 500000;
  for (const c of COURSES) g.state.skills[c.id] = true;
  const fired = [];
  g.bus.on('quest', (p) => { if (p.kind === 'milestone') fired.push(p.pct); });
  for (const a of ASSETS) {
    g.economy.add(a.id, 1, a.v);
    const r = g.economy.tokenize(a.id);
    if (!r.ok) { ok(false, `tokenize ${a.id} should succeed with money and every course`, r.why); break; }
  }
  eq(g.economy.cityPct(), 100, 'tokenizing all 69 assets reaches 100%');
  eq(fired.length, MILESTONES.length, 'every milestone fired exactly once', fired.join(','));
  ok(g.state.flags.ms100, 'the endgame milestone flag is set');
  eq(badNumbers(g.state).length, 0, 'a fully tokenized city has no NaNs');
  ok(!g.economy.tokenize('trnk').ok, 'you cannot tokenize the same thing twice');
  ok(!g.economy.canTokenize('nope').ok, 'a bogus id cannot be tokenized');
  ok(g.economy.liquidity('trnk') >= ASSET_BY_ID.trnk.q, 'tokenizing improved liquidity');
}

T('clients + taste matching');
{
  const g = createGame({ seed: 13, autosave: false });
  g.state.rep = 80;
  g.state.money = 200000;
  for (const c of COURSES) g.state.skills[c.id] = true;
  for (const k of ['exchange', 'treasury', 'farmcoop', 'mineral', 'stadiumoffice']) g.state.unlocks[k] = true;

  let made = 0, violations = 0;
  for (const c of CLIENTS) {
    for (let i = 0; i < 12; i++) {
      const o = g.clients.makeOrder(c.id);
      if (!o) continue;
      made++;
      for (const it of o.items) {
        if (c.hate.includes(ASSET_BY_ID[it.a].cat)) violations++;
        if (!Number.isFinite(it.q) || it.q < 1) violations++;
      }
      if (!Number.isFinite(o.budget) || o.budget <= 0) violations++;
      if (!Number.isFinite(o.fee) || o.fee <= 0) violations++;
      if (o.deadline <= g.state.day) violations++;
    }
  }
  ok(made > 200, 'orders can be generated for every client', made);
  eq(violations, 0, 'no client is ever offered something they hate, and every order is well formed');

  for (const c of CLIENTS) {
    ok(g.clients.makeOrder(c.id) !== null, `client ${c.id} can produce an order at rep 80`);
    ok(g.clients.ceilingFor(c, g.state.clients[c.id]) > 0, `client ${c.id} has a price ceiling`);
  }
  ok(g.clients.likes('maple', ASSETS.find((a) => a.cat === CLIENT_BY_ID.maple.fav[0]).id) === 1,
    'likes() recognises a favourite');
  ok(g.clients.trustedCount(0) === 24, 'trustedCount counts everybody at bar 0');

  /* an accepted order can always be completed once you hold the goods */
  const o = g.clients.makeOrder('fenn');
  g.economy.acceptOrder(o);
  for (const it of o.items) g.economy.buy(it.a, it.q);
  ok(g.economy.canComplete(o), 'an order becomes completable once sourced');
  const r = g.economy.completeOrder(o);
  ok(r.ok, 'and it completes', r.why);
  eq(g.state.orders.length, 0, 'the order left the book');
  eq(badNumbers(g.state).length, 0, 'completing an order produced no NaNs');

  /* failing one is survivable */
  const o2 = g.clients.makeOrder('fenn');
  g.economy.acceptOrder(o2);
  g.economy.failOrder(o2);
  eq(g.state.orders.length, 0, 'a failed order leaves the book too');
  ok(g.state.stats.ordersFailed === 1, 'and is counted');
}

T('actions refuse impossible things');
{
  const g = createGame({ seed: 17, autosave: false });
  const refusals = [
    ['work on a bogus job', g.actions.work('not_a_job')],
    ['upgrade the office broke', g.actions.upgradeOffice()],
    ['move into the penthouse on day 1', g.actions.moveHome('penthouse')],
    ['hire an engineer with $250 in hand', g.actions.hire('kite')],
    ['hire a ghost', g.actions.hire('nobody')],
    ['buy into the farm before fixing it', g.actions.farmBuyIn()],
    ['open the mine before the lift', g.actions.mineOpen()],
    ['run an IPO on day 1', g.actions.ipoAdvance('harbourco')],
    ['start the stadium at rep 0', g.actions.stadiumAdvance()],
    ['build the swap on day 1', g.actions.buildSwap()],
    ['borrow more than the credit line', g.actions.borrow(999999)],
    ['repay a loan you do not have', g.actions.repay(100)],
    ['deliver an order that does not exist', g.actions.deliver('nope')],
    ['travel to a place that does not exist', g.travel('atlantis')],
    ['travel somewhere you have not heard of', g.travel('penthouse')],
    ['enrol in a course you cannot afford', g.actions.enrol('advmkt')],
  ];
  for (const [label, r] of refusals) {
    ok(r && r.ok === false && typeof r.why === 'string' && r.why.length > 0,
      `refuses to ${label}, with a reason`, JSON.stringify(r));
  }
  eq(badNumbers(g.state).length, 0, 'sixteen refusals produced no NaNs');
  ok(g.actions.pawnStock().length === 4, 'the pawn shop stocks four things a day');
  ok(g.actions.pawnStock().every((p) => Number.isFinite(p.price) && p.price > 0), 'and prices them');
}

T('world queries the 3D builder needs');
{
  const g = createGame({ seed: 19, autosave: false });
  const ap = LOC_BY_ID.apartment;
  const n = g.nearest(ap.world.x, ap.world.z);
  eq(n.loc.id, 'apartment', 'nearest() finds the building you are standing in');
  ok(g.nearest(99999, 99999, 50) === null, 'nearest() respects a max distance');
  const z = g.zoneAt(ap.world.x, ap.world.z);
  ok(!!z, 'zoneAt() resolves a district from a world position');
  eq(g.zoneOf('apartment').id, ap.z, 'zoneOf() resolves a district from a location');
  ok(g.data.locations === LOCATIONS, 'ctx.game.data.locations is the location table');
  ok(Object.isFrozen(g.data) && Object.isFrozen(g.data.locations[0]), 'content tables are frozen');
  let threw = false;
  try { 'use strict'; g.data.locations[0].world.x = 1; } catch (e) { threw = true; }
  ok(threw || LOC_BY_ID.apartment.world.x !== 1, 'and cannot be mutated by another module');
  /* entering by walking costs no fare and no time */
  const m0 = g.state.money, t1 = g.time.minutes;
  g.enter('trunkdepot');
  eq(g.state.money, m0, 'walking in through the door is free');
  eq(g.time.minutes, t1, 'and costs no extra clock');
  eq(g.state.loc, 'trunkdepot', 'and you are inside');
}

/* ============================================================
   REPORT
   ============================================================ */
console.log('');
if (fails.length) {
  console.log(`FAIL — ${pass} passed, ${fails.length} failed\n`);
  for (const f of fails.slice(0, 40)) console.log('  ✗ ' + f);
  if (fails.length > 40) console.log(`  … and ${fails.length - 40} more`);
  process.exit(1);
}
console.log(`PASS — ${pass} assertions green.`);
console.log(`  ${ASSETS.length} assets · ${CLIENTS.length} clients · ${LOCATIONS.length} locations · ` +
  `${Object.keys(ZONES).length} zones · ${QUESTS.length} quests`);
console.log(`  30-day run: day ${sim.state.day}, $${sim.state.money}, rep ${sim.state.rep}, ` +
  `${sim.state.stats.ordersDone} orders, ${sim.state.stats.jobsDone} shifts, ` +
  `${sim.economy.cityPct()}% tokenized, ${sim.quests.progress().done}/${QUESTS.length} quests`);
process.exit(0);
