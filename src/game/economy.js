/* ============================================================
   economy.js — prices, spreads, inventory, orders, funds,
   tokenization, the five fee types and the daily roll.

   THE FIVE FEES (all money that moves for reasons other than an
   asset changing hands):
     1  spread     venue bid/ask, VENUES[v].spread, both directions
     2  liquidity  extra sell haircut, (5 - liquidity) * 3.5 %
     3  filing     tokenization cost, price * 0.13 * tq (min $60)
     4  management weekly 1.5 % of fund value, scaled by satisfaction
     5  fare       travel, charged by game.travel()
   Plus the two recurring drains: weekly rent and daily salaries.
   ============================================================ */

import { baseWeather } from './events.js';
import {
  CONFIG, ASSETS, ASSET_BY_ID, ASSET_BY_TICK, VENUES, VENUE_LOC, CLIENT_BY_ID, OFFICE_STAGES,
  HOME_BY_ID, EMPLOYEE_BY_ID, NEWS_POOL, WALLYNET_GOOD, WALLYNET_BAD, LOC_BY_ID,
  byTicker, assetIdOf, assetLabel, tickerQty, searchAssets, normTicker, orderFailRep,
  FIRST_ORDER,
} from './data.js';
import { round2, clamp } from './state.js';

export function createEconomy(env) {
  const bus = env.bus;
  const M = () => env.mutate;          // state mutation layer
  const S = () => env.state;

  /* ============================================================
     TICKERS ARE FIRST-CLASS.

     Every function below that takes an asset takes an id OR a ticker,
     in any casing, with any spacing: price('GOLD'), buy('wheat', 3),
     owned(' b5y ') all work, and so does the canonical id. idOf() is
     the single funnel — it resolves EXACTLY (never fuzzily), and hands
     an unrecognised string straight through, so the existing "no such
     asset" refusals still fire with the string the caller passed.

     Fuzzy matching is a separate, explicitly-named door: search().
     ============================================================ */
  const idOf = (x) => assetIdOf(x) || x;
  const assetOf = (x) => byTicker(x);
  const ticker = (x) => { const a = byTicker(x); return a ? a.tick : null; };
  /* 'GOLD · Gold Seam Token'. Every place an asset is described to the
     player should lead with this rather than concatenating by hand. */
  const label = (x, sep) => assetLabel(x, sep);
  const labelIco = (x, sep) => { const a = byTicker(x); return a ? a.ico + ' ' + a.tick + (sep || ' · ') + a.n : label(x, sep); };
  /* Exact, case-insensitive, whitespace-tolerant. Null if unknown. */
  const findByTicker = (x) => byTicker(x);
  /* Fuzzy/prefix over ticker AND name: 'gol' -> GOLD, 'wheat' -> WHEAT. */
  const search = (q, limit) => searchAssets(q, limit);
  /* '2x WHEAT · GOLD' — an order rendered as a trade ticket. Takes an
     order, a fund, or a bare [{a,q}] item list. */
  function ticket(x, sep = ' · ') {
    const items = Array.isArray(x) ? x : (x && Array.isArray(x.items) ? x.items : []);
    return items.map((it) => tickerQty(it.a, it.q)).join(sep);
  }

  /* ---------- formatting ---------- */
  function fmt(n) {
    n = round2(n);
    return n.toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) < 100 ? 2 : 0 });
  }

  /* ---------- prices ---------- */
  function price(id) {
    id = idOf(id);
    const p = S().prices[id];
    return Number.isFinite(p) && p > 0 ? p : (ASSET_BY_ID[id] ? ASSET_BY_ID[id].v : 0);
  }
  function clampPrice(id, p) {
    id = idOf(id);
    const a = ASSET_BY_ID[id];
    if (!a) return 0;
    if (!Number.isFinite(p) || p <= 0) p = a.v;
    return round2(clamp(p, a.v * 0.42, a.v * 2.7));
  }
  function liquidity(id) {
    id = idOf(id);
    const a = ASSET_BY_ID[id];
    if (!a) return 1;
    return Math.min(5, a.q + (S().tokenized[id] ? 1 : 0) + (S().swap.pools[id] ? 1 : 0));
  }
  function spread(venue) {
    const v = VENUES[venue];
    return v ? v.spread : 0.06;
  }
  function buyPrice(id, venue) { id = idOf(id); return round2(price(id) * (1 + spread(venue === undefined ? venueOf(id) : venue))); }
  function sellPrice(id, venue) {
    id = idOf(id);
    if (venue === undefined) venue = venueOf(id);
    const liqPenalty = (5 - liquidity(id)) * 0.035;
    const v = VENUES[venue];
    return round2(price(id) * (1 - (v ? v.spread : 0.10) - liqPenalty));
  }
  function trend(id) { return S().trend[idOf(id)] || 0; }
  function history(id) { return (S().hist[idOf(id)] || []).slice(); }
  function venueOf(id) { const a = byTicker(id); return a ? a.ven : null; }
  function venueHours(v) { return VENUES[v] ? VENUES[v].hours : [0, 24]; }
  function venueOpenNow(v) {
    const h = venueHours(v);
    const hour = Math.floor(S().time / 60) % 24;
    return hour >= h[0] && hour < h[1];
  }

  /* ---------- inventory ---------- */
  function owned(id) { const e = S().inv[idOf(id)]; return e ? e.qty : 0; }
  function free(id) { const e = S().inv[idOf(id)]; return e ? Math.max(0, e.qty - (e.locked || 0)) : 0; }
  /* SHELF UNITS — what actually takes up room in the office.
     A LOCKED unit is inside a client fund: it is in custody, it
     belongs to that fund's holders, and Wally can neither sell it nor
     spend it. Counting it against his own shelf meant every fund he
     launched permanently shrank his inventory, so at the top of the
     game "run a full book of funds" and "own all 69 assets" were two
     upgrades fighting over one number. Three separate questions now:
       invCount()   shelf units  (qty - locked)   — what invCap gates
       invHeld()    gross units  (qty)            — everything on paper
       invLocked()  the difference                — committed to funds */
  function invCount() {
    let n = 0;
    for (const k in S().inv) { const e = S().inv[k]; n += Math.max(0, e.qty - (e.locked || 0)); }
    return round2(n);
  }
  function invHeld() { let n = 0; for (const k in S().inv) n += S().inv[k].qty; return round2(n); }
  function invLocked() { let n = 0; for (const k in S().inv) { const e = S().inv[k]; n += Math.min(e.qty, e.locked || 0); } return round2(n); }
  function invCap() {
    const home = HOME_BY_ID[S().home] || HOME_BY_ID.rusty;
    return OFFICE_STAGES[S().office].invCap + (home.store || 0);
  }
  function distinctOwned() { let n = 0; for (const k in S().inv) if (S().inv[k].qty > 0) n++; return n; }
  function avgCost(id) { const e = S().inv[idOf(id)]; return e && e.qty > 0 ? round2(e.cost / e.qty) : 0; }

  function add(id, qty, cost) {
    const st = S();
    id = idOf(id);
    if (!ASSET_BY_ID[id] || !Number.isFinite(qty) || qty <= 0) return false;
    if (!st.inv[id]) st.inv[id] = { qty: 0, cost: 0, locked: 0 };
    st.inv[id].qty = round2(st.inv[id].qty + qty);
    st.inv[id].cost = round2(st.inv[id].cost + (cost || 0));
    bus.emit('inv', { id, qty: st.inv[id].qty });
    env.quests?.check();
    return true;
  }
  function remove(id, qty) {
    const st = S();
    id = idOf(id);
    const e = st.inv[id];
    if (!e) return false;
    if (free(id) + 1e-4 < qty) return false;
    const avg = e.qty > 0 ? e.cost / e.qty : 0;
    e.qty = round2(e.qty - qty);
    e.cost = round2(Math.max(0, e.cost - avg * qty));
    if (e.qty <= 1e-4) delete st.inv[id];
    bus.emit('inv', { id, qty: st.inv[id] ? st.inv[id].qty : 0 });
    return true;
  }

  /* ---------- THE COUNTER IS SHUT WHEN THE BUILDING IS SHUT ----------
     Every venue carries hours and every venue lives in a building that
     carries the same hours, and until now neither was enforced
     anywhere but in the UI's own greying-out: economy.buy() would sell
     you gold at four in the morning. tradeGate() is the rules-layer
     answer, and it is also where maximum hunger stops trading.

       venue given   the venue's own hours (VENUES[v].hours)
       venue null    an off-market deal — the pawn shop is the only
                     one — so the hours are the ones on the counter
                     he is actually standing at.
     ------------------------------------------------------------ */
  function tradeGate(venue, what) {
    /* max hunger locks trading like everything else (game.js gate) */
    const hg = env.gate ? env.gate('trade', { loc: null }) : { ok: true };
    if (!hg.ok) return hg;
    const st = S();
    if (venue && VENUES[venue]) {
      if (!venueOpenNow(venue)) {
        const h = VENUES[venue].hours;
        return { ok: false, kind: 'hours', venue,
          why: VENUES[venue].name + ' is closed — it opens at ' + String(h[0]).padStart(2, '0') + ':00.' };
      }
      return { ok: true };
    }
    /* off-market: whatever counter he is standing at */
    const loc = LOC_BY_ID[st.loc];
    if (loc && env.isOpenLoc && !env.isOpenLoc(st.loc)) {
      return { ok: false, kind: 'hours', why: env.closedLine ? env.closedLine(st.loc) : loc.n + ' is closed.' };
    }
    return { ok: true };
  }

  /* ---------- buy / sell ---------- */
  function buy(id, qty = 1, venue = undefined, unitOverride = null) {
    id = idOf(id);
    if (!ASSET_BY_ID[id]) return { ok: false, why: 'No such asset' };
    if (venue === undefined) venue = venueOf(id);
    const gate = tradeGate(venue, 'buy');
    if (!gate.ok) return gate;
    const unit = unitOverride != null ? unitOverride : buyPrice(id, venue);
    const total = round2(unit * qty);
    if (!M().afford(total)) return { ok: false, why: 'Not enough money' };
    if (invCount() + qty > invCap()) return { ok: false, why: 'No inventory space — upgrade your office' };
    M().pay(-total, 'bought ' + ASSET_BY_ID[id].tick);
    add(id, qty, total);
    bus.emit('trade', { kind: 'buy', id, qty, unit, total });
    return { ok: true, unit, total };
  }
  function sell(id, qty = 1, venue = undefined) {
    id = idOf(id);
    if (!ASSET_BY_ID[id]) return { ok: false, why: 'No such asset' };
    if (venue === undefined) venue = venueOf(id);
    const gate = tradeGate(venue, 'sell');
    if (!gate.ok) return gate;
    if (free(id) + 1e-4 < qty) return { ok: false, why: 'Those units are locked in a client fund' };
    const unit = sellPrice(id, venue);
    const total = round2(unit * qty);
    remove(id, qty);
    M().pay(total, 'sold ' + ASSET_BY_ID[id].tick);
    bus.emit('trade', { kind: 'sell', id, qty, unit, total });
    return { ok: true, unit, total };
  }

  /* Can Wally pay for this right now? Every gate in game.js asks here
     rather than reading S().money, so a future overdraft or credit
     rule lands in exactly one place. */
  function afford(n) {
    if (!Number.isFinite(n)) return false;
    return S().money >= n;
  }

  function netWorth() {
    let n = S().money;
    for (const k in S().inv) n += S().inv[k].qty * price(k);
    return Math.round(n);
  }

  /* ---------- what you are allowed to source ---------- */
  function venueOpen(v) {
    const u = S().unlocks;
    if (v === 'exchange') return !!u.exchange;
    if (v === 'treasury') return !!u.treasury;
    if (v === 'farmcoop') return !!u.farmcoop;
    if (v === 'mineral') return !!u.mineral;
    if (v === 'stadiumoffice') return !!u.stadiumoffice;
    return true;
  }
  function sourceable() { return ASSETS.filter((a) => venueOpen(a.ven)); }

  /* ---------- office capacity ----------
     THREE NUMBERS, ONE TABLE. Every one of them reads OFFICE_STAGES
     and nothing else, and the top stage is sized to the content:
     10 seats for 10 specialists, 24 slots and 24 funds for 24
     clients. The two employee bonuses stay, but at Wally Tower they
     are a courtesy rather than the difference between shipping and
     not — see the note above OFFICE_STAGES in data.js. */
  function teamSeats() {
    return OFFICE_STAGES[S().office].seats;
  }
  function teamFree() { return Math.max(0, teamSeats() - S().employees.length); }
  function orderSlots() {
    let n = OFFICE_STAGES[S().office].slots;
    if (S().employees.includes('pim')) n += 1;
    return n;
  }
  function fundCap() {
    let base = OFFICE_STAGES[S().office].fundCap;
    if (S().employees.includes('mattie')) base += 1;
    return base;
  }

  /* ---------- orders ---------- */
  function acceptOrder(o) {
    const st = S();
    if (!o) return { ok: false, why: 'No order' };
    const hg = env.gate ? env.gate('order', { loc: null }) : { ok: true };
    if (!hg.ok) return hg;
    if (st.orders.length >= orderSlots()) return { ok: false, why: 'No free order slots — upgrade the office' };
    st.orders.push(o);
    st.clients[o.client].met = true;
    st.arrivals = st.arrivals.filter((x) => x.id !== o.id);
    /* PICKING AN ORDER UP AT THE DESK IS A STORY BEAT, not just a
       transaction: it closes q_first_client, it makes the Business
       Broker a place Wally has heard of (LOCATIONS.broker `see`), and
       q_broker — the next objective — sends him there. One flag, set
       in the one place an order is ever taken. */
    st.flags.orderTaken = true;
    /* AND THE SECOND LATCH, in the same one place. Until an order has
       been ACCEPTED, clients.makeOrder() forces the CRUMB basket so
       that the objective above ("go and see the Business Broker") and
       the shopping list agree. This is the line that releases it —
       every order after this one rolls normally. See FIRST_ORDER in
       data.js. */
    st.flags[FIRST_ORDER.flag] = true;
    bus.emit('client', { kind: 'accept', client: o.client, order: o });
    M().note('good', 'Order accepted from ' + CLIENT_BY_ID[o.client].n);
    env.quests?.check();
    return { ok: true, order: o };
  }

  function canComplete(o) {
    return !!o && o.items.every((it) => free(it.a) + 1e-4 >= it.q);
  }

  function completeOrder(o) {
    const st = S();
    if (!canComplete(o)) return { ok: false, why: 'You do not have everything yet' };
    const cs = st.clients[o.client], c = CLIENT_BY_ID[o.client];
    const late = st.day > o.deadline;

    if (o.type === 'fund') {
      for (const it of o.items) {
        const e = st.inv[it.a];
        e.locked = (e.locked || 0) + it.q;
      }
      const val = o.items.reduce((t, it) => t + price(it.a) * it.q, 0);
      st.funds.push({
        id: 'f' + o.id, name: o.name, client: o.client, items: o.items,
        value: Math.round(val), weekly: Math.round(val * 0.015),
        satisfaction: late ? 62 : 86, made: st.day,
      });
      M().pay(Math.round(val * 0.10) + o.fee, 'fund launch fee');
    } else {
      for (const it of o.items) remove(it.a, it.q);
      M().pay(o.budget + o.fee, 'order from ' + c.n);
    }

    cs.done++;
    cs.trust += late ? 1 : 2;
    M().addRep(late ? 1 : 2 + Math.floor(cs.trust / 4));
    st.stats.ordersDone++;
    st.orders.splice(st.orders.indexOf(o), 1);
    bus.emit('client', { kind: 'complete', client: o.client, order: o, late });
    if (!late && env.rng() < 0.5) postWallyNet(true, c.n);
    env.quests?.check();
    return { ok: true, late };
  }

  /* MISSING A DEADLINE COSTS REPUTATION, AND IT SCALES.

     This is the only order-failure path in the game — newDay() calls
     it the morning after the deadline passes — and it used to take a
     flat 2 points whether the client had been promised a $180 pair of
     sneakers or a $12,000 basket of their savings. data.js
     orderFailRep() scales it with what was promised and caps it at 14;
     a fund mandate costs half again. The client's own trust penalty
     is unchanged. */
  function failOrder(o, silent) {
    const st = S();
    const cs = st.clients[o.client];
    const repCost = orderFailRep(o);
    cs.failed++;
    cs.trust = Math.max(0, cs.trust - 2);
    M().addRep(-repCost);
    st.stats.ordersFailed++;
    st.stats.repLost = Math.round(((st.stats.repLost || 0) + repCost) * 10) / 10;
    const i = st.orders.indexOf(o);
    if (i >= 0) st.orders.splice(i, 1);
    if (!silent) {
      M().note('bad', CLIENT_BY_ID[o.client].n + ' gave up waiting · −' + repCost + ' reputation');
      if (env.rng() < 0.6) postWallyNet(false, CLIENT_BY_ID[o.client].n);
    }
    bus.emit('client', { kind: 'fail', client: o.client, order: o, rep: -repCost });
    return { rep: -repCost };
  }

  function postWallyNet(good, who) {
    const pool = good ? WALLYNET_GOOD : WALLYNET_BAD;
    const st = S();
    st.wallynet.unshift({ who, good, day: st.day, text: pool[Math.floor(env.rng() * pool.length)] });
    if (st.wallynet.length > 30) st.wallynet.pop();
  }

  /* ---------- funds ---------- */
  function dissolveFund(fid) {
    const st = S();
    const i = st.funds.findIndex((f) => f.id === fid);
    if (i < 0) return { ok: false, why: 'No such fund' };
    const f = st.funds[i];
    for (const it of f.items) {
      const e = st.inv[it.a];
      if (e) e.locked = Math.max(0, (e.locked || 0) - it.q);
    }
    st.funds.splice(i, 1);
    st.clients[f.client].trust = Math.max(0, st.clients[f.client].trust - 1);
    M().addRep(-2);
    return { ok: true };
  }

  /* ---------- tokenization (fee type 3) ---------- */
  function tokenizeCost(id) {
    id = idOf(id);
    const a = ASSET_BY_ID[id];
    if (!a) return 0;
    let base = Math.max(60, price(id) * 0.13 * a.tq);
    if (S().employees.includes('orla')) base *= 0.7;
    return Math.round(base);
  }
  function canTokenize(id) {
    id = idOf(id);
    const a = ASSET_BY_ID[id];
    if (!a) return { ok: false, why: 'No such asset' };
    if (S().tokenized[id]) return { ok: false, why: 'Already tokenized' };
    if (owned(id) < 1) return { ok: false, why: 'You must own at least 1 unit' };
    if (a.tq >= 2 && !S().skills.inspection) return { ok: false, why: 'Needs the Asset Inspection class' };
    if (a.tq >= 3 && !S().skills.valuation) return { ok: false, why: 'Needs the Business Valuation class' };
    if (!M().afford(tokenizeCost(id))) return { ok: false, why: 'Needs $' + fmt(tokenizeCost(id)) + ' in filing costs' };
    return { ok: true, cost: tokenizeCost(id) };
  }
  function tokenize(id) {
    id = idOf(id);
    const hg = env.gate ? env.gate('trade', { loc: null }) : { ok: true };
    if (!hg.ok) return hg;
    const chk = canTokenize(id);
    if (!chk.ok) return chk;
    const st = S();
    const a = ASSET_BY_ID[id];
    M().pay(-tokenizeCost(id), 'filing costs');
    st.tokenized[id] = true;
    st.prices[id] = clampPrice(id, price(id) * 1.18);
    M().addRep(2 + a.tq * 2);
    st.stats.tokenized++;
    M().banner('TOKENIZED', label(id) + ' — ' + cityPct() + '% of the city is connected');
    bus.emit('tokenize', { id, pct: cityPct() });
    env.quests?.milestones();
    env.quests?.check();
    return { ok: true, pct: cityPct() };
  }
  function cityPct() {
    return Math.round(Object.keys(S().tokenized).length / CONFIG.totalAssets * 100);
  }

  /* ---------- the daily roll ---------- */
  function rollPrices() {
    const st = S();
    for (const a of ASSETS) {
      const tr = st.trend[a.id] || 0;
      const vol = (a.cat === 'Stocks' ? 0.045 : a.cat === 'Bonds' ? 0.006 : 0.028) * (6 - a.q) * 0.4;
      const move = tr + (env.rng() - 0.5) * vol * 2;
      st.prices[a.id] = clampPrice(a.id, price(a.id) * (1 + move));
      st.trend[a.id] = tr * 0.72 + (env.rng() - 0.5) * 0.012;
      const h = st.hist[a.id] || (st.hist[a.id] = []);
      h.push(st.prices[a.id]);
      if (h.length > 14) h.shift();
    }
  }

  /* ------------------------------------------------------------
     TWO HEADLINES A MORNING, AND ONE OF THEM MAY HAVE BEEN TOLD TO
     YOU YESTERDAY.

     events.claimTip() returns an index into NEWS_POOL when somebody
     stopped Wally in the street last night and turned out to be
     worth listening to, or null when they did not. It is claimed
     ONCE and it clears itself, so a reload cannot bank the same
     rumour twice; settleTip() then scores the tipster against what
     actually printed, which means a chancer who happens to be right
     is scored right. See the block above makeTip() in events.js.

     The forced item goes in FIRST and the second is rolled normally,
     so a tip never costs the morning its other headline.
     ------------------------------------------------------------ */
  function rollNews() {
    const st = S();
    st.news = [];
    const forced = env.events ? env.events.claimTip() : null;
    const push = (n) => {
      if (!n || st.news.some((x) => x.h === n.h)) return;
      st.news.push({ h: n.h, t: n.t, a: n.a, e: n.e });
      st.trend[n.a] = (st.trend[n.a] || 0) + n.e * 0.5;
      st.prices[n.a] = clampPrice(n.a, price(n.a) * (1 + n.e * 0.4));
    };
    if (forced != null && NEWS_POOL[forced]) push(NEWS_POOL[forced]);
    while (st.news.length < 2) {
      const before = st.news.length;
      push(NEWS_POOL[Math.floor(env.rng() * NEWS_POOL.length)]);
      if (st.news.length === before) break;          // duplicate; do not spin
    }
    env.events?.settleTip(st.news);
    bus.emit('news', st.news);
  }

  function overnightIncome() {
    const st = S();
    let income = 0;
    for (const id in st.inv) {
      const a = ASSET_BY_ID[id];
      if (!a) continue;
      const q = st.inv[id].qty;
      if (a.cpn) income += a.cpn * q;
      if (a.div) income += a.div * q * 0.34;
      if (st.tokenized[id]) income += price(id) * 0.0035 * q;
    }
    if (st.farm.owned && st.employees.includes('tilda')) income += 40 + st.farm.lvl * 30;
    if (st.mine.owned && st.employees.includes('bruno')) income += 55 + st.mine.lvl * 40;
    if (st.employees.includes('sable')) {
      for (const pid in st.inv) {
        if (ASSET_BY_ID[pid] && ASSET_BY_ID[pid].cat === 'Property') income += price(pid) * 0.002 * st.inv[pid].qty;
      }
    }
    if (st.swap.unlocked) income += Object.keys(st.swap.pools).length * 26;
    return Math.round(income);
  }

  /* Called by game.js when the day turns over. */
  function newDay() {
    const st = S();
    st.day++;
    st.stats.daysPlayed++;
    st.time = CONFIG.dayStartMin;
    /* THE ORDINARY MORNING'S SKY. One draw, here, where it has always
       been — but it used to produce 'rain' or 'clear', two names in a
       vocabulary nothing in the codebase could read, while
       src/world/weather.js sat there with clear/cloudy/rain/storm, a
       wet-surface signal, gusting wind and lightning whose only caller
       was a debug hook. events.js names the draw now (baseWeather),
       a day condition may override it with its own weather, and
       game.js hands the result to ctx.sky.setWeather(). */
    st.weather = baseWeather(env.rng());

    rollPrices();
    rollNews();

    const income = overnightIncome();
    if (income > 0) M().pay(income, 'overnight income');

    /* salaries */
    const wages = st.employees.reduce((t, eid) => t + (EMPLOYEE_BY_ID[eid] ? EMPLOYEE_BY_ID[eid].salary : 0), 0);
    if (wages > 0) M().pay(-wages, 'salaries');

    /* weekly: rent + management fees (fee type 4) */
    if (st.day >= st.rentDay) {
      const home = HOME_BY_ID[st.home] || HOME_BY_ID.rusty;
      M().pay(-home.rent, 'weekly rent');
      st.rentDay = st.day + CONFIG.rentEveryDays;
      let fees = 0;
      for (const f of st.funds) {
        const nv = f.items.reduce((t, it) => t + price(it.a) * it.q, 0);
        f.satisfaction = clamp(f.satisfaction + (nv >= f.value ? 4 : -5), 5, 100);
        f.value = Math.round(nv);
        fees += Math.round(nv * 0.015 * (f.satisfaction / 100 + 0.4));
        if (f.satisfaction > 60) st.clients[f.client].trust += 1;
      }
      if (fees > 0) M().pay(fees, 'weekly management fees');
      if (st.employees.includes('gus')) {
        for (const cid in st.clients) if (st.clients[cid].met) st.clients[cid].trust += 1;
      }
    }

    if (st.money < 0) {
      M().note('bad', 'You are in the red. Grimm has noticed.');
      M().addRep(-3);
      st.money = 0;
    }

    /* expire orders */
    for (const o of st.orders.slice()) {
      if (st.day > o.deadline) failOrder(o);
      else if (o.deadline - st.day <= 1 && !o.warned) {
        o.warned = true;
        M().msg(CLIENT_BY_ID[o.client].n, 'Just checking in about that order. No pressure! (There is pressure.)');
      }
    }

    return income;
  }

  return {
    /* tickers — the primary handle for an asset (see the header) */
    idOf, assetOf, ticker, label, labelIco, findByTicker, search, ticket,
    tickerQty, normTicker, assetByTick: ASSET_BY_TICK,
    /* format + prices */
    fmt, price, prices: () => ({ ...S().prices }), clampPrice, liquidity, spread,
    buyPrice, sellPrice, trend, history, venueOf, venueHours, venueOpenNow,
    /* inventory */
    owned, free, add, remove, invCount, invHeld, invLocked, invCap, distinctOwned, avgCost, netWorth, afford,
    /* trade */
    buy, sell, venueOpen, sourceable,
    /* office capacity, orders + funds */
    teamSeats, teamFree, orderSlots, fundCap, acceptOrder, canComplete, completeOrder, failOrder, dissolveFund,
    failRep: orderFailRep, tradeGate, postWallyNet,
    /* tokenization */
    tokenizeCost, canTokenize, tokenize, cityPct,
    /* day */
    newDay, overnightIncome, rollPrices, rollNews,
  };
}
