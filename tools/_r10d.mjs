/* _r9e.mjs — ROUND NINE part 5. The regression, proved as an A/B on ONE
   page at ONE load: the signature ON (shipping) against the signature
   OFF (byte-for-byte the pre-fix behaviour, since ui.js reads
   touch.uiWillFocus off the object at call time and an always-false
   answer means nothing is ever signed and every restore clears the
   flag). Alternating arms, twenty gestures each, identical finger
   events, one Tab. Plus the census of where that Tab actually lands. */
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
const KEYS = { Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 } };
const keyDown = (n) => cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...KEYS[n] });
const keyUp = (n) => cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...KEYS[n], text: undefined });
const key = async (n, h = 25) => { await keyDown(n); await wait(h); await keyUp(n); };
const panelsNow = () => page.evaluate(() => WALLY.ctx.ui.panels.slice());
const padKb = () => page.evaluate(() => WALLY.debug.padKeyboard());
const focusNow = () => page.evaluate(() => { const a = document.activeElement;
  return { tag: a ? a.tagName.toLowerCase() : null, label: a?.getAttribute?.('aria-label') || null, inPad: !!a?.closest?.('.w-touch') }; });
const press = async (x, y, hold) => { await touch('touchStart', x, y); await wait(hold); await touch('touchEnd', x, y); };
const padAt = (l) => page.evaluate((L) => { const b = [...document.querySelectorAll('.w-abtn')].find(e => e.getAttribute('aria-label') === L);
  const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, l);
const tabTo = async (l, max = 90) => { await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); }); await wait(250);
  for (let i = 0; i < max; i++) { await page.keyboard.press('Tab'); const f = await focusNow(); if (f.inPad && f.label === l) return { ...f, tabs: i + 1 }; } return null; };
const thumbJump = async (hold = 120) => { const c = await padAt('Jump');
  await touch('touchStart', c.x, c.y); await wait(hold); await touch('touchEnd', c.x, c.y); await wait(260); };
const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const toOpenGround = () => page.evaluate((b) => { WALLY.ctx.ui.closeAll(); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {}); }, BOOT);
await page.evaluate(() => { WALLY.debug.hideUI(false); WALLY.ctx.ui.closeAll(); });
await wait(400);
const menu7 = await padAt('Menu');
/* ============================================================
   THE TAB PRESSED ON THE CLOSING LIFT (PANEL-8 .. PANEL-8g)

   WHY THIS BLOCK EXISTS. PANEL-7 above is right and it shipped a
   regression, which is the honest way to describe what the signature
   did: it taught the hand-back to say "I performed this focus" and
   left it silent about "and I am overwriting one the player performed
   6 ms ago". A Tab pressed inside the hand-back's own retry window was
   eaten. Measured as an A/B on one page, one load, alternating arms,
   sixteen gestures each, identical finger events throughout — thumb
   Jump, thumb Menu, thumb Resume — with one Tab on the closing lift:

     signature ON  (as PANEL-7 shipped it)  ->  DEAF 9 of 16
     signature OFF (pre-fix)                ->  DEAF 0 of 16

   DEAF is the player's own sentence: I pressed Tab, the ring is on
   Menu, and the pad still will not take my key. The ledger is a 7-10
   ms race — the Tab lands inside the ALREADY-CLOSING panel, outside
   the pad's root where the pad's focusin rule cannot see it, and the
   signed hand-back then overwrites that focus while keeping `driving`
   alive across the overwrite. The Tab is lost twice: its focus move is
   undone AND its meaning is discarded. Before the signature, the
   restore's own unsigned focusin cleared the flag and ACCIDENTALLY
   RESCUED the Tab; PANEL-7 removed the accident without replacing it.

   AND THE SUITE MUST NOT HAVE TO WIN A RACE TO ENTER THE BRANCH.
   Eight times on this project an assertion has been green for the
   wrong reason, and "the box was quiet, so the window never opened"
   would be the ninth. WALLY.debug.padHandBackStall(n) holds the retry
   window open for n extra frames. It moves WHEN the landing attempt
   happens and touches none of the logic under test: the baseline is
   still sampled once when the close began, the comparison still runs
   at the attempt that lands. So the branch is entered every time, on
   any box, and PANEL-8b can put the Tab at frame three of nine — which
   is the retry-proofing itself, asserted rather than hoped for.

   PANEL-8f then reports the UNSTALLED rate, because the stall proves
   the rule and only the raw gesture proves the rate.
   ============================================================ */
