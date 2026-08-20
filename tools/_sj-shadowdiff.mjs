#!/usr/bin/env node
/* Differential shadow test: capture two consecutive frames, one with the
   ground shadow on and one with it off, and write on.png / off.png / diff.png.
   Consecutive frames means the grass wind has advanced ~1/80 s, so anything
   large in the diff is the shadow. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const ROOT = '/Users/herwig/Desktop/Claude files/wally-rpg';
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.glsl':'text/plain','.wasm':'application/wasm' };
const server = createServer(async (req,res)=>{ try{ const c=decodeURIComponent(req.url.split('?')[0]); const p=join(ROOT,c==='/'?'index.html':c); if(!p.startsWith(ROOT)){res.writeHead(403).end();return;} const b=await readFile(p); res.writeHead(200,{'content-type':MIME[extname(p)]||'application/octet-stream','cache-control':'no-store'}); res.end(b);}catch{res.writeHead(404).end();} });
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const PORT = server.address().port;

const browser = await chromium.launch({ channel:'chrome', args:['--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-gpu-rasterization','--force-color-profile=srgb','--hide-scrollbars','--mute-audio'] });
const page = await browser.newPage({ viewport:{width:1600,height:900}, deviceScaleFactor:1 });
await page.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil:'load', timeout:60000 });
await page.waitForFunction('window.__WALLY_READY__ === true', { timeout:45000 }).catch(()=>{});
await page.waitForTimeout(8000);

const shots = await page.evaluate(async () => {
  const cv = document.getElementById('gl');
  const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  // preserveDrawingBuffer is off, so grab inside the rAF right after render:
  const grab = () => new Promise(r => {
    const t = () => { requestAnimationFrame(() => r(cv.toDataURL('image/png'))); };
    requestAnimationFrame(t);
  });
  await raf();
  const on = await grab();
  window.WALLY.debug.wallyContact(false);
  await raf();
  const off = await grab();
  window.WALLY.debug.wallyContact(true);
  return { on, off };
});
await browser.close(); server.close();

for (const [k,v] of Object.entries(shots)) {
  await writeFile(`/tmp/shadow-${k}.png`, Buffer.from(v.split(',')[1], 'base64'));
  console.log(`/tmp/shadow-${k}.png`);
}
