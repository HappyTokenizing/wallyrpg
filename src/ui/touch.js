/* ============================================================
   touch.js — the phone controls.

   THE BUG THIS FIXES: on a touch device there was no way to move.
   The only touch handling in the whole game was camera orbit, the
   intro skip and the audio unlock, and `settings.touch` was a flag
   nothing read. The game booted, rendered and could not be played.

   What this adds:

     · a FLOATING virtual thumbstick, bottom-left. It centres wherever
       the thumb lands inside its zone rather than at a fixed spot,
       which is the difference between a stick you can use without
       looking and one you keep missing. 12 % dead zone, full
       deflection at 40 % of the zone radius, analogue magnitude — a
       small push walks, a full push runs.

     · an ACTION PAD, bottom-right: jump, interact/confirm, and the
       four panel shortcuts the keyboard has (P / M / O / Esc). The
       HUD's key-cap row hides itself while this is up.

     · LOOK is not here — a one-finger drag outside this zone lands on
       the canvas and core/camera.js orbits with it, with momentum.
       The stick zone is a DOM element ON TOP of the canvas, so a thumb
       on the stick simply never reaches the camera's listeners.

     · HIDE UI, STAGE TWO. Inside the Hide UI comfort setting, and only
       on touch: after a few seconds with no CHARACTER MOVEMENT both of
       the above fade out as well, a double tap anywhere brings them
       back, and adjusting the camera does neither. See the block under
       the stick constants for every number and every gesture rule.

   HOW MOVEMENT REACHES THE CHARACTER: through the existing seam and
   nothing else. wally.js owns the input contract; we hand it a
   function returning the same { x, z, jump, jumpHeld, run } that
   defaultInput() builds, and we run our stick vector through
   `wally.camRelative()` — the one function that applies the camera
   basis — so touch and keyboard cannot disagree about which way is
   left. When the stick is at rest we return `wally.keyboardInput()`
   unchanged, so plugging a keyboard into a tablet still works.

   NOTHING HERE EXISTS ON A DESKTOP. The layer is only built after
   `shouldEnable()` says so — a coarse primary pointer with real touch
   points, a genuine first touchstart, `settings.touch`, or ?touch=1.
   ============================================================ */

import { clamp } from '../core/contracts.js';
import { h, icon } from './style.js';

/* stick shape — see ART_DIRECTION §4 for the speeds these map onto */
const DEAD = 0.12;          // ignore the first 12 % of the throw
const FULL = 0.40;          // full deflection at 40 % of the zone radius
const RUN_AT = 0.62;        // magnitude where walking becomes running
const SLIDE = 1.55;         // origin follows the thumb past this * R
const KNOB = 46;            // px

/* ============================================================
   HIDE UI, STAGE TWO — THE BOTTOM CONTROLS FADE WHEN HE STOPS
   ============================================================

   Hide UI (Settings › Comfort) already takes the two TOP clusters and
   deliberately keeps everything a player might need: the thumbstick,
   the whole .w-acts cluster, toasts, banners, prompts. Stage two exists
   only ON TOUCH and only INSIDE Hide UI: after a few seconds with no
   CHARACTER MOVEMENT the bottom controls fade out too, and a DOUBLE TAP
   anywhere brings them back. It rides the one switch — there is no
   second setting, because the player described it as part of Hide UI
   and a comfort mode with two switches is not a comfort mode.

   THE POINT OF THE FEATURE IS WHAT DOES *NOT* WAKE IT. Framing a shot
   is one-finger camera drag after one-finger camera drag, sometimes for
   a minute. That is exactly when a clean screen is wanted, so a camera
   drag is not activity, does not reset the clock and does not wake
   anything. Neither does a toast, a notification or a banner — those
   are the game talking, not the player moving.

   THE NUMBERS, and why each one is the number it is.

   IDLE_HIDE 5 s   Long enough that reading a toast, checking the
                   compass or just thinking does not strip the controls
                   out from under you; short enough that "I want a clean
                   screen" is satisfied by holding still. 3 s fires while
                   you are still deciding where to walk; 10 s is longer
                   than anyone holds a phone still on purpose.

   MOVE_EPS 0.12 m/s  Planar speed that counts as moving. Walk is 2.45
                   and the controller parks at 0 with the stick at rest,
                   so this only has to clear settle noise.

   TAP_MS 400 ms   A contact longer than this is a deliberate press-and-
                   hold, not a tap. NOT the discriminator — travel is —
                   and it was 220 ms until the harness proved that wrong:
                   real dispatched contacts in this game measure 110-220
                   ms on an idle machine and longer on a loaded one, so
                   220 was rejecting genuine taps. 400 ms sits just under
                   the platform long-press timeout (500 ms), which is the
                   only thing duration honestly needs to exclude, because
                   any gesture that is really a camera move fails the
                   travel gate first and fails it on its first move event.

   TAP_SLOP 12 px  How far one contact may travel and still be a tap.
                   THIS is the load-bearing rule. The camera steers at
                   0.0055 rad/px, so 12 px is 3.8 degrees — below the
                   threshold at which anybody would say they had adjusted
                   the camera. A drag worth the name is tens of pixels
                   and fails this on its first move event. Two quick taps
                   that each travelled under 12 px did not frame
                   anything, so calling them a double tap is correct.

   TAP_GAP 300 ms  Between tap one's release and tap two's landing. This
                   is the browser's own double-tap-to-zoom window — the
                   gesture we are taking over — so we win exactly where
                   the default would have fired, and a third tap 400 ms
                   later starts a new gesture instead of chaining.

   TAP_DIST 44 px  How far apart the two landings may be. 44 px is the
                   minimum touch target in this interface, so "the same
                   place" means "inside one fingertip".

   AND THE GATE THAT IS NOT COUNT-BASED. Each contact is judged on its
   own duration and travel BEFORE it is allowed to be tap one or tap two,
   and a contact that fails clears the pending tap outright. Two quick
   camera drag-taps therefore never accumulate — not because we counted
   them, but because neither of them was a tap.

   THAT SENTENCE USED TO BE FALSE FOR TAP TWO, and it was the headline
   bug of this feature. Recognition fired at POINTERDOWN, so TAP_MS and
   TAP_SLOP only ever reached contact one: stand still until the fade,
   tap once, then start a camera drag from the same spot, and the drag's
   bare touchStart woke everything before it had travelled a pixel — the
   one gesture the whole feature exists to ignore. A 1200 ms press-and-
   hold 20 ms after a tap woke it too, past a 400 ms gate written to
   exclude exactly that.

   WHY IT WAS AT POINTERDOWN, which is the tension the fix has to hold
   both sides of: the waking tap must not ALSO do something. Recognise
   at pointerdown and you can stop the contact dead before any handler
   sees it. Recognise at pointerup and you know whether it was a tap —
   but the target's own pointerdown has already run, and a wake tap
   landing on the hidden Enter button would walk the player into a
   building.

   PROVISIONAL SUPPRESSION, COMMITTED OR RELEASED AT POINTERUP. A
   contact that lands inside TAP_GAP and TAP_DIST of a completed tap one
   is a CANDIDATE, not a wake. Its pointerdown is eaten immediately
   (everywhere except the canvas, as before) so nothing downstream can
   act on it, and then it is judged like any other contact:

     · it travels past TAP_SLOP, or is held past TAP_MS
                    -> RELEASED. No wake, pending cleared, and every
                       event from the move onward flows normally: this
                       is a camera drag and it steers the camera with
                       the finger, which is finding one and a half
                       frames of a drag it never asked to own.
     · it lifts short and still
                    -> COMMITTED at pointerup: wake, eat the pointerup,
                       and arm the click swallow below.

   THE CLICK SWALLOW IS THE REAL BACKSTOP, not the pointerdown eat. A
   released candidate gave up its pointerdown and keeps everything else,
   which is safe because nothing this gesture can land on acts on
   pointerdown: while the controls are faded they are pointer-events:
   none, the canvas is deliberately let through, and a sheet turns the
   whole detector off (see idleSuspended below). What is left that could
   eat a wake tap — a toast, a notification, a card — fires on CLICK, and
   the commit arms a one-shot swallow that eats it at document capture.
   So the wake tap still reaches nothing, and it is now impossible for a
   drag to wake anything.

   IT USED TO BE A 500 ms WINDOW AND THAT WAS BLIND. It was armed on
   commit and closed only by a click actually arriving — but Chrome
   dispatches NO compatibility click for a contact inside a multi-touch
   sequence, and this file deliberately supports waking with a second
   finger while the first is still down. So that commit opened a window
   with nothing of its own to eat, and the NEXT honest press fell in.
   Measured with reduced motion on, which collapses the fade and exposes
   the whole window: wake with a second finger, then tap Phone 80 ms and
   250 ms later — both eaten, ui.openPhone 0, panels [].

   THERE IS NO WINDOW NOW. The swallow is a single flag, armed by a
   gesture this file has consumed and cancelled by the NEXT POINTERDOWN,
   because a click with a contact in front of it belongs to that contact
   and not to a gesture two gestures ago. It also never applies to an
   activation with detail 0, which by definition had no pointer sequence
   in front of it — that is a keyboard or a screen reader, and eating
   those is the second defect this round closed. See tapClick.

   THE COST, stated plainly: the wake lands on tap two's RELEASE rather
   than its landing, about 100-200 ms later than it used to. That is the
   price of judging the contact at all, and it is the same latency the
   platform's own double tap has always had.

   THE DETECTOR RUNS WHILE THE CONTROLS ARE STILL UP, and only the
   COMMIT is gated on them being hidden. It used to early-return unless
   already hidden, which lost the double tap that straddles the fade:
   tap one landing a moment before the controls went, tap two 200 ms
   later — inside every gate — and nothing woke, because tap one was
   never recorded. That is the worst possible moment to feel broken.

   MULTI-FINGER IS ALLOWED ON PURPOSE. Taps are tracked per pointerId, so
   a second finger double-tapping while the first is mid-drag still
   wakes; the brief requires there be no dead moment. Pinch-to-zoom
   survives because a pinch finger moves and is held, so it is never a
   tap.

   A TRANSPARENT CONTROL IS NOT PRESSABLE. The fade is 0.42 s and
   pointer-events used to return the instant the class flipped, so the
   third tap of a triple tap pressed a Jump button at opacity 0.0-0.9.
   Waking adds .w-idlewake, which keeps the cluster inert until the fade
   it can read off the CSS has actually finished. A control is live only
   at full opacity, in both directions.

   ...AND pointer-events COULD NOT ENFORCE THAT WHILE THE PAD LISTENED
   TO CLICK, which is the half that was missing for two rounds. It is a
   hit-test rule, and the compatibility click is hit-tested at DISPATCH —
   at the pointerUP — rather than inheriting the pointerdown's target. So
   a contact that landed while the cluster was inert and lifted after the
   fade had its click delivered straight into the button the same rule
   had just refused it: measured at the apartment door as ui.panels []
   -> ['place'] from a finger that never touched a live control. That
   needed a second, capture-phase gate keyed on WHERE THE CONTACT BEGAN.

   IT NEEDS NOTHING NOW, because the pad no longer listens to click at
   all — see THE PAD IS DRIVEN FROM POINTER EVENTS, above bindPress. The
   pointerdown obeyed pointer-events and the button never armed; the
   retargeted click carries detail 1 and every pad button accepts only
   detail 0. pointer-events is sufficient again because everything it
   governs now happens at pointerdown, which is the only moment it can
   honestly rule on.
   ============================================================ */
const IDLE_HIDE = 5.0;      // s of no character movement before the fade
const MOVE_EPS = 0.12;      // m/s of planar speed that counts as moving
const AIR_EPS = 0.6;        // m/s of vertical speed that counts as airborne
const TAP_MS = 400;         // ms; longer than this is a press-and-hold
const TAP_SLOP = 12;        // px one contact may travel and still be a tap
const TAP_GAP = 300;        // ms between tap one's release and tap two
const TAP_DIST = 44;        // px between the two landings

const _kb = { x: 0, z: 0, jump: false, jumpHeld: false, run: false };
const _sv = { x: 0, z: 0 };

/* ============================================================
   INPUT MODE, AND THE WORDS THAT DEPEND ON IT
   ============================================================

   THE BUG THIS CLOSES: half the interface printed keyboard keys at a
   player who had no keyboard. 'go inside — press E'. A keycap 'E' on
   every world prompt. 'E CONTINUE' on the dialogue card. 'Press P.'
   in a toast. A 'B' chip beside the money. Each one was its own
   string literal, which is why fixing them one at a time never held:
   the next prompt anybody wrote typed 'E' again.

   So there are no key literals left at the call sites. A call site
   names an ACTION and asks for its label; it gets back whatever that
   action is called on the input the player is actually holding. A new
   prompt is right by construction, and a wrong one is a test failure
   (tools/touchtest.mjs sweeps every visible string).

   HOW THE MODE IS DECIDED, and why it is one expression in one place.
   There were three capability tests in this file's neighbourhood at
   one point; they disagreed on a tablet and whichever ran last
   silently overwrote the other's label. There is now exactly one:

       matchMedia('(pointer: coarse)').matches
         && !matchMedia('(any-pointer: fine)').matches

   ...and even that is only the FALLBACK. `ui.touch.enabled` is the
   stronger signal and outranks it the moment the layer exists,
   because it already folds in ?touch=, the saved setting and the
   first genuine touchstart — and because the player can flip it in
   Settings › Touch controls. HYBRIDS ARE HONEST HERE: a tablet with a
   keyboard attached has both, and the switch is the tie-break.

   Which is why labels SUBSCRIBE (onInputMode) instead of being baked
   at boot. Flip the setting mid-session and every chip, prompt,
   caption and sentence repaints. */

