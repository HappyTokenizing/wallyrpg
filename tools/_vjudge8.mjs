#!/usr/bin/env node
/* VERIFY JUDGE part 8 — the real-landing half of the legs gate, using the
   animator object the game actually exposes (ctx.wally.animator). */
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
let held = false;
const touch = async (t, x, y) => { try { await cdp.send('Input.dispatchTouchEvent', { type: t, touchPoints: t === 'touchEnd' ? [] : [{ x, y, radiusX: 12, radiusY: 12, force: 1 }] }); } catch (e) { console.log(' touch err', t, e.message.split('\n')[0]); } };

let fails = 0;
const ok = (c, l, d = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${d ? '  ' + d : ''}`); if (!c) fails++; };

console.log('animator surface:', JSON.stringify(await page.evaluate(() => {
  const a = WALLY.ctx.wally.animator;
  return { has: !!a, locoName: a?.locoName, speed: a?.speed, action: a?.action?.clip?.name ?? null, keys: Object.keys(a || {}).slice(0, 14) };
})));

// record every clip the game asks for
await page.evaluate(() => {
  window.__CLIPS__ = []; window.__LAND__ = []; window.__JUMP__ = [];
  const a = WALLY.ctx.wally.animator;
  const p = a.play.bind(a);
  a.play = (n, o) => { window.__CLIPS__.push({ n, t: +performance.now().toFixed(0) }); return p(n, o); };
  WALLY.ctx.bus.on('phys:land', (e) => window.__LAND__.push(+(e?.impact ?? 0).toFixed(3)));
  WALLY.ctx.bus.on('phys:jump', () => window.__JUMP__.push(1));
});

const jbtn = await page.evaluate(() => {
  const b = [...document.querySelectorAll('*')].find(e => {
    const r = e.getBoundingClientRect();
    return /^\s*JUMP\s*$/i.test((e.textContent || '').trim()) && r.width > 40 && r.width < 130;
  });
  if (!b) return null; const r = b.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
});
console.log('jump button:', JSON.stringify(jbtn));

/* --- A. a standing jump --- */
console.log('\nA. standing jump');
await touch('touchStart', jbtn.x, jbtn.y); await page.waitForTimeout(160); await touch('touchEnd', jbtn.x, jbtn.y);
await page.waitForTimeout(2600);
let r = await page.evaluate(() => ({ clips: window.__CLIPS__.map(c => c.n), jumps: window.__JUMP__.length, lands: window.__LAND__ }));
console.log(' ', JSON.stringify(r));
ok(r.jumps > 0, 'the jump fired');
ok(r.clips.includes('jump-takeoff'), 'jump-takeoff played');
ok(r.clips.includes('jump-air'), 'jump-air played — he was genuinely airborne');
ok(r.clips.includes('jump-land'), 'jump-land STILL plays on a real landing — the gate did not eat it');
ok(r.lands.some(i => i > 0.05), 'the landing carried a real impact', JSON.stringify(r.lands));

/* --- B. a running jump: the locomotion layer must come back --- */
console.log('\nB. running jump, then the legs must return');
await page.evaluate(() => { window.__CLIPS__.length = 0; window.__LAND__.length = 0; window.__JUMP__.length = 0; });
await touch('touchStart', 90, 684); await page.waitForTimeout(120);
await touch('touchMove', 90, 604); await page.waitForTimeout(1600);
// the jump button needs its own touch point; release the stick first is
// not what a player does, so use a second finger via a fresh CDP touch set
await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [
  { id: 1, x: 90, y: 604, radiusX: 12, radiusY: 12, force: 1 },
  { id: 2, x: jbtn.x, y: jbtn.y, radiusX: 12, radiusY: 12, force: 1 },
] }).catch(e => console.log('  2-finger err', e.message.split('\n')[0]));
await page.waitForTimeout(140);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [
  { id: 1, x: 90, y: 604, radiusX: 12, radiusY: 12, force: 1 },
] }).catch(() => {});
await page.waitForTimeout(2600);
const post = await page.evaluate(() => new Promise(res => {
  const w = WALLY.ctx.wally; let bone = null;
  w.root.traverse(o => { if (!bone && o.name === 'legL0') bone = o; });
  const s = []; const t0 = performance.now();
  const step = () => { s.push(bone.rotation.x);
    if (performance.now() - t0 < 1200) requestAnimationFrame(step);
    else res({ range: +(Math.max(...s) - Math.min(...s)).toFixed(4),
      speed: +(w.controller.planarSpeed || 0).toFixed(2),
      loco: w.animator.locoName, action: w.animator.action?.clip?.name ?? null,
      clips: window.__CLIPS__.map(c => c.n), jumps: window.__JUMP__.length, lands: window.__LAND__.length });
  };
  requestAnimationFrame(step);
}));
console.log(' ', JSON.stringify(post));
ok(post.jumps > 0, 'the running jump fired');
ok(post.speed > 1.5, 'he is still running after the landing', String(post.speed));
ok(post.range > 1.0, 'the LOCOMOTION LAYER IS BACK after a running jump — legs animating', `${post.range} rad, loco=${post.loco}, action=${post.action}`);
ok(post.action === null, 'the action layer released (no clip pinned)', String(post.action));
await touch('touchEnd', 90, 604);

console.log('\npage errors:', errs.length, JSON.stringify([...new Set(errs)].slice(0, 3)));
ok(errs.length === 0, 'no page errors');
await browser.close(); server.close();
console.log(`\n${fails === 0 ? 'JUMP/LAND CHECKS GREEN' : fails + ' FAILED'}`);
process.exit(fails ? 1 : 0);
