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


/* WHO IS DRIVING HIM? touch.js's input() falls back to the keyboard
   whenever the stick is at zero, so a walking speed with stick t 0 has
   exactly two possible sources: a stuck movement KEY (which would be
   this harness's fault, it dispatches key events) or an input function
   game.js installed over the default (which would not be). One line
   tells them apart: wally.keyboardInput() reports what the KEYS alone
   say, with no stick and no override in it. */
const who = () => page.evaluate(() => {
  const w = WALLY.ctx.wally, v = w.controller.velocity;
  const kb = w.keyboardInput ? w.keyboardInput({}) : null;
  const t = WALLY.debug.touchState();
  return {
    v: { x: +v.x.toFixed(2), z: +v.z.toFixed(2) }, speed: +Math.hypot(v.x, v.z).toFixed(2),
    kb: kb ? { x: +kb.x.toFixed(2), z: +kb.z.toFixed(2), run: kb.run, jump: kb.jump } : null,
    stick: { t: +(t.t ?? 0).toFixed(2) },
    pos: { x: +w.position.x.toFixed(2), z: +w.position.z.toFixed(2) },
    near: WALLY.ctx.ui.near?.id ?? null, panels: WALLY.ctx.ui.panels.slice(),
  };
});
const cdp = await ctx.newCDPSession(page);
const MASK = { left: 1, middle: 4, right: 2 };
const mouse = (type, x, y, button = 'none', buttons = 0) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
async function mousePress(x, y, button = 'left', hold = 50) {
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, button, MASK[button]);
  await page.waitForTimeout(hold);
  await mouse('mouseReleased', x, y, button, 0);
}
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.hideUI(false); });
await page.waitForTimeout(600);
const ACT = await page.evaluate(() => { const r = document.querySelector('.w-acts .w-abtn.act').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; });

console.log('--- F: the judge\'s K flow, step by step ---');
console.log('F0 booted, nothing touched      ', JSON.stringify(await who()));
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.arrive('apartment', true); });
await page.waitForTimeout(3000);
console.log('F1 after debug.arrive(apartment)', JSON.stringify(await who()));
await page.evaluate(() => { WALLY.ctx.ui.hide('dialogue'); WALLY.ctx.ui.closeAll(); });
await page.waitForTimeout(1200);
console.log('F2 after the dismissal          ', JSON.stringify(await who()));
await page.evaluate(() => { WALLY.debug.hideUI(true); WALLY.debug.idle(0.5); });
let f = null;
for (let i = 0; i < 30 && !f; i++) { await page.waitForTimeout(200); const s = await page.evaluate(() => WALLY.debug.idle()); if (s.hidden) f = i * 200; }
console.log('F3 fade:', f === null ? 'NEVER FADED' : `faded after ${f} ms`, JSON.stringify(await who()));
await mousePress(ACT.x, ACT.y, 'right', 40);
await page.waitForTimeout(80);
await mousePress(ACT.x, ACT.y, 'right', 40);
await page.waitForTimeout(1000);
console.log('F4 after the right double click ', JSON.stringify(await page.evaluate(() => { const i = WALLY.debug.idle(); return { hidden: i.hidden, wakes: i.wakes, live: i.live, moving: i.moving }; })), JSON.stringify(await who()));
await page.waitForTimeout(1500);
console.log('F5 1.5 s later                  ', JSON.stringify(await who()));
/* and the one the judge does next: a left press on the live ENTER */
await page.waitForTimeout(600);
await mousePress(ACT.x, ACT.y, 'left', 70);
await page.waitForTimeout(1200);
console.log('F6 after a LEFT press on Enter  ', JSON.stringify(await who()));
await page.waitForTimeout(2500);
console.log('F7 2.5 s after that             ', JSON.stringify(await who()));

await browser.close();
server.close();
