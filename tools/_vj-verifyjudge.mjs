/* vj-verify.mjs — the VERIFY JUDGE's own probe, written from scratch.

   Purpose: _vj-liftoffsets.mjs FAILED two assertions (SWEEP-live, RAW-sweep)
   by demanding the ring end on Menu. When the hand-back WINS the race the
   Tab moves Menu -> Jump INSIDE the pad, and Space then operates JUMP, not
   Menu. That is correct behaviour under-specified, or it is a real defect.
   This probe decides it by measuring MEANING without assuming which control
   the ring ends on:

     1. the Tab keeps its FOCUS   -> live element, inside the pad, not in a
                                     node the close is about to remove
     2. the Tab keeps its MEANING -> `driving` cleared, padTakesSpace true,
                                     AND the control the ring is actually on
                                     does its OWN job when Space is pressed:
                                       Menu -> the pause sheet opens
                                       Jump -> he jumps and NO sheet opens
     3. ...and the ring is navigable: walk on to Menu with real Tabs and
                                     press Space -> the pause sheet opens.
                                     This is the unambiguous half — the
                                     pause sheet cannot come from the
                                     window-level Space binding.

   Real Input.dispatchTouchEvent at 390x844, hasTouch + isMobile.
     --mode=sign|none|all   force the yield arm (default: as shipped)
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

const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
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
const ring = () => page.evaluate(() => {
  const a = document.activeElement;
  return {
    label: a?.getAttribute?.('aria-label') || a?.className || a?.tagName || null,
    live: !!a && a.isConnected === true && a !== document.body,
    inPad: !!a?.closest?.('.w-touch'),
    inDying: !!a?.closest?.('.out'),
  };
});
const tabTo = async (label, max = 40) => {
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.waitForTimeout(200);
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab'); await page.waitForTimeout(60);
    if ((await ring()).label === label) return i + 1;
  }
  return null;
};
const resumeAt = () => page.evaluate(() => {
  const b = [...document.querySelectorAll('.w-pause button, .w-sheet button')]
    .find((e) => /resume/i.test(e.textContent || ''));
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
/* peak vertical velocity over the whole arc, sampled in-page on rAF */
const pressSpace = async (hold = 200, watch = 520) => {
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
await page.evaluate(() => {
  window.__pk = { max: -1e9, n: 0, on: true };
  const t = () => { if (!window.__pk.on) return; const c = WALLY.ctx.wally.controller, v = c && (c.velocity || c.vel); if (v) { if (v.y > window.__pk.max) window.__pk.max = v.y; window.__pk.n++; } requestAnimationFrame(t); };
  requestAnimationFrame(t);
});
await page.waitForTimeout(720);
const idle = await page.evaluate(() => { window.__pk.on = false; return { peak: +window.__pk.max.toFixed(3), n: window.__pk.n }; });
ok(idle.peak < 0.2 && idle.n > 8, 'FLOOR [the sampler runs and standing still is not a jump]', `peak ${idle.peak} over ${idle.n} frames`);
const FLOOR = idle.peak;

/* ONE gesture: poison the state with a single Tab, then real fingers
   only, then a real Tab `at` ms into the close. */
const gesture = async ({ at = 0, stallN = 0 } = {}) => {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); });
  await reset();
  const tabs = await tabTo('Menu');
  await tap(JUMP, 110);
  const poisoned = await kb();
  await tap(MENU, 70); await page.waitForTimeout(700);
  const opened = await panels();
  const rb = await resumeAt();
  await page.evaluate((n) => WALLY.debug.padHandBackStall(n), stallN);
  if (rb) await tap(rb, 45, 0);
  if (at) await page.waitForTimeout(at);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(950);
  await page.evaluate(() => WALLY.debug.padHandBackStall(0));
  return { tabs, poisoned, opened, ring: await ring(), kb: await kb(), rec: await rec() };
};

/* THE CONTROL THE RING IS ACTUALLY ON MUST DO ITS OWN JOB. No assumption
   about WHICH control the Tab left it on — that assumption is what made
   the other judge fail on a correct outcome. */
const ownJob = async (label) => {
  const s = await pressSpace();
  if (label === 'Menu') return { s, right: s.panels.length === 1 && s.panels[0] === 'pause', want: 'pause sheet' };
  if (label === 'Jump') return { s, right: s.panels.length === 0 && s.peak > FLOOR + 1.0, want: 'a jump, no sheet' };
  return { s, right: null, want: `unmodelled control ${label}` };
};
/* ...AND THE RING IS NAVIGABLE, which is the unambiguous half: the pause
   sheet cannot come from the window-level Space binding. */
const walkToMenuAndSpace = async () => {
  let at = (await ring()).label, hops = 0;
  while (at !== 'Menu' && hops < 12) { await page.keyboard.press('Tab'); await page.waitForTimeout(70); at = (await ring()).label; hops++; }
  await page.keyboard.press('Space'); await page.waitForTimeout(800);
  return { at, hops, panels: await panels() };
};

