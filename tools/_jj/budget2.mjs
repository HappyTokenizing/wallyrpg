/* _jj/budget2.mjs — the two header claims that budget.mjs left open:
   the OFF-SCREEN cost as a function of distance ("53 calls at any
   range, 0 past ~80 m"), and the APPARENT SIZE ("55 m, 28 px tall";
   "26.7 px at 57 m"). Size is measured off the projected VERTICES of
   the drawn meshes, which is the silhouette, not off a nominal height
   pushed through a thin-lens formula. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot();

await page.evaluate(() => {
  const c = window.WALLY.ctx, r = c.renderer, T = window.WALLY.THREE;
  const S = { frames: [], on: false, key: 'bike', want: true, prev: null };
  c._handles.push({ lateUpdate() {
    if (!S.on) return;
    const p = c.wally.rideProps[S.key]; if (!p) return;
    if (S.prev !== null) S.frames.push({ vis: S.prev, calls: r.info.render.calls, tris: r.info.render.triangles });
    S.want = !S.want; p.group.visible = S.want; S.prev = S.want;
  } });
  window.__B = {
    start(k) { S.key = k; S.frames.length = 0; S.want = true; S.prev = null; S.on = true; },
    stop() {
      S.on = false;
      const f = S.frames.slice(4);
      const on = f.filter((x) => x.vis), off = f.filter((x) => !x.vis);
      const m = (a, k) => a.reduce((s, x) => s + x[k], 0) / Math.max(a.length, 1);
      return { n: f.length, calls: +(m(on, 'calls') - m(off, 'calls')).toFixed(1), tris: Math.round(m(on, 'tris') - m(off, 'tris')) };
    },
    setCull(v) { for (const k in c.wally.rideProps) c.wally.rideProps[k].group.traverse((o) => { if (o.isMesh) o.frustumCulled = v; }); },
    /* SILHOUETTE HEIGHT IN PIXELS, off the real vertices. */
    px(key) {
      const g = c.wally.rideProps[key].group; g.updateMatrixWorld(true);
      const cam = c.camera, el = c.renderer.domElement;
      const v = new T.Vector3();
      let y0 = 1e9, y1 = -1e9, x0 = 1e9, x1 = -1e9, n = 0;
      g.traverse((o) => {
        if (!o.isMesh || !o.geometry?.attributes?.position || /outline/i.test(o.name)) return;
        const pa = o.geometry.attributes.position;
        const step = Math.max(1, Math.floor(pa.count / 64));
        for (let i = 0; i < pa.count; i += step) {
          v.fromBufferAttribute(pa, i).applyMatrix4(o.matrixWorld).project(cam);
          if (v.z >= 1) continue;
          const px = (v.x * 0.5 + 0.5) * el.clientWidth, py = (-v.y * 0.5 + 0.5) * el.clientHeight;
          if (py < y0) y0 = py; if (py > y1) y1 = py;
          if (px < x0) x0 = px; if (px > x1) x1 = px; n++;
        }
      });
      const box = new T.Box3().setFromObject(g, true).getCenter(new T.Vector3());
      return { verts: n, pxTall: n ? +(y1 - y0).toFixed(1) : null, pxWide: n ? +(x1 - x0).toFixed(1) : null,
        camDist: +cam.position.distanceTo(box).toFixed(1), fov: +cam.fov.toFixed(2),
        h: +el.clientHeight, dpr: c.renderer.getPixelRatio() };
    },
    where(key) {
      const g = c.wally.rideProps[key].group; g.updateMatrixWorld(true);
      const b = new T.Box3().setFromObject(g, true).getCenter(new T.Vector3());
      const n2 = b.clone().project(c.camera);
      return { dist: +c.camera.position.distanceTo(b).toFixed(1), behindLens: n2.z >= 1,
        inFrustum: n2.z < 1 && Math.abs(n2.x) < 1 && Math.abs(n2.y) < 1, ndcx: +n2.x.toFixed(2) };
    },
  };
});
await page.evaluate(() => { const a = window.WALLY.ctx.game.actions; a.grantRide('bike'); a.equipRide('bike'); });
await page.waitForTimeout(2000);
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
await page.waitForTimeout(1800);
const at = await page.evaluate(() => window.WALLY.ctx.wally.rideProps.bike.group.position.toArray());
P('parked-at', at.map((v) => +v.toFixed(2)));

async function drag(px, n = 1) {
  for (let i = 0; i < n; i++) {
    await page.mouse.move(640, 380); await page.mouse.down();
    for (let k = 1; k <= 6; k++) { await page.mouse.move(640 + (px * k) / 6, 380); await page.waitForTimeout(30); }
    await page.mouse.up(); await page.waitForTimeout(450);
  }
}
async function stand(d, ang = 0.6) {
  await page.evaluate(([x, z, dd, a]) => {
    const c = window.WALLY.ctx;
    const px = x + Math.cos(a) * dd, pz = z + Math.sin(a) * dd;
    const h = c.world.heightAt(px, pz);
    c.wally.setPosition(px, Number.isFinite(h) ? h : 14.5, pz);
  }, [at[0], at[2], d, ang]);
  await page.waitForTimeout(1300);
}
async function aim(key, steps = 26) {
  for (let i = 0; i < steps; i++) {
    const w = await page.evaluate((k) => window.__B.where(k), key);
    if (!w.behindLens && Math.abs(w.ndcx) < 0.3 && w.inFrustum) return w;
    await drag(200);
  }
  return null;
}
const measure = async (ms = 2600) => { await page.evaluate(() => window.__B.start('bike')); await page.waitForTimeout(ms); return page.evaluate(() => window.__B.stop()); };

P('== IN FRAME: cost and apparent size ==', null);
for (const d of [2.5, 6, 15, 30, 52, 80, 115, 138]) {
  await stand(d);
  const w = await aim('bike');
  if (!w) { P('inframe', { stood: d, aim: 'FAILED' }); continue; }
  P('inframe', { stood: d, size: await page.evaluate(() => window.__B.px('bike')), cost: await measure() });
}
P('== OFF SCREEN (turned away): cost vs distance ==', null);
for (const d of [6, 12, 20, 30, 45, 60, 78, 95, 120, 145]) {
  await stand(d);
  await aim('bike');
  await drag(200, 13);
  const w = await page.evaluate((k) => window.__B.where(k), 'bike');
  const vis = await page.evaluate(() => window.WALLY.ctx.wally.rideProps.bike.group.visible);
  P('offscreen', { stood: d, where: w, cullVisible: vis, cost: await measure() });
}
P('ERRS', errs.slice(0, 5));
await close();
