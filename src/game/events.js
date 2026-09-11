/* ============================================================
   events.js — THINGS THAT HAPPEN TO YOU.

   THE HOLE THIS FILLS. Before this file the middle of the game had
   exactly three shapes. NEWS: eighteen headlines that move a price,
   which you READ, on a screen, after the fact. CLIENT ORDERS: the
   loop, which TELLS you where to go. And the Mayor's Dash: one
   set-piece, the only thing in the build that ever interrupted the
   player, and by common consent the best thing in it. So the game
   had things you read and things you were told to do, and one thing
   that happened to you.

   Two layers here, deliberately different shapes, and the difference
   is the whole design:

     A DAY CONDITION is what the CITY is doing. It is not addressed
     to Wally and it cannot be declined, because weather and
     industrial relations are not offers. It changes what a PLACE IS
     for a day — a shut dock, a farm open until eleven at night — and
     it bites through game.isOpen(), which travel(), enter() and every
     gate() already obey.

     AN ENCOUNTER is what a PERSON is doing to you. It stops you in a
     room, says something, and offers a choice. Every single one can
     be walked away from at no cost whatsoever, and decline() below
     is written so that walking away leaves the save byte-identical.

   ------------------------------------------------------------
   THE RULES THAT MAKE THESE COMPANY RATHER THAN NOISE
   ------------------------------------------------------------
   1  NOTHING STEALS A DEADLINE. A condition is refused outright if
      shutting its doors would put a live order's counter or the
      player's own desk out of reach today (canAfford() below), and
      no encounter fires at all on a day an order is due. The Mayor
      gets this right by being a race you can walk away from; the
      cheaper version of the same courtesy is not standing in front
      of somebody who is already late.
   2  NOTHING SHUTS THE LAST KITCHEN. Hunger locks this game down to
      eating at 100, so a condition may never close the only food
      counter still open. Asserted.
   3  NO CONDITION EVER TOUCHES A TRADING VENUE. VENUES in data.js
      carries its own hours table, read by economy.tradeGate(); a
      location whose hours moved would disagree with the counter
      inside it. So the conditions shut kitchens, yards and labs and
      leave every market alone. Asserted against the acts table.
   4  FREQUENCY IS A DESIGN DECISION — see EVENT_TUNING in data.js
      for the numbers and the reasoning.

   ------------------------------------------------------------
   PUBLIC API — ctx.game.events
   ------------------------------------------------------------
   today()            the live condition record, or null
   view()             everything, in one object, for the HUD/phone
   shut(locId)        {shut, why, from} — is that door closed today
   openUntil(locId)   pushed-out closing hour today, or null
   rollDay()          game.rollDay() calls this; returns the condition
   onPlace(locId)     …and setLoc() calls this. May raise an encounter
   live()             the encounter on screen, or null
   answer(id, value)  what ui/dialogue.js calls back with
   accept(id) decline(id)
   claimTip()         economy.rollNews() asks for tomorrow's rumour
   settleTip(news)    …and reports back what actually printed
   tipRecord()        {clientId: {right, wrong, last}} — the track
                      record that makes a tipster worth remembering
   airRadius(alt)     how far you can see from `alt` metres up
   weatherName()      the four-name weather for ctx.sky.setWeather

   EVENTS on ctx.bus
   'today'     {id, n, day, shut, open, wx, line, first}
   'encounter' {kind:'offer', id, enc, speaker, role, portrait,
                text:[…], choices:[{label,value,kind}]}
               ui/dialogue.js listens to exactly this and answers
               through events.answer(). It is the ONE listener this
               feature adds and it has an emitter three lines below.
   'encounter' {kind:'accept'|'decline'|'expire', id, …}
   'tip'       is NOT used — ui.js already owns 'tip' for the help
               cards. A rumour arrives as a 'msg' and a 'note'.
   ============================================================ */

import {
  DAY_EVENTS, DAY_EVENT_BY_ID, ENCOUNTERS, ENCOUNTER_BY_ID,
  TIPSTERS, AIRVIEW, EVENT_TUNING, NEWS_POOL,
  LOC_BY_ID, CLIENT_BY_ID, VENUE_LOC, ASSET_BY_ID, tipVoice,
} from './data.js';

/* The four names src/world/weather.js authors. state.weather used to
   be 'rain' or 'clear' and nothing anywhere read it; it is now always
   one of these, so ctx.sky.setWeather() can be handed it directly and
   never has to guess — an unknown name makes weather.js warn and
   return false, which is how a caller ends up measuring the previous
   sky. See the wiring in game.js init(). */
