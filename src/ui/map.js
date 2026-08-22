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
import { h, rgba, mix, C, wallyMarkup } from './style.js';

const NS = 'http://www.w3.org/2000/svg';

/* The board is 1000x660 and the shoreline ellipse is bigger than the
   board in both axes, so the view is padded until the WHOLE coast
   closes inside the plate with sea left over. It has to close: an
   island whose coastline runs off the top of the sheet is a detail of a
   chart, and this one is meant to read as the whole holding. The
   padding is set from the shoreline radius (1.10 at the wobble's
   maximum) plus a sea margin, not chosen by eye. */
const PAD_X = 140, PAD_Y = 186;

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

  const vb = {
    x: -PAD_X, y: -PAD_Y,
    w: MAP.w + PAD_X * 2, h: MAP.h + PAD_Y * 2,
  };

  /* island ellipse, in board units (data.js states it in metres) */
  const ISL = {
    cx: W.originMapX, cy: W.originMapY,
    rx: W.islandRadiusX / W.scale, ry: W.islandRadiusZ / W.scale,
    beach: W.beachWidth / W.scale,
  };

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

  /* Type scale. The compact chart is ~315 px wide on a 390 px phone —
     0.246 px per board unit — so a caption at the old 24 units printed
     at six pixels and ten districts of them printed as grey lint.
     Everything here is sized back from "about eleven pixels on a phone"
     and then checked in a screenshot, not chosen. */
  const T = compact
    ? { cap: 40, capTrack: 2.2, name: 0, pin: 33, title: 38, titleTrack: 1.8, sub: 31, rose: 64, roseN: 36, motif: 94, mark: 100 }
    : { cap: 27, capTrack: 1.8, name: 24, pin: 27, title: 30, titleTrack: 2.2, sub: 21, rose: 66, roseN: 26, motif: 82, mark: 84 };

  let selected = opts.selected || null;

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
  const ROSE = { x: vb.x + vb.w - T.rose - 34, y: vb.y + vb.h - T.rose - 34, r: T.rose };
  /* The plaque is cut to fit its own title — 0.62 em per character of
     tracked serif caps, measured off the first proof. Hard-coding a
     width is how the first pass printed BULL BEAR CITY through its own
     left border and off the plate. */
  const TITLE = 'BULL BEAR CITY';
  const CART = (() => {
    const w = Math.round(TITLE.length * T.title * 0.62 + (TITLE.length - 1) * T.titleTrack + 54);
    return { w, h: Math.round(T.title * 1.62 + T.sub * 1.5), x: vb.x + 30, y: vb.y + 28 };
  })();

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
    const { x, y, w: cw, h: ch } = CART;
    const c = 14;
    const plaque = (i) => `M${x + c + i} ${y + i}H${x + cw - c - i}L${x + cw - i} ${y + c + i}`
      + `V${y + ch - c - i}L${x + cw - c - i} ${y + ch - i}H${x + c + i}`
      + `L${x + i} ${y + ch - c - i}V${y + c + i}Z`;
    const midX = x + cw / 2;
    const ruleY = y + ch * 0.605;
    return `<g class="wm-cart" transform="rotate(-1.1 ${n1(midX)} ${n1(y + ch / 2)})">
      <path d="${plaque(3)}" fill="${rgba(mix(ink, SHADOW.tint, 0.5), 0.22)}" transform="translate(4 6)"/>
      <path d="${plaque(0)}" fill="${paperLit}" stroke="${rgba(coastInk, 0.62)}" stroke-width="2.4"/>
      <path d="${plaque(7)}" fill="none" stroke="${rgba(coastInk, 0.30)}" stroke-width="1.2"/>
      <text x="${n1(midX)}" y="${n1(y + ch * 0.45)}" text-anchor="middle"
        font-size="${T.title}" font-weight="700" letter-spacing="${T.titleTrack}"
        fill="${rgba(coastInk, 0.95)}">${TITLE}</text>
      <path d="M${n1(x + 38)} ${n1(ruleY)}H${n1(x + cw - 38)}" stroke="${rgba(coastInk, 0.4)}" stroke-width="1.3"/>
      <path d="M${n1(x + 32)} ${n1(ruleY)}l6-3.6v7.2zM${n1(x + cw - 32)} ${n1(ruleY)}l-6-3.6v7.2z"
        fill="${rgba(coastInk, 0.5)}"/>
      <text x="${n1(midX)}" y="${n1(y + ch * 0.87)}" text-anchor="middle"
        font-size="${T.sub}" font-weight="700" letter-spacing="${compact ? 2.2 : 1.6}"
        fill="${rgba(coastInk, 0.64)}">${found} OF ${total} SURVEYED</text>
    </g>`;
  }

  /* ============================================================
     paint
     ============================================================ */
  function paint() {
    const me = wallyAt();
    const sel = selected ? D.locationById[selected] : null;
    const found = D.locations.filter((l) => game.known(l.id)).length;
    const s = [];

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
    const CONTOUR = [
      [1.017, SEA.foam, 0.60, 2.6, ''], [1.042, SEA.foam, 0.34, 2.0, ''],
      [1.072, SEA.deep, 0.16, 1.9, '30 15'], [1.104, SEA.deep, 0.12, 1.7, '20 17'],
      [1.142, SEA.deep, 0.085, 1.6, '13 19'],
    ];
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
    /* ---- where the ten names go ----
       The first pass walked a caption downward until it missed the
       other captions, which is why at full discovery MARKET SQUARE
       printed straight through six pins and INNOVATION DISTRICT through
       the Stampede's. Everything already on the plate that a name must
       not touch — the cartouche, the rose, every pin, every pin's own
       label — is a box; a caption is a box; each name takes the
       candidate position with the least overlapping area, biased toward
       the traditional spot just inside its district's top edge. */
    const boxes = [];
    const box = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });

    /* the traveller's line and its distance chip are geometry, not
       layout — they are computed first and everything else lays out
       around them (420 m printed straight through RUSTY ROW when the
       chip was placed after the names) */
    const route = (() => {
      if (!sel) return null;
      const dx = sel.x - me.x, dy = sel.y - me.y;
      const len = Math.hypot(dx, dy);
      if (len <= 24) return null;
      const nx = -dy / len, ny = dx / len;
      const bx = (me.x + sel.x) / 2 + nx * len * 0.09;
      const by = (me.y + sel.y) / 2 + ny * len * 0.09;
      const off = compact ? 42 : 30;
      return {
        d: `M${n1(me.x)} ${n1(me.y)}Q${n1(bx)} ${n1(by)} ${sel.x} ${sel.y}`,
        metres: Math.round(len * W.scale / 10) * 10,
        lx: (me.x + sel.x) * 0.25 + bx * 0.5 + nx * off,
        ly: (me.y + sel.y) * 0.25 + by * 0.5 + ny * off,
        size: compact ? 32 : 22,
      };
    })();
    const overlap = (b) => boxes.reduce((t, o) => t
      + Math.max(0, Math.min(b.x2, o.x2) - Math.max(b.x1, o.x1))
      * Math.max(0, Math.min(b.y2, o.y2) - Math.max(b.y1, o.y1)), 0);

    boxes.push(box(CART.x, CART.y, CART.x + CART.w, CART.y + CART.h));
    boxes.push(box(ROSE.x - ROSE.r, ROSE.y - ROSE.r - T.roseN * 1.2, ROSE.x + ROSE.r, ROSE.y + ROSE.r));
    const shown = D.locations.filter((l) => game.known(l.id));
    const pinR = (l) => (game.state.loc === l.id || selected === l.id ? T.pin * 1.2 : T.pin);
    for (const l of shown) {
      const pr = pinR(l) * 1.05;
      boxes.push(box(l.x - pr, l.y - pr, l.x + pr, l.y + pr));
    }
    const meR = T.mark * 0.68;
    boxes.push(box(me.x - meR, me.y - meR, me.x + meR, me.y + meR));
    if (route) {
      const rw = String(route.metres).length * route.size * 0.42 + route.size;
      boxes.push(box(route.lx - rw, route.ly - route.size * 0.7,
        route.lx + rw, route.ly + route.size * 0.7));
    }

    /* ---- and where the place names go ----
       Same auction, one ring smaller: below the pin, then above, then
       out to either side. "Your Apartment" and "Noodle Cart Alley" are
       forty units apart and both wanted the space under their own pin. */
    const nameAt = new Map();
    if (T.name) {
      for (const l of [...shown].sort((a, b) => a.y - b.y)) {
        const pr = pinR(l) + 4;
        const half = l.n.length * T.name * 0.30 + 8;
        const hh = T.name * 0.62;
        const cands = [
          [l.x, l.y + pr + hh, 'middle'], [l.x, l.y - pr - hh, 'middle'],
          [l.x + pr + half + 3, l.y + hh * 0.4, 'middle'],
          [l.x - pr - half - 3, l.y + hh * 0.4, 'middle'],
          [l.x, l.y + pr + hh * 2.5, 'middle'],
        ];
        let best = cands[0], bestCost = Infinity;
        for (const c of cands) {
          const x = clampX(c[0], half);
          const b = box(x - half, c[1] - hh, x + half, c[1] + hh);
          const cost = overlap(b) / (half * hh) + (c === cands[0] ? 0 : 0.10);
          if (cost < bestCost) { bestCost = cost; best = [x, c[1], c[2]]; }
        }
        boxes.push(box(best[0] - half, best[1] - hh, best[0] + half, best[1] + hh));
        nameAt.set(l.id, best);
      }
    }

    const caps = [];
    /* biggest districts claim their spot first — a four-place district
       has more pins to dodge and fewer places left to go */
    const order = zids.map((zid, i) => ({ zid, i }))
      .filter((e) => zoneKnown(e.zid))
      .sort((a, b) => shapes[b.i].members.length - shapes[a.i].members.length);

    const capAt = new Map();
    for (const { zid, i } of order) {
      const sh = shapes[i];
      const text = D.zones[zid].n.toUpperCase();
      const half = text.length * T.cap * 0.40 + 14;
      const hh = T.cap * 0.60;
      const home = [sh.cx, sh.top + T.cap * 0.95];
      const cands = [home];
      for (const rr of [0.55, 0.85, 1.15, 1.45, 1.75]) {
        for (let a = 0; a < 16; a++) {
          const th = (a / 16) * Math.PI * 2 - Math.PI / 2;
          cands.push([sh.cx + Math.cos(th) * rr * sh.rmean, sh.cy + Math.sin(th) * rr * sh.rmean * 0.9]);
        }
      }
      let best = home, bestCost = Infinity;
      for (const [ax, ay] of cands) {
        const x = clampX(ax, half), y = ay;
        const b = box(x - half, y - hh, x + half, y + hh);
        /* overlapping anything is five times worse than walking away
           from the traditional spot — that ratio is what stopped IRON
           HILLS printing through the mine */
        let cost = 5 * overlap(b) / (half * hh);
        cost += Math.hypot(x - home[0], y - home[1]) / (sh.rmean * 6);
        if (b.y1 < vb.y + 26 || b.y2 > vb.y + vb.h - 26) cost += 8;
        if (cost < bestCost) { bestCost = cost; best = [x, y]; }
      }
      boxes.push(box(best[0] - half, best[1] - hh, best[0] + half, best[1] + hh));
      capAt.set(zid, best);
    }

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
    s.push(caps.join(''));

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
      /* the crossing, in metres, set clear of its own line on the
         outside of the bow — the one thing a route is being asked */
      s.push(`<text x="${n1(route.lx)}" y="${n1(route.ly + route.size * 0.34)}"
        text-anchor="middle" font-size="${route.size}" font-weight="700" letter-spacing="1.2"
        stroke="${rgba(BRAND.paper, 0.94)}" stroke-width="5.5" paint-order="stroke"
        fill="${C(BRAND.token2)}">${route.metres} m</text>`);
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
      const r = here || isSel ? T.pin * 1.2 : T.pin;

      s.push(`<g data-loc="${l.id}" class="on" style="cursor:pointer">`);
      /* a generous invisible target — a pin is 8-14 px on a phone */
      s.push(`<circle cx="${l.x}" cy="${l.y}" r="${n1(Math.max(46, r * 1.7))}" fill="transparent"/>`);
      if (here) {
        /* where he is standing: a surveyor's tick ring, not a colour */
        let ticks = '';
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          ticks += `M${n1(l.x + Math.cos(a) * (r + 7))} ${n1(l.y + Math.sin(a) * (r + 7))}`
            + `L${n1(l.x + Math.cos(a) * (r + 15))} ${n1(l.y + Math.sin(a) * (r + 15))}`;
        }
        s.push(`<path d="${ticks}" stroke="${rgba(coastInk, 0.42)}" stroke-width="2.2" fill="none"/>`);
      }
      if (isSel) {
        s.push(`<circle cx="${l.x}" cy="${l.y}" r="${n1(r + 13)}" fill="none"
          stroke="${rgba(BRAND.token, 0.85)}" stroke-width="4.4" stroke-dasharray="8 7"/>`);
      }
      s.push(`<circle cx="${l.x}" cy="${n1(l.y + 4)}" r="${n1(r)}" fill="${rgba(coastInk, 0.22)}"/>`);
      s.push(`<circle cx="${l.x}" cy="${l.y}" r="${n1(r)}" fill="${paperLit}"
        stroke="${isSel ? C(BRAND.token2) : rgba(coastInk, 0.72)}" stroke-width="${isSel ? 5 : 3.2}"/>`);
      s.push(`<circle cx="${l.x}" cy="${l.y}" r="${n1(r - 5.4)}" fill="none"
        stroke="${rgba(tint, 0.85)}" stroke-width="1.8"/>`);
      s.push(`<text x="${l.x}" y="${n1(l.y + r * 0.34)}" text-anchor="middle" class="wm-ico"
        font-size="${n1(r * 0.94)}">${esc(l.ico)}</text>`);
      if (!game.isOpen(l.id)) {
        /* closed: a bead at the shoulder, the same language as the
           list's Closed chip */
        s.push(`<circle cx="${n1(l.x + r * 0.76)}" cy="${n1(l.y - r * 0.76)}" r="${n1(r * 0.30)}"
          fill="${C(BRAND.bad)}" stroke="${paperLit}" stroke-width="2.4"/>`);
      }
      const at = nameAt.get(l.id);
      if (at) {
        s.push(`<text x="${n1(at[0])}" y="${n1(at[1] + T.name * 0.34)}" text-anchor="${at[2]}"
          font-size="${T.name}" font-weight="700" letter-spacing="0.4"
          stroke="${rgba(BRAND.paper, 0.94)}" stroke-width="4.6" paint-order="stroke"
          fill="${rgba(coastInk, 0.92)}">${esc(l.n)}</text>`);
      }
      s.push('</g>');
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
       word printed through MAIN STREET when it had one. */
    const K = T.mark;
    const R = K * 0.50;
    const keyline = `<g fill="${rgba(coastInk, 0.85)}" stroke="${rgba(coastInk, 0.85)}"
      stroke-width="3.4" stroke-linejoin="round">
      <ellipse cx="11.5" cy="30" rx="9.6" ry="12.6" transform="rotate(-11 11.5 30)"/>
      <ellipse cx="52.5" cy="30" rx="9.6" ry="12.6" transform="rotate(11 52.5 30)"/>
      <ellipse cx="32" cy="28.5" rx="17.4" ry="17"/>
      <path d="M32 40c4.6 0 6.5 3 6.5 8.2 0 4.2-1.7 7.4-3.1 9.6-1 1.6-3.6 1.4-4.4-.2-1.2-2.4-2.6-5.2-2.6-9.4 0-5.2 1-8.2 3.6-8.2z"/>
    </g>`;
    s.push(`<g class="wm-me">
      <circle cx="${n1(me.x)}" cy="${n1(me.y)}" r="${n1(R * 1.36)}" fill="${rgba(BRAND.token, 0.30)}"/>
      <ellipse cx="${n1(me.x)}" cy="${n1(me.y + R * 0.88)}" rx="${n1(R * 0.84)}" ry="${n1(R * 0.28)}"
        fill="${rgba(coastInk, 0.26)}"/>
      <circle cx="${n1(me.x)}" cy="${n1(me.y)}" r="${n1(R)}" fill="${paperLit}"
        stroke="${C(BRAND.token2)}" stroke-width="${n1(R * 0.14)}"/>
      <g transform="translate(${n1(me.x)} ${n1(me.y)}) scale(${n1(K / 64 * 0.80 * 100) / 100}) translate(-32 -31)">
        ${keyline}${wallyMarkup(U)}
      </g>
    </g>`);

    /* ---------------- furniture and the plate mark ---------------- */
    s.push(compassRose());
    s.push(cartouche(found, D.locations.length));

    s.push(`<rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}"
      fill="url(#wm-vig${U})" pointer-events="none"/>`);

    /* the plate: a hairline outer rule, a heavier inner rule, and a
       graticule of ticks every hundred board units */
    const i0 = 5, i1 = 16;
    let grat = '';
    for (let gx = 0; gx <= MAP.w; gx += 100) {
      grat += `M${gx} ${vb.y + i1}v7M${gx} ${vb.y + vb.h - i1}v-7`;
    }
    for (let gy = 0; gy <= MAP.h; gy += 100) {
      grat += `M${vb.x + i1} ${gy}h7M${vb.x + vb.w - i1} ${gy}h-7`;
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
    const m = 24 + half;
    return m * 2 > vb.w ? vb.x + vb.w / 2 : Math.max(vb.x + m, Math.min(vb.x + vb.w - m, x));
  };

  /* ============================================================
     element
     ============================================================ */
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  svg.setAttribute('class', 'w-map-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Chart of Bull Bear City');
  const el = h('div.w-map' + (compact ? '.compact' : ''), {
    style: opts.height ? { height: opts.height } : null,
  }, svg);

  function render() {
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
    dispose() { offDiscover?.(); },
  };
}

export default cityMap;
