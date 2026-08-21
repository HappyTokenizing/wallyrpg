/* ============================================================
   ui.js — ctx.ui. The whole interface.

   Layers (both already in index.html, both pointer-events:none —
   only the interactive children opt back in with .w-pe):

     #ui        the always-on HUD: pills, objective strip, toasts,
                banners, world-space prompts, key hints
     #overlay   the modal stack: scrim, phone, sheets, pause,
                and the dialogue card above all of it

   ------------------------------------------------------------
   PUBLIC API — ctx.ui
   ------------------------------------------------------------
   show(name, arg)            'hud'|'phone'|'places'|'desk'|'place'|
                              'travel'|'pause'|'settings'|'dialogue'
   hide(name)                 name omitted closes the top panel
   toast(text, kind)          kind: good|bad|money|token|info|warn
   banner(text, sub)          the big centred title card
   dialogue(spec) -> Promise  see ui/dialogue.js
   prompt(text, worldPos, o)  a soft world-anchored prompt
   setVisible(bool)           fade the entire interface out (cinematics)

   Also, for anyone who needs it:
   openPhone(app) openDesk() openPlace(loc) goto(loc) showOrder(o)
   addPrompt(spec) removePrompt(id) refresh() closeAll() placeWally(loc)
   modal (bool)  visible (bool)  near (the location Wally is standing at)

   DEBUG: WALLY.debug.ui(name), WALLY.debug.uiAll()
   ============================================================ */

import { clamp } from '../core/contracts.js';
import { injectStyle, h } from './style.js';
import { createHud } from './hud.js';
import { createDialogue } from './dialogue.js';
import { createPhone } from './phone.js';
import { createMenus } from './menus.js';
import { createTouch, shouldEnable } from './touch.js';

/* which musical context each district wants */
const ZONE_AUDIO = {
  rustyrow: 'town', mainstreet: 'town', learning: 'town', marketsq: 'market',
  greenedge: 'farm', ironhills: 'mine', waterfront: 'explore',
  innovation: 'town', stampede: 'town', goldenheights: 'heights',
};

