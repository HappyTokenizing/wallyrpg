/* _vjpad-drift.mjs — WHY DOES HE MOVE WITH NOTHING TOUCHED?

   Sixteen assertions in tools/_vjpad-judge.mjs failed on one symptom:
   with no contact anywhere, the elephant covers 1.5-2.5 m in 0.6 s. That
   breaks the idle clock outright (moving() is an input to it, so nothing
   ever fades and every wake assertion is unmeasurable) and it breaks
   every "he stopped" measurement in the file.

   Two candidates, and they have different owners:
     · the suite latched an input (a stick contact, a key) — mine, and
       the assertions are wrong;
     · he drifts on a freshly booted page with nothing ever touched —
       not the pad's, and the judge should say so rather than blame it.

   So: boot, touch NOTHING, watch. Then warp and watch again. */
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
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(4000);

const snap = () => page.evaluate(() => {
  const w = WALLY.ctx.wally, c = w.controller, v = c.velocity || c.vel || {};
  const t = WALLY.debug.touchState();
  return {
    p: { x: +w.position.x.toFixed(2), z: +w.position.z.toFixed(2), y: +w.position.y.toFixed(2) },
    v: { x: +(v.x ?? 0).toFixed(2), y: +(v.y ?? 0).toFixed(2), z: +(v.z ?? 0).toFixed(2) },
    grounded: c.grounded, stick: { t: +(t.t ?? 0).toFixed(2), x: +(t.x ?? 0).toFixed(2), z: +(t.z ?? 0).toFixed(2) },
    idle: (() => { const i = WALLY.debug.idle(); return { moving: i.moving, why: i.why, armed: i.armed, hidden: i.hidden }; })(),
  };
});
const speed = (a, b, ms) => +(Math.hypot(b.p.x - a.p.x, b.p.z - a.p.z) / (ms / 1000)).toFixed(2);

async function watch(label, ms = 3000) {
  const a = await snap();
  await page.waitForTimeout(ms);
  const b = await snap();
  console.log(`${label}
   from ${JSON.stringify(a.p)}  v ${JSON.stringify(a.v)}  grounded ${a.grounded}  stick ${JSON.stringify(a.stick)}  idle ${JSON.stringify(a.idle)}
   to   ${JSON.stringify(b.p)}  v ${JSON.stringify(b.v)}  grounded ${b.grounded}  stick ${JSON.stringify(b.stick)}  idle ${JSON.stringify(b.idle)}
   >>>  ${speed(a, b, ms)} m/s over ${ms} ms`);
  return { a, b, mps: speed(a, b, ms) };
}

console.log('--- A: a fresh page, nothing ever touched ---');
await watch('A1 as booted', 3000);
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.hideUI(false); });
await page.waitForTimeout(500);
await watch('A2 after closeAll', 3000);

console.log('\n--- B: after the warp the judge uses (warpTo boot + 0.3) ---');
const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
await page.evaluate((b) => { WALLY.ctx.ui.closeAll(); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {}); }, BOOT);
await page.waitForTimeout(1500);
await watch('B1 1.5 s after the warp', 3000);
await page.waitForTimeout(2000);
await watch('B2 a further 2 s later', 3000);

console.log('\n--- C: does the idle clock ever fire with nothing touched? ---');
await page.evaluate(() => { WALLY.debug.hideUI(true); WALLY.debug.idle(0.5); });
let fired = null;
for (let i = 0; i < 40 && !fired; i++) {
  await page.waitForTimeout(250);
  const s = await page.evaluate(() => WALLY.debug.idle());
  if (s.hidden) fired = { at: i * 250, s };
}
const idleEnd = await page.evaluate(() => WALLY.debug.idle());
console.log(fired ? `C1 faded after ${fired.at} ms  ${JSON.stringify({ hidden: fired.s.hidden, wakes: fired.s.wakes })}`
                  : `C1 NEVER FADED in 10 s  ${JSON.stringify({ hidden: idleEnd.hidden, why: idleEnd.why, t: idleEnd.t, moving: idleEnd.moving })}`);
await page.evaluate(() => { WALLY.debug.idle(null); WALLY.debug.hideUI(false); });

console.log('\n--- D: is anything holding an input? ---');
console.log(JSON.stringify(await page.evaluate(() => {
  const t = WALLY.debug.touchState();
  return { touch: t, layers: !!document.querySelector('.w-touch'),
    downButtons: [...document.querySelectorAll('.w-abtn.down')].map((b) => b.getAttribute('aria-label')),
    stickLive: !!document.querySelector('.w-stick.live') };
})));

console.log('\n--- E: after the judge\'s OWN setup calls, one at a time ---');
async function after(label, fn) {
  await fn();
  await page.waitForTimeout(1200);
  await page.evaluate((b) => { WALLY.ctx.ui.closeAll(); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {}); }, BOOT);
  await page.waitForTimeout(800);
  const r = await watch(label, 1500);
  return r.mps;
}
const e1 = await after('E1 after debug.arrive(apartment) + warp back', async () => {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.arrive('apartment', true); });
  await page.waitForTimeout(3000);
});
const e2 = await after('E2 after a canvas drag (I3\'s gesture) + warp back', async () => {
  const cdp = await ctx.newCDPSession(page);
  const P = (x, y, id = 7) => ({ x, y, id, radiusX: 14, radiusY: 14, force: 1 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [P(120, 330)] });
  for (let i = 1; i <= 6; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [P(120 + i * 25, 330)] }); await page.waitForTimeout(45); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
});
const e3 = await after('E3 after a short tap on the canvas (X2\'s fall-through press) + warp back', async () => {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 195, y: 700, button: 'none', buttons: 0, clickCount: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 195, y: 700, button: 'left', buttons: 1, clickCount: 1 });
  await page.waitForTimeout(25);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 195, y: 700, button: 'left', buttons: 0, clickCount: 1 });
});
console.log(`\nSUMMARY  arrive ${e1} m/s | canvas drag ${e2} m/s | canvas tap ${e3} m/s  (fresh page was 0)`);

await browser.close();
server.close();
