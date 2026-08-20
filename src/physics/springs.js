/* ============================================================
   springs.js — the damped-spring solver.

   ART_DIRECTION §4: "Ear physics ... THIS IS THE MOST VISIBLE PIECE OF
   POLISH IN THE GAME."  Everything secondary in this project moves
   through this file: ears, trunk, tail, belly jiggle, the camera rig,
   awning ropes, hanging signs.

   Three layers, cheapest first:

     Spring1     scalar   value/velocity, sub-stepped, unconditionally
                          stable at any stiffness we will ever use
     Spring3     vec3     same, on THREE.Vector3
     SpringChain N-bone   an anchored chain of point masses that springs
                          toward a rest pose carried by a root transform,
                          with gravity, wind, inertia, per-bone
                          stiffness/damping, angular limits and a curl
                          parameter. Outputs bone quaternions.

   WHY THE CHAIN LOOKS RIGHT
   -------------------------
   Each node is sprung toward *its rest position expressed in the root's
   current world transform*. So the instant Wally turns, accelerates,
   stops or lands, the rest pose teleports and the chain has to chase it.
   Under-damped (zeta < 1) that chase overshoots and settles — which is
   exactly the flap-and-settle the art direction asks for. Gravity, wind
   and an explicit -m*a inertia term are added on top.

   Integration is semi-implicit Euler for the force pass followed by a
   PBD constraint pass (length + angle), then velocity is recovered from
   the position delta. That combination does not blow up, does not creep,
   and keeps segment lengths exact.

   SIX-LINE EAR (this is the target ergonomics):

     const earL = ctx.phys.createChain({
       preset: 'ear',                            // 3 bones, tuned
       bones: [earL0, earL1, earL2],             // a real skeleton chain
       root: headBone,
       restDir: [-0.92, -0.34, 0.18],            // where it hangs at rest
       phase: 0.0, follow: ctx.phys.player,      // wind + his acceleration
     });
     // ...and nothing else. ctx.phys steps it at 60 Hz, interpolates it,
     // and writes the bone quaternions in lateUpdate. Give the right ear
     // phase: 2.1 so the two never move in lockstep, and call
     //   earL.impulse(v) / earL.setCurl(rad)
     // for landing flaps and a deliberate perk.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { clamp, damp } from '../core/contracts.js';

const DEG = Math.PI / 180;

/* Scratch — module-level so the solver allocates nothing per frame. */
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _q4 = new THREE.Quaternion();
const _q5 = new THREE.Quaternion();

/* Resolve (stiffness, damping | dampingRatio) into a concrete pair.
   dampingRatio 1.0 = critical (no overshoot), 0.3-0.5 = the lively
   flap we want on ears, 0.7-0.9 = trunk, 1.0 = camera. */
function resolveDamping(stiffness, damping, dampingRatio) {
  if (damping != null) return damping;
  const zeta = dampingRatio != null ? dampingRatio : 1.0;
  return 2 * zeta * Math.sqrt(Math.max(stiffness, 1e-6));
}

/* Number of sub-steps needed to keep explicit integration stable.
   Semi-implicit Euler needs dt * omega < 2; we target 0.35 for accuracy. */
function stableSubsteps(stiffness, damping, dt, cap = 8) {
  const omega = Math.sqrt(Math.max(stiffness, 1e-6));
  const need = Math.max(dt * omega / 0.35, dt * damping / 0.7);
  return clamp(Math.ceil(need), 1, cap);
}

/* ------------------------------------------------------------------
   Spring1 — scalar damped spring.
   ------------------------------------------------------------------ */
