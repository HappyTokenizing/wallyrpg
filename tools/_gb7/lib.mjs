/* gesture-breaker round five — shared rig.
   Boots the real game the same way tools/touchtest.mjs does. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

export async function serve() {
  const server = createServer(async (rq, rs) => {
    const c = decodeURIComponent(rq.url.split('?')[0]);
    try {
      const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
      rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' });
      rs.end(b);
    } catch { rs.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

export const MASK = { left: 1, middle: 4, right: 2, back: 8, forward: 16 };
export const BTN_INDEX = { left: 0, middle: 1, right: 2, back: 3, forward: 4 };

export async function boot({ mobile = true, query = '?skipIntro', settle = 3500 } = {}) {
  const { server, port } = await serve();
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'],
  });
  const context = await browser.newContext(mobile
    ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 }
    : { viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  const errs = [];
  page.on('pageerror', e => { errs.push(e.message.split('\n')[0]); console.log('PAGEERROR', e.message.split('\n')[0]); });
  await page.goto(`http://127.0.0.1:${port}/index.html${query}`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 240000 });
  await page.waitForTimeout(settle);
  const cdp = await context.newCDPSession(page);

  const P = (x, y, id = 1) => [{ x, y, id, radiusX: 14, radiusY: 14, force: 1 }];
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : P(x, y),
  });
  const multi = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });

  const mouseAt = (type, x, y, button = 'none', buttons = 0, pointerType = 'mouse') =>
    cdp.send('Input.dispatchMouseEvent', {
      type, x, y, button, buttons, pointerType,
      clickCount: type === 'mouseMoved' ? 0 : 1,
      ...(pointerType === 'pen' ? { force: type === 'mouseReleased' ? 0 : 0.5 } : {}),
    });
  async function mousePress(x, y, button = 'left', hold = 60, pointerType = 'mouse') {
    await mouseAt('mouseMoved', x, y, 'none', 0, pointerType);
    await mouseAt('mousePressed', x, y, button, MASK[button], pointerType);
    await page.waitForTimeout(hold);
    await mouseAt('mouseReleased', x, y, button, 0, pointerType);
  }
  async function mouseDrag(x, y, dx, dy, button = 'left', steps = 5, pointerType = 'mouse') {
    await mouseAt('mouseMoved', x, y, 'none', 0, pointerType);
    await mouseAt('mousePressed', x, y, button, MASK[button], pointerType);
    for (let i = 1; i <= steps; i++) {
      await mouseAt('mouseMoved', x + dx * i / steps, y + dy * i / steps, button, MASK[button], pointerType);
      await page.waitForTimeout(25);
    }
    await mouseAt('mouseReleased', x + dx, y + dy, button, 0, pointerType);
  }
  async function press(x, y, hold = 60) {
    await touch('touchStart', x, y);
    await page.waitForTimeout(hold);
    await touch('touchEnd', x, y);
  }
  async function tapOnce(x, y, hold = 45) { await press(x, y, hold); }
  async function doubleTap(x, y, settleMs = 800) {
    await touch('touchStart', x, y); await touch('touchEnd', x, y);
    await touch('touchStart', x, y); await touch('touchEnd', x, y);
    await page.waitForTimeout(settleMs);
  }

  let fails = 0; const lines = [];
  const ok = (cond, msg, extra = '') => {
    if (!cond) fails++;
    const s = `${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '   ' + extra : ''}`;
    console.log(s); lines.push(s); return cond;
  };

  const close = async () => { await browser.close(); server.close(); };
  return { browser, context, page, cdp, touch, multi, mouseAt, mousePress, mouseDrag,
    press, tapOnce, doubleTap, ok, get fails() { return fails; }, errs, close, port };
}

/* ---- the pad ledger, lifted from tools/touchtest.mjs (padProbe/padRead) ---- */
export const padProbe = (page) => page.evaluate(() => {
  window.__pad = { ev: [], act: 0, sc: 0, card: 0, toasts: [], menus: [] };
  if (!window.__padOn) {
    window.__padOn = true;
    const desc = (t) => !t ? null : (t.id
      || (t.tagName.toLowerCase() + '.' + String(t.className?.baseVal ?? t.className ?? '').trim().split(/\s+/).join('.')));
    for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'click', 'auxclick']) {
      document.addEventListener(t, (e) => {
        let acts = null;
        if (e.type === 'pointerup') {
          const r = document.querySelector('.w-acts')?.getBoundingClientRect();
          acts = r ? [Math.round(r.width), Math.round(r.height)] : null;
        }
        window.__pad.ev.push({
          type: e.type, target: desc(e.target), detail: e.detail, button: e.button,
          ptype: e.pointerType, inPad: !!e.target.closest?.('.w-touch'),
          live: WALLY.debug.idle ? WALLY.debug.idle().live : null, acts,
          t: Math.round(e.timeStamp), id: e.pointerId,
          hidden: WALLY.debug.idle ? WALLY.debug.idle().hidden : null,
        });
      }, true);
    }
    document.addEventListener('contextmenu', (e) => {
      window.__pad.menus.push({ target: desc(e.target),
        inPad: !!e.target.closest?.('.w-touch'), prevented: e.defaultPrevented });
    }, false);
    const u = WALLY.ctx.ui;
    const oi = u.interact.bind(u);
    u.interact = (...a) => { window.__pad.act++; return oi(...a); };
    for (const k of ['openPhone', 'openDesk']) {
      const o = u[k].bind(u);
      u[k] = (...a) => { window.__pad.sc++; return o(...a); };
    }
    const osh = u.show.bind(u);
    u.show = (...a) => { window.__pad.sc++; return osh(...a); };
    const ot = u.toast.bind(u);
    u.toast = (...a) => { window.__pad.toasts.push(String(a[0])); return ot(...a); };
    document.addEventListener('click', (e) => { if (e.target.closest?.('.w-dlg')) window.__pad.card++; });
  }
  return true;
});

