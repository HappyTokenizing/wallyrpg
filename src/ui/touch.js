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

const _kb = { x: 0, z: 0, jump: false, jumpHeld: false, run: false };
const _sv = { x: 0, z: 0 };

/** Would this device be better off with thumb controls? */
export function shouldEnable(ctx) {
  if (typeof window === 'undefined') return false;
  const q = new URLSearchParams(location.search).get('touch');
  if (q === '1' || q === 'on') return true;
  if (q === '0' || q === 'off') return false;
  if (ctx?.game?.state?.settings?.touch) return true;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const points = (navigator.maxTouchPoints | 0) > 0 || 'ontouchstart' in window;
  return coarse && points;
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
  for (const s of SHORTCUTS) {
    const b = h('button.w-abtn.sm', {
      type: 'button', 'aria-label': s.cap,
      onclick: () => { ui.click(); s.run(); },
    }, icon(s.ic, 20));
    if (s.badge) b.append(badge);
    shortcuts.append(b);
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
  const actCap = h('span.cap.long', { text: 'Enter / Talk' });
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
  root.append(zone, acts);

  /* ------------------------------------------------------------
     state
     ------------------------------------------------------------ */
  let enabled = false;
  let armed = false;                     // canvas defaults suppressed
  const stick = { id: null, cx: 0, cy: 0, R: 40, t: 0, dx: 0, dz: 0, run: false };
  const home = { x: 80, y: 80 };
  let ringR = 67;
  let jumpHeld = false;
  const off = [];                        // teardown

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

  /* ------------------------------------------------------------
     the stick
     ------------------------------------------------------------ */
  function down(e) {
    if (stick.id !== null) return;                 // one thumb owns it
    const r = zone.getBoundingClientRect();
    stick.id = e.pointerId;
    stick.cx = clamp(e.clientX - r.left, ringR * 0.55, r.width + ringR * 0.35);
    stick.cy = clamp(e.clientY - r.top, ringR * 0.55, r.height - ringR * 0.2);
    place(stick.cx, stick.cy);
    moveKnob(0, 0);
    stickEl.classList.add('live');
    zone.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    try { ctx.audio?.resume?.(); } catch (err) {}
  }
  function move(e) {
    if (e.pointerId !== stick.id) return;
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
    if (e && e.pointerId !== stick.id) return;
    stick.id = null; stick.t = 0; stick.dx = 0; stick.dz = 0;
    if (stick.run) { stick.run = false; stickEl.classList.remove('run'); }
    stickEl.classList.remove('live');
    moveKnob(0, 0);
    place(home.x, home.y);
  }

  bind(zone, 'pointerdown', down, false);
  bind(zone, 'pointermove', move, false);
  bind(zone, 'pointerup', up, true);
  bind(zone, 'pointercancel', up, true);
  bind(zone, 'lostpointercapture', up, true);

  /* ------------------------------------------------------------
     jump — held, not clicked: the controller cuts the rise when the
     button comes up (variable jump height) and buffers the press
     itself, so all it needs from us is the truth about the finger.
     ------------------------------------------------------------ */
  bind(jumpBtn, 'pointerdown', (e) => {
    jumpHeld = true;
    jumpBtn.classList.add('down');
    jumpBtn.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    try { ctx.audio?.resume?.(); } catch (err) {}
  }, false);
  const jumpUp = () => { jumpHeld = false; jumpBtn.classList.remove('down'); };
  bind(jumpBtn, 'pointerup', jumpUp, true);
  bind(jumpBtn, 'pointercancel', jumpUp, true);
  bind(jumpBtn, 'lostpointercapture', jumpUp, true);
  /* a keyboard/screen-reader activation still has to jump */
  bind(jumpBtn, 'click', (e) => {
    if (e.detail !== 0) return;                    // real pointer already handled
    jumpHeld = true;
    setTimeout(jumpUp, 140);
  }, true);

  bind(actBtn, 'click', () => { ui.click(); ui.interact(); }, true);

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
    else up(null);
    /* the seam: ui.js re-installs this after every modal grab */
    ui.setBaseInput(enabled ? input : null);
    return enabled;
  }

  /* ------------------------------------------------------------
     frame
     ------------------------------------------------------------ */
  let acc = 0;
  let mutedWas = null, actWas = null, toastY = -1;
  function update(dt) {
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
    if (live !== actWas) {
      actWas = live;
      actBtn.classList.toggle('on', live);
      actBtn.classList.toggle('off', !live);
      /* An EXPLICIT reference to the caption span, never lastChild:
         the caption is one of several children and reordering them
         (which is exactly what the Enter/Jump swap did) would have
         silently started writing 'More' into the icon. */
      actCap.textContent = talking ? 'More' : 'Enter / Talk';
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
    /** pose the stick without a finger — screenshots only */
    demo(nx, ny) {
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
      root.parentElement?.classList.remove('w-touch-on');
      root.remove();
      document.body.classList.remove('w-touch-on');
      ui.setBaseInput(null);
    },
  };
}

export default createTouch;
