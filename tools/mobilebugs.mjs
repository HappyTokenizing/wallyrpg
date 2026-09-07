/* mobilebugs.mjs — reproduce the reported mobile faults.
     1 legs do not animate while walking on touch
     2 the yellow pointer sits under the objective, not upper-right
     3 music does not start on mobile Chrome
     4 PRESENTATION: the tier a phone receives and the pixels it draws
   Real touch events through CDP, mobile viewport, hasTouch + isMobile.

   ============================================================
   SECTION 4 AND WHY IT IS HERE (PR-1..PR-12)

   Two faults landed together and they are the same story. Every
   quality tier hardcoded `pixelRatio: 1` and renderer.js's
   maxPixelRatio() could only clamp DOWNWARD from it, so a 1170x2532
   iPhone drew 0.33 Mpx and let the compositor upscale it threefold;
   and pickQuality() read UNMASKED_RENDERER_WEBGL and nothing else, so
   no phone could reach the tier whose own comment says "phones", while
   an M-series iPad got a desktop tier by string coincidence.

   Neither was ever exercised by a test, and there is a specific reason
   this file is where they now are: EVERY 390x844 MEASUREMENT ON THIS
   PROJECT SO FAR WAS TAKEN ON A DESKTOP. A narrow Playwright window
   with no `hasTouch` is a desktop by every input the code can read
   (and, deliberately, still is — see deviceClass), so it matched
   /apple m[1-9]/ on this rig and ran tier `high`. This context sets
   hasTouch + isMobile + a Pixel 7 UA, which is the only configuration
   in the repo that takes the handset branch at all.

   HOW EACH ASSERTION IS PROVED. Every one drives the SHIPPING function
   — `pickQuality` and `deviceClass` are imported from
   src/core/contracts.js inside the page, and the pixel ratio is read
   off the live `renderer` after the shipped resize path has run. No
   regex, no ladder and no budget is copied into this file, so nothing
   here can go stale against the module and still pass.

   THE REVERT CHECK IS PR-11 AND PR-12: `WALLY.debug.pixelRatio(1)` pins
   the rule this replaced and `governor(false)` freezes the ladder,
   BOTH ON THE SAME PAGE LOAD, and the assertion is that the old rule
   reproduces the old 390x844 backing store and the new one does not.
   That is the module-switch form contracts.js asks for, not a quoted
   before-number.

   THE DIMENSION THIS FILE DOES NOT SAMPLE: real handset silicon. Every
   frame here is an M1 Max pretending to be a Pixel 7. So PR-4..PR-8
   assert the RULE (what ceiling the tier grants this viewport, what
   the ladder does when it steps) and never a frame time, and the
   governor's own climb is printed with the machine load beside it
   rather than gated on.
   ============================================================ */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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

const load = () => { try { return +execSync('uptime').toString().split('load averages:')[1].trim().split(/\s+/)[0]; } catch { return NaN; } };
const PIXEL7_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';

const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--autoplay-policy=user-gesture-required'] });
/* A HANDSET, not a narrow window: hasTouch + isMobile + a phone UA is
   what makes deviceClass() say 'phone'. Nothing else in tools/ does. */
const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const mobileContext = (deviceScaleFactor, viewport = { width: 390, height: 844 }, kind = 'phone') => browser.newContext({
  viewport, hasTouch: true, isMobile: kind === 'phone', deviceScaleFactor,
  /* an iPad reports a DESKTOP Safari UA and is told apart by touch +
     the size of its box — which is exactly what deviceClass() does */
  userAgent: kind === 'phone' ? PIXEL7_UA : IPAD_UA,
});
const ctxB = await mobileContext(1);
const page = await ctxB.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message.split('\n')[0]));

// NOTE: no ?skipIntro — we want the real mobile first-run path, gesture and all.
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load', timeout: 90000 });

const cdp = await ctxB.newCDPSession(page);
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 12, radiusY: 12, force: 1 }],
});

/* The build may now gate the opening on a real gesture (that was the fix for
   the silent intro), so waiting for READY before tapping can deadlock. Poll,
   and tap once part-way through to release any gate. */
let ready = false;
for (let i = 0; i < 60; i++) {
  ready = await page.evaluate(() => window.__WALLY_READY__ === true).catch(() => false);
  if (ready) break;
  if (i === 12) { await touch('touchStart', 195, 500); await page.waitForTimeout(80); await touch('touchEnd', 195, 500); }
  await page.waitForTimeout(1000);
}
console.log('ready:', ready);
await page.waitForTimeout(2000);

console.log('=== 3. AUDIO ON MOBILE CHROME ===');
const before = await page.evaluate(() => ({
  state: WALLY.ctx.audio?.state?.() ?? WALLY.ctx.audio?.ctxState ?? null,
  running: !!WALLY.ctx.audio?.running,
  suspended: !!WALLY.ctx.audio?.suspended,
}));
console.log('  before any touch:', JSON.stringify(before));

// a real tap, exactly what a phone user does first
await touch('touchStart', 195, 500); await page.waitForTimeout(120);
await touch('touchEnd', 195, 500);   await page.waitForTimeout(1800);
const after = await page.evaluate(() => ({
  running: !!WALLY.ctx.audio?.running,
  suspended: !!WALLY.ctx.audio?.suspended,
  raw: (() => { try { return WALLY.ctx.audio.debugState ? WALLY.ctx.audio.debugState() : null; } catch { return null; } })(),
}));
console.log('  after a tap:      ', JSON.stringify(after));
console.log('  VERDICT:', after.running ? 'audio running' : 'AUDIO STILL NOT RUNNING');

