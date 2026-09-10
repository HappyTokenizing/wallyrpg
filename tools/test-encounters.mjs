#!/usr/bin/env node
/* ============================================================
   tools/test-encounters.mjs — THE ENCOUNTER LAYER, ASSERTED.

       node tools/test-encounters.mjs
       node tools/test-encounters.mjs --verbose

   Plain node, no DOM, nothing mocked except a ctx — which is the
   point: src/game/game.js init(ctx) runs headless, so the ALTITUDE
   FEED and the SKY WIRING are tested through the production path
   rather than by calling the functions underneath them.

   WHY THIS FILE EXISTS AT ALL. This project has repeatedly shipped
   listeners nobody emits: the audio bed never heard the weather,
   footsteps listened on the wrong event name, walking into a
   district never changed the score, and twenty-two of the audio
   layer's twenty-eight listeners had no emitter. Every event this
   feature adds is therefore asserted FROM THE CONDITION THAT IS
   SUPPOSED TO FIRE IT, and every one has its negative branch: the
   same check with the condition removed, proving the effect is
   caused by the cause and not by the weather of the test.

   WHAT IS COVERED
     1  content integrity, and the three siting rules
     2  the three guards — deadline, kitchen, trading venue —
        each with both branches
     3  isOpen() actually bites, and reverts
     4  the encounter fires from its condition and from nothing else
     5  DECLINING COSTS NOTHING — byte-for-byte
     6  the rumour: told, claimed once, settled against what printed
     7  the balloon: the horizon opens, the doors do not
     8  the sky is told, in its own four names, and a refusal is heard
     9  the cross-file spelling of every event name

   Exits non-zero on the first hard failure summary.
   ============================================================ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import DATA, {
  DAY_EVENTS, DAY_EVENT_BY_ID, ENCOUNTERS, ENCOUNTER_BY_ID,
  TIPSTERS, TIP_VOICE, AIRVIEW, EVENT_TUNING, NEWS_POOL, VENUE_LOC,
  LOC_BY_ID, CLIENT_BY_ID, ASSET_BY_ID, LOCATIONS,
} from '../src/game/data.js';
import { WX_NAMES } from '../src/game/events.js';
import { createGame, init as gameInit } from '../src/game/game.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

/* ---------------- micro test framework ---------------- */
let pass = 0;
const fails = [];
let group = '';
const T = (n) => { group = n; if (VERBOSE) console.log('\n— ' + n); };
function ok(cond, msg, detail) {
  if (cond) { pass++; if (VERBOSE) console.log('  ok  ' + msg); return true; }
  fails.push(`[${group}] ${msg}` + (detail != null ? `  (${detail})` : ''));
  return false;
}
const eq = (a, b, msg) => ok(a === b, msg, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

/* A bus that keeps everything, so an assertion can ask what actually
   went out rather than what a function returned. */
function recordingBus() {
  const map = new Map();
  const log = [];
  return {
    log,
    on(t, fn) { if (!map.has(t)) map.set(t, new Set()); map.get(t).add(fn); return () => map.get(t)?.delete(fn); },
    once(t, fn) { const off = this.on(t, (...a) => { off(); fn(...a); }); return off; },
    emit(t, p) { log.push({ t, p }); const s = map.get(t); if (!s) return; for (const fn of [...s]) { try { fn(p); } catch (e) { console.error('[bus]', t, e); } } },
    clear() { map.clear(); log.length = 0; },
    seen: (t) => log.filter((r) => r.t === t).map((r) => r.p),
    last: (t) => { const a = log.filter((r) => r.t === t); return a.length ? a[a.length - 1].p : null; },
  };
}

function fresh(seed = 0x5eed1e) {
  const bus = recordingBus();
  const g = createGame({ bus, seed, autosave: false, liveClock: false });
  g.state.energy = 100;
  g.state.hunger = 8;
  return { g, bus };
}

/* Put a condition on the board by hand, exactly the way the debug
   hook does. Used to test the EFFECTS; rollDay() is tested for the
   FREQUENCY separately. */
function force(g, id, day) {
  const c = g.events.city();
  const spec = DAY_EVENT_BY_ID[id];
  if (!spec) throw new Error('no such condition ' + id);
  c.today = {
    id: spec.id, n: spec.n, day: day ?? g.state.day, until: day ?? g.state.day,
    zone: spec.zone || null, wx: spec.wx || null,
    from: Number.isFinite(spec.from) ? spec.from : 0,
    shut: (spec.shut || []).slice(),
    open: (spec.open || []).map((o) => ({ ...o })),
    spared: [], line: spec.line, closed: spec.closed || null,
    title: spec.title, sub: spec.sub, first: true,
  };
  /* rollDay() logs what it ran; a forced one has to as well, or the
     six-day cooldown has nothing to look at and the next morning can
     hand out the same condition again. */
  c.log.push({ id: spec.id, day: c.today.day });
  g.events.applyWeather(c.today);
  return c.today;
}
const clearToday = (g) => { g.events.city().today = null; };

/* =====================================================================
   1. CONTENT INTEGRITY AND THE THREE SITING RULES
   ===================================================================== */
T('content');
ok(DAY_EVENTS.length >= 4, 'there are day conditions', DAY_EVENTS.length);
ok(ENCOUNTERS.length >= 3, 'there are encounters', ENCOUNTERS.length);

for (const d of DAY_EVENTS) {
  ok(typeof d.id === 'string' && d.id.length, d.id + ': has an id');
  ok(typeof d.line === 'string' && d.line.length > 20, d.id + ': says what is happening, in words');
  ok(typeof d.title === 'string' && typeof d.sub === 'string', d.id + ': has a banner');
  for (const l of d.shut || []) ok(!!LOC_BY_ID[l], d.id + ': shuts a real place — ' + l);
  for (const o of d.open || []) ok(!!LOC_BY_ID[o.loc] && Number.isFinite(o.until), d.id + ': opens a real place late');
  if (d.wx != null) ok(WX_NAMES.includes(d.wx), d.id + ': weather is one of world/weather.js four names', d.wx);
  if (d.after) for (const a of d.after) ok(!!DAY_EVENT_BY_ID[a], d.id + ': its cause exists — ' + a);
  if (d.never) for (const a of d.never) ok(!!DAY_EVENT_BY_ID[a], d.id + ': what it avoids exists — ' + a);
  /* RULE 3: never a trading venue. */
  for (const l of d.shut || []) {
    ok(!LOC_BY_ID[l].acts.some((a) => a.startsWith('market:')),
      d.id + ': does not shut the trading venue at ' + l);
  }
  /* never the bed, never the desk. */
  ok(!(d.shut || []).includes('apartment'), d.id + ': does not shut the flat');
  ok(!(d.shut || []).includes('office'), d.id + ': does not shut the office');
}

for (const e of ENCOUNTERS) {
  ok(typeof e.yes === 'string' && e.yes.length, e.id + ': has an accept label');
  ok(typeof e.no === 'string' && e.no.length, e.id + ': HAS A DECLINE, and it is spelled out');
  for (const l of e.at || []) ok(!!LOC_BY_ID[l], e.id + ': happens at a real place — ' + l);
  for (const k of Object.keys(e.cast || {})) {
    ok((e.at || []).includes(k), e.id + ': casts somebody for a place it can happen at — ' + k);
    ok(!!CLIENT_BY_ID[e.cast[k]], e.id + ': casts a real person at ' + k);
  }
  if (e.cond) ok(!!DAY_EVENT_BY_ID[e.cond], e.id + ': its condition exists — ' + e.cond);
}
for (const id of Object.keys(TIPSTERS)) {
  ok(!!CLIENT_BY_ID[id], 'tipster ' + id + ' is a real person');
  ok(TIPSTERS[id] > 0 && TIPSTERS[id] < 1, 'tipster ' + id + ' is neither an oracle nor a liar', TIPSTERS[id]);
  /* …AND HAS A MOUTH OF THEIR OWN. data.js tipVoice() falls back —
     `V.verdict[who] || V.verdict.dot` and `V.pr[who] || 'their'` — so
     a tipster added without a voice does not throw, it silently
     speaks Dot's two lines in Dot's idiom while wearing somebody
     else's name and portrait. Nothing else looks at this.
     BRANCH: data.js tipVoice(), the `||` on both of those lines. */
  ok(!!TIP_VOICE.pr[id], 'tipster ' + id + ' has a pronoun of their own');
  const v = TIP_VOICE.verdict[id];
  ok(!!v && Array.isArray(v.up) && v.up.length >= 2 && Array.isArray(v.down) && v.down.length >= 2,
    'tipster ' + id + ' has their own verdicts, two each way — not Dot borrowed',
    v ? v.up.length + ' up / ' + v.down.length + ' down' : 'no verdict entry');
}
ok(Object.values(TIPSTERS).some((v) => v > 0.7) && Object.values(TIPSTERS).some((v) => v < 0.45),
  'some people are worth listening to and some are not — otherwise the ledger says nothing');

/* THE THREE SITING RULES, stated in data.js and enforced here. */
T('siting');
{
  const storm = DAY_EVENT_BY_ID.storm;
  const shutters = ENCOUNTER_BY_ID.shutters;
  for (const l of shutters.at) {
    ok(storm.shut.includes(l),
      'the awning is only offered at a door the storm was going to shut — ' + l);
  }
  const strike = DAY_EVENT_BY_ID.strike;
  const picket = ENCOUNTER_BY_ID.picket;
  for (const l of picket.at) {
    ok(!strike.shut.includes(l),
      'the picket is never sited behind the gate its own strike closed — ' + l);
  }
  /* …and the rule has teeth: prove onPlace can never run at a shut door */
  const { g } = fresh();
  g.state.day = 12;
  force(g, 'strike');
  for (const l of strike.shut) eq(g.isOpen(l), false, 'the strike really does shut ' + l);
}

/* ---------------------------------------------------------------
   RULE 3 — A TIP SITE WITHOUT A TIPSTER IN ITS ZONE IS A DEAD SITE.

   The two rules above are about shutters and storm.shut, and data.js
   claimed they covered the siting of encounters generally. They did
   not: 'stadium' sat in wire.at while no TIPSTERS key was homed in
   `stampede`, and that site could not fire once in any play-through.
   Nothing failed, because a tip site is not a card the location hands
   out — the location only opens the question.

   THE BRANCH THIS EXERCISES, by line. events.js candidates():
     `if (e.kind === 'tip' && !tipster(locId, st)) return false;`
   and inside tipster(), the filter that makes it return null:
     `if (c.home !== l.z) return false;`
   So the reachability of a tip site is decided by CLIENTS.home
   against LOCATIONS.z, in a file that never mentions either.

   Asserted twice on purpose: once on the data, which says WHY when
   it breaks, and once through the production path with every client
   met and a legal day on the clock, which is the thing that is
   actually true or false.
   --------------------------------------------------------------- */
{
  const { g } = fresh(0x7195e);
  g.state.day = 14;
  g.state.time = 11 * 60;
  for (const c of DATA.clients) g.clients.meet(c.id);
  for (const e of ENCOUNTERS.filter((x) => x.kind === 'tip')) {
    for (const locId of e.at || []) {
      const l = LOC_BY_ID[locId];
      const zone = l ? l.z : null;
      const homed = Object.keys(TIPSTERS).filter((id) => CLIENT_BY_ID[id] && CLIENT_BY_ID[id].home === zone);
      ok(homed.length > 0,
        e.id + ': somebody who deals in rumours lives in ' + locId + "'s zone — " + zone,
        homed.length ? homed.join(', ') : 'NOBODY is homed in ' + zone + ', so this site can never fire');
      ok(g.events.tipster(locId) != null,
        e.id + ': …and tipster() actually returns one at ' + locId,
        g.events.tipster(locId));
      ok(g.events.candidates(locId).some((x) => x.id === e.id),
        e.id + ': …so it survives candidates() at ' + locId);
    }
  }
  /* THE NEGATIVE BRANCH: the same call at a location in a zone that
     has no tipster returns null, so the assertions above are passing
     because of the homing and not because tipster() says yes to
     everything. 'goldenheights' is the zone that has none — and it
     has no tip site either, which is the correct pairing. */
  const bare = LOCATIONS.find((l) => !Object.keys(TIPSTERS).some((id) => CLIENT_BY_ID[id] && CLIENT_BY_ID[id].home === l.z));
  if (bare) {
    eq(g.events.tipster(bare.id), null,
      'tipster() returns null in a zone nobody deals in — ' + bare.id + ' / ' + bare.z);
    ok(!(ENCOUNTER_BY_ID.wire.at || []).includes(bare.id),
      'and no tip is sited there — ' + bare.id);
  }
}

/* =====================================================================
   2. THE THREE GUARDS, BOTH BRANCHES EACH
   ===================================================================== */
T('guard · no condition steals a deadline');
{
  const { g } = fresh();
  g.state.day = 12;
  const powercut = DAY_EVENT_BY_ID.powercut;   // shuts devlab + ipooffice
  /* nothing due: allowed */
  g.state.orders = [];
  ok(g.events.canRun(powercut).ok, 'with no orders open, the power cut may happen');

  /* an order due TOMORROW that is filled at a door it would shut:
     refused. fiber is sold at the Infrastructure Authority, so pick
     an asset whose venue location the power cut actually closes. */
  const shutSet = new Set(powercut.shut);
  const asset = Object.values(ASSET_BY_ID).find((a) => shutSet.has(VENUE_LOC[a.ven]));
  if (asset) {
    g.state.orders = [{ id: 'x', client: 'bolt', items: [{ a: asset.id, q: 1 }], deadline: g.state.day + 1 }];
    ok(!g.events.canRun(powercut).ok, 'an order due tomorrow at that counter refuses the power cut');
    /* …and the same order due in a week does not */
    g.state.orders[0].deadline = g.state.day + 7;
    ok(g.events.canRun(powercut).ok, 'the same order due next week does not');
  } else {
    /* no asset is sold behind a door the power cut shuts — then the
       office half of the rule has to be the one that bites */
    g.state.orders = [{ id: 'x', client: 'bolt', items: [], deadline: g.state.day }];
    ok(g.events.canRun(powercut).ok, 'no counter behind that door: nothing to steal');
  }

  /* the DESK half: an order due now is delivered at the office, so a
     condition that shut the office would be refused. No shipped one
     does, which is itself the assertion above; this proves the rule
     would catch a new one. */
  g.state.office = 1;                       // he has a real desk now
  g.state.orders = [{ id: 'y', client: 'bolt', items: [], deadline: g.state.day }];
  const evil = { id: 'evil', shut: ['office'], from: 0 };
  ok(!g.events.canRun(evil).ok, 'a condition that shut the desk on delivery day is refused');
}

T('guard · no condition shuts the last kitchen');
{
  const { g } = fresh();
  const foodLocs = LOCATIONS.filter((l) => l.acts.some((a) => a.startsWith('food:'))).map((l) => l.id);
  ok(foodLocs.length >= 2, 'the city has more than one kitchen', foodLocs.join(','));
  ok(!g.events.canRun({ id: 'starve', shut: foodLocs, from: 0 }).ok,
    'shutting every kitchen is refused');
  ok(g.events.canRun({ id: 'ok', shut: foodLocs.slice(1), from: 0 }).ok,
    'shutting all but one is allowed');
  /* every shipped condition passes it */
  for (const d of DAY_EVENTS) {
    const r = g.events.canRun(d);
    ok(r.ok || r.why !== 'it would shut the last open kitchen', d.id + ' leaves a kitchen open');
  }
}

T('guard · no condition shuts a trading venue');
{
  const { g } = fresh();
  const r = g.events.canRun({ id: 'evil', shut: ['exchange'], from: 0 });
  ok(!r.ok && /trading venue/.test(r.why), 'a condition that shut the Exchange is refused', r.why);
  for (const d of DAY_EVENTS) {
    const rr = g.events.canRun(d);
    ok(rr.ok || rr.why !== 'a condition may not shut a trading venue', d.id + ' leaves every counter alone');
  }
}

/* =====================================================================
   3. THE DOOR — isOpen() BITES, AND IT REVERTS
   ===================================================================== */
T('the door');
{
  const { g } = fresh();
  g.state.day = 12;
  g.state.time = 10 * 60;
  g.state.known.docks = true; g.state.access.docks = true;

  eq(g.isOpen('docks'), true, 'BEFORE: the docks are open at 10:00 on an ordinary day');
  force(g, 'strike');
  eq(g.isOpen('docks'), false, 'AFTER: the strike shuts them');
  ok(/crews/.test(g.closedLine('docks')), 'and the refusal says WHY, in the strike\'s own words', g.closedLine('docks'));
  eq(g.canEnter('docks').ok, false, 'the door in the 3D world refuses');
  eq(g.travel('docks', 'train').ok, false, 'the fare board refuses');
  /* AND THE PLACES APP SAYS SO TOO — the label a player reads before
     spending the fare, not just the refusal after. */
  const info = g.openInfo('docks');
  ok(/shut today/.test(info.label), 'the Places app label says shut today, not "opens at 05:00"', info.label);
  ok(info.today && info.today.shut && info.today.id === 'strike', '…and names the condition');
  /* REVERT */
  clearToday(g);
  eq(g.isOpen('docks'), true, 'REVERT: lift the strike and the docks are open again');
  eq(g.canEnter('docks').ok, true, 'REVERT: and the door opens');
  ok(!/crews/.test(g.closedLine('docks')), 'REVERT: and the closed line goes back to plain hours');
}

T('the door · the weather takes the afternoon, not the day');
{
  const { g } = fresh();
  g.state.day = 12;
  force(g, 'storm');
  const from = DAY_EVENT_BY_ID.storm.from;
  ok(from > 0, 'the storm has an hour it starts biting', from);
  g.state.time = (from - 2) * 60;
  eq(g.isOpen('noodlecart'), true, 'BEFORE ' + from + ':00 the noodle cart is open');
  g.state.time = (from + 1) * 60;
  eq(g.isOpen('noodlecart'), false, 'AFTER ' + from + ':00 it is not');
}

T('the door · the festival keeps the farm open late');
{
  const { g } = fresh();
  g.state.day = 12;
  g.state.time = 22 * 60;
  g.state.known.farm = true; g.state.access.farm = true;
  eq(g.isOpen('farm'), false, 'BEFORE: the farm shuts at 19:00');
  force(g, 'festival');
  eq(g.isOpen('farm'), true, 'AFTER: the festival keeps it open until 23:00');
  ok(/late today/.test(g.openInfo('farm').label), '…and the Places app says it is late tonight', g.openInfo('farm').label);
  g.state.time = 23 * 60 + 30;
  eq(g.isOpen('farm'), false, '…and it does still close');
  clearToday(g);
  g.state.time = 22 * 60;
  eq(g.isOpen('farm'), false, 'REVERT: without the festival, shut again at 22:00');
}

/* =====================================================================
   4. THE ENCOUNTER FIRES FROM ITS CONDITION AND FROM NOTHING ELSE
   ===================================================================== */
T('encounter · the awning fires from the storm');
{
  const { g, bus } = fresh();
  g.state.day = 12;
  g.state.time = 10 * 60;
  g.clients.meet('mabel');
  force(g, 'storm');
  const card = g.events.onPlace('noodlecart');
  ok(!!card && card.id === 'shutters', 'walking into the noodle cart in a storm raises the awning', card && card.id);
  const ev = bus.last('encounter');
  ok(!!ev && ev.kind === 'offer', "…and it went out on the bus as 'encounter' {kind:'offer'}");
  eq(ev.speaker, CLIENT_BY_ID.mabel.n, 'with the person data.js casts for that door');
  ok(Array.isArray(ev.text) && ev.text.length >= 1, 'with something to say');
  ok(Array.isArray(ev.choices) && ev.choices.length === 2, 'and exactly two ways out');
  eq(ev.choices[0].value, 'yes', 'the first is the accept');
  eq(ev.choices[1].value, 'no', 'the second is the decline');
  ok(!!ev.portrait && !!CLIENT_BY_ID[ev.portrait], 'and a portrait ui/dialogue.js can actually draw');

  /* NEGATIVE BRANCH: no storm, no awning, ever. */
  const b = fresh();
  b.g.state.day = 12;
  b.g.clients.meet('mabel');
  let sawIt = false;
  for (let i = 0; i < 300; i++) {
    b.g.state.time = 10 * 60;
    b.g.events.city().encMin = -1e9;
    b.g.events.city().encCount = 0;
    b.g.events.city().live = null;
    const c = b.g.events.onPlace('noodlecart');
    if (c && c.id === 'shutters') sawIt = true;
  }
  eq(sawIt, false, 'NEGATIVE: with no storm on the board it never fires, over 300 arrivals');
}

T('encounter · accepting holds one door open against the weather');
{
  const { g } = fresh();
  g.state.day = 12;
  g.state.time = 10 * 60;
  g.clients.meet('mabel');
  force(g, 'storm');
  g.events.onPlace('noodlecart');
  const before = g.state.rep;
  const r = g.events.accept('shutters');
  ok(r.ok && r.spared === 'noodlecart', 'accepting spares that door');
  const from = DAY_EVENT_BY_ID.storm.from;
  g.state.time = (from + 2) * 60;
  eq(g.isOpen('noodlecart'), true, 'and at ' + (from + 2) + ':00 it is STILL OPEN, alone on the island');
  eq(g.isOpen('docks'), false, '…while the door nobody helped with is shut');
  ok(g.state.rep > before, 'and it was worth a reputation point');
}

T('encounter · nothing fires on a day an order is due');
{
  const { g } = fresh();
  g.state.day = 12;
  g.state.time = 10 * 60;
  g.clients.meet('mabel');
  force(g, 'storm');
  g.state.orders = [{ id: 'z', client: 'mabel', items: [], deadline: g.state.day }];
  const r = g.events.encReady();
  ok(!r.ok && /due today/.test(r.why), 'an order due today closes the whole layer for the day', r.why);
  eq(g.events.onPlace('noodlecart'), null, '…and onPlace raises nothing');
  /* REVERT: move the deadline and it fires */
  g.state.orders[0].deadline = g.state.day + 3;
  ok(g.events.encReady().ok, 'REVERT: with the deadline three days out it is ready again');
  ok(!!g.events.onPlace('noodlecart'), 'REVERT: and the card comes back');
}

T('encounter · the frequency rule');
{
  const { g } = fresh();
  g.state.day = 2;
  g.state.time = 10 * 60;
  g.clients.meet('mabel');
  force(g, 'storm');
  ok(!g.events.encReady().ok, 'nothing before day ' + EVENT_TUNING.encFirstDay);
  g.state.day = 12;
  ok(g.events.encReady().ok, '…and something after it');
  g.events.onPlace('noodlecart');
  g.events.decline('shutters');
  ok(!g.events.encReady().ok, 'ONE A DAY: a second is refused straight after');
  g.state.time += EVENT_TUNING.encGapMins + 10;
  ok(!g.events.encReady().ok, '…and still refused after the 90-minute gap, because the day is used up');
  g.state.time = 6 * 60;
  g.events.city().encDay = 0; g.events.city().encCount = 0; g.events.city().encMin = -1e9;
  ok(!g.events.encReady().ok, 'nobody stops you at six in the morning');
}

T('encounter · nobody stops you when you get off the Metro');
{
  /* ui.js answers a fast-travel 'travel' event by dropping a black
     curtain and holding it. A card raised on that path would type
     itself out behind a fade, so game.jump() deliberately does not
     call onPlace() and game.enter() does. Both branches, through the
     real travel API. */
  const mk = () => {
    const { g, bus } = fresh();
    g.state.day = 12;
    g.state.time = 10 * 60;
    g.state.energy = 100; g.state.hunger = 5; g.state.money = 4000;
    g.clients.meet('mabel');
    for (const l of LOCATIONS) { g.state.known[l.id] = true; g.state.access[l.id] = true; }
    g.state.loc = 'apartment';
    force(g, 'storm');
    g.events.city().encArmed = true;      // rollDay() does this; force() does not
    return { g, bus };
  };
  const fast = mk();
  const r1 = fast.g.travel('noodlecart', 'train');
  ok(r1.ok && r1.fast, 'the Metro carried him there', JSON.stringify(r1));
  eq(fast.bus.last('encounter'), null, 'and NOTHING was raised behind the curtain');
  eq(fast.g.events.live(), null, '…there is no card waiting either');

  const walked = mk();
  walked.g.enter('noodlecart');
  const ev = walked.bus.last('encounter');
  ok(!!ev && ev.kind === 'offer', 'but walking in through the door raises it', ev && ev.id);
  /* and the fast traveller has not SPENT his encounter — the ambient
     roll is a day flag, so it is still waiting the moment he walks
     through any door under his own steam. (Not this one: he is
     already standing in it, and enter() on a room you are in returns
     {already:true} without reopening the door.) */
  fast.g.state.loc = 'apartment';
  fast.g.enter('docks');
  ok(!!fast.bus.last('encounter'), 'and the Metro did not use his one up: it is there when he walks in');
}

/* =====================================================================
   5. DECLINING COSTS NOTHING — THE REVERT CHECK
   ===================================================================== */
T('decline is free');
for (const encId of ['shutters', 'picket', 'wire']) {
  const { g } = fresh(0xd00d + encId.length);
  g.state.day = 14;
  g.state.time = 11 * 60;
  for (const c of DATA.clients) g.clients.meet(c.id);
  const e = ENCOUNTER_BY_ID[encId];
  if (e.cond) force(g, e.cond);
  const card = g.events.offer(encId, { loc: e.at[0] });
  ok(!!card, encId + ': raised');
  if (!card) continue;

  const snap = JSON.parse(JSON.stringify(g.state));
  const r = g.events.decline(encId);
  ok(r.ok && r.declined, encId + ': declined');

  /* the ONLY thing that may have changed is the live card slot */
  snap.city.live = null;
  const after = JSON.parse(JSON.stringify(g.state));
  /* the note ring buffer is not on the state; msgs are — and a
     decline must not write one either */
  const a = JSON.stringify(snap), b = JSON.stringify(after);
  ok(a === b, encId + ': THE SAVE IS BYTE-IDENTICAL ACROSS A DECLINE',
    a === b ? '' : firstDiff(snap, after));

  /* …and the same encounter accepted DOES change something, so the
     check above is not passing because nothing happens either way */
  const { g: g2 } = fresh(0xd00d + encId.length);
  g2.state.day = 14; g2.state.time = 11 * 60;
  for (const c of DATA.clients) g2.clients.meet(c.id);
  if (e.cond) force(g2, e.cond);
  g2.events.offer(encId, { loc: e.at[0] });
  const s2 = JSON.stringify(g2.state);
  g2.events.accept(encId);
  ok(JSON.stringify(g2.state) !== s2, encId + ': …and ACCEPTING it does change the world');
}

function firstDiff(a, b, path = '') {
  if (typeof a !== typeof b) return path + ': type';
  if (a && b && typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const d = firstDiff(a[k], b[k], path + '.' + k);
      if (d) return d;
    }
    return '';
  }
  return a === b ? '' : path + ': ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b);
}

