/* THE LADDERS: apparent size in CSS pixels, the in-frame draw cost, and
   the off-screen cost — all differenced across the game's OWN frames,
   never a render() this tool calls itself (renderer.js keeps
   shadowMap.autoUpdate false and info.autoReset false; driving the
   frame myself would silently delete the shadow column and accumulate
   the counters). The prop is MOVED and the loop is allowed to run, so
   toon.js's once-per-frame hull cull sees the new position. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot({ wait: 5000, dpr: 1 });

const setup = await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx;
  /* build the bicycle prop, then put him on the SCOOTER so nothing in
     wally.js writes the bicycle's transform or visibility per frame */
  W.ctx.wally.setBike(true, { ride: 'bike', instant: true });
  W.debug.giveRide('scooter');
  const g = c.wally.rideProps.bike.group;
  c.scene.add(g);
  g.visible = false;
  g.rotation.set(0, 0, 0);
  window.__G = g;
  /* instrument: sample renderer.info at the END of each frame */
  const cv = c.render?.renderer?.domElement || document.querySelector('canvas');
  window.__SAMP = [];
  const tick = () => {
    const s = W.debug.renderInfo();
    window.__SAMP.push([s.calls, s.tris]);
    if (window.__SAMP.length > 400) window.__SAMP.shift();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return {
    dprRenderer: c.render?.renderer?.getPixelRatio?.() ?? null,
    canvasCSS: cv ? [cv.clientWidth, cv.clientHeight] : null,
    canvasBuf: cv ? [cv.width, cv.height] : null,
    devicePixelRatio: window.devicePixelRatio,
    fov: c.camera?.fov ?? null, quality: W.debug.renderInfo().quality,
    cascades: W.debug.renderInfo().cascades,
    autoReset: c.render?.renderer?.info?.autoReset ?? null,
    shadowAuto: c.render?.renderer?.shadowMap?.autoUpdate ?? null,
  };
});
P('SETUP', setup);

async function place(d, behind) {
  await page.evaluate(([dd, bh]) => {
    const c = window.WALLY.ctx, g = window.__G;
    const cam = c.camera;
    cam.updateMatrixWorld(true);
    const f = new window.WALLY.THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    f.y = 0; f.normalize();
    const s = bh ? -1 : 1;
    g.position.set(cam.position.x + f.x * dd * s, cam.position.y - 1.2, cam.position.z + f.z * dd * s);
    g.visible = true;
  }, [d, behind]);
}
async function sample(frames = 8) {
  await page.evaluate(() => { window.__SAMP.length = 0; });
  await page.waitForFunction((n) => window.__SAMP.length >= n, frames, { polling: 'raf' });
  return page.evaluate((n) => {
    const s = window.__SAMP.slice(-n + 2);       // drop the first two settling frames
    const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    return { calls: med(s.map((r) => r[0])), tris: med(s.map((r) => r[1])), n: s.length };
  }, frames);
}
async function apparentPx(d) {
  return page.evaluate((dd) => {
    const W = window.WALLY, c = W.ctx, g = window.__G, T = W.THREE;
    const cam = c.camera; cam.updateMatrixWorld(true); g.updateMatrixWorld(true);
    const cv = c.render?.renderer?.domElement || document.querySelector('canvas');
    let lo = 1e9, hi = -1e9, n = 0;
    const v = new T.Vector3();
    g.traverse((o) => {
      if (!o.isMesh || !o.visible || !o.geometry?.attributes?.position) return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).project(cam);
        if (!Number.isFinite(v.y)) continue;
        if (v.y < lo) lo = v.y; if (v.y > hi) hi = v.y; n++;
      }
    });
    const cssH = cv.clientHeight, bufH = cv.height;
    return { d: dd, cssPx: +(((hi - lo) / 2) * cssH).toFixed(1), bufPx: +(((hi - lo) / 2) * bufH).toFixed(1),
      verts: n, ndc: +(hi - lo).toFixed(5) };
  }, d);
}

/* ---- baseline: prop hidden ---- */
await page.evaluate(() => { window.__G.visible = false; });
const base = await sample(10);
P('BASELINE', base);

P('--- IN FRAME ---', {});
for (const d of [6, 12, 18, 24, 32, 40, 46, 55, 57, 64, 122, 140.7]) {
  await place(d, false);
  const px = await apparentPx(d);
  const on = await sample(10);
  await page.evaluate(() => { window.__G.visible = false; });
  const off = await sample(10);
  P('INFRAME', { d, cssPx: px.cssPx, bufPx: px.bufPx,
    calls: on.calls - off.calls, tris: on.tris - off.tris, absCalls: on.calls, baseCalls: off.calls });
}

P('--- OFF SCREEN (behind the camera) ---', {});
for (const d of [6, 12, 18, 20, 24, 40, 60, 80, 100, 120]) {
  await place(d, true);
  const on = await sample(10);
  await page.evaluate(() => { window.__G.visible = false; });
  const off = await sample(10);
  P('BEHIND', { d, calls: on.calls - off.calls, tris: on.tris - off.tris });
}

/* the thin-lens cross-check the comment offers */
const lens = await page.evaluate(() => {
  const c = window.WALLY.ctx, cv = c.render?.renderer?.domElement || document.querySelector('canvas');
  const f = (cv.clientHeight / 2) / Math.tan((c.camera.fov * Math.PI / 180) / 2);
  return { fov: c.camera.fov, focalPx: +f.toFixed(1), cssH: cv.clientHeight };
});
P('LENS', lens);
P('ERRS', errs.slice(0, 8));
await close();