export const WX_NAMES = Object.freeze(['clear', 'cloudy', 'rain', 'storm']);

/* An ordinary morning's sky, from one 0..1 draw. economy.newDay()
   makes that draw, in the place it has always made it — one number, at
   the top of the day roll — and this only decides what to call it. It
   used to be 'rain' at 0.22 and 'clear' otherwise, in a two-name
   vocabulary nothing in the codebase could read; the same 0.34 of days
   are now overcast-or-wet, in weather.js's own names, and 10% of them
   are properly rainy rather than 22%, because the conditions table
   supplies the heavy weather deliberately instead of by dice. */
export function baseWeather(r) {
  return r < 0.10 ? 'rain' : r < 0.34 ? 'cloudy' : 'clear';
}

const isFood = (l) => !!l && l.acts.some((a) => a.startsWith('food:'));
const isBed = (l) => !!l && l.acts.includes('sleep');
const isMarket = (l) => !!l && l.acts.some((a) => a.startsWith('market:'));

export function createEvents(env) {
  const bus = env.bus;
  const S = () => env.state;
  const M = () => env.mutate;

  /* ------------------------------------------------------------
     ITS OWN STREAM, AND THIS IS NOT FUSSINESS.

     Every module in this game shares rng(), which is seeded, and
     BUILD_BRIEF is explicit about why: Math.random is banned so that
     a seeded world and a screenshot reproduce between builds. The
     first version of this file drew from that shared stream — and a
     whole subsystem drawing three or four numbers every morning
     RESHUFFLED EVERYTHING DOWNSTREAM OF IT. The 30-day simulation in
     tools/test-game.mjs came out with a different bicycle under
     Wally on day 31 and took a save-migration assertion red with it.
     Nothing about encounters was wrong; adding them moved the market.

     So the whole feature draws from its own stream. Prices, news,
     client baskets and quest rolls are then bit-for-bit what they
     were before this file existed, and they stay that way however
     many conditions and encounters get added to the tables.

     AND THE STREAM CARRIES THE WORLD SEED IN ITS NAME. makeRng()
     hashes a string and has never seen opts.seed, so a bare
     makeRng('events') would give every playthrough on earth the same
     weather on the same days in the same order — caught by running
     forty seeded games in tools/test-encounters.mjs and watching a
     bus driver be right forty times out of forty.
     ------------------------------------------------------------ */
  const rng = env.makeRng ? env.makeRng('events:' + (env.seed ?? 0)) : env.rng;

  /* ============================================================
     STATE — three records, all repaired on read so a save written
     before this file existed cannot throw.
     ============================================================ */
  function city(st = S()) {
    if (!st.city || typeof st.city !== 'object' || Array.isArray(st.city)) {
      st.city = { today: null, log: [], encDay: 0, encMin: -1e9, encCount: 0, encArmed: false, live: null };
    }
    if (!Array.isArray(st.city.log)) st.city.log = [];
    /* A MISSING FLAG IS A NO, NOT AN UNDEFINED. encArmed is set each
       morning by rollDay(); a save written before it existed, or a
       harness that forces a condition by hand, must read as "the city
       has nothing to say to you today" rather than as a third state
       that happens to be falsy for the wrong reason. */
    if (typeof st.city.encArmed !== 'boolean') st.city.encArmed = false;
    return st.city;
  }
  function tipState(st = S()) {
    if (!st.tips || typeof st.tips !== 'object' || Array.isArray(st.tips)) {
      st.tips = { pending: null, rec: {} };
    }
    if (!st.tips.rec || typeof st.tips.rec !== 'object') st.tips.rec = {};
    return st.tips;
  }

  /* THE CLAIMED RUMOUR LIVES HERE AND NOT ON THE SAVE.

     claimTip() and settleTip() are two halves of one synchronous
     call inside economy.rollNews(), so nothing can be persisted
     between them — and a transient parked on state.tips would add a
     key that survives a save/load round trip and make the state
     stop being byte-identical to itself, which is a thing
     tools/test-game.mjs asserts and was right to. */
  let claimed = null;

  /* WHO HAS ALREADY STOPPED YOU THIS WEEK — and deliberately NOT on
     the save.

     Reading a play-through, Barnaby cornered Wally on three
     consecutive mornings, because the only cooldown was written by
     settleTip() and a DECLINED tip settles nothing. The obvious fix —
     stamp the person on decline — is the one thing this feature is
     not allowed to do: decline() must leave the save byte-identical,
     and tools/test-encounters.mjs proves it does. So the memory lives
     here, in the closure, where it costs a reload and nothing else.
     A rumour is a thing somebody heard, not a subscription. */
  const spokeOn = new Map();

  /* AND WHICH CARDS THIS RUN HAS ALREADY PUT IN FRONT OF THE PLAYER,
     for the same reason and with the same rule: presentation, not
     save state, so a decline still leaves the file untouched. It buys
     one thing — a person who was told no yesterday does not read out
     the identical paragraph today. A two-day strike printed Barnaby's
     speech twice, word for word, in the play-through that prompted
     this. */
  const offeredOn = new Map();

  const today = () => city().today;
  const todayId = () => (city().today ? city().today.id : null);
  const spec = (id) => DAY_EVENT_BY_ID[id] || null;

  /* ============================================================
     WHAT TODAY DOES TO A DOOR.

     game.isOpen() asks these two, and nothing else in the codebase
     has to know a condition exists. `from` lets the weather take the
     afternoon rather than the whole day, which is what makes the
     awning encounter possible at all: you have to be able to stand
     in the place while it is still open.
     ============================================================ */
  function shut(locId, atMin) {
    const t = today();
    if (!t || !t.shut || !t.shut.includes(locId)) return { shut: false };
    if (t.spared && t.spared.includes(locId)) return { shut: false, spared: true };
    const from = Number.isFinite(t.from) ? t.from : 0;
    if (from > 0) {
      const hour = Math.floor((atMin == null ? S().time : atMin) / 60) % 24;
      if (hour < from) return { shut: false, later: from };
    }
    return { shut: true, why: t.closed || t.line, from, id: t.id };
  }
  function openUntil(locId) {
    const t = today();
    if (!t || !Array.isArray(t.open)) return null;
    const row = t.open.find((o) => o.loc === locId);
    return row ? row.until : null;
  }

  /* ============================================================
     THE THREE GUARDS. Each is its own function because each is its
     own assertion in tools/test-encounters.mjs.
     ============================================================ */

  /* 1. NOTHING STEALS A DEADLINE. Every counter a live order needs,
        plus the desk the order is delivered at. An order due in three
        days is not a deadline this rule protects — the player has
        time to go tomorrow — so only orders due TODAY or TOMORROW
        count, which is the window in which a shut door is actually
        a loss rather than an inconvenience. */
  function neededLocs(st = S()) {
    const out = new Set();
    for (const o of st.orders || []) {
      if (o.deadline - st.day > 1) continue;
      out.add(env.officeLoc());
      for (const it of o.items || []) {
        const a = ASSET_BY_ID[it.a];
        if (a && VENUE_LOC[a.ven]) out.add(VENUE_LOC[a.ven]);
      }
    }
    return out;
  }

  /* 2. NOTHING SHUTS THE LAST KITCHEN.

        Not "there is still a kitchen somewhere" — that is trivially
        true and would let a condition close the only counter open at
        eight in the evening. The rule is HOUR BY HOUR, across every
        hour the condition is in force: if the city would ordinarily
        have had a kitchen open at that hour, it must still have one.

        The first version of this asked one question at hour `from`,
        which for an all-day condition is midnight — when nothing is
        open anyway — so it refused every condition in the table
        including the two that shut no kitchens at all. An invariant
        that is false at an hour nobody is awake is not an invariant.

        AND IT IS BOUNDED TO EVENT_TUNING.kitchenHours, because the
        SECOND version was over-strict in the other direction. The
        noodle cart is the only counter open between 22:00 and 23:00,
        so an unbounded rule refuses any condition that touches it —
        and that hour is not actually a hazard: game.js's hunger-lock
        header already says so out loud, since the cart shuts at 23:00
        every ordinary night and the escape is the bed, which is open
        all night and which travel() and enter() will always carry a
        starving Wally to. Between 08:00 and 21:00 there is no such
        escape and the rule is absolute.

        (The floor UNDER this is SLATE_MEAL, the noodle cart feeding a
        broke, starving Wally on the slate; but the slate is at a
        counter, and a counter that is shut cannot extend credit.) */
  function foodSurvives(sh, from) {
    const [lo, hi] = EVENT_TUNING.kitchenHours;
    const start = Math.max(lo, Math.floor(from || 0));
    const kitchens = Object.values(LOC_BY_ID).filter(isFood);
    for (let h = start; h < hi; h++) {
      const anyNormally = kitchens.some((l) => h >= l.hours[0] && h < l.hours[1]);
      if (!anyNormally) continue;                       // the city is asleep
      const anyLeft = kitchens.some((l) => !sh.includes(l.id) && h >= l.hours[0] && h < l.hours[1]);
      if (!anyLeft) return false;
    }
    return true;
  }

  /* 3. NO TRADING VENUE, EVER. Content-level, so a future condition
        that names the wrong building fails the test rather than the
        player's afternoon. */
  const touchesMarket = (sh) => sh.some((id) => isMarket(LOC_BY_ID[id]));

  function canRun(d, st = S()) {
    const sh = d.shut || [];
    if (sh.includes('apartment') || sh.some((id) => isBed(LOC_BY_ID[id]))) {
      return { ok: false, why: 'it would shut the only bed in the game' };
    }
    if (touchesMarket(sh)) return { ok: false, why: 'a condition may not shut a trading venue' };
    if (!foodSurvives(sh, d.from)) return { ok: false, why: 'it would shut the last open kitchen' };
    const need = neededLocs(st);
    for (const id of sh) if (need.has(id)) return { ok: false, why: 'an order due now is filled at ' + LOC_BY_ID[id].n };
    return { ok: true };
  }

  /* ============================================================
     THE DAY ROLL.

     game.rollDay() calls this AFTER economy.newDay() has moved the
     day number and BEFORE the 'day' event goes out, so the condition
     is already true of the world by the time anybody hears about the
     morning. It owns state.weather outright now: a condition with a
     `wx` sets it, and a plain day rolls one of the four names with
     the same 22% wet chance economy.js has always used.
     ============================================================ */
  function eligible(st) {
    const c = city(st);
    const last = c.log.length ? c.log[c.log.length - 1] : null;
    const yesterday = last && last.day === st.day - 1 ? last.id : null;
    return DAY_EVENTS.filter((d) => {
      /* a condition with an `after` is a CONSEQUENCE and can land
         only the morning after its cause */
      if (d.after) { if (!yesterday || !d.after.includes(yesterday)) return false; }
      if (d.never && yesterday && d.never.includes(yesterday)) return false;
      const seen = c.log.filter((r) => r.id === d.id).pop();
      /* a condition may set its own, longer, cooldown — the plain rainy
         day is the least interesting thing the city does and should be
         the rarest of the ordinary ones */
      const cd = Number.isFinite(d.cooldown) ? d.cooldown : EVENT_TUNING.cooldownDays;
      if (seen && st.day - seen.day < cd) return false;
      if (typeof d.when === 'function' && !d.when(st)) return false;
      return canRun(d, st).ok;
    });
  }

  function rollDay() {
    const st = S();
    const c = city(st);

    /* a multi-day condition (the strike) stays standing */
    if (c.today && Number.isFinite(c.today.until) && c.today.until >= st.day) {
      c.today.day = st.day;
      c.today.first = false;
      applyWeather(c.today);
      announce(c.today);
      return c.today;
    }

    c.today = null;
    c.encDay = 0;
    c.encCount = 0;
    /* AND THE MINUTE CLOCK, WHICH IS WHY THIS COMMENT IS HERE.
       encMin is state.time, which is minutes since midnight and
       resets every morning; encReady() compares `st.time - c.encMin`
       against a 90-minute gap. Left over the night that subtraction
       goes NEGATIVE — 09:20 today minus 13:05 yesterday is minus 225
       — and every encounter in the first quarter of every day was
       silently refused as "too soon after the last one". Found by
       reading a 22-day play-through and noticing that the awning
       never once got offered on a storm morning. */
    c.encMin = -1e9;
    c.encArmed = rng() < EVENT_TUNING.dayEncChance;
    c.live = null;

    /* THE CONSEQUENCE RULE gets its own throw before the general one:
       a power cut that only fires on 34% of the mornings after a
       storm is a coincidence, not a consequence. */
    const pool = eligible(st);
    const consequences = pool.filter((d) => d.after);
    let pick = null;
    if (st.day >= EVENT_TUNING.firstDay) {
      if (consequences.length && rng() < (consequences[0].chance ?? 0.45)) {
        pick = consequences[0];
      } else {
        const plain = pool.filter((d) => !d.after);
        if (plain.length && rng() < EVENT_TUNING.dayChance) {
          pick = plain[Math.floor(rng() * plain.length) % plain.length];
        }
      }
    }

    if (!pick) { applyWeather(null); return null; }

    const days = Array.isArray(pick.days)
      ? pick.days[0] + Math.floor(rng() * (pick.days[1] - pick.days[0] + 1))
      : 1;
    c.today = {
      id: pick.id, n: pick.n, day: st.day, until: st.day + days - 1,
      zone: pick.zone || null, wx: pick.wx || null,
      quiet: !!pick.quiet,
      from: Number.isFinite(pick.from) ? pick.from : 0,
      shut: (pick.shut || []).slice(),
      open: (pick.open || []).map((o) => ({ ...o })),
      spared: [],
      line: pick.line, closed: pick.closed || null,
      title: pick.title, sub: pick.sub,
      first: true,
    };
    c.log.push({ id: pick.id, day: st.day });
    if (c.log.length > 40) c.log.shift();
    applyWeather(c.today);
    announce(c.today);
    return c.today;
  }

  /* state.weather is now always one of weather.js's four names — see
     WX_NAMES above. This is the only writer. */
  /* A CONDITION'S WEATHER OVERRIDES THE MORNING'S, and consumes no
     randomness of its own: economy.newDay() has already drawn the
     ordinary sky (baseWeather, above) at the top of the day roll, so
     this either keeps it or replaces it with the one the condition
     brings. A storm is not a dice roll on top of a dice roll. */
  function applyWeather(t) {
    const st = S();
    if (t && t.wx && WX_NAMES.includes(t.wx)) { st.weather = t.wx; return st.weather; }
    if (!WX_NAMES.includes(st.weather)) st.weather = baseWeather(rng());
    return st.weather;
  }

  /* A DAY WHERE IT MERELY RAINS IS NOT AN ANNOUNCEMENT. `quiet`
     conditions change the sky and nothing else, so they arrive as a
     line on the phone rather than as a plaque with the same weight as
     a strike — the payoff is that the city is visibly wet, which is
     three subsystems of world/weather.js finally being switched on,
     not a card telling you it is. */
  function announce(t) {
    if (!t) return;
    if (t.quiet) M().note('info', t.sub);
    else M().banner(t.title, t.sub);
    M().msg('City Guide', t.line);
    bus.emit('today', {
      id: t.id, n: t.n, day: t.day, zone: t.zone, wx: t.wx,
      shut: t.shut.slice(), open: t.open.map((o) => ({ ...o })),
      from: t.from, line: t.line, first: !!t.first, until: t.until,
    });
  }

  /* ============================================================
     ENCOUNTERS.

     onPlace() is the ONLY thing that raises one, and game.setLoc()
     is the only thing that calls onPlace(): an encounter happens
     when you walk into a room, never on a timer while you are
     standing still, because a card that opens itself while the
     player is doing something else is an interruption and not an
     encounter.
     ============================================================ */
  function orderDueToday(st = S()) {
    return (st.orders || []).some((o) => o.deadline <= st.day);
  }

  function encReady(st = S()) {
    const c = city(st);
    if (c.live) return { ok: false, why: 'one is already on screen' };
    if (st.day < EVENT_TUNING.encFirstDay) return { ok: false, why: 'too early in the game' };
    /* NOTHING FIRES ON A DAY AN ORDER IS DUE. */
    if (orderDueToday(st)) return { ok: false, why: 'an order is due today' };
    if (c.encDay === st.day && c.encCount >= EVENT_TUNING.encPerDay) {
      return { ok: false, why: 'already had one today' };
    }
    if (st.time - c.encMin < EVENT_TUNING.encGapMins) return { ok: false, why: 'too soon after the last one' };
    const h = Math.floor(st.time / 60) % 24;
    if (h < EVENT_TUNING.encHours[0] || h >= EVENT_TUNING.encHours[1]) {
      return { ok: false, why: 'outside the hours anybody stops you' };
    }
    /* max hunger locks the game down to eating; a conversation is not
       eating (game.gate's HUNGER_FREE set is the authority elsewhere) */
    if (env.gate) { const g = env.gate('encounter', { loc: null }); if (!g.ok) return { ok: false, why: 'he is starving' }; }
    return { ok: true };
  }

  /* Which encounters COULD happen in this room right now. Pure, and
     the test rig drives it directly. */
  function candidates(locId, st = S()) {
    const t = today();
    return ENCOUNTERS.filter((e) => {
      if (e.at && !e.at.includes(locId)) return false;
      if (e.cond && (!t || t.id !== e.cond)) return false;
      if (e.minDay && st.day < e.minDay) return false;
      /* the awning is only worth taking hold of while the place is
         still open and the weather has not yet shut it */
      if (e.id === 'shutters') {
        const s = shut(locId);
        if (s.shut || s.spared) return false;
        if (!t || !t.shut.includes(locId)) return false;
      }
      if (e.kind === 'tip' && !tipster(locId, st)) return false;
      if (typeof e.when === 'function' && !e.when(st)) return false;
      return true;
    });
  }

  /* Somebody who is plausibly in this room AND deals in rumours. */
  function tipster(locId, st = S()) {
    const l = LOC_BY_ID[locId];
    if (!l) return null;
    const tp = tipState(st);
    const pool = Object.keys(TIPSTERS).filter((id) => {
      const c = CLIENT_BY_ID[id];
      if (!c) return false;
      if (!st.clients[id] || !st.clients[id].met) return false;
      if (c.home !== l.z) return false;
      /* the same person does not corner you twice in a week — a
         rumour is a thing somebody heard, not a subscription */
      const r = tp.rec[id];
      if (r && r.last && st.day - r.last < 5) return false;
      const said = spokeOn.get(id);
      if (said != null && st.day - said < 4) return false;
      return true;
    });
    if (!pool.length) return null;
    return pool[Math.floor(rng() * pool.length) % pool.length];
  }

  function onPlace(locId) {
    const st = S();
    const ready = encReady(st);
    if (!ready.ok) return null;
    const pool = candidates(locId, st);
    if (!pool.length) return null;
    /* A CONDITION-BORN ENCOUNTER IS NOT A DICE ROLL. If the storm has
       put somebody up a ladder outside the door you just walked
       through, they are up the ladder — the roll is for the ambient
       ones.

       AND THE AMBIENT ROLL IS MADE ONCE, IN THE MORNING, not once per
       doorway. Rolled per arrival at 30% it looked like a third of
       the time and behaved like nine tenths, because a working day is
       seven or eight doorways: reading a play-through, somebody
       stopped Wally in the street on twenty-one days out of
       twenty-two. `encArmed` is the honest version of the same
       number — the city either has a word for you today or it does
       not, and EVENT_TUNING.dayEncChance is that odds, legibly. */
    const forced = pool.find((e) => e.cond);
    if (!forced && !city(st).encArmed) return null;
    return offer((forced || pool[Math.floor(rng() * pool.length) % pool.length]).id, { loc: locId });
  }

  /* ------------------------------------------------------------
     RAISE ONE. Builds the card and emits it. ui/dialogue.js is the
     listener; there is no other. Returns the card so the tests and
     the debug hooks can read it without a DOM.
     ------------------------------------------------------------ */
  function offer(id, opts = {}) {
    const st = S();
    const c = city(st);
    const e = ENCOUNTER_BY_ID[id];
    if (!e) return null;
    const locId = opts.loc || st.loc;
    const l = LOC_BY_ID[locId];
    if (!l) return null;

    const who = e.kind === 'tip'
      ? (opts.who || tipster(locId, st))
      : (opts.who || (e.cast ? e.cast[locId] : null));
    const person = CLIENT_BY_ID[who] || null;
    if (!person) return null;

    /* SAID IT ONCE ALREADY? Say the shorter thing. `again` is
       optional; without one the card repeats, which is correct for an
       encounter that is a fresh occasion each time. */
    const saidBefore = offeredOn.get(e.id);
    const script = (saidBefore != null && saidBefore !== st.day && e.again) ? e.again : e.text;
    let text = (script || []).map((s) => fill(s, person, l));
    let payload = null;
    if (e.kind === 'tip') {
      payload = makeTip(who);
      if (!payload) return null;
      text = [
        fill(payload.opener, person, l),
        '"' + payload.line + '" ' + payload.aside,
      ];
    }

    const card = {
      id: e.id, kind: e.kind, loc: locId, who, day: st.day, at: st.time,
      title: e.title, text, payload,
      mins: e.mins || 0, energy: e.energy || 0,
    };
    c.live = card;
    offeredOn.set(e.id, st.day);
    if (e.kind === 'tip') spokeOn.set(who, st.day);
    /* order matters: read the day BEFORE writing it, or the counter
       never resets and the second encounter of the run is refused
       forever */
    c.encCount = (c.encDay === st.day ? c.encCount : 0) + 1;
    c.encDay = st.day;
    c.encMin = st.time;

    bus.emit('encounter', {
      kind: 'offer',
      id: e.id, enc: e.id, loc: locId,
      speaker: person.n, role: person.role, portrait: person.id,
      title: e.title, text,
      cost: { mins: card.mins, energy: card.energy },
      choices: [
        { label: e.yes, value: 'yes', kind: 'prim' },
        { label: e.no, value: 'no', kind: 'ghost' },
      ],
    });
    return card;
  }

  const fill = (s, person, l) => String(s)
    .replace(/\{who\}/g, person.n)
    .replace(/\{role\}/g, person.role)
    .replace(/\{here\}/g, l.n);

  /* ------------------------------------------------------------
     THE ANSWER. ui/dialogue.js calls this with the chosen value;
     anything that is not 'yes' is a decline, including a card the
     player dismissed without choosing (value null), because a
     dialogue that is closed is a conversation that is over.
     ------------------------------------------------------------ */
  function answer(id, value) {
    return value === 'yes' ? accept(id) : decline(id);
  }

  /* DECLINING COSTS NOTHING. No time, no energy, no reputation, no
     trust, no flag, no memory. The only thing it touches is the
     `live` slot the card was sitting in — the encounter counters
     were already moved by offer(), so a decline cannot buy the
     player a second card either. tools/test-encounters.mjs asserts
     the whole save is unchanged across one, field by field. */
  function decline(id) {
    const c = city();
    const card = c.live;
    if (!card || (id && card.id !== id)) return { ok: false, why: 'nothing on screen' };
    c.live = null;
    const e = ENCOUNTER_BY_ID[card.id];
    if (e && e.passed) M().note('info', e.passed);
    bus.emit('encounter', { kind: 'decline', id: card.id, loc: card.loc, who: card.who });
    return { ok: true, declined: true, id: card.id };
  }

  function accept(id) {
    const st = S();
    const c = city(st);
    const card = c.live;
    if (!card || (id && card.id !== id)) return { ok: false, why: 'nothing on screen' };
    const e = ENCOUNTER_BY_ID[card.id];
    c.live = null;
    if (!e) return { ok: false, why: 'no such encounter' };

    if (card.mins || card.energy) env.advance(card.mins, card.energy);
    if (e.rep) M().addRep(e.rep);
    if (e.trust && card.who) env.clients.addTrust(card.who, e.trust);

    const out = { ok: true, id: e.id, who: card.who, loc: card.loc };

    /* ---- 1. THE AWNING: one door held open against the weather ---- */
    if (e.id === 'shutters') {
      const t = today();
      if (t && !t.spared.includes(card.loc)) t.spared.push(card.loc);
      out.spared = card.loc;
      M().note('good', fill(e.done, CLIENT_BY_ID[card.who], LOC_BY_ID[card.loc]));
    }

    /* ---- 2. THE PICKET: the strike ends a day early ---- */
    if (e.id === 'picket') {
      const t = today();
      if (t && t.id === 'strike') { t.until = st.day; out.settled = true; }
      M().note('good', e.done);
      M().msg('Barnaby', 'They took it back to the authority with your second number written on the front of it. Gate opens in the morning. You are on the tea rota now, obviously.');
    }

    /* ---- 3. THE RUMOUR: logged, and checked tomorrow ---- */
    if (e.kind === 'tip' && card.payload) {
      const tp = tipState(st);
      tp.pending = { who: card.who, news: card.payload.news, up: card.payload.up, day: st.day, asset: card.payload.asset };
      M().msg(CLIENT_BY_ID[card.who].n, card.payload.line);
      M().note('info', 'A word from ' + CLIENT_BY_ID[card.who].n + '. Read the paper in the morning.');
      out.tip = { ...tp.pending };
    }

    bus.emit('encounter', { kind: 'accept', id: e.id, loc: card.loc, who: card.who, ...out });
    return out;
  }

  /* ============================================================
     THE RUMOUR, AND WHY IT IS NOT A PRICE TIP.

     A tip names ONE of the eighteen headlines in NEWS_POOL — the
     ones that already exist, already move a price and already print
     in the morning paper. The only new thing is that a person said
     it to you first, and that whether they were right is now a fact
     the game keeps about that person.

     THE HONESTY RULE. The tipster's reliability decides whether the
     headline is FORCED into tomorrow's roll, and that is decided
     here, tonight, before the roll — but "right" is settled against
     what actually printed. So an unreliable tipster who happens to
     be correct by luck is scored correct, which is the only version
     of this a player can verify by reading the paper.
     ============================================================ */
  function rec(who) {
    const tp = tipState();
    if (!tp.rec[who]) tp.rec[who] = { right: 0, wrong: 0, last: 0 };
    return tp.rec[who];
  }

  /* HOW A PERSON SAYS IT. Not "STMD is going to have a bad morning" —
     that is a terminal talking. They tell you the THING they heard,
     which is the headline, and then what they think it means for the
     one ticker it touches. The headline is already written; all this
     does is put it in somebody's mouth a day early. The mouths
     themselves are TIP_VOICE in data.js, one verdict pair per
     tipster: this is the most frequent encounter in the game, so
     a fixed sentence here is the one the player hears most. */
  function makeTip(who) {
    const st = S();
    const idx = Math.floor(rng() * NEWS_POOL.length) % NEWS_POOL.length;
    const n = NEWS_POOL[idx];
    if (!n || !ASSET_BY_ID[n.a]) return null;
    const a = ASSET_BY_ID[n.a];
    const up = n.e > 0;
    const r = rec(who);
    const seen = r.right + r.wrong;
    return {
      news: idx, asset: n.a, up,
      ...tipVoice(who, n, a, r, rng),
      seen,
    };
  }

  /* economy.rollNews() asks this FIRST, and it answers with an index
     into NEWS_POOL to force, or null. Nothing else in the codebase
     may consume the pending tip — one claim per night, and the claim
     clears the pending flag so a save that reloads mid-morning
     cannot bank it twice. */
  function claimTip() {
    const st = S();
    const tp = tipState(st);
    const p = tp.pending;
    if (!p) return null;
    if (p.day >= st.day) return null;              // told today, prints tomorrow
    const reliability = Math.max(EVENT_TUNING.tipHonourFloor, TIPSTERS[p.who] ?? 0.5);
    const honour = rng() < reliability;
    claimed = { ...p, honour };
    tp.pending = null;
    return honour ? p.news : null;
  }

  /* …and reports what actually printed, so luck counts. */
  function settleTip(news) {
    const st = S();
    const tp = tipState(st);
    const cl = claimed;
    if (!cl) return null;
    claimed = null;
    const hit = (news || []).some((n) => n.a === cl.asset && (n.e > 0) === cl.up);
    const r = rec(cl.who);
    if (hit) r.right++; else r.wrong++;
    r.last = st.day;
    const name = CLIENT_BY_ID[cl.who] ? CLIENT_BY_ID[cl.who].n : cl.who;
    M().msg(name, hit
      ? 'Told you. Do not look so surprised, it is insulting.'
      : 'Right. Well. I did say they were SAYING it. They were. It was still wrong.');
    return { who: cl.who, right: hit, asset: cl.asset };
  }

  /* ============================================================
     THE VIEW FROM THE BASKET.

     game.sense() asks for the radius; at ground level it gets 0 and
     nothing changes. Above AIRVIEW.min the radius is the horizon,
     which is the one thing the Happy Skies' own description has always
     promised and never delivered. It puts places on the MAP and
     nothing else: quests.access() is untouched, so flying over a
     locked door does not open it.
     ============================================================ */
  function airRadius(alt) {
    if (!Number.isFinite(alt) || alt < AIRVIEW.min) return 0;
    return Math.min(AIRVIEW.max, alt * AIRVIEW.gain);
  }
  function firstFlightBanner() {
    const st = S();
    if (st.flags.sawIsland) return false;
    st.flags.sawIsland = true;
    M().banner(AIRVIEW.banner[0], AIRVIEW.banner[1]);
    return true;
  }

  /* ============================================================
     VIEWS
     ============================================================ */
  function view() {
    const st = S();
    const t = today();
    const tp = tipState(st);
    return {
      weather: st.weather,
      today: t ? {
        id: t.id, n: t.n, zone: t.zone, line: t.line, title: t.title, sub: t.sub,
        shut: t.shut.filter((id) => shut(id).shut),
        spared: t.spared.slice(),
        open: t.open.map((o) => ({ ...o })),
        from: t.from, until: t.until, days: t.until - t.day + 1,
      } : null,
      live: city(st).live ? { ...city(st).live } : null,
      encounters: { day: city(st).encDay, count: city(st).encCount, at: city(st).encMin },
      tips: {
        pending: tp.pending ? { ...tp.pending } : null,
        record: Object.keys(tp.rec).map((k) => ({
          who: k, n: CLIENT_BY_ID[k] ? CLIENT_BY_ID[k].n : k, ...tp.rec[k],
        })).sort((a, b) => (b.right + b.wrong) - (a.right + a.wrong)),
      },
    };
  }

  return {
    /* the day */
    today, todayId, rollDay, view, spec, eligible, canRun, applyWeather,
    weatherName: () => S().weather,
    /* doors */
    shut, openUntil,
    /* encounters */
    onPlace, offer, answer, accept, decline, candidates, encReady, tipster,
    live: () => city().live,
    /* rumours */
    claimTip, settleTip, makeTip, tipRecord: () => ({ ...tipState().rec }),
    /* the air */
    airRadius, firstFlightBanner, AIRVIEW,
    /* for save.js and the tests */
    city, tipState,
  };
}

export default createEvents;
