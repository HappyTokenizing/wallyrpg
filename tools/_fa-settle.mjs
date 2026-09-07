#!/usr/bin/env node
/* ============================================================
   _fa-settle.mjs — SETTLE THE TWO FRAME-TIME MEASUREMENTS.

   Two agents measured 390x844 on this machine and disagreed 3-4x.
   Averaging them would be the one useless thing to do. This runs BOTH
   definitions on ONE page load, in the SAME scene, back to back, and
   again after — so the only thing that can differ between the two
   readings is the thing being tested.

   THE FOUR CANDIDATE DIFFERENCES, each isolated here:
     1. THE INSTRUMENT.  _sm-lib.mjs's INJECT wraps ~20 hooks, wraps
        every three.js render call, and issues a GPU TIME_ELAPSED query
        per frame. Phase A reads the scene CLEAN; phase B injects and
        re-reads the SAME scene on the SAME load. Any gap is the probe.
     2. THE CLOCK.  The shipped census rings performance.now() inside
        step(); the judge's rig differences performance.now() in its own
        rAF callback. Both are read here, same frames.
     3. THE LIMITER.  --limiter keeps Chrome's rAF cap; without it the
        run adds --disable-frame-rate-limit --disable-gpu-vsync.
     4. THE MACHINE.  `uptime` load is printed BESIDE every single row,
        not once at the top, because it moves while the run is going and
        this box has other agents' browsers on it.

   And the dimension nobody sampled: --dpr sets Playwright's
   deviceScaleFactor, and the rig prints the DRAWING BUFFER it actually
   got, because a tier that pins pixelRatio to 1 will ignore it.
   --force-dpr additionally lifts renderer.setPixelRatio to the device
   ratio, which is the only way to find out what the pixels cost.
   ============================================================ */
import { boot, INJECT, stats } from './_sm-lib.mjs';
import { execSync } from 'node:child_process';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes('--' + n);
const W = +arg('w', 390), H = +arg('h', 844), DPR = +arg('dpr', 1);
const LIMITER = flag('limiter');
const FORCE_DPR = flag('force-dpr');
const QS = arg('qs', '?skipIntro');
const SECS = +arg('secs', 6);

const load = () => execSync('uptime').toString().split('load averages:')[1].trim().split(/\s+/)[0];

const logs = [];
const { page, close } = await boot({ w: W, h: H, dpr: DPR, qs: QS, logs, limiter: LIMITER });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(6000);

/* If asked, lift the renderer's own pixelRatio clamp to the device's.
   This is NOT what the game ships; it is how you find out what dpr 2-3
   would cost if a tier ever asked for it. */
if (FORCE_DPR) {
  await page.evaluate((d) => {
    const r = WALLY.ctx.renderer;
    WALLY.ctx.quality.pixelRatio = d;
    r.setPixelRatio(d);
    WALLY.ctx.render.resize(innerWidth, innerHeight);
    const hs = WALLY.ctx._handles || [];
    for (const h of hs) { if (h && h !== WALLY.ctx.render && typeof h.resize === 'function') { try { h.resize(innerWidth, innerHeight); } catch (e) {} } }
  }, DPR);
  await page.waitForTimeout(1500);
}

const rig = await page.evaluate(() => {
  const gl = WALLY.ctx.renderer.getContext();
  const d = gl.getExtension('WEBGL_debug_renderer_info');
  const c = WALLY.ctx.renderer.domElement;
  return {
    tier: WALLY.ctx.quality?.name,
    tierPixelRatio: WALLY.ctx.quality?.pixelRatio,
    rendererPixelRatio: WALLY.ctx.renderer.getPixelRatio(),
    windowDPR: window.devicePixelRatio,
    css: [innerWidth, innerHeight],
    drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    canvasAttr: [c.width, c.height],
    gpu: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?',
    msaa: WALLY.ctx.quality?.msaa, ssao: WALLY.ctx.quality?.ssao,
    dof: WALLY.ctx.quality?.dof, bloom: WALLY.ctx.quality?.bloom,
    grassDist: WALLY.ctx.quality?.grassDist,
  };
});
const px = rig.drawingBuffer[0] * rig.drawingBuffer[1];
console.log(`# RIG  ${W}x${H} css | deviceScaleFactor ${DPR} | window.devicePixelRatio ${rig.windowDPR}`);
console.log(`#      tier ${rig.tier}  tier.pixelRatio ${rig.tierPixelRatio}  renderer.getPixelRatio ${rig.rendererPixelRatio}`);
console.log(`#      DRAWING BUFFER ${rig.drawingBuffer[0]}x${rig.drawingBuffer[1]} = ${(px / 1e6).toFixed(3)} Mpx   canvas attr ${rig.canvasAttr.join('x')}`);
console.log(`#      msaa ${rig.msaa} ssao ${rig.ssao} dof ${rig.dof} bloom ${rig.bloom} grassDist ${rig.grassDist}`);
console.log(`#      limiter ${LIMITER ? 'ON' : 'OFF'}  forceDpr ${FORCE_DPR}  gpu ${rig.gpu}  load ${load()}`);

