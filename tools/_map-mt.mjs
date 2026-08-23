/* _map-mt.mjs — MAP AGENT: can canvas measureText stand in for the
   rendered SVG advance width? Compares, for every label on every chart,
   getBBox (true ink, no stroke) against (a) the per-character model in
   use and (b) canvas measureText with the same face, size and tracking. */
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
const T = () => {
  const cv = document.createElement('canvas').getContext('2d');
  const out = [];
  for (const svg of document.querySelectorAll('.w-map svg')) {
    const host = svg.closest('.w-map');
    if (host.getBoundingClientRect().width < 5) continue;
    const face = getComputedStyle(svg).fontFamily;
    for (const t of svg.querySelectorAll('text')) {
      const s = (t.textContent || '').trim();
      if (!s || t.classList.contains('wm-ico')) continue;
      const fs = +t.getAttribute('font-size'); if (!fs) continue;
      const wgt = t.getAttribute('font-weight') || '400';
      const ls = parseFloat(t.getAttribute('letter-spacing') || '0') || 0;
      cv.font = `${wgt} ${fs}px ${face}`;
      const mt = cv.measureText(s);
      const bb = t.getBBox();
      out.push({ s, fs: +fs.toFixed(1), compact: host.classList.contains('compact'),
        ink: +bb.width.toFixed(1), mt: +(mt.width + ls * s.length).toFixed(1),
        inkH: +bb.height.toFixed(1),
        asc: +(mt.actualBoundingBoxAscent || 0).toFixed(1), desc: +(mt.actualBoundingBoxDescent || 0).toFixed(1) });
    }
  }
  return out;
};
const br = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio'] });
const rows = [];
for (const c of [{ n: 'phone', w: 390, h: 844 }, { n: 'land', w: 844, h: 390 }, { n: 'desk', w: 1400, h: 900 }]) {
  const pg = await br.newPage({ viewport: { width: c.w, height: c.h } });
  await pg.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil: 'load', timeout: 120000 });
  await pg.waitForFunction('window.__WALLY_READY__===true', { timeout: 180000 });
  await pg.waitForTimeout(6000);
  await pg.evaluate(() => { const g = window.WALLY.ctx.game;
    for (const l of g.data.locations) { g.state.known[l.id] = true; g.state.access[l.id] = true; } });
  for (const v of ['places', 'map']) {
    await pg.evaluate((x) => window.WALLY.debug.ui(x), v);
    await pg.waitForTimeout(1600);
    rows.push(...(await pg.evaluate(T)).map(r => ({ ...r, case: c.n + "/" + v })));
  }
  await pg.close();
}
let worst = 0, n = 0, sum = 0;
for (const r of rows) {
  const err = (r.mt - r.ink) / r.ink;
  sum += Math.abs(err); n++; if (Math.abs(err) > Math.abs(worst)) worst = err;
  if (Math.abs(err) > 0.04) console.log(`  OUTLIER ${r.case} "${r.s}" fs=${r.fs} ink=${r.ink} measureText=${r.mt} err=${(err * 100).toFixed(1)}%`);
}
console.log(`labels=${n} mean|err|=${(sum / n * 100).toFixed(2)}%  worst=${(worst * 100).toFixed(1)}%`);
console.log('height: ink/fs samples', rows.slice(0, 6).map(r => (r.inkH / r.fs).toFixed(3)).join(' '),
  ' asc+desc/fs', rows.slice(0, 6).map(r => ((r.asc + r.desc) / r.fs).toFixed(3)).join(' '));
await br.close(); srv.close();
