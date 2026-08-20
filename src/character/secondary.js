/* ============================================================
   secondary.js — ears, trunk, tail, belly, squash and foot IK.

   ART_DIRECTION §4 calls ear physics "the most visible piece of polish in
   the game", and it is right: a player reads a character as alive or as a
   puppet within about a second, and what they are reading is whether the
   soft parts lag the hard parts.

   Everything here rides on ctx.phys.createChain(), which is already
   tuned — the 'ear' preset is under-damped (zeta 0.36) precisely so the
   flap overshoots and settles instead of easing politely into place. This
   file's job is to feed those chains the right *intent*:

     rest direction   where the ear hangs for this pose
     curl             how far the trunk is rolled up, per segment
     stiffness        a curled trunk has to be stiffer or gravity unrolls it
     impulses         landings, gusts, hard turns

   WHAT IS NOT A SPRING
     belly    a light 3 cm soft-body offset on a dedicated bone, so the
              gut lags the hips without the whole torso wobbling
     squash   read straight off the controller's SquashSpring (8% takeoff,
              14% landing, volume preserving) and applied to the model
              root, whose origin is at the soles — so a squash never lifts
              him off the floor
     foot IK  two-bone analytic IK per leg onto ctx.phys.groundAt(), with
              the hips dropping to whichever foot needs the most reach

   ORDERING. ctx.phys steps bone-driven chains in ITS lateUpdate, which
   runs before ours (see the stage order in main.js). So: we set targets in
   update(), phys solves and writes bone quaternions, and we do the tip
   accents and the foot IK afterwards in lateUpdate().
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { PROP, BONE_INDEX, bindWorld } from './rig.js';
import { clamp, damp } from '../core/contracts.js';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _p3 = new THREE.Vector3();
const _p4 = new THREE.Vector3();
const _p5 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();

/** Rotate `v` about a unit `axis` by `ang`, into `out`. */
function rotAxis(v, axis, ang, out) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const d = v.dot(axis);
  out.set(
    v.x * c + (axis.y * v.z - axis.z * v.y) * s + axis.x * d * (1 - c),
    v.y * c + (axis.z * v.x - axis.x * v.z) * s + axis.y * d * (1 - c),
    v.z * c + (axis.x * v.y - axis.y * v.x) * s + axis.z * d * (1 - c),
  );
  return out;
}

/* Trunk bind curvature, expressed as the per-segment curl the spring
   solver needs to reproduce it. Measured off rig.js's table: the bind
   segment angles (from straight down, toward +z) run
   36.2 / 28.0 / 11.3 / 3.5 / -2.9 degrees, i.e. -9.8 deg per segment.
   At the old 0.048 (2.75 deg, which matched a trunk a third shorter)
   the chain's rest pose was 30 degrees straighter than the sculpt at the
   tip, and the skin spent every frame being dragged back onto a curve it
   was not built on. */
/* Re-measured for the ROUND 2 trunk table (shorter, slimmer, tip at
   y 0.830): bind segment angles from straight down toward +z run
   46.3 / 30.6 / 16.5 / 6.6 / 5.6 degrees — mean step -10.2 deg/segment. */
/* Re-measured for the ROUND 4 table (slimmer, back edges unchanged, so
   the bind curve is straighter): segment angles run
   37.3 / 31.1 / 15.9 / 7.9 / 4.2 degrees — mean step -8.3 deg/segment. */
/* Re-measured for the ROUND 5 table (longer, slenderer, segments that
   shorten toward the tip): segment angles from straight down toward +z
   run 35.5 / 24.6 / 14.0 / 8.3 / 4.5 degrees — mean step -7.8 deg. */
const TRUNK_BASE_CURL = 0.135;

/* Bone-name lists for the rest-convergence pass. */
const TRUNK_BONES = ['trunk0', 'trunk1', 'trunk2', 'trunk3', 'trunk4'];
const EARL_BONES = ['earL0', 'earL1', 'earL2'];
const EARR_BONES = ['earR0', 'earR1', 'earR2'];
const TAIL_BONES = ['tail0', 'tail1', 'tail2'];

