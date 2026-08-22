/* ============================================================
   crowd.js — what makes a human a person: motion, and somewhere to go.

   Two things live here.

   1. HumanAnim — a procedural animator for the 17-bone rig in
      humans.js. No clip data: every pose is a function of time, of the
      controller's speed and turn rate, and of a per-person phase offset
      drawn from the seeded rng. Clips would be dead weight for a crowd
      this size and, worse, they would make fifty people move in lockstep
      — the phase offset is the entire reason a market square reads as a
      crowd rather than as a chorus line.

      Modes blend by *weight*, not by damping the output. Damping a walk
      cycle toward a target eats its amplitude the moment the frequency
      rises; damping the weight between an idle pose and a walk pose
      keeps both cycles at full amplitude and crossfades cleanly.

   2. createCrowd — the ambient population. Agents walk the real road
      network from src/world/paths.js (the same relaxed, terrain-carved
      polylines the ribbons are drawn on, so nobody walks through a
      hedge), steer around each other and around Wally, stop at
      locations that are open according to ctx.game, and thin out at
      night. Density comes from ctx.quality.particles.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { clamp, damp, lerp } from '../core/contracts.js';
import { BONE_INDEX } from './humans.js';

/* ==================================================================
   1. The animator
   ================================================================== */

const B = BONE_INDEX;
const NB = 17;

/* Rest offsets, applied before anything else. The arms hang 5 mm off
   the flank in bind pose, which is a hair's breadth on a shared skin
   and reads as fused; a permanent 0.10 rad of shoulder abduction opens
   24 mm at the elbow and gives the silhouette its daylight. */
const REST = new Float32Array(NB * 3);
/* THE ABDUCTION IS IN THE BIND POSE NOW. 0.20 rad of live shoulder here
   opened daylight at the elbow, but it opened it by *stretching* a mesh
   whose upper arm was welded into the flank — which is precisely how a
   figure ends up wearing a poncho. humans.js bakes ARM_ABDUCT (0.17)
   into every station below the shoulder, so the arm is already clear
   before a single vertex is skinned; what is left here is the last
   0.03 rad, live, so the shoulder still has somewhere to go. */
REST[B.armL0 * 3 + 2] = 0.030;
REST[B.armR0 * 3 + 2] = -0.030;
REST[B.armL0 * 3 + 0] = -0.06;
REST[B.armR0 * 3 + 0] = -0.06;
/* A resting elbow is nearly straight. -0.20 rad here plus the walk
   cycle's own -0.44 put both forearms 37 degrees forward of vertical
   with the hands meeting in front of the hips, and every NPC walked
   the street carrying an invisible tray. */
REST[B.armL1 * 3 + 0] = -0.10;
REST[B.armR1 * 3 + 0] = -0.10;
REST[B.armL1 * 3 + 2] = -0.06;
REST[B.armR1 * 3 + 2] = 0.06;
REST[B.legL0 * 3 + 2] = 0.012;
REST[B.legR0 * 3 + 2] = -0.012;

export class HumanAnim {
  constructor(human, rng) {
    this.h = human;
    this.bones = human.bones;
    this.hipY = human.bones[B.hips].position.y;
    this.e = new Float32Array(NB * 3);         // euler being applied
    this.ph = rng() * Math.PI * 2;             // personal phase
    this.gait = 0.92 + rng() * 0.20;           // stride frequency scale
    this.energy = 0.80 + rng() * 0.45;         // how big their gestures are
    this.handed = rng() < 0.5 ? 1 : -1;
    this.walkPhase = rng() * Math.PI * 2;

    this.mode = 'idle';
    this.w = { walk: 0, run: 0, talk: 0, sit: 0, work: 0, wave: 0 };
    this.speed = 0;
    this.turn = 0;
    this.rootY = 0;
    this.lookTarget = null;
    this.lookW = 0;
    this.headYaw = 0;
    this.headPitch = 0;
    /* idle "life": a slow random walk of glance targets so a standing
       figure is never actually still (§6 — a static frame is forbidden,
       and a static *person* is worse than a static tree) */
    this.glance = 0;
    this.glanceT = 1 + rng() * 3;
    /* Nobody stands symmetrically. A fixed per-person bias on the
       shoulders, the hips and the head is the cheapest thing in this
       file and it is what stops six idle figures reading as six
       instances of one figure. */
    this.bias = new Float32Array(NB * 3);
    const j = (i, k, a) => { this.bias[i * 3 + k] = (rng() - 0.5) * a; };
    j(B.armL0, 2, 0.13); j(B.armR0, 2, 0.13);
    j(B.armL0, 0, 0.16); j(B.armR0, 0, 0.16);
    j(B.armL1, 0, 0.22); j(B.armR1, 0, 0.22);
    j(B.hips, 2, 0.06); j(B.hips, 1, 0.10);
    j(B.chest, 2, 0.05); j(B.chest, 0, 0.05);
    j(B.head, 1, 0.14); j(B.head, 2, 0.06);
    j(B.legL0, 0, 0.10); j(B.legR0, 0, 0.10);
  }

  setMode(m) { this.mode = m; return this; }

