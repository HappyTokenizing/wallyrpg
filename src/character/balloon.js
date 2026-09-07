/* ============================================================
   balloon.js — THE ASSESSOR. The City Treasury's survey balloon,
   and the fourth and last machine on the ride ladder.

   bike.js explains why a vehicle Wally rides belongs to the character
   layer; rides.js says everything structural about the second and
   third. All of it holds here with exactly one exception, and the
   exception is the whole feature: THIS ONE LEAVES THE GROUND, so the
   contract with the controller is inverted. The bicycle rides a
   character controller. The balloon replaces it.

   WHAT HAD TO BE DIFFERENT, AND WHY
   ---------------------------------
   1  HE STANDS IN IT. anim.js publishes a seated posture per machine
      (BIKE_SEAT / SCOOT_SEAT / MOTO_SEAT) and Animator.setRide()
      points the mount clips at one of them. There is no basket
      posture and inventing one means editing a file this agent does
      not own — but more to the point, a balloonist does not sit. He
      stands at the rim with his weight on one leg looking out, which
      is ART_DIRECTION §1.6 pose 1, which is ALREADY the idle. So the
      balloon does not use the ride posture path at all: wally.js runs
      its own flight state beside the bicycle's, holds the locomotion
      blend at zero, and the idle he is already carrying is the right
      pose by construction. Ear and trunk physics then do the rest —
      they are world-space chains hung off bones, so a climb streams
      his ears down and a stop lets them settle, for free.

   2  THE ORIGIN IS STILL ON THE GROUND. Every park solve in this
      project (bike.js solveParkPose, wally.js parkProp) assumes the
      prop's local origin sits on the plane through its ground
      contacts, and `wheels[]` gives the contact stations. The basket
      floor is therefore at local y = DECK (0.26 — it stands on
      skids), not at 0, and while he is ABOARD the prop is offset
      -DECK in y so the deck lands under his soles. Two invisible skid
      contacts stand in for the wheels so parkProp's chord solve works
      unmodified and the parked balloon conforms to a cross-slope
      exactly like the motorcycle does.

   3  IT GOES COLD WHEN IT IS NOT FLYING. "Where does it live when not
      in use" has one honest answer for a balloon and it is not "on a
      kickstand". The envelope loses its air, folds over on itself and
      drapes down around the burner frame with its skirt on the grass:
      three metres across and under four tall, moored to an iron peg.
      That is a thing that fits beside a motorcycle at a door, and it
      is unmistakably cloth over a structure rather than a machine
      standing to attention. It is also the take-off — the inflation
      IS the mount — and the first version of it, which laid the
      fabric out flat on a launch field, is in build()'s header along
      with the photograph of why that could not ship.

   THE ENVELOPE, AND THE TWO-BAND RAMP
   -----------------------------------
   A large smooth curved surface is the worst case a two-band toon
   ramp can be handed. One arc of terminator across a sphere reads as
   a sticker, and every trick that lives in the shader — softer band,
   more rim, more sky bounce — makes it read as a *shinier* sticker.
   The fix is not in the shader. It is that a real balloon IS NOT A
   SPHERE, and the reasons it is not are all things that break a
   terminator:

     GORES.   Sixteen tapered panels seamed top to bottom. Between two
              seams the fabric bulges (the "pumpkin" lobe, 9.5% of
              radius: 24 cm out at the panel's crown, 12 cm in at the
              seam) and at the seam it is pulled in by the load tape.
              So the section is a sixteen-lobed rosette, not a circle,
              and the terminator crosses it as a SCALLOP — sixteen
              little arcs — instead of one lazy line. That single
              change is most of the answer and it costs nothing at
              runtime.
     MACRO.   toon.js's metre-scale normal undulation, the thing it
              wrote for terrain and describes as "what makes a large
              flat surface band". Same problem, same fix.
     TAPES.   The seams carry real ribbon geometry, dark, converging
              at the crown. They are the balloon's structure, they
              read at forty metres, and they cut the envelope into
              readable panels the eye can measure the form against.
     BANDS.   Each gore is stacked from seven panels with a stitch
              line between them, so the surface has latitude as well
              as longitude and no unbroken curve survives anywhere.
     LIVERY.  Alternate gores in the city's own two colours, a
              terracotta crown cap and a darker skirt. Two bands on
              four albedos is EIGHT values on screen, not two.
     SSS.     toon.js's subsurface term is a back-light: pow(V . -L).
              A fabric envelope with the sun behind it glows, and that
              is the one lighting cue that says "this is cloth over
              hot air" rather than "this is a painted ball".
     WIND.    The envelope is a wind material (§2.3) pivoting at its
              throat, so it leans and breathes with the same gust
              everything else in the frame is riding.

   FORWARD IS +Z. Origin on the ground under the basket's centre-line,
   same as the other three.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { BUILD, LAND, BRAND } from '../core/palette.js';
import { makeKit } from './rides.js';

/* ==================================================================
   1. THE FIT — every station on the machine, in metres above the
      ground contact plane.

   THESE ARE SOLVED AGAINST A 1.6 m ELEPHANT WHO IS STANDING, which is
   a different problem from the seated fits in rides.js. The three
   numbers that matter:

     DECK   0.26  the basket floor over the skids. He is 0.26 m up
                  when aboard, so the prop hangs at -DECK from root.
     RIM    1.16  the basket rim = DECK + 0.90. His shoulder is at
                  ~1.25 m and his belly — §1.1's widest point — at
                  0.64 m, so the rim crosses him at the chest: he
                  reads as standing IN it, not behind it, and the idle
                  arms (which hang at +/-0.30 m) clear the 0.67 m
                  half-width without touching.
     MOUTH  2.86  the envelope throat, 1.00 m over his crown (1.86).
                  Anything lower and the burner is in his ears.

   The envelope is 7.30 m from throat to crown and 7.24 m across at its
   widest. Total object height 10.16 m. That is deliberately smaller
   than a real balloon relative to its rider — a true 20 m envelope
   over a 1.6 m character is 12.5 heights of fabric and there is no
   camera that frames it — and deliberately bigger than anything else
   in the ride ladder, because it has to read as a landmark from the
   ground and as an object from 200 m up.
   ================================================================== */
/* The burner's own colour, for the flame, the throat and the light it
   throws. A propane burner is much whiter at the root than a candle
   is, so this is an orange-amber rather than the fire-red a lamp gets:
   BRAND.token is #F5913C and this sits a touch hotter than it. */
const BURN_LIGHT = 0xff9c46;

export const FIT = Object.freeze({
  DECK: 0.26,          // basket floor over the ground
  SKID: 0.26,          // the runners' height (= DECK; the floor sits on them)
  HALF: 0.67,          // basket half-width
  WALL: 0.90,          // basket wall height
  RIM: 1.16,           // DECK + WALL
  POST: 2.24,          // top of the burner frame uprights
  BURN: 2.36,          // the jets
  MOUTH: 2.86,         // envelope throat centre
  ENV_H: 7.30,         // throat to crown
  ENV_R: 3.62,         // widest radius
  TOP: 10.16,          // MOUTH + ENV_H
});

/* The two skid contacts, fore and aft, in prop-local z. parkProp
   reads these off `wheels[]` and pitches the machine to the chord
   through them — the same solve the motorcycle gets. A short base
   (0.94 m against the motorcycle's 1.28) is the right answer for a
   thing that has to sit level on a lawn: the shorter the base, the
   less of the hill it has to average. */
const SKID_Z = 0.47;

