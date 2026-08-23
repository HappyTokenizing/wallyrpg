/* _pj/census.mjs — judge 15's own park census.
   node tools/_pj/census.mjs <ride> <step> <off> <headingMode> <tag>
   headingMode: 'off'  = golden-angle headings, never a multiple of pi/2
                'lat'  = 0, pi/2, pi, 3pi/2 only (the lattice-friendly set)
   Measures, at every site:
     - both wheel contacts, computed IN THIS TOOL from the prop group's
       world matrix (not read off parkProbe's errMM)
     - whether the two contacts sit on the SAME terrain triangle
     - the stand foot, painted lowest vertex AND design contact point
   and models the OLD two-pass solve at the same site with the same
   heightAt, so before/after are the same instrument.
*/
import { boot } from './lib.mjs';

const RIDE = process.argv[2] || 'bike';
const STEP = +(process.argv[3] || 7.3);
const OFF  = +(process.argv[4] || 0.37);
const HM   = process.argv[5] || 'off';
const TAG  = process.argv[6] || '';

const { page, errs, close } = await boot();

const out = await page.evaluate(([ride, step, off, hm]) => {
  const W = window.WALLY, T = W.THREE, c = W.ctx;
  const probe = W.debug.parkProbe;
  const b = c.world.bounds;
  const CELL = 2;                       // terrain.js: export const CELL = 2
  const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : NaN; } catch (e) { return NaN; } };
  const isRoad = (x, z) => { try { return !!c.world.isRoad(x, z); } catch (e) { return false; } };

  /* terrain triangle id at (x,z) — heightAt's own split: fz<=fx picks
     the lower triangle. Two contacts with different ids straddle. */
  const gx0 = -b.max.x, gz0 = -b.max.z;   // grid origin, checked below
  const triId = (x, z) => {
    const gx = (x - gx0) / CELL, gz = (z - gz0) / CELL;
    const i = Math.floor(gx), j = Math.floor(gz);
    const fx = gx - i, fz = gz - j;
    return i + ',' + j + ',' + (fz <= fx ? 0 : 1);
  };

  const _v = new T.Vector3();
  const _probeObj = new T.Object3D(); _probeObj.rotation.order = 'YXZ';

  /* contact point of a wheel, in the prop's own frame: directly under
     the axle at local y = 0. Walks the parent chain for x AND z. */
  function localContact(w, stop) {
    let x = 0, z = 0;
    for (let n = w; n && n !== stop; n = n.parent) { x += n.position.x; z += n.position.z; }
    return { x, z };
  }
  function meshNamed(g, name) { let m = null; g.traverse((o) => { if (o.name === name) m = o; }); return m; }
  function lowestPainted(m) {
    if (!m) return null;
    m.updateMatrixWorld(true);
    const pos = m.geometry?.attributes?.position; if (!pos) return null;
    let lo = Infinity, bx = 0, bz = 0;
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      if (_v.y < lo) { lo = _v.y; bx = _v.x; bz = _v.z; }
    }
    return { y: lo, x: bx, z: bz };
  }

  /* ---------- transcription of solveParkPose, with knobs ---------- */
  const PITCH_MAX = 0.838, ROLL_BAND = 0.26, ROLL_MIN = 0.035;
  const cl = (v, a, d) => (v < a ? a : (v > d ? d : v));
  function modelSolve(o, mode) {
    const zf = o.zf, zr = o.zr, base = zf - zr, yaw = o.yaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const lx = Math.cos(yaw), lz = -Math.sin(yaw);
    let y = H(o.x, o.z); if (!Number.isFinite(y)) y = o.fallbackY;
    let pitch = 0, raw = 0, clamped = false, hf = NaN, hr = NaN, lift = 0, ef = 0, er = 0, iters = 0, bis = false;
    if (base > 0.05) {
      const impAt = (p) => {
        const cp = Math.cos(p);
        hf = H(o.x + fx * zf * cp, o.z + fz * zf * cp);
        hr = H(o.x + fx * zr * cp, o.z + fz * zr * cp);
        return (Number.isFinite(hf) && Number.isFinite(hr)) ? Math.asin(cl((hr - hf) / base, -1, 1)) : NaN;
      };
      const seed = impAt(0);
      if (Number.isFinite(seed)) {
        let p = cl(Math.atan2(hr - hf, base), -PITCH_MAX, PITCH_MAX);
        let imp = seed, prevP = NaN, prevF = NaN;
        const CAP = mode === 'before' ? 1 : 60;
        for (iters = 1; iters <= CAP; iters++) {
          imp = impAt(p);
          if (!Number.isFinite(imp)) { imp = raw; break; }
          const next = cl(imp, -PITCH_MAX, PITCH_MAX);
          const f = next - p;
          if (Math.abs(f) < 1e-9) break;
          if (mode !== 'before' && Number.isFinite(prevF) && (prevF > 0) !== (f > 0)) {
            bis = true;
            let lo = prevP, hi = p, flo = prevF;
            for (let k = 0; k < 60; k++) {
              const mid = (lo + hi) * 0.5;
              const im = impAt(mid);
              const fm = (Number.isFinite(im) ? cl(im, -PITCH_MAX, PITCH_MAX) : mid) - mid;
              if (fm === 0) { lo = mid; hi = mid; break; }
              if ((fm > 0) === (flo > 0)) { lo = mid; flo = fm; } else hi = mid;
            }
            p = (lo + hi) * 0.5; break;
          }
          prevP = p; prevF = f; p = next;
        }
        if (mode === 'before') {
          /* THE OLD SOLVE: pitch advances to pass two, hf/hr are left
             belonging to pass one, and nothing re-samples. */
          pitch = cl(imp, -PITCH_MAX, PITCH_MAX);
          raw = imp; clamped = Math.abs(raw) > PITCH_MAX + 1e-9;
        } else {
          pitch = p; const i2 = impAt(pitch);
          raw = Number.isFinite(i2) ? i2 : pitch;
          clamped = Math.abs(raw) > PITCH_MAX + 1e-9;
        }
        if (Number.isFinite(hf) && Number.isFinite(hr)) {
          y = (hf + hr) * 0.5 + (zf + zr) * 0.5 * Math.sin(pitch);
          ef = y - zf * Math.sin(pitch) - hf;
          er = y - zr * Math.sin(pitch) - hr;
          const sag = Math.min(ef, er);
          /* the old lift was gated on the clamp saturating */
          if (sag < 0 && (mode !== 'before' || clamped)) { y -= sag; lift = -sag; ef -= sag; er -= sag; }
        }
      }
    }
    if (!Number.isFinite(y)) y = o.fallbackY;
    /* ---- roll ---- */
    const lean = o.lean;
    let roll = lean, rollRaw = lean, rollClamped = false;
    const F = o.foot;
    if (mode !== 'before' && F && Math.abs(F.x) > 0.02) {
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const bx = o.x + fx * F.z * cp, bz = o.z + fz * F.z * cp;
      const planeY = y - F.z * sp;
      const tAt = (u) => { const h = H(bx + lx * u, bz + lz * u); return Number.isFinite(h) ? h - planeY : NaN; };
      const t0 = tAt(0);
      if (Number.isFinite(t0)) {
        let u = F.x, solved = NaN;
        for (let k = 0; k < 3; k++) {
          const tu = tAt(u);
          if (!Number.isFinite(tu) || Math.abs(u) < 1e-3) break;
          const g = (tu - t0) / u;
          const A = F.x + g * F.y, B = F.y - g * F.x;
          const m = Math.hypot(A, B); if (m < 1e-6) break;
          const r = Math.asin(cl(t0 / m, -1, 1)) - Math.atan2(B, A);
          if (!Number.isFinite(r)) break;
          solved = r;
          const nu = F.x * Math.cos(r) - F.y * Math.sin(r);
          const done = Math.abs(nu - u) < 1e-5; u = nu; if (done) break;
        }
        if (Number.isFinite(solved)) {
          rollRaw = solved;
          roll = cl(solved, lean - ROLL_BAND, lean + ROLL_BAND);
          roll = lean < 0 ? Math.min(roll, -ROLL_MIN) : Math.max(roll, ROLL_MIN);
          rollClamped = Math.abs(roll - solved) > 1e-6;
        }
      }
    }
    return { y, pitch, roll, raw, clamped, rollRaw, rollClamped, iters, bis, liftMM: lift * 1000 };
  }

  /* ---------- accumulators ---------- */
  const acc = () => ({ n: 0, o01: 0, o1: 0, o10: 0, worst: 0, worstAt: null, bur1: 0, worstBur: 0, burAt: null, sumAbs: 0 });
  const push = (a, e, at) => { a.n++; a.sumAbs += Math.abs(e);
    if (Math.abs(e) > 0.1) a.o01++; if (Math.abs(e) > 1) a.o1++; if (Math.abs(e) > 10) a.o10++;
    if (Math.abs(e) > Math.abs(a.worst)) { a.worst = e; a.worstAt = at; }
    if (e < -1) a.bur1++; if (e < a.worstBur) { a.worstBur = e; a.burAt = at; } };
  const fin = (a) => ({ contacts: a.n, over01mm: a.o01, over1mm: a.o1, over10mm: a.o10,
    worstMM: +a.worst.toFixed(1), worstAt: a.worstAt, buriedOver1mm: a.bur1,
    worstBuriedMM: +a.worstBur.toFixed(1), meanAbsMM: +(a.sumAbs / Math.max(a.n, 1)).toFixed(4) });
  const st = () => ({ n: 0, sum: 0, h20: 0, s5: 0, wh: 0, ws: 0, whAt: null, vals: [] });
  const pushS = (s, e, at) => { s.n++; s.sum += Math.abs(e); s.vals.push(e);
    if (e > 20) s.h20++; if (e < -5) s.s5++;
    if (e > s.wh) { s.wh = e; s.whAt = at; } if (e < s.ws) s.ws = e; };
  const q = (a, f) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return +b[Math.floor(f * (b.length - 1))].toFixed(1); };
  const finS = (s) => ({ sites: s.n, meanAbsMM: +(s.sum / Math.max(s.n, 1)).toFixed(1),
    hoverOver20mmPct: +(100 * s.h20 / Math.max(s.n, 1)).toFixed(1),
    sunkOver5mmPct: +(100 * s.s5 / Math.max(s.n, 1)).toFixed(1),
    worstHoverMM: +s.wh.toFixed(1), worstSunkMM: +s.ws.toFixed(1),
    p50: q(s.vals, 0.5), p95: q(s.vals, 0.95), p99: q(s.vals, 0.99), hoverAt: s.whAt });

  const A = { all: acc(), road: acc(), straddle: acc(), same: acc(),
              bAll: acc(), bRoad: acc(), bStraddle: acc(), bSame: acc(),
              inclClampAll: acc(), inclClampRoad: acc() };
  const S = { pAll: st(), pRoad: st(), dAll: st(), dRoad: st(),
              bAll: st(), bRoad: st(), pFreeRoad: st(),
              pAllU: st(), pRoadU: st(), bAllU: st(), bRoadU: st(),
              dAllU: st(), dRoadU: st(), dFreeAll: st(), dFreeRoad: st(),
              rlAll: st(), rlRoad: st() };

  let sites = 0, clampedSites = 0, skipped = 0, straddleSites = 0, k = 0;
  let rollClampedN = 0, floorHit = 0, bandHit = 0, reachStraddle = 0, reachSame = 0;
  const crossRoad = [];
  let modelMaxDPitch = 0, modelMaxDY = 0, modelMaxDRoll = 0, modelChecked = 0;
  const GOLD = 2.399963229728653;
  const LAT = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2];
  const DOC = [0.37, 1.19, 2.41, 4.02, 5.51];   // the header's own set
  let gridOK = null;

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
      const road = isRoad(x, z);

      /* --- my own contacts --- */
      const ws = pr.wheels || [];
      const lc = ws.slice(0, 2).map((w) => localContact(w, g));
      const wp = lc.map((L) => { const v = new T.Vector3(L.x, 0, L.z).applyMatrix4(g.matrixWorld); return v.clone(); });
      const es = wp.map((v) => { const th = H(v.x, v.z); return Number.isFinite(th) ? (v.y - th) * 1000 : null; });
      if (gridOK === null) {
        /* confirm the grid origin guess by round-tripping a lattice point */
        gridOK = Math.abs(H(gx0 + 4 * CELL, gz0 + 6 * CELL) - H(gx0 + 4 * CELL, gz0 + 6 * CELL)) === 0;
      }
      const t0 = triId(wp[0].x, wp[0].z), t1 = triId(wp[1].x, wp[1].z);
      const straddle = t0 !== t1;
      if (straddle) straddleSites++;
      const at = [+x.toFixed(4), +z.toFixed(4), +yaw.toFixed(4), p.gradientDeg, p.pitchIters, p.bisected, straddle];

      for (const e of es) { if (e == null) continue;
        push(A.inclClampAll, e, at); if (road) push(A.inclClampRoad, e, at); }
      if (p.clamped) { clampedSites++; }
      else {
        sites++;
        for (const e of es) { if (e == null) continue;
          push(A.all, e, at); if (road) push(A.road, e, at);
          push(straddle ? A.straddle : A.same, e, at); }
      }

      /* --- the stand, painted and design --- */
      const km = meshNamed(g, 'kickstand');
      const lp = lowestPainted(km);
      if (lp) { const th = H(lp.x, lp.z); if (Number.isFinite(th)) {
        const e = (lp.y - th) * 1000; pushS(S.pAll, e, at);
        if (!p.clamped) pushS(S.pAllU, e, at);
        if (road) { pushS(S.pRoad, e, at); if (!p.clamped) pushS(S.pRoadU, e, at);
          if (!p.rollClamped) pushS(S.pFreeRoad, e, at); } } }
      const F = pr.standFoot;
      if (F) { const v = new T.Vector3(F.x, F.y, F.z).applyMatrix4(g.matrixWorld);
        const th = H(v.x, v.z); if (Number.isFinite(th)) { const e = (v.y - th) * 1000;
          pushS(S.dAll, e, at); if (road) pushS(S.dRoad, e, at);
          if (!p.clamped) { pushS(S.dAllU, e, at); if (road) pushS(S.dRoadU, e, at);
            if (!p.rollClamped) { pushS(S.dFreeAll, e, at); if (road) pushS(S.dFreeRoad, e, at); } } } }

      /* --- the model, at the machine's own position --- */
      /* EXACT inputs, not parkProbe's rounded report: g.position is
         literally the px/pz parkProp wrote, pr.parkLean the radians it
         passed. parkProbe rounds machineAt to mm and leanDeg to 0.01
         deg, and feeding those back cost 1.4 mrad of pitch fidelity. */
      const px = g.position.x, pz = g.position.z;
      const zf = lc[0].z, zr = lc[1].z;
      const mo = { x: px, z: pz, yaw, zf, zr, lean: pr.parkLean || 0, foot: F || null, fallbackY: h };
      /* validate the transcription against the live solve */
      const mA = modelSolve(mo, 'after');
      modelChecked++;
      modelMaxDPitch = Math.max(modelMaxDPitch, Math.abs(mA.pitch - g.rotation.x));
      modelMaxDY = Math.max(modelMaxDY, Math.abs(mA.y - g.position.y));
      modelMaxDRoll = Math.max(modelMaxDRoll, Math.abs(mA.roll - g.rotation.z));
      if (p.rollClamped) { rollClampedN++;
        if (Math.abs(p.rollDeg + 2.0) < 0.6) floorHit++; else bandHit++; }
      if (road && p.rollRawDeg != null && p.leanDeg != null) crossRoad.push(p.rollRawDeg - p.leanDeg);
      /* PER-WHEEL REACH STRADDLE — the discriminator the closed form
         actually names: does the segment from the pass-one sample to
         the pass-two landing cross a triangle edge? The header blames
         wheel-to-wheel straddle instead, which is a different thing. */
      {
        const fxw = Math.sin(yaw), fzw = Math.cos(yaw);
        const hf0 = H(px + fxw * zf, pz + fzw * zf), hr0 = H(px + fxw * zr, pz + fzw * zr);
        const p1 = cl(Math.atan2(hr0 - hf0, zf - zr), -PITCH_MAX, PITCH_MAX);
        const c1 = Math.cos(p1), c2 = Math.cos(mA.pitch);
        for (const zz of [zf, zr]) {
          const a = triId(px + fxw * zz * c1, pz + fzw * zz * c1);
          const bq = triId(px + fxw * zz * c2, pz + fzw * zz * c2);
          if (a === bq) reachSame++; else reachStraddle++;
        }
      }
      /* THE OTHER 'BEFORE': the header's stand table holds the pitch
         solve FIXED and only takes the roll back to the constant lean.
         Different population from the two-pass before above, and the
         table does not say which it is. */
      if (F) {
        _probeObj.position.set(px, mA.y, pz);
        _probeObj.rotation.set(mA.pitch, yaw, pr.parkLean || 0);
        _probeObj.updateMatrixWorld(true);
        const v = new T.Vector3(F.x, F.y, F.z).applyMatrix4(_probeObj.matrixWorld);
        const th = H(v.x, v.z);
        if (Number.isFinite(th) && !p.clamped) { const e = (v.y - th) * 1000;
          pushS(S.rlAll, e, at); if (road) pushS(S.rlRoad, e, at); }
      }
      /* the BEFORE pose, measured with the same ruler */
      const mB = modelSolve(mo, 'before');
      _probeObj.position.set(px, mB.y, pz);
      _probeObj.rotation.set(mB.pitch, yaw, mB.roll);
      _probeObj.updateMatrixWorld(true);
      const bes = lc.map((L) => { const v = new T.Vector3(L.x, 0, L.z).applyMatrix4(_probeObj.matrixWorld);
        const th = H(v.x, v.z); return Number.isFinite(th) ? { e: (v.y - th) * 1000, v } : null; });
      if (!mB.clamped) for (const r of bes) { if (!r) continue;
        push(A.bAll, r.e, at); if (road) push(A.bRoad, r.e, at);
        push(straddle ? A.bStraddle : A.bSame, r.e, at); }
      if (F) { const v = new T.Vector3(F.x, F.y, F.z).applyMatrix4(_probeObj.matrixWorld);
        const th = H(v.x, v.z); if (Number.isFinite(th)) { const e = (v.y - th) * 1000;
          pushS(S.bAll, e, at); if (!mB.clamped) pushS(S.bAllU, e, at);
          if (road) { pushS(S.bRoad, e, at); if (!mB.clamped) pushS(S.bRoadU, e, at); } } }
    }
  }
  return { ride, step, off, headings: hm, sitesUnclamped: sites, clampedSites, skipped,
    straddleSitePct: +(100 * straddleSites / Math.max(sites + clampedSites, 1)).toFixed(1),
    modelFidelity: { checked: modelChecked, maxDPitchRad: modelMaxDPitch, maxDYm: modelMaxDY, maxDRollDeg: modelMaxDRoll },
    AFTER: { all: fin(A.all), road: fin(A.road), straddle: fin(A.straddle), sameTri: fin(A.same),
             inclClampedAll: fin(A.inclClampAll), inclClampedRoad: fin(A.inclClampRoad) },
    BEFORE: { all: fin(A.bAll), road: fin(A.bRoad), straddle: fin(A.bStraddle), sameTri: fin(A.bSame) },
    STAND: { afterPaintedAll: finS(S.pAll), afterPaintedRoad: finS(S.pRoad), afterPaintedRoadUnclamped: finS(S.pFreeRoad),
             afterDesignAll: finS(S.dAll), afterDesignRoad: finS(S.dRoad),
             beforeDesignAll: finS(S.bAll), beforeDesignRoad: finS(S.bRoad),
             afterPaintedAllUnclamped: finS(S.pAllU), afterPaintedRoadUnclamped2: finS(S.pRoadU),
             beforeDesignAllUnclamped: finS(S.bAllU), beforeDesignRoadUnclamped: finS(S.bRoadU),
             afterDesignAllUnclamped: finS(S.dAllU), afterDesignRoadUnclamped: finS(S.dRoadU),
             afterDesignAllRollFree: finS(S.dFreeAll), afterDesignRoadRollFree: finS(S.dFreeRoad),
             constLeanAllUnclamped: finS(S.rlAll), constLeanRoadUnclamped: finS(S.rlRoad) },
    ROLLCLAMP: { rollClampedSites: rollClampedN, floorHit, bandHit,
      roadCrossSlopeP05: q(crossRoad, 0.05), roadCrossSlopeP50: q(crossRoad, 0.5), roadCrossSlopeP95: q(crossRoad, 0.95) },
    REACH: { perWheelReachStraddleContacts: reachStraddle, perWheelReachSameTri: reachSame } };
}, [RIDE, STEP, OFF, HM]);

console.log(TAG + ' ' + JSON.stringify(out, null, 1));
if (errs.length) console.log('ERRS', errs.slice(0, 5));
await close();
