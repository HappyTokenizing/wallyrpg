import { boot } from './lib.mjs';
const SP = '/private/tmp/claude-501/-Users-herwig-Desktop-Claude-files/648e6001-7010-404a-9eea-f16c59f21a5d/scratchpad/';
const { page, errs, close } = await boot();
const sites = [
  { name: 'hover', x: 211.67, z: -77.571, yaw: 5.51 },
  { name: 'roadflat', x: -358.58, z: 129.16, yaw: 0.9 },
  { name: 'slope10', x: -12.5, z: -153.92, yaw: 2.1 },
];
for (const s of sites) {
  const r = await page.evaluate((sp) => {
    const W = window.WALLY, T = W.THREE, c = W.ctx;
    const p = W.debug.parkProbe(sp.x, sp.z, sp.yaw, 'bike', true);
    const pr = c.wally.rideProps.bike, g = pr.group;
    g.visible = true; g.traverse((o) => { o.visible = true; });
    c.wally.root.visible = false;
    if (c.cam?.setEnabled) c.cam.setEnabled(false);
    const cam = c.camera, yaw = g.rotation.y;
    const lat = new T.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const fwd = new T.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    cam.position.copy(g.position).addScaledVector(lat, 1.6).addScaledVector(fwd, -1.0).add(new T.Vector3(0, 1.15, 0));
    cam.lookAt(g.position.x, g.position.y + 0.30, g.position.z);
    cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
    return { standFootMM: p.standFootMM, wheels: p.wheels.map((w) => w.errMM),
      pitch: p.pitchDeg, roll: p.rollDeg, rollRaw: p.rollRawDeg, lean: p.leanDeg,
      rollClamped: p.rollClamped, clamped: p.clamped, onRoad: !!c.world.isRoad(sp.x, sp.z) };
  }, s);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: SP + 'pj-' + s.name + '.png' });
  console.log(s.name + ' ' + JSON.stringify(r));
}
if (errs.length) console.log('ERRS', errs.slice(0, 4));
await close();