/* ==================================================================
   2. THE FLIGHT MODEL

   THE HONEST QUESTION IS HOW MUCH AUTHORITY THE PLAYER GETS, and
   there are three answers, two of which are wrong.

   REJECTED — PURE REALISM. A real balloon has no horizontal control
   at all. You choose an altitude and the air at that altitude chooses
   your heading; you steer by climbing and descending until you find a
   layer going your way. It is a beautiful mechanic and it is
   unplayable here: this island is 970 m across, the fare board quotes
   a four-minute motorcycle hop, and hunting wind layers to reach a
   named door would take minutes and could fail. A reward that is
   worse than the bicycle at arriving anywhere is not a reward.

   REJECTED — ARCADE. Direct velocity control with a bank into the
   turn. That is a plane, or a drone, and the brief rules out both by
   name. It also throws away the only thing that makes a balloon a
   balloon, which is that it CANNOT do what you just asked it to.

   CHOSEN — MOMENTUM WITH A BIAS. Two separate authorities:

     VERTICAL is real and it is LAGGED. The burner adds heat, heat
     decays, lift is proportional to (heat - trim), and vertical
     velocity is a first-order lag on lift. So: pull the burner and
     nothing happens for a beat; keep pulling and she climbs; let go
     and she keeps climbing for another five seconds. Full climb is
     4.5 m/s, full descent 3.3 m/s, and the descent is slower than the
     climb because venting only removes what the burner put in. Every
     number below is chosen so the round trip — burner on, respond,
     burner off, respond — is about eight seconds. That lag IS the
     character. Nothing else in this game has any.

     HORIZONTAL is a WISH, not a throttle. The air is moving at the
     global wind (§2.3), the balloon is in the air, and the stick asks
     the air for a favour: velocity damps toward (wind + stick*reach)
     at a rate whose time constant is 4.5 seconds. From a standstill,
     full stick takes eleven seconds to reach its speed and eleven
     more to give it back. You aim forty metres ahead or you do not
     aim at all. There is no bank, no yaw authority and no brake.

     AND THE AIR HAS TO BE MOST OF IT, which the first calibration was
     not. reach 9.00 against windGain 3.60 sounds like a wind-driven
     machine until the wind is measured: ctx.wind.vector() came back
     with a mean magnitude of 0.316 over sixty seconds of live play
     (min 0.098, p50 0.297, p95 0.629, max 0.948), so the air in the
     model was 1.14 m/s against 9.00 m/s of stick — SEVEN AND A HALF
     TO ONE. Measured cruise was 10.03 m/s dead downwind and 8.15 m/s
     dead upwind: a 1.23 ratio, which is to say the wind was a rounding
     error and the player was flying a slow airship in a direction of
     their choosing. The lag and the missing bank are what kept that
     from feeling like an aircraft; the mechanics underneath it were
     an aircraft's.

     So the same delivered speed is re-split between the two. The
     numbers are chosen against three things at once:

       the DOWNWIND ceiling stays where the rest of the game thinks it
       is — reach + windNom * windGain = 6.20 + 0.316 * 9.80 = 9.30,
       against data.js's RACE.street.balloon of 9.0 and the bicycle's
       8.8 sprint, so the ladder and the race pace table are unchanged;

       the UPWIND crawl stays PLAYABLE, which is the tension the first
       calibration correctly identified and then resolved the wrong
       way. |6.20 - 3.10| = 3.10 m/s upwind: slower than walking (5.9),
       and 970 m of island is five minutes of it if you insist on
       fighting the air the whole way. You are not meant to. The wind
       re-aims itself every 18-40 s (core/wind.js), so a headwind is
       weather rather than a wall, and across the wind you still make
       sqrt(6.20^2 + 3.10^2) = 6.9 m/s;

       and the RATIO comes to 2.0 : 1 instead of 7.5 : 1, which is the
       whole point: from up there you now pick your line by reading
       where the air is going, and a leg you took at ten metres a
       second on the way out costs you three on the way back.

     AND SHE TURNS ANYWAY. The basket rotates slowly under the
     envelope — real ones do, about a turn a minute — damping toward
     the drift heading with a wander on top. The camera is oriented on
     the DRIFT, not on the basket, so the world does not spin: the
     basket turns beneath a steady view, which is exactly what the
     ride feels like.

   The DELIVERED downwind ceiling — reach plus the air it is riding —
   is set against the ladder: 9.30, a shade over the bicycle's sprint
   (8.8) and a third of the motorcycle's (26.4). The balloon is not
   the fast way anywhere. It is the way that goes straight over the
   top of the whole island, and it costs almost no energy.

   Exported, and the integrator below is a PURE FUNCTION of numbers
   with no THREE in it, so tools/test-balloon.mjs can assert the lag
   and the terminal speeds in plain node without a browser.
   ================================================================== */
export const FLIGHT = Object.freeze({
  burnRate: 0.62,      // heat/s with the burner lit
  coolRate: 0.155,     // heat/s lost to the sky
  ventRate: 1.05,      // heat/s dumped through the crown
  trim: 0.42,          // the heat at which lift balances weight
  liftAcc: 4.30,       // m/s^2 per unit of (heat - trim)
  vDrag: 0.55,         // 1/s, vertical
  reach: 6.20,         // m/s the stick can eventually buy
  hLag: 0.22,          // 1/s, horizontal. tau = 4.5 s
  windGain: 9.80,      // windNom * this is the air's own speed
  /* MEASURED, not assumed. |ctx.wind.vector()| sampled twice a second
     for sixty seconds of live play: mean 0.316, min 0.098, p50 0.297,
     p95 0.629, max 0.948. The old comment here guessed "~0.5", which
     is why the air in the model was a third of what it was thought to
     be. Exported so tools/test-balloon.mjs can work out the delivered
     ceilings in plain node, with no browser and no wind module. */
  windNom: 0.316,
  spin: 0.35,          // 1/s, basket yaw toward the drift heading
  wander: 0.085,       // rad/s of idle rotation on top of it
  vMaxUp: 4.6,         // clamps, so a pathological dt cannot launch him
  vMaxDown: 3.6,
});

/** Exponential approach that is correct at any timestep.
    Same shape as contracts.js damp(), inlined so the pure integrator
    below has no imports at all. */
const dampf = (a, b, lambda, dt) => b + (a - b) * Math.exp(-lambda * dt);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/**
 * ONE FIXED STEP OF THE FLIGHT MODEL. Pure: no THREE, no ctx, no
 * globals, everything in and out through the two objects.
 *
 * @param {object} S   {heat, vx, vy, vz, yaw} — mutated in place
 * @param {object} I   {x, z, burn, vent} — stick (world XZ) and buttons
 * @param {object} E   {windX, windZ, ceiling} — the air, and whether
 *                     the burner is being forced on by the refusal to
 *                     land in water (see wally.js)
 * @param {number} dt  seconds
 * @returns {object} S
 */
export function stepFlight(S, I, E, dt) {
  const F = FLIGHT;
  if (!(dt > 0) || dt > 0.25) dt = dt > 0 ? 0.25 : 0;

  /* ---- heat ----
     The burner wins over the vent if a player somehow holds both:
     an auto-burner forced by the water refusal must not be cancelled
     by a stuck vent key. */
  const burn = !!I.burn;
  const vent = !!I.vent && !burn;
  let h = S.heat + (burn ? F.burnRate : 0) * dt
        - (vent ? F.ventRate : 0) * dt
        - F.coolRate * dt;
  S.heat = h < 0 ? 0 : h > 1 ? 1 : h;

  /* ---- vertical: lift, then a first-order lag on it ---- */
  const acc = (S.heat - F.trim) * F.liftAcc;
  S.vy = dampf(S.vy, acc / F.vDrag, F.vDrag, dt);
  if (S.vy > F.vMaxUp) S.vy = F.vMaxUp;
  if (S.vy < -F.vMaxDown) S.vy = -F.vMaxDown;

  /* ---- horizontal: damp toward (the air + what you asked for) ---- */
  let sx = I.x || 0, sz = I.z || 0;
  const sl = Math.hypot(sx, sz);
  if (sl > 1) { sx /= sl; sz /= sl; }
  const tx = E.windX * F.windGain + sx * F.reach;
  const tz = E.windZ * F.windGain + sz * F.reach;
  S.vx = dampf(S.vx, tx, F.hLag, dt);
  S.vz = dampf(S.vz, tz, F.hLag, dt);

  /* ---- the lazy turn ----
     Toward the drift when there is a drift worth naming, plus a slow
     wander so a becalmed balloon is never perfectly still. `yawRate`
     is published because rides.js's setSteer() contract wants one and
     because the envelope's own lean reads off it. */
  const speed = Math.hypot(S.vx, S.vz);
  let want = S.yaw;
  if (speed > 0.55) want = Math.atan2(S.vx, S.vz);
  /* shortest way round */
  let d = want - S.yaw;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  const before = S.yaw;
  S.yaw += d * (1 - Math.exp(-F.spin * dt))
         + Math.sin(S.yaw * 1.7 + 0.9) * F.wander * dt;
  S.yawRate = dt > 0 ? (S.yaw - before) / dt : 0;
  S.speed = speed;
  return S;
}

/** A fresh flight state. */
export function newFlight(yaw = 0) {
  return { heat: 0, vx: 0, vy: 0, vz: 0, yaw, yawRate: 0, speed: 0 };
}

/* ==================================================================
   3. THE MERIDIAN — the envelope's own profile.

   Twelve control points rather than a formula, because the shape of a
   hot-air balloon is not any closed form anyone would recognise: it is
   fat and LOW (84% of its final radius by a fifth of its height),
   carries a long rounded shoulder, and closes into a small crown ring
   rather than a point. Every attempt to write it as sin^k came out
   either as an egg or as a raindrop. Catmull-Rom through measured
   points is honest about what it is.

     v  0 = throat, 1 = crown ring
     r  metres
     y  fraction of ENV_H
   ================================================================== */
const MERIDIAN = [
  [0.00, 1.20, 0.000],
  [0.09, 2.30, 0.068],
  [0.20, 3.02, 0.166],
  [0.32, 3.44, 0.286],
  [0.44, 3.62, 0.400],
  [0.56, 3.56, 0.518],
  [0.68, 3.26, 0.648],
  [0.78, 2.82, 0.754],
  [0.87, 2.18, 0.848],
  [0.94, 1.44, 0.925],
  [0.98, 0.82, 0.972],
  [1.00, 0.40, 1.000],
];

/** Catmull-Rom through the table, clamped at both ends. Returns
    [r, yFrac, dr/dv, dy/dv] — the derivatives fall out of the same
    basis and the hull normal needs them. */
function meridian(v) {
  const M = MERIDIAN, n = M.length;
  let i = 0;
  while (i < n - 2 && v > M[i + 1][0]) i++;
  const p0 = M[Math.max(0, i - 1)], p1 = M[i], p2 = M[i + 1], p3 = M[Math.min(n - 1, i + 2)];
  const span = p2[0] - p1[0];
  const t = span > 1e-6 ? (v - p1[0]) / span : 0;
  const t2 = t * t, t3 = t2 * t;
  const h = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  const hd = (a, b, c, d) => 0.5 * ((-a + c) + 2 * (2 * a - 5 * b + 4 * c - d) * t + 3 * (-a + 3 * b - 3 * c + d) * t2);
  const inv = span > 1e-6 ? 1 / span : 0;
  return [
    Math.max(0.02, h(p0[1], p1[1], p2[1], p3[1])),
    h(p0[2], p1[2], p2[2], p3[2]),
    hd(p0[1], p1[1], p2[1], p3[1]) * inv,
    Math.max(0.05, hd(p0[2], p1[2], p2[2], p3[2]) * inv),
  ];
}