const yieldMode = (m) => page.evaluate((v) => WALLY.debug.padHandBackYield(v), m);
const stall = (n) => page.evaluate((v) => WALLY.debug.padHandBackStall(v), n);
/* WHERE THE TAB LANDED, FROM A LEDGER AND NOT FROM A POLL. The first
   cut of this block read document.activeElement 60 ms after the Tab
   and got the wrong answer for an honest reason: with the window held
   open the hand-back had already landed and OVERWRITTEN the Tab's
   focus by the time the sample was taken — which is the defect itself,
   erasing the evidence for the defect. A focusin listener sees the
   landing at the instant it happens and cannot be overwritten. */
await page.evaluate(() => {
  window.__F8 = [];
  const lbl = (e) => e?.getAttribute?.('aria-label') || e?.className || e?.tagName || null;
  const zone = (e) => !e ? 'body'
    : (e.closest?.('.w-touch') ? 'pad'
      : (e.closest?.('.w-sheet,.w-pause,.w-phone') ? (e.closest('.out') ? 'DYING' : 'panel') : 'other'));
  document.addEventListener('focusin', (e) => window.__F8.push(
    { ev: 'focusin', where: zone(e.target), label: lbl(e.target), at: +performance.now().toFixed(1) }), false);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') window.__F8.push({ ev: 'TAB', at: +performance.now().toFixed(1) });
  }, true);
});
const resumeAt = () => page.evaluate(() => {
  const b = [...document.querySelectorAll('.w-pause button, .w-sheet button')]
    .find((e) => /resume/i.test(e.textContent || ''));
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
/* the stale-focus state PANEL-7 is about: one Tab ever, then thumbs */
const stale8 = async () => {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); });
  await toOpenGround();
  await page.waitForTimeout(500);
  const t = await tabTo('Menu');
  await thumbJump(110);
  return t;
};
/* ONE gesture. Thumb Menu open, thumb Resume shut, then a real
   dispatched Tab `at` ms after the closing lift. `mid` is where that
   Tab actually landed, read before the hand-back can move it again. */
const liftTab = async ({ at = 40, tab = true } = {}) => {
  const pre = await stale8();
  await press(menu7.x, menu7.y, 60);
  await page.waitForTimeout(700);
  const opened = await panelsNow();
  const rb = await resumeAt();
  await page.evaluate(() => { window.__F8 = []; });
  if (rb) await press(rb.x, rb.y, 45);
  if (tab) {
    if (at) await page.waitForTimeout(at);
    await page.keyboard.press('Tab');
  }
  await page.waitForTimeout(900);
  /* the FIRST focusin after the Tab keystroke — where the player's own
     keystroke put the keyboard, before anything could move it again */
  const led = await page.evaluate(() => window.__F8.slice());
  const ti = led.findIndex((e) => e.ev === 'TAB');
  const mid = (ti >= 0 ? led.slice(ti + 1).find((e) => e.ev === 'focusin') : null)
    || { where: 'none', label: null };
  const kb = await padKb();
  const f = await focusNow();
  const rec = await page.evaluate(() => WALLY.debug.focusRestore());
  const t0 = led.length ? led[0].at : 0;
  const trace = led.map((e) => `${e.ev}${e.label ? '(' + e.where + ':' + e.label + ')' : ''}@+${(e.at - t0).toFixed(0)}`).join(' ');
  return { pre, opened, mid, kb, f, rec, trace, deaf: kb.driving === true, ranTab: tab };
};

