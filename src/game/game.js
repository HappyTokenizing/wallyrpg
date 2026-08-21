/* ============================================================
   game.js — ctx.game. The facade main.js boots.

   Owns: time, travel, and every player action that changes the
   world state. Delegates content to data.js, numbers to economy.js,
   people to clients.js, story to quests.js, persistence to save.js.

   Pure logic. This module never touches THREE, the DOM or an audio
   context — it emits events on ctx.bus and lets the render, world,
   ui and audio agents react.

   ------------------------------------------------------------
   PUBLIC API — ctx.game
   ------------------------------------------------------------
   data                     frozen content tables (see data.js)
   state                    the live state object (read freely,
                            mutate ONLY through the API below)

   time.day                 1-based day number
   time.minutes             minutes since midnight, may exceed 1440
                            on a long night (force-sleep at 26:00)
   time.hour / time.minute  clamped 0..23 / 0..59
   time.phase               'Night'|'Morning'|'Afternoon'|'Evening'
   time.norm                0..1 through the 24 h day — sky reads this
   time.clock()             '14:35 · Afternoon'
   time.advance(mins, en)   spend time (and optionally energy)

   here()                   the current location record
   officeLoc()              'apartment' until you rent a desk
   isOpen(locId)            opening-hours check
   known(locId)             has the player heard of it
   fares(dest)              every mode, priced — see fares() below.
                            [{mode, n, ico, cost, mins, energy, hops,
                              ok, why, metres?, trudge?, warn?}]
                            'walk' is always ok. Order: walk, bike,
                            train (Metro), trunk (Uber).
   travel(locId, mode)      pay the fare, spend the time, move.
                            mode defaults to 'walk'.
   enter(locId)             the 3D world walked Wally in — no fare
   nearest(x, z)            nearest location to a world position

   economy.*                see economy.js. TICKERS ARE FIRST-CLASS:
                            every asset argument accepts an id OR a
                            ticker. economy.findByTicker('gold'),
                            economy.search('whe'), economy.label(id)
                            -> 'GOLD · Gold Seam Token',
                            economy.ticket(order) -> '2x WHEAT · GOLD'
   clients.*                see clients.js. clients.ticket(order),
                            clients.ordersUnlocked()
   quests.*                 see quests.js. current() is the MAIN chain
                            and only the main chain; sideCurrent() /
                            sides() / startSide(id) are the side quests
   story.*                  the opening beats — happyPending(),
                            happyReady(), beats()
   actions.*                jobs, food, sleep, school, office, homes,
                            farm, mine, ipo, stadium, devlab, team,
                            bank, pawn, desk, buyBike/equipBike/bike,
                            metHappy
   save() load() exportSave() importSave(text) newGame() hasSave()

   ------------------------------------------------------------
   STATE FIELDS OTHER MODULES CARE ABOUT
   ------------------------------------------------------------
   state.bike               {owned, equipped} — buy it, then ride it
   state.sides              {questId: 'active'|'done'} side quests
   state.travel             last mode used; 'walk' on a new game
   state.flags.readMentor   the opening phone message has been read
   state.flags.metHappy     the Happy encounter has played out
   state.flags.metFriend    Otto has been met at the cafe
   state.flags.dispatchShift a shift has been worked at Dispatch;
                            client orders are unlocked

   ------------------------------------------------------------
   EVENTS on ctx.bus
   ------------------------------------------------------------
   'day'     {day, weather, income}   a new day began
   'hour'    {hour, minutes, day}     the hour rolled over
   'money'   {money, delta, why}
   'rep'     {rep, delta}
   'unlock'  {key, ...}               venue / location / feature
   'quest'   {kind:'complete'|'advance'|'milestone', ...}
   'client'  {kind:'arrive'|'accept'|'complete'|'fail'|'meet'|'trust'}
   'quest'   {kind:'side:start'|'side:complete', quest, title, from}
   'story'   {beat:'happy'|'happy:done'|'cafe'|'dispatch', ...}
             THE OPENING BEATS. 'happy' is the NPC agent's cue; they
             call ctx.game.actions.metHappy() when it is over.
   'bike'    {owned, equipped, bought}
   also: 'place' 'travel' 'trade' 'inv' 'tokenize' 'news' 'note'
         'msg' 'banner' 'tip' 'save' 'state' 'endgame' 'ready:game'
   ============================================================ */

import DATA, {
  CONFIG, LOC_BY_ID, ZONES, TRAVEL, BIKE, JOBS, COURSE_BY_ID, OFFICE_STAGES,
  HOME_BY_ID, HOMES, EMPLOYEE_BY_ID, IPOS, IPO_STEPS, STADIUM_STEPS,
  ASSETS, ASSET_BY_ID, CLIENT_BY_ID, MORNING_NOTES, fare, worldDistance,
} from './data.js';
import { newState, createState, mulberry32, hashStr, clamp, round2 } from './state.js';
import { createEconomy } from './economy.js';
import { createClients } from './clients.js';
import { createQuests } from './quests.js';
import { createSave } from './save.js';

/* Walking used to be computed here from the real 3D distance at 1.55 m/s,
   which made crossing the whole island a nine-minute stroll: the island is
   ~900 m across but stands in for a city. Walking is now a first-class
   mode in data.js's TRAVEL table, priced in hops like everything else, so
   there is one fare model and one place to tune it. `metres` is still
   attached below for the Places app, from the real distance. */
const WALK_TRUDGE = 1.6;   // time multiplier when he sets off already spent

/* A minimal bus for headless use (tools/test-game.mjs). Mirrors
   createBus() in core/contracts.js, which we cannot import here. */
function localBus() {
  const map = new Map();
  return {
    on(t, fn) { if (!map.has(t)) map.set(t, new Set()); map.get(t).add(fn); return () => map.get(t)?.delete(fn); },
    once(t, fn) { const off = this.on(t, (...a) => { off(); fn(...a); }); return off; },
    emit(t, p) { const s = map.get(t); if (!s) return; for (const fn of [...s]) { try { fn(p); } catch (e) { console.error('[bus]', t, e); } } },
    clear() { map.clear(); },
  };
}

/* ============================================================
   createGame — the whole system, with no ctx required.
   ============================================================ */
