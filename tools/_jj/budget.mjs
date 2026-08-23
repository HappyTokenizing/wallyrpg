/* _jj/budget.mjs — WHAT A PARKED MACHINE COSTS A FRAME.

   Differences renderer.info over WHOLE FRAMES, not over one hand-made
   render call: draw() goes through the postfx composer (main.js), so a
   single renderer.render(scene, camera) is not the frame. renderer.render
   is wrapped to accumulate every call it makes in a frame, and the prop
   is toggled on alternate frames by a handle appended LAST — after
   wally.js's own parkedCull, which rewrites `visible` every frame and
   would otherwise undo the toggle.

   Runs the whole sweep twice: once as shipped (frustumCulled true) and
   once with the flag forced back to false, which is what it was before.
*/
import { boot, P } from './lib.mjs';

const { page, errs, close } = await boot();

await page.evaluate(() => {
  const c = window.WALLY.ctx, r = c.renderer;
  /* renderer.info.autoReset is FALSE (render/renderer.js) and
     postfx's render() calls renderer.info.reset() once at the top of
     the frame, so info.render.calls is ALREADY the frame total. My
     first version wrapped renderer.render and summed the counter after
     every pass, which sums a running total and reported 16 193 draw
     calls and 111 million triangles a frame. Read it once instead —
     here in lateUpdate, which runs before draw(), so what it holds is
     the PREVIOUS frame, complete. */
  const S = { frames: [], on: false, key: 'bike', want: true, prev: null };
  c._handles.push({ lateUpdate() {
    if (!S.on) return;
    const p = c.wally.rideProps[S.key];
    if (!p) return;
    if (S.prev !== null) S.frames.push({ vis: S.prev, calls: r.info.render.calls, tris: r.info.render.triangles });
    S.want = !S.want;
    p.group.visible = S.want;
    S.prev = S.want;
  } });
  window.__B = {
    S,
    setCull(on) {
      for (const k in c.wally.rideProps) c.wally.rideProps[k].group.traverse((o) => { if (o.isMesh) o.frustumCulled = on; });
    },
    start(key) { S.key = key; S.frames.length = 0; S.want = true; S.prev = null; S.on = true; },
    stop() {
      S.on = false;
      const f = S.frames.slice(4);           // drop the first toggles
      const on = f.filter((x) => x.vis), off = f.filter((x) => !x.vis);
      const m = (a, k) => a.reduce((s, x) => s + x[k], 0) / Math.max(a.length, 1);
      return { n: f.length,
        calls: +(m(on, 'calls') - m(off, 'calls')).toFixed(1),
        tris: Math.round(m(on, 'tris') - m(off, 'tris')),
        frameCalls: Math.round(m(on, 'calls')), frameTris: Math.round(m(on, 'tris')) };
    },
    where(key) {
      const T = window.WALLY.THREE;
      const g = c.wally.rideProps[key].group; g.updateMatrixWorld(true);
      const b = new T.Box3().setFromObject(g, true);
      const ctr = b.getCenter(new T.Vector3());
      const n = ctr.clone().project(c.camera);
      const h = (b.max.y - b.min.y);
      /* apparent height in pixels: the object's own height at its depth */
      const d = c.camera.position.distanceTo(ctr);
      const px = (h / (2 * Math.tan((c.camera.fov * Math.PI / 180) / 2) * d)) * c.renderer.domElement.clientHeight;
      return { dist: +d.toFixed(1), inFrustum: n.z < 1 && Math.abs(n.x) < 1.15 && Math.abs(n.y) < 1.15,
        behindLens: n.z >= 1, ndc: [+n.x.toFixed(2), +n.y.toFixed(2)], pxTall: +px.toFixed(1) };
    },
  };
});

const own = (id) => page.evaluate((i) => { window.WALLY.ctx.game.actions.grantRide(i); window.WALLY.ctx.game.actions.equipRide(i); }, id);
const unequip = () => page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));

await own('bike');
await page.waitForTimeout(2000);
await unequip();
await page.waitForTimeout(1800);
const at = await page.evaluate(() => window.WALLY.ctx.wally.rideProps.bike.group.position.toArray());
P('parked-at', at.map((v) => +v.toFixed(2)));

async function drag(px, n = 1) {
  for (let i = 0; i < n; i++) {
    await page.mouse.move(640, 380);
    await page.mouse.down();
    for (let k = 1; k <= 6; k++) { await page.mouse.move(640 + (px * k) / 6, 380); await page.waitForTimeout(30); }
    await page.mouse.up();
    await page.waitForTimeout(500);
  }
}
async function aim(key, steps = 26) {
  for (let i = 0; i < steps; i++) {
    const w = await page.evaluate((k) => window.__B.where(k), key);
    if (!w.behindLens && Math.abs(w.ndc[0]) < 0.3 && Math.abs(w.ndc[1]) < 0.8) return w;
    await drag(200);
  }
  return null;
}
async function stand(d, ang) {
  await page.evaluate(([x, z, dd, a]) => {
    const c = window.WALLY.ctx;
    const px = x + Math.cos(a) * dd, pz = z + Math.sin(a) * dd;
    const h = c.world.heightAt(px, pz);
    c.wally.setPosition(px, Number.isFinite(h) ? h : 14.5, pz);
  }, [at[0], at[2], d, ang]);
  await page.waitForTimeout(1400);
}
const measure = async (ms = 3000) => {
  await page.evaluate(() => window.__B.start('bike'));
  await page.waitForTimeout(ms);
  return page.evaluate(() => window.__B.stop());
};

for (const cull of [true, false]) {
  await page.evaluate((v) => window.__B.setCull(v), cull);
  P('---- frustumCulled', cull);
  for (const d of [6, 18, 32, 55, 90]) {
    await stand(d + 1.2, 0.6);
    const w = await aim('bike');
    if (!w) { P('inframe', { d, aim: 'FAILED' }); continue; }
    P('inframe', { d, where: w, cost: await measure() });
  }
  /* BEHIND THE LENS: aim at it, then turn away half a circle. */
  for (const d of [12, 40, 90]) {
    await stand(d + 1.2, 0.6);
    await aim('bike');
    await drag(200, 13);
    const w = await page.evaluate((k) => window.__B.where(k), 'bike');
    P('behind', { d, where: w, cost: await measure() });
  }
}
P('ERRS', errs.slice(0, 5));
await close();
