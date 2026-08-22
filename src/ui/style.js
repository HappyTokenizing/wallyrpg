/* ============================================================
   style.js — the UI design system.

   Owns: the CSS (injected once), the DOM helper, the procedural
   icon set, the procedural client portraits and the Wally mark.
   No colour is written here that does not come from palette.js.

   The language, evolved from the 2D original (dark chrome + warm
   paper + token orange) for a 3D game: everything is lighter,
   pushed to the edges, translucent over the world, and nothing
   sits in the middle of the frame.
   ============================================================ */

import { BRAND, SHADOW, CATEGORY, SEA, LAND, CLAY, SKY, css } from '../core/palette.js';
import { mulberry32, clamp } from '../core/contracts.js';

/* ------------------------------------------------------------
   tiny colour maths — all inputs come from the palette
   ------------------------------------------------------------ */
export const rgba = (hex, a) => {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  return `rgba(${r},${g},${b},${a})`;
};
export const mix = (a, b, t) => {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return ((Math.round(ar + (br - ar) * t) << 16) |
          (Math.round(ag + (bg - ag) * t) << 8) |
           Math.round(ab + (bb - ab) * t)) >>> 0;
};
export const C = (hex) => css(hex);

/* Meter / battery ramp. One function so the HUD meters and the phone
   battery can never disagree about what "low" looks like. */
export function meterColour(pct) {
  const p = clamp(pct, 0, 100);
  return C(p < 20 ? BRAND.bad : p < 45 ? BRAND.warn : BRAND.good);
}

/* ------------------------------------------------------------
   FILM GRAIN — ART_DIRECTION §3.8 / §6 ("every surface has grain;
   nothing is flat-shaded and clean").

   The post stack grains the WebGL canvas, but the DOM sits above it,
   so without this the interface is the one perfectly clean object in
   a heavily grained, graded frame. We generate a 128x128 tileable
   monochrome noise tile once, deterministically (mulberry32 — never
   Math.random), and hand it to CSS as a data: URL. Every chrome and
   paper surface carries it as an `overlay` blend layer, and a
   full-screen copy sits over the whole frame at a lower amplitude so
   the UI ends up *inside* the grade rather than pasted on top.

   Mid grey (128) is the identity value for `overlay`, so the tile is
   signed noise about 128. At base 0.9 (cream paper) an `overlay`
   deviation e lands 0.2*e on screen, so spread 46/255 ≈ 0.036.
   ------------------------------------------------------------ */
let _grain = null;
export function grainTile(N = 128, spread = 46) {
  if (_grain) return _grain;
  if (typeof document === 'undefined') return '';
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const g = cv.getContext('2d');
  if (!g) return '';
  const rnd = mulberry32(0x9e3779b1);
  const a = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) a[i] = rnd() * 2 - 1;

  /* one wrap-around cross blur: takes the hardest single-pixel salt
     off so it reads as emulsion grain and not as dither, and keeps
     the tile seamless because every tap wraps. */
  const b = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    const yu = ((y + N - 1) % N) * N, yd = ((y + 1) % N) * N, yc = y * N;
    for (let x = 0; x < N; x++) {
      b[yc + x] = a[yc + x] * 0.52
        + (a[yc + ((x + N - 1) % N)] + a[yc + ((x + 1) % N)] + a[yu + x] + a[yd + x]) * 0.12;
    }
  }
  const img = g.createImageData(N, N);
  const px = img.data;
  for (let i = 0; i < N * N; i++) {
    const v = clamp(Math.round(128 + b[i] * spread * 1.10), 0, 255);
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v;
    px[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  try { _grain = cv.toDataURL('image/png'); } catch (e) { _grain = ''; }
  return _grain;
}

/* ------------------------------------------------------------
   DOM helper.  h('div.card', {onclick}, 'text', child, …)
   ------------------------------------------------------------ */
export function h(spec, props, ...kids) {
  const m = /^([a-z0-9]+)?((?:[.#][^.#]+)*)$/i.exec(spec) || [];
  const tag = m[1] || 'div';
  const node = tag === 'svg' || tag === 'path' || tag === 'circle'
    ? document.createElementNS('http://www.w3.org/2000/svg', tag)
    : document.createElement(tag);
  for (const tok of (m[2] || '').match(/[.#][^.#]+/g) || []) {
    if (tok[0] === '.') node.classList.add(tok.slice(1));
    else node.id = tok.slice(1);
  }
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'class') node.className += (node.className ? ' ' : '') + v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? '' : v);
    }
  }
  add(node, kids);
  return node;
}
function add(node, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) add(node, k);
    else node.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
}
export const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };

/* ------------------------------------------------------------
   formatting
   ------------------------------------------------------------ */
export function money(n) {
  const v = Math.round(n);
  if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 2).replace(/\.0+$/, '') + 'M';
  if (Math.abs(v) >= 1e4) return '$' + (v / 1e3).toFixed(v % 1e3 === 0 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return '$' + v.toLocaleString('en-US');
}
export const money2 = (n) => '$' + (Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) < 100 ? 2 : 0 });
export const pad2 = (n) => String(n).padStart(2, '0');

/* ------------------------------------------------------------
   THE TICKER — the primary handle for every asset in the game.

   data.js gives all 69 assets a 3–5 character symbol and says why in
   as many words: "an order reads like a trade ticket: 3x WHEAT".
   The interface has to agree, which means the symbol is what the eye
   lands on first — set in the mono face, tabular, tracked and
   boxed — and the English name is the caption beside it rather than
   the other way round.

     tickerTag(asset)             ->  [GOLD]
     tickerTag(asset, {qty: 3})   ->  [3× GOLD]

   Accepts an asset record or a bare symbol string.
   ------------------------------------------------------------ */
export function tickerTag(asset, opts = {}) {
  const tick = typeof asset === 'string'
    ? asset.toUpperCase()
    : (asset && asset.tick) || '?';
  const el = h('span.w-tick'
    + (opts.lg ? '.lg' : '') + (opts.sm ? '.sm' : '') + (opts.hot ? '.hot' : ''));
  if (opts.qty != null && opts.qty !== 1) el.append(h('span.q', { text: opts.qty + '×' }));
  el.append(document.createTextNode(tick));
  if (opts.title) el.setAttribute('title', opts.title);
  return el;
}

/* A whole order as one ticket: [2× WHEAT] · [GOLD].
   `items` is data.js's [{a, q}]; `lookup` resolves an id to an asset. */
export function ticketLine(items, lookup, opts = {}) {
  const list = Array.isArray(items) ? items : [items];
  const wrap = h('span.w-ticket');
  list.forEach((it, i) => {
    if (i) wrap.append(h('span.sep', { text: '·' }));
    wrap.append(tickerTag(lookup(it.a) || it.a, { qty: it.q, sm: opts.sm }));
  });
  return wrap;
}

/* ============================================================
   ICONS — every one drawn here, stroked, 24x24 viewbox.
   No emoji in chrome, no external assets.
   ============================================================ */
const P = {
  day:      'M5 7h14a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9a2 2 0 012-2z M8 4v5 M16 4v5 M3 12h18',
  clock:    'M12 3a9 9 0 110 18 9 9 0 010-18z M12 7.4V12l3.2 2.1',
  bolt:     'M13.4 3L6 13.4h4.9L10 21l7.5-10.6h-5L13.4 3z',
  bowl:     'M3.5 11h17a8.5 8.5 0 01-8.5 8 8.5 8.5 0 01-8.5-8z M9 7.6c0-1.2 1.2-1.4 1.2-2.6 M13 7.2c0-1.4 1.4-1.6 1.4-3',
  cash:     'M3 6.5h18v11H3z M12 9.4a2.6 2.6 0 110 5.2 2.6 2.6 0 010-5.2z M6 9.6v-.1 M18 14.4v.1',
  star:     'M12 3.3l2.7 5.6 6 .9-4.35 4.3 1.03 6.1L12 17.3l-5.38 2.9 1.03-6.1L3.3 9.8l6-.9L12 3.3z',
  city:     'M4 20V9.5l6-3.6v4.1l6-3.4V20 M4 20h16 M19 20V11l2 .9V20 M7.4 13.2v2 M12.6 13v2 M12.6 16.6v2',
  chat:     'M4 5.5h16v10H9.6L5.4 19v-3.5H4z',
  map:      'M9 4.5L3.6 6.6v13L9 17.4l6 2.1 5.4-2.1v-13L15 6.6 9 4.5z M9 4.5v12.9 M15 6.6v12.9',
  people:   'M9 11.2a3.2 3.2 0 110-6.4 3.2 3.2 0 010 6.4z M2.9 19.4c.4-3.3 3-5.2 6.1-5.2s5.7 1.9 6.1 5.2 M16.4 5.4a3 3 0 010 6 M17.6 14.6c2.2.5 3.6 2.3 3.9 4.8',
  wallet:   'M3.6 7.4h15.2a2 2 0 012 2v7.4a2 2 0 01-2 2H3.6z M3.6 7.4V6a1.6 1.6 0 011.6-1.6h10.2 M16.6 13.4h4.2 M17.4 13.4v0',
  cal:      'M4.5 6.5h15v13h-15z M4.5 10.6h15 M8.5 4v4 M15.5 4v4 M8 14h2 M14 14h2 M8 17h2',
  news:     'M4 5.5h12v14H5.6A1.6 1.6 0 014 17.9z M16 9h4v8.6a1.9 1.9 0 01-3.9.3 M6.6 8.6h6.8 M6.6 12h6.8 M6.6 15.2h4.4',
  net:      'M12 3a9 9 0 110 18 9 9 0 010-18z M3.2 12h17.6 M12 3.1c4.6 5 4.6 12.8 0 17.8 M12 3.1c-4.6 5-4.6 12.8 0 17.8',
  chart:    'M4 19.4h16 M6.6 19.4V13 M11 19.4V7.6 M15.4 19.4v-8 M19.6 19.4v-4',
  gear:     'M12 8.9a3.1 3.1 0 110 6.2 3.1 3.1 0 010-6.2z M12 2.9l1.3 2.3 2.6-.5 .5 2.6 2.3 1.3-1.3 2.3 1.3 2.3-2.3 1.3-.5 2.6-2.6-.5L12 21.1l-1.3-2.3-2.6.5-.5-2.6-2.3-1.3L6.6 12 5.3 9.7l2.3-1.3.5-2.6 2.6.5L12 2.9z',
  phone:    'M8 2.8h8a2 2 0 012 2v14.4a2 2 0 01-2 2H8a2 2 0 01-2-2V4.8a2 2 0 012-2z M10.4 18.4h3.2',
  back:     'M14.6 5.4L8 12l6.6 6.6',
  close:    'M6.2 6.2l11.6 11.6 M17.8 6.2L6.2 17.8',
  check:    'M4.8 12.6l4.6 4.6L19.2 7',
  pin:      'M12 2.9c3.6 0 6.4 2.8 6.4 6.3 0 4.6-6.4 11.9-6.4 11.9S5.6 13.8 5.6 9.2C5.6 5.7 8.4 2.9 12 2.9z M12 6.9a2.4 2.4 0 110 4.8 2.4 2.4 0 010-4.8z',
  door:     'M6.6 3.6h10.8a1.4 1.4 0 011.4 1.4v15.6H5.2V5a1.4 1.4 0 011.4-1.4z M15 12.6a.9.9 0 110-1.8 .9.9 0 010 1.8z M3.2 20.6h17.6',
  bed:      'M3.2 19V8.6 M3.2 13h17.6v6 M3.2 19h17.6 M6.9 9.4a2.1 2.1 0 110 4.2 2.1 2.1 0 010-4.2z M10.8 13V9.8h7.4a2.6 2.6 0 012.6 2.6V13',
  bag:      'M5.4 8h13.2l1 11.6H4.4L5.4 8z M8.8 8V6.4a3.2 3.2 0 016.4 0V8',
  book:     'M4.4 4.6h6.2A2.6 2.6 0 0112 6.9v12.5 M19.6 4.6h-6.2A2.6 2.6 0 0012 6.9 M4.4 4.6v13h6.4 M19.6 4.6v13h-6.4',
  tools:    'M14.6 3.6a4.4 4.4 0 015.8 5.8l-2.3-2.3-2 .5-.5 2 M14.6 3.6L9.4 8.8 M11.6 11l-6 6a2.2 2.2 0 003.1 3.1l6-6 M9.4 8.8l5.4 5.4',
  key:      'M15.4 3.6a5 5 0 11-3.7 8.4L4.4 19.4v2.2H8v-2.2h2.2v-2.2h2.2l1.3-1.3a5 5 0 011.7-9.7z M16.8 7.6v0',
  trophy:   'M7.4 4.4h9.2v5.2a4.6 4.6 0 01-9.2 0z M7.4 6H4.6v1.6a3 3 0 003 3 M16.6 6h2.8v1.6a3 3 0 01-3 3 M12 14.2v3.4 M8.6 20.4h6.8',
  spark:    'M12 3.4l1.7 5 5 1.7-5 1.7-1.7 5-1.7-5-5-1.7 5-1.7L12 3.4z',
  train:    'M7 4.4h10a2.4 2.4 0 012.4 2.4v8.4a2.4 2.4 0 01-2.4 2.4H7a2.4 2.4 0 01-2.4-2.4V6.8A2.4 2.4 0 017 4.4z M4.6 10.4h14.8 M8.4 14.2v0 M15.6 14.2v0 M7.6 17.6L5.4 20.6 M16.4 17.6l2.2 3',
  bike:     'M6 18.6a3.4 3.4 0 110-6.8 3.4 3.4 0 010 6.8z M18 18.6a3.4 3.4 0 110-6.8 3.4 3.4 0 010 6.8z M6 15.2l4.2-6.4h4.4L18 15.2 M9.6 8.8h4.8 M10.2 8.8L12.4 15',
  car:      'M4.4 15.6l1.4-5A2.6 2.6 0 018.3 8.7h7.4a2.6 2.6 0 012.5 1.9l1.4 5 M3.6 15.6h16.8v3.2H3.6z M7 18.8v1.4 M17 18.8v1.4',
  foot:     'M10.6 3.4c2 0 3 2.2 2.6 5.2-.3 2.4-1.2 3.6-1.2 5.2 0 2.4-1 3.6-2.6 3.6s-2.6-1.4-2.6-3.4c0-2 .8-3.2.8-5.4 0-3 1.2-5.2 3-5.2z M15.6 15.6c1.2 0 2 1 2 2.2 0 1.4-1 2.4-2.4 2.4s-2.2-.8-2.2-2c0-1.4 1.2-2.6 2.6-2.6z',
  save:     'M5 4.6h10.4L19.4 8.6V19.4H5z M8.2 4.6v5h6.4v-5 M8.2 19.4v-5.6h7.6v5.6',
  info:     'M12 3.2a8.8 8.8 0 110 17.6 8.8 8.8 0 010-17.6z M12 10.6v6 M12 7.4v.1',
  play:     'M8.4 5.6l10 6.4-10 6.4z',
  search:   'M10.8 3.6a7.2 7.2 0 110 14.4 7.2 7.2 0 010-14.4z M16.1 16.1l4.3 4.3',
  /* the destination pointer's arrowhead — a solid chevron-kite, not
     a triangle: it has a direction even at 14 px */
  nav:      'M12 3.2l6.6 16.4-6.6-4-6.6 4L12 3.2z',
  minus:    'M5.4 12h13.2',
  plus:     'M12 5.4v13.2 M5.4 12h13.2',
  ticket:   'M4 7.4h16v3a1.7 1.7 0 000 3.2v3H4v-3a1.7 1.7 0 000-3.2z M9.4 7.4v9.2',
  /* "opens in a new tab" — the box with the arrow leaving it. Drawn
     here like every other glyph: no emoji, no font dependency. */
  ext:      'M13.6 4.4h6v6 M19.6 4.4L11.2 12.8 M17 14.2v4.4a1.8 1.8 0 01-1.8 1.8H5.4a1.8 1.8 0 01-1.8-1.8V8.8A1.8 1.8 0 015.4 7h4.4',
};

export function icon(name, size = 16, opts = {}) {
  const d = P[name] || P.info;
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('class', 'w-i' + (opts.class ? ' ' + opts.class : ''));
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill', opts.fill || 'none');
  p.setAttribute('stroke', opts.stroke || 'currentColor');
  p.setAttribute('stroke-width', opts.w || 1.7);
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  s.append(p);
  return s;
}
export const iconNames = Object.keys(P);

/* ============================================================
   THE WALLY MARK — head-ball, dominant ears, black wayfarers and
   THE GLINT (a flattened lazy-Z, ART_DIRECTION §1.4). Readable at
   28 px. Used for the phone icon, the boot chip and his portrait.
   ============================================================ */
export function wallyMark(size = 48) {
  const clay = C(CLAY.body), lit = C(CLAY.bodyLit), ao = C(CLAY.bodyAO);
  const inner = C(CLAY.earInner), frame = C(CLAY.frame), lens = C(CLAY.lens);
  const svg = `
  <svg viewBox="0 0 64 64" width="${size}" height="${size}" class="w-mark" aria-hidden="true">
    <defs>
      <radialGradient id="wmH" cx="38%" cy="28%" r="76%">
        <stop offset="0" stop-color="${lit}"/><stop offset="1" stop-color="${clay}"/>
      </radialGradient>
    </defs>
    <ellipse cx="11.5" cy="30" rx="9.6" ry="12.6" fill="${clay}" transform="rotate(-11 11.5 30)"/>
    <ellipse cx="52.5" cy="30" rx="9.6" ry="12.6" fill="${clay}" transform="rotate(11 52.5 30)"/>
    <ellipse cx="12.4" cy="30.6" rx="6.2" ry="8.6" fill="${inner}" transform="rotate(-11 12.4 30.6)"/>
    <ellipse cx="51.6" cy="30.6" rx="6.2" ry="8.6" fill="${inner}" transform="rotate(11 51.6 30.6)"/>
    <ellipse cx="32" cy="28.5" rx="17.4" ry="17" fill="url(#wmH)"/>
    <path d="M32 40c4.6 0 6.5 3 6.5 8.2 0 4.2-1.7 7.4-3.1 9.6-1 1.6-3.6 1.4-4.4-.2-1.2-2.4-2.6-5.2-2.6-9.4 0-5.2 1-8.2 3.6-8.2z" fill="${clay}"/>
    <path d="M29.6 46.4h5.2M29.9 50.2h4.6" stroke="${ao}" stroke-width="1.1" stroke-linecap="round" opacity=".55"/>
    <path d="M24.6 41.4c-1.9 1.1-3.6.6-4.6-.9M39.4 41.4c1.9 1.1 3.6.6 4.6-.9" stroke="${C(CLAY.tusk)}" stroke-width="3.1" stroke-linecap="round"/>
    <path d="M13.6 25.6h36.8a2 2 0 012 2.1l-.5 3.2h-15l-1.1-2.5h-7.6l-1.1 2.5h-15l-.5-3.2a2 2 0 012-2.1z" fill="${frame}"/>
    <path d="M15.9 31.2h14.4l-1.1 5.1a3.4 3.4 0 01-3.3 2.6h-6a3.4 3.4 0 01-3.3-2.6z" fill="${lens}"/>
    <path d="M33.7 31.2h14.4l-1.1 5.1a3.4 3.4 0 01-3.3 2.6h-6a3.4 3.4 0 01-3.3-2.6z" fill="${lens}"/>
    <path d="M18.4 33.1h3.6l-1.5 1.9h3.1" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M36.2 33.1h3.6l-1.5 1.9h3.1" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`;
  const t = document.createElement('div');
  t.innerHTML = svg.trim();
  return t.firstChild;
}