export function createGame(opts = {}) {
  const bus = opts.bus || localBus();
  const makeRng = opts.makeRng || ((seed) => mulberry32(typeof seed === 'string' ? hashStr(seed) : seed));
  const rng = opts.rng || makeRng(opts.seed ?? 0x5eed1e);

  /* The shared env every submodule closes over. Late-bound on
     purpose: economy needs quests, quests needs economy. */
  const env = {
    data: DATA,
    bus, rng, makeRng,
    state: null,
    setState(s) { env.state = s; },
    officeLoc: () => (env.state && env.state.office >= 1 ? 'office' : 'apartment'),
  };

  env.state = newState(makeRng('newgame'));
  env.mutate = createState(env);
  env.economy = createEconomy(env);
  env.clients = createClients(env);
  env.quests = createQuests(env);
  env.save = createSave(env);

  const S = () => env.state;
  const M = env.mutate;
  const econ = env.economy;
  const clients = env.clients;
  const quests = env.quests;
  const saveSys = env.save;

  let autosaveAt = 0;
  let lastHour = -1;

  /* a default minigame score when the UI has no minigame to run */
  const defaultScore = () => 0.46 + rng() * 0.44;

  /* ============================================================
     TIME
     ============================================================ */
  function phaseOf(h) {
    return h < 6 ? 'Night' : h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : h < 21 ? 'Evening' : 'Night';
  }

  const time = {
    get day() { return S().day; },
    get minutes() { return S().time; },
    get hour() { return Math.floor(S().time / 60) % 24; },
    get minute() { return Math.floor(S().time % 60); },
    get phase() { return phaseOf(time.hour); },
    get norm() { return ((S().time / 60) % 24) / 24; },
    get weather() { return S().weather; },
    clock() {
      const h = time.hour, m = time.minute;
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ' · ' + phaseOf(h);
    },
    advance(mins, energy = 0) { return advance(mins, energy); },
  };

  function advance(mins, energy = 0) {
    const st = S();
    if (!Number.isFinite(mins) || mins <= 0) mins = 0;
    mins *= st.settings.relaxed ? 0.7 : 1;

    const beforeHour = Math.floor(st.time / 60);
    st.time += mins;
    M.addHunger(mins / 60 * CONFIG.hungerPerHour);
    if (energy) M.addEnergy(-energy);
    if (st.hunger >= 98) M.addEnergy(-(mins / 60 * 2));

    if (st.hunger > 84 && !st.flags.hwarn) { st.flags.hwarn = true; M.note('bad', 'Wally is very hungry'); }
    if (st.hunger < 62) st.flags.hwarn = false;
    if (st.energy < 16 && !st.flags.ewarn) { st.flags.ewarn = true; M.note('bad', 'Wally is running on empty'); }
    if (st.energy > 42) st.flags.ewarn = false;

    const afterHour = Math.floor(st.time / 60);
    for (let h = beforeHour + 1; h <= afterHour; h++) {
      const hh = h % 24;
      if (hh !== lastHour) { lastHour = hh; bus.emit('hour', { hour: hh, minutes: st.time, day: st.day }); }
    }

    clients.tick(mins);

    if (st.time >= CONFIG.forceSleepMin) collapse();
    if (opts.autosave !== false && Date.now() - autosaveAt > 45000) {
      autosaveAt = Date.now();
      saveSys.save(st, true);
    }
    return st.time;
  }

  function collapse() {
    M.note('bad', 'You fell asleep at the desk.');
    M.addRep(-1);
    rollDay(true);
  }

  function sleep() {
    const st = S();
    const home = HOME_BY_ID[st.home] || HOME_BY_ID.rusty;
    M.banner('GOODNIGHT', 'Day ' + st.day + ' complete');
    st.energy = home.rest;
    rollDay(false);
    saveSys.save(st, true);
    return { ok: true, day: st.day };
  }

  function rollDay(collapsed) {
    const st = S();
    const income = econ.newDay();
    M.addHunger(collapsed ? 24 : 11);
    if (st.loan > 0) M.pay(-Math.max(4, Math.round(st.loan * 0.02)), 'loan interest');
    /* The desk is cleared every morning — yesterday's walk-ins have
       gone home. STORY ORDERS DO NOT: an order carrying `keep` is one
       a character handed Wally as part of a beat, and evaporating it
       overnight would leave its quest permanently unfinishable. It
       still expires on its own deadline like anything else. */
    st.arrivals = st.arrivals.filter((o) => o.keep && st.day <= o.deadline);
    clients.resetClock();
    clients.seedArrivals();
    clients.dailyOffers();
    /* A friend nags. If the side quest is open but his order is gone —
       lapsed, or wiped by an older save — put it back with a fresh
       deadline, so the quest can always be finished. */
    if (quests.isSideActive('q_side_otto')
      && !st.orders.some((o) => o.client === 'otto')
      && !st.arrivals.some((o) => o.client === 'otto')) {
      const again = firstOrder();
      if (again) {
        clients.addArrival(again);
        M.msg('Otto', 'Still after that thing for the display case, whenever you are passing. No rush. Mild rush.');
      }
    }

    for (const n of MORNING_NOTES) {
      if (n.day === st.day && (!n.when || n.when(st))) M.msg(n.from, n.msg);
    }
    quests.milestones();
    quests.check();
    lastHour = -1;
    bus.emit('day', { day: st.day, weather: st.weather, income });
    return income;
  }

  /* ============================================================
     PLACE + TRAVEL
     ============================================================ */
  const here = () => LOC_BY_ID[S().loc];
  const officeLoc = env.officeLoc;

  function isOpen(locId) {
    const l = LOC_BY_ID[locId];
    if (!l) return false;
    const hour = time.hour;
    return hour >= l.hours[0] && hour < l.hours[1];
  }
  const known = (locId) => quests.knows(locId);
  const visibleLocations = () => DATA.locations.filter((l) => quests.knows(l.id));

  /* ------------------------------------------------------------
     Every way of getting from here to `dest`, priced.

     WALKING IS NEVER REFUSED. That is the rule this function exists
     to keep: a player with no money and no energy must still be able
     to move, or the game is over without saying so. If Wally sets off
     with less energy than the walk costs he still goes — it takes
     WALK_TRUDGE times as long, he arrives on empty, and the option
     carries `trudge: true` and a `warn` string so the UI can say so
     rather than greying the button out.

     Returned per mode:
       mode n ico note        identity, straight from TRAVEL
       cost mins energy hops  the fare (data.js fare())
       metres                 real 3D distance, walking only
       ok why                 may he take it, and why not
       trudge warn            walking on empty
     ------------------------------------------------------------ */
  function fares(dest) {
    const st = S();
    const out = [];
    const freeRides = st.employees.includes('reg');     // Reg drives you
    for (const mode of Object.keys(TRAVEL)) {
      const t = TRAVEL[mode];
      const f = fare(mode, st.loc, dest);
      if (freeRides) f.cost = 0;
      let why = null, trudge = false, warn = null;

      if (mode === 'walk') {
        /* the floor — always available */
        if (st.energy < f.energy) {
          trudge = true;
          f.mins = Math.round(f.mins * WALK_TRUDGE);
          warn = 'You will arrive on your last legs.';
        }
      } else if (mode === 'bike') {
        if (!st.bike.owned) why = 'you do not own a bicycle';
        else if (!st.bike.equipped) why = 'your bicycle is not with you';
        else if (st.energy < f.energy) why = 'too tired to pedal';
      } else if (mode === 'train') {
        if (time.hour >= 0 && time.hour < 5) why = 'no metro before 05:00';
        else if (st.energy < f.energy) why = 'too drained for the metro';
        else if (!econ.afford(f.cost)) why = 'not enough cash';
      } else {
        if (!econ.afford(f.cost)) why = 'not enough cash';
      }

      const row = { mode, ...t, ...f, ok: !why, why };
      if (mode === 'walk') {
        row.metres = Math.round(worldDistance(st.loc, dest));
        row.trudge = trudge;
        row.warn = warn;
      }
      out.push(row);
    }
    /* walk first: it is the one that is always there */
    out.sort((a, b) => (a.mode === 'walk' ? -1 : b.mode === 'walk' ? 1 : 0));
    return out;
  }

  /* Fast travel: charge the fare, burn the clock, move.
     Default mode is WALKING — you do not own a bicycle yet. */
  function travel(locId, mode = 'walk') {
    const st = S();
    if (!LOC_BY_ID[locId]) return { ok: false, why: 'No such place' };
    if (locId === st.loc) return { ok: true, already: true };
    if (!quests.knows(locId)) return { ok: false, why: 'You have not heard of this place yet' };
    const opt = fares(locId).find((f) => f.mode === mode);
    if (!opt) return { ok: false, why: 'No such travel mode' };
    if (!opt.ok) return { ok: false, why: opt.why };

    if (opt.cost) M.pay(-opt.cost, 'fare');
    st.travel = mode;
    st.stats.trips++;
    if (opt.metres) st.stats.metres += opt.metres;
    advance(opt.mins, opt.energy);
    const first = M.setLoc(locId);
    bus.emit('travel', { to: locId, mode, cost: opt.cost, mins: opt.mins, first });
    quests.check();
    storyBeats();
    if (first) M.note('token', 'Discovered ' + LOC_BY_ID[locId].n);
    return { ok: true, first, cost: opt.cost, mins: opt.mins, trudge: !!opt.trudge };
  }

  /* The 3D world walked Wally through a door. No fare, no clock jump —
     the walking already cost him the time. */
  function enter(locId) {
    const st = S();
    if (!LOC_BY_ID[locId]) return { ok: false, why: 'No such place' };
    if (locId === st.loc) return { ok: true, already: true };
    if (!quests.knows(locId)) return { ok: false, why: 'You have not heard of this place yet' };
    st.travel = 'walk';
    const first = M.setLoc(locId);
    bus.emit('travel', { to: locId, mode: 'walk', cost: 0, mins: 0, first });
    quests.check();
    storyBeats();
    if (first) M.note('token', 'Discovered ' + LOC_BY_ID[locId].n);
    return { ok: true, first };
  }

  /* Nearest location to a 3D position — the world module uses this to
     decide which building Wally is standing in front of. */
  function nearest(x, z, maxDist = Infinity) {
    let best = null, bestD = Infinity;
    for (const l of DATA.locations) {
      const d = Math.hypot(l.world.x - x, l.world.z - z);
      if (d < bestD) { bestD = d; best = l; }
    }
    return bestD <= maxDist ? { loc: best, dist: round2(bestD) } : null;
  }
  function zoneAt(x, z) {
    for (const k of Object.keys(ZONES)) {
      const w = ZONES[k].world;
      if (x >= w.min.x && x <= w.max.x && z >= w.min.z && z <= w.max.z) return ZONES[k];
    }
    return null;
  }

  /* ============================================================
     THE OPENING STORY BEATS

     Three beats, in this order, all owned here so that the NPC, UI
     and world agents only have to listen:

       1  PHONE     Otto's welcome is already in state.msgs when the
                    game starts (state.js). Reading it sets
                    flags.readMentor and closes the first objective.
       2  HAPPY     fired the instant the phone is read, as
                      bus.emit('story', { beat: 'happy' })
                    The NPC agent plays the encounter and calls
                      ctx.game.actions.metHappy()
                    when it is over, which sets flags.metHappy.
                    story.happyPending() is true in between, so an
                    encounter interrupted by a reload can be replayed.
       3  DISPATCH  a shift at Dispatch sets flags.dispatchShift and
                    unlocks client arrivals. Emits beat 'dispatch'.

     And alongside them, not in the main chain at all:

       CAFE        walking into 'cafe' after the phone message meets
                   Otto, puts a small order on the desk and starts the
                   SIDE quest q_side_otto. Emits beat 'cafe' with the
                   order attached. The main objective is untouched.

     Every beat is idempotent and guarded by a flag, so calling
     storyBeats() on every arrival, every load and every boot is safe.
     ============================================================ */
  function storyBeats() {
    const st = S();
    if (st.loc === 'cafe' && st.flags.readMentor && !st.flags.metFriend) cafeBeat();
  }

  function cafeBeat() {
    const st = S();
    if (st.flags.metFriend) return { ok: false, why: 'already met' };
    M.flag('metFriend');
    clients.meet('otto');                       // pushes his intro line to the phone
    /* His order goes on the desk like any other, so the player learns
       the normal loop on it. It is exempt from the Dispatch gate — it
       is the errand a friend asks for over coffee, not city business. */
    /* If one of his rolled orders is already ON the desk, throw it back
       and hand over the authored one instead. Otto is a budget-1
       client, so the daily roll may well have queued him a $900 basket
       before the player ever met him — and "the friend's first order"
       has to be the small, affordable, hand-built one. An order he has
       already ACCEPTED is left alone; it satisfies the side quest by
       itself. */
    let order = st.orders.find((o) => o.client === 'otto') || null;
    if (!order) {
      for (const stale of st.arrivals.filter((o) => o.client === 'otto')) clients.removeArrival(stale);
      order = firstOrder();
      if (order) clients.addArrival(order);
    }
    quests.startSide('q_side_otto');
    M.msg('Otto', 'Good to see you upright. That is the whole job — you get me the '
      + (order ? econ.ticket(order) : 'thing we talked about') + ', I pay you more than it cost me. '
      + 'Do not overthink it, and do not tell anyone I said "portfolio".');
    bus.emit('story', { beat: 'cafe', client: 'otto', order, side: 'q_side_otto' });
    quests.check();
    return { ok: true, order };
  }

  /* OTTO'S ORDER — hand-built, not rolled.

     clients.makeOrder() prices against a client's ceiling, and Otto's
     ceiling on day one reaches as far as a $480 gallery collection —
     which a player holding $250 and one shift's pay cannot buy, and
     which is not what "a friend asks you for a small thing over
     coffee" should feel like. So the very first order is the cheapest
     thing he could plausibly want for the arcade, one unit, with a
     long deadline and a friend's margin on top. Everything after this
     one is rolled normally. */
  function firstOrder() {
    const st = S();
    const shortlist = ['sneaks', 'card', 'arcade', 'bakery']
      .map((id) => ASSET_BY_ID[id])
      .filter((a) => a && econ.venueOpen(a.ven));
    const pick = shortlist.sort((a, b) => econ.price(a.id) - econ.price(b.id))[0];
    if (!pick) return clients.makeOrder('otto');       // fallback: the normal roll
    const cost = econ.buyPrice(pick.id);
    return {
      id: 'o_otto_first',
      client: 'otto',
      type: 'deliver',
      name: null,
      items: [{ a: pick.id, q: 1, t: pick.tick }],
      budget: Math.round(cost * 1.18),                 // he is not haggling with you
      fee: Math.round(cost * 0.12) + 30,
      deadline: st.day + 5,                            // and he is not in a hurry
      made: st.day,
      warned: false,
      keep: true,                                      // survives the nightly desk wipe
      line: 'One thing. For the display case. You buy it, I pay you back and a bit more, and we both pretend that was complicated.',
    };
  }

  /* HAPPY — the NPC beat right after the phone. */
  function fireHappy() {
    const st = S();
    if (st.flags.metHappy || st.flags.happyFired) return false;
    M.flag('happyFired');
    bus.emit('story', { beat: 'happy', loc: st.loc, day: st.day });
    return true;
  }

  const story = {
    /* has the Happy encounter been announced but not yet played out? */
    happyPending: () => !!S().flags.happyFired && !S().flags.metHappy,
    /* should it fire at all yet? */
    happyReady: () => !!S().flags.readMentor && !S().flags.metHappy,
    metFriend: () => !!S().flags.metFriend,
    ordersUnlocked: () => clients.ordersUnlocked(),
    /* re-announce a beat that was interrupted by a reload */
    replayHappy() { S().flags.happyFired = false; return fireHappy(); },
    beats: () => ({
      phone: !!S().flags.readMentor,
      happy: !!S().flags.metHappy,
      cafe: !!S().flags.metFriend,
      dispatch: !!S().flags.dispatchShift,
    }),
  };

  /* ============================================================
     ACTIONS
     ============================================================ */
  function needEnergy(n) { return S().energy >= n; }

  const actions = {
    /* ---- jobs ---- */
    work(key, score = defaultScore()) {
      const st = S();
      const j = JOBS[key];
      if (!j) return { ok: false, why: 'No such shift' };
      if (j.night && time.hour > 4 && time.hour < 19) return { ok: false, why: 'That shift starts after 19:00' };
      if (!needEnergy(j.en)) return { ok: false, why: 'Not enough energy for a ' + j.hrs + '-hour shift' };
      if (st.hunger > 92) return { ok: false, why: 'Too hungry to work — eat something first' };

      advance(j.hrs * 60, j.en);
      st.stats.minigames++;
      const pay = Math.round(j.base + clamp(score, 0, 1) * j.mult);
      M.pay(pay, 'shift');
      st.stats.jobsDone++;
      if (score > 0.7) M.addRep(1);

      /* THE SECOND BEAT OF THE OPENING. A shift at Dispatch — either
         of the two driving shifts, both of which are worked there — is
         what puts Wally's name about, and it is the gate on the first
         client order (see clients.ordersUnlocked). Derived from
         JOBS[key].locs so adding a third Dispatch shift needs no edit
         here. */
      if (!st.flags.dispatchShift && (j.locs || []).includes('trunkdepot')) {
        M.flag('dispatchShift');
        M.note('token', 'Word gets round. Somebody will want you at your desk.');
        bus.emit('story', { beat: 'dispatch', loc: st.loc, day: st.day });
        clients.seedArrivals();
      }

      let extra = null;
      if (score > 0.62 && rng() < 0.3) {
        if (key === 'warehouse' || key === 'nightsort') {
          const pool = ASSETS.filter((a) => a.cat === 'Culture' && a.v < 700);
          const f = pool[Math.floor(rng() * pool.length)];
          if (f && econ.invCount() + 1 <= econ.invCap()) {
            econ.add(f.id, 1, 0);
            extra = { kind: 'find', asset: f.id, text: 'Under a pallet: ' + f.n + ', unclaimed for years. It is yours.' };
          }
        } else if (key === 'drive' || key === 'nightdrive') {
          const un = clients.all().filter((c) => !clients.met(c.id) && c.budget <= 2);
          if (un.length) {
            const c = un[Math.floor(rng() * un.length)];
            clients.meet(c.id);
            extra = { kind: 'meet', client: c.id, text: 'Your last fare was ' + c.n + ', ' + c.role.toLowerCase() + '. They took your number.' };
          }
        } else if (key === 'cleanup' && !st.flags.seatF12) {
          st.flags.seatF12 = true;
          M.addRep(2);
          extra = { kind: 'lore', text: 'You found row F, seat 12 — the seat in the poster. Someone carved a date into it.' };
        }
      }
      quests.check();
      return { ok: true, pay, score, extra };
    },

    /* ---- food ---- */
    eat(cost, fill) {
      const st = S();
      if (!econ.afford(cost)) return { ok: false, why: 'Not enough for that' };
      M.pay(-cost, 'food');
      M.addHunger(-fill);
      M.addEnergy(fill * 0.25);
      st.stats.meals++;
      advance(30, 0);
      return { ok: true, hunger: st.hunger };
    },
    /* accepts the 'food:4:26' act string straight from the location */
    eatAct(act) {
      const p = String(act).split(':');
      return actions.eat(+p[1], +p[2]);
    },

    sleep,

    /* ---- the phone ----
       The UI drives this when the player opens Messages. It also
       closes the very first objective, so it must live on the game
       API rather than inside the UI's own state. */
    readMessages() {
      const st = S();
      let n = 0;
      for (const m of st.msgs) if (!m.read) { m.read = true; n++; }
      const first = M.flag('readMentor');
      if (first) {
        quests.check();
        fireHappy();          // beat 2: the NPC agent takes it from here
        storyBeats();         // in case he read it while standing in the cafe
      }
      return { ok: true, read: n, first };
    },
    unreadCount() { return S().msgs.filter((m) => !m.read).length; },

    /* ---- HAPPY ----
       THE HOOK THE NPC AGENT CALLS. The encounter itself belongs to
       them; the flag belongs here, because quests, saves and the
       replay-after-reload path all read it.

         flag        state.flags.metHappy
         event in    bus 'story' { beat: 'happy' }   (we emit)
         call back   ctx.game.actions.metHappy()     (they call)
         event out   bus 'story' { beat: 'happy:done' }
         query       ctx.game.story.happyPending() */
    metHappy() {
      const st = S();
      const first = M.flag('metHappy');
      if (first) {
        M.note('good', 'You met Happy.');
        bus.emit('story', { beat: 'happy:done', loc: st.loc, day: st.day });
        quests.check();
      }
      return { ok: true, first };
    },

    /* ---- the bicycle ----
       Owning it and riding it are separate. Sold at Dispatch and at
       Vic's pawn shop (BIKE.locs), both in Rusty Row, both open on
       day one. */
    canBuyBike() {
      const st = S();
      if (st.bike.owned) return { ok: false, why: 'You already have a bicycle', cost: BIKE.cost };
      if (!BIKE.locs.includes(st.loc)) {
        return { ok: false, cost: BIKE.cost, locs: BIKE.locs,
          why: 'Bicycles are sold at ' + BIKE.locs.map((l) => LOC_BY_ID[l].n).join(' and ') };
      }
      if (!econ.afford(BIKE.cost)) return { ok: false, why: 'You need $' + BIKE.cost, cost: BIKE.cost };
      return { ok: true, cost: BIKE.cost };
    },
    buyBike() {
      const chk = actions.canBuyBike();
      if (!chk.ok) return chk;
      const st = S();
      M.pay(-BIKE.cost, BIKE.n);
      st.bike.owned = true;
      st.bike.equipped = true;
      M.banner('A BICYCLE', BIKE.line);
      /* No M.unlock('bike') — state.bike.owned is the one source of
         truth for this, and unlock() would add a second, duplicate
         toast next to the banner. Listen for the 'bike' event. */
      bus.emit('bike', { owned: true, equipped: true, bought: true });
      quests.check();
      return { ok: true, cost: BIKE.cost, bike: { ...st.bike } };
    },
    /* Take it with you, or leave it chained up. */
    equipBike(on = true) {
      const st = S();
      if (!st.bike.owned) return { ok: false, why: 'You do not own a bicycle' };
      st.bike.equipped = !!on;
      /* state.travel stays honest: it is the last mode actually used,
         not the one he intends to use next. */
      bus.emit('bike', { owned: true, equipped: st.bike.equipped, bought: false });
      return { ok: true, bike: { ...st.bike } };
    },
    bike() { return { ...S().bike, cost: BIKE.cost, locs: BIKE.locs, n: BIKE.n }; },

    /* ---- library ---- */
    study() {
      if (!needEnergy(12)) return { ok: false, why: 'Too tired to read' };
      advance(120, 12);
      M.addRep(1);
      quests.check();
      return { ok: true, rep: 1 };
    },
    archive(score = defaultScore()) {
      const st = S();
      if (st.unlocks.treasury) return { ok: false, why: 'You already have Treasury credentials' };
      if (!st.skills.fundamentals) return { ok: false, why: 'Take Market Fundamentals at the school first' };
      advance(60, 8);
      st.stats.minigames++;
      if (score < 0.45) return { ok: false, why: 'You filed the 1988 harbour accounts under livestock. Try again.', failed: true };
      M.unlock('treasury');
      M.addRep(4);
      M.banner('TREASURY ACCESS', 'City bonds unlocked');
      M.msg('Treasury Clerk', 'Your credentials cleared. Bonds are available at the Treasury, 09:00 to 15:00.');
      quests.check();
      return { ok: true };
    },

    /* ---- school ---- */
    courseAvailable(id) {
      const c = COURSE_BY_ID[id], st = S();
      if (!c) return { ok: false, why: 'No such course' };
      if (st.skills[id]) return { ok: false, why: 'Already passed' };
      const needs = (c.req || []).filter((r) => !st.skills[r]);
      if (needs.length) return { ok: false, why: 'Needs ' + needs.map((r) => COURSE_BY_ID[r].n).join(', ') };
      if (!econ.afford(c.cost)) return { ok: false, why: 'Not enough cash' };
      if (!needEnergy(c.energy)) return { ok: false, why: 'Too tired to study' };
      return { ok: true, course: c };
    },
    enrol(id, score = defaultScore()) {
      const chk = actions.courseAvailable(id);
      if (!chk.ok) return chk;
      const st = S(), c = chk.course;
      M.pay(-c.cost, 'tuition');
      advance(c.hours * 60, c.energy);
      st.stats.classes++;
      st.stats.minigames++;
      if (score < 0.4) {
        return { ok: false, failed: true, why: 'Not this time. The fee is spent and the afternoon is gone.' };
      }
      st.skills[id] = true;
      M.addRep(c.rep);
      if (id === 'fundamentals') M.flag('badgeEligible');
      if (id === 'mobile') M.flag('walletCourse');
      M.banner('PASSED', c.n);
      bus.emit('unlock', { key: 'skill', skill: id });
      quests.check();
      return { ok: true, skill: id, score };
    },

    /* ---- office ---- */
    nextOffice() { return OFFICE_STAGES[S().office + 1] || null; },
    upgradeOffice() {
      const st = S();
      const nx = OFFICE_STAGES[st.office + 1];
      if (!nx) return { ok: false, why: 'Wally Tower is the top' };
      if (st.rep < nx.rep) return { ok: false, why: 'Reputation ' + nx.rep + ' required' };
      if (!econ.afford(nx.cost)) return { ok: false, why: 'Not enough cash' };
      M.pay(-nx.cost, 'office');
      st.office++;
      M.banner('OFFICE UPGRADED', nx.n);
      bus.emit('unlock', { key: 'office', stage: st.office });
      quests.check();
      return { ok: true, stage: st.office, name: nx.n };
    },

    /* ---- homes ---- */
    moveHome(id) {
      const st = S();
      const hm = HOME_BY_ID[id];
      if (!hm) return { ok: false, why: 'No such home' };
      if (st.home === id) return { ok: false, why: 'You live here' };
      const idx = HOMES.findIndex((h) => h.id === id);
      const cur = HOMES.findIndex((h) => h.id === st.home);
      if (idx < cur) return { ok: false, why: 'Already past this' };
      if (id === 'penthouse' && (st.rep < 90 || st.stadium.step < 10)) {
        return { ok: false, why: 'Reputation 90 and the Stampede saved' };
      }
      if (!econ.afford(hm.cost)) return { ok: false, why: 'Not enough cash' };
      M.pay(-hm.cost, 'home');
      st.home = id;
      M.banner('MOVED IN', hm.n);
      bus.emit('unlock', { key: 'home', home: id });
      quests.check();
      return { ok: true, home: id };
    },

    /* ---- team ---- */
    hire(id) {
      const st = S();
      const e = EMPLOYEE_BY_ID[id];
      if (!e) return { ok: false, why: 'No such person' };
      if (st.employees.includes(id)) return { ok: false, why: 'Already on the team' };
      if (st.employees.length >= st.office + 1) return { ok: false, why: 'No free seat — upgrade the office' };
      if (!econ.afford(e.salary * 3)) return { ok: false, why: 'You need three days of salary in hand' };
      st.employees.push(id);
      bus.emit('unlock', { key: 'employee', employee: id });
      quests.check();
      return { ok: true, employee: id };
    },
    fire(id) {
      const st = S();
      if (!st.employees.includes(id)) return { ok: false, why: 'Not on the team' };
      st.employees = st.employees.filter((x) => x !== id);
      M.addRep(-1);
      return { ok: true };
    },

    /* ---- farm ---- */
    farmFixIrrigation(score = defaultScore()) {
      const st = S();
      if (st.farm.irrigation) return { ok: false, why: 'Already fixed' };
      if (!needEnergy(14)) return { ok: false, why: 'Too tired' };
      advance(120, 14);
      st.stats.minigames++;
      if (score < 0.42) return { ok: false, failed: true, why: 'The valve is still weeping. Go again.' };
      st.farm.irrigation = true;
      M.addRep(3);
      clients.meet('maple');
      quests.check();
      return { ok: true };
    },
    farmBuyIn() {
      const st = S();
      if (st.farm.owned) return { ok: false, why: 'Already a partner' };
      if (!st.farm.irrigation) return { ok: false, why: 'Fix the irrigation first' };
      if (!econ.afford(2400)) return { ok: false, why: 'Not enough cash' };
      M.pay(-2400, 'farm partnership');
      st.farm.owned = true;
      st.farm.lvl = 1;
      M.unlock('farmcoop');
      M.banner('PARTNER', "Maple's Farm");
      quests.check();
      return { ok: true };
    },
    farmBuild(what) {
      const st = S();
      const costs = { barn: 3200, cold: 6500 };
      if (!(what in costs)) return { ok: false, why: 'No such building' };
      if (st.farm[what]) return { ok: false, why: 'Already built' };
      if (!st.farm.owned) return { ok: false, why: 'Buy into the farm first' };
      if (!econ.afford(costs[what])) return { ok: false, why: 'Not enough cash' };
      M.pay(-costs[what], 'farm');
      st.farm[what] = true;
      return { ok: true };
    },
    farmUpgrade() {
      const st = S();
      if (!st.farm.owned) return { ok: false, why: 'Buy into the farm first' };
      const cost = 2000 * (st.farm.lvl + 1);
      if (!econ.afford(cost)) return { ok: false, why: 'Not enough cash' };
      M.pay(-cost, 'farm');
      st.farm.lvl++;
      return { ok: true, level: st.farm.lvl };
    },
    farmHarvest(score = defaultScore()) {
      const st = S();
      if (!st.farm.owned) return { ok: false, why: 'Buy into the farm first' };
      if (!needEnergy(16)) return { ok: false, why: 'Too tired' };
      advance(180, 16);
      st.stats.minigames++;
      const pool = ASSETS.filter((a) => a.cat === 'Farm' && (a.farm || 1) <= st.farm.lvl + 1);
      const pick = pool[Math.floor(rng() * pool.length)];
      if (!pick) return { ok: false, why: 'Nothing is in season' };
      const qty = 1 + Math.floor(score * 2) + (st.farm.barn ? 1 : 0);
      if (econ.invCount() + qty > econ.invCap()) return { ok: false, why: 'No inventory space' };
      econ.add(pick.id, qty, 0);
      quests.check();
      return { ok: true, asset: pick.id, qty };
    },

    /* ---- mine ---- */
    mineRights(score = defaultScore()) {
      const st = S();
      if (st.mine.rights) return { ok: false, why: 'You already have the records' };
      if (!st.skills.mining) return { ok: false, why: 'Take Mining and Safety first' };
      advance(90, 12);
      st.stats.minigames++;
      if (score < 0.42) return { ok: false, failed: true, why: 'Goldie is not convinced yet.' };
      st.mine.rights = true;
      M.addRep(4);
      clients.meet('goldie');
      return { ok: true };
    },
    mineCertifyLift() {
      const st = S();
      if (st.mine.elevator) return { ok: false, why: 'Already certified' };
      if (!st.mine.rights) return { ok: false, why: 'Get the records from Goldie first' };
      if (!econ.afford(2600)) return { ok: false, why: 'Not enough cash' };
      M.pay(-2600, 'mine');
      st.mine.elevator = true;
      return { ok: true };
    },
    mineOpen(score = defaultScore()) {
      const st = S();
      if (st.mine.owned) return { ok: false, why: 'Already open' };
      if (!st.mine.elevator) return { ok: false, why: 'Certify the elevator first' };
      advance(150, 16);
      st.stats.minigames++;
      if (score < 0.45) return { ok: false, failed: true, why: 'The safety inspector is not happy.' };
      st.mine.safety = true;
      st.mine.owned = true;
      st.mine.lvl = 1;
      M.unlock('mineral');
      M.banner('REOPENED', 'The Old Bull Bear Mine');
      quests.check();
      return { ok: true };
    },
    mineUpgrade() {
      const st = S();
      if (!st.mine.owned) return { ok: false, why: 'Reopen the mine first' };
      const cost = 3600 * (st.mine.lvl + 1);
      if (!econ.afford(cost)) return { ok: false, why: 'Not enough cash' };
      M.pay(-cost, 'mine');
      st.mine.lvl++;
      return { ok: true, level: st.mine.lvl };
    },
    mineDig(score = defaultScore()) {
      const st = S();
      if (!st.mine.owned) return { ok: false, why: 'Reopen the mine first' };
      if (!needEnergy(20)) return { ok: false, why: 'Too tired' };
      advance(180, 20);
      st.stats.minigames++;
      const pool = ASSETS.filter((a) => a.cat === 'Minerals' && (a.mine || 1) <= st.mine.lvl + 1);
      const pick = pool[Math.floor(rng() * pool.length)];
      if (!pick) return { ok: false, why: 'The seam is dry' };
      const qty = score > 0.7 ? 2 : 1;
      if (econ.invCount() + qty > econ.invCap()) return { ok: false, why: 'No inventory space' };
      econ.add(pick.id, qty, 0);
      quests.check();
      return { ok: true, asset: pick.id, qty };
    },

    /* ---- IPOs ---- */
    ipoStep(ipoId) { return S().ipo[ipoId] || 0; },
    ipoGate(ipoId) {
      const st = S(), ip = IPOS.find((x) => x.id === ipoId);
      if (!ip) return { ok: false, why: 'No such listing' };
      if ((st.ipo[ipoId] || 0) >= IPO_STEPS.length) return { ok: false, why: 'Already listed' };
      if (!st.skills.valuation) return { ok: false, why: 'Needs Business Valuation' };
      if (st.rep < 55) return { ok: false, why: 'Reputation 55 required' };
      if (st.office < 3) return { ok: false, why: 'Needs a Professional Office' };
      if (!econ.afford(ip.cost)) return { ok: false, why: 'Needs $' + econ.fmt(ip.cost) + ' of working capital' };
      return { ok: true, ipo: ip };
    },
    ipoAdvance(ipoId, score = defaultScore()) {
      const gate = actions.ipoGate(ipoId);
      if (!gate.ok) return gate;
      const st = S(), ip = gate.ipo;
      const step = st.ipo[ipoId] || 0;
      if (!needEnergy(14)) return { ok: false, why: 'Too tired for this' };
      if (step === 0) M.pay(-ip.cost, 'listing costs');
      advance(150, 14);
      st.stats.minigames++;
      if (score < 0.42) return { ok: false, failed: true, why: 'That stage did not land. We go again.' };

      st.ipo[ipoId] = step + 1;
      M.addRep(3);
      if (st.ipo[ipoId] >= IPO_STEPS.length) {
        st.prices[ipoId] = econ.clampPrice(ipoId, ip.price * (0.9 + score * 0.5));
        econ.add(ipoId, 25, 0);
        st.stats.ipos++;
        M.unlock('exchange');
        M.addRep(10);
        M.banner('LISTED', ASSET_BY_ID[ipoId].n + ' is public');
        M.msg(CLIENT_BY_ID[ip.client].n, 'We rang the bell. I have no idea what happens now. Thank you.');
        quests.check();
        quests.milestones();
        return { ok: true, listed: true, ipo: ipoId };
      }
      quests.check();
      return { ok: true, listed: false, step: st.ipo[ipoId], title: IPO_STEPS[step].t };
    },

    /* ---- the stadium questline ---- */
    stadiumStep() { return S().stadium.step; },
    stadiumGate() {
      const st = S();
      const step = st.stadium.step;
      if (step >= STADIUM_STEPS.length) return { ok: false, why: 'The Stampede belong to the city' };
      const sp = STADIUM_STEPS[step];
      if (step === 0 && (st.rep < 42)) return { ok: false, why: 'Coach Thunder does not know your name yet' };
      if (sp.cost && !econ.afford(sp.cost)) return { ok: false, why: 'Not enough cash' };
      if (step === 6 && clients.trustedCount(6) < 8) {
        return { ok: false, why: 'Eight clients at trust 6 or better · you have ' + clients.trustedCount(6) };
      }
      if (step === 7 && !(st.tokenized.rights && st.tokenized.concess && st.tokenized.academy)) {
        return { ok: false, why: 'Tokenize the broadcast rights, concessions and academy first' };
      }
      if (!needEnergy(16)) return { ok: false, why: 'Too tired' };
      return { ok: true, step, spec: sp };
    },
    stadiumAdvance(score = defaultScore()) {
      const gate = actions.stadiumGate();
      if (!gate.ok) return gate;
      const st = S(), sp = gate.spec;
      if (sp.cost) M.pay(-sp.cost, 'stampede');
      advance(180, 16);
      st.stats.minigames++;
      if (score < 0.42) return { ok: false, failed: true, why: 'Not good enough. Not from you. Go again.' };

      st.stadium.step++;
      M.addRep(4);
      if (st.stadium.step === 2) M.unlock('stadiumoffice');
      if (st.stadium.step === 5) st.stadium.restored = true;
      if (st.stadium.step >= STADIUM_STEPS.length) {
        econ.add('stampede', 1, 0);
        st.tokenized.stampede = true;
        st.stats.tokenized++;
        M.addRep(20);
        M.banner('THE STAMPEDE BELONG TO THE CITY', '12,000 supporters own a piece');
        M.msg('Coach Thunder', 'Row F, seat 12. Saturday. You are sitting in it.');
      } else {
        M.note('good', STADIUM_STEPS[st.stadium.step - 1].t + ' complete');
      }
      quests.check();
      quests.milestones();
      return { ok: true, step: st.stadium.step };
    },

    /* ---- dev lab ---- */
    buyWallet() {
      const st = S();
      if (st.unlocks.wallet) return { ok: false, why: 'Already installed' };
      if (!st.skills.mobile) return { ok: false, why: 'Needs Mobile Asset Management' };
      if (!econ.afford(900)) return { ok: false, why: 'Not enough cash' };
      M.pay(-900, 'lab');
      M.unlock('wallet');
      return { ok: true };
    },
    buyRemote() {
      const st = S();
      if (st.unlocks.remote) return { ok: false, why: 'Already active' };
      if (!st.unlocks.wallet) return { ok: false, why: 'Install the wallet first' };
      if (!econ.afford(2400)) return { ok: false, why: 'Not enough cash' };
      M.pay(-2400, 'lab');
      M.unlock('remote');
      return { ok: true };
    },
    buildSwap(score = defaultScore()) {
      const st = S();
      if (st.swap.unlocked) return { ok: false, why: 'Wally Swap is live' };
      if (!st.skills.advmkt) return { ok: false, why: 'Needs Advanced Market Systems' };
      if (!st.employees.includes('kite')) return { ok: false, why: 'You need Kite, the software engineer' };
      if (st.office < 3) return { ok: false, why: 'Needs a Professional Office' };
      if (!econ.afford(45000)) return { ok: false, why: 'Not enough cash' };
      advance(180, 16);
      st.stats.minigames++;
      if (score < 0.5) return { ok: false, failed: true, why: 'The filing is not approved yet.' };
      M.pay(-45000, 'swap');
      st.swap.unlocked = true;
      M.unlock('swap');
      M.addRep(8);
      M.banner('WALLY SWAP IS LIVE', 'Automated pools for tokenized assets');
      quests.check();
      quests.milestones();
      return { ok: true };
    },
    addPool(id) {
      const st = S();
      if (!st.swap.unlocked) return { ok: false, why: 'Wally Swap is not live' };
      if (!st.tokenized[id]) return { ok: false, why: 'Tokenize it first' };
      if (st.swap.pools[id]) return { ok: false, why: 'Pool already exists' };
      const cost = Math.round(econ.price(id) * 0.5);
      if (!econ.afford(cost)) return { ok: false, why: 'Not enough cash' };
      M.pay(-cost, 'liquidity');
      st.swap.pools[id] = true;
      return { ok: true, cost };
    },

    /* ---- bank ---- */
    borrow(amount) {
      const st = S();
      const cap = 500 + st.rep * 120;
      if (amount <= 0) return { ok: false, why: 'Nothing to borrow' };
      if (st.loan + amount > cap) return { ok: false, why: 'Your credit line is $' + econ.fmt(cap) };
      st.loan = round2(st.loan + amount);
      M.pay(amount, 'loan');
      return { ok: true, loan: st.loan };
    },
    repay(amount) {
      const st = S();
      amount = Math.min(amount, st.loan, st.money);
      if (amount <= 0) return { ok: false, why: 'Nothing to repay' };
      M.pay(-amount, 'loan repayment');
      st.loan = round2(st.loan - amount);
      return { ok: true, loan: st.loan };
    },

    /* ---- pawn shop: four items a day, 14 % under market ---- */
    pawnStock() {
      const st = S();
      if (st.pawnDay !== st.day) {
        st.pawnDay = st.day;
        const pool = ASSETS.filter((a) => a.v < 900 && a.ven !== 'exchange' && a.ven !== 'treasury');
        st.pawnStock = [];
        for (let i = 0; i < 4 && pool.length; i++) {
          st.pawnStock.push(pool.splice(Math.floor(rng() * pool.length), 1)[0].id);
        }
      }
      return st.pawnStock.map((id) => ({ id, price: Math.round(econ.price(id) * 0.86) }));
    },
    pawnBuy(id) {
      const st = S();
      actions.pawnStock();
      if (!st.pawnStock.includes(id)) return { ok: false, why: 'Vic does not have that today' };
      const unit = Math.round(econ.price(id) * 0.86);
      const r = econ.buy(id, 1, null, unit);
      if (r.ok) st.pawnStock = st.pawnStock.filter((x) => x !== id);
      return r;
    },
    pawnSell(id, qty = 1) {
      if (econ.free(id) + 1e-4 < qty) return { ok: false, why: 'Those units are locked' };
      const unit = Math.round(econ.price(id) * 0.78);
      econ.remove(id, qty);
      M.pay(round2(unit * qty), 'pawned');
      return { ok: true, unit };
    },

    /* ---- Vance: institutional mandates ---- */
    vanceMandate() {
      const st = S();
      if (st.rep < 62) return { ok: false, why: 'Vance does not take meetings below reputation 62' };
      clients.meet('vance');
      if (clients.hasArrival('vance')) return { ok: false, why: 'His mandate is already on your desk' };
      const o = clients.makeOrder('vance');
      if (!o) return { ok: false, why: 'Nothing meets his criteria today' };
      clients.addArrival(o);
      return { ok: true, order: o };
    },

    /* ---- the desk: deliver + tokenize ---- */
    deliver(orderOrId) {
      const st = S();
      const o = typeof orderOrId === 'string' ? st.orders.find((x) => x.id === orderOrId) : orderOrId;
      if (!o) return { ok: false, why: 'No such order' };
      if (st.loc !== officeLoc()) return { ok: false, why: 'Deliver this at your desk' };
      return econ.completeOrder(o);
    },
    accept(orderOrId) {
      const st = S();
      const o = typeof orderOrId === 'string' ? st.arrivals.find((x) => x.id === orderOrId) : orderOrId;
      return econ.acceptOrder(o);
    },
    tokenize(id) { return econ.tokenize(id); },
  };

  /* ============================================================
     SAVE / LOAD / NEW
     ============================================================ */
  function bootState(fresh) {
    quests.refreshKnown(true);
    if (fresh) clients.seedArrivals();
    else if (!S().arrivals.length) clients.seedArrivals();
    lastHour = -1;
    storyBeats();
    bus.emit('ready:game', { day: S().day, loc: S().loc });
  }

  function newGame(seed) {
    const st = newState(makeRng(seed ?? 'newgame'));
    M.replace(st);
    bootState(true);
    return st;
  }
  function load() {
    const d = saveSys.load();
    if (!d) return null;
    M.replace(d);
    bootState(false);
    return d;
  }
  function importSave(text) {
    const d = saveSys.importJSON(text);
    if (!d) return null;
    M.replace(d);
    bootState(false);
    return d;
  }

  /* ============================================================
     the handle main.js hangs on ctx.game
     ============================================================ */
  const api = {
    data: DATA,
    get state() { return env.state; },
    time,
    economy: econ,
    clients,
    quests,
    story,
    actions,
    bus,

    /* place */
    here, officeLoc, isOpen, known, visibleLocations, fares, travel, enter,
    nearest, zoneAt,
    zoneOf: (locId) => (LOC_BY_ID[locId] ? ZONES[LOC_BY_ID[locId].z] : null),

    /* headline numbers the HUD reads every frame */
    hud() {
      const st = env.state;
      return {
        day: st.day, clock: time.clock(), phase: time.phase, weather: st.weather,
        money: st.money, rep: st.rep, energy: st.energy, hunger: st.hunger,
        loc: st.loc, zone: LOC_BY_ID[st.loc] ? LOC_BY_ID[st.loc].z : null,
        cityPct: econ.cityPct(), netWorth: econ.netWorth(),
        owned: econ.distinctOwned(), invCount: econ.invCount(), invCap: econ.invCap(),
        orders: st.orders.length, orderSlots: econ.orderSlots(),
        arrivals: st.arrivals.length,
        /* THE OBJECTIVE STRIP READS THIS, and it is the main chain
           only. A side quest lives in `sideObjective` and has its own
           quieter slot — it can never replace the main one. */
        objective: quests.current(),
        sideObjective: quests.sideCurrent(),
        bike: { ...st.bike },
      };
    },

    /* persistence */
    save: (quiet) => saveSys.save(env.state, quiet),
    load,
    hasSave: () => saveSys.has(),
    wipeSave: () => saveSys.wipe(),
    exportSave: () => saveSys.exportJSON(env.state),
    downloadSave: () => saveSys.download(env.state),
    importSave,
    newGame,

    /* frame hook — the game clock does NOT run on its own. Time moves
       when Wally does something. main.js still calls this; it only
       drains nothing today, and exists so future real-time systems
       (a market tick, a ferry timetable) have a home. */
    update(/* dt, elapsed */) {},
    dispose() { bus.clear(); },
  };

  bootState(true);
  return api;
}

