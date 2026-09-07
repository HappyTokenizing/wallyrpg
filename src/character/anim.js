/* ============================================================
   anim.js — the clip library and the blending state machine.

   A POSE is two flat arrays: a local euler triple per bone and a local
   position offset per bone. Because rig.js guarantees every bind rotation
   is identity, a pose IS the bone's local rotation — there is no bind
   quaternion to compose with, blending is a lerp, and a clip is readable
   as the angles an animator would have dialled.

   Euler blending rather than quaternion slerp is a deliberate choice, not
   a shortcut: every angle in this file is inside +/-160 degrees on a
   single dominant axis per joint, which is the regime where euler lerp and
   slerp are indistinguishable, and it makes the additive layers below
   (look-at, expression, lean, breathing) a simple addition instead of a
   quaternion sandwich.

   LAYERS, in the order they are resolved:

     1  locomotion    idle <-> walk <-> run <-> sprint, blended by speed
                      and driven by DISTANCE, not by time, so the feet do
                      not skate and the blend does not slip its phase
     2  action        a one-shot or looping clip (wave, jump, talk...) or
                      a held pose (cool, welcome), crossfaded over the
                      locomotion layer with a smoothstep weight
     3  additive      look-at, breathing, lean, expression accents

   Nothing snaps. Every transition between 1 and 2 is a timed crossfade,
   and the locomotion blend itself is continuous in speed.
   ============================================================ */

import { BONE_INDEX, BONES, PROP, bindWorld } from './rig.js';
import { clamp, smoothstep, damp } from '../core/contracts.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const NB = BONES.length;
const TAU = Math.PI * 2;

/* ------------------------------------------------------------------
   Pose buffers
   ------------------------------------------------------------------ */
export function makePose() {
  return { e: new Float32Array(NB * 3), t: new Float32Array(NB * 3) };
}
function clearPose(p) { p.e.fill(0); p.t.fill(0); }
function copyPose(dst, src) { dst.e.set(src.e); dst.t.set(src.t); }
function blendPose(dst, a, b, w) {
  if (w <= 0) { copyPose(dst, a); return; }
  if (w >= 1) { copyPose(dst, b); return; }
  const iw = 1 - w;
  for (let i = 0; i < NB * 3; i++) {
    dst.e[i] = a.e[i] * iw + b.e[i] * w;
    dst.t[i] = a.t[i] * iw + b.t[i] * w;
  }
}
function addPose(dst, src, w = 1) {
  for (let i = 0; i < NB * 3; i++) { dst.e[i] += src.e[i] * w; dst.t[i] += src.t[i] * w; }
}

/** The writer handed to a clip function. Degrees in, radians stored. */
class Writer {
  constructor() { this.pose = null; }
  bind(p) { this.pose = p; return this; }
  /** rotate bone `n` by (x,y,z) degrees, additive within the clip */
  r(n, x, y, z) {
    const i = BONE_INDEX[n];
    if (i === undefined) return this;
    const e = this.pose.e;
    e[i * 3] += x * D2R; e[i * 3 + 1] += y * D2R; e[i * 3 + 2] += z * D2R;
    return this;
  }
  /** translate bone `n` by (x,y,z) metres */
  p(n, x, y, z) {
    const i = BONE_INDEX[n];
    if (i === undefined) return this;
    const t = this.pose.t;
    t[i * 3] += x; t[i * 3 + 1] += y; t[i * 3 + 2] += z;
    return this;
  }
  /** mirror-aware: applies to the left bone as given and the right mirrored */
  both(base, x, y, z, mirror = [1, -1, -1]) {
    this.r(base.replace('*', 'L'), x, y, z);
    this.r(base.replace('*', 'R'), x * mirror[0], y * mirror[1], z * mirror[2]);
    return this;
  }
}

const sin = Math.sin, cos = Math.cos;

/* ==================================================================
   THE GAIT SOLVER — walk, run and sprint are one function.

   WHY THIS IS BUILT BACKWARDS FROM THE FOOT.

   The clip this replaces drove the thigh with a cosine and let the foot
   land wherever the arithmetic put it. On a 0.42 m leg a 24-degree
   cosine buys about 0.32 m of foot travel, while `cycle` told the phase
   integrator the stride was 1.34 m — so the planted foot skated forward
   at HALF of ground speed, and the only way to hide that was to keep the
   stride tiny. That is the shuffle: both legs near vertical, no contact
   pose, no passing pose, no weight.

   Here the ANKLE PATH is the thing that is authored:

     STANCE   a straight line moving backward at exactly ground speed,
              corrected by the foot's own roll (see `rollGain`)
     SWING    a Hermite arc whose end tangents MATCH the stance line, so
              the foot is already travelling backward at ground speed on
              the frame it touches down and there is no contact skid

   The thigh, knee and ankle angles are then whatever two-bone IK needs
   to reach that path, and `cycle` — metres of ground per gait cycle — is
   DERIVED from the path rather than tuned against it. "The foot does not
   slide" is therefore a property of the construction, not a setting.

   THE PELVIS HEIGHT IS ALSO SOLVED, NOT KEYED. His legs are 0.42 m long
   and his hip sits 0.535 m over the sole: in bind the leg is DEAD
   STRAIGHT, so it has no reach to spend on a stride until the pelvis
   comes down. `hipCeiling` is the highest the pelvis can be and still
   let both feet touch their targets with a knee left in the leg; the
   real bob falls out of it — deepest just after each contact, highest at
   each passing — which is exactly the DOWN and UP of the four key poses.
   ================================================================== */

const _hipsW = bindWorld('hips');
const _hipJW = bindWorld('legL0');
const _kneeW = bindWorld('legL1');
const _ankW = bindWorld('footL');

const GAIT_T = Math.hypot(_kneeW[0] - _hipJW[0], _kneeW[1] - _hipJW[1], _kneeW[2] - _hipJW[2]);
const GAIT_S = Math.hypot(_ankW[0] - _kneeW[0], _ankW[1] - _kneeW[1], _ankW[2] - _kneeW[2]);
const LEG_MAX = GAIT_T + GAIT_S;
const LEG_MIN = Math.abs(GAIT_T - GAIT_S) + 0.03;

/* the hip joint in the pelvis bone's own frame */
const HIPJ_X = _hipJW[0] - _hipsW[0];
const HIPJ_Y = _hipJW[1] - _hipsW[1];
const HIPJ_Z = _hipJW[2] - _hipsW[2];

/* the sole plane, and everything measured off it */
const SOLE_Y = PROP.foot.c[1] - PROP.foot.h[1] - PROP.foot.r;
const ANK_H = _ankW[1] - SOLE_Y;                                  // ankle over the sole
const HEEL_Z = PROP.foot.c[2] - PROP.foot.h[2] - PROP.foot.r;     // heel, ankle-relative
const TOE_Z = PROP.foot.c[2] + PROP.foot.h[2] + PROP.foot.r;      // toe,  ankle-relative
const STANCE_X = _ankW[0];                                        // half the stance width
const HIPS_Y = _hipsW[1] - SOLE_Y;                                // pelvis bone over the sole

/** Ankle height that puts the lowest point of the sole exactly on the
 *  ground for a given foot pitch. Positive pitch = toe down, so the toe
 *  is the low point; negative = heel down. This is the whole of the foot
 *  roll: heel strike, flat, heel off, toe off all come out of it. */
function soleH(th) {
  return ANK_H * cos(th) + (th < 0 ? HEEL_Z : TOE_Z) * sin(th);
}

/** Foot pitch, radians, positive = plantarflexion (toe down).
 *  strike -> flat -> hold -> heel off -> toe off -> swing -> strike. */
function footPitch(p, G) {
  if (p < G.beta) {
    const u = p / G.beta;
    if (u < G.flat) return G.strike * (1 - smoothstep(0, G.flat, u));
    if (u < G.rise) return 0;
    return G.toeOff * smoothstep(G.rise, 1, u);
  }
  const u = (p - G.beta) / (1 - G.beta);
  const a = G.toeOff + (G.swing - G.toeOff) * smoothstep(0, 0.42, u);
  return a + (G.strike - a) * smoothstep(0.46, 1, u);
}

const ROLL_N = 72;

/** Resolve a gait config: integrate the roll, derive the stride, cache
 *  the stance table and the Hermite tangents. Runs once per gait. */
function buildGait(G) {
  /* ---- roll gain -------------------------------------------------
     A rolling foot is a wheel: while the pitch changes by dTheta about a
     pivot that is `soleH` below the ankle, the ankle itself travels
     soleH * dTheta FORWARD over that pivot. Integrated across the
     stance this is worth ~0.13 m on a 0.42 m leg — a third of the whole
     stride, bought for free by not keeping the foot flat. It is also
     why the trailing leg does not have to reach absurdly far back. */
  const roll = new Float64Array(ROLL_N + 1);
  let acc = 0, prev = footPitch(0, G);
  for (let i = 1; i <= ROLL_N; i++) {
    const th = footPitch((i / ROLL_N) * G.beta, G);
    acc += soleH((th + prev) * 0.5) * (th - prev);
    roll[i] = acc;
    prev = th;
  }
  G.rollTab = roll;
  /* metres of ground covered while one foot is down, and hence the
     cycle: two of those, back to back. */
  G.travel = G.zf - G.zb + acc;
  G.cycle = G.travel / G.beta;
  /* stance tangents in swing-parameter units, damped by `whip` so the
     foot trails after toe-off and whips through instead of pinging */
  const h = 1 / ROLL_N;
  const zAt = (u) => {
    const f = clamp(u, 0, 1) * ROLL_N;
    const i = Math.min(ROLL_N - 1, Math.floor(f)), t = f - i;
    return G.zf - G.travel * clamp(u, 0, 1) + roll[i] * (1 - t) + roll[i + 1] * t;
  };
  G.zAt = zAt;
  const k = (1 - G.beta) / G.beta * G.whip;
  G.m0 = (zAt(1) - zAt(1 - h)) / h * k;     // leaving the ground
  G.m1 = (zAt(h) - zAt(0)) / h * k;         // arriving at it
  /* the mean pelvis height this gait will actually settle at, once the
     reach ceiling has had its say — the head's counter-bob is measured
     against it, and a keyed guess would be wrong by the whole bob */
  const reach = LEG_MAX * (1 - G.slack);
  let sum = 0;
  for (let i = 0; i < 32; i++) {
    const ph = i / 32;
    const pl = ph, pr = (ph + 0.5) % 1;
    ankleAt(pl, G, _fl); ankleAt(pr, G, _fr);
    const c = Math.min(hipCeiling(1, STANCE_X, _fl[1], _fl[0], 0, 0, reach),
      hipCeiling(-1, -STANCE_X, _fr[1], _fr[0], 0, 0, reach));
    sum += Math.min(G.hipY, c);
  }
  G.hipMean = sum / 32;
  return G;
}

/** The ankle, in the root's frame, for one leg at phase p. */
function ankleAt(p, G, out) {
  const th = footPitch(p, G);
  if (p < G.beta) {
    out[0] = G.zAt(p / G.beta);
    out[1] = soleH(th);
  } else {
    const u = (p - G.beta) / (1 - G.beta);
    const u2 = u * u, u3 = u2 * u;
    out[0] = (2 * u3 - 3 * u2 + 1) * G.zb + (u3 - 2 * u2 + u) * G.m0
           + (-2 * u3 + 3 * u2) * G.zf + (u3 - u2) * G.m1;
    /* the arc: clearance over whatever the pitch alone would give, so
       the ends stitch to the stance exactly */
    const s = Math.pow(u, 0.72);
    out[1] = soleH(th) + G.lift * sin(Math.PI * s);
  }
  out[2] = th;
  return out;
}

/* scratch — module scope, never allocated per frame */
const _M = new Float64Array(9);
const _fl = new Float64Array(3);
const _fr = new Float64Array(3);
const _d = new Float64Array(3);

/** R = Rx * Ry * Rz, the order THREE.Euler('XYZ') composes in. */
function pelvisMat(rx, ry, rz, M) {
  const cx = cos(rx), sx = sin(rx), cy = cos(ry), sy = sin(ry), cz = cos(rz), sz = sin(rz);
  M[0] = cy * cz;               M[1] = -cy * sz;              M[2] = sy;
  M[3] = cx * sz + sx * sy * cz; M[4] = cx * cz - sx * sy * sz; M[5] = -sx * cy;
  M[6] = sx * sz - cx * sy * cz; M[7] = sx * cz + cx * sy * sz; M[8] = cx * cy;
}
/** d = R^T * (t - p) - hipOffset : the ankle target in the hip's frame.
 *  `sgn` is +1 for his left hip, -1 for his right; only x mirrors. */
function toHip(M, sgn, px, py, pz, tx, ty, tz, d) {
  const ax = tx - px, ay = ty - py, az = tz - pz;
  d[0] = M[0] * ax + M[3] * ay + M[6] * az - sgn * HIPJ_X;
  d[1] = M[1] * ax + M[4] * ay + M[7] * az - HIPJ_Y;
  d[2] = M[2] * ax + M[5] * ay + M[8] * az - HIPJ_Z;
}

/** Highest the pelvis bone may sit OVER THE SOLE PLANE and still let this
 *  foot reach its target, with `slack` of the leg held in reserve so the
 *  knee never locks dead straight. `ankY` is sole-relative too. */
function hipCeiling(sgn, footX, ankY, ankZ, swayX, surgeZ, reach) {
  const dx = footX - (_hipsW[0] + swayX) - sgn * HIPJ_X;
  const dz = ankZ - (_hipsW[2] + surgeZ) - HIPJ_Z;
  const v = reach * reach - dx * dx - dz * dz;
  return ankY - HIPJ_Y + (v > 1e-4 ? Math.sqrt(v) : 0.01);
}

/**
 * One frame of gait. Writes legs, pelvis, spine, arms and head.
 *
 * THE FOUR KEY POSES ARE NOT KEYED ANYWHERE IN HERE, and that is the
 * point: CONTACT is where the ankle path starts, DOWN is where the reach
 * ceiling pulls the pelvis to its lowest a beat later, PASSING is where
 * the swing arc carries the foot under the hip with the knee at its
 * deepest, and UP is where the ceiling releases and the pelvis rides
 * over the straight support leg. Author the foot and the four poses are
 * consequences; key the four poses and the foot slides.
 */