/** THE capability test. One place, one expression, no second opinion. */
export function coarsePointer() {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
}

/* Every action the player can be TOLD to perform, and what it is
   called on each input. `key` is the keycap; `touch` is the on-screen
   control's own wording — taken from the pad below, so the button and
   the sentence pointing at it can never drift apart. */
export const ACTIONS = {
  /* the corner button: 'Enter / Talk' at rest, 'More' mid-conversation */
  interact: { key: 'E', touch: 'Enter', cap: 'Enter / Talk' },
  advance: { key: 'E', touch: 'More' },
  jump: { key: 'Space', touch: 'Jump' },
  phone: { key: 'P', touch: 'Phone' },
  places: { key: 'M', touch: 'Places' },
  desk: { key: 'O', touch: 'Desk' },
  menu: { key: 'Esc', touch: 'Menu' },
  buy: { key: 'B', touch: 'Buy' },
};

/* null = no layer has spoken yet, so the media query decides. */
let layerOn = null;
let modeWas = null;
const modeSubs = new Set();

/** Is the player driving this with a thumb? The one answer. */
export function touchUI() {
  return layerOn === null ? coarsePointer() : layerOn;
}

/** Repaint `fn(touch)` now, and again whenever the mode changes. */
export function onInputMode(fn) {
  modeSubs.add(fn);
  try { fn(touchUI()); } catch (e) { console.error('[ui] input-mode listener threw', e); }
  return () => modeSubs.delete(fn);
}

function publishMode() {
  const m = touchUI();
  if (m === modeWas) return;
  modeWas = m;
  for (const fn of [...modeSubs]) {
    try { fn(m); } catch (e) { console.error('[ui] input-mode listener threw', e); }
  }
}

/** 'E' on a keyboard, 'Enter' under a thumb. Never a literal. */
export function actionLabel(action) {
  const a = ACTIONS[action];
  if (!a) return '';
  return touchUI() ? a.touch : a.key;
}

/** The same thing inside a sentence: 'press E' / 'tap Enter'. */
export function actionPhrase(action, opts = {}) {
  const t = touchUI();
  const s = (t ? 'tap ' : 'press ') + actionLabel(action);
  return opts.cap ? s[0].toUpperCase() + s.slice(1) : s;
}

/* A KEYCAP IS A KEYBOARD AFFORDANCE. `.key` and `.kb` are drawn as a
   little square cap with a 2 px bottom edge — a picture of a physical
   key — so a touch label may not wear one. style.js belongs to
   somebody else, so the touch treatment is written as inline
   properties (which outrank the class) and cleared, not overwritten,
   on the way back to the keyboard. */
const CHIP_TOUCH = {
  display: 'inline', background: 'transparent', color: 'var(--w-token)',
  boxShadow: 'none', minWidth: '0', height: 'auto', padding: '0',
  borderRadius: '0', letterSpacing: '.09em', textTransform: 'uppercase',
  animation: 'none',
};

/**
 * Paint one chip for the active input mode.
 * `opts.hideOnTouch` drops it entirely — right wherever the chip is a
 * bare reminder sitting next to a control that already says the word.
 */
export function paintChip(el, action, opts = {}) {
  if (!el) return el;
  const t = touchUI();
  const gone = t && !!opts.hideOnTouch;
  for (const k in CHIP_TOUCH) el.style[k] = t ? CHIP_TOUCH[k] : '';
  el.style.display = gone ? 'none' : (t ? CHIP_TOUCH.display : '');
  el.classList.toggle('w-tapcap', t && !gone);
  const text = gone ? '' : (opts.text != null ? opts.text : actionLabel(action));
  if (el.textContent !== text) el.textContent = text;
  return el;
}

/** Would this device be better off with thumb controls? */
export function shouldEnable(ctx) {
  if (typeof window === 'undefined') return false;
  const q = new URLSearchParams(location.search).get('touch');
  if (q === '1' || q === 'on') return true;
  if (q === '0' || q === 'off') return false;
  if (ctx?.game?.state?.settings?.touch) return true;
  return coarsePointer();
}