  /**
   * @param {number} dt
   * @param {number} t  elapsed seconds
   * @param {{speed:number, turn:number}} loco
   */
  update(dt, t, loco) {
    const m = this.mode;
    const moving = (loco?.speed || 0) > 0.22;
    const W = this.w;
    W.walk = damp(W.walk, moving ? 1 : 0, 9, dt);
    /* RUN IS A WEIGHT ON THE WALK, NOT A SECOND CYCLE. A run and a walk
       are the same four limbs on the same phase; what separates them is
       stride length, knee lift, elbow fold, forward lean and a flight
       phase — five numbers, every one of which the walk cycle already
       authors. A second cycle would carry its own phase and would pop on
       the crossfade, which is the one thing a Mayor accelerating away
       from the start line cannot do. */
    W.run = damp(W.run, m === 'run' ? 1 : 0, 4.5, dt);
    W.talk = damp(W.talk, m === 'talk' ? 1 : 0, 5, dt);
    W.sit = damp(W.sit, m === 'sit' ? 1 : 0, 4.5, dt);
    W.work = damp(W.work, m === 'work' ? 1 : 0, 4.5, dt);
    W.wave = damp(W.wave, m === 'wave' ? 1 : 0, 7, dt);

    this.speed = damp(this.speed, loco?.speed || 0, 8, dt);
    this.turn = damp(this.turn, loco?.turn || 0, 6, dt);

    const e = this.e;
    e.set(REST);
    const bias = this.bias;
    const standing = 1 - W.walk;
    for (let i = 0; i < NB * 3; i++) e[i] += bias[i] * standing;
    const tp = t + this.ph;

    this.idle(e, tp);
    if (W.sit > 0.001) this.sit(e, W.sit, tp);
    if (W.work > 0.001) this.work(e, W.work, tp);
    if (W.walk > 0.001) this.walk(e, W.walk, dt, t);
    if (W.talk > 0.001) this.talk(e, W.talk, tp);
    if (W.wave > 0.001) this.wave(e, W.wave, tp);

    /* --- head: glance + look-at, on top of everything --- */
    this.glanceT -= dt;
    if (this.glanceT <= 0) {
      this.glanceT = 2.2 + Math.abs(Math.sin(tp * 7.3)) * 4.5;
      this.glance = (Math.sin(tp * 12.7) * 0.5) * 0.9;
    }
    let wantYaw = this.glance * (1 - this.lookW) + Math.sin(tp * 0.23) * 0.10;
    let wantPitch = Math.sin(tp * 0.31) * 0.04;
    if (this.lookTarget && this.lookW > 0.001) {
      const b = this.bones[B.head];
      b.getWorldPosition(_v1);
      _v2.copy(this.lookTarget).sub(_v1);
      const rootYaw = this.h.root.rotation.y;
      const local = Math.atan2(_v2.x, _v2.z) - rootYaw;
      const yaw = Math.atan2(Math.sin(local), Math.cos(local));
      const pitch = -Math.atan2(_v2.y, Math.hypot(_v2.x, _v2.z));
      wantYaw = lerp(wantYaw, clamp(yaw, -1.15, 1.15), this.lookW);
      wantPitch = lerp(wantPitch, clamp(pitch, -0.45, 0.45), this.lookW);
    }
    this.headYaw = damp(this.headYaw, wantYaw, 6, dt);
    this.headPitch = damp(this.headPitch, wantPitch, 6, dt);
    /* the chest takes a third of a big turn — a head that swivels alone
       on a fixed body is the single most robotic thing an NPC can do */
    e[B.head * 3 + 1] += this.headYaw * 0.72;
    e[B.head * 3 + 0] += this.headPitch;
    e[B.chest * 3 + 1] += this.headYaw * 0.20;
    e[B.spine * 3 + 1] += this.headYaw * 0.08;

    this.apply();
  }

  idle(e, t) {
    const s = Math.sin(t * 0.36);
    const br = Math.sin(t * 1.05);
    e[B.chest * 3 + 0] += br * 0.020;
    e[B.spine * 3 + 0] += br * 0.010;
    e[B.hips * 3 + 2] += s * 0.045;
    e[B.hips * 3 + 1] += s * 0.030;
    e[B.chest * 3 + 2] += -s * 0.032;
    const sw = Math.sin(t * 0.52) * 0.035;
    e[B.armL0 * 3 + 0] += sw;
    e[B.armR0 * 3 + 0] += -sw;
    e[B.armL0 * 3 + 2] += s * 0.020;
    e[B.armR0 * 3 + 2] += s * 0.020;
    this.rootY = 0;
  }

