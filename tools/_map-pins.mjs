/* _map-pins.mjs — MAP AGENT rig, round 4.

   Measures, at three viewport sizes, for BOTH charts (the phone's
   compact Places chart and the full-map sheet):

     · pin ink discs: overlapping pairs, overlapping px2, and the
       minimum centre-to-centre distance in screen pixels
     · TAPPABILITY: for every pin, hit-test its centre and eight points
       on its own ink disc with document.elementFromPoint and confirm
       every one of them resolves to that pin's own data-loc
     · name-on-name pairs / px2 (the round-3 deconfliction, so we can
       see it has not regressed)
     · the fold: where the selected place card sits vs the viewport

   node tools/_map-pins.mjs [--shots] [--tag=m4]
*/
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};
const srv = createServer(async (rq, rs) => {
  try {
    const c = decodeURIComponent(rq.url.split('?')[0]);
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream', 'cache-control': 'no-store' });
    rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;

const SHOTS = process.argv.includes('--shots');
const TAG = (process.argv.find(a => a.startsWith('--tag=')) || '--tag=m4').slice(6);

/* ---- runs in the page ---- */
const MEASURE = () => {
  const out = [];
  for (const svg of document.querySelectorAll('.w-map svg')) {
    const host = svg.closest('.w-map');
    const hr = host.getBoundingClientRect();
    if (hr.width < 5 || hr.height < 5) continue;
    const st = getComputedStyle(host);
    if (st.display === 'none' || st.visibility === 'hidden') continue;

    /* ---------- pins ---------- */
    const pins = [];
    for (const g of svg.querySelectorAll('g[data-loc]')) {
      const c = g.querySelector('circle.wm-pin');
      if (!c) continue;                       // name groups have no disc
      const r = c.getBoundingClientRect();    // includes the stroke
      if (r.width < 1) continue;
      pins.push({
        id: g.getAttribute('data-loc'),
        cx: r.left + r.width / 2, cy: r.top + r.height / 2,
        rad: r.width / 2,
        x1: r.left, y1: r.top, x2: r.right, y2: r.bottom,
      });
    }
    /* how far each symbol was displaced from the coordinate the world
       gives it, in SCREEN pixels — the honesty check on the nudge */
    const ctm = svg.getScreenCTM();
    const locs = window.WALLY.ctx.game.data.locationById;
    let maxShift = 0, sumShift = 0;
    for (const p of pins) {
      const L = locs[p.id];
      if (!L || !ctm) continue;
      const tx = ctm.a * L.x + ctm.c * L.y + ctm.e;
      const ty = ctm.b * L.x + ctm.d * L.y + ctm.f;
      const dd = Math.hypot(tx - p.cx, ty - p.cy);
      sumShift += dd; if (dd > maxShift) maxShift = dd;
    }

    /* true disc-on-disc ink, not bounding boxes: two circles whose
       boxes clip at the corner are not touching */
    let discPairs = 0, discArea = 0;
    for (let i = 0; i < pins.length; i++) {
      for (let j = i + 1; j < pins.length; j++) {
        const a = pins[i], b = pins[j];
        const d = Math.hypot(a.cx - b.cx, a.cy - b.cy);
        const r1 = a.rad, r2 = b.rad;
        if (d >= r1 + r2) continue;
        discPairs++;
        if (d <= Math.abs(r1 - r2)) { discArea += Math.PI * Math.min(r1, r2) ** 2; continue; }
        const a1 = Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1));
        const a2 = Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2));
        discArea += r1 * r1 * (a1 - Math.sin(2 * a1) / 2) + r2 * r2 * (a2 - Math.sin(2 * a2) / 2);
      }
    }

    let pp = 0, pa = 0, minD = Infinity, worstPin = [];
    for (let i = 0; i < pins.length; i++) {
      for (let j = i + 1; j < pins.length; j++) {
        const a = pins[i], b = pins[j];
        const d = Math.hypot(a.cx - b.cx, a.cy - b.cy);
        if (d < minD) minD = d;
        const ow = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
        const oh = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
        if (ow > 0 && oh > 0) {
          pp++; pa += ow * oh;
          worstPin.push([a.id, b.id, Math.round(ow * oh), +d.toFixed(1)]);
        }
      }
    }
    worstPin.sort((x, y) => y[2] - x[2]);

    /* ---------- tappability ----------
       the centre, then eight points at 0.62 of the pin's own ink radius
       and eight more at 0.98 of it — the RIM, which is where the
       ink+1 floor on the tap target can lose to a neighbour. Every
       probe must resolve to this pin's own id. Reported separately,
       because a rim miss and a body miss are different animals. */
    const bad = [], rimBad = [];
    let probes = 0, okp = 0, rim = 0, okRim = 0;
    for (const p of pins) {
      const pts = [[p.cx, p.cy]];
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        pts.push([p.cx + Math.cos(a) * p.rad * 0.62, p.cy + Math.sin(a) * p.rad * 0.62]);
      }
      let miss = null;
      for (const [x, y] of pts) {
        probes++;
        const e = document.elementFromPoint(Math.round(x), Math.round(y));
        const g = e && e.closest ? e.closest('[data-loc]') : null;
        const got = g ? g.getAttribute('data-loc') : null;
        if (got === p.id) okp++; else if (!miss) miss = got || '(nothing)';
      }
      if (miss) bad.push(p.id + '->' + miss);
      let rmiss = null;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + Math.PI / 16;
        const x = p.cx + Math.cos(a) * p.rad * 0.98, y = p.cy + Math.sin(a) * p.rad * 0.98;
        rim++;
        const e = document.elementFromPoint(Math.round(x), Math.round(y));
        const g = e && e.closest ? e.closest('[data-loc]') : null;
        const got = g ? g.getAttribute('data-loc') : null;
        if (got === p.id) okRim++; else if (!rmiss) rmiss = got || '(nothing)';
      }
      if (rmiss) rimBad.push(p.id + '->' + rmiss);
    }
    /* how far the tap targets themselves overlap, in screen px, and
       where the floor beat the bisector */
    let tapPairs = 0, tapWorst = 0;
    const hitR = new Map();
    for (const g of svg.querySelectorAll('g[data-loc]')) {
      const h = g.querySelector('circle.wm-hit');
      if (h) hitR.set(g.getAttribute('data-loc'), h.getBoundingClientRect().width / 2);
    }
    for (let i = 0; i < pins.length; i++) for (let j = i + 1; j < pins.length; j++) {
      const a = pins[i], b2 = pins[j];
      const ra = hitR.get(a.id), rb = hitR.get(b2.id);
      if (!ra || !rb) continue;
      const d = Math.hypot(a.cx - b2.cx, a.cy - b2.cy);
      const gap = ra + rb - d;
      if (gap > 0.01) { tapPairs++; if (gap / 2 > tapWorst) tapWorst = gap / 2; }
    }

    /* ---------- names ---------- */
    const labels = [];
    for (const t of svg.querySelectorAll('text')) {
      const txt = (t.textContent || '').trim();
      if (!txt || t.classList.contains('wm-ico')) continue;
      const cart = !!t.closest('.wm-cart') && /^(BULL BEAR|CITY|BULL BEAR CITY)$/.test(txt);
      const r = t.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      labels.push({ t: txt, cart, x1: r.left, y1: r.top, x2: r.right, y2: r.bottom });
    }
    let np = 0, na = 0; const nw = [];
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i], b = labels[j];
        if (a.cart && b.cart) continue;
        const ow = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
        const oh = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
        if (ow > 0 && oh > 0) { np++; na += ow * oh; nw.push([a.t, b.t, Math.round(ow * oh)]); }
      }
    }
    /* names printed vs pins found */
    out.push({
      compact: host.classList.contains('compact'),
      box: [Math.round(hr.width), Math.round(hr.height)],
      nPins: pins.length, pinPairs: pp, pinArea: Math.round(pa),
      discPairs, discArea: Math.round(discArea),
      maxShift: +maxShift.toFixed(1), meanShift: +(sumShift / (pins.length || 1)).toFixed(1),
      minD: minD === Infinity ? null : +minD.toFixed(1),
      meanPinR: +(pins.reduce((s, p) => s + p.rad, 0) / (pins.length || 1)).toFixed(1),
      worstPin: worstPin.slice(0, 6),
      probes, okp, bad, rim, okRim, rimBad,
      tapPairs, tapWorst: +tapWorst.toFixed(2),
      nLabels: labels.length, namePairs: np, nameArea: Math.round(na), nameWorst: nw.slice(0, 4),
    });
  }
  return out;
};

