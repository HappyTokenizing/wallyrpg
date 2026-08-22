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
   arrive(loc) flushArrival() arrivalPoint(loc)
   modal (bool)  visible (bool)  near (the location Wally is standing at)

   ARRIVAL. This module also owns the half of fast travel that moves the
   player. ctx.game.travel() changes state.loc and emits 'travel'; the
   listener at the bottom of this file turns that into a real arrival at
   ctx.city.doorPosition(loc), through ctx.wally.warpTo() and
   ctx.cam.warp(), behind a 180/260 ms fade. See the ARRIVAL block.

   DEBUG: WALLY.debug.ui(name), WALLY.debug.uiAll(),
          WALLY.debug.travel(loc, mode), WALLY.debug.arrive(loc)
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
    /* the same ELEMENT must never sit in the stack twice, whatever it
       is called: two entries pointing at one node leaves one of them
       permanently undismissable */
    const dup = stack.findIndex((s) => s.el === el);
    if (dup >= 0) stack.splice(dup, 1);
    stack.push({ name, el });
    panels.append(el);
    syncModal();
    return el;
  }

  /* The one exit, so a panel dismissed from the top, by name or by
     element all leave the same way. */
  function retire(el) {
    if (!el) return false;
    el.classList.add('out');
    setTimeout(() => { el.classList.remove('out'); el.remove(); }, 300);
    syncModal();
    return true;
  }

  /* ------------------------------------------------------------
     WHICH BOX THE ✕ BELONGS TO.

     popSheet() dismisses the TOP of the stack. That is right for Esc
     and for a click on the scrim, and wrong for every close button
     printed on a panel: open a place card, travel, open a second card
     over it, then reach back and press the OLDER card's ✕ — and the
     newer one vanished instead, because the button popped the stack
     instead of closing the thing it was drawn on.

     Everything bound to a particular panel goes through closeSheet().
     It takes the panel, or any node inside it, finds THAT entry
     wherever it sits in the stack, and removes it and nothing else.
     ------------------------------------------------------------ */
  function sheetRoot(node) {
    if (!node) return null;
    if (typeof node.closest === 'function') {
      const own = node.closest('.w-sheet, .w-phone, .w-pause');
      if (own) return own;
    }
    return node;
  }
  function closeSheet(node) {
    const el = sheetRoot(node);
    if (!el) return popSheet();
    const i = stack.findIndex((s) => s.el === el);
    if (i < 0) {
      /* not in the stack (or already gone): take the node out rather
         than punishing whatever happens to be on top for it */
      if (el.isConnected && el.parentNode === panels) return retire(el);
      return false;
    }
    stack.splice(i, 1);
    return retire(el);
  }
  function popSheet() {
    const top = stack.pop();
    if (!top) return false;
    return retire(top.el);
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

  /* ============================================================
     ARRIVAL — the other half of fast travel.

     THE BUG THIS EXISTS TO FIX. ctx.game.travel() charged the fare,
     burned the clock, moved state.loc, refreshed the HUD and swapped
     the zone music — and left Wally standing exactly where he was.
     Nothing in the build listened for 'travel' in order to MOVE him,
     so in a 3D remake of a location-based RPG, travelling did not take
     you anywhere: the Places app, the fares, the travel times and all
     28 locations were disconnected from the world the player was
     standing in.

     It is wired to the EVENT, not to the button. game.travel() and
     game.enter() both emit 'travel' synchronously, so this one listener
     covers the Places app, the fare board, the HUD's objective jump,
     a door walked through in the world, and a bare ctx.game.travel()
     typed into the console — which is the case that had no coverage at
     all, because the only caller that moved him was one onclick handler
     inside menus.js.

     WALKING THROUGH A DOOR IS NOT AN ARRIVAL. game.enter() emits the
     same event, and he is already standing at that door — that is how
     he triggered it. Teleporting him "there" would jolt him a metre
     sideways and blink the screen every single time he entered a shop.
     The ARRIVE_NEAR test below is what separates the two cases, and it
     separates them by the only thing that actually distinguishes them:
     how far away he is.
     ============================================================ */

  /* Under this many metres from the destination door he is already
     there. Covers game.enter(), a repeat travel to the same place, and
     the two locations in Rusty Row that share a forecourt. */
  const ARRIVE_NEAR = 6;
  /* The transition. Kept short on purpose: this fires every time the
     player crosses the island, which in this game is constantly, and a
     cinematic wipe you have seen four hundred times is a loading
     screen. Measured end to end at 350 ms, comfortably inside the
     budget.

     THE TWO CURVES ARE NOT THE SAME CURVE, AND THE OUT ONE WAS WRONG.
     It started as `ease-in`, which is slow at the start — so when the
     teleport fired at the end of the fade, the screen was sampled at
     only 0.67 opacity and the player would have seen a third of the cut
     straight through it. Sampled per animation frame:

       ease-in, land at 170 ms   peak painted opacity 0.67   visible cut
       ease-out, land at 180 ms  peak painted opacity 1.00   clean

     So: OUT is ease-out over 140 ms and the landing waits 180, which
     leaves 40 ms of solid black to move him inside — the compositor is
     a frame or two behind the style change and that margin is what pays
     for it. IN is ease-in over 260 ms, which holds the black a moment
     and then opens, so the arrival reveals rather than blinks. */
  const FADE_OUT_MS = 140;      // the curtain's own transition
  const FADE_HOLD = 180;        // when the teleport fires: must exceed the above
  const FADE_IN = 260;

  /* Tallest building the arrival camera will look straight AT rather
     than across. Derived, and shot, in land() below. */
  const LOOK_AT_MAX_H = 6;

  /* The curtain. z-index 60 puts it over the HUD (10), the modal
     overlay (20) and the film grain and vignette (30/31), and under the
     boot screen (100). It is inert to the pointer at all times: a fade
     that could eat a click would be a worse bug than the one it is
     part of fixing. */
  const curtain = h('div.w-warp');
  Object.assign(curtain.style, {
    position: 'fixed', inset: '0', background: '#000',
    opacity: '0', pointerEvents: 'none', zIndex: '60',
    transition: `opacity ${FADE_OUT_MS}ms ease-out`,
  });
  document.body.append(curtain);

  /* An arrival that has faded out but not yet landed. */
  let armed = null;      // {locId, p, t}

  /** Where you end up when you travel to `locId` — feet position + facing. */
  function arrivalPoint(locId) {
    const loc = ctx.game?.data?.locationById?.[locId];
    /* ctx.city.doorPosition is documented as "the point you walk to",
       which is the arrival point by definition — it is built from the
       building's own doorway rather than from its centre, so it already
       accounts for footprint, facing and porch. data.js's world{} is
       the building CENTRE, so it is only the fallback for a location
       the city never built a record for, pushed out along the
       location's own yaw to the front of its footprint. */
    let dx = null, dy = null, dz = null;
    try {
      const d = ctx.city?.doorPosition?.(locId);
      if (d && Number.isFinite(d.x + d.y + d.z)) { dx = d.x; dy = d.y; dz = d.z; }
    } catch (e) { /* fall through to the data.js fallback */ }
    if (dx === null) {
      if (!loc) return null;
      const out = (loc.size?.d ?? 8) * 0.5 + 3.4;
      dx = loc.world.x + Math.sin(loc.yaw) * out;
      dz = loc.world.z + Math.cos(loc.yaw) * out;
      dy = loc.world.y;
    }

    /* Stand a short step BACK from the threshold rather than in the
       doorway: the door point is 1.5 m off the facade, which is inside
       the porch on the locations that have one, and a character clipped
       into his own front porch is the first thing anyone notices about
       an arrival.

       0.9 m, AND NOT MORE, which was measured rather than guessed.
       2.2 m was tried and shot at four locations: at Waterfront Docks
       it walked him off the pier apron, and the camera's ground and
       penetration clamps then dropped the lens to deck height with
       Wally out of the bottom of frame entirely. The door apron is the
       only ground near a building that is reliably flat, reliably level
       and reliably clear, and a step is as far as you can go before you
       are off it. */
    let x = dx, z = dz, faceX = dx, faceZ = dz;
    if (loc) {
      const ox = dx - loc.world.x, oz = dz - loc.world.z;
      const len = Math.hypot(ox, oz);
      if (len > 0.05) { x = dx + (ox / len) * 0.9; z = dz + (oz / len) * 0.9; }
      faceX = loc.world.x; faceZ = loc.world.z;   // turn to face the door
    }

    /* Start him a touch high and let the controller's own snapToGround
       find the real surface — the door's y is the building's base, and
       the apron, steps and terrain under his feet are collision
       geometry the terrain height function does not know about. */
    let y = dy;
    try {
      const t = ctx.world?.heightAt?.(x, z);
      if (Number.isFinite(t)) y = Math.max(y, t);
    } catch (e) { /* keep the door's own y */ }
    if (!Number.isFinite(x + y + z)) return null;

    return { x, y: y + 0.3, z, faceX, faceZ };
  }

  /** Put him down. The camera cut goes with it — they are one event. */
  function land(locId, p) {
    const w = ctx.wally;
    if (!w) return false;
    let ok = false;
    try {
      if (typeof w.warpTo === 'function') {
        ok = w.warpTo(p.x, p.y, p.z, { face: { x: p.faceX, z: p.faceZ } });
      } else {
        /* Older wally.js: setPosition still goes through the controller,
           which is the part that matters. */
        w.setPosition(p.x, p.y, p.z);
        w.setYaw(Math.atan2(p.faceX - p.x, p.faceZ - p.z));
        ok = true;
      }
    } catch (e) { console.warn('[ui] arrival failed', e); return false; }
    if (!ok) return false;

    /* CUT, do not fly. The rig would otherwise ease its anchor height,
       its boom azimuth and its wedge relief across 900 m of island in
       full view of the player. cam.warp() drops all of that and
       re-solves against the new surroundings in one frame.

       WHICH WAY THE LENS POINTS IS DECIDED BY THE BUILDING'S HEIGHT,
       because both of the obvious answers were tried, shot at four
       locations, and each is reproducibly wrong at half of them:

         LOOK AT IT — warp({yaw: his facing}), so the lens sits out on
           the street behind him and looks at the door. Perfect at the
           Noodle Cart: the stall, its awning, the two customers at the
           counter and the "you are here" prompt, all in frame. A wall
           of stucco at the bank — a 14 m facade two metres from his
           nose fills the frame edge to edge and nothing is readable.

         LET IT SOLVE — warp() with no azimuth runs pickPortraitYaw,
           which sweeps the azimuths and scores each for boom clearance
           and open world. Excellent at the bank: its steps and columns
           on the right, the street running back behind him. At the
           Noodle Cart it put the lens behind a barrel with the cart out
           of frame entirely — the sweep scores CLEARANCE and OPENNESS,
           neither of which knows that the thing you just travelled to
           is the thing that ought to be in the picture.

       The discriminator is whether the building fits in the frame from
       where the lens ends up. He stands ~2.4 m off the facade and the
       boom is ~3.2 m, so the lens is ~5.5 m out; at the follow preset's
       50 deg that frames 2 * 5.5 * tan(25) = 5.1 m of height. Anything
       up to about a storey and a half can be looked AT and be seen;
       anything taller has to be looked ACROSS, which is the portrait.
       Hence 6 m, and hence: carts, stalls and huts get the arrival shot,
       banks and stadiums get the portrait. */
    const loc = ctx.game?.data?.locationById?.[locId];
    const bh = loc?.size?.h ?? 0;
    const yaw = (bh > 0 && bh <= LOOK_AT_MAX_H)
      ? Math.atan2(p.faceX - p.x, p.faceZ - p.z)
      : undefined;
    try {
      if (ctx.cam?.warp) ctx.cam.warp(yaw === undefined ? {} : { yaw });
      else ctx.cam?.reframe?.();
    } catch (e) {}
    ctx.bus?.emit('arrive', { loc: locId, x: p.x, y: p.y, z: p.z });
    return true;
  }

  /** Reduced motion gets the teleport without the blink. */
  const canFade = () => !ctx.game?.state?.settings?.reduced;

  function fadeIn() {
    curtain.style.transition = `opacity ${FADE_IN}ms ease-in`;
    curtain.style.opacity = '0';
  }

  /** Land any arrival still behind the curtain, right now. */
  function flushArrival() {
    if (!armed) return false;
    const a = armed;
    armed = null;
    land(a.locId, a.p);
    fadeIn();
    return true;
  }

  /**
   * Travel arrived somewhere. Move him there, behind a short fade.
   *
   * The fade is driven from update(dt), not from setTimeout: a
   * backgrounded tab throttles timers to whole seconds, and an arrival
   * that commits a second late is a second in which state.loc and the
   * world disagree about where the player is — which is the very bug
   * this function exists to close.
   */
  function arrive(locId, o = {}) {
    if (!locId || !ctx.wally) return false;
    /* Already in flight to the same place: menus.js calls placeWally()
       immediately after game.travel(), and game.travel() has already
       emitted 'travel' by then, so this function is legitimately called
       twice for one journey. It must not fade twice. */
    if (armed && armed.locId === locId) return true;

    const p = arrivalPoint(locId);
    if (!p) return false;

    const w = ctx.wally.position;
    if (Math.hypot(w.x - p.x, w.z - p.z) <= ARRIVE_NEAR) return true;   // he walked here

    flushArrival();                    // a different arrival mid-fade lands first
    if (o.instant || !canFade()) { land(locId, p); return true; }

    armed = { locId, p, t: 0 };
    curtain.style.transition = `opacity ${FADE_OUT_MS}ms ease-out`;
    curtain.style.opacity = '1';
    return true;
  }

  /** Drive the curtain. Runs even while the interface is hidden. */
  function tickArrival(dt) {
    if (!armed) return;
    armed.t += dt > 0 ? Math.min(dt, 0.25) : 0;
    if (armed.t * 1000 >= FADE_HOLD) flushArrival();
  }

  /* ------------------------------------------------------------
     navigation
     ------------------------------------------------------------ */

  /* Stand Wally just outside a location's front door.

     Kept as the published name — menus.js calls it — but it is now the
     same code path as a travel event rather than a second, competing
     implementation of "put him at the door". Two of those is how the
     double fade gets in. */
  const placeWally = (locId) => arrive(locId);

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

  /* TICKER SEARCH / QUICK BUY. One box, one confirm. Reachable from
     the pill beside the money readout, from B, from the Wallet app
     and from the head of any venue's order book — "how do I buy a
     thing" should not have a route you can fail to find. */
  function openQuickBuy(preset) {
    const el = pushSheet(menus.quickBuy(preset), 'buy');
    try { ctx.game?.quests?.tip?.('ticker'); } catch (e) {}
    setTimeout(() => { try { el?.querySelector?.('input')?.focus(); } catch (e) {} }, 80);
    return el;
  }

  /* The yellow pointer follows this instead of the current objective
     until he gets there. Null hands it back to the objective. */
  const setDestination = (locId) => hud.setDestination(locId);

  /* ============================================================
     THE MAYOR'S DASH — the half that happens on screen.

     game.race owns the rules, the route, the pace and the verdict.
     This owns the only two things the rules layer cannot see: WHERE
     WALLY ACTUALLY IS, and HOW LONG HE HAS BEEN RUNNING. So the loop
     below is the whole of the race as the player experiences it —
     touch each corner in order, and the clock we hand to
     race.finish() is the clock the result is judged on.

     THE MAYOR IS NOT SIMULATED, HE IS PACED. race.pace() gives his
     target time for this attempt and the metres-per-second that goes
     with it, so a marker travelling at `mps` along the same route is
     exactly the opponent the rules layer will compare against. A
     marker that agreed with the rule two thirds of the time would be
     worse than no marker at all.

     LOSING IS SHOWN AS A GAP, NOT A WALL. Every leg is split against
     his even pace and handed to the result card, so a loss reads as
     "you lost four seconds on the run to Dispatch" — a number to beat
     next time. Nothing here mentions the scooter.
     ============================================================ */
  const RACE_CORNER = 9;        // metres: how near counts as touched
  let race = null;
  let pendingSplits = null;     // handed to the result card by raceTick

  function raceBegin(p) {
    const g = ctx.game;
    if (!g || !ctx.wally) return;
    const route = p.route || g.race.route();
    if (!route || route.length < 2) return;
    race = {
      route,
      metres: p.metres || g.race.metres(),
      mayorSeconds: p.mayorSeconds || 1,
      mps: p.mps || 1,
      elapsed: 0, cp: 0, legT: 0, splits: [],
    };
    closeAll();
    dlg.close(null);
    banner("THE MAYOR'S DASH", route[1].n + ' first · ' + Math.round(race.mayorSeconds) + 's to beat');
    sfx('quest.start');
    racePaint(0);
  }

  function raceStop() {
    race = null;
    hud.setRace(null);
    hud.removePrompt('race');
  }

  /* progress along the route, 0..1, from his real position */
  function raceProgress() {
    const r = race;
    const done = r.route[r.cp].total;               // metres banked at the last corner
    const next = r.route[r.cp + 1];
    const p = ctx.wally.position;
    const d = Math.hypot(p.x - next.world.x, p.z - next.world.z);
    const leg = Math.max(1, next.metres);
    const into = Math.max(0, Math.min(leg, leg - d));
    return { frac: Math.min(1, (done + into) / Math.max(1, r.metres)), dist: d, next };
  }

  function racePaint(dt) {
    const r = race;
    const { frac, dist, next } = raceProgress();
    const his = Math.min(1, (r.mps * r.elapsed) / Math.max(1, r.metres));
    /* seconds: how long HE would have taken to get where you are */
    const mine = (frac * r.metres) / r.mps;
    hud.setRace({
      elapsed: r.elapsed, cp: r.cp, of: r.route.length - 1,
      next: next.n, dist, target: r.mayorSeconds,
      mine: frac, his, delta: r.elapsed - mine,
    });
    hud.addPrompt({
      id: 'race', pos: { x: next.world.x, y: next.world.y + 4.2, z: next.world.z },
      key: next.finish ? '🏁' : String(r.cp + 1),
      text: next.n, sub: Math.round(dist) + ' m',
    });
  }

  function raceTick(dt) {
    if (!race || !ctx.wally) return;
    const r = race;
    r.elapsed += dt;
    const { dist, next } = raceProgress();
    if (dist < RACE_CORNER) {
      const res = ctx.game.race.checkpoint(r.cp + 1);
      if (res && res.ok) {
        const legHis = next.metres / r.mps;
        const legMine = r.elapsed - r.legT;
        r.splits.push({
          i: r.cp + 1, n: next.n, t: r.elapsed,
          mine: legMine, his: legHis, lost: legMine - legHis,
        });
        r.legT = r.elapsed;
        r.cp++;
        if (r.cp >= r.route.length - 1) {
          const secs = r.elapsed;
          /* SET BEFORE FINISHING. race.finish() emits 'race' straight
             back at the listener below, so the splits have to be
             parked before the call, not after it. */
          pendingSplits = r.splits.slice();
          raceStop();
          ctx.game.race.finish(secs);
          return;
        }
        sfx('bell.small');
      }
    }
    racePaint(dt);
  }
  function raceAbandon() {
    if (!race) return false;
    raceStop();
    try { ctx.game.race.abandon(); } catch (e) {}
    toast('You stopped running. He did not.', 'bad');
    return true;
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
        case 'buy': case 'quickbuy': case 'ticker': openQuickBuy(arg); break;
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
      /* the LAST panel with that name, so two markets open at once
         close newest-first by name and by their own ✕ individually */
      let i = -1;
      for (let k = stack.length - 1; k >= 0; k--) if (stack[k].name === name) { i = k; break; }
      if (i < 0) return api;
      const [t] = stack.splice(i, 1);
      retire(t.el);
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
    /** Ticker search + one-confirm buy. `preset` is an id or ticker. */
    openQuickBuy,
    /** Point the yellow HUD pointer at a place (null = the objective). */
    setDestination,
    /** Move him to a location's door. Fires on every 'travel' event. */
    arrive,
    /** Land an arrival still behind the curtain. Saves, tests, cutscenes. */
    flushArrival,
    /** Where travelling to `locId` puts him: {x,y,z,faceX,faceZ}. */
    arrivalPoint,
    showOrder: (o) => menus.showOrder(o),
    talkTo: (c) => menus.talkTo(c),
    addPrompt: hud.addPrompt, removePrompt: hud.removePrompt,
    pushSheet, popSheet, closeAll, refresh, rebuildTop,
    /** Close THIS panel — pass the panel or any node inside it. Every
        close button on a panel must use this, never popSheet(). */
    closeSheet,
    /** The Mayor's Dash: the start card, and quitting mid-race. */
    openRace: () => pushSheet(menus.raceCard(), 'race'),
    raceAbandon,
    get racing() { return !!race; },
    /** A hunger or hours refusal, with the route out printed on it.
        Takes a gate() result: {kind:'hunger'|'hours', why, food|loc}. */
    showBlocked: (r) => menus.blocked(r),
    renderSettings: (el) => menus.renderSettings(el),
    /** The fare board, so the phone and the map quote fares identically. */
    renderTravelModes: (el, locId, onDone) => menus.travelModes(el, locId, onDone),
    /** One ride, as a row. The garage, a shop counter and the fare
        board all render the same object from the same data table. */
    renderRide: (r, opts) => menus.rideRow(r, opts),
    /** Every ride, fastest first — the phone's garage. */
    renderRides: (el, opts) => { for (const row of menus.rideList(opts)) el.append(row); },
    /** The map at full size. */
    openMap: (locId) => pushSheet(menus.bigMap(locId), 'map'),

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
      /* Before the visibility gate: a cinematic that hides the HUD must
         not strand a half-landed arrival behind a black screen. */
      tickArrival(dt);
      /* the race runs whether or not the HUD is showing: a cinematic
         must not silently stop the clock the result is judged on */
      raceTick(dt);
      if (!visible) return;
      hud.update(dt);
      dlg.update(dt);
    },
    resize() { touch.measure(); },
    dispose() {
      flushArrival();
      closeAll();
      hud.dispose(); dlg.dispose(); phone.dispose(); touch.dispose();
      scrim.remove(); panels.remove(); film.remove(); vignette.remove();
      curtain.remove();
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
      case 'KeyB':
        e.preventDefault();
        if (topName() === 'buy') api.hide('buy'); else openQuickBuy();
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
  /* THE ONE LINE THE WHOLE NAVIGATION LOOP WAS MISSING. Every route into
     travel ends here: menus.js's fare board, the Places app (via goto),
     the HUD's objective jump, game.enter() from a door in the world, and
     a bare ctx.game.travel() from anywhere at all. */
  on('travel', (t) => {
    /* you cannot take the train round a footrace */
    if (race) raceAbandon();
    if (t && t.to) arrive(t.to);
  });

  /* ---- THE MAYOR'S DASH ---- */
  on('race', (r) => {
    if (!r) return;
    switch (r.kind) {
      case 'offer': {
        const m = ctx.game.race.mayor();
        const L = ctx.game.data.race.lines;
        api.dialogue({
          speaker: m.n, role: m.role, portrait: m.id,
          text: [L.offer, L.start],
          choices: [
            { label: 'Say when', value: 'go', kind: 'prim', icon: 'play',
              onPick: () => api.openRace() },
            { label: 'Let me look at the route', value: 'route',
              onPick: () => api.openRace() },
            { label: 'Not right now', value: null, kind: 'ghost' },
          ],
        });
        break;
      }
      case 'start': raceBegin(r); break;
      case 'finish': {
        const splits = pendingSplits;
        pendingSplits = null;
        raceStop();
        sfx(r.won ? 'fanfare' : 'ui.error');
        pushSheet(menus.raceResult({ ...r, splits }), 'race');
        break;
      }
      case 'abandon': raceStop(); break;
      default: break;
    }
    hud.refresh(true);
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
        case 'buy': case 'quickbuy': closeAll(); openQuickBuy(arg); break;
        case 'map': closeAll(); pushSheet(menus.bigMap(arg), 'map'); break;
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
      toast('Discovered Dispatch', 'token');
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
    /* --- travel, for the arrival screenshots and tools/traveltest.mjs --- */
    /** Full fast travel: fare, clock, state AND the arrival. */
    d.travel = (loc, mode = 'train') => {
      const r = ctx.game?.travel?.(loc, mode);
      return { ...r, loc: ctx.game?.state?.loc };
    };
    /** The arrival alone, no fare and no clock. `instant` skips the fade. */
    d.arrive = (loc, instant) => arrive(loc, { instant: instant !== false });
    /** Land an arrival still behind the curtain. */
    d.arriveNow = () => flushArrival();
    /** Where travelling to `loc` would put him. */
    d.arriveAt = (loc) => arrivalPoint(loc);
    /* --- the buy path, for the screenshots ---
       `q` is typed into the search box exactly as a player would;
       `pick` selects the first hit, so a shot can pose the ticket. */
    d.uiBuy = (q, pick = true) => {
      closeAll();
      openQuickBuy(pick && q ? q : undefined);
      if (q && !pick) {
        const i = document.querySelector('.w-srch input');
        if (i) { i.value = q; i.dispatchEvent(new Event('input')); }
      }
      return q || 'quickbuy';
    };
    d.uiMap = (loc) => { closeAll(); api.openMap(loc); return loc || 'map'; };
    d.uiDest = (loc) => setDestination(loc);
    d.uiToast = (t, k) => { toast(t || 'Toast', k || 'info'); return true; };
    d.uiBanner = (t, s) => { banner(t || 'TOKENIZED', s || '3% of the city is connected'); return true; };
    d.uiPrompt = (t) => { demoPrompt(t); return true; };
    d.uiHide = () => { closeAll(); dlg.close(null); return true; };

    /* --- the Mayor's Dash, and the two refusals, for screenshots --- */
    /** 'card' the start line · 'live' the running readout ·
        'won'/'lost' the result card. Poses the UI only — the rules
        layer's state is untouched except by 'card', which offers. */
    d.uiRace = (what = 'card') => {
      closeAll();
      const g = ctx.game;
      if (what === 'card') { g.race.offer('debug'); dlg.close(null); api.openRace(); return 'race card'; }
      const v = g.race.view();
      if (what === 'live') {
        raceStop();
        race = { route: v.route, metres: v.metres, mayorSeconds: v.pace.mayorSeconds,
          mps: v.pace.mps, elapsed: 31.4, cp: 2, legT: 0, splits: [] };
        racePaint(0);
        return 'race live';
      }
      const won = what === 'won';
      const t = won ? v.pace.mayorSeconds - 7 : v.pace.mayorSeconds + 9;
      const splits = v.route.slice(1).map((r, i) => ({
        i: i + 1, n: r.n, mine: r.metres / (v.pace.mps * (won ? 1.14 : 0.86)),
        his: r.metres / v.pace.mps,
        lost: r.metres / (v.pace.mps * (won ? 1.14 : 0.86)) - r.metres / v.pace.mps,
      }));
      pushSheet(menus.raceResult({
        won, seconds: t, mayorSeconds: v.pace.mayorSeconds, splits,
        line: won ? g.data.race.lines.won : g.data.race.lines.lost,
        hint: won ? null : g.data.race.hints[0],
      }), 'race');
      return 'race ' + what;
    };
    /** 'hunger' or 'hours' — the refusal card with its way out. */
    d.uiBlocked = (kind = 'hunger') => {
      closeAll();
      const g = ctx.game;
      if (kind === 'hunger') {
        const n = g.needs();
        menus.blocked({ ...n, kind: 'hunger', why: n.why
          || 'Wally is too hungry for anything else. There is food right here.' });
      } else {
        const loc = g.state.loc;
        menus.blocked({ kind: 'hours', loc, why: g.closedLine(loc) });
      }
      return kind;
    };
    /** The farm or the mine, so the upgrade card can be shot. */
    d.uiProducer = (which = 'farm') => {
      closeAll();
      pushSheet(which === 'mine' ? menus.mine() : menus.farm());
      return which;
    };
  }

  return api;
}

export default init;
