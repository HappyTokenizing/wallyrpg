/* The load-bearing facts the comments state about the props: the mesh
   and triangle budget, the widths PARK_CLEAR_M is chosen against, the
   kickstand actually touching the ground at PARK_LEAN, the motors'
   steering group in the wheel's parent chain, and parkedCull's two
   distances. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot({ wait: 4500 });

const facts = await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx, T = W.THREE;
  const out = {};
  for (const id of ['bike', 'scooter', 'motorcycle']) {
    c.wally.setBike(true, { ride: id, instant: true });
    const p = c.wally.rideProps[id], g = p.group;
    let body = 0, hull = 0, tris = 0, bodyTris = 0;
    const mats = new Set(), geos = new Set(), bodyMats = new Set();
    g.traverse((o) => {
      if (!o.isMesh) return;
      const n = o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3;
      tris += n;
      if (o.userData.isOutlineHull) { hull++; } else { body++; bodyTris += n; bodyMats.add(o.material); }
      mats.add(o.material); geos.add(o.geometry);
    });
    g.updateMatrixWorld(true);
    const b = new T.Box3().setFromObject(g);
    const sz = b.getSize(new T.Vector3());
    /* the kickstand, parked: where its far end lands relative to the
       group's own ground line */
    const stand = g.getObjectByName('kickstand');
    out[id] = { bodyMeshes: body, hulls: hull, meshes: body + hull,
      triangles: Math.round(tris), bodyTriangles: Math.round(bodyTris),
      materials: mats.size, bodyMaterials: bodyMats.size, geometries: geos.size,
      widthX: +sz.x.toFixed(3), lengthZ: +sz.z.toFixed(3), heightY: +sz.y.toFixed(3),
      parkLean: p.parkLean, standNamed: !!stand,
      frustumCulledAll: (() => { let all = true; g.traverse((o) => { if (o.isMesh && !o.frustumCulled) all = false; }); return all; })(),
      wheelParents: p.wheels.map((w) => { const ch = []; for (let n = w.parent; n && n !== g; n = n.parent) ch.push(n.type + (n.name ? ':' + n.name : '')); return ch; }),
      wheelAxleY: p.wheels.map((w) => +w.position.y.toFixed(4)),
    };
    c.wally.setBike(false, { instant: true });
  }
  return out;
});
for (const k of Object.keys(facts)) P('PROP-' + k, facts[k]);

/* the kickstand foot, on the ground, in the real parked pose */
const stand = await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx, T = W.THREE;
  const r = W.debug.parkProbe(c.wally.root.position.x, c.wally.root.position.z, 0, 'bike');
  const p = c.wally.rideProps.bike, g = p.group;
  /* parkProbe puts it away again; park it by hand in the same pose to
     read the stand's tip */
  g.rotation.order = 'YXZ'; g.rotation.set(0, 0, 0); p.park(true);
  g.updateMatrixWorld(true);
  const s = g.getObjectByName('kickstand');
  if (!s) return { none: true };
  const box = new T.Box3().setFromObject(s);
  return { visible: s.visible, rollDeg: +(g.rotation.z * 57.2958).toFixed(3),
    tipYWorldMinusGroupY: +(box.min.y - g.position.y).toFixed(4),
    probeWheels: (r.wheels || []).map((w) => w.errMM) };
});
P('KICKSTAND', stand);

/* parkedCull: is a parked machine past PARK_DRAW_M kept while it is in
   shot, and dropped when it is not? */
const cull = await page.evaluate(async () => {
  const W = window.WALLY, c = W.ctx, T = W.THREE;
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  W.debug.giveRide('bike');
  await frame();
  c.game.actions.equipRide(null);
  for (let i = 0; i < 60; i++) await frame();
  const p = c.wally.rideProps.bike, g = p.group;
  const rows = [];
  for (const [d, behind] of [[30, false], [30, true], [70, false], [70, true], [100, false], [130, false], [150, false]]) {
    const cam = c.camera; cam.updateMatrixWorld(true);
    const f = new T.Vector3(0, 0, -1).applyQuaternion(cam.quaternion); f.y = 0; f.normalize();
    const s = behind ? -1 : 1;
    g.position.set(cam.position.x + f.x * d * s, cam.position.y - 1.2, cam.position.z + f.z * d * s);
    await frame(); await frame();
    rows.push({ d, behind, visible: g.visible, parked: c.wally.bikeState.parked.map((q) => q.id) });
  }
  return rows;
});
for (const r of cull) P('CULL', r);
P('ERRS', errs.slice(0, 8));
await close();
