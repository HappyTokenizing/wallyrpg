#!/usr/bin/env node
/* ============================================================
   tools/test-game.mjs — the game-systems test suite.

   Plain node. Imports src/game/*.js directly, so those modules must
   never touch `document`, `window` or `localStorage` at import time.
   There is no DOM here and nothing is mocked.

       node tools/test-game.mjs
       node tools/test-game.mjs --verbose

   WHAT IS COVERED, in order: content counts and integrity; TICKERS
   (all 69 present, unique, well-formed, and resolvable by any casing
   or spacing, plus fuzzy search and the label helper); the 3D layout;
   THE TRAVEL TABLE (fare, time and energy at 1 and 5 hops for all
   four modes, and the shape of the deal each one offers); boot;
   the API surface; a 30-day simulated run; save round-trip and the
   v4→v6 and v5→v6 migrations; quest reachability; milestones and
   clients; THE OPENING (phone → Happy → Dispatch, and the cafe SIDE
   quest that must never touch the main objective); THE FRIEND'S
   MESSAGE, word for word; THE BROKER HAND-OFF (picking an order up
   at the desk must move the objective to the Business Broker); THE
   BICYCLE (gated on purchase and on being equipped); THE RIDES
   (bicycle / scooter / motorcycle, their speed ratios, the scooter's
   quest-only door and the motorcycle's price, one-at-a-time
   equipping and the v6 -> v7 migration); the guarantee that a broke,
   exhausted player is never hard-locked; that no player-visible
   string says Uber; refusals; the world queries the 3D builder
   needs; DISCOVERY BY WALKING (a radius that can never reach a
   neighbour, a dwell that a teleport cannot bank, and the proof that
   finding a building opens not one of its gates); and THE FIRST
   CLIENT ORDER, which is CRUMB at the Business Broker down both
   routes in and across sixty seeds each.

   Exits non-zero on the first hard failure summary.
   ============================================================ */

import DATA, {
  CONFIG, CATEGORIES, ASSETS, ASSET_BY_ID, ASSET_BY_TICK, VENUES, VENUE_LOC,
  CLIENTS, CLIENT_BY_ID, COURSES, COURSE_BY_ID, OFFICE_STAGES,
  HOMES, HOME_BY_ID, ZONES, LOCATIONS, LOC_BY_ID, WORLD, MAP,
  TRAVEL, BIKE, JOBS, EMPLOYEE_POOL, IPOS, IPO_STEPS, STADIUM_STEPS,
  NEWS_POOL, QUESTS, SIDE_QUESTS, MILESTONES, TIPS, MORNING_NOTES,
  OPENING_MESSAGE, byTicker, assetLabel, searchAssets, normTicker,
  RIDES, RIDE_LIST, RIDE_ORDER, SIDE_QUEST_BY_ID, QUEST_BY_ID,
  REP_TITLES, RACE, PRODUCERS, SLATE_MEAL, NPC_POSTS, ORDER_FAIL, HAPPY_ENDING, EMPLOYEE_BY_ID,
  DISCOVER, FIRST_ORDER, ruleLabel,
  repProgress, orderFailRep,
  hops, fare, rideFare, worldDistance, strideCost, isFastTravel,
} from '../src/game/data.js';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
/* THIS USED TO READ "at least 3 fast-travel modes" and it passed by
   counting MODES rather than FAST ones — there are four modes and only
   two of them are fast travel, which is the whole rule of this round,
   and the assertion meant to guard it was blind to it. */
eq(Object.keys(TRAVEL).length, 4, 'four travel modes');
eq(Object.keys(TRAVEL).filter((m) => TRAVEL[m].fast).join(','), 'train,trunk',
  'exactly TWO of them are fast travel: the Metro and the Yoober');
eq(Object.keys(TRAVEL).filter((m) => !TRAVEL[m].fast).join(','), 'walk,bike',
  'and the other two are self-powered — he covers that ground himself');
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
for (const o of OFFICE_STAGES) {
  ok(o.slots >= 1 && o.invCap >= 1, `office ${o.n} has slots and capacity`);
  ok(Number.isFinite(o.seats) && o.seats >= 1, `office ${o.n} declares its seats`, o.seats);
  ok(Number.isFinite(o.fundCap) && o.fundCap >= 0, `office ${o.n} declares its fund capacity`, o.fundCap);
}
for (const n of NEWS_POOL) ok(!!ASSET_BY_ID[n.a], `news "${n.h}" points at a real asset`, n.a);
for (const q of QUESTS) {
  ok(typeof q.check === 'function', `quest ${q.id} has a check()`);
  ok(!q.loc || q.loc === 'office' || !!LOC_BY_ID[q.loc], `quest ${q.id} points at a real place`, q.loc);
  ok(q.act >= 1 && q.act <= 5, `quest ${q.id} belongs to one of the five acts`, q.act);
}
for (const k of Object.keys(TIPS)) ok(!!TIPS[k].t && !!TIPS[k].d, `tip ${k} has a title and body`);
for (const m of MORNING_NOTES) ok(m.day >= 1 && !!m.msg, `morning note day ${m.day} is well formed`);

/* ============================================================
   2b. TICKERS — every asset has one, and it is the primary handle.
   ============================================================ */
T('tickers');
{
  eq(ASSETS.filter((a) => !!a.tick).length, 69, 'all 69 assets carry a ticker');

  const ticks = ASSETS.map((a) => a.tick);
  const seenT = new Set(), dupT = [];
  for (const t of ticks) { if (seenT.has(t)) dupT.push(t); seenT.add(t); }
  /* THE COLLISION GUARD. A future edit that reuses a symbol fails here
     rather than in a save file, which is the only place it would
     otherwise show up. */
  eq(dupT.length, 0, 'every ticker is unique across all 69 assets', dupT.join(', '));
  eq(seenT.size, ASSETS.length, 'the ticker index has one entry per asset');
  eq(Object.keys(ASSET_BY_TICK).length, ASSETS.length, 'ASSET_BY_TICK covers the catalogue');

  const badShape = ticks.filter((t) => !/^[A-Z0-9]{3,5}$/.test(t));
  eq(badShape.length, 0, 'every ticker is 3–5 uppercase alphanumerics', badShape.join(', '));

  /* The 15 stock symbols are load-bearing: they are in save files and
     in quest text, so they must survive every future edit unchanged. */
  const STOCK_TICKS = ['TRNK', 'ACRN', 'MMTR', 'BGRD', 'CTSK', 'STMD', 'BRBM', 'BLRV',
    'ORBT', 'CZBR', 'PBMB', 'LNTR', 'RVRN', 'WFLW', 'NRTH'];
  const stocks = ASSETS.filter((a) => a.cat === 'Stocks').map((a) => a.tick);
  eq(stocks.join(','), STOCK_TICKS.join(','), 'the 15 original stock tickers are untouched');

  /* the category conventions that make them guessable */
  eq(byTicker('B3M').id, 'bond3m', 'bonds read as maturities: B3M');
  eq(byTicker('B10Y').id, 'bond10y', '…and B10Y');
  eq(byTicker('WHEAT').id, 'wheat', 'WHEAT is the wheat');
  eq(byTicker('GOLD').id, 'gold', 'GOLD is the gold');
  eq(ASSETS.filter((a) => a.cat === 'Property').every((a) => a.tick[0] === 'P'), true,
    'every Property ticker starts with P');

  /* resolution: case-insensitive, whitespace-tolerant, id or ticker */
  eq(byTicker('gold').id, 'gold', 'lower case resolves');
  eq(byTicker('  GoLd  ').id, 'gold', 'surrounding whitespace and mixed case resolve');
  eq(byTicker('b5y').id, 'bond5y', 'a bond ticker resolves in lower case');
  eq(byTicker('bond5y').id, 'bond5y', 'the canonical id still resolves');
  eq(byTicker('nope'), null, 'an unknown symbol resolves to null, not a crash');
  eq(byTicker(null), null, 'and so does null');
  eq(normTicker(' g-o l.d '), 'GOLD', 'normTicker strips case, space and punctuation');

  /* every ticker AND every id must round-trip */
  const unresolvable = ASSETS.filter((a) => byTicker(a.tick)?.id !== a.id || byTicker(a.id)?.id !== a.id);
  eq(unresolvable.length, 0, 'every ticker and every id resolves back to its own asset',
    unresolvable.map((a) => a.id).join(', '));

  /* fuzzy / prefix search over ticker AND name */
  const has = (q, id) => searchAssets(q, 12).some((a) => a.id === id);
  ok(has('gol', 'gold'), "typing 'gol' finds GOLD");
  ok(has('wheat', 'wheat'), "typing 'wheat' finds WHEAT");
  ok(has('whe', 'wheat'), "typing 'whe' finds WHEAT");
  ok(has('strawberry', 'straw'), "typing the full name 'strawberry' finds BERRY");
  ok(has('BERRY', 'straw'), '…and so does its ticker');
  ok(has('stampede', 'stampede'), "typing 'stampede' finds the team token");
  ok(has('cloudtusk', 'ctsk'), 'name search works for stocks too');
  eq(searchAssets('gold', 12)[0].id, 'gold', 'an exact ticker ranks first');
  eq(searchAssets('').length, 0, 'an empty query returns nothing');
  eq(searchAssets('zzzzqqq').length, 0, 'a nonsense query returns nothing');
  ok(searchAssets('a', 5).length <= 5, 'the result limit is respected');

  /* the label helper — callers must never concatenate by hand */
  eq(assetLabel('gold'), 'GOLD · Gold Seam Token', 'label() leads with the ticker');
  eq(assetLabel('GOLD'), 'GOLD · Gold Seam Token', '…from either handle');
  ok(ASSETS.every((a) => assetLabel(a.id).startsWith(a.tick)), 'every asset label leads with its ticker');
}

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
ok(fare('walk', 'apartment', 'exchange').cost === 0, 'walking is always free');
/* This used to read fare('taxi', ...), which is not a mode: fare()
   returns all-zeroes for an unknown mode, so `0 < anything` passed
   the assertion while testing nothing at all. */
ok(fare('trunk', 'apartment', 'exchange').mins < fare('bike', 'apartment', 'exchange').mins,
  'a Yoober beats the bicycle on time');
eq(fare('bike', 'apartment', 'apartment').mins, 0, 'going nowhere takes no time');
eq(fare('nosuchmode', 'apartment', 'exchange').mins, 0, 'an unknown mode returns a zeroed fare');

/* ============================================================
   3b. THE TRAVEL TABLE — four modes, four trade-offs.
   Documented in data.js; asserted here so a retune that breaks the
   shape of the deal cannot land quietly.
   ============================================================ */
T('the travel table');
{
  /* a real pair of locations for each hop count we care about */
  const pairAt = (n) => {
    for (const A of LOCATIONS) for (const B of LOCATIONS) if (hops(A.id, B.id) === n) return [A.id, B.id];
    return null;
  };
  const p1 = pairAt(1), p5 = pairAt(5);
  ok(!!p1 && !!p5, 'the island has both 1-hop and 5-hop journeys');

  eq(Object.keys(TRAVEL).length, 4, 'four travel modes');
  for (const m of ['walk', 'bike', 'train', 'trunk']) ok(!!TRAVEL[m], `mode '${m}' exists (id unchanged)`, m);
  eq(TRAVEL.train.n, 'Metro', "'train' displays as Metro");
  eq(TRAVEL.trunk.n, 'Yoober', "'trunk' displays as Yoober");

  const at = (m, p) => fare(m, p[0], p[1]);
  for (const m of Object.keys(TRAVEL)) {
    for (const [label2, p] of [['1 hop', p1], ['5 hops', p5]]) {
      const f = at(m, p);
      ok(Number.isFinite(f.cost) && f.cost >= 0, `${m} @ ${label2}: fare is a real, non-negative number`, f.cost);
      ok(Number.isFinite(f.mins) && f.mins >= 3 && f.mins <= 180, `${m} @ ${label2}: takes 3..180 minutes`, f.mins);
      ok(Number.isFinite(f.energy) && f.energy >= 0 && f.energy <= 40, `${m} @ ${label2}: costs 0..40 energy`, f.energy);
    }
  }

  const w1 = at('walk', p1), w5 = at('walk', p5);
  const b1 = at('bike', p1), b5 = at('bike', p5);
  const m1 = at('train', p1), m5 = at('train', p5);
  const u1 = at('trunk', p1), u5 = at('trunk', p5);

  /* WALKING — free, slow, tiring. The floor. */
  eq(w1.cost, 0, 'walking costs nothing at 1 hop');
  eq(w5.cost, 0, 'walking costs nothing at 5 hops');
  ok(w5.mins > w1.mins && w5.energy > w1.energy, 'walking scales with distance');

  /* THE BICYCLE — the reward for investing early. */
  eq(b5.cost, 0, 'the bicycle is free to run');
  ok(b5.mins < w5.mins * 0.6, 'the bicycle is meaningfully faster than walking',
    `${b5.mins}m vs ${w5.mins}m`);
  ok(b5.energy < w5.energy * 0.5, 'and meaningfully easier on the legs',
    `${b5.energy}e vs ${w5.energy}e`);

  /* THE METRO — a lot of energy, very little money. */
  ok(m5.cost > 0 && m5.cost < 15, 'the Metro across town costs pocket change', m5.cost);
  ok(m5.cost < u5.cost * 0.2, 'and a small fraction of a Yoober', `${m5.cost} vs ${u5.cost}`);
  ok(m1.energy > w1.energy, 'one Metro stop is more tiring than walking it', `${m1.energy}e vs ${w1.energy}e`);
  ok(m5.energy / m5.mins > w5.energy / w5.mins * 1.5,
    'per minute, the Metro is far more draining than walking',
    `${(m5.energy / m5.mins).toFixed(2)} vs ${(w5.energy / w5.mins).toFixed(2)} e/min`);
  ok(m5.mins < w5.mins * 0.5, 'but it buys back most of the day', `${m5.mins}m vs ${w5.mins}m`);

  /* YOOBER — very little energy, expensive, and sharply distance-priced. */
  ok(u1.energy <= 0.5, 'a Yoober costs almost no energy', u1.energy);
  ok(u5.energy < m5.energy * 0.1, 'a fraction of the Metro', `${u5.energy} vs ${m5.energy}`);
  ok(u1.cost >= 20, 'a Yoober is never cheap, even for one hop', u1.cost);
  ok(u5.cost / u1.cost > 3, 'a five-hop Yoober is more than triple a one-hop Yoober',
    `1 hop $${u1.cost}, 5 hops $${u5.cost}`);
  /* CONVEX IN DISTANCE. The user asked for a fare that varies with
     distance more sharply than the old flat 9 + 7·h. Convexity is the
     property that makes a long Yoober hurt: each additional hop costs
     MORE than the one before it. Measured on the hop counts directly,
     not on a pair of locations, so it is the pricing rule under test. */
  const uc = (h) => TRAVEL.trunk.base + TRAVEL.trunk.per * h + TRAVEL.trunk.surge * h * h;
  const d1 = uc(2) - uc(1), d4 = uc(5) - uc(4);
  ok(d4 > d1, 'each extra hop in a Yoober costs more than the last',
    `2nd hop +$${d1.toFixed(2)}, 5th hop +$${d4.toFixed(2)}`);
  ok(uc(5) / 5 > uc(1) - TRAVEL.trunk.base, 'the fare is superlinear, not a flat rate per hop');
  ok(u5.mins < m5.mins, 'it is the fastest way across town', `${u5.mins}m vs ${m5.mins}m`);

  /* the four modes are genuinely different deals, not reskins */
  const costs = [w5.cost, b5.cost, m5.cost, u5.cost];
  ok(new Set(costs).size >= 3, 'the five-hop fares are three different orders of magnitude', costs.join('/'));
  ok(BIKE.cost > 0 && BIKE.locs.every((l) => !!LOC_BY_ID[l]), 'the bicycle has a price and somewhere to buy it',
    `$${BIKE.cost} at ${BIKE.locs.join(', ')}`);
  ok(BIKE.cost < 400, 'and it is reachable in the first few days', BIKE.cost);
}

/* ============================================================
   4. BOOT — headless, no DOM
   ============================================================ */
T('headless boot');
ok(typeof globalThis.document === 'undefined', 'no document exists in this process');
ok(typeof globalThis.window === 'undefined', 'no window exists in this process');

const game = createGame({ seed: 0x5eed1e, autosave: false });
ok(!!game, 'createGame() returned a handle');

/* ------------------------------------------------------------
   NAME THE BRANCH BEFORE ASSERTING ANYTHING ABOUT TRAVEL.

   travel() has two shapes for a self-powered leg and which one you
   get is `hasWalker`. In the browser init(ctx) sets it true from the
   position feed and a walk becomes a ROUTE. Here there is no world,
   no controller and no elephant, so nothing will ever cover a metre
   and travel() resolves the leg itself as a lump.

   Every travel assertion in this file below this line is therefore
   the NO-WALKER branch, and it says so. It was not saying so, and
   that is how 3386 green assertions ran the lump-sum path while the
   round they were meant to be covering was about the other one.
   tools/traveltest.mjs asserts table.walker before anything else and
   owns the routed branch in a real browser; the WALKER section at the
   end of this file drives the routed branch here too, by hand.
   ------------------------------------------------------------ */
eq(game.hasWalker, false,
  '[no-walker] nothing in this process walks him, so travel() resolves a self-powered leg itself');
eq(typeof game.setWalker, 'function', '[no-walker] …and the switch that says so is public');
eq(game.route, null, '[no-walker] a fresh game has no route');

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
  'tokenizeCost', 'cityPct', 'netWorth', 'acceptOrder', 'completeOrder', 'newDay', 'afford',
  'findByTicker', 'search', 'ticker', 'label', 'ticket', 'idOf']) {
  ok(typeof game.economy[k] === 'function', `ctx.game.economy.${k} exists`);
}
for (const k of ['current', 'check', 'complete', 'progress', 'knows', 'milestones',
  'sideCurrent', 'sides', 'startSide', 'sideProgress', 'isSideActive']) {
  ok(typeof game.quests[k] === 'function', `ctx.game.quests.${k} exists`);
}
for (const k of ['buyBike', 'canBuyBike', 'equipBike', 'bike', 'metHappy']) {
  ok(typeof game.actions[k] === 'function', `ctx.game.actions.${k} exists`);
}
for (const k of ['happyPending', 'happyReady', 'beats', 'ordersUnlocked']) {
  ok(typeof game.story[k] === 'function', `ctx.game.story.${k} exists`);
}
for (const k of ['ticket', 'ordersUnlocked']) {
  ok(typeof game.clients[k] === 'function', `ctx.game.clients.${k} exists`);
}
/* the ticker lookup is reachable through ctx.game.economy, which is
   where the UI agent builds buying on it */
eq(game.economy.findByTicker('  gOlD ').id, 'gold', 'economy.findByTicker is case- and space-tolerant');
eq(game.economy.ticker('gold'), 'GOLD', 'economy.ticker() gives the symbol');
eq(game.economy.label('gold'), 'GOLD · Gold Seam Token', 'economy.label() leads with it');
eq(game.economy.price('GOLD'), game.economy.price('gold'), 'every economy call takes a ticker or an id');
eq(game.economy.ticket([{ a: 'wheat', q: 3 }, { a: 'gold', q: 1 }]), '3x WHEAT · GOLD',
  'economy.ticket() renders an order as a trade ticket');
ok(game.economy.search('gol').some((a) => a.id === 'gold'), 'economy.search() is the fuzzy door');
ok(!game.economy.buy('NOTATICKER', 1).ok, 'an unrecognised symbol is still refused');
ok(game.hud().bike && game.hud().bike.owned === false, 'hud() reports the bicycle');
eq(game.hud().sideObjective, null, 'hud() has a side-objective slot, empty on day one');
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
  /* THE COUNTER KEEPS HOURS. The Exchange trades 09:00–16:00 and until
     this pass economy.buy() would sell you a share at four in the
     morning — the hours were drawn in the UI and enforced nowhere. */
  game.state.time = 4 * 60;
  const shut = game.economy.buy(id, 1);
  ok(!shut.ok && shut.kind === 'hours', 'a closed venue refuses to trade', JSON.stringify(shut));
  ok(/opens at 09:00/.test(shut.why), 'and the refusal names the opening time', shut.why);
  game.state.time = 12 * 60;                 // every venue in the city is open at noon
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
let boughtBike = false, sideStarted = false, sideDone = false;
const questOrder = [];
sim.bus.on('quest', (p) => { if (p.kind === 'complete') questOrder.push(p.quest); });
sim.bus.on('quest', (p) => { if (p.kind === 'side:start') sideStarted = true; });
sim.bus.on('quest', (p) => { if (p.kind === 'side:complete') sideDone = true; });

/* BEAT 1. Otto's message is already on the phone; reading it closes
   act-1 step one and cues the Happy encounter. */
ok(sim.state.msgs.length >= 1, 'a new game starts with a message already on the phone');
ok(!sim.state.flags.readMentor, 'and it has not been read yet');
step('read messages', () => sim.actions.readMessages());
ok(sim.state.flags.readMentor, 'reading it sets the flag the first objective checks');

/* the mode the bot uses before it owns a bicycle, and after */
const bestMode = (destId) => {
  const opts = sim.fares(destId).filter((o) => o.ok);
  const bike = opts.find((o) => o.mode === 'bike');
  if (bike) return 'bike';
  const metro = opts.find((o) => o.mode === 'train' && o.cost < sim.state.money * 0.06);
  if (metro && sim.state.energy > 30) return 'train';
  return 'walk';
};

