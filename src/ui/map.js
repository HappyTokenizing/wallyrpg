/* ============================================================
   map.js — THE CHART OF BULL BEAR CITY.

   The Places screen used to be a list of buttons grouped by district,
   which is a table of contents, not a map. Then it was a diagram: sea,
   an ellipse, ten pastel blobs, twenty-eight dots. It answered the four
   questions a player opens a map to ask — where is that, how far, what
   is near it, which way do I walk — and it answered them in the voice of
   a settings panel.

   THIS IS A PRINTED OBJECT. One commitment, held everywhere: the chart
   is a plate pulled on aged stock and folded into Wally's pocket. That
   decides everything else.

     · The coastline is drawn, not computed — the same ellipse the world
       is built on, walked at 72 stations with four harmonics of wobble
       laid over it, so it reads as a pen line that followed a coast
       rather than a shape a compass made. The wobble is biased outward
       (r stays above 0.98) because every location is asserted to be on
       dry land by tools/test-game.mjs and the drawing must not
       contradict the simulation.
     · The sea is a wash with engraved coast lines — five contours of the
       coastline itself, each fainter and more broken than the last. That
       is how a chart says "water" without spending any of the island's
       room, which matters here: the island fills nine tenths of the
       frame and the sea is four corners.
     · Districts are washes with an engraver's hatch, each at its own
       angle, plus a little ink drawing of what the district IS — a
       headframe at Iron Hills, a dock crane at the Waterfront, a stadium
       bowl at the Stampede, three sheaves at Green Edge. All ten are
       procedural paths in a 44x40 box, placed at the point inside the
       district furthest from that district's own pins.
     · UNDISCOVERED IS BLANK PAPER. No grey question marks. An unsurveyed
       district has no wash, no hatch, no name and no pins — only a ghost
       of its outline, a sparse stipple and its drawing at a tenth
       strength. Finding a place inks its district in. Proximity
       discovery is arriving this round; this is what makes it land.
     · Wally is not a dot. He is the mark — head-ball, ears, wayfarers,
       the glint — die-cut on a paper sticker and pressed onto the chart.
     · A compass rose with a faceted eight-point star and an orange north,
       a title cartouche with clipped corners and a double rule, a plate
       mark with graticule ticks, a soft drop under the island, and the
       whole sheet carrying the game's own grain tile (style.js).

   Typography is the press face (--w-serif), tracked and set in caps.
   Everything is derived from data.js — no image assets, no Math.random,
   one <svg>, rebuilt only when the selection changes.

   PUBLIC
     cityMap(ctx, opts) -> { el, svg, select(id), selected, refresh }
       opts.compact   no per-location labels (the phone)
       opts.selected  location id to highlight
       opts.onPick    (locId) => void
       opts.height    css height
   ============================================================ */

import { BRAND, SEA, LAND, SHADOW } from '../core/palette.js';
import { mulberry32 } from '../core/contracts.js';
import { h, rgba, mix, C, wallyMarkup, wallyKeyline } from './style.js';

const NS = 'http://www.w3.org/2000/svg';

/* ------------------------------------------------------------
   THE PLATE IS CUT TO THE PAPER IT IS PRINTED ON.

   The first version padded the board by two constants — 140 and 186 —
   which made one plate, 1.24:1, and handed it to every screen. On a
   390x844 phone that plate is 315 px wide and 254 px tall: a third of
   the screen, with the title and the rose crammed into the two slivers
   of sea beside the coast and the place names printing at six pixels.

   So the padding is no longer a constant. The island is a fixed
   ellipse — it cannot grow past the width of a phone, and cropping the
   coast is not on the table (the whole holding has to close inside the
   sheet). What CAN change is how much sea is printed around it and
   where the furniture stands in that sea. The plate is now cut to the
   box it is given: the tight axis keeps a fixed hairline of sea, the
   loose axis opens into a band, and the cartouche and the compass rose
   — both anchored to plate corners — move out of the coast's way and
   into that band as it opens. A portrait phone gets a portrait plate
   with a title band over the north coast and the rose riding the sea
   to the south; a phone on its side gets a landscape plate with the
   furniture out east and west. Same drawing, cut for the pocket it is
   folded into.

   RMAX is the maximum of coastR() — the furthest the drawn coast can
   get from the centre — so the island's true half-extent is known
   exactly rather than guessed at. MARGIN is the sea kept on the tight
   axis, as a fraction of that half-extent.
   ------------------------------------------------------------ */
const RMAX = 1.108;
const MARGIN = 0.072;

/* Two charts can be alive at once (the phone's Places app behind the
   full sheet). Gradient and pattern ids are document-global, so they
   carry an instance number or the second chart repaints the first. */
let INSTANCE = 0;

const n1 = (v) => (Math.round(v * 10) / 10);

/* deterministic per-zone wobble phase — never Math.random */
function phase(s) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
  return ((x >>> 0) % 6283) / 1000;
}

/* ------------------------------------------------------------
   DISTRICT COLOUR.

   The ten zone tints in data.js are muted architectural browns and
   slates — #6E5B46, #5E6880, #6E6A50 — which is right for a
   building's stucco and wrong for a district's patch on a chart:
   laid over cream at 20 % they were, measured against each other in
   the first shot of this screen, ten shades of the same grey. The
   HUE is the part that carries the identity, so the hue is kept and
   the chroma is opened up. Nothing is invented; each colour is
   still its own zone's colour, said out loud.
   ------------------------------------------------------------ */
