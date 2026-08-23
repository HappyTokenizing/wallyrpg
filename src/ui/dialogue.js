/* ============================================================
   dialogue.js — the speaker card.

   Used constantly, so it has to feel good: a warm paper card at
   the bottom of the frame, a procedurally drawn portrait of the
   speaker (built from the client's own data record), typewriter
   text that any tap completes instantly, and chunky response
   buttons that are comfortable under a thumb.

   ctx.ui.dialogue(spec) -> Promise<value>

     spec.speaker   'Mabel' | 'Wally' | 'Mentor' | …
     spec.role      small line under the name
     spec.portrait  a client id, 'wally', or omitted (initial glyph)
     spec.text      string, or an array of pages
     spec.choices   [{ label, value, kind:'prim'|'ghost', disabled }]
     spec.blocking  false to allow movement while it is open

   Resolves with the chosen `value` (or null when dismissed).
   ============================================================ */

import { mulberry32 } from '../core/contracts.js';
import { h, clear, icon, portrait, glyphAvatar, wallyAvatar, hueFor } from './style.js';
/* THE 'E CONTINUE' CHIP. This card printed a hard-coded 'E' keycap
   beside CONTINUE — on a phone, at the one moment the player is most
   certainly looking at the screen. What advances a conversation now
   comes from the action table in touch.js, which knows what the
   player is holding; see the header there. */
import { paintChip, onInputMode, touchUI } from './touch.js';

/* jitter for the talk-blip cadence — seeded, so a screenshot run is
   byte-identical between builds (Math.random is banned) */
const blipRng = mulberry32(0x7a11ed);

const CPS = 62;          // characters per second
const BLIP_EVERY = 3;    // characters between talk blips

