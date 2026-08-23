/* _vjpad-verify2.mjs — the two follow-ups:
   A. IDLE-74/75/76 read the FIRST pointerdown in the ledger, which is
      the wake tap's, not the measured press's. Stamp the flag at the
      measured contact instead and see what it really was.
   B. the clean detail-0 activation at a door, with the toast printed,
      to separate "handler did not run" from "it ran and was refused". */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
let fails = 0;
const ok = (c, m, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${x ? '   ' + x : ''}`); return c; };

const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctxM.newPage();
page.on('pageerror', e => { console.log('PAGEERROR', e.message.split('\n')[0]); fails++; });
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 60000 });
await page.waitForTimeout(3500);
const cdp = await ctxM.newCDPSession(page);
const pt = (id, x, y) => ({ x, y, id, radiusX: 14, radiusY: 14, force: 1 });
const multi = (t, p) => cdp.send('Input.dispatchTouchEvent', { type: t, touchPoints: p });
const touch = (t, x, y) => multi(t, t === 'touchEnd' ? [] : [pt(1, x, y)]);
const wait = (ms) => page.waitForTimeout(ms);
const idleGet = () => page.evaluate(() => WALLY.debug.idle());
const idleSet = (s) => page.evaluate(v => WALLY.debug.idle(v), s);
const panels = () => page.evaluate(() => WALLY.ctx.ui.panels.slice());
const box = (s, k = 0) => page.evaluate(([q, i]) => { const b = document.querySelectorAll(q)[i]; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, [s, k]);
const actP = await box('.w-abtn.act');
const gearB = await box('.w-acts .shortcuts .w-abtn', 3);

const probe = () => page.evaluate(() => {
  window.__L = { ev: [], act: 0, sc: 0, toasts: [] };
  const u = WALLY.ctx.ui;
  if (!window.__on) {
    window.__on = true;
    const d = (t) => !t ? null : (t.tagName.toLowerCase() + '.' + String(t.className?.baseVal ?? t.className ?? '').trim().split(/\s+/).join('.'));
    for (const k of ['pointerdown', 'pointerup', 'click']) {
      document.addEventListener(k, (e) => window.__L.ev.push({ type: e.type, target: d(e.target), detail: e.detail,
        inPad: !!e.target.closest?.('.w-touch'), live: WALLY.debug.idle().live, t: Math.round(e.timeStamp) }), true);
    }
    const oi = u.interact.bind(u); u.interact = (...a) => { window.__L.act++; return oi(...a); };
    const os = u.show.bind(u); u.show = (...a) => { window.__L.sc++; return os(...a); };
    const ot = u.toast.bind(u); u.toast = (...a) => { window.__L.toasts.push(String(a[0])); return ot(...a); };
  }
  return true;
});
const read = () => page.evaluate(() => window.__L);
const toDoor = async () => { await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.arrive('apartment', true); }); await wait(1200);
  try { await page.waitForFunction(() => WALLY.ctx.ui.near != null, { timeout: 5000 }); } catch {} await wait(300);
  return page.evaluate(() => WALLY.ctx.ui.near?.id ?? WALLY.ctx.ui.near ?? null); };
const goIdle = async (d) => { await idleSet(d); await wait(d * 1000 + 1400); return idleGet(); };


console.log('\n== C. the two undriven bindPress branches ==');
await page.evaluate(() => WALLY.debug.hideUI(false));
await idleSet(null);
await wait(500);

/* C1 — a genuine pointercancel mid-press: `end` must refuse it */
let d = await toDoor();
await probe();
await touch('touchStart', actP.x, actP.y);
await wait(70);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
await wait(900);
let L = await read(); let pn = await panels();
ok(L.act === 0 && pn.length === 0, 'C1 a pointercancel mid-press on Enter presses nothing',
  `act ${L.act}, panels ${JSON.stringify(pn)}, ev ${JSON.stringify(L.ev.map(e => e.type + '->' + e.target))}`);

/* ...and the button is not left armed: a normal press right after works */
await probe();
await touch('touchStart', actP.x, actP.y); await wait(60); await touch('touchEnd', actP.x, actP.y);
await wait(900);
L = await read(); pn = await panels();
ok(L.act === 1 && pn.includes('place'), 'C2 ...and the cancelled button is not left armed — the next press still opens the door',
  `act ${L.act}, panels ${JSON.stringify(pn)}`);
await page.evaluate(() => WALLY.ctx.ui.closeAll());
await wait(700);

/* C3 — two contacts landing on the SAME button: one contact owns it */
d = await toDoor();
await probe();
await multi('touchStart', [pt(1, actP.x - 12, actP.y)]);
await wait(50);
await multi('touchStart', [pt(1, actP.x - 12, actP.y), pt(2, actP.x + 12, actP.y)]);
await wait(70);
await multi('touchEnd', [pt(2, actP.x + 12, actP.y)]);
await wait(70);
await multi('touchEnd', [pt(1, actP.x - 12, actP.y)]);
await wait(900);
L = await read(); pn = await panels();
ok(L.act === 1 && pn.includes('place'), 'C3 two thumbs on the same Enter fire it exactly ONCE',
  `act ${L.act}, panels ${JSON.stringify(pn)}`);

console.log(`\n${fails ? 'FAIL' : 'PASS'} — ${fails} failing`);
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
