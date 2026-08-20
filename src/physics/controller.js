/* ============================================================
   controller.js — the character controller.

   ART_DIRECTION §4, to the letter:
     capsule, swept collision, slope limit 48 deg, step offset 0.35 m,
     coyote time 0.12 s, jump buffering 0.14 s, acceleration CURVES not
     linear lerps, snappy air control, landing squash.

   `position` is the FEET, not the capsule centre — that is what a rig
   and a camera both actually want. The capsule segment runs from
   position + (0, radius, 0) to position + (0, height - radius, 0).

   Motion is integrated at the fixed 60 Hz step owned by physics.js and
   swept in sub-steps no longer than radius * 0.5, so nothing tunnels
   even at terminal velocity. Depenetration is deepest-contact-first
   (the only scheme that behaves in an inside corner), then velocity is
   clipped against every touched plane and re-projected onto the crease
   if two walls still block it.

   FEEL NOTES (the part that matters)
   ----------------------------------
   * Acceleration is a curve of current speed: full authority from rest,
     tapering to 18% at top speed. A linear lerp toward a target speed
     has the opposite shape and reads as mush.
   * Pivoting gets a boost proportional to how hard you reversed, so a
     180 snaps instead of skating.
   * Gravity is asymmetric — 1.0x rising, 1.55x falling. Every platformer
     that feels good does this; nobody notices it and everybody feels it.
   * Releasing jump early cuts the rise. Holding gives full height.
   * `acceleration` is published, smoothed, for the ear and trunk chains
     to feed on. That link is what sells him as a physical object.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { clamp, damp } from '../core/contracts.js';
import { SquashSpring, Spring1 } from './springs.js';

const DEG = Math.PI / 180;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t0 = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _sp = new THREE.Vector3();

/* Footprint sample pattern, in (fore, side) units. Centre first — it is
   the authoritative one whenever it is valid. */
const FOOT = [[0, 0], [1, 0], [-0.6, 0], [0, 0.85], [0, -0.85]];

export const CONTROLLER_DEFAULTS = {
  /* --- shape --- */
  radius: 0.34,
  height: 1.62,           // total capsule height, feet to crown
  position: null,         // THREE.Vector3 | [x,y,z]

  /* --- ground movement --- */
  walkSpeed: 2.6,
  runSpeed: 6.4,
  accel: 46,              // peak ground acceleration, m/s^2
  decel: 34,              // ground deceleration with no input
  pivotBoost: 1.9,        // extra accel when reversing hard
  lateralGrip: 16,        // how fast sideways drift is killed
  accelExp: 1.35,         // shape of the acceleration curve
  accelFloor: 0.18,       // accel authority remaining at top speed

  /* --- air --- */
  airAccel: 26,
  airControl: 0.72,
  airDrag: 0.6,
  gravity: 24,            // magnitude, m/s^2 (rising)
  fallMultiplier: 1.55,   // asymmetric gravity
  maxFallSpeed: 45,

  /* --- jump --- */
  jumpHeight: 1.35,       // apex, metres, with gravity above
  coyoteTime: 0.12,       // ART_DIRECTION §4
  jumpBuffer: 0.14,       // ART_DIRECTION §4
  jumpCut: 0.42,          // vy multiplier when the button is released early
  jumpHorizontalBoost: 0.08,

  /* --- ground contact --- */
  slopeLimit: 48,         // degrees, ART_DIRECTION §4
  stepOffset: 0.35,       // metres, ART_DIRECTION §4
  snapDistance: 0.42,     // ground snap after cresting a rise
  slideAccel: 16,         // slide down over-steep ground
  skin: 0.004,

  /* --- turning --- */
  turnRate: 16,           // yaw damping lambda
  turnRateAir: 7,

  /* --- solver --- */
  maxIterations: 8,
  maxSubstep: 0.5,        // fraction of radius per sweep sub-step

  /* --- feel outputs --- */
  landRefSpeed: 13,       // fall speed that counts as a full-force landing
  strideLength: 1.55,     // metres per footstep event
  accelSmoothing: 22,     // lambda for the published acceleration

  /* --- integration --- */
  input: null,            // () => {x, z, jump, jumpHeld, run, crouch}
  water: true,            // emit ripples when wading
};