function boost(hex) {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let hh = 0;
  if (d) {
    if (mx === r) hh = ((g - b) / d + (g < b ? 6 : 0));
    else if (mx === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh /= 6;
  }
  const l = 0.47, s = Math.min(0.68, ((mx + mn) ? d / (1 - Math.abs(mx + mn - 1)) : 0) * 2.6 + 0.22);
  const q = l + s * 0.5, p = 2 * l - q;
  const f = (t) => {
    t = (t + 1) % 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t
      : t < 0.5 ? q
        : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  return ((Math.round(f(hh + 1 / 3) * 255) << 16)
    | (Math.round(f(hh) * 255) << 8)
    | Math.round(f(hh - 1 / 3) * 255)) >>> 0;
}

/* ------------------------------------------------------------
   THE DISTRICT DRAWINGS.

   Ten pen sketches, each in a 44 wide x 40 tall box standing on a
   baseline at y=37, stroked only — no fills, so they read as one hand
   at any size and cost nothing to tint. A district's drawing is the
   fastest way to say what it is: you do not read "IRON HILLS", you see
   a headframe. Keyed by zone id, so a district added to data.js
   degrades to no drawing rather than to a wrong one.
   ------------------------------------------------------------ */
const MOTIF = {
  /* a leaning tenement with a stovepipe still going */
  rustyrow: [
    'M7 37V17h21v20', 'M4 18 17 8l14 10', 'M23 12V5h5v4',
    'M25.4 3.2c4.6-2-1-5.6 3.6-8', 'M12 22h6v6h-6z', 'M20 37v-8h6v8', 'M31 37l6-4',
  ],
  /* three facades and the street clock */
  mainstreet: [
    'M4 37V19h9v18', 'M15 37V10h11v27', 'M28 37V22h10v15',
    'M24.1 16.4a3.6 3.6 0 1 1-7.2 0 3.6 3.6 0 1 1 7.2 0', 'M20.5 16.4v-2.5', 'M20.5 16.4l2.1 1.2',
    'M4 25h9', 'M28 27.5h10',
  ],
  /* an open book */
  learning: [
    'M4 13c6-3.4 12-2.4 17 1.8v19c-5-4-11-4.8-17-1.8z',
    'M38 13c-6-3.4-12-2.4-17 1.8v19c5-4 11-4.8 17-1.8z',
    'M9 19h8M9 24h8M25 19h8M25 24h8',
  ],
  /* a stall: scalloped awning, a crate, a pennant */
  marketsq: [
    'M6 37V19M36 37V19',
    'M3 19c2.2 5.4 6.8 5.4 9 0 2.2 5.4 6.8 5.4 9 0 2.2 5.4 6.8 5.4 9 0 2.2 5.4 6.8 5.4 9 0',
    'M13 37v-8h13v8z', 'M13 33h13', 'M21 19v-9', 'M21 10l9 3-9 3',
  ],
  /* three sheaves, tied */
  greenedge: [
    'M13 37c-3-9-2.6-15.4-1-19.6', 'M21 37c0-10.6.2-16.6.4-21', 'M29 37c3-9 2.6-15.4 1-19.6',
    'M12.2 26c5.4 2.4 11.6 2.4 17.6 0',
    'M12 17.4c-2.6-2.6-1.8-5.6.4-7 2 1.6 2.4 4.6-.4 7z',
    'M21.4 16c-2.8-2.8-2-6 .2-7.6 2.2 1.8 2.6 4.8-.2 7.6z',
    'M30.6 17.4c-2.8-2.6-2-5.6.2-7 2 1.6 2.4 4.6-.2 7z',
    'M5 37h32',
  ],
  /* a mine headframe over the hills */
  ironhills: [
    'M2 31c5-9.6 10-9.6 15-1.6 4.4-7 9.4-8 13.6 1',
    'M11 37 20 13l9 24', 'M14.6 27h11', 'M16.8 20.4h6.6',
    'M24 11.4a4 4 0 1 1-8 0 4 4 0 1 1 8 0', 'M20 15.4v9',
    'M4 37h33',
  ],
  /* a dock crane, a bollard, two swells */
  waterfront: [
    'M12 37V8', 'M12 8l21 6.4', 'M12 8 6 20', 'M6 20h13',
    'M30 13.4v9.4', 'M27.8 22.8h4.6', 'M5 37h15',
    'M22 31c3-2.2 6-2.2 9 0M22 36c3-2.2 6-2.2 9 0',
  ],
  /* a signal tower, transmitting */
  innovation: [
    'M13 37 20 10l7 27', 'M15.6 29h9', 'M17.4 21h5.4', 'M20 10V5',
    'M25.6 5.4c4 3 4 9 0 12', 'M29.4 1.8c6 5 6 13.6 0 18.6',
    'M14.4 5.4c-4 3-4 9 0 12', 'M8 37h24',
  ],
  /* the bowl and its floodlights */
  stampede: [
    'M38 27a16 9 0 1 1-32 0 16 9 0 1 1 32 0',
    'M30 27a8 4.4 0 1 1-16 0 8 4.4 0 1 1 16 0',
    'M22 18v3.6M22 32.4V36M6.4 27H3M41 27h-3.4',
    'M7 19V6M3.6 6h7v3.6h-7z', 'M37 19V6M33.4 6h7v3.6h-7z',
  ],
  /* the tower where the money already lives */
  goldenheights: [
    'M14 37V15h15v22', 'M17 15v-5h9v5', 'M20 10V6h3v4', 'M21.5 6V2',
    'M17.4 21h8.2M17.4 27h8.2M17.4 33h8.2',
    'M40 32.6a3.6 3.6 0 1 1-7.2 0 3.6 3.6 0 1 1 7.2 0', 'M36.4 29.6v6',
    'M8 37h32',
  ],
};

/* The countryside between the districts, drawn the way a surveyor fills
   country he crossed but did not stop in: a wood, a fir, a pair of
   hills. Local box is 16 wide standing on y=13. */
const FLECK = [
  ['M8 13V9', 'M4.6 8.2a3.4 3.4 0 1 1 6.8 0 3.4 3.4 0 1 1-6.8 0'],
  ['M8 13v-3.4', 'M8 1.6 4.2 9.6h7.6z'],
  ['M1.6 12.4c2.2-4.4 4.8-4.4 7 0', 'M6.6 12.4c2.2-4 4.8-4 7 0'],
  ['M8 13V8.6', 'M3.4 8.6c0-3 2-5 4.6-5s4.6 2 4.6 5z'],
];

/* ============================================================ */

export function cityMap(ctx, opts = {}) {
  const game = ctx.game;
  const D = game.data;
  const MAP = D.map, W = D.world;
  const compact = !!opts.compact;
  const U = '-' + (++INSTANCE);

  /* island ellipse, in board units (data.js states it in metres) */
  const ISL = {
    cx: W.originMapX, cy: W.originMapY,
    rx: W.islandRadiusX / W.scale, ry: W.islandRadiusZ / W.scale,
    beach: W.beachWidth / W.scale,
  };
  /* the drawn coast's true half-extents */
  const HX = ISL.rx * RMAX, HY = ISL.ry * RMAX;

  /* Everything below is cut by layout(), which runs before every paint
     and reads the box the caller actually gave us. `ppu` is pixels per
     board unit — the number that turns a type size in PIXELS, which is
     the only unit a reader has, into the board units the drawing is in. */
  let vb = { x: ISL.cx - HX * 1.07, y: ISL.cy - HY * 1.07, w: HX * 2.14, h: HY * 2.14 };
  let ppu = 0.26;
  let T = null, ROSE = null, CART = null, SEABAND = 1.06;
  let layKey = '';

  /* ---------- the ink and the stock ---------- */
  const ink = BRAND.ink;
  const seaLo = C(mix(SEA.shallow, BRAND.paper, 0.50));
  const seaHi = C(mix(SEA.deep, BRAND.paper, 0.24));
  const sand = C(mix(LAND.sand, BRAND.paper, 0.30));
  const paperLit = C(mix(BRAND.paper, 0xffffff, 0.52));
  const paperMid = C(mix(BRAND.paper, 0xffffff, 0.16));
  const paperAge = C(mix(BRAND.paper, LAND.dirt, 0.17));
  /* the coast is drawn in a warm sepia, never in the UI's near-black:
     a pure black line on cream is a wireframe, not a pressed plate */
  const coastInk = mix(ink, LAND.dirt, 0.34);

  let selected = opts.selected || null;

  /* ============================================================
     LAYOUT — the plate, and the type, in pixels.

     Two separate scales used to be hard-coded here in BOARD units,
     one for the phone and one for everything else, which meant the
     printed size of a word depended on how wide the caller's box
     happened to be. A place name set at 24 units printed at 12 px in
     the desk sheet and at SIX on a phone — the same drawing, half the
     legibility, and no way to tell from the source that it had
     happened. So every size here is stated in the unit the reader
     actually has, and divided into board units at the end.

     `k(lo, per, hi)` is "this many pixels, but never below lo and
     never above hi": type on a chart should grow with the chart, but
     a phone must clear the legibility floor and a 900 px sheet must
     not turn into a poster.
     ============================================================ */
  /* The room the chart has is the SCROLLER it was put in, not the
     window. Sizing off innerHeight is how a chart ends up 364 px tall
     inside a 440 px panel with the fare board pushed out of the world:
     on a desktop the phone is a 560 px mock in a 900 px window, and the
     two numbers have nothing to do with each other. Walk up to the
     first ancestor that scrolls (.w-appbody, .w-sheet-body) and ask it. */
  function availH() {
    let p = el.parentElement;
    for (let i = 0; p && i < 6; i++, p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if (oy === 'auto' || oy === 'scroll') return p.clientHeight || 0;
    }
    return 0;
  }

  function layout() {
    const vw = window.innerWidth || 1024, vh = window.innerHeight || 768;
    /* a phone on its side: wide, and with almost no height to spend */
    const land = vw > vh && vh <= 620;

    /* Measure with the width released, so what we read is the room the
       PARENT has, not the width we ourselves set on the last pass —
       that is the difference between a layout and a feedback loop. */
    el.style.width = '100%';
    let wAvail = Math.round(el.clientWidth || 0);
    if (!wAvail) wAvail = compact ? Math.min(340, vw - 50) : Math.min(560, vw - 56);
    const box = availH() || vh * 0.78;

    /* How much of that room the plate may take, and the shape it may be
       cut to. Landscape keeps 62 px back for the row of buttons under
       the map: an island you have to scroll to finish is not a map of
       an island. Portrait spends more than half, because on a phone the
       map IS the screen and the fare board under it is one thumb-flick
       away.

       THE ASPECT IS NOT A CONSTANT EITHER. It used to be one number per
       case — 1.90 in landscape — which is right for a plate laid across
       the whole width of a phone on its side and wrong the moment the
       Places screen puts the chart in a COLUMN instead: the same rule
       cut a 295x155 plate into a box 310 wide and 218 tall and left 63
       px of paper unprinted under an island that had nowhere to go. The
       plate now takes the shape of the box it was handed and is only
       stopped from going too far by the two limits — the same principle
       the rest of this function already runs on. */
    let hMax, minA, maxA;
    /* THE CALLER MAY STATE THE CAP, because only the caller knows what
       stands under the chart. Guessing it from the viewport was wrong
       the moment the Places screen grew a second layout: at 844x600 the
       viewport says "phone on its side", the app body says 356 px wide
       and 435 tall, and the chart held back 62 px for two buttons while
       the place card it is there to introduce needed 90 more. The full
       map sheet passes nothing and keeps the rules below. */
    /* THE CAP MAY ALSO BE A QUESTION, not only an answer. The phone's
       Places screen knows its box at build time because the app body is
       already in the document; a SHEET is built before it is inserted,
       so its two-column layout cannot be decided until a frame later.
       A function is asked again on every layout — which is exactly when
       the answer is needed and exactly when it is knowable. */
    const cap = typeof opts.hMax === 'function' ? opts.hMax() : opts.hMax;
    if (cap) { hMax = Math.max(120, cap); minA = 0.80; maxA = 2.10; }
    else if (land) { hMax = Math.max(148, box - 62); minA = 1.00; maxA = 2.30; }
    else if (wAvail < 430) { hMax = box * 0.60; minA = 0.80; maxA = 1.40; }
    /* 0.66, not 0.72: with the aspect free to fill the box the plate
       now REACHES hMax, and at 0.72 of a 665 px sheet body the Look
       around button went 40 px under the sheet's own bottom edge */
    else { hMax = box * 0.66; minA = 0.95; maxA = 1.70; }
    const want = Math.max(minA, Math.min(maxA, wAvail / Math.max(1, hMax)));

    let w = wAvail, hp = w / want;
    if (opts.height) {
      el.style.height = opts.height;
      hp = el.clientHeight || hp;
    } else if (hp > hMax) {
      hp = hMax;
      w = Math.min(wAvail, hp * maxA);
    }
    w = Math.max(160, Math.round(w));
    hp = Math.max(120, Math.round(hp));

    /* ---- cut the plate to that box ---- */
    const A = w / hp;
    const hx0 = HX * (1 + MARGIN), hy0 = HY * (1 + MARGIN);
    let hx, hy;
    if (A > hx0 / hy0) { hy = hy0; hx = hy0 * A; } else { hx = hx0; hy = hx0 / A; }
    vb = { x: ISL.cx - hx, y: ISL.cy - hy, w: hx * 2, h: hy * 2 };
    ppu = w / vb.w;
    /* how far out to sea the plate reaches, in coastline radii — the
       swell contours are generated out to it rather than to a fixed
       five, so a deep band of sea is engraved instead of flat wash */
    SEABAND = Math.max(hx / HX, hy / HY);

    /* ---- and the type, in pixels ----

       THE TYPE FOLLOWS THE TIGHT AXIS, NOT THE WIDE ONE. Every size
       here used to scale off `w` alone, which is right for a plate cut
       roughly square and wrong for the one a phone held sideways gets:
       that plate is 501 px wide and 218 tall, the island inside it is
       cut to the 218, and a caption sized off the 501 printed at 14.3
       px across an island only 364 px wide. Measured last round: label
       ink per unit of island reached 1.245 in landscape against 0.899
       in portrait, on a span that had SHRUNK. So the reference length
       is the smaller of the plate's width and what its height can
       carry — one number that describes both axes of the same island.
       The pixel FLOORS from the round that found the six-pixel place
       name are untouched; this only stops a squat plate shouting.

       The furniture (title, rose, mark) still reads the width: it
       stands in the sea band, and the sea band is what a wide plate
       has more of.

       AND A BIGGER PLATE BUYS NAMES, NOT POINTS. `cap` and `name` used
       to grow at 2.85 % and 2.25 % of the plate, which holds the ratio
       of type-ink to island CONSTANT at every size — a desk sheet at
       528 px was as crowded as a phone at 335 and had exactly as
       little room to print in. Legibility is an absolute, not a
       proportion: eleven and a half pixels is the floor a phone needs
       and it is also perfectly readable on a 528 px sheet, so the two
       rates are cut back until the floors carry nearly every size and
       the extra millimetres of a wide plate go into MORE WORDS. This
       is how a printed chart works — one type size per plate, and the
       big edition names the villages the pocket edition cannot. */
    const ref = Math.min(w, hp * 1.62);
    const k = (lo, per, hi) => Math.max(lo, Math.min(hi, per * ref));
    const kw = (lo, per, hi) => Math.max(lo, Math.min(hi, per * w));
    const P = (px) => n1(px / ppu);
    T = {
      cap: P(k(11.5, 0.0235, 16.5)),
      name: P(k(10.5, 0.0185, 13.5)),
      pin: P(k(9.4, 0.0250, 15)),
      title: P(kw(13, 0.0320, 19)),
      sub: P(kw(9.4, 0.0195, 12)),
      rose: P(kw(23, 0.0700, 46)),
      motif: P(k(27, 0.0850, 52)),
      mark: P(kw(31, 0.0870, 48)),
      route: P(k(10, 0.0210, 13)),
    };
    T.capTrack = n1(T.cap * 0.06);
    T.titleTrack = n1(T.title * 0.06);
    T.subTrack = n1(T.sub * 0.09);
    T.roseN = n1(T.rose * 0.46);

    /* ---- furniture, anchored to the plate's corners so it rides the
            sea band outward as the band opens ----

       AND CUT TO THE BAND, NOT ONLY MOVED ALONG IT. A 23 px rose is a
       46 px disc of opaque paper, which on a 295 px plate is a sixth of
       the width standing in a corner where the coast is 30 px offshore
       — the disc sat half on the island and its edge deleted the last
       three letters of STAMPEDE DISTRICT. So the corner is asked how
       much sea it actually has: walk in from the corner along the
       diagonal until the coast, and the rose is whatever fits inside
       that, down to a floor of 16 px where it stops being a rose. */
    const inset = 30 / ppu;
    const seaRoom = (px, py, ux, uy) => {
      let lo = 0, hi = Math.hypot(vb.w, vb.h);
      for (let i = 0; i < 20; i++) {
        const m = (lo + hi) / 2;
        if (onLand(px + ux * m, py + uy * m)) hi = m; else lo = m;
      }
      return lo;
    };
    const R2 = Math.SQRT1_2;
    const seRoom = seaRoom(vb.x + vb.w, vb.y + vb.h, -R2, -R2);
    /* centre sits (r+inset) in from both edges, so its far point is
       (r+inset)*sqrt2 + r from the corner: solve that for r */
    const roseFit = (seRoom - inset * 1.414) / 2.414;
    const roseR = Math.max(16 / ppu, Math.min(T.rose, roseFit));
    ROSE = { x: vb.x + vb.w - roseR - inset, y: vb.y + vb.h - roseR - inset * 0.9, r: roseR };
    T.rose = roseR;
    T.roseN = n1(roseR * 0.46);

    /* THE PLAQUE IS CUT TO ITS OWN TITLE — 0.62 em per character of
       tracked serif caps, measured off the first proof. Hard-coding a
       width is how the first pass printed BULL BEAR CITY through its
       own left border and off the plate.

       AND TO THE BAND IT STANDS IN. On a plate 1.7 wide or wider there
       is no top band at all — the coast runs within a few pixels of the
       plate mark — and one line of BULL BEAR CITY is 40 % of the sheet,
       which lands the plaque squarely on the island's north-west
       shoulder (measured: 192 px of a 486 px plate on a phone held
       sideways). A tall narrow corner gets a STACKED plaque instead,
       which is what an engraver does with that shape, and it drops the
       width by 36 % into the standing band. Scaled down only if even
       that will not fit, and never below 0.70.

       THE PLAQUE IS ALSO CUT TO ITS SUBTITLE. "28 OF 28 SURVEYED" is
       seventeen characters of 0.71-em caps against a stacked title of
       nine, so on the landscape plate the line under the rule was WIDER
       THAN THE PLAQUE IT SITS IN and hung out over the coast, where
       LEARNING QUARTER then printed through it — 835 px2 of collision
       that no label placer could have avoided, because the box the
       placer was told to dodge did not contain the word. */
    const PAD = 26 / ppu;
    const subLen = String(D.locations.length).length * 2 + 12;
    const bandX = vb.w / 2 - HX;
    const cut = (lines, ct, ctr, cs, sub) => {
      const cw = lines.reduce((m, ln) => Math.max(m,
        ln.length * ct * 0.62 + (ln.length - 1) * ctr + PAD),
      sub ? subLen * cs * 0.72 + (subLen - 1) * cs * 0.09 + PAD : 0);
      return {
        lines, t: ct, tr: n1(ctr), s: cs, sub, on: true,
        w: cw, h: ct * (1.05 + (lines.length - 1) * 1.22 + 0.62) + cs * (sub ? 2.1 : 0.85),
      };
    };
    /* Stand it in a named corner and hand back the corner of the plaque
       NEAREST the island — if that point is at sea, all of it is. */
    const stand = (c, corner, insF) => {
      const g = inset * insF;
      const x = corner === 'ne' ? vb.x + vb.w - g - c.w : vb.x + g;
      const y = corner === 'sw' ? vb.y + vb.h - g - c.h : vb.y + g;
      const inner = [corner === 'ne' ? x : x + c.w, corner === 'sw' ? y : y + c.h];
      return { ...c, x, y, inner };
    };
    const clear = (c) => !onLand(c.inner[0], c.inner[1], 1.012);

    let lines = [TITLE], ct = T.title, ctr = T.titleTrack, cs = T.sub;
    if (A >= 1.70) {
      lines = ['BULL BEAR', 'CITY'];
      const need = Math.max(9 * ct * 0.62 + 8 * ctr, subLen * cs * 0.72) + PAD;
      const room = bandX + inset * 0.35;
      if (need > room) {
        const f = Math.max(0.70, (room - PAD) / (need - PAD));
        ct *= f; ctr *= f; cs *= f;
      }
    }
    /* A PLAQUE THAT WILL NOT STAND IN THE SEA IS NOT PRINTED.
       Everything else on this sheet gives way to the coast; the title
       used to be the exception, and on the 295 px plate the Places
       screen cuts for a phone on its side it stood on the island's
       north-west shoulder with GOLDEN HEIGHTS underneath it.

       So it is offered four decreasing forms in each of three corners
       and takes the first that has sea under all of it: as cut, tucked
       hard into the corner, stacked, then stacked without its counter
       line — the SUBTITLE is the widest thing in the plaque at
       seventeen characters against a stacked title of nine, and it may
       not be shrunk out of legibility to save itself. The corners are
       tried north-west first (the engraver's corner, and where it has
       always stood), then south-west, then north-east; the south-east
       belongs to the rose. If none of the twelve has sea under it, the
       plaque is left off: the screen it is inside is already called
       Bull Bear City, the plate mark and the rose carry the printed
       object on their own, and the ten district names are the reason
       the chart exists. */
    const stack = ['BULL BEAR', 'CITY'];
    const forms = [[lines, 1, 0.8, true], [lines, 1, 0.40, true],
      [stack, 1, 0.40, true], [stack, 1, 0.40, false]];
    CART = null;
    outer:
    for (const corner of ['nw', 'sw', 'ne']) {
      for (const [ls, f, insF, sub] of forms) {
        const c = stand(cut(ls, ct * f, ctr * f, cs, sub), corner, insF);
        if (!CART) CART = { ...c, on: false };
        if (clear(c)) { CART = c; break outer; }
      }
    }

    /* ---- and finally hand the box back to the DOM ---- */
    el.style.width = w + 'px';
    el.style.maxWidth = '100%';
    el.style.marginInline = 'auto';
    if (!opts.height) el.style.height = hp + 'px';
    svg.style.display = 'block';
    svg.style.width = '100%';
    svg.style.height = '100%';

    const key = w + 'x' + hp;
    const changed = key !== layKey;
    layKey = key;
    if (changed) _flecks = null;   /* the countryside is sampled in vb */
    return changed;
  }

  /* ============================================================
     THE COASTLINE

     r(t) is a unit radius on the world's own shoreline ellipse with
     four harmonics of wobble. The base offset (+0.040) keeps the
     minimum above 0.98 so the drawn coast never cuts inside a place
     the simulation swears is on land.
     ============================================================ */
  const COAST_N = 72;
  function coastR(t) {
    return 1.040
      + 0.030 * Math.sin(3 * t + 1.9)
      + 0.019 * Math.sin(5 * t - 0.7)
      + 0.012 * Math.sin(8 * t + 2.6)
      + 0.007 * Math.sin(13 * t + 0.3);
  }
  /* the coast at k times its radius, as a smooth closed path */
  const coastCache = new Map();
  function coast(k, squash = 0) {
    const key = k + '|' + squash;
    if (coastCache.has(key)) return coastCache.get(key);
    const pts = [];
    for (let i = 0; i < COAST_N; i++) {
      const t = (i / COAST_N) * Math.PI * 2;
      const r = coastR(t) * k;
      pts.push([
        ISL.cx + Math.cos(t) * (ISL.rx - squash) * r,
        ISL.cy + Math.sin(t) * (ISL.ry - squash) * r,
      ]);
    }
    const d = closed(pts);
    coastCache.set(key, d);
    return d;
  }

  /* Inside the drawn coast, in board units. k<1 tests "inland of the
     foreshore" rather than "inside the waterline". */
  function onLand(x, y, k = 1) {
    const u = (x - ISL.cx) / ISL.rx, v = (y - ISL.cy) / ISL.ry;
    return Math.hypot(u, v) < coastR(Math.atan2(v, u)) * k;
  }

  /* Catmull-Rom through a closed ring, emitted as cubics. A polyline of
     72 straight chords looks like a polygon; this looks like a nib. */
  function closed(pts) {
    const n = pts.length;
    let d = `M${n1(pts[0][0])} ${n1(pts[0][1])}`;
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      d += `C${n1(p1[0] + (p2[0] - p0[0]) / 6)} ${n1(p1[1] + (p2[1] - p0[1]) / 6)},`
        + `${n1(p2[0] - (p3[0] - p1[0]) / 6)} ${n1(p2[1] - (p3[1] - p1[1]) / 6)},`
        + `${n1(p2[0])} ${n1(p2[1])}`;
    }
    return d + 'Z';
  }

  /* ============================================================
     DISTRICT GEOMETRY

     The support function of each zone's own member locations: for 40
     angles around the centroid take the furthest member in that
     direction, add a margin, add a deterministic wobble. A district
     with four places sprawls, a district with two is a lozenge, and
     the shape is a consequence of the content rather than a blob
     someone drew.

       r(t) = max_i (p_i - c).u(t) + margin,  wobbled +/-6 %
     ============================================================ */
  function zoneShape(zid) {
    const members = D.locations.filter((l) => l.z === zid);
    const z = D.zones[zid];
    let cx = z.x, cy = z.y;
    if (members.length) {
      cx = members.reduce((t, l) => t + l.x, 0) / members.length;
      cy = members.reduce((t, l) => t + l.y, 0) / members.length;
    }
    const ph = phase(zid);
    const N = 40, margin = 54;
    const pts = [];
    let top = Infinity, rsum = 0;
    for (let i = 0; i < N; i++) {
      const t = (i / N) * Math.PI * 2;
      const ux = Math.cos(t), uy = Math.sin(t);
      let r = 0;
      for (const l of members) r = Math.max(r, (l.x - cx) * ux + (l.y - cy) * uy);
      /* keep the anchor inside too, and never collapse to a point */
      r = Math.max(r, (z.x - cx) * ux + (z.y - cy) * uy, 26) + margin;
      r *= 1 + 0.058 * Math.sin(3 * t + ph) + 0.034 * Math.sin(5 * t - ph * 1.7);
      rsum += r;
      const p = [cx + ux * r, cy + uy * r];
      top = Math.min(top, p[1]);
      pts.push(p);
    }
    return { d: closed(pts), pts, cx, cy, top, rmean: rsum / N, members };
  }

  const inPoly = (p, pts) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a[1] > p[1]) !== (b[1] > p[1])
        && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  };

  /* Where the drawing goes: the candidate inside the district that is
     furthest from that district's own pins and from its caption band. */
  function motifSpot(sh, size) {
    let best = null, bestScore = 0;
    for (let ring = 0; ring < 3; ring++) {
      const rr = [0, 0.40, 0.64][ring];
      const nA = ring === 0 ? 1 : 12;
      for (let i = 0; i < nA; i++) {
        const a = (i / nA) * Math.PI * 2 + 0.35;
        const p = [sh.cx + Math.cos(a) * rr * sh.rmean, sh.cy + Math.sin(a) * rr * sh.rmean * 0.86];
        if (!inPoly(p, sh.pts)) continue;
        let d = 1e9;
        for (const m of sh.members) d = Math.min(d, Math.hypot(m.x - p[0], m.y - p[1]) - size * 0.42);
        d = Math.min(d, (p[1] - sh.top - size * 0.6) * 1.1);
        if (d > bestScore) { bestScore = d; best = p; }
      }
    }
    return bestScore > size * 0.16 ? best : null;
  }

  function motif(zid, p, size, alpha) {
    const paths = MOTIF[zid];
    if (!paths || !p) return '';
    const k = n1(size / 44 * 100) / 100;
    return `<g transform="translate(${n1(p[0])} ${n1(p[1])}) scale(${k}) translate(-22 -21)"
      fill="none" stroke="${rgba(coastInk, alpha)}" stroke-width="2.1"
      stroke-linecap="round" stroke-linejoin="round">`
      + paths.map((d) => `<path d="${d}"/>`).join('') + '</g>';
  }

  /* ------------------------------------------------------------
     THE COUNTRYSIDE.

     Between the districts the island was one unbroken sheet of cream —
     nine tenths of the chart with nothing drawn on it, which reads as
     an unfinished file rather than as country. So: a seeded scatter of
     woods, firs and hill pairs on the land that no district claims and
     no pin sits on, at a tenth strength. Rejection-sampled against the
     coast, the district polygons and each other, from ctx-free
     mulberry32 so two builds draw the same countryside.
     ------------------------------------------------------------ */
  let _flecks = null;
  function flecks(shapes) {
    if (_flecks) return _flecks;
    const rnd = mulberry32(0x7ac41e);
    const kept = [];
    for (let i = 0; i < 420 && kept.length < 38; i++) {
      const x = vb.x + rnd() * vb.w, y = vb.y + rnd() * vb.h;
      if (!onLand(x, y, 0.92)) continue;
      if (shapes.some((sh) => inPoly([x, y], sh.pts))) continue;
      if (D.locations.some((l) => Math.hypot(l.x - x, l.y - y) < 62)) continue;
      if (kept.some((k) => Math.hypot(k.x - x, k.y - y) < 74)) continue;
      kept.push({ x, y, k: Math.floor(rnd() * FLECK.length), s: 24 + rnd() * 9 });
    }
    _flecks = kept.map((f) => {
      const k = n1(f.s / 16 * 100) / 100;
      return `<g transform="translate(${n1(f.x)} ${n1(f.y)}) scale(${k}) translate(-8 -8)">`
        + FLECK[f.k].map((d) => `<path d="${d}"/>`).join('') + '</g>';
    }).join('');
    return _flecks;
  }

  /* Two rocks off the coast, so the sea has something in it besides
     the swell lines and the plate does not read as a cut-out. */
  function rocks() {
    const out = [];
    for (const [rx0, ry0, rr, ph] of [[vb.x + 132, vb.y + vb.h - 128, 30, 0.7],
      [vb.x + vb.w - 138, vb.y + 128, 24, 2.3]]) {
      const pts = [];
      for (let i = 0; i < 18; i++) {
        const t = (i / 18) * Math.PI * 2;
        const r = rr * (1 + 0.22 * Math.sin(3 * t + ph) + 0.12 * Math.sin(5 * t - ph));
        pts.push([rx0 + Math.cos(t) * r, ry0 + Math.sin(t) * r * 0.78]);
      }
      const d = closed(pts);
      out.push(`<path d="${d}" fill="${sand}" stroke="${rgba(coastInk, 0.62)}" stroke-width="2"/>`);
      out.push(`<g fill="none" stroke="${rgba(coastInk, 0.34)}" stroke-width="1.8"
        stroke-linecap="round" transform="translate(${n1(rx0)} ${n1(ry0 - 2)}) scale(0.9) translate(-8 -8)">`
        + FLECK[1].map((p) => `<path d="${p}"/>`).join('') + '</g>');
    }
    return out.join('');
  }

  /* A street network: every district joined to its two nearest
     neighbours, de-duplicated. Deterministic, and it makes the
     island read as one city rather than ten islands. A road is only
     drawn between two SURVEYED districts — a chart cannot show you the
     way to somewhere you have not heard of, and a full wireframe over
     blank country was the loudest thing on the plate. */
  function roads() {
    const ids = Object.keys(D.zones);
    const seen = new Set();
    const out = [];
    for (const a of ids) {
      const za = D.zones[a];
      const near = ids.filter((b) => b !== a)
        .sort((p, q) => dist2(za, D.zones[p]) - dist2(za, D.zones[q]))
        .slice(0, 2);
      for (const b of near) {
        const key = a < b ? a + '|' + b : b + '|' + a;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!zoneKnown(a) || !zoneKnown(b)) continue;
        out.push([za, D.zones[b]]);
      }
    }
    return out;
  }
  const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  const zoneKnown = (zid) => D.locations.some((l) => l.z === zid && game.known(l.id));

  /* Where Wally is, in board coordinates. His real 3D position when
     the world is up; his current location otherwise. */
  function wallyAt() {
    const p = ctx.wally?.position;
    if (p && Number.isFinite(p.x + p.z)) {
      const m = W.toMap(p.x, p.z);
      return { x: m.x, y: m.y, live: true };
    }
    const l = D.locationById[game.state.loc];
    return l ? { x: l.x, y: l.y, live: false } : { x: MAP.w / 2, y: MAP.h / 2, live: false };
  }

  /* ============================================================
     FURNITURE — the rose and the cartouche.

     Both are placed in a sea corner, and both are registered with the
     caption de-collider before any caption is laid, so a district name
     moves out of their way rather than printing through them.
     ============================================================ */
  const TITLE = 'BULL BEAR CITY';

  function compassRose() {
    const { x: cx, y: cy, r } = ROSE;
    const s = [];
    s.push(`<circle cx="${cx}" cy="${cy}" r="${n1(r * 1.03)}" fill="${rgba(BRAND.paper, 0.82)}"/>`);
    s.push(`<circle cx="${cx}" cy="${cy}" r="${n1(r)}" fill="none"
      stroke="${rgba(coastInk, 0.52)}" stroke-width="2.4"/>`);
    s.push(`<circle cx="${cx}" cy="${cy}" r="${n1(r * 0.90)}" fill="none"
      stroke="${rgba(coastInk, 0.28)}" stroke-width="1.2"/>`);
    /* the tick ring: 32 rhumbs, every fourth long */
    let ticks = '';
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      const r0 = r * (i % 4 === 0 ? 0.78 : 0.85);
      ticks += `M${n1(cx + Math.cos(a) * r0)} ${n1(cy + Math.sin(a) * r0)}`
        + `L${n1(cx + Math.cos(a) * r * 0.9)} ${n1(cy + Math.sin(a) * r * 0.9)}`;
    }
    s.push(`<path d="${ticks}" stroke="${rgba(coastInk, 0.42)}" stroke-width="1.6" fill="none"/>`);
    /* the star: four long points, four short, each split light/dark so
       it reads faceted rather than as a flat asterisk. North is the
       token orange — the one colour the player already reads as "you". */
    const dark = rgba(coastInk, 0.80), light = rgba(BRAND.paper, 0.96);
    for (let i = 0; i < 8; i++) {
      const a = -Math.PI / 2 + (i / 8) * Math.PI * 2;
      const len = r * (i % 2 === 0 ? 0.80 : 0.46);
      const wdt = len * 0.20;
      const ux = Math.cos(a), uy = Math.sin(a), px = -uy, py = ux;
      const tip = [cx + ux * len, cy + uy * len];
      const north = i === 0;
      const tri = (b, f) => `<path d="M${n1(cx)} ${n1(cy)}L${n1(b[0])} ${n1(b[1])}L${n1(tip[0])} ${n1(tip[1])}Z"
        fill="${f}" stroke="${rgba(coastInk, 0.55)}" stroke-width="1.1" stroke-linejoin="round"/>`;
      s.push(tri([cx + px * wdt, cy + py * wdt], north ? C(BRAND.token) : light));
      s.push(tri([cx - px * wdt, cy - py * wdt], north ? C(BRAND.token2) : dark));
    }
    s.push(`<circle cx="${cx}" cy="${cy}" r="${n1(r * 0.09)}" fill="${rgba(BRAND.paper, 0.9)}"
      stroke="${rgba(coastInk, 0.6)}" stroke-width="1.2"/>`);
    s.push(`<text x="${cx}" y="${n1(cy - r - 9)}" text-anchor="middle" font-size="${T.roseN}"
      font-weight="700" letter-spacing="1" fill="${rgba(coastInk, 0.88)}"
      stroke="${rgba(BRAND.paper, 0.9)}" stroke-width="4" paint-order="stroke">N</text>`);
    return `<g class="wm-rose">${s.join('')}</g>`;
  }

  function cartouche(found, total) {
    const { x, y, w: cw, h: ch, t, s: sub } = CART;
    const c = t * 0.24;
    const plaque = (i) => `M${n1(x + c + i)} ${n1(y + i)}H${n1(x + cw - c - i)}L${n1(x + cw - i)} ${n1(y + c + i)}`
      + `V${n1(y + ch - c - i)}L${n1(x + cw - c - i)} ${n1(y + ch - i)}H${n1(x + c + i)}`
      + `L${n1(x + i)} ${n1(y + ch - c - i)}V${n1(y + c + i)}Z`;
    const midX = x + cw / 2;
    const title = CART.lines.map((ln, i) => `<text x="${n1(midX)}"
      y="${n1(y + t * (1.05 + i * 1.22))}" text-anchor="middle"
      font-size="${n1(t)}" font-weight="700" letter-spacing="${CART.tr}"
      fill="${rgba(coastInk, 0.95)}">${ln}</text>`).join('');
    const ruleY = y + t * (1.05 + (CART.lines.length - 1) * 1.22 + 0.62);
    const wing = t * 0.62, tip = t * 0.42;
    return `<g class="wm-cart" transform="rotate(-1.1 ${n1(midX)} ${n1(y + ch / 2)})">
      <path d="${plaque(t * 0.05)}" fill="${rgba(mix(ink, SHADOW.tint, 0.5), 0.22)}"
        transform="translate(${n1(t * 0.08)} ${n1(t * 0.12)})"/>
      <path d="${plaque(0)}" fill="${paperLit}" stroke="${rgba(coastInk, 0.62)}" stroke-width="2.4"/>
      <path d="${plaque(t * 0.13)}" fill="none" stroke="${rgba(coastInk, 0.30)}" stroke-width="1.2"/>
      ${title}
      <path d="M${n1(x + wing * 1.2)} ${n1(ruleY)}H${n1(x + cw - wing * 1.2)}"
        stroke="${rgba(coastInk, 0.4)}" stroke-width="1.3"/>
      <path d="M${n1(x + wing)} ${n1(ruleY)}l${n1(tip)} ${n1(-tip * 0.6)}v${n1(tip * 1.2)}z
        M${n1(x + cw - wing)} ${n1(ruleY)}l${n1(-tip)} ${n1(-tip * 0.6)}v${n1(tip * 1.2)}z"
        fill="${rgba(coastInk, 0.5)}"/>
      ${CART.sub ? `<text x="${n1(midX)}" y="${n1(ruleY + sub * 1.55)}" text-anchor="middle"
        font-size="${n1(sub)}" font-weight="700" letter-spacing="${n1(sub * 0.09)}"
        fill="${rgba(coastInk, 0.64)}">${found} OF ${total} SURVEYED</text>` : ''}
    </g>`;
  }

  /* ---- ask the font how wide this actually is ----
     One scratch canvas and one face lookup for the life of the chart,
     resolved on first use and not at import time, because --w-serif is
     injected by style.js and may not be on the document yet when this
     module is evaluated. Returns the ADVANCE in the same units the
     font-size was given in, or null if there is no canvas to ask.
     Cached by (size, weight, tracking, string): ten districts times a
     hundred and eighty candidates is one measureText, not eighteen
     hundred. See THE MODEL IS THE MEASUREMENT in paint(). */
  let TEXTCV, FACE = null;
  const TEXTW = new Map();
  function advance(s, fs, weight, track) {
    if (TEXTCV === undefined) {
      try { TEXTCV = document.createElement('canvas').getContext('2d'); } catch { TEXTCV = null; }
      try {
        const v = getComputedStyle(document.documentElement)
          .getPropertyValue('--w-serif').trim();
        if (v) FACE = v;
      } catch { /* keep the literal stack below */ }
      if (!FACE) {
        FACE = "'Iowan Old Style','Palatino Linotype',Palatino,"
          + "'Book Antiqua','Hoefler Text',Georgia,'Times New Roman',serif";
      }
    }
    if (!TEXTCV) return null;
    const k = fs + '|' + weight + '|' + track + '|' + s;
    let w = TEXTW.get(k);
    if (w === undefined) {
      TEXTCV.font = weight + ' ' + fs + 'px ' + FACE;
      w = TEXTCV.measureText(s).width + track * s.length;
      TEXTW.set(k, w);
    }
    return w;
  }

  /* ============================================================
     paint
     ============================================================ */
  function paint() {
    const me = wallyAt();
    const sel = selected ? D.locationById[selected] : null;
    const found = D.locations.filter((l) => game.known(l.id)).length;
    const s = [];

    /* ============================================================
       SYMBOL DISPLACEMENT — the pins, nudged apart.

       The names were deconflicted last round and the pins were not, so
       the chart arrived at the honest half of the problem: a player
       could READ where a place was and could not TAP it. Measured on
       the compact chart at 844x390 — fifteen overlapping pairs, 362 px2
       of pin printed on pin, and a tightest pair 14.2 px apart on discs
       19 px across, so one symbol was more than half buried under
       another. All of it in the same knot: Main Street, Market Square
       and the Learning Quarter, three districts that in the world are
       four hundred metres wide and on a 333 px plate are ninety.

       Two ways out were on the table. The second one — let an
       overlapping cluster open a little list and pick from that — keeps
       the drawing untouched and is honest about the knot being a knot,
       but it fixes only the tap: the pin that is half buried is still
       half buried, and a chart you must open a menu to read is a
       picture of a map with a menu on it. So: DISPLACEMENT, which is
       what an engraver does and has done since charts had symbols on
       them. A symbol is not a coordinate; it is a mark that stands FOR
       a coordinate, and when two marks collide at the scale you are
       printing at, you move the marks and you keep the scale.

       It is bounded so it stays honest:
         · a pin may move at most CAP — two pin radii — from where the
           world says it is, and it is pulled home every iteration, so
           nothing drifts that does not have to;
         · a displaced pin is kept on land (tools/test-game.mjs asserts
           every location is on dry land and the drawing may not
           contradict the simulation);
         · the leader line the type layer already draws runs from the
           DISPLACED pin to its name, so the pairing is never in doubt;
         · it is deterministic — same board, same plate, same nudge.

       And the tap target is cut TOWARD the Voronoi bisector: a pin's
       target wants to reach no further than halfway to its nearest
       neighbour. Before this, targets were a flat 46 units — three
       times a pin — and in the knot they simply stacked, so whichever
       place happened to be last in data.js took the tap.

       WHAT THAT DOES AND DOES NOT GUARANTEE. Read the line that sets
       `tap` below: the bisector is a CEILING, `ink + 1` is a FLOOR,
       and where the two disagree the floor wins. In the tightest knot
       they disagree. On a 390x844 phone the compact chart's closest
       pair of centres is 21.7 px against a mean ink radius of 9.5, so
       half the gap is 10.9 and ink+1 is 10.5 — close enough that
       which one wins varies pin by pin. So it is NOT true that no two
       targets can overlap, and not quite true that every point of a
       pin's own ink resolves to that pin.

       THE COUNTS BELOW ARE INSTRUMENT READINGS, SO HERE IS THE
       INSTRUMENT. tools/_map-r5.mjs (same mount as its round-4
       predecessor tools/_map-pins.mjs, so the two are comparable):
       THE REAL APP MOUNT — all 28 places known and open, NOTHING
       explicitly selected, the compact chart reached through
       WALLY.debug.ui('places') and the sheet through ui('map'), so
       the plate is sized by the app's own panel and scroller and not
       by the rig. Measured only after that plate stops resizing —
       r5's SETTLE(): three identical .w-map client rects 200 ms
       apart. A flat wait is not an instrument: the landscape compact
       plate is still growing at 1800 ms — see WAIT FOR THE PLATE
       below. At 390x844, 844x390 and 1400x900, which in this mount is
       six DIFFERENT charts — compact 339x393, 333x218, 372x393 and
       sheet 335x383, 412x259, 528x451 — with pin ink read off
       circle.wm-pin's client rect and taps resolved by
       document.elementFromPoint on integer-rounded coordinates. In
       THAT mount, tap targets overlap on 3, 2, 1, 1, 1 and 0 pairs,
       worst case 0.17 px of radius apiece.

       THE REVIEWING RIG READS 3, 3, 4, 4, 2, 2 AND A WORST OF 0.39 px
       ON THIS SAME CODE, AND THE REASON IS NOT A DISAGREEMENT ABOUT
       THE CHART. tools/_vjM-map.mjs mounts a FRESH cityMap() into its
       own full-viewport host with a place pre-selected. The compact
       layout walks up for the first overflow-y ancestor to size the
       plate, that ancestor is the rig's own host, and so the compact
       chart is handed the whole viewport: its plates come back
       390x488, 754x328 and 1010x594 with COMPACT AND FULL IDENTICAL
       at each viewport. It is measuring three charts twice — hence
       the duplicated pairs — and none of the three is the compact
       plate the player gets. A bigger plate spreads the pins (mean
       ink r 10.3 px against 9.5, closest centres 22.6 against 21.7),
       which is the whole of the difference. That note is now in the
       head of _vjM-map.mjs too; do not spend another round on it.
       Both are still the same fact at different scales, and the
       statement that survives either instrument is the one to hold
       onto: BETWEEN ZERO AND FOUR PAIRS PER CHART, SHARING UNDER HALF
       A PIXEL.

       What is invariant, and what the numbers are actually for, and
       it is invariant ACROSS BOTH MOUNTS even though the plate is
       not: every probe at 0.62 of the ink radius resolves to its own
       pin — 1512 of 1512 here (252 per chart), and 2016 of 2016 in
       the reviewing rig at its own denominator (336 per chart). On
       the RIM at 0.98, exactly two probes on the whole board cross
       over, and they are always the same crossing, "office" giving a
       rim point to "propertyoffice" — 1342 of 1344 here, 2014 of 2016
       there. TWO, in both instruments, on a plate neither of them
       sizes the same way; that is what makes it a property of the
       chart rather than of the rig. WHICH PAIR OF CHARTS carries it
       does move with the mount: the two charts of the 390x844
       portrait viewport in this rig, the 844x390 landscape pair in
       the reviewing one. The count is stable; the address is not, so
       do not cite the address.

       The floor stays and the sentence shrinks, because the floor is
       the better of the two errors. Letting the bisector win outright
       would cut the target SMALLER than the symbol precisely where the
       symbol is hardest to hit, so a thumb on the visible edge of its
       own pin would be handed to the neighbour: a guaranteed dead ring
       on your own ink, bought with under half a pixel of shared target
       between two marks 21 px apart — an ambiguity no thumb can even
       express. That trade is not worth making. An accurate comment is.
       ============================================================ */
    const PINS = (() => {
      const nodes = [];
      for (const l of D.locations) {
        if (!game.known(l.id)) continue;
        const big = game.state.loc === l.id || selected === l.id;
        const r = big ? T.pin * 1.2 : T.pin;
        /* the INK, not the geometry: the disc is stroked, and half that
           stroke prints outside r */
        const ink = r + (big ? 2.5 : 1.6);
        nodes.push({ id: l.id, ox: l.x, oy: l.y, x: l.x, y: l.y, r, ink, big });
      }
      /* a hairline of paper between two symbols, stated in pixels like
         the type it sits among */
      const GAPX = 2.4 / ppu;
      const CAP = T.pin * 2.0;
      for (let it = 0; it < 120; it++) {
        let moved = 0;
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i], b = nodes[j];
            const need = a.ink + b.ink + GAPX;
            let dx = b.x - a.x, dy = b.y - a.y;
            let d = Math.hypot(dx, dy);
            if (d >= need) continue;
            if (d < 1e-4) {
              /* two places on the same coordinate: split them along a
                 direction derived from their ids, never Math.random */
              const t = phase(a.id + '|' + b.id);
              dx = Math.cos(t); dy = Math.sin(t); d = 1;
            } else { dx /= d; dy /= d; }
            const push = (need - d) * 0.5;
            a.x -= dx * push; a.y -= dy * push;
            b.x += dx * push; b.y += dy * push;
            moved += push;
          }
        }
        for (const n of nodes) {
          /* home again, a little, every pass — this is what makes the
             final displacement the SMALLEST one that separates the
             knot rather than wherever the relaxation wandered to */
          n.x += (n.ox - n.x) * 0.05;
          n.y += (n.oy - n.y) * 0.05;
          let dx = n.x - n.ox, dy = n.y - n.oy;
          const d = Math.hypot(dx, dy);
          if (d > CAP) { n.x = n.ox + dx / d * CAP; n.y = n.oy + dy / d * CAP; }
          /* never into the sea */
          if (d > 0.01 && !onLand(n.x, n.y, 0.985)) {
            let lo = 0, hi = 1;
            for (let k = 0; k < 12; k++) {
              const m = (lo + hi) / 2;
              if (onLand(n.ox + dx * m, n.oy + dy * m, 0.985)) lo = m; else hi = m;
            }
            n.x = n.ox + dx * lo; n.y = n.oy + dy * lo;
          }
        }
        if (moved < 0.02) break;
      }
      /* the target: never past the bisector to the nearest neighbour */
      for (const n of nodes) {
        let nn = Infinity;
        for (const m of nodes) if (m !== n) nn = Math.min(nn, Math.hypot(m.x - n.x, m.y - n.y));
        n.tap = Math.max(n.ink + 1, Math.min(Math.max(46, n.r * 1.7), nn / 2));
      }
      const map = new Map();
      for (const n of nodes) map.set(n.id, n);
      return map;
    })();
    /* every reader of a pin's position goes through this, so the
       drawing, the obstacles, the leaders and the route cannot
       disagree about where a symbol is */
    const PX = (l) => PINS.get(l.id)
      || { x: l.x, y: l.y, r: T.pin, ink: T.pin + 1.6, tap: 46 };

    /* ---------------- defs: stock, wash, hatches ---------------- */
    const zids = Object.keys(D.zones);
    const hatches = zids.map((zid, i) => {
      const tint = boost(hex(D.zones[zid].tint));
      const ang = (i * 37) % 180;
      return `<pattern id="wh${i}${U}" width="17" height="17" patternUnits="userSpaceOnUse"
        patternTransform="rotate(${ang})">
        <path d="M0 0V17" stroke="${rgba(tint, 0.30)}" stroke-width="2.4"/>
      </pattern>`;
    }).join('');

    s.push(`<defs>
      <radialGradient id="wm-sea${U}" cx="50%" cy="46%" r="74%">
        <stop offset="0" stop-color="${seaLo}"/>
        <stop offset="1" stop-color="${seaHi}"/>
      </radialGradient>
      <radialGradient id="wm-land${U}" cx="38%" cy="30%" r="82%">
        <stop offset="0" stop-color="${paperLit}"/>
        <stop offset="0.55" stop-color="${paperMid}"/>
        <stop offset="1" stop-color="${paperAge}"/>
      </radialGradient>
      <radialGradient id="wm-vig${U}" cx="50%" cy="48%" r="72%">
        <stop offset="0.55" stop-color="${rgba(ink, 0)}"/>
        <stop offset="1" stop-color="${rgba(mix(ink, LAND.dirt, 0.4), 0.17)}"/>
      </radialGradient>
      <filter id="wm-soft${U}" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="9"/>
      </filter>
      <pattern id="wm-stip${U}" width="26" height="26" patternUnits="userSpaceOnUse">
        <circle cx="5" cy="6" r="1.5" fill="${rgba(coastInk, 0.20)}"/>
        <circle cx="18" cy="17" r="1.3" fill="${rgba(coastInk, 0.16)}"/>
      </pattern>
      ${hatches}
    </defs>`);

    /* ---------------- the stock ----------------
       Paper first, everywhere. The sea is INK ON PAPER: an even-odd
       path of the whole plate minus the coastline, washed blue at 0.9
       so the stock still shows through it. */
    s.push(`<rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="url(#wm-land${U})"/>`);

    /* --- the island's drop, under the sea wash so it reads as the
           sheet lifting rather than as murk in the water --- */
    s.push(`<path d="${coast(1)}" transform="translate(4 13)"
      fill="${rgba(mix(SHADOW.tint, ink, 0.25), 0.34)}" filter="url(#wm-soft${U})"/>`);

    /* --- sea. BANDED, not graded (ART §2.1): a deep wash, then a
           shallow shelf hugging the coast, then the engraved swell
           lines. Three flat steps read as printed water; a smooth
           gradient reads as a UI panel. --- */
    s.push(`<path fill-rule="evenodd" fill="url(#wm-sea${U})" opacity="0.92"
      d="M${vb.x} ${vb.y}H${vb.x + vb.w}V${vb.y + vb.h}H${vb.x}Z ${coast(1)}"/>`);
    s.push(`<path d="${coast(1.13)}" fill="${rgba(mix(SEA.shallow, BRAND.paper, 0.34), 0.42)}"/>`);
    s.push(`<path d="${coast(1.065)}" fill="${rgba(mix(SEA.shallow, BRAND.paper, 0.62), 0.55)}"/>`);

    /* --- the swell: five contours of the coast itself, the two nearest
           in foam (a light line reads on a blue wash where a dark one
           dies), the rest broken and fading out --- */
    /* Two in foam hugging the coast, then as many broken ones as the
       plate has sea for. On a portrait phone the band to the south is
       four times as deep as the sliver to the east, and five fixed
       contours left it as a flat wash with a compass sitting on it. */
    const CONTOUR = [
      [1.017, SEA.foam, 0.60, 2.6, ''], [1.042, SEA.foam, 0.34, 2.0, ''],
    ];
    const DASH = ['30 15', '20 17', '13 19', '26 16', '17 18'];
    for (let i = 0, kk = 1.072, a = 0.20, ww = 1.9; i < 10 && kk < SEABAND + 0.05; i++) {
      /* the far ones go pale rather than dark: a light line reads on a
         blue wash where an ink one dies (same reason the two nearest
         are foam), so the deep band engraves instead of muddying */
      CONTOUR.push([kk, i > 2 ? SEA.foam : SEA.deep, a, ww, DASH[i % 5]]);
      kk *= 1.040; a *= 0.90; ww *= 0.98;
    }
    for (const [k, col, a, w, dash] of CONTOUR) {
      s.push(`<path d="${coast(k)}" fill="none" stroke="${rgba(col, a)}"
        stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`);
    }

    /* --- the shore: sand, the inland foreshore dot line, then the
           coast drawn twice at different weights (a nib gone over
           twice) --- */
    s.push(`<path d="${coast(1)}" fill="${sand}"/>`);
    s.push(`<path d="${coast(1, ISL.beach)}" fill="url(#wm-land${U})"
      stroke="${rgba(LAND.dirt, 0.34)}" stroke-width="1.5" stroke-dasharray="7 6"/>`);
    s.push(`<path d="${coast(1)}" fill="none" stroke="${rgba(coastInk, 0.32)}" stroke-width="4.6"/>`);
    s.push(`<path d="${coast(0.998)}" fill="none" stroke="${rgba(coastInk, 0.78)}" stroke-width="2.3"/>`);

    /* --- offshore rocks, then the country between the districts --- */
    const shapes = zids.map((zid) => zoneShape(zid));
    s.push(rocks());
    s.push(`<g fill="none" stroke="${rgba(coastInk, 0.34)}" stroke-width="2.1"
      stroke-linecap="round" stroke-linejoin="round">${flecks(shapes)}</g>`);

    /* --- streets: an ink bed with a cream metal on top --- */
    for (const [a, b] of roads()) {
      s.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"
        stroke="${rgba(coastInk, 0.13)}" stroke-width="10" stroke-linecap="round"/>`);
      s.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"
        stroke="${rgba(BRAND.paper, 0.72)}" stroke-width="4" stroke-linecap="round"/>`);
    }

    /* ---------------- districts ----------------
       A surveyed district gets a wash, an engraver's hatch at its own
       angle, an inked boundary and a name. An unsurveyed one gets a
       ghost outline, a sparse stipple and its drawing at a tenth
       strength: blank paper with tooth, not a grey question mark. */
    /* ============================================================
       THE TYPE LAYER — one placer, and a name it cannot set clean is
       not set at all.

       The previous pass auctioned each label to the candidate with the
       least overlapping area and then PRINTED IT WHEREVER IT LANDED.
       With type derived in pixels instead of board units — the right
       fix, and the one that took the phone's place names off the
       six-pixel floor — that "least bad" became a guarantee of ink on
       ink: 54 overlapping label pairs and 13,151 px2 of collision on a
       335 px portrait plate, 35 of 42 words damaged. A chart with 28
       names on it that cannot be read is worth less than a chart with
       nine that can.

       So the auction now has a floor under it and three things it did
       not have:

         1. HARD REJECTION. A candidate that touches anything already
            standing costs forty times its own area — overlap is never
            traded against a nicer position — and a place name that
            still touches something after the whole board has settled
            is DROPPED. The pin stays; the name is one tap away, which
            is the same bargain the compact chart already struck.
            REJECTION IS NOT A GUARANTEE, and it cannot be for the
            labels marked `keep` (rule 3): the district captions, the
            selected place and the distance chip are printed whatever
            the auction finds, so for them the forty is a ranking and
            not a veto. When no clean candidate exists a kept caption
            prints the least-bad one, and on the crowded plates that
            still means a district name crossing a pin. What the forty
            does for them is decide WHICH pin and by how much — see
            THE GLYPH IS THE EXPENSIVE PART OF A PIN below, which is
            what makes "least bad" mean least bad to READ rather than
            least bad by the square unit.
         2. RELAXATION. Greedy placement is order-dependent, so after
            the first pass every label is lifted in turn and re-auctioned
            against the others, four sweeps or until nothing moves. This
            is what unpicks GREEN EDGE / IRON HILLS: neither can find
            room while the other is where it landed first.
         3. PRIORITY, and the right to be dropped. The selected place,
            the distance chip and the ten districts are kept whatever
            happens. Everything else is ranked by how much open paper it
            has around it — the greedy order that sets the most names —
            and yields when it must.

       And the type is drawn ON TOP OF THE INK, last. Names used to be
       emitted inside each pin's own group, so pin twelve printed over
       name three's paper halo and the halo could not save it. The chart
       now paints coast, districts, route, pins and the mark, and then
       every word.
       ============================================================ */
    const box = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
    const inter = (a, b) => Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1))
      * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));

    /* ink the type must not touch */
    const obst = [];
    /* type that is currently standing, by key, so a label can be lifted
       out and re-auctioned against everything except itself */
    const standing = new Map();
    /* `cap` is a BUDGET, not a filter: once a candidate has spent more
       ink than the best candidate so far can possibly beat, its exact
       total no longer matters and the sum stops. Only a losing
       candidate is ever cut short, so every figure the auction acts on
       is still exact — and the widened rings below cost almost
       nothing, because the far candidates are the ones that lose. */
    /* AND NOT ALL INK IS WORTH THE SAME. An obstacle may carry a
       weight `w`, and its overlap is charged at that multiple. Exactly
       one thing uses it — the pin glyphs, see below — and everything
       else is charged at its area. */
    const hits = (b, skip, cap) => {
      const lim = cap === undefined ? Infinity : cap;
      let t = 0;
      for (let i = 0; i < obst.length; i++) {
        const o = obst[i];
        t += o.w === undefined ? inter(b, o) : inter(b, o) * o.w;
        if (t > lim) return t;
      }
      for (const [key, o] of standing) {
        if (key === skip) continue;
        t += inter(b, o);
        if (t > lim) return t;
      }
      return t;
    };

    /* the traveller's line is geometry; its chip is type, and it goes
       through the same auction as everything else — "420 m" printed
       straight through a pin when it was placed by formula */
    const route = (() => {
      if (!sel) return null;
      /* the line lands on the symbol, not on the coordinate the symbol
         was displaced from, or it points a few pixels off its own pin */
      const sp = PX(sel);
      const dx = sp.x - me.x, dy = sp.y - me.y;
      const len = Math.hypot(dx, dy);
      if (len <= 24) return null;
      const nx = -dy / len, ny = dx / len;
      const bx = (me.x + sp.x) / 2 + nx * len * 0.09;
      const by = (me.y + sp.y) / 2 + ny * len * 0.09;
      /* points on the bow, for the chip's candidates */
      const at = (t) => {
        const u = 1 - t;
        return [u * u * me.x + 2 * u * t * bx + t * t * sp.x,
          u * u * me.y + 2 * u * t * by + t * t * sp.y];
      };
      return {
        d: `M${n1(me.x)} ${n1(me.y)}Q${n1(bx)} ${n1(by)} ${n1(sp.x)} ${n1(sp.y)}`,
        metres: Math.round(len * W.scale / 10) * 10,
        at, nx, ny, size: T.route,
      };
    })();

    /* the plaque is set on the sheet at -1.1 degrees, so its box is a
       shade bigger than its own width and height */
    if (CART.on) {
      const cpad = 3 / ppu;
      obst.push(box(CART.x - cpad, CART.y - cpad,
        CART.x + CART.w + cpad, CART.y + CART.h + cpad));
    }
    /* the rose is its disc PLUS its N, and the N is set above the disc
       with a 4-unit paper halo. The reservation used to be one flat
       1.2 em above the rim, which is a shade short of where the letter
       actually starts (9 units of gap, then its own ascent, then the
       halo) — INNOVATION DISTRICT found the difference and grazed the
       N by 3 px2 on the landscape sheet, and STAMPEDE DISTRICT found
       it again on the phone the moment the glyph weight below moved
       the captions around. Derived from the same numbers compassRose()
       draws with — 9 units of gap, the face's own ascent above the
       baseline (1.06 em, which is the type layer's 1.44 em line box
       less the 0.38 em that hangs under it), and half the 4-unit halo
       — so the reservation and the letter cannot drift apart. */
    const roseTop = ROSE.y - ROSE.r - 9 - T.roseN * 1.06 - 2.5;
    obst.push(box(ROSE.x - ROSE.r, roseTop, ROSE.x + ROSE.r, ROSE.y + ROSE.r));
    const shown = D.locations.filter((l) => game.known(l.id));
    const pinR = (l) => PX(l).r;
    /* THE GLYPH IS THE EXPENSIVE PART OF A PIN.

       A district caption is never dropped, so when the plate has no
       clean place for one it prints the least-bad candidate it could
       find — and "least bad" was measured against the pin's SQUARE
       footprint, inside which the symbol itself occupies a little over
       half the area and the rest is the disc's blank paper and its
       four empty corners. Grazing a corner and driving through the
       middle of the emoji cost the auction exactly the same per pixel,
       so it had no reason to prefer the harmless one. Measured before
       this: 28 caption-on-glyph pairs and 2335 px2 across the six
       charts, worst MARKET SQUARE through the mine's pick at 157 px2
       and LEARNING QUARTER through the co-op's tractor at 202 px2.

       So the glyph goes in as its own obstacle, at a weight. Its box
       is MEASURED, not modelled: getBBox on all 28 symbols at all
       three viewports gives half-width 0.703 r and half-height 0.742 r
       about a centre offset (+0.039 r, -0.011 r) from the disc's, and
       the spread across every glyph and every size is under 0.03 r —
       an emoji is a full-em tile whatever is drawn on it.

       The weight is 4, so glyph ink costs five times disc paper (the
       glyph box lies wholly inside the pin box, so both are charged).
       This does not stop a kept caption overlapping a symbol — nothing
       can, short of dropping district names, and a chart that will not
       tell you which district you are in is worse. It buys the choice
       BETWEEN bad candidates, which is the only choice there was.

       Four is measured, not picked. 3, 4, 5 and 8 were all run through
       the six charts. 3 gives 25 pairs / 1706 px2, 5 gives 24 / 1584,
       8 gives 29 / 1381 — but 3 and 5 each leave a caption grazing the
       compass N, 5 prints two fewer place names on the landscape
       sheet, and 8 opens a name-on-name pair that had been closed. 4
       gives 27 pairs / 1703 px2 with name-on-name back to the single
       pre-existing pair and two MORE place names set than before. The
       objective is not the smallest number; it is the smallest number
       that costs no name.

       WHAT IS LEFT, AND IN WHICH INSTRUMENT. Those figures are
       tools/_map-r5.mjs: all 28 places known and open, NOTHING
       selected, the compact chart through WALLY.debug.ui('places') and
       the sheet through ui('map'), each measured only after its plate
       stops resizing, at 390x844, 844x390 and 1400x900. Settled, and
       reproducible to the pixel, the six charts read 5, 7, 8, 4, 3 and
       0 caption-on-glyph pairs — 27 pairs, 1703 px2 — worst LEARNING
       QUARTER through the co-op's tractor at 196 px2 on the 844x390
       compact plate, which is the smallest plate the chart is ever
       drawn at. The 1400x900 sheet is clean: no caption touches any
       symbol, and all fourteen place names are set.

       WAIT FOR THE PLATE, NOT FOR A TIMER. Read at a flat 1800 ms
       instead, the landscape compact plate comes back 323x211 on one
       run and 333x218 on the next — it is still growing when the timer
       fires — and the placer, which auctions against whatever box it
       is handed, then reads 10 pairs / 473 px2 against 8 / 480 on
       identical code. That is the whole of the disagreement between
       this rig and the reviewing one on these counts. The magnitude is
       the fact and the address is not: expect a kept caption crossing
       a symbol on every chart but the desktop sheet, nowhere more than
       about a fifth of one glyph tile, and do not cite which glyph.

       Name on name, settled: five of the six charts are clean, and on
       the 844x390 compact plate GREEN EDGE grazes IRON HILLS by 8 px2
       with IRON HILLS and GOLDEN HEIGHTS touching at 0. Both pairs are
       kept captions, which cannot be dropped; no PLACE name touches
       anything on any chart. */
    const GLYPHW = 4;
    for (const l of shown) {
      /* the pin's real footprint, not its disc: the one he is standing
         on wears a tick ring and the selected one a dashed halo, both
         of which a name printed straight through in the first proof */
      const p = PX(l);
      const pr = p.r * 1.06 + (p.big ? 15 : 0);
      obst.push(box(p.x - pr, p.y - pr, p.x + pr, p.y + pr));
      const gx = p.x + p.r * 0.039, gy = p.y - p.r * 0.011;
      const gw = p.r * 0.703, gh = p.r * 0.742;
      const g = box(gx - gw, gy - gh, gx + gw, gy + gh);
      g.w = GLYPHW;
      obst.push(g);
    }
    const meR = T.mark * 0.68;
    obst.push(box(me.x - meR, me.y - meR, me.x + meR, me.y + meR));

    /* THE MARGIN IS INK TOO. A word half off the sheet used to cost a
       flat penalty, which a badly crowded name would happily pay —
       "Noodle Cart Alley" was set with its lower half outside the plate
       rule on the landscape sheet. The four margins are obstacles like
       everything else, so an excursion is an overlap, and an overlap is
       a name that gets dropped rather than a name that gets
       guillotined. The margin is the plate's own OUTER RULE (4 px),
       not its inner one: reserving all twelve of the inner rule on the
       landscape sheet — where the island fills the tight axis and the
       sea north and south is a hairline — cost seven coastal names to
       keep a band nobody had asked for. A word may cross the inner
       rule. It may not leave the sheet. */
    const MRG = 4 / ppu, FAR = 1e5;
    obst.push(box(vb.x - FAR, vb.y - FAR, vb.x + vb.w + FAR, vb.y + MRG));
    obst.push(box(vb.x - FAR, vb.y + vb.h - MRG, vb.x + vb.w + FAR, vb.y + vb.h + FAR));
    obst.push(box(vb.x - FAR, vb.y, vb.x + MRG, vb.y + vb.h));
    obst.push(box(vb.x + vb.w - MRG, vb.y, vb.x + vb.w + FAR, vb.y + vb.h));

    /* ---- the auction ----
       A label is a half-width, a half-height, an ordered list of places
       it would accept and how hard it pulls back toward the first of
       them. Candidate zero is the traditional spot and is free. */
    /* THE MODEL IS THE MEASUREMENT — and now it is a measurement of
       THIS STRING, not of an average string.

       Every half-width used to be (characters x font-size x a
       constant), the constant taken off a proof: 0.41 em per character
       of tracked caps, 0.29 mixed. A per-character average cannot be
       right for both WATERFRONT and INNOVATION DISTRICT, and it is
       not: measured against the rendered getBBox, WATERFRONT comes out
       at 0.410 and INNOVATION DISTRICT at 0.356, so the auction
       believed the longest caption on the chart was 28 px wider than
       it prints — fourteen pixels of imaginary ink hanging off each
       end of the one label that is never allowed to be dropped. It
       spent the whole auction hunting for a gap that did not need to
       be that big, took the least-bad collision it could find, and
       printed a district name through the distance chip.

       So ask the font. A 2D canvas set to the same face, weight, size
       and tracking returns the same advance width the SVG will lay
       down — checked across all 100 labels of all six charts against
       their rendered getBBox: mean error 0.05 %, worst 1.2 %. That is
       not a better guess, it is the answer. Cached by string, because
       ten districts times a hundred candidates is one measureText, not
       a thousand.

       HEIGHT stays modelled at 1.44 em. getBBox on SVG text returns
       the LINE box — the face's own ascent plus descent — not the
       glyph ink, so height genuinely is one number per size, and 1.44
       is that number measured. GUT is the only slack left: two pixels
       of white between one word and the next, stated in pixels like
       the type it separates. */
    const GUT = 2 / ppu;
    /* half-width in BOARD UNITS. Advance is linear in font-size, and
       the sizes here (26-53 board units) are far above the range where
       hinting would break that. `perChar` is the old per-character
       constant, kept as the fallback for a document with no canvas —
       a chart a shade too cautious beats no chart. */
    const measured = (s, fs, weight, track, perChar) => {
      const w = advance(s, fs, weight, track);
      return w === null ? s.length * fs * perChar + GUT : w / 2 + GUT;
    };
    /* THE HALO IS NOT PART OF THE WORD — TRIED AND REJECTED.

       Every label here is set with paint-order:stroke, so each word
       carries a band of opaque paper half its stroke-width wide, and
       that band ERASES what it lies on rather than sharing it. By the
       argument that closed the last round it belongs in the box: it is
       real ink the model was not counting, half a stroke on all four
       sides of every label. It was put in and measured, and it made
       the chart worse. Adding it (name 4.6, caption 5.5/7, chip 6.5,
       so 2.3-3.5 units a side) inflated every box past what the tight
       plates can seat: on the 335x383 portrait sheet the two captions
       that cannot be dropped collided with EACH OTHER for 74 px2 -
       LEARNING QUARTER through MARKET SQUARE, letterform on letterform
       - where before there was none, and the landscape sheet printed
       one fewer place name. It bought the removal of a single 3 px2
       halo-on-halo graze against the compass N.

       So the boxes stay cut to the letterforms plus GUT, and the
       honest statement of what that means is: two labels may share
       their paper bands, and none of them share their letters. That is
       a better chart than one whose model is complete and whose
       captions overlap. Do not re-add this without measuring; the
       numbers above are what it costs. */
    /* overlap is not a preference. Forty label-areas of cost means no
       amount of walking back to the traditional spot can buy a
       collision — the ratio that stopped IRON HILLS printing through
       the mine, taken to its conclusion. The walk back is the only
       other term, and because the candidate lists are written nearest
       first, it is also a bound: once some candidate has been found
       clean, every candidate further from home than that one is worth
       already loses on the walk alone and is never tested at all. */
    function auction(e, skip) {
      let best = null, bestCost = Infinity;
      const ink = 40 / (e.half * e.hh);
      const hx = e.cands[0][0], hy = e.cands[0][1];
      for (let i = 0; i < e.cands.length; i++) {
        const c = e.cands[i];
        const x = clampX(c[0], e.half), y = c[1];
        const dx = x - hx, dy = y - hy;
        const walk = Math.sqrt(dx * dx + dy * dy) * e.pull;
        if (walk >= bestCost) continue;
        const b = box(x - e.half, y - e.hh, x + e.half, y + e.hh);
        const over = hits(b, skip, (bestCost - walk) / ink);
        const cost = ink * over + walk;
        if (cost < bestCost) { bestCost = cost; best = { x, y, b, over }; }
      }
      return best;
    }
    function settleType(entries, sweeps) {
      for (const e of entries) {
        if (e.at) continue;
        e.at = auction(e, null);
        standing.set(e.key, e.at.b);
      }
      for (let s = 0; s < sweeps; s++) {
        let moved = 0;
        for (const e of entries) {
          if (!e.at) continue;
          const cur = hits(e.at.b, e.key);
          if (cur <= 0) continue;
          const r = auction(e, e.key);
          if (r.over < cur - 0.25) { e.at = r; standing.set(e.key, r.b); moved++; }
        }
        if (!moved) break;
      }
    }

    /* a ring of places a label would accept, each pushed far enough out
       that its own box clears the pin it belongs to */
    function ring(cx, cy, clear, half, hh, steps, mult, out) {
      for (const m of mult) {
        for (let a = 0; a < steps; a++) {
          const th = -Math.PI / 2 + (a / steps) * Math.PI * 2;
          const ux = Math.cos(th), uy = Math.sin(th);
          const d = clear * m + Math.abs(ux) * half + Math.abs(uy) * hh + 3;
          out.push([cx + ux * d, cy + uy * d]);
        }
      }
      return out;
    }

    /* ---- the entries, in the order they get to choose ---- */
    const capEntry = new Map(), nameEntry = new Map();
    const all = [];

    /* 1. the selected place, always named — it is the question the
          screen was opened to ask */
    const nameOf = (l, keep) => {
      const pr = pinR(l) + 4;
      const half = measured(l.n, T.name, 700, 0.4, 0.29);
      const hh = T.name * 0.70 + GUT * 0.4;
      const p = PX(l);
      const cands = [[p.x, p.y + pr + hh + 2]];
      ring(p.x, p.y, pr, half, hh, 12, [1, 1.7, 2.5, 3.5], cands);
      const e = {
        key: 'n:' + l.id, l, half, hh, cands, pull: 0.004, keep: !!keep, at: null,
      };
      nameEntry.set(l.id, e);
      all.push(e);
      return e;
    };
    if (sel && game.known(sel.id)) nameOf(sel, true);

    /* 2. the distance chip, on the outside of its own bow */
    let routeEntry = null;
    if (route) {
      /* the chip is the number AND its unit: "430 m", measured whole,
         where the old model was the digits plus a flat 1.1 em for a
         space and an m */
      const half = measured(route.metres + ' m', route.size, 700, 1.2, 0.33);
      const hh = route.size * 0.70 + GUT * 0.4;
      const cands = [];
      for (const t of [0.5, 0.38, 0.62, 0.28, 0.72]) {
        const p = route.at(t);
        for (const sgn of [1, -1]) {
          for (const m of [1.6, 2.6, 3.8]) {
            cands.push([p[0] + route.nx * sgn * hh * m, p[1] + route.ny * sgn * hh * m]);
          }
        }
      }
      routeEntry = { key: 'route', half, hh, cands, pull: 0.002, keep: true, at: null };
      all.push(routeEntry);
    }

    /* 3. the ten districts. A district's name is its identity on the
          chart and is never dropped; the biggest claims first because
          it has the most pins of its own to dodge. */
    const capOrder = zids.map((zid, i) => ({ zid, i }))
      .filter((e) => zoneKnown(e.zid))
      .sort((a, b) => shapes[b.i].members.length - shapes[a.i].members.length);
    for (const { zid, i } of capOrder) {
      const sh = shapes[i];
      const text = D.zones[zid].n.toUpperCase();
      const half = measured(text, T.cap, 700, T.capTrack, 0.41);
      const hh = T.cap * 0.72 + GUT * 0.4;
      const cands = [[sh.cx, sh.top + T.cap * 0.95]];
      /* small jogs first — a caption that only needs to slide eight
         pixels should not jump a ring to do it */
      /* a HALF-LINE is a jog too. The steps used to be whole
         line-heights and then some, which is the right size for a
         caption that has to clear another caption but far too big for
         one that is merely touching it: the last collision left on the
         tightest plate was GREEN EDGE grazing IRON HILLS by half a
         pixel, and there was no move available smaller than a jump of
         two lines that landed it somewhere worse. */
      for (const dx of [-1, -0.5, 0, 0.5, 1]) {
        for (const dy of [-2.1, -1.15, -0.6, 0, 0.6, 1.15, 2.1, 3.2]) {
          if (!dx && !dy) continue;
          cands.push([sh.cx + dx * half * 0.55, sh.top + T.cap * 0.95 + dy * hh]);
        }
      }
      for (const rr of [0.5, 0.8, 1.1, 1.4, 1.72, 2.1, 2.5]) {
        for (let a = 0; a < 24; a++) {
          const th = (a / 24) * Math.PI * 2 - Math.PI / 2;
          cands.push([sh.cx + Math.cos(th) * rr * sh.rmean,
            sh.cy + Math.sin(th) * rr * sh.rmean * 0.9]);
        }
      }
      const e = {
        key: 'c:' + zid, zid, half, hh, cands,
        pull: 1 / (sh.rmean * 6), keep: true, at: null,
      };
      capEntry.set(zid, e);
      all.push(e);
    }

    /* 4. where he is standing, then every other place he has found —
          most open paper first, which is the order that sets the most
          names before the plate runs out. ON THE COMPACT CHART there
          is no step 4 at all: eight names at eleven pixels across
          315 px of stock is lint, and its job is "where is the one I
          just tapped". */
    if (!compact) {
      const room = (l) => {
        let d = 1e9;
        for (const o of shown) if (o !== l) d = Math.min(d, Math.hypot(o.x - l.x, o.y - l.y));
        return d;
      };
      const rest = shown
        .filter((l) => !nameEntry.has(l.id))
        .map((l) => ({ l, r: room(l), here: game.state.loc === l.id }))
        .sort((a, b) => (b.here - a.here) || (b.r - a.r));
      for (const { l, here } of rest) nameOf(l, here);
    }

    settleType(all, 6);

    /* ---- and the ones that will not go ----
       Least important first, because a dropped name is room for the
       next one; then settle again and look once more. */
    const droppable = all.filter((e) => !e.keep);
    for (let pass = 0; pass < 3; pass++) {
      let dropped = 0;
      for (let i = droppable.length - 1; i >= 0; i--) {
        const e = droppable[i];
        if (!e.at) continue;
        if (hits(e.at.b, e.key) > 0.25) {
          standing.delete(e.key); e.at = null; nameEntry.delete(e.l.id); dropped++;
        }
      }
      if (!dropped) break;
      settleType(all.filter((e) => e.at), 2);
    }
    /* dropping a name is a hole in the sheet, and a hole is somewhere a
       wedged pair can finally go */

    /* ---- the shapes the drawing needs ---- */
    const nameAt = new Map();
    for (const e of all) {
      if (!e.at || !e.l) continue;
      nameAt.set(e.l.id, [e.at.x, e.at.y, 'middle']);
    }
    const capAt = new Map();
    for (const [zid, e] of capEntry) if (e.at) capAt.set(zid, [e.at.x, e.at.y]);

    /* A name that had to leave its own dot to find room is joined back
       to it by a hairline, which is what a plate does with a crowded
       coast — and it is what makes the outer rings usable at all. The
       test is the GAP between the pin's edge and the label's, not the
       distance between their centres: a long name set beside its pin
       is touching it however far its far end reaches. */
    const leaders = [];
    for (const e of all) {
      if (!e.at || !e.l) continue;
      const lp = PX(e.l);
      const dx = e.at.x - lp.x, dy = e.at.y - lp.y;
      const d = Math.hypot(dx, dy) || 1;
      const ux = dx / d, uy = dy / d;
      const pr = pinR(e.l);
      const edge = Math.abs(ux) * e.half + Math.abs(uy) * e.hh;
      if (d - edge - pr < pr * 0.85) continue;
      leaders.push(`M${n1(lp.x + ux * (pr + 2))} ${n1(lp.y + uy * (pr + 2))}`
        + `L${n1(e.at.x - ux * (edge + 2))} ${n1(e.at.y - uy * (edge + 2))}`);
    }
    const caps = [], names = [];

    zids.forEach((zid, i) => {
      const z = D.zones[zid];
      const sh = shapes[i];
      const known = zoneKnown(zid);
      const tint = boost(hex(z.tint));
      const spot = motifSpot(sh, T.motif);

      if (known) {
        s.push(`<path d="${sh.d}" fill="${rgba(tint, 0.17)}"/>`);
        s.push(`<path d="${sh.d}" fill="url(#wh${i}${U})"/>`);
        s.push(`<path d="${sh.d}" fill="none" stroke="${rgba(mix(tint, coastInk, 0.42), 0.66)}"
          stroke-width="2.4" stroke-linejoin="round"/>`);
        s.push(motif(zid, spot, T.motif, 0.34));
      } else {
        s.push(`<path d="${sh.d}" fill="url(#wm-stip${U})"/>`);
        s.push(`<path d="${sh.d}" fill="none" stroke="${rgba(coastInk, 0.17)}"
          stroke-width="1.6" stroke-dasharray="4 12" stroke-linejoin="round"/>`);
        s.push(motif(zid, spot, T.motif, 0.11));
      }

      /* only a surveyed district is named — the chart writes down what
         he has actually found, which is what makes finding it worth
         something */
      if (!known) return;
      const at = capAt.get(zid);
      caps.push(`<text x="${n1(at[0])}" y="${n1(at[1] + T.cap * 0.34)}"
        text-anchor="middle" font-size="${T.cap}"
        font-weight="700" letter-spacing="${T.capTrack}"
        stroke="${rgba(BRAND.paper, 0.94)}" stroke-width="${compact ? 7 : 5.5}" paint-order="stroke"
        fill="${rgba(mix(tint, coastInk, 0.52), 0.96)}"
        >${esc(z.n.toUpperCase())}</text>`);
    });

    /* ---------------- the traveller's line ----------------
       Drawn on real distance, not on state.loc: the marker is his LIVE
       3D position, so "he is at the apartment" and "he is standing on
       the apartment pin" are different facts, and the route answers the
       second one. Bowed, dotted, and it prints the crossing in metres —
       which is the question the line is being asked. */
    if (route) {
      s.push(`<path d="${route.d}" fill="none" stroke="${rgba(BRAND.paper, 0.8)}" stroke-width="10"
        stroke-linecap="round"/>`);
      s.push(`<path d="${route.d}" fill="none" stroke="${rgba(coastInk, 0.30)}" stroke-width="6.4"
        stroke-linecap="round" stroke-dasharray="1 15"/>`);
      s.push(`<path d="${route.d}" fill="none" stroke="${C(BRAND.token2)}" stroke-width="3.6"
        stroke-linecap="round" stroke-dasharray="16 12"/>`);
    }

    /* ---------------- the places ----------------
       Only what he has found is on the chart. An unfound place leaves
       blank stock: that is what an old chart does with country nobody
       has walked, and it is what makes walking into one feel like it
       added a line to the plate. */
    for (const l of D.locations) {
      if (!game.known(l.id)) continue;
      const here = game.state.loc === l.id;
      const isSel = selected === l.id;
      const tint = boost(hex(D.zones[l.z].tint));
      const p = PX(l);
      const x = n1(p.x), y = n1(p.y), r = p.r;

      s.push(`<g data-loc="${l.id}" class="on" style="cursor:pointer;pointer-events:auto">`);
      /* The target, cut toward the bisector: as generous as it can be
         without reaching into the next place's, floored at its own ink.
         On open country that is still the full 46 units — three times
         the pin — and in the knot it is half the gap, which is the
         fairest split there is, unless half the gap is less than the
         symbol, in which case the symbol wins and two targets share
         under half a pixel of radius (measured, and measured again in
         a second rig that reads the chart at a different scale; see
         the PINS block above for the instrument and the range that
         survives it). A stack of equal targets is not generosity, it is a
         coin toss with the player's thumb. */
      s.push(`<circle class="wm-hit" cx="${x}" cy="${y}" r="${n1(p.tap)}" fill="transparent"/>`);
      if (here) {
        /* where he is standing: a surveyor's tick ring, not a colour */
        let ticks = '';
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          ticks += `M${n1(p.x + Math.cos(a) * (r + 7))} ${n1(p.y + Math.sin(a) * (r + 7))}`
            + `L${n1(p.x + Math.cos(a) * (r + 15))} ${n1(p.y + Math.sin(a) * (r + 15))}`;
        }
        s.push(`<path d="${ticks}" stroke="${rgba(coastInk, 0.42)}" stroke-width="2.2" fill="none"/>`);
      }
      if (isSel) {
        s.push(`<circle cx="${x}" cy="${y}" r="${n1(r + 13)}" fill="none"
          stroke="${rgba(BRAND.token, 0.85)}" stroke-width="4.4" stroke-dasharray="8 7"/>`);
      }
      s.push(`<circle cx="${x}" cy="${n1(p.y + 4)}" r="${n1(r)}" fill="${rgba(coastInk, 0.22)}"/>`);
      s.push(`<circle class="wm-pin" cx="${x}" cy="${y}" r="${n1(r)}" fill="${paperLit}"
        stroke="${isSel ? C(BRAND.token2) : rgba(coastInk, 0.72)}" stroke-width="${isSel ? 5 : 3.2}"/>`);
      s.push(`<circle cx="${x}" cy="${y}" r="${n1(r - 5.4)}" fill="none"
        stroke="${rgba(tint, 0.85)}" stroke-width="1.8"/>`);
      s.push(`<text x="${x}" y="${n1(p.y + r * 0.34)}" text-anchor="middle" class="wm-ico"
        font-size="${n1(r * 0.94)}">${esc(l.ico)}</text>`);
      if (!game.isOpen(l.id)) {
        /* closed: a bead at the shoulder, the same language as the
           list's Closed chip */
        s.push(`<circle cx="${n1(p.x + r * 0.76)}" cy="${n1(p.y - r * 0.76)}" r="${n1(r * 0.30)}"
          fill="${C(BRAND.bad)}" stroke="${paperLit}" stroke-width="2.4"/>`);
      }
      s.push('</g>');
      /* the word itself is held back for the type layer — its own
         group, so tapping the name still picks the place */
      const at = nameAt.get(l.id);
      if (at) {
        names.push(`<g data-loc="${l.id}" class="on" style="cursor:pointer;pointer-events:auto"
          ><text x="${n1(at[0])}" y="${n1(at[1] + T.name * 0.34)}" text-anchor="${at[2]}"
          font-size="${T.name}" font-weight="700" letter-spacing="0.4"
          stroke="${rgba(BRAND.paper, 0.94)}" stroke-width="4.6" paint-order="stroke"
          fill="${rgba(coastInk, 0.92)}">${esc(l.n)}</text></g>`);
      }
    }

    /* ---------------- Wally ----------------
       The mark, die-cut on a paper token and pressed onto the chart:
       head-ball, ears, wayfarers, the glint. A dot cannot be him.

       Two things the flat mark needs before it survives 25 px on cream.
       (1) A token-orange rim on the disc — the one colour this UI has
       already taught the player to read as "you", and the only ring on
       the chart that is not ink. (2) A KEYLINE under the mark: the clay
       is #D3D3D2 and the stock is #F7EFE0, four values apart, so
       unoutlined he printed as a pair of floating sunglasses. The
       keyline is the mark's own silhouette — two ears, the head-ball,
       the trunk — spread by a stroke, the same trick the favicon uses
       at 16 px. It is a print keyline on a 2D mark, not an outline on
       Wally in the world: ART_DIRECTION §1.2 still holds where it
       means something. No name plate: the face is the label, and the
       word printed through MAIN STREET when it had one.

       THE KEYLINE IS NOT COPIED. It used to be four literal shapes
       transcribed off the mark, and when the mark was redrawn — ear
       tips lifted above the crown, the trunk re-cut — the outline went
       on tracing a Wally that no longer existed and printed as an
       uneven halo. style.js exports wallyKeyline() from the same
       constants wallyMarkup() draws from, so the two cannot drift.

       CENTRING. The mark's own bbox in its 64-box is x 2.6..61.4 and
       y 8.96..57.6 (ear ellipses rotated 22 degrees, trunk tip at
       57.6): centre 32.0, 33.28. The old translate(-32 -31) was cut
       for the old silhouette and now sits the pawn 2.4 units high in
       its disc, which at 31 px is a visible gap under the trunk and a
       tight ear at the top. -33.28 is measured, not nudged. */
    const K = T.mark;
    const R = K * 0.50;
    const keyline = wallyKeyline(`fill="${rgba(coastInk, 0.85)}" stroke="${rgba(coastInk, 0.85)}"
      stroke-width="3.4" stroke-linejoin="round"`);
    s.push(`<g class="wm-me">
      <circle cx="${n1(me.x)}" cy="${n1(me.y)}" r="${n1(R * 1.36)}" fill="${rgba(BRAND.token, 0.30)}"/>
      <ellipse cx="${n1(me.x)}" cy="${n1(me.y + R * 0.88)}" rx="${n1(R * 0.84)}" ry="${n1(R * 0.28)}"
        fill="${rgba(coastInk, 0.26)}"/>
      <circle cx="${n1(me.x)}" cy="${n1(me.y)}" r="${n1(R)}" fill="${paperLit}"
        stroke="${C(BRAND.token2)}" stroke-width="${n1(R * 0.14)}"/>
      <g transform="translate(${n1(me.x)} ${n1(me.y)}) scale(${n1(K / 64 * 0.78 * 100) / 100}) translate(-32 -33.28)">
        ${keyline}${wallyMarkup(U)}
      </g>
    </g>`);

    /* ---------------- furniture ----------------
       The rose and the plaque go down BEFORE the words. Both are
       opaque paper, and drawn after them the plaque printed over the
       G of GOLDEN HEIGHTS and the rose's disc ate the ICT of STAMPEDE
       DISTRICT — decoration deleting data. They are obstacles in the
       auction, so type lands on them only when the plate has run out
       of room, and when it does the word is the thing that survives. */
    s.push(compassRose());
    if (CART.on) s.push(cartouche(found, D.locations.length));

    /* ---------------- THE TYPE, LAST ----------------
       Every word on the plate, over every mark on it. The leaders go
       down first (a hairline belongs under the word it carries), then
       the district names, then the place names, then the crossing in
       metres — which is the newest fact on the sheet and the one thing
       a route is being asked. */
    if (leaders.length) {
      /* in PIXELS. A hairline stated in board units is 0.4 px on a
         phone — the same unit slip that printed the six-pixel name,
         and it made the leaders invisible in their first proof. */
      const lead = leaders.join('');
      s.push(`<path d="${lead}" fill="none" stroke="${rgba(BRAND.paper, 0.88)}"
        stroke-width="${n1(3.4 / ppu)}" stroke-linecap="round"/>`);
      s.push(`<path d="${lead}" fill="none" stroke="${rgba(coastInk, 0.62)}"
        stroke-width="${n1(1.25 / ppu)}" stroke-linecap="round"/>`);
    }
    s.push(caps.join(''));
    s.push(names.join(''));
    if (route && routeEntry && routeEntry.at) {
      s.push(`<text x="${n1(routeEntry.at.x)}" y="${n1(routeEntry.at.y + route.size * 0.34)}"
        text-anchor="middle" font-size="${route.size}" font-weight="700" letter-spacing="1.2"
        stroke="${rgba(BRAND.paper, 0.94)}" stroke-width="6.5" paint-order="stroke"
        fill="${C(BRAND.token2)}">${route.metres} m</text>`);
    }

    /* ---------------- the plate mark ---------------- */
    s.push(`<rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}"
      fill="url(#wm-vig${U})" pointer-events="none"/>`);

    /* the plate: a hairline outer rule, a heavier inner rule, and a
       graticule of ticks every hundred board units */
    /* in PIXELS, like everything else here: a plate mark 16 board units
       in is 8 px on the desk sheet and 3 px on a phone held sideways,
       and 3 px reads as a printing error rather than as a margin */
    const i0 = n1(4 / ppu), i1 = n1(11 / ppu), tick = n1(4 / ppu);
    let grat = '';
    for (let gx = 0; gx <= MAP.w; gx += 100) {
      grat += `M${gx} ${n1(vb.y + i1)}v${tick}M${gx} ${n1(vb.y + vb.h - i1)}v-${tick}`;
    }
    for (let gy = 0; gy <= MAP.h; gy += 100) {
      grat += `M${n1(vb.x + i1)} ${gy}h${tick}M${n1(vb.x + vb.w - i1)} ${gy}h-${tick}`;
    }
    s.push(`<path d="${grat}" stroke="${rgba(coastInk, 0.34)}" stroke-width="1.6" fill="none"/>`);
    s.push(`<rect x="${vb.x + i0}" y="${vb.y + i0}" width="${vb.w - i0 * 2}" height="${vb.h - i0 * 2}"
      fill="none" stroke="${rgba(coastInk, 0.26)}" stroke-width="1.4"/>`);
    s.push(`<rect x="${vb.x + i1}" y="${vb.y + i1}" width="${vb.w - i1 * 2}" height="${vb.h - i1 * 2}"
      fill="none" stroke="${rgba(coastInk, 0.55)}" stroke-width="2.6"/>`);

    return s.join('');
  }

  const hex = (t) => (typeof t === 'string' ? parseInt(t.replace('#', ''), 16) : t);
  const esc = (t) => String(t).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  /* keep a long caption ("INNOVATION DISTRICT") inside the plate mark —
     clamped on its OWN half-width, not on a constant, or the longest
     name is the one that runs off the sheet */
  const clampX = (x, half) => {
    const m = 9 / ppu + half;
    return m * 2 > vb.w ? vb.x + vb.w / 2 : Math.max(vb.x + m, Math.min(vb.x + vb.w - m, x));
  };

  /* ============================================================
     element
     ============================================================ */
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'w-map-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('aria-label', 'Chart of Bull Bear City');
  /* ============================================================
     ONLY A PLACE IS TAPPABLE.

     An SVG stroke catches pointer events, and this chart draws a great
     deal of stroke ON TOP of the pins: the traveller's line is a 10-unit
     paper bed under a dashed orange metal, the leaders are hairlines
     from a name back to its dot, the district captions are set with a
     4.6-unit paper halo, and Wally's own mark is a 40-unit token. Every
     one of them is painted after the places, so every one of them was
     eating taps aimed at a pin underneath it — measured before this
     line, 66 of 252 probes on the pin ink itself did not reach their
     own place, and a third of those hit no place at all.

     So the sheet is inert and the places opt back in: pointer-events
     off at the root, `auto` on each `[data-loc]` group. Decoration can
     now be drawn wherever the drawing needs it without any of it
     costing a tap.
     ============================================================ */
  svg.style.pointerEvents = 'none';
  const el = h('div.w-map' + (compact ? '.compact' : ''), null, svg);

  function render() {
    layout();
    svg.setAttribute('viewBox', `${n1(vb.x)} ${n1(vb.y)} ${n1(vb.w)} ${n1(vb.h)}`);
    svg.innerHTML = paint();
    for (const g of svg.querySelectorAll('[data-loc]')) {
      g.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = g.getAttribute('data-loc');
        if (!game.known(id)) return;
        selected = id;
        render();
        opts.onPick?.(id);
      });
    }
  }
  render();

  /* The chart is built before the caller has put it in the page, so the
     first cut is made against a fallback width. Once it is connected,
     measure for real and — only if the plate came out a different size
     — cut it again. Same on a rotate: a phone that turns over is a
     different sheet of paper, not the same one stretched. */
  let settles = 0;
  function settle() {
    if (!el.isConnected) { if (++settles < 90) requestAnimationFrame(settle); return; }
    if (layout()) render();
  }
  requestAnimationFrame(settle);
  const onResize = () => {
    if (!el.isConnected) { window.removeEventListener('resize', onResize); return; }
    if (layout()) render();
  };
  window.addEventListener('resize', onResize, { passive: true });

  /* Walk within range of somewhere new with the chart open and it inks
     itself in under your thumb — the pin, the district wash, the hatch,
     the name, the roads out of it. That is the whole reason undiscovered
     is blank paper, so the chart redraws itself rather than waiting for
     the screen around it to be rebuilt. Cheap: one repaint is ~1.3 ms
     even with all 28 places found. */
  const offDiscover = ctx.bus?.on?.('discover', () => {
    if (el.isConnected) render();
    else offDiscover?.();
  });

  return {
    el, svg,
    get selected() { return selected; },
    select(id) { selected = id; render(); },
    refresh: render,
    dispose() { offDiscover?.(); window.removeEventListener('resize', onResize); },
  };
}

export default cityMap;