console.log('\n=== 1. LEGS WHILE WALKING ON TOUCH ===');
// hold the thumbstick: press bottom-left, drag up, hold
await touch('touchStart', 90, 700); await page.waitForTimeout(100);
await touch('touchMove', 90, 620);  await page.waitForTimeout(1400);
const walking = await page.evaluate(() => {
  const c = WALLY.ctx, w = c.wally, ct = w.controller;
  const a = w.anim;
  const out = { planarSpeed: ct ? +(ct.planarSpeed || 0).toFixed(2) : null };
  if (a) {
    for (const k of ['locoSpeed','loco','speed','bikeW','walkW','runW','blend','_locoSpeed','_speed'])
      if (a[k] !== undefined && typeof a[k] !== 'function') out['anim.' + k] = a[k];
    try { out.actions = (a.actions || a._actions || []).slice(0, 8).map(x => x && x.name); } catch {}
    try { out.mixerActions = a.mixer ? a.mixer._actions.filter(x => x.isRunning && x.isRunning()).map(x => x._clip.name + '@' + x.getEffectiveWeight().toFixed(2)) : null; } catch (e) { out.mixErr = e.message; }
  }
  try { out.bikeEquipped = c.game?.state?.bike?.equipped; } catch {}
  try { out.animKeys = Object.keys(a || {}).filter(k => typeof a[k] !== 'function').slice(0, 20); } catch {}
  return out;
});
console.log('  while held:', JSON.stringify(walking));
// sample a leg bone over time — the ground truth for "are the legs moving"
const legs = await page.evaluate(() => new Promise(res => {
  const w = WALLY.ctx.wally;
  let bone = null;
  w.root.traverse(o => { if (!bone && o.isBone && /leg|thigh|shin|knee/i.test(o.name)) bone = o; });
  if (!bone) return res({ bone: null });
  const s = []; let n = 0;
  const t = () => { s.push(+bone.rotation.x.toFixed(4)); if (++n < 40) requestAnimationFrame(t); else res({ bone: bone.name, samples: s }); };
  requestAnimationFrame(t);
}));
if (legs.bone) {
  const range = Math.max(...legs.samples) - Math.min(...legs.samples);
  console.log(`  bone ${legs.bone}: rotation range over 40 frames = ${range.toFixed(4)} rad`);
  console.log('  VERDICT:', range > 0.05 ? 'legs ARE animating' : 'LEGS ARE NOT ANIMATING');
} else console.log('  no leg bone found by name');
await touch('touchEnd', 90, 620);
await page.waitForTimeout(500);

