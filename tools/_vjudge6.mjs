#!/usr/bin/env node
/* VERIFY JUDGE part 6 — screenshots of the awkward widths, plus the
   final mobile + desktop gameplay regression shots. */
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
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader'] });
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';

async function shot(name, width, height, mobile, { walk = false, dest = true } = {}) {
  const ctxB = await browser.newContext(mobile
    ? { viewport: { width, height }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: UA }
    : { viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctxB.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message.split('\n')[0]));
  await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro=1`, { waitUntil: 'load', timeout: 90000 });
  for (let i = 0; i < 120; i++) { if (await page.evaluate(() => window.__WALLY_READY__ === true).catch(() => 0)) break; await page.waitForTimeout(300); }
  await page.waitForTimeout(3500);
  if (dest) {
    await page.evaluate(() => { const g = WALLY.ctx.game, h = WALLY.ctx.hud || WALLY.ctx.ui?.hud;
      const id = Object.keys(g.data.locationById).find(i => /apartment/i.test(g.data.locationById[i].name || '')) || Object.keys(g.data.locationById)[1];
      try { h.setDestination(id); } catch {} });
    await page.waitForTimeout(900);
  }
  if (walk) {
    const cdp = await ctxB.newCDPSession(page);
    const t = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 12, radiusY: 12, force: 1 }] });
    if (mobile) {
      await t('touchStart', 90, height - 160); await page.waitForTimeout(120);
      await t('touchMove', 90, height - 240); await page.waitForTimeout(2600);
    } else {
      await page.keyboard.down('w'); await page.waitForTimeout(2600);
    }
  }
  await page.screenshot({ path: join(OUT, name + '.png') });
  const info = await page.evaluate(() => {
    const b = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
    return { fps: WALLY.ctx.loop?.fps ?? null, ptr: b(document.querySelector('.w-ptr')),
      speed: +(WALLY.ctx.wally?.controller?.planarSpeed ?? 0).toFixed(2),
      legL0: (() => { let v = null; WALLY.ctx.wally.root.traverse(o => { if (o.name === 'legL0') v = +o.rotation.x.toFixed(3); }); return v; })() };
  });
  console.log(`${name}: ${JSON.stringify(info)}  errors=${errs.length} ${JSON.stringify([...new Set(errs)].slice(0, 2))}`);
  await ctxB.close();
}

await shot('edge-320', 320, 700, true);
await shot('edge-768', 768, 1024, true);
await shot('final-mobile-gameplay', 390, 844, true, { walk: true });
await shot('final-desktop-gameplay', 1600, 900, false, { walk: true });

await browser.close(); server.close();
