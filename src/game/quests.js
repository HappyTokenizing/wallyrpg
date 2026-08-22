/* ============================================================
   quests.js — the story spine, the objective marker, the
   tokenization milestones and progressive discovery.

   The city opens one door at a time. `see` on a location is a rule
   object; when it becomes true the place is "known" and appears on
   the map — and the world module gets an 'unlock' event so it can
   light the building up.

   Rule grammar (all optional, all AND-ed):
     0 | null           always known
     { rep: n }         reputation at least n
     { office: n }      office stage at least n
     { skill: 'id' }    course passed
     { flag: 'id' }     flag set
     { farm: true }     the farm is yours
     { mine: true }     the mine is yours
     { stadium: n }     stadium questline at step n
     { stat: 'k', n: x} stats[k] >= x
     { ride: 'id' }     that ride is owned
     { any: [r, ...] }  the one OR in the grammar: true if ANY of the
                        sub-rules is true. Everything else AND-s.

   ------------------------------------------------------------
   MAIN CHAIN vs SIDE QUESTS
   ------------------------------------------------------------
   Two lists, deliberately. QUESTS is the spine: linear, one open at
   a time, and current() — which is what hud().objective and the HUD
   objective strip read — walks QUESTS AND NOTHING ELSE. A side quest
   can therefore never overwrite the main objective, which is the
   whole reason the split exists.

   SIDE_QUESTS start dormant. Something in the world calls
   startSide(id); it goes into state.sides as 'active', check()
   evaluates it every tick alongside the main chain, and completing
   it pays out and marks it 'done'. Several can be open at once.

     current()       the main objective        -> the HUD strip
     sideCurrent()   the first open side quest -> a second, quieter slot
     sides()         every side quest with a status
     startSide(id)   arm one
     isSideActive/isSideDone(id)

   A side quest may also carry `arm`, a rule in the grammar above.
   check() starts it automatically the moment the rule is true, so a
   quest that belongs to a point in the game rather than to a
   conversation needs nobody to remember to fire it. And it may carry
   `ride`, a RIDES id, which completing it hands over — that is the
   only way the scooter is ever obtained.

   Events: 'quest' {kind:'side:start'|'side:complete', quest, title}.
   ============================================================ */

import { QUESTS, SIDE_QUESTS, SIDE_QUEST_BY_ID, LOCATIONS, MILESTONES, ZONES, CONFIG } from './data.js';

