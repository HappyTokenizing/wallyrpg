/* ============================================================
   notify.js — the notification centre. Achievements and toasts.

   THE BUG THIS FILE EXISTS TO FIX.
   Toasts and banners lived in #ui (z-index 10). The modal stack —
   scrim, phone, sheets, dialogue — lives in #overlay (z-index 20).
   So every notification fired while ANY panel was open was drawn
   underneath a blurred scrim and a 560 px card, and its 3.4 s timer
   ran to zero behind them. The player never saw it. Tokenize an
   asset from inside the desk sheet and the one message telling you
   it worked was already dead by the time you closed the sheet.

   THE FIX, AND WHY IT IS "RENDER ABOVE" RATHER THAN "QUEUE UNTIL
   CLOSED".
   Both were on the table. Queueing loses the thing that makes a
   confirmation a confirmation: almost every notification in this
   game is caused by a button ON a panel — buy, tokenize, accept,
   hire, travel. Hold it until the panel closes and the answer to
   "did that work?" arrives thirty seconds later, detached from the
   question, while the player is standing in a different street. So
   notifications RENDER ABOVE the modal stack, in their own layer at
   z-index 25 — over the scrim and every sheet, under the film grain
   so they stay inside the colour grade (ART §3.8).

   The queue is still here, because "above the panels" alone does not
   make a wall of eleven cards readable. It does three things:
     · at most 3 present at once (2 while a panel is open, where the
       space above the sheet is shorter), the rest wait their turn;
     · nothing on screen is ever evicted to make room, and the queue
       drains in arrival order. The queue itself is capped at 14, and
       overflow drops the OLDEST ROUTINE TOAST — never an achievement,
       never anything already presented;
     · one achievement at a time. A second waits;
     · a deep backlog shortens what is on screen rather than dropping
       it, so twenty things finishing at once is half a minute of
       notifications and not five.

   AND THE CLOCK ONLY RUNS WHEN THE MESSAGE IS ACTUALLY ON SCREEN.
   A dismissal timer that ticks while the layer is hidden is the same
   bug in a different coat, so life is counted down in update(dt) and
   only while awake(): not during the arrival curtain, not while the
   interface is faded out for a cinematic, not behind the boot screen,
   not in a background tab, and not while the ending is playing. The
   hairline under an achievement is that clock, drawn — it visibly
   stops.

   PLACEMENT. Three docks, chosen automatically, each one picked to
   miss the furniture:
     corner  bottom-left, exactly where toasts have always been.
             Clear of the pills and objective strip (top-left), the
             key hints (bottom-right) and the dialogue (bottom-centre).
     strip   top-left under the objective strip, on touch — the
             bottom-left corner is the thumbstick.
     top     top-centre, when a panel or a dialogue is open. The
             sheet is centred and at most 84vh, so this band is the
             one piece of screen a sheet can never reach.

   ------------------------------------------------------------
   API — ui.notify
     toast(text, kind, opts)      routine. kind: good|bad|money|
                                  token|info|warn
     achievement(spec)            the heavy tier: {title, sub, eyebrow,
                                  icon, kind, replaces, life}
     promote(text)                drop a queued/live toast that the
                                  achievement about to be posted
                                  supersedes (quests emit both)
     setSuppressed(on)            the ending takes the screen; hold
                                  everything, present it afterwards
     freeze(on)                   debug: stop the clock, keep the view
     obscuredBy(fn)               predicate — true means "not visible"
     state()                      {live, queued, dock, awake, frozen}
     clear()  update(dt)  dispose()
   ============================================================ */

import { clamp } from '../core/contracts.js';
import { BRAND } from '../core/palette.js';
import { h, icon, C, rgba } from './style.js';

/* how long each tier sits there, in seconds */
const TOAST_LIFE = 3.9;
const ACH_LIFE = 6.4;
/* the entrance animation. The clock starts after it, so the shortest
   possible read is the full life and not life-minus-the-slide. */
const TOAST_IN = 0.42;
const ACH_IN = 0.62;
/* how many present at once. Fewer while a panel is open: the band
   above a centred sheet is about 70 px tall on a phone. */
