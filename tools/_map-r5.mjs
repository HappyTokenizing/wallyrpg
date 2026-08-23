/* _map-r5.mjs — MAP AGENT rig, round 5.

   Same MOUNT as _map-pins.mjs (round 4) so the numbers are comparable:
   full discovery, NO place selected, chart reached through
   WALLY.debug.ui('places') for the compact chart and ui('map') for the
   full sheet, measured 1800 ms after the switch, at three viewports.

   Adds, on top of round 4:
     · CAPTION-ON-EMOJI: every district caption's box against every
       place-pin glyph box (.wm-ico), pairs and px2, worst named
     · the same for place NAMES on glyphs, so we can see whether a fix
       for the kept captions costs the droppable names anything

   node tools/_map-r5.mjs [--shots] [--tag=r5]
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
const TAG = (process.argv.find(a => a.startsWith('--tag=')) || '--tag=r5').slice(6);

const MEASURE = () => {
  const out = [];
  const ov = (a, b) => {
    const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
    const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
    return w > 0 && h > 0 ? w * h : 0;
  };
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
      if (!c) continue;
      const r = c.getBoundingClientRect();
      if (r.width < 1) continue;
      pins.push({
        id: g.getAttribute('data-loc'),
        cx: r.left + r.width / 2, cy: r.top + r.height / 2, rad: r.width / 2,
        x1: r.left, y1: r.top, x2: r.right, y2: r.bottom,
      });
    }
    /* true disc-on-disc ink */
    let discPairs = 0, discArea = 0, minD = Infinity;
    for (let i = 0; i < pins.length; i++) {
      for (let j = i + 1; j < pins.length; j++) {
        const a = pins[i], b = pins[j];
        const d = Math.hypot(a.cx - b.cx, a.cy - b.cy);
        if (d < minD) minD = d;
        const r1 = a.rad, r2 = b.rad;
        if (d >= r1 + r2) continue;
        discPairs++;
        if (d <= Math.abs(r1 - r2)) { discArea += Math.PI * Math.min(r1, r2) ** 2; continue; }
        const a1 = Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1));
        const a2 = Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2));
        discArea += r1 * r1 * (a1 - Math.sin(2 * a1) / 2) + r2 * r2 * (a2 - Math.sin(2 * a2) / 2);
      }
    }

    /* ---------- tap probes ---------- */
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
      const gap = ra + rb - Math.hypot(a.cx - b2.cx, a.cy - b2.cy);
      if (gap > 0.01) { tapPairs++; if (gap / 2 > tapWorst) tapWorst = gap / 2; }
    }

    /* ---------- type, split into captions / names / glyphs ---------- */
    const labels = [], glyphs = [];
    for (const t of svg.querySelectorAll('text')) {
      const txt = (t.textContent || '').trim();
      if (!txt) continue;
      const r = t.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const bx = { t: txt, x1: r.left, y1: r.top, x2: r.right, y2: r.bottom };
      if (t.classList.contains('wm-ico')) {
        bx.id = t.closest('[data-loc]') ? t.closest('[data-loc]').getAttribute('data-loc') : '?';
        glyphs.push(bx); continue;
      }
      bx.cart = !!t.closest('.wm-cart') && /^(BULL BEAR|CITY|BULL BEAR CITY)$/.test(txt);
      /* a district caption is a chart-level <text> not inside a
         [data-loc] group and not furniture */
      bx.cap = !bx.cart && !t.closest('[data-loc]') && !t.closest('.wm-rose')
        && !/ m$/.test(txt) && txt === txt.toUpperCase();
      labels.push(bx);
    }
    let np = 0, na = 0; const nw = [];
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i], b = labels[j];
        if (a.cart && b.cart) continue;
        const o = ov(a, b);
        if (o > 0) { np++; na += o; nw.push([a.t, b.t, Math.round(o)]); }
      }
    }
    nw.sort((p, q) => q[2] - p[2]);

    let cg = 0, cgA = 0, ng = 0, ngA = 0; const cw = [];
    for (const l of labels) {
      for (const g of glyphs) {
        const o = ov(l, g);
        if (o <= 0) continue;
        if (l.cap) { cg++; cgA += o; cw.push([l.t, g.t + '/' + g.id, Math.round(o)]); }
        else if (!l.cart) { ng++; ngA += o; }
      }
    }
    cw.sort((p, q) => q[2] - p[2]);

    out.push({
      compact: host.classList.contains('compact'),
      box: [Math.round(hr.width), Math.round(hr.height)],
      nPins: pins.length, discPairs, discArea: Math.round(discArea),
      minD: minD === Infinity ? null : +minD.toFixed(1),
      meanPinR: +(pins.reduce((s, p) => s + p.rad, 0) / (pins.length || 1)).toFixed(1),
      probes, okp, bad, rim, okRim, rimBad,
      tapPairs, tapWorst: +tapWorst.toFixed(2),
      nCaps: labels.filter(l => l.cap).length, nLabels: labels.length,
      namePairs: np, nameArea: Math.round(na), nameWorst: nw.slice(0, 4),
      capGlyph: cg, capGlyphArea: Math.round(cgA), capGlyphWorst: cw.slice(0, 5),
      nameGlyph: ng, nameGlyphArea: Math.round(ngA),
    });
  }
  return out;
};

