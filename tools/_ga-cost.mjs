#!/usr/bin/env node
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
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(4000);
console.log(JSON.stringify(await page.evaluate(() => {
  const c = window.WALLY.ctx;
  let fenceTris = 0, fenceInst = 0, fenceMesh = 0;
  c.scene.getObjectByName('city.propsRoot').traverse((o) => {
    if (!o.isInstancedMesh || !/^prop\.fence\./.test(o.name || '') || /\.outline$/.test(o.name)) return;
    fenceMesh++; fenceInst += o.count;
    fenceTris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3 * o.count;
  });
  return { g: c.city.groundStats, fenceTris, fenceInst, fenceMesh, perf: window.__WALLY_PERF__ };
}), null, 1));
await browser.close(); server.close();
