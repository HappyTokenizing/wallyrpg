/* mobilebugs.mjs — reproduce the three reported mobile faults.
     1 legs do not animate while walking on touch
     2 the yellow pointer sits under the objective, not upper-right
     3 music does not start on mobile Chrome
   Real touch events through CDP, mobile viewport, hasTouch + isMobile. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--autoplay-policy=user-gesture-required'] });
const ctxB = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true, isMobile: true, deviceScaleFactor: 1,
  userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
});
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
await browser.close();
server.close();
