/* _gb10d.mjs — ROUND EIGHT: the two live questions, closed properly. */
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
  window.__ftrace = [];
  document.addEventListener('focusin', e => window.__ftrace.push('IN  ' + window.__desc(e.target)), true);
  const nat = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (...a) {
    const st = (new Error().stack || '').split('\n').slice(1, 4).map(s => s.trim().replace(/^at\s+/, '').replace(/https?:\/\/[^/]+/, '')).filter(s => !/HTMLElement.focus/.test(s))[0] || '?';
    window.__ftrace.push(`focus(${window.__desc(this)}) <- ${st}`); return nat.apply(this, a); };
});
const key = async (k, code, kc) => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
  if (k.length === 1) await cdp.send('Input.dispatchKeyEvent', { type: 'char', key: k, text: k, unmodifiedText: k }).catch(() => {});
  await page.waitForTimeout(25);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
  await page.waitForTimeout(40); };
const tab = () => key('Tab', 'Tab', 9), esc = () => key('Escape', 'Escape', 27), space = () => key(' ', 'Space', 32);
const who = () => page.evaluate(() => window.__desc(document.activeElement));
const trace = async () => (await page.evaluate(() => { const t = window.__ftrace.slice(); window.__ftrace.length = 0; return t; })).join('\n           ');
const P = (x, y, id = 1) => [{ x, y, id, radiusX: 14, radiusY: 14, force: 1 }];
const tap = async (x, y, hold = 70, settle = 800) => {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: P(x, y) });
  await page.waitForTimeout(hold);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(settle); };
const padBtn = (l) => page.evaluate((l) => { const b = document.querySelector(`.w-touch .w-abtn[data-pad="${l}"]`);
  if (!b) return null; const r = b.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const t = document.elementFromPoint(cx, cy); return { x: cx, y: cy, w: Math.round(r.width), onTop: !!(t && b.contains(t)) }; }, l);
const kb = () => page.evaluate(() => WALLY.debug.padKeyboard());
const stk = () => page.evaluate(() => ({ modal: WALLY.ctx.ui.modal, panels: WALLY.ctx.ui.panels.slice() }));
const reset = async () => {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.hideUI(false); window.__stamp(); });
  await page.waitForTimeout(500);
  await page.evaluate(() => { document.activeElement?.blur?.(); window.__ftrace.length = 0; });
  await page.waitForTimeout(400);
  const s = await stk(), w = await who();
  pre(!s.modal && w === 'BODY' && s.panels.length === 0, 'clean slate', `${w} ${JSON.stringify(s)}`);
  await page.evaluate(() => { window.__ftrace.length = 0; }); };
const tabToPad = async (l, max = 90) => { for (let i = 0; i < max; i++) { await tab(); if ((await who()) === `PAD:${l}`) return i + 1; } return null; };
/* close by the panel's OWN control, with a real finger */
const fingerClose = async () => {
  const c = await page.evaluate(() => {
    const s = [...document.querySelectorAll('.w-panels > .w-sheet, .w-panels > .w-pause, .w-panels > .w-phone')].pop();
    if (!s) return null;
    const b = [...s.querySelectorAll('button')].find(b => {
      const t = (b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '');
      return /close|back|resume|done|✕|×/i.test(t) && b.getClientRects().length; });
    if (!b) return { none: [...s.querySelectorAll('button')].slice(0, 8).map(b => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 14)) };
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, lab: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 16) }; });
  if (!c || c.none) return c;
  await tap(c.x, c.y, 80, 900);
  return c; };

console.log('\n===== 3. THE TABBED-THEN-THUMB PLAYER, PURE FINGER ROUND TRIP =====');
await reset();
const n3 = await tabToPad('Menu'); const base3 = await who();
if (pre(base3 === 'PAD:Menu', 'tabbed to Menu', `${n3} -> ${base3}`)) {
  const jb = await padBtn('Jump');
  if (pre(jb && jb.onTop, 'Jump tappable', JSON.stringify(jb))) {
    await tap(jb.x, jb.y, 90, 500);
    const k1 = await kb();
    ok(k1.driving && k1.padFocused, '3-setup [tabbed once, then thumbs: focus stays on Menu by design, driving is set]', JSON.stringify(k1));
    const mb = await padBtn('Menu');
    if (pre(mb && mb.onTop, 'Menu tappable', JSON.stringify(mb))) {
      await tap(mb.x, mb.y, 90, 800);
      const s1 = await stk();
      if (pre(s1.panels.length > 0, 'thumb opened the pause sheet', JSON.stringify(s1))) {
        await page.evaluate(() => { window.__ftrace.length = 0; });
        let g = 0, c = null;
        while ((await stk()).panels.length && g++ < 4) { c = await fingerClose(); if (!c || c.none) break; }
        const s2 = await stk(); const w2 = await who(); const k3 = await kb();
        console.log(`  closed with a finger via ${c && c.lab ? `"${c.lab}"` : JSON.stringify(c)} -> ${JSON.stringify(s2.panels)} focus ${w2}`);
        note(await trace());
        if (pre(!s2.panels.length, 'sheet really closed', JSON.stringify(s2))) {
          ok(k3.driving === true,
            '3 [NO KEYBOARD WAS TOUCHED IN THIS WHOLE SEQUENCE]: tab once, then thumb-Jump, thumb-Menu, thumb-close — the pad must still know the player is driving',
            `driving=${k3.driving}  padTakesSpace=${k3.padTakesSpace}  focus=${w2}`);
          await space(); await page.waitForTimeout(450);
          const out = await stk();
          ok(!out.modal, '3-b [and their next SPACE jumps rather than re-opening the sheet they just shut with a thumb]', JSON.stringify(out));
        }
      }
    }
  }
}
console.log(`\n${fails} FAIL / ${rig} unmet preconditions`);
await browser.close(); server.close(); process.exit(0);
