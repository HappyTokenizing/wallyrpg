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
import { kb } from './kbowner.js';
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
      && kb.canFocus(el) && el.getClientRects().length > 0;
  }
  /** Whoever had the keyboard when the modal stack last left empty. */
  let focusReturn = null;

  /* ============================================================
     AND THE SIGNATURE HAD A SECOND CLAUSE IT NEVER SAID: A TAB
     PRESSED INSIDE THE HAND-BACK'S OWN RETRY WINDOW WAS EATEN.

     THE REGRESSION THE FIX ABOVE INTRODUCED, measured as an A/B on one
     page, one load, alternating arms, sixteen gestures each, identical
     finger events throughout — thumb Jump, thumb Menu, thumb Resume —
     with one Tab on the closing lift (tools/_r9e.mjs; my run, load
     4.84 at boot / 6.12 at end, 10 cpus):

       signature ON  (shipping)  ->  DEAF 9 of 16
       signature OFF (pre-fix)   ->  DEAF 0 of 16

     DEAF means the player pressed Tab, the focus ring ends on Menu,
     and the pad still refuses the key. The ledger shows a 7-10 ms race
     between two focus moves:

       DEAF  the panel's focusin, then TAB at +2 ms landing inside the
             ALREADY-CLOSING panel, then the signed hand-back at +8 ms
             overwriting it
       OK    the panel's focusin, the signed hand-back at +7 ms, then
             TAB at +8 ms moving Menu -> Jump INSIDE the pad, where the
             pad's own focusin rule sees it and hands the keyboard back

     When the Tab loses the race it lands inside a panel that has
     already closed — outside the pad's root — so the pad's focusin
     rule never sees it at all. The hand-back then overwrites that
     focus, and its signature keeps `driving` alive across the
     overwrite. The Tab is lost TWICE: its focus move is undone AND its
     meaning is discarded. Before the fix, the restore's own unsigned
     focusin cleared the flag and ACCIDENTALLY RESCUED the Tab; the fix
     removed the accident without replacing it.

     THE DIAGNOSIS NAMES THE FIX. The signature is honest about "I
     performed this focus" and silent about "and I am overwriting one
     the player performed 6 ms ago". So the hand-back must know whether
     the focus it is about to replace is still the one the close left
     behind. It is, in one line: remember the focus AT THE MOMENT THE
     CLOSE BEGAN, and compare it at the attempt that lands.

       still there  -> this is a faithful RESTORE. Sign it.
       moved        -> this is an OVERWRITE of somebody else's focus,
                       and on this path that somebody is the player.
                       Restore the position, WITHHOLD THE SIGNATURE.

     THE FOCUS IS STILL RESTORED, AND THAT IS THE WHOLE POINT OF
     PICKING THIS ONE. The pad then sees an ordinary unsigned focusin
     on a pad button and clears `driving` exactly as it does for any
     player focus — so the Tab keeps its MEANING, and the player keeps
     a real place in the document instead of one inside a node that is
     about to be removed.

     WHAT I REJECTED, AND I MEASURED BOTH RATHER THAN ARGUING THEM.
     `WALLY.debug.padHandBackYield(mode)` runs all three arms on ONE
     page at ONE load; the numbers are in tools/touchtest.mjs at
     PANEL-8.

       'all' — YIELD THE HAND-BACK ENTIRELY when the focus changed
         after the close began. It does not even fix the symptom: the
         Tab landed in the DYING panel, so abandoning the restore
         leaves the keyboard in a node that is removed 300 ms later and
         focus drops to <body>. No pad focusin ever happens, `driving`
         stays true — still DEAF — and now the player has lost their
         place in the document as well, which is the PANEL-1 defect the
         hand-back exists to repair. It trades a lost keystroke for a
         lost position and keeps the lost keystroke. Three arms, one
         page, one load, twelve gestures each (my run, load 5.28 at
         boot / 6.69 at end, 10 cpus):

           'sign'  DEAF  0/12   keyboard left on <body>  0/12
           'none'  DEAF  3/12   keyboard left on <body>  0/12
           'all'   DEAF  8/12   keyboard left on <body>  8/12

       'sign' — what ships. See above.

       ADOPT THE FOCUS INSIDE THE CLOSING PANEL as a player action and
         let it stand. Same end state as 'all' — the panel is going
         away — plus it would have to widen the pad's focusin rule
         beyond its own root so touch.js could see focuses landing in
         panels, which puts panel knowledge in the pad and gives every
         focus anywhere in the document a say in `driving`. A bigger
         blast radius to reach a worse outcome.

     IT CANNOT BE DEFEATED BY THE RETRY, which is the trap the first
     fix fell into and the reason the shape here is deliberate. The
     baseline is captured ONCE, at the moment the close began; the
     COMPARISON runs on EVERY attempt, next to the signature it
     governs. Recapturing the baseline per attempt would be the same
     class of mistake in reverse — attempt N's baseline would already
     contain the player's Tab, the focus would always look unmoved,
     and the check would be decorative. Asserted as PANEL-8b, which
     lands the Tab BETWEEN attempts of a real, multi-attempt close.

     <body> IS NOT A PLAYER MOVE, and this is the one line that keeps
     the cure off the disease. Focus reverting to <body> is focus being
     DROPPED — the panel node went, or the pad is still display:none —
     and that is the exact condition the hand-back was written for. If
     a bare <body> counted as "somebody moved it", every hand-back
     would go unsigned and PANEL-7 would be back within a week. Only a
     real, different, live element counts. Asserted as PANEL-8c.

     THE RESIDUAL, STATED PLAINLY — AND IT WAS WRONG, WHICH IS WHY
     ROUND 6 EXISTS. It used to read: "any OTHER focus() in this layer
     that landed inside a hand-back's six-frame window would also cost
     the signature. There are exactly two, both aimed at an <input>
     inside an open sheet (openQuickBuy here, the Clear button in
     menus.js), and both are outside the pad."

     THERE ARE FOUR, and the residual found two because it went
     looking for `.focus(`:

       src/ui/ui.js        openQuickBuy         el?.…?.('input')?.focus()
       src/ui/menus.js     Clear button         input.focus()
       src/ui/dialogue.js  showChoices          firstChild?.focus?.()
       src/main.js         ask (the boot chip)  goEl?.focus?.()

     The last two are optional-chained, and one of them is not in this
     layer at all. The dialogue one was live: a dialogue with choices
     opening inside a hand-back's window cost the signature 3 of 3 and
     put defect 3 back for a thumb-only player.

     "Both are outside the pad, so the competing focus really is the
     player's" was the false step, and it is false in general and not
     just by two call sites. A focus THIS CODEBASE PERFORMS is never
     the player, wherever it lands.

     So the residual is closed rather than restated. src/ui/kbowner.js
     owns the answer, every one of the four declares its intent to it,
     and the enumeration is asserted two ways — KB-3 reads every file
     in src/ off disk and fails on a `focus` member anywhere but
     kbowner.js, and KB-4 wraps the DISPATCH so an alias or a computed
     access cannot hide either. PANEL-9 still holds the containment
     line, which is now a second belt rather than the whole brace.
     ============================================================ */
  /** Debug switch only — 'sign' ships. 'none' is the pre-fix
      behaviour (always sign), 'all' the rejected yield-entirely. */
  let yieldMode = 'sign';
  /* ============================================================
     THE TWO REVERT SWITCHES, AND THEY ARE ONE PER NEW BEHAVIOUR.

     Round 5 shipped a hand-back that was right about the race and
     wrong about two things it had no way to see. Each is backed out
     independently here, so "the new assertions fail when the change
     is removed" is a measurement on ONE page at ONE load rather than
     a git stash and a hope. Both ship at their first value.

       whoMode  'owner'   who moved the focus is asked of
                          src/ui/kbowner.js: an arrival it did not
                          AUTHORISE is the player's.
                'active'  round 5: compare document.activeElement
                          against the baseline. Cannot tell a
                          dialogue opening inside the window from a
                          player pressing Tab, which is defect 6b.

       keepMode 'survivor' when the player HAS moved and their
                          destination is a live node that will
                          outlive this close, the hand-back leaves
                          them there. Their keystroke keeps its
                          destination as well as its meaning.
                'never'   round 5: always restore the position and
                          only ever yield the SIGNATURE. Takes a
                          Shift-Tab's destination away, which is
                          defect 6a and which this file's own notes
                          call a worse failure than the bug.

     These are NOT the same axis as yieldMode. yieldMode is round 5's
     three-arm A/B and its numbers are quoted above; it is kept
     untouched so PANEL-8/8d still mean what they meant. */
  let whoMode = 'owner';
  let keepMode = 'survivor';
  /** Debug switch only — extra no-op attempts before the hand-back is
      allowed to land, so a test can put a real Tab INSIDE the retry
      window instead of racing it. Ships at 0. See the note on
      d.padHandBackStall. */
  let stallFrames = 0;
  /** Has somebody OTHER than this hand-back taken the keyboard since
      the close began? A real, live, different element only — <body>
      is focus dropped, not focus moved, and dropped focus is the
      thing we are here to repair. */
  function focusMovedSince(from) {
    const a = document.activeElement;
    if (!a || a === document.body) return false;
    return a !== from;
  }

  /* ============================================================
     THE TWO HOLES ROUND 5 LEFT, AND WHY THEY ARE THE SAME HOLE.

     6a  A Shift-Tab pressed on the closing lift lands on a LIVE
         element OUTSIDE the closing panel — the pad sits BEFORE the
         panel layer in the DOM, and every assertion in the suite
         pressed Tab FORWARD, which is why nobody had been there. The
         hand-back saw "the focus moved", withheld its signature, and
         then restored the position anyway — taking the destination
         away. 5 of 5 at zero offset. The keystroke kept its MEANING
         and lost its DESTINATION, which is the same class of failure
         as blur() and is rejected in this file in about twenty lines.

     6b  A dialogue with choices opening inside the retry window
         focuses its first choice. focusMovedSince() cannot tell that
         from a player pressing Tab, so the hand-back went unsigned,
         the pad read an ordinary player focus on a pad button, and
         defect 3 came back for a player who has never touched a
         keyboard. 3 of 3.

     BOTH ARE ONE QUESTION THE OLD CODE COULD NOT ASK: who moved it.
     `document.activeElement` records WHERE the keyboard is and
     nothing at all about WHO put it there, and the whole of round 5
     is an attempt to recover the second from the first. It cannot be
     done — a script focus()'s focusin is isTrusted TRUE, byte
     identical to a real Tab (measured), and a screen reader's rotor
     moves focus with no DOM input event whatsoever.

     So the question is asked of the owner instead. kb.mark() takes a
     token when the close begins; kb.movedSince(token) answers with
     the element the PLAYER moved to, counting only arrivals kbowner
     did not authorise. A dialogue's focus is authorised and does not
     count. A Shift-Tab is not and does.

     AND THEN THE SECOND HALF, WHICH IS WHAT TO DO ABOUT IT. Round 5
     measured that yielding the hand-back ENTIRELY is worse than the
     bug (8/12 DEAF, 8/12 left on <body>) and it was right — but it
     measured a Tab that landed INSIDE THE DYING PANEL, where there
     is nothing to yield TO. That is not the same case as a Shift-Tab
     landing on a live pad button, and treating them the same is what
     6a is:

       destination will SURVIVE this close   -> LEAVE THEM THERE.
         The player chose a real place and it is still going to be
         there. Restoring over it is a hidden focus teleport, which
         is the thing this design exists not to do.
       destination is DYING (inside the closing panel, or already
       detached, or focus dropped to <body>)  -> restore the position
         and ADOPT it: the move was the player's, so the arrival is
         declared to the owner as theirs and the keystroke keeps its
         meaning. This is round 5's unsigned restore, stated as an
         intent instead of as the absence of one.

     Asserted as KB-10 (6a closed, both Tab directions), KB-11 (6b
     closed), KB-12 (the dying destination is still restored, so
     PANEL-8 is not being deleted), and KB-13, which drives the same
     gestures with a Tab that CANNOT reach a survivor and asserts the
     yield count is ZERO — a guard that a reader can use to tell a
     real green from a blind probe.
     ============================================================ */
  /** Will `el` still be a place the player can stand once this close
      has finished? */
  function survives(el, doomed) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;
    if (el === document.body || el === document.documentElement) return false;
    if (doomed) for (const d of doomed) { if (d && (d === el || d.contains(el))) return false; }
    /* focusable() is the same test the hand-back applies to its own
       target, so "somewhere the player can stand" means one thing in
       this file and not two. */
    return focusable(el);
  }
  /** Who moved the keyboard since the close began, and where to.
      One question, two implementations, and the second one is only
      here so backing the first one out is a switch and not a diff. */
  function playerMovedSince(token, from) {
    if (whoMode === 'active') {
      const moved = focusMovedSince(from);
      return { moved, to: moved ? document.activeElement : null };
    }
    return kb.movedSince(token);
  }
  /** Give `el` the keyboard as soon as it can hold it. A few frames,
      then give up — see the note above. */
  let lastRestore = null;          // debug: how the last hand-back went
  /** @param kind    'take' -- a panel just opened and wants the
      keyboard; 'restore' -- a panel just closed and is giving the
      player their place back. Only a RESTORE can yield, because only
      a restore can be racing the player.
      @param doomed  the nodes this close is removing, so the yield
      can tell a destination that will survive from one that will
      not. */
  function handBack(el, kind = 'restore', doomed = null) {
    if (!el) return;
    /* THE ATTEMPT COUNT IS NOT DECORATION. The retry below is the part
       of this that a signature applied in the wrong place would slip
       through, so the suite has to be able to see that a real close
       really did take more than one frame — otherwise PANEL-7 would be
       green on a page where the pad happened to be visible already and
       the retry branch was never entered at all. */
    /* SAMPLED HERE AND NOWHERE ELSE. This is the moment the close
       began; every attempt compares against it. */
    const from = (typeof document !== 'undefined') ? document.activeElement : null;
    /* THE OWNER'S BASELINE, taken at the same instant and for the
       same reason. `from` is kept beside it because whoMode:'active'
       is the revert arm and has to be able to run. */
    const token = kb.mark();
    const rec = lastRestore = {
      kind,
      to: el.getAttribute?.('aria-label') || el.className || el.tagName,
      from: from && from !== document.body
        ? (from.getAttribute?.('aria-label') || from.className || from.tagName)
        : null,
      attempts: 0, landed: false, signed: false, moved: false, movedTo: null,
      yielded: false, mode: yieldMode, who: whoMode, keep: keepMode,
      site: null, kept: false, survivor: null,
    };
    rec.stall = stallFrames;
    attemptHandBack(el, 6 + stallFrames, rec, from, token, doomed, kind, stallFrames);
  }
  function attemptHandBack(el, tries, rec, from, token, doomed, kind, stall) {
    rec.attempts++;
    /* THE WINDOW, HELD OPEN ON PURPOSE — debug only, 0 in shipping.
       It moves WHEN the landing attempt happens and touches none of
       the logic below it, which is the whole reason it is a legitimate
       way to test that logic: the baseline is still sampled once at
       the close, the comparison still runs at the attempt that lands,
       and a Tab pressed at frame three of nine is exactly the case
       PANEL-8b has to be able to reach without racing the machine. */
    if (stall > 0) {
      requestAnimationFrame(() => attemptHandBack(el, tries - 1, rec, from, token, doomed, kind, stall - 1));
      return;
    }
    if (focusable(el)) {
      /* THE SECOND CLAUSE, EVALUATED AT THE ATTEMPT THAT LANDS — see
         AND THE SIGNATURE HAD A SECOND CLAUSE above. Read live, so a
         Tab that arrives at attempt three is seen by attempt four. */
      const who = (kind === 'restore' && yieldMode !== 'none')
        ? playerMovedSince(token, from) : { moved: false, to: null };
      const moved = who.moved;
      if (moved) {
        const a = who.to || document.activeElement;
        rec.moved = true;
        rec.movedTo = a?.getAttribute?.('aria-label') || a?.className || a?.tagName || null;
      }
      /* ============================================================
         6a, CLOSED. The player moved the keyboard themselves and the
         place they moved it to is going to be there after this close
         finishes. Restoring over it would undo a move they made on
         purpose — a hidden focus teleport, announced by a screen
         reader as a context change, and the exact failure blur() was
         rejected for. LEAVE IT.

         This is NOT the 'all' arm round 5 measured and rejected.
         That arm abandoned the restore whether or not there was
         anywhere to abandon it TO, which on a Tab into the dying
         panel left the player on <body> with the keystroke still
         lost. The survivor test is the difference, and KB-13 drives
         the same gestures with no survivor available and asserts
         this branch is taken zero times. */
      if (moved && keepMode === 'survivor' && survives(who.to, doomed)) {
        rec.kept = true;
        rec.survivor = rec.movedTo;
        return;
      }
      if (moved && yieldMode === 'all') {
        /* THE REJECTED ARM, kept only so the A/B can run on one page:
           abandoning the restore leaves the keyboard in the dying
           panel and the player with no place at all. */
        rec.yielded = true;
        return;
      }
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
         leave the attempt that lands unsigned.

         ...AND ONLY WHEN IT IS STILL A RESTORE. `moved` means the
         focus this is about to replace is not the one the close left
         behind — on this path, the player's Tab, 6 ms old, landed in
         the closing panel where the pad could not see it. The position
         is still handed back; the signature is withheld, so the pad
         reads the landing as the ordinary player focus it now stands
         for and the Tab keeps its meaning. */
      /* THE INTENT, DECLARED — see THE THREE INTENTS in
         src/ui/kbowner.js. Three sites, one call, and which one it is
         is decided HERE, at the attempt that lands, for exactly the
         reason the old signature had to be applied per attempt: this
         function re-enters itself on rAF for up to six frames because
         the pad is display:none the instant a sheet closes and
         focus() on it is a silent no-op.

           panel.take     a panel opened and is taking the keyboard.
           panel.restore  a faithful hand-back. The player has not
                          moved, so this says nothing about who they
                          are talking to and the routing bit does not
                          move. (Round 5's "signed".)
           panel.adopt    the player DID move, and their destination
                          is dying. The position is handed back and
                          the arrival is declared as THEIRS, so the
                          keystroke keeps its meaning. (Round 5's
                          "unsigned", said out loud instead of by
                          omission.) */
      const site = kind === 'take' ? 'panel.take' : (moved ? 'panel.adopt' : 'panel.restore');
      rec.site = site;
      rec.signed = site === 'panel.restore';
      kb.focus(site, el, { preventScroll: true });
      rec.landed = true;
      return;
    }
    if (tries <= 0) return;
    requestAnimationFrame(() => attemptHandBack(el, tries - 1, rec, from, token, doomed, kind, 0));
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
    /* THE NODE THIS CLOSE IS TAKING AWAY. The hand-back needs it to
       tell a destination the player chose that will SURVIVE from one
       that will not — see THE TWO HOLES ROUND 5 LEFT. It is still in
       the document here (retire() gives it a 300 ms fade), so
       isConnected alone cannot answer. */
    const doomed = [el];
    const under = stack.length ? stack[stack.length - 1].el : null;
    if (under) { handBack(under, 'restore', doomed); return; }
    const back = focusReturn;
    focusReturn = null;
    /* `back` is null whenever nothing held the keyboard at the moment
       the stack opened — which is every session driven by a thumb,
       because a pad press deliberately never focuses. Then this does
       nothing, the node goes, and the browser drops focus to <body>:
       exactly where it went before any of this existed. No worse, and
       no teleport handed to a player who never asked for one. */
    if (back) handBack(back, 'restore', doomed);
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
    /* A TAKE, NOT A RESTORE, and saying so is not bookkeeping. An
       open cannot be racing the player's Tab against a closing
       panel, so it must never yield and must never adopt: the panel
       root gets the keyboard, full stop. Round 5 ran both through
       one unlabelled path and the yield logic applied to opens as
       well, which was harmless only because `from` was almost always
       the same element. */
    handBack(el, 'take', null);
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
    const doomed = stack.map((s) => s.el);
    while (stack.length) stack.pop().el.remove();
    const back = focusReturn;
    focusReturn = null;
    if (inside && back) handBack(back, 'restore', doomed);
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
    /* DECLARED, like every other focus move in src. It used to be a
       bare optional-chained focus() and it is one of the two that a
       grep for the method name did not find — round 5's residual
       counted the layer's other focus calls and said "exactly two"
       when there were four. */
    setTimeout(() => { kb.focus('sheet.input', el?.querySelector?.('input'), { preventScroll: true }); }, 80);
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
    /** THE YIELD RULE, AS AN A/B SWITCH — see AND THE SIGNATURE HAD A
        SECOND CLAUSE above. 'sign' ships: the hand-back restores the
        position but withholds its signature when the focus it is
        replacing is not the one the close left behind. 'none' is the
        pre-fix behaviour (sign unconditionally — the arm that eats a
        Tab pressed on the closing lift). 'all' is the rejected
        alternative: abandon the hand-back entirely, which loses the
        keystroke AND the player's place. Three arms on ONE page at ONE
        load is the only way this rate means anything; PANEL-8 drives
        it. Debug only; nothing ships through this. */
    d.padHandBackYield = (mode) => {
      if (mode === 'none' || mode === 'all' || mode === 'sign') yieldMode = mode;
      return yieldMode;
    };
    /** HOLD THE RETRY WINDOW OPEN — n extra no-op attempts before the
        hand-back may land. Debug only, 0 in shipping. The defect it
        exists to test is a 7-10 ms race, and a suite that has to WIN a
        race to enter a branch is a suite that goes green on a quiet
        box for no reason — the ninth instance of the same mistake on
        this project, waiting to happen. This widens the window instead
        of hoping for it, so a real dispatched Tab lands INSIDE it
        every time and the branch is entered deterministically. It
        changes only the timing of the landing attempt; the baseline is
        still sampled once when the close began and the comparison
        still runs at the attempt that lands, which is precisely the
        retry-proofing PANEL-8b asserts. */
    d.padHandBackStall = (n = 0) => { stallFrames = Math.max(0, Math.min(30, +n || 0)); return stallFrames; };
    /* ============================================================
       THE OWNER, REACHABLE FROM THE SUITE.

       PAD-41c..PAD-41e used to drive touch.uiWillFocus() directly to
       reach the signature's three bounds — element identity, single
       use, and the 50 ms deadline — because a real close never misses
       on all six frames. There is no signature any more and there are
       no bounds to reach: an authorisation is a call stack, so it
       cannot name the wrong element, be used twice, or expire. What
       replaces those three assertions is one that is strictly
       stronger and that they could not make: NOTHING IN src MOVES
       FOCUS WITHOUT DECLARING IT, and the register is complete.
       ============================================================ */
    /** The owner's whole state, including the violation ledger the
        registration assertion reads. `violations` empty, after the
        suite has driven every UI path in the game, IS the assertion. */
    d.kb = () => kb.report();
    /** Drive a declared focus by site id, so KB-3..KB-5 can reach the
        three intents without having to reproduce the gesture that
        normally produces each one. Debug only. */
    d.kbFocus = (site, sel) => {
      const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      return kb.focus(site, el, { preventScroll: true });
    };
    /** THE REGISTRATION ASSERTION, FROM THE INSIDE. Moves focus by a
        route that never touches kb.focus() and that a grep for the
        method name cannot see — computed member access through a
        string built at runtime. The guard must catch it anyway,
        because it wraps the DISPATCH. This is the revert check for
        the assertion itself: if _smuggle stops being recorded, the
        assertion has quietly become decorative. See KB-1b. */
    d.kbSmuggle = (sel) => {
      const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      const before = kb.report().violations.length;
      kb._smuggle(el);
      return { before, after: kb.report().violations.length };
    };
    d.kbReset = () => { kb._reset(); return kb.report(); };
    /** THE TWO REVERT SWITCHES — see the block above whoMode. Each
        backs out exactly one of round 6's two behaviours on ONE page
        at ONE load, so "the new assertions fail without the change"
        is a number. Debug only; nothing ships through these. */
    d.kbWho = (m) => { if (m === 'owner' || m === 'active') whoMode = m; return whoMode; };
    d.kbKeep = (m) => { if (m === 'survivor' || m === 'never') keepMode = m; return keepMode; };
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
