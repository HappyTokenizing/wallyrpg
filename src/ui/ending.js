/* ============================================================
   ending.js — Happy's ending. The last thing anyone sees.

   Wired to the rules layer's 'game:complete' (quests.js), which
   fires exactly once, latched in the save, when EVERYTHING is
   finished: all 24 main quests, all side quests, all 69 assets
   tokenized, and q_all latched. Its payload carries the speech, so
   nothing here retypes it:

     { speaker, role, text, links:[{label,url}], main, side,
       tokenized, day, time, netWorth, rep, forced }

   THE TEXT IS THE USER'S, VERBATIM. It is rendered as one string,
   split ONLY where a link label sits inside it, so the rendered
   textContent is character-for-character the payload's `text`.
   RWAF.ai and RWAF.xyz become real anchors — target=_blank,
   rel=noopener — underlined in token gold inside the sentence, and
   repeated underneath as two large buttons so nobody has to notice
   that a word in a paragraph was clickable. Verify with
   WALLY.debug.endingLinks().

   It replaces the old 'endgame' handler, which put two placeholder
   lines from "The City" into an ordinary dialogue card at the bottom
   of the frame — the same box a shopkeeper uses. An ending that
   looks like a shopkeeper is not an ending, so this takes the whole
   screen: the interface fades out, the city dims behind a warm wash,
   gold drifts through it, and the card assembles a beat at a time.

   The 100%-tokenized moment ('city:tokenized') is deliberately NOT
   this. That one can land with quests still open, and it gets the
   banner and a gold achievement plaque instead — see ui.js.

   API — ctx.ui.ending
     open(payload)  close()  isOpen  update(dt)  links()  dispose()
   ============================================================ */

import { BRAND } from '../core/palette.js';
import { h, icon, money, portrait, glyphAvatar, C, rgba } from './style.js';

/* Gold motes. A fixed table, not rng: two runs of the same
   screenshot have to be the same image (BUILD_BRIEF). */
const MOTES = [
  [6, 78, 13, 0], [14, 34, 9, 2.4], [21, 62, 15, 1.1], [29, 18, 7, 3.6],
  [36, 84, 11, 0.6], [44, 27, 14, 2.1], [52, 71, 8, 4.2], [58, 12, 12, 1.6],
  [66, 55, 10, 3.1], [73, 88, 16, 0.3], [80, 31, 9, 2.7], [86, 66, 13, 1.4],
  [92, 21, 11, 3.9], [11, 51, 8, 4.6], [48, 45, 7, 5.2], [64, 92, 10, 2.9],
];

/* What each link is FOR, printed under the button. Falls back to the
   host, so a link added to data.js later still gets a caption. */
const LINK_NOTE = {
  'RWAF.ai': 'More games to play',
  'RWAF.xyz': 'The RWA Foundation',
};

