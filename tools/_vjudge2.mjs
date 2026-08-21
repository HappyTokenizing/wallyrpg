#!/usr/bin/env node
/* VERIFY JUDGE part 2 — leg visual evidence + independent audio proof.
   Real mobile context throughout. */
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
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader'] });
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

/* ============================================================
   A. LEG VISUALS — the eyes test.
   The character is projected to screen so the crop actually lands on
   his legs rather than on grass.
   ============================================================ */
{
  console.log('\n############ A. LEG VISUALS (mobile 390) ############');
  const ctxB = await browser.newContext(MOBILE);
  const page = await ctxB.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message.split('\n')[0]));
  await page.goto(URLBASE + '?skipIntro=1', { waitUntil: 'load', timeout: 90000 });
  await waitReady(page); await page.waitForTimeout(3000);
  const cdp = await ctxB.newCDPSession(page);
  const touch = mkTouch(cdp);

  // pull the camera back a little so the legs are not filling the frame,
  // by dragging DOWN outside the stick zone (orbit pitch) — purely a camera move.
  const SX = 90, SY = 684;
  await touch('touchStart', SX, SY); await page.waitForTimeout(120);
  await touch('touchMove', SX, SY - 80);
  await page.waitForTimeout(2500);

  // where are his feet on screen?
  const proj = await page.evaluate(() => {
    const w = WALLY.ctx.wally, T = WALLY.THREE, cam = WALLY.ctx.camera?.camera || WALLY.ctx.camera;
    let footL = null; w.root.traverse(o => { if (!footL && /footL/i.test(o.name)) footL = o; });
    const p = new T.Vector3();
    (footL || w.root).getWorldPosition(p);
    p.project(cam);
    return { x: Math.round((p.x * 0.5 + 0.5) * innerWidth), y: Math.round((-p.y * 0.5 + 0.5) * innerHeight) };
  }).catch(e => ({ err: e.message }));
  console.log('foot on screen:', JSON.stringify(proj));

  const cx = Number.isFinite(proj.x) ? proj.x : 195;
  const cy = Number.isFinite(proj.y) ? proj.y : 700;
  const clip = {
    x: Math.max(0, Math.min(390 - 240, cx - 120)),
    y: Math.max(0, Math.min(844 - 220, cy - 170)),
    width: 240, height: 220,
  };
  console.log('crop:', JSON.stringify(clip));

  const bones = async () => page.evaluate(() => {
    const w = WALLY.ctx.wally; const o = {};
    w.root.traverse(b => { if (/^(legL0|legR0|footL|footR)$/.test(b.name)) o[b.name] = +b.rotation.x.toFixed(3); });
    o.speed = +(w.controller?.planarSpeed ?? 0).toFixed(2);
    return o;
  });

  const frames = [];
  for (let i = 0; i < 6; i++) {
    const b = await bones();
    const f = join(OUT, `walkstrip-${i}.png`);
    await page.screenshot({ path: f, clip });
    frames.push(b);
    await page.waitForTimeout(i === 2 ? 500 : 160);   // frame 3 is ~0.5 s after frame 2
  }
  console.log('bone rotations per frame:');
  frames.forEach((f, i) => console.log('  f' + i, JSON.stringify(f)));

  // two full screenshots exactly ~0.5 s apart, for the "look at it" test
  await page.screenshot({ path: join(OUT, 'walk-t0.png') });
  const b0 = await bones();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'walk-t500.png') });
  const b1 = await bones();
  console.log('t0  :', JSON.stringify(b0));
  console.log('t500:', JSON.stringify(b1));
  console.log('delta legL0:', (b1.legL0 - b0.legL0).toFixed(3), ' legR0:', (b1.legR0 - b0.legR0).toFixed(3));

  await touch('touchEnd', SX, SY - 80);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, 'walk-released.png'), clip });
  console.log('after release:', JSON.stringify(await bones()));

  console.log('page errors:', errs.length, JSON.stringify([...new Set(errs)].slice(0, 3)));
  await ctxB.close();
}

/* ============================================================
   B. AUDIO — independent proof on a real mobile context.
   Headless/headed Chrome will not actually block Web Audio for us, so
   the block is imposed on the page: a context that is born suspended
   and whose resume() only lands while navigator.userActivation.isActive
   is true. That gate is REAL browser activation, so only a genuine
   trusted gesture can pass it.
   Three sub-cases:
     B1 tap on the BOOT SCREEN overlay (the loading screen)
     B2 tap on a UI PANEL opened over the game
     B3 an overlay that preventDefault()s touchstart (kills the
        synthesised mouse events) — the reported real-world shape
   ============================================================ */
