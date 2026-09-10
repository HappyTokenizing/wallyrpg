/* _perf-lib.mjs — shared boot + page-side profiler injection for the
   performance/quality pass. Not a gate; a measuring instrument. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8', '.css':'text/css', '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.svg':'image/svg+xml' };

export async function serve() {
  const server = createServer(async (req, res) => {
    try {
      const clean = decodeURIComponent(req.url.split('?')[0]);
      const path = join(ROOT, clean === '/' ? 'index.html' : clean);
      if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream', 'cache-control':'no-store' });
      res.end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

export async function boot({ w = 1600, h = 900, dpr = 1, qs = '?shot=1', logs = [] } = {}) {
  const { server, port } = await serve();
  const browser = await chromium.launch({ channel: 'chrome', args: [
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio' ] });
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/index.html${qs}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__WALLY_READY__ === true', null, { timeout: 60000 })
    .catch(() => logs.push('[warn] never ready'));
  return { browser, page, server, close: async () => { await browser.close(); server.close(); } };
}

/* ---- the page-side profiler ----
   Wraps every ctx._handles update/lateUpdate and ctx.render.render so
   one frame is broken into named CPU costs, and uses
   EXT_disjoint_timer_query_webgl2 for GPU time when the driver has it. */
export const INJECT = () => {
  const W = window.WALLY, ctx = W.ctx;
  if (window.__PROF__) return 'already';
  const P = window.__PROF__ = {
    cpu: Object.create(null), frames: 0, wall: 0, ms: [], gpu: [], gpuOK: false,
    t0: performance.now(),
  };
  const gl = ctx.renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  P.gpuOK = !!ext;
  const dbgi = gl.getExtension('WEBGL_debug_renderer_info');
  P.gpuName = dbgi ? gl.getParameter(dbgi.UNMASKED_RENDERER_WEBGL) : '?';

  P.gpuOn = true;
  const add = (k, ms) => { P.cpu[k] = (P.cpu[k] || 0) + ms; };
  const hs = ctx._handles;
  const nameOf = (h, i) => (h && h.__profname) || `h${i}`;
  for (let i = 0; i < hs.length; i++) {
    const h = hs[i];
    if (!h || h.__profwrapped) continue;
    h.__profwrapped = true;
    for (const hook of ['update', 'lateUpdate']) {
      const fn = h[hook];
      if (typeof fn !== 'function') continue;
      const key = nameOf(h, i) + '.' + hook;
      h[hook] = function (...a) { const t = performance.now(); try { return fn.apply(this, a); } finally { add(key, performance.now() - t); } };
    }
  }
  /* render, split into shadow+main+post by re-timing inside. */
  const R = ctx.render, rf = R.render;
  const q = [];
  P.renders = 0;
  R.render = function () {
    let query = null;
    if (ext && P.gpuOn) { query = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, query); }
    const t = performance.now();
    try { return rf.call(this); }
    finally {
      add('render.cpu', performance.now() - t);
      if (query) { gl.endQuery(ext.TIME_ELAPSED_EXT); q.push(query); }
      P.renders++;
    }
  };
  /* STRESS MODE. At 60 fps vsync the GPU has 40% idle and downclocks,
     so a timer query measures a slower clock the moment you REMOVE
     work — which is why hiding the NPCs made the frame look dearer.
     Re-rendering the same frame N extra times per rAF saturates it, so
     the per-render query is taken at a steady clock. */
  P.extra = 0;
  const stress = () => {
    requestAnimationFrame(stress);
    P.frames++;
    for (let i = 0; i < P.extra; i++) { try { R.render(); } catch (e) {} }
  };
  requestAnimationFrame(stress);
  /* drain finished GPU queries */
  const drain = () => {
    for (let i = q.length - 1; i >= 0; i--) {
      const query = q[i];
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) continue;
      const dis = gl.getParameter(ext.GPU_DISJOINT_EXT);
      if (!dis) P.gpu.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(query); q.splice(i, 1);
    }
    if (q.length > 24) { for (const x of q.splice(0, q.length - 24)) gl.deleteQuery(x); }
  };
  P.drain = drain;
  if (ext) setInterval(drain, 60);
  P.reset = () => { for (const k in P.cpu) delete P.cpu[k]; P.frames = 0; P.renders = 0; P.gpu.length = 0; P.t0 = performance.now(); };
  P.read = () => {
    const wall = performance.now() - P.t0;
    const g = P.gpu.slice().sort((a, b) => a - b);
    const cpu = {};
    for (const k in P.cpu) { const v = P.cpu[k] / Math.max(1, P.frames); if (v > 0.02) cpu[k] = +v.toFixed(3); }
    return {
      frames: P.frames, renders: P.renders, extra: P.extra,
      wallMs: +(wall / Math.max(1, P.frames)).toFixed(2),
      fps: +(P.frames / (wall / 1000)).toFixed(1),
      gpuMs: g.length ? +g[(g.length * 0.5) | 0].toFixed(2) : null,
      gpuN: g.length, gpuName: P.gpuName,
      renderCpuPer: P.cpu['render.cpu'] ? +(P.cpu['render.cpu'] / Math.max(1, P.renders)).toFixed(3) : null,
      cpu: Object.fromEntries(Object.entries(cpu).sort((a, b) => b[1] - a[1])),
      cpuTotal: +Object.values(cpu).reduce((a, b) => a + b, 0).toFixed(2),
      calls: ctx.renderer.info.render.calls, tris: ctx.renderer.info.render.triangles,
    };
  };
  return 'ok';
};

/* Name the handles so the CPU table is readable. main.js knows the
   names; we recover them from the module namespaces on ctx. */
export const NAMEHANDLES = () => {
  const ctx = window.WALLY.ctx;
  const NS = ['render','mat','wind','sky','world','city','foliage','water','phys','wally','npc','cam','game','ui','audio','intro'];
  for (const n of NS) { const h = ctx[n]; if (h && typeof h === 'object') h.__profname = n; }
  return ctx._handles.map((h, i) => (h && h.__profname) || `h${i}`);
};

export async function sample(page, ms = 3000) {
  await page.evaluate(() => window.__PROF__.reset());
  await page.waitForTimeout(ms);
  return page.evaluate(() => window.__PROF__.read());
}