export class Secondary {
  constructor(ctx, opts) {
    this.ctx = ctx;
    this.root = opts.root;
    this.bones = opts.byName;
    this.controller = opts.controller || null;
    this.quality = ctx.quality;

    const head = this.bones.head;
    const hips = this.bones.hips;
    const headW = bindWorld('head');
    const hipsW = bindWorld('hips');

    const E = PROP.ear;
    const earOff = (side) => [
      E.root[0] * side - headW[0], E.root[1] - headW[1], E.root[2] - headW[2],
    ];
    const earDir = (side) => [E.dir[0] * side, E.dir[1], E.dir[2]];

    const phys = ctx.phys;
    this.chains = {};

    if (phys && phys.createChain) {
      /* ---- ears: 3 bones each, phased so they never move in lockstep ----
         GRAVITY IS A SILHOUETTE DECISION HERE, NOT A PHYSICS ONE. The 'ear'
         preset's 5.5 m/s^2 sags the tips inward by 36 mm a side at rest,
         which is 0.045 H off the span — the whole margin between passing
         and failing §1.1's silhouette test. 1.9 leaves a settled sag of a
         few millimetres, so the authored fan is what you see in a still
         frame, while the under-damped preset (zeta 0.36) still gives §4
         its overshoot-and-settle flap: gravity sets where an ear hangs,
         stiffness and damping set how it moves. */
      const EAR_G = 1.15;
      this.chains.earL = phys.createChain({
        preset: 'ear', name: 'wally.earL',
        bones: [this.bones.earL0, this.bones.earL1, this.bones.earL2],
        root: head,
        offset: earOff(1),
        restDir: earDir(1),
        curlAxis: [0, -1, 0],
        length: [E.seg, E.seg, E.seg],
        gravity: EAR_G,
        phase: 0.0,
        follow: opts.controller || undefined,
      });
      this.chains.earR = phys.createChain({
        preset: 'ear', name: 'wally.earR',
        bones: [this.bones.earR0, this.bones.earR1, this.bones.earR2],
        root: head,
        offset: earOff(-1),
        restDir: earDir(-1),
        curlAxis: [0, 1, 0],
        length: [E.seg, E.seg, E.seg],
        gravity: EAR_G,
        phase: 2.1,
        follow: opts.controller || undefined,
      });

      /* ---- trunk: 5 bones, heavier, stiffer than the preset because it
         has to hold a curl against gravity ---- */
      const T = PROP.trunk;
      const lens = [];
      for (let i = 0; i < 5; i++) {
        lens.push(Math.hypot(T[i + 1][0] - T[i][0], T[i + 1][1] - T[i][1], T[i + 1][2] - T[i][2]));
      }
      /* springs.js rotates segment i by curl * (i + 1), so segment 0 is
         already one curl step off restDir. Feeding it the raw bind
         direction therefore lands the WHOLE chain one step forward of
         the sculpt. restDir is the bind direction rotated BACK by one
         base-curl step, which puts segment 0 exactly on the sculpt and
         every segment after it on the authored fall-off. */
      const d0 = [T[1][0] - T[0][0], T[1][1] - T[0][1], T[1][2] - T[0][2]];
      const l0 = Math.hypot(d0[0], d0[1], d0[2]);
      const cb = Math.cos(-TRUNK_BASE_CURL), sb = Math.sin(-TRUNK_BASE_CURL);
      const ry = (d0[1] / l0) * cb - (d0[2] / l0) * sb;
      const rz = (d0[1] / l0) * sb + (d0[2] / l0) * cb;
      this.trunkRest = [d0[0] / l0, ry, rz];

      this.chains.trunk = phys.createChain({
        preset: 'trunk', name: 'wally.trunk',
        bones: [this.bones.trunk0, this.bones.trunk1, this.bones.trunk2,
          this.bones.trunk3, this.bones.trunk4],
        root: head,
        offset: [T[0][0] - headW[0], T[0][1] - headW[1], T[0][2] - headW[2]],
        restDir: this.trunkRest,
        curlAxis: [1, 0, 0],
        curl: TRUNK_BASE_CURL,
        length: lens,
        stiffness: 330, dampingRatio: 0.66, gravity: 5.6,
        windScale: 0.30, inertiaScale: 1.0, maxAngle: 42, rootMaxAngle: 30,
        phase: 1.05,
        follow: opts.controller || undefined,
      });

      /* ---- tail: a light 3-bone rope (§1.1 requires the tail; §4 wants
         it swaying in walk and wind, with the same rest-convergence rule
         as the trunk) ---- */
      const TL = PROP.tail;
      const td = [TL[1][0] - TL[0][0], TL[1][1] - TL[0][1], TL[1][2] - TL[0][2]];
      const tl = Math.hypot(td[0], td[1], td[2]);
      const tlens = [];
      for (let i = 0; i < 3; i++) {
        tlens.push(Math.hypot(TL[i + 1][0] - TL[i][0], TL[i + 1][1] - TL[i][1], TL[i + 1][2] - TL[i][2]));
      }
      this.chains.tail = phys.createChain({
        preset: 'tail', name: 'wally.tail',
        bones: [this.bones.tail0, this.bones.tail1, this.bones.tail2],
        root: hips,
        offset: [TL[0][0] - hipsW[0], TL[0][1] - hipsW[1], TL[0][2] - hipsW[2]],
        restDir: [td[0] / tl, td[1] / tl, td[2] / tl],
        length: tlens,
        phase: 3.4,
        follow: opts.controller || undefined,
      });
    }

    /* ---- belly: a light soft-body offset (§4, 0.03 m) ---- */
    this.belly = ctx.phys?.createSpringVec3
      ? ctx.phys.createSpringVec3({ stiffness: 210, dampingRatio: 0.42 })
      : null;
    this.bellyOffset = new THREE.Vector3();
    this.bellyBind = new THREE.Vector3().fromArray(this.bones.belly.position.toArray());

    /* ---- squash & stretch ---- */
    this.squash = this.controller ? this.controller.squash
      : (ctx.phys?.createSquash ? ctx.phys.createSquash() : null);

    /* ---- foot IK ---- */
    this.ikEnabled = true;
    this.ikBlend = 0;
    this.hipDrop = 0;
    this.legs = ['L', 'R'].map((s) => ({
      side: s,
      thigh: this.bones[`leg${s}0`],
      shin: this.bones[`leg${s}1`],
      foot: this.bones[`foot${s}`],
      L1: 0, L2: 0,
      offset: 0,
      normal: new THREE.Vector3(0, 1, 0),
    }));
    for (const l of this.legs) {
      l.L1 = l.shin.position.length();
      l.L2 = l.foot.position.length();
    }

    /* ---- live targets ---- */
    this.earPerk = 0; this.earSpread = 0;
    this.trunkCurl = 0; this.trunkSide = 0; this.trunkTip = 0;
    this._perk = 0; this._spread = 0;
    this._curl = 0; this._side = 0; this._tip = 0;
    this._stiff = 330;
    this._stiffTarget = 330;

    /* ---- rest convergence (see _convergeChains) ---- */
    this._speed = 0;
    this._restW = 1;
    this._excite = 0;

    /* landing / gust reactions */
    this._unsub = [];
    if (ctx.bus) {
      this._unsub.push(ctx.bus.on('phys:land', (e) => {
        if (e && this.controller && e.position !== this.controller.simPosition) return;
        this.land(e?.impact ?? 0.5);
      }));
      this._unsub.push(ctx.bus.on('phys:jump', () => this.jump()));
    }
  }

