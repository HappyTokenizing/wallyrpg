/* vj-verify.mjs — VERIFY JUDGE probe.

   Closes three gaps between what the brief claims and what touchtest.mjs
   actually measures:

     A. touchtest asserts Tab+Space on Menu (PAD-30) and Tab+Enter on
        Phone (PAD-30b). The claim is "EVERY focusable button". Six
        buttons x two keys, each reached by a GENUINE Tab traversal.
     B. PAD-37c presses ONE of the four window shortcuts (Escape) with
        the pad faded. The claim is "the shortcut keys". All four, each
        with hidden===true re-read immediately before the press.
     C. PANEL-1..6 run the round trip on phone/pause only, closed by
        Escape only. The claim is "every sheet, opened by keyboard and
        by touch, closed every way". Four sheets x two openers x three
        close routes.

   Same context as touchtest.mjs: 390x844, hasTouch, isMobile, real CDP
   input. No synthetic .click(), no .focus() anywhere in the activation
   paths — every activation below is a dispatched key or a dispatched
   contact. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';

const ROOT = resolve('/Users/herwig/Documents/GitHub/wallyrpg');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
/* NEGATIVE CONTROL, SERVED NOT COMMITTED. VJ_MUTATE=nohandback rewrites
   ui.js ON THE WAY TO THE BROWSER so handBack() returns immediately —
   i.e. the exact defect this round fixed, where a sheet took the
   keyboard and Escape never gave it back. The repo on disk is never
   touched. A probe that cannot be made to fail has not been shown to
   measure anything, and on this project that is how assertions have
   gone green for the wrong reason seven times. Expected under the
   mutation: RT-1 FAILS (nothing is handed back) and RT-2 still PASSES
   (a thumb player was always meant to end on <body>, and does) — so the
   control also proves the two assertions are not the same assertion. */