export class Spring1 {
  constructor(opts = {}) {
    this.value = opts.value ?? 0;
    this.target = opts.target ?? this.value;
    this.velocity = opts.velocity ?? 0;
    this.stiffness = opts.stiffness ?? 120;
    this.damping = resolveDamping(this.stiffness, opts.damping, opts.dampingRatio);
    this.maxVelocity = opts.maxVelocity ?? Infinity;
  }
  set(v, keepVelocity = false) {
    this.value = v;
    if (!keepVelocity) this.velocity = 0;
    return this;
  }
  /** Kick the spring — this is how you make a landing thump read. */
  impulse(v) { this.velocity += v; return this; }
  step(dt, target = this.target) {
    this.target = target;
    const n = stableSubsteps(this.stiffness, this.damping, dt);
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = (this.target - this.value) * this.stiffness - this.velocity * this.damping;
      this.velocity += a * h;
      if (this.velocity > this.maxVelocity) this.velocity = this.maxVelocity;
      else if (this.velocity < -this.maxVelocity) this.velocity = -this.maxVelocity;
      this.value += this.velocity * h;
    }
    if (!Number.isFinite(this.value)) { this.value = this.target; this.velocity = 0; }
    return this.value;
  }
  get settled() { return Math.abs(this.velocity) < 1e-3 && Math.abs(this.target - this.value) < 1e-3; }
}

/* ------------------------------------------------------------------
   Spring3 — vector damped spring. The camera rig lives on this.
   ------------------------------------------------------------------ */
export class Spring3 {
  constructor(opts = {}) {
    this.value = new THREE.Vector3().copy(opts.value ?? new THREE.Vector3());
    this.target = new THREE.Vector3().copy(opts.target ?? this.value);
    this.velocity = new THREE.Vector3().copy(opts.velocity ?? new THREE.Vector3());
    this.stiffness = opts.stiffness ?? 120;
    this.damping = resolveDamping(this.stiffness, opts.damping, opts.dampingRatio);
    this.maxVelocity = opts.maxVelocity ?? Infinity;
  }
  set(v, keepVelocity = false) {
    this.value.copy(v);
    if (!keepVelocity) this.velocity.set(0, 0, 0);
    return this;
  }
  impulse(v) { this.velocity.add(v); return this; }
  step(dt, target) {
    if (target) this.target.copy(target);
    const n = stableSubsteps(this.stiffness, this.damping, dt);
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      _v0.copy(this.target).sub(this.value).multiplyScalar(this.stiffness)
         .addScaledVector(this.velocity, -this.damping);
      this.velocity.addScaledVector(_v0, h);
      const sp = this.velocity.length();
      if (sp > this.maxVelocity) this.velocity.multiplyScalar(this.maxVelocity / sp);
      this.value.addScaledVector(this.velocity, h);
    }
    if (!Number.isFinite(this.value.x + this.value.y + this.value.z)) {
      this.value.copy(this.target); this.velocity.set(0, 0, 0);
    }
    return this.value;
  }
  get settled() {
    return this.velocity.lengthSq() < 1e-6 && this.value.distanceToSquared(this.target) < 1e-6;
  }
}

/* ------------------------------------------------------------------
   SpringChain — the N-bone chain.

   Every option, with the value it takes if you omit it:

     bones          Object3D[] | int   real bones to drive, or a count
     root           Object3D           attach transform (head bone, hips…)
     offset         [x,y,z]  [0,0,0]   attach point in ROOT-LOCAL space
     length         num|num[]  0.1     segment length(s), metres
     restDir        [x,y,z]  [0,-1,0]  segment-0 rest direction, ROOT-LOCAL
     curlAxis       [x,y,z]  [1,0,0]   axis the curl parameter bends about
     curl           rad      0         extra bend PER SEGMENT
     curlStiffness  num      90        how fast curl changes are chased
     stiffness      num|num[] 160      spring constant; arrays are per bone
     stiffnessFalloff num    0.68      per-bone multiplier (tips looser)
     dampingRatio   num      0.4       <1 overshoots — THAT is the flap
     damping        num|num[] auto     absolute, overrides dampingRatio
     mass           num|num[] 1
     gravity        m/s^2    6.0
     windScale      num      1.0       0 to opt out of the wind field
     inertiaScale   num      1.0       how hard body acceleration whips it
     drag           num      0.06
     maxAngle       deg      70        bend limit between segments
     rootMaxAngle   deg      =maxAngle bend limit at the anchor
     maxSpeed       m/s      40
     stretch        num      0.0       0 = inextensible
     iterations     int      4         PBD passes per substep
     substeps       int      1
     phase          num      0         wind phase — offset the two ears!
     enabled/auto/apply  bool true     auto=stepped by ctx.phys

   Methods: follow(controller), setAcceleration(v3), addForce(v3),
   impulse(v3, from, falloff), setCurl(rad), setRestDir(x,y,z),
   setStiffness(k, zeta), reset(), step(dt), apply(), dispose().
   Outputs: points[], worldDir[], localQuat[], tip, energy, deviation.
   ------------------------------------------------------------------ */
