/* THE 2x TRAP, demonstrated: the same apparent height in CSS pixels and
   in drawing-buffer pixels, at dpr 1 and dpr 2. */
import { boot, P } from './lib.mjs';
const DPR = +(process.argv[2] || 2);
const { page, errs, close } = await boot({ wait: 4500, dpr: DPR });
const r = await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx, T = W.THREE;
  c.wally.setBike(true, { ride: 'bike', instant: true });
  const g = c.wally.rideProps.bike.group;
  c.scene.add(g); g.rotation.set(0, 0, 0); g.visible = true;
  const cv = document.querySelector('canvas');
  const cam = c.camera; cam.updateMatrixWorld(true);
  const f = new T.Vector3(0, 0, -1).applyQuaternion(cam.quaternion); f.y = 0; f.normalize();
  const box = new T.Box3().setFromObject(g);
  const propH = box.max.y - box.min.y;
  const out = [];
  for (const d of [12, 57, 64]) {
    g.position.set(cam.position.x + f.x * d, cam.position.y - 1.2, cam.position.z + f.z * d);
    g.updateMatrixWorld(true);
    let lo = 1e9, hi = -1e9;
    const v = new T.Vector3();
    g.traverse((o) => {
      if (!o.isMesh || !o.visible || !o.geometry?.attributes?.position) return;
      const p = o.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld).project(cam);
        if (v.y < lo) lo = v.y; if (v.y > hi) hi = v.y;
      }
    });
    out.push({ d, cssPx: +(((hi - lo) / 2) * cv.clientHeight).toFixed(1),
      bufPx: +(((hi - lo) / 2) * cv.height).toFixed(1) });
  }
  const focal = (cv.clientHeight / 2) / Math.tan((cam.fov * Math.PI / 180) / 2);
  return { dpr: window.devicePixelRatio, cssHW: [cv.clientWidth, cv.clientHeight], bufHW: [cv.width, cv.height],
    propHeightM: +propH.toFixed(4), focalPxCSS: +focal.toFixed(1),
    thinLensAt57: +(propH * focal / 57).toFixed(2), rows: out };
});
P('DPR' + DPR, r);
P('ERRS', errs.slice(0, 5));
await close();
