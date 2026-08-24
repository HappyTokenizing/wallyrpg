/* _fl3.mjs — why does the START BEAT never appear in the harness?
   Probes the audio gate the instant boot finishes.  --headed to use a
   real audio device, --nogesture to force the policy. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try {
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream', 'cache-control': 'no-store' });
    rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const args = ['--enable-unsafe-swiftshader', '--hide-scrollbars'];
if (!has('allowaudio')) args.push('--autoplay-policy=user-gesture-required');
const profile = await mkdtemp(join(tmpdir(), 'wally-audio-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', headless: !has('headed'), args, viewport: { width: 1280, height: 720 },
});
const page = context.pages()[0] || await context.newPage();
page.on('console', (m) => { const t = m.text(); if (/audio|Audio/.test(t)) console.log('  [console]', t.slice(0, 160)); });

await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 180000 });
await page.waitForTimeout(400);

const r = await page.evaluate(() => {
  const g = (f, d = 'ERR') => { try { const v = f(); return v === undefined ? null : v; } catch (e) { return d + ':' + e.message; } };
  const a = window.WALLY?.ctx?.audio;
  return {
    headless: navigator.webdriver,
    audioPresent: !!a,
    running: g(() => a.running),
    unavailable: g(() => a.unavailable),
    keys: a ? Object.keys(a).slice(0, 40) : null,
    probeCtxState: g(() => { const C = window.AudioContext || window.webkitAudioContext; const c = new C(); const s = c.state; c.close(); return s; }),
    bootClass: document.getElementById('boot')?.className,
    started: g(() => window.WALLY.debug.started()),
    introRunning: g(() => window.WALLY.ctx.intro.running),
  };
});
console.log(JSON.stringify(r, null, 2));
await context.close(); server.close();
