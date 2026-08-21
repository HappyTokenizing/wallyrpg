/* ============================================================
   titlecard.js — the WALLY RPG title lockup, the skip chip and the
   film veil. DOM over the canvas, inside #overlay (z-index 20), so it
   draws above the letterbox bars (z-index 8) and the HUD (10).

   ------------------------------------------------------------------
   WHY THE LETTERS ARE DRAWN, NOT SET
   ------------------------------------------------------------------
   The game ships no font files (BUILD_BRIEF: "No external assets"),
   so `font-family:'Baloo 2'` in index.html resolves to whatever the
   machine happens to have — SF Pro here, Segoe there, DejaVu on a
   Linux CI box. A title card whose letterforms change per machine is
   not a designed mark, and the one screenshot people take of this
   game would be a different image every time.

   So the seven glyphs of W A L L Y / R P G are drawn as SVG outlines
   on a 100-unit cap height with a 26-unit stem: a heavy geometric
   sans with flat terminals, pointed W/A apexes and generous counters.
   Vector, therefore exact at 1080p and at 4K, identical everywhere,
   and it can carry a gradient, a hard offset plate and a moving
   specular sweep that live text could not.

   Counters (the holes in R, P, G and A) are punched with an SVG
   <mask> rather than by winding a subpath backwards: a mask is a
   painted image, so hole-then-restore ordering is explicit and the
   G's crossbar can be painted back over the counter it crosses. That
   is the whole reason the G reads.

   Colour comes from palette.js and nowhere else — BRAND.paper for the
   face, SKY.dawn for the warm falloff (the card lands at sunrise),
   BRAND.token #F5913C for RPG and the rules, BRAND.token2 for the
   hard plate under the letters, which is the one thing carried over
   literally from the original arcade title.
   ============================================================ */

import { BRAND, SKY, css } from '../core/palette.js';

/* ------------------------------------------------------------------
   The face. Cap height 100, stem 26, y down, origin at the cap line.
   `s` fills, `h` punches, `r` paints back over `h`.
   ------------------------------------------------------------------ */
const GLYPHS = {
  /* Pointed apexes: the W's two V-bottoms and its middle peak are
     single points, not the flat 26-wide cuts a naive stroke offset
     produces. That is the difference between a W and a plumbing
     diagram. */
  W: { w: 128, s: '<path d="M0 0H26L46 64L64 20L82 64L102 0H128L90 100L64 58L38 100Z"/>' },

  /* The crossbar sits at 56-78, not 62-86. At 86 there were only 14
     units of leg under the bar against a 31-unit counter over it, and
     the A read as a triangle standing on a plinth. */
  A: {
    w: 112,
    s: '<path d="M43 0H69L26 100H0Z"/><path d="M43 0H69L112 100H86Z"/>' +
       '<path d="M22 56H90V78H22Z"/>',
    h: '<path d="M56 31L68 56H44Z"/>',
  },

  L: { w: 78, s: '<path d="M0 0H26V74H78V100H0Z"/>' },

  Y: {
    w: 96,
    s: '<path d="M0 0H26L61 50H35Z"/><path d="M70 0H96L61 50H35Z"/>' +
       '<path d="M35 46H61V100H35Z"/>',
  },

  /* Bowl radius 31, counter radius 11 — a 20-unit bar top and bottom,
     matching the 26 stem closely enough that the weight reads even. */
  R: {
    w: 104,
    s: '<path d="M0 0H26V100H0Z"/><path d="M13 0H56A31 31 0 0 1 56 62H13Z"/>' +
       '<path d="M40 50H68L100 100H72Z"/>',
    h: '<path d="M26 20H56A11 11 0 0 1 56 42H26Z"/>',
  },

  P: {
    w: 92,
    s: '<path d="M0 0H26V100H0Z"/><path d="M13 0H56A31 31 0 0 1 56 62H13Z"/>',
    h: '<path d="M26 20H56A11 11 0 0 1 56 42H26Z"/>',
  },

  /* One disc, one counter, one radial slot for the aperture, and then
     the crossbar painted BACK ON over the counter it crosses. Drawn
     any other way the bar is eaten by its own counter. */
  G: {
    w: 112,
    s: '<ellipse cx="55" cy="50" rx="55" ry="50"/>',
    h: '<ellipse cx="55" cy="50" rx="29" ry="26"/>' +
       '<rect x="0" y="-11" width="96" height="22" transform="translate(55,50) rotate(-27)"/>',
    r: '<rect x="50" y="39" width="58" height="22"/>',
  },
};