  /**
   * Walk. Thigh swings as a sine, the knee flexes on the back half of
   * the stride and again through the swing, the arms counter-swing, the
   * pelvis and chest counter-rotate and the whole body bobs at twice
   * the step frequency. Stride frequency rises with speed but not
   * linearly — a fast walk lengthens the stride more than it quickens
   * it, which is what stops a hurrying NPC from looking like a
   * fast-forwarded one.
   */
  walk(e, w, dt, t) {
    const sp = Math.max(this.speed, 0.3);
    /* THE RUN, as five deltas on the walk. `R` is the run weight; at 0
       every line below is the walk cycle that four hundred people have
       always used, to the digit. */
    const R = this.w.run;
    /* A RUNNER LENGTHENS THE STRIDE MORE THAN HE QUICKENS IT — the same
       law the walk already states, applied again. 30 % more cadence and
       45 % more thigh is a 1.4 m stride at 4 Hz, which is a run; going
       at it with cadence alone gives a fast-forwarded walk, which is
       what a first pass looks like every time. */
    const freq = (1.55 + sp * 0.42) * this.gait * (1 + R * 0.30);
    this.walkPhase += dt * freq * Math.PI * 2;
    if (this.walkPhase > Math.PI * 4) this.walkPhase -= Math.PI * 4;
    const p = this.walkPhase;
    const amp = w * clamp(0.55 + sp * 0.34, 0.5, 1.18) * (1 + R * 0.16);

    const s = Math.sin(p), c = Math.cos(p);
    /* thighs — 0.66 rad each way is a 0.98 m stride on a 0.74 m leg,
       which is a walk with somewhere to be rather than a shuffle */
    const thigh = 0.66 + R * 0.30;
    e[B.legL0 * 3 + 0] += -s * thigh * amp;
    e[B.legR0 * 3 + 0] += s * thigh * amp;
    /* knees — flex under the body and again at the top of the swing.
       The knee is where a run is actually READ at forty metres: a
       walking silhouette's shin stays under the body, a running one
       folds the heel up behind the thigh. */
    const kn = (x) => (0.10 + (0.80 + R * 0.62) * Math.max(0, Math.sin(x + 1.85)) ** 1.4) * amp;
    const knL = kn(p), knR = kn(p + Math.PI);
    e[B.legL1 * 3 + 0] += knL;
    e[B.legR1 * 3 + 0] += knR;

    /* ANKLES ARE NOT A FREE PARAMETER — the foot bone inherits the
       thigh AND the knee, so any angle authored here is added to
       whatever those two already did. The first pass authored
       `-0.45 * knee`, which left +0.55 of the knee's own flexion on the
       ankle: at the top of the swing that is 29 degrees of toe-down and
       the entire crowd walked the island on tiptoe.
       The sole's world pitch is thigh + knee + ankle, so holding it
       level means ankle = -(thigh + knee), and the roll on top of that
       is the actual gait: heel strike as the leg reaches forward, toe
       off as it leaves the ground behind. */
    const roll = (x) => 0.34 * Math.max(0, -Math.sin(x)) - 0.20 * Math.max(0, Math.sin(x + 0.8));
    e[B.footL * 3 + 0] += s * thigh * amp - knL + roll(p) * amp;
    e[B.footR * 3 + 0] += -s * thigh * amp - knR + roll(p + Math.PI) * amp;

    /* arms, opposite the legs. A run drives them from a FOLDED elbow —
       0.72 rad of extra fold is the pumping forearm, and without it the
       arms windmill straight and the figure reads as panicking rather
       than as running. */
    e[B.armL0 * 3 + 0] += s * (0.46 + R * 0.30) * amp;
    e[B.armR0 * 3 + 0] += -s * (0.46 + R * 0.30) * amp;
    e[B.armL1 * 3 + 0] += -(0.08 + R * 0.72 + (0.26 + R * 0.30) * Math.max(0, s)) * amp;
    e[B.armR1 * 3 + 0] += -(0.08 + R * 0.72 + (0.26 + R * 0.30) * Math.max(0, -s)) * amp;
    /* counter-rotation and bob */
    e[B.hips * 3 + 1] += s * (0.10 + R * 0.05) * amp;
    e[B.chest * 3 + 1] += -s * (0.14 + R * 0.07) * amp;
    e[B.hips * 3 + 2] += -c * 0.05 * amp;
    /* THE LEAN. A runner's mass is in front of his feet; 0.20 rad of
       chest pitch is what says "this is effort" from a hundred metres,
       where no limb is more than three pixels. The head takes most of it
       back off, because a runner looks where he is going. */
    e[B.chest * 3 + 0] += 0.045 * amp + Math.max(0, this.speed - 1.6) * 0.05 + R * 0.20;
    e[B.spine * 3 + 0] += R * 0.06 * amp;
    e[B.head * 3 + 0] -= R * 0.17 * amp;
    /* the flight phase: twice the bob of a walk, and a lift that peaks
       between footfalls rather than at them */
    this.rootY = -(0.020 + R * 0.026) * amp * (0.5 - 0.5 * Math.cos(p * 2));
    /* lean into a turn */
    const tl = clamp(this.turn, -1.6, 1.6);
    e[B.chest * 3 + 2] += tl * 0.10;
    e[B.hips * 3 + 2] += tl * 0.05;
  }

  /**
   * Talking with the hands.
   *
   * `talkOpen` (0..1, default 0) swings the gesture OUT instead of up.
   * At 0 — every one of the four hundred people in this city — the
   * forearm folds to 58 degrees and the hand lives in front of the
   * chest, which is what a person gesturing at someone beside them
   * actually does, and what the crowd has always done.
   *
   * At 1 the shoulder abducts, the elbow opens and the palm ends out to
   * the side and low. Two reasons it exists and they agree: it is the
   * gesture in ref/happy-ref.webp — one hand open, mid-sentence — and
   * the closed version parks a forearm across the chest for the whole
   * eleven seconds of the walk-up line, which is precisely where the
   * open blazer, the white tee and the printed mark are. A costume
   * nobody can see during the only scene it appears in is not a
   * costume.
   */
  talk(e, w, t) {
    const g = this.energy;
    const a = this.handed > 0 ? B.armR0 : B.armL0;
    const f = this.handed > 0 ? B.armR1 : B.armL1;
    const s = this.handed;
    const o = this.talkOpen || 0;
    const beat = Math.sin(t * 2.35) * 0.5 + Math.sin(t * 3.9) * 0.3;
    e[a * 3 + 0] = lerp(e[a * 3 + 0], (-0.62 + o * 0.30) + beat * 0.24 * g, w);
    e[a * 3 + 2] = lerp(e[a * 3 + 2], (-0.34 - o * 0.36) * s + beat * 0.12, w);
    e[f * 3 + 0] = lerp(e[f * 3 + 0], (-1.02 + o * 0.60) + beat * 0.42 * g, w);
    e[f * 3 + 1] = lerp(e[f * 3 + 1], beat * 0.28 * s * (1 - o * 0.5), w);
    e[B.head * 3 + 0] += Math.sin(t * 2.6) * 0.055 * w * g;
    e[B.chest * 3 + 1] += Math.sin(t * 1.35) * 0.05 * w * (1 - o * 0.4);
  }

  wave(e, w, t) {
    const a = this.handed > 0 ? B.armR0 : B.armL0;
    const f = this.handed > 0 ? B.armR1 : B.armL1;
    const s = this.handed;
    /* A wave is elbow-up, not arm-out. Raising the shoulder to
       horizontal and leaving the forearm straight gives a figure
       pointing at the horizon; the hand has to finish beside the head,
       which means most of the lift comes from the elbow. */
    e[a * 3 + 2] = lerp(e[a * 3 + 2], -1.62 * s, w);
    e[a * 3 + 0] = lerp(e[a * 3 + 0], -0.34, w);
    e[f * 3 + 2] = lerp(e[f * 3 + 2], (-1.02 + Math.sin(t * 7.4) * 0.44) * s, w);
    e[f * 3 + 0] = lerp(e[f * 3 + 0], -0.22, w);
    e[B.chest * 3 + 2] += -0.07 * s * w;
    e[B.chest * 3 + 1] += 0.06 * s * w;
  }

