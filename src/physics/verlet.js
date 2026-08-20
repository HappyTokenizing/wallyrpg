/* ============================================================
   verlet.js — cloth. Flags, banners, awnings, laundry lines, sails.

   ART_DIRECTION §2.3 and §4: everything hanging in this city moves in
   the same wind as the grass and Wally's ears, and it must RIPPLE, not
   jitter.

   Why verlet and not springs here: a flag is a thousand tiny constraints
   and a spring solver would need a silly stiffness to stop it stretching.
   Position-based verlet enforces length exactly at any stiffness, so we
   can run structural constraints hard (rigid, no stretch) and shear/bend
   constraints soft (the fabric folds), which is precisely the split that
   turns jitter into a ripple.

   The ripple, specifically:
     * fixed dt (this file is only ever stepped by the 60 Hz accumulator)
       so dt^2 is constant and verlet does not gain energy,
     * wind is applied per-quad along the QUAD NORMAL, not uniformly, so
       the sheet luffs and billows instead of translating,
     * a travelling phase offset along the free edge, sampled from the
       same ctx.wind field as everything else, so gusts cross the flag,
     * bend constraints at ~0.2 stiffness — the single knob that decides
       ripple (soft) vs shimmer (hard).

   Usage:
     const flag = ctx.phys.createCloth({
       cols: 14, rows: 9, width: 1.6, height: 1.0,
       origin: new THREE.Vector3(2, 6, -3),
       pin: 'left',
     });
     mesh = new THREE.Mesh(flag.geometry, myMaterial);   // geometry is built for you
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { clamp } from '../core/contracts.js';

const _v = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _nq = new THREE.Vector3();

export const CLOTH_DEFAULTS = {
  cols: 12, rows: 8,          // particle counts (cols x rows)
  width: 1.4, height: 0.9,    // metres
  origin: null,               // THREE.Vector3, the pinned corner
  right: null,                // spanning axis for columns  (default +X)
  down: null,                 // spanning axis for rows     (default -Y)
  pin: 'left',                // 'left'|'top'|'top-corners'|'left-top'|array|fn(c,r)
  gravity: 9.4,
  windScale: 1.0,
  windLift: 0.55,             // how much wind pushes along the quad normal
  flutter: 1.35,              // travelling turbulent pressure — THE flap
  flutterWaves: 1.3,          // crests between the anchor and the free edge
  flutterHz: 0.85,            // how fast those crests travel downwind
  normalDrag: 2.2,            // air resists motion ACROSS the sheet
  damping: 0.018,             // velocity bleed per step
  iterations: 8,
  structuralPasses: 10,       // extra rigid-edge-only passes at the end
  structural: 1.0,            // rigid — a flag does not stretch
  shear: 0.55,
  bend: 0.2,                  // THE ripple knob
  maxStep: 0.09,              // clamp per-step motion; kills explosions
  geometry: true,             // build a BufferGeometry we keep updated
  doubleSided: false,
  object3D: null,             // if set, output is written in its local space
  collide: null,              // {position, radius} or () => ({position, radius})
  phase: 0,
};

/**
 * Gauss-Seidel distance-constraint pass over a range of the SoA list.
 *
 * THE hot loop of the engine — with fifty cloths in the city this runs a
 * third of a million times a frame — so it is a module-level function on
 * flat typed arrays rather than a closure over `this`:
 *   * no closure allocated per step,
 *   * indices arrive from an Int32Array already multiplied by 3,
 *   * pinned-ness and stiffness are pre-baked into KA/KB (see
 *     Cloth._bakeWeights), so there is not a branch in the body,
 *   * sqrt(x*x+y*y+z*z), never Math.hypot. Hypot is overflow-safe and
 *     therefore ~2.5x the cost of a sqrt in V8; at this call count that
 *     one substitution was worth ~5 ms a frame on its own.
 * The arithmetic is otherwise identical to the branchy original.
 */