console.log('\n=== 2. YELLOW POINTER PLACEMENT ===');
const ptr = await page.evaluate(() => {
  const cands = [...document.querySelectorAll('*')].filter(e => {
    const c = typeof e.className === 'string' ? e.className : '';
    return /pointer|compass|bearing|destin/i.test(c) || (e.id && /pointer|compass/i.test(e.id));
  });
  const pick = cands.find(e => e.getBoundingClientRect().width > 0);
  const box = (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const findText = (re) => [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && re.test(e.textContent || '')).map(box)[0] || null;
  return {
    pointer: pick ? { cls: (typeof pick.className === 'string' ? pick.className : '').slice(0, 40), ...box(pick) } : null,
    rep: findText(/^\s*REP\s*$/i), city: findText(/^\s*CITY\s*$/i),
    objective: (() => { const o = document.querySelector('[class*=objective]'); return o ? box(o) : null; })(),
    vw: innerWidth, vh: innerHeight,
  };
});
console.log('  ' + JSON.stringify(ptr, null, 1).replace(/\n/g, '\n  '));

console.log('\nPAGE ERRORS:', errs.length);
for (const e of [...new Set(errs)].slice(0, 5)) console.log('  -', e.slice(0, 140));
await page.screenshot({ path: 'shots/mobilebugs.png' });

/* ============================================================
   4. PRESENTATION — THE TIER A PHONE GETS AND THE PIXELS IT DRAWS
   ============================================================ */
let pass = 0; const fails = [];
const T = (id, cond, msg, got) => {
  if (cond) { pass++; console.log(`  ok   ${id}  ${msg}`); }
  else { fails.push(`${id} ${msg}` + (got !== undefined ? `  (got ${JSON.stringify(got)})` : ''));
    console.log(`  FAIL ${id}  ${msg}` + (got !== undefined ? `  (got ${JSON.stringify(got)})` : '')); }
};
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

console.log('\n=== 4. TIER AND PIXEL RATIO ON A PHONE ===');
console.log(`# rig: headless Chrome (channel chrome), ANGLE Metal on an Apple M1 Max, 10-core, macOS 14.4`);
console.log(`# context: 390x844 CSS, hasTouch + isMobile, Pixel 7 UA. machine 1-min load ${load()}`);

/* ---- PR-1..PR-3: the tier, on a real handset context ---- */
const probe = await page.evaluate(async () => {
  const mod = await import('./src/core/contracts.js');
  return {
    cls: mod.deviceClass(),
    live: WALLY.ctx.quality.name,
    picked: mod.pickQuality(WALLY.ctx.renderer).name,
    gpu: (() => { const gl = WALLY.ctx.renderer.getContext();
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : ''; })(),
    touch: (navigator.maxTouchPoints | 0), vw: innerWidth, vh: innerHeight,
  };
});
console.log(`  GPU string this rig reports: ${probe.gpu}`);
/* BRANCH: contracts.js deviceClass() — `if (!touch) return 'desktop'`
   then `if (mobileUA || shortEdge <= 500) return 'phone'`. */
T('PR-1', probe.cls === 'phone', 'deviceClass() on a touch + mobile-UA 390x844 context is "phone"', probe.cls);
/* BRANCH: contracts.js pickQuality() `if (cls === 'phone' || cls === 'tablet')`
   -> falls past OLD_MOBILE_GPU and /intel/ -> returns QUALITY_TIERS.med.
   Note the GPU string here is an M1 Max: before this change that
   string alone chose the tier and the answer was `high`. */
T('PR-2', probe.picked === 'med', 'pickQuality() gives a phone `med`, not the desktop tier its GPU string names', probe.picked);
T('PR-3', probe.live === 'med', 'the tier the page actually booted with is `med`', probe.live);

/* ---- PR-4..PR-5: every device class, down the real branches ----
   Patch UNMASKED_RENDERER_WEBGL and the environment deviceClass reads,
   then call the shipped pickQuality. No regex is copied here. */
const CASES = [
  ['iPhone 15, Safari',        'Apple GPU',                                              'phone',  { w: 393, h: 852 }, 'med'],
  ['iPhone, extension withheld','',                                                      'phone',  { w: 390, h: 844 }, 'med'],
  ['Android flagship',         'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)',       'phone',  { w: 412, h: 915 }, 'med'],
  ['Android mid',              'ANGLE (ARM, Mali-G715, OpenGL ES 3.2)',                  'phone',  { w: 393, h: 851 }, 'med'],
  ['Android 2017',             'ANGLE (Qualcomm, Adreno (TM) 540, OpenGL ES 3.2)',       'phone',  { w: 360, h: 740 }, 'low'],
  ['iPhone 7 era',             'Apple A10 GPU',                                          'phone',  { w: 375, h: 667 }, 'low'],
  ['iPad Pro M2',              'Apple M2',                                               'tablet', { w: 1194, h: 834 }, 'med'],
  ['iPad, Safari',             'Apple GPU',                                              'tablet', { w: 1024, h: 768 }, 'med'],
  ['Surface, Intel Iris Xe',   'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, D3D11)',     'tablet', { w: 1368, h: 912 }, 'low'],
  ['touch laptop, RTX 3080',   'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11)',     'tablet', { w: 1920, h: 1080 }, 'high'],
  ['MacBook Pro M1 Max',       'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max)',      'desktop', { w: 1600, h: 900 }, 'high'],
  ['old Intel laptop',         'ANGLE (Intel, Intel(R) UHD Graphics 620, OpenGL 4.1)',   'desktop', { w: 1440, h: 900 }, 'low'],
  ['headless SwiftShader',     'ANGLE (Google, SwiftShader Device, SwiftShader driver)', 'desktop', { w: 1600, h: 900 }, 'med(sw)'],
];
const table = await page.evaluate(async (cases) => {
  const mod = await import('./src/core/contracts.js');
  const gl = WALLY.ctx.renderer.getContext();
  const realGet = gl.getParameter.bind(gl), realExt = gl.getExtension.bind(gl);
  const out = [];
  for (const [label, name, cls, box] of cases) {
    gl.getExtension = (n) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : realExt(n));
    gl.getParameter = (p) => (p === 0x9246 ? name : realGet(p));
    /* the environment deviceClass() reads, as a plain stub — the
       function takes it as an argument precisely so this is possible
       without a second browser context per row. */
    const env = { navigator: { maxTouchPoints: cls === 'desktop' ? 0 : 5,
        userAgent: cls === 'phone' ? 'Mozilla/5.0 (Linux; Android 13; Pixel 7) Mobile Safari/537.36'
          : cls === 'tablet' ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605'
          : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605' },
      innerWidth: box.w, innerHeight: box.h, location: { search: '' } };
    const t = mod.pickQuality(WALLY.ctx.renderer, env);
    out.push({ label, cls: mod.deviceClass(env), tier: t.name,
      prMax: t.pixelRatioMax, budget: t.pixelBudget, msaa: t.msaa, dof: t.dof,
      grassDist: t.grassDist, shadow: t.shadowSize });
  }
  gl.getParameter = realGet; gl.getExtension = realExt;
  return out;
}, CASES);
console.log(`  ${'device'.padEnd(26)}${'class'.padEnd(9)}${'tier'.padEnd(9)}${'prMax'.padEnd(7)}${'budget'.padEnd(8)}${'msaa'.padEnd(6)}dof`);
for (const r of table) console.log(`  ${r.label.padEnd(26)}${r.cls.padEnd(9)}${r.tier.padEnd(9)}${String(r.prMax).padEnd(7)}${String(r.budget).padEnd(8)}${String(r.msaa).padEnd(6)}${r.dof}`);
let classOK = true, tierOK = true;
for (let i = 0; i < CASES.length; i++) {
  if (table[i].cls !== CASES[i][2]) { classOK = false; console.log(`    !! ${CASES[i][0]}: class ${table[i].cls} want ${CASES[i][2]}`); }
  if (table[i].tier !== CASES[i][4]) { tierOK = false; console.log(`    !! ${CASES[i][0]}: tier ${table[i].tier} want ${CASES[i][4]}`); }
}
/* BRANCH: contracts.js deviceClass(), all three returns. */
T('PR-4', classOK, 'deviceClass() sorts all 13 device strings into phone / tablet / desktop');
/* BRANCH: contracts.js pickQuality(), the handheld block + the desktop
   block below it. The two rows that were the bug: 'iPad Pro M2' used
   to return high (msaa 4 + DOF) by matching /apple m[1-9]/, and no row
   above could reach `low`, whose comment says "phones". */
T('PR-5', tierOK, 'pickQuality() gives every device class the tier it says it does');
T('PR-6', table.find(r => r.label === 'iPad Pro M2').tier === 'med'
       && table.find(r => r.label === 'iPad Pro M2').msaa === 0,
  'an M-series iPad no longer collects the desktop tier (msaa 4 + DOF) by string coincidence');
T('PR-7', table.some(r => r.cls === 'phone' && r.tier === 'low'),
  '`low` — the tier whose comment says "phones" — is now reachable by a phone');
T('PR-8', table.find(r => r.label === 'touch laptop, RTX 3080').tier === 'high',
  'a touchscreen laptop with a discrete GPU still gets `high` (not over-corrected to a tablet)');

/* ---- PR-9..PR-12: the pixels, and the revert ----
   A fresh handset context per devicePixelRatio. The ceiling assertions
   are pure functions of the shipped code and carry no frame time; the
   governor's own climb is reported with the load beside it. */
console.log('\n  --- the backing store, per devicePixelRatio (a fresh phone context each) ---');
console.log('  # ONE page open at a time: the previous is closed before the next boots, because');
console.log('  #   contending headless Chromes on one GPU is exactly what makes the governor');
console.log('  #   (correctly) refuse to lift, and that refusal would read as a bug in the rule.');
console.log(`  ${'dpr'.padEnd(5)}${'tier'.padEnd(6)}${'ceiling'.padEnd(9)}${'pr@boot'.padEnd(9)}${'pr@12s'.padEnd(8)}${'buffer'.padEnd(12)}${'Mpx'.padEnd(7)}${'lifts'.padEnd(7)}${'late/win'.padEnd(10)}${'p50'.padEnd(7)}load`);
const prRows = [];
let held = null;                                  // the dpr-3 page, kept for the revert
for (const dpr of [1, 2, 3]) {
  const c = await mobileContext(dpr);
  const p = await c.newPage();
  const l0 = load();
  await p.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 90000 });
  await p.waitForFunction('window.__WALLY_READY__===true', { timeout: 180000 }).catch(() => {});
  await p.waitForTimeout(1500);
  const boot = await p.evaluate(() => ({ tier: WALLY.ctx.quality.name, ...WALLY.debug.viewport() }));
  /* let the governor decide for itself, then read what it decided */
  await p.waitForTimeout(12000);
  const climbed = await p.evaluate(() => ({ vp: WALLY.debug.viewport(), gov: WALLY.debug.governorState(),
    perf: window.__WALLY_PERF__ ? { p50: __WALLY_PERF__.p50, cpuMs: __WALLY_PERF__.cpuMs, dropped: __WALLY_PERF__.dropped } : null }));
  const l1 = load();
  const row = { dpr, tier: boot.tier, ceiling: boot.prCeiling, prBoot: boot.pixelRatio,
    prClimb: climbed.vp.pixelRatio, buffer: climbed.vp.buffer, mpx: climbed.vp.mpx,
    lifts: climbed.gov.log.filter(x => /lift/.test(x.why)).length, gov: climbed.gov,
    l0, l1, perf: climbed.perf };
  prRows.push(row);
  console.log(`  ${String(dpr).padEnd(5)}${row.tier.padEnd(6)}${String(row.ceiling).padEnd(9)}${String(row.prBoot).padEnd(9)}${String(row.prClimb).padEnd(8)}${(row.buffer.join('x')).padEnd(12)}${String(row.mpx).padEnd(7)}${String(row.lifts).padEnd(7)}${String(climbed.gov.lateInWindow + '/' + climbed.gov.inWindow).padEnd(10)}${String(climbed.perf?.p50 ?? '-').padEnd(7)}${l0}->${l1}`);
  if (climbed.gov.log.length) for (const g of climbed.gov.log) console.log(`      ${g.why}: ${g.from} -> ${g.to} (pr ${g.pr})`);
  if (dpr === 3) held = { page: p, ctx: c }; else { await p.close(); await c.close(); }
}
const r1 = prRows[0], r2 = prRows[1], r3 = { ...prRows[2], page: held.page };
/* BRANCH: renderer.js pixelRatioCeiling() —
   min(q.pixelRatioMax, devicePixelRatio, sqrt(pixelBudget*1e6/(w*h))).
   At 390x844 the budget term is sqrt(1.4e6/329160) = 2.06, so
   devicePixelRatio is what binds at 1 and 2, and med's
   pixelRatioMax = 2 is what binds at 3. Before this change all three
   read 1, because maxPixelRatio() was min(q.pixelRatio=1, GL/…). */
