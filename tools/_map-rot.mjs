/* _map-rot.mjs — the three things the pin/sheet round still has to
   prove: paint cost with every place found, the full-map sheet
   surviving a rotate in both directions, and 844x600 (the size that
   tripped the viewport test last time) staying one column and uncut. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
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

const STATE = () => {
  const sheet = document.querySelector('.w-sheet.w-paper');
  const body = sheet && sheet.querySelector('.w-sheet-body');
  const host = sheet && sheet.querySelector('.w-map');
  const cards = body ? [...body.querySelectorAll('.w-card')].filter(c => !c.closest('.w-map')) : [];
  const c = cards[0] ? cards[0].getBoundingClientRect() : null;
  const hr = host ? host.getBoundingClientRect() : null;
  const cols = body && body.firstElementChild;
  return {
    sheetW: sheet ? Math.round(sheet.getBoundingClientRect().width) : null,
    bodyBox: body ? [Math.round(body.clientWidth), Math.round(body.clientHeight)] : null,
    dir: cols ? getComputedStyle(cols).flexDirection + '/' + getComputedStyle(cols).display : null,
    chart: hr ? Math.round(hr.width) + 'x' + Math.round(hr.height) : null,
    card: c ? [Math.round(c.top), Math.round(c.bottom)] : null,
    overflow: body ? Math.round(body.scrollHeight - body.clientHeight) : null,
    vh: innerHeight,
    cut: c ? Math.max(0, Math.round(c.bottom) - innerHeight) : null,
  };
};

const br = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'] });
const pg = await br.newPage({ viewport: { width: 390, height: 844 } });
const errs = [], warns = [];
pg.on('pageerror', e => errs.push(e.message));
pg.on('console', m => { if (m.type() === 'error') warns.push(m.text().slice(0, 160)); });
await pg.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil: 'load', timeout: 120000 });
await pg.waitForFunction('window.__WALLY_READY__===true', { timeout: 180000 });
await pg.waitForTimeout(6000);
await pg.evaluate(() => { const g = window.WALLY.ctx.game; for (const l of g.data.locations) { g.state.known[l.id] = true; g.state.access[l.id] = true; } });

await pg.evaluate(() => window.WALLY.debug.ui('map'));
await pg.waitForTimeout(1500);
console.log('portrait 390x844 ', JSON.stringify(await pg.evaluate(STATE)));

/* paint cost with all 28 found — the displacement pass runs inside it */
console.log('paint ms (10 repaints, 28 places):', await pg.evaluate(() => {
  const host = document.querySelector('.w-sheet .w-map');
  const api = window.WALLY.__mapProbe;
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) {
    /* force a repaint the way the game does: fire the discover bus */
    window.WALLY.ctx.bus.emit('discover', { id: 'apartment' });
  }
  return +((performance.now() - t0) / 10).toFixed(2);
}));

await pg.setViewportSize({ width: 844, height: 390 });
await pg.waitForTimeout(1800);
console.log('rotate ->844x390 ', JSON.stringify(await pg.evaluate(STATE)));
await pg.setViewportSize({ width: 390, height: 844 });
await pg.waitForTimeout(1800);
console.log('rotate back      ', JSON.stringify(await pg.evaluate(STATE)));
await pg.setViewportSize({ width: 844, height: 600 });
await pg.waitForTimeout(1800);
console.log('844x600          ', JSON.stringify(await pg.evaluate(STATE)));
for (const [w2, h2] of [[1400, 500], [768, 1024], [360, 640], [1024, 768]]) {
  await pg.setViewportSize({ width: w2, height: h2 });
  await pg.waitForTimeout(1500);
  console.log(`${w2}x${h2}`.padEnd(17), JSON.stringify(await pg.evaluate(STATE)));
}
await pg.setViewportSize({ width: 926, height: 428 });
await pg.waitForTimeout(1800);
console.log('926x428          ', JSON.stringify(await pg.evaluate(STATE)));
await pg.screenshot({ path: join(ROOT, 'shots', 'm4-rot-926.png') });

console.log('pageerrors:', errs.length, errs.slice(0, 3));
console.log('console errors:', warns.length, warns.slice(0, 3));
await br.close(); srv.close();