function gait(ph, w, s, G) {
  const a = ph * TAU;
  const sw = sin(a), cs = cos(a);

  /* ---- pelvis attitude -------------------------------------------
     Three separate things, and the walk was missing all three:
       sway   the pelvis slides on to the supporting foot, or the mass
              is not over the leg carrying it
       roll   the SWINGING side's hip drops away — the pelvic list that
              makes a walk look like it costs something
       yaw    the pelvis counter-rotates against the ribcage, which is
              also worth ~0.02 m of free stride at each hip */
  const swayX = G.sway * sw;
  const rollZ = G.pelvisRoll * sw * D2R;
  const yawY = -G.pelvisYaw * cs * D2R;
  const pitchX = G.lean * D2R;
  /* a small fore/aft surge, twice a cycle, so the pelvis leads the push */
  const surgeZ = G.surge * cos(2 * a);

  /* nominal bob; `lowAt` puts the low point where the gait wants it —
     just after contact for a walk, at mid-stance for a run */
  const bobT = 0.5 + 0.5 * cos(2 * TAU * (ph - G.lowAt));
  let hipY = G.hipY - G.drop * bobT;

  /* ---- feet ---- */
  const pL = ph - Math.floor(ph);
  const pR = (ph + 0.5) - Math.floor(ph + 0.5);
  ankleAt(pL, G, _fl);
  ankleAt(pR, G, _fr);
  /* the swing foot passes closer to the midline than it plants */
  const inL = G.pass * clamp((pL - G.beta) / (1 - G.beta), 0, 1) * (1 - clamp((pL - G.beta) / (1 - G.beta), 0, 1)) * 4;
  const inR = G.pass * clamp((pR - G.beta) / (1 - G.beta), 0, 1) * (1 - clamp((pR - G.beta) / (1 - G.beta), 0, 1)) * 4;
  const xL = STANCE_X - inL;
  const xR = -STANCE_X + inR;

  /* ---- and the pelvis height they will actually allow ---- */
  const reach = LEG_MAX * (1 - G.slack);
  const cL = hipCeiling(1, xL, _fl[1], _fl[0], swayX, surgeZ, reach);
  const cR = hipCeiling(-1, xR, _fr[1], _fr[0], swayX, surgeZ, reach);
  const ceil = Math.min(cL, cR);
  /* SOFT min. A hard one puts a corner in the bob on every changeover
     between which leg is the binding one, and a corner in a height curve
     reads as a hitch in the step. */
  const kk = 0.011;
  hipY = Math.min(hipY, ceil) - kk * Math.log(1 + Math.exp(-Math.abs(hipY - ceil) / kk));
  /* THE WEIGHT SETTLE, and it is subtracted AFTER the ceiling on purpose.
     Geometry gives him a ~20 mm bob, which is what a 0.42 m leg is worth
     and is correct and invisible. The settle is the animator's thumb on
     it: an extra sink through the frames just after each contact, where
     the mass arrives. Taking the pelvis DOWN can never break a foot
     contact — the IK below simply re-solves to the same targets — so
     this is free, whereas exaggerating the rise would put a foot in
     the air. */
  hipY -= G.settle * bobT * bobT;

  const py = SOLE_Y + hipY;
  w.p('hips', swayX, py - _hipsW[1], surgeZ);
  w.r('hips', pitchX * R2D, yawY * R2D, rollZ * R2D);

  pelvisMat(pitchX, yawY, rollZ, _M);

  /* ---- two-bone IK, both legs ---- */
  const solve = (sd, sgn, fx, f) => {
    toHip(_M, sgn, _hipsW[0] + swayX, py, _hipsW[2] + surgeZ, fx, SOLE_Y + f[1], f[0], _d);
    let r = Math.hypot(_d[0], _d[1], _d[2]);
    if (r < 1e-5) return;
    const rc = clamp(r, LEG_MIN, LEG_MAX * 0.9995);
    const abd = Math.asin(clamp(_d[0] / r, -1, 1));
    const aim = Math.atan2(-_d[2], -_d[1]);
    const A = Math.acos(clamp((GAIT_T * GAIT_T + rc * rc - GAIT_S * GAIT_S) / (2 * GAIT_T * rc), -1, 1));
    const K = Math.acos(clamp((GAIT_T * GAIT_T + GAIT_S * GAIT_S - rc * rc) / (2 * GAIT_T * GAIT_S), -1, 1));
    const thigh = aim - A;
    const knee = Math.PI - K;
    w.r(`leg${sd}0`, thigh * R2D, 0, abd * R2D);
    w.r(`leg${sd}1`, knee * R2D, 0, 0);
    /* the ankle carries the roll: whatever is left after the leg */
    w.r(`foot${sd}`, (f[2] - thigh - knee - pitchX) * R2D, -yawY * R2D * 0.55, -abd * R2D * 0.55);
  };
  solve('L', 1, xL, _fl);
  solve('R', -1, xR, _fr);

  /* ---- spine: the ribcage opposes the pelvis --------------------
     These are LOCAL angles on a chain that already carries the pelvis,
     so the sum has to overshoot to land the shoulders on the far side
     of zero — that is what makes it a counter-swing and not a lag. */
  const cw = G.counter;
  w.r('spine', G.spineX * 0.45, -yawY * R2D * (0.55 + cw * 0.45), -rollZ * R2D * 0.55);
  w.r('chest', G.spineX * 0.55, -yawY * R2D * (0.55 + cw * 0.85), -rollZ * R2D * 0.75);

  /* ---- head: level, with a counter-bob against the pelvis ---- */
  const bobV = hipY - G.hipMean;
  w.r('head', G.headX + bobV * 40, yawY * R2D * 0.55, rollZ * R2D * 0.35);
  w.p('head', 0, -bobV * 0.22, 0);

  /* ---- arms: opposition, lagging the legs, elbow soft on the back
     swing so it is a limb and not a pendulum ---- */
  const al = cos(a - G.armLag * TAU);
  const zOut = G.armOut - G.armOutSwing * al;
  w.r('armL0', G.arm * al + G.armBias, 0, zOut);
  w.r('armR0', -G.arm * al + G.armBias, 0, -zOut);
  w.r('armL1', -(G.elbow + G.elbowSwing * clamp(al, 0, 1)), 0, -G.elbowOut);
  w.r('armR1', -(G.elbow + G.elbowSwing * clamp(-al, 0, 1)), 0, G.elbowOut);
  w.r('handL', G.hand, 0, -G.handOut);
  w.r('handR', G.hand, 0, G.handOut);
}

/* ------------------------------------------------------------------
   The three gaits.

   `zf` / `zb` are how far forward the ankle is at heel strike and how
   far back it is at toe-off; `beta` is the fraction of the cycle the
   foot is down. Everything about the stride — its length, its cadence,
   its cycle in metres — follows from those three and the foot roll.

   A RUN IS NOT A FAST WALK. Its numbers say so: `beta` drops under a
   half so both feet leave the ground, `zf`/`zb` grow, the pelvis sits
   lower and its bob turns over (low at MID-STANCE, where a runner's
   knee absorbs, instead of low at contact where a walker's does), and
   the trunk pitches into it.
   ------------------------------------------------------------------ */
const GAITS = {
  /* A SLOW WALK IS ITS OWN RUNG, and it is not a nicety. The ladder used
     to run idle -> walk with nothing between, so 1.0 m/s — which is
     exactly what a half-deflected touch stick holds — resolved to 43%
     walk blended with 57% of a STANDING POSE. A standing pose has feet
     that do not move, so the blend slid the contact foot at most of
     ground speed: measured, 95% slip. Every gentle approach in the game
     was a moonwalk. This rung is a real gait with a real ankle path, so
     the idle blend now only has to cover 0 to 1.25 m/s, which is the
     band he is genuinely stopping in. */
  'walk-slow': buildGait({
    beta: 0.62, flat: 0.22, rise: 0.62,
    strike: -12 * D2R, toeOff: 23 * D2R, swing: -11 * D2R,
    zf: 0.132, zb: -0.150,
    lift: 0.036, whip: 0.58, pass: 0.020,
    hipY: HIPS_Y + 0.004, drop: 0.008, settle: 0.012, lowAt: 0.07, slack: 0.006,
    sway: 0.026, pelvisRoll: 2.6, pelvisYaw: 5.5, surge: 0.004,
    lean: 0.8, spineX: 1.6, headX: -1.4, counter: 0.80,
    arm: 14, armBias: 1.0, armOut: 7.0, armOutSwing: 1.4,
    elbow: 5, elbowSwing: 9, elbowOut: 3, armLag: 0.055,
    hand: 3, handOut: 4,
  }),
  walk: buildGait({
    beta: 0.56, flat: 0.19, rise: 0.60,
    strike: -16 * D2R, toeOff: 30 * D2R, swing: -14 * D2R,
    zf: 0.186, zb: -0.215,
    lift: 0.052, whip: 0.62, pass: 0.026,
    hipY: HIPS_Y + 0.004, drop: 0.010, settle: 0.019, lowAt: 0.06, slack: 0.007,
    sway: 0.030, pelvisRoll: 3.4, pelvisYaw: 7.5, surge: 0.006,
    lean: 1.6, spineX: 2.6, headX: -2.2, counter: 0.90,
    arm: 22, armBias: 1.5, armOut: 7.5, armOutSwing: 2.0,
    elbow: 7, elbowSwing: 13, elbowOut: 3, armLag: 0.045,
    hand: 5, handOut: 4,
  }),
  run: buildGait({
    beta: 0.40, flat: 0.14, rise: 0.52,
    strike: -8 * D2R, toeOff: 46 * D2R, swing: -18 * D2R,
    zf: 0.235, zb: -0.210,
    lift: 0.095, whip: 0.70, pass: 0.030,
    hipY: HIPS_Y - 0.014, drop: 0.020, settle: 0.026, lowAt: 0.16, slack: 0.012,
    sway: 0.022, pelvisRoll: 3.0, pelvisYaw: 10.5, surge: 0.010,
    lean: 7.0, spineX: 7.5, headX: -8.0, counter: 1.05,
    arm: 46, armBias: -3, armOut: 11, armOutSwing: 2.5,
    elbow: 30, elbowSwing: 16, elbowOut: 6, armLag: 0.030,
    hand: 10, handOut: 6,
  }),
  sprint: buildGait({
    beta: 0.34, flat: 0.12, rise: 0.50,
    strike: -4 * D2R, toeOff: 52 * D2R, swing: -22 * D2R,
    zf: 0.255, zb: -0.225,
    lift: 0.125, whip: 0.74, pass: 0.032,
    hipY: HIPS_Y - 0.024, drop: 0.026, settle: 0.032, lowAt: 0.14, slack: 0.014,
    sway: 0.018, pelvisRoll: 2.6, pelvisYaw: 12.0, surge: 0.012,
    lean: 12.0, spineX: 12.0, headX: -13.0, counter: 1.10,
    arm: 58, armBias: -7, armOut: 13, armOutSwing: 3.0,
    elbow: 44, elbowSwing: 18, elbowOut: 8, armLag: 0.025,
    hand: 12, handOut: 7,
  }),
};

/** Stance fraction at a given locomotion speed — secondary.js weights
 *  the terrain conform with it so a swinging foot is never flattened
 *  on to the ground it is passing over. */
export function gaitBeta(speed) {
  let i = 0;
  while (i < LOCO_STEPS.length - 2 && speed > LOCO_STEPS[i + 1].speed) i++;
  const A = LOCO_STEPS[i], B = LOCO_STEPS[i + 1];
  const f = clamp((speed - A.speed) / Math.max(B.speed - A.speed, 1e-3), 0, 1);
  const ba = GAITS[A.name] ? GAITS[A.name].beta : 1;
  const bb = GAITS[B.name] ? GAITS[B.name].beta : 1;
  return ba * (1 - f) + bb * f;
}

/* ==================================================================
   Clip library

   fn(ph, w, s) — ph is 0..1 through the clip, w is the Writer, s is the
   live state {speed, gait, turn, grounded, vy, airTime, elapsed}.
   `loco` marks a clip whose phase comes from distance travelled.
   ================================================================== */

/** Shared: breathing. Small, slow, always on under everything else.
 *
 * THE AMPLITUDE HAS TO BE READABLE AT GAMEPLAY DISTANCE, NOT ON A
 * TURNTABLE. At the boot framing one metre is 150 px, so the old 6 mm
 * chest rise was 0.9 px and the old 1.5 degree pitch moved the crown by
 * 1.1 px — under the film grain, i.e. mathematically present and
 * visually absent. Two judges independently described him as static with
 * "arms hanging limp". 18 mm and 2.8 degrees put the chest through 2.7 px
 * and the crown through 4 px, and because the ear and trunk chains hang
 * off the chest the springs multiply it: the ear tips travel about 9 px
 * per breath, which is the thing you actually notice.
 *
 * The cycle is also two sines a fifth apart rather than one, so the
 * inhale is quicker than the exhale — a flat sine reads as a machine. */
function breathe(w, t, amp = 1) {
  const p = t * 1.02;
  const b = sin(p) * 0.78 + sin(p * 2 + 0.9) * 0.22;
  const b2 = sin(p + 0.55);
  w.r('chest', -2.8 * b * amp, 0, 0);
  w.p('chest', 0, 0.018 * b * amp, 0.007 * b * amp);
  w.r('spine', 1.5 * b2 * amp, 0, 0);
  w.p('spine', 0, 0.006 * b * amp, 0);
  w.r('head', 0.9 * b2 * amp, 0, 0);
  /* the arms ride the ribcage — this is what stops them reading as two
     rods bolted to a barrel */
  w.r('armL0', -1.1 * b * amp, 0, 2.6 * b * amp);
  w.r('armR0', -1.1 * b * amp, 0, -2.6 * b * amp);
  w.r('armL1', 0.8 * b * amp, 0, -1.0 * b * amp);
  w.r('armR1', 0.8 * b * amp, 0, 1.0 * b * amp);
}

/**
 * Shared: arms hanging with a little natural flare and a soft "elbow".
 *
 * `flare` rotates the arm about z at a pivot level with the deltoid, so
 * every degree pushes the FOREARM out without moving the shoulder — it
 * fights §1.1's pear directly. At the old default of 7 degrees the widest
 * silhouette row moved from the deltoid at 0.63 H down to the wrist at
 * 0.55 H and Wally read as a barrel. 3 degrees still keeps the arms off
 * the flank; anything more has to be paid for in the rig.
 */