/* Gores, columns per gore, rows. 16 x 4 x 18 is 2 304 triangles for
   the envelope, which is a THIRD of what the motorcycle spends on its
   frame — and the count is set by the SEAM, not by the curvature: a
   gore needs enough columns that the lobe between two seams is a
   curve rather than a tent, and four is where that stops improving. */
const GORES = 16, COLS = 4, ROWS = 18;
const RING = GORES * (COLS + 1);     // 80 — seam columns are duplicated
/* The lobe. 6.2% of radius, split so the seam is pulled IN by a third
   of it and the panel bulges out by two thirds: 7 cm of valley and
   15 cm of crown on a 3.6 m radius. Big enough that the terminator
   scallops, small enough that the silhouette is still a balloon. */
const LOBE = 0.095, SEAM_PULL = 0.34;
const BANDS = 7, STITCH = 0.0075;

/* ==================================================================
   4. THE ENVELOPE

   Built once as a fixed-topology grid and MORPHED on the CPU for the
   inflation, which is the only animation in this game that changes a
   vertex buffer. It is affordable — 1 520 vertices, about 0.15 ms a
   rebuild, and only while the inflation is actually moving — and it
   buys the one thing a scale or a scale-and-fade could not: the
   envelope genuinely FILLS, from the throat upward, off the ground.

   THREE THINGS HAVE TO BE REBUILT TOGETHER OR THE MORPH IS A BUG:

     position   obvious
     normal     creased at the seams (one-sided differences)
     aHullN     the SMOOTH normal, which toon.js's inverted hull reads.
                It is baked ONCE by hullNormals() at register time from
                a position hash, and it would go stale the moment the
                geometry moved — so this file writes it itself, every
                rebuild, analytically. That is also strictly better
                than what the generic path produces: the exact
                un-creased surface normal instead of an average of
                whatever normals happen to share a position.

   And the bounding sphere, or §6's no-pop-in rule is broken by the
   frustum culler the moment the envelope grows past the sphere it was
   registered with.
   ================================================================== */
