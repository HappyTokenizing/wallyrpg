/* _pj/figures.mjs — the published bicycle figures, re-measured.
   (a) the mesh/triangle/material/geometry census
   (b) apparent height in CSS px: painted-only vs with the §2.2 hulls,
       on the optical axis vs from a LEVEL camera, list re-gathered at
       every range
   (c) the thin-lens cross-check
   Traps handled: hull meshes excluded by name AND by material family;
   the vertex list is never captured once; the camera is explicit. */
import { boot } from './lib.mjs';
const { page, errs, close } = await boot();
const out = await page.evaluate(async () => {
  const W = window.WALLY, T = W.THREE, c = W.ctx;
  const mod = await import('/src/character/bike.js');
  const prop = mod.createBike(c);
  prop.park(true);
  c.scene.add(prop.group);
  prop.group.updateMatrixWorld(true);

  /* ---- (a) the census ---- */
  const meshes = [];
  prop.group.traverse((o) => { if (o.isMesh && o.geometry?.attributes?.position) meshes.push(o); });
  const isHull = (o) => /\.outline$/.test(o.name) || (o.material && o.material.side === T.BackSide);
  const hulls = meshes.filter(isHull), body = meshes.filter((o) => !isHull(o));
  const triOf = (o) => { const g = o.geometry; return (g.index ? g.index.count : g.attributes.position.count) / 3; };
  const sum = (a) => a.reduce((s, o) => s + triOf(o), 0);
  const mats = new Set(meshes.map((o) => o.material?.uuid));
  const bodyMats = new Set(body.map((o) => o.material?.uuid));
  const hullMats = new Set(hulls.map((o) => o.material?.uuid));
  const geos = new Set(meshes.map((o) => o.geometry.uuid));
  const census = { meshes: meshes.length, body: body.length, hulls: hulls.length,
    trisTotal: sum(meshes), trisBody: sum(body), trisHull: sum(hulls),
    materials: mats.size, bodyMaterials: bodyMats.size, hullMaterials: hullMats.size,
    geometries: geos.size,
    hullNameSuffixMatches: meshes.filter((o) => /\.outline$/.test(o.name)).length,
    hullBackSideMatches: meshes.filter((o) => o.material?.side === T.BackSide).length };

  /* ---- (b)(c) apparent height ---- */
  const cam = c.camera, el = c.renderer.domElement;
  const cssH = el.clientHeight || el.height;
  if (c.cam?.setEnabled) c.cam.setEnabled(false);
  const base = c.wally.root.position.clone();
  const yaw = 0.37;
  const f = new T.Vector3(Math.sin(yaw), 0, Math.cos(yaw));

  const measure = (d, mode) => {
    const p = base.clone().addScaledVector(f, d);
    const h = c.world.heightAt(p.x, p.z);
    prop.group.position.set(p.x, Number.isFinite(h) ? h : p.y, p.z);
    prop.group.rotation.order = 'YXZ';
    prop.group.rotation.set(0, yaw + Math.PI / 2, prop.parkLean);
    prop.group.updateMatrixWorld(true);
    const eye = base.clone(); eye.y = (c.world.heightAt(base.x, base.z) ?? base.y) + 0.9;
    const bb = new T.Box3(); bb.makeEmpty();
    const vv = new T.Vector3();
    prop.group.traverse((o) => { if (!o.isMesh || isHull(o) || !o.geometry?.attributes?.position) return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) bb.expandByPoint(vv.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld)); });
    if (mode === 'axis') {
      const midY = (bb.max.y + bb.min.y) * 0.5;
      cam.position.set(eye.x, midY, eye.z);
      cam.lookAt(prop.group.position.x, midY, prop.group.position.z);
    } else { cam.position.copy(eye); cam.lookAt(eye.x + f.x, eye.y, eye.z + f.z); }
    cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
    const v = new T.Vector3();
    const span = (withHulls) => {
      let lo = Infinity, hi = -Infinity, n = 0;
      prop.group.traverse((o) => {
        if (!o.isMesh || !o.geometry?.attributes?.position) return;
        if (!withHulls && isHull(o)) return;
        if (withHulls && isHull(o) && !o.visible) return;   // toon.js culls hulls at range
        const pos = o.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).project(cam);
          const py = (1 - v.y) * 0.5 * cssH;
          if (py < lo) lo = py; if (py > hi) hi = py; n++;
        }
      });
      return { px: +(hi - lo).toFixed(2), verts: n };
    };
    const paint = span(false), all = span(true);
    const fpx = (cssH * 0.5) / Math.tan(cam.fov * Math.PI / 360);
    const dist = cam.position.distanceTo(prop.group.position);
    return { m: d, mode, paintedPx: paint.px, withHullsPx: all.px,
      hullInflationPct: +(100 * (all.px / paint.px - 1)).toFixed(2),
      paintedVerts: paint.verts, allVerts: all.verts,
      heightM: +(bb.max.y - bb.min.y).toFixed(4),
      thinLensPx: +((bb.max.y - bb.min.y) * fpx / dist).toFixed(2),
      focalPx: +fpx.toFixed(0), camDist: +dist.toFixed(2) };
  };
  const RG = [6, 12, 18, 24, 32, 40, 46, 55, 64, 122, 145];
  const axis = RG.map((d) => measure(d, 'axis'));
  const level = RG.map((d) => measure(d, 'level'));
  /* upright height, for the 1.03 vs 0.98 claim */
  prop.park(false); prop.group.rotation.set(0, 0, 0); prop.group.updateMatrixWorld(true);
  const bbU = new T.Box3(); bbU.makeEmpty(); const vu = new T.Vector3();
  prop.group.traverse((o) => { if (!o.isMesh || isHull(o) || !o.geometry?.attributes?.position) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) bbU.expandByPoint(vu.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld)); });
  const uprightH = +(bbU.max.y - bbU.min.y).toFixed(4);
  c.scene.remove(prop.group); prop.dispose();
  return { cssH, dpr: c.renderer.getPixelRatio(), fov: cam.fov, census, uprightH, axis, level,
    rideInfo: W.debug.rideInfo ? W.debug.rideInfo('bike') : null };
});
console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log('ERRS', errs.slice(0, 4));
await close();
