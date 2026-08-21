#!/usr/bin/env node
/* _uj-flow.mjs — UI AGENT probe: drive the two new flows for real.

   1  BUY A TICKER. Open the quick-buy sheet, type "gold", press the
      confirm button, and check the inventory and the cash actually
      moved — the button, not the API behind it.
   2  BUY AND EQUIP THE BICYCLE. Click Buy on the Dispatch place
      panel, then Equip on the fare board, then check game.fares()
      reports the bike as takeable.

   Not part of the gate; a "does the button do the thing" check.
*/
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const b = await readFile(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(b);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb',
    '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?shot=1&quality=low`);
await page.waitForFunction('window.__WALLY_READY__', null, { timeout: 120000 });
await page.waitForTimeout(1200);

const checks = [];
const ok = (pass, name, note = '') => { checks.push({ pass, name, note }); };

/* ---------- 1. buy a ticker through the sheet ---------- */
const buy = await page.evaluate(async () => {
  const g = WALLY.ctx.game, s = g.state;
  s.known.mineral = true; s.unlocks.mineral = true; s.money = 5000;
  s.flags.tip_ticker = true;
  g.enter('mineral');
  WALLY.debug.uiBuy('gold');
  await new Promise((r) => setTimeout(r, 120));
  const before = { money: s.money, gold: g.economy.owned('gold') };
  const plus = document.querySelectorAll('.w-qty .stp')[1];
  plus.click(); plus.click();                       // qty 3
  const btn = [...document.querySelectorAll('.w-tkt .w-btn.prim')][0];
  const label = btn ? btn.textContent.replace(/\s+/g, ' ').trim() : null;
  btn?.click();
  await new Promise((r) => setTimeout(r, 120));
  return { before, after: { money: s.money, gold: g.economy.owned('gold') }, label };
});
ok(buy.after.gold - buy.before.gold === 3, 'quick-buy: the button bought 3 units',
  `${buy.before.gold} -> ${buy.after.gold}`);
ok(buy.before.money - buy.after.money > 900, 'quick-buy: cash left the wallet',
  `$${buy.before.money} -> $${buy.after.money}`);
/* the chip's "3×" and "GOLD" are separate nodes with a CSS gap, so
   textContent has no space between them — match on the parts */
ok(/^Buy\s*3×\s*GOLD\s*·\s*\$1,008$/.test(buy.label || ''),
  'quick-buy: the button names the ticket', buy.label);

/* ---------- 2. the bicycle ---------- */
const bike = await page.evaluate(async () => {
  const g = WALLY.ctx.game, s = g.state;
  const out = {};
  s.money = 400;
  g.enter('trunkdepot');
  WALLY.ctx.ui.closeAll();
  WALLY.debug.ui('place', 'trunkdepot');
  await new Promise((r) => setTimeout(r, 120));
  const buyBtn = [...document.querySelectorAll('.w-sheet .w-btn')]
    .find((b) => b.textContent.trim() === 'Buy');
  out.foundBuy = !!buyBtn;
  buyBtn?.click();
  await new Promise((r) => setTimeout(r, 150));
  out.owned = g.state.bike.owned;
  out.equippedAfterBuy = g.state.bike.equipped;

  WALLY.ctx.ui.closeAll();
  g.state.bike.equipped = false;                    // pretend he left it at home
  WALLY.debug.ui('travel', 'cafe');
  await new Promise((r) => setTimeout(r, 150));
  const eq = [...document.querySelectorAll('.w-sheet .w-btn')]
    .find((b) => b.textContent.trim() === 'Equip');
  out.foundEquip = !!eq;
  eq?.click();
  await new Promise((r) => setTimeout(r, 150));
  out.equipped = g.state.bike.equipped;
  const f = g.fares('cafe').find((x) => x.mode === 'bike');
  out.fare = f && { ok: f.ok, why: f.why, mins: f.mins, energy: f.energy, cost: f.cost };
  return out;
});
ok(bike.foundBuy, 'bicycle: a Buy button exists at Dispatch');
ok(bike.owned, 'bicycle: clicking it bought the bicycle');
ok(bike.equippedAfterBuy, 'bicycle: buying it also puts it under you');
ok(bike.foundEquip, 'bicycle: the fare board offers Equip when it is at home');
ok(bike.equipped, 'bicycle: Equip put it back under him');
ok(bike.fare && bike.fare.ok, 'bicycle: the fare board now takes it',
  JSON.stringify(bike.fare));

/* ---------- 3. the map is drawn, and clickable ---------- */
const map = await page.evaluate(async () => {
  WALLY.ctx.ui.closeAll();
  WALLY.debug.ui('places');
  await new Promise((r) => setTimeout(r, 200));
  const svg = document.querySelector('.w-map-svg');
  return {
    pins: svg ? svg.querySelectorAll('[data-loc]').length : 0,
    zones: svg ? svg.querySelectorAll('path').length : 0,
    me: !!svg?.querySelector('.wm-me'),
  };
});
ok(map.pins === 28, 'map: all 28 locations are on it', map.pins + ' pins');
ok(map.zones >= 10, 'map: the districts are drawn', map.zones + ' paths');
ok(map.me, 'map: Wally is marked on it');

await browser.close();
server.close();
let bad = 0;
for (const c of checks) {
  if (!c.pass) bad++;
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.note ? '   ' + c.note : ''}`);
}
if (errs.length) { console.log('\nCONSOLE ERRORS:'); errs.slice(0, 6).forEach((e) => console.log('  ' + e)); }
console.log(bad || errs.length ? `\nFAIL — ${bad} checks, ${errs.length} errors` : '\nPASS — buying and the bicycle both work from the buttons');
process.exit(bad || errs.length ? 1 : 0);