/* THE CURVE IS ABDUCT-THEN-ADDUCT, WHICH IS HOW YOU GET A GAP WITHOUT A
   BARREL. The note above is right that flare alone is a trap: every
   degree at the deltoid swings the whole arm out, the wrist ends up
   outboard of the shoulder, and §1.1's widest row moves from the belly
   to the hand. But the reason both gameplay judges wrote "arms hanging
   limp" is that at 3 degrees the forearm sits 6 mm off the flank at
   y 0.78 — 0.9 px at the boot framing — so the arm has no background
   behind it and fuses into the torso as one grey slab.

   Splitting the curve fixes both at once. The shoulder abducts `flare`
   (default 6.5) and the elbow adducts about 60% of it back, so:
     elbow  y 0.868  moves out 22 mm  -> the slot opens from ~0 to 22 mm
     wrist  y 0.668  moves out  9 mm  -> outer edge 0.259, still under
                                         the deltoid's 0.276 and well
                                         under the belly, so the widest
                                         ROW is unchanged and §1.1's pear
                                         survives
   and the arm now has a readable S rather than being a plumb line. The
   forward swing does the same job in depth for the three-quarter and
   profile cameras, and drops the hand clear of the thigh. */
function armsRest(w, flare = 6.5, fwd = 5) {
  const back = -flare * 0.60;
  w.r('armL0', -fwd, 0, flare);
  w.r('armR0', -fwd, 0, -flare);
  w.r('armL1', -fwd * 0.55, 0, back);
  w.r('armR1', -fwd * 0.55, 0, -back);
  /* palms roll a few degrees inward toward the thigh — a hand hanging
     dead flat is the other half of "limp" */
  w.r('handL', 5, -6, -4);
  w.r('handR', 5, 6, 4);
}

/* ==================================================================
   THE BICYCLE POSTURE — one function, three clips, and the contract
   bike.js is built against.

   WHY THE HIPS GO **UP** AND NOT DOWN. The clip this replaces dropped
   the pelvis 120 mm BELOW its bind height, which is what you do when a
   character crouches; a rider does the opposite. Wally's hip joint
   stands 0.524 m over his soles, a saddle is set so the leg is ~88 %
   extended at the bottom of the stroke — 0.46 m of hip-to-spindle — and
   the crank spindle has to sit at 0.215 m for a 0.27 m wheel to fit
   under it. 0.215 + 0.46 = 0.675, i.e. 0.151 m ABOVE where the hip
   stands. That is not a stylisation, it is the definition of a bicycle:
   the pedals hold the feet off the floor, so the body rides higher than
   it walks. Every earlier frame of this clip had him squatting six
   inches into the road with his legs dangling half a metre over the
   cranks, which is invisible in the intro's twelve-metre flyby and
   impossible to miss from the four-metre follow camera.

   ALL THREE LOCO CLIPS SHARE THIS ONE PEDAL DRIVE AT ONE PHASE, and
   bike.js turns the real crank from the same phase (Animator.bikePhase),
   so the foot and the pedal under it are the same number rather than
   two numbers that agree. The blend between coasting, riding and
   sprinting therefore cannot slip a stroke — only the body over the
   pedals changes.

   SIGN CONVENTIONS, read off `walk` and `jump-land` rather than
   assumed: +x on leg*0 lifts the thigh forward, +x on leg*1 bends the
   knee (heel back), +x on foot* points the toe down.
   ================================================================== */
export const BIKE_SEAT = {
  /* pelvis offset from bind, metres — hips bone lands at 0.500 + dy */
  dy: 0.036,
  dz: -0.100,
  /* the crank the legs are authored around, in root-local metres.
     bike.js publishes the same three numbers and they must agree. */
  bbY: 0.215, bbZ: 0.030, crank: 0.078,
  /* THE REACH TO THE BARS, and it is mutable so that it can be SOLVED
     rather than argued about. §1.1 gives him a 0.30 H arm hung off a
     shoulder that is 0.355 H wide and abducted 19 degrees to clear the
     pear — so a change of ten degrees at the deltoid moves the mitten
     as much sideways as forward, and no amount of reasoning about
     sagittal angles predicts where it lands. WALLY.debug.bikeArms()
     writes these four and WALLY.debug.bikeInfo() reads back the world
     position of the hand; bike.js's BARS is then set to the answer.
     a0 = deltoid (x forward, z abduction), a1 = elbow. */
  /* SOLVED, 20 August: seven trials at speed 0 with the pedal phase
     frozen, reading handL/handR back out of bikeInfo(). Every
     combination in the family lands the mitten within 25 mm of
     (0.35, 0.885, 0.275) — the arm is short and the shoulder is
     abducted, so the reach is nearly saturated and the ANGLES barely
     move the hand. That is why bike.js's bars go to the hand and not
     the other way round. */
  a0x: -40, a0z: 19, a1x: -20, a1z: -10,
};

/**
 * The seated posture over the cranks.
 *
 * @param {number} ph    pedal phase, 0..1
 * @param {Writer} w
 * @param {number} eff   0 = coasting upright, 1 = riding, 2 = sprinting
 * @param {number} k     master weight, for the mount/dismount ramps
 */
function bikeBody(ph, w, eff = 1, k = 1) {
  if (k <= 0) return;
  const a = ph * TAU;
  /* ---- THE CRANK RUNS THE OTHER WAY ROUND FROM THE BODY ----

     `cr` is the phase the LEG SOLVE runs on, and it is the negative of
     `a`. This is the whole of the "he pedals backwards" fix and it is
     worth saying why the minus sign lives here and nowhere else.

     FORWARD IS +Z (bike.js line 37). A positive rotation.x carries a
     point at +y toward +z, so a forward-rolling wheel and a
     forward-turning crank BOTH have a positive rotation.x: the top of
     the circle goes forward, the bottom goes back. Read the crank the
     other way and you get the four stations in the order
     bottom -> back -> top -> front.

     The solved table this function is fitted to runs the other order.
     Measured on the shipped rig with WALLY.debug.driveTrace, the leg
     solve put the left ankle at root-local z:

         ph 0     +0.012   bottom
         ph 0.25  +0.108   FRONT
         ph 0.5   +0.008   top
         ph 0.75  -0.064   BACK

     bottom -> front -> top -> back, which is a rider back-pedalling.
     Somebody met this before and negated the two CONSUMERS instead —
     bike.setCrankPhase(-phase) and a negated wheel spin in wally.js —
     which glued the pedal mesh under the backwards foot and dragged
     the wheels backwards with it, so the whole drivetrain agreed with
     itself and disagreed with the direction of travel. Those two
     negations are gone; the sign is here, once, at the source.

     ONLY THE PEDAL SOLVE TAKES `cr`. Everything below the legs — the
     rock, the shoulder counter-rotation, the head sway, the arm term —
     stays on `a`, and that is not an oversight. The rock exists to
     shift his mass onto whichever foot is PUSHING, and reversing the
     crank does not change which foot that is: the ankle's HEIGHT curve
     is very nearly even in phase, so the left foot descends over
     ph 0.5..1.0 either way (measured: 0.369 -> 0.209 before, 0.369 ->
     0.209 after). Flipping the rock with the crank would therefore
     have moved his weight onto the foot that is coming UP. What DOES
     change is where in the circle that push happens — it moves from
     the back of the stroke to the FRONT, which is where a bicycle
     makes its torque, and that is the point of the fix. */
  const cr = -a;
  /* effort reshapes the torso, never the legs: the legs are on a crank
     and a crank does not care how hard you are trying */
  /* THE LEAN IS SMALL BECAUSE THE HEAD IS BIG. 25 degrees at the hip is
     a road-bike fold, and on a figure whose cranium is 0.348 H across
     it puts the crown out past the front hub and the face down in the
     basket — measured on shots/_bikeside.png, where he read as being
     sick over the handlebars rather than riding. 8 + 9 keeps the
     upright city-bike back that the swept bars and the basket already
     imply, and still gives the sprint something to fold into. */
  const lean = (8 + eff * 9) * k;
  const rock = (2.6 + eff * 2.2) * k;

  /* ---- the pelvis onto the saddle ----
     The pelvis tips forward on the saddle as the effort goes up, and
     the pedal solve below has to know by how much: the legs hang off
     the hips bone, so every degree of pelvic tilt is a degree the
     thigh has already been given. `hipTilt` is subtracted back out. */
  const hipTilt = (6 + eff * 3) * k;
  w.p('hips', 0, BIKE_SEAT.dy * k, BIKE_SEAT.dz * k);
  w.r('hips', -hipTilt, 0, 0);

  /* ---- the pedal stroke ----

     THESE FOUR NUMBERS ARE SOLVED, NOT DIALLED, and the first attempt
     at dialling them is why: two plausible-looking sine waves put the
     measured ankle 330 mm BEHIND the crank and 520 mm above it, with
     one foot higher than the saddle. A leg on a crank is a closed
     four-bar — the foot is not free to be roughly right.

     SIGN, read off `sit` rather than assumed. A bone's child hangs at
     -y, so R_x(t) sends it to -z for positive t: NEGATIVE x on leg*0
     swings the thigh FORWARD, positive x on leg*1 is knee flexion, and
     the world pitch of the foot is the sum of the three. `sit` agrees
     exactly (-84 thigh forward, +88 knee).

     THE SOLVE. Two-bone inverse kinematics in the sagittal plane at the
     four quarter positions of the crank, with the rig's own segment
     lengths — thigh 0.227 m (hip 0.524 to knee 0.297), shin 0.169
     (knee to ankle 0.128) — and the ankle held 0.10 m above the pedal
     because that is where the sole is:

       solve phase p    0        PI/2      PI       3PI/2
       reach            0.345    0.315     0.206    0.249     (max 0.396)
       thigh forward    45.4     70.3      81.4     51.5      degrees
       knee flexion     59.5     75.6     119.4    103.6

     Neither curve is a cosine — the circle is offset from the hip, so
     both are phase-shifted and the fit needs the shift. Two terms each,
     residual under 2.5 degrees, which is 4 mm at the ankle.

     `p` IS NOT THE CRANK ANGLE — it is its negative (`cr` above). The
     four stations are unchanged; p = PI/2 is still the FRONT of the
     circle. Running them in descending order is what turns the crank
     forward, and it is why bike.setCrankPhase() is now handed the
     animator's phase unsigned.

     WHY THE HIP ONLY RISES 36 mm. §1.1 gives Wally a 0.30 H leg on a
     1.00 H body, so hip-to-ankle is 0.396 m on a 1.60 m character —
     stubby, and it is the whole reason his silhouette works. A saddle
     is set from the LEG, not from the height: 0.345 m of reach at the
     bottom of the stroke puts his hip at 0.560, which is 36 mm over
     where it stands, and therefore puts the whole bicycle — 0.225 m
     wheels, a 0.215 m bottom bracket, a 0.47 m saddle — at small-wheel
     city-bike scale. That is not a stylisation either; it is what
     happens when you build a bicycle for these legs. */
  const pedal = (side, off) => {
    /* `cr`, not `a` — see the note at the top. The four solved stations
       below are unchanged; they are simply visited in the other order,
       which is what makes it a forward stroke. */
    const p = cr + off;
    const thigh = 63.4 - 20.3 * cos(p + 0.481);        // forward of vertical
    const knee = 89.5 - 33.1 * cos(p - 0.437);         // flexion
    w.r(`leg${side}0`, (-thigh + hipTilt) * k, 0, 0);
    w.r(`leg${side}1`, knee * k, 0, 0);
    /* the sole stays flat on the pedal — the foot cancels the sum of
       the two above — with a few degrees of toe-down through the power
       stroke, which is the one thing a rider's ankle actually does */
    w.r(`foot${side}`, (thigh - knee - hipTilt + 5 * cos(p + 0.7)) * k, 0, 0);
    /* knees track the top tube instead of splaying: a small inward
       roll that grows as the thigh comes up */
    w.r(`leg${side}0`, 0, 0, (side === 'L' ? -1 : 1) * (3.4 + 2.2 * -cos(p)) * k);
  };
  pedal('L', 0); pedal('R', Math.PI);

  /* ---- the fold at the hip, and the body rocking with the stroke ----
     The rock is at the PEDAL frequency, not twice it: the rider's mass
     shifts onto whichever foot is pushing, so one sine per revolution,
     with the shoulders counter-rotating a third of it. */
  w.r('spine', lean, -1.5 * rock * sin(a) * 0.3, rock * sin(a));
  w.r('chest', lean * 0.42, 2.0 * rock * sin(a) * 0.3, -rock * 0.55 * sin(a));
  w.r('belly', 0, 0, -rock * 0.3 * sin(a));

  /* ---- head up, watching the road ----
     The head's WORLD pitch is spine + chest + head, i.e. lean * 1.42
     plus whatever is written here, so cancelling the lean means
     cancelling all of it and not just the head's own share. The
     residual +4 is the few degrees of down-gaze a rider actually has:
     level would read as staring into the middle distance. */
  w.r('head', -(lean * 1.42 - 4) * k, (1.6 * sin(a) + 0.8 * sin(a * 0.37)) * k, -rock * 0.3 * sin(a));

  /* ---- hands on the bars ----
     Shoulders down and forward, elbows soft and OUT (a rider's elbows
     are never locked), wrists rolled over the grips. The bar reach is
     measured against these angles in bike.js — see BARS there. */
  const A = BIKE_SEAT;
  w.r('armL0', (A.a0x - eff * 4) * k, -6 * k, (A.a0z + eff * 3) * k);
  w.r('armR0', (A.a0x - eff * 4) * k, 6 * k, (-A.a0z - eff * 3) * k);
  w.r('armL1', (A.a1x - eff * 3) * k, 0, A.a1z * k);
  w.r('armR1', (A.a1x - eff * 3) * k, 0, -A.a1z * k);
  /* the arms take the road through the elbows, out of phase with the
     legs so the whole figure is never symmetric on any frame */
  w.r('armL1', -2.2 * rock * sin(a + 1.1) * k, 0, 0);
  w.r('armR1', 2.2 * rock * sin(a + 1.1) * k, 0, 0);
  w.r('handL', -22 * k, -4 * k, -13 * k);
  w.r('handR', -22 * k, 4 * k, 13 * k);

  breathe(w, ph * (1.4 + eff * 1.6), (0.35 + eff * 0.30) * k);
}