T('PR-9', near(r1.ceiling, 1) && near(r2.ceiling, 2) && near(r3.ceiling, 2),
  'the tier ceiling on a 390x844 phone tracks devicePixelRatio 1/2/3 as 1 / 2 / 2 (was 1 / 1 / 1)',
  [r1.ceiling, r2.ceiling, r3.ceiling]);
/* BRANCH: renderer.js init `renderer.setPixelRatio(q.pixelRatio)` —
   every tier still boots at 1, i.e. the frame that always shipped. */
T('PR-10', r1.prBoot === 1 && r2.prBoot === 1 && r3.prBoot === 1,
  'every tier still BOOTS at pixelRatio 1 — the governor earns anything above it',
  [r1.prBoot, r2.prBoot, r3.prBoot]);

/* THE REVERT CHECK. Same page load, both rules. `pixelRatio(1)` is the
   rule this replaced — the hardcoded constant — driven through the
   same syncViewport path; `pixelRatio(null)` hands it back to the
   ladder. If the new rule were not doing anything, these two would
   produce the same backing store, and they must not.

   The ladder is walked to its ceiling FIRST, and deliberately by hand:
   whether this box's load lets the governor climb on its own is a fact
   about the box, and the revert check is a claim about the rule. The
   two must not be allowed to fail together. */
const revert = await r3.page.evaluate(() => {
  const V = () => WALLY.debug.viewport();
  for (let i = 0; i < 4; i++) WALLY.debug.governorStep(+1);
  WALLY.debug.governor(false);                       // freeze the ladder where it is
  const now = V();
  WALLY.debug.pixelRatio(1);   const old = V();      // the rule this replaced
  WALLY.debug.pixelRatio(null); const back = V();    // and back
  WALLY.debug.governor(true);
  return { now, old, back };
});
console.log(`  revert on one page load @dpr3:  new ${revert.now.buffer.join('x')} (${revert.now.mpx} Mpx)`
  + `  ->  old rule ${revert.old.buffer.join('x')} (${revert.old.mpx} Mpx)  ->  back ${revert.back.buffer.join('x')}`);
/* BRANCH: renderer.js maxPixelRatio() — the `prOverride != null` arm
   vs the `stepRatio(govStep, …)` arm. */
T('PR-11', revert.old.buffer[0] === 390 && revert.old.buffer[1] === 844
        && revert.old.pixelRatio === 1,
  'REVERT: the old rule (pixelRatio pinned to 1) reproduces the 390x844 backing store exactly',
  revert.old.buffer);
T('PR-12', revert.back.buffer[0] === revert.now.buffer[0] && revert.back.buffer[1] === revert.now.buffer[1]
        && revert.now.buffer[0] > 390,
  'REVERT: releasing the pin returns the larger buffer, so the two rules are genuinely different',
  [revert.now.buffer, revert.back.buffer]);

/* ---- PR-13..PR-15: the governor's own ladder, driven deterministically.
   A forced step runs setStep() -> syncViewport() -> maxPixelRatio(),
   i.e. every line the frame-loop path uses, without waiting on a
   machine whose load this file does not control. ---- */
const gov = await r3.page.evaluate(() => {
  WALLY.debug.governor(true);
  WALLY.debug.pixelRatio(null);
  const seen = [];
  const reset = () => { const s = WALLY.ctx.render; return s; };
  reset();
  /* climb to the top of the ladder */
  for (let i = 0; i < 4; i++) seen.push(WALLY.debug.governorStep(+1));
  const top = WALLY.debug.viewport();
  /* then fail one notch: the cap must drop and stay dropped */
  const dropped = WALLY.debug.governorStep(-1);
  const after = WALLY.debug.viewport();
  const retry = WALLY.debug.governorStep(+1);      // must not go back up
  return { seen, top, dropped, after, retry, state: WALLY.debug.governorState() };
});
console.log(`  ladder: ${gov.seen.map(s => s.after).join(' -> ')}   top buffer ${gov.top.buffer.join('x')}`);
console.log(`  after a drop: pr ${gov.after.pixelRatio}, cap ${gov.state.cap}, retry -> ${gov.retry.after}`);
/* BRANCH: renderer.js PR_LADDER + stepRatio() clamped by
   pixelRatioCeiling(). Four lifts on a 3-rung ladder must stop at the
   ceiling, not run off it. */
