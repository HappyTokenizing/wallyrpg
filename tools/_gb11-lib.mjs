/* _gb11-lib.mjs — ROUND TEN gesture breaker: shared driver.
   Real CDP Input.dispatch{Touch,Mouse,Key}Event at 390x844, hasTouch,
   isMobile. Never element.click() except where a detail-0 activation
   is the thing under test and is labelled as such. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';

export const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

export const load = () => {
  const up = execSync('uptime').toString();
  return up.split('load averages:')[1].trim();
};
export const cpus = () => execSync('sysctl -n hw.ncpu').toString().trim();

export async function boot({ url = '/index.html?skipIntro', settle = 3500 } = {}) {
  const server = createServer(async (rq, rs) => {
    const c = decodeURIComponent(rq.url.split('?')[0]);
    try {
      const b = await readFile(ROOT + (c === '/' ? '/index.html' : c));
      rs.writeHead(200, { 'content-type': MIME[c.slice(c.lastIndexOf('.'))] || 'application/octet-stream' });
      rs.end(b);
    } catch { rs.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
  const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  const page = await ctxM.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message.split('\n')[0]));
  await page.goto(`http://127.0.0.1:${port}${url}`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 90000 });
  await page.waitForTimeout(settle);
  const cdp = await ctxM.newCDPSession(page);
  await page.evaluate(() => { WALLY.debug.hideUI(false); WALLY.ctx.ui.closeAll(); });
  await page.waitForTimeout(400);
  return { server, browser, ctxM, page, cdp, errs,
    close: async () => { await browser.close(); server.close(); } };
}

export function driver(page, cdp) {
  const wait = (ms) => page.waitForTimeout(ms);
  const P = (x, y, id = 1) => [{ x, y, id, radiusX: 14, radiusY: 14, force: 1 }];
  const touch = (t, x, y, id = 1) => cdp.send('Input.dispatchTouchEvent', {
    type: t, touchPoints: (t === 'touchEnd' || t === 'touchCancel') ? [] : P(x, y, id) });
  const touchMulti = (t, pts) => cdp.send('Input.dispatchTouchEvent', { type: t, touchPoints: pts });
  const KEYS = {
    Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    KeyP: { key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, text: 'p' },
    KeyM: { key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77, text: 'm' },
    KeyO: { key: 'o', code: 'KeyO', windowsVirtualKeyCode: 79, text: 'o' },
    KeyE: { key: 'e', code: 'KeyE', windowsVirtualKeyCode: 69, text: 'e' },
    KeyW: { key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, text: 'w' },
  };
  const SHIFT = 8;
  const keyDown = (n, mods = 0, extra = {}) => cdp.send('Input.dispatchKeyEvent',
    { type: 'keyDown', modifiers: mods, ...KEYS[n], ...extra });
  const keyUp = (n, mods = 0) => cdp.send('Input.dispatchKeyEvent',
    { type: 'keyUp', modifiers: mods, ...KEYS[n], text: undefined });
  const key = async (n, h = 25, mods = 0) => { await keyDown(n, mods); await wait(h); await keyUp(n, mods); };
  const mouse = (t, x, y, btn = 'left', buttons = 1, clickCount = 1) => cdp.send('Input.dispatchMouseEvent',
    { type: t, x, y, button: btn, buttons, clickCount });

  const padKb = () => page.evaluate(() => WALLY.debug.padKeyboard());
  const restore = () => page.evaluate(() => WALLY.debug.focusRestore());
  const panels = () => page.evaluate(() => WALLY.ctx.ui.panels.slice());
  const focusNow = () => page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return { label: null, where: 'body' };
    const lab = a.getAttribute?.('aria-label') || (a.textContent || '').trim().slice(0, 18) || a.className || a.tagName;
    const sheet = a.closest?.('.w-sheet,.w-pause,.w-phone');
    return { label: lab, tag: a.tagName,
      where: a.closest?.('.w-touch') ? 'pad'
        : (sheet ? (sheet.classList.contains('out') ? 'DYING' : 'panel') : 'other') };
  });
  const padAt = (l) => page.evaluate((L) => {
    const b = [...document.querySelectorAll('.w-abtn')].find(e => e.getAttribute('aria-label') === L);
    if (!b) return null;
    const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, l);
  const stickAt = () => page.evaluate(() => {
    const b = document.querySelector('.w-stick') || document.querySelector('[class*="stick"]');
    if (!b) return null; const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  });
  const tabTo = async (l, max = 90) => {
    for (let i = 0; i < max; i++) {
      await key('Tab', 8); await wait(10);
      const f = await focusNow();
      if (f.where === 'pad' && f.label === l) return { ...f, tabs: i + 1 };
    }
    return null;
  };
  const reset = async () => {
    await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); });
    await wait(320);
  };
  const thumb = async (l, h = 70, after = 300) => {
    const c = await padAt(l); if (!c) return false;
    await touch('touchStart', c.x, c.y); await wait(h); await touch('touchEnd', c.x, c.y);
    await wait(after); return true;
  };
  const btnIn = (re, sel = '.w-pause button, .w-sheet button, .w-phone button') =>
    page.evaluate(([R, S]) => {
      const b = [...document.querySelectorAll(S)].find(e => new RegExp(R, 'i').test(e.textContent || ''));
      if (!b) return null; const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2,
        label: (b.textContent || '').trim().slice(0, 20) };
    }, [re, sel]);

  return { wait, touch, touchMulti, key, keyDown, keyUp, mouse, SHIFT, KEYS,
    padKb, restore, panels, focusNow, padAt, stickAt, tabTo, reset, thumb, btnIn, page, cdp };
}

/* an in-page focus ledger: every focusin, with a timestamp and where
   it landed, so an ordering claim is a record and not an inference. */
export async function installLedger(page) {
  await page.evaluate(() => {
    window.__L = [];
    window.__L0 = performance.now();
    if (window.__ledgerOn) return; window.__ledgerOn = true;
    document.addEventListener('focusin', (e) => {
      const a = e.target;
      const sheet = a.closest?.('.w-sheet,.w-pause,.w-phone');
      window.__L.push({ t: +(performance.now() - window.__L0).toFixed(1),
        el: a.getAttribute?.('aria-label') || (a.textContent || '').trim().slice(0, 14) || a.tagName,
        where: a.closest?.('.w-touch') ? 'pad' : (sheet ? (sheet.classList.contains('out') ? 'DYING' : 'panel') : 'other'),
        trusted: e.isTrusted });
    }, true);
    document.addEventListener('focusout', (e) => {
      window.__L.push({ t: +(performance.now() - window.__L0).toFixed(1), out: true,
        el: e.target.getAttribute?.('aria-label') || e.target.tagName });
    }, true);
  });
}
export const ledger = (page) => page.evaluate(() => { const l = window.__L.slice(); window.__L = []; window.__L0 = performance.now(); return l; });