/* ==================================================================
   THE TWO MOTORISED POSTURES — scooter and motorcycle.

   WHY THEY ARE NOT bikeBody WITH DIFFERENT NUMBERS. The bicycle
   posture is organised around a CRANK: the legs are a closed four-bar
   whose phase drives everything, and the effort parameter reshapes the
   torso over it. Neither motor has a crank. The legs stop being a
   mechanism and become a STANCE — held, quiet, and the single loudest
   thing telling the player which machine is under him at forty metres,
   because a leg is a long limb against a bright road and a fold at the
   knee survives long after the tank and the mudguards have merged into
   one blob.

     bicycle      thighs sweeping 45-81 degrees, feet BELOW the hips
     scooter      thighs forward ~70 degrees, knees soft, feet AHEAD of
                  the hips on a flat deck — the stance of a chair
     motorcycle   thighs near vertical, knees folded ~115 degrees,
                  ankles BEHIND the hips on pegs — a crouch

   THE LEG ANGLES ARE SOLVED, NOT DIALLED, by the same two-bone IK the
   bicycle's four crank stations came from (thigh 0.227 m, shin 0.169 m,
   ankle 0.115 m above whatever it stands on). Author a foot station in
   root-local metres and the solve returns the angles. Where the prop
   then goes is not a second guess: rides.js reads these same records,
   and WALLY.debug.rideInfo() reports where the skeleton actually put
   the ankle, so the two can be checked against each other rather than
   eyeballed off a screenshot.

   MICRO-MOTION IS THE OTHER HALF. A rider on a machine that does the
   work has nothing to do with his body, which is exactly how a badly
   made one reads as a mannequin bolted to a prop. So both carry an
   ENGINE — a fine fast tremor on the seat and the grips with nothing to
   do with the wheels, at 31 Hz for the scooter's little single and
   17 Hz for the big twin. It is a third of a degree. You do not see it;
   you notice when it is missing, and it is the whole tell that the
   thing is RUNNING while stopped, which no bicycle can do.
   ================================================================== */

const THIGH_L = 0.227, SHIN_L = 0.169;
/** Two-bone sagittal IK. dy = ankle below the hip, dz = ankle ahead of
    it, both metres. Returns [thigh forward of vertical, knee flexion]
    in degrees, which is exactly what holdLeg writes. */
function legSolve(dy, dz) {
  const c = Math.min(Math.hypot(dy, dz), (THIGH_L + SHIN_L) * 0.985);
  const inner = clamp((THIGH_L * THIGH_L + SHIN_L * SHIN_L - c * c)
    / (2 * THIGH_L * SHIN_L), -1, 1);
  const ia = Math.acos(inner);
  const knee = 180 - ia * 57.2958;
  const alpha = Math.asin(clamp(SHIN_L * Math.sin(ia) / Math.max(c, 1e-4), -1, 1)) * 57.2958;
  return [Math.atan2(dz, Math.max(dy, 1e-4)) * 57.2958 + alpha, knee];
}

/** One leg, HELD rather than cycled. `roll` closes the knee inward
    (positive) or lets it hang out over a peg (negative). */
function holdLeg(w, side, thigh, knee, hipTilt, toe, roll, k) {
  const s = side === 'L' ? -1 : 1;
  w.r(`leg${side}0`, (-thigh + hipTilt) * k, 0, s * roll * k);
  w.r(`leg${side}1`, knee * k, 0, 0);
  /* the sole cancels the sum of the two above, plus whatever tilt the
     footrest has: flat on a deck, a few degrees down on a peg */
  w.r(`foot${side}`, (thigh - knee - hipTilt + toe) * k, 0, 0);
}

/* The two seats, in root-local metres. rides.js is fitted to these and
   must not be allowed to disagree with them — see RIDE_FIT there. */
/* THE FOOT STATION IS AS HIGH AS IT IS FOR THE MACHINE'S SAKE, and
   that is a legitimate reason. Wally's leg is 0.30 H, so his seat can
   only ever be 0.41 m off the ground; put his soles at ankle 0.260 and
   the floor they stand on lands at 0.10, which leaves a scooter with
   50 mm of body between its floor and the road and reads — measured on
   shots/_scootside.png — as a skateboard with a fairing. Lifting the
   ankle to 0.318 raises the floor to 0.156, gives the machine a body to
   have, and takes the knee from 61 to 78 degrees: further from the
   bicycle's stroke, and much closer to the "sitting in a chair with
   your feet out" that a step-through actually is. */
export const SCOOT_SEAT = {
  dy: -0.018, dz: -0.130,       // pelvis offset from bind (hip stands 0.524)
  footY: 0.318, footZ: 0.112,   // ankle station; the floor is 0.128 under it
  a0x: -34, a0z: 21, a1x: -25, a1z: -12,
  buzz: 31,
};
export const MOTO_SEAT = {
  dy: 0.020, dz: -0.185,
  footY: 0.350, footZ: -0.285,  // ankle over a peg, BEHIND the hip
  a0x: -46, a0z: 25, a1x: -13, a1z: -8,
  buzz: 17,
};

/**
 * A seated motorised posture. Shared by both machines; everything that
 * differs is in the seat record and the shape record.
 *
 * @param {object} P   SCOOT_SEAT | MOTO_SEAT
 * @param {number} ph  distance phase — the road, never the legs
 * @param {Writer} w
 * @param {number} eff 0 = stopped, 1 = cruising, 2 = flat out
 * @param {number} k   master weight, for the mount/dismount ramps
 * @param {object} s   live state; `elapsed` drives the engine tremor
 * @param {object} S   { lean, rock, tilt, roll, toe, tuck }
 */
function motorBody(P, ph, w, eff, k, s, S) {
  if (k <= 0) return;
  const a = ph * TAU;
  const t = (s && s.elapsed) || 0;
  const lean = (S.lean[0] + eff * S.lean[1]) * k;
  const rock = (S.rock[0] + eff * S.rock[1]) * k;
  const hipTilt = (S.tilt[0] + eff * S.tilt[1]) * k;

  /* ---- pelvis onto the seat ---- */
  w.p('hips', 0, P.dy * k, P.dz * k);
  w.r('hips', -hipTilt, 0, 0);

  /* ---- the legs, solved onto their footrest ----
     footZ is a ROOT-space station and the hip has already moved back by
     P.dz, so the reach the solve needs is the difference. */
  const [thigh, knee] = legSolve(0.524 + P.dy - P.footY, P.footZ - P.dz);
  holdLeg(w, 'L', thigh, knee, hipTilt, S.toe, S.roll, k);
  holdLeg(w, 'R', thigh, knee, hipTilt, S.toe, S.roll, k);
  /* NOT PERFECTLY SYMMETRIC. Two legs at identical angles is the one
     thing no photograph of a rider has ever shown, and the eye reads it
     as a shop dummy inside half a second. Two degrees of thigh and one
     of toe is enough, and costs nothing. */
  w.r('legR0', -2.0 * k, 0, 0);
  w.r('footR', 1.4 * k, 0, 0);

  /* ---- the fold at the hip, and the road under it ----
     A motor rider's body moves with the ROAD, not with a stroke: a slow
     weave the speed feeds, an order of magnitude below the bicycle's
     pedal-frequency lurch. */
  const weave = sin(a * 0.5) * 0.6 + sin(a * 0.19 + 1.3) * 0.4;
  w.r('spine', lean, -1.2 * rock * weave, rock * weave);
  w.r('chest', lean * S.tuck, 1.6 * rock * weave, -rock * 0.5 * weave);
  w.r('belly', 0, 0, -rock * 0.3 * weave);

  /* ---- head up, watching the road ----
     Same cancellation as the bicycle: world pitch is spine + chest +
     head, so undoing the lean means undoing all of it. The residual
     grows with effort — you look further ahead the faster you go, and
     on the big machine that is the only place it reads. */
  w.r('head', -(lean * (1 + S.tuck) - (3 + eff * 2)) * k, 1.1 * weave * k, -rock * 0.3 * weave);

  /* ---- hands on the bars ---- */
  w.r('armL0', (P.a0x - eff * 3) * k, -5 * k, (P.a0z + eff * 2) * k);
  w.r('armR0', (P.a0x - eff * 3) * k, 5 * k, (-P.a0z - eff * 2) * k);
  w.r('armL1', (P.a1x - eff * 2) * k, 0, P.a1z * k);
  w.r('armR1', (P.a1x - eff * 2) * k, 0, -P.a1z * k);
  w.r('handL', -20 * k, -4 * k, -12 * k);
  w.r('handR', -20 * k, 4 * k, 12 * k);
  /* the road arrives through the elbows, out of phase side to side */
  w.r('armL1', -1.6 * rock * sin(a * 0.5 + 1.1) * k, 0, 0);
  w.r('armR1', 1.6 * rock * sin(a * 0.5 + 1.1) * k, 0, 0);

  /* ---- THE ENGINE ---- see the block comment above. */
  const buz = sin(t * P.buzz) * (0.30 + eff * 0.10) * k;
  w.r('hips', buz * 0.6, 0, buz * 0.4);
  w.r('handL', buz, 0, 0); w.r('handR', -buz, 0, 0);

  breathe(w, ph * (1.1 + eff * 0.9) + t * 0.15, (0.30 + eff * 0.22) * k);
}

const SCOOT_SHAPE = { lean: [5, 5], rock: [1.4, 1.6], tilt: [3, 3], roll: 4.5, toe: 2, tuck: 0.34 };
const MOTO_SHAPE = { lean: [15, 9], rock: [1.1, 1.4], tilt: [8, 5], roll: -6.5, toe: 9, tuck: 0.46 };

function scootBody(ph, w, eff = 1, k = 1, s) { motorBody(SCOOT_SEAT, ph, w, eff, k, s, SCOOT_SHAPE); }
function motoBody(ph, w, eff = 1, k = 1, s) { motorBody(MOTO_SEAT, ph, w, eff, k, s, MOTO_SHAPE); }

/* ==================================================================
   WHICH MACHINE THE MOUNT IS A MOUNT ONTO.

   'bike-mount' and 'bike-dismount' carry the ARC — the dip, the push,
   the leg over the back, the hands finding the bars — and none of that
   is bicycle-specific. What IS specific is the pose they arrive at, so
   the destination is a POINTER rather than a call, swapped by
   Animator.setRide() before the clip is played. A step-through scooter
   is walked into and barely swings a leg; a motorcycle swings one
   further than a bicycle because the seat sits behind a tank.
   ================================================================== */
const RIDE_POSTURE = { bike: bikeBody, scooter: scootBody, motorcycle: motoBody };
const RIDE_MOUNT = {
  bike: { swing: 1.00, dip: 1.00 },
  scooter: { swing: 0.34, dip: 0.78 },
  motorcycle: { swing: 1.18, dip: 1.12 },
};
let ridePose = bikeBody;
let rideMount = RIDE_MOUNT.bike;
/** Point the mount/dismount clips at a machine. Animator.setRide()
    calls this; nothing else should. */
export function setRidePosture(id) {
  ridePose = RIDE_POSTURE[id] || bikeBody;
  rideMount = RIDE_MOUNT[id] || RIDE_MOUNT.bike;
  return id;
}