/* the selected place card, and whether the scroller cuts it */
const FOLD = () => {
  const sc = document.querySelector('.w-sheet.w-paper .w-sheet-body') || document.querySelector('.w-appbody');
  if (!sc) return null;
  const sr = sc.getBoundingClientRect();
  /* the place card is the first .w-card that is not inside .w-map */
  const cards = [...sc.querySelectorAll('.w-card')].filter(c => !c.closest('.w-map'));
  const c = cards[0] ? cards[0].getBoundingClientRect() : null;
  return {
    scroller: [+sr.top.toFixed(0), +sr.bottom.toFixed(0), Math.round(sr.width), Math.round(sr.height)],
    scrollH: sc.scrollHeight, clientH: sc.clientHeight,
    overflow: Math.round(sc.scrollHeight - sc.clientHeight),
    card: c ? { top: Math.round(c.top), bot: Math.round(c.bottom) } : null,
    vh: window.innerHeight,
  };
};

const CASES = [
  { name: 'phone', w: 390, h: 844 },
  { name: 'land', w: 844, h: 390 },
  { name: 'desk', w: 1400, h: 900 },
];

const br = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
});

const line = (m) => `  ${m.compact ? 'compact' : 'FULL   '} ${String(m.box.join('x')).padEnd(9)} `
  + `pins=${m.nPins} r=${m.meanPinR}  INK pairs=${m.discPairs} px2=${m.discArea}  `
  + `box-pairs=${m.pinPairs}/${m.pinArea}px2 minD=${m.minD} shift max=${m.maxShift} mean=${m.meanShift}  `
  + `TAP ${m.okp}/${m.probes}${m.bad.length ? ' BAD:' + m.bad.slice(0, 6).join(',') : ''} `
  + `RIM ${m.okRim}/${m.rim}${m.rimBad.length ? ' BAD:' + m.rimBad.slice(0, 4).join(',') : ''} `
  + `tapOverlap pairs=${m.tapPairs} worst=${m.tapWorst}px  `
  + `NAME pairs=${m.namePairs} px2=${m.nameArea} (n=${m.nLabels})`;

