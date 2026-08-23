/* ============================================================
   ui.js — ctx.ui. The whole interface.

   Layers (both already in index.html, both pointer-events:none —
   only the interactive children opt back in with .w-pe):

     #ui        the always-on HUD: pills, objective strip, banners,
                world-space prompts, key hints
     #overlay   the modal stack: scrim, phone, sheets, pause,
                and the dialogue card above all of it
     .w-notify  ui/notify.js — achievements and toasts, on <body> at
                z-index 25, ABOVE the modal stack. Nothing the player
                is told may be delivered underneath a sheet.
     .w-endroot ui/ending.js — Happy's ending, on 'game:complete'.

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
          WALLY.debug.travel(loc, mode), WALLY.debug.arrive(loc),
          WALLY.debug.landscape(on) / WALLY.debug.orient()
   ============================================================ */

import { clamp } from '../core/contracts.js';
import { injectStyle, h } from './style.js';
import { createHud } from './hud.js';
import { createDialogue } from './dialogue.js';
import { createPhone } from './phone.js';
import { createMenus } from './menus.js';
/* actionPhrase() is how anything in here TELLS the player to do
   something — 'press E' with a keyboard, 'tap Enter' under a thumb.
   Nothing in this file names a key directly; see the input-mode header
   in touch.js for why that is one mechanism and not seven literals. */
