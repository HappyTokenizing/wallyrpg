/* _gb10c.mjs — ROUND EIGHT: the focus contract, with a focus() CALL-SITE trace. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
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
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(3500);
const cdp = await ctxM.newCDPSession(page);
let fails = 0, rigfails = 0;
const ok  = (c, m, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${x ? '   ' + x : ''}`); return c; };
const pre = (c, m, x = '') => { if (!c) { rigfails++; console.log(`RIG?  precondition: ${m}   ${x}`); } return c; };
const note = (m) => console.log('      ' + m);

await page.evaluate(() => {
  const stamp = () => [...document.querySelectorAll('.w-touch .w-abtn')]
    .forEach(b => b.setAttribute('data-pad', b.getAttribute('aria-label')));
  stamp(); window.__stamp = stamp;
  window.__desc = (a) => !a || a === document.body ? 'BODY'
    : (a.getAttribute?.('data-pad') ? `PAD:${a.getAttribute('data-pad')}`
      : (a.classList?.contains('w-phone') ? 'PANEL:phone'
        : a.classList?.contains('w-pause') ? 'PANEL:pause'
          : a.classList?.contains('w-sheet') ? 'PANEL:sheet'
            : (a.getAttribute?.('aria-label') ? `"${a.getAttribute('aria-label')}"`
              : `${a.tagName}.${String(a.className).split(' ').filter(Boolean).join('.')}`)));
  window.__ftrace = [];
  document.addEventListener('focusin',  e => window.__ftrace.push('IN  ' + window.__desc(e.target)), true);
  document.addEventListener('focusout', e => window.__ftrace.push('OUT ' + window.__desc(e.target)), true);
  /* WHO is calling focus()? one frame of the caller is enough to name it. */
  const nat = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (...a) {
    const st = (new Error().stack || '').split('\n').slice(1, 4)
      .map(s => s.trim().replace(/^at\s+/, '').replace(/https?:\/\/[^/]+/, ''))
      .filter(s => !/HTMLElement.focus/.test(s))[0] || '?';
    window.__ftrace.push(`focus(${window.__desc(this)}) <- ${st}`);
    return nat.apply(this, a);
  };
});
const key = async (k, code, kc) => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
  if (k.length === 1) await cdp.send('Input.dispatchKeyEvent', { type: 'char', key: k, text: k, unmodifiedText: k }).catch(() => {});
  await page.waitForTimeout(25);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
  await page.waitForTimeout(40);
};
const tab = () => key('Tab', 'Tab', 9), esc = () => key('Escape', 'Escape', 27), space = () => key(' ', 'Space', 32);
const who = () => page.evaluate(() => window.__desc(document.activeElement));
const trace = async () => (await page.evaluate(() => { const t = window.__ftrace.slice(); window.__ftrace.length = 0; return t; })).join('\n           ');
const P = (x, y, id = 1) => [{ x, y, id, radiusX: 14, radiusY: 14, force: 1 }];
const tap = async (x, y, hold = 70, settle = 750) => {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: P(x, y) });
  await page.waitForTimeout(hold);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(settle);
};
const padBtn = (label) => page.evaluate((l) => {
  const b = document.querySelector(`.w-touch .w-abtn[data-pad="${l}"]`);
  if (!b) return null; const r = b.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const top = document.elementFromPoint(cx, cy);
  return { x: cx, y: cy, w: Math.round(r.width), onTop: !!(top && b.contains(top)) };
}, label);
const kb = () => page.evaluate(() => WALLY.debug.padKeyboard());
const st = () => page.evaluate(() => ({ modal: WALLY.ctx.ui.modal, stack: WALLY.debug.uiStack ? WALLY.debug.uiStack() : null }));
const reset = async () => {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.hideUI(false); window.__stamp(); });
  await page.waitForTimeout(500);
  await page.evaluate(() => { document.activeElement?.blur?.(); window.__ftrace.length = 0; });
  await page.waitForTimeout(400);
  const s = await st(), w = await who();
  pre(!s.modal && w === 'BODY', 'clean slate', `focus=${w} ${JSON.stringify(s)}`);
  await page.evaluate(() => { window.__ftrace.length = 0; });
};
const tabToPad = async (label, max = 90) => {
  for (let i = 0; i < max; i++) { await tab(); if ((await who()) === `PAD:${label}`) return i + 1; }
  return null;
};

