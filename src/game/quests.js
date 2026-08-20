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
   ============================================================ */

import { QUESTS, LOCATIONS, MILESTONES, ZONES, CONFIG } from './data.js';

export function createQuests(env) {
  const bus = env.bus;
  const S = () => env.state;
  const M = () => env.mutate;

  /* ---------- discovery ---------- */
  function ruleMet(rule) {
    const st = S();
    if (rule === 0 || rule == null) return true;
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
  /* 'office' resolves to wherever your desk currently is */
  function questLoc(qid) {
    const q = QUESTS.find((x) => x.id === qid);
    if (!q || !q.loc) return null;
    return q.loc === 'office' ? env.officeLoc() : q.loc;
  }
  function questAt(locId) {
    const q = current();
    return q && questLoc(q.id) === locId ? q : null;
  }
  function progress() {
    const n = QUESTS.filter((q) => S().quests[q.id]).length;
    return { done: n, total: QUESTS.length, pct: Math.round(n / QUESTS.length * 100) };
  }

  /* Re-evaluate every open quest. Cheap: 23 predicate calls. */
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
    list, done, current, questLoc, questAt, progress, check, complete,
    knows, refreshKnown, ruleMet, milestones, cityPct, tip,
  };
}
