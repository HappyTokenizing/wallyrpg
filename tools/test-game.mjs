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
   quest that must never touch the main objective); THE BICYCLE
   (gated on purchase and on being equipped); the guarantee that a
   broke, exhausted player is never hard-locked; refusals; and the
   world queries the 3D builder needs.

   Exits non-zero on the first hard failure summary.
   ============================================================ */

import DATA, {
  CONFIG, CATEGORIES, ASSETS, ASSET_BY_ID, ASSET_BY_TICK, VENUES, VENUE_LOC,
  CLIENTS, CLIENT_BY_ID, COURSES, COURSE_BY_ID, OFFICE_STAGES,
  HOMES, HOME_BY_ID, ZONES, LOCATIONS, LOC_BY_ID, WORLD, MAP,
  TRAVEL, BIKE, JOBS, EMPLOYEE_POOL, IPOS, IPO_STEPS, STADIUM_STEPS,
  NEWS_POOL, QUESTS, SIDE_QUESTS, MILESTONES, TIPS, MORNING_NOTES,
  OPENING_MESSAGE, byTicker, assetLabel, searchAssets, normTicker,
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
  'an Uber beats the bicycle on time');
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
  eq(TRAVEL.trunk.n, 'Uber', "'trunk' displays as Uber");

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
  ok(m5.cost < u5.cost * 0.2, 'and a small fraction of an Uber', `${m5.cost} vs ${u5.cost}`);
  ok(m1.energy > w1.energy, 'one Metro stop is more tiring than walking it', `${m1.energy}e vs ${w1.energy}e`);
  ok(m5.energy / m5.mins > w5.energy / w5.mins * 1.5,
    'per minute, the Metro is far more draining than walking',
    `${(m5.energy / m5.mins).toFixed(2)} vs ${(w5.energy / w5.mins).toFixed(2)} e/min`);
  ok(m5.mins < w5.mins * 0.5, 'but it buys back most of the day', `${m5.mins}m vs ${w5.mins}m`);

  /* UBER — very little energy, expensive, and sharply distance-priced. */
  ok(u1.energy <= 0.5, 'an Uber costs almost no energy', u1.energy);
  ok(u5.energy < m5.energy * 0.1, 'a fraction of the Metro', `${u5.energy} vs ${m5.energy}`);
  ok(u1.cost >= 20, 'an Uber is never cheap, even for one hop', u1.cost);
  ok(u5.cost / u1.cost > 3, 'a five-hop Uber is more than triple a one-hop Uber',
    `1 hop $${u1.cost}, 5 hops $${u5.cost}`);
  /* CONVEX IN DISTANCE. The user asked for a fare that varies with
     distance more sharply than the old flat 9 + 7·h. Convexity is the
     property that makes a long Uber hurt: each additional hop costs
     MORE than the one before it. Measured on the hop counts directly,
     not on a pair of locations, so it is the pricing rule under test. */
  const uc = (h) => TRAVEL.trunk.base + TRAVEL.trunk.per * h + TRAVEL.trunk.surge * h * h;
  const d1 = uc(2) - uc(1), d4 = uc(5) - uc(4);
  ok(d4 > d1, 'each extra hop in an Uber costs more than the last',
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
         that used to mean an Uber every single day, which at the new
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

/* --- the opening, as it actually played out over thirty days --- */
ok(boughtBike, 'the bot bought a bicycle');
ok(sim.state.bike.owned && sim.state.bike.equipped, 'and it is owned and equipped in the save');
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

  const w = g.actions.work('drive', 0.8);
  ok(w.ok, 'a shift at Dispatch can be worked on day one', w.why);
  ok(g.state.flags.dispatchShift, 'it sets flags.dispatchShift');
  ok(beats.includes('dispatch'), "and emits {beat:'dispatch'}");
  ok(g.clients.ordersUnlocked(), 'which unlocks client orders');
  ok(g.state.arrivals.length >= 1, 'and puts somebody on the desk', g.state.arrivals.length);
  ok(g.state.quests.q_first_job, 'the objective closed');
  eq(g.quests.current().id, 'q_first_client', 'and the next one is the first client order');

  /* --- b. the cafe: a SIDE quest, alongside the main chain --- */
  const mainBefore = g.quests.current().id;
  eq(g.quests.sideCurrent(), null, 'no side quest is running yet');
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
    /* A FRIEND'S FIRST ORDER MUST BE AFFORDABLE. Rolled normally,
       Otto's ceiling reaches a $480 gallery collection on day one —
       which a player holding $250 and one shift's pay cannot buy. */
    const oo = g.state.arrivals.find((x) => x.client === 'otto');
    eq(oo.items.length, 1, 'it is one thing, not a basket');
    eq(oo.items[0].q, 1, 'and one of it');
    const outlay = g.economy.buyPrice(oo.items[0].a);
    ok(outlay <= CONFIG.startMoney + 130, 'and it is buyable on day one money',
      `$${outlay} vs $${CONFIG.startMoney} + a shift`);
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
  g.economy.acceptOrder(o);
  for (const it of o.items) g.economy.buy(it.a, it.q);
  g.travel(g.officeLoc(), 'walk');
  const del = g.actions.deliver(o);
  ok(del.ok, "Otto's order can be delivered", del.why);
  ok(sideEvents.includes('side:complete:q_side_otto'), 'the side quest completed', sideEvents.join(','));
  eq(g.quests.sideStatus('q_side_otto'), 'done', 'state.sides records it as done');
  eq(g.quests.sideCurrent(), null, 'and it leaves the active slot');
  eq(g.quests.sideProgress().done, 1, 'sideProgress counts it');
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

T('a broke, exhausted player is never hard-locked');
{
  /* THE FLOOR. No money, no bicycle, no energy, the small hours so the
     Metro is not running: walking must still be offered, from every
     location the player knows to every other one. Otherwise the game
     ends without saying so. */
  const g = createGame({ seed: 31, autosave: false });
  g.state.money = 0;
  g.state.energy = 0;
  g.state.time = 3 * 60;                 // 03:00 — no Metro
  for (const l of LOCATIONS) g.state.known[l.id] = true;

  let stuck = [];
  for (const l of LOCATIONS) {
    if (l.id === g.state.loc) continue;
    const opts = g.fares(l.id);
    if (!opts.some((o) => o.ok)) stuck.push(l.id);
    const walk = opts.find((o) => o.mode === 'walk');
    if (!walk || !walk.ok) stuck.push(l.id + ':walk');
  }
  eq(stuck.length, 0, 'with $0 and 0 energy at 03:00, every known place is still reachable on foot',
    stuck.slice(0, 4).join(', '));

  const far = g.fares('exchange').find((o) => o.mode === 'walk');
  ok(far.trudge, 'setting off on empty is flagged as a trudge');
  ok(typeof far.warn === 'string' && far.warn.length > 0, 'with a warning the UI can show', far.warn);
  ok(far.mins > fare('walk', g.state.loc, 'exchange').mins, 'and it takes longer than a fresh walk',
    `${far.mins}m vs ${fare('walk', g.state.loc, 'exchange').mins}m`);
  ok(!g.fares('exchange').find((o) => o.mode === 'train').ok, 'the Metro is genuinely shut at 03:00');
  ok(!g.fares('exchange').find((o) => o.mode === 'trunk').ok, 'and an Uber is genuinely unaffordable');

  const t = g.travel('exchange', 'walk');
  ok(t.ok, 'he walks it anyway', t.why);
  eq(g.state.loc, 'exchange', 'and he gets there');
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
  `(${Object.keys(TRAVEL).map((m) => TRAVEL[m].n).join(', ')}) · bicycle $${BIKE.cost}`);
console.log(`  30-day run: day ${sim.state.day}, $${sim.state.money}, rep ${sim.state.rep}, ` +
  `${sim.state.stats.ordersDone} orders, ${sim.state.stats.jobsDone} shifts, ` +
  `${sim.economy.cityPct()}% tokenized, ${sim.quests.progress().done}/${QUESTS.length} quests`);
process.exit(0);
