#!/usr/bin/env node
/* ============================================================
   shot.mjs — headless screenshot harness for WALLY RPG.

   Boots a static server on a random free port, loads the game in
   headless Chrome with real WebGL2, waits for the renderer to
   signal readiness, optionally runs a scripted camera/state setup,
   and writes a PNG.

   Usage:
     node tools/shot.mjs out.png
     node tools/shot.mjs out.png --wait 4000
     node tools/shot.mjs out.png --scene city --w 1920 --h 1080
     node tools/shot.mjs out.png --eval "WALLY.debug.pose('welcome')"
     node tools/shot.mjs out.png --url ref/original-wally.html --wait 9000
     node tools/shot.mjs out.png --seq 0,2,4 --prefix shots/intro

   Flags:
     --w, --h      viewport size            (default 1600x900)
     --wait ms     extra settle time        (default 2500)
     --scene name  passes ?scene=name
     --url path    load something else (relative to project root)
     --eval js     run in page before the shot (after ready)
     --console     print browser console + page errors
     --dpr n       device pixel ratio       (default 1)
   ============================================================ */

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.glsl': 'text/plain', '.wasm': 'application/wasm',
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes(`--${name}`); }

const out = process.argv[2];
if (!out || out.startsWith('--')) {
  console.error('usage: node tools/shot.mjs <out.png> [flags]');
  process.exit(1);
}

const W = +arg('w', 1600), H = +arg('h', 900);
const WAIT = +arg('wait', 2500);
const DPR = +arg('dpr', 1);
const SCENE = arg('scene', null);
const URLPATH = arg('url', 'index.html');
const EVAL = arg('eval', null);

/* ---------- static server ---------- */
const server = createServer(async (req, res) => {
  try {
    const clean = decodeURIComponent(req.url.split('?')[0]);
    const path = join(ROOT, clean === '/' ? 'index.html' : clean);
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': MIME[extname(path)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

/* ---------- browser ---------- */
const browser = await chromium.launch({
  channel: 'chrome',
  args: [
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--force-color-profile=srgb',
    '--hide-scrollbars',
    '--mute-audio',
  ],
});

const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: DPR,
});

const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}\n${e.stack || ''}`));
page.on('requestfailed', r => {
  if (!/favicon\.ico/.test(r.url())) logs.push(`[404] ${r.url()}`);
});
page.on('response', r => {
  if (r.status() >= 400 && !/favicon\.ico/.test(r.url())) {
    logs.push(`[${r.status()}] ${r.url()}`);
  }
});

const qs = SCENE ? `?scene=${encodeURIComponent(SCENE)}&shot=1` : '?shot=1';
const url = `http://127.0.0.1:${PORT}/${URLPATH}${URLPATH.includes('?') ? '' : qs}`;

let failed = null;
try {
  await page.goto(url, { waitUntil: 'load', timeout: 45000 });

  // Wait for the game to declare itself ready (main.js sets window.__WALLY_READY__).
  // Reference/legacy pages never set it, so fall back to the plain wait.
  await page.waitForFunction('window.__WALLY_READY__ === true', { timeout: 30000 })
    .catch(() => logs.push('[warn] __WALLY_READY__ never set — falling back to timed wait'));

  if (EVAL) {
    const r = await page.evaluate(EVAL).catch(e => `[EVAL ERROR] ${e.message}`);
    if (r !== undefined && r !== null) logs.push(`[eval] ${JSON.stringify(r)}`);
  }

  await page.waitForTimeout(WAIT);

  // Force a few animation frames so any post-eval state is rendered.
  await page.evaluate(() => new Promise(r => {
    let n = 0;
    const tick = () => (++n > 6 ? r() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  })).catch(() => {});

  await mkdir(dirname(resolve(ROOT, out)), { recursive: true }).catch(() => {});
  await page.screenshot({ path: resolve(ROOT, out), animations: 'allow', timeout: 20000 });

  // Report perf + any GL errors so agents can see them without a second run.
  const perf = await page.evaluate(() => window.__WALLY_PERF__ || null).catch(() => null);
  if (perf) logs.push(`[perf] ${JSON.stringify(perf)}`);
} catch (e) {
  failed = e;
  logs.push(`[FATAL] ${e.message}`);
}

await browser.close();
server.close();

const errs = logs.filter(l =>
  /PAGEERROR|FATAL|\[error\]|\[404\]|EVAL ERROR/.test(l) &&
  !/favicon|status of 404/.test(l)
);
if (flag('console') || errs.length) {
  console.log(logs.join('\n'));
} else {
  console.log(`wrote ${out}  (${W}x${H})`);
  const perf = logs.find(l => l.startsWith('[perf]'));
  if (perf) console.log(perf);
}
process.exit(failed || errs.length ? 1 : 0);
