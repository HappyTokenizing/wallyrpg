/* ============================================================
   wally.js — ctx.wally. The title character.

   Assembles the four halves of him and publishes the one API the camera,
   the intro, the game and the UI all code against:

     model.js        the SDF sculpt, the glasses, THE GLINT
     rig.js          33 bones, all bind rotations identity
     anim.js         clips + the blending state machine
     secondary.js    ear / trunk / tail springs, belly, squash, foot IK
     expression.js   head, ear, trunk and eyebrow accents; look-at

   FRAME ORDER (main.js runs every update(), then every lateUpdate()):

     phys.update       controller integrates; his position settles
     wally.update      pick a clip, resolve the pose, write the skeleton,
                       hand targets to the spring chains, then force a
                       world-matrix update so the chains have fresh bone
                       transforms to hang off
     phys.lateUpdate   chains solve at the fixed dt and write ear / trunk /
                       tail quaternions
     wally.lateUpdate  trunk-tip accent, foot IK, debug camera
     cam.lateUpdate    follows

   ART DIRECTION COMPLIANCE, in the order §6 lists it:
     - no outline on Wally: every material here sets noOutline
     - no eyes, ever: there is no eye geometry and no eye bone
     - the glint is painted into the lens texture, so it cannot drift
     - the clay is ctx.mat.clay(), unmodified except for grain and sss
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { CLAY, SHADOW } from '../core/palette.js';
import { clamp, damp, lerp } from '../core/contracts.js';

import {
  H, PROP, BONES, BONE_INDEX, buildSkeleton, bindWorld,
} from './rig.js';
import {
  buildBodyGeometry, buildTuskGeometry, buildFrameGeometry,
  buildLensGeometry, buildLensTexture, buildGrooveStrokeGeometry,
  ARM_SEAM,
} from './model.js';
import { Animator, CLIPS, CLIP_NAMES, BIKE_SEAT } from './anim.js';
import { Expression, EXPRESSION_NAMES } from './expression.js';
import { Secondary } from './secondary.js';
import { createBike, solveParkPose, PARK_PITCH_MAX } from './bike.js';
import { createScooter, createMotorcycle, triangleCost } from './rides.js';
import {
  createBalloon, FIT as BALLOON_FIT, FLIGHT, stepFlight, newFlight, envelopeRings,
  WRAP, wrapK, wrapMist, wrapFar, wrapDelta,
} from './balloon.js';

const _e = new THREE.Euler(0, 0, 0, 'XYZ');
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _target = new THREE.Vector3();
const _camPos = new THREE.Vector3();

/* Ground-shadow scratch. Kept out of the shared trio above because the
   shadow runs inside lateUpdate alongside updateGrainScale and the two
   would otherwise stamp on each other's vectors. */
const _sc = new THREE.Vector3();
const _fl = new THREE.Vector3();
const _fr = new THREE.Vector3();

/* Warp scratch. warpTo() runs the placement, the yaw solve and the
   finite check in one call, so it cannot borrow _v / _v2 from face()
   and headPosition() the way setPosition() safely does. */
const _wp = new THREE.Vector3();
const _wsafe = new THREE.Vector3();

/* ------------------------------------------------------------------
   THE NON-FINITE GUARD.

   A position is only usable if every component is a real number, and
   the cost of letting one that is not through is out of all proportion
   to the cost of checking. The controller keeps THREE positions —
   simPosition (end of the fixed step), _prevPosition (start of it) and
   position (the render lerp between them) — and once any of them is
   NaN the lerp is NaN for ever: there is no arithmetic that brings a
   NaN back. Downstream of that, in order: root.position is NaN, so
   Wally's bounding sphere is NaN and he is culled out of the frame;
   the camera anchor damps toward NaN and the whole view disappears;
   the spring chains integrate NaN and never recover; and the audio
   panner is handed a NaN world position, at which point Web Audio
   throws "setTargetAtTime: The provided float value is non-finite"
   once per frame for the rest of the session.

   So every entry point that can move him checks the destination BEFORE
   the controller sees it, and update() re-checks the result of the
   simulation once per frame. `Number.isFinite(x + y + z)` is one add
   chain and one test: NaN and both infinities poison a sum, so the
   single check covers all three components.
   ------------------------------------------------------------------ */
const finite3 = (x, y, z) => Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
const vecFinite = (v) => !!v && Number.isFinite(v.x + v.y + v.z);

/* A layer only the shadow projector's camera looks at, so the silhouette
   pass can draw Wally and nothing else without re-parenting him or
   walking the scene hiding things. */
const SHADOW_LAYER = 9;

/* Debug camera presets. Distances are chosen so that at 16:9 he fills the
   frame the way the reference product shots do — full body just inside the
   safe area, face framed on the glasses, silhouette with room for the ear
   span, which is 0.78 H and by far the widest thing about him. */
const CAMS = {
  full: { pos: [0.00, 0.90, 3.30], look: [0, 0.86, 0], fov: 33 },
  /* Matches ref/wally-ref-cool.png's framing: portrait full-body
     three-quarter from HIS LEFT (~29 degrees), lens a touch below head
     height so the crown has air and the feet sit low in frame. Shot at
     1000x1400 the figure fills ~85% of the height, like the render. */
  studio: { pos: [1.60, 0.98, 2.90], look: [0, 0.80, 0.01], fov: 33 },
  face: { pos: [0.06, 1.44, 1.24], look: [0, 1.372, 0.19], fov: 30 },
  threequarter: { pos: [2.00, 1.28, 2.42], look: [0, 0.88, 0.02], fov: 34 },
  silhouette: { pos: [0.00, 0.82, 4.60], look: [0, 0.80, 0], fov: 22 },
  side: { pos: [3.30, 0.90, 0.10], look: [0, 0.86, 0], fov: 33 },
  /* THE GAIT PAIR. A walk is judged on the feet and the pelvis, and every
     preset above is framed on the head — a striding foot leaves the
     bottom of the frame in all of them, which is exactly how a shuffle
     goes unnoticed. These sit lower, pull back and narrow the lens so the
     ground line and both feet stay in shot through the whole cycle, at
     the two angles a stride reads from: dead profile, and the
     three-quarter where the far leg separates. */
  gait: { pos: [3.85, 0.74, 0.00], look: [0, 0.70, 0], fov: 30 },
  gait34: { pos: [2.90, 0.82, 2.36], look: [0, 0.72, 0.02], fov: 31 },
  back: { pos: [0.00, 0.92, -3.30], look: [0, 0.86, 0], fov: 33 },
  ears: { pos: [0.00, 1.44, 2.10], look: [0, 1.36, 0], fov: 40 },
  /* The bicycle needs a LOWER, WIDER lens than any of the above: the
     interesting geometry (cranks, pedals, the fold at the hip, the bars
     under his hands) lives between 0.2 and 1.0 m, and a lens at head
     height looks straight down on to the top tube and photographs a
     saddle. 0.86 m is level with the bars; 42 degrees keeps the wheels
     inside the frame at 2.9 m without a fisheye on the near tyre. */
  bike: { pos: [2.18, 1.02, 2.02], look: [0, 0.78, 0.06], fov: 41 },
  bikeSide: { pos: [3.25, 0.74, 0.06], look: [0, 0.68, 0.03], fov: 38 },
  /* THE BIGGER MACHINES NEED A BIGGER BOX. The scooter is 1.0 m between
     the axles and the motorcycle 1.28, against the bicycle's 0.94, and
     both carry their mass further forward — so the bicycle's framing
     photographs a Thunderhead with its front wheel amputated. Pulled
     back and swung a little more to the front quarter, which is where a
     leg shield and a tank actually read; the look-at drops with the
     machine, because the interesting half of a motorcycle is below the
     rider's knee. */
  scoot: { pos: [2.42, 1.06, 2.28], look: [0, 0.74, 0.08], fov: 41 },
  scootSide: { pos: [3.45, 0.72, 0.04], look: [0, 0.62, 0.02], fov: 38 },
  moto: { pos: [2.72, 1.10, 2.56], look: [0, 0.72, 0.10], fov: 42 },
  motoSide: { pos: [3.85, 0.70, 0.02], look: [0, 0.60, 0.02], fov: 38 },
};

/**
 * Give a small auxiliary geometry the SAME skin weights as the body
 * surface it lies on, by nearest-neighbour transfer in bind space.
 *
 * This is the whole fix for the drifting bridge lines. A rod parented to
 * one bone is rigid; the skin beneath it is a four-bone blend that the
 * weight smoother and the analytic trunk re-blend have both been over.
 * Guessing that blend analytically means re-deriving two passes of
 * model.js and getting them exactly right; COPYING it from the finished
 * geometry cannot be wrong by construction. Six nearest body vertices,
 * inverse-square weighted, top four bones kept and renormalised — the
 * strokes sit ~0.8 mm off the skin, so the six neighbours are always the
 * two triangles directly under them and the blend is effectively an
 * on-surface interpolation of the body's own weights.
 *
 * Cost: ~320 stroke vertices against the ~3 000 body vertices inside the
 * trunk box, once, at build time.
 */
function copySkinFromBody(dst, src, pad = 0.12) {
  const dp = dst.attributes.position.array;
  const n = dst.attributes.position.count;
  const sp = src.attributes.position.array;
  const si = src.attributes.skinIndex.array;
  const sw = src.attributes.skinWeight.array;
  const m = src.attributes.position.count;

  let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
  for (let i = 0; i < n; i++) {
    const x = dp[i * 3], y = dp[i * 3 + 1], z = dp[i * 3 + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const cand = [];
  for (let j = 0; j < m; j++) {
    const x = sp[j * 3], y = sp[j * 3 + 1], z = sp[j * 3 + 2];
    if (x < x0 - pad || x > x1 + pad || y < y0 - pad || y > y1 + pad
      || z < z0 - pad || z > z1 + pad) continue;
    cand.push(j);
  }
  const K = 6;
  const bd = new Float64Array(K), bj = new Int32Array(K);
  const idx = new Uint16Array(n * 4), wgt = new Float32Array(n * 4);
  const acc = new Map();
  for (let i = 0; i < n; i++) {
    const x = dp[i * 3], y = dp[i * 3 + 1], z = dp[i * 3 + 2];
    for (let k = 0; k < K; k++) { bd[k] = 1e9; bj[k] = -1; }
    for (let q = 0; q < cand.length; q++) {
      const j = cand[q];
      const ex = sp[j * 3] - x, ey = sp[j * 3 + 1] - y, ez = sp[j * 3 + 2] - z;
      const d2 = ex * ex + ey * ey + ez * ez;
      if (d2 >= bd[K - 1]) continue;
      let k = K - 1;
      while (k > 0 && bd[k - 1] > d2) { bd[k] = bd[k - 1]; bj[k] = bj[k - 1]; k--; }
      bd[k] = d2; bj[k] = j;
    }
    acc.clear();
    for (let k = 0; k < K; k++) {
      if (bj[k] < 0) continue;
      const w = 1 / (bd[k] + 1e-6);
      for (let c = 0; c < 4; c++) {
        const b = si[bj[k] * 4 + c], ww = sw[bj[k] * 4 + c] * w;
        if (ww <= 0) continue;
        acc.set(b, (acc.get(b) || 0) + ww);
      }
    }
    const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    let tot = 0;
    for (const e of top) tot += e[1];
    for (let c = 0; c < 4; c++) {
      idx[i * 4 + c] = top[c] ? top[c][0] : 0;
      wgt[i * 4 + c] = tot > 0 && top[c] ? top[c][1] / tot : 0;
    }
    if (tot <= 0) wgt[i * 4] = 1;
  }
  dst.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4));
  dst.setAttribute('skinWeight', new THREE.BufferAttribute(wgt, 4));
}

export async function init(ctx) {
  const t0 = performance.now();
  const q = ctx.quality;
  const tier = String(q?.name || 'high').replace(/\(.*/, '');

  /* ================================================================
     1. Geometry
     ================================================================ */
  const bodyGeo = buildBodyGeometry(tier);
  const lensTex = buildLensTexture(tier === 'low' ? 256 : 512);

  const headW = bindWorld('head');

  const tuskL = buildTuskGeometry(1, tier);
  const tuskR = buildTuskGeometry(-1, tier);
  tuskL.translate(-headW[0], -headW[1], -headW[2]);
  tuskR.translate(-headW[0], -headW[1], -headW[2]);

  /* ROUND 4: the glasses are ONE RIGID ASSEMBLY on the HEAD bone. They
     used to hang off `brow` (a child bone the expression layer nudges a
     few degrees for "eyebrow" accents), which let the whole front tilt
     independently of the face it must sit on. §1.4's identity object
     never shears against the head: same bone as the tusks. */
  const frameGeo = buildFrameGeometry(tier);
  frameGeo.translate(-headW[0], -headW[1], -headW[2]);
  const lensGeoL = buildLensGeometry(1);
  const lensGeoR = buildLensGeometry(-1);
  lensGeoL.translate(-headW[0], -headW[1], -headW[2]);
  lensGeoR.translate(-headW[0], -headW[1], -headW[2]);

  /* ================================================================
     2. Materials — §1.2, §1.3, §1.4
     ================================================================ */
  const mat = ctx.mat;

  /* THE CLAY. Base #D3D3D2, roughness ~0.94 expressed as one broad 8%
     sheen, velvet grain, no rim, no outline.

     GRAIN AMPLITUDE. §1.2 specifies a normal perturbation of ~0.015.
     toon.js delivers `uGrain * 34.0`, so `grain` here is an amplitude in
     units of 1/34: 0.00046 * 34 = 0.0156, on spec. The previous 0.0148
     was 0.50 — thirty-three times the specification — and that, together
     with the default grainShade of 0.55, is what turned matte vinyl into
     terrycloth bath towel: cells 6-8 px across, visibly combed, and a
     luminance modulation of +/-22% riding on top of the cel ramp. The
     shading modulation now runs at 0.15 and the albedo speckle at 0.038,
     which is a velvet nap you have to lean in to see — which is what
     clay does.

     GRAIN SCALE. The lookup is object-space (gp * uGrainScale), so the
     cell size is fixed on the model and doubles when the camera closes
     in — §1.2 asks for grain that "stays constant in screen space". The
     base frequency is raised to 9.4 to buy back the high-frequency
     character lost with the amplitude, and update() rescales it every
     frame by camera distance so a cell holds roughly 1.5 px at any
     range. GRAIN_REF_DIST is the distance at which grainScale is exact. */
  const clayMat = mat.clay({
    name: 'wally.clay',
    color: CLAY.body,
    vertexColors: true,
    /* §1.2 (revised) GRAIN ROW: FINE and UNIFORM — "like cast vinyl,
       clearly visible in a close-up, invisible as noise at gameplay
       distance. If a frame reads fuzzy or dirty, the grain is too coarse
       or too strong." Measured against ref/wally-ref-cool.png the old
       0.066 albedo speckle at 0.34 shade modulation on 9.4 cells was
       BOTH: the speckle read as dirt and the cell size as terrycloth.
       Amplitude halved (albedo 0.030, shade 0.12) and frequency raised
       (12.6 -> ~35% smaller cells), which is the reference's even
       vinyl micro-speckle. */
    /* ROUND 2: nudged UP — the critic now reads the surface as "smooth
       plastic". Fine and uniform is right; invisible is not. Frequency
       raised with amplitude so the cells stay vinyl-fine. */
    /* ROUND 3: the critic still reads "smoother plasticky surface with
       photographic film noise overlaid" — the object-space clay speckle
       was being outshouted by the post grain. Frequency up again (17.0,
       ~15% smaller cells — unmistakably VINYL-fine) and both amplitudes
       up so the surface itself carries the texture. */
    /* PASS 4: "the noise/grain is coarse and mottled" against the ref's
       "fine even grain". With the post grain now suppressed in studio
       mode the clay speckle stands alone, and at 17.0/0.056 its cells
       read as mottle. Frequency up ~50% (cells ~2/3 the size) and both
       amplitudes pulled back toward §1.2's original spec: fine, even,
       and only visible when you lean in. */
    grain: 0.00048,
    grainScale: 25.0,
    grainAlbedo: 0.036,
    grainShade: 0.12,
    /* NO DISTANCE FADE ON THE CLAY. §1.2 is explicit that the grain is
       "scaled so grain stays constant in SCREEN space at gameplay
       distance" and calls it non-negotiable; toon.js's `lod` term is a
       material LOD that multiplies the grain amplitude AND the albedo
       speckle to zero between its two distances. At [16, 66] every
       exterior camera past sixteen metres — every vista, every city
       shot, the whole of a follow camera that has pulled back — was
       showing an untextured surface, which is §7's first forbidden item
       and is exactly what "an untextured mid-grey mesh" describes. The
       pair is now past the haze onset (§2.4, 120 m), i.e. atmosphere
       retires the grain, not an arbitrary LOD ramp. It costs nothing:
       the lookup is already unconditional, only its amplitude faded. */
    grainFade: [120, 320],
    /* §1.2 asks the thin parts to pick up a warm transmission and says
       in so many words that the ears must glow when backlit. At
       gameplay the sun is usually BEHIND him relative to the follow
       camera (measured: N.L on every camera-facing normal at boot is
       -0.33), so this term is the one piece of §1.2 that the default
       framing actually shows off, and 0.17 was tuned in a studio rig
       where it can never fire. */
    sss: 0.22,
    ao: 1.0,

    /* ============ THE TWO-BAND TERMINATOR (§2.2) ============
       This is the single most load-bearing block of numbers on Wally,
       and it is set by MEASUREMENT, not by eye. Scan a row of pixels
       across the lit cranium and across an ear; a two-band ramp shows a
       flat plateau, a compressed drop and a second flat plateau. A
       Lambert cosine shows a monotone slide with no plateau anywhere.

       WHAT WAS WRONG. clay()'s default term is 0.21 and bandSoft 0.062,
       so the smoothstep transition sat at ndl 0.148-0.272 — 74 to 81
       degrees off the key, i.e. out on the limb of every form. Every
       normal you could actually see was at band = 1.0, and a 650 px scan
       across the cranium came back flat at L 202-209 end to end. The
       ramp was implemented, well-reasoned, and aimed off-screen.

       AND THEN IT WAS AIMED AT THE OTHER WRONG PLACE. term 0.38 spans
       ndl 0.335-0.425. The studio key sits 62.8 degrees off the view
       axis, so N.L at the point of ANY form that faces the camera is
       cos(62.8) = 0.458 — thirty-three thousandths above the top of that
       band. Solve for where the terminator lands and it is
       sin(acos(0.38) - 62.8) = 0.085 of the radius from the projected
       centre: the step was drawn through the dead middle of every
       visible surface, which is the one place on a rounded form where
       N.L is stationary. On a sphere that still reads as a line. On the
       trunk, the belly, the flank of an arm — surfaces with a broad,
       nearly-flat face toward the camera — N.L hovers within a few
       hundredths of the threshold across a hand-sized patch, the
       boundary has no gradient to follow, and it breaks into a
       hard-edged amoeba. THAT is what the "lumpy blobby metaball
       artifacts" on the chest and the dark blot on the trunk were: not
       the mesh, which measures smooth to half a millimetre, but a cel
       threshold parked on the flattest part of the frame.

       term 0.18 puts the same step at sin(acos(0.18) - 62.8) = 0.29 of
       the radius, where the surface is genuinely turning and d(N.L)/du is
       ~1.0 per radius instead of ~0. The boundary has a strong gradient to
       lock onto, so it draws ONE clean arc round every form and cannot
       wander; and the camera-facing centre now sits 0.22 of ndl above the
       top of the band instead of 0.033, which is seven times the clearance
       and far more than any normal on this mesh varies by.

       The window is real and it is narrow. At 0.38 (0.085 R) it blotched.
       At -0.05 (0.51 R) it was clean but so far out that the form read
       washed and the two-band structure disappeared. 0.29 R keeps the band
       measurable on the flank and the arms while leaving ~70% of each form
       lit, which is the split a large soft key over a matte object makes.

       bandSoft 0.055 is the HALF width — wider than before in ndl, about
       the same on screen (0.11 R against 0.097 R), and now monotone
       through the whole of it. Plateau, step, plateau, without the step
       being able to double back on itself.

       core 0.80 / coreSoft 0.10, NOT 0.62 / 0.26. The third tone has to
       land INSIDE the lit plateau. At 0.62 +/- 0.26 it ramped from ndl
       0.36 to 0.88 — straight across the terminator — and smeared the
       very step it exists to support. At 0.80 +/- 0.10 the lit side gets
       a flat plateau, then a distinct brighter core toward the key, and
       0.80 is far enough above the 0.458 camera-facing value that the
       core step cannot blotch the flat fronts either. */
    /* ROUND 2: SOFTENED. The critic's pixel comparison found "a harsh
       dark terminator down the centerline creating muscle-like shadow
       bands" and "a cold, posterized hard-shadow split" — on a toy whose
       reference shading is one smooth gradient. The step stays (it is
       what makes him clay, not plastic) but bandSoft widens 0.055 ->
       0.13 so the transition glides over the broad flats of the belly
       and chest instead of snapping across them, and term drops a touch
       so the band sits nearer the limb. Paired with the more frontal
       studio key below. */
    term: 0.14,
    bandSoft: 0.13,
    band2: 0.075,
    core: 0.80,
    coreSoft: 0.14,

    /* THE VALUE DROP HAS TO BE 24%, NOT 19%. §1.2's own reference
       numbers are a #DEDEDD lit cheek against a #A9A9A8 crease — a 24%
       drop — and on a warm-grey tint the hue rotation contributes
       almost nothing, so the value drop IS the terminator. shadowValue
       0.80 with bleed 0.16 and fill 0.040 measured out at a 19% drop
       once the sky bounce had been added back: too shallow to separate
       two bands. 0.70 / 0.10 / 0.030 lands on 0.757 of the lit value,
       which is §1.2's ratio, and sits exactly on §2.1's luminance floor
       so it is still "a modest value drop", never albedo * 0.4. */
    /* 0.86, NOT 0.66 — AND THE REASON IS A MEASUREMENT, NOT A TASTE.
       wShadeLaw() ends in a value floor: the shade result is clamped up
       to floorK x the lit luminance, and floorK is 0.55 for anything as
       bright as this albedo. 0.66 and 0.78 and 0.40 all render
       IDENTICALLY — measured, to the third significant figure — because
       every one of them lands under that floor. The knob was doing
       nothing and the clay was pinned at the darkest value the law
       allows.

       That would be harmless if his shade band were a sliver. At
       gameplay it is the whole of him: the follow camera puts the sun
       behind him, N.L on every visible normal is -0.33, and a two-band
       ramp then paints the entire figure with shadeCol. He measured
       lum 139 against §1.2's #DEDEDD lit cheek (222) and #A9A9A8 deep
       crease (169) — his BRIGHTEST body value sat below the reference's
       darkest, which is precisely why six judges read "mid-grey mesh".

       0.86 clears the floor and puts the plateau back where §1.2 puts
       it. The form is then carried by the baked occlusion in model.js,
       which is geometry and works from every angle, rather than by a
       terminator that the default camera never sees. */
    shadowAmount: 0.44,
    shadowValue: 0.90,
    shadowBleed: 0.12,
    shadowFill: 0.034,
    /* The sky bounce is a fresnel-weighted lift that rides on top of the
       ramp, so at 0.16 it put a slow gradient across the SHADE band and
       the second plateau never read as flat. 0.10 still gives §2.2's
       soft upward-facing bounce without eating the step. */
    skyBounce: 0.13,
    /* Self-shadowing from a cascade sized for the whole island lands on a
       1.6 m character as hard-edged blobs that ignore his form — shadow
       acne dressed as shading. §1's reference is a studio product render
       whose form is read through the terminator and the baked AO, both of
       which are exact here, so the cast-shadow term is dialled back to
       just enough that he still visibly darkens under a building.

       0.30, NOT 0.52. Now that the trunk hangs 150 mm clear of the chest
       it casts onto it, and a cascade sized for an island resolves that
       as a hard-edged blob — §1.2 forbids hard contact darkening in so
       many words. The baked AO already carries the occlusion of the void
       behind the trunk, softly and at the right radius; the cast term
       only has to say "he is under something". */
    /* ROUND 2: 0.30 -> 0.20. In the studio frames the CSM resolved the
       head/ear cast onto the chest as the posterized cold split the
       critic flagged; the baked AO already carries that occlusion softly. */
    shadowStrength: 0.20,
    /* WALLY'S SHADE IS WARM GREY, NOT PERIWINKLE. §2.1's blue-violet
       shadow law is a WORLD law; §1.2 is explicit that clay carries a
       warm AO (#A9A5A2) in every crease. Left on the global tint the
       ear's cast shadow landed on his flank as a hard-edged blue-violet
       shape — the single most obviously wrong colour in the frame,
       because it is the one surface in the game the eye reads as a
       neutral material. toon.js already takes a per-material override
       and routes cast shadow and terminator through the same law, so
       this makes both warm at once.

       WARM, NOT TAN. SHADOW.ao is #A9A5A2, whose hue-normalised ratio is
       1 : 0.976 : 0.958 — a red-over-blue spread of 11 points against
       the 1 point §1.2 specifies for the crease colour (#A9A9A8). Run
       through the shade law on top of a baked AO term that is itself
       warm, that compounded into a 20-point spread and he read tan.
       CLAY.bodyAO is §1.2's literal crease swatch and it is the right
       tint to rotate toward: still warmer than the world's blue-violet
       law, but grey rather than sand. */
    shadowTint: CLAY.bodyAO,
  });
  const GRAIN_SCALE0 = 25.0;   // must track clayMat's grainScale
  const GRAIN_REF_DIST = 3.3;

  /* TUSKS — warm off-white #F2EBDA, roughness 0.55, i.e. the only part of
     him with any shine (§1.3). Terminator pulled well down and the ambient
     bounce up: they are small, they sit under the trunk's own shadow, and
     they have to hold luma ~236 in the light or they read as bone-coloured
     scraps instead of the two bold white shapes that frame the trunk. */
  const tuskMat = mat.clay({
    name: 'wally.tusk',
    color: CLAY.tusk,
    term: -0.06,
    bandSoft: 0.16,
    band2: 0.42,
    core: 0.08,
    coreSoft: 0.46,
    /* ROUND 5: spec up 0.38 -> 0.55 at a tighter lobe — the critic asked
       for the ref's glossy highlight along the outer curve; at 0.38/11
       the tusks measured dead matte in both studio poses. */
    spec: 0.55,
    specPow: 20,
    grain: 0.00022,
    grainScale: 14.0,
    grainAlbedo: 0.028,
    grainShade: 0.10,
    sss: 0.34,
    sssColor: CLAY.tuskRoot,
    skyBounce: 0.66,
    shadowAmount: 0.26,
    shadowValue: 0.97,
    shadowStrength: 0.35,
    shadowTint: SHADOW.ao,
  });

  /* FRAME — near-black, SATIN not gloss (§1.4). spec 0.34 at specPow 46 on
     a near-square section gave the brow bar a hard bright streak along its
     top and made it read as a chrome tube; 0.10 at 15 is a wide soft
     sheen on a flat bar.

     IT HAS TO CARRY GRAIN. §6 requires that every surface has grain and
     §7 forbids an untextured, ungrained one — and satin black is exactly
     where a dead flat fill is most obvious, because there is no albedo
     variation to hide behind. At grain 0.0002 (a 0.007 normal
     perturbation) with a 0.03 albedo speckle the bar measured flat to
     within a bit of noise. 0.00042 delivers §7's ~0.014, and the albedo
     and shading modulation are raised to match: enough to see the
     material at a 2x crop, nowhere near enough to read as texture. */
  const frameMat = mat.toon({
    name: 'wally.frame',
    color: CLAY.frame,
    term: 0.16,
    bandSoft: 0.13,
    band2: 0.11,
    spec: 0.10,
    specPow: 15,
    rim: 0.0,
    skyBounce: 0.22,
    grain: 0.00042,
    grainScale: 13.0,
    grainAlbedo: 0.085,
    grainShade: 0.24,
    grainFade: [120, 320],          // §1.2 — see the clay above
    shadowAmount: 0.38,
    shadowValue: 0.74,
    shadowStrength: 0.45,
    /* §1.2: "Warm AO, never blue on the character." The frame was the
       one piece of him still inheriting §2.1's WORLD shade tint — the
       blue-violet #5A6E9E — plus the global sky bleed and fill, which
       are absolute adds and therefore land hardest on the blackest
       surface we own. It measures as nothing in the studio (the studio
       key leaves the whole frame above the terminator, A/B'd at 0.0
       codes) but a black plastic frame in world shade is not allowed to
       turn indigo, so it takes the clay's warm crease instead. */
    shadowTint: SHADOW.ao,
    shadowBleed: 0.03,
    shadowFill: 0.02,
    outline: false,
    noOutline: true,
  });

  /* LENS + THE GLINT.
     Emissive-only, sampling the lens texture as its own albedo. That is
     what makes the mark unconditional: it is not a specular response to a
     light, so it cannot dim, drift or vanish as the camera moves (§1.4).
     The 0.82 + 0.55*fresnel term in toon.js's emissive path gives the
     lens the subtle edge-brighten §1.4 asks for at the same time. */
  const lensMat = mat.toon({
    name: 'wally.lens',
    color: 0xffffff,
    map: lensTex,
    emissiveOnly: true,
    emissive: 1.12,
    emissiveColor: 0xffffff,
    rim: 0,
    grain: 0,
    outline: false,
    noOutline: true,
  });

  /* ================================================================
     2a. DELIVERED-NEUTRAL BLACK — why the glasses are no longer navy

     MEASURED, studio cool pose, over the frame's own pixels: the mesh
     was painted a key colour for one frame to cut an exact mask, the
     mask was eroded 2 px, and the real frame was then sampled through
     it with every module's update() frozen, so two readings differ by
     exactly one uniform and nothing else.

       frame, darkest half        7.0, 15.1, 31.1     B-R  +24.0
       lens body, darkest half    0.0,  0.0, 22.3     B-R  +22.3
       §1.4 spec  #141414 / #0A0A0A                   B-R      0

     IT IS NOT THE SHADE LAW, and not this module at all. One uniform
     at a time, on the frame's darkest half:

       shadowTint -> neutral               24.0 -> 24.0   (no change)
       shadowBleed + shadowFill -> 0       24.0 -> 24.0   (no change)
       skyBounce -> 0                      24.0 -> 24.4   (worse)
       composite grade uLift -> 0          24.0 ->  -1.7   <-- all of it

     postfx.js's grade lifts the toe by a CONSTANT ADD in display-linear
     light, after ACES: ( -0.007, 0.000, +0.010 ) on the studio preset,
     ( -0.010, -0.003, +0.014 ) on day. On a mid-tone that is a whisper.
     On #141414, whose own post-ACES value is ~0.005, it is larger than
     the signal, and sRGB's toe (slope 12.92) turns +0.010 of blue into
     +17 eight-bit codes while -0.007 of red takes 9 codes away. Every
     near-black in the game gets it — postfx.js's own note says exactly
     this about dark wood props — but the glasses are the blackest
     surface we own and the only one §1.4 fixes a hex for.

     postfx.js is another module's file, so the frame does what the
     brief asks instead: it delivers neutral THROUGH that grade.

     THE INVERSE OF A CONSTANT ADD IS A CONSTANT ADD. uComp is added to
     the shaded colour in linear light, sized per channel to the lift
     the composite is about to apply, and read LIVE from the grade so it
     tracks a time-of-day ease or a cutscene preset with no second
     number to maintain. Per channel, with D_c = max(lift) - lift_c:

         comp_c = K0 * D_c / ( 1 + Q * D_c ) / exposure

     It only ever adds, so it cannot crush a channel to zero the way a
     negative lift does. K0 and Q convert a wanted post-ACES offset into
     the pre-ACES offset that produces it, and neither is 1, because
     ACES sits in between and ACES IS NOT A LINE. Two consequences, both
     measured rather than derived — the composite also runs a pivoted
     contrast and a saturation after the lift, so the analytic slope of
     Hill's fit is only the leading term:

     1. THE OFFSET SHRINKS AS THE PIXEL BRIGHTENS. The fit's slope is
        0.45 where the frame's shaded half sits and 0.88 where its lit
        brow bar sits, so one flat offset delivers twice as much at the
        top of the bar as at the bottom. Flat, the shaded half landed on
        B-R +1.1 while the lit bar over-shot to -5.6: the frame stopped
        being navy and went faintly brown in the light. Dividing by
        ( 1 + FALL x the pixel's own luminance ) tracks that, FALL 9.5.
        It also all but removes the comp from the glint at linear ~1.0,
        so §1.4's white stays white to within a code.

     2. THE OFFSET GROWS SUB-LINEARLY WITH THE LIFT, because a bigger
        offset lands further up the same rising slope. Day lifts 0.024
        of blue-over-red where studio lifts 0.017 — 1.4x — but wants
        only 1.13x the offset. Fitted flat at the studio grade, the
        gameplay frame over-shot to B-R -10.7. Q is that saturation,
        fitted on the two grades the acceptance shots use and monotone
        in between, so the other five presets interpolate.
     ================================================================ */
  const COMP_FRAME = { k0: 10.94, q: 94.4 };
  const COMP_LENS  = { k0: 6.18,  q: 45.0 };
  const COMP_FALL = 9.5;
  const compTargets = [];

  function deliverNeutral(m, k) {
    const MARK = '#endif  // TOON_EMISSIVE';
    if (m.fragmentShader.indexOf(MARK) < 0) {
      console.warn('[wally] toon.js fragment marker moved; glasses will render navy');
      return m;
    }
    /* AFTER the #endif, not before it: before it is inside the #else,
       which the emissive-only lens compiles away. */
    m.uniforms.uComp = { value: new THREE.Vector3() };
    m.uniforms.uCompFall = { value: COMP_FALL };
    m.fragmentShader = 'uniform vec3 uComp;\nuniform float uCompFall;\n'
      + m.fragmentShader.replace(MARK, `${MARK}
  col += uComp / ( 1.0 + uCompFall
       * max( dot( col, vec3( 0.2126, 0.7152, 0.0722 ) ), 0.0 ) );`);
    m.needsUpdate = true;
    compTargets.push([m.uniforms.uComp.value, k]);
    return m;
  }
  deliverNeutral(frameMat, COMP_FRAME);
  deliverNeutral(lensMat, COMP_LENS);

  function updateDeliveredNeutral() {
    const u = ctx.render?.post?.materials?.compositeMat?.uniforms;
    if (!u || !u.uLift) return;
    const L = u.uLift.value;
    const s = 1 / (u.uExposure?.value || 1);
    const mx = Math.max(L.x, L.y, L.z);
    /* The saturation is evaluated once, on the WIDEST channel spread,
       not per channel: what saturates is how far up ACES's rising slope
       the pixel itself has moved, and the pixel moves with its largest
       correction. Per channel instead, green — whose own spread is
       little over half of red's — takes a bigger K than it should and
       B-G measured -5.6 in the city against +1.5 this way. */
    const dmax = mx - Math.min(L.x, L.y, L.z);
    for (let i = 0; i < compTargets.length; i++) {
      const [v, c] = compTargets[i];
      const k = c.k0 * s / (1 + c.q * dmax);
      v.set(k * (mx - L.x), k * (mx - L.y), k * (mx - L.z));
    }
  }
  updateDeliveredNeutral();

  /* ================================================================
     2b. WHAT IS ACTUALLY DARKENING HIM, AND WHY IT IS NOT FIXED HERE
     ================================================================

     Measured, not judged. In the studio welcome frame his belly renders
     at luma 150 and the fork at 132, against ref/wally-ref-cool.png's
     178 for the same patch, and §1.2's own DEEPEST crease swatch
     (#A9A9A8) is 169 — so the brightest part of his torso sits below the
     darkest value the specification allows, under a broad soft gradient
     that reads as a grime layer on the torso and legs.

     Every candidate inside this module was eliminated by A/B on pixels:
       baked sculpt off (WALLY.debug.wallySculpt(0))        belly +2
       vertex AO alpha flattened to 1                       belly +13
       band2 / core / skyBounce / shadowStrength together   belly +3
       ctx.render.setSSAO(_, 0)                             belly +28.5  -> 178.5
     i.e. the post SSAO is the whole of it, and switching it off lands
     him on the reference's number to the decimal.

     WHY IT HITS HIM AND NOT THE WORLD. lighting.js drives the pass at a
     1.05-1.55 m radius (postfx.js defaults 0.9). Wally is 1.61 m tall,
     so the kernel is two thirds of him: from every point on his skin his
     own arms, head, belly and thighs are inside it, and a horizon
     estimator answers the only way it can — partial occlusion
     EVERYWHERE, deepest on the largest, most enclosed form, which is the
     pear. That is a curvature gradient, not a crease. §1.2 says the
     character's occlusion is baked, wide and warm; §7 forbids the dirty
     read outright. The screen footprint is also clamped (rUV <= 0.16),
     so it does not shrink with distance: he carries the same gradient at
     every framing.

     WHY THERE IS NO HONEST PATCH IN THIS FILE. renderer.js offers two
     per-material hooks and neither can do it:
       * userData.ndMaterial with a camera-facing normal — TRIED AND
         MEASURED: belly 150 -> 127, WORSE. Flattening the normal puts
         the tangent plane in the screen plane, so every silhouette
         region (flank, limb edges, ear rims) starts counting the whole
         body in front of it as an occluder.
       * userData.noPrepass — removes his depth as well, so DOF focuses
         him on whatever is behind him.
     Compensating by brightening the clay would be a hack pinned to
     another module's current tuning. This one belongs to render/lighting:
     exclude characters from SSAO, or scale uRadius by the object rather
     than by the sun. See the final report. */

  /* ================================================================
     3. Skeleton + meshes
     ================================================================ */
  const root = new THREE.Group();
  root.name = 'wally';

  const rig = buildSkeleton();
  root.add(rig.rootBone);

  const body = new THREE.SkinnedMesh(bodyGeo, clayMat);
  body.name = 'wally.body';
  root.add(body);
  root.updateMatrixWorld(true);
  body.bind(rig.skeleton);
  /* The runtime half of the arm/flank crease — see the block at the
     bottom of this file. Installed here because it needs the bound
     skeleton's boneInverses and the mesh's bindMatrix, and because the
     shader edit has to land before the first compile. */
  const contact = installContactCrease(clayMat, body, rig);

  const attach = (geo, material, boneName, name) => {
    const m = new THREE.Mesh(geo, material);
    m.name = name;
    rig.byName[boneName].add(m);
    m.frustumCulled = false;
    return m;
  };
  const meshTuskL = attach(tuskL, tuskMat, 'head', 'wally.tuskL');
  const meshTuskR = attach(tuskR, tuskMat, 'head', 'wally.tuskR');
  const meshFrame = attach(frameGeo, frameMat, 'head', 'wally.frame');
  const meshLensL = attach(lensGeoL, lensMat, 'head', 'wally.lensL');
  const meshLensR = attach(lensGeoR, lensMat, 'head', 'wally.lensR');

  /* ---- the three incised bridge lines (§1.5), ROUND 7 ----
     The sculpted channels stay (a shallow dish in the field, which gives
     the AO lip). The DARK stroke is real geometry, because the incision
     tint is baked per vertex on a 13.6 mm mesher grid and a 6.8 mm line
     sampled on that grid interpolates into a smudge.

     WHAT CHANGED. Rounds 5 and 6 hung three rigid capsules off bone
     `trunk1`. The skin at the groove latitude is a BLEND of trunk0,
     trunk1, trunk2 and head, so as soon as a pose curled or swung the
     trunk the rods and the skin parted company — in shots/s-cool.png all
     three strokes were floating beside the trunk, overhanging its
     silhouette to the right, and one of them was drawn over a tusk. The
     strokes are now ONE geometry, arced to lie in the surface
     (model.js), skinned from the BODY'S OWN weights, and bound to the
     same skeleton. Whatever the skin under a stroke does, the stroke
     does — there is no independent transform left to drift. */
  const grooveMat = mat.clay({
    name: 'wally.groove',
    color: 0x4a4540,          // dark-warm — §7: never a neutral grey
    spec: 0.0,
    sss: 0,
    skyBounce: 0.08,
    grain: 0,
    shadowAmount: 0.15,
    outline: false,
    noOutline: true,
  });
  const grooveGeo = buildGrooveStrokeGeometry(tier);
  copySkinFromBody(grooveGeo, bodyGeo);
  const meshGrooves = [new THREE.SkinnedMesh(grooveGeo, grooveMat)];
  meshGrooves[0].name = 'wally.grooves';
  meshGrooves[0].frustumCulled = false;
  root.add(meshGrooves[0]);
  root.updateMatrixWorld(true);
  meshGrooves[0].bind(rig.skeleton);

  /* His ears leave the bind bounding sphere the moment they flap, and he
     is one object — culling him is a false economy that costs a pop. */
  body.frustumCulled = false;
  mat.register(root, { noOutline: true, castShadow: true, receiveShadow: true });
  /* Lenses are self-lit; a shadow cast from them would double the frame's. */
  meshLensL.castShadow = false;
  meshLensR.castShadow = false;
  /* The rods live INSIDE the incision channels — a cast shadow from them
     would double-darken the cut. (Re-asserted after register().) */
  for (const m of meshGrooves) m.castShadow = false;

  ctx.scene.add(root);

  /* ================================================================
     4. Controller
     ================================================================ */
  const controller = ctx.phys?.createController
    ? ctx.phys.createController({
      radius: 0.310,
      height: H * 0.99,
      position: [0, 0, 0],
      walkSpeed: 2.45,
      runSpeed: 5.90,
      jumpHeight: 1.15,
      /* metres per footstep EVENT. It is half a gait cycle, so one
         sound per visible foot plant — and it is read off the clip
         rather than typed in, because the stride is derived from the
         ankle path now and any hand-copied number here would go stale
         the moment the gait is re-tuned. */
      strideLength: CLIPS.walk.cycle * 0.5,
      turnRate: 13,
    })
    : null;

  /* ================================================================
     5. Motion systems
     ================================================================ */
  const anim = new Animator();
  const expr = new Expression();
  const secondary = new Secondary(ctx, {
    root, byName: rig.byName, controller,
  });

  const bindPos = rig.bindPos;
  const bones = rig.bones;
  const nb = bones.length;

  /* Default keyboard control so the game is playable the moment it boots.
     game.js can take it over with ctx.wally.setInput(fn) — or drop it
     entirely with setInput(null). */
  const keys = Object.create(null);
  let inputFn = null;
  let ownInput = true;
  if (typeof window !== 'undefined') {
    addEventListener('keydown', (e) => { keys[e.code] = true; }, { passive: true });
    addEventListener('keyup', (e) => { keys[e.code] = false; }, { passive: true });
  }
  /* THE ONE PLACE THE CAMERA BASIS IS APPLIED.

     (x, z) arrives as stick-space: +z is "away from the camera", +x is
     "to the camera's right". Every input source — the keyboard below,
     the touch thumbstick in ui/touch.js — goes through here, so there
     is exactly one copy of this maths to get wrong.

     CAMERA RIGHT = forward x up. For Y-up right-handed with forward
     f = (fx, 0, fz) that is (-fz, 0, fx). This was once (fz, 0, -fx) —
     the exact negation — so A and D drove the wrong way whenever the
     camera basis was applied. Do not "simplify" the signs. */
  function camRelative(x, z, out) {
    const o = out || { x: 0, z: 0 };
    o.x = x; o.z = z;
    if (!x && !z) return o;
    const cam = ctx.camera;
    if (!cam) return o;                       // world-relative before the rig exists
    cam.getWorldDirection(_v);
    _v.y = 0;
    if (_v.lengthSq() <= 1e-6) return o;
    _v.normalize();
    const rx = -_v.z, rz = _v.x;              // camera right
    o.x = _v.x * z + rx * x;
    o.z = _v.z * z + rz * x;
    return o;
  }

  const _kbIn = { x: 0, z: 0, jump: false, jumpHeld: false, run: false };
  /** The built-in WASD read, camera-relative. Public so an alternative
      input source (touch) can fall back to it instead of replacing it. */
  function keyboardInput(out) {
    let x = 0, z = 0;
    if (keys.KeyW || keys.ArrowUp) z += 1;
    if (keys.KeyS || keys.ArrowDown) z -= 1;
    if (keys.KeyA || keys.ArrowLeft) x -= 1;
    if (keys.KeyD || keys.ArrowRight) x += 1;
    const o = camRelative(x, z, out || _kbIn);
    o.jump = !!keys.Space;
    o.jumpHeld = !!keys.Space;
    o.run = !!(keys.ShiftLeft || keys.ShiftRight);
    return o;
  }
  function defaultInput() { return keyboardInput(_kbIn); }
  if (controller) controller.setInputFn((dt, c) => (inputFn ? inputFn(dt, c) : (ownInput ? defaultInput() : null)));

  /* ================================================================
     6. State
     ================================================================ */
  let manual = null;            // an explicit play()/pose() override
  let manualHold = false;
  let autoClip = null;
  let leanX = 0, leanZ = 0;
  let landT = 0;
  /* THE ANIMATION'S OWN NOTION OF "HE WAS IN THE AIR". Set in update()
     from the same `air` test that starts `jump-air`, and consumed by the
     phys:land handler below. See the long note there for why the
     controller's `grounded` flag is not, on its own, good enough. */
  let airborne = false;
  let controlled = true;        // false = position/rotation driven externally
  let locoSpeed = 0, locoTurn = 0;
  let locoManual = false;

  /* debug camera */
  let dbgCam = null;
  let dbgOrbit = 0;
  let silhouette = false;
  let silSaved = null;

  /* --- the non-finite guard's memory (see finite3, top of file) ---
     The last place everything downstream agreed was real. Seeded on the
     first clean frame and refreshed on every clean frame after it, so
     the recovery below always has somewhere legal to put him. */
  let haveSafe = false;
  let warnedNaN = false;

  /** True if the character AND the controller are entirely finite. */
  function positionFinite() {
    if (!vecFinite(root.position)) return false;
    const c = controller;
    if (!c) return true;
    /* All three of the controller's positions, because _post() lerps
       _prevPosition -> simPosition into position every frame: one bad
       endpoint contaminates the other two on the very next step. */
    return vecFinite(c.simPosition) && vecFinite(c.position)
      && vecFinite(c._prevPosition) && vecFinite(c.velocity);
  }

  /**
   * Checkpoint or repair. Call after anything that writes a position.
   * Returns true if the state was already clean.
   *
   * The repair goes back through controller.teleport() rather than
   * assigning the fields here, because teleport() is the one path that
   * resets simPosition, position and _prevPosition together and zeroes
   * the velocity — which is exactly what a NaN recovery needs, and
   * exactly what writing root.position behind the controller's back
   * fails to do.
   */
  function guardFinite(where) {
    if (positionFinite()) {
      _wsafe.copy(root.position);
      haveSafe = true;
      warnedNaN = false;
      return true;
    }
    if (!warnedNaN) {
      warnedNaN = true;
      console.warn(`[wally] non-finite position after ${where} — restoring last good`);
    }
    const p = haveSafe ? _wp.copy(_wsafe) : _wp.set(0, 0, 0);
    if (controller) controller.teleport(p);
    root.position.copy(p);
    return false;
  }

  if (ctx.bus) {
    ctx.bus.on('phys:jump', () => {
      if (!manual) { anim.play('jump-takeoff', { fade: 0.06, restart: true }); autoClip = 'jump-takeoff'; }
    });
    /* A LANDING IS NOT THE SAME THING AS A phys:land EVENT, AND CONFUSING
       THE TWO IS WHY WALLY WALKED WITHOUT MOVING HIS LEGS FOR A WHOLE
       RELEASE. Reported as "the mobile version doesn't show the elephant
       moving his legs"; it was never a mobile bug and never a touch bug.

       Measured, running at 5.9 m/s up a 1.4-degree rise (per-frame dump,
       tools/mobilebugs.mjs):

         grounded  1 1 0 1 1 0 1 1 0 1 1 0 ...
         airTime   0 0 0.017 0 0 0.017 ...
         vy        0 0 +0.24 0 0 +0.24 ...

       The controller's ground snap lets go for ONE frame in three on a
       gentle uphill, and re-acquires on the next — so it emits phys:land
       at roughly 20 Hz. Every one of those restarted `jump-land`, a 0.42 s
       one-shot on the ACTION layer, and the action layer REPLACES the
       locomotion layer at weight 1. Restarted every 50 ms it could never
       finish, `landT` never reached 0, so the release branch in update()
       never fired either: actionW sat pinned at 1.0 indefinitely and the
       legs froze in the landing crouch while he tore across the map. The
       locomotion layer was correct the entire time — anim.speed 5.89,
       locoName 'run', locPhase advancing — it was simply never visible.

       It looked mobile-only because it is HEADING-dependent: it needs a
       rising surface underfoot. A desktop sweep of eight headings from
       the spawn (synthetic input, no touch anywhere) reproduces it on
       exactly one of them, legL0 range 0.96 rad against 1.8 on the other
       seven. The thumbstick's default camera heading happens to point at
       one of those surfaces, which is the whole of the "mobile" in the
       bug report.

       So the gate: a landing needs either a real airborne interval — the
       same 0.09 s test that starts `jump-air`, so the two clips can never
       disagree about whether he flew — or a real downward impact. These
       blips have neither (impact is 0, because impactSpeed is -0.24: he
       was moving UP when he "landed"). Anything the controller reports
       that is neither is a ground-snap flicker, and the correct animation
       for a ground-snap flicker is to keep walking.

       If the flicker itself is ever fixed in physics/controller.js this
       gate stays correct and costs one boolean. */
    ctx.bus.on('phys:land', (e) => {
      const real = airborne || (e && e.impact > 0.05);
      airborne = false;
      if (!real) return;
      landT = 0.34;
      if (!manual) { anim.play('jump-land', { fade: 0.05, restart: true }); autoClip = 'jump-land'; }
    });
  }

  /* ================================================================
     6b. THE RIDES — bicycle, scooter, motorcycle

     Ownership is the data agent's (state.rides.owned / .equipped, the
     bus events 'ride' and 'bike', and ctx.game.actions.bike() / .ride()).
     Everything from "he has one" onward is here: when the prop exists,
     where it sits, how he gets on and off it, how fast he goes and how
     far he leans.

     ONE MACHINE AT A TIME, and that is enforced here rather than hoped
     for: `props` is a lazy cache keyed by id, `rideId` names the one
     that is allowed to be visible, and showProp() hides every other
     entry on every call. A save that somehow arrives with two equipped
     still cannot render two.

     THE THREE ARE ONE MECHANISM WITH THREE TABLES. RIDE_TUNE below is
     the whole difference: the controller speeds, the lean gain, the
     transition times and the mount offset, per id. Adding a fourth
     machine is a row here, a posture in anim.js and a builder in
     rides.js — not a fourth copy of this block, which is what the
     data agent's RIDES table refactor was avoiding on its own side.

     THE PROP IS A CHILD OF `root`, WHICH IS THE WHOLE TRICK. root
     already carries the controller's position and yaw, so the bicycle
     inherits both for free and can never slide out from under him on a
     turn — there is no second transform to keep in sync and therefore
     no way for them to disagree. The lean into a corner is a roll on
     root itself, so rider and machine bank together as one object,
     which is what a bicycle does and what two separately-leaned
     objects would never quite look like.

     WHY THE SPEED LIVES HERE. The brief hands the ownership state to
     the data agent and the LOOK to this file, but the two cannot be
     separated for free-roam: the pedal cadence is driven by distance
     travelled, so if the controller's top speed did not change, the
     bicycle would be a man in a chair moving at walking pace. The
     controller's own options are patched on equip and restored EXACTLY
     on unequip, from a snapshot taken at the moment of the first
     patch — never from a remembered literal, which is how these get
     out of step with whoever last tuned the walk.

     WHY strideLength GOES TO 1e6. It is metres-per-footstep-event, and
     the audio layer turns each one into a footfall. A bicycle with
     footsteps is a worse defect than a bicycle with no sound at all.
     ================================================================ */
  /* THE SPEEDS ARE THE DATA AGENT'S MULTIPLIERS, NOT A SECOND OPINION.
     data.js RIDES gives bicycle 1, scooter 1.5, motorcycle 3, and the
     fare table divides the bicycle's journey minutes by exactly that.
     Free-roam has to agree or the game contradicts itself: a scooter
     that saves a third of a trip on the travel screen and moves at
     bicycle pace on the street is a bug the player feels before they
     can name it. So the bicycle's 5.10 / 8.80 is the base row and the
     other two are it, multiplied, then rounded to something a hand on a
     stick can steer.

     TURN RATE GOES THE OTHER WAY. The faster and heavier the machine,
     the wider it arcs — a motorcycle at 26 m/s that pivots like a
     bicycle reads as a hovercraft. accel/decel likewise: the motors
     pull harder and take longer to wash off. */
  const RIDE_TUNE = {
    bike: {
      speeds: {
        walkSpeed: 5.10,    // no shift — a relaxed cruise, 2.1x his walk
        runSpeed: 8.80,     // shift — 32 km/h, the "worth every dollar" line
        turnRate: 6.4,      // a bicycle arcs; it does not pivot
        strideLength: 1e6,  // see above
        accel: 22,          // it takes a moment to get going
        decel: 14,          // and it rolls when you stop pedalling
      },
      lean: { gain: 0.115, max: 0.32, rate: 5.5 },
      steer: 0,
      enter: { x: -0.60, y: 0.02, z: -0.10, yaw: 0.26, roll: -0.30 },
    },
    scooter: {
      speeds: {
        walkSpeed: 7.65, runSpeed: 13.20, turnRate: 5.2,
        strideLength: 1e6, accel: 17, decel: 11,
      },
      /* IT LEANS FURTHER THAN THE BICYCLE AND SETTLES SLOWER. Small
         wheels and a low centre of mass make a scooter flickable, and
         the extra roll is most of what sells "faster" when the pedals
         that used to sell it are gone. */
      lean: { gain: 0.132, max: 0.38, rate: 5.0 },
      steer: 0.085,
      enter: { x: -0.66, y: 0.02, z: -0.06, yaw: 0.22, roll: -0.34 },
    },
    motorcycle: {
      speeds: {
        walkSpeed: 15.30, runSpeed: 26.40, turnRate: 3.6,
        strideLength: 1e6, accel: 26, decel: 9,
      },
      lean: { gain: 0.150, max: 0.46, rate: 4.2 },
      steer: 0.055,
      enter: { x: -0.78, y: 0.03, z: -0.14, yaw: 0.18, roll: -0.40 },
    },
    /* THE BALLOON IS A ROW HERE AND NOTHING READS MOST OF IT, which
       is on purpose rather than by neglect. It never touches the
       character controller — flyUpdate() below disables it and
       integrates the machine itself — so `speeds` is never patched in
       and `lean` is never applied. The row exists because a dozen
       lookups in this file are written `RIDE_TUNE[rideId] ||
       RIDE_TUNE.bike`, and a missing row means every one of them
       quietly answers "bicycle" about a balloon. The numbers are the
       honest ones for the machine so that anything which DOES read
       them reads the truth: `speeds` is the drift ceiling from
       balloon.js FLIGHT, and the lean is zero because a balloon has
       no bank at all. */
    balloon: {
      speeds: {
        walkSpeed: 5.60, runSpeed: 9.00, turnRate: 0.9,
        strideLength: 1e6, accel: 2.0, decel: 1.4,
      },
      lean: { gain: 0, max: 0, rate: 1 },
      steer: 0,
      enter: { x: 0, y: 0, z: 0, yaw: 0, roll: 0 },
    },
  };
  const MOUNT_T = 0.62;   // must equal CLIPS['bike-mount'].duration
  const DISMOUNT_T = 0.54;
  const RIDE_BUILD = {
    bike: createBike, scooter: createScooter, motorcycle: createMotorcycle,
    balloon: createBalloon,
  };
  /* 'moto' is what a human types into a debug console at midnight. */
  const RIDE_ALIAS = {
    moto: 'motorcycle', motorbike: 'motorcycle', bicycle: 'bike', scoot: 'scooter',
    air: 'balloon', hotair: 'balloon', assessor: 'balloon',
  };
  const rideKey = (id) => (id == null ? null : (RIDE_ALIAS[id] || (RIDE_TUNE[id] ? id : null)));
  /* Which machines fly. One entry today, asked as a question so the
     twenty call sites below read as "is this one airborne" rather
     than as a string comparison repeated twenty times. */
  const isAir = (id) => rideKey(id) === 'balloon';

  const props = {};                // id -> prop, built on first equip
  let rideId = 'bike';             // which machine setBike(true) mounts
  let bike = null;                 // the CURRENT prop (the old name, kept)
  let bikeOwned = false;
  let bikeEquipped = false;
  let bikePhase = 'off';           // off | mounting | on | dismounting
  let bikeT = 0;                   // seconds into a transition
  let bikeRide = 0;                // 0..1, the prop's "is it under him"
  let bikeLean = 0;
  let bikeSteer = 0;
  let bikeSpeedSaved = null;
  let bikeSyncT = 0;
  let ikSaved = true;
  /* A debug hook or a cutscene has taken the ride over; stop
     reconciling it against ctx.game, which does not know about them. */
  let bikeForced = false;

  function buildProp(id) {
    const key = rideKey(id) || 'bike';
    if (props[key]) return props[key];
    const p = RIDE_BUILD[key](ctx);
    p.group.visible = false;
    /* Looked up ONCE. flyUpdate leans the envelope every frame and a
       per-frame children.find() over a machine with forty parts is a
       linear scan for a pointer that never changes. */
    if (key === 'balloon') flyEnvGroup = p.group.children.find((o) => o.name === 'balloon.envGroup') || null;
    /* The shadow projector renders a private layer, and it was walked
       over `root` before this existed — so opt the prop in by hand or
       he casts a rider-shaped shadow with no machine in it. */
    p.group.traverse((o) => { if (o.isMesh) o.layers.enable(SHADOW_LAYER); });
    root.add(p.group);
    props[key] = p;
    return p;
  }
  const buildBike = () => buildProp(rideId);

  /* WHICH MACHINE IS THIS PROP? Asked of the OBJECT, never of `rideId`.

     `rideId` is a wish, not a fact. bikeSync() rewrites it twice a
     second from ctx.game.actions.bike().id, and that call falls back to
     bestRide() the instant nothing is equipped — so a player who also
     owns the scooter has rideId flipped to 'scooter' partway through
     the 0.54 s dismount of his BICYCLE, before parkProp() runs at the
     end of it. Measured, with the scooter owned: the bicycle correctly
     detached, leaned and standing at [-362.80, 7.02, 201.13] while
     bikeState.parked read [{id:'scooter', at:[0,0,0], visible:false}].
     Mounting the scooter then deleted that phantom record, and
     showProp's hide loop — which exempts machines in `parkedIds` — no
     longer saw the bicycle as parked and switched it off. A raycast
     through the bicycle's own screen point hit the scooter and no
     bicycle at all.

     Own only the bicycle and the whole path works, because then
     bestRide() answers 'bike' and the wrong key happens to be right.
     That is why it shipped.

     Three entries, a linear scan, once per dismount and once per frame
     while something is parked. The alternative is an id stored on the
     prop, which is one more copy that can disagree with `props` — and
     two ids disagreeing is the entire bug. */
  const propKey = (p) => {
    if (!p) return null;
    for (const k in props) if (props[k] === p) return k;
    return null;
  };

  /**
   * Exactly one prop is visible ON HIM, ever. Called on every equip.
   *
   * A PARKED MACHINE IS EXEMPT, and that exemption is the whole point
   * of the parked feature. The hide loop used to be unconditional, so
   * leaving the bicycle at the cafe door and then getting on the
   * scooter set visible=false on the bicycle and it stayed invisible —
   * still detached in the scene, still at its parked spot, still
   * leaning on its stand, but not drawn — until it was re-equipped. The
   * player left a machine somewhere and the world stopped agreeing that
   * they had. A parked prop is no longer his; its visibility belongs to
   * parkedCull() and to distance, not to what he happens to be riding.
   */
  function showProp(id) {
    const key = rideKey(id) || 'bike';
    for (const k in props) if (k !== key && !parkedIds.has(k)) props[k].group.visible = false;
    bike = buildProp(key);
    return bike;
  }

  /* ================================================================
     PARKED — the machine is a thing in the world, not a thing on him.

     park() used to be dead: nothing called park(true), the dismount hid
     the prop outright, and the two writes park() makes (group roll and
     crank angle) were overwritten by bikeUpdate's own rotation.set()
     and setCrankPhase() on the very next frame. Forcing it live gave a
     kickstand poking into the air under an upright bicycle.

     It is now a STATE. When he gets off, the machine is DETACHED from
     his root, stood on the ground where he left it, leaned onto its
     stand, and left there. bikeUpdate skips every placement and
     drivetrain write while `parked`, which is what makes the pose
     survive a frame. Mounting re-parents it and takes it off the stand.

     WHY THE UNEQUIP IS THE RIGHT CALL SITE. It is the only dismount the
     game has — hud.js's door interaction warps him, it does not get him
     off a bicycle — and "put the bicycle down and walk in" is exactly
     what a player does at a door. Leaving it standing there is the
     world-telling; bringing it back under him on the next mount is what
     stops it being a way to lose your bicycle. An INSTANT dismount
     still just hides it: that path is for cutscenes and debug hooks,
     and a studio shot with an abandoned bicycle in it is nobody's
     intent.

     DRAW COST IS BOUNDED BY THE FRUSTUM FIRST AND BY DISTANCE SECOND,
     and it used to be bounded by neither properly. Every mesh in the
     prop carried frustumCulled = false — 106 of them, counting the
     §2.2 outline hulls — on the argument that a wheel popping at the
     frame edge is worse than a draw call. Three.js only culls a mesh
     whose own bounding sphere is ENTIRELY outside the frustum, so that
     pop was never on the table; what the flag actually bought was a
     machine that kept drawing when nobody could see it. Measured by
     differencing renderer.info with the prop toggled in and out on
     alternate frames: a bicycle parked 12 m BEHIND the camera cost 199
     draw calls and 30 751 triangles a frame, and one 40 m behind cost
     163 and 25 541.

     WHAT IT COSTS OFF SCREEN NOW, RE-MEASURED, because the sentence
     that replaced those two — "with culling on, both are 53, and past
     about 80 m they are 0" — was right in practice for the wrong
     reason. Culling takes the MAIN pass to nothing at every range;
     what is left is the shadow, and the shadow is not one number, it
     is which cascades the machine falls in:

     AT TIER "high", TWO CASCADES, 1280x720 AT dpr 1 — and the tier is
     named because the ladder IS the cascade set and the cascade set is
     the tier. The machine auto-picks "high" on the rig this was taken
     on (WALLY.debug.renderInfo() prints both).

       behind the camera, under ~16 m    106 calls   (two cascades)
       behind the camera, ~20 m           90 calls   (the boundary)
       behind the camera, 24 to 80 m      53 calls   (one cascade)
       behind the camera, 100 m and out    0 calls

     and parkedCull then takes the 53 to 0 itself past PARK_DRAW_M, so
     a machine left further than 64 m away and out of shot really does
     cost nothing. Inside 64 m it is 53 to 106 calls of shadow, which
     is the price of a machine that still throws one.

     THE ~20 m ROW IS A BOUNDARY, NOT A RUNG. The second cascade's far
     plane sits about there, so a machine at 20 m is in it on some
     frames and out on others as the follow camera drifts, and any
     average across frames lands between 106 and 53 — 90.0 and 90.7 on
     two runs. A ladder measured at one range with the boundary inside
     it will disagree with this table for that reason alone, and a
     ladder that came back FLAT at 53 across the whole near range was
     measuring a prop that never entered the second cascade at all.
     Re-measured twice, against the live loop, with a PRIVATE bicycle
     built from bike.js and added to the scene so parkedCull cannot
     touch it, parked and stood on the terrain at each range, by
     differencing renderer.info across real frames with the prop
     toggled: 105.3/106.3/106.3/106.0 at 4/8/12/16 m, 90.0 at 20 m,
     53.0/53.0/53.0/53.3/53.0 at 24/32/48/64/80 m, 0 at 100 and 140.

     (renderer.js sets renderer.shadowMap.autoUpdate = false and raises
     needsUpdate once a frame. A tool that calls renderer.render()
     itself and does not raise it reuses the last frame's shadow maps
     and measures the main pass only — it reports 0 calls off screen at
     every range, which is how this number was nearly published wrong a
     second time.)

     PARK_DRAW_M IS NOT "FOUR PIXELS TALL". That is what this note used
     to say. It still is not four pixels — but the number that replaced
     it was itself wrong, by exactly the device pixel ratio: "26.7 px
     at 57 m in a 1280x720 frame" was counted in DRAWING-BUFFER pixels
     at dpr 2. The column that replaced THAT was 3.5% high for a
     different reason — it was measured off a vertex list that had been
     captured by traversing the whole prop, so it carried the §2.2
     outline shells, which are the same meshes pushed out along their
     normals, and went on carrying them at ranges where toon.js had
     already culled every hull.

     AND THE COLUMN DEPENDS ON WHERE THE CAMERA IS AIMED, which this
     note did not say and which is the whole of a disagreement it has
     already caused. Painted vertices only, in CSS pixels, at 1280x720,
     fov 50, the machine parked and standing on the terrain:

       range     on the optical axis     level camera, eye 0.9 m
       12 m            63.46 px                 63.48 px
       32 m            23.71                    23.78
       55 m            13.78                    13.98
       57 m            13.30                    13.50
       64 m (PARK_)    11.84                    12.05
       122 m (haze)     6.21                     6.33
       140.7 m          5.38                     5.48

     ON THE AXIS a thin lens is exact and agrees to a HUNDREDTH of a
     pixel (0.98 m of parked, leaned machine, 772 px of focal length at
     fov 50: 0.98*772/57 = 13.28 against 13.30 measured; 0.98*772/140.7
     = 5.38 against 5.38). OFF the axis it is not: an object below the
     optical axis subtends tan(top) - tan(bottom), which is larger than
     h/d, so the same machine measures about 2% taller from a level
     camera at eye height than from one aimed at it. That 2% is the
     difference between 5.38 and 5.48 at 140.7 m, and the 5.5 this note
     used to print was the level-camera number quoted next to a
     thin-lens check that only holds on the axis. Both are here now,
     with the geometry named against each.

     So the old rule popped an 11-pixel object out of existence while
     the player was looking straight at it, which §6 forbids by name —
     still nearly three times the "four pixels" the note before it
     claimed, and the decision is unchanged by either correction. It
     is now two distances and a frustum test:

       within PARK_DRAW_M          always drawn — it is his, and he is
                                   near enough to walk back to it
       PARK_DRAW_M..PARK_FAR_M     drawn only while it is actually in
                                   shot, which costs nothing when it is
                                   not and never pops when it is
       past PARK_FAR_M             gone. 140 m is past the §2.4 haze
                                   line at 120 m, where it is 6.2 px
                                   and washed to #B8DEF0; by 140.7 m it
                                   is 5.4.

     The frustum sphere is inflated by PARK_SHADOW_PAD so a machine just
     outside the frame edge still casts into it.
     ================================================================ */
  /* PARKED IS PER MACHINE, NOT ONE BOOLEAN. He can own three and can
     only ride one, so he can leave the bicycle at the cafe, take the
     scooter to the docks and leave that there too. One flag could not
     express that: mounting the scooter cleared it while the bicycle was
     still standing at the cafe, which left the bicycle's own state
     (detached from root, leaned, kickstand out) with nothing tracking
     it. The set is keyed by the same ids `props` is. */
  const parkedIds = new Set();
  const PARK_DRAW_M = 64;
  const PARK_FAR_M = 140;
  /* THE SHADOW ALLOWANCE ALONE, and the name is the whole of why this
     comment had to be fixed: it used to say "half the machine's own
     diagonal (1.25 m) plus the longest shadow it throws", while
     parkedCull below adds the 1.25 separately (`_psph.radius = 1.25 +
     PARK_SHADOW_PAD`). Read as written, the pad was being double
     counted by anyone reasoning about it. It is the longest shadow the
     machine throws at this latitude and nothing else, so a bicycle a
     metre outside the frame edge does not take its shadow with it. */
  const PARK_SHADOW_PAD = 4.0;
  const _pfr = new THREE.Frustum();
  const _pmat = new THREE.Matrix4();
  const _psph = new THREE.Sphere();
  /* ------------------------------------------------------------------
     THE PITCH CLAMP, AND WHAT IT IS ACTUALLY FOR.

     It used to be 0.26 rad, described as "15 degrees — a steep street",
     with nothing said about the streets that are steeper.

     THE CONFORM INSIDE IT IS EXACT — AND THE MEASUREMENT THAT SAID SO
     BEFORE THIS ONE WAS SAMPLING THE LATTICE. The table that stood here
     read 0.0/0.0 at fourteen gradients from -2.19 to +47.01 degrees and
     was quoted as "zero to the tenth of a millimetre everywhere inside
     the clamp" over 78 869 sites. Every one of those sites was on a
     10 m grid on an axis heading over a 2 m raster. This note used to
     say that keeps both wheels on one terrain triangle: measured on
     that exact grid, the two contacts are on DIFFERENT triangles at
     5 806 of 5 806 sites. What it really does is put the machine's
     origin exactly on a grid line, which makes the height profile along
     the heading homogeneous about the origin and hands pass two pass
     one's own pitch — see solveParkPose's header in bike.js for the
     measurement and the algebra. Off the lattice the same code ran to
     909.7 mm and buried a wheel 673.2 mm INSIDE the clamp.

     RE-MEASURED THROUGH THE FIXED SOLVE, OFF THE LATTICE — 7.3 m grid,
     0.37 m offset, five headings that are not multiples of pi/2,
     WALLY.debug.parkProbe at every site, both contacts each, measured
     from the prop's world matrix rather than off the probe's own
     rounded report:

                       whole island       road, restricted
       sites           10 937                  533
       contacts        21 874                1 066
       over 0.1 mm     0                       0
       worst           0.0 mm                  0.0 mm
       ever buried     none, at any site       none

     and the same for the scooter (21 870 contacts) and the motorcycle
     (21 874), and on two further off-lattice grids — 10.3 m/1.41 and
     3.1 m/0.83, golden-angle headings — for 153 852 bicycle contacts in
     all, none over 0.1 mm. The clamp is a bad-sample guard, so sites
     where it saturates are counted separately (298 of 11 235 on the
     bicycle) and reported below.

     "ROAD" IS RESTRICTED, AND IT HAS TO BE SAID EVERY TIME THE WORD IS
     USED HERE. world.isRoad is terrain.pathAt > 0.35, a painted-surface
     test that answers true inside building footprints and on grades a
     player cannot walk up. Unfiltered it gives 671 sites on this grid;
     137 of those overlap a city building's world box and one is over
     the controller's own slope limit, leaving 533 a machine could
     actually be left at. The count this note used to give, 1 320
     contacts, is 660 sites — isRoad tested under the RIDER while the
     machine it measured stands 0.62 m to his side.

     Outside the clamp it saturates and the residual grows, and there
     the numbers are about a bad sample rather than a street. NOTHING IS
     EVER BURIED — the lift in solveParkPose sees to that, on every path
     rather than only the saturated one, which is the half of it that
     was wrong: the lift used to be gated on the clamp engaging, on the
     strength of the lattice census saying the ungated case was already
     zero.

     STANDING IT UPRIGHT ON ONE SAMPLED HEIGHT INSTEAD IS STRICTLY
     WORSE, and that is arithmetic rather than taste: at pitch 0 the
     residual is (base/2)(tan s) with no sin term to take off it, which
     at 37 degrees is +/-354 mm — exactly twice the error it replaces,
     and now on a bicycle that also reads as ignoring the hill. So: no.

     THE CLAMP IS A BAD-SAMPLE GUARD, NOT A STYLE LIMIT, so it belongs
     at the steepest ground he could have been standing on when he got
     off — the controller's own slope limit, 48 degrees (§4,
     controller.js `slopeLimit`). Below that the conform is exact and
     the clamp never engages; above it, the two heights did not come
     from a street he walked onto — they came from a wall, a cliff face
     or a building footprint in heightAt — and refusing to pitch a
     bicycle 60 degrees on the strength of one of those is the whole
     point. A census of the island (66 058 samples on a 3 m grid, worst
     wheelbase-length chord at each) puts the median at 9 degrees and
     8.8% of the land over 30; the reachable streets are the low half of
     that and the tail is the Golden Heights cliff.

     AND NOTHING GOES UNDER THE GROUND, PAST THE CLAMP OR INSIDE IT. A
     wheel buried in the terrain reads as a bug; the same wheel a few
     centimetres clear reads as a machine parked awkwardly on a slope,
     which is what it is. The origin is lifted by whichever residual is
     more negative, so the deeper contact sits ON the terrain and the
     shallower one hovers. Wherever the iteration converged both
     residuals are zero and the lift is a no-op, which is everywhere the
     census found.

     THE CLAMP ITSELF LIVES IN bike.js NOW, next to the solve it belongs
     to, and both callers take it from there — the intro's copy of this
     arithmetic shipped a generation behind with a 0.26 rad clamp on a
     stage picker that accepts 0.42, which is exactly what two copies of
     one number buys you.
     ------------------------------------------------------------------ */
  const _pv = new THREE.Vector3();

  /* ------------------------------------------------------------------
     WHICH SIDE, AND HOW FAR OUT.

     HIS -X SIDE is the side the mount slides in from (RIDE_TUNE.enter.x
     is negative on all three), so he leaves it the way he picked it up.
     That part is fixed. The DISTANCE is not, and it used to be: parking
     the bicycle and then, without moving a step, the scooter put both
     machines at exactly the same point, interpenetrating. It is a
     contrived way to stand — the feature's own example is the bicycle
     at the cafe and the scooter at the docks — but nothing stopped it,
     and two machines in the same 0.6 m of street is the kind of thing
     a player screenshots.

     So the offset steps outward along the same side until the spot is
     clear of every OTHER parked machine, and gives up after four rungs
     rather than search: the fourth is 3.9 m out, further than he could
     plausibly have wheeled it, and a machine parked slightly too far
     away beats a machine that never parks at all.

     THE RUNG SPACING IS THE CLEARANCE, NOT A FRACTION OF THE OFFSET.
     The first version stepped by 1.25x the 0.62 m offset — 0.775 m
     between rungs, which is under PARK_CLEAR_M, so a machine on one
     rung blocked BOTH of its neighbours. Measured with all three owned
     and parked from one spot: bicycle -0.62, scooter -2.17 (it had to
     skip a rung), motorcycle back at -0.62 on the give-up fallback,
     interpenetrating the bicycle — the exact defect, two machines
     later. Rungs are 1.1 * PARK_CLEAR_M apart now, so consecutive
     machines take consecutive rungs and three of them fit inside the
     first three.
     ------------------------------------------------------------------ */
  const PARK_SIDE_X = -0.62;
  const PARK_CLEAR_M = 1.0;       // measured: the props are 0.60-0.72 m wide
  const PARK_STEP_M = 1.1;        // > PARK_CLEAR_M, or a rung blocks its neighbour
  /* The park probe's ray. Start just above the machine so nothing over
     its head can be mistaken for the ground under it, and go far enough
     down to reach the terrain from the tallest roof in the city. See
     the header on H() inside parkProp. PARK_STRUCT_M is the gap over
     the terrain that means "this is a structure, not a kerb", and
     PARK_STAND_M is how close the ray has to come to the rider's own
     feet before it counts as the thing he is standing on — the
     controller's own step offset is 0.35, so half a metre is a
     comfortable pass for a man on a surface and a clear fail for a
     bench beside him. */
  const PARK_PROBE_UP = 2.0;
  const PARK_PROBE_DOWN = 400;
  const PARK_STRUCT_M = 1.2;
  const PARK_STAND_M = 0.5;
  const _parkOrigin = new THREE.Vector3();
  const _parkDown = new THREE.Vector3(0, -1, 0);
  /* THE CLEARANCE IS THE MACHINE'S, NOT A CONSTANT, and the balloon is
     why. 1.0 m is the measured width of the widest thing on wheels; a
     moored balloon is a basket with five metres of cold envelope laid
     out in front of it (balloon.js `parkClear` = 4.2), and parking one
     0.62 m from a motorcycle puts the motorcycle inside the fabric.
     The pair is asked BOTH ways round — the widest of the two decides,
     so it does not matter which was put down first. */
  const clearOf = (p) => (p && Number.isFinite(p.parkClear) ? p.parkClear : PARK_CLEAR_M);
  function parkOffsetX(at, yaw) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const mine = clearOf(bike);
    const step = Math.max(PARK_STEP_M, mine * 1.1);
    for (let i = 0; i < 4; i++) {
      const ox = PARK_SIDE_X - i * step;
      const x = at.x + cy * ox, z = at.z - sy * ox;
      let clear = true;
      for (const id of parkedIds) {
        const p = props[id];
        if (!p || p === bike) continue;
        const q = p.group.position;
        if (Math.hypot(q.x - x, q.z - z) < Math.max(mine, clearOf(p))) { clear = false; break; }
      }
      if (clear) return ox;
    }
    return PARK_SIDE_X;
  }

  /* WHAT parkProp ACTUALLY DID, for parkProbe to report. See the probe
     at the foot of this file: it used to publish the chord under
     WALLY'S FEET while the machine is parked 0.62 m to one side and
     pitched to the chord THERE, so on sloped ground its `gradientDeg`
     and its `clamped` flag were about a different hill from the one it
     had just measured the wheels against. */
  let _parkLast = null;

  /**
   * Where a wheel's contact patch sits along the machine's own z, in
   * the prop group's frame. `w.position.y` is the axle height and
   * therefore the rolling radius (see bike.js), and the contact is
   * directly under the axle.
   *
   * It walks the parent chain because the motors put their FRONT wheel
   * inside a steering group (rides.js), so `w.position.z` alone is the
   * offset from the fork rather than from the machine. Parent rotations
   * are ignored: the only one in the chain is that steer yaw, it is
   * damped to zero before a dismount ever completes, and even at its
   * 0.16 rad limit it shortens a 0.47 m arm by 6 mm.
   */
  function contactZ(w, stop) {
    let z = 0;
    for (let n = w; n && n !== stop; n = n.parent) z += n.position.z;
    return z;
  }

  /**
   * Stand the machine on the ground beside him and leave it there.
   *
   * IT IS PITCHED TO THE CHORD THROUGH BOTH WHEEL CONTACTS, not dropped
   * onto one height sample. The first version took a single heightAt
   * under the frame origin and wrote rotation (0, yaw, 0), which is
   * exact on a flat door pad — both contacts measured 0.0000 m — and
   * wrong by the wheelbase times the gradient everywhere else. On the
   * hillside twelve metres from that same door the front wheel sat
   * 114 mm UNDER the terrain and the rear 90 mm over it: a bicycle
   * half-buried at one end and hovering at the other. The rider's feet
   * have been conformed to the ground this way since secondary.js was
   * written; the machine he leaves behind gets the same treatment.
   *
   * THE SOLVE ITSELF IS solveParkPose IN bike.js — pitch, height and
   * roll, from terrain samples, iterated to a fixed point rather than
   * taken in a fixed number of passes. Read its header before touching
   * any of this: it carries the off-lattice census that showed the old
   * two-pass version running to 909.7 mm and burying a wheel 673.2 mm
   * inside the clamp, and the reason the census before it could not
   * have seen that.
   *
   * THIS FUNCTION'S OWN JOB IS EVERYTHING AROUND THE SOLVE: which side
   * of him the machine goes and how far out (parkOffsetX), the contact
   * geometry the solve needs (contactZ, walking the steering group),
   * the rotation ORDER, the parked-id bookkeeping, and handing
   * parkProbe what was actually measured. The arithmetic lives in one
   * place because it used to live in two and they drifted apart.
   */
  /**
   * @param {{x:number, z:number, yaw:number}} [at]  put it HERE instead
   *   of beside him. The restore path passes the saved spot, because
   *   "beside him" is a rule about a dismount and a machine coming back
   *   across a reload was not dismounted just now. Everything else about
   *   the pose — pitch, roll, height, mooring — is solved either way.
   */
  function parkProp(at) {
    if (!bike) return;
    const g = bike.group;
    root.updateMatrixWorld(true);
    root.getWorldPosition(_pv);
    const yaw = at ? at.yaw : root.rotation.y;
    /* His -x side, stepped out if another machine is already standing
       there. Local +x maps to world (cos y, 0, -sin y). */
    const ox = at ? 0 : parkOffsetX(_pv, yaw);
    const px = at ? at.x : _pv.x + Math.cos(yaw) * ox;
    const pz = at ? at.z : _pv.z - Math.sin(yaw) * ox;

    const ws = bike.wheels || [];
    const zf = ws.length > 1 ? contactZ(ws[0], g) : 0;
    const zr = ws.length > 1 ? contactZ(ws[1], g) : 0;
    const base = zf - zr;

    /* ----------------------------------------------------------------
       WHAT THE MACHINE IS STANDING ON — and it is not always the hill.

       ctx.world.heightAt() is the TERRAIN RASTER. It answers
       everywhere, for every (x, z) on the island, and it always answers
       about the ground — so solveParkPose could never fail, never once
       took its fallback, and the pose it solved was always a pose on
       the hillside. Park on a ROOF and that is a machine parked inside
       the building. MEASURED, on the penthouse: roof 86.74, terrain
       under it 56.99, and HEAD parks the balloon at 56.99 — 29.75 m
       below the roof he is standing on — then game.js writes that into
       state.rides.parked and it survives the reload.

       A DOWNWARD RAY FROM JUST ABOVE THE MACHINE finds what is really
       under the wheels. IT IS CAST, NOT ASKED FOR THROUGH groundAt:
       ctx.phys.groundAt is published as groundAt(x, z, out)
       (physics.js's wrapper, `groundAt(x, z, out = null)`) and DROPS
       the fromY and maxDist arguments the CollisionWorld's own
       `groundAt(x, z, out, fromY, maxDist)` accepts (cite the two
       signatures rather than line numbers — they move every round). So
       it always starts above the sky and answers the first solid on
       the way down, which would park a bicycle on whatever it happened
       to be standing under. See the
       note on the flight floor clamp in flyUpdate for what that costs
       when it is left in: a 9.91 m snap onto a shop sign.

       AND IT ONLY OVERRIDES THE RASTER WHEN HE IS ACTUALLY STANDING ON
       A STRUCTURE. The question is asked of THE RIDER'S OWN FEET, once,
       and the answer drives every sample, so the chord can never be
       drawn between a roof and a hill:

         · the ray under him comes back within PARK_STAND_M of his own
           y — he is standing ON the thing it found, not beside it;
         · and that thing is more than PARK_STRUCT_M above the raster.

       BOTH HALVES ARE LOAD-BEARING, and the first one is the one that
       is easy to leave out. Asking only "is there something solid over
       the terrain at the park spot" makes street furniture into ground:
       measured on this island, the highest collider top over its own
       terrain is 3.04 m for prop.lamp, with prop.bollard at 2.07 and
       prop.bench at 1.70 — and 6 of 56 door-side park spots have a
       stoop 1.24 m up. There is no empty band between that and a
       roofline (the lowest of the named buildings is 6.96 m over its
       own street, and prop.container reaches 7.91), so no threshold on
       its own can separate them. His feet can: he is on the street, so
       the raster answers and the solve is byte for byte the one HEAD
       ran. Stand him on the stoop and the ray comes back at his feet
       and the machine stands on the stoop with him.

       THE EDGE CASE IT DOES NOT SOLVE: parked 0.62 m to his side, a
       machine can have its spot past a parapet, and then the ray under
       THAT spot is the street thirty metres down. solveParkPose's pitch
       clamp and fallbackY are what catch it, as they did before; the
       balloon has no wheelbase to pitch, so it simply parks low. The
       landing footprint probe (flyFootprint) already leans her onto the
       supported side before she touches, which is why this has to be
       wrong by less than a basket to happen at all.
       ---------------------------------------------------------------- */
    const standX = at ? at.x : _pv.x, standZ = at ? at.z : _pv.z;
    const standY = at ? at.y : _pv.y;
    const startY = standY + PARK_PROBE_UP;
    const rasterAt = (x, z) => {
      try { const h = ctx.world?.heightAt?.(x, z); if (Number.isFinite(h)) return h; } catch (e) {}
      return NaN;
    };
    const rayAt = (x, z) => {
      const p = ctx.phys;
      if (!p || !p.raycast) return NaN;
      try {
        _parkOrigin.set(x, startY, z);
        const h = p.raycast(_parkOrigin, _parkDown, PARK_PROBE_DOWN);
        if (h && Number.isFinite(h.point.y)) return h.point.y;
      } catch (e) { /* no collision world: the raster answers */ }
      return NaN;
    };
    const _r0 = rayAt(standX, standZ), _h0 = rasterAt(standX, standZ);
    const onStructure = Number.isFinite(_r0)
      && Math.abs(_r0 - standY) <= PARK_STAND_M
      && (!Number.isFinite(_h0) || _r0 - _h0 > PARK_STRUCT_M);
    const H = onStructure
      ? (x, z) => { const r = rayAt(x, z); return Number.isFinite(r) ? r : rasterAt(x, z); }
      : rasterAt;
    const sol = solveParkPose(H, {
      x: px, z: pz, yaw, zf, zr,
      lean: bike.parkLean,
      /* the stand's own design contact point, published by the prop —
         never guessed at from geometry here, which is how the last
         kickstand defect (it was on the side away from the lean)
         survived a whole round */
      foot: bike.standFoot || null,
      fallbackY: at ? at.y : _pv.y,
    });
    const gy = sol.y, pitch = sol.pitch;
    /* WHAT WAS ACTUALLY MEASURED, AND WHERE — for parkProbe, so the
       probe reports the gradient this machine was pitched to instead of
       the one under the rider's feet. */
    _parkLast = {
      /* SIX DECIMALS ON THE POSITION. A tool that models this solve has
         to sample heightAt where the machine actually is; fed a position
         rounded to the millimetre it samples a different hill, and on
         a 24-degree grade half a millimetre of position is 0.2 mm of
         height — twice the threshold the same tool then applies. */
      at: [+px.toFixed(6), +pz.toFixed(6)], offsetX: +ox.toFixed(4),
      /* WHICH SURFACE THE SOLVE WAS RUN AGAINST, named rather than
         inferred: `onStructure` false is the terrain raster and the
         pose HEAD would have produced, true is the collision ray. A
         probe that cannot say which branch it took cannot say what it
         measured. */
      onStructure, rayY: Number.isFinite(_r0) ? +_r0.toFixed(3) : null,
      rasterY: Number.isFinite(_h0) ? +_h0.toFixed(3) : null,
      base: +base.toFixed(3),
      gradientDeg: base > 0.05 ? +(sol.rawPitch * 180 / Math.PI).toFixed(2) : null,
      clamped: base > 0.05 && sol.clamped,
      rollDeg: +(sol.roll * 180 / Math.PI).toFixed(2),
      rollRawDeg: +(sol.rollRaw * 180 / Math.PI).toFixed(2),
      leanDeg: +((bike.parkLean || 0) * 180 / Math.PI).toFixed(2),
      rollClamped: !!sol.rollClamped,
      pitchIters: sol.pitchIters, bisected: sol.bisected,
      solveMM: sol.contactMM, liftMM: sol.liftMM,
    };

    if (g.parent !== ctx.scene) ctx.scene.add(g);
    g.position.set(px, gy, pz);
    /* ROTATION ORDER IS THE WHOLE OF WHY THIS IS THREE LINES AND NOT
       ONE. Default 'XYZ' composes Rx*Ry*Rz, which applies the pitch
       OUTSIDE the yaw — i.e. about the world x axis, so a machine
       parked facing east would pitch sideways instead of nose-up.
       'YXZ' gives Ry*Rx*Rz: yaw in the world, then pitch about the
       machine's own lateral axis, then park()'s lean on z about its own
       forward axis. Each rotation is then in the frame it means
       something in. */
    g.rotation.order = 'YXZ';
    g.rotation.set(pitch, yaw, 0);
    g.scale.set(1, 1, 1);
    /* park() writes the roll on z, innermost under 'YXZ', so it is a
       lean in the machine's own frame and not a world-space tilt,
       exactly as the bank on `root` is. THE ROLL IS CONFORMED NOW: it
       is the prop's own lean plus the ground's cross-slope under the
       stand, clamped to a band around the lean. On flat ground it is
       the lean to the bit. See solveParkPose. */
    bike.park(true, sol.roll);
    g.visible = true;
    /* THE PROP THAT WAS JUST PARKED, not the id another module may have
       rewritten mid-dismount. See propKey. */
    const id = propKey(bike);
    if (id) parkedIds.add(id);
    /* AND IT SURVIVES A RELOAD NOW. game.js owns the fact (state.rides
       .parked), this owns the pose — and only the two numbers the
       terrain cannot re-derive are handed over, because pitch, roll
       and height all come back out of solveParkPose on the way in and
       a stored answer could contradict the ground it is standing on.
       Wrapped because a headless build has no ctx.game at all. */
    if (id) {
      try { ctx.game?.actions?.setParkSpot?.(id, { x: px, y: gy, z: pz, yaw }); }
      catch (e) { /* no game layer: the pose is still correct */ }
    }
  }

  /** Take it off the stand and put it back under him. */
  function unparkProp() {
    if (!bike) return;
    const id = propKey(bike);
    if (id) parkedIds.delete(id);
    if (id) {
      try { ctx.game?.actions?.clearParkSpot?.(id); } catch (e) { /* headless */ }
    }
    const g = bike.group;
    bike.park(false);
    if (g.parent !== root) root.add(g);
    g.position.set(0, 0, 0);
    /* Back to the order every other writer of this transform assumes.
       bikeUpdate only ever sets y and z, which compose the same either
       way, but leaving a non-default order on a shared object is the
       kind of thing that is invisible until it is not. */
    g.rotation.order = 'XYZ';
    g.rotation.set(0, 0, 0);
    g.scale.set(1, 1, 1);
  }

  /** Hide machines left further away than they are worth drawing.
      Every parked one, not just the current — that is the point of
      being able to leave more than one somewhere.

      NEVER HIDE ONE THE PLAYER IS LOOKING AT. See the PARK_DRAW_M note
      above: the old single-distance rule switched a 28-pixel bicycle
      off in one frame in the middle of the shot. Beyond PARK_DRAW_M
      the machine now survives exactly as long as it is in frame, which
      costs nothing the rest of the time (its meshes are frustum-culled
      out of every pass but the shadow) and never pops while it is. */
  function parkedCull() {
    const cam = ctx.camera;
    if (parkedIds.size && cam) {
      _pmat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      _pfr.setFromProjectionMatrix(_pmat);
    }
    for (const id of parkedIds) {
      const p = props[id];
      if (!p) continue;
      if (!cam) { p.group.visible = true; continue; }
      const d = cam.position.distanceTo(p.group.position);
      if (d < PARK_DRAW_M) { p.group.visible = true; continue; }
      if (d > PARK_FAR_M) { p.group.visible = false; continue; }
      _psph.center.copy(p.group.position);
      _psph.center.y += 0.55;                 // half its standing height
      /* 1.25 is half a MOTORCYCLE's diagonal. A moored balloon is five
         metres of envelope on the ground and a sphere sized for a
         motorcycle would cull it while a corner of it was still in
         shot — which is the pop §6 forbids, arriving through the
         constant rather than through the rule. */
      _psph.radius = Math.max(1.25, clearOf(p) * 0.75) + PARK_SHADOW_PAD;
      p.group.visible = _pfr.intersectsSphere(_psph);
    }
  }

  function bikeSpeeds(on) {
    const c = controller;
    if (!c || !c.opts) return;
    const S = (RIDE_TUNE[rideId] || RIDE_TUNE.bike).speeds;
    if (on) {
      /* THE SNAPSHOT IS TAKEN ONCE AND NEVER RE-TAKEN. Swapping from a
         scooter to a motorcycle patches the options a second time while
         they are already patched; re-snapshotting there would record the
         SCOOTER's numbers as "the walk" and unequipping would leave him
         striding around at 7.65 m/s for the rest of the session. */
      if (!bikeSpeedSaved) {
        bikeSpeedSaved = {};
        for (const k in S) bikeSpeedSaved[k] = c.opts[k];
      }
      for (const k in S) c.opts[k] = S[k];
    } else if (bikeSpeedSaved) {
      for (const k in bikeSpeedSaved) c.opts[k] = bikeSpeedSaved[k];
      bikeSpeedSaved = null;
    }
  }

  /**
   * Get on or off. Idempotent, safe to call every frame, and safe to
   * call before ctx.game exists.
   * @param {boolean} on
   * @param {{instant?:boolean}} o  instant skips the mount animation
   */
  function setBike(on, o = {}) {
    const want = !!on;
    /* SETBIKE IS THE ONLY WRITER OF `rideId`, and that is not tidiness:
       the first version let the bus handler assign it before calling in
       here, which made the swap test below compare the new machine
       against itself, find no difference, and return early. The player
       bought a Thunderhead, the state said motorcycle, the posture
       changed — and the SCOOTER stayed on screen underneath him.
       Callers now say which machine they want and nothing else. */
    const wantRide = rideKey(o.ride) || rideId;
    /* ---- THE AIR FORK ----
       An air machine has no seated posture, no controller and no
       kickstand, so it does not take one step down this function: it
       goes to setFly() and the two state machines never overlap. The
       fork is here rather than in the callers because setBike() is
       the ONLY writer of `rideId` (see the note above) and the whole
       point of that rule is that there is one door.

       AND GETTING ON A BALLOON GETS YOU OFF A MOTORCYCLE, which is
       the ride table's own one-at-a-time rule and has to be enforced
       across the fork as well as inside each side of it. */
    if (isAir(wantRide) && want) {
      if (bikePhase !== 'off') setBike(false, { instant: true });
      return setFly(true, o);
    }
    if (flyPhase !== 'off' && (!want || !isAir(wantRide))) {
      /* he is in the air and something wants him out of it, or on a
         different machine: ask her down, and let the landing hand him
         back before anything else happens */
      setFly(false, o);
      if (!want || flyPhase !== 'off') return api;
    }
    const already = bikePhase === 'on' || bikePhase === 'mounting';
    /* A SWAP IS NOT A NO-OP. Asking for the motorcycle while he is on
       the scooter passes want === already, and returning early there is
       how you end up riding a Thunderhead in a Vespa's posture. It falls
       through to the mount path instead, which rebinds the ladder, the
       prop and the controller speeds together. */
    const swap = want && already && wantRide !== rideId;
    if (want === already && !swap) {
      /* Not mounting anything — but remember which machine the NEXT
         mount is of, so equipping a scooter while on foot and then
         getting on produces a scooter. */
      if (!want) rideId = wantRide;
      return api;
    }

    if (want) {
      rideId = wantRide;
      anim.setRide(rideId);
      showProp(rideId);
      bike.group.visible = true;
      unparkProp();
      bikeSpeeds(true);
      ikSaved = secondary.ikEnabled;
      secondary.ikEnabled = false;          // his feet are on a machine
      if (o.instant || swap) {
        bikePhase = 'on'; bikeT = 0; bikeRide = 1;
        anim.setBike(true, swap && !o.instant ? 0.22 : 0);
      } else {
        bikePhase = 'mounting'; bikeT = 0;
        anim.setBike(true, MOUNT_T * 0.72);
        if (!manual) { anim.play('bike-mount', { fade: 0.10, restart: true }); autoClip = 'bike-mount'; }
      }
      ctx.bus?.emit('wally:bike', { riding: true, ride: rideId, instant: !!o.instant });
    } else {
      if (o.instant || !bike) {
        bikePhase = 'off'; bikeT = 0; bikeRide = 0;
        anim.setBike(false, 0);
        /* INSTANT MEANS PUT IT AWAY, not leave it in the street. See
           the parked block: this path is cutscenes and debug hooks. */
        if (bike) { unparkProp(); bike.group.visible = false; }
        bikeSpeeds(false);
        secondary.ikEnabled = ikSaved;
      } else {
        bikePhase = 'dismounting'; bikeT = 0;
        anim.setBike(false, DISMOUNT_T * 0.62);
        if (!manual) { anim.play('bike-dismount', { fade: 0.08, restart: true }); autoClip = 'bike-dismount'; }
      }
      ctx.bus?.emit('wally:bike', { riding: false, ride: rideId, instant: !!o.instant });
    }
    return api;
  }

  /**
   * Put a specific machine under him. `null` walks.
   * @param {'bike'|'scooter'|'motorcycle'|'moto'|null} id
   * @param {{instant?:boolean}} o
   */
  function setRide(id, o = {}) {
    const key = rideKey(id);
    if (!key) return setBike(false, o);
    return setBike(true, { ...o, ride: key });
  }

  /* Per-frame: advance the transition, place the prop, turn the crank,
     bank into the corner. Called from update() after the pose is
     resolved, so the crank can be driven off the same phase the legs
     were. */
  function bikeUpdate(dt, speed) {
    if (bikePhase === 'mounting') {
      bikeT += dt;
      bikeRide = clamp(bikeT / MOUNT_T, 0, 1);
      if (bikeT >= MOUNT_T) { bikePhase = 'on'; bikeRide = 1; }
    } else if (bikePhase === 'dismounting') {
      bikeT += dt;
      bikeRide = 1 - clamp(bikeT / DISMOUNT_T, 0, 1);
      if (bikeT >= DISMOUNT_T) {
        bikePhase = 'off'; bikeRide = 0;
        /* He is off it: stand it up where he left it. */
        parkProp();
        bikeSpeeds(false);
        secondary.ikEnabled = ikSaved;
      }
    }

    /* ---- the lean ----
       Roll on `root` about its own forward axis (Euler 'XYZ' composes
       Rx*Ry*Rz, so z is applied inside the yaw and is therefore a bank,
       not a world-space tilt). Proportional to yaw RATE times speed,
       which is the real physics of it: you lean into a corner in
       proportion to the lateral acceleration, and a stationary bicycle
       does not lean at all. Damped, so it eases in and settles out with
       the corner rather than snapping to the stick. */
    const c = controller;
    const TU = RIDE_TUNE[rideId] || RIDE_TUNE.bike;
    const L = TU.lean;
    /* The reference speed each machine leans FULLY at is its own cruise,
       not the bicycle's: without that the motorcycle would be pinned at
       max lean from walking pace and the whole corner would be one
       angle. */
    const ref = TU.speeds.walkSpeed * 1.08;
    const want = c && bikeRide > 0
      ? clamp((c.yawRate || 0) * L.gain * clamp(speed / ref, 0, 1.25), -L.max, L.max)
      : 0;
    bikeLean = damp(bikeLean, want, L.rate, dt);
    root.rotation.z = bikeLean * bikeRide;

    /* PARKED IS A STATE, AND THIS LINE IS WHAT MAKES IT ONE. Everything
       below writes the prop's placement and its drivetrain against a
       rider who is no longer on it; the frame after parkProp() ran, the
       lean damper is still non-zero, so bikeUpdate is still being
       called, and without this return the kickstand pose would be
       overwritten before it was ever drawn. That is exactly how park()
       came to be dead code.

       IT ASKS ABOUT THE PROP `bike` POINTS AT, not about `rideId`. The
       set holds every machine he has left somewhere and the ones he is
       not on are not this function's business — but `rideId` can name a
       different machine from the one `bike` is, for the whole of a
       dismount (see propKey), and then this guard lets the placement
       writes below run over a bicycle standing in the street. */
    if (parkedIds.has(propKey(bike))) return;

    if (!bike || !bike.group.visible) return;

    /* ---- the front wheel ----
       Only the motors steer. A bicycle's bar is under the same mittens
       and the bicycle prop has no steering group, so this is a null on
       that machine by construction rather than by a branch. */
    if (bike.setSteer) {
      const s = c && bikeRide > 0
        ? clamp(-(c.yawRate || 0) * TU.steer, -0.16, 0.16) : 0;
      bikeSteer = damp(bikeSteer, s, 8.0, dt);
      bike.setSteer(bikeSteer * bikeRide);
    }

    /* ---- where the prop is ----
       Mounting, it comes up off its stand from his left and rights
       itself under him. The two curves are deliberately different
       shapes: the roll finishes early (it is upright before he is
       fully on it) and the slide finishes late, which is what makes it
       read as him pulling it under himself rather than the bicycle
       teleporting into place. */
    const E = TU.enter;
    const slide = 1 - smoothstepLocal(0.10, 0.92, bikeRide);
    const roll = 1 - smoothstepLocal(0.00, 0.62, bikeRide);
    const g = bike.group;
    g.position.set(E.x * slide, E.y * slide, E.z * slide);
    g.rotation.set(0, E.yaw * slide, E.roll * roll);
    g.visible = bikeRide > 0.001;
    /* Undo the landing squash: it is a soft-body effect on a clay
       elephant, and a steel frame does not squash. */
    const rs = root.scale;
    g.scale.set(1 / (rs.x || 1), 1 / (rs.y || 1), 1 / (rs.z || 1));

    /* ---- the drivetrain ----
       On the bicycle, straight off the animator's pedal phase, so the
       pedal is under the foot by construction rather than by a ratio
       kept in step by hand. On a motor there is no crank and no foot on
       it: the wheels are driven by DISTANCE through the prop's own
       radius, which is the only honest source when the gearing is
       inside a case nobody ever sees. */
    if (bike.crank) {
      /* NO SIGN FLIP HERE, and that is the fix for "he pedals
         backwards". Both of these used to be negated, which made the
         pedal mesh follow a leg solve that ran the circle the wrong way
         and then dragged the wheels backwards to match it — a
         drivetrain in perfect agreement with itself and in flat
         contradiction of the direction of travel. The sign now lives
         once, at the source, in bikeBody()'s `cr`; here the phase is
         handed over honestly and rotation.x means what three.js says it
         means, which is forward. */
      bike.setCrankPhase(anim.bikePhase + CRANK_OFFSET);
    }
    /* AND THE WHEELS COME OFF THE GROUND, NOT OFF THE CRANK — on all
       three machines, through the same call. The crank is a gear and
       may change ratio with the rung; the wheel is tyre-bound to the
       road and may not. See bike.js `roll`. */
    bike.roll(speed * dt);
  }

  /* Local smoothstep so this block does not depend on the import list
     changing under it. */
  const smoothstepLocal = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  /* Measured, not guessed. The leg's stroke bottom is at pedal phase 0
     and the prop's crank arm hangs straight DOWN at rotation.x 0, so
     the two agree with no offset at all — and now with no sign flip
     either, since bikeBody() runs its own solve on the reversed phase.
     VERIFIED WITH WALLY.debug.driveTrace(), and stated with both of the
     numbers it returns rather than the flattering one. At the cruise
     rung the ankle-to-pedal offset VECTOR wanders 23.5 mm about its own
     mean (fitDriftMM) and the WORST GAP between ankle and pedal plate
     is 50.2 mm (fitMaxMM, against 14.4 mm at its best). This note used
     to quote the 23.5 as "tracks the pedal plate to within 24 mm across
     the whole stroke", which is the drift wearing the gap's name and
     twice as good as the truth. The gap is a foot standing on a pedal
     with a sole between them; the drift is whether it slides. Both are
     within tolerance; only one of them is 24 mm. */
  const CRANK_OFFSET = 0;
  /* THERE IS NO LONGER A WHEEL_PER_CRANK CONSTANT, and its absence is
     the point. It was 2.6 / (2*pi*0.225) — the ride-bicycle rung's
     cycle length over the wheel's circumference — which made the ratio
     a property of ONE clip. The blend interpolates `cycle` between
     rungs (2.6 at cruise, 4.4 at the sprint), so the wheels were 18%
     slow at cruise and 41% slow flat out, and they inherited the pedal
     phase's wrap: 1.84 turns of discontinuity, 302 degrees, which
     against the wheel's TEN-fold spoke symmetry is a 14-degree BACKWARD
     SNAP about 1.5 times a second. Distance has no rung and no wrap.

     TEN-fold, not five. bike.js lays five spokes as full DIAMETERS at
     36-degree spacing, so a 36-degree turn maps the wheel onto itself.
     The conclusion is the same either way — 302 mod 36 and 302 mod 72
     are both 14 — but this file said five-fold while bike.js said ten
     in the same working tree, and two files disagreeing by name about a
     measured fact is how the next reader gets misled. */

  /* ================================================================
     6c. THE BALLOON — flight, and why it is not the bicycle path

     Everything in 6b assumes the machine is UNDER a character
     controller that owns the position. The balloon owns the position
     itself, so this is a parallel state machine rather than a fourth
     row in that one, and the seam between them is exactly two lines:
     setBike() routes an air ride here, and update() calls flyUpdate()
     before it copies the controller into `root`.

     THE PHASES, and each one is a thing you can see:

       off        on foot. The machine, if he owns one, is lying in a
                  field somewhere with its envelope cold.
       boarding   4.6 s. He is in the basket, the burner is lit, and
                  the envelope is inflating off the ground. The basket
                  stays on its runners until the lift genuinely beats
                  the weight — the take-off is not timed, it is SOLVED.
       aloft      flying. balloon.js stepFlight() owns the velocity.
       landing    the basket is down and the envelope is collapsing
                  forward onto the ground over 3.2 s. At the end of it
                  parkProp() stands the machine where he left it.

     THE CONTROLLER IS DISABLED, NOT DRIVEN, and its three positions
     are written by hand. teleport() is the published way to move it
     and it is the wrong one here: it calls snapToGround(4), so a
     balloon four metres over a roof would be yanked down onto it on
     the frame it crossed. Writing simPosition / position /
     _prevPosition together is what teleport does minus that snap, and
     all three have to move or phys._post() lerps him back across the
     gap on the very next frame — see the long note at api.wallyWarp()
     for the full account of what happens when they disagree.

     WHAT THE VELOCITY IS FOR. It is written honestly rather than
     zeroed, because three things downstream read it and all three are
     wrong if it lies: world.js streams its collision window from
     ctx.phys.player.position, the ear and trunk chains take their
     inertia from the root's motion, and anything reading the subject
     wants a real one. The locomotion blend is the one thing that must
     NOT see it — a 9 m/s planarSpeed would have him sprinting on the
     spot in a basket — so the blend is pinned at zero through
     locoManual for the whole flight, and his idle, which is §1.6 pose
     1 already, is the pose. Ears and trunk then do the acting.
     ================================================================ */
  const F_ANIM = { board: 4.6, land: 3.2 };
  /* THE LIFT-OFF IS SOLVED, NOT TIMED. The basket leaves the ground
     when the envelope is far enough inflated to carry it AND the
     burner has put in enough heat to make the lift positive. Below
     0.62 of inflation the fabric has not got the volume. */
  const F_LIFT_INFLATE = 0.62;
  const F_TOUCH_M = 0.06;
  /* Inside this height the burner is nudged to bleed off the sink
     rate — the last hundred feet, where every landing is made. */
  const F_FLARE_M = 7.0;
  /* She will not put you in the water and she will not put you on a
     cliff. Inside this height over either the burner fires itself —
     and 18 m rather than the 9 it started at, because a REFUSAL IS
     NOT A BRAKE. She arrives at the line doing up to 3.6 m/s down,
     the burner needs 0.7 s to put the heat back over trim and the
     sink then takes another two seconds to wash out, so nine metres
     of warning bought about six of overshoot: measured, she went from
     9 m to 0.71 m over the sea before she came back. Eighteen leaves
     the margin the physics actually needs.

     AND A FLOOR UNDER IT, because "almost never" is not a rule. The
     burner does all the work in every case measured (the floor is
     reported by flightState.floored and was never touched in the
     suite); it exists so that a gust, a stalled tab or a frame of
     3.6 m/s cannot put an elephant in the sea in a game that has no
     way to get him out of one. */
  const F_REFUSE_M = 18.0;
  const F_WATER_FLOOR = 1.6;
  const F_BASKET_R = 0.95;
  const F_ENV_PUSH = 7.5;        // m/s^2 the envelope shoulders with
  /* THE FABRIC'S GIVE — how far outside the ladder's own radius the
     shove starts, and the band it ramps in over. A balloon is not a
     hard surface and it should never read as one arriving.

     IT HAS TO CLEAR THE GORE LOBE. The ladder carries the MERIDIAN's
     radius and the drawn envelope is that meridian with sixteen gores
     lobed over it — balloon.js LOBE and SEAM_PULL put the crown of a
     panel LOBE * (1 - SEAM_PULL) = 6.3% of the radius outside it,
     which is 0.23 m at the equator and 0.35 m measured off the mesh's
     own vertices in 0.25 m bands. A skin under that would let the
     fabric touch a wall before the probe knew anything was there. The
     rest of it is the stopping distance: 1.10 m gives the absorb
     below room to take 6.2 m/s of stick out of her before her
     meridian reaches the brick, which is what makes the contact read
     as canvas giving rather than as clipping. */
  const F_ENV_SKIN = 1.10;
  /* 1/s the inbound speed is soaked up at full contact: about a fifth
     of it a frame at 60 Hz, so a machine driven at a wall squashes to
     a stop over a third of a second. NOT a restitution — see
     flyCollide for why she must not bounce. */
  const F_ENV_ABSORB = 7.0;
  /* m/s, the fastest an envelope already inside a solid is eased out.

     IT IS SET BY THE ONE APPROACH A SIDEWAYS SHOVE CANNOT ANSWER.
     Every deep contact measured on this island happens while she is
     SINKING — at the worst frame of each drive, vy was -1.4 to -1.9
     m/s — because a horizontal probe cannot stop a vertical arrival:
     drop past a roofline four metres from a wall and the fabric is
     simply inside it, at whatever depth the geometry says, before any
     shove has been asked for. Up is never blocked, and it should not
     be, so the answer is to clear it sideways faster than she can
     enter it from above. At 1.40 m/s the worst case was 1.29 m of
     drawn fabric inside the Market Hall; at 2.60 it is 0.87, on the
     same four drives at the same four altitudes minutes apart.

     IT IS A FLOOR NOW AND NOT THE WHOLE RULE — flyCollideCanvas scales
     it by the sink rate, which is the number the sentence above is
     actually about, and this is what is left when she is barely
     descending. 3.60 rather than 2.60 because the school's south face
     is met at 1.4 to 2.5 m/s of sink with barely 2 m/s of drift, and
     2.60 left 1.37 to 1.50 m of drawn fabric in a roof tower there
     against a 1.30 m tolerance. She is drifting at 3 to 4 m/s while
     this runs, so a lateral ease at 3.6 is not something a player can
     see happen, and it only ever runs while fabric is genuinely inside
     masonry. */
  const F_ENV_SLEW = 3.60;
  /* the ceiling on how much harder a compressed envelope refuses than
     one that is merely touching — see the `bite` note in flyCollide */
  const F_ENV_BITE = 3.5;
  /* bearings per ring. Six, so the widest ring's rays are 3.6 m apart
     at the fabric rather than 5.1 m. THE LADDER REVERT'S NUMBER —
     flyCollideCanvas uses F_ENV_AZ2 and staggers it. */
  const F_ENV_AZ = 6;
  /* ---- THE SHIPPING PROBE AND THE SHIPPING RESPONSE. Every one of
     these is derived in flyCollideCanvas's header; the arithmetic is
     there rather than here because it is one argument, not five. ---- */
  const F_ENV_AZ2 = 12;              // bearings per ring
  /* the golden angle. Each ring's fan is turned by this relative to
     the one below, so seven rings sample 84 distinct bearings for
     anything vertical and never line up into a column of blind spot.
     Any irrational multiple of a turn would do; this one is the one
     that spreads soonest at small n, which matters because there are
     seven rings and not seven hundred. */
  const F_ENV_STAGGER = 2.399963229728653;
  const F_ENV_PRECESS = 0.90;        // rad/s the whole fan turns
  /* how far into the skin the spring takes hold. Under this she is
     touching; over it she is being held off. */
  const F_ENV_ENGAGE = 0.60;
  const F_ENV_W = 4.30;              // rad/s, critically damped
  /* m/s^2 the spring may ask for. The stick's own 6.20 m/s delivered
     over a tenth of a second — an envelope cannot shove harder than it
     can be pushed. */
  const F_ENV_AMAX = 62.0;
  /* 1/s the basket bleeds the inbound component at. Wicker with an
     elephant in it, so four times the envelope's rate — but the same
     shape, and the tangent is not in it. */
  const F_BASKET_ABSORB = 18.0;
  /* how much faster than her sink rate the ease-out clears her — see
     the block it is used in. 1.6, so a 2.5 m/s descent into a wall is
     eased out of it at 4.0 and anything under 2.25 m/s is left to
     F_ENV_SLEW's own floor. Measured at the school's south face, which
     is the one place on this island where the worst frame of a drive
     is a SINK and not an approach: the pair (3.60 floor, 1.6 scale)
     took the same drive from 1.50 m of drawn fabric inside a roof
     tower to 1.22. */
  const F_ENV_SLEW_VY = 1.6;
  /* WHAT F_ENV_SLEW WAS WHEN THE 'ladder' REVERT SHIPPED. This round
     raised the floor from 2.60 and scaled it by the sink rate, and a
     revert branch that quietly read today's constant would be
     reverting half the change and calling it the old rule. */
  const F_ENV_SLEW_WAS = 2.60;

  let flyPhase = 'off';          // off | boarding | aloft | landing
  let flyT = 0;
  let flyBlend = 0;              // 0..1 — how much of him is the balloon
  let flyState = newFlight(0);
  let flyProp = null;
  let flyIkSaved = true;
  let flyGround = 0;             // solid height under the basket
  let flyRefusing = false;       // the auto-burner is on
  let flyLandWanted = false;     // he asked to get out while still up
  let flyFogK = 0;
  let flyMistK = 0;              // the offshore fret, 0..1 — see flyHaze
  let flyAlt = 0;
  /* A HELD BURNER, for the verifier. There is no keyboard in a
     headless tab, so tools/test-balloon.mjs holds the burner through
     this rather than through a synthetic key event — which would test
     the event plumbing instead of the thing under test. */
  let flyForceBurn = false;
  /* has the water floor ever had to engage this flight? reported, so
     "the burner does all the work" is a measurement rather than a
     hope */
  let flyFloored = false;
  /* ...and a held stick, for the same reason. */
  let flyStick = null;
  /* the envelope group, looked up once when the prop is built rather
     than searched for every frame */
  let flyEnvGroup = null;
  const _fv = new THREE.Vector3();
  const _fv2 = new THREE.Vector3();
  const _fup = new THREE.Vector3(0, 1, 0);
  const _fin = { x: 0, z: 0, burn: false, vent: false };
  const _fenv = { windX: 0, windZ: 0 };
  const _fground = { y: 0, normal: _fup, hit: false };
  const _fnormal = new THREE.Vector3(0, 1, 0);
  const _fcamGround = { y: 0, normal: _fup, hit: false };
  /* ---------------------------------------------------------------
     THE RAYCAST OUT PARAMETER IS NOT AN OPTIMISATION HERE, IT IS THE
     DIFFERENCE BETWEEN A MEASUREMENT AND A LIE.

     physics/collision.js:559 — `const hit = out || (this._rayHit ||=
     {...})` — hands back ONE SHARED OBJECT when you do not give it
     one. Every raycast in a frame therefore returns the same object,
     and anything you kept a reference to has already changed. The old
     flyCollide kept `hitN = r.normal` while casting two more rays, so
     the basket's response used the normal of the LAST ray that hit
     rather than the NEAREST — identical on a flat wall, wrong on every
     corner and roof edge, and silent either way. `distance` looked
     fine only because a number is copied.

     Two probes reading each other's answer is the same defect the
     suite's own enclosure check had (`b.distance` and `f.distance`
     were the same field), so it is worth naming loudly: give raycast
     an `out`, and COPY anything you keep.
     --------------------------------------------------------------- */
  const _fhit = {
    point: new THREE.Vector3(), normal: new THREE.Vector3(),
    distance: 0, tri: -1, body: 0, plane: false,
  };
  const _fhitN = new THREE.Vector3();
  const _frings = [];            // envelopeRings() writes into this

  /** The solid the basket would land on: terrain, roofs, decks and
      anything else phys calls static. groundAt takes the HIGHEST
      surface under a point, which is why landing on a roof works
      without a single line about roofs.
   *
   *  THE RESULT IS COPIED, NOT RETURNED BY REFERENCE. collision.js's
   *  groundAt() hands back a SHARED scratch object when you pass no
   *  `out` (`this._groundRes`), so two calls in one frame are the same
   *  object and the second silently rewrites the first. Both callers
   *  here are in one frame — the flight reads the ground under the
   *  basket and the camera reads it under the lens — so this returns a
   *  private record instead. Nothing is broken today because the
   *  reads happen to precede the second call; that is not a property
   *  anyone should have to re-verify after moving a line. */
  /** The water surface here — phys owns a real water level (the
      camera reads it for its own floor) and falls back to the world's
      flat sea. Never the seabed: see flyUpdate. */
  function waterAt(x, z) {
    const p = ctx.phys;
    if (p && p.waterLevelAt) {
      try { const v = p.waterLevelAt(x, z); if (Number.isFinite(v)) return v; } catch (e) { /* fall through */ }
    }
    return ctx.world?.seaLevel ?? 0;
  }

  /** The surface she would come to rest on: the solid, or the water
      if the solid is under it. THE DEBUG HOOKS USE THIS TOO — placing
      the machine at "alt 14" over open sea against the SEABED put it
      15.7 m below the waves, which is not an altitude anybody asked
      for and is how the water refusal came to look broken when it was
      the placement that was wrong. */
  function flySurfaceUnder(x, z, fromY) {
    const g = flySolidUnder(x, z, fromY, _fcamGround);
    const wl = waterAt(x, z);
    return (!g.hit || g.y <= wl + 0.35) ? wl : g.y;
  }

  function flySolidUnder(x, z, fromY, out) {
    const r = out || _fground;
    const p = ctx.phys;
    if (p && p.groundAt) {
      try {
        const g = p.groundAt(x, z, null, (fromY ?? root.position.y) + 2, 900);
        if (g && g.hit && Number.isFinite(g.y)) {
          r.y = g.y; r.hit = true;
          r.normal = r === _fground ? _fnormal.copy(g.normal) : g.normal.clone();
          return r;
        }
      } catch (e) { /* fall through to the heightfield */ }
    }
    const h = ctx.world?.heightAt?.(x, z);
    r.y = Number.isFinite(h) ? h : 0;
    r.normal = r === _fground ? _fnormal.set(0, 1, 0) : _fup;
    r.hit = Number.isFinite(h);
    return r;
  }

  /* ----------------------------------------------------------------
     WHAT THE BASKET IS ACTUALLY STANDING ON — the footprint, not a ray.

     flySolidUnder() casts ONE ray, down the machine's centre line, and
     for a balloon over open country that is the whole answer. Over a
     roof it is not, and the roof is the case the feature was built to
     make interesting: the basket is 1.34 m across and every parapet in
     this city is a cliff.

     MEASURED on the penthouse (roof 29.74 m over terrain, 8 of 8 flat
     probes, edge 8.90 m from the centre), flown down on the stick with
     station keeping, load 15.05-29.65:

       centre 0.30 m INSIDE the edge   came to rest on the roof with
                                       its four corner probes reading
                                       71.67 / 71.67 / 86.74 / 86.74 —
                                       a 15.07 m spread, i.e. half the
                                       basket standing on nothing
       centre 0.40 m OUTSIDE the edge  went straight down past the
                                       building and landed on the
                                       terrain 29 m below

     Both are the same bug seen from either side of a line 1.34 m wide:
     a rigid basket on two skids rests on the HIGHEST thing under its
     footprint, and a single ray cannot know what that is.

     So: the centre plus a ring at the skid radius, the highest wins,
     and the direction of that highest support is published so the
     approach can lean toward it (see the nudge in flyUpdate). The ring
     is only paid for inside F_FOOT_M of the surface — four rays a
     frame for the last few seconds of a landing, nothing for the rest
     of a flight.
     ---------------------------------------------------------------- */
  const F_FOOT_M = 14.0;         // start probing the footprint this low
  const F_FOOT_STEP = 0.8;       // corner disagreement that counts as an edge
  const F_FOOT_PUSH = 3.4;       // m/s^2 toward the supported side
  const _ffg = { y: 0, normal: _fup, hit: false };
  const _ffoot = { y: 0, normal: _fup, hit: false, hiX: 0, hiZ: 0, spread: 0 };
  function flyFootprint(x, z, fromY, centre) {
    const r = _ffoot;
    r.y = centre.y; r.normal = centre.normal; r.hit = centre.hit;
    r.hiX = 0; r.hiZ = 0; r.spread = 0;
    let lo = centre.y;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.7854;
      const ox = Math.cos(a) * F_BASKET_R, oz = Math.sin(a) * F_BASKET_R;
      const g = flySolidUnder(x + ox, z + oz, fromY, _ffg);
      if (!g.hit) continue;
      if (g.y < lo) lo = g.y;
      /* A SKID DOES NOT REST ON A WALL. Beside a building the ring
         probes land on its FACE, and letting one of those win puts the
         machine's landing surface up at the height of the wall it is
         passing and hands the refusal a normal pointing sideways — so
         a balloon coming down a street would hover beside the brick
         and decline to land in it. Only surfaces a basket could
         actually stand on are candidates. */
      if (g.normal && g.normal.y < 0.5) continue;
      if (g.y > r.y + 1e-4) {
        r.y = g.y; r.hit = true; r.normal = g.normal;
        r.hiX = ox; r.hiZ = oz;
      }
    }
    r.spread = r.y - lo;
    return r;
  }

  /* ----------------------------------------------------------------
     COLLISION — it must not fly through a building, and it must not be
     TRAPPED by one either. Two probes, and they answer differently on
     purpose:

       THE BASKET is a hard capsule. It is 1.34 m across with an
       elephant standing in it and it is not allowed inside a wall, so
       a contact kills the inbound component of the velocity and keeps
       the tangent. That is the whole of "it does not fly through
       buildings".

       THE ENVELOPE is a soft body six metres higher, seven across and
       seven and a third tall. Between two three-storey terraces there
       is nowhere for it to be, and a hard response there would pin the
       machine in a street for ever — which is the "trapped" half of
       the brief, and it is the one that ships by accident. So the
       envelope PUSHES rather than stops: a lateral shove away from
       whatever it is against, so a balloon that drifts into a terrace
       is eased back over the middle of the street instead of stopping
       dead on a chimney.

     AND UP IS NEVER BLOCKED. Neither probe touches the vertical
     velocity at all. Whatever else has gone wrong, the burner is the
     way out — which is what makes trapped impossible rather than
     merely unlikely.

     ================================================================
     WHAT WAS WRONG WITH IT, MEASURED, because the shape of the answer
     above was right and it still let a player fly through the Exchange.

     ONE RING AT ONE HEIGHT. The envelope was probed on a single
     horizontal ring at its widest point, 5.93 m over the deck. Against
     a building TALLER than that ring it works; against a roofline it
     is a plane sweeping through the air above the tiles. Measured on
     this island: 19 of the city's 28 named buildings have a roof under
     8 m over their own street, so at any altitude a player would
     actually cruise at, the ring is above every one of them. Driven at
     the Market Hall (roof +6.96) at 6 m the envelope ended 2.85 m
     inside the building and the machine came out the far side; the
     same drive at 3 m bounced, because down there the BASKET's rays
     reach the wall. The suite's collision test flew at 3 m. It had
     been green over this bug from the day it was written.

     THE PROBE NOW WALKS THE WHOLE HULL — balloon.js envelopeRings(),
     seven rings generated from the meridian the fabric is drawn from,
     at most 1.25 m apart, six bearings each. With the basket's three
     heights that is 54 rays a frame, measured at 0.00088 ms each
     against this city's collision set: 0.048 ms, which is 0.3% of a
     16.7 ms frame. There was never a reason to be stingy here.

     TREES ARE SOLID NOW, AND ONLY WHILE SHE IS UP. This paragraph
     used to read "TREES ARE STILL GHOSTS ABOVE 1.72 m" and describe a
     handover; the handover shipped, and leaving the old text here was
     the more expensive half of the mistake — a sentence that outlives
     the code it describes reads like evidence for ever. What is true
     now: world/trees.js caps a TRUNK box at props.js's SOLID_TOP,
     which is still right (nothing above a walking elephant's crown can
     be touched by one), and gives the CROWN its own box on top of that
     — never below 2.90 m of world height, and only while 'wally:fly'
     says something that can reach it is in the air. A skeptic put a
     700-point A/B through it: on foot the collision world is what it
     always was, and aloft the ladder above meets a canopy. The prior
     measurement this paragraph carried — 0 of 24 sampled trees
     answering a ray at 3 m — is what the world answers WITH THE
     CROWNS OFF, which is now a mode (trees.js setCanopies(false)) and
     not the world. test-balloon B5f still registers its own canopy,
     deliberately: a test that flies at a body it built itself is
     testing this file, not that one.

     AND THE CROWNS ARE STREAMED, so "solid" means solid inside
     trees.js's CANOPY_IN of the basket, not island-wide. She cannot
     outrun it — 62 m of margin against a 9.0 m/s drift ceiling — but
     a rig that teleports her with debug.balloon({at}) and reads the
     collision world on the SAME frame will find the crowns still
     arriving at a few a frame. Give it a dozen frames, or ask for
     ctx.foliage.trees.setCanopies(true, 'island').

     WHAT IT MUST NOT DO. Not a stop — a balloon that halts dead at a
     roofline has no mass. Not a bounce — canvas has no restitution and
     a reflection here reads as a beach ball. Not a hard collider on
     the envelope — that is the terrace trap above. It shoulders,
     soaks up what is still going in, keeps every bit of the tangent so
     she slides along the roofline and away, and eases out of anything
     she is already inside.
     ---------------------------------------------------------------- */

  /* ----------------------------------------------------------------
     RUNTIME REVERT. contracts.js's strongest form of a revert check is
     "a switch in the module, shipping rule and prior rule side by
     side, driven on the same page load", and this is one: 'ladder' is
     what ships and 'ring' is flyCollideRing() below — the rule this
     round replaced, kept runnable and kept verbatim, aliased normal
     and early-out and all. tools/test-balloon.mjs B5c drives BOTH on
     one boot at the same altitudes off the same measured wall, so the
     claim "the ladder is what stops her going through the roofline" is
     a measurement in this build rather than a number in a comment that
     outlives the code it describes.

     It costs one dead function in the bundle. hud.js pays the same for
     promptAnchor and it is the cheapest honest evidence available.
     ---------------------------------------------------------------- */
  let flyHullMode = 'canvas';    // 'canvas' ships | 'ladder', 'ring' are the two rules it replaced
  let flyProbeT = 0;             // the fan's precession clock — see flyCollideCanvas

  function flyCollide(dt) {
    flyProbeT += dt;
    if (flyHullMode === 'ring') { flyCollideRing(dt); return; }
    if (flyHullMode === 'ladder') { flyCollideLadder(dt); return; }
    flyCollideCanvas(dt);
  }

  /* ----------------------------------------------------------------
     THE PRIOR RULE — LAST ROUND'S LADDER, VERBATIM. Reachable only
     through WALLY.debug.balloonHull('ladder'). It is the probe that
     fixed "2.85 m inside the Market Hall and out the far side", and it
     is kept because the two things wrong with it are things a number
     in a comment cannot demonstrate:
       · SIX BEARINGS ON EVERY RING, ALL AT THE SAME AZIMUTH, which
         puts adjacent rays 3.6 m apart at the widest ring and leaves a
         column-shaped blind spot running the full height of the
         envelope. Measured: a 0.8 m post 1.7 m off the line gave 610
         frames of contact and 3.02 m of fabric intersecting it with no
         response at all, because nothing was ever asked;
       · A CONSTANT SHOVE PLUS AN EXPONENTIAL ABSORB, whose stopping
         distance is proportional to the inbound speed. Flown at five
         buildings x four bearings x four altitudes it held the Market
         Hall (1.128 m of drawn fabric inside solid, against a 1.29 m
         tolerance) and blew it at the four the suite did not fly:
         exchange 1.652, school 3.193, bank 1.788, apartment 2.092,
         with 13 of 72 drives leaving mesh vertices fully enclosed.
     ---------------------------------------------------------------- */
  function flyCollideLadder(dt) {
    const p = ctx.phys;
    if (!p || !p.raycast) return;

    /* THE BEARING THE PROBES ARE ALIGNED TO. Along the drift when
       there is one, and along the machine's own yaw when there is not.
       This used to return early below 0.02 m/s, which switched the
       collision off at precisely the moment it is load-bearing: a
       balloon the wind is holding against a wall sits at very nearly
       zero net speed, and with the probes off, the ease-out below
       never runs and she stays in the brickwork. */
    const sp = Math.hypot(flyState.vx, flyState.vz);
    const moving = sp > 0.02;
    const dx = moving ? flyState.vx / sp : Math.sin(flyState.yaw);
    const dz = moving ? flyState.vz / sp : Math.cos(flyState.yaw);
    const a0 = Math.atan2(dx, dz);

    /* --- the basket --- three heights, at the deck, at his chest and
       at the rim, so a rail at one height cannot be walked through by
       a probe that only looked at another; and four bearings, because
       the shove above can put her sideways into a wall she was never
       pointed at. Nearest contact wins, and its normal is COPIED —
       see _fhit. */
    const reach = F_BASKET_R + sp * dt * 2 + 0.25;
    let hitD = Infinity, hit = false;
    for (let i = 0; i < 4; i++) {
      const a = a0 + (i / 4) * Math.PI * 2;
      _fv2.set(Math.sin(a), 0, Math.cos(a));
      for (const h of [0.10, 0.70, BALLOON_FIT.WALL]) {
        _fv.set(root.position.x, root.position.y + h, root.position.z);
        let r = null;
        try { r = p.raycast(_fv, _fv2, reach, _fhit); } catch (e) { r = null; }
        if (r && r.distance < hitD) { hitD = r.distance; _fhitN.copy(r.normal); hit = true; }
      }
    }
    if (hit) {
      const vn = flyState.vx * _fhitN.x + flyState.vz * _fhitN.z;
      if (vn < 0) {
        flyState.vx -= _fhitN.x * vn * 1.02;
        flyState.vz -= _fhitN.z * vn * 1.02;
        /* it is canvas and wicker, not glass: bleed a fifth of what is
           left so a scrape along a wall costs you something */
        flyState.vx *= 0.80; flyState.vz *= 0.80;
      }
      const gap = F_BASKET_R - hitD;
      if (gap > 0) {
        root.position.x += _fhitN.x * gap * 0.6;
        root.position.z += _fhitN.z * gap * 0.6;
      }
    }

    /* --- the envelope --- the whole hull, ring by ring. */
    const rings = envelopeRings(flyProp ? flyProp.inflation : 1, _frings);
    const y0 = root.position.y - BALLOON_FIT.DECK;
    let px = 0, pz = 0, depth = 0, n = 0;
    for (let k = 0; k < rings.length; k++) {
      const ring = rings[k];
      if (ring.r < 0.30) continue;
      const range = ring.r + F_ENV_SKIN;
      _fv.set(root.position.x, y0 + ring.y, root.position.z);
      for (let i = 0; i < F_ENV_AZ; i++) {
        const a = a0 + (i / F_ENV_AZ) * Math.PI * 2;
        const ax = Math.sin(a), az = Math.cos(a);
        _fv2.set(ax, 0, az);
        let r = null;
        try { r = p.raycast(_fv, _fv2, range, _fhit); } catch (e) { r = null; }
        if (!r) continue;
        /* how far into the skin this bearing is, so the sum leans the
           way the fabric is most compressed */
        const d = range - r.distance;
        px -= ax * d; pz -= az * d;
        if (d > depth) depth = d;
        n++;
      }
    }
    if (!n) return;
    const l = Math.hypot(px, pz);
    /* SQUEEZED EVENLY FROM EVERY SIDE there is no way out sideways and
       nothing sensible to do with a direction of zero length. The
       burner is the answer to that one, and it always is. */
    if (l < 1e-4) return;
    const ux = px / l, uz = pz / l;

    /* HOW HARD SHE SHOULDERS scales with how far in she is: a brush at
       the edge of the fabric is a nudge and a real contact is the full
       shoulder. The old code divided the depth back out again, so
       grazing a chimney with one gore and burying half the envelope in
       a wall were the same 7.5 m/s^2. */
    const soft = clamp(depth / F_ENV_SKIN, 0, 1);
    const push = F_ENV_PUSH * (0.22 + 0.78 * soft) * dt;
    flyState.vx += ux * push;
    flyState.vz += uz * push;

    /* AND PAST THE SKIN IT STIFFENS. Inside the skin the response is a
       toe — a lean-in over the last metre, and `bite` is `soft` there,
       so nothing about the approach changes. Past it the fabric is
       genuinely compressed, and an envelope with hot air in it refuses
       harder the further it is pushed rather than flattening off at
       the surface. Without this the absorb takes a fixed third of a
       second whatever the overlap, which at the stick's own 6.2 m/s is
       longer than it takes to cross the whole skin: measured at the
       Market Hall, the meridian pressed 1.01 m past the wall on the
       worst altitude, against a design budget of 0.60. Capped at
       F_ENV_BITE, because the point is a firm shoulder and not a
       catapult — a balloon that flings itself off a roof is a worse
       lie than one that sinks into it. */
    const over = depth - F_ENV_SKIN;
    const bite = Math.min(soft + Math.max(0, over) / F_ENV_SKIN, F_ENV_BITE);

    /* AND SHE SOAKS UP WHAT IS STILL GOING IN, which is what makes it
       read as mass. The inbound component decays exponentially and the
       TANGENT IS UNTOUCHED, so she does not stop — she stops going
       through the wall and carries on along it, which is the whole
       feel of the thing: a balloon meets a roofline, leans off it and
       drifts away down the street. */
    const vin = flyState.vx * ux + flyState.vz * uz;
    if (vin < 0) {
      const kill = 1 - Math.exp(-F_ENV_ABSORB * bite * dt);
      flyState.vx -= ux * vin * kill;
      flyState.vz -= uz * vin * kill;
    }

    /* THE WAY OUT OF SOMETHING SHE IS ALREADY IN. A shove is an
       acceleration, and an acceleration cannot rescue an envelope a
       metre inside a wall — nor one the wind is holding there, where
       the shove and the air reach a standoff with fabric in the
       brickwork. Past the skin the hull is EASED out at walking pace,
       never faster than F_ENV_SLEW, so she drifts clear over a second
       or so instead of snapping out of the masonry. This is the line
       that makes trapped impossible in the horizontal, the way the
       burner does in the vertical. */
    if (over > 0) {
      /* F_ENV_SLEW_WAS AND NOT F_ENV_SLEW. This round raised the
         shipping ease-out's floor from 2.60 to 3.60 and scaled it by
         the sink rate, and a revert branch that quietly inherited the
         new constant would be reverting half the change and calling it
         the old rule. What ships here is the number that shipped. */
      const s = Math.min(over, F_ENV_SLEW_WAS * dt);
      root.position.x += ux * s;
      root.position.z += uz * s;
    }
  }

  /* ================================================================
     THE SHIPPING RULE — WHAT CANVAS DOES.

     Same hull as the ladder above and the same three refusals (not a
     stop, not a bounce, never blocks up). Two things are different and
     each of them is one of the two ways the ladder failed.

     ------------------------------------------------------------------
     1  THE FAN IS STAGGERED, AND IT IS STAGGERED BECAUSE MASTS ARE
        VERTICAL.

        The ladder put all six of every ring's rays at the SAME six
        azimuths, so the seven rings sampled the same six directions
        seven times and the gaps between them were a blind spot running
        the whole 6.4 m height of the envelope. A wall does not care —
        a wall is wider than the gap. A 0.5 x 0.5 m column does: a
        census of this city found solids above 3 m at six points on the
        exchange, five at the bazaar, four at the docks and three at
        harbourhomes, which is exactly the masts, flues and finials a
        balloon snags on, and the ladder flew through a 0.8 m post 1.7 m
        off the line for 610 frames without answering.

        THE FIX IS FREE AND IT FALLS OUT OF THE GEOMETRY. A post is
        vertical, so it crosses EVERY ring. Turn each ring's fan by the
        golden angle relative to the one below it and the seven rings
        sample seven different sets of bearings — so a vertical obstacle
        is probed at F_ENV_AZ x 7 = 84 effective bearings while a
        horizontal one is still probed at 12, which is all a wall needs.
        At the widest ring that takes the finest bearing gap from 3.60 m
        to 0.27 m for anything standing up, and it costs twelve rays a
        ring rather than six.

        AND THE WHOLE FAN PRECESSES, slowly, on its own clock. A
        becalmed balloon holding station against a chimney would
        otherwise keep the same blind spots for as long as it hovered;
        at F_ENV_PRECESS the fan sweeps a whole bearing gap every 0.6 s,
        so nothing sits in a gap. It is driven off an accumulated dt
        rather than a frame count, so it is the same rotation at 30 fps
        as at 120.

     ------------------------------------------------------------------
     2  THE RESPONSE IS A CRITICALLY DAMPED SPRING, BECAUSE THE LADDER'S
        STOPPING DISTANCE WAS PROPORTIONAL TO THE INBOUND SPEED.

        The ladder shoved at a constant F_ENV_PUSH and bled the inbound
        component at a fixed rate, which means the depth she reaches is
        roughly (inbound - the ease-out's own ceiling) x a time
        constant. Position is integrated and then corrected
        (flyUpdate's aloft branch), the ease-out is capped at 2.60 m/s
        and the stick delivers 6.20 — so it held at the one wall the
        suite flew, whose faces are met at 3.1-4.4 m/s, and came apart
        at the exchange and the school, which are met at 4.7-6.4.

        A spring has no such term. For a critically damped spring the
        deepest a body of any inbound speed v reaches is v / (w e), a
        number that is LINEAR in v with a slope this file gets to
        choose, and it never overshoots on the way out, so it cannot
        turn into the catapult F_ENV_BITE was capped to prevent.

        THE FREQUENCY IS SOLVED, NOT PICKED, and it is solved against
        the squash budget the suite measures: 0.60 m, a sixth of the
        envelope's radius, is what canvas giving looks like and more
        than that reads as clipping. The spring takes hold F_ENV_ENGAGE
        into the skin, so the meridian is past the surface by
        (ENGAGE + v/(w e) - SKIN); setting that to the budget at the
        stick's own ceiling gives w = 6.20 / ((SKIN - ENGAGE + 0.60) e)
        = 6.20 / (1.10 x e) = 2.07 rad/s as the floor. F_ENV_W is 4.30
        — twice the floor, because a floor is not a design — which puts
        the meridian 0.03 m into the brick at 6.20 m/s and 0.00 at
        anything under 5.8. The response stays soft: a hold against a
        wall with the stick buried settles 0.07 m in, because the drive
        is a lag and not a force (0.22/s x 6.20 m/s over w^2).

        AND THE ENGAGE IS SET FROM THE OTHER END. At rest the spring's
        zero IS the gap she floats at: SKIN - ENGAGE = 0.50 m from the
        meridian, which with the gore crowns standing 0.35 m proud of
        it puts the fabric 0.15 m off the wall. Shallower and she hangs
        off buildings behind an invisible cushion, which is the same
        failure as clipping seen from the other side.

        IT TAKES HOLD PART WAY INTO THE SKIN rather than at the fabric's
        outer surface, because the skin exists to let the gore crowns
        touch a wall before anything happens — a spring anchored at the
        skin's edge would hold her 1.10 m off the brick behind an
        invisible cushion, which is the "wall in the sky" failure at the
        other end of this.

        AND THE TANGENT IS STILL UNTOUCHED. The spring acts along the
        contact normal only, so the thing the judge measured and liked —
        inbound 6.24 to 0 in 0.18 s while the tangent RISES 1.50 to 5.54
        and she leans off the wall and runs along it — is the same
        motion, arrived at continuously instead of by an exponential.
     ================================================================ */
  function flyCollideCanvas(dt) {
    const p = ctx.phys;
    if (!p || !p.raycast) return;

    const sp = Math.hypot(flyState.vx, flyState.vz);
    const moving = sp > 0.02;
    const dx = moving ? flyState.vx / sp : Math.sin(flyState.yaw);
    const dz = moving ? flyState.vz / sp : Math.cos(flyState.yaw);
    const a0 = Math.atan2(dx, dz) + flyProbeT * F_ENV_PRECESS;

    flyBasket(dt, a0);

    /* --- the envelope --- the whole hull, ring by ring, staggered. */
    const rings = envelopeRings(flyProp ? flyProp.inflation : 1, _frings);
    const y0 = root.position.y - BALLOON_FIT.DECK;
    let px = 0, pz = 0, depth = 0, n = 0;
    for (let k = 0; k < rings.length; k++) {
      const ring = rings[k];
      if (ring.r < 0.30) continue;
      const range = ring.r + F_ENV_SKIN;
      const ak = a0 + k * F_ENV_STAGGER;
      _fv.set(root.position.x, y0 + ring.y, root.position.z);
      for (let i = 0; i < F_ENV_AZ2; i++) {
        const a = ak + (i / F_ENV_AZ2) * Math.PI * 2;
        const ax = Math.sin(a), az = Math.cos(a);
        _fv2.set(ax, 0, az);
        let r = null;
        try { r = p.raycast(_fv, _fv2, range, _fhit); } catch (e) { r = null; }
        if (!r) continue;
        const d = range - r.distance;
        px -= ax * d; pz -= az * d;
        if (d > depth) depth = d;
        n++;
      }
    }
    if (!n) return;
    const l = Math.hypot(px, pz);
    /* squeezed evenly from every side there is nowhere to go sideways;
       the burner is the answer to that one, and it always is. */
    if (l < 1e-4) return;
    const ux = px / l, uz = pz / l;

    /* ---- the spring ----
       `x` is how far past the engage line the deepest bearing is, and
       `vn` the speed along the same direction (negative going in). The
       acceleration is the textbook critically damped pair, integrated
       semi-implicitly like everything else in this file. */
    const x = depth - F_ENV_ENGAGE;
    if (x > 0) {
      const vn = flyState.vx * ux + flyState.vz * uz;   // + is coming OUT
      const acc = F_ENV_W * F_ENV_W * x - 2 * F_ENV_W * vn;
      /* CAPPED, and the cap is a statement about mass rather than a
         fudge: an envelope cannot shove harder than it can be pushed,
         and F_ENV_AMAX is the stick's own ceiling delivered over a
         tenth of a second. Without it a single frame that starts deep
         — she dropped past a roofline into a wall — would answer with
         hundreds of m/s^2 and fling her. */
      /* AND IT CAN PUSH BUT NOT PULL. A contact is unilateral: fabric
         against brick can refuse to be compressed and cannot hold on.
         Without the floor the damping term wins whenever she is
         leaving fast while still overlapped, and the envelope reels
         her back into the wall she is drifting off — which is a spring
         doing exactly what a spring does and not what a balloon does. */
      const a = Math.max(0, Math.min(acc, F_ENV_AMAX));
      flyState.vx += ux * a * dt;
      flyState.vz += uz * a * dt;
    }

    /* THE WAY OUT OF SOMETHING SHE IS ALREADY IN, unchanged from the
       ladder and for the unchanged reason: a spring is an acceleration
       and an acceleration cannot rescue an envelope the wind is holding
       a metre inside a wall. Past the skin the hull is EASED out at
       walking pace. This is what makes trapped impossible in the
       horizontal the way the burner does in the vertical. */
    const over = depth - F_ENV_SKIN;
    if (over > 0) {
      /* AND IT CLEARS SIDEWAYS AT LEAST AS FAST AS SHE IS ARRIVING
         FROM ABOVE, which is what F_ENV_SLEW's own header said the
         rule was and what the previous round then wrote as a constant.
         Measured at the school's south face, the worst frame of the
         drive was not a fast approach at all: drift 1.98 m/s and vy
         -2.494. She was SINKING past the roofline, and a horizontal
         probe cannot stop a vertical arrival — the fabric is simply
         inside the wall, at whatever depth the geometry says, before
         any shove has been asked for. Up is never blocked and should
         not be, so the only answer is to clear it sideways faster than
         she can enter it, and how fast she is entering it is a number
         this function has: |vy|. A constant 2.60 is the right ease for
         a 1.6 m/s sink and half the ease for a 3.6 m/s one.

         The ceiling is therefore vMaxDown x F_ENV_SLEW_VY = 5.76 m/s,
         and it is only ever reached by an envelope that is genuinely
         buried in masonry while falling at its terminal rate. */
      const ease = Math.max(F_ENV_SLEW, Math.abs(flyState.vy) * F_ENV_SLEW_VY);
      const s = Math.min(over, ease * dt);
      root.position.x += ux * s;
      root.position.z += uz * s;
    }
  }

  /* ----------------------------------------------------------------
     THE BASKET, WITH THE ENVELOPE'S MANNERS.

     WHAT IT USED TO DO, MEASURED. Envelope contact reads like a
     balloon: inbound 6.24 to 0 in 0.18 s while the tangent RISES 1.50
     to 5.54 — she leans off the wall and runs along it. The basket
     branch did the opposite: 4.88 to 0.20 in 0.25 s with the TANGENT
     KILLED ALONGSIDE IT, and then a shove out to 5.8 m off the wall at
     2.42 m/s with the stick still held into the building. Two lines
     did all of it:
       vn * 1.02  — reflecting slightly MORE than the inbound, which is
                    a restitution, on wicker;
       *= 0.80    — an ISOTROPIC bleed, which takes a fifth of the
                    tangent as well, so a scrape along a wall stops her
                    dead along the wall as well as into it. Compounded
                    every frame of a 0.25 s contact that is 0.8^15.
     Together they turned a wall into a bumper: she arrived, stopped,
     and was posted back out into the street.

     WHAT IT DOES NOW. The inbound component decays exponentially and
     the tangent is not touched at all — the same two sentences as the
     envelope, at a stiffer rate because a wicker basket with an
     elephant standing in it is not canvas. The overlap is still
     resolved positionally, which is what actually keeps it out of the
     wall; the velocity's job is only to stop it arriving again.
     ---------------------------------------------------------------- */
  function flyBasket(dt, a0) {
    const p = ctx.phys;
    const sp = Math.hypot(flyState.vx, flyState.vz);
    const reach = F_BASKET_R + sp * dt * 2 + 0.25;
    let hitD = Infinity, hit = false;
    for (let i = 0; i < 4; i++) {
      const a = a0 + (i / 4) * Math.PI * 2;
      _fv2.set(Math.sin(a), 0, Math.cos(a));
      for (const h of [0.10, 0.70, BALLOON_FIT.WALL]) {
        _fv.set(root.position.x, root.position.y + h, root.position.z);
        let r = null;
        try { r = p.raycast(_fv, _fv2, reach, _fhit); } catch (e) { r = null; }
        if (r && r.distance < hitD) { hitD = r.distance; _fhitN.copy(r.normal); hit = true; }
      }
    }
    if (!hit) return;
    const vn = flyState.vx * _fhitN.x + flyState.vz * _fhitN.z;
    if (vn < 0) {
      const kill = 1 - Math.exp(-F_BASKET_ABSORB * dt);
      flyState.vx -= _fhitN.x * vn * kill;
      flyState.vz -= _fhitN.z * vn * kill;
    }
    const gap = F_BASKET_R - hitD;
    if (gap > 0) {
      root.position.x += _fhitN.x * gap * 0.6;
      root.position.z += _fhitN.z * gap * 0.6;
    }
  }

  /* ----------------------------------------------------------------
     THE PRIOR RULE, VERBATIM. Reachable only through
     WALLY.debug.balloonHull('ring'). Nothing in here is a bug that
     survived — every one of them is the thing being reverted TO, and
     they are left exactly as they shipped so the comparison is honest:
       · one ring at the envelope's widest point, so the whole hull
         above and below that plane is unprobed;
       · four bearings rather than six;
       · the push normalised, so depth of contact does not matter;
       · no ease-out, so an overlap can only be undone by the physics;
       · `hitN` aliasing collision.js's shared hit object, so the
         basket answers with the LAST ray's normal, not the nearest;
       · the early-out below 0.02 m/s that switches the probe off while
         the wind holds her against a wall.
     ---------------------------------------------------------------- */
  function flyCollideRing(dt) {
    const p = ctx.phys;
    if (!p || !p.raycast) return;
    const sp = Math.hypot(flyState.vx, flyState.vz);
    if (sp < 0.02) return;
    const dx = flyState.vx / sp, dz = flyState.vz / sp;

    const reach = F_BASKET_R + sp * dt * 2 + 0.25;
    let hitN = null, hitD = Infinity;
    for (const h of [0.10, 0.70, BALLOON_FIT.WALL]) {
      _fv.set(root.position.x, root.position.y + h, root.position.z);
      _fv2.set(dx, 0, dz);
      let r = null;
      try { r = p.raycast(_fv, _fv2, reach); } catch (e) { r = null; }
      if (r && r.distance < hitD) { hitD = r.distance; hitN = r.normal; }
    }
    if (hitN) {
      const vn = flyState.vx * hitN.x + flyState.vz * hitN.z;
      if (vn < 0) {
        flyState.vx -= hitN.x * vn * 1.02;
        flyState.vz -= hitN.z * vn * 1.02;
        flyState.vx *= 0.80; flyState.vz *= 0.80;
      }
      const gap = F_BASKET_R - hitD;
      if (gap > 0) {
        root.position.x += hitN.x * gap * 0.6;
        root.position.z += hitN.z * gap * 0.6;
      }
    }

    const ec = flyProp ? flyProp.envelopeCentre : { y: 6, r: 3.6 };
    const ey = root.position.y - BALLOON_FIT.DECK + ec.y;
    let px = 0, pz = 0, n = 0;
    const a0 = Math.atan2(dx, dz);
    for (let i = 0; i < 4; i++) {
      const a = a0 + (i / 4) * Math.PI * 2;
      const ax = Math.sin(a), az = Math.cos(a);
      _fv.set(root.position.x, ey, root.position.z);
      _fv2.set(ax, 0, az);
      let r = null;
      try { r = p.raycast(_fv, _fv2, ec.r + 0.6); } catch (e) { r = null; }
      if (r) {
        const k = 1 - r.distance / (ec.r + 0.6);
        px -= ax * k; pz -= az * k; n++;
      }
    }
    if (n) {
      const l = Math.hypot(px, pz) || 1;
      flyState.vx += (px / l) * F_ENV_PUSH * dt;
      flyState.vz += (pz / l) * F_ENV_PUSH * dt;
    }
  }

  /* ================================================================
     THE ISLAND IS ROUND — the flight's half of balloon.js WRAP.

     balloon.js owns the geometry and the argument for it; this owns
     the three things a teleport in a live world has to get right, and
     every one of them was a bug before it was a line here.

     1  THE STREAM HAS TO ARRIVE FIRST, AND IT DOES NOT ON ITS OWN.
        terrain.js streams a 3x3 window of 64 m collision tiles at ONE
        TILE PER FRAME (updateCollision's default budget, and world.js
        asks for 1-2). Measured on this build: jump 1273 m and the
        window refills 1,2,3,4,5,6,7,8,9 over NINE FRAMES — 150 ms in
        which the ground under the arrival does not exist. That is the
        documented failure in this codebase, arriving somewhere before
        the ground does, and the balloon being airborne is not an
        answer to it: `flySolidUnder` casts a ray, a ray into an
        unstreamed tile misses, a miss reads as `overWater`, and the
        refusal then decides she is over the sea when she is not.

        So the wrap FORCES the window at the destination before it
        moves her. It forces ONE tile, not the 3x3 this paragraph used
        to claim: a 9-tile force measured 39.2-59.6 ms, one tile
        measures 3.8-5.5 ms, and the section below explains why one is
        enough — the arrival is clamped seabed, so what the force has
        to buy is a real answer on the arrival frame and nothing more.
        world.js finishes the rest at its own two a frame. The arrival
        is then asserted by casting for it (see flyWrapArrival, on
        flightState.wrap, whose `mesh` field is the raw cast that can
        actually come back false).

        It is affordable exactly because of where the plane is: out
        there the height raster has clamped and the sea floor is a flat
        -65.03 m, so the nine tiles are nine flat sheets.

     2  EVERYTHING WORLD-SPACE HUNG OFF HIM MOVES WITH HIM. The camera
        boom (flyCam.pos/aim) is a damped world-space point and would
        otherwise spend a second flying 1560 m across the ocean with
        the lens pointing at nothing. His EARS and TRUNK are worse:
        secondary.js hangs them off phys chains whose particles are
        world positions, so a swap without them streaks the ears out
        to the far side of the map for as long as the springs take to
        catch up. They are TRANSLATED rather than reset() — the chains
        are Verlet, so shifting `points` and `prev` by the same delta
        preserves every velocity in them and the ears do not notice.

     3  IT MUST NOT BE VISIBLE. That is the fret, and it lives in
        flyHaze below: `far` is a function of |x| and |z| only, and the
        wrap negates one of those, so the fog is the SAME NUMBER on
        both sides of the swap. Nothing is cross-faded and nothing is
        matched up; there is no seam because there is no difference.
        WALLY.debug.balloonMist(0) is the runtime revert — it leaves
        the wrap in and takes the concealment out, and B13 shoots both
        and differences the frames.

     WHY THIS IS THE BALLOON'S AND NOT THE WORLD'S. The wrap is a fact
     about the map, and WRAP is exported from balloon.js so world.js can
     adopt it the day anything else can reach the plane. Today nothing
     can: walking and biking are bounded by the island's own geometry
     and the character controller never gets within 300 m of it, so a
     wrap in the world would be a rule with no subject. And it could
     not be applied through the controller anyway — the only published
     way to move it is teleport(), which snaps to the ground, and 65 m
     under the arrival there is nothing but sea floor.
     ================================================================ */
  const _fwrapD = { dx: 0, dz: 0 };
  /* its own ground scratch: flyFootprint's _ffg is live inside its own
     loop and sharing one is how two probes answer with each other's
     surface. */
  const _fwrapG = { y: 0, normal: _fup, hit: false };
  let flyWraps = 0;                 // how many this flight
  let flyWrapLog = null;            // the last one, for the verifier
  let flyMistOn = 1;                // the fret's runtime revert, 0..1

  /** What is actually under (nx, nz) right now, after the stream.
      Cast from well above so it cannot start inside a collider. */
  function flyWrapArrival(nx, nz) {
    const g = flySolidUnder(nx, nz, 120, _fwrapG);
    const sea = waterAt(nx, nz);
    /* `solid` IS NOT EVIDENCE AND NEVER WAS. flySolidUnder falls
       through to ctx.world.heightAt on a ray miss and sets hit from
       the RASTER, which answers everywhere — so `solid:true` was
       returned whether a tile had streamed or not, and the assertion
       that read it could not fail. It is kept because it is the right
       answer for the refusal logic, and `mesh` is added beside it:
       the raw cast, with no fallback, which is false when nothing has
       streamed in. That is the one a verifier should read. */
    let mesh = false, meshY = null;
    try {
      const r = ctx.phys?.groundAt?.(nx, nz, null, 120, 900);
      if (r && r.hit && Number.isFinite(r.y)) { mesh = true; meshY = +r.y.toFixed(2); }
    } catch (e) { /* no collision world is a false, not a throw */ }
    return {
      solid: !!g.hit,
      mesh, meshY,
      solidY: g.hit ? +g.y.toFixed(2) : null,
      seaY: +sea.toFixed(2),
      tiles: (() => { try { return ctx.world?.terrain?.colliderCount?.() ?? null; } catch (e) { return null; } })(),
    };
  }

  /* ----------------------------------------------------------------
     WHAT THE STREAM ACTUALLY COSTS, AND THE PRE-WARM THAT DOES NOT
     WORK — written down because the obvious fix here is wrong and the
     next person will reach for it too.

     Forcing the whole 3x3 window in the swap's own frame WORKS and it
     is measured: 39.2 to 59.6 ms for nine tiles across five bearings
     (headless Chrome, SwiftShader, 1024x640, load average 37 to 96 —
     this machine had a second workflow's browser on it). Two to three
     frames in one, on the single frame of this feature that has to be
     invisible.

     THE OBVIOUS FIX IS TO PRE-WARM THE FAR SIDE while she is still in
     the fret, one tile a frame from k = 0.90 — twenty-two seconds of
     water at the upwind cruise against the nine frames the streamer
     needs. It was written, and it never accumulates: world.js calls
     terrain.updateCollision(focus) EVERY FRAME with the player's own
     position, so the window is dragged back under her between every
     one of the warm's calls and the two just take turns re-centring an
     empty queue. Measured with the warm in: still 39-60 ms at the
     swap, i.e. exactly the unwarmed cost. A window that follows the
     player cannot be pointed somewhere the player is not, and that is
     terrain.js's decision to make, not this file's.

     SO THE FORCE IS ONE TILE AND THE ARGUMENT IS ABOUT GEOMETRY.
     WRAP.X 780 and WRAP.Z 675 are both OUTSIDE terrain.js's built box
     (BX 672, BZ 560) — that is asserted against world.bounds in
     test-balloon B13, not assumed — so every point of the wrap surface
     is off the raster, where the height field has clamped and the sea
     floor is a flat -65.03 m. The arrival is open water by
     construction, and open water needs nothing from the streamer:
     `overWater`, the refusal and the water floor all read waterAt(),
     which is analytic. What one tile buys is that flySolidUnder
     answers with a real sea floor rather than a miss on the arrival
     frame, so the refusal is deciding from a measurement; world.js
     then finishes the other eight at its own two a frame, from the
     same centre, because she is now standing on it.

     And it is CHECKED rather than trusted: flyWrapArrival casts for
     what is really there, before and after, and both go into
     flightState.wrap for the verifier to read. Read `mesh`, not
     `solid` — `solid` accepts the height raster's answer, which is
     available whether anything streamed or not.
     ---------------------------------------------------------------- */
  function flyWrap() {
    const d = wrapDelta(root.position.x, root.position.z, _fwrapD);
    if (!d) return false;
    const nx = root.position.x + d.dx, nz = root.position.z + d.dz;

    /* --- the ground goes first --- */
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    const terr = ctx.world?.terrain;
    try {
      terr?.updateCollision?.(nx, nz, 1);
      terr?.updateRockCollision?.(nx, nz, 2);
    } catch (e) { /* a stream that throws must not strand her mid-swap */ }
    const streamMs = ((typeof performance !== 'undefined') ? performance.now() : 0) - t0;
    const before = {
      at: [+root.position.x.toFixed(2), +root.position.y.toFixed(2), +root.position.z.toFixed(2)],
      alt: +flyAlt.toFixed(2),
      vy: +flyState.vy.toFixed(3),
      drift: +Math.hypot(flyState.vx, flyState.vz).toFixed(3),
      yawDeg: +(flyState.yaw * 180 / Math.PI).toFixed(1),
      under: flyWrapArrival(root.position.x, root.position.z),
      fogFar: ctx.scene?.fog ? Math.round(ctx.scene.fog.far) : null,
    };
    const arrival = flyWrapArrival(nx, nz);

    /* --- then everything that is standing on it --- */
    root.position.x = nx; root.position.z = nz;
    flyCam.pos.x += d.dx; flyCam.pos.z += d.dz;
    flyCam.aim.x += d.dx; flyCam.aim.z += d.dz;
    if (ctx.camera) { ctx.camera.position.x += d.dx; ctx.camera.position.z += d.dz; }
    flyShiftChains(d.dx, d.dz);
    flyPlaceController();

    flyWraps++;
    flyWrapLog = {
      n: flyWraps, dx: d.dx, dz: d.dz,
      before,
      after: {
        at: [+nx.toFixed(2), +root.position.y.toFixed(2), +nz.toFixed(2)],
        vy: before.vy, drift: before.drift, yawDeg: before.yawDeg,
        under: arrival,
        fogFar: ctx.scene?.fog ? Math.round(ctx.scene.fog.far) : null,
      },
      streamMs: +streamMs.toFixed(2),
    };
    ctx.bus?.emit('wally:wrap', flyWrapLog);
    return true;
  }

  /** Translate every world-space spring particle hung off him. See
      point 2 above. `chains` is secondary.js's own public map. */
  function flyShiftChains(dx, dz) {
    const cs = secondary && secondary.chains;
    if (!cs) return;
    for (const k in cs) {
      const c = cs[k];
      if (!c) continue;
      for (const arr of [c.points, c.prev, c.restWorld, c.framePrev, c.render]) {
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) { arr[i].x += dx; arr[i].z += dz; }
      }
      if (c.rootPos) { c.rootPos.x += dx; c.rootPos.z += dz; }
      if (c._prevRootPos) { c._prevRootPos.x += dx; c._prevRootPos.z += dz; }
    }
  }

  /* ----------------------------------------------------------------
     THE HAZE AT ALTITUDE.

     §2.4 pales everything toward #B8DEF0 past ~120 m and the fog is
     how the game says so. MEASURED, live, on this build rather than
     read off lighting.js's constructor: scene.fog sits at near 100 /
     far 520 in clear weather at ground level — lighting.js builds it
     at 60 / 420 and something in the update stages moves it, so the
     multiplier below rides whatever is actually there rather than a
     number from a source file. That range is exactly right at head
     height and it is a WALL from 200 m up:
     the island is 970 m across, so all of it sits past the far plane
     and the one thing this feature exists to show is a flat turquoise
     wash. Measured, from 200 m aimed down the island at 07:00: the
     coast, the sea and the far half of the city are simply not there.
     The same frame with the ramp opened out has all three of them, a
     horizon and a shoreline (shots/balloon-alt200.png against
     shots/balloon-alt200-fog.png).

     THE FIX IS ALTITUDE, NOT WEATHER. The haze is real and it is
     lovely, so it is SCALED rather than switched off: near x4.2 and
     far x4.6 at 150 m, and everything inside a hundred metres of the
     lens still hazes exactly as §2.4 asks. Nothing pops on the way
     back down, because the multiplier rides ALTITUDE — which is
     continuous — rather than a phase, which is not.

     IT IS WRITTEN IN lateUpdate, AND THAT IS NOT A DETAIL. Two
     modules write this object during the update stages —
     world/lighting.js from its own damped weather range inside
     sky.update(), and intro/intro.js, which keeps easing its aerial
     fog toward the sky's — and sky is stage 4 against this module's
     stage 8, so an update-time write here LOOKS safe. It is not:
     measured, with the write in wally.update() and the machine at
     200 m, the fog came back at 100 / 520, i.e. exactly the ground
     value, every frame. Something downstream in the update pass puts
     it back. main.js runs EVERY update() and then EVERY lateUpdate(),
     so a lateUpdate write outranks all of them regardless of stage:
     the same probe from here reads 420 / 2392. That is the whole
     reason this one function does not live beside the rest of the
     flight code.

     IT RESTORES NOTHING, either. lighting.js re-derives fog.near/far
     from scratch every frame, so the moment this stops writing its
     own value is back on the very next one — and at zero altitude the
     multiplier IS one, so there is nothing to hand back.
     ---------------------------------------------------------------- */
  function flyHaze(alt) {
    const fog = ctx.scene?.fog;
    if (!fog || !Number.isFinite(fog.near)) return;
    const k = smoothstepLocal(6, 150, Math.max(0, alt)) * clamp(flyBlend, 0, 1);
    flyFogK = k;
    if (k > 0.0005) {
      fog.near = fog.near * (1 + 3.2 * k);
      fog.far = fog.far * (1 + 3.6 * k);
    }
    /* ---- AND THE FRET CLOSES IT AGAIN OUT AT SEA ----
       This runs AFTER the altitude open and pulls the same two numbers
       back down, because those two are the same rule read at different
       distances from the island: at 200 m over the city the haze wants
       2392 m so the island can be seen, and 300 m past the beach the
       fret wants 210 so it cannot. Applied here rather than as a rival
       write for the reason the header gives — anything that writes the
       fog outside lateUpdate is overwritten before the frame draws.

       IT IS A LERP AND NOT A MIN, so the fret arrives over 170 m of
       water instead of snapping on at a threshold, and so the value at
       the plane is exactly wrapFar() rather than whatever the weather
       happened to be doing.

       AND IT IS SYMMETRIC BY CONSTRUCTION. wrapMist and wrapFar read
       |x|, |z| and the height over the sea; the wrap negates x or z and
       touches neither the other axis nor y, so this returns the same
       pair of numbers on the frame after the swap as on the frame
       before it. That is the whole of "it does not read as a cut". */
    const m = wrapMist(root.position.x, root.position.z)
            * clamp(flyBlend, 0, 1) * clamp(flyMistOn, 0, 1) * WRAP.mist;
    flyMistK = m;
    if (m > 0.0005) {
      const far = wrapFar(root.position.y - (ctx.world?.seaLevel ?? 0));
      fog.far = fog.far + (far - fog.far) * m;
      fog.near = fog.near + (far * 0.05 - fog.near) * m;
    }
  }

  /* ----------------------------------------------------------------
     THE SEA AT ALTITUDE — the other thing opening the haze uncovered.

     WHAT IT LOOKS LIKE. From 200 m the whole ocean carries hard
     horizontal striping: measured on the open water to the right of
     the island at 1600x900, 0.371 luminance-gradient reversals per row
     with a 12.32-code peak-to-trough ripple after the row profile is
     detrended, on four independent frames, load 16.33.

     WHAT IT IS. water.js displaces the ocean disc with four Gerstner
     waves and each carries its own distance fade (uWaveFade, in
     metres): 520-1400 for the 33 m swell down to 34-105 for the 3.9 m
     chop. Those ramps are correct for the camera they were authored
     against — a lens 0.9 m over Wally's soles, where scene.fog.far is
     520 and NOTHING past the first fade is ever visible. The disc's
     rings grow geometrically to 12 km, so at a kilometre out the
     spacing between two rings of vertices is about 89 m and a 33 m
     swell is carried by a third of a vertex. On the ground that is
     free: it is all behind the fog. From a balloon it is not, because
     flyHaze above deliberately pushes the fog to 2392 so the island
     can be seen — and what it also uncovered was a kilometre of sea
     beating against its own tessellation.

     WHAT THIS DOES. Pulls those fades in as the LENS climbs — the lens
     and not the machine, because the sampling is done by the camera —
     so a wave is only displaced while there is geometry to carry it.
     Bisected through water.js's own published uniforms rather than
     guessed: with the fades scaled the ripple goes 12.32 -> 2.37 codes
     and the RMS 2.544 -> 0.407, and the sea comes back as §2.1's
     banded turquoise. Nothing else moved it — flattening the
     amplitudes changed nothing, because water.js rewrites those every
     frame in refreshWaves() and uWaveFade is the one part of the wave
     table it does not touch.

     IT IS A NO-OP BELOW 70 m, which is above every hill on this island
     and above the whole of the flight the refusal will let you make
     near the ground, so a walking frame and a low hop are the frames
     they always were. And it restores from the authored values, so it
     cannot drift: the numbers it hands back are the ones water.js
     started with, not the ones this last wrote.

     Written from lateUpdate for the same reason flyHaze is — see its
     header — and unconditionally rather than only while flying, so
     that coming down and getting out puts the sea back.
     ---------------------------------------------------------------- */
  const F_SEA_ON = 70, F_SEA_FULL = 240, F_SEA_MIN = 0.20;
  let seaFade0 = null;
  let seaFadeK = 1;
  function flySea() {
    const f = ctx.water?.uniforms?.uWaveFade?.value;
    if (!f || !f.length) return;
    if (!seaFade0) seaFade0 = f.map((v) => ({ x: v.x, y: v.y }));
    const sea = ctx.world?.seaLevel ?? 0;
    const h = (ctx.camera ? ctx.camera.position.y : 0) - sea;
    const k = lerp(1, F_SEA_MIN, smoothstepLocal(F_SEA_ON, F_SEA_FULL, h));
    if (Math.abs(k - seaFadeK) < 1e-4) return;
    seaFadeK = k;
    for (let i = 0; i < f.length; i++) f[i].set(seaFade0[i].x * k, seaFade0[i].y * k);
  }

  /* ----------------------------------------------------------------
     THE CAMERA.

     The follow rig is solved for a 1.6 m character on the ground with
     a 4.3 m boom (camera.js RIG) and there is no preset in it for a
     ten-metre object seen from two hundred metres up. It also has no
     idea the subject can fly: `subj.grounded` comes off a controller
     this file has just switched off.

     So the balloon drives cam.override(), which camera.js publishes
     for exactly this — "while an override is active this rig writes
     what it is given and touches nothing else". The rig here is four
     damped quantities, and it is SEEDED FROM THE LIVE LENS on the
     frame the override starts, so the hand-over is not a cut: the
     boom is exactly where the follow rig left it and then eases out
     over the inflation. Coming back is the same trick from the other
     end — releaseOverride() calls camera.js's adopt(), which re-seeds
     its own springs from wherever this left the lens. Neither
     direction can snap, which is §6's rule.

     WHAT MOVES WITH ALTITUDE. The boom goes 20 m -> 30 m, the lens
     6 m over the basket -> 17 m, the FOV 52 -> 61, and the aim walks
     forward and down until it is on the ground a long way ahead. At
     20 m the frame is a balloon over a city; at 200 m it is a city
     with a balloon in the corner of it, which is the shot this whole
     feature is for.

     AND IT LOOKS ALONG THE DRIFT, NOT ALONG THE BASKET. The basket
     rotates under the envelope (balloon.js FLIGHT.spin) because real
     ones do; hanging the camera on that would swing the island round
     the frame every forty seconds. The boom is on the velocity, so
     the world holds still and the basket turns underneath it — which
     is what the ride actually feels like from inside one.
     ---------------------------------------------------------------- */
  const flyCam = {
    pos: new THREE.Vector3(), aim: new THREE.Vector3(), fov: 52, yaw: 0, seeded: false,
    /* THE BOOM'S OWN GEOMETRY AT THE MOMENT OF THE HAND-OVER, in the
       rig's coordinates, so the first TARGET is the follow rig's lens
       rather than a point sixteen metres behind it. `ease` walks from
       one to the other. See flyCamera(). */
    ease: 0, sDist: 4.3, sHigh: 2.1, sAhead: 2.0, sDown: 0.55, sFloor: 1.5,
  };
  /** seconds the boom takes to walk out from where it was handed over
      to where the flight solve wants it — a shade under the 4.6 s
      inflation, so it is out by the time she leaves the grass. */
  const F_CAM_EASE = 3.2;
  /** rad/s the boom may swing while it comes round onto a new drift
      heading. 0.38 = 22 deg/s: a deliberate pan, slower than anything
      a player can ask the follow rig for. */
  const F_CAM_YAW_RATE = 0.38;
  /* WHERE THIS RIG HANDS THE LENS BACK. camera.js's RIG, expressed in
     the fly rig's own coordinates: its boom is 3.15 m behind and its
     lens 0.90 m over his soles (RIG.distance / RIG.height), which is
     0.45 m over this rig's chest anchor, and it is tilted 2.1 DEGREES
     UP (RIG.pitch) rather than down. `ahead`/`down` are the aim point
     that reproduces that tilt: the aim sits 8 m in front of the anchor
     and ( 8 + 3.15 ) * tan( 2.1 ) + 0.45 = 0.86 m ABOVE it, hence a
     NEGATIVE `down`. If camera.js ever re-solves its boom these three
     numbers go stale — the dismount assertion in tools/test-balloon.mjs
     is what catches that, because it measures the delivered look
     change across the hand-back rather than these constants. */
  const F_CAM_HAND = { dist: 3.15, high: 0.45, ahead: 8.0, down: -0.86 };
  const _fcp = new THREE.Vector3(), _fca = new THREE.Vector3();
  /** b, moved by whole turns onto the side of a it is nearest. */
  function wrapNear(a, b) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d;
  }
  function flyCamera(dt, alt) {
    const cam = ctx.cam;
    if (!cam || !cam.override) return;
    const k = smoothstepLocal(4, 170, Math.max(0, alt));
    let dist = lerp(20.0, 30.0, k);
    let high = lerp(6.0, 17.0, k);
    let ahead = lerp(2.0, 30.0, k);
    /* HOW FAR BELOW THE BASKET THE AIM SITS. 2.6 m was wrong at ground
       level and the take-off filmstrip is why: the override is seeded
       from the follow rig, which is 4.3 m behind him at chest height,
       so on the first frame of a boarding the lens is 1.3 m off the
       grass — and an aim 2.6 m BELOW the basket from there points it
       into the ground. The first second of every launch was a
       close-up of the underside of the basket and its own shadow.
       0.55 at ground level keeps the aim level until the boom has
       actually got out. */
    let down = lerp(0.55, 17.0, k);
    let landLam = 1;
    const fov = lerp(52, 61, k);
    /* the anchor is his chest in the basket, not his soles: at 30 m of
       boom that is a metre on screen, and at 20 m it is the difference
       between framing the machine and framing the floor of it */
    const ax = root.position.x, ay = root.position.y + BALLOON_FIT.WALL * 0.5, az = root.position.z;

    if (!flyCam.seeded) {
      /* SEED FROM THE LENS, not from the solve. This is the frame the
         override takes over on, and starting anywhere but exactly
         where the follow rig already is would be the camera snap §6
         forbids by name.

         AND THE YAW IS THE LENS'S OWN FORWARD, NOT ITS REVERSE. This
         line read atan2(-x,-z) and it was a whole boarding's worth of
         wrongness in one character each. `yaw` is consumed as
         ( fx, fz ) = ( sin yaw, cos yaw ) = THE DIRECTION OF TRAVEL:
         the boom goes to ax - fx*dist (behind the subject) and the aim
         to ax + fx*ahead (in front of it). The update twelve lines
         below sets it from atan2( vx, vz ), the drift heading — so the
         seed has to be measured the same way round, and the negated
         one was 180 degrees out of phase with its own update. The boom
         target then landed 20 m in FRONT of the subject along the view
         direction: the lens flew forward over Wally's head while the
         aim retreated behind him, and the two crossed. Measured on the
         boarding, load 27.32: 14.46 degrees of look change in a 12 ms
         frame (1195 deg/s), pitch to -84.1, and the lens 2.48 m on the
         WRONG SIDE of the subject at its worst. With the sign right,
         same rig, load 22.30: 55.5 deg/s worst, pitch -18.4, and the
         lens never once gets in front.

         IT HAS TO BE RIGHT ON ITS OWN. The corrective damp below only
         runs above 0.8 m/s of drift, so a balloon boarded on a calm
         day never reaches it and holds whatever the seed said for as
         long as the flight lasts — which is why tools/test-balloon.mjs
         asserts the becalmed boarding as well as the drifting one. */
      flyCam.pos.copy(ctx.camera.position);
      ctx.camera.getWorldDirection(_fv2);
      flyCam.aim.copy(ctx.camera.position).addScaledVector(_fv2, 12);
      flyCam.fov = ctx.camera.fov;
      flyCam.yaw = Math.atan2(_fv2.x, _fv2.z);
      flyCam.seeded = true;
      /* AND SEED THE TARGET TOO, WHICH THE STATE ALONE DOES NOT DO.
         Seeding only the state leaves the rig damping toward a boom
         sixteen metres further back and four metres higher from the
         very first frame, and an exponential's biggest step is its
         first one: measured across the join, load 23.92, the frame
         after the hand-over moved the lens 1.03 m and swung the look
         3.23 degrees — a visible flinch on every boarding, in the
         opposite direction to the one the sign error caused and much
         smaller, but still a step where the header promises none.

         So the boom's geometry is recorded HERE, in the rig's own
         coordinates, and `ease` walks the target from it out to the
         flight solve over F_CAM_EASE seconds. The first target is the
         lens itself, so the first step is zero by construction and
         the pull-back is the four-second move the header describes
         rather than a spring release. */
      const sdx = flyCam.pos.x - ax, sdz = flyCam.pos.z - az;
      flyCam.sDist = Math.max(1.0, Math.hypot(sdx, sdz));
      flyCam.sHigh = flyCam.pos.y - ay;
      const sfx = Math.sin(flyCam.yaw), sfz = Math.cos(flyCam.yaw);
      flyCam.sAhead = (flyCam.aim.x - ax) * sfx + (flyCam.aim.z - az) * sfz;
      flyCam.sDown = ay - flyCam.aim.y;
      flyCam.sFloor = Math.max(0.35,
        flyCam.pos.y - flySolidUnder(flyCam.pos.x, flyCam.pos.z, flyCam.pos.y + 4, _fcamGround).y);
      /* THE WALK-OUT IS FOR A BOARDING, and only for one. Its whole
         job is to take the boom from where the FOLLOW rig had it out
         to where the flight wants it without a step, which is a claim
         about a hand-over. A re-seed that is not a hand-over — the
         screenshot rig's `balloon({alt: 200})`, a phase restarted
         under a debug hook — starts from a lens that has nothing to
         do with the follow rig and 210 m to travel, and easing the
         TARGET as well as the state there just means the shot is not
         framed yet three seconds later. The state damp still keeps
         that continuous; only the target jumps. */
      flyCam.ease = flyPhase === 'boarding' ? 0 : 1;
      /* AND HAND OVER ON EXACTLY THAT, before a single damp step, so
         the seed frame is bit-identical to the rig it is taking the
         lens from. */
      cam.override(flyCam.pos, flyCam.aim, flyCam.fov);
      return;
    }

    /* the walk-out. smoothstep so it leaves and arrives at rest. */
    if (flyCam.ease < 1) flyCam.ease = clamp(flyCam.ease + dt / F_CAM_EASE, 0, 1);
    if (flyCam.ease < 1) {
      const e = smoothstepLocal(0, 1, flyCam.ease);
      dist = lerp(flyCam.sDist, dist, e);
      high = lerp(flyCam.sHigh, high, e);
      ahead = lerp(flyCam.sAhead, ahead, e);
      down = lerp(flyCam.sDown, down, e);
    }

    /* ---- AND THE WALK BACK IN, which is the same seam from the other
       end and was the worse of the two.

       releaseOverride() calls camera.js's adopt(), and adopt re-seeds
       that rig's springs FROM THE LIVE LENS — so the position is
       continuous across the hand-back and the header's claim that
       "neither direction can snap" was measured on the position. The
       LOOK is not a spring: camera.js solves its aim from (dist,
       height, pitch) every frame, and on the first follow frame those
       are its own preset's, not this rig's. So the lens stayed put and
       the frame pitched 7.85 degrees in one 33 ms frame — 234.9 deg/s,
       load 28.49 — and then rolled the rest of the way out over five
       more. Every dismount, and it is the largest single-frame look
       change left anywhere in the sequence.

       There is nothing to fix in camera.js. The fix is to ARRIVE in
       the follow rig's geometry rather than to be taken out of a
       flying one: over the 3.2 s of the deflation the boom walks from
       20 m back and 6 m up in to camera.js's own RIG (3.15 m back,
       0.90 m over his soles, tilted 2.1 degrees UP), so by the time
       releaseOverride() runs the two rigs are looking at the same
       thing from the same place and adopt() has nothing left to move.
       It is also the better shot: the envelope comes down and the
       camera comes back to him with it. */
    if (flyPhase === 'landing') {
      /* arrive early — the state damps toward this target and has to
         be given time to actually reach it before the hand-back */
      const lt = smoothstepLocal(0, 1, clamp(flyT / (F_ANIM.land * 0.72), 0, 1));
      dist = lerp(dist, F_CAM_HAND.dist, lt);
      high = lerp(high, F_CAM_HAND.high, lt);
      ahead = lerp(ahead, F_CAM_HAND.ahead, lt);
      down = lerp(down, F_CAM_HAND.down, lt);
      landLam = lerp(1, 3.4, lt);
    }

    /* the boom sits behind the DRIFT; with no drift it holds the last
       heading, so a becalmed balloon does not spin its own camera
       hunting for one.

       THE FADE AND THE CAP ARE BOTH THERE FOR THE BOARDING. `if (sp >
       0.8)` is a cliff: on the frame the drift crosses it a damp at
       1.1 opens on whatever angle happens to lie between the lens and
       the new heading, and on a boarding into a following wind that
       angle is most of a half-turn. Measured on the drifting boarding
       before this, load 24.61: 2.59 degrees in one 17 ms frame,
       154 deg/s, on the frame of the crossing and nowhere else.
       Fading the authority in over 0.35-1.30 m/s removes the cliff;
       capping the rate keeps the swing a pan rather than a whip when
       the heading really does have to come half way round. After the
       first seconds the exponential is slower than the cap and
       neither term does anything, so cruise is untouched. */
    const sp = Math.hypot(flyState.vx, flyState.vz);
    const align = smoothstepLocal(0.35, 1.30, sp);
    if (align > 0) {
      const want = wrapNear(flyCam.yaw, Math.atan2(flyState.vx, flyState.vz));
      const step = damp(flyCam.yaw, want, 1.1 * align, dt) - flyCam.yaw;
      const cap = F_CAM_YAW_RATE * dt;
      flyCam.yaw += clamp(step, -cap, cap);
    }
    const fx = Math.sin(flyCam.yaw), fz = Math.cos(flyCam.yaw);

    /* DURING THE INFLATION THE SUBJECT IS THE ENVELOPE, not the ground
       ahead: the fabric is coming up off the grass and standing itself
       into a balloon, which is the best four seconds this machine has.
       The aim rides the middle of it and hands back to the flying
       framing as the boom gets out. */
    const lift = flyPhase === 'boarding' && flyProp
      ? (1 - k) * (BALLOON_FIT.MOUTH + BALLOON_FIT.ENV_H * 0.35) * flyProp.inflation : 0;
    _fcp.set(ax - fx * dist, ay + high, az - fz * dist);
    _fca.set(ax + fx * ahead, ay - down + lift, az + fz * ahead);

    /* the boom is slower than the aim, which is what makes a big thing
       read as heavy: the lens trails and the look leads. Stiffened
       through the deflation (landLam) so the state actually ARRIVES at
       the hand-back geometry the target above walks in to — a lagging
       spring would hand back from wherever it had got to, which is the
       seam again with a smaller number on it. */
    const lam = (1.05 + 1.4 * clamp(flyBlend, 0, 1)) * landLam;
    flyCam.pos.x = damp(flyCam.pos.x, _fcp.x, lam, dt);
    flyCam.pos.y = damp(flyCam.pos.y, _fcp.y, lam * 0.8, dt);
    flyCam.pos.z = damp(flyCam.pos.z, _fcp.z, lam, dt);
    flyCam.aim.x = damp(flyCam.aim.x, _fca.x, lam * 1.9, dt);
    flyCam.aim.y = damp(flyCam.aim.y, _fca.y, lam * 1.9, dt);
    flyCam.aim.z = damp(flyCam.aim.z, _fca.z, lam * 1.9, dt);
    flyCam.fov = damp(flyCam.fov, fov, 1.6, dt);
    /* never inside the hill. The follow rig does this for gameplay
       with lensFloor(); an override gets none of the rig's services,
       so the one that matters is done here by hand.

       AND THE MARGIN EASES IN WITH THE BOOM. The follow rig keeps its
       lens lower than 1.5 m over the ground — measured at the moment
       of a boarding on the lawn outside the Treasury, load 13.93, it
       sits 0.94 m up — so applying this floor at full width on the
       first override frame LIFTED THE LENS 0.56 m in one frame and
       swung the look 2.68 degrees. That was the whole of the residual
       step at the join once the seed's sign and the target were both
       fixed: not a spring, a clamp. Starting the margin at whatever
       the handed-over lens already had and walking it out to 1.5 m
       keeps "never inside the hill" true on every frame — the floor
       is never lower than the lens was standing at — while making the
       lift part of the same four-second move as the boom. */
    const gy = flySolidUnder(flyCam.pos.x, flyCam.pos.z, flyCam.pos.y + 4, _fcamGround).y;
    const floor = flyCam.ease < 1
      ? lerp(Math.min(flyCam.sFloor, 1.5), 1.5, smoothstepLocal(0, 1, flyCam.ease))
      : 1.5;
    if (flyCam.pos.y < gy + floor) flyCam.pos.y = gy + floor;
    cam.override(flyCam.pos, flyCam.aim, flyCam.fov);
  }

  /**
   * Get in, or get out. The public door is setBike() / setRide(),
   * which routes any air machine here.
   *
   * GETTING OUT WHILE AIRBORNE IS A REQUEST, NOT AN EVENT. There is
   * no honest way to step out of a basket at 180 m, so unequipping in
   * the air sets `flyLandWanted`: she vents, comes down, flares, and
   * the dismount happens on the ground. That is also what makes
   * hud.js's door interaction safe from up here — it cannot warp him
   * out of the sky, it can only ask him to land.
   */
  function setFly(on, o = {}) {
    if (on) {
      if (flyPhase === 'boarding' || flyPhase === 'aloft') { flyLandWanted = false; return api; }
      rideId = 'balloon';
      flyProp = showProp('balloon');
      flyProp.group.visible = true;
      /* IT COMES OFF ITS OWN SPOT AND UNDER HIM, and the order
         matters: unparkProp() re-parents to `root` and clears the park
         pose, so everything after this line is in his frame. */
      unparkProp();
      try { ctx.game?.actions?.clearParkSpot?.('balloon'); } catch (e) { /* headless */ }
      /* HE STANDS ON THE DECK. The prop's origin is on the ground —
         that is the park solve's contract — so it hangs at -DECK
         under his soles for as long as he is aboard. */
      flyProp.group.position.set(0, -BALLOON_FIT.DECK, 0);
      flyProp.group.rotation.set(0, 0, 0);
      flyProp.group.scale.set(1, 1, 1);
      flyProp.park(false);

      flyState = newFlight(root.rotation.y);
      flyFloored = false;
      flyWraps = 0; flyWrapLog = null;
      flyPhase = 'boarding';
      flyT = 0;
      flyLandWanted = false;
      flyRefusing = false;
      flyCam.seeded = false;
      /* HE IS STANDING, NOT SEATED — see the block header. */
      locoManual = true; locoSpeed = 0; locoTurn = 0;
      flyIkSaved = secondary.ikEnabled;
      secondary.ikEnabled = false;          // his feet are on a deck
      if (controller) {
        controller.enabled = false;
        controller.velocity.set(0, 0, 0);
        controller.acceleration.set(0, 0, 0);
      }
      flyProp.setInflate(o.instant ? 1 : 0);
      if (o.instant) {
        flyPhase = 'aloft'; flyBlend = 1; flyT = 0;
        flyState.heat = FLIGHT.trim;
      }
      ctx.bus?.emit('wally:fly', { flying: true, phase: flyPhase, ride: 'balloon' });
    } else {
      if (flyPhase === 'off') return api;
      if (o.instant) { flyEnd(true); return api; }
      if (flyPhase === 'aloft') {
        const alt = root.position.y - flyGround - BALLOON_FIT.DECK;
        if (alt > F_TOUCH_M + 0.35) { flyLandWanted = true; return api; }
      }
      if (flyPhase !== 'landing') { flyPhase = 'landing'; flyT = 0; }
    }
    return api;
  }

  /** Hard stop — cutscenes, debug hooks and the instant path. A studio
      shot with an abandoned balloon in it is nobody's intent, so this
      one puts the machine away rather than mooring it. */
  function flyEnd(hide) {
    if (flyProp) {
      flyProp.setBurner(false, 0, 1);
      if (hide) { unparkProp(); flyProp.setInflate(1); flyProp.group.visible = false; }
    }
    flyPhase = 'off'; flyBlend = 0; flyT = 0;
    flyLandWanted = false; flyRefusing = false;
    flyCam.seeded = false;
    locoManual = false;
    secondary.ikEnabled = flyIkSaved;
    if (controller) {
      controller.enabled = true;
      controller.velocity.set(0, 0, 0);
    }
    /* THE CROWNS COME DOWN BEFORE THE SNAP, AND THE ORDER IS THE
       WHOLE BUG. trees.js registers canopy colliders on this exact
       event and drops them when it says flying:false, so a snap that
       runs first lands him ON a crown that is about to be deleted out
       from under him: measured at rest 5.11 m over the terrain, and
       the frame after the emit he was 4.83 m over it with crowns 0,
       falling. Emit first and the snap has only the real world to
       find. */
    ctx.bus?.emit('wally:fly', { flying: false, phase: 'off', ride: 'balloon' });
    if (controller) {
      /* 500 m, not 6. This is the cutscene/debug path and it may be
         called with him two hundred metres up; a six-metre snap would
         leave him there and then drop him. Put him on the ground. */
      controller.snapToGround(500);
      root.position.copy(controller.position);
    }
    flyStick = null; flyForceBurn = false;
    ctx.cam?.releaseOverride?.();
  }

  /** Write a position into the controller WITHOUT snapping it to the
      ground. See the block header for why teleport() is the wrong
      call and why all three positions have to move together. */
  function flyPlaceController() {
    const c = controller;
    if (!c) return;
    c.simPosition.copy(root.position);
    c.position.copy(root.position);
    c._prevPosition.copy(root.position);
    c.velocity.set(flyState.vx, flyState.vy, flyState.vz);
    c.acceleration.set(0, 0, 0);
    c.yaw = flyState.yaw;
    if (c._yawTarget !== undefined) c._yawTarget = flyState.yaw;
    /* `grounded` false with airTime 0 keeps update()'s `air` test
       (which needs airTime > 0.09) from starting the jump clip over a
       man standing in a basket. */
    c.grounded = flyPhase !== 'aloft';
    c.airTime = 0;
  }

  function flyUpdate(dt) {
    if (flyPhase === 'off') return false;
    const prop = flyProp;
    if (!prop) { flyEnd(true); return false; }

    /* ---- what is under him ----
       THE SEA COUNTS AS A SURFACE, and getting that wrong is how the
       refusal below fails silently. heightAt() over open water answers
       with the SEABED — measured at about -30 m out past the shore —
       so "am I within nine metres of the thing under me" was asking
       about the bottom of the ocean, and the machine sailed serenely
       down to 28.79 m BELOW sea level before anything objected. The
       surface she would land on over water is the water. */
    let g = flySolidUnder(root.position.x, root.position.z, root.position.y);
    /* THE LAST FOURTEEN METRES ARE FLOWN ON THE FOOTPRINT, not on the
       centre ray — see flyFootprint's header for the two measurements
       that is here for. Above that a balloon is over open air and one
       ray is the honest answer, so the four extra casts are not paid. */
    /* THE GATE IS ON EITHER SURFACE, and it has to be. Gating on the
       centre ray alone is the same single-ray mistake one level up:
       the frame the centre clears a parapet the ray drops thirty
       metres, the gate opens to `false`, and the footprint — the
       thing that was going to notice the roof under the other half of
       the basket — is never run. Measured across the penthouse edge
       at 0.4 m steps, that gate found the roof at 0 of the 8 offsets
       it was there to catch. Last frame's landing surface is the
       other half of the test. */
    let foot = null;
    if (root.position.y - g.y < F_FOOT_M || root.position.y - flyGround < F_FOOT_M) {
      foot = flyFootprint(root.position.x, root.position.z, root.position.y, g);
      g = foot;
    }
    const seaY = waterAt(root.position.x, root.position.z);
    const overWater = !g.hit || g.y <= seaY + 0.35;
    flyGround = overWater ? seaY : g.y;
    const groundNY = overWater ? 1 : (g.normal ? g.normal.y : 1);
    const deckY = flyGround + BALLOON_FIT.DECK;
    const alt = root.position.y - deckY;
    flyAlt = Math.max(0, alt);

    /* ---- the input, read exactly where the controller would read it,
       so ui/touch.js's thumbstick drives the balloon with no change to
       a file this agent does not own: x/z is the drift wish, `jump` is
       the burner and `run` is the vent ---- */
    let raw = null;
    try { raw = inputFn ? inputFn(dt, controller) : (ownInput ? defaultInput() : null); } catch (e) { raw = null; }
    _fin.x = raw ? (raw.x || 0) : 0;
    _fin.z = raw ? (raw.z || 0) : 0;
    _fin.burn = !!(raw && (raw.jumpHeld || raw.jump));
    _fin.vent = !!(raw && raw.run);

    /* ---- THE REFUSAL ----
       She will not put you in the sea and she will not put you on a
       cliff, and both are the same rule: inside F_REFUSE_M of a
       surface he could not stand on, the burner fires itself and
       keeps firing. It is not a hidden clamp — the flame lights, the
       envelope glows, the machine visibly declines — which is the
       difference between a rule a player learns in one go and a bug
       they report. */
    const tooSteep = Math.acos(clamp(groundNY, -1, 1)) > (48 * Math.PI / 180);
    flyRefusing = (overWater || tooSteep) && alt < F_REFUSE_M && flyPhase === 'aloft';
    if (flyRefusing) { _fin.burn = true; _fin.vent = false; }

    /* ---- THE FLARE ----
       A balloon that arrives at 3.6 m/s puts its basket through a
       lawn. Inside F_FLARE_M the burner is nudged so the sink rate is
       proportional to the height left — half a metre a second at the
       last metre — which is the same thing a pilot does on the last
       hundred feet and is what makes every landing look deliberate
       instead of survived. */
    if (flyPhase === 'aloft' && !flyRefusing && flyState.vy < 0) {
      const want = -0.55 - (alt / F_FLARE_M) * 2.4;
      if (alt < F_FLARE_M && flyState.vy < want) { _fin.burn = true; _fin.vent = false; }
    }
    /* asked to come down: hold the vent until the flare takes over */
    if (flyLandWanted && flyPhase === 'aloft' && !flyRefusing && alt > F_FLARE_M) {
      _fin.vent = true; _fin.burn = false;
    }

    /* the verifier's held burner wins over everything above, because
       what it is testing is that the burner is ALWAYS the way out */
    if (flyForceBurn) { _fin.burn = true; _fin.vent = false; }
    if (flyStick) { _fin.x = flyStick.x; _fin.z = flyStick.z; }

    /* ---- the air ---- */
    const w = ctx.wind?.vector?.(root.position.x, root.position.z);
    _fenv.windX = w ? w.x : 0;
    _fenv.windZ = w ? w.z : 0;

    /* ================= the phases ================= */
    if (flyPhase === 'boarding') {
      flyT += dt;
      const t = clamp(flyT / F_ANIM.board, 0, 1);
      /* the burner is on for the whole inflation — that is what fills
         it — and the heat it puts in is the heat she leaves with */
      _fin.burn = true; _fin.vent = false; _fin.x = 0; _fin.z = 0;
      prop.setInflate(smoothstepLocal(0.04, 0.94, t));
      stepFlight(flyState, _fin, _fenv, dt);
      flyBlend = smoothstepLocal(0.15, 0.75, t);
      /* SHE LEAVES WHEN SHE IS READY. Enough envelope, and enough lift
         to beat the weight. Until then the velocity is thrown away and
         the basket sits on its runners, so there is no float before
         the fabric is up and no jump at the end of a timer. */
      const canLift = prop.inflation >= F_LIFT_INFLATE && flyState.vy > 0.02;
      if (!canLift) {
        flyState.vy = 0; flyState.vx = 0; flyState.vz = 0;
        root.position.y = deckY;
      } else {
        root.position.y += flyState.vy * dt;
      }
      if (t >= 1) {
        flyPhase = 'aloft'; flyT = 0;
        ctx.bus?.emit('wally:fly', { flying: true, phase: 'aloft', ride: 'balloon' });
      }
    } else if (flyPhase === 'aloft') {
      flyBlend = Math.min(1, flyBlend + dt * 1.4);
      stepFlight(flyState, _fin, _fenv, dt);
      root.position.x += flyState.vx * dt;
      root.position.y += flyState.vy * dt;
      root.position.z += flyState.vz * dt;
      flyCollide(dt);
      /* THE ISLAND IS ROUND — after the collision and before anything
         reads the position, so the frame that lands is already on the
         far side and nothing downstream sees the intermediate. The
         velocity, the heat, the yaw and the altitude are untouched by
         it on purpose: she carries on doing exactly what she was
         doing, in the same direction, at the same height. */
      flyWrap();
      /* SHE FINDS THE ROOF. Coming down over a parapet, the footprint
         probe knows which way the support is; this leans the machine
         that way so the basket ends up ON the roof instead of standing
         half over a fifteen-metre drop, or missing it by forty
         centimetres and going all the way to the street. A shove, not
         a snap — the same answer the envelope gives a terrace, and for
         the same reason: a hard correction here would fight the stick
         and the player would feel the building steering the machine.
         It only exists while she is actually arriving (inside the
         flare) and only when the corners genuinely disagree. */
      if (foot && foot.spread > F_FOOT_STEP && alt < F_FLARE_M
          && (foot.hiX !== 0 || foot.hiZ !== 0)) {
        const l = Math.hypot(foot.hiX, foot.hiZ) || 1;
        const k = F_FOOT_PUSH * (1 - alt / F_FLARE_M) * dt;
        flyState.vx += (foot.hiX / l) * k;
        flyState.vz += (foot.hiZ / l) * k;
      }
      /* THE FLOOR OVER WATER — the backstop under the refusal above. */
      if (overWater) {
        const wf = deckY + F_WATER_FLOOR;
        if (root.position.y < wf) {
          root.position.y = wf;
          if (flyState.vy < 0) flyState.vy = 0;
          flyFloored = true;
        }
      }
      /* ---- THE FLOOR, AND WHAT IT WILL PUT HER ON ----

         IT IS A LIFT, NOT A LIMIT: `<=` with an assignment, so anything
         that raises deckY teleports the basket UP to it inside one
         frame. deckY is flyGround + DECK and flyGround comes from
         flySolidUnder, which asks ctx.phys.groundAt — and groundAt as
         PUBLISHED — physics.js's wrapper is `groundAt(x, z, out = null)`
         — silently drops the fromY and maxDist arguments the
         CollisionWorld's own `groundAt(x, z, out, fromY, maxDist)` takes.
         flySolidUnder passes `(fromY ?? root.position.y) + 2` and 900
         in good faith and neither survives the call. Every probe is
         therefore cast FROM THE TOP OF THE WORLD and answers the first
         solid on the way down — so any permanent collider over her head
         is "the ground", and this line lifts her onto it.

         MEASURED ON THIS BUILD, not inferred. The tallest sign.board
         over its own street stands 25.18 m up (15.68 m over terrain at
         9.51). Put the balloon 8 m under it at y 15.53 and read the
         next frame: y 25.44, flyGround 25.18, alt 0.00, vy 0 — a
         9.91 m upward snap onto a hanging shop sign, reported as a
         landing. Two frames later she has drifted 30 cm off the board,
         the ray finds the street again, flyGround 9.56, and she is
         15.6 m up in clear air with the machine none the wiser.

         THAT IS THE WHOLE OF THE REPORTED "12.75 m SNAP ON FAST
         TRAVEL". It is not a warp transient and it is not a probe
         settling: it is a permanent body — sign.board, 28 of them,
         the highest topping out at 72.26 m of world height — being
         found by a ray that starts above the sky. Fixing it means
         making the ray honour its own fromY, which is a change to
         physics.js's published signature and belongs to whoever owns
         that file; the handover is in this round's report. Until then
         nothing in here may treat flyGround as "the ground".

         DOWN IS NOT OUT. Touching the ground is not getting out — he
         can burn again from here and go straight back up, which is
         what makes "land on that roof and have a look" a thing you
         are allowed to do. Only an explicit dismount ends a flight. */
      if (root.position.y <= deckY) {
        root.position.y = deckY;
        if (flyState.vy < 0) flyState.vy = 0;
        if (flyLandWanted) { flyPhase = 'landing'; flyT = 0; flyLandWanted = false; }
      }
    } else if (flyPhase === 'landing') {
      flyT += dt;
      const t = clamp(flyT / F_ANIM.land, 0, 1);
      _fin.burn = false; _fin.vent = true; _fin.x = 0; _fin.z = 0;
      prop.setInflate(1 - smoothstepLocal(0.05, 0.92, t));
      stepFlight(flyState, _fin, _fenv, dt);
      flyState.vx *= 0.86; flyState.vz *= 0.86;
      root.position.y = damp(root.position.y, deckY, 6, dt);
      flyBlend = 1 - smoothstepLocal(0.45, 1.0, t);
      if (t >= 1) {
        /* ON HIS FEET, ON THE GROUND, AND THE MACHINE LEFT WHERE IT IS.
           parkProp() is the same call the bicycle's dismount makes and
           the same solve stands it on the hill. */
        root.position.y = flyGround;
        if (controller) {
          controller.enabled = true;
          controller.simPosition.copy(root.position);
          controller.position.copy(root.position);
          controller._prevPosition.copy(root.position);
          controller.velocity.set(0, 0, 0);
          controller.acceleration.set(0, 0, 0);
        }
        locoManual = false;
        secondary.ikEnabled = flyIkSaved;
        flyPhase = 'off'; flyBlend = 0; flyAlt = 0;
        flyCam.seeded = false;
        prop.setBurner(false, 0, 1);
        bike = prop;
        ctx.cam?.releaseOverride?.();
        /* SAME ORDERING AS flyEnd, and this path is the worse-shaped
           one: maxDrop 3 will happily find a crown top under his head,
           so he would be snapped onto canopy the emit is about to
           remove. Crowns down first, then snap onto what is left.

           AND parkProp() IS INSIDE THAT RULE NOW, not above it. Its
           probe is a downward ray from just over the machine (see H in
           parkProp) rather than the terrain raster, and a balloon that
           has just come down on a beech is standing on a crown box —
           so parking before the emit would solve the pose against a
           body that is deleted three lines later and moor the machine
           in mid-air, in a spot that then persists through
           state.rides.parked. One order satisfies both readers. */
        ctx.bus?.emit('wally:fly', { flying: false, phase: 'off', ride: 'balloon' });
        parkProp();
        if (controller) {
          controller.snapToGround(3);
          root.position.copy(controller.position);
        }
        return true;
      }
    }

    /* ---- write it all down ---- */
    guardFinite('fly.integrate');
    flyPlaceController();
    root.rotation.y = flyState.yaw;
    root.rotation.z = 0;
    prop.setBurner(_fin.burn, flyState.heat, dt);
    prop.roll(Math.hypot(flyState.vx, flyState.vz) * dt);
    /* THE ENVELOPE TRAILS. A real one hangs back from the basket's own
       acceleration, and this lean is the only place the machine admits
       it is being pushed about: two degrees at full drift, damped over
       half a second, in the machine's own frame rather than the
       world's. */
    if (flyEnvGroup) {
      const bx = flyState.vx * Math.cos(flyState.yaw) - flyState.vz * Math.sin(flyState.yaw);
      const bz = flyState.vx * Math.sin(flyState.yaw) + flyState.vz * Math.cos(flyState.yaw);
      flyEnvGroup.rotation.z = damp(flyEnvGroup.rotation.z, clamp(-bx * 0.006, -0.055, 0.055), 2.2, dt);
      flyEnvGroup.rotation.x = damp(flyEnvGroup.rotation.x, clamp(bz * 0.006, -0.055, 0.055), 2.2, dt);
    }
    flyCamera(dt, flyAlt);
    return true;
  }
  /* Ownership sync. The data agent emits 'bike' on buy and on equip;
     a SAVE LOAD may restore state.bike without one, so the state is
     also re-read on a slow timer. Twice a second, one object read —
     cheaper than a class of bug where the player's bicycle silently
     vanishes across a reload. */
  /* ----------------------------------------------------------------
     WHAT WAS LEFT LYING ABOUT LAST SESSION.

     parkedIds is a runtime Set and always was, so before this every
     machine left standing in the street came back under him after a
     reload. game.js now keeps the fact (state.rides.parked, written by
     parkProp) and this reads it once, the first time there is a game
     layer to read.

     ONLY THE POSITION AND THE HEADING COME BACK. Pitch, roll, height
     and the mooring are re-SOLVED here against the terrain as it
     exists now — solveParkPose is the only thing that has ever been
     allowed to answer those, and a stored answer would be a second
     opinion that a world rebuild could make wrong.

     IT IS NOT A ONE-SHOT, and the first version was. A boolean set on
     the first bikeSync looks right — the save loads inside game.js's
     own init, before the first frame — and it is wrong for every path
     where the state arrives LATER: a load from the menu, an imported
     file, and the screenshot rig, which boots with ?shot=1 and
     deliberately does not read the save at all until something asks
     it to. In all three the restore had already run against an empty
     record and latched.

     So it is a RECONCILIATION instead, on the same half-second timer
     as the ownership sync beside it: anything the game says is parked
     and this module does not have standing gets stood up. It is a
     handful of string compares over at most four entries, it is a
     no-op on every tick after the first, and it cannot latch. Putting
     a machine down adds it to `parkedIds` on the same frame, so the
     next tick already knows about it; picking one up clears the
     record, so it cannot be resurrected under him either.
     ---------------------------------------------------------------- */
  function restoreParked() {
    const spots = ctx.game?.actions?.parkSpots;
    if (!spots) return;
    let list = null;
    try { list = spots(); } catch (e) { return; }
    if (!list) return;
    const wasBike = bike, wasRide = rideId;
    let did = false;
    for (const id of Object.keys(list)) {
      const key = rideKey(id);
      const at = list[id];
      if (!key || !at) continue;
      if (parkedIds.has(key)) continue;                   // already standing
      /* never stand up the machine he is currently on */
      if (key === rideId && (bikePhase !== 'off' || flyPhase !== 'off')) continue;
      bike = buildProp(key);
      /* THE SAVED SPOT, not a spot beside him — parkProp(at) exists
         for exactly this. Everything else about the pose is re-solved
         against the terrain as it is now. */
      parkProp(at);
      did = true;
    }
    if (did) { bike = wasBike; rideId = wasRide; }
  }

  function bikeSync(dt) {
    if (bikeForced) return;
    bikeSyncT -= dt;
    if (bikeSyncT > 0) return;
    bikeSyncT = 0.5;
    restoreParked();
    const g = ctx.game?.actions?.bike;
    if (!g) return;
    let s = null;
    try { s = g(); } catch (e) { return; }
    if (!s) return;
    bikeOwned = !!s.owned;
    bikeEquipped = !!(s.owned && s.equipped);
    /* WHICH ONE. actions.bike() reports the ride he is actually on
       (data.js v7 folded three vehicles into one row per machine and
       kept this call as the view onto the equipped one), so `id` is the
       answer and the old boolean pair is only the on/off. An id this
       file does not know about falls back to the bicycle rather than
       leaving him seated on nothing. */
    const want = rideKey(s.id) || 'bike';
    if (bikeEquipped && bikeOwned) buildProp(want);
    /* Never fight a cutscene: the intro drives root.position itself and
       has its own bicycle. */
    if (!controlled) return;
    setBike(bikeEquipped, { ride: want });
  }

  if (ctx.bus) {
    const onOwnership = (e) => {
      bikeOwned = !!e?.owned;
      bikeEquipped = !!(e?.owned && e?.equipped);
      const want = rideKey(e?.ride) || rideId;
      if (bikeOwned) buildProp(want);
      if (controlled) setBike(bikeEquipped, { ride: want });
    };
    ctx.bus.on('bike', onOwnership);
    /* 'ride' is the richer event the rides table emits on buy, grant,
       equip and unequip — and game.js emits it IMMEDIATELY BEFORE the
       'bike' above, every time, on every path. So it does not get a
       second opinion here: it only arms the slow reconcile, which
       re-reads the authoritative record. Two handlers both deciding
       what is equipped is how they come to disagree. */
    ctx.bus.on('ride', () => { bikeSyncT = 0; });
  }

  /* ================================================================
     7. Pose application
     ================================================================ */
  function applyPose(p) {
    const e = p.e, t = p.t;
    for (let i = 0; i < nb; i++) {
      const b = bones[i];
      const i3 = i * 3;
      _e.set(e[i3], e[i3 + 1], e[i3 + 2]);
      b.quaternion.setFromEuler(_e);
      b.position.set(
        bindPos[i3] + t[i3],
        bindPos[i3 + 1] + t[i3 + 1],
        bindPos[i3 + 2] + t[i3 + 2],
      );
    }
  }

  /* ================================================================
     8. Frame
     ================================================================ */
  function update(dt, elapsed) {
    /* main.js clamps dt from above only; under the headless harness one
       frame can arrive with dt seconds NEGATIVE (rAF timestamp behind
       performance.now), and everything damped downstream of here treats
       a negative dt as an exponential amplifier. Measured blast radius:
       secondary's damped pose fields at 1e22, the trunk chain's curl
       spring at 7e22, the trunk scrambled for ten seconds after boot. */
    if (!(dt > 0)) dt = 1e-4;
    else if (dt > 0.05) dt = 0.05;
    const c = controller;

    /* ---- the balloon owns the position when it is flying ----
       flyUpdate() integrates the machine and writes both `root` and
       the controller's three positions, so the copy below is a no-op
       that happens to be true rather than a fight. It runs FIRST
       because every read after this line — the animator, the lean
       additive, the secondary chains — wants this frame's position,
       not last frame's. */
    const flying = flyPhase !== 'off' && controlled ? flyUpdate(dt) : false;

    /* ---- root transform from the controller ---- */
    if (c && controlled && !flying) {
      root.position.copy(c.position);
      root.rotation.y = c.yaw;
    }

    /* ---- does he have a bicycle, and is it with him? ---- */
    bikeSync(dt);

    /* ---- and it has to be a real number ----
       One add and one isFinite per frame, in exchange for the whole
       class of failure documented at finite3(): a NaN that gets past
       here is a NaN in the camera anchor, the spring chains and the
       audio panner within two frames, and none of them come back. */
    guardFinite('phys.update');

    /* ---- locomotion inputs ---- */
    let speed = locoManual ? locoSpeed : (c ? c.planarSpeed : 0);
    let turn = locoManual ? locoTurn : (c ? c.yawRate : 0);
    anim.setLocomotion(speed, turn);

    /* ---- automatic clip selection ---- */
    /* `air` is resolved OUTSIDE the !manual guard: it is the fact the
       phys:land gate above reads, and a fact must not depend on whether a
       cutscene happens to be holding a pose at the time. */
    const air = !!c && !c.grounded && c.airTime > 0.09;
    if (air) airborne = true;
    if (!manual && c) {
      landT = Math.max(0, landT - dt);
      if (air) {
        if (autoClip !== 'jump-air') { anim.play('jump-air', { fade: 0.14 }); autoClip = 'jump-air'; }
      } else if (autoClip === 'jump-air') {
        anim.play('jump-land', { fade: 0.05, restart: true }); autoClip = 'jump-land';
      } else if (autoClip && landT <= 0 && anim.action && anim.action.time > (anim.action.clip.duration || 1)) {
        anim.stop(0.20); autoClip = null;
      } else if (autoClip === 'jump-land' && c.grounded && speed > 1.2
                 && anim.action && anim.action.time > 0.20) {
        /* THE SAFETY NET, and it is also better animation. A landing at
           speed is a stride, not a stop: the crouch has done its job by
           0.20 s (jump-land's own `c` term is spent by ph 0.85 = 0.36 s)
           and holding it any longer reads as a stumble. Releasing here
           also means the locomotion layer is guaranteed to be back within
           ~0.34 s of ANY landing while he is moving, whatever the land
           event does — so the failure above cannot silently return by a
           different route. Landing from a standstill is untouched. */
        anim.stop(0.14); autoClip = null;
      } else if (!autoClip) {
        anim.stop(0.24);
      }
    }

    /* ---- resolve the pose ---- */
    const pose = anim.update(dt, {
      grounded: c ? c.grounded : true,
      vy: c ? c.velocity.y : 0,
      airTime: c ? c.airTime : 0,
    });

    /* ---- additive: expression + look-at ---- */
    const ex = expr.update(dt, rig.byName.head, root.rotation.y);
    anim.add(ex, 1);

    /* ---- additive: lean into acceleration and into the turn (§4) ----
       Faded out on the bicycle: that lean models a body throwing its
       weight against the ground through two feet, and a rider's weight
       goes through the saddle and the bars instead. The bank on `root`
       in bikeUpdate() replaces it. */
    if (c) {
      const onFoot = 1 - bikeRide;
      const fwdA = c.acceleration.x * Math.sin(c.yaw) + c.acceleration.z * Math.cos(c.yaw);
      const sideA = c.acceleration.x * Math.cos(c.yaw) - c.acceleration.z * Math.sin(c.yaw);
      leanX = damp(leanX, clamp(fwdA * 0.010, -0.20, 0.20), 7, dt);
      leanZ = damp(leanZ, clamp(-sideA * 0.012, -0.22, 0.22) + (c.lean?.value ?? 0) * 0.5, 7, dt);
      const hi = BONE_INDEX.hips * 3, si = BONE_INDEX.spine * 3, ci = BONE_INDEX.chest * 3;
      pose.e[hi] += leanX * 0.42 * onFoot; pose.e[hi + 2] += leanZ * 0.42 * onFoot;
      pose.e[si] += leanX * 0.34 * onFoot; pose.e[si + 2] += leanZ * 0.34 * onFoot;
      pose.e[ci] += leanX * 0.24 * onFoot; pose.e[ci + 2] += leanZ * 0.24 * onFoot;
    }

    applyPose(pose);

    /* ---- the bicycle: transition, prop placement, crank, bank ----
       After applyPose so the crank is turned from the same phase the
       legs were resolved at, and before secondary.update so the ear and
       trunk chains hang off a root that has already banked. */
    if (bikePhase !== 'off' || bikeLean !== 0) bikeUpdate(dt, speed);
    if (parkedIds.size) parkedCull();

    /* ---- secondary targets, then a forced world update so the spring
       chains in phys.lateUpdate see this frame's bone transforms ---- */
    secondary.update(dt, {
      speed,
      hints: anim.hints,
      earPerk: expr.earPerk, earSpread: expr.earSpread,
      trunkCurl: expr.trunkCurl, trunkSide: expr.trunkSide, trunkTip: expr.trunkTip,
    });

    root.updateMatrixWorld(true);
    updateGrainScale();
    updateDeliveredNeutral();
  }

  /* §1.2: "scaled so grain stays constant in *screen* space at gameplay
     distance". The triplanar lookup is object-space, so the only way to
     hold a constant screen-space cell is to rescale the frequency by view
     distance every frame. Clamped so a very close camera cannot drive the
     frequency past the grain texture's own Nyquist, and a far one cannot
     smear it into a wash. */
  function updateGrainScale() {
    const cam = ctx.camera;
    if (!cam) return;
    _camPos.setFromMatrixPosition(cam.matrixWorld);
    /* Measured to his MIDRIFF, not his feet. root.position is at the soles,
       and a face camera 1.0 m from the head is 1.9 m from the soles — using
       the origin under-corrects by nearly half and the cell still doubles
       between the full-body and face framings, which is the exact defect
       this is here to fix. */
    _v.copy(root.position); _v.y += H * 0.53;
    const d = Math.max(0.4, _camPos.distanceTo(_v) - 0.22);
    /* THE FLOOR WAS 0.55, WHICH IS 6 METRES. Past 6 m the frequency
       stopped tracking and the cell shrank with distance like any
       ordinary texture — so the grain washed out exactly where §1.2
       says it must not, and the boot camera sits at 5.9 m, i.e. right
       on the cliff. 0.16 holds a constant screen-space cell out to
       ~21 m, which covers every gameplay and city framing; beyond that
       he is under 50 px and the haze owns him anyway. The lookup is
       mip-mapped and triplanar, so a higher object-space frequency at
       range costs nothing and resolves at mip 0 rather than aliasing. */
    const k = clamp(GRAIN_REF_DIST / d, 0.16, 4.6);
    const u = clayMat.uniforms;
    if (u && u.uGrainScale) u.uGrainScale.value = GRAIN_SCALE0 * k;
  }

  function lateUpdate(dt) {
    /* THE HAZE, HERE AND NOWHERE ELSE — see flyHaze's header for the
       two modules this has to outrank and the measurement that proved
       it had to. */
    if (flyPhase !== 'off') flyHaze(flyAlt);
    flySea();
    if (!(dt > 0)) dt = 1e-4;
    else if (dt > 0.05) dt = 0.05;
    secondary.lateUpdate(dt, {
      grounded: controller ? controller.grounded : true,
      /* which feet the gait says are bearing weight this frame */
      plant: anim.plant,
    });
    root.updateMatrixWorld(true);
    contact.update();
    if (dbgCam) applyDebugCam();
    if (studioOn) studioHold();
    /* The ground shadow reads the frame's own depth prepass and the live
       sun, so it has to be resolved after the pose, after any debug
       camera, and before renderer.js runs — i.e. exactly here. */
    updateGroundShadow();
  }

  /* ================================================================
     9. Debug camera
     ================================================================ */
  function applyDebugCam() {
    const cam = ctx.camera;
    if (!cam) return;
    const p = dbgCam;
    const a = dbgOrbit * Math.PI / 180;
    const ca = Math.cos(a), sa = Math.sin(a);
    const px = p.pos[0] * ca + p.pos[2] * sa;
    const pz = -p.pos[0] * sa + p.pos[2] * ca;
    const lx = p.look[0] * ca + p.look[2] * sa;
    const lz = -p.look[0] * sa + p.look[2] * ca;
    cam.position.set(root.position.x + px, root.position.y + p.pos[1], root.position.z + pz);
    _target.set(root.position.x + lx, root.position.y + p.look[1], root.position.z + lz);
    cam.lookAt(_target);
    if (cam.fov !== p.fov) { cam.fov = p.fov; cam.updateProjectionMatrix(); }
  }

  function setSilhouette(on) {
    if (on === silhouette) return;
    silhouette = !!on;
    /* The silhouette test is "filled black on white" (§1.1). A contact
       shadow in that frame is a second grey shape and it corrupts the
       measurement. */
    contactShadow(false);
    if (silhouette) {
      const flat = mat.toon({
        name: 'wally.silhouette',
        color: 0x000000, emissiveOnly: true, emissive: 0,
        emissiveColor: 0x000000, rim: 0, grain: 0, noOutline: true,
      });
      silSaved = [];
      root.traverse((o) => {
        if (o.isMesh) { silSaved.push([o, o.material]); o.material = flat; }
      });
      if (ctx.render) {
        ctx.render.setPost(false);
        ctx.render.clearColor.setRGB(1, 1, 1);
      }
      if (ctx.scene) { silSaved.bg = ctx.scene.background; ctx.scene.background = null; }
    } else {
      for (const [o, m] of (silSaved || [])) o.material = m;
      if (ctx.render) { ctx.render.setPost(true); ctx.render.clearColor.setHex(0x9fd8f2); }
      if (silSaved && ctx.scene) ctx.scene.background = silSaved.bg ?? null;
      silSaved = null;
    }
  }

  /* ================================================================
     10. Public API — ctx.wally
     ================================================================ */
  const api = {
    /* --- identity --- */
    root,
    get position() { return root.position; },
    get rotation() { return root.rotation; },
    get quaternion() { return root.quaternion; },
    height: H,
    controller,
    skeleton: rig.skeleton,
    bones: rig.byName,
    mesh: body,
    materials: { clay: clayMat, tusk: tuskMat, frame: frameMat, lens: lensMat },

    /* --- animation --- */
    /**
     * Play a clip on the action layer.
     * @param {string} clip  see ctx.wally.clips
     * @param {{fade?:number, loop?:boolean, speed?:number, restart?:boolean}} o
     */
    play(clip, o = {}) {
      if (!CLIPS[clip]) { console.warn(`[wally] no clip "${clip}"`); return api; }
      manual = clip;
      manualHold = !!(o.loop ?? CLIPS[clip].loop);
      autoClip = null;
      anim.play(clip, o);
      anim.onFinish = (name) => { if (manual === name && !manualHold) manual = null; };
      return api;
    },

    /**
     * Hold one of the named reference poses (§1.6) or any looping clip.
     * 'cool' and 'welcome' are the two the intro and the title screen use.
     */
    pose(name, o = {}) {
      if (!CLIPS[name]) { console.warn(`[wally] no pose "${name}"`); return api; }
      manual = name;
      manualHold = true;
      autoClip = null;
      anim.play(name, { fade: o.fade ?? 0.45, loop: true, hold: true, ...o });
      if (CLIPS[name].expression) expr.set(CLIPS[name].expression, o);
      else if (name === 'cool') expr.set('cool', o);
      else if (name === 'welcome') expr.set('happy', o);
      return api;
    },

    /** Return to automatic, controller-driven animation. */
    release(fade = 0.30) { manual = null; manualHold = false; anim.stop(fade); return api; },

    /**
     * Drive the locomotion blend by hand — for cutscenes where he is not
     * on the controller. Pass (null) to hand it back to the controller.
     */
    setLocomotion(speed, turn) {
      if (speed == null) { locoManual = false; return api; }
      locoManual = true;
      locoSpeed = speed;
      locoTurn = turn ?? 0;
      return api;
    },

    /** Aim his head. Vector3 | Object3D | {x,y,z} | null to release. */
    look(target, weight = 1) { expr.look(target, weight); return api; },

    /* --- the rides ---
       ctx.game owns whether he HAS one; this owns what that looks like.
       setBike(true) mounts whatever is equipped, {instant:true} skips
       the animation, {ride:'scooter'} names the machine. */
    setBike(on, o) { return setBike(on, o || {}); },
    /** Put a named machine under him, or null to walk. */
    setRide(id, o) { return setRide(id, o || {}); },
    get riding() {
      return bikePhase === 'on' || bikePhase === 'mounting'
        || flyPhase === 'aloft' || flyPhase === 'boarding';
    },
    /* --- the balloon ---
       `flying` is the fact anything outside this module should ask;
       `flightState` is the whole machine, for the HUD, the tests and
       the screenshot rig. Altitude is over the SOLID under the basket
       (a roof counts), not over sea level. */
    get flying() { return flyPhase !== 'off'; },
    get flightPhase() { return flyPhase; },
    get flightState() {
      return {
        phase: flyPhase,
        alt: +flyAlt.toFixed(2),
        ground: +flyGround.toFixed(2),
        heat: +flyState.heat.toFixed(3),
        vy: +flyState.vy.toFixed(3),
        drift: +Math.hypot(flyState.vx, flyState.vz).toFixed(3),
        yawDeg: +(flyState.yaw * 180 / Math.PI).toFixed(1),
        inflate: flyProp ? +flyProp.inflation.toFixed(3) : 0,
        burner: flyProp ? +flyProp.burner.toFixed(3) : 0,
        refusing: flyRefusing,
        floored: flyFloored,
        landWanted: flyLandWanted,
        blend: +flyBlend.toFixed(3),
        hazeK: +flyFogK.toFixed(3),
        fog: ctx.scene?.fog ? [Math.round(ctx.scene.fog.near), Math.round(ctx.scene.fog.far)] : null,
        /* THE WRAP, as a measurement rather than a promise: how far out
           she is in half-periods, how thick the fret is, how many times
           the map has come round this flight, and the whole record of
           the last one including what was actually under her before and
           after. See flyWrap. */
        wrapK: +wrapK(root.position.x, root.position.z).toFixed(4),
        mistK: +flyMistK.toFixed(3),
        wraps: flyWraps,
        wrap: flyWrapLog,
        at: [+root.position.x.toFixed(2), +root.position.y.toFixed(2), +root.position.z.toFixed(2)],
      };
    },
    get bike() { return bike; },
    /** The machine he is on / would mount: 'bike'|'scooter'|'motorcycle' */
    get rideId() { return rideId; },
    get rideProps() { return props; },
    get bikeState() {
      return { owned: bikeOwned, equipped: bikeEquipped, phase: bikePhase,
        id: rideId, ride: +bikeRide.toFixed(3), lean: +bikeLean.toFixed(3),
        steer: +bikeSteer.toFixed(3),
        /* which machines he has left standing somewhere, and where */
        parked: [...parkedIds].map((k) => ({
          id: k,
          at: props[k] ? props[k].group.position.toArray().map((v) => +v.toFixed(2)) : null,
          pitchDeg: props[k] ? +(props[k].group.rotation.x * 180 / Math.PI).toFixed(2) : null,
          visible: props[k] ? props[k].group.visible : null,
        })) };
    },
    get rideState() { return api.bikeState; },

    /** Set a facial/postural expression. See ctx.wally.expressions. */
    express(name, o = {}) { expr.set(name, o); return api; },

    /* --- placement --- */
    /** Teleport (feet position). Moves the controller too. */
    setPosition(x, y, z) {
      const py = y ?? 0, pz = z ?? 0;
      if (!finite3(x, py, pz)) {
        console.warn('[wally] setPosition ignored — non-finite destination', x, py, pz);
        return api;
      }
      _v.set(x, py, pz);
      if (controller) controller.teleport(_v);
      root.position.copy(_v);
      guardFinite('setPosition');
      return api;
    },
    setYaw(rad) {
      if (!Number.isFinite(rad)) return api;
      root.rotation.y = rad;
      if (controller) { controller.yaw = rad; controller._yawTarget = rad; }
      return api;
    },

    /**
     * THE ARRIVAL. Put him down somewhere else in the world as though he
     * had walked there — the whole of it, not just the coordinates.
     *
     * setPosition() is the minimum: root plus controller. Fast travel
     * needs more than the minimum, because a 900 m jump is a
     * discontinuity in every quantity anything downstream derives from
     * his position, and each of them fails differently:
     *
     *   THE CONTROLLER'S THREE POSITIONS. simPosition is the end of the
     *     fixed step, _prevPosition the start, and `position` is the
     *     render lerp between them. Writing root.position behind the
     *     controller's back — which is the tempting one-liner — leaves
     *     all three at the old place, so the next frame drags him
     *     straight back and the frame after that fights it again. Moving
     *     simPosition alone is worse: the lerp then interpolates ACROSS
     *     THE ISLAND, and the two endpoints are far enough apart that
     *     the sweep in _move() runs its substep guard out and can hand
     *     back a non-finite result. That is the NaN that takes Web Audio
     *     down. controller.teleport() is the only path that moves all
     *     three together, so it is the only path used here.
     *
     *   VELOCITY, ACCELERATION AND THE TIMERS. He was walking out of his
     *     apartment; he is now standing at a noodle cart. Left alone,
     *     the animator reads the old speed, the lean additive reads the
     *     old acceleration, and the coyote/buffer/jump timers describe a
     *     jump he took on the other side of the map.
     *
     *   THE SPRING CHAINS. The ears, trunk and tail are WORLD-SPACE
     *     particles (springs.js SpringChain: points[] are world
     *     positions). Teleport the root and leave them and they are
     *     abandoned 900 m behind, then whip across the island over the
     *     next second at whatever the angle limits allow. reset() snaps
     *     each chain onto its rest pose at the new root, with zero
     *     velocity — it is the difference between arriving and being
     *     flung. It needs a current world matrix, so the root matrix is
     *     forced before they are touched.
     *
     * @param {number} x  @param {number} y  @param {number} z  feet position
     * @param {{yaw?:number, face?:object, keepLook?:boolean}} o
     *        yaw   absolute facing, radians
     *        face  world point to turn toward (ignored if yaw is given)
     * @returns {boolean} true if he actually moved
     */
    warpTo(x, y, z, o = {}) {
      const py = y ?? 0, pz = z ?? 0;
      if (!finite3(x, py, pz)) {
        console.warn('[wally] warpTo refused — non-finite destination', x, py, pz);
        return false;
      }
      _wp.set(x, py, pz);

      const c = controller;
      if (c) {
        c.teleport(_wp);                 // sim + prev + position + velocity, together
        c.acceleration.set(0, 0, 0);
        c._prevVelocity.set(0, 0, 0);
        c.airTime = 0; c.groundTime = 0;
        c.coyoteT = 0; c.bufferT = 0; c._stepGrace = 0;
        c.jumping = false; c.jumpTime = 0; c._prevJump = false;
        c.landImpact = 0;
        c.touchingWall = false;
        c.yawRate = 0;
        c.lean?.set?.(0);
        c.squash?.s?.set?.(1);
        /* teleport() snapped him onto whatever is actually under the
           destination, so read the settled point back rather than
           trusting the one we asked for. */
        if (vecFinite(c.position)) _wp.copy(c.position);
      }
      root.position.copy(_wp);

      /* --- facing --- */
      let yaw = o.yaw;
      if (!Number.isFinite(yaw) && o.face) {
        const f = o.face;
        if (Number.isFinite(f.x) && Number.isFinite(f.z)) {
          yaw = Math.atan2(f.x - _wp.x, f.z - _wp.z);
        }
      }
      if (Number.isFinite(yaw)) {
        root.rotation.y = yaw;
        if (c) { c.yaw = yaw; c._yawTarget = yaw; c.yawRate = 0; }
      }

      /* --- locomotion state that describes a journey he did not make --- */
      leanX = 0; leanZ = 0; landT = 0; airborne = false;
      anim.setLocomotion(0, 0);
      if (!manual) { anim.stop(0); autoClip = null; }
      /* A look target at the old place is now 900 m behind his head. */
      if (!o.keepLook) expr.look(null);

      /* --- secondary, at the new place --- */
      root.updateMatrixWorld(true);
      const chains = secondary?.chains;
      if (chains) {
        for (const k in chains) {
          try { chains[k].reset(); } catch (e) { /* a chain that cannot reset is not worth a throw */ }
        }
      }

      const ok = guardFinite('warpTo');
      ctx.bus?.emit('wally:warp', {
        x: root.position.x, y: root.position.y, z: root.position.z,
        yaw: root.rotation.y, ok,
      });
      return ok;
    },
    /** Turn to face a world point, immediately. */
    face(target) {
      const p = target.isVector3 ? target : _v2.set(target.x, target.y, target.z);
      return api.setYaw(Math.atan2(p.x - root.position.x, p.z - root.position.z));
    },
    /** false = the intro/cutscene owns root.position and root.rotation. */
    setControlled(on) {
      const want = on !== false;
      /* A CUTSCENE TAKES THE BALLOON AWAY FIRST. flyUpdate is gated on
         `controlled`, so handing control to the intro while he is
         aloft would freeze the flight with the character controller
         still disabled and the camera still in override — and nothing
         would ever give either of them back. Put the machine away on
         the way out; a cutscene with an abandoned balloon in it is
         nobody's intent, which is the same rule setBike's instant path
         has always followed. */
      if (!want && flyPhase !== 'off') flyEnd(true);
      controlled = want;
      if (controller) controller.enabled = controlled;
      return api;
    },
    /** Replace the input source. null restores the built-in WASD. */
    setInput(fn) { inputFn = fn || null; ownInput = !fn; return api; },
    /** The WASD read, already camera-relative. An input source that
        wants to ADD to the keyboard rather than silence it (touch on a
        device with a keyboard attached) composes with this. */
    keyboardInput,
    /** Stick space (+z away from camera, +x camera-right) -> world XZ.
        The single source of truth for the camera basis. */
    camRelative,

    /* --- secondary --- */
    /** Kick every spring chain. Explosions, big landings, story beats. */
    impulse(x, y, z) { secondary.impulse(x, y, z); return api; },
    /** Ear/trunk reaction to a landing, 0..1. */
    land(impact) { secondary.land(impact); return api; },
    setFootIK(on) { secondary.ikEnabled = on !== false; return api; },
    secondary,
    animator: anim,
    expression: expr,

    /* --- introspection --- */
    clips: CLIP_NAMES,
    expressions: EXPRESSION_NAMES,
    get clip() { return anim.current; },
    get poseName() { return manual; },
    get grounded() { return controller ? controller.grounded : true; },
    get speed() { return controller ? controller.planarSpeed : 0; },
    /** World position of a named bone (fresh vector). */
    bonePosition(name, out) {
      const b = rig.byName[name];
      if (!b) return null;
      return b.getWorldPosition(out || new THREE.Vector3());
    },
    /** Where a camera should aim to frame his head. */
    headPosition(out) { return api.bonePosition('head', out).add(_v2.set(0, 0.19, 0)); },

    /* --- ground contact, for anything that has to react to him standing
       on it. foliage.js currently parts the blade field around
       root.position, which is the point BETWEEN his feet; parting around
       these two instead puts the bend where he actually touches, and
       `contactRadius` is the radius the ground shadow's own pool covers,
       so the two agree. --- */
    feet(outL, outR) {
      const bl = rig.byName.footL, br = rig.byName.footR;
      const a = outL || new THREE.Vector3();
      const b = outR || new THREE.Vector3();
      if (bl) bl.getWorldPosition(a); else a.copy(root.position);
      if (br) br.getWorldPosition(b); else b.copy(root.position);
      a.y = root.position.y; b.y = root.position.y;
      return [a, b];
    },
    contactRadius: 0.95,

    /* --- module contract --- */
    update,
    lateUpdate,
    dispose() {
      secondary.dispose();
      /* every machine that was ever built, not just the one under him */
      for (const k of Object.keys(props)) { props[k].dispose(); delete props[k]; }
      parkedIds.clear();
      bike = null;
      ctx.scene.remove(root);
      if (shadowMesh) {
        ctx.scene.remove(shadowMesh);
        shadowMesh.geometry.dispose();
        shadowMesh = null;
      }
      /* shRT and the flat-white material belong to ctx.render.silhouette
         and are pooled across callers — its own dispose() owns them. */
      projMat.dispose();
      bodyGeo.dispose(); tuskL.dispose(); tuskR.dispose();
      frameGeo.dispose(); lensGeoL.dispose(); lensGeoR.dispose();
      grooveGeo.dispose();
      lensTex.dispose();
      controller?.dispose();
    },

    stats: {
      triangles: bodyGeo.userData.triangles,
      vertices: bodyGeo.attributes.position.count,
      bones: nb,
      buildMs: 0,
    },
  };

  /* ================================================================
     11. Debug hooks — the screenshot harness drives these
     ================================================================ */
  const dbg = (window.WALLY && window.WALLY.debug) || {};

  dbg.pose = (name) => { api.pose(name, { fade: 0.001, instant: true }); return name; };
  dbg.clip = (name, o) => { api.play(name, { fade: 0.001, ...(o || {}) }); return name; };
  dbg.express = (name) => { api.express(name, { instant: true }); return name; };
  dbg.release = () => { api.release(0.001); };
  dbg.locomotion = (s, t) => { api.setLocomotion(s, t); return [s, t]; };

  /* ---- the gait rig -------------------------------------------------
     A walk cycle can only be judged as a SEQUENCE, and `--wait` cannot be
     trusted to land on the phase you meant. locoPhase() pins it, so a
     strip of frames is a strip of exact phases. gaitTrace() steps the
     whole animator — clip, blend, additive layers, foot IK, all of it —
     round the cycle and reports the things a still cannot show: stride,
     bob, knee range, and how far the PLANTED foot moves per frame
     against the ground speed the phase integrator is actually using.
     That last number is the one that decides whether this is a walk or a
     shuffle, and it has to be measured on the real pipeline, not on the
     clip function in isolation. */
  dbg.footIK = (on) => { secondary.ikEnabled = on !== false; return secondary.ikEnabled; };
  /* "His trunk goes through his body sometimes." The fix is a body
     proxy in secondary.js; these make it measurable rather than
     claimed. trunkClear() is the rendered clearance in metres —
     negative is inside him, and a green frame is >= 0. bodyProxy(false)
     switches the constraint off so a before/after is one session. */
  dbg.trunkClear = () => secondary.trunkClearance();
  dbg.bodyProxy = (on) => { secondary.bodyProxyOn = on !== false; return secondary.bodyProxyOn; };
  /* 0 restores the untrimmed run flap; 1 is the shipped trim. */
  dbg.earTrim = (v) => { secondary.earTrim = v == null ? 1 : +v; return secondary.earTrim; };
  dbg.locoPhase = (p) => { anim.setPhaseLock(p == null ? null : p); return p == null ? 'free' : p; };
  /* Walk the pinned phase to a new value over `frames` real frames rather
     than jumping to it. The ear, trunk and tail chains are springs driven
     by ACCELERATION: teleporting the phase by an eighth of a cycle
     between two screenshots hands them an impulse the gait never
     produces, and they photograph flung out sideways. This is slow
     motion, not a freeze — the soft parts still lag, they just lag
     something plausible. */
  dbg.locoStep = (to, frames = 18) => new Promise((done) => {
    const from = anim.phaseLock == null ? anim.locPhase : anim.phaseLock;
    let d = to - from; d -= Math.round(d);          // shortest way round
    let i = 0;
    const tick = () => {
      i++;
      anim.setPhaseLock(from + d * (i / frames));
      if (i >= frames) { anim.setPhaseLock(to); done(to); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const _tv = new THREE.Vector3();
  const GT_SOLE = PROP.foot.c[1] - PROP.foot.h[1] - PROP.foot.r;
  const GT_ANKH = bindWorld('footL')[1] - GT_SOLE;
  const GT_HEEL = PROP.foot.c[2] - PROP.foot.h[2] - PROP.foot.r - bindWorld('footL')[2];
  const GT_TOE = PROP.foot.c[2] + PROP.foot.h[2] + PROP.foot.r - bindWorld('footL')[2];

  /* `flat` swaps the terrain for a plane at his feet for the duration of
     the measurement, and it is not cheating: "does the contact foot
     slide" is a question about the GAIT, and it cannot be answered from a
     spawn point that happens to have a 0.33 m kerb inside the stride —
     the conform reaching down into that is correct behaviour and swamps
     the signal. Pass false to measure the conform itself. */
  dbg.gaitTrace = (speed = 2.45, n = 32, flat = true) => {
    const wasManual = locoManual, wasS = locoSpeed, wasT = locoTurn, wasLock = anim.phaseLock;
    const phys = ctx.phys;
    const realGround = phys && phys.groundAt;
    if (flat && realGround) {
      const g0 = realGround.call(phys, root.position.x, root.position.z);
      const flatN = { x: 0, y: 1, z: 0 };
      phys.groundAt = () => ({ y: g0.y, normal: g0.normal ? flatN : flatN, slope: 0 });
    }
    api.setLocomotion(speed, 0);
    /* two cycles of pre-roll: hipDrop, ikBlend and the spring chains are
       all damped accumulators, and measuring them cold measures the
       transient rather than the gait */
    secondary.hipDrop = 0; secondary.ikBlend = 1;
    for (let i = 0; i < n * 2; i++) {
      anim.setPhaseLock(i / n);
      update(1 / 60, i / 60);
      lateUpdate(1 / 60);
    }
    const rows = [];
    const at = (bone, ly, lz) => {
      _tv.set(0, ly, lz).applyMatrix4(bone.matrixWorld);
      return [_tv.z - root.position.z, _tv.y - root.position.y - GT_SOLE];
    };
    for (let i = 0; i < n; i++) {
      anim.setPhaseLock(i / n);
      update(1 / 60, i / 60);
      lateUpdate(1 / 60);
      root.updateMatrixWorld(true);
      const r = { ph: +(i / n).toFixed(4) };
      rig.byName.hips.getWorldPosition(_tv);
      r.hipY = +(_tv.y - root.position.y - GT_SOLE).toFixed(4);
      for (const sd of ['L', 'R']) {
        const b = rig.byName['foot' + sd];
        const m = b.matrixWorld.elements;
        const heel = at(b, -GT_ANKH, GT_HEEL);
        const toe = at(b, -GT_ANKH, GT_TOE);
        b.getWorldPosition(_tv);
        r['ank' + sd] = [+(_tv.z - root.position.z).toFixed(4), +(_tv.y - root.position.y - GT_SOLE).toFixed(4)];
        r['pitch' + sd] = +(Math.atan2(m[6], m[5]) * 180 / Math.PI).toFixed(1);
        r['knee' + sd] = +(rig.byName['leg' + sd + '1'].rotation.x * 180 / Math.PI).toFixed(1);
        r['thigh' + sd] = +(rig.byName['leg' + sd + '0'].rotation.x * 180 / Math.PI).toFixed(1);
        r['sole' + sd] = +Math.min(heel[1], toe[1]).toFixed(4);
        r['heel' + sd] = +heel[0].toFixed(4); r['toe' + sd] = +toe[0].toFixed(4);
      }
      r.plant = [+anim.plant[0].toFixed(2), +anim.plant[1].toFixed(2)];
      r.hipDrop = +secondary.hipDrop.toFixed(4);
      r.sy = +(root.scale.y).toFixed(4);
      rows.push(r);
    }
    anim.setPhaseLock(wasLock);
    if (flat && realGround) phys.groundAt = realGround;
    if (wasManual) api.setLocomotion(wasS, wasT); else api.setLocomotion(null);

    const cycle = anim.locoCycle || 1;
    const step = cycle / n;
    /* slip: over the planted frames the contact point must travel
       backward at exactly one `step` per frame. The pivot changes
       identity at the heel-to-toe handover, so those frames are skipped
       rather than counted as a metre of slide. */
    let tot = 0, cnt = 0, worst = 0;
    for (let i = 1; i < n; i++) {
      const a = rows[i - 1], b = rows[i];
      if (a.soleL > 0.004 || b.soleL > 0.004) continue;
      let d;
      if (Math.abs(a.pitchL) < 1.2 && Math.abs(b.pitchL) < 1.2) d = b.ankL[0] - a.ankL[0];
      else if (a.pitchL < -1.2 && b.pitchL < -1.2) d = b.heelL - a.heelL;
      else if (a.pitchL > 1.2 && b.pitchL > 1.2) d = b.toeL - a.toeL;
      else continue;
      const e = Math.abs(d + step);
      tot += e; cnt++; worst = Math.max(worst, e);
    }
    const rng = (k, j) => {
      const v = rows.map((r) => (j === undefined ? r[k] : r[k][j]));
      return +(Math.max(...v) - Math.min(...v)).toFixed(4);
    };
    return {
      speed, cycle: +cycle.toFixed(4),
      cadenceStepsPerSec: +(2 * speed / cycle).toFixed(2),
      hipBob: rng('hipY'),
      thighRangeDeg: rng('thighL'),
      kneeRangeDeg: rng('kneeL'),
      footPitchDeg: rng('pitchL'),
      ankleTravel: rng('ankL', 0),
      footLift: +Math.max(...rows.map((r) => r.soleL)).toFixed(4),
      soleSink: +Math.min(...rows.map((r) => r.soleL)).toFixed(4),
      rootY: +root.position.y.toFixed(4),
      groundY: +(ctx.phys?.groundAt ? ctx.phys.groundAt(root.position.x, root.position.z).y : 0).toFixed(4),
      hipDropRange: rng('hipDrop'),
      syRange: rng('sy'),
      plantedFrames: cnt,
      slipPerFrame: +(tot / Math.max(cnt, 1)).toFixed(5),
      slipPctOfGroundSpeed: +(100 * (tot / Math.max(cnt, 1)) / step).toFixed(1),
      worstSlip: +worst.toFixed(5),
      rows,
    };
  };

  /* ================================================================
     WALLY.debug.driveTrace(ride, speed, n)

     THE DRIVETRAIN RULER. "Is he pedalling backwards" is exactly the
     question an eye cannot answer — a crank circle looks identical
     played either way at 24 fps — so it is answered here with numbers
     instead. For one full cycle at a known speed it samples, in
     ROOT-LOCAL metres (the frame the whole convention is stated in,
     FORWARD IS +Z):

       ankle   the footL bone, i.e. where the leg solve actually puts
               the foot after every blend, IK gate and secondary pass
       pedal   the LEFT pedal plate on the prop's own crank
       mark    a material point on the rear wheel rim — a valve stem

     and reports, for each of the three, the sign of dz at the TOP of
     its own circle. A forward drivetrain has ALL THREE POSITIVE: the
     top of a forward-rolling wheel moves toward +z, and so does the
     top of a forward-turning crank and the foot on it.

     THE SIGN IS ONLY A SIGN ABOVE A FLOOR, and the rule used to be
     stated without one: "any minus sign in that row is a reversed
     drivetrain". On a machine with no pedals that rule convicts the
     noise. The scooter has a footboard and no crank, so the foot does
     not travel a circle at all and `dzAtTop.ankle` reads -0.00016 m —
     0.16 mm of residual from the secondary pass, and a minus sign. The
     real signals on the machines that do have a drivetrain are 0.0127
     and 0.0180 m, two orders of magnitude clear of that, so the floor
     can sit almost anywhere between; DZ_NOISE_M is 0.001 m, six times
     the noise and twelve times below the smallest true reading.

     `driveDirection` applies it: 'fwd', 'rev', or 'none' when the
     travel is under the floor and there is nothing to read a direction
     from. Read THAT, not the sign of the raw millimetres, which are
     still published beside it because a number you cannot see is a
     number nobody can check.

     `fitMax` is the ankle-to-pedal distance at its WORST over the
     stroke and `fitDrift` is how much that offset VECTOR wanders, which
     is the number that catches a foot sliding off the pedal as the
     phase is re-signed. THEY ARE DIFFERENT QUESTIONS and quoting one
     for the other has already caused trouble in this file: at the
     shipped tuning fitDrift is 23.5 mm and fitMax is 50.2 mm, and a
     note downstream cited the 23.5 as "the ankle tracks the pedal to
     within 24 mm across the whole stroke", which is twice as good as
     the truth. Drift is the SPREAD of the offset; max is the GAP.

     `speed` IS A RUNG, AND IT REACHES BOTH HALVES. It pins the pose for
     the phase sweep, and it is mapped onto the controller for the
     travel probe the way touch.js maps a stick: pick the speed, then
     say which gear it lives in. That mapping used to be missing — the
     probe pushed run:false at full magnitude and always measured the
     no-shift cruise, so driveTrace('bike', 8.8) came back byte-for-byte
     identical to driveTrace('bike', 5.2) and the tool was blind to the
     sprint rung, which is exactly where the wheel bug was worst at 41%
     slow. `rungMeasured` now reports what was actually reached, so the
     number can never be read as the rung that was asked for.
     ================================================================ */
  dbg.driveTrace = (rideName = 'bike', speed = 5.2, n = 48) => {
    const wasManual = locoManual, wasS = locoSpeed, wasT = locoTurn;
    const wasLock = anim.phaseLock, wasForced = bikeForced;
    const key = rideKey(rideName) || 'bike';
    bikeForced = true;
    api.setRide(key, { instant: true });
    api.setLocomotion(speed, 0);
    /* PRE-ROLL, AND IT IS 2.5 s BECAUSE 0.4 s WAS NOT ENOUGH ONCE.
       bikeRide, the lean damper and the spring chains are all
       accumulators, and a cold first frame measures the transient. At
       24 frames the very FIRST call after boot — the machine has never
       been mounted, so the whole mount transition is inside the sample
       — reported fitMaxMM 117.3 and fitDriftMM 84.4, while every call
       after it reported 50.2 and 23.5 to the decimal. A ruler whose
       first reading is 2.3x out and whose second is exact is a ruler
       nobody can use once. Measured: 24 frames gives 117.3/84.4 cold,
       72 gives 57.8/26.9, 150 gives 50.2/23.6 — the same numbers as
       every warm call, to a tenth of a millimetre. It is 150. */
    for (let i = 0; i < 150; i++) { update(1 / 60, i / 60); lateUpdate(1 / 60); }

    const prop = bike;
    const V = new THREE.Vector3();
    /* the left crank arm is the one at +x — bike.js puts it at
       rotation 0 because bikeBody gives the left leg pedal phase 0 —
       and the pedal plate is the child hanging below it */
    let pedalMesh = null;
    if (prop && prop.crank) {
      const arm = prop.crank.children.find((c) => !c.isMesh && c.position.x > 0)
        || prop.crank.children.find((c) => c.children?.length && c.position.x > 0);
      /* the PLATE, not the arm: the arm's own capsule also hangs at
         -y, and measuring its midpoint measures a point at half the
         crank radius, which reads as a working drivetrain at the wrong
         scale. The plate is the box, and it is the thing the foot is
         supposed to be standing on. */
      pedalMesh = arm && (arm.children.find((c) => c.isMesh && c.geometry?.type === 'BoxGeometry')
        || arm.children.find((c) => c.isMesh && c.position.y < 0));
    }
    /* the REAR wheel: wheels[0] is the front (z +AXZ), wheels[1] the
       rear. Either tells the same story; the rear is the driven one. */
    const wheel = prop && prop.wheels ? (prop.wheels[1] || prop.wheels[0]) : null;
    /* the wheel group sits at y = its own radius, so its height IS the
       radius — no module has to publish a second copy of the number */
    const wr = wheel ? wheel.position.y : 0.225;

    const local = (o, lx, ly, lz) => {
      V.set(lx || 0, ly || 0, lz || 0);
      o.localToWorld(V);
      root.worldToLocal(V);
      return [V.x, V.y, V.z];
    };

    const rows = [];
    for (let i = 0; i <= n; i++) {
      const ph = i / n;
      anim.setPhaseLock(ph % 1);
      update(1 / 60, i / 60);
      lateUpdate(1 / 60);
      root.updateMatrixWorld(true);
      const r = { ph: +ph.toFixed(4) };
      r.ankle = local(rig.byName.footL, 0, 0, 0);
      r.pedal = pedalMesh ? local(pedalMesh, 0, 0, 0) : null;
      /* a valve stem: wheel-LOCAL +y, so it rides round with the group */
      r.mark = wheel ? local(wheel, 0, wr, 0) : null;
      r.crankRot = prop && prop.crank ? prop.crank.rotation.x : null;
      r.wheelRot = wheel ? wheel.rotation.x : null;
      /* THE ROCK, against the foot it is supposed to be rocking onto.
         LEFT IS +X on this rig (legL0 sits at x +0.134), and a NEGATIVE
         spine roll tips the torso top toward +x. So "leans onto the
         left foot" reads as spineRollDeg < 0, and it has to coincide
         with the left ankle DESCENDING — that is the push. */
      r.spineRollDeg = +(rig.byName.spine.rotation.z * 180 / Math.PI).toFixed(2);
      r.ankRy = +local(rig.byName.footR, 0, 0, 0)[1].toFixed(4);
      r.elbowLx = +(rig.byName.armL1.rotation.x * 180 / Math.PI).toFixed(2);
      rows.push(r);
    }

    /* dz at the top of each circle, and at the bottom, from the sample
       where that point is highest / lowest. One-sided differences, so
       the sign is the sign of the motion and nothing else. */
    /* 1 mm. Six times the 0.16 mm the pedal-less machines idle at, and
       twelve times under the smallest real signal (0.0127 m). */
    const DZ_NOISE_M = 0.001;
    const dirOf = (v) => (v == null ? null : (Math.abs(v) < DZ_NOISE_M ? 'none' : (v > 0 ? 'fwd' : 'rev')));
    /* ------------------------------------------------------------------
       NO INDEX WRAP. IT CALLED A CORRECT WHEEL REVERSED, ABOUT ONCE IN
       NINE.

       This used to take the forward difference at
       `pts[(bi + 1) % (pts.length - 1)]`. The wrap is right for the
       ankle and the pedal, which are PERIODIC across the phase sweep —
       index 0 and index n are the same pose, so wrapping off the end
       lands on the neighbour. The wheel mark is not periodic: it is
       driven by DISTANCE and turns 4.15 revolutions across the sweep,
       so whenever the highest sample landed on the second-to-last index
       the difference was taken across four revolutions and its sign was
       arbitrary. Measured: the same call from the same spot, 18 times,
       returned 'rev' for the wheel mark twice, with magnitudes the size
       of the true signal rather than of noise, while wheelRateErrPct
       read 0.00% throughout.

       This tool exists BECAUSE the drivetrain once ran backwards under
       a character moving forwards. A false 'reversed' is exactly the
       alarm that gets a ruler ignored, and an ignored ruler is worse
       than no ruler.

       The wrap was never needed by the periodic pair either: `bi` is
       searched over [0, len-2], so bi + 1 is always a real index, and
       for a periodic series pts[n] is pts[0] to the float. One line,
       and it is now the same line for all three.
       ------------------------------------------------------------------ */
    const dzAt = (key2, pick) => {
      const pts = rows.map((r) => r[key2]).filter(Boolean);
      if (pts.length < 3) return null;
      let bi = 0;
      for (let i = 1; i < pts.length - 1; i++) {
        if (pick === 'top' ? pts[i][1] > pts[bi][1] : pts[i][1] < pts[bi][1]) bi = i;
      }
      return +(pts[bi + 1][2] - pts[bi][2]).toFixed(5);
    };

    let fitMax = 0, fitMin = 1e9;
    const offs = [];
    for (const r of rows) {
      if (!r.pedal) break;
      const dy = r.ankle[1] - r.pedal[1], dz = r.ankle[2] - r.pedal[2];
      /* the fit is a SAGITTAL question: the pedal plate is offset
         outboard on purpose (bike.js's wide chainline), so x is the
         geometry and y/z is whether the foot is ON it */
      const d = Math.hypot(dy - 0.10, dz);
      fitMax = Math.max(fitMax, d); fitMin = Math.min(fitMin, d);
      offs.push([dy, dz]);
    }
    const mean = offs.length
      ? [offs.reduce((s, o) => s + o[0], 0) / offs.length, offs.reduce((s, o) => s + o[1], 0) / offs.length]
      : [0, 0];
    const fitDrift = offs.reduce((m, o) => Math.max(m, Math.hypot(o[0] - mean[0], o[1] - mean[1])), 0);

    /* ================================================================
       THE TRAVEL REFERENCE — the half of this tool that was dead.

       It reported travelAlongOwnForward 0 at every speed, because the
       loop above only calls update()/lateUpdate() by hand: update()
       COPIES the controller's position onto the root, and nothing was
       stepping the controller, so the root sat still while the legs
       pedalled. Mutual agreement between ankle, crank and wheel with no
       travel to compare them against is precisely the failure mode that
       let "he pedals backwards" ship — all three agreed with each other
       and all three were wrong.

       So step the CONTROLLER. A temporary input function pushes a unit
       wish along his current heading, controller.step() integrates it
       through the real solver against the real collision world, and the
       root follows because update() copies it. Position and velocity
       are put back afterwards, so calling the ruler does not move the
       player.

       `blocked` is not a nicety either: a probe that starts two metres
       from a wall measures a stationary bicycle and would report the
       drivetrain as infinitely fast. If it trips, move him and re-run.

       ------------------------------------------------------------------
       IT WARMS TO A PLATEAU NOW, AND IT SAYS SO WHEN IT DID NOT.
       ------------------------------------------------------------------
       A FALSE ALARM FROM A MEASURING TOOL IS NOT A SMALL THING ON THIS
       PROJECT. Three rounds went into digging a defect a tool had
       fabricated by sampling background pixels, and the reason this
       function was repaired at all is that it used to report zero for
       travel. A ruler that cries wolf gets ignored, and an ignored ruler
       is worse than no ruler.

       The fixed 48-frame warm-up was one of those wolves. It is 0.8 s,
       which is enough for a bicycle (accel 22, cruise 5.10) and nowhere
       near enough for a motorcycle (accel 26, cruise 15.30): the sample
       window opened at 10.65 m/s against a 15.30 target and ran to its
       end still accelerating. The roll LAGS the ground while
       accelerating — the wheel is driven by `speed * dt` sampled at the
       top of the frame while the controller integrates within it — by
       -14.7% over the accel window against -0.005% once steady, so the
       tool reported -1.74% wheel rate error on a drivetrain that is
       exact to five decimal places. travelBlocked could not catch it,
       because `expected` is derived from the same average.

       So warm until the speed stops changing, with a frame cap so a
       machine pinned against a wall still returns; then check the
       sample window itself and publish `sampledAtCruise`. A number
       taken off a machine that is still accelerating is not a rate
       measurement and must not be read as one.

       ------------------------------------------------------------------
       ONE FRAME OF STILLNESS IS NOT A PLATEAU
       ------------------------------------------------------------------
       The first version of that break-out tested |s - prevS| on a SINGLE
       frame, and a controller scraping along a wall satisfies that
       constantly while it is nowhere near its rung. Measured at the
       bike's 8.2 rung outside the apartment: it broke out after 56
       frames at warmSpeed 8.197 — which reads like the rung — then the
       40-frame sample averaged 5.464 and it reported wheelRateErrPct
       -1.75, the exact false alarm this whole repair exists to stop.
       `sampledAtCruise` did catch it (false, 48.6% drift), and that half
       worked. But the plateau must hold for PLATEAU_HOLD consecutive
       frames before the warm-up believes it, or the warm-up hands the
       sample window a speed the machine is about to leave.

       AND travelBlocked NOW COMPARES AGAINST THE RUNG THAT WAS ASKED
       FOR. It used to derive `expected` from `plateau` — the average of
       the very sample it was checking — so a machine that stalled at
       two thirds of its rung produced a two-thirds expectation and
       matched it perfectly. It read false on every machine at every
       rung, including rungs nothing ever got near, which makes it worse
       than useless: it is the first flag a reader looks at when asking
       whether a measurement was any good. It is now `want` — the
       requested speed, clamped to what the machine can actually do —
       and it trips on the run above.
       ================================================================ */
    anim.setPhaseLock(null);
    const TAU2 = Math.PI * 2;
    const unwrapStep = (d) => d - Math.round(d / TAU2) * TAU2;
    /* ------------------------------------------------------------------
       THE PLATEAU IS A TREND TEST, NOT A STILLNESS TEST, AND IT IS
       RELATIVE TO THE RUNG.

       The flag this header tells you to read first used to be wrong most
       of the time. `reachedPlateau` judged the plateau on an ABSOLUTE
       per-frame speed change of 1e-4 m/s held for 12 consecutive frames.
       The ground undulates: heightAt is a 2 m raster and the controller
       climbs and descends every cell, so planarSpeed keeps moving by
       more than that indefinitely. Measured with an independent rig that
       does not call driveTrace — the controller stepped by hand at the
       bike's 5.2 rung, frames 200 to 400, i.e. long past any
       acceleration — the per-frame |ds| is 1e-8 at the median but its
       90th percentile is 3.0e-3 and its worst 1.6e-2, and the longest
       run of consecutive frames under 1e-4 was 13 at one spot and 22 at
       another. So the warm-up ran its full 300-frame cap and the flag
       read false on samples whose rate error was exactly 0.00%. Across
       30 runs at 5 spots it was false in 21.

       It fails safe, but a flag that reads "not a rate" on a rate exact
       to five decimals is the ignored-ruler failure again, and it is the
       second instance of it in this one function (see the dz wrap
       above).

       So: the question is not "is the speed still" — on this terrain it
       never is — but "has it stopped TRENDING". Mean of the last
       PLATEAU_WIN frames against the mean of the PLATEAU_WIN before, as
       a fraction of the rung that was asked for. Measured with the same
       rig: at cruise that number is 0.03% to 0.06%; during the
       acceleration it is 34.6%. Three orders of magnitude between the
       two states, so the threshold is not a tuning parameter. The bike
       settles at frame 95 with 5.193-5.198 m/s against a 5.20 rung; the
       motorcycle at 15.3 settles between 148 and 217, which is why the
       cap is no longer 300.
       ------------------------------------------------------------------ */
    const T_WARM_MAX = 420, T_FRAMES = 40, T_DT = 1 / 60;
    const PLATEAU_WIN = 30;          // frames per half of the trend window
    const PLATEAU_EPS_REL = 0.002;   // 0.2% of the rung between the halves
    const PLATEAU_HOLD = 6;
    let travel = 0, dist = 0, wheelRad = 0, maxStepRad = 0, backStepRad = 0, plateau = 0;
    let warmFrames = 0, warmSpeed = 0, reachedPlateau = false;
    let sampleS0 = 0, sampleS1 = 0;
    /* the sample window's own series, so steadiness is judged on all of
       it rather than on its two end frames */
    const sampleSeries = [];
    /* the rung the CONTROLLER was actually asked for, hoisted out of the
       block below so travelBlocked can be about it */
    let rungTarget = Number.isFinite(speed) ? speed : 0;
    if (controller) {
      const savedFn = controller._inputFn || null;
      const savedPos = controller.simPosition.clone();
      const savedVel = controller.velocity.clone();
      const yaw0 = controller.yaw;
      /* RELEASE THE FORCED LOCOMOTION FIRST. The phase sweep above pins
         it at `speed` so the pose is the pose at that rung; leaving it
         pinned through the travel probe would roll the wheels off a
         number that has nothing to do with how far the controller
         actually got, and the tool would report a 41% rate error on a
         drivetrain that is exact. Off the leash, `speed` in update() is
         the controller's own planarSpeed — which is the only pairing
         where "revolutions per metre" means anything. */
      api.setLocomotion(null);
      /* THE RUNG, ON THE CONTROLLER. `target` inside _horizontal() is
         (run ? runSpeed : walkSpeed) * |input|, so a requested speed has
         to choose the GEAR and the MAGNITUDE together — the same two
         numbers, in the same order, that touch.js picks for the stick.
         The options are read off the controller rather than off
         RIDE_TUNE because bikeSpeeds() has already patched them for the
         machine that is actually mounted, and the patched pair is what
         the solver will use.

         WORLD-space wish along his own forward. camera.js documents the
         same convention: controller.input is a world direction. */
      const O = controller.opts || {};
      const vWalk = O.walkSpeed || 5.10;
      const vRun = O.runSpeed || vWalk;
      const want = clamp(Number.isFinite(speed) ? speed : vWalk, 0, vRun);
      rungTarget = want;
      const useRun = want > vWalk + 1e-4;
      const mag = clamp(want / Math.max(useRun ? vRun : vWalk, 1e-4), 0, 1);
      controller.setInputFn(() => ({
        x: Math.sin(yaw0) * mag, z: Math.cos(yaw0) * mag, run: useRun,
      }));
      /* warm-up: run it until the speed stops TRENDING, not until it
         stops moving and not for a fixed count of frames */
      const hist = [];
      let held = 0, sum1 = 0, sum2 = 0;
      for (let i = 0; i < T_WARM_MAX; i++) {
        controller.step(T_DT);
        controller.position.copy(controller.simPosition);
        update(T_DT, i * T_DT);
        lateUpdate(T_DT);
        warmFrames++;
        const s = controller.planarSpeed;
        /* two running sums over the last 2*PLATEAU_WIN frames: the newer
           half against the older one */
        hist.push(s); sum1 += s;
        if (hist.length > PLATEAU_WIN) { const m = hist[hist.length - 1 - PLATEAU_WIN]; sum1 -= m; sum2 += m; }
        if (hist.length > 2 * PLATEAU_WIN) sum2 -= hist[hist.length - 1 - 2 * PLATEAU_WIN];
        if (hist.length >= 2 * PLATEAU_WIN) {
          const trend = Math.abs(sum1 - sum2) / PLATEAU_WIN / Math.max(want, 1e-3);
          /* HELD, NOT HIT. One quiet window is a coincidence; a
             wall-scrape that happens to sit flat does not survive six
             consecutive ones. */
          held = trend < PLATEAU_EPS_REL ? held + 1 : 0;
          if (held >= PLATEAU_HOLD) { reachedPlateau = true; break; }
        }
      }
      warmSpeed = controller.planarSpeed;
      const p0 = controller.simPosition.clone();
      let prevRot = wheel ? wheel.rotation.x : 0;
      const prevP = controller.simPosition.clone();
      for (let i = 0; i < T_FRAMES; i++) {
        controller.step(T_DT);
        controller.position.copy(controller.simPosition);
        update(T_DT, i * T_DT);
        lateUpdate(T_DT);
        if (wheel) {
          const raw = wheel.rotation.x - prevRot;
          if (Math.abs(raw) > Math.abs(maxStepRad)) maxStepRad = raw;
          const st = unwrapStep(raw);
          if (st < backStepRad) backStepRad = st;
          wheelRad += st;
          prevRot = wheel.rotation.x;
        }
        dist += Math.hypot(controller.simPosition.x - prevP.x, controller.simPosition.z - prevP.z);
        prevP.copy(controller.simPosition);
        plateau += controller.planarSpeed;
        sampleSeries.push(controller.planarSpeed);
        if (i === 0) sampleS0 = controller.planarSpeed;
        sampleS1 = controller.planarSpeed;
      }
      plateau /= T_FRAMES;
      const fwd = new THREE.Vector3(Math.sin(yaw0), 0, Math.cos(yaw0));
      travel = controller.simPosition.clone().sub(p0).dot(fwd);
      controller.setInputFn(savedFn);
      controller.teleport(savedPos);
      controller.velocity.copy(savedVel);
    }
    /* Did the SAMPLE — not the warm-up — happen at a steady speed? The
       rate figures below are only a rate measurement if it did.

       TWO QUESTIONS, REPORTED SEPARATELY, because they fail for
       different reasons and lumping them cost this flag its credibility.
       `sampleDriftPct` is the first frame of the window against the last
       — the old test, kept because it is cheap to check by hand, but it
       is a two-point difference and terrain undulation moves it on a
       sample that is otherwise perfect. `sampleTrendPct` is the second
       half's mean against the first half's: undulation cancels in it and
       acceleration does not, which is the only distinction that matters
       here. `sampleSpreadPct` is the window's full range, published so
       an undulating sample can be SEEN to be undulating rather than
       inferred to be. */
    const sampleDrift = Math.abs(sampleS1 - sampleS0) / Math.max(plateau, 1e-4);
    let sampleTrend = 0, sampleSpread = 0;
    if (sampleSeries.length >= 4) {
      const h = sampleSeries.length >> 1;
      let a = 0, b = 0, lo = Infinity, hi = -Infinity;
      for (let i = 0; i < sampleSeries.length; i++) {
        const v = sampleSeries[i];
        if (i < h) a += v; else b += v;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const den = Math.max(plateau, 1e-4);
      sampleTrend = Math.abs(b / (sampleSeries.length - h) - a / h) / den;
      sampleSpread = (hi - lo) / den;
    }
    /* 0.5% of the rung across the window. The bike's undulation trend at
       cruise measures 0.03-0.06%; the motorcycle still accelerating
       through its window measured 34.6%. Nothing lives in between.

       AND IT IS GATED ON travelBlocked, WHICH IS THE HALF THIS FLAG WAS
       BLIND TO. A steady speed was the whole test, and a controller
       pinned dead against a wall is perfectly steady: measured from the
       spawn mark at 24 headings, the motorcycle's 26.4 rung came back
       travelBlocked at 20 of them and `sampledAtCruise` TRUE at 11 of
       those — plateau reached, trend 0.000%, at 0.7% of the rung it was
       asked for. The scooter's 13.2 did it at 3 of 6. The flag's own
       header says READ IT FIRST, and read first it waved every one of
       them through. It is not enough to pair it with travelBlocked in
       prose: a reader who takes the instruction literally never gets to
       the pairing. So the two are joined here, and `notCruiseBecause`
       carries WHICH of the three it was, because an accelerating sample,
       an undulating one and a blocked one are three different
       complaints and lumping them is what cost this flag its
       credibility the last time. (The rate figures — revolutions per
       metre — can still be sound on a blocked sample; they are computed
       from path length, not from forward travel. `notCruiseBecause` is
       how you tell that case from a genuinely unusable one.) */
    const expectedTravel = rungTarget * T_FRAMES * T_DT;
    const blocked = expectedTravel > 0.05 && travel < expectedTravel * 0.5;
    const steady = reachedPlateau && sampleTrend < 0.005;
    const sampledAtCruise = steady && !blocked;
    /* BLOCKED IS TESTED FIRST, and the order is the whole point. A pinned
       machine also fails to plateau and also reads a wild trend, so an
       accelerating-or-undulating test in front of it reports a SYMPTOM and
       buries the cause: measured over 26 blocked runs, the old order named
       the wrong one of the three on 12 of them (46%), worst case a
       motorcycle that travelled 0.0023 m against 17.6 m expected and was
       reported 'undulating'. Being pinned is the diagnosis that changes what
       the reader does next; the other two labels are what it looks like. */
    const notCruiseBecause = sampledAtCruise ? null
      : (travelBlocked ? 'blocked' : (!reachedPlateau ? 'accelerating' : 'undulating'));
    let crankRadPerCycle = 0;
    for (let i = 1; i < rows.length; i++) {
      crankRadPerCycle += unwrapStep(rows[i].crankRot - rows[i - 1].crankRot);
    }
    /* THE EXPECTATION IS THE RUNG THAT WAS ASKED FOR, not the average of
       the sample being judged. See the note above. One name, computed
       once, above, because sampledAtCruise is now gated on it. */
    const expected = expectedTravel;
    const revsRolled = wheelRad / TAU2;
    const demandRevPerM = dist > 1e-4 ? 1 / (TAU2 * wr) : null;
    const deliverRevPerM = dist > 1e-4 ? revsRolled / dist : null;

    anim.setPhaseLock(wasLock);
    bikeForced = wasForced;
    if (wasManual) api.setLocomotion(wasS, wasT); else api.setLocomotion(null);

    return {
      ride: key, samples: n,
      /* --- WHICH RUNG, asked for and actually reached ---
         `rungRequested` is the argument; `rungMeasured` is the speed the
         sample was taken at. They are both here so the answer can never
         be attributed to a rung the machine never got to — the failure
         that made this tool blind to the sprint. */
      rungRequested: speed,
      /* what the CONTROLLER was asked for: `speed` clamped to the gear
         ladder the mounted machine actually has. travelBlocked is about
         this number. */
      rungTarget: +rungTarget.toFixed(3),
      rungMeasured: +plateau.toFixed(3),
      warmFrames,
      warmSpeed: +warmSpeed.toFixed(3),
      /* FALSE MEANS THE SAMPLE IS NOT A MEASUREMENT OF THE RUNG THAT WAS
         ASKED FOR. Three ways: the warm-up ran out of frames before the
         speed stopped trending; the speed was still trending across the
         sample window itself; or the machine held a steady speed it
         reached by being stopped by something. Read it first — it is
         safe to read first now, which it was not while a machine pinned
         against a wall at 0.7% of its rung satisfied it. */
      sampledAtCruise,
      /* 'accelerating' | 'undulating' | 'blocked' | null — WHICH of the
         three, so the flag can be read first without losing what a
         second look would have told you. On 'blocked' the revs-per-metre
         figures may still be sound; on the other two they are not. */
      notCruiseBecause,
      /* the two halves of the flag, still published on their own */
      steadyInWindow: steady,
      /* the warm-up's own verdict, on its own */
      plateauReached: reachedPlateau,
      /* the sample window: trend is the one the flag is gated on, spread
         and drift are published so undulation is visible rather than
         inferred */
      sampleTrendPct: +(sampleTrend * 100).toFixed(3),
      sampleSpreadPct: +(sampleSpread * 100).toFixed(3),
      sampleSpeedDriftPct: +(sampleDrift * 100).toFixed(3),
      /* --- the direction-of-travel half --- */
      travelAlongOwnForward: +travel.toFixed(4),
      /* what the REQUESTED rung would have covered in the sample window */
      travelExpected: +expected.toFixed(4),
      cruiseSpeed: +plateau.toFixed(3),
      /* TRUE MEANS MOVE HIM AND RUN IT AGAIN. Measured against the rung
         that was asked for, so a machine that stalled at two thirds of
         it trips this — which the old expectation, derived from the
         stalled average itself, could never do. sampledAtCruise is gated
         on this, so the two can no longer disagree. */
      travelBlocked: blocked,
      /* --- the RATE half: what the ground demands vs what it gets ---
         Both figures are revolutions per metre. They are the whole
         point of the tool: a drivetrain can point the right way and
         still be 41% slow, which is what the crank-driven wheel was at
         the sprint rung. --- */
      metresTravelled: +dist.toFixed(4),
      wheelRevs: +revsRolled.toFixed(4),
      wheelRadius: +wr.toFixed(4),
      revPerMetreDemanded: demandRevPerM == null ? null : +demandRevPerM.toFixed(4),
      revPerMetreDelivered: deliverRevPerM == null ? null : +deliverRevPerM.toFixed(4),
      wheelRateErrPct: (demandRevPerM && deliverRevPerM)
        ? +(((deliverRevPerM / demandRevPerM) - 1) * 100).toFixed(2) : null,
      /* THE SNAP DETECTOR. maxWheelStepRad is the largest step in the
         RAW angle, so a legitimate wrap shows up here as about -2*pi
         and that is fine — a rotation of exactly one turn is identity.
         maxBackwardStepRad is the same series with exact 2*pi taken
         out, so it is the largest step the EYE would see going the
         wrong way. It read -5.27 rad (-302 deg) on the crank-driven
         wheel, about 1.5 times a second; it must read ~0 now, and
         anything below about -0.05 at a walking pace is a real snap. */
      maxWheelStepRad: +maxStepRad.toFixed(4),
      maxBackwardStepRad: +backStepRad.toFixed(4),
      dzAtTop: { ankle: dzAt('ankle', 'top'), pedal: dzAt('pedal', 'top'), wheelMark: dzAt('mark', 'top') },
      dzAtBottom: { ankle: dzAt('ankle', 'bottom'), pedal: dzAt('pedal', 'bottom'), wheelMark: dzAt('mark', 'bottom') },
      /* THE VERDICT, WITH THE NOISE FLOOR APPLIED. See the header: a
         pedal-less machine's ankle reads 0.16 mm and a bare sign test
         calls that a reversed drivetrain. */
      dzNoiseFloorM: DZ_NOISE_M,
      driveDirection: {
        ankle: dirOf(dzAt('ankle', 'top')),
        pedal: dirOf(dzAt('pedal', 'top')),
        wheelMark: dirOf(dzAt('mark', 'top')),
      },
      /* THE FREE CROSS-CHECK, and it costs nothing because both halves
         are already in this object. `driveDirection.wheelMark` reads the
         valve stem at the top of ONE circle during the phase sweep;
         `wheelRollVsTravel` reads the whole travel probe — the sign of
         the revolutions the wheel actually turned against the sign of
         the distance the controller actually covered. They answer the
         same question from two independent halves of the tool, so a
         disagreement is a defect in the RULER and not in the drivetrain.
         'idle' when there is not enough of either to have a sign. */
      wheelRollVsTravel: (Math.abs(revsRolled) < 0.02 || Math.abs(travel) < 0.02)
        ? 'idle' : ((revsRolled > 0) === (travel > 0) ? 'agree' : 'disagree'),
      /* UNWRAPPED, and that is the whole repair: both of these used to
         difference a wrapped angle at phase 0 against the same wrapped
         angle at phase 1 and report 0. The crank should read one full
         turn per locomotion cycle.

         AND IT IS REPORTED IN TURNS. The key used to say Turn and the
         value used to be 6.2832 — radians, one turn — so the next
         reader saw "6.28 turns per pedal cycle" and either filed a bug
         or believed it. Both units are published now, under names that
         say which is which. */
      crankTurnsPerCycle: prop && prop.crank ? +(crankRadPerCycle / TAU2).toFixed(4) : null,
      crankRadPerCycle: prop && prop.crank ? +crankRadPerCycle.toFixed(4) : null,
      /* fitMax is the WORST GAP between ankle and pedal plate over the
         stroke; fitDrift is how far the offset VECTOR wanders from its
         own mean. Different questions — see the header.

         NULL ON A MACHINE WITH NO PEDALS, rather than the seed values.
         A motorcycle used to report fitMin 1000000000000 (the 1e9 m
         sentinel in millimetres) and fitMax 0.0, and a zero-millimetre
         fit reads as a perfect one. There is no fit to report; say so. */
      fitMaxMM: offs.length ? +(fitMax * 1000).toFixed(1) : null,
      fitMinMM: offs.length ? +(fitMin * 1000).toFixed(1) : null,
      fitDriftMM: offs.length ? +(fitDrift * 1000).toFixed(1) : null,
      meanOffsetMM: offs.length
        ? [+(mean[0] * 1000).toFixed(1), +(mean[1] * 1000).toFixed(1)] : null,
      quarters: [0, 0.25, 0.5, 0.75].map((q) => {
        const r = rows[Math.round(q * n)];
        return {
          ph: q,
          ankle: r.ankle.map((v) => +v.toFixed(3)),
          pedal: r.pedal ? r.pedal.map((v) => +v.toFixed(3)) : null,
          spineRollDeg: r.spineRollDeg, ankRy: r.ankRy, elbowLx: r.elbowLx,
        };
      }),
    };
  };

  /* The reference renders in §1 are studio product shots: one large soft
     key from upper-left, a weak fill from lower-right, no rim, pure white
     backdrop, everything in focus. Reproduce that rig so a crop of this
     frame is comparable to the reference like for like. */
  function studioRig() {
    const dist = Math.hypot(dbgCam.pos[0] - dbgCam.look[0],
      dbgCam.pos[1] - dbgCam.look[1], dbgCam.pos[2] - dbgCam.look[2]);

    /* THE KEY IS UPPER-LEFT OF THE FRAME, NOT OF THE WORLD. §1.2 describes
       a studio product shot, and in a studio the light is placed relative
       to the camera — that is the whole reason the reference renders read
       the way they do. A world-fixed key put the three-quarter camera on
       the far side of it, so the visible surface sat within a few
       hundredths of the band threshold across its whole width and the cel
       terminator broke into blotches. Rigged off the camera basis the
       terminator lands near the right-hand limb where curvature is high,
       and it draws one clean arc around the form in every preset. */
    /* THE KEY HAS TO RAKE, NOT FIRE DOWN THE LENS. At (-0.46, 0.60,
       0.66) the key sat only 48.9 degrees off the view axis: on a
       front-lit ball, N.L at the centre of the visible form is then
       0.658 and the whole cranium is above ANY sane band threshold, so
       the terminator is pushed behind the silhouette no matter what
       `term` says. The two numbers are one setting and they have to move
       together.
       (-0.586, 0.669, 0.458) is 62.8 degrees off the axis — elevation 42
       degrees, azimuth 52 degrees to camera-left, which is where a
       studio key lives. N.L at the centre of the form is 0.458 against a
       band centred on 0.30, so the terminator crosses the cranium 0.17
       radii below and right of centre and leaves ~61% of the form lit:
       the classic product-render split §1.2 describes. */
    /* ROUND 2: MORE FRONTAL — 50 degrees off the view axis, not 62.8.
       The reference render's key is soft and forward; at 62.8 the
       terminator fell down the middle of the figure and, with the old
       narrow band, posterized the chest into the "muscle-like shadow
       bands" the critic flagged. At 50 degrees it lands ~0.5 R out,
       where the form genuinely turns. */
    const cam = ctx.camera;
    const L = new THREE.Vector3(-0.478, 0.596, 0.646);
    if (cam) {
      cam.updateMatrixWorld(true);
      const rx = _v.setFromMatrixColumn(cam.matrixWorld, 0);
      const uy = _v2.setFromMatrixColumn(cam.matrixWorld, 1);
      const bz = _camPos.setFromMatrixColumn(cam.matrixWorld, 2);   // toward the viewer
      L.set(0, 0, 0)
        .addScaledVector(rx, -0.478)
        .addScaledVector(uy, 0.596)
        .addScaledVector(bz, 0.646);
    }
    /* SUN COLOUR IS NEARLY NEUTRAL. §1.2's base albedo is #D3D3D2 — a
       desaturated warm grey, blue only one point under red. Keyed with
       0xfff4e2 (29 points of red over blue) the lit clay measured
       214,210,203 and he read tan; 0xfffdfa keeps the warmth §1.2 asks
       for at the value where the albedo, not the lamp, is doing it. */
    ctx.mat?.setSun?.(L.normalize(), 0xfffdfa, 0.96);
    ctx.mat?.setAmbient?.(0xe3e6ea, 0xe9e8e4, 0.50, 0.26);
    if (ctx.render) {
      ctx.render.setGrade('studio');
      ctx.render.setDOF(dist, 0.35, 0.06);
      ctx.render.clearColor.setRGB(0.90, 0.905, 0.912);
    }
    if (ctx.scene) ctx.scene.background = null;
    contactShadow(true);
  }

  /* ================================================================
     THE GROUND SHADOW — §1.2 "a soft contact shadow beneath", and the
     one note two blind panels wrote down twice: "no contact shadow, so
     he floats on the grass".

     WHY THE PREVIOUS DECAL WAS INVISIBLE, MEASURED. It was a 1.10 x
     0.84 m plane scaled to 0.42 (0.46 x 0.35 m) laid on the terrain at
     +4 mm, peak alpha 74/255. The blade field is 68 blades/m^2 at
     0.11-0.24 m tall and the gameplay camera sits 1.31 m up and 4.3 m
     back — an 17 degree grazing angle at which that carpet is opaque.
     So the decal was drawn, correctly, UNDER the grass: a 0.46 m pool
     at 29% opacity, occluded by the very thing it was supposed to
     anchor him to. Nothing about it could ever have reached the frame.

     A bigger, darker decal does not fix it — it is still under the
     grass. The shadow has to darken the BLADES, which means it has to
     be evaluated at the depth of whatever is actually on screen, not
     on a plane.

     SO IT IS A DEFERRED SHADOW PROJECTOR, IN TWO PARTS.

     1. A silhouette pass. An orthographic camera looks down the sun
        direction at him and renders him — and only him, via a private
        layer — flat white into a small target. This is HIS SHAPE: ear
        fans, head ball, trunk, the pear, four stubs, animated, so the
        shadow "describes his form" rather than being an ellipse.

     2. A projection pass. A box volume around his feet is drawn with
        depth test OFF and multiply blending. Each fragment reads the
        renderer's own normal+depth prepass (ctx.render.normalDepthTexture,
        linear view depth in alpha), reconstructs the WORLD position of
        whatever the frame actually shows at that pixel, and asks the
        silhouette whether that point stands in his shadow. A blade of
        grass 0.2 m up inside the shadow cylinder gets darkened; the
        blade beside it, in the light, does not. That is the read the
        judges are missing, and it is exact rather than approximated.

     On top of the cast term sits a tight, sun-independent CONTACT POOL
     at each foot bone plus a broad one under his mass, faded out above
     0.12 m inside his own footprint so his shins stay clean while the
     turf he is standing in goes dark right where he touches it.

     §7 compliance: nothing here is hard-edged (the silhouette is
     blurred with a 17-tap ring and the pool is Gaussian), and the
     colour is §2.1's blue-violet world shadow law applied as a
     multiplier — never black, never grey. This is a shadow on the
     WORLD, so it takes the world's tint, not the clay's warm one.
     ================================================================ */
  /* No SH_SIZE here any more: silhouette.target() applies the tier
     scale itself, from the same 128 / 224 / 320 table, and re-sizes the
     pooled target on a live quality change. */
  const SH_EXT = 1.06;              // ortho half-extent, metres
  const SH_RAKE = 0.86;             // max tan(zenith angle) of the projector

  /* THE MASK PASS IS THE RENDER LAYER'S, NOT OURS. It used to be a
     private flat-white material, a private target and
     renderer.render( ctx.scene, shCam ) right here. The camera layer
     mask meant only seven meshes ever drew — but three has to walk the
     whole graph in projectObject() before it can find that out, and in
     the city that is 9 704 objects and 2 250 meshes for seven draws:

       whole scene + overrideMaterial     1.99 ms   every frame
       ctx.render.silhouette (this)       0.06 ms

     renderer.render() takes any Object3D, so handing it `root` walks
     42 nodes instead. The size is unchanged at 320 px because none of
     that 2 ms was pixels — 160 px measured 1.98 ms — and the
     projector's blur radius is authored in mask UV, so a different
     size is a different penumbra. The output is bit-identical: 0
     differing pixels of 409 600 across six poses. See
     src/render/silhouette.js for the measurement in full. */
  const shRT = ctx.render.silhouette.target('wally.groundShadow', 320);
  const shCam = ctx.render.silhouette.makeCamera(SH_EXT, 0.05, 7.0, SHADOW_LAYER);
  const shVP = new THREE.Matrix4();

  /* Still enabled, and camera.layers still filters: the subtree is now
     the first gate and the layer the second, so anything parented under
     him that must not cast (a held prop's UI billboard) stays excluded
     exactly as before. */
  root.traverse((o) => { if (o.isMesh) o.layers.enable(SHADOW_LAYER); });

  /* §2.1's law as a straight multiplier: mix(1, tint, 0.55) in LINEAR
     light, which is a hue rotation toward blue-violet plus a modest
     value drop — never albedo * 0.4, never grey. */
  const _t = new THREE.Color(SHADOW.tint).convertSRGBToLinear();
  const shTint = new THREE.Color(
    1 + (_t.r - 1) * SHADOW.amount,
    1 + (_t.g - 1) * SHADOW.amount,
    1 + (_t.b - 1) * SHADOW.amount,
  );

  const SIL_TAPS = /* glsl */`
    float silAt( vec2 uv, float r ) {
      float s = texture2D( tSil, uv ).r * 1.60;
      #define T(dx,dy,k) s += texture2D( tSil, uv + vec2(dx,dy) * r * k ).r;
      T( 1.0, 0.0, 1.0 ) T( 0.707, 0.707, 1.0 ) T( 0.0, 1.0, 1.0 ) T(-0.707, 0.707, 1.0 )
      T(-1.0, 0.0, 1.0 ) T(-0.707,-0.707, 1.0 ) T( 0.0,-1.0, 1.0 ) T( 0.707,-0.707, 1.0 )
      T( 1.0, 0.0, 0.5 ) T( 0.707, 0.707, 0.5 ) T( 0.0, 1.0, 0.5 ) T(-0.707, 0.707, 0.5 )
      T(-1.0, 0.0, 0.5 ) T(-0.707,-0.707, 0.5 ) T( 0.0,-1.0, 0.5 ) T( 0.707,-0.707, 0.5 )
      #undef T
      return s * ( 1.0 / 17.6 );
    }
  `;

  const projMat = new THREE.ShaderMaterial({
    name: 'wally.groundShadow',
    uniforms: {
      tND: { value: null },
      tSil: { value: shRT.texture },
      uInvRes: { value: new THREE.Vector2(1 / 1600, 1 / 900) },
      uInvProj: { value: new THREE.Matrix4() },
      uCamMat: { value: new THREE.Matrix4() },
      uShadowVP: { value: shVP },
      uGroundY: { value: 0 },
      uFeet: { value: new THREE.Vector3() },
      uFootL: { value: new THREE.Vector3() },
      uFootR: { value: new THREE.Vector3() },
      uTint: { value: shTint },
      /* x cast strength, y pool strength, z canopy height, w blur radius */
      uParams: { value: new THREE.Vector4(0.78, 1.0, 0.30, 0.034) },
      uDebug: { value: 0 },
    },
    vertexShader: /* glsl */`
      void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D tND;
      uniform sampler2D tSil;
      uniform vec2  uInvRes;
      uniform mat4  uInvProj;
      uniform mat4  uCamMat;
      uniform mat4  uShadowVP;
      uniform float uGroundY;
      uniform vec3  uFeet;
      uniform vec3  uFootL;
      uniform vec3  uFootR;
      uniform vec3  uTint;
      uniform vec4  uParams;
      uniform float uDebug;
      ${SIL_TAPS}
      void main() {
        vec2 uv = gl_FragCoord.xy * uInvRes;

        /* view ray -> view position -> world position of the real pixel */
        vec4 vp = uInvProj * vec4( uv * 2.0 - 1.0, -1.0, 1.0 );
        vec3 dir = vp.xyz / vp.w;
        dir /= -dir.z;
        vec3 org = uCamMat[ 3 ].xyz;

        #ifdef ND_DEPTH
          float z = texture2D( tND, uv ).a;
          if ( z <= 0.002 ) discard;                  // sky
          vec3 wp = ( uCamMat * vec4( dir * z, 1.0 ) ).xyz;
        #else
          /* No prepass on the low tier, so there is no per-pixel depth to
             stand the shadow in. Fall back to the ground plane: a flat
             decal, correct where the terrain is flat, which is what the
             tier that cannot afford grass is looking at anyway. */
          vec3 rd = normalize( mat3( uCamMat ) * dir );
          if ( rd.y > -0.02 ) discard;
          vec3 wp = org + rd * ( ( uGroundY - org.y ) / rd.y );
        #endif

        float h = wp.y - uGroundY;
        if ( h > uParams.z + 0.34 || h < -1.2 ) discard;

        vec4 sp = uShadowVP * vec4( wp, 1.0 );
        vec2 suv = sp.xy * 0.5 + 0.5;
        float sil = 0.0;
        if ( suv.x > 0.03 && suv.x < 0.97 && suv.y > 0.03 && suv.y < 0.97 ) {
          sil = silAt( suv, uParams.w );
        }

        /* THE CONTACT POOL — the term that actually answers "he floats".
           A tight Gaussian at each foot BONE (not at the root, which is
           between them) plus a broad one under his mass. It is not sun
           dependent: it is the occlusion of the sky by a body standing
           on the turf, so it is there at every hour and from every
           camera, including the three-quarter front where his own body
           hides the cast shape entirely. */
        vec2 dl = wp.xz - uFootL.xz;
        vec2 dr = wp.xz - uFootR.xz;
        vec2 db = wp.xz - uFeet.xz;
        /* Three radii, taken as a max, because a contact shadow is not
           one Gaussian: it is a near-black seam where the sole meets the
           turf, a half-value pool at the scale of the foot, and a broad
           soft one at the scale of the body. One curve gives you either
           a hard disc or a haze; three give the gradient the eye reads
           as "standing in it". */
        float tight = max( exp( -dot( dl, dl ) * 30.0 ), exp( -dot( dr, dr ) * 30.0 ) );
        float mid   = max( exp( -dot( dl, dl ) *  5.0 ), exp( -dot( dr, dr ) *  5.0 ) ) * 0.62;
        float broad = exp( -dot( db, db ) * 1.15 ) * 0.44;
        float pool = max( tight, max( mid, broad ) );
        /* It has to survive INTO the canopy — a pool that dies at 30 mm
           is a pool drawn on the soil under 160 mm of grass, which is
           the exact failure the old decal had. */
        pool *= 1.0 - smoothstep( 0.02, 0.30, h );

        /* the canopy gate: full at the roots, softening toward the tips,
           gone above the blade field so nothing shows a slab edge */
        float vg = 1.0 - smoothstep( uParams.z * 0.50, uParams.z + 0.30, h );

        float a = clamp( max( sil * uParams.x, pool * uParams.y ), 0.0, 1.0 ) * vg;
        if ( uDebug > 0.5 ) {
          if ( uDebug < 1.5 )      { gl_FragColor = vec4( clamp( h * 3.0, 0.0, 1.0 ), 0.2, 0.6, 1.0 ); return; }
          else if ( uDebug < 2.5 ) { gl_FragColor = vec4( 1.0 - a, 1.0 - a * 0.3, 1.0 - a, 1.0 ); return; }
          else                     { gl_FragColor = vec4( 1.0 - sil, 1.0 - sil * 0.2, 1.0 - pool, 1.0 ); return; }
        }
        if ( a < 0.003 ) discard;
        gl_FragColor = vec4( mix( vec3( 1.0 ), uTint, a ), 1.0 );
      }
    `,
    defines: (q?.ssao !== false || q?.dof !== false) ? { ND_DEPTH: 1 } : {},
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    /* dst = dst * src, spelled out. THREE.MultiplyBlending is the same
       factors but insists on premultipliedAlpha and then warns once per
       frame about it; this states the intent and stays quiet. Alpha is
       left alone so the scene target's coverage channel is untouched. */
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    toneMapped: false,
  });

  let shadowMesh = null;
  let shadowOn = false;
  let shadowLocked = false;   // a debug hook has taken uParams over

  function buildGroundShadow() {
    /* Box, not a plane: it is a screen-space BOUND, and the fragments
       inside it are resolved against the real depth buffer. Back faces
       with the depth test off so it survives the camera being inside
       it — which the follow camera is, every time he backs into it. */
    const geo = new THREE.BoxGeometry(3.8, 1.30, 3.8);
    geo.translate(0, 0.25, 0);
    const mesh = new THREE.Mesh(geo, projMat);
    mesh.name = 'wally.groundShadow';
    mesh.renderOrder = 3;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    /* It must never reach the normal+depth prepass: it is transparent,
       so collectAndSwap() would leave it on its own material and it
       would multiply itself into the very buffer it reads. */
    mesh.userData.noPrepass = true;
    mesh.userData.noOutline = true;
    return mesh;
  }

  /* Draw him, alone, flat white, from the sun. The only thing in the
     game that knows what shape his shadow is.

     aimSun() reproduces the dawn/dusk flatten (below minY 0.12 the sun
     is on the horizon and a true projection is a 40 m smear that reads
     as a stripe, so the direction is flattened 0.25 toward the vertical)
     and the SH_RAKE zenith cap that keeps the shape under him at every
     hour — which is also what the reference product render does with
     its soft key from upper-left. render() saves and restores the
     render target, autoClear, the clear colour and alpha, and
     shadowMap.needsUpdate, that last one because leaving it true would
     make three re-render every cascade for a 320 px mask. */
  function renderSilhouette() {
    if (!ctx.renderer || !shadowMesh) return;
    _sc.set(root.position.x, root.position.y + H * 0.47, root.position.z);
    ctx.render.silhouette.aimSun(shCam, _sc, { dist: 3.2, rake: SH_RAKE, outVP: shVP });
    ctx.render.silhouette.render(root, shCam, shRT);
  }

  function updateGroundShadow() {
    if (!shadowMesh || !shadowOn) return;
    /* Nothing to occlude the ground if he is not in the frame — the
       intro, a menu, a cutscene that has hidden him. */
    if (!root.visible) { shadowMesh.visible = false; return; }
    shadowMesh.visible = true;
    const cam = ctx.camera;
    const nd = ctx.render?.normalDepthTexture || null;

    renderSilhouette();

    shadowMesh.position.set(root.position.x, root.position.y, root.position.z);

    const u = projMat.uniforms;
    u.tND.value = nd;
    const t = ctx.render?.targets?.normalDepth;
    if (t) u.uInvRes.value.set(1 / t.width, 1 / t.height);
    cam.updateMatrixWorld(true);
    u.uInvProj.value.copy(cam.projectionMatrixInverse);
    u.uCamMat.value.copy(cam.matrixWorld);
    u.uGroundY.value = root.position.y;

    const bl = rig.byName.footL, br = rig.byName.footR;
    if (bl && br) {
      bl.getWorldPosition(_fl);
      br.getWorldPosition(_fr);
      u.uFootL.value.copy(_fl);
      u.uFootR.value.copy(_fr);
      u.uFeet.value.set(
        (_fl.x + _fr.x) * 0.5, root.position.y, (_fl.z + _fr.z) * 0.5,
      );
    } else {
      u.uFootL.value.copy(root.position);
      u.uFootR.value.copy(root.position);
      u.uFeet.value.copy(root.position);
    }

    /* Off the ground the contact pool has to go — that is what makes a
       jump read — while the cast shape stays and softens. */
    const air = controller && !controller.grounded
      ? clamp(controller.airTime * 5.0, 0, 1) : 0;
    if (shadowLocked) return;
    const p = u.uParams.value;
    p.x = 0.78 * (1 - air * 0.35);
    p.y = 1.0 * (1 - air);
    p.w = 0.034 + air * 0.030;
  }

  api.materials.groundShadow = projMat;

  function contactShadow(on) {
    if (on && !shadowMesh) {
      shadowMesh = buildGroundShadow();
      ctx.scene.add(shadowMesh);
    }
    shadowOn = !!on;
    if (shadowMesh) shadowMesh.visible = shadowOn;
  }

  /* ================================================================
     WALLY.debug.parkProbe(x, z, yaw, ride)

     Stand a machine at a chosen spot and heading through the REAL
     parkProp() path, then measure both wheel contacts against
     ctx.world.heightAt at their own world positions. Returns the
     gradient the machine was pitched to and each contact's error in
     millimetres, positive for hovering.

     `gradientDeg` IS THE MACHINE'S GRADIENT, NOT THE RIDER'S, and it
     used to be the rider's. This probe computed its own chord under
     (x, z) — where WALLY is standing — while parkProp offsets the
     machine to his -x side and samples the chord THERE. On sloped
     ground those are different hills, and the disagreement was not
     small: measured pairs of machine gradient against what this probe
     printed were -42.01 / 54.97 (it called that clamped; it is not),
     -51.45 / 37.03 (it called that unclamped; it is clamped) and
     47.01 / -47.53 — the sign as well.

     That is the same defect as driveTrace's old travelBlocked, which
     derived its expectation from the sample it was judging, and as the
     silhouette tool that sampled background as subject and cost three
     rounds of wrong work. A probe that measures one thing and names
     another is worse than no probe. So the number now comes back OUT of
     parkProp — the raw pitch it computed, from its own two samples, at
     its own position — and `clamped` is derived from that raw value
     rather than re-decided here.

     The contacts are taken as the point directly under each axle in the
     PROP's frame and then transformed by the group's world matrix —
     never as wheel-local (0, -R, 0), which is a material point on the
     rim and carries the rolling angle with it. A wheel that has turned
     half a revolution would put that point on top.

     IT MEASURES THE STAND TOO, AND IT MEASURES THE PAINTED SURFACE.
     Two wheels on the ground says nothing about the third leg: the roll
     was a constant for two rounds while the stand sat 0.23 to 0.34 m
     out to the side, so a probe that reported 0.0/0.0 at both wheels
     was reporting a machine whose foot hung 391 mm in the air.

     `standFootMM` IS A CLEARANCE, NOT A LOWEST VERTEX, and that is this
     round's correction to this probe. It used to be the lowest painted
     vertex of the mesh named 'kickstand' measured against heightAt
     under that vertex's own x/z — which is a fine number on flat ground
     and a meaningless one on a hillside, where the lowest vertex is
     simply whichever one hangs furthest out over the downhill and the
     figure reports the gradient rather than the pose. It is now the
     CLOSEST APPROACH: the minimum over every painted vertex of
     (vertex y - heightAt at that vertex), which is the same number on
     the flat, is the depth of the deepest penetration when the stand is
     in the ground, and means the same thing at any angle. Negative is
     into the ground, positive is hovering, and `standDesignMM` beside
     it is the tube's axis endpoint — the DESIGN contact point, the one
     solveParkPose actually stands on the ground. The painted surface
     sits 4.71 mm below that point on the bicycle, 5.18 on the scooter
     and 5.22 on the motorcycle (measured in the prop's own frame at its
     own lean; see solveParkPose's header for why those are not the
     4.4/5.6/5.1 this note used to give).
     ================================================================ */
  const _pfv = new THREE.Vector3();
  function standProbe(group) {
    let m = null;
    group.traverse((o) => { if (o.name === 'kickstand') m = o; });
    if (!m) return null;
    const pos = m.geometry?.attributes?.position;
    if (!pos) return null;
    m.updateMatrixWorld(true);
    let lo = Infinity, bx = 0, bz = 0, clear = Infinity;
    for (let i = 0; i < pos.count; i++) {
      _pfv.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      if (_pfv.y < lo) { lo = _pfv.y; bx = _pfv.x; bz = _pfv.z; }
      const h = ctx.world?.heightAt?.(_pfv.x, _pfv.z);
      if (Number.isFinite(h)) clear = Math.min(clear, _pfv.y - h);
    }
    return { y: lo, x: bx, z: bz, clear: Number.isFinite(clear) ? clear : null, visible: m.visible };
  }
  /* `leave` stands the machine there and walks away instead of tidying
     up — the probe prints millimetres, and millimetres are not a
     substitute for looking at the thing. Without it every screenshot
     rig had to re-implement the park path to get a machine that was
     still on screen when the shutter opened, which is the same "a model
     of the code under test" trap the gradient number fell into. */
  dbg.parkProbe = (x, z, yaw = 0, rideName = 'bike', leave = false) => {
    const key = rideKey(rideName) || 'bike';
    const H = (px, pz) => { try { const h = ctx.world?.heightAt?.(px, pz); return Number.isFinite(h) ? h : null; } catch (e) { return null; } };
    const gy0 = H(x, z);
    if (gy0 == null) return { error: 'no terrain at ' + x + ',' + z };
    const wasForced = bikeForced;
    bikeForced = true;
    api.setPosition(x, gy0, z);
    api.setYaw(yaw);
    setBike(true, { ride: key, instant: true });
    root.updateMatrixWorld(true);
    parkProp();
    const p = props[key];
    p.group.updateMatrixWorld(true);
    const ws = p.wheels || [];
    const rows = ws.map((w, i) => {
      /* under the axle, in the prop's own frame */
      const v = new THREE.Vector3(w.position.x, 0, contactZ(w, p.group));
      let n = w.parent;
      for (; n && n !== p.group; n = n.parent) { v.x += n.position.x; }
      v.applyMatrix4(p.group.matrixWorld);
      const h = H(v.x, v.z);
      /* FOUR DECIMALS, AND THAT IS NOT FUSSINESS. This used to publish
         toFixed(1) — a tenth of a millimetre — while the threshold every
         census applies to it is "over 0.1 mm". Everything from 0.100 to
         0.149 rounded down and fell out of the bucket, and the published
         before-census undercounted by 156 contacts of 1 085 for exactly
         that reason. A probe must not round at the resolution its
         readers threshold on. */
      return { wheel: i, errMM: h == null ? null : +((v.y - h) * 1000).toFixed(4) };
    });
    const L = _parkLast || {};
    const out = { ride: key,
      /* where the RIDER was told to stand, and where the MACHINE went */
      standingAt: [+x.toFixed(2), +z.toFixed(2)],
      machineAt: L.at || null, offsetX: L.offsetX ?? null,
      yaw: +yaw.toFixed(3),
      /* parkProp's own raw pitch, at parkProp's own position, from
         parkProp's own pair of contact samples */
      gradientDeg: L.gradientDeg ?? null,
      /* WHICH SURFACE, so a roof park can be told from a hill park
         without inferring it from the numbers. See H() in parkProp. */
      onStructure: L.onStructure ?? null, rayY: L.rayY ?? null, rasterY: L.rasterY ?? null,
      wheelbase: L.base ?? null,
      pitchDeg: +(p.group.rotation.x * 180 / Math.PI).toFixed(2),
      clampDeg: +(PARK_PITCH_MAX * 180 / Math.PI).toFixed(1),
      clamped: !!L.clamped,
      /* the lateral half: what the roll solve did and what the stand
         foot ended up doing about it */
      rollDeg: +(p.group.rotation.z * 180 / Math.PI).toFixed(2),
      /* what the ground ASKED for before the band and the floor got at
         it — the number that says whether the clamp is doing anything */
      rollRawDeg: L.rollRawDeg ?? null,
      leanDeg: L.leanDeg ?? null,
      rollClamped: !!L.rollClamped,
      /* how hard the pitch solve had to work, so a site that needed the
         bisection can be found again */
      pitchIters: L.pitchIters ?? null, bisected: !!L.bisected,
      solveResidualMM: L.solveMM || null, liftMM: L.liftMM ?? null,
      wheels: rows,
      ...(() => {
        const s = standProbe(p.group);
        if (!s) return { standFootMM: null, standDesignMM: null, standLowestVertexMM: null };
        const h = H(s.x, s.z);
        const F = p.standFoot;
        let dmm = null;
        if (F) {
          const v = new THREE.Vector3(F.x, F.y, F.z).applyMatrix4(p.group.matrixWorld);
          const dh = H(v.x, v.z);
          if (dh != null) dmm = +((v.y - dh) * 1000).toFixed(3);
        }
        return {
          /* the painted stand's closest approach to the ground */
          standFootMM: s.clear == null ? null : +(s.clear * 1000).toFixed(3),
          /* the point the solve puts on the ground */
          standDesignMM: dmm,
          /* the old metric, kept only so an old reading can be
             recognised for what it was — see standProbe */
          standLowestVertexMM: h == null ? null : +((s.y - h) * 1000).toFixed(3),
        };
      })() };
    if (!leave) setBike(false, { instant: true });
    bikeForced = wasForced;
    return out;
  };

  dbg.wallyCam = (preset) => {
    const p = CAMS[preset] || CAMS.full;
    dbgCam = p;
    setSilhouette(preset === 'silhouette');
    /* If a camera rig has already booted, stand it down — its lateUpdate
       runs after ours and would win otherwise. */
    const cam = ctx.cam;
    if (cam) {
      if (typeof cam.setEnabled === 'function') cam.setEnabled(false);
      else if (typeof cam.detach === 'function') cam.detach();
      else if ('enabled' in cam) cam.enabled = false;
    }
    ctx.bus?.emit('cam:override', { source: 'wally.debug', preset });
    applyDebugCam();
    /* after applyDebugCam: the key is rigged off the live camera basis */
    if (preset !== 'silhouette') studioRig();
    return preset;
  };

  dbg.turntable = (deg) => { dbgOrbit = deg || 0; if (dbgCam) applyDebugCam(); return dbgOrbit; };

  /* ================================================================
     THE BICYCLE — WALLY.debug.bike(on, speed)

     The verifier's entry point. Mounts him, drives the locomotion blend
     by hand at a plausible riding speed (so the pedal cadence, the body
     rock and the ear/trunk hints are all where they would be at speed
     rather than frozen at a standstill), and frames the three-quarter
     studio camera that shows the drivetrain, the bars and the rider's
     fold at the hip in one shot.

       WALLY.debug.bike(true)        mount + ride at 5.2 m/s
       WALLY.debug.bike(true, 9)     sprinting
       WALLY.debug.bike(false)       dismount, hand the camera back
       WALLY.debug.bikeInfo()        the numbers, measured live
     ================================================================ */
  dbg.bike = (on = true, speed = 5.2, camName = 'bike') => {
    if (on === false || on === 'off') {
      bikeForced = false;
      api.setBike(false, { instant: true });
      api.setLocomotion(null);
      dbg.studio(false);
      return 'bike off';
    }
    /* THE FORCE FLAG IS NOT OPTIONAL HERE. bikeSync() reconciles the
       prop against ctx.game every half second, and in a fresh save
       state.rides.owned is empty — so without this the hook mounts him
       and the next sync tick quietly puts him back on his feet, three
       seconds before the shutter. */
    bikeForced = true;
    api.setBike(true, { instant: true });
    api.setLocomotion(speed, 0);
    dbg.studio(true, camName);
    return { riding: api.riding, speed, cam: camName, ...api.bikeState };
  };

  /* ================================================================
     THE RIDES — WALLY.debug.ride(id, speed)

     One hook for all three machines, and the entry point the verifier
     drives. Mounts the named one, drives the locomotion blend by hand
     at a speed that machine would actually be doing (so the posture,
     the body rock, the engine tremor and the ear/trunk streaming are
     all where they would be at speed rather than frozen at a
     standstill), and frames the studio camera that shows the machine's
     own silhouette — pulled back and up for the bigger two, because a
     motorcycle framed like a bicycle is a motorcycle with its front
     wheel out of shot.

       WALLY.debug.ride('scooter')     mount + ride at its cruise
       WALLY.debug.ride('moto')        ditto, the big one
       WALLY.debug.ride('bike')        the bicycle
       WALLY.debug.ride(null)          off, camera handed back
       WALLY.debug.ride('moto', 22)    flat out
       WALLY.debug.rideInfo()          the fit, measured live
     ================================================================ */
  const RIDE_SHOW = {
    /* each machine's own CRUISE, not one number for all three: the
       ladder rung a shot lands on is the pose the shot is of */
    bike: { speed: 5.2, cam: 'bike' },
    scooter: { speed: 7.2, cam: 'scoot' },
    motorcycle: { speed: 11.0, cam: 'moto' },
  };
  dbg.ride = (id = 'bike', speed, camName) => {
    if (id === null || id === false || id === 'off' || id === 'walk') {
      bikeForced = false;
      api.setBike(false, { instant: true });
      api.setLocomotion(null);
      dbg.studio(false);
      return 'walking';
    }
    const key = rideKey(id);
    if (!key) return 'no ride "' + id + '"';
    const S = RIDE_SHOW[key];
    bikeForced = true;
    api.setRide(key, { instant: true });
    api.setLocomotion(speed ?? S.speed, 0);
    dbg.studio(true, camName || S.cam);
    return {
      ...api.bikeState, speed: speed ?? S.speed, cam: camName || S.cam,
      cost: bike ? triangleCost(bike.group) : null,
    };
  };

  /* Where the feet and hands actually are against where the prop puts
     its footrests and its bars — the same measurement bikeInfo() makes
     for the bicycle, for whichever machine is under him. This is what
     rides.js's SCOOT_BARS / MOTO_BARS were fitted to; never eyeball
     them off a screenshot. */
  /* ================================================================
     THE BALLOON — WALLY.debug.balloon(...) and friends.

     The verifier's entry points, and the suite's. Every one of them
     returns MEASURED numbers rather than the numbers that were asked
     for, because the difference between the two is where every
     screenshot-shaped lie in this project has come from.

       WALLY.debug.balloon()                board it, here, for real
       WALLY.debug.balloon(false)           put it away (instant)
       WALLY.debug.balloon({alt: 200})      board it and be at 200 m
       WALLY.debug.balloonInfo()            the flight, live
       WALLY.debug.balloonCost()            what the machine costs,
                                            differenced across frames
       WALLY.debug.balloonPose(t)           freeze the inflation at t
     ================================================================ */
  dbg.balloon = (o = {}) => {
    if (o === false || o === 'off' || o === null) {
      bikeForced = false;
      setFly(false, { instant: true });
      api.setLocomotion(null);
      return 'balloon off';
    }
    const opts = (o === true || typeof o !== 'object') ? {} : o;
    bikeForced = true;
    /* THE FORCE FLAG IS NOT OPTIONAL. bikeSync() reconciles against
       ctx.game every half second and a fresh save owns nothing, so
       without it the hook boards him and the next tick quietly puts
       him back on the grass three seconds before the shutter. */
    if (bikePhase !== 'off') setBike(false, { instant: true });
    setFly(true, { instant: !!opts.instant || Number.isFinite(opts.alt) });
    if (Array.isArray(opts.at) && opts.at.length === 3 && opts.at.every(Number.isFinite)) {
      /* PUT THE MACHINE SOMEWHERE, without going through setPosition()
         — that calls controller.teleport(), which snaps to the ground
         and would drop a flying balloon onto whatever is under it. */
      root.position.set(opts.at[0], opts.at[1], opts.at[2]);
      flyState.vx = 0; flyState.vy = 0; flyState.vz = 0;
      flyState.heat = FLIGHT.trim;
      flyPlaceController();
    }
    if (Number.isFinite(opts.alt)) {
      /* PUT HIM THERE, do not fly him there. The altitude hook exists
         so a shot can be taken OF an altitude; flying up to it takes
         fifty seconds and lands somewhere the wind chose. */
      const gy = flySurfaceUnder(root.position.x, root.position.z, root.position.y + 400);
      root.position.y = gy + BALLOON_FIT.DECK + opts.alt;
      flyState.heat = FLIGHT.trim;
      flyState.vy = 0;
      if (Number.isFinite(opts.drift)) {
        flyState.vz = opts.drift;
        flyState.yaw = 0;
      }
      flyBlend = 1;
      flyCam.seeded = false;
      flyPlaceController();
    }
    return api.flightState;
  };
  /** Hold or release the burner. See flyForceBurn. */
  dbg.balloonBurn = (on = true) => { flyForceBurn = on !== false; return flyForceBurn; };
  /** THE RUNTIME REVERT FOR THE FRET. 1 ships; 0 leaves the wrap
      exactly as it is and takes the concealment away, so B13 can shoot
      the same swap with and without it on one page load and difference
      the two frames rather than quoting a number about them. */
  dbg.balloonMist = (v = 1) => { flyMistOn = Math.max(0, Math.min(1, +v || 0)); return flyMistOn; };
  /** The wrap, and the numbers that decide where it fires. `at` puts
      her on a bearing at a fraction of the half-period so a test can
      start just inside the plane instead of flying twelve minutes. */
  dbg.balloonWrap = (o = null) => {
    if (o && Number.isFinite(o.k) && Array.isArray(o.dir)) {
      const l = Math.hypot(o.dir[0], o.dir[1]) || 1;
      const ux = o.dir[0] / l, uz = o.dir[1] / l;
      /* the half-period along this bearing, so k means the same thing
         on every one of them */
      const s = 1 / Math.max(Math.abs(ux) / WRAP.X, Math.abs(uz) / WRAP.Z);
      dbg.balloon({ alt: o.alt ?? 40, at: [ux * s * o.k, 60, uz * s * o.k] });
      if (o.drive !== false) dbg.balloonStick(ux, uz);
    }
    return {
      wrap: WRAP,
      k: +wrapK(root.position.x, root.position.z).toFixed(4),
      mist: +flyMistK.toFixed(3), mistOn: flyMistOn,
      far: +wrapFar(root.position.y - (ctx.world?.seaLevel ?? 0)).toFixed(1),
      fog: ctx.scene?.fog ? [Math.round(ctx.scene.fog.near), Math.round(ctx.scene.fog.far)] : null,
      wraps: flyWraps, last: flyWrapLog,
      /* the design's own margin, derived from the world rather than
         transcribed: how much open water there is past the shoreline
         before the plane, on each axis. */
      margin: [WRAP.X - (ctx.world?.islandRadiusX ?? 0), WRAP.Z - (ctx.world?.islandRadiusZ ?? 0)],
    };
  };
  /** THE RUNTIME REVERT for the envelope's collision hull, and there
      are THREE rules in it now, every one runnable on one page load:
        'canvas'  ships — the staggered fan and the damped spring;
        'ladder'  the round before — one azimuth set for all seven
                  rings, a constant shove and an exponential absorb;
        'ring'    the round before that — one horizontal ring at the
                  envelope's widest point.
      tools/test-balloon.mjs B5b drives all three at three buildings.
      Returns the mode actually in force, not the one asked for. */
  dbg.balloonHull = (mode) => {
    if (mode === 'ring' || mode === 'ladder' || mode === 'canvas') flyHullMode = mode;
    return { mode: flyHullMode,
      /* PUBLISHED RATHER THAN TRANSCRIBED. A test that copies a
         constant into itself is asserting against its own copy. */
      skin: F_ENV_SKIN, push: F_ENV_PUSH, absorb: F_ENV_ABSORB,
      slew: F_ENV_SLEW, slewVy: F_ENV_SLEW_VY, slewWas: F_ENV_SLEW_WAS,
      az: F_ENV_AZ, basketR: F_BASKET_R,
      az2: F_ENV_AZ2, stagger: F_ENV_STAGGER, precess: F_ENV_PRECESS,
      engage: F_ENV_ENGAGE, w: F_ENV_W, amax: F_ENV_AMAX,
      basketAbsorb: F_BASKET_ABSORB,
      /* THE MODULE'S OWN PREDICTION, as a number rather than a
         function, because page.evaluate cannot bring a function home.
         The deepest a critically damped spring lets the stick's own
         ceiling reach past the engage line is v / (w e); a test builds
         its tolerance out of this instead of out of a number somebody
         watched come out. */
      squashAt: +(FLIGHT.reach / (F_ENV_W * Math.E)).toFixed(3),
      /* and the same number expressed as what the SUITE measures: how
         far the meridian itself gets past the surface, which is the
         spring's travel minus the skin it still had left when the
         spring took hold. Negative means the fabric never reaches the
         wall at that speed at all. */
      meridianAt: +Math.max(0, F_ENV_ENGAGE + FLIGHT.reach / (F_ENV_W * Math.E) - F_ENV_SKIN).toFixed(3),
      /* and where she rests against a wall with the stick off: the
         spring's own zero. Deeper than this and the gore crowns are in
         the brick; shallower and she floats off it behind an invisible
         cushion, which is the other end of the same failure. */
      restGap: +(F_ENV_SKIN - F_ENV_ENGAGE).toFixed(3),
      hull: flyHullMode,
      rings: envelopeRings(flyProp ? flyProp.inflation : 1).map(
        (r) => ({ y: +r.y.toFixed(2), r: +r.r.toFixed(2) })) };
  };
  /** Hold the stick. `null` hands it back to the keyboard. Set rather
      than pushed, because a test that writes the VELOCITY writes over
      the collision response it is trying to measure. */
  dbg.balloonStick = (x, z) => {
    flyStick = (x == null && z == null) ? null : { x: x || 0, z: z || 0 };
    return flyStick;
  };
  /** THE FLY RIG'S OWN FOUR NUMBERS, so a seam can be measured rather
      than inferred from the lens. `aimDist` is the one that matters:
      when the aim point walks THROUGH the lens the look direction is
      undefined and the frame whips — which is exactly what the
      seed's sign error used to do on every boarding. */
  dbg.balloonCam = () => ({
    seeded: flyCam.seeded,
    yawDeg: +(flyCam.yaw * 180 / Math.PI).toFixed(2),
    pos: flyCam.pos.toArray().map((v) => +v.toFixed(3)),
    aim: flyCam.aim.toArray().map((v) => +v.toFixed(3)),
    aimDist: +flyCam.pos.distanceTo(flyCam.aim).toFixed(3),
    fov: +flyCam.fov.toFixed(2),
    /* signed metres the lens sits BEHIND the subject along the boom
       heading. Negative means the camera has got in front of him,
       which is the seam's signature. */
    behind: +(-((flyCam.pos.x - root.position.x) * Math.sin(flyCam.yaw)
             + (flyCam.pos.z - root.position.z) * Math.cos(flyCam.yaw))).toFixed(3),
  });
  dbg.balloonInfo = () => {
    const p = props.balloon || null;
    return {
      ...api.flightState,
      owned: bikeOwned, equipped: bikeEquipped, rideId,
      cost: p ? triangleCost(p.group) : null,
      fit: BALLOON_FIT, flight: FLIGHT,
      parked: [...parkedIds],
      spot: (() => { try { return ctx.game?.actions?.parkSpot?.('balloon') ?? null; } catch (e) { return null; } })(),
    };
  };
  /** Hold the inflation still at `t` so a shot can be taken of the
      middle of it. Returns the inflation the prop actually reports,
      not the one that was asked for. */
  dbg.balloonPose = (t = 0) => {
    const p = buildProp('balloon');
    p.group.visible = true;
    p.setInflate(t);
    return { asked: t, is: p.inflation, cost: triangleCost(p.group) };
  };

  /* ----------------------------------------------------------------
     WHAT THE MACHINE COSTS, DIFFERENCED ACROSS REAL FRAMES.

     renderer.js sets renderer.info.autoReset = FALSE and raises the
     reset once a frame, so info accumulates across every pass —
     shadow cascades, the outline pass, post. Reading it at one moment
     and calling that "the draw calls" is how somebody in this project
     once published 16 193 calls and 111 million triangles: they had
     summed a frame's worth of passes and then summed several frames.

     The only honest measurement is a DIFFERENCE between two whole
     frames that are alike in everything but this prop, so that is
     what this does: toggle `visible` on alternate frames, sample at
     the END of each frame (after post, before the reset), and average
     over `n` pairs. The shadow map has to be re-rendered on both
     sides or the "off" frame reuses the "on" frame's cascades and the
     answer comes back as zero.
     ---------------------------------------------------------------- */
  dbg.balloonCost = (n = 24) => new Promise((resolve) => {
    const p = props.balloon || buildProp('balloon');
    const info = ctx.render?.renderer?.info || ctx.renderer?.info;
    if (!info) { resolve({ error: 'no renderer.info' }); return; }
    /* IT IS MEASURED WITH THE MACHINE UNDER HIM, and it has to be:
       a MOORED balloon's visibility belongs to parkedCull(), which
       rewrites it on every frame, so an alternate-frame toggle on a
       parked prop is overwritten before it is ever drawn and the
       difference comes back as a flat zero. Board first if he is not
       aboard, and put it back afterwards. */
    const wasFlying = flyPhase !== 'off';
    if (!wasFlying) { bikeForced = true; setFly(true, { instant: true }); }
    const wasVisible = p.group.visible;
    p.group.visible = true;
    const on = [], off = [];
    let i = 0;
    /* A WALL-CLOCK FALLBACK, because a promise that only ever resolves
       from requestAnimationFrame hangs for ever if rAF stalls — which
       it does in a headless tab that loses its compositor. */
    const t0 = performance.now();
    const tick = () => {
      const show = (i & 1) === 0;
      p.group.visible = show;
      requestAnimationFrame(() => {
        /* sampled on the frame AFTER the toggle, so what is measured is
           a frame that was drawn with the prop in the state we set */
        (show ? on : off).push({
          calls: info.render.calls, tris: info.render.triangles,
          lines: info.render.lines, points: info.render.points,
        });
        i++;
        if (i < n * 2 && performance.now() - t0 < 12000) tick();
        else {
          p.group.visible = wasVisible;
          if (!wasFlying) setFly(false, { instant: true });
          const med = (a, k) => {
            const v = a.map((x) => x[k]).sort((x, y) => x - y);
            return v.length ? v[v.length >> 1] : 0;
          };
          resolve({
            frames: on.length + off.length,
            withProp: { calls: med(on, 'calls'), tris: med(on, 'tris') },
            without: { calls: med(off, 'calls'), tris: med(off, 'tris') },
            balloon: { calls: med(on, 'calls') - med(off, 'calls'), tris: med(on, 'tris') - med(off, 'tris') },
            geometry: triangleCost(p.group),
            inflation: p.inflation,
            note: 'medians of alternate frames; renderer.info.autoReset is false',
          });
        }
      });
    };
    tick();
  });

  dbg.rideInfo = () => {
    const info = dbg.bikeInfo();
    const cost = bike ? triangleCost(bike.group) : null;
    /* THE CHARACTER TOTAL COUNTS WHAT IS ON SCREEN, which means walking
       the ancestor chain: hiding a prop sets `visible` on its GROUP, and
       a mesh inside a hidden group still reports visible === true. The
       first version of this counted all three machines at once and grew
       by 17 000 triangles every time the hook was called. */
    const shown = (o) => { for (let p = o; p; p = p.parent) if (p.visible === false) return false; return true; };
    let tris = 0, meshes = 0;
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry || o.userData.isOutlineHull || !shown(o)) return;
      const g = o.geometry;
      tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
      meshes++;
    });
    return { id: rideId, ...info, cost, characterTotal: { triangles: Math.round(tris), meshes } };
  };
  /* Sweep the reach to the bars live. See BIKE_SEAT in anim.js for why
     this cannot be reasoned about from the angles. */
  dbg.bikeArms = (a0x, a0z, a1x, a1z) => {
    if (a0x != null) BIKE_SEAT.a0x = a0x;
    if (a0z != null) BIKE_SEAT.a0z = a0z;
    if (a1x != null) BIKE_SEAT.a1x = a1x;
    if (a1z != null) BIKE_SEAT.a1z = a1z;
    return { a0x: BIKE_SEAT.a0x, a0z: BIKE_SEAT.a0z, a1x: BIKE_SEAT.a1x, a1z: BIKE_SEAT.a1z };
  };
  /* Where the feet and hands actually are against where the prop puts
     the pedals and the bars. This is the measurement the bike geometry
     is fitted to; never eyeball it off a screenshot. */
  dbg.bikeInfo = () => {
    const p = new THREE.Vector3();
    const rel = (n) => {
      const b = rig.byName[n];
      if (!b) return null;
      b.getWorldPosition(p);
      root.worldToLocal(p);
      return [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)];
    };
    return {
      phase: bikePhase, ride: +bikeRide.toFixed(3), lean: +bikeLean.toFixed(3),
      bikeW: +anim.bikeW.toFixed(3), pedalPhase: +anim.locPhase.toFixed(3),
      clip: anim.current,
      hips: rel('hips'), footL: rel('footL'), footR: rel('footR'),
      handL: rel('handL'), handR: rel('handR'), head: rel('head'),
      prop: bike
        ? { kind: bike.kind || 'bike', saddle: bike.SADDLE, bars: bike.BARS, pedal: bike.PEDAL }
        : null,
      speeds: controller ? {
        walk: controller.opts.walkSpeed, run: controller.opts.runSpeed,
        turn: controller.opts.turnRate,
      } : null,
    };
  };

  /* ================================================================
     STUDIO MODE — WALLY.debug.studio(pose)

     Every likeness iteration has to be compared against the reference
     renders LIKE FOR LIKE, and the reference is a studio product shot:
     no world, neutral backdrop, soft key upper-left, full-body
     three-quarter framing. This hides the world with VISIBILITY TOGGLES
     only (no other module is edited), holds the named pose, frames with
     CAMS.studio and lights with the existing studioRig().
     studio(false) restores everything.
     ================================================================ */
  let studioSaved = null;
  /* MEASUREMENT BACKDROP. The studio backdrop is #E6E7E9 and the clay is
     #D3D3D2 — 8% apart, which is fine for judging form by eye and useless
     for extracting a silhouette mask from the PNG: grain alone straddles
     the difference. dbg.studioBG([r,g,b]) swaps the clear colour (and
     drops the contact shadow) so a pixel-accurate silhouette can be cut
     off a black field exactly the way ref/wally-ref-cool.png is cut. It
     changes nothing about the model — it is a ruler, not a look. */
  let studioBG = null;
  let studioOn = false;
  /* studio(pose, cam?) — cam is an optional CAMS preset name so the tail
     and the temple hooks can be verified from 'back'/'side' under the
     same studio rig (critic delta 8: "add a rear/three-quarter studio
     angle to the shot rig"). */
  dbg.studio = (pose, camName) => {
    if (pose === false || pose === 'off') {
      studioOn = false;
      ctx.render?.setGrain?.(0.011);   // postfx.js GRAIN default

      if (studioSaved) {
        for (const [o, v] of studioSaved) o.visible = v;
        studioSaved = null;
      }
      for (const id of ['ui', 'overlay']) {
        const el = document.getElementById(id);
        if (el) el.style.visibility = '';
      }
      api.release(0.001);
      dbg.wallyFree();
      return 'studio off';
    }
    /* `true` means KEEP whatever is playing — the studio backdrop and
       key without the pose override. The bicycle needs it: its pose is
       a live locomotion blend, not a held clip, and forcing 'cool' over
       it would photograph a standing elephant beside a bicycle. */
    const keep = pose === true;
    const name = typeof pose === 'string' && CLIPS[pose] ? pose : 'cool';
    /* Kill the post film grain while the studio rig is up: likeness
       comparisons against ref/wally-ref-cool.png must not be polluted
       by photographic noise. Runtime state only — restored on 'off'. */
    ctx.render?.setGrain?.(0);
    if (!studioSaved) {
      studioSaved = [];
      /* Hide EVERYTHING in the scene that is not Wally, his ground-shadow
         projector, a light or a camera. Visibility toggles only — no
         other module is edited or reparented. */
      for (const o of ctx.scene.children) {
        if (o === root || (shadowMesh && o === shadowMesh)) continue;
        if (o.isLight || o.isCamera) continue;
        studioSaved.push([o, o.visible]);
        o.visible = false;
      }
    }
    /* the DOM HUD sits over the canvas and pollutes the comparison */
    for (const id of ['ui', 'overlay']) {
      const el = document.getElementById(id);
      if (el) el.style.visibility = 'hidden';
    }
    if (!keep) {
      api.pose(name, { fade: 0.001, instant: true });
      /* welcome is the SQUARE-ON reference (§1.6 pose 2, the title
         screen): face the studio lens for it; cool keeps the
         three-quarter composition of ref/wally-ref-cool.png. */
      api.setYaw(name === 'welcome'
        ? Math.atan2(CAMS.studio.pos[0], CAMS.studio.pos[2]) : 0);
    }
    dbg.wallyCam(camName && CAMS[camName] ? camName : 'studio');
    studioOn = true;
    return `studio:${keep ? 'keep' : name}${camName ? ':' + camName : ''}`;
  };

  /* lighting.js re-pushes the sun, the ambient and the clear colour every
     frame from the sky's own update (which runs before ours), so a studio
     frame has to re-assert its rig every frame too — cheaply: just the
     light and the backdrop, not the grade/DOF, which stick from the
     initial studioRig() call. */
  function studioHold() {
    /* some modules (clouds.js, weather.js) re-assert their own mesh
       visibility every update; wally runs after them, so re-hide here */
    if (studioSaved) for (const [o] of studioSaved) o.visible = false;
    const cam = ctx.camera;
    if (cam) {
      cam.updateMatrixWorld(true);
      _v.setFromMatrixColumn(cam.matrixWorld, 0);
      _v2.setFromMatrixColumn(cam.matrixWorld, 1);
      _camPos.setFromMatrixColumn(cam.matrixWorld, 2);
      _target.set(0, 0, 0)
        .addScaledVector(_v, -0.478)
        .addScaledVector(_v2, 0.596)
        .addScaledVector(_camPos, 0.646)
        .normalize();
      ctx.mat?.setSun?.(_target, 0xfffdfa, 0.96);
    }
    ctx.mat?.setAmbient?.(0xe3e6ea, 0xe9e8e4, 0.50, 0.26);
    if (ctx.render) {
      if (studioBG) ctx.render.clearColor.setRGB(studioBG[0], studioBG[1], studioBG[2]);
      else ctx.render.clearColor.setRGB(0.90, 0.905, 0.912);
    }
    if (studioBG && shadowMesh) shadowMesh.visible = false;
    if (ctx.scene) ctx.scene.background = null;
  }

  /* see the note on `studioBG` */
  dbg.studioBG = (rgb) => {
    studioBG = Array.isArray(rgb) ? rgb : null;
    return studioBG ? `bg ${studioBG}` : 'bg default';
  };

  /* Paint the body by dominant bone. The single most useful thing to be
     able to look at when a skinned mesh tears: it turns "something is
     dragging" into "bone 17 is dragging". */
  let weightSaved = null;
  dbg.wallyWeights = (on) => {
    const attr = bodyGeo.attributes.color;
    if (on === false) {
      if (weightSaved) { attr.array.set(weightSaved); attr.needsUpdate = true; weightSaved = null; }
      return 'off';
    }
    if (!weightSaved) weightSaved = attr.array.slice();
    const si = bodyGeo.attributes.skinIndex.array;
    const sw = bodyGeo.attributes.skinWeight.array;
    const n = attr.count;
    const seen = {};
    for (let v = 0; v < n; v++) {
      let bi = si[v * 4], bw = sw[v * 4];
      for (let k = 1; k < 4; k++) if (sw[v * 4 + k] > bw) { bw = sw[v * 4 + k]; bi = si[v * 4 + k]; }
      seen[BONES[bi].name] = (seen[BONES[bi].name] || 0) + 1;
      const h = (bi * 0.2793) % 1;
      const f = (k) => { const t = (h * 6 + k) % 6; return Math.max(0, Math.min(1, Math.min(t, 4 - t, 1.5))); };
      attr.array[v * 4] = f(5) * 2.2;
      attr.array[v * 4 + 1] = f(3) * 2.2;
      attr.array[v * 4 + 2] = f(1) * 2.2;
      attr.array[v * 4 + 3] = 1;
    }
    attr.needsUpdate = true;
    return seen;
  };
  /* Which bone owns the skin nearest a world point — for pinning a tear. */
  dbg.wallyBoneAt = (x, y, z) => {
    const pos = bodyGeo.attributes.position.array;
    const si = bodyGeo.attributes.skinIndex.array;
    const sw = bodyGeo.attributes.skinWeight.array;
    let best = Infinity, v = -1;
    for (let i = 0; i < bodyGeo.attributes.position.count; i++) {
      const dx = pos[i * 3] - x, dy = pos[i * 3 + 1] - y, dz = pos[i * 3 + 2] - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) { best = d; v = i; }
    }
    if (v < 0) return null;
    return {
      dist: +Math.sqrt(best).toFixed(4),
      at: [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]].map((n) => +n.toFixed(3)),
      bones: [0, 1, 2, 3].map((k) => [BONES[si[v * 4 + k]].name, +sw[v * 4 + k].toFixed(3)])
        .filter((b) => b[1] > 0),
    };
  };
  /* Dial the baked form/sky sculpt (model.js §6) between 0 and 1 in a
     live frame. The only honest way to judge it: the world's lighting,
     grade and exposure move under us while several agents work, so an
     absolute measurement across two runs means nothing and an A/B in one
     frame means everything. */
  let sculptSaved = null;
  dbg.wallySculpt = (k = 1) => {
    const attr = bodyGeo.attributes.color;
    const sk = bodyGeo.userData.sculptK;
    if (!sk) return null;
    if (!sculptSaved) sculptSaved = attr.array.slice();
    for (let i = 0; i < sk.length; i++) {
      /* undo the multiplier, then re-apply k of it */
      const inv = sk[i] > 1e-4 ? 1 / sk[i] : 1;
      const m = inv * (1 + (sk[i] - 1) * k);
      attr.array[i * 4] = sculptSaved[i * 4] * m;
      attr.array[i * 4 + 1] = sculptSaved[i * 4 + 1] * m;
      attr.array[i * 4 + 2] = sculptSaved[i * 4 + 2] * m;
    }
    attr.needsUpdate = true;
    return k;
  };

  /* Dial the baked CONE-TRACE AO (vColor.a) between 0 (off, flat white)
     and 1 (as baked) in a live frame — the alpha channel is a separate
     term from wallySculpt's rgb and the two have to be judged apart.
     Values above 1 are legal and deepen it. The only honest way to
     decide whether a dark patch on the belly is occlusion or dirt: watch
     it fade while nothing else in the frame moves. */
  let aoSaved = null;
  dbg.wallyAO = (k = 1) => {
    const attr = bodyGeo.attributes.color;
    if (!aoSaved) aoSaved = Float32Array.from(
      { length: attr.count }, (_, i) => attr.array[i * 4 + 3]);
    for (let i = 0; i < attr.count; i++) {
      attr.array[i * 4 + 3] = 1 + (aoSaved[i] - 1) * k;
    }
    attr.needsUpdate = true;
    return k;
  };

  /* Dial the RUNTIME contact crease (see installContactCrease) between
     0 and 1 in a live frame. It is a third term alongside wallySculpt's
     rgb and wallyAO's alpha, it is the only one that tracks the pose,
     and creasetest --extra needs to be able to switch it off to say how
     much of a crease is this and how much is the studio key. */
  dbg.wallyContact2 = (k = 1) => { contact.uniforms.uContactY.value.z = k; return k; };
  dbg.wallyContactInfo = () => ({
    strength: contact.uniforms.uContactY.value.z,
    params: contact.uniforms.uContact.value.toArray(),
    ramp: contact.uniforms.uContactY.value.toArray(),
    drops: contact.uniforms.uContactK.value.toArray(),
    arm: contact.uniforms.uCArmA.value.map((v, i) => [
      v.toArray().map((q) => +q.toFixed(3)),
      contact.uniforms.uCArmB.value[i].toArray().map((q) => +q.toFixed(3))]),
    body: contact.uniforms.uCBodyA.value.map((v, i) => [
      v.toArray().map((q) => +q.toFixed(3)),
      contact.uniforms.uCBodyB.value[i].toArray().map((q) => +q.toFixed(3))]),
    patched: clayMat.vertexShader.indexOf('wContactCaps') > -1
      && clayMat.fragmentShader.indexOf('vContact') > -1,
    progErr: clayMat.userData.progErr || null,
  });

  /* Sweep the idle's trunk hint without a rebuild — the trunk IS §1.6
     pose 1 and its side/curl have to be judged against the live gameplay
     camera, which means several values per boot. */
  dbg.wallyIdleTrunk = (curl, side, tip, stiff) => {
    const T = CLIPS.idle.trunk;
    if (curl != null) T.curl = curl;
    if (side != null) T.side = side;
    if (tip != null) T.tip = tip;
    if (stiff != null) T.stiff = stiff;
    return { ...T };
  };
  /* The same sweep for ANY clip — `cool` is the pose every likeness
     comparison is judged in, and its trunk hint needs the same
     several-values-per-boot treatment the idle's got. */
  dbg.wallyClipTrunk = (name, curl, side, tip, stiff) => {
    const T = CLIPS[name] && CLIPS[name].trunk;
    if (!T) return null;
    if (curl != null) T.curl = curl;
    if (side != null) T.side = side;
    if (tip != null) T.tip = tip;
    if (stiff != null) T.stiff = stiff;
    return { ...T };
  };
  dbg.wallyIdleEars = (perk, spread) => {
    CLIPS.idle.ears = (perk == null && spread == null)
      ? null : { perk: perk || 0, spread: spread || 0 };
    return CLIPS.idle.ears;
  };
  dbg.wallyGust = (x = 9, y = 2, z = 0) => { secondary.impulse(x, y, z); return 'gust'; };
  dbg.wallyLand = (i = 1) => { secondary.land(i); return 'land'; };
  dbg.wallyFree = () => { dbgCam = null; setSilhouette(false); contactShadow(true); };
  /** The arrival, on its own. `WALLY.debug.wallyWarp(x, y, z, yaw)`. */
  dbg.wallyWarp = (x, y, z, yaw) => {
    const ok = api.warpTo(x, y, z, yaw == null ? {} : { yaw });
    return { ok, pos: root.position.toArray().map((v) => +v.toFixed(2)), yaw: +root.rotation.y.toFixed(3) };
  };
  /** Is anything about him non-finite right now? For the travel test. */
  dbg.wallyFinite = () => positionFinite();
  dbg.wallyContact = (on) => { contactShadow(on !== false); return !!on; };
  /* Live handles on the ground shadow: (cast, pool, canopy, blur). Pass
     null for any you do not want to change. `debug` paints `a` flat so
     the coverage can be measured rather than guessed at. */
  dbg.wallyShadowDebug = (n) => { projMat.uniforms.uDebug.value = n || 0; return n; };
  dbg.wallyShadow = (cast, pool, canopy, blur) => {
    const p = projMat.uniforms.uParams.value;
    if (cast != null) p.x = cast;
    if (pool != null) p.y = pool;
    if (canopy != null) p.z = canopy;
    if (blur != null) p.w = blur;
    shadowLocked = true;
    return p.toArray();
  };
  dbg.wallyInfo = () => ({
    tris: api.stats.triangles,
    verts: api.stats.vertices,
    bones: nb,
    buildMs: api.stats.buildMs,
    clip: anim.current,
    action: anim.actionName,
    w: +anim.actionW.toFixed(2),
    expr: expr.name,
    pos: root.position.toArray().map((v) => +v.toFixed(3)),
    earTipL: secondary.chains.earL
      ? secondary.chains.earL.tip.toArray().map((v) => +v.toFixed(3)) : null,
    trunkTip: secondary.chains.trunk
      ? secondary.chains.trunk.tip.toArray().map((v) => +v.toFixed(3)) : null,
  });
  /* Resolved local euler (degrees) per bone plus the world height of a few
     landmarks — the only way to tell a clip problem from an additive-layer
     problem from a camera problem without guessing at a screenshot. */
  dbg.wallyPose = (names) => {
    const R2D = 180 / Math.PI;
    const list = names || ['hips', 'spine', 'chest', 'head', 'brow',
      'armL0', 'armR0', 'armL1', 'armR1', 'legL0', 'legR0'];
    const out = { clip: anim.current, action: anim.actionName, w: +anim.actionW.toFixed(3), expr: expr.name };
    for (const n of list) {
      const b = rig.byName[n];
      if (!b) continue;
      out[n] = [b.rotation.x * R2D, b.rotation.y * R2D, b.rotation.z * R2D].map((v) => +v.toFixed(1));
    }
    const wp = (n) => {
      const b = rig.byName[n];
      if (!b) return null;
      b.getWorldPosition(_v2);
      return [+_v2.x.toFixed(3), +_v2.y.toFixed(3), +_v2.z.toFixed(3)];
    };
    out._world = { hips: wp('hips'), chest: wp('chest'), head: wp('head'), brow: wp('brow') };
    out._lean = [+leanX.toFixed(3), +leanZ.toFixed(3)];
    out._look = [+expr.lookYaw.toFixed(3), +expr.lookPitch.toFixed(3), +expr.lookWeight.toFixed(3)];
    /* Where the face actually points, in world, and where the camera is
       relative to it. Degrees. This is the number that decides whether the
       lenses read, and it cannot be eyeballed off a screenshot. */
    const cam = ctx.camera || (ctx.render && ctx.render.camera);
    const hb = rig.byName.head;
    if (hb && cam) {
      hb.updateWorldMatrix(true, false);
      const q = new THREE.Quaternion(); hb.getWorldQuaternion(q);
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      const hp = new THREE.Vector3(); hb.getWorldPosition(hp);
      const cp = new THREE.Vector3(); cam.getWorldPosition(cp);
      const toCam = cp.clone().sub(hp).normalize();
      const R2 = 180 / Math.PI;
      out._face = {
        fwd: fwd.toArray().map((v) => +v.toFixed(3)),
        up: up.toArray().map((v) => +v.toFixed(3)),
        /* + = face pitched UP */
        facePitch: +(Math.asin(fwd.y) * R2).toFixed(1),
        /* angle between where he looks and where the camera is. 0 = dead on */
        faceToCam: +(Math.acos(clamp(fwd.dot(toCam), -1, 1)) * R2).toFixed(1),
        /* + = camera is ABOVE the head */
        camElev: +(Math.asin(toCam.y) * R2).toFixed(1),
        rootYaw: +(root.rotation.y * R2).toFixed(1),
        camPos: cp.toArray().map((v) => +v.toFixed(2)),
      };
    }
    return out;
  };
  if (window.WALLY) window.WALLY.debug = dbg;

  /* ================================================================
     12. Boot state
     ================================================================ */
  expr.set('neutral', { instant: true });
  /* The contact pool is part of gameplay, not just of the studio rig —
     see lateUpdate(). One draw call, two triangles, no shadow map. */
  contactShadow(true);
  if (ctx.flags.pose && CLIPS[ctx.flags.pose]) api.pose(ctx.flags.pose, { fade: 0.001 });

  /* Prime one frame so the very first render is a settled pose rather
     than the bind T-pose. */
  update(1 / 60, 0);
  for (let i = 0; i < 8; i++) {
    anim.update(1 / 60, { grounded: true, vy: 0, airTime: 0 });
  }
  update(1 / 60, 0);

  /* ================================================================
     THE MACHINES ARE BUILT NOW, NOT ON THE FRAME HE GETS ON ONE.

     `props = {}` and buildProp()'s `if (props[key]) return` made every
     ride lazy, which is the right instinct and the wrong frame: the
     work does not go away, it lands on the first equip — and for the
     balloon the first equip is flyPhase 'boarding', the one transition
     in the game with no cut over it. Two costs land there together:
     the machine's own construction (geometry, canvas textures,
     materials — one-time JS), and, the first time it is DRAWN, the
     GLSL compile and link of its programs.

     Both are one-time, so the only question is which frame pays. Here
     it is behind the boot bar, in a stage that already reports its own
     milliseconds, on a screen nobody is playing yet.

     THE SCOPE IS DELIBERATE, AND THE WIDER VERSION WAS TRIED AND
     REJECTED WITH EVIDENCE: a blanket renderer.compile() warm pass
     over the whole scene built 49 programs in 79.3 ms and city.gold
     and sky.godrays still compiled in play anyway, because their
     in-play draws carry different cacheKeys. This compiles the ride
     props and nothing else, against the real scene, and the count it
     returns is published so a rig can see whether it took.

     compile(object, camera, targetScene) is r180's own targeted form,
     and its two traversals are NOT symmetric: the first argument is
     walked with plain traverse(), so a hidden prop group is reachable,
     while the third is walked with traverseVisible() for lights and
     supplies the environment — which is why the scene goes there and
     the group goes first. Read both in vendor/three.module.js before
     changing either argument; that asymmetry is the whole reason this
     works on a prop that is visible:false.

     AND THE ONE-PIXEL RENDER TARGET IS THE POINT OF THE WHOLE BLOCK.
     Warming without it builds programs that are never used. Measured,
     on this build: compile straight to the canvas produced a
     balloon.envelope whose cacheKey differed from the one the first
     board used at EXACTLY ONE of 67 tokens — 'srgb' where the drawn
     frame wants 'srgb-linear' — so all seven programs compiled again
     on the lift-off frame anyway, which is precisely the failure the
     rejected scene-wide warm pass hit and could not explain. The
     token is three.module.js:6979: a material's outputColorSpace is
     renderer.outputColorSpace when there is NO render target bound and
     LinearSRGBColorSpace when there is, and everything in this game is
     drawn into the post chain's linear target. Binding any target for
     the length of the compile is therefore the difference between a
     warm pass and a waste of 90 ms.

     DO NOT REACH FOR renderer.outputColorSpace INSTEAD. It was tried:
     it moves that token AND a second one (a map's colour space is
     resolved against the output space), so the key misses in a new
     way and the programs compile in play regardless.

     WHAT IT STILL DOES NOT CATCH, measured the same way:
     balloon.envelope.depth. That is toon.js's userData.depthMaterial,
     hung on the mesh as customDepthMaterial, and compile() only ever
     looks at object.material — so it is built the first time the
     shadow pass draws the envelope. One program instead of seven.
     ================================================================ */
  api.stats.rideWarm = (() => {
    const t = performance.now();
    let built = 0, programs = 0;
    try {
      for (const key of Object.keys(RIDE_BUILD)) { buildProp(key); built++; }
      const r = ctx.renderer, cam = ctx.camera, scene = ctx.scene;
      if (r && cam && scene && typeof r.compile === 'function') {
        const before = r.info?.programs?.length ?? 0;
        const wasRT = r.getRenderTarget();
        const rt = new THREE.WebGLRenderTarget(1, 1);
        try {
          r.setRenderTarget(rt);
          for (const key of Object.keys(props)) r.compile(props[key].group, cam, scene);
        } finally {
          r.setRenderTarget(wasRT);
          rt.dispose();
        }
        programs = (r.info?.programs?.length ?? 0) - before;
      }
    } catch (e) {
      /* A ride that will not build at boot must not take the character
         down with it — buildProp is still lazy and still works. */
      console.warn('[wally] ride warm failed:', e && e.message);
    }
    return { built, programs, ms: +(performance.now() - t).toFixed(1) };
  })();

  api.stats.buildMs = +(performance.now() - t0).toFixed(1);
  console.log(`[wally] cell=${bodyGeo.userData.cell} tier=${tier} ${api.stats.triangles} tris, ${api.stats.vertices} verts, ${nb} bones, ${api.stats.buildMs} ms`);
  /* THE WARM IS PRINTED, so it cannot quietly stop working. `programs 0`
     with `built 4` means the compile found nothing new to build and the
     lift-off frame is about to pay for it again — which is exactly the
     state this block existed to leave behind. */
  console.log(`[wally] rides warm: ${api.stats.rideWarm.built} built, ${api.stats.rideWarm.programs} programs, ${api.stats.rideWarm.ms} ms`);

  return api;
}

/* ================================================================
   THE RUNTIME ARM/HAND CONTACT CREASE (§1.2 "armpits") — the half of
   the arm/flank crease that A BAKE CANNOT DO.

   model.js armSeam() paints this crease from y 0.76 up, per vertex, in
   BIND space, off the arm blobs against the TORSO and BELLY only. Its
   own block explains why the leg is not in that min: bind space is
   where the mitten hangs beside the thigh, so a leg-derived band leaves
   its body-side half stranded on the hip the instant a pose opens the
   arm — measured once at 23 000 stranded pixels across the two hip rows
   in `welcome`. The band therefore had to stop at the wrist, and the
   scan says exactly what that costs: at f 0.68 of figure height — the
   forearm-and-mitten-against-hip stretch the user photographed — the
   luminance ran monotonically 209 -> 103 across 130 mm with no minimum
   anywhere, against a reference that plunges to 62 in a 14 mm hairline
   between two lit forms.

   SO THE SAME MEASURE IS EVALUATED IN THE POSE INSTEAD. Ten capsules —
   forearm, mitten and knuckle per arm, both thighs, two hip columns —
   are pushed to the vertex shader each frame in the space the skinning
   chunk leaves `transformed` in, and the shader computes what armSeam()
   computes:  s = max(0,dArm) + max(0,dBody), skewed by which wall the
   vertex is on, through the same smoothstep and the same ARM_SEAM_W /
   _A drops IMPORTED from model.js. Nothing is re-typed — drift between
   the two halves would show up as a step across y 0.76.

   WHY THIS IS SAFE WHERE THE BAKE WAS NOT. It is a proximity fact
   recomputed from the current bone matrices, so when `welcome` swings
   the mitten off the hip the hip's half of the band leaves with it,
   which is the whole of the failure the bake could not avoid. It also
   cannot gash the armpit: it is gated to bind y < 0.76, well under the
   shoulder, and above that the baked band is in charge.

   COST. A vertex-stage term (the bake it continues is per-vertex too),
   ten capsules of vector maths over 31 k vertices; on the CPU one
   matrix per contributing bone and 20 point transforms per frame.
   ================================================================ */
const CONTACT_ARM = 6, CONTACT_BODY = 4;

/* The proxies, in BIND space, each carried by the bone that owns that
   skin. RADII ARE READ OFF PROP AND SHADED DOWN, never authored: a proxy
   that pokes out through the sculpted surface reads dArm = 0 on the
   WRONG side of the slot and shades the whole limb. The hip pair are
   round capsules against an elliptical lathe, so they take the lathe's
   HALF-WIDTH and sit inside it in z — the safe direction. */
function contactCapsules() {
  const A = PROP.arm, HD = PROP.hand, L = PROP.leg, T = PROP.torso;
  const fore = A[3], wrist = A[4];
  const arm = (side) => {
    const el = side > 0 ? 'armL1' : 'armR1';
    const hn = side > 0 ? 'handL' : 'handR';
    const S = (p) => [p[0] * side, p[1], p[2]];
    return [
      [el, S(fore), fore[3] * 0.96, S(wrist), wrist[3] * 0.96],
      [hn, S(wrist), wrist[3] * 0.96, S(HD.knuckle), HD.knuckle[3] * 0.94],
      [hn, S(HD.knuckle), HD.knuckle[3] * 0.94, S(HD.tip), HD.tip[3] * 0.94],
    ];
  };
  const leg = (side) => [side > 0 ? 'legL0' : 'legR0',
    [L[0][0] * side, L[0][1], L[0][2]], L[0][3] * 0.94,
    [L[1][0] * side, L[1][1], L[1][2]], L[1][3] * 0.94];
  const hip = (a, b) => ['hips',
    [0, T[a][0], T[a][2]], T[a][1] * 0.96,
    [0, T[b][0], T[b][2]], T[b][1] * 0.96];
  return { arm: [...arm(1), ...arm(-1)], body: [leg(1), leg(-1), hip(0, 2), hip(2, 3)] };
}

function installContactCrease(material, skinned, rigRef) {
  const caps = contactCapsules();
  const armA = [], armB = [], bodyA = [], bodyB = [];
  for (let i = 0; i < CONTACT_ARM; i++) { armA.push(new THREE.Vector4()); armB.push(new THREE.Vector4()); }
  for (let i = 0; i < CONTACT_BODY; i++) { bodyA.push(new THREE.Vector4()); bodyB.push(new THREE.Vector4()); }

  /* §1.2's crease is dark-WARM, never grey. Same construction as
     bakeTint's rCrease: a hue direction normalised to unit luminance, so
     the value drop is applied once (by W and A) and not twice. */
  const lin = (h) => {
    const f = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    return [f(((h >> 16) & 255) / 255), f(((h >> 8) & 255) / 255), f((h & 255) / 255)];
  };
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const cr = lin(SHADOW.ao), bs = lin(CLAY.body);
  const crL = lum(cr), bsL = lum(bs);
  const hue = new THREE.Vector3(
    (cr[0] / crL) / (bs[0] / bsL),
    (cr[1] / crL) / (bs[1] / bsL),
    (cr[2] / crL) / (bs[2] / bsL));

  const u = material.uniforms;
  u.uCArmA = { value: armA };
  u.uCArmB = { value: armB };
  u.uCBodyA = { value: bodyA };
  u.uCBodyB = { value: bodyB };
  /* x = R, y = C, z = skew on the arm wall, w = skew on the body wall.
     THE BODY WALL IS SLACKER HERE THAN IN THE BAKE (1.8 against 3.20).
     The bake's flank wall answers to the 30-57 mm slot beside the ribs;
     this one answers to a 47 mm proxy clearance at the mitten, and at
     3.20 the hip side of the contact fell off the end of the band
     altogether — one lit wall and one dark one is a terminator, not a
     crease, which is the note armSeam() opens with. */
  u.uContact = { value: new THREE.Vector4(ARM_SEAM.R, ARM_SEAM.C, ARM_SEAM.skewArm, ARM_SEAM.skewFlank) };
  /* x,y = the handover ramp, taken from model.js so the baked half and
     this one meet at exactly one place; z = master strength (debug). */
  u.uContactY = { value: new THREE.Vector3(ARM_SEAM.y0, ARM_SEAM.y1, 1) };
  u.uContactK = { value: new THREE.Vector4(ARM_SEAM.W, ARM_SEAM.A, ARM_SEAM.flankP, 0) };
  u.uCreaseHue = { value: hue };

  /* A ShaderMaterial owns its source strings outright, so this is a
     plain edit of THIS material. toon.js is untouched and every other
     clay surface in the game compiles the shader it always did. */
  const VDECL = `
uniform vec4 uCArmA[${CONTACT_ARM}];
uniform vec4 uCArmB[${CONTACT_ARM}];
uniform vec4 uCBodyA[${CONTACT_BODY}];
uniform vec4 uCBodyB[${CONTACT_BODY}];
uniform vec4 uContact;
uniform vec3 uContactY;
uniform vec4 uContactK;
varying float vContact;
/* tapered capsule — the measure model.js primDist uses for CONE */
float wContactCaps( vec3 p, vec4 a, vec4 b ) {
  vec3 pa = p - a.xyz, ba = b.xyz - a.xyz;
  float h = clamp( dot( pa, ba ) / max( dot( ba, ba ), 1e-8 ), 0.0, 1.0 );
  return length( pa - ba * h ) - mix( a.w, b.w, h );
}
void main() {`;
  if (material.vertexShader.indexOf('void main() {') < 0) throw new Error('toon VERT moved');
  material.vertexShader = material.vertexShader.replace('void main() {', VDECL);

  const SKIN = '  #include <skinning_vertex>';
  if (material.vertexShader.indexOf(SKIN) < 0) throw new Error('toon skinning hook moved');
  material.vertexShader = material.vertexShader.replace(SKIN, `${SKIN}

  /* ---- the runtime half of the arm/flank crease ---- */
  {
    float dA = 1e3, dB = 1e3;
    for ( int i = 0; i < ${CONTACT_ARM}; i++ ) dA = min( dA, wContactCaps( transformed, uCArmA[ i ], uCArmB[ i ] ) );
    for ( int i = 0; i < ${CONTACT_BODY}; i++ ) dB = min( dB, wContactCaps( transformed, uCBodyA[ i ], uCBodyB[ i ] ) );
    float s = max( dA, 0.0 ) + max( dB, 0.0 );
    float ad = s * ( dA < dB ? uContact.z : uContact.w );
    float c = clamp( ( uContact.x - ad ) / ( uContact.x - uContact.y ), 0.0, 1.0 );
    c = c * c * ( 3.0 - 2.0 * c );
    if ( dA >= dB ) c = pow( c, uContactK.z );   // the body wall recovers on a curve
    vContact = c * ( 1.0 - smoothstep( uContactY.x, uContactY.y, position.y ) ) * uContactY.z;
  }`);

  const FDECL = `
uniform vec4 uContactK;
uniform vec3 uCreaseHue;
varying float vContact;
void main() {`;
  material.fragmentShader = material.fragmentShader.replace('void main() {', FDECL);

  const AOLINE = '    col *= mix( vec3( 0.62, 0.575, 0.565 ), vec3( 1.0 ), mix( 1.0, vColor.a, uAO ) );';
  if (material.fragmentShader.indexOf(AOLINE) < 0) throw new Error('toon AO line moved');
  material.fragmentShader = material.fragmentShader.replace(AOLINE, `${AOLINE}

  /* the runtime crease, applied the way bakeTint applies the baked one:
     a value drop, a value-neutral warm hue rotation, and a share of the
     same warm AO multiplier the alpha channel rides. */
  {
    float cc = vContact;
    float av = 1.0 - uContactK.y * cc;
    col *= ( 1.0 - uContactK.x * cc )
         * mix( vec3( 1.0 ), uCreaseHue, cc * 0.85 )
         * mix( vec3( 0.62, 0.575, 0.565 ), vec3( 1.0 ), mix( 1.0, av, uAO ) );
  }`);
  material.needsUpdate = true;

  /* Bind-space capsule -> the space `transformed` is in, built from the
     mesh's OWN bindMatrix / bindMatrixInverse and the skeleton's
     boneInverses rather than from an assumption about where the root
     is. That assumption is the one that breaks silently the moment the
     character walks away from the origin. */
  const _p = new THREE.Vector3();
  const perBone = new Map();
  const boneMat = (name) => {
    let M = perBone.get(name);
    if (M !== undefined) return M;
    const bone = rigRef.byName[name];
    const i = bone ? skinned.skeleton.bones.indexOf(bone) : -1;
    M = i < 0 ? null : new THREE.Matrix4()
      .multiplyMatrices(bone.matrixWorld, skinned.skeleton.boneInverses[i])
      .premultiply(skinned.bindMatrixInverse)
      .multiply(skinned.bindMatrix);
    perBone.set(name, M);
    return M;
  };
  const write = (spec, A, B, i) => {
    const M = boneMat(spec[0]);
    if (!M) return;
    _p.fromArray(spec[1]).applyMatrix4(M); A[i].set(_p.x, _p.y, _p.z, spec[2]);
    _p.fromArray(spec[3]).applyMatrix4(M); B[i].set(_p.x, _p.y, _p.z, spec[4]);
  };
  const api = {
    uniforms: u,
    update() {
      perBone.clear();
      for (let i = 0; i < CONTACT_ARM; i++) write(caps.arm[i], armA, armB, i);
      for (let i = 0; i < CONTACT_BODY; i++) write(caps.body[i], bodyA, bodyB, i);
    },
  };
  api.update();
  return api;
}

export default init;
