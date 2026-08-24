/* _vj-liftoffsets.mjs — INDEPENDENT verification of the PANEL-8 fix
   (the Tab pressed on the closing lift), written from scratch so a
   harness bug shared with tools/touchtest.mjs cannot make both green.

   What it does that the suite does not: sweeps the Tab across SEVERAL
   offsets of the hand-back window rather than testing one, and proves
   "kept its meaning" by actually PRESSING SPACE and watching what the
   game does, not by reading WALLY.debug.padKeyboard() and trusting it.

   Real Input.dispatchTouchEvent at 390x844, hasTouch + isMobile.

     --mode=sign|none|all   force the in-page yield arm (default: leave
                            whatever ships, i.e. do not touch it)
*/
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

const ARM = (process.argv.find((a) => a.startsWith('--mode=')) || '').split('=')[1] || null;

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
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message.split('\n')[0]); fails++; });
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(3500);

const cdp = await ctx.newCDPSession(page);
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 14, radiusY: 14, force: 1 }],
});
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
const padAt = (label) => page.evaluate((l) => {
  const b = [...document.querySelectorAll('.w-abtn')].find((e) => e.getAttribute('aria-label') === l);
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, label);
const tap = async (p, hold = 70, settle = 280) => {
  await touch('touchStart', p.x, p.y); await page.waitForTimeout(hold);
  await touch('touchEnd', p.x, p.y); await page.waitForTimeout(settle);
};
const focusLabel = () => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return null;
  return a.getAttribute?.('aria-label') || a.className || a.tagName;
});
const tabTo = async (label, max = 40) => {
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.waitForTimeout(200);
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab'); await page.waitForTimeout(60);
    if (await focusLabel() === label) return i + 1;
  }
  return null;
};
/* WHERE THE PLAYER'S OWN KEYSTROKE PUT THE KEYBOARD, from a ledger and
   not a poll: the hand-back overwrites it a few frames later, which is
   the defect itself erasing the evidence for the defect. */
