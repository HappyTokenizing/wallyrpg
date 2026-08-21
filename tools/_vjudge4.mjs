#!/usr/bin/env node
/* VERIFY JUDGE part 4 — LOOK AT THE LEGS.
   Mobile context, real CDP touch driving the thumbstick. The camera is
   moved to the 'hero' / 'wide' framing so the legs are actually VISIBLE
   in the frame — the camera is not what is under test, the leg motion
   is, and the on-screen thumbstick otherwise sits on top of them. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const OUT = '/private/tmp/claude-501/-Users-herwig-Desktop-Claude-files/648e6001-7010-404a-9eea-f16c59f21a5d/scratchpad/shots';
await mkdir(OUT, { recursive: true });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try {
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader'] });
const MOBILE = {
  viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
};
const ctxB = await browser.newContext(MOBILE);
const page = await ctxB.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro=1`, { waitUntil: 'load', timeout: 90000 });
for (let i = 0; i < 100; i++) { if (await page.evaluate(() => window.__WALLY_READY__ === true).catch(() => 0)) break; await page.waitForTimeout(300); }
await page.waitForTimeout(3000);
const cdp = await ctxB.newCDPSession(page);
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 12, radiusY: 12, force: 1 }] });

const bones = () => page.evaluate(() => {
  const w = WALLY.ctx.wally; const o = {};
  w.root.traverse(b => { if (/^(legL0|legR0)$/.test(b.name)) o[b.name] = +b.rotation.x.toFixed(3); });
  o.speed = +(w.controller?.planarSpeed ?? 0).toFixed(2);
  return o;
});

// hold the stick full forward, then reframe the camera so the legs show
await touch('touchStart', 90, 684); await page.waitForTimeout(120);
await touch('touchMove', 90, 604);
await page.waitForTimeout(2500);
console.log('camPreset ->', await page.evaluate(() => { try { return WALLY.debug.camPreset('wide'); } catch (e) { return 'ERR ' + e.message; } }));
await page.waitForTimeout(1200);

console.log('\n--- 8 frames, ~120 ms apart, camera "wide", stick held ---');
for (let i = 0; i < 8; i++) {
  const b = await bones();
  await page.screenshot({ path: join(OUT, `wide-${i}.png`) });
  console.log(` wide-${i}`, JSON.stringify(b));
  await page.waitForTimeout(120);
}

console.log('\n--- the "half a second apart" pair, camera "hero" ---');
console.log('camPreset ->', await page.evaluate(() => { try { return WALLY.debug.camPreset('wide'); } catch (e) { return 'ERR ' + e.message; } }));
await page.waitForTimeout(1500);
const bA = await bones(); await page.screenshot({ path: join(OUT, 'pair-A.png') });
await page.waitForTimeout(500);
const bB = await bones(); await page.screenshot({ path: join(OUT, 'pair-B.png') });
console.log(' A:', JSON.stringify(bA));
console.log(' B:', JSON.stringify(bB));

await touch('touchEnd', 90, 604);
await page.waitForTimeout(2000);
const bI = await bones(); await page.screenshot({ path: join(OUT, 'pair-idle.png') });
console.log(' idle after release:', JSON.stringify(bI));
console.log('page errors:', errs.length, JSON.stringify([...new Set(errs)].slice(0, 3)));
await browser.close(); server.close();
