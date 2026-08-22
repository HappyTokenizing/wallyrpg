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

import { QUESTS, SIDE_QUESTS, SIDE_QUEST_BY_ID, LOCATIONS, MILESTONES, ZONES, CONFIG, HAPPY_ENDING } from './data.js';

/* ============================================================
   THE TWO ENDINGS, AND THE LATCHES THAT KEEP THEM ONE-SHOT
   ------------------------------------------------------------
   Two separate things happen at the end of this game, at two
   different moments, so they are two different events:

     'city:tokenized'  all 69 assets are tokenized. The city throws a
                       minute of fireworks. This can land while quests
                       are still open — q_city is the 23rd of 24 — so
                       it fires on its own account.
     'game:complete'   EVERYTHING is finished (see completion()).
                       Happy turns up and delivers the last line in
                       the game, data.js HAPPY_ENDING.

   Each is latched by A FLAG IN THE SAVE, not by a variable in this
   closure, so a reload cannot replay either one. syncLatches() closes
   the other hole: a save written before these events existed, or one
   already sitting past the line, arms both latches silently on load,
   so a returning player is not met at the door by a minute of
   fireworks he already watched.

   The legacy 'endgame' event still fires alongside 'city:tokenized'
   for anything that was already listening to it.
   ============================================================ */