export class CharacterController {
  constructor(world, opts = {}) {
    const o = { ...CONTROLLER_DEFAULTS, ...opts };
    this.opts = o;
    this.world = world;

    this.radius = o.radius;
    this.height = Math.max(o.height, o.radius * 2 + 1e-3);

    this.position = new THREE.Vector3();       // INTERPOLATED — read this
    this.simPosition = new THREE.Vector3();    // exact end-of-step
    this._prevPosition = new THREE.Vector3();
    if (o.position) {
      const p = o.position;
      this.simPosition.set(p.x ?? p[0] ?? 0, p.y ?? p[1] ?? 0, p.z ?? p[2] ?? 0);
    }
    this.position.copy(this.simPosition);
    this._prevPosition.copy(this.simPosition);

    this.velocity = new THREE.Vector3();
    this.acceleration = new THREE.Vector3();   // smoothed, for the chains
    this._prevVelocity = new THREE.Vector3();

    /* --- ground state --- */
    this.grounded = false;
    this.wasGrounded = false;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.groundSlope = 0;                      // radians
    this.groundBody = 0;
    this.onSteepSlope = false;
    this.airTime = 0;
    this.groundTime = 0;

    /* --- wall state --- */
    this.touchingWall = false;
    this.wallNormal = new THREE.Vector3();

    /* --- input --- */
    this.input = { x: 0, z: 0, jump: false, jumpHeld: false, run: false, crouch: false };
    this._prevJump = false;
    this._inputFn = o.input;

    /* --- timers --- */
    this.coyoteT = 0;
    this.bufferT = 0;
    this.jumping = false;
    this.jumpTime = 0;
    /* While this is running, the ground probe reaches a full radius
       forward. It is set when we mount a step and it is what stops the
       snap from immediately pulling him back off it — see _support(). */
    this._stepGrace = 0;
    this._support0 = {
      hit: false, y: 0, normal: new THREE.Vector3(0, 1, 0), body: 0, centre: false,
    };

    /* --- orientation --- */
    this.yaw = 0;
    this.yawRate = 0;
    this._yawTarget = 0;

    /* --- feel --- */
    this.squash = new SquashSpring();
    this.landImpact = 0;                       // 0..1, decays
    this.lean = new Spring1({ value: 0, stiffness: 90, dampingRatio: 0.55 });
    this._stride = 0;
    this.enabled = true;

    /* --- water --- */
    this.waterLevelFn = null;
    this.waterDepth = 0;
    this.inWater = false;
    this._rippleT = 0;

    /* --- events --- */
    this._onLand = [];
    this._onJump = [];
    this._onStep = [];
    this._onWall = [];
    this._onRipple = [];

    this._contacts = [];
    this._planes = [];
    this._scratch = [];

    /* Snap onto whatever is under the spawn point (pass snapOnSpawn:false
       if you want him to drop in from height). */
    if (o.snapOnSpawn !== false) this.snapToGround();
  }

  /* ---------------- events ---------------- */
  onLand(fn) { this._onLand.push(fn); return () => this._onLand.splice(this._onLand.indexOf(fn), 1); }
  onJump(fn) { this._onJump.push(fn); return () => this._onJump.splice(this._onJump.indexOf(fn), 1); }
  onStep(fn) { this._onStep.push(fn); return () => this._onStep.splice(this._onStep.indexOf(fn), 1); }
  onWall(fn) { this._onWall.push(fn); return () => this._onWall.splice(this._onWall.indexOf(fn), 1); }
  onRipple(fn) { this._onRipple.push(fn); return () => this._onRipple.splice(this._onRipple.indexOf(fn), 1); }
  _emit(list, payload) { for (let i = 0; i < list.length; i++) list[i](payload); }

