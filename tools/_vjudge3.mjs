#!/usr/bin/env node
/* VERIFY JUDGE part 3 — AUDIO, honestly blocked, on a real mobile context.

   My first attempt was VACUOUS: the imposed block did not bite (the
   context was born `running` in this Chrome) and the pass proved
   nothing. This version asserts the PRE-CONDITION first — context
   suspended, boot screen asking, zero notes — and refuses to report a
   pass unless the block was real.

   The block gates resume() on the STRICT phone rule: the browser must
   report live user activation AND a spec-activating event must have
   arrived. On a touchscreen that means `touchend` / `pointerup` —
   NOT `touchstart` / `pointerdown`, which this desktop Chrome build
   wrongly treats as activating. That gap is exactly why the bug was
   invisible on desktop.
*/
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const OUT = '/private/tmp/claude-501/-Users-herwig-Desktop-Claude-files/648e6001-7010-404a-9eea-f16c59f21a5d/scratchpad/shots';
await mkdir(OUT, { recursive: true });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json' };
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
const URLBASE = `http://127.0.0.1:${port}/index.html`;

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader', '--autoplay-policy=user-gesture-required'],
});
const MOBILE = {
  viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1,
  userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
};
const mkTouch = (cdp) => (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 12, radiusY: 12, force: 1 }],
});
async function waitReady(page, ms = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(() => window.__WALLY_READY__ === true).catch(() => false)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

let fails = 0;
const ok = (c, label, detail = '') => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); if (!c) fails++; };

async function blockedPage(ctxB, { hostile = false } = {}) {
  const page = await ctxB.newPage();
  await page.addInitScript(() => {
    /* strict phone activation rule */
    const gate = { at: -1e9 };
    window.__ACT__ = [];
    const spec = (e) => (
      e.type === 'keydown' ? e.key !== 'Escape'
        : (e.type === 'mousedown' || e.type === 'click' || e.type === 'touchend') ? true
          : e.type === 'pointerdown' ? e.pointerType === 'mouse'
            : e.type === 'pointerup' ? e.pointerType !== 'mouse'
              : false);
    for (const t of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'click', 'keydown']) {
      window.addEventListener(t, (e) => {
        if (!e.isTrusted) return;
        const s = spec(e);
        if (s) gate.at = performance.now();
        window.__ACT__.push({ t, spec: s, browserSaysActive: !!navigator.userActivation?.isActive, target: (e.target && (e.target.id || (typeof e.target.className === 'string' ? e.target.className : '') || e.target.tagName)) + '' });
      }, { capture: true, passive: true });
    }
    const permitted = () => !!navigator.userActivation?.isActive && (performance.now() - gate.at) < 5000;

    const Real = window.AudioContext || window.webkitAudioContext;
    window.__REFUSED__ = 0;
    class Blocked extends Real {
      constructor(...a) { super(...a); this.__blocked = true; try { super.suspend(); } catch {} }
      get state() { return this.__blocked ? 'suspended' : super.state; }
      resume() {
        if (!this.__blocked) return super.resume();
        if (!permitted()) { window.__REFUSED__++; return new Promise(() => {}); }
        this.__blocked = false;
        window.__ALLOWED_AT__ = [...window.__ACT__].slice(-3);
        return super.resume();
      }
    }
    window.AudioContext = Blocked;
    window.webkitAudioContext = Blocked;
  });
  if (hostile) {
    await page.addInitScript(() => {
      const put = () => {
        const d = document.createElement('div');
        d.id = 'hostileOverlay';
        d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.02);touch-action:none';
        window.__OVL__ = [];
        const swallow = (e) => { window.__OVL__.push(e.type); e.preventDefault(); e.stopPropagation(); };
        for (const t of ['touchstart', 'touchend', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) d.addEventListener(t, swallow, { passive: false });
        document.body.appendChild(d);
      };
      if (document.body) put(); else addEventListener('DOMContentLoaded', put);
    });
  }
  return page;
}

const state = (page) => page.evaluate(() => {
  const a = WALLY.ctx.audio;
  let dbg = null; try { dbg = WALLY.debug.audioState(); } catch {}
  const boot = document.getElementById('boot');
  return {
    running: !!a?.running, unlocked: !!a?.unlocked, notes: (a?.notes || []).length,
    bar: a?.bar ?? null, ctx: a?.context ?? null, bpm: dbg?.bpm ?? null,
    rawState: dbg?.state ?? null, refused: window.__REFUSED__ || 0,
    bootVisible: !!boot && !boot.classList.contains('gone'),
    bootAsking: !!boot && boot.classList.contains('ask'),
    prompt: (document.getElementById('bootGo')?.textContent || '').trim(),
    started: (() => { try { return WALLY.debug.started(); } catch { return null; } })(),
  };
});

