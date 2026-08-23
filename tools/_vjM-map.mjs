#!/usr/bin/env node
/* VERIFY JUDGE — my own measurement of the chart: label collisions,
   pin ink, tap targets and a full tap probe, on both charts at three
   sizes.  WROOT=<tree> node tools/_vjM-map.mjs

   THIS HOST DOES NOT REPRODUCE THE COMPACT PLATE. READ THIS BEFORE
   FILING A DISCREPANCY WITH map.js. __mount() builds a FRESH chart
   into a full-viewport .vj-host with a place pre-selected, and
   cityMap()'s layout walks up for the first overflow-y ancestor to
   decide how tall the plate may be. That ancestor is the host, so the
   compact chart is handed the whole viewport and comes back the same
   size as the full sheet: MEASURED on this tree, plate 390x488 /
   390x488, 754x328 / 754x328, 1010x594 / 1010x594 — compact and full
   IDENTICAL at all three viewports. This rig therefore measures three
   charts twice, not six charts, which is why its per-chart numbers
   come in duplicated pairs (tap overlap 3,3,4,4,2,2 worst 0.39 px).

   The app mount reached through WALLY.debug.ui('places') / ui('map')
   — tools/_map-r5.mjs — gets six DIFFERENT plates (compact 339x393,
   333x218, 372x393; sheet 335x383, 412x259, 528x451) and reads
   3,2,1,1,1,0 worst 0.17 px. Bigger plate spreads the pins: mean ink
   r 10.3 px here against 9.5 there, closest centres 22.6 px against
   21.7. Neither instrument is broken; this one is not looking at the
   plate the player gets, so map.js's counts are cited to _map-r5.mjs
   and NOT to this file. Use this rig for chart-internal geometry, not
   for anything that depends on the plate's size.                     */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = process.env.WROOT || '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try {
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' });
    rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(2500);

await page.evaluate(async () => {
  const m = await import('/src/ui/map.js');
  window.__mapMod = m;
  /* discover everything so all 28 pins are on the plate */
  const g = WALLY.ctx.game;
  const before = g.data.locations.filter((l) => g.known(l.id)).length;
  for (const l of g.data.locations) {
    g.state.known[l.id] = true;
    if (g.state.access) g.state.access[l.id] = true;
  }
  window.__known = { before, after: g.data.locations.filter((l) => g.known(l.id)).length };
});
console.log('known pins:', JSON.stringify(await page.evaluate(() => window.__known)));

