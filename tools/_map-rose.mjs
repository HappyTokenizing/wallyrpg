import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8', '.mjs': 'text/javascript;charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const srv = createServer(async (rq, rs) => { try { const c = decodeURIComponent(rq.url.split('?')[0]); const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c)); rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream', 'cache-control': 'no-store' }); rs.end(b); } catch { rs.writeHead(404).end(); } });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const br = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'] });
const pg = await br.newPage({ viewport: { width: 844, height: 390 } });
await pg.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil: 'load', timeout: 120000 });
await pg.waitForFunction('window.__WALLY_READY__===true', { timeout: 180000 });
await pg.waitForTimeout(6000);
await pg.evaluate(() => { const g = window.WALLY.ctx.game; for (const l of g.data.locations) { g.state.known[l.id] = true; g.state.access[l.id] = true; } });
await pg.evaluate(() => window.WALLY.debug.ui('map'));
await pg.waitForTimeout(1800);
console.log(JSON.stringify(await pg.evaluate(() => {
  const svg = [...document.querySelectorAll('.w-map svg')].find(s => !s.closest('.w-map').classList.contains('compact'));
  const rose = svg.querySelector('.wm-rose');
  const disc = rose.querySelector('circle');
  const N = rose.querySelector('text');
  const b = (e) => { const r = e.getBBox(); return { x1: +r.x.toFixed(1), y1: +r.y.toFixed(1), x2: +(r.x + r.width).toFixed(1), y2: +(r.y + r.height).toFixed(1) }; };
  const cap = [...svg.querySelectorAll('text')].find(t => t.textContent.trim() === 'INNOVATION DISTRICT');
  return { discBB: b(disc), NBB: b(N), Nfs: N.getAttribute('font-size'), Ny: N.getAttribute('y'),
    cap: cap ? b(cap) : null, capfs: cap && cap.getAttribute('font-size'), vb: svg.getAttribute('viewBox') };
}), null, 1));
await br.close(); srv.close();
