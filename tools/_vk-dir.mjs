/* _vk-dir.mjs — direction of travel, measured; and dz at the top and
   bottom of each circle for ankle / crank plate / wheel rim, in the
   root's own frame. node tools/_vk-dir.mjs <capture.json> */
import { readFile } from 'node:fs/promises';
const D = JSON.parse(await readFile(process.argv[2], 'utf8'));
const rows = D.rows.filter((r) => r.ride > 0.98 && r.rimR);
/* the plateau only: constant speed, no accel transient */
const smax = Math.max(...rows.map((r) => r.spd));
const R = rows.filter((r) => r.spd > smax * 0.97);

/* ---- travel, measured against his OWN forward, frame by frame ---- */
let along = 0, lateral = 0, path = 0;
for (let i = 1; i < R.length; i++) {
  const a = R[i - 1], b = R[i];
  const dx = b.px - a.px, dz = b.pz - a.pz;
  along += dx * a.fwd[0] + dz * a.fwd[2];
  lateral += dx * -a.fwd[2] + dz * a.fwd[0];
  path += Math.hypot(dx, dz);
}

/* ---- dz at the top / bottom of each marker's own circle ----
   For every sample whose y is a local extreme against BOTH neighbours,
   take the one-sided dz. Report the sign census, not one sample: a
   single extremum at 24 fps on a wheel turning 15 rad/s is luck. */
function census(key) {
  const pts = R.map((r) => r[key]).filter(Boolean);
  if (pts.length < 5) return null;
  const top = [], bot = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const y = pts[i][1], dz = pts[i + 1][2] - pts[i][2];
    if (y > pts[i - 1][1] && y > pts[i + 1][1]) top.push(dz);
    if (y < pts[i - 1][1] && y < pts[i + 1][1]) bot.push(dz);
  }
  const stat = (a) => a.length ? {
    n: a.length, pos: a.filter((v) => v > 0).length, neg: a.filter((v) => v < 0).length,
    meanDz: +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(5),
  } : null;
  const ys = pts.map((p) => p[1]);
  return { top: stat(top), bottom: stat(bot), yRange: +(Math.max(...ys) - Math.min(...ys)).toFixed(4) };
}

console.log(JSON.stringify({
  file: process.argv[2], ride: D.ride, mode: D.mode,
  plateauFrames: R.length, speed: +(R.reduce((s, r) => s + r.spd, 0) / R.length).toFixed(3),
  travelAlongOwnForward: +along.toFixed(3),
  travelLateral: +lateral.toFixed(3),
  pathLength: +path.toFixed(3),
  ankleL: census('ankL'), pedalL: census('pedalL'),
  rimRear: census('rimR'), rimFront: census('rimF'), crankTip: census('crankTip'),
}, null, 1));