/* ---------------------------------------------------------- */
async function caseRun(label, { hostile = false, tapOn = 'boot', openPanel = false }) {
  console.log(`\n=== ${label} ===`);
  const ctxB = await browser.newContext(MOBILE);
  const page = await blockedPage(ctxB, { hostile });
  const errs = []; page.on('pageerror', e => errs.push(e.message.split('\n')[0]));
  await page.goto(URLBASE, { waitUntil: 'load', timeout: 90000 });
  await waitReady(page);
  await page.waitForTimeout(2500);
  const cdp = await ctxB.newCDPSession(page);
  const touch = mkTouch(cdp);

  if (openPanel) {
    // dismiss the start beat WITHOUT a gesture (programmatic), leaving the
    // game running and silent, then open a real UI panel over it.
    await page.evaluate(() => { try { WALLY.debug.begin(); } catch {} });
    await page.waitForTimeout(2500);
    const opened = await page.evaluate(() => { try { return WALLY.debug.ui('phone'); } catch (e) { return 'ERR ' + e.message; } });
    await page.waitForTimeout(1500);
    console.log('  panel opened ->', JSON.stringify(opened));
  }

  const pre = await state(page);
  console.log('  PRE :', JSON.stringify(pre));
  // ---- the precondition. Without these the pass is meaningless.
  ok(pre.running === false, 'PRECONDITION: the AudioContext is NOT running before any touch', pre.rawState || '');
  ok(pre.notes === 0, 'PRECONDITION: the scheduler has produced no notes', String(pre.notes));
  if (!openPanel) ok(pre.bootAsking === true, 'PRECONDITION: the boot screen is asking for the start beat', JSON.stringify(pre.prompt));

  // where does the tap land?
  let pt = { x: 195, y: 500 };
  if (openPanel) {
    const p = await page.evaluate(() => {
      const el = [...document.querySelectorAll('*')].filter(e => {
        const r = e.getBoundingClientRect();
        return r.width > 240 && r.height > 240 && /phone|panel|sheet|scrim|modal/i.test(typeof e.className === 'string' ? e.className : '');
      }).pop();
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { cls: (el.className + '').slice(0, 40), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 26) };
    });
    console.log('  panel box:', JSON.stringify(p));
    if (p) pt = { x: p.x, y: p.y };
  }
  const tgt = await page.evaluate(({ x, y }) => {
    const e = document.elementFromPoint(x, y);
    return e ? { tag: e.tagName, id: e.id, cls: (typeof e.className === 'string' ? e.className : '').slice(0, 40) } : null;
  }, pt);
  console.log('  tap point', JSON.stringify(pt), '-> element', JSON.stringify(tgt));
  ok(!!tgt && tgt.tag !== 'CANVAS', 'the tap lands on a DOM OVERLAY, not the canvas', JSON.stringify(tgt));

  await page.screenshot({ path: join(OUT, `audio-${label.replace(/\W+/g, '_')}-pre.png`) });

  // ---- the real touch
  await touch('touchStart', pt.x, pt.y);
  await page.waitForTimeout(150);
  await touch('touchEnd', pt.x, pt.y);
  await page.waitForTimeout(2500);

  const post = await state(page);
  console.log('  POST:', JSON.stringify(post));
  const acts = await page.evaluate(() => ({ acts: window.__ACT__.slice(0, 10), allowedAt: window.__ALLOWED_AT__ || null, ovl: window.__OVL__ || null }));
  console.log('  gestures:', JSON.stringify(acts.acts));
  if (acts.ovl) console.log('  overlay swallowed:', JSON.stringify(acts.ovl));

  ok(post.running === true, 'the AudioContext reaches RUNNING from a real touch on an overlay', post.rawState || '');
  ok(post.unlocked === true, 'the module considers itself unlocked');

  const n0 = post.notes;
  await page.waitForTimeout(3000);
  const later = await state(page);
  console.log('  +3 s:', JSON.stringify({ running: later.running, notes: later.notes, bar: later.bar, ctx: later.ctx, bpm: later.bpm }));
  ok(later.notes > 0, 'the music scheduler produced note events after the touch', `${n0} -> ${later.notes}`);
  ok(later.notes > n0 || later.bar > post.bar, 'the transport keeps scheduling (it is not one frozen bar)', `notes ${n0}->${later.notes}, bar ${post.bar}->${later.bar}`);
  const sample = await page.evaluate(() => (WALLY.ctx.audio.notes || []).slice(-5));
  console.log('  last note events:', JSON.stringify(sample));
  ok(errs.length === 0, 'no page errors', JSON.stringify([...new Set(errs)].slice(0, 3)));
  await page.screenshot({ path: join(OUT, `audio-${label.replace(/\W+/g, '_')}-post.png`) });
  await ctxB.close();
}

await caseRun('C1 loading screen overlay', {});
await caseRun('C2 hostile overlay preventDefault', { hostile: true });
await caseRun('C3 in-game UI panel', { openPanel: true });

/* C4 — the negative control. If the block is real, a touchSTART alone
   (no touchend) must NOT unlock, on the strict phone rule. This proves
   the harness is capable of failing. */
{
  console.log('\n=== C4 negative control: touchstart only, never released ===');
  const ctxB = await browser.newContext(MOBILE);
  const page = await blockedPage(ctxB, {});
  await page.goto(URLBASE, { waitUntil: 'load', timeout: 90000 });
  await waitReady(page); await page.waitForTimeout(2500);
  const cdp = await ctxB.newCDPSession(page);
  const touch = mkTouch(cdp);
  await touch('touchStart', 195, 500);
  await page.waitForTimeout(3000);
  const held = await state(page);
  console.log('  while held (no touchend):', JSON.stringify(held));
  ok(held.running === false, 'CONTROL: a touchstart with no release does NOT unlock (the harness can fail)', held.rawState || '');
  await touch('touchEnd', 195, 500);
  await page.waitForTimeout(2500);
  const rel = await state(page);
  console.log('  after touchend          :', JSON.stringify(rel));
  ok(rel.running === true, 'and the release DOES unlock it', rel.rawState || '');
  await ctxB.close();
}

await browser.close();
server.close();
console.log(`\n${fails === 0 ? 'ALL AUDIO CHECKS GREEN' : fails + ' AUDIO CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
