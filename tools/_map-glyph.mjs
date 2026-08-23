/* _map-glyph.mjs — calibrate the emoji glyph box against its pin disc.
   Reports, per pin, the glyph rect as a multiple of the pin RADIUS and
   the glyph centre offset from the pin centre, so the placer can model
   the glyph without asking the DOM. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.mjs': 'text/javascript;charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const srv = createServer(async (rq, rs) => {
  try { const c = decodeURIComponent(rq.url.split('?')[0]);
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream', 'cache-control': 'no-store' }); rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const br = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'] });
for (const c of [{ w: 390, h: 844 }, { w: 844, h: 390 }, { w: 1400, h: 900 }]) {
  const pg = await br.newPage({ viewport: { width: c.w, height: c.h } });
  await pg.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil: 'load', timeout: 120000 });
  await pg.waitForFunction('window.__WALLY_READY__===true', { timeout: 180000 });
  await pg.waitForTimeout(6000);
  await pg.evaluate(() => { const g = window.WALLY.ctx.game; for (const l of g.data.locations) { g.state.known[l.id] = true; g.state.access[l.id] = true; } });
  await pg.evaluate(() => window.WALLY.debug.ui('map'));
  await pg.waitForTimeout(1800);
  const r = await pg.evaluate(() => {
    const svg = [...document.querySelectorAll('.w-map svg')].find(s => !s.closest('.w-map').classList.contains('compact'));
    const rows = [];
    for (const g of svg.querySelectorAll('g[data-loc]')) {
      const disc = g.querySelector('circle.wm-pin'); const ico = g.querySelector('text.wm-ico');
      if (!disc || !ico) continue;
      const d = disc.getBBox(), t = ico.getBBox();   // USER units, same frame
      const cx = d.x + d.width / 2, cy = d.y + d.height / 2;
      const rad = d.width / 2;   // getBBox excludes stroke -> geometry r
      rows.push({ id: g.getAttribute('data-loc'), ico: ico.textContent,
        halfW: +(t.width / 2 / rad).toFixed(3), halfH: +(t.height / 2 / rad).toFixed(3),
        ox: +((t.x + t.width / 2 - cx) / rad).toFixed(3), oy: +((t.y + t.height / 2 - cy) / rad).toFixed(3) });
    }
    const f = (k) => { const v = rows.map(x => x[k]); return [Math.min(...v), (v.reduce((a, b) => a + b, 0) / v.length), Math.max(...v)].map(x => +x.toFixed(3)); };
    return { n: rows.length, halfW: f('halfW'), halfH: f('halfH'), ox: f('ox'), oy: f('oy'), sample: rows.slice(0, 6) };
  });
  console.log(c.w + 'x' + c.h, JSON.stringify(r, null, 1));
  await pg.close();
}
await br.close(); srv.close();
