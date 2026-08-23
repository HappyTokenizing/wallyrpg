/* _hd/census.mjs — the park census, with the two populations the
   header was missing and one metric it should never have used.

   node tools/_hd/census.mjs <ride> <step> <off> <headingMode> <tag>
     headingMode: 'doc' the header's own five headings, 'off' golden
     angle, 'lat' the axis set (only for reproducing the old blindness)

   WHAT IS DIFFERENT FROM _pj/census.mjs
   -------------------------------------
   1. THE RESTRICTED ROAD POPULATION. world.isRoad is terrain.pathAt >
      0.35 — a painted-surface test that returns true inside building
      footprints and on 24-degree grades. "Machines are parked at doors"
      is a claim about somewhere a player can stand, so the road
      population is filtered: road at the MACHINE's own position (not
      the rider's, they are 0.62 m apart), no overlap with any city
      building's world box, and ground gradient under controller.js's
      48-degree slopeLimit. Every exclusion is counted so the filter can
      be argued with.
   2. THE PAINTED STAND IS MEASURED AS A CLEARANCE, not as a lowest
      vertex. min over painted vertices of (vertexY - heightAt(vertex))
      is the closest the drawn stand comes to the ground and is
      meaningful on any slope; the LOWEST vertex on a hillside is
      whichever one hangs furthest over the downhill, which measures the
      slope rather than the pose.
   3. The stand table's BEFORE row is derived from the SAME population
      and the same pitch as its AFTER row — pitch held, roll taken back
      to the constant lean — so the two halves are comparable.
*/
import { boot } from '../_pj/lib.mjs';

const RIDE = process.argv[2] || 'bike';
const STEP = +(process.argv[3] || 7.3);
const OFF = +(process.argv[4] || 0.37);
const HM = process.argv[5] || 'doc';
const TAG = process.argv[6] || '';

const { page, errs, close } = await boot();