console.log('\n=========== A. WHICH OPENER DOES THE RESTORE PICK? ===========');
for (const lab of ['Phone', 'Places', 'Desk', 'Menu']) {
  await reset();
  const n = await tabToPad(lab); const at0 = await who();
  if (!pre(at0 === `PAD:${lab}`, `tab lands on ${lab}`, `${n} tabs -> ${at0}`)) continue;
  await page.evaluate(() => { window.__ftrace.length = 0; });
  await space(); await page.waitForTimeout(650);
  const opened = await who(); const s1 = await st();
  if (!pre(s1.modal, `${lab}: Space opened something modal`, JSON.stringify(s1))) continue;
  note(`OPEN  ${lab}: ${at0} -> ${opened}\n           ${await trace()}`);
  await esc(); await page.waitForTimeout(1100);
  const closed = await who(); const s2 = await st();
  ok(closed === at0 && !s2.modal, `A-${lab} [the keyboard comes back to the button that opened it]`,
    `${at0} --Space--> ${opened} --Esc--> ${closed}`);
  note(`CLOSE ${lab}: -> ${closed}\n           ${await trace()}`);
}

console.log('\n=========== B. A TOUCH OPEN MUST NOT INVENT A FOCUS ===========');
for (const lab of ['Phone', 'Menu']) {
  await reset();
  const b = await padBtn(lab);
  if (!pre(b && b.onTop && b.w > 20, `${lab} tappable`, JSON.stringify(b))) continue;
  await tap(b.x, b.y);
  const opened = await who(); const s1 = await st();
  if (!pre(s1.modal, `${lab}: finger opened something modal`, JSON.stringify(s1))) continue;
  note(`OPEN by finger ${lab}: -> ${opened}\n           ${await trace()}`);
  await esc(); await page.waitForTimeout(1100);
  const closed = await who(); const s2 = await st();
  ok(closed === 'BODY' && !s2.modal, `B-${lab} [nothing is invented for a player who never had the keyboard]`, `closed on ${closed}`);
  note(`CLOSE: -> ${closed}\n           ${await trace()}`);
}

console.log('\n=========== C. THE TABBED-THEN-THUMB PLAYER ===========');
await reset();
const nC = await tabToPad('Menu'); const cBase = await who();
if (pre(cBase === 'PAD:Menu', 'tabbed to Menu', `${nC} -> ${cBase}`)) {
  const jb = await padBtn('Jump');
  if (pre(jb && jb.onTop, 'Jump tappable', JSON.stringify(jb))) {
    await tap(jb.x, jb.y, 90, 500);
    const k1 = await kb();
    ok(k1.driving === true && k1.padFocused === true,
      'C-setup [tabbed once, now on thumbs — the pad deliberately never takes the focus away, so it is STILL on Menu]', JSON.stringify(k1));
    const mb = await padBtn('Menu');
    if (pre(mb && mb.onTop, 'Menu tappable', JSON.stringify(mb))) {
      await page.evaluate(() => { window.__ftrace.length = 0; });
      await tap(mb.x, mb.y, 90, 750);
      const s1 = await st();
      if (pre(s1.modal, 'thumb tap on Menu opened the pause sheet', JSON.stringify(s1))) {
        note(`OPEN by thumb: -> ${await who()}  ${JSON.stringify(await kb())}\n           ${await trace()}`);
        await esc(); await page.waitForTimeout(1200);
        const cClose = await who(); const k3 = await kb();
        note(`CLOSE: -> ${cClose}  ${JSON.stringify(k3)}\n           ${await trace()}`);
        ok(k3.driving === true,
          'C [the restore must not un-say what the player said]: after opening AND closing a sheet with a FINGER, the pad still knows the player is driving',
          `driving=${k3.driving} focus=${cClose} padTakesSpace=${k3.padTakesSpace}`);
        const s2 = await st();
        if (pre(!s2.modal, 'sheet really closed', JSON.stringify(s2))) {
          await space(); await page.waitForTimeout(400);
          const outcome = await st();
          ok(!outcome.modal, 'C-b [their next SPACE jumps, it does not re-open the sheet they just shut with a thumb]', JSON.stringify(outcome));
        }
      }
    }
  }
}