  /* ---------------- reactions ---------------- */

  /** The landing flap. Ears keep going down, then spring back and over. */
  land(impact) {
    const k = clamp(impact, 0, 1);
    this._excite = Math.min(1, 0.55 + 0.45 * k);
    _v0.set(0, -7.5 * k - 1.6, 0.9 * k);
    this.chains.earL?.impulse(_v0);
    _v0.set(0, -7.5 * k - 1.6, 0.9 * k);
    this.chains.earR?.impulse(_v0);
    _v0.set(0, -4.5 * k - 1.0, 1.4 * k);
    this.chains.trunk?.impulse(_v0);
    _v0.set(0, -3.0 * k, 0);
    this.chains.tail?.impulse(_v0);
    if (this.belly) this.belly.velocity.y -= 0.55 * k;
  }

  jump() {
    this._excite = Math.max(this._excite, 0.7);
    _v0.set(0, 3.2, -0.7);
    this.chains.earL?.impulse(_v0);
    this.chains.earR?.impulse(_v0);
    _v0.set(0, 1.8, -0.5);
    this.chains.trunk?.impulse(_v0);
    if (this.belly) this.belly.velocity.y += 0.3;
  }

  /** Kick every chain — used by the debug gust and by big story beats. */
  impulse(x, y, z) {
    this._excite = 1;
    _v0.set(x, y, z);
    for (const k in this.chains) this.chains[k].impulse(_v0);
    return this;
  }

  setEnabled(on) {
    for (const k in this.chains) this.chains[k].enabled = on !== false;
    return this;
  }

  /* ---------------- per-frame ---------------- */