  /* ---------------- helpers ---------------- */
  /** Bottom sphere centre of the capsule (fresh vector, safe to keep). */
  get capsuleBottom() { return new THREE.Vector3(this.simPosition.x, this.simPosition.y + this.radius, this.simPosition.z); }
  /** Top sphere centre of the capsule (fresh vector, safe to keep). */
  get capsuleTop() { return new THREE.Vector3(this.simPosition.x, this.simPosition.y + this.height - this.radius, this.simPosition.z); }
  get speed() { return this.velocity.length(); }
  get planarSpeed() { return Math.hypot(this.velocity.x, this.velocity.z); }
  /** 0..1, how fast he is going relative to his run speed. Anim blend. */
  get gait() { return clamp(this.planarSpeed / this.opts.runSpeed, 0, 1); }
  get jumpSpeed() { return Math.sqrt(2 * this.opts.gravity * this.opts.jumpHeight); }
  get eyeHeight() { return this.simPosition.y + this.height * 0.86; }

  setInput(i) {
    if (!i) return this;
    this.input.x = i.x ?? 0;
    this.input.z = i.z ?? 0;
    this.input.jump = !!i.jump;
    this.input.jumpHeld = i.jumpHeld != null ? !!i.jumpHeld : !!i.jump;
    this.input.run = !!i.run;
    this.input.crouch = !!i.crouch;
    return this;
  }
  setInputFn(fn) { this._inputFn = fn; return this; }

  teleport(p) {
    this.simPosition.copy(p);
    this.position.copy(p);
    this._prevPosition.copy(p);
    this.velocity.set(0, 0, 0);
    this.acceleration.set(0, 0, 0);
    this.snapToGround();
    return this;
  }
  addImpulse(v) { this.velocity.add(v); this.grounded = false; this.coyoteT = 0; return this; }
  /** Launch him — pads, explosions, the tutorial catapult. */
  launch(v, cancelVertical = true) {
    if (cancelVertical) this.velocity.y = 0;
    this.velocity.add(v);
    this.grounded = false;
    this.coyoteT = 0;
    return this;
  }

  snapToGround(maxDrop = 4) {
    const g = this.world.groundAt(this.simPosition.x, this.simPosition.z, null,
      this.simPosition.y + this.height, maxDrop + this.height);
    if (g && g.hit && this.simPosition.y - g.y <= maxDrop) {
      this.simPosition.y = g.y;
      this.position.copy(this.simPosition);
      this._prevPosition.copy(this.simPosition);
      this.grounded = true;
      this.groundNormal.copy(g.normal);
      this.groundSlope = Math.acos(clamp(g.normal.y, -1, 1));
    }
    return this;
  }

  /* ---------------- the fixed step ---------------- */
  step(dt) {
    if (!this.enabled || dt <= 0) return;
    const o = this.opts;

    this._prevPosition.copy(this.simPosition);
    this._prevVelocity.copy(this.velocity);
    this.wasGrounded = this.grounded;

    if (this._inputFn) this.setInput(this._inputFn(dt, this));

    /* --- jump buffering: remember the press for 0.14 s --- */
    const jumpPressed = this.input.jump && !this._prevJump;
    if (jumpPressed) this.bufferT = o.jumpBuffer;
    else this.bufferT = Math.max(0, this.bufferT - dt);
    /* --- coyote time: 0.12 s of grace after walking off --- */
    if (this.grounded) this.coyoteT = o.coyoteTime;
    else this.coyoteT = Math.max(0, this.coyoteT - dt);
    this._stepGrace = Math.max(0, this._stepGrace - dt);

    this._horizontal(dt);
    this._vertical(dt);
    this._jump(dt);
    this._move(dt);
    this._ground(dt);
    this._post(dt);

    this._prevJump = this.input.jump;
  }

