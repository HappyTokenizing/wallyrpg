/* _vk-id.mjs — the closing identity. Two independent legs:

   (a) wheel.rotation.x === wrap(odometer / r) to float precision, at
       every frame and every speed. This tests the drive itself with no
       sampling-rate assumption at all.
   (b) odometer === metres actually travelled, measured from the
       controller's own simPosition. (a)+(b) is the whole claim.

   Also: the exact size of every discontinuity in the RAW angle series,
   expressed in turns, and what it leaves behind modulo the wheel's
   spoke symmetry (5 diametric capsules = 36 degrees of symmetry).

   node tools/_vk-id.mjs <capture.json> [spokeDeg]
*/
import { readFile } from 'node:fs/promises';
const TAU = Math.PI * 2;
const D = JSON.parse(await readFile(process.argv[2], 'utf8'));
const SYM = +(process.argv[3] || 36) * Math.PI / 180;
const rows = D.rows.filter((r) => r.ride > 0.98 && r.wrot && r.odo != null);
const out = { file: process.argv[2], ride: D.ride, mode: D.mode, frames: rows.length };
if (!rows.length) { out.note = 'no odometer in this capture (pre-fix build)'; }

if (rows.length) {
  let worst = 0, worstT = 0;
  for (const r of rows) {
    for (let k = 0; k < r.wrot.length; k++) {
      const want = ((r.odo / r.wr[k]) % TAU + TAU) % TAU;
      let e = Math.abs(r.wrot[k] - want);
      e = Math.min(e, Math.abs(e - TAU));
      if (e > worst) { worst = e; worstT = r.t; }
    }
  }
  out.identity = { maxAbsErrRad: +worst.toExponential(3), atT: +worstT.toFixed(2) };
  let dist = 0;
  for (let i = 1; i < rows.length; i++) dist += Math.hypot(rows[i].px - rows[i - 1].px, rows[i].pz - rows[i - 1].pz);
  const odo = rows[rows.length - 1].odo - rows[0].odo;
  out.odoVsGround = { odometreDelta: +odo.toFixed(4), measuredMetres: +dist.toFixed(4), diffPct: +((odo / dist - 1) * 100).toFixed(3) };
}

/* raw discontinuities, in turns, and what survives the spoke symmetry */
const all = D.rows.filter((r) => r.ride > 0.98 && r.wrot);
const jumps = [];
for (let i = 1; i < all.length; i++) {
  const raw = all[i].wrot[0] - all[i - 1].wrot[0];
  if (Math.abs(raw) > Math.PI) jumps.push({ t: +all[i].t.toFixed(2), raw: +raw.toFixed(5), turns: +(raw / TAU).toFixed(4), spd: +all[i].spd.toFixed(2) });
}
jumps.sort((a, b) => Math.abs(b.raw) - Math.abs(a.raw));
const visible = (a) => { let x = a % SYM; if (x > SYM / 2) x -= SYM; if (x < -SYM / 2) x += SYM; return +(x * 180 / Math.PI).toFixed(2); };
out.rawJumps = {
  count: jumps.length,
  largest: jumps[0] ? { ...jumps[0], visibleDegAfterSpokeSymmetry: visible(jumps[0].raw) } : null,
  turnsHistogram: jumps.reduce((m, j) => { const k = j.turns.toFixed(2); m[k] = (m[k] || 0) + 1; return m; }, {}),
};
console.log(JSON.stringify(out, null, 1));
