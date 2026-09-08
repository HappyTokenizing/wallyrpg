/* ============================================================
   save.js — versioned persistence, export/import, migration and
   corrupt-save recovery.

   Storage is abstracted behind a tiny driver so the same code runs
   in the browser (localStorage) and in plain node (a Map). Nothing
   here touches `document` or `window` at import time.

   Save format: the state object verbatim, plus `version`.
     v4  the original "Wally: City of Assets" save
     v5  WALLY RPG — adds stats.spent/trips/metres, seen.apartment,
         pawnDay/pawnStock, msgs entries carry `read`
     v6  the travel overhaul and the new opening — adds
           state.bike  {owned, equipped}   the bicycle is bought, not given
           state.sides {id: 'active'|'done'}  side quests, kept apart
                                              from state.quests
         and `state.travel` may now be 'walk'. A v5 file wakes up on
         foot with no bicycle, which is exactly right: it never bought
         one. Old saves keep their money, holdings and quest progress.
     v7  RIDES. state.bike {owned,equipped} becomes
           state.rides {owned:{bike,scooter,motorcycle}, equipped}
         AN EXISTING SAVE WITH A BOUGHT BICYCLE KEEPS IT: migrateRides()
         below reads state.bike and writes rides.owned.bike (and
         equips it if it was equipped). state.bike is kept afterwards
         as a mirror, written from rides on every load, so a v6-era
         tool that poke-sets it still works. v7 also renames the taxi's
         DISPLAY name to Yoober — no save field involved, the mode id
         is still 'trunk'.
   migrate() forward-fills any field a newer version added, so a v4
   file loads straight into v7 without losing a single asset — and
   sanitize() repairs the same fields on EVERY load, version or not,
   so a save written mid-upgrade cannot arrive without a rides record
   and take game.fares() down with it.

   THREE REPAIRS RUN ON EVERY LOAD for exactly that reason, because
   each of them landed inside v7 rather than at a version boundary:
   migrateRides(), migrateRace() and migrateDiscovery() — the last of
   which seeds `state.access` from `state.known` for any file written
   before discovery and access were separate ideas.
   ============================================================ */

import { CONFIG, ASSETS, CLIENTS, CLIENT_BY_ID, LOC_BY_ID, ASSET_BY_ID, TRAVEL, RIDES, SIDE_QUEST_BY_ID, OFFICE_STAGES, DAY_EVENT_BY_ID, NEWS_POOL } from './data.js';
import { newState, clamp, round2, DEFAULT_SETTINGS } from './state.js';

/* ---------- storage driver ---------- */
function makeStore() {
  let ls = null;
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      localStorage.setItem('__wally_probe__', '1');
      localStorage.removeItem('__wally_probe__');
      ls = localStorage;
    }
  } catch (e) { ls = null; }

  if (ls) {
    return {
      kind: 'localStorage',
      get: (k) => { try { return ls.getItem(k); } catch (e) { return null; } },
      set: (k, v) => { try { ls.setItem(k, v); return true; } catch (e) { return false; } },
      del: (k) => { try { ls.removeItem(k); } catch (e) { /* ignore */ } },
    };
  }
  const mem = new Map();
  return {
    kind: 'memory',
    get: (k) => (mem.has(k) ? mem.get(k) : null),
    set: (k, v) => { mem.set(k, v); return true; },
    del: (k) => { mem.delete(k); },
  };
}

