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
                              ok, why, metres?, trudge?, warn?, ride?}]
                            'walk' is always ok. Order: walk, bike,
                            train (Metro), trunk (Yoober). The 'bike'
                            row is WHICHEVER RIDE IS EQUIPPED: `ride`
                            is its id and `n`/`ico` are its name and
                            glyph, so a scooter reads as a scooter.
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
                            bank, pawn, desk, metHappy, and THE RIDES:
                              rides()            every ride + status
                              ride()             the one under you
                              ridesFor(locId)    what is sold here
                              canBuyRide(id)     may he, and why not
                              buyRide(id)        pay, own, equip
                              grantRide(id)      a quest hands it over
                              equipRide(id|null) one at a time
                            buyBike/equipBike/bike still work and are
                            thin wrappers over the above.
   save() load() exportSave() importSave(text) newGame() hasSave()

   ------------------------------------------------------------
   STATE FIELDS OTHER MODULES CARE ABOUT
   ------------------------------------------------------------
   state.rides              {owned:{bike,scooter,motorcycle},
                             equipped:'bike'|'scooter'|'motorcycle'|null}
                            THE SOURCE OF TRUTH for what Wally rides.
                            One table in data.js (RIDES) with the
                            speeds; at most one equipped at a time.
   state.bike               LEGACY MIRROR of the bicycle row, written
                            from state.rides and never read (except by
                            the v6 migration). Do not write it.
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
   'bike'    {owned, equipped, bought, ride}
             LEGACY, and still the one character/wally.js listens to.
             `owned`/`equipped` are now "does he have ANY ride / is
             one with him", and `ride` names which — so a scooter
             still animates as a ride until there is a scooter model.
   'ride'    {kind:'buy'|'grant'|'equip'|'unequip', ride, owned,
              equipped, speed}   the full ride event
   'race'    {kind:'offer'|'start'|'checkpoint'|'finish'|'hint'|
              'abandon', ...}          THE MAYOR'S DASH — see race.*
   'rep'     now carries {title, next, toNext, pct, promoted}
   also: 'place' 'travel' 'trade' 'inv' 'tokenize' 'news' 'note'
         'msg' 'banner' 'tip' 'save' 'state' 'endgame' 'ready:game'

   ------------------------------------------------------------
   WHAT IS NEW IN THIS PASS (the rules layer is now the authority)
   ------------------------------------------------------------
   time.live / setLive / pause    THE CLOCK RUNS BY ITSELF now, at
                                  CONFIG.minutesPerSecond (0.5 — one
                                  in-game minute per two real
                                  seconds). game.update(dt) drives it.
   gate(key, opts)                ONE DOOR every action goes through.
                                  Returns {ok} or {ok:false, why,
                                  kind:'hunger'|'hours'|'place'}.
   needs()                        the hunger lock, and where the food
                                  is, for the UI to draw the refusal.
   openInfo(locId) / opensAt()    opening hours, as words.
   canEnter(locId)                may he go in — travel() and enter()
                                  both refuse a closed door now.
   rep()                          {rep, title, next, toNext, pct}
   race.*                         the Mayor's Dash. See RACE in
                                  data.js and the block below.
   actions.exchangeGate()         every condition on the Exchange
   actions.unlockExchange()       …and the door itself
   actions.producer('farm')       what a producer upgrade really does
   ============================================================ */

