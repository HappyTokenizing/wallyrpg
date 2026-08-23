/* _gb10i.mjs — the headline finding, with the control that isolates its cause. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => { const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b); } catch { rs.writeHead(404).end(); } });
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
await page.evaluate(() => {
  window.__stamp = () => [...document.querySelectorAll('.w-touch .w-abtn')].forEach(b => b.setAttribute('data-pad', b.getAttribute('aria-label')));
  window.__stamp();
  window.__desc = (a) => !a || a === document.body ? 'BODY' : (a.getAttribute?.('data-pad') ? `PAD:${a.getAttribute('data-pad')}`
    : a.classList?.contains('w-pause') ? 'PANEL:pause' : `${a.tagName}.${String(a.className).split(' ').filter(Boolean).join('.')}`);
});
const key = async (k, code, kc) => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
  if (k.length === 1) await cdp.send('Input.dispatchKeyEvent', { type: 'char', key: k, text: k, unmodifiedText: k }).catch(() => {});
  await page.waitForTimeout(25);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
  await page.waitForTimeout(40); };
const tab = () => key('Tab', 'Tab', 9), space = () => key(' ', 'Space', 32);
const who = () => page.evaluate(() => window.__desc(document.activeElement));
const stk = () => page.evaluate(() => ({ modal: WALLY.ctx.ui.modal, panels: WALLY.ctx.ui.panels.slice() }));
const kb = () => page.evaluate(() => WALLY.debug.padKeyboard());
const P = (x, y, id = 1) => [{ x, y, id, radiusX: 14, radiusY: 14, force: 1 }];
const tap = async (x, y, hold = 80, settle = 800) => {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: P(x, y) });
  await page.waitForTimeout(hold);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(settle); };
const padBtn = (l) => page.evaluate((l) => { const b = document.querySelector(`.w-touch .w-abtn[data-pad="${l}"]`);
  if (!b) return null; const r = b.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const t = document.elementFromPoint(cx, cy); return { x: cx, y: cy, onTop: !!(t && b.contains(t)) }; }, l);
const reset = async () => {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.hideUI(false); window.__stamp(); });
  await page.waitForTimeout(500);
  await page.evaluate(() => { document.activeElement?.blur?.(); });
  await page.waitForTimeout(400);
  pre(!(await stk()).modal && (await who()) === 'BODY', 'clean slate'); };
const tabToPad = async (l, max = 90) => { for (let i = 0; i < max; i++) { await tab(); if ((await who()) === `PAD:${l}`) return i + 1; } return null; };
const fingerClose = async () => {
  const c = await page.evaluate(() => {
    const s = [...document.querySelectorAll('.w-panels > .w-pause, .w-panels > .w-sheet')].pop(); if (!s) return null;
    const b = [...s.querySelectorAll('button')].find(b => /close|back|resume|done|✕|×/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')) && b.getClientRects().length);
    if (!b) return null; const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, lab: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 12) }; });
  if (!c) return null; await tap(c.x, c.y, 80, 950); return c; };

/* ONE trial: optionally Tab to Menu first, then a PURE FINGER sequence. */
async function trial(tabFirst) {
  await reset();
  let base = 'BODY';
  if (tabFirst) { const n = await tabToPad('Menu'); base = await who();
    if (!pre(base === 'PAD:Menu', 'tabbed to Menu', String(n))) return null; }
  const jb = await padBtn('Jump'); if (!pre(jb && jb.onTop, 'Jump tappable', JSON.stringify(jb))) return null;
  await tap(jb.x, jb.y, 90, 500);
  const k1 = await kb();
  const mb = await padBtn('Menu'); if (!pre(mb && mb.onTop, 'Menu tappable', JSON.stringify(mb))) return null;
  await tap(mb.x, mb.y, 90, 800);
  const s1 = await stk(); if (!pre(s1.panels.length > 0, 'thumb opened the pause sheet', JSON.stringify(s1))) return null;
  const c = await fingerClose();
  const s2 = await stk(); if (!pre(c && !s2.panels.length, 'finger-closed it', `${JSON.stringify(c)} ${JSON.stringify(s2)}`)) return null;
  const k2 = await kb();
  await space(); await page.waitForTimeout(450);
  const out = await stk();
  return { base, k1, k2, closedVia: c.lab, after: await who(), spaceOpenedTheMenu: !!out.modal, panels: out.panels };
}

console.log('\n=== EVERY EVENT BELOW THE FIRST TAB IS A REAL FINGER. NO KEY IS PRESSED UNTIL THE FINAL SPACE. ===');
for (const round of [1, 2]) {
  for (const tabFirst of [false, true]) {
    const r = await trial(tabFirst);
    if (!r) { console.log(`  (round ${round}, tabFirst=${tabFirst}) skipped`); continue; }
    const name = tabFirst ? 'TABBED ONCE, then thumbs' : 'CONTROL: never tabbed  ';
    console.log(`\n  [${name}] round ${round}`);
    console.log(`     after thumb on Jump : ${JSON.stringify(r.k1)}`);
    console.log(`     after finger-close "${r.closedVia}" : ${JSON.stringify(r.k2)}  focus ${r.after}`);
    console.log(`     the player's next SPACE -> ${r.spaceOpenedTheMenu ? 'OPENED THE PAUSE SHEET' : 'went to the game (jump)'}  panels ${JSON.stringify(r.panels)}`);
    if (tabFirst) {
      ok(r.k2.driving === true, `HEADLINE r${round} [the sheet restore must not un-say the player's thumbs]`,
        `driving ${r.k1.driving} -> ${r.k2.driving}, padTakesSpace ${r.k2.padTakesSpace}`);
      ok(!r.spaceOpenedTheMenu, `HEADLINE r${round}-b [Space still means JUMP after a thumb-only open/close]`, `panels ${JSON.stringify(r.panels)}`);
    } else {
      ok(r.k2.driving === true, `CONTROL r${round} [a player who never tabbed keeps driving — this is the arm that isolates the cause]`, JSON.stringify(r.k2));
      ok(!r.spaceOpenedTheMenu, `CONTROL r${round}-b [and their Space jumps]`, `panels ${JSON.stringify(r.panels)}`);
    }
  }
}
console.log(`\n${fails} FAIL / ${rig} unmet preconditions`);
await browser.close(); server.close(); process.exit(0);
