/* ============================================================
   _sm-lib.mjs — THE SPIKE HUNTER. Per-frame attribution, not averages.

   WHY THIS EXISTS AND WHY _perf-lib.mjs WAS NOT ENOUGH.
   _perf-lib.mjs divides a total by a frame count. A mean cannot see a
   spike: 260 frames at 6.4 ms with 13 frames at 14 ms average to 6.8,
   and the 13 frames are the whole complaint. This records EVERY frame
   separately — its wall time, every named hook's cost IN THAT FRAME,
   the render CPU, the GPU time for that frame's draw, and the deltas
   that betray a one-off (a program compiled, a geometry uploaded, a
   texture uploaded, the JS heap dropping = a GC).

   THE DECOMPOSITION, per frame:
       raw        rAF timestamp delta — exactly what main.js's census
                  puts in its ring, so the two are comparable
       cpu.*      every wrapped hook, summed within that frame
       outside    raw - sum(cpu) — everything that is not our JS:
                  present, vsync wait, compositor, GPU stall, browser
       gpu        EXT_disjoint_timer_query_webgl2 over ctx.render.render

   ORDERING. The recorder's rAF is registered AFTER main.js's, and each
   callback re-registers itself at its own top, so the batch order
   (game.frame, then recorder) is stable for the life of the page. The
   recorder therefore runs at the END of the frame it is describing.

   THE SPECIAL CASE THIS AVOIDS. ?shot makes npc.js drain its whole
   streaming queue on frame one (npc.js `const ms = ctx.flags?.shot ?
   Infinity : ...`). Profiling under ?shot would therefore measure a
   world with the streamer already finished and would never see the
   thing it is streaming. Every run here uses ?skipIntro.
   ============================================================ */
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

/* limiter:false adds the two flags that take the rAF cap off. shot.mjs
   forbids --disable-frame-rate-limit because it starves
   page.screenshot(); nothing here screenshots. */