export const CHAIN_DEFAULTS = {
  bones: 3, root: null, offset: [0, 0, 0],
  length: 0.1, restDir: [0, -1, 0], curlAxis: [1, 0, 0], curl: 0,
  stiffness: 160, stiffnessFalloff: 0.68, dampingRatio: 0.4, mass: 1,
  gravity: 6.0, windScale: 1.0, inertiaScale: 1.0, drag: 0.06,
  maxAngle: 70, maxSpeed: 40, stretch: 0.0,
  iterations: 4, substeps: 1, phase: 0,
};

/* Tuned starting points. Pass `preset: 'ear'` to ctx.phys.createChain and
   override whatever you like on top. These are the numbers the art
   direction's "flap when he runs, settle with a slight overshoot" was
   dialled in against. */
export const CHAIN_PRESETS = {
  /* 3 bones, ART_DIRECTION §4. Loose, light, catches every gust. */
  ear: {
    bones: 3, length: 0.09, stiffness: 210, dampingRatio: 0.36,
    gravity: 5.5, windScale: 1.6, inertiaScale: 1.15, drag: 0.05,
    maxAngle: 62, rootMaxAngle: 48, iterations: 4,
  },
  /* 5 bones, heavier, more damped — it swings, it does not flutter. */
  trunk: {
    bones: 5, length: 0.085, stiffness: 260, dampingRatio: 0.62,
    gravity: 8.5, windScale: 0.35, inertiaScale: 0.9, drag: 0.09,
    maxAngle: 38, rootMaxAngle: 26, iterations: 5,
  },
  /* Tiny, fast, barely visible — but a still tail reads as a dead prop. */
  tail: {
    bones: 2, length: 0.05, stiffness: 320, dampingRatio: 0.3,
    gravity: 6, windScale: 0.9, inertiaScale: 1.4, maxAngle: 55,
  },
  /* Camera boom / any single-segment lag. Critically damped: no wobble. */
  boom: {
    bones: 1, length: 1.0, stiffness: 90, dampingRatio: 1.0,
    gravity: 0, windScale: 0, inertiaScale: 0.4, maxAngle: 40,
  },
  /* Hanging signs, lanterns, mooring ropes, awning pulls. */
  rope: {
    bones: 4, length: 0.22, stiffness: 120, dampingRatio: 0.28,
    gravity: 9.4, windScale: 1.25, inertiaScale: 1.0, maxAngle: 85,
  },
};

export class SpringChain {
  constructor(opts = {}) {
    const boneArg = opts.bones ?? 3;
    /** Optional real Object3D bones we drive. */
    this.bones = Array.isArray(boneArg) ? boneArg.slice() : null;
    /** Segment count. */
    this.n = Array.isArray(boneArg) ? boneArg.length : (boneArg | 0);
    if (this.n < 1) throw new Error('SpringChain needs at least 1 bone');

    this.name = opts.name ?? 'chain';
    this.enabled = opts.enabled !== false;
    this.auto = opts.auto !== false;          // stepped by ctx.phys
    this.writeBones = opts.apply !== false;   // write quaternions in apply()

    /* Attach transform. Anything with .matrixWorld works (Bone, Object3D,
       Group). Without one, drive it by hand with setRoot(). */
    this.root = opts.root ?? null;

    const per = (v, d) => {
      const out = new Float64Array(this.n);
      if (Array.isArray(v)) for (let i = 0; i < this.n; i++) out[i] = v[Math.min(i, v.length - 1)];
      else out.fill(v ?? d);
      return out;
    };

    this.length = per(opts.length, 0.1);
    this.stiffness = per(opts.stiffness, 160);
    this.mass = per(opts.mass, 1);
    this._dampingRatio = opts.dampingRatio ?? null;
    this.damping = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      this.damping[i] = Array.isArray(opts.damping)
        ? opts.damping[Math.min(i, opts.damping.length - 1)]
        : resolveDamping(this.stiffness[i], opts.damping, this._dampingRatio ?? 0.4);
    }
    /* Tips should always be looser than roots or the chain reads as a
       stick. Applied as a multiplier unless the caller gave arrays. */
    if (!Array.isArray(opts.stiffness)) {
      const falloff = opts.stiffnessFalloff ?? 0.68;
      for (let i = 0; i < this.n; i++) {
        const k = Math.pow(falloff, i);
        this.stiffness[i] *= k;
        this.damping[i] *= Math.sqrt(k);
      }
    }