const MUTATE = process.env.VJ_MUTATE || '';
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try {
    let b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    if (MUTATE === 'nohandback' && c.endsWith('/ui/ui.js')) {
      const src = b.toString();
      const NEEDLE = 'function handBack(el, tries = 6) {';
      if (!src.includes(NEEDLE)) { console.log('MUTATE FAILED — needle not found'); process.exit(2); }
      b = Buffer.from(src.replace(NEEDLE, NEEDLE + ' return;'));
    }
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' });
    rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({
  channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'],
});
let fails = 0;
const ok = (cond, msg, extra = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '   ' + extra : ''}`);
  return cond;
};

const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1,
});
const page = await ctx.newPage();
page.on('pageerror', e => { console.log('PAGEERROR', e.message.split('\n')[0]); fails++; });
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 120000 });
await page.waitForTimeout(3500);

const cdp = await ctx.newCDPSession(page);
const P = (x, y) => [{ x, y, id: 1, radiusX: 14, radiusY: 14, force: 1 }];
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : P(x, y),
});
/* a real finger: land, hold a human beat, lift in the same place */
const fingerTap = async (x, y, hold = 90) => {
  await touch('touchStart', x, y);
  await page.waitForTimeout(hold);
  await touch('touchEnd', x, y);
  await page.waitForTimeout(450);
};

const panelsNow = () => page.evaluate(() => WALLY.ctx.ui.panels.slice());
const focusNow = () => page.evaluate(() => {
  const a = document.activeElement;
  return {
    tag: a ? a.tagName.toLowerCase() : null,
    label: a?.getAttribute?.('aria-label') || null,
    cls: a && typeof a.className === 'string' ? a.className : null,
    isBody: !a || a === document.body,
    inPad: !!a?.closest?.('.w-touch'),
    inPanel: !!a?.closest?.('.w-panels'),
  };
});
/* CLOSE FIRST, BLUR SECOND, AND LEAVE A GAP BETWEEN THEM. closeAll()'s
   hand-back is retried across up to six animation frames, so a blur() in
   the same evaluate is overtaken by the hand-back landing a frame later,
   and the next case starts with the keyboard already on a pad button.
   That cost this probe two false findings on its first run. */
const reset = async () => {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.hide('dialogue'); });
  await page.waitForTimeout(320);                  // > 6 frames: let the hand-back finish
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.waitForTimeout(260);
};
/* the phone remembers the app it was last in, so "Escape closes it" is
   only true from the app grid — drive it home the way touchtest does */
const phoneToHome = async () => {
  await page.keyboard.press('P');
  await page.waitForTimeout(420);
  for (let i = 0; i < 3 && (await panelsNow()).includes('phone'); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(420);
  }
};
/* a GENUINE Tab traversal — dispatched key events, one at a time, until
   the pad button with this label actually holds the keyboard. Never
   focus(); if the traversal cannot reach it, that is a finding. */
const tabTo = async (label, max = 80) => {
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.waitForTimeout(200);
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const f = await focusNow();
    if (f.inPad && f.label === label) return { ...f, tabs: i + 1 };
  }
  return null;
};
const padBtn = (label) => page.evaluate((l) => {
  const b = document.querySelector(`.w-touch [aria-label="${l}"]`);
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width) };
}, label);

console.log('\n================ A. EVERY FOCUSABLE PAD BUTTON, BOTH KEYS ================');
/* BRANCH: bindPress's keyboard-activation path — the `detail === 0`
   acceptance in touch.js plus the padTakesSpace gate reading
   driving===false. GESTURE: a genuine dispatched Tab traversal to the
   button, then a genuine dispatched Space (or Enter) keypress. Nothing
   here calls focus() or .click(), so a regression that broke sequential
   focus navigation or the detail-0 rule fails this rather than passing
   it on a synthesised shortcut. */
const OPENS = { Phone: 'phone', Places: 'phone', Desk: 'desk', Menu: 'pause' };
const kbRows = [];
for (const key of ['Space', 'Enter']) {
  for (const label of ['Phone', 'Places', 'Desk', 'Menu']) {
    await reset();
    const t = await tabTo(label);
    if (!t) { kbRows.push(`${label}/${key}: NO TAB REACHED IT`); continue; }
    await page.keyboard.press(key);
    await page.waitForTimeout(700);
    const pn = await panelsNow();
    if (!pn.includes(OPENS[label])) kbRows.push(`${label}/${key}: panels ${JSON.stringify(pn)}`);
  }
}
/* Enter and Jump are verbs, not sheet openers, so they are measured by
   their own effect: Enter runs ui.interact, Jump leaves the ground. */
await reset();
/* 'Enter or talk', not 'Enter' — the label the pad actually sets. The
   first run of this probe asked for 'Enter', got no tab match, and
   reported the button as dead. A label typo failing CLOSED is the
   lucky direction; the same typo in a negative assertion would have
   passed forever. */
const tEnterBtn = await tabTo('Enter or talk');
let entFired = 0;
if (tEnterBtn) {
  await page.evaluate(() => {
    const ui = WALLY.ctx.ui, orig = ui.interact;
    window.__f = 0;
    Object.defineProperty(ui, 'interact', {
      configurable: true, writable: true,
      value: function () { window.__f++; return orig.apply(this, arguments); },
    });
  });
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  entFired = await page.evaluate(() => window.__f);
}
await reset();
const tJumpBtn = await tabTo('Jump');
let jumped = null;
if (tJumpBtn) {
  await page.keyboard.press('Enter');
  await page.waitForTimeout(120);
  jumped = await page.evaluate(() => {
    const w = WALLY.ctx.wally, c = w.controller;
    return { vy: +((c?.velocity || c?.vel)?.y ?? 0).toFixed(2), grounded: !!c?.grounded };
  });
}
ok(kbRows.length === 0 && entFired === 1 && jumped && (jumped.vy > 0.5 || !jumped.grounded),
  'KB-1 [Tab then Space/Enter activates EVERY focusable pad button]: all six controls reached by a genuine Tab traversal answer both keys — four sheet shortcuts open their sheet on Space and on Enter, Enter runs ui.interact, Jump leaves the ground',
  kbRows.length ? JSON.stringify(kbRows)
    : `4 shortcuts x 2 keys all opened; Enter btn fired ${entFired}; Jump vy ${jumped?.vy} grounded ${jumped?.grounded}`);

console.log('\n================ B. ALL FOUR WINDOW SHORTCUTS, PAD FADED ================');
/* BRANCH: ui.js onKey (the window-level keydown), reached while
   touch.js's Hide-UI stage two has the cluster faded — i.e. the pad is
   out of the tab order and its buttons are pointer-events:none. This is
   the redundancy that makes the fade affordable, so each press re-reads
   WALLY.debug.idle().hidden IMMEDIATELY BEFORE it fires: a green here
   with hidden false would be measuring an un-faded pad, which is the
   exact "green for the wrong reason" shape this project keeps hitting.
   GESTURE: a dispatched keypress with no contact anywhere on the glass
   (a contact would wake the pad and destroy the precondition). */
await reset();
await page.evaluate(() => { WALLY.debug.hideUI(true); WALLY.debug.idle(0.4); });
const fadeRows = [];
for (const [code, want] of [['KeyP', 'phone'], ['KeyM', 'phone'], ['KeyO', 'desk'], ['Escape', 'pause']]) {
  /* the dialogue SUSPENDS stage two (idle.why goes 'dialogue' and the
     pad never fades), so it has to go before the clock is read — the
     first run of this probe measured why:'dialogue' four times and
     called it a product failure */
  await page.evaluate(() => {
    WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.hide('dialogue');
  });
  await page.waitForTimeout(320);
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.waitForTimeout(1400);                 // let stage two fade it out again
  const pre = await page.evaluate(() => {
    const i = WALLY.debug.idle();
    const pad = document.querySelector('.w-acts');
    const cs = pad ? getComputedStyle(pad) : null;
    return { hidden: i.hidden, why: i.why, opacity: cs ? +cs.opacity : null, pe: cs ? cs.pointerEvents : null };
  });
  const fPre = await focusNow();
  await page.keyboard.press(code.replace('Key', '').length === 1 ? code.replace('Key', '') : code);
  await page.waitForTimeout(700);
  const pn = await panelsNow();
  if (!pre.hidden) fadeRows.push(`${code}: PRECONDITION — pad not faded (why ${pre.why})`);
  else if (!fPre.isBody) fadeRows.push(`${code}: PRECONDITION — focus was ${fPre.label || fPre.cls}`);
  else if (!pn.includes(want)) fadeRows.push(`${code}: panels ${JSON.stringify(pn)} (wanted ${want}, opacity ${pre.opacity}, pe ${pre.pe})`);
}
ok(fadeRows.length === 0,
  'KB-2 [all four window shortcuts still work with the pad faded]: with stage two holding the cluster at opacity 0 and pointer-events none, and hidden===true re-read immediately before each press, P / M / O / Escape each still raise their sheet — the pad is a second route to these, never the only one',
  fadeRows.length ? JSON.stringify(fadeRows) : 'P, M, O, Escape: 4 of 4 opened with the pad faded and no focus anywhere');
await page.evaluate(() => { WALLY.debug.idle(null); WALLY.debug.hideUI(false); });
await reset();

console.log('\n================ C. EVERY SHEET, BOTH OPENERS, EVERY CLOSE ROUTE ================');
/* Four sheets. Opened by KEYBOARD (Tab to a pad button, then the key —
   so there is a real opener to bank) and by TOUCH (a dispatched finger
   on the same button — so there must be NO opener to bank). Closed
   three ways: the Escape key, the sheet's own X button pressed with a
   real finger, and ui.closeAll(), which is a separate hand-back branch
   from releaseFocus() and reads `inside` before the nodes leave. */
const SHEETS = [
  { name: 'phone', btn: 'Phone', key: 'KeyP', panel: 'phone', inApp: false },
  { name: 'places', btn: 'Places', key: 'KeyM', panel: 'phone', inApp: true },
  { name: 'desk', btn: 'Desk', key: 'KeyO', panel: 'desk', inApp: false },
  { name: 'pause', btn: 'Menu', key: 'Escape', panel: 'pause', inApp: false },
];
const closeBy = async (route, sheet) => {
  if (route === 'escape') {
    /* the phone's Escape is a BACK press while an app is open, so an
       app-opened sheet needs the back press first and then the close —
       the distinction PANEL-2b/2c draws, honoured here too */
    if (sheet.inApp) { await page.keyboard.press('Escape'); await page.waitForTimeout(450); }
    await page.keyboard.press('Escape');
  } else if (route === 'dismiss-control') {
    /* THE SHEET'S OWN DISMISS CONTROL, whatever it is called on that
       sheet. phone/places/desk print a ✕ labelled "Close"; the pause
       panel has no ✕ at all and dismisses through "Resume". Asking
       every sheet for a ✕ made this probe report the pause panel as
       broken on its first run, when the truth is that its dismiss
       affordance is a differently-named button. */
    const x = await page.evaluate(() => {
      const p = document.querySelector('.w-panels');
      const all = [...(p?.querySelectorAll('button') || [])];
      const b = all.find((e) => /close/i.test(e.getAttribute('aria-label') || ''))
             || all.find((e) => /^\s*resume\s*$/i.test(e.textContent || ''));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return {
        x: r.left + r.width / 2, y: r.top + r.height / 2,
        what: b.getAttribute('aria-label') || (b.textContent || '').trim(),
      };
    });
    if (!x) return 'no dismiss control on this sheet';
    await fingerTap(x.x, x.y);
  } else {
    await page.evaluate(() => WALLY.ctx.ui.closeAll());
  }
  await page.waitForTimeout(800);
  return null;
};

const kbRT = [], touchRT = [];
for (const sheet of SHEETS) {
  for (const route of ['escape', 'dismiss-control', 'closeall']) {
    /* ---- opened by KEYBOARD: there IS an opener, it must come back ---- */
    await reset();
    if (sheet.panel === 'phone' && !sheet.inApp) { await phoneToHome(); await reset(); }
    const t = await tabTo(sheet.btn);
    if (!t) { kbRT.push(`${sheet.name}/${route}: no tab to ${sheet.btn}`); continue; }
    await page.keyboard.press(sheet.key === 'Escape' ? 'Space' : sheet.key.replace('Key', ''));
    await page.waitForTimeout(700);
    const opened = await panelsNow();
    const inside = await focusNow();
    if (!opened.includes(sheet.panel)) { kbRT.push(`${sheet.name}/${route}: did not open (${JSON.stringify(opened)})`); continue; }
    if (!inside.inPanel) kbRT.push(`${sheet.name}/${route}: focus did not enter the sheet (${inside.label || inside.cls})`);
    const bad = await closeBy(route, sheet);
    if (bad) { kbRT.push(`${sheet.name}/${route}: ${bad}`); continue; }
    const after = await panelsNow();
    const back = await focusNow();
    if (after.length) kbRT.push(`${sheet.name}/${route}: still open ${JSON.stringify(after)}`);
    else if (back.label !== sheet.btn) kbRT.push(`${sheet.name}/${route}: handed back to ${back.label || back.cls || 'body'} not ${sheet.btn}`);

    /* ---- opened by TOUCH: there is NO opener, nothing may be invented ---- */
    await reset();
    if (sheet.panel === 'phone' && !sheet.inApp) { await phoneToHome(); await reset(); }
    const p = await padBtn(sheet.btn);
    if (!p) { touchRT.push(`${sheet.name}/${route}: no ${sheet.btn} button`); continue; }
    const pre = await focusNow();
    await fingerTap(p.x, p.y);
    const openedT = await panelsNow();
    if (!openedT.includes(sheet.panel)) { touchRT.push(`${sheet.name}/${route}: finger did not open it (${JSON.stringify(openedT)})`); continue; }
    if (!pre.isBody) touchRT.push(`${sheet.name}/${route}: PRECONDITION — focus was not empty before the tap`);
    const badT = await closeBy(route, sheet);
    if (badT) { touchRT.push(`${sheet.name}/${route}: ${badT}`); continue; }
    const afterT = await panelsNow();
    const backT = await focusNow();
    if (afterT.length) touchRT.push(`${sheet.name}/${route}: still open ${JSON.stringify(afterT)}`);
    else if (!backT.isBody) touchRT.push(`${sheet.name}/${route}: INVENTED a focus -> ${backT.label || backT.cls}`);
  }
}
ok(kbRT.length === 0,
  'RT-1 [the round trip closes on EVERY sheet, by EVERY route]: phone, places, desk and pause each opened from a genuinely tabbed pad button take the keyboard into the sheet, and closing by the Escape key, by a real finger on the sheet\'s own dismiss control, or by ui.closeAll() hands it back to the exact button that opened it',
  kbRT.length ? JSON.stringify(kbRT, null, 1) : '4 sheets x 3 close routes: 12 of 12 round-tripped to the opener');
ok(touchRT.length === 0,
  'RT-2 [and a sheet opened by a FINGER invents nothing]: the same twelve cases opened by a dispatched contact instead — the pad preventDefaults its pointerdown so nothing is ever focused, focusReturn stays null, and every close leaves the keyboard exactly where the thumb player left it, on <body>',
  touchRT.length ? JSON.stringify(touchRT, null, 1) : '4 sheets x 3 close routes: 12 of 12 closed to <body>, no focus invented');

console.log(`\n${fails ? 'FAIL' : 'PASS'} — ${fails} failing`);
await browser.close();
server.close();
process.exit(fails ? 1 : 0);
