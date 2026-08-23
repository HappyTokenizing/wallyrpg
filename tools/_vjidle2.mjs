/* _vjidle2.mjs — the four measurements _vjidle.mjs could not make cleanly,
   re-taken with the harness faults removed:
     · the fade-in gate, reading the opacity of the element that actually
       transitions (.w-acts, not the button inside it)
     · hit tests resolved with closest(), because elementFromPoint returns
       the <svg> icon inside a button
     · the PAUSE sheet over faded controls, with the delivery of each tap
       counted at window capture, document capture and the target
     · the straddling double tap, started from controls that are really up */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
let fails = 0;
const ok = (c, m, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${x ? '   ' + x : ''}`); return c; };
const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctxM.newPage();
page.on('pageerror', e => { console.log('PAGEERROR', e.message.split('\n')[0]); fails++; });
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 60000 });
await page.waitForTimeout(3500);
const cdp = await ctxM.newCDPSession(page);
const t1 = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: (type === 'touchEnd' || type === 'touchCancel') ? [] : [{ x, y, id: 1, radiusX: 14, radiusY: 14, force: 1 }],
});
const idleGet = () => page.evaluate(() => WALLY.debug.idle());
const idleSet = (s) => page.evaluate((v) => WALLY.debug.idle(v), s);
const padRead = () => page.evaluate(() => {
  const one = (sel) => { const el = document.querySelector(sel); if (!el) return null;
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2; const hit = document.elementFromPoint(cx, cy);
    return { op: +(+cs.opacity).toFixed(3), vis: cs.visibility, cx: Math.round(cx), cy: Math.round(cy),
      self: !!(hit && (hit === el || el.contains(hit))),
      visible: cs.visibility === 'visible' && cs.display !== 'none' && +cs.opacity > 0.02 && r.width > 0 };
  };
  return { stick: one('.w-stickzone'), acts: one('.w-acts'), act: one('.w-abtn.act'), jump: one('.w-abtn.jump'), idle: WALLY.debug.idle() };
});
const gone = (p) => !p.stick.visible && !p.acts.visible;
const there = (p) => p.stick.visible && p.acts.visible;
async function dbl(x, y, s = 800) { await t1('touchStart', x, y); await t1('touchEnd', x, y); await t1('touchStart', x, y); await t1('touchEnd', x, y); await page.waitForTimeout(s); }
const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const open = () => page.evaluate((b) => { WALLY.ctx.ui.closeAll(); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {}); return null; }, BOOT);
await open(); await page.waitForTimeout(900);
await page.evaluate(() => { WALLY.debug.hideUI(true); return null; });
await page.waitForTimeout(600);
const D = 1.4; await idleSet(D);
const goIdle = async () => { await page.waitForTimeout(D * 1000 + 900); return padRead(); };
const jumpPt = await page.evaluate(() => { const r = document.querySelector('.w-abtn.jump').getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; });

/* ===== A. THE FADE-IN GATE, measured on the element that transitions ===== */
let p = await goIdle();
ok(gone(p), 'W-1 [re-arm for the fade-in gate]', `acts op ${p.acts.op}`);
await dbl(jumpPt[0], jumpPt[1], 0);
const mid = await page.evaluate(([x, y]) => {
  const e = document.elementFromPoint(x, y);
  return { i: WALLY.debug.idle(), acts: +(+getComputedStyle(document.querySelector('.w-acts')).opacity).toFixed(3),
    onJump: !!(e && e.closest && e.closest('.w-abtn.jump')), tag: e ? (e.id || e.tagName.toLowerCase()) : 'null' };
}, jumpPt);
await t1('touchStart', jumpPt[0], jumpPt[1]); await page.waitForTimeout(40); await t1('touchEnd', jumpPt[0], jumpPt[1]);
const mid2 = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y);
  return { i: WALLY.debug.idle(), acts: +(+getComputedStyle(document.querySelector('.w-acts')).opacity).toFixed(3),
    onJump: !!(e && e.closest && e.closest('.w-abtn.jump')) }; }, jumpPt);
await page.waitForTimeout(900);
const late = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y);
  return { i: WALLY.debug.idle(), onJump: !!(e && e.closest && e.closest('.w-abtn.jump')) }; }, jumpPt);
ok(mid.i.hidden === false && mid.i.live === false && mid.acts > 0 && mid.acts < 1 && mid.onJump === false,
  'W-2 [.w-idlewake]: mid fade-in the cluster is PART WAY THROUGH its opacity transition and a finger at the Jump centre still reaches the canvas',
  `.w-acts opacity ${mid.acts}, live ${mid.i.live}, under ${mid.tag}`);
ok(mid2.i.live === false && mid2.acts < 1 && mid2.onJump === false,
  'W-3 [the third tap of a triple tap]: a tap dispatched inside the fade-in found nothing pressable either',
  `.w-acts opacity ${mid2.acts}, live ${mid2.i.live}`);
ok(late.i.live === true && late.onJump === true,
  'W-4 [goLive]: once the fade has run the same point is the Jump button again', `onJump ${late.onJump}, live ${late.i.live}`);

/* ===== B. THE PAUSE SHEET OVER FADED CONTROLS ===== */
await open(); await page.waitForTimeout(700);
p = await goIdle();
ok(gone(p), 'W-5 [faded, before the pause sheet opens]');
await page.evaluate(() => { WALLY.ctx.ui.show('pause'); return null; });
await page.waitForTimeout(900);
const sheetState = await idleGet();
const info = await page.evaluate(() => {
  const panels = document.querySelector('.w-panels');
  const top = panels.lastElementChild;
  const r = top.getBoundingClientRect();
  const pt = [Math.round(r.left + r.width / 2), Math.round(r.top + Math.min(r.height - 12, 60))];
  const b = document.createElement('button');
  b.id = 'vjp'; b.textContent = 'probe';
  Object.assign(b.style, { position: 'fixed', left: (pt[0] - 70) + 'px', top: (pt[1] - 24) + 'px', width: '140px', height: '48px', zIndex: '99999' });
  window.__c = { win: 0, doc: 0, tgt: 0, click: 0, dp: [] };
  addEventListener('pointerdown', () => window.__c.win++, true);
  document.addEventListener('pointerdown', (e) => { window.__c.doc++; window.__c.dp.push(e.defaultPrevented); }, false);
  b.addEventListener('pointerdown', () => window.__c.tgt++);
  b.addEventListener('click', () => window.__c.click++);
  top.append(b);
  const e = document.elementFromPoint(pt[0], pt[1]);
  return { pt, wins: !!e && e.id === 'vjp', top: top.className, modal: WALLY.ctx.ui.modal, panels: WALLY.ctx.ui.panels };
});
await dbl(info.pt[0], info.pt[1], 700);
const c = await page.evaluate(() => { const v = window.__c; document.getElementById('vjp')?.remove(); return v; });
ok(info.wins && info.modal === true && sheetState.why === 'modal' && sheetState.hidden === false,
  'W-6 [idleSuspended() == modal]: the pause sheet suspends the clock and restores the controls behind it',
  `panels ${JSON.stringify(info.panels)}, why ${sheetState.why}, probe wins hit test ${info.wins}`);
ok(c.win === 2 && c.doc === 2 && c.tgt === 2 && c.click === 2,
  'W-7 [tapDown early-return under a sheet]: with the pause sheet open over faded controls both taps of a double tap reach the button underneath',
  `window ${c.win}, document ${c.doc}, target ${c.tgt}, clicks ${c.click}, defaultPrevented ${JSON.stringify(c.dp)}`);
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); return null; });
await page.waitForTimeout(800);

/* ===== C. THE STRADDLING DOUBLE TAP, from controls that are really up ===== */
await open(); await page.waitForTimeout(600);
await dbl(195, 300, 700);                        // make sure they are UP
await idleSet(4);
await page.waitForTimeout(250);
p = await padRead();
ok(there(p), 'W-8 [visible, for the straddle case]', `t ${p.idle.t}, acts op ${p.acts.op}`);
await page.evaluate(() => {
  window.__s = { saw: [], gap: -1, down1: 0, up1: 0, dur1: -1, pend1: null };
  const rec = (e) => { const s = window.__s; s.saw.push(WALLY.debug.idle().hidden);
    if (s.up1) s.gap = Math.round(e.timeStamp - s.up1); else s.down1 = e.timeStamp;
    if (s.saw.length >= 2) document.removeEventListener('pointerdown', rec, true); };
  document.addEventListener('pointerdown', rec, true);
  const fade = (e) => { document.removeEventListener('pointerup', fade, true);
    const s = window.__s; s.up1 = e.timeStamp; s.dur1 = Math.round(e.timeStamp - s.down1);
    s.pend1 = WALLY.debug.idle().pending; WALLY.debug.idle(0);
    const back = () => { if (WALLY.debug.idle().hidden) { WALLY.debug.idle(4); return; } requestAnimationFrame(back); };
    requestAnimationFrame(back); };
  document.addEventListener('pointerup', fade, true);
  return null;
});
const w0 = (await idleGet()).wakes;
await t1('touchStart', 195, 300); await t1('touchEnd', 195, 300);
await page.waitForTimeout(80);
await t1('touchStart', 195, 300); await t1('touchEnd', 195, 300);
await page.waitForTimeout(700);
p = await padRead();
const s = await page.evaluate(() => window.__s);
ok(s.saw.length === 2 && s.saw[0] === false && s.saw[1] === true,
  'W-9 [the fade really landed BETWEEN the two taps]: tap one on visible controls, tap two on faded ones', JSON.stringify(s.saw));
ok(s.pend1 === true && s.gap >= 0 && s.gap <= 300 && there(p) && p.idle.wakes === w0 + 1,
  'W-10 [the detector runs while the controls are still up]: a double tap straddling the fade is one gesture and it wakes',
  `gap ${s.gap} ms, tap one lasted ${s.dur1} ms of TAP_MS 400, pending ${s.pend1}, wakes ${w0} -> ${p.idle.wakes}`);
await idleSet(null);
console.log(fails ? `\nFAIL — ${fails} red.` : '\nPASS — every assertion green.');
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