async function audioCase(label, { where, hostile }) {
  const ctxB = await browser.newContext(MOBILE);
  const page = await ctxB.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message.split('\n')[0]));

  await page.addInitScript(() => {
    /* --- honest autoplay block: gated on real user activation --- */
    const Native = window.AudioContext || window.webkitAudioContext;
    window.__GEST__ = [];
    for (const t of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'click', 'keydown']) {
      window.addEventListener(t, (e) => {
        window.__GEST__.push({ t, trusted: e.isTrusted, act: !!navigator.userActivation?.isActive, target: (e.target && (e.target.id || e.target.className || e.target.tagName)) + '' });
      }, { capture: true, passive: true });
    }
    class BlockedAudioContext extends Native {
      constructor(...a) {
        super(...a);
        this.__blocked = true;
        try { super.suspend(); } catch {}
      }
      resume() {
        // Only a page with LIVE user activation may resume. This is the
        // browser's own signal, not a rehearsal.
        if (!navigator.userActivation?.isActive) {
          window.__REFUSED__ = (window.__REFUSED__ || 0) + 1;
          return new Promise(() => {});      // exactly what a blocked context does
        }
        this.__blocked = false;
        return super.resume();
      }
    }
    window.AudioContext = BlockedAudioContext;
    window.webkitAudioContext = BlockedAudioContext;
  });

  if (hostile) {
    await page.addInitScript(() => {
      addEventListener('DOMContentLoaded', () => {
        const d = document.createElement('div');
        d.id = 'hostile';
        d.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.35)';
        d.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
        d.addEventListener('pointerdown', (e) => e.preventDefault(), { passive: false });
        document.body.appendChild(d);
      });
    });
  }

  await page.goto(URLBASE, { waitUntil: 'load', timeout: 90000 });
  await waitReady(page);
  await page.waitForTimeout(2500);

  const cdp = await ctxB.newCDPSession(page);
  const touch = mkTouch(cdp);

  const st = () => page.evaluate(() => {
    const a = WALLY.ctx.audio;
    let dbg = null; try { dbg = WALLY.debug.audioState(); } catch {}
    return {
      running: !!a?.running, suspended: !!a?.suspended, unlocked: !!a?.unlocked,
      notes: (a?.notes || []).length, bar: a?.bar ?? null, ctx: a?.context ?? null,
      refused: window.__REFUSED__ || 0, dbg,
      bootAsking: !!document.getElementById('boot') && !document.getElementById('boot').classList.contains('gone'),
    };
  });

  const before = await st();
  console.log(`\n--- ${label} ---`);
  console.log(' before tap:', JSON.stringify(before));

  // what is actually under the tap point?
  const tp = await page.evaluate(({ x, y }) => {
    const e = document.elementFromPoint(x, y);
    return e ? { tag: e.tagName, id: e.id, cls: (typeof e.className === 'string' ? e.className : '').slice(0, 50) } : null;
  }, where);
  console.log(' tap target:', JSON.stringify(tp), 'at', JSON.stringify(where));

  await touch('touchStart', where.x, where.y);
  await page.waitForTimeout(140);
  await touch('touchEnd', where.x, where.y);
  await page.waitForTimeout(2500);

  const after = await st();
  console.log(' after tap :', JSON.stringify(after));
  const gest = await page.evaluate(() => window.__GEST__.slice(0, 12));
  console.log(' gestures seen:', JSON.stringify(gest));

  // scheduler must keep producing notes
  await page.waitForTimeout(2500);
  const later = await st();
  console.log(' +2.5 s     :', JSON.stringify({ running: later.running, notes: later.notes, bar: later.bar, ctx: later.ctx }));
  const noteSample = await page.evaluate(() => (WALLY.ctx.audio.notes || []).slice(-6));
  console.log(' last note events:', JSON.stringify(noteSample));

  console.log(' page errors:', errs.length, JSON.stringify([...new Set(errs)].slice(0, 3)));
  const res = { label, before, after, later, gest, notes: noteSample.length, errs: errs.length };
  await ctxB.close();
  return res;
}