console.log('\n=========== D. THE OPENER IS GONE WHEN IT CLOSES ===========');
await reset();
const nD = await tabToPad('Menu'); const dBase = await who();
if (pre(dBase === 'PAD:Menu', 'tabbed to Menu', dBase)) {
  await space(); await page.waitForTimeout(650);
  if (pre((await st()).modal, 'pause up')) {
    await page.evaluate(() => { document.querySelector('.w-touch .w-abtn[data-pad="Menu"]').disabled = true; window.__ftrace.length = 0; });
    await esc(); await page.waitForTimeout(1200);
    console.log(`  D-disabled: opener disabled while the sheet was up: ${dBase} -> ${await who()}\n           ${await trace()}`);
    await page.evaluate(() => { document.querySelector('.w-touch .w-abtn[data-pad="Menu"]').disabled = false; });
  }
}
/* the pad FADED away underneath (visibility:hidden, which still has client rects) */
await reset();
await page.evaluate(() => WALLY.debug.hideUI(true));
const nD2 = await tabToPad('Menu'); const d2Base = await who();
if (pre(d2Base === 'PAD:Menu', 'tabbed to Menu with hideUI on', d2Base)) {
  await space(); await page.waitForTimeout(650);
  if (pre((await st()).modal, 'pause up')) {
    await page.evaluate(() => { window.__ftrace.length = 0; });
    await esc();
    await page.waitForTimeout(200);
    /* drive the idle clock forward while the pad is coming back */
    await page.waitForTimeout(9000);
    const idle = await page.evaluate(() => WALLY.debug.touchState());
    const vis = await page.evaluate(() => { const b = document.querySelector('.w-touch .w-abtn[data-pad="Menu"]');
      const cs = getComputedStyle(b); const r = b.getBoundingClientRect();
      return { vis: cs.visibility, disp: cs.display, rects: b.getClientRects().length, w: Math.round(r.width) }; });
    console.log(`  D-faded: focus -> ${await who()}   pad ${JSON.stringify(vis)}   idle=${JSON.stringify(idle.idle || {})}`);
    note(await trace());
  }
  await page.evaluate(() => WALLY.debug.hideUI(false));
}

console.log('\n=========== E. FIRES BECAUSE FOCUS MOVED? FIRES TWICE? ===========');
await page.evaluate(() => {
  window.__hits = []; const ui = WALLY.ctx.ui;
  if (!ui.__wrapped) { for (const n of ['openPhone', 'openDesk', 'show', 'interact']) {
    const f = ui[n]; if (typeof f !== 'function') continue;
    ui[n] = function (...a) { window.__hits.push(n + '(' + a.map(String).join(',') + ')'); return f.apply(this, a); }; }
    ui.__wrapped = true; }
});
for (const lab of ['Phone', 'Desk', 'Menu']) {
  await reset();
  const n = await tabToPad(lab); if (!pre((await who()) === `PAD:${lab}`, `tab to ${lab}`, String(n))) continue;
  await page.evaluate(() => { window.__hits = []; });
  await space(); await page.waitForTimeout(650);
  const h1 = await page.evaluate(() => window.__hits.slice());
  await esc(); await page.waitForTimeout(1200);
  const h2 = await page.evaluate(() => window.__hits.slice());
  ok(h2.length === 1, `E-kb-${lab} [one keyboard open = one verb; the ARRIVING focus fires nothing]`,
    `open ${JSON.stringify(h1)} after-close ${JSON.stringify(h2)}`);
}
for (const lab of ['Phone', 'Menu']) {
  await reset();
  const b = await padBtn(lab); if (!pre(b && b.onTop, `${lab} tappable`, JSON.stringify(b))) continue;
  await page.evaluate(() => { window.__hits = []; });
  await tap(b.x, b.y);
  const h1 = await page.evaluate(() => window.__hits.slice());
  await esc(); await page.waitForTimeout(1200);
  const h2 = await page.evaluate(() => window.__hits.slice());
  ok(h2.length === 1, `E-tap-${lab} [one finger tap = one verb, through open and close]`,
    `after-open ${JSON.stringify(h1)} after-close ${JSON.stringify(h2)}`);
}

console.log('\n=========== F. THE PAD RULE, END TO END ===========');
await reset();
const nF = await tabToPad('Menu');
if (pre((await who()) === 'PAD:Menu', 'tabbed to Menu', String(nF))) {
  const s = await page.evaluate(() => { const e = document.querySelector('.w-stick'); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: P(s.x, s.y) });
  for (let i = 1; i <= 5; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: P(s.x, s.y - i * 12) }); await page.waitForTimeout(50); }
  await page.waitForTimeout(250);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(350);
  const kF = await kb();
  await space(); await page.waitForTimeout(450);
  ok(!(await st()).modal, 'F-a [walk on the stick, then Space jumps rather than firing the focused Menu]', `${JSON.stringify(kF)}`);
}
await reset();
const nF2 = await tabToPad('Menu');
if (pre((await who()) === 'PAD:Menu', 'tab to Menu again', String(nF2))) {
  await space(); await page.waitForTimeout(650);
  ok((await st()).modal, 'F-b [and a genuine Tab then Space still activates it]');
}
console.log(`\n${fails} FAIL / ${rigfails} unmet preconditions`);
await browser.close(); server.close(); process.exit(0);
