/* ============================================================
   map.js — THE MAP OF BULL BEAR CITY, drawn.

   The Places screen used to be a list of buttons grouped by
   district, which is a table of contents, not a map: it could not
   answer "where is that", "how far", "what is near it" or "which
   way do I walk", and those are the only four questions a player
   opens a map to ask.

   data.js gives every location 2D board coordinates (loc.x / loc.y
   on the original 1000x660 layout) and every zone a tint and a
   blurb, so the map is derivable — nothing here is hand-placed and
   nothing here is an image asset. One SVG, generated from the data,
   in the register of a Wind Waker sea chart: parchment island,
   flat blue sea, tinted districts, ink linework.

   THE DISTRICT SHAPES are the support function of each zone's own
   member locations. For 40 angles around the district centroid we
   take the furthest member in that direction, add a margin, and add
   a small deterministic wobble — so a district with four places
   sprawls, a district with two is a lozenge, and the shape is a
   consequence of the content rather than a blob someone drew.

     r(θ) = max_i (p_i − c)·u(θ) + margin,  wobbled ±6 %

   PUBLIC
     cityMap(ctx, opts) -> { el, select(id), selected }
       opts.compact   no per-location labels (the phone)
       opts.selected  location id to highlight
       opts.onPick    (locId) => void
       opts.height    css height
   ============================================================ */

import { BRAND, SEA, LAND, SHADOW } from '../core/palette.js';
import { h, rgba, mix, C } from './style.js';

const NS = 'http://www.w3.org/2000/svg';

/* The board is 1000x660; the island ellipse is wider than the board,
   so the view is padded out until the shoreline closes and the sea
   shows in the corners. Anything outside is water. */
const PAD_X = 96, PAD_Y = 84;

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
  const l = 0.50, s = Math.min(0.72, ((mx + mn) ? d / (1 - Math.abs(mx + mn - 1)) : 0) * 2.6 + 0.22);
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

