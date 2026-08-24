/* _vj-liftsweep.mjs — VERIFY JUDGE, independent of touchtest.mjs.

   THE QUESTION: a Tab pressed at SEVERAL OFFSETS across the hand-back
   window — does it keep its FOCUS (a live place in the document) and
   its MEANING (the next Space operates the focused button)?

   Written from scratch. Its own server, its own touch helpers, its own
   focus ledger, its own end-to-end meaning check. Nothing is imported
   from touchtest.mjs, so a shared harness bug cannot make both green.

   MEANING IS MEASURED AT THE END OF THE WIRE, not from a flag. After
   the gesture the harness presses Space and asks the GAME what
   happened: a panel named 'pause' opened (the button heard the key) or
   nothing opened and the elephant's vertical velocity spiked (the pad
   swallowed it). Reading padTakesSpace alone would be reading the
   implementation's own opinion of itself.  */
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
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({
  channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'],
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1,
});
const page = await ctx.newPage();
let fails = 0;
const ok = (c, m, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${x ? '\n        ' + x : ''}`); return c; };
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message.split('\n')[0]); fails++; });
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(3500);

const cdp = await ctx.newCDPSession(page);
const TH = +(process.argv.find((a) => a.startsWith('--throttle='))?.split('=')[1] || 1);
if (TH > 1) { await cdp.send('Emulation.setCPUThrottlingRate', { rate: TH }); console.log(`CPU throttled ${TH}x`); }
const finger = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 14, radiusY: 14, force: 1 }],
});
const tap = async (p, hold = 70) => {
  await finger('touchStart', p.x, p.y); await page.waitForTimeout(hold);
  await finger('touchEnd', p.x, p.y); await page.waitForTimeout(260);
};
/* THE CLOSING LIFT, WITH NOTHING AFTER IT. tap()'s 260 ms settle is
   fine everywhere else and fatal here: the offsets below are measured
   FROM THE LIFT, and a helper that sleeps a quarter second first turns
   "off = 0" into "off = 260" — the hand-back has long since landed and
   the Tab never races anything. My first run of this file failed
   exactly that way, and SWEEP-pre is the line that caught it. */
const liftOnly = async (p, hold = 45) => {
  await finger('touchStart', p.x, p.y); await page.waitForTimeout(hold);
  await finger('touchEnd', p.x, p.y);
};
const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const reset = async () => {
  await page.evaluate((b) => {
    WALLY.ctx.ui.closeAll(); WALLY.debug.hideUI(false);
    WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {});
  }, BOOT);
  await page.waitForTimeout(700);
};
const kb = () => page.evaluate(() => WALLY.debug.padKeyboard());
const panels = () => page.evaluate(() => WALLY.ctx.ui.panels.slice());
const rec = () => page.evaluate(() => WALLY.debug.focusRestore());
const lbl = () => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return null;
  return a.getAttribute?.('aria-label') || a.className || a.tagName;
});
const padAt = (l) => page.evaluate((n) => {
  const b = [...document.querySelectorAll('.w-abtn')].find((e) => e.getAttribute('aria-label') === n);
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, l);
const resumeAt = () => page.evaluate(() => {
  const b = [...document.querySelectorAll('.w-pause button, .w-sheet button')]
    .find((e) => /resume/i.test(e.textContent || ''));
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
const tabTo = async (label, max = 40) => {
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.waitForTimeout(180);
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab'); await page.waitForTimeout(55);
    if (await lbl() === label) return i + 1;
  }
  return null;
};
const mode = (m) => page.evaluate((v) => WALLY.debug.padHandBackYield(v), m);
const stall = (n) => page.evaluate((v) => WALLY.debug.padHandBackStall(v), n);

/* PEAK vertical velocity, so "he jumped" has a number and a floor. */
const armSampler = () => page.evaluate(() => {
  window.__pk = { max: -1e9, n: 0, on: true };
  const t = () => {
    if (!window.__pk.on) return;
    const c = WALLY.ctx.wally.controller, v = c && (c.velocity || c.vel);
    if (v) { if (v.y > window.__pk.max) window.__pk.max = v.y; window.__pk.n++; }
    requestAnimationFrame(t);
  };
  requestAnimationFrame(t);
});
const readSampler = () => page.evaluate(() => { window.__pk.on = false; return { peak: +window.__pk.max.toFixed(3), n: window.__pk.n }; });

/* the ledger: where the player's own keystroke actually put the
   keyboard, read at the instant it landed. Polling activeElement later
   reads the hand-back's overwrite — the defect erasing its own
   evidence. */
await page.evaluate(() => {
  window.__L = [];
  const nm = (e) => e?.getAttribute?.('aria-label') || e?.className || e?.tagName || null;
  const zone = (e) => !e || e === document.body ? 'body'
    : e.closest?.('.w-touch') ? 'pad'
      : e.closest?.('.w-sheet,.w-pause,.w-phone') ? (e.closest('.out') ? 'DYING' : 'panel') : 'other';
  document.addEventListener('focusin', (e) => window.__L.push({ ev: 'in', z: zone(e.target), l: nm(e.target), t: +performance.now().toFixed(1) }), true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Tab') window.__L.push({ ev: 'TAB', t: +performance.now().toFixed(1) }); }, true);
});

const JUMP = await padAt('Jump'), MENU = await padAt('Menu');
console.log('geometry', JSON.stringify({ JUMP, MENU }));

/* ---- floor ---- */
await reset();
await armSampler(); await page.waitForTimeout(720);
const idle = await readSampler();
ok(idle.peak < 0.2 && idle.n > 8, 'FLOOR [the sampler is alive and standing still is not a jump]', `peak ${idle.peak} over ${idle.n} frames`);
const FLOOR = idle.peak;

/* ============================================================
   ONE GESTURE: tab once, thumbs only, open with a thumb, close with a
   thumb, then a REAL dispatched Tab `off` ms after the closing lift.
   Then Space, and we ask the GAME what the Space meant.
   ============================================================ */
const gesture = async ({ off = 0, tab = true }) => {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); });
  await reset();
  const tabs = await tabTo('Menu');
  await tap(JUMP, 110);
  const poisoned = await kb();
  await tap(MENU, 70);
  await page.waitForTimeout(720);
  const opened = await panels();
  const rb = await resumeAt();
  await page.evaluate(() => { window.__L = []; });
  if (rb) await liftOnly(rb, 45);
  if (tab) { if (off) await page.waitForTimeout(off); await page.keyboard.press('Tab'); }
  await page.waitForTimeout(950);
  const led = await page.evaluate(() => window.__L.slice());
  const ti = led.findIndex((e) => e.ev === 'TAB');
  const landed = (ti >= 0 ? led.slice(ti + 1).find((e) => e.ev === 'in') : null) || { z: 'none', l: null };
  const after = await kb();
  const r = await rec();
  const ring = await lbl();
  /* THE MEANING, AT THE END OF THE WIRE.
     HELD, NOT TAPPED. keyboard.press() is a keydown and keyup with
     nothing between them: the game reads `keys[e.code]` once a frame,
     so a zero-length Space can be set and cleared inside one frame and
     read as "he did not jump" on a box that is busy. That is a harness
     flake pretending to be a product failure — my first run of this
     file produced exactly one. A button's click still arrives on the
     keyup, so holding costs the button nothing. */
  await armSampler();
  await page.keyboard.down('Space');
  await page.waitForTimeout(200);
  await page.keyboard.up('Space');
  await page.waitForTimeout(700);
  const pk = await readSampler();
  const pn = await panels();
  const t0 = led.length ? led[0].t : 0;
  return {
    tabs, opened, landed, after, rec: r, ring, peak: pk.peak, frames: pk.n, panels: pn,
    heard: pn.length === 1 && pn[0] === 'pause',
    trace: led.map((e) => `${e.ev}${e.l ? `(${e.z}:${e.l})` : ''}@+${(e.t - t0).toFixed(0)}`).join(' '),
  };
};

/* ============================================================
   1. THE SWEEP — several offsets ACROSS the hand-back window, with the
   window held open so every offset is INSIDE it. The stall moves only
   WHEN the landing attempt happens; the baseline is still sampled once
   at the close and the comparison still runs at the attempt that
   lands, so this widens the window without touching the rule.
   ============================================================ */
const STALL = +(process.argv.find((a) => a.startsWith('--stall='))?.split('=')[1] || 8);
await stall(STALL);
console.log(`stall ${STALL} frames`);
/* WHEN THE PANEL NODE ACTUALLY LEAVES THE DOM. The removal is
   WALL-CLOCK (~300 ms) and the retry is FRAME-COUNTED, so on a slow
   box the landing attempt can fall on the far side of it — at which
   point the Tab's focus has already been dropped to <body> and the
   deliberate "<body> is not a player move" rule reads the overwrite as
   a faithful restore. This records the removal so that claim is a
   measurement and not an inference. */
await page.evaluate(() => {
  window.__GONE = null;
  new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.removedNodes) {
      if (n.nodeType === 1 && n.matches?.('.w-sheet,.w-pause,.w-phone')) window.__GONE = +performance.now().toFixed(1);
    }
  }).observe(document.body, { childList: true, subtree: true });
});
const OFFSETS = [0, 8, 20, 40, 70, 110];
const sweep = { sign: [], none: [] };
for (const off of OFFSETS) {
  for (const m of ['sign', 'none']) {
    await mode(m);
    const g = await gesture({ off });
    sweep[m].push({ off, z: g.landed.z, heard: g.heard, driving: g.after.driving, ring: g.ring, signed: g.rec?.signed, moved: g.rec?.moved, peak: g.peak, panels: g.panels });
    console.log(`    [${m}] off=${off}ms  tab landed ${g.landed.z}:${g.landed.l}  ring=${g.ring}  signed=${g.rec?.signed} moved=${g.rec?.moved}  Space -> ${g.heard ? 'BUTTON FIRED (pause)' : `no panel, vy ${g.peak}`}\n         trace ${g.trace}`);
  }
}
await mode('sign');

const enteredBranch = sweep.none.filter((r) => r.z === 'DYING').length;
ok(enteredBranch >= OFFSETS.length - 1,
  `SWEEP-pre [BRANCH: every offset really is INSIDE the window and really does enter the defect]: with the signature unconditional the Tab lands in the ALREADY-CLOSING panel at ${enteredBranch}/${OFFSETS.length} offsets. Without this line the sweep below could be green because the Tab never raced anything`,
  JSON.stringify(sweep.none.map((r) => `${r.off}ms:${r.z}`)));

const signHeard = sweep.sign.filter((r) => r.heard).length;
const signRing = sweep.sign.filter((r) => r.ring !== null).length;
ok(signHeard === OFFSETS.length,
  `SWEEP [BRANCH: the withheld signature — the Tab keeps its MEANING at every offset]: at each of ${OFFSETS.length} offsets across the window the Space that follows the Tab OPENS THE PAUSE SHEET. Measured from the game, not from a flag`,
  `heard ${signHeard}/${OFFSETS.length}  |  pre-fix arm heard ${sweep.none.filter((r) => r.heard).length}/${OFFSETS.length}`);
ok(signRing === OFFSETS.length && sweep.sign.every((r) => r.ring === 'Menu'),
  `SWEEP-b [and it keeps its FOCUS]: at every offset the ring ends on the live Menu button — not on <body> and not inside a node that is removed 300 ms later`,
  JSON.stringify(sweep.sign.map((r) => `${r.off}ms:${r.ring}`)));

/* ---- the same sweep with the window NOT held open: the raw rate ---- */
await stall(0);
const raw = { sign: 0, none: 0, n: 0 };
for (const off of [0, 6, 14]) {
  for (const m of ['sign', 'none']) {
    await mode(m);
    const g = await gesture({ off });
    if (!g.heard) raw[m]++;
    if (m === 'sign') raw.n++;
    console.log(`    RAW [${m}] off=${off}ms  landed ${g.landed.z}:${g.landed.l}  ring=${g.ring}  rec ${JSON.stringify(g.rec)}\n         trace ${g.trace}`);
  }
}
await mode('sign');
ok(raw.sign === 0,
  'RAW [the rate on the unstalled gesture]: with nothing holding the window open the Tab is still heard every time. The pre-fix arm is reported, not asserted — it must LOSE a 7-10 ms race to fail and a quiet box may not lose it',
  `sign deaf ${raw.sign}/${raw.n}, pre-fix arm deaf ${raw.none}/${raw.n} (reported)`);

/* ============================================================
   2. THE THUMB PLAYER IS UNHARMED — tabbed once, then thumbs only, no
   Tab anywhere near the close, then Space MEANING JUMP.
   ============================================================ */
await stall(0);
const quiet = await gesture({ tab: false });
ok(quiet.rec && quiet.rec.moved === false && quiet.rec.signed === true
  && quiet.after.driving === true && quiet.panels.length === 0 && quiet.peak > FLOOR + 1.0,
  'THUMB [BRANCH: nothing moved, so the restore is faithful and IS signed]: tabbed once for any reason, then thumbs only, then Space meaning jump — HE JUMPS and no sheet opens. The new rule is inert here, which is the only way the old fix survives the new one',
  `peak vy ${quiet.peak} (floor ${FLOOR}, ${quiet.frames} frames), panels ${JSON.stringify(quiet.panels)}, rec ${JSON.stringify(quiet.rec)}`);

/* ============================================================
   3. TABBED, THEN SPACE, NO TOUCH BETWEEN — the button fires.
   ============================================================ */
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); });
await reset();
const t3 = await tabTo('Menu');
const k3 = await kb();
await page.keyboard.press('Space');
await page.waitForTimeout(800);
const p3 = await panels();
ok(t3 !== null && k3.driving === false && k3.padTakesSpace === true && p3.length === 1 && p3[0] === 'pause',
  'KEYONLY [BRANCH: no touch since the focus, so the BUTTON owns Space]: Tab to Menu, Space, and the PAUSE sheet opens. Named and counted — `length === 1` alone once passed with the wrong panel already up',
  `${JSON.stringify(k3)} -> ${JSON.stringify(p3)}`);

/* ============================================================
   4. THE KEYBOARD PLAYER STILL GETS HIS PLACE BACK.
   ============================================================ */
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); });
await reset();
const t4 = await tabTo('Menu');
await page.keyboard.press('Space');
await page.waitForTimeout(800);
const open4 = await panels();
const in4 = await page.evaluate(() => {
  const a = document.activeElement, p = a?.closest?.('.w-sheet,.w-phone,.w-pause');
  return { inPanel: !!p, role: p?.getAttribute('role') || null, modal: p?.getAttribute('aria-modal') || null };
});
await page.keyboard.press('Escape');
await page.waitForTimeout(1000);
const shut4 = await panels(), k4 = await kb(), r4 = await rec();
ok(t4 !== null && open4.length === 1 && in4.inPanel === true && in4.role === 'dialog',
  'SHEET-pre [the sheet TOOK the keyboard, so there is something to hand back]: without this the restore never runs and SHEET is vacuously green',
  `${JSON.stringify(open4)} ${JSON.stringify(in4)}`);
ok(shut4.length === 0 && k4.focus === 'Menu' && k4.padFocused === true
  && k4.driving === false && k4.padTakesSpace === true,
  'SHEET [BRANCH: a keyboard player closing a sheet gets his place AND his Space back]: Escape returns focus to the Menu button he opened it from, not to <body>',
  `${JSON.stringify(k4)} restore ${JSON.stringify(r4)}`);
await page.keyboard.press('Space');
await page.waitForTimeout(800);
const p4b = await panels();
ok(p4b.length === 1 && p4b[0] === 'pause',
  'SHEET-b [the returned place is a WORKING one]: Space on the handed-back button re-opens the pause sheet — a live control, not a dead ring',
  `panels ${JSON.stringify(p4b)}`);

console.log(`\n${fails ? 'FAIL' : 'OK'} — ${fails} failing`);
await browser.close();
server.close();
process.exit(fails ? 1 : 0);
