/* _pp3-verify.mjs — the panel focus round trip, plus the ring question, plus the canvas path. */
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
  await page.waitForTimeout(35);
};
const tab = () => key('Tab', 'Tab', 9);
const esc = () => key('Escape', 'Escape', 27);
const who = () => page.evaluate(() => {
  const a = document.activeElement;
  if (!a) return 'null';
  return `${a.tagName}.${String(a.className).split(' ').join('.')}` +
    (a.getAttribute?.('aria-label') ? `[${a.getAttribute('aria-label')}]` : '');
});
const tabTo = async (label, max = 80) => {
  for (let i = 0; i < max; i++) { await tab(); const w = await who(); if (w.includes(`[${label}]`)) return i + 1; }
  return null;
};
let fails = 0;
const ok = (c, m, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${x ? '   ' + x : ''}`); return c; };

await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.hideUI(false); });
await page.waitForTimeout(700);

/* ---- PANEL-1..3 : the round trip, on P ---- */
const n1 = await tabTo('Menu');
const at0 = await who();
ok(n1 !== null, 'PANEL-0 [set up]: a real Tab traversal lands on Menu', `${n1} tabs -> ${at0}`);
await key('p', 'KeyP', 80);
await page.waitForTimeout(450);
const at1 = await who();
const d1 = await page.evaluate(() => {
  const a = document.activeElement;
  const p = a && a.closest?.('.w-sheet,.w-phone,.w-pause');
  return { inPanel: !!p, role: p?.getAttribute('role'), modal: p?.getAttribute('aria-modal'), ti: p?.getAttribute('tabindex') };
});
ok(d1.inPanel && d1.role === 'dialog' && d1.modal === 'true',
  'PANEL-1 [a sheet TAKES the keyboard]: opening the phone with P moves focus into the panel itself, named as a modal dialog — not to <body>',
  `${at1} ${JSON.stringify(d1)}`);
await esc();
await page.waitForTimeout(600);
const at2 = await who();
ok(at2 === at0, 'PANEL-2 [and CLOSING gives it back]: Escape returns the keyboard to the Menu button the player tabbed to, through a pad that was display:none one frame earlier',
  `${at0}  ->  ${at2}`);
const one = await page.evaluate(() => { const a = document.activeElement; return a && a.getBoundingClientRect ? Math.round(a.getBoundingClientRect().width) : -1; });
ok(one > 0, 'PANEL-2b [and it is really on screen]: the restored button has a box', `${one}px wide`);
/* and the next Space still works from there */
await key(' ', 'Space', 32);
await page.waitForTimeout(400);
ok(await page.evaluate(() => WALLY.ctx.ui.modal), 'PANEL-3 [the returned focus is LIVE]: Space on the handed-back Menu button opens the pause sheet — the bookmark still means what it says');
await page.evaluate(() => WALLY.ctx.ui.closeAll());
await page.waitForTimeout(500);

/* ---- PANEL-4 : nested sheets hand back down the stack ---- */
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); });
await page.waitForTimeout(300);
const n4 = await tabTo('Menu');
const base4 = await who();
await esc();                                       // Esc opens pause from a pad-less start? use show()
await page.waitForTimeout(400);
const nest = await page.evaluate(async () => {
  const ui = WALLY.ctx.ui;
  ui.closeAll();
  return null;
});
await page.waitForTimeout(300);
const n4b = await tabTo('Menu');
const base4b = await who();
await page.evaluate(() => WALLY.ctx.ui.show('pause'));
await page.waitForTimeout(400);
const lvl1 = await who();
await page.evaluate(() => WALLY.ctx.ui.show('settings'));
await page.waitForTimeout(400);
const lvl2 = await who();
await page.evaluate(() => WALLY.ctx.ui.hide());          // pop the top
await page.waitForTimeout(450);
const back1 = await who();
await page.evaluate(() => WALLY.ctx.ui.hide());          // pop the pause
await page.waitForTimeout(600);
const back0 = await who();
ok(lvl1 !== 'BODY.w-touch-on' && lvl2 !== 'BODY.w-touch-on' && lvl2 !== lvl1,
  'PANEL-4a [set up]: two panels, each taking the keyboard as it opens', `${lvl1} -> ${lvl2}`);
ok(back1 === lvl1, 'PANEL-4 [a nested panel hands back DOWN the stack]: closing the settings sheet returns the keyboard to the pause panel underneath, not to <body> and not all the way out',
  `${lvl2} -> ${back1}`);
ok(back0 === base4b, 'PANEL-5 [and the last one hands back OUT]: closing the bottom panel returns the keyboard to the button that opened the first one',
  `${base4b} -> ${back0}`);

/* ---- PANEL-6 : a THUMB player gets no focus ring handed to them ---- */
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); });
await page.waitForTimeout(500);
const P = (x, y) => [{ x, y, id: 1, radiusX: 14, radiusY: 14, force: 1 }];
const tap = async (x, y) => {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: P(x, y) });
  await page.waitForTimeout(70);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(400);
};
const mc = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.w-abtn')].find(e => e.getAttribute('aria-label') === 'Menu');
  const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
const preTap = await who();
await tap(mc.x, mc.y);
const openTap = await who();
const ring = await page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return 'no focus at all';
  return a.matches(':focus-visible') ? 'RING (focus-visible)' : 'focused, no ring';
});
await page.evaluate(() => WALLY.ctx.ui.closeAll());
await page.waitForTimeout(600);
const afterTap = await who();
ok(preTap === 'BODY.w-touch-on', 'PANEL-6a [set up]: a thumb player has no keyboard focus anywhere', preTap);
ok(afterTap === 'BODY.w-touch-on',
  'PANEL-6 [a thumb player is handed nothing]: tapping Menu with a real finger and closing again leaves the keyboard exactly where it was — the hand-back only fires when there was a place to keep',
  `open:${openTap} (${ring})  close:${afterTap}`);

/* ---- ITEM 3: the canvas path ---- */
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); });
await page.waitForTimeout(400);
const nC = await tabTo('Menu');
const kbBefore = await page.evaluate(() => WALLY.debug.padKeyboard());
await tap(195, 300);                                    // bare canvas
const kbAfter = await page.evaluate(() => WALLY.debug.padKeyboard());
console.log(`\nCANVAS: tabbed to Menu (${nC} tabs)`);
console.log('  before canvas touch :', JSON.stringify(kbBefore));
console.log('  after  canvas touch :', JSON.stringify(kbAfter), ' activeElement:', await who());

console.log(fails ? `\nFAIL — ${fails}` : '\nPASS — all');
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
