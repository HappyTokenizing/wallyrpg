/* _zz/apparent.mjs — how tall a parked machine actually is, in CSS
   pixels, at range, with a LEVEL camera.

   PAINTED VERTICES ONLY: the §2.2 outline hulls are the same meshes
   pushed out along their normals and named '<mesh>.outline', and a
   column that carries them reads about 3.5% tall — and goes on carrying
   them at ranges where toon.js has already culled every hull.

   The camera is LEVEL and the machine is straight ahead at its own
   terrain height, because the column is a thin-lens check and a tilted
   camera foreshortens a standing object. The list is re-gathered at
   every range, never captured once.
*/
import { boot } from '../_jj/lib.mjs';
const { page, errs, close } = await boot();
const out = await page.evaluate(async () => {
  const W = window.WALLY, T = W.THREE, c = W.ctx;
  const mod = await import('/src/character/bike.js');
  const prop = mod.createBike(c);
  prop.park(true);
  c.scene.add(prop.group);
  const cam = c.camera;
  const el = c.renderer.domElement;
  const cssH = el.clientHeight || el.height;
  if (c.cam?.setEnabled) c.cam.setEnabled(false);

  const measure = (d, onAxis) => {
    /* level camera, machine straight ahead on the ground */
    const yaw = 0.37;
    const f = new T.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const base = c.wally.root.position.clone();
    const p = base.clone().addScaledVector(f, d);
    const h = c.world.heightAt(p.x, p.z);
    prop.group.position.set(p.x, Number.isFinite(h) ? h : p.y, p.z);
    prop.group.rotation.order = 'YXZ';
    prop.group.rotation.set(0, yaw + Math.PI / 2, prop.parkLean);
    prop.group.updateMatrixWorld(true);
    const eye = base.clone(); eye.y = (c.world.heightAt(base.x, base.z) ?? base.y) + 0.9;
    cam.position.copy(eye);
    /* LEVEL: look at the same height, not at the machine */
    if (onAxis) {
      /* the machine centred on the optical axis, which is the ONLY
         geometry in which h*f/d is exact — an object below the axis
         projects a little taller than the thin lens says */
      const bb = new T.Box3().setFromObject(prop.group, true);
      cam.position.set(eye.x, (bb.max.y + bb.min.y) * 0.5, eye.z);
      cam.lookAt(prop.group.position.x, (bb.max.y + bb.min.y) * 0.5, prop.group.position.z);
    } else cam.lookAt(eye.x + f.x, eye.y, eye.z + f.z);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    const v = new T.Vector3();
    let lo = Infinity, hi = -Infinity, n = 0;
    prop.group.traverse((o) => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return;
      if (/\.outline$/.test(o.name)) return;          // §2.2 hull, not paint
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).project(cam);
        const py = (1 - v.y) * 0.5 * cssH;
        if (py < lo) lo = py;
        if (py > hi) hi = py;
        n++;
      }
    });
    /* thin lens, for the cross-check: focal in px = (h/2)/tan(fov/2) */
    const fpx = (cssH * 0.5) / Math.tan(cam.fov * Math.PI / 360);
    const box = new T.Box3().setFromObject(prop.group, true);
    return { m: d, px: +(hi - lo).toFixed(2), verts: n,
      thinLensPx: +((box.max.y - box.min.y) * fpx / d).toFixed(2),
      heightM: +(box.max.y - box.min.y).toFixed(3), focalPx: +fpx.toFixed(0) };
  };
  const RG = [12, 32, 55, 57, 64, 122, 140.7, 145];
  const rows = RG.map((d) => measure(d, false));
  const onAxis = RG.map((d) => measure(d, true));
  c.scene.remove(prop.group); prop.dispose();
  return { cssH, fov: cam.fov, rows, onAxis };
});
console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log('ERRS', errs.slice(0, 4));
await close();