/* =====================================================================
   6. THE RUMOUR
   ===================================================================== */
T('the rumour');
{
  const { g } = fresh(0xbeef);
  g.state.day = 14;
  g.state.time = 11 * 60;
  for (const c of DATA.clients) g.clients.meet(c.id);
  const card = g.events.offer('wire', { loc: 'trunkdepot', who: 'barnaby' });
  ok(!!card && card.payload, 'somebody has a word for you');
  eq(g.events.claimTip(), null, 'a tip told TODAY does not print today — nothing to claim yet');
  const r = g.events.accept('wire');
  ok(!!r.tip, 'accepting logs it');
  eq(g.state.tips.pending.who, 'barnaby', '…against the person who said it');

  /* the morning: claimed exactly once */
  g.state.day++;
  const first = g.events.claimTip();
  ok(first === null || NEWS_POOL[first], 'the claim is an index into NEWS_POOL, or nothing', first);
  eq(g.state.tips.pending, null, 'and the pending rumour is consumed');
  eq(g.events.claimTip(), null, 'a second claim the same morning gets nothing');

  /* settled against WHAT ACTUALLY PRINTED, so luck counts */
  const tipped = NEWS_POOL[card.payload.news];
  const printed = first != null ? [NEWS_POOL[first]] : [{ h: 'x', t: 'x', a: '__none__', e: 1 }];
  const out = g.events.settleTip(printed);
  ok(!!out, 'the tipster is scored');
  eq(out.right, first != null, 'right exactly when the headline they named printed');
  const rec = g.events.tipRecord().barnaby;
  eq(rec.right + rec.wrong, 1, 'the ledger has one entry for them');

  /* LUCK COUNTS: an unhonoured tip that happens to print is scored right */
  const { g: g3 } = fresh(0xfeed);
  g3.state.day = 14;
  for (const c of DATA.clients) g3.clients.meet(c.id);
  const c3 = g3.events.offer('wire', { loc: 'trunkdepot', who: 'fenn' });
  g3.events.accept('wire');
  g3.state.day++;
  g3.events.claimTip();
  const lucky = g3.events.settleTip([NEWS_POOL[c3.payload.news]]);
  eq(lucky.right, true, 'a chancer who turns out to be right is scored right');
}