    this.gravity = opts.gravity ?? 6.0;         // m/s^2, world -Y
    this.windScale = opts.windScale ?? 1.0;
    this.inertiaScale = opts.inertiaScale ?? 1.0;
    this.drag = opts.drag ?? 0.06;
    this.iterations = opts.iterations ?? 4;
    this.substeps = opts.substeps ?? 1;
    this.maxAngle = (opts.maxAngle ?? 70) * DEG;
    this.rootMaxAngle = (opts.rootMaxAngle ?? opts.maxAngle ?? 70) * DEG;
    this.maxSpeed = opts.maxSpeed ?? 40;
    this.stretch = opts.stretch ?? 0.0;

    /* Rest direction of segment 0 in ROOT-LOCAL space. Subsequent
       segments inherit it, bent progressively by `curl`. */
    const rd = opts.restDir ?? [0, -1, 0];
    this.restDir = new THREE.Vector3(rd[0] ?? rd.x, rd[1] ?? rd.y, rd[2] ?? rd.z).normalize();
    const ca = opts.curlAxis ?? [1, 0, 0];
    this.curlAxis = new THREE.Vector3(ca[0] ?? ca.x, ca[1] ?? ca.y, ca[2] ?? ca.z).normalize();
    this.curl = opts.curl ?? 0;               // radians of extra bend PER SEGMENT
    this._curlSpring = new Spring1({ value: this.curl, stiffness: opts.curlStiffness ?? 90, dampingRatio: 0.9 });

    /* Root-local offset of the attach point (e.g. ear root off the head). */
    const ro = opts.offset ?? [0, 0, 0];
    this.offset = new THREE.Vector3(ro[0] ?? ro.x ?? 0, ro[1] ?? ro.y ?? 0, ro[2] ?? ro.z ?? 0);

    /* ---- state ---- */
    this.points = [];       // world positions, points[0] is the anchor
    this.prev = [];
    this.vel = [];
    this.restWorld = [];    // world-space rest position per node
    this.restLocalDir = []; // per-segment rest direction, root-local
    for (let i = 0; i <= this.n; i++) {
      this.points.push(new THREE.Vector3());
      this.prev.push(new THREE.Vector3());
      this.vel.push(new THREE.Vector3());
      this.restWorld.push(new THREE.Vector3());
    }
    for (let i = 0; i < this.n; i++) this.restLocalDir.push(new THREE.Vector3());

    this.rootPos = new THREE.Vector3();
    this.rootQuat = new THREE.Quaternion();
    this._prevRootPos = new THREE.Vector3();
    this._rootVel = new THREE.Vector3();
    this._rootAccel = new THREE.Vector3();
    this._extAccel = new THREE.Vector3();   // externally supplied (controller)
    this._force = new THREE.Vector3();      // one-shot force accumulator
    this._wind = new THREE.Vector3();
    this._bodyAccel = new THREE.Vector3();  // persistent: scratch is not safe here
    this._haveRoot = false;

