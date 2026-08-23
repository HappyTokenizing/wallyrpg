/* _kk/cost.mjs — the apparent-size and draw-cost ladders, re-measured.
   Pixels are CSS pixels (domElement.clientHeight), NOT drawing-buffer
   pixels: at dpr 2 the two differ by exactly the factor the old note
   was wrong by. renderer.info.autoReset is false in this build, so
   every render here is bracketed by an explicit info.reset(). */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot();
await page.evaluate(() => { const a = window.WALLY.ctx.game.actions; a.grantRide('bike'); a.equipRide('bike'); });
await page.waitForTimeout(1800);
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
await page.waitForTimeout(1500);

const out = await page.evaluate(() => {
  const W = window.WALLY, T = W.THREE, c = W.ctx;
  const g = c.wally.rideProps.bike.group;
  g.updateMatrixWorld(true);
  const box = new T.Box3().setFromObject(g, true);
  const ctr = box.getCenter(new T.Vector3());
  const cam = c.camera, r = c.renderer, el = r.domElement;
  const dpr = r.getPixelRatio();
  const cssH = el.clientHeight, cssW = el.clientWidth;
  const worldH = box.max.y - box.min.y;

  /* every vertex of every mesh in the prop, in world space, once */
  const verts = [];
  g.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const pa = o.geometry.attributes.position;
    const v = new T.Vector3();
    for (let i = 0; i < pa.count; i++) { v.fromBufferAttribute(pa, i); o.localToWorld(v); verts.push(v.clone()); }
  });

  const pxHeight = () => {
    let y0 = 1e9, y1 = -1e9, ok = 0;
    const v = new T.Vector3();
    for (const p of verts) {
      v.copy(p).project(cam);
      if (v.z >= 1) continue;
      ok++;
      const y = (-v.y * 0.5 + 0.5) * cssH;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return ok ? +(y1 - y0).toFixed(1) : null;
  };
  const rd = () => { r.info.reset(); r.render(c.scene, cam); return { calls: r.info.render.calls, tris: r.info.render.triangles }; };
  const delta = () => {
    const was = g.visible;
    g.visible = true; rd(); const on = rd();
    g.visible = false; const off = rd();
    g.visible = was; rd();
    return { calls: on.calls - off.calls, tris: on.tris - off.tris };
  };

  const savedP = cam.position.clone(), savedQ = cam.quaternion.clone();
  const dirs = { front: new T.Vector3(0.62, 0.22, 0.75).normalize() };
  const place = (d, behind) => {
    const off = dirs.front.clone().multiplyScalar(d);
    cam.position.copy(ctr).add(off);
    cam.lookAt(behind ? ctr.clone().add(off.clone().multiplyScalar(2)) : ctr);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
  };
  /* parkedCull's own arithmetic, so the ladder can say what the game
     would actually do at this range rather than what culling alone
     leaves */
  const culled = (d) => {
    if (d < 64) return 'drawn (within PARK_DRAW_M)';
    if (d > 140) return 'hidden (past PARK_FAR_M)';
    const m = new T.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const f = new T.Frustum().setFromProjectionMatrix(m);
    const s = new T.Sphere(new T.Vector3(g.position.x, g.position.y + 0.55, g.position.z), 1.25 + 4.0);
    return f.intersectsSphere(s) ? 'drawn (in frustum)' : 'hidden by parkedCull';
  };

  const D = [24, 122, 140.7];
  const rows = [];
  for (const d of D) {
    place(d, false);
    const px = pxHeight();
    const inF = delta();
    const cullIn = culled(d);
    place(d, true);
    const offF = delta();
    const cullOut = culled(d);
    rows.push({ d, pxCSS: px, pxBuffer: px == null ? null : +(px * dpr).toFixed(1),
      inFrame: inF, offScreen: offF, parkedCullInFrame: cullIn, parkedCullOffScreen: cullOut });
  }
  cam.position.copy(savedP); cam.quaternion.copy(savedQ);
  cam.updateMatrixWorld(true); cam.updateProjectionMatrix();

  const fPx = (cssH * 0.5) / Math.tan((cam.fov * Math.PI / 180) * 0.5);
  return { dpr, cssW, cssH, buffer: [el.width, el.height], fov: cam.fov, worldH: +worldH.toFixed(3),
    focalPx: +fPx.toFixed(1), verts: verts.length,
    thinLens: D.map((d) => ({ d, px: +((worldH * fPx) / d).toFixed(1) })), rows };
});
P('frame', { dpr: out.dpr, css: [out.cssW, out.cssH], buffer: out.buffer, fov: out.fov, worldH: out.worldH, focalPx: out.focalPx, verts: out.verts });
P('thinLens', out.thinLens);
for (const r of out.rows) P('ladder', r);
P('ERRS', errs.slice(0, 4));
await close();