  /**
   * Push this frame's intent into the chains. Called from wally.update(),
   * AFTER the clip pose has been written to the bones and BEFORE
   * phys.lateUpdate() solves the chains.
   */
  update(dt, s) {
    /* SANITISE dt — see _convergeChains. A single negative-dt frame at
       boot (headless rAF timestamp behind performance.now) turns every
       damp() here into an EXPONENTIAL AMPLIFIER: measured, _curl reached
       7e22 and the accent pass then wrote setFromAxisAngle(x, 7e22) onto
       bones the convergence had just fixed. The state persists, so the
       guard lives at the state's owner, not at the caller. */
    if (!(dt > 0)) dt = 1e-4;
    else if (dt > 0.05) dt = 0.05;
    this._speed = s.speed || 0;
    /* Blend the clip's declared hints over the expression's. A clip like
       `cool` owns the trunk; a mere expression only nudges it. */
    const h = s.hints;
    let perk = s.earPerk, spread = s.earSpread;
    let curl = s.trunkCurl, side = s.trunkSide, tip = s.trunkTip;
    let stiff = 330;
    if (h) {
      /* trunk cover and ear cover are separate: a blend can be half over a
         clip that owns the trunk and says nothing about the ears */
      const we = clamp(h.wEars ?? h.w, 0, 1);
      const wt = clamp(h.wTrunk ?? h.w, 0, 1);
      if (h.ears) {
        perk = perk * (1 - we) + (h.ears.perk ?? 0) * we;
        spread = spread * (1 - we) + (h.ears.spread ?? 0) * we;
      }
      if (h.trunk) {
        curl = curl * (1 - wt) + (h.trunk.curl ?? 0) * wt;
        side = side * (1 - wt) + (h.trunk.side ?? 0) * wt;
        tip = tip * (1 - wt) + (h.trunk.tip ?? 0) * wt;
        stiff = stiff * (1 - wt) + (h.trunk.stiff ?? 330) * wt;
      }
    }

    /* Running lays the ears back a little and stretches the trunk out —
       that is what makes speed read on the character rather than on the
       ground scrolling past. */
    const gait = clamp((s.speed || 0) / 6.4, 0, 1);
    perk -= gait * 0.13;
    spread += gait * 0.05;
    curl += gait * 0.06;

    /* Clamped into pose-space ranges: these feed setFromAxisAngle and the
       chain rest, where a corrupted value does structural damage. The
       clamps also RECOVER state that an earlier bad frame blew up —
       without them a 1e22 field takes ten seconds of exponential decay to
       come back on camera. */
    this._perk = clamp(damp(this._perk, perk, 6, dt), -1.5, 1.5);
    this._spread = clamp(damp(this._spread, spread, 6, dt), -1.5, 1.5);
    this._curl = clamp(damp(this._curl, curl, 7, dt), -2.5, 2.5);
    this._side = clamp(damp(this._side, side, 6, dt), -2.5, 2.5);
    this._tip = clamp(damp(this._tip, tip, 6, dt), -2.5, 2.5);
    this._stiffTarget = stiff;
    this._stiff = clamp(damp(this._stiff, this._stiffTarget, 4, dt), 40, 2400);

    /* ---- ears ---- */
    const E = PROP.ear;
    for (const [key, sgn] of [['earL', 1], ['earR', -1]]) {
      const c = this.chains[key];
      if (!c) continue;
      c.setCurl(this._perk);
      /* spread lifts the tip and swings it away from the skull */
      const dx = E.dir[0] * sgn;
      const dy = E.dir[1] + this._spread * 1.15;
      const dz = E.dir[2] - this._spread * 0.35;
      c.setRestDir(dx, dy, dz);
    }

    /* ---- trunk ---- */
    const tr = this.chains.trunk;
    if (tr) {
      tr.setCurl(TRUNK_BASE_CURL + this._curl);
      /* swing the whole trunk sideways, and tilt the curl plane with it,
         so a curled trunk stays curled while it swings (§1.6, 'cool') */
      const a = this._side;
      const ca = Math.cos(a), sa = Math.sin(a);
      const r = this.trunkRest;
      tr.setRestDir(r[0] * ca + r[2] * sa, r[1], -r[0] * sa + r[2] * ca);
      tr.curlAxis.set(ca, 0, -sa).normalize();
      tr.setStiffness(this._stiff, 0.66);
    }

    /* ---- spring hygiene: a chain's internal curl spring holds state
       across frames, and Spring1 only self-heals on NON-finite values —
       a finite-but-astronomical one (the negative-dt explosion) sticks
       and scrambles the chain's rest directions for ten seconds while it
       decays. Snap it straight onto its target instead. ---- */
    for (const k in this.chains) {
      const c = this.chains[k];
      const cs = c && c._curlSpring;
      if (cs && !(Math.abs(cs.value) < 8)) cs.set(cs.target || 0);
    }

    /* ---- belly: chases zero, kicked by the body's own acceleration ---- */
    if (this.belly) {
      const c = this.controller;
      if (c) {
        _v0.copy(c.acceleration).multiplyScalar(-0.0016);
        _v0.y -= 0.010;
        _v0.x = clamp(_v0.x, -0.05, 0.05);
        _v0.y = clamp(_v0.y, -0.05, 0.05);
        _v0.z = clamp(_v0.z, -0.05, 0.05);
      } else _v0.set(0, -0.006, 0);
      this.belly.step(dt, _v0);
      this.bellyOffset.copy(this.belly.value).clampLength(0, 0.032);
      const b = this.bones.belly;
      b.position.set(
        this.bellyBind.x + this.bellyOffset.x,
        this.bellyBind.y + this.bellyOffset.y,
        this.bellyBind.z + this.bellyOffset.z,
      );
    }

    /* ---- squash & stretch, applied at the soles ---- */
    if (this.squash) {
      if (!this.controller) this.squash.step(dt);
      const y = this.squash.y, xz = this.squash.xz;
      this.root.scale.set(xz, y, xz);
    }
  }