export function createTouch(ctx, ui) {
  /* ------------------------------------------------------------
     DOM
     ------------------------------------------------------------ */
  const root = h('div.w-touch.hidden');

  const zone = h('div.w-stickzone', { 'aria-hidden': 'true' });
  const knob = h('div.knob');
  const ring = h('div.ring');
  const stickEl = h('div.w-stick', null, ring, knob,
    h('div.lbl', { text: 'move' }));
  for (let i = 0; i < 4; i++) {
    ring.append(h('div.tick', {
      style: { transform: `rotate(${i * 90}deg) translateY(calc(var(--w-sk) * -.5 + 7px))` },
    }));
  }
  zone.append(stickEl);

  const badge = h('span.badge', { text: '0', style: { display: 'none' } });
  const shortcuts = h('div.shortcuts');
  const SHORTCUTS = [
    { ic: 'phone', cap: 'Phone', run: () => ui.openPhone(), badge: true },
    { ic: 'map', cap: 'Places', run: () => ui.openPhone('places') },
    { ic: 'chart', cap: 'Desk', run: () => ui.openDesk() },
    { ic: 'gear', cap: 'Menu', run: () => ui.show('pause') },
  ];
  /* NO onclick. Every button in this cluster is driven from pointer
     events — see the block above bindPress — so the verbs are collected
     here and bound there, with the pad's state in scope. */
  const shortcutBtns = [];
  for (const s of SHORTCUTS) {
    const b = h('button.w-abtn.sm', { type: 'button', 'aria-label': s.cap }, icon(s.ic, 20));
    if (s.badge) b.append(badge);
    shortcuts.append(b);
    shortcutBtns.push([b, s]);
  }

  /* THE PAD, AND WHICH THUMB POSITION EACH BUTTON EARNS.

     The corner-most slot — bottom-right, where the thumb rests without
     reaching — belongs to ENTER, because Enter is what this game is
     made of: every door, desk, client, NPC and shop runs through it,
     and the whole prompt system exists to feed it. It is the big one.

     Jump sits UP AND LEFT of it, smaller: the same diagonal a thumb
     sweeps, so the two never share a landing zone at speed, and the
     one you press by accident is the incidental one. (This used to be
     the other way round — jump big in the corner — which put the
     game's main verb in the harder-to-reach seat.) */
  const actCap = h('span.cap.long', { text: ACTIONS.interact.cap });
  const actBtn = h('button.w-abtn.big.act.off', {
    type: 'button', 'aria-label': 'Enter or talk',
  }, icon('door', 27), actCap);
  const jumpBtn = h('button.w-abtn.mid.jump', {
    type: 'button', 'aria-label': 'Jump',
    /* NOT `w-up`: that class is the producer upgrade CARD (a 70% white
       slab with 12 px of padding, style.js), and the jump chevron has
       been quietly wearing it — which is why the arrow rendered as a
       pale filled disc. `w-rot90` belongs to nothing else. */
  }, icon('back', 24, { class: 'w-rot90' }), h('span.cap', { text: 'Jump' }));

  /* jump first => jump is the left/raised one, Enter holds the corner */
  const acts = h('div.w-acts', null, shortcuts, h('div.pad', null, jumpBtn, actBtn));

  /* THE QUIET AFFORDANCE, and why there is one at all.

     While the controls are faded the screen is empty, and a player who
     cannot work out why the elephant will not move is the whole failure
     mode of this feature. So exactly ONE mark survives: a 34x3 px
     hairline seam at the bottom centre at 16 % opacity, the shape of a
     home indicator, with no chrome, no blur, no caption and no pointer
     events. It is not a control and it is not the UI coming back — it
     is the smallest possible "something is here". On the FIRST fade of
     a session it lands at 50 % and decays to 16 % over 1.4 s, which
     teaches once and never again; reduced motion gets the resting value
     with no decay. A screenshot at 16 % opacity and 102 px^2 is still a
     clean screenshot. */
  const seam = h('div.w-idleseam', { 'aria-hidden': 'true' });
  root.append(zone, acts, seam);

  /* ------------------------------------------------------------
     state
     ------------------------------------------------------------ */
  let enabled = false;
  let armed = false;                     // canvas defaults suppressed
  const stick = { id: null, cx: 0, cy: 0, R: 40, t: 0, dx: 0, dz: 0, run: false };
  const home = { x: 80, y: 80 };
  let ringR = 67;
  let jumpHeld = false;
  let jumpId = null;                     // the ONE contact holding Jump
  let jumpKeyT = 0;                      // the keyboard/AT auto-release
  const off = [];                        // teardown

  /* ---- Hide UI stage two ---- */
  let idleDelay = IDLE_HIDE;             // seconds; tests shorten it
  let idleT = 0;                         // seconds of stillness banked
  let idleHidden = false;                // the bottom controls are faded out
  let idleWhy = 'off';                   // why the clock is where it is
  let wokeAt = 0;                        // how many double-tap wakes this session
  let seamTaught = false;                // the first fade gets the decay
  let liveTimer = 0;                     // the fade-in, after which controls are live
  let resumeSkip = false;                // first tick back from a backgrounded tab
  const pressing = new Map();            // pad button -> the pointerId holding it

  /* ------------------------------------------------------------
     geometry. The zone carries the safe-area insets as padding, so
     the resting stick is inside the notch/home-indicator on every
     phone without this file knowing what a phone is.
     ------------------------------------------------------------ */
  function measure() {
    const r = zone.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const cs = getComputedStyle(zone);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padB = parseFloat(cs.paddingBottom) || 0;
    stick.R = clamp(Math.min(r.width, r.height) * 0.5 * FULL, 34, 52);
    ringR = stick.R + KNOB * 0.5 + 9;
    root.style.setProperty('--w-sk', (ringR * 2) + 'px');
    root.style.setProperty('--w-kn', KNOB + 'px');
    home.x = padL + ringR;
    home.y = r.height - padB - ringR;
    if (stick.id === null) place(home.x, home.y);
  }
  function place(x, y) {
    stickEl.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
  }
  function moveKnob(dx, dy) {
    knob.style.transform = `translate3d(${dx.toFixed(1)}px,${dy.toFixed(1)}px,0)`;
  }

  /* ============================================================
     ONE PRIMARY-BUTTON GATE, FOR EVERY CONTROL ON THE PAD.

     THE DEFECT, and it is a cost of driving this cluster from pointer
     events rather than click: `click` is PRIMARY-BUTTON ONLY, and
     `pointerdown` is not. Nothing here looked at `e.button`, so on a
     hybrid device with the touch layer on — a Surface, a touchscreen
     laptop, anyone who ticked Settings › Touch controls — a RIGHT-BUTTON
     press on Enter at the apartment door measured padpress 1, interact
     1, panels ['place'] AND a context menu: the door opened from an
     input that could not have fired it at all under the old click
     binding. Middle-click did the same without the menu, every one of
     the five bindPress buttons fired, and a right-drag on the thumbstick
     deflected it to full and walked him 1.57 m.

     Jump and the stick were on pointerdown before this round, so those
     two were wrong already; the five bindPress buttons are new. The
     guard is one function used by all seven, because a per-control copy
     is how five of them came to disagree in the first place.

     WHY `> 0` AND NOT `!== 0`. A touch or pen contact is always button
     0, so fingers are unaffected. But `pointercancel` and
     `lostpointercapture` carry button -1 ("no button changed"), and
     those are the two events that RELEASE a held control — testing
     `!== 0` would strand a cancelled stick at full deflection. Only a
     genuine second button, 1 and up, is refused.

     AND THE FIRE POINT NEEDS IT TOO, for one sequence and one only.
     Chrome's chorded-button rules say a second button pressed or
     released while another is still down is a POINTERMOVE, not a
     pointerdown or pointerup — so most of what looks reachable here is
     not. Measured on this build, with the mouse's single pointerId
     throughout:

       left down, right down, right up, left up
         -> pointerdown b0, move b2, move b2, pointerup b0     normal
       left down, right down, LEFT up, right up
         -> pointerdown b0, move b2, move b0, click, pointerup b2

     The second one is the reachable case: the primary release comes
     through as a POINTERMOVE we never see, and the only pointerup the
     armed button ever gets carries button 2 — so without a test at the
     fire point the verb runs off the RIGHT button coming up. It is
     refused, and the rule that falls out is one line: no verb on this
     pad ever fires from a secondary button.

     THE RELEASE STILL RELEASES, THOUGH, and this is why the test sits
     BELOW the disarm and not above it. That same pointerup is the only
     release the button, the stick or Jump is ever going to get; an
     early return above the bookkeeping would leave the button armed
     against every later contact, or — worse — leave the STICK at full
     deflection with the elephant walking away on his own. Let go
     first, then decline to fire.

     THERE IS AN EIGHTH pointerdown BINDING AND IT IS NOT GATED, ON
     PURPOSE. `secondary` is on all seven CONTROLS — the stick, Jump and
     the five bindPress buttons — and that is the whole of the rule
     above: no VERB on this pad fires from a secondary button. The
     eighth is the document-capture pointerdown that drives the Hide-UI
     wake detector (bindCap, near tapDown), and a right-button double
     click wakes the controls exactly as a left one does. Measured, and
     kept.

     WHY IT IS KEPT. It is the same argument as the deliberate absence
     of a pointerType filter, whose block sits directly above tapDown,
     and it is for the same population. A wake RUNS NOTHING: the committing contact is
     eaten everywhere but the canvas, its compatibility click is
     swallowed, and the single effect is that the cluster becomes
     visible again — so the sentence this block exists to protect is
     untouched, because there is no verb here to refuse. What refusing
     WOULD cost is the way back: with the controls faded the pause gear
     is faded with them, so the double tap IS the only route home. A
     hybrid or assistive player whose primary is not button 0 — a
     swapped mouse, a trackball, a stylus barrel button, a switch
     device — would be locked out of their own HUD, which is a strictly
     worse failure than the one being prevented. And a wake is
     idempotent and self-reversing: five seconds of stillness puts it
     back.

     AND THE GUARD WOULD HAVE THE SAME ORDERING TRAP as the fire point
     above. tapDown's first line clears the commit swallow, and it does
     that BEFORE every early return in the function precisely because a
     click with a contact in front of it belongs to that contact. An
     `if (secondary(e)) return;` at the top of tapDown would skip that
     line and leave a stale one-shot swallow armed for a right press to
     fall into — the identical shape as guarding above the disarm and
     stranding an armed button. Asserted as PAD-27.
     ============================================================ */
  /* ------------------------------------------------------------
     BUTTON 5 IS A PEN'S CONTACT, NOT A SECOND BUTTON — AND IT CANNOT BE
     TESTED HERE. BOTH HALVES ARE WRITTEN DOWN ON PURPOSE.

     `> 0` catches 5, and 5 is the ERASER. Decided off the Pointer
     Events button/buttons tables rather than off a probe, because the
     probe cannot be run: bit 1 of `buttons` is "left mouse, TOUCH
     CONTACT, PEN CONTACT" and bit 32 is "pen eraser button". Those are
     two CONTACT STATES, not a modifier layered over the first. A pen
     that lands eraser-end down therefore arrives as button 5 / buttons
     32 with no bit-1 contact anywhere in its sequence, and refusing it
     refuses that stylus user's ONLY press — on all seven controls and
     at both ends, since the fire point calls this same function. That
     is the PAD-27 asymmetry again: a player locked out of their own
     controls is strictly worse than a stray activation. Pen eraser is
     exempt.

     AND THE EXEMPTION IS INERT IF THE PREMISE IS WRONG. Chrome may
     instead normalise an inverted pen down to a plain tip (button 0) —
     in which case button 5 can only ever reach us as a CHORDED second
     button, and Chrome delivers a chorded press or release as a
     POINTERMOVE, not as a pointerdown or pointerup (measured for the
     mouse in ONE PRIMARY-BUTTON GATE above). So either the eraser is
     the initiating contact, where admitting it is the whole fix, or it
     never reaches this line at all. There is no third world where this
     lets a modifier through.

     THE LIMITATION, SO THE NEXT PERSON DOES NOT REDISCOVER IT: this
     harness CANNOT produce a real eraser. CDP's
     Input.dispatchMouseEvent takes button as none/left/middle/right/
     back/forward with no eraser value, and a pen dispatched with
     buttons 32 comes through normalised to a plain tip. PAD-28
     therefore asserts the ARITHMETIC ONLY, from a synthesised pen
     event, and says so in its own name. Nothing below has been
     measured against hardware; a real pen is the test that replaces it.
     ------------------------------------------------------------ */
  const PEN_ERASER = 5;
  /** A press this pad refuses: any pointer button but the primary
      CONTACT. Fingers and pen TIPS are always 0; a pen ERASER is 5 and
      is a contact too — see the block above. */
  const secondary = (e) => e.button > 0
    && !(e.button === PEN_ERASER && e.pointerType === 'pen');

  /* ============================================================
     THE FOCUS OUTLIVES THE MODALITY: WHY SPACE IS ROUTED BY INTENT
     AND NOT BY document.activeElement.

     THE DEFECT, and it arrives through the FRONT DOOR rather than
     through any hole. A genuine Tab focuses a pad button -- the
     supported, deliberate, assistive route, and the one PAD-30 exists
     to protect. Every later pad contact then calls preventDefault on
     its pointerdown FIRST (see A REFUSED PRESS MUST NOT FOCUS THE
     BUTTON, below), which is what stops a press taking focus -- and the
     same call means nothing ever takes that focus AWAY again either.
     So the bookmark sticks, and the detail-0 listener at the bottom of
     bindPress keeps answering to it. Measured:

       Tab to Menu, real finger tap on Jump, then SPACE -> pause sheet
       same shape 4 of 4: Phone, Desk, Places, Menu
       Tab to Menu, WALK ON THE THUMBSTICK, then SPACE  -> pause sheet

     The player is moving, presses Space meaning JUMP, and gets a menu.
     Only a tap on the CANVAS cleared it; a tap on the stick or on Jump
     did not.

     WHAT IS ACTUALLY WRONG IS NOT WHERE FOCUS IS. Tab-then-Space is
     CORRECT for a keyboard or screen-reader player: they tabbed to
     Menu, they pressed Space, they want the pause sheet. Focus is in a
     perfectly reasonable place. What has gone stale is the INFERENCE --
     "a pad button holds focus, therefore Space means activate it" --
     because the player switched to their thumbs in between and said so.
     The discriminator is INTENT, NOT CAPABILITY.

     SO THE STALE PROXY IS DISTRUSTED RATHER THAN REFRESHED. `driving`
     says the player is currently playing with direct manipulation. It
     is set by a contact that only a player driving the game produces,
     and it is cleared the moment FOCUS ARRIVES on a pad button again --
     see the focusin listener below, which is the whole handback and
     reduces the rule to one sentence: A PAD BUTTON REFUSES A KEYBOARD
     ACTIVATION ONLY IF THE PLAYER TOUCHED THE PAD AFTER FOCUSING IT.

     WHY NOT blur(). Clearing focus is the obvious shape and it is the
     wrong one. blur() sends activeElement to <body>, so the next Tab
     restarts sequential navigation from the top of the document -- for
     a screen-reader player mid-navigation that is a silent teleport out
     of their place in the page, which is a worse accessibility failure
     than the bug. Not-blurring keeps the ring exactly where the player
     put it: it stops meaning "Space fires this" and goes on meaning
     "this is where Tab resumes", which is the truth and is the property
     worth keeping. Stashing the element and restoring it on Tab was the
     other way to have both, and it is a hidden focus teleport that a
     screen reader announces as a context change plus a preventDefault
     dance against the browser's own sequential navigation -- too clever
     for what it buys.

     WHAT SETS IT, and the deliberate asymmetry. The STICK and JUMP set
     it on contact: they are the movement controls, no mouse user is
     reaching for a virtual thumbstick, and no assistive activation
     arrives this way (AT presses land as a detail-0 CLICK with no
     pointer contact behind them at all -- that is the whole shape the
     listener below tests for). A SHORTCUT is the ambiguous one the pad
     was warned about, since a tap is also how a mouse user presses it;
     `direct()` answers that half by reading pointerType, and the
     remaining half -- an AT double-tap that really does synthesise a
     contact -- is answered by only counting a shortcut once its press
     has FIRED, at pointerup, inside the rect, with the controls live.

     WHAT DOES NOT CLEAR IT: the declined keystroke itself. Handing the
     keyboard back on the refusal was tried on paper and puts the bug
     straight back one keystroke later -- Space to jump, Space to jump,
     and the second one opens the menu. A fresh focus clears it, and
     nothing else does.

     THE COST, STATED PLAINLY: a sighted player on a tablet with a
     keyboard can see a focus ring on Menu, press Space, and jump
     instead. One Tab makes it work. That is the price of never
     destroying a screen-reader player's position in the document, and
     it is the right way round -- a surprising keystroke is visible and
     recoverable, a lost place in the page is neither.

     Asserted as PAD-35 (the theft, closed), PAD-36 (Tab hands it back),
     PAD-37 (the fade no longer strips a tabbed-to button's focus).
     ============================================================ */
  /** A contact from a finger or a pen tip -- direct manipulation, as
      opposed to a mouse, which a keyboard player may well also be
      holding. */
  const direct = (e) => e.pointerType === 'touch' || e.pointerType === 'pen';
  /** True while the player is demonstrably driving with their thumbs. */
  let driving = false;
  /** Is the keyboard's focus parked on one of our own buttons? */
  const padFocused = () => {
    const a = typeof document !== 'undefined' && document.activeElement;
    return !!a && a !== document.body && root.contains(a);
  };
  /* FOCUS ARRIVING ON A PAD BUTTON IS THE HANDBACK, AND IT IS THE
     PRECISE STATEMENT OF THE DEFECT.

     The first cut of this cleared `driving` on TAB, which is wrong in
     both directions and the suite said so immediately. Too narrow: a
     screen reader moves its cursor with swipes and rotor gestures, not
     with Tab, and the resulting focus change arrives as a plain
     focus() with no keystroke anywhere near it -- PAD-7 focuses a
     button directly and presses Enter, and a Tab-only rule left it
     refused. It is also unnecessary: what actually went stale was
     focus that was set BEFORE the player picked the game up, and
     focus that ARRIVES AFTER a touch is by definition fresh.

     So the rule is one sentence: A PAD BUTTON REFUSES A KEYBOARD
     ACTIVATION ONLY IF THE PLAYER TOUCHED THE PAD AFTER FOCUSING IT.
     `focusin` is exactly that edge, and it covers Tab, a screen
     reader's own navigation, a switch device and a programmatic
     focus() with one listener instead of a list of keys to keep up to
     date. PAD-7..PAD-9 -- "a keypress after a throwaway contact is
     delivered", which this suite has asserted since long before this
     round -- pass unchanged for the same reason. */
  /* ============================================================
     A FOCUS THE PLAYER PERFORMED AND A FOCUS THE UI RESTORED ARE
     DIFFERENT EVENTS THAT LOOKED IDENTICAL.

     THE DEFECT, and it is the sentence above being satisfied by a
     focus THE PLAYER NEVER PERFORMED. ui.js banks whoever held the
     keyboard when the modal stack opens and hands it back on close
     (see THE DIALOG ROUND TRIP there). When the banked element is a
     pad button, the hand-back calls focus() on it, focusin fires, and
     the listener below read that as the player focusing the button and
     handed Space to it. Measured, single variable -- one Tab ever, and
     every later event a real finger, no key until the final Space:

       never tabbed, twice       after thumb on Jump  driving true
                                 after finger close   driving true
                                 SPACE -> the game, panels []
       tabbed once, then thumbs  after thumb on Jump  driving true, focus "Menu"
                                 after finger close   driving FALSE
                                 SPACE -> THE PAUSE SHEET OPENED

     In words: tab once for any reason, put the phone in your hands,
     thumb Jump, thumb Menu, thumb Resume, press Space meaning jump --
     get the pause menu.

     The comment in ui.js that licensed the design -- "a thumb press on
     the pad deliberately never focuses anything ... so for a player
     using their thumbs focusReturn is null and this whole path is
     inert" -- was false, and false because of a decision made in THIS
     file. A thumb press never TAKES focus, and this file also never
     RELEASES it (see WHY NOT blur() above). So after ONE Tab, ever,
     activeElement stays parked on a pad button for the rest of the
     session, the banked value is non-null for every thumb-opened
     sheet, and the path is not inert at all.

     WHAT DOES NOT DISCRIMINATE, both measured rather than argued:

       e.isTrusted     TRUE for a script focus(), byte-identical to a
                       real Tab's focusin. The UA dispatches both, so
                       trust says "the browser made this event", never
                       "the player did".
       :focus-visible  a browser heuristic that inherits from the
                       previously focused element -- and the element the
                       restore comes FROM is the panel root, which
                       Chrome already matches (it is why ui.js sets
                       outline:none on it). It would report the restore
                       as keyboard-driven.

     SO THE UI SIGNS ITS OWN. `uiWillFocus(el)` is ui.js saying "the
     next focusin on that element is mine, not a player's". Three
     bounds, because a signature that outlives its focus is a pad gone
     deaf to a real one:

       · ELEMENT IDENTITY -- it only covers the node named.
       · SINGLE USE -- consumed by the focusin it describes, so the
         very next focus on the same button is the player's again.
       · A 50 ms DEADLINE -- an announced focus that never lands (see
         below) cannot sit armed waiting to swallow a genuine Tab.

     AND IT SURVIVES THE RESTORE'S OWN RETRY, which is the part a flag
     set once around the CALL would have got wrong. The hand-back spans
     roughly six frames: the pad is still display:none at the instant
     of the close, focus() on a display:none element is a silent no-op
     that fires no focusin at all, and ui.js retries on rAF until it
     lands. So the signature is applied PER ATTEMPT, next to the
     focus() call itself, and the attempts that no-op simply expire.
     Nothing can be tabbed into that window either -- the pad is
     display:none for the whole of it, so there is no genuine focus to
     mistake. focusin is dispatched SYNCHRONOUSLY inside focus()
     (measured), so the match is never a race; the deadline is belt to
     that brace, not the mechanism.

     WHY THE FLAG STAYS THE THING THE RULE KEYS ON. The tempting
     replacement is to key on the last INPUT event's type -- something
     no focus() call can forge. IT CANNOT EXPRESS THIS RULE AT ALL. At
     the moment of the detail-0 click the last trusted input event IS
     THE ACTIVATING KEYSTROKE: measured, touchstart at 13363.6, Space
     keydown at 13852.6, then the click. The key that causes the click
     is always the most recent input, so "refuse if the last input was
     touch" never refuses, and the original theft comes straight back.

     The sentence is not about a modality, it is about an ORDER between
     two events -- the last pad touch and the last pad focus -- and
     `driving` is exactly that order compressed to one bit. Keying on
     the last input type keeps one of the two and throws the ordering
     away. Requiring instead that a focus be ATTRIBUTABLE to a real
     input event before it counts -- unforgeable, and the shape the
     fragility argument points at -- fails on the case this design
     exists to protect: a screen reader moves its cursor with a rotor
     gesture, which produces a focus change and NO DOM input event
     whatsoever. PAD-7 is that case, it is a bare programmatic focus,
     and it is indistinguishable from the restore by event evidence
     alone. Something has to declare intent, and only the caller can.

     So the flag is right and its INPUT was wrong. The forgeable half
     is now signed at the one call site that can forge it: handBack()
     is the only function in the ui layer that focuses an element
     outside the panel stack (the two other focus() calls in the layer
     target an <input> inside a sheet, which root.contains() rejects
     one line down). Asserted as PAD-41..PAD-41e and PANEL-7..PANEL-7d.
     ============================================================ */
  /** The one restore ui.js has announced and the pad has not yet seen:
      { el, at } -- element identity, single use, 50 ms. */
  let uiFocus = null;
  /** ui.js: "I am about to focus this myself." Called immediately
      before each focus() attempt of the hand-back. */
  function uiWillFocus(el) {
    if (!el || !root.contains(el)) return false;   // not ours; nothing to sign
    uiFocus = { el, at: performance.now() };
    return true;
  }
  /** Is the focusin now arriving the restore ui.js just announced? */
  function isUiRestore(target) {
    if (!uiFocus) return false;
    const mine = uiFocus.el === target && (performance.now() - uiFocus.at) < 50;
    if (mine) uiFocus = null;                      // consumed
    return mine;
  }
  bindCap(document, 'focusin', (e) => {
    if (!root.contains(e.target)) return;
    /* THE ONE LINE THE DEFECT LIVED ON. A focus the PLAYER performed
       is the handback. A focus the UI RESTORED is the player's place
       in the document being handed back to them, and it says nothing
       at all about which way they are holding the phone. */
    if (!isUiRestore(e.target)) driving = false;
    /* ...AND IT IS ACTIVITY, WHICH IS THE WHOLE OF THIS FILE'S ANSWER
       TO THE FADE. style.js gives the faded cluster visibility:hidden,
       which takes every button out of the tab order AND out of the
       accessibility tree -- so a player who has just tabbed to Menu can
       have the button taken out from under them mid-decision by a clock
       they never touched. Resetting it hands them a WHOLE window from
       the moment they arrive, which is what the feature already does
       for every other kind of activity.

       IT IS A RESET AND NOT A SUSPENSION, deliberately: see the note in
       idleSuspended. And it is bounded on purpose -- a focus left on the
       cluster does eventually fade like anything else, because the cost
       of that is small and known. The pad's four shortcuts are P / M / O
       / Esc, and ui.js binds all four on `window` whether or not this
       layer exists, so a keyboard player who loses the buttons loses no
       capability at all; they lose a redundant second route to it. That
       is the trade, and it is the cheap side of it.

       BOTH BRANCHES RESET IT, deliberately. A restore is not the
       player focusing anything, but it only ever happens because the
       player just closed a sheet -- which is activity by any reading,
       and the clock is already held at zero by idleSuspended()'s
       'modal' while the sheet is up. Splitting this line would change
       nothing and would put a second rule in a file that has one. */
    idleT = 0;
  }, true);

  /* setPointerCapture throws for a pointerId the browser has no active
     contact for. It used to sit ABOVE the preventDefault in all three
     controls; it now sits below the bookkeeping, where an uncaught
     throw would leave a button in `pressing`, wearing its pressed
     class, unpressable for the rest of the session. Contained here
     instead: WITHOUT capture the control still works, because the
     release-inside test measures the rect itself rather than trusting
     the capture. This is a downgrade, not a failure. */
  const capRetried = new Set();
  let captureRetry = true;               // see lostIsRelease; debug switch only
  function capture(el, id) {
    capRetried.delete(el);                         // a fresh contact, a fresh retry
    try { el.setPointerCapture?.(id); } catch (err) {}
  }
  function recapture(el, id) {
    try { el.setPointerCapture?.(id); } catch (err) {}
  }

  /* ============================================================
     A lostpointercapture WITH THE CONTACT STILL DOWN IS NOT A RELEASE,
     AND IT IS WHY A MOUSE DRAG ON THE THUMBSTICK ONLY WORKED SOMETIMES.

     ALL THREE CONTROLS BIND lostpointercapture STRAIGHT TO THEIR RELEASE,
     which is right for the case it was written for: capture torn away
     mid-gesture would otherwise strand the knob at full deflection and
     walk the player off on his own. It is wrong for what this Chrome
     actually does. Measured on the thumbstick with a plain PRIMARY mouse
     drag — no second button anywhere near it — twelve gestures a session:

       down gotpointercapture lostpointercapture(has=false, buttons=1) up
                                              -> stick t 0.00, he never moves
       down up                                -> stick t 1.00, normal

     Two in five, at every load this box was tried at, and it PREDATES
     this round: the same run against the previous ordering of down()
     produced the same split — 5 of 6 plain drags dead — so it is neither
     the preventDefault move nor the chord guard. Chrome grants the
     capture and drops it again inside the same gesture, and `up` was
     bound to hear that as "the thumb left the glass".

     buttons IS THE DISCRIMINATOR AND IT IS EXACT. Every spurious loss
     measured carries buttons 1, the primary still down; a capture
     released because the CONTACT ended carries 0. So a loss with buttons
     still set means the capture moved and the contact did not, and the
     honest answer is to take the capture back rather than to let go.
     ONCE per contact: a re-take that can be lost again is a loop, and
     one round trip is all the evidence supports.

     AND THE SAME BINDING IS ON THE FIVE bindPress BUTTONS AND ON JUMP,
     where a spurious loss disarms the button so its own pointerup finds
     nothing in `pressing` and the verb never runs — a press that does
     nothing, with no error and nothing to see. Same wrapper, same reason.

     THE STRAND IS COVERED FROM THE OTHER SIDE TOO, because a re-take is
     not a guarantee: the stick's release is ALSO bound at document
     capture, where a pointerup arrives wherever the pointer happens to
     be by then. `up` is pointerId-gated, so the ordinary path still
     releases exactly once.
     ============================================================ */
  const lostIsRelease = (el, owns, release) => (e) => {
    if (!owns(e)) return;
    /* `captureRetry` is a DEBUG SWITCH and nothing else -- shipping
       value true, not a setting, not saved, not reachable from the
       interface. Turned off, this function is byte-for-byte the old
       behaviour (a loss is a release), which is the only way to put a
       real before/after of the dead-drag rate on ONE page at ONE load.
       See WALLY.debug.padCaptureRetry(). */
    if (e.buttons && captureRetry) {
      if (!capRetried.has(el)) { capRetried.add(el); recapture(el, e.pointerId); }
      return;
    }
    capRetried.delete(el);
    release(e);
  };

  /* THE MENU ITSELF, since the press that would raise it is now refused.
     A right press or a platform long-press over the controls drops a
     browser menu across the thumbstick, and there is nothing under it to
     copy, select, save or open in a new tab. This is the pad only — the
     canvas keeps its own handling through armCanvas(). */
  bind(root, 'contextmenu', (e) => e.preventDefault(), false);

  /* ------------------------------------------------------------
     the stick
     ------------------------------------------------------------ */
  function down(e) {
    /* FIRST LINE, ABOVE EVERY EARLY RETURN — see A REFUSED PRESS MUST
       NOT FOCUS THE BUTTON, above bindPress. The stick is not focusable,
       but the same call also kills middle-button autoscroll and the
       drag/selection defaults for a refused contact, and one rule
       written once in three places is the point of that block. */
    e.preventDefault();
    if (secondary(e)) return;                      // a right/middle drag is not a thumb
    if (stick.id !== null) return;                 // one thumb owns it
    /* A THUMB ON THE STICK IS THE PLAINEST STATEMENT OF INTENT THIS PAD
       CAN RECEIVE -- see THE FOCUS OUTLIVES THE MODALITY. */
    if (direct(e)) driving = true;
    const r = zone.getBoundingClientRect();
    stick.id = e.pointerId;
    stick.cx = clamp(e.clientX - r.left, ringR * 0.55, r.width + ringR * 0.35);
    stick.cy = clamp(e.clientY - r.top, ringR * 0.55, r.height - ringR * 0.2);
    place(stick.cx, stick.cy);
    moveKnob(0, 0);
    stickEl.classList.add('live');
    capture(zone, e.pointerId);
    try { ctx.audio?.resume?.(); } catch (err) {}
  }
  function move(e) {
    if (e.pointerId !== stick.id) return;
    /* ============================================================
       THE CHORD WINDOW, AND WHY CLOSING IT IS NOT THE THING THE GATE
       BLOCK REFUSED TO DO.

       Chrome sends a chorded press or release as a POINTERMOVE. So
       `primary down, drag, right down, primary UP` delivers the primary
       release as a pointermove nobody was looking at, and the stick went
       on tracking a mouse with no button held — deflected, walking him —
       until the right button finally came up and produced the one
       pointerup the stick ever gets.

       The gate block above declines to GATE THE RELEASE, and rightly:
       refusing that button-2 pointerup would strand the knob at full
       deflection with the elephant walking away. This is the opposite
       shape. It does not withhold a release, it ADDS one, at the exact
       event that says the primary is gone — so the stick lets go the
       moment the thumb-equivalent does, and the later button-2 pointerup
       finds stick.id already null and falls out of `up` harmlessly.

       MOUSE ONLY, and `buttons` not `button`: a touch or pen contact
       reports buttons 1 for its whole life (a pen with the barrel held
       reads 1|2, an eraser contact 32), while a pen HOVER reports 0 —
       and a hover cannot be stick.id, because the contact that owns the
       stick has not lifted. Restricting to mouse costs nothing and
       means no reading of a finger's `buttons` can ever drop a live
       thumb.
       ============================================================ */
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) { up(e); return; }
    const r = zone.getBoundingClientRect();
    let dx = (e.clientX - r.left) - stick.cx;
    let dy = (e.clientY - r.top) - stick.cy;
    let len = Math.hypot(dx, dy);

    /* Drag the origin along once the thumb has walked well past full
       deflection, so a long swipe never runs out of stick. */
    const slide = stick.R * SLIDE;
    if (len > slide) {
      const k = (len - slide) / len;
      stick.cx += dx * k; stick.cy += dy * k;
      dx -= dx * k; dy -= dy * k;
      len = slide;
      place(stick.cx, stick.cy);
    }
    setAxes(dx, dy, len);
    e.preventDefault();
  }
  function setAxes(dx, dy, len) {
    const u = clamp(len / stick.R, 0, 1);
    const t = u <= DEAD ? 0 : (u - DEAD) / (1 - DEAD);
    stick.t = t;
    if (t > 0 && len > 1e-4) {
      stick.dx = dx / len;                // screen right  -> camera right
      stick.dz = -dy / len;               // screen up     -> camera forward
    } else { stick.dx = 0; stick.dz = 0; }
    const kr = Math.min(len, stick.R * 1.14);
    moveKnob(len > 1e-4 ? dx / len * kr : 0, len > 1e-4 ? dy / len * kr : 0);
    const running = t > RUN_AT;
    if (running !== stick.run) { stick.run = running; stickEl.classList.toggle('run', running); }
  }
  function up(e) {
    /* NO BUTTON TEST HERE — see the gate block above. A pointerup that
       carries button 2 is the LAST release of a chorded mouse, and it
       is the only one the stick gets; refusing it strands the knob at
       full deflection and walks him away on his own. */
    if (e && e.pointerId !== stick.id) return;
    stick.id = null; stick.t = 0; stick.dx = 0; stick.dz = 0;
    if (stick.run) { stick.run = false; stickEl.classList.remove('run'); }
    stickEl.classList.remove('live');
    moveKnob(0, 0);
    place(home.x, home.y);
  }

  const stickOwns = (e) => e.pointerId === stick.id;
  bind(zone, 'pointerdown', down, false);
  bind(zone, 'pointermove', move, false);
  bind(zone, 'pointerup', up, true);
  bind(zone, 'pointercancel', up, true);
  bind(zone, 'lostpointercapture', lostIsRelease(zone, stickOwns, up), true);
  /* THE RELEASE THAT CANNOT BE LOST — see the block above lostIsRelease.
     Capture is the only thing that guarantees the zone hears its own
     pointerup, and capture is exactly what this Chrome drops mid-gesture.
     A stick that never hears a release is the one failure this file
     cannot have, so the release is caught at document capture as well,
     wherever the pointer ended up. `up` is pointerId-gated: with capture
     intact the document sees it first and the zone's own listener then
     returns, so this is a second route and never a second release. */
  bindCap(document, 'pointerup', (e) => { if (stick.id !== null) up(e); }, true);
  bindCap(document, 'pointercancel', (e) => { if (stick.id !== null) up(e); }, true);

  /* ------------------------------------------------------------
     jump — held, not clicked: the controller cuts the rise when the
     button comes up (variable jump height) and buffers the press
     itself, so all it needs from us is the truth about the finger.
     ------------------------------------------------------------ */
  bind(jumpBtn, 'pointerdown', (e) => {
    /* FIRST LINE, ABOVE EVERY EARLY RETURN — see A REFUSED PRESS MUST
       NOT FOCUS THE BUTTON, above bindPress. This is the call that stops
       the focus grab, and a refused press that focused Jump handed the
       player's next SPACE to it: measured at peak vy 5.83 against a
       control of 0.00. */
    e.preventDefault();
    if (secondary(e)) return;                      // see ONE PRIMARY-BUTTON GATE
    /* ONE CONTACT OWNS JUMP, the same rule bindPress has had all along.
       jumpUp was bound to pointerup with no pointerId test, so with two
       thumbs on the button EITHER lifting released it, in either order —
       which cuts variable jump height (the controller reads the flag to
       decide when to stop the rise) and lets a second thumb merely
       RESTING on the button cancel a held jump. */
    if (jumpId !== null) return;
    /* ...and so is a thumb on Jump -- see THE FOCUS OUTLIVES THE
       MODALITY, above the stick. */
    if (direct(e)) driving = true;
    jumpId = e.pointerId;
    jumpHeld = true;
    jumpBtn.classList.add('down');
    capture(jumpBtn, e.pointerId);
    try { ctx.audio?.resume?.(); } catch (err) {}
  }, false);
  /** Let go, whoever asked: the keyboard timer, the fade, the teardown.
      The pointer path goes through jumpEnd, which owns the contact test. */
  function jumpUp() {
    clearTimeout(jumpKeyT); jumpKeyT = 0;
    jumpId = null;
    jumpHeld = false;
    jumpBtn.classList.remove('down');
  }
  /* A release always releases, whatever BUTTON it carries — see the gate
     block above the stick — but only from the contact that took it. */
  const jumpOwns = (e) => !!e && e.pointerId === jumpId;
  const jumpEnd = (e) => { if (!jumpOwns(e)) return; jumpUp(); };
  bind(jumpBtn, 'pointerup', jumpEnd, true);
  bind(jumpBtn, 'pointercancel', jumpEnd, true);
  /* a capture loss with the thumb still down is not a lift — see the
     block above lostIsRelease */
  bind(jumpBtn, 'lostpointercapture', lostIsRelease(jumpBtn, jumpOwns, jumpEnd), true);
  /* a keyboard/screen-reader activation still has to jump */
  bind(jumpBtn, 'click', (e) => {
    if (e.detail !== 0) return;                    // real pointer already handled
    /* THE PLAYER IS ON THEIR THUMBS: this Space means jump, and it
       already did -- wally.js reads the key off window. Answering it
       here as well would double-fire the very verb they wanted.
       See THE FOCUS OUTLIVES THE MODALITY. */
    if (driving) return;
    if (jumpId !== null) return;                   // a thumb owns it: do not cut its hold
    jumpHeld = true;
    clearTimeout(jumpKeyT);
    /* ...and the auto-release must not steal a contact that landed
       inside its 140 ms either */
    jumpKeyT = setTimeout(() => { if (jumpId === null) jumpUp(); }, 140);
  }, true);

  /* ============================================================
     THE PAD IS DRIVEN FROM POINTER EVENTS. IT DOES NOT LISTEN TO CLICK,
     AND THAT IS THE WHOLE FIX.

     THE DEFECT, which had nothing to do with Hide UI and was the worst
     thing measured on this cluster: CHROME DISPATCHES NO COMPATIBILITY
     CLICK FOR A CONTACT INSIDE A MULTI-TOUCH SEQUENCE. At the apartment
     door, controls fully live, Hide UI OFF, counting ui.interact() calls
     rather than listeners:

       one finger taps Enter               interact 1, panels ['place']
       stick held, Enter tapped            interact 0, panels []
       stick held, stick lifts first       interact 0, panels []
       a finger parked anywhere, Enter     interact 0, panels []
       both fingers off, Enter again       interact 1, panels ['place']

     TWO PAD BUTTONS AT ONCE was listed here as a sixth symptom —
     "Phone and Menu pressed together, neither one fires" — and it was
     wrong in both directions, because nothing had ever driven two
     BUTTONS down together. Driven on purpose (PAD-14/15) the truth is
     that both contacts arm and both reach their own pointerup at their
     own button. What happens next is decided by the FIRST RELEASE: its
     verb raises a sheet, ui.js puts the pad inside a display:none
     subtree, and the second button's rect is then 0x0 — so the loser is
     refused by the release-inside test below, not by any missing event.

     TAKE THE OCCLUSION AWAY AND BOTH FIRE, and that half has two
     independent sources now — it used to rest on a stubbed test alone,
     which is a poor thing for a claim about real verbs to stand on.
     PAD-15 monkey-patches the two sheet verbs so neither can hide the
     pad, and both stubs run. PAD-15b touches nothing: it presses ENTER
     and Menu together on OPEN GROUND, where Enter's real verb refuses
     for a game reason (no door in range) and so raises no sheet to
     occlude anything — the loser's release then measures a live,
     non-zero pad rect and Menu's real verb opens the real pause sheet.
     Two verbs, no stubs, the same conclusion.

     That is the behaviour we want:
     the sheet a player has just opened is not fought over by whatever
     their other thumb was resting on, and nothing is silently dropped
     when there is no sheet in the way.

     So walking on the thumbstick and pressing Enter with the other thumb
     did NOTHING, and Enter is this game's main verb — every door, desk,
     client, NPC and shop runs through it. No window, guard or gate could
     have fixed that: the event the button was waiting for is never sent.
     It was proved to be the browser and not the game on a bare page with
     two buttons and no game in it — pointerdown:a, pointerdown:b,
     pointerup:b, pointerup:a, and no click:b.

     JUMP AND THE THUMBSTICK WERE ALWAYS IMMUNE, for the one reason that
     matters: they are driven from pointerdown. In the same run Jump
     measured vy 2.63 two-fingered while Enter measured nothing at all.
     Pointer events are per-contact and know nothing about how many other
     fingers are on the glass, so Enter and the four shortcuts are now
     driven the same way — armed at pointerdown with the contact
     captured, fired at pointerup if the finger is still on the button.

     WHAT CLICK WAS QUIETLY GIVING US, NOW KEPT ON PURPOSE:

       · KEYBOARD AND ASSISTIVE TECHNOLOGY. Those activations arrive as a
         click with detail 0 and NO pointer sequence in front of them, so
         every button keeps a click listener that accepts exactly that
         and nothing else — the same inversion Jump has always used, and
         the population the missing pointerType filter is there to
         protect. A hybrid tablet with a keyboard, or a screen reader,
         still presses every button on this pad.
       · REFUSING A RETARGETED OR SYNTHESISED PRESS. A compatibility
         click is hit-tested at dispatch and carries detail 1; the
         detail-0 listener refuses it by construction, which is what let
         a whole capture-phase gate be deleted (see above bindCap).

     THE RELEASE IS INSIDE-OR-CANCELLED, which is the other half of what
     click meant and the reason capture is not enough on its own: a
     finger that lands on Enter, slides off and lifts somewhere else has
     changed its mind, and pointer capture would otherwise still hand
     that pointerup to the button.

     AND THE CONTACT'S OWN CLICK STILL HAS TO GO SOMEWHERE. This is the
     one thing acting at pointerup costs that acting at click did not,
     and it was measured immediately: one finger taps Enter at the
     apartment door ->

       pointerdown -> svg.w-i                    panels []
       pointerup   -> button.w-abtn.big.act.on   panels []   (opens it)
       click (d1)  -> div.w-scrim.on             panels ['place']
       -> popSheet, final panels []

     The verb ran at pointerup and raised the sheet, and the trailing
     click was then hit-tested against a screen that now had a scrim on
     it and dismissed what the press had just opened. So a press arms
     swallowClick, and the capture-phase gate that already existed for
     the wake tap eats that one click. `e.preventDefault()` on the
     pointerdown does NOT do this job, whatever the specification says:
     measured on a bare div in this Chrome, ["pd","ts","pu","te","CLICK
     d1"] with pointerdown prevented and no CLICK at all with touchstart
     or touchend prevented. A touch-level preventDefault would therefore
     work for a finger — and do nothing for the mouse a hybrid tablet
     might be using, whose click is not a compatibility event at all.
     One flag covers both inputs, so there is one mechanism and not two.
     ============================================================ */

  /* ============================================================
     A REFUSED PRESS MUST NOT FOCUS THE BUTTON, WHICH IS WHY ONE LINE
     MOVED ABOVE THE GATE.

     THE GATE WAS BYPASSED ONE KEYSTROKE LATER. `secondary(e)` returned
     ABOVE the `e.preventDefault()` here and in Jump, and that
     preventDefault is the only thing stopping the browser's focus grab.
     So a refused press still FOCUSED the button, and the player's next
     Space or Enter arrived at it as a click with detail 0 — which is
     precisely the shape the keyboard/AT listener at the bottom of this
     function accepts. Measured with a real mouse in a mobile context,
     every one of them a verb the gate had just refused:

       right press on Menu, then Space   -> pause sheet opens
       right press on Menu, then Enter   -> pause sheet opens
       MIDDLE press on Menu, then Space  -> pause sheet opens
       right press on Phone, then Space  -> phone opens
       right press on Desk, then Enter   -> desk opens
       right press on Jump, then Space   -> peak vy 5.83 (control 0.00)
       pen BARREL press on Enter         -> the same hole via stylus

     AND IT STOLE THE GAME'S KEYBOARD, which is worse than the defect it
     grew out of. With a shortcut holding focus from a refused press, a
     player's SPACE — which they mean as JUMP — opened the phone
     instead, vy 0.00. Any secondary press on this pad silently rebound
     Space and Enter to that button until focus moved, with no visible
     cause. A stray activation is at least visible.

     THE FIX IS THE ONE LINE, FIRST, ABOVE EVERY EARLY RETURN — not just
     above the secondary one, because `pressing.has(btn)` is an early
     return too and a second contact on an already-held button has no
     more business taking focus than a right press does. The breaker
     proved the mechanism from the other side: a capture-phase
     pointerdown listener calling preventDefault for button > 0 stopped
     the grab (activeElement inside the pad went null) and removing it
     brought the grab straight back.

     WHAT preventDefault DOES NOT DO HERE, kept from the round that
     measured it: it does NOT suppress the compatibility click. Only
     touchstart/touchend do that, and the click is dealt with at the fire
     point by swallowClick instead. Moving this line therefore changes
     the focus behaviour and nothing else about the click path.

     WHAT IS DELIBERATELY UNTOUCHED: a genuine Tab to one of these
     buttons still focuses it — preventDefault on a POINTERdown cannot
     reach sequential focus navigation — and Space or Enter there still
     runs the verb through the detail-0 listener below. That path is for
     assistive users and it is the whole reason the listener exists; the
     defect was never that keyboard activation worked, it was that a
     mouse could hand the keyboard a button the player never chose.
     Asserted as PAD-29 (the hole, now closed) and PAD-30 (the AT path,
     still open).
     ============================================================ */
  /** Arm at pointerdown, fire at pointerup. `run` is the button's verb. */
  function bindPress(btn, run) {
    bind(btn, 'pointerdown', (e) => {
      /* THE FIRST LINE, ABOVE BOTH EARLY RETURNS — see the block above.
         This stops the focus grab, and NOT the compatibility click. */
      e.preventDefault();
      if (secondary(e)) return;                    // see ONE PRIMARY-BUTTON GATE
      if (pressing.has(btn)) return;               // one contact owns one button
      pressing.set(btn, e.pointerId);
      btn.classList.add('down');
      capture(btn, e.pointerId);
      try { ctx.audio?.resume?.(); } catch (err) {}
    }, false);
    const end = (e) => {
      if (pressing.get(btn) !== e.pointerId) return;
      pressing.delete(btn);
      btn.classList.remove('down');
      if (e.type !== 'pointerup') return;          // cancelled, or capture lost
      /* BELOW the disarm, deliberately — see ONE PRIMARY-BUTTON GATE.
         This is the last release the button will get, so it has to let
         go; it just does not get to fire. */
      if (secondary(e)) return;
      /* THE FADE CAN LAND UNDER A RESTING THUMB. A tap is not presence
         (see idleTick), so a thumb parked on Enter does not stop the
         idle clock, and firing an invisible button on the way up would
         be the very defect the inert gate was built for. ONE guard, at
         the one moment this can honestly be false. */
      if (!controlsLive()) return;
      const r = btn.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right
        || e.clientY < r.top || e.clientY > r.bottom) return;
      /* armed BEFORE the verb runs, because the verb may raise a sheet
         and the click this contact is about to produce would be
         hit-tested against that sheet's scrim */
      swallowClick = true;
      /* ONLY HERE, NOT AT pointerdown. A shortcut tap is the ambiguous
         one -- it is also how a mouse user presses it, and it is the
         one shape an assistive double-tap could conceivably synthesise.
         A press that has got this far is past the rect test, past
         controlsLive and carries a real finger, so it is a player
         playing. See THE FOCUS OUTLIVES THE MODALITY. */
      if (direct(e)) driving = true;
      run();
    };
    bind(btn, 'pointerup', end, true);
    bind(btn, 'pointercancel', end, true);
    /* A CAPTURE LOSS WITH THE CONTACT STILL DOWN DISARMED THE BUTTON, so
       its own pointerup then found nothing in `pressing` and the verb
       never ran — a press that does nothing, silently. See the block
       above lostIsRelease for the measurement. */
    bind(btn, 'lostpointercapture',
      lostIsRelease(btn, (e) => pressing.get(btn) === e.pointerId, end), true);
    /* KEYBOARD AND ASSISTIVE TECHNOLOGY ONLY — see the block above.
       DELIBERATELY NOT GATED ON controlsLive(). While the controls are
       faded, style.js gives the cluster `visibility:hidden`, which takes
       every button out of the tab order and out of the accessibility
       tree — there is nothing here to activate and no way to reach it.
       During the fade-IN the button is visible and focusable, and a
       player who has deliberately tabbed to it and pressed Enter should
       be answered: refusing them is the failure the deleted gate caused,
       not a protection against it. */
    bind(btn, 'click', (e) => {
      if (e.detail !== 0) return;
      /* THE ONE NEW REFUSAL, and it is a routing decision rather than a
         capability one: this player is driving with their thumbs, so
         their Space belongs to the game and not to a button they tabbed
         to some time ago. Tab hands it straight back, and focus is left
         exactly where they put it. See THE FOCUS OUTLIVES THE
         MODALITY. */
      if (driving) return;
      run();
    }, true);
  }
  /** Drop every held button: the layer is going away, or it just faded. */
  function pressCancelAll() {
    for (const b of pressing.keys()) b.classList.remove('down');
    pressing.clear();
  }

  bindPress(actBtn, () => { ui.click(); ui.interact(); });
  for (const [b, s] of shortcutBtns) bindPress(b, () => { ui.click(); s.run(); });

  /* ============================================================
     HIDE UI, STAGE TWO — the clock, the fade, and the way back.
     See the header block for the numbers and the reasoning.
     ============================================================ */

  /** Is the second stage even in play? Touch layer up, Hide UI on. */
  function idleArmed() { return enabled && !!ui.hideUI; }

  /* WHAT SUSPENDS THE CLOCK. Fading the controls out under a
     conversation is not idleness — the player is reading, and the pad's
     Enter button is the thing they are about to press. Same for a sheet
     or the phone (the pad is already put away behind those, and coming
     back out of one to a screen with no controls would read as a bug),
     and same for a cinematic. Suspended means HELD AT ZERO, not frozen
     mid-count: a conversation that ends hands the player the whole
     window back rather than a second and a half of it.

     SUSPENSION RESTORES. It used to only stop counting, which meant a
     dialogue or a sheet opening while the controls were ALREADY faded
     froze them away permanently: `why` read 'dialogue', hidden stayed
     true, and Enter — the button the rationale above says they are
     about to press — never came back. The whole reason for suspending
     is that the player needs the pad, so suspending has to hand it to
     them. Two measured consequences of not doing so, both gone now: a
     conversation entered from a faded screen was unplayable on touch,
     and with a sheet up the detector went on eating every second tap to
     wake a pad that was behind the sheet and invisible. */
  function idleSuspended() {
    if (ui.modal) return 'modal';
    if (!ui.visible) return 'cinematic';
    if (ui.dialogueOpen) return 'dialogue';
    /* A PARKED FOCUS IS THE KEYBOARD'S RESTING THUMB. setIdleHidden
       already refuses to fade out from under a live contact; a player
       who has tabbed INTO this cluster is just as present, and the
       cost of ignoring them is worse than a stranded knob. style.js
       gives the faded cluster `visibility:hidden`, which takes every
       button out of the tab order AND out of the accessibility tree --
       so the idle clock firing under a tabbed-to button drops
       activeElement to <body> and destroys the player's place in the
       document, on a timer they never touched. Held here instead.
       It can only ever be true while the controls are live, because a
       hidden button cannot be tabbed to in the first place. */
    /* A FOCUSED PAD BUTTON IS DELIBERATELY *NOT* HERE, AND THE SUITE IS
       WHY. Suspending the clock while focus sits on the cluster was the
       first shape of this and it is wrong: focus, unlike a thumb, is
       never taken off the glass, so ONE keyboard visit disabled stage
       two for the rest of the session. Measured -- it broke seven
       assertions that had nothing to do with the keyboard (IDLE-75,
       IDLE-77, IDLE-79, PAD-8 and their setups), every one of them by
       the fade simply never arriving. A focus ARRIVING is treated as
       activity instead, and resets the clock like any other activity;
       see the focusin listener above bindPress. */
    return '';
  }

  /* WHAT COUNTS AS THE PLAYER MOVING. Character motion, plus the two
     inputs that are about to produce it. Deliberately NOT: a camera
     drag, a toast, a notification, a banner, a quest update, or the
     clock. `grounded` is not consulted — it flickers on a ground snap
     (see the phys:land note in character/wally.js) and a flickering
     input to a five-second clock is a clock that never fires. Vertical
     speed is the honest airborne test: at rest on the ground the
     controller parks vy at about -0.02. */
  function moving() {
    if (stick.t > 0 || stick.id !== null || jumpHeld) return true;
    const c = ctx.wally?.controller;
    const v = c && (c.velocity || c.vel);
    if (!v) return false;
    if (Math.hypot(v.x, v.z) > MOVE_EPS) return true;
    return Math.abs(v.y) > AIR_EPS;
  }

  function setIdleHidden(on) {
    on = !!on;
    if (on === idleHidden) return;
    idleHidden = on;
    root.classList.toggle('w-idlehide', on);
    if (on) {
      /* never fade out from under a live thumb, and never leave the
         jump flag latched true behind an invisible button — including
         the contact that owns it and a keyboard auto-release in flight */
      up(null);
      jumpUp();
      /* ...and never leave a pad button armed behind an invisible face:
         its pointerup would arrive with the control faded out. The fire
         path refuses that on its own (controlsLive), so this is only
         about not leaving a pressed-looking button to fade away. */
      pressCancelAll();
      if (!seamTaught) { seamTaught = true; root.classList.add('w-idlefirst'); }
    } else {
      root.classList.remove('w-idlefirst');
      idleT = 0;
      /* do not carry a half-finished double tap across the wake */
      contacts.clear(); pending = null; cand = null;
      /* INERT UNTIL THE FADE FINISHES. Removing .w-idlehide returns
         pointer-events at once, which made every control pressable at
         opacity 0.00 for the whole 0.42 s fade — the third tap of a
         triple tap pressed an invisible Jump. .w-idlewake holds them
         off until the transition this reads off the CSS has run. */
      root.classList.add('w-idlewake');
      clearTimeout(liveTimer);
      const ms = fadeMs();
      if (ms <= 2) { root.classList.remove('w-idlewake'); liveTimer = 0; }
      else liveTimer = setTimeout(goLive, ms + 20);
      /* a rotation while the cluster was invisible measured nothing */
      measure();
    }
  }

  /** How long the cluster's own fade lasts, read off the CSS rather
      than duplicated here — which is also what makes reduced motion
      (a global `.w-rm *` pin to .001s) collapse this to nothing. */
  function fadeMs() {
    const d = getComputedStyle(zone).transitionDuration || '0s';
    let m = 0;
    for (const v of d.split(',')) m = Math.max(m, (parseFloat(v) || 0) * 1000);
    return m;
  }
  function goLive() {
    liveTimer = 0;
    root.classList.remove('w-idlewake');
  }

  /** The one way back. Returns true if it actually woke something. */
  function wake() {
    if (!idleHidden) return false;
    setIdleHidden(false);
    wokeAt++;
    return true;
  }

  function idleTick(dt) {
    if (!idleArmed()) {
      /* Hide UI off, or the layer put away: everything comes straight
         back. This is also the route Settings takes on the way out. */
      if (idleHidden) setIdleHidden(false);
      idleT = 0;
      idleWhy = enabled ? 'nohideui' : 'off';
      return;
    }
    /* TIME IN ANOTHER APP IS NOT TIME HOLDING STILL. Backgrounded, this
       loop is throttled rather than stopped and every one of those
       frames was banked, so eight seconds in another app came back to a
       stripped screen and a first tap — usually aimed at a control —
       that did nothing. The clock is held here and reset on the way
       back in (see the visibilitychange handler), so returning to the
       game always hands over the whole window. */
    if (typeof document !== 'undefined' && document.hidden) {
      idleWhy = 'background';
      return;
    }
    if (resumeSkip) {
      resumeSkip = false; idleT = 0;
      idleWhy = idleHidden ? 'hidden' : 'counting';
      return;
    }
    const sus = idleSuspended();
    if (sus) {
      /* HELD AT ZERO *AND* RESTORED — see idleSuspended's note. */
      if (idleHidden) setIdleHidden(false);
      idleT = 0; idleWhy = sus; return;
    }
    idleWhy = idleHidden ? 'hidden' : 'counting';
    if (idleHidden) return;
    if (moving()) { idleT = 0; return; }
    idleT += dt;
    if (idleT >= idleDelay) setIdleHidden(true);
  }

  /* ------------------------------------------------------------
     THE DOUBLE TAP.

     Bound at DOCUMENT CAPTURE, which is the only place with no dead
     region: it sees the contact before the canvas, before the faded
     controls, before a dialogue card and before a notification, wherever
     on the screen it lands. It early-returns unless stage two is armed
     and nothing modal is up, so during normal play these listeners
     record a landing point and change nothing.

     SWALLOWING THE WAKING CONTACT. The tap that brings the controls back
     must not also do something. Measured, in this browser, the order for
     one finger is: pointerdown -> touchstart -> ... -> touchend -> click.
     A contact that COULD be tap two is provisionally suppressed at its
     pointerdown and then judged; only a contact that lifts short and
     still commits (see the header):

       · pointerdown  provisional: stopPropagation + preventDefault, so
                      the target's own pointerdown never fires (this is
                      what would otherwise jump, or grab the stick).
       · pointermove  stopPropagation while it is still a candidate; the
                      first move past TAP_SLOP RELEASES it and every
                      event after that flows normally.
       · pointerup    commit or release. On commit: the same pair, plus
                      the one-shot click swallow below.
       · click        the capture-phase swallow, armed by the commit and
                      spent on the very next pointer-borne click. THIS is
                      the real backstop — it is what catches a toast or a
                      card, and it is why letting a released candidate
                      keep its pointerup costs nothing.

     ...UNLESS THE TAP LANDED ON THE CANVAS, which is let through
     untouched and on purpose. The canvas has no click handler, so
     nothing can fire; what it does have is core/camera.js, and letting
     the contact reach it means a wake tap that turns into a camera drag
     IS a camera drag, with no lost frames. The cost is that a wake tap
     steers the camera by however far the finger moved — at most
     TAP_SLOP, which is 3.8 degrees, which is nothing.

     DOUBLE-TAP-TO-ZOOM, the browser default we are taking over, is
     already dead everywhere this fires: the canvas is touch-action:none
     (armCanvas), the pad is touch-action:manipulation, and style.js puts
     manipulation on <body> for the whole touch session. preventDefault
     is therefore never load-bearing for zoom — it is only there to eat
     the compat click — so nothing here can break scrolling in a phone
     sheet or pinch anywhere else.
     ------------------------------------------------------------ */
  const contacts = new Map();       // pointerId -> { x, y, t, moved, cand }
  let pending = null;               // the completed tap one, if any
  let cand = null;                  // pointerId provisionally held as tap two
  /* EAT THE NEXT POINTER-BORNE CLICK. Not a window and not a timer: it
     is armed by a gesture this file has just consumed — a wake commit,
     or a pad button firing — and it is cancelled by the next
     pointerdown, because a click with a contact in front of it belongs
     to that contact. See tapClick for the two things it must never
     touch. */
  let swallowClick = false;
  const stamp = (e) => e.timeStamp || performance.now();
  const onCanvas = (e) => !!ctx.canvas && e.target === ctx.canvas;

  function eat(e) { e.preventDefault(); e.stopPropagation(); }

  /** The gate every contact passes on its own, at its own pointerup:
      short enough to be a tap, and it stayed where it landed. */
  function wasTap(c, e, now) {
    return now - c.t <= TAP_MS
      && c.moved <= TAP_SLOP
      && Math.hypot(e.clientX - c.x, e.clientY - c.y) <= TAP_SLOP;
  }

  /* NO pointerType FILTER, deliberately. This whole detector is dead
     unless the touch layer is up and Hide UI is on, and it never eats
     anything unless the controls are actually hidden, so it can never
     touch a desktop player. What the missing filter buys
     is the hybrid: a tablet with a trackpad, or a pen. The layer can be
     on there (Settings › Touch controls, or one genuine touchstart), and
     if only a thumb could wake the controls then a hybrid player who put
     the tablet down and picked up the mouse would have no way back at
     all — the pause gear is faded out with everything else. A double
     click passes exactly the same tap/gap/distance gates a double tap
     does, so admitting it costs nothing and closes that.

     AND NO e.button FILTER EITHER, for the same players and the same
     reason: a right-button double click wakes exactly as a left one
     does. This is the EIGHTH pointerdown in the file and the one
     documented exception to the pad's primary-button rule — the rule
     is about verbs, and no verb lives here. The full argument, and
     the ordering trap a guard on the line below would walk into, are
     in ONE PRIMARY-BUTTON GATE above the stick. Asserted as PAD-27. */
  function tapDown(e) {
    /* A NEW CONTACT CLOSES THE COMMIT SWALLOW, unconditionally and
       before every early return below. A click that has a pointerdown in
       front of it belongs to that contact, not to a commit two gestures
       ago — and the multi-touch wake this file supports produces a
       commit with no compat click of its own to close it. Without this
       line that window sat open for its full 500 ms and ate the next
       honest press: measured, with reduced motion collapsing the fade,
       as Phone tapped 80 ms and 250 ms after a two-finger wake doing
       nothing at all. */
    swallowClick = false;
    /* OFF ENTIRELY UNDER A SHEET. With the phone or a menu up the pad
       is behind it and invisible, so there is nothing here to wake and
       every candidate this armed was a tap eaten for nothing — measured
       as every SECOND tap in the phone doing nothing at all. */
    if (!idleArmed() || idleSuspended()) return;
    const now = stamp(e);
    /* A CANDIDATE, NOT A WAKE. It still has to survive its own pointerup
       (wasTap) before it is allowed to be tap two. */
    const two = idleHidden && !!pending
      && now - pending.up <= TAP_GAP
      && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) <= TAP_DIST;
    contacts.set(e.pointerId, { x: e.clientX, y: e.clientY, t: now, moved: 0, cand: two });
    if (!two) return;
    cand = e.pointerId;
    if (!onCanvas(e)) eat(e);
  }

  function tapMove(e) {
    const c = contacts.get(e.pointerId);
    if (!c) return;
    const d = Math.hypot(e.clientX - c.x, e.clientY - c.y);
    if (d > c.moved) c.moved = d;
    if (!c.cand) return;
    if (c.moved > TAP_SLOP) {
      /* RELEASED, on the first move that proves it a drag. Nothing is
         eaten from here on: this contact is a camera adjustment and the
         camera has had it since its pointerdown (the canvas branch
         above never eats), so the drag runs to the end unbroken and
         wakes nothing. */
      c.cand = false;
      if (cand === e.pointerId) cand = null;
      return;
    }
    if (!onCanvas(e)) e.stopPropagation();   // passive listener: no preventDefault
  }

  function tapUp(e) {
    const c = contacts.get(e.pointerId);
    if (!c) return;
    contacts.delete(e.pointerId);
    if (cand === e.pointerId) cand = null;
    const now = stamp(e);
    const tap = wasTap(c, e, now);
    if (c.cand && tap && idleHidden && !idleSuspended()) {
      /* COMMIT. The gesture is spent, the click it is about to produce
         is swallowed, and the controls come back. */
      pending = null;
      swallowClick = true;
      if (!onCanvas(e)) eat(e);
      wake();
      return;
    }
    /* A contact that was NOT a tap does not merely fail to be tap two —
       it clears the pending tap one. That is the rule that stops a tap
       followed by a camera drag from arming anything. */
    pending = tap ? { x: c.x, y: c.y, up: now } : null;
  }

  function tapCancel(e) {
    contacts.delete(e.pointerId);
    if (e.pointerId === cand) cand = null;
    pending = null;
  }

  /* ============================================================
     WHAT USED TO BE HERE, AND WHY IT IS NOT.

     A capture-phase gate keyed on WHERE THE CONTACT BEGAN: a Set of
     pointerIds that landed while the cluster was inert, a 500 ms window
     armed when one of them lifted, and a rule that ate any click landing
     inside .w-touch either during that window or while the cluster was
     still not live. It closed a real, measured defect — a finger that
     lands 150 ms after a wake, on the faded Enter, and lifts 630 ms
     later walked the player through the apartment door, because the
     compatibility click is hit-tested at DISPATCH and retargeted into
     the button that pointer-events had just refused it.

     IT WAS A DOOR THAT NO LONGER EXISTS. The pad is driven from pointer
     events now: that contact's pointerdown obeyed pointer-events and
     never armed the button, and its retargeted click carries detail 1,
     which every pad button refuses. The two cases the gate was built
     for — a contact that outlives the fade, and one whose pad is
     restored under it by a suspending dialogue — are closed by the
     structure instead of by a window. Both are still driven, at a door,
     and they still assert the click really did retarget INTO the pad.

     AND IT WAS EATING HONEST ACTIVATIONS. The window it armed was blind:
     an inert-born contact's click almost always lands on the CANVAS —
     that being why it was inert — so the branch that cleared the window
     never ran, and it sat open for its full 500 ms with nothing of its
     own to eat. Anything arriving without a pointerdown in front of it
     fell in. Measured on a fully live, fully opaque Enter button:

       inert-born contact, its click on the canvas, then a keypress
                                                 -> interact 0, EATEN
       an ordinary camera drag, then a keypress   -> interact 0, EATEN
       CONTROL: no contact at all, then a keypress-> interact 1

     A keypress is a hybrid tablet or a screen reader — exactly the
     population the no-pointerType-filter comment above exists to
     protect — and a fully live button refusing an honest activation is
     the failure that block predicted a per-handler guard would cause.
     The guard that replaced it is per-handler and is the opposite shape:
     it says YES to detail 0 rather than NO to a class of pointer.
     ============================================================ */

  /** Can a finger press the cluster right now? THE FLAG, NOT THE
      ELEMENT. Mid-fade every button is at opacity 1 inside a container
      that is not, so `elementFromPoint` and uiLayers().hit both report
      Enter reachable for the whole inert window — which is how a green
      suite covered this twice. `hidden` is not the same question
      either: it is false for the entire fade-in. */
  function controlsLive() {
    return !idleHidden && !root.classList.contains('w-idlewake');
  }

  function tapClick(e) {
    /* AN ACTIVATION WITH NO POINTER BEHIND IT IS NEVER A WAKE TAP'S
       CLICK. detail 0 is a keyboard or an assistive technology pressing
       something on purpose; the swallow below exists for a compatibility
       click, which always carries 1 or more. This is the line that stops
       the window from eating the population it was built beside. */
    if (e.detail === 0) return;
    if (!swallowClick) return;
    swallowClick = false;
    eat(e);
  }

  bindCap(document, 'pointerdown', tapDown, false);
  bindCap(document, 'pointermove', tapMove, true);
  bindCap(document, 'pointerup', tapUp, false);
  bindCap(document, 'pointercancel', tapCancel, true);
  bindCap(document, 'click', tapClick, false);
  /* THE touchstart PREVENTDEFAULT IS GONE ON PURPOSE. It existed to
     suppress the compat click of a contact recognised at pointerdown,
     and there is no longer anything to recognise that early — a
     candidate is not a wake yet, and killing a candidate's click would
     silently break a press-and-hold on a dialogue card that never woke
     anything. The click swallow above is the backstop, and it fires
     only after an actual commit. */

  /* BACKGROUND TIME IS NOT IDLE TIME. Bound here rather than only read
     in idleTick, because a throttled or a fully stopped rAF are both
     possible and the state has to be right either way: the clock is
     held while away and handed back whole on return. */
  const onVisibility = () => {
    if (typeof document === 'undefined') return;
    if (document.hidden) { idleWhy = 'background'; return; }
    /* one tick of catch-up dt is worth up to a whole window on its own */
    resumeSkip = true;
    idleT = 0;
    /* a gesture cannot straddle a trip to another app */
    contacts.clear(); pending = null; cand = null; swallowClick = false;
  };
  bindCap(document, 'visibilitychange', onVisibility, true);

  /* ------------------------------------------------------------
     THE INPUT SOURCE — the only thing here that moves anything.

     `out`, `_kb` and `_sv` are deliberately SHARED and mutated in place:
     one allocation for the life of the layer instead of three per frame.
     That is safe because the consumer copies rather than retains —
     PhysicsController.setInput() reads the six fields into its own
     `this.input` the moment we return (controller.js), and
     wally.camRelative() writes into whatever scratch it is handed. No
     one downstream keeps the reference or compares this frame's object
     against last frame's.

     This is written down because "touch returns a shared mutable object,
     a fresh literal animates fine" was the leading theory for the
     legs-don't-move bug and it cost an afternoon. It was wrong twice
     over: the aliasing is benign, and the bug was not in this file or on
     mobile at all — it was the phys:land handler in character/wally.js
     mistaking a one-frame ground-snap flicker for a landing. See the
     note there before suspecting this seam again.
     ------------------------------------------------------------ */
  const out = { x: 0, z: 0, jump: false, jumpHeld: false, run: false };
  function input(dt, c) {
    const w = ctx.wally;
    const kb = w && w.keyboardInput ? w.keyboardInput(_kb) : null;

    out.jump = jumpHeld || !!(kb && kb.jump);
    out.jumpHeld = out.jump;

    if (stick.t > 0 && w && w.camRelative) {
      /* ANALOGUE SPEED. The controller's target is
         (run ? runSpeed : walkSpeed) * |input|, so a continuous speed
         curve has to choose the gear AND the magnitude together — pick
         the speed first, then say which gear it lives in. */
      const walk = c?.opts?.walkSpeed ?? 2.45;
      const run = c?.opts?.runSpeed ?? 5.9;
      const t = stick.t;
      const speed = t <= RUN_AT
        ? walk * (t / RUN_AT)
        : walk + (run - walk) * ((t - RUN_AT) / (1 - RUN_AT));
      const useRun = speed > walk + 1e-4;
      const mag = clamp(speed / (useRun ? run : walk), 0, 1);
      const v = w.camRelative(stick.dx, stick.dz, _sv);
      out.x = v.x * mag; out.z = v.z * mag; out.run = useRun;
      return out;
    }
    if (kb) { out.x = kb.x; out.z = kb.z; out.run = kb.run; return out; }
    out.x = 0; out.z = 0; out.run = false;
    return out;
  }

  /* ------------------------------------------------------------
     canvas defaults — ONLY on the canvas. The DOM interface keeps
     its native behaviour (a phone sheet must still scroll).
     ------------------------------------------------------------ */
  function armCanvas() {
    if (armed) return;
    const cv = ctx.canvas;
    if (!cv || !cv.style) return;
    armed = true;
    cv.style.touchAction = 'none';                 // no scroll, no pinch, no double-tap zoom
    cv.style.webkitUserSelect = 'none';
    cv.style.userSelect = 'none';
    cv.style.webkitTouchCallout = 'none';
    /* iOS Safari pinch-zooms the PAGE through gesture events, which
       touch-action does not cover. */
    bind(cv, 'gesturestart', (e) => e.preventDefault(), false);
    bind(cv, 'gesturechange', (e) => e.preventDefault(), false);
    bind(cv, 'dblclick', (e) => e.preventDefault(), false);

    /* ============================================================
       THE FOURTH TOUCH SOURCE, WHICH WAS RIGHT FOR THE WRONG REASON.

       WHAT WAS MEASURED. Tab to Menu, then one real finger on the bare
       canvas:

         before   {driving:false, padFocused:true,  focus:"Menu", padTakesSpace:true}
         after    {driving:false, padFocused:false, focus:null,   padTakesSpace:false}

       The next Space does not open the pause sheet, which is the right
       ANSWER — and look at why. `driving` never moved. What changed is
       that `focus` went to null: Chrome's default action for a contact
       on a non-focusable element blurs whatever held the keyboard, so
       the theft is blocked here by DESTROYING the player's place in the
       document. That is the blur() failure this design rejected, in
       full, arriving as a browser default instead of as a decision.

       A rule that holds for three sources and is accidentally rescued
       on the fourth is a rule waiting to break: add `tabindex` to the
       canvas for a keyboard camera, or a preventDefault upstream to
       stop something else, and the canvas silently starts stealing
       Space again with nothing in the suite to notice.

       SO THE TWO PATHS ARE MADE TO AGREE, and a canvas touch IS a
       legitimate way to say "I am driving with touch": it is the
       camera orbit — direct manipulation of the world, by the same
       thumbs, and a mouse user reaching for it is filtered out by
       `direct()` exactly as it is on the stick and on Jump.

         · it SETS the flag, so the refusal is the flag's doing and is
           handed back by the same focusin that hands the other three
           back, and
         · it STOPS TAKING THE FOCUS, so the player keeps their place.

       WHY THE preventDefault IS GATED ON THERE BEING SOMETHING TO
       PROTECT. With nothing focused the default action has nothing to
       destroy, and calling preventDefault anyway would suppress the
       compat mouse events for every canvas contact in the game for no
       gain — a blast radius with no benefit on the other side of it.
       When something IS focused, suppressing them costs nothing that
       exists: the canvas has no click handler (see THE DOUBLE TAP),
       and the camera runs on pointer events, which preventDefault does
       not touch. Capture phase so it lands before camera.js.

       Asserted as PAD-39 / PAD-39b / PAD-39c.
       ============================================================ */
    /* bindCap, and its second argument is `passive` — NOT capture, which
       `bind` takes in the same slot. A passive listener's
       preventDefault is dropped on the floor with a console warning,
       so this line getting that wrong would have looked exactly like
       the fix not working. */
    bindCap(cv, 'pointerdown', (e) => {
      if (!enabled || !direct(e)) return;
      driving = true;
      const a = document.activeElement;
      if (a && a !== document.body) e.preventDefault();
    }, false);
  }

  /* ------------------------------------------------------------
     enable / disable
     ------------------------------------------------------------ */
  function setEnabled(on) {
    on = !!on;
    if (on === enabled) return enabled;
    enabled = on;
    root.classList.toggle('hidden', !enabled);
    const uiRoot = root.parentElement;
    uiRoot?.classList.toggle('w-touch-on', enabled);
    document.body.classList.toggle('w-touch-on', enabled);
    if (enabled) { armCanvas(); measure(); }
    else { up(null); setIdleHidden(false); }
    /* a fresh session of the layer starts with the full clock */
    idleT = 0; pending = null; contacts.clear(); cand = null; swallowClick = false;
    pressCancelAll();
    /* ...and Jump, which owns its contact separately from `pressing` */
    jumpUp();
    clearTimeout(liveTimer); liveTimer = 0; root.classList.remove('w-idlewake');
    /* the caption latches are stale the moment the layer is put away —
       drop them so the first update after it comes back repaints */
    actWas = null; talkWas = null;
    /* the seam: ui.js re-installs this after every modal grab */
    ui.setBaseInput(enabled ? input : null);
    /* THE LABELS FOLLOW THE SWITCH. Settings › Touch controls calls
       through here, so every subscribed chip, prompt and sentence
       repaints for the new input mode instead of staying whatever it
       was at boot. */
    layerOn = enabled;
    publishMode();
    return enabled;
  }

  /* ------------------------------------------------------------
     frame
     ------------------------------------------------------------ */
  let acc = 0;
  let mutedWas = null, actWas = null, talkWas = null, toastY = -1;
  function update(dt) {
    /* BEFORE the enabled gate and before the muted gate, every frame
       rather than on the 0.2 s cadence below. Before `enabled` because
       turning the layer off has to put the controls back; before
       `muted` because a sheet SUSPENDS the clock and that decision is
       made in here; every frame because a 5 s clock quantised to 200 ms
       would drop a stick tap that landed between two samples. */
    idleTick(dt);
    if (!enabled) return;
    /* a panel owns the screen — the pad would only sit under it */
    const muted = ui.modal || !ui.visible;
    if (muted !== mutedWas) {
      mutedWas = muted;
      root.classList.toggle('hidden', muted);
      /* a rotation while we were display:none measured nothing */
      if (muted) up(null); else measure();
    }
    if (muted) return;

    acc += dt;
    if (acc < 0.2) return;
    acc = 0;

    /* keep the relocated toasts clear of the objective strip, which
       grows a line whenever the quest name is long */
    const bar = root.parentElement?.querySelector('.w-bar.left');
    if (bar) {
      /* HIDE UI keeps the bar in the layout (visibility, not display —
         see the note in style.js), so this measurement never returns
         zero. But with the strip invisible the toasts should take the
         top-left corner it vacated rather than float below a hole, so
         we dock to the bar's TOP instead of its bottom. */
      const r = bar.getBoundingClientRect();
      const y = Math.round(ui.hideUI ? r.top : r.bottom) + 10;
      if (y !== toastY) {
        toastY = y;
        root.parentElement.style.setProperty('--w-toasty', y + 'px');
        /* The notification layer is parented to <body> so that no
           sheet can cover it (ui/notify.js), which also puts it
           outside #ui and out of reach of the line above. Mirror the
           measurement onto :root so the strip dock can read it. */
        document.documentElement.style.setProperty('--w-toasty', y + 'px');
      }
    }

    const near = !!ui.near;
    const talking = !!ui.dialogueOpen;
    const live = near || talking;

    /* TWO CONCERNS, TWO LATCHES — and they are deliberately not the
       same condition. The button LIGHTS UP whenever there is anything
       at all to press: a door, a conversation, either. The CAPTION
       says which, and only a conversation changes it.

       They used to share one latch on `live`, and standing at a door
       already makes `live` true, so opening a conversation there never
       re-entered the branch. Measured, before this split:
         · a conversation in open ground   -> 'More', reverts. Fine.
         · a conversation AT a door        -> stuck on 'Enter / Talk'.
         · a conversation that ENDS with a door in range -> stuck on
           'More' indefinitely, recovering only by walking out of range
           of every door. That is the damaging one: the button read
           'More' while pressing it walked you inside a building.
       The one branch that worked is also the only one the test drove,
       which is why 57/57 was green while this was broken. */
    if (live !== actWas) {
      actWas = live;
      actBtn.classList.toggle('on', live);
      actBtn.classList.toggle('off', !live);
    }
    if (talking !== talkWas) {
      talkWas = talking;
      /* An EXPLICIT reference to the caption span, never lastChild.
         lastChild is a Node, not an Element: the day anybody appends
         an icon, a badge or even a stray text node after the caption,
         `lastChild.textContent = …` silently writes into that instead
         and the caption stops updating with no error anywhere. */
      actCap.textContent = talking ? ACTIONS.advance.touch : ACTIONS.interact.cap;
      /* 'More' is short; only the resting caption overhangs the button */
      actCap.classList.toggle('long', !talking);
    }
  }

  function setBadge(n) {
    badge.textContent = n > 9 ? '9+' : String(n);
    badge.style.display = n ? '' : 'none';
  }

  /* ------------------------------------------------------------
     plumbing
     ------------------------------------------------------------ */
  function bind(el, type, fn, passive) {
    const o = passive ? { passive: true } : { passive: false };
    el.addEventListener(type, fn, o);
    off.push(() => el.removeEventListener(type, fn, o));
  }
  /* the same, in the CAPTURE phase — which is the only phase that can
     see a contact before the element under it does */
  function bindCap(el, type, fn, passive) {
    const o = { capture: true, passive: !!passive };
    el.addEventListener(type, fn, o);
    off.push(() => el.removeEventListener(type, fn, o));
  }
  const onResize = () => measure();
  addEventListener('resize', onResize);
  addEventListener('orientationchange', onResize);
  off.push(() => removeEventListener('resize', onResize));
  off.push(() => removeEventListener('orientationchange', onResize));

  /* The first genuine touch is the last word on whether this is a
     touch device — a laptop with a touchscreen reports a fine pointer
     right up until somebody puts a finger on it. */
  const onFirstTouch = () => {
    removeEventListener('touchstart', onFirstTouch, { capture: true });
    if (!enabled) setEnabled(true);
  };
  addEventListener('touchstart', onFirstTouch, { capture: true, passive: true });
  off.push(() => removeEventListener('touchstart', onFirstTouch, { capture: true }));

  return {
    root, input, setEnabled, setBadge, update, measure,
    get enabled() { return enabled; },
    get active() { return stick.id !== null; },
    /** raw stick read, for tools/touchtest.mjs */
    get axes() { return { t: stick.t, x: stick.dx, z: stick.dz, run: stick.run, R: stick.R }; },
    /** Jump's held flag AND which contact owns it — the second half is
        what tools/touchtest.mjs needs to tell "he let go" from "the
        wrong finger let go for him". */
    get jump() { return { held: jumpHeld, id: jumpId }; },
    /** WHO OWNS THE NEXT SPACE, and why -- see THE FOCUS OUTLIVES THE
        MODALITY. `driving` is the routing flag; `focus` is where the
        keyboard's bookmark actually sits, which this design
        deliberately does NOT move. */
    get keyboard() {
      const d = typeof document !== 'undefined' ? document : null;
      /* <body> is where focus SITS when nothing holds it, so reporting
         its class list as "the focus" reads as a focused element. */
      const a = d && d.activeElement !== d.body ? d.activeElement : null;
      return {
        driving,
        padFocused: padFocused(),
        focus: a ? (a.getAttribute?.('aria-label') || a.className || a.tagName) : null,
        /* the sentence a player would say: would Space fire the button? */
        padTakesSpace: padFocused() && !driving,
      };
    },
    /** ui.js ANNOUNCING ITS OWN focus() — see A FOCUS THE PLAYER
        PERFORMED AND A FOCUS THE UI RESTORED. Call it immediately
        before EACH focus() attempt of the sheet hand-back; the pad
        then knows that focusin is not the player picking the button up
        again and leaves `driving` alone. Element identity, single use,
        50 ms — a signature that outlived its focus would be a pad deaf
        to a real one. Returns false for anything outside the cluster,
        which is every other focus this layer performs. */
    uiWillFocus,
    /** THE DEBUG SWITCH BEHIND lostIsRelease. false restores the old
        "a capture loss is a release" behaviour so the dead-drag rate
        can be measured before and after on one page. */
    setCaptureRetry(on) { captureRetry = on !== false; return captureRetry; },
    /** Hide UI stage two, for tools/touchtest.mjs and the screenshots. */
    get idle() {
      return {
        armed: idleArmed(), hidden: idleHidden, t: +idleT.toFixed(2),
        delay: idleDelay, why: idleWhy, wakes: wokeAt,
        moving: idleArmed() ? moving() : false,
        pending: !!pending,
        /* `live` IS THE ONE HONEST FLAG, and it is NOT the same
           question as `hidden`: for the 0.42 s of the fade-in the
           controls are drawn, hidden is already false, and every button
           is still inert. Nor is it a question the DOM can answer —
           each button's own opacity is 1 throughout the fade (it is the
           container that fades), so elementFromPoint and
           uiLayers().hit both report Enter reachable across the whole
           inert window. An assertion built on the element is blind to
           this; one built on this flag is not. That is how the same bug
           survived two green suites. */
        live: controlsLive(),
        cand: cand !== null,
      };
    },
    /** Shorten the idle window so a test can exercise every branch
        without waiting five seconds a time. Not a setting, not saved,
        not reachable from the interface — `undefined` restores.
        The floor is 0 — "fade on the next tick" — rather than 0.2 s,
        because the one branch that cannot be built out of waits is the
        double tap that STRADDLES the fade, and landing the fade between
        two taps 300 ms apart leaves no room for a round trip. */
    setIdleDelay(sec) {
      idleDelay = (sec === undefined || sec === null) ? IDLE_HIDE
        : clamp(+sec || 0, 0, 120);
      idleT = 0;
      return idleDelay;
    },
    /** pose the stick without a finger — screenshots only */
    demo(nx, ny) {
      /* a posed stick under a faded-out cluster is an invisible stick */
      wake();
      if (nx == null) { up(null); return null; }
      const r = zone.getBoundingClientRect();
      if (stick.id === null) { stick.cx = home.x; stick.cy = home.y; }
      stickEl.classList.add('live');
      const len = Math.hypot(nx, ny) * stick.R;
      const a = Math.hypot(nx, ny) || 1;
      setAxes((nx / a) * len, (-ny / a) * len, len);
      return { t: +stick.t.toFixed(2), run: stick.run, zone: [r.width | 0, r.height | 0] };
    },
    dispose() {
      for (const f of off) f();
      clearTimeout(liveTimer); liveTimer = 0;
      clearTimeout(jumpKeyT); jumpKeyT = 0;
      root.parentElement?.classList.remove('w-touch-on');
      root.remove();
      document.body.classList.remove('w-touch-on');
      ui.setBaseInput(null);
      /* no layer left to outrank the media query */
      layerOn = null;
      publishMode();
    },
  };
}

export default createTouch;