  /* ---- horizontal control, on the acceleration curve ---- */
  _horizontal(dt) {
    const o = this.opts;
    const v = this.velocity;
    let ix = this.input.x, iz = this.input.z;
    let mag = Math.hypot(ix, iz);
    if (mag > 1) { ix /= mag; iz /= mag; mag = 1; }

    const airborne = !this.grounded;
    const target = (this.input.run ? o.runSpeed : o.walkSpeed) * mag *
                   (this.input.crouch ? 0.45 : 1);

    /* Current planar velocity. */
    let vx = v.x, vz = v.z;
    const planar = Math.hypot(vx, vz);

    if (mag > 1e-4) {
      const dx = ix / mag, dz = iz / mag;
      const along = vx * dx + vz * dz;

      /* THE CURVE. Full authority from rest, `accelFloor` at top speed.
         (A linear lerp toward `target` has exactly the wrong shape.) */
      const t = clamp(along / Math.max(target, 1e-4), 0, 1);
      let a = (airborne ? o.airAccel : o.accel) *
              (o.accelFloor + (1 - o.accelFloor) * Math.pow(1 - t, o.accelExp));

      /* Pivot boost — proportional to how hard the stick opposes motion. */
      if (planar > 0.2) {
        const opp = clamp(-(vx * dx + vz * dz) / planar, 0, 1);
        a *= 1 + o.pivotBoost * opp * (airborne ? 0.35 : 1);
      }
      if (airborne) a *= o.airControl;

      vx += dx * a * dt;
      vz += dz * a * dt;

      /* Kill sideways drift so a turn tracks the stick instead of skating.
         Frame-rate independent — never a raw lerp. */
      const grip = 1 - Math.exp(-(airborne ? o.lateralGrip * 0.28 : o.lateralGrip) * dt);
      const na = vx * dx + vz * dz;
      const lx = vx - dx * na, lz = vz - dz * na;
      vx -= lx * grip; vz -= lz * grip;

      /* Clamp to the target only if we were not already faster (so a
         launch pad or a slope boost is preserved). */
      const sp = Math.hypot(vx, vz);
      if (sp > target && planar <= target + 1e-3) { vx *= target / sp; vz *= target / sp; }
      else if (sp > target && airborne === false) {
        /* bleed excess speed rather than clipping it — reads as momentum */
        const k = Math.exp(-2.4 * dt);
        const want = Math.max(target, sp * k);
        vx *= want / sp; vz *= want / sp;
      }

      this._yawTarget = Math.atan2(dx, dz);
    } else if (!airborne) {
      /* Deceleration: strong at speed, easing into a settle. */
      if (planar > 1e-4) {
        const d = o.decel * (0.5 + 0.5 * clamp(planar / o.runSpeed, 0, 1)) * dt;
        const s = Math.max(0, planar - d);
        vx *= s / planar; vz *= s / planar;
      }
    } else {
      const k = Math.exp(-o.airDrag * dt);
      vx *= k; vz *= k;
    }

    /* Over-steep ground: no purchase, slide down the fall line. */
    if (this.onSteepSlope) {
      const n = this.groundNormal;
      _t0.set(n.x, 0, n.z);
      const l = _t0.length();
      if (l > 1e-4) {
        _t0.divideScalar(l);
        const steep = clamp((this.groundSlope - o.slopeLimit * DEG) / (0.6), 0, 1);
        vx += _t0.x * o.slideAccel * steep * dt;
        vz += _t0.z * o.slideAccel * steep * dt;
      }
    }

    v.x = vx; v.z = vz;

    /* Yaw follows the move direction, critically damped, faster on ground. */
    const lam = this.grounded ? o.turnRate : o.turnRateAir;
    let d = this._yawTarget - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const nyaw = this.yaw + d * (1 - Math.exp(-lam * dt));
    this.yawRate = (nyaw - this.yaw) / dt;
    this.yaw = nyaw;

    /* Lean into the turn + into acceleration. Pure output for the rig. */
    this.lean.step(dt, clamp(this.yawRate * 0.06 * this.gait, -0.4, 0.4));
  }

  /* ---- gravity ---- */
  _vertical(dt) {
    const o = this.opts;
    if (this.grounded && !this.onSteepSlope) {
      /* Stay glued: cancel the normal component, keep tangential motion. */
      const n = this.groundNormal;
      const vn = this.velocity.dot(n);
      if (vn < 0) this.velocity.addScaledVector(n, -vn);
      /* Project onto the surface so running a slope tracks it exactly
         instead of stair-stepping through gravity + snap. */
      const vnn = this.velocity.dot(n);
      this.velocity.addScaledVector(n, -vnn);
      /* A little stick force so a downslope does not launch him. */
      this.velocity.y -= 1.2 * dt;
    } else {
      const g = o.gravity * (this.velocity.y < 0 ? o.fallMultiplier : 1);
      this.velocity.y -= g * dt;
      if (this.velocity.y < -o.maxFallSpeed) this.velocity.y = -o.maxFallSpeed;
    }

    /* Variable jump height: releasing early cuts the rise. */
    if (this.jumping && this.velocity.y > 0 && !this.input.jumpHeld) {
      this.velocity.y *= o.jumpCut;
      this.jumping = false;
    }
    if (this.velocity.y <= 0) this.jumping = false;
    if (!this.grounded) this.jumpTime += dt;
  }