await stall(8);                       // ~130 ms of window on this box

/* --- BRANCH the defect, held open: the arm PANEL-7 shipped --- */
await yieldMode('none');
const g8none = await liftTab({ at: 0 });
ok(g8none.pre !== null && g8none.opened.length === 1
  && g8none.mid.where === 'DYING' && g8none.deaf === true
  && g8none.kb.padFocused === true && g8none.kb.padTakesSpace === false,
  'PANEL-8-pre [BRANCH: the defect, and the setup really enters it]: with the signature unconditional, a Tab pressed on the closing lift lands inside the ALREADY-CLOSING panel — outside the pad, where the pad cannot see it — and the signed hand-back then overwrites it. The ring ends on a pad button and the pad still refuses the key. Asserted with the window held open so this is the branch and not the weather',
  `tab landed ${g8none.mid.where}:${g8none.mid.label}, then ${JSON.stringify(g8none.kb)}\n        rec ${JSON.stringify(g8none.rec)}\n        ${g8none.trace}`);

/* --- BRANCH the fix: the position is restored, the SIGNATURE is not --- */
await yieldMode('sign');
const g8sign = await liftTab({ at: 0 });
ok(g8sign.mid.where === 'DYING' && g8sign.deaf === false && g8sign.kb.padTakesSpace === true,
  'PANEL-8 [BRANCH: the hand-back yields its SIGNATURE, not its focus]: the same Tab, the same window, the same landing inside the dying panel — but the hand-back can see that the focus it is about to replace is no longer the one the close left behind, so it restores the position UNSIGNED. The pad reads an ordinary player focus, clears the intent flag, and the keystroke keeps its meaning',
  `tab landed ${g8sign.mid.where}:${g8sign.mid.label}, then ${JSON.stringify(g8sign.kb)}\n        ${g8sign.trace}`);

ok(g8sign.f.inPad === true && g8sign.kb.padFocused === true,
  'PANEL-8a [and the player keeps a real place in the document]: yielding the SIGNATURE and not the FOCUS is the whole reason to prefer it — the ring ends on a live pad button, not inside a node that is removed 300 ms later',
  `focus ${JSON.stringify(g8sign.f)}`);

ok(g8sign.rec && g8sign.rec.attempts > 2 && g8sign.rec.landed === true
  && g8sign.rec.moved === true && g8sign.rec.signed === false
  && g8sign.rec.yielded === false,
  'PANEL-8b [BRANCH: IT CANNOT BE DEFEATED BY THE RETRY, which is exactly how the first fix went wrong]: the Tab arrived at frame three of nine and the attempt that LANDED still saw it. The baseline is sampled ONCE when the close began and compared on EVERY attempt; recapturing it per attempt would put the player’s Tab into the baseline itself and make the check decorative',
  JSON.stringify(g8sign.rec));

/* --- BRANCH <body> is focus DROPPED, not focus MOVED. If a bare
       <body> counted as somebody else taking the keyboard, every
       hand-back would go unsigned and PANEL-7 would be back inside a
       week. The blur here is the harness constructing the state, not a
       player action: it is the state a removed panel node leaves. --- */
const g8body = await (async () => {
  const pre = await stale8();
  await press(menu7.x, menu7.y, 60);
  await page.waitForTimeout(700);
  const rb = await resumeAt();
  if (rb) await press(rb.x, rb.y, 45);
  await page.waitForTimeout(40);
  const dropped = await page.evaluate(() => {
    document.activeElement?.blur?.();
    return !document.activeElement || document.activeElement === document.body;
  });
  await page.waitForTimeout(900);
  return { pre, dropped, kb: await padKb(), rec: await page.evaluate(() => WALLY.debug.focusRestore()) };
})();
ok(g8body.dropped === true && g8body.rec && g8body.rec.moved === false
  && g8body.rec.signed === true && g8body.kb.driving === true
  && g8body.kb.padTakesSpace === false,
  'PANEL-8c [BRANCH: <body> is focus DROPPED, not focus MOVED]: focus reverting to <body> mid-window is the exact condition the hand-back exists to repair, so it does NOT count as the player taking the keyboard. The restore is still signed and the thumb player’s Space still belongs to the game — without this line the cure eats the disease',
  `${JSON.stringify(g8body.rec)} -> ${JSON.stringify(g8body.kb)}`);

