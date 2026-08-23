/* _map-forensic.mjs — MAP AGENT: what could an instrument have been
   counting to get "46 pairs / 12742 px2" on the portrait full map?
   Prints, for that exact chart, several plausible readings side by side,
   plus Wally's live marker position on each of three fresh boots (a
   moving marker moves the route, and the route moves the type). */
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
const F = () => {
  const svg = document.querySelector('.w-map:not(.compact) svg') || document.querySelector('.w-map svg');
  const all = [...svg.querySelectorAll('text')].map(t => {
    const r = t.getBoundingClientRect();
    return { s: (t.textContent || '').trim(), ico: t.classList.contains('wm-ico'),
      grp: !!t.closest('g[data-loc]'), x1: r.left, y1: r.top, x2: r.right, y2: r.bottom };
  }).filter(o => o.s && o.x2 > o.x1);
  const groups = [...svg.querySelectorAll('g[data-loc]')].map(g => {
    const r = g.getBoundingClientRect();
    return { s: g.getAttribute('data-loc'), x1: r.left, y1: r.top, x2: r.right, y2: r.bottom };
  }).filter(o => o.x2 > o.x1);
  const pairs = (L) => { let n = 0, a = 0;
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      const ow = Math.min(L[i].x2, L[j].x2) - Math.max(L[i].x1, L[j].x1);
      const oh = Math.min(L[i].y2, L[j].y2) - Math.max(L[i].y1, L[j].y1);
      if (ow > 0 && oh > 0) { n++; a += ow * oh; } }
    return [n, Math.round(a)]; };
  const area = (L) => Math.round(L.reduce((s, o) => s + (o.x2 - o.x1) * (o.y2 - o.y1), 0));
  const names = all.filter(o => !o.ico);
  const me = window.WALLY.ctx.game.state;
  return {
    namesOnly: [names.length, ...pairs(names), area(names)],
    withPinGlyphs: [all.length, ...pairs(all), area(all)],
    textPlusGroups: [all.length + groups.length, ...pairs([...all, ...groups]), area([...all, ...groups])],
    groupsOnly: [groups.length, ...pairs(groups), area(groups)],
    namesPlusGroups: [names.length + groups.length, ...pairs([...names, ...groups]), area([...names, ...groups])],
    loc: me.loc, sel: (window.WALLY.ctx.ui && window.WALLY.ctx.ui.mapSel) || null,
    wally: [Math.round(window.WALLY.ctx.wally.root.position.x), Math.round(window.WALLY.ctx.wally.root.position.z)],
  };
};
const br = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio'] });
for (let run = 0; run < 1; run++) {
  const pg = await br.newPage({ viewport: { width: 390, height: 844 } });
  await pg.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil: 'load', timeout: 120000 });
  await pg.waitForFunction('window.__WALLY_READY__===true', { timeout: 180000 });
  await pg.waitForTimeout(6000);
  await pg.evaluate(() => { const g = window.WALLY.ctx.game;
    for (const l of g.data.locations) { g.state.known[l.id] = true; g.state.access[l.id] = true; } });
  await pg.evaluate(() => window.WALLY.debug.ui('map'));
  await pg.waitForTimeout(1800);
  const f = await pg.evaluate(F);
  console.log(`run ${run}  loc=${f.loc} wally=${f.wally.join(',')}`);
  for (const k of ['namesOnly', 'withPinGlyphs', 'textPlusGroups', 'groupsOnly', 'namesPlusGroups'])
    console.log(`   ${k.padEnd(15)} boxes=${f[k][0]} pairs=${f[k][1]} overlapPx2=${f[k][2]} TOTAL-INK-px2=${f[k][3]}`);
  await pg.close();
}
await br.close(); srv.close();
