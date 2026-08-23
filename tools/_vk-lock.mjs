/* _vk-lock.mjs — PHASE-LOCK ruler, sample-rate independent.

   THE REASON THIS EXISTS. Unwrapping a wheel angle frame by frame is
   only valid while the wheel turns less than PI between samples. My
   capture rig runs the game at ~24 fps under SwiftShader, and a
   motorcycle at 21 m/s on a 262 mm wheel turns 3.3 rad per frame —
   past Nyquist — so a frame-differenced unwrap folds it backwards and
   reports a NEGATIVE rev/m. That is my instrument misreading, not the
   game: I caught it doing exactly that on moto rung 22.

   So do not difference. Predict. Expected angle at sample i is the
   MEASURED ground distance so far divided by that wheel's own radius;
   the residual (actual - expected), wrapped, is flat and constant for
   a drivetrain that is exactly tyre-bound, drifts linearly if the rate
   is wrong, and STEPS if the angle jumps. The residual moves slowly
   even when the wheel does not, so unwrapping IT is always valid.

   node tools/_vk-lock.mjs <capture.json> [minSpeed] [maxSpeed]
*/
import { readFile } from 'node:fs/promises';
const TAU = Math.PI * 2;
const wrapPi = (a) => { let x = a % TAU; if (x > Math.PI) x -= TAU; if (x < -Math.PI) x += TAU; return x; };
const D = JSON.parse(await readFile(process.argv[2], 'utf8'));
const lo = process.argv[3] ? +process.argv[3] : -1;
const hi = process.argv[4] ? +process.argv[4] : 1e9;
let rows = D.rows.filter((r) => r.ride > 0.98 && r.wrot);
const smax = Math.max(...rows.map((r) => r.spd));
if (lo < 0) rows = rows.filter((r) => r.spd > smax * 0.97);   // the plateau
else rows = rows.filter((r) => r.spd >= lo && r.spd <= hi);
if (rows.length < 8) { console.log(JSON.stringify({ error: 'too few frames', n: rows.length })); process.exit(0); }

const nW = rows[0].wrot.length;
const out = { file: process.argv[2], ride: D.ride, mode: D.mode, frames: rows.length,
  speed: +(rows.reduce((s, r) => s + r.spd, 0) / rows.length).toFixed(3),
  speedRange: [+Math.min(...rows.map((r) => r.spd)).toFixed(2), +Math.max(...rows.map((r) => r.spd)).toFixed(2)],
  radPerFrame: +(rows.reduce((s, r) => s + r.spd, 0) / rows.length / rows[0].wr[0] / 24).toFixed(3),
  wheels: [] };

let dist = 0;
const cum = [0];
for (let i = 1; i < rows.length; i++) {
  dist += Math.hypot(rows[i].px - rows[i - 1].px, rows[i].pz - rows[i - 1].pz);
  cum.push(dist);
}
out.metres = +dist.toFixed(3);

for (let k = 0; k < nW; k++) {
  const r0 = rows[0].wr[k];
  let prev = wrapPi(rows[0].wrot[k] - cum[0] / r0), acc = prev, maxJump = 0, maxJumpAt = 0;
  const res = [acc];
  for (let i = 1; i < rows.length; i++) {
    const cur = wrapPi(rows[i].wrot[k] - cum[i] / r0);
    const d = wrapPi(cur - prev);
    if (Math.abs(d) > Math.abs(maxJump)) { maxJump = d; maxJumpAt = rows[i].t; }
    acc += d; prev = cur;
    res.push(acc);
  }
  /* least-squares slope of residual (rad) against distance (m) */
  const n = res.length;
  const mx = cum.reduce((s, v) => s + v, 0) / n, my = res.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (cum[i] - mx) * (res[i] - my); sxx += (cum[i] - mx) ** 2; }
  const slope = sxx > 1e-9 ? sxy / sxx : 0;           // rad per metre of drift
  const demand = 1 / (TAU * r0);
  const deliver = demand + slope / TAU;
  out.wheels.push({
    z: rows[0].wz[k], radius: r0,
    demandRevPerM: +demand.toFixed(4),
    deliverRevPerM: +deliver.toFixed(4),
    errPct: +((deliver / demand - 1) * 100).toFixed(3),
    residualDriftRad: +(Math.max(...res) - Math.min(...res)).toFixed(4),
    residualSpanDeg: +((Math.max(...res) - Math.min(...res)) * 180 / Math.PI).toFixed(2),
    maxResidualJumpRad: +maxJump.toFixed(4), atT: +maxJumpAt.toFixed(2),
  });
}
console.log(JSON.stringify(out, null, 1));