await page.evaluate(() => {
  window.__L = [];
  const lbl = (e) => e?.getAttribute?.('aria-label') || e?.className || e?.tagName || null;
  const zone = (e) => !e ? 'body'
    : (e.closest?.('.w-touch') ? 'pad'
      : (e.closest?.('.w-sheet,.w-pause,.w-phone') ? (e.closest('.out') ? 'DYING' : 'panel') : 'other'));
  document.addEventListener('focusin', (e) => window.__L.push(
    { ev: 'focusin', where: zone(e.target), label: lbl(e.target), at: +performance.now().toFixed(1) }), false);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') window.__L.push({ ev: 'TAB', at: +performance.now().toFixed(1) });
  }, true);
});
const resumeAt = () => page.evaluate(() => {
  const b = [...document.querySelectorAll('.w-pause button, .w-sheet button')]
    .find((e) => /resume/i.test(e.textContent || ''));
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
const peakJump = async (hold = 200, watch = 520) => {
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
  await page.keyboard.down('Space'); await page.waitForTimeout(hold);
  await page.keyboard.up('Space'); await page.waitForTimeout(watch);
  const r = await page.evaluate(() => { window.__pk.on = false; return { peak: +window.__pk.max.toFixed(3), n: window.__pk.n }; });
  return { ...r, panels: await panels() };
};

const JUMP = await padAt('Jump'), MENU = await padAt('Menu');
console.log('geometry', JSON.stringify({ JUMP, MENU }), 'arm', ARM || '(as shipped)');
if (ARM) console.log('forced yield mode ->', await page.evaluate((m) => WALLY.debug.padHandBackYield(m), ARM));

await reset();
const idle = await (async () => {
  await page.evaluate(() => {
    window.__pk = { max: -1e9, n: 0, on: true };
    const t = () => { if (!window.__pk.on) return; const c = WALLY.ctx.wally.controller, v = c && (c.velocity || c.vel); if (v) { if (v.y > window.__pk.max) window.__pk.max = v.y; window.__pk.n++; } requestAnimationFrame(t); };
    requestAnimationFrame(t);
  });
  await page.waitForTimeout(720);
  return page.evaluate(() => { window.__pk.on = false; return { peak: +window.__pk.max.toFixed(3), n: window.__pk.n }; });
})();
ok(idle.peak < 0.2 && idle.n > 8,
  'FLOOR [the sampler runs and standing still is not a jump]',
  `peak ${idle.peak} over ${idle.n} frames`);
const FLOOR = idle.peak;

/* ============ ONE GESTURE: thumbs, then a Tab `at` ms into the close.
   `stallN` widens the hand-back's retry window so the Tab is INSIDE it
   deterministically; stallN 0 is the raw race a real player runs. ==== */
const gesture = async ({ at = 0, stallN = 0, tab = true } = {}) => {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); });
  await reset();
  const tabs = await tabTo('Menu');            // the ONE Tab that poisons the state
  await tap(JUMP, 110);                        // thumbs from here on
  const poisoned = await kb();
  await tap(MENU, 70); await page.waitForTimeout(700);
  const opened = await panels();
  const rb = await resumeAt();
  await page.evaluate((n) => { window.__L = []; WALLY.debug.padHandBackStall(n); }, stallN);
  if (rb) await tap(rb, 45, 0);
  if (tab) { if (at) await page.waitForTimeout(at); await page.keyboard.press('Tab'); }
  await page.waitForTimeout(950);
  await page.evaluate(() => WALLY.debug.padHandBackStall(0));
  const led = await page.evaluate(() => window.__L.slice());
  const ti = led.findIndex((e) => e.ev === 'TAB');
  const mid = (ti >= 0 ? led.slice(ti + 1).find((e) => e.ev === 'focusin') : null) || { where: 'none', label: null };
  const end = await page.evaluate(() => {
    const a = document.activeElement;
    return {
      label: a?.getAttribute?.('aria-label') || a?.className || a?.tagName || null,
      live: !!a && a.isConnected === true && a !== document.body,
      inPad: !!a?.closest?.('.w-touch'),
      inDying: !!a?.closest?.('.out'),
    };
  });
  const t0 = led.length ? led[0].at : 0;
  const trace = led.map((e) => `${e.ev}${e.label ? `(${e.where}:${e.label})` : ''}@+${(e.at - t0).toFixed(0)}`).join(' ');
  return { tabs, poisoned, opened, mid, end, kb: await kb(), rec: await rec(), trace, tabbed: tab };
};
/* MEANING, MEASURED AND NOT READ OFF A FLAG: press Space and see what
   the game does. A Tab that kept its meaning leaves the FOCUSED BUTTON
   owning Space, so the pause sheet opens. (Space is also bound on
   `window` with no focus test, so he jumps either way — the panel list
   is the load-bearing half, exactly as the earlier judge found.) */
const spaceNow = async () => { const j = await peakJump(); return { ...j, kb: await kb() }; };

/* ---------- 1. THE SWEEP, window held open (deterministic) ---------- */
const OFFS = [0, 10, 25, 50, 90];
const sweep = [];
for (const at of OFFS) {
  const g = await gesture({ at, stallN: 8 });
  const s = await spaceNow();
  sweep.push({ at, g, s });
  console.log(`  offset +${at}ms  tab landed ${g.mid.where}:${g.mid.label}  end ${JSON.stringify(g.end)}  driving ${g.kb.driving} takesSpace ${g.kb.padTakesSpace}  SPACE -> panels ${JSON.stringify(s.panels)} vy ${s.peak}\n     rec ${JSON.stringify(g.rec)}\n     ${g.trace}`);
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); });
  await page.waitForTimeout(300);
}
ok(sweep.every((r) => r.g.tabs !== null && r.g.opened.length === 1 && r.g.poisoned.driving === true
  && r.g.poisoned.focus === 'Menu'),
  'SWEEP-pre [BRANCH: every offset really reaches the poisoned state]: one Tab, then real fingers only — the keyboard bookmark is still on Menu with `driving` set, which is the state the hand-back has to aim at. Without this the sweep could be green by never entering the path',
  sweep.map((r) => `+${r.at}: tabs ${r.g.tabs} driving ${r.g.poisoned.driving} focus ${r.g.poisoned.focus}`).join(' | '));