  /**
   * Runs after phys.lateUpdate() has solved and written the chains.
   * Tip accents first (they multiply onto what the solver wrote), then
   * foot IK.
   */
  lateUpdate(dt, s) {
    this._convergeChains(dt);
    this._applyPoseAccents();
    if (this.ikEnabled && this.ctx.phys?.groundAt) this._footIK(dt, s);
  }

  /* ------------------------------------------------------------------
     REST CONVERGENCE — the structural fix for the orbiting trunk.

     THE DEFECT, MEASURED (see the clip comment on `idle` in anim.js):
     the 5-bone trunk chain does not settle at rest — it ORBITS, half a
     metre of travel at the tip across wind phases, and every pose that
     rides the chain (cool/idle/intro) ships whatever frame of that orbit
     the boot happened to land on. Tuning stiffness cannot fix a solver
     whose rest target is itself being moved (curl spring, wind, root
     micro-motion from breathing all displace it every frame).

     THE FIX IS STRUCTURAL: the springs only get to EXPRESS during
     locomotion and reactions. chain.apply() (phys.lateUpdate) writes the
     solver's delta onto the bones; this pass runs immediately after and
     blends those quaternions back toward IDENTITY — which, because every
     bind rotation in rig.js is identity and no clip writes chain bones,
     IS the authored sculpt pose — then hard-caps the residual deviation.
     At full rest the trunk sits within ~3 degrees of the sculpt no matter
     what the wind does for 30 s or 30 minutes; the pose accents
     (_applyPoseAccents) then add the AUTHORED curl/side/tip on top, so
     'cool' renders the same trunk every boot. As speed rises the blend
     and the cap fade out and §4's flap-and-settle is untouched; landings,
     jumps and gusts push `_excite`, which opens the cap for ~1.5 s so the
     reaction still reads, and then the chain converges again.
     ------------------------------------------------------------------ */
  _convergeChains(dt) {
    /* SANITISE dt. main.js clamps the frame dt from above only
       (Math.min(raw, 0.05)); under the headless screenshot harness the
       first rAF timestamp can sit SECONDS BEFORE the performance.now()
       taken during boot, so one call arrives with dt ~ -15 s. Fed to
       damp() that is lerp with t = 1-e^(+51): the state explodes to 1e21
       and the slerp below, handed that as a weight, scrambles every
       chain bone. Everything in this pass is state that persists, so it
       is guarded here rather than hoping every caller is clean. */
    if (!(dt > 0)) return;
    if (dt > 0.05) dt = 0.05;
    /* restness: 1 standing still, 0 above a slow walk */
    const rest = 1 - clamp((this._speed - 0.22) / 1.1, 0, 1);
    this._excite = clamp(this._excite - dt * 0.7, 0, 1);
    const want = rest * (1 - this._excite);
    this._restW = clamp(damp(this._restW, want, 3.4, dt), 0, 1);
    const rw = this._restW;
    if (rw < 0.01) return;

    _q1.identity();
    const B = this.bones;
    /* [names, blend-at-rest, residual cap in degrees at full rest] */
    const groups = [
      [TRUNK_BONES, 0.94, 3.0],
      [EARL_BONES, 0.82, 5.0],
      [EARR_BONES, 0.82, 5.0],
      [TAIL_BONES, 0.88, 6.0],
    ];
    for (let g = 0; g < groups.length; g++) {
      const [names, blend, capDeg] = groups[g];
      const cap = (capDeg * Math.PI / 180) / Math.max(rw, 1e-3);
      for (let i = 0; i < names.length; i++) {
        const b = B[names[i]];
        if (!b) continue;
        const q = b.quaternion;
        q.slerp(_q1, blend * rw);
        const w = Math.abs(q.w) > 1 ? 1 : Math.abs(q.w);
        const ang = 2 * Math.acos(w);
        if (ang > cap) q.slerp(_q1, 1 - cap / ang);
      }
    }
  }