const out = await page.evaluate(([ride, step, off, hm]) => {
  const W = window.WALLY, T = W.THREE, c = W.ctx;
  const probe = W.debug.parkProbe;
  const b = c.world.bounds;
  const CELL = c.world.cellSize;
  const gx0 = b.min.x, gz0 = b.min.z;
  const H = (x, z) => { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : NaN; };
  const cl = (v, a, d) => (v < a ? a : (v > d ? d : v));
  const PM = 0.838, RB = 0.26, RM = 0.035;
  const DEG = 180 / Math.PI;
  const _n = new T.Vector3();
  const gradDeg = (x, z) => Math.acos(cl(c.world.normalAt(x, z, _n).y, -1, 1)) * DEG;

  /* --- building footprints, world space, from the city records --- */
  const BOXES = [];
  try {
    const recs = c.city && c.city.locations;
    if (recs) for (const [, r] of recs) {
      if (!r || !r.box) continue;
      BOXES.push([r.box.min.x, r.box.max.x, r.box.min.z, r.box.max.z]);
    }
  } catch (e) {}
  const MARGIN = 0.5;                 // half the machine's own footprint
  const inBuilding = (x, z, m) => {
    for (let i = 0; i < BOXES.length; i++) {
      const q = BOXES[i];
      if (x > q[0] - m && x < q[1] + m && z > q[2] - m && z < q[3] + m) return true;
    }
    return false;
  };

  const _v = new T.Vector3();
  const _obj = new T.Object3D(); _obj.rotation.order = 'YXZ';
  function localContact(w, stop) { let x = 0, z = 0;
    for (let n = w; n && n !== stop; n = n.parent) { x += n.position.x; z += n.position.z; } return { x, z }; }
  function meshNamed(g, name) { let m = null; g.traverse((o) => { if (o.name === name) m = o; }); return m; }
  /* the closest the PAINTED stand comes to the ground, anywhere on it */
  function paintedClearance(m) {
    if (!m) return null;
    m.updateMatrixWorld(true);
    const pos = m.geometry?.attributes?.position; if (!pos) return null;
    let lo = Infinity;
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      const th = H(_v.x, _v.z);
      if (Number.isFinite(th)) lo = Math.min(lo, _v.y - th);
    }
    return Number.isFinite(lo) ? lo : null;
  }

  /* --- accumulators --- */
  const acc = () => ({ n: 0, o01: 0, o1: 0, o10: 0, worst: 0, worstAt: null, bur1: 0, worstBur: 0, burAt: null, sum: 0 });
  const push = (a, e, at) => { a.n++; a.sum += Math.abs(e);
    if (Math.abs(e) > 0.1) a.o01++; if (Math.abs(e) > 1) a.o1++; if (Math.abs(e) > 10) a.o10++;
    if (Math.abs(e) > Math.abs(a.worst)) { a.worst = e; a.worstAt = at; }
    if (e < -1) a.bur1++; if (e < a.worstBur) { a.worstBur = e; a.burAt = at; } };
  const fin = (a) => ({ contacts: a.n, over01: a.o01, over1: a.o1, over10: a.o10,
    worstMM: +a.worst.toFixed(2), worstAt: a.worstAt, buried1mm: a.bur1,
    worstBuriedMM: +a.worstBur.toFixed(2), buriedAt: a.burAt, meanAbsMM: +(a.sum / Math.max(a.n, 1)).toFixed(4) });
  const st = () => ({ n: 0, sum: 0, h20: 0, s5: 0, s20: 0, wh: 0, ws: 0, whAt: null, wsAt: null, vals: [] });
  const pushS = (s, e, at) => { s.n++; s.sum += Math.abs(e); s.vals.push(e);
    if (e > 20) s.h20++; if (e < -5) s.s5++; if (e < -20) s.s20++;
    if (e > s.wh) { s.wh = e; s.whAt = at; } if (e < s.ws) { s.ws = e; s.wsAt = at; } };
  const q = (a, f) => { if (!a.length) return null; const d = a.slice().sort((x, y) => x - y); return +d[Math.floor(f * (d.length - 1))].toFixed(2); };
  const finS = (s) => ({ sites: s.n, meanAbsMM: +(s.sum / Math.max(s.n, 1)).toFixed(2),
    hover20Pct: +(100 * s.h20 / Math.max(s.n, 1)).toFixed(1), sunk5Pct: +(100 * s.s5 / Math.max(s.n, 1)).toFixed(1),
    sunk20Pct: +(100 * s.s20 / Math.max(s.n, 1)).toFixed(1),
    worstHoverMM: +s.wh.toFixed(1), worstHoverAt: s.whAt, worstSunkMM: +s.ws.toFixed(1), worstSunkAt: s.wsAt,
    p01: q(s.vals, 0.01), p05: q(s.vals, 0.05), p50: q(s.vals, 0.5), p95: q(s.vals, 0.95), p99: q(s.vals, 0.99) });

  /* THE ROUNDING THAT COST THE OLD CENSUS ITS COUNT: parkProbe used to
     publish errMM at toFixed(1), so anything from 0.100 to 0.149 fell
     out of an "over 0.1 mm" bucket. Both thresholds, same values. */
  let bOver01Raw = 0, bOver01Rounded = 0, bIn0100to0149 = 0;
  /* the discriminator the closed form names: does the segment from the
     pass-one sample to the pass-two landing cross a triangle edge? And
     the claim the header made instead: are the two wheel contacts in
     one triangle? */
  let reachStraddle = 0, reachSame = 0, pairStraddle = 0, pairSame = 0;
  let mildestGradOver1mm = 1e9, mildestGradOver10mm = 1e9;
  const band4448 = []; let band4448Both = 0, band4448N = 0;
  const triId = (x, z) => { const gx = (x - gx0) / CELL, gz = (z - gz0) / CELL;
    const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
    return i + ',' + j + ',' + (fz <= fx ? 0 : 1); };
  const POPS = ['isl', 'roadRaw', 'road'];
  const Wm = {}, Wb = {}, Sd = {}, Sb = {}, Sp = {}, Spb = {}, Sdu = {};
  for (const k of POPS) { Wm[k] = acc(); Wb[k] = acc(); Sd[k] = st(); Sb[k] = st(); Sp[k] = st(); Spb[k] = st(); Sdu[k] = st(); }

  const GOLD = 2.399963229728653;
  const LAT = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2];
  const DOC = [0.37, 1.19, 2.41, 4.02, 5.51];
  let k = 0, sites = 0, clampedSites = 0, skipped = 0, posMismatch = 0, maxProbeDiffMM = 0;
  let roadRaw = 0, roadRider = 0, exclBuilding = 0, exclGrade = 0, road = 0;
  let rollClampedN = 0, floorHit = 0, bandHit = 0, kvCount = 0;
  const crossRoad = [], crossIsl = [];
  let flat = null, maxFlatDevDeg = 0, flatN = 0, minGradRoad = 1e9;
  const sinkRows = [];

  for (let x = b.min.x + off; x <= b.max.x; x += step) {
    for (let z = b.min.z + off * 1.7; z <= b.max.z; z += step) {
      const h = H(x, z);
      if (!Number.isFinite(h) || h < c.world.seaLevel + 0.15) continue;
      const yaw = hm === 'lat' ? LAT[k % 4] : hm === 'doc' ? DOC[k % 5] : (k * GOLD) % (Math.PI * 2);
      k++;
      const p = probe(x, z, yaw, ride, true);
      if (p.error || !p.wheels || p.wheels.length < 2) { skipped++; continue; }
      const pr = c.wally.rideProps[p.ride]; if (!pr) { skipped++; continue; }
      const g = pr.group; g.updateMatrixWorld(true);
      const px = g.position.x, pz = g.position.z;
      if (Math.abs(px - p.machineAt[0]) > 1e-3 || Math.abs(pz - p.machineAt[1]) > 1e-3) posMismatch++;

      if (p.clamped) { clampedSites++; continue; }   /* one population, everywhere */
      sites++;

      /* ---- which populations this site belongs to ---- */
      const rRaw = !!c.world.isRoad(px, pz);
      if (!!c.world.isRoad(x, z)) roadRider++;
      const gd = gradDeg(px, pz);
      let inRoad = false;
      if (rRaw) { roadRaw++;
        const bld = inBuilding(px, pz, MARGIN);
        if (bld) exclBuilding++;
        else if (gd >= 48) exclGrade++;
        else { inRoad = true; road++; }
      }
      const pops = ['isl']; if (rRaw) pops.push('roadRaw'); if (inRoad) pops.push('road');
      const at = [+px.toFixed(3), +pz.toFixed(3), +yaw.toFixed(3), +gd.toFixed(1), p.gradientDeg, p.rollDeg, p.rollRawDeg, !!p.rollClamped];

      /* ---- AFTER: both contacts, measured from the world matrix ---- */
      const ws = pr.wheels || [];
      const lc = ws.slice(0, 2).map((w) => localContact(w, g));
      const es = lc.map((L) => { const v = new T.Vector3(L.x, 0, L.z).applyMatrix4(g.matrixWorld);
        const th = H(v.x, v.z); return Number.isFinite(th) ? (v.y - th) * 1000 : null; });
      for (let i = 0; i < es.length; i++) { if (es[i] == null) continue;
        for (const pp of pops) push(Wm[pp], es[i], at);
        const pe = p.wheels[i] && p.wheels[i].errMM;
        if (pe != null) maxProbeDiffMM = Math.max(maxProbeDiffMM, Math.abs(pe - es[i]));
      }

      /* ---- the stand, as parked ---- */
      const F = pr.standFoot;
      const km = meshNamed(g, 'kickstand');
      if (km && !kvCount) kvCount = km.geometry.attributes.position.count;
      if (F) { const v = new T.Vector3(F.x, F.y, F.z).applyMatrix4(g.matrixWorld);
        const th = H(v.x, v.z);
        if (Number.isFinite(th)) { const e = (v.y - th) * 1000;
          for (const pp of pops) { pushS(Sd[pp], e, at); if (!p.rollClamped) pushS(Sdu[pp], e, at); } } }
      const pc = paintedClearance(km);
      if (pc != null) { const e = pc * 1000;
        for (const pp of pops) pushS(Sp[pp], e, at);
        if (rRaw && e < -5) {
          sinkRows.push({ x: +px.toFixed(2), z: +pz.toFixed(2), yaw: +yaw.toFixed(2), sunkMM: +e.toFixed(1),
            gradDeg: +gd.toFixed(1), rollDeg: p.rollDeg, rollRawDeg: p.rollRawDeg, rollClamped: !!p.rollClamped,
            inBuilding: inBuilding(px, pz, MARGIN), restricted: inRoad });
          sinkRows.sort((a2, b2) => a2.sunkMM - b2.sunkMM);
          if (sinkRows.length > 14) sinkRows.length = 14;
        }
      }

      /* ---- BEFORE the roll solve: same pitch, same y, roll = lean ---- */
      const lean = pr.parkLean || 0;
      if (F) {
        _obj.position.set(px, g.position.y, pz);
        _obj.rotation.set(g.rotation.x, yaw, lean);
        _obj.updateMatrixWorld(true);
        const v = new T.Vector3(F.x, F.y, F.z).applyMatrix4(_obj.matrixWorld);
        const th = H(v.x, v.z);
        if (Number.isFinite(th)) { const e = (v.y - th) * 1000; for (const pp of pops) pushS(Sb[pp], e, at); }
        if (km) { const rz = g.rotation.z; g.rotation.z = lean; g.updateMatrixWorld(true);
          const cpb = paintedClearance(km);
          g.rotation.z = rz; g.updateMatrixWorld(true);
          if (cpb != null) { const e = cpb * 1000; for (const pp of pops) pushS(Spb[pp], e, at); } }
      }

      /* ---- BEFORE the pitch solve: the documented two-pass ---- */
      const zf = lc[0].z, zr = lc[1].z, base = zf - zr;
      const fxw = Math.sin(yaw), fzw = Math.cos(yaw);
      const S = (u) => H(px + fxw * u, pz + fzw * u);
      const hf0 = S(zf), hr0 = S(zr);
      const p1 = cl(Math.atan2(hr0 - hf0, base), -PM, PM);
      const c1 = Math.cos(p1);
      const hf1 = S(zf * c1), hr1 = S(zr * c1);
      const rawP2 = Math.asin(cl((hr1 - hf1) / base, -1, 1));
      const p2 = cl(rawP2, -PM, PM);
      const bClamped = Math.abs(rawP2) > PM + 1e-9;
      let yB = (hf1 + hr1) * 0.5 + (zf + zr) * 0.5 * Math.sin(p2);
      let bf = yB - zf * Math.sin(p2) - S(zf * Math.cos(p2));
      let br = yB - zr * Math.sin(p2) - S(zr * Math.cos(p2));
      if (bClamped) { const sag = Math.min(bf, br); if (sag < 0) { bf -= sag; br -= sag; } }
      { const c2b = Math.cos(p2);
        for (const zz of [zf, zr]) {
          const a1 = triId(px + fxw * zz * c1, pz + fzw * zz * c1);
          const a2 = triId(px + fxw * zz * c2b, pz + fzw * zz * c2b);
          if (a1 === a2) reachSame++; else reachStraddle++;
        }
        const cf = Math.cos(g.rotation.x);
        const t1 = triId(px + fxw * zf * cf, pz + fzw * zf * cf);
        const t2 = triId(px + fxw * zr * cf, pz + fzw * zr * cf);
        if (t1 === t2) pairSame++; else pairStraddle++;
      }
      { const gr = Math.abs(p.gradientDeg == null ? 0 : p.gradientDeg);
        if (gr >= 44 && gr <= 48) { band4448N++;
          if (bf < 0 && br < 0) { band4448Both++;
            if (band4448.length < 8) band4448.push({ gradDeg: p.gradientDeg,
              beforeMM: [+(bf * 1000).toFixed(1), +(br * 1000).toFixed(1)],
              afterMM: [+(es[0] == null ? NaN : es[0]).toFixed(1), +(es[1] == null ? NaN : es[1]).toFixed(1)] }); } } }
      for (const e of [bf * 1000, br * 1000]) {
        if (Math.abs(e) > 1) mildestGradOver1mm = Math.min(mildestGradOver1mm, gd);
        if (Math.abs(e) > 10) mildestGradOver10mm = Math.min(mildestGradOver10mm, gd);
        for (const pp of pops) push(Wb[pp], e, at);
        const a = Math.abs(e), r = Math.abs(+e.toFixed(1));
        if (a > 0.1) bOver01Raw++;
        if (r > 0.1) bOver01Rounded++;
        if (a > 0.1 && r <= 0.1) bIn0100to0149++;
      }

      /* ---- roll bookkeeping ---- */
      if (p.rollClamped) { rollClampedN++;
        if (Math.abs(p.rollDeg - (lean * DEG)) > RB * DEG - 1e-3) bandHit++; else floorHit++; }
      if (p.rollRawDeg != null) { const ex = p.rollRawDeg - p.leanDeg;
        crossIsl.push(ex); if (inRoad) crossRoad.push(ex); }
      /* ---- the flat-ground claim: how near-flat does the island get,
         and how far from the lean does the roll go there ---- */
      if (inRoad) {
        const dev = Math.abs(p.rollDeg - p.leanDeg);
        if (gd < minGradRoad) { minGradRoad = gd;
          flat = { x: +px.toFixed(2), z: +pz.toFixed(2), gradDeg: +gd.toFixed(4), rollDeg: p.rollDeg,
            rollRawDeg: p.rollRawDeg, leanDeg: p.leanDeg, devDeg: +dev.toFixed(4), clamped: !!p.rollClamped }; }
        if (gd < 1) { flatN++; maxFlatDevDeg = Math.max(maxFlatDevDeg, dev); }
      }
    }
  }
  return { ride, step, off, headings: hm, boxes: BOXES.length, kickstandVerts: kvCount,
    sitesUnclamped: sites, clampedSites, skipped, posMismatch, maxProbeVsToolMM: +maxProbeDiffMM.toFixed(4),
    population: { islandSites: sites, roadRiderTest: roadRider, roadAtMachine: roadRaw,
      excludedInsideBuilding: exclBuilding, excludedOverSlopeLimit: exclGrade, roadRestricted: road },
    WHEELS: { beforeIsland: fin(Wb.isl), beforeRoadRaw: fin(Wb.roadRaw), beforeRoad: fin(Wb.road),
      afterIsland: fin(Wm.isl), afterRoadRaw: fin(Wm.roadRaw), afterRoad: fin(Wm.road) },
    STAND: { designBeforeIsland: finS(Sb.isl), designBeforeRoad: finS(Sb.road), designBeforeRoadRaw: finS(Sb.roadRaw),
      designAfterIsland: finS(Sd.isl), designAfterRoad: finS(Sd.road), designAfterRoadRaw: finS(Sd.roadRaw),
      designAfterIslandRollFree: finS(Sdu.isl), designAfterRoadRollFree: finS(Sdu.road),
      paintedBeforeIsland: finS(Spb.isl), paintedBeforeRoad: finS(Spb.road),
      paintedAfterIsland: finS(Sp.isl), paintedAfterRoad: finS(Sp.road), paintedAfterRoadRaw: finS(Sp.roadRaw) },
    BAND4448: { sites: band4448N, bothWheelsBuried: band4448Both, rows: band4448 },
    MECH: { reachSegmentStraddleContacts: reachStraddle, reachSegmentSameTriangle: reachSame,
      wheelPairStraddleSites: pairStraddle, wheelPairSameTriangleSites: pairSame,
      mildestGradDegWithOver1mm: +mildestGradOver1mm.toFixed(1), mildestGradDegWithOver10mm: +mildestGradOver10mm.toFixed(1) },
    BEFORE_THRESHOLD: { over01Unrounded: bOver01Raw, over01AfterRoundingTo0p1: bOver01Rounded, lostToRounding: bIn0100to0149 },
    ROLL: { rollClampedSites: rollClampedN, floorHit, bandHit,
      roadCrossP05: q(crossRoad, 0.05), roadCrossP50: q(crossRoad, 0.5), roadCrossP95: q(crossRoad, 0.95),
      islandCrossP05: q(crossIsl, 0.05), islandCrossP95: q(crossIsl, 0.95) },
    FLAT: { flattestRoadSite: flat, nearFlatRoadSites: flatN, maxDevFromLeanUnder1degDeg: +maxFlatDevDeg.toFixed(4) },
    SINKS: sinkRows };
}, [RIDE, STEP, OFF, HM]);

console.log(TAG + ' ' + JSON.stringify(out, null, 1));
if (errs.length) console.log('ERRS', errs.slice(0, 5));
await close();