const TRACK = 16;          // units between glyph advances at cap 100

/* KERNING. Advance widths alone are not a setting. W's right edge
   recedes from x=128 at the cap line to x=90 at the baseline, and A's
   left edge runs the other way, so W + A at a flat 16-unit track opens
   a 56-unit hole — twice the stem — and the word visibly falls in two.
   Measured off the outlines, not eyeballed: each value here brings the
   pair's narrowest gap back to roughly one stem width. */
const KERN = { WA: -30, AL: -8, LY: -26, RP: -6, PG: -8 };

/* Lay a word out and return the three ink layers plus its width. */
function setWord(word) {
  let x = 0, s = '', h = '', r = '', prev = '';
  for (const ch of word) {
    const g = GLYPHS[ch];
    if (!g) { x += 60 + TRACK; prev = ch; continue; }
    if (prev) x += KERN[prev + ch] || 0;
    const open = `<g transform="translate(${x},0)">`;
    s += open + g.s + '</g>';
    if (g.h) h += open + g.h + '</g>';
    if (g.r) r += open + g.r + '</g>';
    x += g.w + TRACK;
    prev = ch;
  }
  return { s, h, r, w: x - TRACK };
}

/* One masked, filled word. `id` must be unique in the document. */
function wordSVG(id, word, x, y, scale, fill, sheen) {
  const m = setWord(word);
  const mask =
    `<mask id="${id}" maskUnits="userSpaceOnUse" x="-40" y="-40" ` +
    `width="${m.w + 80}" height="180">` +
    `<g fill="#fff">${m.s}</g><g fill="#000">${m.h}</g><g fill="#fff">${m.r}</g>` +
    `</mask>`;
  const body =
    `<g mask="url(#${id})">` +
    `<rect x="-40" y="-40" width="${m.w + 80}" height="180" fill="${fill}"/>` +
    (sheen
      ? `<rect class="${sheen.cls}" x="-260" y="-60" width="120" height="230" ` +
        `fill="url(#${sheen.id})" transform="skewX(-16)"/>`
      : '') +
    `</g>`;
  return {
    w: m.w,
    defs: mask,
    node: `<g transform="translate(${x},${y}) scale(${scale})">${body}</g>`,
  };
}

/* ------------------------------------------------------------------
   THE LOCKUP — the product mark, WALLY RPG.

   WALLY over a hard offset plate; RPG centred beneath it on the same
   optical axis, between two rules that fade away from it. The small
   word is what makes the mark read as a *title* rather than as a
   name: at 0.30 scale its cap height lands near the big word's stem
   weight, which is the ratio that makes a subtitle look set instead
   of merely shrunk. The rules stop 26 units short of it on each side
   so the eye finishes the line through the word.

   Exported because the loading screen in index.html draws the SAME
   mark. The first thing a player sees and the title they see thirty
   seconds later have to be one designed object, not two drawings of
   the same word.

   `prefix` namespaces every id and class, so two lockups can share
   one document without their masks and gradients colliding:
     'ic' — the intro title card (this file)
     'bm' — the boot mark (index.html)
   ------------------------------------------------------------------ */