/* ============================================================
   PORTRAITS — every client drawn from their own data record
   (skin / face / hair / hairCol / beard / specs / hat / mood).
   Flat two-tone vector, deterministic, ~1 kB each.
   ============================================================ */
const SKIN = {
  fair: 0xf0d0b4, tan: 0xd7a578, porcelain: 0xf7e0d0, olive: 0xc9a173,
  warm: 0xe3b489, deep: 0x8a5a3c, bronze: 0xb87a4e, ebony: 0x6b432c,
};
const HAIRC = {
  silver: 0xc9cdd4, black: 0x241f22, plum: 0x6b3355, darkbrown: 0x3f2a1d,
  grey: 0x8d8b88, auburn: 0x8a3d22, white: 0xe8e4dc, chestnut: 0x5d3a20,
  blonde: 0xd6ad63, teal: 0x2f8280, ginger: 0xc8622a,
};
const FACE_W = { round: 20, broad: 21.5, heart: 19.4, oval: 18.6, long: 17.8, square: 20.6 };
const FACE_H = { round: 20.4, broad: 19.6, heart: 21, oval: 21.6, long: 23.4, square: 20.4 };
const FACE_R = { round: 18, broad: 12, heart: 14, oval: 20, long: 16, square: 7 };

function hairPath(kind, w, hh) {
  const L = 32 - w, R = 32 + w, T = 34 - hh;
  switch (kind) {
    case 'bald':      return '';
    case 'buzz':      return `M${L} ${T + 5}c1-7 5.6-10 ${w} -10s${w - 1} 3 ${w} 10c-3-4-7-5.4-${w} -5.4S${L + 3} ${T + 1} ${L} ${T + 5}z`;
    case 'receding':  return `M${L + 2} ${T + 5}c2-6 6-8.6 ${w - 2} -8.6 4 0 7 1.6 8 4-3.4-1.2-7-1.4-10 .2-2.4 1.2-4 2.6-5 4.4z`;
    case 'short':     return `M${L - .6} ${T + 7}c0-8 5-11.6 ${w + .6} -11.6S${R - 31.4} ${T - 1} ${R - 31.4 + 0.1} ${T + 7}c-2.6-5-7-6.8-${w} -6.8-5 0-9 2-11 6.8z`;
    case 'quiff':     return `M${L} ${T + 7}c0-8 5-11.4 ${w} -11.4 5.4 0 8.6 2.4 9.6 6.2 1.4-3.6 5-5.6 7-4.6-3 1.2-4 3.6-4.4 6.6-2.4-4-7-5.6-11.4-5-3.6.5-6.6 3.4-8.2 8.2z`;
    case 'side':      return `M${L} ${T + 7}c0-8 5-11.4 ${w} -11.4 5.6 0 9 2.6 10 7-4.4-3.4-9.6-4.2-14.6-2.2-2.6 1-4.4 3.2-5.4 6.6z`;
    case 'bob':       return `M${L - 2.4} ${T + 15}c-1.4-12 2.6-19.6 ${w + 2.4} -19.6s${w + 1} 6.6 ${w + 2.4} 19.6c-1.6-1-2.6-3.6-2.8-7.4-3.6 2.6-8.6 3.6-13.4 3.4-4.2-.2-7.6-1.6-9.6-3.6-.2 4-1.2 6.6-2.8 7.6z`;
    case 'long':      return `M${L - 3} ${T + 22}c-2.4-16 2-26.4 ${w + 3} -26.4s${w + 2} 10 ${w + 3} 26.4c-2.2-2.2-3.4-7.4-3.6-13.6-3.8 3-9 4-14 3.8-4.4-.2-8-1.6-10-3.8-.2 6.2-1.4 11.4-3.4 13.6z`;
    case 'wavy':      return `M${L - 1.4} ${T + 13}c-1-11 3-17.6 ${w + 1.4} -17.6s${w} 6 ${w + 1.4} 17.6c-2-1.6-2.4-4.6-2.6-7.6-2.6 3-6.6 2.2-9-.6-2 3-6.4 3.8-9.4 1.2-.2 3.4-.8 5.8-2.4 7z`;
    case 'curly':     return `M${L - 2} ${T + 8}c-1.6-4.6.6-8 4-8.4-.4-3.6 2.6-6.2 6.4-6 1.6-2.6 6.4-2.8 8.6-.4 3.6-1 7 1.4 7 4.8 3.2 1 4.4 4.6 2.8 8-2.6-6-8.6-9-14.4-9s-11.6 3.4-14.4 11z`;
    case 'afro':      return `M32 ${T - 5.6}c9.6 0 15.4 6.4 15.4 13.6 0 3.6-1.4 6.4-3.4 8.2 .6-8.2-4.6-13.6-12-13.6s-12.6 5.4-12 13.6c-2-1.8-3.4-4.6-3.4-8.2 0-7.2 5.8-13.6 15.4-13.6z`;
    case 'locs':      return `M${L - 1.6} ${T + 18}c-1.4-14 2.6-22 ${w + 1.6} -22s${w + .6} 8 ${w + 1.6} 22c-1.6-1-2-4.6-2.2-8.6-1.2 4-1.6 6.4-2.2 8.6-.8-3-1-6-1.2-9.4-1.4 3.6-1.8 6.6-2.4 9.4-.8-2.8-1-6-1.2-9.6-1.2 3.8-1.8 6.8-2.4 9.6-.6-2.4-1-5.6-1.2-9.2-1.4 3.4-2 6.2-2.6 9.2-.8-2.6-1-6-1.2-9.4-1.2 3.8-1.8 6.6-2.4 9.4z`;
    case 'braids':    return `M${L - 1.6} ${T + 20}c-1.6-14 2.6-21.6 ${w + 1.6} -21.6s${w + .6} 7.6 ${w + 1.6} 21.6c-2-1.6-2.6-6-2.8-11-3.6 2.4-8.4 3.2-13 3-4-.2-7.4-1.4-9.2-3.2-.2 5-1 9.2-2.6 11.2z`;
    case 'bun':       return `M32 ${T - 8}a4.6 4.6 0 110 9.2 4.6 4.6 0 010-9.2z M${L - .6} ${T + 8}c0-8.6 5-12.6 ${w + .6} -12.6s${w} 4 ${w + .6} 12.6c-2.8-5.6-7.2-7.6-${w} -7.6-5.2 0-9.4 2.4-11.6 7.6z`;
    case 'pony':      return `M${L - .6} ${T + 8}c0-9 5-12.6 ${w + .6} -12.6s${w} 3.6 ${w + .6} 12.6c-2.6-5.6-7-7.8-${w} -7.8s-9.6 2.4-12 7.8z M${R + 1} ${T + 5}c4 1.6 5.6 6 4.8 11.6-.4 3-2 5-3.6 5.4 1.4-4.6 1-9.6-1.2-13.6z`;
    case 'mohawk':    return `M${L + 3} ${T + 8}c1.4-3.4 3.4-5.6 5.6-6.8-.4-3.6 1.2-6.6 3.4-8 2.2 1.4 3.8 4.4 3.4 8 2.2 1.2 4.2 3.4 5.6 6.8-2.4-2.4-5.4-3.6-9-3.6s-6.6 1.2-9 3.6z`;
    case 'headscarf': return `M${L - 1.4} ${T + 12}c-1-10.4 3.6-16.6 ${w + 1.4} -16.6s${w + .4} 6.2 ${w + 1.4} 16.6c-4.4-3-9.4-4.4-14.4-4.4s-9.6 1.4-13.4 4.4z`;
    default:          return `M${L} ${T + 7}c0-8 5-11.4 ${w} -11.4s${w} 3.4 ${w} 11.4c-2.6-5.2-7-7.2-${w} -7.2s-9.4 2-12 7.2z`;
  }
}
function hatPath(kind) {
  switch (kind) {
    case 'top':    return `<path d="M23 16h18v-13h-18z M17 16h30v3.2H17z" fill="#20222c"/><path d="M23 12.6h18v3H23z" fill="${C(BRAND.token2)}"/>`;
    case 'cap':    return `<path d="M18.4 16.6c0-8.6 5.6-13.4 13.6-13.4s13.6 4.8 13.6 13.4z M45.6 16.6h9.6v3.4c-4 .4-7.4-.6-9.6-3.4z" fill="${C(BRAND.token2)}"/>`;
    case 'chef':   return `<path d="M20 17.4c-4.6 0-7.6-3-7.6-7 0-3.6 3-6.4 6.6-6 1.4-3 5-4.8 8.6-3.6 2.4-2 6.6-2 9 0 3.6-1.2 7.2.6 8.6 3.6 3.6-.4 6.6 2.4 6.6 6 0 4-3 7-7.6 7z" fill="#f4f1ea"/><path d="M20 17.4h24v4H20z" fill="#e6e0d2"/>`;
    case 'beret':  return `<path d="M17.6 16.6c0-8 6.4-12.6 14.4-12.6 8.6 0 14.4 4.8 14.4 9.6 0 2-1.4 3-3.4 3z M31 3.4a2 2 0 110 4 2 2 0 010-4z" fill="#8c3550"/>`;
    case 'flat':   return `<path d="M19 16.4c0-8 5.4-12.6 13-12.6s13 4.6 13 12.6z M45 16.4h9v3c-3.8.6-7-.4-9-3z" fill="#5b5f52"/>`;
    case 'bucket': return `<path d="M18.4 16.4c0-8.4 5.6-13 13.6-13s13.6 4.6 13.6 13z M14 16.4h36v4H14z" fill="#7d8a5a"/>`;
    case 'helm':   return `<path d="M17.6 17.4c0-9 6.2-14 14.4-14s14.4 5 14.4 14z M12.6 17.4h38.8v3.6H12.6z" fill="${C(BRAND.warn)}"/><path d="M30 3.8h4v13h-4z" fill="#e2c98a" opacity=".6"/>`;
    case 'fedora': return `<path d="M21 16.4c0-8.6 4.6-13 11-13s11 4.4 11 13z M13 16.4h38v3.4H13z" fill="#3b3730"/><path d="M21.4 13.2h21.2v3.2H21.4z" fill="#5f5a4e"/>`;
    case 'visor':  return `<path d="M19 15.8h26v3.6H19z M45 15.8h9.6v3.6c-4 .6-7.4-.6-9.6-3.6z" fill="${C(BRAND.info)}"/>`;
    case 'beanie': return `<path d="M18.6 17.4c0-8.6 5.8-13.4 13.4-13.4s13.4 4.8 13.4 13.4z M16.6 17.4h30.8v4.2H16.6z" fill="${C(BRAND.gem)}"/>`;
    default:       return '';
  }
}
function specsPath(kind, sw) {
  const y = 33.6;
  if (kind === 'none' || !kind) return '';
  const st = kind === 'thick' ? 2.4 : 1.4;
  const col = kind === 'thick' ? '#20222c' : kind === 'halfmoon' ? '#8a7a5a' : '#4a4a52';
  if (kind === 'halfmoon') {
    return `<path d="M${32 - sw} ${y}h7.4a3.7 3.7 0 01-7.4 0z M${32 + sw - 7.4} ${y}h7.4a3.7 3.7 0 01-7.4 0z M${32 - sw} ${y}h${sw * 2}"
      fill="none" stroke="${col}" stroke-width="${st}" stroke-linecap="round"/>`;
  }
  const r = kind === 'round' ? 4 : 3.6;
  const box = kind === 'square'
    ? `<rect x="${32 - sw}" y="${y - r}" width="${r * 2 + 1}" height="${r * 2}" rx="1.4"/><rect x="${32 + sw - r * 2 - 1}" y="${y - r}" width="${r * 2 + 1}" height="${r * 2}" rx="1.4"/>`
    : `<circle cx="${32 - sw + r}" cy="${y}" r="${r}"/><circle cx="${32 + sw - r}" cy="${y}" r="${r}"/>`;
  return `<g fill="none" stroke="${col}" stroke-width="${st}">${box}<path d="M${32 - sw + r * 2} ${y}h${(sw - r) * 2 - r * 2}" stroke-linecap="round"/></g>`;
}
function beardPath(kind, w, sc) {
  const L = 32 - w + 2, R = 32 + w - 2;
  switch (kind) {
    case 'full':      return `<path d="M${L} 36c0 8 4 13.4 12 13.4S${R} 44 ${R} 36c1.6 6-1 15.6-12 15.6S${L - 1.6} 42 ${L} 36z" fill="${sc}"/>`;
    case 'stubble':   return `<path d="M${L} 37c0 7.6 4 12.4 12 12.4S${R} 44.6 ${R} 37c1.4 5.6-1 14-12 14S${L - 1.4} 42.6 ${L} 37z" fill="${sc}" opacity=".32"/>`;
    case 'moustache': return `<path d="M26.4 42.4c1.6-1.6 3.6-2 5.6-2s4 .4 5.6 2c-1.4 1.6-3.4 2.2-5.6 2.2s-4.2-.6-5.6-2.2z" fill="${sc}"/>`;
    case 'goatee':    return `<path d="M27.4 43.4h9.2c0 4.6-1.8 7.4-4.6 7.4s-4.6-2.8-4.6-7.4z" fill="${sc}"/>`;
    default:          return '';
  }
}

export function portrait(client, size = 56) {
  const skin = SKIN[client.skin] || SKIN.fair;
  const hair = HAIRC[client.hairCol] || HAIRC.black;
  const w = FACE_W[client.face] || 19.4;
  const hh = FACE_H[client.face] || 21;
  const rr = FACE_R[client.face] || 16;
  const shade = C(mix(skin, SHADOW.tint, 0.3));
  const hairC = C(hair);
  const hue = client.hue || C(BRAND.token);
  const brow = client.mood === 'stern' ? 'M26 30.4l4 1.2M38 30.4l-4 1.2' : client.mood === 'warm' ? 'M26.4 30.6l4-.9M37.6 30.6l-4-.9' : 'M26.4 30.4h4M33.6 30.4h4';
  const mouth = client.mood === 'stern' ? 'M28.4 42.6c2-1 5.2-1 7.2 0' : client.mood === 'warm' ? 'M28 41.2c2 2.4 6 2.4 8 0' : 'M28.8 41.8h6.4';
  const wrinkle = client.age >= 2 ? `<path d="M23.4 27.4c1.6-1 3.4-1.4 5-1.2M40.6 27.4c-1.6-1-3.4-1.4-5-1.2" stroke="${shade}" stroke-width="1" fill="none" opacity=".6" stroke-linecap="round"/>` : '';
  const back = hairPath(client.hair, w, hh);
  const svg = `
  <svg viewBox="0 0 64 64" width="${size}" height="${size}" class="w-portrait" aria-hidden="true">
    <defs><clipPath id="pc${client.id}"><circle cx="32" cy="32" r="31"/></clipPath></defs>
    <g clip-path="url(#pc${client.id})">
      <rect x="0" y="0" width="64" height="64" fill="${hue}" opacity=".92"/>
      <circle cx="32" cy="58" r="26" fill="#000" opacity=".14"/>
      <path d="M18 64c1.2-8.4 6.6-12.6 14-12.6S44.8 55.6 46 64z" fill="${C(mix(0xffffff, hair, 0.72))}"/>
      ${back ? `<path d="${back}" fill="${hairC}"/>` : ''}
      <rect x="${32 - w}" y="${34 - hh}" width="${w * 2}" height="${hh + 18}" rx="${rr}" fill="${C(skin)}"/>
      <path d="M${32 - w - 1.6} 35.4a2.6 2.6 0 000 5.2M${32 + w + 1.6} 35.4a2.6 2.6 0 010 5.2" fill="${C(skin)}"/>
      ${back ? `<path d="${back}" fill="${hairC}" opacity=".97" clip-path="url(#pc${client.id})"/>` : ''}
      ${wrinkle}
      <circle cx="${32 - 5.4}" cy="34.4" r="1.9" fill="#2a2620"/>
      <circle cx="${32 + 5.4}" cy="34.4" r="1.9" fill="#2a2620"/>
      <path d="${brow}" stroke="${hairC}" stroke-width="1.6" stroke-linecap="round" fill="none"/>
      <path d="${mouth}" stroke="#8a4a44" stroke-width="1.6" stroke-linecap="round" fill="none"/>
      ${beardPath(client.beard, w, hairC)}
      ${specsPath(client.specs, w - 3)}
      ${hatPath(client.hat)}
    </g>
    <circle cx="32" cy="32" r="30.4" fill="none" stroke="rgba(255,255,255,.34)" stroke-width="1.4"/>
  </svg>`;
  const t = document.createElement('div');
  t.innerHTML = svg.trim();
  return t.firstChild;
}

/* A neutral avatar for non-client speakers (Mentor, the City, a shop). */
export function glyphAvatar(letter, hue = BRAND.token, size = 56) {
  const t = document.createElement('div');
  t.innerHTML = `<svg viewBox="0 0 64 64" width="${size}" height="${size}" class="w-portrait" aria-hidden="true">
    <circle cx="32" cy="32" r="31" fill="${C(hue)}" opacity=".9"/>
    <circle cx="32" cy="32" r="30.4" fill="none" stroke="rgba(255,255,255,.34)" stroke-width="1.4"/>
    <text x="32" y="43" text-anchor="middle" font-size="30" font-weight="700"
      fill="${C(BRAND.paper)}" font-family="inherit">${letter}</text></svg>`;
  return t.firstChild;
}

/* Deterministic hue for an arbitrary speaker name. */
const HUES = [BRAND.token, BRAND.info, BRAND.good, BRAND.gem, BRAND.warn, CATEGORY.Culture, CATEGORY.Stocks, CATEGORY.Transport];
export function hueFor(name) {
  let n = 0;
  for (let i = 0; i < name.length; i++) n = (n * 31 + name.charCodeAt(i)) >>> 0;
  return HUES[n % HUES.length];
}

/* ============================================================
   THE STYLESHEET
   ============================================================ */