function makeEnvelope(ctx, K) {
  const T = THREE;
  const nv = RING * (ROWS + 1);
  const pos = new Float32Array(nv * 3);
  const nrm = new Float32Array(nv * 3);
  const hul = new Float32Array(nv * 3);
  const col = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);

  /* ---- the livery, as vertex colour ----
     The material's albedo is white and every colour on the envelope
     rides in the vertex stream, so the whole thing is ONE mesh and one
     outline hull. That leaves the stroke with no albedo to derive
     itself from, so the outline colour is passed explicitly below —
     the dominant gore, which is what §2.2 means by "the object's
     albedo" for an object with four of them. */
  const C_A = new T.Color().setHex(BRAND.token);      // token orange
  const C_B = new T.Color().setHex(BUILD.stucco);     // stucco cream
  const C_CROWN = new T.Color().setHex(BUILD.roof);   // terracotta cap
  const C_SKIRT = new T.Color().setHex(BUILD.roofShade);
  const _c = new T.Color();

  for (let j = 0; j <= ROWS; j++) {
    const v = j / ROWS;
    for (let g = 0; g < GORES; g++) {
      for (let c = 0; c <= COLS; c++) {
        const i = (g * (COLS + 1) + c) + j * RING;
        /* crown cap and skirt run right across every gore; the body
           alternates. Four albedos, two bands each: eight values. */
        if (v > 0.845) _c.copy(C_CROWN);
        else if (v < 0.105) _c.copy(C_SKIRT);
        else _c.copy((g & 1) ? C_B : C_A);
        /* the seam sits in its own shade even before the tape is laid
           over it — a pressed, stitched valley is darker than the
           panel either side of it whatever the light is doing */
        const seam = (c === 0 || c === COLS) ? 0.82 : 1;
        /* ---- LATITUDE ----
           Longitude is solved (gores, tapes, lobes) and latitude was
           not: the first pass had the horizontal panel seams as a
           0.75% radius dip and nothing else, which is invisible at any
           distance. A gore is stacked from seven panels of cloth and
           no two bolts of dyed nylon are the same value, so alternate
           courses carry +/-4% and the stitch line itself sits at 90%.
           That gives the envelope a horizontal grid to read the form
           against as well as a vertical one, which is the whole of
           "no unbroken curve survives anywhere on it". */
        const sb = v * BANDS, sf = sb - Math.floor(sb);
        const band = 1 + ((Math.floor(sb) & 1) ? 0.040 : -0.040);
        const stitch = Math.min(sf, 1 - sf) < 0.055 ? 0.90 : 1;
        const k = seam * band * stitch;
        col[i * 3] = _c.r * k; col[i * 3 + 1] = _c.g * k; col[i * 3 + 2] = _c.b * k;
        uv[i * 2] = (g + c / COLS) / GORES;
        uv[i * 2 + 1] = v;
      }
    }
  }

  /* THE WINDING, DERIVED AND THEN MEASURED — and it was wrong the
     first time, in a way that is worth writing down because it does
     not look like a winding bug.

     The azimuth runs +theta and a ring vertex is placed at
     (r cos th, y, -r sin th), so d/dtheta at theta = 0 is (0, 0, -r):
     the columns advance toward -z while the rows advance up. Wind
     (a, d, b) and the face normal is (d-a) x (b-a) = (0,A,0) x
     (0,0,-C) = (-AC, 0, 0), which points at -x from a vertex sitting
     at +r on x. Inward. Every triangle on the envelope was facing in.

     WHAT THAT LOOKED LIKE was not an inside-out balloon. Front-face
     culling removed the near wall, the far wall's interior rendered
     at its own greater depth — and §2.2's inverted hull, which is the
     BACK side of the same mesh pushed out along aHullN, was therefore
     the NEAREST surface in the silhouette. The whole envelope drew as
     one flat sheet of outline colour: outlineColor(BRAND.token) is a
     dark blue-brown, so it read as a perfectly plausible brown
     balloon with no livery, no terminator and no gores. Setting
     `diffuse` to green changed nothing, because none of it was the
     envelope's material. shots/balloon-03-full.png is that frame.

     Wound (a, b, d) the normal is (b-a) x (d-a) = +x: outward. */
  const idx = [];
  for (let j = 0; j < ROWS; j++) {
    for (let g = 0; g < GORES; g++) {
      for (let c = 0; c < COLS; c++) {
        const a = (g * (COLS + 1) + c) + j * RING;
        const b = a + 1, d = a + RING, e = d + 1;
        idx.push(a, b, d, b, e, d);
      }
    }
  }

  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new T.BufferAttribute(nrm, 3));
  geo.setAttribute('aHullN', new T.BufferAttribute(hul, 3));
  geo.setAttribute('color', new T.BufferAttribute(col, 3));
  geo.setAttribute('uv', new T.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.boundingSphere = new T.Sphere(new T.Vector3(0, FIT.MOUTH + 3.4, 0), 6.2);

  /* ---- the load tapes ----
     Sixteen ribbons on the sixteen seams, riding 3.5 cm proud of the
     fabric. They are rebuilt in the same pass as the envelope because
     they have to move with it — a tape that stayed put through the
     inflation would be sixteen dark wires standing in the air. */
  const tnv = GORES * 2 * (ROWS + 1);
  const tpos = new Float32Array(tnv * 3);
  const tnrm = new Float32Array(tnv * 3);
  const tidx = [];
  for (let j = 0; j < ROWS; j++) {
    for (let g = 0; g < GORES; g++) {
      const a = (g * 2) + j * GORES * 2;
      const b = a + 1, d = a + GORES * 2, e = d + 1;
      tidx.push(a, d, b, b, d, e);
    }
  }
  const tgeo = new T.BufferGeometry();
  tgeo.setAttribute('position', new T.BufferAttribute(tpos, 3));
  tgeo.setAttribute('normal', new T.BufferAttribute(tnrm, 3));
  tgeo.setIndex(tidx);
  tgeo.boundingSphere = new T.Sphere(new T.Vector3(0, FIT.MOUTH + 3.4, 0), 6.3);

  /* ---- the surface ----
     `t` 0 = cold, 1 = flying.

     WHAT A COLD BALLOON ACTUALLY LOOKS LIKE, and the first answer was
     wrong. It was laid out FLAT on the ground in front of the basket,
     which is what a balloon looks like on a launch field and is a
     genuinely lovely image — and it is also nine metres long and
     eleven wide, because a deflated envelope laid out is its own
     circumference. Built and photographed (shots/balloon-02-cold.png):
     it read as a brown tongue floating at chest height, it would not
     fit in any street on the island, and at that radius the load tapes
     were WIDER than the gores they sit on, so the whole object was
     sixteen dark ribbons and no fabric at all.

     What it looks like the other 99% of its life — and what a machine
     the player moors at a door has to be — is fabric DRAPED: the
     throat stays shackled to the burner frame where it always is, the
     envelope loses its air, folds over on itself and slumps down
     around the frame with its skirt on the grass. Three metres across
     and under four tall, which is a thing that fits beside a
     motorcycle, and unmistakably cloth over a structure rather than a
     deflated party balloon.

     So the deflation is TWO numbers and no rigid-body trick at all:
     the centreline TURNS (up to 3.4 radians, folding the fabric back
     over itself) and it SHORTENS (7.30 m of taut envelope becomes
     3.40 m of heap, because crumpled cloth occupies less of its own
     axis). The throat does not move at any point, which also means the
     rigging is static and there is nothing to keep in sync.
     ---------------------------------------------------------------- */
  const CEN = new Float32Array((ROWS + 1) * 3);     // centreline
  const AXT = new Float32Array((ROWS + 1) * 3);     // its tangent
  const RAD = new Float32Array(ROWS + 1);           // ring radius
  const DRD = new Float32Array(ROWS + 1);           // dr/ds, for the hull normal
  const FOLD = 2.05;          // radians the cold envelope folds through
  const HEAP = 3.90;          // metres of axis a cold envelope occupies
  /* AND THEN IT FALLS. The fold alone put the cold envelope in a neat
     arc that ended a metre and a half off the grass — a balloon doing
     a handstand. Cloth with no air in it has weight and nothing to
     hold it up, so every row is pulled down in proportion to how far
     it is from the throat it is hanging from, and the ground clamp
     then pools whatever reaches the lawn. That is the difference
     between "deflated" and "draped". */
  const DROOP = 3.40;
  let builtT = -1;
  const tip = { x: 0, y: FIT.TOP, z: 0, a: 0 };

  function build(t) {
    const fill = clamp01(t);
    const fold = FOLD * (1 - smooth(0.06, 0.90, fill));
    const L = HEAP + (FIT.ENV_H - HEAP) * Math.pow(fill, 0.80);

    /* integrate the centreline row by row */
    let cx = 0, cy = FIT.MOUTH, cz = 0;
    const ds = L / ROWS;
    for (let j = 0; j <= ROWS; j++) {
      const v = j / ROWS;
      /* the fold happens over the first half and then holds, so the
         skirt bends and the crown end is carried round with it */
      const th = fold * smooth(0, 0.55, v);
      const st = Math.sin(th), ct = Math.cos(th);
      AXT[j * 3] = 0; AXT[j * 3 + 1] = ct; AXT[j * 3 + 2] = st;
      CEN[j * 3] = cx; CEN[j * 3 + 1] = cy; CEN[j * 3 + 2] = cz;
      cy += ct * ds; cz += st * ds;

      const m = meridian(v);
      /* per-row fill: the throat swells first and the crown last, which
         is the whole reason this is a morph and not a scale.

         THE FLOOR IS 0.40, NOT 0.085. At 0.085 the cold envelope was
         0.31 m across at its equator — thinner than the 16 load tapes
         laid on it are wide — so a cold balloon rendered as a bundle
         of ribbon. Cloth with the air out of it does not shrink to a
         wire; it slumps to about a third of its inflated section and
         wrinkles hard, which is the `amp` term below. */
      const rf = clamp01((fill - v * 0.30) / 0.70);
      const k = 0.40 + 0.60 * Math.pow(rf, 0.62);
      RAD[j] = m[0] * k;
      DRD[j] = (m[2] * k) / (m[3] * FIT.ENV_H) * (FIT.ENV_H / L);
    }
    /* THE TIP IS WHERE THE FABRIC ENDED, not where the centreline
       did. The crown ring rides this, and the two differ by the whole
       of the droop and the ground clamp — which is 3.4 m on a cold
       envelope, so the first version left a gold ring hanging in the
       air three metres above and three metres in front of a heap of
       canvas. Photographed at shots/balloon-13-moored.png. */
    tip.x = cx;
    tip.y = Math.max(0.12, cy - DROOP * (1 - fill));
    tip.z = cz; tip.a = fold;

    /* ---- vertices ---- */
    let minY = 1e9, maxY = -1e9, maxR = 0;
    for (let j = 0; j <= ROWS; j++) {
      const v = j / ROWS;
      const rf = clamp01((fill - v * 0.30) / 0.70);
      /* slack cloth rumples: the lobe deepens as the panel empties.
         1.5, not 2.4 — at 2.4 the folds came to points and the heap
         read as crumpled paper rather than as nylon. */
      const amp = LOBE * (1 + 1.5 * (1 - rf)) * Math.pow(Math.sin(Math.PI * clamp01(v)), 0.45);
      const droop = DROOP * (1 - fill) * Math.pow(v, 0.85);
      const sb = v * BANDS, sf = sb - Math.floor(sb);
      const sd = Math.min(sf, 1 - sf);
      const dip = 1 - STITCH * Math.max(0, 1 - sd / 0.045);

      const ax = AXT[j * 3], ay = AXT[j * 3 + 1], az = AXT[j * 3 + 2];
      /* ring basis: right is world +x, the other is axis x right */
      const bx = 0, by = az, bz = -ay;
      const ox = CEN[j * 3], oy = CEN[j * 3 + 1], oz = CEN[j * 3 + 2];

      for (let g = 0; g < GORES; g++) {
        for (let c = 0; c <= COLS; c++) {
          const i = (g * (COLS + 1) + c) + j * RING;
          const u = c / COLS;
          const Th = ((g + u) / GORES) * Math.PI * 2;
          const r = RAD[j] * (1 + amp * (Math.sin(Math.PI * u) - SEAM_PULL)) * dip;
          const cth = Math.cos(Th), sth = Math.sin(Th);
          let px = ox + cth * r + bx * sth * r;
          let py = oy + by * sth * r - droop;
          let pz = oz + bz * sth * r;
          /* THE GROUND CLAMP, and it is what makes a deflated balloon
             read as fabric rather than as a squashed balloon. Cloth
             cannot go through a lawn: everything below the local
             ground plane is laid flat on it. Applied in the prop's own
             frame, which parkProp has already pitched to the hill, so
             it follows a cross-slope for free. */
          if (py < 0.05) py = 0.05;
          pos[i * 3] = px; pos[i * 3 + 1] = py; pos[i * 3 + 2] = pz;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
          const rr = Math.hypot(px, pz);
          if (rr > maxR) maxR = rr;

          /* the SMOOTH normal — radial, tipped back along the axis by
             the meridian's own slope. Exactly the un-creased surface
             normal, written straight into aHullN. */
          const rx = cth, ry = by * sth, rz = bx * sth * 0 + bz * sth;
          const d = DRD[j];
          let hx = rx - ax * d, hy = ry - ay * d, hz = rz - az * d;
          const hl = Math.hypot(hx, hy, hz) || 1;
          hul[i * 3] = hx / hl; hul[i * 3 + 1] = hy / hl; hul[i * 3 + 2] = hz / hl;
        }
      }
    }

    /* ---- normals, creased at the seams ----
       One-sided toward the gore's own interior at c = 0 and c = COLS,
       central everywhere else. That is the crease: two coincident
       vertices, two different normals, one hard line of shading down
       every seam. */
    for (let j = 0; j <= ROWS; j++) {
      const jm = Math.max(0, j - 1), jp = Math.min(ROWS, j + 1);
      for (let g = 0; g < GORES; g++) {
        for (let c = 0; c <= COLS; c++) {
          const base = g * (COLS + 1) + c;
          const i = base + j * RING;
          const ia = (c === COLS ? base - 1 : base) + j * RING;
          const ib = (c === COLS ? base : base + 1) + j * RING;
          const ux = pos[ib * 3] - pos[ia * 3];
          const uy = pos[ib * 3 + 1] - pos[ia * 3 + 1];
          const uz = pos[ib * 3 + 2] - pos[ia * 3 + 2];
          const vx = pos[(base + jp * RING) * 3] - pos[(base + jm * RING) * 3];
          const vy = pos[(base + jp * RING) * 3 + 1] - pos[(base + jm * RING) * 3 + 1];
          const vz = pos[(base + jp * RING) * 3 + 2] - pos[(base + jm * RING) * 3 + 2];
          /* u x v, not v x u — the same derivation as the winding
             above, and it has to agree with it or the shading normal
             faces the opposite way from the triangle it is on. */
          let nx = uy * vz - uz * vy;
          let ny = uz * vx - ux * vz;
          let nz = ux * vy - uy * vx;
          const nl = Math.hypot(nx, ny, nz);
          if (nl < 1e-8) { nx = hul[i * 3]; ny = hul[i * 3 + 1]; nz = hul[i * 3 + 2]; }
          else { nx /= nl; ny /= nl; nz /= nl; }
          nrm[i * 3] = nx; nrm[i * 3 + 1] = ny; nrm[i * 3 + 2] = nz;
        }
      }
    }

    /* ---- the tapes, off the finished surface ---- */
    for (let j = 0; j <= ROWS; j++) {
      for (let g = 0; g < GORES; g++) {
        const src = (g * (COLS + 1)) + j * RING;      // the seam column
        const hx = hul[src * 3], hy = hul[src * 3 + 1], hz = hul[src * 3 + 2];
        /* the ribbon runs across the seam: half a tape either side,
           lifted 35 mm proud of the cloth. ITS WIDTH TRACKS THE RING,
           because a fixed 75 mm tape on a slumped 1.2 m section is
           wider than the 0.47 m of gore it is supposed to be sitting
           on, and sixteen of those is a balloon made entirely of
           webbing — which is exactly what the first cold render was. */
        const tw = 0.075 * Math.min(1, Math.max(0.30, RAD[j] / 1.9));
        const ax = -hz, az = hx;                       // a tangent, in plan
        const al = Math.hypot(ax, az) || 1;
        for (let s = 0; s < 2; s++) {
          const o = (g * 2 + s) + j * GORES * 2;
          const w = (s ? 1 : -1) * tw;
          tpos[o * 3] = pos[src * 3] + hx * 0.035 + (ax / al) * w;
          tpos[o * 3 + 1] = pos[src * 3 + 1] + hy * 0.035;
          tpos[o * 3 + 2] = pos[src * 3 + 2] + hz * 0.035 + (az / al) * w;
          tnrm[o * 3] = hx; tnrm[o * 3 + 1] = hy; tnrm[o * 3 + 2] = hz;
        }
      }
    }

    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
    geo.attributes.aHullN.needsUpdate = true;
    tgeo.attributes.position.needsUpdate = true;
    tgeo.attributes.normal.needsUpdate = true;
    /* the culler reads this, and §6 forbids pop-in */
    const cy2 = (minY + maxY) * 0.5;
    geo.boundingSphere.center.set(0, cy2, 0);
    geo.boundingSphere.radius = Math.hypot(maxR, (maxY - minY) * 0.5) + 0.6;
    tgeo.boundingSphere.copy(geo.boundingSphere);
    builtT = fill;
  }

  build(1);

  /* ---- materials ----
     The envelope is the one surface in this game that is BOTH large,
     smooth and lit from behind half the day, so it takes the softest
     band in the vehicle set (bandSoft 0.10 against the paint's 0.075),
     a real subsurface term, and the biggest sky bounce of anything on
     four wheels. `wind` pivots it at the throat so the whole envelope
     leans with the same gust the grass is riding. */
  const envMat = ctx.mat.toon({
    name: 'balloon.envelope',
    color: 0xffffff,                 // the livery is in the vertex stream
    vertexColors: true,
    /* THE BAND HAS TO BE A BAND. The first pass ran bandSoft at 0.100
       — more than three times toon.js's own default — on the theory
       that a big smooth surface wants a soft terminator. It does not:
       at 0.100 the edge spans a fifth of the visible hemisphere and
       what you get is a gradient, i.e. exactly the airbrushed sticker
       the gores exist to prevent. §2.2 asks for a smoothstep over 0.06
       of the terminator and bandSoft is the HALF width, so 0.030 is
       the letter of it; 0.055 is as far as a seven-metre object can
       be pushed and still have an edge you can find in a pixel
       profile. `term` is up at 0.21 so the boundary sits round the
       shoulder where the gores are widest and the scallop is legible,
       rather than on the limb where it would be four pixels of
       silhouette. */
    term: 0.21, bandSoft: 0.055, band2: 0.20,
    spec: 0.07, specPow: 18, specBanded: true,
    rim: 0.40,
    skyBounce: 0.30,
    /* MACRO IS THE OTHER HALF OF THE ANSWER. toon.js's own note calls
       it "metre-scale undulation of the shading normal — what makes a
       large flat surface band", which is this object's exact problem
       stated by the file that solved it for terrain. At 0.26 cycles a
       metre the coarsest lobe is ~5.6 m, so it modulates the
       terminator across the whole envelope rather than adding texture.
       It is weighted by how horizontal a surface is, so it is full
       strength on the crown and a third of it on the flanks — which
       happens to be the right distribution: the crown is the part with
       no gore silhouette to help it. */
    macro: 0.42, macroScale: 0.26,
    /* the back-light. A fabric envelope with the sun behind it glows,
       and it is the one cue that says cloth-over-hot-air rather than
       painted ball. */
    sss: 0.55, sssColor: 0xffd9a0,
    /* LIT FROM THE INSIDE. toon.js's TOON_INGLOW: full strength at the
       throat (object y = MOUTH, where the burner is), gone by a little
       past the crown, and never below 0.16 of it so the top of the
       envelope still reads as the same lit object rather than as a
       dark cap. Multiplied by the gore's own vertex colour inside the
       shader, so an inflated balloon at dusk glows in its OWN livery.
       setBurner() drives the strength; this is only the shape of it. */
    inGlow: [FIT.MOUTH, FIT.MOUTH + FIT.ENV_H * 1.06, 0.16],
    emissiveColor: 0xffbe7a,
    grain: 0.0016, grainScale: 13, grainAlbedo: 0.035, grainShade: 0.20,
    grainFade: [40, 190],
    wind: 0.80, windBase: FIT.MOUTH, windHeight: FIT.ENV_H,
    outline: true, outlineWidth: 3.2,
  });
  const tapeMat = ctx.mat.toon({
    name: 'balloon.tape',
    color: LAND.rockShade,
    term: 0.17, bandSoft: 0.075, band2: 0.13,
    spec: 0.10, specPow: 22, rim: 0.26, skyBounce: 0.12,
    /* THE TAPES GET A THIRD OF THE ENVELOPE'S GLOW, and they need it.
       They are webbing on the OUTSIDE of the fabric, so physically
       they are silhouetted against a lit envelope and would be very
       dark — but "very dark" against a balloon glowing at 1.03 is
       sixteen black bars across the best shot in the feature, and §7
       forbids pure black outright. A third keeps them clearly the
       structure, reading as dark warm ribbon rather than as ink. */
    inGlow: [FIT.MOUTH, FIT.MOUTH + FIT.ENV_H * 1.06, 0.16],
    emissiveColor: 0xffbe7a,
    grain: 0.0018, grainScale: 26, grainAlbedo: 0.060, grainShade: 0.22,
    grainFade: [26, 96],
    wind: 0.80, windBase: FIT.MOUTH, windHeight: FIT.ENV_H,
    outline: false, noOutline: true,
  });
  K.mats.push(envMat, tapeMat);
  K.owned.push(geo, tgeo);

  const env = new T.Mesh(geo, envMat);
  env.name = 'balloon.envelope';
  const tapes = new T.Mesh(tgeo, tapeMat);
  tapes.name = 'balloon.tapes';

  /* THE STROKE'S COLOUR IS PASSED, NOT DERIVED, and it has to be:
     the material's albedo is white so §2.2's "object albedo darkened
     55% and hue-rotated toward blue" would give a white outline on an
     orange balloon. Claimed here as the dominant gore, before
     register() runs — outline() returns the existing hull rather than
     making a second one. */
  ctx.mat.outline?.(env, { color: BRAND.token, width: 3.2 });

  return { env, tapes, build, tip, get inflate() { return builtT; } };
}

