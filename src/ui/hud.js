/* ============================================================
   hud.js — the always-on layer.

   Day / clock / energy / hunger on the left, money / reputation /
   city-tokenized on the right, the objective strip under the left
   cluster, toasts bottom-left, key hints bottom-right, banners
   centred high, and the world-space interaction prompt.

   Everything lives at the edges. Nothing sits where Wally is.
   The HUD polls ctx.game.hud() at 8 Hz and repaints only the
   fields that actually changed — no per-frame DOM writes.
   ============================================================ */

import { BRAND } from '../core/palette.js';
import { clamp, damp } from '../core/contracts.js';
import { h, icon, money, pad2, rgba, C, meterColour } from './style.js';

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

  /* objective strip */
  const objDot = h('div.dot');
  const objT = h('div.t', { text: '—' });
  const objD = h('div.d', { text: '' });
  const objGo = h('div.go');
  objGo.append(icon('pin', 15));
  const objective = h('div.w-obj.w-pe', {
    role: 'button', tabindex: '0',
    onclick: () => onObjective(),
  }, objDot, h('div.w-grow', null, objT, objD), objGo);

  const left = h('div.w-bar.left', null, leftPills, objective);

  /* ---------------- top-right cluster ---------------- */
  /* money is the only permanent stat the whole game turns on, so it
     carries a little more weight than the pills either side of it */
  const moneyPill = pill('cash', null, '$250');
  moneyPill.el.classList.add('money');
  const repPill = pill('star', null, '0', 'REP');
  const cityPill = ringPill();
  const right = h('div.w-bar.right', null,
    h('div.w-pills', null, moneyPill.el, repPill.el, cityPill.el));

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

  root.append(left, right, toasts, promptLayer, hints);

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
  function onObjective() {
    ui.click();
    if (!objQuest) { ui.toast('Everything in this city belongs to someone now.', 'token'); return; }
    const locId = game().quests.questLoc(objQuest.id);
    if (!locId) { ui.toast(objQuest.d, 'token'); return; }
    ui.goto(locId, objQuest.t);
  }

  function setObjective(q) {
    objQuest = q;
    if (!q) {
      objT.textContent = 'The city is whole';
      objD.textContent = 'Nothing left to own';
      objDot.style.display = 'none';
      return;
    }
    objDot.style.display = '';
    if (objT.textContent !== q.t) {
      objT.textContent = q.t;
      objective.classList.remove('flash'); void objective.offsetWidth;
      objective.animate?.(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.03)' }, { transform: 'scale(1)' }],
        { duration: 520, easing: 'cubic-bezier(.22,1,.36,1)' },
      );
    }
    const locId = game().quests.questLoc(q.id);
    const loc = locId ? game().data.locationById[locId] : null;
    const where = loc && game().known(locId) ? loc.n : (q.hint || q.d);
    objD.textContent = where;
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
    if (force || d.rep !== shown.rep) { shown.rep = d.rep; repPill.set(String(Math.round(d.rep))); }
    if (force || d.cityPct !== shown.city) { shown.city = d.cityPct; cityPill.set(d.cityPct); }

    /* one ramp for both, and for the phone battery: <20 bad, <45 warn.
       Hunger is inverted — the number is how hungry he is, the bar and
       the colour are how fed he is. */
    enPill.set(d.energy, d.energy);
    hgPill.set(d.hunger, 100 - d.hunger);

    const q = d.objective;
    const key = q ? q.id : '';
    if (force || key !== shown.quest) { shown.quest = key; setObjective(q); }
    else if (q) {
      const locId = g.quests.questLoc(q.id);
      const loc = locId ? g.data.locationById[locId] : null;
      const where = loc && g.known(locId) ? loc.n : (q.hint || q.d);
      if (objD.textContent !== where) objD.textContent = where;
    }

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
    /* poser for screenshots — shows the money chip without having to
       actually earn anything */
    demoDelta(text) { moneyPill.flash(); moneyPill.delta(text || '+$56', /^−/.test(text || '')); },
    get nearLocation() { return DOOR.loc; },
    setObjective,
    update(dt) {
      acc += dt;
      if (acc >= 0.125) { acc = 0; refresh(false); }
      updateDoorPrompt(dt);
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
