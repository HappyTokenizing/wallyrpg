/* ============================================================
   expression.js — face and pose accents.

   Wally has no eyes (§1.5, and §7 forbids ever giving him any) and no
   mouth. Everything an audience would normally read off a face has to be
   carried by four things:

     the tilt of the head        attention, doubt, warmth
     the set of the ears         perked forward = alert, laid back = tired
     the curl of the trunk       the single most expressive part of him
     the angle of the glasses    a two-degree nudge on the brow bone reads
                                 as a raised eyebrow, and it is free,
                                 because the frame is parented to `brow`
                                 and `brow` carries no skin

   This module produces an ADDITIVE pose layer plus a set of scalar hints
   that secondary.js feeds into the spring chains. It never fights the
   clip layer; it rides on top of it.

   Look-at lives here too, because "where he is looking" without eyes is
   entirely a matter of head and chest aim, and it has to be clamped and
   damped or it reads as a turret.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { makePose } from './anim.js';
import { BONE_INDEX } from './rig.js';
import { clamp, damp, smoothstep } from '../core/contracts.js';

const D2R = Math.PI / 180;

/* ------------------------------------------------------------------
   Presets. Angles in degrees, curls in radians-per-trunk-segment.
   ------------------------------------------------------------------ */
export const EXPRESSIONS = {
  neutral:   { head: [0, 0, 0],     brow: [0, 0, 0],    jaw: 0,   ear: 0,     spread: 0,    curl: 0,     side: 0,    tip: 0,    breath: 1.0 },
  happy:     { head: [-4, 0, 0],    brow: [-2.5, 0, 0], jaw: 3,   ear: -0.11, spread: 0.09, curl: -0.10, side: 0,    tip: -0.22, breath: 1.15 },
  proud:     { head: [-7, 0, 0],    brow: [-3, 0, 0],   jaw: 1,   ear: -0.14, spread: 0.11, curl: -0.16, side: 0,    tip: -0.30, breath: 1.2 },
  /* cool matches ref/wally-ref-cool.png: trunk hangs on the sculpt, only
     the TIP curls up-and-forward (negative tip = lift). The old
     -0.44/-0.58 whole-tube sweep was authored against the orbiting chain
     and never rendered as intended. */
  /* ROUND 3: head yaw 6 -> 2. The expression STACKS on the cool clip's
     own 5 degrees; the combined 11 squashed the viewer-left lens to a
     sliver in the studio three-quarter and read as glasses asymmetry. */
  cool:      { head: [-1, 2, -1],   brow: [1, 0, -1], jaw: 1, ear: -0.06, spread: 0.05, curl: -0.03, side: -0.30, tip: -0.80, breath: 0.9 },
  curious:   { head: [-2, 0, 9],    brow: [-2, 0, 2],   jaw: 2,   ear: -0.15, spread: 0.12, curl: -0.06, side: 0.10, tip: -0.14, breath: 1.0 },
  thinking:  { head: [4, -8, 6],    brow: [2, 0, 1],    jaw: 1.5, ear: 0.04,  spread: -0.03, curl: 0.10, side: -0.12, tip: 0.10, breath: 0.8 },
  listening: { head: [-1, 0, 4],    brow: [-1.5, 0, 0], jaw: 0.5, ear: -0.17, spread: 0.14, curl: 0.02,  side: 0.04, tip: -0.06, breath: 0.95 },
  surprised: { head: [-9, 0, 0],    brow: [-5, 0, 0],   jaw: 9,   ear: -0.22, spread: 0.17, curl: -0.20, side: 0,    tip: -0.34, breath: 1.4 },
  sad:       { head: [11, 0, -3],   brow: [3, 0, 0],    jaw: 1,   ear: 0.15,  spread: -0.08, curl: 0.16, side: -0.05, tip: 0.16, breath: 0.7 },
  tired:     { head: [13, 0, 0],    brow: [3.5, 0, 0],  jaw: 4,   ear: 0.19,  spread: -0.10, curl: 0.20, side: 0,    tip: 0.22, breath: 0.6 },
  angry:     { head: [6, 0, 0],     brow: [4, 0, 0],    jaw: 3,   ear: 0.10,  spread: -0.12, curl: -0.24, side: 0.06, tip: 0.30, breath: 1.35 },
  talking:   { head: [-2, 0, 0],    brow: [-1, 0, 0],   jaw: 4,   ear: -0.09, spread: 0.06, curl: -0.04, side: 0.05, tip: -0.10, breath: 1.1 },
};

export const EXPRESSION_NAMES = Object.keys(EXPRESSIONS);

const KEYS = ['jaw', 'ear', 'spread', 'curl', 'side', 'tip', 'breath'];

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _tmp = new THREE.Vector3();

