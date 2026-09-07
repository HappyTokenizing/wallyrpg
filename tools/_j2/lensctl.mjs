/* Positive control for the containment test: a point KNOWN to be inside the
   envelope must read odd, and a point known to be outside must read even. */
import { boot } from './lib.mjs';
const { page, close } = await boot({ settle: 4500 });
await page.evaluate(() => { WALLY.debug.balloon({ alt: 40 }); WALLY.debug.balloonStick(0,0); });
await page.waitForTimeout(3000);
const r = await page.evaluate(() => {
  const T = WALLY.THREE;
  let prop = null;
  WALLY.ctx.scene.traverse(o => { if (o.name === 'balloon.envelope') prop = o; });
  prop.updateWorldMatrix(true, false);
  if (!prop.geometry.boundingSphere) prop.geometry.computeBoundingSphere();
  const c = prop.geometry.boundingSphere.center.clone().applyMatrix4(prop.matrixWorld);
  const test = (p) => {
    const rc = new T.Raycaster();
    const dir = new T.Vector3(0.7071, 0.2, 0.6794).normalize();
    rc.set(p, dir); rc.far = 900;
    const om = prop.material.side; prop.material.side = T.DoubleSide;
    const h = rc.intersectObject(prop, false); prop.material.side = om;
    return { hits: h.length, odd: (h.length % 2) === 1, first: h.length ? +h[0].distance.toFixed(2) : null };
  };
  /* the envelope's own middle — a little above the bounding-sphere centre so
     it is unambiguously in the gas space, not near the throat */
  const inside = c.clone(); inside.y += 1.0;
  const outside = c.clone(); outside.x += 60;
  return { centre: c.toArray().map(v=>+v.toFixed(2)),
    INSIDE: test(inside), OUTSIDE: test(outside),
    lens: test(WALLY.ctx.camera.position.clone()),
    lensPos: WALLY.ctx.camera.position.toArray().map(v=>+v.toFixed(2)),
    lensToCentre: +WALLY.ctx.camera.position.distanceTo(c).toFixed(2) };
});
await close();
console.log(JSON.stringify(r, null, 1));