import { createTouch, shouldEnable, actionPhrase } from './touch.js';
import { createOrient } from './orient.js';
import { createNotify } from './notify.js';
import { createEnding } from './ending.js';

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
  /* No DOM of its own: the optional landscape lock, and the honest
     account of whether this browser can actually hold one. */
  const orient = createOrient(ctx, uiRef);
  /* Both of these parent themselves to <body>, ABOVE #overlay — see
     the header. They are deliberately not children of #ui. */
  const notify = createNotify(ctx, uiRef);
  const ending = createEnding(ctx, uiRef);

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

  /* ============================================================
     THE DIALOG ROUND TRIP — a sheet that opens must TAKE the keyboard
     deliberately, and a sheet that closes must GIVE IT BACK.

     THE DEFECT, measured with real Input.dispatchKeyEvent at 390x844:

       Tab to Menu  -> BUTTON.w-abtn.sm[Menu]
       press P      -> BODY            (the phone opened)
       press Escape -> BODY            (it never came back)

     and the mutation that did it, caught with a MutationObserver
     watching the focus holder's ancestor chain:

       DIV.w-touch  class "w-touch" -> "w-touch hidden"   display:none

     THAT IS NOT A BUG IN THE PAD. touch.js hides the whole cluster
     while `ui.modal` is true and it is right to: the pad sits UNDER a
     modal panel, and leaving its buttons in the tab order behind a
     scrim is the classic focus-trap failure. The bug is that this
     layer opened a modal dialog over the player's place in the
     document and then did nothing with the place at all — no take, no
     hand back. The focus was not moved, it was DROPPED, which is the
     one outcome touch.js goes to some length never to cause: blur()
     was rejected there precisely because sending activeElement to
     <body> restarts sequential navigation from the top of the
     document, and this achieved the same thing one keystroke later by
     accident. `driving` is false throughout; the intent flag is not
     involved and never was.

     SO THE CONTRACT, which is just the standard dialog one:

       ON OPEN   remember whoever had the keyboard, then focus the
                 PANEL ROOT.
       ON CLOSE  if the keyboard was inside the panel being removed,
                 hand it to the panel underneath, or — when the stack
                 empties — back to whoever opened the first one.

     WHY THE ROOT AND NOT THE FIRST BUTTON. The APG allows either, and
     the root is the gentler half: role="dialog" plus the panel's own
     heading gives a screen reader the box's NAME on arrival, Tab then
     starts at the top of the panel instead of one item into it, and
     nothing is left armed — a Space arriving at a focused root does
     nothing, where a Space arriving at a focused "Resume" (or, on some
     sheets, something with a price on it) does something the player
     did not ask for. `tabindex="-1"` makes the root a legal target
     without adding it to the tab order.

     WHY A RESTORE CAN'T JUST CALL focus() AND BE DONE. The element it
     is handing back to is usually a pad button, and the pad is STILL
     display:none at that instant: touch.js un-hides on the next frame
     of its own update(), after `api.modal` has gone false. focus() on
     a display:none element is a silent no-op, so the hand-back is
     retried for a few frames and then dropped. Bounded, and quiet if
     it loses — never worse than the behaviour it replaces.

     WHY THIS DOES NOT PUT A RING ON A TOUCH PLAYER'S SCREEN. The
     hand-back only fires if there was a real focus to displace when
     the stack first opened. A thumb press on the pad deliberately
     never focuses anything (touch.js preventDefaults its pointerdown),
     so for a player who has NEVER TOUCHED A KEYBOARD IN THIS SESSION
     `focusReturn` is null and this path really is inert. Asserted as
     PANEL-1..PANEL-6.

     AND HERE IS THE CORRECTION, BECAUSE THE PARAGRAPH ABOVE USED TO
     STOP ONE CLAUSE EARLIER AND WAS FALSE. It said "so for a player
     using their thumbs focusReturn is null and this whole path is
     inert", and a breaker took it apart with a single-variable
     measurement: ONE Tab, ever, then nothing but fingers.

     A thumb press never TAKES focus — but touch.js also deliberately
     never RELEASES it. blur() was rejected there because sending
     activeElement to <body> destroys a screen-reader player's place in
     the document, which is the whole point of the paragraphs above. So
     after one Tab the active element stays parked on that pad button
     for the REST OF THE SESSION, the banked value is non-null for
     every thumb-opened sheet after it, and "using their thumbs" was
     never the same condition as "focusReturn is null".

     WHAT THAT COST. The hand-back fired focus() on a pad button, the
     pad saw focusin, read it as the player focusing the button, and
     cleared `driving` — so the next Space belonged to the button.
     Thumb Jump, thumb Menu, thumb Resume, press Space meaning jump,
     get the pause menu. The path was not inert; it was the bug.

     AND IT AGREES WITH THE PAD'S OWN RULE, WHICH IS WHERE THE FIX IS.
     The pad's sentence — a pad button refuses a keyboard activation
     only if the player touched the pad AFTER focusing it — is right
     and unchanged. What was wrong is that a focus the PLAYER performed
     and a focus this layer RESTORED were the same event to the pad,
     and a script focus()'s focusin is `isTrusted: true`, so the pad
     could not tell them apart on its own. handBack() now says which it
     is, per attempt, via touch.uiWillFocus(). A real Escape-then-Tab
     player still clears the flag and still gets their Space; a
     restored bookmark no longer speaks for them. Asserted as PANEL-7
     and PAD-41.
     ============================================================ */
  const FOCUSABLE = 'button,[href],input,select,textarea,[tabindex]';
  /** Can this element actually take the keyboard right now? */
  function focusable(el) {
    return !!el && el.isConnected && !el.disabled
      && typeof el.focus === 'function' && el.getClientRects().length > 0;
  }
  /** Whoever had the keyboard when the modal stack last left empty. */
  let focusReturn = null;
  /** Give `el` the keyboard as soon as it can hold it. A few frames,
      then give up — see the note above. */
  let lastRestore = null;          // debug: how the last hand-back went
  function handBack(el) {
    if (!el) return;
    /* THE ATTEMPT COUNT IS NOT DECORATION. The retry below is the part
       of this that a signature applied in the wrong place would slip
       through, so the suite has to be able to see that a real close
       really did take more than one frame — otherwise PANEL-7 would be
       green on a page where the pad happened to be visible already and
       the retry branch was never entered at all. */
    const rec = lastRestore = {
      to: el.getAttribute?.('aria-label') || el.className || el.tagName,
      attempts: 0, landed: false, signed: false,
    };
    attemptHandBack(el, 6, rec);
  }
  function attemptHandBack(el, tries, rec) {
    rec.attempts++;
    if (focusable(el)) {
      /* SIGN IT, AND SIGN EVERY ATTEMPT — see A FOCUS THE PLAYER
         PERFORMED AND A FOCUS THE UI RESTORED in touch.js, and the
         correction three paragraphs up. This focus() is very often
         aimed at a pad button, and to the pad a restored focus looked
         exactly like the player picking that button up again: it
         cleared `driving` and handed the next Space to the button, so
         a player on his thumbs pressed Space to jump and got the pause
         sheet. The pad cannot tell the two apart from the event — a
         script focus()'s focusin carries isTrusted TRUE, measured —
         so the only honest answer is for the caller to say which it
         is. Inside the `focusable` branch and NOT around the call to
         handBack(), because that is the retry-proofing: this function
         re-enters itself on rAF for up to six frames (the pad is still
         display:none the instant a sheet closes and focus() on it is a
         silent no-op), and a signature applied once outside would
         cover the first attempt — the one that always fails — and
         leave the attempt that lands unsigned. */
      try { rec.signed = touch.uiWillFocus?.(el) === true; } catch (e) {}
      try { el.focus({ preventScroll: true }); } catch (e) {}
      rec.landed = true;
      return;
    }
    if (tries <= 0) return;
    requestAnimationFrame(() => attemptHandBack(el, tries - 1, rec));
  }
  /** The keyboard is somewhere inside this panel. */
  const holdsFocus = (el) => {
    const a = document.activeElement;
    return !!a && !!el && a !== document.body && el.contains(a);
  };
  /** Called just before a panel leaves the stack, with the stack
      already spliced, so `stack` is what will be left behind. */
  function releaseFocus(el) {
    if (!holdsFocus(el)) return;                 // not ours to hand on
    const under = stack.length ? stack[stack.length - 1].el : null;
    if (under) { handBack(under); return; }
    const back = focusReturn;
    focusReturn = null;
    /* `back` is null whenever nothing held the keyboard at the moment
       the stack opened — which is every session driven by a thumb,
       because a pad press deliberately never focuses. Then this does
       nothing, the node goes, and the browser drops focus to <body>:
       exactly where it went before any of this existed. No worse, and
       no teleport handed to a player who never asked for one. */
    if (back) handBack(back);
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
    /* BEFORE the append, while activeElement is still the opener and
       before anything reparents. Only the FIRST panel banks a return
       address: a second panel's opener is the first panel, and the
       chain in releaseFocus() already walks that. */
    const opener = document.activeElement;
    if (!stack.length) {
      focusReturn = (opener && opener !== document.body && opener.isConnected
        && !panels.contains(opener)) ? opener : null;
    }
    stack.push({ name, el });
    panels.append(el);
    /* A dialog a keyboard cannot land on is not a dialog. `role` is
       set here rather than in menus.js so a panel this layer did not
       build — phone.root — gets the same contract. */
    if (!el.getAttribute('role')) el.setAttribute('role', 'dialog');
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.setAttribute('aria-modal', 'true');
    /* AND NO RING ON THE BOX ITSELF, which is a measurement and not a
       taste. With the root focused, Chrome matched :focus-visible and
       painted `outline: auto 1px rgb(0,95,204)` — the browser's own
       blue — around the whole pause panel, on a touchscreen, for a
       player who had tapped Menu with a thumb and never touched a
       keyboard. This root is tabindex="-1": it is never a tab stop and
       never a control, so there is no keyboard-operable component
       losing its indicator here, and the thing that tells the player
       where they are is the panel filling the screen over a scrim.
       Every real control inside it keeps its own ring untouched. */
    el.style.outline = 'none';
    syncModal();
    handBack(el);
    return el;
  }

  /* The one exit, so a panel dismissed from the top, by name or by
     element all leave the same way. */
  function retire(el) {
    if (!el) return false;
    /* FIRST, and not in the 300 ms timeout below. The panel spends its
       fade-out still in the document, so a keyboard left inside it can
       Tab around a box that is on its way off screen; and once the node
       does go, the browser drops the focus to <body> and the hand-back
       has nothing left to read. Every caller — closeSheet, popSheet,
       hide(name), the scrim — has already spliced the stack by here,
       so `stack` is the panel underneath. */
    releaseFocus(el);
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
    /* the whole stack goes at once, so the hand-back is the outermost
       one — the element that had the keyboard before any of this
       opened. Read before the nodes leave the document. */
    const inside = stack.some((s) => holdsFocus(s.el));
    while (stack.length) stack.pop().el.remove();
    const back = focusReturn;
    focusReturn = null;
    if (inside && back) handBack(back);
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

  /* A NOTIFICATION BEHIND THE TRAVEL CURTAIN HAS NOT BEEN SEEN.
     The curtain is opaque black over the whole frame at z-index 60,
     which is above the notification layer, so anything presenting
     during a fast travel is invisible for 350 ms of its life — and a
     short toast could spend most of itself in there. The clock stops
     until the black lifts. Same predicate covers the boot screen,
     which notify.js checks on its own. */
  notify.obscuredBy(() => curtain.style.opacity !== '0');

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
     use whatever door Wally is standing at.

     EVERY PATH THROUGH HERE LEAVES A REASON. The middle line is a
     SILENT refusal — a sheet is open, so the verb does nothing at all —
     and a silent refusal is indistinguishable from an input path that
     is broken. One activation was measured looking exactly like that:
     handler entered, click detail 0, inside the pad, and no panel and
     no toast, immediately after a stacked phone-plus-desk pair was
     closed. Read the answer back with WALLY.debug.interact(); the door
     half of the story is in hud.js under A REFUSAL HAS TO SAY WHY. */
  let lastInteract = { path: 'none', ok: false, why: 'interact() has not been called yet' };
  const noteInteract = (path, ok, why) => {
    lastInteract = {
      path, ok, why,
      at: Math.round(typeof performance !== 'undefined' ? performance.now() : 0),
      panels: stack.map((s) => s.name),
      dialogue: dlg.isOpen,
      near: hud.nearLocation?.id ?? null,
    };
    return ok;
  };
  function interact() {
    if (dlg.isOpen) { dlg.advance(); return noteInteract('dialogue', true, 'advanced the card'); }
    if (stack.length) {
      return noteInteract('panel', false,
        `refused: ${stack.length} sheet(s) open, top is "${topName()}"`);
    }
    const ran = hud.interact();
    return noteInteract('door', ran, hud.interactWhy);
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
  /* HIDE UI — the two top clusters fade out and nothing else does.
     See the .w-hide-ui block in style.js for what stays and why; the
     short version is that anything which is a RESPONSE to the player
     (toasts, banners, notifications, the race box, the world prompt)
     keeps drawing, and on touch the thumbstick and the whole
     bottom-right cluster keep drawing too.

     A class on the roots, not a teardown: hud.js still writes the
     objective and still steers the compass arrow every frame, and
     touch.js still measures the strip's box to dock the toasts. The
     way back out is Settings, which the pause menu opens — Esc on a
     keyboard, the gear on the pad, both untouched by this.

     ON TOUCH THERE IS A SECOND STAGE, and it rides this switch rather
     than owning one of its own: after a few seconds with no character
     movement the thumbstick and the whole .w-acts cluster fade out too,
     and a double tap anywhere brings them back. Adjusting the camera
     neither wakes them nor resets the clock — that is the point of it.
     It lives entirely in src/ui/touch.js (which polls `api.hideUI`
     every frame, so turning this off restores everything), and nothing
     of it exists on a desktop. */
  let hideUI = false;
  const setHideUI = (on) => {
    hideUI = !!on;
    uiRoot.classList.toggle('w-hide-ui', hideUI);
    ovRoot.classList.toggle('w-hide-ui', hideUI);
    const s = ctx.game?.state?.settings;
    if (s) s.hideUI = hideUI;
  };

  /* ------------------------------------------------------------
     SAYING SOMETHING TO THE PLAYER

     Every route ends in notify.js, which draws above the modal stack
     and counts its dismissal clocks only while the layer is actually
     being looked at. Nothing here writes into #ui any more.
     ------------------------------------------------------------ */
  const toast = (text, kind = 'info') => { notify.toast(text, kind); return api; };

  /* THE TITLE CARD IS NOT ALWAYS THE RIGHT SHAPE.

     hud.banner() is a 20 px letterspaced card at 14vh, inside #ui —
     which is under the scrim. Fired while a sheet is open it used to
     be invisible AND still time out. Showing it on top instead would
     be worse: a full-width title slab over the card the player is
     reading. So a banner raised while anything modal is open becomes
     an achievement plaque carrying the same two lines, in the band
     that exists for exactly this, and the title card is kept for the
     moments it was designed for — an empty screen. */
  const banner = (title, sub) => {
    if (api.modal || dlg.isOpen) {
      notify.achievement({
        eyebrow: title, title: sub || String(title), icon: 'spark',
        kind: 'token', life: 7,
        /* state.js's mutate.banner() raises a note alongside every
           banner, worded `title · sub`. The plaque IS that sentence,
           so the receipt underneath it goes. */
        replaces: sub ? title + ' · ' + sub : String(title),
      });
      return api;
    }
    hud.banner(title, sub);
    sfx('chime');
    return api;
  };

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
    /** The notification centre. Above every panel; see notify.js. */
    notify,
    /** achievement({title, sub, eyebrow, icon, kind}) — the heavy tier. */
    achievement: (spec) => { notify.achievement(spec); return api; },
    /** Happy's ending. Opened by 'game:complete', never by a button. */
    ending,
    dialogue(spec) { return dlg.open(spec || sampleDialogue()); },
    prompt(text, worldPos, opts = {}) {
      if (!text) { hud.removePrompt(opts.id || 'ui'); return null; }
      return hud.addPrompt({
        id: opts.id || 'ui', text, pos: worldPos,
        /* `act` names what the chip is FOR and hud.js words it for the
           active input. `key` stays available for chips that are not
           keyboard keys at all — the race prints checkpoint numbers
           through it. */
        act: opts.act || 'interact', key: opts.key,
        sub: opts.sub, action: opts.action,
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
    /** Fade the top HUD clusters out (and back). Persists in settings. */
    setHideUI,

    /* --- touch --- */
    touch,
    /** Show/hide the thumbstick + action pad. Persists in settings. */
    setTouch(on) {
      touch.setEnabled(on);
      const s = ctx.game?.state?.settings;
      if (s) s.touch = !!on;
      return api;
    },

    /* --- landscape play (ui/orient.js) --- */
    /** mode / handheld / status() / onChange() — what this browser
        can honestly promise about holding the phone sideways. */
    orient,
    /** Flip the optional landscape lock. Persists in settings.
        MUST be reached synchronously from a user gesture: fullscreen
        and the orientation lock are both gated on user activation,
        and one yield in front of this call loses both. Returns the
        promise so a tool can await the real outcome. */
    setLandscape(on) { return orient.setEnabled(on); },
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
      /* Also before it, and for the same reason inverted: the
         notification layer is NOT inside #ui, so it has to be told
         when the interface is away. It stops its clocks itself. */
      notify.update(dt);
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
      hud.dispose(); dlg.dispose(); phone.dispose(); touch.dispose(); orient.dispose();
      notify.dispose(); ending.dispose();
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
    /* touch.js reads this to decide where the toasts dock */
    hideUI: { get: () => hideUI, enumerable: true },
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
  on('msg', (m) => toast('Message from ' + m.from, 'token'));
  on('tip', (t) => api.dialogue({ speaker: t.title, role: 'A note for you', text: t.text, portrait: 'wally' }));

  /* QUESTS ARE THE ACHIEVEMENT TIER.
     quests.js fires a plain note AND a 'quest' event for one act, so
     `replaces` drops the toast wherever it is — queued or already on
     screen — and the plaque carries the moment instead. A milestone
     is not doubled here: it already raises its own banner through
     mutate.banner(), which becomes a plaque by itself whenever
     anything modal is open. */
  on('quest', (q) => {
    if (!q) return;
    if (q.kind === 'complete') {
      sfx('quest.done');
      notify.achievement({
        eyebrow: 'Quest complete', title: q.title, icon: 'trophy',
        kind: 'token', sound: null, replaces: q.title,
      });
    } else if (q.kind === 'side:complete') {
      notify.achievement({
        eyebrow: 'Favour returned', title: q.title, icon: 'check',
        kind: 'good', sub: q.from ? 'for ' + q.from : '',
        sound: 'quest.done', replaces: q.title,
      });
    } else if (q.kind === 'side:start') {
      notify.promote(q.title);
      toast('New: ' + q.title, 'token');
    } else if (q.kind === 'milestone') {
      sfx('fanfare');
    }
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

  /* A ROUTED leg is not a journey the UI has to stage — it is a heading.
     travel() emits 'route' instead of 'travel' for the four self-powered
     modes, and without this the arrow only ever aims when the player goes
     through the travel board: game.travel(x, 'walk') called from anywhere
     else would mount the ride and point at nothing. */
  on('route', (r) => {
    if (r && r.kind === 'set' && r.to) setDestination(r.to);
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
  /* ============================================================
     THE TWO ENDINGS (quests.js)

     'city:tokenized'  all 69 assets carry a token. It can land with
                       quests still open — q_city is the 23rd of 24 —
                       so it is a celebration, not an ending. The
                       milestone table already raises the 100 %
                       banner; this adds the plaque that says which
                       69 and how far that is.
     'game:complete'   EVERYTHING is finished. Happy turns up and
                       says the last line in the game. See ending.js.

     The old 'endgame' listener lived here and put two placeholder
     lines from "The City" into an ordinary dialogue card — the same
     box a shopkeeper uses, and wired to the 100 % event rather than
     to completion. Both halves of that are now fixed; 'endgame' is
     left alone deliberately, because quests.js still emits it as a
     legacy alias of 'city:tokenized' and listening to both would
     celebrate the same moment twice.
     ============================================================ */
  on('city:tokenized', (p) => {
    sfx('fanfare');
    notify.achievement({
      eyebrow: 'The whole city',
      title: (p?.total || 69) + ' of ' + (p?.total || 69) + ' assets tokenized',
      sub: 'Every field, every seam, every seat in that stadium.',
      icon: 'city', kind: 'token', life: 9, sound: null,
    });
    hud.refresh(true);
  });
  on('game:complete', (p) => { ending.open(p || {}); });
  on('ready:game', () => {
    hud.refresh(true);
    const st = ctx.game?.state;
    if (st && !st.flags.readMentor && !ctx.flags?.shot) {
      setTimeout(() => toast('Your phone buzzed. '
        + actionPhrase('phone', { cap: true }) + '.', 'token'), 1400);
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
    setHideUI(!!S.hideUI);
  }
  /* Thumbstick + action pad, on a phone only. touch.js also arms a
     one-shot touchstart listener, so a hybrid laptop grows controls
     the moment a finger lands on it and never before. */
  if (shouldEnable(ctx)) touch.setEnabled(true);
  /* Landscape play, if the player left it on last time. An
     orientation lock cannot be retaken without a gesture, so this
     arms one rather than pretending; see ui/orient.js boot(). */
  orient.boot();
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
      act: 'interact',
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
    /* `jump` carries the OWNING CONTACT as well as the held flag: with
       two thumbs on Jump the flag alone cannot tell "he let go" from
       "the wrong finger let go for him". See PAD-31 in touchtest.mjs. */
    d.touchState = () => ({ enabled: touch.enabled, active: touch.active,
      ...touch.axes, jump: touch.jump });
    /** WHY THE LAST interact() DID WHAT IT DID. The pad's Enter, the
        keyboard's E and an assistive-technology activation all land on
        the same function, and two of its paths do nothing visible on
        purpose — so "nothing happened" needs a reason attached or a
        broken input path looks exactly like a correct refusal. See the
        block above interact() and A REFUSAL HAS TO SAY WHY in hud.js. */
    d.interact = () => lastInteract;
    /** WHO OWNS THE NEXT SPACE. The pad's shortcuts answer a detail-0
        click so a keyboard or screen-reader player can activate them,
        and that inference goes stale the moment the player picks the
        game up and drives it with their thumbs -- focus does not move,
        because nothing on the pad is allowed to take it away. Reads
        `driving` (the player is on their thumbs), where the keyboard's
        bookmark actually sits, and the one sentence that matters:
        would a Space fire the focused button or reach the game? See
        THE FOCUS OUTLIVES THE MODALITY in src/ui/touch.js and PAD-35..
        PAD-37 in tools/touchtest.mjs. */
    d.padKeyboard = () => touch.keyboard;
    /** HOW THE LAST SHEET HAND-BACK WENT — `to` the element it aimed
        at, `attempts` how many frames it took (the pad is display:none
        the instant a sheet closes, so a real close is always > 1),
        `landed` whether focus() was finally called, and `signed`
        whether that landing attempt announced itself to the pad. The
        signature has to be applied PER ATTEMPT; without `attempts` a
        test cannot tell a retry that was signed from a page where the
        retry never happened. See PANEL-7 in tools/touchtest.mjs. */
    d.focusRestore = () => (lastRestore ? { ...lastRestore } : null);
    /** THE SIGNATURE, REACHABLE ON ITS OWN. The end-to-end path
        (PANEL-7) proves the fix as the player meets it, but it cannot
        reach the three BOUNDS on the signature — element identity,
        single use, and the 50 ms deadline — because a real close never
        misses on all six frames. Those bounds are the difference
        between a fix and a pad that has gone deaf to a genuine focus,
        so PAD-41c..PAD-41e drive them directly through here. Debug
        only; nothing ships through this. */
    d.padSignFocus = (el) => touch.uiWillFocus(el);
    /** Turn the lostpointercapture re-take off, restoring the old
        "a capture loss is a release" behaviour, so tools/touchtest.mjs
        can measure the dead-drag rate before and after on ONE page at
        ONE load. Debug only; shipping value is on. */
    d.padCaptureRetry = (on = true) => touch.setCaptureRetry(on);
    /** Hide UI, for the screenshots and tools/touchtest.mjs. */
    d.hideUI = (on = true) => { setHideUI(!!on); return hideUI; };
    /** HIDE UI STAGE TWO — the idle auto-hide clock (src/ui/touch.js).
        `d.idle()` reads it; `d.idle(sec)` shortens the window so a test
        can drive every branch without waiting five seconds a time.
        `d.idle(null)` puts the shipping value back. */
    d.idle = (sec) => {
      if (sec !== undefined) touch.setIdleDelay(sec);
      return touch.idle;
    };
    /** What the top clusters and the kept layers are actually doing. */
    d.uiLayers = () => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          vis: cs.visibility, op: +(+cs.opacity).toFixed(2), disp: cs.display,
          /* the honest question: could a finger reach it? */
          hit: cs.visibility === 'visible' && cs.display !== 'none' && +cs.opacity > 0.02
            && r.width > 0 && r.height > 0,
        };
      };
      return {
        hideUI,
        barLeft: box('.w-bar.left'), barRight: box('.w-bar.right'),
        stick: box('.w-stickzone'), acts: box('.w-acts'),
        act: box('.w-abtn.act'), jump: box('.w-abtn.jump'),
        toasts: box('.w-toasts'), prompt: box('.w-promptlayer'),
        hints: box('.w-hints'), race: box('.w-race'),
        /* stage two: the faded bottom cluster and the one mark that
           survives it. `idle` is the clock that drives them. */
        seam: box('.w-idleseam'), idle: touch.idle,
      };
    };
    /* --- landscape play, for the verifier and tools/shot.mjs ---
       Drives exactly the path the switch drives, minus the finger.
       Returns the PROMISE so the harness sees the real outcome:
       headless Chrome refuses both fullscreen and the lock, and
       `{locked:false, why:'nofullscreen'}` is the honest answer the
       settings row then has to print. */
    d.landscape = (on) => (on === undefined
      ? Promise.resolve(orient.status())
      : api.setLandscape(on).then(() => orient.status()));
    /** The capability report, with nothing changed. */
    d.orient = () => orient.status();
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

    /* ============================================================
       THE NOTIFICATION LAYER, AND THE CASE IT EXISTS FOR

       achievementOverModal(what) opens the panels that used to bury
       a notification and then fires one on top of them:

         'phone'     the phone
         'dialogue'  a speaker card
         'stack'     two sheets, one over the other
         'all'       two sheets AND a dialogue (the default)
         'none'      nothing open, the plain HUD case

       It then FREEZES the dismissal clock, because the screenshot
       harness waits 12 s between the --eval and the shutter and the
       point of the shot is what the player sees, not what is left of
       it twelve seconds later. Freezing is the same code path the
       layer uses whenever it is obscured.
       ============================================================ */
    d.achievementOverModal = (what = 'all') => {
      api.setVisible(true);
      closeAll();
      dlg.close(null);
      notify.clear();
      notify.freeze(false);
      if (what === 'phone' || what === 'all') openPhone(null);
      if (what === 'stack' || what === 'all') {
        pushSheet(menus.travel('trunkdepot'));
        openPlace('bazaar');
      }
      if (what === 'dialogue' || what === 'all') api.dialogue(sampleDialogue());
      notify.achievement({
        eyebrow: 'Quest complete', title: 'Tokenize the Strawberry Field',
        sub: '3% of the city is connected', icon: 'trophy', kind: 'token',
      });
      toast('+$1,240 · Mabel paid up', 'money');
      toast('Discovered Wally Tower', 'token');
      toast('Reputation 74 · the Exchange is watching', 'info');
      /* one frame to lay it out, then stop the clock where it stands */
      notify.update(0);
      setTimeout(() => notify.freeze(true), 900);
      return { open: api.panels, dialogue: dlg.isOpen, notify: notify.state() };
    };
    d.uiAchievement = (title, sub) => {
      notify.achievement({ title: title || 'Tokenize the Strawberry Field', sub });
      return notify.state();
    };
    d.notify = () => notify.state();
    d.notifyFreeze = (on) => notify.freeze(on !== false);
    d.notifyClear = () => { notify.clear(); return notify.state(); };

    /* ---- HAPPY'S ENDING ----
       ending() finishes the game FOR REAL — every asset tokenized,
       every main quest, every side quest — so quests.js fires
       'game:complete' through its own gate and the card is filled
       from the true payload rather than from a fixture. */
    d.ending = () => {
      api.setVisible(true);
      closeAll();
      dlg.close(null);
      const c = ctx.game?.debug?.completeGame?.();
      if (!ending.isOpen) ctx.game?.debug?.fireComplete?.(true);
      return { open: ending.isOpen, complete: c?.complete, links: ending.links() };
    };
    /** Pose the card from the data table alone — no state change. */
    d.endingCard = () => {
      const d2 = ctx.game?.data?.happyEnding || {};
      ending.close();
      ending.open({ ...d2, day: ctx.game?.state?.day });
      return ending.links();
    };
    d.endingClose = () => ending.close();
    /** What the verifier asserts: the anchors, and the line verbatim. */
    d.endingLinks = () => ({
      open: ending.isOpen,
      links: ending.links(),
      spoken: ending.spoken(),
      verbatim: ending.spoken() === (ctx.game?.data?.happyEnding?.text || ''),
    });
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
