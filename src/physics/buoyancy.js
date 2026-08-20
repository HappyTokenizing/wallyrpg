/* ============================================================
   buoyancy.js — floating bodies and water displacement.

   ART_DIRECTION §4: "Water: buoyancy + drag for floating objects; Wally
   displaces water with a ring ripple and leaves a wake."
   ART_DIRECTION §5.4: "a hard white foam ring around every object
   touching it" — this file is what tells water.js where those rings go.

   Submerged volume is approximated analytically per shape:

     sphere  exact spherical-cap volume  V = pi*h^2*(3r - h)/3
     box     axis-aligned slab clip, tilt-corrected by the body's up
     capsule cylinder slab + two caps

   That is enough fidelity for a crate bobbing in a harbour and it costs
   a couple of multiplies. Forces are buoyancy (rho * g * Vsub, up),
   quadratic drag scaled by the submerged fraction, and a wave-slope
   righting torque so a boat leans with the swell instead of standing
   dead flat.

   RIPPLES: a body crossing the surface fires `onSplash` once, and while
   it sits in the surface it fires `onRipple` on an interval scaled by
   its speed. physics.js re-broadcasts both on ctx.bus as
   'water:splash' and 'water:ripple' so water.js can spawn foam rings
   without ever importing this file.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { clamp, damp } from '../core/contracts.js';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();

export const RHO_WATER = 1000;    // kg/m^3

export const BUOY_DEFAULTS = {
  object3D: null,             // driven every step if given
  position: null,
  shape: 'sphere',            // 'sphere' | 'box' | 'capsule'
  radius: 0.4,
  size: null,                 // THREE.Vector3 for 'box'
  halfHeight: 0.3,            // for 'capsule'
  density: 420,               // kg/m^3 — wood floats at ~0.4 of water
  mass: null,                 // derived from density*volume if null
  gravity: 20,
  linearDrag: 2.4,            // quadratic, scaled by submerged fraction
  airDrag: 0.05,
  angularDrag: 3.0,
  righting: 5.5,              // how hard it wants to sit level with the wave
  waveFollow: 0.35,           // how much it drifts with the wind-driven surface
  restitution: 0.0,
  waterLevel: null,           // number | (x,z) => y ; falls back to the world's
  splashSpeed: 1.6,           // |vy| that counts as a splash on entry
  rippleInterval: 0.34,
  minRippleSpeed: 0.25,
  sleepAfter: 2.5,            // seconds of near-stillness before we idle it
  onSplash: null, onRipple: null, onEnter: null, onExit: null,
};

export class BuoyantBody {
  constructor(opts = {}) {
    const o = { ...BUOY_DEFAULTS, ...opts };
    this.opts = o;
    this.enabled = opts.enabled !== false;
    this.auto = opts.auto !== false;

    this.object3D = o.object3D ?? null;
    this.position = new THREE.Vector3();
    if (o.position) this.position.copy(o.position);
    else if (this.object3D) this.object3D.getWorldPosition(this.position);
    this.prevPosition = this.position.clone();
    this.renderPosition = this.position.clone();

    this.velocity = new THREE.Vector3();
    this.angularVelocity = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    if (this.object3D) this.quaternion.copy(this.object3D.quaternion);
    this.renderQuaternion = this.quaternion.clone();
    this.prevQuaternion = this.quaternion.clone();

    this.shape = o.shape;
    this.radius = o.radius;
    this.size = o.size ? o.size.clone() : new THREE.Vector3(0.6, 0.6, 0.6);
    this.halfHeight = o.halfHeight;

    this.volume = this._volume();
    this.mass = o.mass ?? Math.max(o.density * this.volume, 0.05);

    this.submerged = 0;         // 0..1 fraction of volume under water
    this.inWater = false;
    this.waterY = 0;
    this.sleeping = false;
    this._still = 0;
    this._rippleT = 0;
    this._wasIn = false;

    this.waterLevelFn = null;   // injected by physics.js
    this.windSampler = null;    // injected by physics.js
    this._onSplash = o.onSplash ? [o.onSplash] : [];
    this._onRipple = o.onRipple ? [o.onRipple] : [];
    this._onEnter = o.onEnter ? [o.onEnter] : [];
    this._onExit = o.onExit ? [o.onExit] : [];
  }

  onSplash(fn) { this._onSplash.push(fn); return this; }
  onRipple(fn) { this._onRipple.push(fn); return this; }
  onEnter(fn) { this._onEnter.push(fn); return this; }
  onExit(fn) { this._onExit.push(fn); return this; }
  _emit(l, p) { for (let i = 0; i < l.length; i++) l[i](p); }

  _volume() {
    switch (this.shape) {
      case 'box': return this.size.x * this.size.y * this.size.z;
      case 'capsule': return Math.PI * this.radius * this.radius * (2 * this.halfHeight) +
                             (4 / 3) * Math.PI * this.radius ** 3;
      default: return (4 / 3) * Math.PI * this.radius ** 3;
    }
  }

  /** Half-extent along Y of the body in its CURRENT orientation. */
  _halfY() {
    switch (this.shape) {
      case 'box': {
        /* Project the oriented box onto Y — this is what makes a tilted
           crate sit deeper than a level one. */
        _v0.set(this.size.x * 0.5, 0, 0).applyQuaternion(this.quaternion);
        _v1.set(0, this.size.y * 0.5, 0).applyQuaternion(this.quaternion);
        const e = Math.abs(_v0.y) + Math.abs(_v1.y);
        _v0.set(0, 0, this.size.z * 0.5).applyQuaternion(this.quaternion);
        return e + Math.abs(_v0.y);
      }
      case 'capsule': {
        _v0.set(0, this.halfHeight, 0).applyQuaternion(this.quaternion);
        return Math.abs(_v0.y) + this.radius;
      }
      default: return this.radius;
    }
  }

  /** Fraction of the body's volume below `waterY`. */
  _submergedFraction(waterY) {
    const cy = this.position.y;
    if (this.shape === 'sphere') {
      const r = this.radius;
      const h = clamp(waterY - (cy - r), 0, 2 * r);
      if (h <= 0) return 0;
      if (h >= 2 * r) return 1;
      const cap = Math.PI * h * h * (3 * r - h) / 3;
      return clamp(cap / this.volume, 0, 1);
    }
    /* Box / capsule: linear slab through the oriented half-height. A
       cheap, monotonic, stable approximation — and the visual difference
       against a true polyhedral clip is nil at our object scale. */
    const hy = this._halfY();
    const h = clamp(waterY - (cy - hy), 0, 2 * hy);
    if (h <= 0) return 0;
    if (this.shape === 'capsule') {
      /* Smootherstep the ends so a capsule does not pop as it rolls. */
      const t = h / (2 * hy);
      return clamp(t * t * (3 - 2 * t), 0, 1);
    }
    return clamp(h / (2 * hy), 0, 1);
  }

  step(dt) {
    if (!this.enabled || dt <= 0) return this;
    const o = this.opts;
    this.prevPosition.copy(this.position);
    this.prevQuaternion.copy(this.quaternion);

    /* --- where is the surface here --- */
    let wy;
    if (typeof o.waterLevel === 'function') wy = o.waterLevel(this.position.x, this.position.z);
    else if (typeof o.waterLevel === 'number') wy = o.waterLevel;
    else if (this.waterLevelFn) wy = this.waterLevelFn(this.position.x, this.position.z);
    else wy = -Infinity;
    this.waterY = wy;

    const sub = Number.isFinite(wy) ? this._submergedFraction(wy) : 0;
    const wasSub = this.submerged;
    this.submerged = sub;
    const nowIn = sub > 0.001;

    /* --- forces --- */
    _v0.set(0, -o.gravity * this.mass, 0);

    if (nowIn) {
      /* Archimedes: F = rho_water * g * V_submerged, straight up.
         Against weight = mass * g this gives the familiar ratio
         rho_water / density — 2.4x for wood, so a crate bobs high. */
      _v0.y += RHO_WATER * o.gravity * this.volume * sub;

      /* Quadratic drag, submerged-scaled. Water is thick. */
      const sp = this.velocity.length();
      if (sp > 1e-5) {
        /* Quadratic in speed, but the coefficient is capped so an object
           dropped from a great height cannot produce k*dt > 1 and invert
           its own velocity — explicit drag is only stable below that. */
        const k = Math.min(o.linearDrag * sub * (0.55 + sp), 0.5 / Math.max(dt, 1e-4));
        _v0.addScaledVector(this.velocity, -k * this.mass);
      }
      /* Surface drift from the same wind field the waves are drawn with. */
      if (this.windSampler && o.waveFollow) {
        const w = this.windSampler(this.position.x, this.position.z, 0);
        _v0.x += w.x * o.waveFollow * this.mass * 2.2 * sub;
        _v0.z += w.z * o.waveFollow * this.mass * 2.2 * sub;
      }
    } else {
      _v0.addScaledVector(this.velocity, -o.airDrag * this.mass);
    }

    this.velocity.addScaledVector(_v0, dt / this.mass);
    this.position.addScaledVector(this.velocity, dt);

    /* --- righting: sit level with the local surface --- */
    if (nowIn && o.righting > 0) {
      /* Approximate the wave normal from two nearby samples. */
      let nx = 0, nz = 0;
      if (typeof o.waterLevel === 'function' || this.waterLevelFn) {
        const f = typeof o.waterLevel === 'function' ? o.waterLevel : this.waterLevelFn;
        const e = 0.35;
        nx = (f(this.position.x - e, this.position.z) - f(this.position.x + e, this.position.z)) / (2 * e);
        nz = (f(this.position.x, this.position.z - e) - f(this.position.x, this.position.z + e)) / (2 * e);
      }
      _v1.set(nx, 1, nz).normalize();
      _q.setFromUnitVectors(_up, _v1);
      const lam = 1 - Math.exp(-o.righting * sub * dt);
      this.quaternion.slerp(_q, lam);
    }
    /* Spin decays. */
    if (this.angularVelocity.lengthSq() > 1e-10) {
      _q.setFromAxisAngle(
        _v1.copy(this.angularVelocity).normalize(),
        this.angularVelocity.length() * dt,
      );
      this.quaternion.premultiply(_q);
      this.angularVelocity.multiplyScalar(Math.exp(-o.angularDrag * (0.3 + sub) * dt));
    }

    /* --- events --- */
    if (nowIn && !this._wasIn) {
      const impact = Math.abs(this.velocity.y);
      this._emit(this._onEnter, { body: this, position: this.position, speed: impact });
      if (impact > o.splashSpeed) {
        this._emit(this._onSplash, {
          x: this.position.x, z: this.position.z, y: wy,
          radius: this._halfY() * 1.6 + 0.2,
          strength: clamp(impact / 8, 0.15, 1),
          body: this,
        });
      }
    } else if (!nowIn && this._wasIn) {
      this._emit(this._onExit, { body: this, position: this.position });
    }
    this._wasIn = nowIn;
    this.inWater = nowIn;

    if (nowIn && sub < 0.999) {
      this._rippleT -= dt;
      const sp = Math.hypot(this.velocity.x, this.velocity.z);
      const bob = Math.abs(sub - wasSub) / Math.max(dt, 1e-4);
      if (this._rippleT <= 0 && (sp > o.minRippleSpeed || bob > 0.4)) {
        this._rippleT = o.rippleInterval / clamp(0.5 + sp * 0.35, 0.5, 3);
        this._emit(this._onRipple, {
          x: this.position.x, z: this.position.z, y: wy,
          radius: this._halfY() * 1.35 + 0.15,
          strength: clamp(0.22 + sp * 0.14 + bob * 0.2, 0, 1),
          body: this,
        });
      }
    }

    /* --- sleep --- */
    const still = this.velocity.lengthSq() < 4e-4 && Math.abs(sub - wasSub) < 1e-3;
    this._still = still ? this._still + dt : 0;
    this.sleeping = this._still > o.sleepAfter;

    if (!Number.isFinite(this.position.x + this.position.y + this.position.z)) {
      this.position.copy(this.prevPosition);
      this.velocity.set(0, 0, 0);
    }
    return this;
  }

  interpolate(alpha) {
    this.renderPosition.lerpVectors(this.prevPosition, this.position, alpha);
    this.renderQuaternion.copy(this.prevQuaternion).slerp(this.quaternion, alpha);
    if (this.object3D) {
      this.object3D.position.copy(this.renderPosition);
      this.object3D.quaternion.copy(this.renderQuaternion);
    }
    return this.renderPosition;
  }

  addImpulse(v) { this.velocity.addScaledVector(v, 1 / this.mass); this._still = 0; this.sleeping = false; return this; }
  addTorqueImpulse(v) { this.angularVelocity.addScaledVector(v, 1 / this.mass); this.sleeping = false; return this; }
  teleport(p) { this.position.copy(p); this.prevPosition.copy(p); this.velocity.set(0, 0, 0); return this; }
  dispose() { this.enabled = false; this.object3D = null; }
}

export function createBuoy(opts) { return new BuoyantBody(opts); }
export default BuoyantBody;
