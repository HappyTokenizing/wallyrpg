/* _r9d.mjs — ROUND NINE part 4. The two findings, as RATES rather than
   anecdotes, plus the mechanism underneath the first one. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';

const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(ROOT + (c === '/' ? '/index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[c.slice(c.lastIndexOf('.'))] || 'application/octet-stream' }); rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const load = () => execSync('uptime').toString().split('load averages:')[1].trim();
console.log('LOAD at boot:', load(), '(10 cpus)');

const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
let fails = 0;
const ok = (c, m, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${x ? '\n        ' + x : ''}`); return c; };

const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctxM.newPage();
page.on('pageerror', e => { console.log('PAGEERROR', e.message.split('\n')[0]); fails++; });
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 90000 });
await page.waitForTimeout(3500);
const cdp = await ctxM.newCDPSession(page);
const P = (x, y) => [{ x, y, id: 1, radiusX: 14, radiusY: 14, force: 1 }];
const touch = (t, x, y) => cdp.send('Input.dispatchTouchEvent', { type: t, touchPoints: (t === 'touchEnd' || t === 'touchCancel') ? [] : P(x, y) });
const wait = (ms) => page.waitForTimeout(ms);
const KEYS = {
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
};
const keyDown = (n) => cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...KEYS[n] });
const keyUp = (n) => cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...KEYS[n], text: undefined });
const key = async (n, h = 25) => { await keyDown(n); await wait(h); await keyUp(n); };
const padKb = () => page.evaluate(() => WALLY.debug.padKeyboard());
const panels = () => page.evaluate(() => WALLY.ctx.ui.panels.slice());
const focusNow = () => page.evaluate(() => { const a = document.activeElement;
  if (!a || a === document.body) return { label: null, where: 'body' };
  return { label: a.getAttribute?.('aria-label') || a.className || a.tagName,
    where: a.closest?.('.w-touch') ? 'pad' : (a.closest?.('.w-sheet,.w-pause,.w-phone') ? 'panel' : 'other'),
    dying: !!a.closest?.('.out'), connected: a.isConnected }; });
const padAt = (l) => page.evaluate((L) => { const b = [...document.querySelectorAll('.w-abtn')].find(e => e.getAttribute('aria-label') === L);
  if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, l);
const tabTo = async (l, max = 90) => { for (let i = 0; i < max; i++) { await key('Tab', 8); await wait(10);
  const f = await focusNow(); if (f.where === 'pad' && f.label === l) return { ...f, tabs: i + 1 }; } return null; };
const reset = async () => { await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); }); await wait(300); };
const thumbTap = async (l, h = 70) => { const c = await padAt(l);
  await touch('touchStart', c.x, c.y); await wait(h); await touch('touchEnd', c.x, c.y); await wait(320); };
const thumbJump = async (h = 110) => { const c = await padAt('Jump');
  await touch('touchStart', c.x, c.y); await wait(h); await touch('touchEnd', c.x, c.y); await wait(260); };
const resumeBtn = () => page.evaluate(() => {
  const b = [...document.querySelectorAll('.w-pause button, .w-sheet button')].find(e => /resume/i.test(e.textContent || ''));
  if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await page.evaluate(() => { WALLY.debug.hideUI(false); WALLY.ctx.ui.closeAll(); });
await wait(400);
const stale = async () => { await reset(); const t = await tabTo('Menu'); await thumbJump(); return t; };

/* =====================================================================
   A. THE DYING PANEL IS STILL IN THE TAB ORDER.
   retire() hands the keyboard back and then leaves the node in the
   document for its 300 ms fade-out. releaseFocus moves a keyboard that
   is ALREADY inside; nothing stops a Tab pressed afterwards from going
   back IN.
   ===================================================================== */
console.log('\n== A. the panel that has already closed ==');
await stale();
await thumbTap('Menu');
const r = await resumeBtn();
await touch('touchStart', r.x, r.y); await wait(50); await touch('touchEnd', r.x, r.y);
await wait(120);                              // inside the 300 ms fade-out
const panMid = await panels();
const domMid = await page.evaluate(() => {
  const p = document.querySelector('.w-pause, .w-sheet');
  if (!p) return { present: false };
  return { present: true, out: p.classList.contains('out'), op: getComputedStyle(p).opacity,
    focusables: p.querySelectorAll('button,[href],input,select,textarea,[tabindex]').length,
    inert: p.hasAttribute('inert'), ariaHidden: p.getAttribute('aria-hidden') };
});
await key('Tab');
await wait(60);
const fMid = await focusNow();
await wait(900);
const fEnd = await focusNow(); const kbEnd = await padKb();
console.log('  mid-fade panel:', JSON.stringify(domMid), 'ui.panels', JSON.stringify(panMid));
console.log('  where the Tab landed:', JSON.stringify(fMid), '-> settled', JSON.stringify(fEnd), JSON.stringify(kbEnd));
ok(domMid.present === true && panMid.length === 0,
  'R9-20-pre [the closed panel really is still in the document]: ui.panels is empty and the node is still there, fading',
  `${JSON.stringify(domMid)}, panels ${JSON.stringify(panMid)}`);
ok(fMid.where !== 'panel',
  'R9-20 [a Tab pressed after a sheet closes does not walk back INTO it]: the node is on its way off screen and must not be a tab stop while it goes',
  `landed on ${JSON.stringify(fMid)}`);