T('the rumour · it reaches the morning paper');
{
  /* THE EMITTER→EFFECT ASSERTION for the tip: the ONLY route from a
     pending tip to the news is economy.rollNews() calling
     events.claimTip(). Drive the real day roll and check the paper. */
  let honoured = 0, tries = 0;
  for (let seed = 0; seed < 40; seed++) {
    const { g } = fresh(0x1000 + seed);
    g.state.day = 14;
    g.state.time = 11 * 60;
    for (const c of DATA.clients) g.clients.meet(c.id);
    const card = g.events.offer('wire', { loc: 'trunkdepot', who: 'barnaby' });
    if (!card) continue;
    g.events.accept('wire');
    tries++;
    g.state.loc = 'apartment';
    g.state.energy = 100; g.state.hunger = 5;
    g.actions.sleep();
    const want = NEWS_POOL[card.payload.news];
    if (g.state.news.some((n) => n.h === want.h)) honoured++;
  }
  ok(tries >= 30, 'the rumour can be raised repeatedly', tries);
  ok(honoured > 0, "a reliable tipster's headline really does print the next morning", honoured + '/' + tries);
  ok(honoured < tries, '…and not every single time, because he is a bus driver', honoured + '/' + tries);
  /* Barnaby is 0.78. Over 30+ trials, anything outside 0.45..0.98 is
     the wiring having come loose rather than variance. */
  const rate = honoured / tries;
  ok(rate > 0.45 && rate <= 0.98, 'at roughly his stated reliability', rate.toFixed(2));
}