export async function boot({ w = 1600, h = 900, dpr = 1, qs = '?skipIntro', limiter = true, logs = [] } = {}) {
  const { server, port } = await serve();
  const args = ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'];
  if (!limiter) args.push('--disable-frame-rate-limit', '--disable-gpu-vsync');
  const browser = await chromium.launch({ channel: 'chrome', args });
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/index.html${qs}`, { waitUntil: 'load', timeout: 120000 });
  return { browser, page, server, port, close: async () => { await browser.close(); server.close(); } };
}

/* ---- the page-side per-frame recorder ---- */
export const INJECT = () => {
  const W = window.WALLY, ctx = W.ctx;
  if (window.__SMP__) return 'already';
  const gl = ctx.renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const dbgi = gl.getExtension('WEBGL_debug_renderer_info');
  const P = window.__SMP__ = {
    rec: [], on: false, pend: [], gpu: new Map(), long: [], marks: [],
    /* 'frame' = one query around the whole draw; 'pass' = one around
       each three.js render call; 'shadow' = one around the shadow map
       only. TIME_ELAPSED queries CANNOT NEST, so exactly one of these
       is armed at a time and the mode says which. */
    gpuMode: 'frame', pendPass: [], gpuPass: Object.create(null),
    gpuOK: !!ext, gpuName: dbgi ? gl.getParameter(dbgi.UNMASKED_RENDERER_WEBGL) : '?',
    fid: 0,
  };

  const NS = ['render','mat','wind','sky','world','city','foliage','water','phys','wally','npc','cam','game','ui','audio','intro'];
  for (const n of NS) { const h = ctx[n]; if (h && typeof h === 'object' && !h.__smname) h.__smname = n; }

  let cur = Object.create(null);
  const add = (k, ms) => { cur[k] = (cur[k] || 0) + ms; };

  /* every subsystem hook */
  const hs = ctx._handles;
  for (let i = 0; i < hs.length; i++) {
    const h = hs[i]; if (!h || h.__smwrapped) continue; h.__smwrapped = true;
    const nm = h.__smname || ('h' + i);
    for (const hook of ['update', 'lateUpdate']) {
      const fn = h[hook]; if (typeof fn !== 'function') continue;
      const key = nm + (hook === 'update' ? '' : '~late');
      h[hook] = function (...a) { const t = performance.now(); try { return fn.apply(this, a); } finally { add(key, performance.now() - t); } };
    }
  }

  /* the shadow map pass, on its own — this is the line that tests the
     "shadow cascade updates" hypothesis directly. WebGLShadowMap.render
     is an own property of the instance in three r180. */
  const sm = ctx.renderer.shadowMap;
  if (sm && typeof sm.render === 'function' && !sm.__sm) {
    sm.__sm = true; const f = sm.render.bind(sm);
    sm.render = function (l, s, c) {
      let q = null;
      if (ext && P.on && P.gpuMode === 'shadow') { try { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); } catch (e) { q = null; } }
      const t = performance.now();
      try { return f(l, s, c); }
      finally { add('R.shadowmap', performance.now() - t);
        if (q) { try { gl.endQuery(ext.TIME_ELAPSED_EXT); P.pendPass.push([q, 'shadowmap']); } catch (e) {} } }
    };
  }
  /* cascade fitting, separate from the shadow draw */
  const csm = ctx.render.csm;
  if (csm && typeof csm.update === 'function' && !csm.__sm) {
    csm.__sm = true; const f = csm.update.bind(csm);
    csm.update = function (c) { const t = performance.now(); try { return f(c); } finally { add('R.csmFit', performance.now() - t); } };
  }
  /* the post chain */
  const post = ctx.render.post;
  if (post && typeof post.render === 'function' && !post.__sm) {
    post.__sm = true; const f = post.render.bind(post);
    post.render = function (...a) { const t = performance.now(); try { return f(...a); } finally { add('R.post', performance.now() - t); } };
  }
  /* every three.js scene render in the frame, by ordinal. pass0 is the
     main forward pass and CONTAINS R.shadowmap. */
  const R3 = ctx.renderer, r3 = R3.render.bind(R3);
  let passIdx = 0;
  R3.render = function (s, c) {
    const i = passIdx++;
    let q = null;
    if (ext && P.on && P.gpuMode === 'pass') { try { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); } catch (e) { q = null; } }
    const t = performance.now();
    try { return r3(s, c); }
    finally { add('R.gl' + i, performance.now() - t);
      if (q) { try { gl.endQuery(ext.TIME_ELAPSED_EXT); P.pendPass.push([q, 'gl' + i]); } catch (e) {} } }
  };

  /* the whole draw, plus a GPU timer query tagged with the frame id */
  const RR = ctx.render, rf = RR.render.bind(RR);
  RR.render = function () {
    passIdx = 0;
    let q = null;
    if (ext && P.on && P.gpuMode === 'frame') { try { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); } catch (e) { q = null; } }
    const t = performance.now();
    try { return rf(); }
    finally {
      add('R.total', performance.now() - t);
      if (q) { try { gl.endQuery(ext.TIME_ELAPSED_EXT); P.pend.push([q, P.fid]); } catch (e) {} }
    }
  };

  function drain() {
    if (!ext) return;
    for (let i = P.pend.length - 1; i >= 0; i--) {
      const [q, f] = P.pend[i];
      let ok = false; try { ok = gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); } catch (e) { ok = true; }
      if (!ok) continue;
      try { if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) P.gpu.set(f, gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6); } catch (e) {}
      try { gl.deleteQuery(q); } catch (e) {}
      P.pend.splice(i, 1);
    }
    if (P.pend.length > 64) for (const [q] of P.pend.splice(0, P.pend.length - 64)) { try { gl.deleteQuery(q); } catch (e) {} }
    for (let i = P.pendPass.length - 1; i >= 0; i--) {
      const [q, name] = P.pendPass[i];
      let ok = false; try { ok = gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); } catch (e) { ok = true; }
      if (!ok) continue;
      try { if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) (P.gpuPass[name] || (P.gpuPass[name] = [])).push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6); } catch (e) {}
      try { gl.deleteQuery(q); } catch (e) {}
      P.pendPass.splice(i, 1);
    }
    if (P.pendPass.length > 512) for (const [q] of P.pendPass.splice(0, P.pendPass.length - 512)) { try { gl.deleteQuery(q); } catch (e) {} }
  }

  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (P.on) P.long.push([+e.startTime.toFixed(1), +e.duration.toFixed(1)]); })
      .observe({ entryTypes: ['longtask'] });
  } catch (e) {}

  const info = ctx.renderer.info;
  const nProg = () => (info.programs ? info.programs.length : 0);
  let lastTs = 0, lastNow = 0, pProg = nProg(), pGeo = info.memory.geometries, pTex = info.memory.textures, pHeap = 0;

  /* THE INSTRUMENT'S OWN CHECK. `raw` is the rAF TIMESTAMP delta,
     which is what main.js's census rings. `wall` is a performance.now()
     delta across the same interval. They must agree. If they do not,
     the census is ringing the browser's idea of when a frame began
     rather than how long one took — and with --disable-gpu-vsync
     Chrome is free to hand out bunched timestamps. Publish both. */
  function tick(ts) {
    requestAnimationFrame(tick);
    const now = performance.now();
    drain();
    if (P.on && lastTs) {
      const prog = nProg();
      const heap = performance.memory ? performance.memory.usedJSHeapSize : 0;
      let sum = 0; for (const k in cur) if (k !== 'R.total' && k[0] !== 'R') sum += cur[k];
      sum += cur['R.total'] || 0;
      const c = {}; for (const k in cur) { const v = +cur[k].toFixed(3); if (v >= 0.02) c[k] = v; }
      P.rec.push({
        f: P.fid, t: +ts.toFixed(2), raw: +(ts - lastTs).toFixed(3),
        wall: +(now - lastNow).toFixed(3),
        cpu: +sum.toFixed(3), c,
        calls: info.render.calls, tris: info.render.triangles,
        dP: prog - pProg, dG: info.memory.geometries - pGeo, dT: info.memory.textures - pTex,
        dH: pHeap ? +((heap - pHeap) / 1048576).toFixed(2) : 0,
        px: +(ctx.wally?.root?.position?.x ?? 0).toFixed(1),
        pz: +(ctx.wally?.root?.position?.z ?? 0).toFixed(1),
      });
      pProg = prog; pGeo = info.memory.geometries; pTex = info.memory.textures; pHeap = heap;
    }
    lastTs = ts; lastNow = now;
    cur = Object.create(null);
    P.fid++;
  }
  requestAnimationFrame(tick);

  P.start = (label, mode) => { P.rec.length = 0; P.gpu.clear(); P.long.length = 0;
    for (const k in P.gpuPass) delete P.gpuPass[k];
    P.gpuMode = mode || 'frame'; P.on = true; P.label = label || ''; return P.fid; };
  P.stop = () => { P.on = false; drain(); return P.rec.length; };
  P.read = () => {
    drain();
    const rec = P.rec.map(r => ({ ...r, gpu: P.gpu.has(r.f) ? +P.gpu.get(r.f).toFixed(3) : null }));
    const gp = {};
    for (const k in P.gpuPass) { const a = P.gpuPass[k].slice().sort((x, y) => x - y);
      gp[k] = { n: a.length, p50: +a[a.length >> 1].toFixed(3), p95: +a[Math.max(0, Math.ceil(a.length * 0.95) - 1)].toFixed(3), sum50: +a[a.length >> 1].toFixed(3) }; }
    return { label: P.label, gpuMode: P.gpuMode, gpuPass: gp, gpuOK: P.gpuOK, gpuName: P.gpuName, long: P.long, rec,
      quality: ctx.quality?.name, dpr: ctx.renderer.getPixelRatio(), size: [innerWidth, innerHeight] };
  };
  P.mark = (s) => { P.marks.push([performance.now(), s]); };
  return 'ok';
};

/* ---- node-side statistics. One place, so every table agrees. ---- */
export function stats(a) {
  if (!a.length) return null;
  const v = a.slice().sort((x, y) => x - y);
  const q = (p) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(v.length * p) - 1))];
  const mean = a.reduce((s, x) => s + x, 0) / a.length;
  return { n: a.length, mean: +mean.toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2),
    p99: +q(0.99).toFixed(2), worst: +v[v.length - 1].toFixed(2), best: +v[0].toFixed(2) };
}

/* Which hook was the outlier on the slow frames? For every frame above
   `thr`, take its cost table, subtract that hook's own median over the
   whole window, and sum the EXCESS. The winner is the hook that is
   actually different on slow frames, not merely the most expensive one
   on every frame — those are different questions and only the second
   one is answered by a mean. */
export function attribute(rec, thr) {
  const keys = new Set(); for (const r of rec) for (const k in r.c) keys.add(k);
  const med = {};
  for (const k of keys) {
    const a = rec.map(r => r.c[k] || 0).sort((x, y) => x - y);
    med[k] = a[a.length >> 1];
  }
  const slow = rec.filter(r => r.raw > thr);
  const excess = {};
  for (const r of slow) for (const k of keys) {
    const e = (r.c[k] || 0) - med[k];
    if (e > 0.05) excess[k] = (excess[k] || 0) + e;
  }
  const rows = Object.entries(excess).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => [k, +(v / Math.max(1, slow.length)).toFixed(2), +med[k].toFixed(2)]);
  return { nSlow: slow.length, thr: +thr.toFixed(2), rows };
}