ok(sweep.every((r) => r.g.rec && r.g.rec.attempts > 2 && r.g.rec.landed === true),
  'SWEEP-pre2 [BRANCH: the Tab is INSIDE a multi-attempt hand-back, not racing one]: the retry window is held open, so every offset lands between the close and the attempt that succeeds — the branch is entered on any box, not only on a busy one',
  sweep.map((r) => `+${r.at}: attempts ${r.g.rec.attempts} landed ${r.g.rec.landed}`).join(' | '));
ok(sweep.every((r) => r.g.end.live === true && r.g.end.inPad === true && r.g.end.inDying === false),
  'SWEEP-focus [BRANCH: the Tab KEEPS ITS FOCUS — a live one]: at every offset the ring ends on a connected pad button, never on <body> and never inside the node the close is about to remove. This is the half the rejected `all` arm loses',
  sweep.map((r) => `+${r.at}: ${r.g.end.label} live ${r.g.end.live} inPad ${r.g.end.inPad} dying ${r.g.end.inDying}`).join(' | '));
ok(sweep.every((r) => r.g.kb.driving === false && r.g.kb.padTakesSpace === true),
  'SWEEP-meaning [BRANCH: ...AND ITS MEANING — the signature is withheld]: at every offset the hand-back sees that the focus it is replacing is no longer the one the close left behind, restores the position unsigned, and the pad clears the intent flag as it does for any player focus',
  sweep.map((r) => `+${r.at}: driving ${r.g.kb.driving} takesSpace ${r.g.kb.padTakesSpace} signed ${r.g.rec.signed} moved ${r.g.rec.moved}`).join(' | '));
/* WHICH CONTROL THE RING ENDS ON IS NOT FIXED, AND THE FIRST CUT OF THE
   TWO ASSERTIONS BELOW ASSUMED IT WAS. They demanded the PAUSE sheet at
   every offset. But the hand-back sometimes WINS the race: it lands
   first, restores Menu, and the player's Tab then moves Menu -> Jump
   INSIDE the pad, where the pad's own focusin rule sees it. Space is
   then JUMP's to answer, and a jump with NO sheet is the CORRECT
   outcome. Demanding "pause" there fails a correct product — red for
   the wrong reason, which is the same mistake as green for the wrong
   reason with the sign flipped, and it cost a verify pass. Measured on
   this box (load 6.7-7.0 at run, 10 cpus): held-open +90 ms and ALL
   FOUR raw offsets land the ring on Jump.

   So the rule is keyed on WHERE THE RING ACTUALLY IS, and the control
   it is on must do its OWN job:
     Menu -> the pause sheet opens
     Jump -> he jumps and NOTHING opens
   Space is bound on `window` with no focus test, so vy alone cannot
   tell the two apart; the PANEL LIST is the discriminator in both. */
const ownJob = (r) => {
  const l = r.g.end.label;
  if (l === 'Menu') return r.s.panels.length === 1 && r.s.panels[0] === 'pause';
  if (l === 'Jump') return r.s.panels.length === 0 && r.s.peak > FLOOR + 1.0;
  return false;                       // an unmodelled control is not a pass
};
const jobStr = (r) => `+${r.at}: ring ${r.g.end.label} -> panels ${JSON.stringify(r.s.panels)} vy ${r.s.peak} ${ownJob(r) ? 'OK' : 'WRONG'}`;
ok(sweep.every(ownJob),
  'SWEEP-live [and the meaning is a WORKING one, pressed rather than read]: Space after each offset operates THE CONTROL THE RING IS ACTUALLY ON — the pause sheet from Menu, a jump and no sheet from Jump. Keyed on the ring rather than on an assumed Menu; named and counted, because `length === 1` alone once passed with the wrong panel already open',
  sweep.map(jobStr).join(' | '));

