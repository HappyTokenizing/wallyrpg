/* ============================================================
   clients.js — the 24 people who actually pay you.

   Taste matching:
     - a client will NEVER be offered something in `hate`
     - 72 % of the time the basket is drawn only from `fav`
     - the price ceiling they will look at is
         380 + trust*320 + rep*85 + (budget-1)*560
     - `patience` buys an extra day of deadline at 4+
     - `trust` (0..n) raises generosity, the fee, and the ceiling

   Arrivals: clients come to YOU. Your office is the folding table
   in the flat until you rent a real one, so arrivals follow
   game.officeLoc(). One wanders in roughly every 90 in-game
   minutes between 08:00 and 20:00.
   ============================================================ */

import { CLIENTS, CLIENT_BY_ID, ASSET_BY_ID, NPC_POSTS, FIRST_ORDER, tickerQty } from './data.js';

const FUND_NAMES = {
  Stocks: 'Growth', Bonds: 'Safe City', Farm: 'Farm & Food', Minerals: 'Deep Earth',
  Property: 'Main Street', Culture: 'Culture Collection', Infrastructure: 'Future Energy',
  Business: 'Local Champions', Sports: 'Stampede Support', Transport: 'Moving City',
};

export function createClients(env) {
  const bus = env.bus;
  const S = () => env.state;
  const M = () => env.mutate;
  const E = () => env.economy;

  let arrivalClock = 0;
  let orderSeq = 0;

  /* ---------- lookup ---------- */
  const all = () => CLIENTS;
  const get = (id) => CLIENT_BY_ID[id] || null;
  const stateOf = (id) => S().clients[id] || null;
  const trust = (id) => (S().clients[id] ? S().clients[id].trust : 0);
  const met = (id) => !!(S().clients[id] && S().clients[id].met);

  function meet(id) {
    const cs = S().clients[id];
    if (!cs || cs.met) return false;
    cs.met = true;
    bus.emit('client', { kind: 'meet', client: id });
    M().msg(CLIENT_BY_ID[id].n, CLIENT_BY_ID[id].intro);
    env.quests?.check();
    return true;
  }
  function addTrust(id, n) {
    const cs = S().clients[id];
    if (!cs) return 0;
    cs.trust = Math.max(0, cs.trust + n);
    bus.emit('client', { kind: 'trust', client: id, trust: cs.trust });
    return cs.trust;
  }
  /* how many clients are at or above a trust bar — the stadium needs 8 at 6 */
  function trustedCount(bar = 6) {
    return CLIENTS.filter((c) => trust(c.id) >= bar).length;
  }
  /* ---------- who is standing here ----------
     THE BUG THIS FIXES. at() placed every client by their home ZONE
     and nothing else, so Otto — who lives in Rusty Row — was never in
     The Bent Spoon on Main Street, which is the one room the opening
     message sends the player to. The friend you are told to meet was
     in a different district for the whole of act one.

     A POST is an explicit "this person is waiting HERE, until this
     flag is set" (data.js NPC_POSTS). Posts come first in the list and
     carry `waiting: true` plus the line the world agent should use, so
     the NPC layer can stand them in the right room and give them
     something to say. */
  function postsAt(locId) {
    const st = S();
    return NPC_POSTS
      .filter((p) => p.loc === locId && !st.flags[p.until] && CLIENT_BY_ID[p.client])
      .map((p) => ({ ...CLIENT_BY_ID[p.client], waiting: true, post: p.loc, line: p.line, until: p.until }));
  }
  /* Is this person waiting at this exact place right now? */
  function waitingAt(clientId, locId) {
    return postsAt(locId).some((c) => c.id === clientId);
  }
  function at(locId) {
    const st = S();
    const loc = env.data.locationById[locId];
    if (!loc) return [];
    const posted = postsAt(locId);
    const seen = new Set(posted.map((c) => c.id));
    /* SOMEBODY WAITING SOMEWHERE IS NOT ALSO AT HOME. Otto's post is
       the Bent Spoon; until he has been met he must not also turn up
       in Rusty Row, or the player meets him in the wrong room. */
    const elsewhere = new Set(NPC_POSTS
      .filter((p) => p.loc !== locId && !st.flags[p.until])
      .map((p) => p.client));
    const locals = CLIENTS.filter((c) => !seen.has(c.id) && !elsewhere.has(c.id) && c.home === loc.z
      && (st.clients[c.id].met || c.budget === 1));
    return posted.concat(locals);
  }

  /* ---------- taste matching ---------- */
  function ceilingFor(c, cs) {
    return 380 + cs.trust * 320 + S().rep * 85 + (c.budget - 1) * 560;
  }
  function likes(clientId, assetId) {
    const c = CLIENT_BY_ID[clientId], a = ASSET_BY_ID[assetId];
    if (!c || !a) return 0;
    if (c.hate.includes(a.cat)) return -1;
    return c.fav.includes(a.cat) ? 1 : 0;
  }

  /* ============================================================
     THE FIRST ORDER IN THE GAME IS ALWAYS CRUMB.

     See data.js FIRST_ORDER for the full why. The short version:
     taking an order at the desk is what sends the player to the
     Business Broker (q_broker), so the order had better be for
     something the Business Broker actually sells. A rolled basket is
     not, four times out of five — the pool is all 69 assets across
     twelve venues.

     THE LATCH IS ON ACCEPTANCE, NOT ON CREATION. economy.acceptOrder()
     sets flags.firstOrderTaken. Until then EVERY order this module
     builds is the CRUMB one, so it does not matter how many arrivals
     came and went overnight, which client walked in, or whether the
     player met Otto in the cafe before ever working a shift — the
     order he picks up is the one the objective is about. After it,
     makeOrder() rolls exactly as it always did and the variety of the
     other 68 assets is completely untouched.

     Deterministic: it consumes no rng, so a seeded run produces the
     same first order every time. tools/test-game.mjs checks that
     across a hundred seeds and both routes in.
     ============================================================ */
  function firstOrderPending() {
    const st = S();
    if (st.flags[FIRST_ORDER.flag]) return false;
    /* SELF-HEALING, for a save written before this flag existed and
       for anything that fabricates a player mid-career. A book with
       orders in it, or a career with orders behind it, is not somebody
       waiting for their first client — latch and get out of the way,
       or an established broker's next basket would arrive as a single
       croissant. */
    if (st.stats.ordersDone > 0 || st.orders.length > 0) { st.flags[FIRST_ORDER.flag] = true; return false; }
    return true;
  }
  const crumbAsset = () => ASSET_BY_ID[FIRST_ORDER.asset];

  /* The authored basket. One unit, a friend's margin, a long fuse. */
  function crumbOrder(clientId, opts = {}) {
    const st = S();
    const c = CLIENT_BY_ID[clientId];
    const a = crumbAsset();
    if (!c || !a) return null;
    const cost = E().buyPrice(a.id);
    return {
      id: opts.id || ('o_first_' + clientId),
      client: clientId,
      type: 'deliver',
      name: null,
      items: [{ a: a.id, q: FIRST_ORDER.qty, t: a.tick }],
      budget: Math.round(cost * FIRST_ORDER.margin),
      fee: Math.round(cost * FIRST_ORDER.feeRate) + FIRST_ORDER.feeFlat,
      deadline: st.day + FIRST_ORDER.days,
      made: st.day,
      warned: false,
      first: true,                              // the tests and the UI both ask
      keep: !!opts.keep,                        // survives the nightly desk wipe
      line: opts.line || FIRST_ORDER.line,
    };
  }

  function makeOrder(clientId) {
    const st = S();
    const c = CLIENT_BY_ID[clientId], cs = st.clients[clientId];
    if (!c || !cs) return null;
    /* THE ONE FORCED BASKET, ahead of every roll below. The hate check
       is belt and braces — only Mr. Ledger hates Business and he is a
       budget-4 client who cannot possibly be the first through the
       door — but a content edit should not be able to hand somebody an
       order they would refuse on sight. */
    if (firstOrderPending() && !c.hate.includes(crumbAsset().cat)) return crumbOrder(clientId);
    const ceiling = ceilingFor(c, cs);
    const pool = E().sourceable().filter((a) => !c.hate.includes(a.cat) && E().price(a.id) <= ceiling);
    if (!pool.length) return null;

    const favPool = pool.filter((a) => c.fav.includes(a.cat));
    const usable = favPool.length && env.rng() < 0.72 ? favPool : pool;

    const fundOrder = !!st.skills.fundcon && cs.trust >= 3 &&
      st.funds.length < E().fundCap() && env.rng() < 0.32;
    const count = fundOrder ? 2 + Math.floor(env.rng() * 3) : (env.rng() < 0.7 ? 1 : 2);

    const items = [], used = {};
    let guard = 0;
    while (items.length < count && guard++ < 40) {
      const pick = usable[Math.floor(env.rng() * usable.length)];
      if (!pick || used[pick.id]) continue;
      used[pick.id] = 1;
      const q = E().price(pick.id) < 120 ? 1 + Math.floor(env.rng() * 3) : 1;
      /* `t` is the ticker, carried on the item so an order reads as a
         trade ticket without a lookup. `a` remains the canonical id and
         is what every economy call uses; `t` is presentation only, and
         ticket() below re-derives it so orders in older saves still
         render correctly. */
      items.push({ a: pick.id, q, t: pick.tick });
    }
    if (!items.length) return null;

    const cost = items.reduce((t, it) => t + E().price(it.a) * it.q, 0);
    const generosity = 1.12 + cs.trust * 0.012 + (c.budget - 1) * 0.02;
    const budget = Math.round(cost * generosity);
    const fee = Math.round(cost * (0.07 + cs.trust * 0.006) + 25);
    const days = fundOrder ? 6 : 3 + Math.floor(env.rng() * 3) + (c.patience >= 4 ? 1 : 0);

    return {
      id: 'o' + st.day + '_' + (orderSeq++) + '_' + clientId,
      client: clientId,
      type: fundOrder ? 'fund' : 'deliver',
      name: fundOrder ? fundName(items) : null,
      items, budget, fee,
      deadline: st.day + days,
      made: st.day,
      warned: false,
      line: c.intro,
    };
  }
  function fundName(items) {
    const cat = ASSET_BY_ID[items[0].a].cat;
    return (FUND_NAMES[cat] || 'City Growth') + ' Fund';
  }

  /* '2x WHEAT · GOLD' — an order as a trade ticket. Derived from `a`,
     so it works for orders saved before items carried a ticker. */
  function ticket(o, sep = ' · ') {
    const items = Array.isArray(o) ? o : (o && Array.isArray(o.items) ? o.items : []);
    return items.map((it) => tickerQty(it.a, it.q)).join(sep);
  }

  /* ---------- arrivals ----------
     NOBODY BRINGS YOU WORK UNTIL YOU HAVE WORKED A SHIFT AT DISPATCH.
     That is the third beat of the opening (see QUESTS in data.js): the
     shift is what puts Wally's name about, and until flags.dispatchShift
     is set there are no arrivals, no daily offers and no first order to
     take. One gate, checked in the one place arrivals are created. */
  const ordersUnlocked = () => !!S().flags.dispatchShift;
  const arrivals = () => S().arrivals;
  function hasArrival(cid) { return S().arrivals.some((o) => o.client === cid); }
  function addArrival(o) {
    S().arrivals.push(o);
    bus.emit('client', { kind: 'arrive', client: o.client, order: o });
    return o;
  }
  function removeArrival(o) {
    const st = S();
    st.arrivals = st.arrivals.filter((x) => x !== o && x.id !== o.id);
  }

  function candidates() {
    const st = S();
    const first = firstOrderPending();
    return CLIENTS.filter((c) => {
      const cs = st.clients[c.id];
      if (hasArrival(c.id)) return false;
      if (st.orders.some((o) => o.client === c.id)) return false;
      if (c.id === 'vance') return false;                 // only via his own office
      /* while the CRUMB order is the only order this game will build,
         somebody who would not touch a bakery cannot be the one to
         ask for it */
      if (first && c.hate.includes(crumbAsset().cat)) return false;
      if (c.budget === 1) return true;
      if (c.budget === 2) return st.rep >= 8 || cs.met;
      if (c.budget === 3) return st.rep >= 22;
      if (c.budget === 4) return st.rep >= 45;
      return st.rep >= 65;
    });
  }

  /* is the forced first order already sitting on the desk, unclaimed? */
  const pendingFirst = () => S().arrivals.find((o) => o && o.first) || null;

  function newArrival() {
    const st = S();
    if (!ordersUnlocked()) return null;
    /* ONE FIRST ORDER, NOT THREE. While the CRUMB basket is forced,
       a second arrival would be a second person asking for the same
       loaf, which reads as a bug even though it is not one. The desk
       stays a one-item desk until that order is taken. */
    if (firstOrderPending() && pendingFirst()) return null;
    const pool = candidates();
    if (!pool.length || st.arrivals.length >= 4) return null;
    const c = pool[Math.floor(env.rng() * pool.length)];
    const o = makeOrder(c.id);
    if (!o) return null;
    addArrival(o);
    if (st.clients[c.id].met) {
      M().msg(c.n, 'I have dropped something in at your office. No rush. Some rush.');
    }
    return o;
  }

  function seedArrivals() {
    const st = S();
    if (!ordersUnlocked()) return;
    const n = 1 + (st.rep >= 15 ? 1 : 0) + (st.rep >= 40 ? 1 : 0);
    for (let i = 0; i < n; i++) newArrival();
  }

  /* called from game.time.advance */
  function tick(mins) {
    arrivalClock += mins;
    if (arrivalClock < 90) return null;
    arrivalClock = 0;
    const st = S();
    const hour = Math.floor(st.time / 60) % 24;
    if (hour < 8 || hour > 20) return null;
    if (st.arrivals.length >= 3) return null;
    if (env.rng() > 0.42) return null;
    const o = newArrival();
    if (o) M().note('token', CLIENT_BY_ID[o.client].n + ' is waiting at your office');
    return o;
  }

  /* fresh offers from met clients at the start of a day */
  function dailyOffers() {
    const st = S();
    if (!ordersUnlocked()) return;
    /* same one-desk rule as newArrival(): the morning does not pile a
       second CRUMB request on top of the untouched one */
    if (firstOrderPending() && pendingFirst()) return;
    const crumbCat = crumbAsset().cat;
    const metIds = CLIENTS.filter((c) => (st.clients[c.id].met || c.budget === 1)
      && !(firstOrderPending() && c.hate.includes(crumbCat))).map((c) => c.id);
    const offers = firstOrderPending() ? 1 : 1 + Math.floor(st.rep / 28);
    for (let i = 0; i < offers; i++) {
      const cid = metIds[Math.floor(env.rng() * metIds.length)];
      if (!cid) break;
      if (st.clients[cid].lastDay === st.day) continue;
      const o = makeOrder(cid);
      if (o) { addArrival(o); st.clients[cid].lastDay = st.day; }
    }
  }

  function resetClock() { arrivalClock = 0; }

  return {
    all, get, stateOf, trust, met, meet, addTrust, trustedCount, at, postsAt, waitingAt,
    likes, ceilingFor, makeOrder, ticket,
    /* the forced opening order — see FIRST_ORDER in data.js */
    crumbOrder, firstOrderPending, pendingFirst,
    arrivals, hasArrival, addArrival, removeArrival, candidates, ordersUnlocked,
    newArrival, seedArrivals, dailyOffers, tick, resetClock,
  };
}
