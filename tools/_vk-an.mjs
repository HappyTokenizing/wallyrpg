/* _vk-an.mjs — analysis of a _vk-drive.mjs capture. My own unwrap, my
   own distance, my own rung binning. node tools/_vk-an.mjs <file.json> */
import { readFile } from 'node:fs/promises';
const TAU = Math.PI * 2;
const f = process.argv[2];
const D = JSON.parse(await readFile(f, 'utf8'));
const rows = D.rows.filter((r) => r.wrot);
const unwrap = (d) => d - Math.round(d / TAU) * TAU;

/* rungs: bike 0/3.40/8.20, scooter 0/4.60/12.60, moto 0/8.00/22.00 */
const STEPS = {
  bike: [['coast', 0], ['cruise', 3.40], ['sprint', 8.20]],
  scooter: [['idle', 0], ['cruise', 4.60], ['fast', 12.60]],
  motorcycle: [['idle', 0], ['cruise', 8.00], ['fast', 22.00]],
}[D.ride] || [['coast', 0], ['cruise', 3.4], ['sprint', 8.2]];

function seg(pred, label) {
  let dist = 0, rev = [], maxRaw = 0, maxBack = 0, maxBackT = 0, n = 0, sp = 0, spMin = 1e9, spMax = 0;
  let odo0 = null, odo1 = null;
  const nW = rows[0].wrot.length;
  rev = new Array(nW).fill(0);
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    if (!pred(b, a)) continue;
    const d = Math.hypot(b.px - a.px, b.pz - a.pz);
    dist += d; n++; sp += b.spd; spMin = Math.min(spMin, b.spd); spMax = Math.max(spMax, b.spd);
    if (odo0 == null && b.odo != null) odo0 = a.odo;
    if (b.odo != null) odo1 = b.odo;
    for (let k = 0; k < nW; k++) {
      const raw = b.wrot[k] - a.wrot[k];
      if (Math.abs(raw) > Math.abs(maxRaw)) maxRaw = raw;
      const st = unwrap(raw);
      if (st < maxBack) { maxBack = st; maxBackT = b.t; }
      rev[k] += st;
    }
  }
  if (!n) return null;
  const R = rows[0].wr;
  const out = {
    label, frames: n, secs: +(n / 24).toFixed(2),
    speedMean: +(sp / n).toFixed(3), speedRange: [+spMin.toFixed(2), +spMax.toFixed(2)],
    metres: +dist.toFixed(4),
    odoDelta: odo1 != null && odo0 != null ? +(odo1 - odo0).toFixed(4) : null,
    wheels: R.map((r, k) => ({
      radius: r, z: rows[0].wz[k],
      revs: +(rev[k] / TAU).toFixed(4),
      demandRevPerM: +(1 / (TAU * r)).toFixed(4),
      deliverRevPerM: dist > 0.2 ? +((rev[k] / TAU) / dist).toFixed(4) : null,
      errPct: dist > 0.2 ? +((((rev[k] / TAU) / dist) / (1 / (TAU * r)) - 1) * 100).toFixed(2) : null,
    })),
    maxRawStepRad: +maxRaw.toFixed(4),
    maxBackwardStepRad: +maxBack.toFixed(4),
    maxBackwardAtT: +maxBackT.toFixed(2),
  };
  return out;
}

const ride = rows.filter((r) => r.ride > 0.98);
const out = { file: f, ride: D.ride, mode: D.mode, rows: rows.length, errs: D.errs, dbg: D.dbg };
out.whole = seg((b) => b.ride > 0.98, 'mounted');
/* per-rung bins: within 12% of the rung speed (and >0.4 m/s for the low rung) */
out.rungs = STEPS.map(([name, v]) => {
  if (v === 0) return seg((b) => b.ride > 0.98 && b.spd > 0.35 && b.spd < 1.2, name + ' (0.35-1.2 m/s)');
  const lo = v * 0.9, hi = v * 1.1;
  return seg((b) => b.ride > 0.98 && b.spd >= lo && b.spd <= hi, `${name} (${lo.toFixed(2)}-${hi.toFixed(2)} m/s)`);
}).filter(Boolean);
/* held-key plateau: the top 60% of the speed range */
const smax = Math.max(...ride.map((r) => r.spd));
out.plateau = seg((b) => b.ride > 0.98 && b.spd > smax * 0.97, `plateau >${(smax * 0.97).toFixed(2)}`);

/* crank wrap */
let cMaxRaw = 0, cRev = 0, cDist = 0;
for (let i = 1; i < rows.length; i++) {
  const a = rows[i - 1], b = rows[i];
  if (a.crot == null || b.crot == null || b.ride < 0.98) continue;
  const raw = b.crot - a.crot;
  if (Math.abs(raw) > Math.abs(cMaxRaw)) cMaxRaw = raw;
  cRev += unwrap(raw);
  cDist += Math.hypot(b.px - a.px, b.pz - a.pz);
}
out.crank = { maxRawStepRad: +cMaxRaw.toFixed(4), revs: +(cRev / TAU).toFixed(4), metres: +cDist.toFixed(3), metresPerRev: cRev ? +(cDist / (cRev / TAU)).toFixed(3) : null };

/* net travel + forward direction */
const m = ride[0], z = ride[ride.length - 1];
if (m && z) {
  const dx = z.px - m.px, dz = z.pz - m.pz;
  out.net = { dx: +dx.toFixed(3), dz: +dz.toFixed(3), fwdStart: m.fwd, dotFwd: +(dx * m.fwd[0] + dz * m.fwd[2]).toFixed(3) };
}
console.log(JSON.stringify(out, null, 1));