/* --- BRANCH no race at all: the signature must still apply, or this
       is just a slower way of deleting PANEL-7 --- */
const g8quiet = await liftTab({ tab: false });
ok(g8quiet.rec && g8quiet.rec.moved === false && g8quiet.rec.signed === true
  && g8quiet.kb.driving === true && g8quiet.kb.padTakesSpace === false,
  'PANEL-8e [BRANCH: nothing moved, so it is a faithful RESTORE and is signed]: with no Tab anywhere near the close the rule is inert and PANEL-7 stands unchanged — the thumb player’s restored bookmark still does not speak for him',
  `${JSON.stringify(g8quiet.rec)} -> ${JSON.stringify(g8quiet.kb)}`);

/* --- BRANCH the REJECTED alternative, measured rather than argued.
       'all' abandons the hand-back whenever the focus moved. It does
       not even fix the symptom — the Tab landed in the DYING panel, so
       there is no pad focusin at all, the flag stays set, and now the
       keyboard is left in a node that is removed 300 ms later. It
       trades the player's place in the document for nothing. --- */
await yieldMode('all');
const g8all = await liftTab({ at: 0 });
await yieldMode('sign');
ok(g8all.rec && g8all.rec.yielded === true && g8all.rec.landed === false
  && g8all.f.inPad === false && g8all.deaf === true,
  'PANEL-8d [BRANCH: the alternative I rejected, as a measurement]: yielding the hand-back ENTIRELY leaves the keystroke lost AND the player on <body> — the PANEL-1 defect the hand-back was written to repair, bought at the price of the bug it was meant to fix. Kept in the suite so the rejection is a number and not a paragraph',
  `${JSON.stringify(g8all.rec)} -> focus ${JSON.stringify(g8all.f)}, ${JSON.stringify(g8all.kb)}`);

/* --- and the keystroke is LIVE, not merely accounted for. The Tab
       lands on a pad button; a Space there must operate it. --- */
await stall(0);
let at8 = (await padKb()).focus, hops8 = 0;
const g8live = await liftTab({ at: 0 });
at8 = g8live.kb.focus; hops8 = 0;
while (at8 !== 'Menu' && hops8 < 12) {
  await page.keyboard.press('Tab');
  at8 = (await padKb()).focus; hops8++;
}
await page.keyboard.press('Space');
await page.waitForTimeout(700);
const pnl8 = await panelsNow();
ok(at8 === 'Menu' && pnl8.length === 1 && pnl8[0] === 'pause',
  'PANEL-8g [and the hand-back is still LIVE after all of this]: walking on to Menu through the state the unsigned restore left behind — no blur to wash it out — and pressing Space opens the PAUSE sheet. Named and counted, because `length === 1` alone once passed with the wrong panel already open',
  `landed on ${JSON.stringify(at8)} after ${hops8} more tabs, panels ${JSON.stringify(pnl8)}`);
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); });
await page.waitForTimeout(400);

/* --- THE RATE, UNSTALLED. The stall proves the RULE; only the raw
       gesture proves the RATE, and the rate is what says whether this
       was worth fixing. Alternating arms on ONE page at ONE load,
       identical finger events, one Tab on the closing lift. The `none`
       arm is reported and not asserted: it is a race, and a quiet box
       may simply not lose it. The `sign` arm IS asserted, because a
       rule that holds under the stall must hold here too. --- */
