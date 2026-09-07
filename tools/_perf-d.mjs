/* _perf-d.mjs — DOES NOT WORK ON THIS DRIVER. KEPT SO NOBODY BUILDS IT
   AGAIN. Per-pass TIME_ELAPSED queries on ANGLE/Metal (Apple) carry a
   fixed per-query cost of roughly 1.4 ms because each query splits the
   command buffer: fifteen passes summed to 27 ms inside a frame the
   whole-frame query measured at 7. Every pass also reads back suspiciously
   near that same 1.4-1.7 ms floor, which is the tell. Use ONE query
   around the whole render (_perf-lib INJECT) and ablate passes to
   difference them (_perf-b) instead.

   _perf-d.mjs — per-PASS GPU timing. Wraps composer.draw and
   renderer.render with EXT_disjoint_timer_query so the frame is broken
   into named passes instead of guessed at by ablation. Run saturated so
   the GPU clock does not move underneath the measurement. */
import { boot, INJECT, NAMEHANDLES } from './_perf-lib.mjs';
const argv = process.argv.slice(2);
const W = +(argv.find(a => a.startsWith('--w='))?.slice(4) ?? 1600);
const H = +(argv.find(a => a.startsWith('--h='))?.slice(4) ?? 900);
const SITE = argv.find(a => a.startsWith('--site='))?.slice(7) ?? 'cafe';
const logs = [];
const { page, close } = await boot({ w: W, h: H, logs });
await page.evaluate(NAMEHANDLES); await page.evaluate(INJECT);
await page.evaluate((l) => { const d = window.WALLY.debug; d.arrive(l, true); d.arriveNow && d.arriveNow(); }, SITE);
await page.waitForTimeout(2500);

await page.evaluate(() => {
  window.__PROF__.gpuOn = false;   // nested TIME_ELAPSED queries are illegal
  const ctx = window.WALLY.ctx, R = ctx.render, gl = ctx.renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const P = window.__PASS__ = { t: Object.create(null), n: Object.create(null), q: [], frames: 0 };
  const names = new Map();
  const M = R.post.materials;
  for (const k in M) names.set(M[k], k.replace(/Mat$/, ''));
  const label = (m, rt) => names.get(m) || ('other@' + (rt ? rt.width + 'x' + rt.height : 'screen'));
  const cd = R.composer.draw;
  const begin = (key) => { const q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); return [key, q]; };
  const end = (e) => { gl.endQuery(ext.TIME_ELAPSED_EXT); P.q.push(e); };
  R.composer.draw = function (m, rt, clear) {
    const e = begin(label(m, rt));
    try { return cd.call(this, m, rt, clear); } finally { end(e); }
  };
  const rr = ctx.renderer.render.bind(ctx.renderer);
  ctx.renderer.render = function (sc, cam) {
    const shadow = ctx.renderer.shadowMap.needsUpdate;
    const e = begin(shadow ? 'scene+shadow' : 'scene');
    try { return rr(sc, cam); } finally { end(e); }
  };
  P.drain = () => {
    for (let i = P.q.length - 1; i >= 0; i--) {
      const [key, q] = P.q[i];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) continue;
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        P.t[key] = (P.t[key] || 0) + gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        P.n[key] = (P.n[key] || 0) + 1;
      }
      gl.deleteQuery(q); P.q.splice(i, 1);
    }
  };
  setInterval(P.drain, 40);
  P.reset = () => { for (const k in P.t) { delete P.t[k]; delete P.n[k]; } P.frames = 0; };
  P.read = (renders) => Object.fromEntries(Object.entries(P.t)
    .map(([k, v]) => [k, { msPerFrame: +(v / renders).toFixed(3), perFrame: +(P.n[k] / renders).toFixed(2) }])
    .sort((a, b) => b[1].msPerFrame - a[1].msPerFrame));
});
await page.evaluate(() => { window.__PROF__.extra = 3; });
await page.waitForTimeout(700);
await page.evaluate(() => { window.__PASS__.reset(); window.__PROF__.reset(); });
await page.waitForTimeout(2500);
const r = await page.evaluate(() => { window.__PASS__.drain();
  const p = window.__PROF__.read();
  return { renders: p.renders, gpuMs: p.gpuMs, renderCpuPer: p.renderCpuPer, calls: p.calls, tris: p.tris,
           passes: window.__PASS__.read(p.renders) }; });
console.log(`site=${SITE} ${W}x${H}  renders=${r.renders}  gpu/render=${r.gpuMs} ms  renderCPU=${r.renderCpuPer} ms  calls=${r.calls} tris=${r.tris}`);
let sum = 0;
for (const [k, v] of Object.entries(r.passes)) { sum += v.msPerFrame;
  console.log(`  ${k.padEnd(16)} ${String(v.msPerFrame).padStart(7)} ms   x${v.perFrame}`); }
console.log(`  ${'SUM'.padEnd(16)} ${sum.toFixed(3)} ms`);
const errs = logs.filter(l => /PAGEERROR|\[error\]/.test(l));
if (errs.length) console.log('ERRORS ' + errs.slice(0, 5).join('\n'));
await close();