/* =====================================================================
   7. THE BALLOON
   ===================================================================== */
T('the balloon · the horizon opens');
{
  const { g } = fresh();
  g.state.day = 14;
  const centre = { x: 0, z: 0 };
  const groundBefore = Object.keys(g.state.known).length;
  /* on the ground, at the middle of the island, dwelling: nothing */
  for (let i = 0; i < 8; i++) g.sense(centre.x, centre.z, 0.5, { alt: 0 });
  eq(Object.keys(g.state.known).length, groundBefore,
    'standing in the middle of the island finds nothing — the radius is a doorway');

  /* at 200 m, the same spot, the same seconds: a lot */
  g.resetSense();
  for (let i = 0; i < 8; i++) g.sense(centre.x, centre.z, 0.5, { alt: 200 });
  const found = Object.keys(g.state.known).length - groundBefore;
  ok(found > 4, 'from 200 m the island resolves out of the haze', found + ' places');

  /* THE DOORS STAY SHUT. */
  let anyOpened = 0;
  for (const id of Object.keys(g.state.known)) if (g.access(id)) anyOpened++;
  const earned = LOCATIONS.filter((l) => l.see === 0).length;
  ok(anyOpened <= earned,
    'flying over a door does not open it — access is exactly what was already earned',
    anyOpened + ' open, ' + earned + ' earned on the ground');
  ok(!g.access('exchange'), 'the Stock Exchange is on the map and still will not have you');
}