  sit(e, w, t) {
    e[B.legL0 * 3 + 0] = lerp(e[B.legL0 * 3 + 0], -1.44, w);
    e[B.legR0 * 3 + 0] = lerp(e[B.legR0 * 3 + 0], -1.44, w);
    e[B.legL0 * 3 + 2] = lerp(e[B.legL0 * 3 + 2], 0.10, w);
    e[B.legR0 * 3 + 2] = lerp(e[B.legR0 * 3 + 2], -0.10, w);
    e[B.legL1 * 3 + 0] = lerp(e[B.legL1 * 3 + 0], 1.42, w);
    e[B.legR1 * 3 + 0] = lerp(e[B.legR1 * 3 + 0], 1.42, w);
    e[B.armL0 * 3 + 0] = lerp(e[B.armL0 * 3 + 0], -0.42, w);
    e[B.armR0 * 3 + 0] = lerp(e[B.armR0 * 3 + 0], -0.42, w);
    e[B.armL1 * 3 + 0] = lerp(e[B.armL1 * 3 + 0], -0.62, w);
    e[B.armR1 * 3 + 0] = lerp(e[B.armR1 * 3 + 0], -0.62, w);
    e[B.chest * 3 + 0] += 0.07 * w + Math.sin(t * 0.9) * 0.015;
    this.rootY = lerp(this.rootY, -0.395, w);
  }

  work(e, w, t) {
    const b = Math.sin(t * 2.9);
    e[B.chest * 3 + 0] = lerp(e[B.chest * 3 + 0], 0.30, w);
    e[B.spine * 3 + 0] = lerp(e[B.spine * 3 + 0], 0.14, w);
    e[B.head * 3 + 0] += 0.20 * w;
    e[B.armL0 * 3 + 0] = lerp(e[B.armL0 * 3 + 0], -0.78 + b * 0.10, w);
    e[B.armR0 * 3 + 0] = lerp(e[B.armR0 * 3 + 0], -0.82 - b * 0.14, w);
    e[B.armL1 * 3 + 0] = lerp(e[B.armL1 * 3 + 0], -0.86 - b * 0.18, w);
    e[B.armR1 * 3 + 0] = lerp(e[B.armR1 * 3 + 0], -0.92 + b * 0.26, w);
    e[B.legL0 * 3 + 2] = lerp(e[B.legL0 * 3 + 2], 0.10, w);
    e[B.legR0 * 3 + 2] = lerp(e[B.legR0 * 3 + 2], -0.10, w);
    this.rootY = lerp(this.rootY, -0.045, w);
  }