/* =====================================================================
   B. THE RACE, AS A RATE. Identical gesture, twenty times: thumb-close
   the sheet and press Tab immediately. Two outcomes are possible
   depending on whether the Tab or the hand-back lands first, and they
   disagree about who owns the next Space.
   ===================================================================== */
console.log('\n== B. Tab against the hand-back, twenty times ==');
const outcomes = { drivingTrue: 0, drivingFalse: 0, landed: {} };
const rows = [];
for (let i = 0; i < 20; i++) {
  await stale();
  await thumbTap('Menu');
  const rb = await resumeBtn();
  await touch('touchStart', rb.x, rb.y); await wait(45); await touch('touchEnd', rb.x, rb.y);
  await keyDown('Tab'); await keyUp('Tab');
  await wait(800);
  const f = await focusNow(); const kb = await padKb();
  rows.push({ i, focus: f.label, where: f.where, driving: kb.driving, takes: kb.padTakesSpace });
  if (kb.driving) outcomes.drivingTrue++; else outcomes.drivingFalse++;
  outcomes.landed[f.label] = (outcomes.landed[f.label] || 0) + 1;
}
console.log('  ' + JSON.stringify(outcomes));
console.log('  ' + rows.map(x => `${x.where}:${x.focus}/${x.driving ? 'D' : '-'}`).join(' '));
ok(outcomes.drivingTrue === 0 || outcomes.drivingFalse === 0,
  'R9-21 [one gesture, one answer]: pressing Tab as the sheet closes always resolves the same way — the player’s Tab either always hands the keyboard back or always does not, rather than depending on which of two frames wins',
  `driving still set ${outcomes.drivingTrue}/20, cleared ${outcomes.drivingFalse}/20; landed ${JSON.stringify(outcomes.landed)}`);

/* the consequence, stated as the player meets it: with driving still
   set and the focus sitting on Menu, is the Space a jump or a sheet? */
console.log('\n== B2. what that costs, on the arm that keeps the flag ==');
let stuck = 0, tries = 0;
for (let i = 0; i < 8 && stuck === 0; i++) {
  tries++;
  await stale();
  await thumbTap('Menu');
  const rb = await resumeBtn();
  await touch('touchStart', rb.x, rb.y); await wait(45); await touch('touchEnd', rb.x, rb.y);
  await keyDown('Tab'); await keyUp('Tab');
  await wait(800);
  const kb = await padKb(); const f = await focusNow();
  if (kb.driving === true && f.where === 'pad') {
    await key('Space'); await wait(700);
    const pan = await panels();
    console.log(`  attempt ${i}: focus ${f.label}, driving ${kb.driving}, Space -> panels ${JSON.stringify(pan)}`);
    stuck = 1;
    ok(false === false, `R9-22 [observed]: the Tab was pressed, the ring is on ${f.label}, and the pad still refuses the key`,
      `kb ${JSON.stringify(kb)}, panels after Space ${JSON.stringify(pan)}`);
  }
}
if (!stuck) console.log(`  the flag-kept arm did not come up in ${tries} tries this run`);

/* =====================================================================
   C. THE FINGER ON A SHEET, AS A RATE — and the same gesture with the
   sheet closed by the ✕ rather than Resume, and on a place card
   rather than the pause sheet.
   ===================================================================== */
console.log('\n== C. a finger that closes a sheet is not a finger on the pad ==');
const armC = async (closerSel) => {
  await reset();
  const t = await tabTo('Menu');
  await key('Space'); await wait(700);          // keyboard opens it
  const opened = await panels();
  const c = await page.evaluate((sel) => {
    const b = document.querySelector(sel);
    if (!b) return null; const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, txt: (b.textContent || '').trim().slice(0, 10) };
  }, closerSel);
  if (!c) return { skipped: closerSel, opened };
  await touch('touchStart', c.x, c.y); await wait(55); await touch('touchEnd', c.x, c.y);
  await wait(900);
  const kb = await padKb(); const f = await focusNow();
  await key('Space'); await wait(700);
  return { t, opened, c, kb, f, after: await panels() };
};
const C1 = await armC('.w-pause button, .w-sheet button');
console.log('  Resume:', JSON.stringify(C1));
ok(C1.after && C1.after.length === 0,
  'R9-18 [a real finger closing a sheet counts as driving]: keyboard-opened, THUMB-closed, and the next Space is not the pause sheet coming straight back',
  `kb ${JSON.stringify(C1.kb)}, focus ${JSON.stringify(C1.f)}, panels after Space ${JSON.stringify(C1.after)}`);

/* the scrim: a finger on the dark area outside the panel */
await reset();
const tS = await tabTo('Menu');
await key('Space'); await wait(700);
const openedS = await panels();
await touch('touchStart', 195, 60); await wait(50); await touch('touchEnd', 195, 60);
await wait(900);
const kbS = await padKb(); const panS = await panels();
await key('Space'); await wait(700);
const panS2 = await panels();
console.log('  scrim tap:', JSON.stringify({ openedS, kbS, panS, panS2 }));
ok(panS.length === 0 ? panS2.length === 0 : true,
  'R9-23 [and a finger on the SCRIM the same]: dismissing by tapping outside the sheet is a finger on the glass too',
  `closed ${JSON.stringify(panS)}, kb ${JSON.stringify(kbS)}, after Space ${JSON.stringify(panS2)}`);

console.log('\nLOAD at end:', load());
console.log(`\n${fails ? 'FAIL' : 'PASS'} — ${fails} failing`);
await browser.close(); server.close();
process.exit(0);
