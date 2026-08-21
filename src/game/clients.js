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

import { CLIENTS, CLIENT_BY_ID, ASSET_BY_ID, tickerQty } from './data.js';

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
  /* who is standing around a given location right now */
  function at(locId) {
    const st = S();
    const loc = env.data.locationById[locId];
    if (!loc) return [];
    return CLIENTS.filter((c) => c.home === loc.z && (st.clients[c.id].met || c.budget === 1));
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

  function makeOrder(clientId) {
    const st = S();
    const c = CLIENT_BY_ID[clientId], cs = st.clients[clientId];
    if (!c || !cs) return null;
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
    return CLIENTS.filter((c) => {
      const cs = st.clients[c.id];
      if (hasArrival(c.id)) return false;
      if (st.orders.some((o) => o.client === c.id)) return false;
      if (c.id === 'vance') return false;                 // only via his own office
      if (c.budget === 1) return true;
      if (c.budget === 2) return st.rep >= 8 || cs.met;
      if (c.budget === 3) return st.rep >= 22;
      if (c.budget === 4) return st.rep >= 45;
      return st.rep >= 65;
    });
  }

  function newArrival() {
    const st = S();
    if (!ordersUnlocked()) return null;
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
    const metIds = CLIENTS.filter((c) => st.clients[c.id].met || c.budget === 1).map((c) => c.id);
    const offers = 1 + Math.floor(st.rep / 28);
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
    all, get, stateOf, trust, met, meet, addTrust, trustedCount, at,
    likes, ceilingFor, makeOrder, ticket,
    arrivals, hasArrival, addArrival, removeArrival, candidates, ordersUnlocked,
    newArrival, seedArrivals, dailyOffers, tick, resetClock,
  };
}