  /* ------------------------------------------------------------------
     CURL AND SPREAD HAVE TO BE WRITTEN ONTO THE BONES HERE.

     This is not a stylistic choice, it is a property of the solver.
     SpringChain outputs a DELTA: apply() builds each bone's quaternion
     from setFromUnitVectors(restLocalDir[i] * rootQuat, worldDir[i]).
     setCurl() and setRestDir() move restLocalDir — and the chain's
     particles settle onto that same new rest — so the two sides of that
     subtraction move together and the delta stays identity. Measured:
     with the 'cool' clip driving curl to -0.42 the chain's tip solved to
     (0.42, 1.24, 0.68), a properly raised and cocked trunk, while every
     trunk bone stayed within 2 degrees of bind and the SKIN hung dead
     straight down. That is the "ragdoll mid-fall" the critique saw, and
     no amount of tuning the clip could have fixed it.

     So the chain keeps owning the DYNAMICS (its rest is still curled, so
     gravity, inertia and the angle limits all behave as if the trunk
     really is held up there) and this writes the POSE on top of what the
     solver wrote. Per-segment rotations are post-multiplied — expressed
     in each bone's own frame, so they accumulate down the chain into a
     progressive curl exactly as springs.js intends. Root-level aim
     changes are pre-multiplied, because those are expressed in the
     parent's frame.
     ------------------------------------------------------------------ */
  _applyPoseAccents() {
    const B = this.bones;

    /* ---- trunk: the side sweep GROWS down the chain, per the reference —
       the root hangs plumb off the face and the lower half drifts to one
       side, so the tip curl (below) opens ACROSS the camera instead of
       foreshortening straight at it. A root-only yaw either did nothing
       (small values) or unseated the trunk from the face (large ones). ---- */
    if (Math.abs(this._side) > 1e-4) {
      _q0.setFromAxisAngle(_v0.set(0, 1, 0), this._side * 0.30);
      B.trunk0.quaternion.premultiply(_q0);
      _q0.setFromAxisAngle(_v0.set(0, 1, 0), this._side * 0.45);
      B.trunk2.quaternion.multiply(_q0);
      _q0.setFromAxisAngle(_v0.set(0, 1, 0), this._side * 0.60);
      B.trunk3.quaternion.multiply(_q0);
    }
    if (Math.abs(this._curl) > 1e-4) {
      _q0.setFromAxisAngle(_v0.set(1, 0, 0), this._curl);
      for (let i = 0; i < 5; i++) B['trunk' + i].quaternion.multiply(_q0);
    }
    /* Cocked tip — the last segments carry an extra accent on top of the
       curl, which is what turns "raised" into "raised and cocked". */
    /* ROUND 5: spread over THREE bones (was trunk4 + 0.42*trunk3). Two
       reasons, both seen in shots/ck-*.png: (1) the ref's tip is an ARC —
       the last third of the trunk sweeps up — not a two-bone hinge, and
       the hinge could never carry enough total angle to lift the nub past
       horizontal without crumpling the skin at one joint; (2) the old
       concentration printed a crease band at the trunk3/trunk4 latitude
       in the welcome hang. Total gain 1.67x per unit of `tip` (was
       1.42x), with every single joint bending LESS for the same read. */
    /* ROUND 6: PUSHED BACK TOWARD THE TIP (1.15 / 0.40 / 0.10, total
       1.65x). Round 5's 0.30 on trunk2 rotated the MID-trunk 25 degrees
       forward in 'cool' — verified in a studio side shot: the whole lower
       half swept out horizontally like a reaching arm, and from the 3/4
       studio camera that projected as the critic's "sideways-left bend,
       no upward arc". The ref hangs the SHAFT plumb and confines the curl
       to the last third: trunk2 now gets a token 0.10 (keeps the arc from
       reading as a hinge), trunk3 0.40, and trunk4 carries the nub the
       rest of the way. Bonus: trunk2's smaller rotation also stops the
       skin at the groove latitude (y 1.09-1.17) drifting off the seated
       stroke rods — the split third bridge line in both poses. */
    /* ROUND 7 — RE-SPREAD FOR THE LONGER TRUNK, AND TO KILL THE JOINT.
       The nub read as a lobe stuck on the end of the trunk rather than
       the last third of one spline, and the reason was arithmetic: at
       gain 1.15 with `cool`'s tip -1.32, bone trunk4 alone bent 1.52 rad
       — 87 degrees at a single joint on a 82 mm segment. No amount of
       weight smoothing hides an 87-degree hinge; it prints a crease ring
       and the mesh either side of it reads as two forms.
       Gains now 0.95 / 0.75 / 0.20 (total 1.90, was 1.65): the biggest
       single joint drops to 72 degrees while the TOTAL arc grows, which
       is what the longer trunk needs to finish its curl. Traced against
       the new station table with `cool`'s accents, the nub lands at
       y 1.022 / z 0.572 and its crown at 0.66 H — the ref's nostril sits
       at 0.65 H and, solved back through the studio camera's basis from
       its pixel position, at z ~0.60. */
    /* ROUND 8 — THE LOOP HAS TO OPEN, AND THAT IS WHERE THE ARC STARTS,
       NOT HOW BIG IT IS. Compared at matched scale against
       ref/wally-ref-cool.png: the reference's trunk hangs STRAIGHT for
       roughly the first 60% of its length and then sweeps through one
       wide arc, so the bottom of the loop sits low, near mid-chest, and
       the nub finishes well out to the side. Round 7's 0.20 on trunk2
       started bending at 35% of the length, so the same total angle was
       spent higher up: the loop closed into a tight hook right under the
       tusks and the nub came back up beside the tube it left.
       Total gain is unchanged at 1.90 — the arc is still ~144 degrees at
       cool's -1.32 — but it now starts a segment later: trunk2 keeps a
       token 0.08 so the transition is not a hinge, and the two lower
       joints carry the rest at 1.02 / 0.80. Biggest single joint 77
       degrees, which is inside the 87 that round 7 measured as the angle
       that prints a crease ring, and the softened nub flare (see
       PROP.trunk) takes the rest of the strain off that joint. */
    if (Math.abs(this._tip) > 1e-4) {
      _q0.setFromAxisAngle(_v0.set(1, 0, 0), this._tip * 1.02);
      B.trunk4.quaternion.multiply(_q0);
      _q0.setFromAxisAngle(_v0.set(1, 0, 0), this._tip * 0.80);
      B.trunk3.quaternion.multiply(_q0);
      _q0.setFromAxisAngle(_v0.set(1, 0, 0), this._tip * 0.08);
      B.trunk2.quaternion.multiply(_q0);
    }

    /* ---- ears: spread swings the fan off the skull, perk rolls it ---- */
    const E = PROP.ear;
    if (Math.abs(this._spread) > 1e-4 || Math.abs(this._perk) > 1e-4) {
      for (const [key, sgn] of [['earL', 1], ['earR', -1]]) {
        if (!B[key + '0']) continue;
        if (Math.abs(this._spread) > 1e-4) {
          _v0.set(E.dir[0] * sgn, E.dir[1], E.dir[2]).normalize();
          _v1.set(E.dir[0] * sgn, E.dir[1] + this._spread * 1.15,
            E.dir[2] - this._spread * 0.35).normalize();
          _q0.setFromUnitVectors(_v0, _v1);
          B[key + '0'].quaternion.premultiply(_q0);
        }
        if (Math.abs(this._perk) > 1e-4) {
          _q0.setFromAxisAngle(_v0.set(0, -sgn, 0), this._perk);
          for (let i = 0; i < 3; i++) B[key + i].quaternion.multiply(_q0);
        }
      }
    }
  }