export function stylesheet() {
  const ink = C(BRAND.ink), paper = C(BRAND.paper), token = C(BRAND.token);
  /* One chrome, held in every biome. At 0.72/0.80 the world's hue
     came through hard enough that the same pill read slate over sky
     and olive over grass — a HUD whose colour is whatever is behind
     it does not have a colour. */
  const chromeA = rgba(mix(BRAND.ink, SHADOW.tint, 0.24), 0.86);
  const chromeB = rgba(BRAND.ink, 0.91);
  const line = rgba(BRAND.paper, 0.13);
  const paperBg = `linear-gradient(176deg,${C(mix(BRAND.paper, 0xffffff, 0.35))} 0%,var(--w-paper) 42%,var(--w-paper2) 100%)`;
  const phoneBg = `linear-gradient(165deg,${rgba(mix(BRAND.ink, SHADOW.tint, 0.4), 0.94)},${rgba(BRAND.ink, 0.97)})`;
  const screenBg = `linear-gradient(180deg,${C(mix(BRAND.paper, 0xffffff, 0.3))},${C(BRAND.paper)} 34%,${C(mix(BRAND.paper, BRAND.token2, 0.12))})`;
  /* vignette tint: dark, warm — never neutral grey (ART §3.9) */
  const vig = mix(BRAND.ink, BRAND.token2, 0.16);

  /* Lay the grain tile over an existing background as an `overlay`
     layer. Grain is pinned to 128 CSS px so it stays constant in
     screen space, exactly like the clay's velvet grain (§1.2). */
  const G = (bg) => `background-image:var(--w-grain),${bg};` +
    `background-repeat:repeat,no-repeat;background-size:128px 128px,cover;` +
    `background-blend-mode:overlay,normal;`;

  return `
:root{
  --w-ink:${ink};
  --w-paper:${paper};
  --w-paper2:${C(mix(BRAND.paper, BRAND.token2, 0.10))};
  --w-token:${token};
  --w-token2:${C(BRAND.token2)};
  --w-good:${C(BRAND.good)};
  --w-bad:${C(BRAND.bad)};
  --w-warn:${C(BRAND.warn)};
  --w-info:${C(BRAND.info)};
  --w-gem:${C(BRAND.gem)};
  /* THE DESTINATION YELLOW. The palette has no pure yellow, and the
     pointer must not be the token orange — the objective strip
     already owns that, and a pointer the same colour as the thing it
     points at is one signal wearing two hats. Warn amber lifted
     toward the sun halo, so it reads yellow beside the orange. */
  --w-yellow:${C(mix(BRAND.warn, SKY.sunHalo, 0.30))};
  --w-yellow2:${C(BRAND.warn)};
  --w-text:${C(BRAND.text)};
  --w-dim:${rgba(BRAND.text, 0.60)};
  --w-dim2:${rgba(BRAND.text, 0.40)};
  --w-line:${line};
  --w-chrome:linear-gradient(180deg,${chromeA},${chromeB});
  --w-glass:${rgba(BRAND.ink, 0.55)};
  --w-grain:url("${grainTile()}");
  --w-sea:${C(SEA.shallow)};
  --w-grass:${C(LAND.grassLit)};
  --w-ts:1;
  /* 105%, not 135% — at 135% the world's hue bleeds through the
     chrome and the HUD turns olive over grass (one chrome, every
     biome). */
  --w-blur:blur(18px) saturate(105%);
  --w-shadow:0 2px 6px ${rgba(0x05070c, 0.30)}, 0 12px 34px ${rgba(0x05070c, 0.34)};
  --w-inset:inset 0 1px 0 ${rgba(BRAND.paper, 0.14)};
  --w-font:ui-rounded,'SF Pro Rounded','Nunito','Quicksand',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  --w-mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  --w-ease:cubic-bezier(.22,1,.36,1);
}
.w-root{
  font-family:var(--w-font);
  color:var(--w-text);
  font-size:calc(14px * var(--w-ts));
  line-height:1.35;
  -webkit-font-smoothing:antialiased;
  transition:opacity .45s var(--w-ease);
}
.w-root.w-off{opacity:0 !important;pointer-events:none !important}
.w-root *{box-sizing:border-box}
.w-pe{pointer-events:auto;touch-action:manipulation}
.w-i{flex:none;display:block}
.w-mark,.w-portrait{display:block}

/* ---------- the film layer ----------
   Two fixed siblings over the whole frame (created by ui.js and
   parented to <body>, so they survive the HUD fading out during
   cinematics). Grain first, in overlay blend, at roughly the post
   stack's 0.018; then a soft warm vignette on top. Together they
   pull the DOM inside the colour grade instead of leaving it
   pasted on a graded canvas. */
.w-film,.w-vig{position:fixed;inset:0;pointer-events:none;user-select:none}
.w-film{
  z-index:30;background-image:var(--w-grain);
  background-repeat:repeat;background-size:128px 128px;
  mix-blend-mode:overlay;opacity:.32;
}
.w-vig{
  z-index:31;
  background:radial-gradient(122% 100% at 50% 46%,transparent 48%,${rgba(vig, 0.05)} 78%,${rgba(vig, 0.115)} 100%);
}

/* ---------- surfaces ---------- */
.w-chrome{
  ${G('var(--w-chrome)')}
  -webkit-backdrop-filter:var(--w-blur);backdrop-filter:var(--w-blur);
  border:1px solid var(--w-line);
  box-shadow:var(--w-shadow),var(--w-inset);
}
.w-paper{
  ${G(paperBg)}
  color:var(--w-ink);
  border:1px solid ${rgba(BRAND.ink, 0.12)};
  box-shadow:var(--w-shadow),inset 0 1px 0 ${rgba(0xffffff, 0.72)};
}
.w-paper .w-sub{color:${rgba(BRAND.ink, 0.62)}}

/* ---------- top bar ---------- */
.w-bar{
  position:absolute;top:max(12px,env(safe-area-inset-top));
  display:flex;gap:calc(6px * var(--w-ts));align-items:flex-start;
  max-width:46vw;flex-wrap:wrap;
}
.w-bar.left{left:max(12px,env(safe-area-inset-left));flex-direction:column;align-items:flex-start}
.w-bar.right{right:max(12px,env(safe-area-inset-right));justify-content:flex-end}
/* THE PILL ROW WRAPS AGAINST THE BAR, NOT AGAINST ITS SIBLING.
   .w-bar is a shrink-to-fit absolute box: its intrinsic width is the
   widest child, and the objective strip below is deliberately wider
   than the pills. Without its own cap the pill row inherits that
   width, stops wrapping, and walks straight into the right-hand
   cluster — measured at 390 px, the clock pill vanished under the
   money pill. So the row carries the same cap the bar does. */
.w-pills{display:flex;gap:calc(6px * var(--w-ts));align-items:center;flex-wrap:wrap;max-width:46vw}
.w-bar.right .w-pills{max-width:none}
.w-pill{
  display:flex;align-items:center;gap:calc(7px * var(--w-ts));
  height:calc(32px * var(--w-ts));padding:0 calc(11px * var(--w-ts));
  border-radius:999px;
  ${G('var(--w-chrome)')}
  -webkit-backdrop-filter:var(--w-blur);backdrop-filter:var(--w-blur);
  border:1px solid var(--w-line);
  box-shadow:var(--w-shadow),var(--w-inset);
  font-size:calc(12.5px * var(--w-ts));font-weight:700;letter-spacing:.01em;
  white-space:nowrap;color:var(--w-text);
}
.w-pill .w-i{opacity:.72}
.w-pill .w-k{font-size:calc(9.5px * var(--w-ts));letter-spacing:.16em;text-transform:uppercase;color:var(--w-dim2);font-weight:800}
.w-pill .w-num{font-variant-numeric:tabular-nums}
.w-pill.money .w-num{font-size:calc(13.6px * var(--w-ts));font-weight:800;letter-spacing:0}
.w-pill.money .w-i{opacity:1;color:var(--w-token)}
.w-pill.tap{cursor:pointer;transition:transform .16s var(--w-ease),border-color .16s}
.w-pill.tap:active{transform:scale(.96)}
/* the TICKER pill carries its own keycap — the affordance and the
   shortcut in one object, against the money it spends */
.w-pill .kb{
  display:grid;place-items:center;min-width:calc(15px * var(--w-ts));height:calc(15px * var(--w-ts));
  border-radius:calc(4.5px * var(--w-ts));background:${rgba(BRAND.token, 0.8)};
  color:${C(BRAND.ink)};font-size:calc(8.6px * var(--w-ts));font-weight:800;padding:0 3px;
  margin-left:calc(-2px * var(--w-ts));
}
.w-pill.tap:hover{border-color:${rgba(BRAND.token, 0.6)}}
.w-pill.flash{animation:wFlash .7s var(--w-ease)}
@keyframes wFlash{0%{border-color:var(--w-token);box-shadow:0 0 0 0 ${rgba(BRAND.token, 0.5)}}100%{border-color:var(--w-line);box-shadow:var(--w-shadow),var(--w-inset)}}

/* THE REPUTATION PILL — figure, title, and a progress hairline.
   The title is capped and ellipsised rather than allowed to push the
   city ring off a narrow screen; the full text is in the tooltip. */
.w-pill.rep{position:relative;overflow:hidden;padding-bottom:calc(2px * var(--w-ts))}
.w-pill.rep .ttl{max-width:calc(150px * var(--w-ts));overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;color:var(--w-token);letter-spacing:.11em}
.w-pill.rep .w-num{font-weight:800}
.w-repbar{position:absolute;left:calc(11px * var(--w-ts));right:calc(11px * var(--w-ts));
  bottom:calc(3px * var(--w-ts));height:2px;border-radius:999px;background:${rgba(BRAND.text, 0.18)}}
.w-repbar i{display:block;height:100%;border-radius:999px;background:var(--w-token);
  transition:width .6s cubic-bezier(.22,1,.36,1)}

/* THE LOCK STRIP — the engine's two hard refusals, said out loud and
   with the way out one press away. Sits under the objective, in the
   same column, so it can never collide with anything. */
.w-lock{
  -webkit-appearance:none;appearance:none;font-family:inherit;cursor:pointer;text-align:left;
  display:flex;align-items:center;gap:calc(9px * var(--w-ts));
  max-width:min(430px,52vw);margin-top:calc(6px * var(--w-ts));
  padding:calc(8px * var(--w-ts)) calc(11px * var(--w-ts));border-radius:calc(14px * var(--w-ts));
  ${G('var(--w-chrome)')}
  -webkit-backdrop-filter:var(--w-blur);backdrop-filter:var(--w-blur);
  border:1px solid ${rgba(BRAND.warn, 0.5)};color:var(--w-text);
  box-shadow:var(--w-shadow),var(--w-inset),0 0 20px ${rgba(BRAND.warn, 0.16)};
  animation:wLock .34s var(--w-ease) both;
}
.w-lock.bad{border-color:${rgba(BRAND.bad, 0.6)};box-shadow:var(--w-shadow),var(--w-inset),0 0 22px ${rgba(BRAND.bad, 0.22)}}
.w-lock:active{transform:scale(.985)}
.w-lock .ic{flex:none;color:var(--w-yellow2);display:grid;place-items:center}
.w-lock.bad .ic{color:var(--w-bad)}
.w-lock .t{font-size:calc(11px * var(--w-ts));font-weight:800;letter-spacing:.02em;line-height:1.28}
.w-lock .d{font-size:calc(10.4px * var(--w-ts));font-weight:700;color:var(--w-dim2);margin-top:1px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.w-lock .go{flex:none;font-size:calc(8.6px * var(--w-ts));letter-spacing:.16em;font-weight:800;
  padding:calc(3px * var(--w-ts)) calc(7px * var(--w-ts));border-radius:999px;
  background:${rgba(BRAND.warn, 0.24)};color:var(--w-yellow)}
.w-lock.bad .go{background:${rgba(BRAND.bad, 0.26)};color:${C(mix(BRAND.bad, 0xffffff, 0.5))}}
@keyframes wLock{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}

/* THE MAYOR'S DASH, live. Top-centre, above everything, and only on
   screen while the race is actually running. The two markers on one
   track are the whole readout: the race is a comparison. */
.w-race{
  /* UNDER the pill row, never across it. The top of the frame is
     already two stat clusters wide; a centred box at y=14 sat on top
     of the money and reputation readouts. */
  position:absolute;top:calc(54px * var(--w-ts));left:50%;transform:translateX(-50%);
  width:min(470px,50vw);pointer-events:auto;
  padding:calc(10px * var(--w-ts)) calc(13px * var(--w-ts)) calc(9px * var(--w-ts));
  border-radius:calc(17px * var(--w-ts));
  ${G('var(--w-chrome)')}
  -webkit-backdrop-filter:var(--w-blur);backdrop-filter:var(--w-blur);
  border:1px solid ${rgba(BRAND.warn, 0.46)};color:var(--w-text);
  box-shadow:var(--w-shadow),var(--w-inset),0 0 26px ${rgba(BRAND.warn, 0.18)};
  animation:wLock .3s var(--w-ease) both;
}
.w-race.behind{border-color:${rgba(BRAND.bad, 0.5)}}
.w-race .hd{display:flex;align-items:center;gap:calc(9px * var(--w-ts))}
.w-race .flag{font-size:calc(14px * var(--w-ts));flex:none}
.w-race .clk{font-family:var(--w-mono);font-variant-numeric:tabular-nums;
  font-size:calc(19px * var(--w-ts));font-weight:800;letter-spacing:-.02em;flex:none}
.w-race .nxt{flex:1 1 auto;min-width:0;font-size:calc(10.4px * var(--w-ts));font-weight:800;
  letter-spacing:.08em;text-transform:uppercase;color:var(--w-yellow);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.w-race .hd .w-btn{flex:none;white-space:nowrap}
.w-race .trk{position:relative;height:calc(9px * var(--w-ts));border-radius:999px;
  margin:calc(8px * var(--w-ts)) 0 calc(6px * var(--w-ts));
  background:${rgba(BRAND.text, 0.16)};box-shadow:inset 0 0 0 1px ${rgba(BRAND.text, 0.14)}}
/* TWO SHAPES, NOT TWO COLOURS. The markers cross each other by
   definition, and a red dot behind an orange dot is one dot: the
   Mayor is a tall bar, Wally is the disc that runs over it. */
.w-race .trk i{position:absolute;top:50%;transform:translate(-50%,-50%);transition:left .12s linear}
.w-race .trk .me{width:calc(13px * var(--w-ts));height:calc(13px * var(--w-ts));border-radius:999px;
  background:var(--w-token);box-shadow:0 0 10px ${rgba(BRAND.token, 0.85)},0 0 0 2px ${rgba(0x05070c, 0.55)};z-index:2}
.w-race .trk .him{width:calc(4px * var(--w-ts));height:calc(24px * var(--w-ts));border-radius:2px;
  background:${C(BRAND.bad)};box-shadow:0 0 9px ${rgba(BRAND.bad, 0.8)};z-index:1}
.w-race .dl{font-size:calc(10.6px * var(--w-ts));font-weight:800;font-variant-numeric:tabular-nums;
  letter-spacing:.02em}

/* the money delta chip — the one thing in the pill row allowed to
   shout, because money changing is the game's core feedback */
.w-pill .w-delta{
  font-size:calc(11px * var(--w-ts));font-weight:800;font-variant-numeric:tabular-nums;
  letter-spacing:.01em;color:var(--w-token);background:${rgba(BRAND.token, 0.18)};
  box-shadow:inset 0 0 0 1px ${rgba(BRAND.token, 0.38)};
  border-radius:999px;padding:1px calc(6px * var(--w-ts));margin-left:calc(-2px * var(--w-ts));
  animation:wDelta 2.1s var(--w-ease) both;
}
.w-pill .w-delta.neg{color:var(--w-bad);background:${rgba(BRAND.bad, 0.18)};box-shadow:inset 0 0 0 1px ${rgba(BRAND.bad, 0.38)}}
@keyframes wDelta{
  0%{opacity:0;transform:translateY(7px) scale(.86)}
  14%{opacity:1;transform:none}
  74%{opacity:1;transform:none}
  100%{opacity:0;transform:translateY(-5px) scale(.96)}
}

/* meters — 72x9 with a numeral, a name and a threshold tick. A HUD
   meter has one job: be readable at a glance from across the room. */
.w-meter{position:relative;width:calc(72px * var(--w-ts));height:calc(9px * var(--w-ts));border-radius:999px;
  background:${rgba(0x05070c, 0.58)};overflow:hidden;
  box-shadow:inset 0 0 0 1px ${rgba(BRAND.paper, 0.10)},inset 0 1px 2px ${rgba(0x05070c, 0.6)}}
.w-meter>i{display:block;height:100%;min-width:6%;border-radius:999px;
  box-shadow:inset 0 1px 0 ${rgba(0xffffff, 0.28)};
  transition:width .5s var(--w-ease),background .5s linear}
.w-meter:after{content:'';position:absolute;top:0;bottom:0;left:var(--w-tick,25%);width:1px;
  background:${rgba(BRAND.paper, 0.18)}}
.w-pill .w-mnum{font-variant-numeric:tabular-nums;font-size:calc(12.5px * var(--w-ts));font-weight:800;
  min-width:calc(21px * var(--w-ts));text-align:right}
.w-ring{transform:rotate(-90deg)}
.w-ring circle{fill:none;stroke-linecap:round}

/* ---------- the objective strip — AND THE ONLY POINTER ----------

   What to do, where it is, and which way to turn, in one object.
   There is no second floating compass: a chosen destination
   retargets THIS strip (hud.js paintStrip / setDestination) and
   lights the .chosen accent, and the ✕ hands it back to the quest.

   The dial's arrow is written every frame by hud.js. The bearing is
   taken in Wally's own frame, so "point it up and walk". */
.w-obj{
  margin-top:calc(7px * var(--w-ts));
  display:flex;align-items:center;gap:calc(10px * var(--w-ts));
  padding:calc(7px * var(--w-ts)) calc(13px * var(--w-ts)) calc(7px * var(--w-ts)) calc(7px * var(--w-ts));
  border-radius:calc(15px * var(--w-ts));
  ${G('var(--w-chrome)')}
  -webkit-backdrop-filter:var(--w-blur);backdrop-filter:var(--w-blur);
  border:1px solid var(--w-line);border-left:calc(3px * var(--w-ts)) solid var(--w-token);
  box-shadow:var(--w-shadow),var(--w-inset);
  cursor:pointer;max-width:min(420px,44vw);
  transition:transform .18s var(--w-ease),border-color .2s,box-shadow .25s var(--w-ease);
}
.w-obj:active{transform:scale(.985)}
.w-obj .w-grow{min-width:0}
.w-obj .t{font-weight:800;font-size:calc(13px * var(--w-ts));letter-spacing:.005em;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.w-obj .d{font-size:calc(10.5px * var(--w-ts));color:var(--w-yellow);font-weight:700;
  font-variant-numeric:tabular-nums;margin-top:1px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.w-obj .why{font-size:calc(10px * var(--w-ts));color:var(--w-dim);font-weight:600;margin-top:1px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* THE DIAL. Ex-.w-ptr, unchanged in look — it moved house, it did
   not change identity, and the player should not notice a new object
   where the old arrow used to be. */
.w-obj .dial{
  position:relative;flex:none;
  width:calc(34px * var(--w-ts));height:calc(34px * var(--w-ts));border-radius:50%;
  display:grid;place-items:center;
  background:radial-gradient(circle at 50% 34%,${rgba(BRAND.warn, 0.30)},${rgba(BRAND.warn, 0.10)});
  box-shadow:inset 0 0 0 1.6px ${rgba(BRAND.warn, 0.62)};
  transition:background .3s var(--w-ease),box-shadow .3s var(--w-ease),opacity .3s var(--w-ease);
}
/* the tick marks that make it read as a dial rather than a badge */
.w-obj .dial:before{content:'';position:absolute;inset:calc(3px * var(--w-ts));border-radius:50%;
  border:1px dashed ${rgba(BRAND.warn, 0.30)}}
.w-obj .arw{color:var(--w-yellow);filter:drop-shadow(0 0 6px ${rgba(BRAND.warn, 0.7)});
  transform-origin:50% 50%;will-change:transform}
.w-obj.here .dial{background:${rgba(BRAND.good, 0.22)};box-shadow:inset 0 0 0 1.6px ${rgba(BRAND.good, 0.6)}}
.w-obj.here .arw{color:${C(BRAND.good)};filter:none}
/* nothing to point at — the dial dims rather than inventing a bearing */
.w-obj.nodir .dial{opacity:.34}
.w-obj.nodir .arw{filter:none}
/* a chosen destination: same strip, warmer edge, and a way out */
.w-obj.chosen{border-left-color:var(--w-yellow);
  box-shadow:var(--w-shadow),var(--w-inset),0 0 24px ${rgba(BRAND.warn, 0.18)}}
.w-obj .go{margin-left:auto;flex:none;display:grid;place-items:center;
  width:calc(22px * var(--w-ts));height:calc(22px * var(--w-ts));border-radius:50%;
  border:0;background:${rgba(BRAND.paper, 0.12)};color:var(--w-text);opacity:.72;cursor:pointer;
  transition:opacity .18s,transform .18s var(--w-ease)}
.w-obj .go:hover{opacity:1}
.w-obj .go:active{transform:scale(.9)}
@keyframes wPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.72)}}

/* ---------- toasts ---------- */
.w-toasts{
  position:absolute;left:max(12px,env(safe-area-inset-left));
  bottom:calc(max(12px,env(safe-area-inset-bottom)) + 10px);
  display:flex;flex-direction:column-reverse;gap:calc(6px * var(--w-ts));max-width:min(360px,60vw);
}
.w-toast{
  display:flex;align-items:center;gap:calc(9px * var(--w-ts));
  padding:calc(7px * var(--w-ts)) calc(13px * var(--w-ts));border-radius:999px;
  ${G('var(--w-chrome)')}
  -webkit-backdrop-filter:var(--w-blur);backdrop-filter:var(--w-blur);
  border:1px solid var(--w-line);box-shadow:var(--w-shadow),var(--w-inset);
  font-size:calc(12px * var(--w-ts));font-weight:600;
  animation:wToastIn .42s var(--w-ease) both;
}
.w-toast.out{animation:wToastOut .34s var(--w-ease) both}
.w-toast .bul{width:calc(6px * var(--w-ts));height:calc(6px * var(--w-ts));border-radius:99px;flex:none}
@keyframes wToastIn{from{opacity:0;transform:translateX(-14px) scale(.96)}to{opacity:1;transform:none}}
@keyframes wToastOut{to{opacity:0;transform:translateX(-10px) scale(.97)}}

/* ---------- banner ---------- */
.w-banner{
  position:absolute;left:50%;top:14vh;transform:translateX(-50%);
  text-align:center;padding:calc(14px * var(--w-ts)) calc(30px * var(--w-ts));
  border-radius:calc(17px * var(--w-ts));
  ${G('var(--w-chrome)')}
  -webkit-backdrop-filter:var(--w-blur);backdrop-filter:var(--w-blur);
  border:1px solid ${rgba(BRAND.token, 0.32)};
  box-shadow:0 18px 60px ${rgba(0x05070c, 0.5)},var(--w-inset),0 0 44px ${rgba(BRAND.token, 0.14)};
  animation:wBanner .6s var(--w-ease) both;
}
.w-banner.out{animation:wBannerOut .5s var(--w-ease) both}
.w-banner .t{font-size:calc(20px * var(--w-ts));font-weight:800;letter-spacing:.13em;color:var(--w-token);text-transform:uppercase}
.w-banner .s{font-size:calc(12.5px * var(--w-ts));color:var(--w-dim);margin-top:calc(4px * var(--w-ts));letter-spacing:.04em}
@keyframes wBanner{from{opacity:0;transform:translateX(-50%) translateY(-14px) scale(.94)}to{opacity:1;transform:translateX(-50%)}}
@keyframes wBannerOut{to{opacity:0;transform:translateX(-50%) translateY(-8px) scale(.98)}}

/* ---------- world-space prompt ---------- */
.w-prompt{
  position:absolute;transform:translate(-50%,-100%);
  display:flex;align-items:center;gap:calc(8px * var(--w-ts));
  padding:calc(6px * var(--w-ts)) calc(12px * var(--w-ts)) calc(6px * var(--w-ts)) calc(6px * var(--w-ts));
  border-radius:999px;
  ${G('var(--w-chrome)')}
  -webkit-backdrop-filter:var(--w-blur);backdrop-filter:var(--w-blur);
  border:1px solid var(--w-line);box-shadow:var(--w-shadow),var(--w-inset);
  font-size:calc(12px * var(--w-ts));font-weight:700;white-space:nowrap;
  transition:opacity .26s var(--w-ease);
}
.w-prompt .key,.w-dlg-more .key{
  display:grid;place-items:center;min-width:calc(21px * var(--w-ts));height:calc(21px * var(--w-ts));
  padding:0 calc(5px * var(--w-ts));border-radius:calc(7px * var(--w-ts));
  background:var(--w-token);color:${C(BRAND.ink)};font-size:calc(10.5px * var(--w-ts));font-weight:800;
  box-shadow:0 2px 0 ${rgba(BRAND.token2, 0.9)},0 0 16px ${rgba(BRAND.token, 0.4)};
}
.w-prompt .sub{color:var(--w-dim);font-weight:600}
.w-prompt:after{content:'';position:absolute;left:50%;bottom:calc(-5px * var(--w-ts));margin-left:calc(-5px * var(--w-ts));
  width:calc(10px * var(--w-ts));height:calc(10px * var(--w-ts));background:var(--w-chrome);
  border-right:1px solid var(--w-line);border-bottom:1px solid var(--w-line);
  transform:rotate(45deg);border-bottom-right-radius:3px}

/* ---------- key hints ---------- */
.w-hints{
  position:absolute;right:max(12px,env(safe-area-inset-right));
  bottom:calc(max(12px,env(safe-area-inset-bottom)) + 10px);
  display:flex;gap:calc(6px * var(--w-ts));flex-wrap:wrap;justify-content:flex-end;max-width:52vw;
}
/* Tier three. Hints are reminders, not state — same chrome fill as
   every other surface (one chrome, no second colour), but smaller
   and idling at .55 so money and the objective outrank them. */
.w-hint{
  position:relative;
  display:flex;align-items:center;gap:calc(5px * var(--w-ts));
  height:calc(24px * var(--w-ts));padding:0 calc(9px * var(--w-ts));border-radius:999px;
  ${G('var(--w-chrome)')}
  -webkit-backdrop-filter:var(--w-blur);backdrop-filter:var(--w-blur);
  border:1px solid var(--w-line);box-shadow:var(--w-shadow);
  font-size:calc(10px * var(--w-ts));font-weight:700;color:var(--w-dim2);cursor:pointer;
  letter-spacing:.02em;
  transition:transform .16s var(--w-ease),color .22s var(--w-ease);
}
/* Demoted by size and by text contrast, NOT by element opacity — a
   translucent chrome fill at 60% opacity just lets the grass through
   and the pill turns olive, which is the bug we came to fix. */
.w-hint:hover,.w-hint:focus-visible,.w-hint.lit,.w-hint.badged{color:var(--w-text)}
.w-hint .kb{transition:background .22s var(--w-ease)}
.w-hint:hover .kb,.w-hint.lit .kb,.w-hint.badged .kb{background:${rgba(BRAND.token, 0.85)};color:${C(BRAND.ink)}}
.w-hint:active{transform:scale(.94)}
.w-hint .kb{
  display:grid;place-items:center;min-width:calc(15px * var(--w-ts));height:calc(15px * var(--w-ts));
  border-radius:calc(4.5px * var(--w-ts));background:${rgba(BRAND.paper, 0.14)};
  color:var(--w-text);font-size:calc(8.6px * var(--w-ts));font-weight:800;padding:0 3px;
}
.w-hint .badge{
  position:absolute;top:calc(-6px * var(--w-ts));right:calc(-5px * var(--w-ts));
  min-width:calc(15px * var(--w-ts));height:calc(15px * var(--w-ts));border-radius:99px;
  background:var(--w-bad);color:#fff;font-size:calc(9px * var(--w-ts));font-weight:800;
  display:grid;place-items:center;padding:0 3px;box-shadow:0 0 0 2px ${rgba(BRAND.ink, 0.7)};
}

/* ============================================================
   TOUCH CONTROLS — ui/touch.js

   Only ever in the document when the device is actually touched;
   see touch.js for the detection. Everything here is sized in raw
   px, deliberately NOT scaled by --w-ts: a thumb is the same size
   whatever the player set the text to, and 44 px is the smallest
   target anyone should have to hit while an elephant is running.

   The two clusters own the bottom two corners, so the HUD gets out
   of their way: the key-hint row is replaced by the action pad, and
   the toasts move from bottom-left (under the thumb) to under the
   objective strip, top-left.
   ============================================================ */
.w-touch{position:absolute;inset:0;pointer-events:none;z-index:2;
  transition:opacity .28s var(--w-ease)}
.w-touch.hidden{display:none}
.w-touch.muted{opacity:.22;pointer-events:none}

/* the capture area. Invisible, bottom-left, thumb-sized — a drag that
   starts here works the stick, a drag anywhere else reaches the canvas
   underneath and orbits the camera. */
.w-stickzone{
  position:absolute;left:0;bottom:0;
  width:min(46vw,250px);height:min(56vh,320px);
  padding:0 0 max(12px,env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-left));
  pointer-events:auto;touch-action:none;-webkit-user-select:none;user-select:none;
}
.w-stick{
  position:absolute;left:0;top:0;width:var(--w-sk);height:var(--w-sk);
  margin-left:calc(var(--w-sk) * -.5);margin-top:calc(var(--w-sk) * -.5);
  border-radius:50%;opacity:.78;
  transition:opacity .22s var(--w-ease);
  will-change:transform,opacity;
}
.w-stick.live{opacity:1}
/* Same chrome as every other surface in the game — one chrome, no
   second colour (see the key-hint note). It matters more here than
   anywhere else: a ring made of a hairline and a wash disappears the
   moment a grey elephant walks through it, and this is the one control
   the player has to be able to find without looking down. */
.w-stick .ring{
  position:absolute;inset:0;border-radius:50%;
  ${G('var(--w-chrome)')}
  -webkit-backdrop-filter:var(--w-blur);backdrop-filter:var(--w-blur);
  border:1.5px solid ${rgba(BRAND.paper, 0.34)};
  box-shadow:var(--w-shadow),inset 0 1px 0 ${rgba(BRAND.paper, 0.16)},
    inset 0 0 30px ${rgba(0x05070c, 0.30)};
}
/* the four bearings, so the ring reads as a control and not a smudge */
.w-stick .tick{position:absolute;left:50%;top:50%;width:2px;height:7px;margin:-3.5px 0 0 -1px;
  border-radius:2px;background:${rgba(BRAND.paper, 0.42)};transform-origin:50% 50%}
.w-stick .knob{
  position:absolute;left:50%;top:50%;width:var(--w-kn);height:var(--w-kn);
  margin-left:calc(var(--w-kn) * -.5);margin-top:calc(var(--w-kn) * -.5);
  border-radius:50%;
  background:linear-gradient(178deg,${rgba(BRAND.paper, 0.94)},${C(mix(BRAND.paper, BRAND.token, 0.22))});
  border:1px solid ${rgba(BRAND.ink, 0.18)};
  box-shadow:0 3px 0 ${rgba(BRAND.token2, 0.55)},0 8px 20px ${rgba(0x05070c, 0.45)},inset 0 1px 0 ${rgba(0xffffff, 0.7)};
  will-change:transform;
}
.w-stick.run .knob{background:linear-gradient(178deg,${C(mix(BRAND.token, 0xffffff, 0.35))},var(--w-token));
  box-shadow:0 3px 0 ${rgba(BRAND.token2, 0.8)},0 0 22px ${rgba(BRAND.token, 0.5)},inset 0 1px 0 ${rgba(0xffffff, 0.5)}}
/* the caption goes ABOVE the ring: below it is off the bottom of the
   screen, which is where a thumb-height control by definition sits */
.w-stick .lbl{
  position:absolute;left:50%;top:-15px;transform:translateX(-50%);
  font-size:9.5px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;
  color:var(--w-dim2);white-space:nowrap;transition:opacity .2s var(--w-ease);
}
.w-stick.live .lbl{opacity:0}

/* ---------- the action pad ---------- */
/* the +15 is headroom for the captions, which hang below the buttons
   and would otherwise be cropped by the bottom edge of the screen */
.w-acts{
  position:absolute;right:max(12px,env(safe-area-inset-right));
  bottom:calc(max(10px,env(safe-area-inset-bottom)) + 15px);
  display:flex;flex-direction:column;align-items:flex-end;gap:10px;
  pointer-events:none;
}
.w-acts .shortcuts{display:flex;gap:8px;pointer-events:none}
.w-acts .pad{display:flex;align-items:flex-end;gap:11px;pointer-events:none}
.w-abtn{
  position:relative;display:grid;place-items:center;
  width:46px;height:46px;border-radius:50%;padding:0;
  pointer-events:auto;touch-action:manipulation;-webkit-user-select:none;user-select:none;
  ${G('var(--w-chrome)')}
  -webkit-backdrop-filter:var(--w-blur);backdrop-filter:var(--w-blur);
  border:1px solid var(--w-line);box-shadow:var(--w-shadow),var(--w-inset);
  color:var(--w-text);font-family:var(--w-font);font-weight:800;cursor:pointer;
  transition:transform .12s var(--w-ease),opacity .2s var(--w-ease),border-color .2s;
}
.w-abtn .cap{position:absolute;left:50%;bottom:-13px;transform:translateX(-50%);
  font-size:8.5px;font-weight:800;letter-spacing:.13em;text-transform:uppercase;
  color:var(--w-dim2);white-space:nowrap;pointer-events:none}
.w-abtn:active,.w-abtn.down{transform:scale(.9);border-color:${rgba(BRAND.token, 0.75)}}
.w-abtn.big{width:66px;height:66px}
.w-abtn.mid{width:57px;height:57px;margin-bottom:26px}
.w-abtn.jump{background-image:var(--w-grain),linear-gradient(178deg,${rgba(BRAND.token, 0.92)},${rgba(BRAND.token2, 0.92)});
  color:${C(BRAND.ink)};border-color:${rgba(BRAND.paper, 0.4)};
  box-shadow:0 4px 0 ${rgba(BRAND.token2, 0.85)},var(--w-shadow)}
.w-abtn.jump .cap{color:${rgba(BRAND.text, 0.66)}}
.w-abtn .w-up{transform:rotate(90deg);transform-origin:50% 50%}
.w-abtn.act{border-color:${rgba(BRAND.token, 0.5)}}
.w-abtn.act.on{background-image:var(--w-grain),linear-gradient(178deg,${rgba(BRAND.good, 0.9)},${rgba(BRAND.good, 0.72)});
  color:${C(BRAND.paper)};animation:wActPulse 1.9s ease-in-out infinite}
.w-abtn.act.off{opacity:.46}
@keyframes wActPulse{0%,100%{box-shadow:var(--w-shadow),0 0 0 0 ${rgba(BRAND.good, 0.45)}}
  55%{box-shadow:var(--w-shadow),0 0 0 9px ${rgba(BRAND.good, 0)}}}
.w-abtn .badge{
  position:absolute;top:-3px;right:-3px;min-width:16px;height:16px;border-radius:99px;
  background:var(--w-bad);color:#fff;font-size:9px;font-weight:800;
  display:grid;place-items:center;padding:0 3px;box-shadow:0 0 0 2px ${rgba(BRAND.ink, 0.75)};
}

/* ---------- the HUD steps aside for two thumbs ---------- */
.w-touch-on .w-hints{display:none}
/* Toasts live bottom-left — under the thumb. On touch they move to
   just below the objective strip, whose height touch.js measures
   (it grows to two lines whenever the quest name is long). */
.w-touch-on .w-toasts{
  bottom:auto;top:var(--w-toasty,calc(max(12px,env(safe-area-inset-top)) + 96px));
  flex-direction:column;max-width:min(320px,60vw);
}
.w-touch-on .w-toast{animation-name:wToastIn}
/* the world prompt would sit under the pad on a short screen */
@media (max-height:460px){
  .w-touch .w-abtn.mid{margin-bottom:16px}
  .w-acts{gap:7px}
}

/* ---------- dialogue takes the frame ----------
   Nine live pills shouting around a cream slab is nobody's idea of
   a reading experience. While someone is speaking the HUD steps
   back; the objective holds a little higher because it is the one
   thing a player may want to check mid-conversation. */
.w-root .w-pills,.w-root .w-obj,.w-root .w-hints,.w-root .w-toasts,.w-root .w-promptlayer{
  transition:opacity .35s var(--w-ease);
}
.w-root.w-dlg-open .w-pills{opacity:.26}
.w-root.w-dlg-open .w-obj{opacity:.5}
.w-root.w-dlg-open .w-hints{opacity:.18}
.w-root.w-dlg-open .w-toasts{opacity:.3}
.w-root.w-dlg-open .w-promptlayer{opacity:.22}
.w-root.w-dlg-open .w-hint{opacity:1}

/* ---------- scrim + panels ---------- */
.w-scrim{
  position:absolute;inset:0;background:radial-gradient(120% 90% at 50% 40%,${rgba(0x05070c, 0.22)},${rgba(0x05070c, 0.62)});
  -webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);
  opacity:0;transition:opacity .3s var(--w-ease);
}
.w-scrim.on{opacity:1}
.w-panels{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:2.5vh 2.5vw}
.w-sheet{
  width:min(560px,94vw);max-height:min(84vh,760px);display:flex;flex-direction:column;
  border-radius:calc(22px * var(--w-ts));overflow:hidden;
  animation:wSheet .38s var(--w-ease) both;
}
.w-sheet.out{animation:wSheetOut .26s var(--w-ease) both}
@keyframes wSheet{from{opacity:0;transform:translateY(24px) scale(.97)}to{opacity:1;transform:none}}
@keyframes wSheetOut{to{opacity:0;transform:translateY(12px) scale(.985)}}
.w-sheet-head{
  display:flex;align-items:center;gap:calc(11px * var(--w-ts));
  padding:calc(14px * var(--w-ts)) calc(16px * var(--w-ts));
  border-bottom:1px solid ${rgba(BRAND.ink, 0.10)};flex:none;
}
.w-paper .w-sheet-head{background:linear-gradient(180deg,${rgba(0xffffff, 0.5)},transparent)}
.w-sheet-head h2{margin:0;font-size:calc(17px * var(--w-ts));font-weight:800;letter-spacing:.005em}
.w-sheet-head .hs{font-size:calc(11px * var(--w-ts));opacity:.62;font-weight:600;margin-top:1px}
.w-sheet-body{overflow-y:auto;overflow-x:hidden;padding:calc(13px * var(--w-ts)) calc(15px * var(--w-ts)) calc(17px * var(--w-ts));
  -webkit-overflow-scrolling:touch;scrollbar-width:thin}
.w-sheet-body::-webkit-scrollbar{width:8px}
.w-sheet-body::-webkit-scrollbar-thumb{background:${rgba(BRAND.ink, 0.18)};border-radius:99px}

/* ---------- generic bits ---------- */
.w-btn{
  -webkit-appearance:none;appearance:none;border:0;font-family:inherit;
  display:inline-flex;align-items:center;justify-content:center;gap:calc(7px * var(--w-ts));
  min-height:calc(38px * var(--w-ts));padding:0 calc(16px * var(--w-ts));
  border-radius:calc(12px * var(--w-ts));font-size:calc(13px * var(--w-ts));font-weight:800;
  background:${rgba(BRAND.ink, 0.08)};color:var(--w-ink);cursor:pointer;
  transition:transform .15s var(--w-ease),filter .15s,background .15s;
}
.w-btn:active{transform:scale(.965)}
.w-btn.prim{background:linear-gradient(180deg,var(--w-token),var(--w-token2));color:${C(BRAND.ink)};
  box-shadow:0 3px 0 ${rgba(BRAND.token2, 0.75)},0 6px 18px ${rgba(BRAND.token, 0.3)}}
.w-btn.prim:active{box-shadow:0 1px 0 ${rgba(BRAND.token2, 0.75)}}
.w-btn.ghost{background:transparent;box-shadow:inset 0 0 0 1.5px ${rgba(BRAND.ink, 0.16)}}
.w-btn.dark{background:${rgba(BRAND.paper, 0.10)};color:var(--w-text);box-shadow:inset 0 0 0 1px var(--w-line)}
.w-btn.sm{min-height:calc(30px * var(--w-ts));padding:0 calc(11px * var(--w-ts));font-size:calc(11.5px * var(--w-ts));border-radius:calc(9px * var(--w-ts))}
.w-btn[disabled]{opacity:.42;pointer-events:none}
.w-row{display:flex;gap:calc(8px * var(--w-ts));flex-wrap:wrap}
.w-grow{flex:1 1 auto;min-width:0}
.w-label{font-size:calc(9.6px * var(--w-ts));letter-spacing:.18em;text-transform:uppercase;font-weight:800;
  opacity:.5;margin:calc(14px * var(--w-ts)) 0 calc(7px * var(--w-ts));display:flex;align-items:center;gap:8px}
.w-label:first-child{margin-top:calc(2px * var(--w-ts))}
.w-label:before{content:'';width:calc(3px * var(--w-ts));height:calc(11px * var(--w-ts));background:var(--w-token);border-radius:2px}
.w-card{
  display:flex;align-items:center;gap:calc(11px * var(--w-ts));width:100%;text-align:left;
  padding:calc(11px * var(--w-ts)) calc(13px * var(--w-ts));border-radius:calc(13px * var(--w-ts));
  background:${rgba(0xffffff, 0.55)};box-shadow:inset 0 0 0 1px ${rgba(BRAND.ink, 0.08)};
  border:0;font-family:inherit;color:inherit;cursor:pointer;
  transition:transform .15s var(--w-ease),background .15s,box-shadow .15s;margin-bottom:calc(7px * var(--w-ts));
}
.w-card:active{transform:scale(.985);background:${rgba(0xffffff, 0.82)}}
.w-card[disabled]{opacity:.5;pointer-events:none}
.w-card .ic{width:calc(34px * var(--w-ts));height:calc(34px * var(--w-ts));border-radius:calc(10px * var(--w-ts));
  display:grid;place-items:center;flex:none;background:${rgba(BRAND.ink, 0.07)};color:${rgba(BRAND.ink, 0.72)}}
.w-card .t{font-weight:800;font-size:calc(13px * var(--w-ts))}
.w-card .d{font-size:calc(11px * var(--w-ts));opacity:.62;margin-top:1px;line-height:1.3}
.w-card .m{margin-left:auto;text-align:right;font-weight:800;font-size:calc(12px * var(--w-ts));white-space:nowrap}
.w-card .m small{display:block;font-weight:600;font-size:calc(10px * var(--w-ts));opacity:.6}

/* A LOCKED RIDE IS A SHOP WINDOW, NOT A GREY ROW. Same card, but
   unfilled and outlined in warm token dashes — the register of a
   thing on display behind glass rather than a control that has been
   switched off. The glyph keeps its colour: it is the whole reason
   to want it. 'on' is the mirror of it — the one under him right
   now, in green, so the list has an obvious head. */
.w-card.locked{background:${rgba(BRAND.token, 0.055)};
  box-shadow:inset 0 0 0 1.5px ${rgba(BRAND.token, 0.26)}}
.w-card.locked .t{opacity:.9}
.w-card.locked .ic{background:${rgba(BRAND.token, 0.13)}}
.w-card.on{background:${rgba(BRAND.good, 0.11)};
  box-shadow:inset 0 0 0 1.5px ${rgba(BRAND.good, 0.34)}}
.w-card.on .ic{background:${rgba(BRAND.good, 0.16)}}
.w-empty{padding:calc(26px * var(--w-ts)) calc(14px * var(--w-ts));text-align:center;opacity:.5;font-size:calc(12px * var(--w-ts))}
.w-chipbar{display:flex;gap:calc(6px * var(--w-ts));overflow-x:auto;padding-bottom:calc(4px * var(--w-ts));scrollbar-width:none}
.w-chipbar::-webkit-scrollbar{display:none}
.w-chip{border:0;font-family:inherit;white-space:nowrap;cursor:pointer;
  padding:calc(6px * var(--w-ts)) calc(11px * var(--w-ts));border-radius:999px;font-size:calc(11px * var(--w-ts));font-weight:800;
  background:${rgba(BRAND.ink, 0.07)};color:${rgba(BRAND.ink, 0.66)};transition:background .15s,color .15s}
.w-chip.on{background:var(--w-token);color:${C(BRAND.ink)}}
.w-kv{display:flex;justify-content:space-between;gap:12px;padding:calc(7px * var(--w-ts)) 0;
  border-bottom:1px solid ${rgba(BRAND.ink, 0.07)};font-size:calc(12px * var(--w-ts))}
.w-kv:last-child{border-bottom:0}
.w-kv b{font-variant-numeric:tabular-nums}
.w-switch{position:relative;width:calc(46px * var(--w-ts));height:calc(27px * var(--w-ts));border-radius:99px;border:0;flex:none;
  background:${rgba(BRAND.ink, 0.16)};cursor:pointer;transition:background .22s var(--w-ease)}
.w-switch:after{content:'';position:absolute;top:calc(3px * var(--w-ts));left:calc(3px * var(--w-ts));
  width:calc(21px * var(--w-ts));height:calc(21px * var(--w-ts));border-radius:99px;background:#fff;
  box-shadow:0 1px 3px rgba(0,0,0,.32);transition:transform .22s var(--w-ease)}
.w-switch.on{background:var(--w-token)}
.w-switch.on:after{transform:translateX(calc(19px * var(--w-ts)))}
/* A SETTINGS ROW THAT HAS TO EXPLAIN ITSELF — ui/menus.js
   landscapeRow(). The line underneath is not a description, it is a
   live status: an orientation lock dies when fullscreen closes and
   the row has to say so. .warn is a refusal, which is worth reading
   rather than skimming, so it comes up out of the .55 register. */
.w-lsrow{padding-bottom:calc(8px * var(--w-ts));
  border-bottom:1px solid ${rgba(BRAND.ink, 0.07)}}
.w-lsrow .w-kv{border-bottom:0;padding-bottom:calc(2px * var(--w-ts))}
.w-lsrow .sub{font-size:calc(10.6px * var(--w-ts));line-height:1.42;font-weight:600;
  opacity:.55;max-width:46ch}
.w-lsrow.warn .sub{opacity:.92;color:${C(BRAND.bad)}}
/* the row still has a right-hand column when it has no switch — an
   empty gutter would read as a control that failed to draw */
.w-tagoff{flex:none;align-self:center;font-size:calc(9.4px * var(--w-ts));font-weight:800;
  letter-spacing:.14em;text-transform:uppercase;opacity:.42;white-space:nowrap}
.w-slider{-webkit-appearance:none;appearance:none;width:100%;height:calc(5px * var(--w-ts));border-radius:99px;
  background:${rgba(BRAND.ink, 0.14)};outline:0;cursor:pointer}
.w-slider::-webkit-slider-thumb{-webkit-appearance:none;width:calc(20px * var(--w-ts));height:calc(20px * var(--w-ts));
  border-radius:99px;background:var(--w-token);box-shadow:0 1px 4px rgba(0,0,0,.35),0 0 0 3px ${rgba(BRAND.token, 0.2)};cursor:pointer}
.w-ta{width:100%;min-height:110px;border-radius:12px;border:1.5px solid ${rgba(BRAND.ink, 0.16)};
  background:${rgba(0xffffff, 0.6)};padding:10px;font-family:var(--w-mono);font-size:11px;color:var(--w-ink);resize:vertical}

/* ---------- the phone ---------- */
.w-phone{
  width:min(392px,92vw);height:min(760px,90vh);display:flex;flex-direction:column;
  border-radius:calc(38px * var(--w-ts));padding:calc(9px * var(--w-ts));
  ${G(phoneBg)}
  border:1px solid ${rgba(BRAND.paper, 0.16)};
  box-shadow:0 40px 90px ${rgba(0x05070c, 0.62)},var(--w-inset),0 0 0 1px ${rgba(0x05070c, 0.5)};
  animation:wSheet .4s var(--w-ease) both;
}
.w-phone.out{animation:wSheetOut .26s var(--w-ease) both}
.w-screen{
  flex:1;min-height:0;display:flex;flex-direction:column;border-radius:calc(30px * var(--w-ts));overflow:hidden;
  ${G(screenBg)}
  color:var(--w-ink);position:relative;
}
/* 22px of side inset, not 16 — at the battery's height the 30px
   corner arc eats about 5px of it, and a clipped battery cap in the
   first 100px of the panel reads as unfinished. */
.w-status{display:flex;align-items:center;gap:8px;padding:calc(10px * var(--w-ts)) calc(22px * var(--w-ts)) calc(6px * var(--w-ts));
  font-size:calc(11px * var(--w-ts));font-weight:800;letter-spacing:.02em;color:${rgba(BRAND.ink, 0.66)};flex:none}
.w-status .batwrap{display:flex;align-items:center;gap:calc(1.5px * var(--w-ts));flex:none}
.w-status .bat{width:calc(22px * var(--w-ts));height:calc(11px * var(--w-ts));border-radius:3px;
  box-shadow:inset 0 0 0 1.4px ${rgba(BRAND.ink, 0.4)};padding:1.6px}
/* the terminal nub is a flex sibling, not an absolute pseudo — it
   participates in layout and so can never overhang the screen */
.w-status .batnub{width:calc(2px * var(--w-ts));height:calc(4px * var(--w-ts));flex:none;
  background:${rgba(BRAND.ink, 0.4)};border-radius:0 2px 2px 0}
.w-status .bat i{display:block;height:100%;border-radius:1.5px;background:var(--w-good)}
.w-appbar{display:flex;align-items:center;gap:calc(9px * var(--w-ts));padding:calc(2px * var(--w-ts)) calc(15px * var(--w-ts)) calc(6px * var(--w-ts));flex:none;min-height:calc(30px * var(--w-ts))}
/* an eyebrow, not a headline — the numbers below it are the reason
   the player opened the phone */
.w-appbar h3{margin:0;font-size:calc(11px * var(--w-ts));font-weight:800;letter-spacing:.17em;
  text-transform:uppercase;color:${rgba(BRAND.ink, 0.5)}}
.w-appbar h3:empty{display:none}
.w-appbody{flex:1;min-height:0;overflow-y:auto;padding:0 calc(13px * var(--w-ts)) calc(14px * var(--w-ts));scrollbar-width:thin}
/* the home screen only: let the mark sink to the bottom edge so the
   leftover space reads as a margin, not as content that ran out */
.w-appbody.home{display:flex;flex-direction:column}
.w-appbody.home>*{flex:none}
.w-appbody.home>.foot{margin-top:auto}
.w-appbody::-webkit-scrollbar{width:6px}
.w-appbody::-webkit-scrollbar-thumb{background:${rgba(BRAND.ink, 0.16)};border-radius:99px}
.w-apps{display:grid;grid-template-columns:repeat(3,1fr);gap:calc(12px * var(--w-ts));padding:calc(6px * var(--w-ts)) 0}
.w-app{background:none;border:0;font-family:inherit;cursor:pointer;display:flex;flex-direction:column;
  align-items:center;gap:calc(6px * var(--w-ts));padding:0;color:inherit;transition:transform .16s var(--w-ease)}
.w-app:active{transform:scale(.92)}
.w-app .tile{width:calc(58px * var(--w-ts));height:calc(58px * var(--w-ts));border-radius:calc(18px * var(--w-ts));
  display:grid;place-items:center;color:#fff;position:relative;
  box-shadow:0 5px 14px ${rgba(0x05070c, 0.24)},inset 0 1.4px 0 ${rgba(0xffffff, 0.38)},inset 0 -2px 6px ${rgba(0x05070c, 0.18)}}
.w-app .nm{font-size:calc(10.5px * var(--w-ts));font-weight:800;opacity:.78;letter-spacing:.005em}
.w-app .bdg{position:absolute;top:calc(-5px * var(--w-ts));right:calc(-5px * var(--w-ts));
  min-width:calc(19px * var(--w-ts));height:calc(19px * var(--w-ts));border-radius:99px;background:var(--w-bad);
  color:#fff;font-size:calc(10px * var(--w-ts));font-weight:800;display:grid;place-items:center;padding:0 4px;
  box-shadow:0 0 0 2.4px ${C(BRAND.paper)}}
.w-msg{padding:calc(11px * var(--w-ts)) calc(13px * var(--w-ts));border-radius:calc(15px * var(--w-ts));
  background:${rgba(0xffffff, 0.62)};box-shadow:inset 0 0 0 1px ${rgba(BRAND.ink, 0.07)};margin-bottom:calc(8px * var(--w-ts))}
.w-msg .hd{display:flex;align-items:center;gap:8px;font-weight:800;font-size:calc(12.5px * var(--w-ts))}
.w-msg .hd .when{margin-left:auto;font-size:calc(10px * var(--w-ts));opacity:.5;font-weight:700}
.w-msg .bd{font-size:calc(12px * var(--w-ts));line-height:1.44;margin-top:calc(5px * var(--w-ts));opacity:.86}
.w-msg.unread{background:${rgba(BRAND.token, 0.14)};box-shadow:inset 0 0 0 1px ${rgba(BRAND.token, 0.34)}}

/* ---------- at a glance ----------
   Cards, not a definition list. One hero figure (cash — the number
   the player actually came for), then a three-up of the slower
   stats. Same .w-msg surface as everything else on this screen, so
   the phone reuses one component instead of inventing a table. */
.w-hero{display:flex;align-items:center;gap:calc(12px * var(--w-ts));
  padding:calc(12px * var(--w-ts)) calc(14px * var(--w-ts));border-radius:calc(16px * var(--w-ts));
  background:linear-gradient(150deg,${rgba(BRAND.token, 0.20)},${rgba(0xffffff, 0.66)} 72%);
  box-shadow:inset 0 0 0 1px ${rgba(BRAND.token, 0.28)},0 3px 10px ${rgba(BRAND.token2, 0.10)};
  margin-bottom:calc(8px * var(--w-ts))}
.w-hero .ic{width:calc(42px * var(--w-ts));height:calc(42px * var(--w-ts));border-radius:calc(13px * var(--w-ts));
  display:grid;place-items:center;flex:none;color:#fff;
  background:linear-gradient(160deg,var(--w-token),var(--w-token2));
  box-shadow:0 4px 10px ${rgba(BRAND.token2, 0.34)},inset 0 1.4px 0 ${rgba(0xffffff, 0.44)}}
.w-hero .k{font-size:calc(9.5px * var(--w-ts));letter-spacing:.18em;text-transform:uppercase;
  font-weight:800;color:${rgba(BRAND.ink, 0.5)}}
.w-hero .v{font-size:calc(26px * var(--w-ts));font-weight:800;letter-spacing:-.02em;line-height:1.08;
  color:var(--w-token2);font-variant-numeric:tabular-nums}
.w-hero .w{margin-left:auto;text-align:right;max-width:44%}
.w-hero .w .k{letter-spacing:.14em}
.w-hero .w .n{font-size:calc(11.5px * var(--w-ts));font-weight:800;color:${rgba(BRAND.ink, 0.78)};
  margin-top:2px;line-height:1.24}
.w-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:calc(7px * var(--w-ts));margin-bottom:calc(8px * var(--w-ts))}
.w-stat{padding:calc(9px * var(--w-ts)) calc(10px * var(--w-ts));border-radius:calc(13px * var(--w-ts));
  background:${rgba(0xffffff, 0.62)};box-shadow:inset 0 0 0 1px ${rgba(BRAND.ink, 0.07)};
  display:flex;flex-direction:column;gap:calc(5px * var(--w-ts));min-width:0;
  /* a pressable tile is a <button>: kill the UA chrome, keep the card */
  -webkit-appearance:none;appearance:none;border:0;font-family:inherit;color:inherit;
  text-align:left;cursor:default}
button.w-stat{cursor:pointer;transition:transform .15s var(--w-ease)}
button.w-stat:active{transform:scale(.97)}
/* THE LABEL WRAPS RATHER THAN TRUNCATES. It carries the reputation
   TITLE now, and "A Little C." is worse than two short lines. */
.w-stat .k{display:flex;align-items:flex-start;gap:calc(5px * var(--w-ts));
  font-size:calc(8.8px * var(--w-ts));letter-spacing:.11em;text-transform:uppercase;line-height:1.32;
  font-weight:800;color:${rgba(BRAND.ink, 0.46)};overflow:hidden}
.w-stat .k .w-i{flex:none;margin-top:calc(1px * var(--w-ts))}
.w-stat .k .w-i{opacity:.7;flex:none}
.w-stat .v{font-size:calc(16px * var(--w-ts));font-weight:800;letter-spacing:-.01em;
  font-variant-numeric:tabular-nums;color:${rgba(BRAND.ink, 0.86)}}
.w-home-ind{height:calc(16px * var(--w-ts));display:grid;place-items:center;flex:none}
.w-home-ind i{width:calc(110px * var(--w-ts));height:calc(4px * var(--w-ts));border-radius:99px;background:${rgba(BRAND.ink, 0.22)}}

/* ---------- dialogue ---------- */
.w-dlg{
  position:absolute;left:50%;bottom:calc(max(16px,env(safe-area-inset-bottom)) + 12px);
  transform:translateX(-50%);width:min(592px,92vw);
  border-radius:calc(20px * var(--w-ts));overflow:hidden;
  animation:wDlgIn .38s var(--w-ease) both;
}
.w-dlg.out{animation:wDlgOut .26s var(--w-ease) both}
@keyframes wDlgIn{from{opacity:0;transform:translateX(-50%) translateY(26px) scale(.97)}to{opacity:1;transform:translateX(-50%)}}
@keyframes wDlgOut{to{opacity:0;transform:translateX(-50%) translateY(14px) scale(.985)}}
.w-dlg-in{display:flex;gap:calc(15px * var(--w-ts));padding:calc(16px * var(--w-ts)) calc(19px * var(--w-ts)) calc(15px * var(--w-ts))}
/* centred on the card, not top-aligned in the flex row */
.w-dlg-por{position:relative;flex:none;align-self:center;width:calc(66px * var(--w-ts));height:calc(66px * var(--w-ts))}
.w-dlg-por>*{width:100%;height:100%;border-radius:99px;box-shadow:0 5px 16px ${rgba(0x05070c, 0.32)},0 0 0 2px ${rgba(0xffffff, 0.5)}}
.w-dlg-nm{font-size:calc(12.5px * var(--w-ts));font-weight:800;letter-spacing:.11em;text-transform:uppercase;color:var(--w-token2)}
.w-dlg-rl{font-size:calc(10.5px * var(--w-ts));opacity:.55;font-weight:700;margin-top:-1px}
/* no min-height: the card is exactly as tall as the line. The ghost
   span reserves the full page so the box does not jitter while the
   typewriter runs — measure lands at ~62 characters. */
.w-dlg-tx{position:relative;font-size:calc(15.6px * var(--w-ts));line-height:1.52;
  margin-top:calc(6px * var(--w-ts));font-weight:600;letter-spacing:.002em}
.w-dlg-tx .gh{visibility:hidden;display:block}
.w-dlg-tx .lv{position:absolute;left:0;top:0;right:0}
.w-dlg-tx .car{display:inline-block;width:.46em;height:1.02em;vertical-align:-.16em;margin-left:.06em;
  background:var(--w-token);border-radius:2px;animation:wCar .82s steps(1) infinite}
@keyframes wCar{0%,55%{opacity:1}56%,100%{opacity:0}}
.w-dlg-ch{display:flex;flex-wrap:wrap;gap:calc(8px * var(--w-ts));padding:0 calc(19px * var(--w-ts)) calc(16px * var(--w-ts))}
/* a real affordance with the bound key, not 0.42-opacity body text
   on cream — this is a keyboard build */
.w-dlg-more{display:flex;align-items:center;justify-content:flex-end;gap:calc(8px * var(--w-ts));
  padding:0 calc(19px * var(--w-ts)) calc(15px * var(--w-ts));
  font-size:calc(10px * var(--w-ts));font-weight:800;letter-spacing:.14em;text-transform:uppercase;
  opacity:.7;color:${rgba(BRAND.ink, 0.9)}}
.w-dlg-more .key{animation:wKeyPulse 2.1s ease-in-out infinite}
@keyframes wKeyPulse{0%,100%{transform:translateY(0)}50%{transform:translateY(-1.5px)}}

/* ---------- pause menu ---------- */
.w-pause{width:min(400px,92vw);border-radius:calc(24px * var(--w-ts));padding:calc(22px * var(--w-ts));
  display:flex;flex-direction:column;gap:calc(9px * var(--w-ts));animation:wSheet .36s var(--w-ease) both}
.w-pause .brand{display:flex;flex-direction:column;align-items:center;gap:calc(7px * var(--w-ts));margin-bottom:calc(8px * var(--w-ts))}
.w-pause .brand .wm{font-size:calc(25px * var(--w-ts));font-weight:800;letter-spacing:.2em;color:var(--w-token);
  text-shadow:0 0 30px ${rgba(BRAND.token, 0.44)}}
.w-pause .brand .sm{font-size:calc(10px * var(--w-ts));letter-spacing:.24em;text-transform:uppercase;color:var(--w-dim2);font-weight:800}
.w-pause .w-btn{width:100%}

/* ============================================================
   TICKERS — the primary handle for an asset (style.js tickerTag).

   Mono, tabular, tracked and boxed, so that in a list of nine rows
   the eye lands on the symbol column and not on the prose. The
   default is tuned for paper (sheets, the phone); .on-dark is the
   chrome variant for anything sitting over the world.
   ============================================================ */
.w-tick{
  display:inline-flex;align-items:center;gap:.28em;flex:none;
  font-family:var(--w-mono);font-weight:800;letter-spacing:.055em;
  font-variant-numeric:tabular-nums;font-size:calc(12.6px * var(--w-ts));
  line-height:1;padding:calc(4px * var(--w-ts)) calc(7px * var(--w-ts));
  border-radius:calc(7px * var(--w-ts));white-space:nowrap;
  color:${rgba(BRAND.ink, 0.92)};background:${rgba(BRAND.ink, 0.07)};
  box-shadow:inset 0 0 0 1.2px ${rgba(BRAND.ink, 0.16)};
}
.w-tick.lg{font-size:calc(19px * var(--w-ts));padding:calc(6px * var(--w-ts)) calc(10px * var(--w-ts));
  letter-spacing:.07em;border-radius:calc(9px * var(--w-ts))}
.w-tick.sm{font-size:calc(11px * var(--w-ts));padding:calc(3px * var(--w-ts)) calc(5.5px * var(--w-ts))}
/* the one the player is about to buy */
.w-tick.hot{color:${C(BRAND.token2)};background:${rgba(BRAND.token, 0.18)};
  box-shadow:inset 0 0 0 1.4px ${rgba(BRAND.token, 0.5)}}
.w-tick .q{font-weight:700;opacity:.62;letter-spacing:.01em}
.w-tick.on-dark{color:var(--w-text);background:${rgba(BRAND.paper, 0.12)};
  box-shadow:inset 0 0 0 1.2px ${rgba(BRAND.paper, 0.2)}}
.w-ticket{display:inline-flex;align-items:center;gap:calc(5px * var(--w-ts));flex-wrap:wrap}
.w-ticket .sep{opacity:.35;font-weight:800}

/* ============================================================
   THE MAP — ui/map.js
   ============================================================ */
.w-map{
  position:relative;border-radius:calc(15px * var(--w-ts));overflow:hidden;
  background:${C(mix(SEA.shallow, BRAND.paper, 0.42))};
  box-shadow:inset 0 0 0 1.4px ${rgba(BRAND.ink, 0.16)},0 5px 16px ${rgba(BRAND.ink, 0.14)};
  margin:calc(4px * var(--w-ts)) 0 calc(9px * var(--w-ts));
}
.w-map-svg{display:block;width:100%;height:auto;font-family:var(--w-font)}
.w-map-svg text{user-select:none;-webkit-user-select:none}
.w-map .w-map-tools{
  position:absolute;right:calc(8px * var(--w-ts));bottom:calc(8px * var(--w-ts));
  display:flex;gap:calc(6px * var(--w-ts));
}
.w-map .wm-me circle:first-child{animation:wPing 2.6s ease-out infinite}
@keyframes wPing{0%{opacity:.55;transform-box:fill-box;transform-origin:center;transform:scale(.6)}
  70%{opacity:0;transform:scale(1.25)}100%{opacity:0;transform:scale(1.25)}}
.w-mapwrap{display:flex;flex-direction:column;height:100%;min-height:0}
.w-mapwrap .w-map{flex:1;min-height:0;display:flex}
.w-mapwrap .w-map-svg{width:100%;height:100%;object-fit:contain}

/* ============================================================
   QUICK BUY — the search box, the results and the trade ticket.
   ============================================================ */
.w-srch{
  display:flex;align-items:center;gap:calc(8px * var(--w-ts));
  padding:0 calc(12px * var(--w-ts));min-height:calc(42px * var(--w-ts));
  border-radius:calc(12px * var(--w-ts));background:${rgba(0xffffff, 0.72)};
  box-shadow:inset 0 0 0 1.5px ${rgba(BRAND.ink, 0.16)};
  margin-bottom:calc(9px * var(--w-ts));
}
.w-srch:focus-within{box-shadow:inset 0 0 0 2px ${rgba(BRAND.token, 0.7)}}
.w-srch .w-i{opacity:.5;flex:none}
.w-srch input{
  flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--w-ink);
  font-family:var(--w-mono);font-size:calc(14.5px * var(--w-ts));font-weight:800;
  letter-spacing:.06em;text-transform:uppercase;padding:calc(9px * var(--w-ts)) 0;
}
.w-srch input::placeholder{font-family:var(--w-font);font-weight:700;letter-spacing:.01em;
  text-transform:none;opacity:.42}
.w-srch .clr{flex:none}

/* the ticket. A perforated stub down the left is the one bit of
   skeuomorphism here and it earns its keep: it says "this is an
   order you are about to place", which is exactly the thing the
   player could not previously tell. */
.w-tkt{
  position:relative;border-radius:calc(14px * var(--w-ts));overflow:hidden;
  background:${rgba(0xffffff, 0.78)};
  box-shadow:inset 0 0 0 1.5px ${rgba(BRAND.ink, 0.15)},0 4px 14px ${rgba(BRAND.ink, 0.10)};
  padding:calc(13px * var(--w-ts)) calc(14px * var(--w-ts)) calc(12px * var(--w-ts)) calc(20px * var(--w-ts));
  margin-top:calc(4px * var(--w-ts));
}
.w-tkt:before{content:'';position:absolute;left:calc(9px * var(--w-ts));top:calc(10px * var(--w-ts));
  bottom:calc(10px * var(--w-ts));width:0;border-left:2px dashed ${rgba(BRAND.ink, 0.22)}}
.w-tkt .hd{display:flex;align-items:center;gap:calc(10px * var(--w-ts))}
.w-tkt .nm{font-weight:800;font-size:calc(13.4px * var(--w-ts));line-height:1.2}
.w-tkt .sb{font-size:calc(10.6px * var(--w-ts));opacity:.62;font-weight:700;margin-top:2px}
.w-tkt .w-kv{border-bottom-color:${rgba(BRAND.ink, 0.08)}}
.w-tkt .tot{border-top:1.6px solid ${rgba(BRAND.ink, 0.22)};margin-top:calc(4px * var(--w-ts));padding-top:calc(8px * var(--w-ts))}
.w-tkt .tot span{font-weight:800;letter-spacing:.14em;text-transform:uppercase;font-size:calc(10px * var(--w-ts))}
.w-tkt .tot b{font-size:calc(18px * var(--w-ts));letter-spacing:-.01em}
.w-tkt .warn{margin-top:calc(9px * var(--w-ts));padding:calc(9px * var(--w-ts)) calc(11px * var(--w-ts));
  border-radius:calc(11px * var(--w-ts));font-size:calc(11.4px * var(--w-ts));font-weight:700;line-height:1.42;
  background:${rgba(BRAND.bad, 0.11)};box-shadow:inset 0 0 0 1.3px ${rgba(BRAND.bad, 0.3)}}
.w-tkt .warn.ok{background:${rgba(BRAND.good, 0.12)};box-shadow:inset 0 0 0 1.3px ${rgba(BRAND.good, 0.3)}}
.w-tkt .warn.wait{background:${rgba(BRAND.warn, 0.14)};box-shadow:inset 0 0 0 1.3px ${rgba(BRAND.warn, 0.36)}}

/* the quantity stepper — big targets, tabular figure */
.w-qty{display:flex;align-items:center;gap:calc(7px * var(--w-ts));margin:calc(10px * var(--w-ts)) 0}
.w-qty .stp{
  -webkit-appearance:none;appearance:none;border:0;font-family:inherit;cursor:pointer;
  width:calc(34px * var(--w-ts));height:calc(34px * var(--w-ts));border-radius:calc(11px * var(--w-ts));
  display:grid;place-items:center;color:var(--w-ink);
  background:${rgba(BRAND.ink, 0.07)};box-shadow:inset 0 0 0 1.4px ${rgba(BRAND.ink, 0.16)};
}
.w-qty .stp:active{transform:scale(.94)}
.w-qty .stp[disabled]{opacity:.35;pointer-events:none}
.w-qty .n{min-width:calc(52px * var(--w-ts));text-align:center;font-family:var(--w-mono);
  font-variant-numeric:tabular-nums;font-size:calc(19px * var(--w-ts));font-weight:800}
.w-qty .pre{margin-left:auto;display:flex;gap:calc(5px * var(--w-ts))}

/* ============================================================
   THE ASK — the price legibility block.

   economy.buyPrice() is mid x (1 + venue spread), so a list quoting
   the mid beside a button charging the ask reads as a bug. These two
   surfaces put the ask on top, at size, and print the mid and the
   spread underneath it in cash: the difference is a stated fee.
   ============================================================ */
.w-ask{
  margin-top:calc(10px * var(--w-ts));padding:calc(10px * var(--w-ts)) calc(12px * var(--w-ts));
  border-radius:calc(12px * var(--w-ts));
  background:${rgba(BRAND.token, 0.13)};box-shadow:inset 0 0 0 1.3px ${rgba(BRAND.token, 0.30)};
}
.w-ask .row{display:flex;align-items:baseline;gap:calc(8px * var(--w-ts))}
.w-ask .k{font-size:calc(9.4px * var(--w-ts));letter-spacing:.16em;text-transform:uppercase;
  font-weight:800;color:${rgba(BRAND.ink, 0.55)}}
.w-ask .v{margin-left:auto;font-size:calc(21px * var(--w-ts));font-weight:800;letter-spacing:-.02em;
  font-variant-numeric:tabular-nums;color:var(--w-token2)}
.w-ask .u{font-size:calc(10px * var(--w-ts));font-weight:800;opacity:.55}
.w-ask .brk{display:flex;align-items:center;flex-wrap:wrap;gap:calc(7px * var(--w-ts));
  margin-top:calc(5px * var(--w-ts));font-size:calc(11px * var(--w-ts));font-weight:700;opacity:.78}
.w-ask .brk b{font-variant-numeric:tabular-nums}
.w-ask .brk .op{font-weight:800;opacity:.5}
.w-spread{
  padding:calc(9px * var(--w-ts)) calc(11px * var(--w-ts));border-radius:calc(12px * var(--w-ts));
  background:${rgba(BRAND.info, 0.11)};box-shadow:inset 0 0 0 1.2px ${rgba(BRAND.info, 0.26)};
  margin:calc(6px * var(--w-ts)) 0;
}
.w-spread .k{display:block;font-size:calc(9.4px * var(--w-ts));letter-spacing:.16em;
  text-transform:uppercase;font-weight:800;color:${rgba(BRAND.ink, 0.55)}}
.w-spread .d{display:block;font-size:calc(11.4px * var(--w-ts));line-height:1.45;
  font-weight:700;margin-top:calc(3px * var(--w-ts));opacity:.85}

/* ---------- notes, warnings, and the refusal card ---------- */
.w-note{font-size:calc(11.4px * var(--w-ts));line-height:1.5;font-weight:600;opacity:.72;
  padding:calc(8px * var(--w-ts)) 0}
.w-warnbox{
  padding:calc(11px * var(--w-ts)) calc(13px * var(--w-ts));border-radius:calc(13px * var(--w-ts));
  font-size:calc(12.2px * var(--w-ts));font-weight:700;line-height:1.46;
  background:${rgba(BRAND.warn, 0.15)};box-shadow:inset 0 0 0 1.3px ${rgba(BRAND.warn, 0.38)};
}
.w-warnbox.bad{background:${rgba(BRAND.bad, 0.13)};box-shadow:inset 0 0 0 1.3px ${rgba(BRAND.bad, 0.34)}}
.w-warnbox.good{background:${rgba(BRAND.good, 0.13)};box-shadow:inset 0 0 0 1.3px ${rgba(BRAND.good, 0.34)}}

/* ---------- the producer upgrade card ----------
   The cost, then the three effects in numbers, then the button. A
   level is a purchase; a purchase gets a receipt before the money. */
.w-up{
  padding:calc(12px * var(--w-ts)) calc(13px * var(--w-ts));border-radius:calc(15px * var(--w-ts));
  background:${rgba(0xffffff, 0.70)};box-shadow:inset 0 0 0 1.3px ${rgba(BRAND.ink, 0.12)};
}
.w-up.poor{opacity:.82}
.w-up .hd{display:flex;align-items:center;gap:calc(10px * var(--w-ts))}
.w-up .hd .ic{width:calc(32px * var(--w-ts));height:calc(32px * var(--w-ts));flex:none;
  border-radius:calc(10px * var(--w-ts));display:grid;place-items:center;
  background:${rgba(BRAND.token, 0.16)};color:var(--w-token2)}
.w-up .hd .t{font-weight:800;font-size:calc(12.8px * var(--w-ts))}
.w-up .hd .d{font-size:calc(10.6px * var(--w-ts));opacity:.6;margin-top:1px}
.w-up .hd .m{margin-left:auto;text-align:right;font-weight:800;font-size:calc(13px * var(--w-ts));
  white-space:nowrap;font-variant-numeric:tabular-nums}
.w-up .hd .m small{display:block;font-weight:700;font-size:calc(9.4px * var(--w-ts));opacity:.6}
.w-up .eff{margin-top:calc(9px * var(--w-ts));display:flex;flex-direction:column;
  gap:calc(6px * var(--w-ts))}
.w-up .eff .row{display:flex;gap:calc(8px * var(--w-ts));align-items:flex-start;
  padding:calc(7px * var(--w-ts)) calc(9px * var(--w-ts));border-radius:calc(10px * var(--w-ts));
  background:${rgba(BRAND.ink, 0.045)};color:${rgba(BRAND.ink, 0.55)}}
.w-up .eff .row.on{background:${rgba(BRAND.good, 0.11)};color:var(--w-good)}
.w-up .eff .row b{display:block;font-size:calc(11.8px * var(--w-ts));font-weight:800;color:var(--w-ink)}
.w-up .eff .row span{display:block;font-size:calc(10.6px * var(--w-ts));line-height:1.42;
  font-weight:600;color:${rgba(BRAND.ink, 0.62)};margin-top:1px}
.w-up .eff .row .w-i{margin-top:calc(2px * var(--w-ts));flex:none}

/* ---------- the race: route, splits, and the two clocks ---------- */
.w-route{display:flex;flex-direction:column;gap:calc(4px * var(--w-ts))}
.w-route .leg{display:flex;align-items:center;gap:calc(9px * var(--w-ts));
  padding:calc(7px * var(--w-ts)) calc(10px * var(--w-ts));border-radius:calc(10px * var(--w-ts));
  background:${rgba(BRAND.ink, 0.045)};font-size:calc(11.6px * var(--w-ts));font-weight:700}
.w-route .leg.done{background:${rgba(BRAND.good, 0.12)}}
.w-route .leg.lost{background:${rgba(BRAND.bad, 0.10)}}
.w-route .leg .n{min-width:calc(44px * var(--w-ts));font-size:calc(9px * var(--w-ts));
  letter-spacing:.14em;font-weight:800;opacity:.5;text-transform:uppercase}
.w-route .leg .p{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.w-route .leg .m{font-variant-numeric:tabular-nums;opacity:.66;font-weight:800}
.w-versus{display:flex;align-items:stretch;gap:calc(8px * var(--w-ts));margin-bottom:calc(10px * var(--w-ts))}
.w-versus .side{flex:1 1 0;min-width:0;text-align:center;padding:calc(11px * var(--w-ts)) calc(8px * var(--w-ts));
  border-radius:calc(14px * var(--w-ts));background:${rgba(BRAND.ink, 0.05)}}
.w-versus .side.win{background:${rgba(BRAND.good, 0.14)};box-shadow:inset 0 0 0 1.4px ${rgba(BRAND.good, 0.34)}}
.w-versus .side .k{display:block;font-size:calc(9px * var(--w-ts));letter-spacing:.16em;
  text-transform:uppercase;font-weight:800;opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.w-versus .side b{display:block;font-size:calc(25px * var(--w-ts));font-weight:800;letter-spacing:-.02em;
  font-variant-numeric:tabular-nums;line-height:1.1;margin-top:2px}
.w-versus .side .d{display:block;font-size:calc(9.6px * var(--w-ts));font-weight:700;opacity:.55;margin-top:2px}
.w-versus .gap{display:flex;flex-direction:column;align-items:center;justify-content:center;
  min-width:calc(58px * var(--w-ts))}
.w-versus .gap b{font-size:calc(16px * var(--w-ts));font-weight:800;font-variant-numeric:tabular-nums}
.w-versus .gap span{font-size:calc(8.6px * var(--w-ts));letter-spacing:.12em;text-transform:uppercase;
  font-weight:800;opacity:.5}

/* ---------- WallyNet: the title, and the ladder under it ---------- */
.w-title{
  padding:calc(14px * var(--w-ts));border-radius:calc(18px * var(--w-ts));
  background:linear-gradient(150deg,${rgba(BRAND.token, 0.26)},${rgba(0xffffff, 0.70)} 74%);
  box-shadow:inset 0 0 0 1.3px ${rgba(BRAND.token, 0.34)},0 4px 14px ${rgba(BRAND.token2, 0.12)};
  margin-bottom:calc(9px * var(--w-ts));position:relative;
}
.w-title .rung{font-size:calc(9px * var(--w-ts));letter-spacing:.18em;text-transform:uppercase;
  font-weight:800;color:${rgba(BRAND.ink, 0.5)}}
.w-title .nm{font-size:calc(21px * var(--w-ts));font-weight:800;letter-spacing:-.015em;
  line-height:1.14;margin-top:calc(3px * var(--w-ts));color:var(--w-token2)}
.w-title .ds{font-size:calc(11.4px * var(--w-ts));line-height:1.46;font-weight:600;
  opacity:.72;margin-top:calc(4px * var(--w-ts))}
.w-title .fig{position:absolute;top:calc(12px * var(--w-ts));right:calc(14px * var(--w-ts));text-align:right}
.w-title .fig b{display:block;font-size:calc(28px * var(--w-ts));font-weight:800;letter-spacing:-.03em;
  line-height:1;font-variant-numeric:tabular-nums}
.w-title .fig span{display:block;font-size:calc(8.4px * var(--w-ts));letter-spacing:.14em;
  text-transform:uppercase;font-weight:800;opacity:.5}
.w-title .nx{display:flex;align-items:baseline;flex-wrap:wrap;gap:calc(5px * var(--w-ts));
  margin-top:calc(7px * var(--w-ts));font-size:calc(11px * var(--w-ts));font-weight:700;opacity:.8}
.w-title .nx b{font-weight:800;color:var(--w-token2)}
.w-title .nx .at{opacity:.55;font-weight:700}
.w-titlebar{height:calc(7px * var(--w-ts));border-radius:999px;margin-top:calc(10px * var(--w-ts));
  background:${rgba(BRAND.ink, 0.14)};overflow:hidden}
.w-titlebar i{display:block;height:100%;border-radius:999px;
  background:linear-gradient(90deg,var(--w-token),var(--w-token2));
  transition:width .6s cubic-bezier(.22,1,.36,1)}
.w-ladder{display:flex;flex-direction:column;gap:calc(3px * var(--w-ts))}
.w-ladder .rw{display:flex;align-items:center;gap:calc(8px * var(--w-ts));
  padding:calc(6px * var(--w-ts)) calc(10px * var(--w-ts));border-radius:calc(9px * var(--w-ts));
  font-size:calc(11.4px * var(--w-ts));font-weight:700;opacity:.5}
.w-ladder .rw.on{opacity:1;background:${rgba(BRAND.token, 0.10)}}
.w-ladder .rw.now{background:${rgba(BRAND.token, 0.22)};box-shadow:inset 0 0 0 1.3px ${rgba(BRAND.token, 0.40)}}
.w-ladder .rw .d{display:grid;place-items:center;flex:none;color:var(--w-token2)}
.w-ladder .rw .t{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.w-ladder .rw .r{font-variant-numeric:tabular-nums;font-weight:800;opacity:.6}

/* ---------- accessibility modes ---------- */
.w-hc .w-chrome,.w-hc .w-pill,.w-hc .w-obj,.w-hc .w-toast,.w-hc .w-prompt,.w-hc .w-banner,.w-hc .w-hint{
  background:${rgba(0x05070c, 0.94)} !important;border-color:${rgba(BRAND.paper, 0.42)} !important;
  -webkit-backdrop-filter:none !important;backdrop-filter:none !important;
}
.w-hc{--w-dim:${rgba(BRAND.text, 0.9)};--w-dim2:${rgba(BRAND.text, 0.72)}}
.w-hc .w-hint{opacity:1 !important;color:var(--w-text) !important}
.w-hc .w-dlg-more{opacity:1}
.w-hc.w-root.w-dlg-open .w-pills,.w-hc.w-root.w-dlg-open .w-hints,
.w-hc.w-root.w-dlg-open .w-toasts,.w-hc.w-root.w-dlg-open .w-obj{opacity:.62}
.w-hc .w-paper,.w-hc .w-screen{background:#fff !important}
.w-hc .w-card{background:#fff;box-shadow:inset 0 0 0 1.6px ${rgba(BRAND.ink, 0.5)}}
.w-rm *,.w-rm *:before,.w-rm *:after{animation-duration:.001s !important;animation-iteration-count:1 !important;
  transition-duration:.001s !important}
/* the chip is animation-only; with motion off it would sit there
   invisible and still take up width in the pill */
.w-rm .w-delta{display:none !important}
@media (prefers-reduced-motion:reduce){
  .w-root *,.w-root *:before,.w-root *:after{animation-duration:.001s !important;transition-duration:.02s !important}
  .w-delta{display:none !important}
}
@media (max-width:720px){
  .w-bar{max-width:62vw}
  .w-obj{max-width:min(360px,66vw)}
  .w-hints{max-width:44vw}
  .w-dlg-tx{font-size:calc(14px * var(--w-ts))}
}
/* ---------- phone ----------
   At 390 px the two stat clusters are 62 vw each and interleave across
   the top of the frame. Shrink the pills, shorten the meters and give
   each side under half the width, so the left column reads as a column,
   the right one as a column, and there is a gutter between them. */
@media (max-width:720px){
  /* the right cluster becomes a column here, so the race box drops
     below both of them and takes the full width instead */
  .w-race{top:calc(96px * var(--w-ts));width:min(430px,90vw)}
}
@media (max-width:480px){
  .w-race{top:calc(116px * var(--w-ts));width:92vw}
  .w-bar{max-width:49vw;gap:calc(5px * var(--w-ts))}
  .w-bar.left .w-pills{max-width:49vw}
  .w-bar.right{flex-direction:column;align-items:flex-end}
  .w-bar.right .w-pills{justify-content:flex-end}
  .w-pill{height:calc(27px * var(--w-ts));padding:0 calc(8px * var(--w-ts));
    gap:calc(5px * var(--w-ts));font-size:calc(11.5px * var(--w-ts))}
  .w-meter{width:calc(42px * var(--w-ts))}
  /* THE STRIP IS THE POINTER, so on a phone it gets the width the
     floating pointer used to be squeezed out of: 82vw of the left
     column, a smaller dial, tighter padding. Nothing sits beside it. */
  .w-obj{max-width:min(320px,82vw);padding:calc(6px * var(--w-ts)) calc(10px * var(--w-ts))
    calc(6px * var(--w-ts)) calc(6px * var(--w-ts));gap:calc(8px * var(--w-ts))}
  .w-obj .t{font-size:calc(12px * var(--w-ts))}
  .w-obj .dial{width:calc(30px * var(--w-ts));height:calc(30px * var(--w-ts))}
  .w-toasts{max-width:74vw}
  .w-tkt{padding-left:calc(17px * var(--w-ts))}
  .w-qty .n{min-width:calc(44px * var(--w-ts));font-size:calc(17px * var(--w-ts))}
}
@media (max-height:560px){
  .w-banner{top:8vh}
  .w-phone{height:94vh}
}

/* ============================================================
   THE NOTIFICATION LAYER — ui/notify.js

   z-index 25: ABOVE #overlay (20) — the scrim, every sheet, the
   phone and the dialogue card — and BELOW the film grain (30) and
   vignette (31), so a notification is still inside the colour grade
   rather than pasted on top of it (§3.8). It is parented to <body>,
   not to #ui, precisely so the modal stack cannot reach it.

   THREE DOCKS, each chosen to miss the furniture:
     corner  bottom-left, where toasts have always lived. Pills and
             the objective strip are top-left, the key hints are
             bottom-right, the dialogue is bottom-centre.
     strip   top-left under the objective strip, whose height
             touch.js measures into --w-toasty. Used on touch,
             because bottom-left is the thumbstick.
     top     top-centre, whenever a panel or a dialogue is open. A
             sheet is centred and at most 84vh / a phone is 90vh, so
             this band is the one strip of screen they cannot reach.
   ============================================================ */
.w-notify{
  position:fixed;inset:0;z-index:25;pointer-events:none;
  display:flex;flex-direction:column;
}
.w-notes{
  position:absolute;display:flex;gap:calc(7px * var(--w-ts));
  align-items:flex-start;
}
/* the resting dock: bottom-left, newest nearest the corner */
.w-notify.dock-corner .w-notes{
  left:max(12px,env(safe-area-inset-left));
  bottom:calc(max(12px,env(safe-area-inset-bottom)) + 10px);
  flex-direction:column-reverse;max-width:min(380px,58vw);
}

/* touch: under the objective strip, whose bottom touch.js measures */
.w-notify.dock-strip .w-notes{
  left:max(12px,env(safe-area-inset-left));
  top:var(--w-toasty,calc(max(12px,env(safe-area-inset-top)) + 96px));
  flex-direction:column;max-width:min(330px,74vw);
}
/* a panel is open: the band above it */
.w-notify.dock-top .w-notes{
  left:50%;transform:translateX(-50%);
  top:calc(max(10px,env(safe-area-inset-top)) + 4px);
  flex-direction:column;align-items:center;
  width:min(430px,92vw);
}
.w-notify.dock-top .w-note.tier-ach{width:100%;max-width:none}
/* the queue depth, so a backlog is a number and not a wall of cards */
.w-morechip{
  flex:none;align-self:center;pointer-events:none;
  padding:calc(2px * var(--w-ts)) calc(9px * var(--w-ts));border-radius:999px;
  font-size:calc(9.4px * var(--w-ts));font-weight:800;letter-spacing:.14em;
  text-transform:uppercase;color:${rgba(BRAND.text, 0.62)};
  background:${rgba(BRAND.ink, 0.62)};border:1px solid var(--w-line);
  -webkit-backdrop-filter:var(--w-blur);backdrop-filter:var(--w-blur);
}

/* ---------- tier 1: the routine toast ---------- */
.w-note{position:relative;pointer-events:none}
.w-note.tier-toast{
  display:flex;align-items:center;gap:calc(9px * var(--w-ts));
  padding:calc(7px * var(--w-ts)) calc(14px * var(--w-ts));border-radius:999px;
  ${G('var(--w-chrome)')}
  -webkit-backdrop-filter:var(--w-blur);backdrop-filter:var(--w-blur);
  border:1px solid var(--w-line);box-shadow:var(--w-shadow),var(--w-inset);
  font-size:calc(12px * var(--w-ts));font-weight:600;
  animation:wNoteIn .42s var(--w-ease) both;
}
.w-note.tier-toast .bul{width:calc(6px * var(--w-ts));height:calc(6px * var(--w-ts));
  border-radius:99px;flex:none}
.w-note.tier-toast .tx{min-width:0}

/* ---------- tier 2: the achievement ----------
   An achievement is not a louder toast, it is a different object: a
   plaque. Gold medallion, an eyebrow naming what KIND of thing was
   won, a heavy title, a token-gold rail down the left edge, a single
   shine that crosses it once on arrival, and a hairline clock along
   the bottom that visibly STOPS when the layer is held. Twice the
   ink, twice the dwell, and no chance of being read as a receipt. */
.w-note.tier-ach{
  display:flex;align-items:center;gap:calc(11px * var(--w-ts));
  min-width:calc(250px * var(--w-ts));max-width:min(430px,92vw);
  padding:calc(10px * var(--w-ts)) calc(15px * var(--w-ts)) calc(11px * var(--w-ts))
          calc(11px * var(--w-ts));
  border-radius:calc(15px * var(--w-ts));overflow:hidden;
  ${G('var(--w-chrome)')}
  -webkit-backdrop-filter:var(--w-blur);backdrop-filter:var(--w-blur);
  border:1px solid ${rgba(BRAND.token, 0.30)};
  border-left:calc(3px * var(--w-ts)) solid var(--nc,var(--w-token));
  box-shadow:var(--w-shadow),var(--w-inset),0 0 34px ${rgba(BRAND.token, 0.16)};
  animation:wAchIn .62s var(--w-ease) both;
}
.w-note.tier-ach .medal{
  flex:none;width:calc(36px * var(--w-ts));height:calc(36px * var(--w-ts));
  border-radius:50%;display:grid;place-items:center;
}
.w-note.tier-ach .eb{
  font-size:calc(9.2px * var(--w-ts));font-weight:800;letter-spacing:.19em;
  text-transform:uppercase;opacity:.95;
}
.w-note.tier-ach .ti{
  font-size:calc(13.5px * var(--w-ts));font-weight:800;line-height:1.25;
  margin-top:calc(1px * var(--w-ts));
}
.w-note.tier-ach .sb{
  font-size:calc(10.6px * var(--w-ts));color:var(--w-dim);font-weight:600;
  margin-top:calc(1px * var(--w-ts));line-height:1.3;
}
/* the dismissal clock, drawn */
.w-note.tier-ach .bar{
  position:absolute;left:0;right:0;bottom:0;height:calc(2.6px * var(--w-ts));
  background:linear-gradient(90deg,var(--nc,var(--w-token)),${rgba(BRAND.token, 0.45)});
  box-shadow:0 0 10px ${rgba(BRAND.token, 0.55)};
  transform-origin:0 50%;transform:scaleX(1);opacity:1;
}
/* one pass of light, once, on arrival */
.w-note.tier-ach .sheen{
  position:absolute;top:0;bottom:0;width:46%;left:-60%;pointer-events:none;
  background:linear-gradient(100deg,transparent,${rgba(BRAND.paper, 0.16)},transparent);
  animation:wAchSheen 1.5s cubic-bezier(.4,0,.4,1) .38s 1 both;
}
.w-note.out{animation:wNoteOut .32s var(--w-ease) both}
/* HELD: the layer is not being looked at (curtain down, cinematic,
   background tab, the ending playing). The clock stops and the
   plaque says so rather than pretending. */
.w-notify.held .w-note.tier-ach .bar{opacity:.34}
.w-notify.hushed{opacity:0;transition:opacity .3s var(--w-ease)}

@keyframes wNoteIn{from{opacity:0;transform:translateX(-14px) scale(.96)}to{opacity:1;transform:none}}
@keyframes wNoteOut{to{opacity:0;transform:translateX(-10px) scale(.97)}}
@keyframes wAchIn{
  0%{opacity:0;transform:translateY(-16px) scale(.9)}
  62%{opacity:1;transform:translateY(0) scale(1.025)}
  100%{opacity:1;transform:none}}
@keyframes wAchSheen{from{left:-60%}to{left:130%}}
/* the top dock drops in from above instead of sliding in from the left */
.w-notify.dock-top .w-note.tier-toast{animation-name:wNoteDrop}
@keyframes wNoteDrop{from{opacity:0;transform:translateY(-12px) scale(.97)}to{opacity:1;transform:none}}
.w-rm .w-note,.w-notify.w-rm .w-note{animation-duration:.01s !important}

@media (max-width:480px){
  .w-note.tier-ach{min-width:0;width:100%;
    padding:calc(9px * var(--w-ts)) calc(12px * var(--w-ts))}
  .w-note.tier-ach .ti{font-size:calc(12.6px * var(--w-ts))}
  .w-notify.dock-corner .w-notes{max-width:76vw}
}

/* ============================================================
   THE ENDING — ui/ending.js

   z-index 28: above the notification layer, still under the grain.
   The interface is faded out underneath it, so this is the only
   thing on the screen.
   ============================================================ */
.w-endroot{
  position:fixed;inset:0;z-index:28;pointer-events:none;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:calc(16px * var(--w-ts));padding:3vh 4vw;
  font-family:var(--w-font);color:var(--w-text);
  font-size:calc(14px * var(--w-ts));
}
.w-endroot.out{animation:wEndOut .46s var(--w-ease) both}
@keyframes wEndOut{to{opacity:0}}
/* the wash. Not opaque — the city stays faintly readable behind it,
   which is the whole point of ending IN the place you built. */
.w-endsky{
  position:absolute;inset:0;
  background:radial-gradient(128% 96% at 50% 42%,
    ${rgba(mix(BRAND.ink, BRAND.token2, 0.20), 0.62)} 0%,
    ${rgba(BRAND.ink, 0.88)} 62%, ${rgba(0x05070c, 0.96)} 100%);
  -webkit-backdrop-filter:blur(7px) saturate(112%);backdrop-filter:blur(7px) saturate(112%);
  animation:wEndSky 1.1s var(--w-ease) both;
}
@keyframes wEndSky{from{opacity:0}to{opacity:1}}
.w-endbloom{
  position:absolute;left:50%;top:44%;width:min(1100px,150vw);height:min(1100px,150vw);
  transform:translate(-50%,-50%);pointer-events:none;
  background:radial-gradient(circle at 50% 50%,${rgba(BRAND.token, 0.24)} 0%,
    ${rgba(BRAND.token, 0.09)} 34%,transparent 66%);
  animation:wEndBloom 2.6s var(--w-ease) .16s both;
}
@keyframes wEndBloom{from{opacity:0;transform:translate(-50%,-50%) scale(.72)}
  to{opacity:1;transform:translate(-50%,-50%) scale(1)}}
.w-endmotes{position:absolute;inset:0;overflow:hidden}
.w-endmotes i{
  position:absolute;border-radius:50%;
  background:radial-gradient(circle at 40% 36%,${rgba(0xffe9c4, 0.95)},${rgba(BRAND.token, 0)} 68%);
  animation:wEndMote 13s linear infinite;opacity:0;
}
@keyframes wEndMote{
  0%{opacity:0;transform:translateY(26px) scale(.7)}
  16%{opacity:.85}
  76%{opacity:.5}
  100%{opacity:0;transform:translateY(-120px) scale(1.15)}}

.w-endhead{position:relative;text-align:center}
.w-endhead .eb{
  font-size:calc(10.4px * var(--w-ts));font-weight:800;letter-spacing:.34em;
  text-transform:uppercase;color:${rgba(BRAND.text, 0.55)};
  animation:wEndRise .8s var(--w-ease) .34s both;
}
.w-endhead .big{
  display:flex;justify-content:center;gap:calc(2px * var(--w-ts));
  margin:calc(7px * var(--w-ts)) 0 calc(9px * var(--w-ts));
}
.w-endhead .big span{
  font-size:calc(40px * var(--w-ts));font-weight:800;letter-spacing:.20em;
  background:linear-gradient(178deg,${C(mix(BRAND.token, 0xffffff, 0.42))},var(--w-token) 52%,var(--w-token2));
  -webkit-background-clip:text;background-clip:text;color:transparent;
  filter:drop-shadow(0 3px 16px ${rgba(BRAND.token, 0.42)});
  animation:wEndLetter .74s var(--w-ease) both;
}
.w-endhead .tal{
  font-size:calc(11.4px * var(--w-ts));font-weight:700;letter-spacing:.03em;
  color:${rgba(BRAND.text, 0.66)};font-variant-numeric:tabular-nums;
  animation:wEndRise .8s var(--w-ease) 1.55s both;
}
@keyframes wEndLetter{from{opacity:0;transform:translateY(18px) scale(.86)}to{opacity:1;transform:none}}
@keyframes wEndRise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}

.w-endcard{
  position:relative;display:flex;flex-direction:column;align-items:center;
  gap:calc(15px * var(--w-ts));width:min(660px,94vw);
}
.w-endpaper{
  width:100%;border-radius:calc(24px * var(--w-ts));color:var(--w-ink);
  padding:calc(19px * var(--w-ts)) calc(22px * var(--w-ts)) calc(20px * var(--w-ts));
  border:1px solid ${rgba(BRAND.token, 0.36)};
  box-shadow:0 30px 80px ${rgba(0x05070c, 0.6)},var(--w-inset),
             0 0 60px ${rgba(BRAND.token, 0.16)};
  animation:wEndCard .9s var(--w-ease) .82s both;
}
@keyframes wEndCard{from{opacity:0;transform:translateY(26px) scale(.965)}to{opacity:1;transform:none}}
.w-endwho{display:flex;align-items:center;gap:calc(14px * var(--w-ts));
  padding-bottom:calc(13px * var(--w-ts));
  border-bottom:1px solid ${rgba(BRAND.ink, 0.12)}}
.w-endpor{position:relative;flex:none;animation:wEndRise .7s var(--w-ease) 1.05s both}
.w-endpor>*{border-radius:99px;
  box-shadow:0 8px 22px ${rgba(0x05070c, 0.34)},0 0 0 3px ${rgba(BRAND.token, 0.55)},
             0 0 0 6px ${rgba(0xffffff, 0.45)}}
.w-endwho .nm{font-size:calc(17px * var(--w-ts));font-weight:800;letter-spacing:.13em;
  text-transform:uppercase;color:var(--w-token2)}
.w-endwho .rl{font-size:calc(11.6px * var(--w-ts));font-weight:700;opacity:.6;margin-top:1px}
.w-endwho .seal{flex:none;width:calc(38px * var(--w-ts));height:calc(38px * var(--w-ts));
  border-radius:50%;display:grid;place-items:center;color:var(--w-token2);
  background:radial-gradient(circle at 50% 34%,${rgba(BRAND.token, 0.34)},${rgba(BRAND.token, 0.10)});
  box-shadow:inset 0 0 0 1.6px ${rgba(BRAND.token2, 0.5)}}
.w-endtx{
  margin:calc(14px * var(--w-ts)) 0 0;
  font-size:calc(16.4px * var(--w-ts));line-height:1.62;font-weight:600;
  letter-spacing:.002em;
  animation:wEndRise .8s var(--w-ease) 1.3s both;
}
/* THE TWO LINKS, INSIDE THE SENTENCE. Token gold, underlined with a
   real offset, and an external-link glyph after them through CSS so
   the anchor's textContent stays the user's line to the character. */
.w-endlink{
  color:var(--w-token2);font-weight:800;text-decoration:underline;
  text-decoration-thickness:calc(2px * var(--w-ts));text-underline-offset:3px;
  text-decoration-color:${rgba(BRAND.token, 0.6)};
  border-radius:4px;padding:0 1px;
  transition:color .16s,background .16s,text-decoration-color .16s;
}
.w-endlink:after{content:'↗';font-size:.8em;font-weight:800;
  margin-left:1px;vertical-align:.08em;opacity:.8}
.w-endlink:hover{color:${C(BRAND.token)};background:${rgba(BRAND.token, 0.14)};
  text-decoration-color:${C(BRAND.token)}}
.w-endlinks{display:flex;gap:calc(10px * var(--w-ts));flex-wrap:wrap;
  margin-top:calc(17px * var(--w-ts));
  animation:wEndRise .8s var(--w-ease) 1.75s both}
.w-endbtn{
  flex:1 1 calc(46% - 10px);min-width:calc(190px * var(--w-ts));
  display:flex;align-items:center;gap:calc(11px * var(--w-ts));
  padding:calc(11px * var(--w-ts)) calc(14px * var(--w-ts));
  border-radius:calc(14px * var(--w-ts));text-decoration:none;color:${C(BRAND.ink)};
  background:linear-gradient(180deg,var(--w-token),var(--w-token2));
  box-shadow:0 3px 0 ${rgba(BRAND.token2, 0.8)},0 8px 22px ${rgba(BRAND.token, 0.34)};
  transition:transform .15s var(--w-ease),filter .15s,box-shadow .15s;
}
.w-endbtn:hover{filter:brightness(1.06)}
.w-endbtn:active{transform:translateY(2px);box-shadow:0 1px 0 ${rgba(BRAND.token2, 0.8)}}
.w-endbtn .ic{flex:none;width:calc(30px * var(--w-ts));height:calc(30px * var(--w-ts));
  border-radius:calc(9px * var(--w-ts));display:grid;place-items:center;
  background:${rgba(0xffffff, 0.34)}}
.w-endbtn .t{display:block;font-size:calc(14px * var(--w-ts));font-weight:800;letter-spacing:.01em}
.w-endbtn .d{display:block;font-size:calc(10.6px * var(--w-ts));font-weight:700;opacity:.72}
.w-endclose{
  color:var(--w-text);
  min-height:calc(42px * var(--w-ts));padding:0 calc(24px * var(--w-ts));
  letter-spacing:.04em;
  box-shadow:inset 0 0 0 1.6px ${rgba(BRAND.paper, 0.34)},0 10px 26px ${rgba(0x05070c, 0.42)};
  background:${rgba(BRAND.ink, 0.62)};
  -webkit-backdrop-filter:var(--w-blur);backdrop-filter:var(--w-blur);
  animation:wEndRise .8s var(--w-ease) 2.1s both;
}
.w-endclose:hover{background:${rgba(BRAND.ink, 0.82)};
  box-shadow:inset 0 0 0 1.6px ${rgba(BRAND.token, 0.5)},0 10px 26px ${rgba(0x05070c, 0.42)}}

@media (max-width:480px){
  .w-endroot{gap:calc(11px * var(--w-ts));padding:2vh 3vw}
  .w-endhead .big span{font-size:calc(27px * var(--w-ts));letter-spacing:.14em}
  .w-endhead .tal{font-size:calc(10.2px * var(--w-ts))}
  .w-endpaper{padding:calc(15px * var(--w-ts)) calc(15px * var(--w-ts)) calc(16px * var(--w-ts));
    border-radius:calc(19px * var(--w-ts))}
  .w-endtx{font-size:calc(14.2px * var(--w-ts));line-height:1.56}
  .w-endbtn{flex:1 1 100%;min-width:0;padding:calc(10px * var(--w-ts)) calc(12px * var(--w-ts))}
  .w-endwho .nm{font-size:calc(15px * var(--w-ts))}
}
@media (max-height:700px){
  .w-endhead .big{margin:calc(4px * var(--w-ts)) 0 calc(6px * var(--w-ts))}
  .w-endtx{margin-top:calc(11px * var(--w-ts))}
}

/* ============================================================
   LANDSCAPE PLAY — THE SHORT, WIDE PHONE            ui/orient.js

   The optional setting is worthless if the game does not play well
   sideways, so this block is the larger half of that feature. It is
   NOT the portrait layout scaled down. A landscape phone is about
   390 css px tall, held in two hands, and:

     · the vertical axis is the scarce one. Anything that stacked
       happily down a 844 px column has to stop stacking. The left
       pill cluster was three rows deep, which pushed the objective
       strip to the vertical middle of the frame and parked it
       across Wally's face — measured, not guessed.
     · both thumbs are at the BOTTOM CORNERS and nowhere else. The
       stick and the pad move OUTWARD into them and shrink; the pad
       stops being a column climbing a third of the way up the
       screen and becomes one band along the bottom edge.
     · the notch and the home indicator are on the LEFT and RIGHT.
       env(safe-area-inset-top/bottom) are ~0 here and the two that
       matter are the ones every rule below reaches for.
     · a phone-shaped panel in a short viewport is not a squeeze
       problem, it is a different panel. The phone becomes a wide
       slab with a five-across app grid; the pause menu becomes two
       columns; sheets take the height back from their margins.

   THE TRIGGER IS THE VIEWPORT, NEVER THE SETTING. A player on iOS
   Safari — where no page may rotate anything — turns the phone by
   hand and lands in exactly this layout, which is the only thing
   that makes the settings row's advice honest.
   ============================================================ */
@media (orientation:landscape) and (max-height:540px){
  /* ---------- the top bars: two rows, not three ---------- */
  .w-bar{top:max(9px,env(safe-area-inset-top));max-width:52vw}
  .w-bar.left{left:max(12px,env(safe-area-inset-left))}
  .w-bar.right{right:max(12px,env(safe-area-inset-right))}
  .w-pills{max-width:52vw}
  .w-bar.right .w-pills{max-width:44vw;justify-content:flex-end}
  .w-pill{height:calc(27px * var(--w-ts));padding:0 calc(9px * var(--w-ts));
    gap:calc(5px * var(--w-ts));font-size:calc(11.5px * var(--w-ts))}
  .w-pill.money .w-num{font-size:calc(12.6px * var(--w-ts))}
  .w-pill .w-mnum{font-size:calc(11.6px * var(--w-ts))}
  .w-meter{width:calc(44px * var(--w-ts))}
  /* the rep title is the widest optional thing on the right and the
     one that can afford to ellipsise soonest */
  .w-pill.rep .ttl{max-width:calc(92px * var(--w-ts))}
  /* THE OBJECTIVE STRIP HAS TO CLEAR HIS HEAD. It rides up with the
     row the pills gave back, on a smaller dial. */
  .w-obj{margin-top:calc(5px * var(--w-ts));max-width:min(340px,44vw);
    padding:calc(5px * var(--w-ts)) calc(11px * var(--w-ts)) calc(5px * var(--w-ts)) calc(5px * var(--w-ts))}
  .w-obj .t{font-size:calc(12px * var(--w-ts))}
  .w-obj .d,.w-obj .why{font-size:calc(9.8px * var(--w-ts))}
  .w-obj .dial{width:calc(28px * var(--w-ts));height:calc(28px * var(--w-ts))}
  .w-lock{max-width:min(380px,44vw);margin-top:calc(5px * var(--w-ts))}
  .w-race{top:calc(44px * var(--w-ts));width:min(420px,46vw)}
  .w-banner{top:6vh;padding:calc(10px * var(--w-ts)) calc(24px * var(--w-ts))}
  .w-banner .t{font-size:calc(17px * var(--w-ts))}

  /* ---------- both thumbs, both bottom corners ---------- */
  /* A SMALLER ZONE IS A SMALLER STICK: touch.js sizes the ring from
     this box's shorter side, so capping the height is what stops a
     151 px ring eating 39% of a 390 px screen. */
  .w-stickzone{width:min(34vw,240px);height:min(74vh,180px);
    padding:0 0 max(10px,env(safe-area-inset-bottom)) max(14px,env(safe-area-inset-left))}
  /* THE PAD LIES DOWN. Four shortcuts, interact and jump in ONE row
     along the bottom edge instead of a column climbing 150 px up a
     390 px screen — and it hugs the corner, because that is where
     the right thumb already is. */
  .w-acts{flex-direction:row;align-items:flex-end;gap:calc(13px * var(--w-ts));
    right:max(14px,env(safe-area-inset-right));
    bottom:calc(max(9px,env(safe-area-inset-bottom)) + 15px)}
  .w-touch .w-abtn.mid{margin-bottom:14px}
  .w-hints{max-width:44vw;right:max(14px,env(safe-area-inset-right));
    bottom:calc(max(9px,env(safe-area-inset-bottom)) + 8px)}
  .w-toasts{max-width:min(300px,40vw);left:max(12px,env(safe-area-inset-left))}
  .w-touch-on .w-toasts{max-width:min(300px,40vw)}
  .w-notify.dock-corner .w-notes,.w-notify.dock-strip .w-notes{
    left:max(12px,env(safe-area-inset-left));max-width:min(300px,40vw)}
  .w-notify.dock-top .w-notes{width:min(430px,54vw)}

  /* ---------- panels: buy the height back ---------- */
  .w-panels{padding:1.5vh 2.5vw;
    padding-left:max(2.5vw,env(safe-area-inset-left));
    padding-right:max(2.5vw,env(safe-area-inset-right))}
  .w-sheet{width:min(560px,74vw);max-height:94vh;border-radius:calc(18px * var(--w-ts))}
  .w-sheet-head{padding:calc(9px * var(--w-ts)) calc(14px * var(--w-ts))}
  .w-sheet-head h2{font-size:calc(15px * var(--w-ts))}
  .w-sheet-body{padding:calc(10px * var(--w-ts)) calc(14px * var(--w-ts)) calc(13px * var(--w-ts))}
  .w-label{margin:calc(10px * var(--w-ts)) 0 calc(5px * var(--w-ts))}
  /* the pause menu is a list of six one-line buttons — in landscape
     that list is two columns, or it scrolls for no reason */
  .w-pause{width:min(520px,70vw);max-height:94vh;overflow-y:auto;
    display:grid;grid-template-columns:1fr 1fr;align-content:start;
    gap:calc(8px * var(--w-ts));padding:calc(14px * var(--w-ts)) calc(17px * var(--w-ts))}
  .w-pause>.brand{grid-column:1 / -1;flex-direction:row;justify-content:center;
    align-items:center;gap:calc(13px * var(--w-ts));margin-bottom:0}
  .w-pause>.brand .wm{font-size:calc(21px * var(--w-ts))}
  .w-pause>.brand+div{grid-column:1 / -1;margin:0 !important}

  /* ---------- the phone stops being a phone shape ---------- */
  .w-phone{width:min(660px,84vw);height:min(560px,94vh);
    border-radius:calc(26px * var(--w-ts));padding:calc(7px * var(--w-ts))}
  .w-screen{border-radius:calc(20px * var(--w-ts))}
  .w-status{padding:calc(7px * var(--w-ts)) calc(20px * var(--w-ts)) calc(3px * var(--w-ts))}
  .w-appbar{padding:calc(1px * var(--w-ts)) calc(15px * var(--w-ts)) calc(4px * var(--w-ts));
    min-height:calc(24px * var(--w-ts))}
  .w-apps{grid-template-columns:repeat(5,1fr);gap:calc(9px * var(--w-ts))}
  .w-app .tile{width:calc(50px * var(--w-ts));height:calc(50px * var(--w-ts));
    border-radius:calc(15px * var(--w-ts))}
  .w-home-ind{height:calc(11px * var(--w-ts))}

  /* ---------- dialogue: clear of both thumbs ---------- */
  .w-dlg{width:min(600px,76vw);
    bottom:calc(max(10px,env(safe-area-inset-bottom)) + 8px)}
  .w-dlg-in{gap:calc(12px * var(--w-ts));
    padding:calc(11px * var(--w-ts)) calc(16px * var(--w-ts)) calc(10px * var(--w-ts))}
  .w-dlg-por{width:calc(52px * var(--w-ts));height:calc(52px * var(--w-ts))}
  .w-dlg-tx{font-size:calc(14px * var(--w-ts));line-height:1.44;margin-top:calc(4px * var(--w-ts))}
  .w-dlg-ch{padding:0 calc(16px * var(--w-ts)) calc(11px * var(--w-ts))}
  .w-dlg-more{padding:0 calc(16px * var(--w-ts)) calc(10px * var(--w-ts))}
  /* WITH THE PAD UP, THE CARD LIFTS OFF THE FLOOR. Bottom-centre is
     the floor, and in landscape the floor is a thumbstick on the
     left and an action row on the right. The card clears the tallest
     of them (the interact button, 95 px up) and narrows so its ends
     stay inside them; it stays CENTRED, because a dialogue that
     slides sideways when the controls appear reads as a bug. */
  .w-touch-on .w-dlg{width:min(560px,62vw);
    bottom:calc(max(9px,env(safe-area-inset-bottom)) + 104px)}

  /* ---------- the ending ---------- */
  .w-endroot{gap:calc(9px * var(--w-ts));padding:2vh 4vw}
  .w-endhead .big span{font-size:calc(26px * var(--w-ts))}
  .w-endcard{gap:calc(10px * var(--w-ts));width:min(660px,80vw)}
  .w-endpaper{padding:calc(13px * var(--w-ts)) calc(18px * var(--w-ts)) calc(14px * var(--w-ts))}
  .w-endtx{font-size:calc(13.6px * var(--w-ts));line-height:1.5;margin-top:calc(9px * var(--w-ts))}
  .w-endlinks{margin-top:calc(11px * var(--w-ts))}
}
`;
}

let injected = false;
export function injectStyle() {
  if (injected) return;
  injected = true;
  const s = document.createElement('style');
  s.id = 'wally-ui-style';
  s.textContent = stylesheet();
  document.head.append(s);
}
