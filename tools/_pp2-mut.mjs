/* _pp2-mut.mjs — what mutation makes the tabbed-to pad button unfocusable when a sheet opens? */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try {
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' });
    rs.end(b);
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
const key = async (k, code, keyCode) => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  if (k.length === 1) await cdp.send('Input.dispatchKeyEvent', { type: 'char', key: k, text: k, unmodifiedText: k }).catch(() => {});
  await page.waitForTimeout(25);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await page.waitForTimeout(30);
};
const tab = () => key('Tab', 'Tab', 9);
const who = () => page.evaluate(() => {
  const a = document.activeElement;
  return a ? `${a.tagName}.${String(a.className).split(' ').join('.')}${a.getAttribute?.('aria-label') ? `[${a.getAttribute('aria-label')}]` : ''}` : 'null';
});

await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.hideUI(false); });
await page.waitForTimeout(600);
for (let i = 0; i < 80; i++) { await tab(); if (/Menu/.test(await who())) break; }
console.log('focus parked on:', await who());

/* snapshot every ancestor of the focused element + watch mutations on them */
await page.evaluate(() => {
  window.__snap = (tag) => {
    const a = window.__held;
    const out = [];
    for (let n = a; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      out.push({ n: n.tagName + '.' + String(n.className).split(' ').join('.'),
        vis: s.visibility, disp: s.display, op: s.opacity, inert: n.inert === true,
        ariaHidden: n.getAttribute('aria-hidden'), connected: n.isConnected });
    }
    return { tag, chain: out };
  };
  window.__held = document.activeElement;
  window.__mut = [];
  const mo = new MutationObserver((recs) => {
    for (const r of recs) {
      const t = r.target;
      if (!window.__held || !(t === window.__held || t.contains?.(window.__held))) continue;
      window.__mut.push({ type: r.type, attr: r.attributeName, old: r.oldValue,
        now: r.attributeName ? t.getAttribute(r.attributeName) : null,
        on: t.tagName + '.' + String(t.className).split(' ').join('.') });
    }
  });
  mo.observe(document.documentElement, { attributes: true, attributeOldValue: true, subtree: true, childList: true });
});
const before = await page.evaluate(() => window.__snap('BEFORE'));
console.log('\nBEFORE P:'); for (const c of before.chain) console.log('  ', JSON.stringify(c));

await key('p', 'KeyP', 80);
await page.waitForTimeout(500);
console.log('\nafter P -> focus is', await who());
const after = await page.evaluate(() => window.__snap('AFTER'));
console.log('AFTER P:'); for (const c of after.chain) console.log('  ', JSON.stringify(c));
console.log('\nmutations touching the focus holder:');
for (const m of await page.evaluate(() => window.__mut)) console.log('  ', JSON.stringify(m));
console.log('\nsheet in DOM:', await page.evaluate(() => [...document.querySelectorAll('.w-sheet,.w-phone,.w-pause')].map(e => e.className)));

await browser.close(); server.close();
