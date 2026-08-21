#!/usr/bin/env node
/* _uj-pointer.mjs — UI AGENT probe.

   Checks the HUD destination pointer's bearing against an
   independently computed answer at four yaws, and dumps what the
   quick-buy sheet resolves for a handful of tickers. Not part of the
   regression gate; a one-off "is the maths right" check, because
   "the arrow looks about right" is not a measurement.

     node tools/_uj-pointer.mjs
*/
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};
const server = createServer(async (req, res) => {
  try {
    const clean = decodeURIComponent(req.url.split('?')[0]);
    const p = join(ROOT, clean === '/' ? 'index.html' : clean);
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb',
    '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(`http://127.0.0.1:${PORT}/index.html?shot=1&quality=low`);
await page.waitForFunction('window.__WALLY_READY__', null, { timeout: 120000 });
await page.waitForTimeout(1500);

const out = await page.evaluate(() => {
  const ctx = window.WALLY.ctx;
  const g = ctx.game, wl = ctx.wally;
  const dest = 'exchange';
  ctx.ui.setDestination(dest);
  /* the pointer aims at the DOORWAY, not the building centre — the
     same point ui.arrivalPoint() walks you to */
  const t = ctx.city?.doorPosition?.(dest) || g.data.locationById[dest].world;
  const rows = [];
  for (const yawDeg of [0, 90, 180, 270]) {
    wl.rotation.y = yawDeg * Math.PI / 180;
    for (let i = 0; i < 80; i++) ctx.ui.update(0.05);      // settle the damp
    const el = document.querySelector('.w-ptr .arw');
    const m = /rotate\(([-0-9.]+)deg\)/.exec(el?.style.transform || '');
    const dx = t.x - wl.position.x, dz = t.z - wl.position.z;
    const y = wl.rotation.y;
    const fx = Math.sin(y), fz = Math.cos(y);
    const want = Math.atan2(dx * -fz + dz * fx, dx * fx + dz * fz) * 180 / Math.PI;
    rows.push({
      yaw: yawDeg,
      shown: m ? +(+m[1]).toFixed(1) : null,
      want: +want.toFixed(1),
      text: document.querySelector('.w-ptr .d')?.textContent || '',
      name: document.querySelector('.w-ptr .t')?.textContent || '',
    });
  }
  /* and the resolver behind the quick-buy sheet */
  const E = g.economy;
  const probes = ['gold', 'WHEAT', 'b5y', 'team', 'trnk', 'berry'].map((q) => {
    const a = E.findByTicker(q);
    return a ? { q, tick: a.tick, n: a.n, ven: a.ven, ask: E.buyPrice(a.id) } : { q, miss: true };
  });
  const fuzzy = ['gol', 'rusty', 'gms', 'wheat'].map((q) => ({ q, hits: E.search(q, 3).map((a) => a.tick) }));
  return { rows, probes, fuzzy, wally: { x: +wl.position.x.toFixed(1), z: +wl.position.z.toFixed(1) } };
});

let bad = 0;
console.log(`Wally at (${out.wally.x}, ${out.wally.z}) — pointing at "${out.rows[0].name}"\n`);
for (const r of out.rows) {
  const d = Math.abs(((r.shown - r.want + 540) % 360) - 180);
  const ok = d < 2.5;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  yaw ${String(r.yaw).padStart(3)}°   arrow ${String(r.shown).padStart(7)}°   expected ${String(r.want).padStart(7)}°   "${r.text}"`);
}
console.log('\nticker resolve:');
for (const p of out.probes) console.log('  ' + (p.miss ? `MISS ${p.q}` : `${p.q.padEnd(6)} -> ${p.tick.padEnd(6)} ${p.n} @ ${p.ven} ask $${p.ask}`));
console.log('\nfuzzy search:');
for (const f of out.fuzzy) console.log(`  ${f.q.padEnd(6)} -> ${f.hits.join(', ')}`);
if (errs.length) { console.log('\nCONSOLE ERRORS:'); errs.slice(0, 8).forEach((e) => console.log('  ' + e)); }

await browser.close();
server.close();
console.log(bad || errs.length ? `\nFAIL — ${bad} bearings wrong, ${errs.length} errors` : '\nPASS — the pointer points at it');
process.exit(bad || errs.length ? 1 : 0);
