/* p1 — THE INTRO BICYCLE SHOT. Seek the director to the arrival beat and
   sample, every frame, in Wally's ROOT frame:
     ankleL/ankleR  (footL/footR bones, after every solve)
     pedalL         (the LEFT pedal plate box on the prop's crank)
     crank.rotation.x, both wheel rotation.x, prop odometer
   plus the root's world position, so travel is measured and not assumed.
   Nothing is read from a debug ruler. */
import { boot, unwrapSum, periodSamples } from './lib.mjs';
import { writeFile } from 'node:fs/promises';

const { page, browser, server, errs } = await boot({ w: 960, h: 600 });

await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE;
  const rows = [];
  const inv = new T.Matrix4(), V = new T.Vector3();
  const loc = (o, x, y, z) => { V.set(x || 0, y || 0, z || 0); o.localToWorld(V); V.applyMatrix4(inv); return [V.x, V.y, V.z]; };
  window.__P1 = { rows, on: false, start() { rows.length = 0; this.on = true; }, stop() { this.on = false; return rows; } };
  c._handles.push({ lateUpdate() {
    const S = window.__P1; if (!S.on) return;
    const w = c.wally; if (!w) return;
    const g = c.scene.getObjectByName('intro.bicycle');
    const root = w.root; root.updateMatrixWorld(true);
    inv.copy(root.matrixWorld).invert();
    const r = { t: c.elapsed, pos: [root.position.x, root.position.y, root.position.z], yaw: root.rotation.y,
      ankL: loc(w.bones.footL, 0, 0, 0), ankR: loc(w.bones.footR, 0, 0, 0), vis: g ? g.visible : null };
    const act = w.animator && w.animator.action;
    if (act) { r.act = act.name; r.actT = act.time; r.actDur = act.clip && act.clip.duration; r.actCycle = act.clip && act.clip.cycle; r.actSpeed = act.speed; }
    if (g && g.visible) {
      /* the crank group: the child whose own children include two groups
         each carrying a Box (the pedal plate) */
      let crank = null;
      g.traverse((o) => { if (!crank && o.isGroup && o.children.filter((k) => k.isGroup).length === 2
        && o.children.some((k) => k.isGroup && k.children.some((m) => m.isMesh && m.geometry && m.geometry.type === 'BoxGeometry'))) crank = o; });
      if (crank) {
        r.crankRot = crank.rotation.x;
        const arm = crank.children.find((k) => k.isGroup && k.position.x > 0);
        const plate = arm && arm.children.find((k) => k.isMesh && k.geometry && k.geometry.type === 'BoxGeometry');
        if (plate) r.pedalL = loc(plate, 0, 0, 0);
        const armR = crank.children.find((k) => k.isGroup && k.position.x < 0);
        const plateR = armR && armR.children.find((k) => k.isMesh && k.geometry && k.geometry.type === 'BoxGeometry');
        if (plateR) r.pedalR = loc(plateR, 0, 0, 0);
      }
      const wheels = g.children.filter((k) => k.isGroup && k.children.length >= 7 && k.children.every((m) => m.isMesh));
      if (wheels.length >= 2) {
        const fr = wheels[0].position.z > wheels[1].position.z ? wheels[0] : wheels[1];
        const re = fr === wheels[0] ? wheels[1] : wheels[0];
        r.wrotF = fr.rotation.x; r.wrotR = re.rotation.x; r.wrad = re.position.y;
        r.rimR = loc(re, 0, re.position.y, 0);
      }
      r.gpos = [g.position.x, g.position.y, g.position.z];
    }
    rows.push(r);
  } });
});

const mark = await page.evaluate(() => window.WALLY.debug.introShot(4));
await page.waitForTimeout(400);
await page.evaluate(() => window.__P1.start());
/* the ride runs t 19.30 -> 26.667; mark 4 lands at 20.0 */
const shots = [];
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(1000);
  const p = `/tmp/vjJ-intro-${i}.png`;
  await page.screenshot({ path: p });
  shots.push(p);
}
const rows = await page.evaluate(() => window.__P1.stop());