  /* ---- jump: buffer + coyote ---- */
  _jump() {
    const o = this.opts;
    if (this.bufferT <= 0) return;
    if (!(this.grounded || this.coyoteT > 0) || this.onSteepSlope) return;

    this.velocity.y = this.jumpSpeed;
    /* A touch of forward carry so a running jump reads as committed. */
    if (o.jumpHorizontalBoost) {
      this.velocity.x *= 1 + o.jumpHorizontalBoost;
      this.velocity.z *= 1 + o.jumpHorizontalBoost;
    }
    this.grounded = false;
    this.jumping = true;
    this.jumpTime = 0;
    this.coyoteT = 0;
    this.bufferT = 0;
    this.airTime = 0;
    this.squash.jump(1);
    this._emit(this._onJump, { position: this.simPosition, speed: this.planarSpeed });
  }

  /* ---- sweep + depenetrate + slide ---- */
  _move(dt) {
    const o = this.opts;
    /* Ground is re-established from contacts every step; anything that
       survives here is a stale claim to be standing on something. */
    this.grounded = false;
    this.onSteepSlope = false;

    _dir.copy(this.velocity).multiplyScalar(dt);
    const dist = _dir.length();
    if (dist < 1e-9) { this._resolve(); return; }

    /* Sub-step so nothing ever moves more than half a radius per pass.
       This is what makes the sweep a sweep and not a hope. The step
       length is min(remaining travel, radius * maxSubstep) and the
       iteration cap is high enough that it cannot bind below ~9 km/s —
       a cap that bites is a cap that tunnels. */
    const maxStep = Math.min(this.radius * o.maxSubstep, this.radius);
    const steps = clamp(Math.ceil(dist / maxStep), 1, 512);
    const inv = 1 / steps;

    const startY = this.simPosition.y;
    const startX = this.simPosition.x, startZ = this.simPosition.z;
    const wantX = _dir.x, wantZ = _dir.z;

    this.touchingWall = false;
    for (let s = 0; s < steps; s++) {
      this.simPosition.addScaledVector(_dir, inv);
      this._resolve();
    }

    /* --- step offset: try again from a stair's height --- */
    const gotX = this.simPosition.x - startX, gotZ = this.simPosition.z - startZ;
    const wantLen = Math.hypot(wantX, wantZ);
    if (this.touchingWall && wantLen > 1e-4 && (this.wasGrounded || this.grounded)) {
      const progress = (gotX * wantX + gotZ * wantZ) / (wantLen * wantLen);
      if (progress < 0.62) {
        this._tryStep(startX, startY, startZ, wantX, wantZ, gotX, gotZ);
      }
    }
  }

  _tryStep(sx, sy, sz, wantX, wantZ, gotX, gotZ) {
    const o = this.opts;
    const saveVel = _t2.copy(this.velocity);
    const bx = this.simPosition.x, by = this.simPosition.y, bz = this.simPosition.z;
    const bestProgress = gotX * wantX + gotZ * wantZ;

    /* 1. lift by the step offset, 2. re-run the horizontal move,
       3. drop back down onto whatever is there. */
    this.simPosition.set(sx, sy + o.stepOffset + o.skin, sz);
    if (this._overlapping()) { this.simPosition.set(bx, by, bz); this.velocity.copy(saveVel); return; }

    const maxStep = this.radius * o.maxSubstep;
    const len = Math.hypot(wantX, wantZ);
    const steps = clamp(Math.ceil(len / maxStep), 1, 32);
    for (let s = 0; s < steps; s++) {
      this.simPosition.x += wantX / steps;
      this.simPosition.z += wantZ / steps;
      this._resolve(true);
    }

    /* Drop onto whatever the FOOTPRINT is over. The forward sample reaches
       a full radius so the toe finds the tread even though the axis is
       still short of the nosing — without that the capsule can never
       mount a riser at walking speed (0.04 m of travel per step). */
    const nx = this.simPosition.x - sx, nz = this.simPosition.z - sz;
    const newProgress = nx * wantX + nz * wantZ;
    const s = this._support(
      this.simPosition.x, this.simPosition.y, this.simPosition.z,
      o.stepOffset + o.skin * 4, wantX, wantZ,
      this.radius * 0.95, this.radius * 0.45,
    );

    /* Accept only if we both got further AND ended up genuinely higher —
       otherwise this is a wall, not a step, and the lift is a cheat. */
    if (s.hit && newProgress > bestProgress + 1e-4 && s.y > sy + 0.02) {
      this.simPosition.y = s.y;
      this._resolve();
      this.grounded = true;
      this.groundNormal.copy(s.normal);
      this.groundSlope = Math.acos(clamp(s.normal.y, -1, 1));
      this.onSteepSlope = false;
      this.groundBody = s.body;
      this._stepGrace = 0.25;
      this.velocity.x = saveVel.x; this.velocity.z = saveVel.z;
      this.velocity.y = Math.min(this.velocity.y, 0);
    } else {
      this.simPosition.set(bx, by, bz);
      this.velocity.copy(saveVel);
    }
  }

