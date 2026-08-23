/* _pd1-repro.mjs — the breaker's two arms, single variable: one Tab, ever.
   Every event after that Tab is a real finger. No key until the final Space. */
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
const P = (x, y) => [{ x, y, id: 1, radiusX: 14, radiusY: 14, force: 1 }];
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent',
  { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : P(x, y) });
const tap = async (x, y, hold = 60) => { await touch('touchStart', x, y); await page.waitForTimeout(hold); await touch('touchEnd', x, y); };

const kb = () => page.evaluate(() => WALLY.debug.padKeyboard());
const panels = () => page.evaluate(() => WALLY.ctx.ui.panels.slice());
const focusNow = () => page.evaluate(() => {
  const a = document.activeElement;
  return a === document.body ? 'body' : (a?.getAttribute?.('aria-label') || a?.className || a?.tagName || null);
});
const centre = (sel, label) => page.evaluate(([s, l]) => {
  const b = l ? [...document.querySelectorAll(s)].find(e => e.getAttribute('aria-label') === l)
              : document.querySelector(s);
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, [sel, label]);
const grounded = () => page.evaluate(() => {
  const c = WALLY.ctx.wally.controller; const v = c && (c.velocity || c.vel);
  return { y: +WALLY.ctx.wally.position.y.toFixed(2), vy: v ? +v.y.toFixed(2) : null };
});
const tabTo = async (label, max = 80) => {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const f = await page.evaluate(() => {
      const a = document.activeElement;
      return { label: a?.getAttribute?.('aria-label') || null, inPad: !!a?.closest?.('.w-touch') };
    });
    if (f.inPad && f.label === label) return i + 1;
  }
  return null;
};

const jumpC = await centre('.w-abtn', 'Jump');
const menuC = await centre('.w-abtn', 'Menu');
console.log('jump', jumpC, 'menu', menuC);

async function arm(name, doTab) {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); });
  await page.waitForTimeout(600);
  let tabs = null;
  if (doTab) { tabs = await tabTo('Menu'); }
  const pre = { kb: await kb(), focus: await focusNow(), tabs };

  /* --- from here on: FINGERS ONLY --- */
  await tap(jumpC.x, jumpC.y, 120);
  await page.waitForTimeout(400);
  const afterJump = { kb: await kb(), focus: await focusNow() };

  await tap(menuC.x, menuC.y, 60);
  await page.waitForTimeout(650);
  const openPanels = await panels();
  const afterOpen = { kb: await kb(), focus: await focusNow() };

  /* thumb the Resume button on the pause sheet */
  const resume = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.w-pause button, .w-sheet button')];
    const r = btns.find(b => /resume|close|✕/i.test(b.textContent || b.getAttribute('aria-label') || ''));
    if (!r) return null;
    const q = r.getBoundingClientRect();
    return { x: q.left + q.width / 2, y: q.top + q.height / 2, t: (r.textContent || '').trim().slice(0, 20) };
  });
  if (resume) await tap(resume.x, resume.y, 60);
  else await page.evaluate(() => WALLY.ctx.ui.closeAll());
  await page.waitForTimeout(900);
  const afterClose = { kb: await kb(), focus: await focusNow(), panels: await panels(), resume };

  const g0 = await grounded();
  /* HELD, and sampled WHILE HELD — a press+release sampled 260 ms later
     reads the top of the arc as "no change" and calls a real jump a
     miss. spaceJump()'s shape, from the existing suite. */
  await page.keyboard.down('Space');
  await page.waitForTimeout(190);
  const g1 = await page.evaluate(() => {
    const c = WALLY.ctx.wally.controller;
    return { y: +WALLY.ctx.wally.position.y.toFixed(2), vy: +c.velocity.y.toFixed(2), grounded: c.grounded };
  });
  await page.keyboard.up('Space');
  await page.waitForTimeout(500);
  const after = { panels: await panels(), kb: await kb(), focus: await focusNow() };

  console.log(`\n===== ${name} =====`);
  console.log(' pre        ', JSON.stringify(pre));
  console.log(' afterJump  ', JSON.stringify(afterJump));
  console.log(' afterOpen  ', JSON.stringify(afterOpen), 'panels', JSON.stringify(openPanels));
  console.log(' afterClose ', JSON.stringify(afterClose));
  console.log(' SPACE      ', `y ${g0.y}->${g1.y} vy ${g0.vy}->${g1.vy}`, 'panels', JSON.stringify(after.panels), JSON.stringify(after.kb));
  return { pre, afterJump, afterOpen, afterClose, jumped: g1.vy > 1.0, after };
}

const A = await arm('never tabbed', false);
const B = await arm('tabbed once, then thumbs', true);
console.log('\nload at end:', LOAD());
console.log('\nVERDICT  never-tabbed jumped:', A.jumped, 'panels', JSON.stringify(A.after.panels));
console.log('VERDICT  tabbed-once   jumped:', B.jumped, 'panels', JSON.stringify(B.after.panels));

await browser.close(); server.close();
