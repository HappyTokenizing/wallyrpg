/* ============================================================
   state.js — the live save-state object and its primitive mutations.

   `S` is a plain, JSON-round-trippable object. Nothing on it is a
   class instance, a Map, a Set or a function, because it has to
   survive JSON.stringify -> localStorage -> JSON.parse unchanged.
   Everything that reasons about S lives in economy / clients /
   quests; this file only creates it and provides the few mutations
   that must emit an event (money, rep, unlock).

   Deliberately does not import core/contracts.js: that module reads
   `devicePixelRatio` at import time, which makes it unloadable in
   plain node, and tools/test-game.mjs must be able to import us.
   ============================================================ */

import { CONFIG, ASSETS, CLIENTS, LOC_BY_ID, OPENING_MESSAGE } from './data.js';

/* --- tiny local maths, mirrored from core/contracts.js --- */
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const round2 = (v) => Math.round(v * 100) / 100;
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* ------------------------------------------------------------
   A fresh game. `rng` must be a deterministic 0..1 source so the
   opening prices are reproducible between builds (screenshots!).
   ------------------------------------------------------------ */
export function newState(rng = mulberry32(0x5eed1e)) {
  const s = {
    version: CONFIG.version,
    day: 1,
    time: CONFIG.dayStartMin,
    weather: 'rain',
    money: CONFIG.startMoney,
    energy: 100,
    hunger: 16,
    rep: 0,

    loc: 'apartment',
    /* The last mode used. WALKING, not the bicycle — you do not own a
       bicycle yet. See TRAVEL and BIKE in data.js. */
    travel: 'walk',
    /* THE BICYCLE. owned and equipped are separate: buying it is a
       decision, riding it is a different one. game.fares() refuses the
       'bike' mode unless both are true. Persisted; forward-filled by
       save.js for any save written before v6. */
    bike: { owned: false, equipped: false },
    arrivals: [],
    seen: { apartment: true },
    known: {},
    visited: { rustyrow: true },

    inv: {}, tokenized: {}, prices: {}, hist: {}, trend: {},
    orders: [], funds: [], clients: {}, skills: {}, unlocks: {}, flags: {},

    office: 0,
    home: 'rusty',
    employees: [],
    loan: 0,
    savings: 0,

    farm:    { owned: false, lvl: 0, irrigation: false, barn: false, cold: false, unlocked: {} },
    mine:    { owned: false, lvl: 0, elevator: false, safety: false, rights: false, unlocked: {} },
    stadium: { step: 0, restored: false, fanVote: 0, group: 0 },
    ipo: {},
    swap: { unlocked: false, pools: {} },

    pawnDay: 0, pawnStock: [],
    /* Otto's welcome is on the phone before the player touches
       anything — cloned, because OPENING_MESSAGE is deep-frozen and
       `read` has to be writable. */
    msgs: [{ ...OPENING_MESSAGE, day: 1, time: CONFIG.dayStartMin, read: false }],
    news: [], wallynet: [],
    rentDay: CONFIG.rentEveryDays,
    quests: {}, questIdx: 0,
    /* SIDE QUESTS, kept apart from `quests` so the HUD objective can
       never show one. id -> 'active' | 'done'. See quests.js. */
    sides: {},

    stats: {
      jobsDone: 0, ordersDone: 0, tokenized: 0, ipos: 0, earned: 0, spent: 0,
      daysPlayed: 1, negotiations: 0, ordersFailed: 0, meals: 0, classes: 0,
      minigames: 0, trips: 0, metres: 0,
    },
    settings: {
      music: 0.16, sfx: 0.35, speed: 1, relaxed: false,
      contrast: false, reduced: false, textSize: 1, touch: false,
    },
  };

  for (const a of ASSETS) {
    s.prices[a.id] = round2(a.v * (0.94 + rng() * 0.12));
    s.hist[a.id] = [s.prices[a.id]];
    s.trend[a.id] = (rng() - 0.5) * 0.02;
  }
  for (const c of CLIENTS) {
    s.clients[c.id] = { met: false, trust: 0, done: 0, failed: 0, step: 0, lastDay: 0 };
  }
  return s;
}

/* ------------------------------------------------------------
   The mutation layer. Everything that changes a headline number
   goes through here so the HUD, the 3D world and the audio all
   hear about it on ctx.bus.
   ------------------------------------------------------------ */
export function createState(env) {
  const bus = env.bus;
  const log = [];

  const api = {
    /* --- the live object --- */
    get S() { return env.state; },

    /* Replace the whole state (load / import). */
    replace(next) {
      env.setState(next);
      bus.emit('state', next);
      bus.emit('money', { money: next.money, delta: 0, why: 'load' });
      bus.emit('rep', { rep: next.rep, delta: 0 });
      bus.emit('day', { day: next.day, weather: next.weather });
      return next;
    },

    /* --- money --- */
    pay(n, why = '') {
      const S = env.state;
      if (!Number.isFinite(n)) n = 0;
      S.money = round2(S.money + n);
      if (n > 0) S.stats.earned = round2(S.stats.earned + n);
      else if (n < 0) S.stats.spent = round2(S.stats.spent - n);
      api.note(n >= 0 ? 'money' : 'bad', (n >= 0 ? '+' : '−') + '$' + Math.abs(round2(n)) + (why ? ' · ' + why : ''));
      bus.emit('money', { money: S.money, delta: n, why });
      return S.money;
    },
    afford(n) { return env.state.money >= n; },

    /* --- reputation --- */
    addRep(n) {
      const S = env.state;
      if (!Number.isFinite(n) || n === 0) return S.rep;
      S.rep = Math.max(0, Math.round((S.rep + n) * 10) / 10);
      bus.emit('rep', { rep: S.rep, delta: n });
      return S.rep;
    },

    /* --- vitals --- */
    addEnergy(n) {
      const S = env.state;
      S.energy = clamp(S.energy + n, 0, 100);
      return S.energy;
    },
    addHunger(n) {
      const S = env.state;
      S.hunger = clamp(S.hunger + n, 0, 100);
      return S.hunger;
    },

    /* --- unlocks / flags --- */
    unlock(key, value = true) {
      const S = env.state;
      if (S.unlocks[key] === value) return false;
      S.unlocks[key] = value;
      api.note('token', 'Unlocked: ' + key);
      bus.emit('unlock', { key, value });
      return true;
    },
    flag(key, value = true) {
      const S = env.state;
      const was = S.flags[key];
      S.flags[key] = value;
      return was !== value;
    },

    /* --- place --- */
    setLoc(id) {
      const S = env.state;
      if (!LOC_BY_ID[id]) return false;
      const first = !S.seen[id];
      S.loc = id;
      S.seen[id] = true;
      S.visited[LOC_BY_ID[id].z] = true;
      bus.emit('place', { loc: id, zone: LOC_BY_ID[id].z, first });
      return first;
    },

    /* --- the message/toast ring buffer the UI drains --- */
    note(kind, text) {
      log.push({ kind, text, day: env.state ? env.state.day : 0, at: log.length });
      if (log.length > 200) log.shift();
      bus.emit('note', { kind, text });
    },
    msg(from, text) {
      const S = env.state;
      S.msgs.unshift({ from, text, day: S.day, time: S.time, read: false });
      if (S.msgs.length > 60) S.msgs.pop();
      bus.emit('msg', { from, text });
    },
    banner(title, sub) { bus.emit('banner', { title, sub }); api.note('token', title + ' · ' + sub); },
    log,
  };

  return api;
}