export function wordmarkSVG({
  prefix = 'ic',
  paper = '#f7efe0', dawn = '#ffd0a0',
  token = '#f5913c', token2 = '#d96f1e',
  sheen = true, label = 'WALLY RPG',
} = {}) {
  const VW = 640, VH = 196;
  const wallyX = (VW - setWord('WALLY').w) / 2;
  const rpgScale = 0.30;
  const rpgW = setWord('RPG').w * rpgScale;
  const rpgX = (VW - rpgW) / 2;
  const RULE_Y = 147;

  const sh = sheen ? { id: `${prefix}-sheen`, cls: `${prefix}-sheen` } : null;
  const big = wordSVG(`${prefix}-mw`, 'WALLY', wallyX, 6, 1, `url(#${prefix}-face)`, sh);
  const plate = wordSVG(`${prefix}-mp`, 'WALLY', wallyX, 15, 1, token2, null);
  const small = wordSVG(`${prefix}-mr`, 'RPG', rpgX, 132, rpgScale, token, null);

  return (
    `<svg class="${prefix}-mark" viewBox="0 0 ${VW} ${VH}" role="img" ` +
    `aria-label="${label}" xmlns="http://www.w3.org/2000/svg">` +
    `<defs>` +
      `<linearGradient id="${prefix}-face" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0" stop-color="${paper}"/>` +
        `<stop offset="0.58" stop-color="${paper}"/>` +
        `<stop offset="1" stop-color="${dawn}"/>` +
      `</linearGradient>` +
      (sheen
        ? `<linearGradient id="${prefix}-sheen" x1="0" y1="0" x2="1" y2="0">` +
            `<stop offset="0" stop-color="#fff" stop-opacity="0"/>` +
            `<stop offset="0.5" stop-color="#fff" stop-opacity="0.62"/>` +
            `<stop offset="1" stop-color="#fff" stop-opacity="0"/>` +
          `</linearGradient>`
        : '') +
      `<linearGradient id="${prefix}-rule" x1="0" y1="0" x2="1" y2="0">` +
        `<stop offset="0" stop-color="${token}" stop-opacity="0"/>` +
        `<stop offset="1" stop-color="${token}" stop-opacity="0.95"/>` +
      `</linearGradient>` +
      `<linearGradient id="${prefix}-rule2" x1="0" y1="0" x2="1" y2="0">` +
        `<stop offset="0" stop-color="${token}" stop-opacity="0.95"/>` +
        `<stop offset="1" stop-color="${token}" stop-opacity="0"/>` +
      `</linearGradient>` +
      big.defs + plate.defs + small.defs +
    `</defs>` +
    plate.node + big.node +
    `<rect class="${prefix}-rule" x="54" y="${RULE_Y}" ` +
      `width="${rpgX - 54 - 26}" height="3" fill="url(#${prefix}-rule)"/>` +
    `<rect class="${prefix}-rule" x="${rpgX + rpgW + 26}" y="${RULE_Y}" ` +
      `width="${VW - 54 - (rpgX + rpgW + 26)}" height="3" fill="url(#${prefix}-rule2)"/>` +
    small.node +
    `</svg>`
  );
}

/* ------------------------------------------------------------------ */