export class Expression {
  constructor() {
    this.pose = makePose();
    this.name = 'neutral';
    /* live, damped state — every field is interpolated, nothing snaps */
    this.cur = { head: [0, 0, 0], brow: [0, 0, 0] };
    for (const k of KEYS) this.cur[k] = EXPRESSIONS.neutral[k];
    this.target = EXPRESSIONS.neutral;
    this.rate = 4.0;

    /* look-at */
    this.lookTarget = null;
    this.lookWeight = 0;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this._yawT = 0;
    this._pitchT = 0;

    /* a slow idle wander so he is never dead still */
    this.wander = 0;
    this._t = 0;
  }

  /** Crossfade to a named expression. */
  set(name, opts = {}) {
    const e = EXPRESSIONS[name];
    if (!e) { console.warn(`[wally] no expression "${name}"`); return this; }
    this.name = name;
    this.target = e;
    this.rate = 1 / Math.max(opts.fade ?? 0.35, 0.02);
    if (opts.instant) {
      this.cur.head = e.head.slice();
      this.cur.brow = e.brow.slice();
      for (const k of KEYS) this.cur[k] = e[k];
    }
    return this;
  }

  /**
   * Aim the head. Accepts a Vector3, an Object3D, or null to release.
   * Weight ramps so releasing a look does not snap the head straight.
   */
  look(target, weight = 1) {
    this.lookTarget = target || null;
    this._lookW = target ? clamp(weight, 0, 1) : 0;
    return this;
  }

  /**
   * @param {number} dt
   * @param {THREE.Object3D} headBone  world transform to aim from
   * @param {number} rootYaw           the model's yaw, so look is relative
   */
  update(dt, headBone, rootYaw) {
    /* guard against a negative frame dt — damp() amplifies instead of
       decaying, and these fields persist (see secondary.js) */
    if (!(dt > 0)) dt = 1e-4;
    else if (dt > 0.05) dt = 0.05;
    this._t += dt;
    const t = this.target;

    for (let i = 0; i < 3; i++) {
      this.cur.head[i] = damp(this.cur.head[i], t.head[i], this.rate, dt);
      this.cur.brow[i] = damp(this.cur.brow[i], t.brow[i], this.rate, dt);
    }
    for (const k of KEYS) this.cur[k] = damp(this.cur[k], t[k], this.rate, dt);

    /* ---- look-at ---- */
    let wantYaw = 0, wantPitch = 0;
    if (this.lookTarget && headBone) {
      if (this.lookTarget.isVector3) _v.copy(this.lookTarget);
      else if (this.lookTarget.isObject3D) this.lookTarget.getWorldPosition(_v);
      else if (typeof this.lookTarget.x === 'number') _v.set(this.lookTarget.x, this.lookTarget.y, this.lookTarget.z);
      else _v.set(0, 1.4, 1);

      headBone.getWorldPosition(_tmp);
      _v.sub(_tmp);
      const len = _v.length();
      if (len > 1e-3) {
        _v.divideScalar(len);
        /* express in the model's frame (yaw only — pitch of the body is
           carried by the clip and must not double-count) */
        const cy = Math.cos(-rootYaw), sy = Math.sin(-rootYaw);
        const lx = _v.x * cy - _v.z * sy;
        const lz = _v.x * sy + _v.z * cy;
        wantYaw = clamp(Math.atan2(lx, lz), -0.95, 0.95);
        wantPitch = clamp(-Math.asin(clamp(_v.y, -1, 1)), -0.42, 0.55);
      }
    }
    const lw = this._lookW ?? 0;
    this.lookWeight = damp(this.lookWeight, lw, 3.2, dt);
    this._yawT = damp(this._yawT, wantYaw, 6.5, dt);
    this._pitchT = damp(this._pitchT, wantPitch, 6.5, dt);
    this.lookYaw = this._yawT * this.lookWeight;
    this.lookPitch = this._pitchT * this.lookWeight;

    /* ---- write the additive pose ---- */
    const p = this.pose;
    p.e.fill(0); p.t.fill(0);
    const set = (bone, x, y, z) => {
      const i = BONE_INDEX[bone];
      if (i === undefined) return;
      p.e[i * 3] += x; p.e[i * 3 + 1] += y; p.e[i * 3 + 2] += z;
    };

    /* head split 70/30 with the chest so a big look turns the shoulders */
    set('head', this.cur.head[0] * D2R + this.lookPitch * 0.72,
      this.cur.head[1] * D2R + this.lookYaw * 0.68,
      this.cur.head[2] * D2R);
    set('chest', this.lookPitch * 0.20, this.lookYaw * 0.24, 0);
    set('spine', this.lookPitch * 0.08, this.lookYaw * 0.10, 0);
    set('brow', this.cur.brow[0] * D2R, this.cur.brow[1] * D2R, this.cur.brow[2] * D2R);
    set('jaw', this.cur.jaw * D2R, 0, 0);

    return p;
  }

  /* Hints consumed by secondary.js. */
  get earPerk() { return this.cur.ear; }
  get earSpread() { return this.cur.spread; }
  get trunkCurl() { return this.cur.curl; }
  get trunkSide() { return this.cur.side; }
  get trunkTip() { return this.cur.tip; }
  get breathScale() { return this.cur.breath; }
}

export default { Expression, EXPRESSIONS, EXPRESSION_NAMES };
