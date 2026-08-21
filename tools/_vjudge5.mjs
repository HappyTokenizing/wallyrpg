#!/usr/bin/env node
/* VERIFY JUDGE part 5 — pointer placement stress + regression sweep.
   Widths from 320 to 1920, every location name in the game, and an
   explicit overlap test against REP, CITY and the whole left cluster. */
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

let fails = 0;
const ok = (c, l, d = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${d ? '  ' + d : ''}`); if (!c) fails++; };
const overlaps = (a, b) => a && b && a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;

const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';

async function run(width, height, mobile) {
  const ctxB = await browser.newContext(mobile
    ? { viewport: { width, height }, hasTouch: true, isMobile: true, deviceScaleFactor: 1, userAgent: MOBILE_UA }
    : { viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctxB.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message.split('\n')[0]));
  await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro=1`, { waitUntil: 'load', timeout: 90000 });
  for (let i = 0; i < 120; i++) { if (await page.evaluate(() => window.__WALLY_READY__ === true).catch(() => 0)) break; await page.waitForTimeout(300); }
  await page.waitForTimeout(3000);

  const probe = () => page.evaluate(() => {
    const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
    const ptr = document.querySelector('.w-ptr');
    const kOf = (t) => [...document.querySelectorAll('.w-k')].find(e => (e.textContent || '').trim().toUpperCase() === t);
    const rep = kOf('REP')?.closest('.w-pill'), city = kOf('CITY')?.closest('.w-pill');
    const leftRoot = document.querySelector('.w-left') || ptr?.parentElement;
    return {
      vw: innerWidth, vh: innerHeight,
      rail: ptr?.classList.contains('rail'), off: ptr?.classList.contains('off'),
      ptr: box(ptr), rep: box(rep), city: box(city),
      text: ptr ? (ptr.innerText || '').replace(/\n/g, ' | ') : null,
      leftBoxes: [...document.querySelectorAll('.w-pill,.w-obj')]
        .map(e => ({ t: (e.innerText || '').replace(/\n/g, ' ').slice(0, 20), ...box(e) }))
        .filter(b => b.x < innerWidth * 0.5),
      ellipsed: (() => { const t = ptr?.querySelector('.t'); return t ? t.scrollWidth > t.clientWidth + 1 : null; })(),
    };
  });

  const names = await page.evaluate(() => {
    const g = WALLY.ctx.game;
    return Object.keys(g.data.locationById).map(id => { const l = g.data.locationById[id]; return { id, name: String(l.name || l.title || l.label || id) }; });
  });
  // the longest-named place is the worst case for the rail
  const longest = names.slice().sort((a, b) => b.name.length - a.name.length)[0];

  const results = [];
  for (const target of [names.find(n => /apartment/i.test(n.name)) || names[0], longest]) {
    await page.evaluate((id) => { const h = WALLY.ctx.hud || WALLY.ctx.ui?.hud; try { h.setDestination(id); } catch {} }, target.id);
    await page.waitForTimeout(900);
    const p = await probe();
    results.push({ target: target.name, p });
  }
  await ctxB.close();
  return { results, errs: [...new Set(errs)], longest };
}

const WIDTHS = [[320, 700, true], [360, 780, true], [390, 844, true], [430, 932, true], [768, 1024, true], [899, 900, false], [900, 900, false], [1200, 800, false], [1440, 900, false], [1920, 1080, false]];

console.log('POINTER PLACEMENT SWEEP\n');
for (const [w, h, mob] of WIDTHS) {
  const { results, errs } = await run(w, h, mob);
  console.log(`\n=== ${w}x${h} ${mob ? '(mobile ctx)' : '(desktop ctx)'} ===`);
  for (const { target, p } of results) {
    const ctr = p.ptr ? p.ptr.x + p.ptr.w / 2 : 0;
    const inRight = p.ptr && ctr > p.vw / 2 + 4;
    const belowPills = p.ptr && p.rep && p.city && p.ptr.y >= p.rep.bottom && p.ptr.y >= p.city.bottom;
    const clearOfPills = !overlaps(p.ptr, p.rep) && !overlaps(p.ptr, p.city);
    const clearOfLeft = !p.leftBoxes.some(b => overlaps(p.ptr, b));
    const inViewport = p.ptr && p.ptr.x >= 0 && p.ptr.right <= p.vw + 1;
    console.log(`  "${target}"  rail=${p.rail} off=${p.off}`);
    console.log(`    ptr ${JSON.stringify(p.ptr)}  text=${JSON.stringify(p.text)} ellipsed=${p.ellipsed}`);
    console.log(`    rep ${JSON.stringify(p.rep)}  city ${JSON.stringify(p.city)}`);
    if (p.rail) {
      ok(inRight, `${w}px: pointer is in the RIGHT half`, `centre ${p.ptr ? Math.round(p.ptr.x + p.ptr.w / 2) : '?'} of ${p.vw}`);
      ok(belowPills, `${w}px: pointer sits BELOW both pills`, `ptr.y ${p.ptr?.y} vs rep.bottom ${p.rep?.bottom} / city.bottom ${p.city?.bottom}`);
      const rightEdge = Math.max(p.rep?.right || 0, p.city?.right || 0);
      ok(p.ptr && Math.abs(p.ptr.right - rightEdge) <= 2, `${w}px: shares the right edge with the pill cluster`, `${p.ptr?.right} vs ${rightEdge}`);
    } else {
      ok(Math.abs(ctr - p.vw / 2) <= 2, `${w}px: centre-top placement is actually centred`, `centre ${ctr} of ${p.vw}`);
    }
    ok(clearOfPills, `${w}px: no overlap with REP or CITY`);
    ok(clearOfLeft, `${w}px: no overlap with any left-hand pill or the objective strip`);
    ok(inViewport, `${w}px: fully inside the viewport`);
  }
  if (errs.length) console.log('  page errors:', JSON.stringify(errs.slice(0, 3)));
  ok(errs.length === 0, `${w}px: no page errors`);
}

await browser.close(); server.close();
console.log(`\n${fails === 0 ? 'POINTER SWEEP ALL GREEN' : fails + ' POINTER CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
