/* ============================================================
   _j26-lib.mjs — judge 26's shared boot + load instrumentation.

   WHY A NEW LIB. _sm-lib.mjs's boot() creates a page with NO touch
   emulation and no mobile UA. deviceClass() in contracts.js keys on
   `navigator.maxTouchPoints > 0` FIRST and returns 'desktop' when it
   is zero, whatever the window shape — deliberately, so a narrow
   measurement window is still a desktop. That means EVERY rig built on
   _sm-lib.boot() at 390x844 exercises the DESKTOP branch of
   pickQuality, and none of them has ever been a phone. This lib makes
   phone-ness explicit and prints which branch was actually taken.

   LOAD IS AN INPUT, NOT A FOOTNOTE. This box runs other toolchains. A
   previous judge moved p50 from 7.6 to 16.3 ms and back by opening and
   closing contending browsers on ONE page load. So every timed sample
   reads the 1-minute load average before AND after and prints both; a
   row where they diverge is a row to throw away, and it is printed so
   that it can be.
   ============================================================ */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export function load1() {
  try { return +execSync('uptime').toString().split('load averages:')[1].trim().split(/\s+/)[0]; }
  catch { return NaN; }
}
/* Wait for the box to quiet down. Returns the load it settled at. */
export async function loadGate(max, tries = 30) {
  let l = load1();
  for (let i = 0; i < tries && l > max; i++) {
    if (i === 0) process.stderr.write(`  [loadgate] waiting for 1-min load <= ${max} (now ${l})\n`);
    await sleep(10000); l = load1();
  }
  return l;
}

export async function serve() {
  const server = createServer(async (req, res) => {
    try {
      const clean = decodeURIComponent(req.url.split('?')[0]);
      const path = join(ROOT, clean === '/' ? 'index.html' : clean);
      if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

export const UA = {
  pixel7: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  ipad:   'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
};

/* phone:true turns on hasTouch + isMobile + a mobile UA — the three
   things deviceClass() can read. limiter:false uncaps rAF (never use
   it with page.screenshot: it starves the capture). */
/* THE FIRST-FRAME RECORDER. Installed BEFORE any of the game's own
   script runs, so it can answer "what did the very first frame render
   at" — a question no post-hoc read can answer, because the governor
   has taken two notches by the time a rig has finished awaiting
   __WALLY_READY__ and arriving somewhere. It polls for window.WALLY at
   animation-frame rate and latches the first sample it can take. */
export const FIRST_FRAME = () => {
  window.__J26_FIRST__ = null;
  const tick = () => {
    const W = window.WALLY;
    if (W && W.ctx && W.ctx.renderer && !window.__J26_FIRST__) {
      const r = W.ctx.renderer, el = r.domElement;
      const gl = r.getContext();
      window.__J26_FIRST__ = {
        frame: W.ctx.frame, t: +performance.now().toFixed(1),
        pixelRatio: r.getPixelRatio(),
        canvas: [el.width, el.height],
        gl: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        tier: W.ctx.quality && W.ctx.quality.name,
        tierPixelRatio: W.ctx.quality && W.ctx.quality.pixelRatio,
        dpr: devicePixelRatio,
      };
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

export async function boot({
  w = 1600, h = 900, dpr = 1, phone = false, touch = null, ua = null,
  qs = '?skipIntro&hour=12.5', limiter = true, logs = [], initScript = null,
} = {}) {
  const { server, port } = await serve();
  const args = ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'];
  if (!limiter) args.push('--disable-frame-rate-limit', '--disable-gpu-vsync');
  const browser = await chromium.launch({ channel: 'chrome', args });
  const wantTouch = touch == null ? phone : touch;
  const ctxOpts = {
    viewport: { width: w, height: h }, deviceScaleFactor: dpr,
    hasTouch: !!wantTouch, isMobile: !!phone,
  };
  const uaStr = ua || (phone ? UA.pixel7 : null);
  if (uaStr) ctxOpts.userAgent = uaStr;
  const bctx = await browser.newContext(ctxOpts);
  const page = await bctx.newPage();
  if (initScript) await page.addInitScript(initScript);
  page.on('console', m => { if (m.type() === 'error') logs.push(`[console.error] ${m.text()}`); });
  page.on('pageerror', e => logs.push(`[PAGEERROR] ${String(e.message).split('\n')[0]}`));
  await page.goto(`http://127.0.0.1:${port}/index.html${qs}`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 180000 })
    .catch(() => logs.push('[warn] never ready'));
  return { browser, page, server, port,
    close: async () => { try { await browser.close(); } catch (e) {} server.close(); } };
}

/* What the page thinks it is. Reported next to every measurement so a
   row can never be mistaken for a branch it did not take. */
export const ENVSTATE = () => {
  const g = WALLY.ctx.renderer.getContext();
  const dbg = g.getExtension('WEBGL_debug_renderer_info');
  return {
    innerWidth, innerHeight, dpr: devicePixelRatio,
    maxTouchPoints: navigator.maxTouchPoints | 0,
    onTouchStart: 'ontouchstart' in window,
    uadMobile: navigator.userAgentData ? navigator.userAgentData.mobile : null,
    ua: navigator.userAgent.slice(0, 60),
    gpu: dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '(withheld)',
    tier: WALLY.ctx.quality.name,
    pixelRatioMax: WALLY.ctx.quality.pixelRatioMax,
    pixelBudget: WALLY.ctx.quality.pixelBudget,
    msaa: WALLY.ctx.quality.msaa,
  };
};

export function stats(a) {
  if (!a || !a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const q = (p) => +s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))].toFixed(2);
  return { n: s.length, p50: q(0.5), p95: q(0.95), min: q(0), max: q(1) };
}
