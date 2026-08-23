/* vj-focus.mjs — INDEPENDENT verification of the sheet-restore focus fix.

   Written from scratch rather than reusing touchtest.mjs's helpers, so a
   harness bug shared with the suite cannot make both green together.

   Every arm is driven with REAL Input.dispatchTouchEvent at 390x844,
   hasTouch + isMobile. The jump is measured as a PEAK over the whole arc
   (rAF sampler in-page), not a single sample at a fixed delay — a single
   sample can miss the top and read a real jump as a miss, or catch a
   residual and read a miss as a jump.  */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'],
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1,
});
const page = await ctx.newPage();
let fails = 0;
const ok = (cond, msg, extra = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '\n        ' + extra : ''}`);
  return cond;
};
page.on('pageerror', e => { console.log('PAGEERROR', e.message.split('\n')[0]); fails++; });
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(3500);

const cdp = await ctx.newCDPSession(page);
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: type === 'touchEnd' || type === 'touchCancel'
    ? [] : [{ x, y, id: 1, radiusX: 14, radiusY: 14, force: 1 }],
});

const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const reset = async () => {
  await page.evaluate((b) => {
    WALLY.ctx.ui.closeAll();
    WALLY.debug.hideUI(false);
    WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {});
  }, BOOT);
  await page.waitForTimeout(700);
};
const kb = () => page.evaluate(() => WALLY.debug.padKeyboard());
const panels = () => page.evaluate(() => WALLY.ctx.ui.panels.slice());
const restoreRec = () => page.evaluate(() => WALLY.debug.focusRestore());
const focusLabel = () => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return null;
  return a.getAttribute?.('aria-label') || a.className || a.tagName;
});
const padAt = (label) => page.evaluate((l) => {
  const b = [...document.querySelectorAll('.w-abtn')].find((e) => e.getAttribute('aria-label') === l);
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, label);
const tap = async (p, hold = 70) => {
  await touch('touchStart', p.x, p.y);
  await page.waitForTimeout(hold);
  await touch('touchEnd', p.x, p.y);
  await page.waitForTimeout(280);
};
/** Tab until `label` is focused. `clean` blurs first (a fresh walk);
    without it we walk on from wherever the keyboard already is, which is
    what a real player does and what leaves the restore state intact. */
const tabTo = async (label, clean = true, max = 40) => {
  if (clean) { await page.evaluate(() => document.activeElement?.blur?.()); await page.waitForTimeout(200); }
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(60);
    const f = await focusLabel();
    if (f === label) return { label: f, tabs: i + 1 };
  }
  return null;
};

/* PEAK vertical velocity across the whole arc. A jump is an impulse and
   then gravity; a single sample at a fixed delay is at the mercy of when
   the frame landed, which on a loaded box is exactly what moves. */
const peakJump = async (holdMs = 200, watchMs = 520) => {
  await page.evaluate(() => {
    window.__pk = { max: -1e9, n: 0, on: true };
    const t = () => {
      if (!window.__pk.on) return;
      const c = WALLY.ctx.wally.controller, v = c && (c.velocity || c.vel);
      if (v) { if (v.y > window.__pk.max) window.__pk.max = v.y; window.__pk.n++; }
      requestAnimationFrame(t);
    };
    requestAnimationFrame(t);
  });
  await page.keyboard.down('Space');
  await page.waitForTimeout(holdMs);
  await page.keyboard.up('Space');
  await page.waitForTimeout(watchMs);
  const r = await page.evaluate(() => { window.__pk.on = false; return { peak: +window.__pk.max.toFixed(3), n: window.__pk.n }; });
  const p = await panels();
  await page.waitForTimeout(500);
  return { ...r, panels: p };
};
/** Same sampler, no key at all — the floor a "jump" has to clear. */
const peakIdle = async (watchMs = 720) => {
  await page.evaluate(() => {
    window.__pk = { max: -1e9, n: 0, on: true };
    const t = () => {
      if (!window.__pk.on) return;
      const c = WALLY.ctx.wally.controller, v = c && (c.velocity || c.vel);
      if (v) { if (v.y > window.__pk.max) window.__pk.max = v.y; window.__pk.n++; }
      requestAnimationFrame(t);
    };
    requestAnimationFrame(t);
  });
  await page.waitForTimeout(watchMs);
  return page.evaluate(() => { window.__pk.on = false; return { peak: +window.__pk.max.toFixed(3), n: window.__pk.n }; });
};

const JUMP = await padAt('Jump');
const MENU = await padAt('Menu');
console.log('geometry', JSON.stringify({ JUMP, MENU }));

/* ---------- 0. the floor, so every "he jumped" below has a scale ---- */
await reset();
const idle = await peakIdle();
ok(idle.peak < 0.2 && idle.n > 20,
  'FLOOR [the sampler is running and standing still is not a jump]: with no key pressed the peak vertical velocity over ~0.7 s is ~0. Every threshold below is measured against THIS number, not against a constant somebody guessed',
  `peak ${idle.peak} over ${idle.n} frames`);
const FLOOR = idle.peak;

/* ---------- the arm, run twice, differing by exactly one Tab -------- */
const arm = async (doTab) => {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); });
  await reset();
  const tabs = doTab ? await tabTo('Menu') : null;
  const afterTab = await kb();
  /* ---- REAL FINGERS ONLY until the final Space ---- */
  await tap(JUMP, 110);
  const afterThumbJump = await kb();
  await tap(MENU, 70);
  await page.waitForTimeout(750);
  const opened = await panels();
  const res = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.w-pause button, .w-sheet button')]
      .find((e) => /resume/i.test(e.textContent || ''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (res) await tap(res, 70);
  await page.waitForTimeout(950);
  const afterClose = await kb();
  const rec = await restoreRec();
  const shut = await panels();
  const j = await peakJump();
  return { tabs, afterTab, afterThumbJump, opened, res: !!res, afterClose, rec, shut, j };
};

const A = await arm(false);   // never tabbed
const B = await arm(true);    // tabbed exactly once, at the very start

ok(A.tabs === null && B.tabs !== null && A.opened.length === 1 && B.opened.length === 1
  && A.res && B.res && A.shut.length === 0 && B.shut.length === 0,
  'PRE [both arms really ran and differ by exactly one Tab]: each thumbs Jump, thumbs Menu OPEN and thumbs RESUME shut, with dispatched touch events; the only key in either arm before the final Space is the one Tab in arm B',
  `A tabs ${A.tabs} opened ${JSON.stringify(A.opened)} shut ${JSON.stringify(A.shut)} | B tabs ${B.tabs?.tabs} opened ${JSON.stringify(B.opened)} shut ${JSON.stringify(B.shut)}`);

ok(B.afterThumbJump.focus === 'Menu' && B.afterThumbJump.driving === true
  && A.afterThumbJump.focus === null,
  'PRE-2 [BRANCH: the poisoned state really exists]: in arm B the keyboard bookmark is STILL on Menu after a real finger on Jump — the pad never releases focus, which is why one Tab reaches the rest of the session and why the hand-back has a pad button to aim at at all. Arm A has no bookmark to restore, which is why it never showed the bug',
  `A focus ${JSON.stringify(A.afterThumbJump.focus)} | B focus ${JSON.stringify(B.afterThumbJump.focus)} driving ${B.afterThumbJump.driving}`);

ok(B.rec && B.rec.landed === true && B.rec.signed === true && B.rec.attempts > 1
  && B.afterClose.focus === 'Menu' && B.afterClose.padFocused === true,
  'PRE-3 [BRANCH: the hand-back FIRED, took more than one frame, and every attempt was signed]: if this went green by the restore silently not happening the whole fix would be untested — the pad is display:none at the instant of the close, so the attempt that LANDS is never the first one',
  `${JSON.stringify(B.rec)} focus ${JSON.stringify(B.afterClose.focus)}`);

ok(B.afterClose.driving === true && B.afterClose.padTakesSpace === false
  && B.j.peak > FLOOR + 1.0 && B.j.panels.length === 0,
  'CASE 1 [BRANCH: a RESTORED focus does not speak for the player]: tabbed once, then thumbs only, then Space — HE JUMPS, and no sheet opens',
  `peak vy ${B.j.peak} (floor ${FLOOR}, ${B.j.n} frames), panels ${JSON.stringify(B.j.panels)}, driving ${B.afterClose.driving}`);

ok(A.afterClose.driving === true && A.j.peak > FLOOR + 1.0 && A.j.panels.length === 0,
  'CASE 2 [BRANCH: the never-tabbed control, which was always right]: never tabbed, thumbs only, then Space — he jumps',
  `peak vy ${A.j.peak} (floor ${FLOOR}, ${A.j.n} frames), panels ${JSON.stringify(A.j.panels)}`);

ok(Math.abs(A.j.peak - B.j.peak) < 1.0 && A.j.panels.length === B.j.panels.length,
  'CASE 1v2 [the two arms now AGREE]: one Tab no longer changes the answer — the peaks are the same jump within noise and neither opens anything',
  `A ${A.j.peak} | B ${B.j.peak}`);

/* ---------- 3. tabbed, then Space with NO touch in between ---------- */
await reset();
const t3 = await tabTo('Menu');
const kb3 = await kb();
await page.keyboard.press('Space');
await page.waitForTimeout(800);
const pn3 = await panels();
ok(t3 !== null && kb3.driving === false && kb3.padTakesSpace === true
  && pn3.length === 1 && pn3[0] === 'pause',
  'CASE 3 [BRANCH: no touch since the focus, so the BUTTON owns Space]: Tab to Menu and press Space with nothing touched in between — the pause sheet opens. Named, not counted: `length === 1` alone once passed with the wrong panel already up',
  `${JSON.stringify(kb3)} -> panels ${JSON.stringify(pn3)}`);

/* ---------- 4. tab, touch, tab AGAIN, Space ------------------------- */
await reset();
const t4a = await tabTo('Menu');
await tap(JUMP, 110);
const kb4mid = await kb();
/* the second Tab, walked on from where the restore/touch left it — NO
   blur, or the arm would wash out the very state it is testing */
await page.keyboard.press('Tab');
await page.waitForTimeout(200);
const kb4tab = await kb();
let at4 = kb4tab.focus, hops4 = 0;
while (at4 !== 'Menu' && hops4 < 12) {
  await page.keyboard.press('Tab');
  await page.waitForTimeout(80);
  at4 = (await kb()).focus; hops4++;
}
await page.keyboard.press('Space');
await page.waitForTimeout(800);
const pn4 = await panels();
ok(t4a !== null && kb4mid.driving === true && kb4tab.driving === false
  && kb4tab.padTakesSpace === true && at4 === 'Menu'
  && pn4.length === 1 && pn4[0] === 'pause',
  'CASE 4 [BRANCH: a FRESH focus is still obeyed after a touch]: tab, thumb Jump (driving true), Tab again (driving cleared by that one focusin), walk on to Menu without a blur, Space — the PAUSE sheet opens. The fix distrusts the restore, not the player',
  `mid ${JSON.stringify(kb4mid)} -> after tab ${JSON.stringify(kb4tab)} -> landed ${JSON.stringify(at4)} after ${hops4} more tabs, panels ${JSON.stringify(pn4)}`);

/* ---------- 5. the keyboard player keeps his place ------------------ */
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); });
await reset();
const t5 = await tabTo('Menu');
await page.keyboard.press('Space');
await page.waitForTimeout(800);
const open5 = await panels();
const inPanel5 = await page.evaluate(() => {
  const a = document.activeElement;
  const p = a?.closest?.('.w-sheet,.w-phone,.w-pause');
  return { inPanel: !!p, role: p?.getAttribute('role') || null, modal: p?.getAttribute('aria-modal') || null };
});
await page.keyboard.press('Escape');
await page.waitForTimeout(1000);
const shut5 = await panels();
const kb5 = await kb();
const rec5 = await restoreRec();
ok(t5 !== null && open5.length === 1 && inPanel5.inPanel === true && inPanel5.role === 'dialog',
  'CASE 5-pre [the sheet TOOK the keyboard, so there is something to hand back]: a keyboard-opened pause panel puts focus inside itself on a root named as a modal dialog. Without this the restore never runs and CASE 5 would be vacuously green',
  `${JSON.stringify(open5)} ${JSON.stringify(inPanel5)}`);
ok(shut5.length === 0 && kb5.focus === 'Menu' && kb5.padFocused === true
  && kb5.driving === false && kb5.padTakesSpace === true,
  'CASE 5 [BRANCH: a keyboard player closing a sheet gets his place back AND his Space]: Escape returns focus to the Menu button he opened it from — not to <body>, which would restart sequential navigation from the top of the document — and Space still belongs to that button, so the fix did not buy the thumb player a mute keyboard',
  `${JSON.stringify(kb5)} restore ${JSON.stringify(rec5)}`);
/* ...and it is LIVE, not just a label */
await page.keyboard.press('Space');
await page.waitForTimeout(800);
const pn5b = await panels();
ok(pn5b.length === 1 && pn5b[0] === 'pause',
  'CASE 5b [the returned place is a WORKING one]: pressing Space on the button he was handed back re-opens the pause sheet — the restore handed over a live control, not a dead ring',
  `panels ${JSON.stringify(pn5b)}`);

/* ---------- 6. the MUTATION control: can this measurement fail? ----- */
/* The pre-fix behaviour, exactly: the same restore, UNSIGNED. If the
   assertions above are green because the pad has simply stopped
   listening to focus, this arm is green too and CASE 1 proves nothing. */
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); });
await reset();
const t6 = await tabTo('Menu');
await tap(JUMP, 110);
const kb6a = await kb();
const did6 = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.w-abtn')].find((e) => e.getAttribute('aria-label') === 'Menu');
  document.activeElement?.blur?.();          // the restore always focuses from elsewhere
  b.focus({ preventScroll: true });          // ...and does NOT sign it — the old code
  return document.activeElement === b;
});
await page.waitForTimeout(200);
const kb6b = await kb();
const j6 = await peakJump();
ok(t6 !== null && did6 && kb6a.driving === true && kb6b.driving === false
  && kb6b.padTakesSpace === true && j6.panels.length === 1 && j6.panels[0] === 'pause',
  'MUTATION [the measurement CAN fail — this is the old behaviour, reproduced]: the same programmatic focus on the same button with the signature withheld clears the flag, and the Space that CASE 1 proves is a CLEAN jump opens the PAUSE SHEET on top of him. The green above is the signature doing work, not a dead sensor',
  `driving ${kb6a.driving} -> ${kb6b.driving}, peak vy ${j6.peak} (floor ${FLOOR}), panels ${JSON.stringify(j6.panels)}`);

/* ...AND THE MEASUREMENT THE BRIEF ASKED FOR IS NOT THE DISCRIMINATOR.
   wally.js binds Space on `window` with no focus test at all
   (character/wally.js: `keys[e.code] = true`), and a button's detail-0
   click arrives on KEYUP — after the jump impulse has already been
   taken. So the BROKEN player jumps as well, and gets the sheet on top.
   An assertion resting on peak vy alone would have been green over the
   live bug; the empty panel list is the load-bearing half. */
ok(j6.peak > FLOOR + 1.0,
  'DISCRIMINATOR [vy alone would be green over the bug]: in the reproduced OLD behaviour he jumps TOO — Space is bound on window and the button fires on keyup, after the impulse. “He jumps” is necessary and NOT sufficient, which is why every assertion above pairs the peak with the panel list',
  `broken-state peak vy ${j6.peak} WITH the pause sheet up, vs fixed-state ${B.j.peak} with none`);

console.log(`\n${fails ? 'FAIL' : 'OK'} — ${fails} failing`);
await browser.close();
server.close();
process.exit(fails ? 1 : 0);