  /**
   * Highest WALKABLE support under the capsule's footprint.
   *
   * A single ray down the capsule axis is wrong the moment the capsule
   * straddles an edge — which is every stair nosing, every kerb and
   * every dock plank in this city. Five rays (centre, fore, aft, two
   * lateral) cost almost nothing and are the difference between a
   * controller that climbs a 0.35 m step and one that jams against it.
   *
   * Candidates are accepted only in the band
   *   [feetY - maxDrop, feetY + 0.02]
   * so an uphill sample can never lift him off a slope he is already
   * standing on: on a ramp the centre sample is the highest accepted one
   * and therefore wins, which is exactly the behaviour we want.
   *
   * @returns {hit, y, normal, body, centre}  (shared object)
   */
  _support(px, py, pz, maxDrop, dirX, dirZ, fore, side) {
    const cosLimit = Math.cos(this.opts.slopeLimit * DEG);
    const res = this._support0;
    res.hit = false; res.y = -Infinity; res.centre = false; res.body = 0;

    let ax = dirX, az = dirZ;
    const l = Math.hypot(ax, az);
    if (l > 1e-5) { ax /= l; az /= l; } else { ax = 1; az = 0; }
    const bx = -az, bz = ax;

    const top = py + this.radius;
    const maxDist = this.radius + maxDrop;
    const ceil = py + 0.02;
    const floor = py - maxDrop;

    for (let i = 0; i < FOOT.length; i++) {
      const f = FOOT[i][0] * fore, s = FOOT[i][1] * side;
      _sp.set(px + ax * f + bx * s, top, pz + az * f + bz * s);
      const h = this.world.raycast(_sp, _down, maxDist);
      if (!h) continue;
      if (h.normal.y < cosLimit) continue;
      if (h.point.y > ceil || h.point.y < floor) continue;
      if (h.point.y > res.y) {
        res.y = h.point.y;
        res.normal.copy(h.normal);
        res.body = h.body;
        res.centre = i === 0;
        res.hit = true;
      }
    }
    if (!res.hit) res.y = py;
    return res;
  }

  _overlapping() {
    const a = _a.set(this.simPosition.x, this.simPosition.y + this.radius, this.simPosition.z);
    const b = _b.set(this.simPosition.x, this.simPosition.y + this.height - this.radius, this.simPosition.z);
    this.world.capsuleContacts(a, b, this.radius, this._contacts, this._scratch);
    return this._contacts.length > 0;
  }

