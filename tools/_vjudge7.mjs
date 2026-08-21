#!/usr/bin/env node
/* VERIFY JUDGE part 7 — the MECHANISM behind the legs fix.
   1  ground-snap flicker still happens (phys:land fires at high rate),
      and the legs animate anyway -> the gate is doing real work;
   2  a REAL jump still plays jump-land -> the gate is not just
      throwing every landing away. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
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
const ctxB = await browser.newContext({
  viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1,
  userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
});
const page = await ctxB.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro=1`, { waitUntil: 'load', timeout: 90000 });
for (let i = 0; i < 120; i++) { if (await page.evaluate(() => window.__WALLY_READY__ === true).catch(() => 0)) break; await page.waitForTimeout(300); }
await page.waitForTimeout(3000);
const cdp = await ctxB.newCDPSession(page);
const touch = (t, x, y) => cdp.send('Input.dispatchTouchEvent', { type: t, touchPoints: t === 'touchEnd' ? [] : [{ x, y, radiusX: 12, radiusY: 12, force: 1 }] });

await page.evaluate(() => {
  window.__LAND__ = []; window.__JUMP__ = [];
  WALLY.ctx.bus.on('phys:land', (e) => window.__LAND__.push({ t: performance.now(), impact: e && +(e.impact ?? 0).toFixed(3) }));
  WALLY.ctx.bus.on('phys:jump', () => window.__JUMP__.push(performance.now()));
});

let fails = 0;
const ok = (c, l, d = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${d ? '  ' + d : ''}`); if (!c) fails++; };

/* Sweep headings, and on each one measure BOTH the phys:land rate and
   the leg-bone range over the same window. */
const probe = (ms) => page.evaluate((MS) => new Promise(res => {
  const w = WALLY.ctx.wally, c = w.controller;
  let bone = null; w.root.traverse(o => { if (!bone && o.name === 'legL0') bone = o; });
  const n0 = window.__LAND__.length;
  const s = []; const g = [];
  const t0 = performance.now();
  const step = () => {
    s.push(bone.rotation.x); g.push(c.grounded ? 1 : 0);
    if (performance.now() - t0 < MS) requestAnimationFrame(step);
    else res({
      lands: window.__LAND__.length - n0,
      secs: +((performance.now() - t0) / 1000).toFixed(2),
      range: +(Math.max(...s) - Math.min(...s)).toFixed(4),
      frames: s.length,
      ungroundedFrames: g.filter(x => !x).length,
      speed: +(c.planarSpeed || 0).toFixed(2),
      autoClip: (() => { try { return WALLY.debug.wallyAnim?.().autoClip ?? null; } catch { return null; } })(),
    });
  };
  requestAnimationFrame(step);
}), ms);

console.log('MECHANISM CHECK — ground-snap flicker vs leg motion\n');
const rows = [];
for (let k = 0; k < 10; k++) {
  await touch('touchStart', 300, 300); await page.waitForTimeout(60);
  await touch('touchMove', 300 - 38, 300); await page.waitForTimeout(120);
  await touch('touchEnd', 300 - 38, 300); await page.waitForTimeout(200);
  await touch('touchStart', 90, 684); await page.waitForTimeout(100);
  await touch('touchMove', 90, 604); await page.waitForTimeout(1400);
  const r = await probe(1500);
  rows.push({ h: k, ...r });
  await touch('touchEnd', 90, 604);
  await page.waitForTimeout(350);
}
console.table(rows);
const moving = rows.filter(r => r.speed > 1.5);
const flicker = moving.filter(r => r.lands > 3);
console.log(`headings where he actually moved: ${moving.length}/10; of those, ${flicker.length} showed ground-snap flicker (>3 phys:land in ~1.5 s)`);
ok(moving.length > 0, 'he moved on at least one heading');
ok(moving.every(r => r.range > 1.0), 'every MOVING heading animates the legs (range > 1.0 rad)',
  JSON.stringify(moving.map(r => r.range)));
if (flicker.length) {
  ok(flicker.every(r => r.range > 1.0), 'legs animate EVEN ON the flickering headings — the gate works',
    JSON.stringify(flicker.map(r => ({ lands: r.lands, range: r.range }))));
} else {
  console.log('  NOTE  no ground-snap flicker reproduced in this run; the gate could not be exercised directly here.');
}
ok(rows.filter(r => r.speed < 1.5).every(r => r.range < 0.3), 'headings where he is BLOCKED show no leg motion (correct, he is not moving)',
  JSON.stringify(rows.filter(r => r.speed < 1.5).map(r => ({ speed: r.speed, range: r.range }))));

/* --- a REAL jump must still land --- */
console.log('\nREAL JUMP still plays jump-land');
const jbtn = await page.evaluate(() => {
  const b = [...document.querySelectorAll('*')].find(e => /jump/i.test(e.textContent || '') && e.getBoundingClientRect().width > 40 && e.getBoundingClientRect().width < 120);
  if (!b) return null; const r = b.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
});
console.log('  jump button:', JSON.stringify(jbtn));
await page.evaluate(() => { window.__LAND__.length = 0; window.__JUMP__.length = 0; window.__CLIPS__ = []; });
await page.evaluate(() => {
  const a = WALLY.ctx.wally.anim;
  if (a && !a.__wrapped) { const p = a.play.bind(a); a.play = (n, o) => { window.__CLIPS__.push(n); return p(n, o); }; a.__wrapped = true; }
});
if (jbtn) { await touch('touchStart', jbtn.x, jbtn.y); await page.waitForTimeout(160); await touch('touchEnd', jbtn.x, jbtn.y); }
await page.waitForTimeout(2500);
const jr = await page.evaluate(() => ({ jumps: window.__JUMP__.length, lands: window.__LAND__.length, clips: window.__CLIPS__.slice(0, 12), maxImpact: Math.max(0, ...window.__LAND__.map(l => l.impact || 0)) }));
console.log('  ', JSON.stringify(jr));
ok(jr.jumps > 0, 'the jump fired');
ok(jr.clips.includes('jump-takeoff'), 'jump-takeoff played', JSON.stringify(jr.clips));
ok(jr.clips.includes('jump-air'), 'jump-air played (he was genuinely airborne)');
ok(jr.clips.includes('jump-land'), 'jump-land STILL plays on a real landing — the gate did not eat it');

/* --- and the legs recover after that landing --- */
await touch('touchStart', 90, 684); await page.waitForTimeout(100);
await touch('touchMove', 90, 604); await page.waitForTimeout(400);
if (jbtn) { await touch('touchStart', jbtn.x, jbtn.y); await page.waitForTimeout(140); await touch('touchEnd', jbtn.x, jbtn.y); }
await page.waitForTimeout(2200);
const after = await probe(1200);
console.log('\n  after a jump WHILE RUNNING:', JSON.stringify(after));
ok(after.speed < 1.5 || after.range > 1.0, 'the locomotion layer comes back after a running jump', `speed ${after.speed} range ${after.range}`);
await touch('touchEnd', 90, 604);

console.log('\npage errors:', errs.length, JSON.stringify([...new Set(errs)].slice(0, 3)));
ok(errs.length === 0, 'no page errors');
await browser.close(); server.close();
console.log(`\n${fails === 0 ? 'MECHANISM CHECKS GREEN' : fails + ' FAILED'}`);
process.exit(fails ? 1 : 0);