    /* Render interpolation. The solver runs at a fixed 60 Hz; on a frame
       where the accumulator produced 0 or 2 steps the raw points would
       stutter, so outputs are read off a lerp between the pose at the
       start of the frame and the pose now. */
    this.framePrev = [];
    this.render = [];
    for (let i = 0; i <= this.n; i++) {
      this.framePrev.push(new THREE.Vector3());
      this.render.push(new THREE.Vector3());
    }

    /* Outputs the consumer reads. */
    this.worldDir = [];       // unit direction of each segment, world space
    this.localQuat = [];      // rest->current delta, expressed in root space
    this.bindQuat = [];       // bone local quaternions captured at bind
    for (let i = 0; i < this.n; i++) {
      this.worldDir.push(new THREE.Vector3());
      this.localQuat.push(new THREE.Quaternion());
      this.bindQuat.push(new THREE.Quaternion());
    }
    if (this.bones) {
      for (let i = 0; i < this.n; i++) this.bindQuat[i].copy(this.bones[i].quaternion);
    }

    /* Wind sampling: a phase per chain so two ears never move in lockstep. */
    this.phase = opts.phase ?? 0;
    this.windSampler = opts.wind ?? null;   // (x,z,phase) -> {x,y,z}; phys injects ctx.wind

    this._source = null;      // controller / object we inherit acceleration from
    this._settleT = 0;