const MAX_LIVE = 3;
const MAX_LIVE_MODAL = 2;
/* Backlog pressure. A long queue shortens what is on screen rather
   than dropping it — the alternative is a five-minute drip after
   anything that completes a dozen things at once. */
const HURRY = [
  { over: 8, mul: 0.42 },
  { over: 5, mul: 0.58 },
  { over: 2, mul: 0.76 },
];
const MIN_LIFE = 1.7;

const TIER_COLOUR = {
  good: BRAND.good, bad: BRAND.bad, money: BRAND.good,
  token: BRAND.token, info: BRAND.info, warn: BRAND.warn,
  gem: BRAND.gem,
};

export function createNotify(ctx, ui) {
  /* Parented to <body>, not to #ui: the whole point is to be outside
     the two layers the modal stack can cover. `w-root` is for the
     typography only — `.w-off` is never put on this node. */
  const layer = h('div.w-notify.w-root', { 'aria-live': 'polite' });
  const col = h('div.w-notes');
  const moreChip = h('div.w-morechip', { style: { display: 'none' } });
  /* the chip lives INSIDE the column so it flows with the cards
     rather than laying out on top of them */
  col.append(moreChip);
  layer.append(col);
  document.body.append(layer);

  const queue = [];          // waiting, in arrival order
  const live = [];           // presented, oldest first
  let seq = 0;
  let dock = '';
  let frozen = false;
  let suppressed = false;
  let obscured = null;       // predicate supplied by ui.js
  let awakeNow = true;

  /* ------------------------------------------------------------
     is anyone actually looking at this?
     ------------------------------------------------------------ */
  function hiddenScreen() {
    if (typeof document === 'undefined') return false;
    if (document.hidden) return true;
    const boot = document.getElementById('boot');
    if (boot && !boot.classList.contains('gone')) return true;
    return false;
  }
  function awake() {
    if (frozen) return false;
    if (suppressed) return false;
    if (hiddenScreen()) return false;
    if (ui && ui.visible === false) return false;
    try { if (obscured && obscured()) return false; } catch (e) {}
    return true;
  }

  /* ------------------------------------------------------------
     which dock
     ------------------------------------------------------------ */
  function wantedDock() {
    const modal = !!(ui && (ui.modal || ui.dialogueOpen));
    if (modal) return 'top';
    if (ui && ui.touch && ui.touch.enabled) return 'strip';
    return 'corner';
  }
  function syncDock() {
    const want = wantedDock();
    if (want === dock) return;
    dock = want;
    layer.classList.remove('dock-corner', 'dock-strip', 'dock-top');
    layer.classList.add('dock-' + want);
    /* Re-run the entrance on everything already up. A message that
       teleports from the bottom-left corner to the top of the frame
       when a sheet opens reads as a glitch; a message that arrives
       again, in the new place, reads as the interface getting out of
       its own way. */
    for (const it of live) replayIn(it);
  }
  function replayIn(it) {
    const el = it.el;
    el.style.animation = 'none';
    void el.offsetWidth;                    // reflow: restart the keyframes
    el.style.animation = '';
  }

  /* ------------------------------------------------------------
     building the two tiers
     ------------------------------------------------------------ */
  function buildToast(it) {
    const col2 = TIER_COLOUR[it.kind] || BRAND.info;
    return h('div.w-note.tier-toast', { dataset: { kind: it.kind } },
      h('span.bul', {
        style: { background: C(col2), boxShadow: `0 0 10px ${rgba(col2, 0.7)}` },
      }),
      h('span.tx', { text: it.text }));
  }

  function buildAch(it) {
    const col2 = TIER_COLOUR[it.kind] || BRAND.token;
    const bar = h('i.bar');
    const el = h('div.w-note.tier-ach', { dataset: { kind: it.kind } },
      h('span.sheen'),
      h('span.medal', {
        style: {
          color: C(col2),
          background: `radial-gradient(circle at 50% 34%,${rgba(col2, 0.42)},${rgba(col2, 0.13)})`,
          boxShadow: `inset 0 0 0 1.5px ${rgba(col2, 0.62)},0 0 18px ${rgba(col2, 0.28)}`,
        },
      }, icon(it.icon || 'trophy', 19)),
      h('div.w-grow', null,
        h('div.eb', { text: it.eyebrow || 'Achievement', style: { color: C(col2) } }),
        h('div.ti', { text: it.title }),
        it.sub ? h('div.sb', { text: it.sub }) : null),
      bar);
    el.style.setProperty('--nc', C(col2));
    it.bar = bar;
    return el;
  }

  /* ------------------------------------------------------------
     posting
     ------------------------------------------------------------ */
  function push(it) {
    it.id = 'n' + (seq++);
    it.seen = 0;
    queue.push(it);
    /* The queue is unbounded in principle and capped in practice: at
       fourteen the OLDEST routine toast makes way, never an
       achievement, and never anything already on screen. */
    if (queue.length > 14) {
      const i = queue.findIndex((q) => q.tier === 'toast');
      queue.splice(i >= 0 ? i : 0, 1);
    }
    pump();
    return it.id;
  }

  function toast(text, kind = 'info', opts = {}) {
    if (text == null || text === '') return null;
    return push({
      tier: 'toast', kind, text: String(text),
      life: opts.life || TOAST_LIFE, delay: TOAST_IN,
    });
  }

  function achievement(spec = {}) {
    if (!spec.title) return null;
    if (spec.replaces) promote(spec.replaces);
    return push({
      tier: 'ach',
      kind: spec.kind || 'token',
      title: String(spec.title),
      sub: spec.sub ? String(spec.sub) : '',
      eyebrow: spec.eyebrow || 'Achievement',
      icon: spec.icon || 'trophy',
      life: spec.life || ACH_LIFE, delay: ACH_IN,
      sound: spec.sound === undefined ? 'fanfare' : spec.sound,
    });
  }

  /* quests.js emits BOTH a 'note' and a 'quest' event for one act, so
     the routine toast and the achievement describe the same thing.
     The achievement wins; this drops the toast, wherever it is. */
  function promote(text) {
    const needle = String(text).toLowerCase();
    const match = (t) => t.tier === 'toast'
      && t.text.toLowerCase().replace(/^[^a-z0-9]+/, '').includes(needle);
    for (let i = queue.length - 1; i >= 0; i--) if (match(queue[i])) queue.splice(i, 1);
    for (const it of live.slice()) if (match(it)) dismiss(it, true);
  }

  /* ------------------------------------------------------------
     presenting
     ------------------------------------------------------------ */
  function capacity() { return dock === 'top' ? MAX_LIVE_MODAL : MAX_LIVE; }

  function hurry(life) {
    for (const r of HURRY) if (queue.length > r.over) return Math.max(MIN_LIFE, life * r.mul);
    return life;
  }

  function nextUp() {
    /* an achievement jumps the routine queue — but only one is ever
       on screen, so a second one waits for the first to clear */
    const achLive = live.some((l) => l.tier === 'ach');
    let i = achLive ? -1 : queue.findIndex((q) => q.tier === 'ach');
    if (i < 0) i = queue.findIndex((q) => q.tier === 'toast');
    if (i < 0) return null;
    return queue.splice(i, 1)[0];
  }

  function present(it) {
    it.el = it.tier === 'ach' ? buildAch(it) : buildToast(it);
    it.left = hurry(it.life);
    it.life = it.left;
    col.insertBefore(it.el, moreChip);      // the queue chip stays last
    live.push(it);
    if (it.tier === 'ach' && it.sound) ui.sfx?.(it.sound);
    else if (it.tier === 'toast') ui.sfx?.('ui.toast', 0.5);
  }

  function pump() {
    /* awake() and not the cached awakeNow: push() reaches pump()
       between frames, and the cached flag is a frame stale. That is
       how two quest plaques presented INTO the ending — the ending
       suppressed the layer, and the next completion in the same tick
       walked straight past a flag that had not been recomputed yet. */
    if (!awake()) { paintMore(); return; }
    /* the dock decides the cap, so it has to be current BEFORE the
       cap is read — a burst posted in the same tick a sheet opened
       used to fill to the roomier corner limit and then find itself
       in the narrow band above the sheet */
    syncDock();
    /* AN ACHIEVEMENT DOES NOT WAIT BEHIND RECEIPTS. Reaching 100 %
       queues a dozen routine toasts on its way, and a plaque that
       sits behind them arrives after the moment it belongs to. When
       one is waiting and none is on screen it gets a slot of its
       own, over the cap, and everything else keeps its place. */
    const jump = !live.some((l) => l.tier === 'ach') && queue.some((q) => q.tier === 'ach');
    const cap = capacity() + (jump ? 1 : 0);
    let guard = 8;
    while (live.length < cap && queue.length && guard-- > 0) {
      const it = nextUp();
      if (!it) break;
      present(it);
    }
    paintMore();
  }

  function dismiss(it, quick) {
    const i = live.indexOf(it);
    if (i >= 0) live.splice(i, 1);
    if (!it.el) return;
    it.el.classList.add('out');
    const el = it.el;
    setTimeout(() => el.remove(), quick ? 160 : 320);
    it.el = null;
  }

  function paintMore() {
    const n = queue.length;
    moreChip.style.display = n ? '' : 'none';
    if (n) moreChip.textContent = n === 1 ? '1 more' : n + ' more';
  }

  /* ------------------------------------------------------------
     frame
     ------------------------------------------------------------ */
  function update(dt) {
    syncDock();
    const on = awake();
    if (on !== awakeNow) {
      awakeNow = on;
      layer.classList.toggle('held', !on);
    }
    if (on) {
      for (const it of live.slice()) {
        it.seen += dt;
        if (it.seen < it.delay) continue;         // still sliding in
        it.left -= dt;
        if (it.bar) it.bar.style.transform = 'scaleX(' + clamp(it.left / it.life, 0, 1) + ')';
        if (it.left <= 0) dismiss(it);
      }
    }
    pump();
  }

  /* ------------------------------------------------------------
     public
     ------------------------------------------------------------ */
  syncDock();          // a dock before the first frame, not after it

  return {
    root: layer,
    toast, achievement, promote,
    /** The ending takes the whole screen: hold everything, and let it
        all present the moment the player comes back. */
    setSuppressed(on) {
      suppressed = !!on;
      if (suppressed) {
        /* back to the FRONT of the queue and IN THE ORDER THEY WERE
           IN — unshifting one at a time reverses them, which would
           have the player read the backlog inside out. */
        const back = live.slice().map(reseat);
        for (const it of live.slice()) dismiss(it, true);
        queue.unshift(...back);
      }
      layer.classList.toggle('hushed', suppressed);
      return suppressed;
    },
    /** Stop the clock without hiding anything — the screenshot rig. */
    freeze(on) { frozen = on !== false; return frozen; },
    /** ui.js hands us "the curtain is down" / "the boot screen is up". */
    obscuredBy(fn) { obscured = typeof fn === 'function' ? fn : null; },
    state: () => ({
      live: live.length, queued: queue.length, dock,
      awake: awakeNow, frozen, suppressed,
      top: live.map((l) => ({ tier: l.tier, text: l.text || l.title, left: +l.left.toFixed(2) })),
    }),
    clear() {
      queue.length = 0;
      for (const it of live.slice()) dismiss(it, true);
      paintMore();
    },
    update,
    dispose() { queue.length = 0; live.length = 0; layer.remove(); },
  };

  /* an item taken off the screen and put back in the queue keeps its
     text and gets a fresh clock — it was interrupted, not read */
  function reseat(it) {
    return {
      tier: it.tier, kind: it.kind, text: it.text, title: it.title,
      sub: it.sub, eyebrow: it.eyebrow, icon: it.icon,
      life: it.tier === 'ach' ? ACH_LIFE : TOAST_LIFE,
      delay: it.delay, sound: null, id: it.id, seen: 0,
    };
  }
}

export default createNotify;