  /**
   * Push out of everything, deepest first, then clip velocity against
   * every plane we touched (and onto the crease if two still block).
   */
  _resolve(skipGround = false) {
    const o = this.opts;
    const cosLimit = Math.cos(o.slopeLimit * DEG);
    const planes = this._planes;
    planes.length = 0;

    let foundGround = false;
    let bestGroundY = -Infinity;
    _n.set(0, 1, 0);
    let groundBody = 0;

    for (let iter = 0; iter < o.maxIterations; iter++) {
      const a = _a.set(this.simPosition.x, this.simPosition.y + this.radius, this.simPosition.z);
      const b = _b.set(this.simPosition.x, this.simPosition.y + this.height - this.radius, this.simPosition.z);
      const cs = this.world.capsuleContacts(a, b, this.radius, this._contacts, this._scratch);
      if (cs.length === 0) break;

      let deepest = cs[0];
      for (let i = 1; i < cs.length; i++) if (cs[i].depth > deepest.depth) deepest = cs[i];

      for (let i = 0; i < cs.length; i++) {
        const c = cs[i];
        if (c.normal.y >= cosLimit) {
          if (!skipGround && c.normal.y > bestGroundY) {
            bestGroundY = c.normal.y; _n.copy(c.normal); foundGround = true; groundBody = c.body;
          }
        } else if (c.normal.y > -0.2) {
          this.touchingWall = true;
          this.wallNormal.copy(c.normal);
        }
        if (planes.length < 6) {
          let dup = false;
          for (let p = 0; p < planes.length; p++) if (planes[p].dot(c.normal) > 0.995) { dup = true; break; }
          if (!dup) planes.push(c.normal.clone());
        }
      }

      this.simPosition.addScaledVector(deepest.normal, deepest.depth + o.skin);
      if (deepest.depth < o.skin) break;
    }

    /* Velocity clipping. Quake's algorithm — the reason walls feel like
       walls and corners do not eat your speed entirely. */
    if (planes.length) {
      const v = this.velocity;
      for (let round = 0; round < 3; round++) {
        let blocked = false;
        for (let i = 0; i < planes.length; i++) {
          const p = planes[i];
          const into = v.dot(p);
          if (into < -1e-5) {
            v.addScaledVector(p, -into);
            blocked = true;
            /* If we now push into another plane, ride their crease. */
            for (let j = 0; j < planes.length; j++) {
              if (j === i) continue;
              if (v.dot(planes[j]) < -1e-5) {
                _t0.crossVectors(p, planes[j]);
                const l = _t0.length();
                if (l > 1e-5) {
                  _t0.divideScalar(l);
                  /* Project v onto the crease. Take the dot BEFORE the
                     copy — reading it after would be dotting the crease
                     with itself and would hand the body a phantom 1 m/s
                     along every corner it touches. That is what walked a
                     stopped capsule sideways off the end of a wall. */
                  const alongCrease = _t0.dot(v);
                  v.copy(_t0).multiplyScalar(alongCrease);
                }
              }
            }
          }
        }
        if (!blocked) break;
      }
    }

    if (!skipGround) {
      if (foundGround) {
        this.grounded = true;
        this.groundNormal.copy(_n);
        this.groundSlope = Math.acos(clamp(_n.y, -1, 1));
        this.onSteepSlope = false;
        this.groundBody = groundBody;
      }
    }
  }

  /* ---- ground probe + snap ---- */
  _ground(dt) {
    const o = this.opts;
    const cosLimit = Math.cos(o.slopeLimit * DEG);

    if (!this.grounded && this.velocity.y <= 0.2) {
      /* Probe under the footprint. Catches the frame a contact is lost —
         cresting a rise, walking down stairs, riding a step we just
         mounted (that is what the grace window widens the reach for). */
      const fore = this._stepGrace > 0 ? this.radius : this.radius * 0.45;
      const s = this._support(
        this.simPosition.x, this.simPosition.y, this.simPosition.z,
        o.snapDistance, this.velocity.x, this.velocity.z, fore, this.radius * 0.45,
      );
      if (s.hit) {
        const gap = this.simPosition.y - s.y;
        /* Snap only if we were on the ground last step. Never yank
           someone out of a jump. */
        if (gap <= 0.02 || (this.wasGrounded && !this.jumping && gap <= o.snapDistance)) {
          this.simPosition.y = s.y;
          this.velocity.y = 0;
          this.grounded = true;
          this.groundNormal.copy(s.normal);
          this.groundSlope = Math.acos(clamp(s.normal.y, -1, 1));
          this.onSteepSlope = false;
          this.groundBody = s.body;
          /* Still riding the toe over a nosing — keep the wide reach. */
          if (!s.centre) this._stepGrace = Math.max(this._stepGrace, 0.15);
        }
      } else {
        /* Nothing walkable underfoot, but we may be leaning on an
           over-steep face: touching, yet not standing. */
        _a.set(this.simPosition.x, this.simPosition.y + this.radius, this.simPosition.z);
        const probe = this.world.raycast(_a, _down, this.radius + 0.02);
        if (probe && probe.normal.y < cosLimit) {
          this.grounded = true;
          this.onSteepSlope = true;
          this.groundNormal.copy(probe.normal);
          this.groundSlope = Math.acos(clamp(probe.normal.y, -1, 1));
        }
      }
    }

    /* Losing ground: we did not find a contact and we did not snap. */
    if (this.grounded && !this.onSteepSlope) {
      this.airTime = 0;
      this.groundTime += dt;
    } else {
      this.groundTime = 0;
      this.airTime += dt;
      if (!this.grounded) this.coyoteT = Math.max(0, this.coyoteT);
    }

    /* Landing. */
    if (this.grounded && !this.wasGrounded && !this.onSteepSlope) {
      const impactSpeed = -this._prevVelocity.y;
      const impact = clamp((impactSpeed - 1.5) / this.opts.landRefSpeed, 0, 1);
      this.landImpact = impact;
      this.squash.land(impact);
      this.jumping = false;
      this._emit(this._onLand, {
        position: this.simPosition, impact, speed: impactSpeed,
        normal: this.groundNormal, body: this.groundBody,
      });
    }
  }