T('PR-13', gov.top.pixelRatio === 2 && gov.top.buffer[0] === 780 && gov.top.buffer[1] === 1688,
  'the ladder tops out at the tier ceiling: pixelRatio 2, backing store 780x1688 (1.32 Mpx)',
  [gov.top.pixelRatio, gov.top.buffer]);
/* BRANCH: renderer.js governorTick() `govCap = govStep - 1` and the
   `govStep < govCap` guard on the lift arm. */
T('PR-14', gov.after.pixelRatio < gov.top.pixelRatio,
  'a notch that misses 60 fps drops the pixel ratio back',
  [gov.after.pixelRatio, gov.top.pixelRatio]);
T('PR-15', gov.retry.after === gov.after.pixelRatio && gov.state.cap < 2,
  'a failed notch is locked out for the session — the governor cannot oscillate',
  { retry: gov.retry.after, cap: gov.state.cap });

/* ---- PR-16: the budget, not the dpr, is what binds on a big panel.
   A tablet-shaped box at dpr 2 must NOT get 2, or an iPad would raster
   3.98 Mpx. sqrt(1.4e6/(1194*834)) = 1.19. ---- */
const tabCtx = await mobileContext(2, { width: 1194, height: 834 }, 'tablet');
const tabPage = await tabCtx.newPage();
await tabPage.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 90000 });
await tabPage.waitForFunction('window.__WALLY_READY__===true', { timeout: 180000 }).catch(() => {});
await tabPage.waitForTimeout(1500);
const tab = await tabPage.evaluate(async () => {
  const mod = await import('./src/core/contracts.js');
  for (let i = 0; i < 4; i++) WALLY.debug.governorStep(+1);
  return { cls: mod.deviceClass(), tier: WALLY.ctx.quality.name, ...WALLY.debug.viewport() };
});
console.log(`  tablet box 1194x834 @dpr2: class ${tab.cls}, tier ${tab.tier}, ceiling ${tab.prCeiling}, buffer ${tab.buffer.join('x')} = ${tab.mpx} Mpx`);
/* BRANCH: renderer.js pixelRatioCeiling(), the `byBudget` term —
   the ONE of the four terms that binds here. */
T('PR-16', tab.cls === 'tablet' && near(tab.prCeiling, 1.19, 0.02) && tab.mpx <= 1.45,
  'on a 1194x834 tablet the megapixel budget binds at 1.19, not devicePixelRatio 2 (which would be 3.98 Mpx)',
  [tab.cls, tab.prCeiling, tab.mpx]);

/* ============================================================
   VP-1..VP-4 — THE HEALTH FLAG THAT CRIED ON HEALTHY FRAMES.

   `viewport().inSync` is the flag anyone debugging a resolution
   problem reaches for FIRST, and it compared the canvas against
   Math.ROUND(css * pixelRatio) while three.js allocates it with
   Math.FLOOR. That could not misfire while every tier rendered at
   ratio 1; the megapixel budget made the ratio irrational and it
   started reading DESYNC on correct frames at three of five desktop
   shapes (renderer.js, the block above viewportState()).

   THIS BOX IS ONE OF THEM, which is why the check lives here rather
   than in a rig of its own: 1194x834 at ceiling 1.1857 floors to
   1415x988 and rounds to 1416x989 — both axes wrong. PR-16 above has
   been standing on this exact viewport the whole time.

   THE REVERT IS VP-2, and it is a switch in the module rather than a
   quoted before-number: `WALLY.debug.sizeRule('round')` puts the rule
   this replaced back into BOTH call sites (the flag and syncViewport's
   early-out) on the SAME page load, and the assertion is that the old
   rule calls this frame broken and the new one does not.

   VP-3 IS THE HALF THAT WAS NEVER JUST COSMETIC. syncViewport's
   early-out used the same rounded number, so on these shapes it could
   never match and every poll rebuilt renderer size, camera aspect,
   the whole composer target pool and every module's resize hook for a
   viewport that had not moved. `resyncs` counts the rebuilds.

   VP-4 IS THE POSITIVE CONTROL, and without it the other three are
   worthless: a flag that has been made to read true is not fixed
   unless it can still read FALSE when the buffer really is stale. The
   reconciler is switched off, the box is genuinely resized underneath
   it, and inSync must go false — then come back when it is switched
   on again.
   ============================================================ */
console.log('\n  --- the sizing rule: what `inSync` compares, and what it costs when it is wrong ---');
const vpA = await tabPage.evaluate(async () => {
  const V = () => WALLY.debug.viewport();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  WALLY.debug.governor(false);
  const shipping = V();
  /* the poll cost, both rules, same page load, same still viewport:
     ask syncViewport the question the frame loop asks it, and count
     how many times it answered by rebuilding the chain. */
  const probe = async (rule) => {
    WALLY.debug.sizeRule(rule);
    await sleep(120);
    const before = V().resyncs;
    for (let i = 0; i < 20; i++) WALLY.debug.syncViewport(false);
    return { rule, vp: V(), rebuilds: V().resyncs - before };
  };
  const shipRule = await probe('floor');
  const oldRule = await probe('round');
  WALLY.debug.sizeRule('floor');
  await sleep(120);
  return { shipping, shipRule, oldRule, back: V() };
});
console.log(`  css ${vpA.shipping.css.join('x')} @pr ${vpA.shipping.pixelRatio.toFixed(4)}  buffer ${vpA.shipping.buffer.join('x')}`
  + `  sceneRT ${vpA.shipping.sceneRT.join('x')}  slack ${JSON.stringify(vpA.shipping.slackCss)} CSS px`);
console.log(`  rule 'floor' (ships): want ${vpA.shipRule.vp.want.join('x')}  inSync ${vpA.shipRule.vp.inSync}`
  + `   |   rule 'round' (replaced): want ${vpA.oldRule.vp.want.join('x')}  inSync ${vpA.oldRule.vp.inSync}`);
console.log(`  20 idle syncViewport polls on an unmoved viewport rebuilt the chain: `
  + `floor ${vpA.shipRule.rebuilds}x,  round ${vpA.oldRule.rebuilds}x`);
/* BRANCH: renderer.js viewportState() `inSync:` — the two bufferPx()
   terms. TRUE has to mean the buffer IS the surface. */
T('VP-1', vpA.shipRule.vp.inSync === true
       && vpA.shipRule.vp.want[0] === vpA.shipRule.vp.buffer[0]
       && vpA.shipRule.vp.want[1] === vpA.shipRule.vp.buffer[1]
       && vpA.shipRule.vp.sceneRT[0] === vpA.shipRule.vp.buffer[0],
  'inSync reads TRUE on a healthy frame at a viewport whose css x ratio is not an integer',
  { want: vpA.shipRule.vp.want, buffer: vpA.shipRule.vp.buffer, inSync: vpA.shipRule.vp.inSync });
