#!/usr/bin/env node
/* _verify-driver.mjs — verification driver with an HTTP control port.
   Same idea as _vj2-driver.mjs plus touch/CDP input and perf probes.
     POST /eval  body=<js async fn body>   -> JSON
     POST /shot?p=path[&full=1]
     POST /key?k=KeyW&ms=500     POST /click?x&y   POST /move?x&y
     POST /touch?t=start|move|end&x&y
     POST /viewport?w&h[&touch=1]
     POST /reload?qs=...
     GET  /logs  GET /ping  POST /quit
*/
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml', '.glsl':'text/plain', '.wasm':'application/wasm', '.webp':'image/webp' };
const fileServer = createServer(async (req, res) => {
  try {
    const clean = decodeURIComponent(req.url.split('?')[0]);
    const p = join(ROOT, clean === '/' ? 'index.html' : clean);
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404).end('nf'); }
});
await new Promise(r => fileServer.listen(0, '127.0.0.1', r));
const PORT = fileServer.address().port;

let W = +(process.env.VJ_W || 1400), H = +(process.env.VJ_H || 900);
const QS = process.env.VJ_QS || '';
const TOUCH = process.env.VJ_TOUCH === '1';

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-gpu-rasterization','--force-color-profile=srgb','--hide-scrollbars','--autoplay-policy=no-user-gesture-required'],
});
let ctxB = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, hasTouch: TOUCH, isMobile: false });
let page = await ctxB.newPage();
let cdp = await ctxB.newCDPSession(page);
const logs = [];
const wire = (p) => {
  p.on('console', m => logs.push(`[${m.type()}] ${m.text()}`.slice(0, 500)));
  p.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}`.slice(0, 500)));
  p.on('crash', () => logs.push('[CRASH] page crashed'));
};
wire(page);

async function boot(qs) {
  await page.goto(`http://127.0.0.1:${PORT}/index.html${qs ?? QS}`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction('window.__WALLY_READY__ === true', null, { timeout: 90000 }).catch(() => logs.push('[warn] not ready'));
}
await boot();

const CTL = +(process.env.VJ_PORT || 8990);
const ctl = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let body = '';
  for await (const c of req) body += c;
  const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  try {
    if (u.pathname === '/ping') return send({ ok: true, port: PORT, w: W, h: H, closed: page.isClosed() });
    if (u.pathname === '/logs') { const n = Number(u.searchParams.get('n') || 60); return send({ logs: logs.slice(-n) }); }
    if (u.pathname === '/clearlogs') { logs.length = 0; return send({ ok: true }); }
    if (u.pathname === '/eval') {
      const r = await page.evaluate(new Function('return (async()=>{' + body + '})()')).catch(e => ({ __err: String(e).slice(0, 1200) }));
      return send({ r });
    }
    if (u.pathname === '/shot') {
      const p = resolve(ROOT, u.searchParams.get('p') || 'shots/_vfy.png');
      await mkdir(dirname(p), { recursive: true });
      await page.screenshot({ path: p, animations: 'allow', timeout: 30000, fullPage: u.searchParams.get('full') === '1' });
      return send({ ok: true, p });
    }
    if (u.pathname === '/key') {
      const k = u.searchParams.get('k'); const ms = +(u.searchParams.get('ms') || 0);
      if (ms > 0) { await page.keyboard.down(k); await page.waitForTimeout(ms); await page.keyboard.up(k); }
      else await page.keyboard.press(k);
      return send({ ok: true });
    }
    if (u.pathname === '/keydown') { await page.keyboard.down(u.searchParams.get('k')); return send({ ok: true }); }
    if (u.pathname === '/keyup') { await page.keyboard.up(u.searchParams.get('k')); return send({ ok: true }); }
    if (u.pathname === '/click') { await page.mouse.click(+u.searchParams.get('x'), +u.searchParams.get('y')); return send({ ok: true }); }
    if (u.pathname === '/move') { await page.mouse.move(+u.searchParams.get('x'), +u.searchParams.get('y')); return send({ ok: true }); }
    if (u.pathname === '/touch') {
      const t = u.searchParams.get('t'), x = +u.searchParams.get('x'), y = +u.searchParams.get('y');
      const type = t === 'start' ? 'touchStart' : t === 'move' ? 'touchMove' : 'touchEnd';
      await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 12, radiusY: 12, force: 1 }] });
      return send({ ok: true });
    }
    if (u.pathname === '/viewport') {
      W = +u.searchParams.get('w'); H = +u.searchParams.get('h');
      const wantTouch = u.searchParams.get('touch') === '1';
      const mob = u.searchParams.get('mobile') === '1';
      // new context so hasTouch/isMobile can change
      await ctxB.close();
      ctxB = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, hasTouch: wantTouch, isMobile: mob,
        ...(mob ? { userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36' } : {}) });
      page = await ctxB.newPage(); wire(page); cdp = await ctxB.newCDPSession(page);
      await boot(u.searchParams.get('qs') ?? undefined);
      return send({ ok: true, w: W, h: H, touch: wantTouch, mobile: mob });
    }
    if (u.pathname === '/wait') { await page.waitForTimeout(+(u.searchParams.get('ms') || 500)); return send({ ok: true }); }
    /* A TRUE MID-RUN RESIZE — same context, same page, no reload, so the
       page sees exactly the resize/orientationchange burst a phone
       rotation delivers. /viewport rebuilds the context and reboots,
       which by construction cannot test that path. */
    if (u.pathname === '/resize') {
      W = +u.searchParams.get('w'); H = +u.searchParams.get('h');
      await page.setViewportSize({ width: W, height: H });
      return send({ ok: true, w: W, h: H });
    }
    if (u.pathname === '/reload') { await boot(u.searchParams.get('qs') ?? undefined); return send({ ok: true }); }
    if (u.pathname === '/quit') { send({ ok: true }); await browser.close(); fileServer.close(); process.exit(0); }
    res.writeHead(404).end('nf');
  } catch (e) { send({ __err: String(e).slice(0, 1200) }); }
});
ctl.listen(CTL, '127.0.0.1', () => console.log('driver ready ctl=' + CTL + ' game=' + PORT));
process.on('SIGHUP', () => {});