const CITY_LATCH = 'cityTokenized100';
const DONE_LATCH = 'gameComplete';

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
    /* AFTER the guard is released, so a listener that reacts to the
       ending by calling back into check() is not silently dropped. */
    checkEndings();
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
    }
    checkEndings();
    return p;
  }

  /* ============================================================
     THE ENDINGS
     ============================================================ */

  /* ---------- 1. ONE HUNDRED PERCENT TOKENIZED ----------
     Every one of CONFIG.totalAssets assets carries a token. This is a
     COUNT OF THE CITY, not a count of quests: it is true the instant
     the 69th filing clears, whether or not anything else is finished.
     tokenized[] is only ever added to, so once true it stays true. */
  function tokenizedCount() {
    let n = 0;
    for (const k in S().tokenized) if (S().tokenized[k]) n++;
    return n;
  }
  function cityTokenized() { return tokenizedCount() >= CONFIG.totalAssets; }

  function cityPayload(forced) {
    const st = S();
    return {
      pct: 100,
      tokenized: tokenizedCount(),
      total: CONFIG.totalAssets,
      day: st.day, time: st.time,
      netWorth: env.economy.netWorth(),
      /* HOW LONG THE SHOW RUNS, in milliseconds. CONFIG.fireworksMs. */
      durationMs: CONFIG.fireworksMs,
      forced: !!forced,
    };
  }

  /* ---------- 2. FULL COMPLETION ----------
     "Fully completed" is defined against the real tables and nothing
     else. All four clauses must hold at the same time:

       main    every one of the QUESTS main chain is done. That chain
               already contains the hard ones — q_all (own all 69
               assets), q_city (100% tokenized), q_team (the Stampede
               tokenized), q_pent (the penthouse, which itself needs
               rep 90 and stadium step 10), q_ipo, q_swap.
       side    every one of the SIDE_QUESTS is done — not merely
               armed, and not merely the ones the player happened to
               be given. All of them.
       city    tokenized >= CONFIG.totalAssets, asserted directly
               rather than trusted to q_city, so a future edit to the
               quest table cannot quietly weaken the ending.
       assets  q_all is latched, i.e. he HAS at one point held all 69.
               Deliberately not re-checked live: selling a bushel of
               wheat after the fact must not un-finish the game.

     completion() returns the whole report so the UI can show a
     checklist of what is still outstanding, not just a boolean. */
  function completion() {
    const st = S();
    const mainDone = QUESTS.filter((q) => st.quests[q.id]).length;
    const sideDone = SIDE_QUESTS.filter((q) => isSideDone(q.id)).length;
    const tok = tokenizedCount();
    const main = mainDone >= QUESTS.length;
    const side = sideDone >= SIDE_QUESTS.length;
    const city = tok >= CONFIG.totalAssets;
    const assets = !!st.quests.q_all;
    const missing = [];
    if (!main) for (const q of QUESTS) if (!st.quests[q.id]) missing.push({ kind: 'main', id: q.id, t: q.t });
    if (!side) for (const q of SIDE_QUESTS) if (!isSideDone(q.id)) missing.push({ kind: 'side', id: q.id, t: q.t });
    if (!city) missing.push({ kind: 'city', id: 'tokenize', t: `Tokenize ${CONFIG.totalAssets - tok} more assets` });
    return {
      complete: main && side && city && assets,
      main: { done: mainDone, total: QUESTS.length, ok: main },
      side: { done: sideDone, total: SIDE_QUESTS.length, ok: side },
      tokenized: { done: tok, total: CONFIG.totalAssets, ok: city },
      assets: { ok: assets },
      missing,
      pct: Math.round(((mainDone + sideDone + tok) / (QUESTS.length + SIDE_QUESTS.length + CONFIG.totalAssets)) * 100),
    };
  }

  function completePayload(forced) {
    const st = S();
    const c = completion();
    return {
      day: st.day, time: st.time,
      netWorth: env.economy.netWorth(),
      rep: st.rep,
      main: c.main, side: c.side, tokenized: c.tokenized,
      /* HAPPY'S SPEECH TRAVELS WITH THE EVENT so the UI never retypes
         it. `text` is the whole line, verbatim; `links` are the two
         labels inside it that must be anchors, not prose. */
      speaker: HAPPY_ENDING.speaker,
      role: HAPPY_ENDING.role,
      text: HAPPY_ENDING.text,
      links: HAPPY_ENDING.links.map((l) => ({ ...l })),
      forced: !!forced,
    };
  }

  /* ---------- the one-shot gate ----------
     Called from check() and milestones(), so anything that can move
     the needle reaches it. The flag is written BEFORE the emit, so a
     handler that calls back into the game cannot re-enter and fire a
     second time. */
  function checkEndings() {
    const st = S();
    let fired = null;
    if (!st.flags[CITY_LATCH] && cityTokenized()) {
      st.flags[CITY_LATCH] = true;
      const p = cityPayload(false);
      bus.emit('city:tokenized', p);
      bus.emit('endgame', { day: st.day, netWorth: p.netWorth });   // legacy alias
      fired = 'city';
    }
    if (!st.flags[DONE_LATCH] && completion().complete) {
      st.flags[DONE_LATCH] = true;
      bus.emit('game:complete', completePayload(false));
      fired = fired ? 'both' : 'complete';
    }
    return fired;
  }

  /* Arm both latches for a state that is ALREADY past the line,
     without emitting anything. game.js calls this on every load and
     import, so a finished save reloads quietly. */
  function syncLatches() {
    const st = S();
    if (!st.flags) st.flags = {};
    let armed = 0;
    if (!st.flags[CITY_LATCH] && cityTokenized()) { st.flags[CITY_LATCH] = true; armed++; }
    if (!st.flags[DONE_LATCH] && completion().complete) { st.flags[DONE_LATCH] = true; armed++; }
    return armed;
  }

  /* ---------- debug doors ----------
     Fire either ending on demand, latch and all, so a whole
     playthrough is not the only way to see one. `force` re-fires an
     ending that has already happened; the payload says forced:true so
     a listener can tell a rehearsal from the real thing. */
  function fireCityTokenized(force) {
    const st = S();
    if (st.flags[CITY_LATCH] && !force) return false;
    st.flags[CITY_LATCH] = true;
    const p = cityPayload(!!force);
    bus.emit('city:tokenized', p);
    bus.emit('endgame', { day: st.day, netWorth: p.netWorth, forced: !!force });
    return p;
  }
  function fireGameComplete(force) {
    const st = S();
    if (st.flags[DONE_LATCH] && !force) return false;
    st.flags[DONE_LATCH] = true;
    const p = completePayload(!!force);
    bus.emit('game:complete', p);
    return p;
  }
  const hasFiredCity = () => !!S().flags[CITY_LATCH];
  const hasFiredComplete = () => !!S().flags[DONE_LATCH];

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
    /* THE TWO ENDINGS — 'city:tokenized' and 'game:complete' */
    tokenizedCount, cityTokenized, completion, checkEndings, syncLatches,
    fireCityTokenized, fireGameComplete, hasFiredCity, hasFiredComplete,
    happyEnding: HAPPY_ENDING,
  };
}