/* ==================================================================
   5. A MERGER

   Wicker is forty pieces of geometry and forty draw calls is not what
   a basket is worth, so the weave is baked into one buffer at build
   time. Addons are not available (see BUILD_BRIEF) so this is the
   twenty lines of BufferGeometryUtils this file actually needs.
   ================================================================== */
function mergeGeos(list) {
  const T = THREE;
  let np = 0, ni = 0;
  for (const e of list) {
    const g = e.geo;
    np += g.attributes.position.count;
    ni += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(np * 3);
  const nrm = new Float32Array(np * 3);
  const idx = np > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  const nm = new T.Matrix3();
  const v = new T.Vector3();
  let po = 0, io = 0;
  for (const e of list) {
    const g = e.geo, m = e.matrix;
    nm.getNormalMatrix(m);
    const p = g.attributes.position, n = g.attributes.normal;
    const base = po;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m);
      pos[(po + i) * 3] = v.x; pos[(po + i) * 3 + 1] = v.y; pos[(po + i) * 3 + 2] = v.z;
      if (n) {
        v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
        nrm[(po + i) * 3] = v.x; nrm[(po + i) * 3 + 1] = v.y; nrm[(po + i) * 3 + 2] = v.z;
      }
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[io++] = base + g.index.getX(i);
    else for (let i = 0; i < p.count; i++) idx[io++] = base + i;
    po += p.count;
  }
  const out = new T.BufferGeometry();
  out.setAttribute('position', new T.BufferAttribute(pos, 3));
  out.setAttribute('normal', new T.BufferAttribute(nrm, 3));
  out.setIndex(new T.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/* ==================================================================
   6. THE MACHINE
   ================================================================== */
export function createBalloon(ctx) {
  const T = THREE;
  const K = makeKit(ctx, 'balloon');
  const group = new T.Group();
  group.name = 'wally.balloon';

  /* ---- materials, in the vehicle set's own vocabulary ---- */
  const wickerMat = K.paint(BUILD.wood, {
    name: 'balloon.wicker',
    spec: 0.09, specPow: 18, rim: 0.30, skyBounce: 0.14,
    grain: 0.0021, grainScale: 30, grainAlbedo: 0.085, grainShade: 0.26,
    outlineWidth: 3.0,
  });
  const leatherMat = K.paint(BUILD.woodDark, {
    name: 'balloon.leather',
    spec: 0.14, specPow: 26, rim: 0.24,
    grain: 0.0016, grainScale: 22, grainAlbedo: 0.055,
  });
  const brassMat = K.paint(BUILD.metal, {
    name: 'balloon.brass', color: 0xc0a05a,
    spec: 0.34, specPow: 44, specBanded: true, rim: 0.50,
    grain: 0.0006, grainScale: 26, grainAlbedo: 0.035,
  });
  const ropeMat = K.paint(LAND.rockShade, {
    name: 'balloon.rope', color: 0x8d8272,
    spec: 0.06, specPow: 14, rim: 0.24,
    grain: 0.0018, grainScale: 34, grainAlbedo: 0.070,
  });
  const canvasMat = K.paint(BUILD.stuccoAlt, {
    name: 'balloon.canvas',
    spec: 0.06, specPow: 14, rim: 0.28, skyBounce: 0.20,
    grain: 0.0020, grainScale: 16, grainAlbedo: 0.060,
  });

  /* ==== THE BASKET ====
     A wicker box on ash runners. The MASS is deliberately low and
     wide — a tall basket under a 10 m envelope reads as a lift car —
     and everything above the rim is open frame, so at forty metres
     the silhouette is a dark bar under a big soft shape, which is not
     a bicycle, a scooter or a motorcycle at any distance. */
  const basket = new T.Group();
  group.add(basket);
  const H = FIT.HALF;
  {
    /* --- the runners --- ash skids, and the ground contacts */
    for (const s of [-1, 1]) {
      K.tube(basket, [s * 0.46, FIT.SKID * 0.5, -SKID_Z - 0.06], [s * 0.46, FIT.SKID * 0.5, SKID_Z + 0.06], 0.055, leatherMat);
    }
    /* --- the floor --- */
    K.lump(basket, [0, FIT.DECK - 0.035, 0], [H - 0.02, 0.045, H - 0.02], leatherMat, 8);

    /* --- the walls, as one merged weave ---
       A solid inner shell so you cannot see through the basket, then
       the weave over it: five courses of withy and sixteen uprights.
       §6 forbids an untextured primitive and a plain box IS one, so
       the weave is real geometry rather than a grain map — it is what
       reads at ten metres, and at forty the silhouette needs the
       corner posts to break the box anyway. */
    const parts = [];
    const M = new T.Matrix4();
    const shellG = new T.BoxGeometry(1, 1, 1);
    const rodG = new T.CylinderGeometry(1, 1, 1, 6, 1);
    const wallY = FIT.DECK + FIT.WALL * 0.5;

    /* the shell, four panels so the interior is closed */
    for (let f = 0; f < 4; f++) {
      const a = f * Math.PI / 2;
      M.identity()
        .makeRotationY(a)
        .setPosition(Math.sin(a) * (H - 0.045), wallY, Math.cos(a) * (H - 0.045));
      M.scale(new T.Vector3(H * 2 - 0.09, FIT.WALL, 0.055));
      parts.push({ geo: shellG, matrix: M.clone() });
    }
    /* five courses of withy, running right round */
    for (let c = 0; c < 5; c++) {
      const y = FIT.DECK + 0.10 + c * (FIT.WALL - 0.20) / 4;
      const bow = 0.012 * Math.sin(c * 1.7);
      for (let f = 0; f < 4; f++) {
        const a = f * Math.PI / 2;
        M.identity().makeRotationY(a);
        M.multiply(new T.Matrix4().makeRotationX(Math.PI / 2));
        M.setPosition(Math.sin(a) * (H + 0.012 + bow), y, Math.cos(a) * (H + 0.012 + bow));
        M.scale(new T.Vector3(0.030, H * 2 + 0.05, 0.030));
        parts.push({ geo: rodG, matrix: M.clone() });
      }
    }
    /* the uprights */
    for (let f = 0; f < 4; f++) {
      const a = f * Math.PI / 2;
      for (let k = -2; k <= 2; k++) {
        const off = k * (H * 0.44);
        M.identity().makeRotationY(a);
        M.setPosition(
          Math.sin(a) * (H - 0.005) + Math.cos(a) * off,
          wallY,
          Math.cos(a) * (H - 0.005) - Math.sin(a) * off);
        M.scale(new T.Vector3(0.026, FIT.WALL, 0.026));
        parts.push({ geo: rodG, matrix: M.clone() });
      }
    }
    const weave = mergeGeos(parts);
    shellG.dispose(); rodG.dispose();
    K.owned.push(weave);
    const wm = new T.Mesh(weave, wickerMat);
    wm.name = 'balloon.weave';
    basket.add(wm);

    /* --- the rim --- a padded leather roll, and the thing his hands
       find. It is the basket's one bright edge and the reason he does
       not read as standing in a crate. */
    for (let f = 0; f < 4; f++) {
      const a = f * Math.PI / 2;
      const r = K.tube(basket,
        [Math.sin(a) * H - Math.cos(a) * H, FIT.RIM, Math.cos(a) * H + Math.sin(a) * H],
        [Math.sin(a) * H + Math.cos(a) * H, FIT.RIM, Math.cos(a) * H - Math.sin(a) * H],
        0.058, leatherMat);
      r.name = 'rim';
    }
    /* corner bumpers, in the fleet's brass */
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      K.lump(basket, [sx * H, FIT.RIM, sz * H], [0.075, 0.070, 0.075], brassMat, 8);
    }

    /* --- the Treasury's own equipment ---
       An instrument box on the rim (altimeter and a variometer), a
       sandbag ballast pair on the outside, and a rolled canvas map
       case. These are what make it the ASSESSOR rather than a
       balloon: the machine has a job, and the job is measuring a city
       for its rates. */
    const box = new T.Group();
    box.position.set(-H * 0.42, FIT.RIM + 0.055, H * 0.60);
    box.rotation.y = 0.22;
    K.lump(box, [0, 0, 0], [0.16, 0.055, 0.105], brassMat, 8);
    K.lump(box, [-0.055, 0.048, 0], [0.048, 0.014, 0.048], leatherMat, 8);
    K.lump(box, [0.055, 0.048, 0], [0.048, 0.014, 0.048], leatherMat, 8);
    basket.add(box);
    for (const s of [-1, 1]) {
      K.lump(basket, [s * (H + 0.10), FIT.DECK + 0.20, -H * 0.55], [0.11, 0.145, 0.11], canvasMat, 8);
      K.tube(basket, [s * (H + 0.02), FIT.RIM - 0.02, -H * 0.55], [s * (H + 0.10), FIT.DECK + 0.31, -H * 0.55], 0.014, ropeMat);
    }
    const mapcase = K.lump(basket, [H * 0.55, FIT.DECK + 0.10, -H * 0.30], [0.055, 0.055, 0.30], leatherMat, 8);
    mapcase.rotation.x = 0.06;
  }

  /* ==== THE BURNER FRAME ====
     Four uprights off the basket corners into a brass gimbal ring,
     the burner block under it, and the fuel cylinders standing in the
     basket where the weight belongs. The frame is what stops the
     envelope reading as balanced on a box. */
  const frame = new T.Group();
  group.add(frame);
  {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      K.tube(frame, [sx * H * 0.86, FIT.RIM - 0.05, sz * H * 0.86],
        [sx * 0.20, FIT.POST, sz * 0.20], 0.034, brassMat);
    }
    /* the gimbal ring */
    {
      const g = new T.TorusGeometry(0.30, 0.030, 6, 20);
      K.owned.push(g);
      const m = new T.Mesh(g, brassMat);
      m.position.set(0, FIT.POST, 0);
      m.rotation.x = Math.PI / 2;
      frame.add(m);
    }
    /* the burner block and its two jets */
    K.lump(frame, [0, FIT.BURN, 0], [0.17, 0.10, 0.17], brassMat, 10);
    for (const s of [-1, 1]) {
      K.tube(frame, [s * 0.085, FIT.BURN + 0.06, 0], [s * 0.085, FIT.BURN + 0.20, 0], 0.042, brassMat);
    }
    /* the pilot light — always lit, and the reason a balloon parked at
       dusk is a lantern rather than a lump */
    const pilotMat = ctx.mat.emissive
      ? ctx.mat.emissive({ name: 'balloon.pilot', color: 0xffb04a, intensity: 2.4 })
      : K.paint(BUILD.glassLit, { name: 'balloon.pilot' });
    K.mats.push(pilotMat);
    const pilot = K.lump(frame, [0.085, FIT.BURN + 0.24, 0], [0.030, 0.048, 0.030], pilotMat, 6);
    pilot.name = 'pilot';

    /* THE FLAME. A tapered cone of emissive, hidden until the burner
       fires, scaled on the fly. It is the single loudest thing the
       machine does and it is one mesh. */
    const flameMat = ctx.mat.emissive
      ? ctx.mat.emissive({ name: 'balloon.flame', color: 0xffc463, intensity: 3.4 })
      : K.paint(BUILD.glassLit, { name: 'balloon.flame' });
    K.mats.push(flameMat);
    const fg = new T.ConeGeometry(0.20, 1.05, 10, 3, true);
    K.owned.push(fg);
    const flame = new T.Mesh(fg, flameMat);
    flame.name = 'flame';
    flame.position.set(0, FIT.BURN + 0.72, 0);
    flame.visible = false;
    flame.userData.noOutline = true;
    frame.add(flame);

    /* fuel cylinders, in the corners of the basket he is not standing
       in — they are also why the basket is 1.34 m and not 1.00 m */
    for (const sx of [-1, 1]) {
      const cyl = K.lump(frame, [sx * (H - 0.20), FIT.DECK + 0.29, -(H - 0.20)], [0.115, 0.29, 0.115], brassMat, 10);
      cyl.scale.set(1, 1, 1);
      K.tube(frame, [sx * (H - 0.20), FIT.DECK + 0.56, -(H - 0.20)], [sx * 0.13, FIT.BURN - 0.12, -0.05], 0.020, ropeMat);
    }
    frame.userData.flame = flame;
    frame.userData.pilot = pilot;
    frame.userData.flameMat = flameMat;
  }

  /* ==== THE ENVELOPE ==== */
  const envPart = makeEnvelope(ctx, K);
  const envGroup = new T.Group();
  envGroup.name = 'balloon.envGroup';
  envGroup.add(envPart.env, envPart.tapes);
  group.add(envGroup);

  /* the crown ring and the vent line — the two details that say this
     is a machine somebody maintains */
  const crown = new T.Group();
  {
    const g = new T.TorusGeometry(0.44, 0.038, 5, 16);
    K.owned.push(g);
    const m = new T.Mesh(g, brassMat);
    m.rotation.x = Math.PI / 2;
    crown.add(m);
    crown.position.set(0, FIT.TOP, 0);
    envGroup.add(crown);
  }

  /* the throat lining — a shallow inverted dome you see when you look
     UP the mouth from the ground, which is the angle half of this
     machine's life is spent at. Without it the balloon has a black
     hole in its underside. BackSide, no outline: it is an interior. */
  {
    const g = new T.SphereGeometry(1.22, 16, 6, 0, Math.PI * 2, 0, Math.PI * 0.42);
    K.owned.push(g);
    const throatMat = ctx.mat.toon({
      name: 'balloon.throat',
      color: 0xe8b57a,
      term: 0.10, bandSoft: 0.14, band2: 0.20,
      spec: 0, rim: 0.10, skyBounce: 0.34,
      emissive: 0.10, emissiveColor: 0xffb060,
      grain: 0.0014, grainScale: 14, grainAlbedo: 0.05,
      side: T.BackSide,
      outline: false, noOutline: true,
    });
    K.mats.push(throatMat);
    const m = new T.Mesh(g, throatMat);
    m.name = 'balloon.throat';
    m.position.set(0, FIT.MOUTH + 0.06, 0);
    m.userData.noOutline = true;
    envGroup.userData.throat = m;
    envGroup.userData.throatMat = throatMat;
    envGroup.add(m);
  }

  /* ==== THE RIGGING ====
     Eight cables from the throat's load ring down to the frame. They
     live in their own group so the inflation can re-aim them without
     rebuilding anything: a cable is a capsule, so pointing it is a
     quaternion and a scale. */
  const rig = new T.Group();
  group.add(rig);
  const cables = [];
  {
    const cg = new T.CapsuleGeometry(0.016, 1, 2, 6);
    K.owned.push(cg);
    for (let i = 0; i < 8; i++) {
      const m = new T.Mesh(cg, ropeMat);
      m.name = 'cable' + i;
      rig.add(m);
      cables.push(m);
    }
  }
  const _ca = new T.Vector3(), _cb = new T.Vector3(), _cd = new T.Vector3();
  const UP = new T.Vector3(0, 1, 0);
  /* STATIC, AND THAT IS THE POINT. The throat is shackled to the
     burner frame and stays there whether the envelope is full or
     folded (see build()'s header), so the eight load cables are the
     same eight cables at every inflation. The first version re-aimed
     them every frame of the inflation against a moving mouth, which
     was two descriptions of one geometry and they disagreed. */
  {
    const rMouth = 1.20;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      _ca.set(Math.cos(a) * rMouth, FIT.MOUTH - 0.14, Math.sin(a) * rMouth);
      _cb.set(Math.cos(a) * 0.26, FIT.POST - 0.02, Math.sin(a) * 0.26);
      _cd.subVectors(_ca, _cb);
      const len = Math.max(_cd.length(), 0.02);
      const m = cables[i];
      m.position.copy(_cb).addScaledVector(_cd, 0.5);
      m.quaternion.setFromUnitVectors(UP, _cd.normalize());
      m.scale.set(1, Math.max(len - 0.032, 0.01), 1);
    }
  }

  /* ==== THE SKIDS AS CONTACTS ====
     Two empties standing in for wheels. parkProp reads `wheels[]`,
     takes each one's position.y as its rolling radius and walks the
     parent chain for its z, then pitches the machine to the chord
     through the two — see rides.js finish() and bike.js
     solveParkPose. A skid's "rolling radius" is the height of the
     origin over its own contact patch, which is zero: the origin IS
     on the contact plane. y is therefore the solver's floor value
     (0.02), not a lie about a wheel. */
  const wheels = [];
  for (const z of [SKID_Z, -SKID_Z]) {
    const w = new T.Object3D();
    w.position.set(0, 0.02, z);
    w.visible = false;
    group.add(w);
    wheels.push(w);
  }

  /* ==== THE MOORING ====
     Every other machine parks on a stand it leans onto. A balloon
     does not lean — it is a box on two runners and it stands level.
     `standFoot` is therefore the runner's own outer edge with the
     lean at zero, so solveParkPose's cross-slope conform has a real
     contact to work from and park() writes a roll of 0 on flat
     ground. The mooring line and its iron peg are what appear
     instead of a kickstand: a moored balloon is a machine somebody
     tied down, and that is the visual that says "left here on
     purpose". */
  const stand = new T.Group();
  stand.name = 'kickstand';
  {
    K.tube(stand, [H * 0.9, FIT.DECK + 0.06, H * 0.55], [H + 1.05, 0.055, H * 0.95], 0.016, ropeMat);
    const peg = K.tube(stand, [H + 1.05, 0.30, H * 0.95], [H + 1.08, -0.02, H * 0.96], 0.028, brassMat);
    peg.name = 'peg';
  }
  stand.visible = false;
  group.add(stand);

  return finishBalloon(ctx, group, {
    envGroup, envPart, basket, frame, rig, crown, wheels, stand,
  }, K);
}

