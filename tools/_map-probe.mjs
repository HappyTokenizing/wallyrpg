/* _map-probe.mjs — how fat is the label model?
   Prints, for every <text> on the full-map chart, the rendered getBBox
   in board units next to the model's own estimate. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const M = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const s = createServer(async (rq, rs) => {
  try { const c = decodeURIComponent(rq.url.split('?')[0]);
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': M[extname(c)] || 'application/octet-stream' }); rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => s.listen(0, '127.0.0.1', r)); const P = s.address().port;
const br = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio'] });
const pg = await br.newPage({ viewport: { width: 390, height: 844 } });
await pg.goto(`http://127.0.0.1:${P}/index.html?shot=1`, { waitUntil: 'load', timeout: 120000 });
await pg.waitForFunction('window.__WALLY_READY__===true', { timeout: 180000 });
await pg.waitForTimeout(6000);
await pg.evaluate(() => { const g = window.WALLY.ctx.game; for (const l of g.data.locations) { g.state.known[l.id] = true; g.state.access[l.id] = true; } });
await pg.evaluate(() => window.WALLY.debug.ui('map'));
await pg.waitForTimeout(1500);
const rows = await pg.evaluate(() => {
  const svg = document.querySelector('.w-map:not(.compact) svg');
  const out = [];
  for (const t of svg.querySelectorAll('text')) {
    if (t.classList.contains('wm-ico')) continue;
    const bb = t.getBBox();
    out.push({ s: t.textContent.trim(), fs: +t.getAttribute('font-size'), w: +bb.width.toFixed(1), h: +bb.height.toFixed(1) });
  }
  return out;
});
for (const r of rows) {
  const caps = r.s === r.s.toUpperCase();
  const perChar = r.w / r.s.length / r.fs;
  console.log(`${caps ? 'CAP' : 'mix'} fs=${r.fs} len=${r.s.length} w=${r.w} h=${r.h}  w/(len*fs)=${perChar.toFixed(3)}  h/fs=${(r.h / r.fs).toFixed(3)}  "${r.s}"`);
}
await br.close(); s.close();
