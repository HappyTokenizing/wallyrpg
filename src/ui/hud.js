/* ============================================================
   hud.js — the always-on layer.

   Day / clock / energy / hunger on the left, money / reputation /
   city-tokenized on the right, the objective strip under the left
   cluster, toasts bottom-left, key hints bottom-right, banners
   centred high, and the world-space interaction prompt.

   Everything lives at the edges. Nothing sits where Wally is.

   ONE POINTER, AND ONLY ONE.
   There used to be two: the objective strip (what to do, and where)
   and a separate floating destination pointer (which way, how far).
   Pick a place on the map and the second one appeared beside the
   first, aimed somewhere else — two yellow arrows disagreeing about
   where the player was going, which is worse than either alone.
   They are now the same object. The strip carries the compass dial,
   and choosing a destination RETARGETS it rather than stacking a
   second widget next to it; a small ✕ hands it back to the quest.
   Nothing in this file may add a second one.

   The HUD polls ctx.game.hud() at 8 Hz and repaints only the
   fields that actually changed — no per-frame DOM writes. The one
   exception is the strip's arrow, which is written every frame:
   a compass that lags a turn is worse than no compass at all.
   ============================================================ */

import { BRAND } from '../core/palette.js';
import { clamp, damp } from '../core/contracts.js';
import { h, icon, money, pad2, rgba, C, meterColour } from './style.js';
/* NO KEY NAME IS WRITTEN IN THIS FILE. Every one comes from the action
   table in touch.js, which knows whether the player is holding a
   keyboard or a thumb — see the header there. */
import {
  actionLabel, actionPhrase, paintChip, onInputMode, touchUI,
  isKeyName, setReach,
} from './touch.js';

/* The bottom-right row is the reminder tier and stays at four: the buy
   sheet's shortcut lives on the TICKER pill instead, which is a better
   home for it anyway — the affordance and its shortcut in one object,
   sitting against the money it spends. tools/touchtest.mjs counts
   these four, so adding a fifth here is a test change as well as a
   design one. (The whole row is display:none on a touch build, where
   the action pad stands in for it, but the chips are mode-aware
   regardless: "it happens to be hidden" is not a reason to print a key
   name at somebody who has no keys.) */
const KEY_HINTS = [
  { act: 'phone', name: 'Phone', app: null, id: 'phone', code: 'KeyP' },
  { act: 'places', name: 'Places', app: 'places', id: 'phone', code: 'KeyM' },
  { act: 'desk', name: 'Desk', id: 'office', code: 'KeyO' },
  { act: 'menu', name: 'Menu', id: 'pause', code: 'Escape' },
];