export const CLIPS = {

  /* ---------------- idle ----------------

     IDLE *IS* §1.6 POSE 1. It is not a neutral stance with a shift laid
     over it. This is the frame the game boots on and the frame it returns
     to every time the player stops, so it has to carry the character on
     its own: weight on one leg with the hip cocked, spine upright, head
     level and turned out toward the lens, trunk curled up and off to the
     side ending in a raised cocked tip, one arm relaxed.

     WHAT WAS ACTUALLY WRONG. The previous idle was diagnosed from a
     screenshot as a forward fold at the waist. It was not: measured on
     the live rig, hips/spine/chest resolved to 0.0 / 0.2 / -1.1 degrees
     and the head's world forward pitched +2.4 degrees UP, with the camera
     5 degrees BELOW it. The spine was already plumb. Three things were
     making an upright figure read as a slump at the gameplay framing:

       1  The trunk hung dead vertical down the centre line, 0.42 H of
          grey tube fused with the near arm and the belly into a single
          unbroken column from chin to knee. Nothing in that column has an
          edge, so the eye reads it as one drooping mass. This is by far
          the biggest of the three, and idle could not fix it, because the
          trunk is a spring chain that only accepts a clip HINT and
          `Animator.hints` ignored the locomotion layer entirely. See the
          `hints` getter.
       2  The ears hung collapsed and edge-on. §1.1's silhouette test is
          "ears + head-ball + pear body + four stubs", and at this camera
          the far ear was fully occluded by the cranium while the near one
          showed only its blank convex back. Take the ear span out of the
          silhouette and what is left is a ball on a sack.
       3  The face was 46 degrees off the lens with the head yawed a
          further +6.5 degrees AWAY on the wander, so the near lens was a
          foreshortened sliver.

     ORIENTATION IS NOT MIRROR-SYMMETRIC HERE, AND THAT MATTERS. The
     resting gameplay boom sits on his RIGHT (camera x -2.22 against a
     root yaw of 0, and +x is his left). The `cool` clip below solves the
     same pose for the STUDIO three-quarter preset, which sits on his
     LEFT — so its head yaw and its trunk side are both the mirror of what
     this camera wants, and copying them here would have swung the trunk
     down the view axis into exactly the foreshortened lump `cool`'s own
     comment warns about. Everything asymmetric below is signed for a
     camera on his right. The hip and leg work happens to agree with
     `cool` already; the head yaw and the trunk side do not. */
  idle: {
    /* `cycle` on a clip with no feet in motion looks like a mistake and is
       not. The locomotion blend interpolates cycle length between the two
       rungs it sits on, and idle used to have none — so the fallback,
       1.34 m, was what the phase integrator used across the whole
       stopping band. A blend that is half a standing pose was therefore
       ALSO being told the stride was 1.34 m, and the feet skated for it.
       Matching the rung above collapses that to a stride the half-weight
       pose can nearly cover. */
    duration: 8.4, loop: true, cycle: GAITS['walk-slow'].cycle,
    /* THE TRUNK HINT IS BACK, AND SAFELY. The long note that used to live
       here documented the orbit: the spring chain never settled, so any
       authored curl shipped a random frame of a half-metre tip orbit —
       three attempts parked the trunk across a lens. That solver defect
       is now fixed structurally in secondary.js (_convergeChains): at
       rest the chain is blended onto the sculpt and capped within ~3
       degrees, and the curl/side/tip accents are deterministic bone
       rotations applied on top. The orbit cannot happen, in any wind, so
       idle can finally BE §1.6 pose 1: trunk hanging down the sculpt's
       own S in front of the chest, tip — and only the tip — curled up
       and forward. `side` is +0.10 (his left): the resting gameplay boom
       sits on his RIGHT, and a drift toward the camera would foreshorten
       the tube down the view axis; a shade away keeps the S readable. */
    trunk: { curl: -0.03, side: 0.26, tip: -0.72, stiff: 520 },
    /* NO `ears` HINT EITHER, DELIBERATELY. The first attempt at this pose added
       one, on the theory that the ears were collapsing. They are not: the
       43 degrees on earL1 in the bone dump is the sculpt's own bind
       curvature, not a slumped spring. What the hint actually did was
       reveal that `perk` is a YAW of the ear plane about the skull and
       that NEGATIVE lays the ear BACK — the same sign the gait term uses
       at line ~303 to lay them back when he runs. At -0.15 the tip yawed
       26 degrees rearward, turned the fan edge-on to a three-quarter lens
       and rendered both ears as thin blades. §1.1's silhouette wants the
       broad face of the fan, which is what the bind pose already gives.
       Leave the ears to the springs and the wind. */
    fn(ph, w, s) {
      const t = ph * 8.4;
      armsRest(w);
      breathe(w, t, 1);

      /* ---- the stance, held ----
         Weight on his RIGHT leg — the near one at this camera. GENTLE
         contrapposto per the reference: the render is nearly plumb, so
         everything here is about half of what the last pass dialled —
         the -6.2 hip roll with a 5.8-degree knee-in read as a hard lean
         with a twisted pelvis at gameplay framing. */
      w.p('hips', -0.020, -0.010, 0);
      w.r('hips', 0, 3.0, -3.8);
      w.r('spine', 0, -1.6, 2.2);
      w.r('chest', 0, -2.2, 1.6);
      /* Head LEVEL and yawed NEGATIVE — toward the camera on his right.
         A small opposing z tilt keeps it casual rather than a turret
         lock. */
      w.r('head', -1.2, -7.0, -2.0);

      /* support leg straight and planted, free leg softened — but the
         knee stays OUT of the midline: inward knees were defect 10.
         ROUND 2: halved again, matching `cool` — stubby cylinders. */
      w.r('legR0', -0.5, 1.0, -1.6);
      w.r('legL0', 1.4, 1.4, 2.0);
      w.r('legL1', 4, 0, 0);
      w.r('footL', -3, 2.0, 0);
      w.r('footR', 0, 1.0, 0);

      /* the near arm keeps a deeper rest curve and drifts off the flank —
         it is the arm with the background behind it */
      w.r('armR0', -2.0, 0, -3.0);
      w.r('armR1', -3.0, 0, 2.0);

      /* ---- the shift, layered on ----
         The stance above is the base, so this no longer has to CREATE the
         contrapposto — it only has to keep it alive. `sh` therefore runs
         mostly on one side of zero: he settles from the strong stance to a
         squarer one and back, and never mirrors into the opposite stance,
         which would have thrown the trunk curl and the head turn onto the
         wrong side of the body twice a loop. Two settles per 8.4 s of
         unequal size and unequal timing, so it is not a metronome. */
      const sh = smoothstep(0.18, 0.35, ph) - smoothstep(0.44, 0.61, ph)
               + (smoothstep(0.65, 0.79, ph) - smoothstep(0.87, 0.99, ph)) * -0.88;
      const set = -0.42 * (sh * 0.5 + 0.5);   // 0 .. -0.42, never positive
      w.p('hips', 0.030 * set, -0.010 * Math.abs(set), 0);
      w.r('hips', 0, 3.0 * set, -5.0 * set);
      w.r('spine', 0, -1.5 * set, 3.0 * set);
      w.r('chest', 0, -2.0 * set, 2.6 * set);
      w.r('head', 0, 3.0 * set, -2.6 * set);
      w.r('legR0', 2.0 * set, 0, -2.4 * set);
      w.r('legL0', -2.0 * set, 0, -2.4 * set);
      w.r('legL1', 3.0 * Math.max(0, -set), 0, 0);
      /* the arms swing a little with the ribcage rather than staying
         pinned to the world — the tell that they are hanging, not fixed */
      w.r('armL0', 0, 0, 2.4 * set);
      w.r('armR0', 0, 0, 2.4 * set);

      /* an occasional slow head cast around the room, and a shoulder
         settle on a different period so nothing in him is ever still.
         The yaw wander is biased NEGATIVE so the cast never swings the
         face away from the lens — it looks past the camera and back, not
         over its own far shoulder. */
      w.r('head', 1.4 * sin(t * 0.37), -2.2 + 3.6 * sin(t * 0.23 + 1.1), 0.8 * sin(t * 0.19));
      w.r('chest', 0, 0, 0.7 * sin(t * 0.31 + 2.0));
      w.r('jaw', 0.6 * sin(t * 0.9), 0, 0);
    },
  },

  /* ---------------- locomotion ----------------
     Three sets of numbers, one solver. `cycle` is not typed in: it is
     whatever the authored ankle path covers in one stride, so the phase
     integrator and the feet cannot disagree. See GAITS above. */
  'walk-slow': {
    duration: 0.78, loop: true, loco: true, cycle: GAITS['walk-slow'].cycle,
    fn(ph, w, s) { gait(ph, w, s, GAITS['walk-slow']); breathe(w, ph * 1.7, 0.55); },
  },

  walk: {
    duration: 0.62, loop: true, loco: true, cycle: GAITS.walk.cycle,
    fn(ph, w, s) { gait(ph, w, s, GAITS.walk); breathe(w, ph * 2.2, 0.42); },
  },

  run: {
    duration: 0.42, loop: true, loco: true, cycle: GAITS.run.cycle,
    fn(ph, w, s) { gait(ph, w, s, GAITS.run); },
  },

  sprint: {
    duration: 0.34, loop: true, loco: true, cycle: GAITS.sprint.cycle,
    fn(ph, w, s) { gait(ph, w, s, GAITS.sprint); },
  },

  /* Turn in place — the feet shuffle, the shoulders lead. Signed by
     `s.turn`, so one clip covers both directions. */
  'turn-in-place': {
    duration: 0.9, loop: true,
    fn(ph, w, s) {
      const dir = clamp((s.turn || 0) * 1.6, -1, 1);
      const a = ph * TAU;
      armsRest(w, 4, 2);
      w.r('hips', 0, 9 * dir, 2.4 * dir);
      w.r('spine', 1.5, 5 * dir, 0);
      w.r('chest', 0, 6 * dir, 0);
      w.r('head', 0, 8 * dir, -2 * dir);
      w.p('hips', 0, 0.010 * cos(2 * a) - 0.006, 0);
      const lift = clamp(sin(a), 0, 1), lift2 = clamp(-sin(a), 0, 1);
      w.r('legL0', -10 * lift, 12 * dir * lift, 0);
      w.r('legL1', 18 * lift, 0, 0);
      w.r('legR0', -10 * lift2, 12 * dir * lift2, 0);
      w.r('legR1', 18 * lift2, 0, 0);
      w.r('armL0', 0, 0, 6 + 4 * dir);
      w.r('armR0', 0, 0, -6 + 4 * dir);
      breathe(w, ph * 2, 0.5);
    },
  },

  /* ---------------- jump ---------------- */
  'jump-takeoff': {
    duration: 0.26, loop: false,
    fn(ph, w) {
      const c = 1 - smoothstep(0, 1, ph);            // crouch releases
      const e = smoothstep(0.35, 1, ph);             // extension
      w.p('hips', 0, -0.085 * c + 0.030 * e, 0);
      w.r('legL0', 40 * c - 8 * e, 0, 0); w.r('legR0', 40 * c - 8 * e, 0, 0);
      w.r('legL1', 55 * c, 0, 0); w.r('legR1', 55 * c, 0, 0);
      w.r('footL', -40 * c + 26 * e, 0, 0); w.r('footR', -40 * c + 26 * e, 0, 0);
      w.r('spine', 14 * c - 4 * e, 0, 0);
      w.r('head', -6 * c - 8 * e, 0, 0);
      w.r('armL0', -60 * c - 40 * e, 0, 16); w.r('armR0', -60 * c - 40 * e, 0, -16);
      w.r('armL1', -20 * c, 0, -6); w.r('armR1', -20 * c, 0, 6);
    },
  },

  'jump-air': {
    duration: 0.9, loop: true,
    fn(ph, w, s) {
      const rise = clamp((s.vy || 0) / 5, -1, 1);
      w.p('hips', 0, 0.020, 0);
      w.r('legL0', -20 + 18 * rise, 0, 3); w.r('legR0', -20 + 18 * rise, 0, -3);
      w.r('legL1', 34 - 20 * rise, 0, 0); w.r('legR1', 26 - 20 * rise, 0, 0);
      w.r('footL', 16, 0, 0); w.r('footR', 12, 0, 0);
      w.r('spine', -3 + 6 * rise, 0, 0);
      w.r('chest', 2, 0, 0);
      w.r('head', -6 - 5 * rise, 0, 0);
      w.r('armL0', -48 - 26 * rise, 0, 26); w.r('armR0', -48 - 26 * rise, 0, -26);
      w.r('armL1', -14, 0, -10); w.r('armR1', -14, 0, 10);
      w.r('handL', 0, 0, -14); w.r('handR', 0, 0, 14);
    },
  },

  'jump-land': {
    duration: 0.42, loop: false,
    fn(ph, w) {
      const c = 1 - smoothstep(0, 0.85, ph);
      w.p('hips', 0, -0.105 * c, 0.012 * c);
      w.r('legL0', 46 * c, 0, 5 * c); w.r('legR0', 46 * c, 0, -5 * c);
      w.r('legL1', 62 * c, 0, 0); w.r('legR1', 62 * c, 0, 0);
      w.r('footL', -44 * c, 0, 0); w.r('footR', -44 * c, 0, 0);
      w.r('spine', 18 * c, 0, 0);
      w.r('chest', 6 * c, 0, 0);
      w.r('head', 8 * c, 0, 0);
      w.r('armL0', -34 * c, 0, 22 * c); w.r('armR0', -34 * c, 0, -22 * c);
      w.r('armL1', -26 * c, 0, -8); w.r('armR1', -26 * c, 0, 8);
      armsRest(w, 3 * (1 - c), 2 * (1 - c));
    },
  },

  /* ---------------- social ---------------- */
  talk: {
    duration: 3.1, loop: true,
    fn(ph, w, s) {
      const t = ph * 3.1;
      armsRest(w, 4.5, 4);
      breathe(w, t, 0.7);
      /* the jaw carries the syllables; the head and one hand carry the
         emphasis. No mouth is modelled, so the beat has to read from the
         body (§1.5). */
      const syl = Math.abs(sin(t * 6.1)) * (0.55 + 0.45 * sin(t * 1.7));
      w.r('jaw', 7 * syl, 0, 0);
      w.p('jaw', 0, -0.006 * syl, 0.004 * syl);
      w.r('head', -3 + 3.4 * sin(t * 2.1), 6 * sin(t * 0.83), 2.0 * sin(t * 1.3));
      w.r('chest', 0, 2.5 * sin(t * 0.83), 0);
      const g = smoothstep(0.30, 0.44, ph) - smoothstep(0.62, 0.80, ph);
      w.r('armR0', -34 * g, -10 * g, -18 * g);
      w.r('armR1', -26 * g, 0, 14 * g);
      w.r('handR', -10 * g, 0, 20 * g);
      w.r('armL0', -6 * g, 0, 4 * g);
    },
  },

  wave: {
    duration: 2.0, loop: false,
    fn(ph, w) {
      const up = smoothstep(0, 0.22, ph) - smoothstep(0.78, 1, ph);
      const flap = sin(ph * TAU * 3.2) * up;
      armsRest(w, 3, 2);
      w.r('armR0', -16 * up, -12 * up, -76 * up);
      w.r('armR1', -12 * up, 0, -62 * up + 16 * flap);
      w.r('handR', 0, 0, 22 * flap);
      w.r('chest', 0, -7 * up, -3 * up);
      w.r('head', -4 * up, -8 * up, 4 * up);
      w.r('spine', 0, 0, 2.5 * up);
      w.p('hips', -0.012 * up, 0, 0);
      w.r('armL0', 0, 0, 4 * up);
    },
  },

  cheer: {
    duration: 1.5, loop: true,
    fn(ph, w) {
      const a = ph * TAU;
      const b = Math.abs(sin(a));
      w.p('hips', 0, 0.055 * b - 0.010, 0);
      w.r('legL0', -8 * b, 0, 4); w.r('legR0', -8 * b, 0, -4);
      w.r('legL1', 14 * (1 - b), 0, 0); w.r('legR1', 14 * (1 - b), 0, 0);
      w.r('armL0', -20, 0, 84 - 8 * b); w.r('armR0', -20, 0, -84 + 8 * b);
      w.r('armL1', -6, 0, 68 - 8 * b); w.r('armR1', -6, 0, -68 + 8 * b);
      w.r('handL', 0, 0, 12); w.r('handR', 0, 0, -12);
      w.r('spine', -8 - 4 * b, 0, 0);
      w.r('chest', -6, 0, 0);
      w.r('head', -14 - 4 * b, 0, 0);
    },
  },

  think: {
    duration: 5.0, loop: true,
    fn(ph, w) {
      const t = ph * 5;
      breathe(w, t, 0.6);
      w.r('hips', 0, -3, -3.5);
      w.p('hips', -0.020, -0.006, 0);
      w.r('legL0', 0, 0, -2); w.r('legR0', 3, 0, -3);
      w.r('legR1', 8, 0, 0);
      /* right hand up under the trunk root */
      w.r('armR0', -58, -24, -34);
      w.r('armR1', -74, 0, 26);
      w.r('handR', -22, 0, 18);
      w.r('armL0', -4, 0, 5);
      w.r('armL1', -22, 0, -6);
      w.r('head', 5 + 1.5 * sin(t * 0.9), -9, 6);
      w.r('chest', 0, -4, 2);
      w.r('jaw', 2, 0, 0);
    },
  },

  tired: {
    duration: 4.4, loop: true,
    fn(ph, w) {
      const t = ph * 4.4;
      const b = sin(t * 0.85);
      w.r('spine', 13 + 2.5 * b, 0, 0);
      w.r('chest', 9 + 2.0 * b, 0, 0);
      w.r('head', 15 + 3.0 * b, 3 * sin(t * 0.4), 0);
      w.p('hips', 0, -0.030, 0.010);
      w.r('hips', -4, 0, 1.5 * sin(t * 0.5));
      w.r('legL0', 3, 0, 3); w.r('legR0', 2, 0, -3);
      w.r('legL1', 9, 0, 0); w.r('legR1', 7, 0, 0);
      w.r('armL0', 8, 0, 3); w.r('armR0', 8, 0, -3);
      w.r('armL1', -6, 0, -2); w.r('armR1', -6, 0, 2);
      w.r('jaw', 3 + 2 * b, 0, 0);
    },
  },

  sit: {
    duration: 6.0, loop: true,
    fn(ph, w) {
      const t = ph * 6;
      w.p('hips', 0, -0.300, -0.070);
      w.r('hips', -6, 0, 0);
      w.r('legL0', -84, 5, 4); w.r('legR0', -84, -5, -4);
      w.r('legL1', 88, 0, 0); w.r('legR1', 88, 0, 0);
      w.r('footL', -8, 0, 0); w.r('footR', -8, 0, 0);
      w.r('spine', 5, 0, 0);
      w.r('chest', 2, 0, 0);
      w.r('armL0', -18, 0, 13); w.r('armR0', -18, 0, -13);
      w.r('armL1', -16, 0, -8); w.r('armR1', -16, 0, 8);
      w.r('head', 2, 4 * sin(t * 0.31), 0);
      breathe(w, t, 0.8);
    },
  },

  'ride-bicycle': {
    duration: 1.0, loop: true, loco: true, cycle: 2.6,
    trunk: { curl: -0.04, side: 0.30, tip: -1.05, stiff: 300 },
    ears: { perk: -0.10, spread: 0.09 },
    fn(ph, w) { bikeBody(ph, w, 1.0); },
  },

  /* Rolling slowly, or stopped with the feet still on the pedals. The
     Animator freezes the pedal phase under ~0.15 m/s (see `update`), so
     the cranks and the feet stop together and stay where they stopped. */
  'bike-coast': {
    duration: 1.0, loop: true, loco: true, cycle: 2.6,
    trunk: { curl: -0.03, side: 0.28, tip: -0.92, stiff: 400 },
    ears: { perk: 0.02, spread: 0.02 },
    fn(ph, w) { bikeBody(ph, w, 0.0); },
  },

  /* Flat out: a deeper fold at the hip, the head down between the
     shoulders, twice the body rock and a bigger gear. */
  'bike-sprint': {
    duration: 1.0, loop: true, loco: true, cycle: 4.4,
    trunk: { curl: 0.10, side: 0.30, tip: -0.72, stiff: 210 },
    ears: { perk: -0.22, spread: 0.14 },
    fn(ph, w) { bikeBody(ph, w, 2.0); },
  },

  /* ---- the scooter ----
     Three rungs, same ladder shape as the bicycle's, but the SPEEDS are
     the machine's: it cruises where the bicycle sprints. Nothing here
     pedals, so `cycle` is only the road's contribution to the weave and
     is set long enough that the weave never strobes. */
  'scoot-idle': {
    duration: 1.0, loop: true, loco: true, cycle: 5.0,
    trunk: { curl: -0.02, side: 0.26, tip: -0.88, stiff: 420 },
    ears: { perk: 0.04, spread: 0.03 },
    fn(ph, w, s) { scootBody(ph, w, 0.0, 1, s); },
  },
  'ride-scooter': {
    duration: 1.0, loop: true, loco: true, cycle: 5.0,
    /* THE TRUNK IS THE SPEEDOMETER. There is no pedal cadence on a
       motor, so the one thing that tells the player he is going faster
       than a bicycle is the wind in the soft parts: the trunk streams
       further back and the ears flatten. §2.3 — the wind is the
       signature, and this is the character's share of it. */
    trunk: { curl: -0.02, side: 0.32, tip: -1.16, stiff: 260 },
    ears: { perk: -0.16, spread: 0.12 },
    fn(ph, w, s) { scootBody(ph, w, 1.0, 1, s); },
  },
  'scoot-fast': {
    duration: 1.0, loop: true, loco: true, cycle: 6.4,
    trunk: { curl: 0.06, side: 0.34, tip: -1.34, stiff: 200 },
    ears: { perk: -0.30, spread: 0.19 },
    fn(ph, w, s) { scootBody(ph, w, 2.0, 1, s); },
  },

  /* ---- the motorcycle ---- three times the bicycle, and the ears know
     it: at the top rung they are pinned nearly flat. */
  'moto-idle': {
    duration: 1.0, loop: true, loco: true, cycle: 6.0,
    trunk: { curl: 0.02, side: 0.24, tip: -0.96, stiff: 440 },
    ears: { perk: 0.02, spread: 0.04 },
    fn(ph, w, s) { motoBody(ph, w, 0.0, 1, s); },
  },
  'ride-moto': {
    duration: 1.0, loop: true, loco: true, cycle: 6.0,
    trunk: { curl: 0.10, side: 0.36, tip: -1.40, stiff: 210 },
    ears: { perk: -0.34, spread: 0.20 },
    fn(ph, w, s) { motoBody(ph, w, 1.0, 1, s); },
  },
  'moto-fast': {
    duration: 1.0, loop: true, loco: true, cycle: 8.0,
    trunk: { curl: 0.20, side: 0.36, tip: -1.62, stiff: 165 },
    ears: { perk: -0.52, spread: 0.28 },
    fn(ph, w, s) { motoBody(ph, w, 2.0, 1, s); },
  },

  /* ---- getting on ----
     Ends EXACTLY on the ride posture at effort 0, so the crossfade out
     of it has nothing left to travel. Reads as: dip, push, the right
     leg swings round behind the seat, the hands find the bars. Which
     posture and how far the leg swings are `ridePose` / `rideMount`,
     set by Animator.setRide() — see the block above them. */
  'bike-mount': {
    duration: 0.62, loop: false,
    trunk: { curl: 0.10, side: 0.16, tip: -0.30, stiff: 300 },
    fn(ph, w, s) {
      const M = rideMount;
      const dip = smoothstep(0, 0.24, ph) * (1 - smoothstep(0.22, 0.52, ph)) * M.dip;
      const rise = smoothstep(0.16, 0.86, ph);
      const swing = smoothstep(0.20, 0.74, ph);

      armsRest(w, 6.5 * (1 - rise), 5 * (1 - rise));
      ridePose(0.25, w, 0, rise, s);     // the destination pose, faded in

      /* the dip before the push */
      w.p('hips', 0, -0.085 * dip, 0);
      w.r('legL0', 26 * dip, 0, 0); w.r('legR0', 26 * dip, 0, 0);
      w.r('legL1', 38 * dip, 0, 0); w.r('legR1', 38 * dip, 0, 0);
      w.r('spine', 10 * dip, 0, 0);

      /* the right leg comes over the back of the saddle: an abduction
         (z) and a yaw (y) that both die as it lands on the far pedal */
      const over = sin(swing * Math.PI) * M.swing;
      w.r('legR0', -14 * over, -26 * over, -34 * over);
      w.r('legR1', 40 * over, 0, 0);
      w.r('hips', 0, -10 * over, -6 * over);
      w.r('spine', 0, 6 * over, 4 * over);

      /* the near hand is on the bar first, the far one arrives late */
      const late = smoothstep(0.34, 0.94, ph);
      w.r('armR0', 26 * (1 - late), 0, -18 * (1 - late));
      w.r('armR1', -18 * (1 - late), 0, 0);
      w.r('head', -8 * (1 - rise), 12 * over, 0);
      breathe(w, ph * 2.0, 0.4 * (1 - rise));
    },
  },

  /* ---- and off again ---- the mount run backwards, with the landing
     squashed into the last fifth so the step down reads as weight. */
  'bike-dismount': {
    duration: 0.54, loop: false,
    trunk: { curl: 0.02, side: 0.22, tip: -0.66, stiff: 420 },
    fn(ph, w, s) {
      const M = rideMount;
      const off = smoothstep(0.06, 0.62, ph);
      const land = smoothstep(0.52, 0.86, ph) * (1 - smoothstep(0.80, 1, ph)) * M.dip;

      armsRest(w, 6.5 * off, 5 * off);
      ridePose(0.25, w, 0, 1 - off, s);

      const over = sin(off * Math.PI) * M.swing;
      w.r('legR0', -10 * over, -30 * over, -30 * over);
      w.r('legR1', 44 * over, 0, 0);
      w.r('hips', 0, -12 * over, -5 * over);
      w.p('hips', 0, -0.070 * land, 0);
      w.r('legL0', 30 * land, 0, 0); w.r('legR0', 30 * land, 0, 0);
      w.r('legL1', 42 * land, 0, 0); w.r('legR1', 42 * land, 0, 0);
      w.r('spine', 12 * land, 0, 0);
      w.r('head', 6 * land, 10 * over, 0);
      breathe(w, ph * 2.0, 0.5 * off);
    },
  },

  /* ---------------- the two reference poses (§1.6) ---------------- */

  /* 1. Cool three-quarter: weight on one leg, one arm relaxed, trunk
        curled up and off to the side with a cocked tip. The trunk itself
        is a spring chain — the curl is set in secondary.js; what lives
        here is the body language that makes it read as confident. */
  cool: {
    duration: 6.5, loop: true, hold: true,
    /* THE TRUNK MATCHES ref/wally-ref-cool.png, NOT THE OLD PROSE. The
       reference render — which outranks every sentence written about it —
       hangs the trunk DOWN in front of the chest, gently S-curved, with
       the curl confined to the TIP: the last quarter turns up and forward,
       nostril up. The previous hint (curl -0.48, side -0.68) swept the
       whole tube sideways-and-up across the body; that was authored
       against the orbiting spring chain, which never actually delivered
       it — the shipped frames showed the trunk flung out horizontally,
       the worst likeness defect on the list. Now that secondary.js
       CONVERGES the chain to the sculpt at rest, the accents are
       deterministic: curl ~0 keeps the hang on the sculpt's own S,
       side -0.12 drifts it a shade to his right exactly as the render
       does, and tip -0.55 lifts only trunk3/trunk4 into the up-forward
       curl. (Negative tip = forward/up: R_x(t) maps a hang angle f to
       f - t, so negative t increases f toward +z.) */
    /* ROUND 2: tip -0.62 -> -0.88 — with the shorter trunk the up-curl
       needs a stronger accent to read as "nostril up" from the studio
       three-quarter, matching the reference's clear up-and-forward tip. */
    /* ROUND 4: side -0.30 -> -0.20 — the old swing parked the trunk over
       the viewer-left tusk in the studio three-quarter; the ref drifts
       only slightly left of centre and shows BOTH tusks in full. */
    /* ROUND 5: tip -1.00 -> -1.45. Measured on shots/ck-cool.png: the old
       total (1.42 rad over two bones) rotated the hang ~81 degrees — the
       tip finished HORIZONTAL, a blunt sausage end pointing screen-left
       (world +z projects viewer-left from the studio camera), which the
       critic correctly read as "no upward arc". The ref's last third arcs
       ~140 degrees off the hang so the nub finishes pointing UP with the
       nostril to camera. With the accents now spread over trunk2/3/4
       (1.67x, secondary.js) this lands 2.42 rad = 139 degrees. */
    /* ROUND 6: -1.45 -> -1.32 under the re-weighted accents (1.65x,
       tip-heavy). At -1.45 the nub crested at chin height and BURIED the
       far tusk's tip behind it in the studio three-quarter; the ref's nub
       tops out below the tusk line with both tusk tips clear. ~127
       degrees keeps an unambiguous up-arc, drops the crest ~35 mm, and
       turns the relocated end-nostril more toward the lens. */
    /* ROUND 7 — THE HANG COMES BACK TO THE CENTRE LINE. Measured on the
       normalised silhouette masks (both renders scaled to a common
       figure height and aligned on the leg axis): relative to the head's
       own centre the reference's nub sits at -0.144 H and ours sat at
       -0.167 H, and the DESCENDING tube — not just the curl — carried
       the difference, so the trunk read as hanging off his side instead
       of down his front. side -0.14 -> -0.06 keeps the shade of drift
       the render has without swinging the shaft. The curl still opens
       across the camera because `tip` is unchanged. */
    trunk: { curl: -0.03, side: -0.10, tip: -1.22, stiff: 520 },
    ears: { perk: -0.06, spread: 0.05 },
    fn(ph, w) {
      const t = ph * 6.5;
      breathe(w, t, 0.55);
      /* UPRIGHT GENTLE CONTRAPPOSTO — the reference is nearly plumb. The
         old pose (hips -7.5 roll, 6 yaw, twisted spine chain, knees in)
         read as a hard lean with a twisted pelvis; every number here is
         roughly half of it, and the head is LEVEL. */
      /* ROUND 3: calmer still — the critic reads any residual pelvis
         twist as "lean action figure". Nearly plumb, head level. */
      w.p('hips', -0.016, -0.008, 0);
      w.r('hips', 0, 2.5, -2.8);
      w.r('spine', -1.0, -1.4, 1.8);
      w.r('chest', 0, -2.0, 1.2);
      w.r('head', -1.0 + 0.6 * sin(t * 0.7), 5.0, -1.2);

      /* ROUND 2: halved again — the critic still read "long bandy bent
         legs... splayed at odd angles". Stubby straight cylinders bend
         barely at all in the reference. */
      w.r('legR0', -0.5, 1.0, -1.8);       // planted, straight
      w.r('legL0', 1.5, 1.5, 2.2);         // relaxed, knee barely soft
      w.r('legL1', 4, 0, 0);
      w.r('footL', -3, 2.0, 0);
      w.r('footR', 0, 1.0, 0);

      /* BOTH arms hang relaxed, mittens by the thighs — the reference has
         no hand-on-hip; the left just hangs a shade looser than the right */
      /* ROUND 4: abduction cut to ~3 degrees and MATCHED. The daylight is
         sculpted into the arm table now (rig.js round 4), so the old 11
         degree swing threw the near arm wide while the far arm foreshortened
         into a stub — the shot's "one stub, one flipper" asymmetry. */
      /* ROUND 7 (likeness pass 4): EXACT MIRROR. The critic measured the
         two arms differing in pose, apparent length and hand shape; the
         residual 1-degree offsets ("a shade looser") bought nothing and
         cost symmetry, so the right is now the left's mirror to the digit,
         breathing included. The ref's arms are identical twins. */
      w.r('armL0', -2 + 0.9 * sin(t * 0.6), 0, 3);
      w.r('armL1', -4, 0, -2);
      w.r('handL', 2, 0, -2);
      w.r('armR0', -2 + 0.9 * sin(t * 0.6), 0, -3);
      w.r('armR1', -4, 0, 2);
      w.r('handR', 2, 0, 2);
      w.r('jaw', 1.5, 0, 0);
    },
  },

  /* 2. Welcome: square on, both arms open wide and low, palms forward
        and up, trunk hanging straight between the tusks. */
  welcome: {
    duration: 5.6, loop: true, hold: true,
    /* ROUND 3: tip -0.06 -> -0.62. The critic's pixel comparison:
       "welcome pose: trunk hangs dead straight with a rounded blunt end
       and no up-curl... trunk tip curls up in EVERY pose" — the canon
       up-curl outranks the old §1.6 prose about a straight hang. */
    /* ROUND 5: -1.10 -> -0.93. The accent gain rose 1.42x -> 1.67x when
       the tip spread over three bones (secondary.js); -0.93 keeps the
       TOTAL curl at the approved ~89 degrees while trunk3's single-joint
       bend drops 0.46 -> 0.39 rad — that joint's skin fold was the
       critic's "residual crease two-thirds down the hanging trunk". */
    trunk: { curl: 0.0, side: 0, tip: -0.86, stiff: 380 },
    ears: { perk: -0.16, spread: 0.13 },
    fn(ph, w) {
      const t = ph * 5.6;
      breathe(w, t, 0.85);
      w.p('hips', 0, 0.004, 0);
      /* The chest opens, the HEAD does not follow it back. At a net -10
         degrees of head pitch the cranium rolled far enough that the brow
         bar climbed onto the crown and the forehead swallowed the frame —
         from a level camera a big ball tipped back reads as a bald dome
         with the glasses sliding off it. The openness is carried by the
         spine and the shoulders instead. */
      /* BODY PASS: SPINE UPRIGHT. -1.2/-1.0 was a backward lean bought to
         fake "openness" when the shoulders could not supply it; with the
         flank now weighted to the torso (rig.js spine capture) the arms
         carry the pose and the spine can stand plumb, which is what §1.6
         pose 2 and the reference both show. */
      w.r('spine', 0, 0, 0);
      w.r('chest', 0.4, 0, 0);
      w.r('head', 3.0 + 0.7 * sin(t * 0.8), 0, 0);

      /* Open wide and LOW. The shoulder stays under 30 degrees on
         purpose — the arm is fused to the flank in the sculpt, so a big
         shoulder rotation webs the armpit. The width comes from the
         forearm, which is clear of the torso. */
      /* ROUND 3: opened 22 -> 30 — with the arms now sculpted against
         the fatter pear, 22 left the mittens ON the hips and the pose
         read arms-akimbo instead of open-wide-and-low. */
      /* ROUND 4 — OPEN WIDE AND LOW, ACTUALLY. The old 26-degree swing
         left the mittens hovering AT the hips and the pose shipped as
         arms-akimbo — the clip was wrong, not just the sculpt. With the
         arm now sculpted clear of the flank (rig.js round 4) the shoulder
         can open properly: ~48 degrees of total abduction, elbow nearly
         straight, which parks the mittens wide of the thighs and low.
         The y twists supinate ~85 degrees spread over all three joints so
         no single blend candy-wraps; the digits fan front-to-back in the
         sculpt (palms facing the thighs), so this twist is also what
         turns the four-digit fan toward the lens — §1.6 pose 2 "palms
         forward (digits visible)". */
      /* ROUND 5: abduction moved from the shoulder to the ELBOW. At 40
         degrees of armL0 the capture volume dragged the flank skin out
         with it and the silhouette tented into a bat-wing web from armpit
         to elbow. The shoulder now opens only 12 degrees (under the web
         threshold); the elbow, which owns no torso skin, carries 32. */
      /* ROUND 7 (likeness pass 4): OPEN WIDE, PALMS TO THE LENS, WRISTS
         STRAIGHT. The shipped round-5 frame measured arms nearly vertical
         with the wrists drooped — the critic's "zombie droop". Two causes:
         (a) euler order XYZ applies the y twist AFTER the z swing, so the
         -30 shoulder twist rotated a third of the abduction into fore-aft
         carry; (b) the -14 wrist pitch tipped the knuckles forward. The
         twist is now carried low (elbow+wrist), the shoulder swings only
         10 — VERIFIED ON PIXELS: at 20 the capture volume tented the
         flank into a full bat-wing web from armpit to elbow, exactly as
         the round-5 note warned — the elbow adds 30 more for ~40 degrees
         of visible abduction, on the critic's 35-45 band, and the wrist
         pitch is ZERO with the remaining supination at the hand, so the
         mitten's palm faces the camera. */
      /* A touch of forward reach: drags the same saddle skin FORWARD,
         which the square-on lens cannot see, and reads as offering. */
      /* BODY PASS — THE SHOULDER CAN FINALLY OPEN, BECAUSE THE ARMPIT NO
         LONGER OWNS THE FLANK. Every round from 3 to 7 above is one
         argument: the pose wants 35-45 degrees of abduction and the
         shoulder was capped at 10-12 because anything more tented the
         pear into a bat wing. That was never a clip problem. The cap was
         paying for a WEIGHT defect — 147 flank vertices resolving to
         armL1 with no torso share — and rig.js's spine capture now wins
         them back, verified on the weight paint and on the silhouette.
         26 at the shoulder + 16 at the elbow = 42 degrees of visible
         abduction, on the brief's 35-45 band and mid-way through it.
         That parks the mitten 0.58 m off the midline at y 0.65 — clear
         of the hip, unmistakably away from the body, and still LOW:
         hands at 0.40 H, well under the belly's widest row. */
      w.r('armL0', -8, -8, 26 + 1.2 * sin(t * 0.9));
      w.r('armR0', -8, 8, -26 - 1.2 * sin(t * 0.9));
      /* THE FOREARM TWIST HAS TO STAY UNDER ~25 DEGREES per ARM joint.
         The arm is a 0.088 -> 0.037 sausage fused into the flank; deep
         single-joint rolls fold the skin flat. ~86 degrees of total
         supination is spread 8/24/54: the HAND carries the largest share
         because the mitten is one rigid blob on one bone — there is no
         stretch of arm skin between wrist and digits left to wrap. */
      /* Elbow lateral capped at 20: at 30 the arm-flank fillet skin
         (armL1-won saddle, unavoidable at TAU 55 mm) tented into a
         pointed fin off the slot bottom — seen on pixels twice. The
         last stretch of width comes from a gentle wrist flare instead:
         the mitten is one rigid blob, so its flare drags nothing. */
      /* 14, NOT MORE: even with the saddle travelling pure-arm, 22 of
         elbow swing re-draped the underarm (Laplacian taper is ~65 mm);
         14 is the measured ceiling where the slot stays clean. */
      w.r('armL1', -6, -26, 16);
      w.r('armR1', -6, 26, -16);
      /* Palms to the lens, wrists straight in pitch — no droop. The
         supination total is unchanged at ~86 degrees (8 shoulder / 26
         elbow / 52 hand); it just sits lower down the chain now that the
         shoulder is spending its budget on abduction. The mitten is one
         rigid blob on one bone, so the hand's share wraps no skin. */
      w.r('handL', 0, -52, 8);
      w.r('handR', 0, 52, -8);

      /* ROUND 2: splay halved — the welcome shot showed "feet splayed at
         odd angles" */
      w.r('legL0', 0, 1.5, 2.0); w.r('legR0', 0, -1.5, -2.0);
      w.r('footL', 0, 2, 0); w.r('footR', 0, -2, 0);
      w.r('jaw', 2.0, 0, 0);
    },
  },
};

