/* _vjidle3.mjs — the last two, taken without the harness getting in the way.
     · the whole fade-in, sampled every frame from inside the page, so the
       claim is about EVERY frame of the 0.42 s and not one round trip
     · the pause sheet, driven onto the sheet's OWN button rather than an
       injected probe that lost the hit test */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => { const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b); }
  catch { rs.writeHead(404).end(); } });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
let fails = 0;
const ok = (c, m, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${x ? '   ' + x : ''}`); return c; };
const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctxM.newPage();
page.on('pageerror', e => { console.log('PAGEERROR', e.message.split('\n')[0]); fails++; });
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 60000 });
await page.waitForTimeout(3500);
const cdp = await ctxM.newCDPSession(page);
const t1 = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type,
  touchPoints: (type === 'touchEnd') ? [] : [{ x, y, id: 1, radiusX: 14, radiusY: 14, force: 1 }] });
const idleSet = (s) => page.evaluate((v) => WALLY.debug.idle(v), s);
const padRead = () => page.evaluate(() => { const o = (s) => { const el = document.querySelector(s);
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return { op: +(+cs.opacity).toFixed(3), visible: cs.visibility === 'visible' && +cs.opacity > 0.02 && r.width > 0 }; };
  return { stick: o('.w-stickzone'), acts: o('.w-acts'), idle: WALLY.debug.idle() }; });
const gone = (p) => !p.stick.visible && !p.acts.visible;
const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const open = () => page.evaluate((b) => { WALLY.ctx.ui.closeAll(); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {}); return null; }, BOOT);
await open(); await page.waitForTimeout(900);
await page.evaluate(() => { WALLY.debug.hideUI(true); return null; });
await page.waitForTimeout(600);
const D = 1.4; await idleSet(D);
const goIdle = async () => { await page.waitForTimeout(D * 1000 + 900); return padRead(); };
const jumpPt = await page.evaluate(() => { const r = document.querySelector('.w-abtn.jump').getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; });

/* ===== A. EVERY FRAME OF THE FADE-IN ===== */
let p = await goIdle();
ok(gone(p), 'X-1 [re-arm for the whole-fade sweep]');
await page.evaluate(([x, y]) => {
  window.__f = [];
  const acts = document.querySelector('.w-acts');
  const loop = () => { const i = WALLY.debug.idle();
    const e = document.elementFromPoint(x, y);
    window.__f.push({ op: +(+getComputedStyle(acts).opacity).toFixed(3), live: i.live, hidden: i.hidden,
      onPad: !!(e && e.closest && e.closest('.w-acts, .w-stickzone')) });
    if (window.__f.length < 90) requestAnimationFrame(loop); };
  requestAnimationFrame(loop); return null;
}, jumpPt);
await t1('touchStart', jumpPt[0], jumpPt[1]); await t1('touchEnd', jumpPt[0], jumpPt[1]);
await t1('touchStart', jumpPt[0], jumpPt[1]); await t1('touchEnd', jumpPt[0], jumpPt[1]);
await page.waitForTimeout(1600);
const f = await page.evaluate(() => window.__f);
const fading = f.filter(s => s.hidden === false && s.op > 0 && s.op < 1);
const bad = f.filter(s => s.live === false && s.onPad === true);
const liveFrames = f.filter(s => s.live === true && s.hidden === false);
ok(fading.length >= 5 && bad.length === 0,
  'X-2 [.w-idlewake across the WHOLE fade-in]: every frame of the 0.42 s cross-fade was sampled and not one of them had a part-opacity control winning the hit test',
  `${f.length} frames, ${fading.length} of them mid-fade (opacity ${fading.length ? fading[0].op + '..' + fading[fading.length - 1].op : '-'}), ${bad.length} pressable-while-inert`);
ok(liveFrames.length > 0 && liveFrames.every(s => s.op > 0.99) && liveFrames.some(s => s.onPad),
  'X-3 [live only at full opacity, in both directions]: the pad became hit-testable only after opacity reached 1',
  `first live frame opacity ${liveFrames.length ? liveFrames[0].op : '-'}`);

/* ===== B. THE PAUSE SHEET'S OWN BUTTON ===== */
await open(); await page.waitForTimeout(700);
p = await goIdle();
ok(gone(p), 'X-4 [faded, before the pause sheet opens]');
await page.evaluate(() => { WALLY.ctx.ui.show('pause'); return null; });
await page.waitForTimeout(900);
const btn = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.w-pause button')].find(x => /resume/i.test(x.textContent || ''))
    || document.querySelector('.w-pause button');
  const r = b.getBoundingClientRect();
  const pt = [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
  window.__b = { down: 0, click: 0 };
  b.addEventListener('pointerdown', () => window.__b.down++, true);
  b.addEventListener('click', () => window.__b.click++, true);
  const e = document.elementFromPoint(pt[0], pt[1]);
  return { pt, label: (b.textContent || '').trim().slice(0, 20), wins: !!(e && e.closest && e.closest('button') === b),
    why: WALLY.debug.idle().why, hidden: WALLY.debug.idle().hidden };
});
await t1('touchStart', btn.pt[0], btn.pt[1]); await t1('touchEnd', btn.pt[0], btn.pt[1]);
await t1('touchStart', btn.pt[0], btn.pt[1]); await t1('touchEnd', btn.pt[0], btn.pt[1]);
await page.waitForTimeout(700);
const bc = await page.evaluate(() => window.__b);
ok(btn.wins && btn.why === 'modal' && btn.hidden === false,
  'X-5 [idleSuspended() == modal]: the pause sheet suspends the clock, restores the controls behind it, and its own button is the hit-test winner',
  `"${btn.label}", why ${btn.why}`);
ok(bc.down === 2 && bc.click === 2,
  'X-6 [tapDown early-return under a sheet]: with the pause sheet open over faded controls BOTH taps of a double tap reach the sheet\'s own button',
  `"${btn.label}": ${JSON.stringify(bc)}`);
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); return null; });
await idleSet(null);
console.log(fails ? `\nFAIL — ${fails} red.` : '\nPASS — every assertion green.');
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