export function createDialogue(ctx, ui) {
  const root = h('div.w-dlgroot');
  let card = null;
  let live = null;
  /* the live card's "there is more" row, so a mid-session input-mode
     change repaints the card the player is reading right now */
  let repaintMore = null;
  const offInputMode = onInputMode(() => { repaintMore?.(); });

  function close(value) {
    if (!live) return;
    const l = live;
    live = null;
    repaintMore = null;
    l.el.classList.add('out');
    setTimeout(() => l.el.remove(), 280);
    card = null;
    ui.sfx('talk.end');
    ui._onDialogueClose?.();
    l.resolve(value);
  }

  function open(spec = {}) {
    if (live) close(null);

    const pages = Array.isArray(spec.text) ? spec.text.slice() : [String(spec.text ?? '')];
    const speaker = spec.speaker || 'Wally';
    const choices = spec.choices || null;

    /* ---- portrait ---- */
    const por = h('div.w-dlg-por');
    por.append(makeAvatar(ctx, spec, speaker));

    const nm = h('div.w-dlg-nm', { text: speaker });
    const rl = spec.role ? h('div.w-dlg-rl', { text: spec.role }) : null;
    const tx = h('div.w-dlg-tx');
    const more = h('div.w-dlg-more', { style: { display: 'none' } });
    const chBox = h('div.w-dlg-ch');

    /* The ghost span holds the whole page at zero visibility, so the
       card is already the size it will end at and does not reflow a
       line at a time while the typewriter runs. The live span is
       absolutely positioned on top of it. */
    let ghost = null, lv = null, moreLabel = null;

    const el = h('div.w-dlg.w-paper.w-pe', { role: 'dialog', 'aria-live': 'polite' },
      h('div.w-dlg-in', null, por, h('div.w-grow', null, nm, rl, tx)),
      chBox, more);

    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.w-btn')) return;
      advance();
    });

    root.append(el);
    card = el;
    ui._onDialogueOpen?.();
    ui.sfx('ui.open');
    ctx.audio?.duckFor?.(1.2, 0.45);

    live = { el, resolve: () => {}, pages, page: -1, chars: 0, full: '', typing: false, blip: 0 };
    const promise = new Promise((res) => { live.resolve = res; });
    repaintMore = () => { if (moreLabel) setMore(moreLabel); };

    nextPage();

    function nextPage() {
      live.page++;
      if (live.page >= live.pages.length) { finish(); return; }
      live.full = live.pages[live.page];
      live.chars = 0;
      live.typing = true;
      clear(tx);
      ghost = h('span.gh', { text: live.full });
      lv = h('span.lv', null, document.createTextNode(''), h('span.car'));
      tx.append(ghost, lv);
      setMore(null);
      chBox.style.display = 'none';
    }

    function paint() {
      lv.firstChild.nodeValue = live.full.slice(0, Math.floor(live.chars));
    }

    /* null clears the row; otherwise "how to see the rest", in the same
       treatment as the world-space prompt.

       ON A KEYBOARD that is a keycap and a verb: [E] Continue.
       UNDER A THUMB the keycap goes entirely rather than being
       translated — the whole card advances on tap, so the row says so
       in words and stops pretending there is a key to press. */
    function setMore(label) {
      moreLabel = label || null;
      clear(more);
      if (!label) { more.style.display = 'none'; return; }
      more.style.display = '';
      const chip = paintChip(h('span.key'), 'advance', { hideOnTouch: true });
      more.append(chip, h('span', {
        text: touchUI() ? 'Tap to ' + String(label).toLowerCase() : label,
      }));
    }

    function complete() {
      live.chars = live.full.length;
      paint();
      live.typing = false;
      const car = lv.querySelector('.car');
      if (car) car.remove();
      if (live.page < live.pages.length - 1) {
        setMore('Continue');
      } else {
        setMore(null);
        showChoices();
      }
    }

    function showChoices() {
      clear(chBox);
      chBox.style.display = '';
      const list = choices && choices.length ? choices : [{ label: spec.dismiss || 'Continue', value: null, kind: 'prim' }];
      for (const c of list) {
        const b = h('button.w-btn.w-pe' + (c.kind === 'ghost' ? '.ghost' : c.kind === 'dark' ? '.dark' : c.kind === 'prim' || list.length === 1 ? '.prim' : ''), {
          type: 'button',
          disabled: !!c.disabled,
          title: c.why || '',
          onclick: (ev) => {
            ev.stopPropagation();
            ui.click();
            const v = c.value !== undefined ? c.value : c.label;
            if (c.onPick) { try { c.onPick(v); } catch (e) { console.error('[ui] choice threw', e); } }
            close(v);
          },
        }, c.icon ? icon(c.icon, 15) : null, c.label);
        chBox.append(b);
      }
      /* first choice takes focus so a keyboard player can just hit Enter */
      chBox.firstChild?.focus?.({ preventScroll: true });
    }

    function advance() {
      if (!live) return;
      if (live.typing) { complete(); ui.sfx('ui.tab'); return; }
      if (live.page < live.pages.length - 1) { nextPage(); ui.sfx('ui.tab'); return; }
      /* only auto-dismiss when there is a single implicit choice */
      if (!choices || !choices.length) close(null);
    }

    function finish() { close(null); }

    live.tick = (dt) => {
      if (!live.typing) return;
      live.chars += CPS * dt * (ctx.game?.state?.settings?.reduced ? 6 : 1);
      const n = Math.floor(live.chars);
      if (n >= live.full.length) { complete(); return; }
      paint();
      live.blip += 1;
      if (n - live.blip >= 0) {
        live.blip = n + BLIP_EVERY + (blipRng() < 0.5 ? 0 : 1);
        const ch = live.full[n] || ' ';
        if (ch !== ' ' && ch !== '\n') ui.sfx(n % 7 === 0 ? 'talk.low' : 'talk.blip', 0.34);
      }
    };
    live.advance = advance;
    live.complete = complete;

    return promise;
  }

  return {
    root,
    open,
    close,
    get open_() { return !!live; },
    get isOpen() { return !!live; },
    /** Complete the line, then the page, then dismiss. Reached from the
        keyboard's interact key and from the pad's corner button alike —
        ui.interact() is the one door both go through. */
    advance() { live?.advance(); },
    update(dt) { live?.tick(dt); },
    dispose() { offInputMode(); root.remove(); },
  };
}

/* Build the best avatar we can for a speaker: a real client portrait,
   the Wally mark, or a coloured initial. */
function makeAvatar(ctx, spec, speaker) {
  const byId = ctx.game?.data?.clientById;
  let c = null;
  if (spec.portrait && spec.portrait !== 'wally' && byId) c = byId[spec.portrait];
  if (!c && byId) c = Object.values(byId).find((x) => x.n === speaker) || null;

  /* HIS PORTRAIT IS THE SAME OBJECT AS EVERYONE ELSE'S. This branch
     used to hand-build a disc — a two-stop blue gradient with the mark
     dropped in and nudged down 4 % — which beside portrait(c, 66) in
     the same card read as a logo that had wandered into a cast list:
     no white keyline ring, no ground shadow, nothing running off the
     bottom edge the way a portrait's neck does. style.js draws that
     disc for the phone already; this is the same call, at the same 66
     the client branch below uses, so the two can never diverge again. */
  if (spec.portrait === 'wally' || /^wally$/i.test(speaker)) return wallyAvatar(66);
  if (c) return portrait(c, 66);
  return glyphAvatar((speaker[0] || '?').toUpperCase(), hueFor(speaker), 66);
}