/* BRANCH: renderer.js bufferPx() — the `sizeRule === 'round'` arm vs
   the floor arm, driven live on one page load. */
T('VP-2', vpA.oldRule.vp.inSync === false && vpA.back.inSync === true,
  'REVERT: the rule this replaced (round) calls the SAME healthy frame desynced, and releasing it agrees again',
  { round: vpA.oldRule.vp.inSync, floor: vpA.back.inSync });
/* BRANCH: renderer.js syncViewport() early-out, same bufferPx(). */
T('VP-3', vpA.shipRule.rebuilds === 0 && vpA.oldRule.rebuilds === 20,
  'REVERT: the old rule rebuilt the whole resize chain on every idle poll; the shipping rule rebuilds none',
  { floor: vpA.shipRule.rebuilds, round: vpA.oldRule.rebuilds });

/* THE POSITIVE CONTROL. A flag that cannot go false is not a flag —
   and this one has just been rewritten to read true where it used to
   read false, which is exactly the change that needs a control.

   THE FIRST ATTEMPT AT IT FAILED AND THE FAILURE IS WORTH KEEPING IN
   WRITING: `viewportAuto(false)` plus a real page resize left inSync
   TRUE, because main.js has a `resize` listener of its own
   (`addEventListener('resize', onResize)`, which calls
   renderer.setSize(innerWidth, innerHeight, false) and fans out every
   handle's resize) and it does not consult vpAuto. The reconciler in
   renderer.js is the BACKSTOP for engines that fire no event; it is
   not the only path to setSize, so switching it off does not strand
   the buffer. So the stale buffer is now made directly, through the
   renderer's own API, which is also the honest test of the flag
   rather than of the plumbing around it. */
const staleC = await tabPage.evaluate(() => {
  WALLY.debug.viewportAuto(false);
  const before = WALLY.debug.viewport();
  /* a buffer that is genuinely not the surface: half-size backing
     store, CSS box untouched (updateStyle false) — the landscape bug
     in one line */
  WALLY.ctx.renderer.setSize(Math.round(before.css[0] / 2), Math.round(before.css[1] / 2), false);
  return { before, stale: WALLY.debug.viewport() };
});
await tabPage.evaluate(() => { WALLY.debug.viewportAuto(true); WALLY.debug.syncViewport(true); });
await tabPage.waitForTimeout(400);
const healed = await tabPage.evaluate(() => WALLY.debug.viewport());
console.log(`  control: renderer.setSize to half the box behind the reconciler's back:`
  + ` css ${staleC.stale.css.join('x')} buffer ${staleC.stale.buffer.join('x')} inSync ${staleC.stale.inSync}`
  + `   ->  reconciled: css ${healed.css.join('x')} buffer ${healed.buffer.join('x')} inSync ${healed.inSync}`);
T('VP-4', staleC.before.inSync === true && staleC.stale.inSync === false && healed.inSync === true
       && healed.buffer[0] === staleC.before.buffer[0],
  'CONTROL: inSync still goes FALSE on a genuinely stale buffer, and TRUE again once the reconciler runs',
  { before: staleC.before.inSync, stale: [staleC.stale.buffer, staleC.stale.inSync], healed: [healed.buffer, healed.inSync] });

/* ============================================================
   PR-17..PR-21 — GRASS AND CAST SHADOWS ACROSS THE RATIO CHANGE.

   tools/_k27-guard.mjs's header lists four things the MSAA/resolution
   change must not break. Three are implemented in it. The fourth —

     "4. GRASS AND CAST SHADOWS still present, by draw call and by
         pixel count, at both ratios."

   — appears nowhere in its body; the words 'grass' and 'shadow' occur
   only inside that comment. A declared invariant nobody executes is
   the same species as a revert check that quotes history: the header
   reads like coverage and is not.

   So it is implemented here, where it will actually run, and on the
   viewport where the ratio really moves at runtime — a phone, whose
   ladder climbs 1 -> 2, not a desktop's 1 -> 1.26.

   BOTH HALVES OF THE PROMISE ARE TAKEN.
     BY DRAW CALL: the foliage module's OWN census (foliageStats(),
       not a regex over object names, which would go quiet the day a
       mesh is renamed), plus the visible shadow-casting and
       -receiving set off the scene graph and the cascade count and
       shadow map size the live CSM is using.
     BY PIXEL: a crop of the delivered frame, read back inside the
       same task as the draw so the drawing buffer is still valid —
       the green fraction (is there still grass) and the dark mass
       under an Otsu split of the crop's own luminance (is anything
       still shadowed). Both are FRACTIONS, so they are comparable
       across two buffers of different size; an absolute pixel count
       could not be.

   THE WORLD IS FROZEN for the comparison exactly as _k29-crawl and
   _k30-inv freeze it, so the two ratios are the same instant of the
   same world and the only difference between them is how it was
   sampled. And the place is arrived at and asserted, with the eye's
   own account of itself printed — a number without a position is not
   a measurement.

   AND THE PIXEL HALF IS A DIFFERENTIAL, NOT A THRESHOLD, BECAUSE THE
   THRESHOLD VERSION WAS MEASURING SOMETHING ELSE. The first cut of
   this check scored "grass" as the green fraction of the crop and
   "cast shadow" as the dark mass under an Otsu split of its own
   luminance. Both passed at both ratios, and both were wrong:

     · hiding the foliage root moved the green fraction by 0.003 — the
       TERRAIN under the grass is green too, so "how green is it" was
       never a grass measurement;
     · killing the shadow term moved the dark mass by 0.007 at midday
       and 0.020 at h07 — the dark mass is mostly dark WINDOWS and,
       at seven in the morning, a generally darker frame. Otsu was
       splitting the illumination, not finding the cast shadow.

   So each subject is counted by the pixels IT OWNS: switch it off,
   count the pixels of the crop that moved, switch it back. That
   number is by construction the pixels the grass draws and the pixels
   the shadow term darkens — no threshold to fit, nothing else in the
   frame can satisfy it — and it is taken AT BOTH RATIOS, which is
   what makes it the invariant rather than a control. PR-21 keeps the
   levers themselves honest.
   ============================================================ */