/* ---------- 2. THE SWEEP, RAW — no window held open ----------------- */
const RAW = [0, 5, 12, 25];
const raw = [];
for (const at of RAW) {
  const g = await gesture({ at, stallN: 0 });
  const s = await spaceNow();
  raw.push({ at, g, s });
  console.log(`  RAW +${at}ms  tab landed ${g.mid.where}:${g.mid.label}  driving ${g.kb.driving}  SPACE -> ${JSON.stringify(s.panels)}   rec ${JSON.stringify(g.rec)}`);
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); });
  await page.waitForTimeout(300);
}
ok(raw.every((r) => r.g.end.live && r.g.end.inPad && r.g.kb.driving === false
  && r.g.kb.padTakesSpace === true && ownJob(r)),
  'RAW-sweep [the same thing on the raw gesture, with nothing widened]: at four offsets across the real 7-10 ms race the Tab keeps its focus and its meaning, and the control the ring is on answers its Space. The held-open sweep proves the RULE; this proves the RATE. Keyed on the ring for the reason in the note above — on a quiet box the hand-back WINS this race every time and the ring legitimately ends on Jump',
  raw.map((r) => `+${r.at}: land ${r.g.mid.where} driving ${r.g.kb.driving} ${jobStr(r)}`).join(' | '));

/* ---------- 3. THE THUMB PLAYER IS UNCHANGED ------------------------ */
const quiet = await gesture({ tab: false, stallN: 8 });
const qs = await spaceNow();
ok(quiet.rec && quiet.rec.moved === false && quiet.rec.signed === true
  && quiet.kb.driving === true && quiet.kb.padTakesSpace === false
  && qs.panels.length === 0 && qs.peak > FLOOR + 1.0,
  'THUMB [BRANCH: nothing moved, so it is a faithful RESTORE and IS signed]: tabbed once, then thumbs only, then Space — HE JUMPS and no sheet opens. The peak vertical velocity is the measurement; the empty panel list is the discriminator, because Space is bound on `window` and he jumps in the broken state too',
  `peak vy ${qs.peak} (floor ${FLOOR}, ${qs.n} frames), panels ${JSON.stringify(qs.panels)}, rec ${JSON.stringify(quiet.rec)}`);

/* ---------- 4. TABBED, THEN SPACE, NO TOUCH BETWEEN ----------------- */
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); });
await reset();
const t4 = await tabTo('Menu');
const k4 = await kb();
await page.keyboard.press('Space'); await page.waitForTimeout(800);
const p4 = await panels();
ok(t4 !== null && k4.driving === false && k4.padTakesSpace === true && p4.length === 1 && p4[0] === 'pause',
  'KEYBOARD [BRANCH: no touch since the focus, so the BUTTON owns Space]: Tab to Menu, press Space with nothing touched in between — the pause sheet opens',
  `${JSON.stringify(k4)} -> ${JSON.stringify(p4)}`);

/* ---------- 5. A KEYBOARD PLAYER CLOSING A SHEET KEEPS HIS PLACE ---- */
await page.keyboard.press('Escape'); await page.waitForTimeout(1000);
const p5 = await panels(); const k5 = await kb(); const r5 = await rec();
ok(p5.length === 0 && k5.focus === 'Menu' && k5.padFocused === true
  && k5.driving === false && k5.padTakesSpace === true,
  'SHEET [BRANCH: a keyboard player closing a sheet gets his place back AND his Space]: Escape returns the keyboard to the button he opened it from — not to <body>, which would restart sequential navigation at the top of the document',
  `${JSON.stringify(k5)} restore ${JSON.stringify(r5)}`);
await page.keyboard.press('Space'); await page.waitForTimeout(800);
const p5b = await panels();
ok(p5b.length === 1 && p5b[0] === 'pause',
  'SHEET-live [and the place he got back WORKS]: Space on the handed-back button re-opens the pause sheet — a live control, not a dead ring',
  `panels ${JSON.stringify(p5b)}`);

console.log(`\n${fails ? 'FAIL' : 'OK'} — ${fails} failing`);
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