/* ==================================================================
   6b. THE COLLAPSE — one draw call per material, and why it matters
       more here than on anything else in the ride ladder.

   MEASURED FIRST. The machine built as forty-eight separate meshes
   cost 177 DRAW CALLS a frame, differenced against the same frames
   with the prop toggled out (WALLY.debug.balloonCost). The whole
   frame on foot is 706, so one prop was a quarter of the budget —
   and the reason is not the triangles (8 814 of them, less than the
   motorcycle) but the COUNT: every mesh is drawn in the main pass,
   the depth-normal prepass and both shadow cascades, and §2.2 gives
   every one of them a second inverted-hull mesh in the outline pass.
   Forty-eight parts is therefore about two hundred draws before a
   single triangle is considered.

   Almost none of those parts ever move relative to each other. The
   basket does not articulate, the burner frame is welded, the load
   cables are static (see the rigging note). So everything that is
   rigid AND shares a material is baked into one buffer at build
   time — one draw, one hull, one shadow — and only the things that
   genuinely animate are left alone:

     the envelope and its tapes   morphed every frame by setInflate
     the crown ring               rides the fabric's measured tip
     the throat lining            scales and fades with the inflation
     the flame                    scaled and moved by setBurner
     the mooring                  toggled by park()

   It runs BEFORE ctx.mat.register so the hulls are built for the
   merged meshes rather than for the parts they replaced.
   ================================================================== */