console.log('\n  --- invariant 4: grass and cast shadows are still there at both ratios ---');
const GRASSPX = () => {
  /* SAME TASK AS THE DRAW. Without preserveDrawingBuffer the backing
     store is only readable until the browser composites, and that is
     the end of this task — so render and copy without yielding.

     The band is the GROUND in front of the camera at eye height: the
     lower half of the frame, inset from the edges. Fractions of the
     buffer, not pixels, so it is the same piece of the world at both
     ratios — which an absolute rectangle would not be. */
  const ctx = WALLY.ctx;
  const shot = () => {
    ctx.render.render();
    const gl = ctx.renderer.domElement;
    const x = Math.round(gl.width * 0.08), w = Math.round(gl.width * 0.84);
    const y = Math.round(gl.height * 0.50), h = Math.round(gl.height * 0.38);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g2 = c.getContext('2d', { willReadFrequently: true });
    g2.drawImage(gl, x, y, w, h, 0, 0, w, h);
    return { crop: [x, y, w, h], d: g2.getImageData(0, 0, w, h).data, n: w * h };
  };
  const moved = (A, B) => {
    let k = 0;
    for (let i = 0, p = 0; i < A.n; i++, p += 4) {
      if (Math.abs(A.d[p] - B.d[p]) > 6 || Math.abs(A.d[p + 1] - B.d[p + 1]) > 6
        || Math.abs(A.d[p + 2] - B.d[p + 2]) > 6) k++;
    }
    return +(k / A.n).toFixed(4);
  };
  const base = shot();

  /* GRASS: the pixels the foliage streamer draws into this band. */
  const fol = ctx.foliage.root;
  fol.visible = false;
  const noGrass = shot();
  fol.visible = true;

  /* CAST SHADOW: the pixels the CSM term darkens. The lever is the
     module's own setFar() — a direct write to uCsmFade is rewritten
     by computeSplits() on the very next frame (rule 5), which is why
     the live uniform is read back and reported rather than trusted. */
  const csm = ctx.render.csm;
  const keepFar = csm.cfg.far;
  csm.setFar(0.5);                        // every cascade ends before the ground does
  const noShadow = shot();
  const liveFade = [+csm.uniforms.uCsmFade.value.x.toFixed(3), +csm.uniforms.uCsmFade.value.y.toFixed(3)];
  csm.setFar(keepFar);
  const restored = shot();

  /* a plain descriptive column, NOT the assertion: how green and how
     dark the band is. Kept because it is free and it is what a reader
     expects to see, marked as descriptive so it cannot be mistaken
     for the measurement. */
  let green = 0, dark = 0;
  for (let i = 0, p = 0; i < base.n; i++, p += 4) {
    const r = base.d[p], g = base.d[p + 1], b = base.d[p + 2];
    if (g > r + 4 && g > b + 4) green++;
    if (0.2126 * r + 0.7152 * g + 0.0722 * b < 96) dark++;
  }
  return {
    crop: base.crop,
    grassPx: moved(base, noGrass),        // the invariant's "by pixel count", grass
    shadowPx: moved(base, noShadow),      // ...and cast shadow
    restoredPx: moved(base, restored),    // must be 0: the levers put the frame back
    liveFade, farFrom: keepFar,
    greenFrac: +(green / base.n).toFixed(4), darkFrac: +(dark / base.n).toFixed(4),
  };
};
const SCENECOUNT = () => {
  const ctx = WALLY.ctx;
  let casters = 0, receivers = 0, visMeshes = 0;
  ctx.scene.traverse(o => {
    if (!o.isMesh || !o.visible) return;
    visMeshes++;
    if (o.castShadow) casters++;
    if (o.receiveShadow) receivers++;
  });
  const csm = ctx.render?.csm;
  const f = WALLY.debug.foliageStats();
  return { visMeshes, casters, receivers,
    shadowMapOn: ctx.renderer.shadowMap.enabled,
    cascades: csm?.cfg?.cascades ?? null, mapSize: csm?.cfg?.mapSize ?? null,
    grassChunks: f.chunks, grassMeshes: f.chunkMeshes, grassInstances: f.chunkInstances,
    grassTris: f.chunkTris, trees: f.trees, treesDrawn: f.treesDrawn };
};
/* THE PLACE, ASSERTED. Everything above this point measures rules and
   ratios and does not care where it stands; a picture of grass and
   shadows does. contracts.js rule 5. */
