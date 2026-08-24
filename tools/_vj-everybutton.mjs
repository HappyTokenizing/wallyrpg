/* EVERY focusable pad button, one at a time: genuine Tab on to it, then
   a genuine Space — does the button's OWN verb run?

   Why this exists separately: "the keyboard still works" was being
   carried by two buttons (Menu with Space, Phone with Enter). Five of
   the seven were never keyed at all, and the refusal added by this fix
   lives in a handler shared by all of them, so a per-button sweep is
   the only thing that says the shared handler is intact everywhere.

   Each button gets an observable of its own — a NAMED panel, a jump
   peak, or a counted call — because "something changed" is how a sweep
   goes green on the one button that already had a sheet up. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctx.newPage();
let fails = 0;
const ok = (c, m, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${x ? '\n        ' + x : ''}`); };
page.on('pageerror', e => { console.log('PAGEERROR', e.message.split('\n')[0]); fails++; });
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(3500);
const B = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });

/* count the one verb that has no panel of its own */
const armCount = () => page.evaluate(() => {
  if (window.__icOn) { window.__ic = 0; return true; }
  const ui = WALLY.ctx.ui, orig = ui.interact.bind(ui);
  window.__ic = 0; window.__icOn = true;
  ui.interact = (...a) => { window.__ic++; return orig(...a); };
  return true;
});
const reset = async () => {
  await page.evaluate((b) => { WALLY.ctx.ui.closeAll(); WALLY.debug.hideUI(false);
    WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {}); document.activeElement?.blur?.(); }, B);
  await page.waitForTimeout(650);
};
const focusLabel = () => page.evaluate(() => {
  const a = document.activeElement;
  return (!a || a === document.body) ? null : (a.getAttribute?.('aria-label') || a.className || a.tagName);
});
const labels = await page.evaluate(() =>
  [...document.querySelectorAll('.w-abtn')].map((e) => e.getAttribute('aria-label')));
console.log('pad buttons:', JSON.stringify(labels));

await armCount();
const rows = [];
for (const L of labels) {
  await reset();
  await armCount();
  let f = null, tabs = 0;
  for (; tabs < 40; tabs++) { await page.keyboard.press('Tab'); await page.waitForTimeout(55); f = await focusLabel(); if (f === L) break; }
  const reached = f === L;
  await page.evaluate(() => {
    window.__pk = { max: -1e9, on: true };
    const t = () => { if (!window.__pk.on) return;
      const c = WALLY.ctx.wally.controller, v = c && (c.velocity || c.vel);
      if (v && v.y > window.__pk.max) window.__pk.max = v.y;
      requestAnimationFrame(t); };
    requestAnimationFrame(t);
  });
  await page.keyboard.press('Space');
  await page.waitForTimeout(750);
  const r = await page.evaluate(() => { window.__pk.on = false;
    return { peak: +window.__pk.max.toFixed(2), panels: WALLY.ctx.ui.panels.slice(), ic: window.__ic }; });
  rows.push({ L, reached, tabs: tabs + 1, ...r });
  console.log('  ', JSON.stringify(rows.at(-1)));
}
const by = (n) => rows.find((r) => r.L === n);
ok(rows.every((r) => r.reached), 'SWEEP-pre [every pad button is genuinely reachable by Tab]: sequential navigation lands on all of them, so no row below is green by never having been tried', JSON.stringify(rows.map((r) => [r.L, r.tabs])));
for (const [name, want] of [['Phone', 'phone'], ['Menu', 'pause']]) {
  const r = by(name);
  ok(r && r.panels.length === 1 && r.panels[0] === want,
    `SWEEP ${name} [BRANCH: detail-0 click with driving false — the shared handler]: Tab on to ${name}, press Space, and the ${want} sheet opens. NAMED, not counted`, JSON.stringify(r));
}
for (const name of ['Desk', 'Places']) {
  const r = by(name);
  ok(r && r.panels.length >= 1,
    `SWEEP ${name} [same branch, the two shortcuts nothing else covers]: Tab on to ${name}, press Space, and its sheet opens`, JSON.stringify(r));
}
const j = by('Jump');
ok(j && j.peak > 1.0, 'SWEEP Jump [BRANCH: the jump button’s own detail-0 path]: Tab on to Jump and press Space — he leaves the ground. Measured as a peak over the arc, not a sample at a fixed delay', JSON.stringify(j));
const e = rows.find((r) => /enter|talk/i.test(r.L));
ok(e && e.ic >= 1, 'SWEEP Enter/talk [BRANCH: the one verb with no sheet of its own]: Tab on to the action button and press Space — ui.interact() is CALLED. Counted at the verb, because in open ground it has nothing to open and "no panel appeared" is indistinguishable from a dead button', JSON.stringify(e));
console.log(`\n${fails ? 'FAIL' : 'OK'} — ${fails} failing`);
await browser.close(); server.close(); process.exit(fails ? 1 : 0);
