/* _pj/shot.mjs — find the worst road stand SINK and worst road HOVER
   the census leaves behind, park a bicycle there for real, and look at
   it from the stand side. Millimetres are not a substitute for looking. */
import { boot } from './lib.mjs';
const { page, errs, close } = await boot();
const found = await page.evaluate(() => {
  const W = window.WALLY, T = W.THREE, c = W.ctx, b = c.world.bounds;
  const DOC = [0.37, 1.19, 2.41, 4.02, 5.51];
  const H = (x, z) => { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : NaN; };
  let k = 0, sink = null, hover = null;
  for (let x = b.min.x + 0.37; x <= b.max.x; x += 7.3)
    for (let z = b.min.z + 0.37 * 1.7; z <= b.max.z; z += 7.3) {
      const h = H(x, z); if (!Number.isFinite(h) || h < c.world.seaLevel + 0.15) continue;
      const yaw = DOC[k++ % 5];
      if (!c.world.isRoad(x, z)) continue;
      const p = W.debug.parkProbe(x, z, yaw, 'bike', true);
      if (p.error || p.standFootMM == null) continue;
      const rec = { x: +x.toFixed(3), z: +z.toFixed(3), yaw: +yaw.toFixed(3), mm: p.standFootMM,
        pitch: p.pitchDeg, roll: p.rollDeg, rollRaw: p.rollRawDeg, lean: p.leanDeg,
        clamped: p.clamped, rollClamped: p.rollClamped, wheels: p.wheels.map((w) => w.errMM),
        grad: p.gradientDeg };
      if (!sink || rec.mm < sink.mm) sink = rec;
      if (!hover || rec.mm > hover.mm) hover = rec;
    }
  return { sink, hover };
});
console.log('FOUND ' + JSON.stringify(found));
for (const [name, s] of [['sink', found.sink], ['hover', found.hover]]) {
  if (!s) continue;
  await page.evaluate((sp) => {
    const W = window.WALLY, T = W.THREE, c = W.ctx;
    const p = W.debug.parkProbe(sp.x, sp.z, sp.yaw, 'bike', true);
    const pr = c.wally.rideProps.bike, g = pr.group;
    c.wally.root.visible = false;
    if (c.cam?.setEnabled) c.cam.setEnabled(false);
    const cam = c.camera, yaw = g.rotation.y;
    /* the stand is on the machine's +x side of the lean; look from there */
    const lat = new T.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    cam.position.copy(g.position).addScaledVector(lat, 1.9).add(new T.Vector3(0, 0.55, 0));
    cam.lookAt(g.position.x, g.position.y + 0.22, g.position.z);
    cam.updateProjectionMatrix();
    return p.standFootMM;
  }, s);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `/private/tmp/claude-501/-Users-herwig-Desktop-Claude-files/648e6001-7010-404a-9eea-f16c59f21a5d/scratchpad/stand-${name}.png` });
  console.log('SHOT ' + name + ' ' + JSON.stringify(s));
}
if (errs.length) console.log('ERRS', errs.slice(0, 4));
await close();
