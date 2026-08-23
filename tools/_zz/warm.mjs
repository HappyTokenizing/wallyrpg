/* _zz/warm.mjs — the controller's own speed series at a rung, stepped
   by hand exactly the way driveTrace's travel probe steps it. Nothing
   here calls driveTrace: it is the independent ruler for the question
   "does planarSpeed ever stop moving by 1e-4 m/s a frame".
   node tools/_zz/warm.mjs <ride> <speed>
*/
import { boot } from '../_jj/lib.mjs';
const RIDE = process.argv[2] || 'bike';
const SPD = +(process.argv[3] || 5.2);
const { page, errs, close } = await boot();

const out = await page.evaluate(([ride, speed]) => {
  const W = window.WALLY, T = W.THREE, c = W.ctx;
  const ctrl = c.phys?.controller || c.controller || c.phys?.player;
  if (!ctrl) return { error: 'no controller on ctx', keys: Object.keys(c.phys || {}) };
  const spots = [];
  const P0 = c.wally.root.position.clone();
  /* five spots: the spawn and four points 25 m out on odd headings */
  spots.push([P0.x, P0.z]);
  for (const a of [0.61, 2.13, 3.77, 5.02]) spots.push([P0.x + Math.cos(a) * 25, P0.z + Math.sin(a) * 25]);
  const res = [];
  const savedFn = ctrl._inputFn || null;
  const savedPos = ctrl.simPosition.clone();
  const savedVel = ctrl.velocity.clone();
  for (const [sx, sz] of spots) {
    const h = c.world.heightAt(sx, sz);
    if (!Number.isFinite(h)) continue;
    c.wally.setRide(ride, { instant: true });
    ctrl.teleport(new T.Vector3(sx, h + 0.2, sz));
    ctrl.velocity.set(0, 0, 0);
    const yaw0 = ctrl.yaw;
    const O = ctrl.opts || {};
    const vWalk = O.walkSpeed || 5.10, vRun = O.runSpeed || vWalk;
    const want = Math.max(0, Math.min(speed, vRun));
    const useRun = want > vWalk + 1e-4;
    const mag = Math.max(0, Math.min(want / Math.max(useRun ? vRun : vWalk, 1e-4), 1));
    ctrl.setInputFn(() => ({ x: Math.sin(yaw0) * mag, z: Math.cos(yaw0) * mag, run: useRun }));
    const S = [];
    for (let i = 0; i < 400; i++) { ctrl.step(1 / 60); S.push(ctrl.planarSpeed); }
    /* per-frame |ds| over the LAST 200 frames, i.e. long past any accel */
    const tail = S.slice(200);
    const d = [];
    for (let i = 1; i < tail.length; i++) d.push(Math.abs(tail[i] - tail[i - 1]));
    d.sort((a, b) => a - b);
    const q = (f) => +d[Math.floor(f * (d.length - 1))].toExponential(2);
    const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
    res.push({ at: [+sx.toFixed(0), +sz.toFixed(0)], want: +want.toFixed(2),
      tailMean: +mean.toFixed(4),
      tailMin: +Math.min(...tail).toFixed(4), tailMax: +Math.max(...tail).toFixed(4),
      spreadPct: +(100 * (Math.max(...tail) - Math.min(...tail)) / mean).toFixed(3),
      dsMedian: q(0.5), dsP90: q(0.9), dsMax: q(1),
      framesUnder1e4: d.filter((v) => v < 1e-4).length, of: d.length,
      /* longest run of consecutive frames under 1e-4 in the tail */
      longestHold: (() => { let b = 0, r = 0; for (let i = 1; i < tail.length; i++) { if (Math.abs(tail[i] - tail[i - 1]) < 1e-4) { r++; b = Math.max(b, r); } else r = 0; } return b; })(),
      /* and the same for a RELATIVE eps of 2e-4 * want */
      longestHoldRel: (() => { const e = 2e-4 * want; let b = 0, r = 0; for (let i = 1; i < tail.length; i++) { if (Math.abs(tail[i] - tail[i - 1]) < e) { r++; b = Math.max(b, r); } else r = 0; } return b; })(),
      /* THE TREND, which is what "still accelerating" actually is:
         mean of the last 30 frames against the mean of the 30 before,
         as a fraction of the requested rung. */
      trend: (() => {
        const M = (a, b2) => { let s2 = 0; for (let i = a; i < b2; i++) s2 += S[i]; return s2 / (b2 - a); };
        const tr = (i) => Math.abs(M(i - 29, i + 1) - M(i - 59, i - 29)) / Math.max(want, 1e-3);
        let first = null, held = 0;
        for (let i = 60; i < S.length; i++) {
          if (tr(i) < 0.002) { held++; if (held >= 6 && first == null) first = i; } else held = 0;
        }
        let tailMaxTrend = 0;
        for (let i = 200; i < S.length; i++) tailMaxTrend = Math.max(tailMaxTrend, tr(i));
        let accelMaxTrend = 0;
        for (let i = 60; i < Math.min(120, S.length); i++) accelMaxTrend = Math.max(accelMaxTrend, tr(i));
        return { settleFrame: first, speedAtSettle: first == null ? null : +S[first].toFixed(3),
          tailMaxTrendPct: +(tailMaxTrend * 100).toFixed(3),
          earlyMaxTrendPct: +(accelMaxTrend * 100).toFixed(3) };
      })(),
    });
  }
  ctrl.setInputFn(savedFn); ctrl.teleport(savedPos); ctrl.velocity.copy(savedVel);
  return { ride, speed, res };
}, [RIDE, SPD]);
console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log('ERRS', errs.slice(0, 4));
await close();