  /* ---- outputs the rest of the game reads ---- */
  _post(dt) {
    /* Published acceleration — smoothed, because raw dv/dt at 60 Hz is a
       staircase and the ear chains would twitch on it. */
    _t0.copy(this.velocity).sub(this._prevVelocity).divideScalar(dt);
    const l = 1 - Math.exp(-this.opts.accelSmoothing * dt);
    this.acceleration.lerp(_t0, l);

    this.squash.step(dt);
    this.landImpact = damp(this.landImpact, 0, 6, dt);

    /* Footsteps for audio + dust. */
    if (this.grounded && !this.onSteepSlope) {
      this._stride += this.planarSpeed * dt;
      if (this._stride >= this.opts.strideLength) {
        this._stride -= this.opts.strideLength;
        this._emit(this._onStep, {
          position: this.simPosition, speed: this.planarSpeed,
          normal: this.groundNormal, body: this.groundBody,
          running: this.planarSpeed > this.opts.walkSpeed * 1.2,
        });
      }
    } else this._stride = this.opts.strideLength * 0.5;

    /* Water. */
    if (this.opts.water && this.waterLevelFn) {
      const wy = this.waterLevelFn(this.simPosition.x, this.simPosition.z);
      const depth = wy - this.simPosition.y;
      const was = this.inWater;
      this.waterDepth = Math.max(0, depth);
      this.inWater = depth > 0.02;
      if (this.inWater) {
        /* Wading drag scales with how deep he is. */
        const f = clamp(depth / (this.height * 0.7), 0, 1);
        const k = Math.exp(-3.2 * f * dt);
        this.velocity.x *= k; this.velocity.z *= k;
        this._rippleT -= dt;
        const moving = this.planarSpeed > 0.35;
        if (this._rippleT <= 0 && (moving || !was)) {
          this._rippleT = moving ? 0.22 : 0.9;
          this._emit(this._onRipple, {
            x: this.simPosition.x, z: this.simPosition.z, y: wy,
            radius: 0.35 + f * 0.5,
            strength: clamp(0.3 + this.planarSpeed * 0.12 + (was ? 0 : this.landImpact), 0, 1),
            entering: !was,
          });
        }
      }
    }

    if (!Number.isFinite(this.simPosition.x + this.simPosition.y + this.simPosition.z)) {
      console.warn('[phys] controller went non-finite; resetting');
      this.simPosition.copy(this._prevPosition);
      this.velocity.set(0, 0, 0);
    }
  }

  /** Called by physics.js with the accumulator remainder. */
  interpolate(alpha) {
    this.position.lerpVectors(this._prevPosition, this.simPosition, alpha);
    return this.position;
  }

  dispose() {
    this.enabled = false;
    this._onLand.length = this._onJump.length = this._onStep.length = 0;
    this._onWall.length = this._onRipple.length = 0;
  }
}

export function createController(world, opts) { return new CharacterController(world, opts); }
export default CharacterController;