    if (this.root) this.readRoot();
    else this.setRoot(opts.position ?? new THREE.Vector3(), opts.quaternion ?? new THREE.Quaternion());
    this.reset();
  }

  /* ---- rest pose ------------------------------------------------ */
  _rebuildRestDirs() {
    const c = this._curlSpring.value;
    for (let i = 0; i < this.n; i++) {
      const d = this.restLocalDir[i].copy(this.restDir);
      if (c !== 0) {
        _q0.setFromAxisAngle(this.curlAxis, c * (i + 1));
        d.applyQuaternion(_q0);
      }
      d.normalize();
    }
  }
  _rebuildRestWorld() {
    /* Anchored at the ROOT, not at points[0] — points[0] is only synced
       to the root inside step(), and reset() runs before that. */
    this.restWorld[0].copy(this.rootPos);
    for (let i = 0; i < this.n; i++) {
      _v0.copy(this.restLocalDir[i]).applyQuaternion(this.rootQuat);
      this.restWorld[i + 1].copy(this.restWorld[i]).addScaledVector(_v0, this.length[i]);
    }
  }

  /** Snap the whole chain onto its rest pose with zero velocity. */
  reset() {
    this.readRoot(true);
    this._rebuildRestDirs();
    this._rebuildRestWorld();
    for (let i = 0; i <= this.n; i++) {
      this.points[i].copy(this.restWorld[i]);
      this.prev[i].copy(this.restWorld[i]);
      this.framePrev[i].copy(this.restWorld[i]);
      this.render[i].copy(this.restWorld[i]);
      this.vel[i].set(0, 0, 0);
    }
    this._rootAccel.set(0, 0, 0);
    this._rootVel.set(0, 0, 0);
    this._updateOutputs(this.points);
    return this;
  }

  /** Snapshot the pose for render interpolation. ctx.phys calls this once
      per FRAME, before the frame's fixed steps. */
  beginFrame() {
    for (let i = 0; i <= this.n; i++) this.framePrev[i].copy(this.points[i]);
    return this;
  }
  /** Blend framePrev -> points and refresh the outputs. alpha is the
      accumulator remainder; ctx.phys calls this after the fixed steps. */
  interpolate(alpha = 1) {
    if (alpha >= 0.999) {
      this._updateOutputs(this.points);
      return this;
    }
    for (let i = 0; i <= this.n; i++) {
      this.render[i].lerpVectors(this.framePrev[i], this.points[i], alpha);
    }
    this._updateOutputs(this.render);
    return this;
  }

  /* ---- root ----------------------------------------------------- */
  /** Manual root drive (no Object3D). */
  setRoot(position, quaternion) {
    this.rootPos.copy(position);
    if (quaternion) this.rootQuat.copy(quaternion);
    this._haveRoot = true;
    return this;
  }
  /** Pull the attach transform off the Object3D, if we have one. */
  readRoot(force = false) {
    if (this.root) {
      if (force || this.root.matrixWorldNeedsUpdate) this.root.updateWorldMatrix(true, false);
      this.root.matrixWorld.decompose(_v0, _q0, _v1);
      this.rootQuat.copy(_q0);
      this.rootPos.copy(_v0);
      if (this.offset.lengthSq() > 0) {
        _v2.copy(this.offset).applyQuaternion(_q0).multiply(_v1);
        this.rootPos.add(_v2);
      }
      this._haveRoot = true;
    }
    return this;
  }

  /* ---- inputs --------------------------------------------------- */
  /** Inherit acceleration from a controller or any {acceleration} object. */
  follow(source) { this._source = source; return this; }
  /** Explicit world acceleration input (m/s^2) — turning, running, landing. */
  setAcceleration(a) { this._extAccel.copy(a); return this; }
  /** Continuous world force applied to every node this step. */
  addForce(f) { this._force.add(f); return this; }
  /** Instant velocity kick to the tip-most nodes. THE landing flap. */
  impulse(v, from = 1, falloff = 1.35) {
    for (let i = Math.max(1, from); i <= this.n; i++) {
      const w = Math.pow(i / this.n, falloff);
      this.vel[i].addScaledVector(v, w);
    }
    return this;
  }
  /** Progressive bend of the rest pose. Trunk curl / ear perk lives here. */
  setCurl(radians, immediate = false) {
    this.curl = radians;
    this._curlSpring.target = radians;
    if (immediate) this._curlSpring.set(radians);
    return this;
  }
  setRestDir(x, y, z) {
    if (x.isVector3) this.restDir.copy(x).normalize();
    else this.restDir.set(x, y, z).normalize();
    return this;
  }
  setStiffness(k, dampingRatio) {
    const zeta = dampingRatio ?? this._dampingRatio ?? 0.4;
    const falloff = 0.68;
    for (let i = 0; i < this.n; i++) {
      this.stiffness[i] = k * Math.pow(falloff, i);
      this.damping[i] = resolveDamping(this.stiffness[i], null, zeta);
    }
    return this;
  }

  /* ---- solve ---------------------------------------------------- */
  step(dt) {
    if (!this.enabled || dt <= 0) return this;

    this.readRoot();
    this._curlSpring.step(dt);
    this._rebuildRestDirs();

    /* Anchor. Root velocity/acceleration drive the inertia pseudo-force. */
    if (this._settleT === 0) this._prevRootPos.copy(this.rootPos);
    _v0.copy(this.rootPos).sub(this._prevRootPos).divideScalar(dt);
    _v1.copy(_v0).sub(this._rootVel).divideScalar(dt);
    /* Smooth the finite-difference accel — raw d2p/dt2 is spiky and
       would read as a twitch rather than a whip. */
    this._rootAccel.lerp(_v1, 1 - Math.exp(-28 * dt));
    this._rootVel.copy(_v0);
    this._prevRootPos.copy(this.rootPos);
    this._settleT += dt;

    this.points[0].copy(this.rootPos);
    this._rebuildRestWorld();

    /* Total non-spring acceleration acting on every node. */
    const src = this._source;
    const a = this._bodyAccel;
    if (src && src.acceleration) a.copy(src.acceleration);
    else a.set(0, 0, 0);
    a.add(this._extAccel).add(this._rootAccel);

    if (this.windSampler && this.windScale !== 0) {
      const w = this.windSampler(this.rootPos.x, this.rootPos.z, this.phase);
      this._wind.set(w.x, w.y ?? 0, w.z);
    } else this._wind.set(0, 0, 0);

    const sub = Math.max(1, this.substeps | 0);
    const h = dt / sub;
    for (let s = 0; s < sub; s++) this._substep(h, a);

    this._extAccel.set(0, 0, 0);
    this._force.set(0, 0, 0);
    this._updateOutputs();
    return this;
  }

  _substep(h, bodyAccel) {
    const n = this.n;
    for (let i = 0; i <= n; i++) this.prev[i].copy(this.points[i]);

    /* --- force integration (semi-implicit Euler) --- */
    for (let i = 1; i <= n; i++) {
      const si = i - 1;
      const k = this.stiffness[si];
      const c = this.damping[si];
      const invM = 1 / this.mass[si];
      const tipW = i / n;                          // tips catch more wind

      _v0.copy(this.restWorld[i]).sub(this.points[i]).multiplyScalar(k);
      _v0.addScaledVector(this.vel[i], -c);
      _v0.y -= this.gravity * this.mass[si];
      /* d'Alembert: in the root's frame the chain feels -a. */
      _v0.addScaledVector(bodyAccel, -this.inertiaScale * this.mass[si]);
      _v0.addScaledVector(this._wind, this.windScale * tipW * 8.0 * this.mass[si]);
      _v0.add(this._force);

      this.vel[i].addScaledVector(_v0, invM * h);
      this.vel[i].multiplyScalar(Math.max(0, 1 - this.drag * h * 60));
      const sp = this.vel[i].length();
      if (sp > this.maxSpeed) this.vel[i].multiplyScalar(this.maxSpeed / sp);
      this.points[i].addScaledVector(this.vel[i], h);
    }
    this.points[0].copy(this.rootPos);

    /* --- constraint pass: exact lengths, then angle limits --- */
    for (let it = 0; it < this.iterations; it++) {
      for (let i = 1; i <= n; i++) {
        const L = this.length[i - 1];
        _v0.copy(this.points[i]).sub(this.points[i - 1]);
        let d = _v0.length();
        if (d < 1e-8) { _v0.copy(this.restWorld[i]).sub(this.restWorld[i - 1]).normalize(); d = 1e-8; }
        else _v0.divideScalar(d);
        const slack = L * this.stretch;
        const targetL = clamp(d, L - slack, L + slack);
        this.points[i].copy(this.points[i - 1]).addScaledVector(_v0, targetL);
      }
      this._angleLimits();
    }

    /* --- PBD velocity recovery. Stable, no energy injection. --- */
    for (let i = 1; i <= n; i++) {
      this.vel[i].copy(this.points[i]).sub(this.prev[i]).divideScalar(h);
      if (!Number.isFinite(this.vel[i].x + this.vel[i].y + this.vel[i].z)) {
        this.points[i].copy(this.restWorld[i]);
        this.vel[i].set(0, 0, 0);
      }
    }
  }

  _angleLimits() {
    for (let i = 1; i <= this.n; i++) {
      const L = this.length[i - 1];
      _v0.copy(this.points[i]).sub(this.points[i - 1]);
      if (_v0.lengthSq() < 1e-12) continue;
      _v0.normalize();

      if (i === 1) _v1.copy(this.restLocalDir[0]).applyQuaternion(this.rootQuat);
      else _v1.copy(this.points[i - 1]).sub(this.points[i - 2]).normalize();

      const limit = i === 1 ? this.rootMaxAngle : this.maxAngle;
      const dot = clamp(_v0.dot(_v1), -1, 1);
      const ang = Math.acos(dot);
      if (ang <= limit) continue;

      _v2.crossVectors(_v1, _v0);
      if (_v2.lengthSq() < 1e-12) {
        _v2.set(_v1.y, -_v1.x, _v1.z);
        _v2.crossVectors(_v1, _v2);
        if (_v2.lengthSq() < 1e-12) continue;
      }
      _v2.normalize();
      _q0.setFromAxisAngle(_v2, limit);
      _v3.copy(_v1).applyQuaternion(_q0).normalize();
      this.points[i].copy(this.points[i - 1]).addScaledVector(_v3, L);
    }
  }

  _updateOutputs(src = this.points) {
    for (let i = 0; i < this.n; i++) {
      _v0.copy(src[i + 1]).sub(src[i]);
      if (_v0.lengthSq() < 1e-12) _v0.copy(this.restLocalDir[i]).applyQuaternion(this.rootQuat);
      this.worldDir[i].copy(_v0).normalize();
      _v1.copy(this.restLocalDir[i]).applyQuaternion(this.rootQuat);
      _q0.setFromUnitVectors(_v1, this.worldDir[i]);
      /* Express the world delta in root space so a rig can consume it. */
      _q1.copy(this.rootQuat).invert();
      this.localQuat[i].copy(_q1).multiply(_q0).multiply(this.rootQuat);
    }
  }

  /* ---- output --------------------------------------------------- */
  /** Write the solved orientation onto the Object3D bones.
      Called for you by ctx.phys in lateUpdate when `bones` was given. */
  apply() {
    if (!this.bones || !this.writeBones) return this;
    _q1.copy(this.rootQuat);          // current world quat of bone[i]'s parent
    _q2.copy(this.rootQuat);          // rest    world quat of bone[i]'s parent
    for (let i = 0; i < this.n; i++) {
      /* Where this bone points at rest, in world space. */
      _v1.copy(this.restLocalDir[i]).applyQuaternion(this.rootQuat);
      _q3.copy(_q2).multiply(this.bindQuat[i]);              // restWorldQ
      _q4.setFromUnitVectors(_v1, this.worldDir[i]);         // world aim delta
      _q5.copy(_q4).multiply(_q3);                           // targetWorldQ
      this.bones[i].quaternion.copy(_q0.copy(_q1).invert().multiply(_q5));
      _q1.copy(_q5);
      _q2.copy(_q3);
    }
    return this;
  }

  /** Sum of node speeds — used by tests and by LOD to sleep a chain. */
  get energy() {
    let e = 0;
    for (let i = 1; i <= this.n; i++) e += this.vel[i].lengthSq();
    return e;
  }
  /** Max deviation of any node from its rest position, in metres. */
  get deviation() {
    let d = 0;
    for (let i = 1; i <= this.n; i++) d = Math.max(d, this.points[i].distanceTo(this.restWorld[i]));
    return d;
  }
  get tip() { return this.points[this.n]; }
  dispose() { this.enabled = false; this.bones = null; this.root = null; this._source = null; }
}