/* ============================================================
   The module contract. main.js calls this.
   ============================================================ */
export async function init(ctx) {
  const game = createGame({
    bus: ctx.bus,
    rng: ctx.rng,
    makeRng: ctx.makeRng,
    seed: 0x5eed1e,
  });

  /* Continue an existing run when there is one, unless we are taking
     a screenshot — shots must be reproducible from a fresh state. */
  if (!ctx.flags?.shot && game.hasSave()) {
    try { game.load(); } catch (e) { console.warn('[game] save failed to load, starting fresh', e); }
  }

  if (typeof window !== 'undefined' && window.WALLY) {
    const d = window.WALLY.debug || (window.WALLY.debug = {});
    d.game = game;
    d.setDay = (n) => { while (game.state.day < n) game.actions.sleep(); return game.state.day; };
    d.giveMoney = (n) => { game.state.money = Math.max(0, game.state.money + n); return game.state.money; };
    d.unlockAll = () => {
      for (const k of ['exchange', 'treasury', 'farmcoop', 'mineral', 'stadiumoffice', 'wallet', 'remote', 'swap']) {
        game.state.unlocks[k] = true;
      }
      for (const c of game.data.courses) game.state.skills[c.id] = true;
      game.quests.refreshKnown(true);
      return Object.keys(game.state.known).length;
    };
    d.hud = () => game.hud();
  }

  return game;
}

export default init;
