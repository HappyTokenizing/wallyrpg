#!/usr/bin/env node
/* Split wally.lateUpdate into its parts by counting renderer draw calls and
   timing over a long window with a high-precision accumulator. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const ROOT = '/Users/herwig/Desktop/Claude files/wally-rpg';
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.glsl':'text/plain','.wasm':'application/wasm' };
const server = createServer(async (req,res)=>{ try{ const c=decodeURIComponent(req.url.split('?')[0]); const p=join(ROOT,c==='/'?'index.html':c); if(!p.startsWith(ROOT)){res.writeHead(403).end();return;} const b=await readFile(p); res.writeHead(200,{'content-type':MIME[extname(p)]||'application/octet-stream','cache-control':'no-store'}); res.end(b);}catch{res.writeHead(404).end();} });
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const PORT = server.address().port;
const browser = await chromium.launch({ channel:'chrome', args:['--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-gpu-rasterization','--force-color-profile=srgb','--hide-scrollbars','--mute-audio'] });
const page = await browser.newPage({ viewport:{width:1600,height:900} });
await page.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil:'load', timeout:60000 });
await page.waitForFunction('window.__WALLY_READY__ === true', { timeout:45000 }).catch(()=>{});
await page.waitForTimeout(9000);
const out = await page.evaluate(async () => {
  const ctx = window.WALLY.ctx;
  const w = ctx.wally;
  const orig = w.lateUpdate.bind(w);
  let tot = 0, n = 0, callsBefore = 0, callsDelta = 0;
  const R = ctx.renderer;
  w.lateUpdate = (...a) => {
    const c0 = R.info.render.calls;
    const t = performance.now();
    try { return orig(...a); }
    finally { tot += performance.now() - t; n++; callsDelta += R.info.render.calls - c0; }
  };
  // A/B: with the ground shadow off
  await new Promise(r=>{let k=0;const t=()=>{if(++k>=200)return r();requestAnimationFrame(t);};requestAnimationFrame(t);});
  const on = { ms: tot/n, n, calls: callsDelta/n };
  tot=0;n=0;callsDelta=0;
  window.WALLY.debug.wallyContact(false);
  await new Promise(r=>{let k=0;const t=()=>{if(++k>=200)return r();requestAnimationFrame(t);};requestAnimationFrame(t);});
  const off = { ms: tot/n, n, calls: callsDelta/n };
  window.WALLY.debug.wallyContact(true);
  delete w.lateUpdate;
  return { on, off };
});
await browser.close(); server.close();
console.log('wally.lateUpdate  shadow ON :', out.on.ms.toFixed(3), 'ms  extra draw calls/frame', out.on.calls.toFixed(2), ` n=${out.on.n}`);
console.log('wally.lateUpdate  shadow OFF:', out.off.ms.toFixed(3), 'ms  extra draw calls/frame', out.off.calls.toFixed(2), ` n=${out.off.n}`);