  /* ------------------------------------------------------------------
     Two-bone analytic IK, both legs, plus a hip drop.

     Order matters: measure both feet first, drop the hips by whichever
     foot needs the most downward reach, re-evaluate, then solve each leg.
     Solving legs before dropping the hips gives you a character who does
     the splits on a slope.
     ------------------------------------------------------------------ */
  _footIK(dt, s) {
    const phys = this.ctx.phys;
    const grounded = s?.grounded !== false;
    const want = grounded ? 1 : 0;
    this.ikBlend = damp(this.ikBlend, want, 8, dt);
    if (this.ikBlend < 0.004) { this.hipDrop = damp(this.hipDrop, 0, 8, dt); return; }

    this.root.updateMatrixWorld(true);
    const rootY = this.root.position.y;
    const sy = this.root.scale.y || 1;

    let lowest = 0;
    for (const l of this.legs) {
      l.foot.getWorldPosition(_v0);
      const g = phys.groundAt(_v0.x, _v0.z);
      /* the ankle should sit a fixed height above the ground it stands on */
      const ankleH = (PROP.leg[2][1] - PROP.foot.c[1] + PROP.foot.h[1] + PROP.foot.r) * sy;
      l.targetY = g.y + ankleH;
      l.normal.copy(g.normal);
      const need = l.targetY - _v0.y;
      if (need < lowest) lowest = need;
    }

    /* Hips come down to meet the lower foot. Never up — that would lift
       him off the floor on a crest. */
    const drop = clamp(lowest, -0.34, 0);
    this.hipDrop = damp(this.hipDrop, drop * this.ikBlend, 9, dt);
    if (Math.abs(this.hipDrop) > 1e-5) {
      this.bones.hips.position.y += this.hipDrop / (sy || 1);
      this.root.updateMatrixWorld(true);
    }

    for (const l of this.legs) {
      l.thigh.getWorldPosition(_v0);                 // hip
      l.shin.getWorldPosition(_v1);                  // knee
      l.foot.getWorldPosition(_p0);                  // ankle

      _v3.set(_p0.x, l.targetY, _p0.z);
      _v3.lerpVectors(_p0, _v3, this.ikBlend);

      const L1 = _v0.distanceTo(_v1);
      const L2 = _v1.distanceTo(_p0);
      _p1.copy(_v3).sub(_v0);                        // hip -> target
      let d = _p1.length();
      if (d < 1e-4) continue;
      d = clamp(d, Math.abs(L1 - L2) + 1e-3, L1 + L2 - 1e-3);
      _p1.normalize();

      /* Knee pole: the direction the knee should bulge toward. Blending
         the current thigh direction with the model's forward keeps the
         pose's own knee bend and only corrects the reach. */
      _p2.set(0, 0, 1).applyQuaternion(this.root.quaternion).multiplyScalar(0.55);
      _p3.copy(_v1).sub(_v0).normalize().add(_p2).normalize();
      _p4.crossVectors(_p3, _p1);
      if (_p4.lengthSq() < 1e-8) _p4.set(1, 0, 0).applyQuaternion(this.root.quaternion);
      _p4.normalize();

      const a1 = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
      rotAxis(_p1, _p4, -a1, _p5);                   // desired thigh direction

      /* swing the thigh */
      _p2.copy(_v1).sub(_v0).normalize();
      _q0.setFromUnitVectors(_p2, _p5);
      this._applyWorldRot(l.thigh, _q0);
      l.thigh.updateMatrixWorld(true);

      /* swing the shin onto the target */
      l.shin.getWorldPosition(_v1);
      l.foot.getWorldPosition(_p0);
      _p2.copy(_p0).sub(_v1).normalize();
      _p3.copy(_v3).sub(_v1).normalize();
      _q0.setFromUnitVectors(_p2, _p3);
      this._applyWorldRot(l.shin, _q0);
      l.shin.updateMatrixWorld(true);

      /* roll the foot onto the slope */
      if (l.normal.y < 0.9995) {
        _p2.set(0, 1, 0);
        _q0.setFromUnitVectors(_p2, l.normal);
        _q1.identity().slerp(_q0, this.ikBlend * 0.85);
        this._applyWorldRot(l.foot, _q1);
      }
    }
  }

  /**
   * Compose a world-space rotation Q onto a bone whose parent already has
   * a world orientation P:  local' = P^-1 * Q * P * local.
   */
  _applyWorldRot(bone, qWorld) {
    const parent = bone.parent;
    if (!parent) { bone.quaternion.premultiply(qWorld); return; }
    parent.getWorldQuaternion(_q2);
    _q3.copy(_q2).invert();
    bone.quaternion.premultiply(_q2).premultiply(qWorld).premultiply(_q3);
  }

  dispose() {
    for (const k in this.chains) this.chains[k].dispose?.();
    for (const u of this._unsub) u?.();
    this._unsub.length = 0;
  }
}

export default { Secondary };