/* Aliases so callers can use either spelling. */
CLIPS.turn = CLIPS['turn-in-place'];
CLIPS.jump = CLIPS['jump-takeoff'];
CLIPS.air = CLIPS['jump-air'];
CLIPS.land = CLIPS['jump-land'];
CLIPS.bike = CLIPS['ride-bicycle'];
CLIPS.ride = CLIPS['ride-bicycle'];

export const CLIP_NAMES = Object.keys(CLIPS);

/* ==================================================================
   The state machine
   ================================================================== */

/* THE RUNGS SIT ON THE CONTROLLER'S OWN SPEEDS, not near them. His walk
   is 2.45 m/s and his run 5.90 (wally.js), and a rung two tenths off
   either means the game's most-seen states are permanently a few per
   cent of something else — a walk with a trace of run in the pelvis, a
   run with a trace of walk in the stride. `walk-slow` covers the band a
   touch stick can hold; see the note on its gait config. */
const LOCO_STEPS = [
  { name: 'idle', speed: 0.00 },
  { name: 'walk-slow', speed: 0.80 },
  { name: 'walk', speed: 2.45 },
  { name: 'run', speed: 5.90 },
  { name: 'sprint', speed: 7.90 },
];

/* THE BICYCLE IS A SECOND LOCOMOTION LADDER, NOT A CLIP.

   The obvious implementation — play 'ride-bicycle' as an action clip —
   is what the intro does, and it is why the intro has to cut away
   rather than let him stop: an action clip is a single pose curve with
   no speed in it, so a rider slowing to a halt keeps pedalling at the
   same rate and a rider accelerating never changes shape. It also
   cannot blend with `walk`, because the action layer REPLACES the
   locomotion layer instead of mixing with it.

   So the bike gets its own ladder, resolved exactly the way the foot
   ladder is (same distance-driven phase, same interpolated cycle
   length), and `bikeW` crossfades between the two ladders. That single
   number is what makes mounting a blend rather than a cut: at bikeW 0.5
   he is genuinely half-walking and half-pedalling, at any speed, and
   the mount/dismount clips ride the action layer over the top of it to
   carry the arc. Nothing in the foot ladder changed. */
