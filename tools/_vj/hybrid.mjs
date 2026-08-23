/* VJ 9 — the REAL hybrid: a touchscreen that also has a fine pointer.
   Playwright cannot express that, so the pointer media features are
   overridden through CDP Emulation.setEmulatedMedia while the context
   still carries hasTouch. */
import { chromium } from 'playwright-core';
import { serve, reporter } from './lib.mjs';

const { server, port } = await serve();
const R = reporter();
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });

async function run(label, features, opts) {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: false, ...opts });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]));
  /* CDP's setEmulatedMedia does not carry pointer/any-pointer, so the
     two media queries the code actually consults are overridden in the
     page before anything loads. coarsePointer() reads matchMedia and
     nothing else, so this is the real decision under test. */
  await page.addInitScript((f) => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q) => {
      for (const [k, v] of Object.entries(f)) {
        if (q.replace(/\s+/g, '') === k.replace(/\s+/g, '')) {
          const l = real(q);
          return { media: q, matches: v, addEventListener: l.addEventListener.bind(l), removeEventListener: l.removeEventListener.bind(l), addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false };
        }
      }
      return real(q);
    };
  }, features);
  await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 120000 });
  await page.waitForTimeout(3000);
  const probe = async () => page.evaluate(async () => {
    const m = await import('/src/ui/touch.js');
    const w = WALLY.ctx;
    return {
      mq: { pointer_coarse: matchMedia('(pointer: coarse)').matches, pointer_fine: matchMedia('(pointer: fine)').matches,
        any_fine: matchMedia('(any-pointer: fine)').matches, any_coarse: matchMedia('(any-pointer: coarse)').matches },
      maxTouch: navigator.maxTouchPoints,
      coarsePointer: m.coarsePointer(), touchUI: m.touchUI(),
      padOn: w.ui.touch.enabled, interact: m.actionLabel('interact'),
      prompt: (document.querySelector('.w-prompt .key') || {}).textContent,
      hints: [...document.querySelectorAll('.w-hint .kb')].map((e) => e.textContent),
      hintAria: [...document.querySelectorAll('.w-hint')].map((e) => e.getAttribute('aria-label')),
      /* menus.js's SEPARATE, second capability test for the Hide-UI trap */
      menusCoarseOnly: matchMedia('(pointer: coarse)').matches && ((navigator.maxTouchPoints | 0) > 0 || 'ontouchstart' in window),
    };
  });
  await page.evaluate(async () => { const w = WALLY.ctx; const d = w.city.doorPosition('apartment'); w.wally.warpTo(d.x, d.y + 0.3, d.z, {}); await new Promise((r) => setTimeout(r, 900)); });
  const a = await probe();
  console.log(`\n--- ${label} ---\n  boot: ${JSON.stringify(a)}`);
  /* now the player turns the pad ON in Settings */
  await page.evaluate(() => WALLY.ctx.ui.setTouch(true)); await page.waitForTimeout(600);
  const b = await probe();
  console.log(`  pad ON via Settings: ${JSON.stringify({ touchUI: b.touchUI, interact: b.interact, prompt: b.prompt, hints: b.hints })}`);
  await page.evaluate(() => WALLY.ctx.ui.setTouch(false)); await page.waitForTimeout(600);
  const c = await probe();
  console.log(`  pad OFF again      : ${JSON.stringify({ touchUI: c.touchUI, interact: c.interact, prompt: c.prompt, hints: c.hints })}`);
  await ctx.close();
  return { a, b, c, errs };
}

/* a tablet with a keyboard/trackpad: primary pointer coarse, a fine one also present */
const hy = await run('HYBRID  pointer:coarse + any-pointer:fine',
  { '(pointer: coarse)': true, '(pointer: fine)': false, '(any-pointer: fine)': true, '(any-pointer: coarse)': true });
R.ok(hy.a.coarsePointer === false, 'hybrid: coarsePointer() is FALSE when a fine pointer is also present', JSON.stringify(hy.a.mq));
R.ok(hy.a.touchUI === false && hy.a.interact === 'E' && hy.a.prompt === 'E',
  'hybrid: boots with keyboard words', JSON.stringify([hy.a.touchUI, hy.a.interact, hy.a.prompt]));
R.ok(hy.b.touchUI === true && hy.b.interact === 'Enter' && hy.b.prompt === 'Enter',
  'hybrid: turning the pad ON makes every label follow — not baked from boot', JSON.stringify([hy.b.interact, hy.b.prompt, hy.b.hints]));
R.ok(hy.c.touchUI === false && hy.c.prompt === 'E' && JSON.stringify(hy.c.hints) === JSON.stringify(['P', 'M', 'O', 'Esc']),
  'hybrid: and OFF again puts the keycaps back', JSON.stringify([hy.c.interact, hy.c.prompt, hy.c.hints]));
console.log(`  menus.js coarseOnly() on this hybrid: ${hy.a.menusCoarseOnly}  vs touch.js coarsePointer(): ${hy.a.coarsePointer}`);
R.ok(hy.a.menusCoarseOnly === hy.a.coarsePointer,
  'hybrid: menus.js and touch.js agree about what kind of device this is',
  `menus.coarseOnly=${hy.a.menusCoarseOnly} touch.coarsePointer=${hy.a.coarsePointer}`);

/* a pure phone, for the control */
const ph = await run('PHONE   pointer:coarse, no fine pointer',
  { '(pointer: coarse)': true, '(pointer: fine)': false, '(any-pointer: fine)': false, '(any-pointer: coarse)': true });
R.ok(ph.a.coarsePointer === true && ph.a.touchUI === true, 'control: a phone still reads as a phone', JSON.stringify(ph.a.mq));

/* a desktop with a touchscreen: primary fine, a coarse one also present */
const dk = await run('TOUCH LAPTOP  pointer:fine + any-pointer:coarse',
  { '(pointer: coarse)': false, '(pointer: fine)': true, '(any-pointer: fine)': true, '(any-pointer: coarse)': true });
R.ok(dk.a.coarsePointer === false && dk.a.interact === 'E', 'touch laptop: keyboard words at boot', JSON.stringify(dk.a.mq));
R.ok(dk.b.interact === 'Enter', 'touch laptop: pad on -> touch words', String(dk.b.interact));

await browser.close(); server.close();
console.log(`\n${R.fails} failure(s).`);
