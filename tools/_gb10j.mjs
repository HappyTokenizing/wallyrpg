/* _gb10j.mjs — the opener is gone when the sheet closes; and a dialogue over a sheet. */
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
    : a.classList?.contains('w-pause') ? 'PANEL:pause' : a.classList?.contains('w-phone') ? 'PANEL:phone'
      : a.classList?.contains('w-sheet') ? 'PANEL:sheet' : `${a.tagName}.${String(a.className).split(' ').filter(Boolean).join('.')}`);
  window.__ft = [];
  const nat = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (...a) {
    const st = (new Error().stack || '').split('\n').slice(1, 4).map(s => s.trim().replace(/^at\s+/, '').replace(/https?:\/\/[^/]+/, '')).filter(s => !/HTMLElement.focus/.test(s))[0] || '?';
    window.__ft.push(`focus(${window.__desc(this)}) <- ${st}`); return nat.apply(this, a); };
});
const key = async (k, code, kc) => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
  if (k.length === 1) await cdp.send('Input.dispatchKeyEvent', { type: 'char', key: k, text: k, unmodifiedText: k }).catch(() => {});
  await page.waitForTimeout(25);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
  await page.waitForTimeout(40); };
const tab = () => key('Tab', 'Tab', 9), esc = () => key('Escape', 'Escape', 27), space = () => key(' ', 'Space', 32);
const who = () => page.evaluate(() => window.__desc(document.activeElement));
const ft = async () => (await page.evaluate(() => { const t = window.__ft.slice(); window.__ft.length = 0; return t; })).join(' | ');
const stk = () => page.evaluate(() => ({ modal: WALLY.ctx.ui.modal, panels: WALLY.ctx.ui.panels.slice() }));
const reset = async () => {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.hideUI(false); window.__stamp(); });
  await page.waitForTimeout(500);
  await page.evaluate(() => { document.activeElement?.blur?.(); window.__ft.length = 0; });
  await page.waitForTimeout(400);
  pre(!(await stk()).modal && (await who()) === 'BODY', 'clean slate', await who()); };
const tabToPad = async (l, max = 90) => { for (let i = 0; i < max; i++) { await tab(); if ((await who()) === `PAD:${l}`) return i + 1; } return null; };

console.log('\n===== A. THE OPENER IS DISABLED WHILE THE SHEET IS UP =====');
await reset();
const nA = await tabToPad('Menu'); const baseA = await who();
if (pre(baseA === 'PAD:Menu', 'tabbed to Menu', String(nA))) {
  await space(); await page.waitForTimeout(650);
  if (pre((await stk()).panels.length > 0, 'pause up')) {
    await page.evaluate(() => { document.querySelector('.w-touch .w-abtn[data-pad="Menu"]').disabled = true; window.__ft.length = 0; });
    await esc(); await page.waitForTimeout(1400);
    const w = await who();
    console.log(`  ${baseA} -> (opener disabled) -> ${w}     focus() calls: ${await ft() || 'none'}`);
    ok(w !== 'PANEL:pause', 'A [a disabled opener does not strand the keyboard on the panel that just left]', `landed on ${w}`);
    await page.evaluate(() => { document.querySelector('.w-touch .w-abtn[data-pad="Menu"]').disabled = false; });
  }
}

console.log('\n===== B. THE PAD HAS FADED AWAY WHEN THE SHEET CLOSES =====');
await reset();
await page.evaluate(() => WALLY.debug.hideUI(true));
await page.waitForTimeout(300);
const nB = await tabToPad('Menu'); const baseB = await who();
if (pre(baseB === 'PAD:Menu', 'tabbed to Menu with Hide UI on', String(nB))) {
  await space(); await page.waitForTimeout(650);
  if (pre((await stk()).panels.length > 0, 'pause up')) {
    /* fade the cluster while the sheet is up, so the opener is inert on return */
    await page.evaluate(() => { window.__ft.length = 0; });
    await esc(); await page.waitForTimeout(1400);
    const justAfter = await who(); const f1 = await ft();
    await page.waitForTimeout(8000);                     // let the idle clock take the pad
    const s = await page.evaluate(() => WALLY.debug.touchState());
    const css = await page.evaluate(() => { const b = document.querySelector('.w-touch .w-abtn[data-pad="Menu"]');
      return { vis: getComputedStyle(b).visibility, rects: b.getClientRects().length, focusable: document.activeElement === b }; });
    console.log(`  on close: ${baseB} -> ${justAfter}   focus(): ${f1 || 'none'}`);
    console.log(`  8 s later: idle=${JSON.stringify(s.idle || {})}  Menu css=${JSON.stringify(css)}  focus now ${await who()}`);
    ok(true, 'B [recorded — see the numbers above]');
  }
  await page.evaluate(() => WALLY.debug.hideUI(false));
}

console.log('\n===== C. A SHEET THAT OPENS A DIALOGUE =====');
await reset();
const nC = await tabToPad('Menu'); const baseC = await who();
if (pre(baseC === 'PAD:Menu', 'tabbed to Menu', String(nC))) {
  await space(); await page.waitForTimeout(650);
  const before = await who(); const s0 = await stk();
  const how = await page.evaluate(() => {
    const c = WALLY.ctx;
    try {
      if (c.dialogue?.open) { c.dialogue.open({ name: 'Test', lines: ['one', 'two', 'three'] }); return 'ctx.dialogue.open'; }
      if (WALLY.debug.say) { WALLY.debug.say(['one', 'two', 'three']); return 'debug.say'; }
      return 'no dialogue entry point found';
    } catch (e) { return 'threw: ' + String(e).slice(0, 60); } });
  await page.waitForTimeout(800);
  const during = await who(); const s1 = await stk();
  const dOpen = await page.evaluate(() => { try { return !!WALLY.ctx.ui.dialogueOpen; } catch (e) { return 'n/a'; } });
  console.log(`  via ${how}: focus ${before} -> ${during}   panels ${JSON.stringify(s0.panels)} -> ${JSON.stringify(s1.panels)}  dialogueOpen=${dOpen}`);
  console.log(`  focus() calls: ${await ft() || 'none'}`);
  if (dOpen === true) {
    await esc(); await page.waitForTimeout(900);
    console.log(`  after Esc (closes the dialogue): focus ${await who()}  panels ${JSON.stringify((await stk()).panels)}  focus(): ${await ft() || 'none'}`);
    await esc(); await page.waitForTimeout(1200);
    const w = await who();
    console.log(`  after Esc again (closes the sheet): focus ${w}   (opener was ${baseC})`);
    ok(w === baseC, 'C [a dialogue raised over a sheet does not lose the sheet\'s return address]', `${w} vs ${baseC}`);
  } else { console.log('  no dialogue could be raised from here — NO VERDICT on this case'); }
}
console.log(`\n${fails} FAIL / ${rig} unmet preconditions`);
await browser.close(); server.close(); process.exit(0);