const NO_MERGE = new Set([
  'balloon.envelope', 'balloon.tapes', 'balloon.throat', 'flame', 'pilot',
]);
function collapse(group, K) {
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const buckets = new Map();
  const _m = new THREE.Matrix4();
  group.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.material) return;
    if (NO_MERGE.has(o.name) || o.userData.noMerge) return;
    /* anything under a group that is itself animated stays put */
    for (let p = o.parent; p && p !== group; p = p.parent) {
      if (p.name === 'balloon.envGroup' || p.name === 'kickstand') return;
    }
    const key = o.material;
    let b = buckets.get(key);
    if (!b) { b = []; buckets.set(key, b); }
    b.push(o);
  });
  let merged = 0, saved = 0;
  for (const [mat, list] of buckets) {
    if (list.length < 2) continue;
    const parts = list.map((o) => ({ geo: o.geometry, matrix: _m.copy(inv).multiply(o.matrixWorld).clone() }));
    const g = mergeGeos(parts);
    K.owned.push(g);
    const m = new THREE.Mesh(g, mat);
    m.name = (mat.name || 'balloon') + '.merged';
    group.add(m);
    for (const o of list) o.parent.remove(o);
    merged++; saved += list.length - 1;
  }
  group.userData.collapsed = { merged, saved };
  return group;
}

/* ==================================================================
   7. The live API — the same surface rides.js publishes, so wally.js
      can treat four machines as one kind of thing, plus the four
      calls only a balloon has.
   ================================================================== */