export function createQuests(env) {
  const bus = env.bus;
  const S = () => env.state;
  const M = () => env.mutate;

  /* ---------- discovery ---------- */
  function ruleMet(rule) {
    const st = S();
    if (rule === 0 || rule == null) return true;
    if (Array.isArray(rule)) return rule.every(ruleMet);
    if (rule.any != null) { if (!rule.any.some(ruleMet)) return false; }
    if (rule.ride != null && !(st.rides && st.rides.owned && st.rides.owned[rule.ride])) return false;
    if (rule.rep != null && st.rep < rule.rep) return false;
    if (rule.office != null && st.office < rule.office) return false;
    if (rule.skill != null && !st.skills[rule.skill]) return false;
    if (rule.flag != null && !st.flags[rule.flag]) return false;
    if (rule.farm && !st.farm.owned) return false;
    if (rule.mine && !st.mine.owned) return false;
    if (rule.stadium != null && st.stadium.step < rule.stadium) return false;
    if (rule.stat != null && (st.stats[rule.stat] || 0) < rule.n) return false;
    return true;
  }

  const knows = (locId) => !!S().known[locId];

  /* Recompute what the player has heard of. Returns newly found places. */
  function refreshKnown(quiet) {
    const st = S();
    const found = [];
    for (const l of LOCATIONS) {
      if (st.known[l.id]) continue;
      if (ruleMet(l.see)) { st.known[l.id] = true; found.push(l); }
    }
    if (found.length && !quiet) {
      for (const l of found) {
        M().note('token', 'New place: ' + l.n);
        M().msg('City Guide', 'You have heard about ' + l.n + ' in ' + ZONES[l.z].n + '. ' + l.desc);
        bus.emit('unlock', { key: 'location', location: l.id, zone: l.z });
      }
    } else {
      for (const l of found) bus.emit('unlock', { key: 'location', location: l.id, zone: l.z, quiet: true });
    }
    return found;
  }

  /* ---------- objectives ---------- */
  const list = () => QUESTS;
  const done = (id) => !!S().quests[id];

  function current() {
    for (const q of QUESTS) if (!S().quests[q.id]) return q;
    return null;
  }
  /* 'office' resolves to wherever your desk currently is. Accepts a
     main quest id or a side quest id. */
  function questLoc(qid) {
    const q = QUEST_OR_SIDE(qid);
    if (!q || !q.loc) return null;
    return q.loc === 'office' ? env.officeLoc() : q.loc;
  }
  const QUEST_OR_SIDE = (qid) =>
    (typeof qid === 'object' ? qid : QUESTS.find((x) => x.id === qid) || SIDE_QUEST_BY_ID[qid]) || null;
  function questAt(locId) {
    const q = current();
    return q && questLoc(q.id) === locId ? q : null;
  }
  function progress() {
    const n = QUESTS.filter((q) => S().quests[q.id]).length;
    return { done: n, total: QUESTS.length, pct: Math.round(n / QUESTS.length * 100) };
  }

  /* ---------- side quests ----------
     state.sides[id] is 'active' | 'done'. Absent means dormant: the
     player has not been given it yet, and check() ignores it. */
  const sideStatus = (id) => S().sides?.[id] || null;
  const isSideActive = (id) => sideStatus(id) === 'active';
  const isSideDone = (id) => sideStatus(id) === 'done';

  function startSide(id) {
    const q = SIDE_QUEST_BY_ID[id];
    const st = S();
    if (!q) return false;
    if (!st.sides) st.sides = {};
    if (st.sides[id]) return false;                 // already active or done
    st.sides[id] = 'active';
    M().note('token', '✦ ' + q.t);
    bus.emit('quest', { kind: 'side:start', quest: q.id, title: q.t, from: q.from || null });
    check();                                        // it may already be satisfied
    return true;
  }
  function completeSide(q) {
    if (typeof q === 'string') q = SIDE_QUEST_BY_ID[q];
    const st = S();
    if (!q || st.sides?.[q.id] === 'done') return false;
    if (!st.sides) st.sides = {};
    st.sides[q.id] = 'done';
    if (q.rep) M().addRep(q.rep);
    if (q.money) M().pay(q.money, 'favour returned');
    /* THE RIDE PAYOUT. A quest-unlocked vehicle (RIDES.scooter) has
       no price and no shop; finishing the quest is the only door.
       game.js supplies env.grantRide. */
    if (q.ride) env.grantRide?.(q.ride, { from: q.id });
    M().note('good', '✔ ' + q.t);
    bus.emit('quest', { kind: 'side:complete', quest: q.id, title: q.t, from: q.from || null });
    return true;
  }
  /* Every side quest the player has been given, newest state first. */
  const sides = () => SIDE_QUESTS.filter((q) => !!sideStatus(q.id))
    .map((q) => ({ ...q, status: sideStatus(q.id) }));
  const sideActive = () => SIDE_QUESTS.filter((q) => isSideActive(q.id));
  const sideCurrent = () => sideActive()[0] || null;
  function sideProgress() {
    const done = SIDE_QUESTS.filter((q) => isSideDone(q.id)).length;
    return { done, active: sideActive().length, total: SIDE_QUESTS.length };
  }

  /* Re-evaluate every open quest — main chain and any ACTIVE side
     quest. Cheap: two dozen predicate calls. */
  let inCheck = false;
  function check() {
    if (inCheck) return false;            // check() -> pay() -> check() guard
    inCheck = true;
    let moved = false;
    try {
      for (const q of QUESTS) {
        if (S().quests[q.id]) continue;
        let ok = false;
        try { ok = !!q.check(S()); }
        catch (e) { ok = false; }
        if (!ok) continue;
        complete(q);
        moved = true;
      }
      /* AUTO-ARM. A side quest with an `arm` rule starts itself the
         moment the rule is true — before the completion sweep below,
         so a quest that arms already satisfied still pays out. */
      for (const q of SIDE_QUESTS) {
        if (!q.arm || sideStatus(q.id)) continue;
        if (ruleMet(q.arm)) startSide(q.id);
      }
      /* Side quests are evaluated separately and NEVER set `moved`,
         so finishing an errand does not fire a main-chain 'advance'
         and does not flash the objective strip. */
      for (const q of SIDE_QUESTS) {
        if (!isSideActive(q.id)) continue;
        let ok = false;
        try { ok = !!q.check(S()); }
        catch (e) { ok = false; }
        if (ok) completeSide(q);
      }
      refreshKnown();
    } finally {
      inCheck = false;
    }
    if (moved) bus.emit('quest', { kind: 'advance', current: current() });
    return moved;
  }

  /* Mark a quest done and pay out. Exposed so scripted moments can
     force a step; normally check() drives it. */
  function complete(q) {
    if (typeof q === 'string') q = QUESTS.find((x) => x.id === q);
    if (!q || S().quests[q.id]) return false;
    S().quests[q.id] = true;
    if (q.rep) M().addRep(q.rep);
    if (q.money) M().pay(q.money, 'milestone');
    M().note('good', '✔ ' + q.t);
    bus.emit('quest', { kind: 'complete', quest: q.id, title: q.t });
    return true;
  }

  /* ---------- tokenization milestones ---------- */
  function cityPct() {
    return Math.round(Object.keys(S().tokenized).length / CONFIG.totalAssets * 100);
  }
  function milestones() {
    refreshKnown();
    const p = cityPct();
    for (const m of MILESTONES) {
      if (p < m.p || S().flags['ms' + m.p]) continue;
      S().flags['ms' + m.p] = true;
      M().banner(m.p + '% TOKENIZED', m.t);
      M().msg(m.from, m.msg);
      bus.emit('quest', { kind: 'milestone', pct: m.p, title: m.t, endgame: !!m.endgame });
      if (m.endgame) bus.emit('endgame', { day: S().day, netWorth: env.economy.netWorth() });
    }
    return p;
  }

  /* ---------- one-time tips ---------- */
  function tip(key) {
    const st = S();
    const t = env.data.tips[key];
    if (!t || st.flags['tip_' + key]) return false;
    st.flags['tip_' + key] = true;
    bus.emit('tip', { key, title: t.t, text: t.d });
    return true;
  }

  return {
    /* main chain — current() is the ONLY thing the HUD objective reads */
    list, done, current, questLoc, questAt, progress, check, complete,
    /* side quests, alongside and quieter */
    sideList: () => SIDE_QUESTS, sides, sideActive, sideCurrent, sideProgress,
    startSide, completeSide, isSideActive, isSideDone, sideStatus,
    /* discovery, milestones, tips */
    knows, refreshKnown, ruleMet, milestones, cityPct, tip,
  };
}