const R = rows.filter((r) => r.pedalL && r.crankRot != null);
const TAU = Math.PI * 2;
let dist = 0;
for (let i = 1; i < R.length; i++) dist += Math.hypot(R[i].pos[0] - R[i - 1].pos[0], R[i].pos[2] - R[i - 1].pos[2]);
const crankRad = unwrapSum(R.map((r) => r.crankRot));
const wheelRadR = unwrapSum(R.map((r) => r.wrotR));
const wheelRadF = unwrapSum(R.map((r) => r.wrotF));

/* leg cycles, measured off the ANKLE ITSELF, not off any published phase:
   the autocorrelation period of the left ankle's height. */
const dt = R.length > 1 ? (R[R.length - 1].t - R[0].t) / (R.length - 1) : 1 / 60;
const per = periodSamples(R.map((r) => r.ankL[1]));
/* crank period the same way, off the pedal plate's height, so the two are
   compared through the SAME estimator */
const perPed = periodSamples(R.map((r) => r.pedalL[1]));

/* worst ankle-to-pedal gap, every frame, three ways */
let worst3 = 0, worstSag = 0, worstVert = 0, best3 = 1e9;
const offs = [];
for (const r of R) {
  const dx = r.ankL[0] - r.pedalL[0], dy = r.ankL[1] - r.pedalL[1], dz = r.ankL[2] - r.pedalL[2];
  worst3 = Math.max(worst3, Math.hypot(dx, dy, dz));
  best3 = Math.min(best3, Math.hypot(dx, dy, dz));
  worstSag = Math.max(worstSag, Math.hypot(dy - 0.10, dz));
  worstVert = Math.max(worstVert, Math.abs(dy));
  offs.push([dy, dz]);
}
const mx = offs.reduce((s, o) => s + o[0], 0) / offs.length, mz = offs.reduce((s, o) => s + o[1], 0) / offs.length;
const drift = offs.reduce((m, o) => Math.max(m, Math.hypot(o[0] - mx, o[1] - mz)), 0);

const out = {
  mark, n: rows.length, nRide: R.length, errs: errs.slice(0, 6), shots,
  distM: +dist.toFixed(4), dtAvg: +dt.toFixed(5),
  crankRevs: +(crankRad / TAU).toFixed(4),
  metresPerCrankRev: +(dist / (crankRad / TAU)).toFixed(4),
  ankleCycleSamples: per && +per.toFixed(3),
  pedalCycleSamples: perPed && +perPed.toFixed(3),
  metresPerAnkleCycle: per ? +((dist / (R.length - 1)) * per).toFixed(4) : null,
  metresPerPedalCycle: perPed ? +((dist / (R.length - 1)) * perPed).toFixed(4) : null,
  wheelRevsRear: +(wheelRadR / TAU).toFixed(4),
  wheelRevsFront: +(wheelRadF / TAU).toFixed(4),
  wheelRadius: R[0] && R[0].wrad,
  wheelRevPerM_delivered: +((wheelRadR / TAU) / dist).toFixed(5),
  wheelRevPerM_demanded: R[0] && R[0].wrad ? +(1 / (TAU * R[0].wrad)).toFixed(5) : null,
  fitMaxMM_3d: +(worst3 * 1000).toFixed(1), fitMinMM_3d: +(best3 * 1000).toFixed(1),
  fitMaxMM_sagittal: +(worstSag * 1000).toFixed(1),
  worstVerticalMM: +(worstVert * 1000).toFixed(1),
  fitDriftMM: +(drift * 1000).toFixed(1),
  meanOffsetMM: [+(mx * 1000).toFixed(1), +(mz * 1000).toFixed(1)],
  first: R[0], last: R[R.length - 1],
};
console.log(JSON.stringify(out, null, 1));
await writeFile('/tmp/vjJ-intro-rows.json', JSON.stringify(R));
await browser.close(); server.close();
