/* GESTURE BREAKER ROUND FOUR — my own harness.
   Everything is driven with Input.dispatchTouchEvent / dispatchMouseEvent /
   dispatchKeyEvent at 390x844 with hasTouch + isMobile. Nothing is
   concluded from reading source, and every window is measured in the
   PAGE's own event clock (e.timeStamp) rather than in harness wall time,
   because harness wall time carries dispatch latency. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

export const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

export async function serve() {
  const server = createServer(async (rq, rs) => {
    const c = decodeURIComponent((rq.url || '/').split('?')[0]);
    try {
      const p = join(ROOT, c === '/' ? 'index.html' : c);
      if (!p.startsWith(ROOT)) { rs.writeHead(403).end(); return; }
      const b = await readFile(p);
      rs.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
      rs.end(b);
    } catch { rs.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

export function reporter() {
  let fails = 0; const rows = [];
  const ok = (c, m, x = '') => {
    if (!c) fails++;
    rows.push([!!c, m]);
    console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${x ? '   ' + x : ''}`);
    return !!c;
  };
  const note = (m) => console.log('      ' + m);
  return { ok, note, get fails() { return fails; }, rows };
}

export async function boot(opts = {}) {
  const { server, port } = await serve();
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio'],
  });
  const ctxo = await browser.newContext({
    viewport: opts.viewport || { width: 390, height: 844 },
    hasTouch: opts.hasTouch !== false,
    isMobile: opts.isMobile !== false,
    deviceScaleFactor: 1,
  });
  const page = await ctxo.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message.split('\n')[0]));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
  await page.goto(`http://127.0.0.1:${port}/index.html${opts.query || '?skipIntro'}`, { waitUntil: 'load', timeout: 120000 });
  page.setDefaultTimeout(120000);
  await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 120000 });
  await page.waitForTimeout(opts.settle ?? 3500);
  const cdp = await ctxo.newCDPSession(page);
  const close = async () => { await browser.close(); server.close(); };
  return { server, port, browser, ctxo, page, cdp, errs, close };
}

/* ---------------- the in-page instrument ----------------
   window capture sees every event before touch.js's document-capture
   listeners; a document bubble listener sees what survived. Verb
   counters are wrapped on ui itself, so they count what the PAD's
   handler actually ran, not what a listener merely received. */