export function createEnding(ctx, ui) {
  const root = h('div.w-endroot', { style: { display: 'none' } });
  document.body.append(root);

  let open = false;
  let card = null;
  let anchors = [];

  /* ------------------------------------------------------------
     the speech, with two real links inside it
     ------------------------------------------------------------ */
  function speech(text, links) {
    const box = h('p.w-endtx');
    anchors = [];
    const marks = [];
    for (const l of links || []) {
      if (!l || !l.label) continue;
      let i = text.indexOf(l.label);
      while (i >= 0) {
        marks.push({ i, len: l.label.length, link: l });
        i = text.indexOf(l.label, i + l.label.length);
      }
    }
    marks.sort((a, b) => a.i - b.i);
    let cur = 0;
    for (const m of marks) {
      if (m.i < cur) continue;                       // overlapping labels
      if (m.i > cur) box.append(document.createTextNode(text.slice(cur, m.i)));
      box.append(anchor(m.link));
      cur = m.i + m.len;
    }
    if (cur < text.length) box.append(document.createTextNode(text.slice(cur)));
    return box;
  }

  function anchor(l) {
    const a = h('a.w-endlink.w-pe', {
      href: l.url, target: '_blank', rel: 'noopener noreferrer',
      text: l.label, onclick: () => ui.sfx?.('ui.click'),
    });
    anchors.push(a);
    return a;
  }

  function linkButton(l) {
    let host = '';
    try { host = new URL(l.url).hostname.replace(/^www\./, ''); } catch (e) { host = l.label; }
    const b = h('a.w-endbtn.w-pe', {
      href: l.url, target: '_blank', rel: 'noopener noreferrer',
      onclick: () => ui.sfx?.('ui.click'),
    },
      h('span.ic', null, icon('net', 17)),
      h('span.w-grow', null,
        h('span.t', { text: l.label }),
        h('span.d', { text: LINK_NOTE[l.label] || host })),
      icon('ext', 14));
    anchors.push(b);
    return b;
  }

  /* ------------------------------------------------------------
     Happy's face. The character layer registers his portrait record
     into game.data.clientById.happy (npc.js registerPortrait); the
     initial disc is the fallback if the encounter never ran.
     ------------------------------------------------------------ */
  function face(size) {
    const rec = ctx.game?.data?.clientById?.happy;
    const el = rec ? portrait(rec, size) : glyphAvatar('H', BRAND.token, size);
    return h('div.w-endpor', null, el);
  }

  /* ------------------------------------------------------------
     open
     ------------------------------------------------------------ */
  function show(p = {}) {
    if (open) return false;
    const data = ctx.game?.data?.happyEnding || {};
    const text = p.text || data.text || '';
    const links = (p.links && p.links.length ? p.links : data.links) || [];
    const speaker = p.speaker || data.speaker || 'Happy';
    const role = p.role || data.role || '';

    open = true;
    root.style.display = '';
    root.classList.remove('out');
    /* the whole interface steps off the screen — this also closes
       every open panel, so the ending is never a card over a sheet */
    try { ui.setVisible(false); } catch (e) {}
    ui.notify?.setSuppressed(true);
    ui.sfx?.('fanfare');

    const sky = h('div.w-endsky');
    const bloom = h('div.w-endbloom');
    const motes = h('div.w-endmotes');
    for (const [x, y, s, d] of MOTES) {
      motes.append(h('i', {
        style: {
          left: x + '%', top: y + '%',
          width: s + 'px', height: s + 'px',
          animationDelay: '-' + d + 's',
          animationDuration: (11 + (s % 5) * 1.7) + 's',
        },
      }));
    }

    const tally = [];
    if (p.main) tally.push(p.main.done + '/' + p.main.total + ' quests');
    if (p.side) tally.push(p.side.done + '/' + p.side.total + ' favours');
    if (p.tokenized) tally.push(p.tokenized.done + '/' + p.tokenized.total + ' tokenized');
    if (Number.isFinite(p.netWorth)) tally.push(money(p.netWorth) + ' net worth');
    if (Number.isFinite(p.rep)) tally.push(p.rep + ' reputation');

    card = h('div.w-endcard.w-pe',
      { role: 'dialog', 'aria-label': 'The end' },
      h('div.w-endhead', null,
        h('div.eb', { text: 'Bull Bear City' + (p.day ? ' · Day ' + p.day : '') }),
        h('div.big', null,
          ...'COMPLETE'.split('').map((ch, i) =>
            h('span', { text: ch, style: { animationDelay: (0.46 + i * 0.055) + 's' } }))),
        tally.length ? h('div.tal', { text: tally.join('  ·  ') }) : null),

      h('div.w-endpaper.w-paper', null,
        h('div.w-endwho', null,
          face(84),
          h('div.w-grow', null,
            h('div.nm', { text: speaker }),
            role ? h('div.rl', { text: role }) : null),
          h('span.seal', null, icon('trophy', 20))),
        speech(text, links),
        h('div.w-endlinks', null, ...links.map(linkButton))),

      /* NOT .w-btn.ghost — .ghost is two classes and would out-rank
         .w-endclose's own background, which is how this button spent
         its first render as invisible text on a dark wash. */
      h('button.w-btn.w-endclose.w-pe', {
        type: 'button',
        onclick: () => { ui.sfx?.('ui.back'); hide(); },
      }, icon('check', 15), 'Keep playing'));

    root.append(sky, bloom, motes, card);
    return true;
  }

  function hide() {
    if (!open) return false;
    open = false;
    root.classList.add('out');
    const kids = [...root.children];
    setTimeout(() => {
      for (const k of kids) k.remove();
      if (!open) { root.style.display = 'none'; root.classList.remove('out'); }
    }, 460);
    card = null;
    anchors = [];
    try { ui.setVisible(true); } catch (e) {}
    /* everything that queued up behind the ending now gets its turn */
    ui.notify?.setSuppressed(false);
    return true;
  }

  return {
    root,
    open: show,
    close: hide,
    get isOpen() { return open; },
    /** What the verifier checks: every anchor, its href and target. */
    links: () => anchors.map((a) => ({
      label: a.classList.contains('w-endbtn')
        ? a.querySelector('.t')?.textContent : a.textContent,
      href: a.getAttribute('href'),
      target: a.getAttribute('target'),
      rel: a.getAttribute('rel'),
      inline: !a.classList.contains('w-endbtn'),
    })),
    /** The rendered speech, for the verbatim assertion. */
    spoken: () => (card ? card.querySelector('.w-endtx')?.textContent || '' : ''),
    update() {},
    dispose() { hide(); root.remove(); },
  };
}

export default createEnding;