const BIKE_STEPS = [
  { name: 'bike-coast', speed: 0.00 },
  { name: 'ride-bicycle', speed: 3.40 },
  { name: 'bike-sprint', speed: 8.20 },
];

/* ONE LADDER PER MACHINE, AND THE RUNGS ARE AT THAT MACHINE'S SPEEDS.
   This is the whole reason a scooter cannot be the bicycle with a
   different prop under it: at 7 m/s the bicycle ladder is deep into
   'bike-sprint' — head down, twice the rock, a man working — and the
   scooter is barely past its own cruise, because 7 m/s is what a
   scooter DOES. Rungs sit at 0 / cruise / flat-out for each, and the
   data agent's speed multipliers (1 / 1.5 / 3) are what put them
   there. */
const SCOOT_STEPS = [
  { name: 'scoot-idle', speed: 0.00 },
  { name: 'ride-scooter', speed: 4.60 },
  { name: 'scoot-fast', speed: 12.60 },
];
const MOTO_STEPS = [
  { name: 'moto-idle', speed: 0.00 },
  { name: 'ride-moto', speed: 8.00 },
  { name: 'moto-fast', speed: 22.00 },
];
export const RIDE_STEPS = {
  bike: BIKE_STEPS, scooter: SCOOT_STEPS, motorcycle: MOTO_STEPS,
};

export class Animator {
  constructor() {
    this.out = makePose();
    this._loA = makePose();
    this._loB = makePose();
    this._loco = makePose();
    this._bike = makePose();
    this._act = makePose();
    this._actP = makePose();
    this._w = new Writer();

    /* 0 = on foot, 1 = on the bicycle. Damped, never assigned. */
    this.bikeW = 0;
    this.bikeTarget = 0;
    this.bikeRate = 1 / 0.34;
    this._bkA = CLIPS['bike-coast']; this._bkB = CLIPS['bike-coast']; this._bkF = 0;
    /* which machine's ladder the bike layer resolves on */
    this.rideId = 'bike';
    this.rideSteps = BIKE_STEPS;

    this.locPhase = 0;
    this.locoCycle = 1;
    this.speed = 0;
    this.turn = 0;
    /* debug: pin the gait phase so a screenshot strip can walk the cycle
       frame by frame instead of hoping --wait lands somewhere useful */
    this.phaseLock = null;
    /* how planted each foot is, 0..1, published for secondary.js's
       terrain conform — see the note on _footIK */
    this.plant = [1, 1];
    this.state = { speed: 0, gait: 0, turn: 0, grounded: true, vy: 0, airTime: 0, elapsed: 0 };

    /* action layer */
    this.action = null;         // { clip, name, time, loop, hold }
    this.actionW = 0;
    this.actionTarget = 0;
    this.fadeRate = 5;
    this.onFinish = null;
    this.locoName = 'idle';
    /* THE OUTGOING ACTION CLIP — see `play`. One slot, not a stack:
       two crossfades in flight at once is a third pose nobody authored,
       and a clip swapped again mid-fade should land on what is on
       screen, which is what `out` already holds. */
    this.prev = null;           // { clip, name, time, loop, hold, speed }
    this.prevW = 0;
    this.prevRate = 1 / 0.22;

    /* the locomotion pair and blend factor the last update resolved, so
       `hints` can weight the locomotion layer's declared trunk/ear intent */
    this._hintA = CLIPS.idle; this._hintB = CLIPS.idle; this._hintF = 0;
  }

  /**
   * Start a clip on the action layer.
   *
   * ------------------------------------------------------------------
   * `fade` FADES THE LAYER. IT ALSO NOW FADES BETWEEN TWO CLIPS ON IT.
   * ------------------------------------------------------------------
   * `actionW` is the weight of the action layer AGAINST the locomotion
   * layer, and until this block existed it was the only weight there
   * was: swapping `this.action` while the layer was already up
   * SUBSTITUTED one pose curve for another on the next frame, whatever
   * `fade` said, because `fade` was only ever the rate actionW damps at
   * and actionW was already 1.
   *
   * MEASURED, on the shipped opener, sampling every bone of both arms
   * every frame through the watched intro (max per-joint change between
   * two consecutive frames, degrees):
   *
   *     t=26.689  ride-bicycle -> cool     42.37 deg in one frame
   *     t=31.672  cool -> welcome          52.00 deg in one frame
   *
   * The first is behind the SEQ C -> D camera cut and is meant to be a
   * cut. The SECOND IS NOT BEHIND ANYTHING: the hero camera is holding
   * on him, the title card has been up for half a second, and
   * `pose('welcome', { fade: 0.55 })` asked for a 0.55 s open and got a
   * one-frame snap of both arms through 52 degrees. Every caller of
   * play()/pose() that passes a fade was buying the same nothing.
   *
   * So the outgoing clip is KEPT, at its own weight, and the action
   * layer resolves as a blend of the two before it is blended against
   * locomotion. The rate is the incoming clip's `fade`, so every
   * existing call site now gets the fade it always asked for.
   *
   * A CUT IS STILL A CUT. `instant: true`, or a fade at or under one
   * frame, drops the outgoing clip outright — intro.js's C -> D
   * dismount is `{ fade: 0.001, instant: true }` and is SUPPOSED to
   * substitute, because the camera cuts on the same frame. Blending
   * across that would be five frames of a man melting off a bicycle.
   */
  play(name, opts = {}) {
    const clip = CLIPS[name];
    if (!clip) { console.warn(`[wally] no clip "${name}"`); return this; }
    const fade = opts.fade ?? 0.22;
    if (this.action && this.action.name === name && opts.restart !== true) {
      this.actionTarget = 1;
      this.fadeRate = 1 / Math.max(fade, 0.016);
      return this;
    }
    const cut = !!opts.instant || fade <= 0.016;
    if (!cut && this.action && this.actionW > 0.004) {
      /* Swapped again mid-fade: the outgoing source is what is ON
         SCREEN, which is already the blend in `_act`, so the slot is
         reused rather than stacked. Its `time` keeps running so a
         looping clip does not restart under the blend. */
      this.prev = this.action;
      this.prevW = 1;
      this.prevRate = 1 / Math.max(fade, 0.016);
    } else {
      this.prev = null;
      this.prevW = 0;
    }
    this.action = {
      clip, name, time: 0,
      loop: opts.loop ?? clip.loop ?? false,
      hold: opts.hold ?? clip.hold ?? false,
      speed: opts.speed ?? 1,
    };
    this.actionTarget = 1;
    this.fadeRate = 1 / Math.max(fade, 0.016);
    if (opts.instant) this.actionW = 1;
    return this;
  }

