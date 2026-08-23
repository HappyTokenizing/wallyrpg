/* _p1-focus.mjs — WHO throws the keyboard player's place away when a sheet opens? */
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
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: type === 'keyDown' ? 'rawKeyDown' : 'keyUp',
      key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
      text: type === 'keyDown' && k.length === 1 ? k : undefined,
    });
    if (type === 'keyDown') {
      await cdp.send('Input.dispatchKeyEvent', { type: 'char', key: k, text: k, unmodifiedText: k })
        .catch(() => {});
    }
    await page.waitForTimeout(30);
  }
};
const tab = () => key('Tab', 'Tab', 9);
const who = () => page.evaluate(() => {
  const a = document.activeElement;
  return a ? `${a.tagName}${a.className ? '.' + String(a.className).split(' ').join('.') : ''}` +
    (a.getAttribute?.('aria-label') ? `[${a.getAttribute('aria-label')}]` : '') : 'null';
});

/* instrument: log every focus change with a stack trace of whoever caused it */
await page.evaluate(() => {
  window.__flog = [];
  const desc = (a) => !a ? 'null' : `${a.tagName}${a.className ? '.' + String(a.className).split(' ').join('.') : ''}`;
  document.addEventListener('focusout', (e) => {
    window.__flog.push({ ev: 'focusout', from: desc(e.target), to: desc(e.relatedTarget), stack: new Error().stack.split('\n').slice(1, 8).join(' | ') });
  }, true);
  document.addEventListener('focusin', (e) => {
    window.__flog.push({ ev: 'focusin', to: desc(e.target) });
  }, true);
  /* who calls blur()/focus()/remove()? */
  const ob = HTMLElement.prototype.blur;
  HTMLElement.prototype.blur = function () { window.__flog.push({ ev: 'blur()', on: desc(this), stack: new Error().stack.split('\n').slice(1, 6).join(' | ') }); return ob.apply(this, arguments); };
  const orem = Element.prototype.remove;
  Element.prototype.remove = function () {
    if (this.contains?.(document.activeElement)) window.__flog.push({ ev: 'remove(holding focus)', on: desc(this), stack: new Error().stack.split('\n').slice(1, 6).join(' | ') });
    return orem.apply(this, arguments);
  };
});

await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.hideUI(false); });
await page.waitForTimeout(600);

/* tab to Menu */
let landed = null;
for (let i = 0; i < 80; i++) {
  await tab();
  const w = await who();
  if (/Menu/.test(w)) { landed = { tabs: i + 1, w }; break; }
}
console.log('after Tab traversal    :', landed ? `${landed.tabs} tabs -> ${landed.w}` : 'NEVER LANDED');
await page.evaluate(() => { window.__flog = []; });

await key('p', 'KeyP', 80);
await page.waitForTimeout(500);
console.log('after P (open pause)   :', await who());
console.log('  stack open           :', await page.evaluate(() => WALLY.ctx.ui.stack?.length ?? 'n/a'));
console.log('  flog:');
for (const l of await page.evaluate(() => window.__flog)) console.log('    ', JSON.stringify(l));

await page.evaluate(() => { window.__flog = []; });
await key('Escape', 'Escape', 27);
await page.waitForTimeout(500);
console.log('after Escape (close)   :', await who());
console.log('  flog:');
for (const l of await page.evaluate(() => window.__flog)) console.log('    ', JSON.stringify(l));

/* what IS focusable inside a sheet? */
await key('p', 'KeyP', 80);
await page.waitForTimeout(400);
console.log('\nsheet contents (focusable?):');
console.log(await page.evaluate(() => {
  const el = document.querySelector('.w-pause');
  if (!el) return 'no .w-pause';
  return {
    role: el.getAttribute('role'), ariaModal: el.getAttribute('aria-modal'),
    tabindex: el.getAttribute('tabindex'),
    focusables: [...el.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].length,
    firstFew: [...el.querySelectorAll('button')].slice(0, 4).map(b => (b.textContent || '').trim().slice(0, 18)),
  };
}));
/* does Tab inside the sheet stay inside it? */
for (let i = 0; i < 3; i++) { await tab(); console.log('  tab', i + 1, '->', await who()); }

/* and a canvas touch: what does it do to focus + intent? */
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); });
await page.waitForTimeout(400);
let land2 = null;
for (let i = 0; i < 80; i++) { await tab(); const w = await who(); if (/Menu/.test(w)) { land2 = w; break; } }
console.log('\ncanvas path: focus on   :', land2);
console.log('  padKeyboard before    :', JSON.stringify(await page.evaluate(() => WALLY.debug.padKeyboard())));
const P = (x, y) => [{ x, y, id: 1, radiusX: 14, radiusY: 14, force: 1 }];
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: P(195, 300) });
await page.waitForTimeout(80);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.waitForTimeout(300);
console.log('  after CANVAS touch    :', await who());
console.log('  padKeyboard after     :', JSON.stringify(await page.evaluate(() => WALLY.debug.padKeyboard())));

await browser.close(); server.close();
