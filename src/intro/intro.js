/* ============================================================
   intro.js — ctx.intro. The first thirty seconds.

   The original 2D game booted like an arcade cabinet: CRT sweep, POST
   text, a memory count, then a logo slam over PRESS START. What is
   worth keeping from that is not the CRT — it is the *shape*: a long
   patient build, one hard hit, and a skip chip in the corner the
   whole time. This is that shape, cut for a 3D game, and the thing it
   shows off is the island rather than a fake monitor.

     0.000  SEQ A   the sea at dawn, low to the water, gulls, drifting
    11.111  SEQ B   crane up and back — the island, whole
    20.000  SEQ C   drop into the city and find him on the bicycle
    26.667  SEQ D   he stops; push in
    31.111          TITLE — on bar 7, on the sting
    34.667          release to the player

   Four ctx.cam.cinematic() calls, so three hard cuts, all on bar
   lines of the 54 bpm `cinematic` score. See shots.js for why each
   camera sits where it does.

   ------------------------------------------------------------------
   THINGS THIS FILE IS CAREFUL ABOUT
   ------------------------------------------------------------------
   * It does not run when ctx.flags.shot or ctx.flags.skipIntro is
     set. The screenshot harness always sets `?shot=1`, and every
     other agent's reference shot depends on that staying true. The
     debug hooks below still work, because they are explicit.
   * The cinematic delivers Wally to the position he was spawned at.
     Nothing teleports at the hand-over — the last frame of the intro
     and the first frame of gameplay are the same pose in the same
     place, which is the only way a skippable opener can "land cleanly
     in gameplay".
   * Skipping is a 0.22 s dip to black, then the restore, then a
     0.55 s lift back out. Cutting straight from a 292 m aerial to a
     4.2 m follow boom is a lurch; a dip is what an editor would do.
   * scene.fog is 60/420 by default and the aerials need ~2600 m of
     visibility. This module is boot stage 13, so its update() runs
     after sky.update() and its fog write is the one that survives to
     the render. It stops writing at the end and sky restores its own
     values on the very next frame — nothing is left mutated.
   * prefers-reduced-motion gets no flight at all: one held frame, the
     title, and out.
   ============================================================ */

import { clamp, damp } from '../core/contracts.js';
import { createTitleCard } from './titlecard.js';
/* THE PARKED POSE SOLVE, IMPORTED RATHER THAN TRANSCRIBED. This file
   used to carry its own copy of the arithmetic and its own copy of the
   48-degree clamp, with a note saying it "cannot be imported" because
   intro.js reaches other SUBSYSTEMS through ctx. That rule is about
   subsystems; bike.js is a prop factory, and shots.js right next door
   has imported createBike from it since the day there stopped being two
   bicycles in this game. The transcription is what the rule actually
   cost: the copy here shipped a generation behind, clamping at 14.9
   degrees on a stage picker that accepts 22.8, and buried a wheel
   340 mm at 45 degrees. One solve, one clamp. */
import { solveParkPose } from '../character/bike.js';
import {
  storyboard, chooseStage, MARKS, TIMING, RIDE, ridePath, rideSpeed,
  createGulls, setRideProfile, airAlt, airSink,
} from './shots.js';
/* WHAT HE ARRIVES ON, and the four machines it can be. See arrival.js
   for why there is no "advanced bicycle" and for how the save is read. */
import { ARRIVAL, pickArrival, createArrivalProp } from './arrival.js';

/* NO SADDLE HEIGHT AND NO CRANK RATIO LIVE HERE ANY MORE. Both used
   to: SADDLE_Y 0.92 lifted the rider onto the intro's own bicycle, and
   CRANK_TURNS_PER_M 1/2.2 set the leg cadence while shots.js set the
   crank from the wheel at one turn per 5.017 m. Two constants for one
   drivetrain is how they came to disagree by 2.28x. The prop publishes
   its saddle and the CLIP publishes its cycle; see driveCharacter. */

/* The opener is a sunrise: 06:03 on the water, 07:21 by the title.
   A debug seek has to jump the sky as well as the clock, or every
   reference shot of the hero and the title card comes back lit for
   the wrong hour. */
const HOUR0 = 6.05, HOUR1 = 7.35;

