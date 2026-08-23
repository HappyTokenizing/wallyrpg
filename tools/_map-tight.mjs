/* _map-tight.mjs — MAP AGENT: the one tight case (844x390 compact) plus
   the full sheet beside it, names only. Fast loop for the caption/route
   knot.  node tools/_map-tight.mjs */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const M = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const srv = createServer(async (rq, rs) => {
  try { const c = decodeURIComponent(rq.url.split('?')[0]);
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': M[extname(c)] || 'application/octet-stream', 'cache-control': 'no-store' }); rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const NAMES = () => {
  const out = [];
  for (const svg of document.querySelectorAll('.w-map svg')) {
    const host = svg.closest('.w-map');
    const hr = host.getBoundingClientRect(); if (hr.width < 5) continue;
    const L = [];
    for (const t of svg.querySelectorAll('text')) {
      const s = (t.textContent || '').trim();
      if (!s || t.classList.contains('wm-ico')) continue;
      const cart = !!t.closest('.wm-cart') && /^(BULL BEAR|CITY|BULL BEAR CITY)$/.test(s);
      const r = t.getBoundingClientRect(); if (r.width < 1) continue;
      L.push({ s, cart, x1: r.left, y1: r.top, x2: r.right, y2: r.bottom });
    }
    let np = 0, na = 0; const w = [];
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      const a = L[i], b = L[j]; if (a.cart && b.cart) continue;
      const ow = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
      const oh = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
      if (ow > 0 && oh > 0) { np++; na += ow * oh; w.push([a.s, b.s, +(ow * oh).toFixed(1)]); }
    }
    w.sort((x, y) => y[2] - x[2]);
    out.push({ compact: host.classList.contains('compact'), box: [Math.round(hr.width), Math.round(hr.height)], n: L.length, np, na: +na.toFixed(1), w: w.slice(0, 5) });
  }
  return out;
};
const br = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'] });
for (const c of [{ n: 'phone', w: 390, h: 844 }, { n: 'land', w: 844, h: 390 }, { n: 'desk', w: 1400, h: 900 }]) {
  const pg = await br.newPage({ viewport: { width: c.w, height: c.h } });
  const errs = []; pg.on('pageerror', e => errs.push(e.message));
  await pg.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil: 'load', timeout: 120000 });
  await pg.waitForFunction('window.__WALLY_READY__===true', { timeout: 180000 });
  await pg.waitForTimeout(6000);
  await pg.evaluate(() => { const g = window.WALLY.ctx.game;
    for (const l of g.data.locations) { g.state.known[l.id] = true; g.state.access[l.id] = true; } });
  for (const v of ['places', 'map']) {
    await pg.evaluate((x) => window.WALLY.debug.ui(x), v);
    await pg.waitForTimeout(1800);
    for (const m of await pg.evaluate(NAMES)) {
      console.log(`${c.n.padEnd(5)} ${v.padEnd(6)} ${(m.compact ? 'compact' : 'FULL').padEnd(7)} ${m.box.join('x').padEnd(8)} labels=${m.n} pairs=${m.np} px2=${m.na}`);
      for (const x of m.w) console.log(`        "${x[0]}" x "${x[1]}"  ${x[2]}px2`);
    }
    const ms = await pg.evaluate(() => {
      const g = [...document.querySelectorAll('.w-map svg g[data-loc]')].filter(x => x.querySelector('circle.wm-pin'));
      if (g.length < 4) return null;
      const t = [];
      for (let i = 0; i < 8; i++) {
        const t0 = performance.now();
        g[i % g.length].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        t.push(performance.now() - t0);
      }
      t.sort((a, b) => a - b);
      return [+t[0].toFixed(2), +t[t.length >> 1].toFixed(2), +t[t.length - 1].toFixed(2)];
    });
    if (ms) console.log(`        [re-lay the whole chart on a pin tap: min/med/max ${ms.join(' / ')} ms]`);
  }
  if (errs.length) console.log('  PAGE ERRORS', errs.slice(0, 3));
  await pg.close();
}
await br.close(); srv.close();