/* ---- definition 1: the JUDGE's method. A page-side rAF loop that
   differences performance.now() itself. It does not touch the game. ---- */
const judgeSample = (secs) => page.evaluate(async (s) => {
  const t0 = performance.now(); const ms = []; let last = t0;
  while (performance.now() - t0 < s * 1000) {
    await new Promise(r => requestAnimationFrame(r));
    const n = performance.now(); ms.push(n - last); last = n;
  }
  ms.shift(); ms.shift();
  const v = ms.slice().sort((a, b) => a - b);
  const q = p => v[Math.min(v.length - 1, Math.max(0, Math.ceil(v.length * p) - 1))];
  return { n: v.length, p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), p99: +q(0.99).toFixed(2), worst: +v[v.length - 1].toFixed(2) };
}, secs);

/* ---- definition 2: the SHIPPED census, read over the same window ---- */
const censusSample = async (secs) => {
  await page.waitForTimeout(secs * 1000);
  return page.evaluate(() => { const p = WALLY.debug.perf(); return { n: p.n, p50: p.p50, p95: p.p95, p99: p.p99, worst: p.worst, cpu: p.cpuMs, cpuP95: p.cpuP95, hz: p.hz, dropped: p.dropped, calls: p.calls }; });
};

const row = (tag, j, c) => console.log(
  `  ${tag.padEnd(30)} judge-rAF p50 ${String(j.p50).padStart(6)} p95 ${String(j.p95).padStart(6)} worst ${String(j.worst).padStart(6)} n ${String(j.n).padStart(4)}` +
  ` | census p50 ${String(c.p50).padStart(6)} p95 ${String(c.p95).padStart(6)} worst ${String(c.worst).padStart(6)} cpu ${String(c.cpu).padStart(5)}/${String(c.cpuP95).padStart(5)} drop ${String(c.dropped).padStart(3)} calls ${c.calls} | load ${load()}`);

const SCENES = [
  ['A quiet: spawn', null],
  ['B busy: market square', () => WALLY.debug.arrive('markethall', true)],
  ['C quiet: Green Edge farm', () => WALLY.debug.arrive('farm', true)],
  ['D quiet: Iron Hills mine', () => WALLY.debug.arrive('mine', true)],
];

async function pass(phase) {
  console.log(`\n--- PHASE ${phase} ---`);
  for (const [tag, setup] of SCENES) {
    if (setup) await page.evaluate(setup);
    await page.waitForTimeout(2600);
    const j = await judgeSample(SECS);
    const c = await censusSample(SECS);
    row(`${tag}`, j, c);
  }
  /* walking, W held — the scenario the fixer quoted GPU 26.5 for */
  await page.evaluate(() => WALLY.debug.arrive('cafe', true));
  await page.waitForTimeout(2000);
  await page.keyboard.down('w');
  const jw = await judgeSample(SECS);
  const cw = await censusSample(SECS);
  await page.keyboard.up('w');
  row('E walking, W held (cafe)', jw, cw);
}

await pass('A — CLEAN, nothing injected');
await page.evaluate(INJECT);
await page.evaluate(() => window.__SMP__.start('idle'));
await pass('B — WITH _sm-lib INJECT (hook wrappers + GPU TIME_ELAPSED query)');
await page.evaluate(() => window.__SMP__.stop());

console.log('\n# page errors:', logs.filter(l => /PAGEERROR/.test(l)).length, ' load now', load());
await close();
