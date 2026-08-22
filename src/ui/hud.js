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

/* The bottom-right row is the reminder tier and stays at four: B for
   the buy sheet lives on the TICKER pill instead, which is a better
   home for it anyway — the affordance and its shortcut in one object,
   sitting against the money it spends. tools/touchtest.mjs counts
   these four, so adding a fifth here is a test change as well as a
   design one. */
const KEY_HINTS = [
  { k: 'P', name: 'Phone', app: null, id: 'phone', code: 'KeyP' },
  { k: 'M', name: 'Places', app: 'places', id: 'phone', code: 'KeyM' },
  { k: 'O', name: 'Desk', id: 'office', code: 'KeyO' },
  { k: 'Esc', name: 'Menu', id: 'pause', code: 'Escape' },
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
  const buyPill = h('button.w-pill.tap.w-pe', {
    type: 'button', title: 'Search a ticker and buy it  ·  B',
    onclick: () => { ui.click(); ui.openQuickBuy(); },
  }, icon('search', 13, { w: 2 }), h('span.w-k', { text: 'TICKER' }),
    h('span.kb', { text: 'B' }));
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
  for (const hk of KEY_HINTS) {
    const b = h('button.w-hint.w-pe', {
      type: 'button',
      onclick: () => {
        ui.click();
        if (hk.id === 'phone') ui.openPhone(hk.app);
        else if (hk.id === 'office') ui.openDesk();
        else if (hk.id === 'buy') ui.openQuickBuy();
        else ui.show('pause');
      },
    }, h('span.kb', { text: hk.k }), hk.name);
    if (hk.app === 'places' || hk.id === 'phone') b.dataset.phone = '1';
    hintByKey[hk.code] = b;
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
  let ptrAngle = 0;                 // damped, radians
  const ptrShown = { txt: '', sub: '', why: '', chosen: null };

  function pointerTarget() {
    const g = game();
    if (!g) return null;
    if (destOverride && g.data.locationById[destOverride]) {
      /* arriving retires it — otherwise it would point at his feet */
      if (destOverride === g.state.loc) destOverride = null;
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
    destOverride = locId && game()?.data?.locationById?.[locId] ? locId : null;
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
    const sub = arrived ? (t.chosen ? place + 'arrived' : place + 'go inside — press E')
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

  function addPrompt(spec) {
    const id = spec.id || 'p' + (promptSeq++);
    let p = prompts.get(id);
    if (!p) {
      const key = h('span.key', { text: spec.key || 'E' });
      const label = h('span', { text: spec.text || '' });
      const sub = h('span.sub', { text: spec.sub || '' });
      const el = h('div.w-prompt', { style: { opacity: 0 } }, key, label, sub);
      if (spec.action) {
        el.classList.add('w-pe');
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => { ui.click(); spec.action(); });
      }
      promptLayer.append(el);
      p = { el, key, label, sub, alpha: 0 };
      prompts.set(id, p);
    }
    p.pos = spec.pos;
    p.ttl = spec.ttl ?? Infinity;
    p.action = spec.action;
    if (p.key.textContent !== (spec.key || 'E')) p.key.textContent = spec.key || 'E';
    if (p.label.textContent !== (spec.text || '')) p.label.textContent = spec.text || '';
    if (p.sub.textContent !== (spec.sub || '')) p.sub.textContent = spec.sub || '';
    p.sub.style.display = spec.sub ? '' : 'none';
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
    for (const [id, p] of prompts) {
      if (p.ttl !== Infinity) {
        p.ttl -= dt;
        if (p.ttl <= 0) { removePrompt(id); continue; }
      }
      if (!p.pos) continue;
      V.set(p.pos.x, p.pos.y, p.pos.z).project(cam);
      const behind = V.z > 1;
      const x = (V.x * 0.5 + 0.5) * w;
      const y = (-V.y * 0.5 + 0.5) * hgt;
      const inView = !behind && x > -60 && x < w + 60 && y > -20 && y < hgt + 40;
      const want = inView ? 1 : 0;
      p.alpha = damp(p.alpha, want, 12, dt);
      p.el.style.opacity = p.alpha.toFixed(3);
      if (p.alpha < 0.02) { p.el.style.visibility = 'hidden'; continue; }
      p.el.style.visibility = '';
      p.el.style.left = Math.round(clamp(x, 40, w - 40)) + 'px';
      p.el.style.top = Math.round(clamp(y, 46, hgt - 20)) + 'px';
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
      key: 'E',
      text: inside ? best.n : (open ? best.n : best.n),
      sub: inside ? 'you are here' : open ? '' : `closed · ${pad2(best.hours[0])}:00–${pad2(best.hours[1])}:00`,
      action: () => enterDoor(),
    });
  }
  function dropDoor() {
    if (DOOR.id) { removePrompt(DOOR.id); DOOR.id = null; DOOR.loc = null; }
  }
  function enterDoor() {
    const l = DOOR.loc;
    if (!l) return;
    const g = game();
    if (g.state.loc !== l.id) {
      const r = g.enter(l.id);
      if (!r.ok) { ui.toast(r.why, 'bad'); ui.sfx('ui.error'); return; }
      ui.sfx('door.open');
    }
    ui.openPlace(l.id);
  }
  const interact = () => { if (DOOR.loc) { enterDoor(); return true; } return false; };

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
    /** The Mayor's Dash readout. ui.js owns the race; this paints it. */
    setRace,
    /* poser for screenshots — shows the money chip without having to
       actually earn anything */
    demoDelta(text) { moneyPill.flash(); moneyPill.delta(text || '+$56', /^−/.test(text || '')); },
    get nearLocation() { return DOOR.loc; },
    setObjective,
    /* THE ONE STRIP follows this until he gets there; null hands it
       back to the current objective. It retargets — it never spawns
       a second widget. */
    setDestination,
    get destination() { return destOverride; },
    update(dt) {
      acc += dt;
      if (acc >= 0.125) { acc = 0; refresh(false); }
      updateDoorPrompt(dt);
      updatePointer(dt);
      projectPrompts(dt);
    },
    setHintsVisible(on) { hints.style.display = on ? '' : 'none'; },
    dispose() {
      removeEventListener('keydown', onHintKey);
      for (const t of litT.values()) clearTimeout(t);
      root.remove();
    },
  };
}