export const padRead = (page) => page.evaluate(() => {
  const L = window.__pad;
  const downs = L.ev.filter((e) => e.type === 'pointerdown');
  const ups = L.ev.filter((e) => e.type === 'pointerup');
  const clicks = L.ev.filter((e) => e.type === 'click');
  const slim = (e) => ({ target: e.target, inPad: e.inPad, detail: e.detail,
    button: e.button, ptype: e.ptype, live: e.live, acts: e.acts });
  const slimT = (e) => ({ type: e.type, target: e.target, inPad: e.inPad, detail: e.detail,
    button: e.button, ptype: e.ptype, live: e.live, hidden: e.hidden, t: e.t, id: e.id });
  return { all: L.ev.map(slimT),
    act: L.act, sc: L.sc, card: L.card, toasts: L.toasts, menus: L.menus,
    down: downs[downs.length - 1], up: ups[ups.length - 1], click: clicks[clicks.length - 1],
    downs: downs.map(slim), ups: ups.map(slim), clicks: clicks.map(slim),
    aux: L.ev.filter((e) => e.type === 'auxclick').map(slim),
    nDown: downs.length, n: L.ev.length };
});

export const panelsNow = (page) => page.evaluate(() => WALLY.ctx.ui.panels.slice());
export const nearId = (page) => page.evaluate(() => {
  const n = WALLY.ctx.ui.near; return n ? (n.id || n.key || String(n)) : null;
});

export async function boxes(page) {
  return page.evaluate(() => {
    const c = (sel) => { const e = document.querySelector(sel); if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) }; };
    const sc = [...document.querySelectorAll('.w-acts .shortcuts .w-abtn')].map((b) => {
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: b.getAttribute('aria-label') };
    });
    return { act: c('.w-abtn.act'), jump: c('.w-abtn.jump'), stick: c('.w-stick'), sc };
  });
}

export const clsDown = (page, sel) => page.evaluate((s) =>
  document.querySelector(s)?.classList.contains('down') ?? null, sel);

/* ---------------- round-seven additions ---------------- */

/** Raw mouse/pen dispatch with an explicit buttons mask, so chorded
    sequences can be driven honestly (Chrome derives `buttons` from what
    we send; it does not track state for us). */