/* THE PLATE IS NOT SETTLED AT A FLAT 1800 ms. Round 6 read the
   844x390 compact chart at 323x211 on one run and 333x218 on the next,
   on identical code — the places panel is still growing when the timer
   fires, and the type layer places against whatever box it is handed,
   so the caption counts moved with it (10 pairs / 473 px2 against
   8 / 480). A flat wait is not an instrument. Wait for the host rect to
   stop changing instead: three identical samples 200 ms apart, up to
   12 s, then measure. */
const SETTLE = async (pg) => {
  await pg.waitForFunction(() => {
    const h = [...document.querySelectorAll('.w-map')]
      .filter(e => e.getBoundingClientRect().width > 5);
    if (!h.length) return false;
    const k = h.map(e => { const r = e.getBoundingClientRect();
      return Math.round(r.width) + 'x' + Math.round(r.height); }).join('|');
    window.__mapSettle = window.__mapSettle || { k: '', n: 0 };
    if (k === window.__mapSettle.k) window.__mapSettle.n++;
    else { window.__mapSettle.k = k; window.__mapSettle.n = 0; }
    return window.__mapSettle.n >= 3;
  }, null, { timeout: 30000, polling: 200 });
  await pg.evaluate(() => { window.__mapSettle = null; });
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
  + `pins=${m.nPins} r=${m.meanPinR} INK=${m.discPairs}/${m.discArea}px2 minD=${m.minD}  `
  + `TAP ${m.okp}/${m.probes}${m.bad.length ? ' BAD:' + m.bad.slice(0, 6).join(',') : ''} `
  + `RIM ${m.okRim}/${m.rim}${m.rimBad.length ? ' BAD:' + m.rimBad.slice(0, 4).join(',') : ''} `
  + `tapOv=${m.tapPairs}/${m.tapWorst}px  NAME=${m.namePairs}/${m.nameArea}px2 (n=${m.nLabels},caps=${m.nCaps})  `
  + `CAPxGLYPH=${m.capGlyph}/${m.capGlyphArea}px2  NAMExGLYPH=${m.nameGlyph}/${m.nameGlyphArea}px2`;

for (const c of CASES) {
  const pg = await br.newPage({ viewport: { width: c.w, height: c.h } });
  const errs = [];
  pg.on('pageerror', e => errs.push(e.message));
  pg.setDefaultTimeout(240000);
  await pg.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil: 'load', timeout: 240000 });
  /* NOTE: waitForFunction's second positional argument is ARG, not
     options — passing {timeout} there silently left the default 30 s in
     place, which is shorter than this machine's boot when other agents
     are running headless Chrome alongside. Options go third. */
  await pg.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 240000 });
  await pg.waitForTimeout(6000);
  await pg.evaluate(() => {
    const g = window.WALLY.ctx.game;
    for (const l of g.data.locations) { g.state.known[l.id] = true; g.state.access[l.id] = true; }
  });

  await pg.evaluate(() => window.WALLY.debug.ui('places'));
  await pg.waitForTimeout(900); await SETTLE(pg);
  console.log(`\n=== ${c.name} ${c.w}x${c.h} — PLACES APP ===`);
  for (const m of await pg.evaluate(MEASURE)) {
    console.log(line(m));
    for (const w of m.nameWorst) console.log(`      name "${w[0]}" x "${w[1]}"  ${w[2]}px2`);
    for (const w of m.capGlyphWorst) console.log(`      CAP  "${w[0]}" x ${w[1]}  ${w[2]}px2`);
  }
  if (SHOTS) await pg.screenshot({ path: join(ROOT, 'shots', `${TAG}-${c.name}.png`) });

  await pg.evaluate(() => window.WALLY.debug.ui('map'));
  await pg.waitForTimeout(900); await SETTLE(pg);
  console.log(`--- ${c.name} — FULL MAP SHEET ---`);
  for (const m of await pg.evaluate(MEASURE)) {
    if (m.compact) continue;
    console.log(line(m));
    for (const w of m.nameWorst) console.log(`      name "${w[0]}" x "${w[1]}"  ${w[2]}px2`);
    for (const w of m.capGlyphWorst) console.log(`      CAP  "${w[0]}" x ${w[1]}  ${w[2]}px2`);
  }
  if (SHOTS) await pg.screenshot({ path: join(ROOT, 'shots', `${TAG}-${c.name}-big.png`) });
  if (errs.length) console.log('  PAGEERRORS:', errs.slice(0, 4));
  await pg.close();
}
await br.close(); srv.close();