await page.evaluate(() => {
  window.__mount = function (compact, sel) {
    document.querySelectorAll('.vj-host').forEach((n) => n.remove());
    /* a scroller, because layout() walks up for the first overflow-y
       ancestor to decide how tall the plate may be */
    const host = document.createElement('div');
    host.className = 'vj-host';
    host.style.cssText = `position:fixed;left:0;top:0;z-index:99999;overflow-y:auto;background:#fff;`
      + `width:${window.innerWidth}px;height:${window.innerHeight}px;`;
    document.body.appendChild(host);
    const chart = window.__mapMod.cityMap(WALLY.ctx, { compact, selected: sel });
    host.appendChild(chart.el);
    window.__chart = chart;
    chart.refresh?.();
    return { w: chart.el.clientWidth, h: chart.el.clientHeight };
  };
  window.__measure = function () {
    const svg = window.__chart.svg;
    const ctm = svg.getScreenCTM();
    const sc = Math.hypot(ctm.a, ctm.b);
    const P = (x, y) => { const p = svg.createSVGPoint(); p.x = x; p.y = y; return p.matrixTransform(ctm); };
    /* --- pins --- */
    const pins = [];
    for (const g of svg.querySelectorAll('g[data-loc]')) {
      const pin = g.querySelector('circle.wm-pin');
      const hit = g.querySelector('circle.wm-hit');
      if (!pin || !hit) continue;                      // the name group has neither
      const cx = +pin.getAttribute('cx'), cy = +pin.getAttribute('cy');
      const r = +pin.getAttribute('r');
      const sw = +pin.getAttribute('stroke-width');
      const p = P(cx, cy);
      pins.push({ id: g.getAttribute('data-loc'), x: p.x, y: p.y,
        r: r * sc, ink: (r + sw / 2) * sc, tap: (+hit.getAttribute('r')) * sc });
    }
    /* --- type --- */
    const labels = [];
    for (const t of svg.querySelectorAll('text')) {
      const s = (t.textContent || '').trim();
      if (!s) continue;
      const b = t.getBoundingClientRect();
      if (b.width < 0.5 || b.height < 0.5) continue;
      labels.push({ s, x: b.x, y: b.y, w: b.width, h: b.height,
        loc: t.parentElement?.getAttribute?.('data-loc') || null,
        cls: t.getAttribute('class') || '' });
    }
    return { pins, labels, sc, box: svg.getBoundingClientRect().toJSON() };
  };
  window.__probe = function (fr, nA) {
    /* ring probe: does a point at `fr` of a pin's own INK resolve to
       that pin?  elementFromPoint, then the nearest [data-loc]. */
    const out = { n: 0, bad: [] };
    const svg = window.__chart.svg;
    const ctm = svg.getScreenCTM();
    const sc = Math.hypot(ctm.a, ctm.b);
    const P = (x, y) => { const p = svg.createSVGPoint(); p.x = x; p.y = y; return p.matrixTransform(ctm); };
    for (const g of svg.querySelectorAll('g[data-loc]')) {
      const pin = g.querySelector('circle.wm-pin');
      if (!pin) continue;
      const id = g.getAttribute('data-loc');
      const cx = +pin.getAttribute('cx'), cy = +pin.getAttribute('cy');
      const ink = (+pin.getAttribute('r') + (+pin.getAttribute('stroke-width')) / 2);
      for (let i = 0; i < nA; i++) {
        const a = (i / nA) * Math.PI * 2;
        const p = P(cx + Math.cos(a) * ink * fr, cy + Math.sin(a) * ink * fr);
        out.n++;
        const e = document.elementFromPoint(Math.round(p.x), Math.round(p.y));
        const owner = e?.closest?.('[data-loc]')?.getAttribute('data-loc') ?? null;
        if (owner !== id) out.bad.push({ id, got: owner, a: +(a * 57.3).toFixed(0) });
      }
    }
    return out;
  };
  window.__raster = function (step) {
    /* full tap probe: every point of the plate, at `step` px. For each
       point that resolves to a place, how far is it from THAT place's
       pin, and is there a nearer pin whose own ink it is inside? */
    const svg = window.__chart.svg;
    const b = svg.getBoundingClientRect();
    const ctm = svg.getScreenCTM();
    const sc = Math.hypot(ctm.a, ctm.b);
    const P = (x, y) => { const p = svg.createSVGPoint(); p.x = x; p.y = y; return p.matrixTransform(ctm); };
    const pins = [];
    for (const g of svg.querySelectorAll('g[data-loc]')) {
      const pin = g.querySelector('circle.wm-pin');
      if (!pin) continue;
      const p = P(+pin.getAttribute('cx'), +pin.getAttribute('cy'));
      pins.push({ id: g.getAttribute('data-loc'), x: p.x, y: p.y,
        ink: (+pin.getAttribute('r') + (+pin.getAttribute('stroke-width')) / 2) * sc });
    }
    let n = 0, hits = 0, wrongInk = 0, deadInk = 0;
    const wrong = [];
    for (let y = b.top + 1; y < b.bottom - 1; y += step) {
      for (let x = b.left + 1; x < b.right - 1; x += step) {
        n++;
        const e = document.elementFromPoint(Math.round(x), Math.round(y));
        const owner = e?.closest?.('[data-loc]')?.getAttribute('data-loc') ?? null;
        if (owner) hits++;
        /* which pin's ink is this point inside? */
        let inside = null;
        for (const p of pins) if (Math.hypot(p.x - x, p.y - y) <= p.ink) {
          if (!inside || Math.hypot(p.x - x, p.y - y) < Math.hypot(inside.x - x, inside.y - y)) inside = p;
        }
        if (inside) {
          if (owner === null) { deadInk++; if (wrong.length < 12) wrong.push({ x: Math.round(x), y: Math.round(y), want: inside.id, got: 'none' }); }
          else if (owner !== inside.id) { wrongInk++; if (wrong.length < 12) wrong.push({ x: Math.round(x), y: Math.round(y), want: inside.id, got: owner }); }
        }
      }
    }
    return { n, hits, wrongInk, deadInk, wrong, pins: pins.length };
  };
});

const rect = (a, b) => {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  return (x2 > x && y2 > y) ? (x2 - x) * (y2 - y) : 0;
};