  apply() {
    const e = this.e, bs = this.bones;
    for (let i = 1; i < NB; i++) {
      bs[i].rotation.set(e[i * 3], e[i * 3 + 1], e[i * 3 + 2]);
    }
    bs[B.hips].position.y = this.hipY + this.rootY;
  }
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/* ==================================================================
   2. The ambient crowd
   ================================================================== */

/* How busy the street is, by the hour. The city is not a diorama that
   fills at 07:00 and empties at midnight — it has a morning push, a
   lunch bulge and an evening one, and Rusty Row still has someone out
   at two in the morning. */
function hourDensity(h) {
  const curve = [
    0.07, 0.05, 0.04, 0.05, 0.09, 0.20, 0.45, 0.78, 0.95, 0.88, 0.82, 0.90,
    1.00, 0.94, 0.86, 0.84, 0.90, 1.00, 0.96, 0.82, 0.66, 0.48, 0.30, 0.15,
  ];
  const i = Math.floor(h) % 24;
  const f = h - Math.floor(h);
  return lerp(curve[i], curve[(i + 1) % 24], f);
}

export function createCrowd(ctx, host) {
  const world = ctx.world;
  const rng = ctx.makeRng('npc.crowd.v1');
  /* npc.js owns the ground query, because it is the module that knows a
     road ribbon sits 90 mm above the terrain it was rasterised from. It
     costs 0.03 ms a call, so an agent re-samples it twice a second on a
     staggered timer and damps toward the answer; sampling it per agent
     per frame would be 2.3 ms of nothing. */
  const roadLift = host?.roadLift || (() => 0);

  /* ==================================================================
     THE DOORWAYS ARE NOT STANDING ROOM.

     "Barnaby and other NPCs are too close to some of the entrances to
     the buildings and interfere." Two separate mechanisms put them
     there and this is the second of them. The road network's location
     nodes sit ON the forecourt — that is what makes them worth walking
     to — and `steer` gives an agent arriving at one a 42 % chance of
     standing there for up to eighteen seconds. On a narrow Main Street
     frontage the forecourt IS the doorstep, so the wanderer parks in
     the threshold, the player's walk-to point is inside him, and the
     approach camera photographs the back of a stranger's head.

     What every door needs is a KEEP-CLEAR: a disc at the door itself
     and a corridor reaching out along the way the facade faces, wide
     enough for an elephant to walk down. This is that volume, as a
     force. It is not a collision — a wanderer crossing the frontage
     still crosses it, at walking pace, and simply does not stop in it —
     because a hard wall around every door would make the crowd flow
     visibly around invisible obstacles, which is worse than the defect.

     COST. The doors are static, so they are bucketed ONCE into 8 m
     cells at build time and each one is written into the nine cells
     that its influence can reach. An agent then does exactly one Map
     lookup per frame and, in the overwhelming majority of frames,
     finds nothing and returns. npc.js supplies the list — it is the
     module that has ctx.city and the location table.
     ================================================================== */
  /* ROUND 2. The complaint came back — "still too close to the
     apartment where he interferes with easy access" — and the audit
     that said otherwise was measuring a lane narrower than the elephant
     walking down it. The volume now matches npc.js's own keep-clear to
     the millimetre; if the two ever disagree, one of them is placing
     people the other thinks are in the way. */
  const DOOR_R = 3.20;        // keep-clear disc centred on the door
  const DOOR_LEN = 5.60;      // how far the approach corridor reaches out
  const DOOR_HALF = 2.30;     // corridor half-width
  /* The bucket has to reach as far as the influence does: at 8 m cells
     and a 5.60 m corridor the nine-cell write no longer covers a door
     the agent can still feel, and a wanderer would pop when it crossed
     a cell line. 10 m puts the whole volume inside the 3x3. */
  const DCELL = 10;
  const doors = host?.doors || [];
  const doorGrid = new Map();
  const dkey = (i, j) => ((i * 83492791) ^ (j * 29418343)) | 0;
  for (const d of doors) {
    const ci = Math.floor(d.x / DCELL), cj = Math.floor(d.z / DCELL);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const k = dkey(ci + i, cj + j);
        let b = doorGrid.get(k);
        if (!b) { b = []; doorGrid.set(k, b); }
        b.push(d);
      }
    }
  }

  /* Where a point is being pushed, and how hard. 0 means "not in
     anybody's doorway", which is the answer nearly every time. */
  const _push = { x: 0, z: 0, d: null };
  function doorPush(x, z) {
    _push.x = 0; _push.z = 0; _push.d = null;
    if (!doors.length) return 0;
    const b = doorGrid.get(dkey(Math.floor(x / DCELL), Math.floor(z / DCELL)));
    if (!b) return 0;
    let best = 0;
    for (let i = 0; i < b.length; i++) {
      const d = b[i];
      const dx = x - d.x, dz = z - d.z;
      const along = dx * d.ax + dz * d.az;        // out from the facade
      const side = dx * d.az - dz * d.ax;         // across the corridor
      let k = 0, px = 0, pz = 0;
      if (along > -0.8 && along < DOOR_LEN && Math.abs(side) < DOOR_HALF) {
        /* inside the corridor: leave it SIDEWAYS, by the short way out.
           Pushing them straight back out of the door would send them
           through the wall behind. */
        k = 1 - Math.abs(side) / DOOR_HALF;
        const s = side >= 0 ? 1 : -1;
        px = d.az * s; pz = -d.ax * s;
        /* plus a nudge outward, so a body pinned against the door does
           not slide along the step */
        const fwd = 1 - clamp(along / DOOR_LEN, 0, 1);
        px += d.ax * fwd * 0.45; pz += d.az * fwd * 0.45;
      }
      const r = Math.hypot(dx, dz);
      if (r < DOOR_R) {
        /* the disc: radially away from the door, whichever side of it
           they are on */
        const kr = 1 - r / DOOR_R;
        if (kr > k) {
          k = kr;
          const inv = 1 / (r || 1e-3);
          px = dx * inv; pz = dz * inv;
          /* dead on the door point there is no direction to leave by;
             take the facade's own outward normal */
          if (r < 1e-2) { px = d.ax; pz = d.az; }
        }
      }
      if (k > best) {
        best = k;
        _push.d = d;
        const l = Math.hypot(px, pz) || 1;
        _push.x = px / l; _push.z = pz / l;
      }
    }
    return best;
  }

  /* ==================================================================
     HOW LONG DOES ANYBODY ACTUALLY STAND THERE?

     Transiting a threshold is by design — the keep-clear is a force,
     not a wall, and a pedestrian who walked around every doorway would
     look like the street was full of invisible furniture. What is NOT
     by design is dwelling: round 3 measured 1-7 agents inside a volume
     at any snapshot, of which a couple PERSISTED for 6-9 s, and six
     seconds in a doorway is a person standing in your doorway.

     So the module measures its own defect rather than asserting the
     fix. Every agent carries two clocks, and the difference between
     them is the whole point:

       DWELL — continuous seconds inside ONE door's volume, moving or
         not. Per door, not per any-door: the shops on Main Street stand
         shoulder to shoulder and their corridors overlap across the
         street, so an any-door clock counts a pedestrian walking a row
         of frontages as one nine-second "dwell" when he never once
         stopped. That artefact is what made the first version of this
         audit unable to see its own fix.
       PARK — the subset of that time with the agent essentially
         stationary (under 0.35 m/s). THIS is the complaint: a person
         standing in your doorway. Transit is by design and is left
         alone; parking is what must never happen.

     `doorStats()` reports both distributions and both longest-singles.
     ================================================================== */
  const DWELL_IN = 0.02;          // k above this counts as "inside"
  /* The round-3 anti-parking behaviour, switchable — and unlike the
     A/B this project shipped last round, this one really does restore
     the old code path: the drift floor, the eviction and the
     don't-loiter-on-a-doorstep roll all read it, so `{evict:false}`
     re-measures the crowd that dwelled 6-9 s. */
  const EV = { on: true };
  const PARK_SPEED = 0.35;        // slower than this is not walking past
  const DWELL_BUCKETS = [0.5, 1, 2, 3, 4, 6, 9];
  const nBucket = () => new Array(DWELL_BUCKETS.length + 1).fill(0);
  const blank = () => ({ n: 0, total: 0, longest: 0, hist: nBucket() });
  const stats = {
    t: 0, snaps: 0, snapSum: 0, snapMax: 0, parkSum: 0, parkMax: 0,
    evictions: 0, dwell: blank(), park: blank(),
  };
  function record(bin, d) {
    bin.n++; bin.total += d;
    if (d > bin.longest) bin.longest = d;
    let i = 0;
    while (i < DWELL_BUCKETS.length && d > DWELL_BUCKETS[i]) i++;
    bin.hist[i]++;
  }
  /** One agent, one frame. `d` is the door whose volume he is in. */
  function tallyDwell(a, k, dt, door) {
    const inside = k > DWELL_IN && door;
    if (!inside || door !== a.doorAt) {
      if (a.doorDwell > 0) record(stats.dwell, a.doorDwell);
      if (a.parkDwell > 0) record(stats.park, a.parkDwell);
      a.doorDwell = 0; a.parkDwell = 0;
      a.doorAt = inside ? door : null;
    }
    if (!inside) return;
    a.doorDwell += dt;
    if (a.speed < PARK_SPEED) a.parkDwell += dt;
    else {
      if (a.parkDwell > 0) record(stats.park, a.parkDwell);
      a.parkDwell = 0;
    }
  }

  /* THE PROBE. The natural crowd hardly ever parks in a doorway — road
     nodes mostly sit off the keep-clear, so a 60 s window can pass with
     nothing to see, and "no parking observed" is not the same claim as
     "parking is now impossible". So the module can be made to produce
     the defect on demand: drop somebody on a threshold, tell him to
     loiter, and time how long he takes to get clear. That number is the
     fix, and it is comparable between `{evict:false}` and `{evict:true}`
     on the same doors — an A/B that cannot return the same answer twice
     by accident, because the two branches take different code. */
  const probes = [];

  /* ---- the walkable graph, straight off the road network ---- */
  const nodes = world?.paths?.nodes || [];
  const edges = (world?.paths?.edges || []).filter((e) => e.points && e.points.length > 1);
  const adj = nodes.map(() => []);
  for (const e of edges) {
    if (!adj[e.a.i] || !adj[e.b.i]) continue;
    adj[e.a.i].push({ e, fwd: true });
    adj[e.b.i].push({ e, fwd: false });
  }
  const walkable = nodes.map((n, i) => (adj[i].length > 0 ? i : -1)).filter((i) => i >= 0);

  const agents = [];
  /* spatial hash for separation — 4 m cells, rebuilt every frame; with
     fifty agents this is cheaper than any tree and never allocates */
  const CELL = 4;
  const grid = new Map();
  const key = (x, z) => ((Math.floor(x / CELL) * 73856093) ^ (Math.floor(z / CELL) * 19349663)) | 0;

  function startEdge(a, nodeIdx, exclude) {
    const list = adj[nodeIdx];
    if (!list || !list.length) return false;
    let choices = list.filter((c) => c.e !== exclude);
    if (!choices.length) choices = list;
    const c = choices[Math.floor(rng() * choices.length) % choices.length];
    a.edge = c.e;
    a.fwd = c.fwd;
    a.seg = c.fwd ? 0 : c.e.points.length - 1;
    a.node = c.fwd ? c.e.b.i : c.e.a.i;
    return true;
  }

  function spawnAgent(human, nodeIdx) {
    const n = nodes[nodeIdx];
    const a = {
      human,
      pos: new THREE.Vector3(n.x + (rng() - 0.5) * 3, 0, n.z + (rng() - 0.5) * 3),
      vel: new THREE.Vector3(),
      yaw: rng() * Math.PI * 2,
      base: 1.05 + rng() * 0.55,
      speed: 0,
      edge: null, fwd: true, seg: 0, node: nodeIdx,
      mode: 'walk',
      timer: 0,
      pause: 0,
      /* the door clock: seconds continuously inside a keep-clear, the
         sampled push at the top of this frame, and how long the
         eviction force stays raised after one fires */
      doorDwell: 0, parkDwell: 0, doorAt: null, probe: null,
      dk: 0, dkx: 0, dkz: 0, evict: 0, noPause: 0,
      active: true,
      lift: 0, liftT: rng() * 0.5,
    };
    startEdge(a, nodeIdx, null);
    a.lift = roadLift(a.pos.x, a.pos.z);
    a.pos.y = world.heightAt(a.pos.x, a.pos.z) + a.lift;
    human.root.position.copy(a.pos);
    agents.push(a);
    return a;
  }

  /** ground an agent, road ribbons included */
  function place(a, dt) {
    a.liftT -= dt;
    if (a.liftT <= 0) { a.liftT = 0.45 + rng() * 0.3; a.liftTo = roadLift(a.pos.x, a.pos.z); }
    a.lift = damp(a.lift, a.liftTo ?? a.lift, 7, dt);
    a.pos.y = world.heightAt(a.pos.x, a.pos.z) + a.lift;
    a.human.root.position.copy(a.pos);
  }

  /** Wander target, path following, separation, grounding. */
  function steer(a, dt, wally) {
    if (a.pause > 0) {
      a.pause -= dt;
      a.speed = damp(a.speed, 0, 8, dt);
      if (a.pause <= 0) a.mode = 'walk';
      /* LOITERING IS WHERE THE DEFECT ACTUALLY LIVES. A wanderer
         crossing a threshold is traffic; a wanderer who stops in one is
         a door that cannot be used. So a paused agent keeps drifting —
         slowly, under the same force — until he is out of the corridor,
         and then stops. It reads as somebody shuffling aside, which is
         what a person standing in a doorway does.

         ROUND 3: THE SHUFFLE DID NOT FINISH. The drift speed was scaled
         by k, and k falls to zero AT the boundary — so the closer he
         got to being clear the slower he moved, an asymptote dressed up
         as a force. Measured, that is a couple of agents dwelling 6-9 s
         in a doorway. Two changes, both still forces:

         1. a FLOOR under the drift (never below ~0.28 m/s however
            shallow he is in the volume), so leaving actually completes;
         2. an EVICTION at 1.2 s of continuous dwell — the loiter is cut
            short and he walks off under a raised door weight for the
            next 2.5 s, with a cooldown so he does not re-park at the
            same forecourt. He walks out on his own legs rather than
            sliding out in an idle pose, which is the difference between
            somebody moving aside and a body on a conveyor. */
      const k = a.dk;
      if (k > DWELL_IN) {
        if (EV.on && a.parkDwell > 1.2) {
          a.pause = 0; a.mode = 'walk';
          a.evict = 2.5; a.noPause = 8;
          stats.evictions++;
          return;
        }
        const v = 0.55 * (EV.on ? Math.max(0.5, Math.min(1, k * 2.2)) : Math.min(1, k * 2.2));
        a.pos.x += a.dkx * v * dt;
        a.pos.z += a.dkz * v * dt;
      }
      return;
    }
    if (!a.edge) { if (!startEdge(a, a.node, null)) return; }

    const pts = a.edge.points;
    let tgt = pts[a.seg];
    let dx = tgt.x - a.pos.x, dz = tgt.z - a.pos.z;
    let d = Math.hypot(dx, dz);
    /* advance through the polyline; several points can fall inside one
       step when the road is finely sampled and the agent is running */
    let guard = 0;
    while (d < 1.4 && guard++ < 8) {
      const done = a.fwd ? (a.seg >= pts.length - 1) : (a.seg <= 0);
      if (done) {
        /* arrived at a node. If it is a location and it is open, there
           is a good chance of stopping there for a while. */
        const n = nodes[a.node];
        const loc = n && n.kind === 'loc' ? n.ref : null;
        const open = loc && ctx.game?.isOpen ? ctx.game.isOpen(loc.id) : true;
        /* NOBODY CHOOSES TO STOP ON A DOORSTEP. A location node often
           sits on the forecourt, so the loiter roll is skipped outright
           while he is standing in the keep-clear or is still walking one
           off. He carries on down the road and stops somewhere he is
           not in the way — no teleport, no jitter, just a decision not
           taken. The eviction above handles the ones already there. */
        /* the draws happen either way so the shared stream does not
           shift under a decision that depends on where somebody stands */
        const blocked = EV.on && (a.dk > 0.15 || a.noPause > 0);
        if (loc && open && rng() < 0.42 && !blocked) {
          a.pause = 4 + rng() * 14;
          a.mode = rng() < 0.35 ? 'talk' : (rng() < 0.25 ? 'work' : 'idle');
        } else if (rng() < 0.10 && !blocked) {
          a.pause = 2 + rng() * 6;
          a.mode = 'idle';
        }
        startEdge(a, a.node, a.edge);
        return;
      }
      a.seg += a.fwd ? 1 : -1;
      tgt = pts[a.seg];
      dx = tgt.x - a.pos.x; dz = tgt.z - a.pos.z;
      d = Math.hypot(dx, dz) || 1;
    }
    d = d || 1;
    let ux = dx / d, uz = dz / d;

    /* separation from the neighbours in this cell and the eight around */
    let sx = 0, sz = 0;
    const gx = Math.floor(a.pos.x / CELL), gz = Math.floor(a.pos.z / CELL);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const bucket = grid.get(((gx + i) * 73856093 ^ (gz + j) * 19349663) | 0);
        if (!bucket) continue;
        for (const o of bucket) {
          if (o === a) continue;
          const ox = a.pos.x - o.pos.x, oz = a.pos.z - o.pos.z;
          const dd = ox * ox + oz * oz;
          if (dd > 1.6 * 1.6 || dd < 1e-6) continue;
          const inv = 1 / Math.sqrt(dd);
          const k = (1.6 - 1 / inv) * inv;
          sx += ox * k; sz += oz * k;
        }
      }
    }
    /* and from Wally, who has right of way */
    if (wally) {
      const ox = a.pos.x - wally.x, oz = a.pos.z - wally.z;
      const dd = ox * ox + oz * oz;
      if (dd < 2.2 * 2.2 && dd > 1e-6) {
        const inv = 1 / Math.sqrt(dd);
        const k = (2.2 - 1 / inv) * inv * 2.2;
        sx += ox * k; sz += oz * k;
      }
    }
    ux += sx * 0.55; uz += sz * 0.55;
    /* and out of anybody's doorway. Weighted a shade under the
       separation term: it must be enough to bend a path around a
       threshold and never enough to stop somebody walking past one. */
    const dk = a.dk;
    if (dk > 0) {
      /* the weight triples for a couple of seconds after an eviction:
         enough to beat the road he is following back through the
         threshold, and it decays, so the path bends rather than snaps */
      const w = a.evict > 0 ? 0.85 + 1.75 * Math.min(1, a.evict / 2.5) : 0.85;
      ux += a.dkx * dk * w; uz += a.dkz * dk * w;
    }
    const ul = Math.hypot(ux, uz) || 1;
    ux /= ul; uz /= ul;

    const want = a.base * (a.mode === 'run' ? 1.9 : 1);
    a.speed = damp(a.speed, want, 3.5, dt);
    a.vel.set(ux * a.speed, 0, uz * a.speed);
    a.pos.x += a.vel.x * dt;
    a.pos.z += a.vel.z * dt;
  }

  function updateAgent(a, dt, t, wally) {
    steer(a, dt, wally);
    place(a, dt);
    const h = a.human;
    if (a.speed > 0.15) {
      const want = Math.atan2(a.vel.x, a.vel.z);
      const dyaw = Math.atan2(Math.sin(want - a.yaw), Math.cos(want - a.yaw));
      a.turn = dyaw / Math.max(dt, 1e-3);
      a.yaw += dyaw * (1 - Math.exp(-7 * dt));
    } else {
      a.turn = 0;
    }
    h.root.rotation.y = a.yaw;
    const an = h.anim;
    if (an) {
      an.setMode(a.pause > 0 ? a.mode : (a.speed > 0.25 ? 'walk' : 'idle'));
      an.update(dt, t, { speed: a.speed, turn: clamp(a.turn * 0.35, -1.5, 1.5) });
    }
  }

  return {
    agents,
    nodes, edges, walkable,
    doors,

    /** How far into a doorway keep-clear a point is: 0 outside any,
        1 dead on a door. npc.js scores standing spots with it and the
        verifier measures the fix with it. */
    doorClearance(x, z) {
      const k = doorPush(x, z);
      return { k, out: { x: _push.x, z: _push.z } };
    },

    /** Stand `n` wanderers squarely in `n` different doorways and tell
        them to loiter there; `doorProbeState()` then reports how many
        seconds each one took to get clear. Debug only — it teleports
        people, which nothing in the game does. */
    doorProbe(opts = {}) {
      if (opts.evict !== undefined) EV.on = !!opts.evict;
      for (const a of probes) a.probe = null;
      probes.length = 0;
      const n = opts.n ?? 6;
      const step = Math.max(1, Math.floor(doors.length / n));
      let ai = 0;
      for (let i = 0; i < doors.length && probes.length < n; i += step) {
        const d = doors[i];
        while (ai < agents.length && (agents[ai].human.asleep || agents[ai].probe)) ai++;
        if (ai >= agents.length) break;
        const a = agents[ai++];
        /* half a metre out from the threshold: k ~ 0.85, which is the
           worst the complaint has ever described */
        a.pos.x = d.x + d.ax * 0.5; a.pos.z = d.z + d.az * 0.5;
        a.speed = 0; a.vel.set(0, 0, 0);
        a.pause = opts.pause ?? 12; a.mode = 'idle';
        a.doorDwell = 0; a.parkDwell = 0; a.doorAt = null;
        a.evict = 0; a.noPause = 0;
        a.probe = { door: d.id, t: 0, clear: -1, k0: -1 };
        probes.push(a);
      }
      return { probes: probes.length, evict: EV.on };
    },

    /** Seconds to clear per probe; -1 means still in the doorway. */
    doorProbeState() {
      return {
        evict: EV.on,
        rows: probes.map((a) => ({
          door: a.probe.door, k0: +Math.max(0, a.probe.k0).toFixed(2),
          k: +a.dk.toFixed(2), t: +a.probe.t.toFixed(2),
          clear: a.probe.clear < 0 ? -1 : +a.probe.clear.toFixed(2),
        })),
      };
    },

    /** The dwell distribution inside doorway keep-clears, accumulated
        live since the last reset. `longest` is the headline: transits
        are fine, standing there is not. Ongoing dwells are reported
        separately so a long one in flight cannot hide behind a reset. */
    doorStats(opts = {}) {
      if (opts.evict !== undefined) EV.on = !!opts.evict;
      if (opts.reset) {
        stats.t = 0; stats.snaps = 0; stats.evictions = 0;
        stats.snapSum = 0; stats.snapMax = 0;
        stats.parkSum = 0; stats.parkMax = 0;
        stats.dwell = blank(); stats.park = blank();
        for (const a of agents) { a.doorDwell = 0; a.parkDwell = 0; a.doorAt = null; }
      }
      const shape = (bin, live) => {
        const hist = {};
        for (let i = 0; i <= DWELL_BUCKETS.length; i++) {
          const lo = i === 0 ? 0 : DWELL_BUCKETS[i - 1], hi = DWELL_BUCKETS[i];
          hist[hi ? `${lo}-${hi}s` : `>${lo}s`] = bin.hist[i];
        }
        return {
          n: bin.n, longest: +bin.longest.toFixed(2),
          mean: bin.n ? +(bin.total / bin.n).toFixed(2) : 0,
          hist, longestInFlight: +live.toFixed(2),
        };
      };
      let liveD = 0, liveP = 0;
      for (const a of agents) {
        if (a.doorDwell > liveD) liveD = a.doorDwell;
        if (a.parkDwell > liveP) liveP = a.parkDwell;
      }
      return {
        window: +stats.t.toFixed(1), evict: EV.on, evictions: stats.evictions,
        agents: agents.length, doors: doors.length,
        park: shape(stats.park, liveP),
        transit: shape(stats.dwell, liveD),
        insideMean: stats.snaps ? +(stats.snapSum / stats.snaps).toFixed(2) : 0,
        insideMax: stats.snapMax,
        parkedMean: stats.snaps ? +(stats.parkSum / stats.snaps).toFixed(2) : 0,
        parkedMax: stats.parkMax,
      };
    },

    /** Somewhere sensible to put a new wanderer. */
    randomNode() {
      if (!walkable.length) return -1;
      return walkable[Math.floor(rng() * walkable.length) % walkable.length];
    },

    add(human) {
      const n = this.randomNode();
      if (n < 0) return null;
      return spawnAgent(human, n);
    },

    remove(a) {
      const i = agents.indexOf(a);
      if (i >= 0) agents.splice(i, 1);
    },

    /** Fraction of the crowd that should be out at this hour. */
    density(hour) { return hourDensity(hour); },

    update(dtRaw, t, wally, budget) {
      /* CLAMP THE STEP. Every agent integrates position and damps a
         speed, and `damp` is lerp(a, b, 1 - exp(-lambda*dt)) — feed it
         a negative dt and the blend factor becomes a huge NEGATIVE
         number, which extrapolates instead of interpolating and throws
         the whole population several hundred kilometres off the island
         in a single frame. It then converges back over a second, which
         is why the symptom looked like "the crowd is missing" rather
         than "the crowd exploded". A boot frame can hand any module a
         wild dt; a module that integrates must not trust it. */
      const dt = dtRaw > 0 ? (dtRaw < 0.1 ? dtRaw : 0.1) : 0;
      if (dt <= 0) return;
      grid.clear();
      for (const a of agents) {
        const k = key(a.pos.x, a.pos.z);
        let b = grid.get(k);
        if (!b) { b = []; grid.set(k, b); }
        b.push(a);
      }
      /* ONE door sample per agent per frame, at the top: steer reads it
         instead of calling doorPush again (the _push scratch vector is
         shared, so a second call from anywhere would clobber it), and
         the dwell clock is fed from the same number the force uses —
         the audit cannot disagree with the behaviour it is auditing. */
      let inside = 0, parked = 0;
      for (const a of agents) {
        if (a.frozen || a.human.asleep) { a.dk = 0; tallyDwell(a, 0, dt, null); continue; }
        a.dk = doorPush(a.pos.x, a.pos.z);
        a.dkx = _push.x; a.dkz = _push.z; a.dkd = _push.d;
        if (a.dk > DWELL_IN) { inside++; if (a.speed < PARK_SPEED) parked++; }
        tallyDwell(a, a.dk, dt, a.dkd);
        if (a.probe && a.probe.clear < 0) {
          a.probe.t += dt;
          if (a.probe.k0 < 0) a.probe.k0 = a.dk;
          if (a.dk <= DWELL_IN) a.probe.clear = a.probe.t;
        }
        if (a.evict > 0) a.evict = Math.max(0, a.evict - dt);
        if (a.noPause > 0) a.noPause = Math.max(0, a.noPause - dt);
      }
      stats.t += dt; stats.snaps++;
      stats.snapSum += inside; stats.parkSum += parked;
      if (inside > stats.snapMax) stats.snapMax = inside;
      if (parked > stats.parkMax) stats.parkMax = parked;
      for (const a of agents) {
        if (a.frozen || a.human.asleep) continue;
        a.active = a.human.active;
        if (!a.active) {
          /* off-screen or far away: keep them moving so the city is not
             frozen behind you, but skip the skeleton entirely */
          steer(a, dt, wally);
          place(a, dt);
          if (a.speed > 0.15) a.yaw = Math.atan2(a.vel.x, a.vel.z);
          a.human.root.rotation.y = a.yaw;
          continue;
        }
        updateAgent(a, dt, t, wally);
      }
    },
  };
}

export default { HumanAnim, createCrowd };