function finishBalloon(ctx, group, spec, K) {
  const T = THREE;
  collapse(group, K);
  if (ctx.mat.register) ctx.mat.register(group, { castShadow: true, receiveShadow: true });
  group.traverse((o) => { if (o.isMesh) o.frustumCulled = true; });

  const flame = spec.frame.userData.flame;
  const flameMat = spec.frame.userData.flameMat;
  const throatMat = spec.envGroup.userData.throatMat;
  const envMat = spec.envPart.env.material;
  const tapeMat = spec.envPart.tapes.material;

  let inflate = 1;
  let burnT = 0, burnVis = 0;
  let odo = 0;
  let parked = false;
  /* the burner light's world position, reused — see setBurner */
  const _lit = new T.Vector3();

  const api = {
    group,
    kind: 'balloon',
    /* --- the ride prop contract (rides.js finish) --- */
    SADDLE: { x: 0, y: FIT.DECK, z: 0 },
    BARS: { x: 0, y: FIT.RIM, z: FIT.HALF },
    REST: { y: FIT.DECK, z: 0 },
    PEDAL: { y: FIT.DECK, z: 0, r: 0 },
    wheels: spec.wheels,
    steer: null,
    stand: spec.stand,
    crank: null,
    R: 0.02,
    get odometer() { return odo; },
    /* how much room the parked machine needs beside another one.
       wally.js's parkOffsetX defaults to 1.0 m for a bicycle, which is
       the widest thing on wheels. A moored balloon is a basket with
       its envelope draped round it: measured off the built prop at
       inflation 0 it is 3.2 m across, so 2.6 m of clearance keeps the
       fabric out of whatever else he left at the same door. */
    parkClear: 2.6,

    /** Distance rolled. There is nothing to turn — a balloon has no
        contact with the ground while it works — so this is the
        odometer and nothing else. Kept because wally.js's bikeUpdate
        calls roll() on every machine unconditionally. */
    roll(metres) {
      const d = Number.isFinite(metres) ? metres : 0;
      odo += d;
      if (!Number.isFinite(odo)) odo = 0;
      return odo;
    },
    setCrankPhase() {},
    /** No steering group. The basket's yaw is written on `root` by
        wally.js, exactly like the bicycle's lean. */
    setSteer() {},
    get steerAngle() { return 0; },

    /* --- the balloon's own four --- */

    /**
     * 0 = cold and laid out on the ground, 1 = flying.
     *
     * THE COST IS PAID ONLY WHEN IT MOVES. The morph is 1 520
     * vertices of trig and it rebuilds nothing at all when `t` has
     * not changed by a tenth of a percent — so a balloon standing in
     * a field and a balloon at 200 m both cost zero here, and the
     * only frames that pay are the four seconds of inflation.
     */
    setInflate(t) {
      const v = clamp01(t);
      if (Math.abs(v - inflate) < 1e-3 && spec.envPart.inflate >= 0) return api;
      inflate = v;
      spec.envPart.build(v);
      /* THE CROWN RING RIDES THE MEASURED TIP, not a second copy of
         the centreline arithmetic. build() leaves where the fabric
         actually ended and which way it was pointing when it got
         there, and this reads it — two formulae for one position is
         how the crown ends up floating a metre off the envelope on
         every value of t but 0 and 1. */
      const tip = spec.envPart.tip;
      spec.crown.position.set(tip.x, tip.y, tip.z);
      spec.crown.rotation.x = tip.a;
      /* the throat is SHACKLED to the burner frame and does not move —
         see build()'s header. Only its lining fades, because a cold
         envelope has no inside to look up into. */
      const th = spec.envGroup.userData.throat;
      th.scale.setScalar(0.45 + 0.55 * v);
      th.visible = v > 0.34;
      return api;
    },
    get inflation() { return inflate; },

    /**
     * The burner. `on` lights it; `heat` 0..1 drives how much of the
     * envelope it lights from inside.
     *
     * THE FLAME IS DAMPED, NOT SWITCHED. A jet that appears and
     * disappears between two frames is a sprite; one that punches up
     * over 90 ms and dies back over 300 reads as combustion, and the
     * asymmetry is the whole tell.
     */
    setBurner(on, heat, dt) {
      const d = Number.isFinite(dt) ? Math.min(dt, 0.1) : 1 / 60;
      burnT = on ? Math.min(1, burnT + d * 11) : Math.max(0, burnT - d * 3.4);
      /* a real jet roars unevenly */
      const flick = 1 + Math.sin(ctx.elapsed * 41) * 0.06 + Math.sin(ctx.elapsed * 17.3) * 0.05;
      burnVis = burnT;
      flame.visible = burnT > 0.02 && inflate > 0.05;
      if (flame.visible) {
        flame.scale.set(0.55 + burnT * 0.55, burnT * flick, 0.55 + burnT * 0.55);
        flame.position.y = FIT.BURN + 0.18 + burnT * 0.54;
        if (flameMat.uniforms?.uEmissive) flameMat.uniforms.uEmissive.value = 2.2 + burnT * 2.6;
      }
      /* ---------------------------------------------------------------
         THE ENVELOPE LIGHTS FROM INSIDE — the single most balloon-like
         thing this machine does, and the constant that carried it was
         an order of magnitude too small. glow * 0.085 is 0.09 at full
         burn against a lit surface of about 1.0: a nine per cent lift,
         which is under half of the animated film grain. Photographed
         at 22:00 over the city (shots/fa/before-night-on.png) the
         result was a warm dot at the throat and a GREY BALL above it,
         dimmer than every window in the town behind it, and the whole
         of the rest of the machine — Wally, the basket, the rigging,
         the ground — untouched, because there was no light source in
         this file at all.

         Three things now, and they are three because a balloon at
         night is three separate cues:

           THE THROAT is the furnace. It crosses postfx's 1.7 bloom
           threshold at night so the mouth actually flares.

           THE FABRIC is lit from within, through toon.js's TOON_INGLOW
           — brightest at the throat and falling to a sixth of that at
           the crown, multiplied by the gore's own colour so the livery
           shows rather than an amber wash. See the envMat options.

           AND THERE IS A LIGHT. ctx.mat.setLocalLight() is the one
           local source the toon pipeline has; this is its only caller.
           It sits a little above the jets so the basket rim, the
           uprights, the rigging, the rider and — on a take-off or a
           landing — the grass all catch it.

         ALL THREE COMPETE WITH THE SUN, which is why `dark` is here.
         A burner's absolute output does not change at noon; its
         SIGNIFICANCE does, and an additive term strong enough to be
         the drama at 22:00 is strong enough at 13:00 to push a lit
         envelope onto the ACES shoulder and flatten the two-band ramp
         the gores were built to protect. Measured sun intensity is
         0.10 at 22:00, 0.24 at 19:00 and 0.76 at 13:00, so the 1.6
         power leaves 0.92 of the effect at night, 0.71 at dusk and
         0.15 at noon: a blush on the underside of the fabric by day,
         a lantern by night, and the same code doing both.
         --------------------------------------------------------------- */
      const glow = burnT * 0.9 + (Number.isFinite(heat) ? heat : 0) * 0.16;
      const sunI = ctx.mat?.globals?.uSunIntensity?.value ?? 1;
      const dark = Math.pow(clamp01(1.05 - sunI), 1.6);
      if (throatMat.uniforms?.uEmissive) {
        throatMat.uniforms.uEmissive.value = 0.12 + glow * (0.85 + 1.15 * dark) * flick;
      }
      if (envMat.uniforms?.uEmissive) {
        const e = glow * (0.10 + 0.95 * dark);
        envMat.uniforms.uEmissive.value = e;
        if (tapeMat.uniforms?.uEmissive) tapeMat.uniforms.uEmissive.value = e * 0.34;
      }
      if (ctx.mat?.setLocalLight) {
        if (burnT > 0.02 && inflate > 0.05) {
          _lit.set(0, FIT.BURN + 0.30, 0).applyMatrix4(group.matrixWorld);
          ctx.mat.setLocalLight(_lit, BURN_LIGHT,
            burnT * flick * (0.45 + 0.55 * dark) * 1.15, 20.0);
        } else {
          ctx.mat.setLocalLight(null);
        }
      }
      return api;
    },
    get burner() { return burnVis; },

    /** Where the envelope's centre of volume is, prop-local — the
        collision probe reads it, and it moves with the inflation. */
    get envelopeCentre() {
      return { x: 0, y: FIT.MOUTH + FIT.ENV_H * 0.42 * inflate, z: 0, r: FIT.ENV_R * (0.12 + 0.88 * inflate) };
    },

    /* --- parked, in the same words the other three use --- */
    park(on = true, roll) {
      parked = !!on;
      spec.stand.visible = !!on;
      group.rotation.z = on ? (Number.isFinite(roll) ? roll : 0) : 0;
      /* A MOORED BALLOON IS A COLD BALLOON, and saying so here rather
         than at the call site is what makes every path correct. The
         landing animation has already walked the inflation down to
         zero by the time it parks, so this is a no-op there — but
         wally.js's restoreParked() stands a machine up straight out of
         a save with no landing in front of it, and without this line
         it came back fully inflated and moored to a peg. Measured, and
         it is exactly the sort of thing only an end-to-end reload test
         catches. `park(false)` deliberately does NOT touch it: the
         boarding owns the inflation on the way back up. */
      if (on) api.setInflate(0);
      return api;
    },
    get parked() { return parked; },
    /** A balloon stands level. There is no stand to lean onto, so the
        park lean is zero and solveParkPose's cross-slope conform is
        the only roll it ever gets. */
    get parkLean() { return 0; },
    get standFoot() { return { x: FIT.HALF + 1.05, y: 0.055, z: FIT.HALF * 0.95 }; },

    dispose() {
      /* the local light is a GLOBAL uniform, so a disposed balloon that
         was burning would leave a hearth hanging in the middle of the
         world lighting nothing */
      if (burnT > 0) ctx.mat?.setLocalLight?.(null);
      group.parent?.remove(group);
      K.dispose();
    },
  };
  return api;
}

export default { createBalloon, FIT, FLIGHT, stepFlight, newFlight };