export function createTitleCard(ctx) {
  if (typeof document === 'undefined') return nullCard();

  const paper = css(BRAND.paper);
  const dawn = css(SKY.dawn);
  const token = css(BRAND.token);
  const token2 = css(BRAND.token2);
  const ink = css(BRAND.ink);

  const svg = wordmarkSVG({ prefix: 'ic', paper, dawn, token, token2, sheen: true });

  /* --- DOM ------------------------------------------------------- */
  const root = document.createElement('div');
  root.id = 'introOverlay';
  root.innerHTML =
    `<div class="ic-veil"></div>` +
    `<div class="ic-card">` +
      `<div class="ic-scrim"></div>` +
      svg +
      `<div class="ic-tag">TWO HUNDRED AND FIFTY DOLLARS &middot; ONE BICYCLE &middot; NO REPUTATION</div>` +
    `</div>` +
    `<div class="ic-skip">PRESS ANY KEY TO SKIP</div>`;

  const style = document.createElement('style');
  style.id = 'introOverlayCss';
  style.textContent = `
#introOverlay{position:fixed;inset:0;z-index:30;pointer-events:none;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
#introOverlay .ic-veil{position:absolute;inset:0;background:${ink};opacity:1;
  transition:opacity .9s cubic-bezier(.4,0,.2,1)}
#introOverlay .ic-card{position:absolute;left:50%;top:30%;transform:translate(-50%,-50%);
  width:min(50vw,660px);display:flex;flex-direction:column;align-items:center;
  opacity:0;filter:blur(9px);
  transition:opacity .1s linear}
#introOverlay .ic-card.on{
  animation:ic-in .82s cubic-bezier(.16,1.02,.3,1) both}
@keyframes ic-in{
  0%  {opacity:0;filter:blur(11px);transform:translate(-50%,-50%) scale(1.085)}
  46% {opacity:1;filter:blur(0)}
  100%{opacity:1;filter:blur(0);transform:translate(-50%,-50%) scale(1)}}
#introOverlay .ic-card.off{opacity:0;filter:blur(6px);
  transition:opacity .55s ease,filter .55s ease}
/* The card lands over grass in full morning sun. A gradient alone did
   not hold the type: the scrim also pulls the plate down and takes the
   chroma out of it, which is what a real lower-third does. */
#introOverlay .ic-scrim{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  width:190%;height:250%;pointer-events:none;
  -webkit-mask-image:radial-gradient(52% 46% at 50% 46%,#000 0%,rgba(0,0,0,.55) 58%,transparent 82%);
  mask-image:radial-gradient(52% 46% at 50% 46%,#000 0%,rgba(0,0,0,.55) 58%,transparent 82%);
  backdrop-filter:blur(7px) saturate(.55) brightness(.62);
  -webkit-backdrop-filter:blur(7px) saturate(.55) brightness(.62);
  background:radial-gradient(52% 46% at 50% 46%,
    rgba(10,13,22,.34) 0%,rgba(10,13,22,.18) 58%,rgba(10,13,22,0) 82%)}
#introOverlay .ic-mark{position:relative;width:100%;height:auto;display:block;
  filter:drop-shadow(0 14px 30px rgba(8,10,18,.55)) drop-shadow(0 0 44px rgba(245,145,60,.20))}
#introOverlay .ic-sheen{animation:ic-sheen 7.5s cubic-bezier(.5,0,.5,1) 1.1s infinite}
@keyframes ic-sheen{
  0%  {transform:skewX(-16deg) translateX(0)}
  26% {transform:skewX(-16deg) translateX(1100px)}
  100%{transform:skewX(-16deg) translateX(1100px)}}
#introOverlay .ic-tag{position:relative;margin-top:2.6%;
  font-size:clamp(7.5px,.72vw,11.5px);letter-spacing:.34em;text-indent:.34em;
  color:${paper};opacity:.72;white-space:nowrap;text-align:center;
  text-shadow:0 1px 3px rgba(8,10,18,.95),0 0 16px rgba(8,10,18,.9)}
#introOverlay .ic-skip{position:absolute;right:calc(26px + env(safe-area-inset-right));
  bottom:calc(30px + env(safe-area-inset-bottom));
  font-size:10.5px;letter-spacing:.22em;color:${paper};opacity:0;
  padding:7px 13px;border-radius:8px;border:1px solid rgba(247,239,224,.22);
  background:rgba(10,13,22,.34);backdrop-filter:blur(3px);
  transition:opacity .7s ease}
#introOverlay .ic-skip.on{opacity:.62}
/* The HUD belongs to ui/ui.js and must not be over a cinematic. This
   is a class on <body>, not a write into their module: they get their
   own element back, untouched, the moment the class comes off. */
body.wally-intro #ui{opacity:0;transition:opacity .4s ease}
#ui{transition:opacity .5s ease}
@media (prefers-reduced-motion:reduce){
  #introOverlay .ic-card.on{animation:none;opacity:1;filter:none}
  #introOverlay .ic-sheen{animation:none;opacity:0}
}`;

  document.head.appendChild(style);
  (document.getElementById('overlay') || document.body).appendChild(root);

  const veil = root.querySelector('.ic-veil');
  const card = root.querySelector('.ic-card');
  const skip = root.querySelector('.ic-skip');

  let shown = false;

  const api = {
    root,

    /** Opacity of the full-frame ink veil. `dur` in seconds. */
    setVeil(a, dur = 0.9) {
      veil.style.transitionDuration = `${Math.max(0, dur)}s`;
      /* Force a style flush so a 0 s veil really is instant rather
         than inheriting the previous transition. */
      void veil.offsetWidth;
      veil.style.opacity = String(Math.max(0, Math.min(1, a)));
      return api;
    },

    /** Land the title. Restarting the animation needs the class off
        for one frame or Chrome keeps the finished keyframe state. */
    show() {
      if (shown) return api;
      shown = true;
      card.classList.remove('off');
      card.classList.remove('on');
      void card.offsetWidth;
      card.classList.add('on');
      return api;
    },

    hide(instant = false) {
      if (!shown && !instant) return api;
      shown = false;
      card.classList.remove('on');
      card.classList.add('off');
      if (instant) card.style.transition = 'none';
      return api;
    },

    get visible() { return shown; },

    hint(on = true) { skip.classList.toggle('on', !!on); return api; },

    /** Hide/show the game's own chrome for the duration. */
    chrome(on) { document.body.classList.toggle('wally-intro', !on); return api; },

    dispose() {
      document.body.classList.remove('wally-intro');
      root.remove();
      style.remove();
    },
  };

  return api;
}

function nullCard() {
  const api = {
    root: null,
    setVeil: () => api, show: () => api, hide: () => api,
    hint: () => api, chrome: () => api, dispose: () => {}, visible: false,
  };
  return api;
}

export default createTitleCard;