console.log('\n############ B. AUDIO ON A REAL MOBILE CONTEXT ############');
const A1 = await audioCase('B1 tap on the BOOT/loading overlay', { where: { x: 195, y: 500 } });
const A2 = await audioCase('B2 tap on a preventDefault() overlay (canvas-style)', { where: { x: 195, y: 420 }, hostile: true });

/* B3 — a UI PANEL. Open the game first with a keypress (desktop-style
   unlock is not available on a phone, so instead: first tap unlocks,
   then we SUSPEND the context by hand, open a panel, and prove a tap
   ON THE PANEL brings it back). */
{
  console.log('\n--- B3 tap on an in-game UI panel after the context was taken away ---');
  const ctxB = await browser.newContext(MOBILE);
  const page = await ctxB.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message.split('\n')[0]));
  await page.goto(URLBASE + '?skipIntro=1', { waitUntil: 'load', timeout: 90000 });
  await waitReady(page); await page.waitForTimeout(2500);
  const cdp = await ctxB.newCDPSession(page);
  const touch = mkTouch(cdp);
  await touch('touchStart', 195, 300); await page.waitForTimeout(120); await touch('touchEnd', 195, 300);
  await page.waitForTimeout(1500);
  console.log(' unlocked by first tap:', JSON.stringify(await page.evaluate(() => ({ running: WALLY.ctx.audio.running, unlocked: WALLY.ctx.audio.unlocked, notes: WALLY.ctx.audio.notes.length }))));

  // open a panel through the touch UI (the map button)
  const btn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button,[role=button]')].find(e => /map/i.test(e.title || e.getAttribute('aria-label') || ''));
    if (!b) return null; const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), title: b.title || b.getAttribute('aria-label') };
  });
  console.log(' map button:', JSON.stringify(btn));
  if (btn) {
    await touch('touchStart', btn.x, btn.y); await page.waitForTimeout(110); await touch('touchEnd', btn.x, btn.y);
    await page.waitForTimeout(1200);
  }
  const panel = await page.evaluate(() => {
    const p = [...document.querySelectorAll('[class*=panel],[class*=sheet],[class*=modal],.w-scrim')].find(e => e.getBoundingClientRect().width > 200);
    if (!p) return null; const r = p.getBoundingClientRect();
    return { cls: (p.className + '').slice(0, 40), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 40) };
  });
  console.log(' panel:', JSON.stringify(panel));
  // take the context away, as a phone call would
  await page.evaluate(async () => { try { await WALLY.debug.audioState; } catch {} });
  const dipped = await page.evaluate(async () => {
    // reach the raw context through a scheduled node? use the module's own
    // statechange path: suspend via the AudioContext instance behind api.
    const a = WALLY.ctx.audio;
    // there is no public handle; use visibility to make the browser do it
    return { note: 'suspending via CDP instead', running: a.running };
  });
  await cdp.send('Emulation.setPageVisibilityOverride', { visibility: 'hidden' }).catch(() => {});
  await page.waitForTimeout(2500);
  const hidden = await page.evaluate(() => ({ running: WALLY.ctx.audio.running, state: WALLY.debug.audioState?.().state }));
  console.log(' while hidden:', JSON.stringify(hidden));
  await cdp.send('Emulation.setPageVisibilityOverride', { visibility: 'visible' }).catch(() => {});
  await page.waitForTimeout(400);
  const t = panel || { x: 195, y: 300 };
  const target = await page.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return e ? (e.id || (e.className + '')).slice(0, 40) : null; }, t);
  console.log(' panel tap target:', JSON.stringify(target));
  const n0 = await page.evaluate(() => WALLY.ctx.audio.notes.length);
  await touch('touchStart', t.x, t.y); await page.waitForTimeout(120); await touch('touchEnd', t.x, t.y);
  await page.waitForTimeout(2500);
  const back = await page.evaluate(() => ({ running: WALLY.ctx.audio.running, notes: WALLY.ctx.audio.notes.length, state: WALLY.debug.audioState?.().state }));
  console.log(' after tapping the panel:', JSON.stringify({ notesBefore: n0, ...back }));
  console.log(' page errors:', errs.length, JSON.stringify([...new Set(errs)].slice(0, 3)));
  await page.screenshot({ path: join(OUT, 'panel-mobile.png') });
  await ctxB.close();
}

await browser.close();
server.close();
console.log('\nDONE');