export async function init(ctx) {
  const T = ctx.THREE;

  const reduced = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------- state ---------------- */
  let card = null;
  let board = null;
  let gulls = null;
  let bike = null;             // the arrival machine, whichever one it is
  let ride = ARRIVAL.bike;     // its staging record
  let owned = false;           // ...and whether the save says it is HIS

  let armed = false;            // props built, world state saved
  let running = false;
  let finished = false;
  let clock = 0;
  let beat = -1;                // index into BEATS
  let outro = null;             // { phase, t, reason }
  let retire = null;            // { t } — the arrival bicycle, waiting to be collected
  let bikeShown = false;        // it has been in shot at least one frame
  let bikeParked = false;       // parkArrival() has stood it on its stand
  let handoff = null;           // { id, t } — his own machine, changing hands
  let parkPose = null;          // the solved world pose parkArrival() used
  let fogNear = 60, fogFar = 420;
  let fogTarget = [60, 420];

  const saved = {};
  let stage = null;
  const anchor = new T.Vector3();

  const BEATS = ['sea', 'island', 'arrival', 'hero'];
  const hourAt = (t) => HOUR0 + (HOUR1 - HOUR0) * clamp(t / TIMING.end, 0, 1);

  /* ================================================================
     Setup of the world state the cinematic borrows
     ================================================================ */
  function arm() {
    if (armed) return true;
    if (!ctx.cam?.cinematic) return false;
    armed = true;

    card = card || createTitleCard(ctx);

    /* ================================================================
       WHAT HE ARRIVES ON, DECIDED BEFORE ANYTHING IS STAGED.

       This has to be the first thing arm() does, because everything
       downstream of it is machine-specific: setRideProfile() rewrites
       the road length that chooseStage probes a corridor for, and the
       storyboard's SEQ C is built out of positions on that road — or,
       for the balloon, is a different sequence entirely.

       A BRAND-NEW PLAYER IS EXACTLY WHAT IT WAS. pickArrival() answers
       { id: 'bike', owned: false } for a first boot, a wiped save, a
       save with nothing bought, and for a headless build with no game
       module at all — one answer, four ways of having nothing — and
       every line below that branches on `owned` takes the same branch
       it took before this existed.

       AND IF IT IS HIS, IT IS NOT ALSO PARKED SOMEWHERE. He is riding
       in on it; a machine cannot be under him and standing outside the
       café at the same time. wally.js's restoreParked() would stand a
       second one up off that record within half a second of boot, so
       the record is cleared here rather than reconciled later. */
    const pick = pickArrival(ctx);
    ride = ARRIVAL[pick.id] || ARRIVAL.bike;
    owned = !!pick.owned;
    setRideProfile(ride.id);
    if (owned) { try { ctx.game?.actions?.clearParkSpot?.(ride.id); } catch (e) { /* headless */ } }

    /* Where he is standing right now is where the cinematic WANTS to
       end. chooseStage only moves him if the city has boxed his spawn
       in — see the note in shots.js — and reports how far it went. */
    if (ctx.wally) anchor.copy(ctx.wally.position);
    else anchor.set(0, 0, 0);
    anchor.y = ctx.world?.heightAt?.(anchor.x, anchor.z) ?? anchor.y;
    stage = chooseStage(ctx, anchor);
    anchor.copy(stage.anchor);

    saved.timeScale = ctx.sky?.timeScale ?? 0;
    saved.grade = typeof ctx.sky?.grade === 'string' ? ctx.sky.grade : 'day';
    saved.yaw = ctx.wally?.rotation?.y ?? 0;

    board = storyboard(anchor, ctx.world?.heightAt, stage.yaw);

    /* Dawn, and the sun keeps rising through the whole opener: 06:03
       on the water, 07:21 by the title. The score, the grade, the
       shadow length and the sea colour all move with it, which is
       most of why four cut sequences do not feel like four unrelated
       postcards. */
    ctx.sky?.setHour?.(HOUR0);
    ctx.sky?.setTimeScale?.((HOUR1 - HOUR0) / TIMING.end);

    gulls = createGulls(ctx, {
      from: board.sea.shots[0].position,
      toward: board.sea.shots[0].target,
    });
    ctx.scene.add(gulls.group);

    bike = createArrivalProp(ctx, ride.id);
    bike.group.visible = false;
    ctx.scene.add(bike.group);

    ctx.wally?.setControlled?.(false);
    card.chrome(false);
    return true;
  }

  /* ================================================================
     Cues — one-shot beats, replayed in order when seeking
     ================================================================ */
  function startRide() {
    if (!ctx.wally) return;
    bike.group.visible = true;
    bikeShown = true;
    /* Off the stand: a seek can arrive here from the hero mark, where
       the machine was parked. driveCharacter writes position and yaw
       every frame but never the lean or the kickstand. */
    bike.unpark();
    bikeParked = false;
    /* ---- THE POSTURE, AND THE BALLOON HAS NONE ----
       Three of the four machines have a ride clip (anim.js
       'ride-bicycle' / 'ride-scooter' / 'ride-moto'); the balloon has
       none, because wally.js's own flight code does not use one
       either — its words are "HE IS STANDING, NOT SEATED", and it
       stands him in the basket on the plain locomotion layer with
       locoSpeed 0. Doing the same here is not a shortcut: it is the
       reason the balloon's hand-over is arm-continuous for free, since
       the pose he is in aboard the machine already IS the pose the
       game holds when it takes him back. */
    if (ride.clip) ctx.wally.play(ride.clip, { loop: true, fade: 0.28, speed: 1.6 });
    else { ctx.wally.release?.(0.20); ctx.wally.setLocomotion?.(0, 0); }
    /* NO setFootIK(false) HERE, and that is a measured decision rather
       than an oversight. wally.js kills the terrain foot conform the
       moment he mounts in gameplay ("his feet are on a machine"), so
       the obvious move is to do the same for the cutscene. Measured
       across this shot it changes nothing: ankle-to-pedal drift 24.4 mm
       with the conform off against 24.0 mm with it on. It never bites
       because the conform only presses a PLANTED foot down and the ride
       pose never plants one. Three extra writes into a state machine
       that also has a skip path and a seek path, for 0.4 mm, is a worse
       trade than leaving it alone. */
  }

  /* The C -> D cut. He is pedalling on one side of it and standing in
     the reference 'cool' pose on the other, which is how a film gets
     a character off a bicycle without an animation for it. */
  function dismount() {
    const g = board.groundY(0, 0);
    if (ctx.wally) {
      ctx.wally.root.position.set(anchor.x, g, anchor.z);
      ctx.wally.root.rotation.y = board.yaw;
      ctx.wally.pose('cool', { fade: 0.001, instant: true });
    }
    parkArrival();
  }

  /* ------------------------------------------------------------------
     STANDING THE ARRIVAL BICYCLE ON ITS STAND — and it is a separate
     function because the C -> D cut is not the only way out of the
     opener.

     SKIPPING IS THE COMMON PATH AND IT USED TO LEAVE THE MACHINE IN
     MID-AIR. finish('skip') routes through restoreWorld(), which sets
     the retire timer, but the hero cue that calls this never runs — so
     a skip taken while he is still pedalling dropped the bicycle
     wherever the ride had got to. Measured, Space at t = 24 s: left at
     [0.89, 14.53, -2.44] with rotation.x 0, rotation.z 0 and the
     kickstand hidden, standing unsupported in the grass 2.6 m from the
     player, drawn, until he looked away and the retire timer collected
     it. Every other machine in this game leans on a stand when it is
     left somewhere — the gameplay props have since parkProp() in
     wally.js, and the fix there is what exposed the kickstand being on
     the opposite side from the lean. The one machine the player is
     guaranteed to meet was the one still breaking the rule.

     IT PARKS AT THE HERO MARK, NOT WHERE THE RIDE HAD GOT TO, because
     restoreWorld() puts WALLY at the anchor too: skipping and watching
     now land in the same world state, which is this file's own rule
     about the last frame of the opener and the first frame of play
     being the same pose in the same place. The move happens behind the
     0.22 s dip to black that finish('skip') raises before restoreWorld
     runs, so nothing is ever seen to teleport.

     RE-MEASURED, AND THE RIDE HAS TO BE HIT BY SEEKING TO IT. A wall
     clock cannot: the director's clock is driven by the frame loop, so
     on a loaded machine 24 seconds of wall time lands three seconds of
     film short — two runs four seconds apart both arrived at director
     t = 15.3, in SEQ B, with no bicycle in shot at all. Seeking to
     MARKS[5] and skipping 1.5 s into the pedal, and again from
     MARKS[4]: mid-ride the machine is at [3.00, 14.77, -8.25], upright,
     stand hidden, rotation order XYZ; after Space it is at [1.95,
     14.54, -0.83] on rotation order YXZ, pitched -0.42 deg, leaning
     -6.11 deg on its stand with the kickstand out, 2.12 m from the
     player — and BOTH WHEEL CONTACTS MEASURE 0.0 mm against
     ctx.world.heightAt. (The lean was -7.40 in this note and -7.45 in
     fact — PARK_LEAN is -0.13 rad, which is 7.4485 degrees — and it is
     now neither, because the roll is conformed to the pad's 1.34
     degrees of cross-slope. See parkArrival.) The same
     placement, to the centimetre, whether
     the opener is watched to the C -> D cut or skipped from either
     arrival mark, which is what "the same world state" was supposed to
     mean.
     ------------------------------------------------------------------ */
  function parkArrival() {
    if (!bike || bikeParked) return;
    bikeParked = true;
    /* Parked behind his left shoulder: out of the lens' path to his
       face, still legible as the thing he arrived on.

       THE OFFSET IS THE MACHINE'S. 1.45/1.55 is a bicycle's; a
       Thunderhead is longer and a moored balloon is 3.2 m of basket
       and cold envelope (balloon.js's own measurement), and both of
       them at a bicycle's offset put geometry across the hero lens'
       path to his face. arrival.js carries one pair per machine. */
    const px = anchor.x - board.f.x * ride.park[0] - board.r.x * ride.park[1];
    const pz = anchor.z - board.f.z * ride.park[0] - board.r.z * ride.park[1];
    bike.group.visible = true;
    bikeShown = true;
    /* Cold before she is moored. balloon.js's park() walks the
       inflation to zero on its own; the FLAME is the caller's, and a
       lit burner under a folded envelope is nobody's intent. */
    bike.setBurner(false, 0, 1);

    /* SIT IT ON THE CHORD THROUGH BOTH WHEELS, not on one height
       sample under the frame origin. chooseStage() picks the stage for
       the CITY around it, not for its gradient, so the hero shot is
       not guaranteed a flat pad — and a single sample puts one wheel
       under the ground by the wheelbase times the slope.

       IT IS THE SAME SOLVE AS wally.js parkProp(), NOW INCLUDING THE
       PARTS THAT WERE ADDED AFTER THIS WAS COPIED FROM IT. It was a
       generation behind in both of them, and the second one was live:

         * THE CLAMP WAS 0.26 rad — 14.9 degrees, the number parkProp
           used before it moved to the controller's own 48-degree slope
           limit. chooseStage() accepts a pad at slope 0.42, which is
           22.8 degrees, so the opener's stage picker could hand this
           function ground half again as steep as its own clamp would
           allow and it would saturate on it. MEASURED, both solves over
           the same sites, wheel contacts against heightAt in mm:

             gradient   at 0.26 rad      at PARK_PITCH_MAX
             -14.90       0.0 /   0.0      0.0 / 0.0
             -17.60     -23.2 / +23.3      0.0 / 0.0
             -22.51     -67.3 / +67.5      0.0 / 0.0   <- inside slope 0.42
             -29.54    -136.6 /+136.6      0.0 / 0.0
             -45.14    -340.4 /+331.0      0.0 / 0.0

           A minus is a wheel UNDER the terrain, which is the reading
           that matters: the old clamp did not merely stop conforming
           past 14.9 degrees, it buried the downhill wheel.
         * THE SECOND SAMPLING PASS WAS MISSING. Rotating about the
           origin shortens each contact's reach to z*cos(pitch), so the
           heights that set the pitch are not read where the wheels come
           to rest. On a plane it cancels exactly; where the ground
           breaks slope between sample and contact the machine floats by
           the difference — 111.5 mm at BOTH wheels on the case that
           forced this into parkProp.
         * AND NOTHING GOES UNDER THE GROUND once the clamp does engage:
           the origin is lifted by the residual so the deeper contact
           sits ON the terrain and the shallower one hovers. A wheel a
           few centimetres clear reads as a machine parked awkwardly; a
           buried one reads as a bug.

       IT IS NOT A COPY ANY MORE. All three of those repairs were made
       by hand in two files, and the next generation of the solve — the
       fixed-point iteration that removed the off-lattice residual, and
       the roll conform that put the kickstand on the ground — would
       have had to be made by hand in two files again. It is
       solveParkPose in bike.js and this function passes it the intro's
       own ground function. The stage's ground REPLACES the terrain for
       the arrival mark (board.groundY is the pad, not heightAt), which
       is exactly why the solve takes its sampler as an argument.

       At the shipped hero mark almost none of this fires — the pad is
       0.42 degrees fore-and-aft and both contacts measure 0.0 mm either
       way. The ROLL does: the pad has 1.34 degrees of cross-slope under
       the stand, so the conformed roll comes back -6.11 rather than the
       flat-ground -7.45. Re-measured through the shipped opener: roll
       -6.105 against the -7.4485 lean, so r - lean = 1.343 degrees and
       the identity r = lean + phi holds to three decimals on the one
       pose solveParkPose's header used to call untouched by the roll
       solve. The DESIGN contact point reads 0.000 mm against the ground
       and the painted stand's closest approach -4.63 mm — the design
       offset (4.71 mm below the design point; see solveParkPose) and
       nothing else. (The -4.4 this note used to give was the lowest
       painted VERTEX under its own x/z, which equals the closest
       approach only on level ground and is not what parkProbe reports
       any more.) Seeking to MARKS[4] and MARKS[5]
       and skipping from either lands the identical pose: [1.95, 14.54,
       -0.83], order YXZ, pitch -0.42, roll -6.11, wheels 0.0/0.0. The
       rest of it fires on the pads chooseStage is allowed to pick. */
    const pyaw = board.yaw + ride.parkYaw;
    const zf = bike.wheelbase * 0.5, zr = -zf;
    /* board.groundY is anchor-relative; every sample here is a world
       point, so convert once rather than at each call site. */
    const G = (x, z) => board.groundY(x - anchor.x, z - anchor.z);
    const sol = solveParkPose(G, {
      x: px, z: pz, yaw: pyaw, zf, zr,
      lean: bike.parkLean, foot: bike.standFoot || null,
      fallbackY: G(px, pz),
    });
    bike.park(px, sol.y, pz, pyaw, sol.pitch, sol.roll);
    /* Kept so the hand-over can tell ctx.game where his machine is
       standing WITHOUT re-solving it — a second solve is a second
       answer, and the whole point of the record is that the world and
       the save agree about one place. See THE MACHINE STAYS. */
    parkPose = { x: px, y: sol.y, z: pz, yaw: pyaw };
  }

  function landTitle() {
    card.show();
    card.hint(false);
    ctx.audio?.sting?.('title');
    ctx.bus?.emit('intro:titlecard', { t: clock });
  }

  function poseWelcome() {
    ctx.wally?.pose?.('welcome', { fade: 0.55 });
  }

  /* ==================================================================
     THE SETTLE — where the hand-over pose problem is actually fixed.

     REPORTED: "at the very end of the intro as it cuts from intro to
     scene to game, WALLY's arms are seen going into a weird position
     for the game."

     MEASURED, sampling every arm bone on every frame of the watched
     opener (max per-joint change between consecutive frames, degrees):

       t=26.689  ride-bicycle -> cool       42.37 in ONE frame
       t=31.672  cool -> welcome            52.00 in ONE frame
       t=34.672  release from welcome        2.80 peak, over 1.33 s

     Three findings, and only the middle one was a snap:

       1  The C -> D swap is 42 degrees in a frame — and it is MEANT
          to be, because the camera cuts on the same frame. Left alone.
       2  The title-card swap is 52 degrees in a frame with NOTHING in
          front of it: the hero lens is holding on him, the card has
          been up for half a second, and `pose('welcome', {fade:0.55})`
          asked for a half-second open and got a substitution. That was
          the action layer having no clip-to-clip blend at all; anim.js
          `play` now has one, and the same call is a real 0.55 s open.
       3  AND THE THIRD IS THE ONE THE PLAYER IS COMPLAINING ABOUT.
          `restoreWorld()` releases the action layer at the same
          instant it hands back control and the camera cuts to the
          follow boom — so the arms LEAVE the title-card pose during
          the first 1.3 seconds of gameplay. Nothing snapped; he simply
          starts the game with his arms open wide at 42 degrees of
          abduction and 86 degrees of supination (anim.js `welcome`)
          and spends a second and a third putting them down, over the
          top of whatever the player has already started doing. If the
          player pushed the stick, the walk cycle blended UNDER a
          held welcome, which is a man walking with his arms out.

     THE FIX IS NOT A LONGER CROSSFADE, IT IS DOING IT EARLIER. The
     two poses have to MEET at the cut, not fade across it: release
     the action layer 1.70 s before the hand-over, while the hero lens
     is still on him and the title is still up, so the last second of
     the opener is him relaxing out of the welcome and settling into
     the game's own idle — §1.6 pose 1, which is exactly what the
     first frame of gameplay holds. By the cut the action layer is at
     weight 0.033, i.e. smoothstep 0.0033, i.e. under a tenth of a
     degree of `welcome` left on either arm. The camera cut and the
     control hand-over then happen on a pose that is ALREADY the
     gameplay pose, and there is nothing left to resolve afterwards.

     It reads better as film, too. A held pose that is dropped on the
     cut is a freeze frame; a man lowering his arms as the title holds
     is the shot ending.

     THE EXPRESSION GOES WITH THE POSE. pose('welcome') sets 'happy'
     and release() does not undo it — expression.js is a separate
     additive layer with its own damping — so the game used to inherit
     a face the intro chose. It is handed back neutral, on the same
     beat and over the same interval.

     AND IT IS RIDE-AGNOSTIC BY CONSTRUCTION. Nothing here mentions a
     machine: whatever he arrived on, by TIMING.title he is standing
     at the hero mark in `cool` and the settle is the same settle.
     That is the property that makes one fix hold for four arrivals.
     ================================================================== */
  const SETTLE_LEAD = 1.70;     // seconds before the hand-over
  const SETTLE_FADE = 0.50;
  let settled = false;

  function settle() {
    settled = true;
    ctx.wally?.release?.(SETTLE_FADE);
    ctx.wally?.express?.('neutral', { fade: SETTLE_FADE });
  }

  const CUES = [
    { t: 1.60, f: () => card.hint(true) },
    { t: RIDE.t0, f: startRide },
    { t: TIMING.hero, f: dismount },
    { t: TIMING.title, f: landTitle },
    { t: TIMING.title + 0.55, f: poseWelcome },
    { t: TIMING.end - SETTLE_LEAD, f: settle },
    /* A debug seek holds on its mark instead of handing over: a
       screenshot taken 2.5 s after introShot(7) must still be the
       title, not the follow camera. */
    { t: TIMING.end, f: () => { if (!seeked) finish('end'); } },
  ];
  let cueAt = 0;
  let seeked = false;

  /* ================================================================
     Sequence changes — the cuts
     ================================================================ */
  function playSeq(i, fromShot = 0) {
    beat = i;
    const seq = board[BEATS[i]];
    fogTarget = seq.fog;
    if (fromShot > 0) { fogNear = fogTarget[0]; fogFar = fogTarget[1]; }
    ctx.cam.cinematic(seq.shots.slice(fromShot), { ...seq.opts, grade: seq.grade });
    ctx.bus?.emit('intro:shot', { seq: seq.name, index: i, t: clock });
  }

  /* ================================================================
     Per-frame character + prop driving
     ================================================================ */
  /* ------------------------------------------------------------------
     THE DESCENT — the balloon's driveCharacter, and it is a different
     function rather than a flag inside the other one because almost
     nothing survives the change of machine: there is no road, no
     drivetrain, no pedal phase, no wheels to roll and no ride clip.
     What there is instead is an altitude, a burner and a man standing
     on a deck.

     HE IS INSIDE IT, NOT ON IT. The prop's origin is on the ground —
     that is the park solve's contract, and it is the same contract
     wally.js's setFly() relies on when it hangs the machine at
     -DECK under his soles. Here the machine is a scene prop, so the
     arithmetic runs the other way: the machine sits at the altitude
     and HE sits DECK above its origin.

     THE BURNER IS LIT ON THE FLARE, which is both the physics and the
     picture. balloon.js's rule is that the flame is visible whenever
     she is arresting a descent near the ground, and airSink() falls
     from the full 4.5 m/s to zero across the last 2.3 s — so lighting
     it on the falling half of that curve puts a lit burner under a
     lit envelope for the whole of the final approach, which is the
     only light source in the shot that is not the sun.
     ------------------------------------------------------------------ */
  function driveAir(dt) {
    const back = RIDE.dist - ridePath(clock);
    const x = anchor.x - board.f.x * back;
    const z = anchor.z - board.f.z * back;
    const g = board.groundY(x - anchor.x, z - anchor.z);
    const alt = airAlt(clock);

    bike.group.rotation.order = 'YXZ';
    bike.group.position.set(x, g + alt, z);
    bike.group.rotation.set(0, board.yaw, 0);
    bike.setInflate(1);

    /* Lit while she is being held up: full through the flare, and a
       trickle above it so the envelope is never a cold grey bag. */
    const sink = airSink(clock);
    const flaring = alt > 0.02 && sink < ARRIVAL.balloon.sink - 0.05;
    bike.setBurner(flaring, flaring ? 1 : 0.12, dt);

    ctx.wally.root.position.set(x, g + alt + ride.deck, z);
    ctx.wally.root.rotation.y = board.yaw;
    ctx.wally.setLocomotion?.(0, 0);
  }

  function driveCharacter(dt) {
    /* `>=`, not `>`: TIMING.hero is the frame dismount() runs on, and
       on that frame the ride is over. With `>` the driver got one more
       write after the dismount had already stood him at the anchor —
       harmless on a bicycle, and one frame of a man floating 0.26 m up
       in a basket that has just been moored ten metres away. */
    if (!ctx.wally || clock < RIDE.t0 || clock >= TIMING.hero) return;
    if (ride.air) return driveAir(dt);

    const back = RIDE.dist - ridePath(clock);
    const x = anchor.x - board.f.x * back;
    const z = anchor.z - board.f.z * back;
    const g = board.groundY(x - anchor.x, z - anchor.z);

    /* RIDER AND MACHINE SHARE ONE ORIGIN, exactly as they do in
       gameplay — where the prop is a CHILD of Wally's root, so the two
       cannot disagree by construction. There used to be a `lift` here
       that damped the hips bone up onto a saddle at y 0.92, because the
       intro's own bicycle was built with 0.62 m between its bottom
       bracket and its seat. The prop is now character/bike.js's, whose
       SADDLE (0.465) and PEDAL (0.215) were measured against THIS
       skeleton in THIS clip, so the correct lift is zero and the honest
       way to say that is to not have the term at all. Verified: the
       ankle now tracks the pedal plate the way it does in gameplay
       rather than hovering 376 mm over it. */
    ctx.wally.root.position.set(x, g, z);
    ctx.wally.root.rotation.y = board.yaw;

    const v = rideSpeed(clock);
    ctx.wally.setLocomotion?.(v, 0);

    /* ---- the drivetrain, under the SAME rule the gameplay prop uses:
       the crank is a GEAR and comes off the clip's own cycle; the wheel
       is tyre-bound to the road and comes off DISTANCE. Deriving the
       crank from the wheel — `spin * 0.42`, one crank turn per 5.017 m
       — is what made this shot pedal at 2.28x its own rider's legs.

       `cycle` is metres of ground per pedal cycle and the CLIP declares
       it (anim.js CLIPS['ride-bicycle'].cycle = 2.6), so reading it off
       the clip is what keeps the feet and the cranks on one number.
       The clip runs on the ACTION layer here (the intro is a cutscene,
       not the locomotion ladder), so its phase is `time / duration` and
       its playback rate is metres-per-second over metres-per-cycle. */
    const act = ctx.wally.animator?.action;
    if (act && act.name === 'ride-bicycle') {
      const dur = act.clip?.duration || 1;
      const cycleM = act.clip?.cycle || 2.6;
      act.speed = (v * dur) / cycleM;
      /* This module's update() runs after wally's, so `time` has
         already been advanced for this frame: crank and legs are read
         off the same phase on the same frame, not one frame apart. */
      const ph = (act.time / dur) % 1;
      bike.setCrankPhase(ph * Math.PI * 2);
    }

    bike.group.position.set(x, g, z);
    bike.group.rotation.set(0, board.yaw, 0);
    bike.roll(v * dt);
  }

  /* ================================================================
     Hand-over
     ================================================================ */
  function restoreWorld() {
    ctx.sky?.setTimeScale?.(saved.timeScale ?? 0);
    ctx.render?.setGrade?.(
      typeof ctx.sky?.grade === 'string' ? ctx.sky.grade : saved.grade, 1.0);
    if (ctx.wally) {
      /* ALREADY RELEASED, IF THE OPENER WAS WATCHED. The settle cue
         1.70 s ago started this exact fade and it is 3 % of the way
         from finishing; calling release() again would restart it at a
         different rate, which is a discontinuity in the one place this
         whole block exists to keep continuous. The skip path never
         reaches that cue, so it still needs this. See THE SETTLE. */
      if (!settled) ctx.wally.release?.(0.35);
      /* TWO DIFFERENT RELEASES, AND release() IS ONLY ONE OF THEM.
         release() drops the explicit CLIP override (manual/manualHold).
         The locomotion blend is a separate latch: play() at the top of
         this file drives it with setLocomotion(v, 0), which sets
         locoManual = true, and wally.js then feeds the animator that
         pinned number instead of controller.planarSpeed for the rest of
         the session. Its own docstring says "pass (null) to hand it back
         to the controller" and nothing ever did.
         The symptom was reported as "he moves but no walk animation or
         bike animation": the controller integrates normally and the
         animator believes he is standing still, because the last value
         the cinematic set was ~0. Measured before this line existed —
         animSpeed 0.004 against a controller reading 2.447 m/s, leg-bone
         travel 0.156 rad against 0.98 rad walking.
         It is HERE rather than in finish() because restoreWorld() is the
         one hand-over both paths reach; a skip taken mid-ride does not
         run the watched path's cues. */
      ctx.wally.setLocomotion?.(null);
      ctx.wally.setPosition(anchor.x, anchor.y, anchor.z);
      ctx.wally.setYaw(board.yaw);
      ctx.wally.setControlled?.(true);
    }
    ctx.cam?.release?.();
    card.chrome(true);
    gulls?.dispose();
    gulls = null;
    /* THE BICYCLE STAYS FOR THE HAND-OVER, AND THEN IT IS COLLECTED.
       See THE BICYCLE HE ARRIVES ON below.

       ON ITS STAND FIRST, whichever way we got here. A skip taken
       mid-ride never reaches the hero cue, so this is the call site
       that stops the machine being handed to the player standing
       upright on two wheels with nothing under it. See parkArrival.

       IF IT WAS NEVER IN SHOT IT IS NOT COLLECTED, IT NEVER EXISTED:
       a skip taken before the ride begins has shown the player no
       bicycle at all, and standing one at his feet to be collected
       later would invent the very prop the retire rule exists to
       remove. It goes on this frame, unseen. */
    if (bike && !bikeParked) {
      if (bikeShown) parkArrival(); else collectArrival();
    }

    /* ==================================================================
       THE MACHINE STAYS, IF IT IS HIS — and the old reasoning inverts
       rather than bending.

       The retire rule below is not about props standing in the street.
       It is one argument and one argument only: a FREE bicycle,
       pixel-identical to the $180 one in the pawnshop, standing at the
       player's feet on the frame they take control, deletes the day-one
       purchase the whole early economy turns on. Every word of that is
       about the machine NOT BEING HIS.

       When the save says it is his, every clause fails. It is not free
       — he paid $180, or $3,300, or was handed the key on a bit of
       string, or paid $24,000 and had to have tokenized forty assets
       first. It is not a duplicate — it is the only one; arm() cleared
       its park record precisely so there could not be two. And
       collecting it would not be tidying up a prop, it would be taking
       a machine off a player who owns it, in a cutscene, without
       telling them: exactly the bug the retire rule was written to
       prevent, arrived at from the other side.

       So it is parked, and it is REGISTERED. `state.rides.parked` is
       the balloon agent's record of where a machine was left — world
       metres, position and heading only, everything else re-solved
       against the terrain on the way back in — and writing it here is
       what makes the world and the save agree that his motorcycle is
       standing at the hero mark. Reload and it is still there, because
       wally.js's restoreParked() reads the same record.

       AND THEN THE INTRO GIVES THE OBJECT ITSELF AWAY. The prop
       standing there is the intro's; the machine the game will
       manage is wally.js's, built from the park record. Two objects,
       one machine, and the swap is a handshake rather than a delete
       and a rebuild: `stepHandoff` waits until wally.js's own prop is
       actually standing before disposing this one, so the two overlap
       for a frame at an identical pose instead of leaving a hole. If
       wally.js never takes it — a build with no game module — the
       intro's prop simply stays, which is the safe failure: his
       machine is still there. */
    if (owned && bike && parkPose) {
      let ok = false;
      try {
        /* HE GOT OFF IT, SO THE STATE HAS TO SAY SO. `equipped` is
           "the machine he is on", and bikeSync() reconciles it every
           half second the moment control comes back — so a save that
           arrives equipped would have wally.js re-mount him on the
           machine the opener has just watched him park, two frames
           into gameplay, with a mount animation out of nowhere. It
           also breaks this file's own rule that the last frame of the
           opener and the first frame of play are the same pose.
           Unequipping is not a liberty taken with the save; it is the
           truthful description of a man standing beside his own
           motorcycle. `state.travel` is untouched — game.js's
           mountRide(null) is explicit that putting a machine down is
           not choosing a way to get anywhere — and the machine is
           two metres away when he wants it back. */
        ctx.game?.actions?.equipRide?.(null);
        ok = !!ctx.game?.actions?.setParkSpot?.(ride.id, parkPose)?.ok;
      } catch (e) { ok = false; }
      if (ok) {
        /* wally.js reconciles parked machines on a half-second timer;
           'ride' is the event that arms it for the next frame. */
        ctx.bus?.emit('ride', { kind: 'intro-arrival', ride: ride.id });
        handoff = { id: ride.id, t: 0 };
        retire = null;
        ctx.bus?.emit('intro:arrival', { ride: ride.id, owned: true, at: { ...parkPose } });
        return;
      }
      /* No game module to tell. Keep it anyway — it is still his. */
      retire = null;
      ctx.bus?.emit('intro:arrival', { ride: ride.id, owned: true, at: { ...parkPose } });
      return;
    }
    ctx.bus?.emit('intro:arrival', { ride: ride.id, owned: false, at: parkPose ? { ...parkPose } : null });
    retire = bike ? { t: 0 } : null;
  }

  /* ==================================================================
     THE BICYCLE HE ARRIVES ON IS NOT THE ONE HE BUYS

     Measured, before this existed: 34.7 s after boot the opener has
     handed over, `intro.bicycle` is standing visible at [1.95, 14.54,
     -0.83] — 2.12 m from the player at spawn — and
     ctx.game.actions.bike() reports owned:false. Since the intro
     adopted character/bike.js's model it is also pixel-identical to the
     machine the pawnshop and the trunk depot want $180 for. A free one
     you cannot mount, standing at your feet, next to a shop selling the
     same object: that reads as a bug whichever way the player takes it.

     IT MATTERS BECAUSE THE BICYCLE IS THE FIRST THING THE ECONOMY IS
     ABOUT. data.js prices it at $180 at reputation 0 — the day-one
     purchase — and a round measured the ride at 14.35 energy against
     walking's 39.26 over the same ground. The whole opening is the
     player deciding to stop walking. RIDES.bike's own line is "It is a
     bicycle. It is not a good bicycle. It is, however, yours", which
     only lands if it was not already.

     SO IT LEAVES — but never in shot. It stands through the title card
     and through the first seconds of control, then goes on the first
     frame it is outside the camera frustum. You turn around and someone
     has collected it, which is what happens to a machine that was never
     yours. The frustum test is the same one wally.js's parkedCull uses
     for parked player machines, with the same shadow pad, so it cannot
     go while its shadow is still in frame either. If the player never
     looks away it never goes, which is the correct trade: a pop is a
     defect and a bicycle standing there while you stare at it is not.

     WHAT WAS REJECTED.
       * Making it genuinely the player's. It would then have to come
         out of the shop — the game cannot sell you the bicycle you are
         standing next to — and that deletes the day-one goal, the line
         quoted above, and the 14.35-vs-39.26 decision the early game
         turns on. The economy is not worth an opening prop.
       * Recolouring it as a neighbour's, parked at somebody else's
         door. The player has just watched him ride this machine in and
         get off it (SEQ C -> D, shots.js); a different-coloured
         bicycle at the wrong door contradicts the shot it is supposed
         to explain.
     ================================================================== */
  const RETIRE_HOLD = 2.6;        // seconds of gameplay it stays regardless
  const _rf = new T.Frustum();
  const _rm = new T.Matrix4();
  const _rs = new T.Sphere();

  function collectArrival() {
    if (!bike) { retire = null; handoff = null; return; }
    /* Take the §2.2 hulls out of toon.js's cull list BEFORE disposing,
       or 53 shells go on being distance-tested against a mesh whose
       geometry has been freed. */
    bike.group.traverse((o) => {
      if (o.isMesh && !o.userData.isOutlineHull) ctx.mat?.removeOutline?.(o);
    });
    bike.dispose();
    bike = null;
    retire = null;
    ctx.bus?.emit('intro:bikeCollected', { ride: ride.id, owned });
  }

  /* ------------------------------------------------------------------
     THE HANDSHAKE. wally.js's bikeSync() calls restoreParked() every
     half second and it does not care whether the player has control —
     so once the park record is written, the game's own machine will
     stand itself up at that spot within a frame or two of the 'ride'
     event. THIS one goes when THAT one is up, never before: a delete
     that runs first is a hole in the frame, and both objects are the
     same model at the same solved pose, so an overlap is not visible
     at all.

     The 4 s ceiling is not a timeout that deletes anything. It stops
     the poll, and the intro's prop stays standing — the correct answer
     when nothing is coming to replace it. */
  function stepHandoff(dt) {
    if (!handoff) return;
    handoff.t += dt;
    let up = false;
    try {
      const st = ctx.wally?.rideState;
      up = !!(st && Array.isArray(st.parked)
        && st.parked.some((p) => p.id === handoff.id && p.visible !== false));
    } catch (e) { up = false; }
    if (up) {
      collectArrival();
      ctx.bus?.emit('intro:handoff', { ride: handoff.id, t: +handoff.t.toFixed(2) });
      handoff = null;
      return;
    }
    if (handoff.t > 4.0) handoff = null;
  }

  function stepRetire(dt) {
    if (!bike) { retire = null; return; }
    retire.t += dt;
    if (retire.t < RETIRE_HOLD) return;
    const cam = ctx.camera;
    if (cam) {
      _rm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      _rf.setFromProjectionMatrix(_rm);
      const p = bike.group.position;
      _rs.center.set(p.x, p.y + 0.55, p.z);
      /* half the machine's diagonal plus the longest shadow it throws,
         so it cannot leave while the shadow is still in frame */
      _rs.radius = 1.25 + 4.0;
      if (_rf.intersectsSphere(_rs)) return;
    }
    collectArrival();
  }

  function finish(reason) {
    if (finished || outro) return;
    /* NO CARD, NOTHING TO END. api.skip() and WALLY.debug.skipIntro()
       are reachable on a boot where the opener never armed — ?shot and
       ?skipIntro, which is EVERY rig in tools/, because main.js calls
       play() only when neither flag is set (see the note at the foot of
       this file) — and again after dispose(), which nulls `card`. Both
       fell into the dip below and threw
         TypeError: Cannot read properties of null (reading 'setVeil')
       which shot.mjs counts as a PAGEERROR and exits 1 on, failing a
       whole capture for a rig that only wanted to be sure the cinematic
       was out of the way. Skipping an opener that is not running is a
       no-op, not a page error.
       It deliberately does NOT emit intro:done: nothing started, so
       nothing ended, and audio.js's listener (setContext('explore'))
       must not be fired by a cinematic that never played. */
    if (!card || !running) {
      finished = true;
      detachSkip();
      return;
    }
    if (reason === 'skip') {
      outro = { phase: 'dip', t: 0, reason };
      card.setVeil(1, 0.22);
      card.hint(false);
      return;
    }
    outro = { phase: 'out', t: 0, reason };
    card.hide();
    restoreWorld();
  }

  function stepOutro(dt) {
    outro.t += dt;
    if (outro.phase === 'dip') {
      if (outro.t < 0.24) return;
      card.hide(true);
      restoreWorld();
      card.setVeil(0, 0.55);
      outro = { phase: 'out', t: 0, reason: outro.reason };
      return;
    }
    if (outro.t > 0.9) {
      running = false;
      finished = true;
      const skipped = outro.reason === 'skip';
      outro = null;
      detachSkip();
      ctx.bus?.emit('intro:done', { skipped });
    }
  }

  /* ================================================================
     Skip — any key, any tap, at any time
     ================================================================ */
  let skipOn = false;
  let skipArmed = 0;              // when the listeners went on, ms

  /* THE GESTURE THAT STARTS THE GAME MUST NOT ALSO SKIP IT.
     main.js rolls the opener from the player's first press, and one
     physical tap is several events: pointerdown, then touchstart, then
     mousedown, then click. The start beat consumes the first of them
     and play() attaches these listeners while that same tap is still
     being delivered — so the next event in the sequence would arrive
     here a millisecond later and cut a thirty-second cinematic to
     black before its first frame. A short deaf window is the whole
     fix, and it costs nothing: the skip hint does not appear until
     t = 1.6 s. */
  const SKIP_DEAF = 0.4;          // seconds
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function onSkip(e) {
    if (e && e.type === 'keydown' && (e.key === 'F5' || e.key === 'F12')) return;
    if (now() - skipArmed < SKIP_DEAF * 1000) return;
    if (!running || outro) return;
    finish('skip');
  }
  function attachSkip() {
    skipArmed = now();
    if (skipOn || typeof window === 'undefined') return;
    skipOn = true;
    addEventListener('keydown', onSkip, { capture: true });
    addEventListener('pointerdown', onSkip, { capture: true });
    addEventListener('touchstart', onSkip, { capture: true, passive: true });
  }
  function detachSkip() {
    if (!skipOn) return;
    skipOn = false;
    removeEventListener('keydown', onSkip, { capture: true });
    removeEventListener('pointerdown', onSkip, { capture: true });
    removeEventListener('touchstart', onSkip, { capture: true });
  }

  /* ================================================================
     Entry points
     ================================================================ */
  function play(opts = {}) {
    if (!arm()) return false;
    finished = false;
    outro = null;
    clock = 0;
    cueAt = 0;
    beat = -1;
    seeked = false;
    bikeParked = false;
    settled = false;
    handoff = null;

    if (reduced && !opts.force) return playStatic();

    card.setVeil(1, 0);
    card.hide(true);
    running = true;
    ctx.bus?.emit('intro:start', { reduced: false });
    playSeq(0);
    fogNear = board.sea.fog[0];
    fogFar = board.sea.fog[1];
    card.setVeil(0, 1.7);
    attachSkip();
    return true;
  }

  /* Reduced motion: no flight, no cuts, no push in. One held frame of
     the hero framing, the card, and out. */
  function playStatic() {
    running = true;
    clock = TIMING.title;
    ctx.sky?.setHour?.(hourAt(clock));
    cueAt = CUES.length - 1;
    CUES[CUES.length - 1] = { t: TIMING.title + 4.2, f: () => finish('end') };
    ctx.bus?.emit('intro:start', { reduced: true });
    dismount();
    poseWelcome();
    fogTarget = board.hero.fog;
    fogNear = fogTarget[0];
    fogFar = fogTarget[1];
    beat = BEATS.indexOf('hero');
    ctx.cam.cinematic([board.hero.shots[1]], {
      ...board.hero.opts, handheld: 0, grade: board.hero.grade,
    });
    card.setVeil(0, 0.5);
    landTitle();
    attachSkip();
    return true;
  }

  /** Jump the director to one of the MARKS in shots.js. */
  function seek(n) {
    if (!arm()) return null;
    const m = MARKS[clamp(n | 0, 0, MARKS.length - 1)];
    finished = false;
    outro = null;
    running = true;
    seeked = true;
    settled = false;
    handoff = null;
    /* A seek replays every cue from the top, and one of them parks the
       bicycle. Clearing the flag lets it park again — a seek BACK to
       the ride hands the machine to driveCharacter, which moves it, and
       without this the next seek forward would find it already "parked"
       and leave it wherever the ride had got to. */
    bikeParked = false;
    clock = m.t;
    ctx.sky?.setHour?.(hourAt(clock));
    card.setVeil(0, 0);
    card.hide(true);
    /* Replay every cue up to here, in order — they are all
       idempotent, so this reconstructs the exact character state the
       mark implies rather than approximating it. */
    cueAt = 0;
    while (cueAt < CUES.length && CUES[cueAt].t <= clock + 1e-4) {
      if (CUES[cueAt].t < TIMING.end - 1e-4) CUES[cueAt].f();
      cueAt++;
    }
    playSeq(BEATS.indexOf(m.seq), m.from);
    attachSkip();
    return m;
  }

  /* ================================================================
     Frame
     ================================================================ */
  function update(dt) {
    if (!running && !outro) {
      const d = dt > 0 ? Math.min(dt, 0.05) : 1 / 60;
      /* The opener is over but the machine he arrived on has not been
         collected yet. See THE BICYCLE HE ARRIVES ON. */
      if (retire) stepRetire(d);
      /* ...or it is HIS, and it is changing hands. See THE MACHINE
         STAYS. Never both: restoreWorld() sets exactly one. */
      if (handoff) stepHandoff(d);
      return;
    }
    dt = dt > 0 ? Math.min(dt, 0.05) : 1 / 60;

    if (outro) {
      /* Ease the fog back toward the sky's own numbers so the last
         frame of the intro and the first of gameplay share a horizon;
         stop writing once we are inside them and sky takes over. */
      fogNear = damp(fogNear, 60, 2.2, dt);
      fogFar = damp(fogFar, 420, 2.2, dt);
      if (ctx.sky?.fog && fogFar > 432) { ctx.sky.fog.near = fogNear; ctx.sky.fog.far = fogFar; }
      gulls?.update(dt, ctx.elapsed);
      stepOutro(dt);
      return;
    }

    clock += dt;

    /* cuts */
    const next = beat + 1;
    if (next < BEATS.length && clock >= TIMING[BEATS[next]]) playSeq(next);

    /* one-shots */
    while (cueAt < CUES.length && clock >= CUES[cueAt].t) {
      CUES[cueAt++].f();
      if (outro) return;
    }

    /* fog — this write is the one that reaches the renderer */
    fogNear = damp(fogNear, fogTarget[0], 1.5, dt);
    fogFar = damp(fogFar, fogTarget[1], 1.5, dt);
    if (ctx.sky?.fog) { ctx.sky.fog.near = fogNear; ctx.sky.fog.far = fogFar; }

    driveCharacter(dt);
    gulls?.update(dt, ctx.elapsed);
  }

  /* ================================================================
     ctx.intro
     ================================================================ */
  const api = {
    play,
    seek,
    skip: () => finish('skip'),
    get running() { return running; },
    get time() { return clock; },
    marks: MARKS,
    timing: TIMING,
    update,
    resize() {},
    dispose() {
      detachSkip();
      card?.dispose();
      gulls?.dispose();
      bike?.dispose();
      card = gulls = bike = null;
      retire = null;
      handoff = null;
    },
    state() {
      return {
        running, finished, t: +clock.toFixed(2),
        seq: beat >= 0 ? BEATS[beat] : null,
        fog: [Math.round(fogNear), Math.round(fogFar)],
        hour: ctx.sky?.hour != null ? +ctx.sky.hour.toFixed(2) : null,
        title: !!card?.visible,
        /* what he arrived on, whether it is his, and whether the
           action layer has been handed back yet */
        ride: ride.id,
        owned,
        settled,
        handoff: handoff ? handoff.id : null,
        yaw: board ? +(board.yaw * 57.2958).toFixed(1) : null,
        stage: stage ? { moved: stage.moved, score: stage.score } : null,
        cam: ctx.cam?.mode ?? null,
      };
    },
  };

  /* ================================================================
     Debug hooks
     ================================================================ */
  if (typeof window !== 'undefined' && window.WALLY) {
    const dbg = window.WALLY.debug || (window.WALLY.debug = {});
    dbg.playIntro = () => { play({ force: true }); return api.state(); };
    dbg.introShot = (n = 0) => seek(n);
    dbg.titleCard = () => seek(7);
    dbg.skipIntro = () => { const was = running; finish('skip'); return was ? 'skipping' : 'intro not running'; };
    dbg.introState = () => api.state();
    dbg.introMarks = () => MARKS.map((m) => `${m.n}  ${m.t.toFixed(2)}s  ${m.label}`);
    dbg.intro = api;
  }

  /* NOTHING AUTO-PLAYS FROM HERE ANY MORE.

     This module used to call play() at the end of its own init. That
     meant the opener began while the AudioContext was still
     suspended — browsers only resume one on a real user gesture, and
     boot is not a gesture — so the score never started and the title
     sting at 31.11 s was scheduled into a context that was not
     running. The whole cinematic played silent.

     main.js now rolls the opener from inside the player's first
     gesture (see THE START BEAT there), once the context has actually
     reached `running`, so the music and the picture begin on the same
     instant and the title lands on bar 7 with the sting under it.

     main.js calls ctx.intro.play() only when neither flags.shot nor
     flags.skipIntro is set — the same condition that used to guard
     this line. Every tool in tools/ boots with one of them and none
     of them ever sees the cinematic. */

  return api;
}

export default init;