const SEL = process.env.WSEL || 'apartment';
for (const [vw, vh] of [[390, 844], [844, 390], [1400, 900]]) {
  await page.setViewportSize({ width: vw, height: vh });
  await page.waitForTimeout(400);
  for (const compact of [false, true]) {
    const box = await page.evaluate(([c, s]) => window.__mount(c, s), [compact, SEL]);
    await page.waitForTimeout(500);
    const m = await page.evaluate(() => window.__measure());
    /* labels */
    let pairs = 0, px2 = 0; const worst = [];
    for (let i = 0; i < m.labels.length; i++) {
      for (let j = i + 1; j < m.labels.length; j++) {
        const a = rect(m.labels[i], m.labels[j]);
        if (a > 0.5) { pairs++; px2 += a; worst.push({ a: +a.toFixed(1), s: [m.labels[i].s, m.labels[j].s] }); }
      }
    }
    worst.sort((p, q) => q.a - p.a);
    const ico = (t) => /wm-ico/.test(t.cls);
    let wordPairs = 0, wordPx2 = 0, icoPairs = 0, icoPx2 = 0;
    const detail = [];
    for (let i = 0; i < m.labels.length; i++) {
      for (let j = i + 1; j < m.labels.length; j++) {
        const a = rect(m.labels[i], m.labels[j]);
        if (a <= 0.5) continue;
        const A = m.labels[i], B = m.labels[j];
        if (ico(A) || ico(B)) { icoPairs++; icoPx2 += a; } else { wordPairs++; wordPx2 += a; }
        detail.push(`${JSON.stringify([A.s, B.s])}=${a.toFixed(0)}${ico(A) || ico(B) ? ' [icon]' : ''}`);
      }
    }
    /* pins */
    let inkPairs = 0, minC = Infinity, minPair = null, tapPairs = 0, worstTap = 0;
    for (let i = 0; i < m.pins.length; i++) {
      for (let j = i + 1; j < m.pins.length; j++) {
        const a = m.pins[i], b = m.pins[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < minC) { minC = d; minPair = [a.id, b.id]; }
        if (d < a.ink + b.ink - 1e-6) inkPairs++;
        const ov = a.tap + b.tap - d;
        if (ov > 1e-6) { tapPairs++; worstTap = Math.max(worstTap, ov / 2); }
      }
    }
    const meanInk = m.pins.reduce((t, p) => t + p.ink, 0) / (m.pins.length || 1);
    const p62 = await page.evaluate(() => window.__probe(0.62, 12));
    const p98 = await page.evaluate(() => window.__probe(0.98, 12));
    const ras = await page.evaluate(() => window.__raster(3));
    const routeLbl = m.labels.find((l) => /^\d+ m$/.test(l.s));
    let routeOv = 0;
    if (routeLbl) for (const l of m.labels) if (l !== routeLbl) routeOv += rect(routeLbl, l);
    let routeOnPin = 0;
    if (routeLbl) for (const p of m.pins) {
      const cx = Math.max(routeLbl.x, Math.min(p.x, routeLbl.x + routeLbl.w));
      const cy = Math.max(routeLbl.y, Math.min(p.y, routeLbl.y + routeLbl.h));
      if (Math.hypot(p.x - cx, p.y - cy) <= p.ink) routeOnPin++;
    }
    console.log(`\n### ${vw}x${vh}  ${compact ? 'COMPACT (phone Places)' : 'FULL (desk sheet)'}  plate ${Math.round(m.box.width)}x${Math.round(m.box.height)}`);
    console.log(`   type: ${m.labels.length} text nodes   ALL overlapping pairs ${pairs} / ${px2.toFixed(0)} px2`
      + `   word-vs-word ${wordPairs} / ${wordPx2.toFixed(0)} px2   involving a pin icon ${icoPairs} / ${icoPx2.toFixed(0)} px2`);
    if (detail.length) console.log(`        ${detail.join('   ')}`);
    console.log(`   pins: ${m.pins.length}   ink-overlapping pairs ${inkPairs}   min centre-to-centre ${minC.toFixed(1)} px ${JSON.stringify(minPair)}   mean ink r ${meanInk.toFixed(1)} px`);
    console.log(`   tap: overlapping target pairs ${tapPairs}   worst shared radius ${worstTap.toFixed(2)} px`);
    console.log(`   ring probe 0.62 ink: ${p62.n - p62.bad.length}/${p62.n} correct` + (p62.bad.length ? `  bad ${JSON.stringify(p62.bad.slice(0, 4))}` : ''));
    console.log(`   ring probe 0.98 ink: ${p98.n - p98.bad.length}/${p98.n} correct` + (p98.bad.length ? `  bad ${JSON.stringify(p98.bad.slice(0, 4))}` : ''));
    console.log(`   full raster @3px: ${ras.n} pts, ${ras.hits} resolve to a place; inside-own-ink wrong ${ras.wrongInk}, dead ${ras.deadInk}`
      + (ras.wrong.length ? `  e.g. ${JSON.stringify(ras.wrong.slice(0, 3))}` : ''));
    console.log(`   route chip: ${routeLbl ? `"${routeLbl.s}" at ${Math.round(routeLbl.x)},${Math.round(routeLbl.y)}  overlap with other type ${routeOv.toFixed(1)} px2, sits on ${routeOnPin} pin ink` : 'none on this chart'}`);
  }
}
await browser.close(); server.close();
