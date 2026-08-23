/* _zz/shot.mjs — park a machine on a chosen cross-slope and LOOK at it.
   Finds a site whose stand-side ground demands `want` degrees of extra
   roll, parks through the real path, frames it broadside and shoots.
   node tools/_zz/shot.mjs <ride> <wantExtraDeg> <out.png> [roadOnly]
*/
import { boot } from '../_jj/lib.mjs';
const RIDE = process.argv[2] || 'bike';
const WANT = +(process.argv[3] || 12);
const OUT = process.argv[4] || '/tmp/zz-park.png';
const ROAD = process.argv[5] === 'road';
const { page, errs, close } = await boot();

const info = await page.evaluate(([ride, want, roadOnly]) => {
  const W = window.WALLY, T = W.THREE, c = W.ctx;
  const b = c.world.bounds;
  const HEAD = [0.37, 1.19, 2.41, 4.02, 5.51];
  let best = null; let hi = 0;
  for (let x = b.min.x + 0.37; x <= b.max.x; x += 7.3) {
    for (let z = b.min.z + 0.63; z <= b.max.z; z += 7.3) {
      const h = c.world.heightAt(x, z);
      if (!Number.isFinite(h) || h < c.world.seaLevel + 0.15) continue;
      if (roadOnly && !c.world.isRoad(x, z)) continue;
      const yaw = HEAD[hi++ % HEAD.length];
      const p = W.debug.parkProbe(x, z, yaw, ride);
      if (p.error || p.clamped || p.rollRawDeg == null) continue;
      const ex = p.rollRawDeg - p.leanDeg;
      const d = Math.abs(ex - want);
      if (!best || d < best.d) best = { d, x, z, yaw, p, ex };
    }
  }
  if (!best) return { error: 'no site' };
  const p = W.debug.parkProbe(best.x, best.z, best.yaw, ride, true);
  /* frame it broadside from the stand side, a little above */
  const g = c.wally.rideProps[p.ride].group;
  g.updateMatrixWorld(true);
  const pos = g.position.clone();
  const yaw = best.yaw;
  const lat = new T.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  const cam = c.camera;
  cam.position.copy(pos).addScaledVector(lat, 2.6).add(new T.Vector3(0, 1.05, 0));
  cam.lookAt(pos.x, pos.y + 0.42, pos.z);
  cam.updateProjectionMatrix();
  if (c.cam?.setEnabled) c.cam.setEnabled(false);
  c.wally.root.visible = false;
  if (c.ui?.setVisible) c.ui.setVisible(false);
  return { at: [best.x, best.z], yaw: best.yaw, extraDeg: +best.ex.toFixed(2),
    rollDeg: p.rollDeg, leanDeg: p.leanDeg, pitchDeg: p.pitchDeg,
    gradientDeg: p.gradientDeg, wheels: p.wheels, standFootMM: p.standFootMM,
    rollClamped: p.rollClamped };
}, [RIDE, WANT, ROAD]);

console.log(JSON.stringify(info));
await page.waitForTimeout(400);
await page.screenshot({ path: OUT });
if (errs.length) console.log('ERRS', errs.slice(0, 4));
await close();