  /**
   * Crossfade the locomotion layer between the foot ladder and the
   * bicycle ladder. `fade` in seconds; 0 snaps.
   */
  setBike(on, fade = 0.34) {
    this.bikeTarget = on ? 1 : 0;
    this.bikeRate = 1 / Math.max(fade, 0.016);
    if (fade <= 0.016) this.bikeW = this.bikeTarget;
    return this;
  }

  /**
   * Which machine the bike layer is a layer for.
   *
   * IT IS SAFE TO CALL MID-BLEND and that is deliberate: a player who
   * equips the motorcycle while riding the scooter would otherwise
   * watch the scooter posture play out under a motorcycle. Swapping the
   * ladder swaps the pose the very next frame; wally.js separately
   * swaps the prop over a short dismount/mount, so what the eye gets is
   * one machine leaving and another arriving, never two at once.
   *
   * @param {'bike'|'scooter'|'motorcycle'} id
   */
  setRide(id) {
    const steps = RIDE_STEPS[id];
    if (!steps) return this;
    this.rideId = id;
    this.rideSteps = steps;
    setRidePosture(id);
    return this;
  }

  /** Crank angle in radians, for the prop under his feet. See bike.js.
      Meaningless on a machine with no cranks; the motorised props drive
      their wheels off distance instead (rides.js `update`). */
  get bikePhase() { return this.locPhase * TAU; }

  /** Return to the locomotion layer. */
  stop(fade = 0.28) {
    this.actionTarget = 0;
    this.fadeRate = 1 / Math.max(fade, 0.016);
    return this;
  }

  get current() { return this.actionW > 0.5 && this.action ? this.action.name : this.locoName; }
  get actionName() { return this.action ? this.action.name : null; }
  /** Clip-declared secondary hints (trunk curl, ear perk) at current weight.
   *
   * THE LOCOMOTION LAYER GETS A VOTE, NOT JUST THE ACTION LAYER. `idle` is
   * the pose the game spends most of its running time in and §1.6 pose 1
   * is mostly a TRUNK pose — a curl up and off to the side ending in a
   * cocked tip — and the trunk is a spring chain, so the only way a clip
   * can ask for it is through this hint. While `hints` only looked at
   * `this.action`, idle could not: it is on the locomotion layer, so it
   * returned null and the trunk hung dead straight down the front of the
   * body, fusing with the near arm into one grey column. That column is
   * the thing that reads as a slump.
   *
   * Every contributing clip is weighted by how much of the frame it owns
   * (loco A, loco B, action). A clip that declares nothing contributes no
   * weight rather than contributing zeroes, so an expression still shows
   * through underneath, and `walk` — which declares nothing — dissolves
   * the idle curl smoothly as the blend crosses into it instead of
   * snapping it off. secondary.js damps all five fields on top of that. */
  get hints() {
    let cw = 0, ew = 0;
    let curl = 0, side = 0, tip = 0, stiff = 0, perk = 0, spread = 0;
    const take = (c, wgt) => {
      if (!c || wgt <= 1e-4) return;
      if (c.trunk) {
        curl += (c.trunk.curl ?? 0) * wgt; side += (c.trunk.side ?? 0) * wgt;
        tip += (c.trunk.tip ?? 0) * wgt; stiff += (c.trunk.stiff ?? 330) * wgt;
        cw += wgt;
      }
      if (c.ears) {
        perk += (c.ears.perk ?? 0) * wgt; spread += (c.ears.spread ?? 0) * wgt;
        ew += wgt;
      }
    };
    const aw = this.action ? this.actionW : 0;
    const lw = 1 - aw;
    /* the locomotion layer's share is itself split between the two
       ladders, so a half-mounted Wally gets half a bike trunk */
    const fw = lw * (1 - this.bikeW), bw = lw * this.bikeW;
    take(this._hintA, fw * (1 - this._hintF));
    take(this._hintB, fw * this._hintF);
    take(this._bkA, bw * (1 - this._bkF));
    take(this._bkB, bw * this._bkF);
    /* The action layer's share is split between the incoming clip and
       the outgoing one on exactly the weight `update` blends their
       POSES on — otherwise the trunk curl and the ear set snap on the
       frame the clip is swapped while the arms fade over half a second,
       and the two halves of one gesture arrive at different times. */
    if (this.action) {
      const pw = this.prev ? smoothstep(0, 1, this.prevW) : 0;
      take(this.action.clip, aw * (1 - pw));
      if (this.prev) take(this.prev.clip, aw * pw);
    }
    if (cw <= 1e-4 && ew <= 1e-4) return null;
    /* Each group is normalised by its OWN accumulated weight and carries
       its OWN blend weight, because trunk cover and ear cover come apart
       the moment one clip in the blend declares only one of them. */
    return {
      trunk: cw > 1e-4
        ? { curl: curl / cw, side: side / cw, tip: tip / cw, stiff: stiff / cw }
        : null,
      ears: ew > 1e-4 ? { perk: perk / ew, spread: spread / ew } : null,
      w: Math.max(cw, ew),
      wTrunk: cw,
      wEars: ew,
    };
  }

  setLocomotion(speed, turn) {
    this.speed = Math.max(0, speed || 0);
    this.turn = turn || 0;
    return this;
  }

  /** Debug only: pin the gait phase. null releases it. */
  setPhaseLock(p) {
    this.phaseLock = (p == null) ? null : p - Math.floor(p);
    return this;
  }

  /** Evaluate one clip into `pose`. */
  _eval(clip, ph, pose, s) {
    clearPose(pose);
    this._w.bind(pose);
    clip.fn(ph, this._w, s);
  }

  update(dt, s) {
    const st = this.state;
    st.speed = this.speed;
    st.turn = this.turn;
    st.grounded = s?.grounded ?? true;
    st.vy = s?.vy ?? 0;
    st.airTime = s?.airTime ?? 0;
    st.elapsed = (st.elapsed || 0) + dt;
    st.gait = clamp(this.speed / 6.4, 0, 1);

    /* ---- locomotion blend, driven by distance ---- */
    let i = 0;
    while (i < LOCO_STEPS.length - 2 && this.speed > LOCO_STEPS[i + 1].speed) i++;
    const A = LOCO_STEPS[i], B = LOCO_STEPS[i + 1];
    const f = clamp((this.speed - A.speed) / Math.max(B.speed - A.speed, 1e-3), 0, 1);
    const ca = CLIPS[A.name], cb = CLIPS[B.name];
    this.locoName = f > 0.5 ? B.name : A.name;
    /* remembered for `hints` — the locomotion layer declares trunk and ear
       intent too, and it has to be weighted by this same blend */
    this._hintA = ca; this._hintB = cb; this._hintF = f;

    /* ---- the bicycle ladder, resolved the same way ---- */
    this.bikeW = damp(this.bikeW, this.bikeTarget, this.bikeRate, dt);
    if (this.bikeTarget === 0 && this.bikeW < 0.003) this.bikeW = 0;
    else if (this.bikeTarget === 1 && this.bikeW > 0.997) this.bikeW = 1;
    const riding = this.bikeW > 0.5;
    const STEPS = this.rideSteps || BIKE_STEPS;
    let j = 0;
    while (j < STEPS.length - 2 && this.speed > STEPS[j + 1].speed) j++;
    const KA = STEPS[j], KB = STEPS[j + 1];
    const bf = clamp((this.speed - KA.speed) / Math.max(KB.speed - KA.speed, 1e-3), 0, 1);
    const ka = CLIPS[KA.name], kb = CLIPS[KB.name];
    this._bkA = ka; this._bkB = kb; this._bkF = bf;
    if (riding) this.locoName = bf > 0.5 ? KB.name : KA.name;

    /* One shared phase for the whole blend so the feet of the walk and the
       feet of the run land together. Cycle length is interpolated, so the
       stride grows with speed instead of the legs spinning faster. */
    const cycle = riding
      ? (ka.cycle ?? 2.6) * (1 - bf) + (kb.cycle ?? 2.6) * bf
      : (ca.cycle ?? 1.34) * (1 - f) + (cb.cycle ?? 2.16) * f;
    this.locoCycle = cycle;
    if (this.speed > 0.10) {
      this.locPhase += (this.speed * dt) / Math.max(cycle, 0.2);
    } else if (!riding) {
      this.locPhase += dt / (ca.duration || 1);
    }
    /* ...and NOT while riding: a stopped bicycle has stopped pedals.
       The `else if` above is the whole of that rule. Feet, cranks and
       chainring all halt on the same frame and hold where they halted,
       which is what makes a track stand read as one. */
    this.locPhase -= Math.floor(this.locPhase);
    if (this.phaseLock != null) this.locPhase = this.phaseLock;

    /* Which feet are down, for the terrain conform in secondary.js. The
       gait is authored so the planted foot does not slide; the conform
       must therefore be allowed to press on the planted foot only, or it
       flattens the swing foot on to the ground it is passing over and
       the lift, the heel strike and the toe-off all vanish. */
    {
      const beta = riding ? 1 : gaitBeta(this.speed);
      const e = 0.05;
      const pl = this.locPhase, pr = (pl + 0.5) % 1;
      const down = (p) => smoothstep(-e, e, p) * (1 - smoothstep(beta - e, beta + e, p));
      this.plant[0] = riding ? 1 : down(pl);
      this.plant[1] = riding ? 1 : down(pr);
    }

    const phA = ca.loco ? this.locPhase : (st.elapsed / ca.duration) % 1;
    const phB = cb.loco ? this.locPhase : (st.elapsed / cb.duration) % 1;
    this._eval(ca, phA, this._loA, st);
    this._eval(cb, phB, this._loB, st);
    blendPose(this._loco, this._loA, this._loB, f);

    /* the bicycle ladder over the top of the foot ladder */
    if (this.bikeW > 0.001) {
      const phKA = this.locPhase;
      this._eval(ka, phKA, this._loA, st);
      this._eval(kb, phKA, this._loB, st);
      blendPose(this._bike, this._loA, this._loB, bf);
      blendPose(this._loco, this._loco, this._bike, this.bikeW);
    }

    /* turn-in-place blends in when he is pivoting on the spot.
       Never on the bicycle: a bicycle does not pivot, and the shuffle
       would be two feet stepping through the frame with no floor. */
    const spin = (1 - this.bikeW)
      * clamp((Math.abs(this.turn) - 0.6) / 1.8, 0, 1) * (1 - clamp(this.speed / 1.2, 0, 1));
    if (spin > 0.001) {
      this._eval(CLIPS['turn-in-place'], (st.elapsed / 0.9) % 1, this._loA, st);
      blendPose(this._loco, this._loco, this._loA, spin);
    }

    /* ---- action layer ---- */
    const a = this.action;
    if (a) {
      a.time += dt * a.speed;
      const dur = a.clip.duration || 1;
      if (!a.loop && !a.hold && a.time >= dur) {
        if (this.actionTarget === 1) {
          this.actionTarget = 0;
          this.fadeRate = 1 / 0.26;
          const cb2 = this.onFinish;
          if (cb2) cb2(a.name);
        }
      }
      const ph = a.hold ? (a.time / dur) % 1
        : a.loop ? (a.time / dur) % 1
          : clamp(a.time / dur, 0, 1);
      this._eval(a.clip, ph, this._act, st);

      /* ---- the OUTGOING action clip, blended under the incoming one.
         See `play`. It is advanced as well as evaluated: a looping clip
         frozen on its swap frame would stop breathing halfway through
         its own fade, which the eye reads as the pose "sticking" before
         it moves. */
      const p = this.prev;
      if (p) {
        this.prevW = damp(this.prevW, 0, this.prevRate, dt);
        if (this.prevW < 0.004) { this.prevW = 0; this.prev = null; }
        else {
          p.time += dt * p.speed;
          const pdur = p.clip.duration || 1;
          const pph = (p.hold || p.loop) ? (p.time / pdur) % 1
            : clamp(p.time / pdur, 0, 1);
          this._eval(p.clip, pph, this._actP, st);
          /* smoothstep on the OUTGOING weight, so the pair joins with
             zero velocity at both ends exactly the way the layer blend
             below does. */
          blendPose(this._act, this._act, this._actP, smoothstep(0, 1, this.prevW));
        }
      }
    }

    this.actionW = damp(this.actionW, this.actionTarget, this.fadeRate, dt);
    if (this.actionTarget === 0 && this.actionW < 0.004) {
      this.actionW = 0; this.action = null;
      /* the layer is gone; the thing that was fading INSIDE it goes
         with it, or the next play() blends out of a clip that has not
         been on screen since */
      this.prev = null; this.prevW = 0;
    }

    const w = smoothstep(0, 1, this.actionW);
    if (a && w > 0) blendPose(this.out, this._loco, this._act, w);
    else copyPose(this.out, this._loco);

    return this.out;
  }

  /** Additive layers write straight into the resolved pose. */
  add(pose, weight = 1) { addPose(this.out, pose, weight); return this; }
}

export default { Animator, CLIPS, CLIP_NAMES, makePose };