const rate8 = { sign: 0, none: 0 };
const N8 = 8;
for (let i = 0; i < N8; i++) {
  for (const m of (i % 2 ? ['none', 'sign'] : ['sign', 'none'])) {
    await yieldMode(m);
    const g = await liftTab({ at: 0 });
    if (g.deaf) rate8[m]++;
  }
}
await yieldMode('sign');
ok(rate8.sign === 0,
  'PANEL-8f [the rate, on the raw gesture]: with the window NOT held open, a Tab pressed on the closing lift is heard every time. The pre-fix arm is printed beside it rather than asserted — it has to LOSE a 7-10 ms race to fail, and a quiet box may not lose it, which is why PANEL-8-pre holds the window open instead of trusting this number to enter the branch',
  `sign deaf ${rate8.sign}/${N8}, pre-fix arm deaf ${rate8.none}/${N8} (reported, not asserted)`);

/* ============================================================
   THE LAYER'S OTHER focus() CALLS LAND OUTSIDE THE PAD (PANEL-9)

   FLAGGED BY THE LAST AGENT AND NOT DONE. handBack() is signed because
   it aims at pad buttons. The two other focus() calls in this layer —
   openQuickBuy's in ui.js and the Clear button's in menus.js — are
   unsigned, and they are SAFE only because root.contains() rejects
   their target one line into the pad's focusin listener. Nothing
   asserted that. If a future sheet ever rendered a control inside the
   touch cluster, that unsigned focus would clear `driving` and hand
   the next Space to a pad button — PAD-35, back through a door nobody
   was watching. This is that door, with a lock on it.
   ============================================================ */
const staleQ = await stale8();
await page.evaluate(() => WALLY.ctx.ui.show('buy'));
await page.waitForTimeout(700);
const q9 = await page.evaluate(() => {
  const sheet = document.querySelector('.w-sheet');
  const input = sheet?.querySelector('input');
  const clear = sheet?.querySelector('.clr');
  const pad = document.querySelector('.w-touch');
  const focusables = [...document.querySelectorAll('.w-sheet,.w-pause,.w-phone')]
    .flatMap((p) => [...p.querySelectorAll('button,[href],input,select,textarea,[tabindex]')]);
  return {
    hasInput: !!input,
    hasClear: !!clear,
    focused: document.activeElement === input,
    inPad: !!input?.closest?.('.w-touch'),
    signable: input ? WALLY.debug.padSignFocus(input) : null,
    padHoldsAPanel: !!pad && [...document.querySelectorAll('.w-sheet,.w-pause,.w-phone')].some((p) => pad.contains(p)),
    strays: focusables.filter((e) => e.closest('.w-touch')).length,
    driving: WALLY.debug.padKeyboard().driving,
  };
});
ok(staleQ !== null && q9.hasInput && q9.hasClear && q9.focused === true,
  'PANEL-9-pre [the call really happens]: opening quick-buy focuses the search input menus.js also focuses from its Clear button — unsigned, both of them. Asserted first, so PANEL-9 cannot go green by the focus never occurring',
  JSON.stringify(q9));
ok(q9.inPad === false && q9.signable === false && q9.driving === true,
  'PANEL-9 [BRANCH: uiWillFocus REFUSES anything outside the cluster, which is the only reason those two calls are safe unsigned]: the input is not inside .w-touch, the pad declines to sign it, and focusing it leaves `driving` untouched. If a sheet ever renders a control inside the touch cluster this fails — an unsigned focus in there would clear the flag and hand the next Space to a pad button',
  JSON.stringify(q9));
ok(q9.padHoldsAPanel === false && q9.strays === 0,
  'PANEL-9b [and it is the whole layer, not one input]: no panel and no focusable control in the panel layer is a descendant of the pad root. The containment handBack()’s signature relies on is asserted rather than assumed',
  `panels inside pad ${q9.padHoldsAPanel}, stray controls ${q9.strays}`);
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); });
await page.waitForTimeout(400);


console.log('\nLOAD at end:', load());
console.log(`\n${fails ? 'FAIL' : 'PASS'} — ${fails} failing`);
await browser.close(); server.close(); process.exit(fails ? 1 : 0);
