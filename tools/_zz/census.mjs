/* _zz/census.mjs — OFF-LATTICE park census through the REAL parkProp
   path (WALLY.debug.parkProbe), measuring both wheel contacts AND the
   kickstand foot, split road / whole-island.

   node tools/_zz/census.mjs <ride> <step> <offset> <tag>

   The grid step must NOT divide terrain CELL (2 m) and the headings are
   not multiples of pi/2 — a step that divides CELL with axis headings
   keeps both wheel contacts inside one terrain triangle, where the
   two-pass chord is exact by construction and the census agrees with
   itself for free.
*/
import { boot } from '../_jj/lib.mjs';

const RIDE = process.argv[2] || 'bike';
const STEP = +(process.argv[3] || 7.3);
const OFF = +(process.argv[4] || 0.37);
const TAG = process.argv[5] || '';
const HOFF = +(process.argv[6] || 0);

const { page, errs, close } = await boot();

const out = await page.evaluate(([ride, step, off, hoff]) => {
  const W = window.WALLY, T = W.THREE, c = W.ctx;
  const probe = W.debug.parkProbe;
  const b = c.world.bounds;
  /* headings deliberately off the axes and off pi/4 */
  const HEAD = [0.37, 1.19, 2.41, 4.02, 5.51].map((h) => h + hoff);

  /* --- the kickstand instrument, in the TOOL, not in the code under
     test. Lowest PAINTED vertex of the mesh named 'kickstand', in
     world y, and the axis endpoint for comparison. --- */
  const _v = new T.Vector3();
  function standFoot(group) {
    let m = null;
    group.traverse((o) => { if (o.name === 'kickstand') m = o; });
    if (!m) return null;
    m.updateMatrixWorld(true);
    const pos = m.geometry.attributes.position;
    let lo = Infinity;
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      if (_v.y < lo) lo = _v.y;
    }
    /* the axis endpoint: capsuleGeo puts the tip at local +y half-len */
    const half = (m.geometry.parameters.length || 0) * 0.5 + (m.geometry.parameters.radius || 0);
    _v.set(0, -half, 0).applyMatrix4(m.matrixWorld);
    return { paintedY: lo, axisY: _v.y, axisX: _v.x, axisZ: _v.z, loX: null };
  }
  function lowestVertexXZ(group) {
    let m = null;
    group.traverse((o) => { if (o.name === 'kickstand') m = o; });
    if (!m) return null;
    const pos = m.geometry.attributes.position;
    let lo = Infinity, bx = 0, bz = 0;
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      if (_v.y < lo) { lo = _v.y; bx = _v.x; bz = _v.z; }
    }
    return { y: lo, x: bx, z: bz };
  }

  const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; } catch (e) { return null; } };

  const acc = () => ({ n: 0, over01: 0, over1: 0, over10: 0, worst: 0, worstAt: null,
    buried1: 0, worstBuried: 0, buriedAt: null, sum: 0, sumAbs: 0 });
  const stat = () => ({ n: 0, sum: 0, hover20: 0, sunk5: 0, worstHover: 0, worstSunk: 0, hoverAt: null });
  const R = { all: acc(), road: acc() };
  const S = { all: stat(), road: stat(), free: stat(), freeRoad: stat(), painted: stat(), paintedRoad: stat() };
  let rollClamped = 0, floorHit = 0, bandHit = 0;
  const extras = [], extrasRoad = [];
  const clampedN = { all: 0, road: 0 };
  const bandRows = [];

  const push = (a, e, at) => {
    a.n++; a.sum += e; a.sumAbs += Math.abs(e);
    if (Math.abs(e) > 0.1) a.over01++;
    if (Math.abs(e) > 1) a.over1++;
    if (Math.abs(e) > 10) a.over10++;
    if (Math.abs(e) > Math.abs(a.worst)) { a.worst = e; a.worstAt = at; }
    if (e < -1) a.buried1++;
    if (e < a.worstBuried) { a.worstBuried = e; a.buriedAt = at; }
  };
  const pushS = (s, e, at) => {
    s.n++; s.sum += Math.abs(e);
    if (e > 20) s.hover20++;
    if (e < -5) s.sunk5++;
    if (e > s.worstHover) { s.worstHover = e; s.hoverAt = at; }
    if (e < s.worstSunk) s.worstSunk = e;
  };

  let sites = 0, skipped = 0, hi = 0;
  const t0 = performance.now();
  for (let x = b.min.x + off; x <= b.max.x; x += step) {
    for (let z = b.min.z + off * 1.7; z <= b.max.z; z += step) {
      const h = H(x, z);
      if (h == null || h < c.world.seaLevel + 0.15) continue;
      const yaw = HEAD[hi++ % HEAD.length];
      const p = probe(x, z, yaw, ride);
      if (p.error || !p.wheels || p.wheels.length < 2) { skipped++; continue; }
      if (p.clamped) { /* outside the clamp: not the population under test */
        clampedN.all++; continue;
      }
      const road = !!c.world.isRoad(x, z);
      sites++;
      const at = [+x.toFixed(4), +z.toFixed(4), +yaw.toFixed(4), p.gradientDeg, p.pitchIters, p.bisected, p.solveResidualMM];
      for (const w of p.wheels) {
        if (w.errMM == null) continue;
        push(R.all, w.errMM, at);
        if (road) push(R.road, w.errMM, at);
      }
      const pr = c.wally.rideProps[p.ride];
      const g = pr.group;
      if (p.rollClamped) { rollClamped++; }
      if (p.rollRawDeg != null && p.leanDeg != null) {
        const ex = p.rollRawDeg - p.leanDeg;
        extras.push(ex);
        if (road) extrasRoad.push(ex);
        if (p.rollClamped) { if (p.rollRawDeg > -2.87) floorHit++; else bandHit++; }
      }
      /* the DESIGN contact point — the stand tube's far endpoint — put
         through the group's world matrix. The painted lowest vertex
         sits a few mm below it by construction (see solveParkPose), so
         measuring the painted one alone reads as a permanent sink. */
      const F = pr.standFoot;
      if (F) {
        _v.set(F.x, F.y, F.z).applyMatrix4(g.matrixWorld);
        const th = H(_v.x, _v.z);
        if (th != null) {
          const e = (_v.y - th) * 1000;
          pushS(S.all, e, at);
          if (road) pushS(S.road, e, at);
          if (!p.rollClamped) { pushS(S.free, e, at); if (road) pushS(S.freeRoad, e, at); }
        }
      }
      const lv = lowestVertexXZ(g);
      if (lv) {
        const th = H(lv.x, lv.z);
        if (th != null) { pushS(S.painted, (lv.y - th) * 1000, at); if (road) pushS(S.paintedRoad, (lv.y - th) * 1000, at); }
      }
      if (p.gradientDeg != null && Math.abs(p.gradientDeg) > 44 && Math.abs(p.gradientDeg) < 48 && bandRows.length < 14) {
        bandRows.push({ deg: p.gradientDeg, mm: p.wheels.map((w) => w.errMM) });
      }
    }
  }
  const ms = performance.now() - t0;
  const fin = (a) => ({ contacts: a.n, over01mm: a.over01, over1mm: a.over1, over10mm: a.over10,
    worstMM: +a.worst.toFixed(1), worstAt: a.worstAt,
    buriedOver1mm: a.buried1, worstBuriedMM: +a.worstBuried.toFixed(1), buriedAt: a.buriedAt,
    meanAbsMM: +(a.sumAbs / Math.max(a.n, 1)).toFixed(3) });
  const finS = (s) => ({ sites: s.n, meanAbsMM: +(s.sum / Math.max(s.n, 1)).toFixed(1),
    hoverOver20mmPct: +(100 * s.hover20 / Math.max(s.n, 1)).toFixed(1),
    sunkOver5mmPct: +(100 * s.sunk5 / Math.max(s.n, 1)).toFixed(1),
    worstHoverMM: +s.worstHover.toFixed(1), worstSunkMM: +s.worstSunk.toFixed(1), hoverAt: s.hoverAt });
  return { ride, step, off, sites, skipped, clampedSkipped: clampedN.all, ms: +ms.toFixed(0),
    wheelsAll: fin(R.all), wheelsRoad: fin(R.road),
    rollClampedPct: +(100 * rollClamped / Math.max(sites, 1)).toFixed(1),
    floorHit, bandHit,
    extraRollDeg: (() => {
      const q = (a, f) => { const b = a.slice().sort((x, y) => x - y); return b.length ? +b[Math.floor(f * (b.length - 1))].toFixed(2) : null; };
      return { islandP05: q(extras, 0.05), islandP50: q(extras, 0.5), islandP95: q(extras, 0.95),
        roadP05: q(extrasRoad, 0.05), roadP50: q(extrasRoad, 0.5), roadP95: q(extrasRoad, 0.95),
        roadOver9_2Pct: +(100 * extrasRoad.filter((v) => Math.abs(v) > 9.2).length / Math.max(extrasRoad.length, 1)).toFixed(1) };
    })(),
    standAll: finS(S.all), standRoad: finS(S.road),
    standFreeAll: finS(S.free), standFreeRoad: finS(S.freeRoad),
    standPaintedAll: finS(S.painted), standPaintedRoad: finS(S.paintedRoad), bandRows };
}, [RIDE, STEP, OFF, HOFF]);

console.log(TAG + ' ' + JSON.stringify(out, null, 1));
if (errs.length) console.log('ERRS', errs.slice(0, 5));
await close();