function solveRange(P, I, R, KA, KB, from, to) {
  for (let k = from; k < to; k++) {
    const k2 = k << 1;
    const ia = I[k2], ib = I[k2 + 1];
    const dx = P[ib] - P[ia], dy = P[ib + 1] - P[ia + 1], dz = P[ib + 2] - P[ia + 2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < 1e-18) continue;
    const d = Math.sqrt(d2);
    const f = (d - R[k]) / d;
    const ka = KA[k], kb = KB[k];
    const ox = dx * f, oy = dy * f, oz = dz * f;
    P[ia] += ox * ka; P[ia + 1] += oy * ka; P[ia + 2] += oz * ka;
    P[ib] -= ox * kb; P[ib + 1] -= oy * kb; P[ib + 2] -= oz * kb;
  }
}

export class Cloth {
  constructor(opts = {}) {
    const o = { ...CLOTH_DEFAULTS, ...opts };
    this.opts = o;
    this.cols = Math.max(2, o.cols | 0);
    this.rows = Math.max(2, o.rows | 0);
    this.enabled = opts.enabled !== false;
    this.auto = opts.auto !== false;
    this.phase = o.phase;

    const N = this.cols * this.rows;
    this.count = N;
    this.pos = new Float32Array(N * 3);
    this.prev = new Float32Array(N * 3);
    this.pinned = new Uint8Array(N);
    this.rest = new Float32Array(N * 3);

    this.origin = (o.origin ? o.origin.clone() : new THREE.Vector3());
    this.right = (o.right ? o.right.clone() : new THREE.Vector3(1, 0, 0)).normalize();
    this.down = (o.down ? o.down.clone() : new THREE.Vector3(0, -1, 0)).normalize();
    this.normalHint = new THREE.Vector3().crossVectors(this.right, this.down).normalize();

    const dx = o.width / (this.cols - 1);
    const dy = o.height / (this.rows - 1);
    this.dx = dx; this.dy = dy;

    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const i = (r * this.cols + c) * 3;
        _v.copy(this.origin).addScaledVector(this.right, c * dx).addScaledVector(this.down, r * dy);
        this.pos[i] = this.prev[i] = this.rest[i] = _v.x;
        this.pos[i + 1] = this.prev[i + 1] = this.rest[i + 1] = _v.y;
        this.pos[i + 2] = this.prev[i + 2] = this.rest[i + 2] = _v.z;
      }
    }
    this._applyPinning(o.pin);

    /* Simulation clock. Only ever advanced by the 60 Hz accumulator, so
       the travelling flutter wave is bit-reproducible between runs. */
    this.time = 0;

    /* Grid distance from the nearest pin, normalised 0..1. A flag is
       dead still at the hoist and snaps at the fly end, so this is both
       the flutter amplitude envelope and the coordinate the travelling
       wave runs along. Computed once, works for any pin layout. */
    this.freeWeight = new Float32Array(N);
    this._buildFreeWeight();

    /* Constraint list: [iA, iB, restLength, stiffness] flattened.
       STRUCTURAL FIRST. Gauss-Seidel propagates tension one link per
       pass, so a 14-wide flag needs the load-bearing edges solved
       together and solved last; keeping them contiguous lets us run
       extra structural-only passes at the end for a few percent of the
       cost of another full iteration. That is the whole difference
       between a flag that ripples and a flag that visibly stretches. */
    const struct = [], soft = [];
    const push = (list, a, b, k) => {
      const ax = this.pos[a * 3], ay = this.pos[a * 3 + 1], az = this.pos[a * 3 + 2];
      const bx = this.pos[b * 3], by = this.pos[b * 3 + 1], bz = this.pos[b * 3 + 2];
      list.push(a, b, Math.hypot(bx - ax, by - ay, bz - az), k);
    };
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const i = r * this.cols + c;
        if (c + 1 < this.cols) push(struct, i, i + 1, o.structural);
        if (r + 1 < this.rows) push(struct, i, i + this.cols, o.structural);
        if (c + 1 < this.cols && r + 1 < this.rows) {
          push(soft, i, i + this.cols + 1, o.shear);
          push(soft, i + 1, i + this.cols, o.shear);
        }
        if (c + 2 < this.cols) push(soft, i, i + 2, o.bend);
        if (r + 2 < this.rows) push(soft, i, i + 2 * this.cols, o.bend);
      }
    }
    /* --- SoA constraint layout -------------------------------------
       The solver is the hot loop of the whole engine: iterations x
       constraints x cloths x fixed steps, which in the real city is a
       third of a million passes a frame. It gets its own arrays.

         cIdx   Int32Array   the two particle offsets, PRE-MULTIPLIED
                             by 3 so the inner loop never does a *3
         cRest  Float32Array rest length
         cStiff Float32Array raw stiffness (kept only for maxStretch)
         cKa/Kb Float32Array baked correction weights, see _bakeWeights

       Nothing here is derived per step any more: the pinned-ness tests
       and the `* stiffness * 0.5` are folded into cKa/cKb once, which
       removes two typed-array loads and three branches from a loop that
       runs 300k times a frame. Float32Array-of-mixed-fields also forced
       an int coercion (`cons[k*4]|0`) on every index read; Int32Array
       does not.                                                       */
    const all = struct.concat(soft);
    this.consCount = all.length / 4;
    this.structCount = struct.length / 4;
    this.cIdx = new Int32Array(this.consCount * 2);
    this.cRest = new Float32Array(this.consCount);
    this.cStiff = new Float32Array(this.consCount);
    this.cKa = new Float32Array(this.consCount);
    this.cKb = new Float32Array(this.consCount);
    for (let k = 0; k < this.consCount; k++) {
      this.cIdx[k * 2] = all[k * 4] * 3;
      this.cIdx[k * 2 + 1] = all[k * 4 + 1] * 3;
      this.cRest[k] = all[k * 4 + 2];
      this.cStiff[k] = all[k * 4 + 3];
    }
    this._bakeWeights();

    /* --- level of detail -------------------------------------------
       A city carries fifty-odd flags and the far half of them are four
       pixels across. physics.js sets these from the camera distance;
       -1 means "use the authored value". lodSkip runs the cloth on one
       fixed step in N — never a longer dt, because verlet's stability
       is dt^2 and a variable dt gains energy. A distant flag therefore
       animates slower, not wronger. */
    this.lodIter = -1;
    this.lodStruct = -1;
    this.lodSkip = 1;
    this.lodPhase = 0;
    this._lodTick = 0;
    this._dirty = true;

    this.windSampler = opts.wind ?? null;   // injected by physics.js
    this._acc = new Float32Array(N * 3);
    this._nrm = new Float32Array(N * 3);
    /* World-space centre of the sheet — what the LOD measures against. */
    this.centre = this.origin.clone()
      .addScaledVector(this.right, o.width * 0.5)
      .addScaledVector(this.down, o.height * 0.5);
    this.geometry = null;
    if (o.geometry) this.buildGeometry();
    this._inv = o.object3D ? new THREE.Matrix4() : null;
  }

  /**
   * Fold pinned-ness and stiffness into a per-constraint correction
   * weight pair. Exactly reproduces the original branch ladder:
   *   both pinned -> nothing moves            (0, 0)
   *   a pinned    -> b takes the whole offset (0, 2)
   *   b pinned    -> a takes the whole offset (2, 0)
   *   neither     -> split it                 (1, 1)
   * Called again whenever pinning changes, so setPin() stays correct.
   */
  _bakeWeights() {
    for (let k = 0; k < this.consCount; k++) {
      const a = this.cIdx[k * 2] / 3, b = this.cIdx[k * 2 + 1] / 3;
      const pa = this.pinned[a], pb = this.pinned[b];
      const s = this.cStiff[k] * 0.5;
      let wa, wb;
      if (pa && pb) { wa = 0; wb = 0; }
      else if (pa) { wa = 0; wb = 2; }
      else if (pb) { wa = 2; wb = 0; }
      else { wa = 1; wb = 1; }
      this.cKa[k] = s * wa;
      this.cKb[k] = s * wb;
    }
    return this;
  }

  /**
   * LOD knobs, set by physics.js from the camera distance.
   * @param iter   solver iterations, or -1 for the authored count
   * @param struct extra structural-only passes, or -1 for authored
   * @param skip   run one fixed step in `skip` (1 = every step)
   */
  setLod(iter = -1, struct = -1, skip = 1) {
    this.lodIter = iter;
    this.lodStruct = struct;
    this.lodSkip = Math.max(1, skip | 0);
    return this;
  }
  /** True if this cloth should run on the current fixed step. */
  lodDue() {
    const n = this._lodTick++;
    return this.lodSkip <= 1 || ((n + this.lodPhase) % this.lodSkip) === 0;
  }

  _applyPinning(pin) {
    const C = this.cols, R = this.rows;
    const set = (c, r) => { this.pinned[r * C + c] = 1; };
    if (typeof pin === 'function') {
      for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) if (pin(c, r, C, R)) set(c, r);
    } else if (Array.isArray(pin)) {
      for (const i of pin) this.pinned[i] = 1;
    } else if (pin === 'left') { for (let r = 0; r < R; r++) set(0, r); }
    else if (pin === 'right') { for (let r = 0; r < R; r++) set(C - 1, r); }
    else if (pin === 'top') { for (let c = 0; c < C; c++) set(c, 0); }
    else if (pin === 'top-corners') { set(0, 0); set(C - 1, 0); }
    else if (pin === 'left-top') { for (let r = 0; r < R; r++) set(0, r); for (let c = 0; c < C; c++) set(c, 0); }
    else if (pin === 'corners') { set(0, 0); set(C - 1, 0); set(0, R - 1); set(C - 1, R - 1); }
    /* pin === 'none' / null leaves everything free. */
  }

  /** BFS over the structural grid: link distance from the nearest pin. */
  _buildFreeWeight() {
    const C = this.cols, R = this.rows, N = this.count, d = this.freeWeight;
    d.fill(-1);
    const queue = [];
    for (let p = 0; p < N; p++) if (this.pinned[p]) { d[p] = 0; queue.push(p); }
    if (!queue.length) { d.fill(1); return; }        // free-floating sheet
    let head = 0, far = 0;
    while (head < queue.length) {
      const p = queue[head++];
      const c = p % C, r = (p / C) | 0;
      const nd = d[p] + 1;
      if (c > 0 && d[p - 1] < 0) { d[p - 1] = nd; queue.push(p - 1); }
      if (c + 1 < C && d[p + 1] < 0) { d[p + 1] = nd; queue.push(p + 1); }
      if (r > 0 && d[p - C] < 0) { d[p - C] = nd; queue.push(p - C); }
      if (r + 1 < R && d[p + C] < 0) { d[p + C] = nd; queue.push(p + C); }
      if (d[p] > far) far = d[p];
    }
    const inv = far > 0 ? 1 / far : 1;
    for (let p = 0; p < N; p++) d[p] = d[p] > 0 ? d[p] * inv : 0;
    return this;
  }

  /** Move a pinned particle (a flagpole that sways, an awning on a cart). */
  setPin(index, x, y, z) {
    const i = index * 3;
    this.pos[i] = this.prev[i] = x;
    this.pos[i + 1] = this.prev[i + 1] = y;
    this.pos[i + 2] = this.prev[i + 2] = z;
    if (!this.pinned[index]) {
      this.pinned[index] = 1;
      this._buildFreeWeight();
      this._bakeWeights();          // pinning changes the solver weights
    }
    this._dirty = true;
    return this;
  }
  /** Rigid-translate every pin, keeping the cloth's own motion. */
  movePins(dx, dy, dz) {
    for (let p = 0; p < this.count; p++) {
      if (!this.pinned[p]) continue;
      const i = p * 3;
      this.pos[i] += dx; this.pos[i + 1] += dy; this.pos[i + 2] += dz;
      this.prev[i] += dx; this.prev[i + 1] += dy; this.prev[i + 2] += dz;
    }
    this.origin.x += dx; this.origin.y += dy; this.origin.z += dz;
    this.centre.x += dx; this.centre.y += dy; this.centre.z += dz;
    this._dirty = true;
    return this;
  }

  index(c, r) { return r * this.cols + c; }
  getPoint(index, out = new THREE.Vector3()) {
    const i = index * 3;
    return out.set(this.pos[i], this.pos[i + 1], this.pos[i + 2]);
  }

  /* ---------------- simulation ---------------- */
  step(dt) {
    if (!this.enabled || dt <= 0) return this;
    const o = this.opts;
    const N = this.count;
    const P = this.pos, V = this.prev, A = this._acc;
    this.time += dt;
    this._dirty = true;

    const gravity = o.gravity;
    for (let i = 0; i < N * 3; i += 3) { A[i] = 0; A[i + 1] = -gravity; A[i + 2] = 0; }

    /* --- wind, per quad, along the quad normal --- */
    if (this.windSampler && o.windScale !== 0) {
      this._quadNormals();
      const C = this.cols;
      const NRM = this._nrm, D = this.freeWeight;
      const k = o.windScale * 9.0;
      const invDt = 1 / dt;
      const TAU = Math.PI * 2;
      const t = this.time;
      /* Hoisted: these are read once per particle otherwise, and an
         options-object load inside a 3000-iteration loop is not free. */
      const oLift = o.windLift, oFlut = o.flutter, oWaves = o.flutterWaves;
      const oHz = o.flutterHz, oDrag = o.normalDrag, ph0 = this.phase;
      const sampler = this.windSampler;
      for (let p = 0; p < N; p++) {
        const i = p * 3;
        const c = p % C, r = (p / C) | 0;
        const w = sampler(P[i], P[i + 2], ph0 + c * 0.37 + r * 0.19);
        const wx = w.x, wy = w.y ?? 0, wz = w.z;
        const nx = NRM[i], ny = NRM[i + 1], nz = NRM[i + 2];
        const along = wx * nx + wy * ny + wz * nz;

        /* Pressure on the sheet: normal component drives billow, the
           tangential remainder drags the free edge downwind. */
        A[i] += (nx * along * oLift + wx * (1 - oLift)) * k;
        A[i + 1] += (ny * along * oLift + wy * (1 - oLift)) * k;
        A[i + 2] += (nz * along * oLift + wz * (1 - oLift)) * k;

        /* --- THE FLAP -------------------------------------------------
           The billow term above is a dot product with the sheet normal,
           so a flag whose plane CONTAINS the wind direction — which is
           every flag hanging off a pole in a horizontal wind field —
           gets exactly zero out-of-plane force. It pulls itself taut,
           finds a static equilibrium and dies. A flag that goes still in
           the wind is the most noticeable dead thing in a Wind Waker
           game (ART_DIRECTION §2.3, §4).

           Real air is not a laminar sheet: the pressure difference
           across a thin membrane fluctuates over a short correlation
           length, and the disturbance TRAVELS downwind, growing as it
           goes. Modelling that as a travelling wave of pressure along
           the sheet's own normal is what produces flutter — and because
           its amplitude is the LOCAL wind speed sampled per particle
           from the shared field, the waves vary across the cloth in
           space and in time, and every flag in the city snaps together
           when it gusts.

           Wave coordinate = distance from the anchor, so crests run from
           the hoist to the fly end and the amplitude envelope grows with
           it. The second harmonic is skewed across the other axis so the
           crests are not flat stripes. */
        const speed = Math.sqrt(wx * wx + wy * wy + wz * wz);
        const d = D[p];
        const ph = TAU * (d * oWaves - t * oHz) + ph0 + r * 0.62;
        const flap = (Math.sin(ph) + 0.42 * Math.sin(ph * 2.7 + c * 0.31))
                   * oFlut * speed * d * k;

        /* Air resists motion ACROSS a sheet far more than along it. This
           is what keeps the flutter a slow swell instead of a shimmer,
           and it costs nothing while the cloth is still. */
        const nv = ((P[i] - V[i]) * nx + (P[i + 1] - V[i + 1]) * ny
                  + (P[i + 2] - V[i + 2]) * nz) * invDt;
        const push = flap - nv * oDrag;
        A[i] += nx * push; A[i + 1] += ny * push; A[i + 2] += nz * push;
      }
    }

    /* --- verlet integration --- */
    const dt2 = dt * dt;
    const drag = 1 - o.damping;
    const maxStep = o.maxStep;
    const maxStep2 = maxStep * maxStep;
    const PIN = this.pinned;
    for (let p = 0; p < N; p++) {
      const i = p * 3;
      if (PIN[p]) { V[i] = P[i]; V[i + 1] = P[i + 1]; V[i + 2] = P[i + 2]; continue; }
      let vx = (P[i] - V[i]) * drag;
      let vy = (P[i + 1] - V[i + 1]) * drag;
      let vz = (P[i + 2] - V[i + 2]) * drag;
      /* Compare squared first — the clamp almost never fires, and the
         sqrt it used to cost fired on every particle of every cloth. */
      const vl2 = vx * vx + vy * vy + vz * vz;
      if (vl2 > maxStep2) { const s = maxStep / Math.sqrt(vl2); vx *= s; vy *= s; vz *= s; }
      V[i] = P[i]; V[i + 1] = P[i + 1]; V[i + 2] = P[i + 2];
      P[i] += vx + A[i] * dt2;
      P[i + 1] += vy + A[i + 1] * dt2;
      P[i + 2] += vz + A[i + 2] * dt2;
    }

    /* --- constraints ---
       LOD may cut the pass counts; -1 means the authored value. */
    const iters = this.lodIter >= 0 ? this.lodIter : o.iterations;
    const spass = this.lodStruct >= 0 ? this.lodStruct : o.structuralPasses;
    const I = this.cIdx, R = this.cRest, KA = this.cKa, KB = this.cKb;
    for (let it = 0; it < iters; it++) {
      solveRange(P, I, R, KA, KB, 0, this.consCount);
      if (o.collide) this._collide();
    }
    /* Extra structural-only passes: cheap, and they are what keeps the
       load-bearing edges rigid without stiffening the fold behaviour. */
    for (let it = 0; it < spass; it++) solveRange(P, I, R, KA, KB, 0, this.structCount);

    /* --- NaN guard: one bad frame must not kill the flag forever ---
       One accumulating pass and a single isFinite instead of N of them;
       the repair loop only runs on the frame something actually blew up. */
    let sum = 0;
    for (let i = 0; i < N * 3; i++) sum += P[i];
    if (!Number.isFinite(sum)) {
      for (let p = 0; p < N; p++) {
        const i = p * 3;
        if (!Number.isFinite(P[i] + P[i + 1] + P[i + 2])) {
          P[i] = V[i] = this.rest[i];
          P[i + 1] = V[i + 1] = this.rest[i + 1];
          P[i + 2] = V[i + 2] = this.rest[i + 2];
        }
      }
    }
    return this;
  }

  _collide() {
    const c = typeof this.opts.collide === 'function' ? this.opts.collide() : this.opts.collide;
    if (!c || !c.position) return;
    const cx = c.position.x, cy = c.position.y, cz = c.position.z, r = c.radius ?? 0.4;
    const P = this.pos;
    for (let p = 0; p < this.count; p++) {
      if (this.pinned[p]) continue;
      const i = p * 3;
      const dx = P[i] - cx, dy = P[i + 1] - cy, dz = P[i + 2] - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r * r || d2 <= 1e-12) continue;
      const d = Math.sqrt(d2);
      {
        const s = r / d;
        P[i] = cx + dx * s; P[i + 1] = cy + dy * s; P[i + 2] = cz + dz * s;
      }
    }
  }

  /** Smooth per-vertex normals from the quad grid. Also used by the wind. */
  _quadNormals() {
    const C = this.cols, R = this.rows, P = this.pos, N = this._nrm;
    N.fill(0);
    for (let r = 0; r < R - 1; r++) {
      for (let c = 0; c < C - 1; c++) {
        const i0 = (r * C + c) * 3, i1 = (r * C + c + 1) * 3, i2 = ((r + 1) * C + c) * 3;
        _e1.set(P[i1] - P[i0], P[i1 + 1] - P[i0 + 1], P[i1 + 2] - P[i0 + 2]);
        _e2.set(P[i2] - P[i0], P[i2 + 1] - P[i0 + 1], P[i2 + 2] - P[i0 + 2]);
        _nq.crossVectors(_e1, _e2);
        const i3 = ((r + 1) * C + c + 1) * 3;
        N[i0] += _nq.x; N[i0 + 1] += _nq.y; N[i0 + 2] += _nq.z;
        N[i1] += _nq.x; N[i1 + 1] += _nq.y; N[i1 + 2] += _nq.z;
        N[i2] += _nq.x; N[i2 + 1] += _nq.y; N[i2 + 2] += _nq.z;
        N[i3] += _nq.x; N[i3 + 1] += _nq.y; N[i3 + 2] += _nq.z;
      }
    }
    for (let p = 0; p < this.count; p++) {
      const i = p * 3;
      const nx = N[i], ny = N[i + 1], nz = N[i + 2];
      const l2 = nx * nx + ny * ny + nz * nz;
      if (l2 > 1e-18) { const inv = 1 / Math.sqrt(l2); N[i] = nx * inv; N[i + 1] = ny * inv; N[i + 2] = nz * inv; }
      else { N[i] = this.normalHint.x; N[i + 1] = this.normalHint.y; N[i + 2] = this.normalHint.z; }
    }
  }

  /* ---------------- output ---------------- */
  /** Build (once) an indexed grid geometry with UVs that we keep updated. */
  buildGeometry() {
    const C = this.cols, R = this.rows;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.count * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.count * 3), 3));
    const uv = new Float32Array(this.count * 2);
    for (let r = 0; r < R; r++)
      for (let c = 0; c < C; c++) {
        const i = (r * C + c) * 2;
        uv[i] = c / (C - 1); uv[i + 1] = 1 - r / (R - 1);
      }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const idx = [];
    for (let r = 0; r < R - 1; r++)
      for (let c = 0; c < C - 1; c++) {
        const a = r * C + c, b = a + 1, d = a + C, e = d + 1;
        idx.push(a, d, b, b, d, e);
        if (this.opts.doubleSided) idx.push(a, b, d, b, e, d);
      }
    g.setIndex(idx);
    g.attributes.position.setUsage(THREE.DynamicDrawUsage);
    g.attributes.normal.setUsage(THREE.DynamicDrawUsage);
    this.geometry = g;
    this.sync();
    return g;
  }

  /** Push simulated positions + normals into the geometry. */
  sync(force = false) {
    if (!this.geometry) return this;
    /* Nothing moved since the last sync — a slept or LOD-skipped cloth
       does not need its normals recomputed, its buffers re-uploaded and
       its bounding sphere rebuilt. object3D cloths always re-sync: their
       output is in a transform we do not own. */
    if (!force && !this._dirty && !this.opts.object3D) return this;
    this._dirty = false;
    this._quadNormals();
    const pa = this.geometry.attributes.position;
    const na = this.geometry.attributes.normal;
    const obj = this.opts.object3D;
    if (obj) {
      obj.updateWorldMatrix(true, false);
      this._inv.copy(obj.matrixWorld).invert();
      for (let p = 0; p < this.count; p++) {
        const i = p * 3;
        _v.set(this.pos[i], this.pos[i + 1], this.pos[i + 2]).applyMatrix4(this._inv);
        pa.array[i] = _v.x; pa.array[i + 1] = _v.y; pa.array[i + 2] = _v.z;
      }
      na.array.set(this._nrm);
    } else {
      pa.array.set(this.pos);
      na.array.set(this._nrm);
    }
    pa.needsUpdate = true;
    na.needsUpdate = true;
    this.geometry.computeBoundingSphere();
    return this;
  }

  /** Total kinetic-ish energy — tests and LOD sleep use this. */
  get energy() {
    let e = 0;
    for (let p = 0; p < this.count; p++) {
      const i = p * 3;
      e += (this.pos[i] - this.prev[i]) ** 2 + (this.pos[i + 1] - this.prev[i + 1]) ** 2 + (this.pos[i + 2] - this.prev[i + 2]) ** 2;
    }
    return e;
  }
  /** Worst structural-edge stretch as a ratio. 1.0 = perfect. */
  get maxStretch() {
    let worst = 1;
    const P = this.pos, I = this.cIdx;
    for (let k = 0; k < this.consCount; k++) {
      if (this.cStiff[k] < 0.99) continue;               // structural only
      const a = I[k * 2], b = I[k * 2 + 1], rest = this.cRest[k];
      const dx = P[b] - P[a], dy = P[b + 1] - P[a + 1], dz = P[b + 2] - P[a + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      worst = Math.max(worst, d / rest, rest / Math.max(d, 1e-9));
    }
    return worst;
  }

  reset() {
    this.pos.set(this.rest);
    this.prev.set(this.rest);
    this._dirty = true;
    return this;
  }
  dispose() {
    this.enabled = false;
    this.geometry?.dispose();
    this.geometry = null;
  }
}

export function createCloth(opts) { return new Cloth(opts); }
export default Cloth;
