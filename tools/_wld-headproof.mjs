#!/usr/bin/env node
/* scratch: serve the working tree but with src/world/*.js taken from
   HEAD, then run the awkward-surface discs at both rasters. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const HEAD_FILES = process.argv.slice(3);
const overrides = new Map();
for (const f of HEAD_FILES) overrides.set('/' + f, execSync(`git show HEAD:${f}`, { cwd: ROOT, maxBuffer: 1 << 28 }));
const src = await readFile(process.argv[2], 'utf8');
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  if (overrides.has(c)) { rs.writeHead(200, { 'content-type': MIME['.js'] }); rs.end(overrides.get(c)); return; }
  try {
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' });
    rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(4000);
const out = await page.evaluate(`(async () => { ${src} })()`);
console.log(JSON.stringify(out, null, 1));
await browser.close(); server.close();