for (const c of CASES) {
  const pg = await br.newPage({ viewport: { width: c.w, height: c.h } });
  const errs = [];
  pg.on('pageerror', e => errs.push(e.message));
  await pg.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil: 'load', timeout: 120000 });
  await pg.waitForFunction('window.__WALLY_READY__===true', { timeout: 180000 });
  await pg.waitForTimeout(6000);
  const nloc = await pg.evaluate(() => {
    const g = window.WALLY.ctx.game;
    for (const l of g.data.locations) { g.state.known[l.id] = true; g.state.access[l.id] = true; }
    return g.data.locations.length;
  });
  if (c === CASES[0]) console.log('locations known:', nloc);

  await pg.evaluate(() => window.WALLY.debug.ui('places'));
  await pg.waitForTimeout(1800);
  console.log(`\n=== ${c.name} ${c.w}x${c.h} — PLACES APP ===`);
  for (const m of await pg.evaluate(MEASURE)) {
    console.log(line(m));
    for (const w of m.worstPin) console.log(`      pin ${w[0]} x ${w[1]}  ${w[2]}px2  d=${w[3]}`);
    for (const w of m.nameWorst) console.log(`      name "${w[0]}" x "${w[1]}"  ${w[2]}px2`);
  }
  const f1 = await pg.evaluate(() => {
    const sc = document.querySelector('.w-appbody');
    if (!sc) return null;
    const sr = sc.getBoundingClientRect();
    const cards = [...sc.querySelectorAll('.w-card')].filter(c => !c.closest('.w-map'));
    const c2 = cards[0] ? cards[0].getBoundingClientRect() : null;
    return { sc: [Math.round(sr.top), Math.round(sr.bottom)], ov: Math.round(sc.scrollHeight - sc.clientHeight), card: c2 ? [Math.round(c2.top), Math.round(c2.bottom)] : null, vh: innerHeight };
  });
  if (f1) console.log(`  app scroller ${f1.sc.join('-')} overflow=${f1.ov} card=${f1.card ? f1.card.join('-') : 'none'} vh=${f1.vh}`);
  if (SHOTS) await pg.screenshot({ path: join(ROOT, 'shots', `${TAG}-${c.name}.png`) });

  await pg.evaluate(() => window.WALLY.debug.ui('map'));
  await pg.waitForTimeout(1800);
  console.log(`--- ${c.name} — FULL MAP SHEET ---`);
  for (const m of await pg.evaluate(MEASURE)) {
    if (m.compact) continue;                 // the phone chart behind it
    console.log(line(m));
    for (const w of m.worstPin) console.log(`      pin ${w[0]} x ${w[1]}  ${w[2]}px2  d=${w[3]}`);
    for (const w of m.nameWorst) console.log(`      name "${w[0]}" x "${w[1]}"  ${w[2]}px2`);
  }
  const f = await pg.evaluate(FOLD);
  if (f) console.log(`  sheet body ${f.scroller[0]}-${f.scroller[1]} ${f.scroller[2]}x${f.scroller[3]} scroll ${f.scrollH}->${f.clientH} overflow=${f.overflow} card=${f.card ? f.card.top + '-' + f.card.bot : 'none'} vh=${f.vh}`);
  if (SHOTS) await pg.screenshot({ path: join(ROOT, 'shots', `${TAG}-${c.name}-big.png`) });
  if (errs.length) console.log('  PAGEERRORS:', errs.slice(0, 4));
  await pg.close();
}
await br.close(); srv.close();