export function createSpring(opts) { return new Spring1(opts); }
export function createSpringVec3(opts) { return new Spring3(opts); }
export function createChain(opts) { return new SpringChain(opts); }

/* ------------------------------------------------------------------
   Squash & stretch helper — ART_DIRECTION §4: 8% on takeoff, 14% on
   landing, resolved over 0.18s with an elastic ease, volume preserving.
   ------------------------------------------------------------------ */
export class SquashSpring {
  constructor(opts = {}) {
    /* Period ~0.18s with a lively bounce: omega = 2*pi/0.18 ~= 35 rad/s
       => stiffness = omega^2. zeta 0.34 gives one clean overshoot. */
    this.s = new Spring1({
      value: 1, target: 1,
      stiffness: opts.stiffness ?? 1220,
      dampingRatio: opts.dampingRatio ?? 0.34,
    });
    this.takeoff = opts.takeoff ?? 0.08;
    this.landing = opts.landing ?? 0.14;
    /* For an under-damped spring kicked from rest the peak excursion is
       v0 / omega_d, so convert a desired peak straight into a velocity. */
    const w = Math.sqrt(this.s.stiffness);
    const zeta = this.s.damping / (2 * w);
    this._wd = w * Math.sqrt(Math.max(1 - zeta * zeta, 0.05));
  }
  /** impact 0..1 -> squashes to (1 - landing*impact) at the bottom. */
  land(impact) { this.s.impulse(-this.landing * clamp(impact, 0, 1) * this._wd); return this; }
  jump(power = 1) { this.s.impulse(this.takeoff * clamp(power, 0, 1) * this._wd); return this; }
  step(dt) { this.s.step(dt, 1); return this; }
  /** Y scale. */
  get y() { return clamp(this.s.value, 0.6, 1.45); }
  /** XZ scale, volume preserving. */
  get xz() { return 1 / Math.sqrt(this.y); }
}

export default {
  Spring1, Spring3, SpringChain, SquashSpring,
  createSpring, createSpringVec3, createChain,
  CHAIN_DEFAULTS, CHAIN_PRESETS,
};