const run = async (label, offs, stallN) => {
  const rows = [];
  for (const at of offs) {
    const g = await gesture({ at, stallN });
    const job = await ownJob(g.ring.label);
    await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); });
    await page.waitForTimeout(350);
    const g2 = await gesture({ at, stallN });          // same offset, second run, for the walk
    const walk = await walkToMenuAndSpace();
    await page.evaluate(() => { WALLY.ctx.ui.closeAll(); document.activeElement?.blur?.(); });
    await page.waitForTimeout(350);
    rows.push({ at, g, job, g2, walk });
    console.log(`  ${label} +${at}ms  ring ${JSON.stringify(g.ring)}  driving ${g.kb.driving} takesSpace ${g.kb.padTakesSpace}  signed ${g.rec.signed} moved ${g.rec.moved} attempts ${g.rec.attempts}`);
    console.log(`      SPACE on ${g.ring.label} -> panels ${JSON.stringify(job.s.panels)} vy ${job.s.peak}   want ${job.want}  ${job.right ? 'OK' : 'WRONG'}`);
    console.log(`      walk on: ${g2.ring.label} -> ${walk.at} in ${walk.hops} tabs, SPACE -> ${JSON.stringify(walk.panels)}`);
  }
  return rows;
};

console.log('--- window HELD OPEN (stall 8): the rule ---');
const held = await run('HELD', [0, 10, 25, 50, 90], 8);
console.log('--- RAW gesture (stall 0): the rate ---');
const raw = await run('RAW', [0, 5, 12, 25], 0);
const all = [...held, ...raw];

ok(all.every((r) => r.g.tabs !== null && r.g.opened.length === 1
  && r.g.poisoned.driving === true && r.g.poisoned.focus === 'Menu'),
  'SETUP [BRANCH: every offset really reaches the poisoned state]: one Tab, then real fingers only — the bookmark is still on Menu with `driving` set. Without this the sweep is green by never entering the path',
  all.map((r) => `+${r.at}: tabs ${r.g.tabs} driving ${r.g.poisoned.driving} focus ${r.g.poisoned.focus}`).join(' | '));

ok(all.every((r) => r.g.ring.live === true && r.g.ring.inPad === true && r.g.ring.inDying === false),
  'FOCUS [BRANCH: the Tab KEEPS ITS FOCUS, and a live one]: at every offset the ring ends on a connected pad button — never <body>, never inside the node the close removes 300 ms later',
  all.map((r) => `+${r.at}: ${r.g.ring.label} live ${r.g.ring.live} inPad ${r.g.ring.inPad} dying ${r.g.ring.inDying}`).join(' | '));

ok(all.every((r) => r.g.kb.driving === false && r.g.kb.padTakesSpace === true),
  'MEANING [BRANCH: ...AND ITS MEANING — the keyboard speaks again]: at every offset `driving` is cleared and the pad will answer the next key. Whether the signature was WITHHELD (the Tab lost the race, landed in the dying panel) or never needed (the Tab won it and landed in the pad), the end state is the same one',
  all.map((r) => `+${r.at}: driving ${r.g.kb.driving} takesSpace ${r.g.kb.padTakesSpace} signed ${r.g.rec.signed} moved ${r.g.rec.moved}`).join(' | '));

ok(all.every((r) => r.job.right === true),
  'OWN JOB [BRANCH: the control the ring is ACTUALLY on fires — no assumption about which one it is]: Space on Menu opens the pause sheet; Space on Jump jumps and opens nothing. This is the assertion _vj-liftoffsets.mjs got wrong by demanding "pause" at every offset — when the hand-back WINS the race the Tab moves Menu -> Jump inside the pad, and Jump is then the correct answer',
  all.map((r) => `+${r.at}: on ${r.g.ring.label} want ${r.job.want} got panels ${JSON.stringify(r.job.s.panels)} vy ${r.job.s.peak} -> ${r.job.right ? 'OK' : 'WRONG'}`).join(' | '));

ok(all.every((r) => r.walk.at === 'Menu' && r.walk.panels.length === 1 && r.walk.panels[0] === 'pause'),
  'NAVIGABLE [and the ring is a WORKING one — the unambiguous half]: walking on to Menu with real Tabs through the state the restore left behind, with no blur to wash it out, and pressing Space opens the PAUSE sheet. Named and counted; the pause sheet cannot come from the window-level Space binding, which is why this and not vy is the discriminator',
  all.map((r) => `+${r.at}: ${r.g2.ring.label} -> ${r.walk.at} in ${r.walk.hops} tabs, panels ${JSON.stringify(r.walk.panels)}`).join(' | '));

console.log(`\n${fails ? 'FAIL' : 'OK'} — ${fails} failing`);
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