export async function init(ctx) {
  injectStyle();

  const uiRoot = document.getElementById('ui');
  const ovRoot = document.getElementById('overlay');
  if (!uiRoot || !ovRoot) {
    console.warn('[ui] #ui / #overlay missing — interface disabled');
    return { update() {} };
  }
  uiRoot.classList.add('w-root');
  ovRoot.classList.add('w-root');

  /* ------------------------------------------------------------
     the film layer — ART_DIRECTION §3.8 / §6

     The post chain grains, grades and vignettes the WebGL canvas,
     but the DOM sits above it, so without these two the interface
     is the one perfectly clean, perfectly flat object in an
     otherwise heavily grained frame — the single loudest tell that
     a HUD is a web page rather than part of the game.

     They hang off <body>, not off #ui, so they survive the HUD
     fading out during cinematics: the grade should not blink when
     the pills do.
     ------------------------------------------------------------ */
  const film = h('div.w-film');
  const vignette = h('div.w-vig');
  document.body.append(film, vignette);

  /* a late-bound handle so the submodules can call back into ctx.ui
     while it is still being assembled */
  const api = {};
  const uiRef = api;

  /* ------------------------------------------------------------
     overlay scaffolding
     ------------------------------------------------------------ */
  const scrim = h('div.w-scrim', {
    onclick: () => { if (stack.length) { sfx('ui.back'); popSheet(); } },
  });
  const panels = h('div.w-panels');
  ovRoot.append(scrim, panels);

  const hud = createHud(ctx, uiRef);
  const dlg = createDialogue(ctx, uiRef);
  const phone = createPhone(ctx, uiRef);
  const menus = createMenus(ctx, uiRef);
  const touch = createTouch(ctx, uiRef);

  uiRoot.append(hud.root);
  uiRoot.append(touch.root);        // above the HUD, below the modal stack
  ovRoot.append(dlg.root);          // the dialogue always draws above the panels

  /* ------------------------------------------------------------
     the modal stack
     ------------------------------------------------------------ */
  const stack = [];                 // [{name, el}]
  let inputGrabbed = false;

  /* The input source to hand back when the last panel closes.
     `null` means "the built-in WASD"; the touch layer parks its
     thumbstick function here. Restoring null unconditionally — which
     is what this used to do — silently uninstalled the touch controls
     the first time anyone opened and closed the phone. */
  let baseInput = null;
  function applyInput(fn) { try { ctx.wally?.setInput(fn); } catch (e) {} }
  function setBaseInput(fn) {
    baseInput = fn || null;
    if (!inputGrabbed) applyInput(baseInput);
  }

  function syncModal() {
    const on = stack.length > 0;
    scrim.classList.toggle('on', on);
    scrim.style.pointerEvents = on ? 'auto' : 'none';
    panels.style.pointerEvents = 'none';
    if (on && !inputGrabbed) {
      inputGrabbed = true;
      applyInput(() => ({ x: 0, z: 0, jump: false, jumpHeld: false, run: false }));
    } else if (!on && inputGrabbed) {
      inputGrabbed = false;
      applyInput(baseInput);
    }
  }

  function pushSheet(el, name = 'sheet') {
    if (!el) return null;
    if (name === 'phone' || name === 'pause') {
      const same = stack.find((s) => s.name === name);
      if (same) return same.el;
    }
    stack.push({ name, el });
    panels.append(el);
    syncModal();
    return el;
  }
  function popSheet() {
    const top = stack.pop();
    if (!top) return false;
    top.el.classList.add('out');
    const el = top.el;
    setTimeout(() => { el.classList.remove('out'); el.remove(); }, 300);
    syncModal();
    return true;
  }
  function closeAll() {
    while (stack.length) stack.pop().el.remove();
    syncModal();
  }
  const topName = () => (stack.length ? stack[stack.length - 1].name : null);

  /* ------------------------------------------------------------
     sound
     ------------------------------------------------------------ */
  function sfx(name, gain) {
    try { ctx.audio?.sfx?.(name, gain != null ? { gain } : undefined); } catch (e) {}
  }
  function click() { sfx('ui.click'); try { ctx.audio?.resume?.(); } catch (e) {} }

  /* ------------------------------------------------------------
     navigation
     ------------------------------------------------------------ */

  /* Stand Wally just outside a location's front door. Fast travel has
     to move him too, or the state and the world disagree about where
     he is. Uses only public APIs (wally.setPosition, world.heightAt). */
  function placeWally(locId) {
    const loc = ctx.game?.data?.locationById?.[locId];
    if (!loc || !ctx.wally) return false;
    const fx = Math.sin(loc.yaw), fz = Math.cos(loc.yaw);
    const out = loc.size.d * 0.5 + 3.4;
    const x = loc.world.x + fx * out;
    const z = loc.world.z + fz * out;
    const y = ctx.world?.heightAt ? ctx.world.heightAt(x, z) : loc.world.y;
    try {
      ctx.wally.setPosition(x, y + 0.06, z);
      ctx.wally.setYaw(Math.atan2(loc.world.x - x, loc.world.z - z));
    } catch (e) { return false; }
    return true;
  }

  function goto(locId, why) {
    const game = ctx.game;
    if (!game || !locId) return;
    if (!game.known(locId)) { toast('You have not heard of that place yet', 'bad'); return; }
    if (game.state.loc === locId) { openPlace(locId); return; }
    game.quests.tip('map');
    pushSheet(menus.travel(locId, why));
  }
  function openPlace(locId) {
    const id = locId || ctx.game?.state?.loc;
    if (!id) return;
    pushSheet(menus.place(id), 'place');
  }
  function openDesk() {
    const game = ctx.game;
    if (!game) return;
    const deskLoc = game.officeLoc();
    if (game.state.loc !== deskLoc) { goto(deskLoc, 'Your desk is here'); return; }
    pushSheet(menus.desk(), 'desk');
    game.quests.tip('office');
  }
  function openPhone(app) {
    try { ctx.audio?.resume?.(); } catch (e) {}
    if (topName() === 'phone') { phone.open(app); return; }
    pushSheet(phone.root, 'phone');
    phone.open(app);
    sfx('ui.open');
  }

  /* The one "confirm" verb — E on a keyboard, the round button on a
     phone. Advance the conversation if someone is talking, otherwise
     use whatever door Wally is standing at. */
  function interact() {
    if (dlg.isOpen) { dlg.advance(); return true; }
    if (stack.length) return false;
    return hud.interact();
  }

  function refresh() {
    hud.refresh(true);
    if (stack.some((s) => s.name === 'phone')) phone.refresh();
  }
  function rebuildTop() {
    const t = stack[stack.length - 1];
    if (t && t.el._rebuild) t.el._rebuild();
  }

  /* ------------------------------------------------------------
     accessibility
     ------------------------------------------------------------ */
  const setTextSize = (v) =>
    document.documentElement.style.setProperty('--w-ts', String(clamp(+v || 1, 0.8, 1.5)));
  const setReducedMotion = (on) => {
    uiRoot.classList.toggle('w-rm', !!on); ovRoot.classList.toggle('w-rm', !!on);
  };
  const setHighContrast = (on) => {
    uiRoot.classList.toggle('w-hc', !!on); ovRoot.classList.toggle('w-hc', !!on);
    /* high contrast wants flat, maximum-separation surfaces — grain
       and vignette both work against that */
    film.style.display = on ? 'none' : '';
    vignette.style.display = on ? 'none' : '';
  };

  const toast = (text, kind = 'info') => { hud.toast(text, kind); return api; };
  const banner = (title, sub) => { hud.banner(title, sub); sfx('chime'); return api; };

  /* ------------------------------------------------------------
     the public object
     ------------------------------------------------------------ */
  let visible = true;

  Object.assign(api, {
    /* --- the documented surface --- */
    show(name, arg) {
      switch (name) {
        case 'hud': api.setVisible(true); break;
        case 'phone': openPhone(arg); break;
        case 'places': case 'map': openPhone('places'); break;
        case 'messages': openPhone('messages'); break;
        case 'desk': case 'office': openDesk(); break;
        case 'place': openPlace(arg); break;
        case 'travel': goto(arg || ctx.game?.state?.loc); break;
        case 'pause': pushSheet(menus.pause(), 'pause'); break;
        case 'settings': pushSheet(menus.settings()); break;
        case 'dialogue': return api.dialogue(arg || sampleDialogue());
        default:
          if (typeof menus[name] === 'function') pushSheet(menus[name](arg));
          else console.warn('[ui] no panel "' + name + '"');
      }
      return api;
    },
    hide(name) {
      if (!name) { popSheet(); return api; }
      if (name === 'dialogue') { dlg.close(null); return api; }
      const i = stack.findIndex((s) => s.name === name);
      if (i < 0) return api;
      const [t] = stack.splice(i, 1);
      t.el.classList.add('out');
      setTimeout(() => { t.el.classList.remove('out'); t.el.remove(); }, 300);
      syncModal();
      return api;
    },
    toast, banner,
    dialogue(spec) { return dlg.open(spec || sampleDialogue()); },
    prompt(text, worldPos, opts = {}) {
      if (!text) { hud.removePrompt(opts.id || 'ui'); return null; }
      return hud.addPrompt({
        id: opts.id || 'ui', text, pos: worldPos,
        key: opts.key || 'E', sub: opts.sub, action: opts.action,
        ttl: opts.ttl ?? Infinity,
      });
    },
    setVisible(on) {
      visible = on !== false;
      uiRoot.classList.toggle('w-off', !visible);
      ovRoot.classList.toggle('w-off', !visible);
      if (!visible) closeAll();
      return api;
    },

    /* --- navigation --- */
    openPhone, openDesk, openPlace, goto, placeWally, interact,
    showOrder: (o) => menus.showOrder(o),
    talkTo: (c) => menus.talkTo(c),
    addPrompt: hud.addPrompt, removePrompt: hud.removePrompt,
    pushSheet, popSheet, closeAll, refresh, rebuildTop,
    renderSettings: (el) => menus.renderSettings(el),

    /* --- accessibility --- */
    setTextSize, setReducedMotion, setHighContrast,

    /* --- touch --- */
    touch,
    /** Show/hide the thumbstick + action pad. Persists in settings. */
    setTouch(on) {
      touch.setEnabled(on);
      const s = ctx.game?.state?.settings;
      if (s) s.touch = !!on;
      return api;
    },
    /** Park an input source to restore whenever the modal stack empties. */
    setBaseInput,

    /* --- small --- */
    sfx, click,
    /* the HUD steps back while someone is talking */
    _onDialogueOpen() { uiRoot.classList.add('w-dlg-open'); ovRoot.classList.add('w-dlg-open'); },
    _onDialogueClose() { uiRoot.classList.remove('w-dlg-open'); ovRoot.classList.remove('w-dlg-open'); },

    /* --- module contract --- */
    update(dt) {
      touch.update(dt);            // runs while hidden: it owns the input fn
      if (!visible) return;
      hud.update(dt);
      dlg.update(dt);
    },
    resize() { touch.measure(); },
    dispose() {
      closeAll();
      hud.dispose(); dlg.dispose(); phone.dispose(); touch.dispose();
      scrim.remove(); panels.remove(); film.remove(); vignette.remove();
      for (const off of subs) off();
      removeEventListener('keydown', onKey);
    },
  });

  /* live state — defineProperties, because Object.assign would
     evaluate a getter once and freeze its value */
  Object.defineProperties(api, {
    modal: { get: () => stack.length > 0, enumerable: true },
    visible: { get: () => visible, enumerable: true },
    near: { get: () => hud.nearLocation, enumerable: true },
    dialogueOpen: { get: () => dlg.isOpen, enumerable: true },
    panels: { get: () => stack.map((s) => s.name), enumerable: true },
  });

  /* ------------------------------------------------------------
     keyboard — the original's bindings
     ------------------------------------------------------------ */
  const typing = (e) => {
    const t = e.target;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  };
  function onKey(e) {
    if (!visible || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.code) {
      case 'KeyP':
        e.preventDefault();
        if (topName() === 'phone') api.hide('phone'); else openPhone();
        break;
      case 'KeyM':
        e.preventDefault();
        openPhone('places');
        break;
      case 'KeyO':
        e.preventDefault();
        openDesk();
        break;
      case 'KeyE':
        /* the camera keeps Q/E while a panel is open — interact() says so */
        if (interact()) e.preventDefault();
        break;
      case 'Escape':
        e.preventDefault();
        if (dlg.isOpen) { dlg.close(null); return; }
        if (topName() === 'phone' && phone.app) { phone.home(); sfx('ui.back'); return; }
        if (stack.length) { sfx('ui.back'); popSheet(); return; }
        api.show('pause');
        break;
      default: break;
    }
  }
  addEventListener('keydown', onKey);

  /* ------------------------------------------------------------
     the bus
     ------------------------------------------------------------ */
  const subs = [];
  const on = (t, fn) => subs.push(ctx.bus.on(t, fn));

  on('note', (n) => toast(n.text, n.kind));
  on('banner', (b) => banner(b.title, b.sub));
  on('msg', (m) => { toast('Message from ' + m.from, 'token'); sfx('ui.toast'); });
  on('tip', (t) => api.dialogue({ speaker: t.title, role: 'A note for you', text: t.text, portrait: 'wally' }));
  on('quest', (q) => {
    if (q.kind === 'complete') sfx('quest.done');
    else if (q.kind === 'milestone') sfx('fanfare');
    hud.refresh(true);
  });
  on('unlock', (u) => { if (u && !u.quiet) sfx('unlock'); });
  on('day', () => refresh());
  on('trade', () => hud.refresh(true));
  on('client', (c) => { if (c.kind === 'arrive') sfx('bell.small'); });
  on('place', (p) => {
    hud.refresh(true);
    const a = ZONE_AUDIO[p.zone];
    if (a) ctx.bus.emit('game:zone', { name: a, zone: p.zone });
  });
  on('endgame', () => api.dialogue({
    speaker: 'The City', role: 'Bull Bear City',
    text: ['Every asset. Every field, every seam, every seat in that stadium — connected, and held by the people who live beside them.',
           'You did that on a squeaky bicycle. Thank you, Wally.'],
    choices: [{ label: 'Keep playing', value: null, kind: 'prim' }],
  }));
  on('ready:game', () => {
    hud.refresh(true);
    const st = ctx.game?.state;
    if (st && !st.flags.readMentor && !ctx.flags?.shot) {
      setTimeout(() => toast('Your phone buzzed. Press P.', 'token'), 1400);
    }
  });

  /* ------------------------------------------------------------
     boot state
     ------------------------------------------------------------ */
  const S = ctx.game?.state?.settings;
  if (S) {
    setTextSize(S.textSize || 1);
    setReducedMotion(!!S.reduced);
    setHighContrast(!!S.contrast);
  }
  /* Thumbstick + action pad, on a phone only. touch.js also arms a
     one-shot touchstart listener, so a hybrid laptop grows controls
     the moment a finger lands on it and never before. */
  if (shouldEnable(ctx)) touch.setEnabled(true);
  /* audio boots after us — apply the saved mix once it exists */
  on('ready', () => {
    if (!ctx.audio || !S) return;
    try { ctx.audio.musicVolume = S.music; ctx.audio.sfxVolume = S.sfx; } catch (e) {}
  });
  hud.refresh(true);

  /* ------------------------------------------------------------
     debug
     ------------------------------------------------------------ */
  function sampleDialogue() {
    const c = ctx.game?.data?.clientById?.mabel;
    return {
      speaker: c ? c.n : 'Mabel',
      role: c ? c.role : 'Retired teacher',
      portrait: 'mabel',
      text: ['I taught arithmetic for thirty-one years. I still don’t trust anything that goes up too fast.',
             'So: a one-year community bond, and nothing clever. Can you have it by Thursday?'],
      choices: [
        { label: 'Consider it done', value: 'yes', kind: 'prim', icon: 'check' },
        { label: 'What is the budget?', value: 'ask' },
        { label: 'Not this week', value: null, kind: 'ghost' },
      ],
    };
  }

  /* a prompt in front of Wally — shows the shape of the world-space
     prompt without having to walk anywhere */
  function demoPrompt(text) {
    const w = ctx.wally;
    if (!w) return;
    const p = w.position;
    const yaw = w.rotation?.y ?? 0;
    const near = ctx.game?.nearest?.(p.x, p.z);
    hud.addPrompt({
      id: 'demo',
      pos: { x: p.x + Math.sin(yaw) * 2.4, y: p.y + (w.height || 1.7) * 1.2, z: p.z + Math.cos(yaw) * 2.4 },
      key: 'E',
      text: text || (near ? near.loc.n : 'Your Apartment'),
      sub: near && near.dist > 30 ? Math.round(near.dist) + ' m away' : '',
    });
  }

  if (typeof window !== 'undefined' && window.WALLY) {
    const d = window.WALLY.debug || (window.WALLY.debug = {});
    d.ui = (name, arg) => {
      api.setVisible(true);
      dlg.close(null);
      switch (name) {
        case 'hud':
          closeAll();
          hud.refresh(true);
          toast('+$56 · shift', 'money');
          toast('Order accepted from Mabel', 'good');
          hud.demoDelta('+$56');
          demoPrompt();
          break;
        case 'dialogue': closeAll(); api.dialogue(arg); break;
        case 'phone': closeAll(); demoPrompt(); openPhone(arg || null); break;
        case 'place': closeAll(); openPlace(arg || 'apartment'); break;
        case 'desk': closeAll(); openDesk(); break;
        case 'travel': closeAll(); pushSheet(menus.travel(arg || 'trunkdepot')); break;
        case 'pause': closeAll(); api.show('pause'); break;
        case 'settings': closeAll(); pushSheet(menus.settings()); break;
        case 'market': closeAll(); pushSheet(menus.market(arg || 'bazaar')); break;
        case 'school': closeAll(); pushSheet(menus.school()); break;
        case 'banner': banner('TOKENIZED', 'Strawberry Field Token · 3% of the city'); break;
        default: api.show(name, arg);
      }
      return name;
    };
    d.uiAll = () => {
      api.setVisible(true);
      closeAll();
      hud.refresh(true);
      toast('+$56 · shift', 'money');
      toast('Discovered TRUNK Depot', 'token');
      demoPrompt();
      openPhone(null);
      api.dialogue(sampleDialogue());
      return 'hud + prompt + phone + dialogue';
    };
    /* --- touch controls, for the phone screenshots --- */
    d.touch = (on = true) => { api.setTouch(!!on); return touch.enabled; };
    /** Pose the thumbstick without a thumb: nx/ny in -1..1, y up. */
    d.stick = (nx, ny) => {
      if (!touch.enabled) api.setTouch(true);
      return touch.demo(nx, ny);
    };
    d.touchState = () => ({ enabled: touch.enabled, active: touch.active, ...touch.axes });
    d.uiToast = (t, k) => { toast(t || 'Toast', k || 'info'); return true; };
    d.uiBanner = (t, s) => { banner(t || 'TOKENIZED', s || '3% of the city is connected'); return true; };
    d.uiPrompt = (t) => { demoPrompt(t); return true; };
    d.uiHide = () => { closeAll(); dlg.close(null); return true; };
  }

  return api;
}

export default init;
