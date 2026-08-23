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

console.log('\n== A. the IDLE-74/75/76 shape, with the flag stamped at the MEASURED contact ==');
await page.evaluate(() => WALLY.debug.hideUI(true));
const door = await toDoor();
for (const [n, delay, hold] of [[74, 150, 630], [75, 300, 300], [76, 150, 630]]) {
  await page.evaluate(() => WALLY.ctx.ui.closeAll());
  const st = await goIdle(1.2);
  await probe();
  const P = n === 76 ? gearB : actP;
  await touch('touchStart', P.x, P.y); await wait(40); await touch('touchEnd', P.x, P.y);
  await wait(80);
  await touch('touchStart', P.x, P.y); await wait(40); await touch('touchEnd', P.x, P.y);  // wake
  await wait(delay);
  await touch('touchStart', P.x, P.y);
  await wait(hold);
  await touch('touchEnd', P.x, P.y);
  await wait(900);
  const L = await read();
  const pn = await panels();
  const downs = L.ev.filter(e => e.type === 'pointerdown');
  const measured = downs[downs.length - 1];
  const first = downs[0];
  const clicks = L.ev.filter(e => e.type === 'click');
  console.log(`  IDLE-${n} shape (delay ${delay}, hold ${hold}): hidden ${st.hidden}`);
  console.log(`    first pointerdown live=${first?.live}   <- what the suite's pr.down reads`);
  console.log(`    MEASURED pointerdown live=${measured?.live}  target ${measured?.target}`);
  console.log(`    clicks: ${JSON.stringify(clicks.map(c => ({ t: c.target, d: c.detail, inPad: c.inPad })))}`);
  ok(measured && measured.live === false,
    `A${n} the MEASURED contact really did land while live===false`, `live ${measured?.live}`);
  ok((n === 76 ? L.sc : L.act) === 0 && pn.length === 0,
    `A${n} ...and it pressed nothing`, `act ${L.act} sc ${L.sc}, panels ${JSON.stringify(pn)}`);
}

console.log('\n== B. detail-0 at a door, with the refusal printed ==');
await page.evaluate(() => WALLY.debug.hideUI(false));
await idleSet(null);
await wait(600);
for (let i = 0; i < 3; i++) {
  const d = await toDoor();
  await page.evaluate(() => WALLY.ctx.ui.closeAll());
  await wait(500);
  await probe();
  const f = await page.evaluate(() => { const b = document.querySelector('.w-abtn.act'); b.focus(); return document.activeElement === b; });
  await page.keyboard.press('Enter');
  await wait(1000);
  const L = await read(); const pn = await panels();
  console.log(`  run ${i}: near ${JSON.stringify(d)}, focused ${f}, act ${L.act}, panels ${JSON.stringify(pn)}, toasts ${JSON.stringify(L.toasts)}`);
  ok(L.act === 1, `B${i} the detail-0 activation entered the handler`, `act ${L.act}`);
  await page.evaluate(() => WALLY.ctx.ui.closeAll());
  await wait(600);
}

console.log(`\n${fails ? 'FAIL' : 'PASS'} — ${fails} failing`);
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