import DATA, {
  CONFIG, LOC_BY_ID, ZONES, TRAVEL, BIKE, RIDES, RIDE_ORDER, JOBS, COURSE_BY_ID, OFFICE_STAGES,
  HOME_BY_ID, HOMES, EMPLOYEE_BY_ID, EMPLOYEE_POOL, IPOS, IPO_STEPS, STADIUM_STEPS,
  ASSETS, ASSET_BY_ID, CLIENT_BY_ID, MORNING_NOTES, fare, worldDistance,
  RACE, PRODUCERS, SLATE_MEAL, repProgress, hops as hopsBetween,
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

  /* ------------------------------------------------------------
     THE LIVE CLOCK.

     CONFIG.minutesPerSecond was a dead number in both this build and
     the 2D original: nothing read it, so time only moved when Wally
     did something and every opening hour in the game was decoration.
     It is now the rate of a real clock, and the user set the rate:
     0.5, ONE in-game minute per TWO real seconds.

     Rules it obeys:
       * every ambient minute goes through advance(), so hunger, the
         'hour' event, client arrivals and the forced collapse all
         behave exactly as they do for a shift or a journey;
       * ambient time costs NO energy — standing about is not tiring,
         it is only fattening the hunger bar;
       * one frame may never add more than CONFIG.idleMaxMinutes, so
         an alt-tab, a breakpoint or a stalled tab cannot eat a day;
       * `paused` is the UI's switch (a menu, a dialogue, the pause
         screen), `live` is the build's (screenshots set it false so a
         posed frame is reproducible).
     ------------------------------------------------------------ */
  let clockLive = opts.liveClock !== undefined ? !!opts.liveClock : !!CONFIG.liveClock;
  let clockPaused = false;
  let clockCarry = 0;               // fractional in-game minutes not yet spent

  function tickClock(dt) {
    if (!clockLive || clockPaused) return 0;
    if (!Number.isFinite(dt) || dt <= 0) return 0;
    clockCarry += dt * CONFIG.minutesPerSecond;
    if (clockCarry < 0.25) return 0;                 // batch: ~2 s of real time
    const mins = Math.min(clockCarry, CONFIG.idleMaxMinutes);
    clockCarry = 0;
    advance(mins, 0);
    return mins;
  }

  const time = {
    get day() { return S().day; },
    get minutes() { return S().time; },
    get hour() { return Math.floor(S().time / 60) % 24; },
    get minute() { return Math.floor(S().time % 60); },
    get phase() { return phaseOf(time.hour); },
    get norm() { return ((S().time / 60) % 24) / 24; },
    get weather() { return S().weather; },
    /* the live clock, for the UI and the tools */
    get rate() { return CONFIG.minutesPerSecond; },
    get live() { return clockLive; },
    get paused() { return clockPaused; },
    get realSecondsPerHour() { return 60 / CONFIG.minutesPerSecond; },
    /* how much real time is left in this day, at the current rate */
    get realSecondsLeft() { return Math.max(0, (CONFIG.forceSleepMin - S().time) / CONFIG.minutesPerSecond); },
    setLive(on) { clockLive = !!on; clockCarry = 0; return clockLive; },
    pause(on = true) { clockPaused = !!on; if (clockPaused) clockCarry = 0; return clockPaused; },
    resume() { return time.pause(false); },
    tick(dt) { return tickClock(dt); },
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

    if (st.hunger > CONFIG.hungerWarnAt && !st.flags.hwarn) { st.flags.hwarn = true; M.note('bad', 'Wally is very hungry'); }
    if (st.hunger < 62) st.flags.hwarn = false;
    /* MAXIMUM HUNGER LOCKS THE GAME DOWN TO EATING. Said once, loudly,
       on the way in, with the nearest bowl named — the refusals do the
       rest (see gate()). */
    if (starving(st) && !st.flags.starving) {
      st.flags.starving = true;
      const f = nearestFood(st);
      M.banner('TOO HUNGRY', f ? 'Nothing else until you eat · ' + f.n : 'Nothing else until you eat');
      M.note('bad', hungerLine(f));
    }
    if (!starving(st) && st.flags.starving) st.flags.starving = false;
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
    /* YOU SLEEP WHERE THE BED IS. The apartment is open 00:00–24:00
       and walking there is never refused, so this can never strand
       anybody — it is the night escape from the hunger lock. */
    if (!isBedLoc(st.loc)) {
      return { ok: false, kind: 'place', why: 'Your bed is at ' + LOC_BY_ID.apartment.n + ' — you are not there.' };
    }
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

  function isOpen(locId, atMin) {
    const l = LOC_BY_ID[locId];
    if (!l) return false;
    const hour = Math.floor((atMin == null ? S().time : atMin) / 60) % 24;
    return hour >= l.hours[0] && hour < l.hours[1];
  }
  const known = (locId) => quests.knows(locId);
  const visibleLocations = () => DATA.locations.filter((l) => quests.knows(l.id));

  /* ============================================================
     OPENING HOURS — and THE RULES LAYER IS THE AUTHORITY.

     Every location has always carried `hours`, and until now nothing
     enforced them. isOpen() existed, the Places app drew "closed ·
     09:00–16:00" beside a building, the HUD door prompt said the same
     — and then travel(), enter() and every action let the player
     straight in anyway, because the only checks were in the UI. So
     the Stock Exchange traded at four in the morning.

     Three doors are now shut in this file instead:
       travel(dest)   refuses a closed destination
       enter(dest)    refuses a locked door in the 3D world
       gate(key,{loc}) refuses the ACTS of a closed venue — every
                      shift, meal, class, dig, harvest and counter.
     and economy.buy/sell refuse a closed VENUE (economy.js), which is
     the same rule one level down: the venue hours and the hours of
     the building the venue lives in are the same numbers.
     ============================================================ */
  const pad2 = (n) => String(Math.floor(n)).padStart(2, '0');
  const hhmm = (h) => pad2(h) + ':00';

  /* Everything the UI needs to describe a door, in one object. */
  function openInfo(locId, atMin) {
    const l = LOC_BY_ID[locId];
    if (!l) return null;
    const always = l.hours[0] === 0 && l.hours[1] >= 24;
    const open = isOpen(locId, atMin);
    const hour = Math.floor((atMin == null ? S().time : atMin) / 60) % 24;
    let opensIn = 0;
    if (!open) opensIn = (l.hours[0] - hour + 24) % 24;
    return {
      id: l.id, n: l.n, open, always,
      hours: l.hours.slice(),
      opens: hhmm(l.hours[0]), closes: hhmm(l.hours[1]),
      span: hhmm(l.hours[0]) + '–' + hhmm(l.hours[1]),
      opensInHours: opensIn,
      label: always ? 'always open'
        : open ? 'open until ' + hhmm(l.hours[1])
          : 'closed · opens at ' + hhmm(l.hours[0]),
    };
  }
  const opensAt = (locId) => (LOC_BY_ID[locId] ? hhmm(LOC_BY_ID[locId].hours[0]) : null);
  /* the one sentence every hours refusal uses */
  function closedLine(locId) {
    const l = LOC_BY_ID[locId];
    if (!l) return 'That place does not exist.';
    return l.n + ' is closed — it opens at ' + hhmm(l.hours[0]) + ' (' + openInfo(locId).span + ').';
  }

  /* ============================================================
     THE HUNGER LOCK.

     "When you are max hunger you shouldn't be able to do anything
     other than go eat." At CONFIG.hungerLockAt (100) every action in
     this file refuses, and says which way the food is.

     THE THREE THINGS THAT STILL WORK, because without them he is
     bricked rather than hungry:
       eating          obviously, including the slate (below)
       sleeping        the night escape: the noodle cart shuts at
                       23:00, so a starving player at 02:00 must be
                       able to go to bed and wake up at 07:00
       moving to food  travel() and enter() still work, but ONLY to
                       somewhere that feeds him or somewhere with a
                       bed in it
     and the FLOOR under all of it: SLATE_MEAL. If he is at maximum
     hunger and cannot afford the cheapest bowl in the city, the
     noodle cart feeds him on the slate, once a day. Broke AND
     starving is therefore slow and embarrassing, never terminal.
     ============================================================ */
  const isFoodLoc = (id) => !!LOC_BY_ID[id] && LOC_BY_ID[id].acts.some((a) => a.startsWith('food:'));
  const isBedLoc = (id) => !!LOC_BY_ID[id] && LOC_BY_ID[id].acts.includes('sleep');
  /* a declaration, not a const: advance() is above this line and must
     be able to call it whenever it runs */
  function starving(st = S()) { return st.hunger >= CONFIG.hungerLockAt - 1e-6; }

  const foodLocs = () => DATA.locations.filter((l) => isFoodLoc(l.id));
  /* Cheapest meal a location sells, parsed out of its own act strings. */
  function mealsAt(locId) {
    const l = LOC_BY_ID[locId];
    if (!l) return [];
    return l.acts.filter((a) => a.startsWith('food:')).map((a) => {
      const p = a.split(':');
      return { act: a, cost: +p[1], fill: +p[2] };
    }).sort((x, y) => x.cost - y.cost);
  }
  /* The food he should walk to: known places first, open ones first,
     then nearest, then cheapest. Never returns null — the noodle cart
     is `see: 0`, so there is always at least one. */
  function nearestFood(st = S()) {
    const from = st.loc;
    const rows = foodLocs().map((l) => {
      const meal = mealsAt(l.id)[0] || { cost: 0, fill: 0 };
      const info = openInfo(l.id);
      return {
        id: l.id, n: l.n, zone: ZONES[l.z].n, ico: l.ico,
        hops: hopsBetween(from, l.id), here: l.id === from,
        known: quests.knows(l.id), open: info.open, opens: info.opens, span: info.span,
        cost: meal.cost, fill: meal.fill, act: meal.act,
        afford: econ.afford(meal.cost),
      };
    });
    rows.sort((a, b) =>
      (b.known - a.known) || (b.open - a.open) || (a.hops - b.hops) || (a.cost - b.cost));
    return rows[0] || null;
  }
  /* THE SLATE. Only ever available when the alternative is a dead end:
     maximum hunger, standing somewhere that sells food, during its
     hours, unable to afford the cheapest thing on the counter, and not
     already fed this way today. Outside those five conditions it does
     not exist, so it can never be farmed. */
  function slateOffer() {
    const st = S();
    if (!starving(st)) return { ok: false, why: 'You can still pay for a meal' };
    if (!isFoodLoc(st.loc)) {
      const f = nearestFood(st);
      return { ok: false, why: f ? 'Ask at ' + f.n : 'Not here', food: f };
    }
    if (!isOpen(st.loc)) return { ok: false, kind: 'hours', why: closedLine(st.loc) };
    const cheapest = mealsAt(st.loc)[0];
    if (cheapest && econ.afford(cheapest.cost)) return { ok: false, why: 'You can afford to pay for that' };
    if (st.slateDay === st.day) return { ok: false, why: 'You are already on the slate today' };
    return { ok: true, fill: SLATE_MEAL.fill, mins: SLATE_MEAL.mins, line: SLATE_MEAL.line };
  }

  function hungerLine(f) {
    if (!f) return 'Wally is too hungry to do anything but eat.';
    if (f.here && f.open) return 'Wally is too hungry for anything else. There is food right here.';
    if (!f.open) return 'Wally is too hungry for anything else. ' + f.n + ' opens at ' + f.opens
      + ' — sleep it off and eat in the morning.';
    return 'Wally is too hungry for anything else. The nearest food is ' + f.n + ' in ' + f.zone
      + ', ' + f.hops + (f.hops === 1 ? ' hop' : ' hops') + ' away.';
  }

  /* ============================================================
     gate(key, opts) — ONE DOOR, and every action goes through it.

       key    what he is trying to do: 'eat' 'sleep' 'travel' 'work'
              'class' 'trade' 'race' or anything else (anything not
              listed is locked by hunger)
       opts   { loc }   the place the act belongs to. Defaults to
                        where he is standing. Pass null to skip the
                        hours check.
              { act }   an act string the location must actually
                        offer ('job:cafe', 'food:', 'market:mineral')
              { verb }  what to put in the refusal sentence

     Returns {ok:true} or {ok:false, why, kind}. `kind` is 'hunger',
     'hours' or 'place', so the UI can choose an icon without parsing
     English.
     ============================================================ */
  const HUNGER_FREE = new Set(['eat', 'sleep', 'travel', 'enter', 'phone', 'story', 'read', 'look']);

  function gate(key, opts = {}) {
    const st = S();
    /* 1. HUNGER, first, because it beats everything else. */
    if (starving(st) && !HUNGER_FREE.has(key)) {
      const f = nearestFood(st);
      return { ok: false, kind: 'hunger', why: hungerLine(f), food: f, hunger: st.hunger };
    }
    /* 2. THE PLACE. `loc` defaults to where he is standing. */
    const locId = opts.loc === undefined ? st.loc : opts.loc;
    if (locId == null) return { ok: true };
    const l = LOC_BY_ID[locId];
    if (!l) return { ok: false, kind: 'place', why: 'No such place' };
    if (opts.act && !hasAct(locId, opts.act)) {
      return { ok: false, kind: 'place', why: 'You cannot ' + (opts.verb || 'do that') + ' at ' + l.n + '.' };
    }
    if (locId !== st.loc && opts.here !== false) {
      return { ok: false, kind: 'place', why: 'That is done at ' + l.n + ' — you are not there.' };
    }
    /* 3. THE HOURS. */
    if (!isOpen(locId)) return { ok: false, kind: 'hours', why: closedLine(locId), loc: locId, opens: opensAt(locId) };
    return { ok: true };
  }
  /* Does this location offer this act? A trailing colon is a prefix
     match, so 'food:' means "any meal" and 'job:cafe' means that one
     shift. */
  function hasAct(locId, act) {
    const l = LOC_BY_ID[locId];
    if (!l || !act) return false;
    return act.endsWith(':') ? l.acts.some((a) => a.startsWith(act)) : l.acts.includes(act);
  }
  /* Where an act can be done at all — for a refusal that points. */
  function locsWithAct(act) {
    return DATA.locations.filter((l) => hasAct(l.id, act)).map((l) => l.id);
  }
  /* A refusal that names the place instead of just saying no. */
  function needPlace(act, verb) {
    const ids = locsWithAct(act);
    if (!ids.length) return { ok: false, kind: 'place', why: 'Nowhere in this city does that.' };
    return {
      ok: false, kind: 'place', locs: ids,
      why: verb + ' at ' + ids.map((i) => LOC_BY_ID[i].n).join(' or ') + ' — you are not there.',
    };
  }
  /* The whole gate for an act done at the place you are standing in:
     hunger, then "does this place do that", then the hours. */
  function gateAct(key, act, verb) {
    const st = S();
    if (starving(st) && !HUNGER_FREE.has(key)) return gate(key);
    if (!hasAct(st.loc, act)) return needPlace(act, verb);
    if (!isOpen(st.loc)) return { ok: false, kind: 'hours', why: closedLine(st.loc), loc: st.loc, opens: opensAt(st.loc) };
    return { ok: true };
  }
  env.gate = gate;
  env.starving = starving;
  env.nearestFood = nearestFood;
  env.hungerLine = hungerLine;
  env.isOpenLoc = isOpen;
  env.closedLine = closedLine;

  /* May he go in? The one answer travel(), enter() and the HUD door
     prompt all share. */
  function canEnter(locId) {
    const st = S();
    if (!LOC_BY_ID[locId]) return { ok: false, kind: 'place', why: 'No such place' };
    if (!quests.knows(locId)) return { ok: false, kind: 'place', why: 'You have not heard of this place yet' };
    if (!isOpen(locId)) return { ok: false, kind: 'hours', why: closedLine(locId), opens: opensAt(locId) };
    if (starving(st) && !isFoodLoc(locId) && !isBedLoc(locId)) {
      const f = nearestFood(st);
      return { ok: false, kind: 'hunger', why: hungerLine(f), food: f };
    }
    return { ok: true };
  }

  /* The hunger lock, as one object the UI can render. */
  function needs() {
    const st = S();
    const f = nearestFood(st);
    return {
      hunger: st.hunger, energy: st.energy,
      starving: starving(st),
      lockedBy: starving(st) ? 'hunger' : null,
      why: starving(st) ? hungerLine(f) : null,
      food: f,
      slate: slateOffer(),
      warnAt: CONFIG.hungerWarnAt, lockAt: CONFIG.hungerLockAt,
    };
  }

  /* ============================================================
     RIDES

     state.rides is the source of truth:
       { owned: {bike, scooter, motorcycle}, equipped: id|null }
     and data.js's RIDES table holds the speeds. ONE EQUIPPED AT A
     TIME — `equipped` is a single id, so the constraint is the shape
     of the data rather than a rule somebody has to remember.

     syncRides() is the reconciliation, and it is idempotent and
     cheap. It (1) fills in a missing rides record, (2) ADOPTS a
     directly-poked state.bike — that is how a v6 save arrives, and
     how tools/traveltest.mjs sets up its bicycle leg — (3) drops an
     equipped ride that is not owned, and (4) writes state.bike back
     as the legacy mirror. Everything that reads a ride calls it
     first, so there is no path where the two disagree.
     ============================================================ */
  const RIDE_IDS = Object.keys(RIDES);

  function syncRides(st = S()) {
    if (!st.rides || typeof st.rides !== 'object') st.rides = { owned: {}, equipped: null };
    if (!st.rides.owned || typeof st.rides.owned !== 'object') st.rides.owned = {};
    for (const id of RIDE_IDS) if (typeof st.rides.owned[id] !== 'boolean') st.rides.owned[id] = false;
    if (st.bike && typeof st.bike === 'object' && st.bike.owned && !st.rides.owned.bike) {
      st.rides.owned.bike = true;
      if (!st.rides.equipped && st.bike.equipped) st.rides.equipped = 'bike';
    }
    if (!RIDES[st.rides.equipped] || !st.rides.owned[st.rides.equipped]) st.rides.equipped = null;
    st.bike = { owned: !!st.rides.owned.bike, equipped: st.rides.equipped === 'bike' };
    return st.rides;
  }

  const ownsRide = (id) => !!syncRides().owned[id];
  const anyRide = () => RIDE_IDS.some((id) => syncRides().owned[id]);
  const equippedRide = () => RIDES[syncRides().equipped] || null;
  /* fastest thing in the shed, equipped or not */
  const bestRide = () => RIDES[RIDE_ORDER.find((id) => syncRides().owned[id])] || null;
  /* what a 'bike' fare should be priced at: what he is on, or failing
     that what he could be on, or failing that the plain bicycle so the
     board can still quote a number for a thing he does not own. */
  const fareRide = () => equippedRide() || bestRide() || RIDES.bike;

  /* One ride, as the UI wants it. */
  function rideView(id) {
    const r = RIDES[id];
    if (!r) return null;
    const rs = syncRides();
    const u = r.unlock;
    return {
      id: r.id, name: r.name, n: r.n, short: r.short, ico: r.ico,
      speed: r.speed, effort: r.effort,
      desc: r.desc, line: r.line,
      unlock: u.kind, price: r.price, questId: r.questId,
      rep: u.rep || 0, locs: u.locs || [],
      buyable: u.kind === 'buy',
      owned: !!rs.owned[r.id],
      equipped: rs.equipped === r.id,
    };
  }

  /* Own it. Shared by buyRide (money) and grantRide (a quest).
     Auto-equips when it is the best thing he has, because nobody
     buys a motorcycle in order to keep pushing a bicycle. */
  function takeRide(id, how, meta) {
    const st = S();
    const rs = syncRides(st);
    const r = RIDES[id];
    if (!r || rs.owned[id]) return false;
    rs.owned[id] = true;
    const cur = RIDES[rs.equipped];
    if (!cur || r.speed > cur.speed) rs.equipped = id;
    syncRides(st);
    M.banner(r.short.toUpperCase(), r.line);
    bus.emit('ride', { kind: how, ride: id, name: r.name, speed: r.speed,
      owned: { ...rs.owned }, equipped: rs.equipped, ...(meta || {}) });
    bus.emit('bike', { owned: anyRide(), equipped: !!equippedRide(), bought: how === 'buy', ride: rs.equipped });
    quests.check();
    return true;
  }

  /* THE QUEST DOOR. quests.completeSide() calls this through
     env.grantRide for any quest carrying a `ride`. */
  function grantRide(id, meta) {
    if (!RIDES[id]) return { ok: false, why: 'No such ride' };
    if (ownsRide(id)) return { ok: false, why: 'Already yours' };
    takeRide(id, 'grant', meta);
    return { ok: true, ride: rideView(id) };
  }
  env.grantRide = grantRide;

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
    syncRides(st);
    /* A CLOSED DESTINATION SHUTS EVERY ROW, walking included. The
       floor rule is unchanged in the way that matters — he can always
       walk somewhere that is OPEN, and his bed is open 00:00–24:00 —
       but "free, always available, never refused" was never meant to
       mean he can walk into a locked building. menus.js already greys
       a row and prints its `why`, so this is the whole fix. */
    const door = canEnter(dest);
    const freeRides = st.employees.includes('reg');     // Reg drives you
    /* THE 'bike' MODE IS WHATEVER HE IS RIDING. One row, priced at
       that ride's speed — a scooter's row says Scooter and quotes
       scooter minutes. */
    const mount = fareRide();
    for (const mode of Object.keys(TRAVEL)) {
      const t = TRAVEL[mode];
      const f = fare(mode, st.loc, dest, mode === 'bike' ? mount.id : undefined);
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
        if (!anyRide()) why = 'you do not own a bicycle';
        else if (!equippedRide()) why = 'your ' + mount.short.toLowerCase() + ' is not with you';
        else if (st.energy < f.energy) why = 'too tired to ride';
      } else if (mode === 'train') {
        if (time.hour >= 0 && time.hour < 5) why = 'no metro before 05:00';
        else if (st.energy < f.energy) why = 'too drained for the metro';
        else if (!econ.afford(f.cost)) why = 'not enough cash';
      } else {
        if (!econ.afford(f.cost)) why = 'not enough cash';
      }

      if (!door.ok && dest !== st.loc) { why = door.why; trudge = false; warn = null; }
      const row = { mode, ...t, ...f, ok: !why, why, closed: !door.ok, kind: why === door.why ? door.kind : null };
      /* the ride's identity wins over the mode's generic one */
      if (mode === 'bike') {
        row.ride = mount.id;
        row.rideName = mount.name;
        row.speed = mount.speed;
        row.n = mount.short;
        row.ico = mount.ico;
      }
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
    /* THE DOOR IS CHECKED BEFORE THE FARE. Travelling to a place that
       is shut used to work perfectly: you paid, you spent the hour,
       you arrived, and the closed sign meant nothing. */
    const door = canEnter(locId);
    if (!door.ok) return { ok: false, why: door.why, kind: door.kind, opens: door.opens, food: door.food };
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
    /* A LOCKED DOOR IS LOCKED FROM THE STREET TOO. hud.js already
       draws "closed · 09:00–16:00" over the prompt and toasts
       whatever this returns, so the sign and the door now agree. */
    const door = canEnter(locId);
    if (!door.ok) return { ok: false, why: door.why, kind: door.kind, opens: door.opens, food: door.food };
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
     THE MAYOR'S DASH — the race that gates the Stock Exchange.

     WHO OWNS WHAT.  This file owns the RULES and the STATE: the
     route, the checkpoints, the Mayor's pace, win, lose, retry and
     the hint. The UI agent owns the race on screen — the countdown,
     the checkpoint rings, the Mayor's kart and the results card — and
     talks to this through the API below and the 'race' bus event.
     Nothing here touches THREE or the DOM.

     THE EXACT NAMES THE UI AGENT NEEDS
       ctx.game.race.view()            everything, in one object
       ctx.game.race.status()          'locked'|'offered'|'running'|'lost'|'won'
       ctx.game.race.route()           [{i, loc, n, world:{x,y,z}, metres, total}]
       ctx.game.race.metres()          route length, metres
       ctx.game.race.pace()            {mayorSeconds, mps, rideSeconds, ride, qualified}
       ctx.game.race.offer()           the Mayor steps in (idempotent)
       ctx.game.race.canStart()        {ok, why}
       ctx.game.race.start()           {ok, mayorSeconds, mps, route, ride}
       ctx.game.race.checkpoint(i)     {ok, cp, next, remaining}
       ctx.game.race.finish(seconds)   {ok, won, seconds, mayorSeconds, margin,
                                        line, hint}
       ctx.game.race.abandon()         {ok}
       ctx.game.race.won()             boolean
       ctx.game.race.mayor()           the client record (Mayor Ken Jones)
     state:      state.race {status, attempts, losses, wins, best, cp, ...}
     bus event:  'race' {kind:'offer'|'start'|'checkpoint'|'finish'|
                          'hint'|'abandon', ...}

     PACING. pace() returns the Mayor's target time for THIS attempt,
     derived from the ride under Wally: 0.86 of an unqualified rider's
     realistic best (he pulls away) and 1.18 of a qualified one's (he
     is catchable). Run the Mayor's kart at `mps` metres per second
     and the race on screen will agree with the rule underneath it.
     ============================================================ */
  function raceState(st = S()) {
    if (!st.race || typeof st.race !== 'object') {
      st.race = { status: 'locked', attempts: 0, losses: 0, wins: 0, best: 0, startedAt: 0, cp: 0, day: 0, hintDay: 0, hints: 0 };
    }
    return st.race;
  }
  const raceWon = () => raceState().status === 'won';

  /* the route, as the UI wants to draw it */
  function raceRoute() {
    const out = [];
    let total = 0;
    for (let i = 0; i < RACE.route.length; i++) {
      const id = RACE.route[i];
      const l = LOC_BY_ID[id];
      const leg = i ? worldDistance(RACE.route[i - 1], id) : 0;
      total += leg;
      out.push({
        i, loc: id, n: l.n, ico: l.ico, zone: ZONES[l.z].n,
        world: { x: l.world.x, y: l.world.y, z: l.world.z },
        metres: Math.round(leg), total: Math.round(total),
        start: i === 0, finish: i === RACE.route.length - 1,
      });
    }
    return out;
  }
  function raceMetres() {
    let t = 0;
    for (let i = 1; i < RACE.route.length; i++) t += worldDistance(RACE.route[i - 1], RACE.route[i]);
    return Math.round(t);
  }
  /* What Wally is realistically capable of on what he is riding, and
     what the Mayor will therefore do. */
  function racePace() {
    const r = equippedRide();
    const rideId = r ? r.id : 'foot';
    const qualified = RACE.qualifies.includes(rideId);
    const top = RACE.street[rideId] || RACE.street.foot;
    const metres = raceMetres();
    const rideSeconds = metres / (top * RACE.efficiency);
    const mayorSeconds = Math.round(rideSeconds * (qualified ? RACE.slack : RACE.edge));
    return {
      ride: rideId,
      rideName: r ? r.short : 'On foot',
      qualified,
      metres,
      topSpeed: top,
      rideSeconds: Math.round(rideSeconds),
      mayorSeconds,
      mps: Math.round((metres / mayorSeconds) * 100) / 100,
    };
  }
  /* The same projection for a ride he is NOT on — the tools use it to
     prove that only the scooter and the motorcycle can win. */
  function raceProjection(rideId) {
    const top = RACE.street[rideId] || RACE.street.foot;
    const metres = raceMetres();
    return {
      ride: rideId, metres,
      seconds: Math.round(metres / (top * RACE.efficiency)),
      qualified: RACE.qualifies.includes(rideId),
    };
  }

  function raceView() {
    const st = S();
    const rs = raceState(st);
    const p = racePace();
    return {
      status: rs.status,
      offered: rs.status !== 'locked',
      running: rs.status === 'running',
      won: rs.status === 'won',
      attempts: rs.attempts, losses: rs.losses, wins: rs.wins,
      best: rs.best || 0, cp: rs.cp || 0,
      hints: rs.hints || 0,
      route: raceRoute(), metres: p.metres,
      checkpoints: RACE.route.length,
      mayor: CLIENT_BY_ID[RACE.mayor].n,
      hours: RACE.hours.slice(),
      mins: RACE.mins, energy: RACE.energy,
      pace: p,
      canStart: raceCanStart(),
    };
  }

  /* THE MAYOR STEPS IN. Idempotent, and it also makes every corner of
     his route a place Wally has heard of, so the UI can draw the line
     and the HUD can point at it. */
  function raceOffer(why) {
    const st = S();
    const rs = raceState(st);
    if (rs.status === 'won') return { ok: false, why: 'You already beat him' };
    const first = rs.status === 'locked';
    if (first) rs.status = 'offered';
    for (const id of RACE.route) st.known[id] = true;
    if (first) {
      clients.meet(RACE.mayor);
      M.banner('MAYOR KEN JONES', RACE.n);
      M.msg(CLIENT_BY_ID[RACE.mayor].n, RACE.lines.offer + ' ' + RACE.lines.start);
      bus.emit('race', { kind: 'offer', route: raceRoute(), metres: raceMetres(), first: true, why: why || null });
    }
    return { ok: true, first, view: raceView() };
  }

  function raceCanStart() {
    const st = S();
    const rs = raceState(st);
    /* hunger first, like everywhere else: a starving elephant does not
       race the Mayor, he goes and finds a bowl of noodles */
    const g = gate('race', { loc: null });
    if (!g.ok) return g;
    if (rs.status === 'won') return { ok: false, why: 'You have already beaten him' };
    if (rs.status === 'locked') return { ok: false, why: 'The Mayor has not asked you for anything' };
    if (rs.status === 'running') return { ok: false, why: 'You are in the middle of it' };
    const startId = RACE.route[0];
    if (st.loc !== startId) {
      return { ok: false, kind: 'place', why: 'The start line is outside ' + LOC_BY_ID[startId].n + '.', loc: startId };
    }
    const h = time.hour;
    if (h < RACE.hours[0] || h >= RACE.hours[1]) {
      return { ok: false, kind: 'hours', why: CLIENT_BY_ID[RACE.mayor].n + ' only races between '
        + hhmm(RACE.hours[0]) + ' and ' + hhmm(RACE.hours[1]) + '.' };
    }
    if (st.energy < RACE.energy) return { ok: false, why: 'Too tired to race anybody' };
    return { ok: true };
  }

  function raceStart() {
    const chk = raceCanStart();
    if (!chk.ok) return chk;
    const st = S();
    const rs = raceState(st);
    const p = racePace();
    rs.status = 'running';
    rs.attempts++;
    rs.cp = 0;
    rs.day = st.day;
    rs.startedAt = st.time;
    advance(RACE.mins, RACE.energy);
    const payload = { kind: 'start', route: raceRoute(), metres: p.metres,
      mayorSeconds: p.mayorSeconds, mps: p.mps, ride: p.ride, attempt: rs.attempts };
    bus.emit('race', payload);
    return { ok: true, ...payload, line: RACE.lines.start };
  }

  /* The UI calls this as he crosses each ring. Purely bookkeeping —
     the clock the result is judged on is the UI's. */
  function raceCheckpoint(i) {
    const rs = raceState();
    if (rs.status !== 'running') return { ok: false, why: 'You are not racing' };
    const want = (rs.cp || 0) + 1;
    const idx = i == null ? want : i;
    if (idx !== want) return { ok: false, why: 'Checkpoint ' + want + ' first', next: want };
    rs.cp = idx;
    const remaining = RACE.route.length - 1 - idx;
    bus.emit('race', { kind: 'checkpoint', cp: idx, remaining, of: RACE.route.length - 1 });
    return { ok: true, cp: idx, next: remaining > 0 ? idx + 1 : null, remaining };
  }

  /* THE RULE THE WHOLE THING EXISTS FOR.

     A win needs BOTH: a qualifying ride under him, and a clock that
     beat the Mayor's. The ride condition is checked first and it is
     absolute — on foot or on the bicycle he loses however fast the UI
     says he went, because the Mayor "was never going to lose that on
     the Main Street straight". The pacing above means this almost
     never has to fire: an unqualified rider cannot physically make
     the Mayor's time. It is here so that a bug in somebody else's
     clock cannot hand out the Stock Exchange. */
  function raceFinish(seconds) {
    const st = S();
    const rs = raceState(st);
    if (rs.status !== 'running') return { ok: false, why: 'You are not racing' };
    const p = racePace();
    const t = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : p.mayorSeconds + 1;
    const beatTheClock = t < p.mayorSeconds;
    const won = p.qualified && beatTheClock;

    rs.status = won ? 'won' : 'lost';
    if (!rs.best || t < rs.best) rs.best = t;
    let hint = null;
    if (won) {
      rs.wins++;
      M.addRep(6);
      M.banner('YOU BEAT THE MAYOR', p.rideName + ' · ' + t + 's to his ' + p.mayorSeconds + 's');
      M.msg(CLIENT_BY_ID[RACE.mayor].n, RACE.lines.won);
      M.note('good', 'The Stock Exchange will see you now.');
    } else {
      rs.losses++;
      M.note('bad', 'The Mayor got there first. ' + t + 's to his ' + p.mayorSeconds + 's.');
      M.msg(CLIENT_BY_ID[RACE.mayor].n, RACE.lines.lost);
      hint = raceHint();
    }
    quests.check();
    const payload = {
      kind: 'finish', won, seconds: t, mayorSeconds: p.mayorSeconds,
      margin: p.mayorSeconds - t, ride: p.ride, attempts: rs.attempts,
      losses: rs.losses, best: rs.best, hint,
      line: won ? RACE.lines.won : RACE.lines.lost,
    };
    bus.emit('race', payload);
    return { ok: true, ...payload };
  }

  function raceAbandon() {
    const rs = raceState();
    if (rs.status !== 'running') return { ok: false, why: 'You are not racing' };
    rs.status = rs.wins > 0 ? 'won' : 'lost';
    rs.cp = 0;
    bus.emit('race', { kind: 'abandon' });
    return { ok: true };
  }

  /* THE HINT. Never before the second loss, never twice in a day,
     and then only about a third of the time — the player is meant to
     work this out, and an NPC muttering it every single time is the
     objective text with extra steps. */
  function raceHint() {
    const st = S();
    const rs = raceState(st);
    if (rs.losses < RACE.hintAfter + 1) return null;
    if (rs.hintDay && st.day - rs.hintDay < RACE.hintCooldownDays) return null;
    if (rng() > RACE.hintChance) return null;
    const h = RACE.hints[Math.floor(rng() * RACE.hints.length) % RACE.hints.length];
    rs.hintDay = st.day;
    rs.hints = (rs.hints || 0) + 1;
    M.msg(h.from, h.text);
    bus.emit('race', { kind: 'hint', from: h.from, text: h.text, npc: h.from });
    return { from: h.from, text: h.text };
  }

  const race = {
    view: raceView,
    status: () => raceState().status,
    state: () => ({ ...raceState() }),
    route: raceRoute,
    metres: raceMetres,
    pace: racePace,
    projection: raceProjection,
    offer: raceOffer,
    canStart: raceCanStart,
    start: raceStart,
    checkpoint: raceCheckpoint,
    finish: raceFinish,
    abandon: raceAbandon,
    won: raceWon,
    hint: raceHint,
    mayor: () => CLIENT_BY_ID[RACE.mayor],
    qualifies: () => RACE.qualifies.slice(),
    spec: () => RACE,
  };

  /* ============================================================
     THE STOCK EXCHANGE DOOR.

     Four conditions, and the race is the NEW one — the other three
     are the path this game has always described in q_exchange and in
     the original's lockedWhy(): pass Market Fundamentals, do three
     client orders for the trader badge, pay the $1,500 access fee.
     None of them is replaced. The Mayor is simply also standing
     there.

     grantExchange() is the ONLY way state.unlocks.exchange is ever
     set, so the IPO path — which used to unlock the Exchange as a
     side effect of listing a company — cannot walk around him either.
     ============================================================ */
  function exchangeSteps() {
    const st = S();
    const rs = raceState(st);
    return [
      { key: 'fundamentals', t: 'Pass Market Fundamentals', where: 'school',
        done: !!st.skills.fundamentals },
      { key: 'badge', t: 'Complete ' + CONFIG.exchangeOrders + ' client orders for the trader badge',
        where: 'office', done: st.stats.ordersDone >= CONFIG.exchangeOrders,
        have: st.stats.ordersDone, need: CONFIG.exchangeOrders },
      { key: 'race', t: 'Settle it with ' + CLIENT_BY_ID[RACE.mayor].n, where: 'cafe',
        done: rs.status === 'won' },
      { key: 'fee', t: 'Pay the $' + CONFIG.exchangeFee + ' access fee', where: 'exchange',
        done: !!st.unlocks.exchange, cost: CONFIG.exchangeFee },
    ];
  }
  function exchangeGate() {
    const st = S();
    if (st.unlocks.exchange) return { ok: false, why: 'You are already a member', steps: exchangeSteps(), done: true };
    const steps = exchangeSteps();
    const g = gateAct('trade', 'market:exchange', 'The Exchange is');
    const missing = steps.filter((s) => !s.done && s.key !== 'fee');
    if (missing.length) {
      const s = missing[0];
      return { ok: false, kind: s.key === 'race' ? 'race' : 'gate', steps, why: s.key === 'race'
        ? RACE.lines.blocked
        : s.t + (s.have != null ? ' — you have ' + s.have + ' of ' + s.need : '') };
    }
    if (!g.ok) return { ...g, steps };
    if (!econ.afford(CONFIG.exchangeFee)) {
      return { ok: false, kind: 'money', steps, why: 'The access fee is $' + CONFIG.exchangeFee };
    }
    return { ok: true, steps, fee: CONFIG.exchangeFee };
  }
  /* The one door. `how` is 'fee' or 'ipo'. */
  function grantExchange(how) {
    const st = S();
    if (st.unlocks.exchange) return { ok: false, why: 'Already unlocked' };
    if (!raceWon()) {
      raceOffer('exchange');
      return { ok: false, kind: 'race', why: RACE.lines.blocked };
    }
    M.unlock('exchange');
    bus.emit('unlock', { key: 'exchange', how: how || 'fee' });
    quests.check();
    return { ok: true, how: how || 'fee' };
  }
  function unlockExchange() {
    const chk = exchangeGate();
    if (!chk.ok) {
      /* turning up with the paperwork in order is what summons him */
      if (chk.kind === 'race') raceOffer('exchange');
      return chk;
    }
    M.pay(-CONFIG.exchangeFee, 'Exchange membership');
    const r = grantExchange('fee');
    if (!r.ok) { M.pay(CONFIG.exchangeFee, 'refund'); return r; }
    M.addRep(6);
    M.banner('MEMBER', 'Bull Bear Stock Exchange');
    return { ok: true, fee: CONFIG.exchangeFee };
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
    /* THE MAYOR INTERRUPTS. Turning up at the Exchange with the class
       passed is what puts him in the doorway — before the fee, before
       the membership, before anything. Idempotent. */
    if (st.loc === 'exchange' && !st.unlocks.exchange && st.skills.fundamentals
      && raceState(st).status === 'locked') raceOffer('door');
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
    /* ---- jobs ----
       A SHIFT IS WORKED WHERE THE SHIFT IS, DURING OPENING HOURS.
       work() used to take a key and nothing else: you could drive a
       Dispatch shift from your bed at four in the morning. */
    work(key, score = defaultScore()) {
      const st = S();
      const j = JOBS[key];
      if (!j) return { ok: false, why: 'No such shift' };
      const g = gateAct('work', 'job:' + key, 'They want you');
      if (!g.ok) return g;
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

    /* ---- food ----
       EATING IS THE ONE THING MAXIMUM HUNGER DOES NOT REFUSE, so this
       is where the lock has to be un-lockable. Two floors:
         * the meal itself is gated on being somewhere that sells food,
           during its hours — you cannot eat at the Stock Exchange;
         * if he is at maximum hunger and cannot pay, the slate feeds
           him anyway (SLATE_MEAL), once a day. */
    eat(cost, fill) {
      const st = S();
      const g = gateAct('eat', 'food:', 'Food is sold');
      if (!g.ok) return g;
      if (!econ.afford(cost)) {
        const slate = slateOffer();
        if (slate.ok) return actions.slateMeal();
        return { ok: false, why: 'Not enough for that', kind: 'money' };
      }
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
    /* THE FOOD FLOOR. Broke and starving is not a game over. */
    slateOffer,
    slateMeal() {
      const st = S();
      const chk = slateOffer();
      if (!chk.ok) return chk;
      st.slateDay = st.day;
      M.addHunger(-SLATE_MEAL.fill);
      M.addEnergy(SLATE_MEAL.fill * 0.25);
      st.stats.meals++;
      advance(SLATE_MEAL.mins, 0);
      M.note('good', SLATE_MEAL.note);
      return { ok: true, slate: true, hunger: st.hunger, line: SLATE_MEAL.line };
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

    /* ---- THE RIDES ----
       Three vehicles, one table (data.js RIDES), one ownership record
       (state.rides). Owning and riding stay separate — a thing in the
       shed is not a thing under you — and only one is ever equipped.

         bicycle     $180, day one, at Dispatch or Vic's
         scooter     NOT FOR SALE. q_side_scooter hands it over.
                     1.5x the bicycle.
         motorcycle  $16,000 and rep 45, at Dispatch. 3x the bicycle.

       None of it is ever required: walking is free and never refused,
       so a broke, exhausted, ride-less player is slow, not stuck. */
    rides() { syncRides(); return RIDE_ORDER.map(rideView); },
    ride() { const r = equippedRide(); return r ? rideView(r.id) : null; },
    rideById: (id) => rideView(id),
    ownsRide,
    /* what is for sale at this place — the shop list the UI renders */
    ridesFor(locId) {
      return RIDE_ORDER.map(rideView).filter((r) => r && r.buyable && r.locs.includes(locId));
    },
    canBuyRide(id) {
      const st = S();
      const r = RIDES[id];
      if (!r) return { ok: false, why: 'No such ride' };
      const u = r.unlock;
      if (ownsRide(id)) return { ok: false, why: 'You already have the ' + r.short.toLowerCase(), price: r.price };
      /* THE SCOOTER CANNOT BE BOUGHT. Not here, not anywhere, not for
         any amount of money — it is a favour returned. */
      if (u.kind !== 'buy') {
        return { ok: false, price: 0, questId: r.questId,
          why: 'The ' + r.short.toLowerCase() + ' is not for sale at any price' };
      }
      if ((u.rep || 0) > st.rep) {
        return { ok: false, price: r.price, rep: u.rep,
          why: 'They will not sell you one below reputation ' + u.rep };
      }
      if (!u.locs.includes(st.loc)) {
        return { ok: false, price: r.price, locs: u.locs,
          why: r.short + 's are sold at ' + u.locs.map((l) => LOC_BY_ID[l].n).join(' and ') };
      }
      /* and the shop has to be OPEN — a counter is a counter */
      if (!isOpen(st.loc)) {
        return { ok: false, price: r.price, kind: 'hours', why: closedLine(st.loc), opens: opensAt(st.loc) };
      }
      const hg = gate('trade', { loc: null });
      if (!hg.ok) return { ...hg, price: r.price };
      if (!econ.afford(r.price)) return { ok: false, why: 'You need $' + r.price, price: r.price };
      return { ok: true, price: r.price };
    },
    buyRide(id) {
      const chk = actions.canBuyRide(id);
      if (!chk.ok) return chk;
      const r = RIDES[id];
      M.pay(-r.price, r.n);
      takeRide(id, 'buy');
      return { ok: true, cost: r.price, price: r.price, ride: rideView(id), bike: { ...S().bike } };
    },
    grantRide,
    /* Take one with you, or leave it all behind. Pass null to walk. */
    equipRide(id) {
      const st = S();
      const rs = syncRides(st);
      if (id == null) {
        const was = rs.equipped;
        rs.equipped = null;
        syncRides(st);
        bus.emit('ride', { kind: 'unequip', ride: was, owned: { ...rs.owned }, equipped: null });
        bus.emit('bike', { owned: anyRide(), equipped: false, bought: false, ride: null });
        return { ok: true, ride: null, bike: { ...st.bike } };
      }
      if (!RIDES[id]) return { ok: false, why: 'No such ride' };
      if (!rs.owned[id]) return { ok: false, why: 'You do not own the ' + RIDES[id].short.toLowerCase() };
      rs.equipped = id;                    // ONE AT A TIME: a single slot
      syncRides(st);
      /* state.travel stays honest: it is the last mode actually used,
         not the one he intends to use next. */
      bus.emit('ride', { kind: 'equip', ride: id, name: RIDES[id].name, speed: RIDES[id].speed,
        owned: { ...rs.owned }, equipped: id });
      bus.emit('bike', { owned: true, equipped: true, bought: false, ride: id });
      return { ok: true, ride: rideView(id), bike: { ...st.bike } };
    },

    /* ---- the bicycle, in the words the old API used ----
       ui/menus.js and anything written against v6 still call these.
       They are wrappers, not a second implementation: bike() reports
       the ride he is actually on, so a player who owns only a scooter
       does not get told to go and buy a bicycle. */
    canBuyBike() {
      const chk = actions.canBuyRide('bike');
      return { ...chk, cost: RIDES.bike.price, locs: RIDES.bike.unlock.locs };
    },
    buyBike() { return actions.buyRide('bike'); },
    equipBike(on = true) {
      if (!on) return actions.equipRide(null);
      const r = equippedRide() || bestRide();
      if (!r) return { ok: false, why: 'You do not own a bicycle' };
      return actions.equipRide(r.id);
    },
    bike() {
      syncRides();
      const cur = equippedRide() || bestRide() || RIDES.bike;
      return {
        owned: anyRide(),
        equipped: !!equippedRide(),
        id: cur.id, n: cur.n, short: cur.short, ico: cur.ico, speed: cur.speed,
        cost: RIDES.bike.price, locs: RIDES.bike.unlock.locs,
      };
    },

    /* ---- library ---- */
    study() {
      const g = gateAct('class', 'study', 'You read');
      if (!g.ok) return g;
      if (!needEnergy(12)) return { ok: false, why: 'Too tired to read' };
      advance(120, 12);
      M.addRep(1);
      quests.check();
      return { ok: true, rep: 1 };
    },
    archive(score = defaultScore()) {
      const st = S();
      const g = gateAct('class', 'archive', 'The archive is');
      if (!g.ok) return g;
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
      const g = gateAct('class', 'school', 'Classes are taught');
      if (!g.ok) return g;
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
      const g = gate('office', { loc: null });
      if (!g.ok) return g;
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
      const g = gate('home', { loc: null });
      if (!g.ok) return g;
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
      const g = gate('team', { loc: null });
      if (!g.ok) return g;
      const e = EMPLOYEE_BY_ID[id];
      if (!e) return { ok: false, why: 'No such person' };
      if (st.employees.includes(id)) return { ok: false, why: 'Already on the team' };
      /* SEATS COME OUT OF THE OFFICE TABLE NOW. This used to be the
         bare expression `st.office + 1`, which capped Wally Tower at
         six chairs for ten specialists and forced the player to leave
         four bought-and-paid-for upgrades unused for the whole
         endgame. OFFICE_STAGES[5].seats is 10. See data.js. */
      if (st.employees.length >= econ.teamSeats()) return { ok: false, why: 'No free seat — upgrade the office' };
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
      const g = gateAct('farm', 'farm', 'The farm is');
      if (!g.ok) return g;
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
      const g = gateAct('farm', 'farm', 'The farm is');
      if (!g.ok) return g;
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
      const g = gateAct('farm', 'farm', 'The farm is');
      if (!g.ok) return g;
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
      const g = gateAct('farm', 'farm', 'The farm is');
      if (!g.ok) return g;
      if (!st.farm.owned) return { ok: false, why: 'Buy into the farm first' };
      const cost = 2000 * (st.farm.lvl + 1);
      if (!econ.afford(cost)) return { ok: false, why: 'Not enough cash' };
      M.pay(-cost, 'farm');
      st.farm.lvl++;
      return { ok: true, level: st.farm.lvl };
    },
    farmHarvest(score = defaultScore()) {
      const st = S();
      const g = gateAct('farm', 'farm', 'The farm is');
      if (!g.ok) return g;
      if (!st.farm.owned) return { ok: false, why: 'Buy into the farm first' };
      if (!needEnergy(16)) return { ok: false, why: 'Too tired' };
      advance(180, 16);
      st.stats.minigames++;
      const pool = ASSETS.filter((a) => a.cat === 'Farm' && (a.farm || 1) <= st.farm.lvl + 1);
      const pick = pool[Math.floor(rng() * pool.length)];
      if (!pick) return { ok: false, why: 'Nothing is in season' };
      /* THE UPGRADE NOW SHOWS UP IN THE BUCKET. A level used to widen
         the crop POOL and nothing else — the yield was identical at
         level 1 and level 3, which is why "+1 per day?" was an
         unanswerable question. Every level above the first is now
         worth exactly one more token, and actions.producer('farm')
         states it in numbers the panel can print. */
      const qty = 1 + Math.floor(score * 2) + (st.farm.barn ? PRODUCERS.farm.barnBonus : 0)
        + Math.max(0, st.farm.lvl - 1) * PRODUCERS.farm.yieldPerLevel;
      if (econ.invCount() + qty > econ.invCap()) return { ok: false, why: 'No inventory space' };
      econ.add(pick.id, qty, 0);
      quests.check();
      return { ok: true, asset: pick.id, qty };
    },

    /* ---- mine ---- */
    mineRights(score = defaultScore()) {
      const st = S();
      const g = gateAct('mine', 'mine', 'The mine is');
      if (!g.ok) return g;
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
      const g = gateAct('mine', 'mine', 'The mine is');
      if (!g.ok) return g;
      if (st.mine.elevator) return { ok: false, why: 'Already certified' };
      if (!st.mine.rights) return { ok: false, why: 'Get the records from Goldie first' };
      if (!econ.afford(2600)) return { ok: false, why: 'Not enough cash' };
      M.pay(-2600, 'mine');
      st.mine.elevator = true;
      return { ok: true };
    },
    mineOpen(score = defaultScore()) {
      const st = S();
      const g = gateAct('mine', 'mine', 'The mine is');
      if (!g.ok) return g;
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
      const g = gateAct('mine', 'mine', 'The mine is');
      if (!g.ok) return g;
      if (!st.mine.owned) return { ok: false, why: 'Reopen the mine first' };
      const cost = 3600 * (st.mine.lvl + 1);
      if (!econ.afford(cost)) return { ok: false, why: 'Not enough cash' };
      M.pay(-cost, 'mine');
      st.mine.lvl++;
      return { ok: true, level: st.mine.lvl };
    },
    mineDig(score = defaultScore()) {
      const st = S();
      const g = gateAct('mine', 'mine', 'The mine is');
      if (!g.ok) return g;
      if (!st.mine.owned) return { ok: false, why: 'Reopen the mine first' };
      if (!needEnergy(20)) return { ok: false, why: 'Too tired' };
      advance(180, 20);
      st.stats.minigames++;
      const pool = ASSETS.filter((a) => a.cat === 'Minerals' && (a.mine || 1) <= st.mine.lvl + 1);
      const pick = pool[Math.floor(rng() * pool.length)];
      if (!pick) return { ok: false, why: 'The seam is dry' };
      const qty = (score > 0.7 ? 2 : 1)
        + Math.max(0, st.mine.lvl - 1) * PRODUCERS.mine.yieldPerLevel;
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
      const g = gateAct('ipo', 'ipo', 'Listings are run');
      if (!g.ok) return g;
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
        /* LISTING A COMPANY USED TO OPEN THE EXCHANGE ON ITS OWN, which
           would have been a way round the Mayor. It still opens it —
           but through the one door, so the race is a gate on this path
           too, and a player who lists before racing is told who is
           standing in the way. */
        const ex = grantExchange('ipo');
        if (!ex.ok && ex.kind === 'race') M.note('bad', RACE.lines.blocked);
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
      const g = gateAct('stadium', 'stampede', 'The Stampede are');
      if (!g.ok) return g;
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
      const g = gateAct('lab', 'devlab', 'The lab is');
      if (!g.ok) return g;
      if (st.unlocks.wallet) return { ok: false, why: 'Already installed' };
      if (!st.skills.mobile) return { ok: false, why: 'Needs Mobile Asset Management' };
      if (!econ.afford(900)) return { ok: false, why: 'Not enough cash' };
      M.pay(-900, 'lab');
      M.unlock('wallet');
      return { ok: true };
    },
    buyRemote() {
      const st = S();
      const g = gateAct('lab', 'devlab', 'The lab is');
      if (!g.ok) return g;
      if (st.unlocks.remote) return { ok: false, why: 'Already active' };
      if (!st.unlocks.wallet) return { ok: false, why: 'Install the wallet first' };
      if (!econ.afford(2400)) return { ok: false, why: 'Not enough cash' };
      M.pay(-2400, 'lab');
      M.unlock('remote');
      return { ok: true };
    },
    buildSwap(score = defaultScore()) {
      const st = S();
      const g = gateAct('lab', 'devlab', 'The lab is');
      if (!g.ok) return g;
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
      const g = gate('trade', { loc: null });
      if (!g.ok) return g;
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
      const g = gateAct('bank', 'bank', 'The bank counter is');
      if (!g.ok) return g;
      const cap = 500 + st.rep * 120;
      if (amount <= 0) return { ok: false, why: 'Nothing to borrow' };
      if (st.loan + amount > cap) return { ok: false, why: 'Your credit line is $' + econ.fmt(cap) };
      st.loan = round2(st.loan + amount);
      M.pay(amount, 'loan');
      return { ok: true, loan: st.loan };
    },
    repay(amount) {
      const st = S();
      const g = gateAct('bank', 'bank', 'The bank counter is');
      if (!g.ok) return g;
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
      const g = gateAct('pawn', 'pawn', "Vic's counter is");
      if (!g.ok) return g;
      actions.pawnStock();
      if (!st.pawnStock.includes(id)) return { ok: false, why: 'Vic does not have that today' };
      const unit = Math.round(econ.price(id) * 0.86);
      const r = econ.buy(id, 1, null, unit);
      if (r.ok) st.pawnStock = st.pawnStock.filter((x) => x !== id);
      return r;
    },
    pawnSell(id, qty = 1) {
      const g = gateAct('pawn', 'pawn', "Vic's counter is");
      if (!g.ok) return g;
      if (econ.free(id) + 1e-4 < qty) return { ok: false, why: 'Those units are locked' };
      const unit = Math.round(econ.price(id) * 0.78);
      econ.remove(id, qty);
      M.pay(round2(unit * qty), 'pawned');
      return { ok: true, unit };
    },

    /* ---- Vance: institutional mandates ---- */
    vanceMandate() {
      const st = S();
      const g = gateAct('order', 'vance', 'Vance & Partners are');
      if (!g.ok) return g;
      if (st.rep < 62) return { ok: false, why: 'Vance does not take meetings below reputation 62' };
      clients.meet('vance');
      if (clients.hasArrival('vance')) return { ok: false, why: 'His mandate is already on your desk' };
      const o = clients.makeOrder('vance');
      if (!o) return { ok: false, why: 'Nothing meets his criteria today' };
      clients.addArrival(o);
      return { ok: true, order: o };
    },

    /* ---- THE STOCK EXCHANGE DOOR ---- */
    exchangeGate, unlockExchange, exchangeSteps,

    /* ---- WHAT A PRODUCER UPGRADE ACTUALLY DOES ----
       The panel used to offer "Upgrade · $4,000" with no statement of
       the effect, and the effect was thin. Both are fixed: this
       returns the real numbers for the level he is on and the level he
       would be buying, including the part that only pays if the right
       person is on the payroll. */
    producer(which) {
      const st = S();
      const P = PRODUCERS[which];
      if (!P) return null;
      const own = which === 'farm' ? st.farm : st.mine;
      const lvl = own.lvl || 0;
      const yieldAt = (n) => (which === 'farm'
        ? 1 + 1 + (own.barn ? P.barnBonus : 0) + Math.max(0, n - 1) * P.yieldPerLevel   // average score
        : 1 + Math.max(0, n - 1) * P.yieldPerLevel);
      const hired = st.employees.includes(P.manager);
      const daily = (n) => P.dailyBase + n * P.dailyPerLevel;
      const tierAt = (n) => Math.min(P.maxTier, n + 1);
      const next = lvl + 1;
      return {
        id: P.id, n: P.n, loc: P.loc, act: P.act, unit: P.unit, upgrade: P.upgrade,
        owned: !!own.owned, level: lvl, maxTier: P.maxTier,
        cost: P.cost.base * (lvl + 1),
        nextLevel: next,
        perAction: yieldAt(lvl), nextPerAction: yieldAt(next),
        tier: tierAt(lvl), nextTier: tierAt(next),
        tierGrows: tierAt(next) > tierAt(lvl),
        manager: P.manager, managerName: EMPLOYEE_BY_ID[P.manager].n, managerHired: hired,
        dailyIncome: own.owned && hired ? daily(lvl) : 0,
        nextDailyIncome: own.owned && hired ? daily(next) : 0,
        dailyIfHired: daily(next),
        effect: P.effect,
        daily: P.daily,
        /* the three lines a panel should print, already in numbers */
        lines: [
          P.act + ' now yields ' + yieldAt(lvl) + ' ' + P.unit + (yieldAt(lvl) === 1 ? '' : 's')
            + '; at level ' + next + ' it yields ' + yieldAt(next) + '.',
          tierAt(next) > tierAt(lvl)
            ? 'Level ' + next + ' opens tier ' + tierAt(next) + ' — the richer ' + P.unit + 's.'
            : 'Tier ' + tierAt(lvl) + ' is already the richest seam this place has.',
          hired
            ? 'Overnight income goes from $' + daily(lvl) + ' to $' + daily(next) + ' a day.'
            : 'It adds nothing to overnight income until ' + EMPLOYEE_BY_ID[P.manager].n
              + ' (' + EMPLOYEE_BY_ID[P.manager].role.toLowerCase() + ', $'
              + EMPLOYEE_BY_ID[P.manager].salary + '/day) is on the payroll. With '
              + EMPLOYEE_BY_ID[P.manager].n + ' it would pay $' + daily(next) + ' a day.',
        ],
      };
    },

    /* ---- the desk: deliver + tokenize ---- */
    deliver(orderOrId) {
      const st = S();
      const g = gate('order', { loc: null });
      if (!g.ok) return g;
      const o = typeof orderOrId === 'string' ? st.orders.find((x) => x.id === orderOrId) : orderOrId;
      if (!o) return { ok: false, why: 'No such order' };
      if (st.loc !== officeLoc()) return { ok: false, why: 'Deliver this at your desk' };
      return econ.completeOrder(o);
    },
    accept(orderOrId) {
      const st = S();
      const g = gate('order', { loc: null });
      if (!g.ok) return g;
      const o = typeof orderOrId === 'string' ? st.arrivals.find((x) => x.id === orderOrId) : orderOrId;
      return econ.acceptOrder(o);
    },
    tokenize(id) { return econ.tokenize(id); },
  };

  /* hud() runs every frame, so this stays deliberately small. */
  function rideHud() {
    const st = S();
    const r = st.rides ? RIDES[st.rides.equipped] : null;
    return r ? { id: r.id, name: r.name, short: r.short, ico: r.ico, speed: r.speed } : null;
  }

  /* ============================================================
     SAVE / LOAD / NEW
     ============================================================ */
  function bootState(fresh) {
    syncRides();
    /* ARM THE ENDINGS BEFORE ANYTHING CAN CHECK THEM. A save that is
       already at 100% tokenized, or already finished, must not replay
       its fireworks or Happy's speech on the way through the door.
       First line of boot, ahead of every quests.check() below. */
    quests.syncLatches();
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

    /* THE RULES LAYER, as the UI reads it */
    gate, canEnter, openInfo, opensAt, closedLine, needs,
    hasAct, locsWithAct, mealsAt, nearestFood, slateOffer,
    /* reputation and its title ladder */
    rep: () => repProgress(env.state.rep),
    repTitles: () => DATA.repTitles,
    /* the Mayor's Dash */
    race,

    /* ------------------------------------------------------------
       THE OFFICE, AS ONE OBJECT.
       What the current stage grants, what is in use, and — the point
       of the whole thing — whether it can run every upgrade at once.
       `everythingAtOnce` is true only when there is a seat for every
       specialist in the game, a slot for every client and a fund for
       every client. It is true at Wally Tower and nowhere else.
       ------------------------------------------------------------ */
    office() {
      const st = env.state;
      const stage = OFFICE_STAGES[st.office];
      const seats = econ.teamSeats();
      const slots = econ.orderSlots();
      const funds = econ.fundCap();
      return {
        stage: st.office, name: stage.n, desc: stage.desc, top: st.office >= OFFICE_STAGES.length - 1,
        seats: { used: st.employees.length, cap: seats, all: EMPLOYEE_POOL.length },
        slots: { used: st.orders.length, cap: slots, all: CONFIG.totalClients },
        funds: { used: st.funds.length, cap: funds, all: CONFIG.totalClients },
        inventory: { used: econ.invCount(), cap: econ.invCap(), locked: econ.invLocked(), all: CONFIG.totalAssets },
        everythingAtOnce: seats >= EMPLOYEE_POOL.length
          && slots >= CONFIG.totalClients
          && funds >= CONFIG.totalClients
          && econ.invCap() >= CONFIG.totalAssets,
      };
    },

    /* ------------------------------------------------------------
       THE TWO ENDINGS. Detection lives in quests.js; this is the
       reading end. Events: 'city:tokenized' and 'game:complete'.
       ------------------------------------------------------------ */
    endings: {
      report: () => quests.completion(),
      cityDone: () => quests.cityTokenized(),
      cityFired: () => quests.hasFiredCity(),
      completeFired: () => quests.hasFiredComplete(),
      happy: () => DATA.happyEnding,
    },

    /* who is standing here, including people who are waiting for you
       somewhere that is not their home (NPC_POSTS) */
    whoIsAt: (locId) => clients.at(locId),
    postsAt: (locId) => clients.postsAt(locId),

    /* headline numbers the HUD reads every frame */
    hud() {
      const st = env.state;
      return {
        day: st.day, clock: time.clock(), phase: time.phase, weather: st.weather,
        money: st.money, rep: st.rep, energy: st.energy, hunger: st.hunger,
        loc: st.loc, zone: LOC_BY_ID[st.loc] ? LOC_BY_ID[st.loc].z : null,
        cityPct: econ.cityPct(), netWorth: econ.netWorth(),
        owned: econ.distinctOwned(), invCount: econ.invCount(), invCap: econ.invCap(),
        invHeld: econ.invHeld(), invLocked: econ.invLocked(),
        orders: st.orders.length, orderSlots: econ.orderSlots(),
        /* THE OFFICE'S THREE CAPACITIES, so the UI can draw them side
           by side and show that the top stage runs everything at once. */
        team: st.employees.length, teamSeats: econ.teamSeats(),
        fundsOpen: st.funds.length, fundCap: econ.fundCap(),
        office: st.office, officeName: OFFICE_STAGES[st.office].n,
        arrivals: st.arrivals.length,
        /* THE OBJECTIVE STRIP READS THIS, and it is the main chain
           only. A side quest lives in `sideObjective` and has its own
           quieter slot — it can never replace the main one. */
        objective: quests.current(),
        sideObjective: quests.sideCurrent(),
        /* REPUTATION CARRIES A TITLE. The strip shows the title he
           holds, the one after it and how far through he is. */
        title: repProgress(st.rep),
        /* the hunger lock, one boolean and one sentence */
        starving: starving(st),
        lockedBy: starving(st) ? 'hunger' : null,
        /* is where he is standing open, and until when */
        open: isOpen(st.loc),
        hours: openInfo(st.loc),
        /* the race, small enough to read every frame */
        race: { status: raceState(st).status, won: raceState(st).status === 'won' },
        /* LEGACY: the bicycle specifically, {owned, equipped}. */
        bike: { ...st.bike },
        /* THE RIDE HE IS ON, or null if he is on his own feet. */
        ride: rideHud(),
        rides: { owned: { ...(st.rides ? st.rides.owned : {}) }, equipped: st.rides ? st.rides.equipped : null },
      };
    },

    /* ------------------------------------------------------------
       DEBUG DOORS — the rules layer's own, so they work in plain
       node (tools/test-game.mjs) as well as behind window.WALLY.debug.
       Nothing here is reachable from normal play.
       ------------------------------------------------------------ */
    debug: {
      /* Take the whole office to the top: Wally Tower, the reputation
         it needs, and every specialist in the pool on the payroll.
         Returns what that stage actually grants. */
      maxOffice(hire = true) {
        const st = env.state;
        st.office = OFFICE_STAGES.length - 1;
        st.rep = Math.max(st.rep, OFFICE_STAGES[st.office].rep);
        if (hire) {
          st.money = Math.max(st.money, 20000);
          for (const e of EMPLOYEE_POOL) if (!st.employees.includes(e.id)) actions.hire(e.id);
        }
        return api.office();
      },
      /* Tokenize all 69 assets and let the normal sweep fire
         'city:tokenized'. Does NOT finish the game. */
      tokenizeCity() {
        const st = env.state;
        for (const a of ASSETS) st.tokenized[a.id] = true;
        st.stats.tokenized = ASSETS.length;
        quests.milestones();
        quests.check();
        return { pct: econ.cityPct(), fired: quests.hasFiredCity() };
      },
      /* Fire the fireworks event by hand. force re-fires one that has
         already happened (payload carries forced:true). */
      fireCity: (force) => quests.fireCityTokenized(force),
      /* Satisfy the ENTIRE completion set for real — every asset
         tokenized, every main quest, every side quest — and let the
         sweep fire 'game:complete'. */
      completeGame() {
        const st = env.state;
        for (const a of ASSETS) st.tokenized[a.id] = true;
        st.stats.tokenized = ASSETS.length;
        for (const q of DATA.quests) quests.complete(q);
        for (const q of DATA.sideQuests) quests.completeSide(q);
        quests.milestones();
        quests.check();
        return quests.completion();
      },
      /* Fire Happy's ending by hand. */
      fireComplete: (force) => quests.fireGameComplete(force),
      completion: () => quests.completion(),
      happy: () => DATA.happyEnding,
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

    /* FRAME HOOK — AND THE CLOCK NOW RUNS ON ITS OWN.
       At CONFIG.minutesPerSecond (0.5) one real second is half an
       in-game minute, so the city's opening hours pass whether Wally
       is working or standing in the road looking at gulls. Everything
       goes through advance(), so hunger, the hour bell, client
       arrivals and the 01:00 collapse all behave identically to a
       shift. ui.js can freeze it with game.time.pause(true) while a
       menu is open; the screenshot harness turns it off entirely. */
    update(dt /* , elapsed */) { tickClock(dt); },
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
  /* SCREENSHOTS ARE POSED FRAMES. A clock ticking under a --wait would
     make two runs of the same shot differ in sky, crowd and hunger, so
     the live clock is off for the harness and on for players. */
  if (ctx.flags?.shot) game.time.setLive(false);

  if (!ctx.flags?.shot && game.hasSave()) {
    try { game.load(); } catch (e) { console.warn('[game] save failed to load, starting fresh', e); }
  }

  if (typeof window !== 'undefined' && window.WALLY) {
    const d = window.WALLY.debug || (window.WALLY.debug = {});
    d.game = game;
    d.setDay = (n) => {
      /* sleeping happens where the bed is now, so go home first */
      while (game.state.day < n) { if (game.state.loc !== 'apartment') game.enter('apartment'); game.actions.sleep(); }
      return game.state.day;
    };
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
    /* THE MAYOR'S DASH, for anyone posing or testing it. */
    d.race = () => game.race.view();
    d.raceOffer = () => game.race.offer();
    d.raceWin = () => {
      game.race.offer();
      game.actions.grantRide('scooter');
      game.state.loc = game.data.race.route[0];
      game.state.time = 10 * 60;
      game.state.energy = 100;
      game.race.start();
      return game.race.finish(Math.max(1, game.race.pace().mayorSeconds - 5));
    };
    d.clock = (on) => game.time.setLive(on !== false);
    /* ---- THE OFFICE AND THE TWO ENDINGS ----
       maxOffice()      Wally Tower with all ten specialists hired
       office()         what the current stage grants vs what is used
       tokenizeCity()   tokenize all 69 -> fires 'city:tokenized'
       fireCity(force)  fire the fireworks event on demand
       completeGame()   satisfy the whole completion set -> fires
                        'game:complete' (Happy's ending)
       fireComplete(f)  fire Happy's ending on demand
       completion()     the checklist: what is still outstanding      */
    d.maxOffice = (hire) => game.debug.maxOffice(hire !== false);
    d.office = () => game.office();
    d.tokenizeCity = () => game.debug.tokenizeCity();
    d.fireCity = (force) => game.debug.fireCity(force);
    d.completeGame = () => game.debug.completeGame();
    d.fireComplete = (force) => game.debug.fireComplete(force);
    d.completion = () => game.debug.completion();
    d.happy = () => game.debug.happy();
    /* THE RIDES, for anyone posing a screenshot. */
    d.rides = () => game.actions.rides();
    d.giveRide = (id) => game.actions.grantRide(id) && game.actions.equipRide(id);
    /* Fast-forward the opening to the moment the objective becomes
       "Go and see the Business Broker" — phone, Happy, a Dispatch
       shift, then the order picked up off the desk. Returns the live
       objective so a --eval can print it. */
    d.deskPickup = () => {
      const st = game.state;
      st.energy = 100; st.hunger = 8;
      game.actions.readMessages();
      game.actions.metHappy();
      /* the shift is worked AT Dispatch now, during its hours */
      if (!st.flags.dispatchShift) { game.enter('trunkdepot'); game.actions.work('drive', 0.6); }
      if (!st.arrivals.length) game.clients.seedArrivals();
      if (st.arrivals.length) game.actions.accept(st.arrivals[0]);
      return game.hud().objective;
    };
  }

  return game;
}

export default init;