export function createSave(env) {
  const store = makeStore();
  const bus = env.bus;
  const KEY = CONFIG.saveKey;

  /* ---------- migration ---------- */
  function migrate(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (typeof data.version !== 'number') return null;
    if (data.version > CONFIG.version) return null;      // from the future: refuse

    if (data.version < CONFIG.version) {
      const fresh = newState(env.makeRng('migrate'));
      for (const k of Object.keys(fresh)) if (!(k in data)) data[k] = fresh[k];
      for (const k of ['settings', 'stats', 'farm', 'mine', 'stadium', 'swap', 'bike', 'rides']) {
        if (!data[k] || typeof data[k] !== 'object') data[k] = fresh[k];
        else for (const kk of Object.keys(fresh[k])) if (!(kk in data[k])) data[k][kk] = fresh[k][kk];
      }
      if (!data.prices) data.prices = {};
      if (!data.hist) data.hist = {};
      if (!data.trend) data.trend = {};
      for (const a of ASSETS) {
        if (data.prices[a.id] == null) {
          data.prices[a.id] = a.v;
          data.hist[a.id] = [a.v];
          data.trend[a.id] = 0;
        }
      }
      if (!data.clients) data.clients = {};
      for (const c of CLIENTS) {
        if (!data.clients[c.id]) data.clients[c.id] = { met: false, trust: 0, done: 0, failed: 0, step: 0, lastDay: 0 };
      }
      data.version = CONFIG.version;
    }
    return sanitize(data);
  }

  /* ---------- RIDES: the v6 -> v7 migration, and the repair ----------
     Run on EVERY load, not just on a version bump, so a save written
     mid-upgrade cannot arrive without a rides record.

       1  ensure state.rides exists, with a row per RIDES id
       2  ADOPT state.bike. A v6 save that bought the bicycle has
          {owned:true} there and nothing else; it must keep it. Also
          catches a v6-era tool that sets state.bike directly.
       3  at most ONE equipped, and only something owned
       4  write state.bike back as the legacy mirror
     ------------------------------------------------------------ */
  function migrateRides(m) {
    if (!m.rides || typeof m.rides !== 'object') m.rides = { owned: {}, equipped: null };
    if (!m.rides.owned || typeof m.rides.owned !== 'object') m.rides.owned = {};
    for (const id of Object.keys(RIDES)) m.rides.owned[id] = !!m.rides.owned[id];
    for (const id of Object.keys(m.rides.owned)) if (!RIDES[id]) delete m.rides.owned[id];

    if (m.bike && typeof m.bike === 'object' && m.bike.owned) {
      m.rides.owned.bike = true;
      if (!m.rides.equipped && m.bike.equipped) m.rides.equipped = 'bike';
    }
    if (!RIDES[m.rides.equipped] || !m.rides.owned[m.rides.equipped]) m.rides.equipped = null;

    m.bike = { owned: !!m.rides.owned.bike, equipped: m.rides.equipped === 'bike' };
    return m;
  }

  /* ---------- THE MAYOR'S DASH ----------
     state.race arrived after v7 shipped, so a save written by an
     earlier v7 build has no race record at all and migrate() will not
     fill it (the version has not moved). Repaired here instead, on
     every load, exactly like the rides table above: a missing record
     is a locked race, a status that is not one of the five known ones
     is a locked race, and the counters are coerced to numbers so a
     hand-edited file cannot put a NaN on the results card. */
  const RACE_STATES = ['locked', 'offered', 'running', 'lost', 'won'];
  function migrateRace(m) {
    const fresh = { status: 'locked', attempts: 0, losses: 0, wins: 0, best: 0, startedAt: 0, cp: 0, day: 0, hintDay: 0, hints: 0 };
    if (!m.race || typeof m.race !== 'object' || Array.isArray(m.race)) m.race = { ...fresh };
    for (const k of Object.keys(fresh)) {
      if (k === 'status') continue;
      m.race[k] = Number.isFinite(+m.race[k]) ? Math.max(0, Math.floor(+m.race[k])) : 0;
    }
    if (!RACE_STATES.includes(m.race.status)) m.race.status = 'locked';
    /* a save caught mid-race resumes at the start line, not mid-lap */
    if (m.race.status === 'running') { m.race.status = m.race.wins > 0 ? 'won' : 'offered'; m.race.cp = 0; }
    if (m.race.wins > 0) m.race.status = 'won';
    m.slateDay = Number.isFinite(+m.slateDay) ? Math.max(0, Math.floor(+m.slateDay)) : 0;
    return m;
  }

  /* ---------- WHAT THE CITY IS DOING, AND WHO WAS RIGHT ----------
     state.city and state.tips arrived after v7 shipped, so a save
     written by an earlier v7 build has neither and migrate()'s
     forward-fill will not run for it (the version has not moved).
     Repaired on EVERY load, exactly like the rides, the race and the
     discovery maps above.

     THE TWO THINGS THAT MATTER HERE.
       * A condition is dropped if its id is no longer in the content
         table, or if it ran out before the day the save is being
         resumed on. A shut door that outlives its reason is a
         building the player can never get into again.
       * A pending rumour is dropped if it was for a day that has
         already gone. events.claimTip() only ever claims a tip told
         BEFORE today, so a stale one would sit in the record
         forever, never claimed and never settled.
     ------------------------------------------------------------ */
  function migrateEvents(m) {
    if (!m.city || typeof m.city !== 'object' || Array.isArray(m.city)) {
      m.city = { today: null, log: [], encDay: 0, encMin: -1e9, encCount: 0, encArmed: false, live: null };
    }
    m.city.encArmed = m.city.encArmed === true;
    if (!Array.isArray(m.city.log)) m.city.log = [];
    m.city.log = m.city.log.filter((r) => r && DAY_EVENT_BY_ID[r.id] && Number.isFinite(+r.day))
      .map((r) => ({ id: r.id, day: Math.max(1, Math.floor(+r.day)) }));
    for (const k of ['encDay', 'encCount']) m.city[k] = Number.isFinite(+m.city[k]) ? Math.max(0, Math.floor(+m.city[k])) : 0;
    m.city.encMin = Number.isFinite(+m.city.encMin) ? +m.city.encMin : -1e9;
    /* A CARD IS NEVER RESUMED. It was a conversation in a room, on a
       day, with somebody standing in front of you; a save reloaded
       three days later must not reopen it. Dropping it is a DECLINE
       in every sense that matters, and declining costs nothing. */
    m.city.live = null;
    const t = m.city.today;
    if (!t || typeof t !== 'object' || !DAY_EVENT_BY_ID[t.id]
      || !Number.isFinite(+t.until) || +t.until < m.day) {
      m.city.today = null;
    } else {
      t.shut = Array.isArray(t.shut) ? t.shut.filter((id) => LOC_BY_ID[id]) : [];
      t.spared = Array.isArray(t.spared) ? t.spared.filter((id) => LOC_BY_ID[id]) : [];
      t.open = Array.isArray(t.open) ? t.open.filter((o) => o && LOC_BY_ID[o.loc]) : [];
      t.from = Number.isFinite(+t.from) ? +t.from : 0;
      t.until = Math.floor(+t.until);
    }

    if (!m.tips || typeof m.tips !== 'object' || Array.isArray(m.tips)) m.tips = { pending: null, rec: {} };
    if (!m.tips.rec || typeof m.tips.rec !== 'object') m.tips.rec = {};
    for (const k of Object.keys(m.tips.rec)) {
      if (!CLIENT_BY_ID[k]) { delete m.tips.rec[k]; continue; }
      const r = m.tips.rec[k];
      m.tips.rec[k] = {
        right: Number.isFinite(+r?.right) ? Math.max(0, Math.floor(+r.right)) : 0,
        wrong: Number.isFinite(+r?.wrong) ? Math.max(0, Math.floor(+r.wrong)) : 0,
        last: Number.isFinite(+r?.last) ? Math.max(0, Math.floor(+r.last)) : 0,
      };
    }
    const pt = m.tips.pending;
    if (!pt || !CLIENT_BY_ID[pt.who] || !Number.isFinite(+pt.day) || +pt.day >= m.day
      || !Number.isFinite(+pt.news) || !NEWS_POOL[+pt.news]) m.tips.pending = null;
    /* the in-flight claim is a transient inside events.js, never a
       save field — a key added here would break the byte-identical
       save/load round trip. Scrubbed in case an older build wrote
       one. */
    delete m.tips.claimed;
    return m;
  }

  /* ---------- DISCOVERY vs ACCESS ----------
     `state.found` and `state.access` arrived after v7 shipped, so a
     save written by an earlier v7 build has neither and migrate()'s
     forward-fill will not run for it (the version has not moved).
     Repaired here on EVERY load, exactly like rides and the race
     above — and this one MATTERS, because getting it wrong locks a
     returning player out of buildings he already earned.

     THE MIGRATION, AND WHY IT IS SAFE. Before proximity discovery,
     `known[id]` could only ever be set by the `see` rule coming true
     (quests.refreshKnown) or by raceOffer() forcing the route open.
     So on an old save "known" and "access" were the same set, and
     seeding access from known is not a guess — it is the identity
     that held when the file was written. A NEW save is left alone: it
     has its own access map and its own found map, and a place found
     by walking must stay found-but-shut.
     ------------------------------------------------------------ */
  function migrateDiscovery(m) {
    const fresh = !m.access || typeof m.access !== 'object' || Array.isArray(m.access);
    if (!m.found || typeof m.found !== 'object' || Array.isArray(m.found)) m.found = {};
    if (fresh) {
      m.access = {};
      for (const id of Object.keys(m.known)) if (LOC_BY_ID[id]) m.access[id] = true;
    }
    /* a place that no longer exists in the content tables is dropped
       from all three, so a hand-edited file cannot put a ghost pin on
       the map */
    for (const map of [m.known, m.found, m.access]) {
      for (const id of Object.keys(map)) { if (!LOC_BY_ID[id]) delete map[id]; else map[id] = !!map[id] || undefined; }
      for (const id of Object.keys(map)) if (!map[id]) delete map[id];
    }
    /* found implies known: you cannot have walked past something that
       is not on your map */
    for (const id of Object.keys(m.found)) m.known[id] = true;
    return m;
  }

  /* ---------- SETTINGS ----------
     Forward-filled and type-coerced on EVERY load, for the same
     reason as the two repairs above: `settings` grows a key whenever
     a comfort option ships, and a comfort option does not move
     CONFIG.version — so migrate()'s forward-fill never runs for it
     and a save written by yesterday's build arrives with the new key
     simply missing. A missing boolean is not `false`, it is
     `undefined`, and a switch bound to it reads as neither on nor
     off. state.js DEFAULT_SETTINGS is the one list; anything not on
     it is dropped, so a hand-edited file cannot smuggle a key in.

     `landscape` is what made this necessary: it must be a real
     `false` on every existing save, because portrait is the default
     and ui/orient.js decides what to do at boot from this flag. */
  function migrateSettings(m) {
    if (!m.settings || typeof m.settings !== 'object' || Array.isArray(m.settings)) m.settings = {};
    const s = m.settings;
    for (const k of Object.keys(s)) if (!(k in DEFAULT_SETTINGS)) delete s[k];
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      const d = DEFAULT_SETTINGS[k];
      if (typeof d === 'boolean') s[k] = k in s ? !!s[k] : d;
      else s[k] = Number.isFinite(+s[k]) ? +s[k] : d;
    }
    s.music = clamp(s.music, 0, 1);
    s.sfx = clamp(s.sfx, 0, 1);
    s.speed = clamp(s.speed, 0.5, 2);
    s.textSize = clamp(s.textSize, 0.8, 1.5);
    return m;
  }

  /* Never let a bad file produce NaN money or a negative holding. */
  function sanitize(m) {
    if (!Number.isFinite(m.money)) m.money = 0;
    m.money = Math.max(0, round2(m.money));
    m.energy = clamp(Number(m.energy) || 0, 0, 100);
    m.hunger = clamp(Number(m.hunger) || 0, 0, 100);
    m.rep = Math.max(0, Number(m.rep) || 0);
    m.day = Math.max(1, Math.floor(Number(m.day) || 1));
    m.time = Number.isFinite(m.time) ? m.time : CONFIG.dayStartMin;
    /* the top stage, from the table rather than a literal 5 */
    m.office = clamp(Math.floor(Number(m.office) || 0), 0, OFFICE_STAGES.length - 1);

    if (!m.inv || typeof m.inv !== 'object') m.inv = {};
    for (const id of Object.keys(m.inv)) {
      const e = m.inv[id];
      if (!ASSET_BY_ID[id] || !e || !Number.isFinite(e.qty) || e.qty <= 0) { delete m.inv[id]; continue; }
      e.qty = round2(e.qty);
      e.cost = Number.isFinite(e.cost) ? round2(e.cost) : 0;
      e.locked = Number.isFinite(e.locked) ? Math.max(0, Math.min(e.qty, e.locked)) : 0;
    }
    for (const id of Object.keys(m.prices || {})) {
      if (!ASSET_BY_ID[id]) { delete m.prices[id]; continue; }
      if (!Number.isFinite(m.prices[id]) || m.prices[id] <= 0) m.prices[id] = ASSET_BY_ID[id].v;
    }
    for (const id of Object.keys(m.tokenized || {})) if (!ASSET_BY_ID[id]) delete m.tokenized[id];

    if (!LOC_BY_ID[m.loc]) m.loc = 'apartment';
    migrateRides(m);
    migrateRace(m);
    migrateSettings(m);
    /* A v5 save's last mode was very often 'bike', from back when the
       bicycle was handed to you. It is not any more, so a loaded save
       that is "riding" a vehicle it does not own falls back to walking
       — which is always available. */
    if (!TRAVEL[m.travel] || (m.travel === 'bike' && !m.rides.equipped)) m.travel = 'walk';
    /* SIDE QUESTS. Only the two known statuses survive, and only for
       side quests that still exist in the content tables. */
    if (!m.sides || typeof m.sides !== 'object') m.sides = {};
    for (const k of Object.keys(m.sides)) {
      if (!SIDE_QUEST_BY_ID[k] || (m.sides[k] !== 'active' && m.sides[k] !== 'done')) delete m.sides[k];
    }
    if (!Array.isArray(m.arrivals)) m.arrivals = [];
    if (!Array.isArray(m.orders)) m.orders = [];
    if (!Array.isArray(m.funds)) m.funds = [];
    if (!Array.isArray(m.employees)) m.employees = [];
    if (!Array.isArray(m.msgs)) m.msgs = [];
    if (!Array.isArray(m.news)) m.news = [];
    if (!Array.isArray(m.wallynet)) m.wallynet = [];
    if (!m.seen) m.seen = {};
    if (!m.known) m.known = {};
    if (!m.visited) m.visited = {};
    migrateDiscovery(m);
    migrateEvents(m);
    if (!m.flags) m.flags = {};
    if (!m.skills) m.skills = {};
    if (!m.unlocks) m.unlocks = {};
    if (!m.quests) m.quests = {};
    if (!m.ipo) m.ipo = {};
    return m;
  }

  /* ---------- persistence ---------- */
  function save(state, quiet) {
    const s = state || env.state;
    let text;
    try { text = JSON.stringify(s); }
    catch (e) { bus.emit('save', { ok: false, why: 'state is not serialisable' }); return false; }
    const ok = store.set(KEY, text);
    bus.emit('save', { ok, quiet: !!quiet, bytes: text.length });
    if (!ok) env.mutate.note('bad', 'Could not save: storage is full');
    else if (!quiet) env.mutate.note('good', 'Progress saved');
    return ok;
  }

  function load() {
    let raw = store.get(KEY);
    if (!raw) {
      for (const legacy of CONFIG.legacyKeys) {          // adopt a v4 save
        raw = store.get(legacy);
        if (raw) break;
      }
    }
    if (!raw) return null;
    let data;
    try { data = JSON.parse(raw); }
    catch (e) {
      store.set(KEY + '_corrupt', raw);
      store.del(KEY);
      bus.emit('save', { ok: false, why: 'corrupt' });
      return null;
    }
    const m = migrate(data);
    if (!m) { store.del(KEY); return null; }
    return m;
  }

  const has = () => !!store.get(KEY) || CONFIG.legacyKeys.some((k) => !!store.get(k));
  function wipe() { store.del(KEY); bus.emit('save', { ok: true, wiped: true }); }

  /* ---------- export / import ----------
     exportJSON returns the TEXT. Handing it to the user (a Blob and
     an <a download>) is the UI's job — this module never touches the
     DOM. `download` is a convenience that no-ops outside a browser. */
  function exportJSON(state) {
    return JSON.stringify(state || env.state, null, 1);
  }
  function filename(state) {
    const s = state || env.state;
    return 'wally-rpg-save-day' + s.day + '.json';
  }
  function download(state) {
    const s = state || env.state;
    if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
      return { ok: false, why: 'no browser', text: exportJSON(s) };
    }
    const blob = new Blob([exportJSON(s)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename(s);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return { ok: true };
  }
  function importJSON(text) {
    let data;
    try { data = typeof text === 'string' ? JSON.parse(text) : text; }
    catch (e) { return null; }
    return migrate(data);
  }

  return { save, load, has, wipe, migrate, sanitize, migrateRides, migrateRace, migrateDiscovery, migrateEvents, exportJSON, importJSON, download, filename, driver: store.kind };
}
