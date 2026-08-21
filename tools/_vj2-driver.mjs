#!/usr/bin/env node
/* _vj2-driver.mjs — live browser driver with an HTTP control port.
   Boots the game once, then accepts commands so the judge can poke it
   interactively.  POST /eval  body=<js>   (async fn body, returns JSON)
                  POST /shot?p=path
                  POST /key?k=KeyW&ms=500
                  POST /click?x=..&y=..    /move?x=..&y=..
                  GET  /logs   GET /ping   POST /quit
*/
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml', '.glsl':'text/plain', '.wasm':'application/wasm' };
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

const W = +(process.env.VJ_W || 1600), H = +(process.env.VJ_H || 900);
const QS = process.env.VJ_QS || '';
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-gpu-rasterization','--force-color-profile=srgb','--hide-scrollbars','--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`.slice(0, 400)));
page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}`.slice(0, 400)));

await page.goto(`http://127.0.0.1:${PORT}/index.html${QS}`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__ === true', { timeout: 60000 }).catch(() => logs.push('[warn] not ready'));

const CTL = +(process.env.VJ_PORT || 8977);
const ctl = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let body = '';
  for await (const c of req) body += c;
  const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  try {
    if (u.pathname === '/ping') return send({ ok: true, port: PORT });
    if (u.pathname === '/logs') return send({ logs: logs.slice(-Number(u.searchParams.get('n') || 60)) });
    if (u.pathname === '/clearlogs') { logs.length = 0; return send({ ok: true }); }
    if (u.pathname === '/eval') {
      const r = await page.evaluate(new Function('return (async()=>{' + body + '})()')).catch(e => ({ __err: String(e).slice(0, 900) }));
      return send({ r });
    }
    if (u.pathname === '/shot') {
      const p = resolve(ROOT, u.searchParams.get('p') || 'shots/_vj2.png');
      await mkdir(dirname(p), { recursive: true });
      await page.screenshot({ path: p, animations: 'allow', timeout: 25000 });
      return send({ ok: true, p });
    }
    if (u.pathname === '/key') {
      const k = u.searchParams.get('k'); const ms = +(u.searchParams.get('ms') || 0);
      if (ms > 0) { await page.keyboard.down(k); await page.waitForTimeout(ms); await page.keyboard.up(k); }
      else await page.keyboard.press(k);
      return send({ ok: true });
    }
    if (u.pathname === '/type') { await page.keyboard.type(u.searchParams.get('t') || '', { delay: 40 }); return send({ ok: true }); }
    if (u.pathname === '/click') { await page.mouse.click(+u.searchParams.get('x'), +u.searchParams.get('y')); return send({ ok: true }); }
    if (u.pathname === '/drag') {
      await page.mouse.move(+u.searchParams.get('x'), +u.searchParams.get('y'));
      await page.mouse.down();
      await page.mouse.move(+u.searchParams.get('x2'), +u.searchParams.get('y2'), { steps: 20 });
      await page.mouse.up();
      return send({ ok: true });
    }
    if (u.pathname === '/wait') { await page.waitForTimeout(+(u.searchParams.get('ms') || 500)); return send({ ok: true }); }
    if (u.pathname === '/reload') { await page.goto(`http://127.0.0.1:${PORT}/index.html${u.searchParams.get('qs')||''}`, { waitUntil: 'load', timeout: 60000 }); await page.waitForFunction('window.__WALLY_READY__ === true', { timeout: 60000 }).catch(()=>{}); return send({ ok: true }); }
    if (u.pathname === '/quit') { send({ ok: true }); await browser.close(); fileServer.close(); process.exit(0); }
    res.writeHead(404).end('nf');
  } catch (e) { send({ __err: String(e).slice(0, 900) }); }
});
ctl.listen(CTL, '127.0.0.1', () => console.log('driver ready on ' + CTL + ' game on ' + PORT));
