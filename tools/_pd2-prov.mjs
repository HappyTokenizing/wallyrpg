/* _pd2-prov.mjs — which discriminators actually discriminate.
   E1 isTrusted on a focusin from a script focus() vs a real Tab.
   E2 is focusin dispatched SYNCHRONOUSLY inside focus()? (decides whether a
      bare boolean around the call is enough, or a token is needed)
   E3 what is the last trusted INPUT event at the moment of the detail-0 click? */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
const LOAD = () => execSync('uptime').toString().trim().split('load averages:')[1].trim();
console.log('load at start:', LOAD());

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctxM.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 120000 });
await page.waitForTimeout(3500);

const cdp = await ctxM.newCDPSession(page);
const P = (x, y) => [{ x, y, id: 1, radiusX: 14, radiusY: 14, force: 1 }];
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent',
  { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : P(x, y) });
const tap = async (x, y, h = 60) => { await touch('touchStart', x, y); await page.waitForTimeout(h); await touch('touchEnd', x, y); };

/* instrument: record every focusin on the pad with its trust + a marker set
   immediately before any script focus(), plus the last trusted input event */
await page.evaluate(() => {
  const w = window; w.__prov = { focusins: [], sync: null };
  w.__lastInput = null;
  for (const t of ['keydown', 'pointerdown', 'mousedown', 'touchstart']) {
    document.addEventListener(t, (e) => {
      if (!e.isTrusted) return;
      w.__lastInput = { type: t, pt: e.pointerType || null, key: e.key || null, t: +performance.now().toFixed(1) };
    }, true);
  }
  document.addEventListener('focusin', (e) => {
    if (!e.target?.closest?.('.w-touch')) return;
    w.__prov.focusins.push({
      trusted: e.isTrusted,
      inFocusCall: !!w.__inFocusCall,          // set by the E2 probe below
      label: e.target.getAttribute?.('aria-label') || null,
      lastInput: w.__lastInput,
    });
  }, true);
  document.addEventListener('click', (e) => {
    if (e.detail !== 0) return;
    if (!e.target?.closest?.('.w-touch')) return;
    w.__prov.detail0 = { label: e.target.getAttribute?.('aria-label') || null, lastInput: w.__lastInput };
  }, true);
});

const menuC = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.w-abtn')].find(e => e.getAttribute('aria-label') === 'Menu');
  const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
const jumpC = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.w-abtn')].find(e => e.getAttribute('aria-label') === 'Jump');
  const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});

/* ---- E1a: a REAL Tab onto a pad button ---- */
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); window.__prov.focusins.length = 0; });
await page.waitForTimeout(300);
for (let i = 0; i < 60; i++) {
  await page.keyboard.press('Tab');
  const f = await page.evaluate(() => { const a = document.activeElement;
    return { l: a?.getAttribute?.('aria-label'), inPad: !!a?.closest?.('.w-touch') }; });
  if (f.inPad && f.l === 'Menu') break;
}
const e1a = await page.evaluate(() => window.__prov.focusins.slice(-1)[0]);

/* ---- E1b + E2: a SCRIPT focus() on the same button ---- */
const e1b = await page.evaluate(() => {
  document.activeElement?.blur?.();
  const w = window; w.__prov.focusins.length = 0;
  const b = [...document.querySelectorAll('.w-abtn')].find(e => e.getAttribute('aria-label') === 'Menu');
  w.__inFocusCall = true;
  b.focus({ preventScroll: true });
  const during = w.__prov.focusins.length;          // E2: did it fire INSIDE focus()?
  w.__inFocusCall = false;
  return { during, rec: w.__prov.focusins.slice(-1)[0] };
});

/* ---- E3: last trusted input at the detail-0 click that Space produces ---- */
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); });
await page.waitForTimeout(400);
for (let i = 0; i < 60; i++) {
  await page.keyboard.press('Tab');
  const f = await page.evaluate(() => { const a = document.activeElement;
    return { l: a?.getAttribute?.('aria-label'), inPad: !!a?.closest?.('.w-touch') }; });
  if (f.inPad && f.l === 'Menu') break;
}
await tap(jumpC.x, jumpC.y, 110);                    // real finger: player is on thumbs
await page.waitForTimeout(350);
const beforeSpace = await page.evaluate(() => window.__lastInput);
await page.evaluate(() => { window.__prov.detail0 = null; });
await page.keyboard.press('Space');
await page.waitForTimeout(500);
const e3 = await page.evaluate(() => ({ d0: window.__prov.detail0, last: window.__lastInput }));

console.log('\nE1a  focusin from a REAL Tab        ', JSON.stringify(e1a));
console.log('E1b  focusin from a SCRIPT focus()  ', JSON.stringify(e1b.rec));
console.log('E2   focusins dispatched INSIDE focus():', e1b.during, '(1 = synchronous)');
console.log('\nE3   last trusted input BEFORE Space:', JSON.stringify(beforeSpace));
console.log('E3   at the detail-0 click          :', JSON.stringify(e3.d0));
console.log('\nload at end:', LOAD());
await browser.close(); server.close();