export function cityMap(ctx, opts = {}) {
  const game = ctx.game;
  const D = game.data;
  const MAP = D.map, W = D.world;
  const compact = !!opts.compact;

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

  /* ---------- palette: a sea chart on cream paper ---------- */
  const seaLo = C(mix(SEA.shallow, BRAND.paper, 0.42));
  const seaHi = C(mix(SEA.deep, BRAND.paper, 0.26));
  const sand = C(mix(LAND.sand, BRAND.paper, 0.42));
  const land = C(mix(BRAND.paper, 0xffffff, 0.30));
  const ink = BRAND.ink;

  let selected = opts.selected || null;

  /* ============================================================
     geometry
     ============================================================ */

  /* Support-function outline of one district. Returns an SVG path. */
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
    for (let i = 0; i < N; i++) {
      const t = (i / N) * Math.PI * 2;
      const ux = Math.cos(t), uy = Math.sin(t);
      let r = 0;
      for (const l of members) r = Math.max(r, (l.x - cx) * ux + (l.y - cy) * uy);
      /* keep the anchor inside too, and never collapse to a point */
      r = Math.max(r, (z.x - cx) * ux + (z.y - cy) * uy, 26) + margin;
      r *= 1 + 0.058 * Math.sin(3 * t + ph) + 0.034 * Math.sin(5 * t - ph * 1.7);
      pts.push([cx + ux * r, cy + uy * r]);
    }
    let d = 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
    let top = Infinity;
    for (let i = 1; i < N; i++) d += 'L' + pts[i][0].toFixed(1) + ' ' + pts[i][1].toFixed(1);
    for (const p of pts) top = Math.min(top, p[1]);
    return { d: d + 'Z', cx, cy, top };
  }

  /* A street network: every district joined to its two nearest
     neighbours, de-duplicated. Deterministic, and it makes the
     island read as one city rather than ten islands. */
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
        out.push([za, D.zones[b]]);
      }
    }
    return out;
  }
  const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

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
     paint
     ============================================================ */
  function paint() {
    const me = wallyAt();
    const sel = selected ? D.locationById[selected] : null;
    const s = [];

    s.push(`<defs>
      <radialGradient id="wm-sea" cx="50%" cy="46%" r="72%">
        <stop offset="0" stop-color="${seaLo}"/>
        <stop offset="1" stop-color="${seaHi}"/>
      </radialGradient>
      <radialGradient id="wm-land" cx="42%" cy="34%" r="78%">
        <stop offset="0" stop-color="${C(mix(BRAND.paper, 0xffffff, 0.5))}"/>
        <stop offset="1" stop-color="${land}"/>
      </radialGradient>
      <filter id="wm-soft" x="-18%" y="-18%" width="136%" height="136%">
        <feGaussianBlur stdDeviation="7"/>
      </filter>
    </defs>`);

    /* --- sea --- */
    s.push(`<rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="url(#wm-sea)"/>`);
    /* swell: a few concentric arcs outside the shore, ink-light */
    for (let i = 1; i <= 3; i++) {
      const k = 1 + i * 0.045;
      s.push(`<ellipse cx="${ISL.cx}" cy="${ISL.cy}" rx="${(ISL.rx * k).toFixed(0)}" ry="${(ISL.ry * k).toFixed(0)}"
        fill="none" stroke="${rgba(SEA.deep, 0.13)}" stroke-width="2.6" stroke-dasharray="14 22"/>`);
    }

    /* --- island: a soft drop, then sand, then parchment --- */
    s.push(`<ellipse cx="${ISL.cx}" cy="${ISL.cy + 10}" rx="${ISL.rx}" ry="${ISL.ry}"
      fill="${rgba(SHADOW.tint, 0.28)}" filter="url(#wm-soft)"/>`);
    s.push(`<ellipse cx="${ISL.cx}" cy="${ISL.cy}" rx="${ISL.rx}" ry="${ISL.ry}"
      fill="${sand}" stroke="${rgba(ink, 0.22)}" stroke-width="3"/>`);
    s.push(`<ellipse cx="${ISL.cx}" cy="${ISL.cy}" rx="${ISL.rx - ISL.beach}" ry="${ISL.ry - ISL.beach}"
      fill="url(#wm-land)" stroke="${rgba(LAND.dirt, 0.30)}" stroke-width="1.6"/>`);

    /* --- streets --- */
    for (const [a, b] of roads()) {
      s.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"
        stroke="${rgba(ink, 0.11)}" stroke-width="9" stroke-linecap="round"/>`);
      s.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"
        stroke="${rgba(BRAND.paper, 0.5)}" stroke-width="3.4" stroke-linecap="round"/>`);
    }

    /* --- districts ---
       Captions are placed, then de-collided: "MARKET SQUARE" and
       "INNOVATION DISTRICT" share a latitude on this board and in
       the first pass they printed straight through each other. */
    const caps = [];
    const placed = [];
    const capFont = compact ? 24 : 21;
    function capY(text, x, y) {
      const half = text.length * capFont * 0.36 + 14;
      let yy = y;
      for (let guard = 0; guard < 8; guard++) {
        const hit = placed.find((p) => Math.abs(p.y - yy) < capFont * 1.15
          && p.x1 < x + half && p.x2 > x - half);
        if (!hit) break;
        yy = hit.y + capFont * 1.25;
      }
      placed.push({ x1: x - half, x2: x + half, y: yy });
      return yy;
    }
    for (const zid of Object.keys(D.zones)) {
      const z = D.zones[zid];
      const sh = zoneShape(zid);
      const anyKnown = D.locations.some((l) => l.z === zid && game.known(l.id));
      const tint = boost(hex(z.tint));
      s.push(`<path d="${sh.d}" fill="${rgba(tint, anyKnown ? 0.30 : 0.12)}"
        stroke="${rgba(tint, anyKnown ? 0.70 : 0.30)}" stroke-width="2.6"
        stroke-dasharray="${anyKnown ? '' : '11 9'}" stroke-linejoin="round"/>`);
      /* the caption sits just inside the district's own top edge, so
         it can never land on that district's own pins; a paper halo
         keeps it legible where two districts overlap */
      const capX = clampX(sh.cx);
      caps.push(`<text x="${capX.toFixed(0)}" y="${capY(z.n, capX, sh.top + 26).toFixed(0)}"
        text-anchor="middle" font-family="inherit" font-size="${capFont}"
        font-weight="800" letter-spacing="${compact ? 1.6 : 2.2}"
        stroke="${rgba(BRAND.paper, 0.88)}" stroke-width="5" paint-order="stroke"
        fill="${rgba(mix(tint, ink, 0.32), anyKnown ? 1 : 0.5)}"
        >${esc(z.n.toUpperCase())}</text>`);
    }
    s.push(caps.join(''));

    /* --- the route line, under the pins --- */
    /* Drawn on real distance, not on state.loc: the marker is his
       LIVE 3D position, so "he is at the apartment" and "he is
       standing on the apartment pin" are different facts, and the
       route should answer the second one. */
    if (sel && Math.hypot(sel.x - me.x, sel.y - me.y) > 24) {
      /* two strokes: a soft dark bed so the dashes hold over both the
         cream land and a saturated district patch, then the yellow */
      s.push(`<line x1="${me.x.toFixed(1)}" y1="${me.y.toFixed(1)}" x2="${sel.x}" y2="${sel.y}"
        stroke="${rgba(ink, 0.22)}" stroke-width="9" stroke-linecap="round"
        stroke-dasharray="17 12"/>`);
      s.push(`<line x1="${me.x.toFixed(1)}" y1="${me.y.toFixed(1)}" x2="${sel.x}" y2="${sel.y}"
        stroke="${C(BRAND.warn)}" stroke-width="5.4" stroke-linecap="round"
        stroke-dasharray="17 12"/>`);
    }

    /* --- locations --- */
    for (const l of D.locations) {
      const known = game.known(l.id);
      const here = game.state.loc === l.id;
      const isSel = selected === l.id;
      const z = D.zones[l.z];
      const tint = boost(hex(z.tint));
      const r = here || isSel ? 31 : 25;

      s.push(`<g data-loc="${l.id}" style="cursor:pointer">`);
      /* a generous invisible target — these are 22 units on a 1200
         unit board, which on a phone is a 7 px pin */
      s.push(`<circle cx="${l.x}" cy="${l.y}" r="46" fill="transparent"/>`);
      if (isSel) {
        s.push(`<circle cx="${l.x}" cy="${l.y}" r="${r + 12}" fill="none"
          stroke="${rgba(BRAND.warn, 0.75)}" stroke-width="4" stroke-dasharray="7 6"/>`);
      }
      if (known) {
        s.push(`<circle cx="${l.x}" cy="${l.y + 3.5}" r="${r}" fill="${rgba(ink, 0.20)}"/>`);
        s.push(`<circle cx="${l.x}" cy="${l.y}" r="${r}"
          fill="${C(mix(BRAND.paper, 0xffffff, 0.7))}"
          stroke="${isSel ? C(BRAND.warn) : C(tint)}" stroke-width="${isSel ? 5.5 : 4}"/>`);
        s.push(`<text x="${l.x}" y="${l.y + r * 0.36}" text-anchor="middle"
          font-size="${(r * 1.04).toFixed(0)}" font-family="inherit">${esc(l.ico)}</text>`);
        if (!game.isOpen(l.id)) {
          /* closed: a red bead at the shoulder, the same language as
             the list's Closed chip */
          s.push(`<circle cx="${l.x + r * 0.76}" cy="${l.y - r * 0.76}" r="8"
            fill="${C(BRAND.bad)}" stroke="${C(mix(BRAND.paper, 0xffffff, 0.7))}" stroke-width="2.6"/>`);
        }
      } else {
        /* a place he has heard of nothing about: smaller and quieter
           than a real pin, but present, because 24 of the 28 are
           unknown on day one and a map with four dots on it is not a
           map of a city */
        s.push(`<circle cx="${l.x}" cy="${l.y}" r="${(r * 0.62).toFixed(1)}" fill="${rgba(ink, 0.06)}"
          stroke="${rgba(ink, 0.28)}" stroke-width="2.6" stroke-dasharray="6 5"/>`);
        s.push(`<text x="${l.x}" y="${l.y + 6}" text-anchor="middle" font-size="19"
          font-weight="800" font-family="inherit" fill="${rgba(ink, 0.4)}">?</text>`);
      }
      if (!compact && known) {
        s.push(`<text x="${l.x}" y="${l.y + r + 20}" text-anchor="middle" font-size="17"
          font-weight="800" font-family="inherit"
          stroke="${rgba(BRAND.paper, 0.9)}" stroke-width="4" paint-order="stroke"
          fill="${rgba(ink, 0.82)}">${esc(l.n)}</text>`);
      }
      s.push('</g>');
    }

    /* --- Wally --- */
    s.push(`<g class="wm-me">
      <circle cx="${me.x.toFixed(1)}" cy="${me.y.toFixed(1)}" r="34" fill="${rgba(BRAND.token, 0.22)}"/>
      <circle cx="${me.x.toFixed(1)}" cy="${me.y.toFixed(1)}" r="15"
        fill="${C(BRAND.token)}" stroke="${C(mix(BRAND.paper, 0xffffff, 0.8))}" stroke-width="4.6"/>
      <text x="${me.x.toFixed(1)}" y="${(me.y - 34).toFixed(1)}" text-anchor="middle"
        font-size="19" font-weight="800" letter-spacing="1.6" font-family="inherit"
        stroke="${rgba(BRAND.paper, 0.92)}" stroke-width="4.5" paint-order="stroke"
        fill="${C(BRAND.token2)}">WALLY</text>
    </g>`);

    /* --- compass, in the one corner nothing else wants --- */
    const cxp = vb.x + 60, cyp = vb.y + vb.h - 60;
    s.push(`<g opacity="0.72">
      <circle cx="${cxp}" cy="${cyp}" r="34" fill="${rgba(BRAND.paper, 0.72)}"
        stroke="${rgba(ink, 0.24)}" stroke-width="2.4"/>
      <path d="M${cxp} ${cyp - 24} L${cxp + 9} ${cyp + 6} L${cxp} ${cyp - 1} L${cxp - 9} ${cyp + 6} Z"
        fill="${C(BRAND.bad)}"/>
      <text x="${cxp}" y="${cyp + 24}" text-anchor="middle" font-size="16" font-weight="800"
        font-family="inherit" fill="${rgba(ink, 0.7)}">N</text>
    </g>`);

    return s.join('');
  }

  const hex = (t) => (typeof t === 'string' ? parseInt(t.replace('#', ''), 16) : t);
  const esc = (t) => String(t).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  /* keep a long caption ("INNOVATION DISTRICT") inside the frame */
  const clampX = (x) => Math.max(vb.x + 118, Math.min(vb.x + vb.w - 118, x));

  /* ============================================================
     element
     ============================================================ */
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  svg.setAttribute('class', 'w-map-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Map of Bull Bear City');
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

  return {
    el, svg,
    get selected() { return selected; },
    select(id) { selected = id; render(); },
    refresh: render,
  };
}

export default cityMap;