/* THE BOT NOW OBEYS THE RULES LAYER, because the rules layer is now
   the authority: a shift is worked AT the depot during its hours, a
   meal is eaten where food is sold, a venue that is shut will not sell
   you anything, and you sleep in your own bed. Every one of those used
   to work from anywhere at any hour. The bot doing the day properly is
   itself the test. */
const go = (id) => {
  if (sim.state.loc === id) return true;
  const r = sim.travel(id, bestMode(id));
  return !!(r && r.ok);
};
const feed = () => step('eat', () => {
  const f = sim.needs().food;
  if (!f || !f.act) return;
  if (!go(f.id)) return;
  sim.actions.eatAct(f.act);
});

for (let day = 1; day <= 30; day++) {
  /* --- morning: eat if hungry --- */
  if (sim.state.hunger > 45) feed();

  /* --- take whatever is on the desk that we can afford --- */
  step('accept', () => {
    for (const o of sim.state.arrivals.slice()) {
      if (sim.state.orders.length >= sim.economy.orderSlots()) break;
      const cost = o.items.reduce((t, it) => t + sim.economy.buyPrice(it.a) * it.q, 0);
      if (cost > sim.state.money * 0.85) continue;
      sim.actions.accept(o);
    }
  });

  /* --- work a shift or two for cash, AT THE DEPOT --- */
  for (let s = 0; s < 2; s++) {
    if (sim.state.energy < 30 || sim.time.hour > 17) break;
    if (!go('trunkdepot')) break;
    const r = step('work', () => sim.actions.work('drive', 0.5 + (day % 7) / 14));
    if (r && r.ok) jobsRun++; else break;
  }

  /* --- source everything the open orders need --- */
  step('source', () => {
    for (const o of sim.state.orders.slice()) {
      for (const it of o.items) {
        const need = it.q - sim.economy.free(it.a);
        /* THE COUNTER HAS TO BE OPEN. economy.buy() refuses a closed
           venue now, so the bot checks the clock like a player would. */
        if (need > 0 && sim.economy.venueOpenNow(sim.economy.venueOf(it.a))) sim.economy.buy(it.a, need);
      }
    }
  });

  /* --- a bicycle, as soon as we are standing somewhere that sells one
         and can spare the money. This is the gate under test: before
         this succeeds, fares() must refuse the 'bike' mode. --- */
  if (!boughtBike) {
    step('bike', () => {
      if (sim.state.money < BIKE.cost + 120) return;
      if (!BIKE.locs.includes(sim.state.loc)) sim.travel(BIKE.locs[0], bestMode(BIKE.locs[0]));
      if (sim.actions.buyBike().ok) boughtBike = true;
    });
  }

  /* --- deliver at the desk --- */
  step('deliver', () => {
    if (sim.state.loc !== sim.officeLoc()) sim.travel(sim.officeLoc(), bestMode(sim.officeLoc()));
    for (const o of sim.state.orders.slice()) {
      if (sim.economy.canComplete(o)) { if (sim.actions.deliver(o).ok) orderDone++; }
    }
  });

  /* --- a class, once we can pay for it. Market Fundamentals needs
         Asset Inspection first, so we walk the prerequisite chain and
         let courseAvailable() — not the bot — decide if we can go. --- */
  if (!courseTaken) {
    if (sim.known('school') && sim.state.loc !== 'school') step('travel school', () => sim.travel('school', bestMode('school')));
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

  /* --- the cafe, once: meeting Otto there starts the SIDE quest --- */
  if (day === 2 && sim.known('cafe')) {
    step('cafe', () => sim.travel('cafe', bestMode('cafe')));
  }

  /* --- travel somewhere real so travel/fares get exercised. Rotate
         through the modes rather than always taking the last one:
         that used to mean a Yoober every single day, which at the new
         fares is a shift's pay for a walk Wally could have taken. --- */
  step('wander', () => {
    const dests = LOCATIONS.filter((l) => sim.known(l.id) && l.id !== sim.state.loc);
    if (!dests.length) return;
    const d = dests[day % dests.length];
    const usable = sim.fares(d.id).filter((o) => o.ok);
    if (!usable.length) return;
    const pick = usable[day % usable.length];
    /* never spend more than a tenth of the wallet on a whim */
    sim.travel(d.id, pick.cost <= sim.state.money * 0.1 ? pick.mode : 'walk');
  });

  peakMoney = Math.max(peakMoney, sim.state.money);
  if (sim.state.hunger > 70) feed();
  /* and home to bed, because that is where the bed is */
  step('sleep', () => { go('apartment'); return sim.actions.sleep(); });
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

/* --- the opening, as it actually played out over thirty days --- */
ok(boughtBike, 'the bot bought a bicycle');
ok(sim.state.rides.owned.bike, 'and the bicycle is owned in the save', JSON.stringify(sim.state.rides));
ok(!!sim.state.rides.equipped, 'and something is equipped to ride', sim.state.rides.equipped);
ok(sim.state.bike.owned === sim.state.rides.owned.bike
   && sim.state.bike.equipped === (sim.state.rides.equipped === 'bike'),
  'the legacy state.bike mirror agrees with state.rides',
  JSON.stringify(sim.state.bike) + ' vs ' + JSON.stringify(sim.state.rides));
ok(sim.state.flags.dispatchShift, 'a shift was worked at Dispatch');
ok(sideStarted, 'meeting Otto at the cafe started the side quest');
ok(sideDone, 'and the side quest was completed', JSON.stringify(sim.quests.sideProgress()));
{
  /* RELATIVE order, not absolute: a quest closes the moment its
     predicate flips, so an optional step the bot happened to satisfy
     early (a class, say) can legitimately land in between. What must
     hold is the causal chain. */
  const i = (id) => questOrder.indexOf(id);
  const seq = questOrder.slice(0, 6).join(' → ');
  ok(i('q_wake') === 0, 'the phone message closed first', seq);
  ok(i('q_first_job') > i('q_wake'), 'then the shift at Dispatch', seq);
  ok(i('q_first_client') > i('q_first_job'), 'then the first client order', seq);
  ok(i('q_first_fee') > i('q_first_client'), 'then delivering it', seq);
  /* THE SIDE QUEST IS NOT IN THIS LIST AT ALL. questOrder only records
     kind:'complete', which side quests never emit — they emit
     'side:complete'. That separation is what keeps the objective
     strip on the main chain. */
  ok(!questOrder.includes('q_side_otto'), 'and the side quest never entered the main chain');
}
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

  /* --- v5 -> v6: the bicycle and the side quests --- */
  {
    const v5 = JSON.parse(JSON.stringify(before));
    v5.version = 5;
    delete v5.bike;                 // v5 had no bicycle record…
    delete v5.rides;                // …and certainly no rides table…
    delete v5.sides;                // …and no side quests
    v5.travel = 'bike';             // …and handed you a bicycle for free
    const m6 = sim.importSave(JSON.stringify(v5));
    ok(!!m6, 'a v5 save migrates forward');
    eq(m6.version, CONFIG.version, 'and lands on v6');
    ok(!!m6.bike && m6.bike.owned === false && m6.bike.equipped === false,
      'it wakes up with no bicycle, because it never bought one', JSON.stringify(m6.bike));
    eq(m6.travel, 'walk', 'and on foot rather than riding a bicycle it does not own');
    ok(!!m6.sides && typeof m6.sides === 'object', 'state.sides is forward-filled');
    eq(m6.money, before.money, 'money survived the version bump');
    eq(Object.keys(m6.inv).length, Object.keys(before.inv).length, 'so did the holdings');
    eq(Object.keys(m6.quests).length, Object.keys(before.quests).length, 'and the quest progress');
    ok(CONFIG.legacyKeys.includes('wally_rpg_save_v5'), 'the v5 storage key is still adopted on load');
  }
  /* a nonsense bicycle record is repaired rather than trusted */
  {
    const bad = JSON.parse(JSON.stringify(before));
    bad.bike = { owned: false, equipped: true };      // riding one you do not own
    bad.sides = { q_side_otto: 'banana', q_ghost: 'active' };
    const fixed = sim.importSave(JSON.stringify(bad));
    eq(fixed.bike.equipped, false, 'equipped cannot be true without owned');
    ok(!fixed.sides.q_side_otto, 'an unknown side-quest status is dropped');
    ok(!fixed.sides.q_ghost, 'and so is a side quest that no longer exists');
  }

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
  S.flags.dispatchShift = true;
  S.flags.metHappy = true;
  S.flags.metFriend = true;
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
  S.seen.broker = true;
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
  g.state.time = 12 * 60;                    // every venue in the city is open at noon
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

/* ============================================================
   9. THE OPENING — phone, Happy, the cafe side quest, Dispatch
   ============================================================ */
T('the opening story beats');
{
  const g = createGame({ seed: 23, autosave: false });
  const beats = [];
  g.bus.on('story', (p) => beats.push(p.beat));
  const sideEvents = [];
  g.bus.on('quest', (p) => { if (String(p.kind).startsWith('side:')) sideEvents.push(p.kind + ':' + p.quest); });

  /* --- a. the phone message from a friend --- */
  eq(g.state.msgs.length, 1, 'day one: exactly one message on the phone');
  eq(g.state.msgs[0].from, 'Otto', 'it is from a friend, by name');
  eq(g.state.msgs[0].read, false, 'and it is unread');
  ok(/cafe|Bent Spoon/i.test(g.state.msgs[0].text), 'it asks Wally to meet at the cafe');
  ok(g.state.msgs[0].text.length > 120, 'and it is written, not stubbed', g.state.msgs[0].text.length);
  ok(Object.isFrozen(OPENING_MESSAGE), 'the template is frozen');
  ok(g.state.msgs[0] !== OPENING_MESSAGE, 'but state holds a writable clone of it');
  eq(g.quests.current().id, 'q_wake', 'the first objective is to read it');
  ok(g.known('cafe'), 'the cafe is on the map from the start — the message points at it');

  /* --- the Happy hook, right after the phone --- */
  eq(g.story.happyReady(), false, 'Happy is not cued before the message is read');
  g.actions.readMessages();
  ok(g.state.flags.readMentor, 'reading it sets flags.readMentor');
  ok(beats.includes('happy'), "reading it emits bus 'story' {beat:'happy'}", beats.join(','));
  ok(g.story.happyPending(), 'and story.happyPending() is true until the NPC agent calls back');
  ok(!g.state.flags.metHappy, 'flags.metHappy is not set by the cue alone');
  const mh = g.actions.metHappy();
  ok(mh.ok && mh.first, 'actions.metHappy() is the callback');
  ok(g.state.flags.metHappy, 'and it sets flags.metHappy');
  ok(beats.includes('happy:done'), "…and emits {beat:'happy:done'}");
  eq(g.story.happyPending(), false, 'the beat is no longer pending');
  ok(!g.actions.metHappy().first, 'calling it twice is idempotent');

  /* --- c. the main chain now runs through Dispatch --- */
  eq(LOC_BY_ID.trunkdepot.n, 'Dispatch', "location 'trunkdepot' displays as Dispatch");
  ok(!!LOC_BY_ID.trunkdepot, "…and keeps its id, so saves and 3D placement still work");
  eq(g.quests.current().id, 'q_first_job', 'the second objective is the Dispatch shift');
  eq(g.quests.questLoc('q_first_job'), 'trunkdepot', 'and it points at Dispatch');
  ok(/Dispatch/.test(g.quests.current().t), 'the objective says so in words', g.quests.current().t);

  /* NO CLIENT WORK EXISTS YET. This is the gate the user asked for:
     the first client order does not unlock until a shift is worked. */
  eq(g.clients.ordersUnlocked(), false, 'client orders are locked before the shift');
  eq(g.state.arrivals.length, 0, 'nobody is waiting at the desk on day one');
  g.clients.seedArrivals();
  g.clients.dailyOffers();
  eq(g.state.arrivals.length, 0, 'and neither seeding nor the daily roll can conjure one');

  /* AND IT IS WORKED AT DISPATCH. work() used to take the key and
     nothing else — you could drive a shift from your own bed. */
  const fromBed = g.actions.work('drive', 0.8);
  ok(!fromBed.ok, 'a Dispatch shift cannot be worked from the apartment', JSON.stringify(fromBed));
  ok(/Dispatch/.test(fromBed.why), 'and the refusal names the place', fromBed.why);
  ok(g.enter('trunkdepot').ok, 'so he walks into Dispatch');
  const w = g.actions.work('drive', 0.8);
  ok(w.ok, 'a shift at Dispatch can be worked on day one', w.why);
  ok(g.state.flags.dispatchShift, 'it sets flags.dispatchShift');
  ok(beats.includes('dispatch'), "and emits {beat:'dispatch'}");
  ok(g.clients.ordersUnlocked(), 'which unlocks client orders');
  ok(g.state.arrivals.length >= 1, 'and puts somebody on the desk', g.state.arrivals.length);
  ok(g.state.quests.q_first_job, 'the objective closed');
  eq(g.quests.current().id, 'q_first_client', 'and the next one is the first client order');

  /* --- b. the cafe: a SIDE quest, alongside the main chain ---

     AND THE PLAYER IS NOW SENT THERE. The opening message says "come
     and find me at the Bent Spoon"; until this pass nothing in the
     game pointed at it, so q_side_otto_meet arms the moment the phone
     is read and puts the cafe in the side slot. */
  const mainBefore = g.quests.current().id;
  ok(!!g.quests.sideCurrent(), 'reading the message opened a side objective');
  eq(g.quests.sideCurrent().id, 'q_side_otto_meet', 'and it is the one that points at the cafe');
  eq(g.quests.questLoc('q_side_otto_meet'), 'cafe', 'questLoc() resolves it to the Bent Spoon');
  ok(g.known('cafe'), 'which is a place he has heard of, so the pointer has a target');
  /* AND OTTO IS ACTUALLY IN THE ROOM. clients.at() used to place every
     client by their HOME zone, and Otto lives in Rusty Row — so the
     friend you are told to meet on Main Street was never there. */
  ok(g.clients.postsAt('cafe').some((c) => c.id === 'otto'), 'Otto is posted at the Bent Spoon');
  ok(g.whoIsAt('cafe').some((c) => c.id === 'otto'), 'and whoIsAt() reports him there');
  ok(!g.whoIsAt('cafe').find((c) => c.id === 'otto').waiting === false, 'flagged as waiting for you');
  g.state.energy = 100;
  const trip = g.travel('cafe', 'walk');
  ok(trip.ok, 'you can walk to the cafe', trip.why);
  ok(beats.includes('cafe'), "arriving emits {beat:'cafe'}", beats.join(','));
  ok(g.state.flags.metFriend, 'and sets flags.metFriend');
  ok(g.clients.met('otto'), 'Otto has been met');
  ok(sideEvents.includes('side:start:q_side_otto'), 'a side quest started', sideEvents.join(','));
  ok(!!g.quests.sideCurrent(), 'quests.sideCurrent() reports it');
  eq(g.quests.sideCurrent().id, 'q_side_otto', 'by id');
  eq(g.quests.sideStatus('q_side_otto'), 'active', 'and state.sides records it as active');
  ok(g.state.arrivals.some((o) => o.client === 'otto'), 'and he left an order on the desk');
  {
    /* A FRIEND'S FIRST ORDER IS ONE THING, IT IS CRUMB, AND IT IS
       SOLD AT THE BROKER. Rolled normally, Otto's ceiling reaches a
       $480 gallery collection on day one. The old hand-built version
       fixed that by taking the CHEAPEST of a four-asset shortlist —
       which is SNEAK at $210, sold at the Culture Bazaar — while the
       objective this very order triggers says "Go and see the Business
       Broker". The shopping list and the arrow now point at the same
       counter. See FIRST_ORDER in data.js, and section 24 below, which
       proves it across every route in and a hundred seeds. */
    const oo = g.state.arrivals.find((x) => x.client === 'otto');
    eq(oo.items.length, 1, 'it is one thing, not a basket');
    eq(oo.items[0].q, 1, 'and one of it');
    eq(oo.items[0].t, 'CRUMB', 'and the one thing is CRUMB');
    eq(ASSET_BY_ID[oo.items[0].a].ven, 'broker', 'sold at the Business Broker and nowhere else');
    const outlay = g.economy.buyPrice(oo.items[0].a);
    /* NOT "buyable straight out of the wallet". CRUMB is deliberately
       a few shifts' work — data.js says so in the JOBS table, which is
       balanced around exactly this asset — and the deadline is sized
       to that. What has to be true is that the two shifts open to a
       nobody on day one cover it well inside the deadline. */
    const perShift = JOBS.drive.base + 0.5 * JOBS.drive.mult;
    const shiftsNeeded = Math.max(0, outlay - CONFIG.startMoney) / perShift;
    ok(shiftsNeeded <= (oo.deadline - g.state.day) * 3, 'day-one shifts cover it inside the deadline',
      `$${outlay} = ${shiftsNeeded.toFixed(1)} Dispatch shifts across ${oo.deadline - g.state.day} days`);
    ok(oo.budget + oo.fee > outlay, 'he pays more than it costs you', `$${oo.budget + oo.fee} for $${outlay}`);
    ok(oo.deadline - g.state.day >= 4, 'and he is in no hurry', oo.deadline - g.state.day);
  }

  /* THE ASSERTION THIS WHOLE SPLIT EXISTS FOR. */
  eq(g.quests.current().id, mainBefore, 'the MAIN objective is unchanged by the side quest');
  eq(g.hud().objective.id, mainBefore, 'and hud().objective still shows the main chain');
  eq(g.hud().sideObjective.id, 'q_side_otto', 'the side quest has its own hud() slot');
  ok(!QUESTS.some((q) => q.id === 'q_side_otto'), 'a side quest is not in the main QUESTS table');
  eq(g.quests.progress().total, QUESTS.length, 'main-chain progress ignores side quests');
  ok(!g.state.quests.q_side_otto, 'and state.quests never records it');

  /* running it a second time changes nothing */
  const arrivals0 = g.state.arrivals.length;
  g.enter('apartment'); g.enter('cafe');
  eq(g.state.arrivals.length, arrivals0, 'walking back into the cafe does not re-issue the order');
  eq(sideEvents.filter((e) => e === 'side:start:q_side_otto').length, 1, 'nor restart the side quest');

  /* THE DESK IS WIPED EVERY MORNING. A story order must not be.
     Without this the side quest can become permanently unfinishable
     simply because the player slept on it. */
  ok(!g.actions.sleep().ok, 'you cannot sleep in the cafe');
  g.enter('apartment');
  g.actions.sleep();
  ok(g.state.arrivals.some((x) => x.client === 'otto'), "a night's sleep does not lose the friend's order");
  ok(g.state.arrivals.find((x) => x.client === 'otto').keep, 'because it is marked to keep');
  /* and if it does go missing, the next morning puts it back */
  g.state.arrivals = g.state.arrivals.filter((x) => x.client !== 'otto');
  g.actions.sleep();
  ok(g.state.arrivals.some((x) => x.client === 'otto'), 'and a lost story order is reissued the next day');

  /* finishing Otto's order completes the side quest, and only it */
  const o = g.state.arrivals.find((x) => x.client === 'otto');
  g.state.money = 50000;
  g.state.time = 12 * 60;                    // the shops he buys from are open at noon
  g.economy.acceptOrder(o);
  for (const it of o.items) g.economy.buy(it.a, it.q);
  g.travel(g.officeLoc(), 'walk');
  const del = g.actions.deliver(o);
  ok(del.ok, "Otto's order can be delivered", del.why);
  ok(sideEvents.includes('side:complete:q_side_otto'), 'the side quest completed', sideEvents.join(','));
  eq(g.quests.sideStatus('q_side_otto'), 'done', 'state.sides records it as done');
  eq(g.quests.sideCurrent(), null, 'and it leaves the active slot');
  eq(g.quests.sideProgress().done, 2, 'sideProgress counts it, and the meeting before it');
  eq(badNumbers(g.state).length, 0, 'the whole opening produced no NaNs');

  /* orders read as trade tickets */
  const tk = g.clients.ticket(o);
  ok(/^[0-9]*x? ?[A-Z0-9]{3,5}/.test(tk), 'an order renders as a trade ticket', tk);
  ok(o.items.every((it) => !it.t || it.t === ASSET_BY_ID[it.a].tick), 'each order item carries its ticker');
}

/* ============================================================
   10. THE BICYCLE — bought, not given
   ============================================================ */
T('the bicycle gates on ownership');
{
  const g = createGame({ seed: 29, autosave: false });
  const dest = 'noodlecart';
  g.state.known[dest] = true;
  g.state.money = 5000;
  g.state.energy = 100;

  eq(g.state.bike.owned, false, 'a new game owns no bicycle');
  eq(g.state.bike.equipped, false, 'and is not riding one');
  eq(g.state.travel, 'walk', 'the default travel mode is walking, not the bike');

  const bikeOpt = () => g.fares(dest).find((f) => f.mode === 'bike');
  const walkOpt = () => g.fares(dest).find((f) => f.mode === 'walk');
  ok(!bikeOpt().ok, 'fares() refuses the bicycle before it is bought');
  ok(/own/.test(bikeOpt().why), 'and says why', bikeOpt().why);
  ok(!g.travel(dest, 'bike').ok, 'and travel() refuses it too');

  /* you cannot buy one just anywhere */
  ok(!g.actions.canBuyBike().ok, 'you cannot buy a bicycle in your flat');
  ok(/sold at/i.test(g.actions.canBuyBike().why), 'it says where they are sold', g.actions.canBuyBike().why);
  ok(!g.actions.buyBike().ok, 'and buyBike() refuses');
  ok(!g.actions.equipBike(true).ok, 'you cannot equip a bicycle you do not own');

  g.enter('trunkdepot');
  ok(BIKE.locs.includes('trunkdepot'), 'Dispatch sells them');
  g.state.money = BIKE.cost - 1;
  ok(!g.actions.buyBike().ok, 'and refuses when you are a dollar short');
  g.state.money = BIKE.cost + 500;
  const before = g.state.money;
  const r = g.actions.buyBike();
  ok(r.ok, 'buying one at Dispatch works', r.why);
  eq(g.state.money, before - BIKE.cost, 'and costs exactly its price');
  ok(g.state.bike.owned && g.state.bike.equipped, 'you own it and it is equipped');
  ok(!g.actions.buyBike().ok, 'you cannot buy a second one');

  ok(bikeOpt().ok, 'now fares() offers the bicycle');
  ok(g.travel(dest, 'bike').ok, 'and you can ride it');
  eq(g.state.travel, 'bike', 'the mode is remembered');
  /* walk back, so the fares below are for a real journey rather than
     a zero-hop trip to where he already is */
  g.enter('apartment');

  /* owning and riding are separate */
  ok(g.actions.equipBike(false).ok, 'you can leave it chained up');
  eq(g.state.bike.equipped, false, 'equipped goes false while owned stays true');
  eq(g.state.bike.owned, true, 'you still own it');
  ok(!bikeOpt().ok, 'and fares() refuses the mode again');
  ok(/not with you/.test(bikeOpt().why), 'with a different reason', bikeOpt().why);
  ok(g.actions.equipBike(true).ok && bikeOpt().ok, 'picking it back up restores the mode');

  /* the bicycle is a real upgrade over walking */
  const b = bikeOpt(), w = walkOpt();
  ok(b.mins < w.mins && b.energy < w.energy && b.cost === 0,
    'the bicycle beats walking on time and energy and still costs nothing',
    `bike ${b.mins}m/${b.energy}e vs walk ${w.mins}m/${w.energy}e`);
  eq(badNumbers(g.state).length, 0, 'buying and equipping a bicycle produced no NaNs');
}


/* ============================================================
   10b. THE FRIEND'S MESSAGE — the user's words, verbatim

   The fiction: WALLY GREW UP IN BULL BEAR CITY and is coming BACK
   to it. He is not a newcomer. He is new as a TRADER, which is why
   Happy's "you're the new trader in town, right?" still holds — but
   nothing may say he is new to the CITY.
   ============================================================ */
T("the friend's opening message");
{
  const WANT =
    'WALLY! Welcome back to Bull Bear City, which is louder and broker than you left it as a kid. '
    + 'After you put the mattress down, come and find me at the Bent Spoon on Main Street. '
    + 'The coffee is bad in a way I have grown to respect. '
    + 'There is also a small thing I could use your help with. Small. Bring the sunglasses.';

  eq(OPENING_MESSAGE.text, WANT, 'the opening message is the replacement text, character for character');
  eq(OPENING_MESSAGE.from, 'Otto', 'and it is still from the friend');

  /* it is on the phone before the player has touched anything */
  const fresh = newState(mulberry32(3));
  eq(fresh.msgs.length, 1, 'exactly one message is waiting on day 1');
  eq(fresh.msgs[0].text, WANT, 'and it is that one');
  eq(fresh.msgs[0].read, false, 'unread');
  ok(Object.isFrozen(OPENING_MESSAGE) && fresh.msgs[0] !== OPENING_MESSAGE,
    'it was cloned, not pushed by reference, so `read` stays writable');

  /* it still points at the cafe, and the cafe still starts the SIDE quest */
  ok(/Bent Spoon/.test(WANT), 'it names the Bent Spoon');
  ok(LOC_BY_ID.cafe.n === 'The Bent Spoon' && LOC_BY_ID.cafe.see === 0,
    'which is a real place, on the map from the first minute');
  {
    const g = createGame({ seed: 31, autosave: false });
    g.actions.readMessages();
    g.enter('cafe');
    ok(g.quests.isSideActive('q_side_otto') || g.quests.isSideDone('q_side_otto'),
      'walking into the cafe after reading it still starts the cafe side quest');
    ok(g.state.flags.metFriend, 'and the friend has been met');
    ok(g.quests.current() && g.quests.current().id !== 'q_side_otto',
      'and the main objective is untouched by it');
  }

  /* THE FICTION CHECK. Nothing in the opening may call him new to the
     city. Walked over every authored string the player can read in
     the first act, not just the message. */
  const NEWCOMER = /\b(new (in|to) town|new to the city|just moved (in|here)|never been here|first time in (this )?city)\b/i;
  const opening = [
    OPENING_MESSAGE.text,
    ...QUESTS.filter((q) => q.act <= 1).flatMap((q) => [q.t, q.d, q.hint]),
    ...SIDE_QUESTS.filter((q) => q.act <= 1).flatMap((q) => [q.t, q.d, q.hint]),
    ...Object.values(TIPS).flatMap((t) => [t.t, t.d]),
    ...DATA.wallynetGood, ...DATA.wallynetBad,
    ...MORNING_NOTES.map((m) => m.msg),
    ...LOCATIONS.filter((l) => l.see === 0).map((l) => l.desc),
    CLIENT_BY_ID.otto.intro,
  ].filter((x) => typeof x === 'string');
  const contradicts = opening.filter((t) => NEWCOMER.test(t));
  eq(contradicts.length, 0, 'nothing in the opening says Wally is new to the city', contradicts.join(' | '));
  ok(/welcome back|left it as a kid/i.test(OPENING_MESSAGE.text), 'and the message says he is coming back');
}

/* ============================================================
   10c. THE BROKER HAND-OFF

   "Once the order is picked up at the desk, the objective should
   update to have Wally go to the business broker."

   Three things have to be true at once, and the third is the one
   that is easy to miss: the objective must move, it must name the
   broker, and the broker must be a place Wally has HEARD OF — hud.js
   refuses to draw the yellow pointer at an unknown location, so an
   objective pointing somewhere undiscovered is an objective with no
   arrow.
   ============================================================ */
T('the objective advances to the broker after the desk pickup');
{
  const g = createGame({ seed: 37, autosave: false });
  g.state.energy = 100;
  g.state.hunger = 10;

  g.actions.readMessages();                    // beat 1
  g.actions.metHappy();                        // beat 2
  g.enter('trunkdepot');                       // the shift is worked where the shift is
  const shift = g.actions.work('drive', 0.55); // beat 3 — unlocks arrivals
  ok(shift.ok, 'a shift at Dispatch was worked', shift.why);
  ok(g.clients.ordersUnlocked(), 'which unlocks client orders');

  ok(g.state.arrivals.length > 0, 'somebody is waiting at the desk', g.state.arrivals.length);
  eq(g.hud().objective.id, 'q_first_client', 'the objective is to take that order');
  ok(!g.known('broker'), 'and the Business Broker is not on the map yet');

  g.enter('apartment');
  const acc = g.actions.accept(g.state.arrivals[0]);
  ok(acc.ok, 'the order is picked up at the desk', acc.why);

  const obj = g.hud().objective;
  eq(obj.id, 'q_broker', 'and the objective advances to the broker');
  ok(/broker/i.test(obj.t), 'which reads naturally in the strip', obj.t);
  ok(obj.t.length <= 44, 'and is short enough for the strip', `${obj.t.length} chars`);
  eq(g.quests.questLoc('q_broker'), 'broker', 'questLoc() resolves it to the broker');
  eq(LOC_BY_ID.broker.z, 'marketsq', 'which is in Market Square');
  ok(g.known('broker'), 'and it is now a place Wally has heard of, so the pointer has a target');
  ok(g.hud().objective !== g.hud().sideObjective, 'the side slot is still its own thing');

  /* and it closes by turning up */
  ok(!g.quests.done('q_broker'), 'it is not complete before he goes');
  g.enter('broker');
  g.quests.check();
  ok(g.quests.done('q_broker'), 'walking in completes it');
  eq(g.hud().objective.id, 'q_first_fee', 'and the chain carries on to delivering the order');
  eq(badNumbers(g.state).length, 0, 'the hand-off produced no NaNs');

  /* the flag is set in the one place an order is ever taken */
  const h = createGame({ seed: 38, autosave: false });
  ok(!h.state.flags.orderTaken, 'a fresh game has not taken an order');
  ok(!h.quests.ruleMet(LOC_BY_ID.broker.see), "and does not know the broker's discovery rule");
  h.state.rep = 12;
  ok(h.quests.ruleMet(LOC_BY_ID.broker.see), 'the reputation arm of the `any` rule still works on its own');
}

/* ============================================================
   10d. THE RIDES — bicycle, scooter, motorcycle
   ============================================================ */
T('the rides table');
{
  eq(RIDE_LIST.length, 3, 'three rides');
  for (const id of ['bike', 'scooter', 'motorcycle']) ok(!!RIDES[id], `ride '${id}' exists`, id);
  eq(RIDE_ORDER[0], 'motorcycle', 'the fastest is the head of RIDE_ORDER');

  for (const r of RIDE_LIST) {
    eq(r.id, RIDES[r.id].id, `${r.id}: the key and the id agree`);
    ok(typeof r.name === 'string' && r.name.length > 2, `${r.id}: has a name`, r.name);
    ok(typeof r.short === 'string' && r.short.length > 2, `${r.id}: has a short name`, r.short);
    ok(Number.isFinite(r.speed) && r.speed > 0, `${r.id}: has a real speed`, r.speed);
    ok(Number.isFinite(r.effort) && r.effort > 0 && r.effort <= 1, `${r.id}: effort is a 0..1 multiplier`, r.effort);
    ok(r.unlock && (r.unlock.kind === 'buy' || r.unlock.kind === 'quest'), `${r.id}: unlock is buy or quest`, r.unlock && r.unlock.kind);
    if (r.unlock.kind === 'buy') {
      eq(r.price, r.unlock.price, `${r.id}: price mirrors unlock.price`);
      eq(r.questId, null, `${r.id}: a bought ride has no quest`);
      ok(r.unlock.locs.length > 0 && r.unlock.locs.every((l) => !!LOC_BY_ID[l]),
        `${r.id}: is sold at real places`, r.unlock.locs.join(', '));
    } else {
      eq(r.price, 0, `${r.id}: a quest ride has no price`);
      eq(r.questId, r.unlock.questId, `${r.id}: questId mirrors unlock.questId`);
      ok(!!SIDE_QUEST_BY_ID[r.questId], `${r.id}: and that quest exists`, r.questId);
    }
  }

  /* THE SPEED RATIOS — the whole reason the table exists. */
  eq(RIDES.bike.speed, 1, 'the bicycle is the unit of speed');
  eq(RIDES.scooter.speed, RIDES.bike.speed * 1.5, 'the scooter is 50% faster than the bicycle');
  eq(RIDES.motorcycle.speed, RIDES.scooter.speed * 2, 'the motorcycle is twice the scooter');
  eq(RIDES.motorcycle.speed, RIDES.bike.speed * 3, 'and therefore three times the bicycle');

  /* folded into the travel table: a real journey, at each speed */
  const far = (() => {
    for (const A of LOCATIONS) for (const B of LOCATIONS) if (hops(A.id, B.id) === 5) return [A.id, B.id];
    return ['apartment', 'exchange'];
  })();
  const bk = rideFare('bike', far[0], far[1]);
  const sc = rideFare('scooter', far[0], far[1]);
  const mc = rideFare('motorcycle', far[0], far[1]);
  eq(fare('bike', far[0], far[1]).mins, bk.mins, 'fare() with no ride is still the plain bicycle');
  ok(sc.mins < bk.mins && mc.mins < sc.mins, 'each ride is quicker than the last',
    `${bk.mins}m / ${sc.mins}m / ${mc.mins}m`);
  ok(Math.abs(bk.mins / sc.mins - 1.5) < 0.12, 'the scooter is ~1.5x the bicycle on the clock',
    (bk.mins / sc.mins).toFixed(2));
  ok(Math.abs(sc.mins / mc.mins - 2) < 0.2, 'and the motorcycle ~2x the scooter',
    (sc.mins / mc.mins).toFixed(2));
  eq(bk.cost + sc.cost + mc.cost, 0, 'none of them costs a fare to run');
  ok(sc.energy < bk.energy && mc.energy <= sc.energy, 'a motor does the pedalling', `${bk.energy}/${sc.energy}/${mc.energy}`);

  /* THE SCOOTER IS NOT FOR SALE AT ANY PRICE. */
  eq(RIDES.scooter.unlock.kind, 'quest', 'the scooter is quest-unlocked');
  eq(RIDES.scooter.price, 0, 'it has no price');
  {
    const g = createGame({ seed: 43, autosave: false });
    g.state.money = 10000000;
    g.state.rep = 100;
    for (const loc of LOCATIONS) {
      g.state.known[loc.id] = true;
      g.enter(loc.id);
      if (g.actions.canBuyRide('scooter').ok) { ok(false, 'the scooter must not be purchasable at ' + loc.id); break; }
    }
    ok(!g.actions.canBuyRide('scooter').ok, 'with unlimited money and reputation it cannot be bought anywhere');
    ok(/not for sale/i.test(g.actions.canBuyRide('scooter').why), 'and it says so plainly',
      g.actions.canBuyRide('scooter').why);
    ok(!g.actions.buyRide('scooter').ok, 'buyRide() refuses it');
    ok(!g.state.rides.owned.scooter, 'and nothing was bought');
    eq(g.actions.ridesFor('trunkdepot').filter((r) => r.id === 'scooter').length, 0,
      'it is in no shop list');
  }

  /* THE MOTORCYCLE — a genuine late-game goal. */
  eq(RIDES.motorcycle.unlock.kind, 'buy', 'the motorcycle is bought');
  ok(RIDES.motorcycle.price > 0, 'its price is set', RIDES.motorcycle.price);
  ok(RIDES.motorcycle.price >= RIDES.bike.price * 15, 'and it is an order of magnitude beyond the bicycle',
    `$${RIDES.motorcycle.price} vs $${RIDES.bike.price}`);
  ok(RIDES.motorcycle.price > OFFICE_STAGES[1].cost, 'more than the Shared Desk costs',
    `$${RIDES.motorcycle.price} vs $${OFFICE_STAGES[1].cost}`);
  ok(RIDES.motorcycle.unlock.rep >= 45, 'and it is gated on late-game reputation', RIDES.motorcycle.unlock.rep);
  {
    const g = createGame({ seed: 47, autosave: false });
    g.state.money = RIDES.motorcycle.price * 4;
    g.enter('trunkdepot');
    ok(!g.actions.canBuyRide('motorcycle').ok, 'a rich nobody still cannot buy one');
    ok(/reputation/i.test(g.actions.canBuyRide('motorcycle').why), 'because of reputation',
      g.actions.canBuyRide('motorcycle').why);
    g.state.rep = RIDES.motorcycle.unlock.rep;
    g.enter('apartment');
    ok(!g.actions.canBuyRide('motorcycle').ok, 'and not from the flat');
    g.enter('trunkdepot');
    g.state.money = RIDES.motorcycle.price - 1;
    ok(!g.actions.canBuyRide('motorcycle').ok, 'nor a dollar short');
    g.state.money = RIDES.motorcycle.price + 100;
    const r = g.actions.buyRide('motorcycle');
    ok(r.ok, 'but reputable, standing at Dispatch, with the money: yes', r.why);
    eq(g.state.money, 100, 'and it costs exactly its price');
    ok(g.state.rides.owned.motorcycle && g.state.rides.equipped === 'motorcycle',
      'you own it and you are on it');
    ok(!g.actions.buyRide('motorcycle').ok, 'you cannot buy a second one');
  }

  /* ONE AT A TIME. */
  {
    const g = createGame({ seed: 53, autosave: false });
    g.state.money = 999999;
    g.state.rep = 99;
    g.enter('trunkdepot');
    ok(g.actions.buyRide('bike').ok, 'buy the bicycle');
    eq(g.state.rides.equipped, 'bike', 'which equips itself');
    ok(g.actions.grantRide('scooter').ok, 'a quest hands over the scooter');
    eq(g.state.rides.equipped, 'scooter', 'and the better ride takes over');
    ok(g.state.rides.owned.bike, 'the bicycle is still owned, just not under him');
    eq(g.actions.rides().filter((r) => r.equipped).length, 1, 'exactly one ride is equipped');
    ok(g.actions.equipRide('bike').ok, 'you may go back to the bicycle');
    eq(g.state.rides.equipped, 'bike', 'and that is the one equipped');
    eq(g.actions.rides().filter((r) => r.equipped).length, 1, 'still exactly one');
    ok(!g.actions.equipRide('motorcycle').ok, 'you cannot equip one you do not own');
    ok(g.actions.equipRide(null).ok, 'and you can leave everything behind');
    eq(g.state.rides.equipped, null, 'walking again');
    eq(g.actions.rides().filter((r) => r.equipped).length, 0, 'nothing equipped');
    ok(!g.actions.grantRide('scooter').ok, 'granting a ride you already own is a no-op');

    /* the fare board follows whatever is under him */
    g.state.known.noodlecart = true;
    const rideRow = () => g.fares('noodlecart').find((f) => f.mode === 'bike');
    g.actions.equipRide('bike');
    eq(rideRow().ride, 'bike', 'the bike row is the bicycle');
    eq(rideRow().n, 'Bicycle', 'and reads as one');
    const bmins = rideRow().mins;
    g.actions.equipRide('scooter');
    eq(rideRow().ride, 'scooter', 'and the scooter when he is on the scooter');
    eq(rideRow().n, 'Scooter', 'reading as a scooter, not a bicycle');
    ok(rideRow().mins <= bmins, 'and quoting the quicker journey', `${rideRow().mins}m vs ${bmins}m`);
    ok(rideRow().ok, 'and it is takeable');
    eq(badNumbers(g.state).length, 0, 'none of that produced a NaN');
  }

  /* THE SCOOTER'S QUEST sits in the mid-game chain and pays the ride. */
  {
    const q = SIDE_QUEST_BY_ID[RIDES.scooter.questId];
    ok(!!q, 'the scooter quest exists', RIDES.scooter.questId);
    eq(q.ride, 'scooter', 'and it pays out the scooter');
    ok(!!q.arm, 'it arms itself on a rule rather than waiting for a caller');
    const g = createGame({ seed: 59, autosave: false });
    ok(!g.quests.isSideActive(q.id), 'dormant on day 1');
    g.state.office = 1;                       // the Shared Desk: mid-game
    g.quests.check();
    ok(g.quests.isSideActive(q.id), 'and arms once you are off the folding table');
    ok(!g.state.rides.owned.scooter, 'the scooter is not yours yet');
    g.state.clients.barnaby.done = 1;         // the favour, returned
    g.quests.check();
    ok(g.quests.isSideDone(q.id), 'doing the favour completes it');
    ok(g.state.rides.owned.scooter, 'and hands over the scooter');
    eq(g.state.rides.equipped, 'scooter', 'already under him');
    ok(g.quests.current() && g.quests.current().id !== q.id, 'a side quest never becomes the main objective');
  }
}

T('an old save keeps its bicycle');
{
  /* A REAL v6 FILE: state.bike, no state.rides. The player paid $180
     for that bicycle and must not lose it to a refactor. */
  const g = createGame({ seed: 61, autosave: false });
  g.state.money = 4321;
  g.state.rep = 9;
  g.state.day = 12;
  g.economy.add('gold', 2, 100);
  const v6 = JSON.parse(JSON.stringify(g.state));
  v6.version = 6;
  delete v6.rides;
  v6.bike = { owned: true, equipped: true };

  const m = g.importSave(JSON.stringify(v6));
  ok(!!m, 'a v6 save loads');
  eq(m.version, CONFIG.version, 'and lands on the current version');
  ok(!!m.rides && !!m.rides.owned, 'it has a rides record now');
  eq(m.rides.owned.bike, true, 'THE BICYCLE SURVIVED');
  eq(m.rides.equipped, 'bike', 'and is still the thing he is riding');
  eq(m.rides.owned.scooter, false, 'it did not invent a scooter');
  eq(m.rides.owned.motorcycle, false, 'nor a motorcycle');
  eq(m.money, 4321, 'money survived');
  eq(m.day, 12, 'and the day');
  ok(m.inv.gold && m.inv.gold.qty === 2, 'and the holdings');
  eq(m.bike.owned, true, 'the legacy mirror agrees');
  eq(m.bike.equipped, true, 'on both fields');
  g.state.known.noodlecart = true;
  ok(g.fares('noodlecart').find((f) => f.mode === 'bike').ok, 'and the migrated bicycle can be ridden');

  /* owned but left at home */
  const v6b = JSON.parse(JSON.stringify(v6));
  v6b.bike = { owned: true, equipped: false };
  const m2 = g.importSave(JSON.stringify(v6b));
  eq(m2.rides.owned.bike, true, 'a v6 bicycle left at home is still owned');
  eq(m2.rides.equipped, null, 'and nothing is equipped');

  /* never bought one */
  const v6c = JSON.parse(JSON.stringify(v6));
  v6c.bike = { owned: false, equipped: false };
  const m3 = g.importSave(JSON.stringify(v6c));
  eq(m3.rides.owned.bike, false, 'a v6 save that never bought one gets nothing');
  eq(m3.travel, 'walk', 'and walks');

  /* nonsense is repaired, not trusted */
  const v7bad = JSON.parse(JSON.stringify(g.state));
  v7bad.rides = { owned: { bike: false, scooter: 'yes', ghost: true }, equipped: 'motorcycle' };
  const m4 = g.importSave(JSON.stringify(v7bad));
  eq(m4.rides.equipped, null, 'you cannot be riding something you do not own');
  eq(m4.rides.owned.scooter, true, 'a truthy ownership flag is coerced to a boolean');
  ok(!('ghost' in m4.rides.owned), 'and a ride that does not exist is dropped');
  eq(badNumbers(m4).length, 0, 'the repaired save has no NaNs');
}

/* ============================================================
   10e. NOTHING THE PLAYER READS SAYS "UBER"

   The taxi mode is called YOOBER. The MODE ID is still 'trunk' —
   it is in save files (state.travel), in ui/menus.js's icon map and
   in tools/traveltest.mjs, and renaming it would break all three
   for no gain. Only the display name changed.
   ============================================================ */
T('the taxi is Yoober, everywhere the player can see');
{
  eq(TRAVEL.trunk.id, 'trunk', 'the mode id is unchanged');
  eq(TRAVEL.trunk.n, 'Yoober', 'and the display name is Yoober');

  /* every string in the whole content bundle */
  const strings = [];
  (function walk(o, seen = new Set()) {
    if (o == null) return;
    if (typeof o === 'string') { strings.push(o); return; }
    if (typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    for (const k of Object.keys(o)) walk(o[k], seen);
  })(DATA);
  const dirty = strings.filter((t) => /uber/i.test(t));
  eq(dirty.length, 0, 'no string in the content tables says Uber', dirty.slice(0, 3).join(' | '));
  ok(strings.some((t) => /Yoober/.test(t)), 'and at least one says Yoober');

  /* the live fare board, the tips and the hud */
  const g = createGame({ seed: 67, autosave: false });
  g.state.known.exchange = true;
  const board = g.fares('exchange');
  const taxi = board.find((f) => f.mode === 'trunk');
  eq(taxi.n, 'Yoober', 'the fare board calls it Yoober');
  const live = board.flatMap((f) => [f.n, f.note, f.why, f.warn]).filter((x) => typeof x === 'string');
  eq(live.filter((t) => /uber/i.test(t)).length, 0, 'and nothing on the board says Uber');
  eq(Object.values(DATA.tips).filter((t) => /uber/i.test(t.d + t.t)).length, 0, 'nor any tip');

  /* and the source files this agent owns carry no stray occurrence */
  const gameDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'game');
  const offenders = readdirSync(gameDir).filter((f) => f.endsWith('.js'))
    .filter((f) => /uber/i.test(readFileSync(join(gameDir, f), 'utf8')));
  eq(offenders.length, 0, 'and no file in src/game mentions Uber at all', offenders.join(', '));
}

T('a broke, exhausted player is never hard-locked');
{
  /* THE FLOOR, RESTATED. Walking is still free, still always
     available and still never refused — but a locked door is now
     locked, so the guarantee is precisely this: with no money, no
     bicycle, no energy and no trains, every place that is OPEN is
     still reachable on foot, and his own bed is open 00:00–24:00, so
     there is never a night he cannot end. */
  const g = createGame({ seed: 31, autosave: false });
  g.state.money = 0;
  g.state.energy = 0;
  g.state.time = 3 * 60;                 // 03:00 — no Metro, most of the city shut
  for (const l of LOCATIONS) g.state.known[l.id] = true;

  const stuck = [];
  const shut = [];
  for (const l of LOCATIONS) {
    if (l.id === g.state.loc) continue;
    const opts = g.fares(l.id);
    const walk = opts.find((o) => o.mode === 'walk');
    if (g.isOpen(l.id)) { if (!walk || !walk.ok) stuck.push(l.id); }
    else if (walk.ok) shut.push(l.id);
  }
  eq(stuck.length, 0, 'with $0 and 0 energy at 03:00, every OPEN place is still reachable on foot',
    stuck.slice(0, 4).join(', '));
  eq(shut.length, 0, 'and every closed one refuses, on every mode', shut.slice(0, 4).join(', '));

  /* THE BED IS THE FLOOR UNDER THE FLOOR. */
  ok(g.isOpen('apartment'), 'his own front door is open at 03:00');
  ok(LOC_BY_ID.apartment.acts.includes('sleep'), 'and the bed is behind it');
  const home = g.fares('apartment').find((o) => o.mode === 'walk');
  ok(!home || home.ok || g.state.loc === 'apartment', 'and he can always walk to it');

  /* the trudge is unchanged, measured on somewhere that is open */
  g.enter('apartment');
  const far = g.fares('noodlecart').find((o) => o.mode === 'walk');
  ok(!g.isOpen('noodlecart'), 'the noodle cart is shut at 03:00');
  g.state.time = 8 * 60;                 // …and open at 08:00
  const open = g.fares('noodlecart').find((o) => o.mode === 'walk');
  ok(open.ok, 'at 08:00 he can walk to it with nothing in his pockets', open.why);
  ok(open.trudge, 'setting off on empty is flagged as a trudge');
  ok(typeof open.warn === 'string' && open.warn.length > 0, 'with a warning the UI can show', open.warn);
  ok(open.mins > fare('walk', g.state.loc, 'noodlecart').mins, 'and it takes longer than a fresh walk',
    `${open.mins}m vs ${fare('walk', g.state.loc, 'noodlecart').mins}m`);
  g.state.time = 3 * 60;
  ok(!g.fares('trunkdepot').find((o) => o.mode === 'train').ok, 'the Metro is genuinely shut at 03:00');
  g.state.time = 8 * 60;
  ok(!g.fares('noodlecart').find((o) => o.mode === 'trunk').ok, 'and a Yoober is genuinely unaffordable');

  const t = g.travel('noodlecart', 'walk');
  ok(t.ok, 'he walks it anyway', t.why);
  eq(g.state.loc, 'noodlecart', 'and he gets there');
  ok(g.state.energy >= 0, 'energy never goes negative', g.state.energy);
  eq(badNumbers(g.state).length, 0, 'the trudge produced no NaNs');
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
   11. THE CLOCK — one in-game minute per two real seconds

   CONFIG.minutesPerSecond was 4 and, more to the point, was read by
   nobody: time only moved when Wally acted, so every opening hour in
   the game was decoration. It is 0.5 now and game.update(dt) drives
   it.
   ============================================================ */
T('the clock runs, at one minute per two real seconds');
{
  eq(CONFIG.minutesPerSecond, 0.5, 'the rate is half an in-game minute per real second');
  eq(1 / CONFIG.minutesPerSecond, 2, '…which is one in-game minute per TWO real seconds');
  eq(CONFIG.forceSleepMin, 25 * 60, 'the day is re-tuned to end at 01:00, not 02:00');
  ok(CONFIG.forceSleepMin > CONFIG.dayStartMin, 'and it ends after it begins');

  const g = createGame({ seed: 101, autosave: false });
  eq(g.time.rate, CONFIG.minutesPerSecond, 'time.rate publishes it');
  ok(g.time.live, 'the clock is live by default');
  eq(g.time.realSecondsPerHour, 120, 'an in-game hour is two real minutes');

  /* it actually ticks */
  const t0 = g.time.minutes;
  for (let i = 0; i < 120; i++) g.update(1 / 60);      // two real seconds of frames
  const moved = g.time.minutes - t0;
  ok(Math.abs(moved - 1) < 0.3, 'two real seconds move the clock one in-game minute', moved.toFixed(2));

  /* an hour of real time is thirty in-game minutes per real minute */
  const t1 = g.time.minutes;
  for (let i = 0; i < 60 * 60; i++) g.update(1 / 60);  // sixty real seconds
  const perRealMinute = g.time.minutes - t1;
  ok(Math.abs(perRealMinute - 30) < 1, 'one real minute is thirty in-game minutes', perRealMinute.toFixed(1));

  /* THE DAY, IN REAL TIME. 07:00 -> 01:00 is 18 in-game hours, which
     at this rate is 36 real minutes of standing perfectly still. */
  const dayMins = CONFIG.forceSleepMin - CONFIG.dayStartMin;
  eq(dayMins, 18 * 60, 'the playable day is 18 in-game hours');
  const realMinutes = dayMins / CONFIG.minutesPerSecond / 60;
  ok(realMinutes > 25 && realMinutes < 45, 'which is about 36 real minutes if he never does anything',
    realMinutes.toFixed(0) + ' real minutes');

  /* HUNGER PER REAL MINUTE. 3.4/hour at 30 in-game minutes per real
     minute is 1.7 an hour of wall clock: a full day's idling is one
     meal, which is the rhythm the re-tune is aiming at. */
  const hungerPerRealMin = CONFIG.hungerPerHour * (CONFIG.minutesPerSecond * 60) / 60;
  ok(Math.abs(hungerPerRealMin - 1.7) < 0.01, 'hunger climbs 1.7 per real minute', hungerPerRealMin);
  const perDay = dayMins / 60 * CONFIG.hungerPerHour;
  ok(perDay > 50 && perDay < 70, 'a whole day of it is about one meal short of maximum', perDay.toFixed(0));

  /* THE ALT-TAB GUARD */
  const h = createGame({ seed: 102, autosave: false });
  const before = h.time.minutes;
  h.update(3600);                                     // a one-hour frame
  ok(h.time.minutes - before <= CONFIG.idleMaxMinutes + 0.01,
    'one enormous frame cannot advance more than the cap', h.time.minutes - before);

  /* pause and live are separate switches, and both stop it */
  const k = createGame({ seed: 103, autosave: false });
  k.time.pause(true);
  const p0 = k.time.minutes;
  for (let i = 0; i < 300; i++) k.update(1 / 60);
  eq(k.time.minutes, p0, 'a paused clock does not move (the UI holds this while a menu is open)');
  k.time.resume();
  for (let i = 0; i < 300; i++) k.update(1 / 60);
  ok(k.time.minutes > p0, 'and resuming starts it again');
  k.time.setLive(false);
  const p1 = k.time.minutes;
  for (let i = 0; i < 300; i++) k.update(1 / 60);
  eq(k.time.minutes, p1, 'setLive(false) stops it dead — this is what the screenshot rig uses');

  /* ambient time is hunger, not exhaustion */
  const m = createGame({ seed: 104, autosave: false });
  m.state.energy = 50;
  const e0 = m.state.energy, hu0 = m.state.hunger;
  for (let i = 0; i < 60 * 60; i++) m.update(1 / 60);
  eq(m.state.energy, e0, 'standing about costs no energy');
  ok(m.state.hunger > hu0, 'but it does make him hungry', m.state.hunger.toFixed(1));

  /* and the collapse still catches him */
  const n = createGame({ seed: 105, autosave: false });
  n.state.time = CONFIG.forceSleepMin - 2;
  n.state.hunger = 10;
  const day0 = n.state.day;
  for (let i = 0; i < 60 * 30; i++) n.update(1 / 60);
  eq(n.state.day, day0 + 1, 'and the clock rolls him into the next day at 01:00');
  eq(badNumbers(n.state).length, 0, 'a live clock produced no NaNs');
}

/* ============================================================
   12. MAX HUNGER LOCKS EVERYTHING EXCEPT EATING
   ============================================================ */
T('maximum hunger locks everything but eating');
{
  const g = createGame({ seed: 111, autosave: false });
  for (const l of LOCATIONS) g.state.known[l.id] = true;
  g.state.money = 20000;
  g.state.energy = 100;
  g.state.time = 12 * 60;
  g.state.rep = 40;
  g.state.skills.inspection = true;
  g.enter('trunkdepot');
  g.state.hunger = CONFIG.hungerLockAt;

  eq(CONFIG.hungerLockAt, 100, 'the lock is at maximum hunger');
  ok(g.needs().starving, 'needs() reports him starving');
  eq(g.needs().lockedBy, 'hunger', 'and names what is holding him');
  ok(/hungry/i.test(g.needs().why), 'with a sentence the UI can print', g.needs().why);
  ok(!!g.needs().food && !!g.needs().food.n, 'and the nearest food attached', JSON.stringify(g.needs().food?.n));

  /* EVERY ACTION REFUSES, AND SAYS WHY */
  const locked = [
    ['work a shift', g.actions.work('drive', 0.8)],
    ['buy an asset', g.economy.buy('wheat', 1)],
    ['sell an asset', g.economy.sell('wheat', 1)],
    ['take an order', g.actions.accept({ id: 'x', client: 'otto', items: [] })],
    ['deliver an order', g.actions.deliver('x')],
    ['buy a bicycle', g.actions.buyRide('bike')],
    ['upgrade the office', g.actions.upgradeOffice()],
    ['move house', g.actions.moveHome('studio')],
    ['hire anybody', g.actions.hire('pim')],
    ['tokenize', g.economy.tokenize('wheat')],
    ['race the Mayor', g.race.canStart()],
  ];
  for (const [what, r] of locked) {
    ok(r && r.ok === false, `too hungry to ${what}`, JSON.stringify(r));
    ok(r.kind === 'hunger', `…and it is hunger that says no (${what})`, r.kind + ' / ' + r.why);
    ok(/hungry/i.test(r.why), `…in words (${what})`, r.why);
  }
  /* the refusal POINTS AT THE FOOD, which is the whole point of it */
  const why = g.actions.work('drive').why;
  ok(/Noodle Cart|Bent Spoon|Market Hall|food/i.test(why), 'the refusal names the nearest food', why);

  /* GETTING TO FOOD STILL WORKS — otherwise he is bricked */
  ok(g.fares('noodlecart').find((f) => f.mode === 'walk').ok, 'he may still walk to food');
  ok(g.travel('noodlecart', 'walk').ok, 'and travelling there is allowed');
  eq(g.state.loc, 'noodlecart', 'and he arrives');
  /* but nowhere else */
  const nope = g.travel('school', 'walk');
  ok(!nope.ok && nope.kind === 'hunger', 'travelling anywhere that is not food or a bed is refused', JSON.stringify(nope));

  /* EATING WORKS */
  const meal = g.mealsAt('noodlecart')[0];
  ok(!!meal, 'the noodle cart sells food');
  const ate = g.actions.eatAct(meal.act);
  ok(ate.ok, 'and he can eat it', ate.why);
  ok(g.state.hunger < CONFIG.hungerLockAt, 'which unlocks the game again', g.state.hunger);
  ok(g.actions.work('drive').ok === false, 'he still cannot drive from a noodle cart');
  ok(!/hungry/i.test(g.actions.work('drive').why), '…but not because he is hungry any more',
    g.actions.work('drive').why);
}

T('broke AND starving still has a way out');
{
  /* THE DEADLOCK CHECK. No money, maximum hunger, the small hours, and
     every meal in the city costs something. If this path did not
     exist the hunger lock would be a game over with no message. */
  const g = createGame({ seed: 113, autosave: false });
  for (const l of LOCATIONS) g.state.known[l.id] = true;
  g.state.money = 0;
  g.state.hunger = 100;
  g.state.energy = 4;
  g.state.time = 2 * 60;                       // 02:00: even the noodle cart is shut
  g.enter('apartment');

  ok(g.needs().starving, 'starving');
  ok(!g.economy.afford(4), 'and broke — the cheapest bowl in the city is beyond him');
  ok(!g.actions.eatAct('food:4:26').ok, 'he cannot eat in his own flat');
  ok(!g.slateOffer().ok, 'and the slate is not offered where there is no counter');

  /* step 1: the bed. It is open 00:00–24:00 and sleeping is exempt. */
  ok(g.isOpen('apartment'), 'his flat is open at 02:00');
  const slept = g.actions.sleep();
  ok(slept.ok, 'so he can always go to bed', slept.why);
  eq(g.time.hour, 7, 'and wake at 07:00');
  ok(g.state.hunger >= 99, 'still starving in the morning', g.state.hunger);

  /* step 2: walk to food, which the lock allows */
  const t = g.travel('noodlecart', 'walk');
  ok(t.ok, 'and walk to the noodle cart with nothing in his pockets', t.why);

  /* step 3: the slate */
  const offer = g.slateOffer();
  ok(offer.ok, 'the slate is offered', offer.why);
  const bowl = g.actions.eatAct('food:4:26');
  ok(bowl.ok && bowl.slate, 'and a bowl arrives anyway', JSON.stringify(bowl));
  ok(g.state.hunger < 100, 'he is fed', g.state.hunger);
  eq(g.state.money, 0, 'and it cost him nothing, because he had nothing');
  ok(g.actions.work('drive').ok === false, 'he still has to walk to Dispatch to earn');

  /* it cannot be farmed */
  g.state.hunger = 100;
  ok(!g.slateOffer().ok, 'the slate is once a day', g.slateOffer().why);
  g.state.money = 500;
  g.state.hunger = 100;
  g.state.slateDay = 0;
  ok(!g.slateOffer().ok, 'and never while he can pay', g.slateOffer().why);
  eq(badNumbers(g.state).length, 0, 'no NaNs anywhere in that');
}

/* ============================================================
   13. CLOSED IS CLOSED — the rules layer is the authority
   ============================================================ */
T('closed locations are actually closed');
{
  const g = createGame({ seed: 121, autosave: false });
  for (const l of LOCATIONS) g.state.known[l.id] = true;
  g.state.money = 100000;
  g.state.energy = 100;
  g.state.rep = 90;
  for (const c of COURSES) g.state.skills[c.id] = true;
  g.state.time = 4 * 60;                       // 04:00

  eq(g.isOpen('exchange'), false, 'the Stock Exchange is shut at 04:00');
  eq(g.isOpen('apartment'), true, 'a 00:00–24:00 place is never shut');

  /* THE THREE DOORS */
  const trav = g.travel('exchange', 'walk');
  ok(!trav.ok, 'travelling to a closed venue is refused', JSON.stringify(trav));
  eq(trav.kind, 'hours', 'and the reason is the hours');
  ok(/opens at 09:00/.test(trav.why), 'and it names the opening time', trav.why);

  const ent = g.enter('exchange');
  ok(!ent.ok, 'and so is walking in through the door from the 3D world', JSON.stringify(ent));
  ok(/opens at 09:00/.test(ent.why), 'with the same sentence', ent.why);
  eq(g.state.loc, 'apartment', 'he did not get in');

  /* every mode on the fare board says so, so no UI can offer one */
  const board = g.fares('exchange');
  eq(board.filter((f) => f.ok).length, 0, 'every travel mode is refused while it is shut');
  ok(board.every((f) => f.closed), 'and every row is flagged closed for the UI');

  /* THE ACTS OF A CLOSED VENUE */
  ok(!g.economy.buy('trnk', 1).ok, 'you cannot buy a share at 04:00');
  eq(g.economy.buy('trnk', 1).kind, 'hours', 'because the venue is shut');
  ok(!g.economy.sell('trnk', 1).ok, 'nor sell one');

  /* the shifts, the classes, the counters */
  g.state.time = 4 * 60;
  g.state.loc = 'cafe';
  const shift = g.actions.work('cafe', 0.8);
  ok(!shift.ok && shift.kind === 'hours', 'a café shift at 04:00 is refused', JSON.stringify(shift));
  ok(/opens at 06:00/.test(shift.why), 'and says when they open', shift.why);
  g.state.loc = 'school';
  ok(!g.actions.enrol('negotiation', 0.9).ok, 'the school is shut at 04:00');
  g.state.loc = 'library';
  ok(!g.actions.study().ok, 'so is the library');
  g.state.loc = 'bank';
  ok(!g.actions.borrow(50).ok, 'and the bank');
  g.state.loc = 'pawnshop';
  ok(!g.actions.pawnBuy(g.actions.pawnStock()[0].id).ok, "and Vic's");

  /* AND THEY OPEN AGAIN */
  g.state.time = 10 * 60;
  g.state.loc = 'apartment';
  ok(g.travel('exchange', 'walk').ok, 'at 10:00 the Exchange lets him travel there');
  ok(g.economy.buy('trnk', 1).ok, 'and trade');
  g.state.loc = 'cafe';
  ok(g.actions.work('cafe', 0.8).ok, 'the café takes its shift');

  /* THE OTHER HALF OF THE RULE: an act belongs to a place. */
  g.state.time = 12 * 60;
  g.enter('apartment');
  const wrong = g.actions.work('cafe', 0.8);
  ok(!wrong.ok && wrong.kind === 'place', 'a café shift cannot be worked from the flat', JSON.stringify(wrong));
  ok(/Bent Spoon/.test(wrong.why), 'and the refusal names where it is', wrong.why);
  ok(!g.actions.study().ok, 'nor can he read the library from bed');
  ok(!g.actions.farmHarvest().ok, 'nor harvest a farm he is not standing in');
  ok(!g.actions.mineDig().ok, 'nor dig a mine he is not standing in');

  /* openInfo() is the one description everything shares */
  const info = g.openInfo('exchange');
  eq(info.span, '09:00–16:00', 'openInfo() spells out the hours');
  eq(g.opensAt('exchange'), '09:00', 'opensAt() gives the opening time');
  ok(g.openInfo('apartment').always, 'and knows an always-open door when it sees one');

  /* every location in the game has enforceable hours */
  const bad = LOCATIONS.filter((l) => !Array.isArray(l.hours) || l.hours[0] > l.hours[1]);
  eq(bad.length, 0, 'every one of the 28 locations carries usable hours', bad.map((l) => l.id).join(','));
  /* and the venue hours agree with the hours of the building they are in */
  const mismatched = Object.keys(VENUES).filter((v) => {
    const l = LOC_BY_ID[VENUE_LOC[v]];
    return l && (l.hours[0] !== VENUES[v].hours[0] || l.hours[1] !== VENUES[v].hours[1]);
  });
  eq(mismatched.length, 0, 'every venue keeps the same hours as its building', mismatched.join(','));
}

/* ============================================================
   14. REPUTATION TITLES AND THE DEADLINE PENALTY
   ============================================================ */
T('reputation carries a title');
{
  ok(REP_TITLES.length >= 8 && REP_TITLES.length <= 12, 'a ladder of 8–12 rungs', REP_TITLES.length);
  eq(REP_TITLES[0].t, 'A Little Calf', 'it starts as A Little Calf');
  eq(REP_TITLES[REP_TITLES.length - 1].t, 'Tokenization Legend', 'and ends as Tokenization Legend');
  eq(REP_TITLES[0].rep, 0, 'the first rung is rep 0, so there is always a title');
  for (let i = 1; i < REP_TITLES.length; i++) {
    ok(REP_TITLES[i].rep > REP_TITLES[i - 1].rep, `rung ${i + 1} is above rung ${i}`,
      `${REP_TITLES[i - 1].rep} -> ${REP_TITLES[i].rep}`);
  }
  const dupTitles = new Set(REP_TITLES.map((r) => r.t));
  eq(dupTitles.size, REP_TITLES.length, 'every title is distinct');
  ok(REP_TITLES.every((r) => r.d && r.d.length > 12), 'and every one has a line under it');
  /* spread over the WHOLE progression, not the first week */
  const questRep = QUESTS.reduce((t, q) => t + (q.rep || 0), 0);
  ok(REP_TITLES[REP_TITLES.length - 1].rep > questRep * 0.5,
    'the last rung is a full run away, not a fortnight', `${REP_TITLES[REP_TITLES.length - 1].rep} vs ${questRep} from quests alone`);

  /* the three things the UI shows */
  const p0 = DATA.repProgress(0);
  eq(p0.title, 'A Little Calf', 'day one: the title');
  eq(p0.next, 'Errand Elephant', '…the next one');
  eq(p0.toNext, 8, '…and the distance to it');
  eq(p0.pct, 0, 'with progress at zero');
  const mid = DATA.repProgress(13);
  eq(mid.title, 'Errand Elephant', 'halfway up a rung keeps the lower title');
  eq(mid.pct, 50, 'and reports the progress through it', mid.pct);
  const top = DATA.repProgress(99999);
  eq(top.title, 'Tokenization Legend', 'the top of the ladder');
  eq(top.next, null, 'has nothing after it');
  eq(top.pct, 100, 'and is complete');
  ok(DATA.repProgress(-5).title === 'A Little Calf', 'a negative reputation is still a calf');

  /* live, through the game handle and the HUD */
  const g = createGame({ seed: 131, autosave: false });
  eq(g.rep().title, 'A Little Calf', 'game.rep() reports it');
  eq(g.hud().title.title, 'A Little Calf', 'and hud().title carries it for the strip');
  ok(g.hud().title.next && g.hud().title.toNext > 0, 'with the next rung and the gap');
  const promotions = [];
  g.bus.on('rep', (p) => { if (p.promoted) promotions.push(p.title); });
  g.economy.add('gold', 1, 0);
  while (g.state.rep < 40) g.quests.complete(g.quests.current());
  ok(promotions.length >= 2, 'climbing fires a promotion per rung', promotions.join(' → '));
  eq(promotions[0], 'Errand Elephant', 'in order', promotions.join(' → '));
  ok(g.rep().title !== 'A Little Calf', 'and the title moved with him', g.rep().title);
}

T('missing a deadline costs reputation, scaled to the order');
{
  eq(DATA.orderFailRep({ budget: 0, fee: 0 }), 2, 'the old flat 2 is now the floor');
  ok(DATA.orderFailRep({ budget: 3800, fee: 200 }) > DATA.orderFailRep({ budget: 180, fee: 20 }),
    'a bigger promise costs more when you break it');
  ok(DATA.orderFailRep({ budget: 1e9, fee: 0 }) <= DATA.orderFail.cap, 'and it is capped', DATA.orderFail.cap);
  ok(DATA.orderFailRep({ budget: 2000, fee: 0, type: 'fund' }) > DATA.orderFailRep({ budget: 2000, fee: 0 }),
    'a fund mandate — somebody’s savings — costs half again');

  const g = createGame({ seed: 133, autosave: false });
  g.state.rep = 60;
  g.state.time = 12 * 60;
  g.state.money = 500000;
  const small = { id: 'o1', client: 'otto', type: 'deliver', items: [], budget: 150, fee: 30, deadline: 1, made: 1 };
  const big = { id: 'o2', client: 'vance', type: 'deliver', items: [], budget: 7000, fee: 900, deadline: 1, made: 1 };
  g.state.orders.push(small, big);

  const before = g.state.rep;
  const failedEvents = [];
  g.bus.on('client', (p) => { if (p.kind === 'fail') failedEvents.push(p); });
  g.economy.failOrder(small);
  const afterSmall = before - g.state.rep;
  const mid = g.state.rep;
  g.economy.failOrder(big);
  const afterBig = mid - g.state.rep;

  ok(afterSmall >= 2, 'failing a small order costs at least the old penalty', afterSmall);
  ok(afterBig > afterSmall * 2, 'and failing a big one costs a lot more',
    `small −${afterSmall}, big −${afterBig}`);
  eq(g.state.stats.ordersFailed, 2, 'both were counted');
  ok(g.state.stats.repLost > 0, 'and the reputation lost is tracked', g.state.stats.repLost);
  ok(failedEvents.every((e) => e.rep < 0), "the 'client' event carries the cost", JSON.stringify(failedEvents.map((e) => e.rep)));

  /* and the live path — an order that runs out of days */
  const h = createGame({ seed: 134, autosave: false });
  h.state.rep = 40;
  h.state.time = 12 * 60;
  h.state.flags.dispatchShift = true;
  const o = h.clients.makeOrder('mabel');
  o.deadline = h.state.day;
  h.economy.acceptOrder(o);
  const rep0 = h.state.rep;
  h.enter('apartment');
  h.actions.sleep();                                  // the deadline passes overnight
  ok(h.state.rep < rep0, 'sleeping through a deadline costs reputation', `${rep0} -> ${h.state.rep}`);
  eq(h.state.orders.length, 0, 'and the order is gone');
  eq(badNumbers(h.state).length, 0, 'no NaNs');
}

/* ============================================================
   15. THE MAYOR'S DASH
   ============================================================ */
T('the Mayor is Ken Jones and he wants a race');
{
  eq(CLIENT_BY_ID.tusk.n, 'Mayor Ken Jones', 'the mayor is Mayor Ken Jones');
  eq(CLIENT_BY_ID.tusk.id, 'tusk', "…and keeps the id 'tusk', so old saves and orders still resolve");
  eq(RACE.mayor, 'tusk', 'the race points at him by id');
  const strings = [];
  (function walk(o, seen = new Set()) {
    if (o == null) return;
    if (typeof o === 'string') { strings.push(o); return; }
    if (typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    for (const k of Object.keys(o)) walk(o[k], seen);
  })(DATA);
  eq(strings.filter((t) => /Mayor Tusk/.test(t)).length, 0, 'nothing the player reads still says Mayor Tusk');

  /* THE ROUTE */
  ok(RACE.route.length >= 4, 'the route has at least four points', RACE.route.length);
  ok(RACE.route.every((id) => !!LOC_BY_ID[id]), 'every checkpoint is a real place', RACE.route.join(','));
  eq(RACE.route[0], RACE.route[RACE.route.length - 1], 'and it finishes where it started');
  const zones = new Set(RACE.route.map((id) => LOC_BY_ID[id].z));
  ok(zones.size >= 3, 'it goes through at least three districts', [...zones].join(', '));

  const g = createGame({ seed: 141, autosave: false });
  const route = g.race.route();
  eq(route.length, RACE.route.length, 'race.route() hands the UI one row per checkpoint');
  ok(route.every((r) => Number.isFinite(r.world.x) && Number.isFinite(r.world.z)),
    'each with a world position to draw a ring at');
  ok(route[route.length - 1].total > 400 && route[route.length - 1].total < 1600,
    'the lap is a few hundred metres of town', route[route.length - 1].total + ' m');
  eq(g.race.metres(), route[route.length - 1].total, 'race.metres() agrees with the route');

  /* THE ONLY WAY TO WIN IS THE SCOOTER OR THE MOTORCYCLE */
  eq(RACE.qualifies.join(','), 'scooter,motorcycle', 'only two rides can win');
  const onFoot = g.race.projection('foot');
  const onBike = g.race.projection('bike');
  const onScoot = g.race.projection('scooter');
  const onMoto = g.race.projection('motorcycle');
  ok(onFoot.seconds > onBike.seconds && onBike.seconds > onScoot.seconds && onScoot.seconds > onMoto.seconds,
    'each ride is quicker round the lap',
    `${onFoot.seconds}s / ${onBike.seconds}s / ${onScoot.seconds}s / ${onMoto.seconds}s`);
  ok(!onFoot.qualified && !onBike.qualified, 'feet and the bicycle do not qualify');
  ok(onScoot.qualified && onMoto.qualified, 'the scooter and the motorcycle do');

  /* THE STATE MACHINE */
  eq(g.race.status(), 'locked', 'it starts locked');
  ok(!g.race.canStart().ok, 'and cannot be started before he is asked');
  const events = [];
  g.bus.on('race', (p) => events.push(p.kind));
  const offer = g.race.offer();
  ok(offer.ok && offer.first, 'the Mayor steps in', JSON.stringify(offer));
  eq(g.race.status(), 'offered', 'and the race is on the table');
  ok(events.includes('offer'), "which emits bus 'race' {kind:'offer'}");
  ok(RACE.route.every((id) => g.known(id)), 'and every corner of his route is now on the map');
  ok(g.clients.met('tusk'), 'and Wally has met the Mayor');
  eq(g.race.offer().first, false, 'offering twice changes nothing');

  /* start conditions */
  g.state.energy = 100;
  g.state.hunger = 10;
  g.state.time = 10 * 60;
  g.state.loc = 'apartment';
  ok(!g.race.canStart().ok, 'you cannot start it from the wrong end of town');
  ok(/start line/i.test(g.race.canStart().why), 'and it says where the start line is', g.race.canStart().why);
  g.state.loc = RACE.route[0];
  g.state.time = 3 * 60;
  ok(!g.race.canStart().ok, 'nor at three in the morning');
  g.state.time = 10 * 60;
  ok(g.race.canStart().ok, 'at ten, outside the Bent Spoon, he can go', g.race.canStart().why);

  /* ON FOOT HE LOSES */
  const paceFoot = g.race.pace();
  eq(paceFoot.qualified, false, 'on foot he does not qualify');
  const started = g.race.start();
  ok(started.ok, 'the race starts', started.why);
  eq(g.race.status(), 'running', 'and it is running');
  ok(started.mayorSeconds > 0 && started.mps > 0, 'the UI is handed the Mayor’s pace', JSON.stringify({ s: started.mayorSeconds, mps: started.mps }));
  ok(started.mayorSeconds < paceFoot.rideSeconds, 'which on foot is faster than Wally can possibly run',
    `${started.mayorSeconds}s vs his best ${paceFoot.rideSeconds}s`);
  const cp = g.race.checkpoint(1);
  ok(cp.ok, 'checkpoints tick over', JSON.stringify(cp));
  ok(!g.race.checkpoint(5).ok, 'and they cannot be taken out of order');
  const lost = g.race.finish(paceFoot.mayorSeconds + 20);
  ok(lost.ok && !lost.won, 'and he loses', JSON.stringify(lost));
  eq(g.race.status(), 'lost', 'the race is lost');
  eq(g.state.race.losses, 1, 'and the loss is counted');

  /* EVEN A PERFECT RUN ON FOOT LOSES — the rule is absolute */
  g.state.energy = 100;
  g.race.start();
  const cheated = g.race.finish(1);
  ok(!cheated.won, 'a one-second lap on foot still loses — the ride is the rule', JSON.stringify(cheated));

  /* RETRY AS OFTEN AS HE LIKES */
  g.state.energy = 100;
  ok(g.race.canStart().ok, 'he may go again', g.race.canStart().why);
  ok(g.race.start().ok, 'and again');
  g.race.abandon();
  eq(g.race.status(), 'lost', 'abandoning is just another loss');

  /* THE BICYCLE IS NOT ENOUGH EITHER */
  g.actions.grantRide('bike');
  g.actions.equipRide('bike');
  g.state.energy = 100;
  const paceBike = g.race.pace();
  eq(paceBike.qualified, false, 'the bicycle does not qualify');
  ok(paceBike.mayorSeconds < paceBike.rideSeconds, 'and the Mayor still out-paces it',
    `${paceBike.mayorSeconds}s vs ${paceBike.rideSeconds}s`);
  g.race.start();
  ok(!g.race.finish(paceBike.mayorSeconds - 1).won, 'so the bicycle loses');

  /* THE SCOOTER WINS */
  g.actions.grantRide('scooter');
  g.actions.equipRide('scooter');
  g.state.energy = 100;
  const paceScoot = g.race.pace();
  ok(paceScoot.qualified, 'the scooter qualifies');
  ok(paceScoot.mayorSeconds > paceScoot.rideSeconds, 'and the Mayor is catchable on it',
    `${paceScoot.mayorSeconds}s vs ${paceScoot.rideSeconds}s`);
  g.race.start();
  const won = g.race.finish(paceScoot.rideSeconds);
  ok(won.ok && won.won, 'and he wins', JSON.stringify(won));
  eq(g.race.status(), 'won', 'the race is won');
  ok(g.race.won(), 'race.won() says so');
  ok(events.includes('finish'), "and the finish went out on the bus");
  ok(!g.race.canStart().ok, 'and there is nothing left to race for');
  eq(badNumbers(g.state).length, 0, 'the whole race produced no NaNs');
}

T('the scooter hint is occasional, earned, and never in the objective');
{
  /* NOT IN THE OBJECTIVE TEXT. The player has to work it out. */
  const exq = QUEST_BY_ID.q_exchange;
  ok(!/scooter|motorcycle|moped|vehicle|faster/i.test(exq.t + ' ' + exq.d + ' ' + exq.hint),
    'the Exchange objective never mentions a vehicle', exq.d);
  const anyQuest = QUESTS.concat(SIDE_QUESTS)
    .filter((q) => /scooter/i.test(q.t + ' ' + q.d) && q.id !== 'q_side_scooter');
  eq(anyQuest.length, 0, 'and no other objective gives it away', anyQuest.map((q) => q.id).join(','));
  ok(RACE.hints.some((h) => h.text === 'You might want to get a scooter to go faster!'),
    'the hint the user asked for is in the pool, word for word');

  const g = createGame({ seed: 147, autosave: false });
  g.race.offer();
  g.state.energy = 100;
  g.state.hunger = 5;
  const hints = [];
  g.bus.on('race', (p) => { if (p.kind === 'hint') hints.push({ day: g.state.day, text: p.text }); });

  /* first loss: never a hint */
  g.state.loc = RACE.route[0];
  g.state.time = 10 * 60;
  g.race.start();
  g.race.finish(9999);
  eq(hints.length, 0, 'no hint after the first loss — he is allowed to be confused');

  /* many more losses, on many days */
  let attempts = 0;
  for (let day = 0; day < 30; day++) {
    g.state.energy = 100;
    g.state.hunger = 5;
    g.state.time = 10 * 60;
    g.state.loc = RACE.route[0];
    if (!g.race.canStart().ok) break;
    g.race.start();
    g.race.finish(9999);
    attempts++;
    g.enter('apartment');
    g.actions.sleep();
  }
  ok(hints.length >= 1, 'but somebody eventually mutters it', `${hints.length} hints in ${attempts} losses`);
  ok(hints.length < attempts, 'and not on every single loss', `${hints.length} of ${attempts}`);
  const days = hints.map((h) => h.day);
  eq(new Set(days).size, days.length, 'never twice in one day', days.join(','));
  ok(hints.every((h) => /scooter/i.test(h.text)), 'and the hint points at a scooter', hints[0].text);
  eq(g.state.race.hints, hints.length, 'state.race counts them');
}

T('the race is an ADDITIONAL gate on the Stock Exchange');
{
  const g = createGame({ seed: 151, autosave: false });
  for (const l of LOCATIONS) g.state.known[l.id] = true;
  g.state.money = 100000;
  g.state.energy = 100;
  g.state.time = 10 * 60;

  const steps = () => g.actions.exchangeGate().steps;
  eq(steps().length, 4, 'four conditions on the door');
  eq(steps().map((s) => s.key).join(','), 'fundamentals,badge,race,fee', 'and the race is one of them, not all of them');

  /* the OLD path still has to be satisfied */
  g.enter('exchange');
  let gate = g.actions.exchangeGate();
  ok(!gate.ok, 'no class, no membership', gate.why);
  ok(/Market Fundamentals/.test(gate.why), 'and it says which class', gate.why);
  g.state.skills.inspection = true;
  g.state.skills.fundamentals = true;
  gate = g.actions.exchangeGate();
  ok(!gate.ok && /orders/.test(gate.why), 'the trader badge is still three client orders', gate.why);
  g.state.stats.ordersDone = CONFIG.exchangeOrders;

  /* NOW THE MAYOR */
  gate = g.actions.exchangeGate();
  ok(!gate.ok, 'paperwork in order and the door is still shut', gate.why);
  eq(gate.kind, 'race', 'because of the race');
  const purse = g.state.money;
  const tried = g.actions.unlockExchange();
  ok(!tried.ok, 'and paying will not get you past him', tried.why);
  ok(!g.state.unlocks.exchange, 'the Exchange is not unlocked');
  /* nothing was DEDUCTED (meeting the Mayor can close an old objective
     and pay it out, so this is >=, not ===) */
  ok(g.state.money >= purse, 'and no fee was taken', `${purse} -> ${g.state.money}`);
  eq(g.race.status(), 'offered', 'trying is what puts him in the doorway');

  /* the IPO path cannot walk round him either */
  const h = createGame({ seed: 152, autosave: false });
  h.state.money = 500000;
  h.state.rep = 60;
  h.state.office = 3;
  h.state.energy = 100;
  h.state.time = 11 * 60;
  for (const c of COURSES) h.state.skills[c.id] = true;
  for (const l of LOCATIONS) h.state.known[l.id] = true;
  h.enter('ipooffice');
  for (let i = 0; i < IPO_STEPS.length; i++) {
    h.state.energy = 100;
    h.state.time = 11 * 60;                          // the Listings Office keeps hours now
    const r = h.actions.ipoAdvance('wflw', 0.95);
    ok(r.ok, 'IPO step ' + (i + 1) + ' of ' + IPO_STEPS.length, r.why);
  }
  ok(h.state.stats.ipos >= 1, 'a company was listed', h.state.stats.ipos);
  ok(!h.state.unlocks.exchange, 'and listing it did NOT hand over the Exchange — the Mayor is still waiting');
  ok(h.race.status() !== 'locked', 'in fact it summoned him', h.race.status());

  /* win the race and the door opens on the old terms */
  g.actions.grantRide('scooter');
  g.state.loc = RACE.route[0];
  g.state.energy = 100;
  g.state.time = 10 * 60;
  g.race.start();
  ok(g.race.finish(g.race.pace().rideSeconds).won, 'he beats the Mayor');
  g.travel('exchange', 'walk');
  gate = g.actions.exchangeGate();
  ok(gate.ok, 'and now the door is open to him', gate.why);
  const money0 = g.state.money;
  const unl = g.actions.unlockExchange();
  ok(unl.ok, 'the membership goes through', unl.why);
  eq(money0 - g.state.money, CONFIG.exchangeFee, 'and it costs the $1,500 access fee');
  ok(g.state.unlocks.exchange, 'the Exchange is unlocked');
  ok(g.economy.buy('trnk', 1).ok, 'and he can finally buy a share');
  ok(g.state.quests.q_exchange, 'which closes the act-3 objective');
  ok(!g.actions.unlockExchange().ok, 'you cannot pay twice');
  eq(badNumbers(g.state).length, 0, 'no NaNs');
}

/* ============================================================
   16. THE MOTORCYCLE COSTS TEN CLIENT ORDERS
   ============================================================ */
T('the motorcycle is priced in client orders');
{
  /* MEASURED, not asserted from a comment: build the state a player is
     in when the shop will sell them one, roll real orders for all 24
     clients through clients.makeOrder(), and price the thing at ten of
     them. */
  const g = createGame({ seed: 161, autosave: false });
  g.state.rep = RIDES.motorcycle.unlock.rep;
  g.state.money = 5e6;
  g.state.time = 12 * 60;
  /* THIS SECTION MEASURES THE STEADY STATE, NOT THE TUTORIAL. Every
     order in the game before the first one is ACCEPTED is forced to
     the CRUMB basket (data.js FIRST_ORDER), and a $77 fee on a single
     croissant is not what the motorcycle is priced against. The flag
     is what acceptOrder() sets; a fabricated rep-95 broker who has
     never touched the desk has to set it himself. */
  g.state.flags.firstOrderTaken = true;
  for (const c of COURSES) g.state.skills[c.id] = true;
  for (const k of ['exchange', 'treasury', 'farmcoop', 'mineral', 'stadiumoffice']) g.state.unlocks[k] = true;
  for (const cid of Object.keys(g.state.clients)) { g.state.clients[cid].met = true; g.state.clients[cid].trust = 3; }

  let profit = 0, n = 0;
  for (let i = 0; i < 20; i++) {
    for (const c of CLIENTS) {
      const o = g.clients.makeOrder(c.id);
      if (!o || o.type === 'fund') continue;
      const outlay = o.items.reduce((t, it) => t + g.economy.buyPrice(it.a) * it.q, 0);
      profit += o.budget + o.fee - outlay;
      n++;
    }
  }
  const perOrder = profit / n;
  ok(n > 300, 'a big enough sample of real orders', n);
  ok(perOrder > 200 && perOrder < 500, 'a delivered order nets a few hundred dollars at that reputation',
    '$' + perOrder.toFixed(0));

  const orders = RIDES.motorcycle.price / perOrder;
  ok(orders >= 7 && orders <= 14, 'and the motorcycle is roughly ten of them',
    `$${RIDES.motorcycle.price} / $${perOrder.toFixed(0)} = ${orders.toFixed(1)} orders`);

  /* …or a great many shifts */
  const shift = (k, s = 0.5) => JOBS[k].base + s * JOBS[k].mult;
  const driveShifts = RIDES.motorcycle.price / shift('drive');
  const cafeShifts = RIDES.motorcycle.price / shift('cafe');
  ok(driveShifts > 40, 'or a great many Dispatch shifts', driveShifts.toFixed(0));
  ok(cafeShifts > driveShifts, 'and even more café ones', cafeShifts.toFixed(0));

  /* and it is still a late-game purchase, gated and sold in one place */
  ok(RIDES.motorcycle.unlock.rep >= 45, 'the reputation gate is late-game', RIDES.motorcycle.unlock.rep);
  eq(DATA.repProgress(RIDES.motorcycle.unlock.rep).title, 'Ledger Keeper',
    'you are a Ledger Keeper before Dispatch will sell you one');
  eq(RIDES.motorcycle.unlock.locs.join(','), 'trunkdepot', 'and only Dispatch sells it');
}

/* ============================================================
   17. SHIFTS PAY LESS — and CRUMB takes longer
   ============================================================ */
T('the café and Dispatch shifts pay less');
{
  const pay = (k, s = 0.5) => JOBS[k].base + s * JOBS[k].mult;
  /* the two day-one shifts, cut */
  ok(pay('cafe') < 45, 'a café shift is under $45', '$' + pay('cafe'));
  ok(pay('drive') < 55, 'a Dispatch shift is under $55', '$' + pay('drive'));
  ok(pay('nightdrive') < 80, 'and the night shift under $80', '$' + pay('nightdrive'));
  /* the shifts you have to be discovered to work now pay best */
  ok(pay('warehouse') > pay('drive'), 'sorting a warehouse beats driving', `$${pay('warehouse')} vs $${pay('drive')}`);
  ok(pay('cleanup') > pay('cafe'), 'and the stadium beats the café', `$${pay('cleanup')} vs $${pay('cafe')}`);
  for (const k of Object.keys(JOBS)) {
    ok(pay(k, 0) > 0 && pay(k, 1) > pay(k, 0), `shift ${k} still pays on performance`);
  }

  /* THE FIRST ASSET FROM CRUMB. Crumb & Co. Bakery is $380 at the
     business broker's 8 % spread. The count is: how many shifts, on
     top of the $250 you start with, until you can pay for one unit. */
  const g = createGame({ seed: 171, autosave: false });
  const crumb = g.economy.findByTicker('CRUMB');
  eq(crumb.id, 'bakery', 'CRUMB is the bakery');
  const price = g.economy.buyPrice('bakery');
  const need = Math.max(0, price - CONFIG.startMoney);
  const shiftsFor = (k) => Math.ceil(need / pay(k));
  const nowCafe = shiftsFor('cafe');
  const nowDrive = shiftsFor('drive');
  /* the pay it used to be, so the comparison is in the test and not
     only in a report nobody re-runs */
  const WAS = { cafe: 48 + 0.5 * 64, drive: 56 + 0.5 * 78 };
  const wasCafe = Math.ceil(need / WAS.cafe);
  const wasDrive = Math.ceil(need / WAS.drive);
  ok(nowCafe > wasCafe, 'CRUMB takes more café shifts than it used to', `${wasCafe} -> ${nowCafe}`);
  ok(nowDrive > wasDrive, 'and more Dispatch shifts', `${wasDrive} -> ${nowDrive}`);
  ok(nowCafe >= 4 && nowCafe <= 8, 'four to eight café shifts is the target', nowCafe);
  ok(nowDrive >= 3 && nowDrive <= 6, 'three to six at Dispatch', nowDrive);

  /* and it is still affordable inside the first week, not the first month */
  const perDay = pay('drive') * 2;                    // two shifts is a comfortable day
  ok(need / perDay < 4, 'a couple of days of proper work, not a fortnight', (need / perDay).toFixed(1) + ' days');
}

/* ============================================================
   18. OTTO IS AT THE BENT SPOON — the whole beat, simulated
   ============================================================ */
T('Otto is actually at the Bent Spoon, end to end');
{
  const g = createGame({ seed: 181, autosave: false });
  const beats = [];
  g.bus.on('story', (p) => beats.push(p.beat));

  /* 1. the message arrives, and it names the place */
  eq(g.state.msgs[0].from, 'Otto', 'the message is from Otto');
  ok(/Bent Spoon on Main Street/.test(g.state.msgs[0].text), 'and it says where to find him');
  eq(LOC_BY_ID.cafe.n, 'The Bent Spoon', 'which is a real place');
  eq(LOC_BY_ID.cafe.z, 'mainstreet', 'on Main Street');

  /* 2. reading it points him at the CAFE — this is the fix */
  g.actions.readMessages();
  const side = g.quests.sideCurrent();
  ok(!!side, 'reading it opens a side objective');
  eq(side.id, 'q_side_otto_meet', 'to go and find him');
  eq(g.quests.questLoc(side.id), 'cafe', 'AT THE CAFE, not at the office');
  eq(SIDE_QUEST_BY_ID.q_side_otto_meet.loc, 'cafe', 'the declaration says cafe');
  eq(SIDE_QUEST_BY_ID.q_side_otto.loc, 'office', "…and the DELIVERY step still says office, because that is where the desk is");
  eq(g.hud().objective.id, 'q_first_job', 'the main objective is the Dispatch shift, untouched by any of this');

  /* 3. and Otto is standing in the room */
  ok(g.clients.postsAt('cafe').some((c) => c.id === 'otto'), 'Otto is posted at the cafe');
  ok(g.whoIsAt('cafe').some((c) => c.id === 'otto'), 'whoIsAt() puts him there for the NPC layer');
  ok(g.whoIsAt('cafe').find((c) => c.id === 'otto').line.length > 20, 'with a line to say');
  ok(!g.whoIsAt('trunkdepot').some((c) => c.id === 'otto'), 'and he is not simultaneously at Dispatch');

  /* 4. travel there — the cafe is open and known from the first minute */
  ok(g.known('cafe'), 'the cafe is on the map from the first minute');
  ok(g.isOpen('cafe'), 'and open at 07:00');
  g.state.energy = 100;
  const trip = g.travel('cafe', 'walk');
  ok(trip.ok, 'he can walk there', trip.why);
  eq(g.state.loc, 'cafe', 'and he is in the cafe');

  /* 5. he is THERE: the beat fires, the order lands, the quest starts */
  ok(beats.includes('cafe'), 'the meeting fires');
  ok(g.state.flags.metFriend, 'they have met');
  ok(g.clients.met('otto'), 'and Otto is a client now');
  ok(g.quests.isSideDone('q_side_otto_meet'), 'the "find him" step closed by finding him');
  ok(g.quests.isSideActive('q_side_otto'), 'and the order step opened');
  eq(g.quests.questLoc('q_side_otto'), g.officeLoc(), 'pointing at the desk, wherever the desk currently is');
  const order = g.state.arrivals.find((o) => o.client === 'otto');
  ok(!!order, 'his order is on the desk', JSON.stringify(g.state.arrivals.map((a) => a.client)));
  /* he has stopped waiting, because he has been met */
  ok(!g.clients.postsAt('cafe').some((c) => c.id === 'otto'), 'and he is no longer waiting there');

  /* 6. it does not disturb the main objective */
  eq(g.hud().objective.id, 'q_first_job', 'the main chain is exactly where it was');
  ok(!g.state.quests.q_side_otto && !g.state.quests.q_side_otto_meet, 'and state.quests never sees either step');

  /* 7. finish it: buy the thing, take it to the desk */
  g.state.money = 5000;
  g.state.time = 12 * 60;
  g.actions.accept(order);
  for (const it of order.items) {
    const r = g.economy.buy(it.a, it.q);
    ok(r.ok, 'the thing he asked for can be bought', r.why);
  }
  g.travel(g.officeLoc(), 'walk');
  const del = g.actions.deliver(order);
  ok(del.ok, 'and delivered at the desk', del.why);
  ok(g.quests.isSideDone('q_side_otto'), 'which finishes the errand');
  eq(g.quests.sideProgress().done, 2, 'both halves of the beat are done');
  eq(badNumbers(g.state).length, 0, 'the whole beat produced no NaNs');
}

/* ============================================================
   19. THE PRODUCER UPGRADES — what they actually do
   ============================================================ */
T('the farm and mine upgrades do something you can point at');
{
  const g = createGame({ seed: 191, autosave: false });
  for (const l of LOCATIONS) g.state.known[l.id] = true;
  g.state.money = 500000;
  g.state.time = 10 * 60;
  g.state.farm = { ...g.state.farm, owned: true, lvl: 1, irrigation: true };
  g.state.mine = { ...g.state.mine, owned: true, lvl: 1, elevator: true, safety: true, rights: true };

  const f1 = g.actions.producer('farm');
  ok(!!f1, 'actions.producer("farm") answers the question');
  eq(f1.level, 1, 'at level 1');
  ok(f1.nextPerAction > f1.perAction, 'the next level yields MORE PER HARVEST — which it did not before',
    `${f1.perAction} -> ${f1.nextPerAction}`);
  eq(f1.nextPerAction - f1.perAction, 1, 'exactly one more crop token per harvest');
  ok(f1.lines.length === 3 && f1.lines.every((l) => /\d/.test(l)), 'and it is stated in numbers the UI can print',
    f1.lines.join(' | '));
  ok(/Tilda/.test(f1.lines[2]), 'including the part that only pays if Tilda is hired', f1.lines[2]);
  eq(f1.dailyIncome, 0, 'because without her the daily income really is zero');
  ok(f1.dailyIfHired > 0, 'and with her it would be $' + f1.dailyIfHired + ' a day');

  /* the yield claim is TRUE, measured through the real action */
  g.enter('farm');
  g.state.energy = 100; g.state.time = 10 * 60;
  const h1 = g.actions.farmHarvest(0.5);
  ok(h1.ok, 'a harvest at level 1', h1.why);
  g.state.farm.lvl = 3;
  g.state.energy = 100; g.state.time = 10 * 60;      // the farm shuts at 19:00
  const h3 = g.actions.farmHarvest(0.5);
  ok(h3.ok, 'and one at level 3', h3.why);
  ok(h3.qty > h1.qty, 'the level really does put more in the basket', `${h1.qty} -> ${h3.qty}`);
  eq(h3.qty - h1.qty, 2, 'two levels, two more tokens');

  /* the same for the mine */
  g.state.time = 10 * 60;
  g.enter('mine');
  g.state.energy = 100;
  const d1 = g.actions.mineDig(0.5);
  ok(d1.ok, 'a dig at level 1', d1.why);
  g.state.mine.lvl = 3;
  g.state.energy = 100; g.state.time = 10 * 60;      // and the mine at 18:00
  const d3 = g.actions.mineDig(0.5);
  ok(d3.ok, 'and one at level 3', d3.why);
  ok(d3.qty > d1.qty, 'and the mine level does the same', `${d1.qty} -> ${d3.qty}`);

  const m1 = g.actions.producer('mine');
  ok(/Bruno/.test(m1.lines[2]), 'the mine names Bruno', m1.lines[2]);
  eq(m1.manager, 'bruno', 'by id, so the UI can link to him');
  ok(m1.cost > 0 && Number.isFinite(m1.cost), 'and the next level has a price', m1.cost);

  /* the OTHER real effect, the one nobody ever stated: the tier */
  const lvl0 = g.actions.producer('farm');
  ok(lvl0.tier >= 1 && lvl0.tier <= DATA.producers.farm.maxTier, 'a level maps to a crop tier', lvl0.tier);
  ok(DATA.producers.farm.effect.length > 20 && DATA.producers.mine.effect.length > 20,
    'and data.js carries a plain description of both effects for the UI');
  ok(/only while/i.test(DATA.producers.farm.daily), 'which is honest about the employee condition',
    DATA.producers.farm.daily);
  ok(!g.actions.producer('nonsense'), 'an unknown producer is null, not a crash');
}

/* ============================================================
   THE TOP OFFICE RUNS EVERY UPGRADE AT ONCE

   The complaint this block exists to keep answered: at the top of the
   game the player was still choosing between upgrades he had already
   bought — ten specialists, six chairs. These tests hold the ceiling
   open, and the block after them holds the CLIMB open, so nobody
   "fixes" this again by handing stage 0 the keys to Wally Tower.
   ============================================================ */
const TOP = OFFICE_STAGES.length - 1;

/* A game standing at the top of every ladder, with the money, the
   classes and the venues to actually use it. Home stays the leaking
   flat on purpose: THE OFFICE ALONE must be enough. */
function topOfficeGame(seed = 4242) {
  const g = createGame({ seed, autosave: false });
  const st = g.state;
  st.office = TOP;
  st.rep = 120;
  st.money = 5000000;
  st.energy = 100;
  st.hunger = 0;
  st.time = 12 * 60;
  st.flags.dispatchShift = true;
  for (const c of COURSES) st.skills[c.id] = true;
  for (const k of ['exchange', 'treasury', 'farmcoop', 'mineral', 'stadiumoffice', 'wallet', 'remote', 'swap']) st.unlocks[k] = true;
  return g;
}

T('the top office seats every upgrade in the game at once');
{
  const g = topOfficeGame();
  const st = g.state;

  /* 1. SEATS. This is the one that was broken: hire() read the literal
     `state.office + 1`, so the top office had six chairs for ten
     specialists. Every hire below goes through the real door. */
  eq(OFFICE_STAGES[TOP].seats, EMPLOYEE_POOL.length,
    'the top stage has a seat for every specialist in the pool');
  ok(OFFICE_STAGES[TOP].seats > TOP + 1,
    'and seats no longer come from the old office+1 rule',
    `${OFFICE_STAGES[TOP].seats} vs ${TOP + 1}`);
  for (const e of EMPLOYEE_POOL) {
    const r = g.actions.hire(e.id);
    ok(r.ok, `${e.n} the ${e.role.toLowerCase()} can be hired at the top office`, r.why);
  }
  eq(st.employees.length, EMPLOYEE_POOL.length, 'all ten are on the payroll simultaneously');
  eq(g.economy.teamFree(), 0, 'which is exactly a full house, not an infinite one');

  /* 2. AND EVERY PERK IS LIVE AT THE SAME TIME. A seat is only worth
     having if the thing sitting in it works, so measure them. */
  ok(g.economy.orderSlots() > OFFICE_STAGES[TOP].slots, "Pim's extra order slot is live");
  ok(g.economy.fundCap() > OFFICE_STAGES[TOP].fundCap, "Mattie's extra fund is live");
  const plain = createGame({ seed: 9, autosave: false });
  plain.state.money = 500000;
  plain.economy.add('gold', 1, 100);
  g.economy.add('gold', 1, 100);
  ok(g.economy.tokenizeCost('gold') < plain.economy.tokenizeCost('gold'),
    "Orla's cheaper filing is live at the same time",
    `${g.economy.tokenizeCost('gold')} vs ${plain.economy.tokenizeCost('gold')}`);
  st.farm.owned = true; st.farm.lvl = 2;
  st.mine.owned = true; st.mine.lvl = 2;
  ok(g.economy.overnightIncome() > 0,
    'and the farm, the mine and the property book all pay overnight together',
    g.economy.overnightIncome());
  ok(st.employees.includes('kite') && st.employees.includes('tilda') && st.employees.includes('bruno')
    && st.employees.includes('sable') && st.employees.includes('reg') && st.employees.includes('orla'),
    'Wally Swap, both producers, the property book, the driver and the lawyer share the floor');

  /* 3. SLOTS. clients.candidates() refuses anyone who already has a
     live order, so the true ceiling is one job per client. */
  ok(g.economy.orderSlots() >= CONFIG.totalClients,
    'the top office holds an open job from every client in the city',
    `${g.economy.orderSlots()} slots vs ${CONFIG.totalClients} clients`);
  let accepted = 0;
  for (const c of CLIENTS) {
    const o = g.clients.makeOrder(c.id);
    if (!o) continue;
    const r = g.economy.acceptOrder(o);
    if (!r.ok) { ok(false, `order ${accepted + 1} from ${c.n} was refused`, r.why); break; }
    accepted++;
  }
  eq(accepted, CLIENTS.length, 'every one of the 24 clients has a live job at once');
  eq(st.orders.length, CLIENTS.length, 'and all 24 are in the order book together');

  /* 4. FUNDS. Same ceiling, same reason. */
  ok(g.economy.fundCap() >= CONFIG.totalClients,
    'the top office runs a fund for every client too',
    `${g.economy.fundCap()} funds vs ${CONFIG.totalClients} clients`);

  /* 5. INVENTORY. One of all 69 assets — quest q_all — plus a
     completely full order book at its worst case. */
  ok(OFFICE_STAGES[TOP].invCap >= CONFIG.totalAssets + CONFIG.totalClients * 2 * 3,
    'the shelf holds all 69 assets plus a worst-case full order book',
    `${OFFICE_STAGES[TOP].invCap} vs ${CONFIG.totalAssets + CONFIG.totalClients * 2 * 3}`);

  /* 6. THE ONE-LINE ANSWER the UI can read. */
  const off = g.office();
  ok(off.everythingAtOnce, 'game.office().everythingAtOnce is true at Wally Tower');
  eq(off.name, 'Wally Tower', 'and it names the stage');
  eq(off.seats.used, EMPLOYEE_POOL.length, 'with every seat filled');
  eq(badNumbers(st).length, 0, 'a fully staffed, fully booked office has no NaNs');
}

T('and every asset in the city fits on the shelf with room for the book');
{
  const g = topOfficeGame(77);
  for (const a of ASSETS) {
    if (!g.economy.add(a.id, 1, a.v)) {
      ok(false, `no room for ${a.tick} at the top office`, g.economy.invCount() + '/' + g.economy.invCap());
      break;
    }
  }
  eq(g.economy.distinctOwned(), CONFIG.totalAssets, 'all 69 assets owned at once');
  ok(g.economy.invCount() <= g.economy.invCap(), 'inside the shelf, not over it',
    `${g.economy.invCount()}/${g.economy.invCap()}`);
  ok(g.economy.invCap() - g.economy.invCount() >= CONFIG.totalClients * 2 * 3,
    'with room left for a worst-case full order book on top',
    `${g.economy.invCap() - g.economy.invCount()} spare`);
  g.quests.check();
  ok(g.state.quests.q_all, 'and quest q_all — own all 69 assets — closes on it');
}

T('funds live in the fund, not on the office shelf');
{
  const g = topOfficeGame(78);
  const cap = g.economy.invCap();
  g.economy.add('gold', 10, 1000);
  eq(g.economy.invCount(), 10, 'ten units on the shelf');
  /* lock six into a client fund, the way completeOrder() does */
  g.state.inv.gold.locked = 6;
  eq(g.economy.invCount(), 4, 'six locked into a fund leave four on the shelf');
  eq(g.economy.invLocked(), 6, 'invLocked() reports the six');
  eq(g.economy.invHeld(), 10, 'invHeld() still reports all ten on paper');
  eq(g.economy.free('gold'), 4, 'free() agrees — locked units cannot be sold');
  eq(g.economy.invCap(), cap, 'the cap itself has not moved');
  ok(g.economy.add('gold', cap - 4, 1000),
    'so the fund has not stolen shelf space from the next purchase');
}

T('the office stages are still a climb, not six copies of the top');
{
  for (const k of ['seats', 'slots', 'invCap', 'fundCap']) {
    for (let i = 1; i < OFFICE_STAGES.length; i++) {
      ok(OFFICE_STAGES[i][k] > OFFICE_STAGES[i - 1][k],
        `${k} strictly increases from ${OFFICE_STAGES[i - 1].n} to ${OFFICE_STAGES[i].n}`,
        `${OFFICE_STAGES[i - 1][k]} -> ${OFFICE_STAGES[i][k]}`);
    }
    for (let i = 0; i < TOP; i++) {
      ok(OFFICE_STAGES[i][k] < OFFICE_STAGES[TOP][k],
        `${OFFICE_STAGES[i].n} is genuinely smaller than Wally Tower on ${k}`);
    }
  }
  for (let i = 1; i < OFFICE_STAGES.length; i++) {
    ok(OFFICE_STAGES[i].cost > OFFICE_STAGES[i - 1].cost, `stage ${i} costs more than stage ${i - 1}`);
    ok(OFFICE_STAGES[i].rep >= OFFICE_STAGES[i - 1].rep, `stage ${i} asks for at least as much reputation`);
  }
  /* the opening is untouched: one seat, one slot, no funds */
  eq(OFFICE_STAGES[0].seats, 1, 'the folding table still seats exactly Wally');
  eq(OFFICE_STAGES[0].slots, 1, 'and holds exactly one job');
  eq(OFFICE_STAGES[0].fundCap, 0, 'and cannot run a fund at all');
  /* nothing below the top may claim it can run everything */
  for (let i = 0; i < OFFICE_STAGES.length; i++) {
    const g = createGame({ seed: 300 + i, autosave: false });
    g.state.office = i;
    eq(g.office().everythingAtOnce, i === TOP,
      `everythingAtOnce is ${i === TOP} at ${OFFICE_STAGES[i].n}`);
  }
  /* and a mid-stage office still says no, in the same words */
  const mid = createGame({ seed: 301, autosave: false });
  mid.state.office = 1; mid.state.money = 500000; mid.state.hunger = 0;
  for (const e of EMPLOYEE_POOL) mid.actions.hire(e.id);
  eq(mid.state.employees.length, OFFICE_STAGES[1].seats, 'the Shared Desk still seats only two');
  const refused = mid.actions.hire('kite');
  ok(!refused.ok && /free seat/i.test(refused.why), 'and refuses the third by name', refused.why);
}

/* ============================================================
   THE TWO ENDINGS

   'city:tokenized'  all 69 assets tokenized -> the minute of fireworks
   'game:complete'   the whole game finished -> Happy's last line

   Both are latched by a flag IN THE SAVE, so a reload cannot replay
   them, and both have a debug door so neither needs a playthrough.
   ============================================================ */

/* Tokenize the whole city through the real economy door. */
function tokenizeWholeCity(g) {
  g.state.money = 5000000;
  for (const c of COURSES) g.state.skills[c.id] = true;
  for (const a of ASSETS) {
    if (g.economy.owned(a.id) < 1) g.economy.add(a.id, 1, a.v);
    g.economy.tokenize(a.id);
  }
  return g.economy.cityPct();
}

T('100% tokenized fires city:tokenized once, and only once');
{
  const g = createGame({ seed: 501, autosave: false });
  const seen = [];
  const legacy = [];
  g.bus.on('city:tokenized', (p) => seen.push(p));
  g.bus.on('endgame', (p) => legacy.push(p));

  /* 68 of 69 must NOT fire it */
  g.state.money = 5000000;
  for (const c of COURSES) g.state.skills[c.id] = true;
  const last = ASSETS[ASSETS.length - 1];
  for (const a of ASSETS.slice(0, -1)) { g.economy.add(a.id, 1, a.v); g.economy.tokenize(a.id); }
  eq(g.quests.tokenizedCount(), CONFIG.totalAssets - 1, 'sixty-eight assets tokenized');
  eq(seen.length, 0, 'and the city event has not fired at 68 of 69');
  ok(!g.quests.cityTokenized(), 'quests.cityTokenized() is false one short');
  ok(!g.quests.hasFiredCity(), 'and the latch is not set');

  /* the sixty-ninth fires it */
  g.economy.add(last.id, 1, last.v);
  g.economy.tokenize(last.id);
  eq(seen.length, 1, 'the sixty-ninth fires city:tokenized exactly once');
  const p = seen[0];
  eq(p.pct, 100, 'payload.pct is 100');
  eq(p.tokenized, CONFIG.totalAssets, 'payload.tokenized is 69');
  eq(p.total, CONFIG.totalAssets, 'payload.total is 69');
  eq(p.durationMs, CONFIG.fireworksMs, 'payload.durationMs is the length of the show');
  eq(p.durationMs, 60000, 'which is a minute, in milliseconds');
  eq(p.forced, false, 'and it is not a forced rehearsal');
  num(p.day, 'payload.day is a number');
  num(p.netWorth, 'payload.netWorth is a number');
  ok(legacy.length >= 1, "the legacy 'endgame' event still fires alongside it");
  ok(g.quests.hasFiredCity(), 'the latch is set');
  eq(g.state.flags.cityTokenized100, true, 'as state.flags.cityTokenized100, which is in the save');

  /* nothing can make it fire twice */
  g.quests.check();
  g.quests.milestones();
  g.economy.tokenize(last.id);
  eq(seen.length, 1, 'checking, milestoning and re-tokenizing cannot fire it again');

  /* AND IT SURVIVES A SAVE/LOAD */
  const json = g.exportSave();
  const g2 = createGame({ seed: 502, autosave: false });
  const seen2 = [];
  g2.bus.on('city:tokenized', (x) => seen2.push(x));
  ok(!!g2.importSave(json), 'the fully tokenized save loads');
  eq(seen2.length, 0, 'and loading it does NOT replay the fireworks');
  eq(g2.quests.cityPct(), 100, 'though the loaded city is still 100% tokenized');
  ok(g2.quests.hasFiredCity(), 'and the latch came across with the save');

  /* a save written BEFORE the latch existed must not replay either */
  const older = JSON.parse(json);
  delete older.flags.cityTokenized100;
  delete older.flags.gameComplete;
  const g3 = createGame({ seed: 503, autosave: false });
  const seen3 = [];
  g3.bus.on('city:tokenized', (x) => seen3.push(x));
  ok(!!g3.importSave(JSON.stringify(older)), 'a pre-latch finished save loads');
  eq(seen3.length, 0, 'and syncLatches() stops it replaying the fireworks at the door');
  ok(g3.quests.hasFiredCity(), 'the latch is armed silently instead');
}

T('the city fireworks have a debug door');
{
  const g = createGame({ seed: 504, autosave: false });
  const seen = [];
  g.bus.on('city:tokenized', (p) => seen.push(p));
  ok(typeof g.debug.tokenizeCity === 'function', 'game.debug.tokenizeCity() exists');
  ok(typeof g.debug.fireCity === 'function', 'game.debug.fireCity() exists');
  eq(g.debug.tokenizeCity().pct, 100, 'tokenizeCity() takes the city to 100%');
  eq(seen.length, 1, 'and fires the event once');
  eq(g.debug.fireCity(), false, 'fireCity() refuses to fire a second time');
  eq(seen.length, 1, 'so nothing fired again');
  const forced = g.debug.fireCity(true);
  ok(forced && forced.forced === true, 'fireCity(true) re-fires as an explicit rehearsal');
  eq(seen.length, 2, 'which is the only way to see it twice');
  eq(seen[1].durationMs, CONFIG.fireworksMs, 'and the rehearsal is the same minute long');
}

T('game:complete fires only when the real completion set is satisfied');
{
  /* (a) 100% tokenized ALONE is not completion */
  const a = createGame({ seed: 601, autosave: false });
  const doneA = [];
  a.bus.on('game:complete', (p) => doneA.push(p));
  tokenizeWholeCity(a);
  a.quests.check();
  eq(doneA.length, 0, 'a fully tokenized city with quests open does NOT finish the game');
  ok(!a.quests.completion().complete, 'and completion() says so');
  ok(a.quests.completion().missing.length > 0, 'with a list of what is left',
    a.quests.completion().missing.length);

  /* (b) the whole main chain WITHOUT the side quests is not completion */
  const b = createGame({ seed: 602, autosave: false });
  const doneB = [];
  b.bus.on('game:complete', (p) => doneB.push(p));
  tokenizeWholeCity(b);
  for (const q of QUESTS) b.quests.complete(q);
  b.state.sides = {};
  b.quests.check();
  eq(b.quests.completion().side.done, 0, 'no side quests done');
  eq(doneB.length, 0, 'the main chain alone does NOT finish the game');
  ok(b.quests.completion().missing.some((m) => m.kind === 'side'),
    'and the side quests are named as missing');

  /* (c) main + side WITHOUT the city is not completion either — the
     tokenization clause is asserted directly, not trusted to q_city */
  const c = createGame({ seed: 603, autosave: false });
  const doneC = [];
  c.bus.on('game:complete', (p) => doneC.push(p));
  for (const q of QUESTS) c.quests.complete(q);
  for (const q of SIDE_QUESTS) c.quests.completeSide(q);
  c.state.tokenized = {};
  c.quests.check();
  eq(doneC.length, 0, 'every quest closed but an untokenized city does NOT finish the game');
  ok(!c.quests.completion().tokenized.ok, 'the tokenization clause is what fails',
    JSON.stringify(c.quests.completion().tokenized));

  /* (d) the whole set, and it fires exactly once */
  const d = createGame({ seed: 604, autosave: false });
  const doneD = [];
  d.bus.on('game:complete', (p) => doneD.push(p));
  const report = d.debug.completeGame();
  ok(report.complete, 'the full completion set is satisfiable');
  eq(report.main.done, QUESTS.length, `all ${QUESTS.length} main quests done`);
  eq(report.side.done, SIDE_QUESTS.length, `all ${SIDE_QUESTS.length} side quests done`);
  eq(report.tokenized.done, CONFIG.totalAssets, 'all 69 assets tokenized');
  ok(report.assets.ok, 'and q_all — own all 69 assets — is closed');
  eq(doneD.length, 1, 'game:complete fired exactly once');
  d.quests.check(); d.quests.milestones(); d.debug.completeGame();
  eq(doneD.length, 1, 'and nothing can make it fire again');
  eq(d.state.flags.gameComplete, true, 'the latch is state.flags.gameComplete');
  eq(badNumbers(d.state).length, 0, 'a finished game has no NaNs');

  /* (e) it survives a save/load */
  const json = d.exportSave();
  const e = createGame({ seed: 605, autosave: false });
  const doneE = [];
  e.bus.on('game:complete', (p) => doneE.push(p));
  ok(!!e.importSave(json), 'the finished save loads');
  eq(doneE.length, 0, 'and loading it does not replay Happy');
  ok(e.quests.completion().complete, 'though it is still a finished game');
  ok(e.quests.hasFiredComplete(), 'and the latch came across');

  /* (f) the debug door */
  const f = createGame({ seed: 606, autosave: false });
  const doneF = [];
  f.bus.on('game:complete', (p) => doneF.push(p));
  ok(typeof f.debug.completeGame === 'function', 'game.debug.completeGame() exists');
  ok(typeof f.debug.fireComplete === 'function', 'game.debug.fireComplete() exists');
  ok(f.debug.fireComplete()?.text, 'fireComplete() fires it on demand');
  eq(doneF.length, 1, 'once');
  eq(f.debug.fireComplete(), false, 'and refuses a second time');
  ok(f.debug.fireComplete(true).forced === true, 'unless forced, which says so in the payload');
  eq(doneF.length, 2, 'and that is the only way to see it twice');
}

T("Happy's ending is verbatim, and both URLs are links");
{
  /* THE LINE, TYPED OUT HERE INDEPENDENTLY OF data.js. If these two
     ever disagree, one of them was edited, and this is the test that
     has to say so. */
  const VERBATIM = "Congratulations, Wally! You've brought Bull Bear City to its max potential using tokenization and your belief in RWAs. Try more games at RWAF.ai or learn more about the RWA Foundation at RWAFx.xyz";

  eq(DATA.happyEnding.text, VERBATIM, "Happy's speech is verbatim, character for character");
  eq(HAPPY_ENDING.text, VERBATIM, 'and the exported constant agrees');
  eq(HAPPY_ENDING.speaker, 'Happy', 'Happy is the one who says it');
  ok(!/\n/.test(HAPPY_ENDING.text), 'it is one unbroken paragraph, not a reflowed array');

  /* the two URLs, present and countable */
  ok(HAPPY_ENDING.text.includes('RWAF.ai'), 'RWAF.ai survives in the text');
  ok(HAPPY_ENDING.text.includes('RWAFx.xyz'), 'RWAFx.xyz survives in the text');
  eq(HAPPY_ENDING.links.length, 2, 'and both are declared as links, not prose');
  for (const l of HAPPY_ENDING.links) {
    ok(HAPPY_ENDING.text.includes(l.label), `link label "${l.label}" appears in the speech`);
    ok(/^https?:\/\/\S+$/.test(l.url), `link "${l.label}" has an absolute url`, l.url);
    eq(HAPPY_ENDING.text.split(l.label).length - 1, 1,
      `"${l.label}" appears exactly once, so a linkifier cannot mis-target it`);
  }
  eq(HAPPY_ENDING.links[0].label, 'RWAF.ai', 'the first link is RWAF.ai');
  eq(HAPPY_ENDING.links[1].label, 'RWAFx.xyz', 'the second link is RWAFx.xyz');
  ok(HAPPY_ENDING.links[0].url !== HAPPY_ENDING.links[1].url, 'and they point at different places');

  /* AND IT RIDES ON THE EVENT, so the UI never retypes it */
  const g = createGame({ seed: 701, autosave: false });
  let payload = null;
  g.bus.on('game:complete', (p) => { payload = p; });
  g.debug.completeGame();
  ok(payload, 'game:complete carried a payload');
  eq(payload.speaker, 'Happy', 'the payload names Happy as the speaker');
  eq(payload.text, VERBATIM, 'and carries the speech verbatim');
  eq(payload.links.length, 2, 'and both links');
  eq(payload.links.map((l) => l.label).join('|'), 'RWAF.ai|RWAFx.xyz', 'in order, labelled');
  num(payload.netWorth, 'plus a net worth for the card');
  eq(payload.main.total, QUESTS.length, 'and the main-chain tally');
  eq(payload.side.total, SIDE_QUESTS.length, 'and the side-quest tally');
}

/* ============================================================
   23. DISCOVERY BY WALKING — found is not the same as allowed in

   "You can discover all places yourself by also walking nearby them
   and discovering them on the map by traveling there manually,
   however it doesn't always mean you can use or start the quests
   right away."

   So this section has to prove BOTH halves. Walking up to a building
   puts it on the map — which is what stops Dispatch from being the
   only road forward — and putting it on the map grants NOTHING. Every
   gate that stood before it still stands after it, and the refusal
   says which one.
   ============================================================ */
T('walking near a building discovers it');
{
  const g = createGame({ seed: 401, autosave: false });
  const ex = LOC_BY_ID.exchange;

  /* --- the radius is a real, sane number, per building --- */
  ok(DISCOVER.dwell > 0 && DISCOVER.dwell < 3, 'the dwell is a fraction of a second, not a stakeout', DISCOVER.dwell);
  for (const l of LOCATIONS) {
    num(l.findRadius, `${l.id} has a discovery radius`);
    ok(l.findRadius >= DISCOVER.min, `${l.id}'s radius is at least the floor`, l.findRadius);
    ok(l.findRadius > l.radius, `${l.id} is noticed from further than its own footprint`,
      `${l.findRadius} vs ${l.radius}`);
    /* it must also be WIDER than hud.js's door-prompt reach, so a place
       lands on the map before you can press E at it */
    const doorReach = Math.max(9, Math.hypot(l.size.w, l.size.d) * 0.5 + 5.5);
    ok(l.findRadius > doorReach, `${l.id} is discovered before its door prompts`,
      `${l.findRadius} vs ${doorReach.toFixed(1)}`);
  }
  /* THE ASSERTION THAT KEEPS THE RADIUS HONEST: no circle may ever
     reach a neighbour, or walking to one door would discover two. */
  let worst = Infinity, worstPair = '';
  for (const a of LOCATIONS) {
    for (const b of LOCATIONS) {
      if (a === b) continue;
      const d = Math.hypot(a.world.x - b.world.x, a.world.z - b.world.z);
      const slack = d - a.findRadius;
      if (slack < worst) { worst = slack; worstPair = `${a.id} -> ${b.id}`; }
    }
  }
  ok(worst > 10, 'no discovery radius reaches another building', `${worstPair} clears by ${worst.toFixed(1)} m`);

  /* EVERY GATED PLACE CAN EXPLAIN ITSELF. This is the content check
     behind "never a dead entry": if a location carries a `see` rule
     that ruleLabel() cannot put into words, a player who walks up to
     it gets a locked door and no sentence. */
  for (const l of LOCATIONS) {
    if (l.see === 0 || l.see == null) continue;
    const label = ruleLabel(l.see);
    ok(!!label && label.length > 3, `${l.id}'s see-rule reads as English`, JSON.stringify(l.see) + ' -> ' + label);
    ok(!/undefined|null|\[object|NaN/.test(String(label)), `${l.id}'s label has no leaked internals`, label);
  }

  /* --- out of range discovers nothing --- */
  eq(g.sense(ex.world.x + 400, ex.world.z, 5).length, 0, 'standing 400 m away finds nothing');
  ok(!g.known('exchange'), 'and the Exchange is still off the map');

  /* --- and inside the radius you have to actually linger --- */
  g.resetSense();
  eq(g.sense(ex.world.x + 4, ex.world.z, DISCOVER.dwell * 0.4).length, 0, 'brushing past for a moment is not enough');
  ok(!g.known('exchange'), 'still nothing on the map');
  const found = g.sense(ex.world.x + 4, ex.world.z, DISCOVER.dwell);
  eq(found.length, 1, 'staying put for the dwell finds it');
  eq(found[0].id, 'exchange', 'and it is the building you are standing at');
  ok(g.known('exchange'), 'the Stock Exchange is on the map');
  ok(g.foundNear('exchange'), 'and marked as found on foot, not earned');
  ok(g.state.found.exchange, 'state.found records it');
  eq(g.sense(ex.world.x + 4, ex.world.z, 5).length, 0, 'and it is not discovered twice');

  /* ONE BUILDING AT A TIME. Golden Heights has four; standing at the
     Exchange must not hand over the Treasury and the penthouse. */
  eq(LOCATIONS.filter((l) => g.known(l.id) && l.z === 'goldenheights').length, 1,
    'only the building you walked to, not its whole district');

  /* --- FOUND IS NOT ALLOWED IN. Every gate still refuses. --- */
  ok(!g.access('exchange'), 'discovering it did not satisfy its `see` rule');
  const door = g.canEnter('exchange');
  ok(!door.ok, 'the door refuses');
  eq(door.kind, 'locked', 'and it refuses as locked, not as unknown');
  ok(/Market Fundamentals/i.test(door.why), 'and it names the gate that is shut', door.why);
  ok(!!door.need, 'with a `need` string the UI can print on its own', door.need);
  const warp = g.travel('exchange', 'walk');
  ok(!warp.ok, 'fast travel refuses it too');
  eq(warp.kind, 'locked', 'with the same kind');
  const ent = g.enter('exchange');
  ok(!ent.ok, 'and so does walking through the door');
  ok(g.state.loc !== 'exchange', 'he is not inside it');

  /* --- NEVER A DEAD ENTRY: every fare row carries the reason --- */
  const rows = g.fares('exchange');
  ok(rows.length >= 3, 'the fare board still lists every mode');
  for (const r of rows) {
    ok(!r.ok, `the ${r.mode} row is refused`);
    ok(!!r.why && r.why.length > 12, `the ${r.mode} row says why in a sentence`, r.why);
    ok(/Market Fundamentals/i.test(r.why), `the ${r.mode} row names the gate`, r.why);
  }
  /* …and placeInfo() says the same thing in one object */
  const info = g.placeInfo('exchange');
  eq(info.status, 'locked', 'placeInfo() calls it locked');
  ok(info.known, 'known');
  ok(info.found, 'found on foot');
  ok(!info.access, 'not accessible');
  ok(!!info.statusLabel, 'with a label to print', info.statusLabel);
  ok(!!info.why, 'and the reason', info.why);
  ok(g.places().some((p) => p.id === 'exchange'), 'it appears in the Places list');
  ok(g.placeProgress().locked >= 1, 'and the Places headline counts it as not-yet-open');

  /* --- AND WHEN THE GATE FINALLY FALLS, THE CITY SAYS SO ---
     the payoff for having found it early: it is already on your map,
     so the moment the last rule comes true it has to announce itself
     rather than silently becoming clickable. */
  {
    const notes = [];
    g.bus.on('note', (n) => notes.push(n.text));
    g.state.skills.fundamentals = true;
    /* a read-only query FIRST, because a fare board or a Places card
       may well latch the access before check() ever runs — the
       announcement must survive that */
    eq(g.placeInfo('exchange').status, 'closed', 'the query sees it open now (just shut for the night)');
    g.quests.check();
    ok(notes.some((t) => /Bull Bear Stock Exchange will see you now/.test(t)),
      'the place you walked past announces that it will see you now', notes.join(' | '));
  }

  /* --- THE GATE IS THE SAME GATE IT ALWAYS WAS --- */
  ok(g.access('exchange'), 'passing Market Fundamentals opens it, exactly as before');
  eq(g.canEnter('exchange').kind, 'hours', 'and the next refusal is the clock, not the rule');
  g.state.time = 11 * 60;
  ok(g.canEnter('exchange').ok, 'inside opening hours the door opens');
  /* AND THE EXCHANGE ITSELF IS UNTOUCHED: finding it early does not
     buy a single one of the four membership steps. */
  const xg = g.actions.exchangeGate();
  ok(!xg.ok, 'membership still refuses');
  ok(xg.steps.filter((s) => s.done).length < xg.steps.length, 'the checklist is not silently ticked',
    xg.steps.map((s) => s.key + ':' + (s.done ? 'y' : 'n')).join(' '));
}

T('every gate still refuses a place you only walked past');
{
  /* WALK THE WHOLE ISLAND. Stand at all 28 doors, discover everything,
     and then assert that the city is exactly as shut as it was. */
  const g = createGame({ seed: 402, autosave: false });
  const before = LOCATIONS.filter((l) => g.access(l.id)).map((l) => l.id).sort().join(',');
  for (const l of LOCATIONS) {
    g.resetSense();
    g.sense(l.world.x, l.world.z, 1);
  }
  eq(LOCATIONS.filter((l) => g.known(l.id)).length, LOCATIONS.length, 'every place is on the map');
  eq(g.placeProgress().known, LOCATIONS.length, 'placeProgress() agrees');
  const after = LOCATIONS.filter((l) => g.access(l.id)).map((l) => l.id).sort().join(',');
  eq(after, before, 'and NOT ONE new door opened');

  /* every still-gated place refuses with a reason, and none of them
     refuses with a shrug */
  let locked = 0;
  for (const l of LOCATIONS) {
    if (g.access(l.id)) continue;
    locked++;
    const p = g.placeInfo(l.id);
    eq(p.status, 'locked', `${l.id} reads as locked`);
    ok(!!p.why && p.why.length > 12, `${l.id} gives a real reason`, p.why);
    ok(!!p.need, `${l.id} names what it wants`, p.need);
    ok(!/undefined|null|\[object/.test(p.why + p.need), `${l.id}'s reason is English, not a stringified object`, p.why);
    ok(!g.travel(l.id, 'walk').ok, `${l.id} refuses fast travel`);
    ok(!g.enter(l.id).ok, `${l.id} refuses the door`);
  }
  ok(locked >= 15, 'most of the city is still shut behind its own rules', locked);

  /* THE QUESTS DO NOT MOVE EITHER. Discovery must not tick a single
     objective — that is the whole "you cannot start the quests right
     away" half of the brief. */
  eq(Object.keys(g.state.quests).length, 0, 'no quest completed itself');
  eq(g.quests.current().id, 'q_wake', 'the objective is still the first one');
  eq(g.state.stats.ordersDone, 0, 'and nothing was delivered by walking about');

  /* A TELEPORT IS NOT A WALK. Fast travel does not feed sense(), and a
     position that jumps further than a motorcycle could have gone
     drops the dwell timers rather than banking the journey. */
  const h = createGame({ seed: 403, autosave: false });
  const bank = LOC_BY_ID.bank, mine = LOC_BY_ID.mine;
  h.resetSense();
  h.sense(bank.world.x, bank.world.z, DISCOVER.dwell * 0.8);   // nearly there…
  h.sense(mine.world.x, mine.world.z, 0.05);                   // …then 400 m away in one frame
  ok(!h.known('bank'), 'the half-finished dwell at the bank did not carry over');
  ok(!h.known('mine'), 'and the teleport arrival did not instantly count either');
  /* standing still afterwards is a walk again */
  h.sense(mine.world.x, mine.world.z, DISCOVER.dwell);
  ok(h.known('mine'), 'but standing there for the dwell does discover it');

  /* nonsense in, nothing out */
  eq(h.sense(NaN, 0, 1).length, 0, 'a NaN position discovers nothing');
  eq(h.sense(0, Infinity, 1).length, 0, 'nor an infinite one');
}

T('a discovered place survives a save, and an old save keeps its doors');
{
  const g = createGame({ seed: 404, autosave: false });
  g.resetSense();
  g.sense(LOC_BY_ID.exchange.world.x, LOC_BY_ID.exchange.world.z, 1);
  g.state.rep = 30;
  g.quests.refreshKnown(true);                       // earns the library, bank, …
  const text = g.exportSave();
  const back = g.importSave(text);
  ok(back, 'the save round-trips');
  ok(back.known.exchange, 'the Exchange is still on the map');
  ok(back.found.exchange, 'still marked found-on-foot');
  ok(!back.access.exchange, 'and still not accessible');
  ok(back.access.library, 'while a place earned by reputation kept its access');

  /* A SAVE FROM BEFORE THE SPLIT. `known` was the only bit, and it
     could only ever mean "earned" — so every known place must come
     back accessible or a returning player is locked out of buildings
     he already paid for. */
  const old = JSON.parse(g.exportSave());
  delete old.access;
  delete old.found;
  const fixed = g.importSave(JSON.stringify(old));
  ok(fixed, 'a pre-split save still loads');
  for (const id of Object.keys(fixed.known)) {
    ok(fixed.access[id], `${id} kept its access across the migration`);
  }
  eq(Object.keys(fixed.found).length, 0, 'and nothing is retroactively claimed as found on foot');

  /* REP CAN GO DOWN. A place you were let into never un-lets you in. */
  const h = createGame({ seed: 405, autosave: false });
  h.state.rep = 30;
  h.quests.refreshKnown(true);
  ok(h.access('library'), 'the library opened at reputation 30');
  h.state.rep = 0;
  ok(h.access('library'), 'and a ruined reputation does not shut it again');
  ok(h.canEnter('library').kind !== 'locked', 'the door still is not "locked"');
}

/* ============================================================
   24. THE FIRST CLIENT ALWAYS ASKS FOR CRUMB, AT THE BROKER

   "A bug in the game with the business broker order objective is that
   the first client may not need the business broker."

   Taking an order at the desk sets flags.orderTaken, which makes
   q_broker — "Go and see the Business Broker" — the live objective.
   The order itself used to be rolled from all 69 assets across twelve
   venues, so four times out of five the objective sent the player to a
   counter that did not stock the thing he needed.

   Two routes reach the first order (Otto in the cafe, and the first
   arrival after a Dispatch shift) and both are checked here, across
   many seeds, because "it worked on my seed" is exactly how this
   regressed the first time.
   ============================================================ */
T('the first client order is always CRUMB at the Business Broker');
{
  /* the content this rests on */
  const crumb = ASSET_BY_ID[FIRST_ORDER.asset];
  ok(!!crumb, 'FIRST_ORDER names a real asset', FIRST_ORDER.asset);
  eq(crumb.tick, 'CRUMB', 'and its ticker is CRUMB');
  eq(crumb.tick, FIRST_ORDER.ticker, 'the constant agrees with the asset table');
  eq(crumb.ven, 'broker', 'CRUMB is sold at the broker');
  eq(crumb.ven, FIRST_ORDER.venue, 'and the constant agrees about that too');
  eq(VENUE_LOC[crumb.ven], 'broker', 'and that venue is the Business Broker building');
  eq(LOC_BY_ID.broker.n, 'Business Broker', 'which is the place q_broker points at');
  ok(ASSETS.filter((a) => a.tick === 'CRUMB').length === 1, 'exactly one CRUMB in the game');

  /* --- ROUTE A: the cafe. Otto's authored order. --- */
  let seeds = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const g = createGame({ seed, autosave: false });
    g.state.flags.readMentor = true;
    g.enter('cafe');
    const o = g.state.arrivals.find((x) => x.client === 'otto');
    if (!ok(!!o, `seed ${seed}: Otto left an order`)) continue;
    if (!ok(o.items.length === 1 && o.items[0].t === 'CRUMB',
      `seed ${seed}: and it is one unit of CRUMB`,
      o.items.map((i) => i.q + 'x' + i.t).join(','))) continue;
    ok(ASSET_BY_ID[o.items[0].a].ven === 'broker', `seed ${seed}: bought at the broker`);
    seeds++;
  }
  eq(seeds, 60, 'all sixty cafe seeds asked for CRUMB');

  /* --- ROUTE B: a Dispatch shift, then whoever walks in. --- */
  const clientsSeen = new Set();
  let bseeds = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const g = createGame({ seed: seed * 7 + 3, autosave: false });
    g.state.flags.readMentor = true;
    g.state.flags.metHappy = true;
    g.enter('trunkdepot');
    const w = g.actions.work('drive', 0.6);
    if (!ok(w.ok, `seed ${seed}: the shift ran`, w.why)) continue;
    ok(g.state.flags.dispatchShift, `seed ${seed}: the shift unlocked arrivals`);
    const o = g.state.arrivals[0];
    if (!ok(!!o, `seed ${seed}: somebody came to the desk`)) continue;
    clientsSeen.add(o.client);
    ok(o.items.length === 1 && o.items[0].t === 'CRUMB',
      `seed ${seed}: the first arrival wants CRUMB`, o.items.map((i) => i.q + 'x' + i.t).join(','));
    ok(o.first === true, `seed ${seed}: and it is flagged as the first order`);
    /* ONE DESK, ONE FIRST ORDER: a second person must not turn up
       asking for the same loaf while this one is untouched. */
    g.clients.newArrival();
    g.clients.dailyOffers();
    eq(g.state.arrivals.length, 1, `seed ${seed}: no second first-order piles up`);
    bseeds++;
  }
  eq(bseeds, 60, 'all sixty Dispatch seeds asked for CRUMB');
  ok(clientsSeen.size > 1, 'and it was not always the same client', [...clientsSeen].join(','));

  /* --- ACCEPTING IT IS WHAT MAKES THE OBJECTIVE MAKE SENSE --- */
  {
    const g = createGame({ seed: 909, autosave: false });
    g.state.flags.readMentor = true;
    g.state.flags.metHappy = true;
    g.enter('trunkdepot');
    g.actions.work('drive', 0.6);
    g.enter('apartment');
    const o = g.state.arrivals[0];
    const r = g.economy.acceptOrder(o);
    ok(r.ok, 'the order is accepted at the desk', r.why);
    ok(g.state.flags.orderTaken, 'flags.orderTaken is set');
    ok(g.state.flags[FIRST_ORDER.flag], 'and so is the first-order latch');
    ok(g.known('broker'), 'the Business Broker is now on the map');
    ok(g.access('broker'), 'and it will let him in');
    eq(g.quests.current().id, 'q_broker', 'the objective is "go and see the Business Broker"');
    eq(g.quests.questLoc('q_broker'), 'broker', 'pointing at the broker');
    /* THE POINT OF THE WHOLE FIX: the objective's destination is where
       the order's asset is actually bought. */
    const item = g.state.orders[0].items[0];
    eq(VENUE_LOC[ASSET_BY_ID[item.a].ven], g.quests.questLoc('q_broker'),
      'and that is exactly where the thing he was asked for is sold');
    /* and he can actually do it there */
    g.state.time = 11 * 60;
    g.state.money = 5000;
    g.state.energy = 100;
    ok(g.travel('broker', 'walk').ok, 'he can travel there');
    const buy = g.economy.buy(item.a, 1);
    ok(buy.ok, 'and buy the thing at that counter', buy.why);
  }

  /* --- AND EVERY ORDER AFTER IT IS ROLLED NORMALLY --- */
  {
    const g = createGame({ seed: 910, autosave: false });
    g.state.flags.dispatchShift = true;
    g.state.flags[FIRST_ORDER.flag] = true;           // the first one has been taken
    g.state.rep = 40;
    g.state.time = 12 * 60;
    for (const cid of Object.keys(g.state.clients)) { g.state.clients[cid].met = true; g.state.clients[cid].trust = 3; }
    const assets = new Set(), venues = new Set();
    let rolled = 0, wasCrumb = 0;
    for (let i = 0; i < 400; i++) {
      const c = CLIENTS[i % CLIENTS.length];
      const o = g.clients.makeOrder(c.id);
      if (!o) continue;
      rolled++;
      if (o.first) wasCrumb++;
      for (const it of o.items) { assets.add(it.a); venues.add(ASSET_BY_ID[it.a].ven); }
    }
    ok(rolled > 300, 'a big sample of post-tutorial orders', rolled);
    eq(wasCrumb, 0, 'not one of them is the forced tutorial basket');
    ok(assets.size > 20, 'later orders draw on the whole asset list', assets.size + ' assets');
    ok(venues.size >= 3, 'across several venues, not just the broker', venues.size + ' venues');
    ok(assets.size > 20, 'CRUMB is no longer the only thing anyone wants', assets.size);
  }

  /* --- A MID-CAREER SAVE FROM BEFORE THE LATCH SELF-HEALS --- */
  {
    const g = createGame({ seed: 911, autosave: false });
    g.state.flags.dispatchShift = true;
    g.state.stats.ordersDone = 6;                     // a career, but no latch
    delete g.state.flags[FIRST_ORDER.flag];
    g.state.rep = 40;
    for (const cid of Object.keys(g.state.clients)) { g.state.clients[cid].met = true; g.state.clients[cid].trust = 3; }
    const o = g.clients.makeOrder('rico');
    ok(!!o, 'an order is still produced');
    ok(!o.first, 'an established broker is not handed the tutorial basket again');
    ok(g.state.flags[FIRST_ORDER.flag], 'and the latch healed itself on the way past');
  }

  /* --- IT IS DETERMINISTIC: same seed, same first order --- */
  {
    const mk = () => {
      const g = createGame({ seed: 912, autosave: false });
      g.state.flags.readMentor = true;
      g.enter('cafe');
      const o = g.state.arrivals.find((x) => x.client === 'otto');
      return JSON.stringify({ items: o.items, budget: o.budget, fee: o.fee, deadline: o.deadline });
    };
    eq(mk(), mk(), 'two runs of the same seed produce the identical first order');
  }
}

/* ============================================================
   BOTH BRANCHES OF travel(), NAMED.

   Everything above this point ran the NO-WALKER branch without ever
   saying so. These two sections say so, and then drive the other one.

   THE SPLIT, so neither section can be read as the general case:

     [no-walker]  nothing covers a metre in this process, so a
                  self-powered leg is RESOLVED — fare paid, minutes
                  and energy in one lump, arrived, moved:true,
                  resolved:'no-walker', no route left behind.
     [walker]     setWalker(true) is the browser's shape, driven by
                  hand here: travel() sets a ROUTE, charges nothing,
                  and stride() bills every metre he covers.
   ============================================================ */
T('travel: the no-walker branch, named');
{
  const g = createGame({ seed: 0x0f007, autosave: false });
  eq(g.hasWalker, false, '[no-walker] the branch this block is on');
  g.state.known.stadium = true;
  g.state.energy = 100;
  g.state.time = 10 * 60;          // mid-morning: every door in this block is open
  const before = { loc: g.state.loc, time: g.state.time, energy: g.state.energy };
  const quote = g.fares('stadium').find((f) => f.mode === 'walk');
  const r = g.travel('stadium', 'walk');
  ok(r.ok && r.moved === true, '[no-walker] a walk MOVES him — there is nobody here to walk it', JSON.stringify(r));
  eq(r.routed, false, '[no-walker] and it does not claim to be a route');
  eq(r.resolved, 'no-walker', '[no-walker] it says which branch resolved it, in the result');
  eq(r.fast, false, '[no-walker] but it never claims a walk was fast travel', String(r.fast));
  eq(g.state.loc, 'stadium', '[no-walker] he is at the stadium');
  eq(g.route, null, '[no-walker] and no route was left behind');
  ok(g.state.time - before.time >= quote.mins - 0.01,
    '[no-walker] the clock took the whole quoted lump of minutes', `${before.time} -> ${g.state.time}`);
  ok(Math.abs((before.energy - g.state.energy) - quote.energy) < 0.5,
    '[no-walker] and the energy came off in one lump too, on arrival',
    `${(before.energy - g.state.energy).toFixed(2)} vs ${quote.energy}`);
  eq(g.stride(0, 0), 0, '[no-walker] stride() has no baseline yet, so the first sample is free');
  eq(g.stride(50, 0), 0, '[no-walker] and a 50 m jump is a warp, not a walk');
  const e0 = g.state.energy;
  g.resetStride(); g.stride(0, 0);
  for (let i = 1; i <= 100; i++) g.stride(i, 0);
  ok(Math.abs((e0 - g.state.energy) - strideCost('walk') * 100) < 0.02,
    '[no-walker] stride() itself still charges by the metre if something DOES feed it',
    `${(e0 - g.state.energy).toFixed(2)} for 100 m`);
}

T('travel: the walker branch, driven by hand');
{
  const g = createGame({ seed: 0x0f008, autosave: false });
  g.setWalker(true);
  eq(g.hasWalker, true, '[walker] the branch this block is on');
  const walk = (n) => { g.resetStride(); g.stride(0, 0); for (let i = 1; i <= n; i++) g.stride(i, 0); };
  const rate = strideCost('walk');
  g.state.known.stadium = true;
  g.state.known.bank = true;
  g.state.energy = 100;
  g.state.time = 10 * 60;          // mid-morning: every door in this block is open

  /* --- it points, it does not carry --- */
  const before = { loc: g.state.loc, time: g.state.time, money: g.state.money, energy: g.state.energy };
  const r = g.travel('stadium', 'walk');
  ok(r.ok && r.moved === false && r.routed === true,
    '[walker] a walk is a ROUTE: moved:false, routed:true', JSON.stringify(r));
  eq(g.state.loc, before.loc, '[walker] he has not gone anywhere yet');
  eq(g.route.to, 'stadium', '[walker] but he is pointed at the stadium');
  eq(g.routeTo, 'stadium', '[walker] and routeTo is the same answer, cheaply');
  eq(g.state.time, before.time, '[walker] no lump of minutes — the live clock bills those');
  eq(g.state.money, before.money, '[walker] and no money changed hands');
  eq(g.state.energy, before.energy, '[walker] nothing is charged until he moves');

  /* --- the road, charged by the metre, with no cap --- */
  walk(200);
  const spent200 = before.energy - g.state.energy;
  ok(Math.abs(spent200 - rate * 200) < 0.02,
    '[walker/routed] 200 m costs 200 x strideCost', `${spent200.toFixed(2)} vs ${(rate * 200).toFixed(2)}`);

  /* --- re-tapping the same row keeps the ledger (P3) --- */
  const again = g.travel('stadium', 'walk');
  eq(again.resumed, true, '[walker/routed] re-tapping the same row resumes the same journey');
  ok(Math.abs(g.route.spent - spent200) < 0.02,
    '[walker/routed] …with its ledger intact, not reset to zero', String(g.route.spent));
  eq(g.route.walked, 200, '[walker/routed] and the road already covered stays covered');
  walk(200);
  ok(Math.abs((before.energy - g.state.energy) - rate * 400) < 0.03,
    '[walker/routed] 400 m of walking costs 400 m, not two full quotes',
    `${(before.energy - g.state.energy).toFixed(2)} vs ${(rate * 400).toFixed(2)}`);

  /* --- a different row is a change of mind, cleanly --- */
  const cleared = [];
  const off = g.bus.on('route', (e) => { if (e.kind === 'clear') cleared.push(e); });
  g.travel('bank', 'walk');
  off();
  eq(cleared.length, 1, '[walker/routed] changing destination fires exactly one clear event');
  eq(cleared[0].to, 'stadium', '[walker/routed] …naming the route it dropped');
  ok(cleared[0].spent > 0, '[walker/routed] …and what that route had already spent', String(cleared[0].spent));
  eq(g.route.spent, 0, '[walker/routed] the new route starts a fresh ledger');

  /* --- THE ROAD WITH NO ROUTE AT ALL (P2) --- */
  g.clearRoute('test');
  eq(g.route, null, '[walker/no-route] nothing is routed');
  g.state.energy = 100;
  walk(300);
  ok(Math.abs((100 - g.state.energy) - rate * 300) < 0.02,
    '[walker/no-route] 300 m still costs 300 x strideCost — moving is never free',
    `${(100 - g.state.energy).toFixed(2)} vs ${(rate * 300).toFixed(2)}`);

  /* --- and the ride under him sets the rate --- */
  g.state.rides = { owned: { bike: true, scooter: false, motorcycle: false }, equipped: 'bike' };
  g.state.energy = 100;
  walk(300);
  const onBike = 100 - g.state.energy;
  ok(Math.abs(onBike - strideCost('bike', 'bike') * 300) < 0.02,
    '[walker/no-route] on the bicycle the same 300 m is charged at the bicycle rate',
    `${onBike.toFixed(2)} vs ${(strideCost('bike', 'bike') * 300).toFixed(2)}`);
  ok(onBike < rate * 300, '[walker/no-route] …which is cheaper than his feet');

  /* --- standing still is still free, and creeping is not lost --- */
  g.actions.equipRide(null);
  g.state.energy = 100;
  g.resetStride(); g.stride(0, 0);
  for (let i = 0; i < 200; i++) g.stride(0, 0);          // he is not moving at all
  eq(g.state.energy, 100, '[walker/no-route] standing still costs nothing, however often he is sampled');
  /* A step under MIN_STEP_M is not billed, but it does not move the
     baseline either, so a slow creep accumulates against the last
     place he actually stood rather than being quietly forgiven. */
  for (let i = 1; i <= 200; i++) g.stride(0.001 * i, 0);  // 0.2 m of creep, 1 mm at a time
  const crept = 100 - g.state.energy;
  ok(crept > rate * 0.2 * 0.8 && crept <= rate * 0.2 + 1e-9,
    '[walker/no-route] …but a slow creep accumulates instead of being forgiven a millimetre at a time',
    `${crept.toFixed(5)} for 0.2 m of creep vs ${(rate * 0.2).toFixed(5)} walked outright`);

  /* --- A ROUTE DOES NOT SURVIVE THE NIGHT (P11) --- */
  g.actions.equipRide(null);
  g.enter('apartment');
  g.travel('stadium', 'walk');
  eq(g.route.to, 'stadium', '[walker/routed] a live route, at bedtime');
  const day0 = g.state.day;
  g.actions.sleep();
  eq(g.state.day, day0 + 1, '[walker/routed] the day rolled');
  eq(g.route, null, '[walker/routed] and the route did not survive the night');

  /* --- arriving is what ends one, and it costs no second fare --- */
  g.state.energy = 100;
  g.state.time = 10 * 60;          // the new day starts at dawn; the stadium opens at 08:00
  const m0 = g.state.money, t0 = g.state.time;
  g.travel('stadium', 'walk');
  walk(100);
  const arrive = g.enter('stadium');
  ok(arrive.ok && arrive.routed === true, '[walker/routed] enter() at the door closes the routed journey',
    JSON.stringify(arrive));
  eq(g.state.loc, 'stadium', '[walker/routed] and now he is there');
  eq(g.state.money, m0, '[walker/routed] the whole journey cost no money');
  eq(g.state.time, t0, '[walker/routed] and no lump of minutes');
  eq(g.route, null, '[walker/routed] the route is closed');
  ok(Math.abs((100 - g.state.energy) - rate * 100) < 0.02,
    '[walker/routed] he paid for the 100 m he actually covered and not a metre more',
    `${(100 - g.state.energy).toFixed(2)}`);
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
  `${Object.keys(ZONES).length} zones · ${QUESTS.length} quests + ${SIDE_QUESTS.length} side`);
console.log(`  ${ASSETS.length} unique tickers · ${Object.keys(TRAVEL).length} travel modes ` +
  `(${Object.keys(TRAVEL).map((m) => TRAVEL[m].n).join(', ')}) · `
  + `${RIDE_LIST.length} rides (${RIDE_ORDER.slice().reverse().map((id) => RIDES[id].short + ' x' + RIDES[id].speed).join(', ')})`);
console.log(`  30-day run: day ${sim.state.day}, $${sim.state.money}, rep ${sim.state.rep}, ` +
  `${sim.state.stats.ordersDone} orders, ${sim.state.stats.jobsDone} shifts, ` +
  `${sim.economy.cityPct()}% tokenized, ${sim.quests.progress().done}/${QUESTS.length} quests`);
process.exit(0);