const invPlace = 'cafe';
const invArrived = await r3.page.evaluate((p) => WALLY.debug.arrive(p, true), invPlace).catch((e) => 'threw: ' + e.message);
if (invArrived !== true) {
  console.log(`   FAIL PR-17..21  arrive('${invPlace}') returned ${JSON.stringify(invArrived)} — refusing to measure the boot position`);
  fails.push(`PR-17..21 arrive('${invPlace}') !== true (got ${JSON.stringify(invArrived)})`);
} else {
  await r3.page.waitForTimeout(6000);
  /* THE HOUR IS PART OF THE SUBJECT. At midday the ground under a
     doorstep carries almost no cast shadow at all — the first run of
     PR-21 measured 1.8 % of the crop moving when shadows were killed,
     which means the dark mass PR-20 was watching was mostly dark
     WINDOWS. h07.0 is the long-shadow hour and it is the hour
     _k30-inv takes this same check at. Set BEFORE the freeze, because
     sky.js's update is one of the hooks the freeze nulls. */
  await r3.page.evaluate(() => WALLY.debug.setHour(7.0));
  await r3.page.waitForTimeout(2500);
  const invAt = await r3.page.evaluate(() => {
    WALLY.debug.governor(false);
    WALLY.ctx.render.setGrain(0);          // a per-frame random field is not the subject
    for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.display = 'none';
    let frozen = 0;                        // same freeze as _k29-crawl / _k30-inv
    for (const h of WALLY.ctx._handles || []) {
      if (!h || h === WALLY.ctx.render) continue;
      for (const k of ['update', 'lateUpdate']) if (typeof h[k] === 'function') { h[k] = () => {}; frozen++; }
    }
    const c = WALLY.ctx.camera;
    const g = WALLY.debug.worldHeight(c.position.x, c.position.z);
    return { frozen, eye: c.position.toArray().map(v => +v.toFixed(2)),
      ground: g.y, agl: +(c.position.y - g.y).toFixed(2), zone: g.zone,
      hour: WALLY.ctx.sky?.hour ?? WALLY.ctx.sky?.state?.().hour ?? null };
  });
  await r3.page.waitForTimeout(900);
  console.log(`  arrive('${invPlace}') TRUE   eye ${JSON.stringify(invAt.eye)}  ground ${invAt.ground} m`
    + `  eye-above-ground ${invAt.agl} m  zone '${invAt.zone}'  hour ${invAt.hour}  world FROZEN (${invAt.frozen} hooks)  grain off`);

  const invRows = [];
  for (const pr of [1, 2, 1]) {                       // first row re-measured last
    await r3.page.evaluate((p) => WALLY.debug.pixelRatio(p), pr);
    await r3.page.waitForTimeout(1800);
    const row = await r3.page.evaluate(([S, G]) => {
      const scene = new Function('return (' + S + ')')()();
      const px = new Function('return (' + G + ')')()();
      return { vp: WALLY.debug.viewport(), scene, px };
    }, [SCENECOUNT.toString(), GRASSPX.toString()]);
    invRows.push({ pr, ...row, drift: invRows.length === 2 });
  }
  const fmt = (r) => `  ${String(r.pr + (r.drift ? '*' : '')).padEnd(6)}${r.vp.buffer.join('x').padEnd(12)}`
    + `${String(r.scene.grassChunks).padEnd(8)}${String(r.scene.grassInstances).padEnd(12)}${String(r.scene.grassTris).padEnd(11)}`
    + `${String(r.scene.casters).padEnd(9)}${String(r.scene.receivers).padEnd(11)}${String(r.scene.cascades).padEnd(6)}`
    + `${String(r.scene.mapSize).padEnd(8)}| ${String((r.px.grassPx * 100).toFixed(2) + ' %').padEnd(11)}`
    + `${String((r.px.shadowPx * 100).toFixed(2) + ' %').padEnd(12)}${String((r.px.restoredPx * 100).toFixed(2) + ' %').padEnd(11)}`
    + `| ${String(r.px.greenFrac).padEnd(11)}${r.px.darkFrac}`;
  console.log('  ' + 'pr'.padEnd(6) + 'buffer'.padEnd(12) + 'chunks'.padEnd(8) + 'grass inst'.padEnd(12) + 'grass tris'.padEnd(11)
    + 'casters'.padEnd(9) + 'receivers'.padEnd(11) + 'casc'.padEnd(6) + 'map'.padEnd(8)
    + '| BY PIXEL: ' + 'grass'.padEnd(11) + 'cast shadow'.padEnd(12) + 'restored'.padEnd(11) + '| descriptive: green      dark');
  for (const r of invRows) console.log(fmt(r));
  const [a, b, aa] = invRows;
  const same = (k) => a.scene[k] === b.scene[k] && a.scene[k] === aa.scene[k];
  console.log(`  band ${JSON.stringify(a.px.crop)} buffer px at pr 1, ${JSON.stringify(b.px.crop)} at pr 2 — the same 84 % x 38 % of the frame.`);
  console.log(`  shadow lever: csm.setFar ${a.px.farFrom} -> 0.5, live uCsmFade read back after the draw as ${JSON.stringify(a.px.liveFade)}.`);
  /* BRANCH: foliage.js api.stats() — the streamer's own chunk/instance
     census, which a ratio change has no path to touch. */
  T('PR-17', same('grassChunks') && same('grassInstances') && same('grassTris') && same('trees') && same('treesDrawn')
         && a.scene.grassInstances > 0,
    'INVARIANT 4a: grass survives the ratio change BY DRAW CALL — chunks, instances, triangles and trees all identical at pr 1 and 2',
    [a.scene.grassChunks, a.scene.grassInstances, a.scene.grassTris]);
  /* BRANCH: renderer.js api.resize() — it resizes the composer pool and
     nothing else; csm.setMapSize/setFar are NOT on the resize path, so
     the cascade rig is sized by tier and never by pixel count. */
  T('PR-18', same('casters') && same('receivers') && same('cascades') && same('mapSize')
         && a.scene.shadowMapOn === true && a.scene.casters > 0,
    'INVARIANT 4b: cast shadows survive it BY DRAW CALL — caster/receiver sets, cascade count and shadow map size identical',
    [a.scene.casters, a.scene.receivers, a.scene.cascades, a.scene.mapSize]);
  /* BRANCH: foliage.js's instanced grass draw, counted by the pixels it
     owns rather than by a colour that the terrain shares with it. */
  T('PR-19', a.px.grassPx > 0.05 && Math.abs(a.px.grassPx - b.px.grassPx) <= 0.02
         && a.px.grassPx === aa.px.grassPx,
    'INVARIANT 4c: grass survives it BY PIXEL — the share of the ground band the grass draws holds across both buffers',
    [a.px.grassPx, b.px.grassPx, aa.px.grassPx]);
  /* BRANCH: csm.js wCsmShadow() — the pixels the shadow term darkens,
     found by switching the term off through cfg.far. */
  T('PR-20', a.px.shadowPx > 0.015 && Math.abs(a.px.shadowPx - b.px.shadowPx) <= 0.01
         && a.px.shadowPx === aa.px.shadowPx,
    'INVARIANT 4d: cast shadows survive it BY PIXEL — the share of the ground band the CSM darkens holds across both buffers',
    [a.px.shadowPx, b.px.shadowPx, aa.px.shadowPx]);
  /* THE LEVERS THEMSELVES. A differential is only a measurement if the
     switch went back: if `restored` were not zero, every number above
     it would be contaminated by whatever the lever left behind. And
     the fade uniform is READ OFF THE SHADER after the draw, because a
     direct write to it is silently rewritten by computeSplits() every
     frame — which is how the first version of this control measured
     0.00 % and looked like a finding. */
  T('PR-21', a.px.restoredPx === 0 && b.px.restoredPx === 0 && aa.px.restoredPx === 0
         && a.px.liveFade[1] <= 0.5 && a.px.farFrom > 1,
    'CONTROL: both levers put the frame back bit-for-bit, and the shadow lever is confirmed at the live uniform, not at the setter',
    { restored: [a.px.restoredPx, b.px.restoredPx, aa.px.restoredPx], liveFade: a.px.liveFade, farFrom: a.px.farFrom });
}

console.log(`\n  PRESENTATION: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('   FAIL ' + f);
console.log(`  machine 1-min load at end: ${load()}`);

await browser.close();
server.close();
if (fails.length) process.exit(1);