export function createHud(ctx, ui) {
  const game = () => ctx.game;
  const root = h('div.w-hudroot');

  /* ---------------- top-left cluster ---------------- */
  const dayPill = pill('day', 'DAY', '1');
  const clockPill = pill('clock', null, '07:00', 'Morning');
  /* Energy reads straight; hunger is inverted — a full hunger bar is
     bad news, so the meter shows "how fed you are" and the ramp and
     the danger tick both point the same way as energy's. */
  const enPill = meterPill('bolt', 'Energy', 'ENERGY');
  const hgPill = meterPill('bowl', 'Hunger', 'HUNGER');

  enPill.tick(25);          // energy is dangerous low
  hgPill.tick(75);          // hunger is dangerous high

  const leftPills = h('div.w-pills', null, dayPill.el, clockPill.el, enPill.el, hgPill.el);

  /* ---------------- the objective strip = THE pointer ----------------
     Left: the compass dial, whose arrow is written every frame.
     Middle: what you are going to do, then where it is and which way.
     Right: nothing at all while it follows the objective; a ✕ while
     the player has chosen somewhere else, because a detour must be
     as easy to drop as it was to take. */
  const ptrArrow = icon('nav', 17, { fill: 'currentColor', stroke: 'currentColor', w: 1.2, class: 'arw' });
  const objDial = h('div.dial', null, ptrArrow);
  const objT = h('div.t', { text: '—' });
  const objD = h('div.d', { text: '' });
  const objWhy = h('div.why', { style: { display: 'none' } });
  const objClear = h('button.go.w-pe', {
    type: 'button', 'aria-label': 'Follow the objective again',
    title: 'Drop this destination',
    style: { display: 'none' },
    onclick: (e) => { e.stopPropagation(); ui.click(); setDestination(null); },
  }, icon('close', 13));
  const objective = h('div.w-obj.w-pe', {
    role: 'button', tabindex: '0', title: 'Where you are going',
    onclick: () => onObjective(),
  }, objDial, h('div.w-grow', null, objT, objD, objWhy), objClear);

  const left = h('div.w-bar.left', null, leftPills, objective);

  /* ---------------- top-right cluster ---------------- */
  /* money is the only permanent stat the whole game turns on, so it
     carries a little more weight than the pills either side of it */
  const moneyPill = pill('cash', null, '$250');
  moneyPill.el.classList.add('money');
  /* THE BUY AFFORDANCE, and it sits against the money readout on
     purpose: cash is the number the player checks before spending
     it, so the one control that spends it belongs in the same
     glance. Before this there was no route to a purchase that did
     not start with knowing which of nine venues sold the thing. */
  const buyKb = h('span.kb');
  const buyPill = h('button.w-pill.tap.w-pe', {
    type: 'button',
    onclick: () => { ui.click(); ui.openQuickBuy(); },
  }, icon('search', 13, { w: 2 }), h('span.w-k', { text: 'TICKER' }), buyKb);
  /* The shortcut chip is a KEYBOARD reminder riding a control that is
     already tappable, so under a thumb it is not "translated" — it is
     removed, along with the tooltip that named the key. */
  function paintBuy() {
    paintChip(buyKb, 'buy', { hideOnTouch: true });
    buyPill.title = 'Search a ticker and buy it'
      + (touchUI() ? '' : '  ·  ' + actionLabel('buy'));
  }
  /* THE REPUTATION PILL — a number, the TITLE it has earned, and a
     door. Reputation is standing, and WallyNet is where the city
     talks about you, so pressing this opens that app instead of
     doing nothing. The title rides beside the figure because a bare
     "17" says nothing about who 17 makes you, and the hairline along
     the bottom is the progress toward the next rung. */
  const repPill = titlePill();
  const cityPill = ringPill();
  const right = h('div.w-bar.right', null,
    h('div.w-pills', null, moneyPill.el, buyPill, repPill.el, cityPill.el));

  /* ---------------- THE LOCK STRIP ----------------
     One line, under the objective, for the two refusals the engine
     enforces before an action is even attempted: maximum hunger, and
     standing somewhere that is shut. It is a button, because the
     point of naming a wall is to point at the door beside it. */
  const lockT = h('div.t', { text: '' });
  const lockD = h('div.d', { text: '' });
  const lockStrip = h('button.w-lock.w-pe', {
    type: 'button', style: { display: 'none' }, title: 'What can I do about it?',
    onclick: () => { ui.click(); onLock(); },
  }, h('div.ic', null, icon('info', 15)), h('div.w-grow', null, lockT, lockD),
    h('span.go', { text: 'FIX' }));
  left.append(lockStrip);
  let lockKind = null;

  function onLock() {
    const g = game();
    if (!g) return;
    if (lockKind === 'hunger') { ui.showBlocked({ ...g.needs(), kind: 'hunger' }); return; }
    const st = g.state;
    ui.showBlocked({ kind: 'hours', loc: st.loc, why: g.closedLine(st.loc) });
  }

  function updateLock(d) {
    const g = game();
    let kind = null, t = '', sub = '';
    if (d.lockedBy === 'hunger') {
      kind = 'hunger';
      let f = null;
      try { f = g.needs().food; } catch (e) { f = null; }
      t = 'TOO HUNGRY — nothing but eating, sleeping and walking to food';
      sub = f ? (f.here ? 'There is food right here · ' + money(f.cost)
        : f.n + ' · ' + f.hops + ' hop' + (f.hops === 1 ? '' : 's') + ' · ' + money(f.cost)
          + (f.open ? '' : ' · opens ' + f.opens))
        : 'Find somewhere that sells food';
    } else if (d.open === false && d.hours) {
      kind = 'hours';
      t = d.hours.n + ' is CLOSED — nothing here can be done';
      sub = 'Opens at ' + d.hours.opens + ' · ' + d.hours.span;
    }
    if (kind === lockKind && lockT.textContent === t && lockD.textContent === sub) return;
    lockKind = kind;
    lockStrip.style.display = kind ? '' : 'none';
    lockStrip.classList.toggle('bad', kind === 'hunger');
    if (!kind) return;
    lockT.textContent = t;
    lockD.textContent = sub;
  }

  /* ---------------- THE MAYOR'S DASH, live ----------------
     Top-centre, on screen only while the race is running. The clock,
     which corner is next, and the one thing that decides the race:
     where the Mayor is on the same road. He is a marker on a track,
     not a number, so "he is pulling away" is something the player
     SEES half a lap before the result card says it. */
  const raceClock = h('div.clk', { text: '0.0' });
  const raceNext = h('div.nxt', { text: '' });
  const raceMine = h('i.me');
  const raceHis = h('i.him');
  const raceTrack = h('div.trk', null, raceHis, raceMine);
  const raceDelta = h('div.dl', { text: '' });
  const raceQuit = h('button.w-btn.sm.ghost.w-pe', {
    type: 'button', onclick: () => { ui.click(); ui.raceAbandon(); },
  }, 'Quit');
  const raceBox = h('div.w-race', { style: { display: 'none' } },
    h('div.hd', null, h('span.flag', { text: '🏁' }), raceClock, raceNext, raceQuit),
    raceTrack, raceDelta);

  /* ---------------- toasts / banner / prompt / hints ---------------- */
  const toasts = h('div.w-toasts');
  const promptLayer = h('div.w-promptlayer');
  const hints = h('div.w-hints');
  let bannerEl = null;

  const hintByKey = {};
  const hintChips = [];
  for (const hk of KEY_HINTS) {
    const kb = h('span.kb');
    const b = h('button.w-hint.w-pe', {
      type: 'button', 'aria-label': hk.name,
      onclick: () => {
        ui.click();
        if (hk.id === 'phone') ui.openPhone(hk.app);
        else if (hk.id === 'office') ui.openDesk();
        else if (hk.id === 'buy') ui.openQuickBuy();
        else ui.show('pause');
      },
    }, kb, hk.name);
    if (hk.app === 'places' || hk.id === 'phone') b.dataset.phone = '1';
    hintByKey[hk.code] = b;
    hintChips.push({ kb, b, act: hk.act, name: hk.name });
    hints.append(b);
  }
  const msgBadge = h('span.badge', { text: '0', style: { display: 'none' } });
  hints.firstChild.append(msgBadge);

  /* Hints idle at .55 and light up when their key is actually pressed,
     so the row acknowledges the player without ever competing with
     the live stats above it. */
  const litT = new Map();
  function onHintKey(e) {
    const b = hintByKey[e.code];
    if (!b || e.metaKey || e.ctrlKey || e.altKey) return;
    b.classList.add('lit');
    clearTimeout(litT.get(b));
    litT.set(b, setTimeout(() => b.classList.remove('lit'), 1100));
  }
  addEventListener('keydown', onHintKey);

  root.append(left, right, raceBox, toasts, promptLayer, hints);

  /* ============================================================
     builders
     ============================================================ */
  function pill(ic, key, value, suffix) {
    const el = h('div.w-pill');
    el.append(icon(ic, 14));
    if (key) el.append(h('span.w-k', { text: key }));
    const v = h('span.w-num', { text: value });
    el.append(v);
    let sfx = null;
    if (suffix) { sfx = h('span.w-k', { text: suffix }); el.append(sfx); }
    let deltaEl = null, deltaT = 0;
    return {
      el, node: v, sfxNode: sfx,
      set(t) { if (v.textContent !== t) v.textContent = t; },
      setSfx(t) { if (sfx && sfx.textContent !== t) sfx.textContent = t; },
      flash() { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); },
      /* the +$56 chip. Money is a permanent stat that also happens to
         be the game's core feedback loop, so it gets the one piece of
         motion in an otherwise still pill row. */
      delta(text, negative) {
        if (deltaEl) deltaEl.remove();
        deltaEl = h('span.w-delta' + (negative ? '.neg' : ''), { text });
        el.append(deltaEl);
        clearTimeout(deltaT);
        const mine = deltaEl;
        deltaT = setTimeout(() => { mine.remove(); if (deltaEl === mine) deltaEl = null; }, 2100);
      },
    };
  }

  /* ⚡ 82 ENERGY [========--]  — a numeral, a name, a 72x9 bar and a
     tick at the danger threshold. All four, because a 46x5 unlabelled
     capsule cannot tell "not implemented" from "about to starve". */
  function meterPill(ic, label, caps) {
    const fill = h('i');
    const track = h('div.w-meter', {
      role: 'meter', 'aria-label': label,
      'aria-valuemin': '0', 'aria-valuemax': '100',
    }, fill);
    const num = h('span.w-mnum', { text: '—' });
    const el = h('div.w-pill', { title: label });
    el.append(icon(ic, 14), num, h('span.w-k', { text: caps }), track);
    let last = -1;
    return {
      el,
      /** `value` is both the numeral and the bar, so the two can never
          disagree; `level` is how safe that value is, which for hunger
          runs the other way. */
      set(value, level) {
        const v = Math.round(clamp(value, 0, 100));
        if (v === last) return;
        last = v;
        const lv = clamp(level == null ? v : level, 0, 100);
        num.textContent = String(v);
        fill.style.width = v + '%';
        fill.style.background = meterColour(lv);
        track.setAttribute('aria-valuenow', String(v));
      },
      /** where the 1px danger tick sits, in meter space */
      tick(pct) { track.style.setProperty('--w-tick', pct + '%'); },
    };
  }

  /* ★ 42 · LEDGER KEEPER  — with a progress hairline to the next rung.
     Pressable: it opens WallyNet, where the whole ladder lives. */
  function titlePill() {
    const num = h('span.w-num', { text: '0' });
    const ttl = h('span.w-k.ttl', { text: 'REP' });
    const prog = h('i');
    const bar = h('div.w-repbar', null, prog);
    const el = h('button.w-pill.tap.w-pe.rep', {
      type: 'button', 'aria-label': 'Reputation — open WallyNet',
      onclick: () => { ui.click(); ui.openPhone('wallynet'); },
    }, icon('star', 14), num, ttl, bar);
    let lastN = '', lastT = '', lastP = -1;
    return {
      el,
      /** `t` is game.hud().title — data.js's repProgress(). */
      set(rep, t) {
        const n = String(Math.round(rep));
        if (n !== lastN) { lastN = n; num.textContent = n; }
        const name = t && t.title ? t.title : 'REP';
        if (name !== lastT) {
          lastT = name;
          ttl.textContent = name;
          el.title = t
            ? name + ' · rung ' + t.rung + ' of ' + t.total
              + (t.next ? ' · ' + t.toNext + ' rep to ' + t.next : ' · the top of the ladder')
              + '  —  open WallyNet'
            : 'Reputation — open WallyNet';
        }
        const pct = t ? t.pct : 0;
        if (pct !== lastP) { lastP = pct; prog.style.width = pct + '%'; }
      },
    };
  }

  function ringPill() {
    const R = 8.4, CIRC = 2 * Math.PI * R;
    const svgNS = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(svgNS, 'svg');
    s.setAttribute('viewBox', '0 0 22 22');
    s.setAttribute('width', 17); s.setAttribute('height', 17);
    s.setAttribute('class', 'w-i w-ring');
    const bg = document.createElementNS(svgNS, 'circle');
    bg.setAttribute('cx', 11); bg.setAttribute('cy', 11); bg.setAttribute('r', R);
    bg.setAttribute('stroke', rgba(BRAND.text, 0.16)); bg.setAttribute('stroke-width', 2.6);
    const fg = document.createElementNS(svgNS, 'circle');
    fg.setAttribute('cx', 11); fg.setAttribute('cy', 11); fg.setAttribute('r', R);
    fg.setAttribute('stroke', C(BRAND.token)); fg.setAttribute('stroke-width', 2.6);
    fg.setAttribute('stroke-dasharray', CIRC);
    fg.setAttribute('stroke-dashoffset', CIRC);
    fg.style.transition = 'stroke-dashoffset .6s cubic-bezier(.22,1,.36,1)';
    s.append(bg, fg);
    const v = h('span.w-num', { text: '0%' });
    const el = h('div.w-pill', { title: 'City tokenized' }, s, v, h('span.w-k', { text: 'CITY' }));
    let last = -1;
    return {
      el,
      set(pct) {
        if (pct === last) return;
        last = pct;
        v.textContent = pct + '%';
        fg.setAttribute('stroke-dashoffset', CIRC * (1 - clamp(pct, 0, 100) / 100));
      },
    };
  }

  /* ============================================================
     objective
     ============================================================ */
  let objQuest = null;

  /* THE ONE CLICK. Whatever the strip is currently aimed at is what
     it opens — the chosen destination if there is one, the quest's
     place otherwise. There is no second target and no second control
     that could disagree with this one. */
  function onObjective() {
    ui.click();
    const t = pointerTarget();
    if (t) {
      if (t.id === game().state.loc) { ui.openPlace(t.id); return; }
      ui.goto(t.id, t.why);
      return;
    }
    if (!objQuest) { ui.toast('Everything in this city belongs to someone now.', 'token'); return; }
    ui.toast(objQuest.d, 'token');
  }

  /* The quest changed. paintStrip() decides what the strip actually
     says — this only records it and plays the nudge, and it plays the
     nudge only while the strip is showing the quest: flashing a
     detour because a quest you cannot see advanced is a lie. */
  function setObjective(q) {
    const was = objQuest;
    objQuest = q;
    if (q && (!was || was.t !== q.t) && !destOverride) {
      objective.classList.remove('flash'); void objective.offsetWidth;
      objective.animate?.(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.03)' }, { transform: 'scale(1)' }],
        { duration: 520, easing: 'cubic-bezier(.22,1,.36,1)' },
      );
    }
    paintStrip();
  }

  /* ============================================================
     THE DIRECTION HALF OF THE STRIP

     Which way to go, and how far, from where Wally is standing and
     facing. It follows the current objective unless the player has
     picked somewhere else on the map, in which case THE SAME STRIP
     follows that until they arrive or clear it. There is no second
     element: `destOverride` swaps what this one is aimed at.

     THE BEARING IS TAKEN IN WALLY'S OWN FRAME, not in world north.
     A compass rose would be honest and useless: the player does not
     know which way north is, they know which way the elephant is
     facing. So the arrow is the angle between his nose and the
     door, which means "turn until the arrow points up".

       forward  f = (sin yaw, cos yaw)      the convention in data.js
       right    r = (-fz, fx)               forward x up — the same
                                            basis wally.js strafes on
       screen angle = atan2(d·r, d·f)       clockwise, 0 = straight on

     The arrow is written every frame and damped, so a turn is a
     sweep rather than a snap and a stationary player sees a still
     pointer rather than a twitching one.
     ============================================================ */
  let destOverride = null;          // a place the player chose on the map
  let destRoute = null;             // …and the route id it came from, if any
  let ptrAngle = 0;                 // damped, radians
  const ptrShown = { txt: '', sub: '', why: '', chosen: null };

  /* ------------------------------------------------------------
     THE ARROW AND THE ROUTE ARE ONE DECISION.

     `destOverride` was a module-local `let` that nothing ever seeded,
     and game.route lives on the save. So the two halves of one choice
     persisted differently, and it was measured: route to the cafe on
     foot (41 min, 12.6 e, 302 m), the arrow reads "The Bent Spoon",
     save, reload — the ROUTE comes back intact and the arrow has
     reverted to the quest. Two hundred metres of walking then charged
     8.08 energy toward a destination the HUD no longer named.
     game.js's own comment claims the opposite ("being pointed at the
     Business Broker is the kind of thing that should still be true
     tomorrow"). It survived. The pointing did not.

     So the ROUTE IS THE AUTHORITY and this mirrors it, on every read:
       · a live route seeds and holds the arrow — at boot, after a
         load, and for any route set by code that never went through
         ui.setDestination();
       · a route that ends — arrived, abandoned, cancelled, slept on —
         takes down the arrow it seeded;
       · aiming the arrow somewhere else, or dropping it with the ✕,
         clears a route pointing anywhere but there (setDestination).

     A destination picked WITHOUT a route (the phone's "Point me", the
     map, "Come back to …") is still only an arrow, and stays one —
     `destRoute` is what tells the two apart, so clearing a route never
     silently steals a heading the player set by hand.
     ------------------------------------------------------------ */
  const routeDest = (g) => (g ? (g.routeTo ?? (g.route ? g.route.to : null)) : null);

  function syncDest() {
    const g = game();
    if (!g) return;
    const to = routeDest(g);
    if (to) {
      if (destOverride !== to) {
        destOverride = to;
        ptrShown.txt = ptrShown.sub = ptrShown.why = '';
        ptrShown.chosen = null;
      }
      destRoute = to;
    } else if (destRoute) {
      if (destOverride === destRoute) destOverride = null;
      destRoute = null;
    }
  }

  function pointerTarget() {
    const g = game();
    if (!g) return null;
    syncDest();
    if (destOverride && g.data.locationById[destOverride]) {
      /* arriving retires it — otherwise it would point at his feet */
      if (destOverride === g.state.loc) { destOverride = null; destRoute = null; }
      else return { id: destOverride, why: 'your destination', chosen: true };
    }
    const q = objQuest;
    if (!q) return null;
    const locId = g.quests.questLoc(q.id);
    if (!locId || !g.known(locId)) return null;
    return { id: locId, why: q.t, chosen: false };
  }

  /* Aim the one strip somewhere the player chose. Null hands it back
     to the quest. It never creates an element — it retargets this one. */
  function setDestination(locId) {
    const g = game();
    const id = locId && g?.data?.locationById?.[locId] ? locId : null;
    /* THE ✕ DROPS BOTH HALVES, and so does re-aiming: a route still
       metering him toward somewhere the arrow no longer names is the
       exact bug this block exists to stop. The one case that must NOT
       clear is ui.js hearing 'route' and aiming the arrow at the route
       that was just set — same id, nothing to drop. */
    const to = routeDest(g);
    if (to && to !== id) g.clearRoute(id ? 'pointed somewhere else' : 'the arrow was cleared');
    destOverride = id;
    destRoute = id && to === id ? id : null;
    ptrShown.txt = ptrShown.sub = ptrShown.why = '';
    ptrShown.chosen = null;
    paintStrip();
    return destOverride;
  }

  /* The strip's static half: the headline, the ✕, and the quest line
     under it. Called whenever the target or the quest changes — never
     per frame; updatePointer() owns the distance line. */
  function paintStrip() {
    const g = game();
    const t = pointerTarget();
    const chosen = !!(t && t.chosen);
    const loc = t && g ? g.data.locationById[t.id] : null;

    /* HEADLINE. Following the objective it is the quest's own words,
       exactly as it has always been. On a detour it is the place,
       because a detour has no other name. */
    const txt = chosen ? (loc ? loc.n : 'Your destination')
      : objQuest ? objQuest.t : 'The city is whole';
    if (ptrShown.txt !== txt) { ptrShown.txt = txt; objT.textContent = txt; }

    /* THE THIRD LINE, and it only exists when there is something the
       first two do not already say: on a detour, the objective you
       stepped away from; with no bearing to give, the quest's hint.
       Following the objective to a known place it stays hidden — the
       distance line below the headline is the whole story. */
    let why = '';
    if (chosen) why = objQuest ? 'Objective · ' + objQuest.t : '';
    else if (!t) why = objQuest ? (objQuest.hint || objQuest.d || '') : 'Nothing left to own';
    if (ptrShown.why !== why) {
      ptrShown.why = why;
      objWhy.textContent = why;
      objWhy.style.display = why ? '' : 'none';
    }

    if (ptrShown.chosen !== chosen) {
      ptrShown.chosen = chosen;
      objective.classList.toggle('chosen', chosen);
      objClear.style.display = chosen ? '' : 'none';
    }
    /* No target at all: the dial has nothing to point at, so it goes
       quiet rather than lying about a bearing. */
    objective.classList.toggle('nodir', !t);
    if (!t) {
      if (ptrShown.sub !== '') { ptrShown.sub = ''; objD.textContent = ''; }
      objD.style.display = 'none';
    } else {
      objD.style.display = '';
    }
  }

  /* The point to walk to. ctx.city.doorPosition is the real doorway;
     data.js's world{} is the building centre and is the fallback.

     CACHED ON THE ID. This runs inside a per-frame update and a door
     does not move, so asking the city for it sixty times a second
     would be sixty lookups for one answer. */
  const _tp = { id: null, x: 0, y: 0, z: 0, ok: false };
  function targetPoint(locId) {
    if (_tp.id === locId) return _tp.ok ? _tp : null;
    _tp.id = locId; _tp.ok = false;
    try {
      const d = ctx.city?.doorPosition?.(locId);
      if (d && Number.isFinite(d.x + d.z)) {
        _tp.x = d.x; _tp.y = d.y; _tp.z = d.z; _tp.ok = true;
        return _tp;
      }
    } catch (e) { /* fall through */ }
    const l = game().data.locationById[locId];
    if (!l) return null;
    _tp.x = l.world.x; _tp.y = l.world.y; _tp.z = l.world.z; _tp.ok = true;
    return _tp;
  }

  const TAU = Math.PI * 2;
  const wrapPi = (a) => { a = (a + Math.PI) % TAU; return (a < 0 ? a + TAU : a) - Math.PI; };

  function updatePointer(dt) {
    const t = pointerTarget();
    if (!t) {
      if (!objective.classList.contains('nodir')) paintStrip();
      return;
    }
    const g = game();
    const tp = targetPoint(t.id);
    if (!tp) { objective.classList.add('nodir'); return; }
    if (objective.classList.contains('nodir') || ptrShown.chosen !== t.chosen) paintStrip();

    /* where he is and which way he is looking; before the character
       exists, stand him at his current location facing north */
    const w = ctx.wally;
    const px = w?.position?.x ?? (g.data.locationById[g.state.loc]?.world.x || 0);
    const pz = w?.position?.z ?? (g.data.locationById[g.state.loc]?.world.z || 0);
    const yaw = w?.rotation?.y ?? Math.PI;

    const dx = tp.x - px, dz = tp.z - pz;
    const dist = Math.hypot(dx, dz);
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = -fz, rz = fx;
    const want = dist > 0.4 ? Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz) : 0;

    ptrAngle += wrapPi(want - ptrAngle) * (1 - Math.exp(-13 * dt));
    ptrArrow.style.transform = `rotate(${(ptrAngle * 180 / Math.PI).toFixed(1)}deg)`;

    const arrived = dist < 9;
    objective.classList.toggle('here', arrived);

    /* THE WORDS COME OFF `want`, NOT off ptrAngle. ptrAngle is
       deliberately never wrapped — it accumulates shortest-arc steps
       so the arrow sweeps through 350° rather than snapping back
       through zero — which means after a couple of turns it is 700°
       and `Math.abs(ptrAngle) > 2.3` is true forever. Measured: the
       label read "behind you" at all four yaws while the arrow was
       pointing correctly at every one of them. */
    const bearing = arrived ? 'you are here'
      : Math.abs(want) < 0.42 ? 'straight ahead'
        : Math.abs(want) > 2.3 ? 'behind you'
          : want > 0 ? 'to your right' : 'to your left';
    const loc = g.data.locationById[t.id];
    const place = !t.chosen && loc ? loc.n + ' · ' : '';
    const sub = arrived ? (t.chosen ? place + 'arrived' : place + 'go inside — ' + actionPhrase('interact'))
      : place + Math.round(dist) + ' m · ' + bearing;
    if (ptrShown.sub !== sub) { ptrShown.sub = sub; objD.textContent = sub; }
  }

  /* THE PLACEMENT IS NOW THE STRIP'S OWN.
     There were two placements here — centre-top on a wide screen, a
     right-hand rail on a narrow one — and ~100 lines measuring the
     left cluster so the floating pointer never crowded it. That whole
     problem was created by the pointer being a second, free-floating
     box. It is the objective strip now: it sits under the left pills,
     in the flow, and cannot collide with anything by construction. */

  /* ============================================================
     THE RACE READOUT

     ui.js drives the race (it is the module that can see where Wally
     actually is); this only paints. `r` is null to hide it, or:
       {elapsed, cp, of, next, dist, target, mine, his, delta}
     where mine/his are 0..1 along the route and delta is seconds
     behind (positive) or ahead (negative).
     ============================================================ */
  function setRace(r) {
    if (!r) { raceBox.style.display = 'none'; return; }
    raceBox.style.display = '';
    raceClock.textContent = r.elapsed.toFixed(1) + 's';
    /* the corner NAME is the thing you steer by, so it gets the room:
       the count is two characters in front of it and the distance
       moves down to the line that has space for it */
    raceNext.textContent = (r.cp >= r.of ? 'LAST' : (r.cp + 1) + '/' + r.of) + ' → ' + r.next;
    raceMine.style.left = clamp(r.mine * 100, 0, 100) + '%';
    raceHis.style.left = clamp(r.his * 100, 0, 100) + '%';
    const behind = r.delta > 0.6;
    const level = Math.abs(r.delta) <= 0.6;
    raceDelta.textContent = (r.dist != null ? Math.round(r.dist) + ' m to the corner · ' : '')
      + (level
        ? 'level with him'
        : (behind ? '+' : '−') + Math.abs(r.delta).toFixed(1) + 's ' + (behind ? 'behind him' : 'ahead of him'))
      + ' · his target ' + Math.round(r.target) + 's';
    raceDelta.style.color = C(behind ? BRAND.bad : level ? BRAND.warn : BRAND.good);
    raceBox.classList.toggle('behind', behind);
  }

  /* ============================================================
     toasts
     ============================================================ */
  const TOAST_COLOUR = {
    good: BRAND.good, bad: BRAND.bad, money: BRAND.good,
    token: BRAND.token, info: BRAND.info, warn: BRAND.warn,
  };
  const live = [];
  function toast(text, kind = 'info', life = 3400) {
    if (!text) return;
    /* THE TOASTS MOVED HOUSE. #ui is z-index 10 and the modal stack
       is 20, so anything written here was drawn under the scrim and
       timed out unseen behind it. ui/notify.js owns the tier now,
       from a layer above the panels; this stays as the delegate so
       any caller still holding hud.toast lands in the right place. */
    if (ui.notify) return ui.notify.toast(text, kind, { life: life / 1000 });
    const col = TOAST_COLOUR[kind] || BRAND.info;
    const el = h('div.w-toast', null,
      h('span.bul', { style: { background: C(col), boxShadow: `0 0 10px ${rgba(col, 0.7)}` } }),
      h('span', { text: String(text) }));
    toasts.append(el);
    live.push(el);
    while (live.length > 4) kill(live[0]);
    const t = setTimeout(() => kill(el), life);
    el._t = t;
    return el;
  }
  function kill(el) {
    const i = live.indexOf(el);
    if (i >= 0) live.splice(i, 1);
    clearTimeout(el._t);
    el.classList.add('out');
    setTimeout(() => el.remove(), 340);
  }

  /* ============================================================
     banner
     ============================================================ */
  let bannerT = 0;
  function banner(title, sub = '') {
    if (bannerEl) { bannerEl.remove(); bannerEl = null; }
    bannerEl = h('div.w-banner', null,
      h('div.t', { text: String(title) }),
      sub ? h('div.s', { text: String(sub) }) : null);
    root.append(bannerEl);
    clearTimeout(bannerT);
    const mine = bannerEl;
    bannerT = setTimeout(() => {
      mine.classList.add('out');
      setTimeout(() => { mine.remove(); if (bannerEl === mine) bannerEl = null; }, 500);
    }, 2900);
  }

  /* ============================================================
     world-space prompts

     A prompt is anchored to a world position and projected every
     frame. The door prompt is generated automatically from the
     nearest known location; anything else can add one through
     ui.prompt() / ui.addPrompt().
     ============================================================ */
  const V = new ctx.THREE.Vector3();
  const prompts = new Map();          // id -> {el, pos, text, key, sub, action, ttl}
  let promptSeq = 0;

  /* ============================================================
     THE ANCHOR SLIDES. IT IS NOT A CONSTANT THAT WAS NUDGED.

     The door prompt is anchored over the LINTEL — out past the facade
     and, on a nine-metre building, five metres up. That is a good
     place to read it FROM TEN METRES and an impossible one to read it
     from the doorstep: walk in and the elevation from the boom to that
     point climbs through 40, 60, 73 degrees against a 25 degree half
     FOV, the point leaves the top of the frustum, and the label goes
     dark at exactly the moment it is describing the thing under your
     hand. Measured, walking in on the apartment with the boom behind
     him: painted at 6 m, dark at 4 m, and dark the rest of the way in.
     With the boom on its own auto-solved portrait azimuth — which sits
     off his FRONT quarter, so the lens is between him and the door —
     the lintel is behind the camera and the label was never painted at
     any range at all.

     Raising or lowering the constant cannot fix both ends: the height
     that survives the doorstep is too low to sit over the door from
     across the square, and no height whatsoever survives a lens that
     is standing between you and the wall.

     So the anchor is not a point any more, it is a SEGMENT: from the
     lintel (A, where it belongs when you can see it) to a point just
     above Wally's crown (B, which the follow rig frames by contract).
     Every frame we take the SMALLEST t along A->B whose projection
     puts the whole chip inside the viewport. Far away that is t = 0
     and nothing about the old framing changes — the label still hangs
     over its own door and cannot drift onto a neighbour's, because
     every point it is allowed to occupy lies on the line between the
     player and the door he is standing at. Close in, t rises and the
     label slides down the doorway toward his head. Behind him, in
     front of him, or anywhere in between, B is on screen, so some t
     always is.

     Solved in CLIP space, exactly and in constant time. Projection is
     affine in homogeneous coordinates, so clip(lerp(A,B,t)) is
     lerp(clipA, clipB, t); each edge of the box is then one linear
     inequality in t, each feasible set a ray, and the intersection of
     five rays is an interval. No sampling, no search that can step
     over the answer.
     ============================================================ */
  const CLIP_W_MIN = 0.35;      // metres in front of the lens; never nearer
  const _mvp = new ctx.THREE.Matrix4();
  const _cA = new ctx.THREE.Vector4();
  const _cB = new ctx.THREE.Vector4();
  const _fall = new ctx.THREE.Vector3();
  /* the feasible interval, accumulated by need() */
  const _lim = { lo: 0, hi: 1, ok: true };
  function need(fa, fb) {
    const d = fb - fa;
    if (Math.abs(d) < 1e-9) { if (fa < -1e-9) _lim.ok = false; return; }
    const t = -fa / d;
    if (d > 0) { if (t > _lim.lo) _lim.lo = t; }   // rising: feasible above t
    else if (t < _lim.hi) _lim.hi = t;             // falling: feasible below t
  }

  /* THE REVERT SWITCH. 'slide' ships. 'lintel' is the behaviour this
     block replaced — project the bare anchor, hide it the moment it
     leaves a box sixty pixels wider than the screen — so the walk that
     proves the fix can be run again against the defect on the same
     page load. tools/touchtest.mjs drives it; nothing ships through it. */
  let anchorMode = 'slide';

  /* Just above his crown, and stable: position + height, not the head
     bone, which bobs with the walk cycle and would shake the label. */
  function playerAnchor(out) {
    const w = ctx.wally;
    const p = w && w.position;
    if (!p || !Number.isFinite(p.x + p.y + p.z)) return null;
    return out.set(p.x, p.y + (w.height || 1.7) + 0.30, p.z);
  }

  /* The chip's own size, so "in view" means the WHOLE CHIP is on
     screen rather than its anchor point being nominally inside a box
     that is wider than the screen. Measured when the text changes and
     on resize — never per frame, which would be a forced layout every
     frame for every prompt. */
  function measurePrompt(p) {
    p.ew = p.el.offsetWidth || 150;
    p.eh = p.el.offsetHeight || 34;
  }

  /* ============================================================
     A PERSON IS NOT A DOOR, AND THE PROMPT LAYER IS WHERE THE GAME
     ALREADY KNOWS THE DIFFERENCE.

     Two things put a prompt over something you can press Enter on, and
     they are different objects: this file generates the DOOR prompt
     from the nearest known location (`DOOR`, below), and npc.js
     publishes a PERSON prompt under the id 'npc' whenever somebody is
     inside its TALK_RANGE — one id, one at a time, taken down the
     moment they walk out of it (src/character/npc.js updatePrompt).

     So the id IS the fact, and this is the only table that has to know
     it. npc.js cannot say `act: 'talk'` itself — ui.prompt() defaults
     every caller to 'interact' before this file ever sees the spec, and
     npc.js belongs to another agent — so the mapping lives here, beside
     the layer that owns both prompts. The day npc.js does name the
     action, this line becomes a no-op rather than a conflict. */
  const PERSON = 'npc';
  const PROMPT_ACT = { [PERSON]: 'talk' };

  /* THE CHIP ON THE FRONT OF A PROMPT.
     `spec.act` names an ACTION and gets whatever that action is called
     on this input — 'E' with a keyboard, 'Enter' or 'Talk' under a
     thumb, and never a keycap in the second case. `spec.key` is the
     escape hatch for chips that are NOT keyboard keys at all (the race
     prints the checkpoint number and a chequered flag, npc.say prints a
     bullet); those stay literal and keep the cap treatment, because a
     numeral in a cap is a numeral, not a promise about hardware the
     player does not have.

     AND A LITERAL KEY IS NOT ONE OF THOSE. This early return used to be
     unconditional, so any caller that typed a key name skipped the
     input-aware resolver entirely — which is how a hard 'E' went on
     floating over every person in the city on a phone through the whole
     round that removed the last of them (npc.js:632, `key: 'E'`). The
     sweep that was supposed to catch it never had a person in range.
     isKeyName() decides, in touch.js, next to the table it is checked
     against; '•', '🏁' and '3' are still literals and still capped. */
  function paintPromptKey(p) {
    if (p.lit != null && !isKeyName(p.lit)) {
      if (p.key.textContent !== p.lit) p.key.textContent = p.lit;
      return;
    }
    paintChip(p.key, p.act);
  }

  function addPrompt(spec) {
    const id = spec.id || 'p' + (promptSeq++);
    let p = prompts.get(id);
    if (!p) {
      const key = h('span.key');
      const label = h('span', { text: spec.text || '' });
      const sub = h('span.sub', { text: spec.sub || '' });
      const el = h('div.w-prompt', { style: { opacity: 0 } }, key, label, sub);
      if (spec.action) {
        el.classList.add('w-pe');
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => { ui.click(); spec.action(); });
      }
      promptLayer.append(el);
      p = { el, key, label, sub, alpha: 0, t: 0, ew: 0, eh: 0 };
      prompts.set(id, p);
    }
    p.pos = spec.pos;
    p.ttl = spec.ttl ?? Infinity;
    p.action = spec.action;
    p.lit = spec.key != null ? String(spec.key) : null;
    p.act = PROMPT_ACT[id] || spec.act || 'interact';
    const chip = () => [p.key.textContent, p.label.textContent,
      p.sub.textContent, p.sub.style.display].join('|');
    const was = chip();
    paintPromptKey(p);
    if (p.label.textContent !== (spec.text || '')) p.label.textContent = spec.text || '';
    if (p.sub.textContent !== (spec.sub || '')) p.sub.textContent = spec.sub || '';
    p.sub.style.display = spec.sub ? '' : 'none';
    /* the chip changed width, so the box its anchor has to fit inside
       changed with it — one layout here, none in the frame loop */
    if (!p.ew || was !== chip()) measurePrompt(p);
    return id;
  }
  function removePrompt(id) {
    const p = prompts.get(id);
    if (!p) return;
    p.el.style.opacity = 0;
    prompts.delete(id);
    setTimeout(() => p.el.remove(), 280);
  }

  function projectPrompts(dt) {
    if (!prompts.size) return;
    const cam = ctx.camera;
    const w = window.innerWidth, hgt = window.innerHeight;
    const B = anchorMode === 'slide' ? playerAnchor(_fall) : null;
    if (B) _mvp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    for (const [id, p] of prompts) {
      if (p.ttl !== Infinity) {
        p.ttl -= dt;
        if (p.ttl <= 0) { removePrompt(id); continue; }
      }
      if (!p.pos) continue;
      if (!p.ew) measurePrompt(p);

      let x, y, inView;
      /* the pixel box the chip's anchor must land in — the same box the
         solve below is run against, so the final clamp can never move
         the element off the position that was proved to be on screen */
      let bx0 = 40, bx1 = w - 40, by0 = 46, by1 = hgt - 20;
      if (!B) {
        /* NO PLAYER TO SLIDE TOWARD — the intro owns him, or this ran
           before wally booted. The old rule, unchanged. */
        V.set(p.pos.x, p.pos.y, p.pos.z).project(cam);
        x = (V.x * 0.5 + 0.5) * w;
        y = (-V.y * 0.5 + 0.5) * hgt;
        inView = !(V.z > 1) && x > -60 && x < w + 60 && y > -20 && y < hgt + 40;
      } else {
        /* The box the WHOLE CHIP has to sit inside, in pixels. The
           element is translate(-50%,-100%): its anchor is the tip of
           the tail at the bottom centre, so the top edge is eh above
           the anchor and the tail hangs ~5 px below it. */
        const mx = Math.min(p.ew * 0.5 + 10, w * 0.5 - 1);
        const top = Math.min(p.eh + 12, hgt * 0.5 - 1);
        const bot = Math.min(14, hgt * 0.5 - 1);
        bx0 = mx; bx1 = w - mx; by0 = top; by1 = hgt - bot;
        /* ...as NDC half-planes: nl <= ndcX <= nr, nbot <= ndcY <= ntop */
        const nl = (2 * mx) / w - 1, nr = 1 - (2 * mx) / w;
        const ntop = 1 - (2 * top) / hgt, nbot = (2 * bot) / hgt - 1;

        _cA.set(p.pos.x, p.pos.y, p.pos.z, 1).applyMatrix4(_mvp);
        _cB.set(B.x, B.y, B.z, 1).applyMatrix4(_mvp);
        _lim.lo = 0; _lim.hi = 1; _lim.ok = true;
        need(_cA.w - CLIP_W_MIN, _cB.w - CLIP_W_MIN);
        /* the sub-interval that is merely IN FRONT OF THE LENS, banked
           before the four edges narrow it — the last resort below */
        const wOk = _lim.ok && _lim.lo <= _lim.hi + 1e-6;
        const wlo = _lim.lo, whi = _lim.hi;
        need(_cA.x - nl * _cA.w, _cB.x - nl * _cB.w);
        need(nr * _cA.w - _cA.x, nr * _cB.w - _cB.x);
        need(ntop * _cA.w - _cA.y, ntop * _cB.w - _cB.y);
        need(_cA.y - nbot * _cA.w, _cB.y - nbot * _cB.w);

        let t = -1;
        if (_lim.ok && _lim.lo <= _lim.hi + 1e-6) {
          const lo = clamp(_lim.lo, 0, 1), hi = clamp(_lim.hi, lo, 1);
          /* IT RISES AT ONCE AND FALLS SLOWLY. Sliding up the segment
             is what keeps the label on screen, so it may never wait a
             frame; sliding back down is cosmetic, so it eases. Either
             way the value is clamped into the feasible interval, which
             is what makes "painted every frame" a property of the rule
             and not of how fast the player happened to walk. */
          const eased = p.t > lo ? damp(p.t, lo, 6, dt) : lo;
          t = p.t = clamp(eased, lo, hi);
        } else if (wOk) {
          /* THE LAST RESORT, AND IT IS A REAL FRAME. Steer the boom
             into the facade at the doorstep and the collision solver
             crushes it to half a metre off his face: the crown is over
             the top of the frame, the lintel is behind the lens, and
             NO point on the segment can be placed truthfully. Measured
             on the apartment and the depot with the boom held dead in
             front, at 3.4 m and again at 0.6 m. Pin the chip to his
             own point, clamped into the box below, and keep painting —
             it is anchored to the player, so there is no neighbouring
             building for it to wander onto, and a label the game
             withholds while you stand in a doorway is the whole defect
             this block exists to close. */
          t = p.t = clamp(1, wlo, whi);
        }
        inView = t >= 0;
        if (inView) {
          const u = 1 - t;
          const cw = u * _cA.w + t * _cB.w;
          x = ((u * _cA.x + t * _cB.x) / cw * 0.5 + 0.5) * w;
          y = (-(u * _cA.y + t * _cB.y) / cw * 0.5 + 0.5) * hgt;
        } else {
          p.t = 0;
          x = w * 0.5; y = hgt * 0.5;
        }
      }

      const want = inView ? 1 : 0;
      p.alpha = damp(p.alpha, want, 12, dt);
      p.el.style.opacity = p.alpha.toFixed(3);
      if (p.alpha < 0.02) { p.el.style.visibility = 'hidden'; continue; }
      p.el.style.visibility = '';
      p.el.style.left = Math.round(clamp(x, bx0, bx1)) + 'px';
      p.el.style.top = Math.round(clamp(y, by0, by1)) + 'px';
      const s = 0.92 + 0.08 * p.alpha;
      p.el.style.transform = `translate(-50%,-100%) scale(${s.toFixed(3)})`;
    }
  }

  /* ---- the automatic door prompt ---- */
  const DOOR = { id: null, loc: null };
  let nearTimer = 0;
  const doorPos = { x: 0, y: 0, z: 0 };

  function updateDoorPrompt(dt) {
    nearTimer -= dt;
    if (nearTimer > 0) return;
    nearTimer = 0.16;
    updateDoor();
    publishReach();
  }

  /* WHAT IS IN FRONT OF HIM, MEASURED ON THE SAME POLL THAT FINDS THE
     DOOR, because this is the only place both halves are visible at
     once: the door is ours, and the person is npc.js's 'npc' prompt
     sitting in the same map. Everything that has to NAME the one
     interact control — the pad's corner button, this file's prompt
     chip, the strip's sentence — reads the answer instead of guessing
     from `ui.near`, which is the DOOR and has never been anything else.
     That is why a person in range left the pad button dark and reading
     'Enter': nothing was asking about people at all. */
  function publishReach() {
    const off = !!ui.modal || !ui.visible;
    const person = !off && prompts.has(PERSON);
    const door = !off && !!DOOR.loc;
    return setReach(person ? (door ? 'both' : 'person') : door ? 'door' : 'none');
  }

  function updateDoor() {
    const g = game();
    const wally = ctx.wally;
    if (!g || !wally || ui.modal || !ui.visible) { dropDoor(); return; }

    const p = wally.position;
    let best = null, bestD = Infinity;
    for (const l of g.data.locations) {
      if (!g.known(l.id)) continue;
      const d = Math.hypot(l.world.x - p.x, l.world.z - p.z);
      const reach = Math.max(9, Math.hypot(l.size.w, l.size.d) * 0.5 + 5.5);
      if (d < reach && d < bestD) { bestD = d; best = l; }
    }
    if (!best) { dropDoor(); return; }

    /* the front of a building faces (sin yaw, cos yaw) — stand the
       prompt just outside the door and above the lintel */
    const fx = Math.sin(best.yaw), fz = Math.cos(best.yaw);
    const out = best.size.d * 0.5 + 1.2;
    doorPos.x = best.world.x + fx * out;
    doorPos.z = best.world.z + fz * out;
    const ground = ctx.world?.heightAt ? ctx.world.heightAt(doorPos.x, doorPos.z) : best.world.y;
    doorPos.y = ground + Math.min(4.4, best.size.h * 0.42) + 0.7;

    const open = g.isOpen(best.id);
    const inside = g.state.loc === best.id;
    DOOR.loc = best;
    DOOR.id = addPrompt({
      id: 'door',
      pos: doorPos,
      act: 'interact',
      text: inside ? best.n : (open ? best.n : best.n),
      sub: inside ? 'you are here' : open ? '' : `closed · ${pad2(best.hours[0])}:00–${pad2(best.hours[1])}:00`,
      action: () => enterDoor(),
    });
  }
  function dropDoor() {
    if (DOOR.id) { removePrompt(DOOR.id); DOOR.id = null; DOOR.loc = null; }
  }
  /* ============================================================
     A REFUSAL HAS TO SAY WHY, AND UNTIL NOW THIS ONE DID NOT.

     `interact()` returned a bare false and did nothing, which is
     unfalsifiable from outside: a clean, proven activation — handler
     entered, click detail 0, inside the pad — that opened no panel and
     toasted nothing is indistinguishable from a BROKEN INPUT PATH, and
     one was measured looking exactly like that, once, straight after a
     stacked phone-plus-desk pair was closed. An input suite cannot
     close that; only the refusal itself can.

     The other half of the same shape is already known and is the
     mirror image: game.enter() legitimately refuses a closed building
     or a starving elephant and RETURNS TRUE with a toast, so `true`
     never meant "something happened" either.

     So both ends now record a reason. Every path through here leaves a
     one-line string behind, read back as WALLY.debug.interact(). No
     toast is added for "nothing in range": a stray Enter on open ground
     is the commonest press in the game and nagging about it would be
     worse than the silence. The refusals a player CAN act on — a closed
     door, no money — already toast, and still do.
     ============================================================ */
  let interactWhy = 'interact() has not been called yet';
  function enterDoor() {
    const l = DOOR.loc;
    if (!l) return (interactWhy = 'no door: the prompt went away first');
    const g = game();
    /* read BEFORE the enter, or every fresh entry reports itself as
       one he was already standing in */
    const wasInside = g.state.loc === l.id;
    if (!wasInside) {
      const r = g.enter(l.id);
      if (!r.ok) {
        ui.toast(r.why, 'bad'); ui.sfx('ui.error');
        return (interactWhy = `refused by game.enter(${l.id}): ${r.why}`);
      }
      ui.sfx('door.open');
    }
    ui.openPlace(l.id);
    return (interactWhy = `opened ${l.id}${wasInside ? ' (was already inside)' : ''}`);
  }
  /* THE PERSON PROMPT, IF ONE IS UP. npc.js hands it its own action
     (api.talk(id)), so talking to somebody is this module calling the
     verb the people layer already published rather than reaching into
     it. See A PERSON IS NOT A DOOR above. */
  function personPrompt() {
    const p = prompts.get(PERSON);
    return p && typeof p.action === 'function' ? p : null;
  }

  const interact = () => {
    /* A PERSON OUTRANKS A DOOR, ON BOTH INPUTS. On a keyboard that was
       already true and was never written down here: npc.js's KeyE
       listener is registered at stage 11 and ui.js's at stage 13, so
       with somebody in range it consumes the press with
       stopImmediatePropagation and this function is never reached. The
       pad's corner button, though, comes in through ui.interact() and
       landed on the door — so the SAME press talked to Rico with a
       keyboard and walked into the shop behind him with a thumb, and
       named clients stand at doors by design (clients.js homes them
       there), which makes that the normal case and not a corner one.
       Now the label can be honest: the button says Talk because
       pressing it talks. */
    const person = personPrompt();
    if (person) {
      person.action();
      interactWhy = `talked to the person in range (${person.label.textContent || 'unnamed'})`;
      return true;
    }
    if (DOOR.loc) { enterDoor(); return true; }
    /* WHAT TOOK THE DOOR AWAY IS THE USEFUL HALF. updatePointer() drops
       the door prompt outright while ui.modal is true, so a press in
       the frame or two after a sheet closes can honestly find nothing
       here — which is the shape of the one unexplained silence on
       record. Say which it was. */
    const up = [...prompts.keys()];
    interactWhy = `nothing in range (ui.modal ${!!ui.modal}, reach ${publishReach()}, `
      + `prompts ${JSON.stringify(up)})`;
    return false;
  };

  /* ============================================================
     EVERY LABEL IN THIS FILE THAT NAMES A CONTROL, IN ONE PLACE.

     Not baked at boot: Settings › Touch controls flips the input mode
     mid-session, touch.js publishes it, and this runs again. The
     objective sub-line is repainted by CLEARING its cache rather than
     rewriting it — updatePointer() owns that string and rebuilds it on
     the next frame with the distance and bearing still correct.
     ============================================================ */
  const offInputMode = onInputMode(() => {
    paintBuy();
    for (const c of hintChips) {
      paintChip(c.kb, c.act, { hideOnTouch: true });
      /* a screen reader must not be told to press a key either */
      c.b.setAttribute('aria-label',
        touchUI() ? c.name : c.name + ' · ' + actionLabel(c.act));
    }
    for (const p of prompts.values()) paintPromptKey(p);
    ptrShown.sub = '';
  });

  /* ============================================================
     the repaint
     ============================================================ */
  let acc = 0;
  const shown = { day: -1, clock: '', money: -1, rep: -1, city: -1, quest: '' };

  function refresh(force) {
    const g = game();
    if (!g) return;
    let d;
    try { d = g.hud(); } catch (e) { return; }

    if (force || d.day !== shown.day) { shown.day = d.day; dayPill.set(String(d.day)); }
    const t = d.clock.split(' · ');
    if (force || d.clock !== shown.clock) {
      shown.clock = d.clock;
      clockPill.set(t[0]);
      clockPill.setSfx(t[1] || '');
    }
    if (force || d.money !== shown.money) {
      const diff = shown.money >= 0 ? d.money - shown.money : 0;
      shown.money = d.money;
      moneyPill.set(money(d.money));
      if (diff) {
        moneyPill.flash();
        moneyPill.delta((diff > 0 ? '+' : '−') + money(Math.abs(diff)), diff < 0);
      }
    }
    if (force || d.rep !== shown.rep) { shown.rep = d.rep; repPill.set(d.rep, d.title); }
    if (force || d.cityPct !== shown.city) { shown.city = d.cityPct; cityPill.set(d.cityPct); }

    /* one ramp for both, and for the phone battery: <20 bad, <45 warn.
       Hunger is inverted — the number is how hungry he is, the bar and
       the colour are how fed he is. */
    enPill.set(d.energy, d.energy);
    hgPill.set(d.hunger, 100 - d.hunger);

    const q = d.objective;
    const key = q ? q.id : '';
    if (force || key !== shown.quest) { shown.quest = key; setObjective(q); }

    /* the two refusals the engine enforces, said out loud */
    updateLock(d);

    const unread = g.actions.unreadCount();
    msgBadge.textContent = unread > 9 ? '9+' : String(unread);
    msgBadge.style.display = unread ? '' : 'none';
    hintByKey.KeyP?.classList.toggle('badged', unread > 0);
    /* the touch pad stands in for this row on a phone and wants the
       same count — one poll, two readouts */
    ui.touch?.setBadge?.(unread);
  }

  /* ============================================================
     public
     ============================================================ */
  return {
    root,
    toast, banner, refresh,
    addPrompt, removePrompt, interact,
    /** Why the last interact() did what it did — see A REFUSAL HAS TO
        SAY WHY. ui.js folds this into WALLY.debug.interact(). */
    get interactWhy() { return interactWhy; },
    /** The Mayor's Dash readout. ui.js owns the race; this paints it. */
    setRace,
    /* poser for screenshots — shows the money chip without having to
       actually earn anything */
    demoDelta(text) { moneyPill.flash(); moneyPill.delta(text || '+$56', /^−/.test(text || '')); },
    get nearLocation() { return DOOR.loc; },
    /** The person prompt npc.js has up, if any — the other half of
        "what is in range", which `nearLocation` has never covered. */
    get nearPerson() { const p = personPrompt(); return p ? (p.label.textContent || true) : null; },
    setObjective,
    /* THE ONE STRIP follows this until he gets there; null hands it
       back to the current objective. It retargets — it never spawns
       a second widget. */
    setDestination,
    /* Mirrors the route before answering, so nobody outside can read a
       heading that is one frame staler than the one being metered. */
    get destination() { syncDest(); return destOverride; },
    update(dt) {
      acc += dt;
      if (acc >= 0.125) { acc = 0; refresh(false); }
      updateDoorPrompt(dt);
      updatePointer(dt);
      projectPrompts(dt);
    },
    setHintsVisible(on) { hints.style.display = on ? '' : 'none'; },
    /* THE CHIP CHANGED SIZE WITH THE VIEWPORT. --w-ts scales every
       prompt with the window, and the cached width is what the anchor
       solve fits inside the frame — so a stale one is a box that is
       the wrong shape. ui.js's resize() calls this. */
    resize() { for (const p of prompts.values()) measurePrompt(p); },
    /** THE ANCHOR RULE, AS AN A/B SWITCH — see THE ANCHOR SLIDES
        above. 'slide' ships: the anchor slides along lintel -> crown
        until the whole chip is inside the frame. 'lintel' is the
        pre-fix behaviour, kept so the walk that proves the fix can be
        re-run against the defect ON THE SAME PAGE LOAD instead of
        against a memory of another build. Debug only. */
    promptAnchor(mode) {
      if (mode === 'slide' || mode === 'lintel') {
        anchorMode = mode;
        for (const p of prompts.values()) p.t = 0;
      }
      return anchorMode;
    },
    /** WHAT THE BROWSER IS ACTUALLY PAINTING, per prompt: the chip's
        own box on screen, its computed opacity and visibility, and
        `t` — how far along lintel -> crown the anchor had to slide to
        get there. The first three come from the DOM and the styles the
        page resolved, not from this file's own bookkeeping: a prompt
        layer that agrees with itself about being visible is exactly
        the measurement this fix exists because of. */
    promptState() {
      const out = [];
      for (const [id, p] of prompts) {
        const st = getComputedStyle(p.el);
        const r = p.el.getBoundingClientRect();
        const on = st.visibility !== 'hidden' && +st.opacity > 0.5 && r.width > 4
          && r.left >= 0 && r.top >= 0
          && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
        out.push({
          id, text: p.label.textContent, sub: p.sub.textContent,
          op: +(+st.opacity).toFixed(3), vis: st.visibility,
          x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
          w: Math.round(r.width), h: Math.round(r.height),
          t: +p.t.toFixed(3), painted: on,
        });
      }
      return out;
    },
    dispose() {
      offInputMode();
      /* nothing is in front of him once this layer is gone, and the
         pad's caption would otherwise keep the last word it was given */
      setReach('none');
      removeEventListener('keydown', onHintKey);
      for (const t of litT.values()) clearTimeout(t);
      root.remove();
    },
  };
}
