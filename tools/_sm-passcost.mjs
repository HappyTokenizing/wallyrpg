#!/usr/bin/env node
/* ============================================================
   IS THE POST CHAIN PAYING FOR PIXELS OR FOR PASSES?

   SSAO costs 4.38 ms at 1600x900 and 4.72 ms at 390x844 — the same
   money for 4.4x fewer pixels. Either the AO targets are not being
   resized, or a full-screen pass on this driver has a large FIXED
   cost and the chain is paying 17 of them. This decides it: add N
   extra no-op full-screen passes (the cheapest possible shader,
   writing the smallest possible target) and see what each one costs
   at each viewport. A cost per pass that does not fall with the
   viewport is a fixed cost, and then the lever is FEWER PASSES rather
   than cheaper ones.
   ============================================================ */
import { boot, INJECT, stats } from './_sm-lib.mjs';
import { execSync } from 'node:child_process';
const load = () => execSync('uptime').toString().split('load averages:')[1].trim();

for (const [w, h] of [[1600, 900], [390, 844]]) {
  const logs = [];
  const { page, close } = await boot({ w, h, logs, limiter: true });
  await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
  await page.waitForTimeout(6000);
  await page.evaluate(INJECT);
  await page.waitForTimeout(1500);

  /* the AO target's ACTUAL size, straight off the GL object */
  const sizes = await page.evaluate(() => {
    const r = WALLY.ctx.render;
    const out = { screen: [innerWidth, innerHeight], drawingBuffer: [WALLY.ctx.renderer.domElement.width, WALLY.ctx.renderer.domElement.height] };
    const t = r.targets;
    if (t?.scene) out.scene = [t.scene.width, t.scene.height];
    if (t?.normalDepth) out.nd = [t.normalDepth.width, t.normalDepth.height];
    return out;
  });
  console.log(`\n=== ${w}x${h}  targets ${JSON.stringify(sizes)}  load ${load()}`);

  /* N extra no-op passes, injected around ctx.render.render */
  await page.evaluate(() => {
    const THREE = WALLY.THREE, ctx = WALLY.ctx;
    const geo = new THREE.PlaneGeometry(2, 2);
    const mat = new THREE.ShaderMaterial({
      vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'void main(){ gl_FragColor = vec4(0.0); }',
      depthTest: false, depthWrite: false,
    });
    const sc = new THREE.Scene(); sc.add(new THREE.Mesh(geo, mat));
    const cam = new THREE.Camera();
    const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { depthBuffer: false });
    const R = ctx.render, rf = R.render.bind(R);
    window.__EXTRA__ = 0;
    R.render = function () {
      const r = rf();
      const n = window.__EXTRA__;
      if (n) {
        const prev = ctx.renderer.getRenderTarget();
        for (let i = 0; i < n; i++) { ctx.renderer.setRenderTarget(rt); ctx.renderer.render(sc, cam); }
        ctx.renderer.setRenderTarget(prev);
      }
      return r;
    };
  });

  const win = async () => {
    await page.evaluate(() => window.__SMP__.start('pc', 'frame'));
    await page.waitForTimeout(1600);
    await page.evaluate(() => window.__SMP__.stop());
    const d = await page.evaluate(() => window.__SMP__.read());
    const rec = d.rec.slice(1);
    return stats(rec.filter(r => r.gpu != null).map(r => r.gpu));
  };

  for (const n of [0, 4, 8]) {
    const v = [];
    for (let r = 0; r < 3; r++) {
      await page.evaluate(() => { window.__EXTRA__ = 0; }); await page.waitForTimeout(300);
      const a = await win();
      await page.evaluate((k) => { window.__EXTRA__ = k; }, n); await page.waitForTimeout(300);
      const b = await win();
      await page.evaluate(() => { window.__EXTRA__ = 0; });
      v.push(b.best - a.best);
    }
    const m = v.reduce((s, x) => s + x, 0) / v.length;
    console.log(`   +${String(n).padStart(2)} no-op full-screen passes: +${m.toFixed(2)} ms gpu   ${n ? `(${(m / n).toFixed(3)} ms each)` : ''}  rounds ${v.map(x => x.toFixed(2)).join(' ')}`);
  }
  await close();
}
