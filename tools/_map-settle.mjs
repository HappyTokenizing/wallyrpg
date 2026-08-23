/* _map-settle.mjs — MAP AGENT: is the chart's label geometry STABLE, or
   does the number you get depend on when you looked? Measures the same
   chart at a ladder of waits after the view opens. */
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
const SNAP = (pinsAsText) => {
  const out = [];
  for (const svg of document.querySelectorAll('.w-map svg')) {
    const host = svg.closest('.w-map');
    const hr = host.getBoundingClientRect(); if (hr.width < 5) continue;
    const L = [];
    for (const t of svg.querySelectorAll('text')) {
      const s = (t.textContent || '').trim(); if (!s) continue;
      if (!pinsAsText && t.classList.contains('wm-ico')) continue;
      const cart = !!t.closest('.wm-cart') && /^(BULL BEAR|CITY|BULL BEAR CITY)$/.test(s);
      const r = t.getBoundingClientRect(); if (r.width < 1) continue;
      L.push({ s, cart, x1: r.left, y1: r.top, x2: r.right, y2: r.bottom });
    }
    let np = 0, na = 0;
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      const a = L[i], b = L[j]; if (a.cart && b.cart) continue;
      const ow = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
      const oh = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
      if (ow > 0 && oh > 0) { np++; na += ow * oh; }
    }
    out.push({ c: host.classList.contains('compact'), box: [Math.round(hr.width), Math.round(hr.height)], n: L.length, np, na: Math.round(na) });
  }
  return out;
};
const br = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio'] });
for (const c of [{ n: 'phone', w: 390, h: 844 }, { n: 'land', w: 844, h: 390 }]) {
  const pg = await br.newPage({ viewport: { width: c.w, height: c.h } });
  await pg.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil: 'load', timeout: 120000 });
  await pg.waitForFunction('window.__WALLY_READY__===true', { timeout: 180000 });
  await pg.waitForTimeout(6000);
  await pg.evaluate(() => { const g = window.WALLY.ctx.game;
    for (const l of g.data.locations) { g.state.known[l.id] = true; g.state.access[l.id] = true; } });
  for (const v of ['places', 'map']) {
    await pg.evaluate((x) => window.WALLY.debug.ui(x), v);
    let prev = 0;
    for (const wt of [60, 150, 300, 600, 1200, 2400]) {
      await pg.waitForTimeout(wt - prev); prev = wt;
      const a = await pg.evaluate(SNAP, false);
      const b = await pg.evaluate(SNAP, true);
      console.log(`${c.n} ${v} t=${String(wt).padStart(4)}ms  ` + a.map((m, i) =>
        `[${m.c ? 'cmp' : 'FULL'} ${m.box.join('x')} n=${m.n} ${m.np}/${m.na}px2 | +pins n=${b[i].n} ${b[i].np}/${b[i].na}px2]`).join(' '));
    }
  }
  await pg.close();
}
await br.close(); srv.close();