export function rawMouse(cdp) {
  return (type, x, y, button = 'none', buttons = 0, pointerType = 'mouse', extra = {}) =>
    cdp.send('Input.dispatchMouseEvent', {
      type, x, y, button, buttons, pointerType,
      clickCount: type === 'mouseMoved' ? 0 : 1, ...extra,
    });
}

/** Same ledger as padProbe but also records `buttons`, pointerId and
    whether the pad thinks a control is armed at that instant. */
export const padProbe2 = (page) => page.evaluate(() => {
  window.__pad = { ev: [], act: 0, sc: 0, card: 0, toasts: [], menus: [] };
  if (!window.__padOn) {
    window.__padOn = true;
    const desc = (t) => !t ? null : (t.id
      || (t.tagName.toLowerCase() + '.' + String(t.className?.baseVal ?? t.className ?? '').trim().split(/\s+/).join('.')));
    for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'pointermove', 'click', 'auxclick']) {
      document.addEventListener(t, (e) => {
        if (e.type === 'pointermove') return;      // too noisy to keep, but proves delivery
        window.__pad.ev.push({
          type: e.type, target: desc(e.target), detail: e.detail, button: e.button,
          buttons: e.buttons, ptype: e.pointerType,
          inPad: !!e.target.closest?.('.w-touch'),
          live: WALLY.debug.idle ? WALLY.debug.idle().live : null,
          t: Math.round(e.timeStamp), id: e.pointerId,
        });
      }, true);
    }
    document.addEventListener('contextmenu', (e) => {
      window.__pad.menus.push({ target: desc(e.target),
        inPad: !!e.target.closest?.('.w-touch'), prevented: e.defaultPrevented });
    }, false);
    const u = WALLY.ctx.ui;
    const oi = u.interact.bind(u);
    u.interact = (...a) => { window.__pad.act++; return oi(...a); };
    for (const k of ['openPhone', 'openDesk']) {
      const o = u[k].bind(u);
      u[k] = (...a) => { window.__pad.sc++; return o(...a); };
    }
    const osh = u.show.bind(u);
    u.show = (...a) => { window.__pad.sc++; return osh(...a); };
    const ot = u.toast.bind(u);
    u.toast = (...a) => { window.__pad.toasts.push(String(a[0])); return ot(...a); };
    document.addEventListener('click', (e) => { if (e.target.closest?.('.w-dlg')) window.__pad.card++; });
  }
  return true;
});

/** Everything the pad exposes about its own arming, in one shot. */
export const padState = (page) => page.evaluate(() => {
  const s = WALLY.debug.touchState();
  const st = document.querySelector('.w-stick');
  const q = (sel) => { const e = document.querySelector(sel); return e ? {
    down: e.classList.contains('down'), op: +(+getComputedStyle(e).opacity).toFixed(2) } : null; };
  return {
    ...s,
    stickLive: st ? st.classList.contains('live') : null,
    stickRun: st ? st.classList.contains('run') : null,
    act: q('.w-abtn.act'), jump: q('.w-abtn.jump'),
    shortcuts: [...document.querySelectorAll('.w-acts .shortcuts .w-abtn')]
      .map((b) => ({ label: b.getAttribute('aria-label'), down: b.classList.contains('down') })),
    panels: WALLY.ctx.ui.panels.slice(),
    focus: document.activeElement ? (document.activeElement.getAttribute?.('aria-label')
      || document.activeElement.tagName + '.' + String(document.activeElement.className || '')) : null,
    why: WALLY.debug.interact(),
  };
});

/** Ask the physics/controller whether the elephant is actually walking. */
export const walkSpeed = (page) => page.evaluate(() => {
  const c = WALLY.ctx.wally?.controller;
  const v = c && (c.velocity || c.vel);
  return v ? +Math.hypot(v.x, v.z).toFixed(3) : null;
});
export const vy = (page) => page.evaluate(() => {
  const c = WALLY.ctx.wally?.controller;
  const v = c && (c.velocity || c.vel);
  return v ? +v.y.toFixed(3) : null;
});