export async function instrument(page) {
  await page.evaluate(() => {
    const desc = (t) => {
      if (!t) return 'null';
      if (t === document) return 'document';
      if (t === window) return 'window';
      if (!t.tagName) return String(t);
      const cn = typeof t.className === 'string' ? t.className.trim().split(/\s+/).filter(Boolean).join('.') : '';
      return t.tagName.toLowerCase() + (t.id ? '#' + t.id : '') + (cn ? '.' + cn : '');
    };
    window.__desc = desc;
    const G = window.__G = {
      on: false, log: [], bub: [], verbs: [], vy: -9, ymax: -1e9,
      elHits: [],           // clicks that actually reached a pad button
    };
    const idle = () => { try { return WALLY.debug.idle(); } catch (e) { return {}; } };
    window.__idleSnap = () => { const i = idle(); return { hid: i.hidden, live: i.live, wk: i.wakes, cand: i.cand, pend: i.pending, why: i.why }; };

    for (const ty of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel',
      'click', 'touchstart', 'touchend', 'touchcancel', 'keydown', 'keyup',
      'mousedown', 'mouseup', 'lostpointercapture']) {
      addEventListener(ty, (e) => {
        if (!G.on) return;
        if (ty === 'pointermove' && G.log.length > 500) return;
        G.log.push({
          ty, id: e.pointerId, x: Math.round(e.clientX || 0), y: Math.round(e.clientY || 0),
          tgt: desc(e.target), detail: e.detail, ts: Math.round(e.timeStamp),
          now: Math.round(performance.now()), ...window.__idleSnap(),
        });
      }, true);
      document.addEventListener(ty, (e) => {
        if (!G.on) return;
        if (ty === 'pointermove') return;
        G.bub.push({ ty, tgt: desc(e.target), detail: e.detail, dp: e.defaultPrevented });
      }, false);
    }

    /* VERB COUNTERS — the pad's own handler entries. Every bindPress verb
       is `ui.click(); <verb>()`, so ui.click counts pad presses and the
       named verbs say which button. */
    const ui = WALLY.ctx.ui;
    const wrap = (name, tag) => {
      const raw = ui[name] && ui[name].bind(ui);
      if (!raw) return;
      Object.defineProperty(ui, name, {
        configurable: true,
        value: (...a) => { if (G.on) G.verbs.push({ v: tag || name, a: a.map(x => (typeof x === 'string' ? x : typeof x)), t: Math.round(performance.now()) }); return raw(...a); },
      });
    };
    wrap('click', 'padpress'); wrap('interact'); wrap('openPhone'); wrap('openDesk'); wrap('show');

    /* did the DOM click actually reach a pad button? bubble listener,
       registered after touch.js's, so it sees what touch.js saw */
    const bindHit = () => {
      for (const b of document.querySelectorAll('.w-acts .w-abtn')) {
        if (b.__gb4) continue; b.__gb4 = 1;
        b.addEventListener('click', (e) => {
          if (!G.on) return;
          G.elHits.push({ btn: (b.getAttribute('aria-label') || '?'), detail: e.detail, dp: e.defaultPrevented });
        }, false);
      }
    };
    bindHit(); window.__bindHit = bindHit;

    const loop = () => {
      const c = WALLY.ctx.wally && WALLY.ctx.wally.controller;
      const v = c && (c.velocity || c.vel);
      if (v) G.vy = Math.max(G.vy, v.y);
      const p = WALLY.ctx.wally && WALLY.ctx.wally.position;
      if (p) G.ymax = Math.max(G.ymax, p.y);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}

export const arm = (page) => page.evaluate(() => {
  const G = window.__G; G.on = true; G.log = []; G.bub = []; G.verbs = []; G.elHits = [];
  G.vy = -9; G.ymax = -1e9;
  window.__bindHit();
  G.pos0 = (() => { const p = WALLY.ctx.wally.position; return [p.x, p.y, p.z]; })();
  G.panels0 = WALLY.ctx.ui.panels.slice();
});
export const stop = (page) => page.evaluate(() => {
  const G = window.__G; G.on = false;
  const p = WALLY.ctx.wally.position;
  return {
    log: G.log, bub: G.bub, verbs: G.verbs, elHits: G.elHits, vy: G.vy, ymax: G.ymax,
    panels0: G.panels0, panels: WALLY.ctx.ui.panels.slice(),
    moved: +Math.hypot(p.x - G.pos0[0], p.z - G.pos0[2]).toFixed(3),
    dy: +(p.y - G.pos0[1]).toFixed(3),
    idle: window.__idleSnap(),
  };
});

export const count = (r, v) => r.verbs.filter((e) => e.v === v).length;
export const verbList = (r) => r.verbs.map((e) => e.v + (e.a && e.a.length && typeof e.a[0] === 'string' ? ':' + e.a[0] : '')).join(',');

/* ---------------- geometry ---------------- */
export const padGeom = (page) => page.evaluate(() => {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return {
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
      op: +(+cs.opacity).toFixed(3), vis: cs.visibility, disp: cs.display, pe: cs.pointerEvents,
      hit: cs.visibility === 'visible' && cs.display !== 'none' && +cs.opacity > 0.02 && r.width > 0,
    };
  };
  const byLabel = (l) => box([...document.querySelectorAll('.w-acts .w-abtn')].find((b) => b.getAttribute('aria-label') === l));
  /* THE HONEST QUESTION about the whole layer: the root is what carries
     `hidden` (display:none) and `.w-idlehide`, and a button's own computed
     display/opacity says nothing about either. */
  const rootEl = document.querySelector('.w-touch');
  const actEl = document.querySelector('.w-abtn.act');
  const ar = actEl ? actEl.getBoundingClientRect() : null;
  const rootState = rootEl ? {
    cls: rootEl.className, disp: getComputedStyle(rootEl).display,
    laidOut: !!(ar && ar.width > 0),
    underAct: ar && ar.width ? (window.__desc||String)(document.elementFromPoint(ar.left + ar.width / 2, ar.top + ar.height / 2)) : null,
  } : null;
  return {
    root: rootState,
    act: box(document.querySelector('.w-abtn.act')),
    jump: box(document.querySelector('.w-abtn.jump')),
    phone: byLabel('Phone'), places: byLabel('Places'), desk: byLabel('Desk'), menu: byLabel('Menu'),
    zone: box(document.querySelector('.w-stickzone')),
    stick: box(document.querySelector('.w-stick')),
    acts: box(document.querySelector('.w-acts')),
    seam: box(document.querySelector('.w-idleseam')),
    idle: WALLY.debug.idle(),
    near: !!WALLY.ctx.ui.near, panels: WALLY.ctx.ui.panels.slice(),
  };
});

/* ---------------- touch, with the semantics MEASURED, not assumed ------
   I first wrote up() as "send the remaining active set" and p2 caught it
   red-handed: with a thumb on the stick and a thumb on Enter, a touchEnd
   carrying the stick point released THE STICK. So for this Chrome,
   touchEnd's touchPoints are the points being RELEASED (an empty list
   releases everything), while touchStart/touchMove take the full active
   set. Every multi-finger claim below is dispatched on that model and
   re-read out of the page's own pointerId stream. */
export function hand(cdp, page) {
  const pts = new Map();
  const arr = () => [...pts.entries()].map(([id, p]) => ({ id, x: p.x, y: p.y, radiusX: 14, radiusY: 14, force: 1 }));
  const one = (id) => { const p = pts.get(id); return [{ id, x: p.x, y: p.y, radiusX: 14, radiusY: 14, force: 1 }]; };
  const send = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  const wait = (ms) => page.waitForTimeout(ms);
  return {
    pts,
    async down(id, x, y) { pts.set(id, { x, y }); await send('touchStart', arr()); },
    async move(id, x, y) { pts.set(id, { x, y }); await send('touchMove', arr()); },
    async up(id) { const p = one(id); pts.delete(id); await send('touchEnd', p); },
    async cancel() { pts.clear(); await send('touchCancel', []); },
    async tap(x, y, hold = 250, id = 1) { await this.down(id, x, y); await wait(hold); await this.up(id); },
    async drag(x, y, dx, dy, steps = 8, step = 26, id = 1) {
      await this.down(id, x, y); await wait(30);
      for (let i = 1; i <= steps; i++) { await this.move(id, x + dx * i / steps, y + dy * i / steps); await wait(step); }
      await this.up(id); await wait(80);
    },
    wait,
  };
}

/* real key events, which is how a keyboard / screen reader activates */
export async function keyPress(cdp, key = 'Enter') {
  const code = key === 'Enter' ? 'Enter' : 'Space';
  const vk = key === 'Enter' ? 13 : 32;
  const text = key === 'Enter' ? '\r' : ' ';
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: vk, key, code, text });
  await cdp.send('Input.dispatchKeyEvent', { type: 'char', text, key });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: vk, key, code });
}

/* THE APARTMENT DOOR, standing just outside it and facing it, with the
   clock at noon so the place is open — proved in p0b: one 250 ms tap on
   Enter here takes ui.panels [] -> ['place']. */
export async function toDoor(page, id = 'apartment') {
  const r = await page.evaluate((lid) => {
    const g = WALLY.ctx.game;
    const l = g.data.locationById[lid];
    g.state.time = 12 * 60; g.state.money = 5000; g.state.energy = 100;
    WALLY.ctx.ui.closeAll();
    const fx = Math.sin(l.yaw), fz = Math.cos(l.yaw);
    const out = l.size.d * 0.5 + 1.6;
    WALLY.ctx.wally.warpTo(l.world.x + fx * out, WALLY.ctx.wally.position.y + 0.4, l.world.z + fz * out, {});
    return { id: l.id, n: l.n };
  }, id);
  await page.waitForTimeout(1600);
  const near = await page.evaluate(() => !!WALLY.ctx.ui.near);
  return { ...r, near };
}

export async function toOpen(page, boot) {
  await page.evaluate((b) => { WALLY.ctx.ui.closeAll(); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {}); }, boot);
  await page.waitForTimeout(900);
}
