/* _gb10g.mjs — ROUND EIGHT: double-fire, nesting, dialogue, and the in-panel drop. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => { const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b);
  } catch { rs.writeHead(404).end(); } });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctxM.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(3500);
const cdp = await ctxM.newCDPSession(page);
let fails = 0, rig = 0;
const ok = (c, m, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${x ? '\n            ' + x : ''}`); return c; };
const pre = (c, m, x = '') => { if (!c) { rig++; console.log(`RIG?  ${m}   ${x}`); } return c; };
const note = (m) => console.log('      ' + m);
await page.evaluate(() => {
  window.__stamp = () => [...document.querySelectorAll('.w-touch .w-abtn')].forEach(b => b.setAttribute('data-pad', b.getAttribute('aria-label')));
  window.__stamp();
  window.__desc = (a) => !a || a === document.body ? 'BODY'
    : (a.getAttribute?.('data-pad') ? `PAD:${a.getAttribute('data-pad')}`
      : a.classList?.contains('w-phone') ? 'PANEL:phone' : a.classList?.contains('w-pause') ? 'PANEL:pause'
        : a.classList?.contains('w-sheet') ? 'PANEL:sheet'
          : (a.getAttribute?.('aria-label') ? `"${a.getAttribute('aria-label')}"` : `${a.tagName}.${String(a.className).split(' ').filter(Boolean).join('.')}`));
  window.__hits = [];
  const ui = WALLY.ctx.ui;
  for (const n of ['openPhone', 'openDesk', 'show', 'interact']) {
    const f = ui[n]; if (typeof f !== 'function') continue;
    ui[n] = function (...a) { window.__hits.push(n + '(' + a.map(String).join(',') + ')'); return f.apply(this, a); }; }
});
const key = async (k, code, kc) => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
  if (k.length === 1) await cdp.send('Input.dispatchKeyEvent', { type: 'char', key: k, text: k, unmodifiedText: k }).catch(() => {});
  await page.waitForTimeout(25);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
  await page.waitForTimeout(40); };
const tab = () => key('Tab', 'Tab', 9), esc = () => key('Escape', 'Escape', 27), space = () => key(' ', 'Space', 32);
const who = () => page.evaluate(() => window.__desc(document.activeElement));
const stk = () => page.evaluate(() => ({ modal: WALLY.ctx.ui.modal, panels: WALLY.ctx.ui.panels.slice() }));
const hits = () => page.evaluate(() => window.__hits.slice());
const P = (x, y, id = 1) => [{ x, y, id, radiusX: 14, radiusY: 14, force: 1 }];
const tap = async (x, y, hold = 70, settle = 800) => {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: P(x, y) });
  await page.waitForTimeout(hold);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(settle); };
const padBtn = (l) => page.evaluate((l) => { const b = document.querySelector(`.w-touch .w-abtn[data-pad="${l}"]`);
  if (!b) return null; const r = b.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const t = document.elementFromPoint(cx, cy); return { x: cx, y: cy, w: Math.round(r.width), onTop: !!(t && b.contains(t)) }; }, l);
const reset = async () => {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.hideUI(false); window.__stamp(); });
  await page.waitForTimeout(500);
  await page.evaluate(() => { document.activeElement?.blur?.(); window.__hits = []; });
  await page.waitForTimeout(400);
  const s = await stk(), w = await who();
  pre(!s.modal && w === 'BODY' && !s.panels.length, 'clean slate', `${w} ${JSON.stringify(s)}`);
  await page.evaluate(() => { window.__hits = []; }); };
const tabToPad = async (l, max = 90) => { for (let i = 0; i < max; i++) { await tab(); if ((await who()) === `PAD:${l}`) return i + 1; } return null; };

console.log('\n===== 3. THE KEYBOARD DROPPED *INSIDE* AN OPEN MODAL =====');
/* Escape on the phone with an app open runs phone.home() and does NOT close
   the sheet. Where does the keyboard go? */
await reset();
const n3 = await tabToPad('Places'); const base3 = await who();
if (pre(base3 === 'PAD:Places', 'tabbed to Places', String(n3))) {
  await space(); await page.waitForTimeout(700);
  const inPanel = await who(); const s1 = await stk();
  if (pre(s1.panels.length > 0, 'phone open on the places app', JSON.stringify(s1))) {
    await esc(); await page.waitForTimeout(900);
    const after = await who(); const s2 = await stk();
    console.log(`  Places: ${base3} --Space--> ${inPanel}  --Esc(phone.home)-->  ${after}   panels ${JSON.stringify(s2.panels)}`);
    ok(after !== 'BODY' || !s2.panels.length,
      '3 [navigating INSIDE an open aria-modal dialog must not drop the keyboard to <body>]',
      `the phone is still open (${JSON.stringify(s2.panels)}) and the keyboard is on ${after}`);
    const nextTab = await (async () => { await tab(); return who(); })();
    note(`the next Tab from there lands on: ${nextTab}`);
  }
}
console.log(`\n${fails} FAIL / ${rig} unmet preconditions`);
await browser.close(); server.close(); process.exit(0);