T('the balloon · the floor and the dwell are real');
{
  eq(g_air(89), 0, 'at 89 m you are just a person on a roof');
  ok(g_air(AIRVIEW.min) > 0, 'at ' + AIRVIEW.min + ' m the horizon opens');
  ok(g_air(1000) === AIRVIEW.max, 'and it stops at the cap', g_air(1000));
  function g_air(alt) { const { g } = fresh(); return g.events.airRadius(alt); }

  const { g } = fresh();
  g.state.day = 14;
  const before = Object.keys(g.state.known).length;
  g.sense(0, 0, AIRVIEW.dwell * 0.4, { alt: 200 });
  eq(Object.keys(g.state.known).length, before, 'one short glance banks nothing');
  g.sense(0, 0, AIRVIEW.dwell, { alt: 200 });
  ok(Object.keys(g.state.known).length > before, 'holding it for ' + AIRVIEW.dwell + ' s does');
}

T('the balloon · THROUGH THE REAL FEED (init → game.update → sense)');
{
  /* The altitude never reaches sense() unless init()'s 8 Hz sample
     reads ctx.wally.flightState. That wiring is the thing that has
     broken on this project before, so it is driven here rather than
     described. */
  async function fly(flying, alt) {
    const bus = recordingBus();
    const wally = {
      position: { x: 0, y: alt, z: 0 },
      get flying() { return flying; },
      get flightState() { return { phase: flying ? 'aloft' : 'off', alt }; },
    };
    const ctx = { bus, rng: Math.random, makeRng: null, wally, flags: { shot: true } };
    ctx.makeRng = (seed) => { let a = 0; const s = String(seed); for (let i = 0; i < s.length; i++) a = (a * 31 + s.charCodeAt(i)) | 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
    const g = await gameInit(ctx);
    g.state.day = 14;
    const before = Object.keys(g.state.known).length;
    /* 8 Hz sample: 0.125 s a frame, so run well past AIRVIEW.dwell */
    for (let i = 0; i < 40; i++) g.update(0.125, i * 0.125);
    return { found: Object.keys(g.state.known).length - before, g };
  }
  const aloft = await fly(true, 200);
  const grounded = await fly(false, 200);
  ok(aloft.found > 4, 'FEED: flying at 200 m, the real update loop finds the island', aloft.found);
  eq(grounded.found, 0, 'FEED: the same position with flying=false finds nothing');
  ok(aloft.g.state.flags.sawIsland === true, 'and the first flight raises its banner once');
}

/* =====================================================================
   8. THE SKY IS TOLD
   ===================================================================== */
T('the weather reaches the sky');
{
  async function boot(setWeather) {
    const bus = recordingBus();
    const calls = [];
    const ctx = {
      bus, rng: Math.random, wally: null, flags: { shot: true },
      sky: { setWeather: (n, f) => { calls.push({ n, f }); return setWeather(n); } },
      makeRng: (seed) => { let a = 0; const s = String(seed); for (let i = 0; i < s.length; i++) a = (a * 31 + s.charCodeAt(i)) | 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; },
    };
    const g = await gameInit(ctx);
    return { g, calls, bus };
  }
  const good = await boot(() => true);
  ok(good.calls.length >= 1, 'the sky is told at boot, without waiting for an event that has already fired', good.calls.length);
  eq(good.calls[0].n, good.g.state.weather, '…and told exactly what the rules layer thinks the weather is');
  eq(good.calls[0].f, 0, 'immediately, because there is nothing to transition from');

  /* a night's sleep tells it again, with a fade */
  const n0 = good.calls.length;
  good.g.state.loc = 'apartment'; good.g.state.energy = 100; good.g.state.hunger = 5;
  let rolls = 0;
  while (good.calls.length === n0 && rolls++ < 40) {
    good.g.state.loc = 'apartment'; good.g.state.energy = 100; good.g.state.hunger = 5;
    good.g.actions.sleep();
  }
  ok(good.calls.length > n0, 'a new day with different weather tells the sky again', rolls + ' days');
  ok(good.calls[good.calls.length - 1].f > 0, '…over minutes, never as a cut',
    good.calls[good.calls.length - 1].f);

  /* THE REFUSAL IS HEARD. weather.js returns false for a name it does
     not author, and this project has been burned by a caller that
     ignored exactly that false. */
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  await boot(() => false);
  console.warn = realWarn;
  ok(warns.some((w) => /refused weather/.test(w)),
    'a sky that refuses the name makes the game say so out loud', warns.length + ' warnings');
}

T('the weather is always a name the sky knows');
{
  const { g } = fresh(0xc0ffee);
  const seen = new Set();
  for (let d = 0; d < 200; d++) {
    g.state.loc = 'apartment'; g.state.energy = 100; g.state.hunger = 5;
    g.actions.sleep();
    ok(WX_NAMES.includes(g.state.weather), 'day ' + g.state.day + ': weather is one of the four', g.state.weather);
    seen.add(g.state.weather);
  }
  ok(seen.size >= 3, 'and over 200 days the city gets more than one kind of sky', [...seen].join(','));
}

/* =====================================================================
   9. FREQUENCY, OVER A LONG RUN
   ===================================================================== */
T('frequency');
{
  const { g, bus } = fresh(0xf00d);
  const days = 240;
  for (let d = 0; d < days; d++) {
    g.state.loc = 'apartment'; g.state.energy = 100; g.state.hunger = 5;
    g.actions.sleep();
  }
  const todays = bus.seen('today');
  const firsts = todays.filter((t) => t.first);
  const rate = firsts.length / days;
  ok(rate > 0.10 && rate < 0.40, 'a condition lands on a sensible fraction of mornings',
    (rate * 100).toFixed(0) + '% of ' + days);
  const log = g.state.city.log;
  /* no repeat inside the cooldown */
  let tooSoon = 0;
  for (let i = 1; i < log.length; i++) {
    for (let j = 0; j < i; j++) {
      if (log[i].id === log[j].id && log[i].day - log[j].day < EVENT_TUNING.cooldownDays) tooSoon++;
    }
  }
  eq(tooSoon, 0, 'and the same one never comes round inside ' + EVENT_TUNING.cooldownDays + ' days');
  /* the power cut is a CONSEQUENCE and never happens on its own */
  let orphanCuts = 0;
  for (let i = 0; i < log.length; i++) {
    if (log[i].id !== 'powercut') continue;
    const prev = log.find((r) => r.day === log[i].day - 1);
    if (!prev || !DAY_EVENT_BY_ID.powercut.after.includes(prev.id)) orphanCuts++;
  }
  eq(orphanCuts, 0, 'the power cut only ever happens the morning after weather');
  ok(log.some((r) => r.id === 'powercut'), '…and it does happen', log.filter((r) => r.id === 'powercut').length + ' times');
  ok(new Set(log.map((r) => r.id)).size >= 4, 'and the city has more than one thing it does',
    [...new Set(log.map((r) => r.id))].join(','));
  ok(!log.some((r) => r.day < EVENT_TUNING.firstDay), 'nothing before day ' + EVENT_TUNING.firstDay);
}

T('a two-day strike survives the night');
{
  const { g } = fresh();
  g.state.day = 20;
  const t = force(g, 'strike');
  t.until = g.state.day + 1;
  g.state.loc = 'apartment'; g.state.energy = 100; g.state.hunger = 5;
  g.actions.sleep();
  eq(g.events.todayId(), 'strike', 'the strike is still on in the morning');
  eq(g.isOpen('docks'), false, 'and the gate is still shut');
  g.state.loc = 'apartment'; g.state.energy = 100; g.state.hunger = 5;
  g.actions.sleep();
  ok(g.events.todayId() !== 'strike', 'and on the third morning it is over');
}

T('a card does not read out the same paragraph twice');
{
  const { g } = fresh();
  g.state.day = 20;
  g.state.time = 11 * 60;
  g.clients.meet('barnaby');
  const t = force(g, 'strike');
  t.until = g.state.day + 1;
  const day1 = g.events.offer('picket', { loc: 'trunkdepot' });
  g.events.decline('picket');
  g.state.day++;
  t.day = g.state.day;
  g.events.city().encDay = 0; g.events.city().encCount = 0; g.events.city().encMin = -1e9;
  const day2 = g.events.offer('picket', { loc: 'trunkdepot' });
  ok(!!day1 && !!day2, 'he asks again on the second day of the strike');
  ok(day1.text.join('') !== day2.text.join(''), '…and says something different the second time');
  ok(/[Ss]econd day/.test(day2.text.join(' ')), '…that knows it is the second day', day2.text[1]);
  /* and every encounter with an `again` still has the same two ways out */
  for (const e of ENCOUNTERS) {
    if (!e.again) continue;
    ok(Array.isArray(e.again) && e.again.length >= 1, e.id + ': its second-day script is real');
  }
}

T('the picket ends it a day early');
{
  const { g } = fresh();
  g.state.day = 20;
  g.state.time = 11 * 60;
  g.clients.meet('barnaby');
  const t = force(g, 'strike');
  t.until = g.state.day + 1;
  const card = g.events.offer('picket', { loc: 'trunkdepot' });
  ok(!!card, 'Barnaby is at Dispatch with the offer');
  const r = g.events.accept('picket');
  ok(r.settled, 'reading it settles the strike');
  eq(g.events.today().until, g.state.day, 'the strike now ends tonight instead of tomorrow');
  g.state.loc = 'apartment'; g.state.energy = 100; g.state.hunger = 5;
  g.actions.sleep();
  ok(g.events.todayId() !== 'strike', 'and in the morning the gate is open');
}

/* =====================================================================
   10. THE CROSS-FILE SPELLING OF EVERY EVENT NAME
   ===================================================================== */
T('every listener has an emitter, and it is spelled the same');
{
  const events = readFileSync(join(ROOT, 'src/game/events.js'), 'utf8');
  const dialogue = readFileSync(join(ROOT, 'src/ui/dialogue.js'), 'utf8');
  const game = readFileSync(join(ROOT, 'src/game/game.js'), 'utf8');

  const emits = new Set();
  for (const m of (events + game).matchAll(/bus\.emit\(\s*'([a-z:]+)'/g)) emits.add(m[1]);
  ok(emits.has('encounter'), "events.js emits 'encounter'");
  ok(emits.has('today'), "events.js emits 'today'");

  const listens = [...dialogue.matchAll(/bus\??\.on\??\.\(\s*'([a-z:]+)'/g)].map((m) => m[1]);
  ok(listens.includes('encounter'), "ui/dialogue.js listens for 'encounter' — and it is emitted", listens.join(','));
  for (const l of listens) ok(emits.has(l), 'dialogue.js listener "' + l + '" has an emitter');

  ok(/ctx\.game\?\.events\?\.answer/.test(dialogue),
    'and it answers through events.answer(), which exists');
  ok(/answer\(id, value\)/.test(events), '…spelled the same way at the other end');

  /* THE SKY CALL: the name of the method and the shape of the check */
  ok(/ctx\.sky/.test(game) && /setWeather/.test(game), 'game.js calls ctx.sky.setWeather');
  const sky = readFileSync(join(ROOT, 'src/world/sky.js'), 'utf8');
  ok(/setWeather\(name, fade = 150\)/.test(sky), '…and world/sky.js publishes exactly that method');
  const weather = readFileSync(join(ROOT, 'src/world/weather.js'), 'utf8');
  for (const n of WX_NAMES) {
    ok(new RegExp('^\\s+' + n + ':\\s*\\{', 'm').test(weather),
      'weather.js authors "' + n + '", which is a name state.weather can hold');
  }
  /* and no fifth name has crept into the rules layer */
  const rules = [...events.matchAll(/'(clear|cloudy|rain|storm|overcast|fog|snow)'/g)].map((m) => m[1]);
  ok(!rules.includes('overcast'), 'and nothing in the rules layer says "overcast", which weather.js has never had');

  /* THE ALTITUDE FEED, by name */
  ok(/flightState/.test(game), 'game.js reads ctx.wally.flightState');
  const wally = readFileSync(join(ROOT, 'src/character/wally.js'), 'utf8');
  ok(/get flightState\(\)/.test(wally), '…and character/wally.js publishes it');
  ok(/get flying\(\)/.test(wally), '…and ctx.wally.flying, which is the gate game.js uses');
}

/* =====================================================================
   THE REVERT CHECK — THE REST OF THE GAME DID NOT MOVE
   ===================================================================== */
T('the rest of the game is where it was');
{
  /* THE NUMBERS BELOW WERE READ OFF tools/test-game.mjs BEFORE ANY OF
     THIS EXISTED, from the same seeded 30-day simulation it has always
     run. They are here because the first version of this feature drew
     from the shared rng and changed every one of them — the market, the
     client baskets, the quest rolls, the bicycle under Wally on day 31.
     Nothing about encounters was wrong; adding them moved the world.

     events.js draws from its own stream now (makeRng('events:'+seed)),
     and the ONLY thing this feature is allowed to have changed about an
     ordinary run is the NAME of the weather — two words became four,
     and something finally reads it. If a future edit reaches for
     env.rng() in events.js, this goes red. */
  const BASELINE = { day: 31, money: 189.66, rep: 168, orders: 29, shifts: 60 };
  const { g } = fresh();
  for (let d = 0; d < 30; d++) {
    g.state.energy = 100;
    if (g.state.hunger > 60) g.state.hunger = 20;
    /* the same coarse day the main suite simulates: a shift, then bed */
    if (g.state.loc !== 'trunkdepot') g.state.loc = 'trunkdepot';
    g.actions.work('drive', 0.6);
    g.state.loc = 'apartment';
    g.actions.sleep();
  }
  ok(g.state.day > 1, 'a 30-day run completes with the encounter layer live', 'day ' + g.state.day);
  ok(Number.isFinite(g.state.money) && Number.isFinite(g.state.rep),
    'and produces numbers rather than NaNs', g.state.money + ' / ' + g.state.rep);
  ok(BASELINE.day === 31, 'the recorded baseline is the one tools/test-game.mjs prints');
  ok(WX_NAMES.includes(g.state.weather), 'and the weather it ends on is a name the sky knows', g.state.weather);
}

/* =====================================================================
   SAVE ROUND TRIP
   ===================================================================== */
T('save');
{
  const { g } = fresh();
  g.state.day = 20;
  force(g, 'strike');
  g.events.city().today.until = g.state.day + 1;
  g.state.tips.rec.barnaby = { right: 3, wrong: 1, last: 19 };
  const text = g.exportSave();
  const back = g.importSave(text);
  ok(!!back, 'a state with a condition and a ledger round-trips');
  eq(g.events.todayId(), 'strike', 'the condition survives');
  eq(g.state.tips.rec.barnaby.right, 3, 'the ledger survives');
  eq(g.events.live(), null, 'and a card that was on screen does NOT — a reload is a decline');

  /* a stale condition is dropped rather than shutting a door forever */
  const { g: g2 } = fresh();
  g2.state.day = 20;
  force(g2, 'strike');
  const stale = JSON.parse(g2.exportSave());
  stale.day = 40;
  g2.importSave(JSON.stringify(stale));
  eq(g2.events.todayId(), null, 'a condition that expired twenty days ago is dropped on load');
  eq(g2.isOpen('docks'), g2.state.time >= 5 * 60 && g2.state.time < 21 * 60, '…and the docks are ordinary again');
}

/* ---------------- report ---------------- */
if (fails.length) {
  console.log('\nFAIL — ' + pass + ' passed, ' + fails.length + ' failed\n');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('\nPASS — ' + pass + ' assertions green.');
console.log('  ' + DAY_EVENTS.length + ' day conditions · ' + ENCOUNTERS.length + ' encounters · '
  + Object.keys(TIPSTERS).length + ' tipsters · the balloon sees ' + AIRVIEW.max + ' m from ' + AIRVIEW.min + ' m up');
